# The viewer-first preview: the Worker's half

The Worker and web app side of the viewer-first single-user preview (`docs/cua-viewer-first-preview.md`, milestone 2, items 4 to 7): the client to the bridge's viewer host, the space's durable observation ledger, the person's routes, and a Watch desktop action. **Only the preview composes it.** A deployment mounts no route, constructs no desk and provisions no ledger: `serve` mounts `/api/observations` only when the preview passes `{ observations: true }`, and the preview does that only while its private environment opts into the Cua fixture. **Nothing here has been run, type-checked, linted or tested.** The tests below are written for an independent source audit before anything runs.

The host's half is separate and not merged here: `review/linus-cua-viewer-first-20261027` at `917fa25` (the management API frozen in `a142011`'s `docs/cua-viewer-first-preview.md`, with `3bdf5bb`'s shutdown addition; `917fa25` changed only a test since). Its source was accepted at `917fa25`, its fake-host tests passed 29 of 29 at `917fa25` and its fake-journal tests 17 of 17 at the unchanged `3bdf5bb`, each run independently. Those are its own stand-ins: no live host and no route has been qualified, and the earlier failed run (143 of 144) and the stalls nobody diagnosed stay on the record. This client is written against that frozen API. Merging the two will conflict in `preview/cua-viewer-first.ts`'s header comment, which both changed.

## What is wired

```diagram
 Browser (owner's session) ──▶ preview Worker: serve(…, { observations: true })
                                  │ /api/observations/…: session only; bodies ≤ 4 KiB; media refused (503)
                                  ▼
                               preview Pim (the fixture's space only) ──▶ ObservationDesk
                                  │ ledger under cua_observations: written, then storage.sync(), before the host is asked
                                  ▼
                               CuaViewerClient ──▶ POST <bridge path>/observations/{launch,end,status}  (bridge bearer + x-pim-space)
                                               └─▶ /<hostLaunchId>/viewer/… and calls               (no bridge token; the launch's own credential)
```

| Piece | Where | What it does |
| --- | --- | --- |
| Client | `src/cua-viewer.ts` | `CuaViewerClient`: the three management calls, and the viewer's files and calls carried to one launch. No media socket. |
| Desk | `src/cua-observation-runtime.ts` | `ObservationDesk`: the ledger stored and restored, the person's routes, and the mapping of the host's answers to ledger events. |
| Mount | `src/gateway.ts` | `serve(request, env, ctx, mounts)`: `/api/observations/…` only when `mounts.observations`, from a browser session, to the owner's space with its full path. `src/index.ts` passes nothing. |
| Composition | `preview/worker.ts` | The preview's `Pim` makes a desk only in the space the fixture seeded while the environment still names it, and answers `/api/observations/…` there; every other space answers `404`. |
| Provisioning | `preview/cua-fixture.ts` | The seed's one transaction also writes the empty ledger. It is the only place one is written. |
| Watch desktop | `web/src/components/computer-settings.tsx` | Under an operator's Cua computer in Settings → Computer, shown only when `GET /api/observations` answers. |

## The person's routes

All need the owner's browser session (`x-pim-signed-in`, set only by the Worker). An API or OAuth token, an `Authorization` header or a `token` query is `401`. Answers are `no-store`, `no-referrer`, `nosniff`.

| Route | What it does |
| --- | --- |
| `GET /api/observations` | `{ agent, blocked, observations }`: newest first, each `{ id, status, notAfter, evidence }`, never a launch id, generation or viewer path. |
| `POST /api/observations` | Watch. With nothing unresolved: records `open_requested` with `crypto.randomUUID()` and `notAfter = now + 30 min`, flushes, then asks the host. With the one open record before its deadline: asks the host for that key again, which starts nothing new and gives back the same page. Otherwise `409`, naming the record. Answers `{ observation, viewer }`, where `viewer` is `/api/observations/<id>/viewer/#ticket=…&clipboard=0`, for this answer only. |
| `POST /api/observations/<id>/end` | Records `revoke_requested`, flushes, asks the host to end. `202` is a request, not closure. A record still `pending_open` (its launch being recorded or asked for) is `409`, unchanged: its answer names what to end, and revoking it first would leave a record no answer can settle. An `unconfirmed` record whose launch is known is asked to end again, once per request, and stays `unconfirmed` whatever the host answers; one whose launch was never named is `409`, and nothing is asked. |
| `GET /api/observations/<id>` | Asks the host for the launch's status. Only the read on which the host observed closure records it: `state` `closed_observed`, this record's launch id and exact generation, and `launch` present with `phase` `closed` and no unconfirmed stream. A lost answer changes nothing. |
| Anything else under `/api/observations/<id>/` | `admitObservationRequest`, then the client: the viewer's pinned files (`GET` only) and its seven calls (`POST`). The media socket (`media?ticket=…`), once admitted, is `503` and nothing is sent: see "The media socket is refused". Everything else is `404` or `405`, and nothing is sent. |

`POST` needs `Origin` to be the Pim's address.

## How the host's answers are recorded

| Host's answer | Ledger |
| --- | --- |
| `503` (the manager threw, or the host is shutting down), with or without `retry-after` | `unconfirmed` (launch, end): the host doesn't say what it did; nothing (status): the person is answered `503` with the host's `retry-after`, and nothing asks again |
| No answer, a timeout, a redirect, a status other than `200`, `503` and the refusals below, a type other than JSON, more than 16 KiB, or anything that isn't exactly one of the launch manager's answer types | `unconfirmed` (launch, end); nothing (status) |
| `400`, `401`, `403`, `404`, `405`, `413`, `415`: the host refused before reading the request | `not_opened` (launch); nothing (end, status) |
| `launched`, for this key and deadline, not replayed | `open_acknowledged` |
| `launched` for this key with another deadline, or `replayed` for a new key | `open_acknowledged`, then `unconfirmed` |
| `refused` (`blocked` included, as while the host shuts down), `start_failed` | `not_opened` |
| `unconfirmed`, or an answer for another key | `unconfirmed` |
| End: `requested`, or `final` `closed_observed` | stays `revoking` |
| End: anything else, `unconfirmed` included (as while the host shuts down) | `unconfirmed` |
| Status: `found` `closed_observed` for this launch and exact generation, with `launch.phase` `closed` and `launch.unconfirmed` 0 | `closed_observed` |
| Status: `found` `closed_observed` without that launch read (the host recorded closure on a read whose answer Pim didn't see, and no longer holds the launch) | `unconfirmed`: not closure here, and it can't be shown again |
| Status: `found` `unconfirmed`, `start_failed` or `reconciled`, another launch or generation, `not_found`, `generation_mismatch` | `unconfirmed` |

**Revalidation after every wait.** A flush is a wait, and another request may fail its own flush, or change the record, meanwhile. After a launch's flush, the host is asked only if the ledger isn't blocked and the record is still exactly the intent stored: `pending_open`, the same deadline, no launch. After an end's flush, only if the ledger isn't blocked and the record is still unsettled with the same launch and generation. Otherwise nothing is sent (`503` if blocked, `409` or the record as it is otherwise). Watching the open record again hands its page out only if, once the host answers, the record is still that launch, open, before its deadline and unblocked.

**Cancellation.** Every viewer request for a record, the presence stream included, is tied to that record's cancellation. When the record leaves `open` (an end requested, a lost answer, a conflict, closure) or the ledger blocks, its requests in flight are aborted and its answers being passed on end, before the host is asked anything. The observation is admitted again (same record, still `open`, same launch and generation, before its deadline, ledger not blocked), with the clock read anew each time: after the browser's body is read and immediately before the request leaves, and after the host answers, before anything is handed to the browser. A file or call answer for an observation no longer admitted is dropped (`404`).

**Bounded waits.** No wait depends on the fetch's own abort: each is raced against a timer and the cancellation, and the timer and listeners are removed however it ends (`settle`, `linked` in `src/cua-viewer.ts`). A management call has one 25 s bound over its request, headers and every read of its body. A body Pim stops reading is cancelled and its lock released; a cancel that doesn't settle within `CLEANUP_MS` (1 s) is left and logged `cua.viewer.cleanup_unsettled`, so what it holds is visible rather than awaited. An answer that comes after Pim stopped waiting is let go: its body cancelled. The gateway gives an observation request's body 10 s (`408` past it), and a viewer call's body is read against the observation's cancellation and the call bound before the host is asked.

Limits and tombstones stay as `src/cua-observation.ts` has them: nothing is evicted, retired or reset. While any record is unresolved, no new observation starts (`VIEWER_FIRST.openObservations` is 1), so no fresh id escapes an uncertain one. A ledger that is missing, unreadable, another owner's or another version blocks every observation and is left as it is. A write or flush that fails blocks the desk for the life of the instance. Records left `pending_open` or `revoking` come back `unconfirmed` at the next start.

**There is no way out in this preview.** The ledger is Pim's authoritative record, and its records and tombstones stay in the space that wrote them, durably and as they are, as history. A blocked or unsettled ledger stays so: nothing here reconciles, resets or replaces it. Disposing of the preview's disposable resources (the VM, the host's journal, the bridge) settles nothing the ledger holds, and never permits a new observation, a replay, or a fresh space, journal or identity to watch past it (`docs/cua-viewer-first-preview.md`, "Loss is not recovered in this release", and its rule that Pim's records of uncertainty are authoritative). Settling such records needs a separate, explicitly reviewed migration or reconciliation, which doesn't exist yet.

## What the client sends and passes back

- **No automatic retry anywhere.** No management call, viewer request or socket is sent again by the client or the desk; the web app's actions are mutations, which don't retry. Only the person asks again.
- **Management:** `POST`, `Authorization: Bearer <bridge token>`, `x-pim-space`, `content-type: application/json` exactly, no encoding, no query, the manager's request type as JSON, at most 4096 bytes; `redirect: manual`; 25 s in all; never retried. The answer must be `200` with `content-type` exactly `application/json`. Nothing requires the host to name the space back on these answers, and the host doesn't.
- **Files and calls:** to `https://<bridge host>/<hostLaunchId>/…` (22 characters), files by `GET` and calls by `POST` only, never with the bridge's token or any `Authorization`. Only `content-type`, `x-cua-env-authorization`, `grpc-encoding` and `content-encoding` are carried; call bodies at most 4 KiB. Answers keep only `content-type`, `grpc-status`, `grpc-message`, `content-security-policy`, `cross-origin-resource-policy`, `x-content-type-options` and `referrer-policy`, and only the statuses `200`, `400`, `401`, `404`, `405`, `413` and `415` (others are `502`). Files are capped at 512 KiB and unary calls at 257 KiB; the presence stream at the observation's deadline. Files and calls have 30 s; the presence stream 30 s for its headers.
- **Media: refused.** See below.
- **Logs:** only `cua.viewer.lost`, `cua.viewer.refused`, `cua.viewer.unavailable`, `cua.viewer.unreachable` and `cua.viewer.cleanup_unsettled`, with an action, kind or what was being cleaned up, and a status or outcome. Never a target, token, viewer path or anything the host said.

## The media socket is refused

The desk answers an admitted media upgrade `503` and asks the host for nothing, so the viewer opens without the desktop's picture, and the Watch desktop card says so. A relay in the Worker would read the host's socket as fast as it comes and send each message on to the browser. A Worker's socket shows nothing of what it holds unsent (`WebSocket` here has no `bufferedAmount`), so a slow browser would make the Worker buffer without bound. The host can't bound that either: its `MAX_BROWSER_BUFFERED_BYTES` measures its own socket to the Worker, which the Worker drains as fast as it can. Nothing here claims a bound it doesn't have, so media stays off until a relay with a bound the platform supports exists.

A candidate, not tried: answer the browser with the host's socket itself, unaccepted, so that the runtime joins the two sockets and, if its own pump waits on each send, the host sees a slow browser as its own socket backing up. Whether the runtime does that, documents it, and does it from a Durable Object is unconfirmed. It would also give up the Worker's own checks on each message (text only up, sizes) and its ending of the relay when the ledger blocks, leaving those to the host's own bounds, its deadline and its end. That is a decision for review, with a measurement, before any of it is built.

## The viewer's frame

The dialog shows the viewer in an `iframe` at `/api/observations/<id>/viewer/`, which is this app's own origin. That is trust, not isolation: the viewer's pinned script runs with the app's origin and could reach anything the app's pages can, so it is trusted as pinned code (its files are the host's pinned set, and the client passes on only their content security policy and a few other headers). The frame has no `sandbox`. Its `allow` attribute denies the microphone, camera, clipboard and screen capture, which only stops the viewer asking for them. The launch's page turns the clipboard off (`clipboard=0`), the media socket that would carry microphone input is refused, and nothing reaches files. Nothing here isolates the viewer from the app or the person's computer.

## Where this differs from the host's plan

- The management answers are read without requiring `x-pim-space` back; the host's plan doesn't send it.
- The host serves media; the Worker refuses it (above).
- `admitObservationRequest` (`src/cua-observation.ts`) still admits `HEAD` on a file. The client narrows it to the host's: `HEAD` is `405`, with nothing sent. The admission check itself is unchanged.
- The host's status answers `launch: null` once it has recorded closure and dropped the launch. A Worker that lost the answer of the read that observed closure can't see it again, so that record stays `unconfirmed`, and no procedure here settles it.
- The client mirrors the launch manager's types in `src/cua-viewer.ts` rather than importing them, since the Worker doesn't load the Node host's modules. A change on either side must change both.

## Stand-in model and real agents

The listing says which drives the space's agents (`agent`, `preview/cua-viewer-first.ts`):

- **`stand-in`** (the preview's default model): it acts only on the person's `/tool <name> {json}` lines, such as `/tool shell {"command": "ls"}`, and the approval it files is the person's. Watching then shows the wiring (shell, files and Chrome reaching the VM beside the viewer), not an agent working by itself. The Watch desktop card says so.
- **`real`**: a model chosen in Settings (a ChatGPT plan or the person's own provider). Only this mode can show an agent acting while watched. No real model has driven a Cua VM here.

## Unchanged

The ordinary shell, files and Chrome through pim-computer, approvals and the control state are as they were: the desk reads and writes nothing of the control state, takes no lease and admits or blocks no agent request. Native-app tools, the optional Cua child and takeover stay off. Sprites stay as they are, for migration; nothing here adds a Sprite feature or a provider abstraction.

## Tests (written, not run)

Only these files, each run on its own, one after another. All are stand-ins in the test's own runtime: a `fetch` written in the test stands for the viewer host, and nothing reaches the network.

| File | Lane | Tests | Imports added |
| --- | --- | --- | --- |
| `test/cua-observation.test.ts` | prerequisite (`vitest.cua-prerequisite.config.ts`) and the whole suite | 29 (11 before, 18 added) | `vi`; `ObservationDesk`, `type ObservationStorage` from `src/cua-observation-runtime`; `type ClientLimits`, `CuaViewerClient`, `MAX_CALL_REQUEST_BYTES`, `parseEndAnswer`, `parseLaunchAnswer`, `parseStatusAnswer`, `readBounded` from `src/cua-viewer` |
| `test/preview-cua-fixture.test.ts` | stand-in (`vitest.cua-standin.config.ts`) and the whole suite | 11 (9 before, 2 added, 3 extended) | `initialObservationState`, `type ObservationState` from `src/cua-observation`; `OBSERVATION_KEY` from `src/cua-observation-runtime`; `SIGNED_IN_HEADER` from `src/pim` |
| `web/src/components/computer-settings.test.tsx` | `pnpm --filter pim-web test` | 4 (3 before, 1 added) | `type Observations` from `~/lib/pim-api` |

Neither lane's file list changes. None of these files names the tests' Chrome, its binding or live checks, and none opens a WebSocket.

What they check:

- The client reads only the manager's exact answer types, and treats extra fields, other types, a wrong viewer path, a redirect, a server error, non-JSON and oversize as lost.
- The ledger is stored and flushed before the host is asked, and the viewer's credential is never stored or listed.
- Missing, unreadable, other-owner and other-version ledgers block without being recreated; a failed write asks nothing.
- A lost answer leaves the record unconfirmed, and no new observation starts past it; a refusal before acting does let the next one start.
- Watching again asks for the same key; a different launch makes the record unconfirmed and conflicting.
- An end is a request; a lost status changes nothing; only the host's read that observed closure (this launch, exact generation, `phase` `closed`, nothing unconfirmed) closes it. Another launch or generation, no launch snapshot, a launch still closing, an unconfirmed stream or `generation_mismatch` leave it unconfirmed.
- An admitted media upgrade is `503` with nothing sent; another observation's is `404`.
- An end of an unconfirmed record with a known launch is asked again and leaves it unconfirmed; with no launch named, `409` and nothing asked.
- The host's shutdown answers: a launch `refused` `blocked` lets the next start; a status `503` changes nothing, passes `retry-after: 5` on and is asked once; an end `unconfirmed` makes the record unconfirmed and stops new observations. A launch `503` is lost.
- Management answers whose type isn't exactly `application/json` are lost; `HEAD` is refused before sending.
- Records restore conservatively; at the limit nothing is evicted.
- Viewer requests reach the launch at the host's root with only the allowlisted headers and no bridge token; redirects, oversize bodies, other paths, tokens and non-session callers are refused before sending.
- Held flushes: a launch whose flush succeeds after another launch's or an end's flush failed sends nothing; an end of a record still starting is `409` and changes nothing, and that launch is then sent once.
- A viewer call whose body never ends sends nothing: `404` once the observation is ended, `408` at the call bound.
- A management answer that never comes, or a `200` whose body stops halfway and whose cancel never settles, is lost (`timeout`) within the bound and leaves the record unconfirmed; `readBounded` stops a stalled read at its signal and reports, and logs, a cancel that didn't settle.
- In the preview: the seed provisions the ledger in its transaction (and keeps none of it when the ledger's write fails, or when a ledger is already there); the owner's session watches through the bridge with the bearer on management only; the control state keeps the agent's lease; a seeded space whose ledger is gone fails closed; other spaces, and the space once the environment stops naming it, answer `404`.
- The Watch desktop card shows only where offered, says view only and that the agents continue, says the picture isn't shown yet, names the stand-in model, and disables watching while a record is unsettled or the ledger is blocked. An unconfirmed record offers "Ask to end it", never "Stop watching".

Not covered: the production gateway with no mount (only by reading `src/index.ts` and `serve`), a real browser rendering the viewer in the dialog (its frame's `allow` included), and anything against a real host.

## Remaining qualification blockers

1. **The host's half is unmerged, its source accepted and its tests passed only against its own fakes** (29/29 fake host at `917fa25`, 17/17 fake journal at `3bdf5bb`), and no journal is provisioned, so every launch is refused (`blocked`) until one is. The two halves have never met: nothing has checked this client against those routes by running them.
2. **Nothing here has run**: no type check, lint, test or build. The tests above are the audit's starting point, not evidence.
3. **No picture: the media socket is refused** until a relay with a bound the platform supports exists ("The media socket is refused"). Without it the viewer is not a working viewer. That page's blocker 2 says the Worker pipes media "under backpressure"; nothing here can. Behind that, also from blocker 2: whether `fetch` with `Upgrade` from a Durable Object to the bridge works at all, shows `sec-websocket-protocol`, and carries 16 MiB packets.
4. **The viewer in a browser**: the pinned viewer has never run in the dialog's frame against any adapter. Its content security policy, WebCodecs, audio and resizing there are untested, and so is the portal's rewrite of the address for the media socket.
5. **No recovery**: a preview space seeded before this change has no ledger and stays blocked; a blocked or unsettled ledger stays so. Disposing of the VM, the journal or the bridge doesn't change that, and no new space, journal or identity is a way past it. Settling it needs a separate, reviewed migration or reconciliation.
6. **Restart and reconcile**: unconfirmed records stay so; there is no operator procedure to reconcile them, and none is offered here.
7. **Cleanup that doesn't settle**: a cancel left after `CLEANUP_MS` is only logged. Whether workerd's own streams and sockets ever hold one, and what a held one costs a Durable Object, is unmeasured.
8. **A real agent**: only the stand-in model has been considered. Whether a real model's ordinary tools behave on the VM while it is watched is unqualified.
9. **The real VM, spacesd, certificates and the root token's place** (blockers 1, 3 and 4 of the preview page).
