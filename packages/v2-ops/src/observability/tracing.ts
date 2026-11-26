// Exporting traces: the configuration that turns them on, the exporter that carries them, and the guard around both. Pi's own spans (`pi.durable.*`, `pi.ai.*`) are what is
// exported; nothing here wraps agent, model or tool work. Export is best effort and off the hot path: spans wait in a bounded queue, a collector that fails or hangs loses
// spans and never changes what an agent did, and with no endpoint there is no exporter and no network.

import { ExportResultCode } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import { type LangfuseOptions, langfuseAttributes } from "./langfuse.ts";
import { type RedactOptions, redactAttributes, redactText, redactValue } from "./redact.ts";

export type { ReadableSpan, SpanExporter };
type Attributes = ReadableSpan["attributes"];

/** String attributes pi defines as a closed set of words, which a name-based rule must not mistake for content (`result` of a submission: queued, placed or done). */
const CLOSED_WORDS: Readonly<Record<string, ReadonlySet<string>>> = { result: new Set(["queued", "placed", "done"]) };

/** Attributes cleaned by the same rules as logs, except pi's closed vocabulary, which carries no content. */
function cleanAttributes(attributes: Attributes | undefined, options: RedactOptions): Attributes {
	if (!attributes) return {};
	return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, typeof value === "string" && CLOSED_WORDS[key]?.has(value) ? value : redactValue(value, options, key)])) as Attributes;
}

/** A span with some of its fields replaced; everything else is the original's. */
function patched(span: ReadableSpan, patch: Partial<Pick<ReadableSpan, "name" | "status" | "attributes" | "links" | "events" | "resource" | "instrumentationScope">>): ReadableSpan {
	return {
		name: span.name,
		kind: span.kind,
		spanContext: () => span.spanContext(),
		parentSpanContext: span.parentSpanContext,
		startTime: span.startTime,
		endTime: span.endTime,
		status: span.status,
		attributes: span.attributes,
		links: span.links,
		events: span.events,
		duration: span.duration,
		ended: span.ended,
		resource: span.resource,
		instrumentationScope: span.instrumentationScope,
		droppedAttributesCount: span.droppedAttributesCount,
		droppedEventsCount: span.droppedEventsCount,
		droppedLinksCount: span.droppedLinksCount,
		...patch,
	};
}

/** The error classes pi names itself (`provider_error` of a model request; `task_faulted`, `task_failed` and `task_orphaned` of a task): a fixed vocabulary, so it holds no content. */
const KNOWN_ERRORS: ReadonlySet<string> = new Set(["provider_error", "task_faulted", "task_failed", "task_orphaned"]);

/** A status keeps one of pi's own error classes and drops the message, which can echo what a person said; any other text is dropped, a one-word message included. With content capture on the message stays, minus credentials. */
function cleanStatus(status: ReadableSpan["status"], options: RedactOptions): ReadableSpan["status"] {
	if (status.message === undefined) return status;
	if (options.captureContent) return { ...status, message: redactText(status.message).slice(0, 500) };
	const name = status.message.split(": ", 1)[0]!;
	return KNOWN_ERRORS.has(name) ? { ...status, message: name } : { code: status.code };
}

/** The scope's name, version, schema URL and attributes (which the exporter sends too), cleaned like every other field. */
function cleanScope(scope: ReadableSpan["instrumentationScope"], options: RedactOptions): ReadableSpan["instrumentationScope"] {
	const { name, version, schemaUrl, attributes } = scope as typeof scope & { attributes?: Attributes };
	return { name: redactText(name), ...(version === undefined ? {} : { version: redactText(version) }), ...(schemaUrl === undefined ? {} : { schemaUrl: redactText(schemaUrl) }), ...(attributes === undefined ? {} : { attributes: cleanAttributes(attributes, options) }) } as ReadableSpan["instrumentationScope"];
}

/**
 * Wraps any exporter so that no span leaves the process unredacted: the name, attributes, event and link attributes, the status message and the resource are cleaned first, by
 * the same rules as logs. Prompts and tool bodies are removed by name unless `captureContent` is on (pi's spans carry none); credentials never are. `enrich` adds facts that are
 * known only outside the span, such as the public id of the chat a conversation number belongs to; what it adds is cleaned too.
 */
export class RedactingSpanExporter implements SpanExporter {
	readonly #inner: SpanExporter;
	readonly #options: RedactOptions;
	readonly #enrich: ((spans: readonly ReadableSpan[]) => Promise<ReadonlyMap<ReadableSpan, Attributes>>) | undefined;
	readonly #enrichTimeoutMs: number;
	#closed = false;
	constructor(inner: SpanExporter, options: RedactOptions = {}, enrich?: (spans: readonly ReadableSpan[]) => Promise<ReadonlyMap<ReadableSpan, Attributes>>, enrichTimeoutMs = 2000) {
		this.#inner = inner;
		this.#options = options;
		this.#enrich = enrich;
		this.#enrichTimeoutMs = enrichTimeoutMs;
	}
	export(spans: ReadableSpan[], done: Parameters<SpanExporter["export"]>[1]): void {
		if (this.#closed) return done({ code: ExportResultCode.FAILED });
		let sent = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Once: whichever of the enrichment and its deadline comes first sends the batch, and the other does nothing. A batch is never sent after shutdown.
		const send = (extra: ReadonlyMap<ReadableSpan, Attributes>) => {
			if (sent) return;
			sent = true;
			clearTimeout(timer);
			if (this.#closed) return done({ code: ExportResultCode.FAILED });
			this.#inner.export(spans.map((span) => this.#clean(span, extra.get(span))), done);
		};
		if (!this.#enrich) return send(new Map());
		// An enrichment that fails or runs past its deadline sends the spans as they are: telemetry is never worth losing to a lookup.
		timer = setTimeout(() => send(new Map()), this.#enrichTimeoutMs);
		this.#enrich(spans).then(send, () => send(new Map()));
	}
	shutdown(): Promise<void> {
		this.#closed = true;
		return this.#inner.shutdown();
	}
	forceFlush(): Promise<void> {
		return this.#inner.forceFlush?.() ?? Promise.resolve();
	}
	#clean(span: ReadableSpan, extra: Attributes | undefined): ReadableSpan {
		const o = this.#options;
		const clean = (attributes: Attributes | undefined) => cleanAttributes(attributes, o);
		return patched(span, {
			name: redactText(span.name),
			status: cleanStatus(span.status, o),
			attributes: clean(extra ? { ...span.attributes, ...extra } : span.attributes),
			links: span.links.map((l) => ({ ...l, attributes: clean(l.attributes) })),
			events: span.events.map((e) => ({ ...e, name: redactText(e.name), attributes: clean(e.attributes) })),
			resource: resourceFromAttributes(redactAttributes(span.resource.attributes as Record<string, unknown>, o) as Attributes),
			instrumentationScope: cleanScope(span.instrumentationScope, o),
		});
	}
}

/** Adds Langfuse's own attributes to already-clean spans, so Langfuse shows model calls as generations and tool phases as tools. */
export class LangfuseSpanExporter implements SpanExporter {
	readonly #inner: SpanExporter;
	readonly #options: LangfuseOptions;
	constructor(inner: SpanExporter, options: LangfuseOptions = {}) {
		this.#inner = inner;
		this.#options = options;
	}
	export(spans: ReadableSpan[], done: Parameters<SpanExporter["export"]>[1]): void {
		this.#inner.export(spans.map((span) => patched(span, langfuseAttributes(span, this.#options))), done);
	}
	shutdown(): Promise<void> {
		return this.#inner.shutdown();
	}
	forceFlush(): Promise<void> {
		return this.#inner.forceFlush?.() ?? Promise.resolve();
	}
}

export type OtlpOptions = {
	/** How long one request may take before it is given up; default 10 s. */
	readonly timeoutMs?: number;
	/** Told of each batch that could not be delivered, with a reason that holds no content; never throws into the exporter. */
	readonly onError?: (reason: string) => void;
	readonly fetch?: typeof fetch;
};

/** OTLP/HTTP JSON exporter, the protocol every backend takes. One attempt per batch; a failed batch is dropped. Shutdown aborts requests still in flight. */
export function otlpHttpExporter(url: string, headers: Record<string, string> = {}, options: OtlpOptions = {}): SpanExporter {
	const send = options.fetch ?? fetch;
	const pending = new Set<AbortController>();
	let closed = false;
	return {
		export(spans, done) {
			if (closed) return done({ code: ExportResultCode.FAILED });
			const abort = new AbortController();
			pending.add(abort);
			const timer = setTimeout(() => abort.abort(new Error("timeout")), options.timeoutMs ?? 10_000);
			send(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JsonTraceSerializer.serializeRequest(spans), signal: abort.signal })
				.then(async (response) => {
					await response.body?.cancel().catch(() => undefined);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					done({ code: ExportResultCode.SUCCESS });
				})
				.catch((error: unknown) => {
					const reason = abort.signal.aborted ? "timed out or shut down" : error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : "request failed";
					try {
						options.onError?.(reason);
					} catch {
						// A reporter that throws must not reach the exporter.
					}
					done({ code: ExportResultCode.FAILED, error: new Error(reason) });
				})
				.finally(() => {
					clearTimeout(timer);
					pending.delete(abort);
				});
		},
		shutdown: async () => {
			closed = true;
			for (const abort of pending) abort.abort(new Error("shutdown"));
		},
	};
}

export type TelemetryOptions = {
	readonly serviceName: string;
	readonly serviceVersion?: string;
	/** Further resource attributes, such as the process's role. */
	readonly resource?: Record<string, string>;
	readonly exporter: SpanExporter;
	/** Facts to add to spans just before export; see `RedactingSpanExporter`. */
	readonly enrich?: (spans: readonly ReadableSpan[]) => Promise<ReadonlyMap<ReadableSpan, Attributes>>;
	/** Present when the backend is Langfuse. */
	readonly langfuse?: LangfuseOptions;
	/** Keep message content in spans (still without credentials). Pi's spans hold none; only for a library user's own spans. Off by default. */
	readonly captureContent?: boolean;
	/** The queue of finished spans waiting for export; a span arriving when it is full is dropped. Default 2048. */
	readonly maxQueueSize?: number;
	readonly maxExportBatchSize?: number;
	readonly scheduledDelayMs?: number;
	readonly exportTimeoutMs?: number;
	/** How long a batch waits for `enrich` before it is sent without it; default 2 s. */
	readonly enrichTimeoutMs?: number;
};

export type TracerHandle = {
	readonly provider: TracerProvider;
	/** Sends what is queued and stops, within `timeoutMs` (default 5 s): what a slow collector has not taken by then is dropped. */
	shutdown(timeoutMs?: number): Promise<void>;
	forceFlush(timeoutMs?: number): Promise<void>;
};

const within = (work: Promise<unknown>, ms: number) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		work.then(
			() => (clearTimeout(timer), resolve()),
			() => (clearTimeout(timer), resolve()),
		);
	});

/** A private tracer provider (never registered as the global one). Spans leave in this order: enriched and redacted, then mapped for Langfuse when asked, then sent. */
export function createTracerProvider(options: TelemetryOptions): TracerHandle {
	const sink = options.langfuse ? new LangfuseSpanExporter(options.exporter, options.langfuse) : options.exporter;
	const processor = new BatchSpanProcessor({
		exporter: new RedactingSpanExporter(sink, { captureContent: options.captureContent ?? false }, options.enrich, options.enrichTimeoutMs),
		maxQueueSize: options.maxQueueSize ?? 2048,
		maxExportBatchSize: options.maxExportBatchSize ?? 256,
		scheduledDelayMillis: options.scheduledDelayMs ?? 5000,
		exportTimeoutMillis: options.exportTimeoutMs ?? 15_000,
	});
	const provider = new TracerProvider({
		resource: resourceFromAttributes({ "service.name": options.serviceName, ...(options.serviceVersion ? { "service.version": options.serviceVersion } : {}), ...options.resource }),
		spanProcessors: [processor],
	});
	return {
		provider,
		shutdown: async (timeoutMs = 5000) => {
			await within(provider.shutdown(), timeoutMs);
			// A request still in flight after the wait is aborted by the exporter's shutdown.
			await within(options.exporter.shutdown(), 1000);
		},
		forceFlush: (timeoutMs = 5000) => within(provider.forceFlush(), timeoutMs),
	};
}

export type TelemetryConfig = { readonly enabled: false; readonly warnings: readonly string[] } | { readonly enabled: true; readonly url: string; readonly headers: Record<string, string>; readonly serviceName: string; readonly profile: "langfuse" | "generic"; readonly warnings: readonly string[] };

/**
 * Parses `OTEL_EXPORTER_OTLP_HEADERS`: `key=value` pairs separated by commas, split at the first `=` only, so a Basic credential keeps its base64 padding; values may be
 * percent-encoded, as the OpenTelemetry specification says. A pair that is not valid is skipped.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const pair of (raw ?? "").split(",")) {
		const at = pair.indexOf("=");
		if (at < 1) continue;
		const name = pair.slice(0, at).trim().toLowerCase();
		let value = pair.slice(at + 1).trim();
		if (value.includes("%")) {
			try {
				value = decodeURIComponent(value);
			} catch {
				// Not percent-encoding after all: sent as written.
			}
		}
		if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || /[\u0000-\u001f\u007f]/.test(value)) continue;
		headers[name] = value;
	}
	return headers;
}

/**
 * What the OpenTelemetry variables ask for. Nothing is thrown: an endpoint that is missing, not an http(s) address, or asks for gRPC means no exporter, with a warning that holds
 * no part of the endpoint (which can carry a key). A Langfuse endpoint (`/api/public/otel`) gets Langfuse's real-time ingestion header unless one is set.
 */
export function telemetryConfigFromEnv(env: NodeJS.ProcessEnv, service: string): TelemetryConfig {
	const set = (name: string) => env[name]?.trim() || undefined;
	const traces = set("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
	const base = set("OTEL_EXPORTER_OTLP_ENDPOINT");
	const endpoint = traces ?? (base ? `${base.replace(/\/+$/, "")}/v1/traces` : undefined);
	if (endpoint === undefined) return { enabled: false, warnings: [] };
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return { enabled: false, warnings: ["The OTLP endpoint is not a URL; traces are off."] };
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") return { enabled: false, warnings: ["The OTLP endpoint must be an http or https URL without a username or password; traces are off."] };
	const protocol = set("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL") ?? set("OTEL_EXPORTER_OTLP_PROTOCOL");
	if (protocol === "grpc") return { enabled: false, warnings: ["Pim sends OTLP over HTTP as JSON; gRPC is not supported, so traces are off."] };
	const warnings = protocol === "http/protobuf" ? ["Pim sends OTLP over HTTP as JSON, whatever the protocol variable says."] : [];
	const headers = parseOtlpHeaders(set("OTEL_EXPORTER_OTLP_TRACES_HEADERS") ?? set("OTEL_EXPORTER_OTLP_HEADERS"));
	const profile = set("PIM_TRACES_PROFILE") === "generic" ? "generic" : set("PIM_TRACES_PROFILE") === "langfuse" || url.pathname.startsWith("/api/public/otel") ? "langfuse" : "generic";
	if (profile === "langfuse" && headers["x-langfuse-ingestion-version"] === undefined) headers["x-langfuse-ingestion-version"] = "4";
	return { enabled: true, url: url.toString(), headers, serviceName: set("OTEL_SERVICE_NAME") ?? service, profile, warnings };
}
