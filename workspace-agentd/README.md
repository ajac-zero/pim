# workspace-agentd

A small daemon that runs inside each Pim code workspace container and gives the backend (Docker Compose manager, Kubernetes) exec and file operations over authenticated HTTP. It has no dependencies beyond Node 20 or later and needs no GNU coreutils in the image.

## Run

```sh
AGENTD_TOKEN=secret AGENTD_ROOT=/workspace node server.mjs
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENTD_TOKEN` | required | Bearer token. agentd refuses to start without it. |
| `AGENTD_ROOT` | `/workspace` | Directory every path is confined to. |
| `AGENTD_PORT` | `8787` | Listen port. |
| `AGENTD_MAX_OUTPUT_BYTES` | `4194304` | Cap on total exec output. |
| `AGENTD_MAX_BODY_BYTES` | `67108864` | Cap on a request body (file upload or exec request); larger gets 413. |
| `AGENTD_DETACH_GRACE_MS` | `600000` | How long an exec with an `id` keeps running without a client, and how long its events are kept after it ends. |

## Image

`docker build -t pim-workspace workspace-agentd` builds a Node 22 image with git, ripgrep, build-essential and tini, a non-root user (uid 10001), a `/workspace` volume, and agentd as the entrypoint. Run it with `-e AGENTD_TOKEN=…`. The Dockerfile has not been built in CI yet.

## Protocol

Every route requires `Authorization: Bearer <token>` (compared in constant time); otherwise 401. Errors are `{"error": "code", "message": "…"}`.

- `GET /health` → `{ok: true, version}`
- `GET /status` → `{diskUsedBytes, diskFreeBytes, rootBytes, activeExecs, uptimeSec}`
- `POST /exec` with `{cmd: string[], cwd?, env?, timeoutMs, stdin?}` → `200 application/x-ndjson`: lines `{"type":"stdout"|"stderr","data":"…"}`, then exactly one `{"type":"exit","code","signal","timedOut"}`. The command runs in its own process group with no shell, with agentd's environment minus `AGENTD_TOKEN`, plus `env`. On timeout, or when the client disconnects, the whole group gets SIGTERM, then SIGKILL after 2 s. Output beyond the cap is cut, `{"type":"stderr","data":"[output truncated]"}` is sent, and the group is killed. If the command cannot start (for example, not found), the response is `400 spawn_failed` instead of a stream. When the main process exits, leftover processes in its group are killed.
  With an `id` (8–128 letters, digits, `-` or `_`; `409 exec_exists` while one with that id is kept), the exec outlives its connection: when the client disconnects, the command keeps running for `AGENTD_DETACH_GRACE_MS` and is killed only if no client attaches again by then. Its events are kept until that long after it ends. This is what lets a turn keep running while the manager restarts.
- `GET /exec/<id>?after=<n>` → the same NDJSON stream of that exec, from its event `n` on (the number of events the client already has; default 0), then its new events and its exit. A client that attaches takes over from the one before it. `404 exec_not_found` when no such exec is kept.
- `DELETE /exec/<id>` → `{ok: true}`, and kills the exec's process group as a timeout does.
- `GET /file?path=` → raw bytes
- `PUT /file?path=&mode=0644` → raw body, parent directories created, written to a temp file and renamed. A full disk or exceeded quota is `507 disk_full`
- `DELETE /file?path=[&recursive=1]` → files, symlinks (the link itself), and with `recursive=1` directories
- `GET /list?path=` → `[{name, type: "file"|"dir"|"symlink", size, mode, mtimeMs}]` (`mode` is the permission bits)
- `GET /stat?path=` → one such record, or 404

Paths are absolute or relative to the root. Anything that resolves outside it, including `..`, absolute paths elsewhere and symlinks pointing out (at any component, and for write targets' parents), gets `400 path_escape`. Writing to a symlink writes its target, which must also be inside the root.

## Test

```sh
cd workspace-agentd && node --test
```

Exec timeouts apply to the detached process group, not just the shell. At the
command's `timeoutMs`, agentd sends SIGTERM, then SIGKILL after two seconds if
needed, and returns an exit event with `timedOut: true`. If the main process
exits but children keep stdout or stderr open, a 200 ms drain grace kills the
remaining group so the response can finish. The exec tests exercise both a
shell and child ignoring SIGTERM and a child holding stdout open after its
parent exits. These guarantees cover the command's process group; a process
that deliberately creates a separate session is outside that group.
