// The conformance suite every orb client must pass (./types.ts), in the style
// of the workspace suite (../workspace/conformance.ts): a client's test file
// calls `runOrbClientConformanceSuite` with a way to make a fresh client, and
// passing the same cases is what shows a thread's loop is not tied to one
// client. Driving a thread is up to the client's test, through the `script`
// hooks: what the agent's own work would do, and the failures a real client
// meets. A case that needs a hook, or a capability the client doesn't have,
// is registered as skipped, with the reason in its name, so a skip is always
// visible.

import { describe, expect, it } from "vitest";
import { type OrbClient, OrbLostError, type OrbMessage, type OrbMethod, OrbUnreachableError, OrbUnsupportedError, type OrbState } from "./types";

/** How the suite drives a client's threads. Every part is optional; a case that needs one is skipped without it. */
export type OrbScript<C extends OrbClient> = {
	/** Puts the thread in this state, as its agent's work would. */
	setState?: (client: C, threadId: string, state: OrbState) => void | Promise<void>;
	/** Adds to the thread's transcript, as the agent's reply or the person's words would. */
	say?: (client: C, threadId: string, role: "user" | "assistant", text: string) => void | Promise<void>;
	/** Makes the thread take the messages steered to it as its next turn, which a real agent decides on its own. */
	deliver?: (client: C, threadId: string) => void | Promise<void>;
	/** Makes every call of `what` fail as one that can't reach the agent's cloud, or stops that when `on` is false. */
	unreachable?: (client: C, what: OrbMethod, on: boolean) => void;
	/** Makes the orb no longer exist, as one deleted on the agent's cloud. */
	lose?: (client: C, threadId: string) => void;
	/** Makes the thread's usage report this many dollars, or say it has none. */
	reportUsage?: (client: C, threadId: string, usd: number | null) => void;
	/** How many threads the client has started. */
	made?: (client: C) => number;
};

export type OrbConformanceOptions<C extends OrbClient> = {
	script?: OrbScript<C>;
};

/** Every message of a thread, read a page at a time: each call asks for what follows the last message received, until one returns none. */
async function transcript<C extends OrbClient>(client: C, threadId: string): Promise<OrbMessage[]> {
	const out: OrbMessage[] = [];
	for (let calls = 0; calls < 1_000; calls++) {
		const page = await client.messages(threadId, out.length === 0 ? {} : { after: out[out.length - 1]!.id });
		const read = out.length;
		out.push(...page);
		if (out.length === read) return out;
	}
	throw new Error("The client never stops returning the same messages");
}

export function runOrbClientConformanceSuite<C extends OrbClient>(name: string, makeClient: () => C, opts: OrbConformanceOptions<C> = {}): void {
	const capabilities = makeClient().capabilities();
	const script = opts.script ?? {};
	let keys = 0;
	const key = () => `conformance-${++keys}`;
	const start = (client: C, idempotencyKey = key()) =>
		client.start({ project: "https://example.test/repo.git", prompt: "Fix the failing test", mode: null, title: null, idempotencyKey });

	// Gated cases are skipped with their reason in the name, never passed silently.
	const gated = (enabled: boolean, reason: string, title: string, body: () => Promise<void>) => (enabled ? it(title, body) : it.skip(`${title} (skipped: ${reason})`, body));
	const canDrive = script.setState !== undefined && script.deliver !== undefined;

	describe(`orb client conformance: ${name}`, () => {
		it("declares what it can do", () => {
			expect(capabilities).toEqual({ steer: expect.any(Boolean), stop: expect.any(Boolean), usage: expect.any(Boolean) });
		});

		it("starts idempotently on the idempotency key", async () => {
			const client = makeClient();
			const k = key();
			const first = await start(client, k);
			expect(typeof first.threadId).toBe("string");
			expect(first.url).toBeTruthy();
			// The same key again is the thread the first call started; a different key is a different thread.
			expect(await start(client, k)).toEqual(first);
			expect(await start(client)).not.toEqual(first);
			if (script.made) expect(script.made(client)).toBe(2);
		});

		gated(
			script.made !== undefined && script.unreachable !== undefined,
			"the suite has no way to fail a call and count threads",
			"starts no second agent when a retry follows a failure",
			async () => {
				const client = makeClient();
				const k = key();
				const first = await start(client, k);
				script.unreachable!(client, "start", true);
				await expect(start(client, k)).rejects.toBeInstanceOf(OrbUnreachableError);
				script.unreachable!(client, "start", false);
				// The retry is the thread that was started, and it is still the only one.
				expect(await start(client, k)).toEqual(first);
				expect(script.made!(client)).toBe(1);
				// A start that never reached the agent's cloud made nothing either.
				script.unreachable!(client, "start", true);
				await expect(start(client)).rejects.toBeInstanceOf(OrbUnreachableError);
				expect(script.made!(client)).toBe(1);
			},
		);

		gated(
			capabilities.steer && canDrive,
			"the client can't steer, or the suite has no way to move a thread",
			"steers a working thread by queueing, never interrupting it",
			async () => {
				const client = makeClient();
				const { threadId } = await start(client);
				await script.setState!(client, threadId, "working");
				await client.steer(threadId, "Run the tests too");
				await client.steer(threadId, "Then push the branch");
				// The turn went on: neither steer stopped it, and neither is in the transcript yet.
				expect((await client.state(threadId)).state).toBe("working");
				expect((await transcript(client, threadId)).map((message) => message.text)).not.toContain("Run the tests too");
				await script.deliver!(client, threadId);
				const texts = (await transcript(client, threadId)).map((message) => message.text);
				expect(texts.indexOf("Run the tests too")).toBeGreaterThan(-1);
				expect(texts.indexOf("Then push the branch")).toBeGreaterThan(texts.indexOf("Run the tests too"));
			},
		);

		gated(capabilities.stop, "the client can't stop a thread", "stops a thread, and stopping a stopped one does nothing", async () => {
			const client = makeClient();
			const { threadId } = await start(client);
			await client.stop(threadId);
			await client.stop(threadId);
			// Stopping cancels the run, so the thread is no longer working.
			expect((await client.state(threadId)).state).not.toBe("working");
		});

		gated(
			script.setState !== undefined,
			"the suite has no way to move a thread",
			"reports the thread's state as it moves",
			async () => {
				const client = makeClient();
				const { threadId } = await start(client);
				const first = await client.state(threadId);
				expect(first.state === "working" || first.state === "idle" || first.state === "awaiting_approval" || first.state === "error" || first.state === "unknown").toBe(true);
				expect(first.lastEventAt === null || Number.isFinite(first.lastEventAt)).toBe(true);
				for (const state of ["working", "awaiting_approval", "error", "idle"] as const) {
					await script.setState!(client, threadId, state);
					expect(await client.state(threadId)).toMatchObject({ state });
				}
			},
		);

		gated(
			capabilities.usage && script.reportUsage !== undefined,
			"the client reports no usage, or the suite has no way to script it",
			"reports what a thread costs, and null when it can't say",
			async () => {
				const client = makeClient();
				const { threadId } = await start(client);
				script.reportUsage!(client, threadId, 1.25);
				expect(await client.usage(threadId)).toEqual({ usd: 1.25 });
				script.reportUsage!(client, threadId, null);
				expect(await client.usage(threadId)).toBeNull();
			},
		);

		gated(!(capabilities.steer && capabilities.stop && capabilities.usage), "the client can do everything", "refuses what its capabilities say it can't do", async () => {
			const client = makeClient();
			const { threadId } = await start(client);
			if (!capabilities.steer) await expect(client.steer(threadId, "no")).rejects.toBeInstanceOf(OrbUnsupportedError);
			if (!capabilities.stop) await expect(client.stop(threadId)).rejects.toBeInstanceOf(OrbUnsupportedError);
			if (!capabilities.usage) await expect(client.usage(threadId)).rejects.toBeInstanceOf(OrbUnsupportedError);
		});

		gated(
			script.lose !== undefined,
			"the suite has no way to lose an orb",
			"reports a lost orb with a typed error",
			async () => {
				const client = makeClient();
				const { threadId } = await start(client);
				script.lose!(client, threadId);
				await expect(client.state(threadId)).rejects.toBeInstanceOf(OrbLostError);
				await expect(client.messages(threadId)).rejects.toBeInstanceOf(OrbLostError);
				if (capabilities.steer) await expect(client.steer(threadId, "anyone there?")).rejects.toBeInstanceOf(OrbLostError);
				if (capabilities.stop) await expect(client.stop(threadId)).rejects.toBeInstanceOf(OrbLostError);
				if (capabilities.usage) await expect(client.usage(threadId)).rejects.toBeInstanceOf(OrbLostError);
			},
		);

		gated(
			script.say !== undefined,
			"the suite has no way to make a thread say anything",
			"pages a thread's messages after the one named",
			async () => {
				const client = makeClient();
				const { threadId } = await start(client);
				const said: string[] = [];
				for (let i = 0; i < 60; i++) {
					const text = `message ${i}`;
					await script.say!(client, threadId, i % 2 === 0 ? "assistant" : "user", text);
					said.push(text);
				}
				const all = await transcript(client, threadId);
				// Every message, oldest first, each exactly once.
				expect(all.map((message) => message.text).filter((text) => said.includes(text))).toEqual(said);
				expect(new Set(all.map((message) => message.id)).size).toBe(all.length);
				// `after` leaves out what the caller already has.
				const first = await client.messages(threadId);
				expect(first.length).toBeGreaterThan(0);
				const rest = await client.messages(threadId, { after: first[0]!.id });
				expect(rest.map((message) => message.id)).not.toContain(first[0]!.id);
			},
		);
	});
}
