import { defineConfig } from "vitest/config";

// Its own config, so the root's Worker projects aren't picked up from the directory above. The tests share one local PostgreSQL cluster, started by the runtime's global setup; each file creates its own database. They need nats-server on PATH too.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		// A deployment's default is that the person's majordomo answers approvals; these tests answer them by hand, and the ones about the majordomo's review choose that policy themselves.
		env: { PIM_APPROVAL_POLICY: "explicit" },
		globalSetup: ["../v2-runtime/test/support/global-setup.ts", "test/support/template-setup.ts"],
		// Files run side by side, each in its own database copied from a template. Two workers on a 2-CPU orb, four on a 4-vCPU CI runner.
		maxWorkers: Number(process.env.PIM_V2_TEST_WORKERS ?? 2),
	},
});
