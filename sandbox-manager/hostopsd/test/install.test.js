// Runs up.sh and install.sh from a copy of the checkout's scripts, with fake curl, sudo, systemctl,
// docker and the other system tools first on PATH. Nothing touches the real system.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MANAGER_TOKEN = 'mgr-secret-0123456789abcdef'
const ENROLLED = 'enrolled-token-0123456789abcdef'
const OLD = 'installed-token-fedcba9876543210'
const URL = 'https://pim.test'

const FAKES = {
	// Pim: enroll answers $PIM/enroll_status (default 201 with ENROLLED); poll answers 204 when the
	// bearer is in $PIM/good_tokens, else 401. It also serves the fake Node.js mirror at
	// $FAKE_DIST from $FAKE_DIST_ROOT (see makeMirror). Argv goes to $FAKE_LOG; stdin (the curl
	// config, which holds the bearer) is never logged.
	curl: `#!/usr/bin/env bash
echo "curl $*" >>"$FAKE_LOG"
out=; url=
while [ $# -gt 0 ]; do case "$1" in --output | -o) out=$2; shift 2 ;; --write-out|--max-time|--request|--header|--data|--config|--retry|--connect-timeout) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
bearer=$(sed -n 's/^header = "Authorization: Bearer \\(.*\\)"$/\\1/p')
case "$url" in
$FAKE_DIST/SHASUMS256.txt) cat "$FAKE_DIST_ROOT/SHASUMS256.txt"; exit 0 ;;
$FAKE_DIST/*.tar.gz) cat "$FAKE_DIST_ROOT/node.tar.gz"; exit 0 ;;
*/enroll)
  [ "$bearer" = "${MANAGER_TOKEN}" ] || { echo 401; exit 0; }
  status=$(cat "$PIM/enroll_status" 2>/dev/null || echo 201)
  echo "enroll" >>"$PIM/calls"
  [ "$status" = 201 ] && echo '{"token":"${ENROLLED}"}' >"$out" || echo '{"error":"revoked"}' >"$out"
  printf %s "$status" ;;
*/poll)
  echo "poll" >>"$PIM/calls"
  grep -qxF "$bearer" "$PIM/good_tokens" 2>/dev/null && printf 204 || printf 401 ;;
esac
`,
	systemctl: '#!/bin/sh\necho "systemctl $*" >>"$FAKE_LOG"\n[ "$1" = is-active ] && [ -f "$FAKE_DIR/inactive" ] && exit 3\nexit 0\n',
	journalctl: '#!/bin/sh\necho "hostopsd 1 polling https://pim.test for /x"\n',
	sudo: '#!/bin/sh\necho "sudo $*" >>"$FAKE_LOG"\n[ "$1" = -n ] && shift\nFAKE_UID=0 exec "$@"\n',
	id: '#!/bin/sh\ncase "$1" in -u) echo "${FAKE_UID:-1000}" ;; -un) echo "${FAKE_USER:-owner}" ;; esac\n',
	docker: '#!/bin/sh\necho "docker $*" >>"$FAKE_LOG"\n',
	runuser: '#!/bin/sh\nshift 3\nexec "$@"\n',
	install: '#!/bin/bash\nargs=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done\nexec /usr/bin/install "${args[@]}"\n',
	sleep: '#!/bin/sh\n',
	setfacl: '#!/bin/sh\n',
	useradd: '#!/bin/sh\n',
	usermod: '#!/bin/sh\n',
	getent: '#!/bin/sh\n[ "$1" = passwd ] && [ -n "$FAKE_GETHOME" ] && echo "testuser:x:1000:1000::$FAKE_GETHOME:/bin/sh" && exit 0\nexit 0\n',
	chown: '#!/bin/sh\n',
}

let tmp
let env
const log = () => (existsSync(`${tmp}/log`) ? readFileSync(`${tmp}/log`, 'utf8') : '')
const pimCalls = () => (existsSync(`${tmp}/pim/calls`) ? readFileSync(`${tmp}/pim/calls`, 'utf8').trim().split('\n') : [])
const etcFile = (name) => readFileSync(`${tmp}/etc/${name}`, 'utf8')

beforeEach(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), 'hostopsd-install-'))
	const bin = `${tmp}/bin`
	mkdirSync(bin)
	mkdirSync(`${tmp}/pim`)
	mkdirSync(`${tmp}/etc`)
	for (const [name, body] of Object.entries(FAKES)) {
		writeFileSync(`${bin}/${name}`, body.replaceAll('${MANAGER_TOKEN}', MANAGER_TOKEN).replaceAll('${ENROLLED}', ENROLLED))
		chmodSync(`${bin}/${name}`, 0o755)
	}
	// A checkout holding the scripts under test, a git repository so install.sh can inspect it.
	const checkout = `${tmp}/checkout`
	mkdirSync(`${checkout}/sandbox-manager`, { recursive: true })
	cpSync(`${REAL}/up.sh`, `${checkout}/sandbox-manager/up.sh`)
	cpSync(`${REAL}/hostopsd`, `${checkout}/sandbox-manager/hostopsd`, { recursive: true, filter: (s) => !s.includes('/test') && !s.includes('/support') })
	writeFileSync(`${checkout}/sandbox-manager/.env`, `MANAGER_TOKEN=${MANAGER_TOKEN}\n`)
	spawnSync('git', ['init', '-q'], { cwd: checkout })
	spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: checkout })
	spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c'], { cwd: checkout })
	env = {
		PATH: `${bin}:${process.env.PATH}`,
		HOME: tmp,
		FAKE_LOG: `${tmp}/log`,
		FAKE_DIR: tmp,
		PIM: `${tmp}/pim`,
		HOSTOPSD_ETC: `${tmp}/etc`,
		HOSTOPSD_STATE_DIR: `${tmp}/state`,
		HOSTOPSD_UNIT_DIR: `${tmp}/units`,
		HOSTOPS_URL: URL,
		BUILD_SHA: 'abc1234',
	}
	mkdirSync(`${tmp}/units`)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const up = (over = {}) => spawnSync('bash', [`${tmp}/checkout/sandbox-manager/up.sh`], { env: { ...env, ...over }, encoding: 'utf8', stdin: 'ignore' })
const install = (args = [], over = {}) =>
	spawnSync('bash', [`${tmp}/checkout/sandbox-manager/hostopsd/install.sh`, '--checkout', `${tmp}/checkout`, ...args], { env: { ...env, FAKE_UID: '0', ...over }, encoding: 'utf8', input: '' })
const noToken = (r) => {
	assert.ok(!(r.stdout + r.stderr).includes(ENROLLED), 'credential printed')
	assert.ok(!(r.stdout + r.stderr).includes(MANAGER_TOKEN), 'manager token printed')
	assert.ok(!log().includes(ENROLLED) && !log().includes(MANAGER_TOKEN), 'secret on a command line')
}

// A fake Node.js binary: node_major asks it for its major version with -p.
const fakeNode = (dir, major) => {
	mkdirSync(dir, { recursive: true })
	writeFileSync(`${dir}/node`, `#!/bin/sh\ncase "$1" in\n-p) echo ${major} ;;\n*) echo v${major}.0.0 ;;\nesac\n`)
	chmodSync(`${dir}/node`, 0o755)
	return `${dir}/node`
}

// A fake nodejs.org /dist directory (the mirror curl serves from in the installs below) holding one
// official Node.js 22 tarball. `sha256sum` names its own tarball in SHASUMS256.txt, so a run can
// only unpack it by verifying the checksum.
const makeMirror = () => {
	const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
	const name = `node-v22.9.0-linux-${arch}`
	const root = `${tmp}/dist`
	mkdirSync(`${root}/${name}/bin`, { recursive: true })
	writeFileSync(`${root}/${name}/bin/node`, `#!/bin/sh\ncase "$1" in\n-p) echo 22 ;;\n*) echo v22.9.0 ;;\nesac\n`)
	chmodSync(`${root}/${name}/bin/node`, 0o755)
	spawnSync('tar', ['czf', `${root}/node.tar.gz`, '-C', root, name])
	const sha = spawnSync('sha256sum', [`${root}/node.tar.gz`], { encoding: 'utf8' }).stdout.split(' ')[0]
	writeFileSync(`${root}/SHASUMS256.txt`, `${sha}  ${name}.tar.gz\n`)
	return { root, url: 'http://dist.test' }
}

// The fake tools plus the real ones install.sh and up.sh need, with no node on PATH: the host the
// daemon installs on may not have one at all.
const binWithoutNode = () => {
	const bin = `${tmp}/bin-no-node`
	mkdirSync(bin)
	for (const name of Object.keys(FAKES)) cpSync(`${tmp}/bin/${name}`, `${bin}/${name}`)
	for (const n of ['bash', 'env', 'test', 'sed', 'grep', 'tail', 'cut', 'head', 'tr', 'awk', 'sort', 'ls', 'tar', 'gzip', 'mktemp', 'mv', 'rm', 'chmod', 'date', 'stat', 'uname', 'sha256sum', 'git', 'dirname', 'basename', 'cat']) {
		// `command -v` answers with just the name for shell builtins such as test, so fall back to
		// the usual place.
		const p = execFileSync('sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).trim()
		symlinkSync(p.startsWith('/') ? p : `/usr/bin/${n}`, `${bin}/${n}`)
	}
	return bin
}

// Runs bash against the library under test, node.sh, with the real system tools.
const bash = (script, over = {}) => spawnSync('bash', ['-c', script], { env: { ...process.env, ...over }, encoding: 'utf8' })
const nodeSh = `${REAL}/hostopsd/node.sh`
// The fake mirror of nodejs.org/dist for the node.sh tests, served by the curl fake above.
const DIST = 'http://dist.test'
const mirrorEnv = (mirror) => ({ PATH: `${tmp}/bin:${process.env.PATH}`, FAKE_DIST: mirror.url, FAKE_DIST_ROOT: mirror.root })

describe('up.sh ensures hostopsd', () => {
	test('first install enrolls through sudo and stores the credential only in /etc/hostopsd/env', () => {
		const r = up()
		assert.equal(r.status, 0, r.stderr)
		assert.match(log(), /docker compose up -d --build/)
		assert.match(log(), /sudo -n .*install\.sh --url https:\/\/pim\.test/)
		assert.match(log(), /--node \S+\/node(\s|$)/)
		assert.deepEqual(pimCalls(), ['enroll'])
		assert.match(etcFile('env'), new RegExp(`^HOSTOPS_TOKEN=${ENROLLED}$`, 'm'))
		assert.match(r.stdout, /hostopsd: enrolled with Pim, running and polling https:\/\/pim\.test/)
		noToken(r)
	})

	test('a rerun changes nothing and does not rotate the credential', () => {
		up()
		const before = etcFile('env')
		const calls = log().split('\n').length
		const r = up()
		assert.equal(r.status, 0)
		assert.equal(etcFile('env'), before)
		assert.deepEqual(pimCalls(), ['enroll'])
		assert.ok(!log().split('\n').slice(calls).some((l) => l.startsWith('sudo')), 'sudo ran again')
	})

	test('an installer run again with a good installed credential keeps it', () => {
		writeFileSync(`${tmp}/pim/good_tokens`, `${ENROLLED}\n`)
		install()
		const r = install()
		assert.equal(r.status, 0, r.stderr)
		assert.deepEqual(pimCalls(), ['enroll', 'poll'])
		assert.match(r.stdout, /kept the installed credential/)
	})

	test('a stale installer reinstalls', () => {
		up()
		writeFileSync(`${tmp}/checkout/sandbox-manager/hostopsd/hostopsd.service`, `${readFileSync(`${tmp}/checkout/sandbox-manager/hostopsd/hostopsd.service`, 'utf8')}# new\n`)
		const r = up()
		assert.match(r.stdout, /installing hostopsd/)
		assert.equal(r.status, 0)
	})

	test('as the hostopsd user, or without sudo rights, nothing needing root runs when current', () => {
		up()
		const calls = log().split('\n').length
		const r = up({ FAKE_USER: 'hostopsd' })
		assert.equal(r.status, 0)
		assert.ok(!log().split('\n').slice(calls).some((l) => l.startsWith('sudo')))
	})

	test('a stale install run as hostopsd only prints the command', () => {
		const r = up({ FAKE_USER: 'hostopsd' })
		assert.equal(r.status, 0)
		assert.match(r.stderr, /run 'sudo .*install\.sh --url https:\/\/pim\.test/)
		assert.ok(!log().includes('sudo '))
	})

	test('without sudo it prints the one command to run and exits 0', () => {
		const bin = `${tmp}/nosudo`
		mkdirSync(bin)
		for (const n of ['id', 'docker', 'systemctl']) cpSync(`${tmp}/bin/${n}`, `${bin}/${n}`)
		for (const n of ['bash', 'sed', 'grep', 'tail', 'cut', 'sha256sum', 'git', 'dirname']) symlinkSync(execFileSync('sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).trim(), `${bin}/${n}`)
		const r = up({ PATH: bin })
		assert.equal(r.status, 0, r.stderr)
		assert.match(r.stderr, /sudo is not available; to finish installing hostopsd run: sudo \S*install\.sh --url https:\/\/pim\.test --checkout \S+/)
		assert.deepEqual(pimCalls(), [])
	})

	test("with no node on the invoking user's PATH it still runs the installer, without --node", () => {
		const r = up({ PATH: binWithoutNode() })
		assert.equal(r.status, 0, r.stderr)
		assert.match(log(), /sudo -n .*install\.sh --url https:\/\/pim\.test/)
		assert.ok(!/--node/.test(log()), '--node passed without a node to point at')
		assert.deepEqual(pimCalls(), ['enroll'])
	})

	test('a revoked credential does not fail up.sh, installs the unit and is not retried', () => {
		writeFileSync(`${tmp}/pim/enroll_status`, '403')
		const r = up()
		assert.equal(r.status, 0, r.stderr)
		assert.match(r.stdout, /credential was revoked in Pim's Settings/)
		assert.ok(existsSync(`${tmp}/units/hostopsd.service`))
		assert.ok(!/^HOSTOPS_TOKEN=/m.test(etcFile('env')))
		assert.ok(!log().includes('systemctl restart'))
		up()
		assert.deepEqual(pimCalls(), ['enroll'])
	})

	test('a failing install (wrong manager token) is a warning, not a failure', () => {
		writeFileSync(`${tmp}/checkout/sandbox-manager/.env`, 'MANAGER_TOKEN=some-other-token-123\n')
		const r = up()
		assert.equal(r.status, 0)
		assert.match(r.stderr, /Pim rejected MANAGER_TOKEN \(401\)/)
		assert.match(r.stderr, /hostopsd was not installed/)
	})
})

describe('install.sh', () => {
	test('an installed credential Pim rejects with 401 is replaced by enrolling', () => {
		mkdirSync(`${tmp}/etc`, { recursive: true })
		writeFileSync(`${tmp}/etc/env`, `HOSTOPS_URL=${URL}\nHOSTOPS_TOKEN=${OLD}\n`)
		const r = install(['--url', URL])
		assert.equal(r.status, 0, r.stderr)
		assert.deepEqual(pimCalls(), ['poll', 'enroll'])
		assert.match(etcFile('env'), new RegExp(`^HOSTOPS_TOKEN=${ENROLLED}$`, 'm'))
		assert.ok(!etcFile('env').includes(OLD))
		assert.match(r.stdout, /rejected by Pim \(401\); enrolling again/)
		noToken(r)
	})

	test('a credential from --token-file is used without enrolling', () => {
		const given = 'given-token-0123456789abcdef'
		writeFileSync(`${tmp}/tok`, `${given}\n`)
		const r = install(['--url', URL, '--token-file', `${tmp}/tok`])
		assert.equal(r.status, 0, r.stderr)
		assert.deepEqual(pimCalls(), [])
		assert.match(etcFile('env'), new RegExp(`^HOSTOPS_TOKEN=${given}$`, 'm'))
		assert.ok(!(r.stdout + r.stderr + log()).includes(given))
	})

	test('refuses a credential on the command line', () => {
		const r = install(['--url', URL, '--token', 'x'])
		assert.notEqual(r.status, 0)
		assert.match(r.stderr, /not on the command line/)
	})

	test('the env file is not world readable', () => {
		install(['--url', URL])
		const mode = spawnSync('stat', ['-c', '%a', `${tmp}/etc/env`], { encoding: 'utf8' }).stdout.trim()
		assert.equal(mode, '640')
	})

	test("a node from the invoking user's nvm, invisible to root, is used and copied for hostopsd", () => {
		const home = `${tmp}/invoker-home`
		const nvm = fakeNode(`${home}/.nvm/versions/node/v22.1.0/bin`, 22)
		const over = { PATH: binWithoutNode(), SUDO_USER: 'testuser', FAKE_GETHOME: home, HOSTOPSD_NODE_DIR: `${tmp}/opt` }
		const r = install(['--url', URL], over)
		assert.equal(r.status, 0, r.stderr)
		assert.match(etcFile('env'), new RegExp(`^NODE_BIN=${tmp}/opt/node$`, 'm'))
		assert.ok(!etcFile('env').includes(nvm), 'the unit points at the copy, not at nvm')
		assert.ok(existsSync(`${tmp}/opt/node`))
		assert.equal(spawnSync('stat', ['-c', '%a', `${tmp}/opt/node`], { encoding: 'utf8' }).stdout.trim(), '755')
		assert.equal(spawnSync('stat', ['-c', '%a', `${tmp}/opt`], { encoding: 'utf8' }).stdout.trim(), '755')
		assert.ok(!log().includes('SHASUMS256.txt'), 'downloaded Node.js although nvm had one')
	})

	test("a node too old on the invoking user's PATH is not passed on by up.sh", () => {
		const bin = binWithoutNode()
		const old = fakeNode(`${tmp}/old-bin`, 18)
		symlinkSync(old, `${bin}/node`)
		const r = up({ PATH: bin })
		assert.equal(r.status, 0, r.stderr)
		assert.ok(!/--node/.test(log()), 'up.sh passed a Node.js older than 22')
	})

	test('a --node older than 22 is refused with a clear message', () => {
		const old = fakeNode(`${tmp}/old-bin`, 18)
		const r = install(['--url', URL, '--node', old])
		assert.notEqual(r.status, 0)
		assert.match(r.stderr, new RegExp(`is Node\\.js 18; hostopsd needs 22 or later`))
		assert.deepEqual(pimCalls(), [])
	})

	test('with no node anywhere it installs the official Node.js 22, checksum first', () => {
		const mirror = makeMirror()
		const r = install(
			['--url', URL],
			{
				PATH: binWithoutNode(),
				HOSTOPSD_NODE_FALLBACKS: '/no-such/node',
				HOSTOPSD_NODE_DIR: `${tmp}/opt`,
				HOSTOPSD_NODE_DIST: mirror.url,
				FAKE_DIST: mirror.url,
				FAKE_DIST_ROOT: mirror.root,
			},
		)
		assert.equal(r.status, 0, r.stderr)
		assert.match(r.stdout, /no Node\.js 22 or later on this host; installing the official Node\.js 22/)
		assert.match(log(), /curl .*SHASUMS256\.txt/)
		assert.match(etcFile('env'), new RegExp(`^NODE_BIN=${tmp}/opt/node$`, 'm'))
		assert.ok(existsSync(`${tmp}/opt/node-v22.9.0/bin/node`))
		assert.equal(spawnSync(`${tmp}/opt/node`, ['-p', 'x'], { encoding: 'utf8' }).stdout.trim(), '22')
		noToken(r)
	})

	test('a tarball that does not match SHASUMS256.txt is not unpacked', () => {
		const mirror = makeMirror()
		writeFileSync(`${mirror.root}/SHASUMS256.txt`, `0000000000000000000000000000000000000000000000000000000000000000  ${`node-v22.9.0-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`}.tar.gz\n`)
		const r = install(
			['--url', URL],
			{
				PATH: binWithoutNode(),
				HOSTOPSD_NODE_FALLBACKS: '/no-such/node',
				HOSTOPSD_NODE_DIR: `${tmp}/opt`,
				HOSTOPSD_NODE_DIST: mirror.url,
				FAKE_DIST: mirror.url,
				FAKE_DIST_ROOT: mirror.root,
			},
		)
		assert.notEqual(r.status, 0)
		assert.match(r.stderr, /does not match its SHA256/)
		assert.ok(!existsSync(`${tmp}/opt/node`))
	})
})

describe('node.sh', () => {
	test('node_major and node_is_new_enough check the version a node reports', () => {
		const ok = bash(`source ${JSON.stringify(nodeSh)} && node_is_new_enough "$(command -v node)" && node_major "$(command -v node)"`)
		assert.equal(ok.status, 0, ok.stderr)
		assert.match(ok.stdout.trim(), /^(2[2-9]|[3-9][0-9])$/)
		const old = fakeNode(`${tmp}/old`, 18)
		const no = bash(`source ${JSON.stringify(nodeSh)} && node_is_new_enough ${JSON.stringify(old)} && echo kept`)
		assert.notEqual(no.status, 0)
		assert.ok(!no.stdout.includes('kept'))
	})

	test('pick_node skips what is missing or too old and takes the first that runs', () => {
		const old = fakeNode(`${tmp}/old`, 18)
		const good = fakeNode(`${tmp}/good`, 22)
		const r = bash(`set -e; source ${JSON.stringify(nodeSh)} && pick_node /no/such/node ${JSON.stringify(old)} ${JSON.stringify(good)}`)
		assert.equal(r.status, 0, r.stderr)
		assert.equal(r.stdout.trim(), good)
	})

	test("nvm_node finds the newest Node.js under a user's nvm", () => {
		const home = `${tmp}/home`
		fakeNode(`${home}/.nvm/versions/node/v18.0.0/bin`, 18)
		fakeNode(`${home}/.nvm/versions/node/v22.1.0/bin`, 22)
		const newest = fakeNode(`${home}/.nvm/versions/node/v22.10.0/bin`, 22)
		const bin = `${tmp}/getent-bin`
		mkdirSync(bin)
		writeFileSync(`${bin}/getent`, `#!/bin/sh\n[ "$1" = passwd ] && echo "testuser:x:1000:1000::${home}:/bin/sh"\nexit 0\n`)
		chmodSync(`${bin}/getent`, 0o755)
		const r = bash(`source ${JSON.stringify(nodeSh)} && nvm_node testuser`, { PATH: `${bin}:${process.env.PATH}` })
		assert.equal(r.status, 0, r.stderr)
		assert.equal(r.stdout.trim(), newest)
	})

	test('install_node_tarball unpacks a verified tarball and is idempotent', () => {
		const mirror = makeMirror()
		const dir = `${tmp}/opt`
		const r = bash(`set -e; source ${JSON.stringify(nodeSh)} && install_node_tarball ${JSON.stringify(DIST)} ${JSON.stringify(dir)}`, mirrorEnv(mirror))
		assert.equal(r.status, 0, r.stderr)
		assert.equal(r.stdout.trim(), `${dir}/node`)
		assert.ok(existsSync(`${dir}/node`))
		assert.equal(bash(`source ${JSON.stringify(nodeSh)} && node_major ${JSON.stringify(`${dir}/node`)}`).stdout.trim(), '22')
		// Already installed and new enough: no download, so a mirror that has gone away is fine.
		rmSync(`${mirror.root}`, { recursive: true, force: true })
		const again = bash(`set -e; source ${JSON.stringify(nodeSh)} && install_node_tarball ${JSON.stringify(DIST)} ${JSON.stringify(dir)}`, mirrorEnv(mirror))
		assert.equal(again.status, 0, again.stderr)
		assert.equal(again.stdout.trim(), `${dir}/node`)
	})

	test('install_node_tarball fails closed on a checksum mismatch', () => {
		const mirror = makeMirror()
		const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
		writeFileSync(`${mirror.root}/SHASUMS256.txt`, `0000000000000000000000000000000000000000000000000000000000000000  node-v22.9.0-linux-${arch}.tar.gz\n`)
		const dir = `${tmp}/opt`
		const r = bash(`source ${JSON.stringify(nodeSh)} && install_node_tarball ${JSON.stringify(DIST)} ${JSON.stringify(dir)}`, mirrorEnv(mirror))
		assert.notEqual(r.status, 0)
		assert.match(r.stderr, /does not match its SHA256/)
		assert.ok(!existsSync(`${dir}/node`))
	})
})
