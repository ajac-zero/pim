import { OwnershipLost, StorageRejected } from "../src/errors.ts";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, type EntryId } from "@earendil-works/pi-durable";
import { PartitionDirectory } from "../src/directory.ts";
import { IdAllocator, leaseIdBlock, seedIdHighWater } from "../src/ids.ts";
import { migrate } from "../src/migrate.ts";
import { Steward } from "../src/ownership.ts";
import { PgPiStorage } from "../src/storage.ts";
import { createTestDatabase, type TestDatabase } from "./support/pg.ts";
import { openTestPartition, uniqueOwner } from "./support/partition.ts";
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
		const names = (await database.db.pool.query<{ name: string }>("SELECT name FROM public.pim_schema_migrations WHERE number >= 100 ORDER BY number")).rows.map((r) => r.name);
		expect(names).toEqual(["pi_runtime_schema", "pi_conversations_entries", "pi_tasks_submissions", "pi_documents", "pi_commit_receipts_outbox", "runtime_ownership_and_inbox", "external_operations", "sleeping_tasks"]);
		const dir = mkdtempSync(join(tmpdir(), "pim-mig-"));
		writeFileSync(join(dir, "0100_pi_runtime_schema.sql"), "select 1;");
		await expect(migrate(database.db.pool, dir)).rejects.toThrow(/changed after it was applied/);
		// A file outside the runtime's band is refused before anything runs.
		const stray = mkdtempSync(join(tmpdir(), "pim-mig-"));
		writeFileSync(join(stray, "0250_application_table.sql"), "select 1;");
		await expect(migrate(database.db.pool, stray)).rejects.toThrow(/outside runtime's band 100-199/);
	});

	it("applies concurrently from several Runners without conflict", async () => {
		const fresh = await createTestDatabase();
		try {
			await fresh.db.pool.query("DROP SCHEMA pim_runtime CASCADE; CREATE SCHEMA pim_runtime; DELETE FROM public.pim_schema_migrations WHERE number >= 100");
			const pools = [0, 1, 2, 3].map(() => new pg.Pool({ connectionString: fresh.url, max: 1 }));
			const results = await Promise.all(pools.map((pool) => migrate(pool)));
			expect(results.reduce((n, r) => n + r.applied.length, 0)).toBe(8);
			await Promise.all(pools.map((pool) => pool.end()));
		} finally {
			await fresh.drop();
		}
	});
});

describe("owner isolation", () => {
	it("row-level security hides other owners from a non-superuser connection and rejects cross-owner writes", async () => {
		const a = await openTestPartition(database.db);
		const b = await openTestPartition(database.db);
		await commitWrites(a.storage, [conversation(2), entry(3, 2, { data: "secret of A" })], ctx);
		const app = database.appPool();
		const client = await app.connect();
		try {
			await client.query("SELECT set_config('pim.owner_id', $1, false)", [b.ownerId]);
			expect((await client.query("SELECT * FROM pim_runtime.entries")).rowCount).toBe(0);
			await client.query("SELECT set_config('pim.owner_id', $1, false)", [a.ownerId]);
			expect((await client.query("SELECT * FROM pim_runtime.entries")).rowCount).toBe(1);
			await expect(client.query("INSERT INTO pim_runtime.record_ids (owner_id, id, kind, partition_id) VALUES ($1, 99, 'entry', $2)", [b.ownerId, b.partitionId])).rejects.toThrow(/row-level security/);
			await client.query("SELECT set_config('pim.owner_id', '', false)");
			expect((await client.query("SELECT * FROM pim_runtime.entries")).rowCount).toBe(0); // no owner, no rows
		} finally {
			client.release();
		}
	});

	it("never reads another owner's records through the storage even for the same ids", async () => {
		const a = await openTestPartition(database.db);
		const b = await openTestPartition(database.db);
		await commitWrites(a.storage, [conversation(2), entry(3, 2, { data: "A" })], ctx);
		await commitWrites(b.storage, [conversation(2), entry(3, 2, { data: "B" })], ctx); // ids are per owner
		expect((await a.storage.entry(3 as EntryId, ctx))?.entry.data).toBe("A");
		expect((await b.storage.entry(3 as EntryId, ctx))?.entry.data).toBe("B");
	});
});

describe("partition directory and the home rule", () => {
	it("allows one home partition per owner and keeps conversation 1 out of every other partition", async () => {
		const directory = new PartitionDirectory(database.db);
		const ownerId = uniqueOwner();
		const home = await directory.ensureHome(ownerId);
		expect(await directory.ensureHome(ownerId)).toBe(home);
		await expect(directory.createPartition(ownerId, { partitionId: randomUUID(), kind: "home" })).rejects.toThrow(/partitions_one_home/);
		const family = await directory.createPartition(ownerId);
		await expect(directory.createPartition(ownerId, { partitionId: family, kind: "home" })).rejects.toThrow(/another kind/);
		// The database refuses a directory row for conversation 1 in a family partition.
		await expect(database.db.read(ownerId, "INSERT INTO pim_runtime.conversation_partitions (owner_id, conversation_id, partition_id) VALUES ($1, 1, $2)", [ownerId, family])).rejects.toThrow(/home partition/);
		// And the storage refuses the commit that would create it, before anything is written.
		const part = await openTestPartition(database.db, { ownerId, partitionId: family, kind: "family" });
		await expect(commitWrites(part.storage, [conversation(1)], ctx)).rejects.toBeInstanceOf(StorageRejected);
		expect((await database.db.read(ownerId, "SELECT 1 FROM pim_runtime.record_ids WHERE owner_id = $1 AND id = 1", [ownerId])).rowCount).toBe(0);
		// Routing: conversation 1 is home, others come from the directory, and a row cannot be moved.
		expect(await directory.routeConversation(ownerId, "1")).toBe(home);
		await commitWrites(part.storage, [conversation(40)], ctx);
		expect(await directory.routeConversation(ownerId, 40)).toBe(family);
		await expect(database.db.read(ownerId, "UPDATE pim_runtime.conversation_partitions SET partition_id = $2 WHERE owner_id = $1 AND conversation_id = 40", [ownerId, home])).rejects.toThrow(/immutable/);
		const uuid = "7b5c0f0e-2f4e-4c4a-9a43-6b9b0b0f6a11";
		// Conversation 40 was made by a commit, whose outbox event already carries its generated public chat id.
		await expect(directory.registerPublicChat(ownerId, uuid, 40)).rejects.toThrow(/already been published/);
		// The id of a conversation about to be created is chosen beforehand.
		part.storage.reservePublicChatId(uuid);
		await commitWrites(part.storage, [conversation(41)], ctx);
		expect(await directory.routeChat(ownerId, uuid)).toEqual({ partitionId: family, conversationId: 41 });
		expect(await directory.publicChatId(ownerId, 41)).toBe(uuid);
	});

	it("rejects records that name a conversation outside their partition, so a family cannot straddle partitions", async () => {
		const ownerId = uniqueOwner();
		const famId = randomUUID();
		const home = await openTestPartition(database.db, { ownerId, kind: "home" });
		const family = await openTestPartition(database.db, { ownerId, kind: "family", partitionId: famId });
		await commitWrites(home.storage, [conversation(2), entry(3, 2)], ctx);
		await expect(commitWrites(family.storage, [conversation(4, { conversationId: 2, at: 3 })], ctx)).rejects.toThrow(new RegExp(`Conversation 2 is not in partition ${famId}`));
		await expect(commitWrites(family.storage, [entry(5, 2)], ctx)).rejects.toThrow(/not in partition/);
		await expect(commitWrites(family.storage, [conversation(3)], ctx)).rejects.toThrow(/already belongs to entry/); // ids are one owner-wide namespace
		await expect(family.storage.entry(3 as EntryId, ctx)).resolves.toBeUndefined();
	});
});

describe("leases", () => {
	it("a heartbeat keeps a short lease alive, and a steal makes the next renewal fail and abort the owner", async () => {
		const ownerId = uniqueOwner();
		const partitionId = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		const steward = new Steward({ db: database.db, holderId: "heart", leaseTtlMs: 700, renewEveryMs: 150, safetyMarginMs: 100 });
		const lease = (await steward.acquire(ownerId, partitionId))!;
		lease.startHeartbeat();
		await new Promise((resolve) => setTimeout(resolve, 1_600)); // more than two TTLs
		expect(lease.isLocallyValid()).toBe(true);
		const storage = await PgPiStorage.openForOwner({ db: database.db, fence: lease });
		await commitWrites(storage, [conversation(2)], ctx);
		// Another owner takes the row at a higher epoch (as after a long pause).
		await database.db.read(ownerId, "UPDATE pim_runtime.partitions SET holder_id = 'thief', epoch = epoch + 1 WHERE owner_id = $1", [ownerId]);
		await waitFor("the owner to notice", () => (lease.lostReason !== undefined ? true : undefined), 3_000);
		expect(lease.signal.aborted).toBe(true);
		await expect(commitWrites(storage, [conversation(3)], ctx)).rejects.toBeInstanceOf(OwnershipLost);
	});

	it("only one of several concurrent claimants takes a free partition", async () => {
		const ownerId = uniqueOwner();
		const partitionId = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		const stewards = Array.from({ length: 8 }, (_, i) => new Steward({ db: database.db, holderId: `s${i}`, leaseTtlMs: 5_000 }));
		const leases = (await Promise.all(stewards.map((s) => s.acquire(ownerId, partitionId)))).filter((l) => l !== undefined);
		expect(leases).toHaveLength(1);
		expect(leases[0]?.epoch).toBe(1n);
		// claimNext uses SKIP LOCKED: many claimants each take a different needs-owner partition.
		const t2 = uniqueOwner();
		for (let i = 0; i < 4; i++) await new PartitionDirectory(database.db).createPartition(t2, i === 0 ? { kind: "home" } : {});
		const claimed = (await Promise.all(Array.from({ length: 6 }, () => new Steward({ db: database.db, holderId: `c${Math.random()}`, leaseTtlMs: 5_000 }).claimNext({ ownerId: t2 })))).filter((l) => l !== undefined);
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
		const seen: { ownerId: string; partitionId: string; seq: number }[] = [];
		listener.on("notification", (n) => seen.push(JSON.parse(n.payload ?? "{}")));
		const seq = await commitWrites(part.storage, [conversation(2), entry(3, 2)], ctx);
		const rejected = await commitWrites(part.storage, [conversation(2)], ctx).catch((e: unknown) => e);
		expect(rejected).toBeInstanceOf(StorageRejected);
		await waitFor("the notification", () => (seen.length > 0 ? true : undefined));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(seen).toEqual([{ ownerId: part.ownerId, partitionId: part.partitionId, seq }]); // none for the failed commit
		const outbox = await database.db.read<{ commit_seq: string; ordinal: number; conversation_id: string; public_chat_id: string; projection_version: number; event_kind: string; payload: string }>(
			part.ownerId,
			"SELECT * FROM pim_runtime.runtime_outbox WHERE owner_id = $1 ORDER BY commit_seq, ordinal",
			[part.ownerId],
		);
		expect(outbox.rows.map((r) => [Number(r.commit_seq), r.ordinal, Number(r.conversation_id)])).toEqual([[seq, 1, 2]]); // one event per conversation, none for the rejected commit
		expect(outbox.rows[0]).toMatchObject({ projection_version: 1, event_kind: "commit", public_chat_id: await new PartitionDirectory(database.db).publicChatId(part.ownerId, 2) });
		expect(JSON.parse(outbox.rows[0]!.payload).changes).toEqual([{ type: "conversation", id: 2, conversationId: 2 }, { type: "entry", id: 3, conversationId: 2, kind: "note" }]);
		const receipts = await database.db.read(part.ownerId, "SELECT 1 FROM pim_runtime.commit_receipts WHERE owner_id = $1 AND commit_seq = $2", [part.ownerId, seq]);
		expect(receipts.rowCount).toBe(1);
		await listener.end();
	});
});

describe("owner-wide id allocation", () => {
	it("leases disjoint blocks to concurrent owners, with gaps allowed, and starts above an imported high-water mark", async () => {
		const ownerId = uniqueOwner();
		await seedIdHighWater(database.db, ownerId, 5_000);
		const blocks = await Promise.all(Array.from({ length: 20 }, () => leaseIdBlock(database.db, ownerId, 64)));
		const sorted = blocks.map((b) => b.first).sort((x, y) => x - y);
		expect(sorted[0]).toBe(5_001);
		for (const b of blocks) expect(b.last - b.first + 1).toBe(64);
		expect(new Set(sorted).size).toBe(20);
		for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBe(64); // contiguous across owners: no overlap
		// Allocators minting concurrently never collide, and each draws from the shared row once per block.
		const allocators = Array.from({ length: 6 }, () => new IdAllocator(database.db, ownerId, () => undefined, 32));
		const ids = (await Promise.all(allocators.flatMap((a) => Array.from({ length: 100 }, () => a.mint<never>() as Promise<number>)))).flat();
		expect(new Set(ids).size).toBe(600);
		const leased = await database.db.read(ownerId, "SELECT 1 FROM pim_runtime.id_blocks WHERE owner_id = $1", [ownerId]);
		expect(leased.rowCount).toBe(20 + 6 * 4); // 100 ids per allocator is four 32-id blocks
	});

	it("hands out the last ids below 2^53 and then reports exhaustion instead of overflowing", async () => {
		const ownerId = uniqueOwner();
		await seedIdHighWater(database.db, ownerId, Number.MAX_SAFE_INTEGER - 10);
		const block = await leaseIdBlock(database.db, ownerId, 256);
		expect(block).toEqual({ first: Number.MAX_SAFE_INTEGER - 9, last: Number.MAX_SAFE_INTEGER });
		await expect(leaseIdBlock(database.db, ownerId, 1)).rejects.toThrow("ID space is exhausted");
	});
});
