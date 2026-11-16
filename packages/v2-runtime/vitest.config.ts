import { defineConfig } from "vitest/config";

// Its own config, so the root's Worker projects aren't picked up from the directory above. Test files share one local PostgreSQL cluster started in globalSetup; each file creates its own database.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		globalSetup: ["test/support/global-setup.ts"],
		fileParallelism: false,
	},
});
