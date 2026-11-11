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

## Deploy safety: disabled in the shared config

**There is deliberately no `containers` entry, no container bindings and no v8
migration in `wrangler.jsonc`.** Exporting classes does not provision containers.
The ordinary production build has no new Docker requirement.

Pim production deploys use Cloudflare Git integration (Workers Builds). The
repository's `.github/workflows/ci.yml` only installs dependencies and runs checks;
it does not build or publish images or deploy the Worker. `package.json` builds
the web app with `pnpm build` and deploys with `wrangler deploy`. Wrangler's own
`build.command` also builds only `web/`. `docs/instance.md` describes Workers
Builds previews using `wrangler preview`; those must remain separate from
production resources. Nothing checked into this repository proves Docker is
available in Workers Builds. A Dockerfile `image` entry would make production
deploys depend on it, so none is installed here.

An operator must enable Containers in a separate, reviewed deployment configuration
and keep the normal Git build on the shared configuration until the new deployment
path has been verified. Do not deploy `wrangler.preview.jsonc`.

1. On a Docker-capable machine, from the repository root, build the shared image
   and Cloudflare variant:

   ```sh
   docker build --platform linux/amd64 -t pim-workspace:local workspace-agentd
   docker build --platform linux/amd64 -t pim-workspace-cloudflare:local -f workspace-agentd/Dockerfile.cloudflare workspace-agentd
   ```

2. In a private deployment copy of the production config, add these entries to
   `durable_objects.bindings` and append the migration after v7:

   ```json
   { "name": "WorkspaceContainer", "class_name": "WorkspaceContainer" }
   { "name": "WorkspaceCatalog", "class_name": "WorkspaceCatalog" }
   { "tag": "v8", "new_sqlite_classes": ["WorkspaceContainer", "WorkspaceCatalog"] }
   ```

3. In that copy, use this container entry only on the Docker-capable release
   runner (the paths assume the config is at the repository root):

   ```json
   "containers": [{
     "name": "coding-workspaces",
     "class_name": "WorkspaceContainer",
     "scheduling_policy": "durable_object",
     "images": {
       "base": {
         "dockerfile": "./workspace-agentd/Dockerfile.cloudflare",
         "build_context": "./workspace-agentd"
       }
     }
   }]
   ```

   Keep Workers Builds on the unchanged shared config. To use it for container
   releases later, publish the image separately using
   [Cloudflare image management](https://developers.cloudflare.com/containers/guides/image-management/),
   replace the whole `base` object with `{ "image": "<published-registry-digest>" }`,
   and prove in a staging build without Docker that Wrangler resolves it without
   building or pulling through Docker. A registry reference alone is not treated
   here as proof that every Wrangler release path is Docker-free.
4. Run `pnpm exec wrangler types --config wrangler.containers.jsonc` and
   `pnpm typecheck`, then `pnpm exec wrangler deploy --config wrangler.containers.jsonc`
   from the release runner (using that filename for the private config). Do not repeat production bindings
   in preview configuration. Add Cloudflare Containers in Settings → Compute and
   check its health. Start a disposable thread, write a file, suspend and resume,
   and verify files, egress denial, token replacement and usage accounting before
   enabling it for other people. No live deployment was performed for S1a.

The private deployment config and image registry identity belong outside this
public repository. Do not add account IDs, deployment hostnames or credentials.

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

The native inactivity timeout is ten minutes and is renewed by `keepAlive`.
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
