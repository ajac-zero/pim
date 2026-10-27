import { bridgeAddress, type CuaBridge, SPACE_HEADER } from "./cua";

/**
 * Pim's client to a Cua bridge's viewer host (docs/cua-viewer-first-preview.md):
 * the three management calls of the host's launch manager, and the browser's
 * requests to one launch's view-only viewer, carried through. Nothing in a
 * deployment calls it: only the preview composes it (preview/worker.ts).
 *
 * Management goes to `POST <bridge path>/observations/{launch,end,status}`
 * with the bridge's bearer token and `x-pim-space`, as `Cua.connect` sends
 * them, after the same checks (`bridgeAddress`): HTTPS, no credentials,
 * query or fragment, a well-formed token, and a bridge for exactly this
 * space. Each call is one request, given up on after `MANAGE_MS`, with no
 * redirect followed and nothing tried again. Its answer must be `200`,
 * JSON, at most `MAX_REPLY_BYTES`, and exactly one of the launch manager's
 * answers (computer/cua-host/viewer-launch-manager.ts), field for field;
 * anything else is `lost`, never read as what it might mean. Only a refusal
 * the host makes before reading the request (`REFUSED_BEFORE_ACTING`) says
 * the host did nothing.
 *
 * The viewer's requests go to `/<hostLaunchId>/…` at the bridge's origin,
 * which only the launch's own credential opens there: the bridge's token
 * never goes on them. Only the headers the host adapter reads are carried,
 * and bodies are bounded both ways. Each is tied to the observation's
 * cancellation, and admitted again after the host answers and before
 * anything reaches the browser (`Watch`).
 *
 * The media socket is not carried at all. A relay in the Worker reads the
 * host's socket as fast as it comes, and a Worker's socket shows nothing of
 * what it holds unsent to a slow browser, so the Worker would buffer without
 * bound, and the host, which sees only its own socket to the Worker, would
 * never see it back up. Until a relay with a bound the platform supports
 * exists, the desk refuses media before anything is sent
 * (./cua-observation-runtime.ts).
 * This is not a proxy: the caller passes only a target that
 * `admitObservationRequest` (./cua-observation.ts) built.
 *
 * Nothing is logged but fixed event names: never a target, token, viewer
 * path or anything the host said.
 */

// ---------------------------------------------------------------- the host's types

/*
 * The launch manager's requests and answers, as
 * computer/cua-host/viewer-launch-manager.ts declares them. They are copied
 * here, not imported, because the Worker doesn't load the Node host's
 * modules; `parseLaunchAnswer` and its siblings check them field for field.
 */

export type LaunchRequestKey = { readonly key: string; readonly owner: string; readonly notAfter: number; readonly displayName?: string };
export type KeyRequest = { readonly owner: string; readonly key: string; readonly generation: string };

export type EntryState = "intent" | "open" | "ending" | "unconfirmed" | "closed_observed" | "start_failed" | "reconciled";
export type LaunchRefusal = "invalid" | "blocked" | "conflict" | "no_credential" | "invalid_deadline" | "limit" | "storage" | "closed";

export type LaunchAnswer =
	| {
			readonly outcome: "launched";
			readonly key: string;
			readonly launchId: string;
			readonly generation: string;
			readonly notAfter: number;
			readonly viewerPath: string;
			readonly replayed: boolean;
	  }
	| { readonly outcome: "refused"; readonly reason: LaunchRefusal }
	| { readonly outcome: "start_failed"; readonly key: string }
	| { readonly outcome: "unconfirmed"; readonly key: string; readonly reason: "timeout" | "storage" | "ended" | "earlier_generation" | "unconfirmed" };

/** A read of a launch, as the adapter's `LaunchHandle.status()` answers it. */
export type LaunchSnapshot = {
	readonly phase: "live" | "closing" | "closed";
	readonly reason: "expired" | "ended" | "clock" | "timer" | null;
	readonly remainingMs: number;
	readonly transports: { readonly "media-viewer": number; readonly "media-upstream": number; readonly "presence-rpc": number };
	readonly refused: number;
	readonly closeFailures: number;
	readonly sessions: number;
	readonly unconfirmed: number;
	readonly cleanup: { readonly requested: number; readonly answered: number; readonly failed: number };
};

export type EndAnswer =
	| { readonly outcome: "not_found" }
	| { readonly outcome: "generation_mismatch"; readonly generation: string }
	| { readonly outcome: "requested"; readonly recorded: boolean }
	| { readonly outcome: "unconfirmed" }
	| { readonly outcome: "final"; readonly state: EntryState };

export type StatusAnswer =
	| { readonly outcome: "not_found" }
	| { readonly outcome: "generation_mismatch"; readonly generation: string }
	| {
			readonly outcome: "found";
			readonly key: string;
			readonly state: EntryState;
			readonly generation: string;
			readonly launchId: string | null;
			readonly notAfter: number;
			readonly evidence: string | null;
			readonly launch: LaunchSnapshot | null;
	  };

/** What one management call came to. */
export type HostReply<T> =
	/** The host answered, and the answer is one the manager gives. */
	| { readonly kind: "answer"; readonly answer: T }
	/** The host refused before reading the request (`REFUSED_BEFORE_ACTING`): it did nothing for it. */
	| { readonly kind: "refused"; readonly status: number }
	/** No answer Pim can read: the host may or may not have acted. */
	| { readonly kind: "lost"; readonly reason: "timeout" | "unreachable" | "redirect" | "status" | "malformed" }
	/**
	 * `503`: the host's manager isn't taking calls (shutting down, or it
	 * threw), and the host said when to ask again (`retryAfter`, seconds, or
	 * null). What it did for this request is not said, so for a launch or an
	 * end it is read as lost. Nothing here asks again by itself.
	 */
	| { readonly kind: "unavailable"; readonly retryAfter: number | null };

// ---------------------------------------------------------------- bounds

/** How long a management call has, in all. Above the manager's 15 s start timeout, after which it answers `unconfirmed` itself. */
export const MANAGE_MS = 25_000;
/** The most a management request's body may be: the host refuses more than 4096 bytes. */
export const MAX_MANAGE_REQUEST_BYTES = 4096;
/** The most a management answer may be; a status answer is a few hundred bytes. */
export const MAX_REPLY_BYTES = 16 * 1024;
/** How long a viewer request has for its answer's headers, and a file or call for its whole body. */
export const VIEWER_MS = 30_000;
/** The most a viewer call's body may be, as the adapter's `MAX_REQUEST_BYTES`. */
export const MAX_CALL_REQUEST_BYTES = 4 * 1024;
/** The most one of the viewer's files may be: the largest pinned one, `viewer.js`, is about 253 KiB. */
export const MAX_FILE_BYTES = 512 * 1024;
/** The most a unary call's answer may be: the adapter's 256 KiB, its frame headers and its trailer. */
export const MAX_CALL_REPLY_BYTES = 256 * 1024 + 1024;

/** The host's own refusals before it reads a request: bad method, path, headers, token, space, type or size. Nothing was done for it. */
export const REFUSED_BEFORE_ACTING: ReadonlySet<number> = new Set([400, 401, 403, 404, 405, 413, 415]);

/** Where the host serves a launch's files and calls: `/<launch id>/…`, a launch id being 22 characters. */
const ADAPTER_TARGET = /^\/[A-Za-z0-9_-]{22}\//;
/** The presence call, the one call whose answer is a stream: it lasts until the observation's deadline, frame-bounded by the adapter. */
const PRESENCE_JOIN = "cua.env.v1.PresenceService/Join";
/** The request headers the adapter reads of a call; nothing else is carried, the bridge's or the browser's `Authorization` least of all. */
const CALL_HEADERS = ["content-type", "x-cua-env-authorization", "grpc-encoding", "content-encoding"] as const;
/** The answer headers the browser may see: those the adapter sets on files and calls. */
const ANSWER_HEADERS = ["content-type", "grpc-status", "grpc-message", "content-security-policy", "cross-origin-resource-policy", "x-content-type-options", "referrer-policy"] as const;
/** The adapter's answers passed on as they are; any other becomes `502`. */
const VIEWER_STATUSES: ReadonlySet<number> = new Set([200, 400, 401, 404, 405, 413, 415]);

// ---------------------------------------------------------------- strict answers

const KEY = /^[A-Za-z0-9_-]{16,64}$/;
/** A launch id, as the adapter mints it: 16 random bytes in base64url. */
const LAUNCH_ID = /^[A-Za-z0-9_-]{22}$/;
const STATES: readonly string[] = ["intent", "open", "ending", "unconfirmed", "closed_observed", "start_failed", "reconciled"];
const REFUSALS: readonly string[] = ["invalid", "blocked", "conflict", "no_credential", "invalid_deadline", "limit", "storage", "closed"];
const UNCONFIRMED: readonly string[] = ["timeout", "storage", "ended", "earlier_generation", "unconfirmed"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isKey = (value: unknown): value is string => typeof value === "string" && KEY.test(value);
const oneOf = (value: unknown, values: readonly string[]): value is string => typeof value === "string" && values.includes(value);
/** A plain object with exactly `keys`, no more and no fewer. */
const exactly = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
	isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** The viewer page the adapter answers for `launchId`: its path and, in the fragment, the launch's credential. */
export const viewerPathOf = (launchId: string) => new RegExp(`^/${launchId}/viewer/#ticket=[A-Za-z0-9_-]{43}&clipboard=0$`);

export function parseLaunchAnswer(value: unknown): LaunchAnswer | undefined {
	if (!isRecord(value)) return undefined;
	switch (value.outcome) {
		case "launched": {
			if (!exactly(value, ["outcome", "key", "launchId", "generation", "notAfter", "viewerPath", "replayed"])) return undefined;
			const { key, launchId, generation, notAfter, viewerPath, replayed } = value;
			if (!isKey(key) || typeof launchId !== "string" || !LAUNCH_ID.test(launchId) || !isName(generation) || !isTime(notAfter)) return undefined;
			if (typeof viewerPath !== "string" || !viewerPathOf(launchId).test(viewerPath) || typeof replayed !== "boolean") return undefined;
			return { outcome: "launched", key, launchId, generation, notAfter, viewerPath, replayed };
		}
		case "refused":
			return exactly(value, ["outcome", "reason"]) && oneOf(value.reason, REFUSALS) ? { outcome: "refused", reason: value.reason as LaunchRefusal } : undefined;
		case "start_failed":
			return exactly(value, ["outcome", "key"]) && isKey(value.key) ? { outcome: "start_failed", key: value.key } : undefined;
		case "unconfirmed":
			return exactly(value, ["outcome", "key", "reason"]) && isKey(value.key) && oneOf(value.reason, UNCONFIRMED)
				? { outcome: "unconfirmed", key: value.key, reason: value.reason as Extract<LaunchAnswer, { outcome: "unconfirmed" }>["reason"] }
				: undefined;
		default:
			return undefined;
	}
}

export function parseEndAnswer(value: unknown): EndAnswer | undefined {
	if (!isRecord(value)) return undefined;
	switch (value.outcome) {
		case "not_found":
		case "unconfirmed":
			return exactly(value, ["outcome"]) ? { outcome: value.outcome } : undefined;
		case "generation_mismatch":
			return exactly(value, ["outcome", "generation"]) && isName(value.generation) ? { outcome: "generation_mismatch", generation: value.generation } : undefined;
		case "requested":
			return exactly(value, ["outcome", "recorded"]) && typeof value.recorded === "boolean" ? { outcome: "requested", recorded: value.recorded } : undefined;
		case "final":
			return exactly(value, ["outcome", "state"]) && oneOf(value.state, STATES) ? { outcome: "final", state: value.state as EntryState } : undefined;
		default:
			return undefined;
	}
}

function parseSnapshot(value: unknown): LaunchSnapshot | undefined {
	const keys = ["phase", "reason", "remainingMs", "transports", "refused", "closeFailures", "sessions", "unconfirmed", "cleanup"];
	if (!exactly(value, keys)) return undefined;
	const { phase, reason, remainingMs, transports, refused, closeFailures, sessions, unconfirmed, cleanup } = value;
	if (!oneOf(phase, ["live", "closing", "closed"]) || !(reason === null || oneOf(reason, ["expired", "ended", "clock", "timer"]))) return undefined;
	if (!isCount(remainingMs) || !isCount(refused) || !isCount(closeFailures) || !isCount(sessions) || !isCount(unconfirmed)) return undefined;
	if (!exactly(transports, ["media-viewer", "media-upstream", "presence-rpc"]) || !Object.values(transports).every(isCount)) return undefined;
	if (!exactly(cleanup, ["requested", "answered", "failed"]) || !Object.values(cleanup).every(isCount)) return undefined;
	return {
		phase: phase as LaunchSnapshot["phase"],
		reason: reason as LaunchSnapshot["reason"],
		remainingMs,
		transports: { "media-viewer": transports["media-viewer"] as number, "media-upstream": transports["media-upstream"] as number, "presence-rpc": transports["presence-rpc"] as number },
		refused,
		closeFailures,
		sessions,
		unconfirmed,
		cleanup: { requested: cleanup.requested as number, answered: cleanup.answered as number, failed: cleanup.failed as number },
	};
}

export function parseStatusAnswer(value: unknown): StatusAnswer | undefined {
	if (!isRecord(value)) return undefined;
	switch (value.outcome) {
		case "not_found":
			return exactly(value, ["outcome"]) ? { outcome: "not_found" } : undefined;
		case "generation_mismatch":
			return exactly(value, ["outcome", "generation"]) && isName(value.generation) ? { outcome: "generation_mismatch", generation: value.generation } : undefined;
		case "found": {
			if (!exactly(value, ["outcome", "key", "state", "generation", "launchId", "notAfter", "evidence", "launch"])) return undefined;
			const { key, state, generation, launchId, notAfter, evidence } = value;
			if (!isKey(key) || !oneOf(state, STATES) || !isName(generation) || !isTime(notAfter)) return undefined;
			if (!(launchId === null || (typeof launchId === "string" && LAUNCH_ID.test(launchId)))) return undefined;
			if (!(evidence === null || (typeof evidence === "string" && evidence.trim() !== "" && evidence.length <= 1024))) return undefined;
			const launch = value.launch === null ? null : parseSnapshot(value.launch);
			if (launch === undefined) return undefined;
			return { outcome: "found", key, state: state as EntryState, generation, launchId, notAfter, evidence, launch };
		}
		default:
			return undefined;
	}
}

// ---------------------------------------------------------------- waits

/** How long a cancel of a body Pim holds may take to be seen; past it, it is left, and logged as unsettled. */
export const CLEANUP_MS = 1_000;

/** How a wait ended: its value, its rejection, or the signal or bound that stopped it first. */
type Settled<T> = { readonly kind: "value"; readonly value: T } | { readonly kind: "error" } | { readonly kind: "stopped" };

/**
 * Waits for `promise` until `signal` aborts or `ms` passes, whichever comes
 * first. It leaves no timer or listener behind: both are removed the moment
 * any of the three settles. A promise that never settles is left to itself,
 * holding nothing of this wait.
 */
export function settle<T>(promise: Promise<T>, signal: AbortSignal | null, ms: number | null): Promise<Settled<T>> {
	return new Promise((resolve) => {
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: Settled<T>) => {
			if (done) return;
			done = true;
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			resolve(result);
		};
		const stop = () => finish({ kind: "stopped" });
		if (signal?.aborted) return stop();
		signal?.addEventListener("abort", stop, { once: true });
		if (ms !== null) timer = setTimeout(stop, Math.max(0, ms));
		promise.then(
			(value) => finish({ kind: "value", value }),
			() => finish({ kind: "error" }),
		);
	});
}

/**
 * A signal that aborts when any of `sources` does, or `abort()` is called,
 * and `release()`, which removes what it added to the sources. Unlike
 * `AbortSignal.any`, nothing stays attached to a long-lived source (an
 * observation's cancellation) once a request is done.
 */
function linked(...sources: AbortSignal[]): { readonly signal: AbortSignal; readonly abort: () => void; readonly release: () => void } {
	const controller = new AbortController();
	const abort = () => controller.abort();
	for (const source of sources) {
		if (source.aborted) controller.abort();
		else source.addEventListener("abort", abort, { once: true });
	}
	return { signal: controller.signal, abort, release: () => sources.forEach((source) => source.removeEventListener("abort", abort)) };
}

/** Whether a cancel was seen to settle within `CLEANUP_MS`; one that wasn't is logged and left. */
async function cleaned(what: string, cancel: () => Promise<unknown>): Promise<boolean> {
	let started: Promise<unknown>;
	try {
		started = cancel();
	} catch {
		started = Promise.reject(new Error("cancel threw"));
	}
	const seen = await settle(started, null, CLEANUP_MS);
	if (seen.kind !== "value") log("cua.viewer.cleanup_unsettled", { what, outcome: seen.kind });
	return seen.kind === "value";
}

/** Cancels `reader` and releases its lock, waiting at most `CLEANUP_MS`; whether the cancel was seen to settle. */
async function discardReader(reader: ReadableStreamDefaultReader<Uint8Array>, what: string): Promise<boolean> {
	const settled = await cleaned(what, () => reader.cancel());
	try {
		reader.releaseLock();
	} catch {
		// A read still pending keeps the lock; the cancel above already ended the stream if it could.
	}
	return settled;
}

/** Cancels a body Pim won't read, waiting at most `CLEANUP_MS`; whether the cancel was seen to settle. */
async function discardBody(body: ReadableStream<Uint8Array> | null, what: string): Promise<boolean> {
	if (!body) return true;
	return cleaned(what, () => body.cancel());
}

/** Lets go of an answer that came after Pim stopped waiting for it: its socket closed, its body cancelled, neither awaited. */
function abandon(late: Promise<Response>, what: string): void {
	late.then(
		(response) => {
			if (response.webSocket) {
				try {
					response.webSocket.accept();
					response.webSocket.close(1008, "Too late");
				} catch {
					// It ends by itself.
				}
			}
			void discardBody(response.body, what);
		},
		() => undefined,
	);
}

// ---------------------------------------------------------------- bodies

/** A body read whole, or why not, and for a body left unread whether its cancel was seen to settle. */
export type BodyRead = { readonly kind: "read"; readonly bytes: Uint8Array } | { readonly kind: "too_big" | "stopped" | "failed"; readonly cleaned: boolean };

/**
 * Reads `body` whole, at most `max` bytes, each read raced against
 * `signal`: a read that stalls, or a body that never ends, stops when the
 * signal aborts, and the reader is cancelled (within `CLEANUP_MS`) and
 * released. Nothing here waits on the body after that.
 */
export async function readBounded(body: ReadableStream<Uint8Array> | null, max: number, signal: AbortSignal): Promise<BodyRead> {
	if (!body) return { kind: "read", bytes: new Uint8Array(0) };
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = body.getReader();
	} catch {
		return { kind: "failed", cleaned: false };
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const step = await settle(reader.read(), signal, null);
		if (step.kind !== "value") return { kind: step.kind === "stopped" ? "stopped" : "failed", cleaned: await discardReader(reader, "body") };
		if (step.value.done) break;
		size += step.value.value.byteLength;
		if (size > max) return { kind: "too_big", cleaned: await discardReader(reader, "body") };
		chunks.push(step.value.value);
	}
	try {
		reader.releaseLock();
	} catch {
		// Done reading: nothing is pending.
	}
	const whole = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		whole.set(chunk, at);
		at += chunk.byteLength;
	}
	return { kind: "read", bytes: whole };
}

/**
 * `body`, passed on as the browser reads it, failing once it has had more
 * than `max` bytes (no limit for `null`) or `signal` aborts. Each read of
 * the host's body is raced against `signal`, so a stalled one doesn't hold
 * the browser's. `ended` runs once, however it ends: done, failed, too big,
 * stopped, or cancelled by the browser.
 */
function passOn(body: ReadableStream<Uint8Array>, max: number | null, signal: AbortSignal, ended: () => void): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let size = 0;
	let finished = false;
	let output: ReadableStreamDefaultController<Uint8Array> | undefined;
	const finish = (error?: Error) => {
		if (finished) return;
		finished = true;
		signal.removeEventListener("abort", stopped);
		ended();
		if (error) {
			void discardReader(reader, "answer");
			try {
				output?.error(error);
			} catch {
				// Already closed or errored.
			}
		}
	};
	const stopped = () => finish(new Error("The observation ended."));
	return new ReadableStream<Uint8Array>({
		start(controller) {
			output = controller;
			if (signal.aborted) stopped();
			else signal.addEventListener("abort", stopped, { once: true });
		},
		async pull(controller) {
			if (finished) return;
			const step = await settle(reader.read(), signal, null);
			if (finished) return;
			if (step.kind !== "value") return finish(new Error("The desktop's answer ended."));
			if (step.value.done) {
				finish();
				try {
					reader.releaseLock();
				} catch {
					// Nothing is pending.
				}
				return controller.close();
			}
			size += step.value.value.byteLength;
			if (max !== null && size > max) return finish(new Error("The desktop's answer was too big."));
			controller.enqueue(step.value.value);
		},
		cancel() {
			if (finished) return;
			finished = true;
			signal.removeEventListener("abort", stopped);
			ended();
			void discardReader(reader, "answer");
		},
	});
}

const plain = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const log = (event: string, detail: Record<string, unknown> = {}) => console.error(JSON.stringify({ event, ...detail }));

// ---------------------------------------------------------------- the client

/** Bounds a client is made with; tests shorten them. */
export type ClientLimits = { readonly manageMs: number; readonly viewerMs: number };

export class CuaViewerClient {
	readonly #bridge: CuaBridge;
	readonly #space: string;
	readonly #fetch: typeof fetch;
	readonly #limits: ClientLimits;
	/** `https://host`: where the viewer's launches are, at the root. */
	readonly #origin: string;
	/** `https://host/<bridge path>`, without a trailing slash: where management is. */
	readonly #base: string;

	/** Checks the bridge as `Cua.connect` does, before anything is sent; throws its `HttpError` otherwise. `fetcher` is the Worker's `fetch`; tests give their own. */
	constructor(bridge: CuaBridge, space: string, fetcher: typeof fetch = fetch, limits: Partial<ClientLimits> = {}) {
		const url = bridgeAddress(bridge, space);
		this.#bridge = bridge;
		this.#space = space;
		this.#fetch = fetcher;
		this.#limits = { manageMs: MANAGE_MS, viewerMs: VIEWER_MS, ...limits };
		this.#origin = url.origin;
		this.#base = url.origin + url.pathname.replace(/\/+$/, "");
	}

	/** The fetcher's answer as a promise, even when it throws as it is called. */
	#send(url: string, init: RequestInit): Promise<Response> {
		try {
			return this.#fetch(url, init);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	launch(request: LaunchRequestKey): Promise<HostReply<LaunchAnswer>> {
		return this.#manage("launch", request, parseLaunchAnswer);
	}

	end(request: KeyRequest): Promise<HostReply<EndAnswer>> {
		return this.#manage("end", request, parseEndAnswer);
	}

	status(request: KeyRequest): Promise<HostReply<StatusAnswer>> {
		return this.#manage("status", request, parseStatusAnswer);
	}

	/**
	 * One management call, bounded by `manageMs` in all: the request, the
	 * answer's headers and every read of its body are raced against one
	 * timer, which is cleared however the call ends. An answer that comes
	 * after it is let go unread.
	 */
	async #manage<T>(action: "launch" | "end" | "status", request: object, parse: (value: unknown) => T | undefined): Promise<HostReply<T>> {
		const body = JSON.stringify(request);
		if (byteLength(body) > MAX_MANAGE_REQUEST_BYTES) throw new RangeError("A management request is too big to send.");
		const giveUp = new AbortController();
		const timer = setTimeout(() => giveUp.abort(), this.#limits.manageMs);
		const lost = (reason: Extract<HostReply<T>, { kind: "lost" }>["reason"]): HostReply<T> => {
			log("cua.viewer.lost", { action, reason });
			return { kind: "lost", reason };
		};
		try {
			const sent = this.#send(`${this.#base}/observations/${action}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.#bridge.token}`, [SPACE_HEADER]: this.#space, "content-type": "application/json" },
				body,
				redirect: "manual",
				signal: giveUp.signal,
			});
			const answered = await settle(sent, giveUp.signal, null);
			if (answered.kind === "stopped") {
				abandon(sent, "management");
				return lost("timeout");
			}
			// What was thrown may carry anything, the token included: only what happened is told.
			if (answered.kind === "error") return lost(giveUp.signal.aborted ? "timeout" : "unreachable");
			const response = answered.value;
			if (response.status !== 200) {
				await discardBody(response.body, "management");
				if (response.status >= 300 && response.status < 400) return lost("redirect");
				if (REFUSED_BEFORE_ACTING.has(response.status)) {
					log("cua.viewer.refused", { action, status: response.status });
					return { kind: "refused", status: response.status };
				}
				if (response.status === 503) {
					log("cua.viewer.unavailable", { action });
					const retry = response.headers.get("retry-after");
					return { kind: "unavailable", retryAfter: retry !== null && /^[0-9]{1,4}$/.test(retry) ? Number(retry) : null };
				}
				return lost("status");
			}
			// The host answers exactly `application/json`; anything else isn't its answer.
			if (response.headers.get("content-type") !== "application/json") {
				await discardBody(response.body, "management");
				return lost("malformed");
			}
			const read = await readBounded(response.body, MAX_REPLY_BYTES, giveUp.signal);
			if (read.kind === "stopped") return lost("timeout");
			if (read.kind !== "read") return lost("malformed");
			let value: unknown;
			try {
				value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
			} catch {
				return lost("malformed");
			}
			const answer = parse(value);
			return answer === undefined ? lost("malformed") : { kind: "answer", answer };
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Carries one of the viewer's file or call requests to `target`, which
	 * `admitObservationRequest` built (`/<hostLaunchId>/<rest>`), and answers
	 * what the adapter answered, bounded.
	 *
	 * The observation is admitted again (`live`) after the browser's body is
	 * read and immediately before the request leaves, and again when the
	 * host answers. Reading the body, waiting for the answer and passing the
	 * answer on all stop when the observation is cancelled or its deadline
	 * comes; a file or call also when `viewerMs` passes. The presence stream
	 * lasts until the deadline at most.
	 */
	async viewer(target: string, request: Request, kind: "file" | "call", watch: Watch): Promise<Response> {
		// The host serves the adapter's files to GET and its calls to POST only, at `/<22 characters>/…`, with no query.
		const wrongMethod = request.method !== (kind === "file" ? "GET" : "POST");
		if (!ADAPTER_TARGET.test(target) || target.includes("?") || wrongMethod || (kind === "file" && request.body)) {
			await discardBody(request.body, "request");
			return plain(wrongMethod ? 405 : 404);
		}
		if (!live(watch)) return plain(404);
		const stream = kind === "call" && target.endsWith(`/${PRESENCE_JOIN}`);
		const link = linked(watch.cancel);
		// One timer at a time bounds the whole request; it is replaced once the answer's headers come, and cleared when it ends.
		let timer = setTimeout(link.abort, Math.min(this.#limits.viewerMs, remaining(watch)));
		const started = watch.now();
		let handedOn = false;
		const done = () => {
			clearTimeout(timer);
			link.release();
		};
		try {
			const headers = new Headers();
			let body: Uint8Array | undefined;
			if (kind === "call") {
				for (const name of CALL_HEADERS) {
					const value = request.headers.get(name);
					if (value !== null) headers.set(name, value);
				}
				const length = request.headers.get("content-length");
				if (length !== null && !(Number(length) <= MAX_CALL_REQUEST_BYTES)) {
					await discardBody(request.body, "request");
					return plain(413);
				}
				const read = await readBounded(request.body, MAX_CALL_REQUEST_BYTES, link.signal);
				if (read.kind === "too_big") return plain(413);
				if (read.kind !== "read") return plain(watch.cancel.aborted || !live(watch) ? 404 : 408);
				body = read.bytes;
			}
			// Admitted when the request came isn't admitted now: the body's read was a wait.
			if (link.signal.aborted || !live(watch)) return plain(404);
			const sent = this.#send(this.#origin + target, { method: request.method, headers, ...(body ? { body } : {}), redirect: "manual", signal: link.signal });
			const answered = await settle(sent, link.signal, null);
			if (answered.kind !== "value") {
				if (answered.kind === "stopped") abandon(sent, "viewer");
				log("cua.viewer.unreachable", { kind });
				return plain(watch.cancel.aborted || !live(watch) ? 404 : link.signal.aborted ? 504 : 502);
			}
			const response = answered.value;
			// What came back while the observation stopped being admitted is dropped.
			if (link.signal.aborted || !live(watch)) {
				await discardBody(response.body, "viewer");
				return plain(404);
			}
			if (!VIEWER_STATUSES.has(response.status)) {
				await discardBody(response.body, "viewer");
				log("cua.viewer.refused", { kind, status: response.status });
				return plain(502);
			}
			const answer = new Headers();
			for (const name of ANSWER_HEADERS) {
				const value = response.headers.get(name);
				if (value !== null) answer.set(name, value);
			}
			if (!response.body) return new Response(null, { status: response.status, headers: answer });
			clearTimeout(timer);
			// A file or call keeps what is left of its `viewerMs`; the presence stream, what is left until the deadline.
			timer = setTimeout(link.abort, stream ? remaining(watch) : Math.min(this.#limits.viewerMs - (watch.now() - started), remaining(watch)));
			const max = kind === "file" ? MAX_FILE_BYTES : stream ? null : MAX_CALL_REPLY_BYTES;
			handedOn = true;
			return new Response(passOn(response.body, max, link.signal, done), { status: response.status, headers: answer });
		} finally {
			if (!handedOn) done();
		}
	}
}

/** What a viewer request is carried under: the observation's deadline and clock, its cancellation, and a check that it is still admitted. */
export type Watch = {
	readonly notAfter: number;
	/** The clock `notAfter` is read against, read anew after every wait. */
	readonly now: () => number;
	/** Aborts when the observation stops being admitted: its record leaves `open`, or the ledger is blocked. */
	readonly cancel: AbortSignal;
	/** Whether the observation is admitted now: read immediately before each request leaves and again after the host answers. */
	readonly admitted: () => boolean;
};

/** Milliseconds left until the deadline, read now. */
const remaining = (watch: Watch) => watch.notAfter - watch.now();
/** Whether the observation may still be carried: not cancelled, admitted, before its deadline, all read now. */
const live = (watch: Watch) => !watch.cancel.aborted && watch.admitted() && remaining(watch) > 0;
