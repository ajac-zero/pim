# pim

An open-source personal agent you deploy to your own Cloudflare account. Inspired by Meta's [Muse](https://ai.meta.com/muse/): it remembers what matters to you, turns goals into plans, keeps working in the background, and asks before acting on the world.

Each deployment is one agent, for the one person who deployed it: your conversations and memories stay in your Cloudflare account. The same code also runs **Pimling**, a hosted service where each person gets their own Pim at `<username>.<domain>` (see [Hosting Pimling](docs/hosting.md)). Nothing about hosting is needed to self-host.

This repository is the agent, its API, and its web app ([`web/`](web)): chat, approvals, notifications and settings, signed in with a passkey. One Worker serves all of it. Mobile apps and messaging bridges can use the same API with an API token.

## How it works

```
 Browser, bot, app                        Cloudflare
┌─────────────────────┐   HTTPS / WS   ┌──────────────────────────────────────────────┐
│ web app, or REST +  │───────────────▶│ Worker (src/index.ts)                        │
│ WebSocket at /api   │                │  ├ /*       the web app (web/, static files) │
└─────────────────────┘                │  ├ /auth/*  passkeys (Durable Object "Auth") │
                                       │  └ /api/*   passkey session or API token     │
                                       │   │                                          │
                                       │   ▼                                          │
                                       │ Durable Object "Pim" (src/agent.ts), just one│
                                       │  ├ PiHarness ── pi-durable runs, tasks, inbox│
                                       │  ├ Extensions: optmem, goals, schedule,      │
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
- **Your ChatGPT plan**, optionally. Sign in with ChatGPT (Plus or Pro) and Pim runs on OpenAI's models, such as GPT-6.1 Sol, using the plan's included usage. See [ChatGPT plan](#chatgpt-plan).

## What the agent can do

| Capability | Tools | How |
| --- | --- | --- |
| Long-term memory | `note`, `recall`, `zoom`, `forget` | OptMem-style: an append-only log, compressed in the background into a tree of summaries. Every conversation sees a fixed-size view of it. See [Memory](#memory). |
| Goals and plans | `create_goal`, `update_goal`, `list_goals` | Goals have step-by-step plans and progress notes. Active goals are always in the prompt. |
| Background work | `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` | Delays, dates, or cron. When a task fires, the agent receives a `[Scheduled task]` message in the session that scheduled it. |
| Reaching you | `notify_user` | Stored, pushed to connected sockets, sent as Web Push to browsers that turned it on in Settings (even with the app closed), and POSTed to an optional webhook. |
| Asking first | `http_request` | Gated: the call files an approval request. The action runs when you approve; deny to stop it. Without an answer, the approval policy decides: `auto` approves after 30 seconds so autonomous jobs never block, `explicit` denies after 5 minutes so nothing happens without a yes. The call waits for your answer, and the result comes back within the same turn. Choose **Always approve** and later calls to that tool run without asking; Settings lists those tools and takes them back. |
| Connected apps | `connect_app` (gated), `list_apps`, plus each app's tools | Remote MCP servers, with OAuth sign-in. Tools that don't declare themselves read-only need approval. See [Connected apps](#connected-apps). |
| App skills | `read_skill`, `read_skill_file` | Instructions apps publish over the MCP Skills extension, checked against the app's digests. |
| App events | `list_app_events`, `watch_app_event` (gated), `list_watches`, `stop_watch` | Apps notify Pim when something happens (draft MCP Events, webhooks); each event starts a run with the watch's instruction. |
| The web | `fetch_url`, `web_search` (opt-in) | `web_search` is billed by AI Gateway, so it is off until `PIM_WEB_SEARCH` names a provider. |
| Time | `current_time` | Shows UTC and the user's `PIM_TIME_ZONE`. |

## Deploy

On the Workers free plan, SQLite-backed Durable Objects and Workers AI's daily free allocation are enough for personal use.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ajac-zero/pim)

The button copies this repository to your GitHub account and deploys it to your Cloudflare account. It asks for nothing. Then open the Worker's URL and create your passkey: your face, fingerprint, or PIN. That's the whole setup.

- **The first passkey** can be made that way for 15 minutes after a deploy, and only if this Pim has never had one. Until you create it, whoever opens the URL first could, so open it right after deploying. If someone else gets there first, you'll see the sign-in screen instead of setup. Get a setup link from the logs (below), then remove the passkey you didn't make in Settings. The Worker logs when the first passkey was made.
- **More passkeys** (your phone, another browser) come from Settings.
- **Missed the 15 minutes, or lost every passkey?** The sign-in screen has the Worker write a one-time setup link to its logs, which only someone signed in to your Cloudflare account can read. In the dashboard, open Workers & Pages, then `pim`, then Observability, and open the link in the log that starts with "Pim setup link". It works once, for an hour.

Sessions last 30 days, and removing a passkey signs out the browsers it signed in. API tokens for other clients are made in Settings (`POST /auth/tokens` with a passkey session) and revoked there. Passkeys belong to the hostname the app is served from, so moving Pim to another domain means creating new ones.

Or from a checkout:

```sh
pnpm install
pnpm wrangler login
pnpm wrangler secret put PIM_API_TOKEN      # optional: for clients other than the web app
pnpm wrangler secret put PIM_NOTIFY_WEBHOOK # optional
pnpm run deploy                             # builds web/ first
```

Open the URL `wrangler deploy` prints to create your passkey. With the CLI, `pnpm wrangler tail` shows setup links as the sign-in screen asks for them.

Configuration lives in `vars` in `wrangler.jsonc`:

| Var | Default | Meaning |
| --- | --- | --- |
| `PIM_MODEL` | `@cf/zai-org/glm-4.7-flash` | Model for new sessions: a Workers AI id or an AI Gateway catalog id |
| `PIM_TIME_ZONE` | `UTC` | The person's IANA time zone |
| `PIM_WEB_SEARCH` | empty | `exa`, `ceramic`, or `linkup` enables `web_search` |
| `PIM_MEMORY_MODEL` | empty | Model that compresses memories; empty uses `PIM_MODEL`, never the ChatGPT plan |
| `PIM_MEMORY_LINES` | `96` | Lines of long-term memory in every prompt (about 8k tokens) |
| `PIM_PUBLIC_URL` | empty | Public URL apps deliver events to; empty uses the origin of your API requests |
| `PIM_APPROVAL_POLICY` | `auto` | What an unanswered approval becomes: `auto` approves it after 30 seconds, `explicit` denies it after 5 minutes. You can change it in Settings |
| `PIM_MODELS` | empty | Workers AI or AI Gateway models sessions may use besides `PIM_MODEL`, comma-separated; empty allows any |
| `PIM_LIMITS` | empty | Usage limits as JSON, such as `{"dailyTokens": 2000000, "dailyRuns": 500}`; empty is none. Every limit is in [`src/usage.ts`](src/usage.ts) |

`PIM_TIME_ZONE` and `PIM_APPROVAL_POLICY` are defaults: your own choices in Settings (`PUT /settings`) take their place.

For local development, copy `.dev.vars.example` to `.dev.vars` and run `pnpm dev`: the Worker and the built web app at `http://localhost:8787`. Its first 15 minutes count as just deployed, and setup links show up in the terminal. For the web app with hot reload, also run `PIM_API_TOKEN=... pnpm dev:web` (port 3000), which signs in with the token. The `AI` binding is remote, so `wrangler dev` needs a Cloudflare login, and model calls bill that account.

## API

The API lives under `/api`: `GET /api/sessions`, and so on; the table leaves out the prefix. The web app calls it with its passkey session. Other clients send `Authorization: Bearer <token>`: a token made in Settings (API tokens), or `PIM_API_TOKEN` once you set that secret. WebSockets from clients that can't set headers pass `?token=<token>` instead. Only the two paths connected apps call stay at the root, without the prefix: `/mcp/callback` and `/mcp/events/:watch`. Sessions are separate conversations. The root session is `1`.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/health` | | `{ name: "pim", ok: true }`; no token needed; also at the root |
| GET | `/` | | Model, time zone, root session, and tools (with `requiresApproval`) |
| GET | `/sessions` | | `{ sessions: [{ id, title, busy, createdAt, updatedAt }] }`, most recently active first; `title` is the start of the user's first message until renamed |
| POST | `/sessions` | `{ title? }` | A new session |
| PUT | `/sessions/:s` | `{ title }` | Renames it |
| GET | `/sessions/:s/messages` | | `{ busy, pending, messages }`: the transcript as display messages |
| POST | `/sessions/:s/messages` | `{ content, wait?, whenBusy?: "followUp" \| "steer", operationId? }` | `202` with a receipt `{ operationId, accepted }`, or the result `{ status, text?, reason? }` when `wait` is true |
| GET | `/sessions/:s/operations/:op` | `?timeout=ms` (max 60000) | The result once settled, or `{ status: "pending" }` |
| POST | `/sessions/:s/abort` | `{ operationId? }` | Withdraws one operation, or stops everything |
| POST | `/sessions/:s/reset` | `{ handoff? }` | Starts a fresh context; history stays stored |
| PUT | `/sessions/:s/model` | `{ model }` | Changes one session's model: a Workers AI or AI Gateway id |
| GET | `/settings` | | `{ timeZone, approvalPolicy, approvalTimeoutSeconds, notifyWebhook }` |
| PUT | `/settings` | Any of `{ timeZone, approvalPolicy, notifyWebhook }`; `null` goes back to the deployment's | The settings |
| GET | `/usage` | | `{ limits, today, history, storageBytes }`: model requests, tokens (the ChatGPT plan's apart) and runs by UTC day |
| GET | `/export` | | Everything as one JSON download, without credentials |
| GET | `/model` | | `{ model, default, choices, chatgpt: { connected, email, error } }`: the model every session uses, and the ones you can choose |
| PUT | `/model` | `{ provider, id }`, one of `choices` | Moves every session, and new ones, to that model |
| GET | `/chatgpt` | | `{ connected, email }` |
| POST | `/chatgpt/login` | | `{ url }` to open in a browser, to sign in with ChatGPT |
| POST | `/chatgpt/callback` | `{ url }`: the `http://127.0.0.1:1455/...` address the browser landed on | `{ connected, email }` |
| DELETE | `/chatgpt` | | Disconnects; sessions on a ChatGPT model go back to the default |
| GET | `/memory` | | `{ count, pendingCompressions, view }`: the view is what the model sees |
| GET | `/memory/log` | `?q=regex` or `?before=id`, `?limit=` | Raw memories, newest first |
| POST | `/memory/log` | `{ text }` (one line, ≤ 280 bytes) | Records a memory as the user |
| DELETE | `/memory/log/:id` | | Forgets one memory and rebuilds the summaries over it |
| GET | `/memory/tree/:block` | a block such as `0-15` | Its summary and its two halves |
| DELETE | `/memory/tree/:block` | | Drops a bad summary and those built on it; they are rebuilt |
| GET | `/goals`, `/goals/:id` | `?status=active\|paused\|done\|abandoned` | Goals with steps and notes |
| DELETE | `/goals/:id` | | |
| GET | `/schedules` | | Pending scheduled tasks |
| DELETE | `/schedules/:id` | | Cancel one |
| GET | `/approvals`, `/approvals/:id` | `?status=pending\|approved\|denied` | Approval requests; each says what its timeout decides (`onTimeout`) and who decided it (`decidedBy`: `user`, `timeout` or `always`) |
| POST | `/approvals/:id/approve`, `/approvals/:id/deny` | `{ note? }` | The decided approval; `409` if already decided |
| POST | `/approvals/:id/approve` | `{ note?, always: true }` | Also approves every later call to the same tool (the approval's `tool`), and other pending calls to it |
| GET | `/always-approved` | | `{ tools: [{ tool, createdAt }] }`: tools whose calls are approved without asking |
| DELETE | `/always-approved/:tool` | | Asks before that tool again; `404` if it was not always approved |
| GET | `/mcp` | | Connected apps, their state, sign-in link, approval policy and tools |
| POST | `/mcp` | `{ name, url, headers?, approval? }` | Connects an app; `201` with `{ id, state, authUrl? }` (`authUrl`: send the user there to sign in) |
| PUT | `/mcp/:id` | `{ approval: "writes" \| "all" \| "none" }` | Which of its tools need approval |
| DELETE | `/mcp/:id` | | Disconnects it |
| GET | `/mcp/callback` (root, no `/api`) | | Where an app's sign-in returns; no token needed |
| GET | `/mcp/:id/skills`, `/mcp/:id/events` | | The skills and watchable events an app offers |
| GET | `/watches` | | Event watches: app, event, instruction, state, next renewal |
| DELETE | `/watches/:id` | | Stops a watch and unsubscribes |
| POST | `/mcp/events/:watch` (root, no `/api`) | Standard Webhooks-signed event | Where apps deliver events; no token needed, the signature is checked |
| GET | `/notifications` | `?unread=true` | Notifications |
| POST | `/notifications/:id/read` | | Marks one read |
| GET | `/push/key` | | The VAPID public key browsers subscribe with (made on first use) |
| PUT | `/push/subscription` | `{ endpoint, p256dh, auth }` | Subscribes a browser to Web Push |
| DELETE | `/push/subscription` | `{ endpoint }` | Unsubscribes it |

Submissions are idempotent by `operationId`. Retrying with the same id returns the same receipt and never starts a second run.

### WebSocket

Connect to `wss://<host>/api/ws?session=1` (add `&token=...` without a passkey session). Each socket follows one session. Message types are in [`src/protocol.ts`](src/protocol.ts).

- Server → client:
  - `hello`: the session and tools.
  - `events`: pi's [agent events](https://github.com/earendil-works/pi/tree/main/packages/durable#agent-events-experimental). The first batch starts with a `snapshot` that replaces client state.
  - `notification` and `approval`: sent to every socket.
  - `result` and `error`: replies to commands that carried an `id`.
- Client → server: `submit`, `abort`, `reset`, `resync`.

To fold events into a chat view, see the reducer in Cloudflare's [pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi/src/view.ts).

## Memory

Long-term memory follows Victor Taelin's [OptMem](https://github.com/VictorTaelin/OptMem), reimplemented as a pi-durable extension in [`src/extensions/optmem`](src/extensions/optmem).

- **The log is the truth.** The agent records one-line memories (up to 280 bytes) with `note` as it learns things. Memories are numbered in order and never edited.
- **Summaries form a binary tree.** Block `#0-1` summarizes memories 0 and 1, `#0-3` summarizes `#0-1` and `#2-3`, and so on. A background pi task compresses each block as soon as it is complete, smallest first: blocks up to 16 memories from the raw lines, larger ones from their two halves. The tree is a cache; any summary can be dropped and rebuilt.
- **The view has a fixed size.** Every conversation's prompt holds `PIM_MEMORY_LINES` lines: the newest memories verbatim, older ones as summaries that get coarser with age. The model gets back detail with `recall` (a regular expression over the whole log) and `zoom` (a block's two halves).
- **Forgetting is real.** `forget` blanks the memory, keeping its number, and drops every summary built over it; they are rebuilt without it. A summary that was being written when a memory was forgotten is discarded.

Where pim differs from OptMem:

- The view is a prompt section rather than a `wake` command, so the model always has it.
- Compression runs in a durable background task instead of interrupting the conversation.
- OptMem never deletes; pim lets you forget.

### Memory and the prompt cache

pi never edits what it already sent, so the provider's prompt cache keeps hitting. A changed system-prompt section is appended to the transcript as a whole new copy, and old copies stay until a compaction writes a fresh baseline. The memory is built to change that prompt as little as possible:

- **A conversation keeps the view it was first shown.** Most requests add nothing to the prompt.
- **Notes a conversation takes itself** are already in its transcript, so they trigger nothing.
- **Memories from elsewhere** (the API, other sessions) are listed in a small `memory_since` section after the view. When the list changes, only the list is re-sent.
- **The view is re-rendered only when:**
  - a memory is forgotten, so the old view stops showing it;
  - more than an eighth of the view (at least 4 memories) piles up in `memory_since`;
  - a full view's worth of memories has arrived since it was shown.
- **Compaction** writes every section again anyway, and the old view goes with the compacted entries, so the conversation gets a fresh view at no extra cost.

The same rule applies to every section: one that appears later than sections after it makes pi remove and re-send all of them. That is why `active_goals` says "No active goals." instead of disappearing.

Forgetting removes a memory from the log, the tree, and future views. It does not erase the conversation where it came up: that stays in the session's transcript until you reset the session.

## ChatGPT plan

Pim supports OpenAI's [ChatGPT plan usage for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source): sign in with ChatGPT, and requests to OpenAI models count against your Plus or Pro plan's included usage instead of an API bill. ChatGPT's settings show Pim's usage and let you cap it.

OpenAI only redirects a sign-in to a loopback address (`http://127.0.0.1:1455/...`), which can't reach a Worker. So the sign-in has a paste step:

1. `POST /chatgpt/login` returns a URL. Open it, sign in, and approve Pim.
2. The browser lands on a `http://127.0.0.1:1455/auth/callback?code=...` page that doesn't load. Copy that whole address.
3. `POST /chatgpt/callback` with `{ url }`. Pim exchanges the code (with PKCE), checks the ID token against OpenAI's keys, and stores the tokens in its database.
4. `PUT /model` with one of `GET /model`'s choices, such as `{ "provider": "openai", "id": "gpt-6.1-sol" }`.

Pim registers with OpenAI as one agent host (a `urn:uuid:` ID it keeps) and refreshes the token itself, one refresh at a time, since OpenAI rotates refresh tokens. Memory compression stays on `PIM_MODEL`, so background work doesn't spend the plan. pi-ai sends these requests the way the flow requires: `store: false`, streaming, and no `temperature` or `max_output_tokens`.

## Connected apps

Apps connect through remote [MCP](https://modelcontextprotocol.io) servers: the vendor's own (many apps publish one), or one you deploy as another Worker. The `agents` SDK's MCP client handles the connection, OAuth sign-in (with dynamic client registration), token storage in the agent's database, and reconnecting after a wake.

- **Connecting.** `POST /mcp` with a name and URL, or ask Pim: its `connect_app` tool files an approval, and the connection is made when you approve. If the app needs sign-in, the response (or Pim) gives you a link; the app sends you back to `/mcp/callback`.
- **Finding the server.** Say "connect my Linear" and Pim's `find_app` tool looks the app up in the official [MCP Registry](https://registry.modelcontextprotocol.io). The registry verifies publishers (`app.linear/...` only by whoever controls linear.app), so Pim ranks first the server whose publisher's domain names the app and that runs on that domain, like `https://mcp.linear.app/mcp`. Gateways that relay the app through someone else's server come after, labeled as third parties, and Pim says who runs one before offering it. Remotes that need a URL template or an API key header are left out.
- **Tools.** Each MCP tool becomes a pi tool named `<app>_<tool>`. pi picks up added and removed tools from the next request, without a restart. The app's instructions go in the `connected_apps` prompt section.
- **Approvals.** With the default `writes` policy, tools that do not declare `readOnlyHint` file an approval like `http_request`, and the call is made when you approve. `all` gates every tool; `none` trusts the app. The read-only hint comes from the app itself, so only connect apps you trust.
- **Prompt cache.** The apps' tools come last in pi's tool list, so a newly connected app's tools are appended to what the provider has cached instead of re-sending every tool. Changing an app's approval policy changes its tools' descriptions, which re-sends the tool list once.

### Skills from apps

Apps that implement the [MCP Skills extension](https://modelcontextprotocol.io/extensions/skills/overview) (`io.modelcontextprotocol/skills`) ship instructions for using them as [Agent Skills](https://agentskills.io). pim reads an app's `skills/list` when it connects and again when the listing's TTL runs out, and lists each skill's name and description under the app in the prompt. The model loads one with `read_skill`, and supporting files with `read_skill_file`.

- Every file is checked against the SHA-256 digest and size the app published; a mismatch re-reads the listing once, so an app that updated a skill is picked up, and content that still doesn't match is refused.
- Skill content is labeled with the app it came from, as the extension requires: it is the app's text, not the user's.
- pim runs no code from skills. Anything a skill tells the model to do goes through the app's tools and their approvals.

### Events from apps

Apps that implement the draft [MCP Events](https://github.com/modelcontextprotocol/experimental-ext-triggers-events) extension can tell Pim when something happens: a price changed, a message arrived. pim supports webhook delivery, the same slice ChatGPT implements.

- **Watching.** Ask Pim ("tell me when the JFK–Lisbon price drops below $500"); `watch_app_event` files an approval naming the app, the event and the instruction. Once approved, pim calls `events/subscribe` with a callback URL (`/mcp/events/<watch>`) and a fresh signing secret, and renews the subscription before the app's grant runs out.
- **Receiving.** Each delivery must carry a valid Standard Webhooks signature from the last five minutes. The event becomes a message to the conversation that created the watch, with the instruction and the event data marked as untrusted. The event id is its idempotency key, so a delivery the app retries starts one run, not two.
- **Ending.** `stop_watch` or `DELETE /watches/:id` unsubscribes. A watch the app terminates, or refuses to renew, ends with a notification. Removing an app stops its watches.
- **Draft.** The extension is not ratified. Today's MCP SDKs drop its `events` capability from the handshake, so pim also asks an app for `events/list` when it declares nothing.

MCP servers expose tools, prompts and resources; pim uses their tools, instructions and skills. They cannot add hooks or change how pim runs, which is also what keeps them safe to connect.

## Develop

```sh
pnpm test        # Vitest in workerd (self-hosted and Pimling Workers), with pi-ai's faux model, then the web app's tests; no Cloudflare account needed
pnpm test:live   # live checks against real MCP servers (Hugging Face's); needs the network
pnpm typecheck   # also generates the web app's route tree, so it works on a fresh checkout
pnpm types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

The web app is in [`web/`](web), with its own README. Passkey sign-in is in [`src/auth/`](src/auth).

To add a tool, write a pi extension in `src/extensions/` and install it in `Pim`'s harness factory. A tool with effects outside the conversation should be a `GatedAction` (see `src/extensions/approvals.ts`) so it runs only after approval.

## Not built yet

- Falling back to `PIM_MODEL` when the ChatGPT plan's usage limit is reached. Until then, a run that hits the limit fails with OpenAI's error.
- A sandboxed computer and browser for the agent: Cloudflare Containers or Browser Rendering.
- Extensions beyond MCP: Agent Skills, and full pi extensions that Pim builds into itself by redeploying its own Worker.
- Secret placeholders, so approved requests can use credentials the model never sees.
- Semantic recall. `recall` is a regular expression over the log, so it finds words, not meanings.
