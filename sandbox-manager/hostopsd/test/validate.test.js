import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateOp } from '../validate.js'

const v = (name, args, extra = {}) => validateOp({ id: 'op-1', name, args, ...extra })
const ok = (name, args, expected) => {
	const r = v(name, args)
	assert.equal(r.error, undefined, `${name} ${JSON.stringify(args)}: ${r.error}`)
	assert.deepEqual(r.op.args, expected)
}
const bad = (name, args, pattern) => {
	const r = v(name, args)
	assert.equal(r.op, undefined, `${name} ${JSON.stringify(args)} should be refused`)
	assert.equal(r.id, 'op-1')
	if (pattern) assert.match(r.error, pattern)
}

const INJECTIONS = ['main; touch /tmp/x', '$(touch /tmp/x)', '`touch /tmp/x`', 'main && id', 'main|id', "main'", 'main\nid', 'a b', '${IFS}']

test('the envelope needs an id and a known op name', () => {
	assert.equal(validateOp(null).id, null)
	assert.equal(validateOp({ name: 'stats' }).id, null)
	assert.equal(validateOp({ id: 'a b', name: 'stats' }).id, null)
	bad('reboot', {}, /unknown operation/)
	bad('constructor', {}, /unknown operation/)
	bad('__proto__', {}, /unknown operation/)
	bad('toString', {}, /unknown operation/)
	assert.match(validateOp({ id: 'x', name: 'stats', args: [] }).error, /args must be an object/)
	assert.match(validateOp({ id: 'x', name: 'stats', args: 'x' }).error, /args must be an object/)
})

test('stats takes nothing', () => {
	ok('stats', {}, {})
	ok('stats', undefined, {})
	bad('stats', { verbose: true }, /takes no argument "verbose"/)
})

test('deploy takes an optional ref', () => {
	ok('deploy', {}, { ref: 'origin/main' })
	ok('deploy', { ref: 'origin/release-1.2_x' }, { ref: 'origin/release-1.2_x' })
	ok('deploy', { ref: 'abc1234' }, { ref: 'abc1234' })
	for (const ref of ['', 'x'.repeat(101), 7, null, ...INJECTIONS]) bad('deploy', { ref })
	for (const ref of ['-c', '--upload-pack=x', 'main..side', '/main', 'main/', 'a//b', 'main.lock', 'main.', 'HEAD@{1}', 'main^2', 'main~1']) bad('deploy', { ref })
	bad('deploy', { ref: 'origin/main', force: true }, /takes no argument "force"/)
})

test('rollback needs a 7 to 40 character hex commit', () => {
	ok('rollback', { commit: 'abcdef0' }, { commit: 'abcdef0' })
	ok('rollback', { commit: 'ABCDEF0123' }, { commit: 'abcdef0123' })
	ok('rollback', { commit: 'a'.repeat(40) }, { commit: 'a'.repeat(40) })
	bad('rollback', {}, /needs commit/)
	for (const commit of ['abcdef', 'a'.repeat(41), 'abcdefg', 'origin/main', 1234567, ...INJECTIONS, 'abc1234; rm -rf /']) bad('rollback', { commit })
	bad('rollback', { commit: 'abcdef0', ref: 'x' })
})

test('restart and logs take a listed service', () => {
	for (const service of ['sandbox-manager', 'egress-proxy', 'docker-socket-proxy', 'hostopsd']) {
		ok('restart', { service }, { service })
		ok('logs', { service, lines: 5 }, { service, lines: 5 })
	}
	ok('logs', { service: 'hostopsd' }, { service: 'hostopsd', lines: 200 })
	for (const service of [undefined, 'workspace-image', 'sandbox-manager ', 'SANDBOX-MANAGER', 'sandbox-manager && touch /tmp/x', ['hostopsd']]) {
		bad('restart', service === undefined ? {} : { service })
		bad('logs', service === undefined ? {} : { service, lines: 5 })
	}
	for (const lines of [0, 501, 1.5, '5', '5; id', -1, null]) bad('logs', { service: 'hostopsd', lines })
	ok('logs', { service: 'hostopsd', lines: 500 }, { service: 'hostopsd', lines: 500 })
	bad('restart', { service: 'hostopsd', all: true })
})

test('set_slot_limit needs maxConcurrent 1 to 16', () => {
	ok('set_slot_limit', { maxConcurrent: 1 }, { maxConcurrent: 1 })
	ok('set_slot_limit', { maxConcurrent: 16 }, { maxConcurrent: 16 })
	bad('set_slot_limit', {}, /needs maxConcurrent/)
	for (const maxConcurrent of [0, 17, 2.5, '4', null, true]) bad('set_slot_limit', { maxConcurrent })
	bad('set_slot_limit', { maxConcurrent: 2, persist: true })
})

test('deadlineMs is passed through when it is a number', () => {
	assert.equal(v('stats', {}, { deadlineMs: 123 }).op.deadlineMs, 123)
	assert.equal(v('stats', {}, { deadlineMs: 'soon' }).op.deadlineMs, null)
})
