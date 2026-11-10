#!/usr/bin/env node
// hostopsd: runs the allowlisted host operations Pim queues for this host. It dials out to Pim,
// long-polls for one operation at a time, runs it, and reports the result, retrying the report
// until Pim accepts it. See README.md.
import { readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOps } from './ops.js'
import { loadState, saveState } from './state.js'
import { validateOp } from './validate.js'

export const VERSION = '1.0.0'
const ENV_FILE = '/etc/hostopsd/env'
const sleep = (ms, signal) =>
	new Promise((resolve) => {
		const t = setTimeout(resolve, ms)
		signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
	})
const jitter = (ms) => Math.round(ms * (0.5 + Math.random() * 0.5))

// KEY=VALUE lines, as in systemd environment files and docker compose .env files: comments,
// blank lines, an optional `export ` and matching quotes around the value.
export function parseEnvFile(text) {
	const out = {}
	for (const line of text.split('\n')) {
		const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
		if (!m) continue
		let v = m[2].trim()
		if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1)
		out[m[1]] = v
	}
	return out
}

const readEnvFile = (file) => {
	try {
		return parseEnvFile(readFileSync(file, 'utf8'))
	} catch (e) {
		if (e.code === 'ENOENT') return null
		throw e
	}
}

// Configuration comes from /etc/hostopsd/env (systemd also passes it as the environment), with
// the process environment taking precedence. The manager's environment file holds what up.sh
// and docker compose need (MANAGER_TOKEN, PROXY_ADMIN_TOKEN, ...).
export function loadConfig(env = process.env) {
	const e = { ...(readEnvFile(env.HOSTOPSD_ENV_FILE ?? ENV_FILE) ?? {}), ...env }
	const need = (k) => {
		if (!e[k]) throw new Error(`${k} is not set (in ${ENV_FILE} or the environment)`)
		return e[k]
	}
	const url = new URL(need('HOSTOPS_URL'))
	const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
	if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('HOSTOPS_URL must be an https:// origin')
	const checkout = path.resolve(need('PIM_CHECKOUT'))
	const managerEnvFile = e.MANAGER_ENV_FILE || path.join(checkout, 'sandbox-manager/.env')
	const managerEnv = readEnvFile(managerEnvFile) ?? {}
	const managerToken = e.MANAGER_TOKEN || managerEnv.MANAGER_TOKEN
	if (!managerToken) throw new Error(`MANAGER_TOKEN is not set and not in ${managerEnvFile}`)
	const token = need('HOSTOPS_TOKEN')
	const num = (k, d) => (e[k] ? Number(e[k]) : d)
	return {
		url: url.origin,
		token,
		checkout,
		managerUrl: e.MANAGER_URL || 'http://127.0.0.1:8080',
		managerToken,
		managerEnv,
		stateFile: e.HOSTOPSD_STATE_FILE || '/var/lib/hostopsd/state.json',
		path: e.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
		home: e.HOME || os.homedir(),
		version: VERSION,
		// Values replaced wherever they appear in anything reported to Pim: the credentials above, and
		// the value of every secret-looking variable in the manager's environment and this daemon's.
		secrets: [token, managerToken, ...Object.entries({ ...managerEnv, ...e }).filter(([k]) => /TOKEN|SECRET|PASSWORD|KEY/.test(k)).map(([, v]) => v)],
		waitMs: 25000,
		healthTimeoutMs: num('HOSTOPSD_HEALTH_TIMEOUT_MS', 120000),
		healthIntervalMs: num('HOSTOPSD_HEALTH_INTERVAL_MS', 2000),
		idleTimeoutMs: num('HOSTOPSD_IDLE_TIMEOUT_MS', 10 * 60000),
		idleIntervalMs: num('HOSTOPSD_IDLE_INTERVAL_MS', 5000),
		sessionsTimeoutMs: num('HOSTOPSD_SESSIONS_TIMEOUT_MS', 60000),
		sessionsIntervalMs: num('HOSTOPSD_SESSIONS_INTERVAL_MS', 2000),
		backoffMinMs: num('HOSTOPSD_BACKOFF_MIN_MS', 1000),
		backoffMaxMs: num('HOSTOPSD_BACKOFF_MAX_MS', 60000),
		unauthorizedRetryMs: num('HOSTOPSD_UNAUTHORIZED_RETRY_MS', 5 * 60000),
	}
}

// Results Pim rejects for good (unknown or finished op, malformed result) are dropped rather than
// retried forever; everything else, 401 included, is retried.
const QUIET_FAILURES = 3
const PERMANENT = new Set([400, 404, 409, 410, 413, 422])

export function createDaemon(cfg, { log = (m) => console.log(m) } = {}) {
	let state
	let ops
	let failures = 0
	let restartAfterReport = false
	const save = () => saveState(cfg.stateFile, state)

	async function call(p, body, timeoutMs, stop) {
		const res = await fetch(`${cfg.url}${p}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', 'user-agent': `hostopsd/${VERSION}` },
			body: JSON.stringify(body),
			signal: stop ? AbortSignal.any([AbortSignal.timeout(timeoutMs), stop]) : AbortSignal.timeout(timeoutMs),
		})
		const text = await res.text()
		return { status: res.status, text }
	}

	// How long to wait after a failed request: exponential with jitter, and slowly after a 401,
	// which means the credential was revoked or is wrong and will not fix itself soon.
	// A 5xx or a dropped connection is transient (Pim deploying, a Durable Object resetting, a proxy
	// closing an idle long poll), so it is retried quietly: only the third failure in a row is logged,
	// and then the recovery.
	function backoff(status, what, detail) {
		if (status === 401) {
			const ms = jitter(cfg.unauthorizedRetryMs)
			log(`${what}: Pim rejected HOSTOPS_TOKEN (401); the credential may have been revoked. Retrying in ${Math.round(ms / 1000)} s.`)
			return ms
		}
		failures++
		if (failures === QUIET_FAILURES) log(`${what}: ${detail ?? 'failing'}, ${QUIET_FAILURES} times in a row; retrying with backoff.`)
		return jitter(Math.min(cfg.backoffMaxMs, cfg.backoffMinMs * 2 ** Math.min(failures - 1, 16)))
	}

	// A request got through: forgets earlier failures.
	function recovered() {
		if (failures >= QUIET_FAILURES) log('Pim is answering again.')
		failures = 0
	}

	async function queue(outcome) {
		if (!outcome) return
		state.pendingResults.push(outcome.result)
		await save()
		if (outcome.restartSelf) restartAfterReport = true
		log(`op ${outcome.result.id}: ${outcome.result.state}: ${outcome.result.summary.replace(/\s*\n\s*/g, ' ')}`)
	}

	// Sends the oldest pending result. Returns the time to wait before trying again, or 0.
	async function deliverOne() {
		const r = state.pendingResults[0]
		let status
		try {
			;({ status } = await call('/api/hostops/agent/result', r, 30000))
		} catch (e) {
			return backoff(0, `result ${r.id}`, e.cause?.code ?? e.message)
		}
		if (status >= 200 && status < 300) {
			log(`result ${r.id}: delivered`)
		} else if (PERMANENT.has(status)) {
			log(`result ${r.id}: Pim refused it with ${status}; dropping it`)
		} else {
			return backoff(status, `result ${r.id}`, `Pim answered ${status}`)
		}
		recovered()
		state.pendingResults.shift()
		await save()
		return 0
	}

	// Asks Pim for the next op. Returns {op} or {waitMs}.
	async function poll(stop) {
		let res
		try {
			const commit = await ops.head().catch(() => null)
			res = await call('/api/hostops/agent/poll', { agentVersion: VERSION, commit, waitMs: cfg.waitMs }, cfg.waitMs + 15000, stop)
		} catch (e) {
			return { waitMs: backoff(0, 'poll', e.cause?.code ?? e.message) }
		}
		if (res.status === 204) {
			recovered()
			return {}
		}
		if (res.status !== 200) {
			return { waitMs: backoff(res.status, 'poll', `Pim answered ${res.status}`) }
		}
		recovered()
		let body
		try {
			body = JSON.parse(res.text)
		} catch {
			return { waitMs: backoff(0, 'poll', 'the answer is not JSON') }
		}
		return { op: body?.op ?? null }
	}

	async function handle(raw) {
		const v = validateOp(raw)
		if (!v.id) {
			log(`poll: ignoring an op without a valid id: ${v.error}`)
			return { waitMs: jitter(cfg.backoffMaxMs) }
		}
		if (v.error) {
			await queue({ result: { id: v.id, ok: false, state: 'failed', summary: `Refused: ${v.error}. Nothing ran.`, data: {} } })
			return
		}
		// A command stays out of the log: it is in Pim's audit log, and it may hold a secret no pattern knows.
		const args = v.op.name === 'exec' ? `a command of ${v.op.args.command.length} characters` : JSON.stringify(v.op.args)
		log(`op ${v.id}: ${v.op.name} ${args}`)
		await queue(await ops.run(v.op))
	}

	return {
		async start() {
			state = await loadState(cfg.stateFile)
			ops = createOps(cfg, { state, save, log })
			cfg.startCommit = await ops.head().catch(() => null)
			await queue(await ops.recover())
		},
		// One step of the loop: deliver a pending result, or poll and run an op. Returns how long to
		// wait before the next step and whether the daemon should exit to restart.
		async step(stop) {
			if (state.pendingResults.length) return { waitMs: await deliverOne() }
			if (restartAfterReport) return { exit: true }
			const p = await poll(stop)
			if (p.op) return (await handle(p.op)) ?? {}
			return { waitMs: p.waitMs ?? 0 }
		},
		async run(signal) {
			await this.start()
			log(`hostopsd ${VERSION} polling ${cfg.url} for ${cfg.checkout} (at ${cfg.startCommit?.slice(0, 12) ?? 'unknown commit'})`)
			while (!signal?.aborted) {
				const s = await this.step(signal)
				if (s.exit) {
					log('restarting to run the code now checked out')
					return 'restart'
				}
				if (s.waitMs) await sleep(s.waitMs, signal)
			}
			return 'stopped'
		},
		get state() {
			return state
		},
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
	let cfg
	try {
		cfg = loadConfig()
	} catch (e) {
		console.error(`hostopsd: ${e.message}`)
		process.exit(2)
	}
	const stop = new AbortController()
	for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stop.abort())
	createDaemon(cfg)
		.run(stop.signal)
		.then(() => process.exit(0))
		.catch((e) => {
			console.error(`hostopsd: ${e.stack ?? e}`)
			process.exit(1)
		})
}
