import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { testBindings } from "./vitest.bindings";

/**
 * The Cua prerequisite lane (docs/cua-prerequisite-tests.md): the native-call
 * binder's and the observation ledger's tests, and nothing else, one file
 * after another. Both are stand-ins in the test's own runtime: an in-memory
 * authority and storage for the binder, and requests built in the test for
 * the ledger's admission check. It is the Cua stand-in lane's configuration
 * (vitest.cua-standin.config.ts), unchanged but for its files: no Browser
 * Run binding, no live mode, no remote bindings, and the same check of each
 * file and the same setup file before anything runs.
 */
export const CUA_PREREQUISITE_FILES = ["test/cua-native-identity.test.ts", "test/cua-observation.test.ts"];

/** What no file in the lane may name: the tests' Chrome and the binding behind it, or live checks. As the stand-in lane's. */
const OUTSIDE_THE_LANE = /\btestBrowser\b|\bpairTestComputer\b|\bBROWSER\b|\bbrowserRendering\b|\bPIM_LIVE\b|test\/live\//;

if (process.env.PIM_LIVE !== undefined) throw new Error("The Cua prerequisite lane has no live mode: unset PIM_LIVE to run it.");
for (const file of CUA_PREREQUISITE_FILES) {
	const named = OUTSIDE_THE_LANE.exec(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
	if (named) throw new Error(`${file} names ${named[0]}, which the Cua prerequisite lane doesn't run; take it out of the lane or the lane out of it.`);
}

export default defineConfig({
	plugins: [
		cloudflareTest({
			// The real Worker, with a Pim that talks to pi-ai's faux provider, as in vitest.config.ts.
			main: "./test/worker.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			miniflare: {
				// As the stand-in lane's Worker, so that both lanes load the same Worker. No `browserRendering`: the lane has no Chrome.
				durableObjects: { PREVIEW_PIM: { className: "PreviewPim", useSQLite: true }, PREVIEW_DIRECTORY: { className: "PreviewDirectory", useSQLite: true } },
				bindings: testBindings,
			},
		}),
	],
	test: {
		testTimeout: 20_000,
		include: CUA_PREREQUISITE_FILES,
		// One file at a time, and a file that finds a Browser Run binding fails before its tests run.
		fileParallelism: false,
		setupFiles: ["./test/standin-lane.ts"],
	},
});
