# What Pim is built from: abilities, connectors, widgets and themes

Pim is the platform; a space is one person's own part of it; an agent is what they create and chat with; a template is an agent shared through the gallery; an app is what an agent builds that people use; a connector is a service an agent works with, such as Gmail.

The Cloudflare version of Pim let a deployment add *extensions* in code (a `pim.config.ts`); the v2 server has no such framework. What an extension brought is built in, as the modules below, and people add tools through connectors (remote MCP servers) instead. To add a capability for everyone, change the server: [AGENTS.md](../AGENTS.md) says where, and [reference.md](reference.md#develop) how a tool is added.

## Three layers

| Layer | What it is | Where |
| --- | --- | --- |
| Core | How every space works: talking through `send_to_user`, approvals, honesty, time. No space's instructions change it | The core preamble in [`packages/v2-server/src/agent-prompts.ts`](../packages/v2-server/src/agent-prompts.ts) |
| Abilities | Tools, prompt sections and background work every space has: goals, schedules and triggers, memory, apps, tasks, the web, the computer, coding, connectors; and actions that ask first | `packages/v2-server/src/*-tools.ts`, registered by [`agent-host.ts`](../packages/v2-server/src/agent-host.ts) |
| Agents | What a person talks with: a name and their own instructions and connectors on top of how Pim's assistant works. Stored data, made in the app or by the agent | Your agents |

At every request an agent's chats get the core preamble, then an `agent` section with the agent's name, how Pim's assistant works, and the person's own instructions, which win. They also get every ability the agent is offered. Edits to an ability reach every agent at the next update: they aren't copies.

An ability's action that has effects outside the conversation asks first: it is listed in `NEEDS_APPROVAL` (`packages/v2-app/src/authz.ts`) and uses `askFirst` (`tool-approval.ts`). Each such action files an approval, which is approved immediately unless the person chose Ask or Off in Settings → Tool permissions, or follows the person's approval policy. A risky action is marked so that every call waits for the person's decision, with no timeout or Always approve.

## Connectors

What people on the deployment can connect are remote MCP servers and connectors Pim implements itself, in the directory (`GET /api/app-directory`): the popular servers ([`popular-apps.ts`](../packages/v2-server/src/native/popular-apps.ts)), Pim's own (Gmail, Google Drive and Spotify), and those the admin adds in Connectors → Create new connector or by asking their majordomo, named `custom/<id>`. Each is named `<provider>/<id>`, and that name is what agents and templates list, never the URL. How they connect, store credentials and watch for events is in [architecture/v2-connectors.md](architecture/v2-connectors.md).

Each person connects a connector once, with their own account, from Connectors in the sidebar, an agent's page in Agents, or by asking an agent, whose `connect_connector` connects only the connectors that agent lists. Every agent of theirs that lists it then works with that one connection. A chat gets the tools and instructions of the connected connectors its agent lists. Connectors connected for another agent stay out of it. With `manage_connectors` enabled (Off / Ask in Tool permissions), an agent can add or remove a connector from its own list once the person approves it.

Each agent has a switch for each tool of its connected connectors, on its page: on, the tool runs in its chats and tasks without asking; off, it isn't offered. Tools start on, except those marked `destructiveHint: true` and those of a connector whose approval policy is `all`, which start off until the person switches them on. Circles keep their own permissions.

Most MCP servers let Pim register itself when someone signs in. For one that doesn't, such as GitHub's, register an OAuth client with the service whose redirect URL is this Pim's `/mcp/callback/apps`, and set it in `.env` (`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`); Pim signs everyone in with that client, and offers the connector only once they're set ([reference.md](reference.md#deploy) lists them).

### Connectors Pim implements

For a service with no MCP server, such as Spotify, Pim implements the connector: its sign-in and its tools, in [`packages/v2-server/src/native/`](../packages/v2-server/src/native). To everything else it is a connector like the others: agents list it, people connect it once from Connectors, and tool permissions and approvals cover its tools.

### Google connectors

[`google.ts`](../packages/v2-server/src/native/google.ts) is what Google's connectors share: Google's sign-in, renewal and revocation, and calls to Google's APIs with the person's credential. Pim's own are [Gmail](../packages/v2-server/src/native/gmail.ts) and [Google Drive](../packages/v2-server/src/native/drive.ts); setting up their OAuth clients is in [reference.md](reference.md#deploy).

- **One OAuth client per connector, each in its own Google Cloud project.** Google keeps a person's grant per project: every client in a project shares it, and revoking it ends every client's tokens there. With a project each, the person allows Gmail and Drive separately, and disconnecting one revokes only its grant. Until the client's ID and secret are set, nobody is offered the connector.
- **Narrow scopes only.** `GOOGLE_SCOPES` is what connectors may ask for: `gmail.readonly`, and `drive.file`, which reaches only the files the person picks for Pim or Pim creates. The sign-in asks for offline access with Google's consent screen each time, so every sign-in has a refresh token, and asks Google to list every scope the person granted the project (`include_granted_scopes`), so the check sees the whole grant. Granted scopes must be the connector's exactly, in any order or spacing. One with more (its project serves something else too) is refused and left unrevoked, since revoking would end that other grant; one with less (the person unticked a box), or without a refresh token, is refused and revoked.
- **The credential** is a sealed bundle with an access token, a refresh token and when it expires. Renewing keeps the refresh token, which Google leaves out of its answer. `invalid_grant` (revoked, or expired) means connecting again: the connector's credential is cleared, it shows as needing a sign-in, and the person gets a notification. A renewal is made by one caller at a time and written only over the credential it began from, so calls at once spend a rotating refresh token once and a connection made again meanwhile is never overwritten; a service that only cannot answer now leaves the sign-in as it was. Erasing an account revokes its native connectors' grants at the provider.
- **Calls** go only to `https://*.googleapis.com`, send the token, and don't follow redirects. Google busy (429, 5xx, or a rate-limit 403) or out of reach: they try up to three times, waiting longer each time or as `Retry-After` says, up to 5 seconds; a request that isn't GET, HEAD, PUT or DELETE is tried once unless marked idempotent. A 401 renews the token once and tries again; refused again, the connector needs connecting again. Any other refusal throws a `GoogleApiError` with its `status`, Google's `reason` and message, never the token. A large answer never fills memory: answers are read up to a limit, and Google's refusals are read up to 16 KiB and said in one line of at most 300 characters.
- Tools that only read are marked read-only. Google connectors don't write: not mail, not Drive files.

Gmail's `search`, `get_message` and `get_thread` fetch from Gmail within bounds (20 results a search, headers only for results, 256 KiB for a list, 8 MiB for a message, 16 MiB for a thread, falling back to headers past that) and read what comes back through a `GmailContent` adapter ([`gmail-adapter.ts`](../packages/v2-server/src/native/gmail-adapter.ts)) over the MIME normalizer [`gmail-content.ts`](../packages/v2-server/src/native/gmail-content.ts): at most 12 levels and 200 parts a message, 1 MiB decoded and 20,000 characters of text a message, 4 MiB and 60,000 a thread's latest 25 messages, header values of 500 characters (200 in a thread); plain text before HTML, HTML reduced to its text, attachments listed and never fetched, and mail fenced as untrusted. The HTTP bounds limit memory and parsing; the normalizer's limit the work and what the model reads. Gmail never sends, drafts, labels or deletes.

Drive reads only the files the person picks for Pim, on Pim's page `/app-pages/google/drive` (see [reference.md](reference.md#deploy)), with Google's Picker: the connector's `actions` are what the person does in their own browser (picking files), and Drive's tools read only the picked files, each checked with Google.

## Widgets

A widget is data of a kind the web app knows how to draw ([`agent-widgets.ts`](../packages/v2-server/src/agent-widgets.ts)). Its loader runs on the server, in the person's own space, when an agent sends it with a message. No code runs in the browser.

| Kind | Items | Drawn as |
| --- | --- | --- |
| `list` | `{ title, detail?, time?, link? }` | Rows. `time` is ISO 8601, shown in the person's language and time zone |
| `progress` | `{ title, value, max, detail?, link? }` | A bar with `value/max`, and the detail under it |

A `link` is `{ chat }` or `{ artifact }`: the item opens it. `{ artifact, chat }` opens the app beside that chat. (`artifact` is still the key's name in the code.) The built-in widgets are `pim.schedule/upcoming`, `pim.goals/active` and `pim.memory/recent`. Each shows what belongs to the chat's agent: `pim.memory/recent` shows the newest memories of the [scopes](reference.md#scopes) it reads, so the majordomo's shows all of them. A widget that throws shows as failed, with the error logged; the message's other widgets still load.

The model reads a `widgets` section listing the ones the chat can show, each with its description. It names them in `send_to_user`'s `widgets`, up to four, instead of retyping what they show.

- **Loaded once, when sent.** A message and its widgets always agree, as the person sees it later.
- **The model sees what was shown.** The tool's result holds the widgets' content, which the app draws from, so the model knows what the person is looking at.
- **Mistakes come back to the model.** A widget the chat can't show refuses the whole message, and says which widgets it can show. Nothing reaches the person, and the model tries again within the turn.
- **Text where they can't be drawn.** An email gets them as Markdown under the message, and so does an API client's `replies`.
- **Not in visits or tasks' conversations**: a guest never sees the host's data in a widget, and an agent at work on a task doesn't talk to the person.

Beyond widgets, a message can carry interactive blocks the agent writes in the `ui` language (see [Interactive blocks](reference.md#interactive-blocks)).

## Themes

A theme gives the web app its colors, typography and icon style: every color token its components use (see [`web/DESIGN.md`](../web/DESIGN.md#color)), in light and in dark mode, the Shiki themes that color code in each, and optional choices of bundled fonts and icons. Like widgets, themes are data; no code from a theme runs in the browser. Pim's themes are in [`packages/shared/src/theme-data/`](../packages/shared/src/theme-data), and are shared by the server and the web app:

```ts
import { nord } from "@pim/shared/theme-data/nord";

export const acme = {
	id: "acme", // stored in people's browsers: don't rename it
	name: "Acme",
	light: { ...nord.light, primary: "#c2410c", ring: "#c2410c" },
	dark: { ...nord.dark, primary: "#fb923c", ring: "#fb923c" },
	code: { light: "github-light-default", dark: "github-dark-default" },
};
```

- **Every token, in each mode.** `light` and `dark` give every token in [`THEME_TOKENS`](../packages/shared/src/themes.ts) a CSS color; `bubble` and `bubble-foreground` are optional and follow the secondary surface and its foreground. Bubble fills should stay close to the canvas, with text meeting WCAG AA contrast (4.5:1). A missing or unknown token fails with the reason.
- **Ids** are lowercase letters, digits and hyphens, unique across themes.
- **Code colors** are a theme Shiki bundles, by name, or one recolored from it: `{ base, background, foreground, colors }`, mapping each of the base's colors to yours. A name Shiki doesn't ship leaves that theme's code uncolored.
- **Fonts** are optional: `fonts: { ui: "pixel", code: "pixel" }` chooses Pixeloid Sans (regular and bold) for interface text and Pixeloid Mono for monospace text. Each role independently accepts `"system"` (the default) or `"pixel"`. Font files ship with the web app; missing characters use the fallback stack. Themes do not fetch fonts from third parties.
- **Icons** are optional: `icons: "pixel"` chooses pixel outlines for utility icons and named agent symbols; `"lucide"` is the default. Uploaded images, emoji, connector logos and Pim's wordmark keep their identity. Fonts and icons can be selected independently of each other and of the colors. Adding a new font or icon set requires bundling it in Pim.
- **The default** is Tokyo Night: what people see until they pick another, and when the one they picked is gone.
- **The logo** at the top of the sidebar is Pim's own mark, or `PIM_LOGO`: an https or `data:` image URL, square, that works on light and dark. Hovering it shows Pim's version, from `package.json`.

People pick a theme in Settings → General, under Appearance; previews show its colors, fonts and icons, and the choice is kept in their browser. Pim's Pixel theme pairs Tokyo Night's colors with pixel fonts and icons; existing themes keep system fonts and Lucide icons. The server serves every theme's tokens as one stylesheet, `/api/themes.css`, which the app loads before it draws, and lists them at `/api/themes`. Both are public, since the sign-in screens use them too.

## Not built yet

- **Extensions a deployment writes in code**, as the Cloudflare version had: a deployment changes the server itself, and people bring tools through MCP connectors.
- **Choosing Pim's own abilities per space**: memory, goals and the rest are every space's.
- **Widget actions** beyond opening a chat or an app, and more kinds.
- **Theme-specific shapes and spacing**, and translated theme names.
- **Widgets with arguments** in chat, such as one goal.
- **Widgets from MCP connectors' results**, and interfaces connectors ship themselves ([MCP Apps](https://modelcontextprotocol.io/extensions/apps)).
- **More than one account** of a connector per person, such as two banks.
