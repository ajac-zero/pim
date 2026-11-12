# Sandbox pools

A sandbox pool is a named group of coding sandboxes a deployment offers coding threads. Each pool names a provider (a workspace backend's id, such as `compose` or `cloudflare`; several pools may share one provider), a `size` (how many threads may hold a slot in it at once), a `priority` (the thread takes the lowest number first), a `config` object kept as given, and whether it is `enabled`. Pools are kept by the admin in the Gallery's `sandbox_pools` table, like its compute providers (`src/gallery.ts`), and every write is kept in the admin's audit trail of structured events (`pim.sandbox_pool_added`, `…_changed`, `…_removed`).

A deployment starts with two pools, put in once when the registry is first used and never again, so the admin's changes stay theirs: a `compose` pool (the local sandbox manager, size 2, priority 1) and a `cloudflare` pool (Cloudflare Containers, size 2, priority 2). They are checked in at `src/coding/pools-default.ts`; even emptying the table is not filled back in.

`resolvePools(storedPools, availableProviders)` (`src/coding/pools.ts`) orders the pools for placement: the enabled ones whose provider is among those available, the lowest `priority` first and ties by id. Every pool left out comes with its reason: `disabled`, or `provider_unavailable` when the deployment has no such provider.

Nothing reads the registry yet. Placement still runs as it did: one pool per provider, ordered by the provider kinds' roles, and `pool` on a thread's start names its provider's id (`docs/coding-api.md`). A later change wires `resolvePools` into the thread loop.
