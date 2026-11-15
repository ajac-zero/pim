import { defineConfig } from "vitest/config";

// Its own config, so the root's Worker projects aren't picked up from the directory above. The timeout is the root's Node project's: waits poll for the real condition, and a starved 2-vCPU CI runner can be slow.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 60_000 } });
