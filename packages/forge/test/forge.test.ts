import { randomUUID } from "node:crypto";
import { claudeCode } from "@pim/coding/harness/claude-code";
import { FakeOrbClient } from "@pim/coding/orb/fake";
import { FakeWorkspaceProvider } from "@pim/coding/workspace/fake";
import type { WorkspaceSpec } from "@pim/coding/workspace/types";
import { type Actor, Forbidden, createGrant, revokeGrant } from "@pim/core/authz";
import { withTenant } from "@pim/core/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Forge } from "../src/forge.ts";
import { claudeLines } from "../../coding/test/support/claude-code.ts";
import { createTestDb, type TestDb } from "../../core/test/support/db.ts";
import { tenantWithPeople } from "../../core/test/support/people.ts";

let db: TestDb;
beforeAll(async () => {
	db = await createTestDb();
});
afterAll(async () => db.close());

const until = async (read: () => Promise<boolean>, what: string) => {
	for (let i = 0; i < 400; i++) {
		if (await read()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`Timed out waiting for ${what}`);
};

/** A provider whose workspaces start with the repository checked out, as a real provider's do. */
class RepoProvider extends FakeWorkspaceProvider {
	override async create(spec: WorkspaceSpec) {
		const ref = await super.create(spec);
		await (await this.get(ref))!.writeFile("/workspace/repo/.keep", Buffer.from(""));
		return ref;
	}
}

function forgeWith(provider: FakeWorkspaceProvider = new RepoProvider(), orb = new FakeOrbClient(), maxEvents?: number) {
	const forge = new Forge({
		pool: db.runtime,
		authz: db.gate,
		workspaces: provider,
		orb,
		harnesses: { "claude-code": claudeCode },
		authFor: () => ({ mode: "env", env: { ANTHROPIC_API_KEY: "sk-test-key" }, secrets: ["sk-test-key"] }),
		workspaceSpec: ({ opId, repo, branch }): WorkspaceSpec => ({ sessionId: `placeholder-${opId}`, image: "fake", repo: { url: repo, ref: "main", branch }, limits: { cpu: 1, memMiB: 512, diskMiB: 512, pids: 64, wallClockMin: null }, egress: { allow: [] }, gitAuth: { mode: "none" } }),
		maxEvents,
	});
	return { forge, provider, orb };
}
// The workspace's session id must be the Forge's, so that a retry finds its own workspace.
const withSession = (forge: Forge) => {
	const original = forge.deps.workspaceSpec;
	(forge.deps as { workspaceSpec: typeof original }).workspaceSpec = (input) => ({ ...original(input), sessionId: forge.sessionOf(input.tenantId, input.opId) });
	return forge;
};

async function setup() {
	const t = await tenantWithPeople(db);
	const admin = await t.login("admin");
	const ada = await t.login("ada");
	await createGrant(db.gate, admin, { grantId: "g-code", subjectUser: "ada", kind: "coding", pools: ["pool-a"], repos: ["org/app"] });
	const actor: Actor = { principal: ada };
	return { t, admin, ada, actor };
}
const req = (opId: string) => ({ opId, harness: "claude-code" as const, repo: "org/app", pool: "pool-a", task: "fix the bug", budgetUsd: 5 });

describe("Forge: authority", () => {
	it("starts nothing without an explicit grant: no workspace, no operation, no run", async () => {
		const t = await tenantWithPeople(db);
		const ada = await t.login("ada");
		const { forge, provider } = forgeWith();
		withSession(forge);
		await expect(forge.start({ principal: ada }, req("op-denied"))).rejects.toBeInstanceOf(Forbidden);
		expect(await provider.list()).toEqual([]);
		const rows = await withTenant(db.maint, t.tenantId, (q) => q.get<{ n: number }>("SELECT (SELECT count(*) FROM app.external_ops)::int + (SELECT count(*) FROM app.coding_runs)::int AS n"));
		expect(rows?.n).toBe(0);
	});

	it("is limited to granted repositories and pools, and by run quota, with the denial audited", async () => {
		const s = await setup();
		const { forge } = forgeWith();
		withSession(forge);
		await expect(forge.start(s.actor, { ...req("o1"), repo: "org/secret" })).rejects.toThrow(/repository/);
		await expect(forge.start(s.actor, { ...req("o2"), pool: "pool-b" })).rejects.toThrow(/pool/);
		await createGrant(db.gate, s.admin, { grantId: "g-once", subjectUser: "gus", kind: "coding", pools: ["p"], quotaRuns: 1 });
		const gus = await s.t.login("gus");
		const provider = new RepoProvider();
		provider.register("claude", () => ({ stdout: `${claudeLines("turn").join("\n")}\n` }));
		const g = forgeWith(provider);
		withSession(g.forge);
		await g.forge.start({ principal: gus }, { ...req("q1"), pool: "p" });
		await expect(g.forge.start({ principal: gus }, { ...req("q2"), pool: "p" })).rejects.toThrow(/quota/);
		const audit = await withTenant(db.maint, s.t.tenantId, (q) => q.all<{ outcome: string }>("SELECT outcome FROM app.audit WHERE action = 'coding.run' ORDER BY audit_id"));
		expect(audit.some((a) => a.outcome.startsWith("denied:"))).toBe(true);
	});

	it("stops the runs a grant authorized when it is revoked", async () => {
		const s = await setup();
		const provider = new RepoProvider();
		provider.register("claude", async ({ killed }) => {
			await killed;
			return { code: 130 };
		});
		const { forge } = forgeWith(provider);
		withSession(forge);
		await forge.start(s.actor, req("rev1"));
		await until(async () => forge.driving.size === 1, "the run to be driven");
		await revokeGrant(db.gate, s.admin, "g-code");
		expect(await forge.onGrantRevoked(s.t.tenantId, "g-code", s.actor)).toEqual(["rev1"]);
		const run = await withTenant(db.maint, s.t.tenantId, (q) => q.get<{ state: string }>("SELECT state FROM app.coding_runs WHERE op_id = 'rev1'"));
		expect(run?.state).toBe("cancelled");
		await expect(forge.start(s.actor, req("rev2"))).rejects.toBeInstanceOf(Forbidden);
	});
});

describe("Forge: lifecycle", () => {
	it("runs a Claude Code turn through the real harness parser, keeps its events, records the handle first and the cost on the grant", async () => {
		const s = await setup();
		const provider = new RepoProvider();
		provider.register("claude", () => ({ stdout: `${claudeLines("turn").join("\n")}\n` }));
		const { forge } = forgeWith(provider);
		withSession(forge);
		const started = await forge.start(s.actor, req("run1"));
		expect(started.state).toBe("succeeded");
		const op = await withTenant(db.maint, s.t.tenantId, (q) => q.get<{ handle: { sessionId: string }; kind: string }>("SELECT handle, kind FROM app.external_ops WHERE op_id = 'run1'"));
		expect(op?.kind).toBe("coding.run");
		expect(op?.handle.sessionId).toBe(forge.sessionOf(s.t.tenantId, "run1"));
		await until(async () => (await withTenant(db.maint, s.t.tenantId, (q) => q.get<{ state: string }>("SELECT state FROM app.coding_runs WHERE op_id = 'run1'")))?.state === "done", "the run to finish");
		const events = await withTenant(db.maint, s.t.tenantId, (q) => q.all<{ kind: string }>("SELECT kind FROM app.coding_events WHERE op_id = 'run1' ORDER BY cursor"));
		expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["session", "assistant", "result"]));
		const run = await withTenant(db.maint, s.t.tenantId, (q) => q.get<{ cost_usd: string }>("SELECT cost_usd FROM app.coding_runs WHERE op_id = 'run1'"));
		expect(Number(run?.cost_usd)).toBeGreaterThan(0);
		const grant = await withTenant(db.maint, s.t.tenantId, (q) => q.get<{ spent_cents: number }>("SELECT spent_cents FROM app.execution_grants WHERE tenant_id = $1 AND grant_id = 'g-code'", s.t.tenantId));
		expect(grant?.spent_cents).toBeGreaterThan(0);
		// The API key the CLI ran with is in no event.
		const text = JSON.stringify(await withTenant(db.maint, s.t.tenantId, (q) => q.all("SELECT payload FROM app.coding_events")));
		expect(text).not.toContain("sk-test-key");
	});

	it("never starts a second run for the same operation, even asked twice", async () => {
		const s = await setup();
		const provider = new RepoProvider();
		let starts = 0;
		provider.register("claude", () => {
			starts++;
			return { stdout: `${claudeLines("turn").join("\n")}\n` };
		});
		const { forge } = forgeWith(provider);
		withSession(forge);
		await forge.start(s.actor, req("dup"));
		await until(async () => forge.driving.size === 0, "the first to finish");
		await forge.start(s.actor, req("dup"));
		await new Promise((r) => setTimeout(r, 200));
		expect(starts).toBe(1);
		expect((await provider.list()).length).toBe(1);
	});

	it("after a lost process, adopts nothing blindly: the CLI is stopped, the run is interrupted, and nothing is started again", async () => {
		const s = await setup();
		const provider = new RepoProvider();
		let starts = 0;
		provider.register("claude", async ({ killed }) => {
			starts++;
			await killed;
			return { code: 137 };
		});
		const first = forgeWith(provider);
		withSession(first.forge);
		await first.forge.start(s.actor, req("lost1"));
		await until(async () => starts === 1, "the CLI to start");
		// A new process: it has no in-memory driver for the run.
		const second = forgeWith(provider);
		withSession(second.forge);
		const result = await second.forge.reconcile(s.t.tenantId);
		expect(result.interrupted).toEqual(["lost1"]);
		const run = await withTenant(db.maint, s.t.tenantId, (q) => q.get<{ state: string; result: { reason: string } }>("SELECT state, result FROM app.coding_runs WHERE op_id = 'lost1'"));
		expect(run?.state).toBe("interrupted");
		expect(starts).toBe(1);
		expect((await provider.list()).length).toBe(1);
		await first.forge.cancel(s.actor, "lost1").catch(() => undefined);
	});

	it("adopts a running Amp thread by its handle after a restart and never starts a second remote agent", async () => {
		const s = await setup();
		await createGrant(db.gate, s.admin, { grantId: "g-amp", subjectUser: "ada", kind: "coding", pools: ["pool-a"] });
		const orb = new FakeOrbClient();
		const first = forgeWith(new RepoProvider(), orb);
		const amp = { ...req("amp1"), harness: "amp" as const };
		await first.forge.start(s.actor, amp);
		expect(orb.started.length).toBe(1);
		const second = forgeWith(new RepoProvider(), orb);
		// Even a retry of the start, as a restarted caller would send, is the same thread.
		await second.forge.start(s.actor, amp);
		expect(orb.started.length).toBe(1);
		const adopted = await second.forge.reconcile(s.t.tenantId);
		expect(adopted.adopted.length + (await withTenant(db.maint, s.t.tenantId, (q) => q.all("SELECT 1 FROM app.coding_runs WHERE op_id = 'amp1' AND state = 'done'"))).length).toBeGreaterThan(0);
		expect(orb.started.length).toBe(1);
	});

	it("reports a cancel the other side may not have honored as uncertain", async () => {
		const s = await setup();
		await createGrant(db.gate, s.admin, { grantId: "g-amp2", subjectUser: "ada", kind: "coding", pools: ["pool-a"] });
		const orb = new FakeOrbClient();
		orb.cancel = async () => {
			throw new Error("network");
		};
		const { forge } = forgeWith(new RepoProvider(), orb);
		await forge.start(s.actor, { ...req("amp-c"), harness: "amp" });
		expect(await forge.cancel(s.actor, "amp-c")).toBe("cancel_uncertain");
	});

	it("keeps a transcript flood bounded", async () => {
		const s = await setup();
		const provider = new RepoProvider();
		const noisy = claudeLines("turn");
		provider.register("claude", () => ({ stdout: `${Array.from({ length: 40 }, () => noisy).flat().join("\n")}\n` }));
		const { forge } = forgeWith(provider, new FakeOrbClient(), 30);
		withSession(forge);
		await forge.start(s.actor, req("flood"));
		await until(async () => (await withTenant(db.maint, s.t.tenantId, (q) => q.get<{ state: string }>("SELECT state FROM app.coding_runs WHERE op_id = 'flood'")))?.state !== "running", "the flood to end");
		const stats = await withTenant(db.maint, s.t.tenantId, (q) => q.get<{ n: number; dropped: number; cursor: number }>("SELECT (SELECT count(*) FROM app.coding_events WHERE op_id = 'flood')::int AS n, dropped::int, cursor::int FROM app.coding_runs WHERE op_id = 'flood'"));
		expect(stats!.n).toBeLessThanOrEqual(30);
		expect(stats!.dropped).toBeGreaterThan(100);
		expect(stats!.n + stats!.dropped).toBe(stats!.cursor);
	});
});

describe("Forge: git, isolation and cleanup", () => {
	it("pushes only with push authority, as an idempotent operation, and an agent's push needs a standing grant that reaches delegates only if it says so", async () => {
		const s = await setup();
		const provider = new RepoProvider();
		const pushes: string[] = [];
		provider.register("claude", () => ({ stdout: `${claudeLines("turn").join("\n")}\n` }));
		provider.register("git", ({ argv }) => {
			if (argv[1] === "push") pushes.push(argv.join(" "));
			return { stdout: "ok" };
		});
		const { forge } = forgeWith(provider);
		withSession(forge);
		await forge.start(s.actor, req("git1"));
		await until(async () => (await withTenant(db.maint, s.t.tenantId, (q) => q.get<{ state: string }>("SELECT state FROM app.coding_runs WHERE op_id = 'git1'")))?.state === "done", "run done");
		// The coding grant is not push authority.
		await expect(forge.push(s.actor, "git1")).rejects.toThrow(/no repo_push grant/);
		await createGrant(db.gate, s.admin, { grantId: "g-push", subjectUser: "ada", kind: "repo_push", repos: ["org/app"], standing: true });
		expect((await forge.push(s.actor, "git1")).state).toBe("succeeded");
		expect((await forge.push(s.actor, "git1")).state).toBe("succeeded");
		expect(pushes.length).toBe(1);
		const delegated: Actor = { principal: s.actor.principal, agent: { agentId: "child", tools: new Set(["coding_push"]), delegationDepth: 1 } };
		await expect(forge.push(delegated, "git1")).rejects.toThrow(/delegated/);
		// Merge is separate authority again.
		await expect(forge.merge(s.actor, "git1")).rejects.toThrow(/no repo_merge grant/);
	});

	it("isolates tenants' workspaces and runs from each other", async () => {
		const a = await setup();
		const b = await setup();
		const provider = new RepoProvider();
		provider.register("claude", () => ({ stdout: `${claudeLines("turn").join("\n")}\n` }));
		const fa = forgeWith(provider);
		withSession(fa.forge);
		await fa.forge.start(a.actor, req("same-op"));
		await fa.forge.start(b.actor, req("same-op"));
		const workspaces = await provider.list();
		expect(new Set(workspaces.map((w) => w.ref.sessionId)).size).toBe(2);
		const wa = (await provider.get(workspaces[0]!.ref))!;
		await wa.writeFile("/workspace/secret.txt", Buffer.from("tenant A only"));
		const wb = (await provider.get(workspaces[1]!.ref))!;
		await expect(wb.readFile("/workspace/secret.txt")).rejects.toThrow();
		// Tenant B cannot see or cancel A's run through the database.
		const seen = await withTenant(db.runtime, b.t.tenantId, (q) => q.all("SELECT op_id FROM app.coding_runs WHERE tenant_id = $1", a.t.tenantId));
		expect(seen).toEqual([]);
	});

	it("removes finished runs' workspaces and sweeps a workspace no run owns", async () => {
		const s = await setup();
		const provider = new RepoProvider();
		provider.register("claude", () => ({ stdout: `${claudeLines("turn").join("\n")}\n` }));
		const { forge } = forgeWith(provider);
		withSession(forge);
		await forge.start(s.actor, req("clean1"));
		await until(async () => (await withTenant(db.maint, s.t.tenantId, (q) => q.get<{ state: string }>("SELECT state FROM app.coding_runs WHERE op_id = 'clean1'")))?.state === "done", "run done");
		// A crash between create and the run row: a workspace with an operation handle and no run.
		const orphanSession = forge.sessionOf(s.t.tenantId, "orphan");
		await provider.create({ ...forge.deps.workspaceSpec({ tenantId: s.t.tenantId, opId: "orphan", repo: "org/app", branch: "b", harness: "claude-code" }), sessionId: orphanSession });
		await withTenant(db.maint, s.t.tenantId, (q) => q.run("INSERT INTO app.external_ops (tenant_id, op_id, kind, idempotent, request, handle) VALUES ($1, 'orphan', 'coding.run', false, '{}', $2)", s.t.tenantId, JSON.stringify({ sessionId: orphanSession })));
		expect((await provider.list()).length).toBe(2);
		expect(await forge.cleanup(s.t.tenantId)).toEqual({ removed: 1, orphans: 1 });
		expect(await provider.list()).toEqual([]);
		void randomUUID;
	});
});
