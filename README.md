# pim

An open-source personal agent you deploy to your own Cloudflare account. Inspired by Meta's [Muse](https://ai.meta.com/muse/): it remembers what matters to you, turns goals into plans, keeps working in the background, and asks before acting on the world.

A deployment is a Pim for you and the people you invite: family, friends, a small team. Each person gets their own space, with their own agents, conversations, memories and connected apps, and can share it with the others. You run it, and everything stays in your Cloudflare account. The name is [pi](https://github.com/earendil-works/pi), the harness it runs on, plus **m** for multiplayer.

This repository is the agent, its API, and its web app ([`web/`](web)): chat, approvals, notifications and settings, signed in with a passkey, or with Google, GitHub or your own single sign-on when you set those up. One Worker serves all of it, for everyone, at one address. Mobile apps and messaging bridges can use the same API with an API token, and Claude, ChatGPT and other MCP clients can talk with your majordomo at `/mcp` (see [Talking with Pim from other apps](#talking-with-pim-from-other-apps)).

The copy button in a chat's header copies the conversation as Markdown, with separate headings for the user, the named agent and system notices. It becomes available when the chat finishes loading and the agent finishes replying. Message formatting stays intact; attached images are marked with a placeholder, and private reasoning and tool activity are left out.

The globe button beside it makes a public link to the chat: a copy of the conversation as it is then, which anyone with the link can read at `/shared/<owner>/<link>`, without an account. The copy is what you read in the chat: your messages and what the agent sent you, with the widgets that went with them as they were. The images you attached, Pim's own notices, private reasoning and tool activity are left out, and so is everything said after it was made. **Update to include new messages** copies the chat again under the same link. **Turn off link**, deleting the chat, or deleting the account makes the link answer `404`; a browser that read it in the last minute may still show its copy. The page asks search engines not to index it, and shows the copy as untrusted text: no images load, no HTML runs, and links go only to web and mail addresses. A chat with someone else's agent (a visit) can't have a link.

**Vocabulary:** Pim is the platform; a space is one person's own part of it, with their agents, conversations, memories and files; an agent is what you create and chat with; a blueprint is what an extension defines in code for agents to build on; a template is an agent shared through the gallery.

## How it works

```
 Browser, bot, app                        Cloudflare
┌─────────────────────┐   HTTPS / WS   ┌──────────────────────────────────────────────┐
│ web app, or REST +  │───────────────▶│ Worker (src/index.ts, src/gateway.ts)        │
│ WebSocket at /api;  │                │  ├ /*       the web app (web/, static files) │
│ MCP clients at /mcp │                │  ├ /auth/*  joining, passkeys, Google/GitHub │
└─────────────────────┘                │  ├ /mcp, /oauth/*  the majordomo over MCP,   │
                                       │  │          and its OAuth (OAUTH_KV)         │
                                       │  └ /api/*   whoever the session or token     │
                                       │   │         names                            │
                                       │   ▼                                          │
                                       │ Durable Object "Pim" (src/pim.ts), one per   │
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
                                       │ "Auth", one per person: sign-ins, tokens     │
                                       │ "Directory": accounts, the admin, invites    │
                                       │ "Gallery": profiles, published templates     │
                                       └──────────────────────────────────────────────┘
```
- **[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable)** runs the agent. Every model turn and tool call is a durable task committed to the Durable Object's SQLite before anything is shown. If the object is evicted mid-run, the `agents` SDK's `PiHarness` alarm wakes it, and pi resumes where it stopped.
- **One space per person.** The Worker reads whose request it is from the browser's session or the API token, and sends it to that person's Durable Object, which holds their memory, apps and agents in its SQLite database. A URL never chooses whose space answers. See [docs/instance.md](docs/instance.md).
- **A model that can do the job.** Pim decides what to say and when, and says it with a tool call, so it needs a capable model. The default is GLM-5.3 on Workers AI (`@cf/zai-org/glm-5.3`), billed to your Cloudflare account, with no vendor keys. Any AI Gateway catalog model works too, such as `anthropic/claude-opus-4.8` (set `PIM_MODEL`), or OpenAI's through your ChatGPT plan.
- **Your ChatGPT plan**, optionally. Sign in with ChatGPT (Plus or Pro) and Pim runs on OpenAI's models, such as GPT-6.1 Sol, using the plan's included usage. See [ChatGPT plan](#chatgpt-plan).

## What the agent can do

| Capability | Tools | How |
| --- | --- | --- |
| Long-term memory | `note`, `recall`, `zoom`, `forget` | OptMem-style: an append-only log, compressed in the background into a tree of summaries. Every conversation sees a fixed-size view of it. See [Memory](#memory). |
| Artifacts | `artifact_create`, `artifact_update`, `artifact_read`, `artifact_show`, `artifact_list` | Documents, HTML pages, React apps, drawings and diagrams the agent makes for you, with every version kept; pages and apps can span several files, copies of your own files among them. They open in a canvas beside the chat, and are listed in Artifacts; they run in a sandbox apart from your account, and can be edited, printed, restored, downloaded, shared with your circles or published. Through `window.pim` they can keep data, and with your permission ask the model or use an app's tools. See [docs/artifacts.md](docs/artifacts.md). |
| Files and JavaScript | `file_read`, `file_list`, `file_find`, `file_search`, `file_write`, `file_edit`, `file_delete` (gated), `run_javascript` and `file_load` (opt-in) | A folder you and your agents share, `/workspace`. Text is kept in your space's database, where agents search and edit it; files that aren't text, such as PDFs, images and audio, are stored in R2 and show in the same folders, marked "stored" for agents, who can look at the images among them. You see it under Files in the sidebar, where you can upload, preview, download and delete; every agent you chat with, and its team, reads and writes the same files. Writing and editing count toward your storage; deleting asks first, because files keep no earlier versions. Uploads are at most 25 MB each. Where the deployment can run code (see [Running JavaScript](#running-javascript)), `run_javascript` runs JavaScript over those files, to analyse data, convert formats or make files such as charts; each run is a fresh sandbox with no network, which stops after a minute and can't reach past `/workspace`. Code sees the text files; `file_load` copies a stored file in for it, to `/workspace/.loaded`, and what code writes that isn't text is stored when it ends. Code can change and remove files without asking, as `file_write` can. |
| The browser | `browser_open`, `browser_read`, `browser_screenshot`, `browser_close`, `browser_click` and `browser_type` (asking first) | One Chrome on [Browser Run](https://developers.cloudflare.com/browser-run/) that your agents share, for pages `fetch_url` can't read and for clicking through sites. Agents read a page as its text, with what can be clicked or typed into numbered; clicking and typing ask first, naming the element as the page shows it ("On shop.example, click the button “Buy now”"), and Settings → Tool permissions can let them run. It starts signed in nowhere and closes itself after ten minutes unused. To sign in, or to get past a check that you're human, open the box beside the chat (the list button at its top right, which has a dot while the browser is open), where the browser shows under the summary, and choose Take over (Browser Run's Live View); the agents go on in the same pages. Screenshots go to your files. See [The browser](#the-browser). |
| Images | `generate_image` | Agents draw images from a description, with the deployment's image model on Workers AI (`PIM_IMAGE_MODEL`, FLUX.2 [klein] 4B unless set), square, landscape or portrait, and save them to your files, under `/workspace/images/` unless they name a place. Each one shows in the chat where it was made, opening the file, and counts as a model request toward your daily limit; Workers AI bills it to the Cloudflare account, about a tenth of a cent an image with the default model. The ChatGPT plan can't make images: OpenAI's plan sharing doesn't include its image generation. |
| Your agents | `create_agent`, `update_agent`, `rename_agent`, `manage_apps` (edits gated) | Every chat's agent knows your other agents and points you to the one made for what you ask. When none fits ongoing help you want, such as a coding helper, it makes one, with its instructions, apps, team, and an emoji and color for its icon, without asking; it never makes two with the same name. It can change its own instructions, description and team, rename itself or another of your agents, or request changes to its own apps through the approval flow. See [Your agents](#your-agents). |
| Dashboards | `update_dashboard` | Each agent's dashboard starts empty. Ask for something there, such as a chart of your spending or today's headlines, and the agent makes it as an artifact and pins it; it can pin a widget, such as your goals, too. See [Your agents](#your-agents). |
| Goals and plans | `create_goal`, `update_goal`, `list_goals` | Goals have step-by-step plans and progress notes. Active goals are always in the prompt. |
| Background work | `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` | Delays, dates, or cron. When a task fires, the agent receives a `[Scheduled task]` message in the session that scheduled it, or, with `new_chat`, in a new chat with the same agent each time, titled with the task's label, and you get a notification that links to that chat. Schedules, in the sidebar, lists what's pending, soonest first, each opening the chat it runs in, and cancels any of it. Deleting the chat that scheduled a task cancels it, unless the task starts new chats: that one goes on until cancelled. |
| Talking to you | `send_to_user` | The only way Pim speaks: you see what it sends, and none of its working notes or reasoning. A successful send ends the turn by default; a progress update uses `complete: false` and must be followed by a final send. User-started turns that end without sending get up to two private correction prompts, then fail rather than showing private text. Background work can stay silent. A message can carry up to four widgets, such as your goals or what's coming up, drawn by the app from your data as it is when sent; the model names them instead of retyping what they show (see [docs/extensions.md](docs/extensions.md#in-chat)). A message goes to the conversation, or to your email when the deployment can send it (see [Email](#email)). With `notify`, it is also stored as a notification, pushed to connected sockets, sent as Web Push to browsers that turned it on in Settings (even with the app closed), and POSTed to an optional webhook. |
| Asking first | `http_request` | Gated: the call files an approval request and waits for the decision; your apps and devices are told. The action runs when you approve; deny to stop it. Either way the call returns the decision, with the result, and the turn goes on from there. While it waits the call is suspended: it holds no memory, the space can sleep, and the chat stays busy, so a message you send meanwhile waits its turn. It waits however long you take. The approval policy says who answers: under `majordomo` (the default), other agents' requests go to your [majordomo](#your-majordomo) first, which decides those it's sure about and asks you about the rest; `auto` approves what you don't answer within 30 seconds, so autonomous jobs never stall; `explicit` waits for you, so nothing happens without your yes. Choose **Always approve** and later calls to that tool run without asking. Settings → Permissions sets each such tool, and each app's tool, to Off, Ask or On (see [Tool permissions](#tool-permissions)). |
| Connected apps | `connect_app`, `list_apps`, `find_app`, plus each app's tools | The apps this Pim offers: remote MCP servers, with OAuth sign-in, which you connect once for all your agents. A chat works only with the apps its agent lists. Assignment auto-approves routine tools; risky tools and tools you set to Ask still need approval. See [Connected apps](#connected-apps). |
| Skills | `write_skill` (gated), `read_skill`, `read_skill_file` | Your agents write down how you want work that comes up again done, with your approval, and load it before doing that work. Apps publish skills too, over the MCP Skills extension, checked against the app's digests. See [Skills](#skills). |
| App events | `list_app_events`, `watch_app_event` (gated), `list_watches`, `stop_watch` | Apps notify Pim when something happens (draft MCP Events, webhooks); each event starts a run with the watch's instruction. |
| The web | `fetch_url`, `web_search` (opt-in) | `web_search` is billed by AI Gateway, so it is off until `PIM_WEB_SEARCH` names a provider. |
| Time | `current_time` | Shows UTC and the person's time zone. |

The chat never displays raw tool calls, their arguments or results, working notes, or reasoning, including while a run streams. These remain in the durable transcript for debugging. Approval requests and generated artifacts keep their dedicated user-facing cards; a busy indicator shows when Pim is working.

## Deploy

Pim's Durable Objects run on the Workers free plan, but the default model, GLM-5.3 on Workers AI, needs the Workers Paid plan or prepaid AI Gateway credits. For a free first look, set `PIM_MODEL` to `@cf/zai-org/glm-4.7-flash`, which runs on Workers AI's daily free allocation but is not good enough for real use; or connect a ChatGPT plan in Settings.

Images people send in chats and files that aren't text are kept in one R2 bucket, and artifacts' files in another; deploying creates both. R2 has to be turned on for the account first: in the dashboard, open Storage & databases, then R2, and add the R2 subscription. Its free tier covers 10 GB, but Cloudflare asks for a payment method.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ajac-zero/pim)

The button copies this repository to your GitHub account and deploys it to your Cloudflare account. It asks for nothing. Then open the Worker's `workers.dev` URL, which the deploy shows: Pim asks for its address, `PIM_PUBLIC_URL`, before anything else. Pim answers only there, and passkeys belong to it, so choose the one you'll keep: the `workers.dev` URL, or a custom domain you attach to the Worker first. Add it in the dashboard (Workers & Pages → `pim` → Settings → Variables and Secrets), open it, pick a username, save your recovery codes and create your passkey: your face, fingerprint, or PIN. You're the admin of this Pim. That's the whole setup.

- **The first account** can be made that way for 15 minutes after a deploy, and it is the admin's. Until you make it, whoever opens the URL first could, so open it right after deploying. Missed the 15 minutes? The sign-in screen has the Worker write a one-time setup link to its logs, which only someone signed in to your Cloudflare account can read. In the dashboard, open Workers & Pages, then `pim`, then Observability, and open the link in the log that starts with "Pim setup link". It works once, for an hour.
- **Inviting people.** Settings → Members → Invite someone makes a link that lets one person join. With `PIM_REGISTRATION` set to `open`, anyone who finds the address can; `closed` lets nobody in.
- **More passkeys** (your phone, another browser) come from Settings.
- **Google, GitHub or single sign-on** (optional). Passkeys always work, and need no setup. To let people also sign in with Google, GitHub, or any OpenID Connect provider (Microsoft, GitLab, Authentik, Keycloak, Pocket ID...), make an OAuth app there and add its client ID and secret as the Worker's secrets: in the dashboard (Workers & Pages → `pim` → Settings → Variables and Secrets) or with `wrangler secret put`. They work once saved, with no redeploy. Google takes `PIM_GOOGLE_CLIENT_ID` and `PIM_GOOGLE_CLIENT_SECRET`; GitHub `PIM_GITHUB_CLIENT_ID` and `PIM_GITHUB_CLIENT_SECRET`; single sign-on `PIM_OIDC_ISSUER`, `PIM_OIDC_CLIENT_ID`, `PIM_OIDC_CLIENT_SECRET`, and optionally `PIM_OIDC_NAME` for its button. The app's callback URL is `https://<your Pim>/auth/oauth/<google|github|oidc>/callback`; Settings → Members shows it, and which providers are on. People then link that account in Settings, or use it instead of a passkey when they join. It never makes an account by itself: someone who never joined, or never linked that account, isn't let in. An account at a provider signs in to one person on the Pim, matched by the provider's user ID, not by email.
- **Lost every passkey?** Each person got ten recovery codes when they joined; one, with their username, adds a new passkey. The admin can make anyone a setup link in Settings, and gets one for themselves from the logs, as above.

Sessions last 30 days, and removing a passkey, or unlinking an account, signs out the browsers it signed in. API tokens for other clients are made in Settings (`POST /auth/tokens` from a signed-in browser) and revoked there. Passkeys belong to the hostname the app is served from, so moving Pim to another domain means creating new ones.

Or from a checkout:

```sh
pnpm install
pnpm wrangler login
pnpm run deploy        # builds web/ first
```

Then set `PIM_PUBLIC_URL` in the dashboard as above (from the CLI, `pnpm wrangler secret put PIM_PUBLIC_URL` works too, since wrangler has no command for plain variables), and open that address to set it up. With the CLI, `pnpm wrangler tail` shows setup links as the sign-in screen asks for them.

`wrangler.jsonc` is the same for every deployment, so deploy it as it is. What's yours is a variable you set in the dashboard (Workers & Pages → `pim` → Settings → Variables and Secrets), not in `wrangler.jsonc`: `keep_vars` keeps them through deploys, and saving one there applies it at once. Leave any of them unset for its default (in [`src/deployment.ts`](src/deployment.ts)). The admin sees what each is, and any Pim can't read, in Settings → Deployment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIM_PUBLIC_URL` | none: required | The address people use, such as `https://pim.example.com`: passkeys, apps' callbacks and the links Pim makes belong to it. Pim answers only there, sends the web app there from any other address, and answers nothing until it's set |
| `PIM_CONTENT_ORIGIN` | unset | Another address, routed to this Worker, for public artifact links (see [docs/artifacts.md](docs/artifacts.md#public-links)); unset turns links off. It must differ from `PIM_PUBLIC_URL` |
| `PIM_REGISTRATION` | `invite` | How people join once there is an admin: `invite` (links the admin makes), `open` or `closed` |
| `PIM_MAX_ACCOUNTS` | unset | Accounts allowed in all; unset for no cap |
| `PIM_REGISTRATIONS_PER_ADDRESS` | `3` | Accounts one IP address may make in a day |
| `PIM_MODEL` | `@cf/zai-org/glm-5.3` | Model for new sessions: a Workers AI id or an AI Gateway catalog id |
| `PIM_MODELS` | unset | Workers AI or AI Gateway models sessions may use besides `PIM_MODEL`, comma-separated; unset allows any |
| `PIM_UTILITY_MODEL` | `@cf/ibm-granite/granite-4.0-h-micro` | Small Workers AI model for side jobs, such as naming chats (see [Utility model](#utility-model)); `off` turns them off. Each person can choose another in Settings |
| `PIM_MEMORY_MODEL` | unset | Model that compresses memories; unset uses `PIM_MODEL`, never the ChatGPT plan |
| `PIM_MEMORY_LINES` | `96` | Lines of long-term memory in every prompt (about 8k tokens) |
| `PIM_IMAGE_MODEL` | `@cf/black-forest-labs/flux-2-klein-4b` | Workers AI text-to-image model `generate_image` draws with, such as `@cf/black-forest-labs/flux-1-schnell` or `@cf/leonardo/lucid-origin`; `off` leaves agents without it |
| `PIM_WEB_SEARCH` | unset | `exa`, `ceramic`, or `linkup` enables `web_search` |
| `PIM_APPROVAL_POLICY` | `majordomo` | Who answers approvals: `majordomo` sends other agents' requests to each person's majordomo, which decides or asks them; `auto` approves what nobody answers after 30 seconds; `explicit` waits for the person however long. Each person can change theirs in Settings |
| `PIM_TIME_ZONE` | `UTC` | IANA time zone for anyone who hasn't set theirs; joining sets the browser's |
| `PIM_LIMIT_DAILY_TOKENS`, `PIM_LIMIT_DAILY_MODEL_REQUESTS`, `PIM_LIMIT_DAILY_RUNS`, `PIM_LIMIT_SESSIONS`, `PIM_LIMIT_SCHEDULES`, `PIM_LIMIT_STORAGE_BYTES`, `PIM_LIMIT_ARTIFACTS`, `PIM_LIMIT_ARTIFACT_VERSIONS`, `PIM_LIMIT_ARTIFACT_BYTES`, `PIM_LIMIT_ARTIFACT_STORAGE_BYTES` | unset | Members' usage limits, one each, as whole numbers; unset is none. The admin has none. What each counts is in [`src/usage.ts`](src/usage.ts) |
| `PIM_EMAIL_FROM` | unset | The address Pim emails from (see [Email](#email)) |

A variable Pim can't read counts as its default, except a limit or a cap on accounts, which counts as 0, so a typo never lifts it. Settings → Deployment says which and why.

Attach your domain in the dashboard too (Workers & Pages → `pim` → Settings → Domains & Routes): deploys leave it alone.

`ratelimits` in `wrangler.jsonc` slow down sign-in attempts from one address and API requests from one person; leave them out and nothing is slowed down. Their namespace IDs must be unique in your Cloudflare account.

Pim comes with 36 apps ([`popular-apps.ts`](src/extensions/popular-apps.ts), [`spotify.ts`](src/extensions/spotify.ts)): Airtable, Amp, Atlassian (Jira and Confluence), Attio, Cal.com, Calendly, ClickUp, Cloudflare, Context7, Exa, Firecrawl, Fireflies, GitHub, Granola, Hex, Hugging Face, Intercom, Jotform, Klaviyo, Linear, Make, Mercury, Miro, monday.com, Neon, Netlify, Notion, PayPal, PostHog, Sentry, Spotify, Stripe, Supabase, Todoist, Webflow and Wix. All but two work as they are. Two need secrets of your own, set with `wrangler secret put`; until they are, nobody is offered the app:

- **GitHub**: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, from an OAuth app at [github.com/settings/developers](https://github.com/settings/developers) whose callback URL is `https://<your Pim>/mcp/callback`. GitHub's MCP server doesn't let apps register themselves, so Pim signs everyone in with this one.
- **Spotify**: `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`, from an app at [developer.spotify.com](https://developer.spotify.com/dashboard) whose redirect URI is `https://<your Pim>/mcp/callback/apps`.

### Email

Pim can email each person, when they ask for it or for something worth keeping, such as a report. It's off until you set it up with [Cloudflare Email Service](https://developers.cloudflare.com/email-service/): onboard a domain for Email Sending, then add to `wrangler.jsonc`

```jsonc
"send_email": [{ "name": "EMAIL" }],
```

and set `PIM_EMAIL_FROM` in the dashboard to an address on that domain, such as `pim@example.com`. Each person then adds their address in Settings and confirms it with a code Pim emails there; Pim only ever emails that one address, at most 50 times a day.

### The browser

The agents' browser runs on [Browser Run](https://developers.cloudflare.com/browser-run/), through the `browser` binding in `wrangler.jsonc`; remove it and nobody is offered the browser. The Workers free plan allows 10 minutes of browser time a day, and the paid plan includes 10 hours a month, then bills by the hour. A browser counts while it's open: from an agent's first page until it's closed, or ten minutes after it was last used. Under `wrangler dev`, and in tests, it's a Chrome that wrangler downloads; Live View, and so taking the browser over, needs the real Browser Run.

### Running JavaScript

Agents can run JavaScript over people's files once the deployment has a Worker Loader: uncomment

```jsonc
"worker_loaders": [{ "binding": "LOADER" }],
```

in `wrangler.jsonc`. [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/) need the Workers Paid plan; each `run_javascript` call loads one, with no network access, and its CPU time counts toward the account's Workers usage. Without the binding nobody is offered `run_javascript`; files work either way.

### Traces

Pim sends [OpenTelemetry](https://opentelemetry.io/) traces of what the agents do to any backend that takes OTLP over HTTP as JSON: Langfuse, Arize Phoenix, Honeycomb, Grafana, Jaeger, or an OpenTelemetry Collector. They follow the [semantic conventions for generative AI](https://github.com/open-telemetry/semantic-conventions-genai): each run of a conversation is an `invoke_agent` span, each model request in it a `chat` span with the model, finish reason and tokens, and each tool call an `execute_tool` span. Work a tool call starts in another conversation is that call's child, so one trace holds everything a message led to: the tasks it handed out, and the majordomo's review of an approval request, with its decision.

Set the endpoint as a variable in the dashboard, like the settings above, and its key as a secret, with the standard OpenTelemetry variables:

| Variable | Meaning |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The backend's OTLP base URL; traces go to `/v1/traces` under it. Or set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to the full URL. Empty sends no traces |
| `OTEL_EXPORTER_OTLP_HEADERS` | A secret (`wrangler secret put`): headers as `key=value,key=value`, such as `Authorization=Basic ...` |
| `OTEL_SERVICE_NAME` | The traces' service name; `pim` when unset |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `true` adds prompts, messages, and tool arguments and results. They are people's private conversations: set it only for a backend that may hold them |

Each span's `gen_ai.conversation.id` is its conversation's id; for a chat, the one in `/chat/<id>`. Spans go out every few seconds and whenever a person's agents go idle; any not yet sent are lost if their space is evicted.

For local development, run `pnpm dev`: the Worker and the built web app at `http://localhost:8787` (use `localhost`: passkeys don't work on an IP address). Its first 15 minutes count as just deployed, so the first account you make is the admin, and setup links show up in the terminal. For the web app with hot reload, make an API token in Settings and run `PIM_API_TOKEN=... pnpm dev:web` (port 3000), which signs in with it. The `AI` binding is remote, so `wrangler dev` needs a Cloudflare login, and model calls bill that account. `pnpm preview` runs the same Pim with no Cloudflare login and a stand-in model, at the same address.

## API

The API lives under `/api`: `GET /api/sessions`, and so on; the table leaves out the prefix. It is the signed-in person's own space. The web app calls it with its session cookie. Other clients send `Authorization: Bearer <token>`, with a token made in Settings (API tokens), which names its owner (`pim_<owner>_…`). WebSockets from clients that can't set headers pass `?token=<token>` instead. Only the three paths connected apps call stay at the root, without the prefix, and name whose agent they are for: `/mcp/callback/:owner`, `/mcp/events/:owner/:watch`, and `/mcp/client/:owner`, Pim's client metadata document for services whose sign-in takes one instead of registering clients (Amp's). MCP clients talk with your majordomo at `/mcp`, also at the root, with an OAuth access token or an API token (see [Talking with Pim from other apps](#talking-with-pim-from-other-apps)). Sessions are separate conversations. Each has a random id (a UUID) of its own, which is also its address in the app (`/chat/<id>`); `GET /` names the root session, where API clients talk by default.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/health` | | `{ name: "pim", ok: true }`; no token needed; also at the root |
| GET | `/` | | Model, time zone, root session, and tools (with `requiresApproval`) |
| GET | `/sessions` | | `{ sessions: [{ id, title, busy, createdAt, updatedAt, responseAt, unread }] }`, most recently active first; `title` is a few words the utility model picks from the user's first message, and the start of that message until it answers or if it fails. `responseAt` identifies the latest delivered reply (null before reply tracking began); `unread` says it has not been acknowledged |
| POST | `/sessions` | `{ title? }` | A new session |
| POST | `/sessions/:s/read` | `{ responseAt }` | Acknowledges replies through the supplied `responseAt`; a newer reply stays unread. Returns the session's name, activity and read state |
| PUT | `/sessions/:s` | `{ title }` | Renames it |
| POST | `/sessions/:s/title` | | Names it again from the conversation so far, with the utility model; the session |
| GET | `/sessions/:s/summary` | | `{ summary }`: Markdown with what the chat covered and its next steps, from the utility model, written again only when more was said since the last one; null before anything was said |
| GET, PUT, DELETE | `/sessions/:s/link` | | `{ link: { id, url, sharedAt, messages } }`: the chat's public link, null without one. PUT makes it show the chat as it is now, as a new link or the one it has (`409` before anything was said, `413` over 1 MB); DELETE turns it off |
| GET | `/shared/:owner/:link` | | What a public link shows: `{ title, agent: { name, symbol, color }, sharedAt, messages }`, each message `{ role: "user", text, images, at }` or `{ role: "agent", text, widgets, at }`; no token needed |
| POST | `/prompts/improve` | `{ text }` | `{ text }`: a message the person is about to send, rewritten by the utility model so their agent can act on it |
| GET | `/sessions/:s/messages` | | `{ busy, pending, messages }`: the transcript as display messages |
| POST | `/sessions/:s/messages` | `{ content, wait?, whenBusy?: "followUp" \| "steer", operationId? }`. `content` is text, or an array of `{ type: "text", text }` and `{ type: "image", data, mimeType }` parts: up to 4 PNG, JPEG, WebP or GIF images, base64, at most 5 MB each. Images are kept in R2; the transcript shows each as `{ type: "image", mimeType, url }`. Models on the OpenAI Responses and Anthropic Messages APIs fetch them from a signed URL (`/images/<owner>/<id>`, valid 15 minutes) when Pim has a public HTTPS address; any other model gets them inline | `202` with a receipt `{ operationId, accepted }`, or the result `{ status, replies, text?, reason? }` when `wait` is true. `replies` contains only successful chat sends, in order; `text`, when present, joins those replies with blank lines. Private notes are never used as a fallback |
| GET | `/images/:id` | | An image sent in a chat, by the `url` its message keeps |
| GET | `/sessions/:s/operations/:op` | `?timeout=ms` (max 60000) | The result once settled, or `{ status: "pending" }` |
| POST | `/sessions/:s/abort` | `{ operationId? }` | Withdraws one operation, or stops everything |
| POST | `/sessions/:s/reset` | `{ handoff? }` | Starts a fresh context; history stays stored |
| PUT | `/sessions/:s/model` | `{ model }` | Changes one session's model: a Workers AI or AI Gateway id |
| GET | `/settings` | | `{ timeZone, approvalPolicy, approvalTimeoutSeconds, notifyWebhook }`; `approvalTimeoutSeconds` is null when approvals wait however long |
| PUT | `/settings` | Any of `{ timeZone, approvalPolicy, notifyWebhook }`; `null` goes back to the deployment's | The settings |
| GET | `/usage` | | `{ limits, today, history, storageBytes }`: model requests, tokens (the ChatGPT plan's apart) and runs by UTC day |
| GET | `/export` | | Everything as one JSON download, without credentials |
| GET | `/model` | | `{ model, default, choices, utility: { model, default, choices }, chatgpt: { connected, email, error } }`: the model every session uses, and the ones you can choose. Each says whether it sees images (`images`); a model that doesn't is told an image was left out. `utility` is the utility model: `PIM_UTILITY_MODEL` unless you chose another, and the deployment's default again while a chosen ChatGPT model's plan is disconnected |
| PUT | `/model` | `{ provider, id }`, one of `choices` | Moves every session, and new ones, to that model |
| PUT | `/model/utility` | `{ provider, id }`, one of `utility.choices` | Makes that model the utility model |
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
| GET | `/artifacts/:id/versions/:v` | `?path=` | One version with its files and the content of its main file, or of the file at `path` |
| GET | `/artifacts/:id/versions/:v/frame`, `…/download` | `?path=` (download) | A framed version as a sandboxed page, with its own files inline, or one of its files to save |
| POST | `/artifacts/:id/versions` | `{ baseVersion, content, path?, title? }` | Saves the person's edit of one file as the new latest; `409` if `baseVersion` isn't the latest |
| POST | `/artifacts/:id/restore` | `{ version, baseVersion }` | Restores a version as the new latest; `409` if `baseVersion` isn't the latest |
| POST | `/artifacts/:id/versions/:v/bridge` | `{ op, args }` | A call the version made through `window.pim`: `{ value }`, or `{ needs }` when the person must allow it first |
| POST | `/artifacts/:id/versions/:v/grants` | `{ capability }` | Lets the version use `model` or `tool:<name>` |
| DELETE | `/artifacts/:id` | | Deletes it with every version |
| PUT | `/artifacts/:id/circles` | `{ circles }` | Shares it with those circles; `[]` stops sharing it |
| GET | `/shared-artifacts`, `/shared-artifacts/:host/:id` | | Artifacts others share with you, as their latest versions; `…/versions/:v`, `…/frame`, `…/bridge` and `…/grants` work as for your own |
| GET | `/files` | `?path=` (default `/workspace`) | `{ path, entries: [{ name, path, type, size, updatedAt }] }`: one folder, folders first |
| GET | `/files/content` | `?path=`, `&download` | The file's bytes, served as inert data: HTML, SVG and unknown types come back as `text/plain` with a sandboxing CSP |
| PUT | `/files/content` | `?path=`, the file as the body | Saves it, making its folders; `413` over 25 MB, `429` when your space is out of storage |
| DELETE | `/files` | `?path=` | Deletes a file, or a folder with everything in it |
| GET | `/browser` | | `{ available, page }`: whether this Pim has a browser, and the `url` and `title` it shows, or null when it's closed |
| GET | `/browser/screenshot` | | The page it shows, as a PNG; `404` when it's closed |
| POST | `/browser/live` | | `{ url }`: a Live View link to take the browser over, valid to open for five minutes. It carries its own access, so keep it to yourself; `501` where Browser Run doesn't offer Live View, as with a local Chrome |
| DELETE | `/browser` | | Closes it, with its pages and anything signed in there |
| GET | `/goals`, `/goals/:id` | `?status=active\|paused\|done\|abandoned` | Goals with steps and notes |
| DELETE | `/goals/:id` | | |
| GET | `/schedules` | | Pending scheduled tasks |
| DELETE | `/schedules/:id` | | Cancel one |
| GET | `/approvals`, `/approvals/:id` | `?status=pending\|approved\|denied` | Approval requests; each says what its timeout decides (`onTimeout`), who decided it (`decidedBy`: `user`, `timeout`, `always` or `majordomo`), and `review`: `{ status: "reviewing" \| "escalated", note }` while the majordomo has it, or after it asked you, with what it said; null when you were asked directly. `session` is the chat that asked, or null when a guest asked from their own space |
| POST | `/approvals/:id/approve`, `/approvals/:id/deny` | `{ note? }` | The decided approval; `409` if already decided |
| POST | `/approvals/:id/approve` | `{ note?, always: true }` | Also sets the approval's tool to `on`, so later calls run without asking, and approves other pending calls to it |
| GET | `/permissions` | `?circle=` | `{ tools: [{ app, appName, tool, name, description, readOnly, permission, default, chosen, changed, choices }] }`: Pim's own tools that ask first (`app: null`) and every connected app's tools, or with `circle`, that circle's (memory, and the apps' tools). `permission` is what applies: `off`, `ask` or `on`. `chosen` is yours, or null for the default |
| PUT | `/permissions` | `{ circle?, app, tool, permission }`: `app` null for Pim's own tools, `tool` the app's own name for it, `permission` null for the default | That tool's entry; `404` for an unknown tool or circle |
| GET | `/agents` | | `{ agents: [{ id, name, description, instructions, apps, skills, team, blueprint, source, published, icon, symbol, color, majordomo, createdAt, updatedAt }] }`: your agents, the majordomo first (see [Your agents](#your-agents)) |
| GET | `/majordomo` | | `{ agent, introduced }`: your majordomo, and whether you named it yet |
| POST | `/majordomo` | `{ name, symbol?, color?, yourName?, tone?: "warm" \| "formal" \| "playful" \| "brief", customTone?, helpWith?: ("work" \| "home" \| "health" \| "money" \| "learning" \| "travel")[], otherHelp?: string[], involvement?: "close" \| "balanced" \| "hands_off", locale?, title? }` | Names the majordomo, once (`409` after): its name and look; your name and what you'd like a hand with (`otherHelp`: up to six things in your words), which it remembers; and how it talks (`customTone` in your words) and how much it handles without asking you, which become its instructions. Then it opens the main chat, titled `title` (or "Welcome, <yourName>"), by introducing itself in `locale`'s language; returns `{ agent, introduced, session }` with that chat's id |
| POST | `/agents` | `{ name, description?, instructions?, apps?: [ref], skills?: [name], team?: [{ name, instructions, tools? }], blueprint?, symbol?, color? }` | A new agent. `symbol` is what shows for it without an uploaded icon: an icon's name, such as `rocket`, or one emoji; `color` is one of `gray`, `red`, `orange`, `amber`, `green`, `teal`, `blue`, `indigo`, `violet` or `pink`. Either may be null for the default. `tools` lists the tool names a team member may use; null or missing for all a member can have (see [Teams](#teams)). `blueprint` is what it builds on, such as `pim.assistant/pim`, or null for none; missing means the deployment's default blueprint |
| GET, PUT, DELETE | `/agents/:id` | PUT: any of the fields | The agent; editing reaches its chats from their next request, deleting moves them to the majordomo. The majordomo can't be deleted (`400`) |
| GET | `/skills` | | `{ skills: [{ name, description, version, author, restoredFrom, createdAt, updatedAt, agents: [{ id, name }] }] }`: your skills as their latest versions, and the agents that use each (see [Skills](#skills)). `author` is the agent that wrote the version, null for one you restored |
| GET, DELETE | `/skills/:name` | | The skill with its `instructions`, `files` (`[{ path, content }]`), its `agents`, and `history`, the versions kept, newest first; deleting deletes every version and takes it off every agent |
| GET | `/skills/:name/versions/:version` | | One version, with its `description`, `instructions` and `files` |
| POST | `/skills/:name/restore` | `{ version, baseVersion }` | Adds that version's content as the newest (`201` with the skill); `409` when `baseVersion` is no longer the latest |
| GET | `/agents/:id/dashboard` | `?locale=` | `{ agent, starters, widgets: [{ id, title, empty, kind, items } \| { id, title, empty, failed: true } \| { id: "artifact:<id>", title, artifact: { id, kind, version } }] }`: what its dashboard shows, widgets loaded for this agent and pinned artifacts as their latest version; until it's changed, the dashboard of the blueprint it builds on (see [docs/extensions.md](docs/extensions.md)) |
| PUT | `/agents/:id/dashboard` | `{ items }` | Sets what it shows, in order, by the `id`s above: each must be on it already, a widget it can show, or one of your artifacts; `400` otherwise, and past 12 |
| GET | `/extensions` | | `{ extensions: [{ id, name, description, blueprints: [{ ref, name, description, apps }], widgets }], defaultBlueprint, logo }`: what this deployment installed, and its sidebar logo (null for Pim's own) |
| GET | `/app-directory` | | `{ apps: [{ ref, name, description, url, custom }] }`: the apps you can connect, the extensions' then the admin's (`custom: true`). Agents list apps by `ref` |
| POST | `/sessions` | `{ title?, agent? }` | A new session with that agent, or the majordomo; sessions list their `agent` (null in a visit) |
| GET | `/sessions/:id/tasks` | | `{ tasks: [{ id, parent, agent: { id, name, member }, from: { id, name, member }, task, state, result, createdAt, updatedAt }] }`: the [tasks](#tasks) the chat led to, oldest first, as a tree by `parent`; `state` is `working`, `auth-required`, `completed`, `failed` or `canceled` |
| GET | `/sessions/:id/tasks/:task` | | One of them, with its conversation as `messages`, read-only |
| POST | `/sessions/:id/tasks/:task/cancel` | | Cancels it, and the tasks it handed out |
| GET | `/account` | | `{ username, ownerId, role, status, createdAt, usage, recoveryCodesLeft, alone }` (`alone`: nobody else has an active account here) |
| GET | `/account/export` | | Your account and everything in your space, as one JSON download, without credentials |
| DELETE | `/account` | `{ confirm: username }` | Deletes your account and erases your space; a signed-in browser only. `202` while erasing is still being retried |
| GET, PUT | `/profile` | PUT: `{ displayName, bio }` | How others on this Pim see you |
| GET | `/people/:username` | | `{ username, displayName, bio, templates }`: someone, and the agent templates they published |
| GET | `/templates` | `?q=` | `{ templates }`: shared agents, most used first, without their instructions |
| GET | `/templates/:id` | | A published agent template in full, with the `symbol` and `color` it was published with, and `icon`, the version of its uploaded icon or null |
| GET | `/templates/:id/icon` | | Its uploaded icon; `404` without one |
| POST | `/templates/:id/use` | | Makes it one of your agents: a copy, its look and icon too, with `source` saying where it came from |
| POST, DELETE | `/agents/:id/publish` | | Publishes your agent (again, to update it), or takes it down |
| GET | `/published-artifacts` | `?q=` | `{ artifacts }`: published artifacts, most used first, without their content |
| GET | `/published-artifacts/:id`, `…/versions/:v`, `…/versions/:v/frame` | | One, its content, and its page; `v` must be the published version |
| POST | `/published-artifacts/:id/versions/:v/bridge`, `…/grants` | | Its bridge calls and permissions, with your own data, model and tools |
| POST | `/published-artifacts/:id/use` | | Makes it one of your artifacts: a copy of the published version |
| GET, POST, DELETE | `/artifacts/:id/publish` | `{ public? }` | What you published of it, with its public `link` (`404` if nothing); publishes its latest version (again, to update it), `public` saying whether anyone with the link may see it; or takes it down |
| GET | `/circles` | | `{ circles: [{ id, name, enabled, createdAt, members: [{ ownerId, username, addedAt }] }] }` (see [Sharing](#sharing)) |
| POST | `/circles` | `{ name }` | A new circle, with nothing allowed |
| PUT | `/circles/:id` | `{ name?, enabled? }` | The circle; `enabled: false` pauses everyone in it |
| DELETE | `/circles/:id` | | Deletes it; its people's spaces are told |
| POST | `/circles/:id/members` | `{ username }` | Puts that person in the circle (moving them from another), and tells their space; `404` for an unknown username |
| DELETE | `/circles/:id/members/:ownerId` | | Takes them out; their space is told |
| GET | `/circles/activity` | | `{ activity: [{ id, at, username, circle, tool, outcome, summary }] }`: guests' tool calls, newest first; `outcome` is `ran`, `asked` or `refused` |
| GET | `/visits` | | `{ visits: [{ ownerId, username, sharedAt, available, session }] }`: spaces shared with you, and your conversation with each |
| POST | `/visits/:username` | | `{ session }`: your conversation with that space, started if new. Messages to it go through `/sessions/:s/messages` like any other |
| GET | `/mcp` | | Connected apps, their state, sign-in link, approval policy, tools (with their `permission`), and `agents`: the names of your agents that work with each |
| POST | `/mcp` | `{ app, approval? }` | Connects one of the directory's apps, by its `ref`; `201` with `{ id, state, authUrl? }` (`authUrl`: send the user there to sign in) |
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

The admin runs the Pim under `/admin`, from a signed-in browser only: an API token can't. See [docs/instance.md](docs/instance.md#running-it).

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/admin/stats` | | Accounts by status, registrations in the last day, unused invites, queued and failing cleanups |
| GET | `/admin/accounts` | `?status=&after=&limit=` | Accounts, by username |
| GET | `/admin/accounts/:username` | | The account, its usage, and its cleanup job if one is queued |
| POST | `/admin/accounts/:username/suspend`, `…/unsuspend` | `{ reason? }` | Stops the account at once, or restores it; not your own |
| GET | `/admin/deployment` | | `{ settings, variables: [{ name, value, problem }] }`: how the deployment runs, from its variables, and why Pim can't read any it can't (Settings → Deployment) |
| PUT | `/admin/accounts/:username/limits` | `{ limits }` or `{ limits: null }` | One person's limits over the deployment's |
| POST | `/admin/accounts/:username/setup-link` | | `{ setupUrl, expiresAt }`: adds a passkey once, within an hour |
| DELETE | `/admin/accounts/:username` | `{ reason? }` | Deletes it as its owner would; not your own |
| POST | `/admin/invites` | `{ count?, note? }` | `{ codes, links }`: single-use invite links, up to 100 |
| GET | `/admin/sign-in` | | `{ providers }`: Google, GitHub and custom OpenID Connect, whether the deployment's secrets turn each on (and which are missing if only some are set), their names, and the callback URL to register; never their values |
| DELETE | `/admin/templates/:id` | | Takes a published Pim out of Discover |
| DELETE | `/admin/published-artifacts/:id` | | Takes a published artifact out of Discover |
| POST | `/admin/apps` | `{ name, description?, url }` | Adds an app everyone can connect: a remote MCP server, named `custom/<id>` after its name (`201` with `{ app }`) |
| DELETE | `/admin/apps/:id` | | Takes it out of the directory. People's connections to it stay until they disconnect them |

### WebSocket

Connect to `wss://<host>/api/ws?session=<id>` (add `&token=...` without a passkey session); without `session`, the socket follows the root session. Each socket follows one session at a time; `follow` moves it to another, starting again with that session's snapshot, and `snapshot` returns another session's snapshot without following it. Message types are in [`src/protocol.ts`](src/protocol.ts).

- Server → client:
  - `hello`: the session and tools.
  - `events`: pi's [agent events](https://github.com/earendil-works/pi/tree/main/packages/durable#agent-events-experimental). The first batch starts with a `snapshot` that replaces client state.
  - `notification` and `approval`: sent to every socket.
  - `result` and `error`: replies to commands that carried an `id`.
- Client → server: `submit`, `abort`, `reset`, `resync`, `follow`, `snapshot`.

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

Pim registers with OpenAI as one agent host (a `urn:uuid:` ID it keeps) and refreshes the token itself, one refresh at a time, since OpenAI rotates refresh tokens. Memory compression stays on `PIM_MEMORY_MODEL`, or `PIM_MODEL`, so background work doesn't spend the plan. pi-ai sends these requests the way the flow requires: `store: false`, streaming, and no `temperature` or `max_output_tokens`.

## Utility model

Small jobs around a conversation go to one utility model rather than the chat's model: a fast, cheap one by default (`PIM_UTILITY_MODEL`), or any model you can chat with, such as one on your ChatGPT plan (Settings → Model → Utility model). Its requests count against the daily model limits, but not as runs. Today it:

- **Names chats.** A chat is called by the start of its first message at once, then by the few words the utility model picks. A rename in the meantime stays. Chat ⋯ → Regenerate names it again from the conversation so far.
- **Improves prompts.** The ✨ button in the message box rewrites the draft in place so the agent can act on it.
- **Summarizes chats.** The summary button in a chat's header opens a box at the top right with what the chat covered and the next steps; it stays open from chat to chat until closed. Nothing is written while it's closed, and a summary is kept until more is said.

Each job is a task in [`src/utility.ts`](src/utility.ts): instructions, a cap on the answer for models that don't reason, and how to clean the answer. `Pim.utility(task, input)` runs one on the utility model, and `conversationText` gives it a chat as what each side said, without tool calls or the agent's private notes. A new feature adds a task there and a route that calls it.

## Connected apps

Apps connect through remote [MCP](https://modelcontextprotocol.io) servers: the vendor's own (many apps publish one), or one you deploy as another Worker. The `agents` SDK's MCP client handles the connection, OAuth sign-in (with dynamic client registration), token storage in the agent's database, and reconnecting after a wake.

- **The directory.** People connect only the apps this Pim offers: those its extensions bring (`apps` in [an extension](docs/extensions.md#apps): MCP servers such as the bundled GitHub, Linear and Notion, or apps the extension implements for services without one, like the bundled Spotify app), and those the admin adds in Apps → Create new app, named `custom/<app>`. Nobody connects an arbitrary server. `GET /app-directory` lists them.
- **One sign-in for all your agents.** Agents, blueprints and templates list apps by name (`test.ledger/notes`, `custom/acme-crm`), never by URL. You connect an app once, and every agent of yours that lists it uses that connection. Agents and templates from before the directory listed `{ name, url }`: each is read as the directory's app at that URL, and left out while the directory has none.
- **Each agent lists its apps.** An extension's blueprint lists the apps it works with in its definition, and each of your agents can add its own (ask in chat, or click its sidebar ⋯ → Settings → Edit → Apps it works with). A chat gets the tools, instructions, and prompt entry of the apps its agent lists, and of no other, even when you connected more. Team members work with their agent's apps.
- **Connecting.** Connect from Apps in the sidebar's rail, an agent's settings modal (sidebar ⋯ → Settings), `POST /mcp` with the app's `ref`, or ask Pim: its `connect_app` tool connects one of the apps the chat's agent lists, without asking, since the agent already chose it. It can't connect anything else. If the app needs sign-in, the response (or Pim) gives you a link; the app sends you back to `/mcp/callback/<you>`.
- **Seeing them.** Apps, a dialog from the sidebar's rail, lists every app this Pim offers, whether you connected it, which of your agents work with it, and a sign-in link while it waits for one. Disconnect an app there. An app no agent lists does nothing until one does. An app you connected that the Pim no longer offers stays until you disconnect it.
- **Finding an app.** Say "use my Linear" and Pim's `find_app` tool looks it up in the directory by name, then by description, for its `ref`.
- **Managing apps in chat.** With `manage_apps` enabled, Pim requests additions and removals for its own agent, by `ref`. You approve the app names in chat; approval adds and connects new apps, and Pim resumes your task with their tools. An app the directory doesn't have is refused before you're asked. Each change requires your explicit decision, even under the `auto` approval policy: no timeout or Always approve. Settings → Tool permissions offers **Off / Ask** for this capability, separately from `update_agent`, which cannot change apps. Removing an app here does not disconnect the shared connection, change its tool permissions, or affect other agents. Blueprint apps cannot be removed this way. If sign-in is needed, Pim returns its link; it never needs your credentials in chat. If connection fails, the app stays on the agent's list so `connect_app` can retry, and the result explains the failure.
- **Tools.** Each MCP tool becomes a pi tool named `<app>_<tool>`. pi picks up added and removed tools from the next request, without a restart. The app's instructions go in the `connected_apps` prompt section.
- **Approvals.** Assigning an app to an agent, directly or through its blueprint, auto-approves its routine tools in that agent's chats and tasks, without a permission prompt. Explicit Off or Ask choices and changed-tool reapproval still apply, and the app's `all` policy still asks. Tools marked `destructiveHint: true` always wait for your own decision, with no timeout or Always approve, even under `none`; native apps mark these tools `destructive: true`. Unassigned apps are not offered to the agent. Outside assigned agents' calls, the default `writes` policy asks for tools that do not declare `readOnlyHint`; `none` trusts routine tools. These hints come from the app itself, so only connect apps you trust.
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

Settings → Tool permissions lists every tool that acts on the world or comes from an app, grouped by app, with Pim's own (`http_request`, `watch_app_event`, `update_agent`, `rename_agent`, `file_delete`, `browser_click`, `browser_type`) first. Each is **Off** (the model isn't offered it), **Ask** (each call files an approval) or **On** (it runs without asking). A tool you haven't set follows its default: Pim's own ask, and an app's follow its approval policy. **Always approve** on a request sets its tool to On.

- **Assignment is consent for routine tools.** An agent's assigned apps and blueprint abilities auto-approve calls unless you chose Ask or Off. Global permissions still show the unassigned default. Assignment never bypasses a risky tool's per-call decision, a changed-tool warning, an app's `all` policy, or a circle's separate permissions.
- **App management always asks.** `manage_apps` offers only Off / Ask. Each request waits for your explicit decision, even under the auto policy; turning it off also blocks pending changes.
- **Tied to the tool you saw.** An app tool set to On is held to its definition at the time: description, input schema and annotations. If the app changes any of them, Pim asks before each call again and Settings says so until you choose again.
- **Checked at each call.** An app tool's permission is checked again when the model calls it, so a tool turned off or changed since the tool list was built is refused or asked about.
- **Removing an app** forgets its tools' permissions. Tools chosen with Always approve before permissions existed become On the first time Pim sees them.

## Your agents

The chats panel offers three views, chosen from the vertical-dots menu beside Chats. **Agents** is the default, grouping conversations under each agent, with a new-chat button per section. **Inbox** is one list across agents and conversations with shared spaces, with the agent's name under each title; its sort menu beside search chooses recent activity or unread replies first (then recent activity within each group). **Majordomo** is just that agent's conversations, most recently active first, without section headings. Inbox and Majordomo have a quiet, left-aligned New chat button below search. New chat, there and in the mobile bar, starts a chat with the agent of the chat that's open, or with your majordomo anywhere else. The view and inbox sort are kept in your browser and apply to the mobile chats panel too. A dot on the left marks an unread response in every view; in Inbox it gently pulses unless reduced motion is preferred. Opening its conversation in a visible tab clears it once the transcript has loaded and the turn finishes. Read state belongs to your space, so it follows you between devices, independently of notification read state. Existing conversations start read when reply tracking is introduced; new replies become unread.

Your agents are named assistants, each with its own instructions: a marathon coach, a trip planner, a code reviewer. Each builds on a blueprint an [extension](docs/extensions.md) brings (sidebar ⋯ → Settings → Edit → Based on blueprint), Pim's own assistant unless you chose another, which gives it its habits, the extension's tools beyond Pim's own, and its dashboard; your name and instructions go on top. One is your [majordomo](#your-majordomo): it talks in chats started without choosing an agent, and its dashboard is the app's home. The sidebar has a section for each agent, named after it, with its chats, most recent first. Chats you open show as tabs above the transcript once there are two or more (a single one shows just its title), so you can switch between them with the sidebar collapsed; each tab shows when its chat is working or waiting for your approval. As in a browser, opening a chat from the sidebar shows it in the current tab, in place of the chat there; ⋯ → Open in new tab, or dragging the chat onto the conversation, gives it a tab of its own. New chats and links to chats open in new tabs, and closing a tab doesn't delete the chat. The tabs are kept in the browser, and each chat keeps its unsent text and scroll position while the page is open. Click an agent's name for its dashboard, or ⋯ → Settings for a settings modal with editing, publishing and deletion controls. Creating or editing an agent sets how it looks: one of the built-in icons or any emoji, in a color, or an uploaded image. The new-chat icon is immediately to the right of ⋯. Use New agent below the sidebar list to create another. A chat started with another (its sidebar new-chat button, or ⋯ → Settings → Chat) talks with that one. A chat's agent adds its name and instructions to the model's own habits; everything else is shared by all agents in your space: memory, connected apps, approvals, schedules. Edit an agent and its chats follow from their next request; delete it and they go on with the majordomo. An agent lists the apps it works with, by MCP server URL, besides those of the blueprint it builds on: its chats get only those apps' tools, and whoever uses it connects them with their own accounts.

**Rename in chat.** Ask any of your agents to rename itself or another of your agents, such as “Rename the assistant you just made to Quill.” `rename_agent` shows the old and new names for approval, keeping the agent's chats, instructions, apps and team. Its own Off / Ask / On permission is separate from `update_agent`; it follows your approval policy like other gated tools.

**An agent for everyone who joins.** The admin can choose one of their agents for new members (⋯ → Settings → Give everyone who joins a copy). Each person who joins after that gets a copy besides their majordomo: its name, description, instructions and suggested apps, theirs to change. Copies don't follow later edits to the admin's agent, and people who joined before don't get one.

**Dashboards.** Each agent's name in the sidebar opens its dashboard: a box to start a chat with it, suggested first messages, and what you asked it to show there. It starts empty (an extension's blueprint can start it with widgets of its own). Ask for something, such as "keep a chart of my spending here" or "show me today's NYC headlines", and the agent makes it as an [artifact](docs/artifacts.md), usually a small React app or page, and pins it with `update_dashboard`. A pinned artifact runs as its latest version, across the whole width: it can draw charts, keep its own data, and use your apps' tools through [the bridge](docs/artifacts.md#the-bridge), and the agent keeps one current with what only it can fetch, such as news, by updating it on a schedule. Clicking an item can put a message about it in the box below, with the artifact attached, for you to send (`pim.chat`); nothing is sent until you do. The agent can also pin Pim's own widgets: what's coming up, the goals being worked on, what it remembered lately, and what it made recently. Each card's × takes it off, and the expand button opens a pinned artifact on its own page. Each agent's dashboard is its own, and pinning needs no approval: it changes only your screen.

An agent can be **published** to the others on your Pim: Discover lists published agents, and anyone on it can read one in full and **make it their own**, which copies its name, description, instructions, suggested apps and look (its icon or emoji, color, or uploaded image) into their own agents. The agent the admin chooses for everyone who joins is copied the same way. Nothing else of the author's goes with it: no memory, chats or credentials. The copy is theirs to change; publishing again updates what others see, not their copies. Unpublishing, deleting the agent, or deleting the account takes it out of Discover. Each person has a profile (a name and a line about them), shown on their page and next to what they publish. Artifacts are published the same way, from Share on the artifact's page: a copy of its latest version, which anyone on your Pim can open from Discover and use with their own data, model and tools, or make their own (see [docs/artifacts.md](docs/artifacts.md#publishing)). Until someone else has an account on your Pim, there is nobody to publish for, so the app hides Discover and the Publish button.

A published agent's instructions are someone else's words running with your tools, so read them before you take one: your copy still asks before acting wherever your tool permissions say it should.

### Your majordomo

Your majordomo is the agent you come to first, for almost anything, and the one that knows you best. There is one, always the same: the title can't move to another agent, and it can't be deleted. It builds on the deployment's default blueprint (`defaultBlueprint` in `pim.config.ts`), and is edited like any agent.

- **Naming it.** The first time you sign in, you say your name, unless the Google, GitHub or single sign-on account you joined with already says it; then you name your majordomo and choose how it looks. Then, if you like, you pick how it should talk (warm, formal, playful or brief), what you'd like a hand with (work, home and family, health and fitness, money, learning, travel), and how much it should take care of without asking you (keep me in the loop, use your judgment, or take it off my hands); the first two also take an answer in your own words, and all of it is one Skip away. How it talks and how much it handles go into its instructions, where you can change them. Then it opens your first chat, "Welcome, <name>", itself: it introduces itself and asks about you, and you tell it as much or as little as you like, in your own words. It asks one question at a time and takes one topic at a time, so getting to know you happens over a few conversations rather than all at once. It remembers your name, what you'd like a hand with, and what you tell it in memory, which every agent shares. Accounts from before majordomos keep the agent they talked with as theirs.
- **It hands work down.** It doesn't do the work itself. It hands tasks to your other agents with `delegate` (see [Tasks](#tasks)), making one first with `create_agent` (with a team when the work has parts that can go on at once) when none fits. It doesn't wait for them: it tells you what it handed out and is free for whatever you say next, and when their answers arrive it tells you what came of them. Only the majordomo hands tasks to your other agents; any agent hands them to its team.
- **It is your face to your agents.** Under the `majordomo` approval policy, another agent's request for your approval goes to it first: in a chat you have with that agent, from a team member, or from an agent at work for it. In a conversation of its own, with your memory, it approves what it's sure you'd want, denies what's clearly against it, and asks you about the rest: anything that spends money, sends something in your name, shares private information or deletes things, and whatever it's unsure of. The request's card shows it deciding, then who decided and why, or what it asks you; you can always decide first. A request it asks you about notifies you and waits for you however long. One it hasn't decided in five minutes comes to you too. Its own requests, in its chats with you, and requests that need your own decision (`manage_apps`) or come from people in your circles, come straight to you.
- **It suggests apps.** When something you talk about would go better with one of this Pim's apps, it suggests that one app, and connects it if you want it. One you turn down it remembers, and doesn't suggest again unless you bring it up.

### Skills

A skill is how you want work that comes up again done, written down for your agents: how to plan your training week, what goes in the weekly report. It has a name such as `weekly-plan`, a description, and instructions in Markdown, as in [Agent Skills](https://agentskills.io).

- **Your agents write them.** When you ask an agent to remember how to do something, or it has worked out with you a task you'll ask for again, it saves it with `write_skill`. The request shows the whole skill, and nothing is saved until it is approved under your approval policy, as with `update_agent`, since a skill steers every later run that loads it. Settings → Tool permissions sets `write_skill` to Off, Ask or On.
- **Each agent lists the skills it uses**, as it lists apps. A skill an agent writes goes on its own list; `PUT /agents/:id` with `skills` gives one to another agent. Its chats list each skill's name and description, and the agent loads one with `read_skill` before the work it describes.
- **Supporting files.** A skill can carry up to 20 text files beside its instructions, by paths such as `references/paces.md` or `scripts/convert.js`, which the agent reads with `read_skill_file`. A script is an ES module whose `export default async function (input)` does the work, which the agent runs by passing it to `run_javascript` where the deployment can run code (see [Running JavaScript](#running-javascript)); agents are told about scripts only there. A rewrite that gives no files keeps the ones the skill had. The files live with each version, not in your files folder, so only an approved `write_skill` changes them.
- **Versions.** Every write adds a version, and the latest 20 are kept. A rewrite names the version it read; one approved after the skill changed is refused, so two rewrites never overwrite each other unseen.
- **Seeing them.** Skills, in the sidebar's rail, lists them. A skill's page shows what it says at any version kept, who wrote each, and the agents that use it: click an agent to give it the skill or take it away. Restore an older version (it becomes the newest) or delete the skill there.
- **Not yet:** installing a skill from your files, sharing skills through Discover, and serving them to other apps over MCP.

### Tasks

Agents hand each other work as tasks, with `delegate`: your majordomo to your other agents, and any agent to the members of its team. In a chat you talk with an agent; in a task an agent talks with the agent that handed it the task, and nothing in it is yours. Tasks follow [A2A](https://a2a-protocol.org/)'s task model, inside your space.

- **Nobody waits.** `delegate` returns at once with each task's id, and the agent that handed them out goes on, or ends its turn, so you can keep talking with it. Tasks handed out together work at the same time, each in a conversation of its own.
- **States.** A task is `working`, then `completed` with its agent's answer, `failed`, or `canceled`. While its agent waits for your approval it is `auth-required`.
- **Answers come back once.** When none of the tasks handed out together is working, their answers come to the agent that asked, in one message starting with "[Task update]", which the chat shows as a notice. A task waiting for your approval doesn't hold up the others: the update says it waits, and its answer comes in an update of its own. An agent that hands out tasks of its own while working on one answers its task once those have come back.
- **The chat shows the work**, above the composer: every task the chat led to, as a tree, with who does it and its state. A task opens read-only, with what it was asked and what its agent did, and one not done can be canceled there: its agent stops, the tasks it handed out are canceled, its pending approval requests are denied, and the agent that asked hears it was canceled. Deleting a chat cancels its tasks. Tasks' conversations aren't chats in the sidebar.
- **Approvals.** A task's tools ask before acting, as in a chat. The request shows in the chat the work began in, labeled with the agent or member that asked; the agent waits for the decision, which its call returns.
- **Following up.** To carry on with a task that is done, an agent hands out another that `continues` it, in the same conversation, where the earlier work is.

### Teams

An agent can have a team: up to eight members, each with a name, its own instructions and, optionally, the tools it may use. You still talk to one agent. It hands members [tasks](#tasks), they work at the same time, and it combines their answers when they arrive. A coding agent, for example, can be a planner that hands parts of the change to a few coders.

- **Members answer the agent, never you.** They don't get `send_to_user`, scheduling, watching apps' events, or `delegate`. Given a list of tools, a member gets only those.
- **Copies.** Publishing an agent, making one your own, and the agent everyone who joins gets copy its team.

## Talking with Pim from other apps

Claude, ChatGPT and other MCP clients can talk with your [majordomo](#your-majordomo). Add `https://<your Pim>/mcp` to one as a custom connector (Settings → Account → MCP clients shows the address). It works like Amp's Puck over MCP: the server has one tool, `pim`, which sends a message to your majordomo and returns its reply.

- **Connecting signs you in.** The client registers itself with Pim ([dynamic client registration](https://datatracker.ietf.org/doc/html/rfc7591)) and opens Pim's `/authorize` page, where you sign in if you aren't already and see who is asking and where access goes. Allow sends it back with a code it exchanges for tokens. Pim is the OAuth authorization server for its own MCP server, as the [MCP authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) asks, with [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider): discovery at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`, registration at `/oauth/register`, and tokens at `/oauth/token`, with PKCE. Clients, grants and hashed tokens are kept in the `OAUTH_KV` namespace, which deploying creates (see [`src/mcp-auth.ts`](src/mcp-auth.ts)).
- **Access lasts while it's used.** An access token lasts an hour, and the client refreshes it. A connection ends after 30 days without use, or when you disconnect it in Settings → Account → MCP clients.
- **API tokens work too**, for clients without OAuth: send one from Settings → API tokens as `Authorization: Bearer <token>`.
- **A new chat per call, unless the client continues one.** Every reply names its conversation, a chat with your majordomo that you can also continue in Pim; a call that passes it back as `conversation` continues that chat, and one without it starts a new one. Only your majordomo's chats can be continued this way.
- **It hands work down as in the app.** Your majordomo hands bigger work to your other agents as [tasks](#tasks), and the reply waits for their answers too: it has everything the majordomo said, about the tasks as well. Work waiting for your approval comes back to its chat later, so asking again in the same conversation ("did Concierge book it?") tells you how things went.
- **A reply waits up to 45 seconds.** A turn still going after that answers "still working", or what the majordomo said so far and that it is still waiting on some of the work; ask again in the same conversation in a little while, and that message is answered once the turn before it ends.
- **Everything else works as in the app:** approvals, usage limits and tool permissions.

A connection opens only `/mcp`; an API token opens your whole API, so give it only to clients you trust.

## Sharing

You can let others on your Pim message your agent from their own space. Sharing → Circles: make a circle (Family, Close friends, Acquaintances), add people by their username, and choose what the circle can use: each connected app's tools (Off, Ask or On, as in [Tool permissions](#tool-permissions)) and your memory (read-only). Everything starts off. Until someone else has an account on your Pim, the app hides Sharing.

- **Their conversation runs in their space.** Someone you share with finds your space under Shared with you. Their conversation with it (a visit) is a chat in their own space, on their own model and usage: whoever sends the messages pays for them. It sees a brief your space sends before each of their turns: what their circle may use, your memory if allowed, and your time zone. Nothing of their own space (its tools, memory or apps) is in that conversation, and nothing of yours is in their other chats.
- **The boundary is in your space, at every call.** Each tool in a visit is a call into your space (`guestCall`), which checks again that they're in a circle, that the circle is on, and that the tool is allowed for it now. A tool turned off, an app that changed a tool since you allowed it, or a person you removed is refused, whatever their space was told before.
- **Ask means you decide.** A call to a tool set to Ask files an approval that names who asked and through which circle, and notifies you. Their conversation goes on; your decision arrives in it later as a message. Unanswered, it is denied after a day: a guest's request is never approved by a timeout. **Always approve for Family** sets the tool to On for that circle.
- **Limits.** Up to 20 circles and 200 people in them. Each guest can make 200 calls into your space a day, so your apps' own limits stay yours. Sharing → Recent activity lists what guests used, asked for, or were refused.
- **Taking it back.** Remove someone, or turn a circle off, and their next turn is refused. Deleting a circle forgets its permissions.
- **Artifacts too.** Share an artifact with circles from its page, and their people find its latest version under Artifacts → Shared with you, running in their own space with their own model and data; what it keeps for everyone (`pim.shared`) stays in yours. See [docs/artifacts.md](docs/artifacts.md#sharing).

## Develop

```sh
pnpm test        # Vitest in workerd, with pi-ai's faux model, then the web app's tests; no Cloudflare account needed
pnpm test:live   # live checks against real MCP servers (Hugging Face's); needs the network
pnpm typecheck   # also generates the web app's route tree, so it works on a fresh checkout
pnpm types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
pnpm lint        # Biome, for the web app
pnpm check       # typecheck, lint and test, as CI does
pnpm preview     # a Pim with a stand-in model and a passkey-free sign-in, at http://localhost:8787, with no Cloudflare login (see docs/instance.md)
```

The web app is in [`web/`](web), with its own README. Sign-in, with passkeys and other providers, is in [`src/auth/`](src/auth).

To add a blueprint, tools only some agents get, or dashboard widgets, write an extension with a base and list it in `pim.config.ts` (see [docs/extensions.md](docs/extensions.md)). To add a tool, write a pi extension in `src/extensions/` and install it in `Pim`'s harness factory. A tool with effects outside the conversation should be a `GatedAction` (see `src/extensions/approvals.ts`) so it runs only after approval.

## Not built yet

- Falling back to `PIM_MODEL` when the ChatGPT plan's usage limit is reached. Until then, a run that hits the limit fails with OpenAI's error.
- A sandboxed computer for the agent beyond its files, JavaScript and browser: a shell, packages and other languages (Cloudflare Containers). And signing in once for the agents: the browser forgets a sign-in when it closes.
- Extensions beyond MCP: installing Agent Skills from elsewhere, and full pi extensions that Pim builds into itself by redeploying its own Worker.
- Secret placeholders, so approved requests can use credentials the model never sees.
- Semantic recall. `recall` is a regular expression over the log, so it finds words, not meanings.
