import { readdirSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalRequiredError, ForbiddenError, GoneError, UnauthorizedError } from "../src/errors.ts";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import { asSession, fixture, member } from "./support/fixture.ts";

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
	f = await fixture();
});
afterAll(() => f.close());

describe("migrations", () => {
	it("apply the canonical foundation and then the application band, recorded in the shared ledger, and again as a no-op", async () => {
		const owner = new pg.Client({ connectionString: f.ownerUrl });
		await owner.connect();
		const { rows } = await owner.query("SELECT number FROM public.pim_schema_migrations ORDER BY number");
		await owner.end();
		await expect(f.db.anonymous((tx) => tx.query("SELECT 1 FROM public.pim_schema_migrations"))).rejects.toThrow(/permission denied/); // the ledger is not the application's
		expect(rows.map((r) => r.number)).toEqual([1, ...readdirSync(new URL("../migrations", import.meta.url)).map((f) => Number(f.slice(0, 4))).sort()]);
		const { migrate } = await import("../src/migrate.ts");
		expect(await migrate(f.ownerUrl)).toEqual([]);
	});
});

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
		await f.app.identity.authz.enforce(tp, "api:read");
		await expect(f.app.identity.authz.enforce(tp, "api:write")).rejects.toBeInstanceOf(ForbiddenError);
		// A token cannot mint tokens, whatever its scopes: that is session-only.
		const star = await f.app.identity.authenticate((await f.app.identity.createToken(sp, { name: "all", scopes: ["*"] })).token);
		await expect(f.app.identity.createToken(star, { name: "child", scopes: ["*"] })).rejects.toMatchObject({ reason: "session-only" });
		await f.app.identity.revokeToken(sp, id);
		await expect(f.app.identity.authenticate(token)).rejects.toBeInstanceOf(UnauthorizedError);
		await f.app.identity.revokeSession(d.account.ownerId, (sp as { sessionId: string }).sessionId);
		await expect(f.app.identity.authenticate(session)).rejects.toBeInstanceOf(UnauthorizedError);
	});

	it("keeps the administration and the computer's desktop to a browser session, whatever a token's scopes", async () => {
		const adminSession = f.admin.principal;
		const all = await f.app.identity.authenticate((await f.app.identity.createToken(adminSession, { name: "all", scopes: ["*"] })).token);
		for (const action of ["admin:settings", "admin:accounts", "admin:compute", "computer:screen"]) {
			await expect(f.app.identity.authz.enforce(all, action)).rejects.toMatchObject({ reason: "session-only" });
		}
		await f.app.identity.authz.enforce(adminSession, "admin:settings");
		await f.app.identity.authz.enforce(adminSession, "computer:screen");
		// What a token may otherwise do is still its scopes' to say.
		await f.app.identity.authz.enforce(all, "computer:use");
	});

	it("suspends (403) and deletes (410) an owner across session, token, MCP, trigger and public execution", async () => {
		const e = await member(f.app, f.admin.principal, "erin");
		const owner = e.account.ownerId;
		const session = await f.app.identity.createSession(owner);
		const sp = await f.app.identity.authenticate(session);
		const api = await f.app.identity.authenticate((await f.app.identity.createToken(sp, { name: "t", scopes: ["*"] })).token);
		const mcp = await f.app.identity.authenticate((await f.app.identity.issueConsumer(owner, "mcp_grant", { scopes: ["api:*"] })).token);
		const trigger: Principal = { kind: "agent", ownerId: OwnerId.parse(owner), agentId: "trigger" };
		const surfaces = [sp, api, mcp, trigger];
		for (const p of surfaces) await f.app.identity.authz.enforce(p, "api:read");

		await f.app.identity.setStatus(f.admin.principal, owner, "suspended", "abuse");
		for (const p of surfaces) await expect(f.app.identity.authz.enforce(p, "api:read")).rejects.toMatchObject({ name: "ForbiddenError", reason: "suspended" });
		await expect(f.app.identity.authenticate(session)).rejects.toMatchObject({ reason: "suspended" });
		await expect(f.app.identity.authz.requireLive(owner)).rejects.toMatchObject({ reason: "suspended" }); // public hosted-app execution asks this

		await f.app.identity.setStatus(f.admin.principal, owner, "active");
		await f.app.identity.authz.enforce(sp, "api:read");
		await f.app.identity.setStatus(f.admin.principal, owner, "deleted");
		for (const p of surfaces) await expect(f.app.identity.authz.enforce(p, "api:read")).rejects.toBeInstanceOf(GoneError);
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
	const repo = (name: string) => ({ repository: `github.com/${name}` });
	const agentOf = (owner: string, agentId: string): Principal => ({ kind: "agent", ownerId: OwnerId.parse(owner), agentId });

	it("lets a standing approval cover push and merge on one repository, and refuses what no grant covers", async () => {
		const linus = await member(f.app, f.admin.principal, "linus");
		const owner = linus.account.ownerId;
		const authz = f.app.identity.authz;
		const agent = agentOf(owner, "linus");
		const ask = (action: string, resource: Record<string, string>) => authz.authorize({ principal: agent, ownerId: owner, action, resource });
		// No coding grant yet: forbidden outright, for push and for start.
		await expect(ask("coding:push", repo("ajac-zero/pim"))).rejects.toMatchObject({ name: "ForbiddenError", reason: "no-coding-grant" });
		// A grant without a pool means coding cannot start at all: the capability is absent, which is not a permission failure.
		await authz.grantCoding(f.admin.principal, { ownerId: owner, permissions: ["coding:start", "coding:push", "coding:merge"], repositories: ["github.com/ajac-zero/*"] });
		await expect(ask("coding:start", {})).rejects.toMatchObject({ name: "CapabilityUnavailableError", capability: "coding" });
		// Granted but not approved: a person must approve each push. Permission and approval are separate answers.
		expect(await ask("coding:push", repo("ajac-zero/pim"))).toMatchObject({ outcome: "approval_required" });
		const standing = await authz.grantStanding(f.admin.principal, { ownerId: owner, action: "coding:push", scope: repo("ajac-zero/pim") });
		await authz.grantStanding(f.admin.principal, { ownerId: owner, action: "coding:merge", scope: repo("ajac-zero/pim") });
		expect(await ask("coding:push", repo("ajac-zero/pim"))).toEqual({ outcome: "allow", viaStandingApproval: standing });
		expect(await ask("coding:merge", repo("ajac-zero/pim"))).toMatchObject({ outcome: "allow" });
		expect(await ask("coding:push", repo("ajac-zero/other"))).toMatchObject({ outcome: "approval_required" }); // another repository
		await expect(ask("coding:push", repo("elsewhere/x"))).rejects.toMatchObject({ reason: "repository-not-granted" }); // not an authorized repository
		await expect(ask("coding:pr", repo("ajac-zero/pim"))).rejects.toMatchObject({ reason: "no-coding-grant" }); // the grant never listed PRs
		// A standing approval is a record: it expires and can be revoked at once.
		const soon = await authz.grantStanding(f.admin.principal, { ownerId: owner, action: "coding:push", scope: repo("ajac-zero/short"), expiresAt: new Date(Date.now() - 1000) });
		expect(soon).toBeTruthy();
		expect(await ask("coding:push", repo("ajac-zero/short"))).toMatchObject({ outcome: "approval_required" });
		// Decisions are audited, and the audit log is append-only to the application role.
		const audit = await f.db.owner(owner, (tx) => tx.query("SELECT decision FROM pim_app.audit_log ORDER BY id"));
		expect(audit.rows.map((r) => r.decision)).toEqual(expect.arrayContaining(["allowed", "approval_required", "denied", "unavailable"]));
		await expect(f.db.owner(owner, (tx) => tx.query("DELETE FROM pim_app.audit_log"))).resolves.toMatchObject({ rowCount: 0 });
		await authz.revokeStanding(f.admin.principal, owner, standing);
		expect(await ask("coding:push", repo("ajac-zero/pim"))).toMatchObject({ outcome: "approval_required" });
		// Only an admin manages grants, and only a person decides approvals.
		await expect(authz.grantStanding(linus.principal, { ownerId: owner, action: "coding:push", scope: {} })).rejects.toMatchObject({ reason: "admin-only" });
		await expect(authz.enforce(agent, "approval:decide")).rejects.toMatchObject({ reason: "agent-scope" });
		await expect(authz.enforce(agent, "admin:grants")).rejects.toMatchObject({ reason: "agent-scope" });
		await authz.grantCoding(f.admin.principal, { ownerId: owner, permissions: ["coding:start"], pools: ["shared"] });
		expect(await ask("coding:start", { pool: "shared" })).toEqual({ outcome: "allow" });
		await expect(ask("coding:start", { pool: "other" })).rejects.toMatchObject({ reason: "pool-not-granted" });
		// An Amp thread runs in an orb and takes no pool, so no grant needs one for it; the repository still has to be granted, however it is spelled.
		await authz.revokeCoding(f.admin.principal, owner, (await authz.codingGrants(owner)).find((g) => g.pools.includes("shared"))!.grantId);
		await expect(ask("coding:start", { harness: "amp", repository: "github.com/ajac-zero/pim" })).resolves.toEqual({ outcome: "allow" });
		await expect(ask("coding:start", { harness: "pi", repository: "github.com/ajac-zero/pim" })).rejects.toMatchObject({ name: "CapabilityUnavailableError" });
		await expect(ask("coding:start", { harness: "amp", repository: "github.com/elsewhere/x" })).rejects.toMatchObject({ reason: "repository-not-granted" });
		await expect(ask("coding:start", { harness: "amp", repository: "ajac-zero/pim" })).resolves.toEqual({ outcome: "allow" }); // host-less spelling of the same repository
		// The admin lists every live grant with its holder, and a revoked one is gone from the list and from the checks.
		const listed = await authz.listCodingGrants(f.admin.principal);
		expect(listed.filter((g) => g.ownerId === owner).map((g) => g.username)).toEqual(["linus"]);
		await expect(authz.listCodingGrants(linus.principal)).rejects.toMatchObject({ reason: "admin-only" });
		await authz.revokeCoding(f.admin.principal, owner, listed.find((g) => g.ownerId === owner)!.grantId);
		await expect(ask("coding:start", { harness: "amp", repository: "github.com/ajac-zero/pim" })).rejects.toMatchObject({ reason: "no-coding-grant" });
		await expect(authz.revokeCoding(f.admin.principal, owner, "cg_gone")).rejects.toMatchObject({ name: "NotFoundError" });
	});

	it("never grants coding to a guest, a missing account, an unknown permission or a malformed repository", async () => {
		const g = await member(f.app, f.admin.principal, "gus");
		const owner = g.account.ownerId;
		const authz = f.app.identity.authz;
		await expect(authz.grantCoding(f.admin.principal, { ownerId: owner, permissions: ["coding:start"] as never, repositories: ["not a repo"] })).rejects.toMatchObject({ name: "BadRequestError" });
		await expect(authz.grantCoding(f.admin.principal, { ownerId: owner, permissions: ["admin:grants"] as never, repositories: ["a/b"] })).rejects.toMatchObject({ name: "BadRequestError" });
		await expect(authz.grantCoding(f.admin.principal, { ownerId: "o_nobody", permissions: ["coding:start"], repositories: ["a/b"] })).rejects.toMatchObject({ name: "NotFoundError" });
		await f.db.owner(owner, (tx) => tx.query("UPDATE pim_app.accounts SET role = 'guest' WHERE owner_id = $1", [owner]));
		await expect(authz.grantCoding(f.admin.principal, { ownerId: owner, permissions: ["coding:start"], repositories: ["a/b"] })).rejects.toMatchObject({ name: "RefusedError" });
		expect(await authz.codingGrants(owner)).toEqual([]);
	});

	it("decides a delegated principal on its origin, so delegation never launders privilege", async () => {
		const h = await member(f.app, f.admin.principal, "heidi");
		const owner = h.account.ownerId;
		const authz = f.app.identity.authz;
		await authz.grantCoding(f.admin.principal, { ownerId: owner, permissions: ["coding:push"], repositories: ["github.com/heidi/*"] });
		await authz.grantStanding(f.admin.principal, { ownerId: owner, action: "coding:push", scope: repo("heidi/app") });
		const trusted = agentOf(owner, "trusted");
		const viaAgent = { principal: trusted, ownerId: owner, action: "coding:push", resource: repo("heidi/app") };
		expect(await authz.authorize(viaAgent)).toMatchObject({ outcome: "allow" });
		const delegated = (origin: Principal): Principal => ({ kind: "delegated", ownerId: OwnerId.parse(owner), delegateId: "task_1", originPrincipal: origin });
		// A read-only token asks the trusted agent's task to push: the origin's scope decides, and it has none for coding.
		const readOnly: Principal = { kind: "token", ownerId: OwnerId.parse(owner), role: "member", tokenId: "tok", scopes: ["api:read"] };
		await expect(authz.authorize({ ...viaAgent, principal: delegated(readOnly) })).rejects.toMatchObject({ reason: "scope" });
		// A guest cannot start coding by delegating to an agent.
		const guest: Principal = { kind: "user", ownerId: OwnerId.parse(owner), role: "guest", sessionId: "g" };
		await f.db.owner(owner, (tx) => tx.query("UPDATE pim_app.accounts SET role = 'guest' WHERE owner_id = $1", [owner]));
		await expect(authz.authorize({ ...viaAgent, principal: delegated(guest) })).rejects.toMatchObject({ reason: "guest" });
		await f.db.owner(owner, (tx) => tx.query("UPDATE pim_app.accounts SET role = 'member' WHERE owner_id = $1", [owner]));
		// An origin whose account is suspended stops what it started, even through a perfectly fine agent.
		const visitor = await member(f.app, f.admin.principal, "ivan");
		await f.app.identity.setStatus(f.admin.principal, visitor.account.ownerId, "suspended");
		await expect(authz.authorize({ ...viaAgent, principal: delegated(visitor.principal) })).rejects.toMatchObject({ reason: "suspended" });
		// A chain of delegations is decided on the first principal, however long.
		await expect(authz.authorize({ ...viaAgent, principal: delegated(delegated(readOnly)) })).rejects.toMatchObject({ reason: "scope" });
		// An origin from another owner cannot reach this owner's resources.
		const stranger = await member(f.app, f.admin.principal, "stranger");
		await expect(authz.authorize({ ...viaAgent, principal: delegated(stranger.principal) })).rejects.toMatchObject({ reason: "another-owner" });
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

	it("refuses names v1 refused: under 3 characters, odd hyphens, and the reserved ones that look official", async () => {
		await f.app.identity.setRegistrationOpen(f.admin.principal, true);
		for (const [name, reason] of [["ab", /3 to 32/], ["a--b", /single hyphens/], ["-ab", /single hyphens/], ["ab-", /single hyphens/], ["admin", /reserved/], ["support", /reserved/], ["x".repeat(33), /3 to 32/]] as const) {
			await expect(f.app.identity.register({ username: name })).rejects.toThrow(reason);
			expect(await f.app.signin.usernameAvailable(name)).toMatchObject({ available: false });
		}
		// Digits may lead, as in v1.
		expect((await f.app.identity.register({ username: "7seas" })).username).toBe("7seas");
	});

	it("follows PIM_REGISTRATION, PIM_MAX_ACCOUNTS and PIM_REGISTRATIONS_PER_ADDRESS, whatever the admin's switch says", async () => {
		const withEnv = (env: Record<string, string>) => new (f.app.constructor as typeof import("../src/app.ts").App)(f.db, f.store, { env });
		const invite = await f.app.identity.createInvite(f.admin.principal);
		const closed = withEnv({ PIM_REGISTRATION: "closed" });
		await expect(closed.identity.register({ username: "carla", invite })).rejects.toMatchObject({ code: "registration_closed" });
		await expect(closed.identity.setRegistrationOpen(f.admin.principal, true)).rejects.toMatchObject({ code: "registration_fixed" });
		// Open ignores invites, and the cap counts every account that is not deleted.
		const total = await f.db.anonymous(async (tx) => (await tx.query("SELECT count(*)::int AS n FROM pim_app.accounts WHERE status <> 'deleted'")).rows[0].n as number);
		const capped = withEnv({ PIM_REGISTRATION: "open", PIM_MAX_ACCOUNTS: String(total + 1) });
		expect((await capped.identity.register({ username: "carla" })).role).toBe("member");
		await expect(capped.identity.register({ username: "dora" })).rejects.toMatchObject({ status: 503, code: "full" });
		// A cap that cannot be read counts as none left, so a typo never lifts it.
		await expect(withEnv({ PIM_REGISTRATION: "open", PIM_MAX_ACCOUNTS: "lots" }).identity.register({ username: "dora" })).rejects.toMatchObject({ code: "full" });
		// Per address, a day; only registrations that were made count.
		const few = withEnv({ PIM_REGISTRATION: "open", PIM_REGISTRATIONS_PER_ADDRESS: "2" });
		await expect(few.identity.register({ username: "ed", address: "10.9.9.9" })).rejects.toThrow(/3 to 32/);
		await few.identity.register({ username: "eddie", address: "10.9.9.9" });
		await few.identity.register({ username: "edith", address: "10.9.9.9" });
		await expect(few.identity.register({ username: "edna", address: "10.9.9.9" })).rejects.toMatchObject({ status: 429 });
		await few.identity.register({ username: "edna", address: "10.9.9.10" });
	});

	it("lets a registration nobody made a passkey for lapse after a day, giving back its username, invite and place", async () => {
		await f.app.identity.setRegistrationOpen(f.admin.principal, false);
		const invite = await f.app.identity.createInvite(f.admin.principal);
		const longAgo = new Date(Date.now() - 25 * 3600_000);
		const lapsed = await f.app.identity.register({ username: "gone", invite, pending: true, now: longAgo });
		expect(lapsed.status).toBe("pending");
		// A pending account cannot act, and its day is up.
		await expect(f.app.identity.authz.requireLive(lapsed.ownerId)).rejects.toBeInstanceOf(ForbiddenError);
		await f.app.identity.activate(lapsed.ownerId);
		expect((await f.app.identity.authz.account(lapsed.ownerId))?.status).toBe("pending");
		// The next registration frees it: the same name and the same invite work for someone else.
		const again = await f.app.identity.register({ username: "gone", invite });
		expect(again.ownerId).not.toBe(lapsed.ownerId);
		expect(await f.app.identity.authz.account(lapsed.ownerId)).toBeNull();
		// A registration inside its day is held, and is the owner's once activated.
		const invite2 = await f.app.identity.createInvite(f.admin.principal);
		const held = await f.app.identity.register({ username: "holding", invite: invite2, pending: true });
		await expect(f.app.identity.register({ username: "holding", invite: invite2 })).rejects.toMatchObject({ code: "username_taken" });
		await f.app.identity.activate(held.ownerId);
		expect((await f.app.identity.authz.account(held.ownerId))?.status).toBe("active");
		await f.app.identity.setRegistrationOpen(f.admin.principal, true);
	});

	it("lists API tokens that were imported, lets them be revoked, and holds a person to 20", async () => {
		const u = await member(f.app, f.admin.principal, "tokenly");
		await f.app.identity.importLegacyToken(u.account.ownerId, "old phone", "legacy-hash");
		const names = async () => (await f.db.owner(u.account.ownerId, async (tx) => (await tx.query("SELECT name FROM pim_app.api_tokens WHERE revoked_at IS NULL")).rows)).map((r) => r.name);
		expect(await names()).toEqual(["old phone"]);
		for (let i = 1; i < 20; i++) await f.app.identity.createToken(u.principal, { name: `t${i}`, scopes: ["*"] });
		await expect(f.app.identity.createToken(u.principal, { name: "one too many", scopes: ["*"] })).rejects.toMatchObject({ status: 429 });
	});
});
