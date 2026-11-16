# v2 canonical topology: who owns which files

The portable persistent-backend rearchitecture is built by six workstreams in parallel. Each owns a branch and a set of paths, so no two edit the same file. `pim/v2-canonical` is the shared base: every workstream rebases onto `origin/pim/v2-canonical` and implements against `@pim/v2-contracts`. The audit that scopes the work is in [rearchitecture-foundations-audit.md](rearchitecture-foundations-audit.md), with its inventory in `inventory/`.

## Ownership

| Branch | Owns | Builds |
| --- | --- | --- |
| `pim/v2-canonical` | `packages/v2-contracts/**`, `packages/v2-server/**`, `docs/architecture/**`, root wiring (`package.json`, `tsconfig`, `scripts/ci-scope.mjs`, `.github/workflows/ci.yml`) | Contracts, `0001_foundation.sql`, integration: the runtime source for Live's projector, cross-workstream grants, end-to-end tests |
| `pim/v2-runtime` | `packages/v2-runtime/**` | PostgreSQL pi-durable 1.1.0 storage, partition lease and epoch fencing, Steward, Dispatch and Runner lifecycle |
| `pim/v2-application` | `packages/v2-app/**` | Application ledger, RBAC, grants and standing approvals, tokens, sessions and envelope crypto, Gate HTTP API, agent features, Canvas, Relay, Objects |
| `pim/v2-live-ui` | `packages/v2-live/**`, `web/**` | Projections, NATS Pulse, cursor replay, Live WebSocket server, the live client |
| `pim/v2-forge` | `packages/v2-forge/**` | Coding control plane, coding grants, five harnesses, sandbox isolation, wake delivery |
| `pim/v2-operations` | `packages/v2-ops/**`, `deploy/**`, `scripts/v2-*/**` | Compose and Kubernetes manifests, observability, export and import migration, backup, multi-Runner and load harness |

The legacy Worker (`src/`, `packages/shared`, `packages/coding`, …) is not changed by any of them; v2 packages never import `src/`. A change that must touch a path it doesn't own goes through `pim/v2-canonical`.

## Dependencies

A v2 package imports `@pim/v2-contracts` and npm packages. It does not import another v2 package except where this table allows it: `v2-app`, `v2-live` and `v2-forge` may import `v2-runtime`'s public exports. `v2-contracts` imports nothing from Pim and nothing from Cloudflare.

`@pim/shared/live-client` (moved from `web/src/lib/`) is the Live protocol client the web app and Node callers, such as `v2-server`'s tests and the load harness, share; packages may not import `web/`.

## Joins

`@pim/v2-server` holds what connects workstreams, so none of them imports another's internals:

- **Runtime to Live:** `runtimeOutboxSource` turns the runtime's commits (receipts and outbox references) into the events Live projects.
- **Forge to Live:** `forgeOutboxSource` reads Forge's outbox, which migration 0601 numbers per owner without gaps, as a stream with a stable pseudo-partition id (`forgePartitionId`). `combineSources` gives the projector both.
- **Forge to the runtime:** `deliverForgeWakes` turns each `wake` row of Forge's outbox into a `coding_wake` command in the partition that holds the chat; the wake id is the command id.
- Forge's `cost_ledger` rows are left for the application ledger's consumer.

## Migrations

`packages/v2-contracts/migrations/0001_foundation.sql` creates the schemas `pim_app`, `pim_runtime`, `pim_forge` and `pim_projection`, one `NOLOGIN` role per process kind, the `public.pim_schema_migrations` ledger and `pim_current_owner_id()`, which row-level security policies compare with `owner_id`. A workstream keeps its migrations in its own package and numbers them in its band, writing only its own schema:

| Band | Owner | Schema |
| --- | --- | --- |
| 0001–0099 | canonical | all, foundation only |
| 0100–0199 | runtime | `pim_runtime` |
| 0200–0299 | application | `pim_app` |
| 0300–0399 | live | `pim_projection` |
| 0400–0499 | forge | `pim_forge` |
| 0500–0599 | operations | maintenance across schemas |
| 0600–0699 | canonical (`packages/v2-server/migrations`) | grants, numbering and functions across workstreams, applied last (`0600` Live reads the runtime, `0601` Live reads Forge) |

`validateMigrationFiles` in `src/db.ts` checks a directory against its band. Work for an owner goes through `withTenantTransaction`, which sets `pim.owner_id` with `SET LOCAL` semantics so PgBouncer in transaction mode never leaks it.

## Seams

- `identity.ts`, `authz.ts`: owners, partitions, principals, and the `Authorizer`, which keeps permission (`ForbiddenError`, `CapabilityUnavailableError`) apart from human approval (`ApprovalRequiredError`). Standing approvals and coding grants are records, never code paths.
- `runtime-seam.ts`: the command inbox, partition leases with epoch fencing, the outbox written in the runtime commit, and durable external operations.
- `live-seam.ts`: projection cursors, Pulse subjects and the WebSocket frames. NATS carries hints only, never state and never authorization.
- `forge-seam.ts`: deterministic coding thread ids, harness capabilities, and the wake envelopes into the agent's inbox.
- `platform.ts`: object store, envelope crypto and process roles.
