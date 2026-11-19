# @pim/v2-forge

Forge is Pim's coding control plane on PostgreSQL (`pim_forge`, migrations `0400`–`0499`), in place of `CodingThreadDO` and `CodingSchedulerDO`. Thread IDs, `/coding/<id>` URLs, Amp `T-…` lookups and `coding_start` replays resolve exactly as before (`identity.ts`).

## What is here

- `store.ts`: threads, inbox, events, outbox. A thread is stepped under a lease; every write names the lease epoch, so a worker that lost the thread is refused (`fenced`).
- `scheduler.ts`: pools and slots as advisory-locked transactions: FIFO queue with a 30-minute deadline and one requeue, a 2-minute idle slot grace, the 3-failure/5-minute half-open breaker (`@pim/coding/pool-breaker`), per-person login locks, environment-build deduplication, and separate concurrency, compute-minute and USD quotas.
- `harnesses.ts`: one capability descriptor per harness. The five do not share resume, cost, checkpoint or push semantics.
- `worker.ts`: family A/B turns (`pi`, `claude-code`, `codex`, `mistral-vibe`: a lost run settles `interrupted` and resumes at most `MAX_RESUMES` times, with no premature `turn_ended`) and family C (`amp`: records the orb handle before anything else, adopts a live orb after a restart without a second start or a re-sent prompt, mirrors messages by cursor, syncs turns started in Amp, mirrors attachments to Objects).
- `authz.ts`: coding grants (`coding:start|steer|abort|push|pr|merge`) per user, tenant or agent, scoped by repository and pool, re-checked before every privileged action. A permission is not an approval (`requiresApproval`); an agent cannot approve its own request. No pool or Amp credential is `CapabilityUnavailableError` (503), a missing grant is `ForbiddenError` (403).
- `tokens.ts`: `pimgit_` and `pimgw_` HMAC tokens (at most 12 hours, one repository). Whether they still work is read from PostgreSQL on each use, so abort, archive and account suspension cut them off at once.
- `compute.ts`: the provisioning intent is committed before a provider is called; an ambiguous create is reconciled by tag and never repeated inside the settle window.
- `forge.ts`: the facade REST routes and agent tools both call. `archive`, compute teardown, artifact deletion and remote branch deletion are separate operations; cancellation is `requested`, `cancelled` or `uncertain`.
- `stall.ts`: evidence-based two-stage stall wakes, deduplicated as `stall:<source>:<stage>:<progress>`.

## Contracts

Forge depends on `@pim/v2-contracts`: `codingThreadId`, the `ForgeCompletionWake` / `ForgeStallWake` envelopes (every outbox wake is parsed with them; operation ids with a colon are made safe in the wake id only), `ObjectStore` (`Objects`), the `Authorizer` (`ForgeAuthorizer`, deciding on the origin of a delegation chain, with `StandingApproval` as an auditable table), the error classes, and the shared `public.pim_schema_migrations` ledger (migrations `0400`–`0404`, band-validated). `toContractDescriptor` computes the contracts' capability shape from Forge's honest descriptor; it differs from `HARNESS_CAPABILITIES` only where `CONTRACT_DIVERGENCES` lists, and a test pins that list. Amp cost is captured as dollar deltas when the orb client's `usage` reports them; otherwise spend stays 0 and unmetered. Row-level security on `pim_current_owner_id()` is not enabled: Forge's workers step every owner's threads, so isolation is by `owner_id` in each query.

## Adapters (real, not test ports)

- `workspace-agent.ts`: `WorkspaceAgentComputeProvider` puts `@pim/coding`'s `WorkspaceProvider` (`ComposeWorkspaceProvider`, the sandbox-manager client whose sandboxes run workspace-agentd) behind Forge's tag contract. The tag is the thread id, which is the manager's session id.
- `cli-port.ts`: `CliTurnPort` runs claude-code, codex and mistral-vibe turns with `@pim/coding`'s `HarnessRunner`, command builders and parsers: the person's login restored from the vault and written back, their login lock, API-key mode, the session's cost as a delta, messages and test runs recorded, a dead worker's run finished off by `recoverRun`.
- `pi-storage.ts`, `pi-port.ts`: a real pi-durable 1.5.2 `Harness` per `pi` thread on `PgPiStorage` (an event-sourced Storage: the in-memory engine validates each commit, `forge_pi_commits` keeps it under the lease epoch, opening replays the log), with the coding tools in the sandbox and their journal in `forge_tool_journal`.
- `amp-adapter.ts`: `AmpHttpOrbClient` with `PgAmpStore` and the person's Amp key from the vault, and an attachment fetcher that checks magic bytes. A steer is never sent twice or dropped silently: it is `sending`, then `sent` or `uncertain` (settled against Amp's own transcript, resent only by `Forge.retrySteer`). A start whose answer was lost waits in `waiting_input / orb_start_uncertain`.
- `provider-git.ts`, `gitops.ts`: `ProviderGitHost` and `providerUpstream` over `@pim/coding`'s GitHub and Gitea providers. A merge (any thread, Amp's included) runs in a throwaway clone: fast-forward, else rebase, never force. `git-checkout.ts` makes the sandbox's checkout through the broker.
- `vault.ts`, `gitea.ts`: `ForgeVault` (a `CodingVault` on `EnvelopeCrypto`, `PgVaultBackend` behind `CachingVaultBackend`) and the Gitea OAuth (PKCE) connection with refresh.

## HTTP (`src/http/`)

Portable `(req: Request) => Promise<Response | null>` handlers, composed with `compose`; the host supplies `authenticate` (Gate owns sessions and tokens). `rest.ts` (`/api/coding/threads*`, repo settings, `/api/admin/coding/pools`), `git-broker.ts` (smart HTTP in front of the git host), `gateway.ts` (`pimgw_` model gateway with budget, caps and usage charging), `vault.ts` (`/api/coding/vault/*`, `/api/coding/gitea/*`).

## The worker, row-level security and the force-push rule

- `ForgeWorker.dispatch` starts steps without waiting (a turn takes minutes; a lease is renewed while one runs), `reap` gives back a sandbox idle for two minutes (autosave, delete, free the slot; the next turn provisions again and restores from the bundle), and `ForgeScheduler.sweep` promotes waiters and expires the 30-minute deadlines. `packages/v2-server/src/forge-assembly.ts` assembles all of it from the environment and runs the loops (`startForgeLoops`: a poll, a `pg_notify('pim_forge_work')` wake, the stall check).
- Migration `0406` turns on row-level security for `pim_gate` on the owner-keyed tables (`forge_threads`, `forge_vault`, `forge_repo_settings`) and on what hangs off a thread. A Gate request runs under `scopedDb(db, owner)` (`Forge.scopedTo`, `Credentials` with `scoped`, the handlers' `scope`), so a query that forgot its owner returns nothing. The worker and maintenance roles see every owner's rows. Grants, quotas and standing approvals are the admin's records and carry no owner policy.
- The broker takes a branch's first push as it is and an update only as a fast-forward: the pack goes up under a staging ref, the host says whether the old tip leads to the new commit (`GitHost.isAncestor`), and only then does the branch move (an empty pack, guarded by the old tip) and the staging ref go. A force push, a delete, another branch and the default branch are refused.

## Not here

- The vendor CLIs' own sign-in flow (`/login`): the routes call a `LoginFlows` port a deployment wires and answer 503 without it.
- A pool-level environment build/snapshot (`/environment/rebuild`): the scheduler deduplicates builds, but nothing builds one yet.
- The gateway's catalog prices: it takes a `price` function and defaults to the family's dearest.
- A production `EnvelopeCrypto`, the `@pim/v2-contracts` Gate wiring and row-level security.

Tests run against a real PostgreSQL (`embedded-postgres`, started once by `test/global-setup.ts`): `pnpm --filter @pim/v2-forge test`. The sandbox manager is the `@pim/coding` fake manager, vendor CLIs are its fixtures, Amp and Gitea are local `http.createServer` mocks, and the git host is `git http-backend`.
