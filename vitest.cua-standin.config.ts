import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { testBindings } from "./vitest.bindings";

/**
 * The Cua stand-in lane (docs/cua-standin-lane.md): the Cua transport,
 * bridge and relay, control state, runtime and viewer, and preview-fixture
 * tests together, one file after another, where every computer, bridge,
 * browser and model is a stand-in in the test's own runtime. Its Worker has
 * no Browser Run binding, so nothing in it can start the tests' Chrome; it
 * has no live mode and no remote bindings, and runs only the files named
 * here, each checked below before anything runs.
 */
export const CUA_STANDIN_FILES = [
	"test/cua.test.ts",
	"test/cua-bridge.test.ts",
	"test/cua-relay-qualification.test.ts",
	"test/computer-control.test.ts",
	"test/computer-control-runtime.test.ts",
	"test/computer-control-viewer.test.ts",
	"test/preview-cua-fixture.test.ts",
	"test/computer-native-handler.test.ts",
	"test/waits.test.ts",
	"test/pi-durable-run-identity.test.ts",
	"test/cua-native-identity.test.ts",
	"test/cua-native-authority.test.ts",
];

/** What no file in the lane may name: the tests' Chrome and the binding behind it, or live checks. */
const OUTSIDE_THE_LANE = /\btestBrowser\b|\bpairTestComputer\b|\bBROWSER\b|\bbrowserRendering\b|\bPIM_LIVE\b|test\/live\//;

if (process.env.PIM_LIVE !== undefined) throw new Error("The Cua stand-in lane has no live mode: unset PIM_LIVE to run it.");
for (const file of CUA_STANDIN_FILES) {
	const named = OUTSIDE_THE_LANE.exec(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
	if (named) throw new Error(`${file} names ${named[0]}, which the Cua stand-in lane doesn't run; take it out of the lane or the lane out of it.`);
}

export default defineConfig({
	plugins: [
		cloudflareTest({
			// The real Worker, with a Pim that talks to pi-ai's faux provider, as in vitest.config.ts.
			main: "./test/worker.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			miniflare: {
				// The preview's own Pim and Directory, for its Cua fixture's and evaluation mode's tests. No `browserRendering`: the lane has no Chrome.
				durableObjects: { PREVIEW_PIM: { className: "PreviewPim", useSQLite: true }, PREVIEW_DIRECTORY: { className: "PreviewDirectory", useSQLite: true } },
				bindings: testBindings,
			},
		}),
	],
	test: {
		testTimeout: 20_000,
		include: CUA_STANDIN_FILES,
		// One file at a time, and a file that finds a Browser Run binding fails before its tests run.
		fileParallelism: false,
		setupFiles: ["./test/standin-lane.ts"],
	},
});
