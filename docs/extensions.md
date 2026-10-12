# Extensions

An extension is what a deployment adds to everyone's Pims: Pims to build on, and widgets for their dashboards. Its admin chooses them in code, in [`pim.config.ts`](../pim.config.ts), and deploys; the people on the Pim choose among what's there. Nothing is loaded at runtime.

Pim's own Pim is an extension too, [`pim.assistant`](../src/extensions/assistant.ts), written with the same API. A deployment can leave it out, and a person can make another Pim their default and delete theirs.

## Three layers

| Layer | What it is | Where |
| --- | --- | --- |
| Core | How every Pim works: talking through `send_to_user`, approvals, honesty, time. No Pim's instructions change it | The `preamble` section in [`src/extensions/persona.ts`](../src/extensions/persona.ts) |
| Abilities | Tools, prompt sections and background work, plus their widgets: goals, schedules, memory, artifacts, apps, teams | `src/extensions/`, always installed |
| Pims | A name, instructions, a dashboard and starters, defined by an extension; people's own Pims build on one | Extensions in `pim.config.ts` |

A person's Pim stores the extension's Pim it builds on as `base`, such as `pim.assistant/pim`. At every request its chats get the core preamble, then a `pim` section with the Pim's name, the base's instructions, and the person's own instructions, which win. Edits to the extension reach every Pim built on it at the next deploy: they aren't copies.

## Writing one

```ts
// extensions/ledger.ts
import { definePimExtension } from "../src/extensions/define";

export const ledger = definePimExtension({
	id: "ledger", // stored in people's Pims: don't rename it
	name: "Ledger",
	description: "Budgets and bills.",
	widgets: {
		bills: {
			title: { en: "Upcoming bills", es: "Próximas facturas" },
			empty: "No bills due.",
			load: async ({ pim, chatOf, timeZone }) => ({
				kind: "list",
				items: [{ title: "Rent", time: "2026-11-01T09:00:00Z" }],
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

People then make Pims built on it with `POST /api/personas` and `{ "name": "Household", "base": "ledger/budget" }`.

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

A widget that throws shows as failed, with the error logged; the dashboard's other widgets still load. The built-in widgets are `pim.schedule/upcoming`, `pim.goals/active`, `pim.memory/recent` and `pim.artifacts/recent`. Memory is shared by every Pim, so `pim.memory/recent` shows the same everywhere.

## Not built yet

- **Tools from extensions.** An extension can't bring tools, prompt sections or background work yet. Those are still pi extensions installed in `Pim`'s harness factory, and every Pim gets all of them.
- **Choosing a base in the app.** The API takes `base`, but the web app only makes Pims on the default one.
- **Copies keep their base.** Publishing a Pim and the Pim everyone starts with copy its name, instructions, apps and team, not its base: a copy builds on the deployment's default Pim.
- **Widget actions** beyond opening a chat or an artifact, more kinds, and arranging a dashboard.
