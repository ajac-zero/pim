// Everything that reaches Docker's create calls is built here from a fixed template plus
// validated numbers. Request bodies never contribute raw Docker fields: unknown keys are
// rejected, so a caller cannot ask for binds, privileged mode, capabilities or host networking.
import { HttpError } from './errors.js'

export const LABEL = 'pim.coding.session'
export const LABEL_SPEC = 'pim.coding.spec'
// A random value per container. The manager derives the session's agentd token from it and its
// own secret, so the token itself is never stored in a label.
export const LABEL_NONCE = 'pim.coding.nonce'
// Marks the small marker volume that records a kept workspace volume (see `names().marker`).
export const LABEL_KEPT = 'pim.coding.kept'
export const LABEL_KEPT_INFO = 'pim.coding.kept-info'
export const AGENTD_PORT = 8787
// The API caps each of stdout and stderr at 10 MiB; agentd caps their sum, so it gets twice that.
export const MAX_OUTPUT = 10 * 1024 * 1024
const MiB = 1024 * 1024

export const BOUNDS = {
	cpu: [0.1, 4],
	memMiB: [64, 8192],
	diskMiB: [64, 20480],
	pids: [16, 2048],
}
export const DEFAULT_DISK_MIB = 5120

const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/

function onlyKeys(obj, allowed, what) {
	for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new HttpError(400, `unknown field ${what}${k}`)
}

// `image` defaults to the first allowed image and `limits.diskMiB` to `defaultDiskMiB`.
export function parseCreate(body, allowedImages, defaultDiskMiB = DEFAULT_DISK_MIB) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be an object')
	onlyKeys(body, ['sessionId', 'image', 'limits', 'egressAllow'], '')
	const { sessionId, image = allowedImages[0], limits, egressAllow = [] } = body
	if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new HttpError(400, 'invalid sessionId')
	if (typeof image !== 'string' || !allowedImages.includes(image)) throw new HttpError(403, 'image is not allowed')
	if (!limits || typeof limits !== 'object') throw new HttpError(400, 'limits required')
	onlyKeys(limits, Object.keys(BOUNDS), 'limits.')
	const filled = { diskMiB: defaultDiskMiB, ...limits }
	for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
		const v = filled[k]
		if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new HttpError(400, `limits.${k} must be a number in [${lo}, ${hi}]`)
		if (k !== 'cpu' && !Number.isInteger(v)) throw new HttpError(400, `limits.${k} must be an integer`)
	}
	if (!Array.isArray(egressAllow) || egressAllow.length > 64 || !egressAllow.every((h) => typeof h === 'string' && HOST.test(h))) {
		throw new HttpError(400, 'egressAllow must be an array of hostnames (optionally *.suffix)')
	}
	return { sessionId, image, limits: { cpu: filled.cpu, memMiB: filled.memMiB, diskMiB: filled.diskMiB, pids: filled.pids }, egressAllow: [...new Set(egressAllow)] }
}

export const names = (id) => ({ container: `pim-s-${id}`, volume: `pim-ws-${id}`, network: `pim-net-${id}`, marker: `pim-kept-${id}` })

// The proxy variables a session's commands get. The manager also passes them with every exec,
// because the proxy's address changes when it is re-attached to the session network.
export const proxyEnv = (proxyUrl) => ({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '' })

// opts: { proxyUrl, quotaMode: 'volume' | 'measure' | 'tmpfs', nonce, token, agentdPort }
export function buildSpec(params, opts) {
	const { sessionId, image, limits } = params
	const n = names(sessionId)
	const labels = { [LABEL]: sessionId, [LABEL_SPEC]: JSON.stringify(params) }
	const driverOpts = {
		// An XFS project quota on the volume's directory; Docker refuses it on other filesystems.
		volume: { size: `${limits.diskMiB}m` },
		// Enforces diskMiB too, but is memory-backed.
		tmpfs: { type: 'tmpfs', device: 'tmpfs', o: `size=${limits.diskMiB}m,uid=10001,gid=10001,mode=0755` },
	}[opts.quotaMode]
	const env = {
		HOME: '/workspace',
		...proxyEnv(opts.proxyUrl),
		// Visible to Docker API clients (docker inspect) and to the session's own user; agentd keeps
		// it out of the commands it runs, and the manager never logs it. See the README.
		AGENTD_TOKEN: opts.token,
		AGENTD_ROOT: '/workspace',
		AGENTD_PORT: String(opts.agentdPort ?? AGENTD_PORT),
		AGENTD_MAX_OUTPUT_BYTES: String(2 * MAX_OUTPUT),
	}
	return {
		volume: { Name: n.volume, Labels: labels, ...(driverOpts && { Driver: 'local', DriverOpts: driverOpts }) },
		network: { Name: n.network, Driver: 'bridge', Internal: true, Labels: labels },
		container: {
			name: n.container,
			body: {
				Image: image,
				User: '10001',
				// The image's own entrypoint runs workspace-agentd.
				WorkingDir: '/workspace',
				Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
				Labels: { ...labels, [LABEL_NONCE]: opts.nonce },
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
// escapes are caught by agentd, which resolves the path inside the container.
export function workspacePath(p) {
	if (typeof p !== 'string' || !p || p.includes('\0')) throw new HttpError(400, 'invalid path')
	const abs = p.startsWith('/') ? p : `/workspace/${p}`
	const parts = abs.split('/').filter((s) => s && s !== '.')
	if (parts.includes('..')) throw new HttpError(403, 'path escapes /workspace')
	if (parts[0] !== 'workspace') throw new HttpError(403, 'path escapes /workspace')
	return `/${parts.join('/')}`
}

// The same path relative to /workspace, as agentd takes it ('.' for /workspace itself).
export const agentdPath = (abs) => abs.slice('/workspace/'.length) || '.'
