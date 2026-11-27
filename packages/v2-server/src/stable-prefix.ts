// Providers reuse a cached prompt only up to the first byte that differs from an earlier request. pi-ai folds every system patch into the one system message that leads the request
// (`resolveTranscript`), and the AI gateway hoists system messages the same way, so a memory that changes mid-chat would rewrite the start of the request while the history after
// it is identical, and the whole prompt would be read again. The harness stores each change of a section as a system patch in the history, at the point the change was first seen
// (`planSystemEntries` in pi-durable, before the model call that follows a user message or tool results). Here the sections that change while a chat runs stay at what the system
// message said when the chat (or its last compaction) began, and each later patch of one becomes a user message at the patch's own position, so a change is sent once and every later
// request carries it at the same place, byte for byte, as part of the history the provider has cached. Nothing new is stored: this is applied to each request.

/** The prompt sections whose text changes while a chat runs; every other section is written once and left in the system message. */
export const VOLATILE_SECTIONS = ["memory", "room"] as const;

const volatile = new Set<string>(VOLATILE_SECTIONS);

/** What the message that carries a change begins with. */
const CONTEXT_UPDATE = "[Context update] These sections changed after the system prompt above was written.";

const hasSections = (message: any) => message.role === "system" && message.sections !== undefined && Object.keys(message.sections).length > 0;

/**
 * The context with every volatile section as the first system message that carries sections had it. A later patch to one becomes a user message ("[Context update]") where the patch is
 * in the history, holding the current text of the sections it changed, or saying one is empty now; a section a patch sets to the text already shown is not repeated. Only the changed
 * sections are in it, and the update after it holds only what changed since. The result is the same for the same history, and a request's history leads the next one's unchanged, so
 * repeated requests share a prefix. An update waits until the tool results it follows have all been placed, so it never comes between a tool call and its result.
 */
export function withStablePrefix<C extends { messages: any[] }>(context: C): C {
	const first = context.messages.findIndex(hasSections);
	if (first < 0) return context;
	const shown = new Map<string, string>();
	let pending = new Map<string, string | null>();
	let at = 0;
	let changed = false;
	const messages: any[] = [];
	const flush = () => {
		const texts: string[] = [];
		for (const [key, value] of pending) {
			if (value === null ? !shown.has(key) : shown.get(key) === value) continue;
			texts.push(value ?? `<${key}>\nNothing now.\n</${key}>`);
			if (value === null) shown.delete(key);
			else shown.set(key, value);
		}
		pending = new Map();
		if (texts.length > 0) messages.push({ role: "user", content: `${CONTEXT_UPDATE} Each replaces the section of the same name there; treat them as current.\n\n${texts.join("\n\n")}`, timestamp: at });
	};
	context.messages.forEach((message, index) => {
		if (message.role !== "system" && message.role !== "toolResult" && pending.size > 0) flush();
		if (!hasSections(message) || index === first) {
			for (const [key, value] of Object.entries<string | null>(message.sections ?? {})) if (index === first && volatile.has(key) && value !== null) shown.set(key, value);
			messages.push(message);
			return;
		}
		const kept: Record<string, string | null> = {};
		for (const [key, value] of Object.entries<string | null>(message.sections)) {
			if (!volatile.has(key)) kept[key] = value;
			else pending.set(key, value);
		}
		if (Object.keys(kept).length === Object.keys(message.sections).length) return void messages.push(message);
		changed = true;
		at = message.timestamp;
		// A patch of nothing but volatile sections leaves no message behind.
		if (Object.keys(kept).length > 0 || message.content || message.toolsAdded || message.toolsRemoved) messages.push({ ...message, sections: kept });
	});
	flush();
	return changed ? { ...context, messages } : context;
}
