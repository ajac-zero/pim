# The triggers runtime on the computer

> **Not active.** This is a review-only foundation. Nothing imports [`computer/triggers-runtime.ts`](../computer/triggers-runtime.ts): pim-computer doesn't run it, no service or install script starts it, no route or Durable Object sends it a message, and it has no real observers. Its only adapters are the fakes in `test/triggers-runtime.node.test.ts`. Running real polls, streams, process watches and file watches, and carrying its messages over pim-computer's connection, are later changes.

Triggers (see [triggers.md](triggers.md)) keep the space's Durable Object as the authority: it stores each trigger, decides which computer sources run, and admits what they observe. This runtime is the other end, on the person's computer. It runs the computer sources (`poll`, `stream`, `process`, `file`) the space wants, and only those; fences anything a stopped or replaced observer still emits; and holds observations in a bounded spool on disk until the space has durably taken them.

| Part | What it is |
| --- | --- |
| `parseServerMessage`, `sourceConfigHash` | The `triggers.v1` protocol: messages from the space, read from untrusted JSON; the digest a source's configuration is consented to under |
| `ObservationSpool` | The transport spool: a journal of observations and gaps not yet settled by the space |
| `TriggersRuntime` | Reconciles observers with what the space wants, under a lease, with grants checked by the host |
| `ObserverAdapter` | What a real observer will implement; only fakes exist |

The runtime consumes `PollSource`, `StreamSource`, `ProcessSource` and `FileSource` from [`src/triggers/spec.ts`](../src/triggers/spec.ts) as types only, so the file stays loadable in Node alone, as pim-computer is. It changes nothing in `src/triggers/`.

## Authority

**One owner, from configuration.** A runtime is constructed with one `binding`, `{ space, runtimeId }`, from the computer's own configuration (later, the token pim-computer connects with). A reconcile carries a binding too, but only to be checked: one that differs is refused (`binding_mismatch`) and changes nothing. Observations carry no space at all; the space a message belongs to is the connection it came in on. Nothing an adapter emits can set an envelope field: what it observed is nested under `data`, and a `data.sourceId` or `data.spaceId` is just data.

**One connection at a time.** The host attaches a transport with a `connectionId` it got from its handshake with the space. Every message from the space names that connection; a message for another connection, or arriving on one that was detached, is refused or ignored.

**Grants are consent, not a sandbox.** Observers run as the user who runs pim-computer, with that user's access. A grant says the person consented to one source's exact configuration; it confines nothing. A custom script in a poll or a stream can do anything that user can, and nothing here says otherwise.

**Default deny.** Before an observer starts, and again on every reconcile that keeps it, the runtime asks the host's `authorize` check with the binding, trigger, source identity, generation, `configHash`, the source and the grant. Only a verdict of exactly `{ ok: true }` allows it; any other value, a throw, or no check configured denies it. A grant is an opaque reference and a digest of its scope (`grantRef`, `scopeHash`), never a credential, and nothing copies a credential into the protocol or the spool.

**Any change of what runs needs consent again.** `configHash` is `sourceConfigHash(source)`: a SHA-256 digest over every field of the source, so the command, path, working folder, interval, deadline and events are all part of it. The runtime recomputes it and refuses a source whose hash doesn't match (`invalid`, health `config_hash_mismatch`). A host's check that keys consent on the exact `(grantRef, scopeHash, configHash)` therefore can't carry an approval over a change of content, frequency or scope. A changed grant or scope on the same generation stops the running observer (`consent_changed`) and checks the new grant before anything starts.

## Protocol `triggers.v1`

Every frame is one JSON object with `protocol: "triggers.v1"` and a `type`. Frames from the space are read strictly: unknown fields, unknown types, wrong types and out-of-range numbers are refused with an `error` frame that carries only a code (`invalid`, `unsupported_protocol`, `too_large`). Frames from the space may be up to 1 MiB (4 MiB at most); frames the runtime sends are at most 64 KiB.

### From the space

| Type | Fields | Means |
| --- | --- | --- |
| `reconcile` | `binding`, `connectionId`, `serverEpoch` (≥ 1), `desiredRevision`, `leaseMs` (1 to 120,000), `sources` (up to 256) | The whole set of computer sources the space wants running now, and a lease on it |
| `ack` | `connectionId`, `serverEpoch`, `durable: true`, `results` (up to 1,024) | What the space did with observations and gaps, sent only after its own write is durable |

Each desired source is `{ triggerId, sourceId, revision, generation, configHash, source, grant: { grantRef, scopeHash }, checkpoint }`. `sourceId` is the store's source identity (`<triggerId>#<revision>`), `generation` the trigger's generation, and `checkpoint` (`{ position, cursor }` or null) what the space has durably taken, for a new observer to resume from. Each trigger appears at most once.

Each ack result is `{ sequence, eventId, result, reason, retryAfterMs }`:

| `result` | Final | The entry |
| --- | --- | --- |
| `accepted` | Yes | Leaves the spool |
| `duplicate` | Yes | Leaves the spool; the space already had it, and nothing new happens |
| `rejected` | Yes | Leaves the spool: the space will never take it (stale generation, deleted, invalid, too old) |
| `deferred` | No | Stays, and is sent again with the same id and sequence from `retryAfterMs` (at least `resendAfterMs`) |

A result whose `eventId` doesn't match the entry at that sequence, one for an entry already gone, and any ack for another epoch are ignored, so duplicate and reordered acks are harmless.

### From the runtime

| Type | Fields | Sent |
| --- | --- | --- |
| `hello` | `runtimeId`, `connectionId`, `lastEpoch`, `pending` | On attaching a connection |
| `reconciled` | `serverEpoch`, `desiredRevision`, `leaseMs`, `sources[]` of `{ triggerId, sourceId, generation, state }` | After each reconcile it took. `state` is `starting`, `running`, `stale` or `invalid` |
| `installed` | `serverEpoch`, `triggerId`, `sourceId`, `generation`, `configHash` | When an observer's `start` has returned. Always before its first observation and its `listening` health |
| `health` | the same, `status` (`ok`, `degraded`, `error`), `code` | `listening`, `resumed`, `backpressure`, `auth_denied`, `start_failed`, `start_timed_out`, `unsupported`, `config_hash_mismatch`, `spool_unavailable`, or an adapter's own code. Codes only, never text |
| `stopped` | the same, `reason`, `adapter` | When this generation's own adapter was asked to stop. `adapter` is `returned`, `timed_out`, `failed` or `not_started`. **It never says a process or anything the adapter started was cancelled or undone** |
| `observation` | `serverEpoch`, `eventId`, `triggerId`, `sourceId`, `revision`, `generation`, `sequence`, `occurredAt`, `data`, `checkpoint`, `coalesced` | Each spooled observation, until settled |
| `gap` | `serverEpoch`, `eventId`, `triggerId`, `sourceId`, `generation`, `sequence`, `reasons`, `from`, `to` | Each recorded loss, until settled. A null source is the whole spool's |
| `error` | `code` | A frame from the space refused: `invalid`, `unsupported_protocol`, `too_large`, `binding_mismatch`, `wrong_connection`, `stale_epoch`, `stale_reconcile`, `spool_unavailable` |

`sequence` is the runtime's own, increasing and never reused; observations and gaps share it, and each keeps its `eventId` and `sequence` through every retransmission and restart. An `eventId` is random, or, when the adapter gives a stable `key` (such as a file's inode and change counter), a digest of the source identity and the key, so a re-read event is a `duplicate` at the space.

Control frames (`hello`, `reconciled`, `installed`, `health`, `stopped`, `error`) go before observations in every flush and are not kept across connections: after a reconnect, the next `reconciled` says where every source stands. At most `control` (1,024) are held; past that the oldest health goes first.

## Lifecycle

**Reconcile is idempotent.** The space sends the whole desired set. For each trigger, an observer with the same source identity, generation, `configHash` and grant keeps running (its grant is checked again); anything else is stopped and the new one started. A trigger left out is stopped (`not_desired`): pausing, ending and deleting all look like that here. An older generation than one already seen is `stale` and changes nothing. A reconcile with an older `desiredRevision` in the same epoch is refused; the same one again only renews the lease and checks grants again.

**Leases.** A reconcile holds for its `leaseMs`, 120 seconds by default and at most, counted on the runtime's own clock from when it arrives, so clock skew doesn't matter. Observers keep running, and spooling, while disconnected, until the lease runs out; then every observer is stopped (`lease_expired`) and only a new reconcile starts them again. The space stops admitting on its own side independently.

**One observer per trigger, fenced by generation.** A trigger has at most one observer at a time. Stopping one fences it at once: from that moment its `emit` returns `stopped`, its health is ignored, its `AbortSignal` fires, and its `stop` is called, even if its `start` hasn't returned. The next generation's `start` waits until the old `stop` has returned, failed, or timed out (`stopTimeoutMs`, 10 s). A `start` that returns after its observer was stopped reports nothing. The runtime only ever calls `stop` on the adapter it made for that generation; it never finds or stops anything by name.

**Installation before listening.** An observer is `installed` once its `start` has returned; until then its emissions are refused (`not_started`). A `start` that throws, or doesn't return within `startTimeoutMs` (30 s), is reported as health `start_failed` or `start_timed_out`, never as installed, and its adapter is stopped.

**Epochs.** `serverEpoch` names the space's current session with this computer. The same epoch on a new connection resumes it: everything unsettled is sent again, unchanged. A higher epoch replaces it: every observer is stopped (`epoch_replaced`), every spooled entry from an older epoch is taken out without being sent, and one gap per source in the new epoch counts them (`epoch_replaced`). Observations are never replayed into a new epoch. A lower epoch is refused (`stale_epoch`).

**Restarts.** Nothing on disk starts an observer. After a restart the runtime sends `hello` and waits; the spool's entries are sent only after the space reconciles on that connection in their epoch, and an observer starts only if that reconcile still wants it and the host's check still allows it. It resumes from the space's checkpoint in the reconcile, not from anything local, and old commands are never re-run on the strength of a file.

**Checkpoints.** An observation can carry a checkpoint. The adapter's `commit(checkpoint)` is called only when the space has settled (`accepted`, `duplicate` or `rejected`) every earlier observation of that observer, so it never passes one still unsettled, deferred or lost. A loss (expiry, epoch replacement) is never passed: what follows it doesn't move the checkpoint for that observer's run.

## The spool

**What it is.** A journal in one file, `journal`, in a directory the host names. Each record is one line: 16 hex digits of the SHA-256 of its JSON, a space, and the JSON. Records put, replace and remove entries. Every write is synced (`datasync`) before it counts, and an observation is written, with its `eventId` and `sequence`, before it is ever sent.

**Retention is transport only.** The spool is not history, not a log, and not a raw sample: raw samples stay off (see triggers.md). An entry leaves when the space settles it, when its time to live runs out, or when its epoch is replaced. Until then it holds what an observer saw, which can be sensitive, as plain JSON on the person's disk, for at most 24 hours. The directory is made `0700` and the journal `0600`, wider modes found are narrowed, a symlinked or foreign-owned path is refused (`unsafe_path`), and files are opened with `O_NOFOLLOW`. That keeps other users of the machine out; it is not isolation from the user pim-computer runs as, or anything that user runs. Source configurations, commands and grants are never written to the spool.

**Bounds.** At most 32 MiB and 24 hours (`maxBytes`, `ttlMs`), configurable lower, never higher; at most 100,000 entries. The journal never grows past `maxBytes`: before an append would, it is rewritten with only what is live, through `journal.tmp`, synced and renamed over it. Part of it (`reserveBytes`, `reserveEntries`) is kept for gaps, which observations can't use. An observation's data is at most 16 KiB as JSON, what the space's store takes, and its frame at most 64 KiB; a larger one is refused (`too_large`), never cut, and counted in a gap.

**Crashes and corruption.** Opening reads every whole line whose digest matches. A last line cut short by a crash is dropped (`recovery.torn`), and so is any line whose digest doesn't match (`recovery.corrupt`); the journal is then rewritten from what was read. A write that fails part-way, such as on a full disk (`ENOSPC`), is cut back to the last whole record before anything else is written, and the emission is refused (`spool_unavailable`). Corrupt records are counted in a gap with no source, sent in the spool's epoch.

**Overflow.** Nothing is dropped silently and no cursor moves past what wasn't kept:

- **Events** (`stream`, `process`, `file`): when the spool is full, the emission is refused with `backpressure`, the adapter's `pause` is called once, health goes `degraded`/`backpressure`, and a gap counts every refused emission (`overflow`, with the first and last `occurredAt`). The adapter must not move its own cursor past a refused event. Once the space has settled enough that the spool is at most half full, `resume` is called and health goes `ok`/`resumed`. The gap is sent in sequence, after what was kept before it.
- **States** (`poll`): when the spool is full, the source's snapshots not yet sent may be folded into the newest one, which says so: `coalesced: { count, from, to }` is how many snapshots it stands for and over what time. A snapshot already sent is never folded or changed. If there is nothing left to fold, a state is refused as an event is.

**Time to live.** An observation held longer than `ttlMs` is taken out unsent, and a gap counts it (`expired`, with its time range). Nothing is fabricated in its place, and it is never sent later. Gaps themselves don't expire: they hold counts and times, nothing observed, and they merge, one per source, generation and epoch, until sent.

**Sending.** Each flush sends control first, then at most `batch` (32) due entries in sequence order. An unsettled entry is sent again after `resendAfterMs` (30 s), doubling up to `maxResendMs` (5 min); a new connection starts the backoff over. A transport that takes nothing waits `blockedRetryMs` (1 s). A flush always ends by setting a timer for a later instant, or none, so it never loops, and the runtime never reconnects on its own: that is the host's.

**Logging.** The runtime's `log` gets codes and counts only (`lease_expired`, `spool_expired`, `ack_unknown`, `adapter_stop_timed_out`, ...), never what was observed, a command, a grant or an error's text. It writes nothing to the console.

## What fails, and what happens

| Failure | What the runtime does | What the space sees |
| --- | --- | --- |
| Reconcile for another space or runtime | Refuses it; nothing starts or stops | `error` `binding_mismatch` |
| Message on another connection | Ignores it, or refuses it | Nothing, or `error` `wrong_connection` |
| Malformed message, lease over 120 s, other protocol | Refuses it | `error` `invalid` / `unsupported_protocol` |
| No grant check, or a verdict other than `{ ok: true }` | Starts nothing | `health` `auth_denied` |
| `configHash` not the source's | Starts nothing, stops any observer of that trigger | `reconciled` `invalid`, `health` `config_hash_mismatch` |
| Grant revoked between reconciles | Stops the observer (`revoked`) | `health` `auth_denied`, `stopped` |
| Grant or scope changed, same generation | Stops (`consent_changed`), checks the new grant | `stopped`, then `installed` or `auth_denied` |
| Source changed (new generation) | Fences and stops the old (`reconfigured`), starts the new after its stop | `stopped`, `installed` |
| Older generation offered | Nothing | `reconciled` `stale` |
| `start` throws or times out | Stops that adapter | `health` `start_failed` / `start_timed_out`, `stopped`, never `installed` |
| Stopped while `start` runs | Calls `stop` at once; a late `start` reports nothing | `stopped` |
| `stop` never returns | Reports it after `stopTimeoutMs`; the old generation stays fenced | `stopped` `timed_out` |
| Emission after stop, or before installation | Refused; nothing written | Nothing |
| Paused, ended or deleted | Stops the observer (`not_desired`); spooled entries are still sent | `stopped`, then `rejected` acks for what it won't take |
| Disconnected | Keeps observing and spooling until the lease ends | Retransmission on reconnect |
| Lease runs out | Stops every observer (`lease_expired`) | Nothing until it reconnects and reconciles |
| Reconnect, same epoch | Sends everything unsettled again, same ids and sequences | Duplicates are `duplicate` |
| New epoch | Stops everything, drops older-epoch entries unsent | One `gap` (`epoch_replaced`) per source |
| Older epoch | Refuses it | `error` `stale_epoch` |
| Restart | Starts nothing; waits for a reconcile | `hello` with `lastEpoch` and `pending` |
| Ack out of order, duplicated, mismatched or for another epoch | Settles only exact matches in this epoch; checkpoints commit in order | Nothing |
| `deferred` ack | Keeps the entry, sends it again later | The same observation again |
| Crash part-way through a write | The cut line is dropped on opening | Nothing; the emission was never `ok` |
| Write fails (disk full) | Cuts back to the last whole record; refuses the emission | `health` `spool_unavailable` |
| Corrupt record | Skipped on opening | `gap` with no source, `corrupt` |
| Spool full, events | Refuses with `backpressure`, pauses the adapter | `health` `backpressure`, a `gap` (`overflow`) |
| Spool full, states | Folds unsent snapshots into the newest | `observation` with `coalesced` |
| Older than `ttlMs` | Takes it out unsent | `gap` (`expired`) |
| Data over 16 KiB or frame over 64 KiB | Refuses it, never cuts it | `gap` (`too_large`) |
| Transport takes nothing | Waits `blockedRetryMs` | Nothing until it does |

## Meeting the store

When this is turned on, the space's side maps the protocol onto `TriggerStore` (`src/triggers/store.ts`) as it is, without changing it:

- An `observation` is `admit({ id: triggerId, generation, eventId, observedAt: occurredAt, payload: data, checkpoint })`. `accepted` acks `accepted`; `duplicate` acks `duplicate`; `backpressure` and `inbox_full` ack `deferred`; `not_found`, `deleted`, `stale_generation`, `not_enabled`, `wrong_source`, `out_of_order`, `too_old`, `expired` and a `TriggerValidationError` ack `rejected`. The ack is sent after `transactionSync` returns, so it is durable.
- A `gap` is `recordGap({ id: triggerId, generation })`, then acked. A gap with no source marks every computer trigger of the space. A `coalesced` observation should be admitted with `gap: true`, since what it stands for was never seen.
- `installed`, `health` and `stopped` map to `setHealth` (`healthy`, `configuration_error`, `auth_required`, ...), which carries codes only.
- `reconcile` is built from enabled computer triggers: `sourceId` from `sourceState(id).identity`, `checkpoint` from its `position` and `cursor`, `configHash` from `sourceConfigHash`.

The spool's time to live (24 hours at most) is well inside the store's replay horizon (7 days), so a retransmitted observation is never `too_old` because the runtime held it, and its `occurredAt` is the same on every delivery, as `admit` requires.

### Proposed changes to shared modules

None of these are made here; they are for whoever owns those modules to accept or refuse.

1. **Export the source reader.** `src/triggers/spec.ts` reads a source in `parseSource`, which isn't exported, so the runtime checks a source's shape on its own (`readSource`) and relies on the space having checked its bounds. Exporting `parseSource`, or a `parseComputerSource`, would let both ends read one way, if the runtime may import it as a value.
2. **One digest of a source.** The space has to compute the same `configHash` as `sourceConfigHash` here (SHA-256 of `"triggers.v1/source\n"` and the source as JSON with sorted keys), and the host's check, and the approval that fills `authorizationRef`, should key consent on it. Putting that function beside the spec would keep the two from drifting.
3. **Name the generation the grant was checked for.** The store's `AuthorizationRequest` has no `configHash` or scope digest; adding them would let the approval and this runtime's check agree on exactly what was consented to.

## Not done here

The real adapters (running polls and streams, watching processes and files), carrying these frames over pim-computer's connection, the space's side of the protocol, starting the runtime as part of pim-computer, choosing where its spool lives, and the host's real grant check. Each is its own change, and this file is the contract they meet.
