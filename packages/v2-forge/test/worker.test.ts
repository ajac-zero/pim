import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AmbiguousCreateError, type ComputeHandle, type ComputeProvider } from "../src/compute";
import { CAPABILITIES, HARNESSES, MAX_RESUMES, MAX_SESSION_RESTARTS } from "../src/harnesses";
import { SETTLE_MS } from "../src/compute";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach } from "vitest";
import type { TurnRequest, TurnResult } from "../src/ports";
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
		// Told what it was asked and what it last said, as v1 told a CLI whose session was lost.
		expect(port.calls[1]!.prompt).toContain("again");
		expect(port.calls[1]!.prompt).toContain("Your earlier session was lost");
		expect(port.calls[1]!.prompt).toContain("Fix the login bug");
		expect(port.calls[1]!.prompt).toContain("first");
		expect((await s.store.get(threadId))!.workspaceRef).toBeTruthy();
		// A thread with input waiting is never reaped.
		s.advance(121_000);
		await s.store.locked(threadId, (q) => s.store.enqueueInbox(q, threadId, "reap-3", "steer", { prompt: "x" }));
		expect(await w.reap()).not.toContain(threadId);
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

describe("stopping, keeping and retrying turns", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let n = 0;
	beforeEach(async () => {
		s = await stack();
		await s.grantAll("ada");
	});
	afterEach(async () => s.close());
	const host = (...a: string[]) => execFileSync("git", ["--git-dir", s.bare, ...a], { encoding: "utf8" }).trim();
	/** A turn that runs until it is stopped, as a real harness does. */
	const untilStopped = (turn: TurnRequest) => new Promise<TurnResult>((resolve) => turn.signal.addEventListener("abort", () => resolve({ outcome: "failed", detail: "stopped" }), { once: true }));
	/** A turn that edits a file in the checkout and leaves it uncommitted. */
	const editing = (file: string) => async (turn: TurnRequest): Promise<TurnResult> => {
		const h = await s.checkout(turn.threadId);
		await s.sandboxes.exec(h, ["sh", "-c", `echo ${file} > ${file}`]);
		return { outcome: "completed", text: "edited" };
	};

	it("abort stops a running turn, and the thread can be steered again afterwards", async () => {
		const { threadId } = await s.forge.start(ada, startReq(`stop-${++n}`, { harness: "claude-code" }));
		const port = new ScriptedPort([untilStopped, { outcome: "completed", text: "back" }]);
		const w = s.worker({ turns: { "claude-code": port } });
		const first = w.step(threadId);
		await waitUntil(async () => port.calls.length === 1);
		expect(await s.forge.abort(ada, threadId)).toEqual({ cancelState: "requested" });
		// Without a stop the turn would never end.
		await first;
		expect(await s.store.get(threadId)).toMatchObject({ state: "idle", stateReason: "aborted", cancelState: "cancelled" });
		await s.forge.steer(ada, threadId, "go on", "stop-steer");
		await w.step(threadId);
		expect(port.calls[1]).toMatchObject({ prompt: expect.stringContaining("go on") });
		expect(await s.store.get(threadId)).toMatchObject({ state: "idle", cancelState: "none", stateReason: null });
	});

	it("keeps what an agent left uncommitted: a checkpoint, a diff from the start that outlives the sandbox, a push that carries it", async () => {
		const { threadId } = await s.forge.start(ada, startReq(`keep-${++n}`, { harness: "claude-code" }));
		const w = s.worker({ turns: { "claude-code": new ScriptedPort([editing("one.txt")]) } });
		await w.step(threadId);
		const t = (await s.store.get(threadId))!;
		// The tree is committed at the turn's end, and the checkpoint remembers it.
		expect(await s.sandboxes.exec(t.workspaceRef, ["git", "status", "--porcelain"])).toMatchObject({ stdout: "" });
		const cps = (await s.pool.query("select seq, label from pim_forge.forge_checkpoints where thread_id = $1", [threadId])).rows;
		expect(cps).toEqual([{ seq: "1", label: `Checkpoint 1 (keep-${n})` }]);
		const base = (await s.store.get(threadId))!.baseSha;
		expect(base).toMatch(/^[0-9a-f]{40}$/);
		expect(await s.forge.diff(ada, threadId)).toMatchObject({ since: base, truncated: false, diff: expect.stringContaining("+one.txt") });
		// Work left after the turn is committed before it is pushed, and before the sandbox is given back.
		await s.sandboxes.exec(t.workspaceRef, ["sh", "-c", "echo two > two.txt"]);
		const pushed = await s.forge.push(ada, threadId);
		expect(host("show", `${t.branch}:two.txt`)).toBe("two");
		expect(host("show", `${t.branch}:one.txt`)).toBe("one.txt");
		await s.sandboxes.exec(t.workspaceRef, ["sh", "-c", "echo three > three.txt"]);
		s.advance(121_000);
		expect(await w.reap((id) => s.forge.autosave(id))).toContain(threadId);
		const bundled = (await s.pool.query("select head_sha from pim_forge.forge_autosaves where thread_id = $1", [threadId])).rows[0]!.head_sha;
		expect(bundled).not.toBe((pushed as any).sha);
		// The sandbox is gone; the diff is what was kept, and one that was never kept needs a workspace.
		const after = await s.forge.diff(ada, threadId);
		expect(after).toMatchObject({ head: bundled, diff: expect.stringContaining("+three") });
		await expect(s.forge.diff(ada, threadId, { since: "deadbeef" })).rejects.toMatchObject({ code: "workspace_not_running" });
	});

	it("pushes the thread's own branch when a turn ends, and says when it can't", async () => {
		const { threadId } = await s.forge.start(ada, startReq(`auto-${++n}`, { harness: "claude-code" }));
		const w = s.worker({ turns: { "claude-code": new ScriptedPort([editing("auto.txt"), { outcome: "completed", text: "nothing new" }]) }, autopush: true });
		await w.step(threadId);
		const t = (await s.store.get(threadId))!;
		expect(host("show", `${t.branch}:auto.txt`)).toBe("auto.txt");
		expect(t.lastPushedSha).toBe(host("rev-parse", `refs/heads/${t.branch}`));
		// Nothing new, nothing pushed again.
		await s.forge.steer(ada, threadId, "again", `auto-steer-${n}`);
		await w.step(threadId);
		expect((await s.pool.query("select count(*) c from pim_forge.forge_events where thread_id = $1 and kind = 'thread.pushed'", [threadId])).rows[0]!.c).toBe("1");
		// A host that refuses is recorded and never fails the turn.
		await s.sandboxes.exec(t.workspaceRef, ["git", "remote", "set-url", "origin", "/nowhere.git"]);
		await s.sandboxes.exec(t.workspaceRef, ["sh", "-c", "echo more > more.txt"]);
		await s.forge.steer(ada, threadId, "more", `auto-steer2-${n}`);
		await w.step(threadId);
		expect(await s.store.get(threadId)).toMatchObject({ state: "idle" });
		expect((await s.pool.query("select count(*) c from pim_forge.forge_events where thread_id = $1 and kind = 'thread.autopush_failed'", [threadId])).rows[0]!.c).toBe("1");
	});

	it("runs the repository's setup script once in a new checkout, and shows a failed one without stopping the thread", async () => {
		const prepare = async (t: { threadId: string }) => void (await s.checkout(t.threadId));
		await s.forge.repoSettings(ada, "acme/app", { setupScript: "echo installed > setup-ran.txt" });
		const ok = await s.forge.start(ada, startReq(`setup-${++n}`, { harness: "claude-code" }));
		const port = new ScriptedPort([{ outcome: "completed", text: "ok" }]);
		await s.worker({ turns: { "claude-code": port }, prepareWorkspace: prepare }).step(ok.threadId);
		const t = (await s.store.get(ok.threadId))!;
		expect((await s.sandboxes.exec(t.workspaceRef, ["cat", "setup-ran.txt"])).stdout.trim()).toBe("installed");
		expect(t.provisioning.environment).toMatchObject({ state: "ready" });

		await s.forge.repoSettings(ada, "acme/app", { setupScript: "echo boom >&2; exit 3" });
		const bad = await s.forge.start(ada, startReq(`setup-${++n}`, { harness: "claude-code" }));
		const port2 = new ScriptedPort([]);
		await s.worker({ turns: { "claude-code": port2 }, prepareWorkspace: prepare }).step(bad.threadId);
		const failed = (await s.store.get(bad.threadId))!;
		// The turn still ran (the start's own input), as v1 went on after a failed setup; what failed stays on the thread for its page.
		expect(port2.calls).toHaveLength(1);
		expect(failed.state).toBe("idle");
		expect(failed.provisioning.environment).toMatchObject({ state: "failed", error: expect.stringContaining("code 3") });
		expect(failed.provisioning.environment.error).toContain("boom");
		const events = (await s.pool.query("select data from pim_forge.forge_events where thread_id = $1 and kind = 'environment.failed'", [bad.threadId])).rows;
		expect(events).toHaveLength(1);
	});

	it("tries a turn that failed for provider trouble once more before it fails, and not one that can never work", async () => {
		const flaky = await s.forge.start(ada, startReq(`flaky-${++n}`, { harness: "claude-code" }));
		const port = new ScriptedPort([{ outcome: "failed", detail: "503 service unavailable" }, { outcome: "completed", text: "worked" }]);
		const w = s.worker({ turns: { "claude-code": port }, retryDelayMs: 60_000 });
		await w.step(flaky.threadId);
		expect(await s.store.get(flaky.threadId)).toMatchObject({ state: "idle", stateReason: "retrying" });
		// It waits for its time, and a sweep before then leaves it be.
		expect(await w.sweep()).toEqual([]);
		await s.pool.query("update pim_forge.forge_inbox set payload = payload || '{\"notBefore\": 0}' where thread_id = $1 and kind = 'retry'", [flaky.threadId]);
		// Nobody was told it failed.
		expect((await s.pool.query("select 1 from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1", [flaky.threadId])).rows).toHaveLength(0);
		await w.step(flaky.threadId);
		expect(port.calls).toHaveLength(2);
		expect(port.calls[1]!.operationId).toBe(`retry-flaky-${n}-1`);
		expect(await s.store.get(flaky.threadId)).toMatchObject({ state: "idle", stateReason: null });
		expect((await s.pool.query("select payload from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1", [flaky.threadId])).rows).toHaveLength(1);

		const dead = await s.forge.start(ada, startReq(`dead-${++n}`, { harness: "claude-code" }));
		await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "failed", detail: "Invalid API key" }]) }, retryDelayMs: 0 }).step(dead.threadId);
		expect(await s.store.get(dead.threadId)).toMatchObject({ state: "failed" });
		// Steering a failed thread goes on with it.
		const port2 = new ScriptedPort([{ outcome: "completed", text: "fixed" }]);
		await s.forge.steer(ada, dead.threadId, "try again", `dead-steer-${n}`);
		expect(await s.store.get(dead.threadId)).toMatchObject({ state: "idle" });
		await s.worker({ turns: { "claude-code": port2 } }).step(dead.threadId);
		expect(port2.calls[0]!.prompt).toContain("try again");
		expect(await s.store.get(dead.threadId)).toMatchObject({ state: "idle", stateReason: null });
	});

	it("a steer that interrupts stops the turn under way and the next turn is the steer's", async () => {
		const { threadId } = await s.forge.start(ada, startReq(`int-${++n}`, { harness: "claude-code" }));
		const port = new ScriptedPort([untilStopped, { outcome: "completed", text: "redone" }]);
		const w = s.worker({ turns: { "claude-code": port } });
		const running = w.step(threadId);
		await waitUntil(async () => port.calls.length === 1);
		await s.forge.steer(ada, threadId, "do this instead", `int-steer-${n}`, { interrupt: true });
		await running;
		expect(port.calls).toHaveLength(2);
		expect(port.calls[1]!.prompt).toContain("do this instead");
		expect(await s.store.get(threadId)).toMatchObject({ state: "idle", cancelState: "none" });
		// The turn that was cut short told nobody; the one that finished did.
		const wakes = (await s.pool.query("select dedupe_key from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1", [threadId])).rows.map((r) => r.dedupe_key);
		expect(wakes).toEqual([`coding:${threadId}:int-steer-${n}`]);
	});
});
