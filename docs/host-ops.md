# Host operations

The admin's majordomo can look after the machine a self-hosted Pim runs on: read its stats and services' logs, restart a service, change how many sandboxes run at once, deploy a new version and roll back. It asks a small daemon on the host, `hostopsd`, which runs only a fixed list of operations. How the queue, the checks and the audit log work is in [reference.md](reference.md#host-operations).

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

The services are `sandbox-manager`, `egress-proxy`, `docker-socket-proxy` and `hostopsd`. Each call waits up to 100 seconds for its operation to end. A deploy or rollback can take longer: the call then answers with the operation's id, and the majordomo follows it with `hostops_op`. One deploy or rollback runs at a time.

Nothing asks first: there is no approval to wait for, so the majordomo can run them from a schedule at night. What keeps them safe is that only these operations and arguments exist, that a failed deploy rolls back, and that every request, refused or not, is in the audit log.

## Who can use them

Only the majordomo of the admin's space. Other agents, the admin's included, aren't offered the tools or told about them, and if one reached them anyway it would be refused and the refusal kept in the audit log. Nobody can ask for an operation over the API, an MCP client or the web app, the admin included: the admin asks their majordomo.

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
