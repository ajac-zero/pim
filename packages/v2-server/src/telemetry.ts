/**
 * Pim's side of tracing. pi-durable and pi-ai describe what the agents do as spans, once a Harness is given a telemetry context; this module makes that context (the OpenTelemetry
 * adapter of `@pim/v2-ops/observability/pi-telemetry`, one per partition so its spans say whose they are), adds what only Pim knows, and sends the spans to the collector the
 * deployment names. It starts no spans around agent, model or tool work. With no endpoint it makes nothing: `createTelemetry` returns undefined and pi's telemetry stays off.
 *
 * What a span says about Pim is content-free: an opaque reference to the owner (a keyed hash, so an owner id is not recoverable from it), the public ids of the chat and the agent,
 * the partition, the role and the release. The conversation number a span carries is turned into the chat's public id just before export, off the request path.
 */

import { createHmac } from "node:crypto";
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

const FACT_TTL_MS = 60_000;
const MAX_LOOKUPS_PER_BATCH = 32;
const MAX_OWNERS = 10_000;

/** The owner as a telemetry backend may see them: a stable reference that cannot be reversed to an owner id without the deployment's secret. */
export function ownerRef(env: NodeJS.ProcessEnv, ownerId: string): string {
	return `o_${createHmac("sha256", env.PIM_INGRESS_SECRET ?? "pim").update(`pim.telemetry.owner:${ownerId}`).digest("hex").slice(0, 16)}`;
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
	const owners = new Map<string, string>();
	const facts = new Map<string, { at: number; value: ConversationFacts | undefined }>();

	const lookup = async (ref: string, conversation: number): Promise<ConversationFacts | undefined> => {
		const key = `${ref}:${conversation}`;
		const held = facts.get(key);
		if (held && Date.now() - held.at < FACT_TTL_MS) return held.value;
		const ownerId = owners.get(ref);
		const value = ownerId && input.conversation ? await input.conversation(ownerId, conversation).catch(() => undefined) : undefined;
		if (facts.size > 4096) facts.clear();
		facts.set(key, { at: Date.now(), value });
		return value;
	};

	const handle = createTracerProvider({
		serviceName: config.enabled ? config.serviceName : "pim",
		serviceVersion: version,
		resource: { "pim.role": role, ...(env.PIM_REVISION?.trim() ? { "pim.revision": env.PIM_REVISION.trim() } : {}) },
		exporter,
		...(langfuse ? { langfuse: { release: version } } : {}),
		...(input.immediate ? { scheduledDelayMs: 1 } : {}),
		enrich: async (spans) => {
			const extra = new Map<(typeof spans)[number], Record<string, string>>();
			let lookups = 0;
			for (const span of spans) {
				const ref = span.attributes["pim.owner.ref"];
				const conversation = span.attributes["pim.conversation"];
				if (typeof ref !== "string" || typeof conversation !== "number") continue;
				if (!facts.has(`${ref}:${conversation}`) && ++lookups > MAX_LOOKUPS_PER_BATCH) continue;
				const found = await lookup(ref, conversation);
				if (!found) continue;
				extra.set(span, {
					"pim.chat": found.chat,
					...(found.agent ? { "pim.agent": found.agent } : {}),
					...(found.startedByChat ? { "pim.started_by.chat": found.startedByChat } : {}),
					...(found.startedByTask ? { "pim.started_by.task": found.startedByTask } : {}),
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
		shutdown: () => handle.shutdown(),
	};
}
