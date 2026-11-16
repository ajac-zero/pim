#!/usr/bin/env node
// Decides which of CI's jobs a change needs (`.github/workflows/ci.yml`'s `scope` job), from the files
// it changes against the branch it started from, so a change to the docs doesn't wait for the Worker's
// tests. Pushes to main run every job. It needs only Node and git, so it runs before anything is installed.
// Anything it doesn't know is backend code, which runs the most; a job is skipped only for files that can't reach it.
import { spawnSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Every job a change can need, besides the internal-identifier check, which always runs. */
export const JOBS = ["typecheck", "lint", "web", "daemons", "unit", "worker", "browser"];

/** Prose: what no test or type reads. */
const prose = (file) => file.endsWith(".md") || file === "LICENSE" || file.startsWith("docs/");

/** The standalone daemons, whose tests are their own. */
const daemon = (file) => file.startsWith("sandbox-manager/") || file.startsWith("workspace-agentd/") || file.startsWith("displayd/");

/** What can change every job's result: the dependencies, the build, the test setup and CI itself. */
const configuring = (file) => /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*|wrangler[^/]*\.jsonc|vitest[^/]*\.config\.[^/]*|biome\.json[c]?)$/.test(file) || file.startsWith(".github/");

/** What the web app imports from outside web/: the packages it depends on (@pim/shared and @pim/ui-lang), and the bundle web/ serves from displayd. */
const sharedWithWeb = (file) => ["packages/shared/", "packages/ui-lang/", "displayd/bundle."].some((shared) => file.startsWith(shared));

/** A package's own tests: no Worker test or type outside the package reads them, unlike its source and its `test/support/` modules, which Worker tests import. */
const packageTest = (file) => /^packages\/[^/]+\/test\//.test(file) && !file.includes("/test/support/");

/** The v2 packages (`packages/v2-*`) and tools (`scripts/v2-*`): nothing in the Worker or the web app imports them, so only their types and their own tests (the unit job) can change. */
const v2 = (file) => /^(packages\/v2-[^/]+\/|scripts\/v2-)/.test(file);

/** What the tests that browse with a Chrome (test/browser.test.ts) can reach. */
const browsing = (file) =>
	["src/browser.ts", "src/extensions/browser.ts", "src/space/routes.ts", "src/space/sockets.ts", "src/space/views.ts", "computer/", "test/browser.test.ts", "test/helpers.ts", "test/worker.ts", "scripts/install-test-browser.mjs"].some((path) => file.startsWith(path));

/** The jobs a change to `changed` needs: every one for a push to main, otherwise those the files can reach. */
export function selectJobs(changed, { main = false } = {}) {
	const jobs = Object.fromEntries(JOBS.map((job) => [job, main]));
	if (main) return jobs;
	for (const file of changed.filter(Boolean)) {
		if (prose(file)) continue;
		if (configuring(file)) {
			for (const job of JOBS) jobs[job] = true;
		} else if (file.startsWith("web/")) {
			Object.assign(jobs, { typecheck: true, lint: true, web: true });
		} else if (v2(file)) {
			Object.assign(jobs, { typecheck: true, unit: true });
		} else if (packageTest(file)) {
			// Only the package's own tests read these: its types and its tests, which the unit job runs. Its source also runs under the Worker's tests (below), so the Worker's shards are skipped only for a change that is all tests.
			Object.assign(jobs, { typecheck: true, unit: true });
		} else if (daemon(file)) {
			jobs.daemons = true;
			// What the Worker's tests and the web app's types read of displayd is its bundle.
			if (sharedWithWeb(file)) Object.assign(jobs, { typecheck: true, web: true, unit: true, worker: true });
		} else {
			Object.assign(jobs, { typecheck: true, lint: true, unit: true, worker: true });
			if (sharedWithWeb(file)) jobs.web = true;
			if (browsing(file)) jobs.browser = true;
		}
	}
	return jobs;
}

/** The files that differ from `base` at its merge base with HEAD. */
function changedFiles(base) {
	const diff = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
	if (diff.status !== 0) throw new Error(`git diff ${base}...HEAD failed: ${diff.stderr}`);
	return diff.stdout.split("\n").filter(Boolean);
}

function main() {
	// `main` is a push to main; anything else is compared with the branch it started from.
	const main = process.env.GITHUB_REF === "refs/heads/main";
	const base = process.argv[2] ?? `origin/${process.env.GITHUB_BASE_REF || "main"}`;
	// When the diff can't be taken, everything runs.
	let jobs;
	let files = [];
	try {
		files = main ? [] : changedFiles(base);
		jobs = selectJobs(files, { main: main || files.length === 0 });
	} catch (error) {
		console.warn(String(error));
		jobs = selectJobs([], { main: true });
	}
	console.log(`${main ? "main" : `changes against ${base}`}: ${files.join(", ") || "(all)"}`);
	for (const [job, needed] of Object.entries(jobs)) console.log(`${job.padEnd(10)} ${needed ? "run" : "skip"}`);
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(jobs).map(([job, needed]) => `${job}=${needed}\n`).join(""));
}

// Only when started as a script; a test imports selectJobs from here.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
