# Agent-hosted coding threads (orbs)

An **agent-hosted** thread runs in the vendor's cloud, not a sandbox Pim owns. `providerKind: "agent-hosted"` distinguishes it from a workspace thread. Pim starts and polls the agent through `OrbClient` (`src/coding/orb/types.ts`), with no workspace, commands, environment or scheduler slot. Old thread records remain workspace threads.

## The interface

`OrbClient` is the provider-neutral seam: idempotent `start`, `state`, paginated `messages`, optional `steer`, `stop` and `usage`. Capability flags declare which optional verbs work; unsupported calls throw `OrbUnsupportedError`. Authentication, unreachable clouds and deleted threads have typed errors too. Usage is null when unavailable, never invented as zero.

The conformance suite (`src/coding/orb/conformance.ts`) checks the contract. Capabilities and script hooks gate cases a provider cannot exercise, with explicit skip reasons. `FakeOrbClient` is an in-memory implementation for loop tests.

## Amp over HTTPS

`AmpHttpOrbClient` (`src/coding/orb/amp-http.ts`) uses only fetch from the Worker/DO to Amp's HTTPS External API. It never starts a CLI, opens a WebSocket, or holds a sandbox slot. The **workspace Amp harness is retired**; `harness: "amp"` now defaults to agent-hosted Orbs (amp-http) with no sandbox slot. Old threads that used the workspace Amp harness remain readable. See [coding-amp.md](coding-amp.md) for legacy information.

The bearer is **the same saved credential as the coding page's Amp Connect field**: `codingVault.loadApiKey(space, "amp")`. There is no second PAT or Connect UI. A missing token waits in `login_required`. A 401/403 also waits there and says:

> Amp rejected the saved token for the HTTP API; a PAT with amp.api:threads:create + amp.api:threads:view is needed, save it in the same Amp Connect field

Tokens and response bodies are never included in client errors or logs. Reconnecting through the existing field resumes threads waiting for the login.

### Creation and retries

Start sends only `project: "namespace/name"`, `message` and optional `agentMode` / `title` to `POST /api/v2/threads`. A durable reservation precedes POST, and its thread handle is stored before any poll.

Amp documents no caller idempotency key. After a network failure, a 5xx, or a crash before the handle is saved, Pim **cannot know whether creation succeeded**. It refuses to POST again under that key and asks the person to check Amp. This trades automatic recovery of an ambiguous start for never double-starting. Definitive authentication and rate-limit rejections can be retried. A saved handle is returned on retries, including after eviction.

The DO alarm polls every 30 seconds. Metadata with an unset state keeps polling; idle ends the turn only after working was seen or a 60-second creation grace period. Approval means needs-attention on Amp. Amp may retry its own errors, so an error must persist for two minutes before Pim fails the turn. Progress and retry backoff survive eviction. 429/5xx and network errors back off with a bounded attempt count and honor Retry-After; ambiguous creation is never resent.

Messages are cursor-paged defensively. Their raw JSON, including versions and unfamiliar fields, is kept in DO storage as well as mirrored into Pim's transcript. The mirror keeps its last message id so a restart does not repeat messages.

### Unsupported controls

**Steering and stopping are not supported by Amp's HTTP API yet.** The capability flags are false and calls throw typed `OrbUnsupportedError`. Pim hides the composer and Stop control for HTTP threads. API/tools return `unsupported` with that explanation rather than silently queuing a message or pretending to cancel. Archiving in Pim is local only; its confirmation says the Amp run continues. DELETE is never used: deleting a thread is not cancelling it.

Other orb clients may support steering and stopping; the fake exercises queued steering and idempotent stopping in the generic loop tests.

### Optional usage

**Cost is n/a with a PAT.** The usage endpoint requires M2M OAuth, not a PAT. Optional machine credentials can be provisioned internally with `CodingVault.saveAmpM2m(space, {clientId, clientSecret}, expectedVersion)`. They are sealed in a separate `amp-http-m2m` entry, never listed as a Connect field, and never replace the saved Amp token. Only when that entry exists does the factory enable usage.

The client exchanges those credentials at `https://auth.ampcode.com/oauth2/token` with `client_credentials` and scope `amp.api:workspace.threads.meta:view`. Without them, usage is disabled and cost remains null, not zero. Unrecognized usage response fields are also n/a rather than invented dollars. Costs and test outcomes remain the agent's word, not measurements Pim can enforce against a budget.

## Git checks and limits

An orb clones and pushes with its own credentials. Pim cannot enforce its workspace egress or git policies on that cloud. `src/coding/orb/git-check.ts` provides pure ref snapshots, comparisons and diffs, tested with `FakeRefReader`: default-branch moves, force pushes, new/deleted refs, capped commits and concurrent pushes are detected without falsely attributing every change to the orb. These checks still have no live `RefReader` and are not called by the thread loop.

The deployment factory registers Amp HTTP; tests can inject another client. A thread naming an unregistered client fails with `agent-hosted provider not available` rather than crashing.

## Verification

`test/coding-orb-amp-http.test.ts` uses injected fetch responses and runs the conformance suite with unsupported capabilities declared. `test/coding-orb-thread.test.ts` covers slot-free placement, polling, eviction, the shared Connect credential and auth rejection. `test/coding-vault.test.ts` covers sealing the optional M2M credential separately from that token.

These are mocked tests, not verification of a live Amp account. Authentication, project permissions and current transcript/usage response shapes still need account-level verification.
