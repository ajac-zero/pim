import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { StorageRejected, type ConversationId, type EntryId } from "@earendil-works/pi-durable";
import { PartitionDirectory } from "../src/directory.ts";
import { IdAllocator, leaseIdBlock, seedIdHighWater } from "../src/ids.ts";
import { migrate } from "../src/migrate.ts";
import { Steward } from "../src/ownership.ts";
import { PgPiStorage } from "../src/storage.ts";
import { createTestDatabase, type TestDatabase } from "./support/pg.ts";
import { openTestPartition, uniqueTenant } from "./support/partition.ts";
import { waitFor } from "./support/rig.ts";

const ctx = BACKGROUND_CONTEXT;
let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(async () => {
	await database.drop();
});

const conversation = (id: number, parent?: { conversationId: number; at: number }) => ({ type: "conversation" as const, value: { id: id as ConversationId, ...(parent === undefined ? {} : { parent: { conversationId: parent.conversationId as ConversationId, at: parent.at as EntryId } }) } });
const entry = (id: number, conversationId: number, extra: object = {}) => ({ type: "entry" as const, value: { id: id as EntryId, conversationId: conversationId as ConversationId, kind: "note", ...extra } });

describe("migrations", () => {
	it("apply once, are recorded with their checksum, and refuse a changed file", async () => {
		expect((await migrate(database.db.pool)).applied).toEqual([]);
		const names = (await database.db.pool.query<{ name: string }>("SELECT name FROM pim_runtime.schema_migrations ORDER BY name")).rows.map((r) => r.name);
		expect(names).toEqual(["0100_pi_runtime_schema.sql", "0101_pi_conversations_entries.sql", "0102_pi_tasks_submissions.sql", "0103_pi_documents.sql", "0104_pi_commit_receipts_outbox.sql", "0105_runtime_ownership_and_inbox.sql"]);
		const dir = mkdtempSync(join(tmpdir(), "pim-mig-"));
		writeFileSync(join(dir, "0100_pi_runtime_schema.sql"), "select 1;");
		await expect(migrate(database.db.pool, dir)).rejects.toThrow(/changed after it was applied/);
	});

	it("applies concurrently from several Runners without conflict", async () => {
		const fresh = await createTestDatabase();
		try {
			await fresh.db.pool.query("DROP SCHEMA pim_runtime CASCADE");
			const pools = [0, 1, 2, 3].map(() => new pg.Pool({ connectionString: fresh.url, max: 1 }));
			const results = await Promise.all(pools.map((pool) => migrate(pool)));
			expect(results.reduce((n, r) => n + r.applied.length, 0)).toBe(6);
			await Promise.all(pools.map((pool) => pool.end()));
		} finally {
			await fresh.drop();
		}
	});
});

describe("tenant isolation", () => {
	it("row-level security hides other tenants from a non-superuser connection and rejects cross-tenant writes", async () => {
		const a = await openTestPartition(database.db);
		const b = await openTestPartition(database.db);
		await a.storage.commit([conversation(2), entry(3, 2, { data: "secret of A" })], ctx);
		const app = database.appPool();
		const client = await app.connect();
		try {
			await client.query("SELECT set_config('pim.tenant_id', $1, false)", [b.tenantId]);
			expect((await client.query("SELECT * FROM pim_runtime.entries")).rowCount).toBe(0);
			await client.query("SELECT set_config('pim.tenant_id', $1, false)", [a.tenantId]);
			expect((await client.query("SELECT * FROM pim_runtime.entries")).rowCount).toBe(1);
			await expect(client.query("INSERT INTO pim_runtime.record_ids (tenant_id, id, kind, partition_id) VALUES ($1, 99, 'entry', $2)", [b.tenantId, b.partitionId])).rejects.toThrow(/row-level security/);
			await client.query("SELECT set_config('pim.tenant_id', '', false)");
			expect((await client.query("SELECT * FROM pim_runtime.entries")).rowCount).toBe(0); // no tenant, no rows
		} finally {
			client.release();
		}
	});

	it("never reads another tenant's records through the storage even for the same ids", async () => {
		const a = await openTestPartition(database.db);
		const b = await openTestPartition(database.db);
		await a.storage.commit([conversation(2), entry(3, 2, { data: "A" })], ctx);
		await b.storage.commit([conversation(2), entry(3, 2, { data: "B" })], ctx); // ids are per tenant
		expect((await a.storage.entry(3 as EntryId, ctx))?.entry.data).toBe("A");
		expect((await b.storage.entry(3 as EntryId, ctx))?.entry.data).toBe("B");
	});
});

describe("partition directory and the home rule", () => {
	it("allows one home partition per tenant and keeps conversation 1 out of every other partition", async () => {
		const directory = new PartitionDirectory(database.db);
		const tenantId = uniqueTenant();
		const home = await directory.ensureHome(tenantId);
		expect(await directory.ensureHome(tenantId)).toBe(home);
		await expect(directory.createPartition(tenantId, { partitionId: "second-home", kind: "home" })).rejects.toThrow(/partitions_one_home/);
		const family = await directory.createPartition(tenantId);
		await expect(directory.createPartition(tenantId, { partitionId: family, kind: "home" })).rejects.toThrow(/another kind/);
		// The database refuses a directory row for conversation 1 in a family partition.
		await expect(database.db.read(tenantId, "INSERT INTO pim_runtime.conversation_partitions (tenant_id, conversation_id, partition_id) VALUES ($1, 1, $2)", [tenantId, family])).rejects.toThrow(/home partition/);
		// And the storage refuses the commit that would create it, before anything is written.
		const part = await openTestPartition(database.db, { tenantId, partitionId: family, kind: "family" });
		await expect(part.storage.commit([conversation(1)], ctx)).rejects.toBeInstanceOf(StorageRejected);
		expect((await database.db.read(tenantId, "SELECT 1 FROM pim_runtime.record_ids WHERE tenant_id = $1 AND id = 1", [tenantId])).rowCount).toBe(0);
		// Routing: conversation 1 is home, others come from the directory, and a row cannot be moved.
		expect(await directory.routeConversation(tenantId, "1")).toBe(home);
		await part.storage.commit([conversation(40)], ctx);
		expect(await directory.routeConversation(tenantId, 40)).toBe(family);
		await expect(database.db.read(tenantId, "UPDATE pim_runtime.conversation_partitions SET partition_id = $2 WHERE tenant_id = $1 AND conversation_id = 40", [tenantId, home])).rejects.toThrow(/immutable/);
		const uuid = "7b5c0f0e-2f4e-4c4a-9a43-6b9b0b0f6a11";
		await directory.registerPublicChat(tenantId, uuid, 40);
		expect(await directory.routeChat(tenantId, uuid)).toEqual({ partitionId: family, conversationId: 40 });
	});

	it("rejects records that name a conversation outside their partition, so a family cannot straddle partitions", async () => {
		const tenantId = uniqueTenant();
		const home = await openTestPartition(database.db, { tenantId, kind: "home" });
		const family = await openTestPartition(database.db, { tenantId, kind: "family", partitionId: "fam" });
		await home.storage.commit([conversation(2), entry(3, 2)], ctx);
		await expect(family.storage.commit([conversation(4, { conversationId: 2, at: 3 })], ctx)).rejects.toThrow(/Conversation 2 is not in partition fam/);
		await expect(family.storage.commit([entry(5, 2)], ctx)).rejects.toThrow(/not in partition/);
		await expect(family.storage.commit([conversation(3)], ctx)).rejects.toThrow(/already belongs to entry/); // ids are one tenant-wide namespace
		await expect(family.storage.entry(3 as EntryId, ctx)).resolves.toBeUndefined();
	});
});

describe("leases", () => {
	it("a heartbeat keeps a short lease alive, and a steal makes the next renewal fail and abort the owner", async () => {
		const tenantId = uniqueTenant();
		const partitionId = await new PartitionDirectory(database.db).createPartition(tenantId, { kind: "home" });
		const steward = new Steward({ db: database.db, ownerId: "heart", leaseTtlMs: 700, renewEveryMs: 150, safetyMarginMs: 100 });
		const lease = (await steward.acquire(tenantId, partitionId))!;
		lease.startHeartbeat();
		await new Promise((resolve) => setTimeout(resolve, 1_600)); // more than two TTLs
		expect(lease.isLocallyValid()).toBe(true);
		const storage = await PgPiStorage.openForOwner({ db: database.db, fence: lease });
		await storage.commit([conversation(2)], ctx);
		// Another owner takes the row at a higher epoch (as after a long pause).
		await database.db.read(tenantId, "UPDATE pim_runtime.partitions SET owner_id = 'thief', owner_epoch = owner_epoch + 1 WHERE tenant_id = $1", [tenantId]);
		await waitFor("the owner to notice", () => (lease.lostReason !== undefined ? true : undefined), 3_000);
		expect(lease.signal.aborted).toBe(true);
		await expect(storage.commit([conversation(3)], ctx)).rejects.toBeInstanceOf(StorageRejected);
	});

	it("only one of several concurrent claimants takes a free partition", async () => {
		const tenantId = uniqueTenant();
		const partitionId = await new PartitionDirectory(database.db).createPartition(tenantId, { kind: "home" });
		const stewards = Array.from({ length: 8 }, (_, i) => new Steward({ db: database.db, ownerId: `s${i}`, leaseTtlMs: 5_000 }));
		const leases = (await Promise.all(stewards.map((s) => s.acquire(tenantId, partitionId)))).filter((l) => l !== undefined);
		expect(leases).toHaveLength(1);
		expect(leases[0]?.epoch).toBe(1);
		// claimNext uses SKIP LOCKED: many claimants each take a different needs-owner partition.
		const t2 = uniqueTenant();
		for (let i = 0; i < 4; i++) await new PartitionDirectory(database.db).createPartition(t2, i === 0 ? { kind: "home" } : {});
		const claimed = (await Promise.all(Array.from({ length: 6 }, () => new Steward({ db: database.db, ownerId: `c${Math.random()}`, leaseTtlMs: 5_000 }).claimNext({ tenantId: t2 })))).filter((l) => l !== undefined);
		expect(claimed).toHaveLength(4);
		expect(new Set(claimed.map((l) => l.partitionId)).size).toBe(4);
	});
});

describe("commit outbox and receipts", () => {
	it("writes the receipt and outbox row in the commit's own transaction, and notifies only after it commits", async () => {
		const part = await openTestPartition(database.db);
		const listener = new pg.Client({ connectionString: database.url });
		await listener.connect();
		await listener.query("LISTEN pim_runtime_outbox");
		const seen: { tenantId: string; partitionId: string; seq: number }[] = [];
		listener.on("notification", (n) => seen.push(JSON.parse(n.payload ?? "{}")));
		const seq = await part.storage.commit([conversation(2), entry(3, 2)], ctx);
		const rejected = await part.storage.commit([conversation(2)], ctx).catch((e: unknown) => e);
		expect(rejected).toBeInstanceOf(StorageRejected);
		await waitFor("the notification", () => (seen.length > 0 ? true : undefined));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(seen).toEqual([{ tenantId: part.tenantId, partitionId: part.partitionId, seq }]); // none for the failed commit
		const outbox = await database.db.read<{ seq: string; changes: string }>(part.tenantId, "SELECT seq, changes FROM pim_runtime.runtime_outbox WHERE tenant_id = $1 ORDER BY seq", [part.tenantId]);
		expect(outbox.rows.map((r) => Number(r.seq))).toEqual([seq]);
		expect(JSON.parse(outbox.rows[0]!.changes)).toEqual([{ type: "conversation", id: 2 }, { type: "entry", id: 3, conversationId: 2, kind: "note" }]);
		const receipts = await database.db.read(part.tenantId, "SELECT 1 FROM pim_runtime.commit_receipts WHERE tenant_id = $1 AND commit_seq = $2", [part.tenantId, seq]);
		expect(receipts.rowCount).toBe(1);
		await listener.end();
	});
});

describe("tenant-wide id allocation", () => {
	it("leases disjoint blocks to concurrent owners, with gaps allowed, and starts above an imported high-water mark", async () => {
		const tenantId = uniqueTenant();
		await seedIdHighWater(database.db, tenantId, 5_000);
		const blocks = await Promise.all(Array.from({ length: 20 }, () => leaseIdBlock(database.db, tenantId, 64)));
		const sorted = blocks.map((b) => b.first).sort((x, y) => x - y);
		expect(sorted[0]).toBe(5_001);
		for (const b of blocks) expect(b.last - b.first + 1).toBe(64);
		expect(new Set(sorted).size).toBe(20);
		for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBe(64); // contiguous across owners: no overlap
		// Allocators minting concurrently never collide, and each draws from the shared row once per block.
		const allocators = Array.from({ length: 6 }, () => new IdAllocator(database.db, tenantId, () => undefined, 32));
		const ids = (await Promise.all(allocators.flatMap((a) => Array.from({ length: 100 }, () => a.mint<never>() as Promise<number>)))).flat();
		expect(new Set(ids).size).toBe(600);
		const leased = await database.db.read(tenantId, "SELECT 1 FROM pim_runtime.id_blocks WHERE tenant_id = $1", [tenantId]);
		expect(leased.rowCount).toBe(20 + 6 * 4); // 100 ids per allocator is four 32-id blocks
	});

	it("hands out the last ids below 2^53 and then reports exhaustion instead of overflowing", async () => {
		const tenantId = uniqueTenant();
		await seedIdHighWater(database.db, tenantId, Number.MAX_SAFE_INTEGER - 10);
		const block = await leaseIdBlock(database.db, tenantId, 256);
		expect(block).toEqual({ first: Number.MAX_SAFE_INTEGER - 9, last: Number.MAX_SAFE_INTEGER });
		await expect(leaseIdBlock(database.db, tenantId, 1)).rejects.toThrow("ID space is exhausted");
	});
});
