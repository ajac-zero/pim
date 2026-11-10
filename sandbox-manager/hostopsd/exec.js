// Runs one program with a fixed argv array: a fixed working directory, a timeout that kills the
// program's whole process group, and bounded output. Every command hostopsd runs goes through
// here, with no stdin. `reap` ends the run shortly after the program exits and kills what it left running in its
// process group, instead of waiting for them to close its output (the exec operation sets it).
import { spawn } from 'node:child_process'

const KEEP = 1024 * 1024 // bytes kept per stream; the tail is what matters for failures

export function run(file, argv, { cwd, env, timeoutMs, input, reap = false } = {}) {
	if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) throw new TypeError('argv must be an array of strings')
	if (!cwd) throw new TypeError('cwd is required')
	if (!timeoutMs) throw new TypeError('timeoutMs is required')
	return new Promise((resolve) => {
		const out = []
		const err = []
		const sizes = { out: 0, err: 0 }
		let seen = 0
		let dropped = 0
		const timers = []
		let timedOut = false
		let done = false
		let child
		const finish = (r) => {
			if (done) return
			done = true
			for (const t of timers) clearTimeout(t)
			resolve({ stdout: tail(out), stderr: tail(err), timedOut, outputBytes: seen, droppedBytes: dropped, ...r })
		}
		const collect = (buf, key, c) => {
			buf.push(c)
			sizes[key] += c.length
			seen += c.length
			while (sizes[key] > KEEP && buf.length > 1) {
				const gone = buf.shift().length
				sizes[key] -= gone
				dropped += gone
			}
		}
		try {
			child = spawn(file, argv, { cwd, env, shell: false, detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
		} catch (e) {
			return resolve({ code: 127, signal: null, stdout: '', stderr: String(e.message), timedOut: false })
		}
		const killGroup = () => {
			try {
				process.kill(-child.pid, 'SIGKILL')
			} catch {}
		}
		timers.push(
			setTimeout(() => {
				timedOut = true
				killGroup()
				// A process that left its process group can hold the output open; do not wait for it.
				timers.push(setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 2000))
			}, timeoutMs),
		)
		child.stdout.on('data', (c) => collect(out, 'out', c))
		child.stderr.on('data', (c) => collect(err, 'err', c))
		if (reap) {
			child.on('exit', (code, signal) =>
				timers.push(
					setTimeout(() => {
						killGroup()
						finish({ code, signal })
					}, 300),
				),
			)
		}
		if (input !== undefined) child.stdin.end(input)
		child.on('error', (e) => finish({ code: 127, signal: null, stderr: `${file}: ${e.message}` }))
		child.on('close', (code, signal) => finish({ code, signal }))
	})
}

const tail = (chunks) => Buffer.concat(chunks).toString('utf8')

// The last `max` characters of a command's output, for failure messages.
export const lastLines = (s, max = 1500) => (s.length > max ? `…${s.slice(-max)}` : s).trim()

export function describeFailure(name, r) {
	if (r.timedOut) return `${name} timed out`
	const why = r.code === null ? `was killed by ${r.signal}` : `exited with ${r.code}`
	const text = lastLines(`${r.stderr}\n${r.stdout}`.trim())
	return `${name} ${why}${text ? `: ${text}` : ''}`
}
