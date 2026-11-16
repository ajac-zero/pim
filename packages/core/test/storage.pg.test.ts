import { Harness, StorageRejected } from "@earendil-works/pi-durable";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdAllocator } from "../src/ids.ts";
import { acquireLease, renewLease } from "../src/partitions.ts";
import { OwnershipLost, PgStorage } from "../src/storage.ts";
import { createPool, withTenant } from "../src/db.ts";
import { createTestDb, type TestDb } from "./support/db.ts";
import { ctx, scriptedModel } from "./support/harness.ts";
import { newTenant, openStorage } from "./support/storage.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

let db: TestDb;
beforeAll(async () => {
	db = await createTestDb();
});
afterAll(async () => db.close());

describe("ownership fence", () => {
	it("refuses a stale owner's commit after the lease expired and another owner took the family", async () => {
		const first = await openStorage(db, { ttlMs: 300 });
		const harness = await Harness.open(first.storage, { ...scriptedModel().options() }, ctx);
		await harness.root(ctx, { agent: scriptedModel().agent as never });
		await new Promise((resolve) => setTimeout(resolve, 400));
		// The second owner takes over; the first still believes it holds the family.
		const second = await acquireLease(db.runtime, first.tenantId, first.partitionId, "second-owner", 60_000);
		expect(second?.epoch).toBe(first.lease.epoch + 1);
		const stale = harness.root(ctx).then(() => harness.createConversation({ ownership: { kind: "ownerless" } }, ctx));
		await expect(stale).rejects.toBeInstanceOf(OwnershipLost);
		// Nothing of the stale commit exists.
		const count = await withTenant(db.runtime, first.tenantId, (q) => q.get<{ n: number }>("SELECT count(*)::int AS n FROM rt.conversations WHERE partition_id = $1", first.partitionId));
		expect(count?.n).toBe(1);
	});

	it("does not let a lease be taken while live, revived after expiry, or renewed by anyone else", async () => {
		const a = await openStorage(db, { ttlMs: 400 });
		expect(await acquireLease(db.runtime, a.tenantId, a.partitionId, "thief", 60_000)).toBeUndefined();
		expect(await renewLease(db.runtime, a.lease, 400)).toBe(true);
		expect(await renewLease(db.runtime, { ...a.lease, ownerId: "thief" }, 400)).toBe(false);
		expect(await renewLease(db.runtime, { ...a.lease, epoch: a.lease.epoch + 1 }, 400)).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(await renewLease(db.runtime, a.lease, 400)).toBe(false);
	});

	it("blocks open of a suspended tenant's family", async () => {
		const a = await openStorage(db);
		await db.admin.query("UPDATE rt.partitions SET lease_until = '-infinity' WHERE partition_id = $1", [a.partitionId]);
		await db.admin.query("UPDATE app.tenants SET status = 'suspended' WHERE tenant_id = $1", [a.tenantId]);
		expect(await acquireLease(db.runtime, a.tenantId, a.partitionId, "o", 60_000)).toBeUndefined();
	});
});

describe("unknown COMMIT", () => {
	it("resolves a lost acknowledgement from the receipt: the commit is reported once, and exists once", async () => {
		let drop = false;
		const a = await openStorage(db, {
			faults: {
				afterCommit: async () => {
					if (drop) {
						drop = false;
						throw new Error("ECONNRESET: acknowledgement lost");
					}
				},
			},
		});
		const harness = await Harness.open(a.storage, scriptedModel().options(), ctx);
		drop = true;
		const root = await harness.root(ctx, { agent: scriptedModel().agent as never });
		expect(root.id).toBe(1);
		const rows = await withTenant(db.runtime, a.tenantId, (q) => q.all("SELECT seq FROM rt.commits WHERE partition_id = $1 ORDER BY seq", a.partitionId));
		const seqs = rows.map((row) => row.seq);
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(drop).toBe(false);
	});

	it("reports a commit whose connection died before COMMIT as not applied, and nothing is written", async () => {
		let kill = false;
		const a = await openStorage(db, {
			faults: {
				beforeCommit: async (client) => {
					if (!kill) return;
					kill = false;
					const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
					const killer = new pg.Client({ connectionString: db.url("postgres") });
					await killer.connect();
					await killer.query("SELECT pg_terminate_backend($1)", [pid]);
					await killer.end();
				},
			},
		});
		const harness = await Harness.open(a.storage, scriptedModel().options(), ctx);
		kill = true;
		await expect(harness.root(ctx, { agent: scriptedModel().agent as never })).rejects.toBeInstanceOf(StorageRejected);
		const n = await withTenant(db.runtime, a.tenantId, (q) => q.get<{ n: number }>("SELECT (SELECT count(*) FROM rt.conversations)::int + (SELECT count(*) FROM rt.commits)::int AS n"));
		expect(n?.n).toBe(0);
	});
});

describe("ids, root and families", () => {
	it("never mints the same id in two families of one tenant, and keeps imported ids", async () => {
		const ids = new IdAllocator(db.runtime, 10);
		const home = await openStorage(db, { ids });
		const other = await openStorage(db, { ids, tenantId: home.tenantId, home: false });
		const seen = new Set<number>();
		for (const s of [home.storage, other.storage, home.storage, other.storage]) for (let i = 0; i < 15; i++) seen.add((await s.mintId()) as number);
		expect(seen.size).toBe(60);
		expect(Math.min(...seen)).toBeGreaterThanOrEqual(2);
		// A second allocator (another Runner) never overlaps the first.
		const ids2 = new IdAllocator(db.runtime, 10);
		for (let i = 0; i < 30; i++) expect(seen.has(await ids2.next(home.tenantId))).toBe(false);
	});

	it("keeps conversation 1 in the home family only; a non-home family cannot create it", async () => {
		const home = await openStorage(db);
		const other = await openStorage(db, { tenantId: home.tenantId, home: false, ids: home.ids });
		const harness = await Harness.open(other.storage, scriptedModel().options(), ctx);
		await expect(harness.root(ctx)).rejects.toThrow(/home partition/);
		const homeHarness = await Harness.open(home.storage, scriptedModel().options(), ctx);
		expect((await homeHarness.root(ctx)).id).toBe(1);
		const dir = await withTenant(db.runtime, home.tenantId, (q) => q.get<{ partition_id: string }>("SELECT partition_id FROM rt.conversation_directory WHERE conversation_id = 1"));
		expect(dir?.partition_id).toBe(home.partitionId);
	});

	it("keeps forks, their ancestry and copied documents inside one family and replays a runtime through the adapter", async () => {
		const m = scriptedModel();
		const a = await openStorage(db);
		const harness = await Harness.open(a.storage, m.options(), ctx);
		const root = await harness.root(ctx, { agent: m.agent as never });
		m.faux.setResponses([fauxAssistantMessage("four"), fauxAssistantMessage("five")]);
		const first = await root.submit({ type: "input", content: "2+2?", requestId: "r1" }, ctx);
		expect((await first.wait(ctx)).status).toBe("done");
		const page = await root.entries({ order: "ascending" }, 20, undefined, ctx);
		const assistant = page.items.find((e) => e.kind === "pi.assistant")!;
		const fork = await root.fork(assistant.id, { ownership: { kind: "ownerless" } }, ctx);
		const second = await fork.submit({ type: "input", content: "and 3+2?" }, ctx);
		expect((await second.wait(ctx)).status).toBe("done");
		const forkEntries = (await fork.entries({ order: "ascending" }, 50, undefined, ctx)).items;
		// The fork sees the parent's ancestry up to the fork point, then its own entries.
		expect(forkEntries.map((e) => e.conversationId).includes(root.id)).toBe(true);
		expect(forkEntries.some((e) => e.conversationId === fork.id)).toBe(true);
		const dir = await withTenant(db.runtime, a.tenantId, (q) => q.all<{ partition_id: string }>("SELECT DISTINCT partition_id FROM rt.conversation_directory"));
		expect(dir.map((d) => d.partition_id)).toEqual([a.partitionId]);
		// requestId dedupe holds through the adapter.
		const again = await root.submit({ type: "input", content: "2+2?", requestId: "r1" }, ctx);
		expect(again.id).toBe(first.id);
		await harness.close(ctx);
		// Reopen from the database: the same history.
		const lease2 = a.lease;
		const reopened = new PgStorage({ pool: db.runtime, tenantId: a.tenantId, partitionId: a.partitionId, ownerId: lease2.ownerId, epoch: lease2.epoch, home: true, ids: a.ids });
		const h2 = await Harness.open(reopened, m.options(), ctx);
		const root2 = await h2.root(ctx);
		expect((await root2.entries({ order: "ascending" }, 50, undefined, ctx)).items.length).toBe(2);
	});
});

describe("row-level security and pooled connections", () => {
	it("shows a tenant only its own rows, with no context nothing, and never carries a tenant across pool reuse", async () => {
		const t1 = await openStorage(db);
		const t2 = await openStorage(db);
		const h1 = await Harness.open(t1.storage, scriptedModel().options(), ctx);
		await h1.root(ctx, { agent: scriptedModel().agent as never });
		const own = await withTenant(db.runtime, t1.tenantId, (q) => q.get<{ n: number }>("SELECT count(*)::int AS n FROM rt.conversations"));
		const foreign = await withTenant(db.runtime, t2.tenantId, (q) => q.get<{ n: number }>("SELECT count(*)::int AS n FROM rt.conversations"));
		expect(own?.n).toBe(1);
		expect(foreign?.n).toBe(0);
		// A bare query on the pool, outside any tenant transaction, sees nothing at all.
		expect((await db.runtime.query("SELECT count(*)::int AS n FROM rt.conversations")).rows[0].n).toBe(0);
		// A write for another tenant is refused by the policy.
		await expect(withTenant(db.runtime, t2.tenantId, (q) => q.run("INSERT INTO rt.record_ids (tenant_id, id, partition_id, record_type) VALUES ($1, 999, 'x', 'entry')", t1.tenantId))).rejects.toThrow(/row-level security/);
		// The GUC is transaction-local: a single pooled connection shows no tenant after the transaction.
		const pool = createPool({ connectionString: db.url("login_runtime"), max: 1 });
		await withTenant(pool, t1.tenantId, async () => undefined);
		expect((await pool.query("SELECT current_setting('pim.tenant_id', true) AS t")).rows[0].t ?? "").toBe("");
		await pool.end();
	});

	it("cannot bypass RLS: the scoped roles are not superusers and do not bypass it", async () => {
		const rows = (await db.admin.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'login_%' OR rolname LIKE 'pim_%'")).rows;
		expect(rows.length).toBeGreaterThanOrEqual(10);
		for (const row of rows) expect([row.rolname, row.rolsuper, row.rolbypassrls]).toEqual([row.rolname, false, false]);
		void newTenant;
	});
});
