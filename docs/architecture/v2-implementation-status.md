# v2 implementation status

What `pim/v2-canonical` implements of the audit ([rearchitecture-foundations-audit.md](rearchitecture-foundations-audit.md), inventory in `inventory/`), where it is tested, and what is not proven. Written at the integration of all six workstreams; read the gaps before relying on a claim.

**What "tested" means here.** Each module's own tests run against a real PostgreSQL (and, where named, NATS, an S3-protocol server, real WebSockets, real processes). The cross-module claims are tested in `packages/v2-server/test/`. **Coverage is mapped by inventory group, not by entry**: the audit lists 162 entries and this document has not walked each one to a test. Doing that is open work (see [What is not proven](#what-is-not-proven)).

## The processes

`@pim/v2-server` (`node --import tsx src/main.ts <role>`, image `deploy/Dockerfile.v2`) runs `migrate`, `gate`, `live`, `runner`, `forge`, `canvas`, `relay`, `maintenance` or `all-in-one` from `loadProcessConfig`. Each serves `/healthz`, `/readyz` and `POST /drain` on `PIM_HTTP_PORT` and Prometheus metrics on `PIM_METRICS_PORT`; with `PIM_INGRESS_SECRET` set it refuses requests that lack the proxy's header. Each process connects as its own database role (`pim_gate`, `pim_runtime`, `pim_live`, `pim_forge`, `pim_maintenance`), none a superuser or `BYPASSRLS`.

| Role | Runs |
|---|---|
| `gate` (also `canvas`, `relay`) | The application API and sockets (`@pim/v2-app`), the projections' snapshots at `/api/snapshot/**`, Forge's coding API at `/api/coding/**`; publishes revocations on Pulse; carries a decided approval to the runtime. |
| `live` | WebSocket at `/api/ws`, snapshots at `/snapshot/**`, the projector (runtime commits and Forge's feed, woken by `pg_notify` and polling). |
| `runner` | The runtime's `Runner` and the command relay (Gate's inbox to the runtime's). Not ready until any restore has been reconciled (`pim_ops.ops_restore`). |
| `forge` | Forge's pool and connectivity. Steps no threads yet (see gaps). |
| `maintenance` | Moves Forge's wakes into the chats that started threads (`coding_wake`) and Forge's spend into the cost ledger. |

How the schemas are joined (migrations `0600`–`0602` in `packages/v2-server/migrations`, one ledger, one migrator):

- **Gate to runtime:** the Gate admits a command into `pim_app.command_inbox` (202 at once). The Runner's relay claims it through `pim_app.relay_claim` (a `SECURITY DEFINER` function), creates the chat's family partition and conversation under the application's ids, hands the command to the runtime's inbox, and marks it `runtime_committed` once pi has taken it.
- **Runtime to Live:** `runtimeOutboxSource` turns commits (receipts, outbox references, the live document) into projected events; partials are replaced by the final message.
- **Forge to Live and to the runtime:** Forge's outbox is numbered per owner without gaps (`0601`), projected as coding topics, and its wakes and costs delivered.
- **Live's identity:** two `SECURITY DEFINER` functions (`live_authenticate`, `live_valid`) give `pim_live` a credential's owner and validity without any grant on `pim_app`.

## Inventory groups

| Group | Implemented in | Tested in |
|---|---|---|
| **B1** identity, auth, sharing, public surface | `@pim/v2-app`: accounts, WebAuthn passkeys (EdDSA/ES256/RS256), setup, recovery and device links, Google/GitHub/OIDC, MCP OAuth 2.1, sessions and tokens, `Authorizer`, circles, shared chats, people, bots, visits. Live's `AppLiveIdentity`. | `v2-app/test/{auth,security,domain,surfaces}.test.ts`; `v2-server/test/vertical-slice.test.ts` (passkey registration and sign-in over the Gate, shared-chat page). |
| **B2** conversations, agents, approvals | `@pim/v2-runtime` (storage on `pi-durable` 1.1.0, partitions, fenced leases, Runner, signals, inbox, legacy family splitter); `@pim/v2-app` conversations, agents, approvals; the command relay. | `v2-runtime/test/*` (69 tests: storage conformance, fencing, ambiguous commit, early signals, drain); `v2-server/test/vertical-slice.test.ts` (admit, stream, park for approval, drain mid-turn, fail over under a newer epoch, decide, resume). |
| **B3** memory, triggers, models, notifications | `@pim/v2-app` memories, schedules, triggers (over `@pim/triggers`), providers (sealed keys), usage; `Usage` also records coding spend. | `v2-app/test/domain.test.ts`; `vertical-slice` (coding spend in `/api/usage/costs`). Notifications and push delivery are **not** implemented in v2. |
| **B4** files, apps, computer | `@pim/v2-app` objects (S3 with ranges), Canvas (Yjs with fenced leases), Relay (`pimc_` protocol 1 and 2, hosted-app proxy), apps. | `v2-app/test/{files,relay,surfaces}.test.ts` (including s3rver). |
| **B5** coding | `@pim/v2-forge`: threads, scheduler, grants, standing approvals, harness ports, Amp adapter, HTTP handlers. Joins in `@pim/v2-server`. | `v2-forge/test/*` (103); `v2-server/test/{forge-bridge,vertical-slice}.test.ts` (grant, 403 and 503 paths, standing approval, wake, spend, sidebar). |
| **B6** deployment, storage | `@pim/v2-contracts` (platform, migrations bands), `@pim/v2-ops` (migration, backup, observability, bench), `deploy/` (Compose, Kubernetes, observability), `deploy/Dockerfile.v2`. | `v2-ops/test/*` (48); `v2-server/test/entrypoint.test.ts` (migrate across all bands into one ledger, role isolation, health, metrics, ingress secret, restore gate, real OS processes, SIGTERM). |
| **C** cutover fence | `@pim/v2-ops` fence Worker, exporter, importer, auditor. | `v2-ops/test/{fence,migration,backup}.test.ts`. |

Measured benchmark numbers are in [../v2-operations.md](../v2-operations.md#verification-status) (5, 50, 500 and 1,000 active streaming runs on a 4-vCPU sandbox; 1,000 runs is about that machine's limit, commit p99 0.28 s with batching). **Their Runner is a reference write path, not the Pim Runner**, so they bound PostgreSQL, Node and NATS under that pattern and say nothing about the real Runner's cost.

## What is not proven

- **No Docker daemon here.** `deploy/Dockerfile.v2` and the Compose stack were never built or started; the manifests pass `kubeconform` and the repository's tests but were never applied. Production-dependency installation and `node --import tsx src/main.ts` were checked outside Docker.
- **CloudNativePG, OpenBao, gVisor, Barman WAL archiving to object storage, failover and restore on a live cluster:** not run.
- **Interactive vendor CLI OAuth** (Claude Code, Codex, Mistral Vibe, Amp logins) in a browser: not run.
- **Relay across processes.** The Relay holds a computer's socket in the process it connected to. `canvas` and `relay` containers run the Gate's code, so a Gate and a Relay in separate containers cannot reach each other's computers: there is no cross-process hop yet, and none was tested. `all-in-one`, or one Gate that all computer traffic reaches, works.
- **Agent models and tools in the Runner.** The `runner` role takes its model providers and tool registry from the deployment (`Hooks`); none are configured by default, so a bare Runner can host chats but its agents have no model. The vertical slice injects a scripted model and one tool; the legacy extensions (memory, browser, files, triggers' tools, `coding_*` tools) are not ported to v2 tools.
- **Forge's worker is not wired.** The `forge` role assembles Forge but has no compute provider, git host or vendor CLI ports configured, so no thread runs on its own; the vertical slice completes one by writing what a worker writes. Forge's HTTP surface on the Gate is `codingRest` only (the git broker, model gateway, vault and Gitea handlers are not mounted).
- **Importer targets.** `@pim/v2-ops` imports into `pim_ops` landing tables. They are **not** bridged to `pim_app`, `pim_runtime` or `pim_forge`: the importer does not yet create accounts, conversations or Forge threads there. A rehearsal on a real export has not been done.
- **Two stores of coding grants.** The application has coding grants and standing approvals in `pim_app`; Forge enforces its own in `pim_forge`. Only Forge's are consulted by coding routes. Forge's tables also carry no row-level security (every query names its owner; the Gate holds a grant on them).
- **Ids.** The application chooses a chat's partition and public id; pi allocates numeric conversation ids, so `pim_app.conversations.conversation_id` is a provisional number that the relay does not write back. The runtime's directory is the source of truth. Forge accepts owner ids that are not `o_…`; Live skips them.
- **Approvals.** A Gate decision wakes the parked task. An approval's timeout sweep (`Approvals.sweep`) does not yet deliver a decision to the runtime.
- **Drain leaves a trace.** A Runner drained mid-answer leaves pi's aborted assistant message in the transcript; the next Runner's turn follows it.
- **Two ledgers of external operations** (`pim_app.external_operations`, `pim_runtime` migration 0106) and a third in `pim_ops`: unreconciled.
- **Retention.** Forge's `projection` outbox rows are read by Live and never marked delivered; no job trims them.
- **Per-entry coverage.** Every one of the audit's entries has not been traced to a test (see above).
