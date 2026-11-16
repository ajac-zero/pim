# @pim/v2-runtime

Pim's portable persistent runtime: pi-durable on PostgreSQL, partitioned by conversation family, with fenced ownership and
a Runner that hosts the partitions. It imports no Cloudflare module and nothing from `src/` or `web/`.

Pinned to `@earendil-works/pi-durable` 1.1.0 plus Pim's patch (`Harness.resumeTask`, the `suspend` retry policy). 1.1.0
has no `wake()` or `onWake`; everything below is built on `Harness.open`, `inspect()`, `resume()`, `resumeTask()`,
`subscribeCommits()`, `subscribeClose()` and `close()`.

## What is in it

| Module | What it is for |
|---|---|
| `storage.ts` | `PgPiStorage`: pi's `Storage` implemented directly on PostgreSQL, one instance per partition and fenced owner. `reconcileAmbiguousCommit` answers whether a batch whose `COMMIT` acknowledgement was lost landed. |
| `ids.ts` | The tenant-wide pi id sequence, leased in blocks (`IdAllocator`). |
| `ownership.ts` | `Steward` and `Lease`: epoch fencing, TTL leases, heartbeat, release with a new-work check, hand-off. |
| `runner.ts` | `Runner` and `ResidentPartition`: claim, host, deliver commands and signals, quiesce, evict, recover, drain. |
| `quiescence.ts` | Decides from `inspect()` and `pi.live` whether a partition needs a process, and until when it may sleep. |
| `signals.ts` | `PartitionInbox`: durable commands and signals; each write wakes the partition in the same transaction. |
| `directory.ts` | `PartitionDirectory`: conversation to partition routing, and the home rule. |
| `splitter.ts` | `planFamilies` and `importLegacySpace`: split a legacy single-SQLite space into families and import it. |
| `admission.ts` | Per-tenant and per-provider admission for model calls, with fairness between tenants. |
| `durability.ts` | Refuses a server whose `synchronous_commit` is weaker than the declared profile. |
| `migrate.ts`, `migrations/0100-0105` | The `pim_runtime` schema; applied under an advisory lock, checksummed. |

## Model

- A **partition** is a conversation family: a conversation and every fork of it. One partition is one pi storage, one
  Harness, one mutation line and one lease owner. Unrelated chats, group-chat seats, delegated task chats, trigger chats,
  reviews, visits and post-idle continuations are separate partitions, so a person's active threads run concurrently.
- **pi ids are one tenant-wide namespace.** A `PartitionId` only says where a record is stored. Ids are minted from
  blocks (default 256) leased from `tenant_id_allocators`, so minting touches the shared row once per block, gaps are
  allowed, and ids stay increasing within a partition because an owner's block is dropped when it closes. A commit that
  writes an id above the allocator's mark (an import, an explicit id) raises the mark and drops the block. Everything is
  bounded by `Number.MAX_SAFE_INTEGER`; the last block is short, and then minting fails with "ID space is exhausted".
- **Seq is per partition.** It strictly increases and may have gaps. The import keeps every original commit Seq.
- **Home.** Only a tenant's `home` partition holds conversation 1 and the root-attached `optmem.nap`. Three layers keep
  it so: the Runner never calls `Harness.root()` on another partition (the Harness it hands out throws), the storage
  rejects a commit that creates conversation 1 anywhere else, and a trigger on the directory table refuses the row.
  `ROOT_SESSION` routes to home through `PartitionDirectory.routeConversation`.
- **Closure.** A commit is rejected when a fork parent, entry, task, submission or document names a conversation outside
  its partition.
- **Records are stored as the JSON text pi wrote** (`text` columns), so key order survives and strings with lone
  surrogates round-trip, which `json` and `jsonb` refuse. Indexed identities (task and document kinds, document keys,
  request ids) go through `ident()`, an injective encoding that PostgreSQL accepts for any JavaScript string.
- **Session-scope documents** live in the partition that wrote them. The import puts the legacy ones in home. Pim has none.

## Ownership

`Steward.acquire` and `claimNext` bump `partitions.owner_epoch` when the lease is free or expired (database clock only).
`PgPiStorage.openForOwner` checks `(owner_id, owner_epoch, lease_expires_at)` in PostgreSQL before `Harness.open`, which
rewrites `running` tasks to `pending`. Every commit starts with one `UPDATE partitions ... WHERE owner_epoch = $e AND
lease_expires_at > clock_timestamp() RETURNING next_seq - 1`, which is the fence and the Seq at once; a stale owner gets no
row and fails with `OwnershipLost` (a `StorageRejected`, so pi knows nothing committed and the Session is not poisoned).

A `Lease` measures its own deadline on the local monotonic clock from the database's remaining time, minus a safety
margin, so clock skew never extends it. When renewal is refused, or the deadline passes, the lease aborts its signal:
the Harness closes, and model calls (through `admitModels`) and tool invocations are aborted.

## Commit

One transaction: fence and Seq; claim ids in `record_ids`; conversations (and their directory rows); closure check;
entries; tasks; submissions; documents and revisions (copies read the source as committed before the batch); a
`commit_receipts` row; a `runtime_outbox` row listing the changed records; `pg_notify('pim_runtime_outbox')`. The
transaction sets `synchronous_commit` to `on`. The Seq is returned only after `COMMIT` is acknowledged.

A failure before `COMMIT` is sent, or an error answer to `COMMIT`, is a `StorageRejected` (rolled back). A transport
failure after `COMMIT` is sent is `AmbiguousCommit`: pi poisons the Session, the storage refuses further work, and the
Runner closes the Harness, runs `reconcileAmbiguousCommit` (lock the partition row with a timeout; terminate the old
backend if it will not release it; look up the receipt), and reopens on the same lease. A command being delivered is
retried with the same request id, which pi deduplicates, so the batch is neither lost nor applied twice.

## Activation without `wake()`

A partition is claimable unless its owner declared it quiescent with a conditional write on `due_work.activation_seq`.
Everything that gives a partition work (`PartitionInbox.enqueueCommand`, `recordSignal`, hand-off) bumps that sequence in
its own transaction, so `Steward.release` (one statement checking the sequence, the command inbox, the unsettled
signals and the outbox) cannot release a partition work has just reached. A notification (`pim_runtime_wake`) is a hint
only; polling the due-work table is enough.

`assessInspection` treats `suspended` and `blocked` tasks as parked, a `waiting` task as parked when everything it waits
on is, and a running or ready task as parked only when its checkpoint (`until`, `pollAt`) or `pi.live`
(`generation.retry.at`, `deferred.pollAt`) says it sleeps at least `longWaitMs`; that time becomes `due_work.next_due_at`.
A new task kind that sleeps long and does not put its due time in its checkpoint will pin a Runner.

**Early approvals.** Patched 1.1.0 remembers a `resumeTask` for a task that has not suspended yet only in memory. A
decision is recorded in `durable_signals` first, and the owner calls `resumeTask` for every unsettled signal at every
activation. A signal is settled when `resumeTask` returns `resumed` or `terminal`, or, after `requested`, when the task is
seen to wait and wake (or end). A tool's `beforeTool` hook should read the decision from `PartitionInbox.signalByKey`, so
it gives the same answer after a restart.

## Running it

`new Runner({ db, harnessOptions, homeRoot, chatAgent, maxResident, admission, ... })`, then `start()`. Built-in command
kinds: `submit` and `create_conversation`; more through `commands`. `drain(deadlineMs)` stops claiming, releases quiet
partitions atomically, and closes and hands off busy ones with their wake intent. At `maxResident` a resident that needs
no owner is released at once, least recently used first.

## Tests

The tests need PostgreSQL. `test/support/global-setup.ts` starts a throwaway cluster on a free port from the installed
binaries (`scripts/ensure-postgres.sh` installs them), or uses `PIM_V2_PG_URL`. Each file creates its own database.

```sh
pnpm --filter @pim/v2-runtime test
```

`conformance.test.ts` runs pi's `registerStorageConformance` (24 cases in 1.1.0) and the benchmark seeds against
`PgPiStorage`. The rest cover fencing, split brain, lease expiry mid-stream, early signals and crashes, the deactivation
race, ambiguous `COMMIT` (a TCP proxy drops the connection around a real `COMMIT`), the legacy import, eviction, drain,
admission, row-level security and migrations.

## Deployment notes

- Row-level security (`pim.tenant_id`) is a second fence: every query also filters by tenant. Connections need session
  pooling or direct connections, not a transaction-pooling proxy, and a role that is not a superuser. The migration grants
  `pim_runtime_app` when that role exists.
- Run with `synchronous_commit = on` (and a synchronous standby for failover safety). `Runner.start()` checks it.
- The outbox is written but not pruned or consumed here; consumers keep `(partition_id, last_seq)` in `outbox_consumers`.
- A very large fork tree is one partition; splitting a family is not done here.
