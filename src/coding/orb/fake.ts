// An in-memory OrbClient for tests: threads, queues and transcripts in maps,
// a deterministic clock, and the script and failure hooks the conformance
// suite needs (conformance.ts). It is the first client the shared suite runs
// against, and so a reference for the contract in types.ts, not a client that
// reaches anything.

import {
	type OrbCapabilities,
	type OrbClient,
	type OrbMessage,
	OrbLostError,
	type OrbMethod,
	OrbUnreachableError,
	OrbUnsupportedError,
	type OrbStart,
	type OrbState,
	type OrbStatus,
	type OrbThread,
	type OrbUsage,
} from "./types";

/** What the fake is made with. */
export type FakeOrbOptions = {
	/** The client's id, as a thread record names the provider it runs on; "fake" when absent. */
	id?: string;
	/**
	 * The clock events are stamped with. Deterministic by default: a counter
	 * that steps 1 second per recorded event and never reads the real clock,
	 * so two fakes scripted alike report alike.
	 */
	now?: () => number;
	/** What the client can do; everything when absent. */
	capabilities?: Partial<OrbCapabilities>;
	/** How many messages one call of `messages` returns at most, so a caller pages; 50 when absent. */
	page?: number;
};

/** One thread as the fake keeps it. */
type FakeThread = {
	readonly threadId: string;
	readonly url: string;
	state: OrbState;
	lastEventAt: number | null;
	/** Messages steered while the thread works, waiting to be taken as its next turn. */
	readonly queue: string[];
	readonly messages: OrbMessage[];
	/** What the thread has cost as a test scripted it, or null for an agent that reports no cost. */
	usage: OrbUsage | null;
	stopped: boolean;
	lost: boolean;
	/** How many `stop` calls took effect; stopping a stopped thread does nothing, and doesn't count. */
	stops: number;
};

export class FakeOrbClient implements OrbClient {
	readonly id: string;

	/** The threads this fake started, in the order it started them: a retry starts no second one. */
	get started(): readonly OrbThread[] {
		return this.#started;
	}

	readonly #started: OrbThread[] = [];

	readonly #threads = new Map<string, FakeThread>();
	/** The thread each idempotency key started, so a retry is the thread it was. */
	readonly #byKey = new Map<string, string>();
	readonly #capabilities: OrbCapabilities;
	readonly #unreachable = new Set<OrbMethod>();
	readonly #page: number;
	readonly #now: () => number;
	#threadsMade = 0;
	#messagesMade = 0;

	constructor(o: FakeOrbOptions = {}) {
		this.id = o.id ?? "fake";
		this.#capabilities = { steer: true, stop: true, usage: true, ...o.capabilities };
		this.#page = o.page ?? 50;
		let tick = 0;
		this.#now = o.now ?? (() => (tick += 1_000));
	}

	capabilities(): OrbCapabilities {
		return this.#capabilities;
	}

	async start(start: OrbStart): Promise<OrbThread> {
		this.#refuse("start");
		// The same key is the thread the first call started, even when the first call's answer never arrived.
		const known = this.#byKey.get(start.idempotencyKey);
		if (known !== undefined) return this.#thread(this.#live(known));
		const threadId = `T-${++this.#threadsMade}`;
		const thread: FakeThread = {
			threadId,
			url: `https://orb.example.test/threads/${threadId}`,
			state: "working",
			lastEventAt: null,
			queue: [],
			messages: [],
			usage: null,
			stopped: false,
			lost: false,
			stops: 0,
		};
		this.#threads.set(threadId, thread);
		this.#byKey.set(start.idempotencyKey, threadId);
		this.#started.push({ threadId, url: thread.url });
		this.say(threadId, "user", start.prompt);
		return { threadId, url: thread.url };
	}

	async steer(threadId: string, message: string): Promise<void> {
		this.#refuse("steer");
		const thread = this.#live(threadId);
		if (!this.#capabilities.steer) throw new OrbUnsupportedError("This client can't steer a thread");
		// Only queued: the thread's run goes on, and the agent takes the message when it is ready.
		thread.queue.push(message);
		this.#touch(thread);
	}

	async stop(threadId: string): Promise<void> {
		this.#refuse("stop");
		const thread = this.#live(threadId);
		if (!this.#capabilities.stop) throw new OrbUnsupportedError("This client can't stop a thread");
		if (thread.stopped) return;
		thread.stopped = true;
		thread.stops++;
		thread.state = "idle";
		this.#touch(thread);
	}

	async state(threadId: string): Promise<OrbStatus> {
		this.#refuse("state");
		const thread = this.#live(threadId);
		return { state: thread.state, lastEventAt: thread.lastEventAt };
	}

	async messages(threadId: string, o: { after?: string } = {}): Promise<readonly OrbMessage[]> {
		this.#refuse("messages");
		const thread = this.#live(threadId);
		// A message id the caller doesn't have (an unknown one, or none given) starts at the beginning.
		const from = o.after === undefined ? 0 : thread.messages.findIndex((message) => message.id === o.after) + 1;
		return thread.messages.slice(from, from + this.#page);
	}

	async usage(threadId: string): Promise<OrbUsage | null> {
		this.#refuse("usage");
		const thread = this.#live(threadId);
		if (!this.#capabilities.usage) throw new OrbUnsupportedError("This client reports no usage");
		return thread.usage;
	}

	// What only a test does, as the agent's own work would on a real one. Each of these takes a thread that exists, so they throw for one that doesn't.

	/** Puts the thread in this state, as its agent's work would. */
	setState(threadId: string, state: OrbState): void {
		const thread = this.#live(threadId);
		thread.state = state;
		this.#touch(thread);
	}

	/** Adds a message to the thread's transcript, as the agent's reply or the person's words would. */
	say(threadId: string, role: "user" | "assistant", text: string): void {
		const thread = this.#live(threadId);
		const message: OrbMessage = { id: `m-${++this.#messagesMade}`, role, at: this.#now(), text };
		thread.messages.push(message);
		this.#touch(thread);
	}

	/** The thread takes the messages steered to it as its next turn, which a real agent decides on its own. */
	deliver(threadId: string): void {
		const thread = this.#live(threadId);
		const queued = thread.queue.splice(0);
		for (const text of queued) this.say(threadId, "user", text);
		if (queued.length > 0) thread.state = "working";
	}

	/** Makes the thread's usage report this, or say it has none: an agent that reports no cost. */
	setUsage(threadId: string, usage: OrbUsage | null): void {
		this.#live(threadId).usage = usage;
	}

	/** Makes the orb no longer exist, as one deleted on the agent's cloud. */
	lose(threadId: string): void {
		const thread = this.#threads.get(threadId);
		if (thread) thread.lost = true;
	}

	/** Makes calls of `what` throw the client's error for one that can't reach the agent's cloud, or stops that when `on` is false. Nothing is changed while they fail. */
	unreachable(what: OrbMethod, on = true): void {
		if (on) this.#unreachable.add(what);
		else this.#unreachable.delete(what);
	}

	// What a test can see of the fake's own threads.

	/** The messages steered to the thread and not taken yet, oldest first. */
	queued(threadId: string): readonly string[] {
		return [...this.#live(threadId).queue];
	}

	/** How many `stop` calls took effect on the thread. */
	stopCount(threadId: string): number {
		return this.#live(threadId).stops;
	}

	/** Throws when the fake is told this call can't reach the agent's cloud. */
	#refuse(what: OrbMethod): void {
		if (this.#unreachable.has(what)) throw new OrbUnreachableError();
	}

	/** The thread, refusing one that doesn't exist or is gone. */
	#live(threadId: string): FakeThread {
		const thread = this.#threads.get(threadId);
		if (!thread || thread.lost) throw new OrbLostError();
		return thread;
	}

	#thread(thread: FakeThread): OrbThread {
		return { threadId: thread.threadId, url: thread.url };
	}

	#touch(thread: FakeThread): void {
		thread.lastEventAt = this.#now();
	}
}
