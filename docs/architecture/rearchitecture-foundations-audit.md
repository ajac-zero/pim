# Pim re-architecture foundations — read-only design audit (revision 2)

**Status:** audit only. No implementation, flag, migration, deployment or production change is authorised or made by this document.
**Branch:** `pim/rearchitecture-foundations-audit`. **Audited application commit:** `30818438bdc0581e5960d20d8f30310fd5fbc7b7` (`main`, 2026-11-16); this branch changes only `docs/architecture/**`, so every application `path:line` below is against that SHA.
**Labels:** **[V]** verified by reading code/docs/artifacts for this audit · **[P]** proposed design choice · **[U]** unverified, with the specific open question.
**Checks run (revision 2):** source reading; `npm pack` of pi-durable 1.1.0/1.2.0/1.3.0/1.4.0/1.5.2 with `grep`/`diff` (tarball + Pim's patch equals the installed runtime); `esbuild` normalised comparison of 8 files (inconclusive, see A1); `node scripts/check-internal-identifiers.mjs`. **No Pim or pi test suite was run; every test in this document is proposed.** No capacity or cause claims are made.

## 0. Executive decision summary

1. **Partition = conversation family [P], validated against the data model (A6).** One PostgreSQL pi-durable storage (one Harness, one mutation line, one lease owner) per fork-closed group of conversations. The pi record references that cross conversations in Pim's data are only fork `parent` (with ancestor entry visibility, `head`/`edits`, and `document.copy`) and the NapTask's attachment to conversation 1. New chats, group-chat seats, delegation/task conversations, trigger chats, reviews, visit conversations and continuations each start a new family. Per-tenant stays only until import; per-agent and per-conversation are rejected (A5).
2. **Two namespaces:** an application `PartitionId` and pi's numeric ids. pi ids stay unchanged and come from a **tenant-wide leased-block sequence**; because they were unique in the single original storage and are split without renumbering, public entry ids cannot collide after the split (A6.3). The Runner must never call `Harness.root()` outside the tenant's home partition; `ROOT_SESSION` routes through the directory to home (A6.4).
3. **Pinned pi-durable 1.1.0 has no `wake()`/`onWake` (they arrive in 1.4.0) — a required correction to the earlier upstream-main-based claim [V].** The host activation contract is rebuilt on 1.1.0 APIs (`inspect()`, `resume()`, patched `resumeTask()`, `close()`) plus lease, activation, signal-outbox and timer tables (A8). No implicit pi upgrade.
4. **Host-write atomicity, stated precisely [V]:** no Pim host write is designed to share a transaction with a pi commit and B2 found none that does; callbacks such as `init` run *before* pi's SQL transaction opens, so their host writes are separate autocommits repaired by operation ids and evidence docs. One residual timing question is **[U]** (A3).
5. **Cutover cannot rely on account suspension [V].** Suspension flags the account, aborts chat runs once and closes sockets; it does not stop `Pim.alarm()`, pi wake jobs, `cf_agents_jobs`, MCP reconnects, push/subscription ticks, the Directory erasure alarm or anything in coding. A deterministic 10-step fence is in [inventory/C-cutover-fence-entrypoints.md](inventory/C-cutover-fence-entrypoints.md) §10 (existing controls: invalid `PIM_RUNTIME` for ingress, registration closed, suspension; **needed, PROPOSED:** an alarm stop — freeze flag or inert maintenance Worker — and export tooling, which does not exist).
6. **Permissions (Part G):** the 18 gaps are classified explicit / absent-enforcement / uncertain with PRESERVE vs PROPOSED HARDENING; five need a user decision. **"Admin-supplied infrastructure + elevated per-user permissions + repository authorization" is only partly implemented today (B5 §5.8):** infrastructure is per deployment/admin; there is no per-user coding permission beyond admin role and a per-person compute quota; repository authorization is an optional deployment allowlist (`PIM_GIT_REPOS`, unset = any repository) — that intent is therefore **proposed hardening**, not an existing behavior to preserve.
7. **Inventory (Part B):** 162 entries in six fragments plus the fence document, with exact refs or specific [U] questions. Corrected in this revision: secrets are *not* uniformly plaintext (native-app credentials are AES-GCM under `APP_CREDENTIALS_KEY`; vault/broker/gateway/Gitea keys derive from the Directory `cookie_key`); computer dependence is per item, not blanket (B4 §0.1: chat image attachments, apps, notes, sharing work with no computer; `/workspace` files, `generate_image`, hosted-app backends, the agents' Chrome need one); the alarm table is `cf_agents_jobs`; celld does **not** run coding or host-ops (not wired).
8. **Coding:** five harnesses (`pi`, `claude-code`, `codex`, `mistral-vibe`, `amp`); a pi-durable store is opened in each coding-thread Durable Object for every variant but only `pi` runs a model loop through it; each coding thread is its own partition-equivalent. Agent tools skip checks the UI routes apply (`coding_push` pushes immediately; `coding_merge` has no REST route) — current behavior to preserve or a decision (Part G).
9. **Unproven:** all performance. Code facts only (≈ up to 4 storage transactions/s per streaming conversation at Pim's 250 ms setting; open and queued-submission scans grow with a storage's live tasks/queued inputs). Nothing here explains the reported "Connecting at 5+ threads".

## 1. Evidence table

| Claim | Evidence | Label |
|---|---|---|
| pi-durable 1.1.0 (patched), chord 1.1.0, agents 0.27.0 (patched) | `package.json:30-44`; `pnpm-lock.yaml:990-1001,3124`; `patches/` | V |
| Installed pi-durable = published 1.1.0 + Pim patch | `npm pack`, `patch -p1`, `diff -rq` (A1) | V |
| `wake()`/`onWake` absent in 1.1.0, present from 1.4.0 | tarball greps; 1.5.2 `CHANGELOG.md` | V |
| One owner per storage, no cross-process lock, no PostgreSQL | pi `README.md:545` (tag `abe508e`) | V |
| Open rewrites `running→pending`; timers in-process | `scheduler.ts:239-262,1313-1345`; installed `dist/harness/scheduler.js:95-101,350,1249` | V |
| Mutation line; uncertain commit poisons | `session/session.ts:415-440,545`; `dist/session/session.js:276,285` | V |
| `mintId` in-process counter; seq from metadata row | `storage/sqlite/storage.ts:174-203`; `dist/storage/sqlite/storage.js:103-127` | V |
| `root()` is the only creator of conversation 1; `PiHarness` calls it on every open | `harness/harness.ts:336-342`; `agents/dist/harness/pi/index.js:559-563` | V |
| One Harness per space; pi store opened in every coding-thread DO | `src/pim.ts:491,588`; `src/coding/thread-do.ts:280-299`; B5 §6 | V |
| Public chat id UUID; message id = entry id; internal ids are numeric strings in host tables | `src/store.ts:213-226,737-746`; `packages/shared/src/transcript.ts:161-186`; B2 §0.3 | V |
| Pim defines one task kind and one document kind | `optmem/index.ts:216,459`; `packages/triggers/src/host.ts:53` | V |
| `init` host writes are separate autocommits | `session.ts:415,428`; `host.ts:237,380-398`; B2 §0.4 | V |
| Suspension is not a fence | fence doc §2 | V |
| Behaviour of pi-durable ≥ 1.2 beyond the 1.4.0 `wake` note | not audited | U |
| Target PostgreSQL durability/failover behaviour | no environment supplied | U |

## 2. Partition, storage and ownership

### Part A — pi-durable Harness partition, storage and ownership

Labels: **[V]** verified in code/docs read for this audit; **[P]** proposed design choice; **[U]** unverified or not checkable here.

### A1. Provenance

| Item | Value | Label |
|---|---|---|
| Audited Pim commit | `30818438bdc0581e5960d20d8f30310fd5fbc7b7` (`main`, 2026-11-16) | [V] |
| `@earendil-works/pi-durable` | `1.1.0`, `package.json:32`, `packages/{coding,shared,triggers}/package.json`; lock integrity `sha512-NtuB3RY2…` (`pnpm-lock.yaml:999`); **patched** by `patches/@earendil-works__pi-durable@1.1.0.patch` (adds `Harness.resumeTask`, a `suspend` generation policy, queued-input content in agent events) | [V] |
| `@earendil-works/chord` | `1.1.0` (lock `:990`), pulled in by pi-durable | [V] |
| `@earendil-works/pi-ai` | `1.1.0`, patched (`patches/@earendil-works__pi-ai@1.1.0.patch`) | [V] |
| `agents` (Cloudflare) | `0.27.0`, patched (`patches/agents@0.27.0.patch`, adds `PiHarness.resumeTask`, `suspendedOnly`). Upstream tag `agents@0.27.0` peels to `e335186331f99be12609a5eb0c64c7863c3ccafd` | [V] |
| pi source read | `https://github.com/earendil-works/pi` tag `v1.1.0` = commit `abe508e1b89912adde45528136c3221eb69acdd7`, `packages/durable/{README.md,docs/spec.md,src/**}`, `packages/chord`. The installed package's `README.md` and `CHANGELOG.md` are byte-identical to that tag. The npm tarball carries no `gitHead`, so tag-to-tarball identity of `dist/` is **[U]**; the installed `dist/` is the patched build that Pim actually runs and was read where behaviour differed. | [V]/[U] |
| Installed runtime vs published tarball | `npm pack @earendil-works/pi-durable@1.1.0`, then `patch -p1 < patches/@earendil-works__pi-durable@1.1.0.patch`, then `diff -rq` against `node_modules/@earendil-works/pi-durable`: **identical** (8 files differ from the unpatched tarball, exactly the patch's 8 files). Run in this audit. | V |
| Published tarball vs git tag source | tarball `README.md`, `CHANGELOG.md`, `package.json` are byte-identical to tag `v1.1.0`; the tarball's `dist/**/*.d.ts` file set equals the tag's `src/**/*.ts` file set. Compiled `dist/*.js` vs tag `src/*.ts` could **not** be proven byte-equal (esbuild and tsc emit differ; normalised comparison of 8 files differed by about 1%, the sampled difference being comments and trailing commas only). Each runtime claim below is therefore cited against the tag source **and** spot-checked in the installed `dist` (lines given). | V/U |
| `wake()` / `onWake` | **Not in 1.1.0.** `grep -rn "onWake\|wake(" dist` of the 1.1.0 tarball finds nothing; the first release that has them is **1.4.0** (`CHANGELOG.md` of 1.5.2, §[1.4.0], "`Harness.wake()` and `HarnessOptions.onWake` tell a host when the Session next needs a process"; 1.2.0 and 1.3.0 tarballs checked: absent). Earlier drafts of this design that assumed upstream-main `wake()`/`onWake` and a "crash-loop guard"/`restarts` field are **a required design correction**: against the pinned 1.1.0 the host contract in A8 is built on `inspect()`, `resume()`, `resumeTask()` (patch) and `close()` plus host tables, and does not assume `wake()`. Adopting 1.4+ is a separate, explicit upgrade decision (Q8), not implied here. | V |
| Latest upstream | npm now publishes `pi-durable 1.5.2`. **Not audited.** Every statement below is about 1.1.0 (+Pim patch); re-check the storage contract and "one process owns a storage" text before upgrading. | [U] |

Immutable links (pi, tag commit `abe508e…`): `…/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/docs/spec.md` (§4 storage ownership, §5.4 scheduler/ownership, §10 storage contract), `…/packages/durable/README.md#storage`, `…/packages/durable/src/storage/sqlite/storage.ts`, `…/src/harness/scheduler.ts`, `…/src/harness/generation.ts`. The agents `PiHarness` source is `node_modules/agents/dist/harness/pi/index.js` (published dist; `agents` repo tag above).

### A2. What upstream actually guarantees [V]

- One Session = one **mutation line**; all commits of a Harness are serialised (`spec.md` §1 invariant 7, §4). One commit is atomic across entries, tasks, submissions and documents (invariant 1).
- "**One process owns a storage at a time; there is no cross-process locking**" (`README.md:545`). Storage implementations "do not add a second caller-facing commit mutex" (`spec.md` §10). There is no built-in PostgreSQL; backends are Memory, SQLite, JSONL, and the Cloudflare DO SQLite wrapper (`README.md` Storage table).
- `Storage` (spec §10, `src/types.ts`) has `commit(writes[])→Seq`, `mintId()`, point reads and cursor scans for conversations, entries, tasks, submissions, documents, `close`. `StorageRejected` = "guaranteed not committed"; any other failure after admission is **uncertain and poisons the Session** (`session/session.ts:431-440`, `:545`); the process must reopen.
- `SqliteStorage.commit` (`storage/sqlite/storage.ts:174-197`): one SQL transaction; reads `durable_metadata(next_id,next_seq)`, checks global ids, applies writes, bumps `next_seq`. `mintId` is an **in-process counter** (`:199-203`); uniqueness is only enforced at commit by `checkGlobalIds` against `record_ids`. Commit sequences "strictly increase but may have gaps".
- **Open is a write by the owner.** `Scheduler.open` (`harness/scheduler.ts:239-262`) scans every live task in the storage (`pending|running|waiting|completing`) and **rewrites every `running` task to `pending`**. A second process opening the same storage while the first runs therefore corrupts the first's task states. Hence fencing must happen at open as well as at commit.
- Timers are **in-process**: `sleep()` is `setTimeout` (`scheduler.ts:1312-1345`); retry/poll times are stored in the task checkpoint / `LiveDoc.generation.retry.at|deferred.pollAt`. After `close()` or a crash tasks "resume on reopen" — only `Harness.resume()` (or a submit/wait call) enables scheduling (`spec.md` §2.2 `resume()`, `README.md:110-113`). **pi supplies no wake-up, no "next due time" query and no cross-process signal.** The only host-facing introspection is `inspect()` (live tasks, blocked reasons) and `subscribeCommits()` / `subscribeClose()` (in-process, synchronous, "must not call Session APIs", `types.ts:925-929`).
- `Harness.usage()` scans every conversation (`harness.ts:286-296`); the reconcile pass scans **all queued submissions** of the storage (`scheduler.ts` `#loadScopes`). Harness open cost therefore grows with the storage's live tasks and queued inputs, not with idle history.
- Model streaming: generation commits a **throttled partial of the in-flight message** at most every `progress.partialIntervalMs` with one commit in flight (`generation.ts:360-410`; default 100 ms). Pim sets **250 ms** for both partials and tool output (`src/pim.ts:717`, `src/coding/thread-do.ts:4963`). So each actively streaming conversation costs up to ~4 storage transactions/second plus tool and result commits, and "all visible progress is durable; there is no volatile publication path" (invariant 3). The provider stream and its partial live in the owning process's memory; after a crash the committed partial is converted to an aborted assistant entry (`convertPartial`) and the run is retried. These are code facts; no throughput claim follows from them.
- Installed-runtime cross-checks (patched `dist`, equal to tarball+patch): open scan and `running→pending` rewrite `dist/harness/scheduler.js:95-101`; sleep timers `:350`, `:1249`; `SqliteStorage.commit` `dist/storage/sqlite/storage.js:103-120` (metadata read `:108`, seq `:111`, update `:117`); in-process id counter `:123-127`; poison `dist/session/session.js:276,285`; default partial interval `dist/harness/agent.js:16`.
- Parked work: a task `waiting` on other tasks, or a tool task suspended for a person (Pim's patch: `Harness.resumeTask`), holds **no invocation and no memory** beyond its record; `PiHarness` lets the object sleep when all live tasks are suspended/waiting (`suspendedOnly`). In the patched runtime a *suspended* task is a task `waiting` with an empty `on` (`dist/harness/scheduler.js:1227`), reported by `inspect()` as `{kind:"suspended"}` (`:802-803`); `resumeTask(id)` commits it to `pending` (`:164-181`). **A `resumeTask` for a task that has not yet suspended returns `"requested"` and is remembered only in memory** (`#resumeRequested`, `:66-69,176,978`): a crash loses the request. Safe because a task cut off before suspending runs again after reopen and its `beforeTool` hook finds the approval already decided (`src/space/approvals.ts` `approvalFiled` returns the outcome for a non-pending approval), but it means **the decision must be durable in the application schema and re-applied by the host after activation**.
- Tool effects use the **effect sandwich** (`spec.md` §5.2, §8.4): intent committed → effect → result committed. Recovery in `execute` re-runs a tool only if both stored and current replay policy are `safe`; otherwise an `interrupted` result is committed. Generic tasks must be idempotent or poll a handle.
- Cursors are backend-private; `entry(id)` and `findLatestHeadMarker` exist so context reads never need all history. There is **no tail/changefeed API on Storage**.
- A `conformance` suite and benchmark seeds are exported: `@earendil-works/pi-durable/testing` → `createStorageConformance` (the suite registers on the order of 66 cases in 1.1.0; counted by `it(`/`test(` occurrences, not run), `registerStorageConformance`, `seedStorageBenchmark` (`src/testing/index.ts`) [V]. The SQLite facade `SqliteDatabase` (`storage/sqlite/database.ts`) is **not** reusable for PostgreSQL: the schema uses `STRICT`, `json_valid`, `INSERT OR IGNORE` (`migrations.ts`), so a PostgreSQL adapter implements `Storage` directly.
- Chord (1.1.0) contributes document state: tracked JSON deltas with base batches; each document state has its own **in-memory** delivery cursor that "Pico does not persist" (`spec.md` §9.1). Durable resume positions for live views must therefore be the storage commit `Seq`/application cursors, never Chord cursors.

### A3. How Pim uses it today [V]

| Fact | Evidence |
|---|---|
| **One Harness, one storage per person.** `Pim extends DurableAgent`; `readonly harness = new PiHarness({ harness: async ({storage}) => … Harness.open(storage, …) })` | `src/pim.ts:179`, `:491`, `:588-596` |
| Storage = that Durable Object's SQLite, shared with Pim's own `pim_*` host tables, via `openPiSessionStore(lifecycle.storage)` | `node_modules/agents/dist/harness/pi/index.js:30-33,557`; host schema `src/store.ts:150-280` |
| Space **root conversation** is pi's `ROOT_CONVERSATION_ID` (1), created by `pi.root()` at every open | `agents/dist/harness/pi/index.js:559-563`; `ROOT_SESSION` used in `src/space/routes.ts:254,1791`, `sockets.ts:145`, `views.ts:144` |
| Every other chat is `createConversation({ownership:{kind:"ownerless"}})` or `fork(...,{ownership:{kind:"ownerless"}})` | `agents/.../index.js:677-690`; `src/space/conversations.ts:331-333` |
| **Conversation key = numeric pi `ConversationId` as a string**, stored in host tables (`pim_sessions.id`, agents-per-session, rooms, tasks, approvals `session`, …); the **public chat id is a random UUID** in `pim_session_ids` | `src/store.ts:213-226,737-746`; `Number(session) as ConversationId` at 13 sites in `src/` |
| **Public message id = pi `EntryId` as string** (`id: String(entry.id)`), and fork points are named by it | `packages/shared/src/transcript.ts:161-186`; `src/space/routes.ts:317-327` |
| Pim registers **one** pi task kind of its own: `optmem.nap` (background, `ownership: conversation`, root conversation) | `src/extensions/optmem/index.ts:216,459`; `src/pim.ts:1046-1061`; `src/space/abilities.ts` no tasks |
| Pim defines **one** pi document: `pim.trigger_chat` (conversation scope, `fork:"initial"`). No Session-scope documents exist in Pim or in pi built-ins (`pi.live`, `pi.inbox`, `pi.usage`, `pi.provider` are all conversation scope) | `packages/triggers/src/host.ts:53-60`; `/tmp/pi…/harness/{live,inbox,usage,provider}.ts` |
| Built-in task kinds: `pi.generation`, `pi.tool`, `pi.compaction` | `durable/src/harness/{generation,tool,compaction}.ts` |
| Pim never creates task-owned conversations or pi sub-agent edges; the only ownership kinds in `src/` are `ownerless` (9 kinds of conversation: ROOT, chat, trigger chat, fork, continuation, task chat, room seat, review, visit — B2 §0.1.1) and `conversation` for the NapTask, which is a **task attached to conversation 1** (not a `ConversationRecord.owner` edge) | `rg ownership src/` (non-coding); `src/pim.ts:1054`, `src/extensions/optmem/index.ts:313-318`; B2 §0.1.1 |
| Delegation, rooms (group chats), reviews and trigger chats are **application tasks**: a row in Pim's `tasks` store, a **new ownerless conversation**, an input submitted with a stable `operationId` (`task:<id>`), and an in-memory `harness.wait(operation)`; restart re-waits (`#resumeTasks`) | `src/space/conversations.ts:413-483`; `src/tasks.ts` |
| Group-chat seats are one conversation per agent; room messages reach other seats by a `write` submission with `requestId = operationId`, deduplicated by `submissionByRequest` | `src/space/conversations.ts:770-781` |
| Continuation after compaction/overflow = a **new** conversation seeded by an `init` commit with a summary entry (not a pi fork); the link is host data (`store.continueSession`) | `src/space/abilities.ts:335-395` |
| User "fork" = pi `fork(at)` inside the same storage (ancestry shared). Group chats and visited bots cannot be forked | `src/space/routes.ts:317-327`, `conversations.ts:331` |
| Approvals: the host row `pim_approvals(session, call_id…)` is written during a tool's `beforeTool` hook; the pi `pi.tool` task then suspends; the decision calls `resumeTask(session, call)` | `src/space/approvals.ts:97-235`; `agents` patch `resumeTask` |
| **No Pim host write is designed to share a transaction with a pi commit, and B2 found none that does.** pi's `commitWith` runs the callback (`init`, `conversation.commit(fn)`, `runtime.commit(fn)`) first, against a buffering transaction (`session/session.ts:415,428`); the SQL transaction opens only inside `storage.commit` (`storage/sqlite/storage.js:103`; DO adapter `agents/.../index.js:228-236`). So a host statement in an `init` callback (`packages/triggers/src/host.ts:237`) is a separate autocommit, not rolled back with the pi commit, and is repaired by `#madeChat`/`adoptChat`/`chat_ready`/`TriggerChatDoc` (`host.ts:380-398`). Hooks (`beforeTool` …) and tool bodies run outside commits (`tool.ts:67-91`, `generation.ts:197`, `compaction.ts:129`). Residual **[U]**: Pim writes `ctx.storage.sql` directly, bypassing the adapter queue, so a host statement could in principle land inside pi's open DO transaction by timing; not reproduced. Full enumeration: B2 §0.4. |
| Schedules/timeouts (approval expiry, reviews, triggers) use the `agents` `schedule()` callbacks, stored as rows in **`cf_agents_jobs`** (agents 0.27.0 migrates the old `cf_agents_schedules` away: `node_modules/agents/dist/scheduler-DZ3xQfeK.js:361-403`), not pi tasks; six callbacks plus `retryAfterCooldown` (B6 §4) | `src/space/approvals.ts:112,149,208` |
| Cross-tenant calls exist: a guest's space calls the owner's space (`pimOf(ownerId).visitAnswer/botToolDecided`) | `src/space/approvals.ts:222-228` |
| Wake after eviction is **not pi**: `PiHarness` (agents) schedules one lifecycle job per conversation `pi-wake:<conversation>` (singleflight, recoveryLoop), whose step calls `inspect()`, waits on `waitForIdle` up to 10 min, re-heartbeats every 30 s, and hands retry/poll waits > 60 s to the alarm; `onStart` re-arms a job per conversation with live tasks; `keepAliveWhile` keeps the DO up | `agents/.../index.js:247-337,484-540,574-579`; `src/pim.ts:176,1060` |
| Each coding thread is its own Durable Object with a `PiHarness` field and its own SQLite. The wrapper is a lifecycle capability, so on the thread's first RPC `Lifecycle.start` runs `onStart`, which **opens pi-durable's store and `Harness.open` for every harness variant**; only the `pi` variant runs a model loop through it, `claude-code`/`codex`/`mistral-vibe` store only `harness.message` write entries and `amp` only mirrored messages. B5 §6 | `src/coding/thread-do.ts:133,280-299`; B5 §6 |

Harness/Session/store counts, therefore: one per person-space (key: owner id → DO name), and one pi-durable store per coding thread (key: coding thread id; opened for every harness variant but used as a model loop only by `pi`). Each Harness has one `Storage`; the only keys inside are numeric conversation/entry/task/submission/document ids from the single per-storage id space, with `commit_seq` per storage.

### A4. Cross-conversation requirements — pi dependency vs application coupling

| # | Requirement | Where | pi-level dependency? | Same-partition required? |
|---|---|---|---|---|
| 1 | Root/global documents | none (no Session-scope docs) | none today | no |
| 2 | Shared extension state (memory scopes, goals, skills, schedules, notes, files, canvas) | host tables / `OptMemStore`; extensions read host state per conversation (`access(conversationId)`) | **application** | no (needs a tenant-scoped app DB, not pi storage) |
| 3 | Settings / agent configuration | `pi.agent` is a per-conversation doc configured from host data on creation (`agentDefaults`, `configure`); a fork keeps the `asOf` copy (`spec.md` §3.7) | pi (per conversation) | with its fork parent only |
| 4 | Fork history | pi `fork(at)`: child's entries are the parent's visible ancestry; `document.copy` reads the source document at the cut inside the same storage (`spec.md` §10, §3.7) | **hard pi dependency** | **yes: parent and all forks in one storage** |
| 5 | Compaction | blocking compaction appends to the same conversation; continuation = new seeded conversation (app link) | none cross-conversation | no |
| 6 | Shared IDs | host tables hold numeric conversation ids; entry ids are public; commit `Seq` is used for historical document reads | per-storage id space | ids must be **unique across a tenant's partitions** to keep host keys and public ids (see A6) |
| 7 | Parent/child tasks, delegation | application `tasks` store + separate ownerless conversations + `operationId` submissions; no pi owner edges | none | no (pi owner edges, if ever used, would force same storage) |
| 8 | Group chats / rooms | seat per agent; `write` submissions between seats | none; each cross-write is its own commit today | no — needs a durable, idempotent cross-partition delivery |
| 9 | Approvals | host row + suspended `pi.tool` task in the **same** conversation; wake by `resumeTask` | task in one conversation | no (same conversation) |
| 10 | Schedules / triggers | host/`agents` alarms and `pim_trigger_*` tables; they submit input to a conversation (`submitTo`) with stable `operationId` | none | no |
| 11 | Watches | `harness.events` / `watchDoc` are per-conversation, in-process | per conversation | no |
| 12 | Atomic host+pi writes | **none exist** (see A3); two-phase flags + evidence docs | — | n/a. This is a *property to preserve*, not a dependency to replace |
| 13 | Usage / memory | `pi.usage` is per conversation; `Harness.usage()` unused by Pim; spend ledger is host | none | no |
| 14 | Cancellation | `abort` of one conversation; abort cascade only along pi owner edges (none used besides NapTask→root) | per conversation | no |
| 15 | Coding-thread completion waits | normal agent's coding tool stores a handle and a host-level callback; coding threads are separate DOs/harnesses (B5 inventory) | none | no |
| 16 | NapTask | background task **attached to conversation 1** (`TaskRecord.conversationId`, `ownership:{kind:"conversation"}`), reads host memory store; its retry `sleep` is ≤ 2^attempt·2 s (`optmem/index.ts:262-290`) | task↔conversation co-location | **yes: stays in the partition of conversation 1** |
| 17 | Public listing | `harness.sessions.list()` scans all conversations for the chat limit (`conversations.ts:327`) | uses `scanConversations({})` | must become an app-schema query (title/list/counts live in `pim_sessions`) |

Net, stated precisely: the pi *record references* that cross conversations in Pim's data are only (a) `ConversationRecord.parent` of forks with the entry visibility, `head` and `edits` that read ancestors' entries, plus `document.copy` of conversation documents at fork time, and (b) the NapTask's attachment to conversation 1. `ConversationRecord.owner` (task-owned conversations) is never written by Pim. Pim-authored entries (`pim.room`, compaction summary) carry no conversation/entry ids in `data` (`src/space/conversations.ts:776`, `src/space/abilities.ts:372`). **Other** whole-storage behaviours exist in pi but are not required couplings: open scans of live tasks, queued-submission scans, `usage()`, `sessions.list()`. Everything else crosses conversations through idempotent application operations. Everything else already crosses conversations through idempotent application operations.

### A5. Candidate partition boundaries

| Candidate | Cross-conv atomicity kept | Verdict |
|---|---|---|
| **Tenant (today)** | all | Preserves everything, but one mutation line, one open-scan of all live tasks/queued submissions, one owner process for every active conversation of a person; contradicts the active-run goal. Acceptable only as a transient state, not a destination. |
| **Agent** | agent's chats | Rejected: a chat's agent can change, rooms put several agents' seats in one chat, and one agent can own hundreds of chats; adds no atomicity Pim uses. |
| **Conversation (no sharing)** | none | Cleanest unit for ownership and parallelism, but **breaks forks** unless a fork becomes a physical copy of history: new entry ids (public message ids are entry ids), `asOf` doc copies re-based, O(history) cost, and loss of the property that a fork and its parent are consistent. Rejected as the primary unit. |
| **Conversation family** = a conversation plus every fork reachable from it | fork ancestry, `document.copy`, owner edges, NapTask→root | **Recommended.** It is the smallest unit closed under the only two hard pi couplings. |
| **Family + task-ownership closure** | adds pi sub-agent edges | Same unit; if Pim ever adopts pi task-owned conversations they join the owner's family. Stated as an invariant, not as new work. |

### A6. Recommended model [P]

**Partition = conversation family.** One PostgreSQL pi-durable storage (`partition_id`), one Harness instance, one mutation line, one lease owner.

Hard invariants (each testable; a migration/adapter check fails closed):

1. **Closure.** A fork is created in its parent's partition (same storage). A cross-partition fork is impossible: `forkConversation` validates the parent entry through the same storage's ancestry (`spec.md` §3.7, §10 `document.copy` "source must be an alive conversation document" in the storage). Group-chat seats, delegation conversations, trigger chats, reviews, visit conversations, continuations and plain new chats each start a new partition: no pi record of theirs references their origin (A4).
2. **Two namespaces, never conflated.** `PartitionId` is an application identifier (new; the key of storage, lease, outbox and activation rows). Every pi identifier (`ConversationId`, `EntryId`, `TaskId`, `SubmissionId`, `DocumentId`) stays a number from **one tenant-wide sequence**. The directory `conversation_directory(tenant, conversation_id → partition_id)` is the only translation. Public URLs and payloads keep using the existing public chat UUID (`pim_session_ids`) or the pi number exactly as today (message id = `String(entry.id)`; the new system adds no partition component to public ids).
3. **Tenant-unique pi ids [V arithmetic, P mechanism].** Today every id of a tenant is unique because it comes from one storage's `next_id` (`storage.js:108-127`, `checkGlobalIds`). Splitting a tenant by family moves records without renumbering, so no two partitions can hold the same id: they were distinct before the split. After import `mintId` continues from `max(all ids)+1` of a **tenant-wide leased-block sequence**, so ids minted later cannot collide either (gaps allowed by contract). This is what proves unchanged public entry ids, host-table conversation keys, `pim_tasks.batch` / `nap_task` pi task ids, and fork points stay valid. Without a tenant-wide sequence, two new partitions would mint equal numbers; that is why per-partition counters are rejected.
4. **Root handling.** pi never creates a root implicitly: id 1 is created only by `Harness.root()` (`harness/harness.ts:336-342`, `session/transaction.ts:287-288`), which the `agents` `PiHarness` calls on **every** open (`agents/dist/harness/pi/index.js:559-563`). The new Runner must **not** call `root()` for any partition except the tenant's home partition; otherwise each partition would mint a second "conversation 1". Conversation id 1 and `ROOT_SESSION` ("1": `src/space/routes.ts:254,1791`, `sockets.ts:145,277,327`, `views.ts:144,361`) route to the home partition by a directory row `1 → home` created at import/provisioning; non-home partitions have no id-1 record. A test: every `ROOT_SESSION` use resolves through the directory and never "the local family root".
5. **Seq.** `Seq` is per storage and only needs to increase. The import keeps every record's original `commit_seq`, document `created_at`/`retired_at` and `document_revisions.seq` unchanged (they are conversation- and document-local) and sets each partition's `next_seq` to the original tenant `next_seq` (≥ every kept seq). `asOf` reads (`entry(id).commitSeq` → `document(id, at=seq)`) therefore see the same bases/deltas as before; a fork's copied documents were already independent complete bases written in the fork's own commit (`spec.md` §10), and they travel with the fork's conversation in the same partition.
6. **Records that must be in the same partition as a conversation C:** C's entries; its documents (scope owner = C) and revisions; tasks with `conversationId = C`; submissions of C; every conversation reachable through `parent` (up and down) and through `owner` edges; tasks attached to those. A migration check computes the connected components with union-find over `ConversationRecord.parent.conversationId` and `owner.conversationId`, assigns each record by its conversation, and fails if (a) a task's `conversationId`, a submission's, or a document's scope owner names a conversation in another component, (b) an `EntryRecord.head`, `edits[].target` or a `pi.tool` task input's `assistant` entry resolves outside the component, or (c) any `owner` edge exists other than those listed in A4. **[U]** for entry `data` of Pim-authored kinds other than the two checked above: grep found none embedding ids, but only the import check over real data can prove it.
7. **NapTask.** `optmem.nap` is a task of conversation 1 and stays in the home partition; it does not create a conversation owner edge.
8. **Directory.** `conversation_id → partition_id` rows are immutable and written in the same PostgreSQL transaction that creates the conversation or fork.
9. **No cross-partition pi transaction.** Cross-partition work is an application operation with a stable `operationId` delivered through `submit({requestId})` (deduplicated by `submissionByRequest`), as rooms/delegation do today; no atomicity exists to lose (separate commits today).
10. **Tenant-scoped state** (memory, goals, notes, approvals, agents, settings, notifications) lives in the application schema.
11. **One lease owner per partition**, enforced in the PostgreSQL row that sequences commits (A7).

Why this addresses the target [P, no measurement claimed]: concurrency across a person's active chats no longer shares a mutation line, an open-scan or an owner process; a large tenant's active runs spread across Runners; each partition's open cost is bounded by its own live tasks and queued inputs; idle partitions are simply not loaded. What remains serial is genuinely one family (one chat and its forks), which is one agent loop at a time by design. The one structural hot spot left is a pathologically large fork tree; the route to relieve it is **fork-by-copy-on-demand into a new family** (offline "detach" of a fork into its own partition, which does not exist today and is **not** part of the first cut). Whole-tenant is never the destination.

Recommended diagram:

```
 tenant T (application schema: users, agents, memory, approvals, notes, files, tasks, rooms, schedules)
   │ conversation_directory(conversation_id → partition_id)      ← immutable rows
   │
   ├─ partition P0 "home"  : root conv 1 ── fork 17 ── fork 52      + optmem.nap (owned by conv 1)
   ├─ partition P1         : chat 9 ── fork 31
   ├─ partition P2         : chat 14                              (delegation child, seat, trigger chat …)
   └─ … one pi-durable Harness each; one lease owner each; ids from T's sequence

 cross-partition effect = app operation (operationId) ──outbox──► submit({requestId}) in target partition
```

### A7. PostgreSQL storage adapter requirements [P], grounded in the `Storage` contract [V]

1. **Schema.** Per partition: `partitions(id, tenant_id, owner_epoch, owner_id, lease_until, next_seq, schema_version)`; `conversations, entries, tasks, submissions, documents, document_revisions, record_ids` keyed `(partition_id, id)`, with the same indexes the SQLite schema declares (by owner, conversation/id, task status/kind/abort/background, submission request, document address/scope) so every `scan*` and `findLatestHeadMarker` is an index range. JSON as `jsonb` or `text` with identical canonical serialisation round-trip (values must come back detached and JSON-equal). Large `entries.record` bodies stay inline until proven otherwise [U].
2. **IDs.** `mintId` draws from `tenant_id_seq` in leased blocks (e.g. `UPDATE … RETURNING` of a block). Crash loses unused ids (gaps). `commit` still verifies `record_ids` for global ownership; `candidateNextId` logic is replaced by the sequence.
3. **Transaction.** One `commit(writes)` = one PG transaction at `READ COMMITTED` that: (a) `UPDATE partitions SET next_seq = next_seq+1 … WHERE id=$p AND owner_epoch=$e AND lease_until>now() RETURNING next_seq` (row lock + **fence + sequence**; zero rows ⇒ ownership lost), (b) applies table writes and document base/delta rows with the seq, (c) inserts one `commit_receipts(partition_id, seq, epoch, token)` row and the projection/outbox rows (A9), (d) `COMMIT`. All writes of one `StorageWrite[]` batch, including the documented normalisation rules (≤1 content command per incarnation, retire-after-content, `document.copy` reading *pre-batch* committed source state, `StorageRejected` for deterministic copy/replay failures only when nothing committed) are in that one transaction.
4. **Reads.** Read-your-writes through the same primary (never a lagging replica) once `commit` resolves. Scans are keyset pagination whose cursor is a JSON object (`{id,order}`), honoring the `order` rule (a cursor carries its order, other order rejects).
5. **Snapshots/historical reads.** `document(id, at)` = newest base at or below `seq` + ordered deltas; keep base/delta cadence from SQLite (`deltasSinceBase`), and a version change only at a base.
6. **Optimistic checks.** The contract has none beyond global-id and document-record consistency (`Session` is the sole writer); correctness against a *second* writer comes only from the epoch fence. Never use `SERIALIZABLE` retries as a substitute.
7. **Durability receipt.** `commit` resolves with `Seq` only after PG acknowledged `COMMIT` under the deployment's declared durability mode. For a PostgreSQL with replicas, the deployment must declare `synchronous_commit` (and `synchronous_standby_names`) — otherwise a failover can silently lose acknowledged commits and the "commit-before-display" semantics break. The adapter reads this setting at startup and refuses (or reports) a weaker mode than configured [U for what the target deployment provides].
8. **Ambiguous COMMIT.** On a connection error between sending `COMMIT` and its acknowledgement: open a new connection, `SELECT … FROM partitions WHERE id=$p FOR UPDATE` (blocks until the old backend's transaction, which already holds that row lock from step (a), has committed or rolled back — sound because step (a) is first in the transaction), then look for `commit_receipts(token)`. Found ⇒ return its seq. Absent ⇒ definitively not committed; throw `StorageRejected`. If the database cannot be reached, throw a non-`StorageRejected` error: the Session poisons (contract-conformant) and the Runner reopens the Harness from the database.
9. **Failure/reopen.** `open()` takes the lease (A8), applies schema migrations transactionally (`schema_version` row), and does the scheduler's open-time `running→pending` rewrite under the fence. `close()` releases the lease cooperatively.
10. **Pool use.** Transactions are short and run entirely inside the callback; a connection is held only for the commit (the SQLite facade rule "never call the database from inside the callback" applies). One small pool per Runner, not per Harness; commit concurrency across partitions is bounded by the pool, so pool size × commit latency is the capacity knob [U: no numbers].
11. **Schema/task versioning.** `schema_version` per adapter; pi task/document versions already block rather than terminalize (`missing_task`, `task_too_old`, `migration_failed`). Rolling deploys must not start a Runner whose registry lacks a kind that a live task has — the task would sit `blocked` (spec §5.4).
12. **Conformance suite.** Run `createStorageConformance` (66 cases) against the adapter through `registerStorageConformance`, then add the adapter-specific suite in A10. Run `seedStorageBenchmark` only as a regression harness, not as evidence for the active-run target.

### A8. Ownership, activation and what pi 1.1.0 leaves outside [V for pi; P for the design]

**pi 1.1.0 supplies:** the in-process scheduler; `resume()` (enable scheduling; submit/wait also enable it); `inspect()` — `{scheduling, tasks[{record, state: running|ready|waiting{on}|suspended|completing|blocked{reason}}], submissions}` (`harness/types.ts:472-499`; `suspended` is the Pim patch, `dist/harness/scheduler.js:802`); `abortTask`, `waitForTask`, `waitForIdle`; `resumeTask` (patch); `close()` (stops invocations, writes no outcome; work resumes on reopen); poisoning on uncertain commit; blocked-task derivation (`missing_task|task_too_old|migration_failed`). It does **not** supply `wake()`/`onWake` (first in 1.4.0), a "next due" value, a restart counter, a cross-process lock, or fan-out.

**Host contract against the 1.1.0 API [P].** A partition needs an owner process iff `inspect()` reports a task in `running` or `ready`, a `waiting` task whose `on` is live in the same partition, a `completing` task, a queued/placed submission, or `scheduling` not yet resumed. It needs **no** owner when every live task is `suspended` (parked for `resumeTask`) or `blocked`, **except** two time-based cases the host reads itself, exactly as the existing `PiHarness._longWait` does: `LiveDoc.generation.retry.at` and `…deferred.pollAt` (`agents/dist/harness/pi/index.js:574-579`). For those the owner records `due_at = at` and may unload. Any other task that sleeps (`runtime.sleep` in task code) keeps its owner; in Pim only `optmem.nap` sleeps, for ≤ 2^attempt·2 s. **Any new Pim task type that sleeps long must declare its due time in the activation row or it pins a Runner** (acceptance rule for future extensions).

Tables (all in the application schema; written by Runner/Gate code, not by pi):
- `partition_lease(partition_id, owner_id, epoch, lease_until)` — the same row that sequences commits (A7.3).
- `partition_activation(partition_id, state ∈ {needs_owner, quiescent}, due_at, signal_seq)`.
- `signal_outbox(id, partition_id, kind, payload, operation_id UNIQUE, done_at)` — durable signals: input submission, approval decision (`resumeTask`), trigger firing, cross-partition delivery, coding completion.

Rules:
1. **Default is "needs owner".** A partition is claimable (`FOR UPDATE SKIP LOCKED`, lease take, `Harness.open` + `resume()`) unless its owner declared it quiescent with a conditional write `UPDATE … SET state='quiescent', due_at=$t WHERE partition_id=$p AND owner epoch=$e AND signal_seq=$seen`. The host, not the adapter, declares quiescence (the adapter cannot decode pi documents or derive `suspended`). A crash before the declaration leaves it claimable.
2. **Signals are durable before they are hints.** The writer, in one application transaction, inserts the `signal_outbox` row (unique `operation_id`), sets `partition_activation` to `needs_owner, due_at=now, signal_seq+1`, and then sends a NATS hint. NATS loss delays; the activation poll and outbox are canonical.
3. **Delivery of a signal** is done by the partition's owner: `submit({requestId: operation_id})` for inputs; for approvals `resumeTask(task)` **again after every activation for every decided approval whose call is still suspended** (the call returns `resumed|requested|terminal`; `requested` is only in memory, A2); mark the outbox row done only after pi acknowledges. Duplicates are harmless (`requestId` dedupe; `resumeTask` is idempotent).
4. **No wake race.** Because the declaration is conditional on `signal_seq`, a signal arriving between the owner's `inspect()` and its quiescence declaration makes the declaration fail and the owner re-inspects.
5. **Loss of ownership.** On `OwnershipLost` (adapter, non-`StorageRejected`) the Runner closes the Harness and stops dispatching tools for that partition; effects already dispatched are covered by A10.
6. **Time-based jobs outside pi** (approval expiry, review expiry, trigger ticks, scheduled pushes — today `agents` callbacks in `cf_agents_jobs`, B3 §"entrypoints") become rows in one `timers(due_at, kind, ref, tenant, done_at)` table claimed by Runners with `SKIP LOCKED`; firing inserts the same durable signals. This is a table plus a polling loop, not a workflow engine.
7. **Rolling deploys** must not start a Runner whose registry lacks a task/document kind present in live data (`blocked`); the import pre-flight (C2) and a startup check enforce it.

Steward/Dispatch are modules in the Runner (lease/activation; outbox delivery), not services. No second scheduler: pi still decides what runs inside a loaded Harness.

Races to be tested (A11): missing early wake; owner dies between a timer/signal write and its delivery; expired stale owner commits or dispatches a tool; NATS lost/duplicated; duplicate signal/submission; Gate/Live reconnect; DB failover; two Runners claiming a partition; clock skew on `lease_until`; `resumeTask` "requested" lost by a crash.

### A9. Canonical data authority and projections

Authority [P]: PostgreSQL pi-durable partition tables (conversation truth: entries, tasks, submissions, documents) and the application schema (tenant truth). S3 holds object bodies referenced by id/checksum. NATS is never authority. UI projections (session list, unread, transcript view, task/approval cards) are derived and rebuildable.

Feasibility of atomic runtime→projection/outbox [V/P]: `Storage.commit` receives the complete `StorageWrite[]` (entry, task, submission, document change with Chord ops) and the allocated `Seq`, so the adapter can insert **projection outbox rows in the same PostgreSQL transaction** with no change to pi. The in-process alternative (`subscribeCommits`) runs after storage settlement and cannot be atomic. The outbox row is `(partition_id, seq, kind, ref)`, ordered per partition by `seq`; consumers keep a `(partition_id, last_seq)` cursor (**not** a Chord cursor). Retention: an outbox row is deleted once all projectors have advanced past it; if a projector is far behind or rebuilt, it re-reads canonical entries/docs and the cursor jumps to `max(seq)`. Rebuilding a projection never calls tools, models or delivery: effects are never driven from projection state.

Host (application) writes that today sit next to a pi commit remain **two-phase with idempotent operation ids**, as in the trigger-chat protocol above; the new design may place them in the same PostgreSQL database but must not claim cross-store atomicity that pi's `commit` callback does not provide, unless the adapter explicitly accepts an application transaction handle (**[P] not required for the first cut**).

### A10. External-effect ambiguity (distinct from storage recovery)

Storage recovery answers "did this commit land"; effect ambiguity answers "did the outside world do it". pi's rule is the effect sandwich. Requirements for the host [P]:

- every externally visible effect carries a stable idempotency key derived from the durable ids (`task id + call id + attempt-independent`) — the repo already does this for deliveries (`operationId`, `requestId`, `task:<id>`);
- tools keep their pi **replay policy**: `unsafe` tools are never re-run after recovery (pi commits an `interrupted` result); `safe` ones must truly be idempotent;
- a **stale owner can still perform an effect** after losing its lease (fencing stops its commits, not its network calls). Mitigations: check lease validity (with margin) immediately before dispatch; abort invocations on `OwnershipLost`/`subscribeClose`; effect endpoints that accept it receive the fence epoch;
- coding jobs, notifications, emails and git operations are external: the app records intent before and result after, and on uncertainty polls the external handle rather than re-issuing.

### A11. Concrete tests (proposed; **none were run**, the audit authorised no implementation)

Adapter-level: full `createStorageConformance` run; kill backend between `COMMIT` send and ack (ambiguous resolution both ways); two Runners `open` the same partition; stale epoch commit; lease expiry under clock skew; id-block exhaustion and crash gaps; failover with async vs sync replica; migration `schema_version` race; large fork-tree scan plans.
Host-level: signal committed before owner exists; owner killed mid-stream (partial converted, run retried, no duplicate tool effect for `unsafe`); duplicate `requestId` across partitions; outbox consumer crash/rebuild (no effect replay); approval decided while owner down; reconnect with stale client cursor; NATS down for N minutes; active-run soak with M partitions per Runner reporting commit rate, p99 commit latency and activation lag (a qualification harness, to be built — no figures asserted here).

### A12. Answers to the brief's specific questions

- *Harnesses/Sessions/stores and keys:* 1 per person-space (owner id), 1 per coding thread (thread id); numeric ids inside; public chat id = UUID map, public message id = entry id.
- *Can storage be partitioned safely?* Yes, by conversation family; per-conversation and per-agent are not safe without changing fork/document semantics; per-tenant is the status quo.
- *Cross-partition delegation/forks:* forks never cross; delegation, rooms, triggers, continuations and reviews already cross conversations only through idempotent submissions with stable operation ids; no child ownership or atomicity exists to lose. The migration check must prove no `owner_task_id`/`owner_conversation_id` edge leaves a family except root→NapTask.
- *What migrates:* each tenant's single storage is split by fork family at import with ids, seqs, documents and tasks preserved (see main plan).


## Part B — Compatibility and migration inventory

Per-entry inventory (same compact format everywhere: Sources · Canonical storage · Behavior & invariants · Computer required?/Admin infra required? · Authorization · Migration · Public ID/URL compatibility · Overrides · Dependencies · Acceptance test · Uncertainty) is in six fragments plus the fence document. Material claims carry exact `path:line` or an explicit [U] with the open question; fragments say where they did not re-read an entry (B1 WebSocket message lists/web caches/webhook details/MCP tool; B2 several §1 entries; B5 some `TD:` refs; B6 a few unread items) — those remain [U].

### B.0 Cross-cutting findings (revised)

| Topic | Finding | Fragment |
|---|---|---|
| Import / export | No importer exists (`docs/instance.md:151`); `GET /account/export` omits secrets and the export cannot be mapped back to internal ids (trigger specs carry internal ids, sessions public ids). Whole-DO dump route does not exist. | B6 §7, B3 |
| Encryption at rest | Mixed. Native-app credentials: AES-GCM with `APP_CREDENTIALS_KEY`, AAD owner/connection/app/purpose (`native-apps.ts:505-507`; mandatory for Gmail/Drive `google.ts:101`). Vault, git-broker, gateway and Gitea keys are HKDF-derived from the Directory `cookie_key`, which also signs cookies. Plaintext: `pim_credentials` (`credentials.ts:39`), own/shared providers (`models.ts:312`, `gallery.ts:603,639`), VAPID keys (`pim.ts:1410-1415`), subscription secrets, MCP OAuth tokens in DO key-value storage (`pim.ts:669-692`). Re-encryption is PROPOSED HARDENING, not compatibility. | B3, B6 |
| Identity continuity | Passkey RP id = `PIM_PUBLIC_URL` hostname; cookies valid iff `cookie_key` copied; API tokens = unsalted SHA-256 hex of the full token (`auth/store.ts:102-106`); VAPID keys per space. | B1, B6, B3 |
| Resumable state | pending/decided approvals (incl. guest and bot approvals), `cf_agents_jobs` rows (schedules, `pi-wake:*`), trigger tables, suspended `pi.tool` tasks, queued submissions, account cleanup jobs, pending computer-host requests, coding-thread handles. | B1–B5 |
| Personal computer | Per item (B4 §0.1): works with none paired — chat image attachments (R2 `BLOBS`), apps/artifacts and versions, notes (Yjs), bridge data, sharing/gallery; needs one — `/workspace` files and file/shell tools, file tabs, `generate_image` (stored on the computer; the ChatGPT-image path also runs there), hosted-app backends and their data, agents' Chrome. Browser Run is not used by product code. | B4 |
| Coding | Five harnesses; pool/provider/credentials/repo/git privileges per B5 §5; model gateway exists but no harness uses it; coding spend not in the space ledger; completion is a push wake into chat. | B5 |
| celld | Binds only Pim/Auth/Directory/Gallery; coding and host-ops are not wired and would be offered then throw; `config.check.mjs` is not in CI and would fail at this SHA. Not evidence that coding runs off Cloudflare. | B6 |
| Atomicity | 13 host↔pi write pairings, all sequential with idempotent keys and startup repair (B2 §0.4). | B2 |
| Ids outside pi | Raw numeric conversation ids in ~30 host tables/meta keys and immutable trigger specs; entry ids public; therefore ids must be preserved, not remapped (B2 §0.3, B3). | B2, B3 |

### B.1 Entry index (completeness evidence)

**[B1](inventory/B1-identity-sharing-public-surface.md)** — 33 entries

- Owner ID / account record (tenancy key)
- Usernames
- Registration, claiming the Pim, invites, caps
- Passkeys (WebAuthn) and the sign-in ceremony
- Linked identities / external sign-in (Google, GitHub, OIDC)
- Sessions (browser cookie)
- Recovery codes, setup links, device links
- API tokens (`pim_<owner>_<secret>`)
- MCP server authorisation (OAuth for `/mcp`)
- Account status, suspension, deletion and erase (cleanup jobs)
- Account export (user data portability)
- Rate limiting and ingress trust (runtime profiles)
- Deployment settings (`PIM_*` variables) and secrets
- Admin API (`/api/admin/*`), admin-as-majordomo
- Machine credentials (computer, computer host, host-ops daemon, coding workspace)
- Circles and circle members (host side)
- Visits (visitor side) and guest brief
- Guest tool boundary (`guestCall`) and guest approvals
- Shared apps (artifacts shared to circles) and hosted-app access
- Templates (published agents), gallery, profiles, "people"
- Published apps and public app links
- Default agent for everyone
- Public bots (admin-shared agent link) and bot-guest accounts
- Chat public links
- Gateway routing table (URL shapes, in dispatch order)
- Space HTTP API (families; all under `/api`, answered by the owner's space)
- WebSocket endpoints and protocol
- Web app client-side caches and stored identifiers
- Web Push
- Connector callbacks and event ingress (webhooks)
- MCP server tool (`pim`)
- Cell basis for every non-uniform cell above (second pass)
- Unavoidable user choices (code cannot decide; need a product call)

**[B2](inventory/B2-conversations-agents-approvals.md)** — 29 entries

- 0.1 pi-durable records Pim registers (critical for partitioning)
- 0.2 Where the harness is built and how the space starts
- 0.3 Every place a pi conversation id, entry id or task id is stored outside pi (the ID-preservation matrix)
- 0.4 Atomicity / consistency hazards found (host write adjacent to a pi commit)
- Normal chats (sessions) — create, send, queue, stop, retry, reset
- Session/conversation IDs and the pi mapping
- Session info, title, archive, read state, delete
- Forks
- Compaction and reset
- Continuations (long chat carried on in a new chat)
- Group chats / rooms
- Delegation / tasks (agent handing work to another agent)
- Majordomo approval reviews (task kind `review`)
- Approvals and gated actions (parked tool calls)
- Tool permissions ("Always approve", Off/Ask/On)
- Agents (configuration) and agent ↔ conversation binding
- Per-conversation configuration (abilities/tools/model/instructions in `pi.agent`)
- Extensions, abilities and tool discovery (`pim.config.ts`)
- Native apps (built-in) and hosted apps
- Connectors: MCP client, directory and native connectors
- Pim as MCP server and OAuth provider (`mcp-auth`, `/mcp`)
- Account directory (src/directory.ts) and deployment connector directory
- Run guard (stoppable tools) and the run watchdog
- Progress lines
- Chat links (public read-only copies)
- Reports and diagnostics reads
- Messaging, `send_to_user`, notifications, push, widgets, `ui` block state
- Memory (optmem) background nap
- Trigger-made chats (cross-reference)

**[B3](inventory/B3-memory-triggers-models-notifications.md)** — 30 entries

- Memory (OptMem log + summary tree)
- Memory view in prompts / prompt-cache sections
- Skills (the person's own skills, versions, supporting files)
- Skill sources / install_skill
- Connector (app) skills and built-in skills
- Goals
- Scheduled tasks (`schedule_task`, list/cancel, `/schedules`)
- Triggers engine: store, revisions, occurrences, outbox, coordinator, host
- Time triggers and the wake (alarm)
- Connector-event triggers: subscriptions, ingress, webhook signing, event data
- Computer-source triggers (poll, stream, process, file) and grants
- Triggers HTTP API, agent tools and the screen
- Watches (`watch_connector_event`, `list_watches`, stop)
- Space alarms (non-trigger timers on the agents `schedule()` primitive)
- Alarm and timer entrypoint inventory (what a cutover must stop, then re-create)
- Notifications (in-app) and device delivery routing
- Web Push (VAPID)
- Email (confirmed address, sending)
- Run guard / stall activity / heartbeats
- Model selection (space, agent, chat), fallbacks, utility and memory models
- Custom model providers (own and admin-shared) and provider catalog
- Credential store and ChatGPT-plan sign-in (and Codex images)
- Provider cooldowns and failover (subscription usage limits)
- Model-call ledger, phases and pricing
- Usage meter and limits (per-space quotas)
- Compute ledger, quotas and compute providers (coding sandboxes)
- Settings (person's settings)
- Telemetry (OpenTelemetry traces)
- Diagnostics (events, admin majordomo tool)
- Export / erase coverage for this area

**[B4](inventory/B4-files-apps-computer.md)** — 22 entries

- 0.1 What depends on the personal computer, precisely (corrects the earlier blanket claim)
- 0.2 R2 key shapes and DO tables holding blobs or ids (for an exact copy + checksum migration)
- Note document (Markdown note = artifact kind `markdown` + live Yjs doc)
- Note agent tools (note_create/note_read/note_edit/note_list/note_show)
- Artifact (app) + version + file records
- Artifact rendering / sandbox headers (frame, download, runtime)
- Bridge (`window.pim`): app data, model ask, tools, grants
- Sharing to circles, publishing to Gallery, public links
- Personal files under `/workspace` (live on the computer)
- File-change notices (`pim_file_seen`)
- Legacy stored files (pre-computer)
- Code editor tabs and the canvas
- Hosted app (artifact kind `hosted`), release, data, port, secrets
- Chat images (user uploads) and kept media (`pim_images`)
- `generate_image` (Workers AI) and ChatGPT/Codex images
- Computer pairing record, token, connection
- Managed computers and the computer host (`pim-host`)
- Desktop (Cua `cua-spacesd`), displayd, takeover / control handoff
- Agents' browser on the computer, and takeover
- Computer-hosted trigger runtime (adjacent)
- Host operations (hostopsd, majordomo tools, audit)
- celld deployment profile (alternate runtime for the Worker) and `deploy/`

**[B5](inventory/B5-coding.md)** — 29 entries

- Coding thread DO — `CodingThreadDO` (lifecycle, state machine, recovery, wake)
- Scheduler — `CodingSchedulerDO` + `packages/coding/src/scheduler.ts` (slots, queue, breakers, login locks, thread index)
- Thread index / list / "seen" / "activity" / stalls
- Thread transcript, events stream, log, diff, tests, checkpoints, artifacts
- Normal-agent ↔ coding coupling: `coding_*` tools, completion wake, supervisor
- Harness: `pi` (Pim's own loop, sandbox-hosted)
- Harness: `claude-code` (Anthropic CLI, subscription login, sandbox-hosted)
- Harness: `codex` (OpenAI Codex CLI, ChatGPT-plan login, sandbox-hosted)
- Harness: `mistral-vibe` (Mistral Vibe CLI, API key, sandbox-hosted)
- Harness: `amp` (Amp agent-hosted "orb", remote API, NO sandbox)
- Harness (legacy): workspace Amp CLI (retired)
- Harness logins & the vault (credentials, injection, encryption)
- Workspaces, providers, pools, Cloudflare Containers, sandbox manager, workspace-agentd
- Environment preparation (snapshots, setup scripts, repo settings)
- Git broker, push/merge/PR flows, repository authorization
- Model gateway (`/api/coding/gateway/<anthropic|openai>/…`)
- Usage / cost accounting for coding
- Public API surface (docs/coding-api.md ⇄ src/coding/routes.ts)
- Approval / permission model summary (who may start coding, admin vs user)
- External session handles that survive a migration + in-flight job behavior at cutover
- 5.1 Roles and channels
- 5.2 (a) Who may start a coding thread; which harness / provider / pool / workspace type
- 5.3 (b) Who may use each pool / provider / harness
- 5.4 (c) Who may bring credentials / log in
- 5.5 (d) Who may authorize repositories
- 5.6 (e) Who may push / merge / open PRs
- 5.7 (f) Who may use admin-supplied infrastructure
- 5.8 Is "admin-supplied infrastructure + elevated per-user permissions + repository authorization" implemented?
- 5.9 PROPOSED HARDENING (not current behavior; do not treat as compatibility)

**[B6](inventory/B6-deployment-and-storage.md)** — 19 entries

- 2.1 `src/deployment.ts` settings (all plain variables)
- 2.2 Variables/secrets read outside `src/deployment.ts`
- 2.3 Derived/internal secrets (no variable; stored in DO storage) — all [V]
- 3.1 Per-owner `Pim` DO (class `Pim`, one per person) — constructed in `src/pim.ts:214-365` and `src/space/*`
- 3.2 Other DO classes
- 5.1 Request routing & hostnames
- 5.2 Client IP / geolocation
- 5.3 CORS / origin / CSRF
- 5.4 Cookies & WebAuthn
- 5.5 WebSocket hibernation
- 5.6 Size / time / memory limits that code is shaped around
- 5.7 Other platform assumptions
- 8.1 Gate: ingress, hostnames, static assets, headers
- 8.2 Identity & bootstrap (Directory + Auth)
- 8.3 Space actor (Pim DO) → Live
- 8.4 Object storage
- 8.5 Background jobs → Runner/Live timers
- 8.6 Coding / computers (optional subsystems)
- 8.7 Host operations

Plus [C-cutover-fence-entrypoints](inventory/C-cutover-fence-entrypoints.md): ingress table (18 routes), suspension effects, alarms for 9 DO classes, coding/Amp/computer/outbound effects, controls that exist or not, checklist.


## Part C — Cutover, rollback and verification plan [P]

Nothing here was executed. The plan is for the Pim → PostgreSQL/S3/NATS move of one deployment; it contains no flags, no per-user opt-in allowlist and no period of dual writes.

### C1. Principles

1. **One writer at any time.** The old Durable-Object execution is fenced *before* any new process can cause a side effect. There is never an interval where both can run tools, deliver notifications, push to git or call models for the same space.
2. **Write pause, not dual write.** Cutover is a bounded maintenance window per deployment (or per tenant, as a sequence of identical full cutovers — never a feature flag that leaves some functions on the old path).
3. **State moves once, by export/import**, with stable ids; no blind replay of effects and no projection rebuild that issues effects.
4. **Rollback is fencing in the other direction** and is only possible until the new system has accepted its first external effect after the window opens; after that, rollback is "forward fix" (C6).
5. Normal chat must work with **no coding infrastructure and no computer** after cutover; coding privileges are migrated separately.

### C2. Pre-flight (read-only, repeatable)

| Check | Evidence required |
|---|---|
| Inventory of every Durable Object class and R2/KV/secret binding (Part B6) matches the export manifest | manifest diff = empty |
| Per tenant: fork forest computed from `conversations.record` (fork parent edges); **no** `owner_task_id` / `owner_conversation_id` edge leaves a family except root → `optmem.nap` | report per tenant; any other edge is a stop |
| Every pi task kind and document kind present in the data is defined by the target registry at the same version (`pi.generation`, `pi.tool`, `pi.compaction`, `optmem.nap`, `pim.trigger_chat`, `pi.*` docs) | zero `missing_task`/`task_too_old` after a dry-run open of each partition on a copy |
| Key inventory: every secret/encrypted column and its key derivation (B3/B5/B6) has a target key and a re-encryption procedure | dry-run decrypt/re-encrypt of a sample per class |
| Capacity of target (PostgreSQL durability mode, S3, NATS) matches the declared requirements (A7.7) | settings printout |

### C3. Fence, then export (old system) — the deterministic procedure is [C-cutover-fence-entrypoints.md](inventory/C-cutover-fence-entrypoints.md) §10

Verified facts that drive it **[V, with refs in that file]**: **account suspension is not a fence** — it writes a status flag, aborts the space's chat runs once and closes sockets with 4003 (`src/accounts.ts:992-1002`, `src/pim.ts:1996-2004`), but does not stop `Pim.alarm()` (checks only erasure, `pim.ts:1964-1967`), the `PiHarness` wake jobs, `agents` jobs (`cf_agents_jobs`), MCP reconnects, push/subscription ticks, the Directory alarm that keeps erasing spaces (`directory.ts:607-633`), nor anything in `src/coding`; the erasure fence is destructive (`reports.ts:431-461`); the only existing hard ingress stop is an invalid `PIM_RUNTIME` (every request answers 503: `runtime.ts:17-18,58,133-138`, `gateway.ts:523-524`) and it stops nothing below the Worker.

Procedure (steps as in that file; **PROPOSED** where it says so):
1. Read-only inventory of ingress and variables; verify Directory cleanups are drained (the Directory alarm must finish erasures *before* the fence, §10 step 2).
2. Close registration (`PIM_REGISTRATION=closed`, existing control).
3. Suspend every non-admin account (existing control; paced by the API limiter) — this cancels in-flight chat runs once and refuses further API use; it is **not** the fence.
4. Fence ingress with an invalid `PIM_RUNTIME` (existing control).
5. **Stop alarms** with one of two PROPOSED controls, both needing separate review: (A) a durable freeze flag checked in every alarm/`onStart` entrypoint (`Pim`, `CodingThreadDO`, `CodingSchedulerDO`, `Directory`, `HostOps`), or (B) a **maintenance Worker version that exports every DO class as an inert shell** (no-op `alarm()`, 503 RPC, same bindings/migrations, never a `deleted_classes` migration). B is the sound fallback and the verification for A. Cloudflare keeps old DO code alive up to 300 s after a deploy by default, so verify per class (§10 step 7), not by assumption.
6. Stop outside-the-Worker work: Cloudflare containers, Compose sandboxes (manager sessions), host daemons; tell personal-computer owners that their hosted-app backends keep running locally. **Remote Amp sessions cannot be stopped from the Worker once fenced**: before step 4/5 the owner (or a PROPOSED admin RPC) calls `abort()` per agent-hosted thread and the handle, state and `lastEventAt` are recorded; afterwards only polling stops.
7. Snapshot only after the verification checks of steps 4-6 pass and `cf_agents_jobs` counts are unchanged across two reads ≥ 2 minutes apart.

**Export tooling is a prerequisite that does not exist** (`docs/instance.md:151`; no whole-DO dump route, B6 §7). PROPOSED: the maintenance version of B also hosts an authenticated read-only exporter per DO class (SQL tables, the DO key-value storage — which holds the MCP OAuth tokens: B6 — and R2 listings), reviewed separately.

Not stoppable and handled by adoption rather than fencing: remote Amp cloud agents; detached Compose execs (≤ 10 minutes after disconnect, `workspace-agentd/README.md:18`); Cloudflare containers until their 30-minute inactivity timer; computer-side hosted apps (`pim-computer.ts:1115-1121`); host operations a daemon already accepted.

### C4. Import / transformation

| Data | Transformation | Identity preserved |
|---|---|---|
| pi storage of a space | split by fork family into partitions (A6); copy records verbatim with their ids, `commit_seq`, document bases/deltas; set tenant id sequence > max id; set each partition `next_seq` > max seq; write `conversation_directory` rows | conversation/entry/task/submission/document ids; public chat UUIDs; message ids |
| In-flight pi state | `running` tasks are imported as `pending` (exactly what pi's open does); suspended tool tasks stay suspended; queued submissions keep `requestId`; `pi.live` partials stay committed (converted to an aborted entry on first run, as pi does) | task ids |
| Host `pim_*` tables | row copy to the application schema with the same primary keys (B1–B4 give each table) | all ids and token hashes |
| `agents` jobs: rows of `cf_agents_jobs` (schedule callbacks incl. `retryAfterCooldown`, `pi-wake:*`) and the six callbacks in B6 §4; trigger tables `pim_trigger_*` | translated into the new timer/outbox rows with the same due times and ids; **missed** due times fire once after cutover only if the entry's own semantics say so (e.g. approval expiry yes; a recurring schedule's missed occurrence follows trigger spec behaviour, B3) — never twice | schedule/trigger ids |
| Blobs | R2 → S3 with the same keys or a recorded key map; verify checksums; public URLs resolve through Gate with the same paths | file/artifact/image ids |
| Credentials / vault / native-app credentials | **keys, not plaintext, move**: the Directory `cookie_key` roots the vault, git-broker, gateway and Gitea HKDF keys (`vault/crypto.ts:21,35-45`, `broker.ts:147-151`, `model-gateway.ts:89-95`, `gitea-connection.ts:76-85`) and signs cookies (`auth/index.ts:143-146`); `APP_CREDENTIALS_KEY` (AES-GCM, AAD owner/connection/app/purpose, `native-apps.ts:505-507`) must be carried or every native-app sign-in becomes `ReconnectRequired`. Most other credentials are plaintext in SQLite (`pim_credentials`, `own_providers`, Gallery providers, VAPID, subscription secrets: B3). Re-encryption at rest is PROPOSED HARDENING, not compatibility; verify by canary decrypt per class | credential ids |
| Passkeys / sessions / API tokens | credential public keys copied; relying-party id = `PIM_PUBLIC_URL` hostname must be kept; cookies stay valid iff `cookie_key` is copied; API tokens are unsalted SHA-256 hex of the full `pim_<owner>_…` string (`auth/store.ts:102-106`), so hashes migrate as-is | credential ids, token ids |
| MCP OAuth tokens | held in the `Pim` DO key-value storage (`pim.ts:669-692`), plaintext; export must read KV as well as SQL or people reconnect connectors | server ids |

Import is **idempotent per tenant** (a `migration_runs(tenant, source_hash, status)` row) so a failed import is re-run from the same snapshot.

### C5. Activation (new system) and effect ambiguity

1. New Runners start with **activation disabled** for imported tenants (an operational pause of the *new* system, not a feature flag). Verification (C7) runs read-only against the imported data.
2. Enable activation. Partitions with live tasks are claimed, opened, resumed. Resumed `running` tool tasks follow pi's recovery rule: `unsafe` tools produce an `interrupted` result, `safe` tools re-execute; tasks that were in an *intent* phase for effects outside pi (delivery, coding turn submission, git push) go through that effect's own idempotency/polling path (A10, B5).
3. Held webhooks/triggers from the maintenance log are replayed through the normal ingress with their original delivery ids so de-duplication applies.
4. Approvals decided during the pause are applied as ordinary decisions (`resumeTask`) after activation, not on the old system.

### C6. Rollback

- **Before activation (C5.2):** rollback = discard imported data and undo the fence in reverse order (deploy the previous version, restore `PIM_RUNTIME`/`PIM_REGISTRATION`, unsuspend each account: fence doc §10 step 10); alarms resume from stored rows. The old state is unchanged because it only ever *read* after the fence. Missed trigger firings follow their catch-up rules. Cost: the maintenance window.
- **After activation:** the new system is authoritative. Returning to the old system would require exporting back and is **not** a supported rollback; the recovery path is forward fixes. The old snapshot is kept read-only for a defined retention period for forensic recovery of individual records.
- Both directions use the same fencing rule: whichever side is not authoritative is stopped (alarms, Workers, DO access) before the other starts.

### C7. Evidence required to declare a tenant migrated

1. Row/record counts per table and per pi record type equal on both sides (conversations, entries, tasks by status, submissions by status, documents), plus a content hash per partition over ordered entries.
2. For a sampled and for all *active* tenants: every public chat UUID resolves; for each chat the projected transcript equals the old projection byte-for-byte (the shared `projectEntries`); message ids and fork points match.
3. Every approval pending in the old system is pending in the new one with the same ids; suspended tool tasks are suspended and wake on decision.
4. Every schedule/trigger due within the next period is present exactly once.
5. All blobs present with equal checksums; a sampled set fetched through the new public URLs.
6. Decrypt canaries for each secret class succeed on the new key.
7. A scripted **no-coding, no-computer** user journey (sign in, chat, tools, memory, approval, schedule) passes on the new system.
8. Where coding is enabled: adopt-handle test per harness (B5) — an imported thread reports its status without issuing a new turn.
9. A failure drill on the new system: kill a Runner mid-stream; the partition is re-claimed, the partial is converted, the run continues, no duplicate tool effect for an `unsafe` tool.

### C8. Permission matrix

See B1 Part 4 (with the E/A/U cell basis and the 18 classified gaps) and B5 §5 (privilege trace); a summary is in Part G of the main report.


## Part D — Concrete acceptance and failure tests (all proposed; none run)

Storage/ownership: A11. Partitioning at import: nested forks land with all ancestors; the union-find check fails on any task/submission/document/`head`/`edits[].target`/tool-input reference leaving a component or any `owner` edge other than A4; no partition contains conversation 1 except home and no `root()` call occurs elsewhere; imported `Seq`/`asOf` reads return the same document values as before the split for a sample of forks (`document.copy` at fork time); minted ids after import exceed every imported id across partitions. Host races: A8. Projections: rebuild from canonical state yields identical projections and calls no tool/model/delivery. Fence: each §10 step check of the fence document, including per-class "old code no longer running". Product: each entry's acceptance test; no-coding/no-computer journey; per-harness adopt-handle test; Runner-kill drill. Qualification harness (to be built): N active runs per Runner with a scripted faux provider, reporting commit rate, commit p99, activation lag, memory, PG connections — a harness, not a result.

## Part G — Permissions, coding privileges and resolved decisions

### G.1 Permission operation matrix and gaps

The matrix with a cell basis (E explicit rule with `path:line` / A absent enforcement with the searched routes / U uncertain) is [B1 Part 4](inventory/B1-identity-sharing-public-surface.md); the identity hand-off trace between spaces is B1 "Guest / visitor identity trace". The 18 gaps are classified there. Summary of what **current behavior** is (to preserve unless a user decision below changes it):

- Inter-space RPC identity is vouched by the calling space, not verified; callee checks go by `guest.ownerId` only; `runBotTool`/`botImage` do not check the `guest` argument (A, searched all RPC methods; no `@callable`/`routeAgentRequest`).
- API tokens are unscoped and unexpiring ("an API token opens your whole API", `docs/reference.md:825`); session-only operations are the enumerated list in B1 gap 3.
- Hosted apps have a third access level `public` served anonymously (`app-manifest.ts:22-30`, `pim.ts:2137`).
- Sign-out is client-side only; there is no server-side session table; suspended authors' public content stays served (deliberate separation, `gallery.ts:26-28`).
- Guests can reach `/mcp` connector management routes (A).
- Role and username are immutable (only `UPDATE accounts` sites at `directory.ts:500,512,547,594`).

### G.2 Coding privileges today (B5 §5)

| Question | Current state |
|---|---|
| Who may start a coding thread, with which harness/provider/pool | Any non-guest signed-in user or API token of the space; guests refused over REST (`routes.ts:25`), not inside `startThread` or tools; the person's own configured harness logins and the deployment's pools apply. |
| Per-user coding permission | **None**; only admin role and a per-person compute quota exist. |
| Repository authorization | Optional deployment env allowlist `PIM_GIT_REPOS`; **unset means any repository** (`config.ts:28,121-122`, `broker.ts:68-70`); no per-user, per-agent or per-repo grants. Gitea admin routes need role=admin and refuse API tokens (`gitea-api.ts:30-32`, `accounts.ts:800-801`). |
| Push/merge/PR | UI push files an approval (`routes.ts:178-187`); REST PR opens without approval; agent `coding_push`/`coding_merge` act immediately (`extensions/coding.ts:335-349`); `coding_merge` has no REST route; default-branch protection is external to Pim. |
| Credentials | Agents can spend the person's stored harness logins and Amp token (vault checks only that the thread is in the space, `inject.ts:61-62`). |
| Admin-supplied infrastructure | Per deployment (pools, shared provider keys, Gitea); admin-only management routes. |
| **Verdict** | The stated intent (admin infrastructure + elevated per-user permission + repository authorization) is **partly implemented**: admin-supplied infra yes; per-user elevation and per-repo authorization are **PROPOSED HARDENING** (B5 §5.9), not existing behavior. |

### G.3 Resolved implementation decisions (recommendations the audit makes without user input)

| # | Decision | Basis |
|---|---|---|
| R1 | Partition = conversation family; coding threads = their own partitions | A5–A6 |
| R2 | pi ids unchanged from a tenant-wide sequence; `PartitionId` separate; public ids unchanged | A6.2–3 |
| R3 | `Harness.root()` only in the home partition; directory row `1 → home` | A6.4 |
| R4 | Import preserves `Seq`, `next_seq` = original tenant max | A6.5 |
| R5 | Stay on pi-durable 1.1.0 + patch; host contract per A8; any 1.4+ move is a separate decision | A1, A8 |
| R6 | Approval decisions and all signals durable in the application schema; host re-applies `resumeTask` after activation | A2, A8 |
| R7 | No claim of host/pi atomicity; keep two-phase operations with stable ids | A3 |
| R8 | Cutover uses suspend + invalid `PIM_RUNTIME` + (alarm stop via maintenance Worker or freeze flag) + verified checks; suspension alone never counts as a fence | fence doc §10 |
| R9 | Export tooling is a prerequisite (maintenance-version exporter), reading SQL **and** DO key-value storage | C3 |
| R10 | Carry `cookie_key` and `APP_CREDENTIALS_KEY`; keep RP id/hostname; tokens migrate as hashes | B.0 |
| R11 | Preserve all current permission behavior (G.1–G.2) as compatibility; hardening is a separate announced change | B1, B5 |
| R12 | No coding infrastructure or computer required for normal chat; `coding_*`/computer tools are withheld when absent (`pim.ts:2316-2322,2337`, `abilities.ts:105-112`) | B4, B5 |
| R13 | celld/Compose parity claims exclude coding and host-ops until they are wired | B6 |
| R14 | `?token=` in URLs and plain-HTTP behavior preserved; HTTPS-only recommended | B1 gaps 10, 18 |

### G.4 Unavoidable user choices (with recommendations)

| # | Choice | Recommendation |
|---|---|---|
| U1 | API token scope/expiry (B1 gap 3) | Preserve at cutover (hashes must keep working); add optional scopes later |
| U2 | Admin token reach: share-bot and Gitea admin by token (gap 4) | Preserve now; make session-only with `/admin` in a separate announced change |
| U3 | Suspended authors' public content (gap 5) | Hide it after the baseline is established |
| U4 | Admin continuity, last-admin delete, 15-minute claim window after deploy (gap 6) | Single admin at cutover; add "last admin cannot delete self" first |
| U5 | Server-side session revocation (gap 7) | Yes in the new architecture; forced re-login unless `cookie_key` is copied |
| U6 | Per-user coding permission and per-repo authorization (B5 §5.9) | Product decision; do not present as migration compatibility; start from current deployment allowlist semantics |
| U7 | Whether agent `coding_push`/`coding_merge` should require the approval the UI push route files (B5) | Preserve now; decide with U6 |
| U8 | Keep the `cookie_key` carry-over (continuous sessions) vs forced re-login | Carry it (R10) |

## Part E — Remaining open questions (specific)

| # | Question | Where |
|---|---|---|
| Q1 | Does `PiSession.abort` durably end held-for-retry generation tasks? (fence mitigations depend on it) | fence doc §12 |
| Q2 | Container execs: detached like Compose? does outbound-only CLI activity renew the 30-minute timer? | fence doc §12 |
| Q3 | Behaviour of a pending DO alarm when its class export/binding is removed (the procedure avoids it) | fence doc §12 |
| Q4 | PostgreSQL durability mode and failover policy for the Compose and scalable profiles | A7.7 |
| Q5 | Whether one `Registry` instance can be shared by several Harnesses of a tenant (cost of ~30 extension installs per open) | A6 |
| Q6 | Residual timing question: a host `ctx.storage.sql` write landing inside pi's open DO transaction (A3) — irrelevant to PostgreSQL, relevant only to explaining historical behaviour | B2 §0.4 |
| Q7 | Pi 1.4+ upgrade (adds `wake()`, `restarts`, a different publication model): separate decision after this foundation | A1 |
| Q8 | Items marked [U] in fragments (B1 unread areas, B2 §1 entries, B6 unbound-bucket behaviour, `cf_agents_*` live table set) | fragments |

## Part F — Implementation brief inputs (not authorisation)

1. PostgreSQL `Storage` adapter for pi-durable 1.1.0 per A7; `createStorageConformance` first; then the adapter suite (A11).
2. Conversation directory, family closure rules, tenant id sequence, `root()` discipline (A6).
3. Lease/activation/signal-outbox/timer tables and the Runner loop against 1.1.0 APIs (A8).
4. Application schema carrying `pim_*` tables with primary keys unchanged (B2–B4); S3 key map (B4 §0.2).
5. Maintenance-version exporter, import with family split, verification report (Part C, fence doc).
6. Forge module reproducing five harnesses/vault/broker/pools (B5), after settling its 8 doc/code discrepancies.
7. Self-host profiles from the B6 admin-infra matrix; celld/Compose parity statement per R13.
8. First checks to write: Q1, Q2, Q3 (cutover), Q5.

## Appendix — provenance and method

pi: `https://github.com/earendil-works/pi` tag `v1.1.0` = `abe508e1b89912adde45528136c3221eb69acdd7`; agents tag `agents@0.27.0` (peeled `e335186331f99be12609a5eb0c64c7863c3ccafd`). Tarballs from the npm registry for 1.1.0, 1.2.0, 1.3.0, 1.4.0, 1.5.2 (hash-checked only by content comparison, not by registry signature). Part B inventory was produced by read-only reviewers over the audited commit in two passes and merged here. Nothing was executed against Pim, Cloudflare, PostgreSQL, NATS or S3.
