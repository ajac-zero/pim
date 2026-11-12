/**
 * The ```ui-response trailer that follows the readable Markdown of a turn a
 * form sent: the form's block, what its fields held and how each did, as
 * JSON in its own fence. The app reads it to show the turn compactly and to
 * lock the form again after a reload; the model sees the whole turn as the
 * person's message, and answers it from the readable part.
 */

import { MAX_RESPONSE_STATE_BYTES, MAX_TURN_BYTES } from "./limits";
import { fieldsOf, type UiProgram } from "./program";
import { isStorable } from "./state";
import { stringOf, type UiState, type Value } from "./value";

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
	/** What the rest of the block held when the form was sent, by key: its sliders, checkboxes and declared state. Old trailers have none. */
	state?: Record<string, Value>;
};

/**
 * What a block holds outside its forms' fields, for a turn to carry: its
 * sliders, checkboxes and declared state, in the order the block declares
 * them. Whatever would take the whole beyond MAX_RESPONSE_STATE_BYTES is
 * left out, so a block can't make a turn larger than the app will send.
 */
export function extraState(program: UiProgram, state: UiState): Record<string, Value> {
	const inForms = new Set(fieldsOf(program).map((field) => field.key));
	const kept: Record<string, Value> = {};
	// The size the trailer's JSON object will have: its braces, then each "key":value and the commas between.
	let bytes = 2;
	for (const key of program.stateKeys) {
		const value = state.values[key];
		if (inForms.has(key) || value === undefined || !isStorable(value)) continue;
		const entry = new TextEncoder().encode(`${JSON.stringify(key)}:${JSON.stringify(value)}`).length;
		const next = bytes + entry + (Object.keys(kept).length > 0 ? 1 : 0);
		if (next > MAX_RESPONSE_STATE_BYTES) break;
		bytes = next;
		kept[key] = value;
	}
	return kept;
}

/** That state as a readable Markdown list, or nothing when there is none. */
export function stateSummary(state: Record<string, Value>): string {
	const lines = Object.entries(state).map(([key, value]) => `- ${key}: ${stringOf(value).replace(/\r?\n/g, " ")}`);
	return lines.length === 0 ? "" : ["Other values in the block:", "", ...lines].join("\n");
}

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

function isStateRecord(value: unknown): value is Record<string, Value> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isStorable);
}

/** The last trailer in a message, or null when it has none. */
export function uiResponseOf(text: string): UiResponse | null {
	for (const match of text.matchAll(TRAILER)) {
		const body = match[1];
		if (body === undefined) continue;
		try {
			const parsed: unknown = JSON.parse(body);
			if (typeof parsed !== "object" || parsed === null) continue;
			const { block, messageId, values, graded, state } = parsed as Record<string, unknown>;
			if (typeof block !== "string" || !strings(values) || !marks(graded)) continue;
			return {
				block,
				values,
				graded,
				...(messageId !== undefined && typeof messageId === "string" ? { messageId } : {}),
				// A trailer without state, or with state that isn't a record of storable values, is read as one without.
				...(isStateRecord(state) ? { state } : {}),
			};
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

/** Whether a turn is small enough to send. */
export function turnFits(turn: string): boolean {
	return new TextEncoder().encode(turn).length <= MAX_TURN_BYTES;
}

/** A turn as a form sends it: its readable Markdown, then its trailer. */
export function uiTurn(markdown: string, response: UiResponse): string {
	const trailer = ["```ui-response", JSON.stringify(response), "```"].join("\n");
	return `${markdown}\n\n${trailer}`;
}
