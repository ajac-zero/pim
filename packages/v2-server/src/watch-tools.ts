/**
 * The connector-event half of the agent's `trigger` tool, ported from v1's `src/extensions/app-events.ts`: what a connected server can tell an agent about (`events`), hearing of one
 * (`start`: a trigger on the connector's event with a subscription at the server, `watches.ts`), how each watch stands (`info`), and stopping one (`stop`). Each event arrives as a
 * message that starts with "[Connector event]". Subscribing needs no approval; what the agent then does is still subject to the usual approvals.
 */
import type { TriggerSpec } from "@pim/triggers/spec";
import type { Principal } from "@pim/v2-contracts/identity";
import { BadRequestError } from "@pim/v2-app/errors";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { chatApps, listsConnector } from "./connector-tools.ts";
import { connectorOf, connectorSession, listEvents, newWatchSecret, subscribe, unsubscribe, type WatchDeps } from "./watches.ts";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export type WatchToolDeps = {
	ownerId: string;
	runtime: RuntimeDb;
	/** The application, keys and transport, as the Runner has them; absent where the Runner has no application database. */
	watch: () => WatchDeps | undefined;
};

type Row = { id: string; name: string; url: string | null; status: string; credential: string | null; app_ref: string | null };

/** How a watch stands at its connector, as `trigger` shows it beside the trigger. */
export type WatchInfo = { service: string; status: string; lastError: string | null; lastEventAt: string | null; renewsBefore: string | null };

export function watchOps(deps: WatchToolDeps) {
	const { ownerId } = deps;
	/** The connectors an agent can ask for events: MCP servers that are connected. */
	const servers = async (w: WatchDeps): Promise<Row[]> => (await w.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id, name, url, status, credential, app_ref FROM pim_app.connectors WHERE url IS NOT NULL AND status = 'connected' ORDER BY created_at")).rows)) as Row[];
	/** Whether the chat's agent works with the connector: the connectors an agent lists are the only ones it may hear events of, as in v1. */
	const works = async (chat: string | null, c: { id: string; name: string; app_ref?: string | null }) => listsConnector((await chatApps(deps.runtime, ownerId, chat)).apps, { id: c.id, name: c.name, appRef: c.app_ref ?? null });

	return {
		available: () => deps.watch() !== undefined,

		/** The events the connectors the chat's agent works with can notify it about, with the arguments each accepts. */
		async events(chat: string | null): Promise<unknown[]> {
			const w = deps.watch();
			if (!w) return [];
			const out: unknown[] = [];
			const apps = (await chatApps(deps.runtime, ownerId, chat)).apps;
			await Promise.all((await servers(w)).filter((c) => listsConnector(apps, { id: c.id, name: c.name, appRef: c.app_ref })).map(async (c) => {
				try {
					const full = await connectorOf(w.app, ownerId, c.id);
					for (const e of await connectorSession(w, ownerId, full!, (rpc) => listEvents(rpc))) out.push({ connector: c.id, service: c.name, event: e.name, description: e.description, arguments: e.inputSchema ?? {} });
				} catch {
					// A server without events, or one that cannot be reached now, offers none.
				}
			}));
			return out;
		},

		/**
		 * Makes the watch `spec` describes (its source is a connector event): checks the connector is one the chat's agent works with and offers the event, makes the trigger, subscribes at the
		 * server and enables it. A watch with the same connector, event, arguments, chat and instruction is the one already made, so a replay makes nothing new.
		 */
		async start(p: Principal, chat: string | null, spec: TriggerSpec, key: string): Promise<Result> {
			const w = deps.watch();
			if (!w) return text("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot do that.", true);
			const source = spec.source;
			if (source.kind !== "connector_event") throw new Error("A watch is a connector event");
			if (!chat) return text("Watches belong to a chat, and this is not one.", true);
			const refused = (why: string, name = source.connectorId) => text(`Could not watch ${name} for "${source.event}": ${why}`, true);
			const c = await connectorOf(w.app, ownerId, source.connectorId);
			if (!c?.url || c.status !== "connected" || !(await works(chat, c))) return text(`No connector named ${source.connectorId} among the connectors you work with. See trigger(action: "sources", kind: "connector_event").`, true);
			let events;
			try {
				events = await connectorSession(w, ownerId, c, (rpc) => listEvents(rpc));
			} catch (error) {
				return refused(`${c.name} could not be asked for its events (${error instanceof Error ? error.message : "no answer"}).`, c.name);
			}
			if (!events.some((e) => e.name === source.event)) return text(`${c.name} has no event named ${source.event}. See trigger(action: "sources", kind: "connector_event").`, true);
			if (!w.publicUrl) return refused("pim does not know its public URL yet; set PIM_PUBLIC_URL.", c.name);
			const args = source.arguments ?? {};
			const said = (id: string) => text(`Watching ${c.name} for "${source.event}" (watch ${id}). Each event will arrive as a message starting with "[Connector event]".`);
			const existing = await w.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT s.trigger_id FROM pim_app.watch_subscriptions s JOIN pim_app.triggers t ON t.id = s.trigger_id WHERE s.connector_id = $1 AND s.event = $2 AND s.arguments = $3::jsonb AND t.origin_chat = $4 AND t.spec->>'instruction' = $5 AND t.lifecycle = 'enabled' AND s.status <> 'ended'", [c.id, source.event, JSON.stringify(args), chat, spec.instruction])).rows[0]?.trigger_id as string | undefined);
			if (existing) return said(existing);
			const label = spec.label || `${c.name}: ${source.event}`;
			let id: string;
			try {
				const made = await w.app.triggers.create(p, { spec: { ...spec, label: label.length > 120 ? `${label.slice(0, 119)}…` : label }, key });
				id = made.id;
			} catch (error) {
				if (error instanceof BadRequestError) return refused(error.message, c.name);
				throw error;
			}
			const { sealed } = await newWatchSecret(w, ownerId, id);
			await w.app.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.watch_subscriptions (owner_id, trigger_id, connector_id, event, arguments, secret) VALUES ($1,$2,$3,$4,$5,$6)", [ownerId, id, c.id, source.event, JSON.stringify(args), sealed]));
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
			await w.app.triggers.setHealth(ownerId, id, "healthy", null, ["unknown"]);
			return said(id);
		},

		/** How each of these triggers stands at its connector, by trigger id; triggers that are no watch are left out. */
		async info(ids: readonly string[]): Promise<Map<string, WatchInfo>> {
			const w = deps.watch();
			if (!w || ids.length === 0) return new Map();
			const rows = await w.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT s.trigger_id, s.connector_id, s.status, s.last_error, s.last_event_at, s.renew_before, t.lifecycle, c.name AS service FROM pim_app.watch_subscriptions s JOIN pim_app.triggers t ON t.id = s.trigger_id LEFT JOIN pim_app.connectors c ON c.id = s.connector_id WHERE s.trigger_id = ANY($1::text[])", [ids])).rows);
			return new Map(rows.map((r) => [r.trigger_id as string, { service: r.service ?? r.connector_id, status: r.lifecycle === "enabled" ? r.status : r.lifecycle, lastError: r.last_error, lastEventAt: iso(r.last_event_at), renewsBefore: iso(r.renew_before) }]));
		},

		/** Unsubscribes the trigger's watch, while the connector can still be asked, and removes it. Does nothing for a trigger that is no watch. */
		async stop(id: string): Promise<void> {
			const w = deps.watch();
			if (!w) return;
			const row = await w.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT trigger_id, connector_id, event, arguments, secret, cursor FROM pim_app.watch_subscriptions WHERE trigger_id = $1", [id])).rows[0]);
			if (!row) return;
			await unsubscribe(w, ownerId, row);
			await w.app.db.owner(ownerId, (tx) => tx.query("DELETE FROM pim_app.watch_subscriptions WHERE trigger_id = $1", [id]));
		},
	};
}

export type WatchOps = ReturnType<typeof watchOps>;
