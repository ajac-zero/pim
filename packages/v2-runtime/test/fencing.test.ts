import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, StorageRejected } from "@earendil-works/pi-durable";
import { PartitionDirectory } from "../src/directory.ts";
import { OwnershipLost } from "../src/errors.ts";
import { Steward } from "../src/ownership.ts";
import { PgPiStorage } from "../src/storage.ts";
import { createTestDatabase, type TestDatabase } from "./support/pg.ts";
import { uniqueTenant } from "./support/partition.ts";
import { createRig, fauxAssistantMessage, textOf, transcript, waitFor } from "./support/rig.ts";

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
		const tenantId = uniqueTenant();
		const partitionId = await new PartitionDirectory(db).createPartition(tenantId, { kind: "home" });
		const a = new Steward({ db, ownerId: "runner-a", leaseTtlMs: 600, safetyMarginMs: 50 });
		const b = new Steward({ db, ownerId: "runner-b", leaseTtlMs: 30_000 });
		const leaseA = await a.acquire(tenantId, partitionId);
		expect(leaseA?.epoch).toBe(1);
		expect(await b.acquire(tenantId, partitionId)).toBeUndefined(); // A's lease is live
		const rig = createRig(db, tenantId);
		const storageA = await PgPiStorage.openForOwner({ db, fence: leaseA!, idBlockSize: 4 });
		const harnessA = await Harness.open(storageA, rig.harnessOptions(), BACKGROUND_CONTEXT);
		const rootA = await harnessA.root(BACKGROUND_CONTEXT, { agent: rig.agent });
		await rootA.commit((tx) => tx.appendEntry(rootA.id, { kind: "note", data: "from A before the steal" }), BACKGROUND_CONTEXT);

		await sleep(700); // A stops renewing; the lease expires
		const leaseB = await b.acquire(tenantId, partitionId);
		expect(leaseB?.epoch).toBe(2);

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
		const receipts = await db.read<{ owner_epoch: string; commit_seq: string }>(tenantId, "SELECT owner_epoch, commit_seq FROM pim_runtime.commit_receipts WHERE tenant_id = $1 ORDER BY commit_seq", [tenantId]);
		const epochs = receipts.rows.map((row) => Number(row.owner_epoch));
		expect(epochs).toEqual([...epochs].sort((x, y) => x - y));
		expect(new Set(epochs)).toEqual(new Set([1, 2]));
		await harnessB.close(BACKGROUND_CONTEXT);
		await harnessA.close(BACKGROUND_CONTEXT).catch(() => {});
	});

	it("a lease that is not renewed aborts the in-flight model stream and closes the Harness; the next owner finishes the turn once", async () => {
		const { db } = database;
		const tenantId = uniqueTenant();
		const directory = new PartitionDirectory(db);
		const partitionId = await directory.createPartition(tenantId, { kind: "home" });
		const rig = createRig(db, tenantId);
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
		const runnerA = rig.runner({ steward: { ownerId: "runner-a", leaseTtlMs: 1_200, renewEveryMs: 60_000, safetyMarginMs: 200 } });
		const residentA = await runnerA.activate(tenantId, partitionId);
		expect(residentA).toBeDefined();
		const conversationId = 1;
		await runnerA.inbox.enqueueCommand(tenantId, partitionId, { requestId: "req-1", kind: "submit", conversationId, payload: { conversationId, content: "hello" } });
		await residentA!.pump();
		await waitFor("model stream to start", () => streamSignal);
		await waitFor("runner A to lose the lease", () => residentA!.disposed || undefined, 5_000);
		expect(streamSignal?.aborted).toBe(true); // the model call was cut off
		release();

		// Runner B takes over, reopens, and finishes the turn exactly once.
		rig.faux.setResponses([fauxAssistantMessage("answer from B")]);
		const runnerB = rig.runner({ steward: { ownerId: "runner-b", leaseTtlMs: 10_000 } });
		await waitFor("lease to expire", async () => {
			const lease = await runnerB.steward.acquire(tenantId, partitionId);
			if (lease === undefined) return undefined;
			await runnerB.steward.handOff(lease, "test"); // give it back so the claim loop below takes it
			return true;
		}, 5_000);
		await runnerB.start();
		const residentB = await waitFor("runner B to host the partition", () => runnerB.resident(tenantId, partitionId));
		await residentB.pump();
		const root = (await residentB.harness.conversation(1 as never, BACKGROUND_CONTEXT))!;
		const entries = await waitFor("the turn to finish", async () => {
			const all = await transcript(residentB.harness, root);
			return all.some((e) => e.kind === "pi.assistant" && textOf(e) === "answer from B") ? all : undefined;
		});
		expect(entries.filter((e) => e.kind === "pi.user")).toHaveLength(1);
		expect(runnerB.resident(tenantId, partitionId)?.lease.epoch).toBeGreaterThan(residentA!.lease.epoch);
		await runnerB.stop();
		await runnerA.stop();
	});
});
