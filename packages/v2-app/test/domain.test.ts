import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandSubmission } from "@pim/v2-contracts/runtime-seam";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import { FIRE_GRACE_MS, nextCron } from "../src/schedules.ts";
import { fixture, member } from "./support/fixture.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let u: Awaited<ReturnType<typeof member>>;
beforeAll(async () => {
	f = await fixture();
	u = await member(f.app, f.admin.principal, "ada");
});
afterAll(() => f.close());

const owner = () => u.account.ownerId;

describe("command admission", () => {
	it("commits a duplicate commandId once, and refuses the id for a different command", async () => {
		const chat = await f.app.conversations.create(u.principal, { title: "hello" });
		const first = await f.app.conversations.admit(u.principal, { commandId: "c1", kind: "user_message", chatId: chat, payload: { text: "hi" } });
		const again = await f.app.conversations.admit(u.principal, { commandId: "c1", kind: "user_message", chatId: chat, payload: { text: "hi" } });
		expect(first).toMatchObject({ duplicate: false, state: "inbox_accepted" });
		expect(again).toMatchObject({ duplicate: true, piRequestId: first.piRequestId });
		await expect(f.app.conversations.admit(u.principal, { commandId: "c1", kind: "user_message", chatId: chat, payload: { text: "other" } })).rejects.toMatchObject({ code: "command_id_reused" });
		const rows = await f.db.owner(owner(), (tx) => tx.query("SELECT (SELECT count(*)::int FROM pim_app.accepted_commands WHERE command_id = 'c1') AS a, (SELECT count(*)::int FROM pim_app.command_inbox WHERE command_id = 'c1') AS i"));
		expect(rows.rows[0]).toEqual({ a: 1, i: 1 });
	});

	it("answers without a Runner, and shows accepted and runtime-committed commands apart", async () => {
		const chat = await f.app.conversations.create(u.principal, {});
		await f.app.conversations.markCommitted(owner(), "c1"); // the earlier test's command is done
		await f.app.conversations.admit(u.principal, { commandId: "m1", kind: "user_message", chatId: chat, payload: { text: "one" } });
		await f.app.conversations.admit(u.principal, { commandId: "m2", kind: "user_message", chatId: chat, payload: { text: "two" } });
		expect((await f.app.conversations.pending(owner(), chat)).map((c) => [c.commandId, c.inboxAccepted, c.runtimeCommitted])).toEqual([["m1", true, false], ["m2", true, false]]);
		const claimed = await f.app.conversations.claim(owner(), "runner-a", 1);
		expect(claimed.map((c) => c.commandId)).toEqual(["m1"]);
		// What the Runner receives is the runtime's CommandSubmission, with the stable piRequestId and the numeric pi conversation id.
		expect(CommandSubmission.parse(claimed[0])).toMatchObject({ kind: "user_message", ownerId: owner(), publicChatId: chat, payload: { text: "one" }, piRequestId: (await f.app.conversations.pending(owner(), chat))[0]!.piRequestId });
		expect(claimed[0]!.conversationId).toBeGreaterThan(1); // 1 is the home partition's root
		expect((await f.app.conversations.claim(owner(), "runner-b", 5)).map((c) => c.commandId)).toEqual(["m2"]); // m1 is leased, not handed out twice
		await f.app.conversations.markCommitted(owner(), "m1");
		expect((await f.app.conversations.pending(owner(), chat)).map((c) => [c.commandId, c.state])).toEqual([["m1", "runtime_committed"], ["m2", "inbox_accepted"]]);
	});

	it("forks into the parent's family with stable ids, and keeps public ids apart from pi ids", async () => {
		const chat = await f.app.conversations.create(u.principal, { title: "parent" });
		const fork = await f.app.conversations.admit(u.principal, { commandId: "f1", kind: "fork", chatId: chat });
		const dup = await f.app.conversations.admit(u.principal, { commandId: "f1", kind: "fork", chatId: chat });
		expect(dup.result).toEqual(fork.result);
		const parent = await f.app.conversations.get(owner(), chat);
		const child = await f.app.conversations.get(owner(), fork.chatId!);
		expect(child).toMatchObject({ forkedFrom: chat, partitionId: parent.partitionId });
		expect(child.conversationId).not.toBe(parent.conversationId);
		// A new chat starts a new family.
		const other = await f.app.conversations.get(owner(), await f.app.conversations.create(u.principal, {}));
		expect(other.partitionId).not.toBe(parent.partitionId);
		expect(new Set([parent.conversationId, child.conversationId, other.conversationId]).size).toBe(3);
	});

	it("detaches a post-idle continuation when the archived chat is unarchived or messaged", async () => {
		for (const kind of ["unarchive", "user_message"] as const) {
			const old = await f.app.conversations.create(u.principal, { title: `old-${kind}` });
			const next = await f.app.conversations.handoff(u.principal, old, "## Goal\nsummary");
			expect(await f.app.conversations.handoff(u.principal, old, "again")).toBe(next); // one continuation
			expect(await f.app.conversations.get(owner(), old)).toMatchObject({ continuedTo: next, archived: true });
			expect(await f.app.conversations.get(owner(), next)).toMatchObject({ continuedFrom: old });
			await f.app.conversations.admit(u.principal, { commandId: `r-${kind}`, kind, chatId: old, payload: { text: "back" } });
			expect(await f.app.conversations.get(owner(), old)).toMatchObject({ continuedTo: null, archived: false });
			expect(await f.app.conversations.get(owner(), next)).toMatchObject({ continuedFrom: null });
		}
	});

	it("moves a delegated task through its states and delivers each [Task update] once", async () => {
		const chat = await f.app.conversations.create(u.principal, {});
		const d = await f.app.conversations.admit(u.principal, { commandId: "d1", kind: "delegate", chatId: chat, payload: { title: "research", prompt: "go" } });
		const taskId = d.result!.taskId as string;
		expect((await f.app.conversations.admit(u.principal, { commandId: "d1", kind: "delegate", chatId: chat, payload: { title: "research", prompt: "go" } })).result).toEqual(d.result);
		expect(await f.app.conversations.updateTask(u.principal, taskId, "auth-required")).toEqual({ delivered: true });
		expect(await f.app.conversations.updateTask(u.principal, taskId, "auth-required")).toEqual({ delivered: false });
		await f.app.conversations.updateTask(u.principal, taskId, "working");
		expect(await f.app.conversations.updateTask(u.principal, taskId, "completed", "done")).toEqual({ delivered: true });
		await expect(f.app.conversations.updateTask(u.principal, taskId, "working")).rejects.toMatchObject({ code: "bad_task_transition" });
		const updates = (await f.app.conversations.pending(owner(), chat)).filter((c) => c.kind === "task_wake" && c.commandId.startsWith("task:"));
		expect(updates.map((c) => c.commandId)).toEqual([`task:${taskId}:auth-required`, `task:${taskId}:working`, `task:${taskId}:completed`]);
		expect(await f.app.conversations.archiveTaskChats(u.principal)).toBeGreaterThanOrEqual(1);
		expect((await f.app.conversations.get(owner(), d.chatId!)).archived).toBe(true);
	});
});

describe("memories, skills and goals", () => {
	it("recalls by regex within scopes, zooms into blocks, forgets and moves", async () => {
		const a = await f.app.memories.remember(u.principal, "agent-1", "Coffee", "likes oat milk\nno sugar\nstrong");
		await f.app.memories.remember(u.principal, "everyone", "Tea", "green tea");
		await f.app.memories.remember(u.principal, "agent-2", "Coffee order", "hidden from agent-1");
		expect((await f.app.memories.recall(u.principal, ["agent-1", "everyone"], "^coffee|green")).map((m) => m.title).sort()).toEqual(["Coffee", "Tea"]);
		expect(await f.app.memories.zoom(u.principal, a, 2, 1)).toEqual({ lines: ["no sugar"], total: 3 });
		await expect(f.app.memories.recall(u.principal, ["everyone"], "(")).rejects.toMatchObject({ status: 400 });
		await f.app.memories.move(u.principal, a, "everyone");
		expect((await f.app.memories.recall(u.principal, ["everyone"], "oat")).map((m) => m.id)).toEqual([a]);
		await f.app.memories.forget(u.principal, a);
		expect(await f.app.memories.recall(u.principal, ["everyone"], "oat")).toEqual([]);
	});

	it("finishes a goal with its last step", async () => {
		const g = await f.app.memories.createGoal(u.principal, "Run a 5k", ["Run 2k", "Run 5k"]);
		expect(await f.app.memories.completeStep(u.principal, g, 0)).toEqual({ goalDone: false });
		expect(await f.app.memories.completeStep(u.principal, g, 1)).toEqual({ goalDone: true });
	});
});

describe("schedules", () => {
	it("computes cron occurrences in UTC", () => {
		expect(nextCron("*/15 9 * * 1-5", new Date("2026-11-16T09:50:00Z"))?.toISOString()).toBe("2026-11-17T09:00:00.000Z");
		expect(nextCron("30 2 29 2 *", new Date("2026-03-01T00:00:00Z"))?.toISOString()).toBe("2028-02-29T02:30:00.000Z");
	});

	it("fires only the latest in-grace occurrence after downtime and records the rest as missed, once", async () => {
		const t0 = new Date("2026-11-16T00:00:00Z");
		const id = await f.app.schedules.create(u.principal, { kind: "cron", spec: "0 * * * *", prompt: "hourly check", now: t0, target: "new_chat" });
		// The system was down for ten hours; it comes back two minutes after the 10:00 occurrence.
		const back = new Date("2026-11-16T10:02:00Z");
		expect(await f.app.schedules.dueOwners(back)).toContain(owner());
		const [a, b] = await Promise.all([f.app.schedules.tick(owner(), back), f.app.schedules.tick(owner(), back)]);
		expect(a.fired + b.fired).toBe(1);
		const runs = await f.app.schedules.runs(owner(), id);
		expect(runs.filter((r) => r.outcome === "fired").map((r) => r.occurrence.toISOString())).toEqual(["2026-11-16T10:00:00.000Z"]);
		expect(runs.filter((r) => r.outcome === "missed")).toHaveLength(9); // 01:00 .. 09:00
		const commands = await f.db.owner(owner(), (tx) => tx.query("SELECT command_id FROM pim_app.accepted_commands WHERE command_id LIKE $1", [`sched:${id}:%`]));
		expect(commands.rowCount).toBe(1);
		expect((await f.app.schedules.tick(owner(), back))).toEqual({ fired: 0, missed: 0 });
		// Past the grace window nothing fires at all, and the schedule moves on.
		const late = new Date(new Date("2026-11-16T12:00:00Z").getTime() + FIRE_GRACE_MS + 60_000);
		expect(await f.app.schedules.tick(owner(), late)).toEqual({ fired: 0, missed: 2 });
	});

	it("records a one-shot that was missed, and stops a suspended owner's schedules", async () => {
		const id = await f.app.schedules.create(u.principal, { kind: "at", spec: "2026-11-01T08:00:00Z", prompt: "once", now: new Date("2026-10-30T00:00:00Z") });
		expect(await f.app.schedules.tick(owner(), new Date("2026-11-16T00:00:00Z"))).toEqual({ fired: 0, missed: 1 });
		expect((await f.app.schedules.runs(owner(), id)).map((r) => r.outcome)).toEqual(["missed"]);
		const v = await member(f.app, f.admin.principal, "vic");
		await f.app.schedules.create(v.principal, { kind: "delay", spec: "1000", prompt: "soon", now: new Date("2026-11-16T00:00:00Z") });
		await f.app.identity.setStatus(f.admin.principal, v.account.ownerId, "suspended");
		expect(await f.app.schedules.tick(v.account.ownerId, new Date("2026-11-16T00:00:02Z"))).toEqual({ fired: 0, missed: 0 });
	});
});

describe("durable tool operations and approvals", () => {
	const partitionId = "7d444840-9dc0-41b4-8b2c-3b0f0c4b8a11";
	const op = (idempotent: boolean, now?: Date) => f.app.operations.create(u.principal, { partitionId, taskId: "task_1", toolName: idempotent ? "web_fetch" : "http_request", capability: "http", idempotent, deadlineMs: 1000, ...(now ? { now } : {}) });

	it("sends a timed-out call the provider cannot de-duplicate to reconciliation and never retries it blind", async () => {
		const now = new Date("2026-11-16T00:00:00Z");
		const post = await op(false, now);
		const get = await op(true, now);
		expect(post).toMatchObject({ state: "pending", idempotencyKey: `pim-${post.operationId}`, receipt: null, earlySignal: null });
		await f.app.operations.start(owner(), post.operationId);
		await f.app.operations.start(owner(), get.operationId);
		expect(await f.app.operations.sweep(owner(), new Date(now.getTime() + 2000))).toEqual({ requeued: 1, needsReconciliation: 1 });
		expect((await f.app.operations.get(owner(), post.operationId))?.state).toBe("needs_reconciliation");
		await expect(f.app.operations.retry(owner(), post.operationId)).rejects.toMatchObject({ code: "retry_unsafe" });
		await expect(f.app.operations.start(owner(), post.operationId)).rejects.toMatchObject({ code: "bad_operation_state" });
		// The one whose provider honours the key retries under the same key.
		expect(await f.app.operations.retry(owner(), get.operationId)).toEqual({ idempotencyKey: get.idempotencyKey });
		// A person reconciles the other with what actually happened.
		await f.app.operations.complete(owner(), post.operationId, { status: 201 });
		expect(await f.app.operations.get(owner(), post.operationId)).toMatchObject({ state: "completed", receipt: { status: 201 } });
	});

	it("records cancellation as requested, confirmed or uncertain, and keeps an early signal for the parked task", async () => {
		const a = await op(false);
		await f.app.operations.start(owner(), a.operationId);
		await f.app.operations.cancel(owner(), a.operationId, "requested");
		expect((await f.app.operations.get(owner(), a.operationId))?.state).toBe("cancel_requested");
		await f.app.operations.recordEarlySignal(owner(), a.operationId, { decision: "deny" });
		await f.app.operations.cancel(owner(), a.operationId, "uncertain");
		expect(await f.app.operations.get(owner(), a.operationId)).toMatchObject({ state: "cancel_uncertain", earlySignal: { decision: "deny" } });
		const b = await op(false);
		await f.app.operations.cancel(owner(), b.operationId, "confirmed");
		expect((await f.app.operations.get(owner(), b.operationId))?.state).toBe("cancelled");
		await expect(f.app.operations.cancel(owner(), b.operationId, "requested")).rejects.toMatchObject({ code: "bad_operation_state" });
	});

	it("approves after 30 seconds what a person on the auto policy never answers, and leaves explicit ones waiting", async () => {
		const agent: Principal = { kind: "agent", ownerId: OwnerId.parse(owner()), agentId: "dev" };
		await f.app.identity.authz.grantCoding(f.admin.principal, { ownerId: owner(), permissions: ["coding:push"], repositories: ["github.com/acme/*"] });
		const resource = { repository: "github.com/acme/app" };
		const now = new Date("2026-11-17T00:00:00Z");
		const setPolicy = (value: string) => f.db.owner(owner(), (tx) => tx.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1, 'settings.approvalPolicy', $2) ON CONFLICT (owner_id, key) DO UPDATE SET value = $2", [owner(), JSON.stringify(value)]));
		await setPolicy("explicit");
		const waits = await f.app.approvals.gate(agent, { action: "coding:push", resource, now });
		await setPolicy("auto");
		const auto = await f.app.approvals.gate(agent, { action: "coding:push", resource, now });
		// Under auto, even a caller that would have waited ten minutes, and would have denied, gets the policy: approved after 30 seconds.
		const own = await f.app.approvals.gate(agent, { action: "coding:push", resource, timeoutMs: 600_000, onTimeout: "deny", now });
		if (waits.outcome !== "waiting" || auto.outcome !== "waiting" || own.outcome !== "waiting") throw new Error("expected waiting approvals");
		expect(await f.app.approvals.sweep(owner(), new Date(now.getTime() + 29_000))).toEqual({ denied: 0, approved: 0 });
		expect(await f.app.approvals.sweep(owner(), new Date(now.getTime() + 31_000))).toEqual({ denied: 0, approved: 2 });
		expect(await f.app.approvals.state(owner(), auto.approvalId)).toBe("timed_out_approved");
		expect(await f.app.approvals.state(owner(), own.approvalId)).toBe("timed_out_approved");
		expect(await f.app.approvals.state(owner(), waits.approvalId)).toBe("waiting"); // filed before the person chose auto
		await setPolicy("explicit");
	});

	it("applies approval timeouts: deny by default, approve only a call still waiting", async () => {
		const agent: Principal = { kind: "agent", ownerId: OwnerId.parse(owner()), agentId: "dev" };
		await f.app.identity.authz.grantCoding(f.admin.principal, { ownerId: owner(), permissions: ["coding:push"], repositories: ["github.com/acme/*"] });
		const resource = { repository: "github.com/acme/app" };
		const now = new Date("2026-11-16T00:00:00Z");
		const w1 = await f.app.approvals.gate(agent, { action: "coding:push", resource, timeoutMs: 1000, now });
		const w2 = await f.app.approvals.gate(agent, { action: "coding:push", resource, timeoutMs: 1000, onTimeout: "approve", now });
		const w3 = await f.app.approvals.gate(agent, { action: "coding:push", resource, timeoutMs: 1000, onTimeout: "approve", now });
		if (w1.outcome !== "waiting" || w2.outcome !== "waiting" || w3.outcome !== "waiting") throw new Error("expected waiting approvals");
		await f.app.approvals.decide(u.principal, w3.approvalId, false); // a person said no before the timeout
		expect(await f.app.approvals.sweep(owner(), new Date(now.getTime() + 5000))).toEqual({ denied: 1, approved: 1 });
		expect(await f.app.approvals.state(owner(), w1.approvalId)).toBe("timed_out_denied");
		expect(await f.app.approvals.state(owner(), w2.approvalId)).toBe("timed_out_approved");
		expect(await f.app.approvals.state(owner(), w3.approvalId)).toBe("denied"); // not flipped to approved by its policy
		await expect(f.app.approvals.decide(u.principal, w1.approvalId, true)).rejects.toMatchObject({ code: "approval_closed" });
		// An agent cannot approve its own request.
		await expect(f.app.approvals.decide(agent, w1.approvalId, true)).rejects.toMatchObject({ reason: "agent-scope" });
		// A standing approval lets the call through with no approval filed, and says which one.
		const standing = await f.app.identity.authz.grantStanding(f.admin.principal, { ownerId: owner(), action: "coding:push", scope: resource });
		expect(await f.app.approvals.gate(agent, { action: "coding:push", resource })).toEqual({ outcome: "allowed", viaStandingApproval: standing });
	});
});
