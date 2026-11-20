import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codingThreadId, threadRef } from "../src/identity";
import { CapabilityUnavailableError, ForbiddenError, httpStatus } from "../src/errors";
import { ada, REPO, startReq, stack } from "./stack";

describe("thread identity", () => {
	it("derives the same ID Pim has always derived", () => {
		// sha256("pim coding thread\nada\nop-1"), computed independently with Python's hashlib.
		expect(codingThreadId("ada", "op-1")).toBe("138d64e7-af2e-beb4-edaa-c47130b65c81");
		expect(codingThreadId("bob", "op-1")).not.toBe(codingThreadId("ada", "op-1"));
	});

	it("reads an id, a page, an Amp id and an Amp URL", () => {
		expect(threadRef("/coding/abc")).toEqual({ kind: "pim", id: "abc" });
		expect(threadRef("https://pim.example.test/coding/abc/")).toEqual({ kind: "pim", id: "abc" });
		expect(threadRef("T-1a2b")).toEqual({ kind: "amp", id: "T-1a2b" });
		expect(threadRef("https://ampcode.com/threads/T-1a2b?x=1")).toEqual({ kind: "amp", id: "T-1a2b" });
	});
});

describe("coding authorization", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	beforeAll(async () => (s = await stack()));
	afterAll(async () => s.close());

	it("a person with no grant gets 403 even though normal chat works; a deployment with no pool gets 503", async () => {
		await expect(s.forge.start(ada, startReq("nogrant"))).rejects.toSatisfy((e) => httpStatus(e) === 403);
		await s.grantAll("ada");
		const bare = await stack();
		await bare.grantAll("ada");
		await bare.pool.query("update pim_forge.forge_pools set enabled = false");
		await expect(bare.forge.start(ada, startReq("nopool"))).rejects.toBeInstanceOf(CapabilityUnavailableError);
		await expect(bare.forge.start(ada, startReq("nopool"))).rejects.toSatisfy((e) => httpStatus(e) === 503);
		await bare.close();
	});

	it("starts idempotently: the same (owner, operation) is the same thread", async () => {
		const a = await s.forge.start(ada, startReq("op-1"));
		const b = await s.forge.start(ada, startReq("op-1", { task: "different words" }));
		expect(a).toMatchObject({ threadId: "138d64e7-af2e-beb4-edaa-c47130b65c81", created: true });
		expect(b).toMatchObject({ threadId: a.threadId, created: false });
		const rows = await s.pool.query("select count(*) c from pim_forge.forge_threads where start_operation = 'op-1'");
		expect(rows.rows[0].c).toBe("1");
		// Found by its page, and by the Amp id once it has an orb.
		expect((await s.forge.status(ada, `/coding/${a.threadId}`)).threadId).toBe(a.threadId);
		await expect(s.forge.status({ ownerId: "eve", role: "member" }, a.threadId)).rejects.toMatchObject({ code: "not_found" });
	});

	it("refuses guests and unknown repositories, and lets a grant with no repositories named reach any repository: the deployment has no allow-list of its own", async () => {
		await expect(s.forge.start({ ownerId: "ada", role: "guest" }, startReq("g"))).rejects.toBeInstanceOf(ForbiddenError);
		await expect(s.forge.start(ada, startReq("other", { repo: "https://github.com/evil/repo" }))).resolves.toMatchObject({ created: true });
		await expect(s.forge.start(ada, startReq("bad", { repo: "not a repo" }))).rejects.toMatchObject({ code: "invalid" });
	});

	it("scopes a grant to repositories and pools, and revocation bites at once", async () => {
		const g = await s.authz.grant({ subjectType: "user", subjectId: "bo", permission: "coding:start", repos: ["acme/app"], pools: ["default"], grantedBy: "admin" });
		const bo = { ownerId: "bo", role: "member" as const };
		await expect(s.authz.check(bo, "coding:start", { repo: REPO, pool: "default" })).resolves.toMatchObject({ requiresApproval: false });
		await expect(s.authz.check(bo, "coding:start", { repo: "https://github.com/acme/other", pool: "default" })).rejects.toBeInstanceOf(ForbiddenError);
		await expect(s.authz.check(bo, "coding:start", { repo: REPO, pool: "gpu" })).rejects.toBeInstanceOf(ForbiddenError);
		await s.authz.revoke(g);
		await expect(s.authz.check(bo, "coding:start", { repo: REPO, pool: "default" })).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("honors a standing agent grant as an explicit policy, and permission is not approval", async () => {
		await s.authz.grant({ subjectType: "agent", subjectId: "linus", permission: "coding:merge", repos: ["acme/app"], standing: true, grantedBy: "admin" });
		await s.authz.grant({ subjectType: "user", subjectId: "cy", permission: "coding:push", requiresApproval: true, grantedBy: "admin" });
		const linus = { ownerId: "zed", role: "member" as const, agent: "linus" };
		await expect(s.authz.check(linus, "coding:merge", { repo: REPO })).resolves.toMatchObject({ standing: true, requiresApproval: false });
		await expect(s.authz.check(linus, "coding:push", { repo: REPO })).rejects.toBeInstanceOf(ForbiddenError);
		await expect(s.authz.check({ ownerId: "cy", role: "member" }, "coding:push", { repo: REPO })).resolves.toMatchObject({ requiresApproval: true });
	});

	it("suspension blocks every action", async () => {
		await s.authz.setSuspended("ada", true);
		await expect(s.forge.start(ada, startReq("sus"))).rejects.toMatchObject({ code: "forbidden" });
		await s.authz.setSuspended("ada", false);
		await expect(s.forge.start(ada, startReq("sus"))).resolves.toMatchObject({ created: true });
	});

	it("keeps Amp unavailable (503) without a credential while sandbox harnesses still work", async () => {
		const s2 = await stack({ ampConfigured: false });
		await s2.grantAll("ada");
		await expect(s2.forge.start(ada, startReq("a1", { harness: "amp" }))).rejects.toBeInstanceOf(CapabilityUnavailableError);
		await expect(s2.forge.start(ada, startReq("a2", { harness: "claude-code" }))).resolves.toMatchObject({ created: true });
		await s2.close();
	});
});
