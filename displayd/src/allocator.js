// The lease allocator: one display per thread, from queued to gone. It holds the lease table and
// decides; the runner starts and kills the processes, the store keeps the table across restarts,
// and the memory guard says whether another display fits. All of them are passed in, and every
// change to the table runs one at a time, so the HTTP handlers and the periodic tick() never
// interleave.
//
// States: queued (waiting for a slot or memory) -> starting (processes spawned, not yet healthy)
// -> active (touched recently) <-> idle (not touched for idleAfterMs) -> reaping -> gone. A gone
// lease is dropped from the table, except two that the thread has not been told about yet: a
// queued lease that waited longer than queueTimeoutMs becomes 'timeout', and a display taken for
// a queued thread becomes 'gone' with reason 'preempted'. Either is replaced by a fresh queued
// lease on the thread's next acquire (a timeout is reported by one acquire first).
//
// Queue: queued leases are served oldest first; with several spaces queued they take turns, one
// lease per space per round. When the queue is not empty and no display can be started, the
// longest-idle display that has been idle for more than minIdleMs is reaped for it. A display
// whose person has taken over ('user' control) is never taken and is not idle.
import { randomBytes } from 'node:crypto'
import { memoryGuard } from './memory.js'

export const STATES = ['queued', 'starting', 'active', 'idle', 'reaping', 'gone']
const MIN = 60_000

export const DEFAULTS = {
	maxDisplays: 6,
	displayBase: 100, // the display number of slot 0; slots count up from it
	vncBasePort: 5910, // loopback VNC port of slot 0
	cdpBasePort: 9320, // the Chrome DevTools port reserved for slot 0
	driverBasePort: 3220, // loopback port of slot 0's Cua Driver
	geometry: '1280x800',
	idleAfterMs: MIN, // without a touch for this long an active display is idle
	ttlMs: 10 * MIN, // without a touch for this long a display is reaped
	browserTtlMs: 20 * MIN, // the same, once markBrowser has been called
	startTimeoutMs: 30_000, // a display still starting after this is killed and started again
	maxStartAttempts: 2, // the first start and one retry
	queueTimeoutMs: 5 * MIN, // a lease queued for this long is dropped and its acquire says 'timeout'
	minIdleMs: 2 * MIN, // a display is only preempted once idle for longer than this
	preemptCooldownMs: 15_000, // after a preemption, memory-driven ones wait this long for memory to be freed
	controlRevertMs: 30 * MIN, // user control returns to the agent after this long without a viewer touch
	tombstoneMs: 10 * MIN, // how long a timeout or preempted lease is remembered for its thread
}

export class DisplayAllocator {
	#leases = []
	#claims = [] // {threadId, site}: which threads hold a slot of a limited site
	#lock = Promise.resolve()
	#lastPreempt = -Infinity

	constructor({ runner, store, readMemory, now = Date.now, log = () => {}, config = {}, sites = {} }) {
		this.siteLimits = sites
		this.runner = runner
		this.store = store
		this.readMemory = readMemory
		this.now = now
		this.log = log
		this.config = { ...DEFAULTS, ...config }
	}

	#serial(fn) {
		const p = this.#lock.then(fn)
		this.#lock = p.catch(() => {})
		return p
	}

	// The lease for a thread that has one in use, whatever its state but reaping, gone and timeout.
	#current(threadId) {
		return this.#leases.find((l) => l.threadId === threadId && !['reaping', 'gone', 'timeout'].includes(l.state))
	}

	// The same, or the timeout / preempted lease that has not been replaced yet.
	#latest(threadId) {
		return this.#leases.find((l) => l.threadId === threadId && l.state !== 'reaping')
	}

	// The queued leases in the order they are served: oldest first, spaces taking turns.
	#queue() {
		const bySpace = new Map()
		for (const l of this.#leases.filter((x) => x.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)) {
			if (!bySpace.has(l.spaceId)) bySpace.set(l.spaceId, [])
			bySpace.get(l.spaceId).push(l)
		}
		const out = []
		for (let round = 0; out.length < this.#leases.length; round++) {
			const turn = [...bySpace.values()].map((q) => q[round]).filter(Boolean)
			if (!turn.length) break
			out.push(...turn)
		}
		return out
	}

	// How long a display has been idle: zero while its person has it.
	#idleMs(l) {
		return l.control === 'user' ? 0 : Math.max(0, this.now() - l.lastTouch)
	}

	#holders() {
		return this.#leases.filter((l) => l.slot !== null && ['starting', 'active', 'idle'].includes(l.state))
	}

	// What a queued lease can expect: its place, when a display is likely to free up for it (a
	// holder is preemptable once idle past minIdleMs and reaped at ttl at the latest; a person's
	// take-over first has to end), and who holds the displays.
	#queueStatus(l) {
		const position = this.#queue().indexOf(l) + 1
		const holders = this.#holders()
		const t = this.now()
		const freeIn = holders
			.map((h) => {
				const ttl = h.browser ? this.config.browserTtlMs : this.config.ttlMs
				const idle = this.#idleMs(h)
				const revert = h.control === 'user' ? Math.max(0, this.config.controlRevertMs - (t - (h.viewerTouch ?? t))) : 0
				return Math.min(revert + Math.max(0, this.config.minIdleMs - idle), Math.max(0, ttl - idle) + revert)
			})
			.sort((a, b) => a - b)
		const ttl = this.config.ttlMs
		const wait = freeIn.length ? freeIn[(position - 1) % freeIn.length] + Math.floor((position - 1) / freeIn.length) * ttl : 0
		return { position, estimatedWaitSec: Math.ceil(wait / 1000), holders: holders.map((h) => ({ threadId: h.threadId, idleSec: Math.floor(this.#idleMs(h) / 1000), state: h.state })) }
	}

	// Every change to the table ends here. A claim lives only as long as its thread's lease, so
	// whatever way a lease ended (released, reaped, preempted, timed out), its claims go too.
	#persist() {
		this.#claims = this.#claims.filter((c) => this.#current(c.threadId))
		this.store.save(this.#leases, this.#claims)
	}

	// The limited sites with their limit, domains and the threads that hold a slot.
	claims() {
		return Object.fromEntries(Object.entries(this.siteLimits).map(([site, { max }]) => [site, { max, holders: this.#claims.filter((c) => c.site === site).map((c) => c.threadId) }]))
	}

	// Takes a slot of a limited site for a thread that has a lease; asking again is a grant. Returns
	// null when the thread has no lease, else {granted} with the holders when it is not.
	claim(threadId, site) {
		return this.#serial(async () => {
			if (!this.#current(threadId)) return null
			this.#persist() // forget the claims of leases that ended since
			if (this.#claims.some((c) => c.threadId === threadId && c.site === site)) return { granted: true }
			const holders = this.#claims.filter((c) => c.site === site).map((c) => c.threadId)
			if (holders.length >= this.siteLimits[site].max) return { granted: false, holders }
			this.#claims.push({ threadId, site })
			this.log(`thread ${threadId} holds a slot of ${site}`)
			this.#persist()
			return { granted: true }
		})
	}

	releaseSite(threadId, site) {
		return this.#serial(async () => {
			const before = this.#claims.length
			this.#claims = this.#claims.filter((c) => !(c.threadId === threadId && c.site === site))
			this.#persist()
			return this.#claims.length < before
		})
	}

	#view(l) {
		const { id, threadId, spaceId, state, display, vncPort, cdpPort, env, browser, createdAt, lastTouch, attempts, lastError } = l
		const driver = l.slot === null ? null : { base: `http://127.0.0.1:${this.config.driverBasePort + l.slot}`, tokenFile: `${this.runner.contextDir(l.id)}/driver-token` }
		return { id, threadId, spaceId, state, display, vncPort, cdpPort, driver, env, browser, createdAt, lastTouch, attempts, lastError, control: l.control ?? 'agent', ...(l.reason ? { reason: l.reason } : {}), ...(state === 'queued' ? this.#queueStatus(l) : {}) }
	}

	list() {
		return this.#leases.map((l) => this.#view(l))
	}

	get(threadId) {
		const l = this.#latest(threadId)
		return l ? this.#view(l) : null
	}

	// Marks a timeout as reported to its thread, so the next acquire queues afresh.
	ack(threadId) {
		return this.#serial(async () => {
			const l = this.#latest(threadId)
			if (l?.state === 'timeout') l.reported = true
			this.#persist()
		})
	}

	// Returns the thread's lease, making one when it has none. Asking again returns the same lease
	// and counts as a touch. A lease that is queued has no display yet; ask again, or watch
	// list(), until it is active.
	acquire(threadId, spaceId) {
		return this.#serial(async () => {
			this.#expire()
			let l = this.#latest(threadId)
			if (l?.state === 'timeout' && !l.reported) {
				l.reported = true
				this.#persist()
				return this.#view(l)
			}
			if (l && ['gone', 'timeout'].includes(l.state)) {
				this.#leases = this.#leases.filter((x) => x !== l)
				l = undefined
			}
			if (l) {
				l.lastTouch = this.now()
			} else {
				const t = this.now()
				l = { id: randomBytes(6).toString('hex'), threadId, spaceId, state: 'queued', slot: null, display: null, vncPort: null, cdpPort: null, env: null, pgid: null, browser: false, control: 'agent', viewerTouch: null, createdAt: t, startedAt: null, lastTouch: t, attempts: 0, lastError: null }
				this.#leases.push(l)
				this.log(`lease ${l.id} for thread ${threadId}: queued`)
				await this.#admit()
			}
			this.#persist()
			return this.#view(l)
		})
	}

	// A heartbeat. Returns the lease, or null when the thread has none. A touch from the viewer
	// (the person watching the display) also keeps a take-over going.
	touch(threadId, { viewer = false } = {}) {
		return this.#serial(async () => {
			const l = this.#current(threadId)
			if (!l) return null
			l.lastTouch = this.now()
			if (viewer) l.viewerTouch = l.lastTouch
			if (l.state === 'idle') l.state = 'active'
			this.#persist()
			return this.#view(l)
		})
	}

	// A person takes the display over ('user') or hands it back ('agent'). While 'user' the display
	// is not idle and the agent's tools are paused; it reverts by itself after controlRevertMs
	// without a viewer touch. Returns the lease, or null when the thread has none.
	setControl(threadId, mode) {
		return this.#serial(async () => {
			const l = this.#current(threadId)
			if (!l) return null
			l.control = mode
			l.lastTouch = l.viewerTouch = this.now()
			if (l.state === 'idle') l.state = 'active'
			this.log(`lease ${l.id}: ${mode} has control`)
			this.#persist()
			return this.#view(l)
		})
	}

	// The thread uses a browser on its display, which is slow to set up again, so it keeps the
	// display for the longer TTL. Counts as a touch.
	markBrowser(threadId) {
		return this.#serial(async () => {
			const l = this.#current(threadId)
			if (!l) return null
			l.browser = true
			l.lastTouch = this.now()
			if (l.state === 'idle') l.state = 'active'
			this.#persist()
			return this.#view(l)
		})
	}

	// Kills the thread's display and waits until it is gone. Returns whether there was one.
	release(threadId) {
		return this.#serial(async () => {
			const l = this.#current(threadId)
			if (!l) {
				this.#leases = this.#leases.filter((x) => !(x.threadId === threadId && ['gone', 'timeout'].includes(x.state)))
				this.#persist()
				return false
			}
			l.state = 'reaping'
			await this.#reap(l)
			await this.#admit()
			this.#persist()
			return true
		})
	}

	// One round of housekeeping, run every few seconds: starting displays become active or are
	// retried, idle ones are reaped, dead ones are dropped, and queued leases get a slot when
	// memory allows.
	tick() {
		return this.#serial(async () => {
			const t = this.now()
			this.#expire()
			this.#leases = this.#leases.filter((l) => !(['gone', 'timeout'].includes(l.state) && t - (l.goneAt ?? t) >= this.config.tombstoneMs))
			for (const l of [...this.#leases]) {
				if (l.control === 'user' && t - (l.viewerTouch ?? l.lastTouch) >= this.config.controlRevertMs) {
					this.log(`lease ${l.id}: no viewer activity; control back to the agent`)
					l.control = 'agent'
					l.lastTouch = t
				}
				if (l.state === 'starting') {
					if (l.pgid && (await this.runner.probe(this.#spec(l), l.pgid))) {
						l.state = 'active'
						l.lastTouch = Math.max(l.lastTouch, t)
						this.log(`lease ${l.id}: active on :${l.display}`)
					} else if (!l.pgid || t - l.startedAt > this.config.startTimeoutMs) {
						await this.#startFailed(l, 'did not become healthy in time')
					}
				} else if (l.state === 'active' || l.state === 'idle') {
					const ttl = l.browser ? this.config.browserTtlMs : this.config.ttlMs
					if (!(await this.runner.probe(this.#spec(l), l.pgid))) {
						this.log(`lease ${l.id}: display :${l.display} died; reaping`)
						l.lastError = 'display died'
						l.state = 'reaping'
					} else if (l.control === 'user') {
						l.state = 'active'
					} else if (t - l.lastTouch >= ttl) {
						this.log(`lease ${l.id}: idle for ${Math.round((t - l.lastTouch) / 1000)} s; reaping`)
						l.state = 'reaping'
					} else {
						l.state = t - l.lastTouch >= this.config.idleAfterMs ? 'idle' : 'active'
					}
				}
				if (l.state === 'reaping') await this.#reap(l)
			}
			await this.#admit()
			this.#persist()
		})
	}

	// After a restart of displayd: takes over the displays whose processes are still healthy,
	// kills and forgets the rest, and reaps context directories nobody owns.
	recover() {
		return this.#serial(async () => {
			const t = this.now()
			const kept = []
			for (const l of this.store.load()) {
				if (['queued', 'gone', 'timeout'].includes(l.state)) {
					kept.push(l)
					continue
				}
				const spec = l.slot === null ? null : this.#spec(l)
				if (spec && l.pgid && ['starting', 'active', 'idle'].includes(l.state) && this.runner.isAlive(l.pgid, spec) && (await this.runner.probe(spec, l.pgid))) {
					// Time spent down is not the thread's idleness.
					l.lastTouch = t
					if (l.viewerTouch) l.viewerTouch = t
					if (l.state === 'starting') l.state = 'active'
					kept.push(l)
					this.log(`re-adopted display :${l.display} of thread ${l.threadId}`)
				} else {
					this.log(`dropping display of thread ${l.threadId}: not running`)
					if (spec) await this.#kill(l, spec)
				}
			}
			this.#leases = kept
			this.#claims = (this.store.loadClaims?.() ?? []).filter((c) => this.siteLimits[c.site])
			const owned = new Set(kept.filter((l) => l.pgid).map((l) => l.id))
			for (const { id, pgid } of this.runner.listContexts()) {
				if (owned.has(id)) continue
				this.log(`reaping orphan display context ${id}`)
				if (pgid) await this.runner.kill(pgid, { id })
				this.runner.removeContext(id)
			}
			await this.#admit()
			this.#persist()
		})
	}

	// What /health reports: the slots, the memory, and whether each display's processes are healthy now.
	health() {
		return this.#serial(async () => {
			const mem = await this.#memory()
			const displays = []
			for (const l of this.#leases) {
				const started = l.pgid && l.slot !== null
				displays.push({ id: l.id, threadId: l.threadId, state: l.state, control: l.control ?? 'agent', ...(l.reason ? { reason: l.reason } : {}), ...(l.state === 'queued' ? this.#queueStatus(l) : {}), display: l.display, alive: started ? await this.runner.probe(this.#spec(l), l.pgid) : false, driver: started ? await this.runner.probeDriver(this.#spec(l)) : false })
			}
			const used = this.#leases.filter((l) => l.slot !== null).length
			return { slots: { max: this.config.maxDisplays, used, free: this.config.maxDisplays - used }, memAvailableBytes: mem?.memAvailableBytes ?? null, memTotalBytes: mem?.memTotalBytes ?? null, queued: this.#leases.filter((l) => l.state === 'queued').length, claims: this.claims(), displays }
		})
	}

	// --- internals, all called inside #serial ---

	async #memory() {
		try {
			return await this.readMemory()
		} catch (e) {
			this.log(`cannot read memory: ${e.message}`)
			return null
		}
	}

	#spec(l) {
		const dir = this.runner.contextDir(l.id)
		return { id: l.id, display: l.display, vncPort: l.vncPort, cdpPort: l.cdpPort, driverPort: this.config.driverBasePort + l.slot, dir, geometry: this.config.geometry, env: this.#env(l, dir) }
	}

	#env(l, dir) {
		return {
			DISPLAY: `:${l.display}`,
			XAUTHORITY: `${dir}/Xauthority`,
			DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/bus`,
			XDG_RUNTIME_DIR: `${dir}/run`,
			GTK_MODULES: 'gail:atk-bridge',
			QT_ACCESSIBILITY: '1',
		}
	}

	// Queued leases that have waited too long are dropped, leaving a 'timeout' for their thread.
	#expire() {
		const t = this.now()
		for (const l of this.#leases) {
			if (l.state === 'queued' && t - l.createdAt >= this.config.queueTimeoutMs) {
				this.log(`lease ${l.id}: queued for ${Math.round((t - l.createdAt) / 1000)} s; timed out`)
				l.state = 'timeout'
				l.goneAt = t
				l.reported = false
			}
		}
	}

	// Reaps the longest-idle display that has been idle for more than minIdleMs, for a queued
	// thread. A display with a person in control, or touched within minIdleMs by a tool call or the
	// viewer, is never taken. Its lease stays as 'gone' (preempted) until its thread asks again.
	async #preempt() {
		const victim = this.#leases
			.filter((l) => ['active', 'idle'].includes(l.state) && l.control !== 'user' && this.#idleMs(l) > this.config.minIdleMs)
			.sort((a, b) => this.#idleMs(b) - this.#idleMs(a))[0]
		if (!victim) return false
		this.log(`lease ${victim.id}: idle for ${Math.round(this.#idleMs(victim) / 1000)} s; preempted for a queued thread`)
		await this.#kill(victim, this.#spec(victim))
		Object.assign(victim, { state: 'gone', reason: 'preempted', goneAt: this.now(), slot: null, display: null, vncPort: null, cdpPort: null, env: null })
		this.#lastPreempt = this.now()
		return true
	}

	// Gives queued leases a slot, in queue order, while memory allows. One display starts at a time
	// so the memory the next reading sees includes the one just started; the first in the queue
	// is never passed over. When it cannot start, one idle display may be preempted for it.
	async #admit() {
		this.#expire()
		let preempted = false
		for (;;) {
			if (this.#leases.some((l) => l.state === 'starting')) return
			const next = this.#queue()[0]
			if (!next) return
			const slot = [...Array(this.config.maxDisplays).keys()].find((s) => !this.#leases.some((l) => l.slot === s))
			if (slot === undefined) {
				if (preempted || !(await this.#preempt())) return
				preempted = true
				continue
			}
			const mem = await this.#memory()
			const guard = memoryGuard({ ...(mem ?? { memAvailableBytes: NaN, memTotalBytes: NaN }), activeDisplays: this.#leases.filter((l) => l.slot !== null).length, maxDisplays: this.config.maxDisplays })
			if (!guard.allow) {
				if (next.lastError !== guard.reason) this.log(`lease ${next.id} stays queued: ${guard.reason}`)
				next.lastError = guard.reason
				// Memory takes a moment to come back after a kill, so do not preempt again right away.
				if (!preempted && this.now() - this.#lastPreempt >= this.config.preemptCooldownMs && (await this.#preempt())) {
					preempted = true
					continue
				}
				return
			}
			next.lastError = null
			next.slot = slot
			next.display = this.config.displayBase + slot
			next.vncPort = this.config.vncBasePort + slot
			next.cdpPort = this.config.cdpBasePort + slot
			next.env = this.#env(next, this.runner.contextDir(next.id))
			await this.#launch(next)
			return
		}
	}

	async #launch(l) {
		l.state = 'starting'
		l.attempts += 1
		l.startedAt = this.now()
		l.pgid = null
		try {
			l.pgid = (await this.runner.start(this.#spec(l))).pgid
			this.log(`lease ${l.id}: starting :${l.display} (attempt ${l.attempts}, pgid ${l.pgid})`)
		} catch (e) {
			await this.#startFailed(l, `start failed: ${e.message}`)
		}
	}

	async #startFailed(l, why) {
		await this.#kill(l, this.#spec(l))
		l.lastError = why
		if (l.attempts < this.config.maxStartAttempts) {
			this.log(`lease ${l.id}: ${why}; trying again`)
			await this.#launch(l)
		} else {
			this.log(`lease ${l.id}: ${why}; giving up`)
			l.state = 'reaping'
			await this.#reap(l)
		}
	}

	async #kill(l, spec) {
		if (l.pgid) await this.runner.kill(l.pgid, spec)
		l.pgid = null
		this.runner.removeContext(l.id)
	}

	async #reap(l) {
		l.state = 'reaping'
		await this.#kill(l, this.#spec(l))
		l.state = 'gone'
		this.#leases = this.#leases.filter((x) => x !== l)
		this.log(`lease ${l.id}: gone`)
	}
}
