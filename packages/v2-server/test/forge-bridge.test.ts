import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeOrbClient } from "@pim/coding/orb/fake";
import { projectEntries } from "@pim/shared/transcript";
import { Authz, type Actor } from "@pim/v2-forge/authz";
import type { Db as ForgeDb } from "@pim/v2-forge/db";
import { Forge } from "@pim/v2-forge/forge";
import { MemoryObjects } from "@pim/v2-forge/ports";
import { ForgeScheduler } from "@pim/v2-forge/scheduler";
import { ForgeStore } from "@pim/v2-forge/store";
import { Credentials } from "@pim/v2-forge/tokens";
import { Projector } from "@pim/v2-live/projections/projector";
import { sidebarPage, transcriptPage } from "@pim/v2-live/projections/snapshots";
import { combineSources, forgeOutboxSource, forgePartitionId } from "../src/forge-source.ts";
import { deliverForgeWakes } from "../src/forge-wakes.ts";
import { runtimeOutboxSource } from "../src/runtime-source.ts";
import { readTranscript, textOf, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { createStack, type Stack } from "./support/stack.ts";
import { ADA, createTurnRig, fauxAssistantMessage } from "./support/turn.ts";

const REPO = "https://github.com/acme/app";
const ada: Actor = { ownerId: ADA, role: "member" };

describe("Forge's outbox joined to the runtime's inbox and to Live", () => {
	let stack: Stack;
	let rig: Awaited<ReturnType<typeof createTurnRig>>;
	let forge: Forge;
	let store: ForgeStore;
	let projector: Projector;
	let chat: string;
	const unroutable: string[] = [];
	const forgeDb = () => stack.admin as unknown as ForgeDb;

	beforeAll(async () => {
		stack = await createStack();
		rig = await createTurnRig(stack);
		store = new ForgeStore(forgeDb());
		const authz = new Authz(forgeDb(), { branchPrefix: "pim/" });
		const scheduler = new ForgeScheduler(forgeDb(), store, Date.now);
		await scheduler.upsertPool({ poolId: "default", provider: "local", size: 50 });
		for (const owner of [ADA, "ada"]) for (const p of ["coding:start"] as const) await authz.grant({ subjectType: "user", subjectId: owner, permission: p, grantedBy: "admin" });
		forge = new Forge({ db: forgeDb(), store, authz, scheduler, credentials: new Credentials(forgeDb(), "test-signing-key", authz.policy, Date.now), git: {} as never, objects: new MemoryObjects(), orbs: () => new FakeOrbClient(), compute: {} as never, ampConfigured: false });
		projector = new Projector(stack.live, { source: combineSources(runtimeOutboxSource(stack.live), forgeOutboxSource(stack.live)) });
		rig.faux.setResponses([fauxAssistantMessage("Hello, Ada.")]);
		await rig.submit("c0", "hi");
		chat = await waitFor("the chat's public id", () => rig.chatId());
	});
	afterAll(async () => {
		await rig?.runner.stop();
		await stack?.drop();
	});

	const wakes = () => deliverForgeWakes({ forge, forgeDb: forgeDb(), runtime: stack.runtime, inbox: rig.runner.inbox, onUnroutable: (id, why) => unroutable.push(`${id}: ${why}`) });

	it("shows a coding thread in the sidebar and its transcript in a coding topic, in order, and survives an owner id Live can't project", async () => {
		const { threadId } = await forge.start(ada, { operationId: "op-1", task: "Fix the flaky login test\nand add a regression test", repo: REPO, chatId: chat });
		await store.locked(threadId, async (q) => {
			await store.setState(q, threadId, "running");
			await store.appendEvent(q, threadId, { kind: "message", role: "assistant", data: { text: "Looking at it", toolCalls: [{ id: "t1", name: "read", arguments: { path: "a.ts" } }] } });
			await store.appendEvent(q, threadId, { kind: "message", role: "tool", data: { toolCallId: "t1", name: "read", text: "contents" } });
			await store.appendEvent(q, threadId, { kind: "message", role: "assistant", data: { text: "Fixed." }, costUsd: 0.25 });
		});
		// An owner id that isn't Pim's (Forge doesn't check) must not stop anyone else's projection.
		await forge.start({ ownerId: "ada", role: "member" }, { operationId: "op-x", task: "x", repo: REPO });
		await projector.drainAll();

		const sidebar = await sidebarPage(stack.live, ADA);
		expect(sidebar.coding).toMatchObject([{ threadId, title: "Fix the flaky login test", harness: "pi", state: "running", running: true }]);
		const coding = await transcriptPage(stack.live, ADA, threadId, { kind: "coding" });
		expect(coding.messages.map((m) => [m.id, m.role])).toEqual([["1", "assistant"], ["2", "tool"], ["3", "assistant"]]);
		expect(coding.messages[0]!.parts).toEqual([{ type: "text", text: "Looking at it" }, { type: "tool-call", id: "t1", name: "read", arguments: { path: "a.ts" } }]);
		// Every outbox row of the owner took the next number: the watermark has no hole, and the cost row took one without being projected.
		const mark = (await stack.admin.query("SELECT projected_seq FROM pim_projection.projection_watermarks WHERE partition_id = $1", [forgePartitionId(ADA)])).rows[0].projected_seq;
		const last = (await stack.admin.query("SELECT last_seq FROM pim_forge.forge_outbox_counters WHERE owner_id = $1", [ADA])).rows[0].last_seq;
		expect(mark).toBe(last);
		expect(Number(last)).toBeGreaterThanOrEqual(6);

		// A rebuild gives the same views from Forge's outbox alone.
		const before = JSON.stringify([(await sidebarPage(stack.live, ADA)).coding, coding.messages]);
		await projector.rebuild(ADA);
		expect(JSON.stringify([(await sidebarPage(stack.live, ADA)).coding, (await transcriptPage(stack.live, ADA, threadId, { kind: "coding" })).messages])).toBe(before);
	});

	it("wakes the chat that started a thread once, as a coding_wake the agent answers, and leaves other topics for their own consumers", async () => {
		const { threadId } = await forge.start(ada, { operationId: "op-2", task: "Bump the dependency", repo: REPO, chatId: chat });
		await store.locked(threadId, async (q) => {
			await store.appendEvent(q, threadId, { kind: "message", role: "assistant", data: { text: "done" }, costUsd: 0.1 });
			await store.emitCompletionWake(q, { threadId, chatId: chat }, "op-2", "completed", "Opened a pull request.");
		});
		rig.faux.setResponses([fauxAssistantMessage("Thanks, I will tell her.")]);
		expect(await wakes()).toBe(1);
		const sees = async () => (await readTranscript(stack.runtime, ADA, rig.home, 1)).map(textOf);
		await waitFor("the agent to answer the wake", async () => ((await sees()).includes("Thanks, I will tell her.") ? true : undefined));
		const heard = (await sees()).filter((t) => t.startsWith("[Coding thread"));
		expect(heard).toHaveLength(1);
		expect(heard[0]).toContain(`[Coding thread ${threadId}] It finished its turn.\nState: `);
		expect(heard[0]).toContain("Detail: Opened a pull request.");
		expect(heard[0]).toContain("It last said:\ndone");
		// Delivered rows are not delivered again, and the same wake sent again is the same command.
		expect(await wakes()).toBe(0);
		await store.locked(threadId, (q) => store.emitCompletionWake(q, { threadId, chatId: chat }, "op-2", "completed", "Opened a pull request."));
		expect(await wakes()).toBe(0);
		// The cost row was left for the ledger's consumer.
		expect((await stack.admin.query("SELECT count(*)::int AS n FROM pim_forge.forge_outbox WHERE topic = 'cost_ledger' AND delivered_at IS NULL")).rows[0].n).toBeGreaterThan(0);
		expect(unroutable).toEqual([]);
	});

	it("reports and drops a wake whose chat does not exist instead of retrying it forever", async () => {
		const gone = "99999999-9999-4999-8999-999999999999";
		const { threadId } = await forge.start(ada, { operationId: "op-3", task: "Orphan", repo: REPO, chatId: gone });
		await store.locked(threadId, (q) => store.emitCompletionWake(q, { threadId, chatId: gone }, "op-3", "failed"));
		expect(await wakes()).toBe(1);
		expect(unroutable).toHaveLength(1);
		expect(unroutable[0]).toMatch(/no such chat/);
		expect(await wakes()).toBe(0);
	});
});
