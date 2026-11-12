# Coding threads API

A coding thread is an agent that works on a GitHub repository in a workspace of its own, on a branch of its own (`pim/…`), until it is archived. The web app shows each at `/coding/<id>`. This is the API it and other clients use, under `/api/coding/threads`, signed in as every other `/api` route is: the browser's session cookie, or `Authorization: Bearer <token>`. A guest's account has no coding threads (`403`). The types are in [`src/coding/api.ts`](../src/coding/api.ts); how threads work is in [reference.md](reference.md#coding-threads).

Each thread belongs to the space that started it. Every route checks that the thread is in the caller's space: another space's thread, or one that doesn't exist, is `404`.

Placement skips an unhealthy pool with `placement.skipped[].reason: "unhealthy"`. Three consecutive workspace infrastructure failures open a pool for five minutes; after that only one thread probes it. A successful workspace start closes it, and a failed probe restarts the cooldown. Capacity and low-disk refusals do not count. A thread pinned to an open pool stays queued with `queue.reason: "unhealthy"` rather than failing or moving to another pool, subject to the usual queue deadline. Breaker state belongs to the space’s scheduler and survives its restart.

## Errors

Every error is JSON with the HTTP status:

```json
{ "error": "GitHub App not configured: ask the Pim owner to set it up", "code": "github_app_not_configured" }
```

| `code` | Status | When |
| --- | --- | --- |
| `invalid` | 400 | The body or query is wrong: a missing `task`, a repository not on GitHub, a budget that isn't a positive number |
| `forbidden` | 403 | The deployment doesn't let coding threads use that repository (`PIM_GIT_REPOS`), or a guest asked |
| `not_found` | 404 | No such thread in this space |
| `archived` | 409 | The thread is archived: only reading it works |
| `budget_spent` | 409 | Steering a thread that spent its budget, or continuing it without a bigger `budgetUsd` |
| `not_cancellable` | 409 | Cancelling a thread whose turn has started: abort it instead |
| `workspace_not_running` | 409 | A diff from a commit other than the start, a push or a merge, when the thread's workspace can't be resumed (archived or failed thread, or a workspace that won't open) |
| `workspace_queued` | 409 | The same, when the suspended thread is still queued for a sandbox slot or resuming after about two minutes: try again later. A suspended workspace is otherwise resumed automatically |
| `nothing_to_push` | 409 | A push before the thread has committed a checkpoint |
| `github_app_not_configured` | 409 | A push on a Pim whose GitHub App isn't set up; nothing was asked |
| `push_refused` | 403 | A push (a merge is `coding_merge`'s) to `main`, `master`, the default branch, or a branch outside the deployment's prefix (`pim/`) |
| `conflict` | 409 | The thread refused the call as it is now; `error` says why |

## Types

```ts
type CodingThreadState = "provisioning" | "queued" | "idle" | "running" | "waiting_input" | "failed" | "archived";

/** Who started a thread: the person (web app or API) or one of their agents, from a chat. */
type CodingCreator = { type: "person" } | { type: "agent"; agent: string; chat: string };

/** Its place in the space's queue, while it waits for a workspace slot. */
type QueuePlace = { position: number; reason: string; detail?: string };

/** Which model the thread runs on: a provider id of the space (`/api/model`'s `providers`) and a model of it. */
type AgentProfile = { providerId: string; model: string; thinking?: "minimal" | "low" | "medium" | "high" | "xhigh" };

/** A thread as `GET /api/coding/threads` lists it. Times are ms since the epoch; money is US dollars. */
type CodingThreadSummary = {
  id: string;
  url: string;              // "/coding/<id>", the web app's page
  repo: string;             // "https://github.com/<owner>/<name>"
  ref: string;              // what it started from, "main" unless given
  branch: string;           // "pim/<slug>-<id prefix>"
  task: string;             // the task it was started with, at most 2,000 characters
  state: CodingThreadState;
  stateReason: string | null; // such as "budget", "no_backend", "aborted", "cancelled", "queue_expired:slots_full", "login_required"
  queue: QueuePlace | null;
  createdBy: CodingCreator;
  parent: string | null;    // the thread that started this one
  chat: string | null;      // the chat it was started from, which the chat list shows it under as a subthread
  harness: "pi" | "claude-code" | "codex" | "mistral-vibe" | "amp"; // the coding agent that runs it
  spentUsd: number;
  budgetUsd: number | null; // null when none was set
  createdAt: number;
  updatedAt: number;
  lastTurnEndedAt: number | null; // when its latest turn ended; null before its first
  lastSeenAt: number | null;      // when the person last viewed it (`POST …/seen`); null if never
};

/** One thread in full: what the routes below answer with unless they say otherwise. */
type CodingThreadView = {
  id: string;
  threadId: string;         // the same as id
  url: string;
  task: string;
  status: CodingThreadState; // the same as state
  position?: number;        // while queued, queue.position
  reason?: string;          // while queued, queue.reason
  state: CodingThreadState;
  stateReason: string | null;
  stateDetail: string | null; // what to tell the person, such as how to set up a workspace backend; for a `model_error`, the provider's HTTP status, error type and code and message, secrets taken out and cut to 500 characters (or the provider and model when it said nothing)
  repo: { url: string; ref: string; branch: string; baseSha: string | null };
  profile: AgentProfile;
  workspaceProvider: string; // the backend it runs on, such as "compose" or "cloudflare"; while it waits for its first slot, the one it tries first
  provider: string;           // the same as `workspaceProvider`: the sandbox provider's id, such as "compose" or "cloudflare"
  pool: string;               // the pool it takes slots from: a pool of the deployment's registry (see coding-pools.md), or its provider's id while one provider is one pool
  placementReason: "pinned" | "priority" | "overflow"; // pinned: the start named it; priority: the first pool with room; overflow: moved on from a full one
  placement: { kind: "pinned" | "priority" | "overflow"; pool: string; provider: string; priority: number; skipped: { pool: string; reason: "disabled" | "provider_unavailable" | "unhealthy" | "full" }[] } | null;
  // the same as `placementReason` in full: the pool it took a slot in, the provider behind it, where the pool stands among the deployment's pools, and the pools it couldn't and why. Null until the thread is placed
  slot: "none" | "queued" | "held";
  queue: QueuePlace | null;
  budgetUsd: number | null; // null when none was set
  spentUsd: number;
  currentOperation: string | null; // the turn under way, null between turns
  inbox: number;            // inputs waiting for a turn
  checkpoint: { seq: number; sha: string; message: string; operationId: string | null; createdAt: number } | null;
  environment: CodingEnvironment;
  createdBy: CodingCreator;
  harness: "pi" | "claude-code" | "codex" | "mistral-vibe" | "amp";
  parentThread: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * The repository's prepared environment in the thread's workspace: the toolchains and dependencies its files pin,
 * provisioned, then its setup script run, restored from the person's snapshot when one was kept (see Coding threads in
 * reference.md, and coding-environment.md). Durations are milliseconds; times are ms since the epoch.
 */
type CodingEnvironment = {
  state: "none" | "unsupported" | "restoring" | "cached" | "building" | "failed"; // none: nothing to provision and no setup script; unsupported: the workspace backend keeps no environments (reason says why); failed: the setup script failed (a failed provisioning step is on its item)
  reason?: string;               // why the backend can't keep environments, when the state is "unsupported"
  key: string | null;           // 64 hex digits: the person, the repository, the provisioning steps, the script, its lockfiles and the workspace image
  source: "settings" | "repository" | "mise" | "devcontainer" | null; // the person's setting, the repository's .pim/setup.sh, its mise task `setup`, or its dev container's lifecycle commands (the first that exists); null without a setup
  builtAt: number | null;       // when the snapshot the thread has was made
  restoredFromKey: string | null; // the snapshot the workspace started from, an older key's when the repository moved on
  provisionMs: number | null;   // making the workspace and checking the repository out, restore included
  restoreMs: number | null;
  setupMs: number | null;       // provisioning and the setup script together
  snapshotMs: number | null;
  snapshotBytes: number | null; // the snapshot taken or restored, compressed, as the backend stores it
  snapshotKept: boolean | null; // false: restoring it was expected to take longer than the setup, so it was deleted, or a provisioning step failed, so none was taken
  readyFrom: "snapshot" | "setup" | null; // restored from a snapshot (a cache hit), or provisioned and set up in this workspace
  preparedAt: number | null;    // when the thread last readied it; null before its first turn
  rebuildRequested: boolean;
  error?: string;               // why it failed, at most 500 characters; the end of the script's output is the repository's
  toolchains: {                 // what the repository's files pin, strongest source first, and the image's own Node, pnpm and Yarn
    tool: string;               // "go", "node", "pnpm", "python", "uv", "rust", or a name from mise's configuration such as "npm:prettier"
    version: string | null;     // as mise takes it ("1.22.5", "20", "lts", "stable"); null for the image's own
    source: "mise" | "devcontainer" | "manifest" | "dockerfile" | "default" | "image";
    from: string;               // the file it was read from, such as "go.mod"
    status: ProvisionStatus;
    error?: string;             // the step's command, how it ended and the end of what it printed
  }[];
  dependencies: { tool: string; command: string; from: string; status: ProvisionStatus; error?: string }[]; // such as "go mod download" from "go.sum"
  testCommands: { command: string; source: "mise" | "make" | "package.json" | "ci" | "default"; from: string }[]; // the checks the coding agent is told
  notes: string[];              // what was found and isn't provisioned, such as a CI workflow's services
};

// pending: not run yet; installed: in this workspace; cached: came with the snapshot; failed; skipped: a toolchain it needs failed; present: the image has it
type ProvisionStatus = "pending" | "installed" | "cached" | "failed" | "skipped" | "present";

/** The person's settings for one of their repositories. */
type CodingRepoSettings = {
  repo: string;                 // "owner/name", in lowercase
  setupScript: string | null;   // run in place of the repository's own .pim/setup.sh; at most 64 KiB
  updatedAt: number | null;
};
```

## Routes

Paths are under `/api`. Bodies are JSON. `operationId` makes a call idempotent: the same one again changes nothing and answers as the first did. It is optional; without one, each call is new.

| Method | Path | Body / query | Answers |
| --- | --- | --- | --- |
| GET | `/coding/threads` | | `{ threads: CodingThreadSummary[] }`, newest first, archived ones included |
| POST | `/coding/threads` | `{ repo, ref?, task, profile?, harness?, chat?, budgetUsd?, parent?, operationId?, pool?, provider?, rebuildEnvironment? }` | `201` with `CodingThreadView`, or `200` with the same thread when `operationId` started one already. It returns at once: the thread is `provisioning`, or `queued` with `position` and `reason` when the space's slots are taken. When `rebuildEnvironment` is true, the thread starts with a freshly rebuilt environment, skipping any cached snapshot. `pool` pins the thread to one sandbox pool by its id, such as `compose` or `cloudflare-2` (case-insensitive); `provider` pins it to a provider, which is that provider's first pool. Naming both, they must agree (the admin's name for the provider works too). A pinned thread is placed only in that pool and waits in the queue when it is full, never overflowing. A name the space has no enabled pool for is refused with `400 invalid`, saying which pools it has. Left out, the thread walks the deployment's pools in their order of priority and takes the first with room, moving on to the next when one is full (see [coding-pools.md](coding-pools.md)) |
| GET | `/coding/threads/:id` | | `CodingThreadView` |
| GET | `/coding/threads/:id/transcript` | | `{ messages: TranscriptMessage[] }`, as `/sessions/:s/messages` has them, with the thread's own notices (a budget stop) as `role: "notice"` |
| GET | `/coding/threads/:id/diff` | `?since=<sha>` | `{ since, head, diff, truncated }`: `git diff` from `since` (the commit it started from, by default) to its latest checkpoint, at most 256 KiB. From the start it is kept for every checkpoint; from another commit it needs the workspace (`workspace_not_running`) |
| GET | `/coding/threads/:id/tests` | | `{ runs: [{ seq, command, exitCode, timedOut, startedAt, durationMs, summary: { format, passed, failed, skipped, total } \| null, output }] }`, oldest first; `output` is the end of what it printed |
| GET | `/coding/threads/:id/log` | `?since=<seq>` | `{ events: CodingEvent[], next }`: the thread's log after `since` (0), at most 500, and the `since` for the next page. See below |
| GET | `/coding/threads/:id/events` | `Accept: text/event-stream` for SSE | The live stream, as below, until the client closes it |
| POST | `/coding/threads/:id/steer` | `{ text, interrupt?, operationId? }` | `CodingThreadView`. During a turn the text joins it after its current tool round, or with `interrupt` stops it and starts a new turn with the text; between turns it starts the next one. A `claude-code`, `codex` or `amp` thread takes no input mid-turn: the text is its next turn, which resumes the CLI's session |
| POST | `/coding/threads/:id/abort` | | `CodingThreadView`: stops the turn under way and every command it runs, and withdraws inputs waiting |
| POST | `/coding/threads/:id/continue` | `{ budgetUsd?, operationId? }` | `CodingThreadView`: goes on after a failure or a stop, with a bigger budget if given. A thread `waiting_input` for a login goes on with the input it waited with |
| POST | `/coding/threads/:id/cancel` | | `CodingThreadView`: a thread whose task hasn't started yet (`queued` or `provisioning`) leaves the queue or gives its slot back, withdraws its inputs, and ends with `thread.turn_ended`, `outcome: "cancelled"`; it is then `idle` with `stateReason: "cancelled"`. Again, it changes nothing. A thread whose turn started: `not_cancellable` |
| POST | `/coding/threads/:id/seen` | | `{ seen: true }`: says the person has viewed the thread, setting its `lastSeenAt` to now. A thread is unread while its `lastTurnEndedAt` is later than its `lastSeenAt`; the web app marks it on the icon, and every open page hears of the change on the chat list's socket |
| POST | `/coding/threads/:id/archive` | | `CodingThreadView`: ends the thread, deleting its workspace. Reading it still works |
| GET | `/coding/threads/:id/environment` | | `CodingEnvironment` |
| POST | `/coding/threads/:id/environment/rebuild` | | `CodingEnvironment`, now `building` with `rebuildRequested`: deletes the person's snapshot of its key, then provisions the toolchains and dependencies and runs the setup script again in the thread's workspace between turns and keeps a new snapshot. A thread without a slot asks for one; a failed one rebuilds once continued. During a turn: `conflict` |
| GET | `/coding/repos/:owner/:name/settings` | | `CodingRepoSettings`, the person's own; empty when they set none |
| PUT | `/coding/repos/:owner/:name/settings` | `{ setupScript: string \| null }` | `CodingRepoSettings`. A null or blank script clears it. A repository the deployment doesn't allow is `forbidden`; a script over 64 KiB, `invalid` |
| POST | `/coding/threads/:id/push` | `{ branch? }` | `202` with `{ approval, status, branch, head, bytes, summary }`: asks the person to approve pushing the thread's latest checkpoint to `branch` (its own branch by default) on GitHub. `approval` is the id of the approval to decide with `POST /approvals/:id/approve` or `/deny`, as any other; `status` is `pending` until then. The same push asked again is the same approval. Pushing needs the thread's workspace running. Errors: `github_app_not_configured`, `push_refused`, `nothing_to_push`, `workspace_not_running` |
| POST | `/coding/threads/:id/pull-request` | `{ title?, body? }` | `200` with `{ title, base, url, number }`: opens a pull request on the thread's git host (GitHub or Gitea) from its pushed branch into the branch it started from (the default branch when it started from a commit), with no approval. The title defaults to the thread's task, and the body to the task with a note that Pim opened it. The pull request's URL and number are also in the thread's `pullRequest`; if one from the branch is open already, that one is used. Errors: `github_app_not_configured`, `not_pushed` (push the branch first), `archived`, `conflict` (such as Gitea not connected) |

### The log

`CodingEvent` is `{ seq, kind, at, provider, model, input, output, cacheRead, cacheWrite, costUsd, data }`. `kind` is one of:

- `model_call`: one call to the model, with its tokens and cost. `data` is null for the thread's own calls; a call a CLI in the workspace made through the model gateway has `data: { via: "gateway", api, pricing, pricedAs?, estimated? }` (see Model gateway for coding threads in [reference.md](reference.md)).
- `thread.queued`: `data: { position, reason }`, each time the thread waits for a slot.
- `thread.turn_started`: `data: { operationId }`.
- `thread.turn_ended`: `data: { type, threadId, space, operationId, outcome, reason?, checkpoint?, at }`, where `outcome` is `completed`, `error`, `cancelled` or `needs_approval`.
- `app.budget_stop`: `data: { budgetUsd, spentUsd }`. Threads stopped before 2026-11-10 at a token ceiling also have `tokens` and `tokenCeiling`.
- `thread.pushed`: `data: { repo, branch, before, after, outcome }`, where `outcome` is `created`, `updated` or `unchanged`.
- `thread.merged`: `data: { repo, branch, before, after, outcome, rebased }`, a merge into the default branch (`branch`); `rebased` says whether the thread's commits were rebased onto it first. A rebase also adds a checkpoint, `Rebased onto <branch>`.
- `environment.built`, `environment.restored`: `data: { key, setupMs?, snapshotKept? }`, the environment was set up (and its snapshot kept, unless `snapshotKept` is false), or restored from the person's snapshot.
- `environment.failed`: `data: { key, error }`; `environment.restore_failed`: `data: { key, error }`, a snapshot that couldn't be restored, after which the thread cloned as usual.
- `environment.provision_failed`: `data: { step, error }`, a provisioning step that failed (`step` is `mise`, `toolchain:<tool>` or `dependencies:<tool>`); the thread went on, and `environment.built` has `provisionFailures`.
- `thread.waiting_input`: `data: { reason, harness, operationId }`: a CLI harness thread's input waits for the person to connect the harness (`reason: "login_required"`): to sign in with their subscription, or to give their API key.
- `harness.api_retry`: `data: { attempt, maxRetries, delayMs, error, status }`: the CLI is retrying a model request.
- `harness.permission_denied`: `data: { tool, message }`: the CLI refused a tool call nothing allowed.
- `harness.notice`: `data: { message }`: the CLI warned of something that didn't stop the turn (Codex's error items, an Amp background subagent that failed).
- `thread.retrying`: `data: { operationId, reason, error, retryAt }`: a turn failed for a transient error, such as a model provider's error, a 429 or 5xx, a dropped network or WebSocket connection, or a workspace or harness that couldn't be started, and is tried again once after 30 to 60 seconds, in the same workspace so its work is kept. `error` is the original error, which also shows as the thread's `stateDetail` while `stateReason` is `retrying`. The retry is a turn of its own (its operation starts with `retry-`, and it is told to continue where it left off), so its spend counts once as it is made and a thread over its budget isn't retried. A retry that fails too, an abort, an auth failure, an exhausted budget or usage limit, and a 4xx other than 429 fail the thread as before, so a turn is retried at most once. A person's steer withdraws a retry that is waiting and goes at once.
- `workspace.lost`: `data: { operationId, error }`: the workspace stopped answering for longer than a minute, or its backend said it has no such workspace (its container, the workspace manager or its host died). It was let go with its volume kept, and is made again from that volume on its next use. A CLI harness's turn cut off by it ends `workspace_lost` and goes on by itself in the new workspace, resuming the CLI's session, with `thread.resumed` (`data: { attempt, reason: "workspace_lost" }`) and the prompt "You were interrupted by an infrastructure restart; continue where you left off."; pi's turn goes on as it was, the command that ran told it was lost. It goes on by itself at most three times in a row, counting the turns it went on with after an eviction of its own; the next loss fails the thread with `stateReason: "workspace_lost"` and `thread.turn_ended` (`outcome: "error"`, `reason: "workspace_lost"`). `workspace.retry`: `data: { attempt, error }`, the workspace couldn't be made again yet, or its backend couldn't be reached while the thread went on after one, and is tried again: at once when it was found down, or, when its backend couldn't be reached, after a minute, then two, then four. These count toward the three as well.
- `workspace.overflow`: `data: { from, to }`: the thread took its slot in another pool than the one it would run in first (`from` and `to` are pool ids), as when the sandbox manager's pools are full and it runs on Cloudflare Containers instead. It happens only before the thread makes its first workspace; after that it stays on its backend. A thread pinned with `pool` or `provider` never overflows, and its `placementReason` is `pinned`; the pin is kept when it is resumed, steered or retried, as it is placed on that pool for good.
- `workspace.restored`: `data: { from, savedAt? }`: the workspace's volume was lost too, so the repository was cloned again and the thread's work put back: from its last autosave (`from: "autosave"`), made every three minutes of a turn and at each turn's end that changed something, without touching the checkout, as a commit the workspace keeps as `refs/pim/autosave` (pushed nowhere) and a git bundle of up to 1 MiB the thread keeps, the changes not committed then left uncommitted; or, without one, from its base. A CLI that keeps its sessions in the workspace (Claude Code, Codex, Mistral Vibe) starts a new session, told the task and what it last said.

For a `claude-code` thread, each turn is one `model_call` with the turn's tokens and what the CLI estimates it cost (`provider: "claude-code"`). For a `codex` or `amp` thread it is the turn's tokens with no cost (`provider: "codex"`, `"amp"`), since neither CLI reports one in dollars ([coding-codex.md](coding-codex.md), [coding-amp.md](coding-amp.md)). Their spend is unmetered: `spentUsd` stays 0 and a budget is not enforced against them, as tokens are no price (Amp counts its whole context again on every response).

### The live stream

`GET /coding/threads/:id/events` is newline-delimited JSON (`application/x-ndjson`), one object a line; with `Accept: text/event-stream` each object is an SSE `data:` line instead. The first is pi's `snapshot` of the conversation, then one `{ type: "events", events }` per change, and `{ type: "output", … }` for what the `bash` and `test` tools print as they run. A `claude-code`, `codex` or `amp` thread's messages arrive as `entry_appended` events once each is complete, and Claude Code's text and thinking as it writes them as `{ type: "partial", kind: "text" | "thinking", text }`, each a piece to add to what came before. Codex and Amp print each message whole.

## Starting a thread

```http
POST /api/coding/threads
{ "repo": "https://github.com/acme/widgets", "task": "Fix the flaky date test", "budgetUsd": 5, "operationId": "a3c1…" }
```

```json
{ "id": "6d0f…", "url": "/coding/6d0f…", "status": "queued", "position": 2, "reason": "slots_full", "state": "queued", "queue": { "position": 2, "reason": "slots_full" }, "…": "…" }
```

- `repo` must be `https://github.com/<owner>/<name>` (`invalid`), and one the deployment allows (`forbidden`).
- `profile` is the thread's model. Without one, it is the space's default model, the one its chats use when an agent has none of its own (`GET /api/model`'s `model`), unless that is a ChatGPT plan model, which coding threads can't use: then it is the deployment's default.
- `budgetUsd` is the most it spends on its model; without it a thread has no budget and runs until it finishes. With one, at it the thread stops, `failed` with `stateReason: "budget"`, until continued with a bigger one. Not enforced for Codex and Amp, which report no cost.
- `parent` must be a thread of this space (`not_found`).
- `harness` is the coding agent that runs it: `pi` by default, `claude-code`, Anthropic's Claude Code CLI ([coding-claude-code.md](coding-claude-code.md)), or `codex`, OpenAI's Codex CLI ([coding-codex.md](coding-codex.md)), each run in the thread's workspace with the person's own subscription, or `mistral-vibe`, Mistral's Vibe CLI ([coding-vibe.md](coding-vibe.md)), or `amp`, Amp's CLI ([coding-amp.md](coding-amp.md)), each run with the person's own API key. A `claude-code` thread's `profile` is `{ providerId: "claude-code", model: "default" }`, the CLI's own model, unless it is given one with that `providerId`, whose `model` the CLI is asked for (`--model`); a `codex` thread's likewise, with `providerId: "codex"` (`-m`), and a `mistral-vibe` thread's with `providerId: "mistral-vibe"` and one of Vibe's model aliases (`--model`, on a new session only). An `amp` thread's `model` is one of Amp's modes, `low`, `medium`, `high` or `ultra` (`--mode`), or `default` for Amp's; another fails its turn.
- `chat` is the chat the thread is started from, for the chat list to show it under that chat. A thread an agent starts records its own chat, so it needs none.
- `rebuildEnvironment` is a boolean, false by default. When true, the thread starts with a freshly rebuilt environment: its workspace is made from a clean clone, the repository's setup script is run from scratch, and no cached snapshot is restored. This is useful when you need a fresh environment, such as after changing dependencies or the setup script.

## Agents

Every agent can start and follow threads with the `coding_*` tools ([`src/extensions/coding.ts`](../src/extensions/coding.ts)): `coding_start`, `coding_status` (with the thread's `environment`: every field of its `CodingEnvironment` that isn't null or empty, its timings, toolchains and check commands included, and `cache_hit`, true when it was restored from a snapshot), `coding_steer`, `coding_diff`, `coding_tests`, `coding_transcript` and `coding_transcript_output`, `coding_abort`, `coding_push`, `coding_merge`, `coding_open_pull_request` and `coding_archive`. `coding_transcript` reads what a thread said ([`src/coding/transcript.ts`](../src/coding/transcript.ts)): its messages oldest first, at most 50 at a time from an `offset`, of one `role` (`user`, `assistant`, `tool` or `notice`) when asked, each cut to what fits — with `summary`, one line of each — and `coding_transcript_output` reads one message whole by the id the page gave it, paged by lines as `read` pages a file; both redact what looks like a credential, as the thread's own tools do. A thread an agent starts is `createdBy: { type: "agent", agent, chat }`, and when each of its turns ends that chat is woken with a message saying how it went. `coding_push` pushes the thread's latest checkpoint to its own `pim/` branch (or another `pim/` branch) at once, with no approval, and says the thread's latest test runs; the person's `POST …/push` still asks first. `coding_open_pull_request` opens a pull request from the pushed branch at once, with no approval, as `POST …/pull-request` does,, with `title` and `body` if given, and answers with its URL and number. `coding_merge` ships a thread's latest checkpoint to the repository's default branch, also at once and with no approval, and says the new commit and the latest test runs: Pim fetches the default branch into the thread's workspace, fast-forwards the checkpoint onto it or rebases it, and moves the default branch forward through the GitHub App, never with a force push. If the thread's changes conflict, the rebase is aborted, nothing is pushed, and the agent is told to `coding_steer` the thread to rebase onto `origin/<default branch>` and resolve them; if the default branch moves while merging, the rebase is made once more, and then it fails. The thread's own `pim/` branch is updated to the same commit when GitHub lets it, and the result says the default branch's new commit.

## Harness logins

Harnesses run the unmodified vendor CLIs, Claude Code (`claude-code`) and Codex (`codex`), inside the person's own workspace, signed in with their own subscription through the CLI's own login. Pim keeps each person's login per harness in their own space: the CLI's credential and config files only (the lists are `HARNESS_FILES` in [`src/coding/vault/harnesses.ts`](../src/coding/vault/harnesses.ts)), packed into one archive of at most 512 KiB and sealed with AES-256-GCM under a key derived from the Directory's own. Pim never opens the files. A login is put into a workspace before a harness runs only when that workspace is one of the same person's threads, and what the CLI changed, such as refreshed tokens, is kept afterwards unless a newer login or a disconnect came first. The disclosures a person accepts before connecting are `HARNESS_DISCLOSURES` in the same file.

Mistral Vibe (`mistral-vibe`) and Amp (`amp`) sign in with an API key instead: a Mistral API key, or an Amp access token (which starts with `sgamp_`). The person saves it once with `PUT …/api-key`; Pim seals it with the same key and binding as a login, in the same table, and never returns it, any part of it, or its length. A run of the harness reads it from the vault and hands it to the CLI in the environment variable the harness declares (`apiKeyEnv`: `MISTRAL_API_KEY`, `AMP_API_KEY`), never on its command line, with no config files restored or written back and no lock taken (`authEnv` in [`src/coding/harness/auth.ts`](../src/coding/harness/auth.ts)). The runner replaces the key with `[redacted]` in every line the CLI prints before anything reads it, so it never reaches the transcript, the log, test runs or the thread's state. A thread on such a harness without a key waits with `login_required`, and goes on when the key is saved. A key is 16 to 512 characters of letters, digits and `._~+/=-`.

| Method | Path | Answers |
| --- | --- | --- |
| GET | `/coding/vault` | `{ harnesses: [{ harness, connected, updatedAt, byteLength }] }`, one per harness |
| GET | `/coding/vault/:harness` | `{ harness, connected, updatedAt, byteLength }`; an unknown harness is `404`. `byteLength` is always `null` for an API key |
| DELETE | `/coding/vault/:harness` | The same, now disconnected: the login or API key is deleted |
| PUT | `/coding/vault/:harness/api-key` | `{ apiKey }`, for `mistral-vibe` or `amp`: stores the key, replacing any before it, and goes on with the person's threads that waited for it. Answers `{ harness, connected: true, updatedAt, byteLength: null }`; a key that doesn't look right is `400` with why, never quoting it, and another harness is `404` |
| POST | `/coding/vault/:harness/login` | `LoginStatus`: starts the CLI's own sign-in in a short-lived workspace of the person's, ending one already under way, and answers once the CLI printed what the person needs: `state: "waiting_code"` with `url`, and for `codex` the `userCode` to enter there |
| GET | `/coding/vault/:harness/login` | `LoginStatus` of the sign-in under way, `state: "none"` without one. A `codex` sign-in ends by itself, so the web app polls this until it is `connected` or `failed` |
| POST | `/coding/vault/claude-code/login/code` | `{ code }`, the code the sign-in page shows. Pim hands it to the CLI on its standard input, waits for the CLI to save its login and keeps that in the vault: `state: "connected"`, or `failed` with `error`. `codex` takes no code here (`400`) |
| DELETE | `/coding/vault/:harness/login` | Ends the sign-in and deletes its workspace: `state: "none"` |

```ts
type LoginStatus = { harness: "claude-code" | "codex"; state: "none" | "starting" | "waiting_code" | "completing" | "connected" | "failed"; url: string | null; userCode: string | null; error: string | null };
```

Claude Code's sign-in is `claude auth login`: the person signs in at `url` and pastes the code the page shows. Codex's is `codex login --device-auth`: the person enters `userCode` at `url` (`https://auth.openai.com/codex/device`), and the CLI, which polls OpenAI meanwhile, exits once they have; Pim then keeps its login, and threads that waited for it go on.

No route returns or accepts a login's contents: Pim reads nothing the CLI prints but the URL and the code to enter, and keeps neither code nor what it prints. A guest's account has none (`403`).

## Live activity and stalls

Thread details and list rows include an `activity` record, also used by the
web app and `pim_diagnostics` (`now`, `stalls`, and `coding`). Chats expose the
same record at `GET /api/sessions/:session/activity`, with the chat's usual
access checks. No feature flag is needed.

The record has `running`, `lastActivityAt` (epoch milliseconds), `current`
(the pending tools' names, short redacted summaries, `startedAt`, `elapsedMs`
and `timeoutMs`), up to 120 timeline `steps`, and `stalls`. Completed tool
steps include `exitCode` where the harness reports one and `outputBytes`,
the UTF-8 size of the retained tool-result content serialized as JSON, not
necessarily the full output before truncation. Unknown values are null.
Model durations are null when the harness did not report them.

Summaries select operational arguments only: commands, file paths, thread
ids and URL paths. They do not include prompts, request bodies or environment
objects. Secret-shaped values, authorization, URL queries and email addresses
are scrubbed before summaries are cut to about 200 characters. URL hosts stay
redacted under diagnostics' existing address policy.

A pending tool is stalled past its declared timeout or after five minutes
without observed output. A running coding thread is also stalled after
fifteen minutes without transcript/output activity. Heartbeats are not
output: a live scheduler cannot make a silent command look healthy. A stall
is a warning, not proof that the process is dead; commands may legitimately
be quiet. Parent agents receive a notice once per stall, through the same
wake path as turn completion; threads started by the person notify the
majordomo instead. The existing chat watchdog's stop policy is unchanged.
CLI and agent-hosted harnesses can only expose tool calls and activity that
they report; absence of command details is shown as working, never invented.
