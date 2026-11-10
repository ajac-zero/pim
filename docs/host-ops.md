# Host operations

The admin's majordomo can look after the machine a self-hosted Pim runs on: read its stats and services' logs, restart a service, change how many sandboxes run at once, deploy a new version and roll back. It asks a small daemon on the host, `hostopsd`, which runs a fixed list of operations, and, with your approval each time, one command you can read first. How the queue, the checks and the audit log work is in [reference.md](reference.md#host-operations).

## What the majordomo can do

| Tool | Operation |
| --- | --- |
| `hostops_stats` | The host's stats, as the daemon reports them |
| `hostops_logs` | A service's latest log lines (`lines`, 1 to 500, 100 by default) |
| `hostops_restart` | Restart a service |
| `hostops_set_slot_limit` | How many sandboxes the sandbox manager runs at once (`maxConcurrent`, 1 to 16) |
| `hostops_deploy` | Deploy a git ref (`ref`, `origin/main` by default). The daemon checks the new version and rolls back on its own when it fails, which reports `rolled_back` |
| `hostops_rollback` | Go back to a commit (`commit`, 7 to 40 hex digits) |
| `hostops_status` | Whether the daemon has a credential, when it was last seen, its version and commit, and its queue |
| `hostops_op` | An operation by its id, once it ends |
| `hostops_exec` | One shell command, with your approval for that call: see [Running a command](#running-a-command) |

The services are `sandbox-manager`, `egress-proxy`, `docker-socket-proxy` and `hostopsd`. Each call waits up to 100 seconds for its operation to end. A deploy or rollback can take longer: the call then answers with the operation's id, and the majordomo follows it with `hostops_op`. One deploy or rollback runs at a time.

Except `hostops_exec`, nothing asks first: there is no approval to wait for, so the majordomo can run them from a schedule at night. What keeps them safe is that only these operations and arguments exist, that a failed deploy rolls back, and that every request, refused or not, is in the audit log.

## Running a command

`hostops_exec` runs one command, such as `df -h /` or `journalctl -u docker -n 50`, for the things the fixed operations don't cover. It is a risky action: **every call asks you**, and the request shows the exact command. There is no always-approve, no permission that skips asking, and no timeout that approves; denying it runs nothing. Without you at the app, an unanswered request just waits, so a schedule can't run commands at night.

- **As whom.** `/bin/sh -c <command>` as the user `hostopsd` runs as, in its home directory, with only `PATH`, `HOME` and `LANG` in its environment (none of the daemon's or the manager's credentials). There is no root or sudo variant, no stdin and no terminal, and one command per call (a shell can still chain several in it).
- **Limits.** `timeoutSeconds` (1 to 300, 60 by default): at the timeout the command's whole process group is killed and the result says `timedOut`. `maxOutputBytes` (1 to 65536, the most by default): stdout and stderr together, in the order written; when there is more, the *last* part is kept and `truncated` is true. A command that ends leaves nothing running behind it.
- **Secrets.** Before the output goes anywhere, the daemon takes out the values of its own credentials and of every secret-looking variable in its environment files (`MANAGER_TOKEN`, `HOSTOPS_TOKEN` and the like), bearer tokens, vendor key shapes (`sk-…`, `ghp_…`, `AKIA…`, JWTs, private key blocks), values assigned to names like `password` or `api_key`, and long token-like runs. Pim redacts again before the audit log keeps anything. Redaction recognizes what it was given; a command that transforms a secret (say, base64 of a file) gets past it.
- **Enforcement.** Pim queues the command only when the majordomo's call comes with an approval you gave, in Pim's own records, for exactly that command and those limits, and each approval runs one command. The daemon never sees the approval: it takes the command only from an authenticated poll with its credential, and refuses any other argument.
- **Audit.** Settings → Deployment keeps the request (the command, and the approval it ran under) and, when the command ends, a row with the command, who approved it and when, the exit code, the duration, whether it timed out, and the last 3000 characters of its output.

The daemon runs as a member of the `docker` group, which is root on the host: a command can start a privileged container. Approve a command only when you would type it as root yourself.

## Who can use them

Only the majordomo of the admin's space. Other agents, the admin's included, aren't offered the tools or told about them, and if one reached them anyway it would be refused and the refusal kept in the audit log. Nobody can ask for an operation over the API, an MCP client or the web app, the admin included: the admin asks their majordomo, and for a command approves it.

## Setting up the daemon

The host enrolls its daemon by itself. The host shares a secret with Pim, `MANAGER_TOKEN` there and the secret `PIM_CODING_MANAGER_TOKEN` here. When `up.sh` runs, it sends that token to `POST /api/hostops/agent/enroll` and gets a new credential for the daemon, in return for no click in Settings:

- The token is compared in constant time. A wrong or missing one is refused with 401, and counted against the sign-in attempts limit of its address. A Pim without the secret answers 404.
- The credential is made as the admin's is: random, shown only in the answer (201, `{ "token": ... }`), with only its digest kept, and the one before it stops working. The audit log keeps the enrollment as `credential.enroll` by the `host`, and never the token.
- Enrolling again rotates the credential, so the host can do it on every run. The new credential shows in Settings, where the admin can revoke it.

**A revoke sticks.** While the newest credential was revoked in Settings, enrollment is refused with 403 `{ "error": "revoked" }`, and the audit log keeps the refusal. The admin turns it back on with **Issue credential**; after that the host can enroll again.

To do it by hand instead, say for a host that isn't set up with `up.sh`:

1. In Settings → Deployment → Host operations, choose **Issue credential**. The credential is shown once, with a copy button, and with the installer's command for this Pim.
2. On the host, in Pim's checkout, run the installer with this Pim's URL, and give it the credential:

   ```sh
   sudo ./sandbox-manager/hostopsd/install.sh --url https://pim.example.com
   ```

3. Once the daemon polls, the section shows when it was last seen, its version and its commit.

**Rotate credential** issues a new one in place of the old, which stops working at once; **Revoke credential** stops it with none in its place, and operations then wait, and expire after 10 minutes. The audit log below lists the newest 100 rows: when, who (the majordomo, the daemon, the host, the admin, or a refused caller), the operation and its arguments, and how it went.
