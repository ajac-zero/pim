import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { testBindings } from "./vitest.bindings";

const live = process.env.PIM_LIVE === "1";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// The real Worker, with a Pim that talks to pi-ai's faux provider instead of Workers AI.
			main: "./test/worker.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			miniflare: {
				// The preview's own Pim and Directory (preview/worker.ts), for its Cua fixture's and evaluation mode's tests only; a deployment has no such binding.
				durableObjects: { PREVIEW_PIM: { className: "PreviewPim", useSQLite: true }, PREVIEW_DIRECTORY: { className: "PreviewDirectory", useSQLite: true } },
				// A local Chrome, which the tests' computers browse with (test/helpers.ts's `testBrowser`).
				browserRendering: { binding: "BROWSER" },
				bindings: testBindings,
			},
		}),
	],
	test: {
		testTimeout: 20_000,
		// Live checks against real third-party servers need the network: `pnpm test:live`.
		include: live ? ["test/live/**/*.test.ts"] : ["test/*.test.ts"],
	},
});
