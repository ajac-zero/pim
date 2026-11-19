import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { appStore, runtimeStore } from "../src/connector-credential.ts";
import { ConnectorService } from "../src/connector-service.ts";
import { notifyPass } from "../src/notifier.ts";
import { sweepApprovals, sweepErasures, tickSchedules, tickTriggers, trimForgeOutbox } from "../src/sweeps.ts";
import { createStack, type Stack } from "./support/stack.ts";

describe("maintenance sweeps", () => {
	let stack: Stack;
	let gate: App;
	let maintenance: App;
	let maintPool: pg.Pool;
	let owner: string;
	let chat: string;

	beforeAll(async () => {
		stack = await createStack();
		gate = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		maintenance = new App(connectApp(stack.url("maintenance"), 4), new MemoryObjectStore());
		maintPool = new pg.Pool({ connectionString: stack.url("maintenance"), max: 4 }).on("error", () => {});
		const account = await gate.identity.register({ username: "ada", bootstrap: await gate.identity.issueClaim("bootstrap", null, 3_600_000) });
		owner = account.ownerId;
		chat = await gate.conversations.create({ kind: "user", ownerId: account.ownerId, role: "admin", sessionId: "s" }, {});
	}, 120_000);
	afterAll(async () => {
		await maintPool?.end();
		await gate?.db.end();
		await maintenance?.db.end();
		await stack?.drop();
	});

	const file = (id: string, policy: "deny" | "approve", expiresAt: Date | null, taskId: number | null = 7) =>
		gate.db.owner(owner, (tx) => tx.query("INSERT INTO pim_app.approvals (id, owner_id, public_chat_id, tool, args, timeout_policy, expires_at) VALUES ($1,$2,$3,'t',$4,$5,$6)", [id, owner, chat, JSON.stringify(taskId === null ? {} : { taskId }), policy, expiresAt]));
	const commands = async () => (await stack.admin.query("SELECT command_id, kind, payload FROM pim_app.accepted_commands WHERE command_id LIKE 'approval:%' ORDER BY command_id")).rows;

	it("delivers a timed-out approval to the runtime as the outcome its policy says, once, and leaves the others alone", async () => {
		const past = new Date(Date.now() - 60_000);
		await file("ap_deny", "deny", past);
		await file("ap_approve", "approve", past);
		await file("ap_future", "deny", new Date(Date.now() + 3_600_000));
		await file("ap_notask", "deny", past, null);
		expect(await sweepApprovals(maintenance, maintPool)).toBe(2);
		const rows = await commands();
		expect(rows.map((r) => [r.command_id, r.kind, r.payload.approved, r.payload.taskId])).toEqual([["approval:ap_approve", "approval_decision", true, 7], ["approval:ap_deny", "approval_decision", false, 7]]);
		expect((await stack.admin.query("SELECT id, state FROM pim_app.approvals ORDER BY id")).rows).toEqual([
			{ id: "ap_approve", state: "timed_out_approved" },
			{ id: "ap_deny", state: "timed_out_denied" },
			{ id: "ap_future", state: "waiting" },
			{ id: "ap_notask", state: "timed_out_denied" },
		]);
		// They are in the Gate's inbox for the Runner's relay, and a second pass delivers nothing more.
		expect(Number((await stack.admin.query("SELECT count(*) n FROM pim_app.command_inbox WHERE command_id LIKE 'approval:%'")).rows[0].n)).toBe(2);
		expect(await sweepApprovals(maintenance, maintPool)).toBe(0);
	});

	it("trims Forge's outbox only past what Live has projected, and delivered wakes and costs once they are old", async () => {
		const q = (sql: string, v: unknown[] = []) => stack.admin.query(sql, v);
		await q("INSERT INTO pim_forge.forge_threads (thread_id, owner_id, start_operation, harness, state, task, repo, created_by, gateway_nonce) VALUES ('th1', $1, 'op', 'pi', 'idle', 't', 'acme/app', $1, 'n')", [owner]);
		for (const [key, topic] of [["a", "projection"], ["b", "projection"], ["c", "projection"], ["w", "wake"], ["x", "cost_ledger"]] as const) await q("INSERT INTO pim_forge.forge_outbox (topic, dedupe_key, thread_id, payload) VALUES ($1, $2, 'th1', '{}')", [topic, key]);
		await q("UPDATE pim_forge.forge_outbox SET delivered_at = now() - interval '30 days' WHERE dedupe_key = 'w'");
		// Live has projected the first two rows of this owner's Forge stream.
		const { forgePartitionId } = await import("../src/forge-source.ts");
		await q("INSERT INTO pim_projection.projection_watermarks (owner_id, partition_id, projection_version, projected_seq) VALUES ($1, $2, 1, 2)", [owner, forgePartitionId(owner)]);
		expect(await trimForgeOutbox(maintPool)).toBe(3);
		expect((await q("SELECT dedupe_key FROM pim_forge.forge_outbox ORDER BY owner_seq")).rows.map((r) => r.dedupe_key)).toEqual(["c", "x"]);
	});

	it("erases a deleted account's objects and rows in every schema, and nothing of anyone else's", async () => {
		const store = new MemoryObjectStore();
		const objects = new App(connectApp(stack.url("gate"), 2), store);
		await objects.identity.setRegistrationOpen({ kind: "user", ownerId: owner, role: "admin", sessionId: "s" } as never, true);
		const bob = await objects.identity.register({ username: "bob" });
		const bobPrincipal = { kind: "user", ownerId: bob.ownerId, role: "member", sessionId: "s2" } as never;
		const bobChat = await objects.conversations.create(bobPrincipal, { title: "mine" });
		const put = await objects.objects.put(bobPrincipal, { bytes: new Uint8Array([1, 2, 3]), contentType: "text/plain", purpose: "file" });
		const rows = async (who: string) => Number((await stack.admin.query("SELECT (SELECT count(*) FROM pim_app.conversations WHERE owner_id = $1) + (SELECT count(*) FROM pim_runtime.partitions WHERE owner_id = $1) + (SELECT count(*) FROM pim_runtime.conversation_partitions WHERE owner_id = $1) AS n", [who])).rows[0].n);
		expect(bobChat).toBeTruthy();
		// What the Runner would have written for the chat, in the runtime's schema, where the conversation map is immutable.
		const partition = (await stack.admin.query("SELECT partition_id FROM pim_app.conversations WHERE public_chat_id = $1", [bobChat])).rows[0].partition_id;
		await stack.admin.query("INSERT INTO pim_runtime.partitions (owner_id, partition_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [bob.ownerId, partition]);
		await stack.admin.query("INSERT INTO pim_runtime.conversation_partitions (owner_id, conversation_id, partition_id, public_chat_id) VALUES ($1, 77, $2, $3)", [bob.ownerId, partition, bobChat]);
		expect(await rows(bob.ownerId)).toBeGreaterThan(1);
		const adaRows = await rows(owner);
		// Until the account is deleted, nothing is erased.
		expect(await sweepErasures(maintenance, maintPool, store)).toEqual([]);
		await objects.identity.deleteSelf(bobPrincipal);
		expect(await sweepErasures(maintenance, maintPool, store)).toEqual([bob.ownerId]);
		expect(await store.head(put.key)).toBeNull();
		expect(await rows(bob.ownerId)).toBe(0);
		expect((await stack.admin.query("SELECT status FROM pim_app.accounts WHERE owner_id = $1", [bob.ownerId])).rows[0].status).toBe("deleted");
		expect(await rows(owner)).toBe(adaRows);
		expect(await sweepErasures(maintenance, maintPool, store)).toEqual([]);
		await objects.db.end();
	});

	it("revokes a deleted account's Gmail grant at Google before erasing it, and an account still there keeps its grant", async () => {
		const store = new MemoryObjectStore();
		const objects = new App(connectApp(stack.url("gate"), 2), store);
		await objects.identity.setRegistrationOpen({ kind: "user", ownerId: owner, role: "admin", sessionId: "s" } as never, true);
		const grants: { who: string; owner: string }[] = [];
		const connectGmail = async (username: string) => {
			const account = await objects.identity.register({ username });
			const person = { kind: "user", ownerId: account.ownerId, role: "member", sessionId: `s-${username}` } as never;
			const { connector } = await objects.connectors.create(person, { kind: "native", name: "Gmail" });
			await objects.db.owner(account.ownerId, (tx) => tx.query("UPDATE pim_app.connectors SET app_ref = 'google/gmail' WHERE id = $1", [connector.id]));
			await objects.connectors.setCredential(account.ownerId, connector.id, JSON.stringify({ access_token: "access", refresh_token: `${username}-refresh` }));
			grants.push({ who: `${username}-refresh`, owner: account.ownerId });
			return { account, person };
		};
		const [carol, dave] = [await connectGmail("carol"), await connectGmail("dave")];
		const revoked: string[] = [];
		const fetcher = (async (url: string, init: RequestInit) => {
			revoked.push(`${url} ${init.body}`);
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;
		const service = new ConnectorService(objects, { PIM_GOOGLE_REVOKE_URL: "https://google.test/revoke" }, { fetch: fetcher, allowPrivate: true, check: async (u) => new URL(u) });
		await objects.identity.deleteSelf(carol.person);
		expect(await sweepErasures(maintenance, maintPool, store, 5, (who) => service.revokeAll(who))).toEqual([carol.account.ownerId]);
		expect(revoked).toEqual(["https://google.test/revoke token=carol-refresh"]);
		expect(dave.account.ownerId).not.toBe(carol.account.ownerId);
		// Google not answering does not stop the erasure.
		const failing = new ConnectorService(objects, { PIM_GOOGLE_REVOKE_URL: "https://google.test/revoke" }, { fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch, allowPrivate: true, check: async (u) => new URL(u) });
		await objects.identity.deleteSelf(dave.person);
		expect(await sweepErasures(maintenance, maintPool, store, 5, (who) => failing.revokeAll(who))).toEqual([dave.account.ownerId]);
		await objects.db.end();
	});

	it("writes a renewed credential only over the one it read, marks a lost sign-in, and tells the person once", async () => {
		const ada = { kind: "user", ownerId: owner, role: "admin", sessionId: "s" } as never;
		const { connector } = await gate.connectors.create(ada, { kind: "native", name: "Drive" });
		await gate.connectors.setCredential(owner, connector.id, JSON.stringify({ access_token: "one" }));
		const sealed = async () => (await stack.admin.query("SELECT credential FROM pim_app.connectors WHERE id = $1", [connector.id])).rows[0].credential as string | null;
		const first = (await sealed())!;
		for (const store of [appStore(gate), runtimeStore(stack.runtime)]) {
			expect(await store.current(owner, connector.id)).toBe(await sealed());
			expect(await store.current(owner, "cn_missing")).toBeUndefined();
			// A renewal that began on another credential writes nothing.
			expect(await store.replace(owner, connector.id, "sealed:other", "sealed:renewed")).toBe(false);
			expect(await store.lose(owner, connector.id, "sealed:other", "Sign in again")).toBe(false);
			expect(await sealed()).toBe(first);
		}
		expect(await appStore(gate).replace(owner, connector.id, first, "sealed:next")).toBe(true);
		expect(await sealed()).toBe("sealed:next");
		expect(await runtimeStore(stack.runtime).lose(owner, connector.id, "sealed:next", "Sign in again: Token has been expired or revoked.")).toBe(true);
		expect((await stack.admin.query("SELECT credential, status, auth_url, error FROM pim_app.connectors WHERE id = $1", [connector.id])).rows[0]).toEqual({ credential: null, status: "auth_required", auth_url: null, error: "Sign in again: Token has been expired or revoked." });
		const connectors = await new ConnectorService(gate, {}, { fetch, allowPrivate: true, check: async (u) => new URL(u) }).list(ada, []);
		expect(connectors.find((c) => c.id === connector.id)).toMatchObject({ state: "failed", authUrl: null });
		// The person is told, once.
		const options = { vapid: null, subject: "mailto:x@example.test", allowPrivate: true };
		expect(await notifyPass(maintenance, maintPool, options as never)).toBeGreaterThanOrEqual(1);
		const told = (await stack.admin.query("SELECT title FROM pim_app.notifications WHERE owner_id = $1 AND id LIKE $2", [owner, `connector-${connector.id}-%`])).rows;
		expect(told).toEqual([{ title: "Drive needs you to sign in again" }]);
		await notifyPass(maintenance, maintPool, options as never);
		expect((await stack.admin.query("SELECT count(*)::int AS n FROM pim_app.notifications WHERE owner_id = $1 AND id LIKE $2", [owner, `connector-${connector.id}-%`])).rows[0].n).toBe(1);
	});

	it("fires a due schedule and a due time trigger once each, from the owners that have them, into chats of their own", async () => {
		const ada = { kind: "user", ownerId: owner, role: "admin", sessionId: "s" } as never;
		const agent = await gate.agents.create(ada, { name: "Clock" });
		await gate.schedules.create(ada, { kind: "delay", spec: "1000", prompt: "stretch", target: "new_chat", agentId: agent.id });
		const at = Date.now() + 2_000;
		const trigger = await gate.triggers.create(ada, { spec: { version: 1, owningAgentId: agent.id, originChatId: "api", label: "Once", instruction: "say hi", source: { kind: "time", schedule: "once", at }, condition: null, destination: { type: "new_chat" }, delivery: {}, authorizationRef: null } });
		await gate.triggers.setLifecycle(ada, trigger.id, "enabled");
		// Before either is due nothing fires; the owner is found from the schedule's wakeup and from the trigger's own row.
		expect(await tickSchedules(maintenance)).toBe(0);
		expect(await tickTriggers(maintenance, maintPool)).toBe(0);
		const later = new Date(Date.now() + 10_000);
		expect(await tickSchedules(maintenance, later)).toBe(1);
		expect(await tickTriggers(maintenance, maintPool, later)).toBe(1);
		// A second pass fires nothing more, and each made a chat of kind trigger that waits in the command inbox for a Runner.
		expect(await tickSchedules(maintenance, later)).toBe(0);
		expect(await tickTriggers(maintenance, maintPool, later)).toBe(0);
		const made = (await stack.admin.query("SELECT c.kind, a.kind AS command FROM pim_app.conversations c JOIN pim_app.accepted_commands a ON a.public_chat_id = c.public_chat_id WHERE c.owner_id = $1 AND c.kind = 'trigger' ORDER BY a.accepted_at", [owner])).rows;
		expect(made).toEqual([{ kind: "trigger", command: "trigger_fire" }, { kind: "trigger", command: "trigger_fire" }]);
		expect((await gate.triggers.runs(ada, trigger.id)).map((r) => r.phase)).toEqual(["fired"]);
		expect((await gate.triggers.get(ada, trigger.id)).lifecycle).toBe("ended");
	});

	it("keeps a firing the space cannot run yet, says so in the trigger's health and hands it on later, ends one whose agent is gone without stopping the others, and starts a condition over when the trigger changes", async () => {
		const ada = { kind: "user", ownerId: owner, role: "admin", sessionId: "s" } as never;
		await gate.identity.setRegistrationOpen(ada, true);
		const bob = await gate.identity.register({ username: "budgeted" });
		const o = bob.ownerId;
		const u = { kind: "user", ownerId: o, role: "member", sessionId: "budgeted-session" } as never;
		// A member's runs count against the day's limit, which the deployed processes switch on.
		const limited = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore()).limitSpaces();
		const cron = (agentId: string, source: unknown, extra: object = {}) => ({ version: 1, owningAgentId: agentId, originChatId: "api", label: "Hourly", instruction: "check in", source, condition: null, destination: { type: "new_chat" }, delivery: {}, authorizationRef: null, ...extra });
		const hourly = { kind: "time", schedule: "cron", expression: "0 * * * *", timeZone: "UTC" };
		const agent = await limited.agents.create(u, { name: "Blocked" });
		const gone = await limited.agents.create(u, { name: "Gone" });
		const t = await limited.triggers.create(u, { spec: cron(agent.id, hourly) });
		const orphan = await limited.triggers.create(u, { spec: cron(gone.id, hourly) });
		const once = await limited.triggers.create(u, { spec: cron(agent.id, { kind: "time", schedule: "once", at: Date.parse("2026-11-16T10:00:00Z"), maxLatenessMs: 3_600_000 }) });
		for (const x of [t, orphan, once]) await limited.triggers.setLifecycle(u, x.id, "enabled", new Date("2026-11-16T00:00:00Z"));
		await limited.agents.remove(u, gone.id);
		const health = async (id: string) => (await stack.admin.query("SELECT health, health_detail FROM pim_app.triggers WHERE id = $1", [id])).rows[0] as { health: string; health_detail: string | null };
		expect(await health(orphan.id)).toMatchObject({ health: "configuration_error", health_detail: expect.stringContaining("agent was deleted") });
		await limited.db.owner(o, (tx) => limited.quota.setOverride(tx, o, { dailyRuns: 0 }));
		// Nothing may run today: the firings wait (the one-time trigger's only firing is kept), the health says why, and the tick still goes through every trigger.
		await limited.triggers.tickTime(o, new Date("2026-11-16T10:01:00Z"));
		expect((await limited.triggers.runs(u, t.id)).map((r) => r.phase)).toEqual(["pending"]);
		expect((await limited.triggers.runs(u, once.id)).map((r) => r.phase)).toEqual(["pending"]);
		expect(await health(t.id)).toMatchObject({ health: "budget_blocked" });
		expect((await limited.triggers.runs(u, orphan.id)).map((r) => [r.phase, r.error])).toEqual([["failed", expect.stringContaining("agent was deleted")]]);
		expect(await health(orphan.id)).toMatchObject({ health: "configuration_error" });
		// Still blocked a while later; once the limit is lifted, the firings go out and the health is well again.
		expect(await limited.triggers.deliverPending(o, new Date("2026-11-16T10:30:00Z"))).toBe(0);
		await limited.db.owner(o, (tx) => limited.quota.setOverride(tx, o, null));
		expect(await limited.triggers.deliverPending(o, new Date("2026-11-16T10:31:00Z"))).toBe(2);
		expect((await limited.triggers.runs(u, t.id)).map((r) => r.phase)).toEqual(["fired"]);
		expect((await limited.triggers.runs(u, once.id)).map((r) => r.phase)).toEqual(["fired"]);
		expect(await health(t.id)).toMatchObject({ health: "healthy" });
		// A firing that waited past its deadline is never handed on.
		await limited.db.owner(o, (tx) => limited.quota.setOverride(tx, o, { dailyRuns: 0 }));
		await limited.triggers.tickTime(o, new Date("2026-11-16T12:01:00Z"));
		expect(await limited.triggers.deliverPending(o, new Date(Date.now() + 25 * 3_600_000))).toBe(0);
		expect((await limited.triggers.runs(u, t.id)).map((r) => r.phase).sort()).toEqual(["failed", "fired"]);

		// A condition's memory goes with a change of the trigger, or a pause: an edited threshold never inherits an old edge.
		const poll = cron(agent.id, { kind: "poll", command: "price-check", intervalMs: 300_000 }, { condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 500 } } });
		const p = await limited.triggers.create(u, { spec: poll });
		const remembered = async () => (await stack.admin.query("SELECT condition_state FROM pim_app.triggers WHERE id = $1", [p.id])).rows[0].condition_state;
		const remember = () => stack.admin.query("UPDATE pim_app.triggers SET condition_state = '{\"version\":1}' WHERE id = $1", [p.id]);
		await remember();
		await limited.triggers.update(u, p.id, { spec: { ...poll, condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 400 } } } });
		expect(await remembered()).toBeNull();
		await remember();
		await limited.triggers.update(u, p.id, { spec: { ...poll, condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 400 } } } });
		expect(await remembered()).not.toBeNull(); // nothing changed
		await stack.admin.query("UPDATE pim_app.triggers SET lifecycle = 'enabled' WHERE id = $1", [p.id]);
		await limited.triggers.setLifecycle(u, p.id, "paused");
		expect(await remembered()).toBeNull();
		await limited.db.end();
	});

	it("runs a trigger one turn at a time: an occurrence waits behind the running turn, a full trigger turns the source away, and a state keeps only its newest", async () => {
		const ada = { kind: "user", ownerId: owner, role: "admin", sessionId: "s" } as never;
		const agent = await gate.agents.create(ada, { name: "Serial" });
		const spec = (source: object, condition: object | null, delivery: object) => ({ version: 1, owningAgentId: agent.id, originChatId: "api", label: "Serial", instruction: "go", source, condition, destination: { type: "new_chat" }, delivery, authorizationRef: null });
		const stream = await gate.triggers.create(ada, { spec: spec({ kind: "stream", command: "tail -f log", cwd: null }, { when: { op: "exists", path: ["n"] } }, { maxPendingEvents: 2 }) });
		const phases = async (id: string) => Object.fromEntries((await gate.triggers.runs(ada, id)).map((r) => [r.id.split(":").slice(3).join(":"), r.phase]));
		const commit = (id: string, eventId: string, secondsAgo = 60) => stack.admin.query("UPDATE pim_app.accepted_commands SET state = 'runtime_committed', committed_at = now() - make_interval(secs => $3) WHERE command_id = $1 AND owner_id = $2", [`trigger:${id}:computer:${eventId}`, owner, secondsAgo]);
		const fire = (id: string, eventId: string) => gate.triggers.fireOccurrence(owner, id, `computer:${eventId}`, { source: "stream", eventId });
		// Switched on (a computer source needs a grant to be, which this does not test).
		await stack.admin.query("UPDATE pim_app.triggers SET lifecycle = 'enabled' WHERE owner_id = $1 AND id = $2", [owner, stream.id]);
		let busy = new Set<string>();
		gate.triggers.chatBusy = async (_owner, chats) => new Set(chats.filter((c) => busy.has(c)));

		// The first goes to a chat; while its command waits for a Runner the next two wait behind it, and a fourth finds no room and is not recorded, so its source offers it again.
		expect(await fire(stream.id, "e1")).toBe("fired");
		expect(await fire(stream.id, "e2")).toBe("queued");
		expect(await fire(stream.id, "e3")).toBe("queued");
		expect(await fire(stream.id, "e4")).toBe("full");
		expect(await fire(stream.id, "e2")).toBe("duplicate");
		expect(await phases(stream.id)).toEqual({ e1: "fired", e2: "pending", e3: "pending" });
		expect(await gate.triggers.deliverPending(owner)).toBe(0);

		// The Runner took the first and its chat is working: still going. Once the chat is idle the run is over, and the next waiting occurrence goes, one at a time.
		await commit(stream.id, "e1");
		const chatOf = async (eventId: string) => (await stack.admin.query("SELECT public_chat_id FROM pim_app.accepted_commands WHERE command_id = $1", [`trigger:${stream.id}:computer:${eventId}`])).rows[0]?.public_chat_id as string;
		busy = new Set([await chatOf("e1")]);
		expect(await gate.triggers.deliverPending(owner)).toBe(0);
		busy = new Set();
		expect(await gate.triggers.deliverPending(owner)).toBe(1);
		expect(await phases(stream.id)).toEqual({ e1: "completed", e2: "fired", e3: "pending" });
		expect(await chatOf("e2")).toBeTruthy();
		expect(await gate.triggers.deliverPending(owner)).toBe(0);
		await commit(stream.id, "e2");
		expect(await gate.triggers.deliverPending(owner)).toBe(1);
		expect(await phases(stream.id)).toEqual({ e1: "completed", e2: "completed", e3: "fired" });
		// A refused command failed; a run nothing has said anything of for a day is of unknown outcome.
		await stack.admin.query("UPDATE pim_app.accepted_commands SET state = 'rejected' WHERE command_id = $1", [`trigger:${stream.id}:computer:e3`]);
		expect(await gate.triggers.settle(owner, stream.id)).toBe(false);
		expect((await phases(stream.id)).e3).toBe("failed");

		// A state keeps one waiting snapshot: the newer replaces the older, which is recorded as superseded.
		const poll = await gate.triggers.create(ada, { spec: spec({ kind: "poll", command: "date", cwd: null, intervalMs: 60_000, deadlineMs: 10_000 }, { when: { op: "exists", path: ["n"] } }, {}) });
		const poked = (eventId: string) => gate.triggers.fireOccurrence(owner, poll.id, `computer:${eventId}`, { source: "poll", eventId });
		expect([await poked("p1"), await poked("p2"), await poked("p3")]).toEqual(["fired", "queued", "queued"]);
		expect(await phases(poll.id)).toEqual({ p1: "fired", p2: "skipped", p3: "pending" });
		expect((await gate.triggers.runs(ada, poll.id)).find((r) => r.phase === "skipped")!.detail).toMatchObject({ reason: "superseded" });
	});
});
