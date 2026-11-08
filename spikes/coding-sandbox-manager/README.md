# Coding sandbox-manager (P0 spike)

A small HTTP service that gives each coding session one hardened gVisor container through the
Docker Engine API. The agent loop runs in Pim; the sandbox is a dumb workspace that can run
commands and hold files. Plain Node 22 ESM, no dependencies. Throwaway-quality, but tested.

## Run

```sh
MANAGER_TOKEN=$(openssl rand -hex 24) PROXY_ADMIN_TOKEN=$(openssl rand -hex 24) \
ALLOWED_IMAGES=registry.example/sandbox@sha256:... \
docker compose up -d --build
```

The compose file runs three services: `docker-socket-proxy` (the only one with the Docker
socket, allowing containers, exec, volumes, networks, images and info), `sandbox-manager`, and
`egress-proxy`. The host needs Docker with the gVisor runtime registered as `runsc`
(`runsc install`). Without it the manager refuses to start.

Run it without compose: `DOCKER_HOST=unix:///var/run/docker.sock MANAGER_TOKEN=... PROXY_ADMIN_TOKEN=... ALLOWED_IMAGES=... node src/main.js`
(`DOCKER_SOCKET=/path` also works; `tcp://host:port` is accepted for the socket proxy).

Tests: `node --test` (fake Docker over a unix socket, no daemon needed).
Live check: `scripts/live-smoke.sh` (needs a Docker daemon with runsc, `curl`, `jq`).

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MANAGER_TOKEN` | required | Bearer token for the API (compared in constant time) |
| `ALLOWED_IMAGES` | required | Comma-separated exact image references; digest-pin them in production |
| `PROXY_ADMIN_TOKEN` | required | Shared with the egress-proxy admin endpoint |
| `DOCKER_HOST` / `DOCKER_SOCKET` | `/var/run/docker.sock` | Daemon address |
| `DOCKER_ROOT` | `/var/lib/docker` | Directory whose filesystem is checked for free space |
| `MIN_FREE_PCT` | 15 | Refuse create (507) below this free-disk percentage |
| `MAX_CONCURRENT` | 4 | Refuse create (429) at this many sessions |
| `IDLE_MIN` | 30 | Reaper removes sessions idle longer than this |
| `PROBE_IMAGE` | `busybox:1.36` | Image for the startup gVisor probe |
| `WORKSPACE_TMPFS` | 0 | `1` makes `/workspace` a size-capped tmpfs volume (enforces `diskMiB`, but counts against RAM) |
| `EGRESS_PROXY_CONTAINER`, `EGRESS_PROXY_URL`, `EGRESS_PROXY_ADMIN_URL` | `egress-proxy`, `http://egress-proxy:3128`, `http://egress-proxy:3129` | Where the proxy lives |

`DOCKER_SOCKET` (compose only, default `/var/run/docker.sock`) is the host path of the Docker
socket mounted into `docker-socket-proxy`; set it for rootless or non-default installs.

A separate data disk is optional: point Docker's `data-root` at it and set `DOCKER_ROOT_HOST`
in compose to a directory on that disk, so disk governance measures the right filesystem.

## API

All routes except `/health` need `Authorization: Bearer $MANAGER_TOKEN`.

- `GET /health` gives `{runsc, freeDiskPct, sessions}`.
- `POST /sessions {sessionId, image, limits:{cpu,memMiB,diskMiB,pids}, egressAllow:[host]}`.
  Idempotent on `sessionId` (201 on create, 200 when it exists, 409 if the parameters differ).
  `egressAllow` takes hostnames or `*.suffix`.
- `GET /sessions/:id`, `DELETE /sessions/:id` (removes container, volume and network).
- `POST /sessions/:id/exec {cmd:[...], cwd?, timeoutMs, stdin?}` gives
  `{stdout, stderr, exitCode, timedOut, truncated}`. Output is capped at 10 MiB per stream.
- `PUT|GET /sessions/:id/files?path=` reads or writes raw bytes (cap 32 MiB). Relative paths are
  under `/workspace`.

Limits: `cpu` 0.1–4, `memMiB` 64–8192, `diskMiB` 64–20480, `pids` 16–2048.

## Security model

- **gVisor is mandatory.** Startup checks that `/info` lists `runsc` and that a probe container
  (`--runtime=runsc`, `true`) succeeds, otherwise the process exits non-zero. Every session
  container sets `Runtime=runsc`; nothing falls back to runc. `/health` re-reads `/info`.
- **Template only.** `src/template.js` builds the Docker create calls from a fixed template plus
  validated numbers. Request bodies with any other field (binds, privileged, capAdd,
  networkMode, devices, ...) are rejected, and the image must be in `ALLOWED_IMAGES`. The
  container runs as 10001 with a read-only rootfs, all capabilities dropped, no-new-privileges,
  pid, memory and CPU limits, a 64 MiB `/tmp` tmpfs, a per-session labelled volume at
  `/workspace`, no binds and no published ports.
- **Egress.** Each session has its own `internal: true` network, which has no route out. The
  `egress-proxy` is attached to it and to an outbound network. The session gets
  `HTTP(S)_PROXY=http://egress-proxy:3128`. The manager registers the session's IP on that
  network and its allowlist through the proxy's admin endpoint (`PUT /allow/<ip>`, bearer
  token). The proxy keys decisions on the source IP, allows only `CONNECT host:443` to listed
  hosts, denies IP literals and `localhost`, resolves the name itself, refuses it if any
  answer is loopback, RFC1918, link-local (169.254/16), CGNAT or an IPv6 equivalent, and dials
  the address it checked.
- **No DNS in sessions.** Docker's embedded DNS is unavailable under gVisor, so sessions reach the
  proxy by IP (read from the proxy's address on the session network) and have no name
  resolution; the proxy resolves hostnames.
- **Docker API exposure.** The socket is mounted only into `docker-socket-proxy`. Allowing
  `POST` on containers means the proxy cannot stop a privileged create; refusing that is the
  manager's job (`template.js`), not the proxy's. The manager
  holds no socket, so a compromised manager can reach only the allowed API groups.
- **Confinement of files.** Paths with `..` are rejected before reaching Docker. Symlink
  escapes are caught by resolving the path with `realpath -m` inside the container, in the same
  shell command that then reads or writes.
- **Governance.** Create is refused below `MIN_FREE_PCT` free disk or at `MAX_CONCURRENT`
  sessions. A reaper removes sessions idle beyond `IDLE_MIN`. At start the manager rebuilds its
  registry from the `pim.coding.session` labels and removes half-created leftovers.

## Known gaps

- **Docker-socket-proxy filters by URL path, not body.** A manager bug could still ask for a
  privileged container; only `template.js` prevents that. A stricter option is an authorization
  plugin or rootless Docker.
- **`diskMiB` is not enforced by default.** A plain volume is bounded only by the free-disk
  check. `WORKSPACE_TMPFS=1` enforces it but uses RAM. Real quotas need an xfs project-quota
  data disk. Images must also ship `/workspace` owned by 10001 for the plain volume to be writable.
- **Exec timeout kills every process of the sandbox user** (`kill -9 -1` in a second exec),
  because a Docker exec cannot be signalled by its PID, which is wrong under gVisor anyway. Execs
  run one at a time per session, and background processes die on a timeout.
- Proxy allowlists live in the proxy's memory. If the proxy restarts, sessions get no egress
  until the manager restarts (reconcile re-registers them).
- The proxy supports HTTPS (CONNECT :443) only; plain `http://` returns 405. The admin port is
  reachable from session networks and is protected only by its token.
- Sessions can reach each other's proxy, but not each other's containers (separate networks).
  A session shares the proxy's CPU and file descriptors with all others; there is no rate limit.
- A container that is stopped or OOM-killed is not restarted; its session is removed at the next
  reconcile. The manager has no per-session ownership check beyond the single bearer token.
- Image pulls have no timeout, and the manager does not verify digests itself.
- No streaming exec, no TTY, no file listing, no metrics.
