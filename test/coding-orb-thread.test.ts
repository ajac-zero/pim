import { Buffer } from "node:buffer";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { Pim } from "../src/pim";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codingVault } from "../src/coding/vault/worker";
import { OWNER, apiUrl, TOKEN } from "./helpers";
import { FakeOrbClient } from "@pim/coding/orb/fake";
import { OrbAuthError, OrbLostError } from "@pim/coding/orb/types";
import { codingThread, type StartThread } from "../src/coding/thread-do";
import { type CodingThreadDO, codingEvents, codingOrbs, codingStalls, codingThreadClock, codingTimings } from "./worker";

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
	codingTimings.orbSyncTtlMs = 0;
	codingEvents.length = 0;
	codingThreadClock.now = null;
	codingStalls.length = 0;
});

afterEach(() => {
	codingThreadClock.now = null;
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

	it("stores an agent's tool steps as tool calls and results, and writes no empty user message for a result-only one", async () => {
		const fake = new FakeOrbClient();
		const { stub, orb } = await orbThread(fake);
		await heartbeat(stub);
		fake.say(orb(), "assistant", "Reading.", [
			{ type: "text", text: "Reading." },
			{ type: "toolCall", id: "c1", name: "Read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "c2", name: "Bash", arguments: { cmd: "false" } },
		]);
		fake.say(orb(), "user", "", [
			{ type: "toolResult", id: "c1", name: "Read", text: "const a = 1;", isError: false },
			{ type: "toolResult", id: "c2", name: "Bash", text: "exit 1", isError: true },
		]);
		fake.say(orb(), "assistant", "Done.");
		fake.setState(orb(), "idle");
		await heartbeat(stub);
		const stored = (await inside(stub, (thread) => thread.harness.messages())).flatMap((entry) => entry.model ?? []);
		expect(stored.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
		expect(stored[1]).toMatchObject({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Reading." }, { type: "toolCall", id: "c1", name: "Read", arguments: { path: "a.ts" } }, { type: "toolCall", id: "c2", name: "Bash", arguments: { cmd: "false" } }] });
		expect(stored[2]).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "Read", isError: false, content: [{ type: "text", text: "const a = 1;" }] });
		expect(stored[3]).toMatchObject({ role: "toolResult", toolCallId: "c2", toolName: "Bash", isError: true, content: [{ type: "text", text: "exit 1" }] });
		expect(stored[4]).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] });
		expect(stored.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("steers a running turn through the client, and aborts it by cancelling the run, then archives it by stopping", async () => {
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
		// The run is cancelled there, without archiving, and the turn ends cancelled here.
		expect(fake.cancelCount(orb())).toBe(1);
		expect(fake.stopCount(orb())).toBe(0);
		expect(await stub.status()).toMatchObject({ state: "idle", stateReason: null, currentOperation: null });
		expect(ended(id)).toEqual([expect.objectContaining({ outcome: "cancelled", state: "idle" })]);
		// With no turn under way, abort cancels nothing; archive is what stops the thread.
		await stub.abort();
		expect(fake.cancelCount(orb())).toBe(1);
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

	it("waits out Pim's own overload without failing the thread, keeping the input for the same start", async () => {
		const fake = new FakeOrbClient();
		const { stub, input } = await orbThread(fake);
		fake.overloaded("start", true);
		await heartbeat(stub);
		// The agent's cloud was never reached: nothing failed, and the input waits for its retry.
		expect(await stub.status()).toMatchObject({ state: "provisioning", stateReason: "orb_unreachable", stateDetail: expect.stringContaining("too busy"), currentOperation: null, inbox: 1 });
		expect((await stub.log()).filter((event) => event.kind === "orb.local_overload")).toHaveLength(1);
		fake.overloaded("start", false);
		// Held for its backoff: an early look starts nothing.
		await heartbeat(stub);
		expect(fake.started).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 120));
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "running", stateReason: null, currentOperation: input.operationId, inbox: 0 });
		expect(fake.started).toHaveLength(1);
	});

	it("keeps a running turn when Pim is overloaded mid-poll, and finishes it once the overload passes", async () => {
		const fake = new FakeOrbClient();
		const { id, stub, input, orb } = await orbThread(fake);
		await heartbeat(stub);
		fake.say(orb(), "assistant", "Working on it.");
		fake.overloaded("state", true);
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "running", stateReason: "orb_unreachable", currentOperation: input.operationId, orb: { url: "https://orb.example.test/threads/T-1" } });
		expect(ended(id)).toEqual([]);
		fake.say(orb(), "assistant", "Done.");
		fake.setState(orb(), "idle");
		fake.overloaded("state", false);
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "idle", stateReason: null, currentOperation: null });
		expect(ended(id)).toEqual([expect.objectContaining({ outcome: "completed" })]);
		// Every message was mirrored once, though the first look was cut short.
		const texts = JSON.stringify(await said(stub));
		expect(texts.match(/Working on it\./g)).toHaveLength(1);
		expect(fake.started).toHaveLength(1);
	});

	it("queues a message for the next turn when Pim is overloaded before it could be steered", async () => {
		const fake = new FakeOrbClient();
		const { stub, input, orb } = await orbThread(fake);
		await heartbeat(stub);
		fake.overloaded("steer", true);
		const status = await inside(stub, (thread) => thread.steer("More please", { operationId: "more-1" }));
		expect(status).toMatchObject({ state: "running", currentOperation: input.operationId, inbox: 1 });
		expect(fake.queued(orb())).toEqual([]);
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

describe("a turn continued on the agent's own site", () => {
	/** A thread whose first turn is over, as when the person then goes on in the agent's own site. */
	async function idleThread(options: ConstructorParameters<typeof FakeOrbClient>[0] = {}) {
		const fake = new FakeOrbClient(options);
		const made = await orbThread(fake);
		await heartbeat(made.stub);
		fake.say(made.orb(), "assistant", "Done.");
		fake.setState(made.orb(), "idle");
		await heartbeat(made.stub);
		expect(await made.stub.status()).toMatchObject({ state: "idle", currentOperation: null });
		codingEvents.length = 0;
		return { ...made, fake };
	}
	const texts = async (stub: Stub) => (await said(stub)).map(([role, parts]) => `${role}: ${(parts as unknown as { text?: string }[]).map((part) => part.text ?? "").join("")}`);

	it("mirrors a completed continuation when the thread is read, records its end, wakes nobody, and repeats nothing", async () => {
		const { id, stub, fake, orb } = await idleThread();
		const before = await stub.status();
		fake.say(orb(), "user", "Now add a farewell");
		fake.say(orb(), "assistant", "On it.", [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "a.ts" } }]);
		fake.say(orb(), "user", "", [{ type: "toolResult", id: "c1", name: "edit", text: "ok", isError: false }]);
		fake.say(orb(), "assistant", "Added a farewell.");
		const after = await stub.status();
		expect(after).toMatchObject({ state: "idle", currentOperation: null });
		expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
		expect(await texts(stub)).toEqual(expect.arrayContaining(["user: Now add a farewell", "assistant: Added a farewell."]));
		expect((await said(stub)).map(([role]) => role)).toEqual(expect.arrayContaining(["user", "assistant", "tool"]));
		const events = ended(id);
		expect(events).toEqual([expect.objectContaining({ outcome: "completed", state: "idle", operationId: expect.stringMatching(/^external:/) })]);
		const size = (await inside(stub, (thread) => thread.transcript())).length;
		await stub.status();
		expect((await inside(stub, (thread) => thread.transcript())).length).toBe(size);
		expect(ended(id)).toHaveLength(1);
	});

	it("follows a continuation that is still running, and ends it when the agent does", async () => {
		const { id, stub, fake, orb } = await idleThread();
		fake.say(orb(), "user", "Keep going");
		fake.setState(orb(), "working");
		const running = await stub.status();
		expect(running).toMatchObject({ state: "running", currentOperation: expect.stringMatching(/^external:/) });
		fake.say(orb(), "assistant", "Halfway.");
		await heartbeat(stub);
		expect(await texts(stub)).toEqual(expect.arrayContaining(["assistant: Halfway."]));
		expect(ended(id)).toEqual([]);
		fake.say(orb(), "assistant", "All done.");
		fake.setState(orb(), "idle");
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "idle", currentOperation: null });
		expect(ended(id)).toEqual([expect.objectContaining({ outcome: "completed", operationId: running.currentOperation })]);
		expect(await texts(stub)).toContain("assistant: All done.");
	});

	it("can stop a continuation it follows", async () => {
		const { id, stub, fake, orb } = await idleThread();
		fake.setState(orb(), "working");
		expect(await stub.status()).toMatchObject({ state: "running" });
		await stub.abort();
		expect(fake.cancelCount(orb())).toBe(1);
		expect(await stub.status()).toMatchObject({ state: "idle", currentOperation: null });
		expect(ended(id)).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
	});

	it("mirrors what was said there before the turn it steers next", async () => {
		const { stub, fake, orb } = await idleThread();
		fake.say(orb(), "user", "Said on the site");
		fake.say(orb(), "assistant", "Answered on the site");
		await stub.steer("Said in Pim", { operationId: "steer-2" });
		await heartbeat(stub);
		expect(fake.queued(orb())).toEqual(["Said in Pim"]);
		const stored = JSON.stringify(await inside(stub, (thread) => thread.harness.messages()));
		expect(stored).toContain("Said on the site");
		expect(stored).toContain("Answered on the site");
	});

	it("never fails a read because the agent's cloud can't be asked", async () => {
		const { stub, fake, orb } = await idleThread();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const before = await stub.status();
		fake.unreachable("messages", true);
		expect(await stub.status()).toMatchObject({ state: "idle", currentOperation: null, updatedAt: before.updatedAt });
		expect(await inside(stub, (thread) => thread.transcript())).toBeInstanceOf(Array);
		fake.unreachable("messages", false);
		vi.spyOn(fake, "messages").mockRejectedValueOnce(new OrbAuthError("sign in again"));
		expect(await stub.status()).toMatchObject({ state: "idle", stateReason: null });
		vi.spyOn(fake, "state").mockRejectedValueOnce(new OrbLostError("gone"));
		expect(await stub.status()).toMatchObject({ state: "idle", stateReason: null });
		expect(warn.mock.calls.filter(([line]) => String(line).includes("orb_sync_failed")).length).toBeGreaterThanOrEqual(3);
		vi.restoreAllMocks();
		fake.say(orb(), "assistant", "Back again.");
		fake.setState(orb(), "idle");
		await stub.status();
		expect(await texts(stub)).toContain("assistant: Back again.");
	});

	it("looks at the orb once for reads close together", async () => {
		const { stub, fake } = await idleThread();
		const messages = vi.spyOn(fake, "messages");
		await stub.status();
		expect(messages).toHaveBeenCalledTimes(1);
		// The reads just after it, within the window, share that look.
		codingTimings.orbSyncTtlMs = 2_000;
		await stub.status();
		await inside(stub, (thread) => thread.transcript());
		expect(messages).toHaveBeenCalledTimes(1);
		vi.restoreAllMocks();
	});
});

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

	it("reads the same Amp Connect credential, maps rejection, and steers through sendMessageToThread and keeps the turn when cancel fails", async () => {
		const vault = codingVault(env);
		const saved = "sgamp_HTTP_SHARED_CONNECT_TOKEN";
		await vault.saveApiKey(OWNER, "amp", saved);
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ error: "scope missing" }, { status: 403 }));
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		try {
			await stub.start(startInput(id, { space: OWNER, harness: "amp", provider: "orbs" }));
			await heartbeat(stub);
			expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required", stateDetail: expect.stringContaining('Amp rejected the saved token (HTTP 403): {"error":"scope missing"}'), slot: "none", provider: "amp-orbs", pool: "amp-orbs", inbox: 1 });
			expect(fetcher.mock.calls[0]?.[0]).toBe("https://ampcode.com/api/internal?resolveProjectByRepositoryURLs");
			expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: `Bearer ${saved}`, "content-type": "application/json" });
			const method = (init?: RequestInit) => JSON.parse(String(init?.body)).method as string;
			const tail = (state: string) => Response.json({ ok: true, result: { thread: { data: { meta: { lastKnownAgentState: { state } } } }, messages: [] } });
			let agent = "working";
			fetcher.mockImplementation(async (_url, init) => ({
				resolveProjectByRepositoryURLs: () => Response.json({ ok: true, result: { projectID: "P-1" } }),
				createRemoteExecutorThread: () => Response.json({ ok: true, result: { threadID: "T-http", url: "https://ampcode.com/threads/T-http" } }),
				sendMessageToThread: () => Response.json({ ok: true, result: { threadID: "T-http", latestCursor: "1" } }),
				getThreadTail: () => tail(agent),
			})[method(init) as "getThreadTail"]());
			await stub.continue({ operationId: "reconnected" });
			await heartbeat(stub);
			expect(await stub.status()).toMatchObject({ state: "running", providerKind: "agent-hosted", slot: "none", inbox: 0 });
			await inside(stub, (thread) => thread.steer("hi", { operationId: "steer" }));
			expect(fetcher.mock.calls.map(([, init]) => method(init))).toContain("sendMessageToThread");
			const wsToken = "eyJ.SECRET_WS_TOKEN.sig";
			fetcher.mockImplementation(async (url) => String(url).endsWith("/api/thread-actors") ? Response.json({ wsToken }) : new Response("no upgrade", { status: 200 }));
			const cancelFailure = await inside(stub, (thread) => thread.abort()).catch((error: Error) => error);
			expect(String(cancelFailure)).toContain("did not upgrade");
			expect(String(cancelFailure)).not.toContain(wsToken);
			expect(fetcher.mock.calls.some(([url]) => String(url).includes("archiveThread"))).toBe(false);
			fetcher.mockImplementation(async (_url, init) => ({
				getThreadTail: () => tail(agent),
			})[method(init) as "getThreadTail"]());
			expect(await stub.status()).toMatchObject({ state: "running", currentOperation: startInput(id).operationId });
			expect(fetcher.mock.calls.every(([, init]) => init?.method !== "DELETE")).toBe(true);
			fetcher.mockImplementation(async () => Response.json({}, { status: 401 }));
			await heartbeat(stub);
			expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required", currentOperation: startInput(id).operationId });
			agent = "idle";
			fetcher.mockImplementation(async (_url, init) => tail(agent));
			await stub.continue({ operationId: "reconnected-again" });
			await heartbeat(stub);
			expect(await stub.status()).toMatchObject({ state: "idle", slot: "none", currentOperation: null, cost: null });
			expect(fetcher.mock.calls.filter(([, init]) => String(init?.body).includes("\"method\":\"createRemoteExecutorThread\"") && method(init) === "createRemoteExecutorThread")).toHaveLength(1);
		} finally {
			await vault.delete(OWNER, "amp");
		}
	});

	it("shows the first attempt's cause in the failed thread's detail", async () => {
		const vault = codingVault(env);
		await vault.saveApiKey(OWNER, "amp", "sgamp_DETAIL_TOKEN");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			if (JSON.parse(String(init?.body)).method === "resolveProjectByRepositoryURLs") return Response.json({ ok: true, result: { projectID: "P-1" } });
			throw new TypeError("fetch failed");
		});
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		try {
			await stub.start(startInput(id, { space: OWNER, harness: "amp", provider: "orbs" }));
			await heartbeat(stub);
			await heartbeat(stub);
			const status = JSON.stringify(await stub.status());
			expect(status).toContain("first attempt: fetch failed after");
			expect(status).not.toContain("sgamp_DETAIL_TOKEN");
		} finally {
			await vault.delete(OWNER, "amp");
		}
	});
});

describe("Amp attachment images in an agent-hosted thread", () => {
	const LIGHT = "https://ampcode.com/user-content/attachments/9fbe-light.png#amp-media-source=file%3A%2F%2F%2Fa.png&amp-media-width=2560";
	const DARK = "https://ampcode.com/user-content/attachments/bfb0-dark.png#amp-media-width=2560";
	const REPLY = `![Light](${LIGHT})\n![Dark](${DARK}) ![Light again](${LIGHT})\n![Evil](https://evil.example/p.png)\n\n<suggested-replies>\n**Push the branch**\n</suggested-replies>`;
	const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
	const TOKEN = "sgamp_ATTACHMENT_TOKEN";

	const pim = () => env.Pim.getByName(OWNER);
	const stored = (url: string) => runInDurableObject(pim(), async (instance: Pim) => {
		const image = await instance.images.read(url.replace("/api/images/", ""));
		return image && "body" in image ? { type: image.type, bytes: new Uint8Array(await new Response(image.body).arrayBuffer()) } : null;
	});
	const attachmentCalls = (fetcher: { mock: { calls: unknown[][] } }) => fetcher.mock.calls.filter(([url]) => String(url).startsWith("https://ampcode.com/user-content/"));

	async function ampThread() {
		const fake = new FakeOrbClient({ id: "amp-http" });
		codingOrbs.factory = () => fake;
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		await stub.start(startInput(id, { space: OWNER, harness: "amp", provider: "orbs" }));
		await heartbeat(stub);
		return { id, stub, fake, orb: () => fake.started[0]!.threadId };
	}
	const firstText = async (stub: Stub) => {
		const message = (await inside(stub, (thread) => thread.transcript())).find((entry) => entry.role === "assistant");
		return (message!.parts[0] as { text: string }).text;
	};

	beforeEach(async () => {
		await codingVault(env).saveApiKey(OWNER, "amp", TOKEN);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await codingVault(env).delete(OWNER, "amp");
	});

	it("keeps the images a reply shows as the space's own, with the Amp login sent to Amp, each address once, and none from elsewhere", async () => {
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
		const { stub, fake, orb } = await ampThread();
		fake.say(orb(), "assistant", REPLY);
		await heartbeat(stub);
		// Two attachments, though three images name them, fetched with the person's login and no fragment.
		const calls = attachmentCalls(fetcher);
		expect(calls.map(([url]) => url)).toEqual(["https://ampcode.com/user-content/attachments/9fbe-light.png", "https://ampcode.com/user-content/attachments/bfb0-dark.png"]);
		expect((calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
		const text = await firstText(stub);
		const light = /!\[Light\]\((\/api\/images\/[\w-]+)\)/.exec(text)?.[1];
		const dark = /!\[Dark\]\((\/api\/images\/[\w-]+)\)/.exec(text)?.[1];
		expect(light).toBeDefined();
		expect(text).toContain(`![Light again](${light})`);
		expect(text).toContain("![Evil](https://evil.example/p.png)");
		expect(text).toContain("<suggested-replies>");
		expect(await stored(light!)).toEqual({ type: "image/png", bytes: PNG });
		expect(await stored(dark!)).toEqual({ type: "image/png", bytes: PNG });
		// Read again, nothing is fetched.
		fetcher.mockClear();
		expect(await firstText(stub)).toBe(text);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("mirrors an image from a continuation on Amp's site while the thread is idle", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
		const { stub, fake, orb } = await ampThread();
		fake.say(orb(), "assistant", "First.");
		fake.setState(orb(), "idle");
		await heartbeat(stub);
		fake.say(orb(), "user", "Draw it");
		fake.say(orb(), "assistant", `![Light](${LIGHT})`);
		await stub.status();
		const reply = (await inside(stub, (thread) => thread.transcript())).filter((entry) => entry.role === "assistant").at(-1)!;
		const text = (reply.parts[0] as { text: string }).text;
		const url = /!\[Light\]\((\/api\/images\/[\w-]+)\)/.exec(text)?.[1];
		expect(url).toBeDefined();
		expect(await stored(url!)).toEqual({ type: "image/png", bytes: PNG });
	});

	it("copies what an earlier turn left with Amp's addresses the first time the transcript is read, once", async () => {
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
		await codingVault(env).delete(OWNER, "amp");
		const { stub, fake, orb } = await ampThread();
		fake.say(orb(), "assistant", REPLY);
		await heartbeat(stub);
		expect(attachmentCalls(fetcher)).toHaveLength(0);
		expect(await firstText(stub)).toContain(LIGHT);
		await codingVault(env).saveApiKey(OWNER, "amp", TOKEN);
		const text = await firstText(stub);
		expect(text).not.toContain("ampcode.com");
		expect(text).toMatch(/!\[Light\]\(\/api\/images\/[\w-]+\)/);
		expect(attachmentCalls(fetcher)).toHaveLength(2);
		fetcher.mockClear();
		expect(await firstText(stub)).toBe(text);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("gives up on an attachment that is gone, or that is no image, without asking again, and keeps its address", async () => {
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => (String(url).includes("light") ? new Response("no", { status: 404 }) : new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })));
		const { stub, fake, orb } = await ampThread();
		fake.say(orb(), "assistant", REPLY);
		await heartbeat(stub);
		expect(await firstText(stub)).toContain(LIGHT);
		expect(await firstText(stub)).toContain(DARK);
		const asked = attachmentCalls(fetcher).length;
		expect(asked).toBe(2);
		await firstText(stub);
		expect(attachmentCalls(fetcher)).toHaveLength(asked);
	});

	it("tries an attachment again after a failure that may pass, a few times", async () => {
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("later", { status: 503 }));
		const { stub, fake, orb } = await ampThread();
		fake.say(orb(), "assistant", `![Light](${LIGHT})`);
		await heartbeat(stub);
		for (let reads = 0; reads < 5; reads++) await firstText(stub);
		expect(attachmentCalls(fetcher)).toHaveLength(3);
		fetcher.mockImplementation(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
		expect(await firstText(stub)).toContain(LIGHT);
	});

	it("shows the transcript, and spends no attempt, while the space still runs a version that can't keep images", async () => {
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
		const { stub, fake, orb } = await ampThread();
		fake.say(orb(), "assistant", `![Light](${LIGHT})`);
		// The space's object, as the version before this one has it: with no such method, or one that fails.
		const failWith = (error: Error | null) => runInDurableObject(pim(), (instance: Pim) => {
			if (error) (instance as { codingKeepImage: unknown }).codingKeepImage = async () => { throw error; };
			else delete (instance as { codingKeepImage?: unknown }).codingKeepImage;
		});
		await failWith(new TypeError('The RPC receiver does not implement the method "codingKeepImage".'));
		await heartbeat(stub);
		for (let reads = 0; reads < 4; reads++) expect(await firstText(stub)).toContain(LIGHT);
		// Any other failure to keep it also leaves the message showing.
		await failWith(new Error("storage down"));
		expect(await firstText(stub)).toContain(LIGHT);
		await failWith(null);
		fetcher.mockClear();
		expect(await firstText(stub)).toMatch(/!\[Light\]\(\/api\/images\/[\w-]+\)/);
	});

	it("leaves an image the space has no room for as it is", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
		await runInDurableObject(pim(), (instance: Pim) => instance.setLimits({ storageBytes: instance.storedBytes() + 2 }));
		try {
			const { stub, fake, orb } = await ampThread();
			fake.say(orb(), "assistant", `![Light](${LIGHT})`);
			await heartbeat(stub);
			expect(await firstText(stub)).toContain(LIGHT);
		} finally {
			await runInDurableObject(pim(), (instance: Pim) => instance.setLimits(null));
		}
	});
});

describe("Amp video attachments in an agent-hosted thread", () => {
	const MP4_URL = "https://ampcode.com/user-content/attachments/c595-robot_wave.mp4#amp-media-source=file%3A%2F%2F%2Ftmp%2Fr.mp4&amp-media-width=320";
	const MP4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4, 5, 6, 7, 8]);
	const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 8, 7]);
	const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
	const TOKEN_AMP = "sgamp_VIDEO_TOKEN";
	const pim = () => env.Pim.getByName(OWNER);
	const served = (path: string, headers: Record<string, string> = {}) => exports.default.fetch(new Request(apiUrl(path), { headers: { Authorization: `Bearer ${TOKEN}`, ...headers } }));
	const reply = (bytes: Uint8Array, type: string) => new Response(bytes, { headers: { "content-type": type } });
	const attachmentCalls = (fetcher: { mock: { calls: unknown[][] } }) => fetcher.mock.calls.filter(([url]) => String(url).startsWith("https://ampcode.com/user-content/"));

	async function ampThread(text: string) {
		const fake = new FakeOrbClient({ id: "amp-http" });
		codingOrbs.factory = () => fake;
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		await stub.start(startInput(id, { space: OWNER, harness: "amp", provider: "orbs" }));
		await heartbeat(stub);
		fake.say(fake.started[0]!.threadId, "assistant", text);
		await heartbeat(stub);
		const read = async () => {
			const message = (await runInDurableObject(stub, (instance: CodingThreadDO) => instance.transcript())).find((entry) => entry.role === "assistant");
			return (message!.parts[0] as { text: string }).text;
		};
		return { stub, read };
	}

	beforeEach(async () => {
		await codingVault(env).saveApiKey(OWNER, "amp", TOKEN_AMP);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await codingVault(env).delete(OWNER, "amp");
	});

	it("keeps an MP4 and a WebM as videos the space counts, serves, and erases", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => (String(url).endsWith(".webm") ? reply(WEBM, "video/webm") : reply(MP4, "video/mp4")));
		const before = await runInDurableObject(pim(), (instance: Pim) => instance.storedBytes());
		const { read } = await ampThread(`![Wave](${MP4_URL})\n![Clip](https://ampcode.com/user-content/attachments/d1-clip.webm#amp-media-width=1)`);
		const text = await read();
		const mp4 = /!\[Wave\]\((\/api\/images\/[\w-]+\.mp4)\)/.exec(text)?.[1];
		const webm = /!\[Clip\]\((\/api\/images\/[\w-]+\.webm)\)/.exec(text)?.[1];
		expect(mp4).toBeDefined();
		expect(webm).toBeDefined();
		expect(await runInDurableObject(pim(), (instance: Pim) => instance.storedBytes())).toBe(before + MP4.length + WEBM.length);

		const whole = await served(mp4!.replace("/api", ""));
		expect(whole.status).toBe(200);
		expect(Object.fromEntries(["content-type", "accept-ranges", "content-length", "x-content-type-options", "content-security-policy"].map((name) => [name, whole.headers.get(name)]))).toEqual({
			"content-type": "video/mp4",
			"accept-ranges": "bytes",
			"content-length": String(MP4.length),
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
		});
		expect(new Uint8Array(await whole.arrayBuffer())).toEqual(MP4);

		const head = await served(mp4!.replace("/api", ""), { range: "bytes=0-3" });
		expect(head.status).toBe(206);
		expect(head.headers.get("content-range")).toBe(`bytes 0-3/${MP4.length}`);
		expect(head.headers.get("content-length")).toBe("4");
		expect(new Uint8Array(await head.arrayBuffer())).toEqual(MP4.slice(0, 4));
		const tail = await served(mp4!.replace("/api", ""), { range: "bytes=-4" });
		expect(tail.status).toBe(206);
		expect(new Uint8Array(await tail.arrayBuffer())).toEqual(MP4.slice(-4));
		const past = await served(mp4!.replace("/api", ""), { range: "bytes=99999-100000" });
		expect(past.status).toBe(416);
		expect(past.headers.get("content-range")).toBe(`bytes */${MP4.length}`);
		await past.body?.cancel();

		// The extension must be the type's own, and a video is never served through a bare name or a signed link.
		const bare = mp4!.replace("/api", "").replace(".mp4", "");
		for (const path of [bare, mp4!.replace("/api", "").replace(".mp4", ".webm")]) {
			const miss = await served(path);
			expect(miss.status).toBe(404);
			await miss.body?.cancel();
		}
		await runInDurableObject(pim(), async (instance: Pim) => {
			const png = await instance.images.keepBytes("coding:x", PNG, "image/png", null);
			expect(png).toMatch(/^\/api\/images\/[\w-]+$/);
			expect(await instance.images.read(png!.replace("/api/images/", ""), "mp4")).toBeNull();
			await instance.images.deleteSession("coding:x");
		});
		// A thread's images, videos too, go with its session.
		await runInDurableObject(pim(), async (instance: Pim) => {
			// A signed link, correctly signed, still opens no video.
			const store = (instance as unknown as { store: { meta(key: string): string | undefined; setMeta(key: string, value: string): void } }).store;
			store.meta("images_signing_key") ?? store.setMeta("images_signing_key", Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"));
			const key = await crypto.subtle.importKey("raw", Buffer.from(store.meta("images_signing_key")!, "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const mp4Id = mp4!.replace("/api/images/", "").replace(".mp4", "");
			const expires = Date.now() + 60_000;
			const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${mp4Id}:${expires}`))).toString("hex");
			expect(await instance.images.readSigned(mp4Id, new URL(`https://pim.test/images/o/${mp4Id}?expires=${expires}&signature=${signature}`))).toBeNull();
			expect(instance.images.bytes()).toBeGreaterThanOrEqual(MP4.length + WEBM.length);
			await instance.images.deleteAll();
			expect(instance.images.bytes()).toBe(0);
		});
		expect((await served(mp4!.replace("/api", ""))).status).toBe(404);
	});

	it("refuses bytes that aren't of the type they came labeled with", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => reply(new TextEncoder().encode("<html><script>alert(1)</script></html>"), "video/mp4"));
		const { read } = await ampThread(`![Wave](${MP4_URL})`);
		expect(await read()).toContain(MP4_URL);
		await runInDurableObject(pim(), async (instance: Pim) => {
			expect(await instance.images.keepBytes("coding:x", MP4.slice(0, 8), "video/mp4", null)).toBeNull();
			expect(await instance.images.keepBytes("coding:x", new TextEncoder().encode("<svg xmlns='x'/>"), "image/png", null)).toBeNull();
			expect(await instance.images.keepBytes("coding:x", MP4, "video/mp4", 0)).toBeNull();
			expect(await instance.images.keepBytes("coding:x", MP4, "video/quicktime", null)).toBeNull();
		});
	});

	it("tries again a video an earlier version turned away, once, and keeps the images it had copied", async () => {
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => reply(MP4, "video/mp4"));
		await codingVault(env).delete(OWNER, "amp");
		const light = "https://ampcode.com/user-content/attachments/9fbe-light.png";
		const { stub, read } = await ampThread(`![Wave](${MP4_URL})\n![Light](${light})`);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put("amp:attachment:https://ampcode.com/user-content/attachments/c595-robot_wave.mp4", { failed: 3 });
			await state.storage.put(`amp:attachment:${light}`, "/api/images/3f1beb2b-bded-4fda-96cc-1af7192f24b6");
		});
		await codingVault(env).saveApiKey(OWNER, "amp", TOKEN_AMP);
		const text = await read();
		expect(text).toMatch(/!\[Wave\]\(\/api\/images\/[\w-]+\.mp4\)/);
		expect(text).toContain("![Light](/api/images/3f1beb2b-bded-4fda-96cc-1af7192f24b6)");
		expect(attachmentCalls(fetcher)).toHaveLength(1);
		fetcher.mockClear();
		expect(await read()).toBe(text);
		expect(fetcher).not.toHaveBeenCalled();
	});
});

describe("supervising an agent-hosted thread", () => {
	const MIN = 60_000;
	const T0 = 1_800_000_000_000;
	/** A thread in a clock the test drives, its orb stamping events with the same clock. */
	async function clocked() {
		codingThreadClock.now = T0;
		const fake = new FakeOrbClient({ now: () => codingThreadClock.now! });
		const made = await orbThread(fake);
		await heartbeat(made.stub);
		const advance = (ms: number) => (codingThreadClock.now! += ms);
		const call = (id: string, name: string, args: Record<string, unknown>) => fake.say(made.orb(), "assistant", "", [{ type: "toolCall", id, name, arguments: args }]);
		const result = (id: string, name: string) => fake.say(made.orb(), "user", "", [{ type: "toolResult", id, name, text: "ok", isError: false }]);
		const stalls = async () => (await inside(made.stub, (thread) => thread.activity())).stalls;
		return { fake, ...made, advance, call, result, stalls };
	}

	it("raises nothing for a long build polled with shell_command_status, whose timeout_ms is only how long one look waits", async () => {
		const { stub, advance, call, result, stalls } = await clocked();
		call("start", "shell_command", { command: "pnpm exec vitest run" });
		result("start", "shell_command");
		for (let poll = 0; poll < 6; poll++) {
			const id = `poll-${poll}`;
			call(id, "shell_command_status", { pid: 123, timeout_ms: 60_000 });
			await heartbeat(stub);
			advance(65_000 + poll * 11_000);
			expect(await stalls()).toEqual([]);
			await heartbeat(stub);
			result(id, "shell_command_status");
			advance(30_000);
			await heartbeat(stub);
		}
		expect(codingStalls).toEqual([]);
	});

	it("looks for stalls after mirroring, so a command that finished remotely on this very poll is no stall", async () => {
		const { fake, orb, stub, advance, call, result } = await clocked();
		call("t", "Bash", { command: "pnpm test", timeout: 60_000 });
		await heartbeat(stub);
		advance(10 * MIN);
		result("t", "Bash");
		fake.say(orb(), "assistant", "Done.");
		fake.setState(orb(), "idle");
		await heartbeat(stub);
		expect(await stub.status()).toMatchObject({ state: "idle" });
		expect(codingStalls).toEqual([]);
	});

	it("is not hidden by a poll that finds nothing new, and is by one that finds the agent's clock advanced", async () => {
		const { fake, orb, stub, advance, stalls } = await clocked();
		// The agent's cloud answers every 30 s that it is working, with no new message and the same last event.
		for (let elapsed = 0; elapsed < 16 * MIN; elapsed += 30_000) {
			advance(30_000);
			await heartbeat(stub);
		}
		expect((await stalls()).map((stall) => stall.reason)).toEqual(["running with no transcript activity for fifteen minutes"]);
		expect(codingStalls.length).toBeGreaterThan(0);
		// Its last event advancing is progress, with or without a message.
		await fake.steer(orb(), "still here");
		await heartbeat(stub);
		expect(await stalls()).toEqual([]);
	});

	it("flags no silent command at five minutes, and one with a declared timeout only past it and one poll", async () => {
		const { advance, call, stub, stalls } = await clocked();
		call("b", "Bash", { command: "cargo build", timeout: 600_000 });
		await heartbeat(stub);
		advance(6 * MIN);
		expect(await stalls()).toEqual([]);
		advance(4 * MIN + 34_000);
		expect(await stalls()).toEqual([]);
		advance(2_000);
		expect((await stalls()).map((stall) => stall.reason)).toContain("past declared timeout");
	});
});
