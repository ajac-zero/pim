/**
 * Watches: an agent asks to hear of one event type of a connected MCP server (the draft MCP Events extension, webhook delivery). A watch is a trigger on a connector's event
 * (`source.kind = 'connector_event'`) with a subscription at the server (`pim_app.watch_subscriptions`, migration 0641). This file is the part both the Runner's tools
 * (`watch-tools.ts`), the Gate (which receives each signed delivery) and the maintenance role (which renews grants that are running out) share:
 *
 *  - `connectorSession`: the owner's connector, called over MCP with its credential opened and, for an OAuth one, renewed;
 *  - `subscribe` / `unsubscribe`: `events/subscribe` and `events/unsubscribe` with this watch's callback address and secret, which a server treats as idempotent;
 *  - `receiveWatchEvent`: a delivery at `/mcp/events/<owner>/<key>`, verified (Standard Webhooks, the watch's own secret), deduplicated by its event id, and handed to the triggers watching it;
 *  - `renewDue`: subscribes again before a grant runs out.
 *
 * Deliveries that carry no Standard Webhooks headers are the generic connector webhook (`Connectors.receiveEvent`, HMAC under the connector's own secret), which is still served.
 */
import type { Pool } from "pg";
import type { App } from "@pim/v2-app/app";
import { openString, sealString } from "@pim/v2-app/crypto";
import type { EnvelopeCrypto } from "@pim/v2-contracts/platform";
import type { TriggerHealth } from "@pim/triggers/spec";
import { newSecret, verifyWebhook } from "@pim/shared/webhook";
import { AuthRefused } from "./native/http.ts";
import { appStore, CredentialRenewals } from "./connector-credential.ts";
import { McpAuthError, type Transport, withSession } from "./connector-tools.ts";

export type WatchDeps = { app: App; crypto: EnvelopeCrypto; transport: Transport; publicUrl: string | undefined; now: () => number };

/** How long a grant is asked for. A server may give less; the sweep renews before it runs out. */
export const GRANT_MS = 7 * 86_400_000;
/** Renew this long before a grant runs out. */
export const RENEW_MARGIN_MS = 10 * 60_000;

export type Rpc = (method: string, params?: unknown) => Promise<any>;

type ConnectorRecord = { id: string; name: string; url: string | null; status: string; credential: string | null; event_key: string; app_ref?: string | null };

export async function connectorOf(app: App, ownerId: string, id: string): Promise<ConnectorRecord | undefined> {
	return app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id, name, url, status, credential, event_key, app_ref FROM pim_app.connectors WHERE id = $1", [id])).rows[0] as ConnectorRecord | undefined);
}

/** The owner's connector, called over MCP: its credential opened with the key ring, an OAuth one renewed when it is about to expire or the server refuses it (`connector-credential.ts`). */
export async function connectorSession<T>(deps: WatchDeps, ownerId: string, c: ConnectorRecord, run: (rpc: Rpc) => Promise<T>): Promise<T> {
	if (!c.url) throw new Error(`${c.name} is not an MCP server.`);
	const renewals = new CredentialRenewals({ crypto: deps.crypto, store: appStore(deps.app), fetch: deps.transport.fetch, now: deps.now });
	const first = await renewals.open(ownerId, c);
	try {
		return await withSession(deps.transport, c.url, first.bearer, run, 30_000);
	} catch (error) {
		if (!(error instanceof McpAuthError || error instanceof AuthRefused)) throw error;
		return withSession(deps.transport, c.url, (await renewals.open(ownerId, { ...c, credential: first.sealed }, true)).bearer, run, 30_000);
	}
}

export type EventType = { name: string; description: string; inputSchema?: Record<string, unknown> };

/** The event types a server offers by webhook (`events/list`); a server without the extension has none. */
export async function listEvents(rpc: Rpc): Promise<EventType[]> {
	const events: EventType[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 10; page++) {
		const r = await rpc("events/list", cursor ? { cursor } : {});
		for (const e of r?.events ?? []) {
			if (typeof e?.name === "string" && Array.isArray(e.delivery) && e.delivery.includes("webhook")) events.push({ name: e.name, description: typeof e.description === "string" ? e.description : "", ...(e.inputSchema && typeof e.inputSchema === "object" ? { inputSchema: e.inputSchema } : {}) });
		}
		cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
		if (!cursor) break;
	}
	return events;
}

type Watch = { trigger_id: string; connector_id: string; event: string; arguments: Record<string, unknown>; secret: string; cursor: string | null };

const callbackOf = (deps: WatchDeps, ownerId: string, c: ConnectorRecord) => `${(deps.publicUrl ?? "").replace(/\/$/, "")}/mcp/events/${ownerId}/${c.event_key}`;

/**
 * Asks the server to deliver this watch's events (again: the draft makes it idempotent over the callback, the event and its arguments, so renewing is the same request). Records what it
 * answered: the subscription's id and when the grant runs out. A refusal says what the trigger's health is (`health`) and whether it is for good (`final`: the watch ends with the reason);
 * a connector the server no longer accepts the sign-in of waits for it to be signed in again instead; anything else (the server not answering) is thrown for the caller to settle.
 */
export async function subscribe(deps: WatchDeps, ownerId: string, w: Watch): Promise<{ ok: true; renewBefore: Date | null } | { ok: false; error: string; health: TriggerHealth; final: boolean }> {
	const c = await connectorOf(deps.app, ownerId, w.connector_id);
	if (!c) return { ok: false, error: "The connector was removed.", health: "configuration_error", final: true };
	if (!deps.publicUrl) return { ok: false, error: "Pim does not know its public address (PIM_PUBLIC_URL), so a server cannot call it back.", health: "configuration_error", final: true };
	if (c.status !== "connected") return { ok: false, error: c.status === "auth_required" ? "The connector needs signing in again." : "The connector is not connected.", health: c.status === "auth_required" ? "auth_required" : "reconnecting", final: false };
	const secret = await openString(deps.crypto, w.secret, `watch:${ownerId}/${w.trigger_id}`);
	let answer: any;
	try {
		answer = await connectorSession(deps, ownerId, c, (rpc) => rpc("events/subscribe", { name: w.event, arguments: w.arguments, delivery: { mode: "webhook", url: callbackOf(deps, ownerId, c), secret }, cursor: w.cursor, ttlMs: GRANT_MS }));
	} catch (error) {
		if (error instanceof McpAuthError || error instanceof AuthRefused) return { ok: false, error: "The server no longer accepts the connector's sign-in.", health: "auth_required", final: false };
		// A refusal of the request itself (an unknown event, bad arguments) is the server's answer; no answer at all is for the caller.
		if (error instanceof Error && /^The server answered|did not answer|reply held|could not|timed out|aborted|fetch failed/i.test(error.message)) throw error;
		return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "The server refused the subscription.", health: "configuration_error", final: true };
	}
	const refreshBefore = answer?.refreshBefore;
	const renewBefore = typeof refreshBefore === "number" ? new Date(refreshBefore) : typeof refreshBefore === "string" && !Number.isNaN(Date.parse(refreshBefore)) ? new Date(refreshBefore) : new Date(deps.now() + GRANT_MS);
	await deps.app.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.watch_subscriptions SET status = 'active', provider_id = $3, renew_before = $4, last_error = NULL WHERE owner_id = $1 AND trigger_id = $2", [ownerId, w.trigger_id, typeof answer?.id === "string" ? answer.id.slice(0, 256) : null, renewBefore]));
	// The server took it: whatever was wrong with reaching it is over, and the backoff starts again.
	await deps.app.triggers.noteObservation(ownerId, w.trigger_id, "observed", new Date(deps.now()));
	await deps.app.triggers.setHealth(ownerId, w.trigger_id, "healthy", null, ["unknown", "reconnecting", "auth_required"]);
	return { ok: true, renewBefore };
}

export async function unsubscribe(deps: WatchDeps, ownerId: string, w: Watch): Promise<void> {
	const c = await connectorOf(deps.app, ownerId, w.connector_id);
	if (!c || !c.url || !deps.publicUrl) return;
	// Best effort: the watch is gone either way, and a delivery for it is refused.
	await connectorSession(deps, ownerId, c, (rpc) => rpc("events/unsubscribe", { name: w.event, arguments: w.arguments, delivery: { url: callbackOf(deps, ownerId, c) } })).catch(() => undefined);
}

export const newWatchSecret = async (deps: WatchDeps, ownerId: string, triggerId: string) => {
	const secret = newSecret();
	return { secret, sealed: await sealString(deps.crypto, secret, `watch:${ownerId}/${triggerId}`) };
};

/**
 * Records, on the watch and on its trigger, why the server could not be asked or refused: a final refusal ends the watch, and any other trouble is tried again with the trigger's own
 * backoff (half a minute, doubling to a quarter of an hour), so the Triggers screen and `get_trigger` say what is wrong instead of an enabled trigger that never hears anything.
 */
async function troubled(deps: WatchDeps, owner: string, trigger: string, trouble: { error: string; health: TriggerHealth; final: boolean }): Promise<void> {
	await deps.app.db.owner(owner, (tx) => tx.query("UPDATE pim_app.watch_subscriptions SET status = CASE WHEN $3 THEN 'ended' ELSE status END, last_error = $4 WHERE owner_id = $1 AND trigger_id = $2", [owner, trigger, trouble.final, trouble.error]));
	await deps.app.triggers.setHealth(owner, trigger, trouble.health, trouble.error.slice(0, 200));
	if (!trouble.final) await deps.app.triggers.noteObservation(owner, trigger, "failed", new Date(deps.now()));
}

const noAnswer = (what: string, error: unknown) => ({ error: `${what} failed: ${error instanceof Error ? error.message.slice(0, 200) : "no answer"}`, health: "reconnecting" as TriggerHealth, final: false });

/** Subscribes again those grants that run out within the margin, across owners. Returns how many were renewed. */
export async function renewDue(deps: WatchDeps, pool: Pool): Promise<number> {
	const client = await pool.connect();
	let due: { owner_id: string; trigger_id: string }[];
	try {
		await client.query("BEGIN");
		await client.query("SELECT set_config('pim.scope', 'all', true)");
		due = (await client.query("SELECT s.owner_id, s.trigger_id FROM pim_app.watch_subscriptions s JOIN pim_app.triggers t ON t.owner_id = s.owner_id AND t.id = s.trigger_id AND t.lifecycle = 'enabled' WHERE s.status = 'active' AND s.renew_before IS NOT NULL AND s.renew_before <= $1 AND (t.retry_after IS NULL OR t.retry_after <= $2) LIMIT 100", [new Date(deps.now() + RENEW_MARGIN_MS), new Date(deps.now())])).rows;
		await client.query("COMMIT");
	} finally {
		client.release();
	}
	let renewed = 0;
	for (const { owner_id: owner, trigger_id: trigger } of due) {
		const w = await deps.app.db.owner(owner, async (tx) => (await tx.query("SELECT trigger_id, connector_id, event, arguments, secret, cursor FROM pim_app.watch_subscriptions WHERE trigger_id = $1", [trigger])).rows[0] as Watch | undefined);
		if (!w) continue;
		try {
			const r = await subscribe(deps, owner, w);
			if (r.ok) renewed++;
			else await troubled(deps, owner, trigger, r);
		} catch (error) {
			// The server did not answer: it is tried again after a backoff, and the reason is kept for whoever lists the watch and on the trigger.
			await troubled(deps, owner, trigger, noAnswer("Renewing", error));
		}
	}
	return renewed;
}

/**
 * Makes the subscriptions at the servers match the triggers, whichever way a trigger was made or changed: an enabled connector-event trigger has one, and one whose trigger is paused,
 * ended, deleted (by itself or with its chat or its connector) or changed to another event or arguments has none, so nothing is renewed for ever for a trigger that is gone. A trigger that
 * a `trigger` call with a connector event made has its subscription at once; this is for the rest (the Triggers screen, `resume`) and for what a failure left half done.
 */
export async function reconcileWatches(deps: WatchDeps, pool: Pool): Promise<number> {
	const client = await pool.connect();
	let stale: { owner_id: string; trigger_id: string }[];
	let missing: { owner_id: string; id: string; spec: { source?: { connectorId?: string; event?: string; arguments?: Record<string, unknown> } } }[];
	let pending: { owner_id: string; trigger_id: string }[];
	try {
		await client.query("BEGIN");
		await client.query("SELECT set_config('pim.scope', 'all', true)");
		stale = (await client.query(
			`SELECT s.owner_id, s.trigger_id FROM pim_app.watch_subscriptions s LEFT JOIN pim_app.triggers t ON t.owner_id = s.owner_id AND t.id = s.trigger_id
			 WHERE t.id IS NULL OR t.lifecycle <> 'enabled' OR t.source <> 'connector_event' OR t.spec->'source'->>'connectorId' <> s.connector_id OR t.spec->'source'->>'event' <> s.event OR coalesce(t.spec->'source'->'arguments', '{}'::jsonb) <> s.arguments LIMIT 100`,
		)).rows;
		missing = (await client.query(
			`SELECT t.owner_id, t.id, t.spec FROM pim_app.triggers t LEFT JOIN pim_app.watch_subscriptions s ON s.owner_id = t.owner_id AND s.trigger_id = t.id
			 WHERE t.lifecycle = 'enabled' AND t.source = 'connector_event' AND s.trigger_id IS NULL LIMIT 50`,
		)).rows;
		// A subscription the server never answered (it was down, or the tool died between its two steps) is asked for again after a minute.
		pending = (await client.query("SELECT s.owner_id, s.trigger_id FROM pim_app.watch_subscriptions s LEFT JOIN pim_app.triggers t ON t.owner_id = s.owner_id AND t.id = s.trigger_id WHERE s.status = 'pending' AND s.created_at < $1 AND (t.retry_after IS NULL OR t.retry_after <= $2) LIMIT 50", [new Date(deps.now() - 60_000), new Date(deps.now())])).rows;
		await client.query("COMMIT");
	} finally {
		client.release();
	}
	const watchOf = (owner: string, trigger: string) => deps.app.db.owner(owner, async (tx) => (await tx.query("SELECT trigger_id, connector_id, event, arguments, secret, cursor FROM pim_app.watch_subscriptions WHERE trigger_id = $1", [trigger])).rows[0] as Watch | undefined);
	let changed = 0;
	for (const { owner_id: owner, trigger_id: trigger } of stale) {
		const w = await watchOf(owner, trigger);
		if (!w) continue;
		await unsubscribe(deps, owner, w).catch(() => undefined);
		await deps.app.db.owner(owner, (tx) => tx.query("DELETE FROM pim_app.watch_subscriptions WHERE trigger_id = $1", [trigger]));
		changed++;
	}
	for (const t of missing) {
		const source = t.spec.source ?? {};
		if (!source.connectorId || !source.event) continue;
		const { sealed } = await newWatchSecret(deps, t.owner_id, t.id);
		const made = await deps.app.db.owner(t.owner_id, async (tx) => !!(await tx.query("INSERT INTO pim_app.watch_subscriptions (owner_id, trigger_id, connector_id, event, arguments, secret) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [t.owner_id, t.id, source.connectorId, source.event, JSON.stringify(source.arguments ?? {}), sealed])).rowCount);
		if (made) pending.push({ owner_id: t.owner_id, trigger_id: t.id });
	}
	for (const { owner_id: owner, trigger_id: trigger } of pending) {
		const w = await watchOf(owner, trigger);
		if (!w) continue;
		try {
			const r = await subscribe(deps, owner, w);
			if (!r.ok) await troubled(deps, owner, trigger, r);
			changed++;
		} catch (error) {
			await troubled(deps, owner, trigger, noAnswer("Subscribing", error));
		}
	}
	return changed;
}

// ---- deliveries ----

export type Delivery = { status: number; body?: unknown };

const refused = (status: number, reason: string): Delivery => ({ status, body: { error: reason } });

/**
 * One signed delivery for the connector at `key`. Who it is for comes from the route and the signature alone: it must verify under the secret of one of that connector's
 * watches (and, once the server has named its subscription, carry that id). Then, by its envelope: a verification is answered with its challenge; an event (whose
 * `webhook-id` must equal its `eventId`) fires the triggers watching that event once however often it is retried; a gap or the server ending the subscription is recorded on the watch.
 */
export async function receiveWatchEvent(deps: WatchDeps, ownerId: string, key: string, headers: Headers, raw: Uint8Array): Promise<Delivery> {
	const found = await deps.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.connectors WHERE event_key = $1", [key])).rows[0]?.id as string | undefined);
	if (!found) return refused(401, "Unknown connector");
	const watches = await deps.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT trigger_id, connector_id, event, arguments, secret, cursor, provider_id, status FROM pim_app.watch_subscriptions WHERE connector_id = $1 AND status <> 'ended'", [found])).rows as (Watch & { provider_id: string | null; status: string })[]);
	let body: string;
	try {
		body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
	} catch {
		return refused(400, "The body is not UTF-8");
	}
	const sub = headers.get("x-mcp-subscription-id");
	let matched: (typeof watches)[number] | undefined;
	for (const w of watches) {
		if (w.provider_id !== null && sub !== null && sub !== w.provider_id) continue;
		if (await verifyWebhook(await openString(deps.crypto, w.secret, `watch:${ownerId}/${w.trigger_id}`), headers, body, Math.floor(deps.now() / 1000)).catch(() => false)) {
			matched = w;
			break;
		}
	}
	if (!matched) return refused(401, "Bad signature");
	await deps.app.identity.authz.requireLive(ownerId, "connector-event");
	let envelope: any;
	try {
		envelope = JSON.parse(body);
	} catch {
		return refused(400, "The body is not JSON");
	}
	const touch = (set: string, ...values: unknown[]) => deps.app.db.owner(ownerId, (tx) => tx.query(`UPDATE pim_app.watch_subscriptions SET ${set} WHERE owner_id = $1 AND trigger_id = $2`, [ownerId, matched!.trigger_id, ...values]));
	switch (envelope?.type) {
		case "verification":
			return typeof envelope.challenge === "string" ? { status: 200, body: { challenge: envelope.challenge } } : refused(400, "No challenge");
		case "gap":
			await touch("last_error = 'The server reported events it could not replay.'");
			await deps.app.triggers.setHealth(ownerId, matched.trigger_id, "gap", "events_missed");
			return { status: 204 };
		case "terminated": {
			const reason = `The server ended the subscription (code ${Number(envelope.error?.code) || 0}); watch again to resume.`;
			await touch("status = 'ended', last_error = $3", reason);
			await deps.app.triggers.setHealth(ownerId, matched.trigger_id, "configuration_error", reason.slice(0, 200));
			return { status: 204 };
		}
		case undefined: {
			if (typeof envelope?.eventId !== "string" || typeof envelope.name !== "string" || envelope.data === null || typeof envelope.data !== "object") return refused(400, "Not an event");
			if (headers.get("webhook-id") !== envelope.eventId) return refused(400, "The webhook id is not the event's id");
			// The delivery belongs to the watch whose secret signed it: a server that gives two watches the same event id delivers it once to each, and nothing here fires another watch's trigger.
			const fresh = await deps.app.db.owner(ownerId, async (tx) => !!(await tx.query("INSERT INTO pim_app.connector_events (owner_id, connector_id, delivery_id, payload, received_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING", [ownerId, found, `${matched!.trigger_id}:${envelope.eventId}`, JSON.stringify(envelope.data)])).rowCount);
			if (fresh && envelope.name === matched.event) await deps.app.triggers.fireConnectorEvent(ownerId, found, envelope.name, envelope.data, envelope.eventId, matched.trigger_id);
			await deps.app.triggers.setHealth(ownerId, matched.trigger_id, "healthy", null, ["unknown", "gap", "reconnecting", "auth_required"]);
			await touch("last_event_at = now(), cursor = coalesce($3, cursor), last_error = NULL", typeof envelope.cursor === "string" ? envelope.cursor.slice(0, 512) : null);
			return { status: 204 };
		}
		default:
			return refused(400, "Unsupported delivery");
	}
}
