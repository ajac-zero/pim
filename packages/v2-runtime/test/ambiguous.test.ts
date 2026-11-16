import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Db } from "../src/db.ts";
import { PartitionDirectory } from "../src/directory.ts";
import { AmbiguousCommit } from "../src/errors.ts";
import { createTestDatabase, type TestDatabase } from "./support/pg.ts";
import { FaultProxy } from "./support/proxy.ts";
import { uniqueTenant } from "./support/partition.ts";
import { createRig, fauxAssistantMessage, readTranscript, textOf, waitFor } from "./support/rig.ts";

let database: TestDatabase;
let proxy: FaultProxy;
let proxied: Db;
beforeAll(async () => {
	database = await createTestDatabase();
	const url = new URL(database.url);
	proxy = new FaultProxy({ host: url.hostname, port: Number(url.port) });
	await proxy.listen();
	const through = new URL(database.url);
	through.port = String(proxy.port);
	proxied = Db.connect({ connectionString: through.toString(), max: 10 });
});
afterAll(async () => {
	await proxied.close();
	await proxy.close();
	await database.drop();
});

const notes = async (tenantId: string, partitionId: string): Promise<unknown[]> =>
	(await readTranscript(database.db, tenantId, partitionId, 1)).filter((e) => e.kind === "note").map((e) => e.data);

describe("ambiguous COMMIT", () => {
	for (const mode of ["lose-ack", "drop-before"] as const) {
		it(`${mode}: the Session is poisoned, the Runner reconciles the receipt and reopens, and the batch is neither lost nor applied twice`, async () => {
			const tenantId = uniqueTenant();
			const rig = createRig(proxied, tenantId);
			const partitionId = await new PartitionDirectory(database.db).createPartition(tenantId, { kind: "home" });
			const runner = rig.runner({ db: proxied });
			const first = (await runner.activate(tenantId, partitionId))!;
			const root = (await first.harness.conversation(1 as ConversationId, BACKGROUND_CONTEXT))!;
			await root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: "before" }), BACKGROUND_CONTEXT);

			proxy.arm(mode);
			const failure = await root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: "in doubt" }), BACKGROUND_CONTEXT).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(AmbiguousCommit);
			expect(proxy.fired).toBeGreaterThan(0);
			// pi poisons the Session on a failure that is not StorageRejected: nothing more runs through it.
			await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: "after poison" }), BACKGROUND_CONTEXT)).rejects.toThrow(/poisoned|closed|unknown/i);

			const reconciled = await waitFor("the Runner to reconcile", () => rig.events.find((e) => e.type === "reconciled"));
			const batchId = (failure as AmbiguousCommit).batchId;
			expect(reconciled).toMatchObject({ type: "reconciled", batchId, outcome: { committed: mode === "lose-ack" } });
			const receipt = await database.db.read(tenantId, "SELECT 1 FROM pim_runtime.commit_receipts WHERE tenant_id = $1 AND batch_id = $2", [tenantId, batchId]);
			expect(receipt.rowCount).toBe(mode === "lose-ack" ? 1 : 0);

			const second = await waitFor("the reopened partition", () => {
				const resident = runner.resident(tenantId, partitionId);
				return resident !== undefined && resident !== first && !resident.disposed ? resident : undefined;
			});
			expect(second.lease.epoch).toBe(first.lease.epoch); // the same ownership, a fresh Session
			expect(await notes(tenantId, partitionId)).toEqual(mode === "lose-ack" ? ["before", "in doubt"] : ["before"]);

			// New work runs normally on the reopened Session.
			const again = (await second.harness.conversation(1 as ConversationId, BACKGROUND_CONTEXT))!;
			await again.commit((tx) => tx.appendEntry(again.id, { kind: "note", data: "after" }), BACKGROUND_CONTEXT);
			expect(await notes(tenantId, partitionId)).toEqual(mode === "lose-ack" ? ["before", "in doubt", "after"] : ["before", "after"]);
			await runner.stop();
		});
	}

	for (const mode of ["lose-ack", "drop-before"] as const) {
		it(`${mode}: a redelivered command is admitted exactly once whichever way the first attempt went`, async () => {
			const tenantId = uniqueTenant();
			const rig = createRig(proxied, tenantId);
			const partitionId = await new PartitionDirectory(database.db).createPartition(tenantId, { kind: "home" });
			rig.faux.setResponses([fauxAssistantMessage("the answer")]);
			const runner = rig.runner({ db: proxied });
			const resident = (await runner.activate(tenantId, partitionId))!;
			// The first submit commit of the command is the one that is broken.
			await runner.inbox.enqueueCommand(tenantId, partitionId, { requestId: "once", kind: "submit", conversationId: 1, payload: { conversationId: 1, content: "hello" } });
			proxy.arm(mode);
			await resident.pump();
			await waitFor("the Runner to reconcile", () => rig.events.find((e) => e.type === "reconciled"));
			await runner.start();
			await waitFor("the answer", async () => (await readTranscript(database.db, tenantId, partitionId, 1)).some((e) => textOf(e) === "the answer"));
			const entries = await readTranscript(database.db, tenantId, partitionId, 1);
			expect(entries.filter((e) => e.kind === "pi.user")).toHaveLength(1);
			expect(entries.filter((e) => e.kind === "pi.assistant")).toHaveLength(1);
			const done = await database.db.read(tenantId, "SELECT 1 FROM pim_runtime.command_inbox WHERE tenant_id = $1 AND done_at IS NOT NULL", [tenantId]);
			expect(done.rowCount).toBe(1);
			await runner.stop();
		});
	}
});
