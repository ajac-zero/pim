import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import type { Connection } from "agents";
import {
	dispatchEffect,
	NATIVE_TOOL_OP,
	type NativeOutcome,
	readNativeOutcome,
	readNativeRequest,
} from "../computer/native-outcome";
import type { ExecArgs, ExecResult } from "../computer/pim-computer";
import { digestHex } from "./auth/store";
import { currentTrace, type DispatchTrace } from "./computer-control-runtime";
import type { Selection } from "./cua";
import { HttpError } from "./http";

/**
 * The person's computer: a machine of theirs (a server, a VM, a box at home)
 * running `pim-computer` (../computer/pim-computer.ts), which their agents use
 * to run commands, keep files and browse (its Chrome, driven over DevTools
 * through the same connection: `connectBrowser`). Settings → Computer pairs one with the space
 * by making a token, `pimc_<owner>_<secret>`; the program connects out with it
 * to `/api/computer/connect` over a WebSocket, which the Worker hands to this
 * space as `COMPUTER_PATH`, and answers the space's calls on it. The space
 * keeps only the token's digest, and what the computer last said about itself.
 *
 * A space has at most one computer. It is paired from when the token is made
 * until the person forgets it, and online while it is connected: the tools
 * that use it are offered while it is paired, so a computer that drops off
 * for a moment doesn't change what agents can do, and they hear it's offline
 * when they try.
 *
 * A computer Pim started (./sprites.ts) has no token: the space starts
 * pim-computer there when it's needed, which wakes it, and lets go of it
 * once it has gone unused for `IDLE_MS`, so it sleeps. The space reaches it
 * through a `ComputerLink`, which the provider makes.
 *
 * A space whose operator chose its computer (./cua.ts) has that one, and
 * no other: a Cua VM the operator keeps, which the space wakes and lets go
 * of as it does a Sprite, but neither started nor can remove. Only agents'
 * requests its control state admitted (./computer-control-runtime.ts), and
 * the person's reads (`asPersonRead`), reach it; a paired computer's
 * connection, or a Sprite on record, is never used in its place.
 *
 * A link is used only while what the space reaches its computer by
 * (`binding`: paired computers and Sprites, or the operator's bridge as
 * the Worker's secret names it now) is what it was made under. That, and
 * the operator's choice, are checked right before each call or DevTools
 * message is sent, after any wait, so a link made under another choice or
 * another bridge sends nothing.
 */

/** Where the space takes the computer's connection, behind the Worker's `/api/computer/connect`. */
export const COMPUTER_PATH = "/computer/connect";
/** The header the Worker passes the computer's token in. */
export const COMPUTER_TOKEN_HEADER = "x-pim-computer-token";
/** The tag of the computer's connection among the space's sockets. */
export const COMPUTER_TAG = "computer";
/** The close code an old connection gets when another one replaces it (pim-computer's `REPLACED`). */
const REPLACED = 4409;
/** The most bytes the computer gives in one read (pim-computer's `MAX_READ_BYTES`), and the most this sends in one write. */
const CHUNK_BYTES = 1_048_576;
/** How long a file call may take. */
const FILE_CALL_MS = 30_000;
/** What a command may take by default, and at most. */
export const DEFAULT_COMMAND_MS = 120_000;
export const MAX_COMMAND_MS = 600_000;
/** How much of each of a command's outputs comes back. */
const COMMAND_OUTPUT_BYTES = 64_000;
/**
 * How long a native-app call may take: longer than the host's own bounds,
 * three setup requests of `setupMs` (10 s) and one call of `callMs` (60 s),
 * so the space doesn't give a call up before the host has (docs/cua-native-mcp.md).
 */
export const NATIVE_CALL_MS = 120_000;

/** How long a computer Pim started may take to wake and start pim-computer. */
const WAKE_MS = 90_000;
/** How long a computer Pim started goes unused before the space lets go of it, and it sleeps. */
export const IDLE_MS = 5 * 60_000;

const TOKEN_KEY = "computer_token";
const MACHINE_KEY = "computer_machine";
const PAIRED_AT_KEY = "computer_paired_at";
const INFO_KEY = "computer_info";
/** What the operator's computer said about itself, kept apart, so a paired computer's never stands for it. */
const SELECTED_INFO_KEY = "computer_info_selected";

/** A person's reads of their own files and browser, through the routes that only read (`asPersonRead`). */
const personReads = new AsyncLocalStorage<true>();
/** The calls a person's read may make on the operator's computer outside any agent's request: they look, and change nothing there. */
const PERSON_READS: ReadonlySet<string> = new Set(["stat", "read", "readdir", "browser_status"]);

/** Runs `read` as the person's own read, which the operator's computer takes outside any agent's request (see `Computer`). */
export function asPersonRead<T>(read: () => T): T {
	return personReads.run(true, read);
}

/** The owner a computer's token names. Whether it is really theirs is for their space to say. */
export function computerTokenOwner(token: string): string | null {
	return /^pimc_(o_[0-9a-z]{26})_[\w-]+$/.exec(token)?.[1] ?? null;
}

/** What the computer said about itself when it last connected. */
export type ComputerInfo = {
	readonly agent: string;
	readonly hostname: string;
	readonly platform: string;
	readonly arch: string;
	readonly user: string;
	/** The folder on it that is `/workspace`. */
	readonly root: string;
	/** The Chrome the agents browse with there, or null where it has none. */
	readonly browser: string | null;
	readonly connectedAt: number;
};

export type ComputerState = "none" | "offline" | "online";

export type ComputerStatus = {
	readonly state: ComputerState;
	/** Whether Pim started it (./sprites.ts): it sleeps when unused, and wakes when it's needed. */
	readonly managed: boolean;
	readonly pairedAt: number | null;
	readonly computer: ComputerInfo | null;
	/**
	 * Set when the space's operator chose its computer (./cua.ts): `cua`, a
	 * Cua VM that Pim neither started nor can remove, or `unreadable`, a
	 * choice Pim can't read, when it uses no computer.
	 */
	readonly provider?: Selection;
};

/**
 * pim-computer on a computer Pim started, as the space talks to it: a
 * message at a time, each one of pim-computer's JSON messages, in both
 * directions. The provider that made it hands what arrives to
 * `Computer.receive`, and calls `Computer.disconnected` once it has ended.
 * A message it takes is handed to its transport, which says nothing of
 * whether pim-computer got it or ran it: only a reply does. It sends nothing
 * again after an end, and keeps nothing to send later.
 */
export type ComputerLink = {
	readonly readyState: number;
	send(message: string): void;
	/** Lets go of the computer: pim-computer there stops, and the provider may let it sleep. */
	close(): void;
};

type Meta = {
	meta(key: string): string | undefined;
	setMeta(key: string, value: string): void;
	deleteMeta(key: string): void;
};

/** A DevTools connection to the computer's browser, as puppeteer's `ConnectionTransport`. */
export type BrowserTransport = {
	send(message: string): void;
	close(): void;
	onmessage?: (message: string) => void;
	onclose?: () => void;
};

type Pending = {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	/** Set for a native-app call (`NATIVE_TOOL_OP`): the request it was sent for, if any, and its key in that request's `awaiting`. */
	native?: { trace: DispatchTrace | undefined; key: string };
};

/**
 * The browser's DevTools connection, and who waits for answers on it: each
 * message sent and not answered yet, by its session and ID, with the requests
 * it was sent for (see `connectBrowser`).
 */
type BrowserConnection = {
	channel: number;
	transport: BrowserTransport;
	awaiting: Map<string, DispatchTrace[]>;
	/** The requests that sent something on it; what is sent for none of them may be their doing. */
	users: Set<DispatchTrace>;
};

/** What tells a DevTools message's answer from others': its session and ID, or null for an event or a message without an ID. */
function answerKey(raw: string): string | null {
	try {
		const { id, sessionId } = JSON.parse(raw) as { id?: unknown; sessionId?: unknown };
		return typeof id === "number" ? `${typeof sessionId === "string" ? sessionId : ""}:${id}` : null;
	} catch {
		return null;
	}
}

/** A failure the computer reported, with its code (`ENOENT`…), which the file tools read. */
function remoteError(error: { message?: unknown; code?: unknown }): Error {
	return Object.assign(new Error(String(error.message ?? "The computer failed")), { answered: true }, typeof error.code === "string" ? { code: error.code } : {});
}

export class Computer {
	readonly #meta: Meta;
	readonly #sockets: () => Connection[];
	readonly #pending = new Map<string, Pending>();
	/** The DevTools connection to the computer's browser, of which there is one at a time. */
	#browser: BrowserConnection | null = null;
	/** Starts pim-computer on the computer Pim started, which wakes it, when a call finds it asleep. */
	readonly #wake: () => Promise<ComputerLink>;
	/** Whether the space is using the computer in a way it doesn't see itself, such as someone watching its browser. */
	readonly #inUse: () => boolean;
	/** The computer the space's operator chose, which is then its only one; null for paired computers and Sprites. */
	readonly #selected: () => Selection | null;
	/** What the space reaches its computer by now, which a link must have been made under; throws when that can't be read. */
	readonly #binding: () => string;
	/** Whether native-app calls may be sent (`native`): only when the one who makes the computer says so, which Pim doesn't yet. */
	readonly #nativeApps: boolean;
	/** pim-computer on the computer Pim started, while the space holds on to it. */
	#link: ComputerLink | null = null;
	/** What `#link` was made under (`#binding`), kept in memory only. */
	#linkBinding: string | null = null;
	#waking: Promise<void> | undefined;
	/** What waits for pim-computer on the computer Pim started to say what it is, or to stop before it has. */
	#arrivals: ((hello: boolean) => void)[] = [];
	#usedAt = 0;
	#idle: ReturnType<typeof setTimeout> | undefined;

	constructor(options: {
		meta: Meta;
		sockets: () => Connection[];
		wake: () => Promise<ComputerLink>;
		inUse: () => boolean;
		selected?: () => Selection | null;
		binding?: () => string;
		/** Lets `native` send native-app calls to the operator's Cua computer. Off unless given. */
		nativeApps?: boolean;
	}) {
		this.#meta = options.meta;
		this.#sockets = options.sockets;
		this.#wake = options.wake;
		this.#inUse = options.inUse;
		this.#selected = options.selected ?? (() => null);
		this.#binding = options.binding ?? (() => "default");
		this.#nativeApps = options.nativeApps === true;
	}

	/** The computer the space's operator chose, if any (./cua.ts). */
	selected(): Selection | null {
		return this.#selected();
	}

	/** The machine of the computer Pim started, or null for one the person brought. */
	machine(): string | null {
		return this.#meta.meta(MACHINE_KEY) ?? null;
	}

	/** The computer is now the machine Pim started, `name`, in place of any other. */
	started(name: string, now: number): void {
		this.forget();
		this.#meta.setMeta(MACHINE_KEY, name);
		this.#meta.setMeta(PAIRED_AT_KEY, String(now));
	}

	/** Whether it's doing something for the space now: answering a call, or with its browser connected. */
	busy(): boolean {
		return this.#pending.size > 0 || this.#browser !== null;
	}

	#use(): void {
		this.#usedAt = Date.now();
	}

	/**
	 * Lets go of the computer Pim started once it has gone unused for
	 * `IDLE_MS` (by `now`), so it sleeps; one in use is looked at again later.
	 */
	letGoIfIdle(now = Date.now()): void {
		clearTimeout(this.#idle);
		const link = this.#link;
		if (!link || link.readyState !== WebSocket.OPEN) return;
		const idle = now - this.#usedAt;
		if (idle < IDLE_MS || this.busy() || this.#inUse()) {
			this.#idle = setTimeout(() => this.letGoIfIdle(), Math.max(IDLE_MS - idle, 60_000));
			return;
		}
		this.#letGo();
	}

	/** Lets go of the computer Pim started, or the operator's: calls and the browser waiting on it fail now. */
	#letGo(): void {
		const link = this.#link;
		this.#link = null;
		link?.close();
		clearTimeout(this.#idle);
		this.#failPending();
	}

	/** Why the open link may not be used now, as it was made under another choice or bridge than the space's now; null when it may, or there is none. */
	#stale(): Error | null {
		if (this.#link?.readyState !== WebSocket.OPEN) return null;
		try {
			return this.#binding() === this.#linkBinding ? null : new HttpError(503, "The space's computer has changed since it was connected, so nothing was sent to it.");
		} catch (error) {
			return error as Error;
		}
	}

	/** Whether a computer is paired, online or not: one the person brought, with its token, one Pim started, or the operator's. */
	paired(): boolean {
		return this.#selected() !== null || this.#meta.meta(TOKEN_KEY) !== undefined || this.machine() !== null;
	}

	#socket(): Pick<Connection, "send"> | undefined {
		if (this.#link?.readyState === WebSocket.OPEN) return this.#link;
		// A paired computer's connection never stands in for the operator's computer.
		if (this.#selected()) return undefined;
		return this.#sockets().find((socket) => socket.readyState === WebSocket.OPEN);
	}

	status(): ComputerStatus {
		const selected = this.#selected();
		if (selected) {
			const info = selected === "cua" ? this.#meta.meta(SELECTED_INFO_KEY) : undefined;
			const state = this.#socket() ? "online" : "offline";
			return { state, managed: false, pairedAt: null, computer: info ? (JSON.parse(info) as ComputerInfo) : null, provider: selected };
		}
		if (!this.paired()) return { state: "none", managed: false, pairedAt: null, computer: null };
		const info = this.#meta.meta(INFO_KEY);
		return {
			state: this.#socket() ? "online" : "offline",
			managed: this.machine() !== null,
			pairedAt: Number(this.#meta.meta(PAIRED_AT_KEY)),
			computer: info ? (JSON.parse(info) as ComputerInfo) : null,
		};
	}

	/** Pairs a new computer, in place of any other: the token is returned only here, and only its digest is kept. */
	async pair(owner: string, now: number): Promise<string> {
		const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
		const token = `pimc_${owner}_${secret}`;
		this.#meta.setMeta(TOKEN_KEY, await digestHex(token));
		this.#meta.setMeta(PAIRED_AT_KEY, String(now));
		this.#meta.deleteMeta(INFO_KEY);
		this.disconnect("A new computer was paired");
		return token;
	}

	/** Forgets the computer: its token stops working, and it is disconnected. Its files stay on it. */
	forget(): void {
		this.#meta.deleteMeta(TOKEN_KEY);
		this.#meta.deleteMeta(PAIRED_AT_KEY);
		this.#meta.deleteMeta(INFO_KEY);
		this.#meta.deleteMeta(MACHINE_KEY);
		this.disconnect("The computer was removed");
	}

	disconnect(reason: string): void {
		for (const socket of this.#sockets()) socket.close(REPLACED, reason);
		this.#link?.close();
		this.#link = null;
		clearTimeout(this.#idle);
		this.#failPending();
	}

	async checkToken(token: string | null): Promise<boolean> {
		const known = this.#meta.meta(TOKEN_KEY);
		return token !== null && known !== undefined && (await digestHex(token)) === known;
	}

	/** A computer connected: it takes the place of any other connection. */
	connected(connection: Connection): void {
		for (const socket of this.#sockets()) {
			if (socket.id !== connection.id) socket.close(REPLACED, "Another computer connected with this token");
		}
	}

	/** The connection closed: calls waiting on it fail now rather than at their timeouts. */
	disconnected(): void {
		if (this.#socket()) return;
		for (const arrival of this.#arrivals.splice(0)) arrival(false);
		this.#failPending();
	}

	#failPending(): void {
		this.#browserClosed();
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(new HttpError(503, "The computer disconnected before it answered."));
			this.#pending.delete(id);
		}
	}

	/** A message from the computer: what it is, or an answer to a call. */
	receive(raw: string): void {
		let message: { type?: unknown; id?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown } };
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (message.type === "hello") {
			const hello = message as Record<string, unknown>;
			const info: ComputerInfo = {
				agent: String(hello.agent ?? ""),
				hostname: String(hello.hostname ?? ""),
				platform: String(hello.platform ?? ""),
				arch: String(hello.arch ?? ""),
				user: String(hello.user ?? ""),
				root: String(hello.root ?? ""),
				browser: typeof hello.browser === "string" ? hello.browser : null,
				connectedAt: Date.now(),
			};
			this.#meta.setMeta(this.#selected() ? SELECTED_INFO_KEY : INFO_KEY, JSON.stringify(info));
			for (const arrived of this.#arrivals.splice(0)) arrived(true);
			return;
		}
		if (message.type === "cdp" || message.type === "cdp_closed") {
			const browser = this.#browser;
			if (!browser || browser.channel !== (message as { channel?: unknown }).channel) return;
			if (message.type === "cdp_closed") {
				this.#browserClosed();
				return;
			}
			const data = String((message as { data?: unknown }).data);
			// An answer counts only for the message it answers, on this connection; one nobody waits for (late, repeated, foreign) counts for none.
			// With nothing awaited, as in a space that hasn't opted in, messages (the live view's pictures among them) aren't read.
			const key = browser.awaiting.size > 0 ? answerKey(data) : null;
			const waiting = key === null ? undefined : browser.awaiting.get(key);
			if (key !== null && waiting) {
				browser.awaiting.delete(key);
				for (const trace of waiting) trace.awaiting.delete(`${browser.channel}:${key}`);
			}
			browser.transport.onmessage?.(data);
			return;
		}
		if (message.type !== "reply" || typeof message.id !== "string") return;
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		clearTimeout(pending.timer);
		if (pending.native) this.#nativeReply(pending, message, pending.native);
		else if (message.error) pending.reject(remoteError(message.error));
		else pending.resolve(message.result ?? null);
	}

	/**
	 * The reply to a native-app call, which is known only when it is exactly a
	 * `NativeOutcome` (../computer/native-outcome.ts). An unknown one, or a reply
	 * that is no outcome (an error, which can't say whether the app was acted
	 * on, or anything malformed), leaves the request uncertain, before whoever
	 * waits hears of it. A known one clears only its own wait: it never lowers
	 * `sent` or `uncertain`, which may stand for the request's other calls.
	 * Nothing the computer said is passed on but a checked outcome. Checking it
	 * can't strand the call: the reply has already taken the call's place, so
	 * a check that throws settles it as a malformed reply does.
	 */
	#nativeReply(pending: Pending, message: { result?: unknown }, { trace, key }: { trace: DispatchTrace | undefined; key: string }): void {
		let outcome: NativeOutcome | null = null;
		try {
			outcome = Object.hasOwn(message, "error") ? null : readNativeOutcome(message.result);
		} catch {
			// Not passed on or logged: it may be about what the computer said.
		}
		if (trace && (!outcome || dispatchEffect(outcome).uncertain)) trace.uncertain = true;
		trace?.awaiting.delete(key);
		if (outcome) pending.resolve(outcome);
		else pending.reject(new HttpError(502, "The computer's answer to a native-app call couldn't be read, so whether it acted is unknown."));
	}

	/**
	 * Calls the computer and waits for its answer; one Pim started wakes first,
	 * if it's asleep. Op `NATIVE_TOOL_OP` is refused here, unsent: only
	 * `native` makes it, which resolves only with a checked `NativeOutcome`,
	 * awaited in its request's trace until a reply comes (see `#nativeReply`).
	 * Every other op is answered as it always was. Nothing in the reply
	 * chooses which.
	 */
	async call<T = unknown>(op: string, args: Record<string, unknown>, timeoutMs = FILE_CALL_MS, counts = true): Promise<T> {
		// Its args are made only by `native`, from the request being admitted, never by a caller.
		if (op === NATIVE_TOOL_OP) throw new HttpError(400, "A native-app call is made only through the space's own native-app path, so nothing was sent.");
		return this.#call<T>(op, args, timeoutMs, counts);
	}

	/**
	 * Calls one curated native-app tool on the operator's Cua computer, as
	 * the request the control state is admitting now, and resolves with the
	 * checked `NativeOutcome` (see `call` and `#nativeReply`).
	 *
	 * Only `tool` and `args` come from the caller. Who calls is the admitted
	 * request's (`DispatchTrace.request`): the owner is the space's own name,
	 * the agent is the one the server knows, the run is the one the server
	 * named, and the call's ID is the request's ID, so a request makes at most
	 * one native-app call. Anything else is refused before anything is sent,
	 * with a 4xx: native-app calls not turned on, a computer that isn't the
	 * operator's Cua VM (paired computers and Sprites never get one), no
	 * admitted request or one with no run, a second call in a request, a tool
	 * that isn't curated, and arguments that aren't a plain JSON object of at
	 * most `NATIVE_ARGUMENTS_CHARS` (`readNativeRequest`). What is sent is
	 * that reader's copy, made before anything is awaited: anything JSON would
	 * convert (a getter, `toJSON`, a date) is refused, not converted. The host
	 * checks the arguments against the tool's curated schema.
	 */
	async native(tool: unknown, args: unknown, timeoutMs = NATIVE_CALL_MS): Promise<NativeOutcome> {
		const refuse = (why: string) => new HttpError(409, `${why}, so no native-app call was sent.`);
		if (!this.#nativeApps) throw refuse("Native-app calls are off for this computer");
		if (this.#selected() !== "cua") throw refuse("Only an operator's Cua computer takes native-app calls");
		const trace = currentTrace();
		const admitted = trace?.request;
		if (!trace || !admitted) throw refuse("A native-app call is made only within a request the control state admitted");
		if (admitted.runId === undefined) throw refuse("The request names no run");
		if (trace.native) throw refuse("This request has made its native-app call already");
		// The shared reader copies the arguments as plain JSON data, read once each, and refuses anything else; it never throws.
		const request = readNativeRequest({ owner: admitted.space, agentId: admitted.agentId, runId: admitted.runId, callId: admitted.requestId, tool, arguments: args });
		if (!request) throw new HttpError(400, "The native-app call names no curated tool, or its arguments aren't a plain JSON object of a bounded size, so nothing was sent.");
		// Spent now, whatever comes: the request's one call ID is taken.
		trace.native = true;
		return this.#call<NativeOutcome>(NATIVE_TOOL_OP, request, timeoutMs);
	}

	async #call<T>(op: string, args: Record<string, unknown>, timeoutMs: number, counts = true): Promise<T> {
		if (!this.paired()) throw new HttpError(404, "No computer is connected. The person can connect one in Settings → Computer.");
		const refused = this.#refusal(op);
		if (refused) throw refused;
		// A link made under another choice or bridge is let go, and waking makes one under the space's now.
		if (this.#stale()) this.#letGo();
		await this.wake();
		// Checked again after the wait, right before sending: the choice, or the bridge, may have changed meanwhile.
		const stale = this.#stale();
		if (stale) {
			this.#letGo();
			throw stale;
		}
		const late = this.#refusal(op);
		if (late) throw late;
		const socket = this.#socket();
		if (!socket) throw new HttpError(503, "The computer is offline: pim-computer isn't connected. Ask the person to start it again.");
		if (counts) this.#use();
		const id = crypto.randomUUID();
		// A request the control state admitted (see ./computer-control-runtime.ts) learns what became of its calls.
		const trace = currentTrace();
		const native = op === NATIVE_TOOL_OP ? { trace, key: `native:${id}` } : undefined;
		const answer = new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new HttpError(504, `The computer didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`));
			}, timeoutMs);
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, ...(native ? { native } : {}) });
			socket.send(JSON.stringify({ type: "call", id, op, args }));
			if (trace) trace.sent = true;
			// Settled before its reply, the request is unknown: the app may yet be acted on.
			if (trace && native) trace.awaiting.add(native.key);
		});
		// A call that was sent and wasn't answered, by a timeout or a disconnect, may have run.
		return trace
			? answer.catch((error: unknown) => {
					if (!(error as { answered?: unknown }).answered) trace.uncertain = true;
					throw error;
				})
			: answer;
	}

	/**
	 * On the operator's computer, refuses call `op` unless an agent's request
	 * the control state admitted makes it, or it is one of the person's reads
	 * (a DevTools message, `op` null, goes either way); and refuses everything
	 * while the operator's choice can't be read, or a paired computer or a
	 * Sprite is still on record beside it, which Pim leaves for the operator
	 * to resolve. Null when it may be sent.
	 */
	#refusal(op: string | null): HttpError | null {
		const selected = this.#selected();
		if (!selected) return null;
		if (selected === "unreadable") {
			return new HttpError(503, "This space's choice of computer can't be read, so Pim uses no computer for it and sent nothing. Its operator must repair it.");
		}
		if (this.#meta.meta(TOKEN_KEY) !== undefined || this.machine() !== null) {
			return new HttpError(
				409,
				"This space's computer is its operator's Cua VM, but a paired computer or a computer Pim started is still on record, so Pim uses none of them and sent nothing. Its operator must resolve it.",
			);
		}
		if (op === null || currentTrace() || (personReads.getStore() && PERSON_READS.has(op))) return null;
		return new HttpError(409, "This space's Cua computer takes only agents' requests its control state admits, and the person's reads, so nothing was sent to it.");
	}

	/**
	 * Wakes the computer Pim started, or the operator's, if it's asleep, by
	 * starting pim-computer there, and waits until it says what it is; once
	 * for every call that finds it asleep.
	 */
	wake(): Promise<void> {
		if (this.#socket() || (!this.machine() && !this.#selected())) return Promise.resolve();
		this.#waking ??= (async () => {
			const arrived = new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), WAKE_MS);
				this.#arrivals.push((hello) => {
					clearTimeout(timer);
					resolve(hello);
				});
			});
			try {
				// What the link is made under, read in the same turn as the provider reads it to connect.
				const binding = this.#binding();
				this.#link = await this.#wake();
				this.#linkBinding = binding;
			} catch (error) {
				for (const arrival of this.#arrivals.splice(0)) arrival(false);
				throw error;
			}
			if (!(await arrived)) {
				this.#link?.close();
				this.#link = null;
				throw new HttpError(504, "The computer didn't wake up. Try again in a minute.");
			}
			this.#use();
			this.letGoIfIdle();
		})().finally(() => {
			this.#waking = undefined;
		});
		return this.#waking;
	}

	/** Whether the computer has a browser, and whether it's running; neither while the computer is offline or asleep. */
	async browserStatus(): Promise<{ available: boolean; running: boolean }> {
		if (!this.#socket()) return { available: false, running: false };
		// Asking doesn't count as using it, so an app watching the browser lets a computer sleep.
		return this.call<{ available: boolean; running: boolean }>("browser_status", {}, FILE_CALL_MS, false);
	}

	/**
	 * Connects to the computer's browser over DevTools, starting it there
	 * first when it isn't running. Its messages go through the computer's
	 * connection; a connection made before this one is closed.
	 *
	 * For a request the control state admitted (./computer-control-runtime.ts),
	 * each message sent is awaited by its session and DevTools ID, in that
	 * request's trace, until the answer with that key arrives on this
	 * connection. One that can't be sent (this connection was replaced or
	 * closed, or the computer is offline) throws at once, sent for nobody. One
	 * handed to the socket stays awaited when the connection ends or the
	 * request gives up on it, so the request is settled unknown; answers to the
	 * connection's setup, or to other messages, don't count for it. Puppeteer's
	 * own messages, sent as it hears from the browser, and the person's, carry no
	 * request: each unsettled request that has used this connection waits for
	 * them too. A request's message reusing an ID still awaited throws unsent.
	 * With no request using the connection nothing is recorded or read.
	 */
	async connectBrowser(): Promise<BrowserTransport> {
		const { channel } = await this.call<{ channel: number }>("browser_connect", {}, 60_000);
		this.#browserClosed();
		const transport: BrowserTransport = {
			send: (data) => {
				const trace = currentTrace();
				if (this.#browser !== connection) {
					// Nothing leaves; a request hears so now, rather than wait for an answer that can't come.
					if (trace) throw new Error("The browser's connection has closed, so nothing was sent to it.");
					return;
				}
				// Checked right before sending, as for a call: the choice, the bridge, or the connection may have changed since it connected.
				const socket = this.#socket();
				const refused = this.#refusal(null) ?? this.#stale() ?? (socket ? null : new Error("The browser's connection has closed, so nothing was sent to it."));
				if (refused || !socket) {
					// Nothing leaves, and the connection ends here, once puppeteer is done sending, so nothing more waits on it.
					queueMicrotask(() => {
						if (this.#browser === connection) this.#browserClosed();
					});
					if (trace) throw refused;
					return;
				}
				this.#use();
				this.#await(connection, data, trace);
				socket.send(JSON.stringify({ type: "cdp", channel, data }));
			},
			close: () => {
				if (this.#browser !== connection) return;
				this.#browser = null;
				void this.call("browser_disconnect", { channel }).catch(() => undefined);
			},
		};
		const connection: BrowserConnection = { channel, transport, awaiting: new Map(), users: new Set() };
		this.#browser = connection;
		return transport;
	}

	/** Records who waits for the answer to a DevTools message about to be sent; throws, before anything is sent, for a request's message whose answer couldn't be told apart. */
	#await(connection: BrowserConnection, data: string, trace: DispatchTrace | undefined): void {
		for (const user of connection.users) if (user.settled) connection.users.delete(user);
		if (!trace && connection.users.size === 0) return;
		const key = answerKey(data);
		const earlier = key === null ? undefined : connection.awaiting.get(key);
		if (trace && earlier) throw new Error("A message with this ID is still awaiting its answer, so this one was not sent.");
		if (trace) {
			trace.sent = true;
			connection.users.add(trace);
		}
		const waiting = trace ? [trace] : [...connection.users];
		if (key === null || earlier) {
			// An answer that can't be told apart from another's says nothing of which message ran.
			for (const each of [...waiting, ...(earlier ?? [])]) each.uncertain = true;
			return;
		}
		connection.awaiting.set(key, waiting);
		for (const each of waiting) each.awaiting.add(`${connection.channel}:${key}`);
	}

	/** Quits the computer's browser; its profile, with what's signed in there, stays. */
	async stopBrowser(): Promise<void> {
		await this.call("browser_stop", {});
	}

	#browserClosed(): void {
		const browser = this.#browser;
		this.#browser = null;
		browser?.transport.onclose?.();
	}

	/** Runs a shell command on the computer. */
	exec(command: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
		const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_COMMAND_MS, MAX_COMMAND_MS);
		const args: ExecArgs = { command, timeoutMs, maxBytes: COMMAND_OUTPUT_BYTES, ...(options.cwd ? { cwd: options.cwd } : {}) };
		return this.call<ExecResult>("exec", args, timeoutMs + 15_000);
	}

	/**
	 * The computer's `/workspace` as the file tools of `@cloudflare/computer`
	 * use a Workspace's (its `WorkspaceLike`): each call goes to the computer,
	 * and large files go in parts.
	 */
	readonly fs = {
		stat: (path: string) =>
			this.call<{ size: number; mtime: number; mode: number; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>("stat", { path }),
		readFile: async (path: string, options: { byteOffset?: number; byteLength?: number } = {}): Promise<ReadableStream<Uint8Array>> => {
			let offset = options.byteOffset ?? 0;
			const end = options.byteLength === undefined ? Number.POSITIVE_INFINITY : offset + options.byteLength;
			const read = async () => {
				const { data, size } = await this.call<{ data: string; size: number }>("read", { path, offset, length: Math.min(CHUNK_BYTES, end - offset) });
				const bytes = new Uint8Array(Buffer.from(data, "base64"));
				offset += bytes.byteLength;
				return { bytes, done: bytes.byteLength === 0 || offset >= Math.min(size, end) };
			};
			// The first part is read now, so a missing file fails here and not in the stream; the rest as part of the same request, or the same person's read.
			const later = AsyncLocalStorage.snapshot();
			const first = await read();
			let done = first.done;
			return new ReadableStream<Uint8Array>({
				start(controller) {
					if (first.bytes.byteLength > 0) controller.enqueue(first.bytes);
					if (done) controller.close();
				},
				async pull(controller) {
					const next = await later(read);
					done = next.done;
					if (next.bytes.byteLength > 0) controller.enqueue(next.bytes);
					if (done) controller.close();
				},
			});
		},
		writeFile: async (path: string, content: Uint8Array | string, options: { mode?: number } = {}): Promise<void> => {
			const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
			const mode = options.mode === undefined ? {} : { mode: options.mode };
			if (bytes.byteLength <= CHUNK_BYTES) {
				await this.call("write", { path, data: Buffer.from(bytes).toString("base64"), ...mode });
				return;
			}
			// In parts, to a file beside it that takes its place once whole.
			const slash = path.lastIndexOf("/");
			const temporary = `${path.slice(0, slash)}/.${path.slice(slash + 1)}.pim-${crypto.randomUUID()}`;
			try {
				for (let start = 0; start < bytes.byteLength; start += CHUNK_BYTES) {
					const data = Buffer.from(bytes.subarray(start, start + CHUNK_BYTES)).toString("base64");
					await this.call("write", { path: temporary, data, append: start > 0, ...mode });
				}
				await this.call("rename", { from: temporary, to: path });
			} catch (error) {
				await this.call("rm", { path: temporary, force: true }).catch(() => undefined);
				throw error;
			}
		},
		mkdir: async (path: string, options: { recursive?: boolean } = {}): Promise<void> => {
			await this.call("mkdir", { path, recursive: options.recursive === true });
		},
		rm: async (path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> => {
			await this.call("rm", { path, recursive: options.recursive === true, force: options.force === true });
		},
		readdir: (path: string, options: { limit?: number; offset?: number } = {}) =>
			this.call<{ name: string; size: number; mtime: number; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[]>("readdir", { path, ...options }),
		find: (directory: string, pattern?: string, options: { limit?: number; offset?: number; exclude?: string[] } = {}) =>
			this.call<{ path: string; type: "file" | "dir" }[]>("find", { path: directory, pattern, ...options }),
		grep: (
			query: string,
			path: string,
			options: { regex?: boolean; ignoreCase?: boolean; context?: number; limit?: number; offset?: number; include?: string; exclude?: string[] } = {},
		) =>
			this.call<{ path: string; line: number; text: string; context?: { line: number; text: string; isMatch: boolean }[] }[]>("grep", {
				query,
				path,
				...options,
			}),
	};
}
