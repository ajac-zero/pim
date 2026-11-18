// The allowlist. Every operation Pim sends is checked here again, whatever Pim checked: an unknown
// operation, a missing or malformed argument, or any argument not listed fails the operation
// before anything runs.

export const SERVICES = ['sandbox-manager', 'egress-proxy', 'docker-socket-proxy', 'hostopsd']
// The services of the Pim stack on Docker Compose (HOSTOPSD_STACK=compose), which packages/v2-server's HOST_SERVICES must list too.
export const COMPOSE_SERVICES = ['caddy', 'postgres', 'pgbouncer', 'nats', 'seaweedfs', 'gate', 'live', 'runner', 'forge', 'maintenance', 'canvas', 'relay', 'pim-computer', 'sandbox-manager', 'hostopsd']
export const REF = /^[A-Za-z0-9._/-]{1,100}$/
export const COMMIT = /^[0-9a-fA-F]{7,40}$/
const OP_ID = /^[A-Za-z0-9_.:-]{1,128}$/

const int = (lo, hi) => (v) => (Number.isInteger(v) && v >= lo && v <= hi ? null : `must be an integer from ${lo} to ${hi}`)
const oneOf = (list) => (v) => (list.includes(v) ? null : `must be one of ${list.join(', ')}`)

// A ref goes to git as one argv element, so the shell cannot see it; what is refused here is what
// git itself would read as something other than a ref name: an option, a range, or a reflog step.
function ref(v) {
	if (typeof v !== 'string' || !REF.test(v)) return 'must match ^[A-Za-z0-9._/-]{1,100}$'
	if (v.startsWith('-') || v.startsWith('/') || v.endsWith('/') || v.endsWith('.') || v.includes('..') || v.includes('//') || v.endsWith('.lock')) return 'is not a valid ref name'
	return null
}
// One command for a non-interactive shell: any text, but not empty, not huge, and no NUL byte (a
// shell would cut the command there, so the person would approve something other than what runs).
export const EXEC_MAX_COMMAND = 2000
const command = (v) => (typeof v === 'string' && v.trim() !== '' && v.length <= EXEC_MAX_COMMAND && !v.includes('\0') ? null : `must be 1 to ${EXEC_MAX_COMMAND} characters, without NUL`)
// An image tag for `pim.sh update`: stable, edge, 2.1, 2.1.0, sha-0123456789ab. It goes to a script as one argument, and a leading dash would read as an option.
const tag = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v) ? null : 'must be an image tag of letters, digits and . _ -')
const commit = (v) => (typeof v === 'string' && COMMIT.test(v) ? null : 'must be 7 to 40 hex characters')

// name -> { arg: [check, required, default] }
const opsFor = (services) => ({
	stats: {},
	deploy: { ref: [ref, false, 'origin/main'] },
	rollback: { commit: [commit, true] },
	restart: { service: [oneOf(services), true] },
	logs: { service: [oneOf(services), true], lines: [int(1, 500), false, 200] },
	update: { tag: [tag, false, undefined] },
	set_slot_limit: { maxConcurrent: [int(1, 16), true] },
	exec: { command: [command, true], timeoutSeconds: [int(1, 300), false, 60], maxOutputBytes: [int(1, 65536), false, 65536] },
})
const OPS = opsFor(SERVICES)
export const OP_NAMES = Object.keys(OPS)

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

// Checks the envelope Pim sends. Returns the op id (or null when there is none to report against)
// and either the validated op or an error.
export function validateOp(op, services = SERVICES) {
	const id = isPlainObject(op) && typeof op.id === 'string' && OP_ID.test(op.id) ? op.id : null
	if (!id) return { id: null, error: 'operation has no valid id' }
	const ops = services === SERVICES ? OPS : opsFor(services)
	const spec = Object.hasOwn(ops, op.name) ? ops[op.name] : null
	if (!spec) return { id, error: `unknown operation ${JSON.stringify(String(op.name).slice(0, 60))}` }
	const raw = op.args ?? {}
	if (!isPlainObject(raw)) return { id, error: 'args must be an object' }
	const extra = Object.keys(raw).filter((k) => !Object.hasOwn(spec, k))
	if (extra.length) return { id, error: `${op.name} takes no argument ${extra.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}` }
	const args = {}
	for (const [key, [check, required, fallback]] of Object.entries(spec)) {
		if (raw[key] === undefined) {
			if (required) return { id, error: `${op.name} needs ${key}` }
			if (fallback !== undefined) args[key] = fallback
			continue
		}
		const problem = check(raw[key])
		if (problem) return { id, error: `${op.name}: ${key} ${problem}` }
		args[key] = raw[key]
	}
	if (op.name === 'rollback') args.commit = args.commit.toLowerCase()
	const deadlineMs = typeof op.deadlineMs === 'number' && Number.isFinite(op.deadlineMs) ? op.deadlineMs : null
	return { id, op: { id, name: op.name, args, deadlineMs } }
}
