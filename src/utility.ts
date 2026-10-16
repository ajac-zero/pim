import { DELIVERY_REMINDER, type TranscriptMessage } from "./transcript";

/**
 * Side jobs for the utility model: one small, fast model, chosen once per
 * Pim, that features call for work around a conversation rather than in it,
 * such as naming a chat, improving a prompt or summarizing a chat. A feature
 * defines a task here and runs it with `Pim.utility(task, input)`.
 */
export type UtilityTask = {
	/** What the model is told to do with the input. */
	readonly instructions: string;
	/** The most a model that doesn't reason may answer, in tokens. A reasoning model gets no cap, so its thinking can't cut off the answer. */
	readonly maxTokens: number;
	/** The answer as the feature uses it; empty when it is unusable. */
	readonly clean?: (answer: string) => string;
};

/** A chat's title, from its first message or the conversation so far. */
export const NAME_CHAT: UtilityTask = {
	instructions:
		"You name chats. Reply with only a title of 2 to 5 words for the conversation you are given, in its language. No quotes, no ending punctuation, nothing else.",
	maxTokens: 32,
	// Small models add quotes, a label or a full stop all the same.
	clean: (answer) =>
		answer
			.trim()
			.split(/\r?\n/)[0]!
			.trim()
			.replace(/^title\s*:\s*/i, "")
			.replace(/^["'“‘*]+|["'”’*]+$/g, "")
			.replace(/[.。]+$/, "")
			.trim(),
};

/** What the person is about to send, rewritten so their agent can act on it. */
export const IMPROVE_PROMPT: UtilityTask = {
	instructions: [
		"You improve messages a person is about to send to their AI assistant.",
		"Rewrite the message so the assistant can act on it: make the goal clear, add the useful details and constraints it implies, and say what a good answer looks like.",
		"Keep the person's voice, language and intent. Don't invent facts about them, don't answer the message, and keep it short enough to type.",
		"Reply with only the rewritten message.",
	].join(" "),
	maxTokens: 1024,
};

/** A quick summary of a long conversation and what comes next, in Markdown. */
export const SUMMARIZE_CHAT: UtilityTask = {
	instructions: [
		"You summarize conversations between a person and their AI assistant, in the conversation's language.",
		"Reply in Markdown: first a few bullets on what was discussed and decided,",
		"then a heading Next steps (in the conversation's language) with bullets on what is still open and who does what, or a line saying there are none.",
		"Use only what the conversation says, and reply with nothing else.",
	].join(" "),
	maxTokens: 800,
};

/**
 * A conversation as the utility model reads it: what the person said and
 * what their agent sent them, one turn after another. Events Pim delivers
 * (a scheduled task, an approval) are marked as such; tool calls and
 * private notes are left out. A long one keeps its latest `limit` characters.
 */
export function conversationText(messages: readonly TranscriptMessage[], limit: number): string {
	const turns: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = message.parts
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n")
				.trim();
			if (text === "" || text === DELIVERY_REMINDER) continue;
			turns.push(`${text.startsWith("[") ? "Event" : "Person"}: ${text}`);
		} else if (message.role === "assistant") {
			for (const part of message.parts) {
				if (part.type !== "tool-call" || part.name !== "send_to_user") continue;
				const sent = (part.arguments as { message?: unknown } | null)?.message;
				if (typeof sent === "string" && sent.trim() !== "") turns.push(`Assistant: ${sent.trim()}`);
			}
		}
	}
	const text = turns.join("\n\n");
	return text.length > limit ? `…${text.slice(text.length - limit)}` : text;
}
