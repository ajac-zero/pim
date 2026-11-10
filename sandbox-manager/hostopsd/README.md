# hostopsd

The host half of host operations: a small daemon on the Pim host (the machine that runs the
sandbox-manager stack from [`compose.yaml`](../compose.yaml)) that runs the operations the admin's
agent queues in Pim. The manager container cannot run git or docker compose, so deploying and
restarting the stack needs a process on the host. hostopsd dials out to Pim; nothing listens for
it. Plain Node 22 ESM, no dependencies.

## Install

On the host, from the Pim checkout the stack runs from, once the checkout has this directory:

```sh
cd ~/pim && git fetch origin && git checkout --detach origin/main && sudo sandbox-manager/hostopsd/install.sh --url https://YOUR-PIM-ORIGIN
```

It asks for the hostopsd token from Pim without echoing it (or reads it from `--token-file PATH`,
or from stdin when stdin is not a terminal; never from the command line). It then:

- creates the system user `hostopsd` and adds it to the `docker` group (and `systemd-journal`, so
  `logs hostopsd` can read its own journal);
- gives `hostopsd` read and write access to the checkout through ACLs (`setfacl`, package `acl`),
  which new files inherit, and traverse access to the directories above it, and marks the
  checkout a git `safe.directory` for it;
- finds the manager's environment (`MANAGER_TOKEN`, `PROXY_ADMIN_TOKEN`, ...) that `up.sh` and
  `docker compose` need: `--manager-env PATH`, else `sandbox-manager/.env`, else it copies the
  variables from the running `sandbox-manager` container into `/etc/hostopsd/manager.env`;
- writes `/etc/hostopsd/env` (mode 0640, `root:hostopsd`), installs
  `/etc/systemd/system/hostopsd.service`, enables and restarts it, and prints its status.

Run it again to change the URL, the token (give a new one) or the checkout; it keeps the rest.
To revoke access, revoke the token in Pim: hostopsd then logs that it was rejected and retries
every few minutes. `sudo systemctl disable --now hostopsd` stops it on the host.

hostopsd runs from the checkout (`ExecStart` points at `sandbox-manager/hostopsd/hostopsd.js`), so
a deploy that changes this directory makes it exit after reporting, and systemd starts the new
version. A change to `hostopsd.service` needs `install.sh` again.

The checkout is left on a detached HEAD after each deploy. To update by hand, use
`git fetch && git checkout --detach origin/main && sandbox-manager/up.sh` (or `git checkout main`
first to go back to the branch).

## Configuration

`/etc/hostopsd/env` (systemd passes it as the environment; the process environment wins over the
file when hostopsd is run by hand):

| Variable | Meaning |
| --- | --- |
| `HOSTOPS_URL` | Pim's origin, `https://` (plain `http://` only for localhost) |
| `HOSTOPS_TOKEN` | hostopsd's own credential, revocable in Pim |
| `PIM_CHECKOUT` | The checkout holding `sandbox-manager/` |
| `MANAGER_URL` | The manager's API, default `http://127.0.0.1:8080` |
| `MANAGER_ENV_FILE` | The manager's environment, passed to `up.sh` and `docker compose`; default `$PIM_CHECKOUT/sandbox-manager/.env` |
| `MANAGER_TOKEN` | Read from `MANAGER_ENV_FILE` unless set here |
| `NODE_BIN` | The Node.js the unit runs |
| `HOSTOPSD_STATE_FILE` | Default `/var/lib/hostopsd/state.json` |

`HOSTOPSD_HEALTH_TIMEOUT_MS` (120000), `HOSTOPSD_HEALTH_INTERVAL_MS` (2000),
`HOSTOPSD_BACKOFF_MIN_MS` (1000), `HOSTOPSD_BACKOFF_MAX_MS` (60000) and
`HOSTOPSD_UNAUTHORIZED_RETRY_MS` (300000) tune timing; the tests shorten them.

## Protocol

- **Poll:** `POST $HOSTOPS_URL/api/hostops/agent/poll` with `Authorization: Bearer $HOSTOPS_TOKEN`
  and `{agentVersion, commit, waitMs: 25000}` (`commit` is the checkout's full HEAD). 200 is
  `{op: {id, name, args, deadlineMs}}`, 204 is nothing to do. Errors back off exponentially with
  jitter up to a minute; a 401 is logged as a rejected (possibly revoked) credential and retried
  every 2.5 to 5 minutes.
- **Result:** `POST /api/hostops/agent/result` with `{id, ok, state, summary, data}`: `state` is
  `succeeded`, `failed` or `rolled_back`, `summary` at most 2000 characters, `data` an object of at
  most 64 KB. The result is written to the state file before it is sent and retried until Pim
  answers 2xx, so a crash does not lose it; no new op is taken while one is pending. A 400, 404,
  409, 410, 413 or 422 drops it (Pim will never take it).
- An op whose `deadlineMs` (milliseconds since the epoch) has passed when it arrives fails without
  running.

## Operations

Every op is validated again here ([`validate.js`](validate.js)); an unknown op, a missing or
malformed argument or any extra argument fails it before anything runs.

| Op | Args | What it does |
| --- | --- | --- |
| `stats` | none | CPUs, load, memory, swap, free disk of `/` and of Docker's data root (`docker info`), `docker system df`, containers and their states, the manager's `/health`, the checkout's commit, uptimes, hostopsd's version |
| `deploy` | `ref?` (`^[A-Za-z0-9._/-]{1,100}$`, default `origin/main`) | `git fetch origin`, resolves `ref`, requires a fast-forward from the current commit unless `ref` is a commit hash, checks it out detached, runs `up.sh`, then waits up to 120 s for `/health` to be ok at the new commit. On failure it checks out the previous commit, runs `up.sh` and checks health again: `rolled_back`, or `failed` if that fails too |
| `rollback` | `commit` (7 to 40 hex) | The same checkout, `up.sh` and health check for a commit that is an ancestor of HEAD or one an earlier deploy recorded; no second rollback when it fails |
| `restart` | `service`: `sandbox-manager`, `egress-proxy`, `docker-socket-proxy` or `hostopsd` | `docker compose restart <service>`; `hostopsd` exits after reporting and systemd restarts it |
| `logs` | `service` as above, `lines?` 1 to 500 (200) | `docker compose logs --no-color --tail N <service>`, or `journalctl -u hostopsd -n N`; redacted, last 60 KB |
| `set_slot_limit` | `maxConcurrent` 1 to 16 | `PUT $MANAGER_URL/config {maxConcurrent}` with `MANAGER_TOKEN`, then confirms it in `/health` |

The manager counts as healthy at a commit when `/health` answers 200, its `ok` is true (or, from a
manager without `ok`, `runsc` is true), and its `commit` (or `version`) is that commit's short hash.

**Lock and crash recovery.** One op runs at a time. A deploy or rollback is recorded in the state
file (`deploy`: kind, op id, previous and target commit, status, pid) before the checkout changes,
and that record is the deploy lock: while it is there no other deploy or rollback starts. When
hostopsd starts and finds one (it crashed or was stopped mid-deploy), it checks the manager: if it
is healthy at the target the op succeeded; otherwise it rolls a deploy back to the previous commit
(a rollback is only reported as failed), and reports the result under the op's id. Successful
deploys are kept in `deploys` (the last 50), which `rollback` accepts.

## Security

- **The docker group is root-equivalent.** Anyone who can talk to the Docker socket can start a
  privileged container that mounts the host's root filesystem. hostopsd runs as its own user in
  that group, so it is effectively root on the host. What limits it is the allowlist above, the
  argument checks, and a credential Pim can revoke. It runs no shell: every command is a fixed
  argv array through `spawn` without a shell, from a fixed directory, with a timeout that kills
  its process group. Refs and commits go to git as single arguments and cannot start with `-`.
- The token is never logged or passed to the commands hostopsd runs; `up.sh` and `docker compose`
  get only `PATH`, `HOME`, `BUILD_SHA` and the manager's environment. Log output and command errors
  in results are redacted: known secret values, `Bearer ...`, runs of 32 or more hex characters
  and base64-looking runs of 32 or more characters (with a digit and 16 characters without a
  separator, so paths and container names stay readable).
- The unit sets `NoNewPrivileges`, `ProtectSystem=full`, `PrivateTmp` and the kernel protections;
  it cannot protect `/home`, where the checkout usually is.
- The checkout's `origin` must be fetchable by `hostopsd` without credentials (the repository is
  public over https); the installer warns when it is not.

## Tests

`node --test` here (or in `sandbox-manager/`, which includes these). They run the daemon against a
fake Pim and a fake manager, with a real git repository cloned from a local origin, and wrappers
for git (which log and then run the real git), docker, journalctl and the checkout's `up.sh`
(see `support/`). No Docker or systemd needed.
