/**
 * Progress lines: while an agent works, the person watching its chat reads what it is doing in a few words, as in v1. A model that summarizes its reasoning under headings, as
 * OpenAI's do, says it itself, and the app shows those. For other models the utility model writes the line from the person's request, what the agent found so far, its notes
 * and the tools it is calling, for the tool calls of that step. A chat gets one line at a time, at most one every few seconds, always about its latest step; the steps in between
 * keep the tools' names. Lines are never stored: they go to the person's open apps as a notice, and last as long as the app.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { isDeliveryReminder, reasoningHeadings } from "@pim/shared/transcript";

/** The least time between two lines of one chat, so a burst of quick steps costs a request or two, not one each. */
export const GAP_MS = 5_000;

export type ProgressOptions = {
	/** The utility model's line for a step; null when the person has none, and it throws when the model fails. */
	describe: (conversation: string, input: string) => Promise<string | null>;
	/** Tells those who have the chat open the line, with the ids of the tool calls it describes. */
	show: (conversation: string, line: string, calls: readonly string[]) => void;
	/** How long to leave a chat between two lines. */
	gapMs?: number;
};

/** A conversation whose lines are being written: the step to describe next, and the line before. */
type Describing = { next?: { input: string; calls: readonly string[] }; last?: string };

export class Progress {
	readonly #options: ProgressOptions;
	/** What each conversation's latest model request had: the request it works on and the results it just got. In memory. */
	readonly #context = new Map<string, string>();
	readonly #describing = new Map<string, Describing>();

	constructor(options: ProgressOptions) {
		this.#options = options;
	}

	/** The request a model is about to be asked, noted for the step it leads to. */
	request(conversation: string, messages: readonly Message[]): void {
		this.#context.set(conversation, requestContext(messages));
	}

	/** A model's answer: the tool calls of its step are described, unless it is a final answer, or its own headings say it better. */
	step(conversation: string, message: AssistantMessage): void {
		const describing = this.#describing.get(conversation);
		const calls = message.content.flatMap((part) => (part.type === "toolCall" && part.name !== "send_to_user" ? [part] : []));
		const notes = message.content.flatMap((part) => (part.type === "thinking" ? [part.thinking] : part.type === "text" ? [part.text] : [])).join("\n");
		if (calls.length === 0 || reasoningHeadings(notes).length > 0) {
			if (describing) describing.next = undefined;
			if (calls.length === 0) this.#context.delete(conversation);
			return;
		}
		const step = [
			this.#context.get(conversation) ?? "",
			notes.trim() === "" ? "" : `Its notes: ${clip(notes.trim(), 1_500, "end")}`,
			`Calling now:\n${calls.map((call) => `- ${call.name} ${clip(JSON.stringify(call.arguments ?? {}), 300)}`).join("\n")}`,
		]
			.filter((part) => part !== "")
			.join("\n\n");
		const next = { input: step, calls: calls.map((call) => call.id) };
		if (describing) {
			describing.next = next;
			return;
		}
		const state: Describing = { next };
		this.#describing.set(conversation, state);
		void (async () => {
			try {
				while (state.next !== undefined) {
					const { input, calls: described } = state.next;
					state.next = undefined;
					try {
						const line = await this.#options.describe(conversation, state.last ? `${input}\n\nPrevious line: ${state.last}` : input);
						// With no utility model there is nothing to write, nor to wait for: the app names the tool instead.
						if (line === null) continue;
						state.last = line;
						this.#options.show(conversation, line, described);
					} catch {
						// The utility model failed: the app names the tool instead.
					}
					await new Promise((resolve) => setTimeout(resolve, this.#options.gapMs ?? GAP_MS));
				}
			} finally {
				this.#describing.delete(conversation);
			}
		})();
	}
}

/** The person's latest request, and the results of the tools the agent called last, from a model request's messages. */
function requestContext(messages: readonly Message[]): string {
	const results: string[] = [];
	let request = "";
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "toolResult" && results.length < 3 && request === "") {
			const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			if (message.toolName !== "send_to_user") results.unshift(`- ${message.toolName}: ${clip(text, 300)}`);
		}
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			if (text.trim() === "" || isDeliveryReminder(text)) continue;
			request = clip(text.trim(), 1_000);
			break;
		}
	}
	return [request === "" ? "" : `Their request: ${request}`, results.length === 0 ? "" : `Found so far:\n${results.join("\n")}`].filter((part) => part !== "").join("\n\n");
}

/** `text` cut to `limit` characters, keeping its start or its end. */
function clip(text: string, limit: number, keep: "start" | "end" = "start"): string {
	if (text.length <= limit) return text;
	return keep === "start" ? `${text.slice(0, limit)}…` : `…${text.slice(text.length - limit)}`;
}
