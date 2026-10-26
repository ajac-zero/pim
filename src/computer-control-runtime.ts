import { AsyncLocalStorage } from "node:async_hooks";
import {
	applyControlEvent,
	CONTROL_STATE_VERSION,
	type ControlEvent,
	type ControlLease,
	type ControlOutcome,
	type ControlState,
	initialControlState,
	restoreControlState,
} from "./computer-control";

/**
 * Durable, serialized control state for a space's computer, and the one place
 * where an agent's request to the computer is admitted (see
 * ./computer-control.ts for the model and what it cannot prove).
 *
 * Opting in is having a stored control document: `enable()` writes the first
 * one, and nothing in the Worker's routes or tools calls it. Without one,
 * `dispatch` runs the request as it always did, so paired computers and
 * Sprites behave as before. With one, a request reaches the computer only if
 * the state admits it first, and there is no fallback to another computer.
 *
 * Writes are one synchronous read-modify-write of the whole document in the
 * space's own storage, so two transitions never interleave, and a request is
 * recorded before anything is sent. Nothing awaits between deciding and
 * recording.
 *
 * Any failure to store a change latches the coordinator blocked, for as long as
 * this process lives: the stored and remembered state may then disagree, and a
 * disk that comes back does not clear it. A restart reads the stored state
 * conservatively (a request still in flight comes back unknown) and, if that
 * can't be stored either, latches again.
 *
 * What the state says is the application's view. A request that "completed"
 * got a reply over the transport; that is a receipt, not proof the machine
 * stopped accepting other input, and a takeover does not make it so.
 */

/** Why a request was not admitted, for the agent to read: nothing was sent. */
export class ControlRefused extends Error {
	constructor(
		readonly reason: string,
		detail: string,
	) {
		super(`The computer is not available to this agent now (${detail}), so nothing was sent to it.`);
	}
}

/** What the calls of one request did on the transport. */
export type DispatchTrace = {
	/** Something left this process for the computer. */
	sent: boolean;
	/** Something sent may have run without an answer saying so, or its answer can't be told apart. */
	uncertain: boolean;
	/** DevTools messages sent for it and not answered yet, by connection and message ID (see `Computer.connectBrowser`). */
	awaiting: Set<string>;
	/** It has been settled: what is sent after, from code it started, is no longer its own. */
	settled: boolean;
	/** Who makes it, as `dispatch` admitted it; only a trace `dispatch` made has one (see `Computer.native`). */
	readonly request?: AdmittedRequest;
	/** It has made its native-app call; a request makes at most one, whose call ID is the request's. */
	native?: boolean;
};
/** The request whose calls `Computer.call` and the browser's connection are making, if the state is admitting them. */
export const dispatchTrace = new AsyncLocalStorage<DispatchTrace>();

/** The request being made here, unless it was already settled. */
export function currentTrace(): DispatchTrace | undefined {
	const trace = dispatchTrace.getStore();
	return trace && !trace.settled ? trace : undefined;
}

/** Where a space keeps its control document. Reads and writes are synchronous, as the Durable Object's storage is. */
export type ControlStorage = { read(): string | undefined; write(value: string): void };

/** The most approvals awaiting execution that keep the lease they were filed under; an older one finds none and is refused. */
const MAX_BINDINGS = 256;

type Binding = { id: string; lease: ControlLease | null };
type Document = { version: typeof CONTROL_STATE_VERSION; space: string; state: ControlState; bindings: Binding[] };

export type ControlRequest = {
	/** The space making the request, from the Durable Object's own name, never from a client. */
	space: string;
	/** The agent making it, from the server's own record of the conversation. */
	agentId: string;
	/** Unique for one request ever; an ID seen before is refused, so a retry or replay sends nothing. */
	requestId: string;
	/** The approval the request was filed under, whose recorded lease must still be the current one. */
	bindingId?: string;
	/**
	 * The run it belongs to, from the server's own records, for a native-app
	 * call (docs/cua-native-mcp.md). Stored with the request: once one of a
	 * run's requests is unknown, the run admits nothing more, also after a
	 * restart or a reconciliation.
	 */
	runId?: string;
};

/** A request as `dispatch` admitted it: the space's own name, and the agent, request and run it was given by the server. */
export type AdmittedRequest = Readonly<{ space: string; agentId: string; requestId: string; runId?: string }>;

export class ControlCoordinator {
	readonly #space: string;
	readonly #storage: ControlStorage;
	#doc: Document | null = null;
	/** Why the stored document can't be used; it is then left as it is, and every request is refused. */
	#blocked: string | null = null;
	/** A change could not be stored, so what is remembered can't be trusted; never cleared. */
	#latched: string | null = null;

	/**
	 * Loads the stored document. A request recorded as in flight is restored as
	 * unknown (the process died before or after sending it) and written back so.
	 */
	constructor(space: string, storage: ControlStorage) {
		this.#space = space;
		this.#storage = storage;
		const raw = storage.read();
		if (raw === undefined) return;
		const loaded = this.#parse(raw);
		if (typeof loaded === "string") {
			this.#blocked = loaded;
			return;
		}
		this.#doc = loaded;
		if (JSON.stringify(loaded.state) !== JSON.stringify(JSON.parse(raw).state)) {
			try {
				this.#write(loaded);
			} catch {
				// Remembered as restored (unknown), though not stored; blocked either way.
			}
		}
	}

	#parse(raw: string): Document | string {
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			return "the stored control state is not JSON";
		}
		if (typeof value !== "object" || value === null) return "the stored control state is not an object";
		const { version, space, state, bindings } = value as Record<string, unknown>;
		if (version !== CONTROL_STATE_VERSION) return "the stored control state has an unknown version";
		if (space !== this.#space) return "the stored control state belongs to another space";
		if (!Array.isArray(bindings) || !bindings.every(validBinding)) return "the stored lease bindings are malformed";
		const restored = restoreControlState(state);
		if (!restored.ok) return `the stored control state is invalid: ${restored.error}`;
		const seen = new Set<string>();
		for (const binding of bindings as Binding[]) {
			if (seen.has(binding.id)) return "the stored lease bindings repeat an approval";
			seen.add(binding.id);
			const { lease } = binding;
			if (lease && lease.epoch > restored.state.epoch) return "a stored lease binding is from a future epoch";
			if (lease && lease.epoch === restored.state.epoch && lease.leaseId !== restored.state.lease?.leaseId) return "a stored lease binding contradicts the current lease";
		}
		if (bindings.length > MAX_BINDINGS) return "the stored lease bindings are too many";
		return { version: CONTROL_STATE_VERSION, space: this.#space, state: restored.state, bindings: bindings as Binding[] };
	}

	/** Whether the space has opted in, with usable state or not. */
	get enabled(): boolean {
		return this.#doc !== null || this.blocked !== null;
	}

	/** Why requests are refused regardless of state, or null. */
	get blocked(): string | null {
		return this.#blocked ?? this.#latched;
	}

	/** The state, or null when not opted in or blocked. It is a copy: changing it changes nothing. */
	get state(): ControlState | null {
		return this.#doc ? structuredClone(this.#doc.state) : null;
	}

	/** Opts the space in, with the human in control. Does nothing when a document, even a damaged one, is already stored. */
	enable(): void {
		if (this.enabled || this.#storage.read() !== undefined) return;
		this.#write({ version: CONTROL_STATE_VERSION, space: this.#space, state: initialControlState(), bindings: [] });
	}

	#write(doc: Document): void {
		try {
			this.#storage.write(JSON.stringify(doc));
		} catch (error) {
			// The write may or may not have happened, even the first one that opts the space in, so nothing is admitted until a restart reads what is stored.
			this.#latched = "the control state could not be stored";
			throw error;
		}
		this.#doc = doc;
	}

	#usable(): Document {
		if (this.blocked) throw new ControlRefused("blocked", this.blocked);
		if (!this.#doc) throw new ControlRefused("not_enabled", "this space has not opted in");
		return this.#doc;
	}

	/**
	 * Applies one event to the state and stores the result. The only way the state
	 * changes. Viewer events come from the sockets of the browser's live views
	 * (in ./pim.ts); takeover and resume are for the stages that establish their
	 * evidence, and no route or tool sends them.
	 */
	apply(event: ControlEvent): ControlOutcome {
		const doc = this.#usable();
		const result = applyControlEvent(doc.state, event);
		if (result.outcome.ok && result.state !== doc.state) this.#write({ ...doc, state: result.state });
		return result.outcome;
	}

	/**
	 * Remembers the lease an approval was filed under, so that a takeover, or a
	 * resume after one, that comes before it is decided is found out when it runs.
	 * Filed with no lease to hold (the human owns the computer), it will be refused.
	 */
	bind(approvalId: string): void {
		// A blocked coordinator changes nothing, stored or remembered.
		if (!this.#doc || this.blocked || this.#doc.bindings.some((binding) => binding.id === approvalId)) return;
		const { state } = this.#doc;
		const bindings = [...this.#doc.bindings, { id: approvalId, lease: state.owner === "agent" ? state.lease : null }].slice(-MAX_BINDINGS);
		this.#write({ ...this.#doc, bindings });
	}

	/**
	 * Sends a request to the computer if the state admits it. Without a stored
	 * document it just runs `send`. Otherwise:
	 * 1. admitted (or refused, throwing `ControlRefused` with nothing sent) and
	 *    stored before `send` starts;
	 * 2. `send` runs once, never again for this request ID;
	 * 3. settled from what its calls and DevTools messages did: every one sent
	 *    was answered (`completed`), or nothing left this process (`rejected`),
	 *    or one was sent with no answer it can be sure of (`unknown`, which
	 *    keeps the state blocked until a `reconcile_request` event).
	 */
	async dispatch<T>(request: ControlRequest, send: () => Promise<T>): Promise<T> {
		if (!this.enabled) return send();
		const doc = this.#usable();
		if (request.space !== this.#space) throw new ControlRefused("wrong_space", "the request is for another space");
		if (!request.agentId || !request.requestId || request.runId === "") throw new ControlRefused("empty_value", "the request has no identity");

		let lease = doc.state.lease;
		let bindings = doc.bindings;
		if (request.bindingId !== undefined) {
			const bound = bindings.find((binding) => binding.id === request.bindingId);
			// Spent now, whatever comes: an approval runs once.
			bindings = bindings.filter((binding) => binding !== bound);
			lease = bound?.lease ?? null;
			if (!lease) {
				this.#write({ ...doc, bindings });
				throw new ControlRefused("stale_lease", "the approval was not filed under a lease");
			}
		}
		if (!lease) throw new ControlRefused("not_agent_owned", "the person has control");
		const { agentId, requestId, runId } = request;
		const admitted = applyControlEvent(doc.state, { type: "admit", requestId, agentId, lease, ...(runId === undefined ? {} : { runId }) });
		if (!admitted.outcome.ok) {
			if (bindings !== doc.bindings) this.#write({ ...doc, bindings });
			throw new ControlRefused(admitted.outcome.reason, admitted.outcome.reason);
		}
		this.#write({ ...doc, state: admitted.state, bindings });
		const epoch = admitted.state.epoch;

		const admittedRequest: AdmittedRequest = Object.freeze({ space: this.#space, agentId, requestId, ...(runId === undefined ? {} : { runId }) });
		const trace: DispatchTrace = { sent: false, uncertain: false, awaiting: new Set(), settled: false, request: admittedRequest };
		try {
			return await dispatchTrace.run(trace, send);
		} finally {
			trace.settled = true;
			// A DevTools message still unanswered may yet run; an answer arriving after this changes nothing.
			const outcome = trace.uncertain || trace.awaiting.size > 0 ? "unknown" : trace.sent ? "completed" : "rejected";
			try {
				this.apply({ type: "request_result", requestId: request.requestId, epoch, outcome });
			} catch (error) {
				// The failed write latched the coordinator, so nothing more is admitted; a restart reads this request as unknown.
				console.error("settling a computer request", error);
			}
		}
	}
}

function validBinding(value: unknown): value is Binding {
	if (typeof value !== "object" || value === null) return false;
	const { id, lease } = value as { id?: unknown; lease?: unknown };
	if (typeof id !== "string" || !id) return false;
	if (lease === null) return true;
	if (typeof lease !== "object") return false;
	const { epoch, leaseId } = lease as { epoch?: unknown; leaseId?: unknown };
	return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0 && typeof leaseId === "string" && leaseId !== "";
}
