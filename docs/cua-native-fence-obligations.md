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

## Why recovery can't miss a send

These two steps happen before any call can leave:

1. **The binder's claim** is a harness commit, before the send (unchanged).
2. **Admission** (`NativeFences.admit` in `#desktopSend`) stores and syncs the run's record before:
   - the control state admits the call;
   - its send is authorized.

   A refusal here is a `ControlRefused`, so the binding closes and nothing is sent.

A Stop's marks are committed before the Stop learns its effect, and the send's own authorization reads them on the harness's line. So a call whose record didn't exist when the Stop looked is refused at its send.

A new process admits nothing until `reconcile` has done three things:
- read the binder's records, which turns every claim it isn't sending into `unknown`;
- required a `recovered` fence for every run with an unknown call;
- synced.

Every call that could still be sent, or still be queued at a broker, is claimed or unknown in the binder. So the restore fences its run even when the Stop's own record was never written. Everything else in a stopped run had a known end. **There's no new durable effect record:** the binder's claims are the pre-operation marker.

## Failure behaviour

| Case | What happens |
| --- | --- |
| Marking commit fails | The Stop throws as `abort()` does. Nothing is required, and the call goes on. |
| Crash after the mark, before Pim's write | The Stop's result is lost and **not reconstructed**. The restart turns the run's claimed call into `unknown`, fences it as `recovered` before admitting anything, and replays nothing. |
| Pim's fence write fails, or its sync fails | The Stop still answers its boolean after idle. The process latches: no admission, no fence asked or recorded. A restart rebuilds from the binder. A stopped run whose call had a known end gets no fence then, and needs none. |
| Acknowledgement with another fence ID, run or instance, extra fields, or a lost answer | Not counted, so `unconfirmed`. Asked again by the **same fence ID** after a restart. That re-asks for a fence's status; no action is ever replayed. |
| The acknowledgement's sync fails | Not counted. This process's view reverts and latches. |
| The broker comes back as another instance | The old run's fence can't be confirmed by asking the new instance, so it stays `unconfirmed`. A run admitted under one instance admits nothing under another. A confirmed fence stays confirmed after its instance is gone. |
| 512 records (`MAX_NATIVE_FENCES`) | New admission is refused before anything is sent. Nothing is evicted. Every record belongs to a run of a binding the binder accepted, and the binder accepts at most 512 in a space's life, so this limit is reached only by a store that is wrong. |

**Known limits:**
- Pim's SQL and the harness are two stores. No write here is in a transaction with a harness commit.
- Whether `sync()` and workerd's output gate give the crash durability assumed here in production is **not established**.
- The latch after a write failure lives in memory. Across a restart, safety comes from the reconcile rule above, not from a stored fault.
- A transport that never answers leaves a fence `pending`. A real transport would have to bound its own call.
- The instance recorded at admission is what the stand-in transport says. The real native path doesn't go through a broker.

## Evidence

The lane, with no Browser Run binding, runs the new file `test/native-fences.test.ts` in the real Pim Durable Object in workerd, over its SQLite storage and `ctx.storage.sync`. The stand-ins are:
- the computer's `native` call, which passes through Pim's real send gate and then answers as scripted;
- the broker's fence channel.

A restart is `ctx.abort()` on the instance. That is a reset in the local runtime that keeps committed storage, not a power loss. Injected failures are thrown before SQLite sees a write, or from `sync()` after the write reached storage.

`test/cua.test.ts` now watches `abortWithEffect` in its Stop-ordering tests, where it watched `abort`.

**Not exercised with a native call:** seats, handed-out tasks, suspension and a seat's removal. They use the same `#stop`.
