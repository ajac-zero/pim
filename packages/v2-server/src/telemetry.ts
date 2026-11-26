/**
 * Pim's side of tracing. pi-durable and pi-ai describe what the agents do as spans, once a Harness is given a telemetry context; this module makes that context (the OpenTelemetry
 * adapter of `@pim/v2-ops/observability/pi-telemetry`, one per partition so its spans say whose they are), adds what only Pim knows, and sends the spans to the collector the
 * deployment names. It starts no spans around agent, model or tool work. With no endpoint it makes nothing: `createTelemetry` returns undefined and pi's telemetry stays off.
 *
 * What a span says about Pim is content-free: an opaque reference to the owner (a keyed hash, so an owner id is not recoverable from it), the public ids of the chat and the agent,
 * the partition, the role and the release. The conversation number a span carries is turned into the chat's public id just before export, off the request path.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { PiTelemetry } from "@pim/v2-ops/observability/pi-telemetry";
import { createTracerProvider, otlpHttpExporter, type SpanExporter, telemetryConfigFromEnv } from "@pim/v2-ops/observability/tracing";

/** What Pim knows about a durable conversation, for the spans of its runs. */
export type ConversationFacts = { readonly chat: string; readonly agent?: string | null; readonly startedByChat?: string | null; readonly startedByTask?: string | null };

export type TelemetryInput = {
	readonly role: string;
	/** The chat a conversation of an owner is, and the agent it runs as: asked just before export, never while an agent runs. */
	readonly conversation?: (ownerId: string, conversationId: number) => Promise<ConversationFacts | undefined>;
	/** Replaces the collector: tests, which read what would be sent. */
	readonly exporter?: SpanExporter;
	/** Export without waiting for a batch (tests). */
	readonly immediate?: boolean;
	/** The bounds of the lookup that adds chat and agent ids (tests lower them). */
	readonly limits?: Partial<typeof LIMITS>;
};

export type Telemetry = {
	/** What `HarnessOptions.telemetry` of an owner's partition takes. */
	partition(ownerId: string, partitionId: string): TelemetryContext;
	/**
	 * Runs a model call that no chat asked for (an approval review, a memory nap, a title) under a span that says what it was for, so pi's request spans have a parent to belong to.
	 * `span` is what to give the call as `options.telemetry`.
	 */
	background<T>(ownerId: string, kind: string, call: (span: TelemetrySpan) => Promise<T>): Promise<T>;
	flush(): Promise<void>;
	/** Sends what is queued, within a bound, and stops. */
	shutdown(): Promise<void>;
};

/** What bounds the lookup of chat and agent ids: how long an answer is kept, how long a batch waits for any, how many lookups one batch may start, and how many may be outstanding at all. */
const LIMITS = { ttlMs: 60_000, deadlineMs: 2_000, perBatch: 32, inflight: 8 };
const MAX_OWNERS = 10_000;

/** Used when the deployment has no ingress secret: random for this process, so a reference is stable only until the process restarts, and guessable by no one. */
const EPHEMERAL_KEY = randomBytes(32);

/**
 * The owner as a telemetry backend may see them: a keyed hash that cannot be reversed to an owner id without the key. The key is the deployment's `PIM_INGRESS_SECRET`; with none (or an
 * empty one) it is a random key made when the process started, so references from before a restart, and from other processes, do not match: a chat's session is unaffected, only the user.
 */
export function ownerRef(env: NodeJS.ProcessEnv, ownerId: string): string {
	const key = env.PIM_INGRESS_SECRET?.trim() ? env.PIM_INGRESS_SECRET : EPHEMERAL_KEY;
	return `o_${createHmac("sha256", key).update(`pim.telemetry.owner:${ownerId}`).digest("hex").slice(0, 16)}`;
}

export function createTelemetry(env: NodeJS.ProcessEnv, input: TelemetryInput): Telemetry | undefined {
	const config = telemetryConfigFromEnv(env, "pim");
	let last = 0;
	const warn = (message: string) => {
		// At most one line a minute: a collector that is down must not fill the logs.
		if (Date.now() - last < 60_000) return;
		last = Date.now();
		console.warn(JSON.stringify({ event: "pim.telemetry", message }));
	};
	for (const message of config.warnings) warn(message);
	const exporter = input.exporter ?? (config.enabled ? otlpHttpExporter(config.url, config.headers, { onError: (reason) => warn(`Traces could not be sent: ${reason}`) }) : undefined);
	if (!exporter) return undefined;
	if (env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === "true") warn("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT has no effect: Pim's traces never carry prompts, messages or tool arguments.");

	const version = env.PIM_VERSION?.trim() || "dev";
	const role = input.role;
	const langfuse = config.enabled ? config.profile === "langfuse" : false;
	const limits = { ...LIMITS, ...input.limits };
	const owners = new Map<string, string>();
	const facts = new Map<string, { at: number; value: ConversationFacts | undefined }>();
	/** Lookups that have not settled. A lookup that hangs stays here, so no more than `limits.inflight` are ever outstanding, and a batch that needs the same one waits on it, not on another. */
	const inflight = new Map<string, Promise<ConversationFacts | undefined>>();
	let closed = false;

	/** Starts the lookup for a key unless one is under way, the batch has used its share, or too many are outstanding; the key is then left without. */
	const start = (key: string, ref: string, conversation: number, started: { n: number }): Promise<ConversationFacts | undefined> | undefined => {
		const under = inflight.get(key);
		if (under) return under;
		const ownerId = owners.get(ref);
		if (closed || !ownerId || !input.conversation || started.n >= limits.perBatch || inflight.size >= limits.inflight) return undefined;
		started.n++;
		const lookup = Promise.resolve().then(() => input.conversation!(ownerId, conversation)).then(
			(value) => value,
			() => undefined,
		);
		const tracked = lookup.then((value) => {
			if (facts.size > 4096) facts.clear();
			facts.set(key, { at: Date.now(), value });
			return value;
		}).finally(() => inflight.delete(key));
		inflight.set(key, tracked);
		return tracked;
	};

	const handle = createTracerProvider({
		serviceName: config.enabled ? config.serviceName : "pim",
		serviceVersion: version,
		resource: { "pim.role": role, ...(env.PIM_REVISION?.trim() ? { "pim.revision": env.PIM_REVISION.trim() } : {}) },
		exporter,
		...(langfuse ? { langfuse: { release: version } } : {}),
		...(input.immediate ? { scheduledDelayMs: 1 } : {}),
		// The exporter's own deadline is a backstop behind the lookup's.
		enrichTimeoutMs: limits.deadlineMs + 500,
		enrich: async (spans) => {
			const extra = new Map<(typeof spans)[number], Record<string, string>>();
			const keyOf = (span: (typeof spans)[number]) => {
				const ref = span.attributes["pim.owner.ref"];
				const conversation = span.attributes["pim.conversation"];
				return typeof ref === "string" && typeof conversation === "number" ? { key: `${ref}:${conversation}`, ref, conversation } : undefined;
			};
			// Answers kept within their time are used; every other key is looked up, counted against the batch whether or not an older answer expired.
			const found = new Map<string, ConversationFacts | undefined>();
			const waiting: Promise<void>[] = [];
			const started = { n: 0 };
			for (const span of spans) {
				const k = keyOf(span);
				if (!k || found.has(k.key)) continue;
				const held = facts.get(k.key);
				if (held && Date.now() - held.at < limits.ttlMs) {
					found.set(k.key, held.value);
					continue;
				}
				// An expired answer still names the chat if no new one comes in time.
				found.set(k.key, held?.value);
				const lookup = start(k.key, k.ref, k.conversation, started);
				if (lookup) waiting.push(lookup.then((value) => void found.set(k.key, value)));
			}
			// The batch waits for its lookups no longer than the deadline, and the timer does not outlive it.
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([Promise.all(waiting), new Promise<void>((resolve) => (timer = setTimeout(resolve, limits.deadlineMs)))]);
			clearTimeout(timer);
			for (const span of spans) {
				const k = keyOf(span);
				const value = k && found.get(k.key);
				if (!value) continue;
				extra.set(span, {
					"pim.chat": value.chat,
					...(value.agent ? { "pim.agent": value.agent } : {}),
					...(value.startedByChat ? { "pim.started_by.chat": value.startedByChat } : {}),
					...(value.startedByTask ? { "pim.started_by.task": value.startedByTask } : {}),
				});
			}
			return extra;
		},
	});
	const tracer = handle.provider.getTracer("pim");

	const remember = (ownerId: string): string => {
		const ref = ownerRef(env, ownerId);
		if (!owners.has(ref) && owners.size >= MAX_OWNERS) owners.clear();
		owners.set(ref, ownerId);
		return ref;
	};

	return {
		partition(ownerId, partitionId) {
			return new PiTelemetry({ tracer, attributes: { "pim.owner.ref": remember(ownerId), "pim.partition.id": partitionId, "pim.role": role } }).context;
		},
		background(ownerId, kind, call) {
			return new PiTelemetry({ tracer, attributes: { "pim.owner.ref": remember(ownerId), "pim.role": role } }).context.startSpan({ name: "pim.background", attributes: { "pim.call": kind } }, call);
		},
		flush: () => handle.forceFlush(),
		shutdown: () => {
			closed = true;
			return handle.shutdown();
		},
	};
}
