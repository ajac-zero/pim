import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PartitionDirectory } from "../src/directory.ts";
import { PartitionInbox } from "../src/signals.ts";
import { createTestDatabase, type TestDatabase } from "./support/pg.ts";
import { uniqueOwner } from "./support/partition.ts";
import { command } from "./support/commands.ts";
import { createRig, fauxAssistantMessage, fauxToolCall, latch, type Rig, readTranscript, textOf, waitFor } from "./support/rig.ts";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(async () => {
	await database.drop();
});

const toolTaskId = async (ownerId: string): Promise<number> => {
	const rows = await database.db.read<{ id: string }>(ownerId, "SELECT id FROM pim_runtime.tasks WHERE owner_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1", [ownerId, "w:pi.tool"]);
	return Number(rows.rows[0]?.id);
};

const submitHello = (inbox: PartitionInbox, ownerId: string, partitionId: string, requestId = "req-1") =>
	command(inbox, ownerId, partitionId, requestId, 1, { content: "hello" });

const settledAt = async (ownerId: string): Promise<(Date | null)[]> =>
	(await database.db.read<{ settled_at: Date | null }>(ownerId, "SELECT settled_at FROM pim_runtime.durable_signals WHERE owner_id = $1", [ownerId])).rows.map((r) => r.settled_at);

async function homeWithGateTurn(rig: Rig, ownerId: string): Promise<string> {
	rig.faux.setResponses([fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" }), fauxAssistantMessage("all done")]);
	return new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
}

describe("early approval signals", () => {
	it("a decision that arrives before the tool task suspends is held in PostgreSQL and woken once the task suspends", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const partitionId = await homeWithGateTurn(rig, ownerId);
		rig.state.gateLatch = latch();
		const runner = rig.runner();
		const resident = (await runner.activate(ownerId, partitionId))!;
		await submitHello(runner.inbox, ownerId, partitionId);
		await resident.pump();
		await waitFor("the gate to run", () => rig.state.gateRuns[0]);
		const taskId = await toolTaskId(ownerId);
		await runner.inbox.recordSignal(ownerId, partitionId, { key: `approval:${taskId}`, kind: "approval", taskId, payload: { decision: "approve" } });
		await resident.pump();
		// pi 1.1.0 only remembers this request in memory: the task has not suspended yet.
		expect(rig.events.some((e) => e.type === "signal" && e.result === "requested")).toBe(true);
		expect(await settledAt(ownerId)).toEqual([null]);
		rig.state.gateLatch.release();
		await waitFor("the turn to finish", async () => (await readTranscript(database.db, ownerId, partitionId, 1)).some((e) => textOf(e) === "all done"));
		await waitFor("the signal to settle", async () => ((await settledAt(ownerId))[0] !== null ? true : undefined));
		expect(rig.state.gateRuns.length).toBe(2); // suspended once, woken once
		await runner.stop();
	});

	it("survives a Runner crash: the reopened Runner re-applies the signal and the turn completes without hanging", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const partitionId = await homeWithGateTurn(rig, ownerId);
		rig.state.gateLatch = latch();
		const runnerA = rig.runner({ steward: { holderId: "runner-a", leaseTtlMs: 1_500 } });
		const residentA = (await runnerA.activate(ownerId, partitionId))!;
		await submitHello(runnerA.inbox, ownerId, partitionId);
		await residentA.pump();
		await waitFor("the gate to run", () => rig.state.gateRuns[0]);
		const taskId = await toolTaskId(ownerId);
		await runnerA.inbox.recordSignal(ownerId, partitionId, { key: `approval:${taskId}`, kind: "approval", taskId, payload: { decision: "approve" } });
		await residentA.pump();
		expect(await settledAt(ownerId)).toEqual([null]);

		// The crash: the process is gone with the in-memory request. Its lease is left to expire.
		rig.state.gateLatch = undefined;
		await runnerA.stop();

		const runnerB = rig.runner({ steward: { holderId: "runner-b", leaseTtlMs: 10_000 } });
		await runnerB.start();
		const residentB = await waitFor("runner B to take the partition", () => runnerB.resident(ownerId, partitionId), 10_000);
		await waitFor("the turn to finish", async () => (await readTranscript(database.db, ownerId, partitionId, 1)).some((e) => textOf(e) === "all done"));
		await waitFor("the signal to settle", async () => ((await settledAt(ownerId))[0] !== null ? true : undefined));
		expect((await readTranscript(database.db, ownerId, partitionId, 1)).filter((e) => e.kind === "pi.user")).toHaveLength(1);
		await runnerB.stop();
	});
});

describe("quiescence and wake", () => {
	it("releases a partition parked on a suspended approval and wakes it when the decision is recorded", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const partitionId = await homeWithGateTurn(rig, ownerId);
		const runner = rig.runner();
		await runner.start();
		await submitHello(runner.inbox, ownerId, partitionId);
		await waitFor("the partition to be released while suspended", () => rig.events.find((e) => e.type === "released" && e.ownerId === ownerId));
		expect(runner.resident(ownerId, partitionId)).toBeUndefined();
		const due = (await database.db.read<{ state: string; next_due_at: Date | null }>(ownerId, "SELECT state, next_due_at FROM pim_runtime.due_work WHERE owner_id = $1", [ownerId])).rows[0];
		expect(due?.state).toBe("quiescent");
		expect(due?.next_due_at).toBeNull(); // only an outside signal can wake it
		const taskId = await toolTaskId(ownerId);
		await runner.inbox.recordSignal(ownerId, partitionId, { key: `approval:${taskId}`, kind: "approval", taskId, payload: { decision: "approve" } });
		const resident = await waitFor("the partition to wake", () => runner.resident(ownerId, partitionId));
		await waitFor("the turn to finish", async () => (await readTranscript(database.db, ownerId, partitionId, 1)).some((e) => textOf(e) === "all done"));
		await runner.stop();
	});

	it("loses no wake when a command lands while the owner releases (polling only, no pulse)", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const directory = new PartitionDirectory(database.db);
		const partitionId = await directory.createPartition(ownerId, { kind: "home" });
		const inbox = new PartitionInbox(database.db);
		const runner = rig.runner();
		const resident = (await runner.activate(ownerId, partitionId))!;

		// The race, made exact: the owner reads the activation sequence, a command arrives, then the owner tries to release.
		const seen = await inbox.activationSeq(ownerId, partitionId);
		await submitHello(inbox, ownerId, partitionId);
		const outcome = await runner.steward.release(resident.lease, { seenActivation: seen });
		expect(outcome).toEqual({ released: false, reason: "new_work" });
		expect((await database.db.read(ownerId, "SELECT 1 FROM pim_runtime.partitions WHERE owner_id = $1 AND holder_id IS NOT NULL", [ownerId])).rowCount).toBe(1);

		// And the same race run concurrently many times: after each, the command is still pending and the partition is held or claimable.
		for (let i = 0; i < 40; i++) {
			const t = uniqueOwner();
			const p = await directory.createPartition(t, { kind: "home" });
			const lease = (await runner.steward.acquire(t, p))!;
			const before = await inbox.activationSeq(t, p);
			const [released] = await Promise.all([runner.steward.release(lease, { seenActivation: before }), command(inbox, t, p, "r", 1, { content: "hello" })]);
			const state = (await database.db.read<{ holder_id: string | null; state: string }>(t, "SELECT p.holder_id, d.state FROM pim_runtime.partitions p JOIN pim_runtime.due_work d USING (owner_id, partition_id) WHERE p.owner_id = $1", [t])).rows[0]!;
			const pending = (await inbox.pendingCommands(t, p)).length;
			expect(pending).toBe(1);
			expect(state.state, `iteration ${i}: released=${JSON.stringify(released)}`).toBe("needs_owner");
			if (released.released) expect(state.holder_id).toBeNull(); // free and needs an owner: claimable
		}
		await runner.stop();
	});

	it("a released idle partition is claimed again by polling when a command arrives, and the command runs once", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const partitionId = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		rig.faux.setResponses([fauxAssistantMessage("hi there")]);
		const runner = rig.runner();
		await runner.start();
		await waitFor("the idle partition to be released", () => rig.events.find((e) => e.type === "released" && e.ownerId === ownerId));
		await submitHello(runner.inbox, ownerId, partitionId);
		const resident = await waitFor("the partition to be claimed", () => runner.resident(ownerId, partitionId));
		await waitFor("the answer", async () => (await readTranscript(database.db, ownerId, partitionId, 1)).some((e) => textOf(e) === "hi there"));
		expect((await readTranscript(database.db, ownerId, partitionId, 1)).filter((e) => e.kind === "pi.user")).toHaveLength(1);
		await runner.stop();
	});

	it("records a far retry as the partition's due time, releases it, and the due time reactivates it", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const partitionId = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		// The first attempt fails with a retryable error and a 3 s backoff, which is "far" for a 1 s long-wait window.
		rig.settings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 3_000 };
		rig.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded, try again later" }), fauxAssistantMessage("recovered answer")]);
		const runner = rig.runner({ longWaitMs: 1_000 });
		await runner.start();
		const startedAt = Date.now();
		await submitHello(runner.inbox, ownerId, partitionId);
		const released = await waitFor("the partition to be released with a due time", () => rig.events.find((e) => e.type === "released" && e.nextDueAt !== undefined));
		const dueAt = (released as { nextDueAt: number }).nextDueAt;
		expect(dueAt).toBeGreaterThan(startedAt + 2_000);
		expect(dueAt).toBeLessThan(startedAt + 6_000);
		const row = (await database.db.read<{ state: string; next_due_at: Date }>(ownerId, "SELECT state, next_due_at FROM pim_runtime.due_work WHERE owner_id = $1", [ownerId])).rows[0]!;
		expect(row.state).toBe("quiescent");
		expect(Math.abs(row.next_due_at.getTime() - dueAt)).toBeLessThan(5);
		await waitFor("the due time to reactivate the partition and the retry to answer", async () =>
			(await readTranscript(database.db, ownerId, partitionId, 1)).some((e) => textOf(e) === "recovered answer"), 20_000);
		expect((await readTranscript(database.db, ownerId, partitionId, 1)).filter((e) => e.kind === "pi.user")).toHaveLength(1);
		await runner.stop();
	});
});
