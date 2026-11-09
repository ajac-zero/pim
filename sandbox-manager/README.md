# Coding sandbox-manager

A small HTTP service that gives each coding session one hardened gVisor container through the
Docker Engine API. The agent loop runs in Pim; the sandbox is a workspace that can run commands
and hold files. Inside each container runs [workspace-agentd](../workspace-agentd/README.md),
which does the commands and file operations; the manager creates and governs the containers and
forwards its API to each session's agentd. Plain Node 22 ESM, no dependencies.

## Run

The deployer installs Docker and gVisor on the host and registers gVisor as the `runsc` runtime
(`runsc install`, then restart Docker). Neither is installed by this service. Without `runsc` the
manager refuses to start.

```sh
MANAGER_TOKEN=$(openssl rand -hex 24) PROXY_ADMIN_TOKEN=$(openssl rand -hex 24) \
AGENTD_TOKEN_SECRET=$(openssl rand -hex 32) \
docker compose up -d --build
```

The compose file builds `pim-workspace:local` from `../workspace-agentd` (the default and only
allowed sandbox image unless `ALLOWED_IMAGES` says otherwise) and runs three services:
`docker-socket-proxy` (the only one with the Docker socket, allowing containers, volumes,
networks, images and info, but not exec), `sandbox-manager`, and `egress-proxy`.

Run it without compose: `DOCKER_HOST=unix:///var/run/docker.sock MANAGER_TOKEN=... PROXY_ADMIN_TOKEN=... HOST=127.0.0.1 node src/main.js`
(`DOCKER_SOCKET=/path` also works; `tcp://host:port` is accepted for the socket proxy). On the
host the manager reaches each session's agentd through Docker's bridge, so leave
`MANAGER_CONTAINER` unset, and listen on `127.0.0.1`: the host is reachable from session networks.

Tests: `node --test` (fake Docker over a unix socket and fake agentds; one suite runs the real
workspace-agentd as a local process). No Docker daemon needed.
Live check: `scripts/live-smoke.sh` (needs a Docker daemon with runsc, `curl`, `jq`).

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MANAGER_TOKEN` | required | Bearer token for the API (compared in constant time) |
| `PROXY_ADMIN_TOKEN` | required | Shared with the egress-proxy admin endpoint |
| `AGENTD_TOKEN_SECRET` | `MANAGER_TOKEN` | Key the per-session agentd tokens are derived from. Set it, so rotating `MANAGER_TOKEN` does not cut a restarted manager off from running sessions |
| `ALLOWED_IMAGES` | `pim-workspace:local` | Comma-separated exact image references; the first is the default. Each must run workspace-agentd as its entrypoint (build `FROM` the workspace image). Digest-pin them in production |
| `DOCKER_HOST` / `DOCKER_SOCKET` | `/var/run/docker.sock` | Daemon address |
| `DOCKER_ROOT` | `/var/lib/docker` | Directory whose filesystem is checked for free space |
| `MIN_FREE_DISK_PCT` | 15 | Refuse create (507, `low_disk`) below this free-disk percentage |
| `MAX_CONCURRENT` | derived | Refuse create (429, `capacity`) at this many live sessions. Default `clamp(min(cpus, floor((memGiB - 1) / 1.5)), 1, 8)`: 2 vCPU / 3 GiB gives 1, 4 / 16 gives 4 |
| `DEFAULT_DISK_MIB` | 5120 | Workspace quota when a create leaves out `limits.diskMiB` |
| `MAX_TOTAL_WORKSPACE_GB` | 100 | Refuse create (507, `workspace_quota`) when the quotas of live, starting and kept workspaces plus the new one exceed this many GiB. `0` turns it off |
| `DISK_QUOTA_MODE` | `auto` | `volume`, `measure` or `auto` (probe at start); see Disk governance |
| `DISK_CHECK_SEC` | 60 | How often every workspace is measured |
| `WORKSPACE_TMPFS` | 0 | `1` makes `/workspace` a size-capped tmpfs volume (quota mode `tmpfs`: enforced, but counts against RAM) |
| `IDLE_MIN` | 30 | Reaper removes sessions idle longer than this |
| `KEPT_VOLUME_DAYS` | 7 | Reaper removes kept workspace volumes older than this; `0` keeps them until deleted |
| `PROBE_IMAGE` | `busybox:1.36` | Image for the startup gVisor probe |
| `MANAGER_CONTAINER` | unset | This manager's container name, when it runs in Docker; it attaches itself to each session network to reach agentd. Compose sets `sandbox-manager` |
| `AGENTD_PORT` | 8787 | Port agentd listens on in the sandbox |
| `AGENTD_READY_MS` | 30000 | How long create waits for a new session's agentd to answer |
| `EGRESS_PROXY_CONTAINER`, `EGRESS_PROXY_URL`, `EGRESS_PROXY_ADMIN_URL` | `egress-proxy`, `http://egress-proxy:3128`, `http://egress-proxy:3129` | Where the proxy lives |
| `PORT`, `HOST` | 8080, `0.0.0.0` | Where the API listens |

`DOCKER_SOCKET` (compose only, default `/var/run/docker.sock`) is the host path of the Docker
socket mounted into `docker-socket-proxy`; set it for rootless or non-default installs.

A separate data disk is optional: point Docker's `data-root` at it and set `DOCKER_ROOT_HOST`
in compose to a directory on that disk, so disk governance measures the right filesystem.

## API

All routes except `/health` need `Authorization: Bearer $MANAGER_TOKEN`. Errors are
`{error: message, code?}` with the HTTP status.

- `GET /health` gives `{runsc, freeDiskPct, maxConcurrent, running, free, sessions}`.
- `POST /sessions {sessionId, image?, limits:{cpu,memMiB,diskMiB?,pids}, egressAllow:[host]}`.
  Idempotent on `sessionId` (201 on create, 200 when it exists, 409 if the parameters differ;
  defaults count as parameters). Answers once the session's agentd is up. `egressAllow` takes
  hostnames or `*.suffix`. Refusals: 429 `capacity`, 507 `low_disk`, 507 `workspace_quota`
  (`{reservedMiB, requestedMiB, maxTotalMiB}`), 502 `agentd_unreachable`.
- `GET /sessions/:id` gives the parameters with `{state: 'running', createdAt, lastUsedAt}`.
- `DELETE /sessions/:id` removes container, network and volume. `?keepVolume=1` keeps the
  workspace volume and answers `{deleted, keptVolume}`; creating the same `sessionId` again
  reuses it.
- `GET /sessions/:id/status` gives `{sessionId, state, reason, diskBytes, diskQuotaBytes,
  diskFreeBytes, activeExecs, quotaMode, measuredAt}`. `state` is `creating`, `running` or
  `stopped`; a stopped session has `reason` `over_disk_quota` or `kept_volume` and `keptAt`. For
  a running session it measures now; `error` is set if agentd did not answer. It does not count
  as use for the idle reaper.
- `POST /sessions/:id/exec {cmd:[...], cwd?, timeoutMs, stdin?}` gives
  `{stdout, stderr, exitCode, timedOut, truncated}`. Output is capped at 10 MiB per stream. A
  command that cannot start gives exit code 127, one killed by a signal 128 + its number, a
  timeout `exitCode: null`. Execs run concurrently.
- `PUT|GET|DELETE /sessions/:id/files?path=` writes, reads or deletes (`&recursive=1` for a
  directory). Writes are capped at 32 MiB and answer `{ok: true}`; reads stream raw bytes.
- `GET /sessions/:id/list?path=` (default `/workspace`) gives `[{name, type, size, mtimeMs}]`;
  `GET /sessions/:id/stat?path=` gives one such record. `type` is `file`, `dir` or `symlink`.

Paths are relative to `/workspace` or absolute under it; anything else, including a symlink that
leads out, is 403. A missing file is 404. Exec and file routes on a session stopped for its disk
quota give 409 `over_disk_quota`.

Limits: `cpu` 0.1–4, `memMiB` 64–8192, `diskMiB` 64–20480, `pids` 16–2048.

## Security model

- **gVisor is mandatory.** Startup checks that `/info` lists `runsc` and that a probe container
  (`--runtime=runsc`, `true`) succeeds, otherwise the process exits non-zero. Every session
  container sets `Runtime=runsc`; nothing falls back to runc. `/health` re-reads `/info`.
- **Template only.** `src/template.js` builds the Docker create calls from a fixed template plus
  validated numbers. Request bodies with any other field (binds, privileged, capAdd,
  networkMode, devices, ...) are rejected, and the image must be in `ALLOWED_IMAGES`. The
  container runs the image's entrypoint (agentd) as 10001 with a read-only rootfs, all
  capabilities dropped, no-new-privileges, pid, memory and CPU limits, a 64 MiB `/tmp` tmpfs, a
  per-session labelled volume at `/workspace`, no binds and no published ports.
- **agentd tokens.** Each container gets its own `AGENTD_TOKEN`:
  HMAC-SHA256(`AGENTD_TOKEN_SECRET`, sessionId + a random nonce). The nonce is a container
  label; the token is in no label, never logged, and recomputed after a restart. The token
  reaches agentd as a container environment variable, the only way agentd takes it, so anyone
  with Docker API access (`docker inspect`) can read it, as can code in the session through
  `/proc/1/environ` (the same user as agentd, so it gains nothing). agentd keeps it out of the
  environment of the commands it runs, so it does not show up in their output or logs. It
  protects agentd from everything else on the session network.
- **Reaching agentd.** Docker's embedded DNS does not work under gVisor, so the manager talks to
  agentd at the container's IP on the session network, port 8787. In compose the manager attaches
  itself to every session network for that; it refuses any request that arrives on its own
  address there, so a session cannot reach the manager's API.
- **Egress.** Each session has its own `internal: true` network, which has no route out. The
  `egress-proxy` is attached to it and to an outbound network. The session gets
  `HTTP(S)_PROXY=http://<proxy IP>:3128`, also passed with every exec so a re-attached proxy
  with a new address keeps working. The manager registers the session's IP on that
  network and its allowlist through the proxy's admin endpoint (`PUT /allow/<ip>`, bearer
  token). The proxy keys decisions on the source IP, allows only `CONNECT host:443` to listed
  hosts, denies IP literals and `localhost`, resolves the name itself, refuses it if any
  answer is loopback, RFC1918, link-local (169.254/16), CGNAT or an IPv6 equivalent, and dials
  the address it checked.
- **No DNS in sessions.** Sessions reach the proxy by IP and have no name resolution; the proxy
  resolves hostnames.
- **Docker API exposure.** The socket is mounted only into `docker-socket-proxy`. Allowing
  `POST` on containers means the proxy cannot stop a privileged create; refusing that is the
  manager's job (`template.js`), not the proxy's. Exec is not allowed at all. The manager
  holds no socket, so a compromised manager can reach only the allowed API groups.
- **Confinement of files.** Paths with `..` or outside `/workspace` are rejected before they
  reach agentd. agentd resolves every path (each component, and a write target's parent)
  inside the container and refuses symlink escapes. It needs no shell or coreutils.
- **Exec timeouts.** agentd runs each command in its own process group and on timeout (or when
  the manager drops the connection) kills that group only. If agentd itself stops answering, the
  manager drops the connection after the timeout plus 5 s.

## Disk governance

- **Per-session quota** (`limits.diskMiB`, default 5 GiB), enforced by one of three modes, picked
  at start and reported in status as `quotaMode`:
  - `volume`: the workspace volume is created with the local driver's `size` option, an XFS
    project quota, so writes beyond it fail with "disk quota exceeded". It needs Docker's
    data-root on XFS mounted with `pquota`. `auto` picks it when a probe volume with a size can
    be created. (`--storage-opt size` limits only a container's writable layer, which is
    read-only here, so it would not bound the workspace.)
  - `measure`: everywhere else. Every `DISK_CHECK_SEC` the manager reads `rootBytes` (the
    apparent size of every file under `/workspace`) from each agentd's `/status`. A session over
    its quota is stopped: its container and network are removed, its volume is kept, and status
    says `stopped` / `over_disk_quota`. A session can overshoot until the next check.
  - `tmpfs` (`WORKSPACE_TMPFS=1`): a size-capped tmpfs workspace, enforced but held in RAM.
- **Total.** Creates are refused with 507 `workspace_quota` when the quotas of all live,
  starting and kept workspaces plus the new one exceed `MAX_TOTAL_WORKSPACE_GB`, and with 507
  `low_disk` below `MIN_FREE_DISK_PCT` free disk. The capacity check, the total check and the
  slot reservation happen in one synchronous step, so concurrent creates cannot exceed them.
  Sessions already over a limit (after lowering it or a restart) are never killed; they only
  block new creates. The manager keeps no queue and does not retry; the Pim control plane owns
  queueing and decides when to retry after a refusal. Re-creating an existing `sessionId` is
  idempotent and never counts against the limits.
- **Kept volumes.** `DELETE ?keepVolume=1` and the quota stop keep the volume and record that in
  a marker volume (`pim-kept-<id>`, labels `pim.coding.kept` and `pim.coding.kept-info`), so a
  restarted manager knows about them. A plain `DELETE`, or the reaper after `KEPT_VOLUME_DAYS`,
  removes the volume and its marker.
- **Reaper.** Every 30 s it removes sessions idle beyond `IDLE_MIN` and expired kept volumes.

## Restarts

At start the manager rebuilds its registry from the `pim.coding.session` labels: running
containers become sessions again (their agentd tokens recomputed from the nonce label), marker
volumes become kept workspaces, and anything else labelled (a stopped container, a half-created
session's volume or network) is removed. It then attaches the egress proxy, and itself when it
runs in a container, to every live session network they are not on: a recreated container (for
example after `docker compose up` with a new image) has lost them. It re-registers every
allowlist with the proxy. Every 30 s it does that again, so a proxy that was recreated or
restarted while the manager kept running gets its networks and allowlists back too.

## Known gaps

- **Docker-socket-proxy filters by URL path, not body.** A manager bug could still ask for a
  privileged container; only `template.js` prevents that. A stricter option is an authorization
  plugin or rootless Docker.
- **The agentd token is visible in `docker inspect`.** Docker has no per-container secret store
  outside swarm. Anyone with Docker API access already controls every container.
- **`measure` mode is after the fact.** A session can write past its quota for up to
  `DISK_CHECK_SEC` (and as fast as the disk allows) before it is stopped; `MIN_FREE_DISK_PCT`
  is the backstop. The measure walks the whole workspace each time, which costs I/O on large
  trees. Resuming a kept volume in `volume` mode keeps the quota it was created with.
- Images must ship `/workspace` owned by 10001 (the workspace image does), so the new volume,
  which Docker fills from the image, is writable.
- The proxy supports HTTPS (CONNECT :443) only; plain `http://` returns 405. The admin port is
  reachable from session networks and is protected only by its token.
- Sessions can reach each other's proxy, but not each other's containers (separate networks).
  A session shares the proxy's CPU and file descriptors with all others; there is no rate limit.
- A container that is stopped or OOM-killed is not restarted; its session (volume included) is
  removed at the next start of the manager. The manager has no per-session ownership check
  beyond the single bearer token.
- Image pulls have no timeout, and the manager does not verify digests itself.
- No streaming exec and no TTY through the manager (agentd streams; the manager buffers to keep
  its API), and no metrics.
