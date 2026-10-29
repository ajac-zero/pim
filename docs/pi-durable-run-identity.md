# Proposal: an authoritative run identity in pi-durable

**Implemented locally, not upstream.** Pim's own patch of pi-durable 1.1.0 (`patches/@earendil-works__pi-durable@1.1.0.patch`, applied by pnpm's `patchedDependencies`) carries the change below; see "The local patch". Nothing is published or sent upstream. The native-call binder (docs/cua-native-identity.md) needs a run identity the harness publishes and types, and pi-durable 1.1.0 has none. Its README defines a run, its design document mentions one only through events, and `pi.live.run` names a run's controlling task and inputs but not the run itself. The first-input derivation from that document's experimental §9.4 remains unaccepted, and nothing below relies on it.

The change below is the smallest one that lets Pim check, in one transaction, that a tool call belongs to the run that is going now and has belonged to it since it was created. It adds one ID type, one field each on two records, and one read. An upstream release with the same contract would replace the local patch.

## The change

```ts
// types.ts
/** One run of one conversation, minted by the Session; never reused. */
export type RunId = Id<"run">;

export interface Tx {
	// ...as now, plus:
	/**
	 * The conversation's active run as this transaction reads it, or undefined while it is idle.
	 * `id` is null for a run that began before run IDs. Read-only: it creates and writes nothing.
	 */
	run(conversationId: ConversationId): Promise<Readonly<{ id: RunId | null; taskId: TaskId }> | undefined>;
}

// harness/live.ts
export type LiveState = {
	run?: {
		/** The run's identity. Absent only on a run that began before run IDs, and never filled in. */
		id?: RunId;
		taskId: TaskId;
		inputs: SubmissionId[];
	};
	// ...generation, tools and compactions as now
};

// harness/tool.ts
export type ToolTaskInput = {
	assistant: EntryId;
	callId: string;
	/** The run whose generation created this call, copied from `pi.live.run.id` in the creating commit. Absent on calls created before run IDs. Immutable. */
	runId?: RunId;
};
```

Nothing else changes. There is no run ID on `ToolExecutionApi` (a tool reads its own task through `api.commit` and `tx.task(api.taskId)`), no field on events, no way to submit, look up or list runs by ID, and no parameter anywhere that takes a run ID. `pi.live` stays version 1 because the field is optional, and `pi.tool`'s definition version goes up by one, with a `migrate` that leaves `runId` absent.

## The contract

These would be added to the design document, §6 and §8, and covered by its conformance tests.

**Minting.** A run ID is minted with `Storage.mintId()`, from the one global numeric namespace whose IDs are never reused after a committed write (§1, invariant 5, and §10). It happens only in the commit that starts a run. That is the commit that gives `pi.live.run` new inputs, as distinct from handing an existing run over or adding to it. Every path through which a run starts is one of these:

- an input placed in an idle conversation with an empty inbox;
- a `final` boundary that selects user items, after an answer, `terminate` or `handoff`;
- a `postTools` boundary whose reset ends the run and whose selected user items start a successor;
- the boundary that places queued items after a failed run.

It is never derived from, or equal by construction to, a submission ID, a request ID, a call ID, an entry, a task, a provider session or anything a caller, a tool or a model passes. No API accepts one.

**Ownership.** The run's ID belongs to run control in `pi.live`. Only the commit that starts a run writes it. Handover, reconciliation, faults and orphaning never write it, and no path puts a removed run's ID back. A `pi.tool` task gets `runId` from `pi.live.run.id` in the commit that creates it. That is the generation's `tools` commit, or for a sequential round the commit that creates each later call. After that, a task's input changes only through its own definition's `migrate` (§5.1). `pi.tool`'s `migrate` must keep a `runId` exactly as it is, and must never add one.

**What keeps a run's ID.** The same ID stays in `pi.live.run` and every tool task the run creates, through:

- handover to the next generation after a tool round (§8.5);
- steering inputs joining the run;
- an `onYield` continuation, which keeps the inputs open (§8.3);
- generation retries, polls and blocking compactions;
- a tool call suspended on no task and woken with `resumeTask()` (Pim's patch, which would need the same rule);
- an abort mark that hasn't yet ended the run;
- a process ending, open-time reconciliation, and task migration.

**What ends it.** Every path that removes `run` (`endRun`) ends the ID for good. That includes an answer, `terminate`, `handoff`, failure, a run task's abort handler, a fault or orphan, and a reset that ends the run. The next run of that conversation gets a new ID, as does every child or forked conversation's run. A fork starts with `pi.live` empty, by its `initial` fork policy.

**The atomic read.** In one transaction, `tx.task(id)` and `tx.run(conversationId)` read the same committed state. A tool call belongs to the run going now exactly when all of these hold:

- the task's kind is `pi.tool`, its conversation is the one claimed, and its status is `pending`, `running` or `waiting`;
- its `input.runId` is present;
- `tx.run(conversationId)` is defined, and its `id` is not null and equals `input.runId`.

Because the task's run is fixed when it is made, a call of an earlier run never matches a later one. That includes a later run with the same call ID, or one whose first input is the same submission. No owner or generation check is needed.

**Legacy, fail closed.** A run begun before the upgrade has no ID until it ends, and `tx.run()` reports `id: null`. A tool task created before the upgrade has no `runId`. Neither is ever back-filled: `pi.live` gets no migration, and the `pi.tool` migration leaves `runId` absent. A consumer that needs a run must refuse both.

**Submissions and operations.** None of these ever mints or changes a run ID except as above:

- A `requestId` seen before returns its submission before any write, so it mints nothing and moves nothing.
- A steer joins the current run, and keeps its ID. A follow-up starts a successor at a `final` boundary, with a new ID.
- Writes (including compaction summaries and display-only entries) never start or keep a run. A reset head write that ends a run ends its ID.
- Withdrawing a queued submission changes no run.
- `Conversation.abort()` ends the run and its ID, and the next input starts another.
- `abortTask()` on one tool task ends that task only. Its run and the run's other calls keep their ID.
- `retryTask()` on a task parked by the restart limit changes no run.

## How Pim's approvals use it

Pim's identity authority (`harnessAuthority`, docs/cua-native-identity.md, "The authority") reads the call in one harness commit (`Pim.#transact`, a `harness.commit(tx => …)` in which the binder's document is a Pim-defined harness document, `NativeBindingsDoc`). It reads `tx.task(toolTaskId)` and `tx.run(conversationId)`, applies the rule above, and vouches with `runAnchor` set to the run ID as a string. The agent comes from Pim's own store, as before. It refuses a legacy run or call as `legacy`, a run that ended, a terminal or aborting task or a deleted chat as `stopped`, and a different run as `not_run_owned`. The desktop's tools that use it are on only in tests (`Pim.nativeDesktop`).

- **When the call asks.** The native agent tool binds the call (`bind`) inside its own call, before `fileApproval`. That means before `#approvalFiled` can approve it at once, for a tool the person lets run without asking. The approval stores the binding's ID and shows the binding's frozen arguments.
- **When the approval is decided** in `decideApproval`, outside the tool's call, `dispatch` asks the authority again. The call must still be a live task of the same run. Normally it is `waiting` on no task, suspended. It is `running` when the decision is made in the call's own turn. The same transaction claims the binding. Then the coordinator admits the request against the lease, the call is sent, and the decision wakes the call. If the run ended while the approval waited (the chat stopped, was reset or was deleted) and that commit came first, the transaction sees it, closes the binding, and nothing is sent. Pim's own check that the call still waits (`#waitingCall`) is a separate read and orders nothing.
- **The check and the claim are one transaction. This is required.** The binder before this change stored its document apart from the harness, so an abort, a reset or a deletion could commit between the authority's read and the claim, and the binder would still send. The coordinator doesn't close that gap, because it checks the lease and its own records, not whether the harness still has the call in that run. Now the read and the durable claim are one `harness.commit`. The harness's commit line orders every abort, reset and deletion entirely before the claim, which refuses it and sends nothing, or entirely after, which can't make the call unsent and leaves its outcome, possibly `unknown`, with the binding. The coordinator's synchronous admission then checks the lease, before anything is sent. A restart turns a stored claim into `unknown`, whether or not anything left. This needs nothing more from the harness than the read above and an ordinary commit that writes a Pim-defined document. docs/cua-native-identity.md ("The gap between the authority and the claim") gives the full ordering, and `test/cua-native-authority.test.ts` tests it.

## Why replaying a tool can't repeat a native effect

- The agent tool must be `replay: "safe"`, because only such a tool may suspend. Its `execute` never acts itself, though: it binds, files the approval, suspends, and when woken returns the decided outcome. The effect happens only in `dispatch`, which takes a `bound` binding only and stores it `claimed` before `send`.
- When the harness reruns `execute`, after recovery or when woken, the call binds again with the same task, run and arguments. The `execute` checkpoint stores the arguments as of the intent commit, and `prepareArguments` runs again only before that. A binding still `bound` is returned unchanged; one that is `claimed`, `unknown` or `closed` is refused. On a restart, `claimed` comes back as `unknown`. So the rerun gets back the outcome or the uncertainty, never a second send, even when the call was approved in its own turn and the process died mid-send.
- A run ID doesn't let a call be sent again. A rerun is the same task in the same run, and nothing mints a new one for it. A successor run has a new ID, but the earlier call's task keeps its own run's ID, so it can't be bound under the new one. The binder never lets a binding go, and the coordinator's request IDs and run latch remain the dispatch authority's own guards.

## What the upstream change should test

- One ID minted per run start on each path above, all distinct.
- The same ID kept across handover, steering, `onYield`, retries, suspension and `resumeTask`, a restart with a call suspended and one running, and task migration.
- A new ID after every way a run ends, and none put back.
- `requestId` dedup, withdrawals, writes and `abortTask` on one call minting nothing.
- `tx.run()` and `tx.task()` agreeing within one transaction while another commit moves the run on.
- Legacy runs and calls reporting `null` or absent, never filled in.
- Forks and child conversations starting with no run.

## The local patch

The patch edits the published `dist` files, as Pim's earlier changes to this package do (`resumeTask` and suspension):

- `dist/session/transaction.js`: `Tx.run(conversationId)`, which reads `pi.live` read-only: this transaction's draft if it acquired one, otherwise the committed document through the transaction's host, with no draft staged. `mintRunId()`, an internal method that mints from `Storage.mintId()`. The run document is registered by `dist/harness/live.js` (`registerRunDocument`), so the session layer imports nothing of the harness.
- `dist/harness/generation.js`: `startRun` mints the ID, the only place one is minted. `createToolTask` copies `pi.live.run.id` into `ToolTaskInput.runId`, only while the creating generation holds run control in that commit, so a call can't take another run's ID.
- `dist/harness/tool.js`: `pi.tool` version 2, whose `migrate` returns the input as it is: a version-1 call has no run ID, and none is added.
- The `.d.ts` files: `RunId`, `Tx.run`, `LiveState.run.id` and `ToolTaskInput.runId`, as above. Source maps are not updated.

The same patch also carries `Conversation.abortWithEffect()` (`dist/harness/scheduler.js`, `harness.js`, `inbox.js` and their `.d.ts` files), the opt-in abort-effect companion described in docs/cua-native-abort-effect.md. `abort()` is that commit followed by its wait.

Handover, steering, `onYield` continuations, reconciliation and faults are unchanged, so they keep or end the ID as the contract says without code of their own. To reproduce the patch: `pnpm patch @earendil-works/pi-durable@1.1.0`, apply the hunks to the directory it prints, and `pnpm patch-commit <dir>`; pnpm checks the file against its SHA-256 in `pnpm-lock.yaml` (`patchedDependencies`) when it installs. `pnpm install --frozen-lockfile` applies it.

`test/pi-durable-run-identity.test.ts` runs the real harness over its in-memory storage with a scripted model. It shows that each run gets one ID that its tool tasks carry and that its later tool rounds keep, and that the next run gets another. The ID survives steering, an `onYield` continuation, a suspended call and a restart with a new harness over the same storage, and the woken call keeps it. An abort and a queued reset each end the run, and a later run gets a new ID. A run whose stored control has no ID reads as `null`, and its calls carry none. A version-1 call stored mid-run migrates and runs without one. A fork starts with no run. Under deliberate mutations it failed for: no ID minted, a new ID minted at handover, and a migration that adds one.
