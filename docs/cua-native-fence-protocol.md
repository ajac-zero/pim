# Native-app calls through the bridge's broker: the acknowledged-fence protocol (spec and plan; not implemented)

**Status: draft specification, not acceptance-ready. Nothing here is implemented, accepted or active.** Two points block acceptance, and neither is settled here: holding the harness's line across `ctx.storage.sync()` is an unqualified risk ("Local invalidation"), and a Stop with an `operationId` needs exact resolution that isn't yet shown ("Stop, Delete, removal, epoch, unknown"). Groves chose acknowledged remote fencing as the direction for native-app calls in the protected-account design (`docs/cua-native-host-plan.md`). Two directions were rejected: a prepare-then-irrevocable-`go` dispatch, and asynchronous revocation (see the plan's record). Pim's `nativeDesktop()` stays false. **Human takeover is unavailable, and nothing here is a takeover or quiescence claim.**

This revision answers the reviews of `7ef5ab5` and `dfa088b`. Scopes now match each change. Every harness run end is accounted for. The fence step is exact. The acknowledgment is the latch alone, with no counts. Messages have a discriminator and per-type bounds. Fences are deduplicated by scope, with reserved capacity. The wording is narrowed.

## The contract

- **Local admission closes at once.** Stop, Delete, an agent's removal and an epoch change each close their scope in Pim before their route answers. From then on Pim records no new native intent and sends no `native.execute` in that scope.
- **Scopes are as narrow as the change.** Stop closes the runs it stops, not the chat: the chat's next run works as before. Delete closes the chat for good. Removing an agent closes that agent's calls; its chats go on with the majordomo, as today. A queued reset is unchanged: it is not a closure until the harness applies it. Unaffected chats and agents are untouched. See "Scopes".
- **Two things are reported separately:** the local change (stopped, deleted), and the state of the desktop fence.
- **A confirmed fence means exactly this:** the broker instances that could still send any call Pim intended in the scope have each latched the scope and acknowledged it. So the broker sends nothing more in that scope, including calls whose outcome is `unknown`.
- **It does not cover:**
  - input already handed to spacesd, which may still act, or the outcome of an `unknown` call;
  - any other process on the desktop;
  - the person's control of the display.
- **No false success.** An unavailable VM or instance leaves the fence `pending` and then `unconfirmed`. Time passing, a new instance or Pim's local close never makes it `confirmed`.
- **Preserved from today:**
  - Delete still hides the chat (`deleted_at`) and aborts it, its seats and the tasks it handed out.
  - Stop still aborts through `Conversation.abort()`.
  - The binder's tombstones and run latches are never released.

**Previous semantics vs added ones.** Today Stop and Delete are local only:
- the harness aborts, and Delete hides;
- the binder and the send gate refuse a call that hasn't left (`docs/cua-native-identity.md`);
- nothing is said about the desktop.

This protocol adds a remote statement, reported separately and possibly never confirmed, and narrows nothing local.

## A correction to earlier claims

The accepted send gate (`#desktopSend` in `src/pim.ts`, accepted at `b347372`) is a **local** qualification. It reads the authority in a harness commit, then reads Pim's deletion and agent records synchronously, and calls `transmit()` inside that commit's callback, before the commit resolves. Nothing there is awaited as durable before the send. Its tests showed the order of reads against store writes queued in its awaits, in workerd with stand-ins, and nothing about a remote executor.

`docs/cua-native-host-plan.md` at `023a068` said protocol B put "the authority's commit at the broker's send", and treated recording inside the commit callback as a durable commit. **Both are withdrawn.** A callback's return is not a durable commit. Cloudflare documents output gates for Durable Object storage, but nothing here verified that they hold this WebSocket send behind these writes, so this protocol awaits durability explicitly wherever a record must precede a message.

## Parties and trust boundaries

| Party | Account | Trusted for | Not trusted for |
| --- | --- | --- | --- |
| Pim (the space's Durable Object) | Cloudflare | Authority: intents, closures, fences, the durable record | Anything on the VM |
| The link | TLS through Caddy to the bridge, the bridge's bearer, `x-pim-space` | Authenticity and order of messages within one connection | Delivery across connections |
| The bridge and broker | `pim-bridge` | Executing only what Pim sent, latching, reporting truthfully | Durability: its memory dies with its process |
| pim-computer | `pim-desktop` | Its ordinary ops | Anything native. The demux drops every `native.*` from its side and ends the session |
| spacesd | `pim-spacesd` | Running the curated tool it is sent | Deduplication, cancellation, or saying when input lands |

## Scopes, and who mints their keys

Every intent records each key below, read from Pim's or the harness's own records, never from a model, the bridge or the desktop.

| Scope | Key | Minted by | Closed by | Never reused because |
| --- | --- | --- | --- | --- |
| Run | harness run ID | pi-durable's `Storage.mintId()` in the commit that starts a run (Pim's patch, `docs/pi-durable-run-identity.md`) | Stop, Delete (the runs of seats and handed-out tasks), an `unknown` call (its run) | One global numeric namespace, never reused after a committed write |
| Conversation | harness conversation ID | the harness | Delete (`deleted_at`, the existing record) | Harness IDs come from the same namespace |
| Assignment | (conversation, agent ID, generation); `assignment` in an execute is the generation, 0 until a reassignment route exists | Pim's `AgentStore` and task records; the generation by Pim's store | A change of the chat's agent | The generation only grows |
| Agent | agent ID | `newAgentId` in `src/agents.ts` (48 random bits) | Removing the agent (`DELETE /agents/:agent`) | Stage 1 redraws a new agent ID equal to any `agentId` in Pim's intents or tombstones, which are bounded (below) |
| Epoch | the coordinator's control epoch | `ControlCoordinator` | Each change of ownership | Epochs only grow |

**Reassignment vs removal.**
- **Today no route reassigns a live chat.** `AgentStore.setSession` runs only when a conversation is created (`src/pim.ts` L1992, L3038, L3288). The one way a chat's agent changes is removal: `AgentStore.delete` drops the agent's `pim_agent_sessions` rows, and its chats talk as the majordomo from then on. Task conversations fall back to the majordomo too (`#roleOf`, `src/pim.ts` L2934).
- **Removal closes the agent scope:** every call by that agent, in every chat. The agent no longer exists, so no ordinary use is lost. The chats themselves stay open under the majordomo.
- **A future reassignment route** closes only the (conversation, old agent) assignment. It must also bump a per-conversation assignment generation, which Pim's store increments in the same SQL write as the row change, and which every intent records. Then a chat moved back to an earlier agent isn't blocked by the old closure. The agent's other chats are unaffected.
- **The local check needs no new record:** the gate already refuses a call whose binding's agent isn't `#roleOf(session).agent.id`.

**Stop never closes the conversation or the agent.** A later message starts a new run with a new run ID, which no closure names.

## Local invalidation: every run end, before the send

Two kinds of change can make a call stale between its authority read and its send. They are ordered against the send differently, and both orderings are needed.

### Harness run ends: ordered by the harness's line

Every change to a run in pinned pi-durable 1.1.0, as patched, is a harness commit on the session's mutation line (`Session.commitWith`, `dist/session/session.js` L53–60, `#enqueue`). Each conversation's `commit` maps onto it (`dist/harness/harness.js` L47–48), and so do the scheduler's commits (`dist/harness/scheduler.js` L97, L134, L166, L212).

| Path | Where (dist/harness) | What it does |
| --- | --- | --- |
| Natural completion | `generation.js` L423, L504 | `endRun(… "done")` |
| Model error, no model | `generation.js` L232, L244, L389 | `endRun(… "unanswered")` |
| Reset applied | `generation.js` L512 | `endRun(… "reset")` at the run's boundary |
| Abort | `scheduler.js` L207–212 | `Conversation.abort()`: in one commit, withdraws queued inputs and marks live tasks |
| Abort settled, task faulted | `live.js` L86–106 (`settleSchedulerOutcome`) | `endRun` for the run's task |
| Next run, replacement | `generation.js` L425, L506, L514; `submissions.js` L156, L172 | `startRun` with a new run ID |
| Handover | `generation.js` L419, L520 | Not a run end: the run ID stays |

**The gate holds that line from its authority read to its send.** It runs inside one harness commit, so every row above lands wholly before the gate's read (which then refuses: the run has ended, the task is terminal or marked for abort, or a newer run doesn't own the task) or wholly after the send. The change from today is that the intent's durability await (step 4 below) also happens inside that commit. So the line is held across it, and no harness run end can land between the authority read and the send.

- **This is a pending qualification risk, not an accepted implementation detail.** No one has shown that awaiting `ctx.storage.sync()` inside a harness commit callback neither deadlocks nor is refused, in workerd or in production. Its latency is also unmeasured: every harness commit of the space would wait behind one storage sync per native call. Stage 2 has to qualify both. If it can't, the design goes back to review, and doesn't fall back to releasing the line.
- **Review rule for upgrades:** every `endRun` and `startRun` in the pinned, patched dist must be inside a commit callback. The stage 2 reviewer greps for them, and so does any reviewer of a pi-durable upgrade.

### Pim's own records: re-read with nothing awaited before the send

Deletion (`deleted_at`), an agent's removal, a chat's agent, Pim's run closures and the coordinator's epoch are written outside the harness's line. They can land during any await, including the durability await. So the gate reads them again **after the last await, synchronously, immediately before `transmit()`**.

### Why routes alone wouldn't do

A closure written only by the Stop and Delete routes would miss the harness's own run ends: completion, an applied reset, a model error, a fault and replacement. Those are covered by holding the line, not by closures. Pim's run closures exist for the remote fence, and for one window: between Stop's closure commit and its abort commit (below).

## Messages

Every message is one JSON object with a `type` discriminator, `v: 1`, and exactly the listed keys. A message over its type's bound, of another shape, or of an unknown type is refused with a fixed reason and changes no state. The broker sends `native.*` only to Pim's side, and the demux drops any `native.*` from pim-computer's side and ends that session. The link's frame cap stays `BRIDGE_MESSAGE_CHARS` (16 MiB).

| `type` | Direction | Keys | Bound | Meaning |
| --- | --- | --- | --- | --- |
| `native.hello` | broker → Pim, first on each connection | `instance` | 256 chars | Which instance this is. Pim sends no execute or fence to a connection without one |
| `native.execute` | Pim → broker | `requestId`, `owner`, `agentId`, `conversationId`, `runId`, `assignment`, `epoch`, `instance`, `tool`, `arguments`, `argsSha256`, `boundMs` | `NATIVE_ARGUMENTS_CHARS` (32 KiB) + 4 KiB | The one action message, never re-sent. `boundMs` ≤ 60,000, from the broker's receipt |
| `native.result` | broker → Pim | `requestId`, `instance`, `sent`, `outcome` | The outcome ≤ `NATIVE_WIRE_LIMITS.maxOutcomeChars`, the rest ≤ `REPLY_RESERVE_CHARS` | Exactly one per execute the broker read, unless it dies. `sent: false` only if it refused before handing the call to `fetch`. Screenshots fit, as now |
| `native.fence` | Pim → broker | `fenceId`, `instance`, `scope` | 1 KiB | Latch the scope. Idempotent; re-sending it is a status request |
| `native.fenced` | broker → Pim | `fenceId`, `instance`, `scope` | 1 KiB | An echo of the fence, sent only after its latch (or the space latch) is set. Repeats are identical, and the broker stores nothing per `fenceId` |

**Scope objects:** `{ kind: "run", runId }`, `{ kind: "conversation", conversationId }`, `{ kind: "assignment", conversationId, agentId, generation }`, `{ kind: "agent", agentId }`, `{ kind: "epoch", epoch }`.

**The acknowledgment is the latch alone.** It carries no list, count or digest of calls. Each call's own disposition arrives in its `native.result`, whenever that is, and no result is compared against the fence. Pim checks only that the echo's `fenceId`, `instance` and `scope` equal its record. Trusting the instance's latch is the same trust the design already places in it to execute only what Pim sent.

## Pim's side

### Records, in Pim's SQL storage

- **Intent**, keyed by `requestId`. It holds every field of `native.execute`, frozen, and a `state`:
  - `intended`: written, and durable before any execute exists;
  - `refused`: the broker said `sent: false`, or Pim knows it never transmitted;
  - `completed`: a valid result with `sent: true`;
  - `unknown`: anything else.

  The last three are final: an outcome never changes once settled. `unknown` latches the run in the binder and the coordinator, as today. **An `unknown` intent still counts as outstanding for fences**, because Pim settles it when its own wait ends, while the broker measures `boundMs` from receipt. A delayed execute can therefore still be sent.
- **Run closure**, keyed by run ID, written by Stop and Delete (below).
  - **A closure whose run has intents is kept for good**, with its fence, even after the harness ends the run. The harness then refuses the run locally, but the fence's scope and required instances are what Pim re-sends and what it reports, and the broker's latch is keyed on the run.
  - **A closure whose run has no intents needs no fence.** It can be compacted once Pim has observed in a harness commit that the run ended, since the authority then refuses that run's calls for good.
- **Fence**, keyed by its canonical scope key (`kind` plus its keys), with one `fenceId` minted when the record is first made. It holds:
  - its required instances, the distinct `instance` of every intent in scope that is `intended` or `unknown`;
  - its acknowledgments;
  - its state, `pending`, `confirmed` or `unconfirmed`.

  Closing a scope that already has a fence reuses it: a repeated Stop or an `unknown` call in an already fenced run makes no new record and no new `fenceId`. A closed scope admits no new intent, and a run with an `unknown` call is latched in the binder, so the required set is fixed when the fence is made. A scope with no `intended` or `unknown` intent needs no fence, and none is recorded.
- **Fence capacity is reserved with the intent.** An intent belongs to five scope keys: its run, conversation, assignment, agent and epoch. In the synchronous step that writes it (step 3 below), Pim reserves a fence slot for each of those keys that doesn't hold one yet. If the reservation can't be made, the intent isn't written, and the call is refused unsent (`full`). So a scope that needs a fence always has its slot. At most 5 × 512 = 2,560 slots are ever reserved. A failure to fence never comes from exhausted capacity.

The other closures already exist: `deleted_at`, the agent's absence from `AgentStore` (with the redraw rule above), and the coordinator's epoch.

### One closure boundary

Each change that closes a scope does, in **one synchronous step** with nothing awaited:
1. its own write (`deleteSession`, `agents.delete`, or the run closures);
2. a scan of every intent in the scope;
3. the fence record, with required instances from that scan.

An intent written after that step can't be in the scope, because step 3 of the call path re-reads the closures before writing one. An intent written before it is in the scan, whatever its state.

### A call's path, with every await

1. **Binding and approval**, as today. The binder's claim is its own harness commit, as today.
2. **The gate's harness commit starts.** Pim's authority reads the tool task and run (`tx.task`, `tx.run`) and `await`s its answer, as today. The coordinator has admitted the request.
3. **Synchronous step:** read the deletion, the chat's agent and assignment, the run closures, the epoch, and the connection's `instance`. If all pass, write the intent `intended`.
4. **Await the intent's durability** (`ctx.storage.sync()`), still inside the gate's commit, so no harness run end can land. Pim's own records can.
5. **Synchronous step, then transmit:** read the records of step 3 again. If anything changed, settle the intent `refused` (Pim knows it never transmitted) and send nothing. Otherwise transmit `native.execute` on the same connection, with nothing awaited between the read and the send.
6. **The commit ends.** Await the result, bounded by `boundMs` plus transit:
   - a valid result settles the intent `completed`, or `refused` if `sent: false`;
   - anything else (none, malformed, another instance, a closed connection) settles it `unknown`, and records a run fence for its run (below).

There is no cross-store transaction. The harness's records, Pim's SQL and the coordinator's state are read in this order, and each later step re-reads what an earlier await could have let change.

### Stop, Delete, removal, epoch, unknown

- **Stop** (`POST /sessions/:session/abort` without an `operationId`):
  1. One Pim harness commit reads the live run of the chat and of each seat (`tx.run`). In one synchronous step inside it, it writes their run closures, scans their intents and records the fence.
  2. The route awaits durability, then runs the existing aborts.
  3. It answers `{ aborted, desktopFence }` without waiting for the desktop.

  Because step 1 is on the harness line, a gate is wholly before it (its call is out, and the fence orders it) or after it (its step 3 or 5 finds the closure). **A run that starts after step 1 is a new run** (for example from a queued input reaching its turn) and isn't closed or fenced by this Stop. The existing abort may still end it locally, as today.

  **A Stop with an `operationId` keeps its existing meaning.** It either withdraws a queued input, or aborts the run that input joined (`abort` in `agents/harness/pi`). Pim closes and fences a run only when, in the closure commit, it resolves exactly from the harness's records that the operation is one of the live run's inputs. A queued input closes nothing. **There is no fallback:** if stage 1 can't show exact resolution, the native feature fails qualification (acceptance gate 3) until it can. Stop never over-closes silently.
- **Delete:**
  1. `deleteSession` runs first, as now. In the same synchronous step it scans the chat's intents and records its conversation fence.
  2. Then a harness commit, as for Stop, closes and fences the live runs of its seats and of the tasks it handed out. Their later runs are unaffected, as today.
  3. Then the existing steps run.
- **Removing an agent:** after the existing task cancellations, `agents.delete` and the agent's fence record share one synchronous step.
- **An epoch change** records an epoch fence for the old epoch if it has outstanding intents.
- **An `unknown` call:** in the step that settles it, Pim records a run fence for its run. That covers the delayed-execute case after natural completion, a reset or replacement, with no hook into those paths.
- **Fence delivery:** Pim sends `native.fence` to the connection whenever a required instance is connected, and again on each reconnect while the fence is `pending`.
- **On `native.fenced`:** Pim checks that the `fenceId` is known, that the instance is required and not yet recorded, and that the scope is equal. It then records the acknowledgment durably (awaited) before counting it.
- **States:**
  - **confirmed:** all required instances have acknowledged durably;
  - **unconfirmed:** after 2 minutes (proposed), or as soon as the connection belongs to another instance while one is missing. It still accepts late acknowledgments from its own missing instances.

## The broker's side

### State: in memory, per instance, bounded

- **Calls:** each execute read, keyed by `requestId`. State is `setup`, `sent` or `refused`, at most 1,024 per instance. Past that, executes are refused (`sent: false`).
- **Latches:** a set of canonical scope keys, at most 4,096, above Pim's 2,560 reserved slots. A repeated scope adds nothing. Past the bound, the next fence sets the space latch instead, a single flag that covers every scope. The space latch refuses every later execute, so that instance has to be replaced before native calls resume. Every fence, before or after saturation, is answered with its own echo. Nothing is stored per `fenceId`.
- **Calls in progress:** at most one per run (`busy`) and `MAX_RUNS` (256) runs, as `createNativeDispatcher` keeps them, with its run latches.

These bounds sit above Pim's lifetime quota (below), so in a correct Pim they aren't reached. They exist against a faulty peer, and they fail closed.

### One serialized queue per space

Run setup (`initialize`, `notifications/initialized`, `tools/list`) is awaited outside the queue. Two steps happen inside it, each one synchronous with nothing awaited:

- **Send step**, for a call whose setup finished. The call must be `setup` (not `refused`), its `instance` must be this one, `boundMs` must not have passed, and no latch may cover any of its keys or the space. If so, it is marked `sent` and the `tools/call` is handed to `fetch`, with no await before the handoff. Otherwise it is marked `refused` and its `native.result` says `sent: false`.
- **Fence step:**
  1. Set the latch for the scope, or the space latch past the bound. Setting it again is a no-op.
  2. Mark every call in the scope that is still in `setup` as `refused`. This is irrevocable, and happens before the answer exists, so its setup continuation finds it refused and never reaches `fetch`. Its `native.result` then says `sent: false`.
  3. Send the echo.

  A call in scope that arrives later is refused by the latch, and reported in its own `native.result`.

So within one instance, every send and fence step has one place in the queue. A send before the fence step may have run. Nothing in the scope is sent after it. **This order is the broker's, not Pim's:** a send placed before the fence step can follow Pim's local close in real time, if the execute left before the close. The protocol doesn't claim that Pim's close forbids a remote send of an execute already transmitted.

### What an acknowledgment proves, and for how long

An acknowledgment says: "this instance has latched the scope, and sends nothing more in it". **Once Pim has recorded it durably, it stays true for good.** While that process lives, the latch is checked at every send. After it dies, it sends nothing. A later instance refuses every execute naming another instance, and Pim never transmits an old execute again. So a recorded acknowledgment remains valid after its instance dies, and across restarts of the bridge and of Pim.

What a crash loses is the ability to acknowledge again. If an instance dies before Pim recorded its acknowledgment, its fence stays `unconfirmed` for good, because no one can speak for what that process did. **The broker needs no durable journal:** a journal would let a successor repeat an acknowledgment, but couldn't vouch for its predecessor's last moments.

A process that is suspended and resumed, not restarted, keeps its memory and latches.

## Crashes, losses and replay

| Event | Pim records | Why |
| --- | --- | --- |
| Pim ends after the intent is durable, before transmit | On restore every `intended` intent becomes `unknown`, with a run fence | It can't prove nothing left |
| Pim ends after transmit | `unknown`, and a run fence | |
| Pim ends before the intent is durable | If the intent survived, `unknown` and a run fence; if not, no intent. Either way the binding comes back `unknown` (`docs/cua-native-identity.md`, "Restarts") | Nothing was transmitted, but restore can't tell |
| Execute lost (connection closed) | `unknown` | Never re-sent |
| Broker ends before or after `fetch` | `unknown`. Fences that need it stay `unconfirmed` | A new instance can't say what the old one did |
| Result lost | `unknown` | A late result changes nothing |
| Pim gave up, and the delayed execute arrives later | Stays `unknown`. Its run fence requires that instance | The broker's bound starts at receipt |
| `native.fenced` lost, instance alive | `pending`, re-sent, answered with the same echo | Re-sending the fence is a status request |
| `native.fenced` lost, instance dead | `unconfirmed` | |
| Pim's durable write of an acknowledgment fails | Not counted. Re-sent while the instance lives | Only a durable acknowledgment counts |
| Old and new instance both alive | Each answers for itself. A silent required one leaves the fence `unconfirmed` | No clearance by succession |

**No replay:**
- No `native.execute` is sent twice.
- No request, run or assignment key is minted again to escape `unknown`.
- A closed scope blocks every later call in it.

Re-sending a fence is the only repeated message, and it changes nothing beyond the latch it repeats. **Expiry never proves absence:** Pim's timers never turn `unknown` into `refused`.

## Retention and quotas

- **Intents:** at most one per binding. The binder already holds at most `MAX_NATIVE_BINDINGS` (512) bindings **over the space's lifetime**, and never lets one go. So Pim stores at most 512 intents, each frozen at most `NATIVE_ARGUMENTS_CHARS` + 4 KiB. A final intent whose fences are all settled is compacted to a tombstone (request ID, keys, state). Tombstones are never removed, since they back the no-replay rule.
- **Fences:** one per canonical scope key, reserved with the intents (above), so at most 2,560 over the lifetime, each with at most 512 required instances. They're kept for good.
- **Run closures:** kept for good when their run has intents (at most 512 such runs). Otherwise compacted once the run's end is observed, so the live ones are bounded by the space's live conversations.
- **Removed agents:** no new record. `MAX_AGENTS` (50) bounds agents at a time, not over the lifetime, so removals aren't listed. Instead a new agent ID never equals an `agentId` in the bounded intents and tombstones.
- **At any cap,** Pim refuses new native calls (`full`), as the binder does. Nothing that backs no-replay is ever expired.
- **The broker:** the bounds above, failing closed.

## What the person sees, and the API

| State | Line in the chat or Settings | API |
| --- | --- | --- |
| No outstanding intent in scope | Nothing about the desktop | `desktopFence: null` |
| Fence pending | "Stopped here. Waiting for the native broker to confirm it will send nothing more from this chat…" | `{ id, state: "pending" }` |
| Confirmed | "Native broker fence confirmed: no new broker sends from this chat. Actions already sent may still finish; other programs on the desktop are unaffected." | `state: "confirmed"` |
| Unconfirmed | "Stopped here, but the native broker didn't confirm. Pim sends nothing more; actions already sent may still run, and other programs on the desktop are unaffected." | `state: "unconfirmed"` |
| A call `unknown` | "This action may have run." Never "cancelled" | the intent's `state: "unknown"` |

"This chat" names the scope: "this run", "this chat" or "this agent".

- **The routes answer after the local change is durable and the existing local steps are done:** `DELETE /sessions/:session`, `POST /sessions/:session/abort` and `DELETE /agents/:agent`. Each adds `desktopFence`, and none waits on the desktop.
- **A fence can be read** at `GET /computer/native/fences/:id`, owner only. It returns the scope's kind, the state, and how many of its required instances have acknowledged, and nothing of a deleted chat.
- **The wording never says "safe", "taken over" or "the desktop stopped".**

## Not assumed

No new driver capability, no grant beyond the protected-account plan's open decisions, no takeover, and no cancellation of input spacesd already took.

## Test plan (not written, not run)

Stand-ins only: Pim in workerd with a scripted bridge and broker, and the broker in-process with a stand-in spacesd. Nothing can run before the code exists.

| Case | Expected |
| --- | --- |
| Gate holds the line through the durability await. A harness abort, an applied reset or a natural completion is queued during it | Lands after the transmit. A fresh call afterwards is refused by the authority |
| Delete, agent removal or epoch change during the durability await | Step 5 refuses. Intent `refused`, nothing transmitted |
| Stop's closure commit before or after a gate commit | Before: refused at step 3 or 5. After: the call is out, and the fence's latch orders it |
| A queued input starts a new run after Stop's closure | The new run's calls work. Stop's fence doesn't name it |
| Stop, then the chat's next message | Its run's calls work |
| Removing agent A while A has chats and task conversations; agent B's chats | A's calls refused everywhere. B is unaffected. The chats go on as the majordomo |
| (Future route) reassigning a chat and back again | Only the old generation is closed |
| Setup held at the broker, then a fence | Marked `refused` at the fence step. Setup finishes, and nothing reaches `fetch` |
| Send step before the fence step | Counted `sent`. The intent settles by its result |
| Same fence twice; Stop repeated on a fenced run | The same echo; one fence record and one `fenceId` |
| A call in scope after the fence, and its late `sent: false` result | Refused by the latch. The confirmed fence stays confirmed |
| A Stop with an `operationId` for a queued input; for an input of the live run | Nothing closed; the run closed and fenced. Unresolvable: qualification fails |
| Pim reaches its fence slots | The intent isn't written (`full`). No closure ever lacks a fence slot |
| Execute lost, result lost, delayed execute after Pim's timeout | `unknown`, a run fence, no re-send |
| `native.fenced` lost | Re-sent, and answered with the same echo |
| Pim fails to commit an intent, or an acknowledgment | Nothing transmitted; or not counted, and re-sent |
| Pim restarts between intent durability and transmit | `unknown`, not `refused` |
| Broker restarts with a call in setup; old and new both alive | `unknown`. A fence needing the old one stays `unconfirmed`, and a recorded old acknowledgment stays valid |
| VM unavailable at Stop | The route answers locally. `pending`, then `unconfirmed`. Never `confirmed` |
| Wrong `type` or `v`, oversize per type, unknown keys, forged instance or fence | Refused with a fixed reason, no state change |
| A `native.*` from pim-computer's side | Dropped and the session ended |
| Pim at 512 intents; broker at its bounds | Refused (`full`); executes refused or the space latched, and every fence still answered with its echo |
| A run closure whose run has intents, after the harness ended the run | Kept, with its fence and required instances |
| UI and API | The exact lines above; never "cancelled" for `unknown`; the routes never wait on the desktop |

Mutations, each of which must fail a test:
- the line released before the durability await;
- a send step that awaits after its checks;
- a setup call left eligible to send after the echo;
- a latch set after the answer;
- a re-sent execute;
- a successor clearing an old fence;
- `unknown` settled by a timer or a fence;
- a required set without `unknown` intents;
- a counted acknowledgment that isn't durable;
- Stop closing the conversation;
- removal closing another agent's calls;
- an intent written without its fence slots;
- a run closure with intents compacted;
- a Stop with an `operationId` closing the live run without exact resolution.

## Acceptance gates

1. This spec reviewed and accepted, as written or amended. It isn't acceptance-ready while the two blockers in its status line stand.
2. The protected-account placement's upstream facts verified on a disposable VM under separate authorization.
3. Each stage passes its focused stand-in tests and mutations, and an independent review of its boundary.
4. A composed stand-in run of Pim, the relay with its demux, the broker and a stand-in spacesd passes the whole table.
5. Only then, a separately authorized live qualification. Native calls stay off until a decision after it.

## Implementation plan (staged; nothing started)

| Stage | Scope | Size | Depends on | Review boundary |
| --- | --- | --- | --- | --- |
| 1 | Pim's intents, run closures, fences with reserved slots; the closure steps in Stop (with exact `operationId` resolution), Delete, removal, epoch and `unknown`; `desktopFence` and the fence route; all behind `nativeDesktop` | Large | Gate 1 | Pim's store and routes: one closure boundary, durability awaits, no resurrection, reservations |
| 2 | Qualify, or fail, holding the line across `ctx.storage.sync()`, in workerd; then the gate's steps 2–6 against a scripted bridge; the grep of run ends | Medium | 1 | `#desktopSend` and `Computer.native`. A failed qualification returns the design to review |
| 3 | The demux, `native.hello` and the message parser with per-type bounds (`computer/cua-bridge.ts`, `host.ts`) | Small to medium | Gate 1 | The internet-facing bridge |
| 4 | The broker's queue, latches, echoes and bounds, around `createNativeDispatcher`, with a stand-in spacesd | Medium | 3 | `computer/cua-host/`: the synchronous steps |
| 5 | The composed stand-in lane over 1–4 | Medium | 2, 4 | The whole table and the mutations |
| 6 | The UI states | Small | 1 | `web/`: a screenshot of each state |

Each stage is its own branch and review. No stage turns on `nativeDesktop`, changes the installer, or makes a service, account or token.
