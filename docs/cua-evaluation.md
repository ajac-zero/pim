# Cua evaluation (private prototype)

A private, single-owner prototype in which one person's agents use a [Cua](https://github.com/trycua/cua) machine as their computer: files, shell and a browser driven with cua-driver's typed browser tools. The person pauses the agents to use the machine themselves in Cua's viewer, in a tab of its own, and only they resume them.

**It is an evaluation on a review branch, not a feature.** It is off unless a deployment sets all three of its settings, only for the one owner they name, and only once that owner turns it on. Sprites and paired computers are unchanged and stay the default; turning the evaluation off gives the agents back the space's own computer as it was.

**What has run, and against what.** Pim's tests use a stand-in bridge; the bridge's tests a stand-in spacesd; `test_caddy.py` the VM's own Caddyfile, patched, in Caddy 2.11.7. The whole path has run end to end on a disposable stand-in for the VM (`rehearsal/orb-vm.sh`): the reviewed bootstrap's own units and Caddyfile, the pinned Caddy 2.11.7 and cua-spacesd 0.7.0, `install.sh`, the Pim preview's real tools through `e2e.py` (42 checks, including a real media WebSocket closed by a resume), the soft deadline, and `rollback.sh`. That stand-in had no XFCE, audio or Chromium, so **the browser has not run end to end**: there, cua-driver refused with `browser_route_unavailable`, which came back to the agent intact and with nothing internal. **Nothing here has run on the real VM.**

## How it fits together

```
 Pim (local preview only)                              Cua evaluation VM
┌──────────────────────────────┐   HTTPS :443   ┌──────────────────────────────────────────────┐
│ Pim Durable Object           │───────────────▶│ Caddy (cua-viewer-proxy), the VM's Caddyfile │
│  CuaEvaluation (src/cua.ts)  │ 6 POST routes, │  0. /pim-bridge/v1/{6 routes}: Pim's cred.   │
│  CuaBrowser (cua-browser.ts) │ X-Pim-Bridge-  │  1. Basic login · path checks · headers      │
│  CUA_EVAL_BRIDGE_TOKEN       │ Authorization  │  5. Origin  6. ticket → OpenMedia to bridge, │
└──────────────┬───────────────┘                │     10 viewer RPCs + /media to spacesd       │
               │ /api/cua…                      │   │                                          │
               │ (session cookie, same origin)  │ pim-cua-bridge 127.0.0.1:3290 (pim-bridge)   │
┌──────────────┴───────────────┐                │   who has the machine: state.json            │
│ Web app: Settings → Computer │                │   holds spacesd's root token (credential)    │
│  Pause · Open viewer · Resume│   new tab,     │   ├─ gRPC-Web, /mcp ─▶ cua-spacesd :3211 (cua)│
└──────────────────────────────┘   viewer ticket│   └─ unix socket ─▶ runner (pim-agent),      │
                                 ──────────────▶│        pim-agent-exec.service's cgroup       │
                                                └──────────────────────────────────────────────┘
```

- **Pim** reads `CUA_EVAL_BRIDGE_URL`, `CUA_EVAL_BRIDGE_TOKEN` and `CUA_EVAL_OWNER` from the Worker's environment ([`src/cua.ts`](../src/cua.ts)). The address must be `https://` on a fixed allowlist (`CUA_BRIDGE_HOSTS`, only `cua-eval.ajac-zero.com`), an origin with no login, port, path or query; the credential at least 256 bits of base64url; the owner one `o_…` id. Any unsound value leaves the evaluation off and logs which setting is wrong, once, never its value. Pim follows no redirect from the bridge, caps answers at 12 MiB, and scrubs its credential from any error.
- **The space** stands the evaluation in for its computer (`ComputerProvider` in [`src/computer.ts`](../src/computer.ts)), so `shell`, the file tools and Files reach the Cua machine through the same code, the same gated actions and the same per-agent tool permissions as a Sprite or a paired computer. Each file tool runs on the computer it started on (`Computer.pinned`). The browser tools reach a `CuaBrowser` ([`src/cua-browser.ts`](../src/cua-browser.ts)) through the `AgentBrowser` interface, one use at a time, never over DevTools.
- **pim-cua-bridge** ([`deploy/cua-eval/pim_cua_bridge.py`](../deploy/cua-eval/pim_cua_bridge.py), Python's standard library only) runs on the VM as `pim-bridge`, on loopback, behind Caddy, and decides who has the machine. It takes Pim's own credential (only its SHA-256 is on the VM), never the root token or the person's Basic login:
  - `call`: pim-computer's `stat`, `read`, `write`, `mkdir`, `rm`, `rename`, `readdir`, `find`, `grep` and `exec`, handed to **the agents' runner** over `/run/pim-agent-exec.sock`, a socket only `pim-bridge` may open.
  - `driver`: eight cua-driver tools over spacesd's `/mcp`, in fixed shapes (`start_session`, `browser_prepare`, `list_windows`, `get_browser_state`, `browser_navigate`, `browser_click`, `browser_type`, `end_session`), one session and one isolated named profile, both `pim`; only `http:`, `https:` and `about:blank` pages.
  - `pause`, `resume`, `status` and `viewer`: who has the machine, below.
  - `media/open`: the viewer's own `OpenMedia`, which Caddy sends here after the person's own checks, passed to spacesd with the viewer's ticket only.

  It refuses other paths, methods, content types and shapes; bodies over 192 KiB; more than 60 requests in 10 seconds, or 4 calls at once; and everything for a minute after 10 failed credentials. Its errors and logs never carry headers, bodies, queries or upstream answers.
- **The agents' runner** is the same file with `--runner`, in `pim-agent-exec.service` as `pim-agent`, started by `pim-agent-exec.socket`. It runs each call in a helper process of its own. **spacesd can't do this:** the VM runs it as `cua`, and spacesd refuses to start a process as another user unless it is root (`process/mod.rs` at the pinned commit; `check_protocol.py` checks it). Running the agents' commands as `cua` instead would let them read spacesd's root token from `/proc/<pid>/environ`.

**Why a bridge.** The local preview runs on a laptop or an orb, and spacesd listens only on the VM's loopback; the VM's public route serves the viewer and nothing that controls the machine, and a viewer ticket doesn't grant spacesd's processes, MCP or ticket minting. Pim has no outbound companion that reaches into that VM (`pim-computer` dials out to a Pim, which a preview on loopback can't receive). So the smallest path is six authenticated POST routes on the HTTPS site the VM already serves, with the raw daemon still private.

## Who has the machine

The bridge keeps who has the machine in its state file, so a restart keeps it: `human` (where it starts, with no file), `agents` under a lease (an epoch number), `draining` or `handoff`. The space keeps its own record (`cua_control`), which starts, and stays across restarts, with the agents stopped.

1. **Agents' calls carry their lease.** The bridge runs a call only while the machine is the agents' under that same lease, checked when the call arrives. The space checks too, before any call leaves: every call the agents' tools make (files, shell, browser, including reads, which can navigate; approved calls that run later; tasks in the background) is refused while the agents aren't resumed, however it was asked for or approved.
2. **Pause** stops the agents at once, here and at the bridge: the bridge ends the lease (`draining`), so a call from before the pause that arrives late, after a restart or a network timeout, is refused. What's already under way finishes; a tool with several calls (a long write) is cut short between calls. Nothing is killed to make a pause quick.
3. **A pause always wins over a resume.** Each pause starts a new generation at once, before it waits its turn. A resume asked for before it (waiting its turn, or waiting for the bridge's answer) is refused, never hands the machine to the agents here, and the pause then takes the machine back from the bridge, which may have given the agents a lease meanwhile that nothing here uses.
4. **The pause completes** only when nothing of the agents' runs: no call at the bridge; nothing but the runner itself in the runner's cgroup, which the bridge reads itself as well as asking the runner; nothing under way in the space. Only then is the machine `human`. If the bridge or the runner doesn't answer, it stays waiting. A browser call has no such proof: the bridge can't see or cancel what cua-driver does with a call whose answer it never got. So a driver call that ends without spacesd's answer (a timeout or a dropped connection), or a bridge restart while one was under way, leaves the machine **unsettled** (`"unsettled": true` in the bridge's status): the pause never completes and no viewer opens, however long anyone waits, until an operator recovers it (below).
5. **Commands' background work counts.** Everything a command starts, detached or not (`&`, `nohup`, `setsid`, double forks), stays in the runner's cgroup; a pause waits for it, and nothing kills it.
6. **Open viewer** asks Pim (an authenticated same-origin POST, answered `no-store` and `no-referrer`) for a viewer link, which the bridge makes only while the machine is `human`, and which Pim hands out only if no pause or resume came in while it was made. The app opens a blank tab, cuts it off from the app (`opener = null`), then sets its address to the link. The ticket is in the fragment, which no server sees; the app keeps it nowhere. The viewer is never framed (`frame-ancestors 'none'`). The VM asks for its own Basic login there, which the person enters themselves; Pim never knows it.
7. **The person's input is a media session.** A viewer ticket can't call input, process or window methods; the desktop is reached only through a media session from `StreamService/OpenMedia`, whose socket stays open past its ticket's expiry. Caddy sends every `OpenMedia` to the bridge, after the Basic login, the Origin check and the ticket check; the bridge passes it on only while the machine is `human` and records each session it opens before the viewer hears of it.
8. **Resume** is only by hand, from the signed-in person, naming the complete pause they saw. The bridge refuses any new `OpenMedia`, closes every recorded media session (`StreamService/CloseMedia`, which closes its socket and revokes its ticket), then gives the agents a new lease; if a session won't close, the agents stay paused. Closing the viewer tab resumes nothing.
9. **Turning it on or off** is only while the agents are paused, nothing of theirs runs and no resume is under way; each ends the generation the person saw. Turning it on starts with the agents stopped (`pausing`) until the bridge says the machine is the person's, so a lease the bridge still holds keeps the viewer closed. Approval requests for computer actions the person hasn't decided are denied when the computer changes.

All of `/api/cua…` is for the signed-in person in their browser: an API token, another site, or another owner gets 403 or 404, and a space that isn't the allowlisted owner's sees `{ "offered": false }`.

## Where the boundary is

- **`exec` is a shell as `pim-agent`, not a sandbox.** File calls are confined to `/home/pim-agent/pim` by walking each path from a descriptor of it with `O_NOFOLLOW`, refusing any symbolic link (a link inside is listed, moved and deleted, never read, written or entered), so a link swapped in mid-call fails the call; hard links and commands are not confined beyond what `pim-agent` may reach. What the unit confines (checked on the stand-in): commands run as `pim-agent`, in no administrator group, with sudo refused (`NoNewPrivileges`, and `install.sh` checks `sudo -l -U pim-agent`); they can write only `/home/pim-agent` and a private `/tmp`; they see no other home; and they reach no loopback service (spacesd, the bridge, Caddy), no link-local address (Azure's metadata service) and not `168.63.129.16`, only the DNS stub and the network beyond. They have neither the desktop's X authority nor its session bus, so they can't touch the person's desktop. They can still read what any unprivileged user can, use the network, and use 4 GiB and 512 tasks.
- **The runner shares a user with the commands.** They could kill it (systemd then stops the whole unit, commands included) or, where Yama's `ptrace_scope` is 0, tamper with it; that is why the bridge counts the cgroup itself. The runner holds no secret.
- **Pim's credential being server-only doesn't make `exec` safe.** Treat what the agents run there as untrusted.
- **The desktop user `cua`** has no sudo (the operator checked; `install.sh` reports it). The browser the driver drives runs as `cua`, in its isolated `pim` profile.
- **Viewer sessions** the bridge closes are those opened since it was installed; `install.sh` restarts spacesd so none predates it. A ticket the person still holds can call the viewer's harmless methods (capabilities, health, targets, presence) until it expires in five minutes, and opens no media while the agents have the machine.

## Installing on the VM

None of this has been done; it is the procedure for the VM's operator, after review, through Azure RunCommand only. It needs the VM bootstrapped at Sandbox commit `90ea971` (`install.sh` refuses any other Caddyfile or `deadline-check.sh`, by SHA-256) and before its soft deadline.

1. **The credential**, on the machine that runs the Pim preview:

   ```sh
   openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' > ~/.pim-cua-bridge-credential
   chmod 600 ~/.pim-cua-bridge-credential
   printf %s "$(cat ~/.pim-cua-bridge-credential)" | sha256sum | cut -d' ' -f1    # the digest
   ```

   Only the digest goes to the VM. The credential goes in the preview's `.dev.vars`, which git ignores.
2. **The files.** From the reviewed commit: `python3 deploy/cua-eval/make_bundle.py script > pim-cua-bridge-bundle.sh` (about 45 KB; the same files make the same script). Run it with RunCommand. It unpacks into `/root/pim-cua-bridge-<first 12 of SHA256SUMS' SHA-256>`, checks every file against `SHA256SUMS`, and runs nothing else. Compare the SHA-256 it prints with `sha256sum deploy/cua-eval/SHA256SUMS` locally.
3. **The digest**, with RunCommand: `install -m 0600 /dev/null /root/pim-bridge.sha256 && echo <digest> > /root/pim-bridge.sha256`.
4. **Check, changing nothing:** `/root/pim-cua-bridge-…/install.sh --digest-file /root/pim-bridge.sha256 --check`.
5. **Install**, with no viewer open: `/root/pim-cua-bridge-…/install.sh --digest-file /root/pim-bridge.sha256`. It makes `pim-bridge` and `pim-agent`; copies the bridge to `/opt/pim-cua-bridge`, `bridge.env` (the digest, `root:pim-bridge 0640`) to `/etc/pim-cua-bridge`, and the three units; validates the patched Caddyfile with the real Basic credential in its environment, never printed (its output, if it fails, goes to a root-only file); keeps the originals in `/var/backups/pim-cua-bridge`; then stops the viewer route, puts the patched Caddyfile and `deadline-check.sh` in place, restarts cua-spacesd briefly, starts the runner's socket and the bridge, starts the viewer route, and checks from the VM that the routes answer as reviewed. The desktop and audio stay up. A failure while switching over runs `rollback.sh`.
6. **On the Pim preview**, run `python3 deploy/cua-eval/e2e.py owner` for the test account's owner id, then put in `.dev.vars`:

   ```sh
   CUA_EVAL_BRIDGE_URL=https://cua-eval.ajac-zero.com
   CUA_EVAL_BRIDGE_TOKEN=<the credential>
   CUA_EVAL_OWNER=o_…
   PIM_LIMIT_DAILY_TOKENS=100000000   # the stand-in model counts tokens; one e2e run uses a large share of the default
   ```

   Restart the preview (`pnpm preview`, or its service in an orb; a running preview doesn't reload `.dev.vars`).
7. **Acceptance test:** host `python3 deploy/cua-eval/e2e.py fixture` (a page with a button, a link and a text field) where the VM's browser reaches it, then `python3 deploy/cua-eval/e2e.py run --browser-url <its URL> --viewer-basic <file holding user:password of the viewer login>`. It prints PASS, FAIL or SKIP per check and never a secret, leaves the evaluation off for the test account, and ends `ACCEPTED` (exit 0) only when every required check listed in `e2e.py` ran and passed; a skipped or missing one makes it `INCOMPLETE` (exit 1). `--partial` runs without the fixture or the viewer login for diagnostics and ends `INCOMPLETE` (exit 2) whenever anything was skipped. Settings → Computer then shows **Cua evaluation** to that account only.

**What changes in the VM's Caddyfile** ([`vm_patch.py`](../deploy/cua-eval/vm_patch.py), exact anchors, fixed result `b7d16aa7…`): the site's `route` first imports [`pim-bridge-machine.caddy`](../deploy/cua-eval/caddy/pim-bridge-machine.caddy), the six machine routes, matched on the exact raw request URI (no query, no encoding), POST only, with a well-formed `X-Pim-Bridge-Authorization` or 401, ≤ 192 KiB; anything else under `/pim-bridge/` goes on to the Basic login and the site's 404. `OpenMedia` leaves `@viewer_rpc`'s list (now 10 paths), and [`pim-bridge-media.caddy`](../deploy/cua-eval/caddy/pim-bridge-media.caddy), just before `handle @viewer_rpc`, sends it to the bridge after the Basic login, the path check, the response headers, the Origin check and the ticket check, with no query, ≤ 64 KiB. Neither route passes on the Basic login, cookies, `Forwarded`, `X-Forwarded-*`, `X-Real-IP` and the like, `Origin`, `Referer` or spacesd's relay headers ([`pim-bridge-strip.caddy`](../deploy/cua-eval/caddy/pim-bridge-strip.caddy)), and their answers get no CORS headers. The CSP, the global log filter (`request delete`, which keeps Pim's credential, tickets and queries out of error logs) and everything else stay as they are.

**The soft deadline.** `deadline-check.sh` stops `pim-cua-bridge` and `pim-agent-exec` right after the public proxy and before spacesd, then the runner's socket; every new unit has `ConditionPathExists=!/var/lib/cua-evaluation/expired`, so none starts again, even by hand.

**Rollback:** `/root/pim-cua-bridge-…/rollback.sh`. It stops the viewer route, stops the bridge and the runner (and with it whatever the agents' commands left running) and checks that their units are inactive, their cgroups empty, and nothing listens on port 3290 or the runner's socket; restores the Caddyfile and `deadline-check.sh` byte for byte (from the backups, checked against the reviewed SHA-256 before and after) and has `caddy validate` accept the Caddyfile; removes the units, `/opt/pim-cua-bridge` and `/etc/pim-cua-bridge`; restarts cua-spacesd briefly so no media session of the bridge's time survives; and only then starts the viewer route. If any check fails it keeps the viewer route down, the backups in place (and the bridge's units and code, if something of it may still run), leaves the deadline timer alone, and exits 1; run it again once the cause is fixed.

**After an unsettled restart** (the bridge's status says `"unsettled": true`), the machine stays the agents' until this is done by hand, as root: `systemctl stop pim-cua-bridge`; `systemctl restart cua-spacesd` (which ends cua-driver's session and its browser actions, and every viewer session); check that no browser process of the driver's session still runs (`ps -u cua -o pid,args | grep -i chrom`); `rm /var/lib/pim-cua-bridge/state.json`; `systemctl start pim-cua-bridge`. The bridge then starts with the machine the person's. Nothing automates this, and the bridge doesn't check the operator's work. It keeps the users, `/home/pim-agent`, `/var/lib/pim-cua-bridge` and the backups (moved aside); the comment at its top says how to remove those. To revoke Pim's access without that, stop `pim-cua-bridge`.

## Rehearsing on a disposable machine

On an Amp orb, never the VM: `PIM_REHEARSAL_DISPOSABLE=1 sudo -E deploy/cua-eval/rehearsal/orb-vm.sh up <Sandbox checkout at 90ea971>/cua-evaluation`. It lays out the bootstrap's own units, scripts and Caddyfile with the pinned Caddy and cua-spacesd, synthetic secrets (the viewer password is written, never printed, to `~/.pim-rehearsal/viewer-basic`), `tls internal` with its root trusted, and `cua-eval.ajac-zero.com` resolving to 127.0.0.1 there, with the real VM's address blackholed. Then steps 2–7 above with `sudo`, and `orb-vm.sh down`.

## Checks

```sh
pnpm exec vitest run test/cua.test.ts                          # Pim with a stand-in bridge, through the real tool registry
pnpm --filter pim-web exec vitest run src/components/cua-evaluation.test.tsx
python3 -m unittest deploy/cua-eval/test_pim_cua_bridge.py     # the bridge and its runner, with a stand-in spacesd
python3 -m unittest deploy/cua-eval/test_packaging.py          # SHA256SUMS, the two patches, the deadline order
CADDY=/path/to/caddy-2.11.7 python3 -m unittest deploy/cua-eval/test_caddy.py   # the VM's patched Caddyfile in a real Caddy
python deploy/cua-eval/check_protocol.py --cua /path/to/cua    # against Cua's own definitions at the pinned commit
```

`check_protocol.py` compiles cua.env.v1's `.proto` files at commit `fca21937bc4e1420a23d544d11dbdf987f0266e6` with protoc and checks, with the official protobuf library, every message the bridge writes and reads and the golden bytes its tests use; checks the driver tool shapes against cua-driver's published MCP tool schemas for Linux at that commit; and checks the spacesd facts above in its source. It needs `grpcio-tools` and `protobuf`, and reaches nothing.

## Limitations

- **The browser is unproven end to end** (above), and so is everything on the real VM: its desktop, Chromium, and its network.
- **One shared tab.** The Cua browser is one tab that every chat shares, used one at a time. Numbers from `browser_read` last until the next read, screenshot or navigation, so an approved click on an old number reaches nothing.
- **Paused means everything.** Files in the app are refused too while paused, and the browser box shows no picture of the page: the person uses the viewer.
- **Waiting, not stopping.** A command that leaves a server running keeps a pause from completing until it ends; Pim offers no way to stop it. Ask the agent to stop it before pausing, or `systemctl restart pim-agent-exec.service` on the VM, which ends all of the agents' processes.
- **The bridge's lockout** after failed credentials is for everyone, so anyone who can reach the site can keep it locked. `grep` patterns are Python regular expressions there, not JavaScript ones.

## Licenses

No Cua code is copied here: the bridge speaks spacesd's and cua-driver's published protocols, and the checks and the rehearsal read or download Cua's own releases without copying them. cua-spacesd is under the Functional Source License (FSL-1.1-MIT), which permits this private, internal, non-commercial evaluation and nothing that competes with it as a product; cua-driver and the rest of the Cua repository are MIT. This prototype accepts no commercial license. Keep Cua's license notices with any copy of its software.
