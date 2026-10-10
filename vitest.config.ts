import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const live = process.env.PIM_LIVE === "1";

export default defineConfig({
	test: {
		testTimeout: 20_000,
		projects: [
			{
				extends: true,
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
					name: "self-hosted",
					// Live checks against real third-party servers need the network: `pnpm test:live`.
					include: live ? ["test/live/**/*.test.ts"] : ["test/*.test.ts"],
				},
			},
			// Pimling has no live checks of its own.
			...(live ? [] : [{
				extends: true,
				plugins: [
					cloudflareTest({
						// Pimling's Worker, with the same faux-model Pim.
						main: "./test/hosted/worker.ts",
						wrangler: { configPath: "./wrangler.hosted.jsonc" },
						remoteBindings: false,
						// PIM_API_TOKEN is set to check that hosting never accepts it.
						miniflare: {
							bindings: { PIMLING_DOMAIN: "pimling.test", PIMLING_ADMIN_TOKEN: "admin-token", PIMLING_REGISTRATION: "open", PIM_API_TOKEN: "env-token" },
						},
					}),
				],
				test: {
					name: "hosted",
					include: ["test/hosted/*.test.ts"],
				},
			}]),
		],
	},
});
