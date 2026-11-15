import { describe, expect, it } from "vitest";
import { runOrbClientConformanceSuite } from "../src/coding/orb/conformance";
import { FakeOrbClient } from "../src/coding/orb/fake";
import { OrbLostError, OrbUnreachableError } from "../src/coding/orb/types";

// The fake is pure logic, so it runs in the Worker pool like the workspace fake's tests, touching no binding.

// What the suite needs to drive a client: each hook is the fake's own way of doing what an agent's work, or a broken network, would.
runOrbClientConformanceSuite("fake", () => new FakeOrbClient(), {
	script: {
		setState: (client, threadId, state) => client.setState(threadId, state),
		say: (client, threadId, role, text) => client.say(threadId, role, text),
		deliver: (client, threadId) => client.deliver(threadId),
		unreachable: (client, what, on) => client.unreachable(what, on),
		lose: (client, threadId) => client.lose(threadId),
		reportUsage: (client, threadId, usd) => client.setUsage(threadId, usd === null ? null : { usd }),
		made: (client) => client.started.length,
	},
});

// A client that can only start a thread, as one whose agent's cloud offers nothing else: the cases that need what it lacks are skipped, and the refusal case runs.
runOrbClientConformanceSuite("fake with nothing but start", () => new FakeOrbClient({ capabilities: { steer: false, stop: false, usage: false } }));

describe("FakeOrbClient", () => {
	it("is deterministic: two fakes scripted alike report alike", async () => {
		const script = async (client: FakeOrbClient) => {
			const { threadId } = await client.start({ project: "https://example.test/repo.git", prompt: "Fix the failing test", mode: null, title: null, idempotencyKey: "same" });
			client.say(threadId, "assistant", "On it");
			client.setState(threadId, "idle");
			return { status: await client.state(threadId), messages: await client.messages(threadId) };
		};
		expect(await script(new FakeOrbClient())).toEqual(await script(new FakeOrbClient()));
	});

	it("keeps steers in a queue until the thread takes them, and takes them in order", async () => {
		const client = new FakeOrbClient();
		const { threadId } = await client.start({ project: "p", prompt: "Go", mode: null, title: null, idempotencyKey: "k" });
		await client.steer(threadId, "first");
		await client.steer(threadId, "second");
		expect(client.queued(threadId)).toEqual(["first", "second"]);
		client.deliver(threadId);
		expect(client.queued(threadId)).toEqual([]);
		expect((await client.messages(threadId)).map((message) => message.text)).toEqual(["Go", "first", "second"]);
		expect((await client.state(threadId)).state).toBe("working");
	});

	it("stops a thread once, and a second stop changes nothing", async () => {
		const client = new FakeOrbClient();
		const { threadId } = await client.start({ project: "p", prompt: "Go", mode: null, title: null, idempotencyKey: "k" });
		await client.stop(threadId);
		const stopped = (await client.state(threadId)).lastEventAt;
		await client.stop(threadId);
		expect(client.stopCount(threadId)).toBe(1);
		expect((await client.state(threadId)).lastEventAt).toBe(stopped);
	});

	it("fails only the calls it is told to, and a start of a lost thread's key says it is lost", async () => {
		const client = new FakeOrbClient();
		const { threadId } = await client.start({ project: "p", prompt: "Go", mode: null, title: null, idempotencyKey: "k" });
		client.unreachable("usage");
		await expect(client.usage(threadId)).rejects.toBeInstanceOf(OrbUnreachableError);
		await expect(client.state(threadId)).resolves.toMatchObject({ state: "working" });
		client.unreachable("usage", false);
		expect(await client.usage(threadId)).toBeNull();
		client.lose(threadId);
		await expect(client.state(threadId)).rejects.toBeInstanceOf(OrbLostError);
		await expect(
			client.start({ project: "p", prompt: "Go again", mode: null, title: null, idempotencyKey: "k" }),
		).rejects.toBeInstanceOf(OrbLostError);
		expect(client.started).toHaveLength(1);
	});

	it("returns a page of messages at a time, and starts at the beginning for an id it doesn't know", async () => {
		const client = new FakeOrbClient({ page: 2 });
		const { threadId } = await client.start({ project: "p", prompt: "Go", mode: null, title: null, idempotencyKey: "k" });
		for (let i = 0; i < 5; i++) client.say(threadId, "assistant", `note ${i}`);
		const page = await client.messages(threadId);
		expect(page).toHaveLength(2);
		expect(await client.messages(threadId, { after: "m-no-such-message" })).toEqual(page);
		const next = await client.messages(threadId, { after: page[1]!.id });
		expect(next.map((message) => message.text)).toEqual(["note 1", "note 2"]);
	});
});
