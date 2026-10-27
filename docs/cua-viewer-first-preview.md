# The viewer-first single-user preview (milestone 1: frozen candidate)

This is the target composition for a local preview in which one person watches their one Cua desktop in full, while their agents use it only through the ordinary tools. It is a candidate for review. **Nothing in it has been run, type-checked or tested**, and nothing here wires anything. The source added is `preview/cua-viewer-first.ts` (settings and the initial journal's shape; no behavior) and this page. It adds no route, binding, setting, tool, listener or credential, and nothing in `src/` or the Node host imports it. The preview stays non-production: its Worker is `preview/worker.ts`, never deployed, and every route below would exist only there.

Based on `ce65a77`. Nothing from main, and not the unaccepted `4c11a30`, is in it. The earlier stand-in results (`docs/cua-standin-lane.md`, `docs/cua-prerequisite-tests.md`) stay what they say: stand-in tests only, with the earlier failures and stalls preserved. No real Cua VM, spacesd, browser or bridge has been qualified.

## The composition

```diagram
 Person's browser ──(session)──▶ preview Worker ──(bridge bearer, HTTPS/WSS)──▶ bridge account on the VM
                                  │ Pim space DO                                  ├─ relay → desktop endpoint → pim-computer   (shell, files, Chrome)
                                  │  marker + control lease (fixture)             └─ viewer host → viewer adapter → spacesd     (view only)
                                  │  observation ledger
```

| Part | What it is | State |
| --- | --- | --- |
| Ordinary shell, files and Chrome | The existing pim-computer, reached through the Cua bridge (`docs/cua-bridge.md`). Unchanged. | Exists; unqualified on a real VM |
| The preview's computer selection and lease | `preview/cua-fixture.ts`: marker, control state enabled and resumed under `preview-cua-fixture`, for one space, once. | Exists |
| The full desktop viewer | The accepted adapter for spacesd 0.7.0's own HTML5 viewer (`computer/cua-host/viewer-adapter.ts`, `docs/cua-viewer-adapter.md`), `VIEW_ONLY` and `OBSERVE_ONLY`, one display. **Not** the earlier browser screenshot viewer, which is not used. | Module exists; unmounted |
| Observation record and admission | `src/cua-observation.ts`, `docs/cua-observation.md`. | Exists; unmounted |
| Launch manager | `computer/cua-host/viewer-launch-manager.ts`. | Exists; no store, no journal |
| Sprites | Defaults unchanged. A space with the Cua marker uses no Sprite and no paired computer, as today. | Unchanged |
| Native-app tools | Off. `Computer.native` stays off; `desktop.ts` is never given `cua`; no credential file for `cua-computer.ts` is provisioned; no `RunId` is invented for them. | Off |
| Human takeover | Off, as in `docs/computer-control-state.md`. Observation is not control and grants no input. | Off |

The settings (`VIEWER_FIRST`): display `primary`; an observation lasts 30 minutes; one observation open at a time; one space.

## The control lease, for ordinary tools only

An agent's `shell`, files and browser calls are admitted by the control state only while the agent holds the application. The preview already gives that, for one space, in `seedCuaFixture`: it stores the marker under `computer_provider`, enables the control state and resumes it under the lease `preview-cua-fixture`. It is opt-in by `PREVIEW_CUA_FIXTURE=seed` and `PREVIEW_CUA_FIXTURE_OWNER` in the preview's private `.dev.vars`, and the bridge is that owner's entry in `CUA_BRIDGES`. This needs nothing new:

- Viewing needs no lease: the ledger doesn't touch the control state, and an observation can be open while the agent owns the application.
- Approvals are unchanged: `shell` still files an approval, and the preview's stand-in reviewer leaves it to the person.
- No lease is made for native tools. Their `RunId` and identity (`docs/cua-native-identity.md`) stay unused.
- Once seeded, the control state is the space's own: a blocked or unknown state is not repaired by the fixture. Recovery is disposing of the preview.

## Secrets

Three kinds, kept in separate places:

| Secret | Who reads it | Where |
| --- | --- | --- |
| Bridge token, TLS key, and anything for the cloud | Only the bridge account (`bridge.ts` already requires a regular file of its own account, mode `0600`). Never any account in a desktop group. | Bridge account's files; the preview's `.dev.vars` for `CUA_BRIDGES` |
| spacesd's own-desktop authority (its root token) | spacesd, and the viewer host to mint one view-only ticket per launch (`startLaunch`, `rootToken()`); never stored, logged or answered. | **Open, see blocker 1** |
| Desktop user's own files, browser profile and `/workspace` | The shared non-root desktop user and everything the agents run there. `/workspace` is a convention, not an OS sandbox; nothing here promises more. | Desktop user's home |

One persistent VM per space; one shared non-root desktop user. The root token is spacesd's authority over the desktop the agents already control as that user. What this design must not do is let that user, or any desktop group, read the bridge's token, the TLS key or cloud credentials. No isolation between agents is claimed.

## The journal, minimally

The launch manager creates no journal and blocks on a missing, unreadable or invalid one, for good (`docs/cua-observation.md`). The minimal provisioning for this preview:

- The operator writes, once, when the VM is made and before the viewer host first starts, a file in the host account's own directory (not the desktop user's), mode `0600`, created exclusively, whose content is `initialJournal("<who, which preview>")` (`preview/cua-viewer-first.ts`): `{ "version": 1, "revision": 1, "generation": "provisioned", "initialized": "…", "entries": [] }`. `revision` must be at least 1.
- The host's `JournalStore` (write a temporary file, flush it, rename it over the old one, flush the directory; refuse a stale `expectedRevision`) is not written yet.
- **No reset or recovery at run time.** A missing, lost or invalid journal leaves the viewer blocked. The way out is to dispose of the whole preview (VM, space state and ledger) and make a new one with a new journal; nothing here edits, recreates or reconciles one. That is the preview's stand-in for the "never-reused admission namespace" `docs/cua-observation.md` says a real deployment needs: because the ledger and the journal are disposed together, no old observation key survives to start again. This holds only if both are always disposed together, which the preview's runbook, not code, must keep.

## What milestone 2 must wire

Each is a separate, small job, in this order. None starts before this source is reviewed.

1. **A file `JournalStore`** (`computer/cua-host/journal-store.ts`): `{ read(): Promise<unknown>; write(journal: Journal, expectedRevision: number): Promise<void> }` with the atomicity contract of `viewer-launch-manager.ts`. Temp-file tests only.
2. **The viewer host** (`computer/cua-host/viewer-host.ts`, started by `bridge.ts` as an option): builds `createViewerAdapter({ upstream: { origin, fetch, openMedia }, displayId: VIEWER_FIRST.displayId })` with Node `fetch` and a `ws` client, and `openViewerLaunchManager({ adapter, store, generation: crypto.randomUUID(), rootToken })`. The root token is read from a file for each launch (blocker 1).
3. **Host routes** (`computer/cua-host/host.ts`; `HostOptions` gets an optional `viewer`): behind the same bearer and space checks as the relay, `POST /<path>/observations/launch|end|status` calling `manager.launch(LaunchRequestKey)`, `.end(KeyRequest)` and `.status(KeyRequest)`; and `/<hostLaunchId>/…` to `adapter.fetch`, with upgrades to `adapter.media(target, protocols)` then `attach(open)`, as `docs/cua-viewer-adapter.md` ("Not wired yet", item 2) describes. Request targets are never logged.
4. **The Worker's client to those routes** (`src/cua.ts` or a sibling): reuses `CuaBridge` and the existing HTTPS and bearer rules; no new secret. Methods mirror the three manager calls, plus a pass-through `fetch` and WebSocket to `/<hostLaunchId>/…`.
5. **The space's ledger** (`src/pim.ts`, stored as the control state is in `src/computer-control-runtime.ts`): `ObservationState` under its own key with an opt-in marker, written synchronously before the host is asked; `open_requested`, `open_acknowledged` and `closure_observed` from the three answers; `observationId = crypto.randomUUID()`, `notAfter = now + VIEWER_FIRST.observationMs`; a retry finds its record. `restoreObservationState` runs on start.
6. **The gateway route** (`src/gateway.ts`): `/api/observations/` checked with `signedIn`, the session owner passed to `admitObservationRequest(request, caller, ledger, now, publicOrigin)`, which answers a host target or a status; `observationResponse` on every answer; the upgrade allowlist (`/ws`, `BROWSER_LIVE_PATH`, around line 453) gets an observation's `media` only. No generic proxy. The viewer path, whose fragment is the launch's credential, goes only to the owner's session, `no-store`.
7. **A start action** by which the person asks to watch (one route and one button in `web/`, following `web/DESIGN.md`). Preview-only, behind the same opt-in as the fixture.

Not in milestone 2: native tools and their dispatcher, takeover, retiring final records, a reconcile procedure, any provisioning script, certificates, bundle delivery, or the VM.

## Critical-path blockers

1. **Where spacesd's root token lives and who reads it.** The viewer host must read it to mint view-only tickets, and spacesd must hold it. If it sits in the desktop user's files, the agents can read it too. That is within the authority they already have over their own desktop, but then the viewer host must not run in a desktop group, and the bridge's token and TLS key must stay in an account the desktop user can't read. The choice (a file owned by the host account, or the desktop user's file read by the host through an ACL) needs a decision. Without it, step 2 can't be written.
2. **A real base image and session.** The exact base, session, Node and browser versions, and whether spacesd 0.7.0 with its `/media` and viewer run there at all, are separate gates. Nothing shows the pinned viewer works against the real binary.
3. **A Worker-to-bridge WebSocket for media.** `Cua.connect` upgrades with `fetch`, and the platform exposing `x-pim-space` is assumed, not tested. The viewer needs the same for a second, long-lived socket with packets up to 16 MiB, which the Worker pipes both ways under backpressure. Untested, and the first thing to try once a bridge exists.
4. **Certificate and network** for the bridge to be reached from the preview, and the bundle that puts the host's programs on the VM.
5. **Journal and ledger disposed together** (above): a runbook rule with no code behind it.
6. **Restart.** A host that dies leaves spacesd's media sessions and viewer ticket to their own lifetimes, so entries stay `unconfirmed` until the preview is disposed. There is no reconcile procedure.
7. **The viewer has never run in a browser** against any adapter. Its content security policy, rendering, codecs and audio are untested.

## Cutover: Cua supersedes Sprites

Cua is to replace Sprites as the computer, not sit beside them. This candidate changes no Sprite behavior and adds no provider abstraction, no Sprite feature and no Sprite-side code. The marker (`computer_provider`) already makes a space's computer exactly one of Cua or Sprite, and that existing choice is all the coexistence there is. Sprites keep working as they do now only until migration is validated. **Nothing below is done now:** no migration, default switch, deletion, shutdown, retirement or inspection of any Sprite, and no production action. A production cutover or retirement needs its own explicit, reviewed authorization.

1. **Inventory (per space, read-only, later).** The files under the Sprite's root, the browser profile and its logins and downloads, installed tools and their versions, other persistent state such as services or cron jobs, and the space's own records: its control state, approvals and any unknown operation. Each item is listed with its size and whether it moves.
2. **Export, import, verify, rollback.** Export is a copy: the Sprite is not changed or stopped. Import writes only to the new Cua VM's desktop user. Verification compares file lists and hashes, tool versions, and that the browser profile opens. **Rollback boundary:** until the person accepts the VM, the space's marker still selects the Sprite and nothing was removed from it, so rollback is not switching the marker and discarding the VM. After the switch, work done on the VM is not carried back to the Sprite unless exported again; that is the point of no return for it.
3. **Unknown operations are never migrated.** A command or native request whose outcome is `unknown`, and every tombstone or request ID the control state, `src/cua-native-identity.ts` or the ledger holds, stays where it is, unchanged and not copied, replayed or erased. Migration moves files and tools, not records of operations. A space with an unknown operation stays blocked until it is reconciled as today, on whichever computer it was on.
4. **Workflows that must be shown on the real VM before the default moves:** shell commands and their approvals, file read and write, Chrome (open, log in, download), the full-desktop viewer watching those, and all of it again after the VM restarts, with files, the browser profile and installed tools still there.
5. **Cost, measured.** Idle, storage and egress for the Cua VM over a representative period, against the current Sprite spend for the same space. Both are unknown until measured; this page gives no figure and the Azure cost and time gates are unchanged.
6. **Staged default, then removal.** First opt-in per space by the marker, as the preview does now; then Cua as the default for new spaces, with Sprites only for spaces not yet moved; then, once every space has moved and the evidence above is in, a reviewed change that removes the Sprite code (`src/sprites.ts` and what imports it), its settings and secrets, and its resources. Removal is its own change, after the evidence, and not before.

None of this blocks the current candidate. The only blocker it adds is the same as blockers 1 to 4 above: there is nothing to measure or migrate until a real Cua VM exists.

## What is not claimed

No real Worker-to-HTTPS connection, VM shell, files or browser, full preview process restart, or two-account secret access has been shown. No Azure resource exists, and the later cost and time gates are not opened by this candidate. No test, type check or build was run for this milestone, so `preview/cua-viewer-first.ts` is unchecked.
