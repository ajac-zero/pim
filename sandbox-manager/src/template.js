// Everything that reaches Docker's create calls is built here from a fixed template plus
// validated numbers. Request bodies never contribute raw Docker fields: unknown keys are
// rejected, so a caller cannot ask for binds, privileged mode, capabilities or host networking.
import { HttpError } from './errors.js'

export const LABEL = 'pim.coding.session'
export const LABEL_SPEC = 'pim.coding.spec'
const MiB = 1024 * 1024

export const BOUNDS = {
	cpu: [0.1, 4],
	memMiB: [64, 8192],
	diskMiB: [64, 20480],
	pids: [16, 2048],
}

const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/

function onlyKeys(obj, allowed, what) {
	for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new HttpError(400, `unknown field ${what}${k}`)
}

export function parseCreate(body, allowedImages) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be an object')
	onlyKeys(body, ['sessionId', 'image', 'limits', 'egressAllow'], '')
	const { sessionId, image, limits, egressAllow = [] } = body
	if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new HttpError(400, 'invalid sessionId')
	if (typeof image !== 'string' || !allowedImages.includes(image)) throw new HttpError(403, 'image is not allowed')
	if (!limits || typeof limits !== 'object') throw new HttpError(400, 'limits required')
	onlyKeys(limits, Object.keys(BOUNDS), 'limits.')
	for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
		const v = limits[k]
		if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new HttpError(400, `limits.${k} must be a number in [${lo}, ${hi}]`)
		if (k !== 'cpu' && !Number.isInteger(v)) throw new HttpError(400, `limits.${k} must be an integer`)
	}
	if (!Array.isArray(egressAllow) || egressAllow.length > 64 || !egressAllow.every((h) => typeof h === 'string' && HOST.test(h))) {
		throw new HttpError(400, 'egressAllow must be an array of hostnames (optionally *.suffix)')
	}
	return { sessionId, image, limits: { cpu: limits.cpu, memMiB: limits.memMiB, diskMiB: limits.diskMiB, pids: limits.pids }, egressAllow: [...new Set(egressAllow)] }
}

export const names = (id) => ({ container: `pim-s-${id}`, volume: `pim-ws-${id}`, network: `pim-net-${id}` })

// opts: { proxyUrl, workspaceTmpfs }
export function buildSpec(params, opts) {
	const { sessionId, image, limits } = params
	const n = names(sessionId)
	const labels = { [LABEL]: sessionId, [LABEL_SPEC]: JSON.stringify(params) }
	const proxy = opts.proxyUrl
	return {
		volume: {
			Name: n.volume,
			Labels: labels,
			// Without this the volume is plain disk on the Docker root and only bounded by the
			// free-disk check; the tmpfs variant enforces diskMiB but is memory-backed.
			...(opts.workspaceTmpfs && { Driver: 'local', DriverOpts: { type: 'tmpfs', device: 'tmpfs', o: `size=${limits.diskMiB}m,uid=10001,gid=10001,mode=0755` } }),
		},
		network: { Name: n.network, Driver: 'bridge', Internal: true, Labels: labels },
		container: {
			name: n.container,
			body: {
				Image: image,
				User: '10001',
				Entrypoint: ['sleep', 'infinity'],
				WorkingDir: '/workspace',
				Env: [`HOME=/workspace`, `HTTP_PROXY=${proxy}`, `HTTPS_PROXY=${proxy}`, `http_proxy=${proxy}`, `https_proxy=${proxy}`, 'NO_PROXY='],
				Labels: labels,
				NetworkDisabled: false,
				HostConfig: {
					Runtime: 'runsc',
					Privileged: false,
					ReadonlyRootfs: true,
					CapDrop: ['ALL'],
					SecurityOpt: ['no-new-privileges'],
					PidsLimit: limits.pids,
					Memory: limits.memMiB * MiB,
					MemorySwap: limits.memMiB * MiB,
					NanoCpus: Math.round(limits.cpu * 1e9),
					Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
					Mounts: [{ Type: 'volume', Source: n.volume, Target: '/workspace', VolumeOptions: { Labels: labels } }],
					NetworkMode: n.network,
					PublishAllPorts: false,
					RestartPolicy: { Name: 'no' },
				},
			},
		},
	}
}

// Resolves a request path to a lexically safe absolute path under /workspace. Symlink
// escapes are caught later, by resolving inside the container.
export function workspacePath(p) {
	if (typeof p !== 'string' || !p || p.includes('\0')) throw new HttpError(400, 'invalid path')
	const abs = p.startsWith('/') ? p : `/workspace/${p}`
	const parts = abs.split('/').filter((s) => s && s !== '.')
	if (parts.includes('..')) throw new HttpError(403, 'path escapes /workspace')
	if (parts[0] !== 'workspace') throw new HttpError(403, 'path escapes /workspace')
	return `/${parts.join('/')}`
}
