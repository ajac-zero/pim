// The lease allocator: one display per thread, from queued to gone. It holds the lease table and
// decides; the runner starts and kills the processes, the store keeps the table across restarts,
// and the memory guard says whether another display fits. All of them are passed in, and every
// change to the table runs one at a time, so the HTTP handlers and the periodic tick() never
// interleave.
//
// States: queued (waiting for a slot or memory) -> starting (processes spawned, not yet healthy)
// -> active (touched recently) <-> idle (not touched for idleAfterMs) -> reaping -> gone. A gone
// lease is dropped from the table.
import { randomBytes } from 'node:crypto'
import { memoryGuard } from './memory.js'

export const STATES = ['queued', 'starting', 'active', 'idle', 'reaping', 'gone']
const MIN = 60_000

export const DEFAULTS = {
	maxDisplays: 6,
	displayBase: 100, // the display number of slot 0; slots count up from it
	vncBasePort: 5910, // loopback VNC port of slot 0
	cdpBasePort: 9320, // the Chrome DevTools port reserved for slot 0
	geometry: '1280x800',
	idleAfterMs: MIN, // without a touch for this long an active display is idle
	ttlMs: 10 * MIN, // without a touch for this long a display is reaped
	browserTtlMs: 20 * MIN, // the same, once markBrowser has been called
	startTimeoutMs: 30_000, // a display still starting after this is killed and started again
	maxStartAttempts: 2, // the first start and one retry
}

export class DisplayAllocator {
	#leases = []
	#lock = Promise.resolve()

	constructor({ runner, store, readMemory, now = Date.now, log = () => {}, config = {} }) {
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

	// The lease for a thread that has one in use, whatever its state but reaping and gone.
	#current(threadId) {
		return this.#leases.find((l) => l.threadId === threadId && l.state !== 'reaping')
	}

	#persist() {
		this.store.save(this.#leases)
	}

	#view(l) {
		const { id, threadId, spaceId, state, display, vncPort, cdpPort, env, browser, createdAt, lastTouch, attempts, lastError } = l
		return { id, threadId, spaceId, state, display, vncPort, cdpPort, env, browser, createdAt, lastTouch, attempts, lastError }
	}

	list() {
		return this.#leases.map((l) => this.#view(l))
	}

	get(threadId) {
		const l = this.#current(threadId)
		return l ? this.#view(l) : null
	}

	// Returns the thread's lease, making one when it has none. Asking again returns the same lease
	// and counts as a touch. A lease that is queued has no display yet; ask again, or watch
	// list(), until it is active.
	acquire(threadId, spaceId) {
		return this.#serial(async () => {
			let l = this.#current(threadId)
			if (l) {
				l.lastTouch = this.now()
			} else {
				const t = this.now()
				l = { id: randomBytes(6).toString('hex'), threadId, spaceId, state: 'queued', slot: null, display: null, vncPort: null, cdpPort: null, env: null, pgid: null, browser: false, createdAt: t, startedAt: null, lastTouch: t, attempts: 0, lastError: null }
				this.#leases.push(l)
				this.log(`lease ${l.id} for thread ${threadId}: queued`)
				await this.#admit()
			}
			this.#persist()
			return this.#view(l)
		})
	}

	// A heartbeat. Returns the lease, or null when the thread has none.
	touch(threadId) {
		return this.#serial(async () => {
			const l = this.#current(threadId)
			if (!l) return null
			l.lastTouch = this.now()
			if (l.state === 'idle') l.state = 'active'
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
			if (!l) return false
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
			for (const l of [...this.#leases]) {
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
				if (l.state === 'queued') {
					kept.push(l)
					continue
				}
				const spec = l.slot === null ? null : this.#spec(l)
				if (spec && l.pgid && ['starting', 'active', 'idle'].includes(l.state) && this.runner.isAlive(l.pgid, spec) && (await this.runner.probe(spec, l.pgid))) {
					// Time spent down is not the thread's idleness.
					l.lastTouch = t
					if (l.state === 'starting') l.state = 'active'
					kept.push(l)
					this.log(`re-adopted display :${l.display} of thread ${l.threadId}`)
				} else {
					this.log(`dropping display of thread ${l.threadId}: not running`)
					if (spec) await this.#kill(l, spec)
				}
			}
			this.#leases = kept
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
				displays.push({ id: l.id, threadId: l.threadId, state: l.state, display: l.display, alive: started ? await this.runner.probe(this.#spec(l), l.pgid) : false })
			}
			const used = this.#leases.filter((l) => l.slot !== null).length
			return { slots: { max: this.config.maxDisplays, used, free: this.config.maxDisplays - used }, memAvailableBytes: mem?.memAvailableBytes ?? null, memTotalBytes: mem?.memTotalBytes ?? null, queued: this.#leases.filter((l) => l.state === 'queued').length, displays }
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
		return { id: l.id, display: l.display, vncPort: l.vncPort, cdpPort: l.cdpPort, dir, geometry: this.config.geometry, env: this.#env(l, dir) }
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

	// Gives queued leases a slot, oldest first, while memory allows. One display starts at a time
	// so the memory the next reading sees includes the one just started; the oldest waiting lease
	// is never passed over for a younger one.
	async #admit() {
		for (;;) {
			if (this.#leases.some((l) => l.state === 'starting')) return
			const next = this.#leases.filter((l) => l.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0]
			if (!next) return
			const slot = [...Array(this.config.maxDisplays).keys()].find((s) => !this.#leases.some((l) => l.slot === s))
			if (slot === undefined) return
			const mem = await this.#memory()
			const guard = memoryGuard({ ...(mem ?? { memAvailableBytes: NaN, memTotalBytes: NaN }), activeDisplays: this.#leases.filter((l) => l.slot !== null).length, maxDisplays: this.config.maxDisplays })
			if (!guard.allow) {
				if (next.lastError !== guard.reason) this.log(`lease ${next.id} stays queued: ${guard.reason}`)
				next.lastError = guard.reason
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
