/**
 * What `send_to_user` shows under a message besides its text: widgets, cards the web app draws from data (`web/src/components/widgets.tsx`). Pim's own are
 * what is scheduled and the newest memories; each is loaded once, as the message is sent, and goes back to the model in the tool's result so it knows what the person saw.
 * A ```ui block in the message is checked by the `ui` language's compiler (`@pim/ui-lang`) first, and a block that cannot be drawn refuses the message, with what to fix.
 */
import type { App } from "@pim/v2-app/app";
import type { Principal } from "@pim/v2-contracts/identity";
import { closedUiSources, compile } from "@pim/ui-lang";

export const MAX_WIDGETS = 4;
type Text = string | { en: string; [locale: string]: string };
type Item = { title: string; detail?: string; time?: string; value?: number; max?: number };
export type ShownWidget = { id: string; title: Text; empty: Text } & ({ kind: "list" | "progress"; items: Item[] } | { failed: true });

export const WIDGETS: Record<string, { title: Text; empty: Text; description: string; load(app: App, p: Principal, agentId: string | null): Promise<{ kind: "list" | "progress"; items: Item[] }> }> = {
	"pim.schedule/upcoming": {
		title: { en: "Coming up", es: "Próximamente" },
		empty: { en: "Nothing scheduled. Ask for a reminder or a recurring check-in.", es: "Nada programado. Pide un recordatorio o un seguimiento periódico." },
		description: "The next scheduled tasks in this space, soonest first, with when each runs.",
		async load(app, p) {
			const next = (await app.schedules.list(p)).filter((s) => s.enabled && s.nextRunAt).sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime()).slice(0, 5);
			return { kind: "list", items: next.map((s) => ({ title: s.prompt.length > 120 ? `${s.prompt.slice(0, 119)}…` : s.prompt, time: s.nextRunAt!.toISOString() })) };
		},
	},
	"pim.memory/recent": {
		title: { en: "Recent memories", es: "Recuerdos recientes" },
		empty: { en: "Nothing remembered yet.", es: "Aún no hay recuerdos." },
		description: "The newest memories this agent can read.",
		async load(app, p, agentId) {
			const found = await app.memories.list(p, agentId ? (await app.agents.memoryOf(p, agentId)).reads : undefined);
			return { kind: "list", items: found.slice(0, 5).map((m) => ({ title: m.title, detail: m.body.length > 100 ? `${m.body.slice(0, 99)}…` : m.body, time: m.updatedAt.toISOString() })) };
		},
	},
};

/** Pim's own extensions, the ones that bring the widgets above, as `GET /api/extensions` lists them. */
const OWN_EXTENSIONS: Record<string, { name: string; description: string }> = {
	"pim.schedule": { name: "Schedules", description: "Work Pim does later, once or on a schedule." },
	"pim.memory": { name: "Memory", description: "What Pim remembers about you, in every chat." },
};
export const installedExtensions = () =>
	Object.entries(OWN_EXTENSIONS).map(([id, e]) => ({ id, ...e, widgets: widgetRefs().filter((ref) => ref.startsWith(`${id}/`)) }));

/** The widgets a chat can show, for the tool's description and its refusals. */
export const widgetRefs = () => Object.keys(WIDGETS);

/** Loads each widget asked for; one that throws comes back failed and the others still load. */
export async function loadWidgets(app: App, p: Principal, agentId: string | null, refs: string[]): Promise<ShownWidget[]> {
	return Promise.all(refs.map(async (id): Promise<ShownWidget> => {
		const w = WIDGETS[id]!;
		try {
			return { id, title: w.title, empty: w.empty, ...(await w.load(app, p, agentId)) };
		} catch (error) {
			console.warn(`widget ${id} failed`, error);
			return { id, title: w.title, empty: w.empty, failed: true };
		}
	}));
}

/**
 * What is wrong with a message's ```ui blocks, as the model can read and fix. The compiler only warns about what it could not use, such as JSON, which it drops and draws as plain text;
 * a message that shows the person that instead of the piece the model meant is refused, with what to fix, so the model can send it again.
 */
export function uiDiagnostics(message: string): { error?: string } {
	for (const body of closedUiSources(message)) {
		const [d] = compile(body).diagnostics;
		if (d) return { error: `a \`\`\`ui block${d.line > 0 ? ` (line ${d.line})` : ""} ${d.message}` };
	}
	return {};
}
