# Cua evaluation (private prototype)

A private, single-owner prototype in which one person's agents use a [Cua](https://github.com/trycua/cua) machine as their computer: its files, its shell and its browser, driven with cua-driver's typed browser tools. The person pauses their agents to use the machine themselves in Cua's viewer, in a tab of its own, and only they resume them.

**It is an evaluation on a review branch, not a feature.** It is off unless a deployment sets all three of its settings, only for the one owner they name, and only once that owner turns it on. It has been run only against a stand-in bridge in Pim's tests and the bridge's own tests, with synthetic fixtures; **nothing here has been run against a real Cua machine**. Sprites and paired computers are unchanged and stay the default; turning the evaluation off gives the agents back the space's own computer as it was.

## How it fits together

```
 Pim (local preview only)                              Cua evaluation VM
┌──────────────────────────────┐   HTTPS :443   ┌──────────────────────────────────────────────┐
│ Pim Durable Object           │───────────────▶│ Caddy, cua-eval.ajac-zero.com                │
│  CuaEvaluation (src/cua.ts)  │ 4 POST paths,  │  /viewer…  HTTP Basic, viewer allowlist      │
│  CuaBrowser (cua-browser.ts) │ X-Pim-Bridge-  │  /pim-bridge/v1/{status,call,driver,viewer}  │
│  CUA_EVAL_BRIDGE_TOKEN       │ Authorization  │   │ no Basic; body ≤ 192 KiB                 │
└──────────────┬───────────────┘                │   ▼                                          │
               │ /api/cua…                      │ pim-cua-bridge 127.0.0.1:3290 (pim-bridge)   │
               │ (session cookie, same origin)  │   holds spacesd's root token (credential)    │
┌──────────────┴───────────────┐                │   │ gRPC-Web, /mcp                           │
│ Web app: Settings → Computer │                │   ▼                                          │
│  Pause · Open viewer · Resume│   new tab,     │ cua-spacesd 127.0.0.1:3211 (private)         │
└──────────────────────────────┘   viewer ticket│   processes as the desktop user, cua-driver  │
                                 ──────────────▶│   viewer (/viewer/#ticket=…, 5 minutes)      │
                                                └──────────────────────────────────────────────┘
```

- **Pim** reads `CUA_EVAL_BRIDGE_URL`, `CUA_EVAL_BRIDGE_TOKEN` and `CUA_EVAL_OWNER` from the Worker's environment ([`src/cua.ts`](../src/cua.ts)). The address must be `https://` on a fixed allowlist (`CUA_BRIDGE_HOSTS`, only `cua-eval.ajac-zero.com`), an origin with no login, port, path or query; the credential at least 256 bits of base64url; the owner one `o_…` id. Any unsound value leaves the evaluation off and logs which setting is wrong, never its value. Pim follows no redirect from the bridge, caps answers at 12 MiB, and scrubs its credential from any error.
- **The space** stands the evaluation in for its computer (`ComputerProvider` in [`src/computer.ts`](../src/computer.ts)), so `shell`, the file tools and Files reach the Cua machine through the same code, the same gated actions and the same per-agent tool permissions as a Sprite or a paired computer. The browser tools reach a `CuaBrowser` ([`src/cua-browser.ts`](../src/cua-browser.ts)) instead of `PimBrowser`, through the `AgentBrowser` interface: nothing goes over DevTools.
- **pim-cua-bridge** ([`deploy/cua-eval/pim_cua_bridge.py`](../deploy/cua-eval/pim_cua_bridge.py), Python's standard library only) runs on the VM, on loopback, behind Caddy. It takes Pim's own credential, never the root token or the human's Basic login, and makes only these calls to the one spacesd at 127.0.0.1:3211:
  - `status`: whether spacesd answers, and how many agent calls are under way.
  - `call`: pim-computer's `stat`, `read`, `write`, `mkdir`, `rm`, `rename`, `readdir`, `find`, `grep` and `exec`, each one process that spacesd starts as the desktop user (`PIM_BRIDGE_RUN_AS`, never root), confined to `PIM_BRIDGE_ROOT` after following links. Commands run there with `bash -lc`.
  - `driver`: eight cua-driver tools in fixed shapes (`start_session`, `browser_prepare`, `list_windows`, `get_browser_state`, `browser_navigate`, `browser_click`, `browser_type`, `end_session`), one session and one isolated named profile, both `pim`, never an existing browser profile.
  - `viewer`: a five-minute viewer ticket (`SystemService.CreateViewerTicket`, activation allowed, no clipboard or files), refused while any agent call is under way.

  It refuses other paths, methods, content types and shapes; bodies over 192 KiB; more than 60 requests in 10 seconds, or 4 calls at once; and everything for a minute after 10 failed credentials. Its errors and logs never carry headers, bodies or upstream answers. It refuses to start on a non-loopback address, with root as the desktop user, without a sound credential digest, or without the root token.

**Why a bridge.** The local preview runs on a laptop or an orb, and spacesd listens only on the VM's loopback; the VM's public route deliberately serves the viewer and nothing that controls the machine, and a viewer ticket doesn't grant spacesd's processes, MCP or ticket minting. Pim has no existing outbound companion that reaches into that VM: `pim-computer` dials out to a Pim, but Pim on loopback can't be dialled, and running it on the VM would need a public Pim. So the smallest path is four authenticated POST routes on the HTTPS site the VM already serves, with the raw daemon still private.

## Pausing, the viewer and resuming

The space keeps who may use the machine in its storage (`cua_control`: `agents`, `pausing` or `paused`, and a generation number), so it survives a restart and fails closed.

1. **Pause** (Settings → Computer, or the browser box beside a chat) stops new agent calls at once: every call the agents' tools make here (files, shell, browser, including reads, which can navigate, approved calls that run later, and tasks working in the background) is checked when it would run, and refused while the mode isn't `agents`. An approval granted before or during a pause doesn't get past this check. A tool's calls count as one piece of work (`CuaEvaluation.hold`), so a pause never cuts a multi-part write in two.
2. The pause is `pausing` until nothing is under way, in the space or on the bridge; then it is `paused`. Nothing is killed to make it so. If the bridge doesn't answer, the pause stays `pausing`, with the reason shown, and the agents stay stopped. A restarted space asks the bridge what it still has under way.
3. **Open viewer** asks Pim (an authenticated same-origin POST, answered `no-store` and `no-referrer`) for a viewer link, made only while `paused`, and checked again after it's made. The app opens a blank tab, cuts it off from the app (`opener = null`), then replaces its address with the link. The ticket is in the link's fragment, which no server sees and the viewer clears; the app keeps it in no cache, store or address. The viewer is never framed: Cua's viewer forbids it (`frame-ancestors 'none'`), and Pim's own headers stay as they were. The VM's Caddy still asks for its HTTP Basic login there, which the person enters themselves; Pim never knows it.
4. **Resume** is only by hand, from the signed-in person, naming the pause they saw: a stale page, or one that saw an older pause, is refused. Closing the viewer doesn't resume anything.

All of `/api/cua…` is for the signed-in person in their browser: an API token, another site, or another owner gets 403 or 404, and a space that isn't the allowlisted owner's sees `{ "offered": false }` and nothing else.

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
sudo install -d -m 0755 /opt/pim-cua-bridge && sudo install -m 0644 pim_cua_bridge.py /opt/pim-cua-bridge/
sudo install -d -m 0750 -g pim-bridge /etc/pim-cua-bridge
sudo install -m 0640 -g pim-bridge pim-cua-bridge.env.example /etc/pim-cua-bridge/bridge.env   # then edit it
sudo -u <desktop user> mkdir -p /home/<desktop user>/pim
sudo install -m 0644 pim-cua-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pim-cua-bridge
```

- [`pim-cua-bridge.env.example`](../deploy/cua-eval/pim-cua-bridge.env.example): the listen address (loopback), the credential's digest, the desktop user and the files folder.
- [`pim-cua-bridge.service`](../deploy/cua-eval/pim-cua-bridge.service): the bridge as `pim-bridge`, with `/etc/cua/spacesd.env` handed over as a systemd credential (`LoadCredential`), which only this service reads; spacesd's file stays root's. It may reach only localhost.
- [`Caddyfile.pim-bridge`](../deploy/cua-eval/Caddyfile.pim-bridge): the four POST paths, above the site's other `handle` blocks, without Basic, with a 192 KiB body limit and an optional `remote_ip`; any other `/pim-bridge/` path is a 404. Keep the credential header out of access logs as it shows. Then `caddy validate` and reload.

### On the Pim preview

Sign in to the preview as the test account, read its owner id from `/api/account` (`ownerId`), and put the settings in `.dev.vars`:

```sh
CUA_EVAL_BRIDGE_URL=https://cua-eval.ajac-zero.com
CUA_EVAL_BRIDGE_TOKEN=<the credential>
CUA_EVAL_OWNER=o_…
```

Restart the preview (`pnpm preview`, or its service in an orb). Settings → Computer then shows **Cua evaluation** to that account only; **Turn on** puts it in place of the space's computer, and **Turn off** gives that back. To revoke Pim's access, remove the bridge's digest (or stop the service) on the VM; to revoke a viewer ticket before its five minutes are up, rotate spacesd's root token.

## Checks

```sh
pnpm exec vitest run test/cua.test.ts                    # Pim with a stand-in bridge, through the real tool registry
pnpm --filter pim-web exec vitest run src/components/cua-evaluation.test.tsx
python3 -m unittest deploy/cua-eval/test_pim_cua_bridge.py   # the bridge, with a fake spacesd
```

The bridge's protobuf messages were checked against the schema at the pinned commit with the official protobuf library; its tests keep those bytes as golden values.

## Limitations

- **One shared tab.** The Cua browser is one tab that every chat shares, where Pim's own browser gives each chat a window. Numbers from `browser_read` last until the next read, screenshot or navigation; a screenshot reads the page again. Only `http:` and `https:` pages open.
- **Paused means everything.** Files in the app are refused too while paused, and the browser box shows no picture of the page: the person uses the viewer. `browser_screenshot` reads the driver's screenshot of the window.
- **What a pause can't stop.** A command an agent started in the background (`nohup`, `&`) keeps running through a pause; the pause waits only for the calls Pim made. Resuming can't take back a viewer ticket already given; it expires after five minutes, or with a new root token.
- **The bridge's lockout** after failed credentials is for everyone, so without `remote_ip` anyone who can reach the site can keep it locked. `grep` patterns are Python regular expressions there, not JavaScript ones.
- **No end-to-end run.** The driver's tool shapes and answers come from cua-driver 0.38.0's source at commit `fca21937bc4e1420a23d544d11dbdf987f0266e6`; whether its window binding and refs behave on the real VM as the stand-in does is untested.

## Licenses

No Cua code is copied here: the bridge speaks spacesd's and cua-driver's published protocols. cua-spacesd is under the Functional Source License (FSL-1.1-MIT), which permits this private, internal, non-commercial evaluation and nothing that competes with it as a product; cua-driver and the rest of the Cua repository are MIT. This prototype accepts no commercial license, and using it beyond an internal evaluation needs that question answered first. Keep Cua's license notices with any copy of its software on the VM.
