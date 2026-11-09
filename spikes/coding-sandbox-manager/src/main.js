import { Docker } from './docker.js'
import { createManager, defaultMaxConcurrent, selfCheck } from './manager.js'

const env = process.env
const need = (k) => env[k] || (console.error(`${k} is required`), process.exit(1))
const cfg = {
	token: need('MANAGER_TOKEN'),
	allowedImages: need('ALLOWED_IMAGES').split(',').map((s) => s.trim()).filter(Boolean),
	dockerRoot: env.DOCKER_ROOT ?? '/var/lib/docker',
	minFreePct: Number(env.MIN_FREE_DISK_PCT ?? 15),
	maxConcurrent: Number(env.MAX_CONCURRENT || defaultMaxConcurrent()),
	idleMin: Number(env.IDLE_MIN ?? 30),
	proxyContainer: env.EGRESS_PROXY_CONTAINER ?? 'egress-proxy',
	proxyUrl: env.EGRESS_PROXY_URL ?? 'http://egress-proxy:3128',
	workspaceTmpfs: env.WORKSPACE_TMPFS === '1',
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
} catch (e) {
	console.error(e.message)
	process.exit(1)
}
const manager = createManager({ docker, cfg, proxyAdmin })
await manager.reconcile()
setInterval(() => manager.reap().catch(console.error), 30000).unref()
manager.server.listen(Number(env.PORT ?? 8080), env.HOST ?? '0.0.0.0', () => console.log('sandbox-manager ready (runsc verified)'))
