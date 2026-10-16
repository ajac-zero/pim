import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const live = process.env.PIM_LIVE === "1";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// The real Worker, with a Pim that talks to pi-ai's faux provider instead of Workers AI.
			main: "./test/worker.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			// An 8-line memory view, so a few dozen memories exercise every level of the tree.
			// Open registration, so tests add people without invites unless they mean to.
			// The secrets of the test extension's bank app.
			miniflare: {
				bindings: {
					PIM_TIME_ZONE: "America/New_York",
					PIM_MEMORY_LINES: "8",
					PIM_REGISTRATION: "open",
					TEST_BANK_CLIENT_ID: "bank-client",
					TEST_BANK_CLIENT_SECRET: "bank-secret",
				},
			},
		}),
	],
	test: {
		testTimeout: 20_000,
		// Live checks against real third-party servers need the network: `pnpm test:live`.
		include: live ? ["test/live/**/*.test.ts"] : ["test/*.test.ts"],
	},
});
