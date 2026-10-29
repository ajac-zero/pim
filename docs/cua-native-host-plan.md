# Native-app calls on a Cua VM: the host design, for review

This page is source and design only. **Groves rejected the earlier proposal**: spacesd's root token as a file of the desktop account, and spacesd running as that account ("placement A" for native calls). It is kept below only as a record. In its place, this page compares a minimal protected-account design: spacesd and its credential outside the desktop's UID, and native calls brokered by the trusted bridge account over a fixed nine-operation interface.

**Nothing here is implemented or provisioned:** no new account, service, socket, token, configuration or process. Pim's `nativeDesktop()` stays false (`src/pim.ts`), so no agent is offered a native-app tool. **Human takeover is unavailable, and nothing here is a takeover safety claim.** The ordinary smoke test, which doesn't depend on any of this, is now its own page (`docs/cua-ordinary-smoke-plan.md`).

## Executive decision (proposed)

**Status: not acceptance-ready.** Groves chose acknowledged remote fencing for execution-time authority. Its protocol and staged plan are in `docs/cua-native-fence-protocol.md`, a draft that isn't acceptance-ready. It is blocked on the line-holding qualification and on exact resolution for a Stop with an `operationId`. Nothing in it is accepted or implemented, and the upstream facts below are unverified.

- **Adopt as the design to qualify:** spacesd in its own non-root account; the token readable only by that account and the bridge's; native calls executed by a broker inside the bridge process, which already holds the token for the viewer. The bridge demuxes `native_tool` away from pim-computer. The desktop account gets no token, socket or child for native calls.
- **Don't build it yet.** Two upstream facts decide whether it works at all, and neither is verified:
  - whether a separate-account spacesd can drive the desktop's X display;
  - whether it can read the session's accessibility tree, given that D-Bus session buses normally admit only their own UID.

  A bounded read-only qualification on a disposable VM comes first. If accessibility needs a grant on the desktop's session bus, that grant is a decision in its own right.
- **Native calls stay off until then.** Even built, the design governs only Pim's own native calls, up to the broker's send. Same-user X11 clients and detached programs still act on the display through any pause, so human takeover stays unavailable.

## Where things stand

- **The desktop endpoint can start the Cua computer** (`desktop.ts --native on …`), a desktop-UID child that reads spacesd's token as descriptor 3 (`docs/cua-bridge.md`). That path belongs to the rejected placement. The code stays opt-in and unused: no installer step, service or variable passes `--native on`, and the protected design doesn't use it. Its descriptor-3 qualification (`computer/cua-host/qualification/`) stays unrun and is off this design's path.
- **The viewer configuration already runs spacesd** (`pim-cua-spacesd.service`) as `pim-desktop` on `127.0.0.1:3211`, with `--no-mcp --no-driver`. Its token is `/etc/pim-spacesd/token` (`pim-desktop`, `0600`), and the bridge keeps a copy, `/etc/pim-bridge/viewer-root-token` (`pim-bridge`, `0600`), to mint view-only viewer tickets (`docs/cua-viewer-first-startup.md`, "spacesd").
- **The bridge's relay** carries every message between Pim and pim-computer unchanged and parses none (`computer/cua-bridge.ts`).
- **`createNativeDispatcher`** (`computer/cua-host/native-mcp.ts`) already does the host's side of a native call: one owner, the nine curated tools with tightened schemas, the pinned `tools/list` check, one driver session per run, one call per call ID, a run latched once unknown, and typed outcomes including `unknown`.

## Why moving the file alone isn't enough

A daemon that uses the token holds it in memory and reads it from a file at start, so both the file and the process must be beyond the desktop's UID. While spacesd runs as `pim-desktop`, any same-user process can:
- read the token file spacesd reads at start;
- stop spacesd and start its own with chosen arguments and data directory;
- write spacesd's data directory.

The only same-UID protection is Yama's `ptrace_scope` 1, which stops attaching to a non-descendant and so reading its `/proc/<pid>/mem`. It doesn't protect the file, which is the first thing read. So the credential is protected only if spacesd itself runs as another account.

## What spacesd's token authorizes

Read from [trycua/cua at `fca2193`](https://github.com/trycua/cua/tree/fca21937bc4e1420a23d544d11dbdf987f0266e6) (the pinned cua-spacesd 0.7.0; paths under `libs/`, git blob ids in brackets). Nothing was built or run.

- **One root token, no scopes.** `Auth` holds a single `token: RwLock<Option<Arc<str>>>` (`cua-spacesd-server/src/auth.rs` L287–292 [`347e31aa5324`]). There are no token lists, roles or scopes, and no documented narrower token (`cua-spacesd/README.md` L47–63 [`22dfb99b5f22`], `cua-spacesd-server/README.md` [`f711d1414cfa`]). It is accepted as `authorization` or `x-cua-env-authorization` `Bearer` (`auth.rs` L443–468) and compared in constant time for equal lengths (L440, `util.rs` L80–83 [`b1fe2c3af700`]).
- **Every gRPC service, with no per-method check.** `AuthLayer` wraps all of them (`server.rs` L234–236 [`bbfa9d8c74a7`]): System, Process, Filesystem, Driver, Teleport, Tunnel, Volume and reflection (L42–56, L190–198), and the desktop's Computer, Windows, Accessibility, Stream and Presence (`cua-spacesd-desktop/src/grpc/mod.rs` L50–54, L409–436 [`4a2bd1488d74`]). For a token caller, the only refusal is a missing or wrong token (`auth.rs` L1095–1100). Method lists bind only viewer tickets and relay callers (L221–231, L262–274).
  - **Programs:** `ProcessService.StartProcess` runs any command (`process/mod.rs` L908–915 [`2ceccba70dcc`]), as another user only when spacesd is root (L301–340), which it never is here.
  - **Files:** `Filesystem` reads, writes, moves and removes any path spacesd's account can reach; only viewer tickets are confined (`filesystem/mod.rs` L195–207 [`001b946ef1b2`]). It also mints signed `/files` URLs (L1014).
  - **The desktop:** the clipboard (`grpc/computer.rs` L36–45, L663–734 [`798efbd3936d`]) and pointer and keyboard input (L456, L581).
  - **Other services:** Teleport imports, tunnels to loopback and the guest's own addresses (`services/tunnel.rs` L250–262 [`baf24a2cbab9`]), and `Shutdown` of the daemon (`services/system.rs` L865–903 [`357444e64354`]).
- **spacesd itself.**
  - **Tickets:** the token mints tickets of any grant, including `ALLOW_ACTIVATION`, clipboard and files, for up to 24 hours (`services/system.rs` L962–1032). Their keys derive from the token (`auth.rs` L471–482).
  - **Relays:** `AttachRelay` and `DetachRelay` pass `require_root` for a token caller (`system.rs` L540–553, L931–960), so the token can attach spacesd to a relay of the caller's choosing.
  - **`Init`:** it can set a new token (`set_token`, L740–765), which locks out every other holder. That invalidates tickets and signed URLs but not open connections (it doesn't call `revoke_sessions`).
- **`/mcp`, when served (without `--no-mcp`), carries the whole Linux registry**, not the nine tools Pim curates (`cua-spacesd-desktop/src/lib.rs` L2418–2431 [`85ab80741b71`] → `platform-linux/src/tools/impl_.rs` L14609–14893 [`c67855ac30d6`]).
  - **What it includes:**
    - `launch_app`, which runs `Command::new` on a caller's `name` or `launch_path` and arguments (`impl_.rs` L1910–1929, L2113–2115): `sh -c …` included;
    - `run_script`, on by default (`cua-driver-core/src/tool.rs` L1335–1395 [`afef86dc4e54`]);
    - `clipboard_read` and `clipboard_write`;
    - `page` with `execute_javascript`;
    - `browser_download` and `browser_set_input_files`;
    - the recording tools and `install_ffmpeg`;
    - `set_config`;
    - every input tool.
  - **What dispatch checks:** process-wide settings only, never the caller or the token: "caller-supplied session strings or tool arguments are never authorization inputs" (`cua-driver-core/src/authorization.rs` L1118–1178, L1128–1130 [`8e4ed0d5578d`]). spacesd sets no policy file or permission mode, so the default `standard` mode allows clipboard, input, file transfer and `launch_app`. It refuses `kill_app` of processes the driver didn't start, and allows page JavaScript only in unrestricted mode (`consent.rs` L380–448 [`397b15a30751`]).
  - **gRPC:** `DriverService.CallTool` reaches the same tools, checking only that the name is known (`services/driver.rs` L147–191 [`b6107a099ce2`]).

**What `--no-driver` doesn't remove.** Read, not run. `--no-driver` stops spacesd linking `platform_tools()` only when there is no desktop provider (`if !args.no_driver && !desktop_tools`, `cua-spacesd/src/main.rs` L688–692 [`645e3ac49029`]). With the desktop services on, as in the viewer's unit, which doesn't pass `--no-desktop`, the server takes the desktop provider's registry for the Driver service and `/mcp` (`server.rs` L120–122, L193 [`bbfa9d8c74a7`]; `tool_provider`, `grpc/mod.rs` L473–482 [`4a2bd1488d74`]). On Linux that registry is always there (`linux_backend.rs` L739–741 [`2b8725ae4cb6`]). `/mcp` itself stays off with `--no-mcp` (`server.rs` L278). So in today's viewer configuration, a holder of the token can most likely already call every driver tool, `launch_app` included, through `DriverService.CallTool`, and drive input and the clipboard through `ComputerService`. That contradicts `docs/cua-viewer-first-startup.md` ("`/mcp` and the driver are off"), which this branch doesn't edit; it is reported for that page's owner. Running the pinned binary would settle it, and isn't authorized here.

**What Pim's side does not limit.**
- **The owner tag** is the Cua computer's own refusal of another space's call (`createNativeDispatcher`), and the agent session (`X-Cua-Agent-Session`) only picks a driver session. Neither is checked by spacesd or tied to the token.
- **The curated client** is Pim's policy for its own tools.
- **Approvals, the control state, the run identity and the send fence** govern what Pim's agents' native-app tools send.

None of these binds anything else that holds the token.

## Approvals, human control and the agent-owned machine

Three different things are easy to run together. Only the first two exist, and the protected design changes neither the first nor the third.

1. **Ordinary full agent OS access (exists).** Every agent of the space acts as `pim-desktop`.
   - `shell`, once approved, or unasked where the person let it run, runs any command as that user and may leave programs running detached (`src/extensions/files.ts`). Such a program outlives its approval, its chat and any change of control.
   - pim-computer passes the session's `DISPLAY` and `XAUTHORITY` to what it starts (`KEPT_ENVIRONMENT` in `desktop.ts`), so a command is a client of the person's X display. That such a client can inject input (XTEST, or `XSendEvent` as the driver itself uses) is general X11 behaviour, **not verified on the evaluation's Xvfb**.
2. **The curated-tool approval experience (exists, behind `nativeDesktop`).** Pim's approvals, its control state's admissions and lease, the run identity, the send fence and, in the protected design, the broker's fence latches (`docs/cua-native-fence-protocol.md`) decide whether a given native call is sent, and record what was. spacesd, X11 and the kernel never consult them.
3. **Global takeover exclusion (does not exist; unproven).** That while the person controls the desktop, nothing an agent started acts on it. A takeover in Pim's control state only closes Pim's own admissions and drops the lease. `inputQuiescence` is always `unproven` (`src/computer-control.ts`, `docs/computer-control-state.md`), no takeover or resume is exposed, and **human takeover is unavailable**.

**Do same-user direct spacesd calls bypass Pim's approvals and a human-control pause?**
- **Under placement A, yes, both.** Any same-user process reads the token, and spacesd checks nothing else.
- **Under the protected design, they lose the token,** so direct spacesd calls fail (`401`).
- **Same-user X11 clients and detached programs still bypass any pause.** They need no token: they act on the display as its user, and nothing on the VM consults Pim's control state or stops what is already running. The endpoint signals only the pim-computer it started, and the units use `KillMode=process`.

**Agent-owned machine.** Pim's model for a Cua computer, as built, is a machine its agents act on with the desktop user's full authority through `shell`. The protected design fits it: it takes spacesd's control (tickets, relays, `Init`, `Shutdown`, the driver's whole registry) away from that user and keeps native calls behind Pim and the broker. It does not make the machine one the person can take back from the agents. **Accepting credential visibility, or removing it, is a separate question from takeover exclusion**, and this page claims neither takeover nor quiescence.

## The protected-account design

### Accounts, files and who holds the token

| Holder | What | Can mint tickets, administer spacesd |
| --- | --- | --- |
| `pim-spacesd` (new system account, no login, in no other group) | Runs spacesd. Owns `/etc/pim-spacesd/token` (`0600`) in `/etc/pim-spacesd` (`0700`, `pim-spacesd`), and its data directory | Yes (it is spacesd) |
| `pim-bridge` (exists) | `/etc/pim-bridge/viewer-root-token` (`0600`), already read for the viewer. Runs the broker | Yes: it holds the root token, as it already does for the viewer |
| `pim-desktop` and every agent | No token file, no broker socket, no native child | No. It can reach `127.0.0.1:3211`, but every authenticated route answers `401`; `/health` and the static `/viewer` page need no token |
| root | Everything | Yes |

- **No root daemon by default.** Root would give spacesd every UID's authority (`ProcessService` switches users as root, `process/mod.rs` L301–340).
- **The memory boundary:** another UID can't attach to spacesd, read its `/proc/<pid>/mem` or `environ`, or read its files, without `CAP_SYS_PTRACE` or root.
- **What the desktop keeps:** it still owns its session and, presumably, Xvfb. It can stop the display and deny service; that is not new authority.

### How a separate-account spacesd reaches the display (unverified)

Read from the pinned source, not run. These decide whether the design works:

- **X11 access:** `pim-spacesd` needs an X authorization for the desktop's display. Either the Xvfb `-auth` cookie is readable through a dedicated group, or the session grants `xhost +si:localuser:pim-spacesd`. Either makes `pim-spacesd` a full client of that display, which is the trusted direction, and gives the desktop nothing new. The driver discovers a cookie from the X server's `-auth` file only where it can read that file (`platform-linux/src/xauth.rs`). The viewer page already calls this grant untested ("Placement B").
- **Input:** `click`, `type_text`, `press_key`, `hotkey` and `scroll` use X11 `XSendEvent` to a window (`platform-linux/src/input/mod.rs` [`f382aee62fce`]), which any authorized client can send. Terminal emulators are typed into through their pty master (`crate::tty`), which belongs to the desktop user, so **typing into a terminal will likely fail** from another UID. The MPX/uinput keyboard paths need `/dev/uinput` access, which is a device grant.
- **Screenshots** (`get_window_state`'s image): MIT-SHM, with a segment the server creates and passes as a descriptor (`capture.rs` [`b2c04867dcfa`]). It is probably independent of the client's UID; unverified.
- **Accessibility trees** (`get_window_state`): AT-SPI through `org.a11y.Bus` on the desktop's session bus, `/run/user/<uid>/bus` (`health_report.rs` [`fbdf341328c7`] L100–160). D-Bus session buses normally admit only their own UID, so **from `pim-spacesd` the trees will likely be empty** ("X11 input injection still works"). The fix is a bus policy admitting `pim-spacesd`, which gives it the desktop session's bus as a whole, and is a decision.
- **Apps and windows:** `list_windows` and `bring_to_front` are X11 operations, and should work with the X grant. `list_apps` reads processes, which `/proc` shows across UIDs by default (`hidepid=0`).

If the accessibility tree can't be had without a session-bus grant Groves rejects, `get_window_state` returns screenshots without trees, and the curated set shrinks or native calls stay off.

### The broker and the demux

- **Where:** in the bridge process (`pim-bridge`), using `createNativeDispatcher` against `http://127.0.0.1:3211/mcp` with the bridge's existing token copy. There is no new socket, credential or desktop-owned child.

  **The alternative** is a broker process in `pim-spacesd`'s account behind a Unix socket only `pim-bridge`'s group can reach. It adds a socket, a group and a process, and changes nothing about who holds the token, because the bridge holds it for the viewer anyway. It would matter only if the viewer's ticket minting also moved out of the bridge.
- **The interface** is the nine curated operations, as `createNativeDispatcher` already admits them, and nothing else. No `launch_app`, no `run_script`, no other driver tool, no gRPC, no ticket minting for native calls.
- **The demux:**
  - **What it adds:** the relay would parse what Pim sends only enough to recognize a call with op `native_tool`. It answers such calls itself through the broker and never forwards them to pim-computer.
  - **Forged replies:** it records the IDs of native calls in flight. Any message from pim-computer naming one of them is dropped, and the session ends, so the untrusted side can't forge a native outcome.
  - **Everything else** passes unchanged, both ways.
  - **Pim's side:** `native_tool` stays answered by whatever Pim's link reaches. A bridge without the broker forwards it, and pim-computer answers `ENOSYS`, which Pim reads as `unknown`. So the bridge must declare the broker (in its `101` or `hello`), and Pim must refuse to send a native call to a bridge that doesn't.

### Request identity and authentication

- **Authentication:** Pim's messages reach the bridge over the existing channel: TLS (Caddy, then the bridge's own certificate), the bridge's bearer token and the space check (`check` in `cua-bridge.ts`). The desktop side can't write into it, since the demux reads only Pim's half. While the broker is in the bridge, a signature adds no authenticity; it would if the broker were a separate process.
- **A native call is bound exactly** (the fields of `native.execute`):
  - Pim's frozen native request: owner, agent, run ID, call ID (the request ID) and the tool's arguments. The broker reads it once into its own frozen copy (`readNativeRequest`), and only that copy is ever sent.
  - The arguments' canonical SHA-256 (`canonical` in `native-mcp.ts`), the coordinator's epoch, and the broker instance it is meant for.

  Anything that doesn't match exactly is refused unsent.

### Execution-time authority

Specified in `docs/cua-native-fence-protocol.md`: acknowledged remote fencing (Groves's choice). In short:
- Stop closes the runs it stops, Delete the chat, and removing an agent that agent's calls. Each closes Pim's local admission at once and answers without waiting for the desktop.
- A separate fence state is confirmed only when every broker instance that could still send a call Pim intended in the scope has latched it and acknowledged: no new broker sends in that scope. Sends already made, and other desktop programs, aren't covered.
- An unavailable VM leaves the fence unconfirmed, never confirmed.
- Pim's send gate would hold the harness's line across the awaited durability of the call's intent, so that no harness run end lands between its authority read and the send. Pim's own records are re-read synchronously just before it. **Holding the line across `ctx.storage.sync()` is an unqualified risk, not an accepted detail.**
- The acknowledgment is the instance's latch alone, deduplicated per scope, with fence capacity reserved when each intent is written.
- Pim never re-sends an action. The broker keeps no durable journal: an acknowledgment Pim recorded durably stays valid after its instance dies, and a missing one from a dead instance leaves the fence unconfirmed.

**Withdrawn from revision `023a068`:**
- the prepare-then-`go` protocol (B), with its claims that it put "the authority's commit at the broker's send";
- that a request is "recorded as sent in the same transaction that transmits its go".

The send gate accepted at `b347372` transmits inside a harness commit's callback, before that commit resolves, and no write there is awaited as durable before the send. Its tests qualify the local order of reads in workerd with stand-ins, not a remote protocol.

### Unknown, and no replay

Unchanged: once Pim may have transmitted a call's `native.execute` (its intent is durable), any outcome that isn't a valid answer is `unknown`, whether lost in transit, at the broker, or after `fetch`. The request stays unknown until reconciled, its run is latched in the binder and the coordinator (and in the broker while it lives), it stays outstanding for fences, and nothing is sent again (`docs/cua-native-mcp.md`, "Outcomes and the commit point").

### Costs and limits

- **New moving parts:**
  - a new account and its unit;
  - an X authorization grant, possibly a session-bus grant and a `/dev/uinput` grant;
  - the token's two files owned by two accounts;
  - message parsing in the internet-facing bridge;
  - the broker declaration;
  - the fence protocol's messages and records on both sides, and the broker's bounded queue, latches and request set;
  - tests for each.
- **Probable losses** under another UID: terminal typing, and accessibility trees unless the bus is granted.
- **The bridge becomes the native executor.** A compromised bridge already has the root token through the viewer, so the design adds code, not authority.
- **The same-user display remains open to agents** as in layer 1. There is no takeover, pause or quiescence claim.

## Provisioning, rotation and revocation (protected design; proposal only)

- **Provisioning:** the one-time `root-token` step (`journal-provision.ts`) would write spacesd's file as `pim-spacesd`'s and the bridge's copy as now. The desktop gets none. No value appears in any configuration, unit, argument, variable or log.
- **What spacesd does with it:**
  - **`--token-file`:** read once at start (`cua-spacesd/src/main.rs` L611–612, L662 [`645e3ac49029`]), with no reload, expiry or token list. `Init` lets any holder, now only the bridge and spacesd, set a new one.
  - **`--await-token-file`:** polls the file (`token_file.rs` L26 [`a900991c82bc`]). Replacing or emptying it drops every session (`context.rs` L349–382 [`f0ac88edb9df`]), and `Init` is disabled. Under placement A that made the desktop-owned file a live control; under this design only `pim-spacesd` and root can write it, so it becomes a usable revocation. The bridge's copy must be replaced too, or the viewer and broker stop.
- **Revocation in an evaluation:** stop the bridge, which ends Pim's reach, the broker and the viewer host; then stop spacesd; then discard the VM. A native call in flight ends `unknown` and latches. Tickets die with spacesd's token. **Limit:** this ends the token's holders, not what agents started as `pim-desktop`; that ends only with the VM.

## Rejected (record)

- **Asynchronous revocation (`70a6e0e`):** a permit checked against revocations Pim sends asynchronously. A lifecycle change committed in Pim could precede the broker's send while its revocation was still in transit.
- **Prepare, then an irrevocable `go` (protocol B, `023a068`):** rejected by Groves in favour of acknowledged fencing. Its claims are withdrawn above.
- **The desktop-owned placement:** below.

### The desktop-owned placement

The earlier proposal would have started the endpoint with `--native on`, handed it `/etc/pim-spacesd/token` (the desktop's own file), and dropped `--no-mcp` from a spacesd running as `pim-desktop`. Groves rejected it: the token's whole authority would be every same-user process's, and spacesd's in-memory copy would be in the desktop's UID. What it surfaced still holds:
- the bundle lacks `cua-computer.ts`, `native-mcp.ts` and `native-mcp-upstream.ts`;
- the installer's `unit-check` reads only `FragmentPath`, `DropInPaths`, `User` and `KillMode`, not `ExecStart`;
- `--no-driver` probably doesn't remove the Driver service (above).

## Qualifying descriptor 3 (rejected path; unrun)

The fixtures in `computer/cua-host/qualification/` (`fd3-inheritance.ts`, `fd3-child.ts`) would qualify the desktop-UID Cua child's descriptor 3 on a real kernel. They belong to the rejected placement, are off this design's path, and **have never been run**. They are in no suite and not in the bundle, and are only typechecked with the host.

- **Guards:** the harness runs only with `--authorized-descriptor-qualification`, never as root, and only with `/proc/self/fd`.
- **Setup:** synthetic non-secret bytes in a new private folder, and the real `readEndpointArguments` and `createDesktopEndpoint` with a real spawn and an in-memory connection, so nothing listens.
- **The child** runs the real `startCuaComputer` against a stand-in spacesd that answers 503.
- **Step `good`:**
  - descriptor 3 is inherited, closed before serving and absent from a grandchild;
  - the bearer's hash matches the synthetic bytes;
  - the endpoint holds no copy;
  - the child exits 0.
- **Step `refused`:** a file the child refuses gives `credential-format`, with nothing held and no other program started.
- **Bounds:** each step 15 s, stop at the first failure, no retry, cleanup always, and output of booleans and fixed reasons only.

## Open decisions and unverified upstream

1. **Accessibility across accounts.** A session-bus policy admitting `pim-spacesd`, or native calls without accessibility trees, or no native calls.
2. **The X authorization grant**, and whether Xvfb's owner is the desktop account.
3. **Broker placement:** in the bridge (proposed), or a separate process if viewer ticket minting is also to leave the bridge.
4. **The execution protocol:** decided, acknowledged remote fencing. Its spec (`docs/cua-native-fence-protocol.md`) awaits review, and its interleavings need stand-in tests once implemented.
5. **Unverified upstream, from reading only:**
   - X11 access and MIT-SHM capture from another UID;
   - AT-SPI from another UID;
   - terminal typing;
   - `--no-driver`'s effect;
   - `/mcp`'s `tools/list` under the pinned binary.

   Each needs a bounded read-only check on a disposable VM, separately authorized.
6. **Takeover** stays unavailable on any space whose agents have `shell` or desktop tools. Nothing here proposes otherwise.
