import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticate, createApiToken, createSession, newRecoveryCodes, revokeSession, revokeToken, signInWithRecoveryCode, storeRecoveryCodes, tenantOfToken } from "../src/auth.ts";
import { type Actor, actionDigest, authorize, createGrant, enforce, Forbidden, revokeGrant } from "../src/authz.ts";
import { withTenant } from "../src/db.ts";
import { KeyRing, getSecret, putSecret, rotateSecrets } from "../src/secrets.ts";
import { createTestDb, type TestDb } from "./support/db.ts";
import { tenantWithPeople } from "./support/people.ts";

let db: TestDb;
beforeAll(async () => {
	db = await createTestDb();
});
afterAll(async () => db.close());

describe("sessions and tokens", () => {
	it("revokes server-side at once, expires, and blocks suspended people and tenants", async () => {
		const t = await tenantWithPeople(db);
		const secret = await createSession(db.gate, t.tenantId, "ada");
		expect((await authenticate(db.gate, t.tenantId, secret))?.userId).toBe("ada");
		expect(await revokeSession(db.gate, t.tenantId, "ada", secret)).toBe(1);
		expect(await authenticate(db.gate, t.tenantId, secret)).toBeUndefined();

		const short = await createSession(db.gate, t.tenantId, "ada", 50);
		await new Promise((r) => setTimeout(r, 120));
		expect(await authenticate(db.gate, t.tenantId, short)).toBeUndefined();

		const live = await createSession(db.gate, t.tenantId, "ada");
		await withTenant(db.gate, t.tenantId, (q) => q.run("UPDATE app.users SET status = 'suspended' WHERE user_id = 'ada'"));
		expect(await authenticate(db.gate, t.tenantId, live)).toBeUndefined();
		await withTenant(db.gate, t.tenantId, (q) => q.run("UPDATE app.users SET status = 'active' WHERE user_id = 'ada'"));
		expect((await authenticate(db.gate, t.tenantId, live))?.userId).toBe("ada");
		await db.admin.query("UPDATE app.tenants SET status = 'suspended' WHERE tenant_id = $1", [t.tenantId]);
		expect(await authenticate(db.gate, t.tenantId, live)).toBeUndefined();
	});

	it("scopes and revokes API tokens, never accepts a token across tenants, and stores only a digest", async () => {
		const a = await tenantWithPeople(db);
		const b = await tenantWithPeople(db);
		const { tokenId, secret } = await createApiToken(db.gate, { tenantId: a.tenantId, userId: "ada", name: "cli", scopes: ["chat.read"] });
		expect(tenantOfToken(secret)).toBe(a.tenantId);
		const principal = (await authenticate(db.gate, a.tenantId, secret))!;
		expect(principal.via).toBe("token");
		const actor: Actor = { principal };
		expect((await authorize(db.gate, actor, "chat.read", { tenantId: a.tenantId, ownerUserId: "ada" })).allow).toBe(true);
		expect((await authorize(db.gate, actor, "chat.send", { tenantId: a.tenantId, ownerUserId: "ada" })).reason).toMatch(/scope/);
		// The same secret presented to another tenant is nobody; a principal of A cannot act on B's resource.
		expect(await authenticate(db.gate, b.tenantId, secret)).toBeUndefined();
		expect((await authorize(db.gate, actor, "chat.read", { tenantId: b.tenantId })).reason).toBe("tenant mismatch");
		const stored = (await db.admin.query("SELECT token_hash FROM app.api_tokens WHERE token_id = $1", [tokenId])).rows[0].token_hash;
		expect(stored).not.toContain(secret);
		expect(await revokeToken(db.gate, a.tenantId, tokenId)).toBe(true);
		expect(await authenticate(db.gate, a.tenantId, secret)).toBeUndefined();
		// A principal that was already resolved stops being authorized the moment its credential is revoked.
		expect((await authorize(db.gate, actor, "chat.read", { tenantId: a.tenantId, ownerUserId: "ada" })).reason).toMatch(/no longer active/);
	});

	it("keeps a legacy SHA-256 token working after import by its stored digest", async () => {
		const t = await tenantWithPeople(db);
		const legacy = `pim_${t.tenantId}_legacysecretvalue`;
		const { hashToken } = await import("../src/auth.ts");
		await withTenant(db.gate, t.tenantId, (q) => q.run("INSERT INTO app.api_tokens (tenant_id, token_id, token_hash, user_id, name, scopes, legacy) VALUES ($1, 'legacy1', $2, 'ada', 'imported', ARRAY['*'], true)", t.tenantId, hashToken(legacy)));
		expect((await authenticate(db.gate, t.tenantId, legacy))?.userId).toBe("ada");
	});
});

describe("admin recovery", () => {
	it("refuses to remove, demote or suspend the last active admin, but allows it with a second admin", async () => {
		const t = await tenantWithPeople(db);
		for (const sql of ["UPDATE app.users SET role = 'member' WHERE user_id = 'admin'", "UPDATE app.users SET status = 'suspended' WHERE user_id = 'admin'", "DELETE FROM app.users WHERE user_id = 'admin'"]) {
			await expect(withTenant(db.gate, t.tenantId, (q) => q.run(sql))).rejects.toThrow(/last active admin/);
		}
		await withTenant(db.gate, t.tenantId, (q) => q.run("UPDATE app.users SET role = 'admin' WHERE user_id = 'ada'"));
		await withTenant(db.gate, t.tenantId, (q) => q.run("UPDATE app.users SET role = 'member' WHERE user_id = 'admin'"));
		await expect(withTenant(db.gate, t.tenantId, (q) => q.run("UPDATE app.users SET status = 'suspended' WHERE user_id = 'ada'"))).rejects.toThrow(/last active admin/);
	});

	it("signs in with a recovery code once, for its own person only", async () => {
		const t = await tenantWithPeople(db);
		const codes = newRecoveryCodes(3);
		await storeRecoveryCodes(db.gate, t.tenantId, "admin", codes);
		expect(await signInWithRecoveryCode(db.gate, t.tenantId, "ada", codes[0]!)).toBeUndefined();
		const session = await signInWithRecoveryCode(db.gate, t.tenantId, "admin", codes[0]!);
		expect((await authenticate(db.gate, t.tenantId, session!))?.role).toBe("admin");
		expect(await signInWithRecoveryCode(db.gate, t.tenantId, "admin", codes[0]!)).toBeUndefined();
		expect(await signInWithRecoveryCode(db.gate, t.tenantId, "admin", "not-a-code")).toBeUndefined();
	});
});

describe("coding, compute and repository authority", () => {
	it("is not implied by the admin role, comes from an explicit grant, and stops when revoked", async () => {
		const t = await tenantWithPeople(db);
		const admin = await t.login("admin");
		const ada = await t.login("ada");
		const run = { tenantId: t.tenantId, pool: "pool-a" };
		expect((await authorize(db.gate, { principal: admin }, "coding.run", run)).reason).toBe("no coding grant");
		await expect(createGrant(db.gate, ada, { grantId: "x", subjectUser: "ada", kind: "coding" })).rejects.toBeInstanceOf(Forbidden);
		await createGrant(db.gate, admin, { grantId: "g1", subjectUser: "ada", kind: "coding", pools: ["pool-a"] });
		expect((await authorize(db.gate, { principal: ada }, "coding.run", run)).allow).toBe(true);
		expect((await authorize(db.gate, { principal: ada }, "coding.run", { ...run, pool: "pool-b" })).reason).toMatch(/not granted/);
		expect(await revokeGrant(db.gate, admin, "g1")).toBe(true);
		expect((await authorize(db.gate, { principal: ada }, "coding.run", run)).allow).toBe(false);
	});

	it("limits repositories, quota and spend, separately from agent permission", async () => {
		const t = await tenantWithPeople(db);
		const admin = await t.login("admin");
		const ada = await t.login("ada");
		await createGrant(db.gate, admin, { grantId: "push", subjectUser: "ada", kind: "repo_push", repos: ["org/app"], quotaRuns: 2 });
		const res = { tenantId: t.tenantId, repo: "org/app" };
		expect((await authorize(db.gate, { principal: ada }, "repo.push", { ...res, repo: "org/other" })).allow).toBe(false);
		await enforce(db.gate, { principal: ada }, "repo.push", res);
		await enforce(db.gate, { principal: ada }, "repo.push", res);
		await expect(enforce(db.gate, { principal: ada }, "repo.push", res)).rejects.toThrow(/quota/);
		await createGrant(db.gate, admin, { grantId: "spend", subjectUser: "ada", kind: "coding", pools: ["p"], spendCapCents: 100 });
		expect((await authorize(db.gate, { principal: ada }, "coding.run", { tenantId: t.tenantId, pool: "p", costCents: 90 })).allow).toBe(true);
		expect((await authorize(db.gate, { principal: ada }, "coding.run", { tenantId: t.tenantId, pool: "p", costCents: 101 })).reason).toBe("spend cap reached");
		// Agent tool permission is a separate gate: a grant does not give the agent the tool.
		const agent: Actor = { principal: ada, agent: { agentId: "a1", tools: new Set(["coding_run"]), delegationDepth: 0 } };
		expect((await authorize(db.gate, agent, "coding.run", { tenantId: t.tenantId, pool: "p", tool: "other_tool" })).reason).toMatch(/no permission for tool/);
	});

	it("does not launder authority through an agent or a delegate: one-off authority needs approval of exactly that action; delegates need the grant to say so", async () => {
		const t = await tenantWithPeople(db);
		const admin = await t.login("admin");
		const ada = await t.login("ada");
		await createGrant(db.gate, admin, { grantId: "oneoff", subjectUser: "ada", kind: "repo_merge", repos: ["org/app"] });
		const res = { tenantId: t.tenantId, repo: "org/app", tool: "coding_merge" };
		const top: Actor = { principal: ada, agent: { agentId: "a1", tools: new Set(["coding_merge"]), delegationDepth: 0 } };
		expect((await authorize(db.gate, top, "repo.merge", res)).reason).toMatch(/approval/);
		// The person approves a different action: not enough.
		await withTenant(db.gate, t.tenantId, async (q) => {
			await q.run("INSERT INTO app.approvals (tenant_id, approval_id, partition_id, conversation_id, call_id, status, decided_by, action_digest) VALUES ($1, 'ap-other', 'p', 1, 'c1', 'approved', 'ada', $2)", t.tenantId, actionDigest("repo.merge", { ...res, repo: "org/other" }));
			await q.run("INSERT INTO app.approvals (tenant_id, approval_id, partition_id, conversation_id, call_id, status, decided_by, action_digest) VALUES ($1, 'ap-exact', 'p', 1, 'c2', 'approved', 'ada', $2)", t.tenantId, actionDigest("repo.merge", res));
		});
		expect((await authorize(db.gate, top, "repo.merge", { ...res, approvalId: "ap-other" })).allow).toBe(false);
		expect((await authorize(db.gate, top, "repo.merge", { ...res, approvalId: "ap-exact" })).allow).toBe(true);
		// A standing grant is an explicit record; a delegated agent still cannot use it unless the record extends to delegates.
		await createGrant(db.gate, admin, { grantId: "standing", subjectUser: "ada", kind: "repo_push", repos: ["org/app"], standing: true });
		const pushRes = { tenantId: t.tenantId, repo: "org/app", tool: "coding_push" };
		const child: Actor = { principal: ada, agent: { agentId: "child", tools: new Set(["coding_push"]), delegationDepth: 1 } };
		expect((await authorize(db.gate, { principal: ada, agent: { ...top.agent!, tools: new Set(["coding_push"]) } }, "repo.push", pushRes)).allow).toBe(true);
		expect((await authorize(db.gate, child, "repo.push", pushRes)).reason).toMatch(/delegated/);
		await createGrant(db.gate, admin, { grantId: "standing-delegates", subjectUser: "ada", kind: "repo_push", repos: ["org/app"], standing: true, allowDelegates: true });
		expect((await authorize(db.gate, child, "repo.push", pushRes)).allow).toBe(true);
	});

	it("limits a guest to chats shared with them and a member to their own", async () => {
		const t = await tenantWithPeople(db);
		const gus = await t.login("gus");
		const ada = await t.login("ada");
		expect((await authorize(db.gate, { principal: gus }, "chat.read", { tenantId: t.tenantId, ownerUserId: "ada" })).allow).toBe(false);
		expect((await authorize(db.gate, { principal: gus }, "chat.read", { tenantId: t.tenantId, ownerUserId: "ada", sharedWith: ["gus"] })).allow).toBe(true);
		expect((await authorize(db.gate, { principal: gus }, "settings.write", { tenantId: t.tenantId, ownerUserId: "gus" })).allow).toBe(false);
		expect((await authorize(db.gate, { principal: ada }, "admin.users", { tenantId: t.tenantId })).reason).toBe("admin role required");
		expect((await authorize(db.gate, { principal: ada }, "chat.read", { tenantId: t.tenantId, ownerUserId: "admin" })).allow).toBe(false);
	});
});

describe("secrets", () => {
	const master = Buffer.alloc(32, 7);
	it("encrypts with versioned keys, binds ciphertext to its row, rotates without exposing plaintext, and stores no plaintext", async () => {
		const t = await tenantWithPeople(db);
		const ring1 = new KeyRing(master, 1);
		await putSecret(db.gate, ring1, { tenantId: t.tenantId, secretId: "gmail", purpose: "connector", value: "sk-very-secret-value" });
		await putSecret(db.gate, ring1, { tenantId: t.tenantId, secretId: "other", purpose: "connector", value: "another" });
		expect(await getSecret(db.gate, ring1, t.tenantId, "gmail")).toBe("sk-very-secret-value");
		const raw = (await db.admin.query("SELECT encode(wrapped_key || nonce || ciphertext, 'escape') AS blob FROM app.secrets")).rows.map((r) => r.blob).join("");
		expect(raw).not.toContain("very-secret");
		// Swapping ciphertext between rows (or purposes) fails authentication.
		await db.admin.query("UPDATE app.secrets a SET ciphertext = b.ciphertext, nonce = b.nonce FROM app.secrets b WHERE a.tenant_id = $1 AND a.secret_id = 'gmail' AND b.tenant_id = $1 AND b.secret_id = 'other'", [t.tenantId]);
		await expect(getSecret(db.gate, ring1, t.tenantId, "gmail")).rejects.toThrow();
		await putSecret(db.gate, ring1, { tenantId: t.tenantId, secretId: "gmail", purpose: "connector", value: "sk-very-secret-value" });
		await db.admin.query("UPDATE app.secrets SET purpose = 'other-purpose' WHERE tenant_id = $1 AND secret_id = 'gmail'", [t.tenantId]);
		await expect(getSecret(db.gate, ring1, t.tenantId, "gmail")).rejects.toThrow();
		await db.admin.query("UPDATE app.secrets SET purpose = 'connector' WHERE tenant_id = $1 AND secret_id = 'gmail'", [t.tenantId]);
		// Rotation to key version 2 keeps both readable, and version 1 alone no longer suffices once nothing uses it.
		const ring2 = new KeyRing(master, 2, [1, 2]);
		expect(await rotateSecrets(db.gate, ring2, t.tenantId)).toBe(2);
		expect(await getSecret(db.gate, ring2, t.tenantId, "gmail")).toBe("sk-very-secret-value");
		await expect(getSecret(db.gate, ring1, t.tenantId, "gmail")).rejects.toThrow(/version 2/);
		// A different tenant cannot read it.
		const other = await tenantWithPeople(db);
		expect(await getSecret(db.gate, ring2, other.tenantId, "gmail")).toBeUndefined();
	});

	it("derives keys under their own label: a different master cannot read, and a short master is refused", async () => {
		expect(() => new KeyRing(Buffer.alloc(8), 1)).toThrow(/32 bytes/);
		const t = await tenantWithPeople(db);
		await putSecret(db.gate, new KeyRing(master, 1), { tenantId: t.tenantId, secretId: "s", purpose: "p", value: "v" });
		await expect(getSecret(db.gate, new KeyRing(Buffer.alloc(32, 9), 1), t.tenantId, "s")).rejects.toThrow();
	});
});
