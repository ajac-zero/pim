import { bridgeAddress, type CuaBridge, SPACE_HEADER } from "./cua";
import { OBSERVATION_MEDIA_PROTOCOL } from "./cua-observation";

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
 * bodies are bounded both ways, and the media socket is relayed message by
 * message within the adapter's own bounds until the observation's deadline.
 * Each is tied to the observation's cancellation, and admitted again after
 * the host answers and before anything reaches the browser (`Watch`).
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
	| { readonly kind: "lost"; readonly reason: "timeout" | "unreachable" | "redirect" | "status" | "malformed" };

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
/** The most a text message from the browser's media socket may be, as the adapter's `MAX_BROWSER_CONTROL_BYTES`. */
export const MAX_BROWSER_MEDIA_TEXT_BYTES = 1024;
/** The most a text message from the host's media socket may be, as the adapter's `MAX_MEDIA_CONTROL_BYTES`. */
export const MAX_HOST_MEDIA_TEXT_BYTES = 64 * 1024;
/** The most a media packet may be, as the adapter's `MAX_MEDIA_PACKET_BYTES`. */
export const MAX_MEDIA_PACKET_BYTES = 16 * 1024 * 1024;

/** The host's own refusals before it reads a request: bad method, path, headers, token, space, type or size. Nothing was done for it. */
export const REFUSED_BEFORE_ACTING: ReadonlySet<number> = new Set([400, 401, 403, 404, 405, 413, 415]);

/** Where the host serves a launch's files and calls: `/<launch id>/…`, a launch id being 22 characters. */
const ADAPTER_TARGET = /^\/[A-Za-z0-9_-]{22}\//;
/** The one media target the host takes: `/<launch id>/media?ticket=<43-character attach token>`. */
const MEDIA_TARGET = /^\/[A-Za-z0-9_-]{22}\/media\?ticket=[A-Za-z0-9_-]{43}$/;
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

// ---------------------------------------------------------------- bodies

/** A body read whole, or `null` when it has more than `max` bytes or fails. */
export async function readBounded(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
	if (!body) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > max) {
				await reader.cancel().catch(() => undefined);
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}
	const whole = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		whole.set(chunk, at);
		at += chunk.byteLength;
	}
	return whole;
}

/** `body`, passed on as it arrives, failing once it has had more than `max` bytes (no limit for `null`). */
function capped(body: ReadableStream<Uint8Array>, max: number | null): ReadableStream<Uint8Array> {
	let size = 0;
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			size += chunk.byteLength;
			if (max !== null && size > max) {
				controller.error(new Error("The desktop's answer was too big."));
				return;
			}
			controller.enqueue(chunk);
		},
	});
	// A failure here reaches the browser as its read failing; nothing more is owed to it.
	body.pipeTo(writable).catch(() => undefined);
	return readable;
}

const plain = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const log = (event: string, detail: Record<string, unknown> = {}) => console.error(JSON.stringify({ event, ...detail }));

// ---------------------------------------------------------------- the client

export class CuaViewerClient {
	readonly #bridge: CuaBridge;
	readonly #space: string;
	readonly #fetch: typeof fetch;
	/** `https://host`: where the viewer's launches are, at the root. */
	readonly #origin: string;
	/** `https://host/<bridge path>`, without a trailing slash: where management is. */
	readonly #base: string;

	/** Checks the bridge as `Cua.connect` does, before anything is sent; throws its `HttpError` otherwise. `fetcher` is the Worker's `fetch`; tests give their own. */
	constructor(bridge: CuaBridge, space: string, fetcher: typeof fetch = fetch) {
		const url = bridgeAddress(bridge, space);
		this.#bridge = bridge;
		this.#space = space;
		this.#fetch = fetcher;
		this.#origin = url.origin;
		this.#base = url.origin + url.pathname.replace(/\/+$/, "");
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

	async #manage<T>(action: "launch" | "end" | "status", request: object, parse: (value: unknown) => T | undefined): Promise<HostReply<T>> {
		const body = JSON.stringify(request);
		if (byteLength(body) > MAX_MANAGE_REQUEST_BYTES) throw new RangeError("A management request is too big to send.");
		const giveUp = new AbortController();
		const timer = setTimeout(() => giveUp.abort(), MANAGE_MS);
		const lost = (reason: Extract<HostReply<T>, { kind: "lost" }>["reason"]): HostReply<T> => {
			log("cua.viewer.lost", { action, reason });
			return { kind: "lost", reason };
		};
		try {
			let response: Response;
			try {
				response = await this.#fetch(`${this.#base}/observations/${action}`, {
					method: "POST",
					headers: { Authorization: `Bearer ${this.#bridge.token}`, [SPACE_HEADER]: this.#space, "content-type": "application/json" },
					body,
					redirect: "manual",
					signal: giveUp.signal,
				});
			} catch {
				// What was thrown may carry anything, the token included: only what happened is told.
				return lost(giveUp.signal.aborted ? "timeout" : "unreachable");
			}
			if (response.status !== 200) {
				await response.body?.cancel().catch(() => undefined);
				if (response.status >= 300 && response.status < 400) return lost("redirect");
				if (REFUSED_BEFORE_ACTING.has(response.status)) {
					log("cua.viewer.refused", { action, status: response.status });
					return { kind: "refused", status: response.status };
				}
				return lost("status");
			}
			// The host answers exactly `application/json`; anything else isn't its answer.
			if (response.headers.get("content-type") !== "application/json") {
				await response.body?.cancel().catch(() => undefined);
				return lost("malformed");
			}
			const bytes = await readBounded(response.body, MAX_REPLY_BYTES);
			if (giveUp.signal.aborted) return lost("timeout");
			if (!bytes) return lost("malformed");
			let value: unknown;
			try {
				value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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
	 * what the adapter answered, bounded. The presence stream lasts until
	 * `notAfter` at most. `cancel` ends it, at any point, when the
	 * observation stops being admitted.
	 */
	async viewer(target: string, request: Request, kind: "file" | "call", watch: Watch): Promise<Response> {
		// The host serves the adapter's files to GET and its calls to POST only, at `/<22 characters>/…`, with no query.
		if (!ADAPTER_TARGET.test(target) || target.includes("?")) return plain(404);
		if (request.method !== (kind === "file" ? "GET" : "POST")) {
			await request.body?.cancel().catch(() => undefined);
			return plain(405);
		}
		const headers = new Headers();
		let body: Uint8Array | undefined;
		if (kind === "call") {
			for (const name of CALL_HEADERS) {
				const value = request.headers.get(name);
				if (value !== null) headers.set(name, value);
			}
			const length = request.headers.get("content-length");
			if (length !== null && !(Number(length) <= MAX_CALL_REQUEST_BYTES)) return plain(413);
			const read = await readBounded(request.body, MAX_CALL_REQUEST_BYTES);
			if (!read) return plain(413);
			body = read;
		} else {
			await request.body?.cancel().catch(() => undefined);
		}
		const stream = kind === "call" && target.endsWith(`/${PRESENCE_JOIN}`);
		const left = watch.notAfter - (watch.now ?? Date.now());
		if (left <= 0 || watch.cancel.aborted) return plain(404);
		const giveUp = new AbortController();
		const headersDue = setTimeout(() => giveUp.abort(), VIEWER_MS);
		// A file or call has `VIEWER_MS` in all; the presence stream, until the deadline; any of them, until the observation is cancelled.
		const signal = AbortSignal.any([giveUp.signal, watch.cancel, AbortSignal.timeout(stream ? left : Math.min(left, VIEWER_MS))]);
		let response: Response;
		try {
			response = await this.#fetch(this.#origin + target, { method: request.method, headers, ...(body ? { body } : {}), redirect: "manual", signal });
		} catch {
			log("cua.viewer.unreachable", { kind });
			return plain(watch.cancel.aborted ? 404 : signal.aborted ? 504 : 502);
		} finally {
			clearTimeout(headersDue);
		}
		// Admitted before it was sent is not admitted now: what came back while the observation ended is dropped.
		if (watch.cancel.aborted || !watch.admitted()) {
			await response.body?.cancel().catch(() => undefined);
			return plain(404);
		}
		if (!VIEWER_STATUSES.has(response.status)) {
			await response.body?.cancel().catch(() => undefined);
			log("cua.viewer.refused", { kind, status: response.status });
			return plain(502);
		}
		const answer = new Headers();
		for (const name of ANSWER_HEADERS) {
			const value = response.headers.get(name);
			if (value !== null) answer.set(name, value);
		}
		const max = kind === "file" ? MAX_FILE_BYTES : stream ? null : MAX_CALL_REPLY_BYTES;
		const passed = response.body ? capped(response.body, max) : null;
		return new Response(passed, { status: response.status, headers: answer });
	}

	/**
	 * Opens the media socket at `target` (`/<hostLaunchId>/media?ticket=…`,
	 * built by `admitObservationRequest`), offering only `rcdp.v2`, and
	 * answers the browser's side of a relay to it, or a refusal.
	 *
	 * Nothing is handed to the browser until the observation is admitted
	 * again after the host's socket opened: one cancelled or no longer
	 * admitted by then (an end requested, a lost answer, the deadline) has
	 * its socket closed, and the browser gets `404`. A cancellation while the
	 * host is being asked aborts the request. Once relayed, a cancellation
	 * ends both sides.
	 */
	async media(target: string, watch: Watch): Promise<Response> {
		// The host takes media upgrades only at exactly `/<22 characters>/media?ticket=<43 characters>`.
		if (!MEDIA_TARGET.test(target)) return plain(404);
		const left = watch.notAfter - (watch.now ?? Date.now());
		if (left <= 0 || watch.cancel.aborted) return plain(404);
		const giveUp = new AbortController();
		const timer = setTimeout(() => giveUp.abort(), VIEWER_MS);
		const signal = AbortSignal.any([giveUp.signal, watch.cancel]);
		let response: Response;
		try {
			// No `Authorization`: the attach token in the target is the adapter's to check, and the bridge's token never goes to a viewer route.
			response = await this.#fetch(this.#origin + target, {
				headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": OBSERVATION_MEDIA_PROTOCOL },
				redirect: "manual",
				signal,
			});
		} catch {
			log("cua.viewer.unreachable", { kind: "media" });
			return plain(watch.cancel.aborted ? 404 : giveUp.signal.aborted ? 504 : 502);
		} finally {
			clearTimeout(timer);
		}
		const upstream = response.webSocket;
		const protocol = response.headers.get("sec-websocket-protocol");
		const refuse = async (status: number) => {
			if (upstream) {
				try {
					upstream.accept();
					upstream.close(1008, "Refused");
				} catch {
					// It ends by itself.
				}
			}
			await response.body?.cancel().catch(() => undefined);
			return plain(status);
		};
		if (signal.aborted || !watch.admitted()) return refuse(signal.aborted && !watch.cancel.aborted ? 504 : 404);
		// The adapter completes only with `rcdp.v2`; whether the platform shows the header on a `101` is not known, so only another value refuses.
		if (response.status !== 101 || !upstream || (protocol !== null && protocol !== OBSERVATION_MEDIA_PROTOCOL)) {
			log("cua.viewer.refused", { kind: "media", status: response.status });
			return refuse(response.status === 400 || response.status === 401 || response.status === 404 ? response.status : 502);
		}
		upstream.accept();
		const { 0: client, 1: browser } = new WebSocketPair();
		browser.accept();
		relayMedia(browser, upstream, watch.notAfter - (watch.now ?? Date.now()), watch.cancel);
		return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": OBSERVATION_MEDIA_PROTOCOL } });
	}
}

/** What a viewer request is carried under: the observation's deadline, its cancellation, and a check that it is still admitted. */
export type Watch = {
	readonly notAfter: number;
	readonly now?: number;
	/** Aborts when the observation stops being admitted: its record leaves `open`, or the ledger is blocked. */
	readonly cancel: AbortSignal;
	/** Whether the observation is admitted now, read again after the host answered and before anything is handed on. */
	readonly admitted: () => boolean;
};

/** A close code one side may send on: the other side's own, when it is one a socket may send, or `1011`; `1000` when there was none. */
function passedCode(code: number | undefined): number {
	if (code === undefined || code === 1005) return 1000;
	if (code === 1000 || code === 1001 || code === 1003 || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999)) return code;
	return 1011;
}

/**
 * Relays one media socket between the browser and the host, until either
 * closes, `lifetimeMs` passes or `cancel` aborts. Up go only text messages within the
 * adapter's bound for the browser (it rebuilds or refuses each); down go text
 * and packets within its bounds. Anything else ends both sides with `1008`
 * or `1009`. Workers' sockets say nothing of what they hold unsent, so this
 * can't apply backpressure: a browser far behind is the host's to end
 * (`MAX_BROWSER_BUFFERED_BYTES`), as it sees its own socket back up.
 */
export function relayMedia(browser: WebSocket, upstream: WebSocket, lifetimeMs: number, cancel?: AbortSignal): void {
	let ended = false;
	const shut = (socket: WebSocket, code: number, reason: string) => {
		try {
			if (socket.readyState !== WebSocket.CLOSED) socket.close(code, reason);
		} catch {
			// It ends by itself.
		}
	};
	const end = (code: number, reason: string) => {
		if (ended) return;
		ended = true;
		clearTimeout(deadline);
		cancel?.removeEventListener("abort", cancelled);
		shut(browser, code, reason);
		shut(upstream, code, reason);
	};
	const cancelled = () => end(1000, "Observation ended");
	const deadline = setTimeout(cancelled, Math.max(0, lifetimeMs));
	if (cancel?.aborted) return cancelled();
	cancel?.addEventListener("abort", cancelled, { once: true });
	browser.addEventListener("message", (event) => {
		if (ended) return;
		if (typeof event.data !== "string") return end(1008, "Only text from the viewer");
		if (byteLength(event.data) > MAX_BROWSER_MEDIA_TEXT_BYTES) return end(1009, "Message too big");
		try {
			upstream.send(event.data);
		} catch {
			end(1011, "Error");
		}
	});
	upstream.addEventListener("message", (event) => {
		if (ended) return;
		const data = event.data as string | ArrayBuffer;
		if (typeof data === "string" ? byteLength(data) > MAX_HOST_MEDIA_TEXT_BYTES : data.byteLength > MAX_MEDIA_PACKET_BYTES) return end(1009, "Message too big");
		try {
			browser.send(data);
		} catch {
			end(1011, "Error");
		}
	});
	browser.addEventListener("close", (event) => end(passedCode(event.code), "Closed"));
	upstream.addEventListener("close", (event) => end(passedCode(event.code), "Closed"));
	browser.addEventListener("error", () => end(1011, "Error"));
	upstream.addEventListener("error", () => end(1011, "Error"));
}
