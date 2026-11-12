import { HttpError } from "../http";

/**
 * Sandbox pools: the named groups of coding sandboxes a deployment offers
 * coding threads, kept by the admin in the Gallery (`sandbox_pools`). A pool
 * names a provider (a workspace backend's id, such as "compose" or
 * "cloudflare"; several pools may share one), how many threads may run in it
 * at once, and where it stands among the others: lower `priority` first.
 *
 * Placement reads the registry through `placementPools`: the coding
 * scheduler counts its slots per pool (./scheduler.ts), and a thread asks for
 * a slot in a pool, which may be one of several on one provider.
 */

/** A pool as the admin keeps it, in the Gallery's `sandbox_pools` table. */
export type SandboxPool = {
	/** Its name, a slug the admin chooses, such as "compose" or "cloudflare-2". */
	readonly id: string;
	/** The workspace backend it runs on (a `WorkspaceProvider.id`), such as "compose" or "cloudflare". Several pools may share one. */
	readonly provider: string;
	/** How many coding threads may hold a slot in it at once. */
	readonly size: number;
	/** Where it stands among the pools: the thread takes the lowest number first. */
	readonly priority: number;
	/** Whatever else the pool's provider takes, kept as given and unused yet. */
	readonly config: Readonly<Record<string, unknown>>;
	/** Whether coding threads may be placed in it. A pool switched off stays kept. */
	readonly enabled: boolean;
};

/** What adding or changing a pool gives; a field left out keeps what it was. */
export type SandboxPoolInput = {
	readonly id?: unknown;
	readonly provider?: unknown;
	readonly size?: unknown;
	readonly priority?: unknown;
	readonly config?: unknown;
	readonly enabled?: unknown;
};

/** The most threads one pool may hold at once. */
export const MAX_POOL_SIZE = 1000;

/** The most either id may be. */
const MAX_ID = 40;

/** A pool or provider id: lowercase letters, digits and single hyphens inside, such as "cloudflare-2". */
const isSlug = (value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= MAX_ID;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const slug = (value: unknown, field: string): string => {
	if (typeof value !== "string" || !isSlug(value.trim())) throw new HttpError(400, `${field} must be a slug: lowercase letters, digits and single hyphens inside, at most ${MAX_ID} characters`);
	return value.trim();
};

const whole = (value: unknown, field: string, min?: number): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || (min !== undefined && value < min)) {
		throw new HttpError(400, min === undefined ? `${field} must be a whole number` : `${field} must be a whole number of at least ${min}`);
	}
	return value;
};

/** Checks a new pool, or a change to `existing`, and returns it as it will be kept. */
export function prepareSandboxPool(input: SandboxPoolInput, existing: SandboxPool | null): SandboxPool {
	const id = input.id === undefined ? existing?.id : slug(input.id, "id");
	if (id === undefined) throw new HttpError(400, "id is required");
	if (existing && id !== existing.id) throw new HttpError(400, "A pool's id cannot be changed. Remove it and add another instead.");
	const provider = input.provider === undefined ? existing?.provider : slug(input.provider, "provider");
	if (provider === undefined) throw new HttpError(400, "provider is required");
	const size = input.size === undefined ? existing?.size : whole(input.size, "size", 1);
	if (size !== undefined && size > MAX_POOL_SIZE) throw new HttpError(400, `size must be at most ${MAX_POOL_SIZE}`);
	if (size === undefined) throw new HttpError(400, "size is required");
	const priority = input.priority === undefined ? existing?.priority : whole(input.priority, "priority");
	if (priority === undefined) throw new HttpError(400, "priority is required");
	const config = input.config === undefined ? (existing?.config ?? {}) : readConfig(input.config);
	if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
	return { id, provider, size, priority, config, enabled: (input.enabled as boolean | undefined) ?? existing?.enabled ?? true };
}

function readConfig(value: unknown): Readonly<Record<string, unknown>> {
	if (!isObject(value)) throw new HttpError(400, "config must be an object");
	return value;
}

/** How pools stand against each other: the lowest priority first, ties by id. */
export const comparePools = (a: SandboxPool, b: SandboxPool) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Whether `pool` keeps its provider's environment snapshots from before they
 * were kept per pool (`environmentKey`): the provider's first pool among all
 * the stored ones, enabled or not, so switching a pool off moves nothing. A
 * pool the registry doesn't have, as in the fallback of one pool per
 * provider, is its provider's only one.
 */
export function ownsLegacySnapshots(pool: { readonly id: string; readonly provider: string }, storedPools: readonly SandboxPool[]): boolean {
	const first = [...storedPools].filter((each) => each.provider === pool.provider).sort(comparePools)[0];
	return first === undefined || first.id === pool.id || !storedPools.some((each) => each.id === pool.id);
}

/** Why a pool was left out of the ones coding threads may be placed in. */
export type PoolSkipReason = "disabled" | "provider_unavailable" | "unhealthy";

/** A pool placement won't use, and why. */
export type SkippedPool = { readonly pool: SandboxPool; readonly reason: PoolSkipReason };

/** What `resolvePools` found: the pools to place threads in, in order, and the rest with why. */
export type ResolvedPools = {
	/** The enabled pools whose provider is available, the lowest priority first, ties by id. */
	readonly pools: readonly SandboxPool[];
	/** Every pool left out, with why: switched off, or naming a provider the deployment doesn't have. */
	readonly skipped: readonly SkippedPool[];
};

/**
 * Orders the stored pools for placement: the enabled ones whose provider is
 * among `availableProviders` (workspace backend ids, such as the registry's),
 * the lowest priority first and ties by id; every pool left out comes with
 * why. Pure: placement calls it with what it reads.
 */
export function resolvePools(storedPools: readonly SandboxPool[], availableProviders: readonly string[]): ResolvedPools {
	const available = new Set(availableProviders);
	const ordered = [...storedPools].sort(comparePools);
	const pools: SandboxPool[] = [];
	const skipped: SkippedPool[] = [];
	for (const pool of ordered) {
		if (!pool.enabled) skipped.push({ pool, reason: "disabled" });
		else if (!available.has(pool.provider)) skipped.push({ pool, reason: "provider_unavailable" });
		else pools.push(pool);
	}
	return { pools, skipped };
}

/** A pool as placement sees it: its id, the provider behind it, how many slots it holds, and where it stands among the pools. */
export type PlacementPool = {
	/** Its id: what a thread names to pin itself to it, and what the scheduler counts its slots by. */
	readonly id: string;
	/** The workspace backend it runs on; several pools may share one. */
	readonly provider: string;
	/** How many coding threads may hold a slot in it at once; null when the provider's own limit decides, as while one provider is one pool. */
	readonly size: number | null;
	/** Where it stands among the pools: the thread takes the lowest number first. */
	readonly priority: number;
};

/**
 * The pools a thread may take a slot in, and the ones it can't and why: the
 * registry's (`resolvePools`) when it has usable pools, and otherwise one per
 * available provider, its id the provider's, in the registry's order —
 * exactly as placement ran before pools, when a pool was its provider. A
 * deployment whose registry has no usable pools, such as one whose Gallery
 * rows never made it or whose pools name providers it doesn't have, places
 * threads as it always did.
 */
export function placementPools(storedPools: readonly SandboxPool[], availableProviders: readonly string[]): { readonly pools: readonly PlacementPool[]; readonly skipped: readonly SkippedPool[] } {
	const resolved = resolvePools(storedPools, availableProviders);
	if (resolved.pools.length > 0) return { pools: resolved.pools, skipped: resolved.skipped };
	return {
		pools: availableProviders.map((provider, index) => ({ id: provider, provider, size: null, priority: index + 1 })),
		skipped: resolved.skipped,
	};
}

/**
 * Keeps a write to the pools in the admin's trail of structured events, as
 * its routes do for every admin write (../accounts.ts): what changed, and who
 * by, as the admin's owner id.
 */
export function auditPoolWrite(action: "added" | "changed" | "removed", pool: string, by: string): void {
	console.log(JSON.stringify({ event: `pim.sandbox_pool_${action}`, pool, by }));
}

/** A pool's config with every value that looks like a credential left out, for the admin's view. */
export function publicPoolConfig(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(config).filter(([key]) => !/secret|token|key|password|credential|auth/i.test(key)));
}

/** Where a pool's circuit breaker stands: `open` while cooling down, `half_open` once the cooldown is over and a probe may go. */
export type PoolHealth = "healthy" | "open" | "half_open";

/** A pool's live state in one space's scheduler. */
export type PoolLiveState = {
	/** Slots threads hold in the pool now. */
	readonly held: number;
	/** Queued threads that named the pool. */
	readonly queued: number;
	readonly breaker: { readonly state: PoolHealth; readonly retryAt: number | null };
};
