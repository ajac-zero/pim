// Providers reuse a cached prompt only up to the first byte that differs from an earlier request. pi-ai folds every system patch into the one system message that leads the request
// (`resolveTranscript`), and the AI gateway hoists system messages the same way, so a memory or goal that changes mid-chat would rewrite the start of the request while the history after
// it is identical, and the whole prompt would be read again. Here the sections that change while a chat runs are held at what the system message said when the chat (or its last
// compaction) began, and what has changed since goes after the history, as a message from the person's side. The harness stores nothing different: this is applied to each request.

/** The prompt sections whose text changes while a chat runs; every other section is written once and left in the system message. */
export const VOLATILE_SECTIONS = ["memory", "active_goals", "room"] as const;

const volatile = new Set<string>(VOLATILE_SECTIONS);

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
	const text = `[Context update] These sections changed after the system prompt above was written. Each replaces the section of the same name there; treat them as current.\n\n${[...updates, ...gone].join("\n\n")}`;
	return { ...context, messages: [...messages, { role: "user", content: text, timestamp: last?.timestamp ?? 0 }] };
}
