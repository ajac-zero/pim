#!/usr/bin/env node
// Runs only the tests a change can reach, so iterating on one file doesn't pay for the whole
// suite every time: `pnpm test:changed`. It diffs against origin/main (HEAD~1 when there is no
// origin/main, or the ref given as an argument) and picks what to run: the whole suite when
// configuration changed or nothing maps to a test, otherwise vitest's own --changed over the
// root project for the Worker's tests, plus the web app's tests when web/ changed. The whole
// suite still runs once at the end of a change, in the foreground (AGENTS.md).
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** A file's own name, whatever directory it is in, so web/package.json counts as package.json. */
const name = (file) => file.slice(file.lastIndexOf("/") + 1);

/** Whether a change to a file can reach any test: the dependencies, and the build and test setup. */
function reconfigured(file) {
	return (
		name(file) === "package.json" ||
		name(file) === "pnpm-lock.yaml" ||
		/^vitest.*\.config\./.test(name(file)) ||
		/^wrangler/.test(name(file)) ||
		/^tsconfig/.test(name(file))
	);
}

/** Whether no test reads a file: prose, and the repository's own housekeeping. */
function prose(file) {
	return file.endsWith(".md") || file === "LICENSE" || file.startsWith("docs/") || file.startsWith(".github/");
}

/** What `pnpm test:changed` runs for a diff's files: the whole suite and why, or the projects it maps the change to. */
export function selectRuns(changed) {
	const files = changed.filter((file) => file);
	if (!files.length) return { full: true, reason: "nothing changed to diff" };
	const configuring = files.find((file) => reconfigured(file));
	if (configuring) return { full: true, reason: `${configuring} changed` };
	const web = files.some((file) => file.startsWith("web/"));
	const root = files.some((file) => !file.startsWith("web/") && !prose(file));
	if (!root && !web) return { full: true, reason: "no tests map to what changed" };
	return { full: false, root, web };
}

/** Runs one command in the foreground, one at a time as AGENTS.md asks, and returns whether it passed. */
function run(command, args) {
	return spawnSync(command, args, { stdio: "inherit" }).status === 0;
}

/** The files that differ from `ref`: the branch's commits, the working tree, and files never added. */
function changedFiles(ref) {
	const git = (args) => (spawnSync("git", args, { encoding: "utf8" }).stdout ?? "").split("\n");
	return [...git(["diff", "--name-only", ref]), ...git(["ls-files", "--others", "--exclude-standard"])].filter(Boolean);
}

/** The ref to diff against: the one asked for, origin/main, or HEAD~1 when there is no origin/main. */
function baseRef() {
	for (const ref of [process.argv[2], "origin/main", "HEAD~1"]) {
		if (ref && spawnSync("git", ["rev-parse", "--verify", "--quiet", ref]).status === 0) return ref;
	}
	return null;
}

function main() {
	const base = baseRef();
	const files = base ? changedFiles(base) : [];
	const plan = selectRuns(files);
	console.log(`Diff against ${base ?? "nothing"}: ${files.join(", ") || "(no files)"}`);
	if (plan.full) {
		console.log(`Running the whole suite, because ${plan.reason}.`);
		process.exit(run("pnpm", ["test"]) ? 0 : 1);
	}
	if (plan.root) {
		console.log(`Running the root project's tests changed since ${base}.`);
		if (!run("pnpm", ["exec", "vitest", "run", "--changed", base])) process.exit(1);
	}
	if (plan.web) {
		console.log("Running the web app's tests.");
		if (!run("pnpm", ["--filter", "pim-web", "test"])) process.exit(1);
	}
}

// Only when started as a script; a test imports selectRuns from here.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
