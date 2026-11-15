import { defineConfig } from "vitest/config";

// Its own config, so the root's Worker projects aren't picked up from the directory above.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
