import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { testBindings } from "./vitest.bindings";

/**
 * The native fence prerequisites and the abort-effect companions of Pim's
 * local pi-durable and agents patches (docs/cua-native-fence-prerequisites.md,
 * docs/cua-native-abort-effect.md), with the existing tests whose Stops and
 * aborts the patches touch. As the Cua stand-in lane does
 * (vitest.cua-standin.config.ts), its Worker has no Browser Run binding, no
 * live mode and no remote bindings, and it runs only the files named here,
 * one after another, each checked below before anything runs.
 */
export const NATIVE_PREREQUISITE_FILES = [
	"test/native-prerequisites.test.ts",
	"test/abort-effect.test.ts",
	"test/pi-durable-run-identity.test.ts",
	"test/cua-native-authority.test.ts",
	"test/approvals.test.ts",
	"test/tasks.test.ts",
];

/** What no file here may name: the tests' Chrome and the binding behind it, or live checks. */
const OUTSIDE = /\btestBrowser\b|\bpairTestComputer\b|\bBROWSER\b|\bbrowserRendering\b|\bPIM_LIVE\b|test\/live\//;

if (process.env.PIM_LIVE !== undefined) throw new Error("This lane has no live mode: unset PIM_LIVE to run it.");
for (const file of NATIVE_PREREQUISITE_FILES) {
	const named = OUTSIDE.exec(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
	if (named) throw new Error(`${file} names ${named[0]}, which this lane doesn't run.`);
}

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./test/worker.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			// No `browserRendering`, and no preview objects: nothing here can start the tests' Chrome.
			miniflare: { bindings: testBindings },
		}),
	],
	test: {
		testTimeout: 20_000,
		include: NATIVE_PREREQUISITE_FILES,
		fileParallelism: false,
		// A file that finds a Browser Run binding fails before its tests run.
		setupFiles: ["./test/standin-lane.ts"],
	},
});
