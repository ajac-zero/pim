import { defineConfig } from "vitest/config";

// Its own config, so the root's Worker projects aren't picked up from the directory above. Tests that start a real
// PostgreSQL get a generous timeout: initdb and a cold start take seconds on a 2-vCPU runner.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false } });
