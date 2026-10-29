# Fence obligations in Pim

**Status: local, for review. Not active anywhere.** `Pim.nativeDesktop()` stays `false`, so no deployment or preview space records a fence or calls the abort-effect companions. There is no broker and no wire protocol: the only fence transport is a scripted stand-in in the tests (`fenceTransports` in `test/worker.ts`). The fence protocol draft stays frozen at d1ee74d; this is the Pim-side slice of it, built on the companions accepted at 7cea1b7 (`docs/cua-native-abort-effect.md`).

Code: `src/cua-native-fences.ts` (`NativeFences`), and in `src/pim.ts` `#stop`, `#desktopSend` and `#desktopDispatch`.

## What a fence means here

A fence concerns one run, and only **new broker sends of that run**. Confirmed means: the broker instance that run's calls were admitted under acknowledged it will send nothing more of that run, and Pim recorded that durably. It does not mean the desktop stopped, that a call already sent didn't run, or anything about other programs on the desktop. Takeover stays unavailable.

| State | Meaning |
| --- | --- |
| `open` | A call of the run was admitted. No fence is required yet. |
| `pending` | A fence is required and was asked for. No acknowledgement has been counted. |
| `confirmed` | Acknowledged by the instance it was asked of, with the same fence ID and run, and synced. |
| `unconfirmed` | Required, and no acknowledgement can be had or counted now: no transport, another instance, a lost or wrong answer. A later acknowledgement from the right instance may still confirm it. |

A fence is required for one of three reasons: `stop` (a Stop's marking commit reported the run), `unknown` (a call of the run has no known end), or `recovered` (a restart found such a call). Each run has one record, keyed by its run ID. A run whose fence was required admits nothing more, ever.

## How Stop changes, and how it doesn't

**Where the desktop's tools are off (every real space), every Stop calls `PiSession.abort()` exactly as before.** No table is created, and the answers, the idle wait and queued resets are unchanged.

**Where they're on,** `#stop` replaces `abort(operationId)` in:
- the Stop route (seats and the chat);
- the socket's `abort`;
- chat deletion (seats and the chat);
- `#cancelTask`, which covers task cancellation, agent deletion and deletion's handed-out tasks;
- a seat's removal (`#leave`);
- suspension.

Erasure keeps `abort()`, because it deletes all storage anyway.

`#stop` does the following:
1. It calls `abortWithEffect(operationId)`, which resolves after the marking commit.
2. For each `marked` entry with a run ID, it requires that run's fence if the run has a record. A legacy run (`runId: null`) needs none, because the authority refuses its calls. A run without a record had no call admitted, so none sent.
3. It writes and syncs the fence, **then** awaits `idle`.
4. It returns `effect.aborted`, which is `abort()`'s own boolean.

A failed marking commit throws as `abort()` does, having required nothing. A failed fence write doesn't change the answer.

The API still answers only the existing boolean. It acknowledges the local Stop, not remote safety. There is no UI.

## Why nothing is sent without an open record, and recovery can't miss a send

These steps happen before any call can leave:

1. **The binder's claim** is a harness commit, before the send (unchanged).
2. **Admission** (`NativeFences.admit` in `#desktopSend`) stores and syncs the run's record before:
   - the control state admits the call;
   - its send is authorized.

   A refusal here is a `ControlRefused`, so the binding closes and nothing is sent.
3. **The send's own authorization** (the `NativeGate` commit) checks the fences again, synchronously, after every await it has: admission's sync, the computer's wake, and the authority's verification. It reads `NativeFences.sendable(run)` next to Pim's other records, with nothing awaited between that read and `transmit()`. A fence required for the run, a fault, a closed space or a broker instance other than the one the run was admitted under refuses the send.

A Stop's marks are committed before the Stop learns its effect, and the send's own authorization reads them on the harness's line. So a call whose record didn't exist when the Stop looked is refused at its send.

A new process admits nothing until `reconcile` has done three things:
- read the binder's records, which turns every claim it isn't sending into `unknown`;
- required a `recovered` fence for every run with an unknown call, **and for every run whose record is still `open`**;
- synced.

Every call that could still be sent, or still be queued at a broker, is claimed or unknown in the binder. So the restore fences its run even when the Stop's own record was never written. **There's no new durable effect record:** the binder's claims are the pre-operation marker.

**Why every open record is fenced.** An `open` record that survives a restart may belong to a run whose Stop marked it in the harness while the Stop's fence write was lost. The obligation is a fence on the broker's sends for that run, whether or not any of its calls' outcomes are unresolved. Pim doesn't reconstruct which Stops happened. Instead it fences every surviving open record, and each of those was synced before any call of its run could be sent. If the instance the run was admitted under is no longer the transport's, the fence stays `unconfirmed`.

The cost is that a run still going across a restart sends nothing more natively. Whether new runs are admitted after the restart is a separate question, decided by the stored fault below.

## After a fault: what is closed, and what survives a restart

Any failed fence write or sync latches the process: admission, a Stop's or an unknown end's fence, an acknowledgement, a lapse, or reading the faults. A latched process admits nothing, sends nothing, and asks and records nothing more. **The latch itself is memory only.**

The latch also tries to write a row to `pim_native_fence_faults` and sync it. That row goes to the store that just failed, so whether it survives is never certain, and nothing claims it did.

What a restart finds:

| What was stored | What the restart does |
| --- | --- |
| The fault row | Native calls stay closed. Fences are still rebuilt and asked for, but nothing is admitted. **Nothing reopens them: a reconciliation policy is an open decision for Groves, and none is assumed.** |
| No fault row (its write or sync was lost too) | Nothing records that a fault happened, so new runs are admitted again. Before that, the restart fences every run with an unknown call and every run still `open`. That is conservative for every write that could have been lost:<br>• a lost admission record means its call was refused unsent;<br>• a lost Stop fence leaves the run `open`, which is fenced now;<br>• a lost acknowledgement or lapse leaves the fence `pending`, and it is asked for again. |

In both cases, what survives is only what storage committed: the binder's claims, and whatever fence rows were synced. A write whose sync failed may or may not be there, and the rules above hold either way.

## Acknowledgements

**An acknowledgement is recorded in two steps.**
1. `#confirm` writes the acknowledgement alone (`acked_at`) and leaves the state as it was. It then syncs.
2. Only once that sync has resolved does it write `confirmed`, and sync again.

So `confirmed` is never written before the acknowledgement's own sync has resolved. This holds in the process, and in what is on disk after a crash. An `acked_at` whose state isn't `confirmed` counts for nothing, and its fence is asked for again. If the first sync fails, the acknowledgement is undone. Either failure latches the process.

**What this qualifies, and what it doesn't.** The tests show the ordering in this process, and what the local runtime keeps after `ctx.abort()` during either sync. They rest on one assumption: that `sync()` resolving means the write is durable. That is **not established** for production storage or its output gate. Nothing here relies on in-process state surviving a crash.

**Each ask is bounded** by `nativeFenceAskMs()`, 30 s by default. Unanswered, the fence becomes `unconfirmed`, its ask is released, and it is asked for again, by the same fence ID, the next time fences are asked for. That happens on another fence's requirement or on a restart, and re-asks for a fence's status; no action is replayed. An answer arriving after the bound is still checked and counted.

## Failure behaviour

| Case | What happens |
| --- | --- |
| Marking commit fails | The Stop throws as `abort()` does. Nothing is required, and the call goes on. |
| Crash after the mark, before Pim's write | The Stop's result is lost and **not reconstructed**. The restart turns the run's claimed call into `unknown`, fences it as `recovered` before admitting anything, and replays nothing. |
| A fence is required, the broker instance changes, or a fault occurs while a call waits on admission's sync or the computer's wake | The send's own check refuses it. Nothing leaves, and the binding closes. |
| Pim's fence write or its sync fails | The Stop still answers its boolean after idle. The process latches and tries to store the fault. Native calls stay closed after a restart only if it was stored. |
| Acknowledgement with another fence ID, run or instance, extra fields, or a lost answer | Not counted, so `unconfirmed`. Asked again by the **same fence ID**. |
| The broker never answers | `unconfirmed` once the ask's bound passes. Asked again later, by the same ID. A late answer still counts. |
| The acknowledgement's first sync fails | Never `confirmed`. The acknowledgement is undone, and the process latches and tries to store the fault. |
| The process ends during the acknowledgement's first sync | The state on disk is still `pending`, and any `acked_at` counts for nothing. The restart asks for the fence again by its own ID. |
| The process ends during the second sync | `confirmed` may be on disk. It was written only after the first sync had resolved. |
| The broker comes back as another instance | The old run's fence can't be confirmed by asking the new instance, so it stays `unconfirmed`. A run admitted under one instance admits and sends nothing under another. A confirmed fence stays confirmed after its instance is gone. |
| 512 records (`MAX_NATIVE_FENCES`) | New admission is refused before anything is sent. Nothing is evicted. Every record belongs to a run of a binding the binder accepted, and the binder accepts at most 512 in a space's life, so this limit is reached only by a store that is wrong. |

**Known limits:**
- Pim's SQL and the harness are two stores. No write here is in a transaction with a harness commit.
- Whether `sync()` and workerd's output gate give the crash durability assumed here in production is **not established**.
- A stored fault can't be guaranteed, as described above. Without one, a restart reopens new runs.
- The instance recorded at admission is what the stand-in transport says. The real native path doesn't go through a broker.

## Evidence

The lane, with no Browser Run binding, runs `test/native-fences.test.ts` in the real Pim Durable Object in workerd, over its SQLite storage and `ctx.storage.sync`. The stand-ins are:
- the computer's `native` call, which can hold its wake, passes through Pim's real send gate, and then answers as scripted;
- the broker's fence channel.

A restart is `ctx.abort()` on the instance. That is a reset in the local runtime that keeps committed storage, not a power loss. Injected failures are thrown before SQLite sees a write, or from `sync()` after the write reached storage. A held sync is a test's promise in place of `sync()`, not storage's own.

Each of the four corrections has its own test:

| Correction | Test | What it shows |
| --- | --- | --- |
| Check at the send | "checks the run's fence again at the send itself…" | A required fence, a broker instance change or a fault, made while the computer's wake or the admission's sync is held, sends nothing, and the binding closes. |
| Acknowledgement only after its own sync | "counts an acknowledgement only after its own sync resolved, in two steps…" | **Held first sync:** SQLite holds the acknowledgement with the state still `pending`, and it reads `pending`. **First sync failing:** the acknowledgement is undone, and after a restart the fence is `pending` and asked for again. **Crash during the first sync:** the restart reads `pending` and asks for it again by the same ID, and nothing is sent again. **Crash during the second sync:** `confirmed`, with its acknowledgement on disk. |
| Restart after a fault | "after a fault, a restart fences every run still open…" | **Fault row stored:** the restart stays closed. The old open run is fenced as recovered, and stays `unconfirmed` under a new instance. **Fault row lost too:** the old run, whose call completed and whose Stop write was lost, is fenced as recovered and confirmed; a new run is admitted, and nothing is replayed. **Fence write kept, sync failed:** re-asked by its own ID, and the space stays closed. |
| Bounded wait | "waits a bounded time for an acknowledgement…" | An unanswering broker leaves the fence `unconfirmed`. It is asked again by the same ID, and a late answer still counts. |

**Every path that stops a chat** is exercised with a held native call, and each must fence that call's run:
- the Stop route's seats;
- a seat taken out;
- Delete's seats;
- a canceled task;
- a deleted agent's task;
- suspension;
- the chat socket's `abort`.

The plain Stop, an operation's Stop and Delete's own chat are covered by the earlier tests.

`test/cua.test.ts` now watches `abortWithEffect` in its Stop-ordering tests, where it watched `abort`.
