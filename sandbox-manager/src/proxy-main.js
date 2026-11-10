import { createProxy } from './proxy.js'

const token = process.env.PROXY_ADMIN_TOKEN
if (!token) {
	console.error('PROXY_ADMIN_TOKEN is required')
	process.exit(1)
}
// Node, as a container's PID 1, would otherwise ignore SIGTERM until Docker kills it after the stop timeout.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0))
const { proxy, admin } = createProxy({ adminToken: token })
proxy.listen(Number(process.env.PROXY_PORT ?? 3128), '0.0.0.0')
admin.listen(Number(process.env.PROXY_ADMIN_PORT ?? 3129), '0.0.0.0')
console.log('egress-proxy listening')
