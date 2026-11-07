# The triggers runtime on the computer

> **Behind a gate, and not active.** pim-computer runs this runtime only when `PIM_COMPUTER_TRIGGERS` is `internal`, which nothing sets: no install script, service or deployment, and an installed computer can't, since the Pim's install and update download `pim-computer.ts` alone ([Over pim-computer's connection](#over-pim-computers-connection)). Behind the gate it carries `triggers.v1` over pim-computer's own connection, with `poll`, `stream` and `process` observers ([triggers-adapters.md](triggers-adapters.md), [triggers-stream.md](triggers-stream.md)) and the host's grant check. **Nothing in Pim speaks it yet**: no route or Durable Object sends it a frame, so even with the gate on nothing runs. What the space must do is [below](#what-the-space-must-do).

Triggers (see [triggers.md](triggers.md)) keep the space's Durable Object as the authority: it stores each trigger, decides which computer sources run, and admits what they observe. This runtime is the other end, on the person's computer. It runs the computer sources (`poll`, `stream`, `process`, `file`) the space wants, and only those; fences anything a stopped or replaced observer still emits; and holds observations in a bounded spool on disk until the space has durably taken them.

| Part | What it is |
| --- | --- |
| `parseServerMessage`, `sourceConfigHash` | The `triggers.v1` protocol: messages from the space, read from untrusted JSON; the digest a source's configuration is consented to under |
| `ObservationSpool` | The transport spool: a journal of observations and gaps not yet settled by the space |
| `TriggersRuntime` | Reconciles observers with what the space wants, under a lease, with grants checked by the host |
| `ObserverAdapter` | What an observer implements: `poll` and `process` in [triggers-adapters.md](triggers-adapters.md), registered nowhere; fakes for the rest |

The runtime consumes `PollSource`, `StreamSource`, `ProcessSource` and `FileSource` from [`src/triggers/spec.ts`](../src/triggers/spec.ts) as types only, so the file stays loadable in Node alone, as pim-computer is. It changes nothing in `src/triggers/`.

## Authority

**One owner, from configuration.** A runtime is constructed with one `binding`, `{ space, runtimeId }`, from the computer's own configuration: in pim-computer, the token it connects with ([Binding](#over-pim-computers-connection)). A reconcile carries a binding too, but only to be checked: one that differs is refused (`binding_mismatch`) and changes nothing. Observations carry no space at all; the space a message belongs to is the connection it came in on. Nothing an adapter emits can set an envelope field: what it observed is nested under `data`, and a `data.sourceId` or `data.spaceId` is just data.

**One connection at a time.** The host attaches a transport with a `connectionId` it got from its handshake with the space. Every message from the space names that connection; a message for another connection, or arriving on one that was detached, is refused or ignored.

**Nothing given in can change later.** What an adapter emits is copied into frozen plain JSON the moment `emit` is called, before anything waits: each field is read once, and a getter, a symbol or non-enumerable property, a non-plain object, a number that isn't finite, more than 8 levels or more than 16,384 values is refused (`invalid`). So what is checked, sized, written and sent is the same thing, whatever the adapter does with its own objects afterwards. Messages from the space are frozen as they are read, so the source and grant an adapter or the host's check is given can't be changed either, and the spool hands out only frozen entries.

**Grants are consent, not a sandbox.** Observers run as the user who runs pim-computer, with that user's access. A grant says the person consented to one source's exact configuration; it confines nothing. A custom script in a poll or a stream can do anything that user can, and nothing here says otherwise.

**Default deny.** Before an observer starts, and again on every reconcile that keeps it, the runtime asks the host's `authorize` check with the binding, trigger, source identity, generation, `configHash`, the source and the grant. Only a verdict of exactly `{ ok: true }` allows it; any other value, a throw, or no check configured denies it. A grant is an opaque reference and a digest of its scope (`grantRef`, `scopeHash`), never a credential, and nothing copies a credential into the protocol or the spool.

**Any change of what runs needs consent again.** `configHash` is `sourceConfigHash(source)`: a SHA-256 digest over every field of the source, so the command, path, working folder, interval, deadline and events are all part of it. The runtime recomputes it and refuses a source whose hash doesn't match (`invalid`, health `config_hash_mismatch`). A host's check that keys consent on the exact `(grantRef, scopeHash, configHash)` therefore can't carry an approval over a change of content, frequency or scope. A changed grant or scope on the same generation stops the running observer (`consent_changed`) and checks the new grant before anything starts.

## Protocol `triggers.v1`

Every frame is one JSON object with `protocol: "triggers.v1"` and a `type`. Frames from the space are read strictly: unknown fields, unknown types, wrong types and out-of-range numbers are refused with an `error` frame that carries only a code (`invalid`, `unsupported_protocol`, `too_large`). Frames from the space may be up to 1 MiB (4 MiB at most).

**Every frame the runtime sends is within `frameBytes`** (64 KiB, configurable down to 1 KiB), control frames included, and none is ever cut. Ids in the protocol (`triggerId`, `sourceId`, `connectionId`, `runtimeId`, `space`, a process `handle`) are printable ASCII other than `"` and `\`, at most 160 characters; a `grantRef` may take 256 and is never sent back. So every control frame and gap fits in 1 KiB however long its ids and numbers: the largest possible, a gap with every reason, takes under 800 bytes. A frame that somehow wouldn't fit is dropped and logged (`control_too_large`), never truncated. The answer to a reconcile is split into numbered parts (below). An observation that wouldn't fit is refused when emitted (`too_large`), and one spooled under a larger `frameBytes` than the runtime now has is given up with a `too_large` gap rather than sent.

### From the space

| Type | Fields | Means |
| --- | --- | --- |
| `reconcile` | `binding`, `connectionId`, `serverEpoch` (≥ 1), `desiredRevision`, `leaseMs` (1 to 120,000), `sources` (up to 256) | The whole set of computer sources the space wants running now, and a lease on it. The same `desiredRevision` again must say exactly the same (`divergent_reconcile` otherwise) |
| `ack` | `connectionId`, `serverEpoch`, `durable: true`, `results` (up to 1,024) | What the space did with observations and gaps, sent only after its own write is durable |

Each desired source is `{ triggerId, sourceId, revision, generation, configHash, source, grant: { grantRef, scopeHash }, checkpoint }`. `sourceId` is the store's source identity (`<triggerId>#<revision>`), `revision` the revision the source was set in (its suffix), `generation` the trigger's generation, and `checkpoint` (`{ position, cursor }` or null) what the space has durably taken, for a new observer to resume from. Each trigger appears at most once. **A generation fixes its source:** the same trigger and generation with another `sourceId`, `revision` or `configHash` is refused (`invalid`, health `generation_mismatch`) and stops its observer; only the grant may change within a generation.

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
| `reconciled` | `serverEpoch`, `desiredRevision`, `leaseMs`, `part`, `parts`, `sources[]` of `{ triggerId, sourceId, generation, state }` | After each reconcile it took, in `parts` frames numbered from 1, each within `frameBytes`, with every source in exactly one, in order. **Only all the parts together acknowledge the reconcile**; a newer answer replaces any part of an older one still queued. `state` is `starting`, `running`, `ended` (below), `stale` or `invalid` |
| `installed` | `serverEpoch`, `triggerId`, `sourceId`, `generation`, `configHash` | When an observer's `start` has returned. Always before its first observation and its `listening` health |
| `health` | the same, `status` (`ok`, `degraded`, `error`), `code` | `listening`, `resumed`, `backpressure`, `auth_denied`, `start_failed`, `start_timed_out`, `unsupported`, `config_hash_mismatch`, `generation_mismatch`, `spool_unavailable`, `loss_unrecorded`, or an adapter's own code. Codes only, never text |
| `stopped` | the same, `reason`, `adapter` | When this generation's own adapter was asked to stop. `adapter` is `returned`, `timed_out`, `failed` or `not_started`. **It never says a process or anything the adapter started was cancelled or undone** |
| `observation` | `serverEpoch`, `eventId`, `triggerId`, `sourceId`, `revision`, `generation`, `sequence`, `occurredAt`, `data`, `checkpoint`, `coalesced` | Each spooled observation, until settled |
| `gap` | `serverEpoch`, `eventId`, `triggerId`, `sourceId`, `generation`, `sequence`, `reasons`, `from`, `to` | Each recorded break or loss, until settled. A null source is the whole spool's |
| `error` | `code` | A frame from the space refused: `invalid`, `unsupported_protocol`, `too_large`, `binding_mismatch`, `wrong_connection`, `stale_epoch`, `stale_reconcile`, `divergent_reconcile`, `spool_unavailable` |

A gap's `reasons` count why: `interrupted` (no observer of the source ran from `from` to `to`), `coverage_unknown` (an observer started at `to`, and nothing is known of before, as after a restart), and, for observations seen but never to be sent, `overflow`, `too_large`, `expired`, `epoch_replaced` and `corrupt`. Coverage gaps merge only with each other, and the rest with each other, one of each per source, generation and epoch until sent, so each keeps a time range that means one thing.

`sequence` is the runtime's own, increasing and never reused; observations and gaps share it, and each keeps its `eventId` and `sequence` through every retransmission and restart. An `eventId` is random, or, when the adapter gives a stable `key` (such as a file's inode and change counter), a digest of the source identity and the key, so a re-read event is a `duplicate` at the space.

Control frames (`hello`, `reconciled`, `installed`, `health`, `stopped`, `error`) go before observations in every flush and are not kept across connections: after a reconnect, the next `reconciled` says where every source stands, and the durable gaps say what coverage was lost. At most `control` (1,024) are held; past that the oldest health goes first. **What an observer reports is labelled with the epoch it started in**, and goes only to a connection the space has reconciled on while that epoch is current: an observer of a replaced epoch that finishes stopping, or finishes starting, reports nothing, rather than something that could be read as the new epoch's.

## Lifecycle

**Reconcile is idempotent.** The space sends the whole desired set. For each trigger, an observer with the same source identity, generation, `configHash` and grant keeps running (its grant is checked again); anything else is stopped and the new one started. A trigger left out is stopped (`not_desired`): pausing, ending and deleting all look like that here. An older generation than one already seen is `stale` and changes nothing. A reconcile with an older `desiredRevision` in the same epoch is refused; the same one again only renews the lease and checks grants again.

**Leases.** A reconcile holds for its `leaseMs`, 120 seconds by default and at most, counted on the runtime's own clock from when it arrives, so clock skew doesn't matter. Observers keep running, and spooling, while disconnected, until the lease runs out; then every observer is stopped (`lease_expired`) and only a new reconcile starts them again. The space stops admitting on its own side independently.

**One observer per trigger, fenced by generation.** A trigger has at most one observer at a time. Stopping one fences it at once: from that moment its `emit` returns `stopped`, its health is ignored, its `AbortSignal` fires, and its `stop` is called, even if its `start` hasn't returned. The next generation's `start` waits until the old `stop` has returned, failed, or timed out (`stopTimeoutMs`, 10 s). A `start` that returns after its observer was stopped reports nothing. The runtime only ever calls `stop` on the adapter it made for that generation; it never finds or stops anything by name.

**Installation before listening.** An observer is `installed` once its `start` has returned and its coverage gap is durable (below); until then its emissions are refused (`not_started`). A `start` that throws, or doesn't return within `startTimeoutMs` (30 s), is reported as health `start_failed` or `start_timed_out`, never as installed, and its adapter is stopped. Its grant is checked before it starts, and whether it is still its trigger's observer in the current epoch is checked again after the check, after `start`, and after the gap is written.

**Coverage is reported, not inferred.** Every observer, before it is installed, durably records a gap for its source: `interrupted` from when the trigger's previous observer stopped (by lease, revocation, reconfiguration, epoch or anything else), or from when the runtime paused it if it was stopped before being resumed (nothing it saw since was taken), or from its recorded end (below), to now, or `coverage_unknown` when this runtime knows of no previous one, as after a restart. Its sequence is lower than anything the new observer emits, and it is sent no later, so the space learns of the break before the first observation after it, even if the `stopped` frame was lost while disconnected. A gap that can't be written stops the observer (`spool_unavailable`) and is tried again on the next start.

**Ending.** An observer whose source has ended for good, such as a stream whose command exited, says so through `config.endCoverage({ at, code })` once it has emitted everything it saw before the end. The runtime records it in the queue, so nothing else changes the observer, the epoch or the spool meanwhile, and answers:

- `recorded`: **one commit** has written a gap of its own, `interrupted` from `at` to now, and the generation's **end record** (trigger, source identity, generation, `configHash`, `at`, `code`); only then is the observer stopped (`stopped` with reason `ended`), health `error` with its code sent, and the trigger's coverage counted as broken from `at`, so a later generation's gap starts there, not at the stop. The end gap is never merged into another gap, so its window keeps its meaning, and its sequence follows everything the observer emitted.
- `not_started`: it isn't installed yet; nothing is recorded, and the adapter tries again. `at` is bounded to between its installation and now: the gap written at installation already covers what came before.
- `unavailable`: the commit failed; nothing changed (no record, no gap, the observer still runs, a previous generation's record kept), and the adapter may try again.
- `stopped`: the observer is fenced, by a stop, a lease, a reconcile or a new epoch, before or while the end was recorded. An end that became durable while it was being stopped still holds.
- `invalid`: not an integer `at` and a health code.

One call per observer is outstanding at a time: a repeat while one is waits on the same answer, so callers can't pile up, and once recorded every later call is `stopped`. **The same generation never runs again.** A reconcile that wants it, on this connection or another, after the lease ran out, in a new epoch or after a restart, answers `ended` for it, sends its code as health, and starts nothing; only a new generation, which the space makes on every change of lifecycle or source, starts the source again, and its installation gap removes the old end record in the same commit. An end that was never recorded is unknown after a restart, so the space's reconcile starts that generation again, after a `coverage_unknown` gap, as it does any other.

**Epochs.** `serverEpoch` names the space's current session with this computer. The same epoch on a new connection resumes it: everything unsettled is sent again, unchanged. A higher epoch replaces it: every observer is stopped (`epoch_replaced`), and then **one commit** sets the new epoch, takes out every older entry unsent, and writes the gaps that count them in the new epoch (`epoch_replaced`, with an old gap's own counts carried over). **The old epoch goes quiet first:** before the change starts, the connection stops counting as reconciled, so no observation of the old epoch is sent or sent again, and every report of the old epoch still queued is dropped. If that commit can't be written, nothing of it happened: the epoch, and the old entries, stay as they were, held and unsent, nothing is reported as reconciled (`error` `spool_unavailable`), nothing more of the old epoch goes out on that connection, and the next reconcile tries again. Once it succeeds, only the new epoch is heard of. Observations are never replayed into a new epoch. A lower epoch is refused (`stale_epoch`).

**Restarts.** Nothing on disk starts an observer. After a restart the runtime sends `hello` and waits; the spool's entries are sent only after the space reconciles on that connection in their epoch, and an observer starts only if that reconcile still wants it and the host's check still allows it. It resumes from the space's checkpoint in the reconcile, not from anything local, and old commands are never re-run on the strength of a file.

**Checkpoints.** An observation can carry a checkpoint. The adapter's `commit(checkpoint)` is called only when the space has settled (`accepted`, `duplicate` or `rejected`) every earlier observation of that observer, so it never passes one still unsettled or deferred. What an observer is waiting on is kept as a list of its unsettled entries, with each settled stretch between them merged into one item, so it holds at most about twice its entries in the spool. **A loss is a barrier:** once an observer has an entry expire or discarded, or has an emission refused (`backpressure`, `too_large`, `spool_unavailable`), it commits nothing more and keeps nothing to; only a new observer, starting from the checkpoint the space gives in a reconcile, moves on.

**What it keeps is bounded.** Per trigger, the runtime keeps one observer, its generation's identity and when its coverage last stopped, only while the latest reconcile wants the trigger or its observer is still stopping; a trigger left out is forgotten once its observer has stopped. A trigger forgotten and wanted again starts with `coverage_unknown`.

## The spool

**What it is.** A journal in one file, `journal`, in a directory the host names. **Each commit is one line:** 16 hex digits of the SHA-256 of its JSON, a space, and the JSON, which puts, replaces and removes entries and may set the epoch. A line is applied whole or not at all, so a commit that does several things (a coalesced snapshot replacing older ones, gaps written with the removal of what they count, a new epoch) is never half-applied. Every write is synced (`datasync`) before it counts, and an observation is written, with its `eventId` and `sequence`, before it is ever sent.

**Retention is transport only.** The spool is not history, not a log, and not a raw sample: raw samples stay off (see triggers.md). An entry leaves when the space settles it, when its time to live runs out, or when its epoch is replaced. Until then it holds what an observer saw, which can be sensitive, as plain JSON on the person's disk, for at most 24 hours.

**Leaving the spool, leaving the file.** Removing an entry appends a line, so its bytes stay in the file until the journal is rewritten. The runtime rewrites it (a new file, synced and renamed over the old) within `scrubAfterMs` of an entry leaving: 60 seconds by default, at most 10 minutes. Expiry and epoch replacement rewrite it in the same commit, so what expired is out of the file when it expires. Closing the runtime and opening the spool rewrite it too. `scrubAfterMs` is a grace period for cleaning up, not an erasure: a rewrite that fails, as on a full or failing disk, leaves the bytes where they are and is tried again after `blockedRetryMs`, and stays visible while it does, as `retiredBytes` above zero on the spool and `scrub_failed` in the log. That is as far as it goes: the old file's blocks are freed, not overwritten, and a journaling or copy-on-write filesystem, an SSD, swap, snapshots or backups may keep copies the runtime can't reach. There is no secure erase. The directory is made `0700` and the journal `0600`, wider modes found are narrowed, a symlinked or foreign-owned path is refused (`unsafe_path`), and files are opened with `O_NOFOLLOW`. That keeps other users of the machine out; it is not isolation from the user pim-computer runs as, or anything that user runs. Source configurations, commands and grants are never written to the spool.

**Bounds.** At most 32 MiB and 24 hours (`maxBytes`, `ttlMs`), configurable lower, never higher; at most 100,000 entries. The journal never grows past `maxBytes`: before an append would, it is rewritten with only what is live, through `journal.tmp`, synced and renamed over it. Part of it (`reserveBytes`, `reserveEntries`) is kept for gaps, which observations can't use. An observation's data is at most 16 KiB as JSON, what the space's store takes, and its frame at most 64 KiB; a larger one is refused (`too_large`), never cut, and counted in a gap.

**End records.** The journal also keeps one end record per trigger (above), in the same lines as gaps: `ends` puts records and `unend` removes them, by trigger, applied with the rest of the line or not at all, and a rewrite copies them after the first line. They hold ids, a digest, two times and a code: nothing observed, no command and no grant. They are bounded (`MAX_END_RECORDS`, 1,024; past that, the oldest record of a trigger the runtime no longer keeps, or else the oldest, goes in the same commit) and count towards `maxBytes`. They leave when a newer generation of the trigger installs, not when settled or expired, since what they keep is that a generation is over. A journal written before end records existed reads as one with none. A runtime from before them reads a journal with them, ignoring them, and drops them on its next rewrite, after which an ended generation would run again on reconcile, with a `coverage_unknown` gap. A line whose records aren't exactly as above is corrupt, as any line that doesn't read.

**Crashes and corruption.** Opening reads every whole line whose digest matches. A last line cut short by a crash is cut off (`recovery.torn`), and a line whose digest doesn't match is skipped (`recovery.corrupt`). A write that fails part-way, such as on a full disk (`ENOSPC`), is cut back to the last whole line before anything else is written, and the emission is refused (`spool_unavailable`). Corrupt lines are counted in a gap with no source, sent in the spool's epoch; they stay in the file, and are counted again on every opening, until that gap is durable, in the commit that rewrites them out.

**Losses are durable before what they stand for goes.** Expired and discarded entries leave only in the same commit as the gaps that count them. If it can't be written, they stay, and an expired observation is still never sent; the sweep tries again after `blockedRetryMs`. A refused emission's count is kept in memory, one per source, until a commit can take its gap, and is tried again with every commit and after `blockedRetryMs` (health `loss_unrecorded` meanwhile). **That count is not durable**, and nothing claims it is: it is lost if the process dies first. What makes that acceptable is only this: the adapter was told its emission failed, so it keeps the event to emit again or replays it from its own source, and neither it nor the runtime moves a cursor past it (the barrier above).

**Overflow.** Nothing is dropped silently and no cursor moves past what wasn't kept:

- **Events** (`stream`, `process`, `file`): when the spool is full, the emission is refused with `backpressure`, the adapter's `pause` is called once, health goes `degraded`/`backpressure`, and a gap counts every refused emission (`overflow`, with the first and last `occurredAt`). The adapter must not move its own cursor past a refused event, and the runtime never commits past it (the barrier above). Once the space has settled enough that the spool is at most half full, `resume` is called and health goes `ok`/`resumed`. The gap is sent in sequence, after what was kept before it.
- **States** (`poll`): when the spool is full, the source's snapshots not yet sent may be folded into the newest one, which says so: `coalesced: { count, from, to }` is how many snapshots it stands for and over what time. A snapshot already sent is never folded or changed. If there is nothing left to fold, a state is refused as an event is.

**Time to live.** An observation held longer than `ttlMs` is taken out unsent, and a gap counts it (`expired`, with its time range). Nothing is fabricated in its place, and it is never sent later. Gaps themselves don't expire: they hold counts and times, nothing observed, and they merge, one per source, generation and epoch, until sent.

**Sending.** Each flush sends control first, then at most `batch` (32) due entries in sequence order. An unsettled entry is sent again after `resendAfterMs` (30 s), doubling up to `maxResendMs` (5 min); a new connection starts the backoff over. A transport that takes nothing waits `blockedRetryMs` (1 s). A flush always ends by setting a timer for a later instant, or none, so it never loops, and the runtime never reconnects on its own: that is the host's.

**Logging.** The runtime's `log` gets codes and counts only (`lease_expired`, `spool_expired`, `loss_unrecorded`, `ack_unknown`, `adapter_stop_timed_out`, ...), never what was observed, a command, a grant or an error's text. It writes nothing to the console. A log line is never how a loss is accounted for: that is always a gap.

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
| Same generation, different source | Refuses it, stops the observer (`invalid`) | `reconciled` `invalid`, `health` `generation_mismatch` |
| Same `desiredRevision`, different content | Refuses it; nothing changes, the lease isn't renewed | `error` `divergent_reconcile` |
| Id not plain ASCII, or over 160 characters | Refuses the message | `error` `invalid` |
| Answer to a reconcile larger than a frame | Splits it into numbered parts | `reconciled` parts 1 to `parts` |
| Source changed (new generation) | Fences and stops the old (`reconfigured`), starts the new after its stop | `stopped`, `installed` |
| Older generation offered | Nothing | `reconciled` `stale` |
| `start` throws or times out | Stops that adapter | `health` `start_failed` / `start_timed_out`, `stopped`, never `installed` |
| Stopped while `start` runs | Calls `stop` at once; a late `start` reports nothing | `stopped` |
| `stop` never returns | Reports it after `stopTimeoutMs`; the old generation stays fenced | `stopped` `timed_out` |
| Emission after stop, or before installation | Refused; nothing written | Nothing |
| Paused, ended or deleted | Stops the observer (`not_desired`); spooled entries are still sent | `stopped`, then `rejected` acks for what it won't take |
| Disconnected | Keeps observing and spooling until the lease ends | Retransmission on reconnect |
| Lease runs out | Stops every observer (`lease_expired`) | Nothing until it reconnects and reconciles; then a durable `gap` (`interrupted`, from the stop to the restart) before any new observation |
| Reconnect, same epoch | Sends everything unsettled again, same ids and sequences | Duplicates are `duplicate` |
| New epoch | Stops everything; in one commit sets the epoch, drops older-epoch entries unsent and records them | One `gap` (`epoch_replaced`) per source |
| New epoch, commit fails | Keeps the old epoch and its entries, unsent; drops its queued reports | `error` `spool_unavailable` only, no `reconciled`, nothing of the old epoch, even when its resend falls due; the next reconcile tries again |
| Old epoch's observer stops or starts late | Reports nothing of it | Nothing |
| Observer finishes starting on a connection not yet reconciled | Reports nothing until the reconcile | `reconciled` `running` |
| Older epoch | Refuses it | `error` `stale_epoch` |
| Restart | Starts nothing; waits for a reconcile | `hello` with `lastEpoch` and `pending`; each observer started after it records `coverage_unknown` |
| Observer ends for good | Records its gap and end record in one commit, then stops it | `gap` (`interrupted` from the end), `health` with its code, `stopped` `ended` |
| End before installation | Records nothing (`not_started`); the adapter tries again | The end, once installed, from the installation |
| End can't be written | Changes nothing (`unavailable`); the adapter tries again | Nothing until it is written |
| Ended generation wanted again | Starts nothing, on any connection, epoch or restart | `reconciled` `ended`, `health` with its code |
| Stopped while paused | Counts its coverage as broken from the pause | The next observer's `gap` (`interrupted`) from the pause |
| Ack out of order, duplicated, mismatched or for another epoch | Settles only exact matches in this epoch; checkpoints commit in order | Nothing |
| `deferred` ack | Keeps the entry, sends it again later | The same observation again |
| Crash part-way through a write | The cut line is dropped on opening, so its whole commit is | Nothing; the emission was never `ok` |
| Adapter changes its object after `emit` | Nothing: the runtime copied it when `emit` was called | The observation as emitted |
| Write fails (disk full) | Cuts back to the last whole record; refuses the emission | `health` `spool_unavailable` |
| Corrupt line | Skipped on opening; rewritten out once its gap is durable | `gap` with no source, `corrupt` |
| Spool full, events | Refuses with `backpressure`, pauses the adapter | `health` `backpressure`, a `gap` (`overflow`) |
| Spool full, states | Folds unsent snapshots into the newest | `observation` with `coalesced` |
| Older than `ttlMs` | Takes it out unsent, in the commit that records it and rewrites the file | `gap` (`expired`) |
| Older than `ttlMs`, commit fails | Keeps it, never sends it, tries again | `gap` (`expired`) once it can be written |
| Spool full, even for a gap | Refuses the emission; keeps the count in memory | `health` `loss_unrecorded`, then the `gap` once there is room |
| Entries settled | Rewrites the file without them within `scrubAfterMs` | Nothing |
| Rewrite fails | Leaves the bytes, tries again, keeps `retiredBytes` above zero | Nothing; `scrub_failed` in the log |
| Entry spooled under a larger `frameBytes` | Gives it up unsent, never cut | `gap` (`too_large`) |
| Data over 16 KiB or frame over 64 KiB | Refuses it, never cuts it | `gap` (`too_large`) |
| Transport takes nothing | Waits `blockedRetryMs` | Nothing until it does |

## Over pim-computer's connection

[`computer/triggers-host.ts`](../computer/triggers-host.ts) builds the runtime inside pim-computer and carries its frames over the WebSocket pim-computer's token opened (`/api/computer/connect`). pim-computer's part is `loadTriggers` and a few calls in `main`.

**The gate.** `PIM_COMPUTER_TRIGGERS=internal`, exactly; any other value, or none, is off. Nothing sets it: `install` gives its service only the variables it names, the loop service drops every `PIM_` variable, and the Pim's install script and `update` download `pim-computer.ts` alone, so an installed computer has no `triggers-host.ts` to load and runs no triggers whatever its environment says (it logs that their runtime couldn't start). **Off, pim-computer behaves exactly as before**: it imports only Node's own modules as values and loads the host with `import()` only behind the gate, so it makes no file or folder, adds no process or socket listener, starts no timer, and sends and reads exactly what it did; a triggers message from the space goes to the `Link`, which ignores its type, as it does today.

**The envelope.** Each frame is one text message, both ways: `{"type":"triggers","frame":`, the frame exactly as written, and `}`. Nothing is escaped, re-encoded or cut, so a message from the computer is at most `frameBytes` + 28 bytes (65,564), and a frame from the space over `inboundBytes` (1 MiB) is refused whole (`error` `too_large`). pim-computer takes every message that starts with that prefix as triggers, whatever follows, and never gives it to the `Link` or its log of commands; the runtime's strict parser reads what is between the prefix and the last character, so a malformed envelope is answered `error` `invalid`. Its `type` is one neither end acts on today: Pim's `Computer.receive` and pim-computer's `Link.receive` both drop it. The frames can't go bare: the runtime's `hello` has `type: "hello"`, which Pim would take for pim-computer's own and overwrite what it knows of the computer with.

**Connections.** Each socket that opens is a new runtime connection. After pim-computer's own `hello`, the host attaches the socket under a random UUID as its `connectionId`, and the runtime sends its `hello` with it; the space names it in everything it sends on that socket. A frame that comes on a socket that has closed is dropped, and one naming another id is refused (`wrong_connection`). While the socket holds more than 1 MiB unsent, the transport takes nothing and the runtime waits `blockedRetryMs`.

**Binding.** From the token, `pimc_<owner>_<secret>`: `space` is `<owner>` (`o_` and 26 characters, as `computerTokenOwner` in `src/computer.ts` reads it), and `runtimeId` is `rt_` and the first 32 hex digits of SHA-256 of `triggers.v1/runtime`, a newline, and the token's own SHA-256 in lower-case hex. The space keeps that digest of the token (`digestHex`), so it can compute the id without the token, and a new token is a new runtime, with a spool of its own. A token of another form runs no triggers.

**The grant check.** `exactSourceGrant` allows a source only when its kind is `poll`, `stream` or `process`, the request's binding is this computer's, `configHash` is `sourceConfigHash` of the source as given, and `grant.scopeHash` is exactly `grantScopeHash`:

```text
scopeHash = hex(SHA-256("triggers.v1/grant\n" + JSON.stringify({ configHash, grantRef, runtimeId, sourceId, space, triggerId })))
```

six strings, keys in that sorted order, no whitespace. A grant therefore names one source's exact configuration, for one trigger, on one computer, under one approval: a changed command, `cwd`, interval, deadline or handle (another `configHash`), another trigger or source identity, another computer, or another approval's reference is refused (`health` `auth_denied`), and no adapter is made and nothing launched. The generation is left out, so pausing and enabling a trigger, which make new generations of the same source, keep its grant. A `file` source is refused whatever its grant: nothing here observes it. The runtime asks before every start and on every reconcile, so a grant changed to one that doesn't name its source stops the observer (`consent_changed`).

**Where it keeps things.** In pim-computer's folder, `~/.pim-computer`: `triggers/` (made `0700`; a link or another user's folder is refused, and triggers stay off), the spool in `triggers/<runtimeId>/` ([The spool](#the-spool)), and `triggers/managed/`, the state folder process watches read. Nothing writes that one yet, so every process watch fails to start (`start_failed`).

**Observers.** `observerAdapters` with `poll` (`NodeChildLauncher`), `stream` (`NodeStreamLauncher`) and `process` (`FileProcessProvider`), each within the runtime's `stopTimeoutMs`. A poll or stream whose source names no `cwd` runs in pim-computer's root (`--root`, `~/pim`), with only the environment `pollEnvironment` keeps, so the token is never in it. Its command runs as the user who runs pim-computer, as `shell` calls do; the grant is consent, not a sandbox. The host tracks every child its launchers start until it exits.

**Stopping.**

- **The socket closes**: the runtime is detached. Observers keep running and spooling until the space's last lease runs out (at most 120 s), as apps keep running across a dropped connection; then each is stopped, its process group with it. A new socket starts nothing until the space reconciles on it.
- **SIGTERM or SIGINT**: `close` stops every observer and waits for their stops (each bounded: 4.1 s by default), takes retired bytes out of the journal and closes the spool, alongside the apps' stop; then pim-computer exits.
- **Replaced by another computer** (close code 4409): the same, then it exits 1.
- **Any exit** (`process.exit`, an uncaught error): SIGKILL, synchronously, to each tracked child's group that is still provably its own (its leader unreaped).

Nothing is signalled but a group these launchers started, and only while its leader is unreaped. A SIGKILL or SIGHUP of pim-computer (it catches neither) leaves a stream's command running under its leader; containing that would need cgroups or a parent-death signal, and isn't done.

**Tests.** `test/triggers-transport.node.test.ts`, in Node: the gate off for every value but `internal`, with no file, listener or timer made, pim-computer still importing only Node's modules, and a `Link` ignoring a triggers message; then on, through a fake socket, the real runtime and spool and fake launchers on a fake clock: the binding, a frame round trip for a stream and a poll, refused connections and epochs, grants allowed and refused (forged, another computer's, another trigger's, a changed source, a changed grant, a `file`), nothing launched before a grant or after a restart until the space reconciles, observers stopped when the lease runs out after the socket closes, the spool replayed with the same ids after a restart from its private folder with no command, grant or token in it, bounded frames both ways and a full socket waited out; and real children, a stream's process group ended at the lease after the connection drops and at exit, with a bystander process untouched.

### What the space must do

Nothing in Pim does this yet; `src/` is unchanged by the computer's side. For anything to run, the space's side of the computer connection must:

1. **Route the envelope.** Take each text message from the computer that starts with `{"type":"triggers","frame":` before any other handling (in particular before `hello`), never as a call, a reply or the computer's `hello`, and read the frame between the prefix and the last `}` as a runtime frame (the tables above). Send frames the same way, each within the runtime's `inboundBytes` (1 MiB unless the host sets less), on the socket they are for.
2. **Wait for the runtime's `hello`.** A computer speaks `triggers.v1` on a socket only once it has sent a triggers `hello` there. Check its `runtimeId` against the id computed from the stored token digest (Binding, above) and ignore the computer's triggers if it differs. Send nothing of triggers on a socket before its `hello`; an older pim-computer never sends one.
3. **Echo the connection.** Put that `hello`'s `connectionId` in every `reconcile` and `ack` sent on that socket, and on no other.
4. **Keep the epoch.** Keep `serverEpoch` durable per runtime id. Reuse it after a reconnect while the space's record of what it has taken is intact; otherwise move to a higher one, always above the `hello`'s `lastEpoch` (a lower one is refused `stale_epoch`). Observations are never replayed into a new epoch; their loss arrives as `epoch_replaced` gaps.
5. **Reconcile and renew.** Send `reconcile` with `binding: { space: <owner>, runtimeId }`, a `desiredRevision` that only grows within an epoch (the same one again only renews, and must say exactly the same), `leaseMs` of at most 120,000, and every enabled computer trigger as a desired source ([Meeting the store](#meeting-the-store)). Send it again well within the lease while connected (every third of it, say): when the lease runs out the runtime stops everything. A source left out is stopped.
6. **Grant exactly.** Give each desired source `grantRef`, the approval's id (printable ASCII but `"` and `\`, at most 256 characters), and `scopeHash` computed as above, and only for an approval that is current and was given for exactly this source on this computer; `TriggerStore`'s `authorize` should check the same (proposed change 3 below). When a grant is revoked, leave the source out, or change its grant, in the next reconcile.
7. **Ack durably.** Ack each `observation` and `gap` only after its own write is durable, with its exact `sequence` and `eventId` ([Meeting the store](#meeting-the-store)); a retransmission carries the same ids and should be answered `duplicate`.
8. **Read status as status.** Take `reconciled` (all its parts), `installed`, `health`, `stopped` and `error` as codes for the triggers' health, never as observations; with no socket connected, the triggers are `waiting_computer`, and `reconnecting` from a new socket until its first complete `reconciled`.

## Meeting the store

When this is turned on, the space's side maps the protocol onto `TriggerStore` (`src/triggers/store.ts`) as it is, without changing it:

- An `observation` is `admit({ id: triggerId, generation, eventId, observedAt: occurredAt, payload: data, checkpoint })`. `accepted` acks `accepted`; `duplicate` acks `duplicate`; `backpressure` and `inbox_full` ack `deferred`; `not_found`, `deleted`, `stale_generation`, `not_enabled`, `wrong_source`, `out_of_order`, `too_old`, `expired` and a `TriggerValidationError` ack `rejected`. The ack is sent after `transactionSync` returns, so it is durable.
- A `gap` is `recordGap({ id: triggerId, generation })`, then acked, whatever its reasons, coverage gaps included. A gap with no source marks every computer trigger of the space. A `coalesced` observation should be admitted with `gap: true`, since what it stands for was never seen.
- `installed`, `health` and `stopped` map to `setHealth` (`healthy`, `configuration_error`, `auth_required`, ...), which carries codes only. A source `ended` in a reconcile's answer is over for that generation: nothing observes it until the space starts a new one.
- `reconcile` is built from enabled computer triggers: `sourceId` from `sourceState(id).identity`, `checkpoint` from its `position` and `cursor`, `configHash` from `sourceConfigHash`.

The spool's time to live (24 hours at most) is well inside the store's replay horizon (7 days), so a retransmitted observation is never `too_old` because the runtime held it, and its `occurredAt` is the same on every delivery, as `admit` requires.

### Proposed changes to shared modules

None of these are made here; they are for whoever owns those modules to accept or refuse.

1. **Export the source reader.** `src/triggers/spec.ts` reads a source in `parseSource`, which isn't exported, so the runtime checks a source's shape on its own (`readSource`) and relies on the space having checked its bounds. Exporting `parseSource`, or a `parseComputerSource`, would let both ends read one way, if the runtime may import it as a value.
2. **One digest of a source.** The space has to compute the same `configHash` as `sourceConfigHash` here (SHA-256 of `"triggers.v1/source\n"` and the source as JSON with sorted keys), and the host's check, and the approval that fills `authorizationRef`, should key consent on it. The same goes for `grantScopeHash` (`computer/triggers-host.ts`), which the approval that gives a grant must compute. Putting both beside the spec would keep the ends from drifting.
3. **Name the generation the grant was checked for.** The store's `AuthorizationRequest` has no `configHash` or scope digest; adding them would let the approval and this runtime's check agree on exactly what was consented to.

## Not done here

The space's side of the protocol ([What the space must do](#what-the-space-must-do)) and of the store's grants (proposed changes above), a way to turn the gate on for real (an install option, a Pim setting), a managed launcher for process watches, `file` observers, containing a stream's command after a SIGKILL of pim-computer, and process watches beyond Linux. Each is its own change, and this file is the contract they meet.
