import { bridgeAddress, type CuaBridge, SPACE_HEADER } from "./cua";

/**
 * Pim's client to a Cua bridge's viewer host (docs/cua-viewer-first-preview.md):
 * the three management calls of the host's launch manager, and the address
 * the person's browser opens a launch's viewer at. Nothing in a deployment
 * calls it: only the preview composes it (preview/worker.ts).
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
 * The viewer itself, its page, files, calls and media socket, goes from the
 * person's browser straight to the host (`viewerUrl`), never through the
 * Worker: Pim carries none of it, and no bridge token or Pim credential goes
 * with it. What opens it there is the launch's own credential, in the
 * viewer address's fragment, which the host checks on every call and
 * exchanges for the media socket's attach token.
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
/** The host's own refusals before it reads a request: bad method, path, headers, token, space, type or size. Nothing was done for it. */
export const REFUSED_BEFORE_ACTING: ReadonlySet<number> = new Set([400, 401, 403, 404, 405, 413, 415]);

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

/** Lets go of an answer that came after Pim stopped waiting for it: its body cancelled, not awaited. */
function abandon(late: Promise<Response>, what: string): void {
	late.then(
		(response) => void discardBody(response.body, what),
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

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const log = (event: string, detail: Record<string, unknown> = {}) => console.error(JSON.stringify({ event, ...detail }));

// ---------------------------------------------------------------- the client

/** Bounds a client is made with; tests shorten them. */
export type ClientLimits = { readonly manageMs: number };

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
		this.#limits = { manageMs: MANAGE_MS, ...limits };
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
	 * The address the person's browser opens the launch's viewer at, directly
	 * on the host: the bridge's checked HTTPS origin and the viewer path the
	 * host answered, which must be exactly the adapter's for `launchId`
	 * (`/<launchId>/viewer/#ticket=<43 characters>&clipboard=0`). Nothing
	 * else of the host's answer, and no other host, goes into it. Its fragment
	 * is the launch's credential: the caller hands it to the person's browser
	 * for that answer only, and neither stores nor logs it.
	 */
	viewerUrl(launchId: string, viewerPath: string): string {
		if (!LAUNCH_ID.test(launchId) || !viewerPathOf(launchId).test(viewerPath)) throw new RangeError("The host's viewer path is not the adapter's.");
		return this.#origin + viewerPath;
	}
}
