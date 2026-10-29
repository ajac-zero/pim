# A Stop that reports its effect

**Status: implemented in Pim's local patches, for review.** Nothing in Pim calls the companions: there is no route integration and no production change, and native calls stay off. See "Implementation and evidence" at the end. The interface below is the one accepted at c4fefa5. The fence draft stays frozen at d1ee74d. This answers blocker 2 in `docs/cua-native-fence-prerequisites.md` (6e6e939): an operation's Stop can't be classified exactly today. The fix proposed is not to classify better beforehand, but to have the commits that actually mark and withdraw report what they did.

Pinned sources: `@earendil-works/pi-durable` 1.1.0 with Pim's patch (paths under `dist/harness/`), and `agents` (`dist/harness/pi/index.js`).

## How a Stop works today

| Step | Where | Commit | Effect, and what it returns |
| --- | --- | --- | --- |
| `PiSession.abort(operationId?)` | agents L638–642 | — | No `operationId`: `Conversation.abort()`, then `true`. With one: `PiHarness.withdraw` |
| `withdraw`, first read | agents L455–457 | **none, off the line** | `storage.submissionByRequest`. Missing, `done` or `unanswered` returns `false`. These states are final, so this "no effect" is truthful |
| `Harness.abortSubmission` → `Submissions.abort` | harness.js L163; submissions.js L65–79 | **one commit** | Checks the submission's conversation. `queued` settles it `unanswered`/`aborted` and leaves the inbox. Returns `"aborted"`, `"already_placed"`, `"settled"` or `"not_found"` |
| If `already_placed`: `Conversation.abort()` → `Scheduler.abortConversation` | agents L459; harness.js L65–67; scheduler.js L206–233 | **a later commit** | Marks `abortRequested` on every live, non-background task reached from the conversation. Withdraws **every** queued input of each reached conversation (`withdrawQueuedInputs`, inbox.js L87–96). Returns nothing, and resolves only once idle |
| Result | agents L460 | — | `true` for both `aborted` and `already_placed` |

**What stops work in a marked run:**
- A marked task's run-mode commits are refused ("has a durable abort mark", scheduler.js L1188–1190), so a marked generation can't create new tool tasks.
- Work created below a cancelled owner is marked too (scheduler.js L300–307, L404–418).
- Settlement ends the run with `aborted` (generation.js L186–197, live.js L26–33). From then on the run owns nothing.

So from the marking commit on, Pim's authority refuses every call of that run: `stopped` for a marked task, then `stopped` or `not_run_owned` once it has ended (`harnessAuthority`, src/cua-native-identity.ts L615).

**Already persisted and usable:**
- each reached task's `abortRequested`;
- each `pi.tool` task's `input.runId` (Pim's patch);
- each withdrawn submission's `unanswered`/`aborted`.

**Not persisted:** which commit marked which run, and the run ID of a run that had no tool task.

## The interface

These are opt-in companions. Every existing method keeps its signature, behaviour and return value.

```ts
// pi-durable (Pim's patch): Conversation, beside abort(). Same commit as abortConversation: same marks, same withdrawals.
abortWithEffect(context: Context, options?: { background?: boolean }): Promise<{
	effect: AbortEffect; // computed inside the marking commit; resolves once that commit has been written to storage
	idle: Promise<void>; // what abort() resolves on today
}>;

type AbortEffect = {
	readonly marked: readonly {
		conversationId: ConversationId;
		runId: RunId | null; // Tx.run(conversationId) in the same commit; null: no active run, or a run from before run IDs
		newlyMarked: number; // tasks this commit itself marked; tasks marked earlier aren't counted
	}[]; // one entry per conversation whose tasks the traversal reached
	readonly withdrawn: readonly { conversationId: ConversationId; submissionId: SubmissionId; requestId?: string }[];
};

// agents: PiSession, beside abort(operationId?). The steps, order and commits of withdraw()/abort() are unchanged.
// Resolves after the last commit the Stop makes (abortSubmission's, or the conversation abort's marking commit), without waiting for idle.
abortWithEffect(operationId?: string): Promise<{
	effect: StopEffect;
	idle: Promise<void>; // the conversation abort's idle promise; already resolved when no conversation abort ran
}>;

type StopEffect = {
	readonly aborted: boolean; // exactly what abort(operationId?) returns today
	readonly operation?: { operationId: string; outcome: "withdrawn" | "placed" | "settled" | "not_found" };
	// From Submissions.abort's own commit, or "settled"/"not_found" from the off-line read of final states.
	readonly conversation?: AbortEffect; // present only if Conversation.abort() ran: no operationId, or outcome "placed"
};
```

**Authoritative sources:**
- `operation.outcome` comes from the commit that withdrew or didn't.
- `conversation.marked` and `conversation.withdrawn` come from the commit that marked and withdrew, so they are never a prior classification.
- If a boundary placed the input, or replaced the run, between the two commits, the effect names the run actually marked: possibly a newer one, or none.

**What doesn't change:** a placed operation's Stop still aborts the conversation and withdraws every queued input, including unrelated ones, which `withdrawn` now lists. No run-only cancellation is introduced.

**Scope and identity:**
- `Submissions.abort` already refuses a submission of another conversation (`not_found`).
- A seat or a handed-out task's conversation is affected only if the traversal reached it, and then it appears in `marked` under its own `conversationId`. Pim's Stop and Delete, which abort seats one call at a time, get one effect per call.
- Request, submission and run IDs are the harness's own, and are never re-minted.

**Repeats report their own effect, not the first one's.**
- A repeated operation Stop may find the input `settled`, and do nothing more.
- If the input is still `placed`, the repeat runs the conversation abort again, as today. That reaches whatever work is live at that commit: the same run (with `newlyMarked` counting only tasks not marked before), or a run that has since replaced it, which is then marked and withdrawn as any Stop would.
- Pim fences every run a result names. Deduplication by scope (d1ee74d) only stops a second fence record for a run already fenced. It doesn't make repeats equivalent.

**A legacy run (`runId: null`) has no native intents,** because the authority refuses legacy runs (`legacy`). So the effect fences nothing for it, and the ordinary Stop is unchanged. Any intent Pim does hold in that conversation is still fenced by its own run, through the restore rule below.

## How Pim uses it, after the mutation

1. The Stop route calls `abortWithEffect` where it calls `abort` today. That resolves after the marking commit, with `{ effect, idle }`, so Pim never waits for idle before it can record the fence.
2. In one synchronous step of Pim's SQL, for each `marked` entry with a non-null `runId`, Pim writes the run's closure and, if the run has `intended` or `unknown` intents, its fence (d1ee74d). Then it awaits durability.
3. It then awaits `idle`, as `abort` does today, and answers with the existing boolean and `desktopFence`.

**There's no gap that admits more calls.** The marks are written in the harness's commit before Pim learns the effect. Until settlement they refuse every call of the run on the harness's line, and afterwards the run owns nothing. Pim's closure is needed only for the remote fence and the UI. That is why the effect can be acted on after the fact.

**No cross-store claim.** The harness commit and Pim's SQL write are two stores and two durability steps. A failed SQL write leaves the marks in place and latches Pim's native calls for the space, failing closed. The route still answers its existing boolean, with the fence reported `unconfirmed`.

**A crash between the marking commit and Pim's write** loses the returned effect, which nothing persists.

**What still holds is narrow: native safety for intents Pim had already recorded.** Pim transmits nothing before its intent is durable (d1ee74d). On restore, every `intended` intent becomes `unknown` with a run fence, and every `unknown` intent already has one. No new harness record is needed for that.

**What can't be recovered:**
- the original Stop's result: which call marked which run, and which inputs it withdrew. Withdrawn submissions read `unanswered`/`aborted`, the same as a run's own aborted inputs;
- a proof that every effect was seen;
- any durable link from a mark to a run that had no tool task, since only `pi.tool` tasks carry `runId`.

A task's `abortRequested`, or its run no longer being live, shows that a run with intents was stopped or ended. It doesn't show which Stop did it. After such a crash, the Stop's `desktopFence` can be found again only through the fences of runs that held intents. The UI must say the Stop's own result is unknown, not reconstruct it.

**The plain Stop can use the same foundation.** Calling `abortWithEffect()` without an `operationId` names the run actually marked. That removes d1ee74d's documented gap, a run starting between Pim's closure commit and the abort, and makes the pre-closure commit unnecessary. I propose it, but it is optional.

## Compatibility cost

- **pi-durable:** an addition to Pim's existing patch:
  - `abortConversation` collects `marked` (with `Tx.run`) and the IDs it withdraws, and returns them with the idle promise;
  - `withdrawQueuedInputs` returns the IDs it settles;
  - `abort()` keeps returning `idle`.

  It is carried and reviewed on every upgrade, like the run-ID patch.
- **agents:** a new patch, since there is none today: `abortWithEffect` beside `withdraw` and `abort`, with no change to either. Like the pi-durable patch, it has to be carried and reviewed on every upgrade. Alternatively Pim could call `pi.abortSubmission` and `Conversation.abortWithEffect` itself, mirroring `withdraw`'s three steps. That avoids the patch but copies the adapter's logic, which then has to stay in step with it.
- **Pim:** no behaviour change while native calls are off. With them on, the route awaits one SQL sync more.

## Test requirements (not written or run)

- **Unchanged booleans:**
  - `abort()` and `abort(op)` return what they did before for: queued, placed, settled, missing, an empty ID, and another conversation's ID;
  - a placed operation's Stop still withdraws unrelated queued inputs, and `withdrawn` lists them;
  - a queued operation's Stop withdraws only it.
- **Races:**
  - a boundary placing the input between the read and `abortSubmission`;
  - the run replaced, or ended, between `already_placed` and the conversation abort.

  The effect names the run actually marked, or none, and never a stale classification.
- **Multi-input runs, seats and handed-out tasks:** one `marked` entry per reached conversation.
- **Legacy runs:** `runId: null`, nothing fenced, the Stop unchanged.
- **Two-stage result:** with the model held, `abortWithEffect` resolves with `{ effect, idle }` after the marking commit and before idle. `abort()` still resolves only once idle, with its old boolean.
- **Repeats:** a repeat against the same live run counts only newly marked tasks and adds no second fence. A repeat after the run was replaced reports and marks the new run.
- **Crash ambiguity:** after a crash between the mark and Pim's write, the UI shows the Stop's result as unknown, not a reconstructed effect.
- **After the mark, nothing more is admitted:** a held native call's gate is refused from the marking commit on, both before and after settlement.
- **Crash after the mark, before Pim's write:** restore fences every `intended` or `unknown` intent's run, and no call is admitted.
- **Pim's SQL write fails:** native calls latch for the space, the route returns its boolean, and the fence is `unconfirmed`.
- **Acknowledgment write fails:** not counted, as d1ee74d says.

## Remaining decision

1. Where the agents side lives: a new `agents` patch, or Pim calling pi-durable directly and mirroring `withdraw`.
2. Whether the plain Stop also moves to after-the-fact fencing, which closes d1ee74d's pre-closure gap.

Until an interface like this is accepted and implemented, blocker 2 stays failed, and native calls stay off.

## Implementation and evidence

**Where it lives:**
- **pi-durable** (`patches/@earendil-works__pi-durable@1.1.0.patch`):
  - `TaskScheduler.abortConversationWithEffect` is the one marking commit. `abortConversation` is now that commit followed by awaiting its `idle`.
  - It reads each reached conversation's run (`Tx.run`) and the withdrawn inputs' request IDs (`queuedInputRequests` in `inbox.js`) before its first write, since a transaction refuses table reads after a write.
  - `withdrawQueuedInputs` returns the IDs it settled.
  - `Conversation.abortWithEffect`, the `ConversationAbortEffect` type and its export.
  - The companion attaches a handler to `idle`, so an `idle` nobody awaits leaves no unhandled rejection. The promise still rejects for callers that await it.
- **agents 0.27.0** (`patches/agents@0.27.0.patch`): `PiHarness.withdrawWithEffect` and `PiSession.abortWithEffect`, with the `PiAbortEffect` and `PiAbortHandle` types. `withdraw()` and `abort()` now await the companions' `idle` and return `effect.aborted`, so each keeps one code path.

**Tests:** `pnpm exec vitest run -c vitest.native-prereq.config.ts` runs this lane: the abort-effect and prerequisite tests, plus the existing tests whose Stops and aborts the patches touch. The lane's Worker has no Browser Run binding, no preview objects and no live mode.

`test/abort-effect.test.ts` covers:
- **pi-durable over in-memory storage:**
  - a child conversation owned by a tool task, reached by the traversal, with its own run;
  - a withdrawn input's request ID;
  - a resolve before idle, and an `idle` rejected by the caller's signal;
  - a repeat that newly marks nothing;
  - a legacy run reported as `null`;
  - a refused marking commit that rejects with nothing marked, alike for `abort()`.
- **The agents adapter in Pim's Durable Object:**
  - a queued input withdrawn alone;
  - a placed input aborting its run and withdrawing unrelated queued inputs;
  - a resolve before idle;
  - settled, missing, empty and other-chat operations;
  - the plain Stop;
  - an input queued then placed into a new run, reported as that run;
  - `abort()`'s booleans.

**Mutations, each caught:**
- counting every reached task as newly marked;
- no handler on `idle`, which the run reports as an unhandled rejection;
- no withdrawn list;
- the adapter awaiting `idle` before it resolves;
- no run read.

**Not exercised:**
- a run replaced between `abortSubmission`'s commit and the conversation abort's (no deterministic interleaving);
- `background: true` traversal;
- a crash between the marking commit and a caller's own record.

