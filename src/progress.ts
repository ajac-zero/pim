import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { SEND_TO_USER } from "./extensions/messaging";
import { DELIVERY_REMINDER, reasoningHeadings } from "./transcript";

/**
 * Progress lines: while an agent works, the person watching its chat reads
 * what it is doing in a few words. A model that summarizes its reasoning
 * under headings, as OpenAI's do, says it itself, and the app shows those.
 * For other models the utility model writes the line from the person's
 * request, what the agent found so far, its notes, and the tools it is
 * calling, for the tool calls of that step. One chat gets one line at a
 * time, at most one every few seconds, always about its latest step, and
 * only while someone has it open; the steps in between keep the tools' names.
 */
export const PROGRESS_EXTENSION = "pim.progress";

/** The least time between two lines of one chat, so a burst of quick steps costs a request or two, not one each. */
const GAP_MS = 5_000;

export type ProgressOptions = {
	/** Whether someone has the chat open now. */
	readonly watched: (conversation: string) => boolean;
	/** The utility model's line for a step; throws when there is none. */
	readonly describe: (input: string) => Promise<string>;
	/** Sends a line to those who have the chat open, with the ids of the tool calls it describes. */
	readonly show: (conversation: string, line: string, calls: readonly string[]) => void;
	/** Keeps the space awake while lines are written. */
	readonly keepAliveWhile: (work: () => Promise<void>) => Promise<unknown>;
};

export class Progress {
	readonly #options: ProgressOptions;
	/** What each conversation's latest model request had: the request it works on and the results it just got. In memory. */
	readonly #context = new Map<string, string>();
	/** Conversations whose lines are being written, with the step to describe next and the line before. In memory. */
	readonly #describing = new Map<string, Describing>();

	constructor(options: ProgressOptions) {
		this.#options = options;
	}

	/** Selected by every chat by default; visits and tasks choose their own extensions, and get no lines. */
	extension() {
		return defineExtension({
			name: PROGRESS_EXTENSION,
			hooks: [
				hook(GenerationTask, {
					beforeRequest: ({ messages }, api) => {
						this.#context.set(String(api.conversationId), requestContext(messages));
						return undefined;
					},
					afterResponse: (message, api) => {
						this.#step(String(api.conversationId), message);
					},
				}),
			],
		});
	}

	#step(conversation: string, message: AssistantMessage): void {
		const describing = this.#describing.get(conversation);
		const calls = message.content.flatMap((part) => (part.type === "toolCall" && part.name !== SEND_TO_USER ? [part] : []));
		const notes = message.content.flatMap((part) => (part.type === "thinking" ? [part.thinking] : part.type === "text" ? [part.text] : [])).join("\n");
		// A final answer has nothing left to describe; a model's own headings describe the step better.
		if (calls.length === 0 || reasoningHeadings(notes).length > 0 || !this.#options.watched(conversation)) {
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
		void this.#options.keepAliveWhile(async () => {
			try {
				while (state.next !== undefined) {
					const { input, calls: described } = state.next;
					state.next = undefined;
					try {
						const line = await this.#options.describe(state.last ? `${input}\n\nPrevious line: ${state.last}` : input);
						state.last = line;
						if (this.#options.watched(conversation)) this.#options.show(conversation, line, described);
					} catch {
						// No utility model, or it failed: the app names the tool instead.
					}
					await new Promise((resolve) => setTimeout(resolve, GAP_MS));
				}
			} finally {
				this.#describing.delete(conversation);
			}
		});
	}
}

/** A conversation whose lines are being written: the step to describe next, and the line before. */
type Describing = { next?: { input: string; calls: readonly string[] }; last?: string };

/** The person's latest request, and the results of the tools the agent called last, from a model request's messages. */
function requestContext(messages: readonly Message[]): string {
	const results: string[] = [];
	let request = "";
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "toolResult" && results.length < 3 && request === "") {
			const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			if (message.toolName !== SEND_TO_USER) results.unshift(`- ${message.toolName}: ${clip(text, 300)}`);
		}
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			if (text.trim() === "" || text === DELIVERY_REMINDER) continue;
			request = clip(text.trim(), 1_000);
			break;
		}
	}
	return [request === "" ? "" : `Their request: ${request}`, results.length === 0 ? "" : `Found so far:\n${results.join("\n")}`]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** `text` cut to `limit` characters, keeping its start or its end. */
function clip(text: string, limit: number, keep: "start" | "end" = "start"): string {
	if (text.length <= limit) return text;
	return keep === "start" ? `${text.slice(0, limit)}…` : `…${text.slice(text.length - limit)}`;
}
