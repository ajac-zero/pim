# The viewer-first single-user preview

This is the target composition for a local preview in which one person watches their one Cua desktop in full, while their agents use it only through the ordinary tools. It is a candidate for review. **What has run, and what hasn't:** at `3bdf5bb`, `journal-store.test.ts` (17) passed, and at `917fa25` `viewer-host.test.ts` (29) passed, each independently, fake-only; the earlier 28/29 failure of `viewer-host.test.ts` at `3bdf5bb` was a test defect, fixed in `917fa25`. **Everything changed since `917fa25` is unrun:** the direct-path hardening (origin rules, response policy, the page's explicit `wss:` origin) and its new tests. No real-route test (`viewer-routes.test.ts`) has ever run, nothing has been tried against a real browser, `ws` peer or spacesd, and no type-check is claimed. The host side is written (`computer/cua-host/journal-store.ts`, `viewer-host.ts`, the optional viewer routes in `host.ts` and `bridge.ts`, and their fake-lifecycle tests); the Worker side, the ledger and the browser are not. Nothing in a deployment calls any of it: the preview's Worker is `preview/worker.ts`, never deployed, and every route below would exist only there.

Based on `ce65a77`. Nothing from main, and not the unaccepted `4c11a30`, is in it. The earlier stand-in results (`docs/cua-standin-lane.md`, `docs/cua-prerequisite-tests.md`) stay what they say: stand-in tests only, with the earlier failures and stalls preserved. No real Cua VM, spacesd, browser or bridge has been qualified. `preview/cua-viewer-first.ts` is settings and a journal's shape, as data. It is not part of any assembled or tested function, and it is not evidence that the candidate is complete.

## The composition

```diagram
 Person's browser ──(session)──▶ preview Worker ──(bridge bearer, HTTPS)──▶ bridge account on the VM
        │                         │ Pim space DO   management only:            ├─ relay → desktop endpoint → pim-computer   (shell, files, Chrome)
        │                         │  marker + lease  /observations/*           └─ viewer host → viewer adapter → spacesd     (view only)
        │                         │  ledger
        └────(direct HTTPS/WSS, the viewer's own capabilities, no Pim cookie)───────────▶ the same bridge origin
```

| Part | What it is | State |
| --- | --- | --- |
| Ordinary shell, files and Chrome | The existing pim-computer, reached through the Cua bridge (`docs/cua-bridge.md`). Unchanged. | Exists; unqualified on a real VM |
| The preview's computer selection and lease | `preview/cua-fixture.ts`: marker, control state enabled and resumed under `preview-cua-fixture`, for one space, once. | Exists |
| The full desktop viewer | The accepted adapter for spacesd 0.7.0's own HTML5 viewer (`computer/cua-host/viewer-adapter.ts`, `docs/cua-viewer-adapter.md`), `VIEW_ONLY` and `OBSERVE_ONLY`, one display. **Not** the earlier browser screenshot viewer, which is not used. | Mounted on the host (`host.ts`, `viewer-host.ts`), unrun; not on the Worker |
| Observation record and admission | `src/cua-observation.ts`, `docs/cua-observation.md`. | Exists; unmounted on the Worker |
| Launch manager and its journal store | `viewer-launch-manager.ts`, with `journal-store.ts`: one file, one writer for the host's life (see "The journal"). | Written; unrun. No journal is provisioned |
| Sprites | Defaults unchanged. A space with the Cua marker uses no Sprite and no paired computer, as today. | Unchanged |
| Native-app tools | Off. `Computer.native` stays off; `desktop.ts` is never given `cua`; no credential file for `cua-computer.ts` is provisioned; no `RunId` is invented for them. | Off |
| Human takeover | Off, as in `docs/computer-control-state.md`. Observation is not control and grants no input. | Off |

The settings (`VIEWER_FIRST`): display `primary`; an observation lasts 30 minutes; one observation open at a time; one space.


## The control lease, for ordinary tools only

An agent's `shell`, files and browser calls are admitted by the control state only while the agent holds the application. The preview already gives that, for one space, in `seedCuaFixture`: it stores the marker under `computer_provider`, enables the control state and resumes it under the lease `preview-cua-fixture`. It is opt-in by `PREVIEW_CUA_FIXTURE=seed` and `PREVIEW_CUA_FIXTURE_OWNER` in the preview's private `.dev.vars`, and the bridge is that owner's entry in `CUA_BRIDGES`. This needs nothing new:

- Viewing needs no lease: the ledger doesn't touch the control state, and an observation can be open while the agent owns the application.
- Approvals are unchanged: `shell` still files an approval, and the preview's stand-in reviewer leaves it to the person.
- No lease is made for native tools. Their `RunId` and identity (`docs/cua-native-identity.md`) stay unused.
- Once seeded, the control state is the space's own: a blocked or unknown state is not repaired by the fixture, and nothing here recovers it. It stays as it is until the existing reconciliation settles it.

## Secrets

Kept in separate places, by who may read them:

| Secret | Who reads it | Where |
| --- | --- | --- |
| The bridge's bearer token | The bridge account (`bridge.ts` requires a regular file of its own account, mode `0600`), and Pim's Worker, which sends it. | The bridge account's file; for the Worker, that space's entry in `CUA_BRIDGES` |
| The bridge's TLS key, and any cloud credential | Only the bridge account or the operator's own tooling. **Neither is in `CUA_BRIDGES`**, which holds one address and one bearer token per space and nothing else. Never any account in a desktop group. | The bridge account's file; the operator's tooling |
| spacesd's root token, which the viewer host uses to mint one view-only ticket per launch | The viewer host, read on each launch from a file it owns: a regular file of the host account's, mode `0400` or `0600`, one link, not reached through a link (`createRootTokenReader`). Never stored, logged, returned or put in an error. If a descriptor's close can't be seen, the reader refuses the token and latches, and is never closed again by number; `blockers()` says so. | The host account's file. How spacesd gets its own credential is a later gate |
| The desktop user's own files, browser profile and `/workspace` | The shared non-root desktop user and everything the agents run there. `/workspace` is a convention, not an OS sandbox; nothing here promises more. | The desktop user's home |

One persistent VM per space; one shared non-root desktop user. spacesd's own-desktop authority is the authority the agents already have over their own desktop. What this design must not do is let that user, or any desktop group, read the bridge's token, the TLS key or cloud credentials, and the host account must not be in a desktop group. No isolation between agents is claimed.

## The journal

The launch manager creates no journal and blocks on a missing, unreadable or invalid one, for good (`docs/cua-observation.md`). The host store (`journal-store.ts`) keeps that:

- **One writer, by a lock, not by a check.** Reading the revision and then renaming is not a compare-and-swap: two writers can both pass it. So `openJournalStore` makes `journal.lock` in the journal's directory with `O_CREAT | O_EXCL` and holds it for the host's life. A lock that is already there, live or left by a host that died, is **refused and left in place**. This program never removes, replaces or recovers a lock, and no recovery from a left lock is supported in this release: a host that died keeps its successor from starting, which fails closed. While it lives, every write also checks that the lock file is still the one it made.
- **Descriptors fail closed.** Every descriptor is closed once; a close that can't be seen to succeed latches the store (and the root token reader), is never retried by number, keeps the original error beside the cleanup error, and leaves the lock in place. The native write loop rejects a write that makes no progress instead of spinning.
- **The write.** Under the lock, `write(journal, expected)` reads the stored revision, refuses unless it is `expected` and the new one is the next, writes `journal.json.tmp`, flushes it, renames it over `journal.json` and flushes the directory.
- **It never creates `journal.json`.** A missing journal reads as none, and a write to one is refused. The host never calls `initialJournal`, and nothing in the host imports `preview/cua-viewer-first.ts`.
- **Provisioning is a separate, unwritten step.** Someone with authority over the host account would create the first file once, outside this program, with the shape `initialJournal` shows (`revision` at least 1), in the host account's own directory (mode `0700`, the file `0600`). Neither the step nor the function has been written as a tested tool; the function is a statement of the shape.
- **Loss is not recovered in this release.** A missing, lost or invalid journal leaves the viewer blocked, and nothing here edits, recreates, resets or reconciles one. Making a new journal, a new space or a new identity is not a way out: a launch's key is Pim's observation ID, a fresh journal would not remember the keys the old one refused to start again, and `docs/cua-observation.md` says a real deployment needs a durable, never-reused admission namespace or an equivalent retirement authority first. That is open, and until it exists the preview's viewer simply stays blocked.

## The management API (frozen)

For the Worker's job, and for nothing else to call. On the bridge's HTTPS address, at the relay's own path (`/pim` below):

| Request | Body (JSON, at most 4096 bytes) | Answer |
| --- | --- | --- |
| `POST /pim/observations/launch` | `{ "key", "owner", "notAfter", "displayName"? }`: the manager's `LaunchRequestKey` | `200`, the manager's `LaunchAnswer` as JSON |
| `POST /pim/observations/end` | `{ "owner", "key", "generation" }`: `KeyRequest` | `200`, `EndAnswer` |
| `POST /pim/observations/status` | the same | `200`, `StatusAnswer` |

- Every request needs the bridge's bearer token and `x-pim-space`, checked by `Relay.authorize` (the same digest comparison as an upgrade, but not the upgrade-only `check`) **before** the body is read. `owner` must be the bridge's space (`403` otherwise, and the manager isn't called). A body must be `application/json`, with each header once, no `content-encoding`, and no query. Other methods are `405`, other paths `404`. A body that is slow is cut off by the host's own timer, and a client seen gone before the manager is asked (after authentication, after the body, and last of all just before the call) starts nothing.
- A launch's answer carries the viewer page's path, whose fragment is the launch's credential. It is for the owner's session only: `no-store`, never logged, never in the journal.
- **The viewer is direct.** The browser never holds the bridge token. The Worker uses the management API only, and hands the owner's session the launch's `viewerPath` made absolute from the checked bridge origin (the path is `/<launchId>/viewer/#ticket=…`; the fragment never goes to a server). The browser then loads the whole pinned viewer, makes its calls and opens its media socket straight to the host, by the adapter's own capabilities. See "The direct viewer path".
- The host serves these only when it is started with `--viewer-origin` (spacesd), `--viewer-public-origin` (the bridge's own, for browsers), `--viewer-journal-dir` and `PIM_VIEWER_ROOT_TOKEN_FILE`, all together (`--viewer-display` and `--viewer-embed-origin` are optional). Any of them without the rest, or with a lone `--viewer-display`, or any invalid (`parseViewerSettings`), refuses to start with `bridge.failed` at stage `viewer`. With none of them it serves the relay alone, as before, and never loads the viewer's code.
- **Shutdown** (`SIGTERM`/`SIGINT`): the viewer host stops admitting first. From then on **none of the three management calls reaches the manager**: a launch is refused (`blocked`), an end answers `unconfirmed`, and a status is answered `503` with `retry-after` (a status has no answer that says "not now"; this is the one failure answer the frozen API adds, and the host answers the same `503` if the manager throws). Then it asks every launch it answered to end through the manager, those still starting included as they answer, and reads each one's status. **One deadline of 5 s, held by a single timer cleared when the shutdown ends, bounds every stage**; the pauses between reads are timers too, cleared as they end, so nothing is left running. A held `end`, `status` or start can't hold the shutdown. The journal's `close` is asked for only when no call is outstanding, since one could still write it, and races the deadline, or one poll interval (100 ms) more if the deadline had already passed when it began: the total is at most the deadline plus one poll interval. It logs `bridge.viewer_stopped` with `requested`, `closed`, `pending` (answered and not seen closed), `unconfirmed` (their last read), `inFlight` (starts not answered by the deadline), `unsettled` (`end`/`status` not answered), `lockLeft` and `settled`, and claims nothing a timeout didn't see. A launch that answers after the deadline is ended then, and nothing waits for it. Pending work stays unresolved in the journal and the next process finds it unconfirmed. **The bridge exits 0 only when `settled`;** anything pending, in flight, unsettled or unreleased exits 3, a failure to close the host exits 1 unless it is already 3, and a failure to start exits 1 after the viewer's own report.

## The direct viewer path

Audited against the source, not run. What a browser reaches on the bridge's HTTPS origin, with no Pim cookie and no CORS:

- **Same origin, so no CORS.** The adapter serves the viewer at `/<launch>/viewer/`, and the viewer resolves its RPCs and its media socket against the parent directory, so every request is to the origin it was loaded from. The host answers no `Access-Control-*` header and no preflight (`OPTIONS` is `405`), so a cross-origin page can't call it. The page's content security policy, set by the adapter, allows connections to `'self'` and, now, to the exact `wss://<public host>[:port]` written out beside it (`viewerCsp`, from `--viewer-public-origin`), so it doesn't rest on a browser counting `'self'` as the `wss:` origin. The pinned viewer files are unchanged. No browser has loaded it yet.
- **Capabilities, not Pim's credentials.** An RPC carries the launch credential (43 characters of base64url, minted by the adapter per launch) in `x-cua-env-authorization`; a media socket carries a 43-character attach token (also the adapter's, one per media session) in its target. Neither is the bridge token or spacesd's root token, and neither is stored in the journal. The files need no credential. Other paths stay `404`; the public route allowlist is unchanged, and no request target is logged.
- **View only is the adapter's, unchanged.** It opens media only as `VIEW_ONLY` with `GEOMETRY_CONTROL_OBSERVE_ONLY` on the one configured display, and relays only keyframe requests and frame acks up.
- **The media socket needs the right `Origin`.** The browser's `Origin` must be exactly `--viewer-public-origin`, a single header; absent, repeated or different is `403` before the adapter learns the token, so it fails closed. Any other adapter request that carries an `Origin` must match too (a same-origin page load sends none). An origin is exact: `https://host[:port]` with a well-formed DNS name or IP address, and nothing else. A path, query, fragment, credentials, a written-out `:443`, uppercase, a trailing dot, an empty or malformed label, and **a wildcard such as `https://*.example` (which the URL parser would otherwise accept) are all refused**, for the public and the embedding origin alike, and an origin is only ever compared as a string. **`--viewer-public-origin` is the bridge's own public HTTPS origin, and is separate from `--viewer-origin`, which is where spacesd is.** The Worker's absolute viewer URL and this setting must name the same origin; the host can't check that they do.
- **Framing.** The host adds `Content-Security-Policy: frame-ancestors <one exact origin>` to every HTTP answer on a viewer route (`/<launch>/…`), **refusals the host makes itself included** (`400`, `403`, `404`, `405`) as well as the adapter's answers. It does not go on the management API's answers, which are JSON for the Worker, nor on a refused WebSocket upgrade, which carries no page, nor on the host's own pre-routing errors (an oversized or malformed request). The origin is `--viewer-embed-origin` (the Pim app) if embedding is chosen, otherwise `'none'`. It is enforced beside the adapter's own policy. It also adds a `Permissions-Policy` with no clipboard, microphone, camera, display capture or geolocation. No wildcard is accepted for either origin: each must be exactly an `https://host[:port]`.
- **The browser's queue bound, stated as it is.** The adapter ends the relay (`1011`) when `bufferedAmount` is over 32 MiB, and checks it after each packet it sends. A packet may be up to 16 MiB, so the queue can reach **32 MiB plus one packet** before it is ended, not 32 MiB strictly. With a browser connected directly, `ws`'s `bufferedAmount` counts what is queued toward that browser (the sender's queue and the socket's own). The most the browser may send up is 4 KiB a message (`maxPayload`; more closes the socket `1009`). A close that can't flush is destroyed after the host's close timeout, and the bytes still queued are discarded. None of this is isolation of the VM, and no claim is made about root breadth or infrastructure leakage.
- **End, and what it doesn't promise.** `end`, the deadline or a shutdown ends the launch: its credential stops working (its paths answer `404`), its relays and presence streams are closed, and `CloseMedia` is asked of spacesd for each session. spacesd's own viewer ticket, minted for the launch, is **not** revoked and lasts until its expiry; the host and its credential are what stop the browser. The launch's expiry is absolute: nothing extends it, and a reconnect or a new media session never moves it. If Pim's `end` is lost, the host can't be told, so revocation is at the latest the launch's `notAfter`, not instant. The journal keeps what is unknown, unresolved; no recovery is added.

**Configuration impact** (nothing is deployed): `--viewer-public-origin` is now required beside the other viewer settings, and `--viewer-embed-origin` is optional (embedding is off without it). `parseViewerSettings`, `ViewerHostOptions` and `ViewerRoutes` gain `publicOrigin` and `embedOrigin?`. The management API is unchanged.

## What milestone 2 has done and still must do

Done as source, unrun (the host job):

1. `computer/cua-host/journal-store.ts`: the file store above, over an injected `JournalFiles`.
2. `computer/cua-host/viewer-host.ts`: the root-token reader, the media opener (`createMediaOpener`, which makes no socket for an already cancelled open), `parseViewerSettings`, `createLaunchAdmission`, and `createViewerHost` (adapter, manager and store, with `blockers()` and a shutdown).
3. `computer/cua-host/host.ts` (`HostOptions.viewer`, `ViewerRoutes`), `bridge.ts` (the flags), and `Relay.authorize` and `Relay.path` in `computer/cua-bridge.ts`.

Still to do, each a small job for the Worker side, which can proceed against the API above:

4. **The Worker's client** (`src/cua.ts` or a sibling): the three calls, with `CuaBridge`'s HTTPS, bearer and no-redirect rules, and an absolute viewer URL made from the checked bridge origin. There is no Worker proxy for the viewer's files, calls or media: the browser goes direct (see "The direct viewer path").
5. **The space's ledger** (`src/pim.ts`, stored as the control state is in `src/computer-control-runtime.ts`): `ObservationState` under its own key with an opt-in marker, written synchronously before the host is asked; `observationId = crypto.randomUUID()`, `notAfter = now + VIEWER_FIRST.observationMs`; events from the three answers; `restoreObservationState` on start.
6. **The gateway route** (`src/gateway.ts`): the observation's management only, for the signed-in owner (`signedIn`): start, end and status, which call the host's three management routes and return the absolute viewer URL to that session. **There is no Worker route for the viewer's files, RPCs or media, and no change to the upgrade allowlist** (`/ws` and the browser's live view stay the only upgrades); on the direct path the Worker never sees them. `admitObservationRequest` and `observationResponse` guard the management route; the viewer's own traffic is not theirs.
7. **A start action** in `web/` (one route, one button, `web/DESIGN.md`), preview-only behind the fixture's opt-in.

Not in milestone 2: native tools, takeover, retiring final records, a reconcile procedure, any provisioning script, certificates, bundle delivery, the VM.

## The stand-in test allowlist, for audit

Nothing has been run. These are the only test files that may later run under a reviewed boundary, by name. The package's own `test/*.test.ts` glob must **not** be used: it would also run the real-process and TLS tests.

| File | What stands in | Sockets or processes |
| --- | --- | --- |
| `computer/cua-host/test/journal-store.test.ts` (new) | An in-memory file system (`fake-journal-files.ts`) | None |
| `computer/cua-host/test/viewer-host.test.ts` (new) | In-memory files; the origin and header rules as pure functions; spacesd as a function that fails the test if called; a stand-in manager for shutdown; an in-process emitter for the media socket | None |
| `computer/cua-host/test/viewer-launch-manager.test.ts` (existing) | An in-memory journal and adapter | None |
| `computer/cua-host/test/viewer-lifetime.test.ts` (existing) | Hand-turned clocks | One real 20 ms timer |
| `computer/cua-host/test/viewer-adapter.test.ts` (existing) | A stand-in for spacesd in the test process | None |

Excluded, by name, and not because every one starts a process: **`viewer-routes.test.ts` (new): real loopback HTTP and `ws` sockets in the test process, outside the mocked-lifecycle boundary until separately authorized**; `host.test.ts` (runs `openssl`, TLS sockets); `session.test.ts` (Unix sockets and real child processes); `cua-endpoint.test.ts` (a Unix socket and a temporary folder, with in-memory fake children and no process started, per its own header, but not part of this allowlist's fakes-only boundary); `cua-computer.test.ts` and `native-mcp.test.ts` (not audited for this list); `eval-credentials.test.ts` (spawns the CLI) and `eval-install.test.ts` (runs `bash`). The new tests were written without being run, so a failure in them is a finding, not a regression. Nothing here qualifies anything.

## Which model the preview's chats use

The preview's Worker answers with a stand-in model that echoes what is said and calls a tool when a message says `/tool <name> {json}`. That demonstrates tools, approvals and the viewer's plumbing. It is **not** evidence that a real agent can use the desktop: no real model chose to call anything. A usable preview needs a real model route, which is one of those the preview already has beside the stand-in: a ChatGPT plan connected in Settings, or a model the person adds. The Workers AI route is a deployment's, not the preview's (no Cloudflare account). Which one, and whether an agent really operates the shell, files, Chrome and the viewer with it, is not shown here and is a gate of its own.

## Critical-path blockers

1. **A real base image and session.** The exact base, session, Node and browser versions, and whether spacesd 0.7.0 with its `/media` and viewer run there at all, are separate gates, as is how spacesd gets its own credential and where it lives. Nothing shows the pinned viewer works against the real binary, or that the root-token file the host reads is the one spacesd accepts.
2. **A Worker-to-bridge WebSocket for media.** `Cua.connect` upgrades with `fetch`, and the platform exposing `x-pim-space` is assumed, not tested. The viewer needs the same for a second, long-lived socket with packets up to 16 MiB, which the Worker pipes both ways under backpressure. Untested, and the first thing to try once a bridge exists.
3. **Certificate and network** for the bridge to be reached from the preview, the bundle that puts the host's programs on the VM, and the provisioning of the journal's directory and its first file.
4. **Journal loss and restart.** Loss blocks the viewer for good, with no recovery in this release. A host that dies leaves its lock (no recovery from a left lock is supported), spacesd's media sessions and its viewer ticket to their own lifetimes, and its entries `unconfirmed`, with no reconcile procedure. Retiring final records and a never-reused admission namespace are open (`docs/cua-observation.md`).
5. **The viewer has never run in a browser** against any adapter. Its content security policy, rendering, codecs and audio are untested. Nor have the new host routes run against a real `ws` client or a real spacesd.
6. **A real model route** for the preview's agents (above), for anything beyond the stand-in demonstration.

## Cutover: Cua supersedes Sprites

Cua is to replace Sprites as the computer, not sit beside them. This candidate changes no Sprite behavior and adds no provider abstraction, no Sprite feature and no Sprite-side code. The marker (`computer_provider`) already makes a space's computer exactly one of Cua or Sprite, and that existing choice is all the coexistence there is. Sprites keep working as they do now only until migration is validated. **Nothing below is done now:** no migration, default switch, deletion, shutdown, retirement or inspection of any Sprite, and no production action. A production cutover or retirement needs its own explicit, reviewed authorization.

1. **Inventory (per space, read-only, later).** The files under the Sprite's root, the browser profile and its logins and downloads, installed tools and their versions, other persistent state such as services or cron jobs, and the space's own records: its control state, approvals and any unknown operation. Each item is listed with its size and whether it moves.
2. **Export, import, verify, rollback.** Export is a copy: the Sprite is not changed or stopped. Import writes only to the new Cua VM's desktop user. Verification compares file lists and hashes, tool versions, and that the browser profile opens. **Rollback boundary:** until the person accepts the VM, the space's marker still selects the Sprite and nothing was removed from it, so rollback is switching the marker back and setting the VM aside; the Sprite and Pim's records are untouched. After the switch, work done on the VM is not carried back to the Sprite unless exported again; that is the point of no return for it.
3. **Pim's records of uncertainty are authoritative and are never migrated, abandoned or renamed away.** A command or native request whose outcome is `unknown`, and every tombstone, request ID, run latch, observation record and journal entry that the control state, `src/cua-native-identity.ts`, the ledger or the journal holds, stays in the space that wrote it, unchanged: not copied, replayed or erased, and not left behind by giving the person a new space, owner or identity. Migration moves files and tools, not records of operations. A space with an unknown operation stays blocked until the existing reconciliation settles it, on whichever computer it was on. If Pim's records can't travel with the space, the space doesn't move.
4. **Workflows that must be shown on the real VM before the default moves:** shell commands and their approvals, file read and write, Chrome (open, log in, download), the full-desktop viewer watching those, and all of it again after the VM restarts, with files, the browser profile and installed tools still there.
5. **Cost, measured.** Idle, storage and egress for the Cua VM over a representative period, against the current Sprite spend for the same space. Both are unknown until measured; this page gives no figure and the Azure cost and time gates are unchanged.
6. **Staged default, then removal.** First opt-in per space by the marker, as the preview does now; then Cua as the default for new spaces, with Sprites only for spaces not yet moved; then, once every space has moved and the evidence above is in, a reviewed change that removes the Sprite code (`src/sprites.ts` and what imports it), its settings and secrets, and its resources. Removal is its own change, after the evidence, and not before.

None of this blocks the current candidate. Nothing can be measured or migrated until a real Cua VM exists (blocker 1 above).

## What is not claimed

No real Worker-to-HTTPS connection, VM shell, files or browser, full preview process restart, or two-account secret access has been shown. No Azure resource exists, and the later cost and time gates are not opened by this candidate. Only the two fake-only files named at the top have run, at the revisions named there; every later change is unrun, and no type-check is claimed.
