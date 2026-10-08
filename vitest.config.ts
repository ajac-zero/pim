import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// The real Worker, with a Pim that talks to pi-ai's faux provider instead of Workers AI.
			main: "./test/worker.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			miniflare: { bindings: { PIM_API_TOKEN: "test-token", PIM_TIME_ZONE: "America/New_York" } },
		}),
	],
	test: { testTimeout: 20_000 },
});
