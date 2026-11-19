import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Its own config, so the root's is not picked up from the directory above. Tests that start a real
// PostgreSQL get a generous timeout: initdb and a cold start take seconds on a 2-vCPU runner.
const timeouts = { testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false };

export default defineConfig({
	test: {
		projects: [
			{ test: { name: "node", include: ["test/**/*.test.ts"], exclude: ["test/fence.test.ts"], ...timeouts } },
			{
				// The fence Worker runs in workerd, with the Durable Objects of the legacy Worker's names and real SQLite storage.
				plugins: [
					cloudflareTest({
						main: "./src/fence-worker/index.ts",
						wrangler: { configPath: "./src/fence-worker/wrangler.jsonc" },
						remoteBindings: false,
						miniflare: { bindings: { FENCE_EXPORT_TOKEN: "fence-test-token-0123456789abcdef0123456789" } },
					}),
				],
				test: { name: "fence", include: ["test/fence.test.ts"], ...timeouts },
			},
		],
	},
});
