// The per-entry inventory coverage matrix covers every entry of the audit and names tests that exist, and the committed document is what the script builds.
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps docs/architecture/v2-inventory-coverage.md complete and current", () => {
	const run = spawnSync(process.execPath, ["scripts/v2-coverage/build.mjs", "--check"], { encoding: "utf8" });
	expect(run.stderr).toBe("");
	expect(run.status).toBe(0);
	expect(run.stdout).toMatch(/^162 entries:/);
});
