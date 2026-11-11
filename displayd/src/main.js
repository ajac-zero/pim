#!/usr/bin/env node
// displayd: per-thread isolated X displays for the agent computer. See README.md.
import { readFileSync } from 'node:fs'
import { DisplayAllocator } from './allocator.js'
import { createServer } from './api.js'
import { parseMeminfo } from './memory.js'
import { RealRunner } from './runner.js'
import { loadSites } from './sites.js'
import { FileStore } from './store.js'

const log = (m) => console.log(`${new Date().toISOString()} ${m}`)
const e = process.env
const token = (e.DISPLAYD_TOKEN || (e.DISPLAYD_TOKEN_FILE ? readFileSync(e.DISPLAYD_TOKEN_FILE, 'utf8') : '')).trim()
if (!token) {
	console.error('displayd: set DISPLAYD_TOKEN or DISPLAYD_TOKEN_FILE')
	process.exit(1)
}
const minutes = (k, name) => (e[k] ? { [name]: Number(e[k]) * 60_000 } : {})

const stateDir = e.DISPLAYD_STATE_DIR || '/var/lib/displayd'
const allocator = new DisplayAllocator({
	sites: loadSites(e.DISPLAYD_SITES_FILE || `${stateDir}/sites.json`),
	runner: new RealRunner({ root: e.DISPLAYD_CONTEXT_DIR || '/run/pim/displays' }),
	store: new FileStore(stateDir),
	readMemory: async () => parseMeminfo(readFileSync('/proc/meminfo', 'utf8')),
	log,
	config: { ...(e.DISPLAYD_MAX_DISPLAYS ? { maxDisplays: Number(e.DISPLAYD_MAX_DISPLAYS) } : {}), ...minutes('DISPLAYD_IDLE_TTL_MIN', 'ttlMs'), ...minutes('DISPLAYD_BROWSER_TTL_MIN', 'browserTtlMs') },
})
await allocator.recover()

const server = createServer({ allocator, token })
const host = e.DISPLAYD_HOST || '127.0.0.1'
const port = Number(e.DISPLAYD_PORT || 9900)
server.listen(port, host, () => log(`displayd listening on ${host}:${port}`))
const timer = setInterval(() => allocator.tick().catch((err) => log(`tick failed: ${err.stack}`)), 5000)

// Displays outlive displayd (the unit uses KillMode=process); the next start re-adopts them.
for (const sig of ['SIGTERM', 'SIGINT'])
	process.on(sig, () => {
		clearInterval(timer)
		server.close(() => process.exit(0))
		setTimeout(() => process.exit(0), 2000).unref()
	})
