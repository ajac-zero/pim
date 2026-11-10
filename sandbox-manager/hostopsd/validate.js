// The allowlist. Every operation Pim sends is checked here again, whatever Pim checked: an unknown
// operation, a missing or malformed argument, or any argument not listed fails the operation
// before anything runs.

export const SERVICES = ['sandbox-manager', 'egress-proxy', 'docker-socket-proxy', 'hostopsd']
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
const commit = (v) => (typeof v === 'string' && COMMIT.test(v) ? null : 'must be 7 to 40 hex characters')

// name -> { arg: [check, required, default] }
const OPS = {
	stats: {},
	deploy: { ref: [ref, false, 'origin/main'] },
	rollback: { commit: [commit, true] },
	restart: { service: [oneOf(SERVICES), true] },
	logs: { service: [oneOf(SERVICES), true], lines: [int(1, 500), false, 200] },
	set_slot_limit: { maxConcurrent: [int(1, 16), true] },
}
export const OP_NAMES = Object.keys(OPS)

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

// Checks the envelope Pim sends. Returns the op id (or null when there is none to report against)
// and either the validated op or an error.
export function validateOp(op) {
	const id = isPlainObject(op) && typeof op.id === 'string' && OP_ID.test(op.id) ? op.id : null
	if (!id) return { id: null, error: 'operation has no valid id' }
	const spec = Object.hasOwn(OPS, op.name) ? OPS[op.name] : null
	if (!spec) return { id, error: `unknown operation ${JSON.stringify(String(op.name).slice(0, 60))}` }
	const raw = op.args ?? {}
	if (!isPlainObject(raw)) return { id, error: 'args must be an object' }
	const extra = Object.keys(raw).filter((k) => !Object.hasOwn(spec, k))
	if (extra.length) return { id, error: `${op.name} takes no argument ${extra.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}` }
	const args = {}
	for (const [key, [check, required, fallback]] of Object.entries(spec)) {
		if (raw[key] === undefined) {
			if (required) return { id, error: `${op.name} needs ${key}` }
			args[key] = fallback
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
