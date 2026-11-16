import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, StorageRejected } from "@earendil-works/pi-durable";
import { PartitionDirectory } from "../src/directory.ts";
import { OwnershipLost } from "../src/errors.ts";
import { Steward } from "../src/ownership.ts";
import { PgPiStorage } from "../src/storage.ts";
import { createTestDatabase, type TestDatabase } from "./support/pg.ts";
import { uniqueOwner } from "./support/partition.ts";
import { command } from "./support/commands.ts";
import { createRig, fauxAssistantMessage, readTranscript, textOf, transcript, waitFor } from "./support/rig.ts";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(async () => {
	await database.drop();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("fenced ownership", () => {
	it("fences a stale owner's open, commit and Harness work with StorageRejected, and none of its writes land", async () => {
		const { db } = database;
		const ownerId = uniqueOwner();
		const partitionId = await new PartitionDirectory(db).createPartition(ownerId, { kind: "home" });
		const a = new Steward({ db, holderId: "runner-a", leaseTtlMs: 600, safetyMarginMs: 50 });
		const b = new Steward({ db, holderId: "runner-b", leaseTtlMs: 30_000 });
		const leaseA = await a.acquire(ownerId, partitionId);
		expect(leaseA?.epoch).toBe(1n);
		expect(await b.acquire(ownerId, partitionId)).toBeUndefined(); // A's lease is live
		const rig = createRig(db, ownerId);
		const storageA = await PgPiStorage.openForOwner({ db, fence: leaseA!, idBlockSize: 4 });
		const harnessA = await Harness.open(storageA, rig.harnessOptions(), BACKGROUND_CONTEXT);
		const rootA = await harnessA.root(BACKGROUND_CONTEXT, { agent: rig.agent });
		await rootA.commit((tx) => tx.appendEntry(rootA.id, { kind: "note", data: "from A before the steal" }), BACKGROUND_CONTEXT);

		await sleep(700); // A stops renewing; the lease expires
		const leaseB = await b.acquire(ownerId, partitionId);
		expect(leaseB?.epoch).toBe(2n);

		// Runner A's open, commit and Harness commit all fail with StorageRejected; B owns the partition.
		await expect(PgPiStorage.openForOwner({ db, fence: leaseA! })).rejects.toBeInstanceOf(OwnershipLost);
		const failure = await rootA.commit((tx) => tx.appendEntry(rootA.id, { kind: "note", data: "from A after the steal" }), BACKGROUND_CONTEXT).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(StorageRejected);
		expect(failure).toBeInstanceOf(OwnershipLost);
		// StorageRejected tells pi nothing committed, so A's Session was not poisoned by it.

		const storageB = await PgPiStorage.openForOwner({ db, fence: leaseB! });
		const harnessB = await Harness.open(storageB, rig.harnessOptions(), BACKGROUND_CONTEXT);
		const rootB = await harnessB.root(BACKGROUND_CONTEXT, { agent: rig.agent });
		await rootB.commit((tx) => tx.appendEntry(rootB.id, { kind: "note", data: "from B" }), BACKGROUND_CONTEXT);

		const notes = (await transcript(harnessB, rootB)).filter((entry) => entry.kind === "note").map((entry) => entry.data);
		expect(notes).toEqual(["from A before the steal", "from B"]);
		// Receipts record who wrote each commit: epoch 1 never wrote after epoch 2 began.
		const receipts = await db.read<{ epoch: string; commit_seq: string }>(ownerId, "SELECT epoch, commit_seq FROM pim_runtime.commit_receipts WHERE owner_id = $1 ORDER BY commit_seq", [ownerId]);
		const epochs = receipts.rows.map((row) => Number(row.epoch));
		expect(epochs).toEqual([...epochs].sort((x, y) => x - y));
		expect(new Set(epochs)).toEqual(new Set([1, 2]));
		await harnessB.close(BACKGROUND_CONTEXT);
		await harnessA.close(BACKGROUND_CONTEXT).catch(() => {});
	});

	it("a lease that is not renewed aborts the in-flight model stream and closes the Harness; the next owner finishes the turn once", async () => {
		const { db } = database;
		const ownerId = uniqueOwner();
		const directory = new PartitionDirectory(db);
		const partitionId = await directory.createPartition(ownerId, { kind: "home" });
		const rig = createRig(db, ownerId);
		let streamSignal: AbortSignal | undefined;
		let release!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		rig.faux.setResponses([
			async (_context, options) => {
				streamSignal = options?.signal;
				await Promise.race([hold, new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
				return fauxAssistantMessage("never committed by A");
			},
		]);
		// Runner A cannot renew (the heartbeat interval is far past the TTL), as when its database path stalls.
		const runnerA = rig.runner({ steward: { holderId: "runner-a", leaseTtlMs: 1_200, renewEveryMs: 60_000, safetyMarginMs: 200 } });
		const residentA = await runnerA.activate(ownerId, partitionId);
		expect(residentA).toBeDefined();
		const conversationId = 1;
		await command(runnerA.inbox, ownerId, partitionId, "req-1", conversationId, { content: "hello" });
		await residentA!.pump();
		await waitFor("model stream to start", () => streamSignal);
		await waitFor("runner A to lose the lease", () => residentA!.disposed || undefined, 5_000);
		expect(streamSignal?.aborted).toBe(true); // the model call was cut off
		release();

		// Runner B takes over, reopens, and finishes the turn exactly once.
		rig.faux.setResponses([fauxAssistantMessage("answer from B")]);
		const runnerB = rig.runner({ steward: { holderId: "runner-b", leaseTtlMs: 10_000 } });
		await waitFor("lease to expire", async () => {
			const lease = await runnerB.steward.acquire(ownerId, partitionId);
			if (lease === undefined) return undefined;
			await runnerB.steward.handOff(lease, "test"); // give it back so the claim loop below takes it
			return true;
		}, 5_000);
		await runnerB.start();
		const entries = await waitFor("the turn to finish", async () => {
			const all = await readTranscript(db, ownerId, partitionId, 1);
			return all.some((e) => e.kind === "pi.assistant" && textOf(e) === "answer from B") ? all : undefined;
		});
		expect(entries.filter((e) => e.kind === "pi.user")).toHaveLength(1);
		const epochs = await db.read<{ epoch: string }>(ownerId, "SELECT DISTINCT epoch FROM pim_runtime.commit_receipts WHERE owner_id = $1 ORDER BY epoch", [ownerId]);
		expect(epochs.rows.length).toBeGreaterThan(1); // A's commits, then B's, in distinct epochs
		await runnerB.stop();
		await runnerA.stop();
	});
});
