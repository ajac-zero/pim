import { defineConfig } from "vitest/config";

// The root's Node tests: the computer's supervisor of apps, displays and triggers, which start real processes
// (computer/test), and the repository's own scripts and import rules (scripts/*.test.ts). The packages' tests
// are in packages/*/test (`pnpm test:packages`) and the web app's in web/.
// Their waits poll for the real condition with a 30 s deadline, so a starved 2-vCPU CI runner can be slow without
// failing; the test timeout is above it.
export default defineConfig({
	test: {
		name: "node",
		testTimeout: 60_000,
		// At most two test files at once, as a 2-vCPU sandbox holds.
		maxWorkers: 2,
		include: ["computer/test/**/*.test.ts", "scripts/*.test.ts"],
	},
});
