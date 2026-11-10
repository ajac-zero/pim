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

1. In Settings → Deployment → Host operations, choose **Issue credential**. The credential is shown once, with a copy button, and with the installer's command for this Pim.
2. On the host, in Pim's checkout, run the installer with this Pim's URL, and give it the credential:

   ```sh
   sudo ./sandbox-manager/hostopsd/install.sh https://pim.example.com
   ```

3. Once the daemon polls, the section shows when it was last seen, its version and its commit.

**Rotate credential** issues a new one in place of the old, which stops working at once; **Revoke credential** stops it with none in its place, and operations then wait, and expire after 10 minutes. The audit log below lists the newest 100 rows: when, who (the majordomo, the daemon, the admin, or a refused caller), the operation and its arguments, and how it went.
