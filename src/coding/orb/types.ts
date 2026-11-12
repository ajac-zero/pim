// An agent-hosted execution provider: the second kind of provider a coding
// thread can run on, after a workspace (../workspace/types.ts). There is no
// machine Pim can exec into; the agent runs in the vendor's cloud (an Amp
// Orb) and Pim drives it through a client. Everything here is the contract
// between a coding thread and such a client, and nothing in it may depend on
// one vendor's API: the client is the only seam.

/** A durable handle on one agent-hosted thread. Plain data, so a thread record can keep it and use it again after a Durable Object restart. */
export type OrbThread = {
	/** The agent's own id of the thread, such as an Amp thread id. */
	readonly threadId: string;
	/** Where the person can watch the thread on the agent's own site. */
	readonly url: string;
};

/** What a thread's first turn asks of the agent. */
export type OrbStart = {
	/** The project to work on, as the agent's cloud takes it: a repository the agent clones itself. */
	readonly project: string;
	/** The task: the thread's first prompt. */
	readonly prompt: string;
	/** The agent's own mode to run in, or null for its default. */
	readonly mode: string | null;
	/** A title for the thread, as the person sees it on the agent's site; null to let the agent name it. */
	readonly title: string | null;
	/** What makes `start` idempotent: the same key again is the thread the first call started, so a retry never starts a second agent. */
	readonly idempotencyKey: string;
};

/** What an agent-hosted thread is doing, as far as its client can tell. "unknown" is a client that can't say. */
export type OrbState = "working" | "idle" | "awaiting_approval" | "error" | "unknown";

/** A thread's own state, as `state` reports it. `lastEventAt` is when the agent last did anything, null when the client can't say. */
export type OrbStatus = { readonly state: OrbState; readonly lastEventAt: number | null };

/** One message of a thread's transcript, as the agent's cloud reports it. */
export type OrbMessage = {
	/** The agent's own id of the message, which `messages` pages by. */
	readonly id: string;
	readonly role: "user" | "assistant";
	/** When the agent's cloud says it was said. */
	readonly at: number;
	readonly text: string;
};

/** What a thread has cost, as its agent reports it. `usd` is absent when the agent reports tokens, or nothing, instead of dollars. */
export type OrbUsage = { readonly usd?: number };

/** What a client can do. Callers, and the conformance suite, check this before relying on a feature. */
export type OrbCapabilities = {
	/** Whether `steer` works: a thread mid-turn can be given another message. */
	readonly steer: boolean;
	/** Whether `stop` works. */
	readonly stop: boolean;
	/** Whether `usage` says anything at all. */
	readonly usage: boolean;
};

/** The methods a client has, as failures and the conformance suite name them. */
export type OrbMethod = "start" | "steer" | "stop" | "state" | "messages" | "usage";

/** How a client failed, as a caller can tell apart without matching on a message. */
export type OrbErrorCode = "orb_auth" | "orb_unreachable" | "orb_unsupported" | "orb_lost";

/** Every failure an orb client reports. Clients throw these, never a bare string or a plain `Error`, so a caller can tell what went wrong from the type. */
export class OrbError extends Error {
	constructor(
		message: string,
		readonly code: OrbErrorCode,
	) {
		super(message);
		this.name = "OrbError";
	}
}

/** The client can't reach the agent's cloud just now: nothing was changed, and the call may be tried again. */
export class OrbUnreachableError extends OrbError {
	constructor(message = "Can't reach the agent's cloud just now") {
		super(message, "orb_unreachable");
		this.name = "OrbUnreachableError";
	}
}

/** The person's login with the agent's cloud was refused: a token missing, wrong or expired, which only they can fix. Nothing was changed. */
export class OrbAuthError extends OrbError {
	constructor(message = "The agent's cloud refused this sign-in") {
		super(message, "orb_auth");
		this.name = "OrbAuthError";
	}
}

/** The client's `capabilities` say it can't do this. */
export class OrbUnsupportedError extends OrbError {
	constructor(message = "This orb client can't do that") {
		super(message, "orb_unsupported");
		this.name = "OrbUnsupportedError";
	}
}

/** The thread no longer exists on the agent's cloud: it was deleted there, and nothing of it can be reached. */
export class OrbLostError extends OrbError {
	constructor(message = "This agent-hosted thread no longer exists on its cloud") {
		super(message, "orb_lost");
		this.name = "OrbLostError";
	}
}

/**
 * How Pim drives a coding agent that runs in someone else's cloud. The
 * methods are the whole of it: no file system, no commands, no workspace —
 * the agent's own cloud is where the work happens, and Pim only starts a
 * thread, feeds it messages, reads what came of them and ends it.
 *
 * Every method throws a subclass of `OrbError` on failure, and a thread that
 * no longer exists makes every method throw `OrbLostError`. Calls of a
 * feature `capabilities` says the client doesn't have throw
 * `OrbUnsupportedError`.
 */
export interface OrbClient {
	/** A stable name for the client, as a thread record names the provider it runs on. */
	readonly id: string;
	/** What the client can do. */
	capabilities(): OrbCapabilities;
	/**
	 * Starts a thread and returns a handle on it. Idempotent on
	 * `start.idempotencyKey`: the same key again is the thread the first call
	 * started, whatever became of that call's answer, so a retry never
	 * starts a second agent. A client that can't reach the agent's cloud
	 * throws `OrbUnreachableError`, having made nothing.
	 */
	start(start: OrbStart): Promise<OrbThread>;
	/**
	 * Gives a thread another message. The message is queued and the thread's
	 * run is never interrupted: the agent takes it when it is ready, on a
	 * turn boundary, and until then the thread keeps working. Throws
	 * `OrbUnsupportedError` when `capabilities.steer` is false.
	 */
	steer(threadId: string, message: string): Promise<void>;
	/**
	 * Ends a thread: archives it on the agent's site, where the person's own
	 * list of them lives, and cancels its run. Stopping a thread that is
	 * already stopped does nothing. Throws `OrbUnsupportedError` when
	 * `capabilities.stop` is false.
	 */
	stop(threadId: string): Promise<void>;
	/** Reports what the thread is doing. Never interrupts it; `state` alone never changes anything. */
	state(threadId: string): Promise<OrbStatus>;
	/**
	 * The thread's messages after the one `after` names — all of them when
	 * absent or unknown — oldest first. A client may return only part of what
	 * is left, so a caller pages: it asks again with the id of the last
	 * message it has, until a call returns fewer than the one before it.
	 */
	messages(threadId: string, o?: { after?: string }): Promise<readonly OrbMessage[]>;
	/**
	 * What the thread has cost so far, or null when the client can't say:
	 * the agent reports no cost, or the cloud won't tell. Null means
	 * unavailable, not free. Throws `OrbUnsupportedError` when
	 * `capabilities.usage` is false.
	 */
	usage(threadId: string): Promise<OrbUsage | null>;
}
