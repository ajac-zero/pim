import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { HttpError } from './errors.mjs'

const KILL_GRACE_MS = 2000
// After the main process exits, how long to wait for its pipes to drain before killing leftovers.
const DRAIN_GRACE_MS = 200

export function parseExec(body) {
	const ok =
		body &&
		typeof body === 'object' &&
		Array.isArray(body.cmd) &&
		body.cmd.length > 0 &&
		body.cmd.every((a) => typeof a === 'string' && !a.includes('\0')) &&
		typeof body.timeoutMs === 'number' &&
		Number.isFinite(body.timeoutMs) &&
		body.timeoutMs > 0
	if (!ok) throw new HttpError(400, 'bad_request', 'body needs cmd (non-empty string array) and timeoutMs (positive number)')
	if (body.cwd !== undefined && typeof body.cwd !== 'string') throw new HttpError(400, 'bad_request', 'cwd must be a string')
	if (body.stdin !== undefined && typeof body.stdin !== 'string') throw new HttpError(400, 'bad_request', 'stdin must be a string')
	if (body.id !== undefined && (typeof body.id !== 'string' || !EXEC_ID.test(body.id))) throw new HttpError(400, 'bad_request', 'id must be 8-128 letters, digits, - or _')
	if (body.env !== undefined) {
		const e = body.env
		if (!e || typeof e !== 'object' || Array.isArray(e) || !Object.values(e).every((v) => typeof v === 'string')) {
			throw new HttpError(400, 'bad_request', 'env must map names to strings')
		}
	}
	return body
}

function killGroup(pid, signal) {
	try {
		process.kill(-pid, signal)
	} catch {}
}

// An exec started with an `id` outlives its connection: when the client goes away (the manager
// restarting, say), the command keeps running for `detachMs` while its events are kept, and a
// client that attaches again with `GET /exec/<id>?after=<events it has>` gets the rest. Without an
// id, a closed connection kills the command at once.
export const EXEC_ID = /^[A-Za-z0-9_-]{8,128}$/

const line = (event) => `${JSON.stringify(event)}\n`

// Streams `run`'s events after the first `after` to `res`, and then each new one. A client that
// attaches takes over from the one before it, whose connection may be dead without agentd knowing.
export function attach(run, res, after = 0) {
	if (!Number.isInteger(after) || after < 0 || after > run.events.length) throw new HttpError(400, 'bad_request', `after must be an integer from 0 to ${run.events.length}`)
	const before = run.res
	run.res = res
	before?.destroy()
	clearTimeout(run.detachTimer)
	res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
	res.flushHeaders()
	for (const event of run.events.slice(after)) res.write(line(event))
	if (run.finished) return res.end()
	res.on('close', () => {
		if (run.res !== res || run.finished) return
		run.res = null
		if (run.detachMs > 0) run.detachTimer = setTimeout(run.kill, run.detachMs)
		else run.kill()
	})
}

// Runs `spec` and streams NDJSON events to `res`. Rejects with HttpError if the process cannot start.
// `baseEnv` is agentd's environment without its own token. An exec with `spec.id` is kept in
// `execs` until `detachMs` after it ends.
export async function runExec(spec, cwd, res, { baseEnv, maxOutputBytes, onStart, onEnd, execs, detachMs }) {
	const kept = spec.id !== undefined
	const run = { events: [], res: null, finished: false, kill: null, detachMs: kept ? detachMs : 0, detachTimer: null }
	if (kept) {
		if (execs.has(spec.id)) throw new HttpError(409, 'exec_exists', `an exec with id ${spec.id} exists`)
		execs.set(spec.id, run)
	}
	const child = spawn(spec.cmd[0], spec.cmd.slice(1), {
		cwd,
		env: { ...baseEnv, ...spec.env },
		detached: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	try {
		await new Promise((resolve, reject) => {
			child.once('spawn', resolve)
			child.once('error', (e) => reject(new HttpError(400, 'spawn_failed', `cannot start ${spec.cmd[0]}: ${e.code ?? e.message}`)))
		})
	} catch (e) {
		if (kept) execs.delete(spec.id)
		throw e
	}
	onStart()
	const pid = child.pid
	let timedOut = false
	let truncated = false
	let bytes = 0
	let killTimer
	let drainTimer

	const kill = () => {
		killGroup(pid, 'SIGTERM')
		killTimer ??= setTimeout(() => killGroup(pid, 'SIGKILL'), KILL_GRACE_MS)
	}
	run.kill = kill
	const send = (event) => {
		if (kept) run.events.push(event)
		const r = run.res
		if (r && !r.writableEnded && !r.destroyed) r.write(line(event))
	}

	attach(run, res)
	const timer = setTimeout(() => {
		timedOut = true
		kill()
	}, spec.timeoutMs)

	const pipe = (stream, type) => {
		const decoder = new StringDecoder('utf8')
		stream.on('data', (chunk) => {
			if (truncated) return
			let buf = chunk
			if (bytes + buf.length > maxOutputBytes) {
				buf = buf.subarray(0, maxOutputBytes - bytes)
				truncated = true
			}
			bytes += buf.length
			const text = decoder.write(buf)
			if (text) send({ type, data: text })
			if (truncated) {
				send({ type: 'stderr', data: '[output truncated]' })
				kill()
			}
		})
		stream.on('end', () => {
			const rest = decoder.end()
			if (rest && !truncated) send({ type, data: rest })
		})
	}
	pipe(child.stdout, 'stdout')
	pipe(child.stderr, 'stderr')

	child.stdin.on('error', () => {})
	child.stdin.end(spec.stdin ?? '')

	child.once('exit', () => {
		drainTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), DRAIN_GRACE_MS)
	})
	await new Promise((resolve) => {
		child.once('close', (code, signal) => {
			run.finished = true
			clearTimeout(timer)
			clearTimeout(killTimer)
			clearTimeout(drainTimer)
			clearTimeout(run.detachTimer)
			killGroup(pid, 'SIGKILL') // leftovers that outlived the main process
			send({ type: 'exit', code, signal, timedOut })
			run.res?.end()
			// Kept a while, so a client that lost the end of the stream can still read it.
			if (kept) setTimeout(() => execs.get(spec.id) === run && execs.delete(spec.id), detachMs).unref()
			onEnd()
			resolve()
		})
	})
}
