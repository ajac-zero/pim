# Agent-hosted coding threads (orbs)

An **agent-hosted** thread runs in the vendor's cloud, not a sandbox Pim owns. `providerKind: "agent-hosted"` distinguishes it from a workspace thread. Pim starts and polls the agent through `OrbClient` (`src/coding/orb/types.ts`), with no workspace, commands, environment or scheduler slot. Old thread records remain workspace threads.

## The interface

`OrbClient` is the provider-neutral seam: idempotent `start`, `state`, paginated `messages`, optional `steer`, `stop` and `usage`. Capability flags declare which optional verbs work; unsupported calls throw `OrbUnsupportedError`. Authentication, unreachable clouds and deleted threads have typed errors too. Usage is null when unavailable, never invented as zero.

The conformance suite (`src/coding/orb/conformance.ts`) checks the contract. Capabilities and script hooks gate cases a provider cannot exercise, with explicit skip reasons. `FakeOrbClient` is an in-memory implementation for loop tests.

## Amp over HTTPS

`AmpHttpOrbClient` (`src/coding/orb/amp-http.ts`) uses only fetch from the Worker/DO to Amp's **internal** HTTPS API (`POST https://ampcode.com/api/internal?<method>`), the one the Amp CLI itself uses. Amp's documented `/api/v2` rejects the `sgamp_` access token with 401, so it is not used. The client never starts a CLI, opens a WebSocket, or holds a sandbox slot. The **workspace Amp harness is retired**; `harness: "amp"` now defaults to agent-hosted Orbs (amp-http) with no sandbox slot. Old threads that used the workspace Amp harness remain readable. See [coding-amp.md](coding-amp.md) for legacy information.

Every call sends only `Authorization: Bearer <token>` and `content-type: application/json`, with body `{"method","params"}`, and gets `{"ok":true,"result"}`, `{"ok":false,"error":{"code","message"}}`, or `{"status","message"}` for 400/401. The base URL is `https://ampcode.com` unless `baseUrl` is given.

| Orb call | Amp method |
| --- | --- |
| start | `resolveProjectByRepositoryURLs` (cached per repository URL, in memory and DO storage), then `createRemoteExecutorThread` |
| state, messages | `getThreadTail` (state reads 1 message; the transcript 200, or 20 if the response is over the 2 MB cap; message text is truncated to 8000 chars; non-text blocks become `[type]` markers) |
| steer | `sendMessageToThread` |
| stop | `archiveThread` with `{thread, archived: true}` |

The bearer is **the same saved credential as the coding page's Amp Connect field**: `codingVault.loadApiKey(space, "amp")`. There is no second PAT or Connect UI. A missing token waits in `login_required`. A 401/403 also waits there and says:

> Amp rejected the saved token (HTTP <status>): <redacted body snippet>

The same status, a body snippet (500 chars) and safe headers (`www-authenticate`, `x-request-id`, `cf-ray`) go to the `pim.coding.amp_http_failed` warn log. Tokens and Bearer values are redacted everywhere. Requests use `redirect: "manual"` (a redirect is refused) and a 30 second timeout. Reconnecting through the existing field resumes threads waiting for the login.

### Creation and retries

Start resolves the project (creating nothing), then a durable reservation precedes `createRemoteExecutorThread`, and its thread handle is stored before any poll. `agentMode` is the thread's mode when it is `low`/`medium`/`high`/`ultra`, otherwise `medium`; a title is not sent.

Amp has no caller idempotency key. After a network failure, a 5xx, or a crash before the handle is saved, Pim **cannot know whether creation succeeded**. It refuses to create again under that key and asks the person to check Amp. This trades automatic recovery of an ambiguous start for never double-starting. Definitive rejections (authentication, rate limit, `ok:false`, other 4xx) can be retried. A saved handle is returned on retries, including after eviction.

The DO alarm polls every 30 seconds. A missing state keeps polling; `working` is running; `idle` ends the turn only after working was seen or a 60-second creation grace period. Unknown states are logged and treated as still working. Approval means needs-attention on Amp. Amp may retry its own errors, so an error must persist for two minutes before Pim fails the turn. Progress and retry backoff survive eviction. 429/5xx and network errors back off with a bounded attempt count and honor Retry-After; ambiguous creation is never resent.

### Steering and archiving

Steering is supported. **Amp's internal API has no cancel call** (`cancelThread` is "Unknown method"), so the orb's `stop` is `archiveThread`, and the UI and tools label it **archive**, not stop. Archiving may not halt a running agent; this is unverified. Pim's own abort is therefore refused for Amp threads with an `unsupported` explanation, and the UI shows no Stop button for them. DELETE is never used.

### Usage

The internal API reports no cost, so usage is not supported and cost remains null, not zero. (The sealed `amp-http-m2m` vault entry from the earlier /api/v2 client is no longer read.) Costs and test outcomes remain the agent's word, not measurements Pim can enforce against a budget.

## Git checks and limits

An orb clones and pushes with its own credentials. Pim cannot enforce its workspace egress or git policies on that cloud. `src/coding/orb/git-check.ts` provides pure ref snapshots, comparisons and diffs, tested with `FakeRefReader`: default-branch moves, force pushes, new/deleted refs, capped commits and concurrent pushes are detected without falsely attributing every change to the orb. These checks still have no live `RefReader` and are not called by the thread loop.

The deployment factory registers Amp HTTP; tests can inject another client. A thread naming an unregistered client fails with `agent-hosted provider not available` rather than crashing.

## Verification

`test/coding-orb-amp-http.test.ts` is a contract test against recorded fixtures (`test/fixtures/amp-internal/*.json`, written from the verified shapes, tokens redacted): exact URLs, headers and bodies, state mapping, defensive transcript mapping, error cases and token redaction. It also runs the conformance suite (`stopHalts: false`, since archiving may not halt a run). `test/coding-orb-thread.test.ts` covers slot-free placement, polling, eviction, the shared Connect credential and auth rejection.

The fixtures are not recordings of live traffic; whether archiving halts a running agent, and the full set of `lastKnownAgentState` values, are unverified.
