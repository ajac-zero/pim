import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, OWNER, post, say, toolUse } from "./helpers";
import { completionStream, faux, type Pim } from "./worker";

/*
 * Two OpenAI-compatible servers behind `fetch`: one at home, which needs no
 * key and lists three models, and one in the cloud, which needs `secret-key`
 * and lists more models than Pim offers unasked.
 */

type Call = { url: string; authorization: string | null; body: any };

let calls: Call[];

const CLOUD_MODELS = [{ id: "gpt-4.1" }, ...Array.from({ length: 59 }, (_, n) => ({ id: `cloud-model-${n}` }))];

beforeEach(() => {
	calls = [];
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
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
	it("offer the models their server lists, run chats on them, and go away with the choice of one", async () => {
		const added = await post("/providers", { name: "Home server", url: "http://localhost:1234/v1/" });
		expect(added.status).toBe(200);
		expect(added.body.provider).toEqual({
			id: "home-server",
			name: "Home server",
			url: "http://localhost:1234/v1",
			hasKey: false,
			chosen: null,
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

		expect((await put("/model", { provider: "own:home-server", id: "vision-model" })).status).toBe(200);
		expect((await say("Hello?")).text).toBe("Hello from home");
		const chat = calls.at(-1)!;
		expect(chat.url).toBe("http://localhost:1234/v1/chat/completions");
		expect(chat.body).toMatchObject({ model: "vision-model", stream: true });
		// Instructions go as a system message, which every compatible server takes.
		expect(chat.body.messages[0].role).toBe("system");
		// The person pays for their own provider: its tokens don't count against the deployment's limit.
		const today = await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) => instance.usage.today());
		expect(today.planTokens).toBe(13);

		expect((await api("/providers/home-server", { method: "DELETE" })).body).toEqual({ deleted: true });
		const after = (await api("/model")).body;
		expect(after.model.id).toBe("faux-model");
		expect(after.providers).toEqual([]);
		// The chat that was on it goes on with the default model.
		faux.setResponses([toolUse("send_to_user", { message: "Back on the default." })]);
		expect((await say("Still there?")).text).toBe("Back on the default.");
		expect((await api("/providers/home-server", { method: "DELETE" })).status).toBe(404);
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
