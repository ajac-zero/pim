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
}
