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

## Not here

- Wiring to the real vendor CLIs (`TurnPort`), `workspace-agentd`/`sandbox-manager` (`ComputeProvider`), S3 (`Objects`), the GitHub App/Gitea (`GitHost`) and `AmpHttpOrbClient` is by port. Tests use a scripted turn runner, a local-process sandbox, local bare repositories and `FakeOrbClient`; nothing contacts a real service.
- `PgPiLog` is the pi thread's fenced partition; running pi-durable on it is not done.
- The model gateway's HTTP route, the git broker's HTTP route, vault, Gitea OAuth and the `@pim/v2-contracts` bindings are not ported.

Tests run against a real PostgreSQL (`embedded-postgres`, started once by `test/global-setup.ts`): `pnpm --filter @pim/v2-forge test`.
