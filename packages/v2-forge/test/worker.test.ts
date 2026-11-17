import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AmbiguousCreateError, type ComputeHandle, type ComputeProvider } from "../src/compute";
import { CAPABILITIES, HARNESSES, MAX_RESUMES, MAX_SESSION_RESTARTS } from "../src/harnesses";
import { SETTLE_MS } from "../src/compute";
import { ada, ScriptedPort, startReq, stack } from "./stack";

const waitUntil = async (check: () => Promise<boolean>) => {
	for (let i = 0; i < 400; i++) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out");
};

describe("harness capabilities are honest", () => {
	it("describes five harnesses in three families, none of which share the normal agents' runners", () => {
		expect(Object.keys(CAPABILITIES).sort()).toEqual([...HARNESSES].sort());
		expect(CAPABILITIES.pi.family).toBe("sandbox-pi");
		for (const h of ["claude-code", "codex", "mistral-vibe"] as const) expect(CAPABILITIES[h]).toMatchObject({ family: "sandbox-cli", resume: "vendor-session-id", needsWorkspace: true });
		expect(CAPABILITIES.amp).toMatchObject({ family: "remote-orb", needsWorkspace: false, onWorkerRestart: "adopt", forgePush: false, diff: "remote-git-host", checkpoints: false });
		// Not all five report cost or enforce a budget the same way.
		expect(CAPABILITIES.codex).toMatchObject({ cost: "tokens-only", budgetEnforced: false });
		expect(CAPABILITIES["claude-code"]).toMatchObject({ cost: "usd-delta", budgetEnforced: true });
		expect(HARNESSES.every((h) => CAPABILITIES[h].sharesNormalAgentRunners === false)).toBe(true);
	});
});

describe("sandbox harness turns", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
	});
	afterAll(async () => s.close());

	it.each(["pi", "claude-code", "codex", "mistral-vibe"] as const)("%s: start, a turn, a steer that resumes its session, one wake per turn", async (harness) => {
		const port = new ScriptedPort([
			{ outcome: "completed", text: "First answer\n<suggested-replies>\n- Ship it\n- Add tests\n</suggested-replies>", costUsd: harness === "codex" ? 0 : 0.25, tokensIn: 100, tokensOut: 50, sessionId: `sess-${harness}` },
			{ outcome: "completed", text: "Second answer" },
		]);
		const w = s.worker({ turns: { [harness]: port } });
		const { threadId } = await s.forge.start(ada, startReq(`run-${harness}`, { harness }));
		expect(await w.step(threadId)).toBe("done");
		let t = await s.store.get(threadId);
		expect(t).toMatchObject({ state: "idle", harness, spentUsd: harness === "codex" ? 0 : 0.25 });
		expect(t!.workspaceRef.tag).toContain(threadId);
		expect(await s.scheduler.slots("default")).toContain(threadId);
		const first = (await s.forge.transcript(ada, threadId, { role: "assistant" })).events;
		expect(first[0]?.data).toMatchObject({ text: "First answer", suggestedReplies: ["Ship it", "Add tests"] });

		// A steer resumes the vendor session; the same operation id twice is one turn.
		await s.forge.steer(ada, threadId, "now add tests", `steer-${harness}`);
		await s.forge.steer(ada, threadId, "now add tests", `steer-${harness}`);
		await w.step(threadId);
		expect(port.calls).toHaveLength(2);
		expect(port.calls[1]).toMatchObject({ sessionId: `sess-${harness}`, resume: true, prompt: "now add tests" });
		const wakes = (await s.pool.query("select dedupe_key from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1 order by id", [threadId])).rows.map((r) => r.dedupe_key);
		expect(wakes).toEqual([`coding:${threadId}:run-${harness}`, `coding:${threadId}:steer-${harness}`]);
		const cost = await s.pool.query("select count(*) c from pim_forge.forge_outbox where topic = 'cost_ledger' and thread_id = $1 and payload ->> 'run_kind' = 'coding_thread'", [threadId]);
		expect(Number(cost.rows[0].c)).toBe(harness === "codex" ? 0 : 1);
		// The transcript supports tail and role, and the final output alone.
		expect((await s.forge.transcript(ada, threadId, { tail: 1 })).events).toHaveLength(1);
		expect(await s.forge.transcriptOutput(ada, threadId)).toEqual({ text: "Second answer" });
		t = await s.store.get(threadId);
		expect(t!.cancelState).toBe("none");
	});

	it("a worker dying mid-turn: the run settles interrupted, resumes by itself without a premature turn_ended, and the dead worker is fenced out", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let entered!: () => void;
		const inTurn = new Promise<void>((r) => (entered = r));
		const slow = new ScriptedPort([async () => ((entered(), await gate), { outcome: "completed", text: "zombie result", costUsd: 9 })]);
		const w1 = s.worker({ turns: { "claude-code": slow }, leaseMs: 60_000 }, "w1");
		const { threadId } = await s.forge.start(ada, startReq("crash-1", { harness: "claude-code" }));
		const first = w1.step(threadId);
		await inTurn;
		// w1 dies: its lease lapses, and w2 takes the thread over at the next epoch.
		await s.pool.query("update pim_forge.forge_threads set lease_expires_at = now() - interval '1 second' where thread_id = $1", [threadId]);
		const fresh = new ScriptedPort([{ outcome: "completed", text: "recovered", sessionId: "s-2" }]);
		const w2 = s.worker({ turns: { "claude-code": fresh } }, "w2");
		expect(await w2.step(threadId)).toBe("done");
		const runs = (await s.pool.query("select operation_id, status from pim_forge.forge_harness_runs where thread_id = $1 order by run_id", [threadId])).rows;
		expect(runs).toEqual([
			{ operation_id: "crash-1", status: "interrupted" },
			{ operation_id: "resume-crash-1-1", status: "completed" },
		]);
		expect(fresh.calls[0]).toMatchObject({ operationId: "resume-crash-1-1" });
		// The zombie finishes late: its writes are refused by the epoch, so nothing of it lands.
		release();
		expect(await first).toBe("busy");
		const ended = (await s.forge.transcript(ada, threadId)).events.map((e) => e.data?.text);
		expect(ended).not.toContain("zombie result");
		const t = (await s.store.get(threadId))!;
		expect(t.spentUsd).toBe(0);
		expect(t.state).toBe("idle");
		const turnEnds = await s.pool.query("select count(*) c from pim_forge.forge_events where thread_id = $1 and kind = 'thread.turn_ended'", [threadId]);
		expect(Number(turnEnds.rows[0].c)).toBe(1);
		const wakes = await s.pool.query("select dedupe_key from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1", [threadId]);
		expect(wakes.rows.map((r) => r.dedupe_key)).toEqual([`coding:${threadId}:crash-1`]);
	});

	it("two workers racing on one thread: the lease lets only one step it", async () => {
		const port = new ScriptedPort([async () => (await new Promise((r) => setTimeout(r, 300)), { outcome: "completed", text: "once" })]);
		const { threadId } = await s.forge.start(ada, startReq("race-1", { harness: "codex" }));
		const results = await Promise.all([s.worker({ turns: { codex: port } }, "a").step(threadId), s.worker({ turns: { codex: port } }, "b").step(threadId)]);
		expect([...results].sort()).toEqual(["busy", "done"]);
		expect(port.calls).toHaveLength(1);
		// A stale epoch cannot write at all.
		const epoch = (await s.store.get(threadId))!.leaseEpoch;
		await expect(s.store.fenced(threadId, epoch - 1, async () => 1)).rejects.toMatchObject({ code: "lease_lost" });
	});

	it("a lost sandbox auto-resumes at most MAX_RESUMES times, then fails once with one wake", async () => {
		const port = new ScriptedPort(Array.from({ length: 10 }, () => ({ outcome: "interrupted" as const, detail: "sandbox lost" })));
		const { threadId } = await s.forge.start(ada, startReq("lost-1", { harness: "mistral-vibe" }));
		await s.worker({ turns: { "mistral-vibe": port } }).step(threadId);
		expect(port.calls).toHaveLength(MAX_RESUMES + 1);
		expect(await s.store.get(threadId)).toMatchObject({ state: "failed", stateReason: "lost" });
		const wakes = await s.pool.query("select payload from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1", [threadId]);
		expect(wakes.rows).toHaveLength(1);
		expect(wakes.rows[0].payload.outcome).toBe("failed");
	});

	it("a session that keeps hitting its time limit without progress stops after MAX_SESSION_RESTARTS", async () => {
		const port = new ScriptedPort(Array.from({ length: 10 }, () => ({ outcome: "session_limit" as const, sessionId: "s", progress: false })));
		const { threadId } = await s.forge.start(ada, startReq("limit-1", { harness: "claude-code" }));
		await s.worker({ turns: { "claude-code": port } }).step(threadId);
		expect(port.calls.length).toBe(MAX_SESSION_RESTARTS + 1);
		expect(await s.store.get(threadId)).toMatchObject({ state: "failed", stateReason: "session_limit" });
	});

	it("stops at its budget: failed/budget, and a steer then answers budget_spent", async () => {
		const port = new ScriptedPort([{ outcome: "completed", text: "pricey", costUsd: 0.6 }]);
		const { threadId } = await s.forge.start(ada, startReq("budget-1", { harness: "claude-code", budgetUsd: 0.5 }));
		await s.worker({ turns: { "claude-code": port } }).step(threadId);
		expect(await s.store.get(threadId)).toMatchObject({ state: "failed", stateReason: "budget", spentUsd: 0.6 });
		await expect(s.forge.steer(ada, threadId, "more", "b-steer")).rejects.toMatchObject({ code: "budget_spent" });
	});

	it("a missing login waits for the person instead of failing", async () => {
		const port = new ScriptedPort([{ outcome: "login_required", detail: "Connect your Codex login" }]);
		const { threadId } = await s.forge.start(ada, startReq("login-1", { harness: "codex" }));
		await s.worker({ turns: { codex: port } }).step(threadId);
		expect(await s.store.get(threadId)).toMatchObject({ state: "waiting_input", stateReason: "login_required" });
	});

	it("gives a sandbox back after two idle minutes, keeps the thread, and provisions again for its next input", async () => {
		const port = new ScriptedPort([{ outcome: "completed", text: "first", sessionId: "s1" }, { outcome: "completed", text: "second" }]);
		const w = s.worker({ turns: { codex: port } });
		const { threadId } = await s.forge.start(ada, startReq("reap-1", { harness: "codex" }));
		await w.step(threadId);
		const first = (await s.store.get(threadId))!.workspaceRef;
		expect(await s.scheduler.slots("default")).toContain(threadId);
		s.advance(60_000);
		expect(await w.reap()).not.toContain(threadId);
		s.advance(61_000);
		expect(await w.reap()).toContain(threadId);
		const t = (await s.store.get(threadId))!;
		expect(t).toMatchObject({ state: "idle", workspaceRef: null });
		expect(await s.scheduler.slots("default")).not.toContain(threadId);
		expect(s.sandboxes.list().some((tag) => tag === first.tag)).toBe(false);
		// The vendor session lived in the sandbox: the next turn starts a new one, in a fresh sandbox.
		await s.forge.steer(ada, threadId, "again", "reap-2");
		await w.step(threadId);
		expect(port.calls[1]).toMatchObject({ sessionId: null, resume: false });
		expect((await s.store.get(threadId))!.workspaceRef).toBeTruthy();
		// A thread with input waiting is never reaped.
		s.advance(121_000);
		await s.store.locked(threadId, (q) => s.store.enqueueInbox(q, threadId, "reap-3", "steer", { prompt: "x" }));
		expect(await w.reap()).not.toContain(threadId);
	});

	it("dispatches steps without waiting for them: a slow turn doesn't hold up another thread", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const slow = new ScriptedPort([async () => (await gate, { outcome: "completed", text: "slow" })]);
		const fast = new ScriptedPort([{ outcome: "completed", text: "fast" }]);
		const w = s.worker({ turns: { "claude-code": slow, codex: fast } });
		const a = (await s.forge.start(ada, startReq("disp-a", { harness: "claude-code" }))).threadId;
		const b = (await s.forge.start(ada, startReq("disp-b", { harness: "codex" }))).threadId;
		const started = await w.dispatch();
		expect(started).toBeGreaterThanOrEqual(2);
		await waitUntil(async () => (await s.store.get(b))!.state === "idle");
		expect((await s.store.get(a))!.state).toBe("running");
		// The same thread is never stepped twice at once.
		expect(await w.dispatch()).toBe(0);
		release();
		await w.drain();
		expect((await s.store.get(a))!.state).toBe("idle");
	});

	it("an ambiguous sandbox creation is reconciled by tag, never launched twice", async () => {
		const real = s.sandboxes;
		let failNext: "after" | "before" | null = "after";
		const flaky: ComputeProvider = {
			id: "local",
			find: (tag) => real.find(tag),
			exec: (h: ComputeHandle, c: readonly string[], o) => real.exec(h, c, o),
			destroy: (h) => real.destroy(h),
			async create(tag, spec) {
				const mode = failNext;
				failNext = null;
				if (mode === "before") throw new AmbiguousCreateError();
				const h = await real.create(tag, spec);
				if (mode === "after") throw new AmbiguousCreateError();
				return h;
			},
		};
		const port = new ScriptedPort([{ outcome: "completed", text: "ok" }]);
		const w = s.worker({ turns: { "claude-code": port }, compute: flaky });
		const { threadId } = await s.forge.start(ada, startReq("amb-1", { harness: "claude-code" }));
		const before = real.created.length;
		// The create happened but its answer was lost: the next step finds it by tag.
		expect(await w.step(threadId)).toBe("retry");
		expect((await s.store.get(threadId))!.provisioning.phase).toBe("uncertain");
		expect(await w.step(threadId)).toBe("done");
		expect(real.created.length - before).toBe(1);
		expect(real.list().filter((t) => t.includes(threadId))).toHaveLength(1);

		// The create never happened, but Forge can't know: it refuses to create inside the settle window, then does, once.
		failNext = "before";
		const t2 = (await s.forge.start(ada, startReq("amb-2", { harness: "claude-code" }))).threadId;
		const b2 = real.created.length;
		expect(await w.step(t2)).toBe("retry");
		expect(await w.step(t2)).toBe("retry");
		expect(real.created.length - b2).toBe(0);
		s.advance(SETTLE_MS + 1);
		port["script"].push({ outcome: "completed", text: "ok2" });
		expect(await w.step(t2)).toBe("done");
		expect(real.created.length - b2).toBe(1);
	});
});
