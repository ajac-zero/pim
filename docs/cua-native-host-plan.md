# Starting the Cua computer from the installer: a plan for review

This page proposes the smallest change to the evaluation installer (`computer/cua-host/eval-install/`, `docs/cua-eval-install.md`) that would start the desktop endpoint with `--native on`. It also states what spacesd's token really authorizes, how the credential would be provisioned, rotated and revoked, how descriptor 3 would be qualified on a real kernel, and an ordinary smoke test that doesn't depend on any of it. **It is a plan. Nothing here is implemented in the installer, applied, provisioned or run.** Pim's `nativeDesktop()` stays false (`src/pim.ts`), so no agent is offered a native-app tool whatever the host does. Four decisions are Groves's (see "Decisions awaiting Groves"); nothing below assumes their answers.

## Where things stand

- **The endpoint takes the setting.** `desktop.ts` starts the Cua computer only with `--native on --cua-computer <path> --cua-owner <space> --cua-origin <origin> --cua-credential <file>`. Without `--native`, or with `--native off`, it starts pim-computer as before. Partial, repeated or contradictory native settings stop it (`native-settings` or the usage), and a Cua computer that fails is never replaced by pim-computer (`docs/cua-bridge.md`). In-process stand-in tests cover it (`computer/cua-host/test/native-startup.test.ts`; `pnpm run test:native-standin` in `computer/cua-host`, 79 tests).
- **Nothing passes it.** `renderUnits` (`eval-install/config.ts`) writes the desktop unit's `ExecStart` without `--native`, and no other service, script or variable gives it.
- **spacesd is already installed with a viewer.** A configuration with `viewer` adds `pim-cua-spacesd.service`, running the pinned spacesd 0.7.0 as `pim-desktop`, on `127.0.0.1:3211`, with `--no-mcp --no-driver`, and its token in `/etc/pim-spacesd/token` (`pim-desktop`, `0600`, in root's `/etc/pim-spacesd`). `journal-provision.ts root-token` makes that file and the bridge's copy once; `start` refuses without it (`viewer-root-token-missing`). `docs/cua-viewer-first-startup.md` ("spacesd") records the decision to run spacesd as the desktop account ("Placement A").
- **The bundle can't run the Cua computer.** `BUNDLE_SOURCES` (`eval-install/operator.ts`) holds `desktop.ts`, `cua-credential.ts` and `native-outcome.ts`, but not `cua-computer.ts`, `native-mcp.ts` or `native-mcp-upstream.ts`, which the Cua computer imports. A bundle missing a runtime import has already stopped an evaluation's endpoint once (`ERR_MODULE_NOT_FOUND`, `docs/cua-viewer-first-startup.md`).

## The proposed change

One optional configuration field, three units' text and the bundle list. Nothing in Pim changes.

1. **Configuration.** An optional `"native": true`, accepted only beside `viewer` (it needs spacesd and its token file) and only as exactly `true`. Anything else, or `native` without `viewer`, is refused before anything changes (`config-native`). Absent, every rendered file is byte for byte what it is today.
2. **The desktop unit.** With `native`, its `ExecStart` gains five settings after the ordinary ones, and nothing else in the unit changes:

   ```
   ExecStart=<node> <bundle>/computer/cua-host/desktop.ts --socket /run/pim-session/session.sock --root <workspace> --browser <browser> --pim-computer <bundle>/computer/pim-computer.ts --headful --native on --cua-computer <bundle>/computer/cua-host/cua-computer.ts --cua-owner <owner> --cua-origin <viewer.origin> --cua-credential /etc/pim-spacesd/token
   ```

   The owner is the configuration's `owner`, the space the bridge serves (`--space`). The origin is `viewer.origin`, spacesd's own `http://127.0.0.1:3211`. The credential is spacesd's own token file, which is already the desktop account's `0600` file with one name at a path with no links, as the endpoint requires. No new secret file is made.
3. **The spacesd unit.** With `native`, its `ExecStart` drops exactly `--no-mcp --no-driver`, so `/mcp` and the driver run. `--listen 127.0.0.1:3211`, `--quic-port 0`, `--cursor-probe false`, the token file and the data directory stay. Without `native` it is unchanged.
4. **The bundle.** With `native`, `operator.ts bundle` also takes `computer/cua-host/cua-computer.ts`, `native-mcp.ts` and `native-mcp-upstream.ts`, and `BUNDLE` records it (a `native` line, as it records the viewer). The planner checks those files as it checks the rest (`bundle`). Without `native`, the bundle and its digest are unchanged.
5. **The planner, `start`, `status` and `recover`.**
   - The planner and `start` need nothing new: `start` already refuses without spacesd's token file (`viewer-root-token-missing`).
   - The installer writes each unit itself, new, from `renderUnits`. Its `unit-check` reads back only `FragmentPath`, `DropInPaths`, `User` and `KillMode` (`checkUnits` in `install.ts`), not the text, so a unit root edited afterwards isn't caught. The proposal adds `ExecStart` to the properties it reads and compares it with the rendered line, so a native line where none was configured, a missing `--no-mcp`, or the reverse fails `unit-check`.
   - `status` reports nothing new.
   - `recover.ts` renders the desktop unit with `renderUnits`, so it follows the configuration it is given. A native configuration's unit can't be recovered as an ordinary one, and the reverse.
6. **Tests**, all over synthetic VMs and stand-ins, as the installer's are now:
   - Without `native`, the four units, the tmpfiles entry and the bundle list are byte for byte today's.
   - With `native`:
     - the desktop `ExecStart`, split as systemd splits it, gives `readEndpointArguments` exactly the five Cua settings above;
     - the spacesd `ExecStart` differs from today's by exactly the two removed flags;
     - the bundle holds the three files;
     - `unit-check` refuses an `ExecStart` that differs from the rendered one, in either direction;
     - `native` without `viewer`, `false`, a string or an object is refused.

A scratch check (not committed) rendered the `ExecStart` above for the documented example configuration and passed it to the real `readEndpointArguments`. It gave `cua` = program `/opt/pim-cua/bundle/computer/cua-host/cua-computer.ts`, owner `o_0123456789abcdefghijklmnop`, origin `http://127.0.0.1:3211`, credential `/etc/pim-spacesd/token`, and the same line without the native settings gave no `cua`.

**Fixed accounts, paths and modes** (all already made by the installer or `root-token`; the change makes no new account, file or directory):

| What | Owner | Mode | Made by |
| --- | --- | --- | --- |
| `/etc/pim-spacesd/` | root | `0755` | the installer (viewer) |
| `/etc/pim-spacesd/token` (spacesd's token, also the Cua computer's credential) | `pim-desktop` | `0600` | `journal-provision.ts root-token`, once |
| `/etc/pim-bridge/viewer-root-token` (the same value, the bridge's copy) | `pim-bridge` | `0600` | the same step |
| `/run/pim-session/` | `pim-desktop:pim-session` | `2750` | tmpfiles.d |
| `pim-cua-desktop.service`, `pim-cua-spacesd.service` | root | `0644` | the installer |

**Startup order** stays `start`'s: the desktop endpoint, spacesd, the bridge, then Caddy. The endpoint checks the credential file when it starts and opens it again for each connection. The Cua computer makes no request until Pim's first native call, and Pim can make none before the bridge, which starts after spacesd. At boot both are enabled and may start in any order. A native call before spacesd is up fails its run's setup, which calls no tool, and is refused `unavailable` with nothing sent. Pim makes none anyway while `nativeDesktop()` is false.

**What the change does on its own:** with Pim unchanged, the Cua computer serves the bridge exactly as pim-computer does, and `native_tool` never arrives. What it adds is spacesd's `/mcp` and driver on loopback, reachable by everything that holds the token (next section), and a host process that holds the token in memory. So it should be applied only together with an authorized qualification of the native path, not ahead of one.

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
- **`/mcp`, once the change drops `--no-mcp --no-driver`, serves the whole Linux registry**, not the nine tools Pim curates (`cua-spacesd-desktop/src/lib.rs` L2418–2431 [`85ab80741b71`] → `platform-linux/src/tools/impl_.rs` L14609–14893 [`c67855ac30d6`]).
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

**What Pim's side does not limit.**
- **The owner tag** is the Cua computer's own refusal of another space's call (`createNativeDispatcher`), and the agent session (`X-Cua-Agent-Session`) only picks a driver session. Neither is checked by spacesd or tied to the token.
- **The curated client** is Pim's policy for its own tools.
- **Approvals, the control state, the run identity and the send fence** govern what Pim's agents' native-app tools send.

None of these binds anything else that holds the token.

## Who holds it, and what descriptor 3 does and doesn't do

Under placement A, spacesd runs as `pim-desktop`, so the token's authority over the guest is the desktop account's own, plus control of spacesd itself (tickets, relays, `Init`, `Shutdown`). Every process running as `pim-desktop` can read `/etc/pim-spacesd/token` directly, since it is that account's `0600` file, and call `127.0.0.1:3211` with it. That includes:
- spacesd itself;
- the desktop endpoint and the Cua computer (or pim-computer);
- every command an agent's approved `shell` runs;
- the browser pim-computer starts and the pages' downloads it saves;
- every app launched in the session.

Being the file's owner, any of them can also change or empty it. The endpoint's socket (`/run/pim-session/session.sock`, `0660`, `pim-desktop:pim-session`) is reachable by the same account and by `pim-bridge`. Anything as `pim-desktop` can connect to it, or run `cua-computer.ts` itself with the file as its descriptor 3.

**Descriptor 3 is hygiene, not isolation.** It keeps the token out of the Cua computer's arguments, environment and logs, and out of the descriptors of the commands and browser it starts. It doesn't keep the token from any same-user process, which reads the file. Yama's `ptrace_scope` 1 (which the installer requires) stops a same-user process from reading another's memory unless it is its descendant, but that matters little while the file itself is readable.

**Agent tools and approvals can't police same-user use of the bearer.** An approved `shell` command (`curl -H "authorization: Bearer $(cat /etc/pim-spacesd/token)" …`), a program it starts, or a page's download run later can use the token with no further approval. Pim's agents can already run anything as the desktop user through `shell` after its approval, and the token adds control of spacesd to that. A real boundary would need the token held by an account the agents aren't, with only the curated calls exposed to them. That is a new security boundary, not proposed here without Groves's decision.

## Decisions awaiting Groves

1. **Whose authority the native path carries.** Accept placement A for native calls: the token is known to every `pim-desktop` process, its reach is the desktop account's plus control of spacesd, and Pim's approvals cover only Pim's own tools. Or require a boundary first (placement B, or a curated proxy under another account). That needs a design and review of its own, and isn't drafted here.
2. **Turning on `/mcp` and the driver.** This adds the whole driver registry on loopback to every token holder, including `launch_app`, `run_script` and `set_config`, and the driver's permission mode stays `standard` unless a policy is set. Whether to set a driver policy file (`CUA_DRIVER_POLICY_FILE`) or permission mode alongside is a further decision. Any such policy is process-wide, so it would also bind Pim's own calls.
3. **Rotation in an evaluation.** The proposal below supports no rotation in place: revoking means discarding the VM. Rotating in place would need new reviewed tooling.
4. **The token file's owner.** The desktop account owns its token file, so any same-user process can change or empty it, stopping the viewer and native calls; that is denial of service, not new authority. Making it root's `0640` with the desktop's group would stop that, but needs spacesd to accept it, and both the endpoint's and the Cua computer's credential checks to change (they require the user's own `0600` file). It doesn't stop reading.

## Provisioning, rotation and revocation (proposal only)

- **Provisioning** is what it is now: `journal-provision.ts root-token`, as root, once, writes 32 random bytes as base64url to `/etc/pim-spacesd/token` and `/etc/pim-bridge/viewer-root-token`, each created exclusively. It never prints, logs or sends the value, and refuses if either file exists. The native change adds no file and no second value. No secret value appears in any configuration, script, unit, argument, variable, log or this page.
- **What spacesd does with it.** The unit uses `--token-file`, which spacesd reads once at start (`cua-spacesd/src/main.rs` L611–612, L662 [`645e3ac49029`]). It handles only SIGTERM and Ctrl-C (L826–840) and has no reload, expiry or token-list API.
  - **`--token-file` (the unit's mode):** replacing the file changes nothing until spacesd restarts. Any token holder can rotate the token in place with `Init`, which keeps open connections.
  - **`--await-token-file`:** spacesd polls the file every 500 ms (`token_file.rs` L26 [`a900991c82bc`]), and replacing or emptying it drops every connection, tunnel and volume (`revoke_sessions`, `context.rs` L349–382 [`f0ac88edb9df`]). `Init` can't change the token in this mode (`system.rs` L673–684). It would close the `Init` lock-out, but it makes the desktop-owned file a live control: any same-user process can rotate or revoke at will.
- **A running Cua computer keeps the token it read**, and file replacement is not revocation. The endpoint reopens the file for each connection, so only the next child reads a new value. The old one works for as long as spacesd accepts it.
- **Revocation, proposed: discard the VM.** Nothing in the evaluation tooling restarts spacesd: `start` refuses a spacesd unit that has run and ended (`viewer-unit-state`), and `root-token` refuses existing files. So the fail-closed path is:
  1. Stop the bridge, which ends Pim's reach.
  2. Stop the desktop endpoint, which waits for the Cua computer's exit.
  3. Stop spacesd.
  4. Discard the VM.

  Any call in flight at step 1 or 2 ends `unknown` in Pim, latches its run and is never replayed. **Limits:** until spacesd stops, every same-user process that read the token can still use it; tickets minted with it last until spacesd stops; and a stopped service is not a sign that nothing it started still runs (`docs/cua-eval-install.md`).
- **Rotation in place, if Groves wants it later**, would be a new reviewed step run as root:
  1. Stop the bridge, the desktop endpoint and spacesd, in that order.
  2. Write a new value to both files, each as a new file renamed over the old in its root-owned directory, with the same owner and mode.
  3. Start spacesd, the desktop endpoint and the bridge.
  4. Change `start`'s spacesd rule to allow this one sequence.

  It doesn't remove the token from same-user processes: they read the new file.

## Protection against wrong or partial settings, and no fallback

- **Configuration:** `native` other than `true`, or without `viewer`, is refused before anything changes. The units are rendered from the checked configuration only, and the proposed `ExecStart` comparison in `unit-check` would refuse a partial or edited `--native` line (today's check doesn't read `ExecStart`).
- **The endpoint:**
  - Partial, repeated or contradictory native settings stop it (`native-settings`, usage).
  - An owner that isn't a space's identity (`cua-owner`), an origin that isn't exactly `https://host[:port]` or loopback `http://` (`cua-origin`), or a credential that isn't the desktop user's regular `0600` file with one name at a link-free path, of 1 to 4,097 bytes (`credential`), stops it before it listens.
  - The Cua computer refuses another space's calls unsent (`identity`).
- **No fallback:**
  - A native endpoint never starts pim-computer instead: a Cua computer that can't start, refuses its credential, or fails before its hello leaves the connection closed, and Pim's call fails rather than reaching another computer.
  - A refused endpoint exits 1 and its unit doesn't restart (`Restart=no`); `start` then refuses (`desktop-not-clean`), and the VM is rebooted or discarded.
  - Pim never sends a native call to a Sprite or a paired computer (`docs/cua-native-mcp.md`).

## Qualifying descriptor 3 (separately authorized; not run)

No test starts a real child with a credential descriptor. The stand-in tests show the order of calls, not what a kernel does with an inherited descriptor. The qualification is in `computer/cua-host/qualification/`, outside every suite and the bundle. It is typechecked with the host (`tsconfig.json` includes it) and **has never been run**:

- **`fd3-inheritance.ts`** runs only with `--authorized-descriptor-qualification`, never as root, and only on Linux with `/proc/self/fd`.
  - **Setup:** it makes a private `0700` temporary folder holding:
    - a root folder;
    - a never-run stand-in browser;
    - a `0600` credential of synthetic bytes: `pim-fd3-qualification-` and 32 random hex digits, not a token of anything.
  - **The endpoint:** the real `readEndpointArguments` and `createDesktopEndpoint`, with the real `spawn` and credential checks. `--cua-computer` names `fd3-child.ts`. The connection is in memory, through the endpoint's `listener` seam, so nothing listens.
- **`fd3-child.ts`** stands where `cua-computer.ts` would.
  - **Before anything:** it records the identity (device and inode) of the descriptor 3 it inherited.
  - **The start:** it runs the real `startCuaComputer`, which reads and closes descriptor 3 with the real `readCredential`.
  - **Stand-ins:** spacesd is a `fetch` that sends nothing and answers 503; serving is a check.
  - **The check, when serving begins:** it looks for that identity among its own descriptors, then starts a grandchild (Node, no shell) that looks among its own. It then makes one native call of its own owner, so the dispatcher hands the bearer to the stand-in, which hashes it.
  - **Its report:** one JSON line: `inherited`, `closedBeforeServe`, `grandchildClean` and the bearer's SHA-256. On a refusal, the fixed reason and whether it still held the file.

**Steps,** each bounded at 15 s, stopping at the first failure, with no retry:

1. **`good`:**
   - exactly one child, the fixture, started;
   - the endpoint holds no descriptor of the file after the spawn;
   - the child reports descriptor 3 inherited, closed before serving and absent from its grandchild;
   - the bearer's hash equals the synthetic bytes';
   - ending the connection ends the child with status 0.
2. **`refused`:**
   - the file rewritten to bytes the endpoint takes and the child refuses (`not a token`);
   - the child reports `credential-format` and holds no descriptor of it;
   - it exits 1;
   - the endpoint holds none;
   - no other program was started.

**Cleanup always runs:** connections ended, the endpoint closed within 10 s, every started child checked to have exited and sent `SIGKILL` if not, and the temporary folder removed. A cleanup that fails is reported beside the result.

**Output** is step names, booleans, exit codes and fixed reasons. It never includes the bytes, their hash or a path. It passes only with every check true and no cleanup failure.

**Not covered:** a close that fails in the parent or child (only the stand-in tests can make one fail), Chrome or a shell starting under pim-computer, and anything on the VM.

## The ordinary smoke test (proposal only; independent of the native stage)

**What it qualifies:** the ordinary path of an evaluation's Cua computer, end to end: transport, approvals and the computer's effects. It is **not an autonomous-agent qualification**. The preview's stand-in model calls exactly the tool a message names (`/tool <name> {json}`, `preview/worker.ts` L69–70) and decides nothing.

**Prerequisites:**
- The owner is signed in to the evaluation's preview with their **existing passkey**, through the web app (`POST /auth/sign-in/options`, then `POST /auth/sign-in`, `src/auth/index.ts`). No dev sign-in, portal link or new enrollment.
- The space's computer is the evaluation's Cua computer.
- `shell` is set to ask first, so its approvals reach the owner.
- A new chat with Pim.

**Each directive is one message,** sent alone in order. Paths are absolute: `/workspace` for file tools, and `/srv/pim-workspace`, the configuration's `workspace`, in commands. The first command fails unless `$PIM_WORKSPACE` is that folder, so nothing depends on the shell's working directory. The names are fixed and new. `set -C` refuses to overwrite.

1. **Shell writes a new file** (approve it in Approvals):

   ```text copy Copy Smoke Step 1
   /tool shell {"command": "set -euo pipefail; set -C; test \"$PIM_WORKSPACE\" = /srv/pim-workspace; printf '%s\\n' pim-smoke-20261029 > /srv/pim-workspace/pim-smoke-20261029-shell.txt; cat /srv/pim-workspace/pim-smoke-20261029-shell.txt", "cwd": "/workspace", "timeout_seconds": 30}
   ```

   Expect `Exit code 0` and `pim-smoke-20261029`.
2. **Read it back**, with no approval:

   ```text copy Copy Smoke Step 2
   /tool file_read {"path": "/workspace/pim-smoke-20261029-shell.txt"}
   ```

   Expect `pim-smoke-20261029`.
3. **The structured browser on a harmless public page**, with no approval:

   ```text copy Copy Smoke Step 3
   /tool browser_open {"url": "https://example.com/"}
   ```

   Expect `Page: Example Domain`, `URL: https://example.com/` and the page's text. Then close the window:

   ```text copy Copy Smoke Step 3b
   /tool browser_close {}
   ```

4. **A denied shell command** (deny it in Approvals):

   ```text copy Copy Smoke Step 4
   /tool shell {"command": "set -C; printf '%s\\n' denied > /srv/pim-workspace/pim-smoke-20261029-denied.txt", "cwd": "/workspace", "timeout_seconds": 30}
   ```

   Expect the tool to report the denial. Then check that nothing ran:

   ```text copy Copy Smoke Step 4b
   /tool file_list {"path": "/workspace"}
   ```

   Expect `pim-smoke-20261029-shell.txt` and no `pim-smoke-20261029-denied.txt`.
5. **Clean up** (approve it in Approvals):

   ```text copy Copy Smoke Step 5
   /tool file_delete {"path": "/workspace/pim-smoke-20261029-shell.txt"}
   ```

   Then repeat step 4b and expect neither file.

**Stop rules:**
- Stop at the first unexpected result.
- Any answer saying a call may have run, or a timeout, is unknown: don't send that directive or any later one again, and record the state.
- Never retry a step. If step 1's file exists before the run, `set -C` refuses and the run stops there; choose a new date suffix for the whole run instead.
- Approve and deny only the request each step names.

**Checked against the source:**
- the schemas of `shell` (`src/extensions/files.ts`: `command`, optional `cwd` under `/workspace`, `timeout_seconds` 1 to 600);
- `file_read`, `file_list` and `file_delete` (`@cloudflare/computer` 0.5.1: `path` and optional fields);
- `browser_open` (`src/extensions/browser.ts`: `url` matching `^(https?://|data:text/html)`) and `browser_close`;
- the approval routes (`POST /approvals/:id/approve` and `/deny`, `src/pim.ts`);
- `$PIM_WORKSPACE` (`computer/pim-computer.ts`).

A scratch check (not committed) parsed each directive with the preview's own directive pattern and JSON, and found only the schemas' fields.
