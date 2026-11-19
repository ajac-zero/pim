import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
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
