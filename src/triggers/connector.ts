/**
 * Connector events into triggers: an inert ingress adapter that takes one
 * signed webhook delivery for a trigger on a connector's event and admits
 * it into the trigger store (./store.ts), and the typed contract for
 * keeping the connector's subscription alive. Nothing constructs it: no
 * route, tool, alarm or subscription reaches it, and connector watches
 * (../extensions/app-events.ts) work exactly as before. See "Connector
 * events" in docs/triggers.md.
 *
 * The delivery format is the webhook slice of the draft MCP Events
 * extension (github.com/modelcontextprotocol/experimental-ext-triggers-events),
 * as app-events.ts receives it, held to the draft's stricter rules:
 * Standard Webhooks headers with `X-MCP-Subscription-Id` on every delivery,
 * an event's `webhook-id` equal to its `eventId`, and `timestamp` as the
 * time the event occurred. Anything else is refused rather than guessed at.
 *
 * Who a delivery is for comes only from the route and the space: the
 * Durable Object that owns the trigger, and the subscription the callback
 * names, which binds one trigger at one source revision and generation to
 * one connector, event and provider subscription. Nothing in the body
 * names a trigger, an owner or a generation. The signature and its
 * freshness are checked, with app-events.ts's own verifier, before the body
 * is parsed, and the binding and the trigger are checked again after every
 * wait, right before the store's one transaction admits the event.
 *
 * The adapter never hands an event to an agent: an admitted event is an
 * occurrence with an outbox item, as the store makes it, and nothing more.
 * The coordinator (./coordinator.ts) hands on time firings only, so a
 * connector occurrence stays pending until a later change gives source
 * context a contract. Nothing observed is kept or logged: not the body,
 * its data, the secret, nor a provider's error text.
 */

import { verifyWebhook } from "../extensions/app-events";
import type { TriggerLifecycle } from "./spec";
import { ADMISSION_LIMITS, type Trigger, type TriggerStore } from "./store";
import { TriggerValidationError, integer, jsonObject, record, text } from "./validate";

/** Bounds on one delivery. The body cap is a quarter of app-events.ts's (256 KiB): an event's data must fit the store's 16 KB anyway. */
export const CONNECTOR_INGRESS_LIMITS = {
	maxBodyBytes: 64 * 1024,
	/** The longest the body may take to arrive. */
	bodyDeadlineMs: 10_000,
	/** Nesting of the whole body: the envelope, and the store's eight levels of data. */
	maxDepth: ADMISSION_LIMITS.payload.maxDepth + 1,
	headerIdLength: ADMISSION_LIMITS.eventIdLength,
	subscriptionIdLength: 256,
	signatureHeaderLength: 2_048,
	signatures: 8,
	challengeLength: 256,
	errorMessageLength: 1_000,
} as const;

/** How a connector stands in the space, as the host sees it now. */
export type ConnectorStatus = "connected" | "disconnected" | "removed";

/**
 * One provider subscription bound to one trigger: what the callback's key
 * resolves to in the space that owns it. The host records it when the
 * connector grants a subscription (deferred, see `RenewalDecision`), for
 * the trigger's generation and source revision at the time, so a pause,
 * an edit or a deletion leaves it stale rather than moving it along.
 */
export type ConnectorSubscription = {
	/** The callback's own key, the last segment of its URL. A watch's id can be one (see docs/triggers.md). */
	readonly key: string;
	readonly triggerId: string;
	readonly sourceRevision: number;
	readonly generation: number;
	readonly connectorId: string;
	readonly event: string;
	/** The `id` the connector's `events/subscribe` answered with; null until it is known, when deliveries are asked to come back later. */
	readonly providerSubscriptionId: string | null;
	/** The Standard Webhooks secret (`whsec_…`) Pim gave the connector. */
	readonly secret: string;
	readonly status: "active" | "revoked";
};

/** What the adapter reads of the space. Every method answers at once, from the space's own state, so nothing can change between a check and the admission. */
export interface ConnectorIngressHost {
	/** The space's owner, as the Durable Object knows itself. */
	owner(): string;
	subscription(key: string): ConnectorSubscription | undefined;
	connector(connectorId: string): ConnectorStatus;
}

export type ConnectorIngressOptions = {
	readonly store: TriggerStore;
	readonly host: ConnectorIngressHost;
	/** The clock signatures' freshness is checked against; the store's own, in Pim. */
	readonly now: () => number;
	readonly bodyDeadlineMs?: number;
};

/** What the adapter made of a delivery, with no part of the body but a verification's challenge. */
export type IngressOutcome =
	| { readonly disposition: "accepted"; readonly status: 200 | 204; readonly reason: AcceptedReason; readonly occurrenceId?: string | null; readonly challenge?: string }
	/** Sending the same event again later may succeed. */
	| { readonly disposition: "retry"; readonly status: 408 | 425 | 500 | 503; readonly reason: RetryReason; readonly retryAfterSeconds: number }
	/** Sending the same bytes again won't succeed. */
	| { readonly disposition: "reject"; readonly status: 400 | 401 | 404 | 410 | 413 | 415; readonly reason: RejectReason };

/** `admitted`: it fired; `filtered`: taken in, its condition didn't fire; `duplicate`: taken in before. */
export type AcceptedReason = "admitted" | "filtered" | "duplicate" | "verified" | "gap_recorded" | "terminated_recorded";
export type RetryReason = "not_ready" | "connector_disconnected" | "subscription_changed" | "body_timeout" | "too_early" | "backpressure" | "inbox_full" | "admission_failed";
export type RejectReason =
	| "wrong_owner"
	| "unknown_subscription"
	| "revoked"
	| "connector_removed"
	| "wrong_subscription"
	| "bad_headers"
	| "unsupported_media_type"
	| "too_large"
	| "malformed_utf8"
	| "too_deep"
	| "malformed_json"
	| "unauthenticated"
	| "unsupported_envelope"
	| "invalid_event"
	| "event_id_mismatch"
	| "wrong_event"
	| "binding_mismatch"
	| "not_found"
	| "deleted"
	| "stale_generation"
	| "not_enabled"
	| "wrong_source"
	| "too_old"
	| "refused";

const RETRY_AFTER: Record<RetryReason, number> = {
	not_ready: 5,
	connector_disconnected: 300,
	subscription_changed: 5,
	body_timeout: 30,
	too_early: 60,
	backpressure: 60,
	inbox_full: 3_600,
	admission_failed: 30,
};

const RETRY_STATUS: Record<RetryReason, 408 | 425 | 500 | 503> = {
	not_ready: 503,
	connector_disconnected: 503,
	subscription_changed: 503,
	body_timeout: 408,
	too_early: 425,
	backpressure: 503,
	inbox_full: 503,
	admission_failed: 500,
};

const REJECT_STATUS: Record<RejectReason, 400 | 401 | 404 | 410 | 413 | 415> = {
	wrong_owner: 404,
	unknown_subscription: 410,
	revoked: 410,
	connector_removed: 410,
	wrong_subscription: 401,
	bad_headers: 400,
	unsupported_media_type: 415,
	too_large: 413,
	malformed_utf8: 400,
	too_deep: 400,
	malformed_json: 400,
	unauthenticated: 401,
	unsupported_envelope: 400,
	invalid_event: 400,
	event_id_mismatch: 400,
	wrong_event: 400,
	binding_mismatch: 410,
	not_found: 410,
	deleted: 410,
	stale_generation: 410,
	not_enabled: 410,
	wrong_source: 410,
	too_old: 410,
	refused: 410,
};

const retry = (reason: RetryReason): IngressOutcome => ({ disposition: "retry", status: RETRY_STATUS[reason], reason, retryAfterSeconds: RETRY_AFTER[reason] });
const reject = (reason: RejectReason): IngressOutcome => ({ disposition: "reject", status: REJECT_STATUS[reason], reason });

/** The HTTP answer for an outcome: a verification's challenge, or the outcome's reason and nothing else. */
export function ingressResponse(outcome: IngressOutcome): Response {
	if (outcome.disposition === "accepted") {
		return outcome.reason === "verified" ? Response.json({ challenge: outcome.challenge }, { status: 200 }) : new Response(null, { status: 204 });
	}
	const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
	if (outcome.disposition === "retry") headers["retry-after"] = String(outcome.retryAfterSeconds);
	return new Response(outcome.reason, { status: outcome.status, headers });
}

/** An event delivery as this adapter takes it, after its signature checked out. */
type EventDelivery = { readonly eventId: string; readonly name: string; readonly observedAt: number; readonly data: Record<string, unknown>; readonly cursor: string | null };
type Envelope =
	| { readonly type: "event"; readonly event: EventDelivery }
	| { readonly type: "verification"; readonly challenge: string }
	| { readonly type: "gap" }
	| { readonly type: "terminated"; readonly code: number };

/** How old or new a delivery's signing time may be, in seconds: app-events.ts's verifier's own tolerance (Standard Webhooks). */
const TOLERANCE_S = 300;

/** Codes a connector ends a subscription with when its access was taken away: the draft's Forbidden, and the one app-events.ts treats so. */
const FORBIDDEN_CODES = new Set([-32012, -32024]);

export class ConnectorIngress {
	readonly #store: TriggerStore;
	readonly #host: ConnectorIngressHost;
	readonly #now: () => number;
	readonly #bodyDeadlineMs: number;

	constructor(options: ConnectorIngressOptions) {
		this.#store = options.store;
		this.#host = options.host;
		this.#now = options.now;
		this.#bodyDeadlineMs = integer(options.bodyDeadlineMs ?? CONNECTOR_INGRESS_LIMITS.bodyDeadlineMs, "bodyDeadlineMs", 1, 60_000);
	}

	/**
	 * Takes one delivery for the callback `<owner>/<key>`. In order: the
	 * route's owner is this space; the key names an active subscription of
	 * an enabled trigger at the generation and source it was bound to; the
	 * headers are there, within bounds, and name that provider
	 * subscription; the body arrives in time and within its cap, as UTF-8;
	 * its signature and timestamp verify; then it is parsed, held to the
	 * contract, and, with every check made again, admitted in one
	 * transaction. Never throws: anything unexpected is a retry.
	 */
	async receive(route: { readonly owner: string; readonly key: string }, request: Pick<Request, "headers" | "body">): Promise<IngressOutcome> {
		try {
			return await this.#receive(route, request);
		} catch {
			return retry("admission_failed");
		}
	}

	async #receive(route: { readonly owner: string; readonly key: string }, request: Pick<Request, "headers" | "body">): Promise<IngressOutcome> {
		if (route.owner !== this.#host.owner()) return reject("wrong_owner");
		const first = this.#bound(route.key);
		if ("disposition" in first) return first;
		const { binding } = first;

		const headers = request.headers;
		const subscriptionId = headers.get("x-mcp-subscription-id");
		if (subscriptionId === null || subscriptionId.length === 0 || subscriptionId.length > CONNECTOR_INGRESS_LIMITS.subscriptionIdLength) return reject("bad_headers");
		if (binding.providerSubscriptionId === null) return retry("not_ready");
		if (subscriptionId !== binding.providerSubscriptionId) return reject("wrong_subscription");
		const webhookId = headers.get("webhook-id");
		const timestamp = headers.get("webhook-timestamp");
		const signatures = headers.get("webhook-signature");
		if (webhookId === null || !plainText(webhookId, CONNECTOR_INGRESS_LIMITS.headerIdLength)) return reject("bad_headers");
		if (timestamp === null || !/^\d{1,12}$/.test(timestamp)) return reject("bad_headers");
		// The verifier checks this again with the signature; checked first, a stale delivery isn't even read.
		if (Math.abs(Math.floor(this.#now() / 1000) - Number(timestamp)) > TOLERANCE_S) return reject("unauthenticated");
		if (signatures === null || signatures.length > CONNECTOR_INGRESS_LIMITS.signatureHeaderLength || signatures.split(" ").length > CONNECTOR_INGRESS_LIMITS.signatures) return reject("bad_headers");
		if (!jsonMediaType(headers.get("content-type"))) return reject("unsupported_media_type");
		const length = headers.get("content-length");
		if (length !== null && (!/^\d{1,12}$/.test(length) || Number(length) > CONNECTOR_INGRESS_LIMITS.maxBodyBytes)) return reject("too_large");

		const read = await readBounded(request.body, CONNECTOR_INGRESS_LIMITS.maxBodyBytes, this.#bodyDeadlineMs);
		if (read === "too_large") return reject("too_large");
		if (read === "timeout") return retry("body_timeout");
		if (read === "malformed") return reject("malformed_utf8");
		let body: string;
		try {
			// Fatal, and keeping a byte order mark, so the text signed is exactly the bytes received.
			body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read);
		} catch {
			return reject("malformed_utf8");
		}
		let verified = false;
		try {
			verified = await verifyWebhook(binding.secret, headers, body, Math.floor(this.#now() / 1000));
		} catch {
			verified = false;
		}
		if (!verified) return reject("unauthenticated");

		// Only now is the body read as JSON.
		if (!nestingWithin(body, CONNECTOR_INGRESS_LIMITS.maxDepth)) return reject("too_deep");
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			return reject("malformed_json");
		}
		const envelope = readEnvelope(parsed);
		if ("disposition" in envelope) return envelope;
		if (envelope.type === "event" && envelope.event.eventId !== webhookId) return reject("event_id_mismatch");

		// From here to the admission nothing waits, so what is checked is what is admitted under.
		const again = this.#bound(route.key);
		if ("disposition" in again) return again;
		if (!sameBinding(again.binding, binding)) return retry("subscription_changed");
		const { trigger } = again;

		switch (envelope.type) {
			case "verification":
				return { disposition: "accepted", status: 200, reason: "verified", challenge: envelope.challenge };
			case "gap": {
				// The store keeps a cursor only with an admission, so the fresh one is not kept: the next subscribe sends the last admitted one, and hears of the gap again.
				const gap = this.#store.recordGap({ id: trigger.id, generation: binding.generation });
				return gap.ok ? { disposition: "accepted", status: 204, reason: "gap_recorded" } : reject("stale_generation");
			}
			case "terminated": {
				const forbidden = FORBIDDEN_CODES.has(envelope.code);
				const health = this.#store.setHealth({
					id: trigger.id,
					generation: binding.generation,
					health: forbidden ? "auth_required" : "configuration_error",
					detail: `The connector ended its subscription (code ${envelope.code}); it must be subscribed again.`,
				});
				return health.ok ? { disposition: "accepted", status: 204, reason: "terminated_recorded" } : reject("stale_generation");
			}
			case "event":
				return this.#admit(trigger, binding, envelope.event);
		}
	}

	/** Admits an event in the store's one transaction, with the cursor it carries as the new checkpoint. */
	#admit(trigger: Trigger, binding: ConnectorSubscription, event: EventDelivery): IngressOutcome {
		if (trigger.spec.source.kind !== "connector_event" || event.name !== trigger.spec.source.event) return reject("wrong_event");
		const now = this.#now();
		if (event.observedAt > now + ADMISSION_LIMITS.futureSkewMs) return retry("too_early");
		if (event.observedAt < 0) return reject("too_old");
		// The checkpoint's position counts this source's admissions; it says nothing of the provider's order, which an opaque cursor doesn't tell.
		const source = this.#store.sourceState(trigger.id);
		const checkpoint = event.cursor === null || source === undefined ? undefined : { position: (source.position ?? 0) + 1, cursor: event.cursor };
		let admission: ReturnType<TriggerStore["admit"]>;
		try {
			admission = this.#store.admit({ id: trigger.id, generation: binding.generation, eventId: event.eventId, observedAt: event.observedAt, payload: event.data, ...(checkpoint ? { checkpoint } : {}) });
		} catch (error) {
			return error instanceof TriggerValidationError ? reject("invalid_event") : retry("admission_failed");
		}
		switch (admission.status) {
			case "accepted":
				return { disposition: "accepted", status: 204, reason: admission.occurrence === null ? "filtered" : "admitted", occurrenceId: admission.occurrence?.id ?? null };
			case "duplicate":
				return { disposition: "accepted", status: 204, reason: "duplicate" };
			case "backpressure":
				return retry("backpressure");
			case "inbox_full":
				return retry("inbox_full");
			case "not_found":
			case "deleted":
			case "stale_generation":
			case "not_enabled":
			case "wrong_source":
			case "too_old":
				return reject(admission.status);
			default:
				return reject("refused");
		}
	}

	/** The key's subscription and its trigger, if deliveries for it may be taken now; else why not. */
	#bound(key: string): { binding: ConnectorSubscription; trigger: Trigger } | IngressOutcome {
		const binding = this.#host.subscription(key);
		if (!binding || binding.key !== key) return reject("unknown_subscription");
		if (binding.status !== "active") return reject("revoked");
		const trigger = this.#store.get(binding.triggerId);
		if (!trigger) return reject("not_found");
		if (trigger.lifecycle === "deleted") return reject("deleted");
		if (trigger.generation !== binding.generation) return reject("stale_generation");
		if (trigger.lifecycle !== "enabled") return reject("not_enabled");
		const source = trigger.spec.source;
		if (source.kind !== "connector_event") return reject("wrong_source");
		if (source.connectorId !== binding.connectorId || source.event !== binding.event) return reject("binding_mismatch");
		if (this.#store.sourceState(trigger.id)?.sourceRevision !== binding.sourceRevision) return reject("stale_generation");
		const connector = this.#host.connector(binding.connectorId);
		if (connector === "removed") return reject("connector_removed");
		if (connector !== "connected") return retry("connector_disconnected");
		return { binding, trigger };
	}
}

function sameBinding(a: ConnectorSubscription, b: ConnectorSubscription): boolean {
	return (
		a.key === b.key &&
		a.triggerId === b.triggerId &&
		a.sourceRevision === b.sourceRevision &&
		a.generation === b.generation &&
		a.connectorId === b.connectorId &&
		a.event === b.event &&
		a.providerSubscriptionId === b.providerSubscriptionId &&
		a.secret === b.secret &&
		a.status === b.status
	);
}

/** Text of 1 to `max` characters with no spaces or control characters. */
function plainText(value: string, max: number): boolean {
	return value.length > 0 && value.length <= max && !/[\s\u0000-\u001f\u007f]/.test(value);
}

/** `application/json`, with no parameter but a UTF-8 charset. */
function jsonMediaType(value: string | null): boolean {
	if (value === null) return false;
	const [type, ...parameters] = value.split(";").map((part) => part.trim().toLowerCase());
	return type === "application/json" && parameters.every((parameter) => parameter === "charset=utf-8" || parameter === 'charset="utf-8"');
}

/**
 * Reads a body of at most `max` bytes, chunk by chunk, within `deadlineMs`.
 * Past the cap or the deadline it stops reading and cancels the stream.
 */
async function readBounded(body: ReadableStream<Uint8Array> | null, max: number, deadlineMs: number): Promise<Uint8Array | "too_large" | "timeout" | "malformed"> {
	if (body === null) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let handle: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"timeout">((resolve) => {
		handle = setTimeout(() => resolve("timeout"), deadlineMs);
	});
	const stop = () => reader.cancel().catch(() => undefined);
	try {
		for (;;) {
			const next = await Promise.race([reader.read(), deadline]);
			if (next === "timeout") {
				void stop();
				return "timeout";
			}
			if (next.done) break;
			const chunk: unknown = next.value;
			if (!(chunk instanceof Uint8Array)) {
				void stop();
				return "malformed";
			}
			total += chunk.byteLength;
			if (total > max) {
				void stop();
				return "too_large";
			}
			chunks.push(chunk);
		}
	} finally {
		clearTimeout(handle);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** Whether JSON text nests objects and arrays at most `max` deep, counted without parsing it. */
function nestingWithin(json: string, max: number): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < json.length; index++) {
		const code = json.charCodeAt(index);
		if (inString) {
			if (escaped) escaped = false;
			else if (code === 0x5c) escaped = true;
			else if (code === 0x22) inString = false;
		} else if (code === 0x22) inString = true;
		else if (code === 0x7b || code === 0x5b) {
			if (++depth > max) return false;
		} else if (code === 0x7d || code === 0x5d) depth--;
	}
	return true;
}

/**
 * The body as the draft defines it: a control envelope, with a top-level
 * `type`, or an event occurrence, with no `type`. Any field the draft
 * doesn't define, or a type it doesn't, is refused.
 */
function readEnvelope(value: unknown): Envelope | IngressOutcome {
	try {
		const given = record(value, "body", ["type", "eventId", "name", "timestamp", "data", "cursor", "_meta", "challenge", "error"]);
		switch (given.type) {
			case undefined: {
				const event = record(value, "body", ["eventId", "name", "timestamp", "data", "cursor", "_meta"]);
				const observedAt = eventTime(event.timestamp);
				if (observedAt === null) return reject("invalid_event");
				if (event.data === null || typeof event.data !== "object" || Array.isArray(event.data)) return reject("invalid_event");
				if (new TextEncoder().encode(JSON.stringify(event.data)).byteLength > ADMISSION_LIMITS.payload.maxBytes) return reject("too_large");
				// Reserved for protocol metadata; read as an object and not kept.
				if (event._meta !== undefined && (event._meta === null || typeof event._meta !== "object" || Array.isArray(event._meta))) return reject("invalid_event");
				return {
					type: "event",
					event: {
						eventId: text(event.eventId, "body.eventId", ADMISSION_LIMITS.eventIdLength),
						name: text(event.name, "body.name", 128),
						observedAt,
						data: jsonObject(event.data, "body.data", ADMISSION_LIMITS.payload),
						cursor: event.cursor === undefined || event.cursor === null ? null : text(event.cursor, "body.cursor", ADMISSION_LIMITS.cursorLength),
					},
				};
			}
			case "verification": {
				const given = record(value, "body", ["type", "challenge"]);
				return { type: "verification", challenge: text(given.challenge, "body.challenge", CONNECTOR_INGRESS_LIMITS.challengeLength) };
			}
			case "gap": {
				const given = record(value, "body", ["type", "cursor"]);
				text(given.cursor, "body.cursor", ADMISSION_LIMITS.cursorLength);
				return { type: "gap" };
			}
			case "terminated": {
				const error = record(record(value, "body", ["type", "error"]).error, "body.error", ["code", "message", "data"]);
				if (error.message !== undefined) text(error.message, "body.error.message", CONNECTOR_INGRESS_LIMITS.errorMessageLength, { multiline: true });
				return { type: "terminated", code: integer(error.code, "body.error.code", -(2 ** 31), 2 ** 31 - 1) };
			}
			default:
				return reject("unsupported_envelope");
		}
	} catch (error) {
		if (error instanceof TriggerValidationError) return reject("invalid_event");
		throw error;
	}
}

/**
 * An event's own time, in ms: ISO 8601 with seconds and a zone (`Z` or
 * `±hh:mm`), fractions past milliseconds cut off, so every delivery of an
 * event reads as the same instant. A time that names no real instant, such
 * as February 30th or a leap second, is null. There is no fallback: the
 * draft makes `timestamp` required, and `webhook-timestamp` is when a
 * delivery was signed, new on every retry, so it can't stand in.
 */
export function eventTime(value: unknown): number | null {
	if (typeof value !== "string" || value.length > 40) return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
	if (!match) return null;
	const [, year, month, day, hour, minute, second, fraction, zone] = match;
	const parts = [year, month, day, hour, minute, second].map(Number) as [number, number, number, number, number, number];
	const [y, mo, d, h, mi, s] = parts;
	if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
	const local = Date.UTC(y, mo - 1, d, h, mi, s, fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0")));
	if (new Date(local).getUTCDate() !== d) return null;
	if (zone === "Z") return local;
	const sign = zone!.startsWith("-") ? -1 : 1;
	const [zoneHours, zoneMinutes] = zone!.slice(1).split(":").map(Number) as [number, number];
	if (zoneHours > 23 || zoneMinutes > 59) return null;
	return local - sign * (zoneHours * 60 + zoneMinutes) * 60_000;
}

// Keeping the subscription: the contract, not an implementation

/** Renew this long before a grant runs out, as app-events.ts does. */
export const RENEW_MARGIN_MS = 5 * 60_000;
/** A grant with no expiry is checked this often, as app-events.ts does. */
export const NO_EXPIRY_CHECK_MS = 24 * 60 * 60_000;
/** How long a request to the connector may go unanswered before its outcome is unknown. */
export const EFFECT_DEADLINE_MS = 30_000;

/** What the connector granted: its subscription's id and when it must be renewed by (null: no expiry). */
export type SubscriptionGrant = { readonly providerSubscriptionId: string; readonly refreshBefore: number | null; readonly grantedAt: number };

/**
 * A request to the connector, recorded before it is sent and kept until
 * its answer is recorded with it as the receipt. `sending` until its
 * deadline; `unknown` after it, or after a restart without an answer: the
 * connector may or may not have done it.
 */
export type SubscriptionIntent = { readonly intentId: string; readonly kind: "subscribe" | "unsubscribe"; readonly state: "sending" | "unknown"; readonly sentAt: number };

export type RenewalInput = {
	readonly lifecycle: TriggerLifecycle;
	/** The trigger's binding, or null when it has none. */
	readonly binding: ConnectorSubscription["status"] | null;
	readonly connector: ConnectorStatus;
	readonly grant: SubscriptionGrant | null;
	/** The request without a recorded answer, if there is one. */
	readonly intent: SubscriptionIntent | null;
	readonly now: number;
};

/**
 * The next step for a trigger's subscription. `resend` sends the intent's
 * recorded request again, byte for byte: the draft's `events/subscribe` and
 * `events/unsubscribe` are idempotent over (principal, callback URL, event,
 * arguments), so a request whose outcome is unknown is settled by asking
 * the same thing again, never by a new subscription with a new URL or
 * secret. Nothing performs these yet.
 */
export type RenewalDecision =
	| { readonly action: "wait"; readonly until: number }
	| { readonly action: "idle"; readonly why: "not_wanted" | "connector_disconnected" }
	| { readonly action: "subscribe"; readonly why: "no_grant" | "renew" | "check_alive" }
	| { readonly action: "resend"; readonly intentId: string }
	| { readonly action: "unsubscribe" };

/** Pure: what keeping one trigger's subscription calls for now. */
export function renewalDecision(input: RenewalInput): RenewalDecision {
	const wanted = input.lifecycle === "enabled" && input.binding === "active" && input.connector !== "removed";
	const intent = input.intent;
	if (intent !== null && intent.state === "sending" && input.now < intent.sentAt + EFFECT_DEADLINE_MS) return { action: "wait", until: intent.sentAt + EFFECT_DEADLINE_MS };
	if (input.connector === "disconnected") return { action: "idle", why: "connector_disconnected" };
	if (intent !== null) {
		// Unknown: the same request again if it is still what's wanted; otherwise what is wanted now, which an unknown subscribe may have made necessary.
		if ((intent.kind === "subscribe") === wanted) return { action: "resend", intentId: intent.intentId };
		return wanted ? { action: "subscribe", why: "no_grant" } : { action: "unsubscribe" };
	}
	if (!wanted) return input.grant === null ? { action: "idle", why: "not_wanted" } : { action: "unsubscribe" };
	if (input.grant === null) return { action: "subscribe", why: "no_grant" };
	if (input.grant.refreshBefore === null) {
		const check = input.grant.grantedAt + NO_EXPIRY_CHECK_MS;
		return input.now >= check ? { action: "subscribe", why: "check_alive" } : { action: "wait", until: check };
	}
	const renewAt = input.grant.refreshBefore - RENEW_MARGIN_MS;
	return input.now >= renewAt ? { action: "subscribe", why: "renew" } : { action: "wait", until: renewAt };
}
