// Providers reuse a cached prompt only up to the first byte that differs from an earlier request. pi-ai folds every system patch into the one system message that leads the request
// (`resolveTranscript`), and the AI gateway hoists system messages the same way, so a memory or goal that changes mid-chat would rewrite the start of the request while the history after
// it is identical, and the whole prompt would be read again. Here the sections that change while a chat runs are held at what the system message said when the chat (or its last
// compaction) began, and what has changed since goes after the history, as a message from the person's side. The harness stores nothing different: this is applied to each request.

/** The prompt sections whose text changes while a chat runs; every other section is written once and left in the system message. */
export const VOLATILE_SECTIONS = ["memory", "active_goals", "room"] as const;

const volatile = new Set<string>(VOLATILE_SECTIONS);

/** What the message that carries the changes begins with. */
const CONTEXT_UPDATE = "[Context update] These sections changed after the system prompt above was written.";

const hasSections = (message: any) => message.role === "system" && message.sections !== undefined && Object.keys(message.sections).length > 0;

/**
 * The context with every volatile section as the first system message that carries sections had it. A later change to one goes at the end of the history in a single user message
 * ("[Context update]") that holds the section's current text, or says it is empty now. The result is the same for the same history and sections, so repeated requests share a prefix.
 */
export function withStablePrefix<C extends { messages: any[] }>(context: C): C {
	const first = context.messages.findIndex(hasSections);
	if (first < 0) return context;
	const current = new Map<string, string>();
	const baseline = new Map<string, string>();
	let changed = false;
	const messages = context.messages.map((message, index) => {
		if (!hasSections(message)) return message;
		const kept: Record<string, string | null> = {};
		for (const [key, value] of Object.entries<string | null>(message.sections)) {
			if (!volatile.has(key)) {
				kept[key] = value;
				continue;
			}
			if (value === null) current.delete(key);
			else current.set(key, value);
			if (index === first) {
				if (value !== null) baseline.set(key, value);
				kept[key] = value;
			}
		}
		if (Object.keys(kept).length === Object.keys(message.sections).length) return message;
		changed = true;
		return { ...message, sections: kept };
	});
	const updates = [...current].filter(([key, text]) => baseline.get(key) !== text).map(([, text]) => text);
	const gone = [...baseline.keys()].filter((key) => !current.has(key)).map((key) => `<${key}>\nNothing now.\n</${key}>`);
	if (updates.length + gone.length === 0) return changed ? { ...context, messages } : context;
	const last = context.messages[context.messages.length - 1];
	const text = `${CONTEXT_UPDATE} Each replaces the section of the same name there; treat them as current.\n\n${[...updates, ...gone].join("\n\n")}`;
	return { ...context, messages: [...messages, { role: "user", content: text, timestamp: last?.timestamp ?? 0 }] };
}

/** The blocks Anthropic takes a cache breakpoint on, as pi-ai's adapter marks them. */
const MARKABLE = new Set(["text", "image", "tool_result", "tool_addition", "tool_removal"]);

/**
 * Anthropic writes a prompt to its cache only at a cache breakpoint, and pi-ai's adapter puts one on the last block of the request. With the context update there, that block is the update, which
 * the next request will not have where this one did: it has the tool round that followed and then its own copy of the update, so the history this request wrote has no breakpoint to be read at,
 * and only the tools and the system prompt, which have their own, were. This moves the breakpoint from the update to the block before it, the end of the history, so what a request writes is what
 * the next one starts with (the update, a few hundred tokens, is sent uncached each time). It moves the marker and adds none, so the 4 breakpoints a request may have are not exceeded.
 * Returns the body of an Anthropic Messages request so changed, or undefined when it has no update, no marker on it, or no block before it that can carry one.
 */
export function markHistoryBeforeUpdate(body: any): any | undefined {
	if (!Array.isArray(body?.messages)) return undefined;
	const blocksOf = (message: any): any[] => (typeof message?.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message?.content) ? message.content : []);
	const places = (body.messages as any[]).flatMap((message, m) => blocksOf(message).map((block, b) => ({ m, b, block })));
	// The update is the very last block of the request (the effort markers after it have no blocks), so text that only begins like it, anywhere else, is never taken for it.
	const update = places.length - 1;
	const last = places[update]?.block;
	const marker = last?.type === "text" && typeof last.text === "string" && last.text.startsWith(CONTEXT_UPDATE) ? last.cache_control : undefined;
	const before = places[update - 1];
	if (!marker || !before || !MARKABLE.has(before.block.type)) return undefined;
	const messages = (body.messages as any[]).slice();
	const edit = (place: { m: number; b: number }, change: (block: any) => any) => {
		messages[place.m] = { ...messages[place.m], content: blocksOf(messages[place.m]).map((block, b) => (b === place.b ? change(block) : block)) };
	};
	edit(places[update]!, ({ cache_control: _gone, ...bare }) => bare);
	edit(before, (block) => ({ ...block, cache_control: marker }));
	return { ...body, messages };
}
