# Pim operational runbooks

One section per alert in `prometheus/pim-alerts.rules.yml`; the alert's `runbook` annotation links to the heading. Every command below is read-only unless it says so. Metric names
are the ones in `packages/v2-ops/src/observability/signals.ts`; none of them carries a person, a chat or any content, and neither do traces unless the operator turned content capture on.

How to look: the dashboard `Pim operations` (Grafana uid `pim-operations`); `kubectl -n pim logs deploy/pim-<role>` or `docker compose logs <role>`; PostgreSQL through the read-only role.

## PimGateLatencyHigh

The Gate's p95 is over 250 ms (the warm foreground budget). Check, in order: the Gate event loop (`PimEventLoopLag`), the pool wait (`PimPgPoolWaiting`), the slowest routes (panel *Gate p95 by route*),
then PostgreSQL (`pg_stat_activity` for long queries, CloudNativePG dashboards for CPU). If a deploy just rolled, compare with the previous version before anything else. Mitigate by scaling the Gate
(`kubectl -n pim scale deploy/pim-gate --replicas=N` or the HPA's max) when CPU-bound; if PostgreSQL is the cause scaling the Gate makes it worse, so shed load first (pause heavy Runners: see *PimInboxStale*).

## PimGateErrorRate

More than 2% of Gate responses are 5xx. Look at the Gate's logs for the first error class, then at PostgreSQL reachability (`pim-pg-pooler-rw` or `pgbouncer`), then NATS and object storage. A rollout that fails
readiness leaves the old pods serving: `kubectl -n pim rollout status deploy/pim-gate`. Roll back with `kubectl -n pim rollout undo deploy/pim-gate` when the errors began with the deploy.

## PimEventLoopLag

A Node service's event loop p99 delay is over 100 ms for five minutes. The service is CPU-bound or something synchronous is blocking it. Check the service's CPU against its limit (throttling shows as lag),
its heap (`nodejs` metrics or `kubectl top pod`), and whether a single tenant is producing a flood (coding transcript floods are the usual cause on a Runner). Scale out the role, or restart the one pod whose lag is
far above its peers. A Runner restart hands its leases to the others: let it drain (`kubectl delete pod` honours the 150 s grace period).

## PimPgPoolWaiting

Callers wait for a PostgreSQL connection. Either the pool is too small for the load or connections are held too long. Check `pim_pg_pool_connections` by service, then `SELECT state, count(*) FROM pg_stat_activity GROUP BY 1`.
Many `idle in transaction` sessions mean a code path holds a transaction across a slow call: find it by `query_start` and report it. Do not raise `max_connections` first: raise the PgBouncer pool for that role only if PostgreSQL has CPU to spare.

## PimPgPoolWaitSlow

Same as *PimPgPoolWaiting* but below the point where callers fail: connections are scarce. Treat it as the warning before pool exhaustion.

## PimCommitSlow

Commit batches take over 250 ms at p99. Commits are synchronous: look at WAL flush time (`SELECT * FROM pg_stat_wal`, `wal_sync_time`), disk latency on the PostgreSQL volume, and, with synchronous replication, the standby's
replication lag (`PimPostgresReplicationLag`): a slow standby slows every commit by design. See the durability tradeoff in `deploy/k8s/base/postgres.yaml` before changing anything.

## PimInboxStale

An inbox item has waited over a minute: Runners are not keeping up, or no Runner owns the partition. Check `pim_partition_leases_held` (is any Runner holding leases?), the Runner pods (`kubectl -n pim get pods -l app.kubernetes.io/component=runner`),
and `PimFencingRejects`. If Runners are healthy but saturated, scale them (the HPA scales down slowly on purpose). To shed load without data loss, scale Runners to fewer than needed for new work only as a last resort: inboxes are durable and drain once capacity returns.

## PimDueWorkOverdue

Scheduled work is over two minutes late. Same causes as *PimInboxStale*, plus clock problems: check node time sync. After a restore or a cutover, due work older than the restore point was deliberately recorded as missed and is not overdue (see the migration and backup runbooks).

## PimFencingRejects

Writes are rejected for stale lease epochs for 15 minutes. That is the fence doing its job: some process kept writing after losing its lease. Find the offender: the rejecting log lines name the partition and the epoch; the Runner whose `pim_partition_leases_held`
still counts that partition is the stale one. Restart that Runner. If it recurs, suspect a stuck event loop (see *PimEventLoopLag*) or an expired-lease clock skew.

## PimLeaseChurn

Leases move often: Runners are crash-looping, being scaled up and down rapidly, or failing health checks. `kubectl -n pim get pods` for restarts; check the HPA's recent scaling events; look for OOMKilled in `describe pod`.

## PimProjectionLag

A projection (sidebar, usage, search) is more than 30 s behind the commits it reads. People see stale lists, not wrong data: the commits are safe. Check the projecting role's logs and CPU; restart is safe, projections resume from their cursor.

## PimLiveReplayLag

Browsers that reconnect take over 5 s to catch up by cursor. Live reads the gap from PostgreSQL: check query duration for `pi_entries` reads and Live's CPU. A thundering herd after a Live restart is expected for a minute; sustained lag is not.

## PimSlowClientOverflow

Live is dropping clients whose send buffers overflow. A few per hour are normal (a phone in a tunnel); a sustained rate means Live itself is slow or the coalescing threshold is wrong for the event rate. Check `pim_live_slow_client_coalesced_total` alongside: coalescing should absorb slow clients long before overflow.

## PimModelTimeouts

A model provider returns 524 (gateway timeout) for more than 5% of requests. It is the provider or a proxy in front of it. Runs retry with backoff and then fail with a clear error; there is nothing to fix in Pim. Switch the affected agents to another provider from the admin settings if it persists.

## PimModelRateLimited

A provider is answering 429. Lower concurrency for that provider (admin settings), or raise the provider quota. Runs wait and retry; they are not lost.

## PimSpendSpike

Hourly spend crossed the threshold. Find which provider and kind from the *Spend* panel, then which tenant from the admin usage view (spend is deliberately not labelled by tenant in metrics). A runaway loop is stopped by pausing the tenant's runs; limits in settings cap daily spend per person.

## PimTargetDown

Prometheus cannot scrape a Pim service. The pod is down, restarting, or a NetworkPolicy blocks the scrape (the `monitoring` namespace must be allowed: `allow-metrics-scrape`). `kubectl -n pim get pods` and `describe`.

## PimPostgresReplicationLag

A standby is more than 30 s behind. With `dataDurability: required` and one synchronous standby, a lagging standby that is the only synchronous one stalls writes; CloudNativePG promotes another standby to synchronous when it can. Check `kubectl cnpg status pim-pg`.
Do not switch to `preferred` durability during an incident without a decision from whoever owns the data-loss risk: see the tradeoff in `deploy/k8s/base/postgres.yaml`.

## PimPostgresBackupOld

No successful backup for 36 hours. Check `kubectl -n pim get backup,scheduledbackup`, the operator's logs, and object-store credentials and reachability. Until a backup succeeds the restore point is old: run an on-demand backup (`kubectl cnpg backup pim-pg`) once the cause is fixed,
and run a restore rehearsal (`scripts/v2-backup/`) afterwards to prove the new backup restores.
