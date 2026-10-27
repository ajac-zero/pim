# The viewer-first preview: the Worker's half

The Worker and web app side of the viewer-first single-user preview (`docs/cua-viewer-first-preview.md`, milestone 2, items 4 to 7): the client to the bridge's viewer host, the space's durable observation ledger, the person's routes, and a Watch desktop action. **Only the preview composes it.** A deployment mounts no route, constructs no desk and provisions no ledger: `serve` mounts `/api/observations` only when the preview passes `{ observations: true }`, and the preview does that only while its private environment opts into the Cua fixture. **Nothing here has been run, type-checked, linted or tested.** The tests below are written for an independent source audit before anything runs.

The host's half is separate and not merged here: `a1420114eab658e1eee464310e8192bffee0f91b` on `review/linus-cua-viewer-first-20261027` (the management API frozen in that commit's `docs/cua-viewer-first-preview.md`, `host.ts`, `viewer-host.ts` and `journal-store.ts`), also unrun. This client is written against that frozen API. Merging the two will conflict in `preview/cua-viewer-first.ts`'s header comment, which both changed.

## What is wired

```diagram
 Browser (owner's session) ──▶ preview Worker: serve(…, { observations: true })
                                  │ /api/observations/…: session only; only …/media upgrades; bodies ≤ 4 KiB
                                  ▼
                               preview Pim (the fixture's space only) ──▶ ObservationDesk
                                  │ ledger under cua_observations: written, then storage.sync(), before the host is asked
                                  ▼
                               CuaViewerClient ──▶ POST <bridge path>/observations/{launch,end,status}  (bridge bearer + x-pim-space)
                                               └─▶ /<hostLaunchId>/viewer/…, calls, media           (no bridge token; the launch's own credential)
```

| Piece | Where | What it does |
| --- | --- | --- |
| Client | `src/cua-viewer.ts` | `CuaViewerClient`: the three management calls, and the viewer's files, calls and media socket carried to one launch. |
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
| `POST /api/observations/<id>/end` | Records `revoke_requested`, flushes, asks the host to end. `202` is a request, not closure. |
| `GET /api/observations/<id>` | Asks the host for the launch's status. Only the read on which the host observed closure records it: `state` `closed_observed`, this record's launch id and exact generation, and `launch` present with `phase` `closed` and no unconfirmed stream. A lost answer changes nothing. |
| Anything else under `/api/observations/<id>/` | `admitObservationRequest`, then the client: the viewer's pinned files (`GET` only), its seven calls (`POST`), or `media?ticket=<43 characters>` as a WebSocket offering only `rcdp.v2`. Everything else is `404` or `405`, and nothing is sent. |

`POST` needs `Origin` to be the Pim's address.

## How the host's answers are recorded

| Host's answer | Ledger |
| --- | --- |
| No answer, a timeout, a redirect, a status other than `200` and the refusals below, a type other than JSON, more than 16 KiB, or anything that isn't exactly one of the launch manager's answer types | `unconfirmed` (launch, end); nothing (status) |
| `400`, `401`, `403`, `404`, `405`, `413`, `415`: the host refused before reading the request | `not_opened` (launch); nothing (end, status) |
| `launched`, for this key and deadline, not replayed | `open_acknowledged` |
| `launched` for this key with another deadline, or `replayed` for a new key | `open_acknowledged`, then `unconfirmed` |
| `refused`, `start_failed` | `not_opened` |
| `unconfirmed`, or an answer for another key | `unconfirmed` |
| End: `requested`, or `final` `closed_observed` | stays `revoking` |
| End: anything else | `unconfirmed` |
| Status: `found` `closed_observed` for this launch and exact generation, with `launch.phase` `closed` and `launch.unconfirmed` 0 | `closed_observed` |
| Status: `found` `closed_observed` without that launch read (the host recorded closure on a read whose answer Pim didn't see, and no longer holds the launch) | `unconfirmed`: not closure here, and it can't be shown again |
| Status: `found` `unconfirmed`, `start_failed` or `reconciled`, another launch or generation, `not_found`, `generation_mismatch` | `unconfirmed` |

**Revalidation and cancellation.** Every viewer request and media relay for a record is tied to that record's cancellation. When the record leaves `open` (an end requested, a lost answer, a conflict, closure) or the ledger blocks, its requests in flight are aborted and its relays end on both sides (`1000`), before the host is asked anything. After the host answers, and before anything is handed to the browser, the observation is admitted again: same record, still `open`, same launch and generation, before its deadline, ledger not blocked. A media socket the host opened for an observation no longer admitted is closed (`1008`) and the browser gets `404`; a file or call answer is dropped (`404`).

Limits and tombstones stay as `src/cua-observation.ts` has them: nothing is evicted, retired or reset. While any record is unresolved, no new observation starts (`VIEWER_FIRST.openObservations` is 1), so no fresh id escapes an uncertain one. A ledger that is missing, unreadable, another owner's or another version blocks every observation and is left as it is. A write or flush that fails blocks the desk for the life of the instance. Records left `pending_open` or `revoking` come back `unconfirmed` at the next start. The only way out of a blocked or unsettled ledger is disposing of the preview (`docs/cua-viewer-first-preview.md`, "The journal, minimally").

## What the client sends and passes back

- **Management:** `POST`, `Authorization: Bearer <bridge token>`, `x-pim-space`, `content-type: application/json` exactly, no encoding, no query, the manager's request type as JSON, at most 4096 bytes; `redirect: manual`; 25 s in all; never retried. The answer must be `200` with `content-type` exactly `application/json`. Nothing requires the host to name the space back on these answers, and the host doesn't.
- **Files and calls:** to `https://<bridge host>/<hostLaunchId>/…` (22 characters), files by `GET` and calls by `POST` only, never with the bridge's token or any `Authorization`. Only `content-type`, `x-cua-env-authorization`, `grpc-encoding` and `content-encoding` are carried; call bodies at most 4 KiB. Answers keep only `content-type`, `grpc-status`, `grpc-message`, `content-security-policy`, `cross-origin-resource-policy`, `x-content-type-options` and `referrer-policy`, and only the statuses `200`, `400`, `401`, `404`, `405`, `413` and `415` (others are `502`). Files are capped at 512 KiB and unary calls at 257 KiB; the presence stream at the observation's deadline. Files and calls have 30 s; the presence stream 30 s for its headers.
- **Media:** only at exactly `/<22 characters>/media?ticket=<43 characters>`, the host's own pattern, though admission takes a token of 16 to 128; `Upgrade: websocket` and `Sec-WebSocket-Protocol: rcdp.v2` only. Up: text only, 1 KiB each. Down: text up to 64 KiB and packets up to 16 MiB. Anything else ends both sides (`1008`, `1009`). The relay ends at the deadline. Workers' sockets don't expose what they hold unsent, so there is no backpressure here: the host's own bound (`MAX_BROWSER_BUFFERED_BYTES`) ends a viewer far behind.
- **Logs:** only `cua.viewer.lost`, `cua.viewer.refused` and `cua.viewer.unreachable`, with an action or kind and a status. Never a target, token, viewer path or anything the host said.

## Where this differs from the host's plan

- The management answers are read without requiring `x-pim-space` back; the host's plan doesn't send it.
- On a media `101`, a missing `sec-websocket-protocol` header is accepted, as whether the platform shows it is not known; a different value is refused.
- `admitObservationRequest` (`src/cua-observation.ts`) still admits `HEAD` on a file and attach tokens of 16 to 128 characters. The client narrows both to the host's: `HEAD` is `405` and other token lengths `404`, with nothing sent. The admission check itself is unchanged.
- The host's status answers `launch: null` once it has recorded closure and dropped the launch. A Worker that lost the answer of the read that observed closure can't see it again, so that record stays `unconfirmed` until an operator reconciles it or the preview is disposed.
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
| `test/cua-observation.test.ts` | prerequisite (`vitest.cua-prerequisite.config.ts`) and the whole suite | 24 (11 before, 13 added) | `vi`; `ObservationDesk`, `type ObservationStorage` from `src/cua-observation-runtime`; `CuaViewerClient`, `MAX_CALL_REQUEST_BYTES`, `parseEndAnswer`, `parseLaunchAnswer`, `parseStatusAnswer` from `src/cua-viewer` |
| `test/preview-cua-fixture.test.ts` | stand-in (`vitest.cua-standin.config.ts`) and the whole suite | 11 (9 before, 2 added, 3 extended) | `initialObservationState`, `type ObservationState` from `src/cua-observation`; `OBSERVATION_KEY` from `src/cua-observation-runtime`; `SIGNED_IN_HEADER` from `src/pim` |
| `web/src/components/computer-settings.test.tsx` | `pnpm --filter pim-web test` | 4 (3 before, 1 added) | `type Observations` from `~/lib/pim-api` |

Neither lane's file list changes. None of these files names the tests' Chrome, its binding or live checks. `test/cua-observation.test.ts` now also uses workerd's `WebSocketPair` for the media relay.

What they check:

- The client reads only the manager's exact answer types, and treats extra fields, other types, a wrong viewer path, a redirect, a server error, non-JSON and oversize as lost.
- The ledger is stored and flushed before the host is asked, and the viewer's credential is never stored or listed.
- Missing, unreadable, other-owner and other-version ledgers block without being recreated; a failed write asks nothing.
- A lost answer leaves the record unconfirmed, and no new observation starts past it; a refusal before acting does let the next one start.
- Watching again asks for the same key; a different launch makes the record unconfirmed and conflicting.
- An end is a request; a lost status changes nothing; only the host's read that observed closure (this launch, exact generation, `phase` `closed`, nothing unconfirmed) closes it. Another launch or generation, no launch snapshot, a launch still closing, an unconfirmed stream or `generation_mismatch` leave it unconfirmed.
- An end asked for while the host's media socket is opening closes that socket and gives the browser `404`; an end asked for during a relay ends both sides.
- Management answers whose type isn't exactly `application/json` are lost; `HEAD` and attach tokens of another length are refused before sending.
- Records restore conservatively; at the limit nothing is evicted.
- Viewer requests reach the launch at the host's root with only the allowlisted headers and no bridge token; redirects, oversize bodies, other paths, tokens and non-session callers are refused before sending.
- The media relay offers only `rcdp.v2`, passes text up and packets down, and ends on a binary message from the viewer.
- In the preview: the seed provisions the ledger in its transaction (and keeps none of it when the ledger's write fails, or when a ledger is already there); the owner's session watches through the bridge with the bearer on management only; the control state keeps the agent's lease; a seeded space whose ledger is gone fails closed; other spaces, and the space once the environment stops naming it, answer `404`.
- The Watch desktop card shows only where offered, says view only and that the agents continue, names the stand-in model, and disables watching while a record is unsettled or the ledger is blocked.

Not covered: the production gateway with no mount (only by reading `src/index.ts` and `serve`), a real browser rendering the viewer in the dialog, and anything against a real host.

## Remaining qualification blockers

1. **The host's half is unrun and unmerged** (`a142011`), and no journal is provisioned, so every launch is refused (`blocked`) until one is. The two halves have never met: nothing has checked this client against those routes by running them.
2. **Nothing here has run**: no type check, lint, test or build. The tests above are the audit's starting point, not evidence.
3. **The Worker's media socket to the bridge** (blocker 3 of the preview page): whether `fetch` with `Upgrade` from a Durable Object to the bridge works, shows `sec-websocket-protocol`, and carries 16 MiB packets, all untested. There is no backpressure on the Worker's side.
4. **The viewer in a browser**: the pinned viewer has never run in the dialog's frame against any adapter. Its content security policy, WebCodecs, audio and resizing there are untested, and so is the portal's rewrite of the address for the media socket.
5. **The ledger and the journal disposed together**: a runbook rule. A preview space seeded before this change has no ledger and stays blocked until the preview is disposed.
6. **Restart and reconcile**: unconfirmed records stay so; there is no operator procedure to reconcile them, and none is offered here.
7. **A real agent**: only the stand-in model has been considered. Whether a real model's ordinary tools behave on the VM while it is watched is unqualified.
8. **The real VM, spacesd, certificates and the root token's place** (blockers 1, 2 and 4 of the preview page).
