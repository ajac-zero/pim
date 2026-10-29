# Native fence prerequisites: local evidence (design frozen at d1ee74d)

This note records what `test/native-prerequisites.test.ts` showed about the two blockers named in `docs/cua-native-fence-protocol.md`. It changes no design and no production code, and native calls stay off.

**What the tests run on:** the real Pim Durable Object in local workerd (`pnpm exec vitest run test/native-prerequisites.test.ts`), with:
- its real SQLite storage;
- Pim's patched pi-durable 1.1.0;
- the agents adapter (`agents/harness/pi`);
- the faux model, held by test gates.

Every wait has a watchdog. **Nothing here says anything about production storage.**

## 1. Awaiting `ctx.storage.sync()` while holding the harness's line

**Why it can work, from the source:** a harness commit runs its callback on the session's mutation line (`Session.commitWith` → `#runCommit`, `dist/session/session.js` L53–60, L253–270). Only after the callback returns does it write its batch through the adapter's `storage.transaction()` (`DurableObjectSqliteDatabase.transaction`, `agents/dist/harness/pi/index.js` L228–236). So while the callback runs, no Durable Object transaction of this commit is open.

| Check | Result |
| --- | --- |
| `storage.sync()` awaited inside a real harness commit callback resolves, with no refusal or deadlock (5 s watchdog) | **PASS** (local workerd) |
| A real `Conversation.abort()` asked for during that callback lands after it. The run and its task are unchanged after the sync, and `abortRequested` is set in the next commit | **PASS** |
| The sync covers Pim's own SQL write made before it; the row is visible | **PASS**, visibility only |
| The sync doesn't cover the commit's own harness writes. The harness's `next_seq` is unchanged after the sync, and moves only after the callback returns | **PASS**, as a finding: same-commit harness writes can't be made durable inside the callback |
| No cross-store transaction: a callback that throws after both writes rolls back the harness write, and Pim's row stays | **PASS** |
| A harness read awaited inside its own commit (`inspect`, which uses `readOnLine`) never runs. The watchdog ends it, and the line recovers | **PASS**, as a control: the gate's callback must await nothing on the harness's line |
| `sync()`'s durability, and output gating, in production | **UNKNOWN**, not runnable here |
| Latency cost of holding the line under load | **UNKNOWN**, not measured |

**Design consequence, within d1ee74d:** none to the protocol. Pim's intents live in Pim's SQL, which the sync can cover. The gate's callback may await only Pim-side work and the sync, never a harness read or commit.

## 2. Classifying a Stop with an `operationId`

| Check | Result |
| --- | --- |
| In one read-only commit, `Tx.submissionByRequest(conversation, operationId)` and `Tx.run(conversation)` classify an operation as queued, placed in the live run, ended (`done`/`unanswered`), or not found. The harness's `next_seq` doesn't move | **PASS** |
| "Placed" matched membership in the live run's inputs in every case: single input, a steer joining (multi-input), a follow-up starting the next run | **PASS**. The inputs list was read test-only through `LiveDoc`; the typed contract is `SubmissionRecord`'s "owned by an active run" |
| Not found: an unknown ID, `""`, and the same ID read in another conversation (as a seat or task conversation would be) | **PASS**: `submissionByRequest` is conversation-scoped |
| A queued input's Stop withdraws only it. The run isn't marked | **PASS** |
| The classification is the commit the Stop acts in | **FAIL** |

**Why it fails.** `abort(operationId)` (`PiHarness.withdraw`, `agents/dist/harness/pi/index.js` L453–461) acts in three steps:
1. a read off the line;
2. `abortSubmission` in one commit;
3. if the input was already placed, `Conversation.abort()` in a later commit.

The test classified `op-B` as queued. A boundary then placed it into a new run, and its Stop aborted that run. Because step 3 is the conversation's whole abort, it also withdrew two unrelated queued inputs. `withdraw` returned `true` both for withdrawing a queued input and for aborting a run, so the caller can't tell which happened. **No commit Pim can run before or after the call shows exactly what it did.**

**The existing meaning, preserved and now stated:** a Stop with an `operationId` either withdraws that queued input alone, or, if the input was already placed, aborts the conversation's live run at that later commit and withdraws every queued input.

**Minimum interface needed (not implemented, no patch made):** an operation-specific withdraw that acts in one harness commit and returns its effect: `{ withdrawn }`, `{ aborted: runId }`, `{ settled }` or `{ not_found }`. The agents adapter's `abort(operationId)` would pass that effect through. Pim would then close and fence the reported run after the fact. That is exact, because the harness's abort mark, made in that same commit, already refuses any later intent in the run on the line. Until an interface like this exists, the native feature fails this qualification, as the spec requires. There is no fallback.

**Related, not required for a Stop without an `operationId`:** if `Conversation.abort()` also returned the run it marked, the plain Stop could close by reported effect too. That would remove its documented gap for a run that starts between Pim's closure commit and the abort.
