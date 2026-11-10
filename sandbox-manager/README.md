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
networks, images, info and system (`/system/df`, which sizes the cache volumes), but not exec),
`sandbox-manager`, and `egress-proxy`. The manager keeps workspace snapshots in the
`manager-data` volume at `/data`.

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
| `DATA_DIR` | `/data` | Where snapshots and the cache index are kept. Put it on Docker's data-root filesystem (compose uses a named volume), so free-disk gating sees it |
| `SNAPSHOT_MAX_GB` | 4 | Largest snapshot, measured as the uncompressed tar; a bigger one fails with 413 `snapshot_too_large` |
| `SNAPSHOT_CACHE_PCT` | 20 | Share of `MAX_TOTAL_WORKSPACE_GB` that snapshots and cache volumes together may use before the least recently used are evicted |

`DOCKER_SOCKET` (compose only, default `/var/run/docker.sock`) is the host path of the Docker
socket mounted into `docker-socket-proxy`; set it for rootless or non-default installs.

A separate data disk is optional: point Docker's `data-root` at it and set `DOCKER_ROOT_HOST`
in compose to a directory on that disk, so disk governance measures the right filesystem.

## API

All routes except `/health` need `Authorization: Bearer $MANAGER_TOKEN`. Errors are
`{error: message, code?}` with the HTTP status. `:id` is a `sessionId` (`[a-z0-9][a-z0-9-]{0,62}`).

| Route | Body / query | Answer |
| --- | --- | --- |
| `GET /health` | (no token) | `{runsc, freeDiskPct, maxConcurrent, running, free, sessions, snapshotBytes, cacheBytes, snapshotCount}` |
| `GET /sessions` | | Every known session, sorted by id: `[{sessionId, image, limits, egressAllow, state, ...}]` |
| `POST /sessions` | `{sessionId, image?, limits:{cpu,memMiB,diskMiB?,pids}, egressAllow?, userId?, repo?, hasRuntimeSecrets?, restoreFrom?:{key}}` | 201 created, 200 already there (or a stopped one resumed with new parameters), 409 different parameters |
| `POST /snapshots` | `{userId, repo, key, sessionId}` | 201 the new snapshot, 200 the one already there for `key` |
| `GET /snapshots` | `?userId=&repo=` (`repo` optional) | The user's snapshots, newest first: `[{key, repo, size, sha256, format, contentBytes, excluded, createdAt, lastUsedAt}]` |
| `DELETE /snapshots/:key` | `?userId=` | `{deleted}`; 409 `snapshot_in_use` while it is being restored |
| `GET /sessions/:id` | | The session: `state` `running`, `creating` or `stopped`; 404 otherwise |
| `DELETE /sessions/:id` | `?keepVolume=1` | `{deleted}`; with `keepVolume` also `keptVolume`, and the volume stays |
| `POST /sessions/:id/stop` | | The session, now `stopped`; does nothing if stopped already |
| `POST /sessions/:id/start` | | The session, now `running`; does nothing if running already |
| `GET /sessions/:id/status` | | `{sessionId, state, reason, diskBytes, diskQuotaBytes, diskFreeBytes, activeExecs, quotaMode, measuredAt}` |
| `POST /sessions/:id/exec` | `{cmd:[...], cwd?, timeoutMs, stdin?, env?}` | `{stdout, stderr, exitCode, timedOut, truncated}` |
| `POST /sessions/:id/exec/stream` | same as exec | `application/x-ndjson` ExecEvents |
| `PUT /sessions/:id/file` | `?path=&mode=0644`, raw body | `{ok: true}` |
| `GET /sessions/:id/file` | `?path=` | raw bytes |
| `DELETE /sessions/:id/file` | `?path=&recursive=1` | `{ok: true}` |
| `GET /sessions/:id/list` | `?path=` (default `/workspace`) | `[{name, type, size, mode, mtimeMs}]` |
| `GET /sessions/:id/stat` | `?path=` | `{name, type, size, mode, mtimeMs}` |

`/sessions/:id/files` is the older spelling of `/file` and still works.

**Sessions.** A create answers once the session's agentd is up. Defaults: `image` is the first
of `ALLOWED_IMAGES`, `limits.diskMiB` is `DEFAULT_DISK_MIB`, `egressAllow` is empty; they count as
parameters for the idempotency check. `egressAllow` takes hostnames or `*.suffix`. Create and
start are refused with 429 `capacity`, 507 `low_disk`, 507 `workspace_quota`
(`{reservedMiB, requestedMiB, maxTotalMiB}`) or 502 `agentd_unreachable`.

**States.** A session list entry or `GET /sessions/:id` has `state` and, when the container is
gone, `reason`, `keptAt` and `keptVolume`:

| `state` | `reason` | Meaning |
| --- | --- | --- |
| `creating` | | Its container is starting |
| `running` | | `createdAt`, `lastUsedAt` |
| `stopped` | `stopped` | Stopped through `/stop`: container and network removed, volume kept. `/start` (or a create with the same id) brings it back with the same files |
| `stopped` | `over_disk_quota` | Stopped by the manager in `measure` mode; start it again the same way |
| `gone` | `kept_volume` | Deleted with `keepVolume`: only in the list and in status; `GET /sessions/:id`, stop and start give 404; a create with the same id reuses the volume |

Stop removes the container (its processes die) and frees its `MAX_CONCURRENT` slot; its disk
quota stays reserved. The state survives a manager restart (see Kept volumes).
`/status` measures a running session now (`error` is set if agentd did not answer) and does not
count as use for the idle reaper.

**Exec.** Each command runs in its own process group with agentd's environment, the proxy
variables and `env` (names `[A-Za-z_][A-Za-z0-9_]*`, string values). `timeoutMs` is 1–900000 (15 minutes: a repository's setup script and the coding tools' longest command).
The buffered `/exec` caps each stream at 10 MiB (`truncated`); a command that cannot start gives
exit code 127, one killed by a signal 128 + its number, a timeout `exitCode: null`.
`/exec/stream` answers as soon as the command starts, with one JSON object per line:
`{type: "stdout"|"stderr", data}` as output arrives, then exactly one
`{type: "exit", code, signal, timedOut}`. A command that cannot start gives a stderr line and
`{type: "exit", code: 127}`. If the client disconnects, the manager closes its request to agentd,
which kills the command's process group. If agentd goes silent past the timeout plus 5 s, the
stream ends with `{type: "exit", code: null, signal: "SIGKILL", timedOut: true}`. Execs run
concurrently. Exec and file routes on a stopped session give 409 `session_stopped` or
`over_disk_quota`.

**Files.** Paths are relative to `/workspace` or absolute under it; anything else, including a
symlink that leads out, is 403 `path_escape`. A missing path is 404 `not_found` with a message
starting "no such file or directory". Writes create parent directories, replace the file
atomically, are capped at 32 MiB (413), and take `mode` as octal permission bits (default 0644).
A write the disk or quota cannot hold is 507 `disk_full`: agentd reports it from the filesystem
in `volume` and `tmpfs` modes, and in `measure` mode the manager refuses a write that would take
the measured workspace (re-measured when older than 5 s) over its quota. Deleting a directory
needs `recursive=1` (otherwise 409). `stat` describes a symlink itself rather than its target;
`type` is `file`, `dir` or `symlink`.

Limits: `cpu` 0.1–4, `memMiB` 64–8192, `diskMiB` 64–20480, `pids` 16–2048.

Coding threads start from the defaults in `src/coding/thread-do.ts` (4096 MiB of memory), then apply
per-repository overrides (`REPO_LIMIT_OVERRIDES`, keyed by lowercase `owner/name`; `ajac-zero/pim` gets
6144 MiB), then any limits the caller passed.

The workspace image has pnpm preinstalled (pinned by `PNPM_VERSION`), and `npm install -g` writes to
`/home/workspace/.npm-global`. npm and pnpm honor the egress proxy environment; corepack does not, so
it is not used.

**Environment caching.** A create with `userId` and `repo` mounts that pair's dependency cache
volume and can restore a snapshot; see Environment caching.

## Environment caching

**Snapshots.** `POST /snapshots` archives a running session's `/workspace` (HOME is `/workspace`,
so the tools' own directories such as `~/.cache` and `~/.local` are in it) through Docker's
archive API into `DATA_DIR/snapshots/<hash of userId>/<key>.tar.zst` (`.tar.gz` where Node has no
zstd). `key` is 16-128 lowercase hex characters, computed by the caller (for example from the
lockfiles); the same `(userId, key)` returns the snapshot already there, and concurrent requests for
one share a single creation. The session must have been created with the same `userId` and `repo`
(otherwise 403 `forbidden` or 409 `repo_mismatch`) and without `hasRuntimeSecrets` (409
`runtime_secrets`), and free disk must be above `MIN_FREE_DISK_PCT` (507 `low_disk`).
- **What is left out:** credentials in the home directory (`.npmrc`, `.netrc`, `.git-credentials`,
  `.pypirc`, `.yarnrc.yml`, `.ssh`, `.aws`, `.docker`, `.kube`, `.gnupg`, `.azure`, `.config/gh`,
  `.config/gcloud`, cargo credentials, the coding harnesses' sign-ins, shell histories), every
  `.env*` in the home directory and its dot-directories (not in a checkout), devices, fifos, and
  symlinks that point outside `/workspace`. Every `.git/config` is rewritten without the user and
  password of http(s) URLs and without `extraheader` lines. `excluded` counts the entries left out.
  The manager never adds secrets to a session; a caller that gives one secrets says so with
  `hasRuntimeSecrets: true` at create, which is kept in the session's labels.
- **Writes are atomic:** the tarball is written to a temporary file, flushed and renamed, then its
  metadata (`<key>.json`, with `sha256`) is written the same way and makes it exist. A failure
  removes both; after a crash the next start removes temporary files and tarballs without
  metadata.
- **Restore:** `POST /sessions` with `restoreFrom: {key}` (and `userId`, `repo`) checks the snapshot
  is that user's for that repo (404 `snapshot_not_found`), verifies its sha256 (422
  `snapshot_corrupt`, and the snapshot is deleted), and extracts it through Docker's archive API
  into the new, not yet started container with `copyUIDGID`, so every file belongs to the sandbox
  user. Each entry is checked first: no absolute path, no `..`, no symlink out of `/workspace`, no
  entry beneath a symlink, no hardlink except to an earlier file, no device or other special file,
  and no setuid, setgid or sticky bit (422 `snapshot_invalid`). A failed restore removes the new
  workspace. A resumed session keeps its own files and ignores `restoreFrom`. The session shows
  `restoredFrom`.
- **Isolation:** every lookup is by `(userId, key)`, and `userId` is required to list, restore and
  delete, so a user never sees another's snapshots; the same key is a different snapshot per user.

**Cache volumes.** A session with `userId` and `repo` mounts the volume `pim-cache-<hash>` of that
pair at `/caches` and gets `PNPM_STORE_DIR` (and `npm_config_store_dir`) `/caches/pnpm`,
`npm_config_cache` `/caches/npm`, `CARGO_HOME` `/caches/cargo`, `CARGO_TARGET_DIR`
`/caches/cargo-target`, `PIP_CACHE_DIR` `/caches/pip` and `UV_CACHE_DIR` `/caches/uv`. Every session
of one user and repo shares it, and no other user's does. It outlives the sessions (it carries
`pim.coding.cache`, not the session label) until GC evicts it. The image must ship `/caches` and
those subdirectories owned by 10001 (the workspace image does), so Docker fills a new volume with
them.

**Accounting and GC.** Snapshot sizes and cache volume sizes (read from `/system/df`) are reported
by `/health` and added to the reserved total that `MAX_TOTAL_WORKSPACE_GB` limits. The GC runs with
the reaper every 30 s, and right away when a snapshot is created over the cap. It keeps the newest
2 snapshots per `(userId, repo)`, deletes snapshots unused (not restored) for 7 days, then, while
snapshots and caches together exceed `SNAPSHOT_CACHE_PCT` of the total, evicts whichever snapshot
or cache was used least recently. A snapshot being restored and the cache volume of a live or
starting session are never deleted.

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
- **Kept volumes.** `/stop`, `DELETE ?keepVolume=1` and the quota stop keep the volume and record that in
  a marker volume (`pim-kept-<id>`, labels `pim.coding.kept` and `pim.coding.kept-info`), so a
  restarted manager knows about them. A plain `DELETE`, or the reaper after `KEPT_VOLUME_DAYS`,
  removes the volume and its marker.
- **Reaper.** Every 30 s it removes sessions idle beyond `IDLE_MIN` and expired kept volumes,
  and collects snapshots and cache volumes (see Environment caching).

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
- Images must ship `/workspace` and `/caches` owned by 10001 (the workspace image does), so the
  new volumes, which Docker fills from the image, are writable.
- A cache volume has no quota of its own: a session can fill it past its `diskMiB`. Its size counts
  toward the total and is evicted once no session mounts it; `MIN_FREE_DISK_PCT` is the backstop.
- Snapshots leave out symlinks that point outside `/workspace`, such as a virtualenv's
  `bin/python -> /usr/bin/python3`, so a restored virtualenv has to be recreated.
- Only a running session can be snapshotted. Snapshot sizes count once written; one being written
  can take free disk below `MIN_FREE_DISK_PCT`, up to `SNAPSHOT_MAX_GB`.
- The proxy supports HTTPS (CONNECT :443) only; plain `http://` returns 405. The admin port is
  reachable from session networks and is protected only by its token.
- Sessions can reach each other's proxy, but not each other's containers (separate networks).
  A session shares the proxy's CPU and file descriptors with all others; there is no rate limit.
- A container that is stopped or OOM-killed is not restarted; its session (volume included) is
  removed at the next start of the manager. The manager has no per-session ownership check
  beyond the single bearer token.
- Image pulls have no timeout, and the manager does not verify digests itself.
- No TTY and no metrics.
- A stopped session stays reserved against `MAX_TOTAL_WORKSPACE_GB` and is removed, files and
  all, by the reaper after `KEPT_VOLUME_DAYS`.
