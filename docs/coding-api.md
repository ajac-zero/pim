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
  stateReason: string | null; // such as "budget", "no_backend", "aborted", "cancelled", "queue_expired:slots_full"
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
| POST | `/coding/threads/:id/steer` | `{ text, interrupt?, operationId? }` | `CodingThreadView`. During a turn the text joins it after its current tool round, or with `interrupt` stops it and starts a new turn with the text; between turns it starts the next one |
| POST | `/coding/threads/:id/abort` | | `CodingThreadView`: stops the turn under way and every command it runs, and withdraws inputs waiting |
| POST | `/coding/threads/:id/continue` | `{ budgetUsd?, operationId? }` | `CodingThreadView`: goes on after a failure or a stop, with a bigger budget if given |
| POST | `/coding/threads/:id/cancel` | | `CodingThreadView`: a thread whose task hasn't started yet (`queued` or `provisioning`) leaves the queue or gives its slot back, withdraws its inputs, and ends with `thread.turn_ended`, `outcome: "cancelled"`; it is then `idle` with `stateReason: "cancelled"`. Again, it changes nothing. A thread whose turn started: `not_cancellable` |
| POST | `/coding/threads/:id/archive` | | `CodingThreadView`: ends the thread, deleting its workspace. Reading it still works |
| POST | `/coding/threads/:id/push` | `{ branch? }` | `202` with `{ approval, status, branch, head, bytes, summary }`: asks the person to approve pushing the thread's latest checkpoint to `branch` (its own branch by default) on GitHub. `approval` is the id of the approval to decide with `POST /approvals/:id/approve` or `/deny`, as any other; `status` is `pending` until then. The same push asked again is the same approval. Pushing needs the thread's workspace running. Errors: `github_app_not_configured`, `push_refused`, `nothing_to_push`, `workspace_not_running` |

### The log

`CodingEvent` is `{ seq, kind, at, provider, model, input, output, cacheRead, cacheWrite, costUsd, data }`. `kind` is one of:

- `model_call`: one call to the model, with its tokens and cost (`data` null).
- `thread.queued`: `data: { position, reason }`, each time the thread waits for a slot.
- `thread.turn_started`: `data: { operationId }`.
- `thread.turn_ended`: `data: { type, threadId, space, operationId, outcome, reason?, checkpoint?, at }`, where `outcome` is `completed`, `error`, `cancelled` or `needs_approval`.
- `app.budget_stop`: `data: { budgetUsd, spentUsd }`.
- `thread.pushed`: `data: { repo, branch, before, after, outcome }`, where `outcome` is `created`, `updated` or `unchanged`.

### The live stream

`GET /coding/threads/:id/events` is newline-delimited JSON (`application/x-ndjson`), one object a line; with `Accept: text/event-stream` each object is an SSE `data:` line instead. The first is pi's `snapshot` of the conversation, then one `{ type: "events", events }` per change, and `{ type: "output", … }` for what the `bash` and `test` tools print as they run.

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
- `harness` is the coding agent that runs it: `pi` by default. `claude-code` and `codex` are accepted by the types but refused with `invalid` ("harness not yet available") until their adapters land.
- `chat` is the chat the thread is started from, for the chat list to show it under that chat. A thread an agent starts records its own chat, so it needs none.

## Agents

Every agent can start and follow threads with the `coding_*` tools ([`src/extensions/coding.ts`](../src/extensions/coding.ts)): `coding_start`, `coding_status`, `coding_steer`, `coding_diff`, `coding_tests`, `coding_abort`, `coding_push` and `coding_archive`. A thread an agent starts is `createdBy: { type: "agent", agent, chat }`, and when each of its turns ends that chat is woken with a message saying how it went. `coding_push` asks the person first, every time, as an approval like `POST …/push` files.
