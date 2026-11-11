# Cloudflare Containers workspaces (S1a)

The `cloudflare` workspace backend now uses Cloudflare Containers directly, with
`workspace-agentd`, rather than the unwired Sandbox SDK adapter. The stored compute
kind stays `cloudflare-sandbox` so existing admin settings survive; its display name
is Cloudflare Containers. Both `WorkspaceContainer` and `WorkspaceCatalog` bindings
are required for A0's `usable` summary. Adding the admin provider alone cannot
turn on coding tools. Switching it off removes it from the workspace registry.

`src/coding/workspace/cloudflare.ts` is the client. `cloudflare-container.ts` holds
the lifecycle controller, its Durable Object, a durable listing and the egress
entrypoint. The client reuses Compose's agentd file and streaming exec protocol,
including reconnect by exec id, and explicitly kills an exec on cancellation.
The old SDK adapter remains in `cloudflare-sandbox.ts` for its existing callers
and tests, but is no longer selected by production compute configuration.

## Deploying

`wrangler.jsonc` has the `containers` entry, the `WorkspaceContainer` and `WorkspaceCatalog`
bindings and their migration, so a fork deploys to any account with no edits and no manual
image step. The image is built from `workspace-agentd/Dockerfile` (stage `cloudflare`, chosen
by the `FLAVOR` build variable) by `wrangler deploy`, which pushes it to the deploying
account's own Cloudflare registry. Workers Builds does this on every push to `main`. The
sandbox manager builds the same Dockerfile with its default stage, `compose`.

Deploys run on Workers Builds and need no setup. To deploy from a machine, it needs Docker
(`wrangler deploy` builds the image) and a linux/amd64 build. Each account's Durable Object
namespaces are capped at 500 and every Workers Builds preview of a branch takes about 8, so
sweep stale previews now and then (`scripts/sweep-preview-aliases.sh --apply`). Add Cloudflare
Containers in Settings → Compute and check its health. Start a disposable thread, write a
file, suspend and resume, and verify files, egress denial, token replacement and usage
accounting before turning it on for other people.

## Lifecycle and limits

A session has one named Durable Object; its specification and snapshot handles
live in Durable Object storage. The catalog contains only session IDs. Suspending
captures the root filesystem before destroying the container; resuming runs the
entrypoint again from the snapshot with no old processes. Snapshot failure keeps
the live container intact. Unexpected container loss reports `gone` and a fresh
create rebuilds rather than claiming an older snapshot contains current files.
`destroy({ keepVolume: true })` suspends; a full destroy erases stored handles.
Checkpoints are scoped to the workspace that made them. Environment caching is
not supported yet.

[Cloudflare snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)
require the `durable_object` scheduling policy, cover the root filesystem rather
than separately mounted volumes, retain no processes and expire after 30 days
without a restore. They are tied to an image version. Keep `/workspace` on that
filesystem and plan image upgrades and retention accordingly. Do not claim
indefinite disk persistence or cross-image restore.

A0 checks the person's quota before creating or resuming a workspace and records
running stretches in the Gallery ledger. Suspension ends a stretch; resuming
starts another. The thread's heartbeat enforces the compute session cap and
releases usage on failure. The provider does not maintain a second usage counter.
CPU, memory and disk are passed as native container resources; process count is
not separately enforced. The durable-object scheduling policy does not accept
`max_instances`; use A0 quotas to bound running workspaces and the account's platform limits as the final ceiling.

The native inactivity timeout is thirty minutes and is renewed by `keepAlive`. It is only a safety net: an idle thread gives its slot back after ten minutes, which suspends the workspace with a snapshot, and the next turn resumes it from that snapshot.
Unexpected stops lose changes since the last snapshot. The provider does not
promise transparent recovery from those losses.

## Egress

Containers start with Internet access disabled. Each allowed target gets HTTP
and HTTPS intercepts bound to that target. The handler checks the URL against both
the connection target and the latest policy, refuses nonstandard ports, and
injects only into HTTPS requests with a matching normalized path. Redirects are
returned for a new policy check. Removed targets still fail closed through old
intercepts; no policy or injection credentials are put in the container.
The policy, including gateway and broker tokens in `Saved.spec.egress.inject`,
is persisted in the workspace's own Durable Object storage. These credentials
are thread-scoped and expire; they are replaced when access is refreshed and
removed with the workspace on full destruction. Expiration invalidates a token
even if its stored value remains until replacement or deletion. They do not live
only in Worker memory. After resume, the thread refreshes broker access with
`setEgress`; CLI gateway access is refreshed before its harness starts.
The entrypoint installs Cloudflare's mounted CA then starts agentd as uid 10001.
[Cloudflare's outbound intercept documentation](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
explains the CA and connection-target/Host distinction.

Tests use a fake remote service for client conformance and a fake native API for
lifecycle failures. These do not prove image startup, snapshot availability,
network interception or billing against a live Cloudflare account.

Compose has no native injection. It writes a short-lived, read-only broker
credential to `/workspace/.config/pim/git/credential.json` (mode 0600) and installs
a URL-scoped Git credential helper beside it. Both files are excluded from
Compose environment snapshots. See [in-workspace Git access](coding-environment.md#in-workspace-git-access).
