# hostopsd

The host half of host operations: a small daemon on the Pim host (the machine that runs the
sandbox-manager stack from [`compose.yaml`](../compose.yaml)) that runs the operations the admin's
agent queues in Pim. The manager container cannot run git or docker compose, so deploying and
restarting the stack needs a process on the host. hostopsd dials out to Pim; nothing listens for
it. Plain Node 22 ESM, no dependencies.

## Install

There is nothing to install by hand. The usual update command, run as your normal user from the
Pim checkout, installs and updates hostopsd:

```sh
git pull && sandbox-manager/up.sh
```

After the stack is up, `up.sh` checks whether hostopsd is installed and current (the installed
`install.sh`, unit, Pim URL and checkout match this checkout, and the unit is running). If not, it
runs [`install.sh`](install.sh) through `sudo` (it asks for your password when there is a terminal,
and uses `sudo -n` when there is none). That is the one time root is needed: creating the
`hostopsd` system user, installing its systemd unit and giving it access to the checkout. If `sudo`
is not available, `up.sh` prints the single command to run and still succeeds. Failing to install
hostopsd never fails `up.sh`; the manager stack comes first. When up to date, or when run as
`hostopsd` itself (a host-ops deploy runs `up.sh` that way), it needs no root and changes nothing.

**Pim's origin** is `HOSTOPS_URL` from the environment, else the one installed in
`/etc/hostopsd/env`, else `HOSTOPS_URL` in `sandbox-manager/.env`, else `https://pim.ajac-zero.com`.

**The credential** is not pasted from anywhere. `install.sh` enrolls: it sends `POST
/api/hostops/agent/enroll` with the manager's `MANAGER_TOKEN` and stores the credential Pim returns
only in `/etc/hostopsd/env` (never printed, never on a command line). It enrolls again only when
there is no credential or Pim rejects the installed one (401 on a poll); running it again otherwise
keeps the credential. If the admin revoked hostopsd in Settings, Pim answers 403: the unit is
installed but left stopped, `up.sh` does not ask again, and the installer says so. After
re-enabling it in Settings, run `sudo sandbox-manager/hostopsd/install.sh`.

`install.sh` also:

- creates the system user `hostopsd` and adds it to the `docker` group (and `systemd-journal`, so
  `logs hostopsd` can read its own journal);
- gives `hostopsd` read and write access to the checkout through ACLs (`setfacl`, package `acl`),
  which new files inherit, and traverse access to the directories above it, and marks the
  checkout a git `safe.directory` for it;
- finds the manager's environment (`MANAGER_TOKEN`, `PROXY_ADMIN_TOKEN`, ...) that `up.sh` and
  `docker compose` need: `--manager-env PATH`, else `sandbox-manager/.env`, else it copies the
  variables from the running `sandbox-manager` container into `/etc/hostopsd/manager.env`;
- finds the Node.js the unit runs: `--node PATH`, else the invoking user's nvm (root's PATH does
  not see it), else `/usr/local/bin/node`, `/usr/bin/node` or the `/opt/hostopsd/node` an earlier
  run left, and when the host has none at all it installs the official Node.js 22 LTS tarball in
  `/opt/hostopsd`, verifying its SHA256 against `SHASUMS256.txt` from the same download. A node
  under a home directory is copied to the root-owned `/opt/hostopsd/node` (mode 0755) so the
  `hostopsd` user can execute it;
- writes `/etc/hostopsd/env` (mode 0640, `root:hostopsd`) and `/etc/hostopsd/installed`, a
  world-readable note of which installer and unit are installed that `up.sh` compares (no secret),
  installs `/etc/systemd/system/hostopsd.service`, enables and restarts it;
- verifies the credential end to end, by reading the daemon's journal for it polling Pim, and
  prints one summary line such as `hostopsd: enrolled with Pim, running and polling https://...`.

It is an internal helper and stays runnable: `--url`, `--checkout`, `--manager-env`,
`--manager-url`, `--node`, and `--token-file PATH` (or `-` for stdin) to install a credential you
already have instead of enrolling. To revoke access, revoke it in Pim: hostopsd then logs that it
was rejected and retries every few minutes. `sudo systemctl disable --now hostopsd` stops it on the
host.

hostopsd runs from the checkout (`ExecStart` points at `sandbox-manager/hostopsd/hostopsd.js`), so
a deploy that changes this directory makes it exit after reporting, and systemd starts the new
version. A change to `hostopsd.service` or `install.sh` is picked up by the next `up.sh`, which runs `install.sh` again.

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
`HOSTOPSD_IDLE_TIMEOUT_MS` (600000) and `HOSTOPSD_IDLE_INTERVAL_MS` (5000),
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
| `deploy` | `ref?` (`^[A-Za-z0-9._/-]{1,100}$`, default `origin/main`) | `git fetch origin`, resolves `ref`, requires a fast-forward from the current commit unless `ref` is a commit hash, checks it out detached, runs `up.sh`, then waits up to 120 s for `/health` to be ok at the new commit. Before it recreates the manager it waits, polling `/health`, until the manager runs no sessions (up to 10 minutes, then goes ahead and says so), because recreating it kills the threads in them; `restart` of `sandbox-manager` waits the same way On failure it checks out the previous commit, runs `up.sh` and checks health again: `rolled_back`, or `failed` if that fails too |
| `rollback` | `commit` (7 to 40 hex) | The same checkout, `up.sh` and health check for a commit that is an ancestor of HEAD or one an earlier deploy recorded; no second rollback when it fails |
| `restart` | `service`: `sandbox-manager`, `egress-proxy`, `docker-socket-proxy` or `hostopsd` | `docker compose restart <service>`; `hostopsd` exits after reporting and systemd restarts it |
| `logs` | `service` as above, `lines?` 1 to 500 (200) | `docker compose logs --no-color --tail N <service>`, or `journalctl -u hostopsd -n N`; redacted, last 60 KB |
| `exec` | `command` (1 to 2000 characters), `timeoutSeconds?` 1 to 300 (60), `maxOutputBytes?` 1 to 65536 (the most) | `/bin/sh -c <command>` as hostopsd's own user, in its home directory, with only `PATH`, `HOME` and `LANG`; no stdin, no terminal, no sudo. Stdout and stderr come back together, redacted, cut to their last `maxOutputBytes` (`truncated`). At the timeout the process group is killed. Exit 0 is `succeeded`, anything else (or a timeout) `failed`, with `exitCode`, `timedOut`, `durationMs` and `output` in the data. Pim queues it only under the person's approval for that exact command |
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
  its process group. The one exception is `exec`, which runs the one command the person approved
  in Pim, through `/bin/sh -c`; with the docker group above, that command can do anything root
  can, so Pim asks the person for every one. It never runs as root, and its command is kept out
  of this daemon's log. Refs and commits go to git as single arguments and cannot start with `-`.
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

`node --test` here (or in `sandbox-manager/`, which includes these). `test/install.test.js` runs
`up.sh` and `install.sh` with fake `curl`, `sudo`, `systemctl` and friends on `PATH`. The rest run the daemon against a
fake Pim and a fake manager, with a real git repository cloned from a local origin, and wrappers
for git (which log and then run the real git), docker, journalctl and the checkout's `up.sh`
(see `support/`). No Docker or systemd needed.
