// A minimal Docker Engine API client. DOCKER_HOST may be unix:///path or tcp://host:port
// (the compose file reaches the daemon through docker-socket-proxy over tcp).
import http from 'node:http'

export function parseDockerHost(host) {
	if (!host) return { socketPath: '/var/run/docker.sock' }
	if (host.startsWith('unix://')) return { socketPath: host.slice(7) }
	if (host.startsWith('/')) return { socketPath: host }
	if (host.startsWith('tcp://')) {
		const u = new URL(host.replace('tcp://', 'http://'))
		return { host: u.hostname, port: Number(u.port || 2375) }
	}
	throw new Error(`unsupported DOCKER_HOST: ${host}`)
}

export class DockerError extends Error {
	constructor(status, message) {
		super(`docker ${status}: ${message}`)
		this.status = status
	}
}

const MAX_OUTPUT = 10 * 1024 * 1024

// Splits Docker's multiplexed stream (8-byte header: type, 3 zero bytes, uint32 length).
export class Demuxer {
	constructor(max) {
		this.buf = Buffer.alloc(0)
		this.out = { 1: [], 2: [] }
		this.size = { 1: 0, 2: 0 }
		this.max = max
		this.truncated = false
	}
	push(chunk) {
		this.buf = Buffer.concat([this.buf, chunk])
		while (this.buf.length >= 8) {
			const len = this.buf.readUInt32BE(4)
			if (this.buf.length < 8 + len) return
			const type = this.buf[0] === 2 ? 2 : 1
			const room = this.max - this.size[type]
			const part = this.buf.subarray(8, 8 + Math.min(len, Math.max(room, 0)))
			if (part.length < len) this.truncated = true
			this.out[type].push(part)
			this.size[type] += part.length
			this.buf = this.buf.subarray(8 + len)
		}
	}
	result() {
		return { stdout: Buffer.concat(this.out[1]), stderr: Buffer.concat(this.out[2]), truncated: this.truncated }
	}
}

export class Docker {
	constructor(host) {
		this.target = parseDockerHost(host)
	}

	request(method, path, body) {
		return new Promise((resolve, reject) => {
			const payload = body === undefined ? undefined : JSON.stringify(body)
			const req = http.request(
				{ ...this.target, method, path, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
				(res) => {
					const chunks = []
					res.on('data', (c) => chunks.push(c))
					res.on('end', () => {
						const text = Buffer.concat(chunks).toString()
						let data = text
						try {
							data = text ? JSON.parse(text) : null
						} catch {}
						if (res.statusCode >= 400) return reject(new DockerError(res.statusCode, data?.message ?? text))
						resolve(data)
					})
				},
			)
			req.on('error', reject)
			req.end(payload)
		})
	}

	// Runs a command in a container and returns {stdout, stderr, exitCode, timedOut}.
	// On timeout the stream is dropped and every process of the sandbox user is killed:
	// a Docker exec cannot be signalled directly, and the PID it reports is not valid in
	// the container's PID namespace (certainly not under gVisor).
	async exec(containerId, { cmd, cwd, stdin, timeoutMs, maxOutput = MAX_OUTPUT }) {
		const created = await this.request('POST', `/containers/${containerId}/exec`, {
			Cmd: cmd,
			WorkingDir: cwd,
			User: '10001',
			AttachStdin: stdin !== undefined,
			AttachStdout: true,
			AttachStderr: true,
			Tty: false,
		})
		const demux = new Demuxer(maxOutput)
		let timedOut = false
		await new Promise((resolve, reject) => {
			let stream
			const timer = setTimeout(() => {
				timedOut = true
				stream?.destroy()
				resolve()
			}, timeoutMs)
			const done = (err) => {
				clearTimeout(timer)
				err ? reject(err) : resolve()
			}
			const body = JSON.stringify({ Detach: false, Tty: false })
			const req = http.request({
				...this.target,
				method: 'POST',
				path: `/exec/${created.Id}/start`,
				headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'Upgrade', upgrade: 'tcp' },
			})
			const attach = (s, writable) => {
				stream = s
				s.on('data', (c) => demux.push(c))
				s.on('end', () => done())
				s.on('close', () => done())
				s.on('error', (e) => (timedOut ? done() : done(e)))
				if (writable) {
					if (stdin !== undefined) s.write(stdin)
					// Half-close so the process sees EOF on stdin while we keep reading.
					if (stdin !== undefined) s.end()
				}
			}
			req.on('upgrade', (_res, socket, head) => {
				if (head.length) demux.push(head)
				attach(socket, true)
			})
			req.on('response', (res) => {
				if (res.statusCode >= 400) return done(new DockerError(res.statusCode, 'exec start failed'))
				attach(res, false)
			})
			req.on('error', (e) => done(e))
			req.end(body)
		})
		if (timedOut) {
			await this.exec(containerId, { cmd: ['kill', '-9', '-1'], timeoutMs: 5000 }).catch(() => {})
			return { ...demux.result(), exitCode: null, timedOut: true }
		}
		const info = await this.request('GET', `/exec/${created.Id}/json`)
		return { ...demux.result(), exitCode: info.ExitCode, timedOut: false }
	}
}
