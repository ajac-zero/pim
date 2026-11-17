import pg from "pg";
import { inject } from "vitest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, scopedDb } from "../src/db";
import { ForgeStore } from "../src/store";
import { ada, startReq, stack } from "./stack";

describe("row-level security for the Gate's role", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let gate: pg.Pool;
	let a: string;
	let b: string;

	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		await s.grantAll("bo");
		a = (await s.forge.start(ada, startReq("rls-a"))).threadId;
		b = (await s.forge.start({ ownerId: "bo", role: "member" }, startReq("rls-b"))).threadId;
		await s.pool.query("insert into pim_forge.forge_vault (owner_id, harness, version, sealed, byte_length) values ('ada','amp',1,'\\x01',1), ('bo','amp',1,'\\x02',1)");
		await s.pool.query("insert into pim_forge.forge_repo_settings (owner_id, repo, setup_script) values ('ada','acme/app','a'), ('bo','acme/app','b')");
		// A login that is a member of pim_gate and nothing else, with the table grants migration 0602 gives that role.
		await s.pool.query("create role rls_gate_login login nosuperuser nobypassrls password 'x' in role pim_gate");
		await s.pool.query("grant usage on schema pim_forge to pim_gate");
		await s.pool.query("grant select, insert, update, delete on all tables in schema pim_forge to pim_gate");
		await s.pool.query("grant usage, select on all sequences in schema pim_forge to pim_gate");
		const url = new URL((s.pool as any).options.connectionString);
		url.username = "rls_gate_login";
		url.password = "x";
		gate = new pg.Pool({ connectionString: url.toString(), max: 4 });
	});
	afterAll(async () => {
		await gate.end();
		await s.close();
	});

	it("shows the Gate's role nothing when no owner is set, and only that owner's rows when one is", async () => {
		const gdb = gate as unknown as Db;
		for (const table of ["forge_threads", "forge_vault", "forge_repo_settings", "forge_events", "forge_inbox"]) {
			expect((await gate.query(`select count(*) c from pim_forge.${table}`)).rows[0].c, table).toBe("0");
		}
		const mine = scopedDb(gdb, "ada");
		expect((await mine.query("select thread_id from pim_forge.forge_threads")).rows.map((r) => r.thread_id)).toEqual([a]);
		expect((await mine.query("select owner_id from pim_forge.forge_vault")).rows.map((r) => r.owner_id)).toEqual(["ada"]);
		expect((await mine.query("select setup_script from pim_forge.forge_repo_settings")).rows).toEqual([{ setup_script: "a" }]);
		// What hangs off a thread follows its owner.
		expect((await mine.query("select distinct thread_id from pim_forge.forge_inbox")).rows.map((r) => r.thread_id)).toEqual([a]);
		// Asking for someone else's row by key still finds nothing, and writing it changes nothing.
		expect((await mine.query("select * from pim_forge.forge_threads where thread_id = $1", [b])).rows).toEqual([]);
		expect((await mine.query("update pim_forge.forge_threads set task = 'hijacked' where thread_id = $1", [b])).rowCount).toBe(0);
		await expect(mine.query("insert into pim_forge.forge_threads (thread_id, owner_id, start_operation, harness, state, task, repo, created_by, gateway_nonce) values ('x','bo','x','pi','idle','t','r','c','n')")).rejects.toThrow(/row-level security/);
		expect((await s.pool.query("select task from pim_forge.forge_threads where thread_id = $1", [b])).rows[0].task).not.toBe("hijacked");
	});

	it("the worker's role, the owner and a Forge scoped to one owner behave as they must", async () => {
		// The owner (this superuser) sees everything; a scoped Forge on the Gate's role runs a person's whole request.
		expect((await s.pool.query("select count(*) c from pim_forge.forge_threads")).rows[0].c).toBe("2");
		const scopedForge = s.forge.scopedTo("ada");
		void scopedForge;
		const store = new ForgeStore(scopedDb(gate as unknown as Db, "ada"));
		expect((await store.get(a))!.ownerId).toBe("ada");
		expect(await store.get(b)).toBeNull();
	});
});
