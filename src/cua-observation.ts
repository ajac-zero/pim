/**
 * A space's record of its Cua display observations (docs/cua-observation.md),
 * and the check a future route would make before a browser reaches one.
 *
 * DECISION RECORD. An observation is a person watching one display of their
 * Cua computer through the view-only viewer adapter (docs/cua-viewer-adapter.md):
 * full display, `VIEW_ONLY`, `OBSERVE_ONLY`, no clipboard, files or
 * microphone. It is not a control viewer. `src/computer-control.ts` treats
 * every viewer session as input-capable and admits one only while the human
 * owns the application; that rule, and the control state's owner and epoch,
 * are untouched here. This ledger is separate: it imports nothing from the
 * control state and nothing reads it there, so an observation can't grant
 * input, claim a pause or takeover, change whether an agent request is
 * admitted, or settle a request whose outcome is unknown.
 *
 * Like the control state it is a pure reducer: it performs no I/O, starts no
 * timers, and calls nothing. Every outside fact (the host acknowledged a
 * launch, the host saw every transport close, a reply was lost) is evidence a
 * caller reports; the ledger can't check it. What it keeps apart:
 *
 * - Requested and observed. Asking the host to end a launch (`revoking`) is
 *   not closure. Only the host's report, for the launch and host generation
 *   this record names, that every transport it owned reported itself closed
 *   makes a record `closed_observed`. That is about network transports; it is
 *   not quiescence of the desktop.
 * - Lost and closed. A reply that never came, a timeout, a host restart or a
 *   host generation other than the one recorded makes a record `unconfirmed`,
 *   never closed. Only the host's observation, or an operator's reconciliation
 *   (`reconciled`, recorded as such), takes it out of `unconfirmed`.
 * - One identity per record. Its owner, id and `notAfter` are fixed when it is
 *   requested; its launch and host generation once acknowledged. Nothing moves
 *   `notAfter`, and a second, different acknowledgment makes the record
 *   `unconfirmed` rather than replacing the first. An id is never reused while
 *   its record is kept, and records are never evicted: at the limits, new
 *   observations are refused.
 *
 * It adds no route, tool, setting or storage, and importing it does nothing.
 * Only the preview's desk uses its ledger (./cua-observation-runtime.ts), and
 * nothing calls its admission check: the viewer goes from the person's
 * browser to the host directly (docs/cua-viewer-first-worker.md).
 */

export const OBSERVATION_STATE_VERSION = 1;

/** The longest an observation may be given from when it is requested, as the host's `MAX_LAUNCH_MS`. */
export const MAX_OBSERVATION_MS = 4 * 60 * 60 * 1000;

/** Records not yet final that a space may hold at once. A new observation is refused, never another evicted. */
export const MAX_UNRESOLVED_OBSERVATIONS = 2;

/** Records a space may hold in all, final ones included. Nothing retires them yet (docs/cua-observation.md). */
export const MAX_OBSERVATION_RECORDS = 32;

export type ObservationStatus =
	/** Recorded before the host is asked; whether the host started anything is not known yet. */
	| "pending_open"
	/** The host acknowledged a launch for it, in a host generation. */
	| "open"
	/** Its end was requested; nothing is known to have closed. */
	| "revoking"
	/** What the host holds for it is not known: a lost reply, a timeout, a restart, another generation. */
	| "unconfirmed"
	/** Final: the host reported that every transport of this launch, in this generation, reported itself closed. */
	| "closed_observed"
	/** Final: the host refused before starting anything for it. */
	| "not_opened"
	/** Final: an operator reconciled an unconfirmed record, with evidence. Not an observation. */
	| "reconciled";

const FINAL: readonly ObservationStatus[] = ["closed_observed", "not_opened", "reconciled"];

export interface ObservationRecord {
	readonly observationId: string;
	/** The space's owner, fixed. */
	readonly owner: string;
	/** Unix milliseconds Pim set when the observation was requested; nothing changes it. */
	readonly notAfter: number;
	/** The host's launch id, once acknowledged; never replaced. */
	readonly hostLaunchId: string | null;
	/** The host process generation that acknowledged it; never replaced. */
	readonly hostGeneration: string | null;
	readonly status: ObservationStatus;
	/** What the caller reported for the latest change that needed it. */
	readonly evidence?: string;
	/** Set when a second, different launch was acknowledged: only an operator's reconciliation settles the record then. */
	readonly conflicting?: true;
}

export interface ObservationState {
	readonly version: typeof OBSERVATION_STATE_VERSION;
	/** The space's owner. Every record has this owner. */
	readonly owner: string;
	readonly records: readonly ObservationRecord[];
}

export type ObservationEvent =
	| { type: "open_requested"; owner: string; observationId: string; notAfter: number; now: number }
	| { type: "open_acknowledged"; observationId: string; hostLaunchId: string; hostGeneration: string }
	| { type: "open_refused"; observationId: string; evidence: string }
	| { type: "unconfirmed"; observationId: string; evidence: string }
	| { type: "revoke_requested"; observationId: string }
	| { type: "closure_observed"; observationId: string; hostLaunchId: string; hostGeneration: string; evidence: string }
	| { type: "reconcile"; observationId: string; evidence: string };

export type ObservationRefusal =
	| "empty_value"
	| "wrong_owner"
	| "invalid_deadline"
	| "duplicate_id"
	| "limit"
	| "unknown_id"
	| "wrong_status"
	| "already_final"
	| "launch_mismatch"
	| "generation_mismatch"
	| "conflicting_launch";

export type ObservationOutcome = { ok: true } | { ok: false; reason: ObservationRefusal };

export interface ObservationResult {
	/**
	 * The next state: the same object when the event changes nothing. A
	 * refusal changes nothing, except `conflicting_launch`, which leaves the
	 * record `unconfirmed`, as a second launch may exist.
	 */
	readonly state: ObservationState;
	readonly outcome: ObservationOutcome;
}

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
/** What an observation id looks like, such as `crypto.randomUUID()`: plain enough to sit in a path as it is. */
const OBSERVATION_ID = /^[A-Za-z0-9_-]{16,64}$/;
const isObservationId = (value: unknown): value is string => typeof value === "string" && OBSERVATION_ID.test(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A space's empty ledger. Only for a space that has never had one: a missing ledger is not an empty one (`restoreObservationState`). */
export function initialObservationState(owner: string): ObservationState {
	if (!isName(owner)) throw new RangeError("An observation ledger needs its owner.");
	return { version: OBSERVATION_STATE_VERSION, owner, records: [] };
}

/** Records that aren't final, oldest first: what is, or may still be, open. */
export function unresolvedObservations(state: ObservationState): ObservationRecord[] {
	return state.records.filter((record) => !FINAL.includes(record.status));
}

const refuse = (state: ObservationState, reason: ObservationRefusal): ObservationResult => ({ state, outcome: { ok: false, reason } });
const accept = (state: ObservationState): ObservationResult => ({ state, outcome: { ok: true } });

function replace(state: ObservationState, next: ObservationRecord): ObservationState {
	return { ...state, records: state.records.map((record) => (record.observationId === next.observationId ? next : record)) };
}

export function applyObservationEvent(state: ObservationState, event: ObservationEvent): ObservationResult {
	if (!isObservationId(event.observationId)) return refuse(state, "empty_value");
	const record = state.records.find((candidate) => candidate.observationId === event.observationId);
	switch (event.type) {
		case "open_requested": {
			if (!isName(event.owner)) return refuse(state, "empty_value");
			if (event.owner !== state.owner) return refuse(state, "wrong_owner");
			if (!isTime(event.now) || !isTime(event.notAfter) || event.notAfter <= event.now || event.notAfter - event.now > MAX_OBSERVATION_MS) {
				return refuse(state, "invalid_deadline");
			}
			// A repeated id is refused whatever its record says: the first may have reached the host.
			if (record) return refuse(state, "duplicate_id");
			if (unresolvedObservations(state).length >= MAX_UNRESOLVED_OBSERVATIONS || state.records.length >= MAX_OBSERVATION_RECORDS) return refuse(state, "limit");
			const created: ObservationRecord = {
				observationId: event.observationId,
				owner: state.owner,
				notAfter: event.notAfter,
				hostLaunchId: null,
				hostGeneration: null,
				status: "pending_open",
			};
			return accept({ ...state, records: [...state.records, created] });
		}
		case "open_acknowledged": {
			if (!record) return refuse(state, "unknown_id");
			if (!isName(event.hostLaunchId) || !isName(event.hostGeneration)) return refuse(state, "empty_value");
			if (record.hostLaunchId !== null) {
				// The same acknowledgment again changes nothing.
				if (record.hostLaunchId === event.hostLaunchId && record.hostGeneration === event.hostGeneration) return accept(state);
				// Another launch, or the same id from another generation: either may be open, and neither is replaced.
				const evidence = `a second, different launch was acknowledged for this observation (${event.hostLaunchId} in ${event.hostGeneration})`;
				return { state: replace(state, { ...record, status: "unconfirmed", evidence, conflicting: true }), outcome: { ok: false, reason: "conflicting_launch" } };
			}
			if (record.status === "not_opened" || record.status === "reconciled") {
				// A launch the record had given up on: it exists after all and is not accounted for.
				const evidence = `a launch was acknowledged after the record was ${record.status}`;
				return { state: replace(state, { ...record, hostLaunchId: event.hostLaunchId, hostGeneration: event.hostGeneration, status: "unconfirmed", evidence }), outcome: { ok: false, reason: "conflicting_launch" } };
			}
			// A late acknowledgment names what to close; it doesn't make a revoking or unconfirmed record open again.
			const status: ObservationStatus = record.status === "pending_open" ? "open" : record.status;
			return accept(replace(state, { ...record, hostLaunchId: event.hostLaunchId, hostGeneration: event.hostGeneration, status }));
		}
		case "open_refused": {
			if (!record) return refuse(state, "unknown_id");
			if (!event.evidence.trim()) return refuse(state, "empty_value");
			if (record.status !== "pending_open") return refuse(state, "wrong_status");
			return accept(replace(state, { ...record, status: "not_opened", evidence: event.evidence }));
		}
		case "unconfirmed": {
			if (!record) return refuse(state, "unknown_id");
			if (!event.evidence.trim()) return refuse(state, "empty_value");
			if (FINAL.includes(record.status)) return refuse(state, "already_final");
			return accept(replace(state, { ...record, status: "unconfirmed", evidence: event.evidence }));
		}
		case "revoke_requested": {
			if (!record) return refuse(state, "unknown_id");
			if (FINAL.includes(record.status)) return refuse(state, "already_final");
			// An unconfirmed record stays so: asking the host to end it observes nothing.
			if (record.status === "revoking" || record.status === "unconfirmed") return accept(state);
			return accept(replace(state, { ...record, status: "revoking" }));
		}
		case "closure_observed": {
			if (!record) return refuse(state, "unknown_id");
			if (!isName(event.hostLaunchId) || !isName(event.hostGeneration) || !event.evidence.trim()) return refuse(state, "empty_value");
			if (FINAL.includes(record.status)) return refuse(state, "already_final");
			// Closure counts only for the launch this record names, seen by the generation that holds it.
			if (record.hostLaunchId === null || record.hostLaunchId !== event.hostLaunchId) return refuse(state, "launch_mismatch");
			if (record.hostGeneration !== event.hostGeneration) return refuse(state, "generation_mismatch");
			// A record that saw two launches can't be closed by seeing one of them close.
			if (record.conflicting) return refuse(state, "conflicting_launch");
			return accept(replace(state, { ...record, status: "closed_observed", evidence: event.evidence }));
		}
		case "reconcile": {
			if (!record) return refuse(state, "unknown_id");
			if (!event.evidence.trim()) return refuse(state, "empty_value");
			if (FINAL.includes(record.status)) return refuse(state, "already_final");
			if (record.status !== "unconfirmed") return refuse(state, "wrong_status");
			const { conflicting: _settled, ...rest } = record;
			return accept(replace(state, { ...rest, status: "reconciled", evidence: event.evidence }));
		}
	}
}

const STATUSES: readonly string[] = ["pending_open", "open", "revoking", "unconfirmed", "closed_observed", "not_opened", "reconciled"];

export type ObservationRestore = { ok: true; state: ObservationState } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validates a stored ledger (as parsed JSON) and restores it conservatively.
 * Anything missing, malformed, of another version or another owner is
 * refused, and the caller must then admit no observation: a missing ledger
 * is not an empty one, since records it held may still be open, and this
 * never invents one.
 *
 * A record `pending_open` was recorded by a process that may have died
 * before or after asking the host, and one `revoking` by a process that may
 * have died before or after the host ended it, so both come back
 * `unconfirmed`. An `open` record stays open: a restart of the space says
 * nothing about the host.
 */
export function restoreObservationState(raw: unknown, owner: string): ObservationRestore {
	const fail = (error: string): ObservationRestore => ({ ok: false, error });
	if (raw === undefined || raw === null) return fail("no ledger is stored");
	if (!isRecord(raw)) return fail("ledger is not an object");
	if (raw.version !== OBSERVATION_STATE_VERSION) return fail(`unsupported version ${String(raw.version)}`);
	if (!isName(raw.owner) || raw.owner !== owner) return fail("ledger of another owner");
	if (!Array.isArray(raw.records) || raw.records.length > MAX_OBSERVATION_RECORDS) return fail("records must be an array within the limit");
	const records: ObservationRecord[] = [];
	for (const item of raw.records) {
		if (!isRecord(item) || !isObservationId(item.observationId) || item.owner !== owner || !isTime(item.notAfter)) return fail("invalid record");
		if (typeof item.status !== "string" || !STATUSES.includes(item.status)) return fail("unknown record status");
		if (records.some((record) => record.observationId === item.observationId)) return fail("duplicate observation id");
		const launch = item.hostLaunchId;
		const generation = item.hostGeneration;
		const hostLaunchId = isName(launch) && isName(generation) ? launch : null;
		const hostGeneration = hostLaunchId !== null && isName(generation) ? generation : null;
		const named = hostLaunchId !== null;
		if (!named && !(launch === null && generation === null)) return fail("launch and generation must be named together");
		// Only a record never acknowledged has no launch; open and observed ones were acknowledged.
		if ((item.status === "pending_open" && named) || ((item.status === "open" || item.status === "closed_observed") && !named)) return fail("status and launch disagree");
		const status = item.status as ObservationStatus;
		const needsEvidence = status !== "pending_open" && status !== "open" && status !== "revoking";
		if (item.evidence !== undefined && (typeof item.evidence !== "string" || !item.evidence.trim())) return fail("invalid evidence");
		if (needsEvidence && item.evidence === undefined) return fail(`${status} record without evidence`);
		if (item.conflicting !== undefined && (item.conflicting !== true || status !== "unconfirmed" || !named)) return fail("invalid conflict");
		const conflict = item.conflicting === true ? { conflicting: true as const } : {};
		const base = { observationId: item.observationId, owner, notAfter: item.notAfter, hostLaunchId, hostGeneration, ...conflict };
		if (status === "pending_open" || status === "revoking") {
			records.push({ ...base, status: "unconfirmed", evidence: `restored while ${status}: the host may hold a launch for it` });
		} else {
			records.push({ ...base, status, ...(item.evidence === undefined ? {} : { evidence: item.evidence as string }) });
		}
	}
	// More unresolved records than new observations may make is a state the events can reach (a late acknowledgment of a final record), so it is kept.
	return { ok: true, state: { version: OBSERVATION_STATE_VERSION, owner, records } };
}

// ---------------------------------------------------------------- admission

/** Where observations are managed, under the API: `/api/observations/<id>/…`. Only the preview mounts it (src/gateway.ts, `Mounts`). */
export const OBSERVATION_PATH_PREFIX = "/api/observations/";

/** The one subprotocol the viewer offers for its media socket, as the host adapter's `MEDIA_PROTOCOL`. */
export const OBSERVATION_MEDIA_PROTOCOL = "rcdp.v2";

/** The viewer's pinned files (computer/cua-host/viewer-upstream.ts), and its page. */
const VIEWER_FILES: readonly string[] = ["", "index.html", "viewer.js", "index.css", "audioWorklet.js", "captureWorklet.js"];

/** The viewer's calls the host adapter answers. Everything else, `Leave` and `UpdateCursor` among them, is refused here too. */
const VIEWER_CALLS: readonly string[] = [
	"cua.env.v1.SystemService/GetCapabilities",
	"cua.env.v1.StreamService/ListTargets",
	"cua.env.v1.StreamService/OpenMedia",
	"cua.env.v1.StreamService/SetPreferences",
	"cua.env.v1.StreamService/RequestKeyframe",
	"cua.env.v1.StreamService/CloseMedia",
	"cua.env.v1.PresenceService/Join",
];

const ATTACH_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Who the gateway found the caller to be. `owner` comes from the session the
 * gateway checked, never from the request; `viaSession` is whether it came
 * with the person's browser session (`signedIn`), not an API, OAuth or query
 * token.
 */
export type ObservationCaller = { readonly owner: string; readonly viaSession: boolean };

export type ObservationAdmission =
	| {
			readonly ok: true;
			readonly owner: string;
			readonly observationId: string;
			readonly hostLaunchId: string;
			readonly hostGeneration: string;
			/** The canonical target on the host adapter: `/<launch>/<rest>`, with the attach token's query for media only. */
			readonly hostTarget: string;
			readonly kind: "file" | "call" | "media";
	  }
	| { readonly ok: false; readonly status: 400 | 401 | 403 | 404 | 405 | 426 };

/**
 * Whether a browser request may reach an observation, and where on the
 * host. Not mounted: nothing calls it.
 *
 * Only the person's active browser session admits, for their own space's
 * record that is `open` and before its `notAfter`; anything else answers as
 * if the observation didn't exist (`404`), so another owner learns nothing.
 * The launch's own credential (the viewer's `#ticket=`, sent as
 * `x-cua-env-authorization`) is the host adapter's to check and is not
 * authentication here. The target must be canonical: one of the viewer's
 * files, one of its calls, or its media socket with exactly its attach token,
 * and nothing percent-encoded. Writes and sockets must come from
 * `publicOrigin`; a socket must offer exactly `rcdp.v2`.
 */
export function admitObservationRequest(
	request: Request,
	caller: ObservationCaller | null,
	ledger: ObservationState | null,
	now: number,
	publicOrigin: string,
): ObservationAdmission {
	const refused = (status: 400 | 401 | 403 | 404 | 405 | 426): ObservationAdmission => ({ ok: false, status });
	const url = new URL(request.url);
	if (url.origin !== publicOrigin || !url.pathname.startsWith(OBSERVATION_PATH_PREFIX)) return refused(404);
	// Only a browser's session: an API or OAuth token, in a header or a query, opens no observation, even beside a session.
	if (!caller || !caller.viaSession || !isName(caller.owner)) return refused(401);
	if (request.headers.has("authorization") || url.searchParams.has("token")) return refused(401);

	const rest = url.pathname.slice(OBSERVATION_PATH_PREFIX.length);
	if (rest.includes("%") || rest.includes("//")) return refused(404);
	const slash = rest.indexOf("/");
	const observationId = slash < 0 ? rest : rest.slice(0, slash);
	const tail = slash < 0 ? "" : rest.slice(slash + 1);
	if (!isObservationId(observationId)) return refused(404);
	let kind: "file" | "call" | "media";
	if (tail.startsWith("viewer/") && VIEWER_FILES.includes(tail.slice("viewer/".length))) kind = "file";
	else if (VIEWER_CALLS.includes(tail)) kind = "call";
	else if (tail === "media") kind = "media";
	else return refused(404);
	// Only the media socket has a query, and it is exactly its attach token.
	if (kind === "media") {
		const token = url.search.startsWith("?ticket=") ? url.search.slice("?ticket=".length) : "";
		if (!ATTACH_TOKEN.test(token)) return refused(404);
	} else if (url.search !== "" || request.url.includes("?")) return refused(404);

	const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
	const origin = request.headers.get("origin");
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return refused(403);
	if (kind === "file") {
		if (upgrade) return refused(404);
		if (request.method !== "GET" && request.method !== "HEAD") return refused(405);
		if (origin !== null && origin !== publicOrigin) return refused(403);
	} else if (kind === "call") {
		if (upgrade) return refused(404);
		if (request.method !== "POST") return refused(405);
		if (origin !== publicOrigin) return refused(403);
	} else {
		if (!upgrade) return refused(426);
		if (request.method !== "GET") return refused(405);
		if (origin !== publicOrigin) return refused(403);
		const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((protocol) => protocol.trim());
		if (offered.length !== 1 || offered[0] !== OBSERVATION_MEDIA_PROTOCOL) return refused(400);
	}

	// The record must be this owner's, open, and before its deadline; otherwise it doesn't exist for this caller.
	if (!ledger || ledger.owner !== caller.owner || !isTime(now)) return refused(404);
	const record = ledger.records.find((candidate) => candidate.observationId === observationId);
	if (!record || record.owner !== caller.owner || record.status !== "open" || now >= record.notAfter) return refused(404);
	if (record.hostLaunchId === null || record.hostGeneration === null) return refused(404);
	return {
		ok: true,
		owner: caller.owner,
		observationId,
		hostLaunchId: record.hostLaunchId,
		hostGeneration: record.hostGeneration,
		hostTarget: `/${record.hostLaunchId}/${tail}${kind === "media" ? url.search : ""}`,
		kind,
	};
}

/**
 * An observation answer as the browser gets it: never cached or stored,
 * no referrer, no sniffing. A WebSocket upgrade is returned as it is.
 */
export function observationResponse(response: Response): Response {
	if (response.status === 101) return response;
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("X-Content-Type-Options", "nosniff");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
