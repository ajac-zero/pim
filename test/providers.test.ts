import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { piProvider, prepareProvider } from "../src/providers";
import { api, OWNER, post, say, toolUse } from "./helpers";
import { completionStream, faux, type Pim } from "./worker";

/*
 * Two OpenAI-compatible servers behind `fetch`: one at home, which needs no
 * key and lists three models, and one in the cloud, which needs `secret-key`
 * and lists more models than Pim offers unasked.
 */

type Call = { url: string; authorization: string | null; headers?: Record<string, string>; body: any };

let calls: Call[];

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
function builtinStream(url: URL, model: string): Response {
	const message = `Hello from ${url.host}`;
	const args = JSON.stringify({ message });
	let events: Record<string, unknown>[];
	if (url.pathname.endsWith("/messages")) {
		events = [
			{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model, usage: { input_tokens: 10, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "send_to_user", input: {} } },
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
		if (url.origin === "https://claude.test") {
			if (url.pathname === "/v1/models") {
				calls.push({ url: request.url, authorization: request.headers.get("authorization"), headers: Object.fromEntries(request.headers), body: null });
				return Response.json({ data: [{ id: "proxy-claude" }] });
			}
			const body = await request.json<{ model: string }>();
			calls.push({ url: request.url, authorization: request.headers.get("authorization"), headers: Object.fromEntries(request.headers), body });
			return builtinStream(url, body.model);
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
				{ id: "served-model", name: "served-model", contextWindow: 4_096, maxTokens: 4_096, images: false, reasoning: false },
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

	it("speaks the Anthropic Messages API to a custom endpoint that is set to", async () => {
		expect((await post("/providers", { name: "Proxy", url: "https://claude.test", api: "gpt" })).status).toBe(400);
		const added = await post("/providers", { name: "Proxy", url: "https://claude.test", key: "proxy-key", api: "anthropic-messages" });
		expect(added.body.provider).toMatchObject({ id: "proxy", api: "anthropic-messages", models: [{ id: "proxy-claude" }] });
		expect(calls[0]).toMatchObject({ url: "https://claude.test/v1/models", headers: expect.objectContaining({ "x-api-key": "proxy-key", "anthropic-version": "2023-06-01" }) });
		expect((await put("/model", { provider: "own:proxy", id: "proxy-claude" })).status).toBe(200);
		expect((await say("Hello?")).text).toBe("Hello from claude.test");
		expect(calls.at(-1)).toMatchObject({ url: expect.stringMatching(/^https:\/\/claude.test\/v1\/messages/), headers: expect.objectContaining({ "x-api-key": "proxy-key" }) });
		// Saving again keeps the API it speaks.
		expect((await put("/providers/proxy", { name: "Proxy 2" })).body.provider).toMatchObject({ api: "anthropic-messages" });
		await api("/providers/proxy", { method: "DELETE" });
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
