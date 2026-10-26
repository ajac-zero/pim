# How Pim works

The details behind the [README](../README.md): what Pim is made of, how to deploy and run it, its API, and how each part behaves.

**Vocabulary:** Pim is the platform; a space is one person's own part of it, with their agents, conversations, memories and files; an agent is what you create and chat with; a blueprint is what an extension defines in code for agents to build on; a template is an agent shared through the gallery.

This repository is the agent, its API, and its web app ([`web/`](../web)): chat, approvals, notifications and settings, signed in with a passkey, or with Google, GitHub or your own single sign-on when you set those up. One Worker serves all of it, for everyone, at one address. Mobile apps and messaging bridges can use the same API with an API token, and Claude, ChatGPT and other MCP clients can talk with your majordomo at `/mcp` (see [Talking with Pim from other apps](#talking-with-pim-from-other-apps)).

## Chats

A chat with no activity for two weeks moves to Archived, folded at the bottom of the chat list, so the list holds what's current. Until then, chats sit under dividers for today, yesterday, last week and the last 14 days. It is not deleted: search finds it, it opens as before, and sending it a message brings it back. A chat with an unread reply, or one still working, stays in the list. Archive in a chat's options menu moves it there at once, whatever its age; sending it a message brings it back.

The copy button in a chat's header copies the conversation as Markdown, with separate headings for the user, the named agent and system notices. It becomes available when the chat finishes loading and the agent finishes replying. Message formatting stays intact; attached images are marked with a placeholder, and private reasoning and tool activity are left out.

The globe button beside it makes a public link to the chat: a copy of the conversation as it is then, which anyone with the link can read at `/shared/<owner>/<link>`, without an account. The copy is what you read in the chat: your messages and what the agent sent you, with the widgets that went with them as they were. The images you attached, Pim's own notices, private reasoning and tool activity are left out, and so is everything said after it was made. **Update to include new messages** copies the chat again under the same link. **Turn off link**, deleting the chat, or deleting the account makes the link answer `404`; a browser that read it in the last minute may still show its copy. The page asks search engines not to index it, and shows the copy as untrusted text: no images load, no HTML runs, and links go only to web and mail addresses. A chat with someone else's agent (a visit) can't have a link.

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
- **One space per person.** The Worker reads whose request it is from the browser's session or the API token, and sends it to that person's Durable Object, which holds their memory, apps and agents in its SQLite database. A URL never chooses whose space answers. See [docs/instance.md](instance.md).
- **A model that can do the job.** Pim decides what to say and when, and says it with a tool call, so it needs a capable model. The default is GLM-5.3 on Workers AI (`@cf/zai-org/glm-5.3`), billed to your Cloudflare account, with no vendor keys. Any AI Gateway catalog model works too, such as `anthropic/claude-opus-4.8` (set `PIM_MODEL`), or OpenAI's through your ChatGPT plan, or any model on a server that speaks OpenAI's chat completions, which you or the admin add in Settings (see [Model providers](#model-providers)). Each person chooses one model for all their chats, in Settings → Model or from the model's logo beside the send button.
- **Your ChatGPT plan**, optionally. Sign in with ChatGPT (Plus or Pro) and Pim runs on OpenAI's models, such as GPT-6.1 Sol, using the plan's included usage. See [ChatGPT plan](#chatgpt-plan).

## What the agent can do

In chat, agents link to your files with Markdown such as `[Report](/workspace/report.csv)`, which opens Pim's file viewer. Older replies using `sandbox:/workspace/...` open there too; they don't need to be regenerated. Files still belong to your space and require sign-in.

| Capability | Tools | How |
| --- | --- | --- |
| Long-term memory | `note`, `recall`, `zoom`, `forget`, `move_memory`; the majordomo's `create_memory_scope`, and `share_memory_scope`, which asks first | OptMem-style: an append-only log, compressed in the background into a tree of summaries, kept in scopes that different agents read. Every conversation sees a fixed-size view of the scopes its agent reads. See [Memory](#memory). |
| Artifacts | `artifact_create`, `artifact_update`, `artifact_read`, `artifact_show`, `artifact_list` | Documents, HTML pages, React apps, drawings and diagrams the agent makes for you, with every version kept; pages and apps can span several files, copies of your own files among them. They open in a canvas beside the chat, and are listed in Artifacts; they run in a sandbox apart from your account, and can be edited, printed, restored, downloaded, shared with your circles or published. Through `window.pim` they can keep data, and with your permission ask the model or use an app's tools. See [docs/artifacts.md](artifacts.md). |
| Your computer | `shell` (gated), `file_read`, `file_list`, `file_find`, `file_search`, `file_write`, `file_edit`, `file_delete` (gated) | A machine of yours, such as a server, a VM or a box at home, that runs `pim-computer` and connects out to your space (see [Your computer](#your-computer)). Agents run commands on it with `shell`, which asks first and shows the command ("Run on your computer: …"), so they can install packages, use other languages, clone repositories or join your Tailscale network; and they keep their files in one folder there, `/workspace` to them. You see that folder under Files in the sidebar, where you can upload, preview, download and delete; every agent you chat with, and every agent at work on a task, reads and writes the same files. Deleting asks first, because files keep no earlier versions. Uploads are at most 25 MB each. Without a computer, agents have neither, and Files is hidden; while it's offline they're told so when they try. |
| The browser | `browser_open`, `browser_read`, `browser_screenshot`, `browser_close`, `browser_click` and `browser_type` (asking first) | The Chrome on [your computer](#your-computer), which your agents share, for pages `fetch_url` can't read and for clicking through sites. It browses from your machine, with its address, and keeps its own profile there, so what you sign in to stays signed in, and sites treat it as you. Agents read a page as its text, with what can be clicked or typed into numbered; clicking and typing ask first, naming the element as the page shows it ("On shop.example, click the button “Buy now”"), and Settings → Tool permissions can let them run. It starts when an agent first needs it and quits after half an hour unused. Each chat has a window of its own in it, and so does each task an agent hands another, so agents browsing at once don't take each other's pages; what you signed in to is signed in in every window. A window opens again where it was when its chat next needs it, after the browser quit or its computer slept; at most six are open at once, and opening another closes the one used longest ago. To sign in, or to get past a check that you're human, open the box beside the chat (the list button at its top right, which has a dot while the chat's window is open), expand the Browser dropdown under Summary, which shows the window (that of a task the chat handed out, if it was used last), and choose Take over: a tab shows the page as it is, live, for you to use with your mouse and keyboard, and the agent goes on in the same page. Its picture loads only while the dropdown is expanded. Taking over opens the window if it's closed, starting the browser, and waking a computer Pim started if it's asleep. Screenshots go to your files. Without a computer, or on one without Chrome or Chromium, there is no browser. See [Your computer](#your-computer). |
| Images | `generate_image` | Agents draw images from a description, with the deployment's image model on Workers AI (`PIM_IMAGE_MODEL`, FLUX.2 [klein] 4B unless set), square, landscape or portrait, and save them to your files, under `/workspace/images/` unless they name a place, so `generate_image` needs a computer. Each one shows in the chat where it was made, opening the file, and counts as a model request toward your daily limit; Workers AI bills it to the Cloudflare account, about a tenth of a cent an image with the default model. The ChatGPT plan can't make images: OpenAI's plan sharing doesn't include its image generation. |
| Your agents | `create_agent`, `update_agent`, `manage_apps` (edits gated) | Every chat's agent knows your other agents and points you to the one made for what you ask. When none fits ongoing help you want, such as a coding helper, it makes one, with its instructions, apps, contacts, and an emoji and color for its icon, without asking; it never makes two with the same role. It can change its own name, role, instructions, description, contacts and icon (an emoji and color, or an image from your files or the web), or request changes to its own apps through the approval flow. Your majordomo can make those changes to any of your agents. See [Your agents](#your-agents). |
| Dashboards | `update_dashboard` | Each agent's dashboard starts empty. Ask for something there, such as a chart of your spending or today's headlines, and the agent makes it as an artifact with a small widget and pins it; it can pin a widget, such as your goals, too. See [Your agents](#your-agents). |
| Goals and plans | `create_goal`, `update_goal`, `list_goals` | Goals have step-by-step plans and progress notes. Active goals are always in the prompt. |
| Background work | `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` | Delays, dates, or cron. When a task fires, the agent receives a `[Scheduled task]` message in the session that scheduled it, or, with `new_chat`, in a new chat with the same agent each time, titled with the task's label (the majordomo can schedule such a task for another of your agents, whose chats it then starts), and you get a notification that links to that chat. Schedules, in the sidebar, lists what's pending, soonest first, each opening the chat it runs in, and cancels any of it. Deleting the chat that scheduled a task cancels it, unless the task starts new chats: that one goes on until cancelled. |
| Talking to you | `send_to_user` | The only way Pim speaks: you see what it sends, and none of its working notes or reasoning. A successful send ends the turn by default; a progress update uses `complete: false` and must be followed by a final send. User-started turns that end without sending get up to two private correction prompts, then fail rather than showing private text. Background work can stay silent. A message can carry up to four widgets, such as your goals or what's coming up, drawn by the app from your data as it is when sent; the model names them instead of retyping what they show (see [docs/extensions.md](extensions.md#in-chat)). It can also show cards of things the agent found, such as products, places or pages, each with its link and image, and galleries of images, such as an image search's results: the agent writes them as ` ```cards ` and ` ```gallery ` blocks of JSON in its Markdown, and the app draws them. An image must be one a tool's result in the chat gave, such as a page's preview image from `fetch_url`, so the agent can't make one up; Pim keeps a copy when the message is sent, and the browser loads only that. Email, push notifications, API replies and public links get them as lists of links. A ` ```mermaid ` block is drawn as a diagram in the message, in a sandboxed frame like a Mermaid artifact's (see [docs/artifacts.md](artifacts.md#how-an-html-artifact-runs)), in the app's light or dark mode; one Mermaid can't draw, and every one outside the app, shows as its source. A message goes to the conversation, or to your email when the deployment can send it (see [Email](#email)). A reply in the chat is sent as Web Push to browsers that turned it on in Settings (even with the app closed) if no device has read it ten seconds later, so you hear from your agents whenever you aren't looking at the conversation; a browser showing that chat doesn't show it. |
| Asking first | `http_request` | Gated: the call files an approval request and waits for the decision; your apps and devices are told. The action runs when you approve; deny to stop it. Either way the call returns the decision, with the result, and the turn goes on from there. While it waits the call is suspended: it holds no memory, the space can sleep, and the chat stays busy, so a message you send meanwhile waits its turn. It waits however long you take. The approval policy says who answers: under `majordomo` (the default), other agents' requests go to your [majordomo](#your-majordomo) first, which decides those it's sure about and asks you about the rest; `auto` approves what you don't answer within 30 seconds, so autonomous jobs never stall; `explicit` waits for you, so nothing happens without your yes. Choose **Always approve** and later calls to that tool run without asking. Settings → Tool permissions sets each such tool to Off, Ask or On (see [Tool permissions](#tool-permissions)); an app's tools are switched on or off for each agent instead. |
| Connected apps | `connect_app`, `list_apps`, `find_app`, plus each app's tools; the admin's majordomo's `add_custom_app` (gated) | The apps this Pim offers: remote MCP servers, with OAuth sign-in, which you connect once for all your agents. A chat works only with the apps its agent lists, and each of their tools is on or off for that agent: on, it runs without asking. See [Connected apps](#connected-apps). |
| Skills | `write_skill` (gated), `install_skill` (gated), `read_skill`, `read_skill_file` | Your agents write down how you want work that comes up again done, or install skills others published, with your approval, and load them before doing that work. Each writes only its own skills; your majordomo also writes them for your other agents. Each agent has a switch for skills on its page. Apps publish skills too, over the MCP Skills extension, checked against the app's digests. See [Skills](#skills). |
| App events | `list_app_events`, `watch_app_event`, `list_watches`, `stop_watch` | Apps notify Pim when something happens (draft MCP Events, webhooks); each event starts a run with the watch's instruction. |
| The web | `fetch_url` | Reads a page by its address, and lists its images, its preview image first. Searching the web is an app's, such as Exa or Firecrawl, which each person connects (see [Connected apps](#connected-apps)). |
| Time | `current_time` | Shows UTC and the person's time zone. |

The chat never displays raw tool calls, their arguments or results, working notes, or reasoning, including while a run streams. These remain in the durable transcript for debugging. A tool call is only a step in the folded "Worked for …" list, marked ✓ once approved, ✗ if denied, or with a clock while it waits. The request itself, with Approve and Deny, waits under "Waiting for you" in the box beside the chat (the summary button in its header), which opens by itself while one is waiting. Generated artifacts keep their dedicated user-facing cards; a busy indicator shows when Pim is working.

File links in an agent's replies and generated images open in the same resizable canvas beside the chat as artifacts, or over the chat on narrow screens. Close the viewer to return to the full conversation. Files opened from the sidebar still have their own page.

## Deploy

Pim's Durable Objects run on the Workers free plan, but the default model, GLM-5.3 on Workers AI, needs the Workers Paid plan or prepaid AI Gateway credits. For a free first look, set `PIM_MODEL` to `@cf/zai-org/glm-4.7-flash`, which runs on Workers AI's daily free allocation but is not good enough for real use; or connect a ChatGPT plan in Settings.

Images people send in chats and skills' files are kept in one R2 bucket, and artifacts' files in another (people's own files are on [their computers](#your-computer)); deploying creates both. R2 has to be turned on for the account first: in the dashboard, open Storage & databases, then R2, and add the R2 subscription. Its free tier covers 10 GB, but Cloudflare asks for a payment method.

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

`wrangler.jsonc` is the same for every deployment, so deploy it as it is. What's yours is a variable you set in the dashboard (Workers & Pages → `pim` → Settings → Variables and Secrets), not in `wrangler.jsonc`: `keep_vars` keeps them through deploys, and saving one there applies it at once. Leave any of them unset for its default (in [`src/deployment.ts`](../src/deployment.ts)). The admin sees what each is, and any Pim can't read, in Settings → Deployment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIM_PUBLIC_URL` | none: required | The address people use, such as `https://pim.example.com`: passkeys, apps' callbacks and the links Pim makes belong to it. Pim answers only there, sends the web app there from any other address, and answers nothing until it's set |
| `PIM_CONTENT_ORIGIN` | unset | Another address, routed to this Worker, for public artifact links (see [docs/artifacts.md](artifacts.md#public-links)); unset turns links off. It must differ from `PIM_PUBLIC_URL` |
| `PIM_REGISTRATION` | `invite` | How people join once there is an admin: `invite` (links the admin makes), `open` or `closed` |
| `PIM_MAX_ACCOUNTS` | unset | Accounts allowed in all; unset for no cap |
| `PIM_REGISTRATIONS_PER_ADDRESS` | `3` | Accounts one IP address may make in a day |
| `PIM_MODEL` | `@cf/zai-org/glm-5.3` | Model for new sessions: a Workers AI id or an AI Gateway catalog id |
| `PIM_MODELS` | unset | Workers AI or AI Gateway models sessions may use besides `PIM_MODEL`, comma-separated; unset allows any |
| `PIM_UTILITY_MODEL` | `@cf/ibm-granite/granite-4.0-h-micro` | Small Workers AI model for side jobs, such as naming chats (see [Utility model](#utility-model)); `off` turns them off. Each person can choose another in Settings |
| `PIM_MEMORY_MODEL` | unset | Model that compresses memories; unset uses `PIM_MODEL`, never the ChatGPT plan |
| `PIM_MEMORY_LINES` | `96` | Lines of long-term memory in every prompt (about 8k tokens) |
| `PIM_IMAGE_MODEL` | `@cf/black-forest-labs/flux-2-klein-4b` | Workers AI text-to-image model `generate_image` draws with, such as `@cf/black-forest-labs/flux-1-schnell` or `@cf/leonardo/lucid-origin`; `off` leaves agents without it |
| `PIM_APPROVAL_POLICY` | `majordomo` | Who answers approvals: `majordomo` sends other agents' requests to each person's majordomo, which decides or asks them; `auto` approves what nobody answers after 30 seconds; `explicit` waits for the person however long. Each person can change theirs in Settings |
| `PIM_TIME_ZONE` | `UTC` | IANA time zone for anyone who hasn't set theirs; joining sets the browser's |
| `PIM_LIMIT_DAILY_TOKENS`, `PIM_LIMIT_DAILY_MODEL_REQUESTS`, `PIM_LIMIT_DAILY_RUNS`, `PIM_LIMIT_SESSIONS`, `PIM_LIMIT_SCHEDULES`, `PIM_LIMIT_STORAGE_BYTES`, `PIM_LIMIT_ARTIFACTS`, `PIM_LIMIT_ARTIFACT_VERSIONS`, `PIM_LIMIT_ARTIFACT_BYTES`, `PIM_LIMIT_ARTIFACT_STORAGE_BYTES` | unset | Members' usage limits, one each, as whole numbers; unset is none. The admin has none. What each counts is in [`src/usage.ts`](../src/usage.ts) |
| `PIM_EMAIL_FROM` | unset | The address Pim emails from (see [Email](#email)) |

A variable Pim can't read counts as its default, except a limit or a cap on accounts, which counts as 0, so a typo never lifts it. Settings → Deployment says which and why.

Attach your domain in the dashboard too (Workers & Pages → `pim` → Settings → Domains & Routes): deploys leave it alone.

`ratelimits` in `wrangler.jsonc` slow down sign-in attempts from one address and API requests from one person; leave them out and nothing is slowed down. Their namespace IDs must be unique in your Cloudflare account.

Pim comes with 38 apps ([`popular-apps.ts`](../src/extensions/popular-apps.ts), [`spotify.ts`](../src/extensions/spotify.ts), [`gmail.ts`](../src/extensions/gmail.ts), [`google-drive.ts`](../src/extensions/google-drive.ts)): Airtable, Amp, Atlassian (Jira and Confluence), Attio, Cal.com, Calendly, ClickUp, Cloudflare, Context7, Exa, Firecrawl, Fireflies, GitHub, Gmail, Google Drive, Granola, Hex, Hugging Face, Intercom, Jotform, Klaviyo, Linear, Make, Mercury, Miro, monday.com, Neon, Netlify, Notion, PayPal, PostHog, Sentry, Spotify, Stripe, Supabase, Todoist, Webflow and Wix. All but four work as they are. Four need secrets of your own, set with `wrangler secret put`; until they are, nobody is offered the app, and its actions say which are missing (by name, never value):

- **GitHub**: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, from an OAuth app at [github.com/settings/developers](https://github.com/settings/developers) whose callback URL is `https://<your Pim>/mcp/callback`. GitHub's MCP server doesn't let apps register themselves, so Pim signs everyone in with this one.
- **Spotify**: `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`, from an app at [developer.spotify.com](https://developer.spotify.com/dashboard) whose redirect URI is `https://<your Pim>/mcp/callback/apps`.
- **Gmail** (search and read mail; never sends, drafts, labels or deletes, and never downloads attachments): `GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET` and `APP_CREDENTIALS_KEY`, as below.
- **Google Drive** (reads only the files each person picks for Pim; never writes, shares or deletes): `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_API_KEY`, `GOOGLE_DRIVE_APP_ID` and `APP_CREDENTIALS_KEY`, as below.

`APP_CREDENTIALS_KEY`, 32 random bytes in base64 (`openssl rand -base64 32 | wrangler secret put APP_CREDENTIALS_KEY`), encrypts people's sign-ins to apps Pim implements, such as Spotify, in their spaces. It is optional for those, but Google's apps aren't offered without it. Keep it: changing or removing it means people connect those apps again.

Google's apps (see [Google apps](extensions.md#google-apps)) each need an OAuth client of their own, in a Google Cloud **project** of their own: Google keeps a person's grant per project, every client in a project shares it, and revoking it (which disconnecting does) revokes the tokens of every client in that project. Separate clients in one project are not enough. So use one project for Gmail, another for Drive, and neither for Pim's own Google sign-in (`PIM_GOOGLE_*`). Pim checks: a sign-in whose grant holds more than the app asks for (because its project serves something else too) is refused, and left unrevoked so the other grant survives. In the [Google Cloud console](https://console.cloud.google.com/), for each app:

1. Make a project for it.
2. Enable the API the app uses: the Gmail API; or the Google Drive API and the Google Picker API.
3. Set up the OAuth consent screen (Google Auth Platform → Branding, Audience, Data access): the app's name, support email, your Pim's domain, and the app's scope: `gmail.readonly` for Gmail, `drive.file` for Drive. Who may sign in, and for how long, is Google's to decide by the app's user type, publishing status and verification, and its rules change; check [Google's overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview) for your case. As Google describes them now: an **Internal** app (a Google Workspace organization's own) is open to that organization's users and isn't verified. An **External** app in **Testing** is open only to the test users you list (at most 100), and their sign-ins expire after 7 days, after which they connect again. A **published** External app that asks for a sensitive or restricted scope, unverified, shows people an unverified-app warning and is capped at 100 users; `gmail.readonly` is restricted, so verifying Gmail involves a security assessment, while `drive.file` is not a sensitive scope. Pim doesn't change any of this.
4. Make an OAuth client (Clients → Create client) of type Web application, with the authorized redirect URI `https://<your Pim>/mcp/callback/apps`.
5. Set its ID and secret as the Worker's secrets: `GOOGLE_GMAIL_CLIENT_ID` and `GOOGLE_GMAIL_CLIENT_SECRET`, or `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET`. Until they and `APP_CREDENTIALS_KEY` are set, nobody is offered the app.
6. For Drive, the Picker: make an API key in the Drive project (APIs & Services → Credentials), restricted to the Google Picker API and to the website `https://<your Pim>/*`, and set it as `GOOGLE_DRIVE_API_KEY`; set the project's **number** (not its ID, from the project's dashboard) as `GOOGLE_DRIVE_APP_ID`, so Google grants Pim the files people pick. The key is shown to people's browsers, as Google intends, so restrict it. The OAuth client needs no JavaScript origins: the picker gets its token from Pim.

People pick Drive files on Pim's page `https://<your Pim>/app-pages/google/drive` (Drive's tools give its link). It is served under a strict content security policy that lets Google's Picker load, and gets from Pim, only for the browser signed in as the person, the connection's current access token (an hour at most, `drive.file` only), never its refresh token or client secret: the Picker can't run without one. While it lives, that token could read and change the files the person picked for Pim, from that page; the page keeps it in memory only, and Pim never logs it. Pim then checks each pick with Google and keeps only those Google confirms, with their resource keys, encrypted with the credential; the tools read only those, and Google checks each read. Removing a file there only stops Pim reading it.

Disconnecting a Google app revokes its grant at Google; so does erasing an account. If Google can't be reached then, the person can remove Pim at [myaccount.google.com/connections](https://myaccount.google.com/connections). A grant revoked at Google, or expired, shows the app as failed in Apps, to be connected again.

### Email

Pim can email each person, when they ask for it or for something worth keeping, such as a report. It's off until you set it up with [Cloudflare Email Service](https://developers.cloudflare.com/email-service/): onboard a domain for Email Sending, then add to `wrangler.jsonc`

```jsonc
"send_email": [{ "name": "EMAIL" }],
```

and set `PIM_EMAIL_FROM` in the dashboard to an address on that domain, such as `pim@example.com`. Each person then adds their address in Settings and confirms it with a code Pim emails there; Pim only ever emails that one address, at most 50 times a day.

### Your computer

Agents run commands and keep files on a machine of each person's own, which runs [`computer/pim-computer.ts`](../computer/pim-computer.ts): a single file for Node.js 22.18 or later, with nothing to install, which the Pim serves at `/pim-computer.ts`. It connects out to the space over a WebSocket, so the machine needs no open port and can sit behind NAT. Settings → Computer makes its token and shows the commands to start it, with Node.js or Docker:

```sh
curl -fsSLO https://pim.example.com/pim-computer.ts
PIM_URL=https://pim.example.com PIM_COMPUTER_TOKEN=pimc_… node pim-computer.ts
```

It keeps the files in `~/pim` (`PIM_COMPUTER_ROOT` or `--root` sets another folder), and reconnects by itself after a drop; to keep it running across restarts, run it under systemd or as the Docker container Settings shows, which installs Chromium the first time it starts.

The computer's Chrome is the agents' browser: `pim-computer` finds Google Chrome or Chromium where it's usually installed (`PIM_CHROME` or `--chrome` names another), starts it headless when an agent first needs it (`--headful` shows its window instead), and lets the space drive it over the DevTools protocol through its connection. Its profile, in `~/.pim-computer/browser`, keeps what you signed in to between runs, including sign-ins that last only for the session. It quits after half an hour with nobody using it. Settings → Computer says when a computer has no browser. A space has one computer: a new token replaces the old one and disconnects it, and removing the computer in Settings forgets its token.

Commands run as the user who started `pim-computer`, with the files folder as their working directory, for up to two minutes unless the agent asks for up to ten; what comes back is the exit code and up to 64 KB of each of its outputs. `shell` is a gated action, so each command asks first unless Settings → Tool permissions sets it to On. File calls never reach outside the folder, through `..` or a link. Anything the user can do, an approved command can, so give it a machine, VM or container meant for it. Files on the computer don't count toward the space's storage. A space that kept files in Pim before this moves them to its computer the first time one connects, renaming any whose name is taken there to `name (from Pim).ext`.

### Computers Pim starts

Pim can start a computer for each person who doesn't bring one: a [Fly.io Sprite](https://sprites.dev), a Linux VM with Node.js, which Pim sets up once with Google Chrome. Settings → Computer then offers **Start a computer for me** beside connecting one's own. Its whole disk persists, so what agents and the person install there, such as Tailscale, stays.

It runs only while it's in use. The space starts `pim-computer --stdio` on it through the Sprites API when an agent or the person needs it, which wakes the Sprite in a few seconds, and talks to it over that command's input and output; five minutes after the last use, with nobody watching its browser, the space lets go, and the Sprite sleeps. Programs left running there are paused, then stopped, once it sleeps; its files and installed software stay. Nothing on it listens on a port: only the Sprites token reaches it. Removing it in Settings, or deleting the account, deletes the Sprite with everything on it.

To turn it on, make a Sprites token for your organization at [sprites.dev](https://sprites.dev) and give it to Pim:

```sh
pnpm wrangler secret put SPRITES_TOKEN
```

Sprites bill for the CPU, memory and storage they use while running, and only for storage while asleep (see [Sprites' pricing](https://sprites.dev)). The token can create and delete every Sprite in the organization, so give Pim an organization of its own.

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
| GET | `/sessions` | | `{ sessions: [{ id, title, busy, createdAt, updatedAt, responseAt, unread, archived, agent, room }] }`, most recently active first; `room` is null for a chat with one agent, or for a [group chat](#group-chats) `{ mode, members: [{ id, name, busy }] }`: how its agents take turns, and the agents in it besides `agent`, its host, each with whether it is at work; `title` is a few words the utility model picks from the user's first message, and the start of that message until it answers or if it fails. `responseAt` identifies the latest delivered reply (null before reply tracking began); `unread` says it has not been acknowledged. `archived` says the chat has had no activity for two weeks and has nothing unread or running: the app lists it apart, under Archived, and its next message or rename brings it back. Nothing is deleted. `POST /sessions/:id/archive` archives a chat by hand, until its next activity |
| POST | `/sessions` | `{ title? }` | A new session |
| POST | `/sessions/:s/read` | `{ responseAt }` | Acknowledges replies through the supplied `responseAt`; a newer reply stays unread. Returns the session's name, activity and read state |
| PUT | `/sessions/:s` | `{ title }` | Renames it |
| PUT | `/sessions/:s/room` | `{ mode: "mentions" \| "open" }` | How the agents in a [group chat](#group-chats) take turns; `{ room }` |
| DELETE | `/sessions/:s/room/members/:agent` | | Takes an agent other than the host out of a [group chat](#group-chats); `{ room }` |
| POST | `/sessions/:s/title` | | Names it again from the conversation so far, with the utility model; the session |
| GET | `/sessions/:s/summary` | | `{ summary }`: Markdown with what the chat covered and its next steps, from the utility model, written again only when more was said since the last one; null before anything was said |
| GET, PUT, DELETE | `/sessions/:s/link` | | `{ link: { id, url, sharedAt, messages } }`: the chat's public link, null without one. PUT makes it show the chat as it is now, as a new link or the one it has (`409` before anything was said, `413` over 1 MB); DELETE turns it off |
| GET | `/shared/:owner/:link` | | What a public link shows: `{ title, agent: { name, symbol, color }, sharedAt, messages }`, each message `{ role: "user", text, images, at }` or `{ role: "agent", text, widgets, at }`; no token needed |
| POST | `/prompts/improve` | `{ text }` | `{ text }`: a message the person is about to send, rewritten by the utility model so their agent can act on it |
| GET | `/sessions/:s/messages` | | `{ busy, pending, messages }`: the transcript as display messages |
| POST | `/sessions/:s/messages` | `{ content, wait?, whenBusy?: "followUp" \| "steer", operationId? }`. `content` is text, or an array of `{ type: "text", text }` and `{ type: "image", data, mimeType }` parts: up to 4 PNG, JPEG, WebP or GIF images, base64, at most 5 MB each. Images are kept in R2; the transcript shows each as `{ type: "image", mimeType, url }`. Models on the OpenAI Responses and Anthropic Messages APIs fetch them from a signed URL (`/images/<owner>/<id>`, valid 15 minutes) when Pim has a public HTTPS address; any other model gets them inline | `202` with a receipt `{ operationId, accepted }`, or the result `{ status, replies, text?, reason? }` when `wait` is true. `replies` contains only successful chat sends, in order; `text`, when present, joins those replies with blank lines. Private notes are never used as a fallback |
| GET | `/images/:id` | | An image sent in a chat, by the `url` its message keeps |
| GET | `/sessions/:s/operations/:op` | `?timeout=ms` (max 60000) | The result once settled, or `{ status: "pending" }` |
| POST | `/sessions/:s/abort` | `{ operationId? }` | Withdraws one operation, or stops everything, in a group chat every agent at work in it |
| POST | `/sessions/:s/reset` | `{ handoff? }` | Starts a fresh context; history stays stored |
| PUT | `/sessions/:s/model` | `{ model }` | Changes one session's model: a Workers AI or AI Gateway id |
| GET | `/settings` | | `{ timeZone, approvalPolicy, approvalTimeoutSeconds }`; `approvalTimeoutSeconds` is null when approvals wait however long |
| PUT | `/settings` | Any of `{ timeZone, approvalPolicy }`; `null` goes back to the deployment's | The settings |
| GET | `/usage` | | `{ limits, today, history, storageBytes }`: model requests, tokens (the ChatGPT plan's apart) and runs by UTC day |
| GET | `/export` | | Everything as one JSON download, without credentials |
| GET | `/model` | | `{ model, default, choices, utility: { model, default, choices }, chatgpt: { connected, email, error }, providers }`: the model every session uses, and the ones you can choose. Each says whether it sees images (`images`); a model that doesn't is told an image was left out. `utility` is the utility model: `PIM_UTILITY_MODEL` unless you chose another, and the deployment's default again while a chosen ChatGPT model's plan is disconnected. `providers` are the [model providers](#model-providers) you can use, the admin's (`shared`) then yours, each with its models and `hasKey`, never the key |
| PUT | `/model` | `{ provider, id }`, one of `choices` | Moves every session, and new ones, to that model |
| PUT | `/model/utility` | `{ provider, id }`, one of `utility.choices` | Makes that model the utility model |
| GET | `/chatgpt` | | `{ connected, email }` |
| POST | `/chatgpt/login` | | `{ url }` to open in a browser, to sign in with ChatGPT |
| POST | `/chatgpt/callback` | `{ url }`: the `http://127.0.0.1:1455/...` address the browser landed on | `{ connected, email }` |
| DELETE | `/chatgpt` | | Disconnects; sessions on a ChatGPT model go back to the default |
| POST | `/providers` | `{ name, url, key?, models?, structuredOutput? }` | Adds a [model provider](#model-providers) of your own, reading its models from `<url>/models` (`{ provider }`) |
| PUT | `/providers/:id` | `{ name?, url?, key?, models?, structuredOutput? }` | Changes it and reads its models again; a key left out stays, an empty one is removed |
| DELETE | `/providers/:id` | | Removes it; sessions on its models go back to the default |
| GET | `/memory` | | `{ count, pendingCompressions, view, scopes }`: the view is what the majordomo sees; `scopes` lists every [scope](#scopes) with its `kind`, `name`, the `agents` whose own it is, its `readers` and its `count` |
| GET | `/memory/log` | `?q=regex` or `?before=id`, `?limit=`, `?scope=` | Raw memories, newest first, each with its `scope` |
| POST | `/memory/log` | `{ text, scope? }` (one line, ≤ 280 bytes) | Records a memory as the user, in the private scope unless `scope` names another |
| PUT | `/memory/log/:id` | `{ scope }` | Moves a memory to another scope, where it gets a new id, and rebuilds the summaries over its old place |
| DELETE | `/memory/log/:id` | | Forgets one memory and rebuilds the summaries over it |
| GET | `/memory/tree/:scope/:block` | a block such as `0-15` | Its summary and its two halves |
| DELETE | `/memory/tree/:scope/:block` | | Drops a bad summary and those built on it; they are rebuilt |
| POST | `/memory/scopes` | `{ name }` | Names a scope, such as Work, for the agents and circles you choose (up to 20) |
| PUT, DELETE | `/memory/scopes/:key` | `{ name }` (PUT) | Renames or deletes a named scope; a deleted scope's memories stay, read only by the majordomo |
| GET | `/artifacts`, `/artifacts/:id` | | Artifacts, and one with its version history. See [docs/artifacts.md](artifacts.md) |
| GET | `/artifacts/:id/versions/:v` | `?path=` | One version with its files and the content of its main file, or of the file at `path` |
| GET | `/artifacts/:id/versions/:v/frame`, `…/download` | `?path=` (download) | A framed version as a sandboxed page, with its own files inline, or one of its files to save |
| POST | `/artifacts/:id/versions` | `{ baseVersion, content, path?, title? }` | Saves the person's edit of one file as the new latest; `409` if `baseVersion` isn't the latest |
| POST | `/artifacts/:id/restore` | `{ version, baseVersion }` | Restores a version as the new latest; `409` if `baseVersion` isn't the latest |
| POST | `/artifacts/:id/versions/:v/bridge` | `{ op, args }` | A call the version made through `window.pim`: `{ value }`, or `{ needs }` when the person must allow it first |
| POST | `/artifacts/:id/versions/:v/grants` | `{ capability }` | Lets the version use `model` or `tool:<name>` |
| DELETE | `/artifacts/:id` | | Deletes it with every version |
| PUT | `/artifacts/:id/circles` | `{ circles }` | Shares it with those circles; `[]` stops sharing it |
| GET | `/shared-artifacts`, `/shared-artifacts/:host/:id` | | Artifacts others share with you, as their latest versions; `…/versions/:v`, `…/frame`, `…/bridge` and `…/grants` work as for your own |
| GET | `/computer` | | `{ state, pairedAt, computer }`: `state` is `none`, `offline` or `online`; `computer` is what it last said about itself (`hostname`, `platform`, `user`, `root`, …) |
| POST | `/computer` | | `201` with the status and a `token` for `pim-computer`, shown only here; replaces any computer the space had |
| DELETE | `/computer` | | Disconnects the computer and forgets its token; its files stay on it |
| GET | `/computer/connect` | `Authorization: Bearer <computer token>`, as a WebSocket | Where `pim-computer` connects; only the token's own space answers |
| GET | `/files` | `?path=` (default `/workspace`) | `{ path, entries: [{ name, path, type, size, updatedAt }] }`: one folder, folders first. Every `/files` call is `503` while no computer is connected |
| GET | `/files/content` | `?path=`, `&download` | The file's bytes, served as inert data: HTML, SVG and unknown types come back as `text/plain` with a sandboxing CSP |
| PUT | `/files/content` | `?path=`, the file as the body | Saves it, making its folders; `413` over 25 MB |
| DELETE | `/files` | `?path=` | Deletes a file, or a folder with everything in it |
| GET | `/browser` | | `{ available, takeOver, page }`: whether you have a browser (a computer is paired), whether you can take it over (not in a space under control state, see `docs/computer-control-state.md`), and the `url` and `title` it shows, or null when it's closed or the computer is offline |
| GET | `/browser/screenshot` | | The page it shows, as a PNG; `404` when it's closed |
| GET | `/browser/live` | A WebSocket | Takes the browser over: it sends `{ type: "frame", data, width, height }` (a JPEG, base64, of the page `width` by `height` pixels) whenever the page changes and `{ type: "page", url, title }`, and takes `{ type: "mouse" \| "key" \| "text" \| "navigate" \| "back" \| "forward" \| "reload", … }` (`src/browser.ts`'s `BrowserInput`). Closes with `4004` when the browser isn't open, `4000` when it closes, and `4005` (after an `error` saying why) in a space under control state, where nothing sent on it reaches the browser |
| DELETE | `/browser` | | Quits it, with its pages; what's signed in there stays in its profile |
| GET | `/goals`, `/goals/:id` | `?status=active\|paused\|done\|abandoned` | Goals with steps and notes |
| DELETE | `/goals/:id` | | |
| GET | `/schedules` | | Pending scheduled tasks |
| DELETE | `/schedules/:id` | | Cancel one |
| GET | `/approvals`, `/approvals/:id` | `?status=pending\|approved\|denied` | Approval requests; each says what its timeout decides (`onTimeout`), who decided it (`decidedBy`: `user`, `timeout`, `always` or `majordomo`), and `review`: `{ status: "reviewing" \| "escalated", note }` while the majordomo has it, or after it asked you, with what it said; null when you were asked directly. `session` is the chat that asked, or null when a guest asked from their own space |
| POST | `/approvals/:id/approve`, `/approvals/:id/deny` | `{ note? }` | The decided approval; `409` if already decided |
| POST | `/approvals/:id/approve` | `{ note?, always: true }` | Also sets the approval's tool to `on`, so later calls run without asking, and approves other pending calls to it |
| GET | `/permissions` | `?circle=` or `?agent=` | `{ tools: [{ app, appName, tool, name, description, readOnly, destructive, permission, default, chosen, changed, choices }] }`: Pim's own tools that ask first (`app: null`); with `circle`, that circle's (memory, and the apps' tools); with `agent`, the switches of that agent's connected apps' tools, `on` or `off`, and `skills`, its switch for skills (`tool: "write_skill"`), in the same shape. `permission` is what applies: `off`, `ask` or `on`. `chosen` is yours, or null for the default |
| PUT | `/permissions` | `{ circle?, agent?, app, tool, permission }`: `app` null for Pim's own tools, `tool` the app's own name for it, `permission` null for the default. Without `circle` or `agent`, only Pim's own tools (`400` for an app's); with `agent`, `on` or `off`, and `app: ""` with `tool: "write_skill"` for its switch for skills | That tool's entry; `404` for an unknown tool, circle or agent |
| GET | `/agents` | | `{ agents: [{ id, name, role, description, instructions, apps, skills, contacts, memoryScope, memoryScopes, blueprint, source, published, icon, symbol, color, majordomo, createdAt, updatedAt }] }`: your agents, the majordomo first (see [Your agents](#your-agents)) |
| GET | `/majordomo` | | `{ agent, introduced, preferences: { tone, customTone, involvement } }`: your majordomo, whether you named it yet, and how it talks and how much it handles on its own, as its instructions say |
| PUT | `/majordomo/preferences` | `{ tone?, customTone?, involvement? }`, as for `POST /majordomo` | The same, with those preferences in place of the ones its instructions held; what you wrote in them yourself stays |
| POST | `/majordomo` | `{ name, symbol?, color?, yourName?, tone?: "warm" \| "formal" \| "playful" \| "brief", customTone?, helpWith?: ("work" \| "home" \| "health" \| "money" \| "learning" \| "travel")[], otherHelp?: string[], involvement?: "close" \| "balanced" \| "hands_off", locale?, title? }` | Names the majordomo, once (`409` after): its name and look; your name and what you'd like a hand with (`otherHelp`: up to six things in your words), which it remembers; and how it talks (`customTone` in your words) and how much it handles without asking you, which become its instructions. Then it opens the main chat, titled `title` (or "Welcome, <yourName>"), by introducing itself in `locale`'s language; returns `{ agent, introduced, session }` with that chat's id |
| POST | `/agents` | `{ name, role?, description?, instructions?, apps?: [ref], skills?: [name], contacts?: [agent id], memoryScopes?: [key], blueprint?, symbol?, color? }` | A new agent. `memoryScopes` are the named [memory scopes](#scopes) it reads besides its own (`memoryScope`) and everyone's. `symbol` is what shows for it without an uploaded icon: an icon's name, such as `rocket`, or one emoji; `color` is one of `gray`, `red`, `orange`, `amber`, `green`, `teal`, `blue`, `indigo`, `violet` or `pink`. Either may be null for the default. `contacts` are the ids of your other agents it hands tasks to, never your majordomo's (see [Contacts](#contacts)). `blueprint` is what it builds on, such as `pim.assistant/pim`, or null for none; missing means the deployment's default blueprint |
| GET, PUT, DELETE | `/agents/:id` | PUT: any of the fields | The agent; editing reaches its chats from their next request, deleting moves them to the majordomo. The majordomo can't be deleted (`400`) |
| GET | `/skills` | | `{ skills: [{ name, description, version, author, restoredFrom, source, createdAt, updatedAt, agents: [{ id, name }] }] }`: your skills as their latest versions, and the agents that use each (see [Skills](#skills)). `author` is the agent that wrote the version, null for one you restored; `source` is where it was installed from, null for one an agent wrote |
| GET, DELETE | `/skills/:name` | | The skill with its `instructions`, `files` (`[{ path, size, type }]`: size in bytes, media type), its `agents`, and `history`, the versions kept, newest first; deleting deletes every version and takes it off every agent |
| GET | `/skills/:name/versions/:version` | | One version, with its `description`, `instructions` and `files` |
| GET | `/skills/:name/versions/:version/file` | `?path=`, `?download` | A supporting file's bytes, as its media type; with `download`, as an attachment |
| POST | `/skills/:name/restore` | `{ version, baseVersion }` | Adds that version's content as the newest (`201` with the skill); `409` when `baseVersion` is no longer the latest |
| GET | `/agents/:id/suggestions` | `?locale=` | `{ suggestions }`: messages to offer for starting a chat with the agent, up to four. Once the agent has had a chat, the utility model writes them from its latest chats, what Pim remembers and what its dashboard shows, which can take a few seconds, and keeps them until one of those changes; before that, or when the model can't, the starters of its blueprint |
| GET | `/agents/:id/dashboard` | `?locale=` | `{ agent, widgets: [{ id, title, empty, kind, items } \| { id, title, empty, failed: true } \| { id: "artifact:<id>", title, size, artifact: { id, kind, version, widget } }] }`: what its dashboard shows, widgets loaded for this agent and pinned artifacts as their latest version, with the size of their widget (`small`, `medium` or `large`) and whether they have one; until it's changed, the dashboard of the blueprint it builds on (see [docs/extensions.md](extensions.md)) |
| PUT | `/agents/:id/dashboard` | `{ items, sizes? }` | Sets what it shows, in order, by the `id`s above: each must be on it already, a widget it can show, or one of your artifacts with a widget; `400` otherwise, and past 12. `sizes` sets pinned artifacts' widget sizes by `id`; the others keep theirs. Answers `{ items, sizes }`, with only sizes that aren't `medium` |
| GET | `/extensions` | | `{ extensions: [{ id, name, description, blueprints: [{ ref, name, description, apps }], widgets }], defaultBlueprint, logo }`: what this deployment installed, and its sidebar logo (null for Pim's own) |
| GET | `/app-directory` | | `{ apps: [{ ref, name, description, url, custom }] }`: the apps you can connect, the extensions' then the admin's (`custom: true`). Agents list apps by `ref` |
| POST | `/sessions` | `{ title?, agent? }` | A new session with that agent, or the majordomo; sessions list their `agent` (null in a visit) |
| GET | `/sessions/:id/tasks` | | `{ tasks: [{ id, parent, call, agent: { id, name, member }, from: { id, name, member }, task, state, result, createdAt, updatedAt }] }`: the [tasks](#tasks) the chat led to, oldest first, as a tree by `parent`; `call` is the id of the `delegate` call that handed it out, in its requester's transcript (null for older tasks); `state` is `working`, `auth-required`, `completed`, `failed` or `canceled` |
| GET | `/sessions/:id/tasks/:task` | | One of them, with its conversation as `messages`, read-only |
| POST | `/sessions/:id/tasks/:task/cancel` | | Cancels it, and the tasks it handed out |
| GET | `/account` | | `{ username, ownerId, role, status, createdAt, usage, recoveryCodesLeft, alone }` (`alone`: nobody else has an active account here) |
| GET | `/account/export` | | Your account and everything in your space, as one JSON download, without credentials |
| DELETE | `/account` | `{ confirm: username }` | Deletes your account and erases your space; a signed-in browser only. `202` while erasing is still being retried |
| GET, PUT | `/profile` | PUT: `{ displayName, bio }` | How others on this Pim see you |
| GET | `/people/:username` | | `{ username, displayName, bio, templates }`: someone, and the agent templates they published |
| GET | `/templates` | `?q=` | `{ templates }`: shared agents, most used first, without their instructions |
| GET | `/templates/:id` | | A published agent template in full, with the `symbol` and `color` it was published with, `icon`, the version of its uploaded icon or null, and the agents that come with it: `contacts`, its own by role, and `bundle`, each of them and theirs, with its name, role, description, instructions, apps, look, `contacts` and `icon`, the version of its uploaded icon or null |
| GET | `/templates/:id/icon` | | Its uploaded icon; `404` without one |
| GET | `/templates/:id/agents/:position/icon` | | The uploaded icon of the agent at `position` in its `bundle`; `404` without one |
| POST | `/templates/:id/use` | | Makes it one of your agents: a copy, its look and icon too, with `source` saying where it came from, and a copy of each agent in its `bundle`, icons included, wired to each other as contacts |
| POST, DELETE | `/agents/:id/publish` | | Publishes your agent (again, to update it), or takes it down |
| GET | `/published-artifacts` | `?q=` | `{ artifacts }`: published artifacts, most used first, without their content |
| GET | `/published-artifacts/:id`, `…/versions/:v`, `…/versions/:v/frame` | | One, its content, and its page; `v` must be the published version |
| POST | `/published-artifacts/:id/versions/:v/bridge`, `…/grants` | | Its bridge calls and permissions, with your own data, model and tools |
| POST | `/published-artifacts/:id/use` | | Makes it one of your artifacts: a copy of the published version |
| GET, POST, DELETE | `/artifacts/:id/publish` | `{ public? }` | What you published of it, with its public `link` (`404` if nothing); publishes its latest version (again, to update it), `public` saying whether anyone with the link may see it; or takes it down |
| GET | `/circles` | | `{ circles: [{ id, name, enabled, createdAt, members: [{ ownerId, username, addedAt }] }] }` (see [Sharing](#sharing)) |
| POST | `/circles` | `{ name }` | A new circle, with nothing allowed |
| PUT | `/circles/:id` | `{ name?, enabled?, memoryScopes? }` | The circle; `enabled: false` pauses everyone in it; `memoryScopes` are the [memory scopes](#scopes) it reads: `everyone` and named ones |
| DELETE | `/circles/:id` | | Deletes it; its people's spaces are told |
| POST | `/circles/:id/members` | `{ username }` | Puts that person in the circle (moving them from another), and tells their space; `404` for an unknown username |
| DELETE | `/circles/:id/members/:ownerId` | | Takes them out; their space is told |
| GET | `/circles/activity` | | `{ activity: [{ id, at, username, circle, tool, outcome, summary }] }`: guests' tool calls, newest first; `outcome` is `ran`, `asked` or `refused` |
| GET | `/visits` | | `{ visits: [{ ownerId, username, sharedAt, available, session }] }`: spaces shared with you, and your conversation with each |
| POST | `/visits/:username` | | `{ session }`: your conversation with that space, started if new. Messages to it go through `/sessions/:s/messages` like any other |
| GET | `/mcp` | | Connected apps, their state, sign-in link, approval policy, tools (with their `permission`), and `agents`: the names of your agents that work with each |
| POST | `/mcp` | `{ app, approval? }` | Connects one of the directory's apps, by its `ref`; `201` with `{ id, state, authUrl? }` (`authUrl`: send the user there to sign in) |
| PUT | `/mcp/:id` | `{ approval: "writes" \| "all" \| "none" }` | Which of its tools need approval, unless you set a tool's permission |
| DELETE | `/mcp/:id` | | Disconnects it, and revokes the grant at the service when the app can (Google's apps) |
| GET | `/mcp/callback/:owner` (root, no `/api`) | | Where an app's sign-in returns; no token needed |
| GET, POST | `/mcp/callback/apps` (root, no `/api`) | | Where a sign-in to an app Pim implements returns: the GET's page posts it back, and it finishes only in a browser signed in as the person who started it |
| POST | `/app-actions/:extension/:app/:action` | JSON | An app's action for the person, such as Drive's file picking; only from their own signed-in browser, not with an API token. `{ result }`, uncached |
| GET | `/app-pages/:extension/:app` (root, no `/api`) | | An app's page, such as Drive's picker; it holds nothing, and its actions check the session |
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

The admin runs the Pim under `/admin`, from a signed-in browser only: an API token can't. See [docs/instance.md](instance.md#running-it).

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
| POST | `/admin/providers` | `{ name, url, key?, models?, structuredOutput? }` | Adds a [model provider](#model-providers) everyone can use (`201` with `{ provider }`) |
| PUT | `/admin/providers/:id` | `{ name?, url?, key?, models?, structuredOutput? }` | Changes it and reads its models again |
| DELETE | `/admin/providers/:id` | | Takes it away from everyone; their sessions on its models go back to the default |

### WebSocket

Connect to `wss://<host>/api/ws?session=<id>` (add `&token=...` without a passkey session); without `session`, the socket follows the root session. Each socket follows one session at a time; `follow` moves it to another, starting again with that session's snapshot, and `snapshot` returns another session's snapshot without following it. Message types are in [`src/protocol.ts`](../src/protocol.ts).

- Server → client:
  - `hello`: the session and tools.
  - `events`: pi's [agent events](https://github.com/earendil-works/pi/tree/main/packages/durable#agent-events-experimental). The first batch starts with a `snapshot` that replaces client state.
  - `progress`: what the session's agent is doing, in a few words from the utility model, for the tool calls `calls` (see [Utility model](#utility-model)).
  - `notification` and `approval`: sent to every socket.
  - `result` and `error`: replies to commands that carried an `id`.
- Client → server: `submit`, `abort`, `reset`, `resync`, `follow`, `snapshot`.

To fold events into a chat view, see the reducer in Cloudflare's [pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi/src/view.ts).

## Memory

Long-term memory follows Victor Taelin's [OptMem](https://github.com/VictorTaelin/OptMem), reimplemented as a pi-durable extension in [`src/extensions/optmem`](../src/extensions/optmem).

- **The log is the truth.** The agent records one-line memories (up to 280 bytes) with `note` as it learns things. Memories are numbered in order and never edited.
- **Each memory is in one scope.** A scope is a log of its own, with its own places 0, 1, 2, …, and its own tree; see [Scopes](#scopes) for who reads which.
- **Summaries form a binary tree.** In each scope, block `#0-1` summarizes its memories 0 and 1, `#0-3` summarizes `#0-1` and `#2-3`, and so on; the model sees them as `#private/0-3`. A background pi task compresses each block as soon as it is complete, smallest first: blocks up to 16 memories from the raw lines, larger ones from their two halves. The tree is a cache; any summary can be dropped and rebuilt.
- **The view has a fixed size.** Every conversation's prompt holds about `PIM_MEMORY_LINES` lines of the scopes its agent reads, shared out equally, a scope never getting more than it holds: in each, the newest memories verbatim, older ones as summaries that get coarser with age. The model gets back detail with `recall` (a regular expression over the scopes it reads) and `zoom` (a block's two halves).
- **Forgetting is real.** `forget` blanks the memory, keeping its number, and drops every summary built over it; they are rebuilt without it. A summary that was being written when a memory was forgotten is discarded.
- **Moving is forgetting in one scope and noting in another.** `move_memory` (or `PUT /memory/log/:id`) appends the memory to the other scope, with a new number and the date it was first noted, and empties its old place as forgetting does.

### Scopes

Your majordomo knows everything you tell it; your other agents know only what concerns them.

| Scope | Who reads it | Whose notes go there |
| --- | --- | --- |
| `private` | your majordomo | your majordomo's |
| `everyone` | every agent, and the circles you tick | any agent's that chooses it |
| `agent-<id>` | that agent, the copies of it you made from the same template, and your majordomo | theirs |
| a named scope, such as Work | the agents and circles you tick, and your majordomo | theirs, when they choose it |
| a deleted agent's or named scope's | your majordomo | nobody's |

- **Notes start narrow.** `note` keeps a memory in its agent's own scope unless the agent names another scope it reads. The majordomo is told to keep in `everyone` only what every agent should know, such as your name and language, and to pass the rest along in the tasks it hands out.
- **A task reads its own agent's memory.** An agent working on a task another handed it reads its own scopes, not those of the agent that asked: what it learns about you from the asker is what the task says.
- **The majordomo can make and share scopes.** For a part of your life only some agents should know, such as your health, it names a scope with `create_memory_scope` and keeps those memories there; only it reads a new scope. `share_memory_scope` lets another agent read a named scope, or stop reading it, and asks you first, as Settings → Tool permissions sets. Other agents aren't offered either tool, and only you choose what circles read.
- **Choosing.** Settings → Memory lists your memories with their scopes: move one by choosing another scope, or forget it, and make, rename and delete named scopes. An agent's page ticks the named scopes it reads; a circle's, in Sharing, ticks `everyone` and the named scopes it reads.
- **From before scopes.** Memories noted before there were scopes are all in `private`, with their summaries, so only the majordomo reads them until you or it move some. Circles that could read memory read `everyone`. Copies of a template made before scopes each have a scope of their own.

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
  - a memory is forgotten or moved, so the old view stops showing it;
  - the agent reads other scopes;
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

## Model providers

Besides Workers AI and the ChatGPT plan, Pim has built-in connections for Anthropic, OpenAI API, Google Gemini, OpenRouter, DeepSeek, Mistral AI, Groq and xAI. In Settings → Model → Providers → Add provider, choose the service, enter its API key and choose up to 50 models from Pim's searchable catalog. No endpoint address is needed. These connections use the models' native APIs and capabilities from pi-ai. They bill the provider's API account, not a chat subscription; OpenAI API is separate from the ChatGPT-plan connection. The catalog is bundled with Pim, not a live account listing: your account must have access to the models, and the key is checked when you use one.

Pim also runs on any server that speaks OpenAI's `/chat/completions`: a model on your own machine, such as llama.cpp's `llama-server`, LM Studio, Ollama or vLLM, or another provider's compatible API. Choose Custom endpoint and give it a name, its address (the part before `/chat/completions`, such as `http://localhost:1234/v1`), and its API key if it needs one. Existing custom endpoints keep working unchanged. Both kinds of connection offer models for chats. A custom endpoint's models are offered as the utility model only when you say it supports structured outputs (the switch in its settings, `structuredOutput`): that its models follow a JSON schema given as `response_format`; check your server's documentation. Of the built-in services, Anthropic, OpenAI, Google Gemini, Mistral and xAI are offered; DeepSeek, Groq and OpenRouter are not, as they only promise valid JSON, or only for some models.

- **Yours, or everyone's.** A provider you add is yours alone: only your agents use it, and its tokens count as yours, not against the deployment's daily token limit. The admin can add one for everyone instead (Everyone on this Pim can use it), so people who join can use it without bringing their own; its tokens count against the limits like Workers AI's. Only the admin changes or removes those. Removing a provider moves chats on its models back to the default model.
- **Models.** A built-in connection offers only the models you choose; saving it again updates their definitions from Pim's bundled catalog. Adding a custom endpoint reads its models from `<address>/models`, and saving it again reads them again, such as after loading another model in LM Studio. A server that lists more than 50 needs the ones to offer named, and a server that can't list its models can be given them by name. What a custom endpoint's model can do comes from the server's list where it says (OpenRouter's context length and input types, vLLM's `max_model_len`, llama.cpp's served context `n_ctx`), else from pi-ai's catalog when it knows the model by that id, else a 128,000-token context and text only. A chat that outgrows a model's real context is compacted and tried again.
- **Keys.** Pim keeps a provider's key in your space, or for the admin's in the gallery, sends it only to that provider, and never shows it again: Settings shows only that there is one. A server without a key, as local ones usually are, is sent a placeholder.

A Pim on Cloudflare can only reach providers on the public internet; one running on your own machine reaches `localhost` too. Pim says everything with tool calls, so a model needs dependable tool calling and a large context: llama.cpp needs `--jinja` and a `-c` well above the 8k tokens of memory every prompt carries, and LM Studio a context length well above its default. Image generation stays on Workers AI.

Workers AI is optional. A deployment without the `AI` binding (delete `ai` from `wrangler.jsonc`) has no platform model: the first model of the first provider, the admin's and then the person's own, is the default until someone chooses another, and until a provider is added, chats answer that no model is set up. Without it, `PIM_MODELS`, `PIM_IMAGE_MODEL` and `PIM_UTILITY_MODEL` do nothing, chat naming and similar side jobs use a provider's model that answers in a JSON schema when someone picks one, long-term memory is not compressed, and `generate_image` is not offered.

## Utility model

Small jobs around a conversation go to one utility model rather than the chat's model: a fast, cheap one by default (`PIM_UTILITY_MODEL`), or a model on your ChatGPT plan, a built-in service that answers in a JSON schema, or a custom endpoint you said supports structured outputs (Settings → Model → Utility model). A chosen model whose provider stops qualifying, such as an endpoint with the switch turned off, is skipped for the default until it does again. Its requests count against the daily model limits, but not as runs. Today it:

- **Names chats.** A chat is called by the start of its first message at once, then by the few words the utility model picks. A rename in the meantime stays. Chat ⋯ → Regenerate names it again from the conversation so far.
- **Improves prompts.** The ✨ button in the message box rewrites the draft in place so the agent can act on it.
- **Suggests what to say.** Above the message box on an agent's dashboard, chips offer messages to send it. A new agent offers its blueprint's starters. Once you've chatted with it, the utility model writes them from its latest chats, what Pim remembers and what its dashboard shows, and they fade in when ready. They are written again only when opening the dashboard finds that something changed, so an agent you don't talk to costs nothing.
- **Summarizes chats.** The summary button in a chat's header opens a box at the top right; it stays open from chat to chat until closed. Expand the Summary dropdown inside it for what the chat covered and the next steps; below it, Tasks lists the [tasks](#tasks) the chat led to, if any. Nothing is written while the dropdown is closed, so you can view the browser without starting a summary, and a summary is kept until more is said.
- **Says what an agent is doing.** While an agent works, the chat lists its steps above the dots, a few words each behind a mark for the kind of step (an app's tools get the app's icon), and adds one as it goes. A model that summarizes its own reasoning under headings, as OpenAI's do, says it itself: each heading is a step. Each tool call is a step too, named by the utility model, from the person's request, the results the agent just got, its notes, and the call with its arguments, which makes it the one job that sees the agent's tool calls ([`src/progress.ts`](../src/progress.ts)). It writes one line at a time, at most one every five seconds, for the latest step, and only while someone has the chat open; a step it didn't describe, or any step without a utility model, shows the tool's name. Once the agent sends its message, the list folds into a "Worked for 42s" line that opens to it again. The utility model's lines aren't stored: after a reload the list shows the tools' names in their place.

Each job is a task in [`src/utility.ts`](../src/utility.ts): instructions, a cap on the answer for models that don't reason, and how to clean the answer. A job whose answer has a shape, such as the suggestions, is a structured task: the model answers in JSON that follows a schema, which its provider enforces with its own structured-output feature (`Pim.utilityStructured`; `withJsonSchema` puts the schema in the request in the form each API takes). That is why only models that support one are offered as the utility model. `Pim.utility(task, input)` runs one on the utility model, and `conversationText` gives it a chat as what each side said, without tool calls or the agent's private notes. A new feature adds a task there and a route that calls it.

## Connected apps

Apps connect through remote [MCP](https://modelcontextprotocol.io) servers: the vendor's own (many apps publish one), or one you deploy as another Worker. The `agents` SDK's MCP client handles the connection, OAuth sign-in (with dynamic client registration), token storage in the agent's database, and reconnecting after a wake.

- **The directory.** People connect only the apps this Pim offers: those its extensions bring (`apps` in [an extension](extensions.md#apps): MCP servers such as the bundled GitHub, Linear and Notion, or apps the extension implements for services without one, like the bundled Spotify app), and those the admin adds in Apps → Create new app, or by asking their majordomo, named `custom/<app>`. Nobody connects an arbitrary server. `GET /app-directory` lists them.
- **One sign-in for all your agents.** Agents, blueprints and templates list apps by name (`test.ledger/notes`, `custom/acme-crm`), never by URL. You connect an app once, and every agent of yours that lists it uses that connection. Agents and templates from before the directory listed `{ name, url }`: each is read as the directory's app at that URL, and left out while the directory has none.
- **Each agent lists its apps.** An extension's blueprint lists the apps it works with in its definition, and each of your agents can add its own (ask in chat, or Add app on its page in the sidebar's Agents, which offers the apps you connected). A chat gets the tools, instructions, and prompt entry of the apps its agent lists, and of no other, even when you connected more. An agent at work on a task works with its own apps.
- **Connecting.** Connect from Apps in the sidebar's rail (also opened by Connect more apps under an agent's Add app), an app an agent's page lists but isn't connected yet, `POST /mcp` with the app's `ref`, or ask Pim: its `connect_app` tool connects one of the apps the chat's agent lists, without asking, since the agent already chose it. It can't connect anything else. If the app needs sign-in, the response (or Pim) gives you a link; the app sends you back to `/mcp/callback/<you>`.
- **Seeing them.** Apps, a dialog from the sidebar's rail, lists every app this Pim offers, whether you connected it, which of your agents work with it, and a sign-in link while it waits for one. Disconnect an app there. An app no agent lists does nothing until one does. An app you connected that the Pim no longer offers stays until you disconnect it.
- **Finding an app.** Say "use my Linear" and Pim's `find_app` tool looks it up in the directory by name, then by description, for its `ref`.
- **Managing apps in chat.** With `manage_apps` enabled, Pim requests additions and removals for its own agent, by `ref`; your majordomo can also name another of your agents. You approve the app names in chat; approval adds and connects new apps, and Pim resumes your task with their tools. An app the directory doesn't have is refused before you're asked. Each change requires your explicit decision, even under the `auto` approval policy: no timeout or Always approve. Settings → Tool permissions offers **Off / Ask** for this capability, separately from `update_agent`, which cannot change apps. Removing an app here does not disconnect the shared connection, change its tool permissions, or affect other agents. Blueprint apps cannot be removed this way. If sign-in is needed, Pim returns its link; it never needs your credentials in chat. If connection fails, the app stays on the agent's list so `connect_app` can retry, and the result explains the failure.
- **The admin's majordomo adds apps.** Tell your majordomo about an MCP server this Pim doesn't offer yet, with its https URL, and, if you're the admin, its `add_custom_app` asks to add it to the directory for everyone, as Apps → Create new app does. Approving it adds the app, puts it on the majordomo's own apps and connects it, with a sign-in link if it needs one; it can then make an agent that works with it, or you add it to one. Each request needs your explicit decision from the signed-in app: not an API token, the majordomo's review, a timeout or Always approve. Settings → Tool permissions offers **Off / Ask**. Only the admin's majordomo is offered the tool, and the space asks the directory whether its owner is the admin before it runs. A server already in the directory is that app; nothing is added twice.
- **Tools.** Each MCP tool becomes a pi tool named `<app>_<tool>`. pi picks up added and removed tools from the next request, without a restart. The app's instructions go in the `connected_apps` prompt section.
- **Each agent's switches.** An agent's page (in the sidebar's Agents) lists the apps it works with, and once one is connected, a switch for each of its tools. A tool that is on runs in that agent's chats and tasks without asking you; one that is off isn't offered to it, and a call made with a tool list from before you switched it off is refused. Nothing an agent does with its apps files an approval. A tool starts on, unless the app marks it `destructiveHint: true` (native apps: `destructive: true`) or the app's approval policy is `all`: those start off, and run freely only once you switch them on. Choices you made in Settings for every agent before the switches carry over: On stays on, Ask and Off are off. The hints come from the app itself, so only connect apps you trust.
- **Tied to the tool you switched on.** A switch you turned on is held to the tool's definition at the time: description, input schema and annotations. If the app changes any of them, the tool is off for that agent, and its page says so, until you switch it on again. Deleting an agent forgets its switches.
- **Artifacts and circles.** An artifact may call an app's tool that runs without asking under the app's approval policy (`writes`, the default: those that declare `readOnlyHint`; `none`: every routine tool), once you allow its version. People in your circles use your apps' tools only as each circle's permissions say (see [Sharing](#sharing)).
- **Prompt cache.** The apps' tools come last in pi's tool list, so a newly connected app's tools are appended to what the provider has cached instead of re-sending every tool.

### Skills from apps

Apps that implement the [MCP Skills extension](https://modelcontextprotocol.io/extensions/skills/overview) (`io.modelcontextprotocol/skills`) ship instructions for using them as [Agent Skills](https://agentskills.io). pim reads an app's `skills/list` when it connects and again when the listing's TTL runs out, and lists each skill's name and description under the app in the prompt. The model loads one with `read_skill`, and supporting files with `read_skill_file`.

- Every file is checked against the SHA-256 digest and size the app published; a mismatch re-reads the listing once, so an app that updated a skill is picked up, and content that still doesn't match is refused.
- Skill content is labeled with the app it came from, as the extension requires: it is the app's text, not the user's.
- pim runs no code from skills. Anything a skill tells the model to do goes through the app's tools and their approvals.

### Events from apps

Apps that implement the draft [MCP Events](https://github.com/modelcontextprotocol/experimental-ext-triggers-events) extension can tell Pim when something happens: a price changed, a message arrived. pim supports webhook delivery, the same slice ChatGPT implements.

- **Watching.** Ask Pim ("tell me when the JFK–Lisbon price drops below $500"); `watch_app_event` subscribes at once, with no approval: it only works for an event listed by a connected app the agent works with, and only in the lead agent's chats. Settings → Tool permissions can switch it Off (it is On otherwise, and an Ask chosen before it stopped asking counts as On). What the agent does when an event arrives still goes through the usual approvals. pim calls `events/subscribe` with a callback URL (`/mcp/events/<owner>/<watch>`) and a fresh signing secret, and renews the subscription before the app's grant runs out.
- **Receiving.** Each delivery must carry a valid Standard Webhooks signature from the last five minutes. The event becomes a message to the conversation that created the watch, with the instruction and the event data marked as untrusted. The event id is its idempotency key, so a delivery the app retries starts one run, not two.
- **Ending.** `stop_watch` or `DELETE /watches/:id` unsubscribes. A watch the app terminates, or refuses to renew, ends with a notification. Removing an app stops its watches.
- **Draft.** The extension is not ratified. Today's MCP SDKs drop its `events` capability from the handshake, so pim also asks an app for `events/list` when it declares nothing.

MCP servers expose tools, prompts and resources; pim uses their tools, instructions and skills. They cannot add hooks or change how pim runs, which is also what keeps them safe to connect.

### Tool permissions

Settings → Tool permissions lists Pim's own tools that act on the world (`http_request`, `watch_app_event`, `update_agent`, `shell`, `file_delete`, `browser_click`, `browser_type`, and the actions extensions' abilities bring). Each is **Off** (the model isn't offered it), **Ask** (each call files an approval) or **On** (it runs without asking). A tool you haven't set asks, except `watch_app_event`, which has no approval to ask for and is only Off or On. **Always approve** on a request sets its tool to On. An app's tools aren't here: each agent has its own switches for them (see [Connected apps](#connected-apps)).

- **Assignment is consent for an ability's actions.** The actions of the abilities an agent's blueprint uses run in its chats without asking, unless you chose Ask or Off.
- **App management always asks.** `manage_apps` offers only Off / Ask. Each request waits for your explicit decision, even under the auto policy; turning it off also blocks pending changes.
- **Removing an app** forgets its tools' permissions and switches. App tools chosen with Always approve before permissions existed are on for every agent that works with the app, the first time Pim sees them.

## Your agents

The notifications panel is for things you haven't opened, not an activity history. Each row shows the agent's icon, a title and a short time. In-app alerts and device push notifications also carry the agent's uploaded image, symbol or emoji; notices without an agent use Pim's icon. Device alerts use the default icon style and colors, and whether their icon appears depends on the browser and operating system. Safari, including iPhone and iPad Home Screen apps, ignores per-notification icons and shows the app's icon instead. A notification is marked read when you open its linked chat from the row. It stays in place until you leave the panel and disappears when you return. Opening the panel or scrolling through it does not mark notifications read; Mark all as read clears the list at once, including notifications without a linked chat. Reading a notification does not delete its chat or change the API's notification history.

Push notifications follow your device's browser permission, with no separate in-app switch. When permission is already granted, opening or returning to Pim automatically registers the device with your space, even if it has never subscribed, and repairs missing registrations or outdated subscription keys. If permission hasn't been decided, Settings → General offers Allow notifications to open the browser's permission prompt; Pim never prompts automatically. To turn notifications off or unblock them, use your device or browser settings. On an iPhone or iPad, add Pim to the Home Screen first. Settings reports whether the device is registered, not whether the system will display an alert. A device alert shows the first sentence of its message; the full text is in the app. Scheduled tasks send a notification linking to their chat when they start; any agent reply is also pushed if no device has read it ten seconds later, including when you leave a chat while its response is still running.

The chats panel is one list across all your agents and your conversations with shared spaces, most recently active first, under dividers for today, yesterday, last week and the last 14 days. Each chat has its agent's icon in front of it (a shared space shows its owner's initial). It has a quiet, left-aligned New chat button below search. New chat, there and in the mobile bar, starts a chat with the agent of the chat or dashboard that's open, or with your majordomo anywhere else. A dot on the left marks an unread response, or a working chat (working takes priority); it gently pulses unless reduced motion is preferred. Opening its conversation in a visible tab clears it once the transcript has loaded and the turn finishes. Read state belongs to your space, so it follows you between devices, independently of notification read state. Existing conversations start read when reply tracking is introduced; new replies become unread.

Your agents are assistants, each with its own instructions: a marathon coach, a trip planner, a code reviewer. Each has a name and a role. The role is what it is for, such as Marathon coach, and each of your agents has its own: two agents can't share one (`409`), and agents and templates refer to each other by it. The name is what you call it, such as Ada, and agents may share one. Left out, a role is the name, and your majordomo's is always Majordomo, whatever you call it. Each builds on a blueprint an [extension](extensions.md) brings (its page in the sidebar's Agents → Based on blueprint), Pim's own assistant unless you chose another, which gives it its habits, the extension's tools beyond Pim's own, and its dashboard; your name and instructions go on top. One is your [majordomo](#your-majordomo): it talks in chats started without choosing an agent, and its dashboard is the app's home. Agents, in the sidebar's rail below Chats, lists them, the majordomo first. Chats you open show as tabs above the transcript once there are two or more (a single one shows just its title), so you can switch between them with the sidebar collapsed; each tab shows when its chat is working or waiting for your approval. As in a browser, opening a chat from the sidebar shows it in the current tab, in place of the chat there; ⋯ → Open in new tab, or dragging the chat onto the conversation, gives it a tab of its own. New chats and links to chats open in new tabs, and closing a tab doesn't delete the chat. The tabs are kept in the browser, and each chat keeps its unsent text and scroll position while the page is open. In Agents, click an agent for its page, in place of the chat: chatting with it, publishing, deletion, its apps and their tools, and its details, which save together. Apps you add there save at once, from those you connected. Creating or editing an agent sets how it looks: one of the built-in icons or any emoji, in a color, or an uploaded image. Use + beside the Agents title to create another; once made, its page opens, to add its apps. A chat started with another (New chat from one of its chats or its dashboard, or Chat on its page) talks with that one. A chat's agent adds its name and instructions to the model's own habits; everything else is shared by all agents in your space: connected apps, approvals, schedules. Memory is in [scopes](#scopes): each agent reads its own, everyone's, and the named scopes ticked on its page; your majordomo reads them all. Edit an agent and its chats follow from their next request; delete it and they go on with the majordomo. An agent lists the apps it works with, by MCP server URL, besides those of the blueprint it builds on: its chats get only those apps' tools, and whoever uses it connects them with their own accounts.

**Edit in chat.** Ask an agent to change its name, role, instructions, description, contacts or look, such as “Use the picture you just made as your icon.” `update_agent` shows what changes for approval. An icon can be an emoji and a color, or an image: a PNG, JPEG, WebP or GIF of at most 256 KB from your files, such as one `generate_image` made, or from a URL on the web. The image is read when the agent asks and again once you approve, and it is set only if it is still the same. Other agents change only themselves; your majordomo changes any of your agents, so you can ask it to rename one, change its role, or find or make a picture for one and use it as that agent's icon.

**An agent for everyone who joins.** The admin can choose one of their agents for new members (its page in Agents → Give everyone who joins a copy). Each person who joins after that gets a copy besides their majordomo: its name, role, description, instructions and suggested apps, and copies of its contacts, theirs to change. Copies don't follow later edits to the admin's agent, and people who joined before don't get one.

**Dashboards.** Each agent in the sidebar's Agents opens its dashboard: a box to start a chat with it, with suggested messages floating above it, and what you asked it to show there. It starts empty (an extension's blueprint can start it with widgets of its own). Ask for something, such as "keep a chart of my spending here" or "show me today's NYC headlines", and the agent makes it as an [artifact](artifacts.md), usually a small React app or page, and pins it with `update_dashboard`. As a phone's home screen shows apps' widgets, the dashboard shows each pinned artifact as [its widget](artifacts.md#widgets): a small view of it in a tile, with its title underneath, such as this month's total and a sparkline, or the top three headlines. Widgets come in three sizes, on a grid of four columns (two on phones): small, a square one column wide; medium, two columns wide and as tall; and large, twice as tall as that. The agent picks one when it pins a widget, and ⋯ under a widget changes it. The widget runs as the latest version, so it can draw charts, keep its own data, and use your apps' tools through [the bridge](artifacts.md#the-bridge), and the agent keeps it current with what only it can fetch, such as news, by updating the artifact on a schedule. Tapping the widget, or its title, opens the whole artifact on its own page. Tapping an item can instead put a message about it in the box below, with the artifact attached, for you to send (`pim.chat`); nothing is sent until you do. An artifact without a widget can't be pinned; one pinned before widgets existed shows as a tile that opens it, until the agent gives it one. The agent can also pin Pim's own widgets: what's coming up, the goals being worked on, what it remembered lately, and what it made recently. Each card's × takes it off. Each agent's dashboard is its own, and pinning needs no approval: it changes only your screen.

An agent can be **published** to the others on your Pim: Discover lists published agents, and anyone on it can read one in full and **make it their own**, which copies its name, description, instructions, suggested apps and look (its icon or emoji, color, or uploaded image) into their own agents, with copies of the agents it comes with (see [Contacts](#contacts)). The agent the admin chooses for everyone who joins is copied the same way. Nothing else of the author's goes with it: no memory, chats or credentials. The copy is theirs to change; publishing again updates what others see, not their copies. Unpublishing, deleting the agent, or deleting the account takes it out of Discover. Each person has a profile (a name and a line about them), shown on their page and next to what they publish. Artifacts are published the same way, from Share on the artifact's page: a copy of its latest version, which anyone on your Pim can open from Discover and use with their own data, model and tools, or make their own (see [docs/artifacts.md](artifacts.md#publishing)). Until someone else has an account on your Pim, there is nobody to publish for, so the app hides Discover and the Publish button.

A published agent's instructions are someone else's words running with your tools, so read them before you take one: your copy still asks before acting wherever your tool permissions say it should.

### Your majordomo

Your majordomo is the agent you come to first, for almost anything, and the one that knows you best. There is one, always the same: the title can't move to another agent, and it can't be deleted. It builds on the deployment's default blueprint (`defaultBlueprint` in `pim.config.ts`), and is edited like any agent.

- **Naming it.** The first time you sign in, you say your name, unless the Google, GitHub or single sign-on account you joined with already says it; then you name your majordomo and choose how it looks. Then, if you like, you pick how it should talk (warm, formal, playful or brief), what you'd like a hand with (work, home and family, health and fitness, money, learning, travel), and how much it should take care of without asking you (keep me in the loop, use your judgment, or take it off my hands); the first two also take an answer in your own words, and all of it is one Skip away. How it talks and how much it handles go into its instructions, and its page (in the sidebar's Agents) changes them later with the same choices. Then it opens your first chat, "Welcome, <name>", itself: it introduces itself and asks about you, and you tell it as much or as little as you like, in your own words. It asks one question at a time and takes one topic at a time, so getting to know you happens over a few conversations rather than all at once. It remembers your name, for every agent, and what you'd like a hand with and what you tell it, in its own private [scope](#scopes). Accounts from before majordomos keep the agent they talked with as theirs.
- **It hands work down.** It doesn't do the work itself. It hands tasks to your other agents with `delegate` (see [Tasks](#tasks)), making one first with `create_agent` when none fits. It doesn't wait for them: it tells you what it handed out and is free for whatever you say next, and when their answers arrive it tells you what came of them. It hands tasks to any of your other agents; any other agent, to its [contacts](#contacts).
- **It is your face to your agents.** Under the `majordomo` approval policy, another agent's request for your approval goes to it first: in a chat you have with that agent, or from an agent at work on a task. In a conversation of its own, with your memory, it approves what it's sure you'd want, denies what's clearly against it, and asks you about the rest: anything that spends money, sends something in your name, shares private information or deletes things, and whatever it's unsure of. The request's entry in the box shows it deciding, then who decided and why, or what it asks you; you can always decide first. A request it asks you about notifies you and waits for you however long. One it hasn't decided in five minutes comes to you too. Its own requests, in its chats with you, and requests that need your own decision (`manage_apps`, `add_custom_app`) or come from people in your circles, come straight to you.
- **It suggests apps.** When something you talk about would go better with one of this Pim's apps, it suggests that one app, and connects it if you want it. One you turn down it remembers, and doesn't suggest again unless you bring it up. If you're the admin, it can also add an app this Pim doesn't offer yet, from its MCP server's URL (see [Connected apps](#connected-apps)).

### Skills

A skill is how you want work that comes up again done, written down for your agents: how to plan your training week, what goes in the weekly report. It has a name such as `weekly-plan`, a description, and instructions in Markdown, as in [Agent Skills](https://agentskills.io).

- **Your agents write them.** When you ask an agent to remember how to do something, or it has worked out with you a task you'll ask for again, it saves it with `write_skill`. The request shows the whole skill, and nothing is saved until it is approved under your approval policy, as with `update_agent`, since a skill steers every later run that loads it. Settings → Tool permissions sets `write_skill` to Off, Ask or On, for every agent.
- **Installing published ones.** Ask an agent to use a skill from a GitHub repository, such as `https://github.com/owner/repo/tree/main/skills/name`, or from a folder in your files with a `SKILL.md`, and it installs it with `write_skill`'s `from` (or `install_skill`, which does the same), through the same request and approval. `from` comes alone: a request with `from` and any of `name`, `description`, `instructions` or `files` is refused, as is one with none of them. The name and description come from the SKILL.md's frontmatter, its instructions are saved as written there, and every other file beside it is copied exactly, hidden ones left out; the request shows the instructions and each file's source, size and SHA-256, and each copy is checked against its SHA-256 when you approve it. From GitHub it reads the folder at the commit its branch is at then, and the skill records that commit as its source; only `github.com` addresses of a repository's folder are read (no `.` or `..` parts, credentials or ports), through GitHub's API, which must name the commit by its full hash, and `raw.githubusercontent.com`, at that hash; a redirect is followed only within GitHub's API, and never from a raw file. From your files only folders under `/workspace` are read, and a link in the folder that leads outside it refuses the install. GitHub's API limits requests from one address, which Pim shares with others; when it refuses, the agent can clone the repository to your computer and install from that folder. An installed skill is labeled with its source when an agent loads it, as written there and not by you. Installing it again with its version updates it.
- **Whose skills an agent writes.** An agent writes and installs skills for itself. Your majordomo can also give `agent`, the id of another of your agents (as `update_agent` and `manage_apps` take it), to write or install one for that agent; any other agent that gives another's id is refused. The request names both, such as "Ada installs the skill deck for Researcher from …". A write changes only a skill that is on the list of the agent it is for and on no other agent's: a skill two agents use is changed by neither (take it off the others on its page first), and an agent can't rewrite, or reuse the name of, one of your skills that isn't on its own list, whatever version it gives. Who wrote a version is a label, not who controls the skill. An agent working on a task someone handed it writes no skills.
- **A switch for each agent.** Each agent's page in Agents has Skills → Write and install skills, on by default, as agents always could. Off, that agent's chats aren't offered `write_skill` or `install_skill`, and no agent, your majordomo included, writes skills for it. It doesn't skip approval: `write_skill`'s Off, Ask or On still applies, and turning it Off stops every agent. Only you flip it, on the page or with `PUT /permissions`; no agent's tool changes it. Whether `write_skill` and the switches allow a write, who asked and whom it is for, and whose skills it touches are checked when the agent asks and again when the request is approved; a request whose agent was deleted or switched off meanwhile, or whose skill changed, saves nothing. The last check, the new version and the skill's place on the agent's list are one transaction: a change made before it ends means nothing is saved, and one made after it, such as taking the skill off the agent, is kept.
- **Each agent lists the skills it uses**, as it lists apps. A skill an agent writes goes on the list of the agent it is for; `PUT /agents/:id` with `skills` gives one to another agent. Its chats list each skill's name and description, and the agent loads one with `read_skill` before the work it describes.
- **Supporting files.** A skill can carry up to 50 files beside its instructions, by paths such as `references/paces.md`, `scripts/convert.py` or `templates/report.docx`. The agent writes text files out, or copies any file from your files with `from_file`: the request names the copy's SHA-256, and when you approve it the file is read again and copied only if it hasn't changed. The agent reads a file with `read_skill_file`, or with `save_to` copies it back to your files as it is, to run a script with `shell` on [your computer](#your-computer) or fill in a template; agents are told about scripts only when you have one. A rewrite that gives no files keeps the ones the skill had. The files live with each version, not in your files folder, so only an approved `write_skill` changes them.
- **Where they are kept.** As with artifacts, a skill's name, description, instructions and versions are in your space's database, and its files' bytes in R2, each stored once under its SHA-256 however many versions and skills have it: a rewrite that keeps a file, or a restore, stores nothing again, and deleting a skill frees the files nothing else has. One version's files take up to 10 MB, and all skills' files up to 100 MB; they count toward the space's storage, and a version there is no room for is refused before it is written.
- **Versions.** Every write adds a version, and the latest 20 are kept. A rewrite names the version it read; one approved after the skill changed is refused, so two rewrites never overwrite each other unseen.
- **Seeing them.** Skills, in the sidebar's rail, lists them. A skill's page shows what it says at any version kept, who wrote each, and the agents that use it: click an agent to give it the skill or take it away. Restore an older version (it becomes the newest) or delete the skill there.
- **Not yet:** sharing skills through Discover, and serving them to other apps over MCP.

### Tasks

Agents hand each other work as tasks, with `delegate`: your majordomo to your other agents, and any agent to its contacts. In a chat you talk with an agent; in a task an agent talks with the agent that handed it the task, and nothing in it is yours. Tasks follow [A2A](https://a2a-protocol.org/)'s task model, inside your space.

- **Nobody waits, unless it must.** `delegate` returns at once with each task's id, and the agent that handed them out goes on, or ends its turn, so you can keep talking with it. Tasks handed out together work at the same time, each in a conversation of its own.
- **Waiting for answers.** An agent that can't reply without the answers, such as when you asked something only its contact knows, sets `wait`: its call is suspended, holding no memory and keeping nothing running, until every task is done, including one waiting for your approval, however long that takes; then the space wakes it, and it returns their answers in place of the update. Meanwhile what you say in the chat waits its turn. If you stop the chat, the answers come in an update once the tasks are done.
- **States.** A task is `working`, then `completed` with its agent's answer, `failed`, or `canceled`. While its agent waits for your approval it is `auth-required`.
- **Answers come back once.** When none of the tasks handed out together is working, their answers come to the agent that asked, in one message starting with "[Task update]", which the chat shows as a notice. A task waiting for your approval doesn't hold up the others: the update says it waits, and its answer comes in an update of its own. An agent that hands out tasks of its own while working on one answers its task once those have come back.
- **The chat shows the work** in an inline card where the agent handed it out, with who does each task and its current state; tasks it hands out in turn sit beneath it as a tree. The card stays where work began, while the completion notice stays where the answer arrived, even when the conversation continued in between. Links jump between the task and its completion notice. A task opens read-only from its card, or from Tasks in the box beside the chat, in the canvas beside the chat (`/chat/<id>?task=<task>`, over it on phones), with what it was asked and what its agent did, and one not done can be canceled there: its agent stops, the tasks it handed out are canceled, its pending approval requests are denied, and the agent that asked hears it was canceled. Deleting a chat cancels its tasks. Tasks' conversations aren't chats in the sidebar; the box beside the chat (the summary button in its header) lists all of the chat's tasks under Tasks, as the same tree, with how many are working or waiting for you, and each opens as from its card.
- **Approvals.** A task's tools ask before acting, as in a chat. The request shows in the chat the work began in, labeled with the agent or member that asked; the agent waits for the decision, which its call returns.
- **Following up.** To carry on with a task that is done, an agent hands out another that `continues` it, in the same conversation, where the earlier work is.

### Group chats

A chat is with one agent until someone in it mentions another of your agents by name, as `@Coach`: you, in a message (the message box offers your agents as you type `@`), or the chat's agent, in one it sends. That agent joins the chat and talks there itself, where you talk with it too. The chat's own agent is its host. Bring an agent in when you should talk with it; hand it a [task](#tasks) when it can work out of sight and report back. See [`src/rooms.ts`](../src/rooms.ts).

- **Each agent is itself.** An agent in a group chat has a conversation of its own there, as a chat with it is, with its own instructions, apps, skills, tool permissions and memory scopes; it isn't one of your chats in the sidebar.
- **Agents join knowing nothing of what came before.** The message that brought an agent in is the first thing it hears, so it should say what the agent needs. When it needs more, the agent reads what was said before it joined with `chat_history`, as a person scrolls back.
- **Taking an agent out.** The host takes an agent out once it has done what it was there for, with `remove_from_chat`, and you do from the menu of the chat's agents (`DELETE /sessions/:s/room/members/:agent`). It stops, the tasks it handed out are canceled and its approval requests denied, it hears nothing more said in the chat, and everyone left hears it left. Mentioned again, it joins afresh. Only the host and you take agents out, and the host stays.
- **Everyone hears everything.** What you say goes to every agent in the chat, and what an agent sends goes to the others, as a message starting "[From Coach]"; the chat shows it as Coach's, under its name and icon, and says when an agent joins or leaves. Each agent's memory is its own, but what it says in the chat, the others hear.
- **Who answers.** An agent answers when it is mentioned, by you or by another agent, and the host answers what you say without mentioning anyone. The rest each agent only hears, without taking a turn, and knows when it next speaks. There is an experimental `open` mode, off by default and with no switch in the app (`PUT /sessions/:s/room` with `open`): everything said wakes every other agent in the chat, and each answers only when it has something to add; one that is mentioned has to answer.
- **Agents can talk among themselves.** Agents mention each other, so one turn can set off another. Each turn counts how far it is from your last message, and nothing stops a chain yet: we're watching whether agents go round in circles in practice.
- **Who an agent brings in.** You bring in any of your agents. In a message it sends, your majordomo brings in any of them too, and any other agent its contacts.
- **What they share.** The agents in a group chat share its browser window, and their approval requests and the tasks they hand out show in the chat, labeled with the agent that asked. The chat shows who is at work, and Stop stops all of them. Deleting the chat stops them and cancels their tasks.

### Contacts

An agent lists its contacts, as it lists its apps: others of your agents it hands [tasks](#tasks) to. You still talk to one agent. It hands its contacts tasks, they work at the same time, and it combines their answers when they arrive. A coding agent, for example, can be a planner with a coder for a contact, which it hands several parts of a change at once. Your majordomo has no list: it hands tasks to all of your agents.

- **Every agent is yours to see.** A contact is one of your agents like any other, in the sidebar's Agents with its own page, chats, apps, skills and tool permissions. Choose an agent's contacts on its page, or ask it in chat: `update_agent` adds and removes contacts by role or name, and asks first under your approval policy, since a contact can use its own apps for the agent.
- **Contacts answer the agent, never you.** At work on a task, an agent doesn't get `send_to_user`, scheduling or watching apps' events.
- **Work doesn't go round in circles.** No agent is handed a task by one working, directly or not, on a task it handed out, and a chain of tasks ends three deep: an agent that far from your chat hands out none.
- **Copies.** Publishing an agent publishes its contacts with it, and theirs, by role; the template's page lists each in full. Making it your own, or joining a Pim whose admin gives everyone that agent, gives you a copy of each, as contacts of the copies that had them. A copy keeps the name it came with, which you can change at any time. One whose role one of your agents already has gets a role of its own, such as "Physio (Marathon coach)". Each comes with its look, uploaded icon included.
- **Teams before.** Agents once had teams: members with instructions of their own that worked with their agent's apps. Each became an agent of its own, with its agent's blueprint, apps, skills and app tool permissions, and one of its contacts; its tasks are the new agent's. A member's list of tools has no counterpart, and was dropped.

## Talking with Pim from other apps

Claude, ChatGPT and other MCP clients can talk with your [majordomo](#your-majordomo). Add `https://<your Pim>/mcp` to one as a custom connector (Settings → Account → MCP clients shows the address). It works like Amp's Puck over MCP: the server has one tool, `pim`, which sends a message to your majordomo and returns its reply.

- **Connecting signs you in.** The client registers itself with Pim ([dynamic client registration](https://datatracker.ietf.org/doc/html/rfc7591)) and opens Pim's `/authorize` page, where you sign in if you aren't already and see who is asking and where access goes. Allow sends it back with a code it exchanges for tokens. Pim is the OAuth authorization server for its own MCP server, as the [MCP authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) asks, with [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider): discovery at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`, registration at `/oauth/register`, and tokens at `/oauth/token`, with PKCE. Clients, grants and hashed tokens are kept in the `OAUTH_KV` namespace, which deploying creates (see [`src/mcp-auth.ts`](../src/mcp-auth.ts)).
- **Access lasts while it's used.** An access token lasts an hour, and the client refreshes it. A connection ends after 30 days without use, or when you disconnect it in Settings → Account → MCP clients.
- **API tokens work too**, for clients without OAuth: send one from Settings → API tokens as `Authorization: Bearer <token>`.
- **A new chat per call, unless the client continues one.** Every reply names its conversation, a chat with your majordomo that you can also continue in Pim; a call that passes it back as `conversation` continues that chat, and one without it starts a new one. Only your majordomo's chats can be continued this way.
- **It hands work down as in the app.** Your majordomo hands bigger work to your other agents as [tasks](#tasks), and the reply waits for their answers too: it has everything the majordomo said, about the tasks as well. Work waiting for your approval comes back to its chat later, so asking again in the same conversation ("did Concierge book it?") tells you how things went.
- **A reply waits up to 45 seconds.** A turn still going after that answers "still working", or what the majordomo said so far and that it is still waiting on some of the work; ask again in the same conversation in a little while, and that message is answered once the turn before it ends.
- **Everything else works as in the app:** approvals, usage limits and tool permissions.

A connection opens only `/mcp`; an API token opens your whole API, so give it only to clients you trust.

## Sharing

You can let others on your Pim message your agent from their own space. Sharing → Circles: make a circle (Family, Close friends, Acquaintances), add people by their username, and choose what the circle can use: each connected app's tools (Off, Ask or On, as in [Tool permissions](#tool-permissions)) and the [memory scopes](#scopes) it may read: everyone's and those you named. Everything starts off. Until someone else has an account on your Pim, the app hides Sharing.

- **Their conversation runs in their space.** Someone you share with finds your space under Shared with you. Their conversation with it (a visit) is a chat in their own space, on their own model and usage: whoever sends the messages pays for them. It sees a brief your space sends before each of their turns: what their circle may use, the memory scopes it may read, and your time zone. Nothing of their own space (its tools, memory or apps) is in that conversation, and nothing of yours is in their other chats.
- **The boundary is in your space, at every call.** Each tool in a visit is a call into your space (`guestCall`), which checks again that they're in a circle, that the circle is on, and that the tool is allowed for it now. A tool turned off, an app that changed a tool since you allowed it, or a person you removed is refused, whatever their space was told before.
- **Ask means you decide.** A call to a tool set to Ask files an approval that names who asked and through which circle, and notifies you. Their conversation goes on; your decision arrives in it later as a message. Unanswered, it is denied after a day: a guest's request is never approved by a timeout. **Always approve for Family** sets the tool to On for that circle.
- **Limits.** Up to 20 circles and 200 people in them. Each guest can make 200 calls into your space a day, so your apps' own limits stay yours. Sharing → Recent activity lists what guests used, asked for, or were refused.
- **Taking it back.** Remove someone, or turn a circle off, and their next turn is refused. Deleting a circle forgets its permissions.
- **Artifacts too.** Share an artifact with circles from its page, and their people find its latest version under Artifacts → Shared with you, running in their own space with their own model and data; what it keeps for everyone (`pim.shared`) stays in yours. See [docs/artifacts.md](artifacts.md#sharing).

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

The web app is in [`web/`](../web), with its own README. Sign-in, with passkeys and other providers, is in [`src/auth/`](../src/auth).

To add a blueprint, tools only some agents get, or dashboard widgets, write an extension with a base and list it in `pim.config.ts` (see [docs/extensions.md](extensions.md)). To add a tool, write a pi extension in `src/extensions/` and install it in `Pim`'s harness factory. A tool with effects outside the conversation should be a `GatedAction` (see `src/extensions/approvals.ts`) so it runs only after approval.

## Not built yet

- Falling back to `PIM_MODEL` when the ChatGPT plan's usage limit is reached. Until then, a run that hits the limit fails with OpenAI's error.
- Computers that Pim starts for people who don't bring one.
- Extensions beyond MCP: full pi extensions that Pim builds into itself by redeploying its own Worker.
- Secret placeholders, so approved requests can use credentials the model never sees.
- Semantic recall. `recall` is a regular expression over the log, so it finds words, not meanings.
