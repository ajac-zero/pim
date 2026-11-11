// The loopback HTTP API. Every request needs the bearer token.
import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'

const digest = (s) => createHash('sha256').update(s).digest()
const ID = /^[A-Za-z0-9._:-]{1,128}$/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class HttpError extends Error {
	constructor(status, message) {
		super(message)
		this.status = status
	}
}

async function body(req) {
	let text = ''
	for await (const chunk of req) {
		text += chunk
		if (text.length > 16_384) throw new HttpError(413, 'body too large')
	}
	try {
		const v = text ? JSON.parse(text) : {}
		if (v && typeof v === 'object' && !Array.isArray(v)) return v
	} catch {}
	throw new HttpError(400, 'body must be a JSON object')
}

const id = (v, name) => {
	if (typeof v !== 'string' || !ID.test(v)) throw new HttpError(400, `${name} must be a string of letters, digits and . _ : -`)
	return v
}

export function createServer({ allocator, token, sleepFn = sleep }) {
	const want = digest(token)
	return http.createServer(async (req, res) => {
		const send = (status, json) => {
			res.writeHead(status, { 'content-type': 'application/json' })
			res.end(JSON.stringify(json))
		}
		try {
			const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
			if (!timingSafeEqual(digest(given), want)) throw new HttpError(401, 'unauthorized')
			const route = `${req.method} ${new URL(req.url, 'http://x').pathname}`
			if (route === 'GET /health') return send(200, { ok: true, ...(await allocator.health()) })
			if (route === 'GET /displays') return send(200, { displays: allocator.list() })
			if (!['POST /acquire', 'POST /release', 'POST /touch'].includes(route)) throw new HttpError(404, 'not found')
			const b = await body(req)
			const threadId = id(b.threadId, 'threadId')
			if (route === 'POST /acquire') {
				const spaceId = id(b.spaceId, 'spaceId')
				let lease = await allocator.acquire(threadId, spaceId)
				// waitMs lets the caller wait for the display to come up instead of polling.
				const until = Date.now() + Math.min(Number(b.waitMs) || 0, 60_000)
				while (lease && ['queued', 'starting'].includes(lease.state) && Date.now() < until) {
					await sleepFn(250)
					lease = allocator.get(threadId)
				}
				if (!lease) throw new HttpError(503, 'the display could not be started')
				return send(lease.state === 'active' || lease.state === 'idle' ? 200 : 202, { lease })
			}
			if (route === 'POST /release') return send(200, { released: await allocator.release(threadId) })
			const lease = await (b.browser ? allocator.markBrowser(threadId) : allocator.touch(threadId))
			if (!lease) throw new HttpError(404, 'the thread has no display')
			return send(200, { lease })
		} catch (e) {
			if (e instanceof HttpError) return send(e.status, { error: e.message })
			send(500, { error: 'internal error' })
			console.error(e)
		}
	})
}
