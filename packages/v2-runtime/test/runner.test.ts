import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelAdmission, admitModels } from "../src/admission.ts";
import { PartitionDirectory } from "../src/directory.ts";
import { assertDurability } from "../src/durability.ts";
import { assessInspection } from "../src/quiescence.ts";
import { createTestDatabase, type TestDatabase } from "./support/pg.ts";
import { uniqueOwner } from "./support/partition.ts";
import { command } from "./support/commands.ts";
import { createRig, fauxToolCall, latch, readTranscript, textOf, waitFor } from "./support/rig.ts";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(async () => {
	await database.drop();
});

const hello = (runner: ReturnType<ReturnType<typeof createRig>["runner"]>, ownerId: string, partitionId: string, requestId: string) =>
	command(runner.inbox, ownerId, partitionId, requestId, 1, { content: `hello ${requestId}` });

describe("memory boundedness", () => {
	it("keeps at most maxResident Harnesses and rehydrates evicted partitions for their next command", async () => {
		// Five owners, one home partition each, all wanting a Runner that holds at most two.
		const owners = Array.from({ length: 5 }, () => uniqueOwner());
		const rig = createRig(database.db, owners[0]!);
		const directory = new PartitionDirectory(database.db);
		const homes = new Map<string, string>();
		for (const ownerId of owners) homes.set(ownerId, await directory.createPartition(ownerId, { kind: "home" }));
		rig.faux.setResponses(Array.from({ length: 5 }, (_, i) => fauxAssistantMessage(`answer ${i}`)));
		let peak = 0;
		const runner = rig.runner({
			maxResident: 2,
			idleUnloadMs: 60_000,
			ownerFilter: undefined,
			onEvent: (e) => {
				rig.events.push(e);
				peak = Math.max(peak, runner.residents.length);
			},
		});
		await runner.start();
		for (const ownerId of owners) await hello(runner, ownerId, homes.get(ownerId)!, "first");
		await waitFor("every partition's command to complete", async () => {
			let done = 0;
			for (const ownerId of owners) done += (await database.db.read(ownerId, "SELECT 1 FROM pim_runtime.command_inbox WHERE owner_id = $1 AND done_at IS NOT NULL", [ownerId])).rowCount ?? 0;
			if (done !== 5) return undefined;
			let answered = 0;
			for (const ownerId of owners) answered += (await readTranscript(database.db, ownerId, homes.get(ownerId)!, 1)).filter((e) => e.kind === "pi.assistant" && textOf(e) !== "").length;
			return answered === 5 ? true : undefined;
		}, 30_000);
		expect(peak).toBeLessThanOrEqual(2);
		expect(rig.events.filter((e) => e.type === "evicted" && e.reason === "capacity").length).toBeGreaterThanOrEqual(3);
		// An evicted partition comes back for a later command.
		const first = owners[0]!;
		await waitFor("the first owner to be released", () => (runner.resident(first, homes.get(first)!) === undefined ? true : undefined));
		rig.faux.setResponses([fauxAssistantMessage("welcome back")]);
		await hello(runner, first, homes.get(first)!, "again");
		await waitFor("the evicted home to rehydrate", async () => (await readTranscript(database.db, first, homes.get(first)!, 1)).some((e) => textOf(e) === "welcome back"));
		await runner.stop();
	});
});

describe("drain", () => {
	it("stops claiming, releases quiet partitions, and hands a still-busy one to the next Runner with its wake intent", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const directory = new PartitionDirectory(database.db);
		const busy = await directory.createPartition(ownerId, { kind: "home" });
		const hold = latch();
		let signal: AbortSignal | undefined;
		rig.faux.setResponses([
			async (_c, options) => {
				signal = options?.signal;
				await Promise.race([hold.promise, new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r(), { once: true }))]);
				return fauxAssistantMessage("late");
			},
			fauxAssistantMessage("finished by B"),
		]);
		const runnerA = rig.runner({ steward: { holderId: "runner-a", leaseTtlMs: 10_000 }, idleUnloadMs: 60_000 });
		await runnerA.start();
		await hello(runnerA, ownerId, busy, "busy");
		await waitFor("the model call to start", () => signal);
		const other = await directory.createPartition(ownerId);
		await runnerA.drain(400);
		expect(runnerA.steward.draining).toBe(true);
		expect(signal?.aborted).toBe(true); // the in-flight call was cut off at the deadline
		expect(rig.events.some((e) => e.type === "drained" && e.partitionId === busy && e.handedOff)).toBe(true);
		const row = (await database.db.read<{ holder_id: string | null; state: string }>(ownerId, "SELECT p.holder_id, d.state FROM pim_runtime.partitions p JOIN pim_runtime.due_work d USING (owner_id, partition_id) WHERE p.owner_id = $1 AND p.partition_id = $2", [ownerId, busy])).rows[0]!;
		expect(row).toEqual({ holder_id: null, state: "needs_owner" });
		// A drained Runner claims nothing more, even the partition created after the drain began.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect((await database.db.read(ownerId, "SELECT 1 FROM pim_runtime.partitions WHERE owner_id = $1 AND partition_id = $2 AND holder_id IS NOT NULL", [ownerId, other])).rowCount).toBe(0);
		// The next Runner takes over at once, without waiting for any lease to expire, and finishes the turn once.
		const runnerB = rig.runner({ steward: { holderId: "runner-b" } });
		await runnerB.start();
		await waitFor("the turn to finish on the new Runner", async () => (await readTranscript(database.db, ownerId, busy, 1)).some((e) => textOf(e) === "finished by B"));
		expect((await readTranscript(database.db, ownerId, busy, 1)).filter((e) => e.kind === "pi.user")).toHaveLength(1);
		await runnerB.stop();
	});

	it("releases a quiet partition atomically during a drain", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const home = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		const runner = rig.runner({ idleUnloadMs: 60_000 });
		await runner.activate(ownerId, home);
		await runner.drain(2_000);
		expect(rig.events.some((e) => e.type === "drained" && e.handedOff === false)).toBe(true);
		const row = (await database.db.read<{ holder_id: string | null }>(ownerId, "SELECT holder_id FROM pim_runtime.partitions WHERE owner_id = $1", [ownerId])).rows[0]!;
		expect(row.holder_id).toBeNull();
	});
});

describe("model admission", () => {
	it("gives every owner its turn and never exceeds the owner or global cap", async () => {
		const admission = new ModelAdmission({ globalLimit: 2, perOwnerLimit: 1 });
		const order: string[] = [];
		const permits = new Map<string, { release(): void }>();
		const request = async (owner: string, tag: string): Promise<void> => {
			const permit = (await admission.acquire(owner, "faux"))!;
			order.push(tag);
			permits.set(tag, permit);
		};
		// Owner A queues four calls before owner B asks for one.
		const a = ["a1", "a2", "a3", "a4"].map((tag) => request("A", tag));
		await waitFor("a1", () => permits.get("a1"));
		const b = request("B", "b1");
		await waitFor("b1 admitted next to a1 despite A's queue", () => permits.get("b1"));
		expect(order).toEqual(["a1", "b1"]);
		expect(admission.inFlight).toBe(2);
		expect(admission.inFlightFor("A")).toBe(1); // the per-owner cap held A to one
		permits.get("a1")!.release();
		await waitFor("a2", () => permits.get("a2"));
		permits.get("b1")!.release();
		permits.get("a2")!.release();
		await waitFor("a3", () => permits.get("a3"));
		permits.get("a3")!.release();
		await waitFor("a4", () => permits.get("a4"));
		permits.get("a4")!.release();
		await Promise.all([...a, b]);
		expect(admission.inFlight).toBe(0);
		expect(admission.waiting).toBe(0);
	});

	it("serves a second owner while a rate-limited first owner's stream is stuck, and cuts waiting calls when their signal aborts", async () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const admission = new ModelAdmission({ globalLimit: 2, perOwnerLimit: 1 });
		const stuck = latch();
		faux.setResponses([async () => { await stuck.promise; return fauxAssistantMessage("slow"); }, fauxAssistantMessage("fast"), fauxAssistantMessage("never")]);
		const lease = new AbortController();
		const slow = admitModels(models, { admission, ownerId: "A", signal: lease.signal });
		const other = admitModels(models, { admission, ownerId: "B", signal: new AbortController().signal });
		const model = faux.getModel();
		const first = slow.complete(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] });
		await waitFor("A's stream to hold its slot", () => (admission.inFlightFor("A") === 1 ? true : undefined));
		const queued = slow.complete(model, { messages: [{ role: "user", content: "y", timestamp: 1 }] }); // A's second call waits behind its own cap
		const fast = await other.complete(model, { messages: [{ role: "user", content: "z", timestamp: 1 }] });
		expect(fast.content).toMatchObject([{ text: "fast" }]);
		expect(admission.waiting).toBe(1);
		lease.abort(); // the lease behind A's calls is lost: the queued call leaves the queue
		const aborted = await queued;
		expect(aborted.errorMessage).toMatch(/abort/i); // pi-ai's own answer to a call whose signal is already aborted
		expect(faux.state.callCount).toBe(2); // the queued call never reached the provider
		stuck.release();
		await first;
		expect(admission.inFlight).toBe(0);
	});

	it("runs a Runner's turns through admission", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const home = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		rig.faux.setResponses([fauxAssistantMessage("admitted answer")]);
		const runner = rig.runner({ admission: { globalLimit: 1, perOwnerLimit: 1 } });
		await runner.start();
		await hello(runner, ownerId, home, "r");
		await waitFor("the answer", async () => (await readTranscript(database.db, ownerId, home, 1)).some((e) => textOf(e) === "admitted answer"));
		expect(runner.admission?.inFlight).toBe(0);
		await runner.stop();
	});
});

describe("durability profile", () => {
	it("refuses a server whose synchronous_commit is off", async () => {
		expect(await assertDurability(database.db, "strict")).toBe("on");
		const off = await createTestDatabase();
		try {
			await off.db.pool.query(`ALTER DATABASE ${off.name} SET synchronous_commit = off`);
			await off.db.close();
			const { Db } = await import("../src/db.ts");
			const fresh = Db.connect({ connectionString: off.url });
			await expect(assertDurability(fresh, "relaxed")).rejects.toThrow(/synchronous_commit is off/);
			await fresh.close();
		} finally {
			await off.drop().catch(() => {});
		}
	});
});

describe("assessInspection", () => {
	const task = (id: number, conversationId: number, kind: string, state: unknown, checkpoint?: unknown): never =>
		({ record: { id, conversationId, kind, state: { status: "running", checkpoint } }, state }) as never;
	const now = 1_000_000;
	it("parks a run waiting on a suspended tool, and needs an owner for one waiting on a ready tool", () => {
		const parked = assessInspection({ scheduling: "running", submissions: [], tasks: [task(1, 1, "pi.generation", { kind: "waiting", on: [2] }), task(2, 1, "pi.tool", { kind: "suspended" })] }, now, { longWaitMs: 60_000 });
		expect(parked).toMatchObject({ needsOwner: false, nextDueAt: undefined });
		const busy = assessInspection({ scheduling: "running", submissions: [], tasks: [task(1, 1, "pi.generation", { kind: "waiting", on: [2] }), task(2, 1, "pi.tool", { kind: "pending", migrates: false })] }, now, { longWaitMs: 60_000 });
		expect(busy.needsOwner).toBe(true);
	});
	it("turns a far sleep into a due time and keeps a near one", () => {
		const far = assessInspection({ scheduling: "running", submissions: [], tasks: [task(1, 1, "pi.generation", { kind: "running" }, { phase: "retry", until: now + 120_000 })] }, now, { longWaitMs: 60_000 });
		expect(far).toMatchObject({ needsOwner: false, nextDueAt: now + 120_000 });
		const near = assessInspection({ scheduling: "running", submissions: [], tasks: [task(1, 1, "pi.generation", { kind: "running" }, { phase: "retry", until: now + 5_000 })] }, now, { longWaitMs: 60_000 });
		expect(near.needsOwner).toBe(true);
		const poll = assessInspection({ scheduling: "running", submissions: [], tasks: [task(1, 1, "pi.generation", { kind: "pending", migrates: false }, { phase: "poll", pollAt: now + 90_000 })] }, now, { longWaitMs: 60_000, liveDue: [now + 70_000] });
		expect(poll).toMatchObject({ needsOwner: false, nextDueAt: now + 70_000 });
	});
	it("needs an owner for a queued input unless a parked run holds it", () => {
		const queued = { id: 9, conversationId: 1, type: "input", status: "queued" } as never;
		expect(assessInspection({ scheduling: "running", submissions: [queued], tasks: [] }, now, { longWaitMs: 1 }).needsOwner).toBe(true);
		const behindParked = assessInspection({ scheduling: "running", submissions: [queued], tasks: [task(2, 1, "pi.tool", { kind: "suspended" })] }, now, { longWaitMs: 1 });
		expect(behindParked.needsOwner).toBe(false);
		expect(assessInspection({ scheduling: "running", submissions: [queued], tasks: [task(2, 2, "pi.tool", { kind: "suspended" })] }, now, { longWaitMs: 1 }).needsOwner).toBe(true);
	});
});

describe("one person's active chats", () => {
	it("run on separate partitions at the same time, across Runners, instead of one after another", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const directory = new PartitionDirectory(database.db);
		const home = await directory.createPartition(ownerId, { kind: "home" });
		const chats = [home];
		for (let i = 0; i < 9; i++) chats.push(await directory.createPartition(ownerId));
		// Every model call waits until ten are in flight together. Serialized on one mutation line this could never happen.
		let inFlight = 0;
		let peak = 0;
		const together = latch();
		rig.faux.setResponses(
			Array.from({ length: 10 }, (_, i) => async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				if (inFlight === 10) together.release();
				await Promise.race([together.promise, new Promise((resolve) => setTimeout(resolve, 8_000))]);
				inFlight--;
				return fauxAssistantMessage(`reply ${i}`);
			}),
		);
		const runnerA = rig.runner({ steward: { holderId: "runner-a" }, idleUnloadMs: 60_000 });
		const runnerB = rig.runner({ steward: { holderId: "runner-b" }, idleUnloadMs: 60_000 });
		await Promise.all([runnerA.start(), runnerB.start()]);
		await hello(runnerA, ownerId, home, "home-chat");
		for (const partitionId of chats.slice(1)) {
			await runnerA.inbox.enqueueCreateConversation(ownerId, partitionId, { commandId: "new-chat", firstInput: "hello from a chat" });
		}
		await waitFor("all ten chats to answer", async () => {
			const answers = await database.db.read(ownerId, "SELECT 1 FROM pim_runtime.entries WHERE owner_id = $1 AND record LIKE '%\"kind\":\"pi.assistant\"%' AND record LIKE '%reply %'", [ownerId]);
			return answers.rowCount === 10 ? true : undefined;
		}, 30_000);
		expect(peak).toBe(10);
		const partitionsWithChats = await database.db.read(ownerId, "SELECT DISTINCT partition_id FROM pim_runtime.conversations WHERE owner_id = $1", [ownerId]);
		expect(partitionsWithChats.rowCount).toBe(10); // the home's root and nine families, each a conversation in its own partition
		await Promise.all([runnerA.stop(), runnerB.stop()]);
	});
});

describe("a chat's model", () => {
	it("is read again before each message, so a model chosen since the last turn answers the next", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const home = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		const chosen = { model: { provider: "faux", modelId: "m" } };
		const runner = rig.runner({ chatAgent: () => chosen });
		const answeredBy = async (): Promise<string[]> => (await readTranscript(database.db, ownerId, home, 1)).flatMap((e) => (e.kind === "pi.assistant" ? (e.model ?? []).map((m) => (m as { model?: string }).model ?? "") : []));
		rig.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three"), fauxAssistantMessage("four")]);
		await runner.start();
		await hello(runner, ownerId, home, "first");
		await waitFor("the first answer", async () => ((await answeredBy()).length === 1 ? true : undefined));
		chosen.model = { provider: "faux", modelId: "m2" };
		await hello(runner, ownerId, home, "second");
		await waitFor("the second answer", async () => ((await answeredBy()).length === 2 ? true : undefined));
		await hello(runner, ownerId, home, "third");
		await waitFor("the third answer", async () => ((await answeredBy()).length === 3 ? true : undefined));
		// Only the deployment's default standing in (nothing named a model) never replaces the model the chat runs on, as for a chat imported from v1.
		Object.assign(chosen, { model: { provider: "faux", modelId: "m" }, explicit: false });
		await hello(runner, ownerId, home, "fourth");
		await waitFor("the fourth answer", async () => ((await answeredBy()).length === 4 ? true : undefined));
		expect(await answeredBy()).toEqual(["m", "m2", "m2", "m2"]);
		await runner.stop();
	});
});

describe("run guard and watchdog", () => {
	const hang = () => fauxAssistantMessage(fauxToolCall("hang", {}), { stopReason: "toolUse" });
	const toolResults = async (ownerId: string, partitionId: string) => (await readTranscript(database.db, ownerId, partitionId, 1)).filter((e) => e.kind === "pi.tool-result");

	it("a stop ends a run stuck in a tool that ignores its abort, and the chat answers the next message", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const home = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		rig.faux.setResponses([hang(), fauxAssistantMessage("after the stop")]);
		const runner = rig.runner({ idleUnloadMs: 60_000, abortGraceMs: 500 });
		await runner.start();
		await command(runner.inbox, ownerId, home, "m1", 1, { content: "go" });
		await waitFor("the tool to hang", () => rig.state.hangs > 0 || undefined);
		await command(runner.inbox, ownerId, home, "stop", 1, {}, "abort");
		await waitFor("the stop to complete", async () => (await database.db.read(ownerId, "SELECT 1 FROM pim_runtime.command_inbox WHERE owner_id = $1 AND command_id = 'stop' AND done_at IS NOT NULL", [ownerId])).rowCount === 1 || undefined);
		expect(rig.events.some((e) => e.type === "stalled" && e.recycled)).toBe(true);
		// The next claim's recovery settles the aborted tool call; the chat is free again.
		await waitFor("the tool call to be settled as aborted", async () => ((await toolResults(ownerId, home)).some((e) => JSON.stringify(e).includes("was aborted")) ? true : undefined));
		await command(runner.inbox, ownerId, home, "m2", 1, { content: "again" });
		await waitFor("the next message to be answered", async () => (await readTranscript(database.db, ownerId, home, 1)).some((e) => textOf(e) === "after the stop"));
		expect(rig.state.hangs).toBe(1);
		await runner.stop();
	});

	it("the watchdog stops a run that makes no progress and says so, and leaves a run parked for a decision alone", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const home = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		rig.faux.setResponses([fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" })]);
		const runner = rig.runner({ idleUnloadMs: 60_000, stallMs: 600, abortGraceMs: 500 });
		await runner.start();
		await command(runner.inbox, ownerId, home, "m1", 1, { content: "ask" });
		await waitFor("the gate to run", () => rig.state.gateRuns[0]);
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(rig.events.some((e) => e.type === "stalled")).toBe(false); // waiting on a person is not a stall
		expect(await toolResults(ownerId, home)).toHaveLength(0);
		await runner.stop();

		const stuckOwner = uniqueOwner();
		const stuck = createRig(database.db, stuckOwner);
		const stuckHome = await new PartitionDirectory(database.db).createPartition(stuckOwner, { kind: "home" });
		stuck.faux.setResponses([hang(), fauxAssistantMessage("recovered")]);
		const second = stuck.runner({ idleUnloadMs: 60_000, stallMs: 600, abortGraceMs: 500 });
		await second.start();
		await command(second.inbox, stuckOwner, stuckHome, "m1", 1, { content: "go" });
		await waitFor("the tool to hang", () => stuck.state.hangs > 0 || undefined);
		await waitFor("the watchdog to stop the run", () => stuck.events.some((e) => e.type === "stalled") || undefined, 20_000);
		await waitFor("the tool call to be settled as aborted", async () => ((await toolResults(stuckOwner, stuckHome)).some((e) => JSON.stringify(e).includes("was aborted")) ? true : undefined), 20_000);
		// The tool ignored the stop, so the partition was recycled; the note that says why the chat stopped is not lost with it, and is there once.
		expect(stuck.events.some((e) => e.type === "stalled" && e.recycled)).toBe(true);
		await waitFor("the note that says why", async () => ((await readTranscript(database.db, stuckOwner, stuckHome, 1)).some((e) => JSON.stringify(e).includes("Pim stopped this turn")) ? true : undefined), 20_000);
		await command(second.inbox, stuckOwner, stuckHome, "m2", 1, { content: "again" });
		await waitFor("the chat to answer again", async () => (await readTranscript(database.db, stuckOwner, stuckHome, 1)).some((e) => textOf(e) === "recovered"));
		expect((await readTranscript(database.db, stuckOwner, stuckHome, 1)).filter((e) => JSON.stringify(e).includes("Pim stopped this turn"))).toHaveLength(1);
		await second.stop();
	});

	it("tells the person why when the watchdog stopped a run that ended at once", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const home = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		// A call that waits on something that never comes, but ends when it is stopped.
		rig.state.gateLatch = latch();
		rig.faux.setResponses([fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" })]);
		const runner = rig.runner({ idleUnloadMs: 60_000, stallMs: 600, abortGraceMs: 2_000 });
		await runner.start();
		await command(runner.inbox, ownerId, home, "m1", 1, { content: "go" });
		await waitFor("the watchdog to say why", async () => ((await readTranscript(database.db, ownerId, home, 1)).some((e) => JSON.stringify(e).includes("Pim stopped this turn")) ? true : undefined), 20_000);
		expect(rig.events.some((e) => e.type === "stalled" && !e.recycled)).toBe(true);
		await runner.stop();
	});
});

describe("a retry after a model error", () => {
	it("asks the model again in the held run, with the message once in the transcript", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const home = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		// A failure no retry cures holds the run, as the agent host's settings do.
		(rig.settings.retry as Record<string, unknown>).suspend = () => true;
		rig.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "422 GCPVertexAIBackendError" }), fauxAssistantMessage("second time lucky")]);
		const runner = rig.runner({ idleUnloadMs: 60_000 });
		await runner.start();
		await command(runner.inbox, ownerId, home, "m1", 1, { content: "plan my week" });
		await waitFor("the failed request to be in the transcript", async () => ((await readTranscript(database.db, ownerId, home, 1)).some((e) => JSON.stringify(e).includes("GCPVertexAIBackendError")) ? true : undefined));
		await command(runner.inbox, ownerId, home, "r1", 1, { content: "plan my week", retry: true });
		await waitFor("the model to answer the retry", async () => ((await readTranscript(database.db, ownerId, home, 1)).some((e) => textOf(e) === "second time lucky") ? true : undefined), 20_000);
		expect((await readTranscript(database.db, ownerId, home, 1)).filter((e) => e.kind === "pi.user")).toHaveLength(1);
		await runner.stop();
	});

	it("goes on with the held run when the person writes a new message instead", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const home = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		(rig.settings.retry as Record<string, unknown>).suspend = () => true;
		rig.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "422 GCPVertexAIBackendError" }), fauxAssistantMessage("answered both")]);
		const runner = rig.runner({ idleUnloadMs: 60_000 });
		await runner.start();
		await command(runner.inbox, ownerId, home, "m1", 1, { content: "plan my week" });
		await waitFor("the failed request to be in the transcript", async () => ((await readTranscript(database.db, ownerId, home, 1)).some((e) => JSON.stringify(e).includes("GCPVertexAIBackendError")) ? true : undefined));
		await command(runner.inbox, ownerId, home, "m2", 1, { content: "never mind, plan the weekend" });
		await waitFor("the model to answer", async () => ((await readTranscript(database.db, ownerId, home, 1)).some((e) => textOf(e) === "answered both") ? true : undefined), 20_000);
		await runner.stop();
	});
});

describe("retry from a message", () => {
	const said = (messages: { role: string; content: unknown }[]) => messages.filter((m) => m.role !== "system").map((m) => `${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content).match(/"text":"([^"]*)"/)?.[1] ?? ""}`);

	it("takes the chat back to the message in place, leaves what came after out of the model's context, and answers it again", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const home = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		const seen: string[][] = [];
		const answer = (text: string) => (ctx: { messages: { role: string; content: unknown }[] }) => (seen.push(said(ctx.messages)), fauxAssistantMessage(text));
		rig.faux.setResponses([answer("a1"), answer("a2"), answer("a3"), answer("a2 again")] as never);
		const runner = rig.runner({ idleUnloadMs: 60_000 });
		await runner.start();
		const entries = () => readTranscript(database.db, ownerId, home, 1);
		const done = async (id: string) => (await database.db.read(ownerId, "SELECT 1 FROM pim_runtime.command_inbox WHERE owner_id = $1 AND command_id = $2 AND done_at IS NOT NULL", [ownerId, id])).rowCount === 1 || undefined;
		for (const [id, text, reply] of [["m1", "one", "a1"], ["m2", "two", "a2"], ["m3", "three", "a3"]] as const) {
			await command(runner.inbox, ownerId, home, id, 1, { content: text });
			await waitFor(`${reply}`, async () => (await entries()).some((e) => textOf(e) === reply) || undefined);
		}
		const two = (await entries()).find((e) => e.kind === "pi.user" && textOf(e) === "two")!;
		// A message that is not the person's is refused, and so is one of another conversation's; neither changes anything.
		await command(runner.inbox, ownerId, home, "bad", 1, { entry: String(two.id + 1) }, "retry_from");
		await waitFor("the refusal", () => done("bad"));
		expect((await entries()).some((e) => e.kind === "pim.retry")).toBe(false);
		await command(runner.inbox, ownerId, home, "retry", 1, { entry: String(two.id) }, "retry_from");
		await waitFor("the answer again", async () => (await entries()).some((e) => textOf(e) === "a2 again") || undefined);
		// The model was asked again with what it had been given up to the message, and nothing of what came after.
		expect(seen.at(-1)).toEqual(["user:one", "assistant:a1", "user:two"]);
		const log = await entries();
		const retry = log.find((e) => e.kind === "pim.retry")!;
		// Nothing is deleted: the later entries are all there, and the one entry says they are left out. The message itself stays, once.
		expect(retry.edits?.map((edit) => edit.target)).toEqual(log.filter((e) => e.id > two.id && e.id < retry.id).map((e) => e.id));
		expect(log.filter((e) => e.kind === "pi.user" && textOf(e) === "two")).toHaveLength(1);
		// The chat goes on from there, and a command that is delivered again leaves nothing out twice.
		rig.faux.setResponses([answer("a4")] as never);
		await command(runner.inbox, ownerId, home, "m4", 1, { content: "four" });
		await waitFor("a4", async () => (await entries()).some((e) => textOf(e) === "a4") || undefined);
		expect(seen.at(-1)).toEqual(["user:one", "assistant:a1", "user:two", "assistant:a2 again", "user:four"]);
		await runner.stop();
	});
	it("undoes a new context begun after the message, with the context the message had", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const home = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		const seen: string[][] = [];
		const answer = (text: string) => (ctx: { messages: { role: string; content: unknown }[] }) => (seen.push(said(ctx.messages)), fauxAssistantMessage(text));
		rig.faux.setResponses([answer("a1"), answer("a2"), answer("a3"), answer("a2 again")] as never);
		const runner = rig.runner({ idleUnloadMs: 60_000 });
		await runner.start();
		const entries = () => readTranscript(database.db, ownerId, home, 1);
		const sent = async (id: string, text: string, reply: string) => {
			await command(runner.inbox, ownerId, home, id, 1, { content: text });
			await waitFor(reply, async () => (await entries()).some((e) => textOf(e) === reply) || undefined);
		};
		await sent("m1", "one", "a1");
		await sent("m2", "two", "a2");
		await command(runner.inbox, ownerId, home, "new-context", 1, { handoff: "We spoke of one and two." }, "compaction_handoff");
		await waitFor("the new context", async () => ((await entries()).some((e) => e.kind === "pi.reset") ? true : undefined));
		await sent("m3", "three", "a3");
		expect(seen.at(-1)).toEqual(["user:We spoke of one and two.", "user:three"]);
		const two = (await entries()).find((e) => e.kind === "pi.user" && textOf(e) === "two")!;
		await command(runner.inbox, ownerId, home, "retry", 1, { entry: String(two.id) }, "retry_from");
		await waitFor("the answer again", async () => (await entries()).some((e) => textOf(e) === "a2 again") || undefined);
		// The model reads what it read at the message, not the new context that came after it.
		expect(seen.at(-1)).toEqual(["user:one", "assistant:a1", "user:two"]);
		await runner.stop();
	});
	it("does not cut off a run at work", async () => {
		const ownerId = uniqueOwner();
		const rig = createRig(database.db, ownerId);
		const home = await new PartitionDirectory(database.db).createPartition(ownerId, { kind: "home" });
		rig.faux.setResponses([fauxAssistantMessage(fauxToolCall("hang", {}), { stopReason: "toolUse" }), fauxAssistantMessage("after the stop")]);
		const runner = rig.runner({ idleUnloadMs: 60_000, abortGraceMs: 500 });
		await runner.start();
		const entries = () => readTranscript(database.db, ownerId, home, 1);
		await command(runner.inbox, ownerId, home, "m1", 1, { content: "go" });
		await waitFor("the tool to hang", () => rig.state.hangs > 0 || undefined);
		const go = (await entries()).find((e) => e.kind === "pi.user")!;
		await command(runner.inbox, ownerId, home, "retry", 1, { entry: String(go.id) }, "retry_from");
		await waitFor("the retry to be refused", async () => (await database.db.read(ownerId, "SELECT 1 FROM pim_runtime.command_inbox WHERE owner_id = $1 AND command_id = 'retry' AND done_at IS NOT NULL", [ownerId])).rowCount === 1 || undefined);
		expect((await entries()).some((e) => e.kind === "pim.retry")).toBe(false);
		expect(rig.state.hangs).toBe(1);
		await command(runner.inbox, ownerId, home, "stop", 1, {}, "abort");
		await waitFor("the stop to complete", async () => (await database.db.read(ownerId, "SELECT 1 FROM pim_runtime.command_inbox WHERE owner_id = $1 AND command_id = 'stop' AND done_at IS NOT NULL", [ownerId])).rowCount === 1 || undefined);
		await runner.stop();
	});
});
