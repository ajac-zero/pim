// An OrbClient that drives Amp Orbs (https://ampcode.com/docs/cli/execute-mode)
// through the `amp` CLI — the same CLI the workspace harness runs
// (../harness/amp.ts) — with `-ox`, execute mode on an orb in Amp's own cloud,
// where the agent works and Pim can only start a thread, feed it messages and
// read what came of them. The CLI is run by an injected `CommandRunner`, so
// this class starts no process and makes no network call of its own: the real
// runner, which execs the CLI inside a Pim sandbox with the person's Amp access
// token in its environment (never on its command line), is a later slice.
//
// What the CLI does is the contract here, checked against the pinned CLI
// (../../../docs/coding-amp.md): a start's first stream-json line names the
// thread (`session_id`, `T-…`) and its process stays attached until the turn's
// `result`; a `threads continue` queues behind a running turn and its process
// stays until that turn ends; `threads archive` cancels the run and takes the
// thread off the person's list on ampcode.com.

import { AMP_DEFAULT_MODE } from "../harness/amp";
import { LineBuffer } from "../harness/runner";
import {
	type OrbCapabilities,
	type OrbClient,
	OrbAuthError,
	type OrbMessage,
	OrbLostError,
	type OrbThread,
	OrbUnreachableError,
	OrbUnsupportedError,
	type OrbStart,
	type OrbState,
	type OrbStatus,
} from "./types";

/** Where the person watches an Amp thread. */
const ampThreadUrl = (threadId: string) => `https://ampcode.com/threads/${threadId}`;

/** What an Amp access token looks like, never to be repeated in anything the client throws. */
const TOKEN = /sgamp_[A-Za-z0-9_-]+/g;
/** What the CLI says when the person's token was refused: the harness's own login failure, in the CLI's words. */
const AUTH_FAILURE = /invalid or missing api key|run 'amp login'|not signed in|not logged in|authentication_failed|oauth_org_not_allowed/i;
/** What the CLI says when it can't reach Amp at all. */
const UNREACHABLE = /websocket connection failed|couldn't connect|network|econnrefused|enotfound|etimedout|eai_again|fetch failed/i;
/** What the CLI says about a thread that is gone from Amp's cloud. */
const LOST = /thread not found/i;

/** The most of the CLI's error output a failure keeps. */
const STDERR_TAIL = 2_000;

/** What the token is replaced with wherever the CLI printed it. */
const REDACTED = "[redacted]";

const redact = (text: string) => text.replaceAll(TOKEN, REDACTED);

/** One thing that happens while the CLI runs: output as it arrives, and finally exactly one exit. `code` is null when the command was killed. */
export type OrbCommandEvent = { type: "stdout" | "stderr"; data: string } | { type: "exit"; code: number | null; signal?: string };

/** A command the client has started. Iterating `events` starts it; `kill` ends it at once, and its exit event follows. */
export type OrbCommand = {
	readonly events: AsyncIterable<OrbCommandEvent>;
	/** Ends the process at once; whatever it was doing is cancelled. */
	kill(): void;
};

/**
 * How the client runs the `amp` CLI. The real one execs it inside a Pim
 * sandbox, with `AMP_API_KEY` in the process's environment (the runner's own
 * to supply, so the token is never on a command line or in a log) and the
 * person's login in its vault. A test injects one that scripts output, exit
 * codes and delays.
 */
export interface CommandRunner {
	run(argv: readonly string[]): OrbCommand;
}

/**
 * Where the client keeps which thread an idempotency key started, so a retry
 * — after a lost answer, a restart, anything — is the thread the first call
 * started and never a second orb. A thread's Durable Object storage is a
 * natural one.
 */
export interface OrbIdempotencyStore {
	get(key: string): Promise<string | null>;
	set(key: string, threadId: string): Promise<void>;
}

/** What the client is made with. */
export type AmpCliOrbOptions = {
	/** How the CLI is run: the real runner inside a Pim sandbox, a fake in tests. */
	readonly runner: CommandRunner;
	/** Where the thread an idempotency key started is kept. */
	readonly keys: OrbIdempotencyStore;
	/** The client's id, as a thread record names the provider it runs on; "amp-cli" when absent. */
	readonly id?: string;
	/** The clock events are stamped with. */
	readonly now?: () => number;
	/** How many messages one call of `messages` returns at most, so a caller pages; 50 when absent. */
	readonly page?: number;
};

/**
 * One command the client is watching: its output parsed as it arrives, the
 * thread it belongs to found when the CLI's init line names it.
 */
type Watch = {
	readonly command: OrbCommand;
	/** The thread this command is about, when Pim knows it before the CLI says so. */
	readonly about: string | null;
	/** Whether the command prints an init line that names its thread: a start's and a steer's do, an archive's doesn't. */
	readonly namesThread: boolean;
	readonly lines: LineBuffer;
	/** Resolves with the thread's id once the CLI's init line names it; rejects, with what the CLI said, when the command ends first. */
	accepted: Promise<string>;
	/** The promise's two ends, for whoever reads the command to answer at the right one. */
	accept: null | ((threadId: string) => void);
	refuse: null | ((error: OrbAuthError | OrbLostError | OrbUnreachableError) => void);
	/** Whether the promise already has its answer. */
	taken: boolean;
	/** Resolves when the command's output is read to its end. */
	read: Promise<void>;
	/** The thread once the CLI named it, until then null. */
	thread: AmpThread | null;
	/** The stream's `result` for the turn this command runs, once it prints one: the only end of a turn. */
	result: { ok: boolean } | null;
	exit: { code: number | null; signal?: string } | null;
	stderr: string;
};

/** One Amp thread as the client keeps it, from what its CLI has printed. */
type AmpThread = {
	readonly threadId: string;
	readonly url: string;
	state: OrbState;
	lastEventAt: number | null;
	/** The thread's transcript, from the stream-json lines the CLI printed while Pim watched. */
	readonly messages: OrbMessage[];
	/** How many messages the thread has, so their ids are stable and ordered. */
	made: number;
	stopped: boolean;
	lost: boolean;
	/** The commands whose turns are still attached: a queued one counts too, until it ends. */
	readonly processes: Set<Watch>;
};

/** What one line of Amp's stream-json means to an orb client: the thread, the words, and how the turn ended. */
type OrbStreamEvent =
	| { type: "init"; threadId: string }
	| { type: "user"; text: string }
	| { type: "assistant"; text: string }
	| { type: "result"; ok: boolean }
	| { type: "error" }
	| { type: "other" };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : null);

/** Reads one stream-json line: a `system` init's thread, the user's and the assistant's words (a subagent's stay out, as do tool results), errors as `system` messages, and the closing `result`. Anything else is nothing to the client. */
function orbStreamEvent(line: string): OrbStreamEvent {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return { type: "other" };
	}
	if (!isObject(value) || typeof value.type !== "string") return { type: "other" };
	if (value.parent_tool_use_id) return { type: "other" };
	switch (value.type) {
		case "system":
			if (value.subtype === "init") {
				const threadId = str(value.session_id);
				return threadId === null ? { type: "other" } : { type: "init", threadId };
			}
			return value.subtype === "error_during_execution" || value.subtype === "error_max_turns" ? { type: "error" } : { type: "other" };
		case "user":
		case "assistant": {
			const message = isObject(value.message) ? value.message : {};
			const blocks = Array.isArray(message.content) ? message.content : [];
			const text = blocks
				.filter(isObject)
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("\n");
			return text === "" ? { type: "other" } : { type: value.type, text };
		}
		case "result":
			return { type: "result", ok: value.subtype === "success" && value.is_error !== true };
		default:
			return { type: "other" };
	}
}

/** The command that starts a thread on an Amp Orb. The prompt is joined to its flag, so one that starts with a dash is never read as an option; the token never appears here at all. */
const ampOrbStartCommand = (start: OrbStart): string[] => [
	"amp",
	"-ox",
	`--execute=${start.prompt}`,
	"--project",
	start.project,
	"--orb-provider",
	"builtin",
	// When no mode is named, pass medium explicitly so threads stay on predictable modes (Amp's own default is the person's last-used one).
	"--mode",
	start.mode ?? AMP_DEFAULT_MODE,
	...(start.title === null ? [] : ["--title", start.title]),
	"--visibility",
	"private",
	"--no-archive-after-execute",
	"--stream-json",
];

/** The command that gives a thread another message: it queues behind the running turn, never interrupting it. */
const ampOrbSteerCommand = (threadId: string, message: string): string[] => [
	"amp",
	"threads",
	"continue",
	threadId,
	"-ox",
	`--execute=${message}`,
	"--no-archive-after-execute",
	"--stream-json",
];

/** The command that archives a thread on ampcode.com, which cancels its run. */
const ampOrbStopCommand = (threadId: string): string[] => ["amp", "threads", "archive", threadId];

export class AmpCliOrbClient implements OrbClient {
	readonly id: string;

	/** The threads this client started, in the order it started them: a retry starts no second one. */
	get started(): readonly OrbThread[] {
		return this.#started;
	}

	readonly #started: OrbThread[] = [];
	readonly #threads = new Map<string, AmpThread>();
	/** The starts under way, so two calls of one key in the same process make one thread. */
	readonly #starting = new Map<string, Promise<OrbThread>>();
	readonly #runner: CommandRunner;
	readonly #keys: OrbIdempotencyStore;
	readonly #now: () => number;
	readonly #page: number;

	constructor(o: AmpCliOrbOptions) {
		this.id = o.id ?? "amp-cli";
		this.#runner = o.runner;
		this.#keys = o.keys;
		this.#now = o.now ?? Date.now;
		this.#page = o.page ?? 50;
	}

	capabilities(): OrbCapabilities {
		// The CLI reports tokens, not dollars, and a credit isn't a documented number of them (docs/coding-amp.md), so there is no cost to report.
		return { steer: true, stop: true, usage: false };
	}

	async start(start: OrbStart): Promise<OrbThread> {
		const known = await this.#keys.get(start.idempotencyKey);
		// The same key is the thread the first call started, even when that call's answer never arrived, and even across a restart.
		if (known !== null) return this.#handle(known);
		const making = this.#starting.get(start.idempotencyKey);
		if (making) return making;
		const made = this.#make(start).finally(() => this.#starting.delete(start.idempotencyKey));
		this.#starting.set(start.idempotencyKey, made);
		return made;
	}

	async #make(start: OrbStart): Promise<OrbThread> {
		const watch = this.#spawn(ampOrbStartCommand(start), null);
		// Rejects when the CLI ends before its init line: no thread was made, and nothing is kept.
		const threadId = await watch.accepted;
		const handle = this.#handle(threadId);
		// Kept before anything else of the turn is awaited, so a retry of the key is this thread whatever becomes of the turn.
		await this.#keys.set(start.idempotencyKey, threadId);
		this.#started.push(handle);
		return handle;
	}

	async steer(threadId: string, message: string): Promise<void> {
		const thread = this.#threads.get(threadId);
		if (thread?.lost === true) throw new OrbLostError();
		const watch = this.#spawn(ampOrbSteerCommand(threadId, message), threadId);
		// The CLI queues the message behind the running turn, and its process stays attached until that turn ends; take its word that the message was taken (the init line) and let the turn go on without the caller waiting for it.
		await watch.accepted;
	}

	async stop(threadId: string): Promise<void> {
		const thread = this.#threads.get(threadId);
		if (thread?.lost === true) throw new OrbLostError();
		// Stopping a stopped thread does nothing.
		if (thread?.stopped === true) return;
		await this.#run(ampOrbStopCommand(threadId), threadId);
		if (thread === undefined) return;
		thread.stopped = true;
		// Archiving cancels the running tool call; the processes Pim holds for the thread go too.
		for (const watch of [...thread.processes]) watch.command.kill();
		thread.state = "idle";
	}

	async state(threadId: string): Promise<OrbStatus> {
		const thread = this.#threads.get(threadId);
		// Nothing is tracked: the client can't say (after a restart, or a thread it never watched).
		if (thread === undefined) return { state: "unknown", lastEventAt: null };
		if (thread.lost) throw new OrbLostError();
		return { state: thread.state, lastEventAt: thread.lastEventAt };
	}

	async messages(threadId: string, o: { after?: string } = {}): Promise<readonly OrbMessage[]> {
		const thread = this.#threads.get(threadId);
		if (thread === undefined) return [];
		if (thread.lost) throw new OrbLostError();
		// A message id the caller doesn't have (an unknown one, or none given) starts at the beginning.
		const from = o.after === undefined ? 0 : thread.messages.findIndex((message) => message.id === o.after) + 1;
		return thread.messages.slice(from, from + this.#page);
	}

	async usage(_threadId: string): Promise<null> {
		// Amp's CLI reports tokens, not dollars, and a credit isn't a documented number of them (docs/coding-amp.md): there is no cost to report.
		throw new OrbUnsupportedError("Amp's CLI reports tokens, not dollars");
	}

	/**
	 * Resolves when the client has read every process it tracks for the thread
	 * to its end. For tests, which end a scripted turn and then look at what
	 * the client made of it.
	 */
	async settled(threadId: string): Promise<void> {
		const thread = this.#threads.get(threadId);
		if (thread === undefined) return;
		await Promise.all([...thread.processes].map((watch) => watch.read));
	}

	/** The thread, made if this is the first that names it, with the handle Pim keeps. */
	#handle(threadId: string): OrbThread {
		const thread = this.#entry(threadId);
		return { threadId, url: thread.url };
	}

	#entry(threadId: string): AmpThread {
		const known = this.#threads.get(threadId);
		if (known !== undefined) return known;
		const thread: AmpThread = {
			threadId,
			url: ampThreadUrl(threadId),
			state: "unknown",
			lastEventAt: null,
			messages: [],
			made: 0,
			stopped: false,
			lost: false,
			processes: new Set(),
		};
		this.#threads.set(threadId, thread);
		return thread;
	}

	/** Runs a command that says nothing of a thread's transcript and prints no init line, to its end, refusing the CLI's own word for a failure. */
	async #run(argv: readonly string[], about: string): Promise<void> {
		const watch = this.#spawn(argv, about, false);
		await watch.read;
		if (watch.exit === null || watch.exit.code !== 0) throw this.#error(watch);
	}

	/** Starts a command and reads it: every line it prints is kept of the thread, and its end says how the turn ended. */
	#spawn(argv: readonly string[], about: string | null, namesThread = true): Watch {
		const command = this.#runner.run(argv);
		const watch: Watch = {
			command,
			about,
			namesThread,
			lines: new LineBuffer(),
			accepted: null!,
			accept: null,
			refuse: null,
			taken: false,
			read: null!,
			thread: null,
			result: null,
			exit: null,
			stderr: "",
		};
		watch.accepted = new Promise((resolve, reject) => {
			watch.accept = (threadId) => {
				watch.taken = true;
				resolve(threadId);
			};
			watch.refuse = reject;
		});
		watch.read = (async () => {
			try {
				for await (const event of command.events) {
					if (event.type === "stdout") for (const line of watch.lines.push(event.data)) this.#line(watch, line);
					else if (event.type === "stderr") watch.stderr = (watch.stderr + event.data).slice(-STDERR_TAIL);
					else if (event.type === "exit") watch.exit = { code: event.code, signal: event.signal };
				}
				for (const line of watch.lines.flush()) this.#line(watch, line);
			} catch {
				// The runner itself failed; the exit it reported, if any, is all that says how.
			} finally {
				this.#end(watch);
			}
		})();
		return watch;
	}

	#line(watch: Watch, line: string): void {
		const event = orbStreamEvent(line);
		if (event.type === "other") return;
		const thread = event.type === "init" ? this.#entry(event.threadId) : watch.thread;
		// Lines before the init line name nothing, and lines of a thread that isn't this command's are not its to keep.
		if (thread === null) return;
		thread.lastEventAt = this.#now();
		if (event.type === "init") {
			if (watch.thread === null) {
				thread.processes.add(watch);
				watch.thread = thread;
			}
			// A turn is under way: this command's own, or the one it queues behind.
			if (!thread.stopped && !thread.lost) thread.state = "working";
			watch.accept?.(thread.threadId);
			return;
		}
		if (thread.stopped || thread.lost) return;
		switch (event.type) {
			case "user":
			case "assistant":
				// The token is taken out of what the CLI printed, as from everything else the client repeats.
				thread.messages.push({ id: `${thread.threadId}-${++thread.made}`, role: event.type, at: this.#now(), text: redact(event.text) });
				break;
			case "result":
				// A stream result is the only end of a turn.
				watch.result = { ok: event.ok };
				thread.state = event.ok ? "idle" : "error";
				break;
			case "error":
				thread.state = "error";
				break;
		}
	}

	/** What a command's end left of the thread, and the answer to whoever waits for the CLI to have taken its message. */
	#end(watch: Watch): void {
		const thread = watch.thread;
		if (thread !== null) thread.processes.delete(watch);
		if (thread !== null && !thread.stopped && !thread.lost) {
			// The stream never said how the turn ended, so the CLI's own exit does: a killed or failing command failed it, a clean one that said nothing ended it.
			if (watch.exit !== null && watch.exit.code !== 0 && watch.result === null) thread.state = "error";
			else if (watch.exit !== null && watch.exit.code === 0 && watch.result === null && thread.processes.size === 0) thread.state = "idle";
		}
		if (watch.taken) return;
		// A command that prints no init line has nothing to answer; one that should have (a start's or a steer's) failed before its message was taken.
		if (watch.namesThread) watch.refuse?.(this.#error(watch));
		else watch.accept?.(watch.about ?? "");
	}

	/** The client's error for a command that failed, in the CLI's own words with the token taken out. */
	#error(watch: Watch): OrbUnreachableError | OrbAuthError | OrbLostError {
		const said = redact(watch.stderr.trim());
		if (watch.about !== null && LOST.test(said)) {
			// The thread is gone from Amp's cloud; nothing of it can be reached.
			this.#entry(watch.about).lost = true;
			return new OrbLostError();
		}
		const how = said || `The amp CLI ${watch.exit === null ? "ended without an exit" : watch.exit.code === null ? "was killed" : `exited ${watch.exit.code}`}`;
		if (AUTH_FAILURE.test(said)) return new OrbAuthError(how);
		// Anything else the CLI said is read as a cloud that can't be reached just now: nothing was changed, and the call may be tried again.
		return new OrbUnreachableError(UNREACHABLE.test(said) ? how : `The amp CLI failed: ${how}`);
	}
}
