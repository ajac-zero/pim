import { describe, expect, it } from "vitest";
import { AmpCliOrbClient, type AmpCliOrbOptions, type OrbIdempotencyStore } from "../src/coding/orb/amp-cli";
import { runOrbClientConformanceSuite } from "../src/coding/orb/conformance";
import { OrbAuthError, OrbLostError, type OrbMethod, OrbUnreachableError } from "../src/coding/orb/types";
import { AMP_SESSION, ampLines } from "./fixtures/amp";
import { ampOrbLines, type AmpCommandKind, FakeCommandRunner } from "./fake-command-runner";

// The Amp CLI orb client (src/coding/orb/amp-cli.ts) on its own, against a
// fake runner (./fake-command-runner.ts): the CLI's command lines as the spike
// of the pinned CLI found them, the stream it prints, what its failures say,
// and the shared conformance suite. No real `amp` and no network anywhere
// here; what the real CLI does with a real token is not verified in CI.

/** An idempotency store in memory, as a Durable Object's storage would keep it. */
class MemoryKeys implements OrbIdempotencyStore {
	readonly #keys = new Map<string, string>();

	async get(key: string): Promise<string | null> {
		return this.#keys.get(key) ?? null;
	}

	async set(key: string, threadId: string): Promise<void> {
		this.#keys.set(key, threadId);
	}
}

const START = { project: "https://example.test/repo.git", prompt: "Fix the failing test", mode: null, title: null } as const;

/** The client and its fake runner, as the suite's script hooks reach them. */
const runners = new WeakMap<AmpCliOrbClient, FakeCommandRunner>();
const fake = (client: AmpCliOrbClient) => runners.get(client)!;

const makeClient = (o: Partial<AmpCliOrbOptions> = {}) => {
	const runner = new FakeCommandRunner();
	const client = new AmpCliOrbClient({ runner, keys: new MemoryKeys(), ...o });
	runners.set(client, runner);
	return client;
};

/** The kinds of command an orb method runs; the ones that run none have nothing to refuse. */
const KINDS: Record<OrbMethod, AmpCommandKind | null> = { start: "start", steer: "steer", stop: "stop", state: null, messages: null, usage: null };

// The CLI's own output is what moves a thread: a turn ends with the stream's result, a message is taken when the init
// line names the thread, and the transcript is what the CLI printed. An orb never waits on an approval Pim could
// answer, so the suite's `awaiting_approval` has no way to happen and `states` leaves it out.
runOrbClientConformanceSuite("amp cli", makeClient, {
	script: {
		states: ["working", "error", "idle"],
		setState: async (client, threadId, state) => {
			const fakeRunner = fake(client);
			let open = fakeRunner.attached(threadId).at(-1);
			if (open === undefined) {
				await client.steer(threadId, "One more turn");
				open = fakeRunner.attached(threadId).at(-1)!;
			}
			// A turn is running: the thread is working, and nothing need happen.
			if (state === "working") return;
			if (state === "error") {
				await open.line(ampOrbLines.result(threadId, false));
				await open.exit(1);
			} else {
				await open.line(ampOrbLines.user(threadId, "One more turn"));
				await open.line(ampOrbLines.result(threadId, true));
				await open.exit(0);
			}
			await client.settled(threadId);
		},
		say: async (client, threadId, role, text) => {
			const open = fake(client).attached(threadId).find((command) => command.kind === "start" || command.kind === "steer");
			if (open === undefined) throw new Error("No command of the thread is running to say this on");
			await open.line(role === "user" ? ampOrbLines.user(threadId, text) : ampOrbLines.assistant(threadId, text));
		},
		deliver: async (client, threadId) => {
			// The agent takes each queued message as its turn: the CLI prints the message, its answer and the turn's result.
			for (const open of fake(client).attached(threadId).filter((command) => command.kind === "steer")) {
				await open.line(ampOrbLines.user(threadId, open.argv.find((each) => each.startsWith("--execute="))!.slice("--execute=".length)));
				await open.line(ampOrbLines.assistant(threadId, "Done with that"));
				await open.line(ampOrbLines.result(threadId, true));
				await open.exit(0);
			}
		},
		unreachable: (client, what, on) => {
			const kind = KINDS[what];
			if (kind !== null) fake(client).refuse(kind, on);
		},
		lose: async (client, threadId) => {
			fake(client).lost.add(threadId);
			// The client learns a thread is gone the only way it can: a command of it says so.
			await expect(client.steer(threadId, "Anyone there?")).rejects.toBeInstanceOf(OrbLostError);
		},
		made: (client) => client.started.length,
	},
});

describe("AmpCliOrbClient", () => {
	it("builds the CLI's command lines exactly, with the prompt joined to its flag and the token nowhere", async () => {
		const client = makeClient();
		await client.start({ ...START, mode: "high", title: "Fix the greeting test", prompt: "-rf / is not an option", idempotencyKey: "k" });
		expect(fake(client).commands[0]!.argv).toEqual([
			"amp",
			"-ox",
			// Joined to its flag, so a prompt that starts with a dash is never read as an option.
			"--execute=-rf / is not an option",
			"--project",
			"https://example.test/repo.git",
			"--orb-provider",
			"builtin",
			// When no mode is named, medium explicitly: Amp's own default is the person's last-used mode.
			"--mode",
			"high",
			"--title",
			"Fix the greeting test",
			"--visibility",
			"private",
			"--no-archive-after-execute",
			"--stream-json",
		]);
		await client.start({ ...START, idempotencyKey: "k2" });
		expect(fake(client).commands[1]!.argv).toContain("--mode");
		expect(fake(client).commands[1]!.argv).toContain("medium");
		const { threadId } = client.started[0]!;
		await client.steer(threadId, "--verbose is not an option either");
		expect(fake(client).of("steer")[0]!.argv).toEqual([
			"amp",
			"threads",
			"continue",
			threadId,
			"-ox",
			"--execute=--verbose is not an option either",
			"--no-archive-after-execute",
			"--stream-json",
		]);
		await client.stop(threadId);
		expect(fake(client).of("stop")[0]!.argv).toEqual(["amp", "threads", "archive", threadId]);
		// The person's Amp access token is the runner's to supply, in the process's environment: it is never on a command line, so it is never in a log of one.
		expect(JSON.stringify(fake(client).commands)).not.toMatch(/sgamp_/);
		expect(fake(client).commands[0]!.argv).not.toContain("-rf / is not an option");
	});

	it("starts the same thread for the same key across a restart, and knows nothing more about it", async () => {
		const keys = new MemoryKeys();
		const first = makeClient({ keys });
		const started = await first.start({ ...START, idempotencyKey: "same" });
		// A restart: a new client and runner, the same store of keys.
		const runner = new FakeCommandRunner();
		const after = new AmpCliOrbClient({ runner, keys });
		expect(await after.start({ ...START, prompt: "Go again", idempotencyKey: "same" })).toEqual(started);
		expect(runner.commands).toHaveLength(0);
		expect(after.started).toHaveLength(0);
		// Nothing is tracked: the client can't say what the thread is doing.
		expect(await after.state(started.threadId)).toEqual({ state: "unknown", lastEventAt: null });
		expect(await after.messages(started.threadId)).toEqual([]);
	});

	it("takes a steered message as soon as the CLI does, without waiting for the queued turn", async () => {
		const client = makeClient();
		const { threadId } = await client.start({ ...START, idempotencyKey: "k" });
		await client.steer(threadId, "Run the tests too");
		const queued = fake(client).of("steer")[0]!;
		// The message was taken (the init line), and the turn it queues behind is still running.
		expect(queued.exited).toBe(false);
		expect((await client.state(threadId)).state).toBe("working");
		expect((await client.messages(threadId)).map((message) => message.text)).not.toContain("Run the tests too");
		// The queued turn ends long after, and the client reads it then.
		await queued.delay(10);
		await queued.line(ampOrbLines.user(threadId, "Run the tests too"));
		await queued.line(ampOrbLines.result(threadId, true));
		await queued.exit(0);
		// The turn it queued behind ends too.
		const running = fake(client).of("start")[0]!;
		await running.line(ampOrbLines.result(threadId, true));
		await running.exit(0);
		await client.settled(threadId);
		expect((await client.messages(threadId)).map((message) => message.text)).toContain("Run the tests too");
		expect((await client.state(threadId)).state).toBe("idle");
	});

	it("stops a thread once: archives it, kills what it holds, and a second stop does nothing", async () => {
		const client = makeClient();
		const { threadId } = await client.start({ ...START, idempotencyKey: "k" });
		await client.steer(threadId, "Run the tests too");
		await client.stop(threadId);
		expect(fake(client).of("stop")).toHaveLength(1);
		expect(fake(client).of("start")[0]!.killed).toBe(true);
		expect(fake(client).of("steer")[0]!.killed).toBe(true);
		expect((await client.state(threadId)).state).toBe("idle");
		await client.stop(threadId);
		expect(fake(client).of("stop")).toHaveLength(1);
	});

	it("reads a failure before the thread began as an unreachable cloud, and keeps nothing of it", async () => {
		const keys = new MemoryKeys();
		const client = makeClient({ keys });
		fake(client).refuse("start");
		await expect(client.start({ ...START, idempotencyKey: "k" })).rejects.toBeInstanceOf(OrbUnreachableError);
		expect(await keys.get("k")).toBeNull();
		expect(client.started).toHaveLength(0);
		// The retry is a start, not a second one of anything.
		fake(client).refuse("start", false);
		expect((await client.start({ ...START, idempotencyKey: "k" })).threadId).toBe("T-1");
	});

	it("maps the CLI's refusal of the person's token to its own error, without repeating the token", async () => {
		const client = makeClient();
		fake(client).script("start", async (command) => {
			await command.error("Error: Invalid or missing API key (sgamp_aFakeAccessToken). Run 'amp login' to authenticate.\n");
			await command.exit(1);
		});
		let failed: unknown = null;
		await client.start({ ...START, idempotencyKey: "k" }).then(
			() => {},
			(error) => {
				failed = error;
			},
		);
		expect(failed).toBeInstanceOf(OrbAuthError);
		expect(failed).toMatchObject({ code: "orb_auth", message: expect.stringContaining("[redacted]") });
		expect(String(failed)).not.toMatch(/sgamp_/);
		expect(client.started).toHaveLength(0);
	});

	it("maps a thread Amp no longer has to a lost orb, on every call after", async () => {
		const client = makeClient();
		const { threadId } = await client.start({ ...START, idempotencyKey: "k" });
		fake(client).lost.add(threadId);
		await expect(client.steer(threadId, "Anyone there?")).rejects.toBeInstanceOf(OrbLostError);
		await expect(client.state(threadId)).rejects.toBeInstanceOf(OrbLostError);
		await expect(client.messages(threadId)).rejects.toBeInstanceOf(OrbLostError);
		await expect(client.stop(threadId)).rejects.toBeInstanceOf(OrbLostError);
	});

	it("reads a captured turn: the thread, the person's words, the agent's answers, and how it ended", async () => {
		const client = makeClient();
		fake(client).script("start", async (command) => {
			for (const line of ampLines("orb-start.jsonl")) {
				await command.line(line);
				await command.delay(1);
			}
			await command.exit(0);
		});
		const { threadId, url } = await client.start({ ...START, idempotencyKey: "k" });
		expect(threadId).toBe(AMP_SESSION);
		expect(url).toBe(`https://ampcode.com/threads/${AMP_SESSION}`);
		await client.settled(threadId);
		expect(await client.state(threadId)).toMatchObject({ state: "idle" });
		const messages = await client.messages(threadId);
		// The person's words and the agent's, in order; a subagent's own words and tool results are not the transcript.
		expect(messages.map((message) => [message.role, message.text])).toEqual([
			["user", "Fix the failing test"],
			["assistant", "I'll run the tests first."],
			["assistant", "Fixed `greet` to include the name; the greeting test passes now."],
		]);
		// The ids are stable and ordered, and `after` pages from one of them.
		expect((await client.messages(threadId)).map((message) => message.id)).toEqual(messages.map((message) => message.id));
		expect(messages.map((message) => message.id)).toEqual([...messages.map((message) => message.id)].sort());
		expect((await client.messages(threadId, { after: messages[0]!.id })).map((message) => message.id)).toEqual(messages.slice(1).map((message) => message.id));
	});

	it("reports no usage, and says it can't rather than answering nothing", async () => {
		const client = makeClient();
		const { threadId } = await client.start({ ...START, idempotencyKey: "k" });
		expect(client.capabilities()).toEqual({ steer: true, stop: true, usage: false });
		await expect(client.usage(threadId)).rejects.toMatchObject({ code: "orb_unsupported" });
	});

	it("takes the token out of what the CLI printed, in the transcript as in its errors", async () => {
		const client = makeClient();
		fake(client).script("start", async (command) => {
			await command.line(ampOrbLines.init(AMP_SESSION));
			await command.line(ampOrbLines.user(AMP_SESSION, "My key is sgamp_aFakeAccessToken, use it"));
			await command.line(ampOrbLines.result(AMP_SESSION, true));
			await command.exit(0);
		});
		const { threadId } = await client.start({ ...START, idempotencyKey: "k" });
		await client.settled(threadId);
		expect(JSON.stringify(await client.messages(threadId))).not.toMatch(/sgamp_/);
		expect((await client.messages(threadId)).map((message) => message.text)).toContain("My key is [redacted], use it");
	});

	it("says a thread failed whose turn the CLI ended without success", async () => {
		const client = makeClient();
		fake(client).script("start", async (command) => {
			await command.line(ampOrbLines.init(AMP_SESSION));
			await command.line(ampOrbLines.user(AMP_SESSION, "Fix the failing test"));
			await command.line(ampOrbLines.result(AMP_SESSION, false));
			await command.exit(1);
		});
		const { threadId } = await client.start({ ...START, idempotencyKey: "k" });
		await client.settled(threadId);
		expect(await client.state(threadId)).toMatchObject({ state: "error" });
	});
});
