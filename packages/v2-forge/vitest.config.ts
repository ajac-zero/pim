import { defineConfig } from "vitest/config";

// Its own config, so the root's Worker projects aren't picked up. Tests share one real PostgreSQL (test/pg.ts), so files run one at a time.
export default defineConfig({ test: { globalSetup: ["test/global-setup.ts"], include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 120_000, fileParallelism: false } });
