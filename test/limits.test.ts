import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Limits, UNLIMITED, UsageMeter } from "../src/usage";
import { exports } from "cloudflare:workers";
import { api, apiUrl, OWNER, post, ROOT, say, TOKEN, toolUse, url } from "./helpers";
import { faux, type Pim } from "./worker";

const agent = () => env.Pim.getByName(OWNER);

function setLimits(limits: Partial<Limits> | null) {
	return runInDurableObject(agent(), (instance: Pim) => instance.setLimits(limits));
}

type Usage = { today: { runs: number; modelRequests: number; tokens: number; planTokens: number }; limits: Limits };

afterEach(async () => {
	await setLimits(null);
});

describe("usage", () => {
	it("counts runs, model requests and tokens by day", async () => {
		const session = (await post("/sessions")).body.id;
		const before = (await api<Usage>("/usage")).body.today;
		faux.setResponses([toolUse("send_to_user", { message: "Hello!" })]);
		await say("Hi", session);
		const after = (await api<Usage>("/usage")).body;
		expect(after.today.runs).toBe(before.runs + 1);
		// The run's request, and the utility model's naming the chat from its first message.
		expect(after.today.modelRequests).toBe(before.modelRequests + 2);
		expect(after.today.tokens).toBeGreaterThan(before.tokens);
		// A self-hosted Pim has no limits unless its PIM_LIMIT_* variables set some.
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

const MODEL = { provider: "faux", id: "faux-model", api: "faux" } as unknown as Model<Api>;

function answered(input: number, output: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "faux",
		provider: "faux",
		model: "faux-model",
		usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** A catalog whose requests stay open until the test ends them. */
function heldCatalog() {
	const open: AssistantMessageEventStream[] = [];
	const catalog = {
		stream: () => {
			const events = createAssistantMessageEventStream();
			open.push(events);
			return events;
		},
	} as unknown as Models;
	const finish = (events: AssistantMessageEventStream, message: AssistantMessage) => {
		events.push({ type: "done", reason: "stop", message });
		events.end(message);
	};
	return { catalog, open, finish };
}

describe("metering under concurrency", () => {
	it("counts a model request when it is sent, so two at once can't both take the last one", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			const before = instance.usage.today();
			await instance.setLimits({ dailyModelRequests: before.modelRequests + 1 });
			const { catalog, open, finish } = heldCatalog();
			const metered = instance.usage.meter(catalog);
			const first = metered.stream(MODEL, { messages: [] });
			const second = metered.stream(MODEL, { messages: [] });
			// Only the first reached the provider; the second was refused before it was sent.
			expect(open).toHaveLength(1);
			expect((await second.result()).errorMessage).toMatch(/quota exceeded: today's \d+ model requests are used up/);
			expect(instance.usage.today().modelRequests).toBe(before.modelRequests + 1);

			finish(open[0]!, answered(30, 12));
			await first.result();
			await new Promise((resolve) => setTimeout(resolve, 0));
			// Its tokens are added once, and it is still one request.
			const after = instance.usage.today();
			expect(after.modelRequests).toBe(before.modelRequests + 1);
			expect(after.tokens).toBe(before.tokens + 42);
		});
	});

	it("doesn't count a request the provider never received", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			const before = instance.usage.today().modelRequests;
			const throwing = { stream: () => { throw new Error("no provider"); } } as unknown as Models;
			expect(() => instance.usage.meter(throwing).stream(MODEL, { messages: [] })).toThrow("no provider");
			expect(instance.usage.today().modelRequests).toBe(before);
		});
	});

	it("adds a request's tokens to the day it was sent, even when it ends after midnight", async () => {
		await runInDurableObject(agent(), async (_instance: Pim, state) => {
			let now = Date.UTC(2020, 0, 1, 23, 59, 59);
			const meter = new UsageMeter({ sql: state.storage.sql, limits: () => UNLIMITED, ownProvider: () => false, now: () => now });
			const { catalog, open, finish } = heldCatalog();
			const request = meter.meter(catalog).stream(MODEL, { messages: [] });
			now += 60_000;
			finish(open[0]!, answered(5, 5));
			await request.result();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(meter.day("2020-01-01")).toMatchObject({ modelRequests: 1, tokens: 10 });
			expect(meter.day("2020-01-02")).toMatchObject({ modelRequests: 0, tokens: 0 });
		});
	});

	it("counts a run before the first await, so two at once can't both take the last one", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			const before = instance.usage.today().runs;
			await instance.setLimits({ dailyRuns: before + 1 });
			faux.setResponses([toolUse("send_to_user", { message: "Only one." })]);
			const [first, second] = await Promise.allSettled([
				instance.submitTo("1", "First", {}, "user"),
				instance.submitTo("1", "Second", {}, "user"),
			]);
			expect(first.status).toBe("fulfilled");
			expect(second).toMatchObject({ status: "rejected", reason: { status: 429 } });
			await instance.harness.wait((first as PromiseFulfilledResult<{ operationId: string }>).value.operationId, { session: "1" });
			expect(instance.usage.today().runs).toBe(before + 1);
		});
	});

	it("gives a run back when its submission repeats one already accepted", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			const before = instance.usage.today().runs;
			faux.setResponses([toolUse("send_to_user", { message: "Once." })]);
			const first = await instance.submitTo("1", "Same", { operationId: "repeat-1" }, "user");
			const again = await instance.submitTo("1", "Same", { operationId: "repeat-1" }, "user");
			expect([first.accepted, again.accepted]).toEqual([true, false]);
			await instance.harness.wait(first.operationId, { session: "1" });
			expect(instance.usage.today().runs).toBe(before + 1);
		});
	});
});

describe("limits", () => {
	it("refuse a run past the daily limit", async () => {
		const { runs } = (await api<Usage>("/usage")).body.today;
		await setLimits({ dailyRuns: runs });
		const refused = await post(`/sessions/${ROOT}/messages`, { content: "One more" });
		expect(refused.status).toBe(429);
		expect(refused.body.error).toMatch(/quota exceeded: today's \d+ runs are used up/);
	});

	it("hold a run once the model allowance is used up, and pick it up again when the person says to", async () => {
		const { modelRequests } = (await api<Usage>("/usage")).body.today;
		await setLimits({ dailyModelRequests: modelRequests });
		const started = Date.now();
		// No scripted response: the model is never asked.
		const sent = await post(`/sessions/${ROOT}/messages`, { content: "Are you there?" });
		// The person reads why in the chat, and the run is still theirs to continue.
		const held = await vi.waitFor(async () => {
			const { body } = await api(`/sessions/${ROOT}/messages`);
			expect(JSON.stringify(body.messages.at(-1))).toMatch(/quota exceeded: today's \d+ model requests are used up/);
			return body;
		});
		expect(held.busy).toBe(true);
		// The chat list doesn't show it at work: it waits for the person.
		const listed = (await api<{ sessions: { id: string; busy: boolean; held: boolean }[] }>("/sessions")).body.sessions;
		expect(listed.find((session) => session.id === ROOT)).toMatchObject({ busy: false, held: true });
		// Retries back off for seconds; a quota error is final.
		expect(Date.now() - started).toBeLessThan(3_000);
		expect((await api<Usage>("/usage")).body.today.modelRequests).toBe(modelRequests);

		await setLimits(null);
		faux.setResponses([toolUse("send_to_user", { message: "Back again." })]);
		expect((await post(`/sessions/${ROOT}/retry`)).status).toBe(200);
		const answer = await api(`/sessions/${ROOT}/operations/${sent.body.operationId}?timeout=20000`);
		expect(answer.body).toMatchObject({ status: "done" });
		expect((await api(`/sessions/${ROOT}/messages`)).body.busy).toBe(false);
		// Nothing is held any more.
		expect((await post(`/sessions/${ROOT}/retry`)).status).toBe(409);
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
		});
		const put = (body: unknown) => api("/settings", { method: "PUT", body: JSON.stringify(body) });
		expect((await put({ timeZone: "Mars/Olympus" })).status).toBe(400);
		expect((await put({ notifyWebhook: "https://hooks.example" })).status).toBe(400);
		expect((await put({ theme: "dark" })).status).toBe(400);
		expect((await put({ timeZone: "Asia/Tokyo" })).body).toMatchObject({ timeZone: "Asia/Tokyo" });
		expect((await api("/")).body).toMatchObject({ timeZone: "Asia/Tokyo" });
		expect((await put({ timeZone: null })).body).toMatchObject({ timeZone: "America/New_York" });
	});
});

describe("the space's own checks", () => {
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

describe("model call ledger", () => {
	const HOUR = 3_600_000;
	const DAY = 24 * HOUR;
	const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cacheWrite1h?: number) => ({
		input,
		output,
		cacheRead,
		cacheWrite,
		...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	const modelOf = (id: string, provider = "faux") => ({ provider, id, api: "faux" }) as unknown as Model<Api>;
	const sqlOf = (instance: Pim) => (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
	beforeEach(() =>
		runInDurableObject(agent(), (instance: Pim) => {
			for (const table of ["pim_model_calls", "pim_usage_daily", "pim_usage_rollup"]) sqlOf(instance).exec(`DELETE FROM ${table}`);
			instance.usage.calls.rollup(Date.now());
			sqlOf(instance).exec("DELETE FROM pim_usage_rollup");
		}),
	);
	const rows = (instance: Pim, model: string) => sqlOf(instance).exec("SELECT * FROM pim_model_calls WHERE model = ? ORDER BY id", model).toArray();

	/** Sends one call through a meter on the instance's own database and settles it as `message` says. */
	async function call(instance: Pim, model: Model<Api>, message: Partial<AssistantMessage>, meter = instance.usage, context: unknown = { messages: [] }) {
		const { catalog, open } = heldCatalog();
		const request = meter.meter(catalog).stream(model, context as never, { sessionId: "s1" });
		open[0]!.push({ type: "done", reason: "stop", message: { ...answered(0, 0), ...message } });
		open[0]!.end({ ...answered(0, 0), ...message });
		await request.result();
		await vi.waitFor(() => expect(rows(instance, model.id).length).toBeGreaterThan(0));
	}

	it("prices each cache tier, with the 1h writes as part of pi-ai's cache writes", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			// 1000 input at 4, 500 output at 20, 2000 read at 0.2, 200 5m writes at 5 and 100 1h writes at 8, per million.
			await call(instance, modelOf("claude-opus-5-5"), { usage: usage(1000, 500, 2000, 300, 100) });
			const [row] = rows(instance, "claude-opus-5-5");
			expect(row).toMatchObject({ input: 1000, output: 500, cache_read: 2000, cache_write_5m: 200, cache_write_1h: 100, plan: 0 });
			expect(row!.cost_usd).toBeCloseTo(0.0162, 10);
			expect(row!.price_version).toBe("2026-11-10.1");
			// Without a 1h split every cache write is a 5m write.
			await call(instance, modelOf("gpt-6.1-sol"), { usage: usage(0, 0, 0, 1_000_000) });
			expect(rows(instance, "gpt-6.1-sol")[0]).toMatchObject({ cache_write_5m: 1_000_000, cache_write_1h: 0, cost_usd: 2.5 });
			// A model with a gateway prefix is the same model.
			await call(instance, modelOf("anthropic/claude-sonnet-5-5"), { usage: usage(1_000_000, 0) });
			expect(rows(instance, "anthropic/claude-sonnet-5-5")[0]!.cost_usd).toBe(2);
		});
	});

	it("leaves the cost of an unknown model and of a plan's calls null, and counts only the first as unpriced", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			await call(instance, modelOf("mystery-model"), { usage: usage(100, 100) });
			await call(instance, modelOf("gpt-6-luna", "openai"), { usage: usage(100, 100) });
			expect(rows(instance, "mystery-model")[0]).toMatchObject({ cost_usd: null, price_version: null, plan: 0 });
			expect(rows(instance, "gpt-6-luna")[0]).toMatchObject({ cost_usd: null, plan: 1 });
			instance.usage.calls.rollup(Date.now());
			// The unknown model counts as unpriced, and the plan's call, whose price is known, doesn't.
			expect(instance.usageCosts(1).unpricedCalls).toBe(1);
		});
	});

	it("records errored and aborted calls with the usage they reported", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			await call(instance, modelOf("claude-haiku-5-5"), { stopReason: "aborted", usage: usage(1000, 10) });
			await call(instance, modelOf("claude-fable-5-1"), { stopReason: "error", errorMessage: "boom", usage: usage(0, 0) });
			expect(rows(instance, "claude-haiku-5-5")[0]).toMatchObject({ stop_reason: "aborted", input: 1000, output: 10 });
			expect(rows(instance, "claude-fable-5-1")[0]).toMatchObject({ stop_reason: "error", input: 0 });
			// A stream that rejects is recorded too, without usage.
			const rejecting = { stream: () => ({ result: () => Promise.reject(new Error("closed")) }) } as unknown as Models;
			instance.usage.meter(rejecting).stream(modelOf("grok-4.6"), { messages: [] });
			await vi.waitFor(() => expect(rows(instance, "grok-4.6")).toHaveLength(1));
			expect(rows(instance, "grok-4.6")[0]).toMatchObject({ stop_reason: "error", input: 0, cost_usd: 0 });
		});
	});

	it("records what the tagger says, and the size of what was sent; unknown tags are null", async () => {
		await runInDurableObject(agent(), async (instance: Pim, state) => {
			const meter = new UsageMeter({
				sql: state.storage.sql,
				limits: () => UNLIMITED,
				ownProvider: () => false,
				tags: ({ sessionId }) => ({ agentId: "a1", chatId: `chat-${sessionId}`, runKind: "scheduled", scheduleOrTriggerId: "t1" }),
			});
			const context = { systemPrompt: "Be brief", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [] }, { role: "user", content: "again" }], tools: [{ name: "a" }, { name: "b" }] };
			await call(instance, modelOf("gemini-3.5-flash"), { usage: usage(10, 5) }, meter, context);
			expect(rows(instance, "gemini-3.5-flash")[0]).toMatchObject({
				agent_id: "a1",
				chat_id: "chat-s1",
				run_kind: "scheduled",
				schedule_or_trigger_id: "t1",
				coding_thread_id: null,
				turn_index: 1,
				tool_count: 2,
				tool_schema_bytes: JSON.stringify(context.tools).length,
				prompt_bytes: JSON.stringify("Be brief").length + JSON.stringify(context.messages).length,
			});
			const throwing = new UsageMeter({ sql: state.storage.sql, limits: () => UNLIMITED, ownProvider: () => false, tags: () => { throw new Error("no tags"); } });
			await call(instance, modelOf("gpt-5.5"), { usage: usage(10, 5) }, throwing);
			expect(rows(instance, "gpt-5.5")[0]).toMatchObject({ agent_id: null, run_kind: null, chat_id: null });
		});
	});

	it("tags a chat's calls with its agent, chat and run kind, and naming it as background work", async () => {
		const session = (await post("/sessions")).body.id;
		faux.setResponses([toolUse("send_to_user", { message: "Hello!" })]);
		await say("Hi", session);
		await runInDurableObject(agent(), async (instance: Pim) => {
			const chat = () => sqlOf(instance).exec("SELECT run_kind, agent_id, chat_id FROM pim_model_calls WHERE chat_id = ?", session).toArray();
			await vi.waitFor(() => expect(chat()).toHaveLength(1));
			expect(chat()[0]).toMatchObject({ run_kind: "interactive", agent_id: expect.any(String) });
			// Naming the chat has no conversation of its own to tag.
			const named = sqlOf(instance).exec("SELECT agent_id, chat_id FROM pim_model_calls WHERE run_kind = 'background'").toArray();
			expect(named.length).toBeGreaterThan(0);
			expect(named[0]).toMatchObject({ agent_id: null, chat_id: null });
		});
	});

	it("rolls up idempotently, replacing a day's rows rather than adding to them", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			const ledger = instance.usage.calls;
			const sql = sqlOf(instance);
			const at = Date.UTC(2026, 5, 1, 10);
			for (const [minute, output] of [[0, 100], [30, 50]] as const) {
				ledger.record({ ts: at + minute * 60_000, tags: { agentId: "a", chatId: "c", runKind: "interactive" }, provider: "faux", model: "claude-opus-5-5", usage: usage(1000, output, 500, 0), stopReason: "stop", latencyMs: 5, shape: undefined, plan: false });
			}
			ledger.record({ ts: at, tags: {}, provider: "faux", model: "claude-opus-5-5", usage: undefined, stopReason: "error", latencyMs: 5, shape: undefined, plan: false });
			const daily = () => sql.exec("SELECT * FROM pim_usage_daily WHERE day = '2026-06-01' ORDER BY agent_id").toArray();
			ledger.rollup(at + HOUR);
			const first = daily();
			ledger.rollup(at + HOUR);
			ledger.rollup(at + HOUR);
			expect(daily()).toEqual(first);
			expect(first).toHaveLength(2);
			expect(first.find((row) => row.agent_id === "a")).toMatchObject({ calls: 2, errors: 0, input: 2000, output: 150, cache_read: 1000, unpriced_calls: 0 });
			expect(first.find((row) => row.agent_id === null)).toMatchObject({ calls: 1, errors: 1 });
			// A late call for the same day is added by recomputing, not by adding twice.
			ledger.record({ ts: at + 2 * HOUR, tags: { agentId: "a", chatId: "c", runKind: "interactive" }, provider: "faux", model: "claude-opus-5-5", usage: usage(1, 1), stopReason: "stop", latencyMs: 5, shape: undefined, plan: false });
			ledger.rollup(at + 3 * HOUR);
			expect(daily().find((row) => row.agent_id === "a")).toMatchObject({ calls: 3, input: 2001 });
		});
	});

	it("serves costs from the rollup and the calls since, with the cache hit ratio and cost per 1k output tokens", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			const ledger = instance.usage.calls;
			const now = Date.UTC(2026, 5, 10, 12);
			const base = { tags: { agentId: "a", chatId: "c1", runKind: "interactive" as const }, provider: "faux", model: "claude-opus-5-5", stopReason: "stop", latencyMs: 1, plan: false };
			ledger.record({ ...base, ts: now - 2 * DAY, usage: usage(1_000_000, 1000, 1_000_000, 0), shape: { promptBytes: 100, toolCount: 0, toolSchemaBytes: 0, turnIndex: 3 } });
			ledger.rollup(now - 2 * DAY + HOUR);
			// After the rollup: summed from the calls, today's partial hour included.
			ledger.record({ ...base, ts: now - HOUR, usage: usage(1_000_000, 1000, 0, 0), shape: { promptBytes: 300, toolCount: 0, toolSchemaBytes: 0, turnIndex: 5 } });
			const report = ledger.costs(7, now);
			expect(report.byDay.map((day) => day.day)).toEqual(["2026-06-08", "2026-06-10"]);
			expect(report.totalCostUsd).toBeCloseTo(4.02 + 0.2 + 4.02, 6);
			expect(report.byDay[0]).toMatchObject({ cacheHitRatio: 0.5, byAgent: [{ key: "a" }], byRunKind: [{ key: "interactive" }], byModel: [{ key: "claude-opus-5-5" }] });
			expect(report.byDay[1]!.cacheHitRatio).toBe(0);
			expect(report.costPer1kOutputTokens).toBeCloseTo(report.totalCostUsd / 2, 6);
			expect(report.topChats).toEqual([{ id: "c1", costUsd: report.totalCostUsd, calls: 2, turns: 5, avgPromptBytes: 200 }]);
			expect(ledger.costs(1, now).byDay.map((day) => day.day)).toEqual(["2026-06-10"]);
		});
		expect((await api("/usage/costs?days=7")).body).toMatchObject({ days: 7, byDay: expect.any(Array), topChats: expect.any(Array), unpricedCalls: expect.any(Number) });
	});

	it("never fails or delays a call when recording fails", async () => {
		await runInDurableObject(agent(), async (instance: Pim, state) => {
			const meter = new UsageMeter({ sql: state.storage.sql, limits: () => UNLIMITED, ownProvider: () => false });
			state.storage.sql.exec("ALTER TABLE pim_model_calls RENAME TO pim_model_calls_away");
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const { catalog, open } = heldCatalog();
				const request = meter.meter(catalog).stream(modelOf("claude-opus-5-5"), { messages: [] });
				open[0]!.push({ type: "done", reason: "stop", message: answered(7, 3) });
				open[0]!.end(answered(7, 3));
				expect((await request.result()).stopReason).toBe("stop");
				await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("pim.model_call_record_failed")));
			} finally {
				warn.mockRestore();
				state.storage.sql.exec("ALTER TABLE pim_model_calls_away RENAME TO pim_model_calls");
			}
			// The call's tokens were still counted where limits read them.
			expect(instance.usage.today().tokens).toBeGreaterThanOrEqual(10);
		});
	});

	it("keeps calls 90 days and rollups 400", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			const ledger = instance.usage.calls;
			const sql = sqlOf(instance);
			const now = Date.UTC(2026, 10, 10, 12);
			const old = (days: number) => ledger.record({ ts: now - days * DAY, tags: {}, provider: "faux", model: "claude-opus-5-5", usage: usage(1, 1), stopReason: "stop", latencyMs: 1, shape: undefined, plan: false });
			old(91);
			old(89);
			ledger.rollup(now - 85 * DAY);
			old(0);
			sql.exec("INSERT INTO pim_usage_daily (day, model, calls, errors, input, output, cache_read, cache_write_5m, cache_write_1h, unpriced_calls) VALUES (?, 'm', 1, 0, 0, 0, 0, 0, 0, 0), (?, 'm', 1, 0, 0, 0, 0, 0, 0, 0)", new Date(now - 401 * DAY).toISOString().slice(0, 10), new Date(now - 399 * DAY).toISOString().slice(0, 10));
			ledger.rollup(now);
			expect(sql.exec("SELECT COUNT(*) AS n FROM pim_model_calls WHERE ts < ?", now - 90 * DAY).one().n).toBe(0);
			expect(sql.exec("SELECT COUNT(*) AS n FROM pim_model_calls WHERE model = 'claude-opus-5-5' AND ts >= ?", now - 90 * DAY).one().n).toBeGreaterThanOrEqual(2);
			const days = sql.exec("SELECT day FROM pim_usage_daily WHERE model = 'm'").toArray();
			expect(days).toEqual([{ day: new Date(now - 399 * DAY).toISOString().slice(0, 10) }]);
			// The 91-day-old call's day was rolled up before it was pruned and stays in the rollup.
			expect(sql.exec("SELECT COUNT(*) AS n FROM pim_usage_daily WHERE model = 'claude-opus-5-5'").one().n).toBeGreaterThanOrEqual(2);
		});
	});
});
