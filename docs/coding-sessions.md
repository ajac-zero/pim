# Sessions, keepalives and egress policy for workspace providers

Sandbox providers such as Cloudflare Sandbox, Daytona, E2B and Vercel cap how long a session lasts, stop a sandbox that sits idle, suspend one while keeping its files, and can enforce egress themselves. The `WorkspaceProvider` contract (`src/coding/workspace/types.ts`) says so in four capabilities, and a coding thread (`src/coding/thread-do.ts`) acts on them. Compose and Cloudflare declare the conservative values: no cap, no keepalive, no suspend, no injection.

## Capabilities

- `sessionMaxMin`: minutes before the backend ends a session; `null` for no limit.
- `keepAlive`: whether the backend needs to be told periodically that a workspace is in use. Activity inside the sandbox doesn't count.
- `suspendResume`: whether `suspend(ref)` works. It keeps the files and ends every process.
- `egressInjection`: whether the backend applies `spec.egress.inject` itself.

`resumeOrCreate(ref, spec)` brings a suspended workspace back, or makes one from the kept volume when it is gone, and either way starts a new session. `keepAlive(ref)` and `setEgress(ref, policy)` are the other two calls. Backends that can't suspend or inject throw `WorkspaceUnsupportedError`; their `resumeOrCreate` is the shared default in `workspace/egress.ts`. The conformance suite (`workspace/conformance.ts`) checks all of it, skipping what a backend's capabilities rule out, and the fake provider can play a capped, keepalive, injecting backend.

## What a thread does

- **Keepalive.** While a turn runs, the thread's heartbeat job (its alarm) calls `keepAlive` on a provider that needs it, every `keepAliveMs()` (a minute), and comes back early enough to do so. Between turns it pings nothing.
- **Session expiry.** Within `sessionMarginMs()` of the cap (a fifth of it, at most two minutes) the thread commits a checkpoint and autosaves, stops running commands, suspends the workspace (or, without `suspendResume`, lets go of it keeping its volume), resumes or makes a new one, restores the checkout, and the turn goes on. A pi turn's agent loop lives in the Durable Object, so only what ran in the sandbox is lost: its running commands are told they were stopped. A CLI harness's process dies with the session, so its turn is stopped and started again from its transcript, resuming the CLI's own session, as is any turn the move can't go on with (the provider refuses to resume, say). Moves happen while a turn runs; a session that ends between turns is found gone by the next one and handled as a lost workspace is.
- **Compute ledger.** The same job keeps the space's compute ledger (`src/compute-ledger.ts`) true: it ends the stretch of a workspace its provider lost, and stops one that reached the quota's session limit (`cap_at`). There is no second timer: `#schedule` brings the job forward to `cap_at`, so a session ends at the earlier of that and the provider's cap (`status().session.expiresAt`). A move to a new session ends the old stretch and begins a new one in one ledger step (`computeRenew`), after the quota is checked again, and the new stretch keeps the old one's end time: only continuing the thread begins a fresh limit; a refusal ends the turn and fails the thread with `compute_quota`, without a retry.
- **Status.** `status().session` has `startedAt`, `maxMin`, `expiresAt`, `keepAlive`, `state` (`active` or `continuing`), the number of `continuations`, and `last` (when, whether the workspace was `resumed` or `created`, or the turn `turn_restarted`). The thread's log has `session.continuing`, `session.continued` and `session.turn_restarted` events.

## Egress policy

`spec.egress` is an `EgressPolicy`: `allow` hostnames (`*.example.com` means subdomains) and `inject` rules, each a host, an optional path prefix and the headers to add. The existing allowlist is a policy with no rules, and `egressPolicy()` normalizes both: names lowercased, listed once, every injected host allowed. Rules for one host are kept apart by path, so the git broker's and the model gateway's tokens don't mix.

A thread asks `placeSecret()` where a secret goes. On a provider with `egressInjection` the rule goes to the provider (`setEgress`), and the workspace gets no secret: git sends no header, and a CLI's key is a placeholder. Anywhere else the secret is in the workspace's environment as before. The thread keeps the rules in memory only and never stores a secret. Backends without native injection can still enforce the allowlist; the rules are for backends that can add headers outside the sandbox.
