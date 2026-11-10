// The operations hostopsd runs on the host. Each takes arguments that validate.js has already
// checked and returns a result for Pim: {id, ok, state, summary, data}. Only one runs at a time.
// deploy and rollback change the checkout; the one in progress is recorded in the state file
// (state.deploy), which is also the deploy lock, so a daemon that restarts mid-deploy can finish
// the job (recover()).
import { readFileSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeFailure, run } from './exec.js'
import { pidAlive } from './state.js'
import { COMMIT } from './validate.js'

export const SUMMARY_MAX = 2000
export const DATA_MAX = 64 * 1024
const LOG_TEXT_MAX = 60 * 1024

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const short = (sha) => String(sha).slice(0, 12)

function bootId() {
	try {
		return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
	} catch {
		return null
	}
}

// Credentials with a recognizable shape, which the generic runs below would miss when short: vendor
// key prefixes, JWTs, private key blocks, hostopsd's own credentials, and the value of an assignment
// to a variable named like a secret (TOKEN=..., "password": "...", api_key: ...).
const KEY_LIKE = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8000}?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bpimhostops_[A-Za-z0-9_-]+/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
	/((?:token|secret|passw(?:or)?d|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]{0,40})["']?\s*[=:]\s*(?!\[redacted\])(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi,
]

// Log output and command errors can carry credentials. Known secret values are replaced wherever
// they appear; in command output, so are bearer tokens and long runs of hex or base64.
export function redact(text, secrets = []) {
	let s = scrub(String(text), secrets)
	s = s.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
	for (const pattern of KEY_LIKE) s = s.replace(pattern, (_, name) => (typeof name === 'string' ? `${name}=[redacted]` : '[redacted]'))
	s = s.replace(/[0-9a-fA-F]{32,}/g, '[redacted]')
	// Base64 (and base64url) runs of 32 or more characters. A path or a hyphenated name such as
	// "sandbox-manager-docker-socket-proxy-1" is also made of these characters; a token differs in
	// having digits and a long stretch without a separator.
	s = s.replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) && Math.max(...m.split(/[+/_-]/).map((p) => p.length)) >= 16 ? '[redacted]' : m))
	return s
}

function scrub(s, secrets) {
	for (const v of secrets) if (v && v.length >= 8) s = s.split(v).join('[redacted]')
	return s
}

function scrubDeep(v, secrets) {
	if (typeof v === 'string') return scrub(v, secrets)
	if (Array.isArray(v)) return v.map((x) => scrubDeep(x, secrets))
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x, secrets)]))
	return v
}

const bytes = (v) => Buffer.byteLength(JSON.stringify(v))
function clipStrings(v, max) {
	if (typeof v === 'string') return v.length > max ? `…${v.slice(-max)}` : v
	if (Array.isArray(v)) return v.map((x) => clipStrings(x, max))
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipStrings(x, max)]))
	return v
}

// Keeps a result's data under 64 KB by shortening its longest strings (keeping their ends).
export function fitData(data) {
	if (bytes(data) <= DATA_MAX) return data
	for (let max = 16384; max >= 64; max >>= 1) {
		const d = { ...clipStrings(data, max), truncated: true }
		if (bytes(d) <= DATA_MAX) return d
	}
	return { truncated: true, note: 'the result data was over 64 KB' }
}

// cfg: checkout, managerUrl, managerToken, managerEnv, path, home, version, secrets, startCommit,
// healthTimeoutMs, healthIntervalMs. state/save: the state file, shared with the daemon.
export function createOps(cfg, { state, save, log = () => {} }) {
	const checkout = path.resolve(cfg.checkout)
	const smDir = path.join(checkout, 'sandbox-manager')
	const baseEnv = { PATH: cfg.path, HOME: cfg.home, LANG: 'C.UTF-8' }
	const composeEnv = (buildSha) => ({ ...baseEnv, ...cfg.managerEnv, BUILD_SHA: buildSha })
	const t = { git: 60000, fetch: 180000, up: 30 * 60000, compose: 180000, probe: 30000, http: 10000, ...cfg.timeouts }
	const failText = (name, r) => redact(describeFailure(name, r), cfg.secrets)
	let busy = false

	const git = (args, timeoutMs = t.git) => run('git', ['-c', `safe.directory=${checkout}`, ...args], { cwd: checkout, env: { ...baseEnv, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, timeoutMs })
	async function gitOut(args, timeoutMs) {
		const r = await git(args, timeoutMs)
		if (r.code !== 0) throw new Error(failText(`git ${args[0]}`, r))
		return r.stdout.trim()
	}
	const head = () => gitOut(['rev-parse', 'HEAD'])
	// The full hash of a commit the name resolves to, or null.
	async function resolveCommit(name) {
		const r = await git(['rev-parse', '--verify', '--quiet', `${name}^{commit}`])
		return r.code === 0 ? r.stdout.trim() : null
	}

	async function manager(method, p, body) {
		const res = await fetch(new URL(p, cfg.managerUrl), {
			method,
			headers: { authorization: `Bearer ${cfg.managerToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(t.http),
		})
		const text = await res.text()
		let json = null
		try {
			json = JSON.parse(text)
		} catch {}
		return { status: res.status, json, text }
	}

	// The manager is healthy at a commit when /health answers 200, says ok (or, from a manager
	// without the ok field, that gVisor is there), and reports that commit's short hash.
	function healthProblem(r, sha) {
		if (r.status !== 200 || !r.json) return `/health answered ${r.status}`
		const j = r.json
		if (j.ok === false || (j.ok === undefined && j.runsc !== true)) return '/health is not ok'
		const c = String(j.commit ?? j.version ?? '')
		if (!/^[0-9a-f]{7,40}$/.test(c) || !sha.startsWith(c)) return `/health reports commit ${c || 'none'}, not ${short(sha)}`
		return null
	}
	async function waitHealthy(sha) {
		const until = Date.now() + cfg.healthTimeoutMs
		let problem = 'no answer'
		for (;;) {
			try {
				const r = await manager('GET', '/health')
				problem = healthProblem(r, sha)
				if (!problem) return { ok: true, health: r.json }
			} catch (e) {
				problem = `/health: ${e.cause?.code ?? e.message}`
			}
			if (Date.now() + cfg.healthIntervalMs > until) return { ok: false, problem }
			await sleep(cfg.healthIntervalMs)
		}
	}

	// Before the manager is recreated, which kills every session it runs and so the threads in them,
	// waits for it to have none, polling /health. It gives up after cfg.idleTimeoutMs and goes ahead,
	// so a manager that is never idle can still be deployed to; a manager that doesn't answer has
	// nothing to protect. Both outcomes are logged and returned for the operation's summary.
	async function waitIdle(op) {
		const until = Date.now() + cfg.idleTimeoutMs
		let running = 0
		let deferred = false
		for (;;) {
			try {
				const r = await manager('GET', '/health')
				running = Number(r.json?.running) || 0
			} catch {
				if (deferred) log(`${op.name}: the manager does not answer, so proceeding`)
				return deferred ? 'The manager stopped answering while waiting, so it went ahead.' : ''
			}
			if (running === 0) {
				if (deferred) log(`${op.name}: the manager is idle, proceeding`)
				return deferred ? 'Waited for the manager to be idle.' : ''
			}
			if (Date.now() + cfg.idleIntervalMs > until) {
				log(`${op.name}: the manager still runs ${running} sessions after ${Math.round(cfg.idleTimeoutMs / 1000)} s, proceeding anyway`)
				return `Went ahead with ${running} sessions still running after waiting ${Math.round(cfg.idleTimeoutMs / 1000)} s; their threads were interrupted.`
			}
			if (!deferred) log(`${op.name}: deferring, the manager runs ${running} sessions; waiting up to ${Math.round(cfg.idleTimeoutMs / 1000)} s for it to be idle`)
			deferred = true
			await sleep(cfg.idleIntervalMs)
		}
	}

	// Checks out a commit, rebuilds the stack with up.sh and waits for the manager to report it.
	async function checkoutAndUp(sha) {
		const co = await git(['checkout', '--detach', '--quiet', sha], t.git)
		if (co.code !== 0) return { ok: false, step: 'checkout', error: failText(`git checkout ${short(sha)}`, co) }
		let buildSha
		try {
			buildSha = await gitOut(['rev-parse', '--short', sha])
		} catch (e) {
			return { ok: false, step: 'checkout', error: e.message }
		}
		const up = await run(path.join(smDir, 'up.sh'), [], { cwd: smDir, env: composeEnv(buildSha), timeoutMs: t.up })
		if (up.code !== 0) return { ok: false, step: 'up.sh', error: failText('up.sh', up) }
		const h = await waitHealthy(sha)
		if (!h.ok) return { ok: false, step: 'health', error: `the manager was not healthy at ${buildSha} within ${Math.round(cfg.healthTimeoutMs / 1000)} s: ${h.problem}` }
		return { ok: true, health: h.health }
	}

	// Whether the daemon's own code differs between the commit it started from and HEAD, so it has
	// to restart to run what is checked out.
	async function ownCodeChanged() {
		if (!cfg.startCommit) return false
		const r = await git(['diff', '--quiet', cfg.startCommit, 'HEAD', '--', 'sandbox-manager/hostopsd'])
		return r.code === 1
	}

	const recordDeploy = (kind, opId, previous, commit) => state.deploys.push({ kind, opId, commit, previous, at: new Date().toISOString() })

	// Moves the checkout from `previous` to `target` with the state file recording it. A deploy
	// (revert) that fails goes back to `previous`; a rollback does not try again.
	async function changeCheckout(op, { kind, previous, target, revert }) {
		state.deploy = { kind, opId: op.id, previous, target, status: 'running', pid: process.pid, bootId: bootId(), startedAt: new Date().toISOString() }
		await save()
		const r = await checkoutAndUp(target)
		const commits = { previous, target }
		if (r.ok) {
			recordDeploy(kind, op.id, previous, target)
			state.deploy = null
			await save()
			const verb = kind === 'deploy' ? 'Deployed' : 'Rolled back to'
			return { result: done(op.id, 'succeeded', `${verb} ${short(target)} (was ${short(previous)}); the manager is healthy at it.`, { ...commits, health: r.health }), restartSelf: await ownCodeChanged() }
		}
		const moved = r.step !== 'checkout' || (await head().catch(() => null)) !== previous
		if (!revert || !moved) {
			state.deploy = null
			await save()
			if (!moved) return { result: done(op.id, 'failed', `${kind} of ${short(target)} failed before anything changed: ${r.error}`, { ...commits, step: r.step }) }
			return { result: done(op.id, 'failed', `Rollback to ${short(target)} failed at ${r.step}: ${r.error}. The checkout is at ${short(target)} (was ${short(previous)}); nothing more was tried.`, { ...commits, step: r.step }) }
		}
		state.deploy.status = 'rolling_back'
		state.deploy.error = r.error
		await save()
		log(`deploy of ${short(target)} failed at ${r.step}; rolling back to ${short(previous)}`)
		return revertTo(op.id, state.deploy, `Deploy of ${short(target)} failed at ${r.step}: ${r.error}.`)
	}

	async function revertTo(opId, d, why) {
		const back = await checkoutAndUp(d.previous)
		state.deploy = null
		await save()
		const commits = { previous: d.previous, target: d.target }
		if (back.ok) return { result: done(opId, 'rolled_back', `${why} Rolled back to ${short(d.previous)}, which is healthy.`, { ...commits, health: back.health }), restartSelf: await ownCodeChanged() }
		return { result: done(opId, 'failed', `${why} The rollback to ${short(d.previous)} also failed at ${back.step}: ${back.error}. The manager needs attention on the host.`, { ...commits, rollbackStep: back.step }) }
	}

	function done(id, st, summary, data = {}) {
		const text = scrub(summary, cfg.secrets)
		return { id, ok: st === 'succeeded', state: st, summary: text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text, data: fitData(scrubDeep(data, cfg.secrets)) }
	}
	const fail = (op, summary, data) => ({ result: done(op.id, 'failed', summary, data) })
	// What the exec operation's command runs with: no credential of hostopsd's, nor the manager's environment.
	const execEnv = { PATH: cfg.path, HOME: cfg.home, LANG: 'C.UTF-8' }

	function deployBlocked() {
		const d = state.deploy
		if (!d) return null
		const live = d.pid !== process.pid && d.bootId === bootId() && pidAlive(d.pid)
		return `${d.kind} ${d.opId} of ${short(d.target)} is ${live ? `running in process ${d.pid}` : 'unfinished in the state file'}`
	}

	const handlers = {
		async stats(op) {
			const errors = {}
			const tryTo = async (key, fn) => {
				try {
					return await fn()
				} catch (e) {
					errors[key] = redact(e.message, cfg.secrets).slice(0, 500)
					return null
				}
			}
			const docker = async (args) => {
				const r = await run('docker', args, { cwd: smDir, env: baseEnv, timeoutMs: t.probe })
				if (r.code !== 0) throw new Error(failText(`docker ${args[0]}`, r))
				return r.stdout
			}
			const jsonLines = (s) => s.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
			const disk = async (p) => {
				const s = await fs.statfs(p)
				const total = s.blocks * s.bsize
				const free = s.bavail * s.bsize
				return { path: p, totalBytes: total, freeBytes: free, freePct: total ? Math.round((free / total) * 1000) / 10 : null }
			}
			const [l1, l5, l15] = os.loadavg()
			const mem = await tryTo('memory', async () => {
				const kb = Object.fromEntries((await fs.readFile('/proc/meminfo', 'utf8')).split('\n').map((l) => l.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map((m) => [m[1], Number(m[2]) * 1024]))
				return { memory: { totalBytes: kb.MemTotal, availableBytes: kb.MemAvailable }, swap: { totalBytes: kb.SwapTotal, freeBytes: kb.SwapFree } }
			})
			const dockerRoot = await tryTo('dockerRoot', async () => (await docker(['info', '--format', '{{.DockerRootDir}}'])).trim())
			const data = {
				hostopsd: { version: cfg.version, pid: process.pid, uptimeSec: Math.round(process.uptime()) },
				uptimeSec: Math.round(os.uptime()),
				cpus: os.availableParallelism?.() ?? os.cpus().length,
				load: { 1: l1, 5: l5, 15: l15 },
				memory: mem?.memory ?? { totalBytes: os.totalmem(), availableBytes: os.freemem() },
				swap: mem?.swap ?? null,
				disk: {
					root: await tryTo('diskRoot', () => disk('/')),
					dockerRoot: dockerRoot ? await tryTo('diskDockerRoot', () => disk(dockerRoot)) : null,
				},
				dockerDf: await tryTo('dockerDf', async () => jsonLines(await docker(['system', 'df', '--format', '{{json .}}'])).map((d) => ({ type: d.Type, total: d.TotalCount, active: d.Active, size: d.Size, reclaimable: d.Reclaimable }))),
				containers: await tryTo('containers', async () => jsonLines(await docker(['ps', '--all', '--format', '{{json .}}'])).slice(0, 200).map((c) => ({ name: c.Names, state: c.State, status: c.Status, image: c.Image }))),
				manager: await tryTo('manager', async () => {
					const r = await manager('GET', '/health')
					if (r.status !== 200 || !r.json) throw new Error(`/health answered ${r.status}`)
					return r.json
				}),
				commit: await tryTo('commit', head),
			}
			if (Object.keys(errors).length) data.errors = errors
			const gib = (b) => (b / 1024 ** 3).toFixed(1)
			const parts = [`load ${l1.toFixed(2)}/${l5.toFixed(2)}/${l15.toFixed(2)} on ${data.cpus} CPUs`]
			if (data.memory.totalBytes) parts.push(`${gib(data.memory.availableBytes)} of ${gib(data.memory.totalBytes)} GiB memory available`)
			if (data.disk.root) parts.push(`/ ${data.disk.root.freePct}% free`)
			if (data.disk.dockerRoot && data.disk.dockerRoot.path !== '/') parts.push(`${data.disk.dockerRoot.path} ${data.disk.dockerRoot.freePct}% free`)
			if (data.containers) parts.push(`${data.containers.filter((c) => c.state === 'running').length} containers running`)
			if (data.manager) parts.push(`manager ${data.manager.commit ?? data.manager.version ?? '?'} with ${data.manager.running ?? '?'} of ${data.manager.maxConcurrent ?? '?'} slots in use`)
			if (data.commit) parts.push(`checkout at ${short(data.commit)}`)
			if (data.errors) parts.push(`could not read ${Object.keys(data.errors).join(', ')}`)
			return { result: done(op.id, 'succeeded', `${parts.join('; ')}.`, data) }
		},

		async deploy(op) {
			const { ref } = op.args
			const blocked = deployBlocked()
			if (blocked) return fail(op, `Not deploying: ${blocked}.`)
			let previous
			try {
				previous = await head()
			} catch (e) {
				return fail(op, `Cannot read the current commit: ${e.message}`)
			}
			const f = await git(['fetch', '--prune', '--quiet', 'origin'], t.fetch)
			if (f.code !== 0) return fail(op, failText('git fetch origin', f))
			const target = await resolveCommit(ref)
			if (!target) return fail(op, `${ref} does not name a commit in the checkout.`)
			const explicit = COMMIT.test(ref) && target.startsWith(ref.toLowerCase())
			if (!explicit) {
				const a = await git(['merge-base', '--is-ancestor', previous, target])
				if (a.code === 1) return fail(op, `Not deploying ${ref} (${short(target)}): it is not a fast-forward of the current commit ${short(previous)}. Deploy it by its commit hash to go there anyway.`, { previous, target })
				if (a.code !== 0) return fail(op, failText('git merge-base', a))
			}
			const waited = await waitIdle(op)
			const out = await changeCheckout(op, { kind: 'deploy', previous, target, revert: true })
			if (waited) out.result = done(op.id, out.result.state, `${waited} ${out.result.summary}`, out.result.data)
			return out
		},

		async rollback(op) {
			const blocked = deployBlocked()
			if (blocked) return fail(op, `Not rolling back: ${blocked}.`)
			const { commit } = op.args
			const target = await resolveCommit(commit)
			if (!target || !target.startsWith(commit)) return fail(op, `${commit} is not a commit in the checkout.`)
			let previous
			try {
				previous = await head()
			} catch (e) {
				return fail(op, `Cannot read the current commit: ${e.message}`)
			}
			const ancestor = (await git(['merge-base', '--is-ancestor', target, previous])).code === 0
			const deployed = state.deploys.some((d) => d.commit === target || d.previous === target)
			if (!ancestor && !deployed) return fail(op, `Not rolling back to ${short(target)}: it is neither an ancestor of the current commit ${short(previous)} nor a commit hostopsd has deployed.`, { previous, target })
			return changeCheckout(op, { kind: 'rollback', previous, target, revert: false })
		},

		async restart(op) {
			const { service } = op.args
			if (service === 'hostopsd') return { result: done(op.id, 'succeeded', 'hostopsd restarts after sending this result.', { service }), restartSelf: true }
			let buildSha
			try {
				buildSha = await gitOut(['rev-parse', '--short', 'HEAD'])
			} catch (e) {
				return fail(op, `Cannot read the current commit: ${e.message}`)
			}
			const waited = service === 'sandbox-manager' ? await waitIdle(op) : ''
			const r = await run('docker', ['compose', 'restart', service], { cwd: smDir, env: composeEnv(buildSha), timeoutMs: t.compose })
			if (r.code !== 0) return fail(op, failText(`docker compose restart ${service}`, r), { service })
			return { result: done(op.id, 'succeeded', `${waited ? `${waited} ` : ''}Restarted ${service}.`, { service }) }
		},

		async logs(op) {
			const { service, lines } = op.args
			const r =
				service === 'hostopsd'
					? await run('journalctl', ['--unit', 'hostopsd', '--lines', String(lines), '--no-pager', '--output', 'short-iso'], { cwd: '/', env: baseEnv, timeoutMs: t.probe })
					: await run('docker', ['compose', 'logs', '--no-color', '--tail', String(lines), service], { cwd: smDir, env: composeEnv((await gitOut(['rev-parse', '--short', 'HEAD']).catch(() => 'unknown')) || 'unknown'), timeoutMs: t.probe })
			if (r.code !== 0) return fail(op, failText(service === 'hostopsd' ? 'journalctl' : 'docker compose logs', r), { service })
			let text = redact(r.stdout, cfg.secrets)
			const truncated = Buffer.byteLength(text) > LOG_TEXT_MAX
			if (truncated) text = Buffer.from(text).subarray(-LOG_TEXT_MAX).toString('utf8').replace(/^[^\n]*\n/, '')
			const count = text.split('\n').filter(Boolean).length
			return { result: done(op.id, 'succeeded', `${count} lines of ${service} logs${truncated ? ' (cut to the last 60 KB)' : ''}.`, { service, lines, text, truncated }) }
		},

		// Runs one command for the admin's majordomo, whom the admin approved for this call in Pim, as
		// the unprivileged hostopsd user: this daemon never runs as root and never uses sudo. The shell
		// is non-interactive, with no stdin and no terminal; the timeout kills its whole process group.
		// The output (stdout and stderr together) is redacted first, then cut to its last maxOutputBytes.
		async exec(op) {
			const { command, timeoutSeconds, maxOutputBytes } = op.args
			const started = Date.now()
			// `exec 2>&1` makes stderr share stdout's pipe, so the output is in the order the command wrote it.
			const r = await run('/bin/sh', ['-c', `exec 2>&1\n${command}`], { cwd: cfg.home, env: execEnv, timeoutMs: timeoutSeconds * 1000, reap: true })
			const durationMs = Date.now() - started
			const bytes = Buffer.from(redact(r.stdout + r.stderr, cfg.secrets))
			const capped = bytes.length > maxOutputBytes
			const output = (capped ? bytes.subarray(-maxOutputBytes) : bytes).toString('utf8').replace(/^\uFFFD+/, '')
			const took = `${(durationMs / 1000).toFixed(1)} s`
			const ended = r.timedOut
				? `Timed out after ${timeoutSeconds} s and was killed with its process group`
				: r.code === null
					? `Was killed by ${r.signal} after ${took}`
					: `Exited with ${r.code} in ${took}`
			const data = {
				command: redact(command, cfg.secrets),
				exitCode: r.code,
				signal: r.signal ?? null,
				timedOut: r.timedOut,
				durationMs,
				output,
				truncated: capped || r.droppedBytes > 0,
				outputBytes: r.outputBytes,
			}
			const ok = r.code === 0 && !r.timedOut
			return { result: done(op.id, ok ? 'succeeded' : 'failed', `${ended}${data.truncated ? '; the output was cut to its last part' : ''}.`, data) }
		},

		async set_slot_limit(op) {
			const { maxConcurrent } = op.args
			let r
			try {
				r = await manager('PUT', '/config', { maxConcurrent })
			} catch (e) {
				return fail(op, `The manager did not answer PUT /config: ${e.cause?.code ?? e.message}`)
			}
			if ([404, 405, 501].includes(r.status)) return fail(op, 'The manager has no PUT /config yet; deploy the sandbox-manager version that adds it.')
			if (r.status !== 200) return fail(op, `PUT /config answered ${r.status}: ${redact(r.text, cfg.secrets).slice(0, 500)}`)
			let h
			try {
				h = await manager('GET', '/health')
			} catch (e) {
				return fail(op, `The manager accepted the limit but /health did not answer: ${e.cause?.code ?? e.message}`, { config: r.json })
			}
			const now = h.json?.maxConcurrent
			if (now !== maxConcurrent) return fail(op, `The manager accepted maxConcurrent ${maxConcurrent} but /health reports ${now}.`, { config: r.json })
			const source = r.json?.source ? ` (${r.json.source})` : ''
			return { result: done(op.id, 'succeeded', `The manager now runs at most ${maxConcurrent} sessions at once${source}; ${h.json.running ?? '?'} running.`, { config: r.json, health: { maxConcurrent: now, running: h.json.running, free: h.json.free } }) }
		},
	}

	return {
		// Runs one validated op. Never throws: failures are results.
		async run(op) {
			if (busy) return fail(op, 'Another operation is running on this host.')
			busy = true
			try {
				if (op.deadlineMs && op.deadlineMs > 1e12 && Date.now() > op.deadlineMs) return fail(op, 'The operation reached its deadline before it started; nothing ran.')
				return await handlers[op.name](op)
			} catch (e) {
				return fail(op, `${op.name} failed: ${redact(e.message, cfg.secrets)}`)
			} finally {
				busy = false
			}
		},

		// Finishes a deploy or rollback the state file says was in progress when the daemon stopped.
		// Returns the result to report for it, or null when there is none.
		async recover() {
			const d = state.deploy
			if (!d) return null
			if (d.pid !== process.pid && d.bootId === bootId() && pidAlive(d.pid)) {
				log(`state file: ${d.kind} ${d.opId} is still running in process ${d.pid}; leaving it`)
				return null
			}
			busy = true
			try {
				log(`state file: ${d.kind} ${d.opId} of ${short(d.target)} was ${d.status} when hostopsd stopped; checking the manager`)
				const why = `hostopsd restarted during the ${d.kind} of ${short(d.target)} (from ${short(d.previous)}).`
				const at = async (sha) => (await head().catch(() => null)) === sha && (await waitHealthy(sha)).ok
				if (d.status === 'rolling_back') {
					if (await at(d.previous)) return finish('rolled_back', `${why} ${d.error ?? ''} The rollback to ${short(d.previous)} had finished and it is healthy.`)
					return await revertTo(d.opId, d, `${why} ${d.error ?? ''}`.trim())
				}
				if (await at(d.target)) {
					recordDeploy(d.kind, d.opId, d.previous, d.target)
					return finish('succeeded', `${why} It had finished: the manager is healthy at ${short(d.target)}.`)
				}
				if (d.kind === 'rollback') return finish('failed', `${why} The manager is not healthy at ${short(d.target)}; nothing more was tried.`)
				if (await at(d.previous)) return finish('rolled_back', `${why} The checkout and the manager are still at ${short(d.previous)}, which is healthy.`)
				d.status = 'rolling_back'
				d.error = 'The manager was not healthy at it afterwards.'
				await save()
				return await revertTo(d.opId, d, `${why} ${d.error}`)
			} catch (e) {
				return finish('failed', `hostopsd restarted during the ${d.kind} of ${short(d.target)} and could not recover: ${e.message}`)
			} finally {
				busy = false
			}

			async function finish(st, summary) {
				state.deploy = null
				await save()
				return { result: done(d.opId, st, summary, { previous: d.previous, target: d.target }), restartSelf: await ownCodeChanged() }
			}
		},

		head,
		redact: (s) => redact(s, cfg.secrets),
	}
}
