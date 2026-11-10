// Test setup: a fake checkout (a real git repository cloned from a local "origin"), wrappers for
// git, docker and journalctl on PATH, a fake manager and a fake Pim.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FAKES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fakes.js')
export const MANAGER_TOKEN = 'mgr-token-0123456789abcdef'
export const HOSTOPS_TOKEN = 'hostops-token-fedcba9876543210'
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)))
const body = async (req) => {
	let s = ''
	for await (const c of req) s += c
	return s ? JSON.parse(s) : null
}

function git(cwd, ...args) {
	return execFileSync(REAL_GIT, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim()
}

// Commits: c1 <- c2 <- c3 (origin/main) <- c4 (origin/selfupdate, changes hostopsd/), and s1
// (origin/side) on c1. The checkout starts detached at c2, which the fake manager runs.
function makeRepo(tmp, fakeDir) {
	const author = path.join(tmp, 'author')
	const origin = path.join(tmp, 'origin.git')
	mkdirSync(author)
	git(tmp, 'init', '--bare', '--quiet', origin)
	git(author, 'init', '--quiet')
	const write = (rel, text, mode) => {
		const p = path.join(author, rel)
		mkdirSync(path.dirname(p), { recursive: true })
		writeFileSync(p, text)
		if (mode) chmodSync(p, mode)
	}
	const commit = (msg) => {
		git(author, 'add', '-A')
		git(author, 'commit', '--quiet', '-m', msg)
		return git(author, 'rev-parse', 'HEAD')
	}
	write('sandbox-manager/up.sh', `#!/bin/sh\nexec "${process.execPath}" "${FAKES}" up "${fakeDir}" "$@"\n`, 0o755)
	write('sandbox-manager/hostopsd/hostopsd.js', '// v1\n')
	write('README.md', 'one\n')
	const c1 = commit('c1')
	write('README.md', 'two\n')
	const c2 = commit('c2')
	write('README.md', 'three\n')
	const c3 = commit('c3')
	write('sandbox-manager/hostopsd/hostopsd.js', '// v2\n')
	const c4 = commit('c4')
	git(author, 'checkout', '--quiet', '-b', 'side', c1)
	write('README.md', 'side\n')
	const s1 = commit('s1')
	git(author, 'push', '--quiet', origin, `${c3}:refs/heads/main`, `${c4}:refs/heads/selfupdate`, 'side:refs/heads/side')
	const checkout = path.join(tmp, 'checkout')
	git(tmp, 'clone', '--quiet', origin, checkout)
	git(checkout, 'checkout', '--quiet', '--detach', c2)
	return { checkout, c1, c2, c3, c4, s1 }
}

export async function setup({ fake = {}, pim = {}, manager = {} } = {}) {
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'hostopsd-'))
	const fakeDir = path.join(tmp, 'fake')
	const bin = path.join(tmp, 'bin')
	mkdirSync(fakeDir)
	mkdirSync(bin)
	for (const tool of ['git', 'docker', 'journalctl']) {
		writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${FAKES}" ${tool} "${fakeDir}" "$@"\n`, { mode: 0o755 })
	}
	const control = { realGit: REAL_GIT, ...fake }
	const setFake = (over) => writeFileSync(path.join(fakeDir, 'fake.json'), JSON.stringify(Object.assign(control, over)))
	setFake({})
	const repo = makeRepo(tmp, fakeDir)
	const short = (sha) => git(repo.checkout, 'rev-parse', '--short', sha)
	writeFileSync(path.join(fakeDir, 'deployed'), short(repo.c2))

	// The fake manager: /health reports the commit up.sh last "started", and not ok for commits in
	// `unhealthy`; PUT /config sets maxConcurrent.
	const mgr = { unhealthy: [], maxConcurrent: 4, noConfig: false, ignoreConfig: false, ...manager }
	const mgrServer = createServer(async (req, res) => {
		const send = (code, b) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(b))
		const deployed = readFileSync(path.join(fakeDir, 'deployed'), 'utf8').trim()
		if (req.method === 'GET' && req.url === '/health') return send(200, { ok: !mgr.unhealthy.some((p) => deployed.startsWith(p) || p.startsWith(deployed)), runsc: true, commit: deployed, maxConcurrent: mgr.maxConcurrent, running: 1, free: mgr.maxConcurrent - 1, sessions: 1 })
		if (req.headers.authorization !== `Bearer ${MANAGER_TOKEN}`) return send(401, { error: 'unauthorized' })
		if (req.method === 'PUT' && req.url === '/config' && !mgr.noConfig) {
			const b = await body(req)
			if (!mgr.ignoreConfig) mgr.maxConcurrent = b.maxConcurrent
			return send(200, { maxConcurrent: b.maxConcurrent, source: 'override' })
		}
		send(404, { error: 'not found' })
	})
	const managerUrl = await listen(mgrServer)

	// The fake Pim: hands out queued ops, records polls and results. `pollStatus` and
	// `resultFailures` make it answer with errors.
	const p = { ops: [], polls: [], results: [], resultAttempts: 0, pollStatus: null, resultFailures: 0, ...pim }
	const pimServer = createServer(async (req, res) => {
		const b = await body(req)
		const authed = req.headers.authorization === `Bearer ${HOSTOPS_TOKEN}`
		if (req.url === '/api/hostops/agent/poll') {
			p.polls.push({ body: b, authed })
			if (p.pollStatus) return res.writeHead(p.pollStatus).end()
			if (!authed) return res.writeHead(401).end()
			const op = p.ops.shift()
			if (!op) return res.writeHead(204).end()
			return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ op }))
		}
		if (req.url === '/api/hostops/agent/result') {
			p.resultAttempts++
			if (p.resultFailures > 0) {
				p.resultFailures--
				return res.writeHead(503).end()
			}
			if (!authed) return res.writeHead(401).end()
			p.results.push(b)
			return res.writeHead(200, { 'content-type': 'application/json' }).end('{"accepted":true}')
		}
		res.writeHead(404).end()
	})
	const pimUrl = await listen(pimServer)

	const env = {
		HOSTOPSD_ENV_FILE: path.join(tmp, 'no-env-file'),
		HOSTOPS_URL: pimUrl,
		HOSTOPS_TOKEN,
		PIM_CHECKOUT: repo.checkout,
		MANAGER_URL: managerUrl,
		MANAGER_ENV_FILE: path.join(tmp, 'manager.env'),
		HOSTOPSD_STATE_FILE: path.join(tmp, 'state', 'state.json'),
		PATH: `${bin}:${process.env.PATH}`,
		HOME: tmp,
		HOSTOPSD_HEALTH_TIMEOUT_MS: '800',
		HOSTOPSD_HEALTH_INTERVAL_MS: '50',
		HOSTOPSD_BACKOFF_MIN_MS: '10',
		HOSTOPSD_BACKOFF_MAX_MS: '40',
		HOSTOPSD_UNAUTHORIZED_RETRY_MS: '60000',
	}
	writeFileSync(env.MANAGER_ENV_FILE, `MANAGER_TOKEN=${MANAGER_TOKEN}\nPROXY_ADMIN_TOKEN="proxy-admin-secret-value"\n# comment\nexport MAX_CONCURRENT=\n`)

	const calls = () => {
		const f = path.join(fakeDir, 'calls.jsonl')
		return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
	}
	return {
		tmp,
		env,
		repo,
		short,
		head: () => git(repo.checkout, 'rev-parse', 'HEAD'),
		deployed: () => readFileSync(path.join(fakeDir, 'deployed'), 'utf8').trim(),
		calls,
		setFake,
		mgr,
		pim: p,
		close: () => {
			mgrServer.close()
			pimServer.close()
			mgrServer.closeAllConnections()
			pimServer.closeAllConnections()
			spawnSync('rm', ['-rf', tmp])
		},
	}
}
