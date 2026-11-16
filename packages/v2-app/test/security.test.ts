import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalRequiredError, ForbiddenError, GoneError, UnauthorizedError } from "../src/errors.ts";
import { delegate } from "../src/principal.ts";
import { asSession, fixture, member } from "./support/fixture.ts";

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
	f = await fixture();
});
afterAll(() => f.close());

describe("row-level security", () => {
	it("keeps tenants apart on one pooled connection, and fails closed with no context", async () => {
		const a = await member(f.app, f.admin.principal, "alice");
		const b = await member(f.app, f.admin.principal, "bob");
		await f.app.memories.remember(a.principal, "everyone", "alice secret", "a-only");
		// One physical connection serves tenant A, then tenant B, then no tenant at all.
		const client = new pg.Client({ connectionString: f.appUrl });
		await client.connect();
		const as = async (owner: string | null, sql: string, params: unknown[] = []) => {
			await client.query("BEGIN");
			if (owner) await client.query("SELECT set_config('pim.owner_id', $1, true)", [owner]);
			try {
				return (await client.query(sql, params)).rows;
			} finally {
				await client.query("ROLLBACK");
			}
		};
		expect(await as(a.account.ownerId, "SELECT title FROM pim_app.memories")).toHaveLength(1);
		expect(await as(b.account.ownerId, "SELECT title FROM pim_app.memories")).toHaveLength(0);
		expect(await as(null, "SELECT title FROM pim_app.memories")).toHaveLength(0);
		// Tenant B cannot write or change tenant A's rows either.
		await expect(as(b.account.ownerId, "INSERT INTO pim_app.memories (id, owner_id, scope, title, body) VALUES ('x', $1, 'everyone', 't', 'b')", [a.account.ownerId])).rejects.toThrow(/row-level security/);
		expect(await as(b.account.ownerId, "UPDATE pim_app.memories SET title = 'pwned' RETURNING id")).toHaveLength(0);
		expect(await as(b.account.ownerId, "DELETE FROM pim_app.memories RETURNING id")).toHaveLength(0);
		// The setting is transaction-local: it does not survive COMMIT on the same connection.
		await client.query("BEGIN");
		await client.query("SELECT set_config('pim.owner_id', $1, true)", [a.account.ownerId]);
		await client.query("COMMIT");
		expect((await client.query("SELECT current_setting('pim.owner_id', true) AS v")).rows[0].v ?? "").toBe("");
		expect((await client.query("SELECT 1 FROM pim_app.memories")).rowCount).toBe(0);
		await client.end();
	});

	it("runs the application as a role that cannot bypass it", async () => {
		const { rows } = await f.db.anonymous((tx) => tx.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"));
		expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
		const forced = await f.db.anonymous((tx) => tx.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'pim_app' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity"));
		expect(forced.rows[0].n).toBeGreaterThan(30);
	});

	it("never lets an app-role session change an account's owner id or username, or remove an account", async () => {
		const c = await member(f.app, f.admin.principal, "carol");
		await expect(f.db.owner(c.account.ownerId, (tx) => tx.query("UPDATE pim_app.accounts SET username = 'other' WHERE owner_id = $1", [c.account.ownerId]))).rejects.toThrow(/immutable/);
		await expect(f.db.owner(c.account.ownerId, (tx) => tx.query("DELETE FROM pim_app.accounts WHERE owner_id = $1", [c.account.ownerId]))).rejects.toThrow(/tombstoned/);
	});
});

describe("sessions, tokens and owner status", () => {
	it("revokes a session and a token immediately, and a token never exceeds its scopes", async () => {
		const d = await member(f.app, f.admin.principal, "dave");
		const session = await f.app.identity.createSession(d.account.ownerId);
		const sp = await f.app.identity.authenticate(session);
		const { token, id } = await f.app.identity.createToken(sp, { name: "ci", scopes: ["api:read"] });
		const tp = await f.app.identity.authenticate(token);
		await f.app.identity.authz.authorize(tp, "api:read");
		await expect(f.app.identity.authz.authorize(tp, "api:write")).rejects.toBeInstanceOf(ForbiddenError);
		// A token cannot mint tokens, whatever its scopes: that is session-only.
		const star = await f.app.identity.authenticate((await f.app.identity.createToken(sp, { name: "all", scopes: ["*"] })).token);
		await expect(f.app.identity.createToken(star, { name: "child", scopes: ["*"] })).rejects.toMatchObject({ code: "session_only" });
		await f.app.identity.revokeToken(sp, id);
		await expect(f.app.identity.authenticate(token)).rejects.toBeInstanceOf(UnauthorizedError);
		await f.app.identity.revokeSession(d.account.ownerId, sp.subject);
		await expect(f.app.identity.authenticate(session)).rejects.toBeInstanceOf(UnauthorizedError);
	});

	it("suspends (403) and deletes (410) an owner across session, token, MCP, trigger and public execution", async () => {
		const e = await member(f.app, f.admin.principal, "erin");
		const owner = e.account.ownerId;
		const session = await f.app.identity.createSession(owner);
		const sp = await f.app.identity.authenticate(session);
		const api = await f.app.identity.authenticate((await f.app.identity.createToken(sp, { name: "t", scopes: ["*"] })).token);
		const mcp = await f.app.identity.authenticate((await f.app.identity.issueConsumer(owner, "mcp_grant", { scopes: ["api:*"] })).token);
		const trigger = { kind: "trigger" as const, ownerId: owner, scopes: ["api:*"], subject: "tr" };
		const surfaces = [sp, api, mcp, trigger];
		for (const p of surfaces) await f.app.identity.authz.authorize(p, "api:read");

		await f.app.identity.setStatus(f.admin.principal, owner, "suspended", "abuse");
		for (const p of surfaces) await expect(f.app.identity.authz.authorize(p, "api:read")).rejects.toMatchObject({ status: 403, code: "suspended" });
		await expect(f.app.identity.authenticate(session)).rejects.toMatchObject({ status: 403 });
		await expect(f.app.identity.authz.requireLive(owner)).rejects.toMatchObject({ status: 403 }); // public hosted-app execution asks this

		await f.app.identity.setStatus(f.admin.principal, owner, "active");
		await f.app.identity.authz.authorize(sp, "api:read");
		await f.app.identity.setStatus(f.admin.principal, owner, "deleted");
		for (const p of surfaces) await expect(f.app.identity.authz.authorize(p, "api:read")).rejects.toBeInstanceOf(GoneError);
		await expect(f.app.identity.authenticate(session)).rejects.toBeInstanceOf(UnauthorizedError); // credentials were revoked with the account
		// The username is never reused, even after deletion.
		await f.app.identity.setRegistrationOpen(f.admin.principal, true);
		await expect(f.app.identity.register({ username: "erin" })).rejects.toMatchObject({ code: "username_taken" });
	});

	it("keeps the last admin, and gives the operator a recovery path", async () => {
		const only = f.admin.account.ownerId;
		await expect(f.app.identity.setStatus(f.admin.principal, only, "suspended")).rejects.toMatchObject({ code: "last_admin" });
		await expect(f.app.identity.setRole(f.admin.principal, only, "member")).rejects.toMatchObject({ code: "last_admin" });
		await expect(f.app.identity.setStatus(f.admin.principal, only, "deleted")).rejects.toMatchObject({ code: "last_admin" });
		// A second admin makes stepping down legal; two admins stepping down at once cannot leave none.
		const g = await member(f.app, f.admin.principal, "gina");
		await f.app.identity.setRole(f.admin.principal, g.account.ownerId, "admin");
		const results = await Promise.allSettled([f.app.identity.setRole(f.admin.principal, only, "member"), f.app.identity.setRole(asSession(g.account.ownerId), g.account.ownerId, "member")]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const admins = await f.db.anonymous(async (tx) => (await tx.query("SELECT count(*)::int AS n FROM pim_app.admin_roster")).rows[0].n);
		expect(admins).toBe(1);
		// Recovery: whoever is left admin is suspended by nobody; the operator's claim code reactivates the admin and starts a session.
		const survivor = (await f.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.admin_roster")).rows[0].owner_id)) as string;
		const other = survivor === only ? g.account.ownerId : only;
		await f.app.identity.setRole(asSession(survivor), other, "admin");
		await f.app.identity.setStatus(asSession(survivor), survivor, "suspended").catch(() => undefined);
		const claim = await f.app.identity.issueClaim("admin_recovery", only, 60_000);
		const { session, account } = await f.app.identity.recoverAdmin(claim);
		expect(account).toMatchObject({ ownerId: only, role: "admin", status: "active" });
		expect((await f.app.identity.authenticate(session)).ownerId).toBe(only);
		await expect(f.app.identity.recoverAdmin(claim)).rejects.toMatchObject({ code: "claim_invalid" }); // one use
	});
});

describe("grants, standing approvals and delegation", () => {
	it("lets a standing grant cover push and merge for one principal, and no one else", async () => {
		const linus = await member(f.app, f.admin.principal, "linus");
		const owner = linus.account.ownerId;
		const agent = { kind: "agent" as const, ownerId: owner, scopes: ["coding:*", "api:*"], subject: "linus" };
		const other = { ...agent, subject: "intruder" };
		// No coding grant yet: forbidden outright.
		await expect(f.app.identity.authz.authorize(agent, "coding:push", "ajac-zero/pim")).rejects.toMatchObject({ code: "no_grant" });
		await f.app.identity.authz.grantCapability(f.admin.principal, { ownerId: owner, capability: "repository", resource: "ajac-zero/*" });
		// Granted but not approved: a human must approve each push.
		await expect(f.app.identity.authz.authorize(agent, "coding:push", "ajac-zero/pim")).rejects.toBeInstanceOf(ApprovalRequiredError);
		await f.app.identity.authz.grantStanding(f.admin.principal, { ownerId: owner, principal: "agent:linus", action: "coding:push", resource: "ajac-zero/pim", reason: "Linus owns pushes to pim" });
		await f.app.identity.authz.grantStanding(f.admin.principal, { ownerId: owner, principal: "agent:linus", action: "coding:merge", resource: "ajac-zero/pim", reason: "Linus owns merges" });
		await f.app.identity.authz.authorize(agent, "coding:push", "ajac-zero/pim");
		await f.app.identity.authz.authorize(agent, "coding:merge", "ajac-zero/pim");
		await expect(f.app.identity.authz.authorize(agent, "coding:push", "ajac-zero/other")).rejects.toBeInstanceOf(ApprovalRequiredError); // another repository
		await expect(f.app.identity.authz.authorize(other, "coding:push", "ajac-zero/pim")).rejects.toBeInstanceOf(ApprovalRequiredError); // another principal
		await expect(f.app.identity.authz.authorize(agent, "coding:push", "elsewhere/x")).rejects.toMatchObject({ code: "no_grant" }); // not an authorized repository
		// Decisions are audited, and the audit log is append-only to the app role.
		const audit = await f.db.owner(owner, (tx) => tx.query("SELECT decision FROM pim_app.audit_log ORDER BY id"));
		expect(audit.rows.map((r) => r.decision)).toContain("allowed");
		await expect(f.db.owner(owner, (tx) => tx.query("DELETE FROM pim_app.audit_log"))).resolves.toMatchObject({ rowCount: 0 });
		// Revoking the standing grant takes effect at once.
		const id = (await f.db.owner(owner, (tx) => tx.query("SELECT id FROM pim_app.standing_approvals WHERE action = 'coding:push'"))).rows[0].id;
		await f.app.identity.authz.revokeStanding(f.admin.principal, owner, id);
		await expect(f.app.identity.authz.authorize(agent, "coding:push", "ajac-zero/pim")).rejects.toBeInstanceOf(ApprovalRequiredError);
		// Only an admin manages grants.
		await expect(f.app.identity.authz.grantStanding(linus.principal, { ownerId: owner, principal: "agent:linus", action: "coding:push", reason: "self" })).rejects.toMatchObject({ code: "admin_only" });
	});

	it("does not let delegation launder privilege beyond the originating principal", async () => {
		const h = await member(f.app, f.admin.principal, "heidi");
		const owner = h.account.ownerId;
		await f.app.identity.authz.grantCapability(f.admin.principal, { ownerId: owner, capability: "repository" });
		await f.app.identity.authz.grantStanding(f.admin.principal, { ownerId: owner, principal: "agent:trusted", action: "coding:push", reason: "trusted agent" });
		const trusted = { kind: "agent" as const, ownerId: owner, scopes: ["coding:*"], subject: "trusted" };
		await f.app.identity.authz.authorize(trusted, "coding:push", "r/x");
		// A read-only token asks the trusted agent to act: the delegated principal carries the chain and is held to both.
		const readOnly = { kind: "token" as const, ownerId: owner, scopes: ["api:read"], subject: "tok" };
		const delegated = delegate(readOnly, { kind: "agent", subject: "trusted", scopes: ["coding:*"] });
		await expect(f.app.identity.authz.authorize(delegated, "coding:push", "r/x")).rejects.toMatchObject({ code: "scope" });
		// An origin that is suspended stops the chain even though the agent itself is fine.
		const visitor = await member(f.app, f.admin.principal, "ivan");
		await f.app.identity.setStatus(f.admin.principal, visitor.account.ownerId, "suspended");
		const fromVisitor = { ...delegate(visitor.principal, { kind: "agent", subject: "trusted", scopes: ["coding:*"] }), ownerId: owner };
		await expect(f.app.identity.authz.authorize(fromVisitor, "coding:push", "r/x")).rejects.toMatchObject({ status: 403, code: "suspended" });
	});
});

describe("registration", () => {
	it("needs a bootstrap claim for the first account, and an invite or open registration afterwards", async () => {
		await f.app.identity.setRegistrationOpen(f.admin.principal, false);
		await expect(f.app.identity.register({ username: "zed" })).rejects.toMatchObject({ code: "registration_closed" });
		const invite = await f.app.identity.createInvite(f.admin.principal);
		const z = await f.app.identity.register({ username: "zed", invite });
		expect(z.role).toBe("member");
		await expect(f.app.identity.register({ username: "zoe", invite })).rejects.toMatchObject({ code: "invite_invalid" });
		// The failed registration did not claim the name or leave an account behind.
		const rows = await f.db.anonymous(async (tx) => (await tx.query("SELECT count(*)::int AS n FROM pim_app.usernames WHERE username = 'zoe'")).rows[0].n);
		expect(rows).toBe(0);
	});
});
