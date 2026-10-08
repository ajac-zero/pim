import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// The real Worker, with a Pim that talks to pi-ai's faux provider instead of Workers AI.
			main: "./test/worker.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			// An 8-line memory view, so a few dozen memories exercise every level of the tree.
			miniflare: { bindings: { PIM_API_TOKEN: "test-token", PIM_TIME_ZONE: "America/New_York", PIM_MEMORY_LINES: "8" } },
		}),
	],
	test: {
		testTimeout: 20_000,
		// Live checks against real third-party servers need the network: `pnpm test:live`.
		include: process.env.PIM_LIVE === "1" ? ["test/live/**/*.test.ts"] : ["test/*.test.ts"],
	},
});
