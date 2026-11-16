import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeOrbClient } from "@pim/coding/orb/fake";
import { ApprovalRequiredError, ForbiddenError as ContractForbidden } from "@pim/v2-contracts/authz";
import { validateMigrationFiles } from "@pim/v2-contracts/db";
import { ForgeCompletionWake, ForgeStallWake, HARNESS_CAPABILITIES, HARNESS_IDS } from "@pim/v2-contracts/forge-seam";
import { ForgeAuthorizer } from "../src/authz";
import { CONTRACT_DIVERGENCES, toContractDescriptor } from "../src/harnesses";
import { ada, REPO, ScriptedPort, startReq, stack } from "./stack";

const o = (id: string) => `o_${id}` as never;
const user = (id: string, role = "member") => ({ kind: "user", ownerId: o(id), role, sessionId: "s" }) as never;

describe("@pim/v2-contracts", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	beforeAll(async () => (s = await stack()));
	afterAll(async () => s.close());

	it("keeps its migrations in the forge band and records them in the shared ledger", async () => {
		expect(validateMigrationFiles("forge", readdirSync(new URL("../migrations", import.meta.url).pathname))).toEqual([]);
		const rows = (await s.pool.query("select number from public.pim_schema_migrations order by number")).rows.map((r) => r.number);
		expect(rows).toEqual([1, 400, 401, 402, 403, 404]);
	});

	it("agrees with the contracts' capability table except where Forge says why it differs", () => {
		const diffs: string[] = [];
		for (const id of HARNESS_IDS) {
			const mine = toContractDescriptor(id);
			const theirs = HARNESS_CAPABILITIES[id];
			expect(mine).toMatchObject({ id, executionClass: theirs.executionClass, requiresWorkspacePool: theirs.requiresWorkspacePool, supportsResume: true });
			for (const k of ["supportsCostReporting", "supportsCheckpoints"] as const) if (mine[k] !== theirs[k]) diffs.push(`${id}.${k}`);
		}
		expect(diffs.sort()).toEqual([...CONTRACT_DIVERGENCES].sort());
		// Codex reports tokens, not dollars: it stays false.
		expect(toContractDescriptor("codex").supportsCostReporting).toBe(false);
	});

	it("sends wakes in the contracts' envelopes, even for an operation id with a colon", async () => {
		await s.grantAll("ada");
		const { threadId } = await s.forge.start(ada, startReq("op:with:colons", { harness: "claude-code" }));
		await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed", text: "ok" }]) } }).step(threadId);
		await s.pool.query("update pim_forge.forge_threads set state = 'running' where thread_id = $1", [threadId]);
		s.advance(16 * 60_000);
		await s.stall.check(threadId);
		const rows = (await s.pool.query("select payload from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1 order by id", [threadId])).rows;
		expect(rows).toHaveLength(2);
		const done = ForgeCompletionWake.parse(rows[0]!.payload);
		expect(done).toMatchObject({ wakeId: `coding:${threadId}:op_with_colons`, operationId: "op:with:colons", outcome: "completed" });
		expect(ForgeStallWake.parse(rows[1]!.payload)).toMatchObject({ source: threadId, stage: "1" });
	});

	it("authorizes through the shared Authorizer, deciding on the origin of a delegation chain", async () => {
		const az = new ForgeAuthorizer(s.authz);
		await s.authz.grant({ subjectType: "user", subjectId: o("kim"), permission: "coding:merge", repos: ["github.com/acme/*"], grantedBy: "admin" });
		const req = (principal: unknown, action = "coding:merge", repository = "github.com/acme/app") => ({ principal: principal as never, ownerId: o("kim"), action, resource: { repository } });
		expect(await az.authorize(req(user("kim")))).toEqual({ outcome: "allow" });
		await expect(az.authorize(req(user("kim"), "coding:push"))).rejects.toBeInstanceOf(ContractForbidden);
		await expect(az.authorize(req(user("kim"), "coding:merge", "github.com/other/app"))).rejects.toBeInstanceOf(ContractForbidden);
		await expect(az.authorize(req(user("kim", "guest")))).rejects.toBeInstanceOf(ContractForbidden);
		await expect(az.authorize(req(user("lee")))).rejects.toBeInstanceOf(ContractForbidden);
		// Delegation never gives more than the origin holds.
		const delegated = (origin: unknown) => ({ kind: "delegated", ownerId: o("kim"), delegateId: "d", originPrincipal: origin });
		expect(await az.authorize(req(delegated(user("kim"))))).toEqual({ outcome: "allow" });
		await expect(az.authorize(req(delegated(user("lee"))))).rejects.toBeInstanceOf(ContractForbidden);
		// A token carries at most the scopes it was minted with.
		const token = (scopes: string[]) => ({ kind: "token", ownerId: o("kim"), role: "member", tokenId: "t", scopes });
		expect(await az.authorize(req(token(["coding:merge"])))).toEqual({ outcome: "allow" });
		await expect(az.authorize(req(token(["coding:steer"])))).rejects.toBeInstanceOf(ContractForbidden);
		await expect(az.authorize({ ...req(user("kim")), action: "files:read" })).rejects.toBeInstanceOf(ContractForbidden);
		void ApprovalRequiredError;
	});

	it("keeps permission and approval apart, and lets only a live, in-scope standing approval stand in for a person", async () => {
		const az = new ForgeAuthorizer(s.authz);
		await s.authz.grant({ subjectType: "user", subjectId: o("ana"), permission: "coding:push", requiresApproval: true, grantedBy: "admin" });
		const req = (repository = "github.com/acme/app", branch?: string) => ({ principal: user("ana"), ownerId: o("ana"), action: "coding:push", resource: { repository, ...(branch ? { branch } : {}) } }) as never;
		expect(await az.authorize(req())).toEqual({ outcome: "approval_required", approvalKey: "coding:push:github.com/acme/app" });
		await s.authz.grantStanding({ approvalId: "sa-1", ownerId: o("ana"), action: "coding:push", scope: { repository: "github.com/acme/app" }, grantedBy: o("admin") });
		expect(await az.authorize(req())).toEqual({ outcome: "allow", viaStandingApproval: "sa-1" });
		expect(await az.authorize(req("github.com/acme/other"))).toMatchObject({ outcome: "approval_required" });
		await s.authz.revokeStanding("sa-1");
		expect(await az.authorize(req())).toMatchObject({ outcome: "approval_required" });
		await s.authz.grantStanding({ approvalId: "sa-2", ownerId: o("ana"), action: "coding:push", scope: { repository: "github.com/acme/app" }, grantedBy: o("admin"), expiresAt: new Date(Date.now() - 1000) });
		expect(await az.authorize(req())).toMatchObject({ outcome: "approval_required" });
	});

	it("a standing approval lets Forge push without asking, only for the repository it names", async () => {
		await s.grantAll("bo", { requiresApproval: true });
		const bo = { ownerId: "bo", role: "member" as const };
		const { threadId } = await s.forge.start(bo, startReq("sa-push", { harness: "claude-code" }));
		await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed" }]) } }).step(threadId);
		await s.commit(threadId, "sa.txt", "sa");
		expect(await s.forge.push(bo, threadId)).toMatchObject({ status: "approval_required" });
		await s.authz.grantStanding({ approvalId: "sa-bo", ownerId: "bo", action: "coding:push", scope: { repository: "github.com/acme/app" }, grantedBy: "admin" });
		expect(await s.forge.push(bo, threadId)).toMatchObject({ status: "done", outcome: "pushed" });
		void REPO;
	});

	it("captures Amp's reported cost as a delta, once, and leaves spend at 0 when the orb reports none", async () => {
		const orb = new FakeOrbClient();
		const { threadId } = await s.forge.start(ada, startReq("amp-cost", { harness: "amp" }));
		const w = s.worker({ orbs: () => orb });
		await w.step(threadId);
		const h = orb.started[0]!.threadId;
		await w.step(threadId);
		expect((await s.store.get(threadId))!.spentUsd).toBe(0);
		orb.setUsage(h, { usd: 0.4 });
		await w.step(threadId);
		await w.step(threadId);
		expect((await s.store.get(threadId))!.spentUsd).toBe(0.4);
		orb.setUsage(h, { usd: 0.9 });
		await w.step(threadId);
		expect((await s.store.get(threadId))!.spentUsd).toBe(0.9);
		const ledger = await s.pool.query("select payload from pim_forge.forge_outbox where topic = 'cost_ledger' and thread_id = $1 order by id", [threadId]);
		expect(ledger.rows.map((r) => [r.payload.run_kind, r.payload.costUsd])).toEqual([["coding_thread", 0.4], ["coding_thread", 0.5]]);
		// A client that can't report usage is never asked, and the capability says so.
		const quiet = new FakeOrbClient({ capabilities: { usage: false } });
		const t2 = (await s.forge.start(ada, startReq("amp-nocost", { harness: "amp" }))).threadId;
		const w2 = s.worker({ orbs: () => quiet });
		await w2.step(t2);
		await w2.step(t2);
		expect((await s.store.get(t2))!.spentUsd).toBe(0);
	});
});
