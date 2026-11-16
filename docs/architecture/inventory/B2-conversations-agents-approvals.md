<!-- Part B inventory fragment B2. Audited commit 30818438bdc0581e5960d20d8f30310fd5fbc7b7. Read-only audit; labels VERIFIED/UNVERIFIED are inside. -->
# Fragment B2 — normal conversations, agents, tasks, approvals, extensions, connectors (commit 30818438)

Paths are relative to the repo. `PD:` = `node_modules/@earendil-works/pi-durable/dist/` (pi-durable 1.1.0, read as installed, not as source). `PH:` = `node_modules/agents/dist/harness/pi/index.js`. Coding threads (`src/coding/*`) are out of scope. Everything marked UNVERIFIED was not confirmed by reading code.

Verification round 2: sections 0.1.1, 0.3 and 0.4 were re-derived from code (pi-durable source `/tmp/pi/src/packages/durable/src`, 1.1.0, same as installed `PD`) and are [V] unless marked. Sections 1 (entries) had their `path:line` refs bounds-checked, their `~` refs replaced by exact lines, and the claims touched by 0.3/0.4 corrected; entries NOT re-read in full this round (Extensions, Native apps, Connectors, MCP server, Directory, Run guard, Progress, Chat links, Reports, Messaging, Memory) keep the previous round's labels and should be treated as [U] where they cite behavior without a precise line.

## 0. Cross-cutting facts

### 0.1 pi-durable records Pim registers (critical for partitioning)

**Task kinds** (`defineTask`). Pim registers exactly ONE of its own. All others are pi's built-ins that Pim uses through `PiHarness`.

| Task kind (`name`/`kind`) | Version | Defined at | Owner / scope | Checkpoint / state shape | Notes |
|---|---|---|---|---|---|
| `optmem.nap` (Pim's only `defineTask`) | 1 | `src/extensions/optmem/index.ts:215` | `{ownership:{kind:"conversation"}, background:true}` created on the ROOT conversation (`src/pim.ts:1054-1056`, also created from a tool call, `src/extensions/optmem/index.ts:313-318`; both `{ownership:{kind:"conversation"}, background:true}`) | phases `next` / `summarize{scope?,lo,hi,attempt}` / `retry{...,until}` (`index.ts:215-296`); `scope` is optional because older checkpoints predate scopes (the default is applied at `index.ts:231`: `scope = PRIVATE_SCOPE`) | Task id stored as meta `nap_task` in the optmem store (`optmem_meta`, `index.ts:304,310`), not in `pim_meta`. Crosses conversations: it reads/writes memory shared by all agents. |
| `pi.generation` | 1 | `PD harness/generation.js:22` | conversation | model request, retry/defer state, tool slots | A run "held after a model error" is a `pi.generation` task with `state.status=="waiting"` and `on.length==0` (`src/space/models.ts:191-193`). Pim resumes it with `resumeTask` (`models.ts:183-189`). |
| `pi.tool` | 1 | `PD harness/tool.js:18` | conversation | input holds `callId`; `api.memo(...)` values are the per-call memo | A tool call that returns `{control:{suspend:true}}` is a SUSPENDED `pi.tool` task. Pim finds it by `(conversationId, input.callId)` (`src/space/approvals.ts:240-250`, `conversations.ts:1032-1049`). |
| `pi.compaction` | 1 | `PD harness/compaction.js:55` | conversation | | Pim hooks `beforeCompact` (`src/space/abilities.ts:279-296`). |

**Document definitions** (`defineDoc` / `defineDocFamily`). Pim defines ONE doc and ZERO families; all others are pi's.

| Doc `kind` | Scope | history/fork | Defined at | Used by Pim at |
|---|---|---|---|---|
| `pim.trigger_chat` `{operationId}` (Pim's only `defineDoc`) | conversation | `latest` / `initial` (a fork starts blank) | `packages/triggers/src/host.ts:53-59` | `packages/triggers/src/host.ts:238-239` (written in the chat-creating `init`, which buffers the doc write into that pi commit; see 0.4.0); read in `src/space/triggers.ts:635` |
| `pi.live` (`LiveDoc`) | conversation | latest / initial | `PD harness/live.js:4` | `src/space/conversations.ts:1006`, `reports.ts:189`: watchdog and `waitingOn` read `live.run`, `live.generation.retry/deferred`, `live.compactions`, `live.tools[].callId` |
| `pi.inbox` (`InboxDoc`) | conversation | latest / initial | `PD harness/inbox.js:4` | `conversations.ts:793` (queue edit inside `conversation.commit`), `:952` (requeue on stop), `abilities.ts:314` (resting check) |
| `pi.provider` (`ProviderDoc`) | conversation | latest / initial; fresh `sessionId` per fork | `PD harness/provider.js:5` | `reports.ts:324` |
| `pi.usage` (`UsageDoc`) | conversation | latest / initial | `PD harness/usage.js:4` | `src/space/routes.ts:596` (`/sessions/:session/cost`) |
| `pi.agent` (`AgentDoc`) | conversation | **rewindable** / `asOf` (a fork starts from the agent state at its fork entry) | `PD harness/agent.js:23` | written by `conversation.configure(...)`: `abilities.ts:131-160`, `approvals.ts:535-540`, `pim.ts:601` |

No Pim doc has `session` or `task` scope. Every doc above is conversation-scoped, so the partition key for docs is the pi conversation id.

**0.1.1 Every pi conversation, task and ownership edge Pim creates (re-enumerated; search `rg -n "sessions\.create\(|\.createConversation\(|\.fork\(|\.root\(|createTask" src packages/*/src`, coding excluded).** [V]
- Task kinds created BY Pim code: only `optmem.nap`, at `src/pim.ts:1054-1056` and `src/extensions/optmem/index.ts:318`, both `ownership:{kind:"conversation"}` (task owned by the conversation it was created in; created on ROOT at `pim.ts:1054` via `root.commit`; the tool-call path at `optmem/index.ts:318` creates it on the calling tool's conversation, which may be any chat; `startNap` guards "one at a time" only through meta `nap_task`, `:303-310`) and `background:true`. Every other task (`pi.generation`, `pi.tool`, `pi.compaction`) is created by pi itself, conversation-owned.
- Doc kinds created by Pim: only `pim.trigger_chat` (`packages/triggers/src/host.ts:53-59`, conversation scope). No doc families (`rg -n "defineDocFamily" src packages/*/src` finds none).
- Conversation creation, with ownership `{kind:"ownerless"}` in every case (pi's `sessions.create` `PH:677-684`; explicit at `conversations.ts:331,333`, `abilities.ts:369`): (1) ROOT: `pi.root(BG,{agent})` at `PH:562` (the only `kind:"root"`, no ownership); (2) normal chat default path `sessions.create()` `conversations.ts:334`; (3) trigger-made chat via `createConversation({init})` `conversations.ts:333`; (4) fork `conversation.fork` `conversations.ts:331`; (5) continuation `createConversation({init: CompactionEntry})` `abilities.ts:367-380`; (6) task chat `#taskConversation` `conversations.ts:462`; (7) room seat `#seat` `conversations.ts:837`; (8) majordomo review chat `approvals.ts:533`; (9) a visit's conversation in the host's space `src/space/sharing.ts:680`. `PH:685-694` `sessions.fork` has no caller outside pi's harness. 
- Ownership edge `{kind:"task", taskId}` (conversation owned by a task, e.g. a subagent tool's): not used by Pim (no `kind: "task"` ownership in `src/` or `packages/*/src`: searched). So Pim creates NO conversation-owned-by-task edges; the only ownership edge it writes is task→conversation `{kind:"conversation"}` for `optmem.nap`, plus pi's own for generation/tool/compaction. pi's `parent` (fork ancestry, `PH:696-713`: `record.parent.conversationId`) is the other edge, created by (4) only.
- Entry kinds written by Pim: `pim.room` through `{type:"write"}` submissions (`src/rooms.ts:63`, `conversations.ts:771-785`); `CompactionEntry` in an `init` (`abilities.ts:372`). Everything else comes from pi's `submit`.

**Pi entry kinds** Pim writes or relies on: `pi.user`, `pi.assistant`, `pi.system`, `pi.tool-result`, `pi.reset`, `pi.compaction` (`PD entries.js:11-30`), plus Pim's own custom kind `pim.room` (`src/rooms.ts:63`, written through a `{type:"write"}` submission at `src/space/conversations.ts:771-785`). A `CompactionEntry` with `head:"self"` is appended inside a conversation-creation `init` (`abilities.ts:362-378`). Entry ids are pi-minted and Pim stores them in: `pim_ui_state.message`, fork `at`, `read_chat`. UNVERIFIED: whether EntryId is numeric (`EntryId` type is imported in `conversations.ts:6`).

Pim extensions installed into the registry (all stored BY NAME in each conversation's `pi.agent` doc, `configure({extensions:{add:[...]}})`, so names are frozen API): `pim.telemetry`, `pim.progress`, `pim.continuation`, `pim.agents`, `pim.skills`, `pim.goals`, `pim.schedule`, `pim.messaging`, `pim.chats`, `pim.tasks`, `pim.rooms`, `pim.review`, `pim.approvals`, `pim.triggers`, `pim.triggers.computer`, `pim.web`, `pim.artifacts`, `pim.notes`, `pim.files`, `pim.canvas`, `pim.hosted`, `pim.images`, `pim.bot-tools`, `pim.browser`, `pim.desktop`, `pim.apps`, `pim.app.<serverId>`, `pim.visit.<ownerId>`, the optmem memory extension, plus every extension id from `pim.config.ts` (`src/extensions/define.ts`, docs/extensions.md: "id … stored in people's agents and chats: don't rename it"). Source lines: `src/pim.ts:491-575` (install order), constants in `src/rooms.ts:270`, `src/tasks.ts:418`, `src/majordomo.ts:22`, `src/space/abilities.ts:34`, `src/progress.ts:16`, `src/telemetry.ts:36`, `src/extensions/mcp.ts:228-229`, `src/visits.ts:71-72`.

### 0.2 Where the harness is built and how the space starts
- One `PiHarness` per space: `src/pim.ts:491-608` (`harness:` callback runs `Harness.open(storage, {models, registry, settings, onReport}, context)`). The callback itself has HOST SIDE EFFECTS: `migrateAlwaysApproved()`, installing all extensions, waiting for MCP connections (`:559`, 5 s), and a one-time migration that calls `configure({instructions:null})` on every chat in `pim_agent_sessions`, guarded by meta `pim_section` (`:596-605`). A new storage adapter must keep "open harness" side-effect free or make it idempotent.
- Restart recovery is in `Pim.onStart` (`src/pim.ts:1162-1197`): `resumeTasks()`, `resumeDecided()`, `armWatchdog()`, `ensureTriggerEngine()`, socket watch restore. These are the host's half of resumable state; they MUST run after a migration (Runner start).
- Conversation ids: pi mints them. `ROOT_SESSION = String(ROOT_CONVERSATION_ID)` (`PH:247`). New chats: `harness.sessions.create()` (`PH:676-681`, `ownership:{kind:"ownerless"}`), `createConversation({init})` (`conversations.ts:335-337`), `conversation.fork(at,{ownership:{kind:"ownerless"}})` (`conversations.ts:331`, `PH:689`). Host tables key by `String(conversationId)`; `Number(session) as ConversationId` is used in every direct doc read (`conversations.ts:1006`, `abilities.ts:314`, `reports.ts:189`, `pim.ts:601`).

### 0.3 Every place a pi conversation id, entry id or task id is stored outside pi (the ID-preservation matrix)
Search: `rg -n "(session|conversation|chat|message|entry|task|room|root|seat|requester|origin)[a-z_]* (TEXT|INTEGER)" src packages/*/src` over every `CREATE TABLE` (all tables listed by `rg -n "CREATE TABLE" src packages/*/src`), plus `pim_meta` key builders, scheduled-callback payloads, operation-id builders, public API/push/WebSocket payload builders. Coding tables (`src/coding/*`, `pim_activity`/`pim_stall_episodes` ids, which are coding thread/call ids, `src/coding/thread-do.ts:294-295`) are out of scope. [V unless marked]

**Id shapes.** Conversation id: numeric string, minted by pi; Pim parses it as `/^[1-9]\d*$/` and `Number(id)` (`src/space/triggers.ts:603`; `Number(session) as ConversationId` `conversations.ts:1006` etc.). Entry id: numeric string, GLOBALLY unique across conversations: `storage().entry(Number(id) as EntryId)` is called with the entry id alone (`src/space/views.ts:167`). Task id: pi `TaskId`, converted with `Number(batch) as TaskId` (`conversations.ts:542`) and `Number(known) as TaskId` (`optmem/index.ts:304`). Inbox item id: number (`/sessions/:session/queue/:id`, `routes.ts:714-735`, `changeQueued` `conversations.ts:790-`).

**A. Host SQLite tables (same DO file, `src/store.ts:152-278` unless noted), with the raw (internal) id column. Export 1:1 if pi ids are preserved; ALL must be rewritten in one transaction if not.**
- Conversation id: `pim_sessions.id` (`store.ts:213`), `pim_sessions.continued_from/continued_to` (added at `store.ts:469-471`), `pim_session_ids.session` (`:222-225`; the public UUID `id` is the PK), `pim_agent_sessions.session` and `pim_session_abilities.session` (`src/agents.ts:139-146`), `pim_rooms.session`, `pim_room_seats.conversation/room`, `pim_room_past_seats.conversation/room` (`src/rooms.ts:73-91`), `pim_tasks.conversation/requester/root` (`src/tasks.ts:96-99`; `requester` null for reviews), `pim_approvals.session` (`store.ts:171`) and JSON `pim_approvals.member` = `{name, session}` (`store.ts:72`; `member.session` is the room seat's conversation) and `pim_approvals.requested_by` JSON (a guest's `session`, which is a conversation in the GUEST's space, `store.ts:74-78`: not exportable by this space's export, cross-space), `pim_tool_widgets.session` (`:232`), `pim_file_seen.session` (`:265`), `pim_goals.session` (`:165`), `pim_emails.session` (`:155`), `pim_notifications.session` (`:243`; raw; the public payload swaps in the public id, `views.ts:313-318`), `pim_chat_links.session` (`src/chat-links.ts:41`), `pim_images.session` (`src/images.ts:55`), `pim_artifacts.session` (`src/artifacts.ts:134`), `pim_run_watch.session` (`src/run-guard.ts:48`), `pim_shares.session` (`src/visits.ts:65`; the visit's conversation in the host space), `optmem_log.source` = `String(api.conversationId)` (`src/extensions/optmem/index.ts:345,434`; `store.ts:52-61`), `pim_trigger_host_operations.chat_id/submission_chat` (`packages/triggers/src/host.ts:67-70`), `pim_trigger_runs.chat_id` (`packages/triggers/src/coordinator.ts:57`; a DB trigger forbids changing it once set, `coordinator.ts:83`), and inside IMMUTABLE JSON: `pim_trigger_revisions.spec` → `originChatId` and `destination.chatId` (`packages/triggers/src/spec.ts:120,103`; revisions are immutable by a DB trigger, `store.ts:44-45`). Consequence: trigger revisions and runs reference raw conversation ids that the schema forbids rewriting by UPDATE, so a renumbering import would have to rebuild trigger tables, not just remap: PRESERVE the ids.
- Entry id: `pim_ui_state.message` (`store.ts:273`), meta `ui_state_sweep_cursor` (`views.ts:30`; a message id).
- Task id (pi): `pim_tasks.batch` = `String(api.taskId)` for a `delegate` call (`src/tasks.ts:504`) or `review:<approvalId>` for reviews (`src/space/approvals.ts:528`), meta `optmem_meta.nap_task` (`optmem/index.ts:304,310`). NOT pi ids: `pim_tasks.id/parent` (Pim's 10-hex ids, `tasks.ts:151`, `parent: asking.id` `conversations.ts:432`); `pim_tasks.call` and `pim_approvals.call_id` are pi tool CALL ids (strings from the model's assistant entry, `tool.ts:readCall`), not task ids, but they must equal the callId in the parked task's input.
- Public ids used instead of raw ids (no remap needed, only the mapping): `pim_model_calls.chat_id` and `pim_usage_daily.chat_id` (`src/space/reports.ts:125,295` pass `publicId`), hostops `ops.caller_chat_id`/`audit.chat_id` (`src/pim.ts:1721-1724` `conversationOf` returns `publicId`), notifications' client payload and the Web Push message (`src/pim.ts:1470-1478` uses `publicNotification`, `views.ts:313-318`).
- Not an id: `pim_sessions.summary_of` is a hash of the conversation (`store.ts:866`), `pim_ui_audit` has no conversation column (`store.ts:255-263`), `pim_usage_*` tables are per-day counters without ids (`src/usage.ts:93-112`), `pim_diagnostic_events.detail` is scrubbed free text (may contain ids; not relied on).

**B. `pim_meta` keys embedding conversation ids** (`pim_meta(key,value)`, `store.ts:226`): `awaiting:<s>` (`src/space/shared.ts:37`), `archive-when-idle:<s>` (`shared.ts:8`, `pim.ts:517`), `suggestions:<s>` (`shared.ts:128`), `fork:<s>` (`shared.ts:131`; value is a title), `coding_woken:<…>` (`src/space/coding.ts:22`; shape of the suffix UNVERIFIED), and `ui_state_sweep_cursor` (entry id).

**C. Scheduled-callback payloads (agents SDK schedule table, outside `pim_*`).** `pushReply {session (raw conversation id), at, body}` (`src/pim.ts:1077,1436`); `expireApproval {id}`, `expireReview {id}` (approval UUID; `approvals.ts:111,130`; guest: `sharing.ts:362,858`); `watchRuns {via}` (`conversations.ts:984`); provider cooldown, trigger tick (no ids). Only `pushReply` carries a conversation id.

**D. Operation ids (stored inside pi submissions AND recomputed by the host) that embed Pim or pi ids.** `task:<pimTaskId>`, `task-update:<pimTaskId>@<updatedAt>,…` (`conversations.ts:449,549`), `review:<approvalId>`, `join:<seatConversationId>`, `joined:<seatConversationId>:<agentId>`, `left:<seatConversationId>:<agentId>` (`conversations.ts:844-845,865`), `post:<conversationId>:<at>:<agentId>` (`:712`), `requeued:<session>:<pi event id>` (`:959`), `reply-<publicId>-<at>` (`pim.ts:1446`), `mention-<publicId>-<speakerId>-<at>` (`conversations.ts:734`). Renumbering conversations changes the raw-id ones, breaking replay idempotence for in-flight fan-outs; they are no-ops only if the same ids appear.

**E. Public API / WebSocket / push / URL payloads.** Chat URLs and `/api/sessions/<publicUuid>/…` use the PUBLIC UUID (`views.ts:141-157`); WebSocket `sessions`/`progress`/`tasks`/`canvas_*` messages use the public id (`conversations.ts:1051`, `sockets.ts:587,606`). But RAW pi ids leave the space in: (1) transcript message ids = `String(entry.id)` (`packages/shared/src/transcript.ts:179,182`; used as fork `at`/`before` in `routes.ts:316-334` and as `pim_ui_state.message`), (2) queue item ids (`routes.ts:714-735`), (3) the trigger STORE holds raw ids (`spec.ts:103,120,261`) but the trigger API view converts `origin.chatId`, `destination.chatId` and run `chatId` to public ids (`packages/triggers/src/api.ts:615-616,639`; `src/space/triggers.ts:443` `publicChat`), so only the internal `TriggerActor.chatId` (`api.ts:64`) is raw; (4) `chat_history`/other tools expose room ids to models (UNVERIFIED which). Task ids shown to agents/API are Pim's 10-hex `pim_tasks.id`, never pi task ids. WebSocket connection state holds the raw session (`sockets.ts:283,485,611`) but is ephemeral (clients reconnect).

**F. Task/doc state inside pi that names other ids** (preserved if pi export is verbatim): the `pi.tool` task input `callId`, memos `approval` (UUID), `prepared`, `images`, `email`, `responseAt`; `TriggerChatDoc.operationId`.

Import rule that follows: conversation ids, entry ids and the pi task ids in `pim_tasks.batch`/`nap_task` must be preserved exactly; otherwise rewrite every column in A, B, C, D and the immutable trigger rows, which is not possible by UPDATE for triggers.

### 0.4 Atomicity / consistency hazards found (host write adjacent to a pi commit)

**0.4.0 What shares a SQL transaction with a pi commit (re-proved; this corrects an earlier claim that `init` "stages a host write inside the pi commit").**

How a pi commit runs [V]: `Session.commitWith` runs the caller's callback (`change(tx)`: this is where `ConversationInit`/`init`, `conversation.commit(...)`, `runtime.commit(...)` callbacks run) first, against an in-memory `Transaction` that only BUFFERS writes (`/tmp/pi/src/packages/durable/src/session/session.ts:405-432` (callback at `:415`), same code in installed `PD session/session.js:250-285`; pi-durable 1.1.0 in both). Only after the callback returns does `await this.#storage.commit(writes)` run (`session.ts:428`), and that is the one place a SQL transaction is opened: `SqliteStorage.commit` → `this.db.transaction(async tx => {…applyTableWrite…applyDocumentActions…UPDATE durable_metadata})` (`/tmp/pi/src/packages/durable/src/storage/sqlite/storage.ts:174-196`). In the Cloudflare adapter that `db.transaction` is `ctx.storage.transaction(async …)` held under an `OperationQueue` (`PH:195-236`, `transaction` at `:228-236`). Therefore:

- Callback bodies (`init`, `conversation.commit(fn)`, `runtime.commit(fn)`, `api.memo` candidates) run BEFORE and OUTSIDE the SQL transaction of their own commit. A `ctx.storage.sql.exec` made from them is an ordinary host statement, autocommitted by the Durable Object, NOT part of the pi commit's transaction, and it is NOT rolled back if the pi commit later fails (e.g. a rejected commit, or `init` throwing afterward). `pi.ConversationInit` docs say "Runs inside the creating commit … table reads here throw ReadAfterWrite" (`/tmp/pi/src/packages/durable/src/harness/types.ts:346-351`): "inside the commit" is pi's logical unit (the buffered `tx`), not the SQL transaction.
- Hooks (`beforeRequest`, `afterResponse`, `afterTools`, `beforeTool`, `afterTool`, `beforeCompact`) are awaited in task handlers outside any commit (`/tmp/pi/src/packages/durable/src/harness/tool.ts:67-79`, `generation.ts:197-200`, `compaction.ts:129-132`; commits in these handlers are separate `runtime.commit` calls, e.g. `tool.ts:85-90`). Tool bodies run after that (`tool.ts:91` `run(...)`) also outside commits. `api.memo(name, candidate)` takes a VALUE, evaluated by the caller before the call; the memo is persisted by its own commit (`scheduler.ts:1170-1185`).
- Possible accidental overlap [V as a code property, UNVERIFIED as a runtime observation]: the adapter documents that "a statement issued outside the transaction while it waits would run inside it" (`PH:195-200`), because DO SQL is synchronous but pi's transaction callback awaits between statements. pi's own calls are serialized by the adapter's queue; Pim's host statements are NOT: Pim uses `ctx.storage.sql` directly (`src/pim.ts:228-237` etc., `packages/triggers/src/host.ts:152`), bypassing the queue. A host `sql.exec` issued by some other async task at a microtask boundary while `storage.commit`'s `ctx.storage.transaction` is open would therefore land inside that SQL transaction (and roll back with it). Nothing in Pim relies on or arranges this; I did not reproduce it. It is accidental, timing-dependent, and no code path in `src/` or `packages/*/src` (excluding coding) is designed around it.

Every use found (search: `rg -n "transactionSync|storage\.transaction|\.transaction\(|\.commit\(|commitWith|createConversation|init:" src packages/*/src`, coding excluded except where it touches the same store: `src/coding/*` uses its OWN DOs `CodingThreadDO`/`CodingSchedulerDO` and their own `ctx.storage`, never the space's pi store):

| Site | Kind | Can a host `pim_*` write share the SQL transaction of a pi commit? |
|---|---|---|
| `packages/triggers/src/host.ts:236-240` `init` passed to `startChat` → `src/space/conversations.ts:333` `createConversation({init})` | pi callback in commit callback phase | Runs one host `UPDATE pim_trigger_host_operations SET chat_id=…` (`host.ts:237`) and a doc write `tx.doc(TriggerChatDoc)` (`:238-239`). The UPDATE executes BEFORE pi's SQL transaction opens: separate autocommit, NOT atomic with the pi commit. If the commit then fails the `chat_id` stays set with `chat_ready=0`; `#madeChat` repairs this by checking pi's `TriggerChatDoc` and forgetting an id pi never wrote (`host.ts:380-398`) and `adoptChat` for a chat made but not tied to its agent (`:394`). DESIGNED non-atomicity with repair, not designed atomicity. |
| `src/space/abilities.ts:367-380` `init` (`tx.appendEntry(CompactionEntry, …)`) | pi callback | No host write inside (pure pi append). |
| `src/space/conversations.ts:792-810` `conversation.commit(async tx => …InboxDoc, tx.settleSubmission…)` | pi callback | No host write inside (pi docs only). |
| `src/pim.ts:1054-1056` `root.commit(tx => tx.createTask(NapTask…))` and `src/extensions/optmem/index.ts:318` `api.createTask(NapTask…)` | pi callback | No host write inside; the host write `store.setMeta("nap_task", id)` is AFTER the commit (`optmem/index.ts:310`). Not atomic (hazard 12). |
| `src/extensions/optmem/index.ts:221-293` `runtime.commit(() => …)` bodies | task checkpoints | They READ host `optmem_log` (`store.pending(1)` `:223`, read-only `store.ts:271`); `store.putSummary` (host WRITE) runs before the commit call (`:281`), not inside it. No host write inside. |
| `packages/triggers/src/store.ts:385-910`, `computer.ts:459,556,606`, `api.ts:323`, `coordinator.ts:307`, `connector.ts:102`, `subscriptions.ts:157`, `engine.ts:31` via `src/space/triggers.ts:129,199,335,408,434` | `ctx.storage.transactionSync` | Synchronous (no await), so no pi commit (async) can occur inside; they cover trigger tables only. No pi/host interleave. |
| `src/pim.ts:237` (`SkillStore`, used at `src/skills.ts:409`) | `transactionSync` | Synchronous, skills tables only. |
| `src/auth/store.ts:321,372` | `transactionSync` | Separate auth DO, not the space store. |
| `src/coding/scheduler-do.ts:84,502,512`, `src/coding/thread-do.ts:362,563,1060,1277,1300` | `transactionSync`/`transaction` | Coding DOs' own storage; out of scope; no pi store. |
| `node_modules/agents/dist/harness/pi/index.js:229` | the pi adapter's `storage.transaction(async …)` | This is the one real SQL transaction wrapping each pi commit's WRITES; Pim code is never called from inside it (callbacks are pre-commit; see above). |

Conclusion [V for the code paths enumerated above; UNVERIFIED for runtime interleaving]: there is NO designed atomicity between a host `pim_*` write and a pi commit. The only host write staged from a pi commit callback is the trigger `init` UPDATE, and it is a separate autocommit that precedes the pi SQL transaction. The previous inventory wording ("staged inside pi commit init", hazard 1, and the "Trigger-made chats" entry) overstated this.

Consequence for a PostgreSQL adapter: Pim's pi data and host tables currently sit in one DO SQLite file, so "same store" is physically true even though not used atomically. With a Postgres pi adapter, a host write made from `init` (or anywhere) goes through whatever connection/store the host uses, which will by default be a different connection from the pi commit's transaction (pi's `transaction(callback)` hands the callback a transaction handle; the `tx` passed to `init` only buffers pi writes). The host `UPDATE` in `init` would therefore still be a separate committed statement, exactly its present behavior; correctness depends on the existing repair (`#madeChat`, `adoptChat`, `chat_ready`, `TriggerChatDoc` as the source of truth), which must keep working. Making a host write atomic with a pi commit would be NEW design (PROPOSED HARDENING: a shared connection/transaction or an outbox inside the pi store), not something to preserve. Do not rely on the Cloudflare accident (concurrent host statements landing in the pi transaction): on Postgres it does not happen.

**The write pairings (all sequential, none atomic; each safe by idempotent keys plus startup repair).** There are 12 as originally counted, plus one found later (13). With a Postgres adapter nothing REQUIRES atomicity provided these repairs keep running:
1. **Chat creation ↔ host row.** `startChat` creates the pi conversation first, then `setSessionModel`, `setModel`, `agents.setSession`, `touchSession` (`src/space/conversations.ts:330-340`). A crash between leaves an orphan pi conversation with no `pim_agent_sessions` row: `agents.ofSession` then silently returns the MAJORDOMO (`src/agents.ts:592-596`). Triggers record `pim_trigger_host_operations.chat_id` from `init` (`packages/triggers/src/host.ts:236-240`): see 0.4.0, this is a pre-commit autocommit, repaired by `#madeChat` (`:380-398`).
2. **Task start.** `startTasks` (`conversations.ts:413-457`): `#taskConversation` (`:461-466`: `sessions.create`, `setModel`, `agents.setSession`, `selectAbilities`) THEN `tasks.start` inserts `pim_tasks` (unique `(batch, position)`, `tasks.ts:115`; `tasks.start` is idempotent via `at(batch, position)` `:205`) THEN `submit` with operation id `task:<id>` (`conversations.ts:449`). A crash before the insert leaves an empty hidden conversation (not listed until recorded); replay of the `delegate` tool finds the row and re-submits the same operation. `resumeTasks` repairs "recorded but not given" (`:600-612`).
3. **Task finish/delivery.** `tasks.finish` after `harness.wait` returns (`:513`; failure path `:493`); `#deliver` (`:530-557`) records `delivered` 0/1/2 via `tasks.giving(ids, "task-update:<id>@<updatedAt>,…")` (`:549-553`); `#giveUpdate` (`:576-598`) submits then `tasks.given` (`:589`). A crash between submit and `given` re-submits the same operation id (no-op in pi) via `resumeTasks` → `beingGiven` (`:613-615`).
4. **Suspended `delegate(wait:true)`.** The call is a suspended `pi.tool` task; its pi task id is stored as `pim_tasks.batch` (`src/tasks.ts:504` `String(api.taskId)`); the host wakes it via `resumeTask(requester, Number(batch) as TaskId)` once all tasks are terminal (`conversations.ts:541-542`, wrapper `:970-971`, pi `PH:403-408`).
5. **Approvals.** `fileApproval` memoizes the approval id in the tool task (`api.memo("approval", crypto.randomUUID())`, `src/extensions/approvals.ts:119`) THEN `requestApproval` inserts `pim_approvals` keyed by it with `call_id = api.callId` (`src/store.ts:572-573`); decision: host `decideApproval` row → run action (host side effect outside both stores) → `recordApprovalResult` → `resumeTask`. After a crash `resumeDecided` (`conversations.ts:1032-1049`) wakes decided-but-unwoken calls; an approved action with `result IS NULL` is recorded as "may have partly run, not run again" (`:1040-1042`).
6. **Continuation.** `#startContinuation` (`abilities.ts:362-390`): `createConversation(init: CompactionEntry)` then `agents.setSession`, `setAbilities`, `touchSession`, `continueSession`, `archiveSession`, `setSessionModel`, `setModel`: not atomic; a crash after creation leaves an orphan pi conversation with no `pim_agent_sessions` row (majordomo-owned if listed) and the old chat not archived. No repair found (searched `continued`, `orphan` in `src/space`, `src/store.ts`): UNVERIFIED whether `sessions.list()` shows the orphan (it would: the host hides only `hiddenSessions()`).
7. **Rooms.** `#seat` (`conversations.ts:835-848`): `sessions.create`, `setModel`, `agents.setSession`, `rooms.open`, `rooms.seat`, then pi `write` submissions keyed `join:<id>` / `joined:<id>:<agent>`; `joining` map (memory) serializes concurrent joins (`:826-832`).
8. **Fork.** pi `fork` then host `setSessionModel`, `setModel`, `agents.setSession`, `touchSession` (`conversations.ts:331-340`), then the route writes `pim_meta fork:<id>` (`src/space/routes.ts:316-330`).
9. **send_to_user.** Host effects (`keepImages`, `sendEmail`, `responseSent`, `posted()` fan-out) run INSIDE the tool body before the tool result commit, protected by `api.memo` keys `images`, `email`, `responseAt` (`src/extensions/messaging.ts:276-291`) and `replay:"safe"`.
10. **Delete chat.** Host `deleteSession` + cancels + abort; pi never deletes conversations (`src/store.ts:839` comment). Deleted conversations persist in pi.
11. **Usage reservation.** `usage.reserveRun()` before `harness.submit` (`conversations.ts:136`), `releaseRun` on rejection/non-accepted (`:156,181,207`; `src/usage.ts:346,357`). A reservation held by a crash: UNVERIFIED (searched only `src/usage.ts`).
12. **Memory nap.** `createTask` commit on ROOT then `store.setMeta("nap_task", id)` (`optmem/index.ts:302-311`; call sites `pim.ts:1048-1058`, `optmem/index.ts:313-318`); a crash between creates a second nap later (benign).
13. **(Not in the original 12.) Majordomo review chat.** `#review` (`src/space/approvals.ts:528-545`): `sessions.create`, `setModel`, `configure({extensions,tools})`, then `tasks.start({kind:"review", batch:"review:<approvalId>"})`; replay finds the row with `tasks.at(call, 0)`.

---

## 1. Entries

### Normal chats (sessions) — create, send, queue, stop, retry, reset
- Sources: `src/space/routes.ts:262-310` (list/create), `:546-740` (messages, queue steer/edit/cancel, retry, abort, reset), `src/space/conversations.ts:122-209` (`submitTo`), `:790-833` (`changeQueued`), `:950-981` (`stop`), `src/space/views.ts:141-157`, `src/pim.ts:1205`.
- Canonical storage: pi conversation (entries, `pi.inbox`, `pi.live`, `pi.agent`, `pi.provider`, `pi.usage`, `pi.generation`/`pi.tool` tasks) for content; host `pim_sessions` (title/times/archived/continued/model/summary), `pim_session_ids` (public id), `pim_agent_sessions` (agent), `pim_session_abilities` (selection key). Conversation id minted by pi (`sessions.create`); public id = `crypto.randomUUID()` minted in `store.publicId` (`store.ts:737`).
- Behavior & invariants: every input goes through `submitTo(from: user|pim|approval|task|room|review)`. Run-limit reservation, suspended check (403), `touchSession`, auto-title from first user message (`titleFrom`) and utility-model naming, ability reselect (`selectAbilities`), image copy to R2 (`images.keep`) then `harness.submit` with caller `operationId`. A repeated operationId is `accepted:false` and gets no second run and no second image upload (`conversations.ts:195-209`). Busy chat: `whenBusy` followUp/steer queue lives in `pi.inbox`. Set meta `awaiting:<s>=1` when a user message is accepted (consumed by `pushReply`, `pim.ts:1429-1446`); remove `archive-when-idle:<s>`. User messages in rooms fan out (see Rooms).
- Computer required? / Admin infra required?: Chat core no. File-change preface (`#fileChanges`, `conversations.ts:290-300`) uses the paired computer only when `pim_file_seen` has rows. Models/providers need admin or personal credentials (`src/space/models.ts`), image copies need R2 (`BLOBS`; `src/images.ts`). Web push needs VAPID (generated, stored in meta `vapid_keys`, `pim.ts:1411`).
- Authorization: gateway `authorize` (`src/gateway.ts:129-130`): bearer API token or signed-in cookie → owner id → routes to that owner's `Pim` DO. Guests only chat with their bot (`notForGuests`). Status `suspended` → 403 on submit; `deleted`→410. Session id in a URL must map via `pim_session_ids` and not be hidden/deleted, else 404 (`views.ts:141-157`), except ROOT which is always reachable.
- Migration/export-import: export pi conversation (all entries, docs, tasks) + all host rows in 0.3. In-flight: queued inbox items (`pi.inbox`), running generation/tool tasks (`pi.generation`, `pi.tool`) must be exported with their checkpoints and `memo`s, or the run must be quiesced first (Stop re-queues non-user events as `requeued:<s>:<id>`, `conversations.ts:950-981`). Pending submissions are matched by `operationId` (`submissionByRequest`, `conversations.ts:775`): operation ids MUST be preserved so retried submits remain no-ops. `usage.reserveRun()` reserves against `pim_usage_runs(day,runs)` (`src/usage.ts:346,357`); whether a reservation held across a crash is ever released: UNVERIFIED (not read beyond the call sites `conversations.ts:136,156,181,207`).
- Public ID/URL compatibility: `/api/sessions/<publicUuid>/…`, app route `/chat/<publicUuid>` (also in email links `pim.ts:1114`). Public UUIDs must be preserved; raw pi ids never leave the space except via MCP/API fields that use `publicId`. ROOT's public id is created lazily.
- Explicit settings/overrides to preserve: per-chat model (`pim_sessions.model` JSON, pi `setModel`), per-chat `pim_session_abilities` key, `title`, `archived_at`, `read_at/response_at`, queue modes.
- Dependencies: reads agents, settings (limits, approval policy), usage, images, visits (`bySession`), tasks (`tasks.of`), rooms; fires telemetry spans; writes root-level nothing. Cross-conversation: rooms fan-out and task deliveries write into OTHER conversations.
- Acceptance test: create chat, send message with image, stop mid-run, restart Runner mid-run and assert exactly one assistant reply, same operation id resubmitted returns `accepted:false`, same public id and same transcript order after export/import.
- Uncertainty: exact `harness.submit` receipt shape on Postgres; `retry` route semantics (`routes.ts:685`) UNVERIFIED in detail.

### Session/conversation IDs and the pi mapping
- Sources: `src/store.ts:222-225,737-747`, `src/space/views.ts:141-157`, `src/pim.ts:327` (`idOf`), `PH:246-247, 676-715`.
- Canonical storage: `pim_session_ids(id TEXT PK uuid, session TEXT UNIQUE)`; mapping is created lazily by `publicId()` on first display; pi conversation id is a decimal string.
- Behavior & invariants: public id is stable forever; `sessionOf` is the only reverse lookup; deleted conversations keep the mapping. "session", "chat", "conversation" are the same pi conversation id everywhere internally; tasks' conversations are ALSO sessions (hidden via `pim_tasks.chat=0`), room seats' conversations too (hidden via `rooms.conversations()`), reviews too.
- Computer/admin: no / no.
- Authorization: lookup only inside the owner's space.
- Migration/export-import: export the table verbatim; do not regenerate. Rows are optional for never-displayed conversations (lazily recreated: new UUID — acceptable but changes URL).
- Public ID/URL compatibility: public UUID appears in `/chat/<id>`, API, websockets (`progress`, `tasks`, `approval` messages), notification ids `reply-<publicId>-<at>`, `mention-<publicId>-<agent>-<at>` (`conversations.ts:734` (mention) and `pim.ts:1446` (reply)). Preserve.
- Explicit settings/overrides to preserve: none beyond the mapping.
- Dependencies: every feature; `harness.sessions.list()` supplies the set of conversations (pi list), filtered by host hidden sets.
- Acceptance test: after import, GET `/api/sessions/<oldUuid>/messages` returns identical messages for 10 sampled chats including a room seat and a task chat.
- Uncertainty: `sessions.list()` implementation under Postgres must return `busy`, `parent` (used by `deleteImages`, `views.ts:127-128`).

### Session info, title, archive, read state, delete
- Sources: `src/store.ts:213-221,748-886`, `src/space/conversations.ts:211-240` (archive cascade), `src/space/routes.ts:349-365,431-460,500-535`, `src/space/views.ts:101-107`, `src/space/shared.ts:8`.
- Canonical storage: `pim_sessions` (id, title, created_at, updated_at, deleted_at, summary, summary_of, plus columns added by migration: archived_at, read_at, response_at, model, continued_from, continued_to — added in code at `store.ts` migrations, UNVERIFIED line), `pim_meta archive-when-idle:<s>`.
- Behavior & invariants: title set once by user/utility model (`touchSession` COALESCE; `retitleSession` only if still equal to old name); archive cascades to the chats of tasks the chat handed out (`#setArchived`, `conversations.ts:223-240`); archiving a busy task chat defers via `archive-when-idle` (`pim.ts:513-519`); any activity unarchives AND undeletes: `touchSession` upserts `deleted_at = NULL, archived_at = NULL` (`src/store.ts:783`; the earlier statement that `touchSession` does not clear `archived_at` was WRONG); the list route also derives `archived` for a chat idle for `ARCHIVE_AFTER_MS` = 14 days that is not busy and has nothing unread (`src/space/routes.ts:63,266,289`). Delete = soft delete (`deleted_at`), cancel own task, cancel tasks handed out, deny pending approvals, abort run, delete images + `pim_file_seen` + suggestions/fork meta + chat link + schedule triggers targeting it + connector watches (`routes.ts:500-535`), and ui-state sweep (`views.ts:184-199`). Deleted ROOT is relisted on next activity (`touchSession` upsert clears `deleted_at`, `store.ts:777-790`).
- Computer/admin: no / no.
- Authorization: owner only.
- Migration/export-import: all rows incl. soft-deleted ones (the deleted set is what hides pi conversations, `store.deletedSessions()`); dropping them would resurrect deleted chats in `harness.sessions.list()`.
- Public ID/URL: see IDs above.
- Explicit settings: archived_at, read_at, title, summary cache (can drop), per-chat model.
- Dependencies: tasks, rooms, chat links, images, triggers, connector watches (cross-conversation cascade).
- Acceptance test: archive a parent chat; assert its task chats archived; unarchive restores; delete a chat with a pending approval and a scheduled trigger; assert approval denied, trigger removed, chat 404.
- Uncertainty: pi has no delete: a Postgres adapter could physically delete but Pim must not assume it.

### Forks
- Sources: `src/space/routes.ts:316-334`, `src/space/conversations.ts:322-341` (`startChat(from)`), `src/space/views.ts:110-127` (`forkTitle`), `src/space/shared.ts:131`, `src/space/conversations.ts:167-179`, `PH:686-695`; `forkPoint` (src/space, UNVERIFIED file).
- Canonical storage: pi `conversation.fork(entryId,{ownership:ownerless})` copies history up to the entry; docs honor `fork` semantics (`pi.agent` asOf; live/inbox/provider/usage/trigger_chat reset to initial, `PD harness/*.js`). Host: new `pim_sessions` row (model copied), `pim_agent_sessions`, meta `fork:<id>=<title>` until the first user message.
- Behavior & invariants: only agent messages (`at`) or user messages (`before`); refused for visits and group chats; title "X (fork #n)"; first user message in a fork triggers `nameSession` from the pre-fork transcript (`conversations.ts:167-179`) and deletes the meta key. Image deletion walks `info.parent` chain so forks keep parents' images (`views.ts:127-140`: `deleteImages` walks `parent` from `sessions.list()`).
- Computer/admin: no / no.
- Authorization: owner; chat must not be a visit or room.
- Migration/export-import: fork ancestry (`parent` id and fork entry) must be preserved by the pi export; host fork meta rows exported as is.
- Public ID/URL: new chat gets a new public id.
- Explicit settings: per-chat model copied (`setSessionModel`), agent copied.
- Dependencies: reads parent transcript; image refcount across parent/fork (`images.deleteSession`).
- Acceptance test: fork at message N, assert fork history equals parent's through N, parent's later messages absent, delete parent keeps fork's images.
- Uncertainty: whether Postgres adapter keeps `parent`/ancestry for `sessions.list()`.

### Compaction and reset
- Sources: `src/space/abilities.ts:279-296` (`beforeCompact` hook on `CompactionTask`), `src/space/routes.ts:740-747` (`session.reset(handoff)`), `src/pim.ts` settings `harnessSettings()` (compaction policy; UNVERIFIED line), `PD harness/agent.js:5-14` (defaults reserveTokens etc.).
- Canonical storage: pi `pi.compaction` task/entry and `pi.reset` entry in the conversation.
- Behavior & invariants: for plain chats (not hidden/visit/room) Pim DECLINES threshold compaction and carries the chat on (see Continuations), but lets `overflow` compaction run in place; `manual` always allowed. Rooms, task chats and visits keep normal compaction.
- Computer/admin: no / model provider needed.
- Authorization: owner.
- Migration/export-import: a compaction task in flight is a `pi.compaction` task with its checkpoint — export as pi records. Compaction entries are just entries.
- Public ID/URL: n/a.
- Explicit settings: compaction policy defaults (`enabled`, `reserveTokens:16384`, `keepRecentTokens:20000`, `backgroundTokens:32768`).
- Dependencies: provider/model of the chat.
- Acceptance test: overflow a small-context model chat; assert in-place compaction entry and continuation not created; threshold on a normal chat creates continuation.
- Uncertainty: effective `harnessSettings()` values UNVERIFIED.

### Continuations (long chat carried on in a new chat)
- Sources: `src/space/continuation.ts:1-87`, `src/space/abilities.ts:262-394`, `src/space/conversations.ts:565-575` (`carriedOn`), `src/tasks.ts:382-385` (`carryOn`), `src/store.ts:792-834` (`continueSession`/`continuation`/`isContinued`/`resumeContinuedSession`).
- Canonical storage: new pi conversation whose first entry is a `CompactionEntry{head:"self",data:{reason:"threshold"}}` carrying the summary message; host `pim_sessions.continued_from` (new) / `continued_to` (old); old chat archived; `pim_agent_sessions`, `pim_session_abilities`, model copied.
- Behavior & invariants: starts at `beforeCompact` for non-manual reason; waits until the chat is at rest (nothing busy, `pi.inbox` empty, no suspended `delegate` waits, `tasks.isWaiting`); summarizes with the chat's model (3× context window chars, 300 s timeout), retries up to 5 times if the chat changed (tail entry id compare), then creates the continuation. In-memory `#continuing` set serializes. `carriedOn(session)` redirects all later task answers/follow-ups/schedules to the new chat, and `tasks.carryOn` rewrites `pim_tasks.requester` and `.conversation` ONLY once the old chat is at rest (no working/auth-required tasks, not busy). The person writing in the old chat un-forwards it (`resumeContinuedSession`).
- Computer/admin: no / model needed.
- Authorization: automatic; no user check.
- Migration/export-import: export both chats and the `continued_*` pointers. An in-progress `#continueChat` is in memory only (the loop restarts at the next compaction trigger); nothing to export. If a continuation was created but host rows incomplete: see hazard 6.
- Public ID/URL: continuation gets its own public id; `continuedFrom(session)` returns the old public id (`abilities.ts:264-267`); `startedBy` follows `continued_to` to find the task (`:252-260`).
- Explicit settings: title copied, model copied, ability key copied.
- Dependencies: tasks table rewrite (cross-conversation), schedules/triggers that target the old chat id are resolved through `carriedOn` at delivery time (UNVERIFIED for triggers).
- Acceptance test: drive a chat past threshold with a pending delegate task; assert no continuation until task answered; after, new chat has summary entry, old chat archived and forwards, task rows point at new chat.
- Uncertainty: no orphan repair (hazard 6).

### Group chats / rooms
- Sources: `src/rooms.ts:1-366` (store + extension `pim.rooms`, tools `remove`, `chat_history`), `src/space/conversations.ts:620-901`, `src/space/routes.ts:379-430,762`, `src/pim.ts:513-519`.
- Canonical storage: `pim_rooms(session PK, mode mentions|open, created_at)`, `pim_room_seats(conversation PK, room, agent, depth, joined_at, UNIQUE(room,agent))`, `pim_room_past_seats`; each seat is a separate pi conversation (the host's own chat is its own seat, `seat.conversation === seat.room`); entries of kind `pim.room` for unwoken writes; `pim_agent_sessions` per seat.
- Behavior & invariants: any chat with the person's own agents is "roomable" and becomes a room when an agent is mentioned (`@name`) or invited. User message → host conversation (woken if mentioned/open/no mention) and every other seat via `submit(from:"room")` with operationId `<op>:<agent>` or `write` (no wake). Agent `send_to_user` → `posted()` fans to other seats with operationId `post:<conv>:<at>:<agent>`, depth+1 (`MAX_ROOM_DEPTH=Infinity`). Seats are hidden from the list; deleting a seat's conversation = `leave`. Room cannot be forked.
- Computer/admin: no / no.
- Authorization: owner; guests/visits excluded (`roomable`).
- Migration/export-import: export all three tables + each seat conversation. In-memory `joining` map and room-depth are not exported (depth is in `pim_room_seats.depth`). Pending fan-out is idempotent by operation id, so a replay after import is safe provided operation ids (stored in pi submissions) are preserved.
- Public ID/URL: room addressed by the host chat's public id; members listed in the chat list response; `/sessions/:s/room/members/:agent` API.
- Explicit settings: `mode`, per-seat model (`/room/members/:agent/model`), seat order by `joined_at`.
- Dependencies: CROSS-CONVERSATION by design: each message writes into several conversations; also notification mention ids; agents store; tasks (`root` is the room chat for agents' delegations, `conversations.ts:419-420`).
- Acceptance test: 3-agent room, open mode, one user message; assert each seat has exactly one submission, no duplicate after replaying the same operation ids; kill the Runner between seats and assert convergence.
- Uncertainty: fan-out is not atomic across seats; partial delivery after crash is only healed by a retried `posted()` (no persisted outbox) — UNVERIFIED whether the model's tool retry covers it.

### Delegation / tasks (agent handing work to another agent)
- Sources: `src/tasks.ts:1-591` (store, `delegate`, `archive_task_chats`, `started_by`/`delegates` sections), `src/space/conversations.ts:240-620, 895-948`, `src/space/views.ts:90-97`, `src/space/routes.ts:662-684`, `src/space/reports.ts:213`, `src/pim.ts:2485-2494,2627`.
- Canonical storage: host `pim_tasks` (`tasks.ts:92-117`; id = 10 hex chars from `newId()` `tasks.ts:151`; kind `agent|review`; states working|auth-required|completed|failed|canceled; `batch` = pi task id of the calling `delegate` tool task; `call` = pi callId; `operation` = latest input's operation id `task:<id>`/`task-update:…`; `delivered` 0/1/2). Task work itself is a normal chat (`chat=1`, a new pi conversation made by `#taskConversation`, `conversations.ts:461-466`) with agent in `pim_agent_sessions`. The `delegate` call is a pi `pi.tool` task (`replay:"safe"`); with `wait:true` it returns `{control:{suspend:true}}` and is suspended in pi until the host wakes it.
- Behavior & invariants: ≤8 tasks per call, depth ≤3 (`MAX_TASK_DEPTH`), no cycles (chain of agent ids); `continues` reuses the earlier task's chat (follow-up; if that chat was carried on, the new one). Task completes when its latest operation settles and it waits for no handed tasks (`#taskSettled`); answers batched per `batch`, delivered as `[Task update]` message (operation `task-update:ids@updatedAt`) to the requester (or `carriedOn(requester)`), `delivered` tracks given-once. Waiting-on-approval task state is `auth-required` and is delivered separately. Cancel cascades to children and denies pending approvals, aborts the run. Wake of a finished task by schedule/event reopens it (`WAKE` prefix operation) and its answer goes to requester again; empty answer after wake is dropped.
- Computer/admin: no / no.
- Authorization: agent-to-agent through `delegates(session)`: majordomo → all other non-majordomo agents; other agent → its `contacts`; none for visits or reviews; API `/sessions/:s/tasks[/:task[/cancel]]` owner only, task must belong to that root chat (`views.ts:95-96`).
- Migration/export-import: export `pim_tasks` + task chats. RESUMABLE STATE: (a) `working` tasks: `resumeTasks()` re-waits on `harness.wait(task.operation)`; it needs the same operation ids to exist in pi submissions. (b) tasks `recorded but not given`: re-submitted by `resumeTasks` (idempotent). (c) updates `delivered=1` ("being given"): re-`#giveUpdate`. (d) suspended `delegate(wait:true)` `pi.tool` tasks: `batch` must still equal the pi task id after import — **if the pi-durable import renumbers task ids, `pim_tasks.batch` (for rows with `waits=1` or any batch from a `delegate` call) and `optmem_meta.nap_task` (not `pim_meta`) must be rewritten; `pim_tasks.parent` is Pim's own 10-hex task id (`conversations.ts:432`) and needs no rewrite** (`conversations.ts:542`: `Number(batch) as TaskId`; the `waiting()` re-delivery at `:617`). `harness.resumeTask(requester, Number(batch))` is the wake.
- Public ID/URL: task ids (10 hex) used by agents and the API; chat link `session` = public id of the task's conversation when `chat=1`.
- Explicit settings: `parent`, `root`, `waits`, `chat`, `position` (`member` is legacy, see Uncertainty).
- Dependencies: CROSS-CONVERSATION: requester ↔ task conversations ↔ root; `hiddenSessions` for old non-chat tasks; approvals (`taskWaits`), schedules (wake), run watchdog (waiting-on-tasks counts as legit wait), archive cascade, delete cascade.
- Acceptance test: delegate 3 tasks (one waiting for approval, one with wait:true), restart Runner at three points (before give, mid-run, after finish before delivery); assert each task answered exactly once and the waiting call returns the answers; cancel parent cancels children.
- Uncertainty: `pim_tasks.member` is written only by the one-time migration from the old `pim_team_runs` table (`src/tasks.ts:163-178`); `TaskStore.start` does not set it (`tasks.ts:210`) and `taskOf` does not map it (searched `member` in `src/tasks.ts`: lines 106,163,169,178 only), so it is a legacy column; legacy tasks with `chat=0` ("from before tasks were chats") need preserving.

### Majordomo approval reviews (task kind `review`)
- Sources: `src/space/approvals.ts:84-132,515-620`, `src/majordomo.ts:22-100`, `src/tasks.ts:50,153`, `src/space/conversations.ts:377`.
- Canonical storage: `pim_tasks` row with `kind="review"`, `batch="review:<approvalId>"`, `requester=null`, `root=<chat>`, a pi conversation configured with only `pim.review`, memory and telemetry extensions and tools `decide_approval`, `recall`, `zoom` (`configure({extensions,tools})`, `approvals.ts:535-540`); `pim_approvals.review` JSON {status reviewing|escalated, note}; scheduled `expireReview {id}` after `REVIEW_MS`.
- Behavior & invariants: only under policy `majordomo`, not for the majordomo's own chat requests, not for explicit-approval actions, not for guests; unanswered/failed/timed out → `escalated` to the person with a notification.
- Computer/admin: no / no.
- Authorization: automatic; decision recorded as `decided_by="majordomo"`.
- Migration/export-import: review conversations are hidden pi conversations; if a review is mid-run at export, either let it finish or mark approval `escalated` (what `expireReview` would do). `review:<id>` operation id must be preserved.
- Public ID/URL: none (reviews are not listed).
- Explicit settings: `approvalPolicy` setting.
- Dependencies: reads approval row, person memory (`recall`), agents; writes decision into approvals and wakes the parked tool call in ANOTHER conversation.
- Acceptance test: file an approval under `majordomo` policy, kill Runner during review, assert it escalates within `REVIEW_MS` or completes once.
- Uncertainty: `REVIEW_MS` = 5 minutes (`src/space/approvals.ts:31`).

### Approvals and gated actions (parked tool calls)
- Sources: `src/extensions/approvals.ts:1-210` (`GatedAction`, `fileApproval`, `gatedTool`), `src/space/approvals.ts:84-260,479-512`, `src/store.ts:169-188,556-626`, `src/space/routes.ts:1656-1710`, `src/space/conversations.ts:903-913,1032-1049`, `src/pim.ts:1628-1640`, `src/extensions/mcp.ts:205-232` (`mcp_call`).
- Canonical storage: host `pim_approvals` (id = UUID memoized in the pi tool task; session; call_id; action; args JSON; summary; status pending|approved|denied; decided_by user|timeout|always|majordomo; expires_at; on_timeout approve|deny; requested_by/member/review JSON) and the PARKED pi `pi.tool` task (suspended, `input.callId`). Scheduled `expireApproval {id}`.
- Behavior & invariants: tool call → `api.memo("approval", uuid)` → insert/read row → `approvalFiled`: if permission `on` decide immediately (`always`); else broadcast, notify, schedule expiry, return `{control:{suspend:true}}`. Decision runs the gated action in the host (`action.run`) under `keepAliveWhile`, records result, then `resumeTask(session, callTaskId)` — the woken call re-executes, finds the decided row and returns `[Approval id] … Result: …` (`#outcome`). `waitingCall` finds the parked task via `pi.inspect()`; if none (chat stopped/deleted/reset) the decision is forced to deny with a note. Policies: `majordomo` (default, other agents reviewed), `auto` (30 s timeout approves), `explicit`. Explicit-approval actions (destructive connector tools, `add_custom_connector`, guest bot calls) ignore always/auto. Decided `inTurn` for `on` permissions: the call returns at once without suspending. Re-filing after wake is guarded by `known = store.approval(id)` (isNew false).
- Computer/admin: Some actions need the computer (`run`) or admin; the approval machinery itself no. `add_custom_connector` approval requires `SIGNED_IN_HEADER` (browser session, not API token) (`routes.ts:1688-1690`).
- Authorization: owner via API (`/approvals/:id/approve|deny`); guest approvals (`requested_by`) decided by the OWNER; guest sides are served by another space's DO (`guest.visitAnswer`, `botToolDecided`, `approvals.ts:219-220`).
- Migration/export-import: PARKED APPROVALS are the key resumable state: export `pim_approvals` (pending ones included) together with the suspended `pi.tool` tasks and their memo (`approval` id, `prepared` {args,summary}). After import: re-arm `expireApproval` for pending rows with `expires_at`, re-arm `expireReview` for `review.status=="reviewing"`, then run `resumeDecided()` semantics (decided but unwoken → wake; approved with `result IS NULL` → record "may have partly run"). `call_id` must equal the pi callId inside the exported task input; `pim_approvals.session` must equal conversation ids. Approvals whose call task no longer exists are decided deny on next decision attempt.
- Public ID/URL: approval UUID is public (API + websockets + notification link).
- Explicit settings: policy, per-tool permission (next entry), `onTimeout`.
- Dependencies: pi task inspection; task state `auth-required` (task chat awaiting approval); notifications/push; majordomo review conversation; guests' spaces (cross-space calls to `pimOf(ownerId)`).
- Acceptance test: file `http_request` approval; restart both Live and Runner; approve; assert exactly one HTTP call, one result, call returns; same for deny, timeout (auto policy), stopped-chat and approved-then-crash (result "may have partly run").
- Uncertainty: guest/visit approvals span two spaces and are not exportable by a single-space export (cross-space consistency).

### Tool permissions ("Always approve", Off/Ask/On)
- Sources: `src/store.ts:189-201,627-681` (`pim_tool_permissions`, `pim_always_approved` legacy), `src/extensions/approvals.ts:11-61` (`resolvePermission`, `ownToolPermission`), `src/space/approvals.ts:256-300,312-345,360-512` (`alwaysApprove`, `approvalPermission`, `migrateAlwaysApproved`), `src/extensions/mcp.ts:111-175` (`needsApproval`, `toolDefinition`, `agentToolPermission`), `src/space/routes.ts` tool-permission routes (UNVERIFIED line).
- Canonical storage: `pim_tool_permissions(audience,app,tool,permission off|ask|on,definition,updated_at)`; audience `""`=owner or a circle id; `app` = connector id or `""` for Pim's own; per-agent connector tool switches stored in the same table under an agent audience (UNVERIFIED; see `agentToolPermission` `mcp.ts:163`); `pim_always_approved` is legacy, folded into permissions by `migrateAlwaysApproved` (runs in harness open, `pim.ts:493,560`); `pim_mcp_servers(id, approval writes|all|none)`.
- Behavior & invariants: a permission is tied to the tool's `definition` hash at choice time: if the connector changes the tool, owner permission `on`→`ask`, circle non-`off`→`off` until re-chosen. Pim's own gated tools default `ask`; `UNASKED_TOOLS` are On/Off only; explicit actions Off/Ask only. "Always approve" = `setToolPermission(on)` + approve other pending calls of the same tool (`approvals.ts:256-275`). A tool switched `off` is excluded from the conversation's tool set via `configure({tools:{remove}})` in `selectAbilities`.
- Computer/admin: no / no.
- Authorization: owner sets own; admin-only for deployment-level (`OWNER_ADMIN_KEY`).
- Migration/export-import: export table verbatim INCLUDING `definition` strings (a changed definition format would demote every permission to Ask). Renamed tools handled by `RENAMED_TOOLS` migration (`store.ts:144,478`).
- Public ID/URL: none.
- Explicit settings: every row; also `settings.approvalPolicy`.
- Dependencies: connector tool catalog (`apps.tools()`), agents (`switchedOff`), circles for guest audience.
- Acceptance test: set `http_request` On, `mcp_call` tool Ask, change connector tool definition, assert it asks again; export/import preserves choices.
- Uncertainty: exact audience encoding of per-agent switches.

### Agents (configuration) and agent ↔ conversation binding
- Sources: `src/agents.ts:1-620`, `src/extensions/agents.ts:1-480` (`create_agent`, `update_agent`, `manage_connectors`, `current_time`, sections `agent`, `your_agents`, `user_time_zone`, `memory`), `src/gallery.ts:223-260` (templates, `default_agent`), `src/space/routes.ts:1816-2030`, `src/majordomo.ts`.
- Canonical storage: host `pim_agents(id "p_"+12hex, name, role, description, instructions, apps JSON, source, published, is_default, symbol, color, introduced, skills, contacts, memory_scope(s), model, fallbacks, copy_of, created/updated)`, `pim_agent_icons`, `pim_agent_sessions(session→agent)`, `pim_session_abilities`, `pim_meta`/skills switches; templates/gallery in the Gallery DO (shared, deployment-wide). NOT in pi: instructions are not stored in the conversation anymore (migration meta `pim_section` nulled them, `pim.ts:596-605`); the prompt `agent` section is computed from the host row at every request.
- Behavior & invariants: majordomo = `is_default=1`; `ofSession` of an unmapped session = majordomo; a chat's agent binding is permanent (`setSession` only at creation; `startChat`, `#seat`, `#taskConversation`, `#startContinuation`). Max sizes: name 60, description 280, instructions 8000, 10 connectors, 20 skills, 20 memory scopes. Agent can edit itself (name, role, instructions, contacts, icon) and request connector changes through an approval; the majordomo edits any (`update_agent` memoizes `UPDATE_AGENT`). Deleting an agent: chats stay bound by id (UNVERIFIED cleanup; `agentExists` used by triggers).
- Computer/admin: no / no (icons stored in DO SQLite; or from files on the computer when set by file path: UNVERIFIED).
- Authorization: owner; guest chats only with their bot (`GuestBot` meta `guest_bot`); agent-initiated edits limited to self unless majordomo.
- Migration/export-import: export `pim_agents`, icons (BLOB), `pim_agent_sessions`, `pim_session_abilities`. Because `pim_session_abilities.abilities` is a string key of extension ids and `-<tool>` removals, the pi `pi.agent` doc already holds the real selection; the key is only a change-detector: dropping it forces a harmless reconfigure on next submit.
- Public ID/URL: agent id `p_xxxxxxxxxxxx` (stored in notifications, API, templates `copy_of`); gallery template ids are deployment-wide.
- Explicit settings: per-agent model + fallbacks, contacts, memory scopes, skills switch, connectors (`apps`), emoji/color/icon, `introduced`.
- Dependencies: gallery (templates/default agent), memory scopes (optmem), skills store, connectors (directory refs), tasks (contacts), settings (model catalog).
- Acceptance test: agents with contacts, custom model and fallbacks; after migration `GET /agents` identical, each existing chat still talks as its agent (check system prompt `agent` section contains the agent's instructions).
- Uncertainty: agent deletion semantics.

### Per-conversation configuration (abilities/tools/model/instructions in `pi.agent`)
- Sources: `src/space/abilities.ts:120-160` (`selectAbilities`), `src/space/models.ts` (`sessionModel`, `agentModel`, fallbacks), `src/space/conversations.ts:98-107,358-370` (`switchedOff`), `src/pim.ts:491-608`.
- Canonical storage: pi `pi.agent` doc per conversation (extension selection, tool removals, model via `setModel`, `instructions` now null); host mirror `pim_session_abilities`, `pim_sessions.model`.
- Behavior & invariants: before each user submit the selection is recomputed (abilities offered to the agent, connector extensions `pim.app.<id>` LAST so pi appends cheaply, grants, triggers extension only if the engine is on) and written only if the key changed. Task chats that are not chats and visits choose their own. Prompt-cache invariant: extension install ORDER matters ("Before memory… a section after it would make pi send every section again", `pim.ts:577`).
- Computer/admin: no / no.
- Authorization: system.
- Migration/export-import: `pi.agent` docs move with the conversation. Extension ids referenced there MUST exist in the new Runner's registry or the conversation fails to resolve tools (UNVERIFIED failure mode): Runner must install the same extension set (`pim.config.ts`).
- Public ID/URL: none.
- Explicit settings: per-conversation model, tool removals.
- Dependencies: registry snapshot, MCP connection state, `visits`.
- Acceptance test: after import, send a message in a chat with a connector; assert tool list equals pre-migration list and no spurious `configure`.
- Uncertainty: how PiHarness reports a missing extension.

### Extensions, abilities and tool discovery (`pim.config.ts`)
- Sources: `pim.config.ts:1-45`, `src/extensions/define.ts:1-476`, `docs/extensions.md`, `src/extensions/services.ts`, `src/extensions/app-directory.ts`, `src/extensions/popular-apps.ts`, `spotify.ts`, `gmail.ts`, `google-drive.ts`, `google.ts`, `src/space/abilities.ts`, `src/pim.ts:2282-2340` (conditional installs), `src/extensions/data.ts:4` (`pim_extension_data`), `src/extensions/schedule.ts:31`.
- Canonical storage: code (deployment config), plus per-extension host data in `pim_extension_data` (key-value by extension id), `pim_app_connections` (native connectors), widgets kept in `pim_tool_widgets`, and ability-specific tables (`schedule.ts:31` label table, optmem tables).
- Behavior & invariants: extension `id` is permanent (stored in agents/chats); `checkToolNames` rejects collisions with Pim's own and others' tool names (`pim.ts:567-583`); abilities come with gated actions turned into tools via `gatedTools`; abilities installed in harness open; some extensions install empty when no computer is paired (`files`, `canvas`, `hosted`, `desktop`, `browser`: `files.ts:128`, `canvas.ts:39`, `hosted.ts:94`).
- Computer/admin: Extension-dependent: files/canvas/hosted/desktop/browser/shell need a paired computer (or Browser Run for `browser`); `coding`, `hostOps` (admin-only majordomo, needs host daemon), `metaAdmin`/`metaDiagnostics`/`metaUi` (admin's majordomo only). Others no.
- Authorization: per-extension `offeredTo(agent)`; admin-only extensions check the caller when run.
- Migration/export-import: code, not data; export `pim_extension_data` and per-extension tables; the target deployment must ship the same `pim.config.ts` and env secrets or abilities silently disappear.
- Public ID/URL: extension ids and tool names are public to models and to stored transcripts (tool-call names in history).
- Explicit settings: `defaultTheme`, extension-level toggles via settings.
- Dependencies: all; shared extension state `pim_extension_data` is cross-conversation.
- Acceptance test: tool list (names+schemas) of the same agent before/after export is byte-equal; each extension's widget loads.
- Uncertainty: not every extension's storage enumerated (googles, hostops).

### Native apps (built-in) and hosted apps
- Sources: `src/builtin-apps.ts:1-18`, `src/extensions/native-apps.ts:1-650`, `src/extensions/notes.ts`, `src/notes.ts:52-70` (`pim_notes`, `pim_note_updates` Yjs), `src/space/connectors.ts:282-300`, `src/app-manifest.ts` (70 lines), `src/hosted.ts:69-130`, `src/extensions/hosted.ts`, `docs/apps.md` (UNVERIFIED read).
- Canonical storage: built-in app list is code (`BUILTIN_APPS` = Notes only); disabled set in gallery (`disabled_builtin_apps`, cached in meta `disabled_builtin_apps`); Notes: `pim_notes` + Yjs updates `pim_note_updates` in the space DB; hosted apps `pim_hosted_apps` (+ `pim.app.json` manifest in the app's files `backend{command,install}`, `access owner|circles|public`); apps' files in the apps R2 bucket (`ARTIFACTS`) and legacy `pim_stored_files`.
- Behavior & invariants: the manifest refuses fields that do nothing; backend runs on the person's computer (`hosted`) and listens on `$PORT` 127.0.0.1; `circles`/`public` access needs `PIM_APPS_ORIGIN`.
- Computer/admin: Notes: no / no. Hosted apps: YES computer; apps origin needs admin DNS/route.
- Authorization: manifest `access`; owner by default.
- Migration/export-import: export notes (Yjs state), `pim_hosted_apps` rows, R2 objects; hosted app processes are NOT migratable (re-start on computer).
- Public ID/URL: app addresses `https://<label>.apps.<origin>` and content-origin share links: must be preserved or labels re-mapped.
- Explicit settings: per-app `access`, disabled built-ins.
- Dependencies: files on computer, R2, circles, extension data.
- Acceptance test: edit a note collaboratively before export; after import, same text and CRDT history; hosted app `access:"circles"` still reachable.
- Uncertainty: app artifacts (`pim_artifacts*`) belong to another fragment.

### Connectors: MCP client, directory and native connectors
- Sources: `src/space/connectors.ts:77-381`, `src/extensions/mcp.ts:1-406`, `src/extensions/app-directory.ts:1-161`, `src/extensions/app-catalog.ts:1-189`, `src/extensions/app-events.ts`, `src/extensions/app-skills.ts`, `src/extensions/native-apps.ts:25-508`, `src/store.ts:202-212`, `src/space/routes.ts:2109-2235`, `src/gateway.ts:213-225`.
- Canonical storage: MCP connections live in the agents SDK (`cf_agents_mcp_servers(id,name,server_url,callback_url,client_id,auth_url,server_options)`, `node_modules/agents/dist/client-1tEQ1Oqz.js:1016-1024`, plus OAuth client info/tokens/verifier in the DO's KV storage under keys owned by the SDK: UNVERIFIED key names) and are mirrored in memory (`McpBridge`); Pim host: `pim_mcp_servers(id, approval)`, `pim_app_catalog(server_id, kind, data, expires_at)` (cache of skills/events), `pim_tool_permissions`, native connectors in `pim_app_connections(id, app UNIQUE, name, state, credential, sign_in_state, pending, auth_url, error)`, admin's custom connectors cached in meta `custom_apps` (source: Gallery DO), connector watches are triggers.
- Behavior & invariants: connector id = `slug(name)` with a random suffix if taken; one connection per directory app (`serverFor`); `connectApp` clears failed/abandoned connections then adds; `authUrl` returned when sign-in needed; callback `/mcp/callback/<owner>` (MCP) and `/mcp/callback/apps` with `state="<owner>.<nonce>"` (native), public routes validated by OAuth state; native sign-in TTL 15 min; credentials renewed 60 s before expiry with generation fencing so a removed-and-re-added connection can't be touched by old work. Tools exposed as `<app>_<tool>` extension `pim.app.<id>`; MCP tool calls are gated by `mcp_call` actions per `approval` policy (`needsApproval`) and permissions.
- Computer/admin: No computer. Admin: deployment secrets for some native connectors (`GITHUB_CLIENT_ID/SECRET`, `SPOTIFY_*`, `GOOGLE_GMAIL_*`, `GOOGLE_DRIVE_*`, `APP_CREDENTIALS_KEY`); public HTTPS callback URL (`PIM_PUBLIC_URL`) reachable by the provider; custom connectors added by the admin's majordomo with a gated action.
- Authorization: owner connects for own space (`notForGuests`); callback accepted only from a browser signed in as that owner (Worker hands the return on, `native-apps.ts` header comment); `add_custom_connector` needs signed-in browser; admin controls what directory offers.
- Migration/export-import: KEY RE-ENCRYPTION: native connector `credential`/`pending` are AES-GCM `sealed:v1:<iv>.<ct>` with AAD = `pim.app-credential.v1\n<owner>\n<connectionId>\n<app>\n<purpose>` (`native-apps.ts:474-507`), key = `APP_CREDENTIALS_KEY` (32 bytes b64). Migration options: (1) keep same key AND same `owner` id, connection id, app ref → export bytes verbatim; (2) if owner id or key changes, decrypt with old binding and re-seal with new (must run where both keys are available); otherwise users hit `ReconnectRequired`. Unsealed legacy values (no prefix) are re-sealed on next use. MCP OAuth tokens in the agents SDK KV: no documented export format — re-authorize is the safe fallback (UNVERIFIED whether exportable). `callback_url` stored per server embeds the old public URL and owner id: must be rewritten if `PIM_PUBLIC_URL` changes (and the provider's registered redirect URI must match; for GitHub/Spotify/Google registered in the provider console).
- Public ID/URL: `/mcp/callback/<owner>`, `/mcp/callback/apps`, `/mcp/events/<owner>/<key>` (signed webhook URLs registered at the provider: PRESERVE hostnames/paths or watches go silent).
- Explicit settings: per-server `approval` mode, per-tool permissions, agent `apps` lists, connector watches (triggers).
- Dependencies: agents (`appsOf`), triggers (event subscriptions), skills store, `APP_CREDENTIALS_KEY`, gallery for custom connectors and admin flag (`owner_admin` meta).
- Acceptance test: connect Linear (MCP/OAuth) and Spotify (native) pre-migration; after migration a tool call from each works with no re-auth (if same key/URL) and refresh-token renewal succeeds; with key changed expect clean `ReconnectRequired` and re-auth works.
- Uncertainty: SDK KV layout; whether MCP clients re-register dynamically after callback URL change.

### Pim as MCP server and OAuth provider (`mcp-auth`, `/mcp`)
- Sources: `src/mcp-auth.ts:1-153`, `src/mcp-server.ts` (UNVERIFIED read), `src/gateway.ts:60-85`, `wrangler.jsonc:67` (`OAUTH_KV`).
- Canonical storage: `OAUTH_KV` Workers KV namespace (grants, clients, hashed tokens) via `@cloudflare/workers-oauth-provider`; props `{owner}`; API tokens (`pim_...`) in the auth Durable Object (`src/auth/store.ts`).
- Behavior & invariants: PKCE required; access tokens 1 h; refresh 30 days idle; `/authorize` consent page; dynamic client registration `/oauth/register`; API tokens also accepted at `/mcp`.
- Computer/admin: no / yes: a KV store replacement (the library requires a KV-compatible interface) and a stable public origin (resource metadata uses it).
- Authorization: grant opens exactly one owner's space; `Settings` lists/revokes by grant id.
- Migration/export-import: export KV entries (grants/clients/tokens hashed) or force clients to re-authorize; tokens are hashed so can be moved verbatim only if same hashing secret/format (library-internal, UNVERIFIED).
- Public ID/URL: `/.well-known/oauth-*`, `/oauth/*`, `/mcp`, `/mcp-server`: must keep origin or all external clients must reconnect.
- Explicit settings: none.
- Dependencies: account directory for token owner.
- Acceptance test: Claude/ChatGPT-style client with existing grant refreshes token after migration.
- Uncertainty: portability of `workers-oauth-provider` off Cloudflare.

### Account directory (src/directory.ts) and deployment connector directory
- Sources: `src/directory.ts:106-160` (tables `accounts`, `registrations`, `invites`, `cleanups`, `identities`, `directory_meta`, `rate_limits`, `computer_requests`), `src/extensions/app-directory.ts` (the connector directory), `src/gallery.ts:223-330`.
- Canonical storage: Directory Durable Object SQLite (accounts: id `o_…` owner ids, role admin|member|guest, status, bot); Gallery DO (templates, bots, providers, apps, disabled built-ins, compute providers, sandbox pools).
- Behavior & invariants: owner id → `Pim` DO name; callbacks route by owner id; admin = first account.
- Computer/admin: yes admin (deployment-level state).
- Authorization: gateway authorizes tokens/cookies against the directory.
- Migration/export-import: owner ids are embedded in OAuth callback URLs, connector `callback_url`, AAD of native credentials, MCP grants (`props.owner`) and trigger/webhook URLs: they must be preserved verbatim. The directory and gallery are out of this fragment's per-space export but gate it.
- Public ID/URL: owner id in public URLs `/mcp/callback/<owner>`, `/shared/<owner>/<link>`, app origins.
- Explicit settings: registration mode, bots/templates/providers.
- Dependencies: every per-space feature.
- Acceptance test: all owner ids identical after migration; callback URL for a pre-existing connector resolves to the right space.
- Uncertainty: directory schema details beyond table names not read.

### Run guard (stoppable tools) and the run watchdog
- Sources: `src/run-guard.ts` (83 lines) (`stoppable`, `RunWatch`, `pim_run_watch`), `src/space/conversations.ts:983-1030` (`armWatchdog`, `watchRuns`), `src/activity.ts:40-41`, `src/space/reports.ts:176-230`, `src/pim.ts:1181`.
- Canonical storage: `pim_run_watch(session PK, run, seen_at, fingerprint, since)`; scheduled `watchRuns` callback; reads pi `inspect()` + `LiveDoc`.
- Behavior & invariants: every registered tool is wrapped so its promise is raced with the chat's cancellation context (`awaitWithContext`); watchdog fingerprint = SHA-256 of `[(taskId, state.kind)…] + live`; runs waiting on suspended tools, retries, deferred generation, or compaction retry are not "stalled". A run with unchanged fingerprint beyond `stallMs` is stopped with a note. Re-armed while anything is busy, else the space sleeps.
- Computer/admin: no / no.
- Authorization: system.
- Migration/export-import: `pim_run_watch` is disposable (rebuilt); but `armWatchdog()` must be called at Runner start. Fingerprint depends on pi task id ordering and `LiveDoc` shape: a different adapter changes fingerprints once (harmless; one extra window).
- Public ID/URL: none (diagnostic output `chat` uses public ids).
- Explicit settings: `stallMs` from settings/deployment.
- Dependencies: pi `inspect()` must return all non-background tasks with `record.conversationId`, `record.id`, `state.kind` (`suspended|waiting|...`), which Pim reads in at least five places (watchdog, `heldSessions`, `resumeDecided`, `waitingCall`, `#busyRuns`). THIS API MUST EXIST in the Postgres adapter.
- Acceptance test: tool that never returns is stopped after stallMs; a parked approval is NOT stopped.
- Uncertainty: `stallMs` default not read.

### Progress lines
- Sources: `src/progress.ts:1-120`, `src/pim.ts:327-335`, hooks on `GenerationTask` (`beforeRequest`, `afterResponse`).
- Canonical storage: none (in memory `#context`, `#describing`); delivered over WebSockets as `{type:"progress",session:publicId,text,calls}`.
- Behavior & invariants: only while someone watches the chat; ≥5 s gap; utility model writes the line; models with reasoning headings use those. Selected by every chat; visits/tasks get none.
- Computer/admin: no / utility model optional.
- Authorization: sockets authenticated like API.
- Migration/export-import: nothing.
- Public ID/URL: websocket message shape.
- Explicit settings: utility model (`UTILITY_MODEL_KEY` meta, `PIM_UTILITY_MODEL`).
- Dependencies: Live must expose "who is watching" (`sockets.watchers(session)`) to the process running the generation: in a Gate/Live/Runner split the Runner executing the generation must reach the Live node holding the sockets.
- Acceptance test: open chat, run a multi-tool step, see progress lines; none when nobody watches.
- Uncertainty: none.

### Chat links (public read-only copies)
- Sources: `src/chat-links.ts` (145 lines), `src/space/routes.ts:461-500`, `src/space/views.ts:130-137`, `src/gateway.ts` (`/shared/<owner>/<id>` route).
- Canonical storage: `pim_chat_links(id 22-char base32, session UNIQUE, chat JSON, shared_at)`; the copy is a SNAPSHOT (≤1,000,000 bytes JSON), not a live view.
- Behavior & invariants: copy built from entries since the last `pi.reset`, only user messages and successful `send_to_user` calls, widgets without links, no tool activity; deleting the chat deletes the link.
- Computer/admin: no / no.
- Authorization: PUBLIC — anyone with the link; owner makes/updates/removes it.
- Migration/export-import: export rows verbatim (snapshot must not be regenerated).
- Public ID/URL: `<PIM_PUBLIC_URL>/shared/<owner>/<linkId>` — preserve exactly.
- Explicit settings: none.
- Dependencies: reads pi entries (`pi.reset`, `pi.system`, `pi.compaction` kinds are interpreted).
- Acceptance test: GET the old public URL anonymously returns the same JSON.
- Uncertainty: none.

### Reports and diagnostics reads
- Sources: `src/space/reports.ts:1-462`, `src/extensions/meta-diagnostics.ts`, `src/diagnostics.ts:111`, `src/model-calls.ts`, `src/usage.ts`.
- Canonical storage: host tables `pim_diagnostic_events`, `pim_model_calls`, `pim_usage_*`; live reads of pi (`LiveDoc`, `ProviderDoc`, `inspect()`, messages).
- Behavior & invariants: read-only; chat ids shown by public id; free text scrubbed.
- Computer/admin: admin's majordomo only for meta tools.
- Authorization: admin.
- Migration/export-import: diagnostics are disposable; usage tables are billing/limit data and should be exported.
- Public ID/URL: none.
- Explicit settings: limits (`LIMITS_KEY` meta, `PIM_LIMIT_*`).
- Dependencies: reads across ALL conversations (turn reports iterate chats).
- Acceptance test: `/diagnostics` busy-run list matches `pi.inspect()` tasks.
- Uncertainty: usage table semantics not fully read.

### Messaging, `send_to_user`, notifications, push, widgets, `ui` block state
- Sources: `src/extensions/messaging.ts:200-444`, `src/pim.ts:1060-1130,1405-1470`, `src/store.ts:230-275,1089-1125`, `src/space/views.ts:176-200`, `src/space/shared.ts:34,125-134`.
- Canonical storage: pi entries (assistant message + tool call/result) are the transcript; host: `pim_notifications`, `pim_push_subscriptions`, `pim_emails`, `pim_tool_widgets`, `pim_ui_state(message=pi entry id, block, version, state, submitted)`, `pim_ui_audit`, `images` (R2 `BLOBS` + `pim_images`), meta `awaiting:<s>`, `suggestions:<s>`, `vapid_keys`.
- Behavior & invariants: only `send_to_user` speaks; replay-safe through memo keys; ui-block ids derive from message text hash; ui state forgotten when the chat is deleted (sweeps 25 messages ≤ every 10 min). Reply push scheduled after 10 s unless read (`pushReply`), idempotent id `reply-<publicId>-<at>`.
- Computer/admin: no / Email sending and Web Push need deployment email binding and VAPID (self-generated); R2 for images.
- Authorization: owner.
- Migration/export-import: `pim_ui_state.message` is a pi ENTRY id: must remain valid; images: URLs point into R2 by id: copy objects and keep URL scheme (signing key `images_signing_key` meta, `src/images.ts:42` — signed URLs break if the key isn't migrated).
- Public ID/URL: image URLs (signed), push endpoints (subscriptions are browser-owned, domain-bound).
- Explicit settings: `deviceAlerts`, `timeZone`, locale.
- Dependencies: rooms (`posted`), notifications, email.
- Acceptance test: ui form state saved pre-migration is the same post-migration and still read by `ui_state`.
- Uncertainty: entry id stability.

### Memory (optmem) background nap
- Sources: `src/extensions/optmem/index.ts:200-470`, `store.ts:52-80` (`optmem_log`, `optmem_tree`, `optmem_meta`, `optmem_scopes`), `src/pim.ts:1046-1062`, `src/space/reports.ts:78`.
- Canonical storage: optmem tables in the space DB (scopes private/everyone/agent/named/former); one background `optmem.nap` pi task on the ROOT conversation; meta `nap_task`.
- Behavior & invariants: one nap at a time; `retry{until}` phase is a time wait; shared memory across all agents/conversations; epoch invalidates cached views; extension installed AFTER sections that must stay stable.
- Computer/admin: no / model for compression (`PIM_MEMORY_MODEL`, else root agent model).
- Authorization: per-agent read scopes (`memoryAccess`).
- Migration/export-import: export tables + the pi task (checkpoint) or drop the task and let `startNap` recreate (safe: it recomputes `pending`). Task id referenced by `nap_task`.
- Public ID/URL: none.
- Explicit settings: named scopes, agents' scope lists.
- Dependencies: ROOT conversation exists; root-scope task ownership — partition the ROOT conversation with the space.
- Acceptance test: pending compression resumes after import and finishes once.
- Uncertainty: none.

### Trigger-made chats (cross-reference)
- Sources: `packages/triggers/src/host.ts:53-59,215-262`, `src/space/triggers.ts:635`.
- Canonical storage: `pim_trigger_host_operations`, `TriggerChatDoc` (the only Pim pi-doc).
- Behavior & invariants: the host records `chat_id` from the `init` callback (`packages/triggers/src/host.ts:236-240`), which runs BEFORE pi's SQL transaction opens, so it is a separate autocommit, not atomic with the pi commit (0.4.0); `#madeChat` repairs a recorded id pi never wrote (`host.ts:380-398`); lookup by operation id decides created/absent/unknown.
- Computer/admin: Computer sources need the paired computer.
- Authorization: owner.
- Migration/export-import: export operations table AND doc; `chat_id` strings must match.
- Public ID/URL: none.
- Explicit settings: n/a.
- Dependencies: scheduled tick, connector webhooks.
- Acceptance test: a trigger firing at the migration boundary creates exactly one chat.
- Uncertainty: other fragment owns details.

---

## 2. Quick answers for partitioning
- All Pim-defined pi records: 1 task kind (`optmem.nap`, ROOT-owned), 1 doc (`pim.trigger_chat`, conversation scope), 0 families; no session- or task-scoped docs. Everything else is pi built-ins (`pi.generation`, `pi.tool`, `pi.compaction`, `pi.live`, `pi.inbox`, `pi.provider`, `pi.usage`, `pi.agent`).
- Strictly conversation-local pi state (partitionable by conversation id): all docs above, tool/generation tasks.
- Space-global state that couples conversations (must be co-located or coordinated): ROOT conversation (nap task, `pim_*` memory), `pim_tasks` (links requester/task/root conversations), `pim_room_*` (seats), `pim_approvals`↔`pi.tool` tasks, `pim_session_ids`, `pim_sessions.continued_*`, `pim_tool_permissions`, `pim_extension_data`, agent store, MCP connections (singleton per space; in the DO process memory), WebSocket watchers.
- Required pi-durable adapter capabilities exposed by call sites: `inspect()` (all tasks + states), `snapshot(Doc, id)`, `conversation.commit` with `tx.doc/settleSubmission/appendEntry/createTask`, `createConversation({init})`, `conversation.fork`, `conversation.submit({type:"write"})`, `storage().submissionByRequest`, `resumeTask(session, taskId)`, `waitForTask`, `harness.wait(operationId,{session})`, `sessions.list()` with `busy`/`parent`, `getTask`, `configure`.
