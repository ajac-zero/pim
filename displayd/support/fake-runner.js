// A runner with no processes. A display is a record in `procs`; tests make it healthy, hang or
// die, and read what the allocator did in `calls`. One instance shared by two allocators stands
// for processes that outlive a restart of displayd.
export class FakeRunner {
	procs = new Map() // pgid -> {id, healthy, spec}
	contexts = new Set()
	calls = []
	nextPgid = 1000
	autoHealthy = true // a started display is healthy at once; false makes it hang in starting
	failStarts = 0 // the next this-many starts throw

	contextDir(id) {
		return `/fake/displays/${id}`
	}
	async start(spec) {
		this.calls.push(['start', spec.id])
		if (this.failStarts > 0) {
			this.failStarts--
			throw new Error('spawn failed')
		}
		const pgid = this.nextPgid++
		this.procs.set(pgid, { id: spec.id, healthy: this.autoHealthy, spec })
		this.contexts.add(spec.id)
		return { pgid }
	}
	isAlive(pgid, spec) {
		return this.procs.get(pgid)?.id === spec.id
	}
	async probe(spec, pgid) {
		return this.isAlive(pgid, spec) && this.procs.get(pgid).healthy
	}
	async kill(pgid, spec) {
		this.calls.push(['kill', spec.id])
		this.procs.delete(pgid)
	}
	removeContext(id) {
		this.calls.push(['removeContext', id])
		this.contexts.delete(id)
	}
	listContexts() {
		return [...this.contexts].map((id) => ({ id, pgid: [...this.procs].find(([, p]) => p.id === id)?.[0] ?? null }))
	}
	// test controls
	pgidOf(id) {
		return [...this.procs].find(([, p]) => p.id === id)?.[0]
	}
	setHealthy(id, healthy = true) {
		this.procs.get(this.pgidOf(id)).healthy = healthy
	}
	crash(id) {
		this.procs.delete(this.pgidOf(id))
	}
	started(id) {
		return this.calls.filter(([c, i]) => c === 'start' && i === id).length
	}
}
