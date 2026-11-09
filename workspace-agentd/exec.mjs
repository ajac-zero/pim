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

// Runs `spec` and streams NDJSON events to `res`. Rejects with HttpError if the process cannot start.
// `baseEnv` is agentd's environment without its own token.
export async function runExec(spec, cwd, res, { baseEnv, maxOutputBytes, onStart, onEnd }) {
	const child = spawn(spec.cmd[0], spec.cmd.slice(1), {
		cwd,
		env: { ...baseEnv, ...spec.env },
		detached: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	await new Promise((resolve, reject) => {
		child.once('spawn', resolve)
		child.once('error', (e) => reject(new HttpError(400, 'spawn_failed', `cannot start ${spec.cmd[0]}: ${e.code ?? e.message}`)))
	})
	onStart()
	const pid = child.pid
	let finished = false
	let timedOut = false
	let truncated = false
	let bytes = 0
	let killTimer
	let drainTimer

	const kill = () => {
		killGroup(pid, 'SIGTERM')
		killTimer ??= setTimeout(() => killGroup(pid, 'SIGKILL'), KILL_GRACE_MS)
	}
	const send = (event) => {
		if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`)
	}

	res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
	res.flushHeaders()
	const timer = setTimeout(() => {
		timedOut = true
		kill()
	}, spec.timeoutMs)
	res.on('close', () => {
		if (!finished) kill()
	})

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
			finished = true
			clearTimeout(timer)
			clearTimeout(killTimer)
			clearTimeout(drainTimer)
			killGroup(pid, 'SIGKILL') // leftovers that outlived the main process
			send({ type: 'exit', code, signal, timedOut })
			res.end()
			onEnd()
			resolve()
		})
	})
}
