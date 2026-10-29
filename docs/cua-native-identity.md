# Binding a native-app call to who makes it

`src/cua-native-identity.ts` binds a native-app call (docs/cua-native-mcp.md) to who makes it before anyone is asked to approve it. The binding records the space, agent, conversation, tool task, call and run, the curated tool with a frozen copy of its arguments, and the agent's control lease. It is stored before it is returned. An approval filed after it, or approved automatically, can only be about that exact call. The binding is sent at most once, only when asked to, and only after the call's identity, lease and run are checked again. Every binding is kept, so a spent tool task or call is never bound again.

**Wired, with Pim's own authority, and off.** The desktop's tools (`src/extensions/desktop.ts`, "The space's desktop tools" in docs/cua-native-mcp.md) make a binder per space and use it as "The wiring" below describes. Its authority is `harnessAuthority`, over the run IDs that Pim's local pi-durable patch mints (docs/pi-durable-run-identity.md), and its check and the binder's claim are one harness commit (see "The gap between the authority and the claim"). The tools are on only where `Pim.nativeDesktop()` says so, and Pim's says no: nothing starts the Cua computer that would take their calls, and nothing has been tried against a real one. So no deployment or preview makes a binder, offers the tools or turns `Computer.native` on. Only the tests turn them on. `Computer.native` keeps its guards: it needs a trace that `ControlCoordinator.dispatch` made with a `runId`, it needs the operator's Cua computer, and it makes one call per request. `Computer.call` still refuses `native_tool`.

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

**The missing contract** is a run identity for a tool invocation that the harness publishes and types. Examples are a `ToolExecutionApi.runId`, or a documented, stable ID on `LiveState.run`. It must stay the same across handover, steering, `onYield`, suspension and restart. It must be different for every successor run. It must be readable together with the tool task's status and owner in one transaction. The derivation from §6 and the experimental §9.4 is not an option, whether pinned or tested: only a contract the harness supports publicly will do. docs/pi-durable-run-identity.md describes the smallest such change to pi-durable. **It is in Pim's local patch, not in an upstream release**: the harness mints a run ID when a run starts, stamps it on the run's tool tasks, and `Tx.run` reads it in a commit. Pim's authority (below) relies on that patch, and on nothing derived from §6 or §9.4. Upstream pi-durable is unchanged, so the patch has to be carried, and reviewed again, on every upgrade.

## The authority

`NativeIdentityAuthority.verify(claim)` takes `{ conversationId, toolTaskId, callId }` from the harness's invocation, never from arguments. It answers either `verified` with a `NativeIdentity` (`owner`, `agentId`, `conversationId`, `toolTaskId`, `callId`, `runAnchor`) or `refused` with `missing`, `legacy`, `ambiguous`, `stopped`, `not_run_owned` or `unsupported`. It must answer from one consistent read of committed state. That read must show that the task exists, is live, is the claim's and belongs to the claim's conversation, that its call is the claim's, that the run is still going and owns the task, and that the agent is the one the server records for the conversation. It must refuse anything else, never guess.

**Pim's authority** is `harnessAuthority(tx, { owner, agentOf, deleted })`, reading the transaction the binder writes in. It refuses `missing` for a claim whose conversation or tool task isn't a harness ID, or whose task isn't there; `ambiguous` for a task that isn't a `pi.tool` task of the claim's conversation and call; `stopped` for a task that isn't pending, running or waiting, or is marked for abort, for a conversation with no run, and for a chat Pim has marked deleted; `legacy` for a task without a run ID, or a run without one, both from before the patch; and `not_run_owned` for a task stamped with another run's ID. Otherwise its run anchor is the run's ID as a string, and its agent is the one Pim records for the conversation (`#roleOf`).

The binder accepts only an answer of exactly that shape. Every identity must be 1 to 256 printable ASCII characters without spaces (`NATIVE_IDENTITY`), the owner must be the binder's own space, and the conversation, task and call must be those claimed. Anything else refuses the call unsent. That includes an authority that throws, extra or missing fields, another space, task or call, and a claim with any other field (such as a `runId`). The binder makes up no part of an identity: no run from a call, conversation, task, usage or provider session ID, and no client operation ID.

## Binding and sending

`new NativeIdentityBinder(space, { lease, newId? })` takes the space's own name and a function that returns the agent's current lease, or null while the person has control. It keeps no document. Each operation is given a scope, `{ storage, authority }`, for one transaction: synchronous storage of the document in that transaction, and an authority reading that same transaction. In Pim the transaction is one harness commit (`harnessScope`), and the document is `NativeBindingsDoc`, a Pim-defined harness document. Nothing else is read.

`bind(scope, claim, tool, arguments)`, in one transaction, before an approval is filed:

1. The claim is read, and `readNativeRequest` copies the tool and arguments before anything is awaited. The copy holds only JSON's own values, read as data within `NATIVE_ARGUMENTS_CHARS`, and is frozen: the same copy a native call carries. No getter, `toJSON` or prototype is called or followed. Anything else refuses the call before the authority is asked. The copy's agent and run are a fixed placeholder (`unverified`), which is never stored, sent or compared. So the caller changing its objects while the authority answers changes nothing that is bound.
2. The authority vouches for the claim. The binding combines the vouched identity, with its run anchor as the run, with the copy made in step 1.
3. Everything from here to the write is checked with nothing awaited. A tool task bound before gets its original binding back (`replayed`), including the lease it was bound under. That happens only while it is still `bound`, its identity, tool and arguments are exactly the same, and no call of its run is unknown. Arguments are compared as JSON, so the same keys in another order count as a change. A suspended call woken by its approval, or rerun after a restart, finds its binding this way. A changed call closes the binding (`changed`), and so does an unknown call of its run (`run_uncertain`). A tool task whose binding is spent (dispatched, unknown or closed) is refused and never bound again.
4. A new binding is refused if another tool task of the same run used the same call ID (`ambiguous_call`), even one that is spent. It is also refused if a call of the run has an unknown end (`run_uncertain`), if the person has control (`not_agent_owned`), or if the binder is full (`full`).
5. It is stored (`bound`), and then returned.

`dispatch(transact, bindingId, send)` is called once the approval is decided, or at once for a read. It claims in one transaction (`claim(scope, bindingId)`, steps 1 to 4), sends outside any transaction, and settles in another (`settle`, step 5). It sends only when asked, and nothing in the binder retries it:

1. The binding must be `bound`, and its run must not hold it (see "Runs" below).
2. The authority vouches for it again. A refusal or a changed identity closes the binding. An authority that throws, or answers something that isn't an answer, leaves it `bound` and sends nothing, since that says nothing about the call. A later dispatch, asked for explicitly, goes through every step again: a fresh answer from the authority, the same identity, the same lease, and a run that doesn't hold it.
3. After the authority answers, the binding must still be `bound`, its run must not hold it, and its lease must still be the current one. The authority read the same transaction, so nothing the harness commits can come between its answer and the claim. If the lease isn't current, the binding is closed (`stale_lease`): epochs only grow, so the lease can never be current again.
4. It is stored as `claimed`, without its arguments, and the transaction commits before `send` is called with the frozen binding. A second dispatch, or a replay, finds it `claimed` and sends nothing. A claim that doesn't commit sends nothing.
5. A known outcome (`completed`, `rpc_error` or `rejected`) closes the binding. An `unknown` outcome, an answer `readNativeOutcome` doesn't accept, or a `send` that throws leaves it `unknown` for good. A `ControlRefused` closes it, because the dispatch authority sent nothing, so `send` must throw that only when nothing was sent.

`release(scope, bindingId)` closes a binding that is still `bound`, for example after its approval is denied or its chat stopped.

**Runs.** A run holds a bound call in two cases:

- **A call of the run is `unknown`.** This is a call dispatched in this process or before a restart, of any agent or tool task, that may have run without an answer saying so. The run sends nothing more, and the bound call is closed (`run_uncertain`), whether it is dispatched or replayed. Nothing reopens the run. The check is keyed only on the run anchor, so a run whose calls the authority says are different agents' is latched as a whole.
- **Another call of the run is `claimed`, that is, being sent.** The bound call is refused (`run_busy`) and stays `bound`, to be dispatched again once that call's end is known. One call of a run is out at a time, as the host's run allows (`busy` in docs/cua-native-mcp.md). If that call ends `unknown`, the bound call is then closed. Binding itself sends nothing, so a call may still be bound while another of its run is being sent.

`send` is the caller's. A later change would route it through `ControlCoordinator.dispatch` with the binding's run anchor as `runId`, and then through `Computer.native`. The coordinator stays the dispatch authority, and the binder doesn't bypass it: whatever the binder allows, the coordinator can still refuse. Its stored request IDs and `unknown` status block replays and successors until reconciliation, also after a restart, and its run latch outlives reconciliation. The binder's own guards don't depend on it. They are its tombstones, which are never let go (see below), and its run latch. There is no new run, call or provider to fall back to.

## The gap between the authority and the claim

**Closed in Pim's wiring.** The binder before this change read the authority in one transaction and claimed in its own storage after it. Between the two, the harness could commit anything on its line, for example:

- `Conversation.abort()` ending the run;
- a reset ending it;
- the chat being deleted;
- the tool task being aborted.

That binder would still claim and send a call that the harness, by then, no longer had in a live run. The coordinator doesn't catch this either: `ControlCoordinator.dispatch` checks the space, the lease, the request ID and its own run latch, not whether the harness still has the call in that run. So it was a time-of-check-to-time-of-use gap, and **closing it is a required part of the integration contract, not an improvement**.

**What the wiring does.** The authority's check and the durable native claim are linearized on the harness's commit line, in one `harness.commit` (`Pim.#transact`):

1. The binder's document is a Pim-defined harness document (`NativeBindingsDoc`), not separate storage.
2. In one transaction, it reads the tool task and the run (`tx.task()` and `tx.run()`), checks the binding's status, its run latch and the lease, and writes the binding `claimed`.

Every abort, reset or deletion is a commit on the same line, so each one is ordered entirely before or entirely after that transaction:

- **Before:** the transaction sees the run ended or the task terminal. The binding is closed in that transaction, and nothing is sent.
- **After:** the claim is the commit point, as `fetch` is in the host's client (docs/cua-native-mcp.md). From the claim on, the call is taken as possibly sent. An abort that commits after it ends the run and the tool task as usual, but it can't make the call unsent. The call goes on to the coordinator and the computer, and its outcome is recorded against the binding. That includes `unknown`, which latches the run even though the run has ended. Whatever the person sees about the approval must say it may have run, not that the abort stopped it.

The lease stays the coordinator's to check, because the control state lives in the space's own storage, not the harness's. So the order is:

1. the harness transaction, with identity, run and claim;
2. then, synchronously, `ControlCoordinator.dispatch`, which checks the lease and records the request before anything is sent;
3. then the send.

A takeover between steps 1 and 2 is refused in step 2, with nothing sent. The binding is then closed in a later harness commit. If the process dies before that commit, it restarts `claimed`.

**Racing an approval.** If the chat stops while its approval waits, Pim denies the approval when the call no longer waits (`#waitingCall`). That check is a separate read too, so it doesn't order anything. The harness transaction above does: whichever of the stop and the claim commits first wins, exactly as above. A decision that loses to a stop sends nothing. A stop that loses to a decision doesn't recall the call.

**Restarts.** A binding stored `claimed` comes back `unknown` and latches its run, whether or not the process got as far as the coordinator or the computer. That is conservative: a call that never left can never be sent, and its run admits nothing more. The coordinator, for its part, reads a request it recorded in flight as `unknown`. A crash between the harness claim and the coordinator's admission leaves the coordinator with no record and the binder with `unknown`. That is still fail-closed, because the binder never sends that binding again.

## Storage and its bounds

The document is `{ version: 1, owner, records }`, with records in the order they were bound, each with its status. In Pim it is the text of `NativeBindingsDoc`. Every change is one synchronous write of the whole document into its transaction, made after deciding and before anything is returned or sent, and stored when that transaction commits. The order is:

- **bind:** copy; then in one transaction verify, decide, write `bound`; return;
- **dispatch:** in one transaction check, verify, check again, write `claimed`; send; in another transaction write `closed` or `unknown`.

A crash or a failed commit before `bound` is stored leaves nothing bound, so the call binds again after a restart. A crash after it leaves the binding for the call to find. A binding stored `claimed` that this process isn't sending (`#inFlight`), such as one from before a restart or one whose settlement didn't commit, comes back `unknown` and is written back, since no one can tell whether the call ran.

A write that throws latches the binder for as long as the process lives. Nothing more is written, bound or sent, because the stored and remembered documents may disagree. A restart reads what was stored.

On loading, the document is checked whole: its size, its JSON, its version, its owner, and every record's exact fields, status, identity and lease. A record's tool and arguments are checked through `readNativeRequest`; a `bound` record must have arguments, and any other must have `null`. Repeated binding IDs, tool tasks, and calls within a run are not allowed. A document that fails any check is left as it is, and everything is refused. A document of another version, which is a legacy or a future one, gets the same treatment. Records that were `claimed` come back `unknown` and are written back.

**No binding is ever let go.** A binding that leaves `bound` becomes a tombstone: it keeps its ID, identity, tool, lease and status, and its arguments become `null`. A tombstone is enough to refuse its tool task (`closed`, `dispatched` or `uncertain`) and its call ID within its run (`ambiguous_call`), and an `unknown` one latches its run, all after a restart too. The document holds at most `MAX_NATIVE_BINDINGS` (512) records and `MAX_NATIVE_BINDINGS_CHARS` (1 MiB) of JSON. A binding that would pass either bound is refused (`full`), and nothing is let go to make room. Only a binding whose arguments become `null` frees space, and its tombstone stays. Once the count is reached, the binder binds nothing more. That is deliberate: letting a record go safely would need a retirement contract from the authority proving its tool task and run can never verify again, and there is none.

## The wiring

Every part of the integration is in place, behind `Pim.nativeDesktop()`:

1. An authority for Pim's harness that meets the contract, `harnessAuthority`, over the run IDs of Pim's local pi-durable patch, with its own tests against the real harness (`test/cua-native-authority.test.ts`).
2. The authority's check and the claim in one harness commit (`Pim.#transact`, `harnessScope`), as "The gap between the authority and the claim" describes.
3. A binder per space, made with the Durable Object's name and the coordinator's lease only while the agent owns the computer. The lease is still checked by the coordinator's synchronous admission after the claim.
4. `bind` called inside the tool's call, before `fileApproval` and before `#approvalFiled` can approve it at once. The approval shows and stores the binding's frozen arguments and the binding's ID.
5. `decideApproval` dispatching through the binder, and a denial or a stopped chat calling `release`, each in a harness commit.
6. `#controlled` passing the binding's run anchor as `runId`, and Pim's `Computer` made with `nativeApps` for the operator's Cua computer.

What stays missing is outside the space: a Cua computer started with a native-app dispatcher, and a try against a real spacesd and desktop (docs/cua-native-mcp.md, "Not wired yet").

## Tests

`test/cua-native-identity.test.ts` drives the binder with in-memory storage and a stand-in authority, each operation in its own stand-in transaction. The stand-in models runs as the design document describes them: the generation named in `pi.live.run` owns its tool tasks and hands the run over, steering inputs join the run, and the first input is the anchor. It is not the harness, and it shows only what the binder does given such an authority. The tests cover the following:

- The binding is stored before it is returned, and it is `claimed` in storage when `send` runs.
- Arguments the caller changes while the authority is held (a value changed, a `session` added, `pid` deleted) bind and send the original copy.
- A getter, a `toJSON` on the arguments and a nested `toJSON` are refused without being called, and the authority isn't asked.
- Changing the caller's object afterwards changes nothing that is sent, and a binding is sent once.
- Every authority refusal is refused unsent and nothing is stored, and so are malformed answers, another space, task, call or conversation, a throwing authority, claims with a `runId` or a bad field, uncurated tools, and arguments that aren't JSON's own values or are too large.
- A binding survives suspension and a restart and is sent from the restarted binder.
- A run's anchor stays the same across handover and steering, an unknown end latches the run after a restart too, and a tool task of the generation that handed the run over isn't the run's.
- Run latches:
  - When a call bound beside another of its run ends `unknown`, the other is closed unsent, whether dispatched, replayed, or dispatched after a restart that found the first call without an end.
  - A call whose authority is held while another of its run becomes `unknown` is refused after the authority answers, before sending.
  - A call whose authority answers while another of its run is being sent is refused `run_busy`, stays bound, and is sent once that call's end is known.
  - A run is latched for every agent the authority vouches for in it.
  - A call left bound by a failing authority is sent on a later explicit dispatch, unless another call of its run became `unknown` meanwhile.
- A successor run binds a call ID seen in an earlier run, and a call ID repeated within one run is refused.
- A changed agent, run, tool or arguments, a stopped run or a missing task closes the binding unsent. Another space's binder leaves the document alone.
- A takeover after binding is refused as `stale_lease`, even though a replay returns the original lease.
- A crash before or after the `bound` write, and a crash during a dispatch, behave as described above.
- A failed write latches the binder, and a settlement that can't be stored comes back `unknown`.
- Each kind of answer from `send` settles as described above.
- No binding is let go. At 512 records, closing bindings frees nothing, and new bindings are refused `full`. Tombstones keep `null` arguments and still refuse their tool tasks and call IDs after a restart. With large arguments the size bound is reached first, and a released binding's tombstone frees room while still refusing its task.
- Fifteen malformed stored documents are refused without being changed, including a bound record without arguments and a closed one with them.

`test/cua-native-authority.test.ts` drives Pim's authority and the binder over the real harness with the local patch, its in-memory storage and a scripted model, a suspended tool call standing for one waiting on its approval. It shows that a call binds under the run ID the harness minted and is sent once; that an abort, a reset and a chat's deletion, each committed before the claim, refuse it unsent; that each committed after the claim leaves the call sent once, with its outcome recorded, `unknown` included; that an abort asked for while the claim's transaction runs commits wholly after it; that dispatch checks again, so a run whose ID was removed refuses the call as `legacy` and a later run's binding is never an earlier call's; that a call stored before run IDs and migrated is refused as `legacy`; and that a binding claimed before a restart comes back `unknown` and latches its run, including the run's next call after a tool round, while the next run binds under a new ID. Under deliberate mutations it failed for: no deleted-chat check, no legacy check on the task, no check of a run without an ID, and no claimed-to-unknown on restart.

`test/cua.test.ts` ("its desktop's apps, with Pim's run authority") composes the authority with the rest of the path; docs/cua-native-mcp.md describes it.
