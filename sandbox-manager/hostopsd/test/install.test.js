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
	// bearer is in $PIM/good_tokens, else 401. Argv goes to $FAKE_LOG; stdin (the curl config,
	// which holds the bearer) is never logged.
	curl: `#!/usr/bin/env bash
echo "curl $*" >>"$FAKE_LOG"
out=; url=
while [ $# -gt 0 ]; do case "$1" in --output) out=$2; shift 2 ;; --write-out|--max-time|--request|--header|--data|--config) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
bearer=$(sed -n 's/^header = "Authorization: Bearer \\(.*\\)"$/\\1/p')
case "$url" in
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
	getent: '#!/bin/sh\n',
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

describe('up.sh ensures hostopsd', () => {
	test('first install enrolls through sudo and stores the credential only in /etc/hostopsd/env', () => {
		const r = up()
		assert.equal(r.status, 0, r.stderr)
		assert.match(log(), /docker compose up -d --build/)
		assert.match(log(), /sudo -n .*install\.sh --url https:\/\/pim\.test/)
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
})
