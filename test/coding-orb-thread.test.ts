import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMP_HTTP_AUTH_REJECTED } from "../src/coding/orb/amp-http";
import { codingVault } from "../src/coding/vault/vault";
import { OWNER } from "./helpers";
import { FakeOrbClient } from "../src/coding/orb/fake";
import { codingThread, type StartThread } from "../src/coding/thread-do";
import { type CodingThreadDO, codingEvents, codingOrbs, codingTimings } from "./worker";

// An agent-hosted thread here is a thread record turned into one — there is no way to start one from the
// API yet — on the fake orb client: it runs its whole turn through the OrbClient interface, with no
// workspace, no slot and no environment, and the tests drive its polling the way the `advance` job's
// alarm does (a heartbeat), which is all a turn on an agent's cloud needs: a look now and then.

const REPO = "https://github.com/acme/demo";
const CODER = { providerId: "coding-faux", model: "coder" };
const TASK = "Add a greeting";

type Stub = DurableObjectStub<CodingThreadDO>;

function startInput(id: string, overrides: Partial<StartThread> = {}): StartThread {
	// No workspace backend, so the workspace path can't run: the thread fails with `no_backend` before it makes anything.
	return { space: `space-${id}`, repo: REPO, task: TASK, profile: CODER, createdBy: "tester", operationId: `start-${id}`, workspaceProvider: "no-backend", ...overrides };
}

/** Calls the thread in its object rather than over RPC, for calls that throw and for its `advance` job. */
const inside = <T>(stub: Stub, call: (thread: CodingThreadDO) => Promise<T> | T) => runInDurableObject(stub, (instance: CodingThreadDO) => call(instance));

/** The `advance` job, as its alarm would run it: the one look at an agent-hosted turn. */
const heartbeat = (stub: Stub) => inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));

/** A thread's `thread.turn_ended` events. */
const ended = (id: string) => codingEvents.filter((event) => event.threadId === id && event.type === "thread.turn_ended");

/** The messages of the thread's conversation, as its transcript shows them. */
const said = async (stub: Stub) => (await inside(stub, (thread) => thread.transcript())).map((message) => [message.role, message.parts] as const);

/**
 * A thread whose record says it runs in the agent's own cloud, on `fake`: started as any thread is — which
 * fails, for it names a workspace backend it hasn't — and then turned into an agent-hosted one and reopened,
 * which is what a later slice's start will write for a thread begun that way.
 */
async function orbThread(fake: FakeOrbClient, overrides: Partial<StartThread> = {}) {
	codingOrbs.factory = () => fake;
	const id = crypto.randomUUID();
	const stub = codingThread(env, id);
	const input = startInput(id, overrides);
	expect(await stub.start(input)).toMatchObject({ state: "failed", stateReason: "no_backend", providerKind: "workspace", orb: null, inbox: 1 });
	await inside(stub, (thread) => {
		thread.store.update({ providerKind: "agent-hosted", providerId: "fake", state: "provisioning", stateReason: null, stateDetail: null });
	});
	// The failure of its start as a workspace thread is not what these tests are about.
	codingEvents.length = 0;
	return { id, stub, input, orb: () => fake.started[0]!.threadId };
}

/** The thread's object is evicted, as a deployment restarts: its isolate's memory is gone, its records stay. */
const evict = (stub: Stub) => runInDurableObject(stub, (_instance: CodingThreadDO, state) => state.abort("evicted")).catch(() => {});

beforeEach(() => {
	codingOrbs.factory = null;
	codingTimings.orbPollMs = 30_000;
	codingEvents.length = 0;
});

describe("an agent-hosted coding thread", () => {
	it("runs its task as one turn in the agent's cloud, with no workspace, and ends it when the agent's thread is idle", async () => {
		const fake = new FakeOrbClient();
		const { id, stub, input, orb } = await orbThread(fake);
		await heartbeat(stub);
		const running = await stub.status();
		// The whole of what Pim did: started the agent's thread, with a key of its own and the turn's.
		expect(fake.started).toHaveLength(1);
		expect(running).toMatchObject({
			state: "running",
			providerKind: "agent-hosted",
			currentOperation: input.operationId,
			inbox: 0,
			slot: "none",
			orb: { url: "https://orb.example.test/threads/T-1" },
			// The agent reports what its work cost; Pim measured nothing here.
			spentUsd: 0,
		});
		fake.say(orb(), "assistant", "Done: added a greeting.");
		fake.setState(orb(), "idle");
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "idle", stateReason: null, stateDetail: null, currentOperation: null });
		expect(ended(id)).toEqual([expect.objectContaining({ type: "thread.turn_ended", outcome: "completed", operationId: input.operationId, state: "idle" })]);
		// No model call, no clone, no workspace: nothing of the workspace path ran.
		expect((await stub.log()).filter((event) => event.kind === "model_call")).toEqual([]);
	});

	it("fails the turn when the agent's cloud says its thread ended in an error", async () => {
		const fake = new FakeOrbClient();
		const { id, stub, orb } = await orbThread(fake);
		await heartbeat(stub);
		fake.say(orb(), "assistant", "I broke the build.");
		fake.setState(orb(), "error");
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "failed", stateReason: "orb_error", currentOperation: null });
		expect(ended(id)).toEqual([
			expect.objectContaining({ outcome: "error", reason: "orb_error", state: "failed", detail: expect.stringContaining("I broke the build.") }),
		]);
	});

	it("fails the thread when its orb no longer exists on the agent's cloud", async () => {
		const fake = new FakeOrbClient();
		const { id, stub, orb } = await orbThread(fake);
		await heartbeat(stub);
		fake.lose(orb());
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "failed", stateReason: "orb_lost", currentOperation: null });
		expect(ended(id)).toEqual([expect.objectContaining({ outcome: "error", reason: "orb_lost", state: "failed" })]);
	});

	it("resumes polling a turn after its object is evicted, without starting a second orb", async () => {
		const fake = new FakeOrbClient();
		const { id, stub, orb } = await orbThread(fake);
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "running", currentOperation: "start-" + id });
		await evict(stub);
		const after = codingThread(env, id);
		await after.status();
		fake.say(orb(), "assistant", "Still going.");
		await heartbeat(after);
		// The orb it kept on its record is polled, not started again.
		expect(fake.started).toHaveLength(1);
		expect(await after.status()).toMatchObject({ state: "running", currentOperation: "start-" + id, orb: { url: "https://orb.example.test/threads/T-1" } });
		fake.setState(orb(), "idle");
		await heartbeat(after);
		expect(await after.status()).toMatchObject({ state: "idle", currentOperation: null });
		expect(fake.started).toHaveLength(1);
		expect(ended(id)).toEqual([expect.objectContaining({ outcome: "completed" })]);
	});

	it("waits out a client that can't say what its thread is doing, and gives up after a bound of them", async () => {
		const fake = new FakeOrbClient();
		const { id, stub, orb } = await orbThread(fake);
		await heartbeat(stub);
		for (let look = 1; look < 10; look++) {
			fake.setState(orb(), "unknown");
			await heartbeat(stub);
			expect(await stub.status()).toMatchObject({ state: "running", currentOperation: expect.any(String) });
		}
		fake.setState(orb(), "unknown");
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "failed", stateReason: "orb_state_unknown", currentOperation: null });
		expect(ended(id)).toEqual([expect.objectContaining({ outcome: "error", reason: "orb_state_unknown", state: "failed" })]);
	});

	it("keeps mirroring the agent's transcript, and repeats nothing across an eviction", async () => {
		// A page at a time, so mirroring pages with `after`.
		const fake = new FakeOrbClient({ page: 1 });
		const { id, stub, orb } = await orbThread(fake);
		await heartbeat(stub);
		fake.say(orb(), "assistant", "Halfway.");
		await heartbeat(stub);
		expect(await said(stub)).toEqual([
			["notice", [{ type: "text", text: "Model: coding-faux · coder · explicit" }]],
			["user", [{ type: "text", text: TASK }]],
			["assistant", [{ type: "text", text: "Halfway." }]],
		]);
		await evict(stub);
		const after = codingThread(env, id);
		await after.status();
		fake.say(orb(), "assistant", "Done.");
		fake.setState(orb(), "idle");
		await heartbeat(after);
		expect(await said(after)).toEqual([
			["notice", [{ type: "text", text: "Model: coding-faux · coder · explicit" }]],
			["user", [{ type: "text", text: TASK }]],
			["assistant", [{ type: "text", text: "Halfway." }]],
			["assistant", [{ type: "text", text: "Done." }]],
		]);
	});

	it("steers a running turn through the client, and aborts it by stopping the agent's thread, once", async () => {
		const fake = new FakeOrbClient();
		const { id, stub, orb } = await orbThread(fake);
		await heartbeat(stub);
		await stub.steer("Add a test too", { operationId: "steer-1" });
		// Steered, queued at the agent for the turn's end, not enqueued here as another turn.
		expect(fake.queued(orb())).toEqual(["Add a test too"]);
		expect(await stub.status()).toMatchObject({ state: "running", inbox: 0, currentOperation: expect.any(String) });
		const steered = (await stub.log()).filter((event) => event.kind === "orb.steered");
		expect(steered).toHaveLength(1);
		await stub.abort();
		// The agent's thread is stopped there — cancelling its run — and the turn ends cancelled here.
		expect(fake.stopCount(orb())).toBe(1);
		expect(await stub.status()).toMatchObject({ state: "idle", stateReason: null, currentOperation: null });
		expect(ended(id)).toEqual([expect.objectContaining({ outcome: "cancelled", state: "idle" })]);
		// Stopping a stopped thread does nothing: abort and archive both ask, and neither ends anything again.
		await stub.abort();
		await stub.archive();
		expect(fake.stopCount(orb())).toBe(1);
		expect(ended(id)).toHaveLength(1);
		expect(await stub.status()).toMatchObject({ state: "archived" });
	});

	it("leaves a message it can't steer mid-turn with the thread, saying so in the log", async () => {
		const fake = new FakeOrbClient({ capabilities: { steer: false } });
		const { stub, orb } = await orbThread(fake);
		await heartbeat(stub);
		await stub.steer("One more thing", { operationId: "steer-1" });
		expect(fake.queued(orb())).toEqual([]);
		expect(await stub.status()).toMatchObject({ state: "running", inbox: 1 });
		const notice = (await stub.log()).filter((event) => event.kind === "orb.steer_unsupported");
		expect(notice).toHaveLength(1);
		expect(String(notice[0]!.data?.message)).toContain("takes no messages");
	});

	it("waits out a cloud it can't be reached, and starts no second orb once it can", async () => {
		const fake = new FakeOrbClient();
		const { stub } = await orbThread(fake);
		fake.unreachable("start", true);
		await heartbeat(stub);
		// Nothing was changed and nothing was made: the turn waits, it doesn't fail.
		expect(await stub.status()).toMatchObject({ state: "provisioning", stateReason: "orb_unreachable", currentOperation: null, inbox: 1 });
		expect(fake.started).toHaveLength(0);
		fake.unreachable("start", false);
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "running", currentOperation: expect.any(String) });
		// A look that can't reach the cloud ends nothing either: the turn goes on.
		fake.unreachable("state", true);
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "running", currentOperation: expect.any(String) });
		expect(fake.started).toHaveLength(1);
	});

	it("fails cleanly when this Pim has no orb client, saying the agent-hosted provider isn't available", async () => {
		const { stub } = await orbThread(new FakeOrbClient());
		codingOrbs.factory = null;
		await heartbeat(stub);
		const status = await stub.status();
		expect(status).toMatchObject({ state: "failed", stateReason: "orb_unavailable", currentOperation: null, inbox: 1 });
		expect(status.stateDetail).toContain("agent-hosted provider not available");
	});
});

describe("what an agent-hosted thread reports about itself", () => {
	it("says what its agent's cloud reported it cost, or honestly that it can't say", async () => {
		const fake = new FakeOrbClient();
		const { stub, orb } = await orbThread(fake);
		await heartbeat(stub);
		fake.setState(orb(), "idle");
		await heartbeat(stub);
		// The agent reports no cost: null means unavailable, not free, and the status says so.
		expect(await stub.status()).toMatchObject({ providerKind: "agent-hosted", cost: null, costNote: "The agent's cloud reports no cost for this thread, so what it spent isn't known." });
		fake.setUsage(orb(), { usd: 1.5 });
		await stub.steer("Go on", { operationId: "next" });
		await heartbeat(stub);
		fake.setState(orb(), "idle");
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ cost: 1.5, costNote: null });
	});

	it("says so when the client reports no usage at all", async () => {
		const fake = new FakeOrbClient({ capabilities: { usage: false } });
		const { stub, orb } = await orbThread(fake);
		await heartbeat(stub);
		fake.setState(orb(), "idle");
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ cost: null, costNote: "fake reports no usage for its threads, so what this one cost isn't known." });
		// Its tests are its agent's word too: Pim ran none and reports none.
		expect(await stub.tests()).toEqual([]);
	});
});

afterEach(() => vi.restoreAllMocks());

describe("Amp HTTP placement", () => {
	it("starts Amp Orbs without a sandbox backend, slot or workspace", async () => {
		const fake = new FakeOrbClient({ id: "amp-http" });
		codingOrbs.factory = () => fake;
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		await stub.start(startInput(id, { harness: "amp", provider: "orbs" }));
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ providerKind: "agent-hosted", provider: "amp-orbs", pool: "amp-orbs", state: "running", slot: "none" });
		expect(fake.started).toHaveLength(1);
	});

	it("reads the same Amp Connect credential, maps rejection, and refuses HTTP steering/stopping", async () => {
		const vault = codingVault(env);
		const saved = "sgamp_HTTP_SHARED_CONNECT_TOKEN";
		await vault.saveApiKey(OWNER, "amp", saved);
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}, { status: 403 }));
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		try {
			await stub.start(startInput(id, { space: OWNER, harness: "amp", provider: "orbs" }));
			await heartbeat(stub);
			expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required", stateDetail: AMP_HTTP_AUTH_REJECTED, slot: "none", provider: "amp-orbs", pool: "amp-orbs", inbox: 1 });
			expect(fetcher.mock.calls[0]?.[0]).toBe("https://ampcode.com/api/v2/threads");
			expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${saved}` });
			fetcher.mockImplementation(async (url) => String(url).endsWith("/threads") ? Response.json({ thread: { id: "T-http", url: "https://ampcode.com/threads/T-http" } }, { status: 201 }) : String(url).endsWith("/messages") ? Response.json({ messages: [] }) : Response.json({ thread: { agentState: { state: "working" } } }));
			await stub.continue({ operationId: "reconnected" });
			await heartbeat(stub);
			expect(await stub.status()).toMatchObject({ state: "running", providerKind: "agent-hosted", slot: "none", inbox: 0 });
			await expect(inside(stub, (thread) => thread.steer("hi", { operationId: "steer" }))).rejects.toThrow("not supported by Amp's HTTP API yet");
			await expect(inside(stub, (thread) => thread.abort())).rejects.toThrow("not supported by Amp's HTTP API yet");
			expect(await stub.status()).toMatchObject({ state: "running", currentOperation: startInput(id).operationId });
			expect(fetcher.mock.calls.every(([, init]) => init?.method !== "DELETE")).toBe(true);
			fetcher.mockImplementation(async () => Response.json({}, { status: 401 }));
			await heartbeat(stub);
			expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required", currentOperation: startInput(id).operationId });
			fetcher.mockImplementation(async (url) => String(url).endsWith("/messages") ? Response.json({ messages: [] }) : Response.json({ thread: { agentState: { state: "idle" } } }));
			await stub.continue({ operationId: "reconnected-again" });
			await heartbeat(stub);
			expect(await stub.status()).toMatchObject({ state: "idle", slot: "none", currentOperation: null, cost: null });
			expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
		} finally {
			await vault.delete(OWNER, "amp");
		}
	});
});
