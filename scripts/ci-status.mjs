#!/usr/bin/env node
// Whether CI and the Compose smoke test passed on a commit of main (publish.yml, the `qualify` and `release` jobs). A release is promoted to `stable` only for a commit they passed on: that a tag is on
// main's history says nothing about it (branch protection is not assumed), so the workflows' own results are read. Anything that cannot be read is an error, never a pass.
//
//   node scripts/ci-status.mjs wait <commit>      waits (up to 50 minutes) until both have finished; exits non-zero unless both succeeded
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const WORKFLOWS = ["ci.yml", "compose.yml"];

const ghRun = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** "success", "failed" (one finished unsuccessfully) or "pending" (one has not started or finished), by each workflow's newest run for the push to main of `commit`. */
export function ciStatus(commit, run = ghRun) {
	let pending = false;
	for (const workflow of WORKFLOWS) {
		const runs = JSON.parse(run(["run", "list", "--workflow", workflow, "--commit", commit, "--event", "push", "--branch", "main", "--limit", "1", "--json", "status,conclusion"]));
		const latest = runs[0];
		if (!latest || latest.status !== "completed") pending = true;
		else if (latest.conclusion !== "success") return "failed";
	}
	return pending ? "pending" : "success";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, commit] = process.argv.slice(2);
	if (command !== "wait" || !commit) throw new Error("usage: ci-status.mjs wait <commit>");
	for (let i = 0; i <= 200; i++) {
		const status = ciStatus(commit);
		console.log(`CI and Compose on ${commit.slice(0, 12)}: ${status}`);
		if (status === "success") process.exit(0);
		if (status === "failed") {
			console.log(`::error::CI or the Compose smoke test did not succeed on ${commit}, so this release is not promoted`);
			process.exit(1);
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
	}
	console.log(`::error::CI and the Compose smoke test on ${commit} did not finish in time`);
	process.exit(1);
}
