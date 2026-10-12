# Extensions

An extension is what a deployment adds to everyone's Pims: Pims to build on, abilities (tools, prompt sections, background work, and actions that ask first), and widgets for their dashboards. Its admin chooses them in code, in [`pim.config.ts`](../pim.config.ts), and deploys; the people on the Pim choose among what's there. Nothing is loaded at runtime.

Pim's own Pim is an extension too, [`pim.assistant`](../src/extensions/assistant.ts), written with the same API. A deployment can leave it out, and a person can make another Pim their default and delete theirs.

## Three layers

| Layer | What it is | Where |
| --- | --- | --- |
| Core | How every Pim works: talking through `send_to_user`, approvals, honesty, time. No Pim's instructions change it | The `preamble` section in [`src/extensions/persona.ts`](../src/extensions/persona.ts) |
| Abilities | Tools, prompt sections, hooks and background tasks, plus actions that ask first and widgets. Pim's own (goals, schedules, memory, artifacts, apps, teams, the web) are every Pim's; an extension's go only to the Pims that use it | `src/extensions/`, and extensions' `ability` |
| Pims | A name, instructions, the abilities it uses, a dashboard and starters, defined by an extension; people's own Pims build on one | Extensions in `pim.config.ts` |

A person's Pim stores the extension's Pim it builds on as `base`, such as `pim.assistant/pim`; the Pim editor's **Builds on** chooses it. At every request its chats get the core preamble, then a `pim` section with the Pim's name, the base's instructions, and the person's own instructions, which win. They also get the abilities the base uses: its own extension's, and those it lists in `abilities`. Edits to the extension reach every Pim built on it at the next deploy, and a Pim that changes its base gets the new abilities in its chats from their next message: they aren't copies. Publishing a Pim and the Pim everyone starts with keep its base; a copy whose base this deployment doesn't have builds on the default Pim.

## Writing one

```ts
// extensions/ledger.ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";
import { defineGatedAction, definePimExtension } from "../src/extensions/define";

type Bill = { name: string; amount: number; due: string; paid: boolean };

export const ledger = definePimExtension({
	id: "ledger", // stored in people's Pims and chats: don't rename it
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
			load: ({ data }) => ({
				kind: "list",
				items: data.list<Bill>("bill:").map(({ value }) => ({ title: value.name, time: value.due })),
			}),
		},
	},
	pims: [
		{
			id: "budget",
			name: "Budget",
			description: "Keeps the books.",
			instructions: "Answer every money question with a number first.",
			dashboard: ["ledger/bills", "pim.goals/active", "pim.schedule/upcoming"],
			// Abilities of other extensions it uses; its own extension's always.
			abilities: [],
			starters: [{ en: "How much did I spend?", es: "¿Cuánto gasté?" }],
		},
	],
});
```

Then add it to `pim.config.ts`:

```ts
export default definePimConfig({
	extensions: [assistant, ledger],
	defaultPim: "pim.assistant/pim",
});
```

People then make Pims built on it: Your Pims → New Pim → Builds on: Budget, or `POST /api/personas` with `{ "name": "Household", "base": "ledger/budget" }`.

## Abilities

`ability` is called once in each person's agent, with:

- `data`: the extension's own data, JSON values by key (`get`, `put`, `delete`, `list(prefix)`). No other extension sees it. It goes with the person's export and is erased with their account.
- `timeZone`: the person's, as it is when read.
- `notify(title, body)`: a notification in the app, pushed to their devices and webhook.

It returns a pi extension without its name (`tools`, `sections`, `hooks`, `wraps`, `tasks`; see [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable#extensions)), plus `actions`. The ability is installed under the extension's id and selected only in the chats of Pims that use it, and in their team members' conversations.

- **Actions ask first.** Each `GatedAction` becomes a tool that files an approval and returns at once. `run` runs only once the person approves, or their approval policy approves it. Actions are listed in Settings → Tool permissions with Pim's own, where they can be turned Off, Ask or On.
- **Names are checked.** An ability whose tool or action has the name of one of Pim's tools, or of another extension's, stops the agent with an error. pi would let the later tool replace the earlier one, so an extension could otherwise stand in for `send_to_user` or a tool that asks first. Prefix your tools' names with your extension's.
- **Code-level trust.** An ability runs in the person's agent, with what the context gives it and whatever its code can reach, such as `fetch`. Install only extensions you would merge into Pim itself.

- **Checked when an agent starts.** Ids must be lowercase letters, digits, dots and hyphens, and unique. Every dashboard must name a widget some installed extension provides, and `defaultPim` must exist. A mistake fails loudly, with the reason, as soon as anything uses extensions (a chat's prompt, the Pims list, a dashboard), instead of drawing a broken dashboard. Run `pnpm test` after changing `pim.config.ts`: every test uses it.
- **Text people read** is a string, or one per language with English always there. The dashboard is asked for in the person's language (`?locale=`), and English stands in for a missing translation. Instructions are for the model, so they are one string.

## Widgets

A widget is data of a kind the web app knows how to draw. `load` runs in the person's own agent, the Durable Object that holds their Pim, when their dashboard is opened. No extension code runs in the browser.

| Kind | Items | Drawn as |
| --- | --- | --- |
| `list` | `{ title, detail?, time?, link? }` | Rows. `time` is ISO 8601, shown in the person's language and time zone |
| `progress` | `{ title, value, max, detail?, link? }` | A bar with `value/max`, and the detail under it |

A `link` is `{ chat }` or `{ artifact }`: the item opens it.

`load` gets:

- `pim`: the Pim whose dashboard it is (`id`, `name`, `default`).
- `chatOf(session)`: the person's chat that a conversation is, or works for, when that chat is this Pim's; null otherwise. A team member's conversation works for the chat that gave it its task. Use it to show only what belongs to this Pim, and to link to the chat.
- `timeZone`: the person's.
- `data`: the data of the extension that brings the widget.

A widget that throws shows as failed, with the error logged; the dashboard's other widgets still load. The built-in widgets are `pim.schedule/upcoming`, `pim.goals/active`, `pim.memory/recent` and `pim.artifacts/recent`. Memory is shared by every Pim, so `pim.memory/recent` shows the same everywhere.

## Not built yet

- **Configuration and secrets** per extension: read a deployment's keys with `import { env } from "cloudflare:workers"` for now; per-person settings have no form.
- **Routes** for an extension's webhooks or sign-in callbacks.
- **Choosing Pim's own abilities per Pim**: memory, goals and the rest are every Pim's.
- **Widget actions** beyond opening a chat or an artifact, more kinds, and arranging a dashboard.
- **Extensions people bring themselves**, sandboxed (see [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)); connected MCP apps are how people add tools today.
