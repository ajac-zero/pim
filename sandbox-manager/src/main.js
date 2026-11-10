import { Docker } from './docker.js'
import { createManager, defaultMaxConcurrent, detectQuotaMode, selfCheck } from './manager.js'
import { DEFAULT_DISK_MIB } from './template.js'

const env = process.env
const need = (k) => env[k] || (console.error(`${k} is required`), process.exit(1))
const token = need('MANAGER_TOKEN')
const cfg = {
	token,
	// Changing it changes the tokens of new sessions only: a restarted manager reads the tokens of
	// running ones back from their containers.
	agentdSecret: env.AGENTD_TOKEN_SECRET || token,
	allowedImages: (env.ALLOWED_IMAGES || 'pim-workspace:local').split(',').map((s) => s.trim()).filter(Boolean),
	defaultDiskMiB: Number(env.DEFAULT_DISK_MIB || DEFAULT_DISK_MIB),
	dockerRoot: env.DOCKER_ROOT ?? '/var/lib/docker',
	minFreePct: Number(env.MIN_FREE_DISK_PCT ?? 15),
	maxConcurrent: Number(env.MAX_CONCURRENT || defaultMaxConcurrent()),
	maxConcurrentSource: env.MAX_CONCURRENT ? 'env' : 'default',
	maxTotalWorkspaceMiB: Number(env.MAX_TOTAL_WORKSPACE_GB ?? 100) * 1024,
	idleMin: Number(env.IDLE_MIN ?? 30),
	keptVolumeDays: Number(env.KEPT_VOLUME_DAYS ?? 7),
	proxyContainer: env.EGRESS_PROXY_CONTAINER ?? 'egress-proxy',
	proxyUrl: env.EGRESS_PROXY_URL ?? 'http://egress-proxy:3128',
	managerContainer: env.MANAGER_CONTAINER || undefined,
	agentdPort: Number(env.AGENTD_PORT || 8787),
	agentdReadyMs: Number(env.AGENTD_READY_MS || 30000),
	dataDir: env.DATA_DIR || '/data',
	snapshotMaxBytes: Number(env.SNAPSHOT_MAX_GB || 4) * 2 ** 30,
	envCachePct: Number(env.SNAPSHOT_CACHE_PCT ?? 20),
}
const adminUrl = env.EGRESS_PROXY_ADMIN_URL ?? 'http://egress-proxy:3129'
const adminToken = need('PROXY_ADMIN_TOKEN')
const adminCall = async (method, ip, body) => {
	const r = await fetch(`${adminUrl}/allow/${ip}`, { method, headers: { authorization: `Bearer ${adminToken}` }, body: body && JSON.stringify(body) })
	if (!r.ok) throw new Error(`egress-proxy admin ${r.status}`)
}
const proxyAdmin = { set: (ip, hosts) => adminCall('PUT', ip, { hosts }), del: (ip) => adminCall('DELETE', ip) }

const docker = new Docker(env.DOCKER_HOST ?? env.DOCKER_SOCKET)
try {
	await selfCheck(docker, env.PROBE_IMAGE ?? 'busybox:1.36')
	const mode = env.WORKSPACE_TMPFS === '1' ? 'tmpfs' : env.DISK_QUOTA_MODE || 'auto'
	if (!['auto', 'volume', 'measure', 'tmpfs'].includes(mode)) throw new Error(`DISK_QUOTA_MODE must be auto, volume, measure or tmpfs, not ${mode}`)
	cfg.quotaMode = mode === 'auto' ? await detectQuotaMode(docker) : mode
} catch (e) {
	console.error(e.message)
	process.exit(1)
}
// Sessions are containers of their own and outlive the manager: stopping it (a deploy, a restart)
// exits at once and touches none of them. Node, as a container's PID 1, would otherwise ignore
// SIGTERM until Docker kills it after the stop timeout.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0))
const manager = createManager({ docker, cfg, proxyAdmin })
await manager.reconcile()
// A run that is still going when the next is due is not overlapped.
const every = (sec, fn) => {
	let running = false
	setInterval(() => {
		if (running) return
		running = true
		fn()
			.catch((e) => console.error(e))
			.finally(() => (running = false))
	}, sec * 1000).unref()
}
every(30, manager.reap)
// Often, so a restarted egress proxy gets its allowlists back within seconds.
every(5, manager.reattach)
every(Number(env.DISK_CHECK_SEC || 60), manager.checkDisk)
manager.server.listen(Number(env.PORT ?? 8080), env.HOST ?? '0.0.0.0', () => console.log(`sandbox-manager ready (runsc verified, disk quota: ${cfg.quotaMode})`))
