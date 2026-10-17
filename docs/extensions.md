# Extensions

An extension is what a deployment adds to everyone's Pims: blueprints for agents to build on, abilities (tools, prompt sections, background work, and actions that ask first), widgets for their dashboards, and color themes for the web app. Its admin chooses them in code, in [`pim.config.ts`](../pim.config.ts), and deploys; people choose among what's there. Nothing is loaded at runtime.

Pim's own blueprint is an extension too, [`pim.assistant`](../src/extensions/assistant.ts), written with the same API. A deployment can leave it out, and a person can make another agent their default and delete theirs. So are Pim's own color themes, [`pim.themes`](../src/extensions/themes/index.ts), which every deployment has.

Pim is the platform and a person's own space; an agent is what they create and chat with; a blueprint is what an extension defines in code for agents to build on; a template is an agent shared through the gallery.

## Three layers

| Layer | What it is | Where |
| --- | --- | --- |
| Core | How every Pim works: talking through `send_to_user`, approvals, honesty, time. No Pim's instructions change it | The `preamble` section in [`src/extensions/agents.ts`](../src/extensions/agents.ts) |
| Abilities | Tools, prompt sections, hooks and background tasks, plus actions that ask first and widgets. Pim's own (goals, schedules, memory, artifacts, teams, the web) are every Pim's; an extension's go only to the agents that use it | `src/extensions/`, and extensions' `ability` |
| Blueprints | A name, instructions, the abilities it uses, the apps it works with, a dashboard and starters, defined by an extension in code; agents build on one | Extensions in `pim.config.ts` |
| Agents | What a person talks with: a name and their own instructions and apps on top of a blueprint. Stored data, made in the app or by the agent | Your agents |

A person's Pim stores the blueprint its agents build on as `blueprint`, such as `pim.assistant/pim`; the agent editor's **Based on blueprint** chooses it. At every request its chats get the core preamble, then an `agent` section with the agent's name, the blueprint's instructions, and the person's own instructions, which win. They also get the abilities the blueprint uses: its own extension's, and those it lists in `abilities`. Edits to the extension reach every agent built on it at the next deploy, and an agent that changes its blueprint gets the new abilities in its chats from their next message: they aren't copies. Published agents and the default agent template keep their blueprint; a copy whose blueprint this deployment doesn't have builds on the default blueprint.

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
	blueprints: [
		{
			id: "budget",
			name: "Budget",
			description: "Keeps the books.",
			instructions: "Answer every money question with a number first.",
			dashboard: ["ledger/bills", "pim.goals/active", "pim.schedule/upcoming"],
			// Abilities of other extensions it uses; its own extension's always.
			abilities: [],
			// Remote MCP servers it works with: each person connects them with their own accounts.
			apps: [{ name: "Bank", url: "https://mcp.bank.example/mcp" }],
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

People then make agents built on it: Your agents → New agent → Based on blueprint: Budget, or `POST /api/agents` with `{ "name": "Household", "blueprint": "ledger/budget" }`.

## Abilities

`ability` is called once in each person's agent, with:

- `data`: the extension's own data, JSON values by key (`get`, `put`, `delete`, `list(prefix)`). No other extension sees it. It goes with the person's export and is erased with their account.
- `timeZone`: the person's, as it is when read.
- `notify(title, body)`: a notification in the app, pushed to their devices and webhook.

It returns a pi extension without its name (`tools`, `sections`, `hooks`, `wraps`, `tasks`; see [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable#extensions)), plus `actions`. The ability is installed under the extension's id and selected only in the chats of Pims that use it, and in their team members' conversations.

- **Actions ask first.** Each `GatedAction` becomes a tool that files an approval and returns at once. `run` runs only once the person approves, or their approval policy approves it. Actions are listed in Settings → Tool permissions with Pim's own, where they can be turned Off, Ask or On.
- **Names are checked.** An ability whose tool or action has the name of one of Pim's tools, or of another extension's, stops the agent with an error. pi would let the later tool replace the earlier one, so an extension could otherwise stand in for `send_to_user` or a tool that asks first. Prefix your tools' names with your extension's.
- **Code-level trust.** An ability runs in the person's agent, with what the context gives it and whatever its code can reach, such as `fetch`. Install only extensions you would merge into Pim itself.

- **Checked when an agent starts.** Ids must be lowercase letters, digits, dots and hyphens, and unique. Every dashboard must name a widget some installed extension provides, and `defaultBlueprint` must exist. A mistake fails loudly, with the reason, as soon as anything uses extensions (a chat's prompt, the agents list, a dashboard), instead of drawing a broken dashboard. Run `pnpm test` after changing `pim.config.ts`: every test uses it.
- **Text people read** is a string, or one per language with English always there. The dashboard is asked for in the person's language (`?locale=`), and English stands in for a missing translation. Instructions are for the model, so they are one string.

## Apps

An agent's `apps` are the remote MCP servers its chats work with. Each person connects them with their own accounts, from an agent's card in Your agents or by asking the agent, whose `connect_app` connects only the apps that agent lists. A chat gets the tools and instructions of the connected apps its agent lists: the blueprint's `apps`, then the agent's own. Apps connected for another agent stay out of it. With `manage_apps` enabled (Off / Ask in Tool permissions), an agent can request additions and removals to its own app list using a URL the person gives it or one `find_app` discovers. Each request requires explicit chat approval of its exact URLs, even under the auto approval policy, and approval connects additions automatically. Removal affects only the agent's own list, not blueprint apps or shared connections. `update_agent` cannot change apps. URLs must be https, and unique within an agent.

## Widgets

A widget is data of a kind the web app knows how to draw. `load` runs in the person's own Pim, the Durable Object that holds their agents, when their dashboard is opened. No extension code runs in the browser.

| Kind | Items | Drawn as |
| --- | --- | --- |
| `list` | `{ title, detail?, time?, link? }` | Rows. `time` is ISO 8601, shown in the person's language and time zone |
| `progress` | `{ title, value, max, detail?, link? }` | A bar with `value/max`, and the detail under it |

A `link` is `{ chat }` or `{ artifact }`: the item opens it.

`load` gets:

- `agent`: the agent whose dashboard it is (`id`, `name`, `default`).
- `chatOf(session)`: the person's chat that a conversation is, or works for, when that chat is this Pim's; null otherwise. A team member's conversation works for the chat that gave it its task. Use it to show only what belongs to this Pim, and to link to the chat.
- `ofAgent(session)`: whether a conversation is, or works for, one of this Pim's chats, including one since deleted. Use it for what outlives the chat it came from, such as a task that starts new chats.
- `timeZone`: the person's.
- `data`: the data of the extension that brings the widget.

A widget that throws shows as failed, with the error logged; the dashboard's other widgets still load. The built-in widgets are `pim.schedule/upcoming`, `pim.goals/active`, `pim.memory/recent` and `pim.artifacts/recent`. Memory is shared by every Pim, so `pim.memory/recent` shows the same everywhere.

### In chat

A widget with a `description` can also go with a message. The model reads a `widgets` section listing the ones the chat can show, each with its description: Pim's own, and those of the blueprint the agent builds on and the abilities that agent uses. It names them in `send_to_user`'s `widgets`, up to four, instead of retyping what they show.

- **Loaded once, when sent.** A message and its widgets always agree, as the person sees it later. The dashboard is where widgets are live.
- **The model sees what was shown.** The tool's result holds the widgets' content, which the app draws from, so the model knows what the person is looking at.
- **Mistakes come back to the model.** A widget the chat can't show refuses the whole message, and says which widgets it can show. Nothing reaches the person, and the model tries again within the turn.
- **Text where they can't be drawn.** An email gets them as Markdown under the message, and so does an API client's `replies`.
- **Not in visits or team members' conversations**: a guest never sees the host's data in a widget, and members don't talk to the person.

Leave out `description` for a widget that only makes sense on its dashboard.

## Themes

A theme is the web app's colors: a value for every color token its components use (see [`web/DESIGN.md`](../web/DESIGN.md#color)), in light and in dark mode, and the Shiki themes that color code in each. Like widgets, themes are data; no extension code runs in the browser.

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
- **The default** is `defaultTheme` in `pim.config.ts`: what people see until they pick another, and when the one they picked is gone.

People pick a theme in Settings → Appearance; the choice is kept in their browser. The Worker serves every theme's tokens as one stylesheet, `/api/themes.css`, which the app loads before it draws, and lists them at `/api/themes`. Both are public, since the sign-in screens use them too.

## Not built yet

- **Configuration and secrets** per extension: read a deployment's keys with `import { env } from "cloudflare:workers"` for now; per-person settings have no form.
- **Routes** for an extension's webhooks or sign-in callbacks.
- **Choosing Pim's own abilities per Pim**: memory, goals and the rest are every Pim's.
- **Widget actions** beyond opening a chat or an artifact, more kinds, and arranging a dashboard.
- **Themes beyond colors**, such as fonts and radii, and translated theme names.
- **Widgets with arguments** in chat, such as one goal, and interfaces the model composes itself from a catalog of components.
- **Extensions people bring themselves**, sandboxed (see [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)); connected MCP apps are how people add tools today.
