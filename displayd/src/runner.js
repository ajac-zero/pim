// The process runner: what starts, probes and kills one display's processes. The allocator only
// sees this interface, so tests give it support/fake-runner.js.
//
//   contextDir(id)            -> the display's context directory
//   start(spec)               -> {pgid}; spawns the display's process group and returns at once
//   probe(spec, pgid)         -> whether the display is healthy: its processes are up, X is
//                                serving and the VNC port answers
//   isAlive(pgid, spec)       -> whether pgid is still this display's process group
//   kill(pgid, spec)          -> ends the group, with SIGKILL after a grace period
//   removeContext(id)         -> deletes the context directory
//   listContexts()            -> [{id, pgid}] for every context directory on disk
//
// spec is {id, display, vncPort, cdpPort, dir, geometry, env}.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One bash process is the group leader and the supervisor: it starts the X server, a private
// session bus, the window manager and the accessibility bus, writes `ready` when all are up, and
// exits, taking the group with it, as soon as any of them does. Nothing listens on TCP but the
// loopback VNC port; X itself is a unix socket guarded by the cookie in XAUTHORITY.
const SUPERVISOR = String.raw`
set -u
umask 077
cd "$PIM_DIR"
trap 'trap - EXIT TERM; kill 0 2>/dev/null; exit 0' EXIT TERM INT
Xvnc ":$PIM_DISPLAY" -geometry "$PIM_GEOMETRY" -depth 24 -rfbport "$PIM_VNC_PORT" -localhost -SecurityTypes None \
	-nolisten tcp -auth "$XAUTHORITY" -AlwaysShared >"$PIM_DIR/xvnc.log" 2>&1 &
for _ in $(seq 100); do [ -S "/tmp/.X11-unix/X$PIM_DISPLAY" ] && break; sleep 0.2; done
[ -S "/tmp/.X11-unix/X$PIM_DISPLAY" ] || exit 1
dbus-daemon --session --nofork --address="$DBUS_SESSION_BUS_ADDRESS" >"$PIM_DIR/dbus.log" 2>&1 &
for _ in $(seq 50); do [ -S "$PIM_DIR/bus" ] && break; sleep 0.1; done
openbox >"$PIM_DIR/openbox.log" 2>&1 &
ATSPI=$(command -v at-spi-bus-launcher || echo /usr/libexec/at-spi-bus-launcher)
"$ATSPI" --launch-immediately >"$PIM_DIR/atspi.log" 2>&1 &
sleep 0.5
touch "$PIM_DIR/ready"
wait -n
exit 1
`

const alive = (pid) => {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return e.code === 'EPERM'
	}
}

const connects = (port) =>
	new Promise((resolve) => {
		const s = net.connect({ host: '127.0.0.1', port })
		const done = (ok) => (s.destroy(), resolve(ok))
		s.setTimeout(1000, () => done(false))
		s.once('connect', () => done(true))
		s.once('error', () => done(false))
	})

export class RealRunner {
	constructor({ root = '/run/pim/displays', env = process.env } = {}) {
		this.root = root
		this.baseEnv = { PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: env.HOME ?? '/', LANG: env.LANG ?? 'C.UTF-8' }
		mkdirSync(root, { recursive: true, mode: 0o700 })
	}

	contextDir(id) {
		return path.join(this.root, id)
	}

	async start(spec) {
		const { dir } = spec
		rmSync(dir, { recursive: true, force: true })
		mkdirSync(path.join(dir, 'run'), { recursive: true, mode: 0o700 })
		chmodSync(dir, 0o700)
		await run('xauth', ['-f', spec.env.XAUTHORITY, 'add', spec.env.DISPLAY, '.', randomBytes(16).toString('hex')], { env: this.baseEnv })
		chmodSync(spec.env.XAUTHORITY, 0o600)
		// A file to source, for a person or a tool that joins the display.
		const exports = Object.entries(spec.env).map(([k, v]) => `export ${k}='${v}'`)
		writeFileSync(path.join(dir, 'env'), `${exports.join('\n')}\n`, { mode: 0o600 })
		const env = { ...this.baseEnv, ...spec.env, PIM_DIR: dir, PIM_DISPLAY: String(spec.display), PIM_VNC_PORT: String(spec.vncPort), PIM_GEOMETRY: spec.geometry }
		// $0 names the display so isAlive can tell it from an unrelated process that reuses the pid.
		const child = spawn('bash', ['-c', SUPERVISOR, `pim-display-${spec.id}`], { env, detached: true, stdio: 'ignore' })
		child.unref()
		await new Promise((resolve, reject) => {
			child.once('spawn', resolve)
			child.once('error', reject)
		})
		writeFileSync(path.join(dir, 'pgid'), `${child.pid}\n`, { mode: 0o600 })
		return { pgid: child.pid }
	}

	isAlive(pgid, spec) {
		try {
			return alive(pgid) && readFileSync(`/proc/${pgid}/cmdline`, 'utf8').split('\0').includes(`pim-display-${spec.id}`)
		} catch {
			return false
		}
	}

	async probe(spec, pgid) {
		return this.isAlive(pgid, spec) && existsSync(path.join(spec.dir, 'ready')) && existsSync(`/tmp/.X11-unix/X${spec.display}`) && (await connects(spec.vncPort))
	}

	async kill(pgid, spec) {
		if (!this.isAlive(pgid, spec)) return
		for (const [sig, wait] of [['SIGTERM', 3000], ['SIGKILL', 2000]]) {
			try {
				process.kill(-pgid, sig)
			} catch {}
			for (let waited = 0; waited < wait && alive(pgid); waited += 100) await sleep(100)
			if (!alive(pgid)) return
		}
	}

	removeContext(id) {
		rmSync(this.contextDir(id), { recursive: true, force: true })
	}

	listContexts() {
		return readdirSync(this.root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => {
				let pgid = null
				try {
					pgid = Number(readFileSync(path.join(this.root, e.name, 'pgid'), 'utf8')) || null
				} catch {}
				return { id: e.name, pgid }
			})
	}
}
