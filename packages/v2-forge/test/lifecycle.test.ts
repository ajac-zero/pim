import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "../src/errors";
import { MAX_TOKEN_TTL_MS } from "../src/tokens";
import { ESCALATED_STALL_MS } from "../src/stall";
import { ada, REPO, ScriptedPort, startReq, stack } from "./stack";

const host = (s: Awaited<ReturnType<typeof stack>>, ...a: string[]) => execFileSync("git", ["--git-dir", s.bare, ...a], { encoding: "utf8" }).trim();

describe("push, pull request, merge and archive", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let n = 0;
	/** A started, provisioned thread with one commit in its checkout. */
	const ready = async (file = "a.txt", content = "a") => {
		const { threadId } = await s.forge.start(ada, startReq(`life-${++n}`, { harness: "claude-code" }));
		await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed", text: "ok" }]) } }).step(threadId);
		await s.commit(threadId, file, content);
		return threadId;
	};
	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
	});
	afterAll(async () => s.close());

	it("pushes only pim/* branches, reports unchanged the second time, and refuses the default branch", async () => {
		const id = await ready();
		const t = (await s.store.get(id))!;
		expect(t.branch).toMatch(/^pim\/fix-the-login-bug-[0-9a-f]{8}$/);
		const r = await s.forge.push(ada, id);
		expect(r).toMatchObject({ status: "done", outcome: "pushed", branch: t.branch });
		expect(host(s, "rev-parse", `refs/heads/${t.branch}`)).toBe((r as any).sha);
		expect(await s.forge.push(ada, id)).toMatchObject({ outcome: "unchanged" });
		expect((await s.store.get(id))!.lastPushedSha).toBe((r as any).sha);
		// Even if a thread's branch were ever main (or outside the prefix), Pim refuses to push there.
		for (const bad of ["main", "release/1.0"]) {
			await s.pool.query("update pim_forge.forge_threads set branch = $2 where thread_id = $1", [id, bad]);
			await expect(s.forge.push(ada, id)).rejects.toMatchObject({ code: "push_refused" });
		}
		expect(host(s, "rev-parse", "refs/heads/main")).not.toBe((r as any).sha);
		await s.pool.query("update pim_forge.forge_threads set branch = $2 where thread_id = $1", [id, t.branch]);
	});

	it("opens a pull request only once the branch is on the host", async () => {
		const id = await ready("b.txt", "b");
		await expect(s.forge.openPullRequest(ada, id)).rejects.toMatchObject({ code: "not_pushed" });
		await s.forge.push(ada, id);
		const pr = await s.forge.openPullRequest(ada, id, "Fix it");
		expect(pr).toMatchObject({ status: "done", url: expect.stringContaining("/pull/") });
		expect((await s.store.get(id))!.pullRequest).toMatchObject({ number: (pr as any).number });
	});

	it("merges by fast-forward, by rebase when the default moved, and aborts a conflict leaving main alone", async () => {
		// Both are cloned from the same main, before either merges.
		const a = await ready("m1.txt", "one");
		const b = await ready("m2.txt", "two");
		const ff = await s.forge.merge(ada, a);
		expect(ff).toMatchObject({ status: "done", outcome: "merged", method: "fast-forward" });
		expect(host(s, "show", "main:m1.txt")).toBe("one");

		// main moved under b (a's merge), so b must rebase.
		const rebased = await s.forge.merge(ada, b);
		expect(rebased).toMatchObject({ outcome: "merged", method: "rebase" });
		expect(host(s, "show", "main:m1.txt")).toBe("one");
		expect(host(s, "show", "main:m2.txt")).toBe("two");

		// A conflicting edit of the same file.
		const c = await ready("conflict.txt", "from-c");
		const d = await ready("conflict.txt", "from-d");
		expect(await s.forge.merge(ada, c)).toMatchObject({ outcome: "merged" });
		const mainBefore = host(s, "rev-parse", "main");
		const lost = await s.forge.merge(ada, d);
		expect(lost).toMatchObject({ status: "done", outcome: "conflict" });
		expect(host(s, "rev-parse", "main")).toBe(mainBefore);
		// The checkout is left clean for the thread to fix, not stuck mid-rebase.
		const dws = (await s.store.get(d))!.workspaceRef;
		expect((await s.sandboxes.exec(dws, ["git", "status", "--porcelain=v2", "--branch"])).stdout).not.toContain("rebase");
	});

	it("separates permission from approval, and an agent can't approve its own request", async () => {
		const bo = { ownerId: "bo", role: "member" as const };
		await s.grantAll("bo", { requiresApproval: true });
		const { threadId } = await s.forge.start(bo, startReq("bo-1", { harness: "claude-code" }));
		await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed" }]) } }).step(threadId);
		await s.commit(threadId, "z.txt", "z");
		const pending = await s.forge.push(bo, threadId);
		expect(pending).toMatchObject({ status: "approval_required" });
		const approvalId = (pending as any).approvalId;
		// Same push again is the same approval.
		expect(await s.forge.push(bo, threadId)).toMatchObject({ approvalId });
		await expect(s.authz.decide(approvalId, { ...bo, agent: "helper" }, true)).rejects.toBeInstanceOf(ForbiddenError);
		await expect(s.authz.decide(approvalId, ada, true)).rejects.toBeInstanceOf(ForbiddenError);
		await s.authz.decide(approvalId, bo, true);
		expect(await s.forge.push(bo, threadId)).toMatchObject({ status: "done", outcome: "pushed" });
		// The approval was spent: the next push asks again.
		await s.commit(threadId, "z2.txt", "z2");
		expect(await s.forge.push(bo, threadId)).toMatchObject({ status: "approval_required" });
	});

	it("honors a standing merge grant for an agent and denies it once revoked", async () => {
		const zed = { ownerId: "zed", role: "member" as const, agent: "linus" };
		// A merge grant is not a start grant: starting still needs its own.
		await expect(s.forge.start(zed, startReq("zed-0", { harness: "claude-code" }))).rejects.toBeInstanceOf(ForbiddenError);
		await s.authz.grant({ subjectType: "user", subjectId: "zed", permission: "coding:start", grantedBy: "admin" });
		const standing = await s.authz.grant({ subjectType: "agent", subjectId: "linus", permission: "coding:merge", repos: ["acme/app"], standing: true, grantedBy: "admin" });
		const { threadId } = await s.forge.start(zed, startReq("zed-1", { harness: "claude-code" }));
		await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed" }]) } }).step(threadId);
		await s.commit(threadId, "st.txt", "st");
		expect(await s.forge.merge(zed, threadId)).toMatchObject({ status: "done", outcome: "merged" });
		await s.authz.revoke(standing);
		await s.commit(threadId, "st2.txt", "st2");
		await expect(s.forge.merge(zed, threadId)).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("revoking a grant blocks the very next privileged action on an existing thread", async () => {
		const id = await ready("rv.txt", "rv");
		const grants = await s.pool.query("select grant_id, permission from pim_forge.forge_grants where subject_id = 'ada'").then((r) => Object.fromEntries(r.rows.map((g) => [g.permission, g.grant_id as number])));
		await s.authz.revoke(grants["coding:push"]!);
		await expect(s.forge.push(ada, id)).rejects.toBeInstanceOf(ForbiddenError);
		await s.authz.revoke(grants["coding:merge"]!);
		await expect(s.forge.merge(ada, id)).rejects.toBeInstanceOf(ForbiddenError);
		await s.authz.revoke(grants["coding:steer"]!);
		await expect(s.forge.steer(ada, id, "x", "rv-steer")).rejects.toBeInstanceOf(ForbiddenError);
		// Reading one's own transcript needs no grant.
		await expect(s.forge.transcript(ada, id)).resolves.toBeTruthy();
	});
});

describe("credentials, archive and cancellation", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let n = 0;
	const ready = async () => {
		const { threadId } = await s.forge.start(ada, startReq(`cred-${++n}`, { harness: "codex" }));
		await s.worker({ turns: { codex: new ScriptedPort([{ outcome: "completed", text: "hi" }]) } }).step(threadId);
		return (await s.store.get(threadId))!;
	};
	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
	});
	afterAll(async () => s.close());

	it("scopes a pimgit_ token to a repository and operation, and refuses pushes outside pim/*", async () => {
		const t = await ready();
		const read = s.credentials.gitToken(t, { repo: REPO, scope: "read" });
		expect(read.startsWith("pimgit_")).toBe(true);
		await expect(s.credentials.verifyGit(read, { repo: REPO, op: "fetch" })).resolves.toMatchObject({ threadId: t.threadId });
		await expect(s.credentials.verifyGit(read, { repo: "https://github.com/acme/other", op: "fetch" })).rejects.toBeInstanceOf(ForbiddenError);
		await expect(s.credentials.verifyGit(read, { repo: REPO, op: "push", branch: t.branch! })).rejects.toMatchObject({ code: "push_refused" });
		const push = s.credentials.gitToken(t, { repo: REPO, scope: "push" });
		await expect(s.credentials.verifyGit(push, { repo: REPO, op: "push", branch: t.branch! })).resolves.toBeTruthy();
		await expect(s.credentials.verifyGit(push, { repo: REPO, op: "push", branch: "main", defaultBranch: "main" })).rejects.toMatchObject({ code: "push_refused" });
		await expect(s.credentials.verifyGit(push, { repo: REPO, op: "push", branch: "feature/x" })).rejects.toMatchObject({ code: "push_refused" });
		// Tampered or foreign tokens fail.
		await expect(s.credentials.verifyGit(push.slice(0, -2) + "xx", { repo: REPO, op: "fetch" })).rejects.toBeInstanceOf(ForbiddenError);
		await expect(s.credentials.verifyGateway(push, "anthropic")).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("caps lifetime at 12 hours and expires", async () => {
		const t = await ready();
		const long = s.credentials.gitToken(t, { repo: REPO, scope: "read", ttlMs: 100 * 3_600_000 });
		s.advance(MAX_TOKEN_TTL_MS - 1000);
		await expect(s.credentials.verifyGit(long, { repo: REPO, op: "fetch" })).resolves.toBeTruthy();
		s.advance(2000);
		await expect(s.credentials.verifyGit(long, { repo: REPO, op: "fetch" })).rejects.toMatchObject({ message: expect.stringContaining("expired") });
	});

	it("abort, suspension and archive each cut off git and gateway tokens immediately", async () => {
		// Aborted.
		let t = await ready();
		let git = s.credentials.gitToken(t, { repo: REPO, scope: "push" });
		let gw = s.credentials.gatewayToken(t, { families: ["anthropic"] });
		await expect(s.credentials.verifyGateway(gw, "anthropic")).resolves.toBeTruthy();
		await expect(s.credentials.verifyGateway(gw, "openai")).rejects.toBeInstanceOf(ForbiddenError);
		await s.forge.abort(ada, t.threadId);
		await expect(s.credentials.verifyGit(git, { repo: REPO, op: "fetch" })).rejects.toBeInstanceOf(ForbiddenError);
		await expect(s.credentials.verifyGateway(gw, "anthropic")).rejects.toBeInstanceOf(ForbiddenError);

		// Suspended: no nonce rotation needed; the owner's state is read on every use.
		t = await ready();
		git = s.credentials.gitToken(t, { repo: REPO, scope: "read" });
		gw = s.credentials.gatewayToken(t, { families: ["openai"] });
		await s.authz.setSuspended("ada", true);
		await expect(s.credentials.verifyGit(git, { repo: REPO, op: "fetch" })).rejects.toMatchObject({ message: expect.stringContaining("suspended") });
		await expect(s.credentials.verifyGateway(gw, "openai")).rejects.toBeInstanceOf(ForbiddenError);
		await s.authz.setSuspended("ada", false);
		await expect(s.credentials.verifyGit(git, { repo: REPO, op: "fetch" })).resolves.toBeTruthy();

		// Archived.
		t = await ready();
		git = s.credentials.gitToken(t, { repo: REPO, scope: "read" });
		await s.forge.archive(ada, t.threadId);
		await expect(s.credentials.verifyGit(git, { repo: REPO, op: "fetch" })).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("archive stops the turn and deletes compute, but transcript, diff and tests stay readable; teardown, artifacts and the remote branch are separate operations", async () => {
		const t = await ready();
		await s.commit(t.threadId, "keep.txt", "keep");
		const live = await s.forge.diff(ada, t.threadId);
		expect(live).toMatchObject({ source: "workspace", unpushedOrb: false });
		// What the agent committed is the thread's work, as v1's diff from the base showed it.
		expect(live.diff).toContain("+keep");
		expect(live.head).toBeTruthy();
		await s.sandboxes.exec(t.workspaceRef, ["sh", "-c", "echo wip > wip.txt"]);
		expect((await s.forge.diff(ada, t.threadId)).diff).toContain("+wip");
		expect(await s.forge.runTests(ada, t.threadId, ["sh", "-c", "echo ok && exit 0"])).toMatchObject({ exitCode: 0 });
		await s.forge.autosave(t.threadId);
		const auto = (await s.pool.query("select * from pim_forge.forge_autosaves where thread_id = $1", [t.threadId])).rows[0];
		expect(auto.object_key).toMatch(/^forge\/.*\.bundle$/);
		expect(s.objects.map.get(auto.object_key)!.bytes.length).toBe(Number(auto.bytes));
		await s.forge.push(ada, t.threadId);
		const branch = t.branch!;

		await s.forge.archive(ada, t.threadId);
		const after = (await s.store.get(t.threadId))!;
		expect(after).toMatchObject({ state: "archived" });
		expect(after.computeTornDownAt).toBeTruthy();
		expect(s.sandboxes.list().some((tag) => tag.includes(t.threadId))).toBe(false);
		expect(await s.scheduler.slots("default")).not.toContain(t.threadId);
		expect((await s.forge.transcript(ada, t.threadId)).events.length).toBeGreaterThan(0);
		expect((await s.forge.diff(ada, t.threadId)).diff).toContain("+wip");
		expect(await s.forge.tests(ada, t.threadId)).toHaveLength(1);
		await expect(s.forge.steer(ada, t.threadId, "again", "arch-steer")).rejects.toMatchObject({ code: "archived" });
		// Archiving never touched the remote branch or the stored bundle.
		expect(host(s, "rev-parse", `refs/heads/${branch}`)).toBeTruthy();
		expect(s.objects.map.has(auto.object_key)).toBe(true);
		await s.forge.deleteArtifacts(ada, t.threadId);
		expect(s.objects.map.has(auto.object_key)).toBe(false);
		await s.forge.deleteRemoteBranch(ada, t.threadId);
		expect(() => host(s, "rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
	});

	it("a running turn cancelled on another worker settles cancelled, not completed", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let entered!: () => void;
		const inTurn = new Promise<void>((r) => (entered = r));
		const { threadId } = await s.forge.start(ada, startReq(`cancel-${++n}`, { harness: "claude-code" }));
		const port = new ScriptedPort([async () => ((entered(), await gate), { outcome: "completed", text: "too late", costUsd: 1 })]);
		const running = s.worker({ turns: { "claude-code": port } }).step(threadId);
		await inTurn;
		expect(await s.forge.abort(ada, threadId)).toEqual({ cancelState: "requested" });
		release();
		await running;
		expect(await s.store.get(threadId)).toMatchObject({ state: "idle", stateReason: "aborted", cancelState: "cancelled" });
		const wakes = await s.pool.query("select 1 from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1", [threadId]);
		expect(wakes.rows).toHaveLength(0);
	});
});

describe("stall supervision and the outbox", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	beforeEach(async () => {
		s = await stack();
		await s.grantAll("ada");
	});
	afterEach(async () => s.close());

	const running = async (op: string) => {
		const { threadId } = await s.forge.start(ada, startReq(op, { harness: "amp" }));
		await s.worker().step(threadId);
		return threadId;
	};
	const stallWakes = async (id: string) => (await s.pool.query("select dedupe_key from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1 and payload ->> 'kind' = 'stall' order by id", [id])).rows.map((r) => r.dedupe_key as string);

	it("wakes the originating chat once per quiet spell and escalates once after 45 minutes", async () => {
		const id = await running("stall-1");
		expect(await s.stall.check(id)).toBe(0);
		s.advance(16 * 60_000);
		expect(await s.stall.check(id)).toBe(1);
		expect(await s.stall.check(id)).toBe(0);
		expect((await stallWakes(id))).toHaveLength(1);
		expect((await stallWakes(id))[0]).toMatch(new RegExp(`^stall:${id}:1:\\d+$`));
		s.advance(ESCALATED_STALL_MS);
		expect(await s.stall.check(id)).toBe(2);
		expect(await s.stall.check(id)).toBe(0);
		expect(await stallWakes(id)).toHaveLength(2);
		// New progress starts a new spell.
		await s.store.locked(id, (q) => s.store.appendEvent(q, id, { kind: "message", role: "assistant", data: { text: "alive" } }));
		s.advance(16 * 60_000 + 60_000);
		expect(await s.stall.check(id)).toBe(1);
	});

	it("never wakes for a quiet status or wait tool inside its own wait, but does for a command past its timeout", async () => {
		const id = await running("stall-2");
		await s.journal.begin(id, "wait-1", "coding_status", { timeoutMs: null });
		s.advance(10 * 60_000);
		expect(await s.stall.check(id)).toBe(0);
		await s.journal.begin(id, "bash-1", "bash", { timeoutMs: 60_000 });
		s.advance(30_000);
		expect(await s.stall.check(id)).toBe(0);
		s.advance(31_000);
		expect(await s.stall.check(id)).toBe(1);
		await s.journal.end(id, "bash-1", { ok: true });
		await s.journal.end(id, "wait-1", { ok: true });
	});

	it("hands each outbox row to one consumer exactly once, even with competing deliverers", async () => {
		await running("outbox-1");
		const seen: string[] = [];
		const deliver = async (r: { dedupeKey: string }) => void seen.push(r.dedupeKey);
		await Promise.all([s.forge.deliverOutbox(deliver), s.forge.deliverOutbox(deliver), s.forge.deliverOutbox(deliver)]);
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen.length).toBeGreaterThan(0);
		expect(await s.forge.deliverOutbox(deliver)).toBe(0);
	});
});
