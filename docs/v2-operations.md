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
| `packages/v2-ops/src/bench/` | Multi-tenant load benchmark; `bench-results/` holds the measured runs. |
| `packages/v2-ops/sql/` | Migrations `0500`-`0599`: cutover record, external-operation ledger, due work, remote threads, import landing tables, role grants, restore fence. |
| `deploy/compose/`, `deploy/k8s/`, `deploy/observability/` | Compose stack, Kustomize manifests, Grafana dashboard, Prometheus rules, runbooks. |
| `scripts/v2-migrate/`, `scripts/v2-backup/`, `scripts/v2-bench/` | Entry points for the tools above. |

The package imports no other Pim package and nothing from `src/`; the landing schema is its own (`sql/0501_import_landing.sql`) and is meant to be reconciled with `@pim/v2-contracts` when that exists (see [Open items](#open-items)).

## The role contract

One Pim image runs one role per container, chosen by `PIM_ROLE`: `migrator`, `gate`, `live`, `runner`, `forge`, `maintenance`, `canvas`, `relay`. Both deployments assume the same contract; the roles themselves belong to the other workstreams.

- `GET /healthz` (process is up) and `GET /readyz` (can serve) on `PIM_HTTP_PORT`; Prometheus metrics on `PIM_METRICS_PORT` (9464) at `/metrics`.
- Configuration is environment: `PIM_PUBLIC_URL`, `PIM_CONTENT_ORIGIN`, `PIM_APPS_ORIGIN`, `PIM_DATABASE_URL`, `PIM_NATS_URL`, `PIM_OBJECTS_{ENDPOINT,BUCKET,ACCESS_KEY,SECRET_KEY}`, `PIM_INGRESS_SECRET`, `OTEL_*`.
- Envelope keys: `PIM_KEK_CURRENT` names the key that wraps new data keys; keys come from `PIM_KEK_<id>` (Compose) or files named `<id>` in `PIM_KEK_DIR` (Kubernetes).
- The Runner, on `SIGTERM` or `POST /drain`, stops claiming work and hands its partition leases back within `PIM_DRAIN_WINDOW_SECONDS` (90).
- A Runner must refuse to claim work while the newest row of `pim.ops_restore` is not `reconciled`, and must never execute a `pim.external_operations` row whose status is `needs_reconciliation`, nor a `pim.pi_tasks` row with a `hold`.

## Compose (homelab)

```sh
cd deploy/compose && cp .env.example .env     # replace every CHANGE_ME
docker compose up -d                          # caddy, postgres 17, pgbouncer, nats, seaweedfs, migrator, gate, live, runner, forge, maintenance
docker compose up -d --scale runner=3
docker compose --profile canvas|computer|coding|observability up -d
```

No Kubernetes, Temporal, Cloudflare or AWS service is involved. The core stack runs with every optional profile off. PostgreSQL runs with `fsync`, `full_page_writes` and `synchronous_commit` on, and nothing in the stack turns them off (a test fails if anything does). `postgres/init/00-roles.sh` creates `pim_migrator` (owns the schema), `pim_app_role`, `pim_runtime_role` and `pim_readonly_role` (none superuser or `BYPASSRLS`, each with a connection limit and statement timeouts); applications connect through PgBouncer in transaction mode, while the migrator and maintenance connect directly (advisory locks and long statements do not belong in transaction pooling). The proxy sets `X-Pim-Client-IP` and `X-Pim-Ingress-Secret` on every request, as the existing `celld` profile does.

## Kubernetes

Kustomize: `kustomize build deploy/k8s | kubectl apply -f -` (needs CloudNativePG, an ingress controller and cert-manager). `overlays/openbao` takes the Secrets from OpenBao or Vault through External Secrets; `overlays/monitoring` adds the PodMonitor, the `PrometheusRule` and the Grafana dashboard (build it with `--load-restrictor LoadRestrictionsNone`, because the dashboard JSON lives in `deploy/observability/`).

- One Deployment per role, each with a PodDisruptionBudget, and an HPA for all but `maintenance`. The Runner has `terminationGracePeriodSeconds: 150`, a `preStop` that calls `/drain`, and an HPA that scales down one pod per two minutes after a ten-minute quiet window, because every Runner that leaves is a lease handoff.
- PostgreSQL is a CloudNativePG `Cluster` of three, with Barman object-store base backups, WAL archiving and a 30-day retention for point-in-time recovery, and a PgBouncer `Pooler` in transaction mode. CloudNativePG uses Barman for this, not pgBackRest.
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

Services call `createPimMetrics()`, `monitorEventLoop()`, `instrumentPool()` and `serveMetrics()`; the services' own call sites belong to their workstreams.

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

## Backup and restore

`scripts/v2-backup/run.mjs backup|restore|post-restore`. The tested engine is a **physical base backup through the low-level API** (`pg_backup_start`, copy, `pg_backup_stop`) with archived WAL, so a restore can stop at the end of the backup or at any chosen instant after it, plus every object with its SHA-256 and the key material's names and fingerprints. `scripts/v2-backup/compose-backup.sh` is a logical `pg_dump` alternative for Compose; it was **not run here** because the sandbox has no `pg_dump` and no Docker daemon. On Kubernetes, CloudNativePG's Barman backups and WAL archive are the equivalent and `ScheduledBackup` runs them daily.

**The restore hazard is real and the safety pass exists for it.** A restored database is older than the world. Operations it shows as pending may already have run after the backup; operations in flight may have finished or half-finished. Before any Runner starts, `post-restore` moves every `pending` and `in_flight` external operation, and every effect named in a journal of effects known to the outside world (`--known-effects`), to `needs_reconciliation`; holds unfinished tool tasks; turns every schedule whose time has passed into `recompute` with the missed time recorded; and marks the restore `reconciled`. Runners refuse to start until then. The database alone cannot know what happened after the backup, so keep an effects journal outside it (provider-side logs, or the failed database's last rows) and pass it in. The pass is idempotent.

Restore order: stop every Runner; `restore`; start PostgreSQL; `post-restore`; check; start Runners. The key ring must come from its own backup: a database restored without it cannot open any sealed secret.

## Load qualification

`node scripts/v2-bench/run.mjs --profile 5 --profile 50 --profile 500 --profile 1000 [--mode single|batched]`; `scripts/v2-bench/install-nats.sh` fetches the pinned NATS server first.

**What it is, and is not.** The harness runs a real PostgreSQL 17 (durability on), a real NATS server, a simulated model provider (time to first token, token interval, tool latency, error injection all parameters), several Runner processes, a Live process with WebSocket fanout and slow-client coalescing, a Gate process with a bounded pool, and a browser process holding WebSocket clients (some that never read) and issuing the two foreground reads. **The Runner is a reference write path, not the Pim Runner**: it reproduces the storage pattern the audit describes for a streaming conversation (a partial message every 250 ms, tool intent and result, the final message; every commit one fenced statement that checks the lease epoch and takes the partition's next commit sequence; an event published after commit) against this package's schema. It measures PostgreSQL, Node and NATS under that pattern, and says nothing about the real Runner until that Runner's writes are shown to follow it. Active streaming runs are counted separately from stored idle conversations (20 history entries each, 100-200 per tenant); every profile has both. A run is continuously streaming: a turn is 400 ms to first token, 120 tokens at 25 ms, a 300 ms tool call and a 200 ms pause.

**Measured here** (4 vCPU, 7.8 GB, Node 26.13, PostgreSQL 17.11 embedded, `shared_buffers` 256 MB, fsync median 0.57 ms for an 8 KB write on the temp disk; client, server and load generators all share the machine; 25 s measured window after a ramp; foreground probes are 4 closed-loop clients, half sidebar and half session reads; "p95 under load" is the warm p95 in the window). Raw output is in `packages/v2-ops/bench-results/`.

| Active runs | Tenants | Idle chats | Mode | Commits/s | Commit p50 / p99 (worst Runner), ms | Sidebar p95 base → load, ms | Session p95 load, ms | p95 regression sidebar / session | Machine CPU | Late turns |
|---:|---:|---:|---|---:|---|---|---:|---|---:|---:|
| 5 | 3 | 300 | single | 20.8 | 1.4 / 3.8 | 2.37 → 2.03 | 2.46 | −15% / −15% | 16% | 0% |
| 50 | 10 | 2,000 | single | 212 | 1.2 / 2.9 | 1.86 → 2.25 | 2.68 | +21% / +17% | 25% | 0% |
| 500 | 50 | 10,000 | single | 2,024 | 2.5 / 41 | 2.29 → 8.78 | 9.40 | +283% / +252% | 88% | 0% |
| 500 | 50 | 10,000 | batched | 2,057 | 11.0 / 245 | 2.48 → 4.20 | 4.81 | +69% / +70% | 77% | 0% |
| 1,000 | 100 | 20,000 | single | 3,313 | 178 / 1,554 | 2.84 → 46.3 | 46.0 | +1,528% / +1,315% | 98% | 90% |
| 1,000 | 100 | 20,000 | batched | 3,412 | 161 / 1,264 | 2.49 → 9.65 | 10.7 | +287% / +273% | 97% | 0.8% |

What this says, within those limits:

- **The absolute foreground budget (warm p95 under 250 ms) held in every run**, by a factor of 5 at the worst (46 ms at 1,000 runs, single commits, the machine at 98% CPU).
- **The relative budget (at most 20% worse than at baseline) was met at 5 runs, missed narrowly at 50 (+0.4 ms on a 1.9 ms baseline, which is inside run-to-run noise: an earlier 50-run measurement gave +4%), and missed from 500 up.** With a baseline of two milliseconds, 20% is under half a millisecond, so this criterion is dominated by CPU contention on a machine that is also running the load. The sandbox cannot say whether it would hold on separate hosts.
- **Saturation:** at 500 runs the machine is at 77-88% CPU and every run keeps pace; at 1,000 runs with one commit per statement it is saturated (98% CPU, 90% of turns more than twice as slow as the model and tool need, commit p99 1.5 s). Batching commits into one transaction per 5 ms per Runner kept 1,000 runs on pace (0.8% late) with commit p99 still 1.3 s. 1,000 simultaneously streaming runs is therefore beyond this 4-vCPU sandbox with a comfortable margin, and about at its limit with batching.
- PostgreSQL did 600 to 3,600 transactions per second (reads included) and 150 to 1,200 WAL flushes per second; mean WAL flush 0.3 to 1.0 ms. The fsync here is fast; a network volume would change every commit latency above.
- Live delivered events to 310 browsers with p99 lag 40-87 ms at 1,000 runs. No client was coalesced or disconnected: the slow clients never exceeded the coalescing threshold at these event rates, so that path is covered by the unit tests, not by this load.
- Memory: PostgreSQL's summed RSS is 0.3-7 GB and counts shared buffers once per backend, so it overstates real use; Node processes 0.7-1.5 GB together.
- Not measured: the real Runner, real models, a separate PostgreSQL host, replication, PgBouncer in the path, Kubernetes. 1,000 runs are 1,000 streaming conversations, not 1,000 stored agents.

## Verification status

| Claim | Evidence | Status |
|---|---|---|
| Export → import → audit parity on a rich synthetic snapshot, quiescence, adoption, idempotency, corruption detection | `test/migration.test.ts` against a real PostgreSQL | Run, passing |
| Fence Worker: alarms consumed without side effects or row loss on Pim, CodingThread, CodingScheduler, Directory and HostOps; authenticated read-only export of every table, blob, kv entry, alarm, R2 and `OAUTH_KV`; exporter end to end | `test/fence.test.ts` in workerd with real SQLite Durable Objects | Run, passing |
| Backup, mutate, restore (base only and point in time), safety pass, zero duplicate effects with a negative control | `test/backup.test.ts`, real PostgreSQL with WAL archiving | Run, passing |
| Redaction, metrics, event-loop and pool signals | `test/observability.test.ts` | Run, passing |
| Compose and Kubernetes configuration | `test/deploy.test.ts`; `kustomize build` and `kubeconform` against Kubernetes 1.30 and the CloudNativePG, External Secrets and Prometheus Operator schemas | Run, passing. **Not applied to a cluster; the Compose stack was never started**: this sandbox has no Docker daemon. |
| Benchmarks | `bench-results/` | Run, numbers above |
| `pg_dump` script, S3 and SeaweedFS paths, OpenBao, CloudNativePG failover and restore, gVisor isolation | — | **Not run.** The importer and backup tools use a directory-backed object store here; an S3 client is not written. |

## Open items

1. **Landing schema.** `@pim/v2-contracts` did not exist when this was built. The landing tables, the external-operation ledger and the Runner's obligations in [The role contract](#the-role-contract) are this workstream's proposal; they must be reconciled with the Runner and storage workstreams before a real cutover.
2. **Legacy table shapes.** The exporter dumps every table whatever its name, so it does not depend on them; the importer's typed promotion (accounts, Auth tables, pi tables, chats) and the quiescence rules read `pim_approvals`, `pim_trigger_*`, `cf_agents_jobs`, `coding_thread` and the pi tables by the names in the audited commit. A rehearsal on a real export, before the real cutover, should come first.
3. **S3.** An S3-compatible `ObjectStore` implementation is needed for SeaweedFS (the interface is four methods).
4. **Rollback after a fence.** Whether the Scheduler, Directory and HostOps recompute their alarms on first use after rolling back from the fence Worker is unobserved (audit open question 6).
5. **Coding-thread pi stores** are kept row for row, not split: each has its own id space, so they cannot share the tenant's id sequence.
