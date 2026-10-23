# Cua evaluation (private prototype)

A private, single-owner prototype in which one person's agents use a [Cua](https://github.com/trycua/cua) machine as their computer: files, shell and a browser driven with cua-driver's typed browser tools. The person pauses the agents to use the machine themselves in Cua's viewer, in a tab of its own, and only they resume them.

**It is an evaluation on a review branch, not a feature.** It is off unless a deployment sets all three of its settings, only for the one owner they name, and only once that owner turns it on. It has run only against stand-ins: Pim's tests with a stand-in bridge, the bridge's tests with a stand-in spacesd, and a real Caddy in front of recorders. **Nothing here has run against a real Cua machine.** Sprites and paired computers are unchanged and stay the default; turning the evaluation off gives the agents back the space's own computer as it was.

## How it fits together

```
 Pim (local preview only)                              Cua evaluation VM
┌──────────────────────────────┐   HTTPS :443   ┌──────────────────────────────────────────────┐
│ Pim Durable Object           │───────────────▶│ Caddy, cua-eval.ajac-zero.com                │
│  CuaEvaluation (src/cua.ts)  │ 6 POST routes, │  /viewer…  HTTP Basic, viewer RPC allowlist  │
│  CuaBrowser (cua-browser.ts) │ X-Pim-Bridge-  │  /pim-bridge/v1/…  no Basic, ≤ 192 KiB       │
│  CUA_EVAL_BRIDGE_TOKEN       │ Authorization  │  …/StreamService/OpenMedia → the bridge      │
└──────────────┬───────────────┘                │   │                                          │
               │ /api/cua…                      │   ▼                                          │
               │ (session cookie, same origin)  │ pim-cua-bridge 127.0.0.1:3290 (pim-bridge)   │
┌──────────────┴───────────────┐                │   who has the machine: state.json            │
│ Web app: Settings → Computer │                │   holds spacesd's root token (credential)    │
│  Pause · Open viewer · Resume│   new tab,     │   │ gRPC-Web, /mcp                           │
└──────────────────────────────┘   viewer ticket│   ▼                                          │
                                 ──────────────▶│ cua-spacesd 127.0.0.1:3211 (private)         │
                                                │   processes as pim-agent, cua-driver, media  │
                                                └──────────────────────────────────────────────┘
```

- **Pim** reads `CUA_EVAL_BRIDGE_URL`, `CUA_EVAL_BRIDGE_TOKEN` and `CUA_EVAL_OWNER` from the Worker's environment ([`src/cua.ts`](../src/cua.ts)). The address must be `https://` on a fixed allowlist (`CUA_BRIDGE_HOSTS`, only `cua-eval.ajac-zero.com`), an origin with no login, port, path or query; the credential at least 256 bits of base64url; the owner one `o_…` id. Any unsound value leaves the evaluation off and logs which setting is wrong, once, never its value. Pim follows no redirect from the bridge, caps answers at 12 MiB, and scrubs its credential from any error.
- **The space** stands the evaluation in for its computer (`ComputerProvider` in [`src/computer.ts`](../src/computer.ts)), so `shell`, the file tools and Files reach the Cua machine through the same code, the same gated actions and the same per-agent tool permissions as a Sprite or a paired computer. Each file tool runs on the computer it started on (`Computer.pinned`), so none reads one computer and writes another. The browser tools reach a `CuaBrowser` ([`src/cua-browser.ts`](../src/cua-browser.ts)) through the `AgentBrowser` interface, one use at a time, never over DevTools.
- **pim-cua-bridge** ([`deploy/cua-eval/pim_cua_bridge.py`](../deploy/cua-eval/pim_cua_bridge.py), Python's standard library only) runs on the VM, on loopback, behind Caddy, and decides who has the machine. It takes Pim's own credential, never the root token or the human's Basic login, and calls only the one spacesd at 127.0.0.1:3211:
  - `call`: pim-computer's `stat`, `read`, `write`, `mkdir`, `rm`, `rename`, `readdir`, `find`, `grep` and `exec`, each one process that spacesd starts as `PIM_BRIDGE_RUN_AS`, tagged `pim-…`.
  - `driver`: eight cua-driver tools in fixed shapes (`start_session`, `browser_prepare`, `list_windows`, `get_browser_state`, `browser_navigate`, `browser_click`, `browser_type`, `end_session`), one session and one isolated named profile, both `pim`, never an existing browser profile.
  - `pause`, `resume`, `status` and `viewer`: who has the machine, below.
  - `media/open`: the viewer's own `OpenMedia`, which Caddy sends here, passed to spacesd with the viewer's ticket only.

  It refuses other paths, methods, content types and shapes; bodies over 192 KiB; more than 60 requests in 10 seconds, or 4 calls at once; and everything for a minute after 10 failed credentials. Its errors and logs never carry headers, bodies, queries or upstream answers. It refuses to start on a non-loopback address, with root or an administrator as the agents' user, without a sound credential digest, without the root token, or with a state file it didn't write.

**Why a bridge.** The local preview runs on a laptop or an orb, and spacesd listens only on the VM's loopback; the VM's public route deliberately serves the viewer and nothing that controls the machine, and a viewer ticket doesn't grant spacesd's processes, MCP or ticket minting. Pim has no existing outbound companion that reaches into that VM: `pim-computer` dials out to a Pim, but Pim on loopback can't be dialled, and running it on the VM would need a public Pim. So the smallest path is a few authenticated POST routes on the HTTPS site the VM already serves, with the raw daemon still private.

## Who has the machine

The bridge keeps who has the machine in its state file, so a bridge restart keeps it: `human` (where it starts, with no file), `agents` under a lease (an epoch number), `draining` or `handoff`. The space keeps its own record (`cua_control`), which starts, and stays across restarts, with the agents paused.

1. **Agents' calls carry their lease.** The bridge runs a call only while the machine is the agents' under that same lease, checked when the call arrives. The space checks too, before any call leaves: every call the agents' tools make here (files, shell, browser, including reads, which can navigate, approved calls that run later, and tasks working in the background) is refused while the agents are paused, however it was asked for or approved.
2. **Pause** stops the agents at once, here and at the bridge: the bridge ends the lease (`draining`), so a call from before the pause that arrives late, after a restart of the space or a network timeout, is refused. What's already under way finishes; a tool with several calls (a long write, an edit) is cut short between calls, leaving at most a `.pim-…` temporary file, never a half-written one. Nothing is killed to make a pause quick.
3. **The pause completes** only when nothing of the agents' runs: no call at the bridge, no `pim-` process in spacesd (its `ListProcesses`), nothing under way in the space, and, after a bridge restart, two minutes for a driver call the restarted bridge lost track of. Only then is the machine `human`. While it waits, the app shows how much is still running; if the bridge or spacesd doesn't answer, it stays waiting.
4. **Commands' background work counts.** Each command runs under a helper that is the subreaper of everything the command starts, detached or not (`&`, `nohup`, `setsid`, double forks), and that stays, tagged in spacesd, until the last of those ends. A pause waits for them; nothing kills them. See the limits below for what isn't the command's descendant.
5. **Open viewer** asks Pim (an authenticated same-origin POST, answered `no-store` and `no-referrer`) for a viewer link, which the bridge makes only while the machine is `human`. The app opens a blank tab, cuts it off from the app (`opener = null`), then replaces its address with the link. The ticket is in the link's fragment, which no server sees and the viewer clears; the app keeps it in no cache, store or address. The viewer is never framed (Cua's viewer forbids it with `frame-ancestors 'none'`). The VM's Caddy asks for its own HTTP Basic login there, which the person enters themselves; Pim never knows it.
6. **The person's input is a media session.** A viewer ticket can't call input, process or window methods; the desktop is reached only through a media session from `StreamService/OpenMedia`, whose socket stays open past its ticket's expiry. Caddy sends every `OpenMedia` to the bridge, which passes it on only while the machine is `human`, with the viewer's own ticket, and records each session it opens before the viewer hears of it. An answer it can't record goes no further, so nobody holds that session's media ticket, and spacesd reaps it at its attach deadline.
7. **Resume** is only by hand, from the signed-in person, naming the complete pause they saw: a pause still completing, a stale page or another person is refused. The bridge first refuses any new `OpenMedia`, then closes every recorded media session (`StreamService/CloseMedia`, which closes its sockets and revokes its ticket), then gives the agents a new lease. If a session won't close, the agents stay paused. The person's still-valid viewer ticket then opens nothing. Closing the viewer tab doesn't resume anything.
8. **Turning it on or off** is only while the agents are paused here and nothing of theirs runs. Approval requests for computer actions that the person hasn't decided yet are denied when the computer changes, so none runs on another computer than the one it was asked for.

All of `/api/cua…` is for the signed-in person in their browser: an API token, another site, or another owner gets 403 or 404, and a space that isn't the allowlisted owner's sees `{ "offered": false }` and nothing else.

## Where the boundary is

- **`exec` is a shell as `PIM_BRIDGE_RUN_AS`.** File calls are confined to `PIM_BRIDGE_ROOT` after following links; commands are not, and can do anything that user can. The bridge refuses root and members of `sudo`, `admin` and `wheel`, but can't read sudoers files: check `sudo -l -U pim-agent` shows nothing. Use a user of its own, not the desktop user, and check it can't reach the desktop session (the display's authority file and the session's D-Bus are the desktop user's). Pim's credential being server-only doesn't make `exec` a sandbox.
- **Background work that isn't a descendant escapes the count.** Work a command hands to another service runs outside its helper: `systemd-run`, `at`, `cron`, D-Bus activation, or a browser already running that a command asks to open a page. A pause can't see or wait for that. With the agents' user apart from the desktop's, such work can't reach the person's desktop; it can still use what that user can.
- **A helper killed from outside** (spacesd stopping, a kill by hand) leaves the command's descendants to init, outside the count.
- **The viewer** sessions the bridge closes are those opened through Caddy since the bridge was installed. Install it with no viewer open and spacesd restarted, so none predates it. A `CloseMedia` only closes the person's media; a ticket they hold can still call the viewer's harmless methods (capabilities, health, targets, presence) until it expires in five minutes.

## Setting it up

None of this has been done; it is the procedure for the VM's operator to review and carry out. Never set these on a deployed Pim.

### The credential

On the machine that runs the Pim preview:

```sh
openssl rand -base64 48 | tr '+/' '-_' | tr -d = > ~/.pim-cua-bridge-credential
chmod 600 ~/.pim-cua-bridge-credential
printf %s "$(cat ~/.pim-cua-bridge-credential)" | sha256sum   # the digest, for the VM
```

Only the digest goes to the VM. The credential stays in the preview's `.dev.vars`, which git ignores, and never reaches the app.

### On the VM (after review)

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin pim-bridge
sudo useradd --create-home --shell /bin/bash pim-agent          # the agents' user: no sudo
sudo -u pim-agent mkdir -p /home/pim-agent/pim
sudo install -d -m 0755 /opt/pim-cua-bridge && sudo install -m 0644 pim_cua_bridge.py /opt/pim-cua-bridge/
sudo install -d -m 0750 -g pim-bridge /etc/pim-cua-bridge
sudo install -m 0640 -g pim-bridge pim-cua-bridge.env.example /etc/pim-cua-bridge/bridge.env   # then edit it
sudo install -m 0644 pim-cua-bridge.service /etc/systemd/system/
# With no viewer open: restart spacesd, so no media session predates the bridge.
sudo systemctl daemon-reload && sudo systemctl enable --now pim-cua-bridge
```

- [`pim-cua-bridge.env.example`](../deploy/cua-eval/pim-cua-bridge.env.example): the listen address (loopback), the credential's digest, the agents' user and their files folder.
- [`pim-cua-bridge.service`](../deploy/cua-eval/pim-cua-bridge.service): the bridge as `pim-bridge`, with `/etc/cua/spacesd.env` handed over as a systemd credential (`LoadCredential`), its state in `/var/lib/pim-cua-bridge`, reaching only localhost.
- [`caddy/`](../deploy/cua-eval/caddy/): import `pim-bridge-routes.caddy` at the top of the site block, and take `/cua.env.v1.StreamService/OpenMedia` out of the viewer's existing RPC allowlist: it is served there. Import `pim-bridge-log-fields.caddy` into a `format filter { fields { … } }` in every log that names requests, the site's access log and the default log, where proxy failures are written with the request. They drop request headers and queries from the logs: Caddy redacts `Authorization` and `Cookie` itself, but not Pim's credential, viewer tickets or `/media?ticket=…`. The bridge never receives the Basic login, cookies, `Forwarded` or `X-Forwarded-*`, `X-Real-IP`, `Origin` or `Referer`. Add `remote_ip` where the preview's address is stable. Then `caddy validate` and reload; a viewer `OpenMedia` answered with the header `X-Pim-Bridge: media/open` shows the route is right.

### On the Pim preview

Sign in to the preview as the test account, read its owner id from `/api/account` (`ownerId`), and put the settings in `.dev.vars`:

```sh
CUA_EVAL_BRIDGE_URL=https://cua-eval.ajac-zero.com
CUA_EVAL_BRIDGE_TOKEN=<the credential>
CUA_EVAL_OWNER=o_…
```

Restart the preview (`pnpm preview`, or its service in an orb). Settings → Computer then shows **Cua evaluation** to that account only; **Use it for my agents** puts it in place of the space's computer with the agents paused, **Resume agents** gives it to them, and **Turn off the evaluation**, while they're paused, gives back the space's own computer. To revoke Pim's access, change the bridge's digest or stop the service on the VM.

## Checks

```sh
pnpm exec vitest run test/cua.test.ts                          # Pim with a stand-in bridge, through the real tool registry
pnpm --filter pim-web exec vitest run src/components/cua-evaluation.test.tsx
python3 -m unittest deploy/cua-eval/test_pim_cua_bridge.py     # the bridge, with a stand-in spacesd running real processes
CADDY=/path/to/caddy python3 -m unittest deploy/cua-eval/test_caddy.py   # the Caddy routes and log filters, in a real Caddy
python deploy/cua-eval/check_protocol.py --cua /path/to/cua    # against Cua's own definitions at the pinned commit
```

`check_protocol.py` compiles cua.env.v1's `.proto` files at commit `fca21937bc4e1420a23d544d11dbdf987f0266e6` with protoc and checks, with the official protobuf library, every message the bridge writes and reads and the golden bytes its tests use; checks the driver tool shapes against cua-driver's published MCP tool schemas for Linux at that commit (`scripts/docs-generators/cli-specs/cua-driver-mcp-linux.json`); and checks the spacesd facts above in its source. It needs `grpcio-tools` and `protobuf`, and reaches nothing. `test_caddy.py` was run with Caddy 2.10.2.

## Limitations

- **No end-to-end run.** The driver's answers (window binding, refs, refusals) and spacesd's behavior come from their source at the pinned commit; how they behave on the real VM is untested.
- **One shared tab.** The Cua browser is one tab that every chat shares, used one at a time. Numbers from `browser_read` last until the next read, screenshot or navigation, so an approved click on an old number reaches nothing. Only `http:` and `https:` pages open.
- **Paused means everything.** Files in the app are refused too while paused, and the browser box shows no picture of the page: the person uses the viewer.
- **Waiting, not stopping.** A command that leaves a server running keeps a pause from completing until it ends; Pim offers no way to stop it. Ask the agent to stop it before pausing, or stop it on the machine.
- **The bridge's lockout** after failed credentials is for everyone, so without `remote_ip` anyone who can reach the site can keep it locked. `grep` patterns are Python regular expressions there, not JavaScript ones.

## Licenses

No Cua code is copied here: the bridge speaks spacesd's and cua-driver's published protocols, and the checks read a Cua checkout without copying it. cua-spacesd is under the Functional Source License (FSL-1.1-MIT), which permits this private, internal, non-commercial evaluation and nothing that competes with it as a product; cua-driver and the rest of the Cua repository are MIT. This prototype accepts no commercial license, and using it beyond an internal evaluation needs that question answered first. Keep Cua's license notices with any copy of its software on the VM.
