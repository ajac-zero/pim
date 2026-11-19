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

	it("makes a sandbox with the minutes its quota leaves, and gives it back once it has run past them, though it never went idle", async () => {
		await s.pool.query("insert into pim_forge.forge_quotas (subject_type, subject_id, max_session_minutes) values ('user', 'cap', 5)");
		await s.grantAll("cap");
		const cap = { ownerId: "cap", role: "member" as const };
		const real = s.sandboxes;
		const specs: { wallClockMin?: number | null }[] = [];
		const spy: ComputeProvider = { id: "local", find: (tag) => real.find(tag), exec: (h, c, o) => real.exec(h, c, o), destroy: (h) => real.destroy(h), create: (tag, spec) => (specs.push(spec), real.create(tag, spec)) };
		const w = s.worker({ turns: { codex: new ScriptedPort([{ outcome: "completed", text: "done" }]) }, compute: spy });
		const { threadId } = await s.forge.start(cap, startReq("cap-1", { harness: "codex" }));
		await w.step(threadId);
		expect(specs).toMatchObject([{ wallClockMin: 5 }]);
		await s.scheduler.markBusy(threadId);
		s.advance(5 * 60_000 + 30_000);
		expect(await w.reap()).not.toContain(threadId);
		s.advance(60_000);
		expect(await w.reap()).toContain(threadId);
		expect(await s.store.get(threadId)).toMatchObject({ workspaceRef: null });
		expect(await s.scheduler.slots("default")).not.toContain(threadId);
		expect((await s.pool.query("select reason from pim_forge.forge_compute_usage where thread_id = $1", [threadId])).rows[0]).toEqual({ reason: "session_limit" });
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
		expect(t.provisioning.environment).toMatchObject({ state: "cached", readyFrom: "setup" });

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
	it("places a thread that names no pool on the first pool with room by priority, and a provider's pin on that provider's first", async () => {
		await s.scheduler.upsertPool({ poolId: "fast", provider: "local", size: 1, priority: 10 });
		await s.scheduler.upsertPool({ poolId: "spare", provider: "local", size: 1, priority: 5 });
		const placed: string[] = [];
		for (const op of ["place-1", "place-2", "place-3"]) {
			const { threadId } = await s.forge.start(ada, startReq(op, { harness: "claude-code" }));
			await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed", text: "ok" }]) } }).step(threadId);
			placed.push((await s.store.get(threadId))!.placement.pool);
		}
		// "fast" holds one, "spare" one, and the rest overflow to the pool with room (default).
		expect(placed).toEqual(["fast", "spare", "default"]);
		const pinned = await s.forge.start(ada, startReq("place-4", { harness: "claude-code", provider: "local" } as never));
		expect((await s.store.get(pinned.threadId))!.placement).toEqual({ pool: "default" });
		await expect(s.forge.start(ada, startReq("place-5", { harness: "claude-code", provider: "nowhere" } as never))).rejects.toMatchObject({ code: "invalid" });
	});
});

describe("a thread that has stopped gives its sandbox back, and a lost one is made again", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let n = 0;
	beforeEach(async () => {
		s = await stack();
		await s.grantAll("ada");
	});
	afterEach(async () => s.close());
	const host = (...a: string[]) => execFileSync("git", ["--git-dir", s.bare, ...a], { encoding: "utf8" }).trim();
	/** The checkout, as a harness's would make it: the repository cloned on the thread's branch, and the thread's last autosave brought back over it. */
	const prepare = async (t: { threadId: string; branch: string | null }, handle: ComputeHandle) => {
		await s.sandboxes.exec(handle, ["git", "clone", s.bare, "."]);
		await s.sandboxes.exec(handle, ["git", "checkout", "-b", t.branch!]);
		const save = (await s.pool.query("select head_sha, object_key from pim_forge.forge_autosaves where thread_id = $1", [t.threadId])).rows[0];
		const got = save ? await s.objects.get(save.object_key) : null;
		if (got) {
			const file = `${s.sandboxes.workdir(handle)}/../restore.bundle`;
			await (await s.sandboxes.workspace(handle)).writeFile(file, got.body, 0o600);
			await s.sandboxes.exec(handle, ["git", "fetch", file, "HEAD"]);
			await s.sandboxes.exec(handle, ["git", "checkout", "-B", t.branch!, save.head_sha]);
		}
	};
	const editing = (file: string) => async (turn: TurnRequest): Promise<TurnResult> => {
		const h = await s.checkout(turn.threadId);
		await s.sandboxes.exec(h, ["sh", "-c", `echo ${file} > ${file}`]);
		return { outcome: "completed", text: "edited" };
	};
	const wakesOf = async (id: string) => (await s.pool.query("select dedupe_key, payload from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1 order by id", [id])).rows;

	it("a thread that ended failed frees its slot and sandbox after the idle grace, and goes on when continued", async () => {
		const port = new ScriptedPort([{ outcome: "failed", detail: "Invalid API key" }, { outcome: "completed", text: "back" }]);
		const w = s.worker({ turns: { codex: port }, prepareWorkspace: prepare });
		const { threadId } = await s.forge.start(ada, startReq(`fail-${++n}`, { harness: "codex" }));
		await w.step(threadId);
		const first = (await s.store.get(threadId))!;
		expect(first).toMatchObject({ state: "failed", stateReason: "error" });
		expect(await s.scheduler.slots("default")).toContain(threadId);
		s.advance(121_000);
		expect(await w.reap((id) => s.forge.autosave(id))).toContain(threadId);
		// It is still failed, with what it said; the slot, the sandbox and the compute stretch are given back.
		expect(await s.store.get(threadId)).toMatchObject({ state: "failed", stateReason: "error", workspaceRef: null });
		expect(await s.scheduler.slots("default")).not.toContain(threadId);
		expect(s.sandboxes.list()).not.toContain(first.workspaceRef.tag);
		expect((await s.pool.query("select count(*) c from pim_forge.forge_compute_usage where thread_id = $1 and ended_at is null", [threadId])).rows[0]!.c).toBe("0");
		await s.forge.continueThread(ada, threadId, `fail-continue-${n}`);
		await w.step(threadId);
		expect(port.calls).toHaveLength(2);
		expect(await s.store.get(threadId)).toMatchObject({ state: "idle", stateReason: null });
		expect((await s.store.get(threadId))!.workspaceRef).toBeTruthy();
	});

	it("a thread waiting for a login keeps its sandbox for five minutes, then gives it back and goes on once the login is there", async () => {
		const port = new ScriptedPort([{ outcome: "login_required", detail: "Connect your Codex login" }, { outcome: "completed", text: "signed in" }]);
		const w = s.worker({ turns: { codex: port }, prepareWorkspace: prepare });
		const { threadId } = await s.forge.start(ada, startReq(`login-${++n}`, { harness: "codex" }));
		await w.step(threadId);
		expect(await s.store.get(threadId)).toMatchObject({ state: "waiting_input", stateReason: "login_required" });
		s.advance(4 * 60_000);
		expect(await w.reap()).not.toContain(threadId);
		s.advance(61_000);
		expect(await w.reap()).toContain(threadId);
		expect(await s.store.get(threadId)).toMatchObject({ state: "waiting_input", stateReason: "login_required", workspaceRef: null });
		expect(await s.scheduler.slots("default")).not.toContain(threadId);
		expect(await s.forge.resumeAfterLogin("ada", "codex")).toBe(1);
		await w.step(threadId);
		expect(port.calls).toHaveLength(2);
		expect(await s.store.get(threadId)).toMatchObject({ state: "idle" });
	});

	it("a sandbox that is gone is made again for the next turn, with the work restored from its last autosave", async () => {
		const port = new ScriptedPort([editing("one.txt"), { outcome: "completed", text: "second", sessionId: "s-2" }]);
		const w = s.worker({ turns: { "claude-code": port }, prepareWorkspace: prepare });
		const { threadId } = await s.forge.start(ada, startReq(`lost-${++n}`, { harness: "claude-code" }));
		await w.step(threadId);
		const first = (await s.store.get(threadId))!.workspaceRef;
		// The host loses the sandbox (a restart, a lost volume): its tag is no longer found.
		await s.sandboxes.destroy(first);
		const made = s.sandboxes.created.length;
		await s.forge.steer(ada, threadId, "go on", `lost-steer-${n}`);
		await w.step(threadId);
		expect(s.sandboxes.created.length - made).toBe(1);
		expect(port.calls).toHaveLength(2);
		// The work of the first turn was in the new checkout when the second ran.
		expect(await s.sandboxes.exec((await s.store.get(threadId))!.workspaceRef, ["cat", "one.txt"])).toMatchObject({ stdout: "one.txt\n" });
		expect((await s.pool.query("select 1 from pim_forge.forge_events where thread_id = $1 and kind = 'workspace.lost'", [threadId])).rows).toHaveLength(1);
		expect(await s.store.get(threadId)).toMatchObject({ state: "idle", stateReason: null });
		// It kept its slot throughout: one slot, not two.
		expect((await s.scheduler.slots("default")).filter((id) => id === threadId)).toHaveLength(1);
	});

	it("tells the chat that started a thread when it fails before any turn: no sandbox backend, a checkout that failed, a provider that refused, a queue that never moved", async () => {
		const none = await s.forge.start(ada, startReq(`early-${++n}`, { harness: "codex" }));
		await s.worker({ compute: null }).step(none.threadId);
		expect(await s.store.get(none.threadId)).toMatchObject({ state: "failed", stateReason: "no_backend" });
		expect(await wakesOf(none.threadId)).toEqual([expect.objectContaining({ dedupe_key: `coding:${none.threadId}:early-${n}`, payload: expect.objectContaining({ outcome: "failed", summary: expect.stringContaining("no_backend") }) })]);

		const bad = await s.forge.start(ada, startReq(`early-${++n}`, { harness: "codex" }));
		const wc = s.worker({ turns: { codex: new ScriptedPort([]) }, prepareWorkspace: async () => void (() => { throw new Error("git clone failed: 128"); })() });
		await wc.step(bad.threadId);
		const failed = (await s.store.get(bad.threadId))!;
		expect(failed).toMatchObject({ state: "failed", stateReason: "checkout_failed", workspaceRef: null });
		expect(await wakesOf(bad.threadId)).toHaveLength(1);
		// Nothing of it is left to pin: the slot is free and the sandbox is gone.
		expect(await s.scheduler.slots("default")).not.toContain(bad.threadId);
		expect(s.sandboxes.list().filter((tag) => tag === bad.threadId)).toEqual([]);

		const refused = await s.forge.start(ada, startReq(`early-${++n}`, { harness: "codex" }));
		const broken: ComputeProvider = { ...s.sandboxes, id: "local", find: async () => null, create: async () => { throw new Error("manager says no"); }, exec: (h, c, o) => s.sandboxes.exec(h, c, o), destroy: (h) => s.sandboxes.destroy(h) };
		await s.worker({ compute: broken }).step(refused.threadId);
		expect(await s.store.get(refused.threadId)).toMatchObject({ state: "failed", stateReason: "provision_failed" });
		expect(await wakesOf(refused.threadId)).toHaveLength(1);

		// A queue that never moves: the thread waits behind a full pool, is requeued once, and fails with its chat told.
		await s.scheduler.upsertPool({ poolId: "tiny", provider: "local", size: 1 });
		const holder = await s.forge.start(ada, startReq(`early-${++n}`, { harness: "codex", pool: "tiny" }));
		await s.worker({ turns: { codex: new ScriptedPort([]) } }).step(holder.threadId);
		const waiting = await s.forge.start(ada, startReq(`early-${++n}`, { harness: "codex", pool: "tiny" }));
		expect(await s.worker().step(waiting.threadId)).toBe("queued");
		s.advance(31 * 60_000);
		await s.scheduler.promote("tiny");
		s.advance(31 * 60_000);
		await s.scheduler.promote("tiny");
		expect(await s.store.get(waiting.threadId)).toMatchObject({ state: "failed", stateReason: "queue_timeout" });
		expect(await wakesOf(waiting.threadId)).toEqual([expect.objectContaining({ dedupe_key: `coding:${waiting.threadId}:early-${n}` })]);
	});

	it("a thread whose budget is spent when its next input comes fails with its chat told, and a quota refusal does too", async () => {
		const w = s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed", text: "ok", costUsd: 0.1 }]) } });
		const { threadId } = await s.forge.start(ada, startReq(`budget-${++n}`, { harness: "claude-code", budgetUsd: 1 }));
		await w.step(threadId);
		await s.pool.query("update pim_forge.forge_threads set budget_usd = 0.05 where thread_id = $1", [threadId]);
		await s.store.locked(threadId, (q) => s.store.enqueueInbox(q, threadId, `budget-more-${n}`, "steer", { prompt: "more" }));
		await w.step(threadId);
		expect(await s.store.get(threadId)).toMatchObject({ state: "failed", stateReason: "budget" });
		expect((await wakesOf(threadId)).map((r) => r.dedupe_key)).toEqual([`coding:${threadId}:budget-${n}`, `coding:${threadId}:budget-more-${n}`]);

		await s.pool.query("insert into pim_forge.forge_quotas values ('user', 'ada', 1, null, null) on conflict (subject_type, subject_id) do update set max_concurrent = 1");
		const over = await s.forge.start(ada, startReq(`quota-${++n}`, { harness: "claude-code" }));
		await s.worker({ turns: { "claude-code": new ScriptedPort([]) } }).step(over.threadId);
		expect(await s.store.get(over.threadId)).toMatchObject({ state: "failed", stateReason: "compute_quota" });
		expect(await wakesOf(over.threadId)).toHaveLength(1);
		await s.pool.query("delete from pim_forge.forge_quotas where subject_id = 'ada'");
	});

	it("a host with no room keeps the thread waiting, provisioning, and is asked again after a while, instead of failing it", async () => {
		const { ForgeError } = await import("../src/errors");
		let asked = 0;
		const full: ComputeProvider = { ...s.sandboxes, id: "local", find: (tag) => s.sandboxes.find(tag), create: async () => (asked++, Promise.reject(new ForgeError("conflict", "low_disk: 9% of the disk free"))), exec: (h, c, o) => s.sandboxes.exec(h, c, o), destroy: (h) => s.sandboxes.destroy(h) };
		const w = s.worker({ compute: full, turns: { codex: new ScriptedPort([]) } });
		const { threadId } = await s.forge.start(ada, startReq(`disk-${++n}`, { harness: "codex" }));
		expect(await w.step(threadId)).toBe("retry");
		expect(await s.store.get(threadId)).toMatchObject({ state: "provisioning", stateReason: "low_disk" });
		expect(await w.step(threadId)).toBe("retry");
		expect(asked).toBe(1);
		s.advance(31_000);
		expect(await w.step(threadId)).toBe("retry");
		expect(asked).toBe(2);
		expect(await s.scheduler.slots("default")).toContain(threadId);
	});

	it("a CLI turn that stalls is continued once by itself, resuming its session", async () => {
		const stalled = { outcome: "failed" as const, detail: "The turn made no progress for 10 minutes, so it was stopped", sessionId: "s-stall" };
		const port = new ScriptedPort([stalled, stalled]);
		const w = s.worker({ turns: { "claude-code": port }, retryDelayMs: 0 });
		const { threadId } = await s.forge.start(ada, startReq(`stall-${++n}`, { harness: "claude-code" }));
		await w.step(threadId);
		expect(port.calls).toHaveLength(2);
		expect(port.calls[1]).toMatchObject({ operationId: `retry-stall-${n}-1`, sessionId: "s-stall", resume: true });
		// Once: the continuation's own stall is not continued again, and the chat hears of it.
		expect(await s.store.get(threadId)).toMatchObject({ state: "failed" });
		expect(await wakesOf(threadId)).toHaveLength(1);
	});

	it("pushes and merges a thread whose sandbox was given back: from the host when it already holds the work, else from a sandbox made again", async () => {
		const w = s.worker({ turns: { "claude-code": new ScriptedPort([editing("kept.txt"), editing("late.txt")]) }, prepareWorkspace: prepare, autopush: true });
		const { threadId } = await s.forge.start(ada, startReq(`ship-${++n}`, { harness: "claude-code" }));
		await w.step(threadId);
		const t = (await s.store.get(threadId))!;
		expect(host("show", `${t.branch}:kept.txt`)).toBe("kept.txt");
		s.advance(121_000);
		expect(await w.reap((id) => s.forge.autosave(id))).toContain(threadId);
		const made = s.sandboxes.created.length;
		// The branch on the host is the thread's work: nothing is brought back to push or merge it.
		expect(await s.forge.push(ada, threadId)).toMatchObject({ status: "done", outcome: "unchanged", sha: host("rev-parse", `refs/heads/${t.branch}`) });
		expect(await s.forge.merge(ada, threadId)).toMatchObject({ status: "done", outcome: "merged" });
		expect(host("show", "main:kept.txt")).toBe("kept.txt");
		expect(s.sandboxes.created.length).toBe(made);

		// Work that never reached the host is pushed from a sandbox the worker makes again, which restores it from the autosave.
		await s.forge.steer(ada, threadId, "more", `ship-steer-${n}`);
		await w.step(threadId);
		const h = (await s.store.get(threadId))!;
		await s.sandboxes.exec(h.workspaceRef, ["git", "remote", "set-url", "origin", "/nowhere.git"]);
		await s.store.locked(threadId, (q) => s.store.patch(q, threadId, { last_pushed_sha: null }));
		await s.sandboxes.exec(h.workspaceRef, ["sh", "-c", "echo three > three.txt"]);
		s.advance(121_000);
		expect(await w.reap((id) => s.forge.autosave(id))).toContain(threadId);
		expect((await s.store.get(threadId))!.workspaceRef).toBeNull();
		const sweeping = setInterval(() => void w.dispatch().catch(() => {}), 50);
		try {
			const pushed = await s.forge.push(ada, threadId);
			expect(pushed).toMatchObject({ status: "done", outcome: "pushed" });
			expect(host("show", `${h.branch}:three.txt`)).toBe("three");
		} finally {
			clearInterval(sweeping);
		}
		// The thread is as it was: idle, with a sandbox that goes again after the grace.
		await w.drain();
		expect(await s.store.get(threadId)).toMatchObject({ state: "idle" });
	});

	it("brings a failed thread's sandbox back to push it, and leaves the thread failed", async () => {
		const w = s.worker({ turns: { "claude-code": new ScriptedPort([async (turn) => ({ ...(await editing("half.txt")(turn)), outcome: "failed", detail: "Invalid API key" } as TurnResult)]) }, prepareWorkspace: prepare });
		const { threadId } = await s.forge.start(ada, startReq(`failed-ship-${++n}`, { harness: "claude-code" }));
		await w.step(threadId);
		s.advance(121_000);
		expect(await w.reap((id) => s.forge.autosave(id))).toContain(threadId);
		expect(await s.store.get(threadId)).toMatchObject({ state: "failed", workspaceRef: null });
		const sweeping = setInterval(() => void w.dispatch().catch(() => {}), 50);
		try {
			expect(await s.forge.push(ada, threadId)).toMatchObject({ status: "done", outcome: "pushed" });
		} finally {
			clearInterval(sweeping);
		}
		await w.drain();
		const t = (await s.store.get(threadId))!;
		expect(t).toMatchObject({ state: "failed", stateReason: "error", stateDetail: "Invalid API key" });
		expect(host("show", `${t.branch}:half.txt`)).toBe("half.txt");
	});
});
