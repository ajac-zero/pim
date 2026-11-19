# Agent-hosted coding threads (orbs)

An **agent-hosted** thread runs in the vendor's cloud, not a sandbox Pim owns. `providerKind: "agent-hosted"` distinguishes it from a workspace thread. Pim starts and polls the agent through `OrbClient` (`packages/coding/src/orb/types.ts`), with no workspace, commands, environment or scheduler slot. Old thread records remain workspace threads.

## The interface

`OrbClient` is the provider-neutral seam: idempotent `start`, `state`, paginated `messages`, optional `steer`, `stop`, `cancel` and `usage`. Capability flags declare which optional verbs work; unsupported calls throw `OrbUnsupportedError`. Authentication, unreachable clouds and deleted threads have typed errors too. Usage is null when unavailable, never invented as zero.

The conformance suite (`packages/coding/src/orb/conformance.ts`) checks the contract. Capabilities and script hooks gate cases a provider cannot exercise, with explicit skip reasons. `FakeOrbClient` is an in-memory implementation for loop tests.

## Amp over HTTPS

`AmpHttpOrbClient` (`packages/coding/src/orb/amp-http.ts`) uses only fetch, from the Forge worker, to Amp's **internal** HTTPS API (`POST https://ampcode.com/api/internal?<method>`), the one the Amp CLI itself uses. Amp's documented `/api/v2` rejects the `sgamp_` access token with 401, so it is not used. The client never starts a CLI, opens a WebSocket, or holds a sandbox slot. The **workspace Amp harness is retired**; `harness: "amp"` now defaults to agent-hosted Orbs (amp-http) with no sandbox slot. Old threads that used the workspace Amp harness remain readable. See [coding-amp.md](coding-amp.md) for legacy information.

Every call sends only `Authorization: Bearer <token>` and `content-type: application/json`, with body `{"method","params"}`, and gets `{"ok":true,"result"}`, `{"ok":false,"error":{"code","message"}}`, or `{"status","message"}` for 400/401. The base URL is `https://ampcode.com` unless `baseUrl` is given.

| Orb call | Amp method |
| --- | --- |
| start | `resolveProjectByRepositoryURLs` (cached per repository URL), then `createRemoteExecutorThread` |
| state, messages | `getThreadTail` (state reads 1 message; the transcript 200, or 20 if the response is over the 2 MB cap; message text is truncated to 8000 chars; non-text blocks become `[type]` markers) |
| steer | `sendMessageToThread` |
| stop (archive) | `archiveThread` with `{thread, archived: true}` |
| cancel (Stop) | `POST /api/thread-actors`, then a WebSocket `client_cancel` (see below) |

The bearer is **the same saved credential as the coding page's Amp Connect field**: `codingVault.loadApiKey(space, "amp")`. There is no second PAT or Connect UI. A missing token waits in `login_required`. A 401/403 also waits there and says:

> Amp rejected the saved token (HTTP <status>): <redacted body snippet>

The same status, a body snippet (500 chars) and safe headers (`www-authenticate`, `x-request-id`, `cf-ray`) go to the `pim.coding.amp_http_failed` warn log. Tokens and Bearer values are redacted everywhere. Requests use `redirect: "manual"` (a redirect is refused) and a 30 second timeout. Reconnecting through the existing field resumes threads waiting for the login.

### Creation and retries

Start resolves the project (creating nothing), then a durable reservation precedes `createRemoteExecutorThread`, and its thread handle is stored before any poll. `agentMode` is the thread's mode when it is `low`/`medium`/`high`/`ultra`, otherwise `medium`; a title is not sent.

Amp has no caller idempotency key. After a network failure, a 5xx, or a crash before the handle is saved, Pim **cannot know whether creation succeeded**. It refuses to create again under that key and asks the person to check Amp. This trades automatic recovery of an ambiguous start for never double-starting. Definitive rejections (authentication, rate limit, `ok:false`, other 4xx) can be retried. A saved handle is returned on retries, including after eviction.

The Forge worker polls every 30 seconds. A missing state keeps polling; `working` is running; `idle` ends the turn only after working was seen or a 60-second creation grace period. Unknown states are logged and treated as still working. Approval means needs-attention on Amp. Amp may retry its own errors, so an error must persist for two minutes before Pim fails the turn. Progress and retry backoff survive eviction. 429/5xx and network errors back off with a bounded attempt count and honor Retry-After; ambiguous creation is never resent.

### Steering and archiving

Steering is supported. Amp's internal HTTP API has no cancel call (`cancelThread` is "Unknown method"), so `stop` is `archiveThread` and the UI and tools label it **archive**; it may not halt a running agent. **Stop** is the separate optional `cancel(id)` capability (`capabilities().cancel`), and Pim's abort uses it for Amp threads: it does not archive, the turn ends like any aborted turn (idle), and a failure leaves the turn running so Stop can be pressed again. DELETE is never used.

Cancel goes over a short-lived outbound WebSocket (one attempt, ~10 s):

1. `POST /api/thread-actors` with the saved bearer and `{"threadId","usesThreadActors":true}` returns a `wsToken` (a secret JWT).
2. `fetch` an Upgrade to `/actors/gateway/threadActor/websocket/?rvt-namespace=default&rvt-method=get&rvt-key=<thread>&rvt-token=<AMP_RIVET_PUBLIC_KEY>&rvt-skip-ready-wait=true` with subprotocols `rivet`, `rivet_encoding.bare`, `rivet_skip_ready_wait`, `rivet_conn_params.<encoded JSON with wsToken>`.
3. Send `client_cancel` as JSON-RPC and wait for the response with the same id (`{"ok":true}`); notifications such as `pong` and `tool_approval_queue` are ignored. Then close with 1000.

`AMP_RIVET_PUBLIC_KEY` is not a secret (every Amp CLI embeds it). If Amp rotates it the socket closes 1008 `auth.invalid_token` and Pim reports "Amp rejected the rivet key"; re-extract it with `strings $(readlink -f $(which amp)) | grep -oE 'pk_[A-Za-z0-9_]{60,}' | head -1`. The wsToken, the access token and the `rivet_conn_params` subprotocol are redacted from every error and log. Unverified until tried live: Workers' fetch-Upgrade to the gateway in production, and whether the long-lived `sgamp_` token is accepted by `/api/thread-actors`.

### Usage

The internal API reports no cost, so usage is not supported and cost remains null, not zero. (The sealed `amp-http-m2m` vault entry from the earlier /api/v2 client is no longer read.) Costs and test outcomes remain the agent's word, not measurements Pim can enforce against a budget.

## Images and suggested replies

An Amp reply may show attachment images and videos (`![Light](https://ampcode.com/user-content/attachments/…)`) that only Amp's signed-in clients can load. The thread copies each into the space's own images (`/api/images/<id>`, kept under the session `coding:<threadId>`, so archiving the thread keeps them) and rewrites the address in the message: while mirroring the orb's messages, and, for threads mirrored before this, the first time `transcript()` is read. `packages/coding/src/orb/amp-attachments.ts` finds them outside code and fetches one with the space's Amp login, which goes to Amp only: a redirect to Amp's own origin is followed with it, one to another HTTPS address once without it, and anything else fails. The attachment must be a PNG, JPEG, WebP or GIF of at most 5 MB, or an MP4 or WebM video of at most 20 MB (its first bytes must be those of its type), and fit the space's storage room. A video's copy is `/api/images/<id>.mp4` or `.webm`, served with `Range` support and shown with the browser's own video controls, never playing by itself; a thread that earlier turned a video down tries it again on its next read. The thread remembers each copy (`amp:attachment:<address>`), and an attachment that can't be fetched is tried at most three times, with at most 20 fetches in one read.

The coding thread's page shows only Pim's own images in an agent's text (`Markdown` with `ownImages`); every other image stays its alt text. A reply may end with `<suggested-replies>` and one reply per line: the tags are taken out of the text, and while the thread is idle and the reply is the last row, the lines show as the chat's suggestions do: a click steers the thread with the line's plain text, and ⌘ or Ctrl-click puts it in the message box.

## Git checks and limits

An orb clones and pushes with its own credentials. Pim cannot enforce its workspace egress or git policies on that cloud. `packages/coding/src/orb/git-check.ts` provides pure ref snapshots, comparisons and diffs, tested with `FakeRefReader`: default-branch moves, force pushes, new/deleted refs, capped commits and concurrent pushes are detected without falsely attributing every change to the orb. These checks still have no live `RefReader` and are not called by the thread loop.

The deployment factory registers Amp HTTP; tests can inject another client. A thread naming an unregistered client fails with `agent-hosted provider not available` rather than crashing.

## Verification

`packages/coding/test/orb-amp-http.test.ts` is a contract test against recorded fixtures (`packages/coding/test/support/amp-internal/*.json`, written from the verified shapes, tokens redacted): exact URLs, headers and bodies, state mapping, defensive transcript mapping, error cases and token redaction. It also runs the conformance suite (`stopHalts: false`, since archiving may not halt a run). `packages/v2-forge/test/amp.test.ts` covers slot-free placement, polling, eviction, the shared Connect credential and auth rejection.

The fixtures are not recordings of live traffic; whether archiving halts a running agent, and the full set of `lastKnownAgentState` values, are unverified.
