# Coding workspaces on Cloudflare Sandbox

**Status: not applied.** The backend in `src/coding/workspace/cloudflare.ts` is finished and tested against an in-memory stand-in, but nothing in `wrangler.jsonc` enables it. Deploying Pim today needs no Containers billing and does not create any sandbox. Everything below is what an owner does to switch it on.

## What it is

`CloudflareSandboxProvider` implements the `WorkspaceProvider` contract (`src/coding/workspace/types.ts`) with one Cloudflare Sandbox per coding session. It imports no `@cloudflare/*` package. It takes `sandboxFor(sessionId)` and a structural `SandboxLike`, the few methods of the Sandbox SDK it calls (`exec`, `readFile`, `writeFile`, `mkdir`, and optionally `createBackup`, `restoreBackup`, `destroy`). `@cloudflare/sandbox` is therefore not a dependency yet; add it when wiring the binding.

- **Create** ensures the sandbox and `/workspace`. Cloning the repository is the coding thread's job, run through `exec`.
- **Files** are all under `/workspace`. Paths are checked lexically, then resolved with `realpath -m` inside the sandbox, so `..` and symlinks that leave the root are refused. The image needs GNU `realpath`, `find` and `rm`.
- **Exec** shell-quotes the argument list, streams stdout and stderr, and ends with one exit event. Timeout and abort both abort the SDK call and end the stream at once; a sandbox failure becomes stderr plus an exit with `signal: "SANDBOX_ERROR"`.
- **Stop and start.** With backups, stop saves `/workspace` to R2 and destroys the container; start restores it. Without backups, stop only marks the workspace stopped and refuses commands; the container sleeps by itself after `sleepAfter`, and its disk is not guaranteed to survive that.
- **Snapshots** use `createBackup` and `restoreBackup` on `/workspace`. `capabilities.snapshot` is true only when the provider is given `backup`.
- **Destroy** deletes the container; with `keepVolume` and backups the files are saved and come back when the session is created again.
- **Capacity** is 2 workspaces at once unless `maxConcurrent` says otherwise.
- Which workspaces exist is remembered per provider instance. After a restart `get(ref)` reopens a workspace if `/workspace` exists in its sandbox; `list` shows only workspaces seen since.
- Disk, memory, CPU and process limits in `WorkspaceSpec.limits` are not enforced by this backend; they come from the container's instance type. Wall-clock limits are the caller's.

## Egress allowlist (design)

`capabilities.egressAllowlist` is false unless `applyEgress(sandbox, allowedHosts)` is supplied. The intended hook uses the SDK's outbound interception: a handler that runs in the Worker for every outbound HTTP(S) request from the container, compares the request's hostname to the session's allowlist (exact match or a `*.` suffix), and answers 403 for anything else. Git and package registries then work only for hosts a thread was granted, and a broker can add credentials in the handler so the container never holds them. The hook is called with each workspace's `spec.egress.allow` at creation. Traffic that is not HTTP(S) must be blocked by the container's network settings; the hook does not cover it.

## What the owner must enable (not applied)

1. Put the account on **Workers Paid** and enable **Containers**. Containers are billed for memory, CPU and disk while running, plus Durable Object and R2 use. A sandbox that is idle past `sleepAfter` stops billing compute; backups cost R2 storage until their TTL.
2. Add an image, for example `deploy/sandbox/Dockerfile`:

   ```dockerfile
   FROM docker.io/cloudflare/sandbox:<version>
   RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep build-essential python3 \
       && rm -rf /var/lib/apt/lists/*
   # Add the language toolchains threads need, such as Node and pnpm.
   ```

   The base image carries the sandbox shim that the SDK talks to; keep its version in step with the `@cloudflare/sandbox` package.
3. Add to `wrangler.jsonc` (**do not merge until Containers billing is on**):

   ```jsonc
   "containers": [
     { "class_name": "Sandbox", "image": "./deploy/sandbox/Dockerfile", "instance_type": "standard-1", "max_instances": 2 }
   ],
   "durable_objects": { "bindings": [ /* existing, */ { "name": "Sandbox", "class_name": "Sandbox" } ] },
   "migrations": [ /* existing, */ { "tag": "sandbox-v1", "new_sqlite_classes": ["Sandbox"] } ]
   ```

   and `export { Sandbox } from "@cloudflare/sandbox";` in the Worker entry. For backups add an R2 bucket binding as the SDK documents. Run `pnpm types` afterwards.
4. Install `pnpm add @cloudflare/sandbox` and construct the provider where coding threads pick a backend:

   ```ts
   import { getSandbox } from "@cloudflare/sandbox";
   new CloudflareSandboxProvider({ sandboxFor: (id) => getSandbox(env.Sandbox, id), backup: { ttlSeconds: 7 * 86400 } });
   ```

   Keep `max_instances` and `maxConcurrent` equal, so Pim refuses new workspaces before Cloudflare does.

## Not verified against the real SDK

The method names and option shapes in `SandboxLike` (`exec` with `stdin`, `signal`, `onOutput`; `readFile` with `encoding: "base64"`; `createBackup({ dir, ttl })`; `destroy`) come from the SDK documentation, not from running it. Check them when wiring the binding; an adapter function is the place to absorb differences.
