import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The lease table in one JSON file in the state dir, written whole through a rename so a crash
// never leaves half a file.
export class FileStore {
	constructor(stateDir) {
		this.file = path.join(stateDir, 'state.json')
		mkdirSync(stateDir, { recursive: true, mode: 0o700 })
	}
	load() {
		try {
			const data = JSON.parse(readFileSync(this.file, 'utf8'))
			return Array.isArray(data.leases) ? data.leases : []
		} catch (e) {
			if (e.code === 'ENOENT') return []
			throw e
		}
	}
	save(leases) {
		const tmp = `${this.file}.tmp`
		writeFileSync(tmp, JSON.stringify({ version: 1, leases }), { mode: 0o600 })
		renameSync(tmp, this.file)
	}
}

export class MemoryStore {
	leases = []
	load() {
		return structuredClone(this.leases)
	}
	save(leases) {
		this.leases = structuredClone(leases)
	}
}
