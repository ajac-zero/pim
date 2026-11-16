import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, StorageRejected, type ConversationRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PartitionDirectory, ROOT_SESSION } from "../src/directory.ts";
import { importLegacySpace, type LegacySpace, planFamilies, readLegacySqlite } from "../src/splitter.ts";
import { PgPiStorage } from "../src/storage.ts";
import { createTestDatabase, type TestDatabase } from "./support/pg.ts";
import { buildLegacySpace, type LegacyFixture } from "./support/legacy.ts";
import { openTestPartition, uniqueOwner } from "./support/partition.ts";
import { command } from "./support/commands.ts";
import { createRig, fauxAssistantMessage, readTranscript, textOf, waitFor } from "./support/rig.ts";

const ctx = BACKGROUND_CONTEXT;
let database: TestDatabase;
let fixture: LegacyFixture;
let space: LegacySpace;
beforeAll(async () => {
	database = await createTestDatabase();
	fixture = await buildLegacySpace();
	space = await readLegacySqlite(fixture.path);
});
afterAll(async () => {
	await database.drop();
});

describe("legacy SQLite space → conversation-family partitions", () => {
	it("computes families from fork closure: the root with its nap is home, every chat tree is its own partition", () => {
		const plan = planFamilies(space, "o_plan");
		const { ids } = fixture;
		const HOME_PARTITION_ID = plan.families.find((f) => f.home)!.partitionId;
		const partition = (id: number) => plan.partitionOf.get(id);
		expect(partition(ids.root)).toBe(HOME_PARTITION_ID);
		expect(partition(ids.fork1)).toBe(partition(ids.chat));
		expect(partition(ids.fork2)).toBe(partition(ids.chat));
		const separate = [ids.chat, ids.seat1, ids.seat2, ids.delegated, ids.continuation].map(partition);
		expect(new Set(separate).size).toBe(5);
		expect(separate).not.toContain(HOME_PARTITION_ID);
		expect(plan.families).toHaveLength(6);
		expect(plan.families[0]).toMatchObject({ home: true });
		expect(plan.taskPartition.get(ids.napTask)).toBe(HOME_PARTITION_ID);
	});

	it("fails closed when a record crosses families", () => {
		const bad: LegacySpace = { ...space, entries: space.entries.map((e) => (e.record.kind === "pi.user" && e.record.conversationId === fixture.ids.seat1 ? { ...e, record: { ...e.record, head: space.entries.find((x) => x.record.conversationId === fixture.ids.delegated)!.record.id } } : e)) };
		expect(() => planFamilies(bad, "o_plan")).toThrow(/crosses conversation families/);
		const orphan: LegacySpace = { ...space, conversations: space.conversations.filter((c) => c.id !== fixture.ids.seat1) };
		expect(() => planFamilies(orphan, "o_plan")).toThrow(/does not exist/);
	});

	it("imports every record with ids, ancestry, documents and sequences preserved, and never creates conversation 1 off the home partition", async () => {
		const ownerId = uniqueOwner();
		const report = await importLegacySpace(database.db, ownerId, space);
		expect(report.partitions).toHaveLength(6);
		const directory = new PartitionDirectory(database.db);
		const legacy = await openNodeSqliteStorage(fixture.path);
		const plan = planFamilies(space, ownerId);
		const HOME_PARTITION_ID = plan.families.find((f) => f.home)!.partitionId;

		// Routing: the root session is the home partition; every other conversation routes through the directory.
		expect(await directory.routeConversation(ownerId, ROOT_SESSION)).toBe(HOME_PARTITION_ID);
		for (const [conversationId, partitionId] of plan.partitionOf) expect(await directory.routeConversation(ownerId, conversationId)).toBe(partitionId);
		const ones = await database.db.read<{ partition_id: string }>(ownerId, "SELECT partition_id FROM pim_runtime.conversations WHERE owner_id = $1 AND id = 1", [ownerId]);
		expect(ones.rows.map((r) => r.partition_id)).toEqual([HOME_PARTITION_ID]);

		// Every conversation's transcript matches the legacy storage entry for entry, forks included.
		for (const c of space.conversations) {
			const partitionId = plan.partitionOf.get(c.id)!;
			const pg = PgPiStorage.forReading(database.db, ownerId, partitionId);
			expect((await pg.conversation(c.id, ctx)), `conversation ${c.id}`).toEqual(c);
			const want = (await legacy.scanEntries({ conversationId: c.id, order: "ascending" }, 10_000, undefined, ctx)).items;
			const got = (await pg.scanEntries({ conversationId: c.id, order: "ascending" }, 10_000, undefined, ctx)).items;
			expect(got.length).toBeGreaterThan(0);
			expect(got, `transcript of conversation ${c.id}`).toEqual(want);
			// The descending scan and head markers agree too.
			expect((await pg.scanEntries({ conversationId: c.id }, 10_000, undefined, ctx)).items).toEqual((await legacy.scanEntries({ conversationId: c.id }, 10_000, undefined, ctx)).items);
			expect(await pg.findLatestHeadMarker(c.id as never, undefined, ctx)).toEqual(await legacy.findLatestHeadMarker(c.id as never, undefined, ctx));
		}
		// The fork's transcript really is its parent's prefix plus its own turns.
		const forkTranscript = (await readTranscript(database.db, ownerId, plan.partitionOf.get(fixture.ids.fork1)!, fixture.ids.fork1)).map(textOf).filter(Boolean);
		expect(forkTranscript).toEqual(expect.arrayContaining(["a1", "A1", "f1", "F1"]));
		expect(forkTranscript).not.toContain("A2");

		// Documents, current and as of every stored revision, are identical; so are commit sequences.
		let compared = 0;
		let historical = 0;
		for (const { record, revisions } of space.documents) {
			const partitionId = record.scope.kind === "session" ? HOME_PARTITION_ID : plan.partitionOf.get(record.scope.kind === "conversation" ? record.scope.conversationId : space.tasks.find((t) => t.id === (record.scope as { taskId: number }).taskId)!.conversationId)!;
			const pg = PgPiStorage.forReading(database.db, ownerId, partitionId);
			const points = record.retiredAt === undefined ? (["current"] as const) : [];
			const stamps = (record as { history?: string }).history === "rewindable" ? revisions.map((r) => r.seq).filter((seq) => seq >= record.createdAt && (record.retiredAt === undefined || seq < record.retiredAt)) : [];
			historical += stamps.length;
			for (const at of [...points, ...stamps]) compared++, expect(await pg.document(record.id as never, at as never, ctx), `document ${record.id} at ${at}`).toEqual(await legacy.document(record.id as never, at as never, ctx));
		}
		expect(compared).toBeGreaterThan(20);
		expect(historical).toBeGreaterThan(5); // asOf reads of rewindable documents were compared, not just current state
		for (const { record, commitSeq } of space.entries) {
			const found = await PgPiStorage.forReading(database.db, ownerId, plan.partitionOf.get(record.conversationId)!).entry(record.id, ctx);
			expect(found?.commitSeq).toBe(commitSeq);
		}
		const seqs = await database.db.read<{ next_seq: string }>(ownerId, "SELECT DISTINCT next_seq FROM pim_runtime.partitions WHERE owner_id = $1", [ownerId]);
		expect(seqs.rows.map((r) => Number(r.next_seq))).toEqual([report.nextSeq]);
		expect(report.nextSeq).toBeGreaterThanOrEqual(space.metadata.nextSeq);

		// The nap task stays in the home partition, still pending.
		const nap = await PgPiStorage.forReading(database.db, ownerId, HOME_PARTITION_ID).task(fixture.ids.napTask as never, ctx);
		expect(nap).toMatchObject({ kind: "optmem.nap", conversationId: 1, background: true });
		await expect(importLegacySpace(database.db, ownerId, space)).rejects.toThrow(/already has partitions/);
		await legacy.close(ctx);
	});

	it("keeps minted ids from colliding across concurrently active families after the import", async () => {
		const ownerId = uniqueOwner();
		const report = await importLegacySpace(database.db, ownerId, space);
		const partitions = await Promise.all(report.partitions.map((p) => openTestPartition(database.db, { ownerId, partitionId: p.partitionId, kind: p.home ? "home" : "family" }).catch(async () => undefined)));
		// openTestPartition creates partitions; they exist already, so lease them directly.
		const leased = partitions.filter((p) => p !== undefined);
		expect(leased.length).toBe(report.partitions.length);
		const minted = await Promise.all(leased.flatMap((p) => Array.from({ length: 700 }, () => p!.storage.mintId<never>() as Promise<number>)));
		expect(new Set(minted).size).toBe(minted.length);
		expect(Math.min(...minted)).toBeGreaterThan(report.highWater);
		// Interleaved blocks: ids are increasing within each partition's own stream.
		for (const p of leased) {
			const own = await Promise.all(Array.from({ length: 300 }, () => p!.storage.mintId<never>() as Promise<number>));
			expect(own).toEqual([...own].sort((a, b) => a - b));
		}
	});

	it("runs imported families: root() is refused off the home partition, conversation 1 is rejected there, and a fork continues on its own partition", async () => {
		const ownerId = uniqueOwner();
		await importLegacySpace(database.db, ownerId, space);
		const plan = planFamilies(space, ownerId);
		const HOME_PARTITION_ID = plan.families.find((f) => f.home)!.partitionId;
		const rig = createRig(database.db, ownerId);
		const runner = rig.runner();
		const chatPartition = plan.partitionOf.get(fixture.ids.chat)!;
		const family = (await runner.activate(ownerId, chatPartition))!;
		expect(family.home).toBe(false);
		expect(() => family.harness.root(ctx)).toThrow(/never called on partition/);
		await expect(family.storage.commit([{ type: "conversation", value: { id: 1 as never } }], ctx)).rejects.toBeInstanceOf(StorageRejected);
		await expect(family.storage.commit([{ type: "conversation", value: { id: 1 as never } }], ctx)).rejects.toThrow(/home partition/);
		// Nothing but the family's conversations is in this partition.
		const conversations = await family.harness.createConversation({ ownership: { kind: "ownerless" }, agent: rig.agent }, ctx);
		expect(conversations.id).toBeGreaterThan(space.metadata.nextId - 1);
		// A fork continues where it was: ancestry intact, new answer appended.
		rig.faux.setResponses([fauxAssistantMessage("F2 from postgres")]);
		await command(runner.inbox, ownerId, chatPartition, "more", fixture.ids.fork1, { content: "f2" });
		await family.pump();
		await waitFor("the fork's new answer", async () => (await readTranscript(database.db, ownerId, chatPartition, fixture.ids.fork1)).some((e) => textOf(e) === "F2 from postgres"));
		const texts = (await readTranscript(database.db, ownerId, chatPartition, fixture.ids.fork1)).map(textOf).filter(Boolean);
		expect(texts.slice(0, 4)).toEqual(["a1", "A1", "f1", "F1"]);
		// The home partition does create conversation 1 (it is already there from the import) and keeps it.
		const home = (await runner.activate(ownerId, HOME_PARTITION_ID))!;
		expect(home.home).toBe(true);
		const root = await home.harness.root(ctx, { agent: rig.agent });
		expect(root.id).toBe(1);
		await runner.stop();
		void Harness;
		void ({} as ConversationRecord);
	});
});
