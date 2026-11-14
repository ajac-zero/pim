import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinModels } from "../src/provider-catalog";
import { describe as describeModel, piProvider, prepareProvider } from "../src/providers";
import { typedSchema } from "../src/typed-schemas";
import { api, OWNER, post, say, toolUse } from "./helpers";
import { completionStream, faux, type Pim } from "./worker";

/*
 * Two OpenAI-compatible servers behind `fetch`: one at home, which needs no
 * key and lists three models, and one in the cloud, which needs `secret-key`
 * and lists more models than Pim offers unasked.
 */

type Call = { url: string; authorization: string | null; headers?: Record<string, string>; body: any; raw?: string };

let calls: Call[];
let claudeFails = false;
/** A tool call the Messages gateway answers its next request with, in place of send_to_user. */
let gatewayCall: { name: string; input: Record<string, unknown> } | undefined;

const CLOUD_MODELS = [{ id: "gpt-4.1" }, ...Array.from({ length: 59 }, (_, n) => ({ id: `cloud-model-${n}` }))];

const BUILTINS = [
	["anthropic", "claude-sonnet-4-6", "https://api.anthropic.com/v1/messages", "x-api-key"],
	["openai", "gpt-4.1", "https://api.openai.com/v1/responses", "authorization"],
	["google", "gemini-2.5-flash", "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse", "x-goog-api-key"],
	["openrouter", "anthropic/claude-sonnet-4.6", "https://openrouter.ai/api/v1/messages", "authorization"],
	["openrouter", "openai/gpt-4.1", "https://openrouter.ai/api/v1/chat/completions", "authorization"],
	["deepseek", "deepseek-flash", "https://api.deepseek.com/chat/completions", "authorization"],
	["mistral", "mistral-large-latest", "https://api.mistral.ai/v1/chat/completions", "authorization"],
	["groq", "llama-3.3-70b-versatile", "https://api.groq.com/openai/v1/chat/completions", "authorization"],
	["xai", "grok-4.3", "https://api.x.ai/v1/responses", "authorization"],
] as const;

/** Native provider streams that ask Pim to deliver a message, rather than just emit text. */
function builtinStream(url: URL, model: string, call = { name: "send_to_user", input: {} as Record<string, unknown> }): Response {
	const message = `Hello from ${url.host}`;
	const args = JSON.stringify(call.name === "send_to_user" ? { message } : call.input);
	let events: Record<string, unknown>[];
	if (url.pathname.endsWith("/messages")) {
		events = [
			{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model, usage: { input_tokens: 10, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: call.name === "send_to_user" ? "toolu_1" : "toolu_2", name: call.name, input: {} } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
			{ type: "message_stop" },
		];
	} else if (url.pathname.endsWith("/responses")) {
		const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "send_to_user", arguments: args, status: "completed" };
		events = [
			{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: args },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
		];
	} else if (url.host === "generativelanguage.googleapis.com") {
		events = [{ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { name: "send_to_user", args: { message } } }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } }];
	} else return completionStream(model, message);
	return new Response(events.map((event) => `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
	calls = [];
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (BUILTINS.some((entry) => new URL(entry[2]).origin === url.origin)) {
			const body = await request.json<{ model: string }>();
			calls.push({ url: request.url, authorization: request.headers.get("authorization"), headers: Object.fromEntries(request.headers), body });
			return builtinStream(url, body.model);
		}
		// A Messages gateway: claude.test serves Claude, gateway.test Gemini beside it.
		if (url.origin === "https://claude.test" || url.origin === "https://gateway.test") {
			if (url.pathname === "/v1/models") {
				calls.push({ url: request.url, authorization: request.headers.get("authorization"), headers: Object.fromEntries(request.headers), body: null });
				return Response.json({ data: url.origin === "https://claude.test" ? [{ id: "claude-sonnet-5-5" }] : [{ id: "claude-sonnet-5-5" }, { id: "gemini-4-argon" }] });
			}
			const raw = await request.text();
			const body = JSON.parse(raw) as { model: string };
			calls.push({ url: request.url, authorization: request.headers.get("authorization"), headers: Object.fromEntries(request.headers), body, raw });
			if (claudeFails) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "thinking is wrong" } }, { status: 400 });
			const call = gatewayCall;
			gatewayCall = undefined;
			return builtinStream(url, body.model, call);
		}
		if (url.origin !== "http://localhost:1234" && url.origin !== "https://models.test") return realFetch(input, init);
		const body = request.method === "POST" ? await request.json<{ model: string }>() : null;
		const authorization = request.headers.get("authorization");
		calls.push({ url: request.url, authorization, body });
		const home = url.origin === "http://localhost:1234";
		if (!home && authorization !== "Bearer secret-key") return Response.json({ error: "unauthorized" }, { status: 401 });
		if (url.pathname === "/v1/models") {
			return Response.json({
				object: "list",
				data: home
					? [
							{ id: "local-model" },
							// As OpenRouter lists a model, and as llama.cpp does, with the context it serves.
							{ id: "vision-model", name: "Vision", context_length: 32_768, architecture: { input_modalities: ["text", "image"] } },
							{ id: "served-model", architecture: { input_modalities: ["text"] }, meta: { n_ctx: 4_096, n_ctx_train: 32_768 } },
						]
					: CLOUD_MODELS,
			});
		}
		if (url.pathname === "/v1/chat/completions") return completionStream(body!.model, home ? "Hello from home" : "Hello from the cloud");
		return new Response("not found", { status: 404 });
	});
});

/** Firecrawl's people_company_enrich input schema as its MCP server lists it (its `people` and a sibling, trimmed of other fields). */
const FIRECRAWL_ENRICH = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	additionalProperties: false,
	properties: {
		people: {
			description: "People to enrich. People and companies together are at most 10 per call.",
			minItems: 1,
			maxItems: 10,
			type: "array",
			items: {
				anyOf: [
					{ required: ["linkedin_url"], properties: { linkedin_url: { pattern: "\\S" } } },
					{ required: ["email"], properties: { email: { pattern: "\\S" } } },
					{ required: ["phone"], properties: { phone: { pattern: "\\S" } } },
					{ required: ["name", "company"], properties: { name: { pattern: "\\S" }, company: { pattern: "\\S" } } },
					{ required: ["name", "domain"], properties: { name: { pattern: "\\S" }, domain: { pattern: "\\S" } } },
					{ required: ["first_name", "last_name", "company"], properties: { first_name: { pattern: "\\S" }, last_name: { pattern: "\\S" }, company: { pattern: "\\S" } } },
					{ required: ["first_name", "last_name", "domain"], properties: { first_name: { pattern: "\\S" }, last_name: { pattern: "\\S" }, domain: { pattern: "\\S" } } },
				],
				type: "object",
				properties: {
					name: { description: "Full name.", type: "string" },
					first_name: { type: "string" },
					last_name: { type: "string" },
					company: { description: "Employer name or domain.", type: "string" },
					domain: { description: "Employer domain, e.g. example.com.", type: "string" },
					linkedin_url: { description: "LinkedIn profile URL.", type: "string" },
					email: { description: "Any email known for the person.", type: "string" },
					phone: { description: "Any phone number known for the person.", type: "string" },
				},
				additionalProperties: false,
			},
		},
		verified_only: { type: "boolean", description: "Return only verified emails." },
	},
};

/**
 * What Vertex AI refuses in a function declaration's schema, by path: written from its rules, not from the code that
 * meets them. A node with `anyOf` has nothing else and at least two branches; any other node has one of Gemini's types
 * and only the fields its Schema has for that type; `enum` lists strings on a string; `format` is one Gemini knows for
 * the type; an array has `items`; `required` names only fields in `properties`. An object's `properties` may be empty:
 * Pim's own tools send `{}` there, and the gateway took it.
 */
const VERTEX_TYPE_FIELDS: Record<string, string[]> = {
	string: ["enum", "format", "minLength", "maxLength", "pattern"],
	number: ["format", "minimum", "maximum"],
	integer: ["format", "minimum", "maximum"],
	boolean: [],
	array: ["items", "minItems", "maxItems"],
	object: ["properties", "required", "minProperties", "maxProperties"],
};
const VERTEX_ANY_TYPE = ["type", "description", "title", "nullable", "default"];
const VERTEX_FORMATS: Record<string, string[]> = { string: ["enum", "date-time"], number: ["float", "double"], integer: ["int32", "int64"] };
function vertexViolations(schema: any, path = "(root)"): string[] {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return [`${path}: not a schema`];
	if ("anyOf" in schema) {
		const others = Object.keys(schema).filter((key) => key !== "anyOf");
		return [
			...(others.length > 0 ? [`${path}: ${others.join(", ")} beside anyOf`] : []),
			...(!Array.isArray(schema.anyOf) || schema.anyOf.length < 2 ? [`${path}: anyOf of fewer than two`] : []),
			...(Array.isArray(schema.anyOf) ? schema.anyOf.flatMap((branch: unknown, n: number) => vertexViolations(branch, `${path}.anyOf[${n}]`)) : []),
		];
	}
	const fields = VERTEX_TYPE_FIELDS[schema.type];
	if (!fields) return [`${path}: type ${JSON.stringify(schema.type)}`];
	const found: string[] = [];
	for (const key of Object.keys(schema)) if (!VERTEX_ANY_TYPE.includes(key) && !fields.includes(key)) found.push(`${path}: ${key} on ${schema.type}`);
	if ("enum" in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some((value: unknown) => typeof value !== "string"))) found.push(`${path}: enum of other than strings`);
	if ("format" in schema && !VERTEX_FORMATS[schema.type]?.includes(schema.format)) found.push(`${path}: format ${schema.format} on ${schema.type}`);
	if ("nullable" in schema && typeof schema.nullable !== "boolean") found.push(`${path}: nullable not a boolean`);
	if (schema.type === "array") found.push(...("items" in schema ? vertexViolations(schema.items, `${path}.items`) : [`${path}: array without items`]));
	const properties = schema.properties ?? {};
	for (const name of schema.required ?? []) if (!(name in properties)) found.push(`${path}: requires ${name}, which isn't in properties`);
	for (const [name, child] of Object.entries(properties)) found.push(...vertexViolations(child, `${path}.${name}`));
	return found;
}

/**
 * What a gateway's translation of a Messages conversation for Vertex refuses or has no counterpart for: `is_error` on a
 * tool result, empty text, thinking and its signatures, a role or block it doesn't know, a tool_use id Anthropic's own
 * rules refuse, and a tool result that answers no tool_use of the message before it.
 */
function messageViolations(messages: any[]): string[] {
	const found: string[] = [];
	let open = new Set<string>();
	messages.forEach((message, m) => {
		const blocks: any[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		if (message.role !== "user" && message.role !== "assistant") found.push(`messages[${m}]: role ${message.role}`);
		if (!Array.isArray(blocks) || blocks.length === 0) {
			found.push(`messages[${m}]: no content`);
			return;
		}
		blocks.forEach((block, b) => {
			const at = `messages[${m}].content[${b}]`;
			const known = message.role === "user" ? ["text", "image", "tool_result"] : ["text", "tool_use"];
			if (!known.includes(block.type)) found.push(`${at}: ${block.type} in a ${message.role} message`);
			if ("signature" in block) found.push(`${at}: signature`);
			if (block.type === "text" && !block.text.trim()) found.push(`${at}: empty text`);
			if (block.type === "tool_use" && !/^[a-zA-Z0-9_-]{1,64}$/.test(block.id)) found.push(`${at}: tool_use id ${block.id}`);
			if (block.type !== "tool_result") return;
			if ("is_error" in block) found.push(`${at}: is_error`);
			if (!open.has(block.tool_use_id)) found.push(`${at}: answers no tool_use before it`);
			if (Array.isArray(block.content)) {
				block.content.forEach((part: any, p: number) => {
					if (part.type !== "text" && part.type !== "image") found.push(`${at}.content[${p}]: ${part.type}`);
					if (part.type === "text" && !part.text.trim()) found.push(`${at}.content[${p}]: empty text`);
				});
			} else if (typeof block.content !== "string") found.push(`${at}: content neither text nor blocks`);
		});
		open = new Set(message.role === "assistant" ? blocks.filter((block) => block.type === "tool_use").map((block) => block.id) : []);
	});
	return found;
}

const put = (path: string, body: unknown) => api(path, { method: "PUT", body: JSON.stringify(body) });

describe("A person's own model providers", () => {
	it("keeps readable history but never replays another OpenAI connection's encrypted reasoning", async () => {
		const provider = await prepareProvider({ builtin: "openai", key: "sk-test-key", models: ["gpt-4.1"] }, null, new Set());
		const models = createModels();
		models.setProvider(piProvider("own:openai", provider));
		const model = models.getModel("own:openai", "gpt-4.1")!;
		const messages = ["openai", "own:openai", "own:openai-2"].map((source, index) => ({
			...fauxAssistantMessage([
				{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "reasoning", id: `rs_${index}`, encrypted_content: `encrypted-${index}`, summary: [] }) },
				{ type: "text", text: `Answer ${index}` },
			]),
			provider: source,
			api: model.api,
			model: model.id,
		}));
		const result = await models.completeSimple(model, { messages });
		expect(result.stopReason).toBe("toolUse");
		expect(result.provider).toBe("own:openai");
		const input = calls.at(-1)!.body.input;
		expect(input.filter((item: { type: string }) => item.type === "reasoning")).toEqual([
			{ type: "reasoning", id: "rs_1", encrypted_content: "encrypted-1", summary: [] },
		]);
		for (let n = 0; n < 3; n++) expect(JSON.stringify(input)).toContain(`Answer ${n}`);
	});

	it("sends a Claude endpoint no thinking in a tool round that another provider's answer started", async () => {
		const provider = await prepareProvider({ name: "Proxy", url: "https://claude.test", key: "proxy-key", api: "anthropic-messages" }, null, new Set());
		const models = createModels();
		models.setProvider(piProvider("own:proxy", provider));
		const model = { ...models.getModel("own:proxy", "claude-sonnet-5-5")!, id: "claude-sonnet-4-5" };
		const call = { type: "toolCall" as const, id: "call_1|fc_1", name: "lookup", arguments: {} };
		const result = { role: "toolResult" as const, toolCallId: call.id, toolName: "lookup", content: [{ type: "text" as const, text: "found" }], isError: false, timestamp: 1 };
		const chatgpt = { ...fauxAssistantMessage([{ type: "thinking", thinking: "", thinkingSignature: "{}" }, call], { stopReason: "toolUse" }), provider: "openai", api: "openai-codex-responses" as const, model: "gpt-5" };
		const failed = { ...fauxAssistantMessage([], { stopReason: "error", errorMessage: "usage limit" }), provider: "openai", api: "openai-codex-responses" as const, model: "gpt-5" };
		const user = { role: "user" as const, content: "Look it up", timestamp: 1 };
		await models.completeSimple(model, { messages: [user, chatgpt, result, failed] }, { reasoning: "low" });
		expect(calls.at(-1)!.body.thinking).toEqual({ type: "disabled" });
		// Once the person says something new, it thinks again.
		await models.completeSimple(model, { messages: [user, chatgpt, result, { ...user, content: "Thanks" }] }, { reasoning: "low" });
		expect(calls.at(-1)!.body.thinking.type).toBe("enabled");
	});

	it("sends a model other than Claude tool schemas Vertex takes, and Claude's request as pi-ai makes it", async () => {
		const provider = await prepareProvider({ name: "Gateway", url: "https://claude.test", key: "proxy-key", api: "anthropic-messages" }, null, new Set());
		const models = createModels();
		models.setProvider(piProvider("own:gateway", provider));
		const claude = models.getModel("own:gateway", "claude-sonnet-5-5")!;
		const tool = { name: "firecrawl_people_company_enrich", description: "Enrich people.", parameters: FIRECRAWL_ENRICH as never };
		const ask = async (model: typeof claude) => {
			let built: Record<string, unknown> | undefined;
			await models.completeSimple(model, { systemPrompt: "Be helpful.", messages: [{ role: "user", content: "Who is Jane?", timestamp: 1 }], tools: [tool] }, {
				onPayload: (params) => {
					built = JSON.parse(JSON.stringify(params));
					return undefined;
				},
			});
			const { betas: _betas, ...body } = built!;
			return { built: body, sent: calls.at(-1)! };
		};

		// Claude's request is the one pi-ai built, to the byte, with the connector's schema as it gave it.
		const forClaude = await ask(claude);
		expect(forClaude.sent.raw).toBe(JSON.stringify(forClaude.built));
		expect(forClaude.sent.body.tools[0].input_schema).toEqual({ type: "object", properties: FIRECRAWL_ENRICH.properties, required: [] });

		// Gemini behind the same gateway gets a schema Vertex takes, the constraint-only branches folded into the person's fields.
		const forGemini = await ask({ ...claude, id: "gemini-4-argon" });
		expect(vertexViolations(forGemini.sent.body.tools[0].input_schema)).toEqual([]);
		expect(forGemini.sent.body.tools[0].input_schema.properties.people).toEqual(typedSchema(FIRECRAWL_ENRICH.properties.people));
		// The rest of the request is what pi-ai built.
		const { tools: _sent, ...rest } = forGemini.sent.body;
		const { tools: _built, ...built } = forGemini.built;
		expect(rest).toEqual(built);
		// The tool's own schema, which checks the model's arguments, is left as it was.
		expect(tool.parameters).toEqual(FIRECRAWL_ENRICH);
	});

	it("sends a model other than Claude its failed tool results as text that says so, and Claude's with is_error as pi-ai makes them", async () => {
		const provider = await prepareProvider({ name: "Gateway", url: "https://claude.test", key: "proxy-key", api: "anthropic-messages" }, null, new Set());
		const models = createModels();
		models.setProvider(piProvider("own:gateway", provider));
		const claude = models.getModel("own:gateway", "claude-sonnet-5-5")!;
		expect(claude.input).toContain("image");
		const call = (id: string) => ({ type: "toolCall" as const, id, name: "lookup", arguments: { who: "Jane" } });
		const result = (id: string, isError: boolean, ...content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]) => ({
			role: "toolResult" as const,
			toolCallId: id,
			toolName: "lookup",
			content,
			isError,
			timestamp: 1,
		});
		// An earlier turn on another model, which thought and called four tools: three failed, one with a screenshot and an empty text.
		const earlier = {
			...fauxAssistantMessage([{ type: "thinking", thinking: "Let me look.", thinkingSignature: "sig-1" }, call("toolu_a"), call("toolu_b"), call("toolu_c"), call("toolu_d")], { stopReason: "toolUse" }),
			provider: "anthropic",
			api: "anthropic-messages" as const,
			model: "claude-opus-4-6",
		};
		const messages = [
			{ role: "user" as const, content: "Look Jane up", timestamp: 1 },
			earlier,
			result("toolu_a", true, { type: "text", text: "Not found" }),
			result("toolu_b", true, { type: "image", data: "aGk=", mimeType: "image/png" }, { type: "text", text: "" }, { type: "text", text: "Timed out" }),
			result("toolu_c", true, { type: "text", text: "Error: no such person" }),
			result("toolu_d", false, { type: "text", text: "Found Jane" }),
			{ role: "user" as const, content: "And?", timestamp: 2 },
		];
		const ask = async (model: typeof claude) => {
			let built: any;
			await models.completeSimple(model, { systemPrompt: "Be helpful.", messages }, {
				onPayload: (params) => {
					built = JSON.parse(JSON.stringify(params));
					return undefined;
				},
			});
			const { betas: _betas, ...body } = built;
			return { built: body, sent: calls.at(-1)! };
		};

		// Claude's request is the one pi-ai built, to the byte, is_error and all.
		const forClaude = await ask(claude);
		expect(forClaude.sent.raw).toBe(JSON.stringify(forClaude.built));
		expect(forClaude.built.messages[2].content.map((block: { is_error: boolean }) => block.is_error)).toEqual([true, true, true, false]);
		expect(messageViolations(forClaude.built.messages)).toEqual(expect.arrayContaining(["messages[2].content[0]: is_error", "messages[2].content[1].content[1]: empty text"]));

		// Gemini behind the same gateway is told in each failed result's text, once, and never sent is_error or an empty text.
		const forGemini = await ask({ ...claude, id: "gemini-4-argon" });
		const sent = forGemini.sent.body.messages;
		expect(sent[2].content).toEqual([
			{ type: "tool_result", tool_use_id: "toolu_a", content: "Error: Not found" },
			{ type: "tool_result", tool_use_id: "toolu_b", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }, { type: "text", text: "Error: Timed out" }] },
			{ type: "tool_result", tool_use_id: "toolu_c", content: "Error: no such person" },
			{ type: "tool_result", tool_use_id: "toolu_d", content: "Found Jane" },
		]);
		expect(messageViolations(sent)).toEqual([]);
		// The rest of the request is what pi-ai built.
		expect(sent.filter((_: unknown, n: number) => n !== 2)).toEqual(forGemini.built.messages.filter((_: unknown, n: number) => n !== 2));
		const { messages: _sent, ...rest } = forGemini.sent.body;
		const { messages: _built, ...built } = forGemini.built;
		expect(rest).toEqual(built);
	});

	it("rewrites Firecrawl's people schema and Pim's own unions to Vertex's rules", () => {
		const people = FIRECRAWL_ENRICH.properties.people;
		// The person's fields stay as Firecrawl typed them; its branches, which only say which fields go together, go.
		expect(typedSchema(people)).toEqual({
			type: "array",
			description: people.description,
			minItems: 1,
			maxItems: 10,
			items: { type: "object", properties: people.items.properties },
		});
		const typed = typedSchema({
			type: "object",
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$defs: { place: { properties: { city: { pattern: "\\S" } }, additionalProperties: false } },
			required: ["color", "missing"],
			properties: {
				// create_agent's color, the union Vertex refused with "When using any_of, it must be the only field set".
				color: { anyOf: [{ type: "string", const: "gray" }, { type: "string", const: "red" }], description: "The color behind its emoji." },
				at: { anyOf: [{ type: "integer", description: "Milliseconds." }, { type: "string", format: "date-time" }], description: "When." },
				either: { type: "object", properties: { a: { type: "string" } }, anyOf: [{ type: "object", properties: { b: { type: "number" } } }, { type: "object", properties: { c: { type: "boolean" } } }] },
				level: { enum: [1, 2, 3], description: "How loud." },
				any: {},
				said: { description: "Anything." },
				code: { pattern: "^[A-Z]+$", format: "uri", minimum: 1 },
				kind: { const: true },
				ratio: { minimum: 0, exclusiveMaximum: 1, multipleOf: 0.1 },
				maybe: { anyOf: [{ type: "integer" }, { type: "null" }] },
				nullable: { type: ["string", "null"], default: null },
				home: { $ref: "#/$defs/place" },
				tags: { type: "array", uniqueItems: true },
				map: { type: "object", patternProperties: { "^.*$": {} }, additionalProperties: true },
				both: { allOf: [{ properties: { x: { type: "string" } }, required: ["x"] }, { properties: { y: { type: "integer", default: 2 } } }] },
			},
		});
		expect(typed).toEqual({
			type: "object",
			required: ["color"],
			properties: {
				color: { type: "string", enum: ["gray", "red"], description: "The color behind its emoji." },
				at: { anyOf: [{ type: "integer", description: "Milliseconds." }, { type: "string", format: "date-time", description: "When." }] },
				either: {
					anyOf: [
						{ type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
						{ type: "object", properties: { a: { type: "string" }, c: { type: "boolean" } } },
					],
				},
				level: { type: "integer", description: "How loud. One of: 1, 2, 3." },
				any: { type: "string" },
				said: { type: "string", description: "Anything." },
				code: { type: "string", pattern: "^[A-Z]+$" },
				kind: { type: "boolean", description: "One of: true." },
				ratio: { type: "number", minimum: 0 },
				maybe: { type: "integer" },
				nullable: { type: "string" },
				home: { type: "object", properties: { city: { type: "string", pattern: "\\S" } } },
				tags: { type: "array", items: { type: "string" } },
				map: { type: "object" },
				both: { type: "object", properties: { x: { type: "string" }, y: { type: "integer", default: 2 } }, required: ["x"] },
			},
		});
		expect(vertexViolations(typed)).toEqual([]);
		// The validator does catch what Vertex refused.
		expect(vertexViolations({ type: "string", anyOf: [{ type: "string" }, { type: "integer" }] })).toEqual(["(root): type beside anyOf"]);
		expect(vertexViolations({ type: "object", properties: { p: { anyOf: [{ pattern: "\\S" }] } }, required: ["q"] })).toEqual([
			"(root): requires q, which isn't in properties",
			"(root).p: anyOf of fewer than two",
			"(root).p.anyOf[0]: type undefined",
		]);
	});

	it("sends a Gemini model behind a Messages gateway every tool and message of an agent's turn in a form Vertex takes", async () => {
		await runInDurableObject(env.Pim.getByName(OWNER), (pim: Pim) => pim.enableTriggerEngine());
		expect((await post("/providers", { name: "Gateway", url: "https://gateway.test", key: "gateway-key", api: "anthropic-messages" })).status).toBe(200);
		const session = (await post("/sessions")).body.id;
		expect((await put(`/sessions/${session}/model`, { provider: "own:gateway", id: "gemini-4-argon" })).status).toBe(200);
		// Gemini first calls a tool with arguments its schema refuses, which fails, and then answers.
		gatewayCall = { name: "fetch_url", input: { url: "nope" } };
		await say("Hello?", session);
		const sent = calls.findLast((call) => call.url.startsWith("https://gateway.test/v1/messages"))!.body;
		expect(sent.model).toBe("gemini-4-argon");
		const names = sent.tools.map((tool: { name: string }) => tool.name);
		// The tools whose schemas Vertex refused, or that hold unions, are among them.
		expect(names).toEqual(expect.arrayContaining(["create_agent", "update_agent", "create_trigger", "update_trigger", "test_trigger", "http_request"]));
		expect(sent.tools.length).toBeGreaterThan(40);
		expect(sent.tools.flatMap((tool: { name: string; input_schema: unknown }) => vertexViolations(tool.input_schema, tool.name))).toEqual([]);
		const failed = sent.messages.flatMap((message: { content: unknown }) => (Array.isArray(message.content) ? message.content : [])).find((block: { type: string }) => block.type === "tool_result");
		expect(failed).toMatchObject({ tool_use_id: "toolu_2", content: expect.stringMatching(/^Error: .*Validation failed for tool "fetch_url"/s) });
		expect(messageViolations(sent.messages)).toEqual([]);
		await api(`/sessions/${session}`, { method: "DELETE" });
		await api("/providers/gateway", { method: "DELETE" });
	});

	it("keeps a system update ahead of an answer on a Claude endpoint when another provider's answer was only reasoning", async () => {
		const provider = await prepareProvider({ name: "Proxy", url: "https://claude.test", key: "proxy-key", api: "anthropic-messages" }, null, new Set());
		const models = createModels();
		models.setProvider(piProvider("own:proxy", provider));
		const model = models.getModel("own:proxy", "claude-sonnet-5-5")!;
		const reasoning = { ...fauxAssistantMessage([{ type: "thinking", thinking: "", thinkingSignature: "{}" }]), provider: "openai", api: "openai-codex-responses" as const, model: "gpt-5" };
		const update = { role: "system" as const, content: "The tools changed.", timestamp: 1 };
		const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
		await models.completeSimple(model, { messages: [{ ...update, content: "Be helpful." }, user("Hi"), update, reasoning, user("Again")] });
		const roles = calls.at(-1)!.body.messages.map((message: { role: string }) => message.role);
		// Claude takes a system message only before an assistant message or at the end.
		expect(roles.every((role: string, index: number) => role !== "system" || roles[index + 1] === undefined || roles[index + 1] === "assistant" || roles[index + 1] === "system")).toBe(true);
	});

	it.each(["a custom Claude endpoint", "the built-in Anthropic provider"])("keeps a system update off the user's turn when an empty Claude answer followed it, on %s", async (where) => {
		const models = createModels();
		let model;
		if (where === "a custom Claude endpoint") {
			models.setProvider(piProvider("own:proxy", await prepareProvider({ name: "Proxy", url: "https://claude.test", key: "proxy-key", api: "anthropic-messages" }, null, new Set())));
			model = models.getModel("own:proxy", "claude-sonnet-5-5")!;
		} else {
			models.setProvider(piProvider("own:anthropic", await prepareProvider({ builtin: "anthropic", key: "sk-test", models: ["claude-opus-4-8"] } as never, null, new Set())));
			model = models.getModel("own:anthropic", "claude-opus-4-8")!;
		}
		const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
		const update = { role: "system" as const, content: "The tools changed.", timestamp: 1 };
		// Both answers came from Claude itself, so nothing about them is converted on the way.
		const claude = (message: ReturnType<typeof fauxAssistantMessage>) => ({ ...message, provider: model.provider, api: "anthropic-messages" as const, model: model.id });
		const answer = claude(fauxAssistantMessage("Hello"));
		for (const empty of [fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }), fauxAssistantMessage([{ type: "text", text: "  " }]), fauxAssistantMessage([{ type: "thinking", thinking: "", thinkingSignature: " " }])].map(claude)) {
			await models.completeSimple(model, { systemPrompt: "Be helpful.", messages: [user("Hi"), answer, update, empty, user("Again")] });
			const sent: { role: string; content: unknown }[] = calls.at(-1)!.body.messages;
			sent.forEach((message, index) => {
				if (message.role === "system") expect(sent[index + 1]?.role).not.toBe("user");
			});
			// A system update may end the array, and then a user message must still be there.
			expect(sent.some((message) => message.role === "user")).toBe(true);
			expect(sent.filter((message) => message.role === "user")).toHaveLength(2);
		}
	});

	it.each(BUILTINS)("connects %s with a key and chosen models, and delivers messages through its native API (%s)", async (builtin, id, endpoint, header) => {
		const catalog = await api("/providers/built-in");
		expect(catalog.status).toBe(200);
		expect(catalog.body.providers.map((provider: { id: string }) => provider.id)).toEqual(["anthropic", "openai", "google", "openrouter", "deepseek", "mistral", "groq", "xai"]);
		expect(catalog.body.providers.find((provider: { id: string }) => provider.id === builtin).models).toContainEqual(expect.objectContaining({ id }));
		const added = await post("/providers", { builtin, key: "sk-test-builtin-secret", models: [id] });
		expect(added).toMatchObject({ status: 200, body: { provider: { id: builtin, builtin, hasKey: true, chosen: [id], models: [expect.objectContaining({ id })] } } });
		const settings = (await api("/model")).body;
		expect(settings.choices).toContainEqual(expect.objectContaining({ provider: `own:${builtin}`, id }));
		expect(settings.chatgpt.connected).toBe(false);
		expect(JSON.stringify(settings)).not.toContain("sk-test-builtin-secret");
		expect((await put("/model", { provider: `own:${builtin}`, id })).status).toBe(200);
		const session = (await post("/sessions", { title: "Provider test" })).body.id;
		expect((await say("Hello?", session)).text).toBe(`Hello from ${new URL(endpoint).host}`);
		const actual = new URL(calls.at(-1)!.url);
		const expected = new URL(endpoint);
		expect(`${actual.origin}${actual.pathname}`).toBe(`${expected.origin}${expected.pathname}`);
		expect(calls.at(-1)?.headers?.[header]).toBe(header === "authorization" ? "Bearer sk-test-builtin-secret" : "sk-test-builtin-secret");
		if (builtin === "xai") expect(calls.at(-1)?.body.include).toContain("reasoning.encrypted_content");
		expect((await put(`/providers/${builtin}`, { name: "My provider" })).body.provider).toMatchObject({ name: "My provider", hasKey: true });
		expect((await say("And again?", session)).text).toBe(`Hello from ${new URL(endpoint).host}`);
		expect((await api(`/providers/${builtin}`, { method: "DELETE" })).status).toBe(200);
		expect((await api("/model")).body.model.id).toBe("faux-model");
	});

	it("requires a known service, key and catalog models, and never accepts an address override", async () => {
		for (const input of [
			{ builtin: "unknown", key: "secret", models: ["gpt-4.1"] },
			{ builtin: "openai", models: ["gpt-4.1"] },
			{ builtin: "openai", key: "secret", models: [] },
			{ builtin: "openai", key: "secret", models: ["not-a-model"] },
			{ builtin: "openai", key: "secret", models: ["gpt-4.1"], url: "https://models.test/v1" },
		]) expect((await post("/providers", input)).status).toBe(400);
		const added = await post("/providers", { builtin: "openai", key: "first-key", models: ["gpt-4.1"] });
		expect(added.status).toBe(200);
		expect((await post("/providers", { builtin: "openai", key: "second-key", models: ["gpt-4.1"] })).body.provider.id).toBe("openai-2");
		expect((await put("/providers/openai", { builtin: "groq" })).status).toBe(400);
		expect((await put("/providers/openai", { key: "" })).status).toBe(400);
		expect((await put("/providers/openai", { key: "replacement-key" })).status).toBe(200);
		await put("/model", { provider: "own:openai", id: "gpt-4.1" });
		const session = (await post("/sessions", { title: "Replacement key" })).body.id;
		expect((await say("Hello?", session)).text).toBe("Hello from api.openai.com");
		expect(calls.at(-1)?.authorization).toBe("Bearer replacement-key");
		for (const id of ["openai", "openai-2"]) await api(`/providers/${id}`, { method: "DELETE" });
	});

	it("offer the models their server lists, run chats on them, and go away with the choice of one", async () => {
		const added = await post("/providers", { name: "Home server", url: "http://localhost:1234/v1/" });
		expect(added.status).toBe(200);
		expect(added.body.provider).toEqual({
			id: "home-server",
			name: "Home server",
			url: "http://localhost:1234/v1",
			hasKey: false,
			chosen: null,
			structuredOutput: false,
			models: [
				{ id: "local-model", name: "local-model", contextWindow: 128_000, maxTokens: 8_192, images: false, reasoning: false },
				{ id: "vision-model", name: "Vision", contextWindow: 32_768, maxTokens: 8_192, images: true, reasoning: false },
				{ id: "served-model", name: "served-model", contextWindow: 4_096, maxTokens: 2_048, images: false, reasoning: false },
			],
		});

		const { body: model } = await api("/model");
		expect(model.providers).toEqual([{ ...added.body.provider, provider: "own:home-server", shared: false }]);
		expect(model.choices.slice(1)).toEqual([
			{ provider: "own:home-server", id: "local-model", name: "local-model", images: false },
			{ provider: "own:home-server", id: "vision-model", name: "Vision", images: true },
			{ provider: "own:home-server", id: "served-model", name: "served-model", images: false },
		]);

		const before = await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) => instance.usage.today());
		expect((await put("/model", { provider: "own:home-server", id: "vision-model" })).status).toBe(200);
		expect((await say("Hello?")).text).toBe("Hello from home");
		const chat = calls.at(-1)!;
		expect(chat.url).toBe("http://localhost:1234/v1/chat/completions");
		expect(chat.body).toMatchObject({ model: "vision-model", stream: true });
		// Instructions go as a system message, which every compatible server takes.
		expect(chat.body.messages[0].role).toBe("system");
		// The person pays for their own provider: its tokens don't count against the deployment's limit.
		const today = await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) => instance.usage.today());
		expect(today.planTokens - before.planTokens).toBe(13);

		expect((await api("/providers/home-server", { method: "DELETE" })).body).toEqual({ deleted: true });
		const after = (await api("/model")).body;
		expect(after.model.id).toBe("faux-model");
		expect(after.providers).toEqual([]);
		// The chat that was on it goes on with the default model.
		faux.setResponses([toolUse("send_to_user", { message: "Back on the default." })]);
		expect((await say("Still there?")).text).toBe("Back on the default.");
		expect((await api("/providers/home-server", { method: "DELETE" })).status).toBe(404);
	});

	it("runs each agent on its own model, and follows the default model for agents that have none", async () => {
		expect((await post("/providers", { name: "Home server", url: "http://localhost:1234/v1/" })).status).toBe(200);
		const coach = (await post("/agents", { name: "Coach", instructions: "x" })).body;
		const other = (await post("/agents", { name: "Writer", instructions: "x" })).body;
		expect(coach.model).toBeNull();
		const agentPut = (agent: string, body: unknown) => put(`/agents/${agent}/model`, body);
		expect((await agentPut(coach.id, { provider: "own:home-server", id: "nope" })).status).toBe(400);
		expect((await agentPut(coach.id, { provider: "own:home-server" })).status).toBe(400);
		expect((await agentPut(coach.id, { provider: "own:home-server", id: "vision-model" })).body.model).toEqual({ provider: "own:home-server", id: "vision-model" });
		expect((await api("/agents")).body.agents.find((agent: { id: string }) => agent.id === coach.id).model).toEqual({ provider: "own:home-server", id: "vision-model" });

		// Only the coach's chats go to the home server; the writer's stay on the default model.
		const coachChat = (await post("/sessions", { agent: coach.id })).body.id;
		const writerChat = (await post("/sessions", { agent: other.id })).body.id;
		expect((await say("Hello?", coachChat)).text).toBe("Hello from home");
		expect(calls.at(-1)!.body).toMatchObject({ model: "vision-model" });
		faux.setResponses([toolUse("send_to_user", { message: "Writer here." })]);
		expect((await say("Hello?", writerChat)).text).toBe("Writer here.");

		// Choosing the default model moves the writer, not the coach, and an earlier chat follows its agent.
		expect((await put("/model", { provider: "own:home-server", id: "local-model" })).status).toBe(200);
		expect((await say("Again?", writerChat)).text).toBe("Hello from home");
		expect(calls.at(-1)!.body).toMatchObject({ model: "local-model" });
		expect((await say("Again?", coachChat)).text).toBe("Hello from home");
		expect(calls.at(-1)!.body).toMatchObject({ model: "vision-model" });

		// Null follows the default again; a provider that goes takes its agents' models with it.
		expect((await agentPut(coach.id, { provider: null, id: null })).body.model).toBeNull();
		expect((await say("Once more?", coachChat)).text).toBe("Hello from home");
		expect(calls.at(-1)!.body).toMatchObject({ model: "local-model" });
		await agentPut(other.id, { provider: "own:home-server", id: "served-model" });
		expect((await api("/providers/home-server", { method: "DELETE" })).status).toBe(200);
		expect((await api(`/agents/${other.id}`)).body.model).toBeNull();
		faux.setResponses([toolUse("send_to_user", { message: "Back on the default." })]);
		expect((await say("Still there?", writerChat)).text).toBe("Back on the default.");
	});

	it("changes one session's model by {provider, id}, by {model: \"<provider>/<id>\"} with the longest provider prefix, or by a bare default id", async () => {
		expect((await post("/providers", { builtin: "openrouter", key: "k", models: ["anthropic/claude-sonnet-4.6"] })).status).toBe(200);
		expect((await post("/providers", { name: "Proxy", url: "https://claude.test", key: "proxy-key", api: "anthropic-messages" })).status).toBe(200);
		const session = (await post("/sessions")).body.id;
		const set = (body: unknown) => put(`/sessions/${session}/model`, body);
		const proxy = { provider: "own:proxy", id: "claude-sonnet-5-5" };
		expect(await set(proxy)).toMatchObject({ status: 200, body: { model: proxy } });
		expect((await say("Hello?", session)).text).toBe("Hello from claude.test");
		// A model id with "/" in it keeps its whole id after the provider.
		expect((await set({ model: "own:openrouter/anthropic/claude-sonnet-4.6" })).body.model).toMatchObject({ provider: "own:openrouter", id: "anthropic/claude-sonnet-4.6" });
		expect((await set({ model: "own:proxy/claude-sonnet-5-5" })).body.model).toMatchObject(proxy);
		// A bare id is the legacy Workers AI form; this test Pim does not offer that one.
		const legacy = await set({ model: "faux-model" });
		expect(legacy.status).toBe(400);
		expect(legacy.body.error ?? JSON.stringify(legacy.body)).toContain("is not a model this");
		// Errors say what to send.
		for (const body of [{ provider: "own:proxy", id: "nope" }, { model: "own:proxy/nope" }, { model: "faux-model" }, {}]) {
			const bad = await set(body);
			expect(bad.status).toBe(400);
			expect(bad.body.error ?? JSON.stringify(bad.body)).toContain(`Send {provider, id} of one of GET /model's choices (for example {"provider":"own:ai-gateway","id":"claude-sonnet-5-5"}), or {model:"<provider>/<id>"}.`);
		}
		for (const id of ["openrouter", "proxy"]) await api(`/providers/${id}`, { method: "DELETE" });
	});

	it("speaks the Anthropic Messages API to a custom endpoint that is set to", async () => {
		expect((await post("/providers", { name: "Proxy", url: "https://claude.test", api: "gpt" })).status).toBe(400);
		const added = await post("/providers", { name: "Proxy", url: "https://claude.test", key: "proxy-key", api: "anthropic-messages" });
		expect(added.body.provider).toMatchObject({ id: "proxy", api: "anthropic-messages", models: [{ id: "claude-sonnet-5-5" }] });
		expect(calls[0]).toMatchObject({ url: "https://claude.test/v1/models", headers: expect.objectContaining({ "x-api-key": "proxy-key", "anthropic-version": "2023-06-01" }) });
		expect((await put("/model", { provider: "own:proxy", id: "claude-sonnet-5-5" })).status).toBe(200);
		expect((await say("Hello?")).text).toBe("Hello from claude.test");
		expect(calls.at(-1)).toMatchObject({ url: expect.stringMatching(/^https:\/\/claude.test\/v1\/messages/), headers: expect.objectContaining({ "x-api-key": "proxy-key", authorization: "Bearer proxy-key" }) });
		// A Claude model that only takes adaptive thinking is never sent a thinking budget, which its API refuses.
		expect(calls.at(-1)!.body.thinking?.type).not.toBe("enabled");
		// A failed request is logged with the API, the request's own settings, never its content.
		claudeFails = true;
		const warn = vi.spyOn(console, "warn");
		const held = (await post("/sessions")).body.id;
		await post(`/sessions/${held}/messages`, { content: "Secret words" });
		const failure = await vi.waitFor(() => {
			const line = warn.mock.calls.map(([text]) => JSON.parse(String(text))).find((entry) => entry.event === "pim.model_error" && entry.provider === "own:proxy");
			expect(line).toBeDefined();
			return line;
		}, { timeout: 15_000 });
		claudeFails = false;
		await api(`/sessions/${held}`, { method: "DELETE" });
		expect(failure).toMatchObject({ api: "anthropic-messages", baseUrl: "https://claude.test", request: { model: "claude-sonnet-5-5", thinking: { type: "adaptive" } } });
		expect(JSON.stringify(failure)).not.toContain("Secret words");
		// The call keeps the provider's whole answer, and the request's settings without its content.
		const [call] = await runInDurableObject(env.Pim.getByName(OWNER), (pim: Pim) =>
			(pim as unknown as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql.exec("SELECT stop_reason, error, request FROM pim_model_calls WHERE provider = 'own:proxy' AND stop_reason = 'error' ORDER BY id DESC LIMIT 1").toArray(),
		);
		expect(call).toMatchObject({ stop_reason: "error", error: '400 {"type":"error","error":{"type":"invalid_request_error","message":"thinking is wrong"}}' });
		expect(JSON.parse(String(call!.request))).toMatchObject({ model: "claude-sonnet-5-5", thinking: { type: "adaptive" } });
		expect(String(call!.request)).not.toContain("Secret words");
		// Saving again keeps the API it speaks.
		expect((await put("/providers/proxy", { name: "Proxy 2" })).body.provider).toMatchObject({ api: "anthropic-messages" });
		await api("/providers/proxy", { method: "DELETE" });
	});

	it("takes a custom endpoint's real context window and prices, and keeps them when its models are read again", async () => {
		await post("/providers", { name: "Home server", url: "http://localhost:1234/v1/" });
		const overrides = { "vision-model": { contextWindow: 200_000, cost: { input: 3, output: 15 } } };
		const saved = (await put("/providers/home-server", { overrides })).body.provider;
		expect(saved.models.find((model: { id: string }) => model.id === "vision-model")).toMatchObject({ contextWindow: 200_000, maxTokens: 8_192, cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } });
		// What the server says about the others stays; saving again keeps the settings.
		expect(saved.models.find((model: { id: string }) => model.id === "served-model")).toMatchObject({ contextWindow: 4_096 });
		expect((await put("/providers/home-server", { name: "Home" })).body.provider.overrides).toEqual({ "vision-model": { contextWindow: 200_000, cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } } });

		// A chat's cost is its tokens at that price: 10 in and 3 out, per million.
		await put("/model", { provider: "own:home-server", id: "vision-model" });
		const session = (await post("/sessions", { title: "Priced" })).body.id;
		await say("Hello?", session);
		expect((await api(`/sessions/${session}/cost`)).body.total).toBeCloseTo((10 * 3 + 3 * 15) / 1e6, 10);

		expect((await put("/providers/home-server", { overrides: { "vision-model": { contextWindow: 0 } } })).status).toBe(400);
		expect((await put("/providers/home-server", { overrides: { "vision-model": { cost: { input: -1 } } } })).status).toBe(400);
		// An empty set takes them away.
		expect((await put("/providers/home-server", { overrides: {} })).body.provider.models[1]).toMatchObject({ contextWindow: 32_768 });
		await api("/providers/home-server", { method: "DELETE" });
	});

	it("offers a provider's models for side jobs only when it answers in a JSON schema", async () => {
		const utility = async () => (await api("/model")).body.utility as { model: { id: string }; choices: { provider: string; id: string }[] };
		const choose = (provider: string, id: string) => put("/model/utility", { provider, id });
		// A custom endpoint says whether it does; without that its models aren't offered, and can't be chosen.
		await post("/providers", { name: "Home server", url: "http://localhost:1234/v1/" });
		expect((await utility()).choices.map((choice) => choice.id)).toEqual(["utility-model"]);
		expect((await choose("own:home-server", "local-model")).status).toBe(400);

		expect((await put("/providers/home-server", { structuredOutput: true })).body.provider).toMatchObject({ structuredOutput: true });
		expect((await utility()).choices.map((choice) => choice.id)).toEqual(["utility-model", "local-model", "vision-model", "served-model"]);
		expect((await choose("own:home-server", "local-model")).body).toMatchObject({ model: { id: "local-model" } });
		expect((await put("/providers/home-server", { structuredOutput: "yes" })).status).toBe(400);

		// Taking it back puts side jobs back on the deployment's model; the choice is kept for if it is said again.
		await put("/providers/home-server", { structuredOutput: false });
		expect((await utility()).model.id).toBe("utility-model");
		await put("/providers/home-server", { structuredOutput: true });
		expect((await utility()).model.id).toBe("local-model");

		// Services that follow a schema are offered; those that only promise valid JSON, or only for some models, aren't.
		const services = [["anthropic", "claude-sonnet-4-6", true], ["openai", "gpt-4.1", true], ["google", "gemini-2.5-flash", true], ["mistral", "mistral-large-latest", true], ["xai", "grok-4.3", true], ["deepseek", "deepseek-flash", false], ["groq", "llama-3.3-70b-versatile", false], ["openrouter", "openai/gpt-4.1", false]] as const;
		for (const [builtin, id] of services) expect((await post("/providers", { builtin, key: "sk-test", models: [id] })).status).toBe(200);
		const offered = (await utility()).choices.map((choice) => choice.provider);
		for (const [builtin, , schemaOutput] of services) expect(offered.includes(`own:${builtin}`)).toBe(schemaOutput);
		expect((await choose("own:deepseek", "deepseek-flash")).status).toBe(400);
		expect((await choose("own:openai", "gpt-4.1")).status).toBe(200);
		for (const id of ["home-server", ...services.map(([builtin]) => builtin)]) await api(`/providers/${id}`, { method: "DELETE" });
	});

	it("keep a provider's key to themselves, and offer only models its server lists", async () => {
		const unkeyed = await post("/providers", { name: "Cloud", url: "https://models.test/v1" });
		expect(unkeyed).toMatchObject({ status: 400, body: { error: expect.stringContaining("it answered 401") } });
		const unasked = await post("/providers", { name: "Cloud", url: "https://models.test/v1", key: "secret-key" });
		expect(unasked).toMatchObject({ status: 400, body: { error: expect.stringContaining("lists 60 models. Name the ones to use.") } });
		const unknown = await post("/providers", { name: "Cloud", url: "https://models.test/v1", key: "secret-key", models: ["gpt-9"] });
		expect(unknown).toMatchObject({ status: 400, body: { error: "https://models.test/v1 doesn't list a model gpt-9" } });
		expect((await post("/providers", { name: "Cloud", url: "ftp://models.test/v1" })).status).toBe(400);

		const added = await post("/providers", { name: "Cloud", url: "https://models.test/v1", key: "secret-key", models: ["gpt-4.1"] });
		expect(added.body.provider).toMatchObject({ id: "cloud", hasKey: true, chosen: ["gpt-4.1"] });
		// pi-ai knows the model by its id, so Pim knows it sees images.
		expect(added.body.provider.models).toEqual([expect.objectContaining({ id: "gpt-4.1", images: true })]);

		// A change that leaves the key out keeps it.
		const renamed = await put("/providers/cloud", { name: "Cloud API" });
		expect(renamed.body.provider).toMatchObject({ name: "Cloud API", hasKey: true });
		expect(calls.at(-1)).toMatchObject({ url: "https://models.test/v1/models", authorization: "Bearer secret-key" });

		await put("/model", { provider: "own:cloud", id: "gpt-4.1" });
		expect((await say("Hello?")).text).toBe("Hello from the cloud");
		expect(calls.at(-1)).toMatchObject({ url: "https://models.test/v1/chat/completions", authorization: "Bearer secret-key" });
		const exported = (await api("/export")).body;
		expect(exported.providers).toEqual([expect.objectContaining({ id: "cloud", hasKey: true })]);
		for (const shown of [added.body, renamed.body, (await api("/model")).body, exported]) expect(JSON.stringify(shown)).not.toContain("secret-key");

		await put("/model", { provider: "faux", id: "faux-model" });
		expect((await api("/providers/cloud", { method: "DELETE" })).body).toEqual({ deleted: true });
	});
});

describe("a model's output limit", () => {
	const catalog = (provider: "anthropic" | "openai" | "google" | "openrouter", id: string) => (getBuiltinModels(provider) as any[]).find((model) => model.id === id);
	// Each row: what the server lists, the catalog's model, the person's override, and the context window and output limit Pim keeps.
	const rows: [string, Record<string, unknown> | undefined, any, any, number, number][] = [
		["anthropic catalog", undefined, catalog("anthropic", "claude-sonnet-4-6"), undefined, 1_000_000, 128_000],
		["openai catalog", undefined, catalog("openai", "gpt-4.1"), undefined, 1_047_576, 32_768],
		["google catalog", undefined, catalog("google", "gemini-2.5-flash"), undefined, 1_048_576, 65_536],
		["openrouter listing beats the catalog", { context_length: 200_000, top_provider: { max_completion_tokens: 64_000 } }, catalog("openrouter", "openai/gpt-4.1"), undefined, 200_000, 64_000],
		["gateway listing, max_output_tokens", { id: "gemini-4-argon", max_output_tokens: 65_536, context_length: 1_000_000 }, undefined, undefined, 1_000_000, 65_536],
		["gateway listing, Gemini's outputTokenLimit", { outputTokenLimit: 32_768 }, undefined, undefined, 128_000, 32_768],
		["custom endpoint with no metadata", { id: "gemini-4-argon" }, undefined, undefined, 128_000, 8_192],
		["override beats the listing", { max_output_tokens: 8_000 }, undefined, { maxTokens: 40_000 }, 128_000, 40_000],
		["output as large as the context is halved", { context_length: 16_000, max_completion_tokens: 16_000 }, undefined, undefined, 16_000, 8_000],
		["output larger than the context is halved", { max_model_len: 10_000, max_output_tokens: 64_000 }, undefined, undefined, 10_000, 5_000],
		["tiny context", { max_model_len: 4_096 }, undefined, undefined, 4_096, 2_048],
		["override larger than a context override", undefined, undefined, { contextWindow: 20_000, maxTokens: 50_000 }, 20_000, 10_000],
	];
	it.each(rows)("resolves for %s", (_name, listed, known, override, contextWindow, maxTokens) => {
		expect(describeModel("m", listed, known, override)).toMatchObject({ contextWindow, maxTokens });
	}, 10_000);

	it("takes a person's output limit only as a whole number of tokens", async () => {
		const bad = await prepareProvider({ name: "x", url: "http://localhost:1234/v1", models: ["local-model"], overrides: { "local-model": { maxTokens: 1.5 } } }, null, new Set()).catch((error) => error);
		expect(bad.message).toContain("maxTokens must be a whole number");
	}, 10_000);
});
