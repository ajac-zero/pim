# Native-app calls through the bridge's broker: the acknowledged-fence protocol (spec and plan; not implemented)

**Status: specification for review. Nothing here is implemented, accepted or active.** Groves chose acknowledged remote fencing as the direction for native-app calls in the protected-account design (`docs/cua-native-host-plan.md`). Two directions were rejected: a prepare-then-irrevocable-`go` dispatch, and asynchronous revocation (see the plan's record). Pim's `nativeDesktop()` stays false. **Human takeover is unavailable, and nothing here is a takeover or quiescence claim.**

## The contract

- **Local admission closes immediately.** Stop and Delete close the scope's local admission in Pim when they are asked, and before they answer. From then on, Pim records no new native intent and sends no `native.execute` in that scope. This is permanent: a closed scope never reopens (no resurrection).
- **Two separate things are reported.** One is that the chat is stopped or deleted locally. The other is that the desktop has confirmed the fence.
- **A confirmed fence means exactly this:** every broker instance that Pim ever handed a call in that scope has acknowledged that it will make no further upstream send in the scope.
- **It does not cover:**
  - input already sent to spacesd, which may still act;
  - calls Pim records as `unknown`;
  - any process on the desktop;
  - the person's control of the display.
- **No false success.** If the VM or an instance is unavailable, the fence stays unconfirmed, or is reported `unconfirmed` past its bound. It never becomes confirmed by time passing, a new instance, or Pim's own local close.
- **What is preserved from today:**
  - Deleting still hides the chat (`deleted_at`, `store.deleteSession`) and aborts it as now.
  - Stop still aborts the harness conversation (`POST /sessions/:session/abort`).
  - The binder's tombstones and run latches are kept, never released.

**Previous semantics vs added ones.** Today Stop and Delete are local only:
- the harness aborts the conversation, and Delete hides the chat;
- the binder and the send gate refuse a call that hasn't left (`docs/cua-native-identity.md`);
- nothing is said about the desktop.

This protocol adds a remote statement, reported separately and possibly never confirmed. It takes nothing from the local semantics.

## A correction to earlier claims

The accepted send gate (`#desktopSend` in `src/pim.ts`, accepted at `b347372`) is a **local** qualification. It reads the authority in a harness commit, then reads Pim's deletion and agent records synchronously and calls `transmit()` inside that commit's callback, before the commit resolves. The coordinator's admission is written before the send in program order, and its durability is not awaited before the socket send.
- **What its tests showed:** the order of reads against store writes queued in its awaits, in workerd with stand-ins.
- **What they didn't show:** that any record is durable before the message leaves, or anything about a remote executor.

`docs/cua-native-host-plan.md` at `023a068` said protocol B put "the authority's commit at the broker's send". It also treated recording a call inside the transaction callback as its durable commit. **Both are withdrawn.** A callback's return is not a durable commit. Cloudflare documents output gates for Durable Object storage, but nothing here verified that they hold this WebSocket send behind the harness's and coordinator's writes, so this protocol doesn't rely on them: it **awaits** the durability of each record that must precede a message.

## Parties and trust boundaries

| Party | Account | Trusted for | Not trusted for |
| --- | --- | --- | --- |
| Pim (the space's Durable Object) | Cloudflare | Authority: intents, scopes, fences, the durable record | Anything on the VM |
| The link | TLS through Caddy to the bridge, the bridge's bearer, `x-pim-space` | Authenticity and order of messages within one connection | Delivery across connections; a lost message is lost |
| The bridge and broker | `pim-bridge` | Executing only what Pim sent it, latching fences, reporting truthfully | Durability: its memory dies with its process |
| pim-computer | `pim-desktop` | Its ordinary ops | Anything native. The demux drops every `native.*` message from its side and ends the session |
| spacesd | `pim-spacesd` | Running the curated tool it is sent | Deduplication, cancellation, or reporting when input lands |

The broker is reached only through the bridge's link, from Pim's side. No desktop-owned socket or child takes part.

## Identifiers

- `owner`, `agentId`, `runId` (the harness-minted run ID), `conversationId` and `requestId` (`call:…` or `approval:…`, the coordinator's): each matches `NATIVE_IDENTITY`, as Pim's records hold them. None comes from a model, and none is ever re-minted to replace another.
- `instance`: 128 bits from a CSPRNG, drawn by the broker at process start and never stored or reused, written as 22 characters of base64url.
- `epoch`: the coordinator's control epoch, which already advances on every ownership change.
- `fenceId`: 128 random bits, minted by Pim with the fence record.
- `argsSha256`: SHA-256 of the arguments' canonical JSON (`canonical` in `native-mcp.ts`).

## Messages

Every message is one JSON object with exactly the listed keys, at most `NATIVE_ARGUMENTS_CHARS` plus 4 KiB long. Any other shape is refused with a fixed reason and changes no state. The broker sends `native.*` only to Pim's side, and the demux drops any `native.*` from pim-computer's side and ends that session.

| Message | Direction | Keys | Meaning |
| --- | --- | --- | --- |
| `native.hello` | broker → Pim, first on each connection | `v: 1`, `instance` | The broker is present, and which instance this is. Pim sends no `native.execute` to a connection without it |
| `native.execute` | Pim → broker | `v`, `requestId`, `owner`, `agentId`, `runId`, `conversationId`, `epoch`, `instance`, `tool`, `arguments`, `argsSha256`, `boundMs` | The one action message. It is never re-sent. `boundMs` is at most 60,000, measured by the broker from receipt |
| `native.result` | broker → Pim | `v`, `requestId`, `instance`, `outcome` (a `NativeOutcome`), `sent` (boolean) | The outcome. `sent: false` only when the broker refused before handing the call to `fetch` |
| `native.fence` | Pim → broker | `v`, `fenceId`, `instance`, `scope` (`{ kind: "conversation", conversationId }`, `{ kind: "run", runId }`, `{ kind: "agent", agentId }` or `{ kind: "epoch", epoch }`) | Latch the scope. It is idempotent and may be re-sent; re-sending is a status request, not an action |
| `native.fenced` | broker → Pim | `v`, `fenceId`, `instance`, `scope`, `sent` (request IDs it handed to `fetch` in scope), `refused` (request IDs it refused unsent in scope) | Sent only after the latch is set. Every `native.fence` for the same `fenceId` gets the same answer |

There are no other phases. Status of an action is never asked by re-sending it.

## Pim's side

### Records (durable, in Pim's store)

- **Native intent**, keyed by `requestId`: every field of `native.execute`, frozen, plus `state`.
  - `intended`: written and its durability awaited before any `native.execute` exists.
  - `refused`: the broker said `sent: false`, or Pim knows it never transmitted.
  - `completed`: a valid `native.result` with `sent: true`.
  - `unknown`: anything else.

  `refused`, `completed` and `unknown` are final, and `unknown` latches the run in the binder and the coordinator, as today. Final means the call's outcome never changes; an `unknown` call still counts as outstanding for fences.
- **Scope closure**, keyed by scope: written in the same synchronous store write as the change that closes it (a chat's `deleted_at`, a stop, an agent change, an epoch change). Every intent check reads it.
- **Fence**, keyed by `fenceId`, with its scope and the set of instances that must acknowledge it.
  - **Who must acknowledge:** every instance named by an intent in the scope that is `intended` or `unknown`. `unknown` counts: Pim settles a call `unknown` when its own wait ends, but the broker measures `boundMs` from receipt, so a delayed execute can still be sent after Pim gave up on it.
  - **States:** `pending`, `confirmed` (every required acknowledgment durably recorded) or `unconfirmed` (past its bound, or a required instance is no longer the one connected).
  - **Not needed:** a scope with no `intended` or `unknown` intent needs no fence, and none is recorded. Nothing in it is outstanding at any broker, and the local closure stops new executes.
  - **Late confirmation:** an `unconfirmed` fence can become `confirmed` only if its own missing instances acknowledge it later.

### A call's path, with every await

1. **Binding and approval**, as today.
2. **The authority:** Pim's run authority reads the call's tool task and run in a harness commit (awaited), as in `#desktopSend` today. The coordinator admits the request (synchronous write).
3. **Synchronous re-read, then the intent:** Pim reads the chat's deletion, its agent, the scope closures for the conversation, run, agent and epoch, and the connection's `instance`. If all pass, it writes the intent `intended` in the same synchronous step.
4. **Await the intent's durability** (the store's sync). No `native.execute` exists yet.
5. **Synchronous re-read of the closures, then transmit:** if any scope closed during step 4, the intent becomes `refused` (Pim knows it never transmitted) and nothing is sent. Otherwise `native.execute` is transmitted on the current connection, with nothing awaited between the re-read and the send.
6. **Await the result**, bounded by `boundMs` plus transit. A valid `native.result` settles the intent `completed`, or `refused` if `sent: false`. Anything else (none, malformed, another instance, a closed connection) settles it `unknown`.

There is no cross-store transaction. The harness's records, Pim's store and the coordinator's state are read in an order, and each later step re-reads what an earlier await could have let change.

### Stop, Delete, and agent or epoch changes

1. **One synchronous write closes the local scope** with the change itself: `deleted_at` and the conversation closure; a stop and the run closures of the conversation's live runs; an agent change and the agent closure; an epoch change and the epoch closure. It also records a fence `pending` with its required instances, unless the scope has no intents. **Local admission is closed from this write on.**
2. **The route answers after that write is durable** (awaited), with the local result and the fence's ID and state. It doesn't wait for the desktop. Then, as today: the harness abort, task cancellation and the rest, each awaited in order.
3. **In the background**, Pim sends `native.fence` to the current connection, and again on every reconnect while the fence is `pending`. Re-sending is idempotent.
4. **On `native.fenced` from a required instance,** Pim checks the fence ID, instance and scope, then records the acknowledgment durably (awaited) before counting it. For each request it lists, `refused` settles an `intended` intent `refused`, and is recorded beside an `unknown` one as evidence without changing it; `sent` settles nothing (it stays `intended` until a result, or `unknown`). A listed request Pim has no intent for is a protocol error and marks the fence `unconfirmed`.
5. **When every required instance has acknowledged, durably,** the fence is `confirmed`.
6. **At its bound** (proposed: 2 minutes from the close, kept while the VM is reachable), or as soon as a required instance is not the instance connected, a `pending` fence becomes `unconfirmed`. It goes on accepting late acknowledgments from its own instances.

**A new instance proves nothing about an old one.** A `native.hello` with another instance ID shows that a different process answers. It doesn't show that the old process has stopped, or that its calls already sent have finished or been dropped by spacesd. So:
- a fence that needs an old instance's acknowledgment stays `unconfirmed` until that instance itself answers;
- no rule clears it optimistically;
- a new instance isn't asked to acknowledge, because it refuses every execute naming another instance and so holds nothing in the scope.

## The broker's side

### State (in memory, per instance, bounded)

- **Received request IDs:** every `requestId` it accepted, at most 10,000 per instance. Past that it refuses new executes (`unavailable`, `sent: false`).
- **Latches:** scopes it has latched, at most 1,000. Past that it latches the whole space and refuses every execute from then on.
- **Calls in progress:** at most one per run (`busy`, as today) and `MAX_RUNS` (256) runs.
- **Run latches:** for runs whose call ended `unknown`, as `createNativeDispatcher` keeps them.

**No durable journal is needed for the acknowledgment's meaning,** because an acknowledgment speaks only for its own instance and is valid only while that process lives:
- Its claim, "this instance will make no further upstream send in the scope", holds while the process lives, because the latch is checked at every send.
- It also holds after the process dies, because a dead process sends nothing, and no later instance accepts an execute naming it.
- If the process were stopped and resumed rather than restarted, it keeps its memory, and the latch with it.

What a crash loses is the ability to acknowledge again. A fence whose acknowledgment Pim hadn't recorded before the crash stays `unconfirmed`, as above. A journal would let a restarted process repeat its predecessor's acknowledgment, but it couldn't vouch for what that predecessor did after its last write, so it isn't proposed.

### One serialized queue per space

Run setup (`initialize`, `notifications/initialized`, `tools/list`) is awaited outside the queue. Two steps happen inside it, each synchronous and never interleaved:

- **The send step** for a call whose setup has finished:
  - check that its `instance` is this one;
  - check that `boundMs` hasn't passed since receipt;
  - check that no latch covers its conversation, run, agent, epoch or the space;
  - check that its request ID isn't consumed.

  Then it marks the call consumed and hands the `tools/call` to `fetch`, with no await before the handoff. A failed check refuses it with `sent: false`.
- **The fence step:** set the latch, then build `sent` and `refused` for the scope from the received set, then send `native.fenced`. **The latch is set before the acknowledgment exists.** Any call in that scope that is still in setup, or arrives later, finds the latch at its send step, and is refused.

So within one instance, every send and fence has one place in the queue. A send before the fence's place may have run, and nothing in the scope is sent after it. **This order is the broker's, not Pim's:** Pim's local close can come before a send that the broker's queue places before the fence. That send is what `sent` lists. **The protocol doesn't claim that Pim's committed close forbids a remote send under an execute already handed over.**

## Crashes, losses and replay

| Event | What Pim records | Why |
| --- | --- | --- |
| Pim ends after the intent is durable, before transmit | `unknown` | It can't prove the message didn't leave |
| Pim ends after transmit | `unknown` | |
| `native.execute` lost (connection closed) | `unknown` | No result arrives on a new connection. The action is never re-sent |
| The broker ends after receipt, before `fetch` | `unknown` | A new instance can't say what the old one did |
| The broker ends after `fetch` | `unknown` | |
| Result lost | `unknown` | A late result changes nothing, as today |
| `native.fenced` lost | Fence `pending`, then re-sent | A fence re-send is a status request: the same instance answers from its latch |
| `native.fenced` lost and the instance ended | Fence `unconfirmed` | Its acknowledgment can't be obtained |
| Pim settled a call `unknown` by its timeout, and the delayed execute reaches the broker later | Stays `unknown`. The fence still requires that instance | The broker's bound starts at receipt |
| Pim's durable write of an acknowledgment fails | Not counted. The fence stays `pending` or `unconfirmed`, and is re-sent | Only a durable acknowledgment counts |
| Old and new broker both alive | Each instance acknowledges for itself, and a missing old one leaves the fence `unconfirmed` | No clearance by succession |

**No replay:**
- No `native.execute` is ever sent twice.
- A request ID, run ID or identity is never re-minted to escape `unknown`.
- A closed scope blocks every future call in its conversation, run, agent or epoch, permanently.

**Re-sending a fence** is the only re-sent message. It changes nothing but the latch it repeats. **Expiry never proves absence:** `boundMs` passing at the broker refuses a call it hadn't sent and says so, but Pim's own timers never turn `unknown` into `refused`.

## Retention

- **Pim:** intents until final and their fences confirmed, then compacted to a tombstone (request ID, state). `unknown` intents, scope closures and fences are kept indefinitely, like the binder's tombstones. Growth is bounded by the space's chats, runs and calls.
- **The broker:** the bounds above. Saturation fails closed (refuse, or latch the space), never open.

## What the person sees, and the API

| State | Chat or Settings line | API |
| --- | --- | --- |
| No `intended` or `unknown` intent in scope | Nothing about the desktop | `desktopFence: null` |
| Stopped or deleted, fence pending | "Stopped. Making sure the desktop takes no further actions from this chat…" | `desktopFence: { id, state: "pending" }` |
| Confirmed | "The desktop confirmed it will take no further actions from this chat. Actions it already took may still finish." | `state: "confirmed"` |
| Unconfirmed | "Stopped here, but the desktop didn't confirm. Pim sends nothing more; actions already sent may still run, and other programs on the desktop aren't affected." | `state: "unconfirmed"` |
| A call `unknown` | "This action may have run." Never "cancelled" | The intent's `state: "unknown"` |

- **The routes answer after the local change is durable:** `DELETE /sessions/:session` and `POST /sessions/:session/abort`, each with `desktopFence`. They never wait for the desktop.
- **A fence is read by its ID,** through `GET /computer/native/fences/:id` (owner only). That works for a deleted chat too, and returns only the scope's kind, the state and counts, nothing of the chat, so the chat stays hidden.
- **The wording never says "safe" or "taken over",** or anything about the desktop beyond the broker's sends.

## Not assumed

No new driver capability, no grant beyond the protected-account plan's open decisions, no takeover, and no cancellation of input spacesd already took.

## Test plan (not written, not run)

Each row is a test to write against stand-ins: Pim in workerd with a scripted bridge and broker, and the broker in-process with a stand-in spacesd. Nothing here can be run before the code exists.

| Case | Expected |
| --- | --- |
| Setup held, then Delete, then setup finishes | Broker refuses at the send step (`sent: false`). The fence lists the call as `refused`, and the intent ends `refused` |
| Wake or transit held, then Stop | Either the closure is found at step 5 (`refused`, nothing transmitted), or the execute is out and the fence orders it |
| Send before the fence in the broker's queue | `fenced.sent` lists it, and the intent stays `unknown` or `completed` by its result. Never `refused` |
| Fence before the send | Refused at the send step. No `fetch` call reaches the stand-in |
| A deletion, an agent change and an abort, each racing a call | Each closes its scope, and later intents in the scope are refused locally |
| `native.execute` lost | `unknown`, the run latched, no re-send, no new ID |
| Result lost | `unknown`. A late result changes nothing |
| `native.fenced` lost | `pending`, then a re-send answered from the latch, then `confirmed` |
| Pim fails to commit the intent | Nothing transmitted. The call is `ControlRefused` before sending |
| Pim fails to commit the acknowledgment | Not counted, and re-sent later |
| Pim restarts between the durable intent and transmit | `unknown`, not `refused` |
| The broker restarts with a call in setup | `unknown`. The new instance refuses an execute naming the old one. A fence needing the old instance is `unconfirmed` |
| Old and new broker both answering | Each acknowledges for itself. A fence needing the silent old one stays `unconfirmed` |
| VM unavailable at Stop | The route answers locally. The fence is `pending`, then `unconfirmed`. Never `confirmed` |
| Duplicate `native.fenced`; duplicate or late `native.result` | Idempotent. No state moves backward |
| Malformed, wrong-version, wrong-instance or unknown-fence messages | Refused with fixed reasons, no state change |
| A `native.*` message from pim-computer's side | Dropped and the session ended. Pim sees nothing of it |
| A closed scope, any later call | Refused locally. No intent, no transmit |
| Saturated broker bounds | Executes refused, or the space latched. Fences still acknowledged |
| UI and API wording | No "cancelled" for `unknown`, no "confirmed" without durable acknowledgments, and the routes answer without waiting for the desktop |

Mutations each must fail:
- no latch before the acknowledgment;
- a send step that awaits after its checks;
- a re-sent execute;
- a new instance clearing an old instance's fence;
- `unknown` settled `refused` by a timer or by a fence's `refused` list;
- a fence's required set that leaves out `unknown` intents;
- an acknowledgment counted before it is durable;
- a closure written after the route answers.

## Acceptance gates

1. This spec reviewed and accepted, with the message schemas and state transitions as written, or as amended.
2. The protected-account placement's upstream facts verified on a disposable VM under separate authorization: X11, accessibility and the input paths from `pim-spacesd`.
3. Each implementation stage below passes its focused stand-in tests and mutations, and an independent review of its boundary.
4. A composed stand-in run of Pim, the relay with its demux, the broker and a stand-in spacesd passes the whole table above.
5. Only then a separately authorized live qualification. Native calls stay off until a decision after it.

## Implementation plan (staged; nothing started)

| Stage | Scope | Size | Depends on | Review boundary |
| --- | --- | --- | --- | --- |
| 1 | Pim's records (intents, closures, fences), the closures in Stop, Delete and agent and epoch changes, the API's `desktopFence` and the fence route, behind `nativeDesktop` | Medium to large | Gate 1 | Pim's store and routes. Reviewer checks durability awaits and no-resurrection |
| 2 | The call path's steps 2–6 against a scripted bridge in workerd, replacing the gate's in-callback transmit for brokered calls | Medium | 1 | `#desktopSend` and `Computer.native`'s link |
| 3 | The relay's demux and `native.hello` (`computer/cua-bridge.ts`, `host.ts`) | Small to medium | Gate 1 | The internet-facing bridge. Reviewer checks parsing limits and drop-and-end |
| 4 | The broker: queue, latches, bounds, around `createNativeDispatcher`, with a stand-in spacesd | Medium | 3 | `computer/cua-host/`. Reviewer checks the synchronous send and fence steps |
| 5 | The composed stand-in lane over 1–4 | Medium | 2, 4 | Whole table; mutations |
| 6 | The UI states | Small | 1 | `web/`. Screenshots of each state, wording as above |

Each stage is its own branch and review. No stage turns on `nativeDesktop`, changes the installer, or makes a service, account or token.
