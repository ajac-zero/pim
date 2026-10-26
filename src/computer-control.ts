/**
 * Application-level control bookkeeping for one space's shared computer.
 *
 * DECISION RECORD. This module records who Pim's application currently treats
 * as in control of the computer (the agent, or the person) and decides whether
 * Pim should admit a new agent request. It is a pure reducer: it performs no
 * I/O, starts no timers, and calls nothing. Every outside fact it consumes
 * (a request finished, a viewer was revoked) is evidence a caller reports; the
 * module cannot check it.
 *
 * It does NOT make the computer stop. A takeover here closes Pim's own
 * admissions and invalidates the agent's lease; a command already sent to the
 * machine may still be running, and nothing here observes or stops it. Actual
 * input quiescence, and so full-computer takeover, is UNPROVEN: `inputQuiescence`
 * is always "unproven". This module must never by itself authorize real human
 * input, or be shown to people as proof that the agent has stopped. A future
 * integration needs enforcement and quiescence established independently.
 *
 * It is also not authorization. Who may send these events, and whether they
 * belong to this space, is the caller's existing authentication and
 * membership checks. Epochs, leases and session IDs are bookkeeping names, not
 * credentials. The module is not wired to any API, tool or UI.
 *
 * The model, in short:
 * - An epoch counts ownership changes. Takeover and resume each start a new one.
 * - An agent request is admitted only with the current lease (epoch and lease
 *   ID) while the agent owns the application, and nothing blocks admission.
 * - A request's result is recorded against the epoch it was admitted in, and
 *   changes nothing else. A late result can never reopen or close admissions.
 * - An outcome the caller reports as unknown, or a request whose result is
 *   lost across a restart, blocks admissions until a `reconcile_request` event
 *   names what happened. Nothing is replayed, and a duplicate request ID is
 *   refused, which says nothing about whether the first one ran, once or at all.
 * - Viewer sessions are treated as input-capable; there is no read-only kind.
 *   A viewer can be requested only while the human owns the application, in the
 *   current epoch. Any viewer session not reported revoked, of any epoch, keeps
 *   admissions closed, so a resume reopens them only after every session is revoked.
 * - A revocation is an attempt with a number the state assigns. Only an
 *   acknowledgment naming the attempt in progress counts, so a duplicate or
 *   delayed acknowledgment of an earlier attempt can't certify a later one. An
 *   open acknowledged after a revocation reopens the session, and needs a fresh
 *   attempt. A late open can't be told from a duplicate one, and is treated as
 *   the worse case.
 */

export const CONTROL_STATE_VERSION = 1;

/** Who the application treats as in control. This is not a claim about what the machine is doing. */
export type ApplicationOwner = "agent" | "human";

export type RequestStatus =
	/** Admitted; whether it reached the machine, or is still running, is not known here. */
	| "in_flight"
	/** The caller reports it definitively finished. */
	| "completed"
	/** The caller reports it definitively did not run. */
	| "rejected"
	/** The outcome is not known. Blocks admissions until reconciled. */
	| "unknown"
	/** Reconciliation evidence says it finished. */
	| "reconciled_completed"
	/** Reconciliation evidence says it did not run. */
	| "reconciled_not_executed";

export type ViewerStatus = "pending_open" | "open" | "revoking" | "revoked" | "revoke_failed";

export interface ControlLease {
	epoch: number;
	leaseId: string;
}

export interface ControlRequest {
	requestId: string;
	agentId: string;
	/** The epoch it was admitted in. */
	epoch: number;
	status: RequestStatus;
	/** Reconciliation evidence, as the caller described it. */
	evidence?: string;
}

export interface ControlViewer {
	sessionId: string;
	/** The epoch the session was requested in. */
	epoch: number;
	status: ViewerStatus;
	/** The number of the latest revocation attempt, 0 if none; acknowledgments must name it. */
	revokeAttempt: number;
}

export interface ControlState {
	version: typeof CONTROL_STATE_VERSION;
	epoch: number;
	owner: ApplicationOwner;
	/** The agent's lease: set while the agent owns the application, otherwise null. */
	lease: ControlLease | null;
	/** Always "unproven": nothing here establishes that the machine takes no agent input. */
	inputQuiescence: "unproven";
	requests: ControlRequest[];
	viewers: ControlViewer[];
}

export type ControlEvent =
	| { type: "admit"; requestId: string; agentId: string; lease: ControlLease }
	| { type: "request_result"; requestId: string; epoch: number; outcome: "completed" | "rejected" | "unknown" }
	| { type: "reconcile_request"; requestId: string; resolution: "completed" | "not_executed"; evidence: string }
	| { type: "takeover" }
	| { type: "resume"; leaseId: string }
	| { type: "viewer_open_requested"; sessionId: string; epoch: number }
	| { type: "viewer_opened"; sessionId: string }
	| { type: "viewer_revoke_requested"; sessionId: string }
	| { type: "viewer_revoked"; sessionId: string; attempt: number }
	| { type: "viewer_revoke_failed"; sessionId: string; attempt: number };

export type ControlRefusal =
	| "stale_lease"
	| "not_agent_owned"
	| "blocked"
	| "duplicate_id"
	| "unknown_id"
	| "epoch_mismatch"
	| "already_final"
	| "empty_value"
	| "wrong_owner"
	| "stale_attempt"
	| "epoch_exhausted"
	| "attempt_exhausted";

export type ControlOutcome = { ok: true } | { ok: false; reason: ControlRefusal };

export interface ControlResult {
	/** The next state: the same object when the event is refused or changes nothing. */
	state: ControlState;
	outcome: ControlOutcome;
}

/**
 * What currently keeps the agent's requests out. Empty means admission is open
 * for a holder of the current lease; it still proves nothing about the machine.
 */
export function admissionBlockers(state: ControlState): string[] {
	const blockers: string[] = [];
	if (state.owner !== "agent") blockers.push("human owns the application");
	for (const request of state.requests) {
		if (request.status === "unknown") blockers.push(`request ${request.requestId} outcome unknown`);
		else if (request.status === "in_flight" && request.epoch < state.epoch) blockers.push(`request ${request.requestId} from an earlier epoch unresolved`);
	}
	for (const viewer of state.viewers) {
		if (viewer.status !== "revoked") blockers.push(`viewer ${viewer.sessionId} not revoked`);
	}
	return blockers;
}

/** The state of a computer nobody has granted the agent control of: the human owns it. */
export function initialControlState(): ControlState {
	return { version: CONTROL_STATE_VERSION, epoch: 0, owner: "human", lease: null, inputQuiescence: "unproven", requests: [], viewers: [] };
}

const refuse = (state: ControlState, reason: ControlRefusal): ControlResult => ({ state, outcome: { ok: false, reason } });
const accept = (state: ControlState): ControlResult => ({ state, outcome: { ok: true } });

const FINAL: readonly RequestStatus[] = ["completed", "rejected", "reconciled_completed", "reconciled_not_executed"];

export function applyControlEvent(state: ControlState, event: ControlEvent): ControlResult {
	switch (event.type) {
		case "admit": {
			if (!event.requestId || !event.agentId || !event.lease.leaseId) return refuse(state, "empty_value");
			if (state.owner !== "agent" || !state.lease) return refuse(state, "not_agent_owned");
			if (event.lease.epoch !== state.epoch || event.lease.leaseId !== state.lease.leaseId) return refuse(state, "stale_lease");
			if (state.requests.some((request) => request.requestId === event.requestId)) return refuse(state, "duplicate_id");
			if (admissionBlockers(state).length > 0) return refuse(state, "blocked");
			const request: ControlRequest = { requestId: event.requestId, agentId: event.agentId, epoch: state.epoch, status: "in_flight" };
			return accept({ ...state, requests: [...state.requests, request] });
		}
		case "request_result": {
			const request = state.requests.find((candidate) => candidate.requestId === event.requestId);
			if (!request) return refuse(state, "unknown_id");
			if (request.epoch !== event.epoch) return refuse(state, "epoch_mismatch");
			if (request.status !== "in_flight") return refuse(state, "already_final");
			const status: RequestStatus = event.outcome === "unknown" ? "unknown" : event.outcome;
			return accept(replaceRequest(state, { ...request, status }));
		}
		case "reconcile_request": {
			const request = state.requests.find((candidate) => candidate.requestId === event.requestId);
			if (!request) return refuse(state, "unknown_id");
			if (!event.evidence.trim()) return refuse(state, "empty_value");
			if (FINAL.includes(request.status)) return refuse(state, "already_final");
			const status = event.resolution === "completed" ? "reconciled_completed" : "reconciled_not_executed";
			return accept(replaceRequest(state, { ...request, status, evidence: event.evidence }));
		}
		case "takeover": {
			if (state.owner === "human") return accept(state);
			// Closing admissions can't wait on a new epoch number, so the last one is kept; resume is what refuses it.
			const epoch = state.epoch < Number.MAX_SAFE_INTEGER ? state.epoch + 1 : state.epoch;
			return accept({ ...state, epoch, owner: "human", lease: null });
		}
		case "resume": {
			if (!event.leaseId) return refuse(state, "empty_value");
			if (state.owner === "agent") return refuse(state, "wrong_owner");
			if (state.epoch >= Number.MAX_SAFE_INTEGER) return refuse(state, "epoch_exhausted");
			const epoch = state.epoch + 1;
			return accept({ ...state, epoch, owner: "agent", lease: { epoch, leaseId: event.leaseId } });
		}
		case "viewer_open_requested": {
			if (!event.sessionId) return refuse(state, "empty_value");
			if (state.owner !== "human") return refuse(state, "wrong_owner");
			if (event.epoch !== state.epoch) return refuse(state, "epoch_mismatch");
			if (state.viewers.some((viewer) => viewer.sessionId === event.sessionId)) return refuse(state, "duplicate_id");
			const viewer: ControlViewer = { sessionId: event.sessionId, epoch: state.epoch, status: "pending_open", revokeAttempt: 0 };
			return accept({ ...state, viewers: [...state.viewers, viewer] });
		}
		case "viewer_opened":
		case "viewer_revoke_requested": {
			const viewer = state.viewers.find((candidate) => candidate.sessionId === event.sessionId);
			if (!viewer) return refuse(state, "unknown_id");
			// An open acknowledged after a revocation, or during one, means the revocation did not cover it: the session is open again.
			if (event.type === "viewer_opened") return accept(replaceViewer(state, { ...viewer, status: "open" }));
			if (viewer.status === "revoked") return refuse(state, "already_final");
			// Past the last safe integer attempts would stop being distinct, so the session stays unrevoked and admissions stay closed.
			if (viewer.revokeAttempt >= Number.MAX_SAFE_INTEGER) return refuse(state, "attempt_exhausted");
			return accept(replaceViewer(state, { ...viewer, status: "revoking", revokeAttempt: viewer.revokeAttempt + 1 }));
		}
		case "viewer_revoked":
		case "viewer_revoke_failed": {
			const viewer = state.viewers.find((candidate) => candidate.sessionId === event.sessionId);
			if (!viewer) return refuse(state, "unknown_id");
			if (viewer.status !== "revoking" || viewer.revokeAttempt !== event.attempt) return refuse(state, "stale_attempt");
			return accept(replaceViewer(state, { ...viewer, status: event.type === "viewer_revoked" ? "revoked" : "revoke_failed" }));
		}
	}
}

function replaceViewer(state: ControlState, next: ControlViewer): ControlState {
	return { ...state, viewers: state.viewers.map((viewer) => (viewer.sessionId === next.sessionId ? next : viewer)) };
}

function replaceRequest(state: ControlState, next: ControlRequest): ControlState {
	return { ...state, requests: state.requests.map((request) => (request.requestId === next.requestId ? next : request)) };
}

const REQUEST_STATUSES: readonly string[] = ["in_flight", "completed", "rejected", "unknown", "reconciled_completed", "reconciled_not_executed"];
const VIEWER_STATUSES: readonly string[] = ["pending_open", "open", "revoking", "revoked", "revoke_failed"];

export type RestoreResult = { ok: true; state: ControlState } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isEpoch = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Validates a stored state (as parsed JSON) and restores it conservatively.
 * Anything malformed, of another version, or inconsistent is refused, and the
 * caller must then treat control as closed: there is no state to admit against,
 * and this never invents one, so it can't turn control on by default.
 *
 * Requests still `in_flight` were admitted by an earlier process that may have
 * died before or after sending them, so they come back `unknown` and block
 * admissions until reconciled. Nothing is re-sent. Likewise a viewer revoking
 * comes back `revoke_failed`, so an acknowledgment from before the restart
 * can't certify it and a fresh attempt is needed.
 */
export function restoreControlState(raw: unknown): RestoreResult {
	const fail = (error: string): RestoreResult => ({ ok: false, error });
	if (!isRecord(raw)) return fail("state is not an object");
	if (raw.version !== CONTROL_STATE_VERSION) return fail(`unsupported version ${String(raw.version)}`);
	if (!isEpoch(raw.epoch)) return fail("invalid epoch");
	const epoch = raw.epoch;
	if (raw.owner !== "agent" && raw.owner !== "human") return fail("unknown owner");
	if (raw.inputQuiescence !== "unproven") return fail("inputQuiescence must be unproven");
	let lease: ControlLease | null = null;
	if (raw.owner === "agent") {
		if (!isRecord(raw.lease) || !isName(raw.lease.leaseId) || raw.lease.epoch !== epoch) return fail("agent owner without a lease of this epoch");
		lease = { epoch, leaseId: raw.lease.leaseId };
	} else if (raw.lease !== null) return fail("human owner with a lease");
	if (!Array.isArray(raw.requests) || !Array.isArray(raw.viewers)) return fail("requests and viewers must be arrays");

	const requests: ControlRequest[] = [];
	for (const item of raw.requests) {
		if (!isRecord(item) || !isName(item.requestId) || !isName(item.agentId) || !isEpoch(item.epoch) || item.epoch > epoch) return fail("invalid request");
		if (typeof item.status !== "string" || !REQUEST_STATUSES.includes(item.status)) return fail("unknown request status");
		if (requests.some((request) => request.requestId === item.requestId)) return fail("duplicate request ID");
		const status = item.status === "in_flight" ? "unknown" : (item.status as RequestStatus);
		const request: ControlRequest = { requestId: item.requestId, agentId: item.agentId, epoch: item.epoch, status };
		if (item.status.startsWith("reconciled_")) {
			if (typeof item.evidence !== "string" || !item.evidence.trim()) return fail("reconciled request without evidence");
			request.evidence = item.evidence;
		}
		requests.push(request);
	}
	const viewers: ControlViewer[] = [];
	for (const item of raw.viewers) {
		if (!isRecord(item) || !isName(item.sessionId) || !isEpoch(item.epoch) || item.epoch > epoch) return fail("invalid viewer");
		if (typeof item.status !== "string" || !VIEWER_STATUSES.includes(item.status)) return fail("unknown viewer status");
		if (viewers.some((viewer) => viewer.sessionId === item.sessionId)) return fail("duplicate viewer session");
		// Only a session that was never revoked has no attempt; revoked, revoking and failed ones have each had one.
		const attempt = item.revokeAttempt;
		if (!isEpoch(attempt) || (item.status === "pending_open" && attempt !== 0) || (item.status !== "pending_open" && item.status !== "open" && attempt < 1)) return fail("invalid revoke attempt");
		// A viewer is requested only while the human owns the application, so none can be of an agent-owned epoch.
		if (raw.owner === "agent" && item.epoch === epoch) return fail("viewer of the agent's own epoch");
		const status = item.status === "revoking" ? "revoke_failed" : (item.status as ViewerStatus);
		viewers.push({ sessionId: item.sessionId, epoch: item.epoch, status, revokeAttempt: attempt });
	}
	return { ok: true, state: { version: CONTROL_STATE_VERSION, epoch, owner: raw.owner, lease, inputQuiescence: "unproven", requests, viewers } };
}
