// The daemon's state file, /var/lib/hostopsd/state.json: the deploy in progress (which is also the
// deploy lock), the commits deployed so far, and results not yet accepted by Pim. Every change is
// written to a temporary file, flushed and renamed over the old one, so a crash leaves either the
// old or the new state.
import { promises as fs } from 'node:fs'
import path from 'node:path'

const EMPTY = { deploy: null, deploys: [], pendingResults: [] }
const MAX_DEPLOYS = 50

export async function loadState(file) {
	let text
	try {
		text = await fs.readFile(file, 'utf8')
	} catch (e) {
		if (e.code === 'ENOENT') return structuredClone(EMPTY)
		throw e
	}
	const s = JSON.parse(text)
	return {
		deploy: s.deploy ?? null,
		deploys: Array.isArray(s.deploys) ? s.deploys : [],
		pendingResults: Array.isArray(s.pendingResults) ? s.pendingResults : [],
	}
}

export async function saveState(file, state) {
	state.deploys = state.deploys.slice(-MAX_DEPLOYS)
	const dir = path.dirname(file)
	await fs.mkdir(dir, { recursive: true, mode: 0o750 })
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
	const fh = await fs.open(tmp, 'w', 0o600)
	try {
		await fh.writeFile(`${JSON.stringify(state, null, '\t')}\n`)
		await fh.sync()
	} finally {
		await fh.close()
	}
	await fs.rename(tmp, file)
	const dh = await fs.open(dir, 'r')
	try {
		await dh.sync()
	} finally {
		await dh.close()
	}
}

export function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return e.code === 'EPERM'
	}
}
