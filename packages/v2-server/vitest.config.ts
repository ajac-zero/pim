import { defineConfig } from "vitest/config";

// Its own config, so the root's Worker projects aren't picked up from the directory above. The tests share one local PostgreSQL cluster, started by the runtime's global setup; each file creates its own database. They need nats-server on PATH too.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		globalSetup: ["../v2-runtime/test/support/global-setup.ts"],
		fileParallelism: false,
	},
});
