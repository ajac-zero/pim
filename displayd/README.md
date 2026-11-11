# displayd

A small host service that gives each thread of the agent computer its own X display, so two
threads never share a screen, pointer, clipboard or accessibility tree. Plain Node 22 ESM, no
dependencies. It runs on the Pim host next to [sandbox-manager](../sandbox-manager/README.md) and
[hostopsd](../sandbox-manager/hostopsd/README.md), and listens on loopback only.

This is the first part (P1a): leasing displays, supervising them, and the HTTP API. Queue
fairness and preemption, routing the computer tools to a display, and browser cookies come later;
`DisplayAllocator` takes its runner, store and memory reader as parameters so they can grow.

## A display

One display is one process group, started by one supervisor shell: `Xvnc` (1280x800, VNC on a
loopback port only, no TCP X), `openbox`, a private `dbus-daemon` session and
`at-spi-bus-launcher`. If any of them exits the group ends. Its context directory,
`/run/pim/displays/<id>/` (0700), holds what a process needs to join it:

| File | Meaning |
| --- | --- |
| `Xauthority` | The display's own cookie (0600) |
| `bus` | The private session bus socket |
| `run/` | `XDG_RUNTIME_DIR` |
| `env` | Shell-sourceable `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `GTK_MODULES=gail:atk-bridge`, `QT_ACCESSIBILITY=1` |
| `pgid`, `ready`, `*.log` | The process group, written when all four are up, and their output |

Display, VNC and Chrome DevTools ports come from the slot a lease holds: display `100 + slot`, VNC
`5910 + slot`, CDP `9320 + slot`. A slot is free again when its lease is gone, so the ports are
unique among live displays and reserved for Chrome before it starts.

## Leases

`acquire(threadId, spaceId)` gives a thread one display, and the same lease again if it has one.
States: `queued` (no slot, or the memory guard says no) → `starting` → `active` ⇄ `idle` →
`reaping` → `gone`. `touch` is the heartbeat; a display not touched for 1 minute is `idle`, and for
10 minutes (20 once `markBrowser` is called, via `{"browser": true}` on `/touch`) it is reaped. A
display still `starting` after 30 s is killed and started once more; the second failure drops the
lease. A display whose processes die is reaped. Displays start one at a time, oldest queued first,
so the memory reading that admits the next one includes the last.

The memory guard (`src/memory.js`) admits a display only if `MemAvailable - 1.5 GiB >= 3 GiB`
(Chrome and X cost, then the reserve for sandbox-manager, which shares the host that has no swap),
and never more than 6 displays.

State is kept in `state.json` in the state dir. After a restart displayd re-adopts every display
whose process group is still its own (the pidfile and the name in `/proc/<pid>/cmdline`) and that
answers a health probe, starts their idle clocks afresh, kills and forgets the rest, and reaps
context directories no lease owns. The unit uses `KillMode=process` so a restart of displayd does
not end the displays.

## API

Loopback, JSON, `Authorization: Bearer $DISPLAYD_TOKEN` on every request.

| Request | Meaning |
| --- | --- |
| `POST /acquire {threadId, spaceId, waitMs?}` | The lease: 200 once active, 202 while queued or starting (`waitMs` waits up to 60 s) |
| `POST /touch {threadId, browser?}` | Heartbeat; 404 when the thread has no display |
| `POST /release {threadId}` | Kills the display and waits; `{released}` |
| `GET /displays` | Every lease |
| `GET /health` | Slots, queue length, `MemAvailable`, and each display's liveness now |

A lease is `{id, threadId, spaceId, state, display, env, vncPort, cdpPort, browser, createdAt,
lastTouch, attempts, lastError}`.

## Run

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISPLAYD_TOKEN` / `DISPLAYD_TOKEN_FILE` | required | Bearer token, or a file holding it |
| `DISPLAYD_HOST`, `DISPLAYD_PORT` | `127.0.0.1`, `9900` | Where the API listens |
| `DISPLAYD_STATE_DIR` | `/var/lib/displayd` | Holds `state.json` |
| `DISPLAYD_CONTEXT_DIR` | `/run/pim/displays` | Context directories |
| `DISPLAYD_MAX_DISPLAYS` | 6 | Hard maximum |
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

## Tests

`node --test` runs the unit tests with a fake runner and a fake clock; no X needed.
`scripts/integration.sh` is not part of CI: on a host with displayd running it starts two real
displays and checks that they have separate cookies, that xdotool in one leaves the other's
pointer alone, that xclip's clipboard is not shared, that VNC is loopback only, and that release
cleans up.
