// A client for the workspace-agentd inside a session (protocol in workspace-agentd/README.md).
// The manager reaches it by the container's IP on the session network, because Docker's
// embedded DNS does not work under gVisor. target: { host, port, token }.
import http from 'node:http'
import os from 'node:os'
import { HttpError } from './errors.js'
import { MAX_OUTPUT } from './template.js'

const unreachable = (e) => new HttpError(502, `workspace daemon unreachable: ${e.code ?? e.message}`, { code: 'agentd_unreachable' })

// Resolves with the response once headers arrive. `idleMs` bounds silence on the socket.
// `signal` aborts the request, and agentd sees the connection close.
export function request(target, method, path, { body, headers = {}, idleMs = 30000, signal } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: target.host, port: target.port, method, path, signal, headers: { authorization: `Bearer ${target.token}`, ...headers } })
		req.setTimeout(idleMs, () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })))
		req.on('response', resolve)
		req.on('error', (e) => reject(unreachable(e)))
		req.end(body)
	})
}

async function readAll(res) {
	const chunks = []
	for await (const c of res) chunks.push(c)
	return Buffer.concat(chunks)
}

// Turns an agentd error response into the manager's error shape.
export async function fail(res) {
	let body = {}
	try {
		body = JSON.parse((await readAll(res)).toString())
	} catch {}
	if (body.error === 'path_escape') throw new HttpError(403, 'path escapes /workspace', { code: 'path_escape' })
	if (body.error === 'disk_full') throw new HttpError(507, 'the workspace disk is full', { code: 'disk_full' })
	if (res.statusCode === 401) throw new HttpError(502, 'workspace daemon refused the session token', { code: 'agentd_auth' })
	if (res.statusCode >= 500) throw new HttpError(502, `workspace daemon error: ${body.message ?? res.statusCode}`, { code: 'agentd_error' })
	throw new HttpError(res.statusCode, body.message ?? 'workspace daemon refused the request', { code: body.error })
}

export async function json(target, method, path, opts) {
	const res = await request(target, method, path, opts)
	if (res.statusCode !== 200) await fail(res)
	return JSON.parse((await readAll(res)).toString())
}

// Waits until agentd answers /health, for up to `ms`.
export async function ready(target, ms) {
	const end = Date.now() + ms
	for (;;) {
		try {
			const res = await request(target, 'GET', '/health', { idleMs: 2000 })
			res.resume()
			if (res.statusCode === 200) return
			if (res.statusCode === 401) throw new HttpError(502, 'workspace daemon refused the session token', { code: 'agentd_auth' })
		} catch (e) {
			if (e.extra?.code === 'agentd_auth') throw e
		}
		if (Date.now() > end) throw new HttpError(502, `workspace daemon did not start within ${ms} ms`, { code: 'agentd_unreachable' })
		await new Promise((r) => setTimeout(r, 200))
	}
}

// Starts a command through agentd and returns its events: {type: 'stdout'|'stderr', data}, then
// one {type: 'exit', code, signal, timedOut}. agentd kills the command's process group on timeout
// and when the connection closes, so aborting `signal` kills the command. If agentd goes silent
// past the timeout plus `graceMs`, the connection is dropped and the exit reports a timeout.
// Throws HttpError when agentd refuses the request.
export async function startExec(target, spec, graceMs, signal) {
	const body = JSON.stringify(spec)
	// The socket's idle timeout is longer than the guard in `events`, so the guard decides.
	const res = await request(target, 'POST', '/exec', { body, headers: { 'content-type': 'application/json' }, idleMs: spec.timeoutMs + 2 * graceMs, signal })
	if (res.statusCode === 400) {
		const err = JSON.parse((await readAll(res)).toString() || '{}')
		// Docker exec reported a command that cannot start as exit code 127; keep that for callers.
		if (err.error === 'spawn_failed') return [{ type: 'stderr', data: `${err.message}\n` }, { type: 'exit', code: 127, signal: null, timedOut: false }]
		throw new HttpError(400, err.message ?? 'bad exec request', { code: err.error })
	}
	if (res.statusCode !== 200) await fail(res)
	return events(res, spec.timeoutMs + graceMs, signal)
}

async function* events(res, guardMs, signal) {
	let dropped = false
	const guard = setTimeout(() => {
		dropped = true
		res.destroy()
	}, guardMs)
	let pending = ''
	let exited = false
	try {
		res.setEncoding('utf8')
		for await (const chunk of res) {
			pending += chunk
			let i
			while ((i = pending.indexOf('\n')) >= 0) {
				const line = pending.slice(0, i)
				pending = pending.slice(i + 1)
				if (!line) continue
				const ev = JSON.parse(line)
				exited ||= ev.type === 'exit'
				yield ev
			}
		}
	} catch (e) {
		if (!dropped && !signal?.aborted) throw unreachable(e)
	} finally {
		clearTimeout(guard)
		res.destroy()
	}
	if (dropped) yield { type: 'exit', code: null, signal: 'SIGKILL', timedOut: true }
	else if (!exited && !signal?.aborted) throw new HttpError(502, 'workspace daemon ended the exec stream early', { code: 'agentd_error' })
}

// Runs a command and buffers its events into the manager's exec result, each stream capped.
export async function exec(target, spec, graceMs) {
	const out = { stdout: [], stderr: [] }
	const size = { stdout: 0, stderr: 0 }
	let truncated = false
	let exit
	for await (const ev of await startExec(target, spec, graceMs)) {
		if (ev.type === 'exit') exit = ev
		else if (ev.type in out) {
			const buf = Buffer.from(ev.data)
			const room = MAX_OUTPUT - size[ev.type]
			if (buf.length > room) truncated = true
			const part = buf.subarray(0, Math.max(room, 0))
			out[ev.type].push(part)
			size[ev.type] += part.length
		}
	}
	const result = { stdout: Buffer.concat(out.stdout).toString(), stderr: Buffer.concat(out.stderr).toString(), truncated }
	if (exit.timedOut) return { ...result, exitCode: null, timedOut: true }
	// A command killed by a signal reports 128 + the signal number, as a shell and Docker exec do.
	const exitCode = exit.code ?? (exit.signal ? 128 + (os.constants.signals[exit.signal] ?? 0) : null)
	return { ...result, exitCode, timedOut: false }
}
