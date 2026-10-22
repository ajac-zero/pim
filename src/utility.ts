import { Type, type TSchema } from "@earendil-works/pi-ai";
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

/** The most prompts the utility model suggests at once. */
const MAX_SUGGESTIONS = 4;

/** An answer's first line without what small models add all the same: a label, quotes, a full stop. */
function line(answer: string, label: RegExp): string {
	return answer
		.trim()
		.split(/\r?\n/)[0]!
		.trim()
		.replace(label, "")
		.replace(/^["'“‘*]+|["'”’*]+$/g, "")
		.replace(/[.。]+$/, "")
		.trim();
}

/** A chat's title, from its first message or the conversation so far. */
export const NAME_CHAT: UtilityTask = {
	instructions:
		"You name chats. Reply with only a title of 2 to 5 words for the conversation you are given, in its language. No quotes, no ending punctuation, nothing else.",
	maxTokens: 32,
	clean: (answer) => line(answer, /^title\s*:\s*/i),
};

/** What an agent is doing now, in a few words, for the person waiting on it (see ./progress.ts). */
export const DESCRIBE_WORK: UtilityTask = {
	instructions: [
		"You tell a person what their AI assistant is doing right now, while they wait for its answer.",
		"You are given their request, what the assistant found so far, its notes and the tools it is calling now.",
		'Reply with only one line of 3 to 8 words, in the language of the request, starting with a verb in the present progressive, such as "Comparing flight prices for May".',
		"Say what it is doing for them, not how: no tool names, code or quotes, no ending punctuation, and not the same as the previous line.",
	].join(" "),
	maxTokens: 32,
	clean: (answer) => line(answer, /^line\s*:\s*/i).slice(0, 120),
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

/** A request from an artifact the person is using (`window.pim.ask`): answered as asked, for the page to show or use. */
export const ARTIFACT_ASK: UtilityTask = {
	instructions: [
		"You answer requests from a small app (an artifact) that a person's AI assistant made for them, which they are using now.",
		"Do what the request asks and reply with only that, in the format it asks for, with no preamble.",
		"You can't use tools or see anything but the request.",
	].join(" "),
	maxTokens: 2048,
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

/**
 * A side job whose answer has a shape: the model answers in JSON that follows
 * `schema`, which the provider enforces while it writes (see `withJsonSchema`),
 * so only models that can do that are offered as the utility model.
 */
export type StructuredUtilityTask<T extends readonly unknown[]> = {
	/** What the model is told to do with the input. */
	readonly instructions: string;
	/** The most a model that doesn't reason may answer, in tokens. */
	readonly maxTokens: number;
	/** The JSON schema of the answer: an object whose properties are all required, with no others allowed, which every provider's strict mode takes. */
	readonly schema: TSchema;
	/** The answer as the feature uses it, from JSON that follows the schema but may still hold nonsense; an empty list when it is unusable. */
	readonly result: (answer: unknown) => T;
};

/** The messages an agent's dashboard offers to start a chat with. */
export const SUGGEST_PROMPTS: StructuredUtilityTask<string[]> = {
	instructions: [
		"You suggest what a person might say next to their AI assistant, from what the assistant knows about them, what they talked about lately, and what is on its dashboard.",
		"Write 4 messages the person could send, each one a short request in their own voice, of 3 to 9 words, that continues something they are doing or follows up on what they care about, or that starts something new that fits.",
		"Use only what you are given: don't invent facts, and don't suggest what a recent chat already finished.",
		"Write in the language of the recent chats, or else the language you are given.",
		"Reply with a JSON object with the messages in a list.",
	].join(" "),
	maxTokens: 300,
	schema: Type.Object({ messages: Type.Array(Type.String()) }, { additionalProperties: false }),
	result: (answer) => {
		const messages = (answer as { messages?: unknown } | null)?.messages;
		if (!Array.isArray(messages)) return [];
		const texts = messages.flatMap((message) => (typeof message === "string" && message.trim() !== "" && message.length <= 100 ? [message.trim()] : []));
		return [...new Set(texts)].slice(0, MAX_SUGGESTIONS);
	},
};

/**
 * A request's payload asking for an answer in `schema`, in the form its API
 * takes: a response format on chat completions (OpenAI, xAI, Workers AI and
 * compatible servers) and Mistral, a text format on the Responses API
 * (OpenAI, ChatGPT), an output format on Anthropic's, and a response schema
 * on Google's. Undefined for an API without one, which leaves it unchanged.
 */
export function withJsonSchema(api: string, payload: unknown, schema: TSchema): unknown {
	const body = payload as Record<string, any>;
	const format = { name: "answer", strict: true, schema };
	switch (api) {
		case "openai-completions":
		case "cloudflare-ai":
		case "mistral-conversations":
			return { ...body, response_format: { type: "json_schema", json_schema: format } };
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			return { ...body, text: { ...body.text, format: { type: "json_schema", ...format } } };
		case "anthropic-messages":
			return { ...body, output_config: { ...body.output_config, format: { type: "json_schema", schema } } };
		case "google-generative-ai":
			return { ...body, config: { ...body.config, responseMimeType: "application/json", responseJsonSchema: schema } };
	}
}
