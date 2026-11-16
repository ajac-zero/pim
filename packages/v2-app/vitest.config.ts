import { defineConfig } from "vitest/config";

// Its own config, so the root's Worker projects aren't picked up. The tests start a real PostgreSQL once, in a global setup, and each file gets its own database.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 120_000, globalSetup: ["test/support/postgres.ts"], fileParallelism: false } });
