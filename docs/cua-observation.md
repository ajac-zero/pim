# Cua display observations (unmounted)

An observation is a person watching one display of their Cua computer through the view-only viewer adapter (`docs/cua-viewer-adapter.md`): the full display, `VIEW_ONLY`, `OBSERVE_ONLY`, no clipboard, files or microphone, restricted gRPC-Web, no datagrams and no presence `Leave`. Three pieces prepare for it. **None is mounted or enabled:** nothing calls them, they add no route, setting, binding, storage or credential, the host doesn't start them, and importing any of them does nothing.

| Piece | Where | What it is |
| --- | --- | --- |
| The observation ledger | `src/cua-observation.ts` | A space's record of its observations: a pure reducer, like the control state. |
| The admission check | `src/cua-observation.ts` (`admitObservationRequest`) | Whether a browser request may reach an observation, and where on the host. A function, not a route. |
| The launch manager | `computer/cua-host/viewer-launch-manager.ts` | Starts the adapter's launches at most once per observation, through a journal that outlives the host process. |

A deployment still mounts none of them. The local preview alone now composes the ledger, for the one space its Cua fixture seeded, behind the owner's browser session (`docs/cua-viewer-first-worker.md`). The viewer goes from that browser straight to the host, so nothing calls the admission check. Routing the host to the launch manager is on the host's own review branch, not merged here.

## Observation is not control

`src/computer-control.ts` treats every viewer as input-capable and admits one (`viewer_open_requested`) only while the human owns the application. That rule, and the control state's owner and epoch, are unchanged. The observation ledger is separate: it imports nothing from the control state and the control state reads nothing of it. An observation can't grant input, claim a pause or takeover, change whether an agent request is admitted, or settle a request whose outcome is unknown. It can be open while the agent owns the application, and an unconfirmed observation keeps no agent out. Closing an observation's transports is not quiescence of the desktop.

## The ledger

`ObservationState` is `{ version: 1, owner, records }`. Each record has a fixed `owner` and `observationId` (16 to 64 of `A-Z a-z 0-9 _ -`, such as `crypto.randomUUID()`), an immutable `notAfter` (Unix milliseconds Pim set, at most 4 hours ahead), the host's `hostLaunchId` and `hostGeneration` once acknowledged (never replaced), a `status`, and the `evidence` the caller gave for its latest change.

| Status | Means | Leaves by |
| --- | --- | --- |
| `pending_open` | Recorded before the host is asked. | `open_acknowledged` → `open`; `open_refused` → `not_opened`; `unconfirmed`; `revoke_requested` |
| `open` | The host acknowledged a launch in a generation. | `revoke_requested`; `unconfirmed`; `closure_observed` |
| `revoking` | Its end was requested. Not closure. | `unconfirmed`; `closure_observed` |
| `unconfirmed` | What the host holds is not known: a lost reply, a timeout, a restart, another generation, a second launch. Asking for its end leaves it so. | `closure_observed` (unless it saw two launches); `reconcile` → `reconciled` |
| `closed_observed` | Final. The host reported that every transport of this launch, in this generation, reported itself closed. | — |
| `not_opened` | Final. The host started nothing for it. | — |
| `reconciled` | Final. An operator settled an unconfirmed record, with evidence. Not an observation. | — |

- **Ids are never reused.** `open_requested` with an id the ledger holds is refused (`duplicate_id`) whatever its record says, since the first may have reached the host.
- **Closure is the host's observation, for the right launch.** `closure_observed` must name the record's launch (`launch_mismatch`) and generation (`generation_mismatch`). Losing a reply, asking for an end, or reaching `notAfter` never makes a record closed.
- **A late acknowledgment names what to close.** On a `pending_open` record it opens it; on a `revoking` or `unconfirmed` one it records the launch and leaves the status as it was. On a `not_opened` or `reconciled` record, a launch that wasn't expected makes the record `unconfirmed`.
- **Two launches stay unconfirmed.** A second, different acknowledgment is refused (`conflicting_launch`), and is the one refusal that changes state: the record becomes `unconfirmed` and is marked `conflicting`, so seeing one launch close can't settle it. Only `reconcile` does.
- **Limits refuse, never evict.** At most 2 records that aren't final, and 32 in all; past either, `open_requested` is refused (`limit`). Nothing retires final records yet.
- **Restore.** `restoreObservationState(raw, owner)` refuses a missing ledger, another owner's, another version, an id or record that is malformed or repeated, a status its launch fields contradict, and a final or unconfirmed record without evidence. More unresolved records than the limit are kept, since a late acknowledgment of a final record can reach that. `pending_open` and `revoking` come back `unconfirmed`, as the process that wrote them may have died either side of asking the host. `open` stays open: a restart of the space says nothing about the host. A missing ledger is not an empty one: only a space known never to have had one starts from `initialObservationState`.

## The launch manager

`openViewerLaunchManager({ adapter, store, generation, rootToken, wallClock, timers, startTimeoutMs })` reads the journal and answers a manager with `launch`, `end`, `status`, `blockers` and `reconcile`. Its key is the ledger's `observationId`; owner and `notAfter` come with the first request and are fixed by it.

**Idempotency comes before the side effect.** The adapter's `startLaunch` mints a spacesd viewer ticket and answers an in-memory `LaunchHandle` that nothing can look up again. So `launch` stores the key's `intent` durably before calling it, and never calls it for a key already in the journal:

- A repeat while the first start is in progress shares its answer. A repeat after it gets the same launch id and viewer path back while this process holds the launch and it is live (`replayed: true`).
- Otherwise a repeat gets `refused` (`conflict` for another owner or `notAfter`, `closed` once closure was observed or reconciled), `start_failed`, or `unconfirmed`. None of them starts anything.

| `launch` answers | Meaning | Ledger event |
| --- | --- | --- |
| `launched` | The launch is open, with its id, generation, `notAfter` and viewer path. | `open_acknowledged` |
| `refused` | Nothing was started for this request. After `storage`, the intent may be stored and is found unconfirmed after a restart. | `open_refused` |
| `start_failed` | No launch is held: the deadline passed before the start, or the adapter refused. A viewer ticket the adapter minted may last until `notAfter`; it was never answered to anyone. | `open_refused` |
| `unconfirmed` | A launch may exist and none is offered: `timeout`, `storage`, `ended`, `earlier_generation`, or `unconfirmed`. | `unconfirmed` |

- **The request is copied before anything waits.** `launch` takes a frozen copy of the request's own data fields before its first wait and uses only that copy from then on, so changing the caller's object while the intent is stored changes nothing. The copy must be a plain object with `key`, `owner`, `notAfter` and optionally `displayName`, and nothing else. Accessors, symbols, other prototypes and values of another type (a string or `Number` deadline, for one) are refused (`invalid`), not read or converted. So is a proxy whose traps throw, or one that was revoked: those requests are answered, never rejected. `end` and `status` copy their requests the same way, and answer `not_found` to anything malformed.
- **Timeouts and late results.** A start that hasn't answered within `startTimeoutMs` (15 s by default) is stored and answered `unconfirmed`. If it answers later, the launch is ended at once, since nobody was given its page; its id is recorded, and a later `status` can observe its closure. If it fails later, the entry stays `unconfirmed`.
- **A launch the journal can't name is not handed out.** If storing `open` fails, the launch is ended and the answer is `unconfirmed`.
- **An end requested while the intent is being stored** cancels the start before the adapter is called, so nothing is minted. The entry becomes `start_failed`, and the request is answered `start_failed`.
- **An end requested during the start** ends the launch as soon as it comes, or at once if it came and is being stored, and the request is answered `unconfirmed` (`ended`), with no viewer path. A start answered `unconfirmed` on its timeout can't be reconciled until the adapter's call settles.
- **`end` requests; `status` observes.** `end` calls the launch's `end()` and stores `ending`. Ending comes first, and it still happens after the journal has failed. `status` reads the launch. Only a read where its phase is `closed` (every transport it took or refused reported itself closed) and no presence stream is `unconfirmed` stores `closed_observed`, with the launch's `cleanup` counts in the evidence. Those counts are `CloseMedia` requests and spacesd's answers, not closures. `status` returns the snapshot: transports by kind, refused, close failures, sessions, unconfirmed streams and cleanup.
- **The deadline is read once.** `notAfter` is converted with `lifetimeUntil` against the wall clock just before the start, and the launch's monotonic deadline is fixed from there (`docs/cua-viewer-lifetime.md`). A `notAfter` that has passed, or is more than 4 hours ahead, is refused before anything is stored; one that passes while the intent is being stored makes the entry `start_failed` without a start.
- **Generations.** Each process has its own `generation`. On start, every entry an earlier generation left unresolved becomes `unconfirmed`, with evidence naming that generation: its transports may still be open upstream, and nothing here can see them. A request naming another generation is answered `generation_mismatch`. A journal that already names the current generation blocks.
- **Owners.** `end` and `status` for another owner's key answer `not_found`, as for a key that doesn't exist.
- **Limits refuse, never evict.** At most 4 entries that aren't final, starts in progress included, and 64 in all. Nothing retires entries yet.
- **Credentials.** `rootToken()` is read for each launch and passed to `startLaunch`; without one, the launch is refused before anything is stored. The root token is never stored, returned or logged. The journal holds keys, owners, deadlines, generations, launch ids, states and evidence; never a viewer path, which carries the launch's credential and is answered only to the request that started the launch and its repeats. The manager logs nothing.

### The journal store and its atomicity

`JournalStore` is `{ read, write }`, injected. The manager serializes its own writes and awaits each before acting on it. The contract, which the store must keep and which no implementation here provides:

- `read()` answers the stored journal parsed, `undefined` when none is stored, and rejects when it can't read.
- `write(journal, expectedRevision)` replaces the journal at `expectedRevision` atomically and durably. When it resolves, every later read by any process gives this journal or a later one. A crash during it leaves the old journal or the new one whole: write a temporary file, flush it, rename it over the old one, flush the directory. It rejects if the stored revision has moved, so a second writer is refused.
- A rejected write says nothing about which journal is stored. The manager then refuses every launch for the rest of its life. `end` still ends the launches it holds, though it can't record that.

What follows from it: no upstream side effect precedes a durable intent, so after a crash the journal holds the intent of any key whose start may have begun. A restart finds that intent, or the `open` written after the start, and makes it `unconfirmed`. It never starts the key again.

**Missing, unreadable or invalid journals block, and are left as they are.** No store, a read that fails, a journal that is malformed, of another version, or inconsistent: every launch is refused, with the reason in `blockers()`, and nothing is written, for the life of the process and every process after it.

**The manager never creates a journal.** A missing journal can't be told from a lost one, and a lost one took with it the keys that must never start again. Repeats of a key are expected (a lost reply is answered by resending it), and evidence that nothing is open retires no key and doesn't stop a delayed request. So a missing journal never authorizes a launch, and no evidence string recovers one. A journal is provisioned outside this module, under its own gate (see Remaining blockers).

An operator's `reconcile(key, evidence)` settles an `unconfirmed` entry that this process holds no launch for, and that has no start still pending. A reconciled key is final, and a repeat of it is refused (`closed`): reconciling never lets a key start.

## The admission check

`admitObservationRequest(request, caller, ledger, now, publicOrigin)` answers either the host target, `/<hostLaunchId>/<rest>`, or a status to refuse with. It reads only what it is given:

- **Only the person's browser session.** `caller` is what the gateway established: the owner from the session it checked, never from the request, and `viaSession`. No caller, an API, OAuth or query token (`viaSession: false`), or a session with an `Authorization` header or `token` query is `401`. The launch's own credential (the viewer's `#ticket=`, sent as `x-cua-env-authorization`) is the host adapter's to check, and is not authentication here.
- **Only the owner's open record.** A ledger of another owner, a missing record, or one that isn't `open` with an acknowledged launch, or is at or past its `notAfter`, is `404`, so another owner learns nothing. A record that is revoking is refused though the host may still be live.
- **Only canonical targets** under `/api/observations/<id>/`: `viewer/` and the viewer's five pinned files (`GET` or `HEAD`); the seven calls the adapter answers (`POST`; `Leave`, `UpdateCursor`, `CreateViewerTicket` and every other method are `404`); and `media?ticket=<attach token>` as a WebSocket upgrade, with no other query. Nothing percent-encoded, no empty segments, and no query elsewhere.
- **Only from this app.** Writes and sockets must carry `Origin: publicOrigin`; a file read may omit it. `Sec-Fetch-Site` other than `same-origin` or `none` is `403`. A socket must offer exactly `rcdp.v2` (`400` otherwise); a non-upgrade to `media` is `426`.

`observationResponse(response)` sets `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`, and returns a `101` as it is.

## What mounting needs later

The host's side (item 3 below, apart from the provisioned journal) is now written: `docs/cua-viewer-first-preview.md` has the frozen management API, the journal store's single-writer lock and the test allowlist. So is the Worker's, for the preview only, on the direct path, which differs from the list below: the browser reaches the host's viewer itself, so there is no viewer route, upgrade or admission check on the Worker, only management (`docs/cua-viewer-first-worker.md`).

Mounting is a separate, reviewed change. `src/gateway.ts` and the space's routes are untouched here: the gateway's upgrade allowlist is still `/ws` and the browser's live view only. A mount needs at least:

1. **A narrow gateway route** for `/api/observations/`, checked with `signedIn` (session and same-site checks) and never `authorize`'s token path, passing the session's owner to `admitObservationRequest` and to `toAgent`, which overwrites the owner and signed-in headers. One more entry in the upgrade allowlist, for `media` only. No generic proxy to the host.
2. **The space's ledger**, stored per space and written synchronously before the host is asked, as `src/computer-control-runtime.ts` stores control, with an opt-in marker so a missing ledger is told from a new one. The space mints `observationId` and sets `notAfter`; a client's retry must find its record rather than make a second.
3. **The host's side**: a real `JournalStore` keeping the contract above, a provisioned journal (see Remaining blockers), a fresh generation per process, a narrow host route through the bridge to `launch`, `end` and `status`, and the adapter's routes as `docs/cua-viewer-adapter.md` describes.
4. **Delivery of the viewer path.** Its fragment is the launch's credential: it goes only to the owner's session, is never logged, and is answered with `no-store` and `no-referrer`. Request targets carry attach tokens and must not be logged either.

## Remaining blockers

- **Restart.** A host that dies leaves spacesd's media sessions and the viewer ticket it minted to their own lifetimes. The ticket lasts until `notAfter` at most, and an attached media session until its socket closes. Nothing here revokes either, or sees them after a restart, so those entries stay `unconfirmed` until an operator reconciles them. The operator procedure, and what evidence counts, is not written.
- **Journal provisioning and loss.** Nothing here creates a journal, so a host can't launch until one is provisioned, and after a loss it stays blocked. Provisioning has its own gate, not written here. A fresh journal must not let any key from before start again: that needs a durable, never-reused admission namespace bound into every key and request, with every earlier namespace refused for good, or an equivalent retirement authority. Operator evidence alone is not enough.
- **Retirement.** Neither the ledger nor the journal retires final records. Both refuse at their limits, so retiring them (with tombstones, so an id can't come back) is needed before real use.
- **Credentials.** Where spacesd's root token lives, and how it is kept from agents running as the desktop account, is still open (`docs/cua-viewer-adapter.md`). The tests use a string.
- **Not run.** Neither test file below has been run, and nothing here has been type-checked.

## Tests

`test/cua-observation.test.ts`, which runs in the whole Worker suite (`vitest.config.ts`) but not in the Cua stand-in lane, whose nine files are unchanged. It covers the ledger and the admission check alone, with requests built in the test:

- An observation opens, becomes unconfirmed, and changes nothing while the agent owns the application. The control state's `viewer_open_requested` still needs the human.
- Repeated ids are refused, and deadlines never move.
- Lost and late replies, and requested ends, don't count as closure. Closure for another launch or generation is refused.
- Conflicting acknowledgments are settled only by reconciliation.
- The limits refuse rather than evict.
- Restore is conservative and refuses what it can't trust.
- Admission covers sessions, tokens and owners, canonical targets, `Origin`, `Sec-Fetch-Site` and subprotocol, the state and deadline races, and the response headers.

`computer/cua-host/test/viewer-launch-manager.test.ts`, part of `pnpm --filter pim-cua-host test`. Its stand-in adapter answers real `ViewerLaunch`es on a clock and timers the test turns by hand, and its store is a string in memory that each write replaces whole. It covers:

- Concurrent and later repeats.
- Conflicts and other owners.
- Intent writes that fail before or after they land.
- Crashes before the start answered and after it was acknowledged. A test's crash severs that process's view of the store and fails its unanswered adapter calls, so its waits settle. Nothing it does after dying reaches the journal, and the old launch is still not claimed closed.
- Missing, lost, unreadable, invalid and same-generation journals. After a loss, restarts in three generations find no way to reinitialize, and try `reconcile` with evidence, `status`, `end`, a delayed request for the prior key sent before the loss and still within its deadline, and a resend of that key: none calls the adapter, and nothing recreates the journal.
- A second writer.
- A launch that can't be recorded.
- Timeouts with late success and late failure.
- An end while the intent is being stored, which calls the adapter zero times.
- An end during the start, and one while the launch is being stored.
- A caller changing its request while the intent is being stored, and requests with accessors, symbols, other prototypes, unknown fields, values of another type, throwing proxy traps, or a revoked proxy.
- Requested ends against observed closure, with `CloseMedia` answers and unconfirmed streams.
- The deadline read once.
- The limits.
- A missing root token, refused starts, and ending after the journal failed.

No socket, server, file, process, browser or real timer is involved, and no real credential.
