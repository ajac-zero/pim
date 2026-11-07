/**
 * Keeping connector events' subscriptions: an inert manager that makes the
 * bindings the ingress adapter (./connector.ts) reads, subscribes each one
 * with its connector, and keeps it renewed while its trigger is enabled,
 * through a provider it is given. Nothing constructs it: no route, tool,
 * alarm, MCP bridge or engine reaches it, and connector watches
 * (../extensions/app-events.ts) work exactly as before. See "Keeping the
 * subscription" in docs/triggers.md.
 *
 * A binding is one trigger at one generation and source revision, with a
 * callback key and a Standard Webhooks secret made once, when the binding
 * is, and never changed: every request for it names the same callback URL,
 * which the draft MCP Events extension keys a subscription by. A pause, an
 * edit of the source or condition, or a deletion starts a new generation,
 * so the binding goes stale; it is revoked and unsubscribed (or left to
 * lapse), and enabling the trigger again makes a new binding.
 *
 * Each request to the connector is recorded as an intent, in a transaction,
 * before it is sent, and its answer as the receipt, in another, after. An
 * intent with no receipt (a crash, no answer by its deadline, an answer it
 * can't read) is settled by sending the same request again, which the
 * draft makes idempotent over the callback URL, never by a new binding: so
 * a connector holds at most one subscription per binding. The intent is
 * also the binding's lease: while one is out, no other tick, and no
 * manager made again after a restart, sends anything for that binding
 * until its deadline.
 *
 * The callback URL and the secret are never in an error, a log, a report
 * or the export: errors are kept as fixed words and codes, never a
 * provider's text, and the export leaves out the key and the secret.
 */

import { newSecret as makeSecret } from "../extensions/app-events";
import {
	type ConnectorIngressHost,
	type ConnectorStatus,
	type ConnectorSubscription,
	EFFECT_DEADLINE_MS,
	type SubscriptionGrant,
	type SubscriptionIntent,
	renewalDecision,
} from "./connector";
import type { ConnectorEventSource } from "./spec";
import type { TriggerStore } from "./store";
import { type JsonObject, integer } from "./validate";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_trigger_subscriptions (
	key TEXT PRIMARY KEY,
	trigger_id TEXT NOT NULL,
	source_revision INTEGER NOT NULL,
	generation INTEGER NOT NULL,
	connector_id TEXT NOT NULL,
	event TEXT NOT NULL,
	secret TEXT NOT NULL,
	status TEXT NOT NULL,
	phase TEXT NOT NULL,
	provider_subscription_id TEXT,
	granted_at INTEGER,
	refresh_before INTEGER,
	intent_id TEXT,
	intent_kind TEXT,
	intent_state TEXT,
	intent_sent_at INTEGER,
	intent_token TEXT,
	intent_cursor TEXT,
	failures INTEGER NOT NULL,
	next_at INTEGER,
	last_error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	ended_at INTEGER,
	UNIQUE (trigger_id, generation)
);
CREATE INDEX IF NOT EXISTS pim_trigger_subscriptions_by_next ON pim_trigger_subscriptions (phase, next_at);
CREATE TRIGGER IF NOT EXISTS pim_trigger_subscriptions_pinned BEFORE UPDATE OF key, trigger_id, source_revision, generation, connector_id, event ON pim_trigger_subscriptions
BEGIN SELECT RAISE(ABORT, 'a binding keeps its key, trigger, generation and event'); END;
CREATE TRIGGER IF NOT EXISTS pim_trigger_subscriptions_secret BEFORE UPDATE OF secret ON pim_trigger_subscriptions WHEN NEW.secret != ''
BEGIN SELECT RAISE(ABORT, 'a binding keeps its secret until it is wiped'); END;
`;

/** The manager's tables, beside the engine's. Pim makes none of them yet. */
export const SUBSCRIPTION_TABLES = ["pim_trigger_subscriptions"] as const;

/** Columns the export leaves out: the callback's key, which is the last segment of its URL, and the secret. */
export const SUBSCRIPTION_PRIVATE_COLUMNS = ["key", "secret"] as const;

/** The subscription's lifetime asked for; the connector grants the real one. As app-events.ts asks. */
export const SUBSCRIPTION_TTL_MS = 60 * 60_000;

/**
 * Codes after which a subscription is gone for good, as app-events.ts treats
 * them: not found, forbidden, unsupported. Forbidden asks the person to
 * sign the connector in again; the others are the trigger's configuration.
 */
export const FATAL_CODES: ReadonlyMap<number, "auth_required" | "configuration_error"> = new Map([
	[-32011, "configuration_error"],
	[-32012, "auth_required"],
	[-32014, "configuration_error"],
]);

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The soonest a grant is renewed after it was granted, however soon it runs out. */
const MIN_RENEW_GAP_MS = 30 * SECOND;
/** How often a binding whose connector is disconnected is looked at again. */
const DISCONNECTED_RECHECK_MS = 5 * MINUTE;
/** The longest wait between failed tries. */
const MAX_BACKOFF_MS = HOUR;
/** Failed or unanswered unsubscribes after which a binding no longer wanted is given up on; it is revoked, so its deliveries answer 410. */
const MAX_UNSUBSCRIBE_FAILURES = 6;
/** Bindings a trigger keeps once they ended, newest first. */
const CLOSED_KEPT = 20;
/** The longest provider subscription id kept, as the ingress adapter takes it. */
const MAX_PROVIDER_ID = 256;

/** What `events/subscribe` is asked, as app-events.ts asks it. The URL and secret are this binding's, the same on every request. */
export type SubscribeRequest = {
	readonly connectorId: string;
	readonly name: string;
	readonly arguments: JsonObject;
	readonly delivery: { readonly mode: "webhook"; readonly url: string; readonly secret: string };
	readonly cursor: string | null;
	readonly ttlMs: number;
};

export type UnsubscribeRequest = {
	readonly connectorId: string;
	readonly name: string;
	readonly arguments: JsonObject;
	readonly delivery: { readonly url: string };
};

/** What the connector answered: a result, or an error with its JSON-RPC code. A throw, or no answer by the deadline, is neither: the outcome is unknown. */
export type ProviderAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: number };

/** A subscribe's result as the connector gave it: `refreshBefore` an ISO time or ms, null for no expiry, absent for the TTL asked for. */
export type ProviderGrant = { readonly id: unknown; readonly refreshBefore?: unknown };

/**
 * The connector side, injected. Each request is given a signal, aborted at
 * its deadline; a request aborted may still take effect, which is why an
 * unknown one is sent again rather than taken as failed. Nothing here
 * logs: an implementation must keep the URL and secret out of its own logs.
 */
export interface SubscriptionProvider {
	connector(connectorId: string): ConnectorStatus;
	subscribe(request: SubscribeRequest, signal: AbortSignal): Promise<ProviderAnswer<ProviderGrant>>;
	unsubscribe(request: UnsubscribeRequest, signal: AbortSignal): Promise<ProviderAnswer<unknown>>;
}

export type SubscriptionManagerOptions = {
	readonly store: TriggerStore;
	readonly provider: SubscriptionProvider;
	/** The database's transactions (`transactionSync`); they nest. */
	readonly transaction: <T>(work: () => T) => T;
	readonly now: () => number;
	/** The space's owner, as the callback's route names it. */
	readonly owner: () => string;
	/** The callback URL for a binding: the same for the same key, every time. */
	readonly callbackUrl: (route: { readonly owner: string; readonly key: string }) => string;
	/** Waits `ms`, or until `signal` is aborted: what requests' deadlines are measured with. */
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** How long one request may go unanswered (30 seconds, at most `EFFECT_DEADLINE_MS`). */
	readonly callTimeoutMs?: number;
	/** The first wait after a failed or unknown request; it doubles with each one in a row, up to an hour (30 seconds). */
	readonly retryMs?: number;
	readonly newId?: () => string;
	readonly newSecret?: () => string;
	readonly batch?: Partial<SubscriptionBatch>;
};

/** Bounds on one tick. */
export type SubscriptionBatch = {
	/** Bindings made for enabled triggers that have none. */
	readonly plans: number;
	/** Stale bindings revoked. */
	readonly revocations: number;
	/** Bindings looked at and requests sent. */
	readonly effects: number;
};

const DEFAULT_BATCH: SubscriptionBatch = { plans: 16, revocations: 32, effects: 8 };

/** One binding as the manager keeps it, without its secret. */
export type SubscriptionBinding = {
	readonly key: string;
	readonly triggerId: string;
	readonly sourceRevision: number;
	readonly generation: number;
	readonly connectorId: string;
	readonly event: string;
	readonly status: ConnectorSubscription["status"];
	/** `open` while it is wanted or being undone; `ended` once unsubscribed, lapsed or never subscribed; `failed` when the connector refused it for good. */
	readonly phase: "open" | "ended" | "failed";
	readonly providerSubscriptionId: string | null;
	readonly grant: SubscriptionGrant | null;
	readonly intent: SubscriptionIntent | null;
	readonly failures: number;
	readonly nextAt: number | null;
	/** A fixed word, with a code when the connector gave one; never the connector's text. */
	readonly lastError: string | null;
	readonly endedAt: number | null;
};

/** What one tick did, by trigger id. */
export type SubscriptionTickReport = {
	readonly planned: string[];
	readonly revoked: string[];
	readonly subscribed: string[];
	readonly unsubscribed: string[];
	readonly unknown: string[];
	readonly refused: string[];
	readonly failed: string[];
	readonly ended: string[];
	nextWakeAt: number | null;
};

type Row = Record<string, SqlStorageValue>;

type Effect =
	| { readonly kind: "subscribe"; readonly key: string; readonly triggerId: string; readonly token: string; readonly request: SubscribeRequest }
	| { readonly kind: "unsubscribe"; readonly key: string; readonly triggerId: string; readonly token: string; readonly request: UnsubscribeRequest };

type Answer<T> = ProviderAnswer<T> | { readonly ok: "unknown" };

function timer(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const handle = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(handle);
			resolve();
		});
	});
}

const TIMED_OUT = Symbol("timed out");

export class ConnectorSubscriptionManager {
	readonly #sql: SqlStorage;
	readonly #store: TriggerStore;
	readonly #provider: SubscriptionProvider;
	readonly #transaction: <T>(work: () => T) => T;
	readonly #now: () => number;
	readonly #owner: () => string;
	readonly #callbackUrl: (route: { readonly owner: string; readonly key: string }) => string;
	readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly #callTimeoutMs: number;
	readonly #retryMs: number;
	readonly #newId: () => string;
	readonly #newSecret: () => string;
	readonly #batch: SubscriptionBatch;

	constructor(sql: SqlStorage, options: SubscriptionManagerOptions) {
		this.#sql = sql;
		this.#store = options.store;
		this.#provider = options.provider;
		this.#transaction = options.transaction;
		this.#now = options.now;
		this.#owner = options.owner;
		this.#callbackUrl = options.callbackUrl;
		this.#sleep = options.sleep ?? timer;
		this.#callTimeoutMs = integer(options.callTimeoutMs ?? EFFECT_DEADLINE_MS, "callTimeoutMs", 100, EFFECT_DEADLINE_MS);
		this.#retryMs = integer(options.retryMs ?? 30 * SECOND, "retryMs", SECOND, HOUR);
		this.#newId = options.newId ?? (() => crypto.randomUUID());
		this.#newSecret = options.newSecret ?? makeSecret;
		const batch = { ...DEFAULT_BATCH, ...options.batch };
		this.#batch = {
			plans: integer(batch.plans, "batch.plans", 1, 256),
			revocations: integer(batch.revocations, "batch.revocations", 1, 256),
			effects: integer(batch.effects, "batch.effects", 1, 64),
		};
		this.#sql.exec(SCHEMA);
	}

	/**
	 * One bounded pass, safe to run at any time, twice at once, or after a
	 * crash: it makes bindings for enabled triggers on a connector's event
	 * that have none for their generation, revokes bindings whose trigger
	 * moved on, then looks at the bindings that are due, oldest first,
	 * sending each one request at most, all in parallel and each within its
	 * deadline. It returns when to tick next.
	 */
	async tick(): Promise<SubscriptionTickReport> {
		const report: SubscriptionTickReport = { planned: [], revoked: [], subscribed: [], unsubscribed: [], unknown: [], refused: [], failed: [], ended: [], nextWakeAt: null };
		this.#plan(report);
		this.#revokeStale(report);
		const due = this.#sql
			.exec("SELECT key FROM pim_trigger_subscriptions WHERE phase = 'open' AND next_at <= ? ORDER BY next_at, key LIMIT ?", this.#now(), this.#batch.effects)
			.toArray()
			.map((row) => String(row.key));
		const effects = due.flatMap((key) => this.#transaction(() => this.#step(key, report)) ?? []);
		await Promise.all(effects.map((effect) => this.#perform(effect, report)));
		report.nextWakeAt = this.nextWakeAt();
		return report;
	}

	/** When the next tick has work: a binding to make, or one that is due. Null when nothing waits. */
	nextWakeAt(): number | null {
		const now = this.#now();
		if (this.#unbound(1).length > 0) return now;
		if (this.#staleQuery(1).length > 0) return now;
		const next = this.#sql.exec("SELECT MIN(next_at) AS at FROM pim_trigger_subscriptions WHERE phase = 'open'").one().at;
		return next === null ? null : Number(next);
	}

	/** The binding a callback's key names, as the ingress adapter reads it: active only while open and not revoked. */
	subscription(key: string): ConnectorSubscription | undefined {
		const row = this.#sql.exec("SELECT * FROM pim_trigger_subscriptions WHERE key = ?", key).toArray()[0];
		if (!row) return undefined;
		return {
			key: String(row.key),
			triggerId: String(row.trigger_id),
			sourceRevision: Number(row.source_revision),
			generation: Number(row.generation),
			connectorId: String(row.connector_id),
			event: String(row.event),
			providerSubscriptionId: row.provider_subscription_id === null ? null : String(row.provider_subscription_id),
			secret: String(row.secret),
			status: row.status === "active" && row.phase === "open" ? "active" : "revoked",
		};
	}

	/** What the ingress adapter asks of the space, answered from these bindings. */
	ingressHost(): ConnectorIngressHost {
		return { owner: () => this.#owner(), subscription: (key) => this.subscription(key), connector: (id) => this.#provider.connector(id) };
	}

	/** A trigger's bindings, oldest first, without their secrets. */
	bindings(triggerId: string): SubscriptionBinding[] {
		return this.#sql.exec("SELECT * FROM pim_trigger_subscriptions WHERE trigger_id = ? ORDER BY created_at, rowid", triggerId).toArray().map(bindingOf);
	}

	/** Erases every binding, for erasing the space. */
	eraseAll(): void {
		this.#transaction(() => {
			for (const table of SUBSCRIPTION_TABLES) this.#sql.exec(`DELETE FROM ${table}`);
		});
	}

	// Desired state

	/** Enabled triggers on a connector's event with no binding for their generation. */
	#unbound(limit: number): Row[] {
		return this.#sql
			.exec(
				`SELECT t.id AS id FROM pim_triggers t
				JOIN pim_trigger_revisions v ON v.trigger_id = t.id AND v.revision = t.revision
				WHERE t.lifecycle = 'enabled' AND json_extract(v.spec, '$.source.kind') = 'connector_event'
				AND NOT EXISTS (SELECT 1 FROM pim_trigger_subscriptions b WHERE b.trigger_id = t.id AND b.generation = t.generation)
				ORDER BY t.updated_at, t.id LIMIT ?`,
				limit,
			)
			.toArray();
	}

	/** Makes a binding, with a key and secret of its own, for each enabled trigger that has none for its generation. */
	#plan(report: SubscriptionTickReport): void {
		for (const row of this.#unbound(this.#batch.plans)) {
			const id = String(row.id);
			const made = this.#transaction(() => {
				const trigger = this.#store.get(id);
				const source = this.#store.sourceState(id);
				if (!trigger || trigger.lifecycle !== "enabled" || trigger.spec.source.kind !== "connector_event" || !source) return false;
				const now = this.#now();
				return (
					this.#sql.exec(
						`INSERT OR IGNORE INTO pim_trigger_subscriptions (key, trigger_id, source_revision, generation, connector_id, event, secret, status, phase, failures, next_at, created_at, updated_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'open', 0, ?, ?, ?)`,
						this.#newId(),
						id,
						source.sourceRevision,
						trigger.generation,
						trigger.spec.source.connectorId,
						trigger.spec.source.event,
						this.#newSecret(),
						now,
						now,
						now,
					).rowsWritten > 0
				);
			});
			if (made) report.planned.push(id);
		}
	}

	/** Open, active bindings whose trigger is gone, not enabled, or at another generation or source. */
	#staleQuery(limit: number): Row[] {
		return this.#sql
			.exec(
				`SELECT b.key AS key, b.trigger_id AS trigger_id FROM pim_trigger_subscriptions b
				LEFT JOIN pim_triggers t ON t.id = b.trigger_id
				LEFT JOIN pim_trigger_sources s ON s.trigger_id = b.trigger_id
				WHERE b.phase = 'open' AND b.status = 'active'
				AND (t.id IS NULL OR t.lifecycle != 'enabled' OR t.generation != b.generation OR s.source_revision IS NOT b.source_revision)
				LIMIT ?`,
				limit,
			)
			.toArray();
	}

	/** Revokes bindings whose trigger moved on, so the ingress adapter refuses them, and makes them due to be undone. */
	#revokeStale(report: SubscriptionTickReport): void {
		for (const row of this.#staleQuery(this.#batch.revocations)) {
			const now = this.#now();
			const written = this.#sql.exec(
				"UPDATE pim_trigger_subscriptions SET status = 'revoked', next_at = MIN(COALESCE(next_at, ?), ?), updated_at = ? WHERE key = ? AND phase = 'open' AND status = 'active'",
				now,
				now,
				now,
				String(row.key),
			).rowsWritten;
			if (written > 0) report.revoked.push(String(row.trigger_id));
		}
	}

	// Steps

	/**
	 * Decides one due binding's next step, in a transaction, and records it:
	 * a wait, an end without a request, or the intent for a request, which
	 * it returns to be sent. Nothing is sent from here.
	 */
	#step(key: string, report: SubscriptionTickReport): Effect | null {
		const row = this.#sql.exec("SELECT * FROM pim_trigger_subscriptions WHERE key = ?", key).toArray()[0];
		const now = this.#now();
		if (!row || row.phase !== "open" || row.next_at === null || Number(row.next_at) > now) return null;
		const binding = bindingOf(row);
		const trigger = this.#store.get(binding.triggerId);
		const source = trigger && trigger.lifecycle !== "deleted" ? this.#store.sourceState(binding.triggerId) : undefined;
		const spec = trigger?.spec.source;
		const current =
			trigger !== undefined &&
			trigger.lifecycle === "enabled" &&
			trigger.generation === binding.generation &&
			source?.sourceRevision === binding.sourceRevision &&
			spec?.kind === "connector_event" &&
			spec.connectorId === binding.connectorId &&
			spec.event === binding.event;
		const connector = this.#provider.connector(binding.connectorId);
		let status = binding.status;
		if (status === "active" && (!current || connector === "removed")) {
			status = "revoked";
			this.#sql.exec("UPDATE pim_trigger_subscriptions SET status = 'revoked', updated_at = ? WHERE key = ?", now, key);
			report.revoked.push(binding.triggerId);
		}
		const wanted = status === "active";
		const decision = renewalDecision({ lifecycle: trigger?.lifecycle ?? "deleted", binding: status, connector, grant: binding.grant, intent: binding.intent, now });
		const lapsed = binding.grant === null || (binding.grant.refreshBefore !== null && binding.grant.refreshBefore <= now);

		switch (decision.action) {
			case "wait":
				this.#reschedule(key, decision.until);
				return null;
			case "idle":
				if (decision.why === "not_wanted" || (!wanted && binding.intent === null && lapsed)) {
					this.#close(row, "ended", connector === "removed" ? "connector_removed" : null, report);
					return null;
				}
				this.#reschedule(key, now + DISCONNECTED_RECHECK_MS);
				return null;
			case "subscribe": {
				// Renewing over and over can't be asked for by a grant that runs out at once.
				if (decision.why !== "no_grant" && binding.grant !== null && now < binding.grant.grantedAt + MIN_RENEW_GAP_MS) {
					this.#reschedule(key, binding.grant.grantedAt + MIN_RENEW_GAP_MS);
					return null;
				}
				return this.#intend(row, "subscribe", this.#newId(), source?.cursor ?? null, now);
			}
			case "resend": {
				const kind = binding.intent!.kind;
				if (kind === "unsubscribe" && connector === "removed") {
					this.#close(row, "ended", "connector_removed", report);
					return null;
				}
				return this.#intend(row, kind, decision.intentId, row.intent_cursor === null ? null : String(row.intent_cursor), now);
			}
			case "unsubscribe":
				// A connector that is gone can't be asked, and a grant that ran out with nothing sent since has lapsed by itself.
				if (connector === "removed" || (binding.intent === null && lapsed)) {
					this.#close(row, "ended", connector === "removed" ? "connector_removed" : "lapsed", report);
					return null;
				}
				return this.#intend(row, "unsubscribe", this.#newId(), null, now);
		}
	}

	/** Records the intent, as sending until its deadline, and builds the request it names: the same request for the same intent, every time. */
	#intend(row: Row, kind: "subscribe" | "unsubscribe", intentId: string, cursor: string | null, now: number): Effect | null {
		const key = String(row.key);
		const triggerId = String(row.trigger_id);
		const spec = this.#store.revision(triggerId, Number(row.source_revision))?.source;
		// The binding's source revision is the one it was made for, and revisions are kept with their trigger; without it nothing can be asked.
		if (spec?.kind !== "connector_event") {
			this.#reschedule(key, now + this.#backoff(Number(row.failures) + 1));
			return null;
		}
		const token = this.#newId();
		this.#sql.exec(
			"UPDATE pim_trigger_subscriptions SET intent_id = ?, intent_kind = ?, intent_state = 'sending', intent_sent_at = ?, intent_token = ?, intent_cursor = ?, next_at = ?, updated_at = ? WHERE key = ?",
			intentId,
			kind,
			now,
			token,
			cursor,
			now + EFFECT_DEADLINE_MS,
			now,
			key,
		);
		const source = spec as ConnectorEventSource;
		const url = this.#callbackUrl({ owner: this.#owner(), key });
		const base = { connectorId: source.connectorId, name: source.event, arguments: source.arguments };
		return kind === "subscribe"
			? { kind, key, triggerId, token, request: { ...base, delivery: { mode: "webhook", url, secret: String(row.secret) }, cursor, ttlMs: SUBSCRIPTION_TTL_MS } }
			: { kind, key, triggerId, token, request: { ...base, delivery: { url } } };
	}

	/**
	 * Sends one request and records its receipt, if the intent is still the
	 * one sent. A receipt that fails to commit leaves the intent sending, as
	 * a crash would, so it is sent again after its deadline.
	 */
	async #perform(effect: Effect, report: SubscriptionTickReport): Promise<void> {
		try {
			if (effect.kind === "subscribe") {
				const answer = await this.#call((signal) => this.#provider.subscribe(effect.request, signal));
				this.#transaction(() => this.#subscribed(effect, answer, report));
			} else {
				const answer = await this.#call((signal) => this.#provider.unsubscribe(effect.request, signal));
				this.#transaction(() => this.#unsubscribed(effect, answer, report));
			}
		} catch {
			report.unknown.push(effect.triggerId);
		}
	}

	/** The intent's row, if it still holds the request this answer is for. */
	#holding(effect: Effect): Row | undefined {
		const row = this.#sql.exec("SELECT * FROM pim_trigger_subscriptions WHERE key = ?", effect.key).toArray()[0];
		return row && row.phase === "open" && row.intent_state === "sending" && row.intent_token === effect.token ? row : undefined;
	}

	#subscribed(effect: Effect, answer: Answer<ProviderGrant>, report: SubscriptionTickReport): void {
		const row = this.#holding(effect);
		if (!row) return;
		const now = this.#now();
		if (answer.ok === "unknown") return this.#unknown(row, "no_answer", report);
		if (answer.ok === false) {
			const fatal = FATAL_CODES.get(answer.code);
			if (fatal) {
				this.#store.setHealth({
					id: effect.triggerId,
					generation: Number(row.generation),
					health: fatal,
					detail: `The connector refused the trigger's subscription (code ${answer.code}); it must be set up again.`,
				});
				this.#close(row, "failed", `refused ${answer.code}`, report);
				return;
			}
			return this.#refused(row, answer.code, report);
		}
		const grant = readGrant(answer.value, now);
		if (grant === null) return this.#unknown(row, "unreadable_answer", report);
		this.#sql.exec(
			"UPDATE pim_trigger_subscriptions SET provider_subscription_id = ?, granted_at = ?, refresh_before = ?, intent_id = NULL, intent_kind = NULL, intent_state = NULL, intent_sent_at = NULL, intent_token = NULL, intent_cursor = NULL, failures = 0, last_error = NULL, next_at = ?, updated_at = ? WHERE key = ?",
			grant.id,
			now,
			grant.refreshBefore,
			now,
			now,
			effect.key,
		);
		// Due now, so the next step works out the renewal from the grant just recorded, or undoes it if the trigger moved on meanwhile.
		const after = bindingOf(this.#sql.exec("SELECT * FROM pim_trigger_subscriptions WHERE key = ?", effect.key).one());
		if (after.status === "active") {
			const next = renewalDecision({ lifecycle: "enabled", binding: "active", connector: "connected", grant: after.grant, intent: null, now });
			this.#reschedule(effect.key, next.action === "wait" ? next.until : now + MIN_RENEW_GAP_MS);
		}
		report.subscribed.push(effect.triggerId);
	}

	#unsubscribed(effect: Effect, answer: Answer<unknown>, report: SubscriptionTickReport): void {
		const row = this.#holding(effect);
		if (!row) return;
		if (answer.ok === true || (answer.ok === false && FATAL_CODES.has(answer.code))) {
			// Not found, forbidden or unsupported: there is nothing left to undo that Pim could.
			this.#close(row, "ended", answer.ok === true ? null : `refused ${answer.code}`, report);
			report.unsubscribed.push(effect.triggerId);
			return;
		}
		if (Number(row.failures) + 1 >= MAX_UNSUBSCRIBE_FAILURES) {
			// Revoked, so every delivery for it answers 410, which the draft's providers take as the end of it.
			this.#close(row, "ended", "unsubscribe_unconfirmed", report);
			return;
		}
		if (answer.ok === "unknown") return this.#unknown(row, "no_answer", report);
		this.#refused(row, answer.code, report);
	}

	/** No answer that can be read: the request may have been done, so it is sent again, the same, after a backoff. */
	#unknown(row: Row, why: "no_answer" | "unreadable_answer", report: SubscriptionTickReport): void {
		const now = this.#now();
		const failures = Number(row.failures) + 1;
		this.#sql.exec(
			"UPDATE pim_trigger_subscriptions SET intent_state = 'unknown', intent_token = NULL, failures = ?, last_error = ?, next_at = ?, updated_at = ? WHERE key = ?",
			failures,
			why,
			now + this.#backoff(failures),
			now,
			String(row.key),
		);
		report.unknown.push(String(row.trigger_id));
	}

	/** An error that isn't fatal: known not done, so the intent is settled, and a new request is decided after a backoff. */
	#refused(row: Row, code: number, report: SubscriptionTickReport): void {
		const now = this.#now();
		const failures = Number(row.failures) + 1;
		this.#sql.exec(
			"UPDATE pim_trigger_subscriptions SET intent_id = NULL, intent_kind = NULL, intent_state = NULL, intent_sent_at = NULL, intent_token = NULL, intent_cursor = NULL, failures = ?, last_error = ?, next_at = ?, updated_at = ? WHERE key = ?",
			failures,
			`refused ${code}`,
			now + this.#backoff(failures),
			now,
			String(row.key),
		);
		report.refused.push(String(row.trigger_id));
	}

	/** Ends a binding for good: revoked, its secret wiped, nothing more to send. A trigger keeps its newest ended bindings as history. */
	#close(row: Row, phase: "ended" | "failed", why: string | null, report: SubscriptionTickReport): void {
		const now = this.#now();
		const key = String(row.key);
		const triggerId = String(row.trigger_id);
		this.#sql.exec(
			"UPDATE pim_trigger_subscriptions SET status = 'revoked', phase = ?, secret = '', intent_id = NULL, intent_kind = NULL, intent_state = NULL, intent_sent_at = NULL, intent_token = NULL, intent_cursor = NULL, next_at = NULL, last_error = COALESCE(?, last_error), ended_at = ?, updated_at = ? WHERE key = ?",
			phase,
			why,
			now,
			now,
			key,
		);
		if (why === "connector_removed") {
			this.#store.setHealth({ id: triggerId, generation: Number(row.generation), health: "configuration_error", detail: "The trigger's connector was removed; it must be set up again." });
		}
		this.#sql.exec(
			`DELETE FROM pim_trigger_subscriptions WHERE trigger_id = ? AND phase != 'open' AND key NOT IN
			(SELECT key FROM pim_trigger_subscriptions WHERE trigger_id = ? AND phase != 'open' ORDER BY ended_at DESC, rowid DESC LIMIT ?)`,
			triggerId,
			triggerId,
			CLOSED_KEPT,
		);
		(phase === "failed" ? report.failed : report.ended).push(triggerId);
	}

	#reschedule(key: string, at: number): void {
		this.#sql.exec("UPDATE pim_trigger_subscriptions SET next_at = ?, updated_at = ? WHERE key = ?", at, this.#now(), key);
	}

	#backoff(failures: number): number {
		return Math.min(MAX_BACKOFF_MS, this.#retryMs * 2 ** Math.min(Math.max(failures - 1, 0), 20));
	}

	/**
	 * Asks the connector one thing, waiting at most `callTimeoutMs`. A throw,
	 * or no answer in time, is unknown, and the signal is aborted; what the
	 * throw said is dropped, since it may hold the request. A later answer
	 * is dropped too.
	 */
	async #call<T>(call: (signal: AbortSignal) => Promise<ProviderAnswer<T>>): Promise<Answer<T>> {
		const abort = new AbortController();
		const stop = new AbortController();
		const deadline = this.#sleep(this.#callTimeoutMs, stop.signal).then(() => TIMED_OUT);
		try {
			const pending = call(abort.signal);
			pending.catch(() => {});
			const result = await Promise.race([pending, deadline]);
			if (result === TIMED_OUT) {
				abort.abort();
				return { ok: "unknown" };
			}
			return isAnswer(result) ? result : { ok: "unknown" };
		} catch {
			return { ok: "unknown" };
		} finally {
			stop.abort();
		}
	}
}

function isAnswer<T>(value: unknown): value is ProviderAnswer<T> {
	if (value === null || typeof value !== "object") return false;
	const answer = value as { ok?: unknown; code?: unknown };
	return answer.ok === true || (answer.ok === false && typeof answer.code === "number" && Number.isSafeInteger(answer.code));
}

/** A grant as the connector gave it, or null when its id can't be the one deliveries name. `refreshBefore` absent or unreadable is the TTL asked for, as app-events.ts takes it. */
function readGrant(value: ProviderGrant | null | undefined, now: number): { id: string; refreshBefore: number | null } | null {
	const id = value?.id;
	if (typeof id !== "string" || id.length === 0 || id.length > MAX_PROVIDER_ID || /[\s\u0000-\u001f\u007f]/.test(id)) return null;
	const given = value!.refreshBefore;
	if (given === null) return { id, refreshBefore: null };
	const at = typeof given === "string" ? Date.parse(given) : typeof given === "number" ? given : Number.NaN;
	return { id, refreshBefore: Number.isSafeInteger(at) ? at : now + SUBSCRIPTION_TTL_MS };
}

function bindingOf(row: Row): SubscriptionBinding {
	const grantedAt = row.granted_at === null ? null : Number(row.granted_at);
	return {
		key: String(row.key),
		triggerId: String(row.trigger_id),
		sourceRevision: Number(row.source_revision),
		generation: Number(row.generation),
		connectorId: String(row.connector_id),
		event: String(row.event),
		status: row.status === "active" && row.phase === "open" ? "active" : "revoked",
		phase: row.phase as SubscriptionBinding["phase"],
		providerSubscriptionId: row.provider_subscription_id === null ? null : String(row.provider_subscription_id),
		grant:
			grantedAt === null || row.provider_subscription_id === null
				? null
				: { providerSubscriptionId: String(row.provider_subscription_id), refreshBefore: row.refresh_before === null ? null : Number(row.refresh_before), grantedAt },
		intent:
			row.intent_id === null
				? null
				: { intentId: String(row.intent_id), kind: row.intent_kind as SubscriptionIntent["kind"], state: row.intent_state as SubscriptionIntent["state"], sentAt: Number(row.intent_sent_at) },
		failures: Number(row.failures),
		nextAt: row.next_at === null ? null : Number(row.next_at),
		lastError: row.last_error === null ? null : String(row.last_error),
		endedAt: row.ended_at === null ? null : Number(row.ended_at),
	};
}
