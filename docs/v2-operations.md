# Pim v2 operations

How Pim v2 is deployed, observed, migrated from the Cloudflare deployment, backed up and load-qualified. The code is in `packages/v2-ops/`, the manifests in `deploy/`, the command-line tools in `scripts/v2-*/`.
What was run, what was only read, and what is not yet proven is in [Verification status](#verification-status); read that before relying on a claim here.

## Layout

| Path | What it is |
|---|---|
| `packages/v2-ops/src/fence-worker/` | The inert maintenance and export Worker for the cutover (a separate entrypoint, never a product flag). |
| `packages/v2-ops/src/migration/` | Snapshot format, exporter, conversation-family split, quiescence plan, importer, checksum auditor, report. |
| `packages/v2-ops/src/backup/` | Physical base backup, point-in-time restore, post-restore safety pass. |
| `packages/v2-ops/src/observability/` | Redaction, Prometheus metrics, OpenTelemetry spans, event-loop and PostgreSQL pool signals. |
| `packages/v2-ops/src/bench/` | Multi-tenant load benchmark with a reference writer; `bench-results/` holds the measured runs. The integrated benchmark with the real processes is `packages/v2-server/test/integrated-bench.test.ts`, with its results in `packages/v2-server/bench-results/`. |
| `packages/v2-ops/sql/` | Migrations `0500`-`0599`: cutover record, external-operation ledger, due work, remote threads, import landing tables, role grants, restore fence. |
| `deploy/compose/`, `deploy/k8s/`, `deploy/observability/` | Compose stack, Kustomize manifests, Grafana dashboard, Prometheus rules, runbooks. |
| `scripts/v2-migrate/`, `scripts/v2-backup/`, `scripts/v2-bench/` | Entry points for the tools above. |

The package imports `@pim/v2-contracts` and nothing else from Pim, and nothing from `src/`. It is aligned with `origin/pim/v2-canonical` (`0ba6fd3`):

- **Migrations:** `src/pg/migrate.ts` runs canonical's `0001_foundation.sql` first, then this package's band (0500-0599), into canonical's ledger `public.pim_schema_migrations (number, name, checksum)`. Every directory is checked against its band with `validateMigrationFiles`; `scripts`/CLI `sql-migrate --dir runtime=...` adds other workstreams' directories. A file edited after it was applied is refused.
- **Schema:** operations has no schema in the contracts, so it creates `pim_ops` (0500). Its tables are the cutover record, the external-operation ledger, due work, remote threads, the restore fence and the **import landing tables** (identity, authentication, secrets, pi history, chats, objects, verbatim legacy rows). Landing tables use `owner_id`, the column canonical's row-level security policies compare with `public.pim_current_owner_id()`; they have no policies yet. When the application and runtime workstreams land their own tables in `pim_app` and `pim_runtime`, the importer's targets move there; the audit's checks stay the same.
- **Roles:** 0502 grants `pim_ops` to `pim_gate`, `pim_runtime`, `pim_live`, `pim_forge` and `pim_maintenance` as 0001 defines them (the Gate and Runner open secrets; Live and Forge never read `secret_envelopes`; only maintenance writes the cutover record and the restore fence).
- **Ids:** an owner id is `o_<chars>` (`OwnerId`): a legacy id that already has that shape is kept, any other is prefixed `o_` (recorded in `pim_ops.owner_map`, audited). A partition id is a UUID (`PartitionId`): a version-5 UUID of the owner and the family's label, so a re-import gives the same ids. Conversation 1 stays `ROOT_CONVERSATION_ID` in the owner's home partition.
- **Environment:** `PIM_ROLE`, `PIM_PUBLIC_URL`, `PIM_DATABASE_URL`, `PIM_APP_DATABASE_URL` and `PIM_FORGE_DATABASE_URL` (Runner only: its agent tools read the application and coding schemas through the gate and forge logins), `PIM_NATS_URL`, `PIM_S3_ENDPOINT`, `PIM_S3_BUCKET`, `PIM_S3_REGION`, `PIM_RUNNER_HOLDER_ID`, `PIM_POOL_<NAME>_MAX`, exactly as `loadProcessConfig` reads them; tests run every Compose service's and every Kubernetes Deployment's environment through it. Additions this package makes, which `loadProcessConfig` ignores: `PIM_S3_ACCESS_KEY`/`PIM_S3_SECRET_KEY`, `PIM_INGRESS_SECRET`, `PIM_KEK_*`, `PIM_METRICS_PORT`, `PIM_DRAIN_WINDOW_SECONDS`, `OTEL_*`.

## The role contract

One Pim image runs one role per container, chosen by `PIM_ROLE`: `gate`, `live`, `runner`, `forge`, `canvas`, `relay`, `maintenance` (`PIM_ROLE` of `@pim/v2-contracts`; the migrator is the one-shot SQL runner, not a role). Both deployments assume the same contract; the roles themselves belong to the other workstreams.

- `GET /healthz` (process is up) and `GET /readyz` (can serve) on `PIM_HTTP_PORT`; Prometheus metrics on `PIM_METRICS_PORT` (9464) at `/metrics`.
- Configuration is the environment listed above (`loadProcessConfig`), plus `PIM_CONTENT_ORIGIN`, `PIM_APPS_ORIGIN`.
- Envelope keys: `PIM_KEK_CURRENT` names the key that wraps new data keys; keys come from `PIM_KEK_<id>` (Compose) or files named `<id>` in `PIM_KEK_DIR` (Kubernetes).
- The Runner, on `SIGTERM` or `POST /drain`, stops claiming work and hands its partition leases back within `PIM_DRAIN_WINDOW_SECONDS` (90).
- A Runner must refuse to claim work while the newest row of `pim_ops.ops_restore` is not `reconciled`, and must never execute a `pim_ops.external_operations` row whose status is `needs_reconciliation`, nor a `pim_ops.pi_tasks` row with a `hold`.

## Compose (homelab)

A trial on one machine, over plain HTTP on `127.0.0.1:8088` (a browser treats `localhost` as secure, so passkeys work):

```sh
deploy/compose/init-env.sh http://localhost:8088 --image pim:v2-local   # writes deploy/compose/.env with random secrets and keys
docker build -f deploy/Dockerfile.v2 -t pim:v2-local .
deploy/compose/pim.sh up -d --wait          # caddy, postgres 17, pgbouncer, nats, seaweedfs, migrator, gate, live, runner, forge, maintenance
curl -s -X POST -H 'origin: http://localhost:8088' http://localhost:8088/auth/setup-link
deploy/compose/pim.sh logs gate | grep -o 'http[^ "]*#claim=[^ "]*'   # open it, make the admin's passkey, save the recovery codes
```

For a real hostname, run `init-env.sh https://pim.example.com` instead: `pim.sh` then uses `compose.yaml` alone and Caddy gets a certificate. `pim.sh` is `docker compose` with this directory's files (`compose.local.yaml` when the URL is `http://`, `compose.dev.yaml`, which mounts this checkout's sources, when `PIM_DEV=1`). A model: either connect one in Settings → Model (the ChatGPT plan sign-in, or a provider with an API key), or set `PIM_AI_GATEWAY_URL`, `PIM_AI_GATEWAY_KEY`, `PIM_AI_GATEWAY_MODELS` and `PIM_DEFAULT_MODEL` in `.env` for an OpenAI-compatible endpoint. Scale Runners with `pim.sh up -d --scale runner=3`; optional profiles are `canvas`, `local-computer`, `coding` and `observability`.

`scripts/v2-compose/smoke.sh` builds the image and boots the stack from nothing with a stand-in model (`scripts/v2-compose/fake-model.mjs`), then claims the first account, chats with the majordomo, parks and approves a tool call, round-trips an object, backs up, writes, restores and chats again; CI's `compose` job runs it on every push.

No Kubernetes, Temporal, Cloudflare or AWS service is involved. The core stack runs with every optional profile off. PostgreSQL runs with `fsync`, `full_page_writes` and `synchronous_commit` on, and nothing in the stack turns them off (a test fails if anything does). `postgres/init/00-roles.sh` creates the five NOLOGIN roles of `0001_foundation.sql` and one login per process kind (`pim_gate_login`, `pim_runtime_login`, `pim_live_login`, `pim_forge_login`, `pim_maintenance_login`), each a member of exactly its role, with the connection limit and the statement timeout that kind has in `DEFAULT_POOL_BUDGETS` (set on the role, since PgBouncer does not pass `statement_timeout` through), plus `pim_migrator`, the only role that creates objects (no login is superuser or `BYPASSRLS`); applications connect through PgBouncer in transaction mode, while the migrator and maintenance connect directly (advisory locks and long statements do not belong in transaction pooling). The proxy sets `X-Pim-Client-IP` and `X-Pim-Ingress-Secret` on every request, as the existing `celld` profile does.

The Gate serves the web app (`web/dist`, built into the image) and answers the v1 web app's routes through `packages/v2-server/src/compat/`, which are tried before the Gate's own routes. What the web app asks for and v2 does not have yet answers as empty or 501, never with invented data: see the deferred list in `docs/architecture/v2-implementation-status.md`.

## A computer on the same machine

A personal computer is how agents get a shell, files, a browser and a desktop: `computer/pim-computer.ts` dials out to the stack's public address (`/api/computer/connect`, WebSocket) with a `pimc_` token and answers the Relay's calls. It is **outside the control-plane security boundary**: it runs arbitrary commands, so it never gets a database, NATS, object-store, key-ring or control-plane credential, and nothing in the stack trusts it beyond what its own owner's space may do. Two ways to run one beside the stack; both pair the same way.

1. **Pair.** Sign in, open Settings → Computer, choose to connect a computer, and copy the `pimc_…` token (shown once; `POST /api/computer`). One person has one computer: pairing another replaces it.
2. **Run it, either:**
   - **Compose profile `local-computer`** (the stack's own host, in a container). In `deploy/compose/.env` set `PIM_COMPUTER_URL` to the stack's address *as this host reaches it* (`https://pim.example.com`; for the plain-HTTP trial stack `http://host.docker.internal:8088`) and `PIM_COMPUTER_TOKEN` to the token, then `deploy/compose/pim.sh --profile local-computer up -d pim-computer`. The `pim-computer` service has no `env_file`, joins none of the stack's networks (its own `computer` network, with the host's address and the public hostname mapped to the Docker host), runs as the unprivileged `node` user with a read-only root, no capabilities and only the `pim-files` volume (`/workspace`) to write. The Pim image carries `computer/pim-computer.ts`, which the Gate also serves at `/pim-computer.ts`.
   - **Directly on the host** (a laptop, or a server where you want a real browser and desktop; the container has no Chrome): `curl -fsSL https://pim.example.com/install.sh | sh -s -- computer pimc_…` installs Node.js if needed and a user service, or in the foreground `PIM_URL=https://pim.example.com PIM_COMPUTER_TOKEN=pimc_… node computer/pim-computer.ts --root ~/pim`.
3. Settings → Computer shows it online. An agent's `shell`, `file_delete`, desktop actions and browser form submissions then wait in Approvals (`computer:shell`, `computer:file_delete`, `computer:desktop`, `computer:browser_submit`) unless an admin gave a standing approval; reading, writing and editing files under `/workspace`, opening pages and clicking links run at once, as in v1. With no computer connected every one of these tools answers "unavailable" immediately, and chat is unaffected.

**What this is not.** A container is not a sandbox for arbitrary agent code: commands in `pim-computer` run in that container on the host's kernel, with outbound network access and whatever you mount into it. Do not mount the Docker socket, `/`, or the stack's directories. Untrusted code that should be contained belongs in the `coding` profile's sandboxes, not here. **Managed computers** (`pim-host`, a computer made for every person) and `hostopsd` host operations are not part of this deployment: `/api/admin/computer-host` reports none paired and refuses to pair one.

The Runner reaches a computer over NATS (`pim.v2.relay.<owner>.rpc`), connecting when an agent first uses a computer tool, so the `runner` role needs `PIM_NATS_URL` (it already has it) and the Gate or `relay` container that holds the computer's socket must be running. `PIM_COMPUTER_SOURCE` overrides where the Gate reads `pim-computer.ts` from (default `/app/computer/pim-computer.ts` in the image).

## Stuck chats and the Runner's guards

A chat whose turn cannot finish ends with an error instead of staying busy. Each guard has a setting on the `runner` role, in milliseconds:

- `PIM_MODEL_STALL_MS` (default 120000): a model stream that sends nothing for this long is cut off; before any output the request goes to the next model of the chat's list, otherwise the chat ends with "The model timed out".
- `PIM_TOOL_TIMEOUT_MS` (default 600000): a tool call that has not returned by then ends with an error result, and a call also ends at once when the person stops the chat, whatever the tool's own work is doing.
- `PIM_RUN_STALL_MS` (default 600000, 0 turns it off): the run watchdog. A run whose tasks and live document have not changed for this long, and that is not parked for an approval, a retry or a sleep, is stopped, and the chat says so.
- `PIM_STOP_GRACE_MS` (default 10000): how long a stop (the web app's stop button, or the watchdog) waits for the run to end. A run that ignores its abort signal then has its partition recycled: the Runner closes the Harness and hands the lease back, and the next claim's recovery settles the aborted calls under a newer epoch, so a stuck run's late writes are fenced.

Provider cooldowns are shared between Runners (`pim_runtime.provider_cooldowns`, migration 0666). The approval policy's `auto` (30 seconds unless the person sets another) is applied by the `maintenance` role's timeout sweep; `majordomo` is applied by the Runner's review loop (`approval-review.ts`, migration 0665), which escalates a review that did not finish in 5 minutes.

## Kubernetes

Kustomize: `kustomize build deploy/k8s | kubectl apply -f -` (needs CloudNativePG, an ingress controller and cert-manager). `overlays/openbao` takes the Secrets from OpenBao or Vault through External Secrets; `overlays/monitoring` adds the PodMonitor, the `PrometheusRule` and the Grafana dashboard (build it with `--load-restrictor LoadRestrictionsNone`, because the dashboard JSON lives in `deploy/observability/`).

- One Deployment per role, each with a PodDisruptionBudget, and an HPA for all but `maintenance`. The Runner has `terminationGracePeriodSeconds: 150`, a `preStop` that calls `/drain`, and an HPA that scales down one pod per two minutes after a ten-minute quiet window, because every Runner that leaves is a lease handoff.
- PostgreSQL is a CloudNativePG `Cluster` of three, with the same roles and logins declared in `managed.roles` (the NOLOGIN roles first, then each login with `inRoles`; the order CloudNativePG reconciles them in was not observed), with Barman object-store base backups, WAL archiving and a 30-day retention for point-in-time recovery, and a PgBouncer `Pooler` in transaction mode. CloudNativePG uses Barman for this, not pgBackRest.
- **Durability against availability is a choice and the manifest states it** (`deploy/k8s/base/postgres.yaml`). It sets `synchronous: { method: any, number: 1, dataDurability: required }`: a commit waits for one standby, so a primary failure loses no committed transaction, and writes stop if no standby can confirm. `dataDurability: preferred` keeps the cluster writable without a standby and can lose the commits only the old primary had. With no `synchronous` block, replication is asynchronous and a primary failure can lose the last commits. Backups and WAL archiving protect against losing the whole cluster, with a recovery point as old as the archive lag. Nothing here claims that failover is lossless on asynchronous replication.
- NATS Core runs as a three-node cluster without JetStream: it carries commit events from Runners to Live and is never a source of truth. A missed message is recovered from PostgreSQL by cursor.
- Untrusted sandbox compute lives in the `pim-sandboxes` namespace, on a node pool with the taint `pim.dev/untrusted=true`, under `runtimeClassName: gvisor` (Kata or an agent-sandbox class works the same way). The control-plane namespace denies all ingress by default and admits only labelled peers: PostgreSQL, the Pooler and NATS accept control-tier pods and nothing else. The sandbox namespace denies all traffic by default and allows DNS, the Gate's port 8080 (where the git broker and the model gateway are) and the public internet except private, link-local and cluster ranges. Both ends enforce it; a test checks that no sandbox rule names PostgreSQL, NATS or a Runner.
- Secrets: nothing in `base/` is a Secret. Envelope keys are mounted as files, never environment variables.

## Observability

`packages/v2-ops/src/observability/` exports Prometheus metrics for every signal in the plan, with no label that can identify a person, a chat or content (the registry refuses such labels):

| Signal | Metric |
|---|---|
| HTTP and Gate latency | `pim_http_request_duration_seconds{service,route,method,status_class}` (p50/p95/p99 through `histogram_quantile`) |
| Event-loop lag | `pim_nodejs_event_loop_delay_seconds{service,quantile}` from `monitorEventLoopDelay` |
| PostgreSQL | `pim_pg_pool_wait_seconds`, `pim_pg_query_duration_seconds`, `pim_pg_commit_batch_duration_seconds`, `pim_pg_pool_connections` |
| Queues | `pim_inbox_oldest_age_seconds`, `pim_due_work_oldest_age_seconds` |
| Ownership | `pim_partition_ownership_transfers_total`, `pim_fencing_rejects_total`, `pim_partition_leases_held` |
| Replay | `pim_projection_lag_seconds`, `pim_live_cursor_replay_lag_seconds` |
| Live | `pim_live_websockets_active`, `pim_live_slow_client_coalesced_total`, `pim_live_slow_client_overflow_total` |
| Models and spend | `pim_model_request_duration_seconds`, `pim_model_time_to_first_token_seconds`, `pim_model_errors_total{class=timeout_524\|rate_limited\|...}`, `pim_model_tokens_total`, `pim_spend_usd_total` |

Services call `createPimMetrics()`, `monitorEventLoop()`, `openPools(config, metrics, service)` (one bounded, instrumented pool per `POOL_NAMES` entry, sized and timed by the process config's budgets; the `pool` label is that name), `instrumentPool()` and `serveMetrics()`; the services' own call sites belong to their workstreams.

**Redaction is the default.** `redact.ts` removes prompts, completions, tool arguments and results, and any field named like a credential, from spans, metric labels and log lines; and it removes credential patterns from every string: `pim_…`, `pimgit_…`, `pimgw_…`, `sgamp_…`, `pimc_`, `pimh_`, `pimhostops_`, bearer and basic credentials, provider keys, JWTs, cookies, PEM private keys, and `APP_CREDENTIALS_KEY`/`cookie_key`/`PIM_KEK_*` assignments. `RedactingSpanExporter` wraps any exporter, so no span leaves unredacted. Setting `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` keeps message content in spans and still removes every credential pattern. Redaction is pattern-based: a secret in a shape the patterns do not know is not caught, and the tests cover the shapes listed here, not every possible one.

`deploy/observability/` has the Grafana dashboard (`Pim operations`, uid `pim-operations`), 19 Prometheus alert rules, and one runbook section per alert. Tests check that every query uses a metric the services export, that every alert has a runbook section, and that the Kubernetes `PrometheusRule` equals the plain rules file.

## Cutover from the Cloudflare deployment

The fence procedure is `docs/architecture/inventory/C-cutover-fence-entrypoints.md` §10 (read in full). This is how the tools map onto its ten steps. Nothing here pushes, deploys or touches a live host: those steps are the operator's, and each tool runs against what it is pointed at.

| Fence step | Tool or action |
|---|---|
| 1-4 Inventory, readiness of destructive paths, close registration, suspend accounts | Operator, with existing controls. The importer treats accounts suspended with the reason `cutover fence` as active again; the admin is never suspended. |
| 5 Fence ingress with an invalid `PIM_RUNTIME` | Operator, existing control. |
| 6 Stop the alarms | Deploy the fence Worker (option B): `node scripts/v2-migrate/fence-config.mjs` writes its wrangler config from the production `wrangler.jsonc`, and a test fails if the two differ. Deploy with `--durable-objects-code-update-mode immediate`. |
| 7 Verify old code is gone | `GET /fence/v1/do/<binding>/<name>/probe` on the Directory, Gallery, a sample of Pim and CodingThread ids, and the WorkspaceCatalog; each must answer from the shell. |
| 8 Stop what is outside the Worker | `POST /fence/v1/do/WorkspaceContainer/<id>/destroy` (off unless `FENCE_ALLOW_CONTAINER_DESTROY=true`); the rest is the operator's. |
| 9 Snapshot and compare | `node scripts/v2-migrate/run.mjs export`, then compare `cf_agents_jobs` row counts across two exports more than two minutes apart. |
| 10 Hold the fence | Keep the fence Worker deployed until activation. |

**The fence Worker** exports the nine legacy classes under their exact names (`Pim`, `Auth`, `Directory`, `Gallery`, `CodingSchedulerDO`, `CodingThreadDO`, `HostOps`, `WorkspaceContainer`, `WorkspaceCatalog`) and `ContainerEgress`; copies the bindings, `migrations` and `containers` blocks without a `deleted_classes` or `exports` entry; never runs `agents` `Lifecycle` (a job with no callback is dropped as done by that scheduler); consumes every alarm without reading or writing storage or re-arming it; answers everything else `503 Maintenance`; and, behind `FENCE_EXPORT_TOKEN` (32 characters or more, compared in constant time), serves read-only dumps of every table (paged), key-value entry and alarm of any object, the R2 buckets, and `OAUTH_KV`. An export route without the token looks like any other path.

**Export, then import and verify** (`node scripts/v2-migrate/run.mjs <command>`):

```sh
export FENCE_EXPORT_TOKEN=... APP_CREDENTIALS_KEY=... PIM_KEY_BACKUP_PASSPHRASE=...
run.mjs export --url https://pim.example.test --out /secure/snapshot --cutover-at 2026-11-20T03:00:00Z
export PIM_KEK_CURRENT=k1 PIM_KEK_k1=$(openssl rand -base64 32)
run.mjs import --snapshot /secure/snapshot --database-url postgres://pim_migrator:... --objects-dir /var/pim-objects \
        --cutover-id cut-2026-11-20 --report /secure/report --legacy-rp-id pim.example.test --new-rp-id pim.example.test
run.mjs rehearse --out /tmp/rehearsal        # the same pipeline on a synthetic snapshot and a throwaway PostgreSQL
```

What the importer does, and what it refuses to:

- Checks every file of the snapshot against the manifest's SHA-256 before it reads any.
- Splits each space's single pi history into **conversation-family partitions**: the home partition holds conversation 1 and what attaches to it; every fork closure, and each plain chat, continuation, delegated task, trigger chat and group-chat seat, is a family of its own. Numeric conversation, entry, task and document ids are never renumbered; each tenant keeps one id sequence continuing above its highest id; each partition continues its commit sequence above its own highest.
- Keeps UUID chat ids mapped to their numeric conversations; keeps explicit settings and overrides row for row (nothing `unset` becomes an override); keeps passkeys, identities, token hashes and recovery codes exactly.
- Moves every secret under `EnvelopeCrypto` (AES-256-GCM, per-value data key wrapped by a named key-encryption key, tenant and name bound as authenticated data) and **keeps the legacy ciphertext beside it**: native-app credentials opened with `APP_CREDENTIALS_KEY`, plaintext provider and compute credentials, the Directory's `cookie_key` and `salt`, push secrets, the MCP OAuth key-value tokens. `legacy_rows` holds a reference, never the secret. The legacy keys themselves go into a passphrase-sealed key backup written beside the snapshot by `export`; keep it away from this host. Coding-vault blobs are kept verbatim: they are sealed under a key derived from `cookie_key`, which is why `cookie_key` is preserved.
- **Quiesces** (`planQuiescence`): every non-terminal `pi.tool` task and every pending, or decided-without-a-result, approval becomes a `needs_reconciliation` operation and a held task, with the arguments reduced to a digest; queued trigger firings likewise; a CLI coding turn cut off by the fence likewise. Schedule occurrences at or before the cutover are recorded as missed and never fired, and the first cron, interval or once occurrence strictly after the cutover is armed, so the first Runner boot has no catch-up to do (cron in a time zone other than UTC is marked `recompute`). A remote coding session (`agent-hosted`) is adopted by its remote id with its start recorded as `succeeded` under the key the client deduplicates on, so it is never started again.
- Refuses a second cutover in the same database, a changed snapshot under the same cutover id, and an import after activation; re-running the same import changes nothing.
- Warns when the WebAuthn rp id would change: passkeys are bound to the hostname.

**The auditor** reads the snapshot and the database independently and compares them: row counts of every source table (typed or kept), record-level hashes of entries, tasks and document revisions, passkey ids and public keys byte for byte, used recovery codes, partition integrity (no entry, fork or task across partitions, every fork point an entry of its parent, id and commit sequences above every id), the visible transcript of **every conversation** resolved through fork ancestry on both sides, explicit settings key by key, no plaintext secret left in `legacy_rows`, every object's SHA-256 and size re-read from the object store, and the quiescence invariants. It writes `cutover-report.json` and `cutover-report.md`; do not start a Runner unless the verdict is PASS.

**Before activation** the new system has not served anyone: rollback is to redeploy the previous Worker version, set `PIM_RUNTIME` and `PIM_REGISTRATION` back, unsuspend each suspended account, and expect alarms to resume from stored rows (the Scheduler, Directory and HostOps recompute their alarms on their next call; **this was not observed**, see the audit's open question 6). Throw the new database and bucket away. **After activation** there is no automatic rollback: writes in the new system have no way back into Durable Objects. The choices are to fix forward, or to restore the pre-activation backup of the new system (below) and accept the loss of everything after it, and to re-run the fence on the old system only if its data is still the wanted one.

## Rehearsal on a real v1 Worker, and the live cutover runbook

`node scripts/v2-migrate/rehearse-local.mjs all --database-url postgres://<superuser>@<host>/postgres` rehearses the whole cutover on one machine, against a **real v1 Worker** (the preview, `wrangler dev`) instead of the synthetic snapshot. It needs PostgreSQL (`packages/v2-runtime/scripts/ensure-postgres.sh`), `PIM_NATS_BIN` (`packages/v2-server/scripts/ensure-nats.sh`) and this checkout's `node_modules`; it touches no Cloudflare account, host or cloud service. Phases (run any subset by name; state is kept in `--work`, default `/tmp/pim-rehearsal`):

| Phase | What it does |
|---|---|
| `v1` | Starts the v1 preview on fresh state and fills it through its real API (`populate-v1.mjs`): two accounts (one admin) with a passkey whose private key the rehearsal keeps, API tokens, settings, a profile, chats (a fork, a chat cut off mid-tool behind a pending approval), agents with instructions, a skill with a file and two versions (written through its approval), memories, a goal with steps, scheduled tasks, a note, an app with two versions, an uploaded image, a custom model provider with an API key, a circle. It then takes a digest of what v1 serves. |
| `fence` | Stops v1 and runs the fence Worker (`packages/v2-ops/src/fence-worker`, its classes, bindings and migrations taken from the production `wrangler.jsonc`) on the **same** Durable Object, R2 and KV state; ordinary paths answer 503 and the export routes need the token. |
| `export` | `run.mjs export` through the fence Worker. |
| `import` | Creates the database, runs every SQL band, `run.mjs import` with its audit, then `promote` with the deployment's keys (`PIM_KEK_*`), the importer's object directory (`PIM_LEGACY_OBJECTS_DIR`) and the S3 settings, so credentials and files are carried over. |
| `serve` | NATS, an S3 server, and the Gate, Live and Runner as separate processes on `NOBYPASSRLS` role logins. Skip it with `--public-url` to point `verify` at another stack, such as Compose (`--ingress-secret` if its proxy needs one). |
| `verify` | `verify-v2.mjs`: signs in with the old passkey and the old API tokens, then checks through the stack's API that every item is present and belongs to the right person (chat histories and fork ancestry, agents and instructions, skills with files and versions, memories, goals, triggers aimed at the new chat ids and not caught up, note, app versions, image bytes, provider with a key that is never returned, circle, profile), that a new message in an imported chat (including the one cut off mid-tool) is answered by a Runner using the imported provider and its imported key, that the cut-off tool call did not run again, and, with the database URL, the explicit settings and that no credential is in clear anywhere. Exit status 0 only if all pass. |
| `rollback` | Stops the new stack and the fence Worker, starts v1 again on the same state and compares the digest, then waits to see whether the schedule that fell due while fenced fires. Nothing is deleted; the new database is left for the operator to discard. |

**What the local rehearsal found, and fixed** (each with a regression test): the exporter dropped a row whose rowid is 0 (the first memory); a real export stores pi-durable's `kind` columns as JSON text, so no tool call was held and the audit's check of it passed vacuously; a tool task's call id and arguments are in `input` and its checkpoint; triggers are `enabled`, not `active`, so none was planned; `cf_agents_jobs.time` is milliseconds; custom provider keys sit in clear inside a JSON array in `pim_meta` (`own_providers`), which no secret list named, and the audit's clear-text check named only the fixture's secrets; the promotion read apps and notes from a table shape the real Worker does not have, kept circles from the first account only, named triggers' chats by the old numeric session id, and was never given keys or object stores by the `promote` command; imported chat images were addressed by a bare id the Gate could not serve; the command relay tried to create a home partition again as a family, so no message could reach a chat of the home partition; and imported chats still named the old deployment's models, so every new message failed with "Model ... is not available" (they now name `PIM_DEFAULT_MODEL`).

**Observed in the local rehearsal:** the unfenced v1 Worker served the same digest, and a schedule that had fallen due during the fence fired by itself after the unfence (so, locally, the alarms are recomputed: this answers the audit's open question 6 for `wrangler dev`, not for Cloudflare).

**Into the Compose stack.** The same rehearsal was run with the booted Compose stack as the destination: `rehearse-local.mjs v1 fence export --work <dir>`, then `scripts/v2-migrate/compose-import.sh <dir> localhost` (import with its audit, 290/290, and promotion, inside the stack's image with its own keys and SeaweedFS), then `verify-v2.mjs --public-url http://localhost:8088 --expect <dir>/v1-expectations.json --provider-host 0.0.0.0` (52/52; the imported provider's URL was pointed at the Docker gateway so the Runner container could reach the stand-in), then `rehearse-local.mjs rollback --public-url http://localhost:8088` (v1 served the same digest, and the schedule due during the fence fired by itself). Ada's v1 passkey signed in to the stack, and the web app showed her imported chats, fork and settings. In one of three verify runs the first message's model calls never reached the stand-in (`Connection error`, no connection seen) and the next run passed; that was the harness's Docker-to-host path, not yet explained.

**Not run against real Cloudflare, and not rehearsed here:** deploying the fence Worker to the production account (`--durable-objects-code-update-mode immediate`) and its effect on live alarms; real R2 (the local one is miniflare's); a passkey on another hostname (the rehearsal keeps `localhost`); native connectors' credentials (`APP_CREDENTIALS_KEY`), push subscriptions, ChatGPT-plan tokens, deployment-level providers, templates and bots (kept in the landing, not promoted); coding threads (the preview has no compute); a partially failed import (an altered snapshot is refused before anything is written, which `migration.test.ts` covers); stored files from before computers (promoted and tested on a landing row, since a v1 space cannot make them any more).

### Live cutover runbook

1. **Destination prerequisites.** The Compose stack (or Kubernetes) is up and healthy with an **empty** database, its migrator done, a bucket, NATS, `PIM_KEK_CURRENT`/`PIM_KEK_<id>` keys set (a backup of the key ring kept apart from the database), and `PIM_PUBLIC_URL` on the **same hostname** as the old Pim so passkeys keep working. Choose `PIM_DEFAULT_MODEL` (`provider/model`) and make sure that provider exists on the new stack: every imported chat that names a model the new deployment lacks is moved to it. Run the full rehearsal first (`rehearse-local.mjs all`, then `verify-v2.mjs` against the Compose stack on a copy).
2. **Announce downtime, then fence** (the table above, steps 1-5): close registration, suspend accounts with the reason `cutover fence`, set an invalid `PIM_RUNTIME`; deploy the fence Worker (`fence-config.mjs`, then `wrangler deploy --durable-objects-code-update-mode immediate`); probe every class; stop containers.
3. **Back up the old side**: export (below) is the backup; also keep `APP_CREDENTIALS_KEY`, `cookie_key` and every Worker secret, sealed with `PIM_KEY_BACKUP_PASSPHRASE` as `run.mjs export` writes them.
4. **Export** twice more than two minutes apart and compare `cf_agents_jobs` counts (nothing may be moving), then `FENCE_EXPORT_TOKEN=... run.mjs export --url <fence> --out <dir> --cutover-at <fence verified time>`.
5. **Import and audit**: `run.mjs import ... --legacy-rp-id <host> --new-rp-id <host>`; the verdict must be PASS and no warning about a changed rp id. Read `cutover-report.md`.
6. **Promote**: `PIM_DATABASE_URL=<schema owner> PIM_RP_ID=<host> PIM_CUTOVER_AT=<epoch ms> PIM_DEFAULT_MODEL=... PIM_LEGACY_OBJECTS_DIR=<importer objects dir> PIM_S3_*=... PIM_KEK_*=... node --import tsx packages/v2-server/src/main.ts promote`. Read its `skipped` list: it names what was not promoted and why. On Compose, steps 5 and 6 are one command, `scripts/v2-migrate/compose-import.sh <dir with snapshot/> <old hostname> [provider/model]`, which keeps the app stopped until both are done.
7. **Verify on the stack before anyone is let in**: `verify-v2.mjs --public-url <stack> --expect <expectations> ...` needs a populated rehearsal's expectations file, so for the real data check by hand: the admin signs in with a passkey, chats and forks read, agents, skills, memories, goals, triggers (time triggers count from the activation; computer-bound ones are paused), notes, apps, the provider answers.
8. **Thread adoption and reconciliation**: remote Amp threads are adopted by their remote id and never started again; every pending approval and cut-off tool call is a `needs_reconciliation` operation in `pim_ops.external_operations`: decide each by hand before enabling anything that could repeat it.
9. **Activate**: start the Runners, lift the maintenance page, unsuspend nobody who was not suspended by the fence. From here there is **no** automatic rollback.
10. **Rollback before activation**: stop the new stack; deploy the previous Worker version; restore `PIM_RUNTIME` and `PIM_REGISTRATION`; unsuspend the fenced accounts. Deleting the new database and bucket is the operator's later choice. The local rehearsal shows the old Worker, unfenced, serving the same data; the same on Cloudflare is not yet observed.

## Backup and restore

`scripts/v2-backup/run.mjs backup|restore|post-restore`. The tested engine is a **physical base backup through the low-level API** (`pg_backup_start`, copy, `pg_backup_stop`) with archived WAL, so a restore can stop at the end of the backup or at any chosen instant after it, plus every object with its SHA-256 and the key material's names and fingerprints. For Compose, `scripts/v2-backup/compose-backup.sh <dir>` takes a logical `pg_dump` (with owners and grants) and a copy of the bucket with SHA-256 sums, and `scripts/v2-backup/compose-restore.sh <dir> [restore-id]` stops the app, restores both, migrates, runs `migrator post-restore` (the safety pass below) and starts the app again; `scripts/v2-compose/smoke.sh` runs both on every CI push and checks that a message written after the backup is gone, the image is back and chat still answers. Keep `deploy/compose/.env` (it holds the key ring) in its own backup. On Kubernetes, CloudNativePG's Barman backups and WAL archive are the equivalent and `ScheduledBackup` runs them daily.

**The restore hazard is real and the safety pass exists for it.** A restored database is older than the world. Operations it shows as pending may already have run after the backup; operations in flight may have finished or half-finished. Before any Runner starts, `post-restore` moves every `pending` and `in_flight` external operation, and every effect named in a journal of effects known to the outside world (`--known-effects`), to `needs_reconciliation`; holds unfinished tool tasks; turns every schedule whose time has passed into `recompute` with the missed time recorded; and marks the restore `reconciled`. Runners refuse to start until then. The database alone cannot know what happened after the backup, so keep an effects journal outside it (provider-side logs, or the failed database's last rows) and pass it in. The pass is idempotent.

Restore order: stop every Runner; `restore`; start PostgreSQL; `post-restore`; check; start Runners. The key ring must come from its own backup: a database restored without it cannot open any sealed secret.

## Load qualification

`node scripts/v2-bench/run.mjs --profile 5 --profile 50 --profile 500 --profile 1000 [--mode single|batched]`; `scripts/v2-bench/install-nats.sh` fetches the pinned NATS server first.

**What it is, and is not.** The harness runs a real PostgreSQL 17 (durability on), a real NATS server, a simulated model provider (time to first token, token interval, tool latency, error injection all parameters), several Runner processes, a Live process with WebSocket fanout and slow-client coalescing, a Gate process with a bounded pool, and a browser process holding WebSocket clients (some that never read) and issuing the two foreground reads. **The Runner is a reference write path, not the Pim Runner**: it reproduces the storage pattern the audit describes for a streaming conversation (a partial message every 250 ms, tool intent and result, the final message; every commit one fenced statement that checks the lease epoch and takes the partition's next commit sequence; an event published after commit) against this package's schema. It measures PostgreSQL, Node and NATS under that pattern, and says nothing about the real Runner until that Runner's writes are shown to follow it. Active streaming runs are counted separately from stored idle conversations (20 history entries each, 100-200 per tenant); every profile has both. A run is continuously streaming: a turn is 400 ms to first token, 120 tokens at 25 ms, a 300 ms tool call and a 200 ms pause.

**Measured here** (4 vCPU, 7.8 GB, Node 26.13, PostgreSQL 17.11 embedded, `shared_buffers` 256 MB, fsync median 0.57 ms for an 8 KB write on the temp disk; client, server and load generators all share the machine; 25 s measured window after a ramp; foreground probes are 4 closed-loop clients, half sidebar and half session reads; "p95 under load" is the warm p95 in the window). Raw output is in `packages/v2-ops/bench-results/`.

| Active runs | Tenants | Idle chats | Mode | Commits/s | Commit p50 / p99 (worst Runner), ms | Sidebar p95 base → load, ms | Session p95 load, ms | p95 regression sidebar / session | Machine CPU | Late turns |
|---:|---:|---:|---|---:|---|---|---:|---|---:|---:|
| 5 | 3 | 300 | single | 20.8 | 1.35 / 2.35 | 2.41 → 2.68 | 3.16 | +11% / +15% | 17% | 0% |
| 50 | 10 | 2,000 | single | 210.9 | 1.08 / 4.12 | 2.88 → 2.79 | 3.25 | −3% / +0.3% | 27% | 0% |
| 500 | 50 | 10,000 | single | 2,048 | 2.11 / 51.5 | 3.72 → 9.18 | 8.89 | +147% / +119% | 88% | 0% |
| 500 | 50 | 10,000 | batched | 2,091 | 7.16 / 30.7 | 2.01 → 4.24 | 5.20 | +111% / +127% | 82% | 0% |
| 1,000 | 100 | 20,000 | single | 3,473 | 108.9 / 706 | 2.29 → 38.3 | 37.9 | +1,570% / +1,354% | 100% | 5% |
| 1,000 | 100 | 20,000 | batched | 3,722 | 67.9 / 282 | 2.34 → 9.37 | 10.46 | +300% / +300% | 99% | 0% |

Foreground reads run as the Gate does, in a transaction that sets `pim.owner_id` through `withTenantTransaction` from `@pim/v2-contracts`. Partitions are UUIDs and owner ids `o_…` as in the contracts. An earlier run of the same harness before that alignment, with plain reads, gave similar shapes but different numbers at saturation (at 1,000 single-commit runs, 90% late turns and p95 46 ms against 5% and 38 ms here): near saturation, results vary a lot from run to run, and one run is not a distribution.

What this says, within those limits:

- **The absolute foreground budget (warm p95 under 250 ms) held in every run**, by a factor of 6 at the worst (38 ms at 1,000 runs, single commits, the machine at 100% CPU).
- **The relative budget (at most 20% worse than at baseline) was met at 5 and 50 runs and missed from 500 up.** With a baseline of two to three milliseconds, 20% is half a millisecond, so this criterion is dominated by CPU contention on a machine that also runs the load; the sandbox cannot say whether it would hold on separate hosts.
- **Saturation:** at 500 runs the machine is at 82-88% CPU and every run keeps pace; at 1,000 runs it is at 99-100% CPU. With one commit per statement 5% of turns fell more than twice behind and commit p99 was 0.7 s; batching commits into one transaction per 5 ms per Runner kept every turn on pace with commit p99 0.28 s. 1,000 simultaneously streaming runs is about this 4-vCPU sandbox's limit.
- PostgreSQL did several hundred to several thousand transactions per second (reads included) and up to about 1,200 WAL flushes per second (`bench-results/*.json` has the exact figures per run); mean WAL flush 0.3 to 1 ms. The fsync here is fast; a network volume would change every commit latency above.
- Live delivered events to 310 browsers at 1,000 runs with p99 lag in the tens of milliseconds (see the JSON). No client was coalesced or disconnected: the slow clients never exceeded the coalescing threshold at these event rates, so that path is covered by the unit tests, not by this load.
- Memory: PostgreSQL's summed RSS is 0.3-7 GB and counts shared buffers once per backend, so it overstates real use; Node processes 0.7-1.5 GB together.
- Not measured: the real Runner, real models, a separate PostgreSQL host, replication, PgBouncer in the path, Kubernetes. 1,000 runs are 1,000 streaming conversations, not 1,000 stored agents.

## Integrated qualification (real Gate, Live, Projector and Runners)

`node scripts/v2-bench/integrated.mjs [--profiles 5,50,500,1000] [--window 30]` runs the integrated test, `packages/v2-server/test/integrated-bench.test.ts`, on a PostgreSQL 17 that the script starts with durability on (`fsync`, `synchronous_commit`, `full_page_writes` on; `shared_buffers` 256 MB; `max_connections` 800) and writes `packages/v2-server/bench-results/<date>-integrated-<profiles>.json`. `scripts/v2-bench/install-nats.sh` installs the pinned NATS server (v2.10.22) first. The default `pnpm --filter @pim/v2-server test test/integrated-bench.test.ts` runs only 5 and 50 active runs with 10 s windows, on the test cluster (`fsync` off), and is what CI runs; it fails only on a collapse (a last turn that never lands, a projection that never catches up, a stalled foreground read, an idle chat that ran) and, at 50 runs or fewer, on a missed absolute budget. Budgets met or missed at 500 and 1,000 are results, not failures.

**What runs.** Each of these is a separate Node process (`scripts/v2-bench/integrated-process.ts`) started through the product's own `startProcess`: one **Gate**, one **Live** (which also runs the **Projector**), and several **Runners**, plus a probe process that is the foreground load. They talk to real PostgreSQL through the non-superuser, `NOBYPASSRLS` role logins the deployments use, and to a real NATS server for Pulse. The model is pi-ai's faux provider: every reply is 240 characters written at 25 tokens per second (2-3 characters a token), so a turn streams for about 2.8 s alone, commits its partials, and its cost grows only through its history, which is longer after every turn. There are no tools in the turns. Beside the runs the profile holds WebSocket followers on Live (about 10% slow readers that stop reading for 40 s at a time, and every 3 s about 5% of the others are cut and reconnect from their cursor), and a coding-thread transcript flood (three threads, about 90 events/s together, 8 KB tool outputs) written to Forge's outbox, projected by Live and followed by sockets. The test process creates the people and chats and sends the messages and is itself a load on the same machine; its CPU is in the results.

**Definitions.** An **active run** is a chat with a turn streaming at every moment of the measured window: all runs start within a few seconds of each other, and each sends its next message 200 ms after its answer is readable (it is a closed loop, so a run is never idle in the window). **Stored idle chats** are separate: two per active run, created through the Gate, never run in the window (the test checks no answer for them was ever projected). They are empty chats, not chats with a long history; the active chats' histories do grow, one turn at a time. **Tenants** are real accounts; chats are spread over them. Each chat is its own partition, so the Runner's resident bound applies per active chat: the Runner role's `maxResident` is its default of 64 (`startRunner` does not pass it on), so a profile starts `ceil(runs / 64) + 1` Runners (2, 2, 9 and 17), each with a pool of 10 connections. **Foreground reads** are `GET /api/sessions` and `GET /api/snapshot/sidebar` for one tenant, by four closed-loop readers with a 40 ms think time, in their own process; they are measured first for 20 s with no run active on the same data (the **warm baseline**, after a 3 s warm-up), then through the load window. A turn's **latency** is from the Gate accepting the send until a 200 ms poll of the projection shows the answer, so it is time-to-readable and includes the projection's lag; the **solo turn** is one turn alone on the idle deployment, and a turn is **late** if it takes more than twice that.

**Measured here:** 4 vCPU (Intel Xeon 2.60 GHz), 7.8 GB RAM, Node 26.13.1, PostgreSQL 17.12 (Debian), nats-server 2.10.22, 30 s measured window after a 15 s ramp, the run recorded in `bench-results/2026-11-17-integrated-5-50-500-1000.json`. Client, probes, Gate, Live, Runners, NATS and PostgreSQL share the machine.

| Active runs | Tenants | Stored idle chats | Runners (resident capacity) | Runs admitted at window start | Commits/s | Turns completed in window | Turn latency p50 / p95, s (solo 2.8) | Late turns | Max projection lag, commits (catch-up after load, s) | Machine CPU | Peak RSS, node processes / PostgreSQL PSS |
|---:|---:|---:|---|---:|---:|---:|---|---:|---|---:|---|
| 5 | 3 | 10 | 2 (128) | 5 | 36 | 51 | 2.7 / 2.7 | 0% | 5 (2.1) | 44% | 1.0 GB / 0.19 GB |
| 50 | 10 | 100 | 2 (128) | 50 | 122 | 177 | 8.6 / 8.9 | 100% | 1,032 (5.8) | 69% | 1.0 GB / 0.27 GB |
| 500 | 50 | 1,000 | 9 (576) | 327 of 500 | 145 | 9 | 34 / 44 | 100% | 94 (44.7) | 95% | 2.4 GB / 0.57 GB |
| 1,000 | 100 | 2,000 | 17 (1,088) | 418 of 1,000 | 217 | 0 | none completed in the window | n/a | 18 (82.1) | 100% | 3.7 GB / 0.91 GB |

| Active runs | Warm baseline p50 / p95 / p99, ms (0 runs active) | Under load p50 / p95 / p99, ms | p95 regression | Absolute budget: p95 < 250 ms | Relative budget: p95 ≤ +20% |
|---:|---|---|---:|---|---|
| 5 | 7.2 / 10.0 / 13.8 | 5.8 / 9.0 / 13.9 | −10% | **met** | **met** |
| 50 | 7.1 / 9.6 / 12.7 | 6.5 / 15.3 / 23.5 | +59% (+5.7 ms) | **met** | missed |
| 500 | 6.7 / 9.7 / 12.7 | 15.8 / 85.6 / 178 | +783% (+76 ms) | **met** | missed |
| 1,000 | 7.5 / 10.8 / 17.3 | 76 / 451 / 758 | +4,080% (+441 ms) | **missed** | missed |

(All three of `/api/sessions`, `/api/snapshot/sidebar` and their union have their own figures in the JSON; the union is shown. Where the table says met or missed for a run, the JSON also says it per endpoint, and no endpoint disagreed with the union.)

What this says, within those limits:

- **Neither budget is met at 1,000 active runs, and only the absolute one at 500.** Foreground p95 was 451 ms at 1,000 runs with the machine at 100% CPU, 86 ms at 500, 15 ms at 50. The relative budget (at most 20% above a 10 ms baseline, that is 2 ms) is met only at 5 runs; at 50 runs the regression is 5.7 ms. At these baselines the relative budget is a test of CPU contention on one machine, not of the Gate's design, and this sandbox cannot say what separate hosts would show.
- **This stack saturates far below the synthetic reference writer's numbers** (the table in Load qualification above: 2,000-3,700 commits/s, every run on pace at 500). The integrated stack committed 122-217 commits/s whatever the number of runs, while PostgreSQL used 40-69 CPU-seconds in a 30 s window (1.3-2.3 cores) at 3,000-5,300 transactions per second (50 runs and above) and the Runners 10-40 CPU-seconds: the Runner's own work (pi-durable, per-partition loads and claims, the relay and the polls) and the queries around a commit cost much more per commit than one fenced statement. The commit rate is what the runs got, not what the machine could do for them: at 500 and 1,000 the machine was out of CPU.
- **Runs per machine.** At 5 runs a turn takes the same time as alone. At 50 runs the Runners were not out of CPU (machine 69%), but a turn took 8.6 s to be readable against 2.8 s alone, with the projection about 1,000 commits behind at a steady plateau: what limited readable turns there was the Projector's single drain loop, not the Runners. That is a measurement of the plateau and of Live's CPU (46% of one core), not a proven cause; whether the loop is bound by its per-partition round trips would need its own experiment. At 500 runs a turn took 34 s and only 327 of 500 runs had been admitted when the window opened (the Gate accepted a send in 0.25 s at p95, 2.0 s at 1,000 runs; the test sends 32 at a time); at 1,000 runs 418 had, and no turn completed in the 30 s window, though every turn eventually landed and the projection caught up, 82 s after the load stopped. 1,000 simultaneously streaming runs is beyond what this 4 vCPU machine serves; the saturation degrades latency rather than correctness (the Gate kept answering with no non-200 response, every last turn landed, the projection caught up), but it is slow.
- **Live.** Delivery averaged 22-786 updates/s (the lowest at 1,000 runs, where little is committed and projected in the window) to 8-203 followers. 2-20 followers read slowly, and 15-140 sockets were cut and reconnected from their cursors (every cut reconnected, no snapshot was refused). **The slow-reader mechanism was not exercised**: the operating system's socket buffers (about 3 MB, measured as the first burst read after a resume in a debugging run) absorbed everything a paused reader was sent in 40 s, so no coalesced-progress frame and no slow-client close happened (`live.slow_client` is zero in every profile). The coalescing and overflow paths are covered by the Live package's own tests, not by this load. The slow-client counters in `pim_live_*` metrics are not wired in `@pim/v2-live` (the hub does not increment them), so Live's own view of it could not be read.
- **Coding transcript flood:** the flood appended 93 and 92 events/s at 5 and 50 runs, but only 63 at 500 and 24 at 1,000, because its writes compete for the same saturated PostgreSQL. The Forge projection lagged by up to 665, 1,274 and 1,698 events at 50, 500 and 1,000 runs and caught up after the load.
- **Memory:** the Runner processes dominate: 0.35 GB for two at 5 runs, 1.7 GB for nine at 500 and 3.2 GB for seventeen at 1,000 (each about 175-190 MB); Gate and Live are 180-280 MB each. PostgreSQL's PSS peaked at 0.9 GB. The load generator peaked at 0.23 GB.
- **Durability:** WAL flushes were 300-480 per second at about 0.2-0.5 ms each (where the JSON has a mean; some runs left it empty), so the local disk's fsync is fast; a network volume would slow every commit.
- **Not measured:** real model providers, tools in the turns, a separate PostgreSQL host or load generator, PgBouncer, Kubernetes, replication, and stored chats with long histories (the idle chats are empty). The turn-latency percentile at 500 comes from 9 turns and at 5 and 50 from 51 and 177; one run of each profile is one sample, not a distribution. The earlier benchmark in `bench-results/2026-11-16-integrated-5-50.json` is the same test before this extension (no baseline, 40 ms polls, fsync off).

### Reproducing both harnesses, and what they failed

Two harnesses exist; both artifacts are kept. **Neither load figure is a claim of scale acceptance, and the one-process result must never be quoted as one.**

```sh
# Prerequisites: PostgreSQL 17 (packages/v2-runtime/scripts/ensure-postgres.sh) and nats-server (scripts/v2-bench/install-nats.sh, or PIM_NATS_BIN=/path/to/nats-server).

# 1. Separate OS processes (the realistic one; `ed372aa`): Gate, Live+Projector and Runners are each a Node process.
node scripts/v2-bench/integrated.mjs --profiles 5,50,500,1000 --window 30
#    artifact: packages/v2-server/bench-results/2026-11-17-integrated-5-50-500-1000.json
#    CI runs its short form: pnpm --filter @pim/v2-server exec vitest run test/integrated-bench.test.ts   (5 and 50 runs)

# 2. One process (the first, easier run; `1dcecd0`): Gate, Live, Runners and Projector share one Node process and an in-process scripted model.
node scripts/v2-bench/integrated-inprocess.mjs --profile 5 --profile 50 --profile 500 --profile 1000
#    artifacts: packages/v2-server/bench-results/2026-11-17-integrated-{5,50,500,1000}.json  (test: test/integrated-bench-inprocess.test.ts, opt-in through PIM_BENCH_INPROCESS)
```

Both ran once per profile on one 4 vCPU sandbox that also hosted the load generator, PostgreSQL and NATS. The 500 and 1,000 profiles were not repeated for this integration.

**Honest failures (kept, not rounded off):**

- **The relative budget (p95 at most 20% above the warm baseline) failed from 50 active runs upward in both harnesses:** multi-process 15.3 ms against a baseline of about 10 ms (+59%), then 85.6 ms at 500 and 451 ms at 1,000; one process 54 ms against 12 ms (+350%), then 78 ms at 500 and 1,000. Only 5 runs met it.
- **In the multi-process harness 1,000 active runs also missed the absolute budget (p95 under 250 ms) at 451 ms.** The machine was at 100% CPU, **no turn finished inside the 30 s window** (every turn eventually landed and the projection caught up 82 s after the load), and **only 418 of 1,000 runs had been admitted when the window opened**. At 500 runs 327 of 500 were admitted and a turn took 34 s against 2.8 s alone.
- **The slow-reader path was not exercised:** a paused WebSocket's operating-system buffer (about 3 MB) absorbed every frame sent in 40 s, so no coalesced-progress frame or slow-client close happened in either harness; that path is covered by Live's own tests only.
- The one-process harness reached about 100 commits/s with the process at 84-88% of a core and met the absolute budget at every size (worst p95 78 ms). That is the easier configuration and says nothing about 1,000 simultaneous streams.

## Integrated qualification in one process (first run)

*This is the first integrated run, made by `1dcecd0`'s harness: Gate, Live, Runners and Projector in **one Node process** with a scripted model injected in-process. That harness was replaced by the multi-process one below (same test file, same script); these results are kept in `packages/v2-server/bench-results/2026-11-17-integrated-{5,50,500,1000}.json` and are not reproducible from the current script.*

The reference-writer numbers above say what PostgreSQL, Node and NATS do under a streaming write pattern. These are measured on the real thing: `packages/v2-server/test/integrated-bench.test.ts` starts the real Gate, Live, Runners and Projector (the `@pim/v2-server` roles), real PostgreSQL 17 with the non-superuser role logins and row-level security, `nats-server`, an S3 server, and a scripted streaming model (25 tokens/s, a 100-character answer, so each turn commits several partial messages). `scripts/v2-bench/integrated-inprocess.mjs` runs it on a PostgreSQL it starts itself with durability on (the test suite's default cluster has `fsync` off) and `max_connections` 1000; the bounded CI run is the same test at profiles 5 and 50. Raw results: `packages/v2-server/bench-results/2026-11-17-integrated-<n>.json`.

**What a profile does.** N people (N tenants) each have one chat that streams and three idle stored chats that do not (active runs and idle chats are counted apart; the idle chats are listed, never run). One person's foreground reads, `GET /api/snapshot/sidebar` and `GET /api/sessions` through the Gate, are measured by four closed-loop clients, first warm and idle for 6 s (after a 2 s warm-up) as the baseline, then through the whole load, so both budgets come from one run: warm p95 under 250 ms, and at most 20% worse than that baseline. During the load a Live client that never reads its socket, a Live client whose socket is cut 4 s in (it must reconnect and resume), and a flood of coding-thread projection writes (40 rows every 100 ms) run beside the turns. For 5 and 50 people each person sends 8 turns in sequence in the qualification run (2 in the bounded CI run), so the load lasts long enough to measure; for 500 and 1,000 every person sends one turn at once, all started together.

**Machine and versions.** 4 vCPU (Intel Xeon 2.6 GHz), 7.8 GB, Node 26.13.1, PostgreSQL 17.11 with `fsync`, `full_page_writes` and `synchronous_commit` on and `shared_buffers` 256 MB, nats-server 2.10.22. Gate, Live, the two Runners and the Projector share **one Node process**, because the scripted model is wired in through in-process hooks; PostgreSQL and NATS are separate processes. That is the main limit of these numbers: the whole product shares one event loop.

Latencies in ms as p50/p95/p99, baseline → under load; "answer readable" is seconds from a person's send until the answer is readable in the projection (p50 / p99).

| Active runs | Turns each | Idle chats | Answer readable (s) | Runtime commits/s | Sidebar | Session list | p95 regression sidebar / sessions | Node process CPU (of one core) | Machine CPU | Max projection lag (commits) | RSS MB: stack process / PostgreSQL (sum of backends) |
|---:|---:|---:|---|---:|---|---|---|---:|---:|---:|---|
| 5 | 8 | 15 | 1.3 / 1.6 | 45.5 | 9/16/20 → 8/19/32 | 9/16/20 → 7/18/26 | +18.8% / +12.5% | 72% | 40% | 16 | 261 / 1,012 |
| 50 | 8 | 150 | 4.5 / 7.1 | 95.1 | 8/12/14 → 23/54/90 | 8/12/14 → 22/54/98 | +350% / +350% | 88% | 59% | 523 | 274 / 2,902 |
| 500 | 1 | 1,500 | 54.7 / 67.0 | 94.7 | 8/12/14 → 20/78/112 | 8/12/15 → 18/77/104 | +550% / +542% | 86% | 58% | 1,254 | 382 / 2,829 |
| 1,000 | 1 | 3,000 | 88.7 / 115.3 | 108.9 | 7/10/13 → 10/78/109 | 7/10/15 → 9/74/107 | +680% / +640% | 84% | 59% | 1,270 | 402 / 3,619 |

**Results against the two budgets.**

- **Warm p95 under 250 ms: met at every size**, on both reads (worst 78 ms, at 500 and 1,000 runs). The single worst read was 653 ms (500 runs): the budget is about p95, and tails exist.
- **At most 20% worse than baseline: met only at 5 runs** (+18.8% and +12.5%; the baseline p95 is 16 ms, so the limit is 3 ms and this is close to run-to-run noise). It is **missed from 50 runs up**, by a wide margin: the p95 goes from 11-12 ms to 54-78 ms. On the real stack the reads cost more than the reference writer's (a Gate request with authentication and a tenant transaction) and share the process with every Runner.
- **Throughput is capped by the one Node process, and that is the bottleneck.** From 50 runs up the stack process uses 84-88% of one core (`stack_node_process_cpu_pct_of_one_core`), the machine is only 58-59% busy, the event loop never stalls long (p99 delay under 20 ms, max 54 ms, against a 10 ms sampling floor), and the runtime sustains about 95-109 commits per second (about 8-9 completed turns per second) whatever N is. So 500 simultaneous turns take 55-67 s to become readable and 1,000 take 89-115 s, against about 4 s for one turn alone. Doubling the Runner pool (`PIM_BENCH_RUNTIME_POOL=80`, 4 Runners, a bigger Gate pool) changed nothing (500 runs: p50 61 s, 82 commits/s), which rules out the connection pools and the Runner count as the limit when they share one event loop. Admission itself is not the limit: the Gate admitted 1,000 messages in 2.5 s, p95 803 ms.
- **Projection lag** (commits the Projector had not yet projected, summed over partitions) peaked at 523 at 50 runs and about 1,250-1,270 at 500 and 1,000: it falls behind during the burst and drains; no turn was lost, every answer landed and was readable.
- **Live:** the slow client stayed connected and received nothing it could not hold (at these event sizes its buffer never reached the coalescing threshold, so no update was coalesced and no client was disconnected: that path is covered by Live's own tests, not by this load); the cut client reconnected and was live again in 0.3-0.5 s at every size and kept receiving updates.
- **Memory:** the stack process peaked at 261-402 MB (about 0.4 MB per concurrent run); PostgreSQL's summed RSS (0.9-3.6 GB) counts shared buffers once per backend and overstates real use.
- **PostgreSQL** did 1,800-3,800 transactions per second (reads included); fsync was not the limit (mean WAL flush about 0.25-0.3 ms).

**What to do about it.** 1,000 simultaneous streaming conversations are not reachable on this stack in one process on this machine: they complete, but at about 100 commits per second the queue drains in two minutes. The next measurement needs Runners (and Gate and Live) in separate processes, which needs the model hooks to be configurable outside the process (the harness injects a scripted provider in-process), and a machine with more cores. It was not done here, and no number for it is claimed. Per-turn cost in the Node process is the thing to profile first.

## Executed in the sandbox, and not

**Actually executed here:**

- A physical PostgreSQL base backup (`pg_backup_start`/`pg_backup_stop`) with WAL archiving, a mutation, a restore (base only and point in time) and the post-restore `needs_reconciliation` safety pass with zero duplicate effects and a negative control (`packages/v2-ops/test/backup.test.ts`).
- `kustomize build` and `kubeconform` schema validation of the Kubernetes manifests (Kubernetes 1.30, CloudNativePG, External Secrets, Prometheus Operator), and `loadProcessConfig` against the Compose and Kubernetes environments (`packages/v2-ops/test/deploy.test.ts`).
- Real OS process startup and SIGTERM drain of every role through `node --import tsx src/main.ts <role>` (`packages/v2-server/test/entrypoint.test.ts`, `vertical-slice.test.ts`).
- Export, import, audit and promotion of a synthetic snapshot, and the cutover rehearsal on real roles (`v2-ops/test/migration.test.ts`, `v2-server/test/migration-cutover.test.ts`).
- `deploy/Dockerfile.v2` built and the Compose stack booted with Docker in an orb (PostgreSQL behind PgBouncer in the query path, NATS, SeaweedFS as the object store, Caddy): `scripts/v2-compose/smoke.sh` passes, and in a browser (Chrome with a virtual authenticator) the claim link, the first passkey, sign-out and passkey sign-in, the majordomo chat, live updates and an approval card all worked. With `--scale runner=2`, a chat whose Runner was killed with SIGKILL was answered by the other within 5 seconds.
- `compose-backup.sh` and `compose-restore.sh` against that stack, and the v1 rehearsal into it (above).

**Not executed, so unproven:**

- A real Cloudflare export, a real hostname with TLS, and a real model provider account (the ChatGPT plan sign-in was tested against a stand-in of OpenAI's endpoints).
- The `local-computer`, `coding`, `canvas` and `observability` profiles were not booted.
- The Kubernetes manifests were never applied to a live cluster; CloudNativePG failover and Barman object-store archiving, OpenBao, gVisor isolation and PgBouncer in the live path were never run.
- Real third-party browser sign-in, the vendor CLIs' interactive logins, and any load beyond the measurements above.

## Verification status

| Claim | Evidence | Status |
|---|---|---|
| Export → import → audit parity on a rich synthetic snapshot, quiescence, adoption, idempotency, corruption detection | `test/migration.test.ts` against a real PostgreSQL | Run, passing |
| Fence Worker: alarms consumed without side effects or row loss on Pim, CodingThread, CodingScheduler, Directory and HostOps; authenticated read-only export of every table, blob, kv entry, alarm, R2 and `OAUTH_KV`; exporter end to end | `test/fence.test.ts` in workerd with real SQLite Durable Objects | Run, passing |
| Backup, mutate, restore (base only and point in time), safety pass, zero duplicate effects with a negative control | `test/backup.test.ts`, real PostgreSQL with WAL archiving | Run, passing |
| Redaction, metrics, event-loop and pool signals | `test/observability.test.ts` | Run, passing |
| Compose and Kubernetes configuration | `test/deploy.test.ts`; `kustomize build` and `kubeconform` against Kubernetes 1.30 and the CloudNativePG, External Secrets and Prometheus Operator schemas | Run, passing. **Not applied to a cluster.** |
| Compose stack boots and serves | `scripts/v2-compose/smoke.sh` (CI job `compose`); browser run; Runner SIGKILL failover; v1 rehearsal into it with `verify-v2.mjs` 52/52 and rollback | Run, passing |
| Benchmarks, reference writer | `bench-results/` | Run, numbers above |
| Benchmarks, integrated stack, in one process (5, 50, 500, 1,000 active runs) | `packages/v2-server/bench-results/2026-11-17-integrated-<n>.json` | Run once each; every answer landed; throughput capped near 100 commits/s by the one event loop |
| Benchmarks, integrated, separate OS processes (5, 50, 500, 1,000 active runs) | `packages/v2-server/bench-results/2026-11-17-integrated-5-50-500-1000.json` | Run once on one 4 vCPU machine. **Relative budget failed from 50 runs; absolute budget failed at 1,000 runs (451 ms); scale not accepted** |
| `pg_dump` backup and restore on Compose, with SeaweedFS | `smoke.sh` | Run, passing |
| OpenBao, CloudNativePG failover and restore, gVisor isolation | — | **Not run.** |

## Open items

1. **Landing tables.** They live in `pim_ops` until the application and runtime workstreams define their own in `pim_app` and `pim_runtime`; then the importer's targets move and RLS policies (`owner_id = pim_current_owner_id()`) apply. The external-operation ledger and the Runner's obligations in [The role contract](#the-role-contract) are this workstream's proposal for the runtime workstream to accept.
2. **Legacy table shapes.** The exporter dumps every table whatever its name, so it does not depend on them; the importer's typed promotion (accounts, Auth tables, pi tables, chats) and the quiescence rules read `pim_approvals`, `pim_trigger_*`, `cf_agents_jobs`, `coding_thread` and the pi tables by the names in the audited commit. The first rehearsal on a real export (above) corrected several of them; one on the production deployment, before the cutover, should still come first.
3. **S3.** The application, the promotion and the Compose backup scripts use SeaweedFS over S3; the physical-backup tool (`scripts/v2-backup/run.mjs`) and the importer's object directory still use a directory-backed store.
4. **Rollback after a fence.** Observed locally (a schedule that fell due during the fence fired after the unfence); not observed on Cloudflare (audit open question 6).
5. **Coding-thread pi stores** are kept row for row, not split: each has its own id space, so they cannot share the tenant's id sequence.
