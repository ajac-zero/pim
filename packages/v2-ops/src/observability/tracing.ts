import { ExportResultCode } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import { type RedactOptions, redactAttributes, redactText } from "./redact.ts";

/**
 * Wraps any exporter so that no span leaves the process unredacted: attributes, event attributes, link attributes, the status message and the
 * span name are cleaned first, by the same rules as logs. Prompts and tool bodies are removed unless `captureContent` is on; credentials never are.
 */
export class RedactingSpanExporter implements SpanExporter {
	readonly #inner: SpanExporter;
	readonly #options: RedactOptions;
	constructor(inner: SpanExporter, options: RedactOptions = {}) {
		this.#inner = inner;
		this.#options = options;
	}
	export(spans: ReadableSpan[], done: Parameters<SpanExporter["export"]>[1]): void {
		this.#inner.export(spans.map((span) => this.#clean(span)), done);
	}
	shutdown(): Promise<void> {
		return this.#inner.shutdown();
	}
	forceFlush(): Promise<void> {
		return this.#inner.forceFlush?.() ?? Promise.resolve();
	}
	#clean(span: ReadableSpan): ReadableSpan {
		const o = this.#options;
		return {
			name: redactText(span.name),
			kind: span.kind,
			spanContext: () => span.spanContext(),
			parentSpanContext: span.parentSpanContext,
			startTime: span.startTime,
			endTime: span.endTime,
			status: span.status.message === undefined ? span.status : { ...span.status, message: redactText(span.status.message) },
			attributes: redactAttributes(span.attributes as Record<string, unknown>, o) as ReadableSpan["attributes"],
			links: span.links.map((l) => ({ ...l, attributes: redactAttributes(l.attributes as Record<string, unknown> | undefined, o) as typeof l.attributes })),
			events: span.events.map((e) => ({ ...e, name: redactText(e.name), attributes: redactAttributes(e.attributes as Record<string, unknown> | undefined, o) as typeof e.attributes })),
			duration: span.duration,
			ended: span.ended,
			resource: span.resource,
			instrumentationScope: span.instrumentationScope,
			droppedAttributesCount: span.droppedAttributesCount,
			droppedEventsCount: span.droppedEventsCount,
			droppedLinksCount: span.droppedLinksCount,
		};
	}
}

/** OTLP/HTTP JSON exporter, the protocol that needs no extra runtime. */
export function otlpHttpExporter(url: string, headers: Record<string, string> = {}): SpanExporter {
	return {
		export(spans, done) {
			fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JsonTraceSerializer.serializeRequest(spans), signal: AbortSignal.timeout(10_000) })
				.then((response) => {
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					done({ code: ExportResultCode.SUCCESS });
				})
				.catch((error: unknown) => done({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) }));
		},
		shutdown: async () => undefined,
	};
}

export type TelemetryOptions = {
	readonly serviceName: string;
	/** OTLP traces endpoint; unset exports nothing but still records through `exporter` when given. */
	readonly otlpEndpoint?: string;
	readonly otlpHeaders?: Record<string, string>;
	readonly exporter?: SpanExporter;
	readonly captureContent?: boolean;
	/** Export synchronously (tests); otherwise batched. */
	readonly sync?: boolean;
};

/** A tracer provider whose every export passes through the redacting wrapper. Content capture follows the standard GenAI variable. */
export function createTracerProvider(options: TelemetryOptions): { provider: TracerProvider; shutdown(): Promise<void> } | null {
	const inner = options.exporter ?? (options.otlpEndpoint ? otlpHttpExporter(options.otlpEndpoint, options.otlpHeaders) : null);
	if (!inner) return null;
	const exporter = new RedactingSpanExporter(inner, { captureContent: options.captureContent ?? false });
	const provider = new TracerProvider({
		resource: resourceFromAttributes({ "service.name": options.serviceName }),
		spanProcessors: [new BatchSpanProcessor({ exporter, ...(options.sync ? { scheduledDelayMillis: 1, maxExportBatchSize: 1 } : {}) })],
	});
	return { provider, shutdown: () => provider.shutdown() };
}

/** Reads the same variables Pim's Worker reads: OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT, OTEL_SERVICE_NAME and OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT. */
export function telemetryFromEnv(env: NodeJS.ProcessEnv, service: string) {
	const base = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces` : undefined);
	const headers = Object.fromEntries((env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",").filter(Boolean).map((p) => p.split("=").map((s) => s.trim()) as [string, string]));
	return createTracerProvider({ serviceName: env.OTEL_SERVICE_NAME ?? service, otlpEndpoint: base, otlpHeaders: headers, captureContent: env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === "true" });
}
