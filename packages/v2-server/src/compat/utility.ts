/**
 * The utility model: the one small model a person chooses in Settings → Model for side jobs around a chat, which are naming a chat, summarizing
 * it, improving a prompt before it is sent, and suggesting what to say next. With none chosen every job is off, as in v1.
 *
 * The Gate asks it over plain HTTP, without a conversation: one system prompt, one user message, one answer. It reaches the deployment's AI
 * gateway, a person's own OpenAI-compatible provider, and the Anthropic, OpenAI and Google services whose key they added. A model run on a
 * ChatGPT plan is reached with the person's plan token on OpenAI's own API, as the Runner does.
 */
import type { App } from "@pim/v2-app/app";
import type { Principal } from "@pim/v2-contracts/identity";
import { transcriptPage } from "@pim/v2-live/projections/snapshots";
import { INTRODUCTION, isDeliveryReminder, ROOM_POST, type TranscriptMessage } from "@pim/shared/transcript";

type Env = Record<string, string | undefined>;
type ModelRef = { provider: string; id: string };

export type UtilityTask = { instructions: string; maxTokens: number; clean?: (answer: string) => string };

/** An answer's first line without what small models add all the same: a label, quotes, a full stop. */
function line(answer: string, label: RegExp): string {
	return answer.trim().split(/\r?\n/)[0]!.trim().replace(label, "").replace(/^["'“‘*]+|["'”’*.。]+$/g, "").trim();
}

export const NAME_CHAT: UtilityTask = {
	instructions:
		"You name chats. Reply with only a title of 2 to 5 words for the conversation you are given, in its language. When it has moved on from where it began, name what its latest messages are about. No quotes, no ending punctuation, nothing else.",
	maxTokens: 32,
	clean: (answer) => line(answer, /^title\s*:\s*/i).slice(0, 100),
};

export const IMPROVE_PROMPT: UtilityTask = {
	instructions: [
		"You improve messages a person is about to send to their AI assistant.",
		"Rewrite the message so the assistant can act on it: make the goal clear, add the useful details and constraints it implies, and say what a good answer looks like.",
		"Keep the person's voice, language and intent. Don't invent facts about them, don't answer the message, and keep it short enough to type.",
		"Reply with only the rewritten message.",
	].join(" "),
	maxTokens: 1024,
};

export const SUMMARIZE_CHAT: UtilityTask = {
	instructions: [
		"You summarize conversations between a person and their AI assistant, in the conversation's language.",
		"Reply in Markdown: first a few bullets on what was discussed and decided,",
		"then a heading Next steps (in the conversation's language) with bullets on what is still open and who does what, or a line saying there are none.",
		"Use only what the conversation says, and reply with nothing else.",
	].join(" "),
	maxTokens: 800,
};

export const SUGGEST_PROMPTS: UtilityTask = {
	instructions: [
		"You suggest what a person might say next to their AI assistant, from what they talked about in the conversation you are given.",
		"Write 2 messages the person could send, each a direct command in their own voice, of 2 to 6 words, such as 'Plan my week' or 'Summarize the Acme thread'. Skip filler like 'Help me', 'Can you', 'Could you' or 'Please'.",
		"Use only what you are given: don't invent facts, and don't suggest what the conversation already finished.",
		"Write in the language of the conversation, or else the language you are given.",
		'Reply with only a JSON object with the messages in a list, such as {"messages": ["Plan my week", "Summarize the thread"]}.',
	].join(" "),
	maxTokens: 300,
};

/** What the person said and what their agent sent them, one turn after another; events Pim delivers, tool calls and private notes are left out. A long one keeps its latest `limit` characters. */
export function conversationText(messages: readonly TranscriptMessage[], limit: number): string {
	const turns: string[] = [];
	for (const message of messages) {
		const body = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
		if (message.role === "user") {
			if (body === "" || isDeliveryReminder(body) || body.startsWith(INTRODUCTION)) continue;
			const post = ROOM_POST.exec(body);
			turns.push(post ? `${post[1]}: ${body.slice(post[0].length).trim()}` : `${body.startsWith("[") ? "Event" : "Person"}: ${body}`);
		} else if (message.compaction) {
			if (body !== "") turns.push(`Earlier in this chat: ${body}`);
		} else if (message.role === "assistant") {
			for (const part of message.parts) {
				if (part.type !== "tool-call" || part.name !== "send_to_user") continue;
				const sent = (part.arguments as { message?: unknown } | null)?.message;
				if (typeof sent === "string" && sent.trim() !== "") turns.push(`Assistant: ${sent.trim()}`);
			}
		}
	}
	const joined = turns.join("\n\n");
	return joined.length > limit ? `…${joined.slice(joined.length - limit)}` : joined;
}

type Endpoint =
	| { api: "chat"; url: string; key: string | null; model: string }
	| { api: "responses"; url: string; key: string; model: string }
	| { api: "anthropic"; key: string; model: string }
	| { api: "google"; key: string; model: string };

const warned = new Set<string>();
/** Says once per owner and model that the chosen utility model cannot be reached, so the jobs that stay off are not silent. */
function unreachable(p: Principal, chosen: ModelRef): null {
	const key = `${p.ownerId}/${chosen.provider}/${chosen.id}`;
	if (!warned.has(key)) {
		warned.add(key);
		console.warn(`the utility model ${chosen.provider}/${chosen.id} cannot be reached from the Gate (no gateway, address or key for it), so chats are not named`);
	}
	return null;
}

/** Where the person's chosen utility model is reached, or null when none is chosen or it cannot be reached from here. */
async function endpointOf(app: App, env: Env, p: Principal): Promise<Endpoint | null> {
	const chosen = (await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT value FROM pim_app.owner_settings WHERE key = 'model_utility'")).rows[0]?.value)) as ModelRef | undefined;
	if (!chosen?.provider || !chosen.id) return null;
	const strip = (u: string) => u.replace(/\/+$/, "");
	if (chosen.provider === "gateway") return env.PIM_AI_GATEWAY_URL ? { api: "chat", url: `${strip(env.PIM_AI_GATEWAY_URL)}/chat/completions`, key: env.PIM_AI_GATEWAY_KEY ?? null, model: chosen.id } : unreachable(p, chosen);
	// A person signed in with ChatGPT runs `openai` on their plan, here as for the Runner.
	if (chosen.provider === "openai") {
		const plan = await app.chatgpt.access(p.ownerId);
		if (plan) return { api: "responses", url: `${strip(plan.resource)}/responses`, key: plan.token, model: chosen.id };
	}
	const rows = await app.providers.list(p);
	const own = rows.find((r) => r.id === chosen.provider);
	if (own) {
		const url = (own.config.baseUrl ?? own.config.url) as unknown;
		return typeof url === "string" ? { api: "chat", url: `${strip(url)}/chat/completions`, key: await app.providers.reveal(p.ownerId, own.id), model: chosen.id } : unreachable(p, chosen);
	}
	const service = rows.find((r) => ((r.config.builtin as string | undefined) ?? r.kind) === chosen.provider && r.hasKey);
	const key = service ? await app.providers.reveal(p.ownerId, service.id) : null;
	if (!key) return unreachable(p, chosen);
	if (chosen.provider === "anthropic") return { api: "anthropic", key, model: chosen.id };
	if (chosen.provider === "google") return { api: "google", key, model: chosen.id };
	if (chosen.provider === "openai") return { api: "chat", url: "https://api.openai.com/v1/chat/completions", key, model: chosen.id };
	return unreachable(p, chosen);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Runs a side job on the person's utility model and returns its answer, cleaned as the task says. Null when there is no utility model; throws when it fails. */
export async function runUtility(app: App, env: Env, p: Principal, task: UtilityTask, input: string): Promise<string | null> {
	const endpoint = await endpointOf(app, env, p);
	if (!endpoint) return null;
	const signal = AbortSignal.timeout(30_000);
	const post = (url: string, headers: Record<string, string>, body: unknown) => fetch(url, { method: "POST", signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
	// A reasoning model spends its cap thinking, so the caps are generous; the task's `clean` keeps the answer short.
	const response =
		endpoint.api === "responses"
			? await post(endpoint.url, { authorization: `Bearer ${endpoint.key}` }, { model: endpoint.model, stream: false, store: false, instructions: task.instructions, max_output_tokens: Math.max(task.maxTokens, 1024), input: input })
			: endpoint.api === "chat"
			? await post(endpoint.url, endpoint.key ? { authorization: `Bearer ${endpoint.key}` } : {}, { model: endpoint.model, stream: false, max_completion_tokens: Math.max(task.maxTokens, 1024), messages: [{ role: "system", content: task.instructions }, { role: "user", content: input }] })
			: endpoint.api === "anthropic"
				? await post("https://api.anthropic.com/v1/messages", { "x-api-key": endpoint.key, "anthropic-version": "2023-06-01" }, { model: endpoint.model, max_tokens: Math.max(task.maxTokens, 1024), system: task.instructions, messages: [{ role: "user", content: input }] })
				: await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(endpoint.model)}:generateContent`, { "x-goog-api-key": endpoint.key }, { systemInstruction: { parts: [{ text: task.instructions }] }, contents: [{ role: "user", parts: [{ text: input }] }], generationConfig: { maxOutputTokens: Math.max(task.maxTokens, 1024) } });
	if (!response.ok) throw new Error(`The utility model answered ${response.status}`);
	const body = (await response.json()) as any;
	const answer =
		endpoint.api === "responses"
			? (body.output ?? []).flatMap((item: { content?: { type?: string; text?: unknown }[] }) => (item.content ?? []).filter((part) => part.type === "output_text").map((part) => str(part.text))).join("")
			: endpoint.api === "chat"
			? str(body.choices?.[0]?.message?.content)
			: endpoint.api === "anthropic"
				? (body.content ?? []).map((part: { text?: unknown }) => str(part.text)).join("")
				: (body.candidates?.[0]?.content?.parts ?? []).map((part: { text?: unknown }) => str(part.text)).join("");
	const cleaned = (task.clean ? task.clean(answer) : answer.trim()).trim();
	if (cleaned === "") throw new Error("The utility model answered nothing usable");
	return cleaned;
}

/** The messages a suggestions answer offers: JSON `{ messages }` as the task asks, found even when the model wraps it in words. */
export function suggestionsIn(answer: string): string[] {
	const found = /\{[\s\S]*\}/.exec(answer)?.[0];
	if (!found) return [];
	try {
		const messages = (JSON.parse(found) as { messages?: unknown }).messages;
		if (!Array.isArray(messages)) return [];
		return [...new Set(messages.flatMap((m) => (typeof m === "string" && m.trim() !== "" && m.length <= 100 ? [m.trim()] : [])))].slice(0, 2);
	} catch {
		return [];
	}
}

/** A chat's conversation as the utility model reads it, as the person who owns it; empty until something has been said in it. */
export async function chatConversation(app: App, p: Principal, chatId: string, limit = 6000): Promise<string> {
	return conversationText((await transcriptPage(app.db.pool, p.ownerId, chatId)).messages, limit);
}

/**
 * Names a chat from what has been said in it and keeps the title, unless the person renamed it meanwhile. Null when there is no utility model or
 * nothing has been said yet.
 */
export async function titleChat(app: App, env: Env, p: Principal, chatId: string): Promise<string | null> {
	const conversation = await chatConversation(app, p, chatId, 2000);
	if (conversation === "") return null;
	const title = await runUtility(app, env, p, NAME_CHAT, conversation);
	if (title === null) return null;
	await app.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.conversations SET title = $2 WHERE public_chat_id = $1 AND deleted_at IS NULL", [chatId, title]));
	return title;
}

const titleTried = new Map<string, number>();

/**
 * Names the first of these chats that has no title and has not been tried in the last minute, and returns its title; one chat per call, and a wait of 8 seconds at
 * most, so a list is never held for long. A slow answer is still kept, and shows the next time the list is read. A failure is logged, not thrown.
 */
export async function nameOneUntitled(app: App, env: Env, p: Principal, chats: readonly { id: string; title: string | null | undefined }[]): Promise<{ id: string; title: string } | null> {
	const chat = chats.find((c) => !c.title && (titleTried.get(c.id) ?? 0) < Date.now() - 60_000);
	if (!chat) return null;
	titleTried.set(chat.id, Date.now());
	const title = await Promise.race([titleChat(app, env, p, chat.id).catch((error) => (console.warn(`naming chat ${chat.id} failed`, error), null)), new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))]);
	return title ? { id: chat.id, title } : null;
}
