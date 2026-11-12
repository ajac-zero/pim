import type { Message } from "@earendil-works/pi-ai";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EVENT_KEEP, scrub } from "../src/diagnostics";
import type { Pim } from "../src/pim";
import type { Approval } from "../src/store";
import { api, apiUrl, OWNER, post, ROOT, say, settled, systemPrompt, toolUse } from "./helpers";
import { faux } from "./worker";

const TOOLS = ["pim_diagnostics", "pim_health"];
const SECRET = "sk-Zx81QwErTy93LkMnBv52PoIuYt40AsDf";
const PUBLIC_HOST = "internal-host.example.net";

let offered: string[] = [];
let prompt = "";
let told = "";
/** The model's last step: it reads the tools it was offered, its prompt and the last tool result, then answers. */
const record = (context: { messages: Message[] }) => {
	const tools = new Set<string>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
	}
	offered = [...tools];
	prompt = systemPrompt(context.messages);
	const result = context.messages.findLast((message) => message.role === "toolResult");
	told = result?.role === "toolResult" && result.content[0]?.type === "text" ? result.content[0].text : "";
	return toolUse("send_to_user", { message: "ok" });
};
/** Has the admin's majordomo call a tool, and returns what it was told. */
async function ask(tool: string, args: Record<string, string | number> = {}) {
	faux.setResponses([toolUse(tool, args), record]);
	await say("Look into it");
	return JSON.parse(told);
}
const inPim = <T>(work: (pim: Pim) => T | Promise<T>) => runInDurableObject(env.Pim.getByName(OWNER), (pim: Pim) => work(pim));

let helperChat = "";

beforeAll(async () => {
	const helper = (await post("/agents", { name: "Helper", instructions: "Helps." })).body.id;
	helperChat = (await post("/sessions", { agent: helper })).body.id;
});

describe("the majordomo's diagnostics tools", () => {
	it("are offered, with their prompt section, only to the admin's majordomo", async () => {
		faux.setResponses([record]);
		await say("Hi");
		expect(offered).toEqual(expect.arrayContaining(TOOLS));
		expect(prompt).toContain("You can debug this Pim");

		faux.setResponses([record]);
		await say("Hi", helperChat);
		expect(offered.filter((name) => TOOLS.includes(name))).toEqual([]);
		expect(prompt).not.toContain("You can debug this Pim");

		// A member's majordomo is no admin's.
		const directory = env.Directory.getByName("directory");
		const registered = await directory.register({ username: "member", ip: "192.0.2.9", policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
		if (!registered.ok) throw new Error(registered.error);
		const memberId = registered.account.ownerId;
		await directory.activate(memberId);
		await (await getAgentByName(env.Pim, memberId)).provision({ ownerId: memberId, username: "member" });
		const token = (await env.Auth.getByName(memberId).createToken(memberId, "tests", Date.now())).token;
		const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
		const root = (await (await exports.default.fetch(new Request(apiUrl("/"), { headers }))).json()) as { rootSession: string };
		faux.setResponses([record]);
		const said = await exports.default.fetch(new Request(apiUrl(`/sessions/${root.rootSession}/messages`), { method: "POST", headers, body: JSON.stringify({ content: "Hi", wait: true }) }));
		expect(said.status).toBe(200);
		expect(offered.filter((name) => TOOLS.includes(name))).toEqual([]);
		expect(prompt).not.toContain("You can debug this Pim");
	});

	it("refuse any other agent that reaches them", async () => {
		const results = await inPim(async (pim) => {
			const session = pim.store.sessionOf(helperChat)!;
			const tools = pim.abilities.get("meta-diagnostics")!.tools!;
			const run = (name: string) => tools.find((tool) => tool.name === name)!.execute({} as never, { conversationId: session } as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;
			return [await run("pim_diagnostics"), await run("pim_health")];
		});
		for (const result of results) {
			expect(result.isError).toBe(true);
			expect(result.content[0]!.text).toBe("Only the admin's majordomo can read this Pim's diagnostics.");
		}
	});

	it("report what went wrong, by kind, with secrets and addresses taken out", async () => {
		await inPim((pim) => {
			const now = Date.now();
			pim.usage.calls.record({ ts: now, tags: { runKind: "interactive" }, provider: "test", model: "m", usage: undefined, stopReason: "error", latencyMs: 90_000, shape: undefined, plan: false });
			pim.providerCooldowns.failed("openai", { message: `You've hit your usage limit (key ${SECRET}). Try again in 42 min.` }, now);
			pim.diagnosticEvents.record("slow_request", { method: "GET", path: "/api/sessions", ms: 7000, error: `Bearer ${SECRET} from https://${PUBLIC_HOST}/x?key=${SECRET}`, api_key: SECRET });
			pim.store.requestApproval({ id: "ap-1", session: pim.store.sessionOf(ROOT)!, action: "send_email", tool: null, args: {}, summary: `Send to someone@example.org with token=${SECRET}`, callId: null, createdAt: now, expiresAt: null, onTimeout: "deny" });
		});
		await inPim(async (pim) => {
			await pim.enableTriggerEngine();
			const now = Date.now();
			const sql = (pim as unknown as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql;
			sql.exec("INSERT INTO pim_triggers (id, revision, lifecycle, health, health_detail, generation, created_at, updated_at) VALUES ('trg-1', 1, 'enabled', 'auth_required', ?, 1, ?, ?)", `sign in again at https://${PUBLIC_HOST}/login`, now, now);
			sql.exec(
				`INSERT INTO pim_trigger_runs (operation_id, trigger_id, outbox_id, occurrence_id, revision, agent_id, chat_state, phase, scheduled_for, admitted_at, deliver_by, deferrals, unknown_answers, last_error, created_at, updated_at)
				VALUES ('op-1', 'trg-1', 'ob-1', 'oc-1', 1, 'agent-1', 'pinned', 'failed', ?, ?, ?, 0, 0, ?, ?, ?)`,
				now,
				now,
				now,
				`the model said no, key ${SECRET}`,
				now,
				now,
			);
		});
		const report = await ask("pim_diagnostics", { since: "1h" });
		expect(Object.keys(report.sections).sort()).toEqual(["approvals", "coding", "connectors", "events", "model_calls", "now", "provider_cooldowns", "runs", "stalls", "triggers", "turns"]);
		expect(report).toMatchObject({ limit: 20, generated_at: expect.any(String), since: expect.any(String) });
		expect(report.sections.model_calls.items[0]).toMatchObject({ why: "stopped with error", provider: "test", model: "m", run_kind: "interactive", latency_ms: 90_000 });
		expect(report.sections.events.items[0]).toMatchObject({ kind: "slow_request", detail: { method: "GET", path: "/api/sessions", ms: 7000, api_key: "[redacted]" } });
		expect(report.sections.triggers.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: "trigger_health", trigger: "trg-1", health: "auth_required", error: "sign in again at [address]/login" }),
				expect.objectContaining({ source: "trigger_run", run: "op-1", phase: "failed", error: "the model said no, key [redacted]" }),
			]),
		);
		expect(report.sections.approvals).toMatchObject({ count: 1, items: [{ id: "ap-1", action: "send_email" }] });
		const [cooldown] = report.sections.provider_cooldowns.items;
		expect(cooldown).toEqual({ provider: "openai", active: true, since: expect.any(String), until: expect.any(String), reason: "You've hit your usage limit (key [redacted]). Try again in 42 min.", failures: 1, reset_from: "provider" });
		expect(Date.parse(cooldown.until) - Date.parse(cooldown.since)).toBe(42 * 60_000);
		const everything = JSON.stringify(report);
		expect(everything).not.toContain(SECRET);
		expect(everything).not.toContain(PUBLIC_HOST);
		expect(everything).not.toContain("someone@example.org");

		const one = await ask("pim_diagnostics", { kind: "events", limit: 1, since: "1h" });
		expect(Object.keys(one.sections)).toEqual(["events"]);
		expect(one.sections.events.items).toHaveLength(1);
	});

	it("say what is wrong with a query instead of guessing", async () => {
		expect((await ask("pim_diagnostics", { since: "yesterday-ish" })).error).toContain("since must be");
	});

	it("tell how the Pim is doing, without its addresses or keys", async () => {
		const health = await ask("pim_health");
		expect(health).toMatchObject({
			generated_at: expect.any(String),
			version: { id: expect.anything() },
			durable_object: { status: "open" },
			counts: { agents: expect.any(Number), chats: expect.any(Number), schedules: expect.any(Number), pending_approvals: 1, connectors: { total: expect.any(Number) } },
			deployment: { registration: expect.any(String), configured: { public_url: true } },
		});
		expect(health.counts.agents).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(health)).not.toContain("pim.test");
	});

	it("tell how long a turn took, and how much of it was the model, the tools and waiting for an approval", async () => {
		const policy = (approvalPolicy: string | null) => api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy }) });
		await policy("explicit");
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			return request.url.startsWith("https://hooks.example.test/") ? new Response("ordered", { status: 201 }) : realFetch(input, init);
		});
		try {
			const chat = (await post("/sessions")).body.id;
			// A provider stamps its answer with when the request began, as the real ones do, not when it ended.
			const answer = async (ms: number, message: ReturnType<typeof toolUse>) => {
				const began = Date.now();
				await new Promise((done) => setTimeout(done, ms));
				return { ...message, timestamp: began };
			};
			faux.setResponses([
				() => answer(400, toolUse("http_request", { method: "POST", url: "https://hooks.example.test/order" })),
				() => answer(0, toolUse("send_to_user", { message: "Ordered." })),
			]);
			expect((await post(`/sessions/${chat}/messages`, { content: "Order it." })).status).toBe(202);
			const approval = await vi.waitFor(async () => {
				const found = (await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals.find((candidate) => candidate.action === "http_request");
				expect(found).toBeDefined();
				return found!;
			});
			await new Promise((done) => setTimeout(done, 700));
			expect((await post(`/approvals/${approval.id}/approve`)).status).toBe(200);
			await settled(chat);

			const [turn] = (await ask("pim_diagnostics", { kind: "turns", chat })).sections.turns.items;
			// The wait for the person is the approval's, not the tool's, and the model's 400 ms are its own.
			expect(turn).toMatchObject({ chat, in_progress: false, model_calls: 2, tool_calls: 2, approvals_ms: expect.any(Number) });
			expect(turn.approvals_ms).toBeGreaterThanOrEqual(700);
			expect(turn.tools_ms).toBeLessThan(700);
			expect(turn.model_ms).toBeGreaterThanOrEqual(400);
			expect(turn.total_ms).toBeGreaterThanOrEqual(1_100);
			expect(turn.steps.map((step: { step: string; name?: string }) => step.name ?? step.step)).toEqual(["model", "http_request", "model", "send_to_user"]);
			expect(turn.steps[0].ms).toBeGreaterThanOrEqual(400);
			expect(turn.steps[1]).toMatchObject({ approval: { id: approval.id, status: "approved", decided_by: "user" } });
			expect(turn.steps[1].approval.waited_ms).toBeGreaterThanOrEqual(700);

			// Without a chat, the turns of the chats at work in the window, without their steps.
			const { items } = (await ask("pim_diagnostics", { kind: "turns", limit: 100 })).sections.turns;
			const listed = items.find((item: { chat: string }) => item.chat === chat);
			expect(listed).toMatchObject({ approvals_ms: turn.approvals_ms, model_calls: 2 });
			expect(listed.steps).toBeUndefined();
		} finally {
			await policy(null);
		}
	});

	it("tell which chats are at work now, what each waits on, and since when", async () => {
		const policy = (approvalPolicy: string | null) => api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy }) });
		await policy("explicit");
		try {
			const waiting = (await post("/sessions")).body.id;
			faux.setResponses([toolUse("http_request", { method: "POST", url: "https://hooks.example.test/order" })]);
			expect((await post(`/sessions/${waiting}/messages`, { content: "Order it." })).status).toBe(202);
			const approval = await vi.waitFor(async () => {
				const found = (await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals.find((candidate) => candidate.action === "http_request");
				expect(found).toBeDefined();
				return found!;
			});
			await inPim((pim) => pim.watchRuns());

			const { items } = (await ask("pim_diagnostics", { kind: "runs" })).sections.runs;
			expect(items.find((item: { chat: string }) => item.chat === waiting)).toMatchObject({
				state: "working",
				waiting_on: `the person's decision on approval ${approval.id}: POST [address]/order`,
				working_since: expect.any(String),
				working_minutes: 0,
				unchanged_since: expect.any(String),
			});
			// The chat that asked is at work on the call, which the watchdog hasn't seen yet; ap-1, filed outside any call, holds none of its.
			expect(items.find((item: { chat: string }) => item.chat === ROOT)).toMatchObject({ state: "working", waiting_on: "its tool calls: pim_diagnostics", working_since: null, unchanged_since: null });

			expect((await post(`/sessions/${waiting}/abort`)).status).toBe(200);
			await settled(waiting);
		} finally {
			await policy(null);
		}
	});
});

describe("the diagnostics log", () => {
	it("keeps only the last events, newest first", async () => {
		const kept = await inPim((pim) => {
			for (let n = 0; n < EVENT_KEEP + 37; n++) pim.diagnosticEvents.record("bulk", { n });
			return { count: pim.diagnosticEvents.count(), newest: pim.diagnosticEvents.since(0, 1), oldest: pim.diagnosticEvents.since(0, 1000).at(-1) };
		});
		expect(kept.count).toBe(EVENT_KEEP);
		expect(kept.newest[0]!.detail).toEqual({ n: EVENT_KEEP + 36 });
		expect(kept.oldest!.detail).toEqual({ n: 37 });
	});

	it("is written by the code paths that only logged before: a slow request", async () => {
		faux.setResponses([async () => (await new Promise((done) => setTimeout(done, 5200)), toolUse("send_to_user", { message: "late" }))]);
		await say("Take your time");
		const events = await inPim((pim) => pim.diagnosticEvents.since(Date.now() - 60_000, 10));
		expect(events.find((event) => event.kind === "slow_request")).toMatchObject({ detail: { method: "POST", status: 200, ms: expect.any(Number) } });
	}, 20_000);
});

describe("scrub", () => {
	it("takes out secrets, addresses, emails and long text", () => {
		const text = scrub(`Bearer ${SECRET} fetch https://user:pw@${PUBLIC_HOST}:8443/a/b?token=${SECRET} failed for me@example.org, password=hunter2`);
		expect(text).toBe("Bearer [redacted] fetch [address]/a/b failed for [email], password=[redacted]");
		expect(scrub("x".repeat(500))).toHaveLength(301);
	});
});

describe("tool input summaries", () => {
	it("keeps operational arguments, redacts before truncating, and never includes bodies", async () => {
		const { toolSummary, turnsOf } = await import("../src/diagnostics");
		const summary = toolSummary({ command: `curl -H 'Authorization: Bearer synthetic-value' https://example.invalid/x?key=synthetic-value; TOKEN='synthetic value' echo ok`, body: "private body", thread_id: "thread-1" });
		expect(summary).not.toContain("synthetic");
		for (const command of [
			"curl -H 'Authorization: Bearer synthetic-value'",
			"Authorization='Basic synthetic value' curl /x",
			'curl -d \'{"api_key":"synthetic value"}\' https://example.invalid/x?anything=synthetic-value',
			"run --access-token 'synthetic value'",
		]) expect(toolSummary({ command })).not.toContain("synthetic");
		expect(summary).not.toContain("private body");
		expect(summary).toContain("/x");
		expect(toolSummary({ command: "x".repeat(300) }).length).toBeLessThanOrEqual(201);
		const messages = [
			{ role: "user", content: "go", timestamp: 0 },
			{ role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "echo ok", timeout: 3 } }], timestamp: 10 },
			{ role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "ok" }], details: { exitCode: 0 }, timestamp: 20 },
		] as Message[];
		expect(turnsOf(messages, new Map(), 30, false)[0]?.steps[1]).toMatchObject({ summary: "command=echo ok timeout=3", exitCode: 0, outputBytes: 29, timeoutMs: 3000 });
	});
});

describe("the shared activity view", () => {
	it("shows parallel pending tools, completed durations and durable last output", async () => {
		const { activityOf, ActivityWatch } = await import("../src/activity");
		const { turnsOf } = await import("../src/diagnostics");
		const messages = [
			{ role: "user", content: "go", timestamp: 100 },
			{ role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "echo ok", timeout: 900 } }, { type: "toolCall", id: "b", name: "read", arguments: { path: "README.md" } }], timestamp: 200 },
			{ role: "toolResult", toolCallId: "b", content: [], timestamp: 300 },
		] as Message[];
		const activity = activityOf(turnsOf(messages, new Map(), 1000, true), 1000, { running: true, startedAt: 100, lastOutputAt: 800 });
		expect(activity.current).toEqual([{ id: "a", name: "bash", summary: "command=echo ok timeout=900", startedAt: 200, elapsedMs: 800, timeoutMs: 900000 }]);
		expect(activity.lastActivityAt).toBe(800);
		expect(activity.steps[2]?.ms).toBe(100);
		expect(activityOf([], 1000, { running: false, startedAt: 100 }).current).toEqual([]);
		await inPim((pim) => {
			const watch = new ActivityWatch((pim as unknown as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql);
			watch.output("test", 800);
			expect(new ActivityWatch((pim as unknown as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql).lastOutput("test")).toBe(800);
		});
	});

	it("exposes the same data on the chat's authorized API", async () => {
		const response = await api(`/sessions/${ROOT}/activity`);
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ current: expect.any(Array), steps: expect.any(Array), lastActivityAt: expect.any(Number) });
	});
});

describe("stall detection", () => {
	it("checks declared timeouts, quiet tools and quiet coding transcripts without flagging approvals", async () => {
		const { activityOf } = await import("../src/activity");
		const { turnsOf } = await import("../src/diagnostics");
		const messages = [
			{ role: "user", content: "go", timestamp: 0 },
			{ role: "assistant", content: [{ type: "toolCall", id: "a", name: "test", arguments: { command: "vitest run", timeout: 900 } }], timestamp: 100 },
		] as Message[];
		const activity = (now: number, lastOutputAt = 100, approval = false) => activityOf(turnsOf(messages, approval ? new Map([["a", { id: "ap", status: "pending", createdAt: 100, decidedAt: null, decidedBy: null }]]) : new Map(), now, true), now, { running: true, startedAt: 0, lastOutputAt, coding: !approval });
		expect(activity(300100).stalls).toEqual([]);
		expect(activity(300101).stalls[0]?.reason).toBe("no output for five minutes");
		expect(activity(900101, 900000).stalls[0]?.reason).toBe("past declared timeout");
		expect(activity(900101).stalls).toHaveLength(2);
		expect(activity(900101, 900000, true).stalls).toEqual([]);
	});
});

describe("shared coding diagnostics", () => {
	it("uses exactly the API activity record in now, coding and stalls, regardless of the since window", async () => {
		const { diagnose } = await import("../src/diagnostics");
		const activity = { running: true, lastActivityAt: 100, current: [{ name: "test", summary: "command=vitest run", startedAt: 100, elapsedMs: 1000000, timeoutMs: 900000 }], steps: [], stalls: [{ key: "tool:1", reason: "past declared timeout", since: 100 }] };
		const sources = {
			now: 1000000,
			turns: async () => [],
			codingThreads: async () => [{ threadId: "coding-test", harness: "pi", state: "running", stateReason: null, task: "Run the test", updatedAt: 100, spentUsd: 0, budgetUsd: null, activity }],
		} as unknown as import("../src/diagnostics").DiagnosticSources;
		const report = await diagnose(sources, { kind: "now", since: "1m" });
		expect(report.sections.now?.items).toEqual([{ source: "coding", thread: "coding-test", ...activity }]);
		expect((await diagnose(sources, { kind: "stalls" })).sections.stalls?.items).toEqual(report.sections.now?.items);
		expect((await diagnose(sources, { kind: "coding" })).sections.coding?.items[0]).toMatchObject({ activity });
	});
});

describe("parallel command silence", () => {
	it("does not let output from another tool hide a silent command", async () => {
		const { activityOf } = await import("../src/activity");
		const { turnsOf } = await import("../src/diagnostics");
		const messages = [
			{ role: "user", content: "go", timestamp: 100 },
			{ role: "assistant", content: [{ type: "toolCall", id: "quiet", name: "bash", arguments: { command: "quiet" } }, { type: "toolCall", id: "loud", name: "bash", arguments: { command: "loud" } }], timestamp: 200 },
		] as Message[];
		const activity = activityOf(turnsOf(messages, new Map(), 400000, true), 400000, { running: true, startedAt: 100, lastOutputAt: 399000, outputByCall: { loud: 399000 } });
		expect(activity.stalls).toEqual([{ key: "tool:quiet", reason: "no output for five minutes", since: 200 }]);
	});
});


describe("harness timeout units", () => {
	it("normalizes Pi seconds and Claude Bash milliseconds without guessing missing timeouts", async () => {
		const { toolTimeout } = await import("../src/diagnostics");
		expect(toolTimeout("bash", { timeout: 900 })).toBe(900000);
		expect(toolTimeout("Bash", { timeout: 900000 })).toBe(900000);
		expect(toolTimeout("shell", { timeout_ms: 900000 })).toBe(900000);
		expect(toolTimeout("bash", {})).toBeNull();
		expect(toolTimeout("bash", { timeout: -1 })).toBeNull();
	});
});
