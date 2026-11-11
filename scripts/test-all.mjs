#!/usr/bin/env node
// The whole suite's independent stages at once — the internal-identifier check, the root project's
// Worker tests and the web app's tests — each with its output prefixed with its name, so one stage
// doesn't wait for the ones before it. The full suite is CI's to run, in shards
// (`.github/workflows/ci.yml`); `pnpm test:serial` runs the same stages one at a time, for a
// machine too small to hold them side by side (AGENTS.md).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** The suite's stages: the name each line of its output is prefixed with, and the command that runs it. */
const stages = [
	{ name: "identifiers", run: [process.execPath, "scripts/check-internal-identifiers.mjs"] },
	{ name: "worker", run: ["pnpm", "exec", "vitest", "run"] },
	{ name: "web", run: ["pnpm", "--filter", "pim-web", "test"] },
];

const width = Math.max(...stages.map((stage) => stage.name.length));
const children = [];

// A Ctrl-C reaches this script alone; the stages it started should stop with it.
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => {
		for (const child of children) child.kill(signal);
		process.exit(130);
	});

/** Starts one stage, printing its output as it comes with its name in front of every line, and resolves to its exit code. */
function start(stage) {
	return new Promise((resolve) => {
		const child = spawn(stage.run[0], stage.run.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		children.push(child);
		const prefix = `${stage.name.padEnd(width)} | `;
		for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", (line) => console.log(prefix + line));
		child.on("error", () => resolve(1));
		child.on("close", (code) => resolve(code ?? 1));
	});
}

const codes = await Promise.all(stages.map(start));
for (const [stage, code] of stages.map((stage, index) => [stage, codes[index]]))
	console.log(code === 0 ? `${stage.name.padEnd(width)} | passed` : `${stage.name.padEnd(width)} | failed with exit code ${code}`);
process.exit(codes.some((code) => code !== 0) ? 1 : 0);
