import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptCommand, createChat, decideApproval, fileApproval } from "../src/commands.ts";
import { withTenant } from "../src/db.ts";
import { IdAllocator } from "../src/ids.ts";
import { provisionTenant } from "../src/partitions.ts";
import { PartitionHost, Runner, type HostDeps } from "../src/runner.ts";
import { createTestDb, type TestDb } from "./support/db.ts";
import { scriptedModel, until } from "./support/harness.ts";
import { newTenant } from "./support/storage.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Lease } from "../src/partitions.ts";

let db: TestDb;
beforeAll(async () => {
	db = await createTestDb(30);
});
afterAll(async () => db.close());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lastUser = (messages: any[]): string => {
	const user = [...messages].reverse().find((m) => m.role === "user");
	return typeof user?.content === "string" ? user.content : (user?.content?.[0]?.text ?? "");
};

/** What a deployment's Runner is configured with. `effects` records every dispatched external effect. */
function runtime(options: { latencyMs?: number; effects?: string[]; tools?: "charge" | "approve" } = {}) {
	const m = scriptedModel();
	m.faux.setResponses(
		Array.from({ length: 2000 }, () => async (context: any) => {
			if (options.latencyMs) await sleep(options.latencyMs);
			const tool = context.messages.some((message: any) => message.role === "toolResult");
			if (options.tools && !tool) return fauxAssistantMessage(fauxToolCall(options.tools, { id: lastUser(context.messages) }), { stopReason: "toolUse" });
			return fauxAssistantMessage(`echo:${lastUser(context.messages)}`);
		}),
	);
	const ids = new IdAllocator(db.runtime, 100);
	const effects = options.effects ?? [];
	const deps = (overrides: Partial<HostDeps> = {}): Omit<HostDeps, "onLost" | "onReleased"> => ({
		pool: db.runtime,
		ids,
		leaseTtlMs: 2000,
		pollMs: 30,
		harnessOptions: (lease: Lease) => {
			const registry = createRegistry();
			registry.install(
				defineExtension({
					name: "fx",
					tools: [
						defineTool({
							name: "charge",
							description: "An unsafe external effect",
							parameters: Type.Object({ id: Type.String() }),
							replay: "unsafe",
							execute: async (args, api) => {
								effects.push(`${lease.partitionId}:${api.callId}`);
								await sleep(100);
								return { content: [{ type: "text", text: `charged ${args.id}` }] };
							},
						}),
						defineTool({
							name: "approve",
							description: "Needs a person's approval",
							parameters: Type.Object({ id: Type.String() }),
							replay: "safe",
							execute: async (args, api) => {
								const filed = await fileApproval(db.runtime, { tenantId: lease.tenantId, partitionId: lease.partitionId, conversationId: api.conversationId, taskId: api.taskId, callId: api.callId });
								if (filed.status === "pending") {
									await sleep(150);
									return { control: { suspend: true } };
								}
								if (filed.status === "denied") return { isError: true, content: [{ type: "text", text: "denied" }] };
								effects.push(`${lease.partitionId}:${api.callId}`);
								return { content: [{ type: "text", text: `approved ${args.id}` }] };
							},
						}),
					],
				}),
			);
			return { models: m.models, registry, settings: { retry: { maxRetries: 0 } } as never };
		},
		...overrides,
	});
	return { m, deps, effects, ids };
}

const chatOf = async (tenantId: string, chatId: string) => withTenant(db.gate, tenantId, (q) => q.get<{ conversation_id: number | null; partition_id: string }>("SELECT conversation_id, partition_id FROM app.chats WHERE chat_id = $1", chatId), { readOnly: true });
const entriesOf = async (tenantId: string, partitionId: string) => withTenant(db.gate, tenantId, (q) => q.all<{ record: string }>("SELECT record FROM rt.entries WHERE partition_id = $1 ORDER BY id", partitionId), { readOnly: true });
const answers = async (tenantId: string, partitionId: string) => (await entriesOf(tenantId, partitionId)).map((r) => JSON.parse(r.record)).filter((e) => e.kind === "pi.assistant");
const quiescent = async (partitionId: string) => (await db.admin.query("SELECT a.state, p.lease_until < now() AS free FROM app.activation a JOIN rt.partitions p USING (partition_id) WHERE a.partition_id = $1", [partitionId])).rows[0];

async function newTenantWithChat(rt: ReturnType<typeof runtime>, message = "hello") {
	const tenantId = newTenant();
	await provisionTenant(db.maint, tenantId);
	const chat = await createChat(db.gate, { tenantId, commandId: `c-${tenantId}`, actor: "u1", agent: rt.m.agent, firstMessage: message });
	return { tenantId, ...chat };
}

describe("Gate -> inbox -> owner -> quiescence", () => {
	it("accepts a command without any owner, then an owner answers once and the family goes quiescent and unowned", async () => {
		const rt = runtime();
		const { tenantId, chatId, partitionId } = await newTenantWithChat(rt, "ping");
		// Accepted and durable with no Runner at all.
		expect((await chatOf(tenantId, chatId))?.conversation_id).toBeNull();
		const runner = new Runner({ ownerId: "r1", steward: db.steward, deps: rt.deps() });
		await runner.claimOnce();
		const answered = await until(async () => (await answers(tenantId, partitionId)).length === 1 && (await answers(tenantId, partitionId)), "the answer");
		expect(JSON.stringify(answered[0])).toContain("echo:ping");
		const settled = await until(async () => (await quiescent(partitionId)).state === "quiescent" && runner.hosts.size === 0, "quiescence");
		expect(settled).toBe(true);
		// Quiescent families are not claimed again.
		expect(await runner.claimOnce()).toBe(0);
		// A new command wakes it with no hint at all (notification loss): the activation row is the authority.
		const conv = (await chatOf(tenantId, chatId))!.conversation_id!;
		await acceptCommand(db.gate, { tenantId, commandId: "send-2", actor: "u1", kind: "chat.send", partitionId, payload: { conversationId: conv, content: "again" }, signal: { kind: "input" } });
		expect(await runner.claimOnce()).toBe(1);
		await until(async () => (await answers(tenantId, partitionId)).length === 2, "second answer");
		await runner.drain();
	});

	it("is idempotent on the command id and rejects a reused id with a different body", async () => {
		const rt = runtime();
		const { tenantId, partitionId, chatId } = await newTenantWithChat(rt);
		const runner = new Runner({ ownerId: "r1", steward: db.steward, deps: rt.deps() });
		await runner.claimOnce();
		await until(async () => (await chatOf(tenantId, chatId))?.conversation_id, "conversation");
		const conv = (await chatOf(tenantId, chatId))!.conversation_id!;
		const cmd = { tenantId, commandId: "dup", actor: "u1", kind: "chat.send", partitionId, payload: { conversationId: conv, content: "once" }, signal: { kind: "input" } };
		expect((await acceptCommand(db.gate, cmd)).duplicate).toBe(false);
		expect((await acceptCommand(db.gate, cmd)).duplicate).toBe(true);
		await expect(acceptCommand(db.gate, { ...cmd, payload: { conversationId: conv, content: "different" } })).rejects.toThrow(/different body/);
		await until(async () => (await answers(tenantId, partitionId)).filter((a) => JSON.stringify(a).includes("echo:once")).length >= 1, "answer");
		await sleep(300);
		expect((await answers(tenantId, partitionId)).filter((a) => JSON.stringify(a).includes("echo:once")).length).toBe(1);
		await runner.drain();
	});
});

describe("competing runners", () => {
	it("two runners over many families: each family has exactly one owner at a time and every chat is answered exactly once", async () => {
		const rt = runtime({ latencyMs: 20 });
		const tenants: Awaited<ReturnType<typeof newTenantWithChat>>[] = [];
		for (let i = 0; i < 12; i++) tenants.push(await newTenantWithChat(rt, `m${i}`));
		const owners = new Map<string, Set<string>>();
		const watch = (name: string) => (rt.deps() as HostDeps);
		void watch;
		const a = new Runner({ ownerId: "ra", steward: db.steward, deps: rt.deps(), maxFamilies: 6 });
		const b = new Runner({ ownerId: "rb", steward: db.steward, deps: rt.deps(), maxFamilies: 6 });
		a.start();
		b.start();
		const sampler = setInterval(async () => {
			const rows = (await db.admin.query("SELECT partition_id, owner_id FROM rt.partitions WHERE lease_until > now() AND owner_id IS NOT NULL")).rows;
			const live = new Map<string, number>();
			for (const r of rows) live.set(r.partition_id, (live.get(r.partition_id) ?? 0) + 1);
			for (const r of rows) (owners.get(r.partition_id) ?? owners.set(r.partition_id, new Set()).get(r.partition_id)!).add(r.owner_id);
			for (const n of live.values()) expect(n).toBe(1);
		}, 20);
		await until(async () => (await Promise.all(tenants.map((t) => answers(t.tenantId, t.partitionId)))).every((x) => x.length >= 1), "all answers", 40_000);
		clearInterval(sampler);
		for (const t of tenants) expect((await answers(t.tenantId, t.partitionId)).length).toBe(1);
		await a.drain();
		await b.drain();
	});
});

describe("crash, drain and stale owners", () => {
	it("recovers a crashed owner's run after the lease expires, with no duplicate input and no repeated unsafe effect", async () => {
		const effects: string[] = [];
		const rt = runtime({ latencyMs: 50, effects, tools: "charge" });
		const { tenantId, partitionId } = await newTenantWithChat(rt, "pay");
		const first = new Runner({ ownerId: "crash-1", steward: db.steward, deps: rt.deps() });
		await first.claimOnce();
		await until(() => effects.length === 1, "effect dispatched");
		await first.crash();
		// No other runner can take it until the lease expires (2s ttl).
		const second = new Runner({ ownerId: "crash-2", steward: db.steward, deps: rt.deps() });
		expect(await second.claimOnce()).toBe(0);
		await sleep(2200);
		second.start();
		await until(async () => (await answers(tenantId, partitionId)).some((a) => JSON.stringify(a).includes("echo:")), "run completed after recovery", 30_000);
		const entries = (await entriesOf(tenantId, partitionId)).map((r) => JSON.parse(r.record));
		expect(entries.filter((e) => e.kind === "pi.user").length).toBe(1);
		// The crashed call was never run again: unsafe tools are interrupted, not replayed.
		expect(effects.length).toBe(1);
		await second.drain();
	});

	it("drains for a rolling upgrade: leases are released at once and another runner continues the family", async () => {
		const rt = runtime({ latencyMs: 300 });
		const { tenantId, partitionId } = await newTenantWithChat(rt, "slow");
		const old = new Runner({ ownerId: "old", steward: db.steward, deps: rt.deps() });
		await old.claimOnce();
		await sleep(150);
		await old.drain();
		const free = (await db.admin.query("SELECT lease_until <= now() AS free FROM rt.partitions WHERE partition_id = $1", [partitionId])).rows[0];
		expect(free.free).toBe(true);
		const next = new Runner({ ownerId: "new", steward: db.steward, deps: rt.deps() });
		expect(await next.claimOnce()).toBe(1);
		await until(async () => (await answers(tenantId, partitionId)).length === 1, "answer after handover");
		await next.drain();
	});

	it("stops a stale owner from dispatching effects and from committing once another owner has the family", async () => {
		const rt = runtime();
		const { tenantId, partitionId } = await newTenantWithChat(rt, "x");
		const lease = (await import("../src/partitions.ts")).acquireLease;
		const l1 = (await lease(db.runtime, tenantId, partitionId, "stale", 400))!;
		const host = new PartitionHost(l1, { ...rt.deps(), leaseTtlMs: 400 });
		expect(await host.mayDispatch(0)).toBe(true);
		await host.kill();
		await sleep(500);
		const l2 = await lease(db.runtime, tenantId, partitionId, "fresh", 60_000);
		expect(l2!.epoch).toBe(l1.epoch + 1);
		expect(await host.mayDispatch(0)).toBe(false);
		await expect(host.storage.commit([], undefined as never)).rejects.toThrow(/closed|Ownership/);
	});
});

describe("approvals", () => {
	for (const early of [false, true]) {
		it(`wakes a parked tool after the owner unloaded${early ? ", with the decision arriving before the tool parked" : ""}`, async () => {
			const effects: string[] = [];
			const rt = runtime({ effects, tools: "approve" });
			const { tenantId, partitionId } = await newTenantWithChat(rt, "pay");
			const runner = new Runner({ ownerId: "ap", steward: db.steward, deps: rt.deps() });
			await runner.claimOnce();
			const approval = await until(async () => (await db.admin.query("SELECT approval_id FROM app.approvals WHERE partition_id = $1", [partitionId])).rows[0], "approval filed");
			if (early) {
				// Decided while the tool is still running (before it suspended).
				expect(await decideApproval(db.gate, { tenantId, approvalId: approval.approval_id, decidedBy: "u1", approve: true })).toBe("decided");
			} else {
				// Owner unloads with the task parked, holding no invocation.
				await until(async () => runner.hosts.size === 0 && (await quiescent(partitionId)).state === "quiescent", "owner unloaded while parked", 30_000);
				expect(effects.length).toBe(0);
				expect(await decideApproval(db.gate, { tenantId, approvalId: approval.approval_id, decidedBy: "u1", approve: true })).toBe("decided");
				expect(await decideApproval(db.gate, { tenantId, approvalId: approval.approval_id, decidedBy: "u1", approve: false })).toBe("already_decided");
				expect(await runner.claimOnce()).toBe(1);
			}
			await until(async () => (await answers(tenantId, partitionId)).some((a) => JSON.stringify(a).includes("echo:")), "run finished", 30_000);
			expect(effects.length).toBe(1);
			const applied = (await db.admin.query("SELECT applied_at IS NOT NULL AS applied FROM app.approvals WHERE approval_id = $1", [approval.approval_id])).rows[0];
			expect(applied.applied).toBe(true);
			await runner.drain();
		});
	}
});
void createModels;
