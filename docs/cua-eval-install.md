# Installing a Cua evaluation's bridge on a new VM

`computer/cua-host/eval-install/` installs a Cua bridge's two programs (`bridge.ts` and `desktop.ts`, `docs/cua-bridge.md`) on one new, disposable Ubuntu 24.04 VM, for one evaluation against the local preview. It is evaluation tooling: nothing in Pim imports it, and it changes no Worker code or setting. It is the layer between a separately reviewed base image and the credential channel (`docs/cua-eval-credentials.md`): it doesn't build the image, create the VM, deliver files to it, issue a certificate, or open the network. **Nothing here has run on a VM.** Its tests run the planner over synthetic VMs and the rest against stand-ins (see "Tests").

```
 base image (separately reviewed)            this installer (root, once)                      seal (as pim-bridge)
 Ubuntu 24.04, systemd, desktop session  ──▶ pim-bridge account, pim-session group          ──▶ /etc/pim-bridge/token
 pim-desktop account, Node, browser          /etc/pim-bridge/{cert,key}.pem   (bridge, 0600)
 staged: bundle, TLS cert and key            /etc/pim-eval/eval-key.pub.pem   (root, 0644)        start
                                             /srv/pim-workspace               (desktop, 0700)  ──▶ pim-cua-desktop.service (pim-desktop)
                                             /run/pim-session  (tmpfiles.d: desktop, 2750)        pim-cua-bridge.service  (pim-bridge, :8443)
                                             two services, enabled, not started
```

The space's agents all run as the one `pim-desktop` account, as `docs/cua-bridge.md` describes. The workspace is where their files are kept, not a sandbox, and nothing here isolates agents from each other or confines either account.

## What it is made of

- **`config.ts`**: the fixed accounts (`pim-desktop`, `pim-bridge`, `pim-session`), paths, tools and service names, and the one configuration, checked strictly (below); the tmpfiles.d entry and the two unit files are rendered from it.
- **`install.ts`**: runs on the VM, as root, from the verified bundle, with the configuration on standard input: `plan`, `install`, `start`, `status`. Its planner is a pure function of the configuration and the VM's facts (`plan(config, facts)`), read once before anything changes.
- **`operator.ts`**: runs on the operator's machine: `bundle` makes the bundle and prints its digest; `digest` prints a directory's; `render` writes the management scripts.

## The trust root

The operator pins, in the configuration, the **bundle's tree digest**, the **Node binary's SHA-256** and exact version, and the **browser binary's SHA-256**. Every management script checks the Node binary and the whole bundle against those pins before it runs anything from them, and the installer checks the browser. Nothing inside the bundle vouches for itself: its `BUNDLE` file names the commit, and the installer refuses a bundle whose commit isn't the configured one, but that only catches a mix-up; the pinned digest is what is trusted.

The tree digest is the SHA-256 of one line per entry of the bundle directory, sorted bytewise by relative path: `d <mode> <path>` for a directory, `f <mode> <sha256> <path>` for a regular file, the mode in octal as `stat -c %a` prints it. Links, any other kind of entry, and names outside `[A-Za-z0-9._@-]` are refused. `operator.ts` computes it in Node and the scripts in bash (GNU `find`, `sort`, `stat`, `sha256sum`); a test checks the two agree. The scripts also refuse a bundle with anything not root's, writable by group or others, with a setuid, setgid or sticky bit, or not a regular file or directory, and any directory above it, or above the Node binary, that isn't root's or is writable by others or a link.

## Making the bundle

On the operator's machine, from a checkout that has the commit (the files are read from git's objects with `git show <commit>:<path>`, never from the working tree):

```sh
npm pack ws@8.22.0                        # or any copy of that tarball; it is checked, not trusted
node computer/cua-host/eval-install/operator.ts bundle --commit <40-hex sha> \
  --ws-tarball "$PWD/ws-8.22.0.tgz" --out /abs/path/to/new/pim-cua-bundle
# {"event":"pim-cua-eval.bundled","commit":"…","sha256":"<tree digest>"}
```

It holds the root `package.json` (for `"type": "module"`), `computer/pim-computer.ts`, `computer/cua-bridge.ts`, and `computer/cua-host/`'s `package.json`, `bridge.ts`, `desktop.ts`, `session.ts`, `host.ts`, `eval-credentials.ts`, `eval-install/config.ts` and `eval-install/install.ts`; `ws` in `computer/cua-host/node_modules/ws/`; and `BUNDLE`. `ws`'s version comes from `computer/cua-host/package.json` at the commit, and the tarball must have exactly the SHA-512 that the commit's `pnpm-lock.yaml` pins (`sha512-Ydggc987…`); then only its regular files and directories under `package/` are taken (no links, devices, PAX or GNU headers, `..`, absolute or odd names, duplicates, a file that is also a directory, bad checksums), and its `package.json` must say `ws` and that version. Nothing is fetched and no package manager runs. Files are written `0644` and directories `0755`, into a directory that must not exist. Node runs the `.ts` files directly (type stripping), so there is no build step.

`node operator.ts digest --dir <dir>` prints the digest of a copy, such as one staged for delivery.

## The configuration

One JSON object with exactly these fields; anything else, missing or extra, is refused with a fixed reason (`config-<field>`). Paths are absolute and normalized, of letters, digits, `.`, `_` and `-` only, so they need no quoting in a unit file or a script. None of it is secret.

```json
{
  "version": 1,
  "evaluation": "cua-eval-20261027",
  "owner": "o_…",
  "commit": "<40-hex sha of the bundle's commit>",
  "bundle": { "dir": "/opt/pim-cua/bundle", "sha256": "<tree digest from operator.ts bundle>" },
  "node": { "path": "/opt/pim-node/bin/node", "sha256": "<sha256 of that binary>", "version": "v22.18.0" },
  "browser": { "path": "/opt/google/chrome/chrome", "sha256": "<sha256 of that binary>" },
  "workspace": "/srv/pim-workspace",
  "tls": { "cert": "/var/lib/pim-cua-install/cert.pem", "key": "/var/lib/pim-cua-install/key.pem" },
  "evalKey": { "fingerprint": "<from eval-credentials.ts keygen>", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…" },
  "bridge": { "host": "0.0.0.0", "port": 8443, "path": "/pim" },
  "desktop": { "headful": true, "display": ":0", "xauthority": null }
}
```

- `evaluation` and `owner` are as `eval-credentials.ts` takes them; the public key must be RSA-3072 with exponent 65537 and have the pinned fingerprint, as `seal` will require.
- `node.version` is the exact `process.version` of the pinned binary, 22.18.0 or later; `node.path` and `browser.path` are canonical (no links), since the desktop endpoint requires that.
- `bridge.port` is 1024 to 65535: the bridge runs unprivileged, with no `setcap` and no proxy. `bridge.host` is an IP literal. `bridge.path` is the relay's path, as Pim's `CUA_BRIDGES` URL will name it.
- `desktop.headful` with `display` (`:N`) and, optionally, `xauthority`: the browser shows its window on the persistent session's display. Headless takes neither.
- `workspace` is under `/srv`, so it can't be where a system program reads configuration (such as a unit's drop-in directory), and not in the desktop's home.
- The TLS files sit side by side in one staging directory. The bundle, workspace, staging directory, Node and browser may not overlap each other or anything the installer makes.

## The management scripts

```sh
node computer/cua-host/eval-install/operator.ts render --config "$STATE/$EVAL/install.json" --out "$STATE/$EVAL/scripts"
```

writes `plan.sh`, `install.sh`, `seal.sh`, `start.sh`, `status.sh` and `cloud-config.yaml` into a new directory. Each script is bash, sets `-euo pipefail` and a fixed `PATH`, holds only the configuration's values (each checked to need no quoting), refuses to run but as root, and checks the pins as above before it `exec`s exactly one command:

- `plan.sh`, `install.sh`, `start.sh`, `status.sh`: `"$NODE" "$BUNDLE/computer/cua-host/eval-install/install.ts" <command>`, with the configuration as JSON in a quoted here-document, so nothing in it is expanded.
- `seal.sh`: `runuser -u pim-bridge -- "$NODE" "$BUNDLE/computer/cua-host/eval-credentials.ts" seal --evaluation … --owner … --public-key /etc/pim-eval/eval-key.pub.pem --fingerprint … --token-file /etc/pim-bridge/token </dev/null`. Before the `exec`, nothing writes to standard output (failures go to standard error), so its standard output is `seal`'s alone: the envelope, one line of ciphertext.

They never use `set -x`, read a token or key, print a file, take anything from the request that runs them, or call the cloud. `cloud-config.yaml` is cloud-init user data (JSON after `#cloud-config`, which is YAML) that only writes the same five scripts to `/usr/local/sbin/pim-cua-eval-<name>` (root's, `0700`) and runs none of them; whether to use it, or send each script with Run Command, is the delivery stage's choice.

## Before installing: what the VM must already have

The separately reviewed base image or bootstrap provides these; the installer checks what it can and refuses, with a fixed reason, when one is missing. It installs no package and starts no desktop.

| Prerequisite | Checked by |
| --- | --- |
| Ubuntu 24.04 (`/etc/os-release`), booted with systemd | `plan` (`os`, `systemd`) |
| `groupadd`, `useradd`, `runuser`, `nologin` in `/usr/sbin`; `systemctl`, `systemd-tmpfiles`, `find`, `head` in `/usr/bin`: root's, writable by no one else, in root's directories | `plan` (`tools`) |
| Yama's `ptrace_scope` at 1 or more, as `docs/cua-bridge.md` assumes of the OS | `plan` (`ptrace-scope`) |
| The pinned Node binary at `node.path`, root's, runnable by every account, with the pinned SHA-256 and version | the scripts (`node-path`, `node-digest`), `plan` (`node-path`, `node-version`) |
| The bundle at `bundle.dir`, root's throughout, with the pinned digest and the configured commit | the scripts (`bundle-path`, `bundle-ownership`, `bundle-digest`), `plan` (`bundle`, `bundle-commit`) |
| The browser at `browser.path`, root's, runnable by every account, with the pinned SHA-256 | `plan` (`browser`, `browser-digest`) |
| Every directory above Node and the browser, the bundle directory and those above it, and those above the workspace, passable by every account, so both services' accounts reach them | `plan` (`unreachable`) |
| The `pim-desktop` account: UID 1000 to 59999 and its own, primary group `pim-desktop` used by no other account, **in no other group** (so not `sudo`, `adm`, `docker`, `lxd` or the bridge's), named in no sudoers file, with a home it owns that no one else can write | `plan` (`desktop-account-missing`, `desktop-account`, `desktop-group`, `desktop-groups`, `sudoers`, `desktop-home`) |
| Nothing of the installer's: no `pim-bridge` or `pim-session` account or group, and nothing at `/etc/pim-bridge`, `/etc/pim-eval`, `/run/pim-session`, the tmpfiles.d entry, either unit or its drop-in directory, or the workspace; their parent directories root's and writable by no one else | `plan` (`preexisting-account`, `preexisting-path`, `unsafe-parent`) |
| The TLS certificate and key staged at `tls.cert` and `tls.key`, root's (the key `0600`), in a root `0700` directory; the key the certificate's, the certificate valid now | `plan` (`tls-staging`), `install` (`tls`) |
| The persistent desktop session of `pim-desktop` on `desktop.display`: its X socket (`/tmp/.X11-unix/X<N>`) and `/run/user/<uid>` | `start` (`display-missing`) and `status`, for a headful browser |
| That the browser runs as `pim-desktop` under Ubuntu 24.04's unprivileged user namespace restriction (Chrome's sandbox) | **not checked** |
| How the desktop session starts (autologin, its X server and D-Bus), Cua and its daemon not running as root, polkit rules, SSH keys, other listeners, and whether `systemd-oomd` or anything else acts on `system.slice` | **not checked** |

The desktop account is a prerequisite, not made here, because the persistent session must already be configured for it. The installer creates nothing for it but the workspace, and never adds it to a group.

## What `install` does

`plan.sh` prints the same plan without changing anything. `install.sh` checks everything above first, then, in order, stopping at the first failure:

1. Reads the staged certificate and key (regular files, not through links) and checks that the key is the certificate's and the certificate is valid now. Nothing has changed yet if this fails.
2. `groupadd --system pim-session`, then `useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --groups pim-session pim-bridge`, and checks the result from `/etc/passwd`, `/etc/group` and `/etc/shadow`: `pim-bridge` a system account of its own UID with no login shell, no home and a locked password, in exactly its own group and `pim-session`; `pim-session` holding `pim-bridge` alone; `pim-desktop` still in no other group.
3. Makes the files below, each new (`O_CREAT | O_EXCL | O_NOFOLLOW`, never over or through anything), mode `0600` while written, then given its owner and mode through its descriptor. `/etc/pim-bridge` is made root's and `0700`, filled, and only then given to `pim-bridge`.
4. `systemd-tmpfiles --create` for the socket directory's entry and `systemctl daemon-reload`; then checks, with `systemctl show`, that each unit is exactly the file it wrote (`FragmentPath`), with no drop-in merged from any of the places systemd reads them (`DropInPaths` empty), as its account, with `KillMode=process` (`unit-check` otherwise); then `systemctl enable` for both services, **without starting them**.
5. Removes the two staged TLS files, each only if it is still the file it read (same device and inode).

| Path | Owner | Mode | What |
| --- | --- | --- | --- |
| `/etc/pim-eval/` | root | `0755` | |
| `/etc/pim-eval/eval-key.pub.pem` | root | `0644` | the evaluation's public key, which `seal` reads |
| `/etc/pim-bridge/` | `pim-bridge:pim-bridge` | `0700` | the bridge's secrets; no group of the desktop's reaches it |
| `/etc/pim-bridge/cert.pem`, `key.pem` | `pim-bridge:pim-bridge` | `0600` | the staged certificate and key, copied |
| `/etc/pim-bridge/token` | `pim-bridge` | `0600` | made later by `seal`, never by the installer |
| workspace | `pim-desktop:pim-desktop` | `0700` | pim-computer's `--root` |
| `/etc/tmpfiles.d/pim-cua-session.conf` | root | `0644` | `d /run/pim-session 2750 pim-desktop pim-session -` |
| `/etc/systemd/system/pim-cua-desktop.service`, `pim-cua-bridge.service` | root | `0644` | the services |

A failure prints `{"event":"pim-cua-eval.failed","command":"install","step":"<step>","reason":"<reason>","changed":true|false}` and undoes nothing: it never deletes, recursively changes or reuses what it or anyone made, and there is no resume. **A failed install means a new VM.** Running it again on the same VM is refused (`preexisting-account` or `preexisting-path`).

## The services

```ini
# pim-cua-desktop.service (headful, desktop UID 1000)
[Service]
Type=simple
User=pim-desktop
Group=pim-desktop
WorkingDirectory=/srv/pim-workspace
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=LANG=C.UTF-8
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
ExecStart=<node> <bundle>/computer/cua-host/desktop.ts --socket /run/pim-session/session.sock --root /srv/pim-workspace --browser <browser> --pim-computer <bundle>/computer/pim-computer.ts --headful
ExecStopPost=/usr/bin/dash -c 'case "$$EXIT_CODE" in killed|dumped) exec /usr/bin/find /run/pim-session -mindepth 1 -maxdepth 1 -name session.sock -type s -user pim-desktop -delete;; esac'
KillMode=process
SendSIGKILL=no
TimeoutStopSec=infinity
Restart=no

# pim-cua-bridge.service
[Unit]
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=pim-bridge
Group=pim-bridge
WorkingDirectory=/
Environment=PATH=/usr/bin:/bin
Environment=PIM_BRIDGE_TOKEN_FILE=/etc/pim-bridge/token
Environment=PIM_BRIDGE_CERT_FILE=/etc/pim-bridge/cert.pem
Environment=PIM_BRIDGE_KEY_FILE=/etc/pim-bridge/key.pem
ExecStart=<node> <bundle>/computer/cua-host/bridge.ts --space <owner> --path /pim --socket /run/pim-session/session.sock --host 0.0.0.0 --port 8443
KillMode=process
Restart=no
```

Both are ordinary system services, `WantedBy=multi-user.target`, each running its program as its own account with fixed arguments; the bridge starts after the network is up. The desktop's environment is a subset of what `desktop.ts` passes on (`KEPT_ENVIRONMENT`); systemd adds `HOME`, `USER`, `LOGNAME` and `SHELL` for the account. The bridge's names only files, never a secret, and systemd gives it `pim-session` from the group database, which is how it reaches the socket. Neither unit has a resource, confinement, sandboxing, capability or delegation directive; this layer adds none, and claims no isolation.

- **The desktop session's display is used, not made.** A headful browser gets the persistent session's `DISPLAY`, `XAUTHORITY` if configured, its runtime directory and session bus. No X server, D-Bus or session is started, and Cua's own programs are not touched.
- **Stopping signals only the main program.** systemd's default would send `SIGTERM` to every process of the unit and `SIGKILL` them after 90 s. `KillMode=process` sends `SIGTERM` to the program alone, and, for the desktop, `SendSIGKILL=no` and `TimeoutStopSec=infinity` take away the `SIGKILL`. The endpoint then does what `docs/cua-bridge.md` says: it ends its connection, and waits for the pim-computer it started to exit, asking it (`SIGTERM`) after 30 s and ending it (`SIGKILL`, that one process only) 5 s after that. **So `systemctl stop pim-cua-desktop` may wait about 35 s, and doesn't return until the OS reports that pim-computer has exited; if it never does, the stop never finishes.** Neither systemd nor this installer signals a process group, the browser, or anything else. A browser or command pim-computer started that outlives it stays in the unit's control group, which `status` counts (`processes`), and systemd will say so on the next start. The service having stopped is not a sign that nothing runs as `pim-desktop`, and neither is anything else here; rebooting or deleting the VM ends everything, which is not a claim this layer makes.
- **No timeout, because of the socket.** A stop timeout would let systemd give up on an endpoint that is still running and run `ExecStopPost`, removing the socket a live endpoint still listens on, and a restart would then start a second endpoint beside it. Without one, the next endpoint starts only after the last has exited, which, for the endpoint, follows the exit of the pim-computer it started.
- **The socket directory and stale sockets.** systemd-tmpfiles makes `/run/pim-session` at boot (`pim-desktop:pim-session`, `2750`), as `desktop.ts` requires; it is never removed by a service. The endpoint removes its own socket when it stops cleanly (Node does, on `close`). Only when a signal ended it (systemd's `$EXIT_CODE` is `killed` or `dumped`, as after an out-of-memory kill), so it couldn't, does `ExecStopPost`, which systemd runs as `pim-desktop` after it has seen the endpoint exit, remove exactly `/run/pim-session/session.sock`, and only if it is a socket owned by `pim-desktop`. After any other exit, a refused start (`socket-exists`) or an uncaught error included, whatever is at the path stays, the next start refuses it, and the operator decides. Nothing else is ever unlinked, and nothing is removed before a start. Since the directory is the desktop account's, any of its processes could put a socket there; one put there between a signal's end of the endpoint and `ExecStopPost` is removed with it.
- **No restart by itself.** Neither service restarts on failure. After an endpoint crash, the pim-computer it started may still run, unobserved, in the unit's control group; `start.sh` refuses while any process is there (`desktop-processes`), so it never puts a second endpoint beside the first's pim-computer. A plain `systemctl start` doesn't check this; use `start.sh`, or look at `status` first.
- **At boot.** Both services are enabled, so a reboot starts them without `start.sh`'s checks: the bridge exits at once (`bridge.failed`, `token`) until `seal` has run, and the endpoint serves whether or not the session's display is up yet (a headful browser fails to start until it is). After a reboot, nothing is left in either control group.
- **Port.** The bridge listens on `bridge.host:bridge.port`, unprivileged (8443 by default), as soon as `start.sh` runs; nothing listens before. There is no proxy, `setcap` or root listener. Forwarding 443 to it, and a certificate Pim's `fetch` trusts, are separate stages (below).

## Running it

Every step is a Run Command invocation of a rendered script (or of its copy cloud-init placed). The `az` lines are illustrations; nothing here runs them.

```sh
az vm run-command invoke … --command-id RunShellScript --scripts @"$STATE/$EVAL/scripts/plan.sh"      # read-only
az vm run-command invoke … --command-id RunShellScript --scripts @"$STATE/$EVAL/scripts/install.sh"
set -o pipefail
az vm run-command invoke … --command-id RunShellScript --scripts @"$STATE/$EVAL/scripts/seal.sh" \
  | node computer/cua-host/eval-credentials.ts capture --out "$STATE/$EVAL/response.json"   # then open, docs/cua-eval-credentials.md
az vm run-command invoke … --command-id RunShellScript --scripts @"$STATE/$EVAL/scripts/start.sh"
az vm run-command invoke … --command-id RunShellScript --scripts @"$STATE/$EVAL/scripts/status.sh"
```

- `install` prints `{"event":"pim-cua-eval.installed",…}`.
- `seal` runs once. It refuses a token that is already there, so running `seal.sh` again changes nothing; after any failure or a lost response, follow "When something fails" in `docs/cua-eval-credentials.md`: no reading the token, no second seal, a new VM and key.
- `start` refuses until the token is the bridge's `0600` file (`token-missing`), for a headful browser until the display is there (`display-missing`), and while any process is in the desktop endpoint's control group (`desktop-processes`, which includes it already running); then starts the desktop endpoint, then the bridge.
- `status` prints one JSON object of metadata: whether the accounts are as expected; owner, group and mode of each file above and of the staged files (`absent` once removed); the certificate's SHA-256 fingerprint, dates and subject alternative names (it is public; the key is never read); `ptrace_scope`; each service's `is-enabled`, `is-active` and the number of processes in its control group; the display's presence; and `denied`, which, for each of the token, certificate and key, runs `runuser -u pim-desktop -- head -c 0 -- <file>`, which opens the file as the desktop account with the groups it logs in with and reads nothing, and says `denied`, or `READABLE` if it opened. The public key, which the desktop account may read, is opened the same way first, as a control: if that fails too, each says `unknown`, since the check itself didn't work.

## What remains before a VM is ready

This layer is ready for review, not for use; no VM is ready because of it. Still needed, each separately reviewed:

- **The base image or bootstrap**: Ubuntu 24.04 with the `pim-desktop` account and its persistent graphical session (autologin, X server, D-Bus) as the table above requires; the pinned Node (22.18 or later; the repository's CI uses Node 26) and browser, their SHA-256 recorded; Cua, if used, with its daemon not running as root; and that Chrome's sandbox works for `pim-desktop` under Ubuntu 24.04's user namespace restriction.
- **Delivery**: how the bundle (with its modes, root's), the staged TLS certificate and key (root `0700`/`0600`), and the scripts reach the VM. No public blob, secret endpoint or URL is assumed here, and the key must never travel in user data, a script or a flag.
- **The certificate and the network**: a certificate for the bridge's name that Pim's `fetch` (the preview's workerd) trusts, its issuance (ACME or otherwise), DNS, and whether 443 is forwarded to the unprivileged port; the VM's inbound rules. None of it is here.
- **Azure**: the VM, its identity and Run Command permissions limited to the operator (which `docs/cua-eval-credentials.md` relies on for provenance), the budget, and teardown. No Azure API is called here.
- **Checks on a real VM, as two accounts**: `plan`, `install`, `seal`, `start` and `status` end to end; `pim-desktop` refused each secret file (`status`'s `denied`) and unable to enter `/etc/pim-bridge`; `pim-bridge` in exactly its own group and `pim-session`; the endpoint taking the socket directory and making the socket `0660` with its group; the bridge connecting through it; the browser starting on the session's display as `pim-desktop`; `systemctl stop` waiting for pim-computer and leaving no socket; the socket of an endpoint ended by a signal removed by `ExecStopPost`, and one left after an exit refused at the next start; `systemctl show` reporting no drop-ins; the envelope arriving whole through Run Command; and the preview reaching the bridge over TLS.

## Tests

`computer/cua-host/test/eval-install.test.ts` (part of `pnpm --filter pim-cua-host test`) runs no installer, management script, account or service command, and nothing privileged:

- the planner, over a synthetic VM given as metadata (never this machine's accounts), produces exactly the accounts, groups, files, owners, modes, unit texts and `systemctl` commands above, and starts nothing; and refuses, before any change, each unsafe or unexpected state: not root, another OS, no systemd, `ptrace_scope` 0, writable or linked tools, Node, bundle files or their directories, a bundle of another commit, a browser that is linked, not runnable by all, or of another digest, directories the services' accounts can't pass through, existing installer accounts, groups or paths (links and drop-in directories included), a desktop account missing, root, sharing its UID or group, in `sudo` or `docker`, named in sudoers, or with a writable home, unsafe parents, unsafe staged TLS files, and a workspace in the desktop's home;
- the configuration's refusals, field by field (extra and missing fields, a privileged port, a host name, an unnormalized path, characters a unit or shell would read, a workspace outside `/srv`, an old Node, a 2048-bit key or another fingerprint, overlapping paths);
- the units, compared whole with text written in the test: only allowed directives (no resource, confinement, sandboxing or restart policy), `KillMode=process` on both, no `SIGKILL` or stop timeout for the desktop, the socket removed after a stop only when a signal ended the endpoint, neither account root, the desktop's variables a subset of `desktop.ts`'s `KEPT_ENVIRONMENT`, the bridge's only file names;
- `apply` against a stand-in VM: files given to the UID `useradd` made, the bridge's directory root's until filled, the staged files removed, the key's buffer zeroed, no token touched; and stopping, undoing nothing, at a mismatched or expired certificate (nothing changed), a failed `useradd`, a failed write (the directory still root's, the staged files kept), an account left in an unexpected group, or a drop-in `systemctl show` reports (neither unit enabled);
- the account check's refusals: a login shell, a home, a non-system or root UID, an extra group, a session group with the desktop in it or without the bridge, an unlocked password;
- `status` against a stand-in probe: metadata only, the denial checks as `pim-desktop` with exact arguments after the control, `READABLE` when one opens, `unknown` when the control fails, and the token and key never read; `start` refusing without the bridge's token or the display, or with a process in the desktop's control group, and starting the desktop before the bridge;
- the rendered scripts: `bash -n`; the pins checked before the one `exec`; no tracing, cloud call, `cat`, `eval`, kill or confinement; the configuration as a here-document that parses back to itself; `seal.sh`'s exact command, and, before it, only statements whose output is captured or goes to standard error (each top-level statement matched against a fixed set, and the functions that print only run inside a command substitution or write to standard error); the cloud-init data writing exactly the scripts and running none;
- the bundle: `ws` taken only at the locked integrity (the repository's own lockfile is read for it), from archives written by hand and by GNU tar, and refused with links, hard links, devices, FIFOs, PAX headers, `..`, absolute, foreign or odd names, a file named as a directory or one that is also another's directory, duplicates, a bad checksum or no end; written new with `0644` and `0755`; and the tree digest equal in Node and in the scripts' bash (the one piece of a script run here, over a folder of the test's), changing with a mode or content, and refused with a link;
- the VM's file operations, over a folder of the test's as this user: only new files and directories, never through a link, and a staged file removed only while it is the one read.

Not shown by them: anything as root or as two accounts, systemd's or `useradd`'s real behavior (`KillMode=process`, `SendSIGKILL=no`, `TimeoutStopSec=infinity`, `$EXIT_CODE` and `$$` in `ExecStopPost`, supplementary groups for `User=`, the setgid mode from tmpfiles.d are as systemd's documentation describes them, not run here), a real npm tarball of `ws` (they use archives of the same format), the display, the browser, and Azure.
