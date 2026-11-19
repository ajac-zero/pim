import { commitWrites } from "@earendil-works/pi-durable/testing";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OwnerId } from "@pim/v2-contracts/identity";
import { COMMAND_KINDS, epochCurrent, leaseLive, operationSettled, type PartitionLease, type RuntimeOutboxEvent } from "@pim/v2-contracts/runtime-seam";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { PartitionDirectory } from "../src/directory.ts";
import { ExternalOperations, InvalidTransition } from "../src/external.ts";
import { PartitionInbox } from "../src/signals.ts";
import { command } from "./support/commands.ts";
import { createTestDatabase, type TestDatabase } from "./support/pg.ts";
import { openTestPartition, uniqueOwner } from "./support/partition.ts";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(async () => {
	await database.drop();
});

describe("the canonical contracts", () => {
	it("a Lease is a PartitionLease: bigint epoch, holder, expiry, activation sequence, and the contract's fencing predicates agree", async () => {
		const part = await openTestPartition(database.db);
		const lease: PartitionLease = part.lease;
		expect(lease).toMatchObject({ isHome: true, holderId: part.lease.holderId, epoch: 1n, activationSeq: 0n, dueAt: null });
		expect(leaseLive(lease, new Date())).toBe(true);
		expect(epochCurrent(1n, lease.epoch)).toBe(true);
		const stored = (await database.db.read<{ epoch: string }>(part.ownerId, "SELECT epoch FROM pim_runtime.partitions WHERE owner_id = $1", [part.ownerId])).rows[0]!;
		expect(epochCurrent(BigInt(stored.epoch), lease.epoch)).toBe(true);
	});

	it("takes a CommandSubmission as the contract defines it, deduplicates by commandId, and rejects what the schema rejects", async () => {
		const ownerId = uniqueOwner();
		const partitionId = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		const inbox = new PartitionInbox(database.db);
		for (const kind of COMMAND_KINDS) {
			const first = await command(inbox, ownerId, partitionId, `c-${kind}`, 1, { content: "x" }, kind);
			expect(first.duplicate).toBe(false);
		}
		expect((await command(inbox, ownerId, partitionId, "c-abort", 1, { content: "again" }, "abort")).duplicate).toBe(true);
		const pending = await inbox.pendingCommands(ownerId, partitionId);
		expect(pending.map((c) => c.kind)).toEqual([...COMMAND_KINDS]);
		expect(pending[0]).toMatchObject({ commandId: "c-user_message", piRequestId: "pi:c-user_message", conversationId: 1 });
		await expect(inbox.enqueueCommand({ commandId: "", ownerId: "nope" } as never)).rejects.toThrow();
	});

	it("writes RuntimeOutboxEvents with a gapless commitSeq per partition and the conversation's public chat id", async () => {
		const part = await openTestPartition(database.db);
		const ctx = BACKGROUND_CONTEXT;
		const commit = (id: number) => commitWrites(part.storage, [{ type: "conversation", value: { id: id as ConversationId } }, { type: "entry", value: { id: (id + 1) as EntryId, conversationId: id as ConversationId, kind: "note" } }], ctx);
		const seqs = [await commit(2), await commit(4), await commit(6)];
		await commitWrites(part.storage, [{ type: "conversation", value: { id: 2 as ConversationId } }], ctx).catch(() => {}); // rejected: consumes nothing
		seqs.push(await commit(8));
		const rows = (await database.db.read<{ commit_seq: string; projection_version: number; public_chat_id: string; conversation_id: string; event_kind: string; payload: string; partition_id: string }>(part.ownerId, "SELECT * FROM pim_runtime.runtime_outbox WHERE owner_id = $1 ORDER BY commit_seq", [part.ownerId])).rows;
		const events: RuntimeOutboxEvent[] = rows.map((r) => ({
			partitionId: part.lease.partitionId,
			commitSeq: BigInt(r.commit_seq),
			projectionVersion: r.projection_version,
			ownerId: OwnerId.parse(part.ownerId),
			publicChatId: r.public_chat_id as never,
			conversationId: Number(r.conversation_id),
			eventKind: r.event_kind,
			payload: JSON.parse(r.payload),
			committedAt: new Date().toISOString(),
		}));
		expect(events.map((e) => e.commitSeq)).toEqual(seqs.map(BigInt));
		for (let i = 1; i < events.length; i++) expect(events[i]!.commitSeq - events[i - 1]!.commitSeq).toBe(1n); // gapless
		expect(events.every((e) => e.publicChatId === events.find((x) => x.conversationId === e.conversationId)?.publicChatId)).toBe(true);
		expect(new Set(events.map((e) => e.publicChatId)).size).toBe(4);
	});

	it("keeps ExternalOperationRecords: idempotent begin, a guarded state machine, an early signal that becomes a durable signal", async () => {
		const ownerId = uniqueOwner();
		const partitionId = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		const ops = new ExternalOperations(database.db);
		const base = { operationId: "op-1", ownerId: OwnerId.parse(ownerId), partitionId: partitionId as never, taskId: "42", toolName: "send_email", capability: "gmail.send", idempotencyKey: "idem-1" };
		const first = await ops.begin(base);
		expect(first).toMatchObject({ state: "pending", receipt: null, earlySignal: null, idempotencyKey: "idem-1" });
		expect(await ops.begin(base)).toEqual(first); // the same call again is the same record
		expect((await ops.begin({ ...base, operationId: "op-2" })).operationId).toBe("op-1"); // and so is the same idempotency key
		await expect(ops.transition(ownerId, "op-1", "completed")).rejects.toBeInstanceOf(InvalidTransition); // not started yet
		await ops.transition(ownerId, "op-1", "running");
		const early = await ops.recordEarlySignal(ownerId, "op-1", { decision: "approve" });
		expect(early.earlySignal).toEqual({ decision: "approve" });
		expect((await ops.recordEarlySignal(ownerId, "op-1", { decision: "deny" })).earlySignal).toEqual({ decision: "approve" }); // the first one wins
		const signals = await new PartitionInbox(database.db).pendingSignals(ownerId, partitionId);
		expect(signals).toMatchObject([{ key: "op:op-1", kind: "tool_result", taskId: 42 }]);
		// A new owner takes over while it is running: reconcile, never repeat.
		expect((await ops.markInterrupted(ownerId, partitionId)).map((o) => o.state)).toEqual(["needs_reconciliation"]);
		expect((await ops.unsettled(ownerId, partitionId)).map((o) => operationSettled(o.state))).toEqual([false]);
		const done = await ops.transition(ownerId, "op-1", "completed", { messageId: "m-1" });
		expect(done).toMatchObject({ state: "completed", receipt: { messageId: "m-1" } });
		expect(await ops.unsettled(ownerId, partitionId)).toEqual([]);
		await expect(ops.transition(ownerId, "op-1", "running")).rejects.toBeInstanceOf(InvalidTransition);
		void randomUUID;
	});
});
