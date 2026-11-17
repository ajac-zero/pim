import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { sweepApprovals, sweepErasures, trimForgeOutbox } from "../src/sweeps.ts";
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
});
