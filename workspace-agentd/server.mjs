#!/usr/bin/env node
import { timingSafeEqual, createHash } from 'node:crypto'
import { createReadStream, mkdirSync, promises as fs } from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { HttpError } from './errors.mjs'
import { attach, EXEC_ID, runExec, parseExec } from './exec.mjs'
import * as files from './files.mjs'
import { makeResolver } from './paths.mjs'

export const VERSION = '0.1.0'
const MiB = 1024 * 1024

const sha = (s) => createHash('sha256').update(s).digest()

function sendJson(res, status, body) {
	const data = JSON.stringify(body)
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
	res.end(data)
}

async function readJson(req, maxBytes) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > maxBytes) throw new HttpError(413, 'body_too_large', `body exceeds ${maxBytes} bytes`)
		chunks.push(chunk)
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		throw new HttpError(400, 'bad_request', 'body must be JSON')
	}
}

function parseMode(value) {
	if (value === null) return 0o644
	if (!/^[0-7]{3,4}$/.test(value)) throw new HttpError(400, 'bad_request', 'mode must be octal, such as 0644')
	return Number.parseInt(value, 8)
}

// Builds the HTTP server. `config` is { token, root, maxOutputBytes, maxBodyBytes, detachGraceMs }.
export async function createAgentd(config) {
	if (!config.token) throw new Error('AGENTD_TOKEN is required')
	const resolver = await makeResolver(config.root ?? '/workspace')
	const maxOutputBytes = config.maxOutputBytes ?? 4 * MiB
	const maxBodyBytes = config.maxBodyBytes ?? 64 * MiB
	const tokenHash = sha(config.token)
	const startedAt = Date.now()
	// Commands never inherit the token, so it cannot end up in their output or logs.
	const { AGENTD_TOKEN: _, ...baseEnv } = process.env
	let activeExecs = 0
	// Execs started with an id, by id: running ones, and finished ones for a while (see exec.mjs).
	const execs = new Map()
	const detachMs = config.detachGraceMs ?? 10 * 60_000

	async function handle(req, res) {
		const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
		if (!timingSafeEqual(sha(given), tokenHash)) throw new HttpError(401, 'unauthorized', 'missing or invalid bearer token')

		const url = new URL(req.url, 'http://agentd')
		const route = `${req.method} ${url.pathname}`
		const p = url.searchParams.get('path')
		const needPath = () => {
			if (p === null) throw new HttpError(400, 'bad_request', 'path is required')
			return p
		}

		const em = /^\/exec\/([^/]+)$/.exec(url.pathname)
		if (em) {
			const run = EXEC_ID.test(em[1]) && execs.get(em[1])
			if (!run) throw new HttpError(404, 'exec_not_found', 'no such exec, or it ended too long ago')
			if (req.method === 'GET') return attach(run, res, Number(url.searchParams.get('after') ?? 0))
			if (req.method === 'DELETE') {
				if (!run.finished) run.kill()
				return sendJson(res, 200, { ok: true })
			}
			throw new HttpError(405, 'method_not_allowed', `no route ${route}`)
		}

		switch (route) {
			case 'GET /health':
				return sendJson(res, 200, { ok: true, version: VERSION })
			case 'GET /status': {
				const fsStat = await fs.statfs(resolver.root)
				const total = fsStat.blocks * fsStat.bsize
				const free = fsStat.bavail * fsStat.bsize
				return sendJson(res, 200, {
					diskUsedBytes: total - fsStat.bfree * fsStat.bsize,
					diskFreeBytes: free,
					rootBytes: await files.treeBytes(resolver.root),
					activeExecs,
					uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
				})
			}
			case 'POST /exec': {
				const spec = parseExec(await readJson(req, maxBodyBytes))
				const cwd = await files.guard(spec.cwd ?? '.', async () => {
					const dir = await resolver.follow(spec.cwd ?? '.')
					if (!(await fs.stat(dir)).isDirectory()) throw new HttpError(400, 'not_a_directory', 'cwd is not a directory')
					return dir
				})
				return runExec(spec, cwd, res, {
					baseEnv,
					maxOutputBytes,
					onStart: () => activeExecs++,
					onEnd: () => activeExecs--,
					execs,
					detachMs,
				})
			}
			case 'GET /file': {
				const { file, size } = await files.openRead(resolver, needPath())
				res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size })
				const stream = createReadStream(file)
				stream.on('error', () => res.destroy())
				stream.pipe(res)
				return
			}
			case 'PUT /file': {
				const mode = parseMode(url.searchParams.get('mode'))
				const declared = Number(req.headers['content-length'])
				if (declared > maxBodyBytes) throw new HttpError(413, 'body_too_large', `body exceeds ${maxBodyBytes} bytes`)
				const { size } = await files.write(resolver, needPath(), mode, req, maxBodyBytes)
				return sendJson(res, 200, { ok: true, size })
			}
			case 'DELETE /file':
				await files.remove(resolver, needPath(), url.searchParams.get('recursive') === '1')
				return sendJson(res, 200, { ok: true })
			case 'GET /list':
				return sendJson(res, 200, await files.list(resolver, needPath()))
			case 'GET /stat':
				return sendJson(res, 200, await files.stat(resolver, needPath()))
			default:
				throw new HttpError(404, 'not_found', `no route ${route}`)
		}
	}

	const server = http.createServer(async (req, res) => {
		try {
			await handle(req, res)
		} catch (error) {
			const known = error instanceof HttpError
			if (!known) console.error('agentd: unexpected error:', error?.code ?? error?.name, error?.message)
			if (res.headersSent) return res.destroy()
			if (known && error.status === 413) res.setHeader('connection', 'close')
			sendJson(res, known ? error.status : 500, {
				error: known ? error.code : 'internal',
				message: known ? error.message : 'internal error',
			})
		}
	})
	server.requestTimeout = 0
	return server
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const env = process.env
	if (!env.AGENTD_TOKEN) {
		console.error('agentd: AGENTD_TOKEN is required')
		process.exit(1)
	}
	// The session's temp directory (TMPDIR, GOTMPDIR) is on the workspace volume: make sure it exists.
	for (const dir of new Set([env.TMPDIR, env.GOTMPDIR])) if (dir?.startsWith('/workspace/')) mkdirSync(dir, { recursive: true })
	const server = await createAgentd({
		token: env.AGENTD_TOKEN,
		root: env.AGENTD_ROOT || '/workspace',
		maxOutputBytes: env.AGENTD_MAX_OUTPUT_BYTES ? Number(env.AGENTD_MAX_OUTPUT_BYTES) : undefined,
		maxBodyBytes: env.AGENTD_MAX_BODY_BYTES ? Number(env.AGENTD_MAX_BODY_BYTES) : undefined,
		detachGraceMs: env.AGENTD_DETACH_GRACE_MS ? Number(env.AGENTD_DETACH_GRACE_MS) : undefined,
	})
	const port = Number(env.AGENTD_PORT || 8787)
	server.listen(port, '0.0.0.0', () => console.log(`agentd ${VERSION} listening on :${port}`))
	for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0))
}
