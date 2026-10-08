# pim

An open-source personal agent you deploy to your own Cloudflare account. Inspired by Meta's [Muse](https://ai.meta.com/muse/): it remembers what matters to you, turns goals into plans, keeps working in the background, and asks before acting on the world.

Each deployment is one agent, for the one person who deployed it. There is no hosted, multi-user pim: if you want one, you deploy your own, and your conversations and memories stay in your Cloudflare account.

This repository is only the agent and its API. Chat apps, mobile apps, and messaging bridges are separate projects that talk to this API.

## How it works

```
 UI (web, mobile, bot)                    Cloudflare
┌─────────────────────┐   HTTPS / WS   ┌──────────────────────────────────────────────┐
│ REST + WebSocket    │───────────────▶│ Worker (src/index.ts): bearer-token auth     │
└─────────────────────┘                │   │ every request                            │
                                       │   ▼                                          │
                                       │ Durable Object "Pim" (src/agent.ts), just one│
                                       │  ├ PiHarness ── pi-durable runs, tasks, inbox│
                                       │  ├ Extensions: memory, goals, schedule,      │
                                       │  │   notify, approvals, web                  │
                                       │  ├ Scheduler (alarms) ── background wake-ups │
                                       │  └ SQLite: pi's tables + pim_* tables        │
                                       │        │                                     │
                                       │        ▼                                     │
                                       │ Workers AI / AI Gateway (env.AI)             │
                                       └──────────────────────────────────────────────┘
```

- **[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable)** runs the agent. Every model turn and tool call is a durable task committed to the Durable Object's SQLite before anything is shown. If the object is evicted mid-run, the `agents` SDK's `PiHarness` alarm wakes it, and pi resumes where it stopped.
- **One agent per deployment.** The Worker sends every request to a single Durable Object, which holds the whole agent in its SQLite database.
- **Workers AI** is the default model (`@cf/zai-org/glm-4.7-flash`), so no vendor API keys are needed. Any AI Gateway catalog model works too, such as `anthropic/claude-opus-4.8`.

## What the agent can do

| Capability | Tools | How |
| --- | --- | --- |
| Memory | `remember`, `recall`, `forget` | Facts are stored in the agent's database and included in the system prompt. You can list and delete them over the API. |
| Goals and plans | `create_goal`, `update_goal`, `list_goals` | Goals have step-by-step plans and progress notes. Active goals are always in the prompt. |
| Background work | `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` | Delays, dates, or cron. When a task fires, the agent receives a `[Scheduled task]` message in the session that scheduled it. |
| Reaching you | `notify_user` | Stored, pushed to connected sockets, and POSTed to an optional webhook. |
| Asking first | `http_request` | Gated: the call files an approval request. The action runs only when you approve, and the result is posted back into the conversation. |
| The web | `fetch_url`, `web_search` (opt-in) | `web_search` is billed by AI Gateway, so it is off until `PIM_WEB_SEARCH` names a provider. |
| Time | `current_time` | Shows UTC and the user's `PIM_TIME_ZONE`. |

## Deploy

On the Workers free plan, SQLite-backed Durable Objects and Workers AI's daily free allocation are enough for personal use.

```sh
pnpm install
pnpm wrangler login
pnpm wrangler secret put PIM_API_TOKEN      # any long random string; your UIs send it
pnpm wrangler secret put PIM_NOTIFY_WEBHOOK # optional
pnpm run deploy
```

Configuration lives in `vars` in `wrangler.jsonc`:

| Var | Default | Meaning |
| --- | --- | --- |
| `PIM_MODEL` | `@cf/zai-org/glm-4.7-flash` | Model for new sessions: a Workers AI id or an AI Gateway catalog id |
| `PIM_TIME_ZONE` | `UTC` | The person's IANA time zone |
| `PIM_WEB_SEARCH` | empty | `exa`, `ceramic`, or `linkup` enables `web_search` |

For local development, copy `.dev.vars.example` to `.dev.vars` and run `pnpm dev`. The `AI` binding is remote, so `wrangler dev` needs a Cloudflare login, and model calls bill that account.

## API

Every request except `GET /health` needs `Authorization: Bearer <PIM_API_TOKEN>`. Browser WebSockets can't set headers, so they pass `?token=<PIM_API_TOKEN>` instead. Sessions are separate conversations. The root session is `1`.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/health` | | `{ name: "pim", ok: true }`; no token needed |
| GET | `/` | | Model, time zone, root session, and tools (with `requiresApproval`) |
| GET | `/sessions` | | `{ sessions: [{ id, parent?, busy }] }` |
| POST | `/sessions` | | `{ id }` of a new session |
| GET | `/sessions/:s/messages` | | `{ busy, pending, messages }`: the transcript as display messages |
| POST | `/sessions/:s/messages` | `{ content, wait?, whenBusy?: "followUp" \| "steer", operationId? }` | `202` with a receipt `{ operationId, accepted }`, or the result `{ status, text?, reason? }` when `wait` is true |
| GET | `/sessions/:s/operations/:op` | `?timeout=ms` (max 60000) | The result once settled, or `{ status: "pending" }` |
| POST | `/sessions/:s/abort` | `{ operationId? }` | Withdraws one operation, or stops everything |
| POST | `/sessions/:s/reset` | `{ handoff? }` | Starts a fresh context; history stays stored |
| PUT | `/sessions/:s/model` | `{ model }` | Changes the session's model |
| GET, POST | `/memories` | `?q=keywords` / `{ content }` | Memories |
| DELETE | `/memories/:id` | | Forget one |
| GET | `/goals`, `/goals/:id` | `?status=active\|paused\|done\|abandoned` | Goals with steps and notes |
| DELETE | `/goals/:id` | | |
| GET | `/schedules` | | Pending scheduled tasks |
| DELETE | `/schedules/:id` | | Cancel one |
| GET | `/approvals`, `/approvals/:id` | `?status=pending\|approved\|denied` | Approval requests |
| POST | `/approvals/:id/approve`, `/approvals/:id/deny` | `{ note? }` | The decided approval; `409` if already decided |
| GET | `/notifications` | `?unread=true` | Notifications |
| POST | `/notifications/:id/read` | | Marks one read |

Submissions are idempotent by `operationId`. Retrying with the same id returns the same receipt and never starts a second run.

### WebSocket

Connect to `wss://<host>/ws?session=1&token=...`. Each socket follows one session. Message types are in [`src/protocol.ts`](src/protocol.ts).

- Server → client:
  - `hello`: the session and tools.
  - `events`: pi's [agent events](https://github.com/earendil-works/pi/tree/main/packages/durable#agent-events-experimental). The first batch starts with a `snapshot` that replaces client state.
  - `notification` and `approval`: sent to every socket.
  - `result` and `error`: replies to commands that carried an `id`.
- Client → server: `submit`, `abort`, `reset`, `resync`.

To fold events into a chat view, see the reducer in Cloudflare's [pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi/src/view.ts).

## Develop

```sh
pnpm test        # Vitest in workerd, with pi-ai's faux model; no Cloudflare account needed
pnpm typecheck
pnpm types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

To add a tool, write a pi extension in `src/extensions/` and install it in `Pim`'s harness factory. A tool with effects outside the conversation should be a `GatedAction` (see `src/extensions/approvals.ts`) so it runs only after approval.

## Not built yet

- App connectors (email, calendar) through MCP servers with OAuth, via the `agents` SDK's MCP client.
- A sandboxed computer and browser for the agent: Cloudflare Containers or Browser Rendering.
- Tools the agent writes for itself, run in Dynamic Workers (codemode).
- Secret placeholders, so approved requests can use credentials the model never sees.
- Semantic memory search with Vectorize.
