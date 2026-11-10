// Stand-ins for the programs hostopsd runs, for the tests: `node fakes.js <tool> <dir> args...`,
// called through small wrappers on PATH (see harness.js). Each call is appended to <dir>/calls.jsonl
// with its argv, working directory and environment variable names. <dir>/fake.json steers them.
// `git` runs the real git after logging, so ancestry checks are real.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [tool, dir, ...args] = process.argv.slice(2)
const ctl = JSON.parse(readFileSync(path.join(dir, 'fake.json'), 'utf8'))
appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ tool, args, cwd: process.cwd(), env: Object.keys(process.env).sort(), buildSha: process.env.BUILD_SHA, managerToken: process.env.MANAGER_TOKEN })}\n`)
const matches = (list, sha) => (list ?? []).some((p) => sha && (sha.startsWith(p) || p.startsWith(sha)))

if (tool === 'git') {
	const r = spawnSync(ctl.realGit, args, { stdio: 'inherit' })
	process.exit(r.status ?? 1)
}

if (tool === 'up') {
	// sandbox-manager/up.sh in the fake checkout: "rebuilds" the stack at BUILD_SHA, which the fake
	// manager then reports.
	const sha = process.env.BUILD_SHA
	if (matches(ctl.upFail, sha)) {
		console.error(`compose build failed for ${sha}`)
		process.exit(1)
	}
	writeFileSync(path.join(dir, 'deployed'), sha)
	console.log(`started ${sha}`)
	process.exit(0)
}

if (tool === 'docker') {
	const a = args.join(' ')
	if (a === 'info --format {{.DockerRootDir}}') console.log(ctl.dockerRoot ?? '/')
	else if (a === 'system df --format {{json .}}') {
		console.log(JSON.stringify({ Type: 'Images', TotalCount: '4', Active: '3', Size: '2.1GB', Reclaimable: '300MB (14%)' }))
		console.log(JSON.stringify({ Type: 'Local Volumes', TotalCount: '7', Active: '2', Size: '5GB', Reclaimable: '1GB (20%)' }))
	} else if (a === 'ps --all --format {{json .}}') {
		console.log(JSON.stringify({ Names: 'sandbox-manager', State: 'running', Status: 'Up 2 hours', Image: 'pim-sandbox-manager' }))
		console.log(JSON.stringify({ Names: 'egress-proxy', State: 'running', Status: 'Up 2 hours', Image: 'pim-sandbox-manager' }))
		console.log(JSON.stringify({ Names: 'sandbox-manager-workspace-image-1', State: 'exited', Status: 'Exited (0) 2 hours ago', Image: 'pim-workspace:local' }))
	} else if (args[0] === 'compose' && args[1] === 'restart') {
		if (ctl.restartFail) {
			console.error(`no such service: ${args[2]}`)
			process.exit(1)
		}
		console.log(`Container ${args[2]} Restarting`)
	} else if (args[0] === 'compose' && args[1] === 'logs') console.log(ctl.logsText ?? '')
	else {
		console.error(`fake docker: unexpected ${a}`)
		process.exit(1)
	}
	process.exit(0)
}

if (tool === 'journalctl') {
	console.log(ctl.journalText ?? '')
	process.exit(0)
}

console.error(`fakes.js: unknown tool ${tool}`)
process.exit(2)
