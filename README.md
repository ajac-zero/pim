# pim

An open-source personal agent you deploy to your own Cloudflare account. Inspired by Meta's [Muse](https://ai.meta.com/muse/): it remembers what matters to you, turns goals into plans, keeps working in the background, and asks before acting on the world.

A deployment is a Pim for you and the people you invite: family, friends, a small team. Each person gets their own agent, with their own conversations, memories and connected apps, and can share it with the others. You run it, and everything stays in your Cloudflare account. The name is [pi](https://github.com/earendil-works/pi), the harness it runs on, plus **m** for multiplayer.

This repository is the agent, its API, and its web app ([`web/`](web)): chat, approvals, notifications and settings, signed in with a passkey. One Worker serves all of it, for everyone, at one address. Mobile apps and messaging bridges can use the same API with an API token.

## How it works

```
 Browser, bot, app                        Cloudflare
┌─────────────────────┐   HTTPS / WS   ┌──────────────────────────────────────────────┐
│ web app, or REST +  │───────────────▶│ Worker (src/index.ts, src/gateway.ts)        │
│ WebSocket at /api   │                │  ├ /*       the web app (web/, static files) │
└─────────────────────┘                │  ├ /auth/*  joining, passkeys                │
                                       │  └ /api/*   whoever the session or token     │
                                       │   │         names                            │
                                       │   ▼                                          │
                                       │ Durable Object "Pim" (src/agent.ts), one per │
                                       │ person, named by their owner ID              │
                                       │  ├ PiHarness ── pi-durable runs, tasks, inbox│
                                       │  ├ Extensions: optmem, goals, schedule,      │
                                       │  │   messaging, approvals, web               │
                                       │  ├ Scheduler (alarms) ── background wake-ups │
                                       │  └ SQLite: pi's tables + pim_* tables        │
                                       │        │                                     │
                                       │        ▼                                     │
                                       │ Workers AI / AI Gateway (env.AI)             │
                                       │                                              │
                                       │ "Auth", one per person: passkeys, tokens     │
                                       │ "Directory": accounts, the admin, invites    │
                                       │ "Gallery": profiles, published Pims          │
                                       └──────────────────────────────────────────────┘
```
- **[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable)** runs the agent. Every model turn and tool call is a durable task committed to the Durable Object's SQLite before anything is shown. If the object is evicted mid-run, the `agents` SDK's `PiHarness` alarm wakes it, and pi resumes where it stopped.
- **One agent per person.** The Worker reads whose request it is from the passkey session or the API token, and sends it to that person's Durable Object, which holds their whole agent in its SQLite database. A URL never chooses whose agent answers. See [docs/instance.md](docs/instance.md).
- **A model that can do the job.** Pim decides what to say and when, and says it with a tool call, so it needs a capable model. The default is GLM-5.3 on Workers AI (`@cf/zai-org/glm-5.3`), billed to your Cloudflare account, with no vendor keys. Any AI Gateway catalog model works too, such as `anthropic/claude-opus-4.8` (set `PIM_MODEL`), or OpenAI's through your ChatGPT plan.
- **Your ChatGPT plan**, optionally. Sign in with ChatGPT (Plus or Pro) and Pim runs on OpenAI's models, such as GPT-6.1 Sol, using the plan's included usage. See [ChatGPT plan](#chatgpt-plan).

## What the agent can do

| Capability | Tools | How |
| --- | --- | --- |
| Long-term memory | `note`, `recall`, `zoom`, `forget` | OptMem-style: an append-only log, compressed in the background into a tree of summaries. Every conversation sees a fixed-size view of it. See [Memory](#memory). |
| Artifacts | `artifact_create`, `artifact_update`, `artifact_read`, `artifact_list` | Documents and small HTML pages the agent makes for you, with every version kept. They show in the chat and in Artifacts, run in a sandbox apart from your account, and can be restored or downloaded. See [docs/artifacts.md](docs/artifacts.md). |
| Goals and plans | `create_goal`, `update_goal`, `list_goals` | Goals have step-by-step plans and progress notes. Active goals are always in the prompt. |
| Background work | `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` | Delays, dates, or cron. When a task fires, the agent receives a `[Scheduled task]` message in the session that scheduled it. |
| Talking to you | `send_to_user` | The only way Pim speaks: you see what it sends, and none of its working notes, so background work can stay silent. A message can carry up to four widgets, such as your goals or what's coming up, drawn by the app from your data as it is when sent; the model names them instead of retyping what they show (see [docs/extensions.md](docs/extensions.md#in-chat)). A message goes to the conversation, or to your email when the deployment can send it (see [Email](#email)). With `notify`, it is also stored as a notification, pushed to connected sockets, sent as Web Push to browsers that turned it on in Settings (even with the app closed), and POSTed to an optional webhook. |
| Asking first | `http_request` | Gated: the call files an approval request and returns at once; your apps and devices are told. The action runs when you approve; deny to stop it. Either way the decision, with the result, comes back to the conversation as a message, so Pim carries on when you answer, however long you take. Without an answer, the approval policy decides: `auto` approves after 30 seconds so autonomous jobs never stall, `explicit` waits for you, so nothing happens without a yes. Choose **Always approve** and later calls to that tool run without asking. Settings → Tool permissions sets each such tool, and each app's tool, to Off, Ask or On (see [Tool permissions](#tool-permissions)). |
| Connected apps | `connect_app`, `list_apps`, `find_app`, plus each app's tools | Remote MCP servers, with OAuth sign-in. A chat works only with the apps its Pim lists. Tools that don't declare themselves read-only need approval. See [Connected apps](#connected-apps). |
| App skills | `read_skill`, `read_skill_file` | Instructions apps publish over the MCP Skills extension, checked against the app's digests. |
| App events | `list_app_events`, `watch_app_event` (gated), `list_watches`, `stop_watch` | Apps notify Pim when something happens (draft MCP Events, webhooks); each event starts a run with the watch's instruction. |
| The web | `fetch_url`, `web_search` (opt-in) | `web_search` is billed by AI Gateway, so it is off until `PIM_WEB_SEARCH` names a provider. |
| Time | `current_time` | Shows UTC and the user's `PIM_TIME_ZONE`. |

## Deploy

Pim's Durable Objects run on the Workers free plan, but the default model, GLM-5.3 on Workers AI, needs the Workers Paid plan or prepaid AI Gateway credits. For a free first look, set `PIM_MODEL` to `@cf/zai-org/glm-4.7-flash`, which runs on Workers AI's daily free allocation but is not good enough for real use; or connect a ChatGPT plan in Settings.

Images people send in chats are kept in an R2 bucket, which deploying creates. R2 has to be turned on for the account first: in the dashboard, open Storage & databases, then R2, and add the R2 subscription. Its free tier covers 10 GB, but Cloudflare asks for a payment method.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ajac-zero/pim)

The button copies this repository to your GitHub account and deploys it to your Cloudflare account. It asks for nothing. Then open the Worker's URL, pick a username, save your recovery codes and create your passkey: your face, fingerprint, or PIN. You're the admin of this Pim. That's the whole setup.

- **The first account** can be made that way for 15 minutes after a deploy, and it is the admin's. Until you make it, whoever opens the URL first could, so open it right after deploying. Missed the 15 minutes? The sign-in screen has the Worker write a one-time setup link to its logs, which only someone signed in to your Cloudflare account can read. In the dashboard, open Workers & Pages, then `pim`, then Observability, and open the link in the log that starts with "Pim setup link". It works once, for an hour.
- **Inviting people.** Settings → People on this Pim → Invite someone makes a link that lets one person join. With `PIM_REGISTRATION` set to `open`, anyone who finds the address can; `closed` lets nobody in.
- **More passkeys** (your phone, another browser) come from Settings.
- **Lost every passkey?** Each person got ten recovery codes when they joined; one, with their username, adds a new passkey. The admin can make anyone a setup link in Settings, and gets one for themselves from the logs, as above.

Sessions last 30 days, and removing a passkey signs out the browsers it signed in. API tokens for other clients are made in Settings (`POST /auth/tokens` with a passkey session) and revoked there. Passkeys belong to the hostname the app is served from, so moving Pim to another domain means creating new ones.

Or from a checkout:

```sh
pnpm install
pnpm wrangler login
pnpm run deploy        # builds web/ first
```

Open the URL `wrangler deploy` prints to set it up. With the CLI, `pnpm wrangler tail` shows setup links as the sign-in screen asks for them.

Configuration lives in `vars` in `wrangler.jsonc`:

| Var | Default | Meaning |
| --- | --- | --- |
| `PIM_MODEL` | `@cf/zai-org/glm-5.3` | Model for new sessions: a Workers AI id or an AI Gateway catalog id |
| `PIM_TIME_ZONE` | `UTC` | IANA time zone for anyone who hasn't set theirs; joining sets the browser's |
| `PIM_WEB_SEARCH` | empty | `exa`, `ceramic`, or `linkup` enables `web_search` |
| `PIM_MEMORY_MODEL` | empty | Model that compresses memories; empty uses `PIM_MODEL`, never the ChatGPT plan |
| `PIM_MEMORY_LINES` | `96` | Lines of long-term memory in every prompt (about 8k tokens) |
| `PIM_PUBLIC_URL` | empty | This Pim's public URL, for apps' callbacks and the links it makes; empty uses the address requests come to |
| `PIM_APPROVAL_POLICY` | `auto` | What an unanswered approval becomes: `auto` approves it after 30 seconds, `explicit` waits for an answer however long. Each person can change theirs in Settings |
| `PIM_MODELS` | empty | Workers AI or AI Gateway models sessions may use besides `PIM_MODEL`, comma-separated; empty allows any |
| `PIM_LIMITS` | empty | Usage limits for members as JSON, such as `{"dailyTokens": 2000000, "dailyRuns": 500}`; empty is none. The admin has none. Every limit is in [`src/usage.ts`](src/usage.ts) |
| `PIM_REGISTRATION` | `invite` | How people join once there is an admin: `invite` (links the admin makes), `open` or `closed` |
| `PIM_MAX_ACCOUNTS` | empty | Accounts allowed in all; empty for no cap |
| `PIM_REGISTRATIONS_PER_ADDRESS` | `3` | Accounts one IP address may make in a day |

`ratelimits` in `wrangler.jsonc` slow down sign-in attempts from one address and API requests from one person; leave them out and nothing is slowed down. Their namespace IDs must be unique in your Cloudflare account.

### Email

Pim can email each person, when they ask for it or for something worth keeping, such as a report. It's off until you set it up with [Cloudflare Email Service](https://developers.cloudflare.com/email-service/): onboard a domain for Email Sending, then add to `wrangler.jsonc`

```jsonc
"send_email": [{ "name": "EMAIL" }],
```

and set `PIM_EMAIL_FROM` in `vars` to an address on that domain, such as `pim@example.com`. Each person then adds their address in Settings and confirms it with a code Pim emails there; Pim only ever emails that one address, at most 50 times a day.

`PIM_TIME_ZONE` and `PIM_APPROVAL_POLICY` are defaults: each person's own choices in Settings (`PUT /settings`) take their place.

For local development, run `pnpm dev`: the Worker and the built web app at `http://localhost:8787` (use `localhost`: passkeys don't work on an IP address). Its first 15 minutes count as just deployed, so the first account you make is the admin, and setup links show up in the terminal. For the web app with hot reload, make an API token in Settings and run `PIM_API_TOKEN=... pnpm dev:web` (port 3000), which signs in with it. The `AI` binding is remote, so `wrangler dev` needs a Cloudflare login, and model calls bill that account. `pnpm preview` runs the same Pim with no Cloudflare login and a stand-in model, at the same address.

## API

The API lives under `/api`: `GET /api/sessions`, and so on; the table leaves out the prefix. It is the signed-in person's own Pim. The web app calls it with its passkey session. Other clients send `Authorization: Bearer <token>`, with a token made in Settings (API tokens), which names its owner (`pim_<owner>_…`). WebSockets from clients that can't set headers pass `?token=<token>` instead. Only the two paths connected apps call stay at the root, without the prefix, and name whose agent they are for: `/mcp/callback/:owner` and `/mcp/events/:owner/:watch`. Sessions are separate conversations. The root session is `1`.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/health` | | `{ name: "pim", ok: true }`; no token needed; also at the root |
| GET | `/` | | Model, time zone, root session, and tools (with `requiresApproval`) |
| GET | `/sessions` | | `{ sessions: [{ id, title, busy, createdAt, updatedAt }] }`, most recently active first; `title` is the start of the user's first message until renamed |
| POST | `/sessions` | `{ title? }` | A new session |
| PUT | `/sessions/:s` | `{ title }` | Renames it |
| GET | `/sessions/:s/messages` | | `{ busy, pending, messages }`: the transcript as display messages |
| POST | `/sessions/:s/messages` | `{ content, wait?, whenBusy?: "followUp" \| "steer", operationId? }`. `content` is text, or an array of `{ type: "text", text }` and `{ type: "image", data, mimeType }` parts: up to 4 PNG, JPEG, WebP or GIF images, base64, at most 5 MB each. Images are kept in R2; the transcript shows each as `{ type: "image", mimeType, url }`. Models on the OpenAI Responses and Anthropic Messages APIs fetch them from a signed URL (`/images/<owner>/<id>`, valid 15 minutes) when Pim has a public HTTPS address; any other model gets them inline | `202` with a receipt `{ operationId, accepted }`, or the result `{ status, replies, text?, reason? }` when `wait` is true. `replies` is what Pim sent you, in order; `text` is its final notes, which only stand in as the reply when it sent nothing |
| GET | `/images/:id` | | An image sent in a chat, by the `url` its message keeps |
| GET | `/sessions/:s/operations/:op` | `?timeout=ms` (max 60000) | The result once settled, or `{ status: "pending" }` |
| POST | `/sessions/:s/abort` | `{ operationId? }` | Withdraws one operation, or stops everything |
| POST | `/sessions/:s/reset` | `{ handoff? }` | Starts a fresh context; history stays stored |
| PUT | `/sessions/:s/model` | `{ model }` | Changes one session's model: a Workers AI or AI Gateway id |
| GET | `/settings` | | `{ timeZone, approvalPolicy, approvalTimeoutSeconds, notifyWebhook }`; `approvalTimeoutSeconds` is null when approvals wait however long |
| PUT | `/settings` | Any of `{ timeZone, approvalPolicy, notifyWebhook }`; `null` goes back to the deployment's | The settings |
| GET | `/usage` | | `{ limits, today, history, storageBytes }`: model requests, tokens (the ChatGPT plan's apart) and runs by UTC day |
| GET | `/export` | | Everything as one JSON download, without credentials |
| GET | `/model` | | `{ model, default, choices, chatgpt: { connected, email, error } }`: the model every session uses, and the ones you can choose. Each says whether it sees images (`images`); a model that doesn't is told an image was left out |
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
| GET | `/artifacts`, `/artifacts/:id` | | Artifacts, and one with its version history. See [docs/artifacts.md](docs/artifacts.md) |
| GET | `/artifacts/:id/versions/:v` | | One version with its content |
| GET | `/artifacts/:id/versions/:v/frame`, `…/download` | | An HTML version as a sandboxed page, or any version as a file |
| POST | `/artifacts/:id/restore` | `{ version, baseVersion }` | Restores a version as the new latest; `409` if `baseVersion` isn't the latest |
| DELETE | `/artifacts/:id` | | Deletes it with every version |
| GET | `/goals`, `/goals/:id` | `?status=active\|paused\|done\|abandoned` | Goals with steps and notes |
| DELETE | `/goals/:id` | | |
| GET | `/schedules` | | Pending scheduled tasks |
| DELETE | `/schedules/:id` | | Cancel one |
| GET | `/approvals`, `/approvals/:id` | `?status=pending\|approved\|denied` | Approval requests; each says what its timeout decides (`onTimeout`) and who decided it (`decidedBy`: `user`, `timeout` or `always`) |
| POST | `/approvals/:id/approve`, `/approvals/:id/deny` | `{ note? }` | The decided approval; `409` if already decided |
| POST | `/approvals/:id/approve` | `{ note?, always: true }` | Also sets the approval's tool to `on`, so later calls run without asking, and approves other pending calls to it |
| GET | `/permissions` | `?circle=` | `{ tools: [{ app, appName, tool, name, description, readOnly, permission, default, chosen, changed, choices }] }`: Pim's own tools that ask first (`app: null`) and every connected app's tools, or with `circle`, that circle's (memory, and the apps' tools). `permission` is what applies: `off`, `ask` or `on`. `chosen` is yours, or null for the default |
| PUT | `/permissions` | `{ circle?, app, tool, permission }`: `app` null for Pim's own tools, `tool` the app's own name for it, `permission` null for the default | That tool's entry; `404` for an unknown tool or circle |
| GET | `/personas` | | `{ personas: [{ id, name, description, instructions, apps, team, base, source, published, default, createdAt, updatedAt }] }`: your Pims, the default one first (see [Your Pims](#your-pims)) |
| POST | `/personas` | `{ name, description?, instructions?, apps?: [{ name, url }], team?: [{ name, instructions, tools? }], base? }` | A new Pim. `tools` lists the tool names a team member may use; null or missing for all a member can have (see [Teams](#teams)). `base` is the extension's Pim it builds on, such as `pim.assistant/pim`, or null for none; missing, the deployment's default Pim |
| GET, PUT, DELETE | `/personas/:id` | PUT: any of the fields | The Pim; editing reaches its chats from their next request, deleting moves them to the default Pim. The default Pim can't be deleted (`400`): make another the default first |
| POST | `/personas/:id/default` | | Makes it the default Pim. Chats keep the Pim they were started with |
| GET | `/personas/:id/dashboard` | `?locale=` | `{ pim, starters, widgets: [{ id, title, empty, kind, items } \| { id, title, empty, failed: true }] }`: the dashboard of the extension's Pim it builds on, loaded for this Pim (see [docs/extensions.md](docs/extensions.md)) |
| GET | `/extensions` | | `{ extensions: [{ id, name, description, pims: [{ ref, name, description }], widgets }], defaultPim }`: what this deployment installed |
| POST | `/sessions` | `{ title?, persona? }` | A new session with that Pim, or the default one; sessions list their `persona` (null in a visit) |
| GET | `/sessions/:id/team` | | `{ runs: [{ conversation, call, member, task, status, createdAt, updatedAt }] }`: the tasks the chat's Pim handed its team, newest first; `status` is `running`, `done` or `failed` |
| GET | `/sessions/:id/team/:conversation` | | One of them, with the member's conversation as `messages`, read-only |
| GET | `/account` | | `{ username, ownerId, role, status, createdAt, usage, recoveryCodesLeft }` |
| GET | `/account/export` | | Your account and everything in your Pim, as one JSON download, without credentials |
| DELETE | `/account` | `{ confirm: username }` | Deletes your account and erases your Pim; a passkey session only. `202` while erasing is still being retried |
| GET, PUT | `/profile` | PUT: `{ displayName, bio }` | How others on this Pim see you |
| GET | `/people/:username` | | `{ username, displayName, bio, templates }`: someone, and the Pims they published |
| GET | `/templates` | `?q=` | `{ templates }`: published Pims, most used first, without their instructions |
| GET | `/templates/:id` | | A published Pim in full |
| POST | `/templates/:id/use` | | Makes it one of your Pims: a copy, with `source` saying where it came from |
| POST, DELETE | `/personas/:id/publish` | | Publishes your Pim (again, to update it), or takes it down |
| GET | `/circles` | | `{ circles: [{ id, name, enabled, createdAt, members: [{ ownerId, username, addedAt }] }] }` (see [Sharing](#sharing)) |
| POST | `/circles` | `{ name }` | A new circle, with nothing allowed |
| PUT | `/circles/:id` | `{ name?, enabled? }` | The circle; `enabled: false` pauses everyone in it |
| DELETE | `/circles/:id` | | Deletes it; its people's Pims are told |
| POST | `/circles/:id/members` | `{ username }` | Puts that person in the circle (moving them from another), and tells their Pim; `404` for an unknown username |
| DELETE | `/circles/:id/members/:ownerId` | | Takes them out; their Pim is told |
| GET | `/circles/activity` | | `{ activity: [{ id, at, username, circle, tool, outcome, summary }] }`: guests' tool calls, newest first; `outcome` is `ran`, `asked` or `refused` |
| GET | `/visits` | | `{ visits: [{ ownerId, username, sharedAt, available, session }] }`: Pims shared with you, and your conversation with each |
| POST | `/visits/:username` | | `{ session }`: your conversation with that Pim, started if new. Messages to it go through `/sessions/:s/messages` like any other |
| GET | `/mcp` | | Connected apps, their state, sign-in link, approval policy, tools (with their `permission`), and `pims`: the names of your Pims that work with each |
| POST | `/mcp` | `{ name, url, headers?, approval? }` | Connects an app; `201` with `{ id, state, authUrl? }` (`authUrl`: send the user there to sign in) |
| PUT | `/mcp/:id` | `{ approval: "writes" \| "all" \| "none" }` | Which of its tools need approval, unless you set a tool's permission |
| DELETE | `/mcp/:id` | | Disconnects it |
| GET | `/mcp/callback/:owner` (root, no `/api`) | | Where an app's sign-in returns; no token needed |
| GET | `/mcp/:id/skills`, `/mcp/:id/events` | | The skills and watchable events an app offers |
| GET | `/watches` | | Event watches: app, event, instruction, state, next renewal |
| DELETE | `/watches/:id` | | Stops a watch and unsubscribes |
| POST | `/mcp/events/:owner/:watch` (root, no `/api`) | Standard Webhooks-signed event | Where apps deliver events; no token needed, the signature is checked |
| GET | `/email` | | `{ available, address, pending }`: whether this Pim can send email, the confirmed address, and one waiting for its code |
| PUT | `/email` | `{ address }` | Emails a code there; `409` when this Pim can't send email |
| POST | `/email/confirm` | `{ code }` | Makes the waiting address the one Pim emails |
| DELETE | `/email` | | Forgets the address |
| GET | `/notifications` | `?unread=true` | Notifications |
| POST | `/notifications/:id/read` | | Marks one read |
| GET | `/push/key` | | The VAPID public key browsers subscribe with (made on first use) |
| PUT | `/push/subscription` | `{ endpoint, p256dh, auth }` | Subscribes a browser to Web Push |
| DELETE | `/push/subscription` | `{ endpoint }` | Unsubscribes it |

Submissions are idempotent by `operationId`. Retrying with the same id returns the same receipt and never starts a second run.

The admin runs the Pim under `/admin`, with a passkey session only: an API token can't. See [docs/instance.md](docs/instance.md#running-it).

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/admin/stats` | | Accounts by status, registrations in the last day, unused invites, queued and failing cleanups |
| GET | `/admin/accounts` | `?status=&after=&limit=` | Accounts, by username |
| GET | `/admin/accounts/:username` | | The account, its usage, and its cleanup job if one is queued |
| POST | `/admin/accounts/:username/suspend`, `…/unsuspend` | `{ reason? }` | Stops the account at once, or restores it; not your own |
| PUT | `/admin/accounts/:username/limits` | `{ limits }` or `{ limits: null }` | One person's limits over `PIM_LIMITS` |
| POST | `/admin/accounts/:username/setup-link` | | `{ setupUrl, expiresAt }`: adds a passkey once, within an hour |
| DELETE | `/admin/accounts/:username` | `{ reason? }` | Deletes it as its owner would; not your own |
| POST | `/admin/invites` | `{ count?, note? }` | `{ codes, links }`: single-use invite links, up to 100 |
| DELETE | `/admin/templates/:id` | | Takes a published Pim out of Discover |

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

- **Each Pim lists its apps.** An extension's Pim lists the apps it works with in its definition (`apps` in [`pim.config.ts`'s extensions](docs/extensions.md)), and each of your Pims can add its own (Your Pims → Edit → Apps it works with). A chat gets the tools, instructions, and prompt entry of the apps its Pim lists, and of no other, even when you connected more. Team members work with their Pim's apps.
- **Connecting.** Connect from a Pim's card in Your Pims, `POST /mcp` with a name and URL, or ask Pim: its `connect_app` tool connects one of the apps the chat's Pim lists, without asking, since the Pim already chose it. It can't connect anything else. If the app needs sign-in, the response (or Pim) gives you a link; the app sends you back to `/mcp/callback/<you>`.
- **Seeing them.** Settings → Connected apps lists every app you connected, its state, which of your Pims work with it, and a sign-in link while it waits for one. Remove an app there. An app no Pim lists does nothing until one does.
- **Finding the server.** Say "use my Linear" and Pim's `find_app` tool looks the app up in the official [MCP Registry](https://registry.modelcontextprotocol.io). The registry verifies publishers (`app.linear/...` only by whoever controls linear.app), so Pim ranks first the server whose publisher's domain names the app and that runs on that domain, like `https://mcp.linear.app/mcp`. Gateways that relay the app through someone else's server come after, labeled as third parties, and Pim says who runs one before offering it. Remotes that need a URL template or an API key header are left out. Pim gives you the URL to add to the Pim; it can't add it itself.
- **Tools.** Each MCP tool becomes a pi tool named `<app>_<tool>`. pi picks up added and removed tools from the next request, without a restart. The app's instructions go in the `connected_apps` prompt section.
- **Approvals.** With the default `writes` policy, tools that do not declare `readOnlyHint` file an approval like `http_request`, and the call is made when you approve. `all` gates every tool; `none` trusts the app. The read-only hint comes from the app itself, so only connect apps you trust. A tool's own [permission](#tool-permissions) takes the policy's place.
- **Prompt cache.** The apps' tools come last in pi's tool list, so a newly connected app's tools are appended to what the provider has cached instead of re-sending every tool. Changing an app's approval policy changes its tools' descriptions, which re-sends the tool list once.

### Skills from apps

Apps that implement the [MCP Skills extension](https://modelcontextprotocol.io/extensions/skills/overview) (`io.modelcontextprotocol/skills`) ship instructions for using them as [Agent Skills](https://agentskills.io). pim reads an app's `skills/list` when it connects and again when the listing's TTL runs out, and lists each skill's name and description under the app in the prompt. The model loads one with `read_skill`, and supporting files with `read_skill_file`.

- Every file is checked against the SHA-256 digest and size the app published; a mismatch re-reads the listing once, so an app that updated a skill is picked up, and content that still doesn't match is refused.
- Skill content is labeled with the app it came from, as the extension requires: it is the app's text, not the user's.
- pim runs no code from skills. Anything a skill tells the model to do goes through the app's tools and their approvals.

### Events from apps

Apps that implement the draft [MCP Events](https://github.com/modelcontextprotocol/experimental-ext-triggers-events) extension can tell Pim when something happens: a price changed, a message arrived. pim supports webhook delivery, the same slice ChatGPT implements.

- **Watching.** Ask Pim ("tell me when the JFK–Lisbon price drops below $500"); `watch_app_event` files an approval naming the app, the event and the instruction. Once approved, pim calls `events/subscribe` with a callback URL (`/mcp/events/<owner>/<watch>`) and a fresh signing secret, and renews the subscription before the app's grant runs out.
- **Receiving.** Each delivery must carry a valid Standard Webhooks signature from the last five minutes. The event becomes a message to the conversation that created the watch, with the instruction and the event data marked as untrusted. The event id is its idempotency key, so a delivery the app retries starts one run, not two.
- **Ending.** `stop_watch` or `DELETE /watches/:id` unsubscribes. A watch the app terminates, or refuses to renew, ends with a notification. Removing an app stops its watches.
- **Draft.** The extension is not ratified. Today's MCP SDKs drop its `events` capability from the handshake, so pim also asks an app for `events/list` when it declares nothing.

MCP servers expose tools, prompts and resources; pim uses their tools, instructions and skills. They cannot add hooks or change how pim runs, which is also what keeps them safe to connect.

### Tool permissions

Settings → Tool permissions lists every tool that acts on the world or comes from an app, grouped by app, with Pim's own (`http_request`, `watch_app_event`) first. Each is **Off** (the model isn't offered it), **Ask** (each call files an approval) or **On** (it runs without asking). A tool you haven't set follows its default: Pim's own ask, and an app's follow its approval policy. **Always approve** on a request sets its tool to On.

- **Tied to the tool you saw.** An app tool set to On is held to its definition at the time: description, input schema and annotations. If the app changes any of them, Pim asks before each call again and Settings says so until you choose again.
- **Checked at each call.** An app tool's permission is checked again when the model calls it, so a tool turned off or changed since the tool list was built is refused or asked about.
- **Removing an app** forgets its tools' permissions. Tools chosen with Always approve before permissions existed become On the first time Pim sees them.

## Your Pims

Your Pims are named agents, each with its own instructions: a marathon coach, a trip planner, a code reviewer. Each builds on a Pim an [extension](docs/extensions.md) brings (Your Pims → Builds on), Pim's own assistant unless you chose another, which gives it its habits, the extension's tools beyond Pim's own, and its dashboard; your name and instructions go on top. One of yours is the default: it talks in chats started without choosing a Pim, and its dashboard is the app's home. Any Pim can be made the default (Your Pims → Make default), and the default can't be deleted until another is; chats stay with the Pim they were started with. Joining ends with naming your first Pim. The sidebar has a section for each Pim, named after it, with its chats, most recent first. A chat started with another (Your Pims → Chat) talks with that one. A chat's Pim adds its name and instructions to the agent's own habits; everything else is shared by all of them: memory, connected apps (each Pim uses the ones it lists), approvals, schedules. Edit a Pim and its chats follow from their next request; delete it and they go on with the default one. A Pim lists the apps it works with, by MCP server URL, besides those of the Pim it builds on: its chats get only those apps' tools, and whoever uses it connects them with their own accounts.

**The Pim everyone starts with.** The admin can make one of their Pims everyone's default (Your Pims → Make everyone's default). Each person who joins after that gets a copy as their default Pim: its name, description, instructions and suggested apps, theirs to change. Copies don't follow later edits to the admin's Pim, and people who joined before keep the default Pim they have. Until the admin chooses one, people start with the deployment's default Pim (`defaultPim` in `pim.config.ts`), named after it, with no instructions of their own.

**Dashboards.** Each Pim's name in the sidebar opens its dashboard: a box to start a chat with it, suggested first messages, and widgets from the extension's Pim it builds on. Pim's own shows what's coming up, the goals being worked on, what it remembered lately, and what it made recently, each from that Pim's chats (memory is shared, so every dashboard shows the same).

A Pim can be **published** to the others on your Pim: Discover lists published Pims, and anyone on it can read one in full and **make it their own**, which copies its name, description, instructions and suggested apps into their own Pims. Nothing else of the author's goes with it: no memory, chats or credentials. The copy is theirs to change; publishing again updates what others see, not their copies. Unpublishing, deleting the Pim, or deleting the account takes it out of Discover. Each person has a profile (a name and a line about them), shown on their page and next to what they publish.

A published Pim's instructions are someone else's words running with your tools, so read them before you take one: your copy still asks before acting wherever your tool permissions say it should.

### Teams

A Pim can have a team: up to eight members, each with a name, its own instructions and, optionally, the tools it may use. You still talk to one Pim. It hands members tasks with its `delegate` tool, they work at the same time, each in a conversation of its own, and it gets all their answers back to combine. A coding Pim, for example, can be a planner that hands parts of the change to a few coders.

- **Members answer the Pim, never you.** They don't get `send_to_user`, scheduling, watching apps' events, or `delegate`. Given a list of tools, a member gets only those.
- **The chat shows the team at work**, above the composer: who has the latest tasks and whether each is working, done or didn't finish. A member opens read-only, with its task and what it did. Members' conversations aren't chats in the sidebar.
- **Approvals.** A member's tools ask before acting, as the Pim's do. The request shows in the chat the member works for, labeled with its name. The decision goes to the member, and what it answers then comes to the Pim's chat as a message starting with "[Team".
- **Copies.** Publishing a Pim, making one your own, and the Pim everyone starts with copy its team.

## Sharing

You can let others on your Pim message your agent from their own. Sharing → Circles: make a circle (Family, Close friends, Acquaintances), add people by their username, and choose what the circle can use: each connected app's tools (Off, Ask or On, as in [Tool permissions](#tool-permissions)) and your memory (read-only). Everything starts off.

- **Their conversation runs in their Pim.** Someone you share with finds your Pim under Shared with you. Their conversation with it (a visit) is a chat in their own Pim, on their own model and usage: whoever sends the messages pays for them. It sees a brief your Pim sends before each of their turns: what their circle may use, your memory if allowed, and your time zone. Nothing of their own Pim (its tools, memory or apps) is in that conversation, and nothing of yours is in their other chats.
- **The boundary is in your Pim, at every call.** Each tool in a visit is a call into your Pim (`guestCall`), which checks again that they're in a circle, that the circle is on, and that the tool is allowed for it now. A tool turned off, an app that changed a tool since you allowed it, or a person you removed is refused, whatever their Pim was told before.
- **Ask means you decide.** A call to a tool set to Ask files an approval that names who asked and through which circle, and notifies you. Their conversation goes on; your decision arrives in it later as a message. Unanswered, it is denied after a day: a guest's request is never approved by a timeout. **Always approve for Family** sets the tool to On for that circle.
- **Limits.** Up to 20 circles and 200 people in them. Each guest can make 200 calls into your Pim a day, so your apps' own limits stay yours. Sharing → Recent activity lists what guests used, asked for, or were refused.
- **Taking it back.** Remove someone, or turn a circle off, and their next turn is refused. Deleting a circle forgets its permissions.

## Develop

```sh
pnpm test        # Vitest in workerd, with pi-ai's faux model, then the web app's tests; no Cloudflare account needed
pnpm test:live   # live checks against real MCP servers (Hugging Face's); needs the network
pnpm typecheck   # also generates the web app's route tree, so it works on a fresh checkout
pnpm types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
pnpm preview     # a Pim with a stand-in model, at http://localhost:8787, with no Cloudflare login (see docs/instance.md)
```

The web app is in [`web/`](web), with its own README. Passkey sign-in is in [`src/auth/`](src/auth).

To add a Pim, tools only some Pims get, or dashboard widgets, write a Pim extension and list it in `pim.config.ts` (see [docs/extensions.md](docs/extensions.md)). To add a tool, write a pi extension in `src/extensions/` and install it in `Pim`'s harness factory. A tool with effects outside the conversation should be a `GatedAction` (see `src/extensions/approvals.ts`) so it runs only after approval.

## Not built yet

- Falling back to `PIM_MODEL` when the ChatGPT plan's usage limit is reached. Until then, a run that hits the limit fails with OpenAI's error.
- Publishing artifacts, JSX artifacts, and artifacts that keep their own state.
- A sandboxed computer and browser for the agent: Cloudflare Containers or Browser Rendering.
- Extensions beyond MCP: Agent Skills, and full pi extensions that Pim builds into itself by redeploying its own Worker.
- Secret placeholders, so approved requests can use credentials the model never sees.
- Semantic recall. `recall` is a regular expression over the log, so it finds words, not meanings.
