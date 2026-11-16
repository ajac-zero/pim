import { defineConfig } from "vitest/config";

// Its own config, so the root's Worker projects aren't picked up from the directory above. Tests run against a real PostgreSQL that globalSetup starts; one database per test file.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 120_000, globalSetup: ["../core/test/support/global-setup.ts"], fileParallelism: false } });
