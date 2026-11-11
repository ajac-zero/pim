/**
 * The ```ui-response trailer that follows the readable Markdown of a turn a
 * form sent: the form's block, what its fields held and how each did, as
 * JSON in its own fence. The app reads it to show the turn compactly and to
 * lock the form again after a reload; the model sees the whole turn as the
 * person's message, and answers it from the readable part.
 */

/** How a form was answered, as its trailer says. */
export type UiResponse = {
	/** The form's id, the block it answers. */
	block: string;
	/** The message the block was drawn in, when it is known. */
	messageId?: string;
	/** What each field held, by its key. */
	values: Record<string, string>;
	/** How each graded field did, by its key. */
	graded: Record<string, boolean>;
};

/** The fence a trailer rides in, alone on its lines. */
const TRAILER = /```ui-response[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/g;

/** Whether a value is a record of strings, as a trailer's values must be. */
function strings(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every((field) => typeof field === "string");
}

/** Whether a value is a record of booleans, as a trailer's marks must be. */
function marks(value: unknown): value is Record<string, boolean> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every((field) => typeof field === "boolean");
}

/** The last trailer in a message, or null when it has none. */
export function uiResponseOf(text: string): UiResponse | null {
	for (const match of text.matchAll(TRAILER)) {
		const body = match[1];
		if (body === undefined) continue;
		try {
			const parsed: unknown = JSON.parse(body);
			if (typeof parsed !== "object" || parsed === null) continue;
			const { block, messageId, values, graded } = parsed as Record<string, unknown>;
			if (typeof block !== "string" || !strings(values) || !marks(graded)) continue;
			return { block, values, graded, ...(messageId !== undefined && typeof messageId === "string" ? { messageId } : {}) };
		} catch {
			// Not a trailer: a fence that only looks like one.
		}
	}
	return null;
}

/** A message with its trailer taken out, and what the trailer said. */
export function splitUiResponse(text: string): { readable: string; response: UiResponse } | null {
	const response = uiResponseOf(text);
	if (response === null) return null;
	return { readable: text.replace(TRAILER, "").trim(), response };
}

/** A turn as a form sends it: its readable Markdown, then its trailer. */
export function uiTurn(markdown: string, response: UiResponse): string {
	const trailer = ["```ui-response", JSON.stringify(response), "```"].join("\n");
	return `${markdown}\n\n${trailer}`;
}
