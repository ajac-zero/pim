// Family A: a real pi-durable 1.5.2 Harness per thread, on PostgreSQL, with the coding tools running in the sandbox.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fakeManager, TOKEN, URL_BASE } from "@pim/coding/support/fake-manager";
import { ComposeWorkspaceProvider } from "@pim/coding/workspace/compose";
import { PiTurnPort } from "../src/pi-port";
import { PgPiStorage, piCommitCount } from "../src/pi-storage";
import { Seeded } from "./seeded";
import type { WorkspaceAgentComputeProvider } from "../src/workspace-agent";
import { ada, startReq, stack } from "./stack";

describe("pi on pi-durable and PostgreSQL", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let agent: WorkspaceAgentComputeProvider;
	let port: PiTurnPort;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", contextWindow: 200_000 }] });
	const ran: string[][] = [];

	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		const manager = fakeManager(5);
		manager.backing.register("sh", async (ctx) => {
			ran.push(ctx.argv);
			if (ctx.argv.join(" ").includes("sleepy")) await new Promise((r) => setTimeout(r, 800));
			return { stdout: "built ok\n", code: 0 };
		});
		agent = new Seeded(new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: manager.fetch, sleep: async () => {} }));
		const models = createModels();
		models.setProvider(faux.provider);
		port = new PiTurnPort({ store: s.store, compute: agent, models: async () => models, defaultModel: { provider: "faux", modelId: "faux-model" }, lookMs: 50 });
	});
	afterAll(async () => s.close());

	const worker = () => s.worker({ compute: agent, turns: { pi: port } });

	it("runs a thread's turn through pi-durable: the model calls a tool that runs in the sandbox, journaled, and the transcript and commits are in pim_forge", async () => {
		faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "make build" }), { stopReason: "toolUse" }), fauxAssistantMessage("Built it.")]);
		const { threadId } = await s.forge.start(ada, startReq("pi-real", { harness: "pi" }));
		expect(await worker().step(threadId)).toBe("done");
		expect(faux.getPendingResponseCount()).toBe(0);
		expect(ran.some((a) => a.join(" ").includes("make build"))).toBe(true);
		expect(await s.store.get(threadId)).toMatchObject({ state: "idle" });
		const events = (await s.forge.transcript(ada, threadId)).events;
		expect(events.map((e) => e.role)).toEqual(["user", "assistant", "tool", "assistant"]);
		expect(events[1]!.data.toolCalls[0]).toMatchObject({ name: "bash" });
		expect(events[2]!.data.text).toContain("built ok");
		expect(await s.forge.transcriptOutput(ada, threadId)).toEqual({ text: "Built it." });
		// The call was journaled in forge_tool_journal before and after it ran.
		const journal = (await s.pool.query("select tool, result from pim_forge.forge_tool_journal where thread_id = $1", [threadId])).rows;
		expect(journal).toHaveLength(1);
		expect(journal[0]).toMatchObject({ tool: "bash", result: { state: "done" } });
		expect(await piCommitCount(s.store, threadId)).toBeGreaterThan(3);
	});

	it("a resumed turn finds its submission by request id: no second model call, no second tool run, no duplicate transcript", async () => {
		faux.setResponses([fauxAssistantMessage("only once")]);
		const { threadId } = await s.forge.start(ada, startReq("pi-resume", { harness: "pi" }));
		const w = worker();
		await w.step(threadId);
		const calls = ran.length;
		const before = (await s.forge.transcript(ada, threadId)).events.length;
		// A dead worker's turn comes back as a resume of the same root operation.
		faux.setResponses([fauxAssistantMessage("must not be used")]);
		await s.store.locked(threadId, (q) => s.store.enqueueInbox(q, threadId, "resume-pi-resume-1", "resume", { prompt: "Continue." }));
		await w.step(threadId);
		expect(faux.getPendingResponseCount()).toBe(1);
		expect(ran.length).toBe(calls);
		expect((await s.forge.transcript(ada, threadId)).events.length).toBe(before);
	});

	it("keeps each thread's storage apart and fences a worker that lost the lease", async () => {
		faux.setResponses([fauxAssistantMessage("a")]);
		const a = (await s.forge.start(ada, startReq("pi-a", { harness: "pi" }))).threadId;
		await worker().step(a);
		const b = (await s.forge.start(ada, startReq("pi-b", { harness: "pi" }))).threadId;
		expect(await piCommitCount(s.store, b)).toBe(0);
		// Reopening replays the log: the conversation is there, with the same entries.
		const epoch = (await s.store.get(a))!.leaseEpoch;
		const reopened = await PgPiStorage.open(s.store, a, epoch);
		const entries = await reopened.scanConversations({}, 10, undefined, undefined as never);
		expect(entries.items.length).toBeGreaterThan(0);
		// A stale epoch can validate a write in memory but never reaches the log.
		const before = await piCommitCount(s.store, a);
		const stale = await PgPiStorage.open(s.store, a, epoch - 1);
		await expect(stale.commit([], () => {}, undefined as never)).rejects.toMatchObject({ code: "lease_lost" });
		expect(await piCommitCount(s.store, a)).toBe(before);
	});

	it("stops a turn when its spend crosses the budget, mid-turn, and fails the thread for it", async () => {
		// The faux provider reports no cost, so every call it answers is billed $2 here.
		const priced = fauxProvider({ provider: "priced", models: [{ id: "m", contextWindow: 200_000 }] });
		const bill = <M extends { usage: any }>(m: M): M => ({ ...m, usage: { ...m.usage, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } } });
		const billed = (stream: (...a: any[]) => any) => (...a: any[]) => {
			const out = createAssistantMessageEventStream();
			void (async () => {
				const inner = stream(...a);
				for await (const e of inner) out.push("message" in e ? { ...e, message: bill(e.message) } : "error" in e ? { ...e, error: bill(e.error) } : e);
				out.end(bill(await inner.result()));
			})();
			return out;
		};
		const models = createModels();
		models.setProvider({ ...priced.provider, stream: billed(priced.provider.stream), streamSimple: billed(priced.provider.streamSimple) } as never);
		const pricey = new PiTurnPort({ store: s.store, compute: agent, models: async () => models, defaultModel: { provider: "priced", modelId: "m" }, lookMs: 50 });
		priced.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "sleepy one" }), { stopReason: "toolUse" }), fauxAssistantMessage("never reached")]);
		const { threadId } = await s.forge.start(ada, startReq("pi-budget", { harness: "pi", budgetUsd: 0.5 }));
		await s.worker({ compute: agent, turns: { pi: pricey } }).step(threadId);
		// The first call alone cost $2 of the $0.50: the second was never made.
		expect(priced.getPendingResponseCount()).toBe(1);
		expect(await s.store.get(threadId)).toMatchObject({ state: "failed", stateReason: "budget" });
	});

	it("a steer sent while the turn runs joins it after its current step, instead of waiting for a second turn", async () => {
		faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "sleepy two" }), { stopReason: "toolUse" }), fauxAssistantMessage("Did both.")]);
		const { threadId } = await s.forge.start(ada, startReq("pi-steer", { harness: "pi" }));
		const running = worker().step(threadId);
		for (let i = 0; i < 200 && !ran.some((a) => a.join(" ").includes("sleepy two")); i++) await new Promise((r) => setTimeout(r, 25));
		await s.forge.steer(ada, threadId, "also add tests", "pi-steer-1");
		await running;
		expect(faux.getPendingResponseCount()).toBe(0);
		const events = (await s.forge.transcript(ada, threadId)).events;
		expect(events.filter((e) => e.role === "user").map((e) => e.data.text)).toEqual(["Fix the login bug", "also add tests"]);
		expect((await s.pool.query("select status from pim_forge.forge_inbox where thread_id = $1 and operation_id = 'pi-steer-1'", [threadId])).rows[0]!.status).toBe("done");
		// One turn, not two.
		expect((await s.pool.query("select count(*) c from pim_forge.forge_harness_runs where thread_id = $1", [threadId])).rows[0]!.c).toBe("1");
	});
});
