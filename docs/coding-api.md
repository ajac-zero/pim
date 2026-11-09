# Coding threads API

A coding thread is an agent that works on a GitHub repository in a workspace of its own, on a branch of its own (`pim/…`), until it is archived. The web app shows each at `/coding/<id>`. This is the API it and other clients use, under `/api/coding/threads`, signed in as every other `/api` route is: the browser's session cookie, or `Authorization: Bearer <token>`. A guest's account has no coding threads (`403`). The types are in [`src/coding/api.ts`](../src/coding/api.ts); how threads work is in [reference.md](reference.md#coding-threads).

Each thread belongs to the space that started it. Every route checks that the thread is in the caller's space: another space's thread, or one that doesn't exist, is `404`.

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
| `workspace_not_running` | 409 | A diff from a commit other than the start, or a push, while the thread's workspace isn't running |
| `nothing_to_push` | 409 | A push before the thread has committed a checkpoint |
| `github_app_not_configured` | 409 | A push on a Pim whose GitHub App isn't set up; nothing was asked |
| `push_refused` | 403 | A push to `main`, `master`, the default branch, or a branch outside the deployment's prefix (`pim/`) |
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
  harness: "pi" | "claude-code" | "codex"; // the coding agent that runs it
  spentUsd: number;
  budgetUsd: number;
  createdAt: number;
  updatedAt: number;
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
  stateDetail: string | null; // what to tell the person, such as how to set up a workspace backend
  repo: { url: string; ref: string; branch: string; baseSha: string | null };
  profile: AgentProfile;
  workspaceProvider: string;
  slot: "none" | "queued" | "held";
  queue: QueuePlace | null;
  budgetUsd: number;
  spentUsd: number;
  currentOperation: string | null; // the turn under way, null between turns
  inbox: number;            // inputs waiting for a turn
  checkpoint: { seq: number; sha: string; message: string; operationId: string | null; createdAt: number } | null;
  createdBy: CodingCreator;
  harness: "pi" | "claude-code" | "codex";
  parentThread: string | null;
  createdAt: number;
  updatedAt: number;
};
```

## Routes

Paths are under `/api`. Bodies are JSON. `operationId` makes a call idempotent: the same one again changes nothing and answers as the first did. It is optional; without one, each call is new.

| Method | Path | Body / query | Answers |
| --- | --- | --- | --- |
| GET | `/coding/threads` | | `{ threads: CodingThreadSummary[] }`, newest first, archived ones included |
| POST | `/coding/threads` | `{ repo, ref?, task, profile?, harness?, chat?, budgetUsd?, parent?, operationId? }` | `201` with `CodingThreadView`, or `200` with the same thread when `operationId` started one already. It returns at once: the thread is `provisioning`, or `queued` with `position` and `reason` when the space's slots are taken |
| GET | `/coding/threads/:id` | | `CodingThreadView` |
| GET | `/coding/threads/:id/transcript` | | `{ messages: TranscriptMessage[] }`, as `/sessions/:s/messages` has them, with the thread's own notices (a budget stop) as `role: "notice"` |
| GET | `/coding/threads/:id/diff` | `?since=<sha>` | `{ since, head, diff, truncated }`: `git diff` from `since` (the commit it started from, by default) to its latest checkpoint, at most 256 KiB. From the start it is kept for every checkpoint; from another commit it needs the workspace (`workspace_not_running`) |
| GET | `/coding/threads/:id/tests` | | `{ runs: [{ seq, command, exitCode, timedOut, startedAt, durationMs, summary: { format, passed, failed, skipped, total } \| null, output }] }`, oldest first; `output` is the end of what it printed |
| GET | `/coding/threads/:id/log` | `?since=<seq>` | `{ events: CodingEvent[], next }`: the thread's log after `since` (0), at most 500, and the `since` for the next page. See below |
| GET | `/coding/threads/:id/events` | `Accept: text/event-stream` for SSE | The live stream, as below, until the client closes it |
| POST | `/coding/threads/:id/steer` | `{ text, interrupt?, operationId? }` | `CodingThreadView`. During a turn the text joins it after its current tool round, or with `interrupt` stops it and starts a new turn with the text; between turns it starts the next one. A `claude-code` or `codex` thread takes no input mid-turn: the text is its next turn, which resumes the CLI's session |
| POST | `/coding/threads/:id/abort` | | `CodingThreadView`: stops the turn under way and every command it runs, and withdraws inputs waiting |
| POST | `/coding/threads/:id/continue` | `{ budgetUsd?, operationId? }` | `CodingThreadView`: goes on after a failure or a stop, with a bigger budget if given. A thread `waiting_input` for a login goes on with the input it waited with |
| POST | `/coding/threads/:id/cancel` | | `CodingThreadView`: a thread whose task hasn't started yet (`queued` or `provisioning`) leaves the queue or gives its slot back, withdraws its inputs, and ends with `thread.turn_ended`, `outcome: "cancelled"`; it is then `idle` with `stateReason: "cancelled"`. Again, it changes nothing. A thread whose turn started: `not_cancellable` |
| POST | `/coding/threads/:id/archive` | | `CodingThreadView`: ends the thread, deleting its workspace. Reading it still works |
| POST | `/coding/threads/:id/push` | `{ branch? }` | `202` with `{ approval, status, branch, head, bytes, summary }`: asks the person to approve pushing the thread's latest checkpoint to `branch` (its own branch by default) on GitHub. `approval` is the id of the approval to decide with `POST /approvals/:id/approve` or `/deny`, as any other; `status` is `pending` until then. The same push asked again is the same approval. Pushing needs the thread's workspace running. Errors: `github_app_not_configured`, `push_refused`, `nothing_to_push`, `workspace_not_running` |

### The log

`CodingEvent` is `{ seq, kind, at, provider, model, input, output, cacheRead, cacheWrite, costUsd, data }`. `kind` is one of:

- `model_call`: one call to the model, with its tokens and cost. `data` is null for the thread's own calls; a call a CLI in the workspace made through the model gateway has `data: { via: "gateway", api, pricing, pricedAs?, estimated? }` (see Model gateway for coding threads in [reference.md](reference.md)).
- `thread.queued`: `data: { position, reason }`, each time the thread waits for a slot.
- `thread.turn_started`: `data: { operationId }`.
- `thread.turn_ended`: `data: { type, threadId, space, operationId, outcome, reason?, checkpoint?, at }`, where `outcome` is `completed`, `error`, `cancelled` or `needs_approval`.
- `app.budget_stop`: `data: { budgetUsd, spentUsd }`.
- `thread.pushed`: `data: { repo, branch, before, after, outcome }`, where `outcome` is `created`, `updated` or `unchanged`.
- `thread.waiting_input`: `data: { reason, harness, operationId }`: a `claude-code` or `codex` thread's input waits for the person to connect the harness (`reason: "login_required"`).
- `harness.api_retry`: `data: { attempt, maxRetries, delayMs, error, status }`: the CLI is retrying a model request.
- `harness.permission_denied`: `data: { tool, message }`: the CLI refused a tool call nothing allowed.
- `harness.notice`: `data: { message }`: the CLI warned of something that didn't stop the turn (Codex's error items).

For a `claude-code` thread, each turn is one `model_call` with the turn's tokens and what the CLI estimates it cost (`provider: "claude-code"`). For a `codex` thread it is the turn's tokens with no cost (`provider: "codex"`), since Codex estimates none ([coding-codex.md](coding-codex.md)).

### The live stream

`GET /coding/threads/:id/events` is newline-delimited JSON (`application/x-ndjson`), one object a line; with `Accept: text/event-stream` each object is an SSE `data:` line instead. The first is pi's `snapshot` of the conversation, then one `{ type: "events", events }` per change, and `{ type: "output", … }` for what the `bash` and `test` tools print as they run. A `claude-code` or `codex` thread's messages arrive as `entry_appended` events once each is complete, and Claude Code's text and thinking as it writes them as `{ type: "partial", kind: "text" | "thinking", text }`, each a piece to add to what came before. Codex prints each message whole.

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
- `budgetUsd` is the most it spends on its model, $3 by default; at it, the thread stops, `failed` with `stateReason: "budget"`, until continued with a bigger one.
- `parent` must be a thread of this space (`not_found`).
- `harness` is the coding agent that runs it: `pi` by default, `claude-code`, Anthropic's Claude Code CLI ([coding-claude-code.md](coding-claude-code.md)), or `codex`, OpenAI's Codex CLI ([coding-codex.md](coding-codex.md)), each run in the thread's workspace with the person's own subscription. A `claude-code` thread's `profile` is `{ providerId: "claude-code", model: "default" }`, the CLI's own model, unless it is given one with that `providerId`, whose `model` the CLI is asked for (`--model`); a `codex` thread's likewise, with `providerId: "codex"` (`-m`).
- `chat` is the chat the thread is started from, for the chat list to show it under that chat. A thread an agent starts records its own chat, so it needs none.

## Agents

Every agent can start and follow threads with the `coding_*` tools ([`src/extensions/coding.ts`](../src/extensions/coding.ts)): `coding_start`, `coding_status`, `coding_steer`, `coding_diff`, `coding_tests`, `coding_abort`, `coding_push` and `coding_archive`. A thread an agent starts is `createdBy: { type: "agent", agent, chat }`, and when each of its turns ends that chat is woken with a message saying how it went. `coding_push` asks the person first, every time, as an approval like `POST …/push` files.

## Harness logins

Harnesses run the unmodified vendor CLIs, Claude Code (`claude-code`) and Codex (`codex`), inside the person's own workspace, signed in with their own subscription through the CLI's own login. Pim keeps each person's login per harness in their own space: the CLI's credential and config files only (the lists are `HARNESS_FILES` in [`src/coding/vault/harnesses.ts`](../src/coding/vault/harnesses.ts)), packed into one archive of at most 512 KiB and sealed with AES-256-GCM under a key derived from the Directory's own. Pim never opens the files. A login is put into a workspace before a harness runs only when that workspace is one of the same person's threads, and what the CLI changed, such as refreshed tokens, is kept afterwards unless a newer login or a disconnect came first. The disclosures a person accepts before connecting are `HARNESS_DISCLOSURES` in the same file.

| Method | Path | Answers |
| --- | --- | --- |
| GET | `/coding/vault` | `{ harnesses: [{ harness, connected, updatedAt, byteLength }] }`, one per harness |
| GET | `/coding/vault/:harness` | `{ harness, connected, updatedAt, byteLength }`; an unknown harness is `404` |
| DELETE | `/coding/vault/:harness` | The same, now disconnected: the login is deleted |
| POST | `/coding/vault/:harness/login` | `LoginStatus`: starts the CLI's own sign-in in a short-lived workspace of the person's, ending one already under way, and answers once the CLI printed what the person needs: `state: "waiting_code"` with `url`, and for `codex` the `userCode` to enter there |
| GET | `/coding/vault/:harness/login` | `LoginStatus` of the sign-in under way, `state: "none"` without one. A `codex` sign-in ends by itself, so the web app polls this until it is `connected` or `failed` |
| POST | `/coding/vault/claude-code/login/code` | `{ code }`, the code the sign-in page shows. Pim hands it to the CLI on its standard input, waits for the CLI to save its login and keeps that in the vault: `state: "connected"`, or `failed` with `error`. `codex` takes no code here (`400`) |
| DELETE | `/coding/vault/:harness/login` | Ends the sign-in and deletes its workspace: `state: "none"` |

```ts
type LoginStatus = { harness: "claude-code" | "codex"; state: "none" | "starting" | "waiting_code" | "completing" | "connected" | "failed"; url: string | null; userCode: string | null; error: string | null };
```

Claude Code's sign-in is `claude auth login`: the person signs in at `url` and pastes the code the page shows. Codex's is `codex login --device-auth`: the person enters `userCode` at `url` (`https://auth.openai.com/codex/device`), and the CLI, which polls OpenAI meanwhile, exits once they have; Pim then keeps its login, and threads that waited for it go on.

No route returns or accepts a login's contents: Pim reads nothing the CLI prints but the URL and the code to enter, and keeps neither code nor what it prints. A guest's account has none (`403`).
