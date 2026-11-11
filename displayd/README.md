# displayd

A small host service that gives each thread of the agent computer its own X display, so two
threads never share a screen, pointer, clipboard or accessibility tree. Plain Node 22 ESM, no
dependencies. It runs on the Pim host next to [sandbox-manager](../sandbox-manager/README.md) and
[hostopsd](../sandbox-manager/hostopsd/README.md), and listens on loopback only.

This part covers leasing displays, supervising them, the HTTP API, and the queue with preemption
and a person's take-over. `DisplayAllocator` takes its runner, store and memory reader as parameters so they can grow.

## A display

One display is one process group, started by one supervisor shell: `Xvnc` (1280x800, VNC on a
loopback port only, no TCP X), `openbox`, a private `dbus-daemon` session and
`at-spi-bus-launcher` and the display's own Cua Driver (`cua-env-driver serve`, an MCP server on a
loopback port that sees only this display's windows; tools there need `delivery_mode: "foreground"`). If any of them exits the group ends. Its context directory,
`/run/pim/displays/<id>/` (0700), holds what a process needs to join it:

| File | Meaning |
| --- | --- |
| `Xauthority` | The display's own cookie (0600) |
| `bus` | The private session bus socket |
| `run/` | `XDG_RUNTIME_DIR` |
| `env` | Shell-sourceable `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `GTK_MODULES=gail:atk-bridge`, `QT_ACCESSIBILITY=1` |
| `driver-token` | The driver's bearer token, 32 random hex characters (0600), written by displayd |
| `pgid`, `ready`, `*.log` | The process group, written when all five are up, and their output |

Display, VNC and Chrome DevTools ports come from the slot a lease holds: display `100 + slot`, VNC
`5910 + slot`, CDP `9320 + slot`, driver `3220 + slot`. A slot is free again when its lease is gone, so the ports are
unique among live displays and reserved for Chrome before it starts.

## Leases

`acquire(threadId, spaceId)` gives a thread one display, and the same lease again if it has one.
States: `queued` (no slot, or the memory guard says no; or `timeout`) → `starting` → `active` ⇄ `idle` →
`reaping` → `gone`. `touch` is the heartbeat; a display not touched for 1 minute is `idle`, and for
10 minutes (20 once `markBrowser` is called, via `{"browser": true}` on `/touch`) it is reaped. A
display still `starting` after 30 s is killed and started once more; the second failure drops the
lease. A display whose processes die is reaped. Displays start one at a time, oldest queued first,
so the memory reading that admits the next one includes the last.

The memory guard (`src/memory.js`) scales with the computer displayd runs in. A display is admitted
only if `MemAvailable - 1 GiB >= reserve`, where the reserve is 15% of `MemTotal` clamped to 0.5–3 GiB,
and, when the computer has swap, `SwapFree >= 1 GiB`. At most `min(6, floor((MemTotal - reserve) / 1.5 GiB))`
displays run, so 2 on a 3.9 GiB computer.

State is kept in `state.json` in the state dir. After a restart displayd re-adopts every display
whose process group is still its own (the pidfile and the name in `/proc/<pid>/cmdline`) and that
answers a health probe, starts their idle clocks afresh, kills and forgets the rest, and reaps
context directories no lease owns. The unit uses `KillMode=process` so a restart of displayd does
not end the displays.

## Queue, preemption and take-over

A thread that cannot get a display (no free slot, or the memory guard says no) is `queued`. The
queue is first come, first served by request time; when several spaces are queued they take turns,
one lease per space per round. A lease queued for 5 minutes (`queueTimeoutMs`) is dropped and its
next `acquire` returns state `timeout` once; asking again queues afresh. Each lease still asks
for one display per thread.

When the queue is not empty and no display can start, displayd reaps the longest-idle display
whose idle time is more than 2 minutes (`minIdleMs`). A display touched within that time by a tool
call or by the viewer, or one a person has taken over, is never preempted. The preempted thread's
lease becomes `gone` with `reason: "preempted"` (shown until it asks again); its next `acquire`
queues a new lease. Its thread directory and profile data stay. After a preemption another one
for memory reasons waits 15 s for the memory to come back.

A queued lease in `acquire`, `GET /displays` and `GET /health` carries `position`,
`estimatedWaitSec` (when a holder becomes preemptable, or is reaped at its TTL at the latest) and
`holders: [{threadId, idleSec, state}]`.

`POST /control {threadId, mode: "user"|"agent"}` sets `lease.control`. While `user`, the display
counts as active, is not preempted or reaped for idleness, and pim-computer returns the retryable
error `display_user_controlled` instead of calling the driver. It reverts to `agent` after 30
minutes without `POST /touch {threadId, viewer: true}`, which is the viewer's heartbeat and
counts as activity like any touch.

## API

Loopback, JSON, `Authorization: Bearer $DISPLAYD_TOKEN` on every request.

| Request | Meaning |
| --- | --- |
| `POST /acquire {threadId, spaceId, waitMs?}` | The lease: 200 once active, 202 while queued or starting (`waitMs` waits up to 60 s) |
| `POST /touch {threadId, browser?, viewer?}` | Heartbeat; `viewer` marks the person watching the display; 404 when the thread has no display |
| `POST /control {threadId, mode}` | `user` takes the display over, `agent` hands it back; 404 when the thread has no display |
| `POST /release {threadId}` | Kills the display and waits; `{released}` |
| `GET /displays` | Every lease, queued ones with their queue status, and `claims` |
| `GET /health` | Slots, queue length, `MemAvailable`, each display's liveness now, with `driver` for the Cua Driver's, and `claims` |
| `GET /sites` | The limited sites: `{sites: {<site>: {max, domains}}}` |
| `POST /site-claim {threadId, site}` | `{granted: true}`, or `{granted: false, holders}` when `max` threads hold the site; asking again is a grant; 404 when the thread has no display or the site isn't limited |
| `POST /site-release {threadId, site}` | `{released}` |

A lease is `{id, threadId, spaceId, state, display, env, vncPort, cdpPort, driver: {base, tokenFile}, browser, createdAt,
lastTouch, attempts, lastError}`. A lease is active only once the driver at `driver.base` answers a
loopback connect; call its `POST /mcp` with `Authorization: Bearer <contents of tokenFile>`.

## Limited sites

To keep a person's account from being seen signed in from several places at once, a site can be
limited to `max` displays at a time. The limits are in `sites.json` in the state directory
(`DISPLAYD_SITES_FILE`), written with the default below when missing and read at start:

```json
{ "linkedin.com": { "max": 1, "domains": ["linkedin.com", "licdn.com"] } }
```

`domains` (default: the site's name) match a host and its subdomains. pim-computer claims a slot
for each limited site among the primary browser's cookies before copying them into a thread's
browser, and copies only the cookies of sites it was granted; a thread that is refused is told, and
is the one to ask the person to use the Primary desktop. A claim ends with its thread's display
(released, reaped, preempted), with `POST /site-release`, and when that thread's browser stops. Claims
are kept in `state.json` and survive a restart with their displays. Desktop tools are not limited.
Adding a site is an entry in the file.

## Run

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISPLAYD_TOKEN` / `DISPLAYD_TOKEN_FILE` | required | Bearer token, or a file holding it |
| `DISPLAYD_HOST`, `DISPLAYD_PORT` | `127.0.0.1`, `9900` | Where the API listens |
| `DISPLAYD_STATE_DIR` | `/var/lib/displayd` | Holds `state.json` |
| `DISPLAYD_CONTEXT_DIR` | `/run/pim/displays` | Context directories |
| `DISPLAYD_MAX_DISPLAYS` | 6 | Lowers the hard maximum (the memory guard may already set it lower) |
| `DISPLAYD_DRIVER_BIN` | `/usr/local/bin/cua-env-driver` | The Cua Driver binary |
| `DISPLAYD_IDLE_TTL_MIN`, `DISPLAYD_BROWSER_TTL_MIN` | 10, 20 | Idle TTLs |

## Install

On the host, install `tigervnc-standalone-server openbox dbus at-spi2-core x11-xauth` (and
`xdotool xclip` for the integration script), then, from the checkout:

```sh
sudo displayd/install.sh
```

It creates the `displayd` user, makes `/tmp/.X11-unix`, writes `/etc/displayd/env` with a generated
token (kept when run again), installs [`displayd.service`](displayd.service) and starts it. Read
the token from that file for whatever calls the API.

## On a computer

`pim-computer install` and each start of pim-computer (so an update too) ensure displayd on a Cua
computer, without ever failing: the packages `tigervnc-standalone-server openbox dbus-x11 at-spi2-core xdotool xclip`
(with `sudo -n`; a warning without it), displayd's files from the same Pim (`/displayd.tar.gz`,
built with the web app, unpacked to `~/.displayd/app`), a token in `/etc/displayd/token` (0640,
the computer user's, made once), and a service that runs as that user: a systemd unit with
`KillMode=process` where there's systemd and sudo, else a restart loop in `~/.displayd`. State is
in `~/.displayd/state` and contexts in `/run/pim/displays`; without sudo the token and contexts
are kept in `~/.displayd`. It prints whether `/health` answers. `PIM_DISPLAYD=0` turns it off,
`=1` turns it on where cua-spacesd isn't present. Restarting displayd leaves the displays running.

## Tests

`node --test` runs the unit tests with a fake runner and a fake clock; no X needed.
`scripts/integration.sh` is not part of CI: on a host with displayd running it starts two real
displays and checks that they have separate cookies, that xdotool in one leaves the other's
pointer alone, that xclip's clipboard is not shared, that VNC is loopback only, and that release
cleans up.
