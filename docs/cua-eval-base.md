# Setting up a Cua evaluation VM's base

`computer/cua-host/eval-base/` sets up the base of one new, disposable Ubuntu 24.04 x86-64 VM for a Cua evaluation: the pinned Node and Google Chrome, the shared non-root `pim-desktop` account, and one persistent X11 display with an Xfce session for it. That is what the installer (`docs/cua-eval-install.md`) checks for before it makes the bridge's account, the session group, the workspace, the secret directories and the two services, none of which this layer makes. It is evaluation tooling: nothing in Pim imports it, and it changes no Worker code, setting or accepted installer module. **Nothing here has run on a VM**: its tests check the plan, the rendered scripts and their helpers without one (see "Tests").

```
 new Ubuntu 24.04 VM          this base (root, once)                           installer (docs/cua-eval-install.md)
 (Azure image, stock)  ──▶    /opt/pim-node/bin/node        (pinned, root's) ──▶ pim-bridge, pim-session
                              /opt/google/chrome/chrome     (pinned .deb)        /etc/pim-bridge, /etc/pim-eval
                              pim-desktop (2000:2000, own group only, locked)    /srv/pim-workspace, /run/pim-session
                              /home/pim-desktop             (0750)               pim-cua-desktop.service, pim-cua-bridge.service
                              user manager (linger) ─▶ pim-desktop-session.service
                                 xinit ─▶ Xvfb :0 + xfce4-session, bus at /run/user/2000/bus
```

The space's agents all run as `pim-desktop`, as `docs/cua-bridge.md` describes; nothing here isolates them from each other or confines the account. `/workspace` is a convention, not a sandbox.

## What it is made of

- **`manifest.ts`**: the pins, as data: the image, Node, Chrome, Ubuntu's stock AppArmor profile for Chrome, and the Ubuntu packages, each with where it came from (below).
- **`base.ts`**: the plan (`preflight()`, `actions()`, `checks()`), each step one call with fixed words; the session's unit; and `render`, which writes the scripts:

```sh
node computer/cua-host/eval-base/base.ts render --out "$STATE/$EVAL/base"
```

It writes `setup.sh`, `check.sh`, `review.sh`, `cloud-config.yaml` and `installer-fragment.json` into a new private directory (`0700`, each file `0600`), with the same rules for its parent as the installer's `render` (`docs/cua-eval-install.md`). The scripts are bash, set `-euo pipefail`, `umask 022` and `PATH=/usr/sbin:/usr/bin`, hold no secret, make none and print none, and take nothing from the request that runs them. Every word they pass is single-quoted from a checked set, and the two files they write come from quoted here-documents, so nothing is expanded. `cloud-config.yaml` only places the three scripts at `/usr/local/sbin/pim-cua-base-<name>` (root's, `0700`) and runs none of them.

## The pins

Every pin was taken on 2026-10-26 from the vendor's own signed metadata, downloaded and checked read-only on the operator's machine; nothing was installed or run there. The setup refuses anything that doesn't match, and a pin is replaced only by a reviewed change to `manifest.ts`.

| What | Pin | Provenance |
| --- | --- | --- |
| Node `v24.22.1` (24 LTS, a security release) | `node-v24.22.1-linux-x64.tar.xz`, 32,026,916 bytes, SHA-256 `6c172a9a…77095e6`; its `bin/node`, 126,879,696 bytes, SHA-256 `e32e2d16…2207cfafb` | `SHASUMS256.txt` of the release, its detached signature verified with `gpgv` against the Node release team's active keys (`nodejs/release-keys`, made by `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`); the archive matched it, and holds `bin/node` as a regular file |
| Google Chrome `156.0.8078.47-1` | `google-chrome-stable_156.0.8078.47-1_amd64.deb`, 144,849,192 bytes, SHA-256 `6c92cd22…5c4d7ac8`; its `/opt/google/chrome/chrome`, 300,920,136 bytes, SHA-256 `95dc9473…f1747b72`, `0755`; `chrome-sandbox` `4755`, SHA-256 `be9f5d4b…37d60314` | dl.google.com's stable `InRelease`, verified with `gpgv` against Google's Linux signing key `EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796` (subkey `0E225917414670F4442C250DFD533C07C264648F`), lists the amd64 `Packages` by SHA-256, which lists this .deb |
| Ubuntu packages | `xvfb 2:21.1.12-1ubuntu1.9`, `xinit 1.4.1-0ubuntu5`, `xfce4-session 4.18.3-1build2`, `xfwm4 4.18.0-1build3`, `xfce4-panel 4.18.4-1ubuntu0.1`, `xfdesktop4 4.18.1-1build3`, `xfce4-settings 4.18.4-0ubuntu3`, `dbus-user-session 1.14.10-4ubuntu4.1` | The newest of noble, noble-updates and noble-security (main, universe) that day; each suite's `InRelease` verified with `gpgv` against the Ubuntu archive key `F6ECB3762474EDA9D21B7022871920D1991BC93C`, each `Packages` index matching it. On the VM apt checks them against the image's own keyring |
| Ubuntu's AppArmor profile `chrome` | `/etc/apparmor.d/chrome` holds `profile chrome /opt/google/chrome/chrome flags=(unconfined) {` and `  userns,` | Shipped by `apparmor` 4.0.0-beta3-0ubuntu3 and 4.0.1really4.0.1-0ubuntu0.24.04.9 alike, read from those packages |

**The limits of this.** Node and Chrome are exact: a pinned file that isn't there or differs refuses. Google keeps only recent versions at their pool URLs, so once this Chrome is gone the download fails and the pin must be replaced, not worked around. For Ubuntu, only the eight top-level versions are pinned: their dependencies (and Chrome's) are whatever those suites hold the day the setup runs, and noble-updates and noble-security list only their newest version, so a pin there stops resolving once it is superseded, and the setup then refuses. The setup records every installed package, version, architecture and state on the VM (`/var/lib/pim-cua-base/packages.tsv`); two VMs set up on different days may differ below the pins, and that record is how to tell. Unattended security upgrades stay as the image has them, so a pinned package may move after setup; `check` then says `packages` false. None of this is a reproducible build.

**Cua's own programs are not here.** The accepted data path is the bridge, its Unix socket, the desktop endpoint and `pim-computer --stdio`, which drives Chrome over the DevTools protocol and runs commands itself; none of it calls Cua's driver or `spacesd`. So neither is pinned, installed or started (the earlier standalone evaluation's spacesd 0.7.0 and driver 0.38.0, and its bootstrap, are not part of this). Nothing here is a human input path either: no VNC, RDP or other viewer, and no takeover.

## What `setup` does

Run once, as root, on a new VM. First the checks; nothing changes until every one passes. A failure prints `{"event":"pim-cua-base.failed","command":"setup","step":"<step>","reason":"<reason>","changed":true|false}` to standard error.

| Check | Refuses with |
| --- | --- |
| Run as root | `root-required` |
| `/usr/lib/os-release` a regular file of root's in root's directories (not `/etc/os-release`, a link), saying exactly `ID=ubuntu`, `VERSION_ID=24.04`, `VERSION_CODENAME=noble`, each once. Its lines are compared as data, never sourced or evaluated | `os` |
| `uname -m` is `x86_64` and `dpkg --print-architecture` is `amd64` | `arch` |
| Booted with systemd (`/run/systemd/system`) | `systemd` |
| Every program the scripts call (`BASE_TOOLS`) a regular file of root's, writable by no one else, in root's directories | `tools` |
| The name service (`getent`) knows no `pim-desktop`, `pim-bridge` or `pim-session` user or group, nor UID or GID 2000; anything but "not found" refuses | `preexisting-account` |
| Nothing, not even a dangling link, at any path the base makes, or that would change what it relies on: the home, the mail spool, `/var/lib/pim-cua-base`, `/opt/pim-node`, `/opt/google`, `/etc/default/google-chrome`, Chrome's apt sources and AppArmor profile, the session unit, its drop-in directory and its enablement link, the linger file, `/run/user/2000`, `/tmp/.X11-unix/X0`, `/tmp/.X0-lock`, `/etc/X0.hosts` | `preexisting-path` |
| `/home`, `/opt`, `/var/lib`, `/etc/default`, `/etc/apt/sources.list.d`, `/etc/systemd/user`, `/var/lib/systemd` and every directory above them root's and writable by no one else | `unsafe-parent` |
| Ubuntu's stock `chrome` profile there, root's, with the two lines above | `browser-sandbox` |

Then the steps, in order, each stopping at its first failure, none undone (`changed` is then `true`):

1. **`staging`**: `/var/lib/pim-cua-base`, new, root's `0700`.
2. **`node-archive`**, **`chrome-deb`**: each downloaded there with `curl` (HTTPS only, redirects to HTTPS only, at most the pinned size, a few retries), then checked to be exactly the pinned size and SHA-256. Nothing is installed from either before both are checked.
3. **`node-extract`**: only `node-v24.22.1-linux-x64/bin/node` is taken out of the archive, into a new directory, without the archive's owner or modes, never over anything; it must then be a regular file (a link or hard link refuses) with the binary's pinned size and SHA-256.
4. **`node`**: `/opt/pim-node` and `/opt/pim-node/bin` made new (`0755`), the binary copied to `/opt/pim-node/bin/node` (`0755`, root's) and checked again.
5. **`chrome-defaults`**: `/etc/default/google-chrome` (`0644`), with `repo_add_once="false"` and `repo_reenable_on_distupgrade="false"`, the package's own documented setting, so neither its `postinst` nor its daily cron job adds Google's apt source.
6. **`apt-update`**, **`packages`**: `apt-get update` (any failed index is an error), then one `apt-get install --no-install-recommends` of the eight pinned versions and the checked .deb, waiting up to 10 minutes for apt's lock (a new VM's own updates may hold it). Their output goes to `/var/lib/pim-cua-base/setup.log`, not to Run Command. Then each pinned version, and Chrome's, must be what dpkg says is installed.
7. **`chrome`**: `/opt/google/chrome/chrome` root's, `0755`, in root's directories, with the pinned size and SHA-256; `chrome-sandbox` root's `4755` with its pinned digest; and no Google apt source and no AppArmor profile of Chrome's own (its `postinst` installs one only when Ubuntu's is missing, which the checks refused first).
8. **`record-packages`**: `packages.tsv`, new.
9. **`desktop-group`**, **`desktop-account`**: `groupadd --gid 2000 pim-desktop`, then `useradd --uid 2000 --gid 2000 --comment 'Pim desktop' --home-dir /home/pim-desktop --create-home --shell /bin/bash --key HOME_MODE=0750 --key SUB_UID_COUNT=0 --key SUB_GID_COUNT=0 pim-desktop`: no other group, no password (useradd's default leaves it locked), no subordinate UID or GID ranges, nothing in the home but `/etc/skel`.
10. **`desktop-check`**: through the name service, the account is exactly `pim-desktop:x:2000:2000:Pim desktop:/home/pim-desktop:/bin/bash`, UID 2000 is it alone, its group `pim-desktop:x:2000:` holds no one, `id -G` says `2000` only, `passwd --status` says `L` (locked), `/etc/subuid` and `/etc/subgid` have no line for it, and the home is its own, `0750`.
11. **`desktop-dirs`**: `~/.pim-computer` (where pim-computer keeps the browser's profile), `~/.local` and `~/.local/bin` (on the login shell's `PATH` through Ubuntu's `~/.profile`), each made by the account itself (`runuser -u pim-desktop -- mkdir -m 0700`) and checked.
12. **`session-unit`**, **`session-enable`**: the unit below, new, root's `0644`, then `systemctl --global enable`, checked by its link in `default.target.wants`.
13. **`linger`**: `loginctl enable-linger pim-desktop`, which starts the account's user manager now and at every boot; that starts its D-Bus session bus and the session.

It prints `{"event":"pim-cua-base.set-up","account":"pim-desktop","display":":0"}`. Running it again on the same VM is refused (`preexisting-account` or `preexisting-path`). **Any failure, or any doubt about what a step did, means a new VM**: nothing here repairs, resumes, deletes or reuses.

| Path | Owner | Mode |
| --- | --- | --- |
| `/var/lib/pim-cua-base/` and what it holds (the two downloads, the extracted binary, `setup.log`, `packages.tsv`) | root | `0700` (no one else can enter it) |
| `/opt/pim-node/`, `/opt/pim-node/bin/` | root | `0755` |
| `/opt/pim-node/bin/node` | root | `0755` |
| `/opt/google/chrome/chrome`, `chrome-sandbox` (from the .deb) | root | `0755`, `4755` |
| `/etc/default/google-chrome` | root | `0644` |
| `/home/pim-desktop/` | `pim-desktop:pim-desktop` | `0750` |
| `~/.pim-computer/`, `~/.local/`, `~/.local/bin/` | `pim-desktop:pim-desktop` | `0700` |
| `/etc/systemd/user/pim-desktop-session.service` | root | `0644` |
| `/var/lib/systemd/linger/pim-desktop` | root (logind) | |
| `/run/user/2000/` (made by logind at each boot) | `pim-desktop` | `0700` |

## The session

```ini
# /etc/systemd/user/pim-desktop-session.service
[Unit]
Description=Pim Cua evaluation desktop session (Xvfb :0 and Xfce)
ConditionUser=pim-desktop
Requires=dbus.socket
After=dbus.socket

[Service]
Type=simple
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus
Environment=XDG_SESSION_TYPE=x11
Environment=XDG_CURRENT_DESKTOP=XFCE
ExecStart=/usr/bin/xinit /usr/bin/xfce4-session -- /usr/bin/Xvfb :0 -screen 0 1280x800x24 -nolisten tcp
Restart=no

[Install]
WantedBy=default.target
```

- **One ordinary startup definition.** It is a user unit in the account's own systemd user manager, which lingering starts at boot without a login; `ConditionUser` keeps it out of any other account's manager (such as the image's admin account, if someone signs in). It has no resource, confinement, sandboxing, cgroup, delegation, capability, kill or user directive, and starts no other process by name. xinit starts the X server, waits for it, then starts Xfce on it, and ends the server when Xfce ends; it doesn't restart.
- **No root desktop, no login.** Nothing runs as root but systemd and logind. There is no display manager, autologin, password, SSH key or other credential, and the account is in no group but its own (so not `sudo`, `adm`, `audio`, `video`, `docker` or `lxd`).
- **Predictable, as the installer needs.** Display `:0` (its socket `/tmp/.X11-unix/X0`, the account's, in the directory systemd's stock `x11.conf` makes root's `1777` at boot), `XDG_RUNTIME_DIR=/run/user/2000` (logind's, the account's, `0700`), `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/2000/bus` (`dbus-user-session`'s socket there), and no `XAUTHORITY`. `installer-fragment.json` is the part of the installer's configuration this decides; the installer's desktop unit then carries exactly these three variables (a test renders it to check):

```json
{
  "node": { "path": "/opt/pim-node/bin/node", "sha256": "e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb", "version": "v24.22.1" },
  "browser": { "path": "/opt/google/chrome/chrome", "sha256": "95dc9473b4f904cb3ab0800fc7206081fcae12abc094a088bd741a13f1747b72" },
  "desktop": { "headful": true, "display": ":0", "xauthority": null }
}
```

- **Who can reach the display.** Without an authorization file, the X server enables local access for the whole host (`EnableLocalAccess` in the X server's `os/auth.c` and `os/access.c`, 21.1.12): any local account can connect over its Unix socket, the filesystem one or Linux's abstract one, while TCP is off (`-nolisten tcp`). A cookie would close that, but making one is generating a secret, which this layer doesn't do. So `pim-bridge` and the image's system accounts can open the display. The bridge already reaches everything the desktop account can through the session socket, by design (`docs/cua-bridge.md`); system services that could connect are a residual exposure for review. Closing it (a cookie made by a reviewed credential step, with `/etc/X0.hosts` naming `si:localuser:pim-desktop`) is a separate change.
- **The browser's sandbox.** Chrome runs from `/opt/google/chrome/chrome`, root's, which Ubuntu's own `chrome` profile lets make the user namespaces its sandbox needs under the image's `kernel.apparmor_restrict_unprivileged_userns=1`. Nothing here writes, loads or changes an AppArmor profile, a sysctl or any confinement, and pim-computer passes no `--no-sandbox` to a non-root browser. If that profile is missing, the setup stops (`browser-sandbox`): that is a blocker to report, not one to work around. That Chrome actually starts sandboxed as `pim-desktop` is only shown on a VM.
- **Persistent.** The home, the browser's profile under `~/.pim-computer` and `~/.local/bin` are on the VM's disk and survive reboots; the session starts again at each boot.

## Running it

Every step is a Run Command invocation of a rendered script, or of the copy cloud-init placed; the `az` lines are illustrations, and nothing here runs them. Run Command keeps only the last 4 KiB of output, which these scripts stay well under.

```sh
az vm run-command invoke … --command-id RunShellScript --scripts @"$STATE/$EVAL/base/setup.sh"     # once; a few minutes
az vm run-command invoke … --command-id RunShellScript --scripts @"$STATE/$EVAL/base/check.sh"     # read-only, once the session has started
az vm run-command invoke … --command-id RunShellScript --scripts @"$STATE/$EVAL/base/review.sh"    # read-only metadata for the review below
```

`check` prints one line per check (`account`, `home`, `node`, `chrome`, `browser-sandbox`, `apt-sources`, `packages`, `session-unit`, `user-manager`, `session`, `runtime-dir`, `display`) and `{"event":"pim-cua-base.checked","ok":true}`, exiting 1 unless all passed. It reads files' metadata and digests and asks systemd (`systemctl show`, for `user@2000.service` and, with `--user --machine=pim-desktop@.host`, for the session); it lists no process and signals nothing. A false `session` or `display` right after setup can mean it hasn't started yet; one that stays false means a new VM, not a fix in place. Then the installer: its `plan.sh` checks the same prerequisites again from its side.

## Administrative authority: what must be reviewed before qualification

The accepted installer searches sudoers files for the three account names, as a tripwire. A name that isn't there doesn't show an account has no administrative authority, and neither does anything in this layer. Before a real qualification, a person reviews the exact fresh image (the same image version, before or right after `setup`) for authority that reaches `pim-desktop` (or later `pim-bridge`) without naming it:

- **sudo.** `/etc/sudoers` and everything it includes: `@includedir /etc/sudoers.d` and `@include`/`#include` of any other file or directory. Look for rules for `ALL`, for groups (`%sudo`, `%admin`, any other, including non-Unix groups `%:…`), for `User_Alias`, `Runas_Alias`, `Host_Alias` and `Cmnd_Alias` that could expand to these accounts or to everyone, `NOPASSWD`, and `Defaults` that change who is asked what. Azure's provisioning typically adds a file for the image's admin account (such as `90-cloud-init-users`): it should name that account alone.
- **Where accounts and groups come from.** `/etc/nsswitch.conf`'s `passwd`, `group`, `shadow`, `gshadow`, `sudoers` and `netgroup` lines. Stock Ubuntu 24.04 uses local files and systemd's module; `sss`, `ldap`, `winbind` or Microsoft Entra ID's `aad` module (from Azure's AAD login extension) could add groups or sudo rules for any account, `pim-desktop` included, that no local file shows.
- **polkit.** `/etc/polkit-1/rules.d` and `/usr/share/polkit-1/rules.d` (JavaScript rules, which can grant any action to any user or group), and the image's actions' defaults. The desktop account's processes run in a lingering user manager, not a logind session, so polkit applies each action's `allow_any` default to them, as to any account outside a session: an action whose `allow_any` is `yes` is open to them.
- **Groups.** The members of `sudo`, `admin`, `wheel` and `adm`, and that `pim-desktop` is in its own group alone.

`review.sh` gathers the metadata for this, read-only, and decides nothing: for each sudoers and polkit rules file and `nsswitch.conf`, its SHA-256 and owning package (a link or anything not a regular file is listed as such); the name service's lines above; those groups' members and the desktop account's groups; and `dpkg --verify` of `sudo`, `polkitd` and `libc-bin`, which lists their files that differ from the packages (empty output means none do). A file not owned by a package, or one `dpkg --verify` lists, is read by the reviewer on a disposable copy of the image. No privilege escalation is attempted or tested here, on a VM or anywhere: the review is reading, and anything doubtful means a different image or a separately reviewed change, not an experiment.

## What remains

This layer is ready for review, not use; no VM is ready because of it. Still needed, each separately reviewed:

- **Azure**: the VM itself (Ubuntu 24.04 LTS, x86-64, the image version recorded), its identity and Run Command permissions limited to the operator, the network rules, the budget and teardown. The image's admin account and its SSH access are Azure's provisioning, not this base, and are part of the review above. No Azure API is called here.
- **Delivery**: of these scripts (Run Command, or the cloud-init data), and later of the installer's bundle, staged TLS files and scripts (`docs/cua-eval-install.md`).
- **The certificate and the network**: the bridge's certificate and its issuance, DNS, any forwarding of 443, and inbound rules. Nothing here listens on the network.
- **The installer, the credential channel and the preview**: as their own documents say.
- **Checks on a real VM** that the tests here can't make: the downloads at their URLs with their pins; apt resolving the eight pins and Chrome's dependencies without a prompt; `useradd` leaving the password locked and allocating no subordinate IDs with those keys; `systemctl --global enable` making the link checked; lingering starting `user@2000.service` at once and after a reboot; xinit starting Xvfb and Xfce under it, `/tmp/.X11-unix/X0` the account's; the bus at `/run/user/2000/bus`; `check` all true; Chrome starting headful on `:0` as `pim-desktop` from the installer's desktop service, with its sandbox (no `--no-sandbox`, no change to AppArmor); the `review.sh` metadata reviewed; and the installer's `plan.sh` passing on the result.

## Tests

`computer/cua-host/test/eval-base.test.ts` (part of `pnpm --filter pim-cua-host test`) runs no base script, account, package, service or privileged command, and reaches no network:

- the manifest: Node's and Chrome's pins well formed and consistent with their URLs and the staged file names, Node at least the installer's minimum, each Ubuntu package at one exact version, none a viewer, remote access, container, display manager or admin package, and no Cua program anywhere;
- the installer's own `parseConfig` taking the fragment, and its own `plan` over a synthetic VM in the state the base leaves (the account as `desktop-check` requires it, Node and Chrome root's in root's directories, an Azure-like admin account in `sudo`) planning its install; and refusing when the desktop account is also in `sudo`, its home is group-writable, or Node or Chrome isn't root's; the installer's desktop unit carrying exactly the session's `DISPLAY`, `XDG_RUNTIME_DIR` and bus, and no `XAUTHORITY`;
- the plan: the checks before any change, in order, with their reasons; every path a step writes being, or being under, one the checks require absent; both downloads checked before anything is installed from them; the exact `apt-get`, `groupadd`, `useradd` and `runuser` calls; no group, password, key or login given; no deletion, move, recursive change, link or forced overwrite; every program a step names checked root's first; and `check` only reading;
- the session's unit, compared whole with text written in the test; its directives from a fixed allowed set; the X server with TCP off, access control not disabled, and no viewer;
- the scripts: `bash -n`; the fixed environment; the setup's statements, after its two here-documents, exactly the plan rendered, in order, with `CHANGED=true` only after the last check; the here-documents read back by bash to exactly the rendered text; no secret, secret generation, tracing, evaluation, sourcing, signals, process listing, privilege, confinement, deletion or cloud command; words with quotes or shell syntax refused; `check` and `review` writing nothing; the cloud-init data placing exactly the three scripts and running none, within Azure's custom data limit;
- the helpers, run in bash over a folder of the test's, with stand-in functions for `curl`, `getent`, `id`, `passwd`, `dpkg-query`, `dpkg`, `uname` and `systemctl`: os-release read as data (quoted or not, once, exact, never run: command substitutions and backquotes in it do nothing), paths refused when anything is there (dangling links included), `getent` passing only "not found", a download refused at the wrong size or digest or when something is at its path (before `curl` is called), the one archive member taken as a regular file with only its directories (refused when it is a link or a hard link, missing, or the target directory exists), a new copy and a new file never over anything, package versions compared exactly, the account check refusing another group, a group member, an unlocked password, another shell or primary group, and subordinate IDs by name or UID, a unit taken as running only for exactly `active` and `running`, and the AppArmor lines and architecture as given.

Not shown by them: anything as root, any real package, account, service, display or browser, the vendor URLs as they will answer, and the trust checks passing (the test's files are never root's, so they show only refusals).
