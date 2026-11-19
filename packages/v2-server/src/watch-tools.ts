/**
 * The agent's watch tools, ported from v1's `src/extensions/app-events.ts`: `list_connector_events` (what a connected server can tell it about), `watch_connector_event` (hear of one,
 * and say what to do each time), `list_watches` and `stop_watch`. A watch is a trigger on the connector's event delivering to the chat that made it, with a subscription at the server
 * (`watches.ts`); each event arrives as a message that starts with "[Connector event]". Subscribing needs no approval; what the agent then does is still subject to the usual approvals.
 */
import { Type } from "typebox";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Principal } from "@pim/v2-contracts/identity";
import { BadRequestError } from "@pim/v2-app/errors";
import { connectorOf, connectorSession, listEvents, newWatchSecret, subscribe, unsubscribe, type WatchDeps } from "./watches.ts";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });
const json = (v: unknown): Result => text(JSON.stringify(v, null, 1));
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export type WatchToolDeps = {
	ownerId: string;
	/** The application, keys and transport, as the Runner has them; absent where the Runner has no application database. */
	watch: () => WatchDeps | undefined;
	chatOf(conversationId: number | string): Promise<string | null>;
	principalOf(chat: string | null): Promise<Principal | undefined>;
};

type Row = { id: string; name: string; url: string | null; status: string; credential: string | null };

export function watchTools(deps: WatchToolDeps): ToolRegistration[] {
	const { ownerId } = deps;
	const noApp = () => text("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot do that.", true);
	/** The connectors an agent can ask for events: MCP servers that are connected. */
	const servers = async (w: WatchDeps): Promise<Row[]> => (await w.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id, name, url, status, credential FROM pim_app.connectors WHERE url IS NOT NULL AND status = 'connected' ORDER BY created_at")).rows)) as Row[];

	const listEventsTool = defineTool({
		name: "list_connector_events",
		description: "List the events connected connectors can notify you about, with the arguments each accepts.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			const w = deps.watch();
			if (!w) return noApp();
			const out: unknown[] = [];
			await Promise.all((await servers(w)).map(async (c) => {
				try {
					const full = await connectorOf(w.app, ownerId, c.id);
					for (const e of await connectorSession(w, ownerId, full!, (rpc) => listEvents(rpc))) out.push({ connector: c.id, service: c.name, event: e.name, description: e.description, arguments: e.inputSchema ?? {} });
				} catch {
					// A server without events, or one that cannot be reached now, offers none.
				}
			}));
			return json(out);
		},
	} as never) as unknown as ToolRegistration;

	const watchEvent = defineTool({
		name: "watch_connector_event",
		description: `Have a connected connector notify you whenever an event happens (see list_connector_events), and say what to do each time. Each event arrives as a message starting with "[Connector event]". Subscribing needs no approval; what you do when an event arrives is still subject to the usual approvals.`,
		parameters: Type.Object({
			connector: Type.String({ description: "The connector's id, as list_connector_events shows it." }),
			event: Type.String(),
			arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Filters the event accepts." })),
			instruction: Type.String({ minLength: 1, description: "What to do each time it fires, written to your future self." }),
		}),
		// A watch with the same connector, event, arguments, chat and instruction is the one already made, so a replay makes nothing new.
		replay: "safe",
		async execute(a: { connector: string; event: string; arguments?: Record<string, unknown>; instruction: string }, api: any) {
			const w = deps.watch();
			if (!w) return noApp();
			const chat = await deps.chatOf(api.conversationId);
			const p = await deps.principalOf(chat);
			if (!p || !chat) return text("Watches belong to a chat, and this is not one.", true);
			const refused = (why: string, name = a.connector) => text(`Could not watch ${name} for "${a.event}": ${why}`, true);
			const c = await connectorOf(w.app, ownerId, a.connector);
			if (!c?.url || c.status !== "connected") return text(`No connected connector ${a.connector}. See list_connector_events.`, true);
			let events;
			try {
				events = await connectorSession(w, ownerId, c, (rpc) => listEvents(rpc));
			} catch (error) {
				return refused(`${c.name} could not be asked for its events (${error instanceof Error ? error.message : "no answer"}).`, c.name);
			}
			if (!events.some((e) => e.name === a.event)) return text(`${c.name} has no event named ${a.event}. See list_connector_events.`, true);
			if (!w.publicUrl) return refused("pim does not know its public URL yet; set PIM_PUBLIC_URL.", c.name);
			const args = a.arguments ?? {};
			const existing = await w.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT s.trigger_id FROM pim_app.watch_subscriptions s JOIN pim_app.triggers t ON t.id = s.trigger_id WHERE s.connector_id = $1 AND s.event = $2 AND s.arguments = $3::jsonb AND t.origin_chat = $4 AND t.spec->>'instruction' = $5 AND t.lifecycle = 'enabled' AND s.status <> 'ended'", [c.id, a.event, JSON.stringify(args), chat, a.instruction])).rows[0]?.trigger_id as string | undefined);
			if (existing) return text(`Watching ${c.name} for "${a.event}" (watch ${existing}). Each event will arrive here as a message starting with "[Connector event]".`);
			const label = `${c.name}: ${a.event}`;
			let id: string;
			try {
				const made = await w.app.triggers.create(p, { spec: { version: 1, owningAgentId: p.kind === "agent" ? p.agentId : "pim", originChatId: chat, label: label.length > 120 ? `${label.slice(0, 119)}…` : label, instruction: a.instruction, source: { kind: "connector_event", connectorId: c.id, event: a.event, arguments: args }, destination: { type: "existing_chat", chatId: chat } } });
				id = made.id;
			} catch (error) {
				if (error instanceof BadRequestError) return refused(error.message, c.name);
				throw error;
			}
			const { sealed } = await newWatchSecret(w, ownerId, id);
			await w.app.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.watch_subscriptions (owner_id, trigger_id, connector_id, event, arguments, secret) VALUES ($1,$2,$3,$4,$5,$6)", [ownerId, id, c.id, a.event, JSON.stringify(args), sealed]));
			const undo = async () => {
				await w.app.db.owner(ownerId, (tx) => tx.query("DELETE FROM pim_app.watch_subscriptions WHERE trigger_id = $1", [id]));
				await w.app.triggers.setLifecycle(p, id, "deleted").catch(() => undefined);
			};
			try {
				const row = (await w.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT trigger_id, connector_id, event, arguments, secret, cursor FROM pim_app.watch_subscriptions WHERE trigger_id = $1", [id])).rows[0]))!;
				// Subscribed now, so the server's answer is this call's. The webhook is verified with the watch's own secret.
				const r = await subscribe(w, ownerId, row);
				if (!r.ok) return (await undo(), refused(`the connector did not take the subscription (${r.error}).`, c.name));
			} catch (error) {
				await undo();
				return refused(`${c.name} did not answer (${error instanceof Error ? error.message : "no answer"}).`, c.name);
			}
			await w.app.triggers.setLifecycle(p, id, "enabled");
			return text(`Watching ${c.name} for "${a.event}" (watch ${id}). Each event will arrive here as a message starting with "[Connector event]".`);
		},
	} as never) as unknown as ToolRegistration;

	const listWatches = defineTool({
		name: "list_watches",
		description: "List your connector event watches and their state.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			const w = deps.watch();
			if (!w) return json([]);
			const rows = await w.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT s.trigger_id, s.connector_id, s.event, s.arguments, s.status, s.last_error, s.last_event_at, s.renew_before, t.lifecycle, t.origin_chat, t.spec->>'instruction' AS instruction, c.name AS service FROM pim_app.watch_subscriptions s JOIN pim_app.triggers t ON t.id = s.trigger_id LEFT JOIN pim_app.connectors c ON c.id = s.connector_id WHERE t.lifecycle <> 'deleted' ORDER BY s.created_at")).rows);
			return json(rows.map((r) => ({ id: r.trigger_id, app: r.service ?? r.connector_id, event: r.event, arguments: r.arguments, instruction: r.instruction, session: r.origin_chat, status: r.lifecycle === "enabled" ? r.status : r.lifecycle, lastError: r.last_error, lastEventAt: iso(r.last_event_at), renewsBefore: iso(r.renew_before) })));
		},
	} as never) as unknown as ToolRegistration;

	const stopWatch = defineTool({
		name: "stop_watch",
		description: "Stop a connector event watch by its id.",
		parameters: Type.Object({ id: Type.String() }),
		replay: "safe",
		async execute(a: { id: string }, api: any) {
			const w = deps.watch();
			const missing = text(`No watch with id ${a.id}.`, true);
			if (!w) return missing;
			const row = await w.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT trigger_id, connector_id, event, arguments, secret, cursor FROM pim_app.watch_subscriptions WHERE trigger_id = $1", [a.id])).rows[0]);
			if (!row) return missing;
			const p = await deps.principalOf(await deps.chatOf(api.conversationId));
			if (!p) return missing;
			// Unsubscribed while the connector can still be asked, then the trigger goes.
			await unsubscribe(w, ownerId, row);
			await w.app.triggers.setLifecycle(p, a.id, "deleted").catch(() => undefined);
			await w.app.db.owner(ownerId, (tx) => tx.query("DELETE FROM pim_app.watch_subscriptions WHERE trigger_id = $1", [a.id]));
			return text("Stopped.");
		},
	} as never) as unknown as ToolRegistration;

	return [listEventsTool, watchEvent, listWatches, stopWatch];
}
