import type { Message } from "@earendil-works/pi-ai";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { EVENT_KEEP, scrub } from "../src/diagnostics";
import type { Pim } from "../src/pim";
import { apiUrl, OWNER, post, ROOT, say, systemPrompt, toolUse } from "./helpers";
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
		expect(Object.keys(report.sections).sort()).toEqual(["approvals", "coding", "connectors", "events", "model_calls", "provider_cooldowns", "runs", "triggers"]);
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
