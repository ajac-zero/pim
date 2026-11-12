import type { SandboxPool } from "./pools";

/**
 * The sandbox pools a deployment starts with, put in once when its registry
 * is first used and never again, so the admin's changes stay theirs
 * (src/gallery.ts): the local sandbox manager first with room for two, and
 * Cloudflare Containers behind it for the threads it has no room for.
 */
export const DEFAULT_POOLS: readonly SandboxPool[] = [
	{ id: "compose", provider: "compose", size: 2, priority: 1, config: {}, enabled: true },
	{ id: "cloudflare", provider: "cloudflare", size: 2, priority: 2, config: {}, enabled: true },
];
