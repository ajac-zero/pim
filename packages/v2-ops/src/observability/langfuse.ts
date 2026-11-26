// What Langfuse needs on top of pi's native spans, added at the export boundary and never in the code that runs agents. Pi's own names and attributes stay as they are in
// the process; for Langfuse a model request becomes a generation (model, usage, cost) and a tool phase becomes a tool, and every span carries the trace-level fields Langfuse
// reads from any span of a trace: session (the chat), user (an opaque owner reference), release and environment. Only clean attributes go in: this runs after redaction.

import type { ReadableSpan } from "@opentelemetry/sdk-trace";

type Attributes = ReadableSpan["attributes"];

export type LangfuseOptions = {
	readonly release?: string;
	readonly environment?: string;
};

const REQUESTS = new Set(["pi.ai.request", "pi.ai.poll"]);
/** Trace metadata Langfuse can filter on, from what Pim adds to its spans. */
const METADATA: readonly (readonly [attribute: string, key: string])[] = [
	["pim.agent", "agent"],
	["pim.partition.id", "partition"],
	["pim.role", "role"],
	["pim.started_by.chat", "started_by_chat"],
	["pim.started_by.task", "started_by_task"],
];

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The span's name and attributes as Langfuse should read them. */
export function langfuseAttributes(span: ReadableSpan, options: LangfuseOptions): Pick<ReadableSpan, "name" | "attributes"> {
	const from = span.attributes;
	const out: Record<string, unknown> = { ...from };
	let name = span.name;
	const chat = text(from["pim.chat"]);
	const owner = text(from["pim.owner.ref"]);
	if (chat) out["langfuse.session.id"] = chat;
	if (owner) out["langfuse.user.id"] = owner;
	if (options.release) out["langfuse.release"] = options.release;
	if (options.environment) out["langfuse.environment"] = options.environment;
	for (const [attribute, key] of METADATA) if (from[attribute] !== undefined) out[`langfuse.trace.metadata.${key}`] = String(from[attribute]);

	if (REQUESTS.has(span.name)) {
		out["langfuse.observation.type"] = "generation";
		const model = text(from.model);
		if (model) out["langfuse.observation.model.name"] = model;
		const provider = text(from.provider);
		if (provider) out["langfuse.observation.metadata.provider"] = provider;
		const reasoning = text(from.reasoning);
		if (reasoning) out["langfuse.observation.model.parameters"] = JSON.stringify({ reasoning });
		// Pi's counts are what one request used: input is the uncached part, so Langfuse adds the cache tiers to it and nothing is counted twice. A request that failed before it answered used nothing that was measured, so it has none.
		const usage: Record<string, number> = {};
		for (const [key, attribute] of [["input", "usage.input"], ["output", "usage.output"], ["cache_read_input_tokens", "usage.cache_read"], ["cache_creation_input_tokens", "usage.cache_write"]] as const) {
			const n = count(from[attribute]);
			if (n !== undefined && (n > 0 || key === "input" || key === "output")) usage[key] = n;
		}
		if (Object.values(usage).some((n) => n > 0)) out["langfuse.observation.usage_details"] = JSON.stringify(usage);
		// Pim's ledger treats a request with tokens and no cost as unpriced, and so does this: a price that is not known is not sent as zero, and Langfuse is left to price it, or not.
		const cost = count(from["cost.total"]);
		if (cost !== undefined && cost > 0) out["langfuse.observation.cost_details"] = JSON.stringify({ total: cost });
		// The native copies would show again under metadata.
		for (const key of ["usage.input", "usage.output", "usage.cache_read", "usage.cache_write", "cost.total", "model", "provider", "reasoning"]) delete out[key];
	} else if (span.name === "pi.durable.phase" && text(from["tool.name"])) {
		out["langfuse.observation.type"] = "tool";
		name = text(from["tool.name"])!;
	}
	return { name, attributes: out as Attributes };
}
