# Sandbox pools

A sandbox pool is a named group of coding sandboxes a deployment offers coding threads. Each pool names a provider (a workspace backend's id, such as `compose` or `cloudflare`; several pools may share one provider), a `size` (how many threads may hold a slot in it at once), a `priority` (the thread takes the lowest number first), a `config` object kept as given, and whether it is `enabled`. Pools are kept by the admin in the Gallery's `sandbox_pools` table, like its compute providers (`src/gallery.ts`), and every write is kept in the admin's audit trail of structured events (`pim.sandbox_pool_added`, `…_changed`, `…_removed`).

A deployment starts with two pools, put in once when the registry is first used and never again, so the admin's changes stay theirs: a `compose` pool (the local sandbox manager, size 2, priority 1) and a `cloudflare` pool (Cloudflare Containers, size 2, priority 2). They are checked in at `src/coding/pools-default.ts`; even emptying the table is not filled back in.

`resolvePools(storedPools, availableProviders)` (`src/coding/pools.ts`) orders the pools for placement: the enabled ones whose provider is among those available, the lowest `priority` first and ties by id. Every pool left out comes with its reason: `disabled`, or `provider_unavailable` when the deployment has no such provider.

Placement reads the registry: a coding thread asks its space's scheduler for a slot in a pool, and the scheduler counts its slots per pool id, each pool's `size` its limit, capped by its provider's own (the space's, or the workspace manager's as its `/health` reports). A thread without a pin walks the pools in their order of priority, taking the first with room and moving on to the next when one is full; `pool` on a thread's start pins it to one pool by its id, and `provider` to a provider's first pool (`docs/coding-api.md`). The thread's status says where it was placed and why in `placement`, next to the plainer `placementReason`.

When the registry has no pool a thread can use — none enabled, or none naming a provider the deployment has — placement falls back to exactly what it did before pools: one pool per available provider, its id the provider's, limited as the provider was. A deployment whose Gallery rows never made it keeps working.

## Environment snapshots

A prepared environment's snapshot is made by one pool's provider and may not restore on another's, so snapshots are kept per pool ([coding-environment.md](coding-environment.md)). The environment's key covers the pool's id, except for the first pool of each provider (by priority, then id, among all stored pools, enabled or not), which keeps the keys made before pools: those snapshots stay where they were made, and nothing is migrated. A pool with no registry row, as in the fallback of one pool per provider, is its provider's first.

A thread placed in a pool restores only that pool's snapshot. When the pool has none, such as after a thread overflowed to it, the thread cold-provisions through the normal setup, never failing for the missing snapshot, and then keeps that pool's snapshot, if restoring it is expected to take less time than the setup did. The thread's `environment` says in `pool` whose snapshot it is and in `readyFrom` whether it was restored (`snapshot`) or cold-provisioned (`setup`). The guess of starting a new thread from the repository's newest snapshot is made only in a provider's first pool, and a pool sharing its provider with others deletes only its own snapshot when one isn't worth keeping.

## Unhealthy pools

Each space’s scheduler keeps a persisted circuit breaker per pool, independent of other pools even when they share a provider. Three consecutive infrastructure failures while finding, creating or starting a workspace (including an unreachable provider, start errors and timeouts) open the pool for five minutes. A successful workspace start resets the count. Capacity and low-disk refusals, quota refusals, and repository or harness setup failures do not count. The thresholds are constants in `src/coding/pool-breaker.ts`, not deployment flags.

Placement walks past an open pool and reports `unhealthy` in `placement.skipped`. A thread pinned there queues with reason `unhealthy`, subject to the usual queue deadline. After the cooldown the pool is half-open: admission reserves one probe thread, even across a scheduler restart. Success closes the breaker and admits the queue normally; failure opens it for another five minutes. A cancelled or capacity-refused probe releases its reservation and waits another cooldown without increasing the failure count. The scheduler’s alarm retries queued threads after the cooldown; it does not move already running workspaces. Open breakers do not trigger the empty-registry provider fallback.

## Waiting for capacity

All pools share one FIFO queue, ordered by request time and then insertion order. Each entry may take only its named pool or overflow pools: an older pin to a full pool does not block unrelated free pools, and a newer pin or resumed thread cannot jump ahead of an older entry eligible for the same slot. Pool priority orders placement choices, not queue entries.

The queue deadline is a fixed 30 minutes, not a deployment flag. The scheduler's alarm removes expired entries and durably delivers their notices. On timeout the thread records the reason `no_capacity`, an actionable message naming the pools and their skip reasons (`full`, `unhealthy`, or `disabled`; unavailable providers are also identified), and a `thread.no_capacity` event. It automatically requeues at the back for one more 30-minute window. While retrying it stays `queued` with `stateReason: "no_capacity"`. After the second timeout it is `failed` with that reason and notifies its parent/chat through the normal failure event. Admission resets the timeout count; manually continuing a failed thread starts a fresh pair of windows.

## Idle workspaces

A thread with no turn, pending input, or environment rebuild suspends its workspace after a fixed two-minute idle grace. Its Durable Object keeps a durable wake for the grace deadline. The checkout is kept by suspension when supported, or as a retained volume and saved work otherwise. A steer reacquires a slot through the same FIFO queue before resuming; suspension does not finish or archive the thread. Running turns and pending inputs, including retry backoff, are not idle.

Every slot release admits and notifies the next eligible queued thread immediately. Failed notices remain in the durable outbox. The scheduler also ticks every 30 seconds while the queue is non-empty (or idle/waiting slots or notices remain), sweeping idle slots past the same two-minute grace and reevaluating admission, so a missed thread wake cannot strand the queue.
