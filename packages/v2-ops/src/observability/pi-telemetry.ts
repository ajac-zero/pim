// The adapter between pi's telemetry contract (@earendil-works/pi-telemetry) and OpenTelemetry. pi-durable and pi-ai describe what they did as spans
// (`pi.durable.submit`, `pi.durable.phase`, `pi.ai.request`); this adapter only records those spans on a tracer and keeps what a span needs to be found again
// later: its carrier. It adds no spans of its own and never reads a global provider, so it works beside any other OpenTelemetry use in the process.

import { type Attributes, ROOT_CONTEXT, type Link, type Span, type SpanContext, SpanStatusCode, type Tracer, TraceFlags, trace } from "@opentelemetry/api";
import type { SpanAttributes, SpanLink, SpanOptions, SpanStatus, TelemetryCarrier, TelemetryContext, TelemetryPropagation, TelemetrySpan } from "@earendil-works/pi-telemetry";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
/** The attribute and carrier key that name the durable conversation a trace belongs to, so work that resumes later (an approval, a restart) is still the chat's. */
export const CONVERSATION_KEY = "pim.conversation";

const defined = (attributes: SpanAttributes | undefined): Attributes => Object.fromEntries(Object.entries(attributes ?? {}).filter(([, v]) => v !== undefined)) as Attributes;
const failure = (error: unknown) => (error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) });

/** The context handle shared by the root, spans and extracted parents: where new work belongs, and the conversation it carries along. */
class Handle implements TelemetryContext {
	readonly propagation: TelemetryPropagation;
	readonly #adapter: PiTelemetry;
	readonly context: SpanContext | undefined;
	readonly conversation: string | undefined;
	constructor(adapter: PiTelemetry, context: SpanContext | undefined, conversation: string | undefined) {
		this.#adapter = adapter;
		this.propagation = adapter;
		this.context = context;
		this.conversation = conversation;
	}
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return this.#adapter.start(this, options, callback);
	}
}

/** A started span: also the parent context of the spans started from it. */
class SpanHandle extends Handle implements TelemetrySpan {
	readonly #span: Span;
	#settled = false;
	#explicit = false;
	get settled(): boolean {
		return this.#settled;
	}
	constructor(adapter: PiTelemetry, span: Span, conversation: string | undefined) {
		super(adapter, span.spanContext(), conversation);
		this.#span = span;
	}
	addLink(link: SpanLink): void {
		const target = link.context instanceof Handle ? link.context.context : undefined;
		if (this.#settled || target === undefined) return;
		this.#span.addLink({ context: target, ...(link.attributes ? { attributes: defined(link.attributes) } : {}) });
	}
	addEvent(name: string, attributes?: SpanAttributes): void {
		if (!this.#settled) this.#span.addEvent(name, defined(attributes));
	}
	setAttributes(attributes: SpanAttributes): void {
		if (!this.#settled) this.#span.setAttributes(defined(attributes));
	}
	setStatus(status: SpanStatus): void {
		if (this.#settled) return;
		this.#explicit = true;
		this.#set(status);
	}
	/** Settlement: an explicit status stays, otherwise the callback's outcome decides. */
	end(error?: { name: string; message: string }): void {
		if (this.#settled) return;
		if (!this.#explicit) this.#set(error ? { status: "error", error } : { status: "ok" });
		this.#settled = true;
		this.#span.end();
	}
	#set(status: SpanStatus): void {
		if (status.status === "ok") this.#span.setStatus({ code: SpanStatusCode.OK });
		else this.#span.setStatus({ code: SpanStatusCode.ERROR, ...(status.error ? { message: `${status.error.name}: ${status.error.message}` } : {}) });
	}
}

/** What work started under a span that has already settled gets: the callback runs, nothing is recorded. */
class InertSpan implements TelemetrySpan {
	readonly propagation: TelemetryPropagation;
	constructor(propagation: TelemetryPropagation) {
		this.propagation = propagation;
	}
	addLink(): void {}
	addEvent(): void {}
	setAttributes(): void {}
	setStatus(): void {}
	startSpan<T>(_options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		try {
			return Promise.resolve(callback(this));
		} catch (error) {
			return Promise.reject(error);
		}
	}
}

export type PiTelemetryOptions = {
	readonly tracer: Tracer;
	/** Attributes on every span of this adapter: what is known about the partition it was made for, never content. */
	readonly attributes?: Attributes;
};

/** Records pi's spans on an OpenTelemetry tracer. `context` is the root to give pi (`HarnessOptions.telemetry`); it also carries the propagation capability. */
export class PiTelemetry implements TelemetryPropagation {
	readonly context: TelemetryContext;
	readonly #tracer: Tracer;
	readonly #attributes: Attributes;
	constructor(options: PiTelemetryOptions) {
		this.#tracer = options.tracer;
		this.#attributes = options.attributes ?? {};
		this.context = new Handle(this, undefined, undefined);
	}

	/** @internal Starts a span under `parent`, runs `callback` once, and ends the span when its value or promise settles. */
	start<T>(parent: Handle, options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		if (parent instanceof SpanHandle && parent.settled) return new InertSpan(this).startSpan(options, callback);
		const given = options.attributes?.["conversation.id"];
		const conversation = parent.conversation ?? (typeof given === "number" ? String(given) : undefined);
		const links: Link[] = (options.links ?? []).flatMap((link) => (link.context instanceof Handle && link.context.context ? [{ context: link.context.context, ...(link.attributes ? { attributes: defined(link.attributes) } : {}) }] : []));
		const attributes = { ...this.#attributes, ...(conversation === undefined ? {} : { [CONVERSATION_KEY]: Number(conversation) }), ...defined(options.attributes) };
		const parentContext = parent.context ? trace.setSpanContext(ROOT_CONTEXT, parent.context) : ROOT_CONTEXT;
		const span = new SpanHandle(this, this.#tracer.startSpan(options.name, { attributes, links }, parentContext), conversation);
		let result: T | Promise<T>;
		try {
			result = callback(span);
		} catch (error) {
			span.end(failure(error));
			return Promise.reject(error);
		}
		return Promise.resolve(result).then(
			(value) => {
				span.end();
				return value;
			},
			(error: unknown) => {
				span.end(failure(error));
				throw error;
			},
		);
	}

	inject(context: TelemetryContext): TelemetryCarrier | undefined {
		if (!(context instanceof Handle) || context.context === undefined) return undefined;
		const { traceId, spanId, traceFlags } = context.context;
		return { traceparent: `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, "0")}`, ...(context.conversation === undefined ? {} : { [CONVERSATION_KEY]: context.conversation }) };
	}

	extract(carrier: TelemetryCarrier | undefined): TelemetryContext {
		const match = typeof carrier?.traceparent === "string" ? TRACEPARENT.exec(carrier.traceparent) : null;
		if (!carrier || !match) return this.context;
		const conversation = typeof carrier[CONVERSATION_KEY] === "string" ? carrier[CONVERSATION_KEY] : undefined;
		return new Handle(this, { traceId: match[1]!, spanId: match[2]!, traceFlags: Number.parseInt(match[3]!, 16) & TraceFlags.SAMPLED, isRemote: true }, conversation);
	}
}
