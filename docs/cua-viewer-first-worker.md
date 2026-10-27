# The viewer-first preview: the Worker's half

The Worker and web app side of the viewer-first single-user preview (`docs/cua-viewer-first-preview.md`, milestone 2, items 4 to 7): the client to the bridge's viewer host for launching, ending and reading observations, the space's durable observation ledger, the person's management routes, and a Watch desktop action that opens the viewer **directly on the host**. **Only the preview composes it.** A deployment mounts no route, constructs no desk and provisions no ledger: `serve` mounts `/api/observations` only when the preview passes `{ observations: true }`, and the preview does that only while its private environment opts into the Cua fixture. **Nothing here has been run, type-checked, linted or tested.** The tests below are written for an independent source audit before anything runs.

The host's half is separate and not merged here: `review/linus-cua-viewer-first-20261027` at `917fa25` (the management API frozen in `a142011`'s `docs/cua-viewer-first-preview.md`, with `3bdf5bb`'s shutdown addition; `917fa25` changed only a test since). Its source was accepted at `917fa25`, its fake-host tests passed 29 of 29 at `917fa25` and its fake-journal tests 17 of 17 at the unchanged `3bdf5bb`, each run independently. Those are its own stand-ins: no live host and no route has been qualified, and the earlier failed run (143 of 144) and the stalls nobody diagnosed stay on the record. This client is written against that frozen API. Merging the two will conflict in `preview/cua-viewer-first.ts`'s header comment, which both changed.

## What is wired

```diagram
 Browser (owner's session) ──▶ preview Worker: serve(…, { observations: true })
   │                               │ /api/observations…: management only; session; Origin on writes; no body, no socket
   │                               ▼
   │                            preview Pim (the fixture's space only) ──▶ ObservationDesk
   │                               │ ledger under cua_observations: written, then storage.sync(), before the host is asked
   │                               ▼
   │                            CuaViewerClient ──▶ POST <bridge path>/observations/{launch,end,status}  (bridge bearer + x-pim-space)
   │
   └─ iframe, direct HTTPS ──▶ https://<bridge host>/<hostLaunchId>/viewer/…, calls, media
                                (the launch's own credential; no bridge token, no Pim login)
```

| Piece | Where | What it does |
| --- | --- | --- |
| Client | `src/cua-viewer.ts` | `CuaViewerClient`: the three management calls, and `viewerUrl`, the viewer's address on the host. It carries nothing of the viewer. |
| Desk | `src/cua-observation-runtime.ts` | `ObservationDesk`: the ledger stored and restored, the management routes, and the mapping of the host's answers to ledger events. |
| Mount | `src/gateway.ts` | `serve(request, env, ctx, mounts)`: `/api/observations…` only when `mounts.observations`, from a browser session, to the owner's space with its full path, without a body. `src/index.ts` passes nothing. |
| Composition | `preview/worker.ts` | The preview's `Pim` makes a desk only in the space the fixture seeded while the environment still names it, and answers `/api/observations…` there; every other space answers `404`. |
| Provisioning | `preview/cua-fixture.ts` | The seed's one transaction also writes the empty ledger. It is the only place one is written. |
| Watch desktop | `web/src/components/computer-settings.tsx` | Under an operator's Cua computer in Settings → Computer, shown only when `GET /api/observations` answers. Opens the viewer's address in a cross-origin frame. |

## The person's routes

All need the owner's browser session (`x-pim-signed-in`, set only by the Worker). An API or OAuth token, an `Authorization` header or a `token` query is `401`. A `POST` whose `Origin` isn't the Pim's address is `403`. Answers are `no-store`, `no-referrer`, `nosniff`. The gateway passes no body and no socket on: a body is cancelled unread, an upgrade is `404`.

| Route | What it does |
| --- | --- |
| `GET /api/observations` | `{ agent, blocked, observations }`: newest first, each `{ id, status, notAfter, evidence }`, never a launch id, generation or viewer address. |
| `POST /api/observations` | Watch. With nothing unresolved: records `open_requested` with `crypto.randomUUID()` and `notAfter = now + 30 min`, flushes, then asks the host. With the one open record before its deadline: asks the host for that key again, which starts nothing new and gives back the same page. Otherwise `409`, naming the record. Answers `{ observation, viewer }`, where `viewer` is `https://<bridge host>/<hostLaunchId>/viewer/#ticket=…&clipboard=0` (below), for this answer only. |
| `POST /api/observations/<id>/end` | Records `revoke_requested`, flushes, asks the host to end. `202` is a request, not closure. A record still `pending_open` (its launch being recorded or asked for) is `409`, unchanged: its answer names what to end, and revoking it first would leave a record no answer can settle. An `unconfirmed` record whose launch is known is asked to end again, once per request, and stays `unconfirmed` whatever the host answers; one whose launch was never named is `409`, and nothing is asked. |
| `GET /api/observations/<id>` | Asks the host for the launch's status. Only the read on which the host observed closure records it: `state` `closed_observed`, this record's launch id and exact generation, and `launch` present with `phase` `closed` and no unconfirmed stream. A lost answer changes nothing. |
| Anything else under `/api/observations/` | `404`, and nothing is sent: the viewer's page, files, calls and media are the host's. |

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

**Revalidation after every wait.** A flush is a wait, and another request may fail its own flush, or change the record, meanwhile. After a launch's flush, the host is asked only if the ledger isn't blocked and the record is still exactly the intent stored: `pending_open`, the same deadline, no launch. After an end's flush, only if the ledger isn't blocked and the record is still unsettled with the same launch and generation. Otherwise nothing is sent (`503` if blocked, `409` or the record as it is otherwise). Watching the open record again hands its viewer out only if, once the host answers, the record is still that launch, open, before its deadline and unblocked.

**Bounded waits.** No wait depends on the fetch's own abort: each is raced against a timer, and the timer and listeners are removed however it ends (`settle` in `src/cua-viewer.ts`). A management call has one 25 s bound over its request, headers and every read of its body. A body Pim stops reading is cancelled and its lock released; a cancel that doesn't settle within `CLEANUP_MS` (1 s) is left and logged `cua.viewer.cleanup_unsettled`, so what it holds is visible rather than awaited. An answer that comes after Pim stopped waiting is let go: its body cancelled.

Limits and tombstones stay as `src/cua-observation.ts` has them: nothing is evicted, retired or reset. While any record is unresolved, no new observation starts (`VIEWER_FIRST.openObservations` is 1), so no fresh id escapes an uncertain one. A ledger that is missing, unreadable, another owner's or another version blocks every observation and is left as it is. A write or flush that fails blocks the desk for the life of the instance. Records left `pending_open` or `revoking` come back `unconfirmed` at the next start.

**There is no way out in this preview.** The ledger is Pim's authoritative record, and its records and tombstones stay in the space that wrote them, durably and as they are, as history. A blocked or unsettled ledger stays so: nothing here reconciles, resets or replaces it. Disposing of the preview's disposable resources (the VM, the host's journal, the bridge) settles nothing the ledger holds, and never permits a new observation, a replay, or a fresh space, journal or identity to watch past it (`docs/cua-viewer-first-preview.md`, "Loss is not recovered in this release", and its rule that Pim's records of uncertainty are authoritative). Settling such records needs a separate, explicitly reviewed migration or reconciliation, which doesn't exist yet.

## Management: what the client sends

- **No automatic retry anywhere.** No management call is sent again by the client or the desk; the web app's actions are mutations, which don't retry, and the frame is never reloaded or relaunched by itself. Only the person asks again.
- **Management:** `POST`, `Authorization: Bearer <bridge token>`, `x-pim-space`, `content-type: application/json` exactly, no encoding, no query, the manager's request type as JSON, at most 4096 bytes; `redirect: manual`; 25 s in all; never retried. The answer must be `200` with `content-type` exactly `application/json`. Nothing requires the host to name the space back on these answers, and the host doesn't.
- **Logs:** only `cua.viewer.lost`, `cua.viewer.refused`, `cua.viewer.unavailable` and `cua.viewer.cleanup_unsettled`, with an action or what was being cleaned up, and a status or outcome. Never a target, token, viewer address or anything the host said.

## The viewer: straight from the browser to the host

The whole pinned viewer, its page, files, calls and media socket, goes from the person's browser to the host over HTTPS, never through the Worker. The host's adapter serves it at `/<hostLaunchId>/…` with relative routes and a content security policy whose `connect-src` is `'self'`, so the page reaches only its own host. Its media socket is the host's own, so the host's bound on what it holds unsent (`MAX_BROWSER_BUFFERED_BYTES`, Node's `bufferedAmount`) measures the real queue to the browser. Pim carries none of it: under `/api/observations/` the viewer's paths are `404`.

**The address.** `CuaViewerClient.viewerUrl` builds it from two things only: the origin of the space's configured bridge, which `bridgeAddress` has checked (HTTPS, no credentials, query or fragment, this space's), and the `viewerPath` the host answered, which must be exactly the adapter's for that launch: `/<launch id, 22 characters>/viewer/#ticket=<43 characters>&clipboard=0`. Anything else in the answer is lost, and no other host can appear in the address. The viewer is at the bridge's origin root, not under its management path.

**The capability.** The fragment's `ticket` is the launch's credential, which the host minted for this launch only after Pim recorded, made durable and asked for it on the owner's browser session. The viewer sends it on each call (`x-cua-env-authorization`), and the host exchanges it for a 43-character attach token for the media socket. It is a bearer capability: whoever holds the address can watch that launch until it ends, from any browser, and nothing binds it to the person's Pim session or to one media request. The browser carries no Pim login, cookie or token to the host, and the host knows nothing of Pim's session. Pim never holds a bridge or root token in the browser. The address is in the launch's answer only: the web app keeps it in the dialog's component state while it is open, and nothing stores or logs it (not the ledger, not the listing, not the Worker's logs). A fragment is not sent in requests or referrers, and the frame's `referrerPolicy` is `no-referrer`.

**Revocation and its bound.** Only the host revokes it: when it ends the launch (the end Pim asks for) and at the launch's absolute deadline, `notAfter`, at most 30 minutes after the observation was recorded. Ending the launch shuts its calls and media on the host. Closing the dialog removes the frame, which closes its sockets, and asks Pim to end the observation; neither is revocation. If that end's answer is lost, or the network is, nothing Pim or the page does can revoke the capability: the record becomes `unconfirmed` and is not shown as stopped, and the capability lasts until the host ends the launch or its deadline passes. That is the honest bound: `notAfter`.

**The frame.** The dialog shows the viewer in an `iframe` whose `src` is that address, another origin than the app's: the viewer can't reach the app's page, cookies or storage, and the app can't reach the viewer's. Its `allow` attribute grants no microphone, camera, clipboard or screen capture; the launch's page turns the clipboard off (`clipboard=0`), and the adapter is view only (`docs/cua-viewer-adapter.md`). The frame has no `sandbox`, and nothing here isolates the viewer from the person's computer beyond the browser's own origin boundary.

## Where this differs from the host's plan

- The management answers are read without requiring `x-pim-space` back; the host's plan doesn't send it.
- The host's plan has the Worker pipe media; here the browser reaches the host directly, and the Worker carries no viewer traffic.
- The host's viewer page sets no `frame-ancestors`, so any site can frame it. Restricting that to Pim's address is the host's to decide; nothing here relies on it either way.
- `admitObservationRequest` (`src/cua-observation.ts`) is unchanged and now unused: it was for viewer traffic through Pim.
- The host's status answers `launch: null` once it has recorded closure and dropped the launch. A Worker that lost the answer of the read that observed closure can't see it again, so that record stays `unconfirmed`, and no procedure here settles it.
- The client mirrors the launch manager's types in `src/cua-viewer.ts` rather than importing them, since the Worker doesn't load the Node host's modules. A change on either side must change both.

## Stand-in model and real agents

The listing says which drives the space's agents (`agent`, `preview/cua-viewer-first.ts`):

- **`stand-in`** (the preview's default model): it acts only on the person's `/tool <name> {json}` lines, such as `/tool shell {"command": "ls"}`, and the approval it files is the person's. Watching then shows the wiring (shell, files and Chrome reaching the VM beside the viewer), not an agent working by itself. The Watch desktop card says so.
- **`real`**: a model chosen in Settings (a ChatGPT plan or the person's own provider). Only this mode can show an agent acting while watched. No real model has driven a Cua VM here.

## Unchanged

The ordinary shell, files and Chrome through pim-computer, approvals and the control state are as they were: the desk reads and writes nothing of the control state, takes no lease and admits or blocks no agent request. Native-app tools, the optional Cua child and takeover stay off. Sprites stay as they are, for migration; nothing here adds a Sprite feature or a provider abstraction.

## Tests (written, not run)

Only these files, each run on its own, one after another. All are stand-ins in the test's own runtime: a `fetch` written in the test stands for the viewer host's management, and nothing reaches the network. None opens a WebSocket, renders the viewer or loads a frame.

| File | Lane | Tests | Imports added |
| --- | --- | --- | --- |
| `test/cua-observation.test.ts` | prerequisite (`vitest.cua-prerequisite.config.ts`) and the whole suite | 28 (11 before, 17 added) | `vi`; `ObservationDesk`, `type ObservationStorage` from `src/cua-observation-runtime`; `type ClientLimits`, `CuaViewerClient`, `parseEndAnswer`, `parseLaunchAnswer`, `parseStatusAnswer`, `readBounded` from `src/cua-viewer` |
| `test/preview-cua-fixture.test.ts` | stand-in (`vitest.cua-standin.config.ts`) and the whole suite | 11 (9 before, 2 added, 3 extended) | `initialObservationState`, `type ObservationState` from `src/cua-observation`; `OBSERVATION_KEY` from `src/cua-observation-runtime`; `SIGNED_IN_HEADER` from `src/pim` |
| `web/src/components/computer-settings.test.tsx` | `pnpm --filter pim-web test` | 4 (3 before, 1 added) | `type Observations` from `~/lib/pim-api` |

Neither lane's file list changes. None of these files names the tests' Chrome, its binding or live checks.

What they check:

- The client reads only the manager's exact answer types, and treats extra fields, other types, a wrong viewer path, a redirect, a server error, non-JSON and oversize as lost.
- The viewer's address is the bridge's origin (its port kept, its path dropped) and the adapter's exact path for that launch; another host, a protocol-relative or `@` path, another launch, `clipboard=1`, a query or `..` is refused, and an HTTP or other space's bridge makes no client.
- The ledger is stored and flushed before the host is asked; the viewer's credential is never stored or listed, and the bridge's token is in neither the ledger, the listing nor the browser's answer.
- Only management is answered: no session, an API token, or a write without this app's `Origin` is refused before anything is recorded or asked; the viewer's page, files, calls, media upgrade and a query are `404` with nothing sent.
- Missing, unreadable, other-owner and other-version ledgers block without being recreated; a failed write asks nothing.
- A lost answer leaves the record unconfirmed, and no new observation starts past it; a refusal before acting does let the next one start.
- Watching again asks for the same key; a different launch makes the record unconfirmed and conflicting.
- An end is a request; a lost status changes nothing; only the host's read that observed closure (this launch, exact generation, `phase` `closed`, nothing unconfirmed) closes it. Another launch or generation, no launch snapshot, a launch still closing, an unconfirmed stream or `generation_mismatch` leave it unconfirmed.
- An end whose answer is unconfirmed leaves the record unconfirmed, not stopped; asking again reaches the host and leaves it so; with no launch named, `409` and nothing asked.
- The host's shutdown answers: a launch `refused` `blocked` lets the next start; a status `503` changes nothing, passes `retry-after: 5` on and is asked once; an end `unconfirmed` makes the record unconfirmed and stops new observations. A launch `503` is lost.
- Management answers whose type isn't exactly `application/json` are lost.
- Records restore conservatively; at the limit nothing is evicted.
- Held flushes: a launch whose flush succeeds after another launch's or an end's flush failed sends nothing; an end of a record still starting is `409` and changes nothing, and that launch is then sent once.
- A management answer that never comes, or a `200` whose body stops halfway and whose cancel never settles, is lost (`timeout`) within the bound and leaves the record unconfirmed; `readBounded` stops a stalled read at its signal and reports, and logs, a cancel that didn't settle.
- In the preview: the seed provisions the ledger in its transaction (and keeps none of it when the ledger's write fails, or when a ledger is already there); the owner's session starts watching with the bearer on management only and gets the host's own viewer address, without the bridge's token; the viewer's path under Pim is `404` and nothing more is sent; the control state keeps the agent's lease; a seeded space whose ledger is gone fails closed; other spaces, and the space once the environment stops naming it, answer `404`.
- The Watch desktop card shows only where offered, says view only and that the agents continue, names the stand-in model, and disables watching while a record is unsettled or the ledger is blocked. An unconfirmed record offers "Ask to end it", never "Stop watching".

Not covered: the production gateway with no mount (only by reading `src/index.ts` and `serve`), the gateway's dropping of a body, a real browser loading the viewer in the frame (its `allow` included), and anything against a real host.

## Remaining qualification blockers

1. **The host's half is unmerged, its source accepted and its tests passed only against its own fakes** (29/29 fake host at `917fa25`, 17/17 fake journal at `3bdf5bb`), and no journal is provisioned, so every launch is refused (`blocked`) until one is. The two halves have never met: nothing has checked this client against those routes by running them.
2. **Nothing here has run**: no type check, lint, test or build. The tests above are the audit's starting point, not evidence.
3. **The browser reaching the host**: the bridge's origin must be reachable from the person's browser over HTTPS with a certificate it trusts, and the viewer's page must load in a frame under Pim's address. Neither is set up or tried (the preview page's blocker 3). The host's own media path to the browser (its `ws` server, `bufferedAmount` bound) has run only against fakes.
4. **The viewer in a browser**: the pinned viewer has never run in the dialog's frame against any adapter. Its content security policy, WebCodecs, audio and resizing there are untested.
5. **A leaked address is a bearer capability** until the host ends the launch or `notAfter` passes; nothing on Pim's side can revoke it when the end's answer, or the network, is lost.
6. **No recovery**: a preview space seeded before this change has no ledger and stays blocked; a blocked or unsettled ledger stays so. Disposing of the VM, the journal or the bridge doesn't change that, and no new space, journal or identity is a way past it. Settling it needs a separate, reviewed migration or reconciliation.
7. **Restart and reconcile**: unconfirmed records stay so; there is no operator procedure to reconcile them, and none is offered here.
8. **Cleanup that doesn't settle**: a cancel left after `CLEANUP_MS` is only logged. Whether workerd's own streams ever hold one, and what a held one costs a Durable Object, is unmeasured.
9. **A real agent**: only the stand-in model has been considered. Whether a real model's ordinary tools behave on the VM while it is watched is unqualified.
10. **The real VM, spacesd and the root token's place** (blockers 1 and 4 of the preview page).
