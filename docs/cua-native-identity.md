# Binding a native-app call to who makes it

`src/cua-native-identity.ts` binds a native-app call (docs/cua-native-mcp.md) to who makes it before anyone is asked to approve it. The binding records the space, agent, conversation, tool task, call and run, the curated tool with a frozen copy of its arguments, and the agent's control lease. It is stored before it is returned. An approval filed after it, or approved automatically, can only be about that exact call. The binding is sent at most once, and only after the call's identity and lease are checked again.

**Nothing uses it.** No tool, route, approval, setting or startup code imports the file, and Pim has no identity authority to give it. The harness doesn't publish a run identity that a tool call can be checked against (see "The harness's run"). `Computer.native` keeps its guards: `nativeApps` is off unless given, it needs a trace that `ControlCoordinator.dispatch` made with a `runId`, it needs the operator's Cua computer, and it makes one call per request. `Computer.call` still refuses `native_tool`. `#controlled` in `src/pim.ts` still passes no `runId`, and the stored approvals (`Approval` in `src/store.ts`) and the coordinator's lease bindings are unchanged.

## The harness's run

A native call's run must come from the server's own records, and it must be the same for every call of one run and different for every other run (docs/cua-native-mcp.md, "Runs"). Pim pins `@earendil-works/pi-durable` 1.1.0 and patches it. This is what that version publishes about runs.

**Typed, exported API** (`dist/index.d.ts`, `dist/types.d.ts`, `dist/harness/types.d.ts`, `dist/harness/live.d.ts`, `dist/harness/tool.d.ts`; the package's `exports` map has `.`, `./env`, `./tools`, `./storage/*` and `./testing`, and no `./harness/*`):

| Export | What it says |
| --- | --- |
| `ToolExecutionApi` | `taskId` (the tool task), `conversationId` and `callId`; `commit(tx => …)`, one atomic transaction; `getTask`, `snapshot`, `agent()` (the agent's configuration as the harness resolved it). **No run.** |
| `Tx.task(id)` → `TaskRecord` | `kind`, `conversationId`, `input` (for `pi.tool`, `ToolTaskInput` `{ assistant, callId }`), `owner`: "Owning task of a child task … Immutable.", and `state.status` (`pending`, `running`, `waiting`, `completing`, `terminal`) |
| `LiveDoc`, `LiveState` | `run?: { taskId, inputs }`: "Run control: the task that settles the run's inputs, and those inputs; present exactly while busy." |
| `Tx.doc(token, conversationId)` | A writable `Draft` of a document inside a commit |
| `AgentEvent` `run_start` / `run_end` | Carry `inputs`. The type doesn't say when a run starts or ends. |

**README** (shipped): "`pi.generation` calls the model and owns the `pi.tool` tasks of its tool calls, waits for them, and hands the run to the next generation." A run is "the turns from an input to its final answer". Steers "are placed after the current tool round and join the running work". Follow-ups "start the next run".

**Design document** (not shipped; `packages/durable/docs/spec.md` at tag `v1.1.0` of earendil-works/pi, commit `abe508e1b899`, SHA-256 `9b96626653cd9686fc77393b7e4695b99ba5c8211bea6dfda274b1dd9fcfb846`; the 1.0.0 changelog links to it):

- §6: "`taskId` names the generation that settles the inputs, including while its tool round runs, then the next generation. Tool tasks never own the run … The ID list is mutable state because a boundary adds placed steering inputs to an active run; every terminal path settles exactly the listed inputs."
- §8.3 and §8.5: an `onYield` continuation "hands it `pi.live.run`, keeping the inputs open". After a tool round, "selected steer IDs join `pi.live.run`, and it creates the next generation … and hands it the run".
- §9.4, "Agent events (experimental)": "`run_start`/`run_end`: `pi.live.run` appears, is removed, or is replaced by a successor run whose first input differs. Steers joining the current run and handovers between its tasks are not run events."

**Internals, not used.** `startRun`, `handOver` and `endRun` (`dist/harness/generation.js`, `dist/harness/live.js`) show that a run's inputs start as the inputs that began it, that a handover changes only `taskId`, and that a steering input is appended. These are not exported, and they promise nothing.

**Pim's patch.** `ToolControl.suspend` and `Harness.resumeTask` (`patches/@earendil-works__pi-durable@1.1.0.patch`) suspend a tool call while its approval waits. They are Pim's own and are not part of upstream's API or design document.

### What that establishes, and what's missing

The typed API establishes the parts of a claim: the tool task's ID, its conversation and its call ID. It also establishes that a commit is one transaction, that a task's owner never changes, and that `pi.live.run` names the task controlling the run while the conversation is busy. The run's own identity is not in the typed API. It can be derived only from the design document: §9.4 tells a successor run apart by its first input, and steering and handovers are not run events, so the first input appears to stay fixed for a run. That derivation is not stated as a guarantee. It comes from a section marked experimental, "adds" doesn't say where a steering input goes, and the document isn't shipped or covered by the changelog's breaking changes. Three more things are not established:

- that a tool may read `pi.live` in its own `api.commit()`. `tx.doc(LiveDoc, …)` hands a tool a writable draft of a document that only the harness's reconciliation and handover write;
- that a call suspended by Pim's patch keeps its generation as `run.taskId` for as long as it waits. This follows from §5.5's waits, but the patch is outside the document;
- that `api.agent()` is Pim's agent. It is the harness's agent configuration, while Pim's record of which agent a conversation is comes from its own store (`#roleOf` in `src/pim.ts`).

**The missing contract** is a run identity for a tool invocation that the harness publishes and types. Examples are a `ToolExecutionApi.runId`, or a documented, stable ID on `LiveState.run`. It must stay the same across handover, steering, `onYield`, suspension and restart. It must be different for every successor run. It must be readable together with the tool task's status and owner in one transaction. Without it, Pim's owner would have to accept §6 and §9.4 as that contract explicitly, with the version pinned and a conformance test against the real harness. Until one of these happens, **there is no harness authority**: nothing resolves a real run, and the binder takes its identity only from an authority it is given.

## The authority

`NativeIdentityAuthority.verify(claim)` takes `{ conversationId, toolTaskId, callId }` from the harness's invocation, never from arguments. It answers either `verified` with a `NativeIdentity` (`owner`, `agentId`, `conversationId`, `toolTaskId`, `callId`, `runAnchor`) or `refused` with `missing`, `legacy`, `ambiguous`, `stopped`, `not_run_owned` or `unsupported`. It must answer from one consistent read of committed state. That read must show that the task exists, is live, is the claim's and belongs to the claim's conversation, that its call is the claim's, that the run is still going and owns the task, and that the agent is the one the server records for the conversation. It must refuse anything else, never guess.

The binder accepts only an answer of exactly that shape. Every identity must be 1 to 256 printable ASCII characters without spaces (`NATIVE_IDENTITY`), the owner must be the binder's own space, and the conversation, task and call must be those claimed. Anything else refuses the call unsent. That includes an authority that throws, extra or missing fields, another space, task or call, and a claim with any other field (such as a `runId`). The binder makes up no part of an identity: no run from a call, conversation, task, usage or provider session ID, and no client operation ID.

## Binding and sending

`new NativeIdentityBinder(space, storage, { authority, lease, newId? })` takes the space's own name, synchronous storage of one document, the authority, and a function that returns the agent's current lease, or null while the person has control. Nothing else is read.

`bind(claim, tool, arguments)`, before an approval is filed:

1. The authority vouches for the claim. Nothing of the tool or arguments is read before that.
2. `readNativeRequest` copies the tool and arguments, with the vouched identity and the run anchor as the run. The copy is a frozen copy of JSON's own values within `NATIVE_ARGUMENTS_CHARS`, the same copy that a native call carries.
3. A tool task bound before gets its original binding back (`replayed`), including the lease it was bound under, but only when the identity, tool and arguments are exactly the same. Arguments are compared as JSON, so the same keys in another order count as a change. A suspended call woken by its approval, or rerun after a restart, finds its binding this way. If anything differs, the binding is closed (`changed`). A binding that was already dispatched or closed isn't returned.
4. A new binding is refused if another tool task of the same run used the same call ID (`ambiguous_call`), if a call of the run has an unknown end (`run_uncertain`), or if the person has control (`not_agent_owned`).
5. It is stored (`bound`), and then returned.

`dispatch(bindingId, send)`, once the approval is decided:

1. The binding must be `bound`. The authority vouches for it again. A refusal or a changed identity closes the binding. An authority that throws leaves it bound, since that says nothing about the call.
2. The binding's lease must still be the current one. Otherwise the binding is closed (`stale_lease`): epochs only grow, so it can never be current again.
3. It is stored as `claimed` before `send` is called with the frozen binding. A second dispatch, or a replay, finds it `claimed` and sends nothing.
4. A known outcome (`completed`, `rpc_error` or `rejected`) closes the binding. An `unknown` outcome, an answer `readNativeOutcome` doesn't accept, or a `send` that throws leaves it `unknown` for good, which latches its run. A `ControlRefused` closes it, because the dispatch authority sent nothing. So `send` must throw that only when nothing was sent.

`release(bindingId)` closes a binding that is still `bound`, for example after its approval is denied or its chat stopped.

`send` is the caller's. A later change would route it through `ControlCoordinator.dispatch` with the binding's run anchor as `runId`, and then through `Computer.native`. The coordinator stays the dispatch authority: its stored request IDs and its `unknown` status block replays and successors until reconciliation, also after a restart, and its run latch outlives reconciliation. The binder's latch adds nothing new to that. It refuses only bindings for a run whose call is unknown, and nothing it does reopens a run. There is no new run, call or provider to fall back to.

## Storage and its bounds

The document is `{ version: 1, owner, records }`, with records in the order they were bound, each with its status. Every change is one synchronous write of the whole document, made after deciding and before anything is returned or sent. No await separates the last check from the write. The order is:

- **bind:** verify, copy, decide, write `bound`, return;
- **dispatch:** verify, decide, write `claimed`, send, write `closed` or `unknown`.

A crash before the `bound` write leaves nothing bound, so the call binds again after a restart. A crash after it leaves the binding for the call to find. A crash after `claimed` comes back `unknown`, since no one can tell whether the call ran.

A write that fails latches the binder for as long as the process lives. Nothing more is written, bound or sent, because the stored and remembered documents may disagree. A restart reads what was stored.

On loading, the document is checked whole: its size, its JSON, its version, its owner, every record's exact fields, statuses, identities and lease, and its tool and arguments through `readNativeRequest`. Repeated binding IDs, tool tasks, and calls within a run are not allowed. A document that fails any check is left as it is, and everything is refused. A document of another version, which is a legacy or a future one, gets the same treatment. Records that were `claimed` come back `unknown` and are written back.

At most `MAX_NATIVE_BINDINGS` (64) bindings and `MAX_NATIVE_BINDINGS_CHARS` (1 MiB) of JSON are kept. To make room, the oldest **closed** binding is let go. A `bound`, `claimed` or `unknown` binding is never let go, so when only those would fit, a new binding is refused (`full`). A call ID repeated within a run is refused only while the earlier binding is remembered. Across all time, the coordinator's request IDs are what keep a request from being sent twice.

## What a wiring change would need

This is for a separate, reviewed change, after the harness's run is settled as above:

1. An authority for Pim's harness that meets the contract, with its own tests against the real harness.
2. A binder per space, made with the Durable Object's name, its own storage key, and the coordinator's lease only while the agent owns the computer.
3. `bind` called inside the tool's call, before `fileApproval` and before `#approvalFiled` can approve it at once. The approval then shows and stores the binding's frozen arguments and the binding's ID.
4. `decideApproval` dispatching through `binder.dispatch`, and a denial or a stopped chat calling `release`.
5. `#controlled` passing the binding's run anchor as `runId`, and Pim's `Computer` made with `nativeApps` for the operator's Cua computer.

## Tests

`test/cua-native-identity.test.ts` drives the binder with in-memory storage and a stand-in authority. The stand-in models runs as the design document describes them: the generation named in `pi.live.run` owns its tool tasks and hands the run over, steering inputs join the run, and the first input is the anchor. It is not the harness, and it shows only what the binder does given such an authority. The tests cover the following:

- The arguments aren't read before the authority vouches for the call.
- The binding is stored before it is returned, and it is `claimed` in storage when `send` runs.
- Changing the caller's object afterwards changes nothing that is sent, and a binding is sent once.
- Every authority refusal is refused unsent and nothing is stored, and so are malformed answers, another space, task, call or conversation, a throwing authority, claims with a `runId` or a bad field, uncurated tools, and arguments that aren't JSON's own values or are too large.
- A binding survives suspension and a restart and is sent from the restarted binder.
- A run's anchor stays the same across handover and steering, an unknown end latches the run after a restart too, and a tool task of the generation that handed the run over isn't the run's.
- A successor run binds a call ID seen in an earlier run, and a call ID repeated within one run is refused.
- A changed agent, run, tool or arguments, a stopped run or a missing task closes the binding unsent. Another space's binder leaves the document alone.
- A takeover after binding is refused as `stale_lease`, even though a replay returns the original lease.
- A crash before or after the `bound` write, and a crash during a dispatch, behave as described above.
- A failed write latches the binder, and a settlement that can't be stored comes back `unknown`.
- Each kind of answer from `send` settles as described above.
- The bounds hold: only closed bindings are let go, and large arguments reach the size bound first.
- Thirteen malformed stored documents are refused without being changed.

**These tests haven't been run.** They were written with this change, and no test, typecheck or build was run for it.
