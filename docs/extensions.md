# Extensions

An extension is what a deployment adds to everyone's spaces: blueprints for agents to build on, abilities (tools, prompt sections, background work, and actions that ask first), widgets for their dashboards, and color themes for the web app. Its admin chooses them in code, in [`pim.config.ts`](../pim.config.ts), and deploys; people choose among what's there. Nothing is loaded at runtime.

Pim's own blueprint is an extension too, [`pim.assistant`](../src/extensions/assistant.ts), written with the same API. A deployment can leave it out, and a person can move their majordomo to another blueprint. So are Pim's own color themes, [`pim.themes`](../src/extensions/themes/index.ts), which every deployment has.

Pim is the platform; a space is one person's own part of it; an agent is what they create and chat with; a blueprint is what an extension defines in code for agents to build on; a template is an agent shared through the gallery.

## Three layers

| Layer | What it is | Where |
| --- | --- | --- |
| Core | How every space works: talking through `send_to_user`, approvals, honesty, time. No space's instructions change it | The `preamble` section in [`src/extensions/agents.ts`](../src/extensions/agents.ts) |
| Abilities | Tools, prompt sections, hooks and background tasks, plus actions that ask first and widgets. Pim's own (goals, schedules, memory, artifacts, tasks, the web) are every space's; an extension's go only to the agents that use it | `src/extensions/`, and extensions' `ability` |
| Blueprints | A name, instructions, the abilities it uses, the apps it works with, a dashboard and starters, defined by an extension in code; agents build on one | Extensions in `pim.config.ts` |
| Agents | What a person talks with: a name and their own instructions and apps on top of a blueprint. Stored data, made in the app or by the agent | Your agents |

A person's space stores the blueprint its agents build on as `blueprint`, such as `pim.assistant/pim`; the agent editor's **Based on blueprint** chooses it. At every request its chats get the core preamble, then an `agent` section with the agent's name, the blueprint's instructions, and the person's own instructions, which win. They also get the abilities the blueprint uses: its own extension's, and those it lists in `abilities`. Edits to the extension reach every agent built on it at the next deploy, and an agent that changes its blueprint gets the new abilities in its chats from their next message: they aren't copies. Published agents and the default agent template keep their blueprint; a copy whose blueprint this deployment doesn't have builds on the default blueprint.

## Writing one

```ts
// extensions/ledger.ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";
import { defineGatedAction, definePimExtension } from "../src/extensions/define";

type Bill = { name: string; amount: number; due: string; paid: boolean };

export const ledger = definePimExtension({
	id: "ledger", // stored in people's agents and chats: don't rename it
	name: "Ledger",
	description: "Budgets and bills.",
	ability: ({ data, timeZone, notify }) => ({
		tools: [
			defineTool({
				name: "ledger_add_bill",
				description: "Record a bill to pay.",
				parameters: Type.Object({ name: Type.String(), amount: Type.Number(), due: Type.String() }),
				async execute({ name, amount, due }) {
					data.put(`bill:${name}`, { name, amount, due, paid: false });
					return { content: [{ type: "text", text: `Recorded ${name}.` }] };
				},
			}),
		],
		sections: [section("ledger_bills", () => data.list<Bill>("bill:").map(({ value }) => `${value.name}: ${value.amount}`).join("\n") || "No bills.")],
		actions: [
			defineGatedAction({
				name: "ledger_pay_bill",
				description: "Pay a recorded bill.",
				parameters: Type.Object({ name: Type.String() }),
				summarize: ({ name }) => `Pay ${name}`,
				async run({ name }) {
					// Runs only once the person approves.
					return `Paid ${name}.`;
				},
			}),
		],
	}),
	widgets: {
		bills: {
			title: { en: "Upcoming bills", es: "Próximas facturas" },
			empty: "No bills due.",
			// For the model: lets it show the widget with a message in chat.
			description: "Bills not paid yet, with when each is due.",
			load: ({ data }) => ({
				kind: "list",
				items: data.list<Bill>("bill:").map(({ value }) => ({ title: value.name, time: value.due })),
			}),
		},
	},
	// Apps people can connect: remote MCP servers, named `ledger/<id>`.
	apps: [{ id: "bank", name: "Bank", description: "Your accounts and transactions.", url: "https://mcp.bank.example/mcp" }],
	blueprints: [
		{
			id: "budget",
			name: "Budget",
			description: "Keeps the books.",
			instructions: "Answer every money question with a number first.",
			// What a new agent's dashboard starts with; the agent and the person change it from there.
			dashboard: ["ledger/bills", "pim.goals/active", "pim.schedule/upcoming"],
			// Abilities of other extensions it uses; its own extension's always.
			abilities: [],
			// Apps it works with, from any extension: each person connects them with their own accounts.
			apps: ["ledger/bank"],
			starters: [{ en: "How much did I spend?", es: "¿Cuánto gasté?" }],
		},
	],
});
```

Then add it to `pim.config.ts`:

```ts
export default definePimConfig({
	extensions: [assistant, ledger],
	defaultBlueprint: "pim.assistant/pim",
	defaultTheme: "tokyo-night",
});
```

People then make agents built on it: Agents in the sidebar → New agent → Based on blueprint: Budget, or `POST /api/agents` with `{ "name": "Household", "blueprint": "ledger/budget" }`.

## Abilities

`ability` is called once in each person's agent, with:

- `data`: the extension's own data, JSON values by key (`get`, `put`, `delete`, `list(prefix)`). No other extension sees it. It goes with the person's export and is erased with their account.
- `timeZone`: the person's, as it is when read.
- `notify(title, body)`: a notification in the app, pushed to their devices.

It returns a pi extension without its name (`tools`, `sections`, `hooks`, `wraps`, `tasks`; see [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable#extensions)), plus `actions`. The ability is installed under the extension's id and selected only in the chats of agents that use it, and in the conversations of tasks they work on.

- **Assigned actions run without a prompt.** Each `GatedAction` files an approval, which is approved immediately for an agent whose blueprint includes the ability, unless the person chose Ask or Off. Mark risky actions `explicitApproval: true`: every call waits for the person's decision, with no timeout or Always approve. Other requests follow the person's approval policy. Actions are listed in Settings → Permissions with Pim's own.
- **Names are checked.** An ability whose tool or action has the name of one of Pim's tools, or of another extension's, stops the agent with an error. pi would let the later tool replace the earlier one, so an extension could otherwise stand in for `send_to_user` or a tool that asks first. Prefix your tools' names with your extension's.
- **Code-level trust.** An ability runs in the person's agent, with what the context gives it and whatever its code can reach, such as `fetch`. Install only extensions you would merge into Pim itself.

- **Checked when an agent starts.** Ids must be lowercase letters, digits, dots and hyphens, and unique. Every dashboard must name a widget some installed extension provides, and `defaultBlueprint` must exist. A mistake fails loudly, with the reason, as soon as anything uses extensions (a chat's prompt, the agents list, a dashboard), instead of drawing a broken dashboard. Run `pnpm test` after changing `pim.config.ts`: every test uses it.
- **Text people read** is a string, or one per language with English always there. The dashboard is asked for in the person's language (`?locale=`), and English stands in for a missing translation. Instructions are for the model, so they are one string.

## Apps

An extension's `apps` are what people on the deployment can connect: remote MCP servers, each with an `id`, a `name`, a `description` and an https `url`, or apps the extension implements itself (see [below](#apps-without-an-mcp-server)). An app's optional `icon` is its logo, an https or `data:` square image URL, drawn as is on light and dark themes; without one it shows its initial. Each is named `<extension>/<id>`, and that name is what blueprints, agents and templates list, never the URL. Besides the extensions' apps, the admin can add their own in Apps (`custom/<id>`; no extension may be called `custom`), and each gets the icon URL they give, or else its site's, looked up when it's added; they can change it later. Together they are the directory, and nothing outside it can be connected.

Each person connects an app once, with their own account, from Apps in the sidebar, an agent's page in the sidebar's Agents, or by asking an agent, whose `connect_app` connects only the apps that agent lists. Every agent of theirs that lists it then works with that one connection. A chat gets the tools and instructions of the connected apps its agent lists: the blueprint's `apps`, then the agent's own. Apps connected for another agent stay out of it. With `manage_apps` enabled (Off / Ask in Tool permissions), an agent can request additions and removals to its own app list, by name, as `find_app` finds them in the directory. Each request requires explicit chat approval, even under the auto approval policy, and approval connects additions automatically. Removal affects only the agent's own list, not blueprint apps or shared connections. `update_agent` cannot change apps.

Each agent has a switch for each tool of its connected apps, on its page: on, the tool runs in its chats and tasks without asking; off, it isn't offered. Tools start on, except those marked `destructiveHint: true` (native app tools: `destructive: true`) and those of an app whose approval policy is `all`, which start off until the person switches them on. Circles keep their own permissions.

Most MCP servers let Pim register itself when someone signs in. For one that doesn't, such as GitHub's, register an OAuth client with the service whose redirect URL is this Pim's `/mcp/callback`, and name the Worker's environment variables holding it in the app's `client`: `client: { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" }`. Pim signs everyone in with that client, and offers the app only once they're set. [`popular-apps.ts`](../src/extensions/popular-apps.ts), the apps Pim brings, has one.

A blueprint's apps must be installed: one that names an app no extension brings fails when extensions are checked. Don't rename an app's `id`: people's agents store it.

### Apps without an MCP server

For a service with no MCP server, such as Spotify or Plaid, an extension implements the app: its sign-in and its tools, in place of a `url`. To everything else it is an app like the others: agents list it, people connect it once from Apps, and tool permissions and approvals cover its tools. [`spotify.ts`](../src/extensions/spotify.ts) is a complete one.

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, definePimExtension, oauth2 } from "../src/extensions/define";

export const music = definePimExtension({
	id: "music",
	name: "Music",
	description: "Your music service.",
	apps: [
		{
			id: "music",
			name: "Music",
			description: "What's playing, and playback.",
			// Environment variables (`wrangler secret put`): until every one is set, nobody is offered the app.
			secrets: ["MUSIC_CLIENT_ID", "MUSIC_CLIENT_SECRET"],
			// signIn, callback and refresh, for a service that speaks OAuth 2.0 (authorization code with PKCE).
			...oauth2({
				authorizeUrl: "https://accounts.music.example/authorize",
				tokenUrl: "https://accounts.music.example/token",
				scopes: ["playback"],
				clientId: "MUSIC_CLIENT_ID",
				clientSecret: "MUSIC_CLIENT_SECRET",
			}),
			tools: [
				defineAppTool({
					name: "now_playing",
					description: "What's playing now.",
					parameters: Type.Object({}),
					// Read-only tools are the ones artifacts may call without the person switching anything on.
					readOnly: true,
					async execute(_args, { credential }) {
						const playing = await (await fetch("https://api.music.example/now", { headers: { authorization: `Bearer ${credential.accessToken}` } })).json();
						return {
							text: `Playing ${playing.title}.`,
							// The person can be shown this under a message (see Widgets → From tools).
							widget: { title: "Now playing", kind: "progress", items: [{ title: playing.title, value: playing.at, max: playing.length }] },
						};
					},
				}),
			],
		},
	],
});
```

- **Sign-in.** `signIn` gets the `callbackUrl`, a `state` and the app's secrets, and returns the URL to send the person to, with anything to keep until they return (`pending`, such as a PKCE verifier). They come back to `callbackUrl`, which is this Pim's `/mcp/callback/apps` for everyone, so it can be registered as the redirect URI; `state` tells the Worker whose space it is. `callback` gets the URL they came back to and returns their credential, any JSON; throw to fail with a reason the person sees. A service with another flow, such as Plaid's Hosted Link, implements `signIn` and `callback` itself.
- **Credentials** stay in the person's own space, never in exports, and go with their account. One with `expiresAt` (ms) is renewed with `refresh` a minute before it expires, once however many calls want it; without `refresh`, or when it fails, the app shows as failed and the person connects it again.
- **Tools** are named `<connection>_<name>`, like an MCP app's, and get the person's `credential` and the app's `secrets`. A thrown error comes back to the model as the tool's error.

## Widgets

A widget is data of a kind the web app knows how to draw. `load` runs in the person's own space, held by the Durable Object `Pim`, when their dashboard is opened. No extension code runs in the browser.

| Kind | Items | Drawn as |
| --- | --- | --- |
| `list` | `{ title, detail?, time?, link? }` | Rows. `time` is ISO 8601, shown in the person's language and time zone |
| `progress` | `{ title, value, max, detail?, link? }` | A bar with `value/max`, and the detail under it |

A `link` is `{ chat }` or `{ artifact }`: the item opens it. `{ artifact, chat }` opens the artifact beside that chat.

`load` gets:

- `agent`: the agent whose dashboard it is (`id`, `name`, `majordomo`).
- `chatOf(session)`: the person's chat that a conversation is, or works for, when that chat is this space's, by the id a `link` takes; null otherwise. A task's conversation works for the chat the work began in. Use it to show only what belongs to this space, and to link to the chat.
- `ofAgent(session)`: whether a conversation is, or works for, one of this space's chats, including one since deleted. Use it for what outlives the chat it came from, such as a task that starts new chats.
- `timeZone`: the person's.
- `data`: the data of the extension that brings the widget.

A blueprint's `dashboard` is where its agents' dashboards start. An agent changes its own with `update_dashboard`, when the person asks: it pins widgets it can show (Pim's own, and those of the extensions it builds on and uses) and artifacts it made, which run there as their latest version, and the person takes things off. From the first change on, the agent's dashboard is its own, and a change to the blueprint's no longer reaches it. Pim's own blueprint starts empty. A widget no installed extension brings anymore is left off.

A widget that throws shows as failed, with the error logged; the dashboard's other widgets still load. The built-in widgets are `pim.schedule/upcoming`, `pim.goals/active`, `pim.memory/recent` and `pim.artifacts/recent`. Memory is shared by every agent in a space, so `pim.memory/recent` shows the same everywhere in that space. `pim.artifacts/recent` is only for dashboards: it shows what the agent's own chats made, so in a chat an agent shows an artifact with `artifact_show`.

### In chat

A widget with a `description` can also go with a message. The model reads a `widgets` section listing the ones the chat can show, each with its description: Pim's own, and those of the blueprint the agent builds on and the abilities that agent uses. It names them in `send_to_user`'s `widgets`, up to four, instead of retyping what they show.

- **Loaded once, when sent.** A message and its widgets always agree, as the person sees it later. The dashboard is where widgets are live.
- **The model sees what was shown.** The tool's result holds the widgets' content, which the app draws from, so the model knows what the person is looking at.
- **Mistakes come back to the model.** A widget the chat can't show refuses the whole message, and says which widgets it can show. Nothing reaches the person, and the model tries again within the turn.
- **Text where they can't be drawn.** An email gets them as Markdown under the message, and so does an API client's `replies`.
- **Not in visits or tasks' conversations**: a guest never sees the host's data in a widget, and an agent at work on a task doesn't talk to the person.

Leave out `description` for a widget that only makes sense on its dashboard.

### From tools

A tool of an app an extension implements can return a `widget` with its `text`: a `title` and content of one of the kinds above. Pim keeps it for the chat (its 20 latest) and tells the model its name, `tool:<id>`, which it can put in `send_to_user`'s `widgets` to show the person the result instead of retyping it. A result the tool marks `isError` keeps none.

## Themes

A theme gives the web app its colors, typography and icon style: every color token its components use (see [`web/DESIGN.md`](../web/DESIGN.md#color)), in light and in dark mode, the Shiki themes that color code in each, and optional choices of bundled fonts and icons. Like widgets, themes are data; no extension code runs in the browser.

```ts
import { nord } from "../src/extensions/themes/nord";

export const brand = definePimExtension({
	id: "acme.brand",
	name: "Acme",
	description: "Acme's colors.",
	themes: [
		{
			id: "acme", // stored in people's browsers: don't rename it
			name: "Acme",
			light: { ...nord.light, primary: "#c2410c", ring: "#c2410c" },
			dark: { ...nord.dark, primary: "#fb923c", ring: "#fb923c" },
			code: { light: "github-light-default", dark: "github-dark-default" },
		},
	],
});
```

- **Every token, in each mode.** `light` and `dark` give every token in [`THEME_TOKENS`](../src/themes.ts) a CSS color; `bubble` and `bubble-foreground` are optional and follow the primary. A missing or unknown token fails with the reason, like any mistake in `pim.config.ts`.
- **Ids are the deployment's.** A theme's id is lowercase letters, digits and hyphens, unique across every extension, Pim's own included. Prefix yours with your extension's name.
- **Code colors** are a theme Shiki bundles, by name, or one recolored from it: `{ base, background, foreground, colors }`, mapping each of the base's colors to yours. A name Shiki doesn't ship leaves that theme's code uncolored.
- **Fonts** are optional: `fonts: { ui: "pixel", code: "pixel" }` chooses Pixeloid Sans (regular and bold) for interface text and Pixeloid Mono for monospace text. Each role independently accepts `"system"` (the default) or `"pixel"`. Font files ship with the web app; missing characters use the fallback stack. Themes do not fetch fonts from third parties.
- **Icons** are optional: `icons: "pixel"` chooses pixel outlines for utility icons and named agent symbols; `"lucide"` is the default. Uploaded images, emoji, app logos and Pim's wordmark keep their identity. Fonts and icons can be selected independently of each other and of the colors. Adding a new font or icon set requires bundling it in Pim, not supplying browser code in an extension.
- **The default** is `defaultTheme` in `pim.config.ts`: what people see until they pick another, and when the one they picked is gone.
- **The logo** at the top of the sidebar is Pim's own mark, or `logo` in `pim.config.ts`: an https or `data:` image URL, square, that works on light and dark. Hovering it shows Pim's version, from `package.json`.

People pick a theme in Settings → General, under Appearance; previews show its colors, fonts and icons, and the choice is kept in their browser. Pim's Pixel theme pairs Tokyo Night's colors with pixel fonts and icons; existing themes keep system fonts and Lucide icons. The Worker serves every theme's tokens as one stylesheet, `/api/themes.css`, which the app loads before it draws, and lists them at `/api/themes`. Both are public, since the sign-in screens use them too.

## Not built yet

- **Configuration and secrets** per extension, beyond an app's `secrets`: read a deployment's keys with `import { env } from "cloudflare:workers"` for now; per-person settings have no form.
- **Routes** for an extension's webhooks.
- **Choosing Pim's own abilities per space**: memory, goals and the rest are every space's.
- **Widget actions** beyond opening a chat or an artifact, more kinds, and arranging a dashboard.
- **Theme-specific shapes and spacing**, and translated theme names.
- **Widgets with arguments** in chat, such as one goal, and interfaces the model composes itself from a catalog of components.
- **Extensions people bring themselves**, sandboxed (see [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)); the directory's MCP apps are how people add tools today.
- **Widgets from MCP apps' results**, and interfaces apps ship themselves ([MCP Apps](https://modelcontextprotocol.io/extensions/apps)).
- **More than one account** of an app per person, such as two banks.
