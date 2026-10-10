import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_NAME } from "../src/agent";
import type { Limits } from "../src/usage";
import { exports } from "cloudflare:workers";
import { api, apiUrl, post, say, TOKEN, url } from "./helpers";
import { faux, type Pim } from "./worker";

const agent = () => env.Pim.getByName(AGENT_NAME);

function setLimits(limits: Partial<Limits> | null) {
	return runInDurableObject(agent(), (instance: Pim) => instance.setLimits(limits));
}

type Usage = { today: { runs: number; modelRequests: number; tokens: number; planTokens: number }; limits: Limits };

afterEach(async () => {
	await setLimits(null);
});

describe("usage", () => {
	it("counts runs, model requests and tokens by day", async () => {
		const before = (await api<Usage>("/usage")).body.today;
		faux.setResponses([fauxAssistantMessage("Hello!")]);
		await say("Hi");
		const after = (await api<Usage>("/usage")).body;
		expect(after.today.runs).toBe(before.runs + 1);
		expect(after.today.modelRequests).toBe(before.modelRequests + 1);
		expect(after.today.tokens).toBeGreaterThan(before.tokens);
		// A self-hosted Pim has no limits unless PIM_LIMITS sets some.
		expect(after.limits).toMatchObject({ dailyTokens: null, dailyRuns: null, sessions: null });
	});

	it("counts the ChatGPT plan's tokens apart, so they never use up the deployment's allowance", async () => {
		await runInDurableObject(agent(), (instance: Pim) => {
			const usage = { input: 600, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			const tokens = instance.usage.today().tokens;
			instance.usage.recordModel("openai", "gpt-6.1-sol", usage);
			expect(instance.usage.today()).toMatchObject({ tokens, planTokens: expect.any(Number) });
			expect(instance.usage.today().planTokens).toBeGreaterThanOrEqual(1000);
		});
		const { tokens } = (await api<Usage>("/usage")).body.today;
		await setLimits({ dailyTokens: tokens });
		await runInDurableObject(agent(), (instance: Pim) => {
			expect(instance.usage.modelRefusal("faux")).toMatch(/quota exceeded/);
			expect(instance.usage.modelRefusal("openai")).toBeNull();
		});
	});
});

describe("limits", () => {
	it("refuse a run past the daily limit", async () => {
		const { runs } = (await api<Usage>("/usage")).body.today;
		await setLimits({ dailyRuns: runs });
		const refused = await post("/sessions/1/messages", { content: "One more" });
		expect(refused.status).toBe(429);
		expect(refused.body.error).toMatch(/quota exceeded: today's \d+ runs are used up/);
	});

	it("stop a run once the model allowance is used up, without retrying it", async () => {
		const { modelRequests } = (await api<Usage>("/usage")).body.today;
		await setLimits({ dailyModelRequests: modelRequests });
		const started = Date.now();
		// No scripted response: the model is never asked.
		const answer = await say("Are you there?");
		expect(answer).toMatchObject({ status: "unanswered", reason: "model_error" });
		// The person reads why in the chat.
		const { messages } = (await api("/sessions/1/messages")).body;
		expect(JSON.stringify(messages.at(-1))).toMatch(/quota exceeded: today's \d+ model requests are used up/);
		// Retries back off for seconds; a quota error is final.
		expect(Date.now() - started).toBeLessThan(3_000);
		expect((await api<Usage>("/usage")).body.today.modelRequests).toBe(modelRequests);
	});

	it("cap open chats", async () => {
		const open = (await api<{ sessions: unknown[] }>("/sessions")).body.sessions.length;
		await setLimits({ sessions: open });
		expect((await post("/sessions")).status).toBe(429);
		await setLimits({ sessions: open + 1 });
		expect((await post("/sessions")).status).toBe(200);
	});

	it("refuse values that are not limits", async () => {
		await expect(setLimits({ dailyRuns: -1 })).rejects.toThrow(/non-negative integer/);
		await expect(setLimits({ unknown: 1 } as never)).rejects.toThrow(/Unknown limit/);
	});
});

describe("settings", () => {
	it("are the deployment's until the owner changes them, and back with null", async () => {
		expect((await api("/settings")).body).toMatchObject({
			timeZone: "America/New_York",
			approvalPolicy: "auto",
			approvalTimeoutSeconds: 1.5,
			notifyWebhook: null,
		});
		const put = (body: unknown) => api("/settings", { method: "PUT", body: JSON.stringify(body) });
		expect((await put({ timeZone: "Mars/Olympus" })).status).toBe(400);
		expect((await put({ notifyWebhook: "http://insecure.example" })).status).toBe(400);
		expect((await put({ theme: "dark" })).status).toBe(400);
		expect((await put({ timeZone: "Asia/Tokyo" })).body).toMatchObject({ timeZone: "Asia/Tokyo" });
		expect((await api("/")).body).toMatchObject({ timeZone: "Asia/Tokyo" });
		expect((await put({ timeZone: null })).body).toMatchObject({ timeZone: "America/New_York" });
	});
});

describe("the agent's own checks", () => {
	it("refuses a request the Worker didn't route to it", async () => {
		const stub = agent();
		expect((await stub.fetch(url("/sessions"))).status).toBe(421);
		expect((await stub.fetch(url("/sessions"), { headers: { "x-pim-owner": "someone-else" } })).status).toBe(421);
	});
});

describe("export", () => {
	it("has the person's data and none of the credentials", async () => {
		await post("/memory/log", { text: "Likes window seats" });
		const exported = await runInDurableObject(agent(), (instance: Pim) => {
			instance.store.putCredential("openai", JSON.stringify({ type: "oauth", access: "SECRET-ACCESS-TOKEN", refresh: "SECRET-REFRESH" }));
			return instance.exportData();
		});
		// The API serves the same export as a download.
		const download = await exports.default.fetch(new Request(apiUrl("/export"), { headers: { Authorization: `Bearer ${TOKEN}` } }));
		expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="pim-export-/);
		expect(await download.text()).not.toContain("SECRET-");
		const data = JSON.parse(exported);
		expect(data).toMatchObject({ format: "pim-export", version: 1, settings: { timeZone: "America/New_York" } });
		expect(JSON.stringify(data.memory)).toContain("Likes window seats");
		expect(data.sessions.length).toBeGreaterThan(0);
		expect(exported).not.toContain("SECRET-");
		expect(exported).not.toContain("cookie_key");
		await runInDurableObject(agent(), (instance: Pim) => instance.store.deleteCredential("openai"));
	});
});
