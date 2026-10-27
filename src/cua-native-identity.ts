import { dispatchEffect, NATIVE_IDENTITY, type NativeOutcome, type NativeRequest, readNativeOutcome, readNativeRequest } from "../computer/native-outcome";
import type { ControlLease } from "./computer-control";
import { ControlRefused } from "./computer-control-runtime";

/**
 * Binds a native-app call to who makes it, before anyone is asked to approve
 * it (docs/cua-native-identity.md). A binding is the exact identity of the
 * call (the space, the agent, the conversation, the tool task, the call and
 * the run), the curated tool with a frozen copy of its arguments, and the
 * agent's lease, stored before the binding is returned, so an approval filed
 * or approved automatically after it can only be about that call.
 *
 * The identity comes from an authority the caller gives (`NativeIdentityAuthority`),
 * never from a model or a client, and the binder makes up no part of it: no
 * run ID from a call, conversation, task or usage ID. Pim has no authority
 * yet, because the harness doesn't promise a run identity a tool call can be
 * checked against (see "The harness's run" in the doc), so nothing makes a
 * binder: no tool, route, approval or startup code imports this file.
 *
 * Every refusal is before anything is sent. A binding is dispatched at most
 * once, after the authority confirms the identity again, the lease is still
 * the agent's, and no call of its run is unknown or being sent; what may have
 * run without an answer saying so stays unknown, across restarts, and latches
 * its run for every binding, whichever agent or call. Sending stays with the
 * caller's `send`, which a later change would route through
 * `ControlCoordinator.dispatch` and `Computer.native`, the dispatch authority.
 *
 * Every binding is remembered for as long as the document lives: one no
 * longer bound keeps its identity, as a tombstone, so the same tool task or
 * call is never bound again. Past the bounds, every new binding is refused.
 *
 * Writes are one synchronous read-modify-write of the whole document, as in
 * ./computer-control-runtime.ts, so nothing interleaves between deciding and
 * recording. A write that fails latches the binder for as long as the process
 * lives; a restart reads what was stored, and a dispatch it can't tell the
 * end of comes back unknown.
 */

export const NATIVE_BINDINGS_VERSION = 1;
/** The most bindings remembered. None is ever let go: past this, every new one is refused. */
export const MAX_NATIVE_BINDINGS = 512;
/** The most characters the stored document may take as JSON, which also bounds the work of reading it back. */
export const MAX_NATIVE_BINDINGS_CHARS = 1024 * 1024;

/** What a tool call says it is, from the harness's own invocation (`ToolExecutionApi`), never from its arguments. */
export type NativeIdentityClaim = Readonly<{ conversationId: string; toolTaskId: string; callId: string }>;

/**
 * Who makes a native-app call, each part from the server's own records: the
 * space (`owner`), the agent the conversation is, the conversation, the tool
 * task and its call, and the run the call belongs to (`runAnchor`), which is
 * the same for every call of one run and differs for every other run.
 */
export type NativeIdentity = Readonly<{ owner: string; agentId: string; conversationId: string; toolTaskId: string; callId: string; runAnchor: string }>;

/** Why an authority can't vouch for a call; each refuses it unsent. */
export const AUTHORITY_REFUSALS = Object.freeze(["missing", "legacy", "ambiguous", "stopped", "not_run_owned", "unsupported"] as const);
export type AuthorityRefusal = (typeof AUTHORITY_REFUSALS)[number];

export type AuthorityAnswer =
	| { readonly status: "verified"; readonly identity: NativeIdentity }
	| { readonly status: "refused"; readonly reason: AuthorityRefusal };

/**
 * The one source of a call's identity. `verify` must answer from one
 * consistent read of committed state (for the harness, one transaction): the
 * tool task exists, is live and is the claim's, its call is the claim's, the
 * run it belongs to is still going and owns it, and the agent is the one the
 * server records for the conversation. Anything it can't establish so is
 * refused, never guessed: a missing, legacy or ambiguous record, a stopped run,
 * a task its run doesn't own, or a harness it doesn't support.
 */
export interface NativeIdentityAuthority {
	verify(claim: NativeIdentityClaim): Promise<AuthorityAnswer>;
}

/** A call bound before its approval: frozen, and what a dispatch sends, whatever the caller does with its own objects. */
export type NativeBinding = Readonly<{
	id: string;
	identity: NativeIdentity;
	tool: NativeRequest["tool"];
	arguments: NativeRequest["arguments"];
	lease: Readonly<ControlLease>;
}>;

/** Where the binder keeps its document. Reads and writes are synchronous, as the Durable Object's storage is. */
export type NativeBindingStorage = { read(): string | undefined; write(value: string): void };

/** Why nothing was bound or sent. */
export type BindingRefusal =
	| AuthorityRefusal
	/** The stored document can't be used, or a write failed in this process. */
	| "blocked"
	/** The authority threw, or answered something that isn't an answer. */
	| "authority_failed"
	/** The authority vouched for another space, conversation, task or call than the one claimed. */
	| "identity"
	/** The claim, the tool or the arguments aren't what a native call may carry. */
	| "invalid_request"
	/** The person has control: there is no lease to bind to. */
	| "not_agent_owned"
	/** The lease the call was bound under isn't the current one. */
	| "stale_lease"
	/** The call's identity, tool or arguments differ from its binding. */
	| "changed"
	/** Another tool task of the run has the same call ID. */
	| "ambiguous_call"
	/** A call of the run may have run without an answer saying so. */
	| "run_uncertain"
	/** Another call of the run is being sent; the binding stays bound. */
	| "run_busy"
	| "unknown_binding"
	/** The binding was closed: refused, released, or settled. */
	| "closed"
	/** The binding was dispatched already. */
	| "dispatched"
	/** The binding was dispatched and may have run without an answer saying so. */
	| "uncertain"
	/** The binder remembers as many bindings as it may, and lets none go. */
	| "full"
	/** The dispatch authority refused it, and nothing was sent. */
	| "control_refused";

export type Refused = { readonly ok: false; readonly reason: BindingRefusal; readonly message: string };
export type BindResult = { readonly ok: true; readonly binding: NativeBinding; readonly replayed: boolean } | Refused;
/** A dispatch that was sent: the outcome as `send` gave it, `unknown` included. A `send` that threw or answered something unreadable is `uncertain`. */
export type DispatchResult = { readonly ok: true; readonly outcome: NativeOutcome } | Refused;

/** A binding is `bound` until it is dispatched (`claimed`) or closed; a dispatch with no known end is `unknown`, for good. */
export type NativeBindingStatus = "bound" | "claimed" | "unknown" | "closed";
const STATUSES: readonly NativeBindingStatus[] = ["bound", "claimed", "unknown", "closed"];
type RecordBase = { id: string; identity: NativeIdentity; tool: NativeRequest["tool"]; lease: ControlLease };
/** A binding that may still be sent, with what it sends. */
type BoundRecord = RecordBase & { status: "bound"; arguments: NativeRequest["arguments"] };
/** A tombstone: a binding that will never be sent, which keeps its identity and lets its arguments go. */
type SpentRecord = RecordBase & { status: Exclude<NativeBindingStatus, "bound">; arguments: null };
type BindingRecord = BoundRecord | SpentRecord;
type Document = { version: typeof NATIVE_BINDINGS_VERSION; owner: string; records: BindingRecord[] };

const IDENTITY_KEYS = ["owner", "agentId", "conversationId", "toolTaskId", "callId", "runAnchor"] as const;
const CLAIM_KEYS = ["conversationId", "toolTaskId", "callId"] as const;
const RECORD_KEYS = ["id", "identity", "tool", "arguments", "lease", "status"] as const;
/** Stands for the agent and run in the copy `bind` makes before the authority answers; never stored, sent or compared. */
const UNVERIFIED = "unverified";

const refuse = (reason: BindingRefusal, detail: string): Refused => ({ ok: false, reason, message: `${detail}, so no native-app call was bound or sent.` });

export class NativeIdentityBinder {
	readonly #owner: string;
	readonly #storage: NativeBindingStorage;
	readonly #authority: NativeIdentityAuthority;
	readonly #lease: () => ControlLease | null;
	readonly #newId: () => string;
	#doc: Document;
	/** Why the stored document can't be used, or why a write failed; never cleared in this process. */
	#blocked: string | null = null;

	/**
	 * Loads the stored document. A binding recorded as dispatched without a
	 * settlement is restored as unknown (the process died before or after
	 * sending it) and written back so. A document that can't be read is left as
	 * it is, and everything is refused.
	 */
	constructor(
		owner: string,
		storage: NativeBindingStorage,
		options: { authority: NativeIdentityAuthority; lease: () => ControlLease | null; newId?: () => string },
	) {
		if (!NATIVE_IDENTITY.test(owner)) throw new TypeError("A native-call binder needs its space's own name as its owner.");
		this.#owner = owner;
		this.#storage = storage;
		this.#authority = options.authority;
		this.#lease = options.lease;
		this.#newId = options.newId ?? (() => crypto.randomUUID());
		this.#doc = { version: NATIVE_BINDINGS_VERSION, owner, records: [] };
		let raw: string | undefined;
		try {
			raw = storage.read();
		} catch {
			this.#blocked = "the stored native bindings can't be read";
			return;
		}
		if (raw === undefined) return;
		const loaded = this.#parse(raw);
		if (typeof loaded === "string") {
			this.#blocked = loaded;
			return;
		}
		this.#doc = loaded;
		if (loaded.records.some((record) => record.status === "claimed")) {
			const records = loaded.records.map((record): BindingRecord => (record.status === "claimed" ? { ...record, status: "unknown" } : record));
			// Remembered as unknown even if this write fails, which then blocks the binder.
			this.#write({ ...loaded, records });
		}
	}

	/** Why everything is refused, or null. */
	get blocked(): string | null {
		return this.#blocked;
	}

	/**
	 * Binds a native-app call before its approval is filed. The tool and
	 * arguments are copied (`readNativeRequest`) before anything is awaited, so
	 * the caller changing its objects while the authority answers changes
	 * nothing bound; then the authority vouches for the claim, and the binding
	 * is stored before it is returned. A tool task bound before, such as one
	 * woken from its approval or rerun after a restart, gets its original
	 * binding back, lease included, if it is exactly the same call and its run
	 * is still sure; if the call differs, or a call of its run is unknown, the
	 * binding is closed. A tool task or call bound before and spent is never
	 * bound again.
	 */
	async bind(claim: NativeIdentityClaim, tool: unknown, args: unknown): Promise<BindResult> {
		if (this.#blocked) return refuse("blocked", this.#blocked);
		const read = readClaim(claim);
		if (!read) return refuse("invalid_request", "The call's claim isn't a conversation, tool task and call ID");
		const copy = readNativeRequest({ owner: this.#owner, agentId: UNVERIFIED, runId: UNVERIFIED, callId: read.callId, tool, arguments: args });
		if (!copy) return refuse("invalid_request", "The call names no curated tool, or its arguments aren't a plain JSON object of a bounded size");
		const verified = await this.#verify(read);
		if (!verified.ok) return verified;
		const { identity } = verified;
		// Everything from here to the write is checked against the document as it is now, with nothing awaited.
		if (this.#blocked) return refuse("blocked", this.#blocked);
		const { records } = this.#doc;
		const earlier = records.find((record) => record.identity.toolTaskId === identity.toolTaskId);
		if (earlier) {
			if (earlier.status !== "bound") return this.#spent(earlier);
			if (!sameCall(earlier, identity, copy)) return this.#close(earlier, refuse("changed", "The call isn't the one its tool task was bound as"));
			if (this.#runUnknown(identity.runAnchor)) return this.#close(earlier, runUncertain());
			return { ok: true, binding: bindingOf(earlier), replayed: true };
		}
		if (records.some((record) => record.identity.runAnchor === identity.runAnchor && record.identity.callId === identity.callId)) {
			return refuse("ambiguous_call", "Another call of this run has the same call ID");
		}
		if (this.#runUnknown(identity.runAnchor)) return runUncertain();
		const lease = this.#currentLease();
		if (!lease) return refuse("not_agent_owned", "The person has control of the computer");
		let id: unknown;
		try {
			id = this.#newId();
		} catch {
			id = null;
		}
		if (!identityPart(id) || records.some((record) => record.id === id)) {
			return refuse("invalid_request", "No unique binding ID could be made");
		}
		const record: BoundRecord = { id, identity, tool: copy.tool, arguments: copy.arguments, lease, status: "bound" };
		const next = { ...this.#doc, records: [...records, record] };
		if (!fits(next)) return refuse("full", "The binder remembers as many bindings as it may");
		if (!this.#write(next)) return refuse("blocked", "The binding couldn't be stored");
		return { ok: true, binding: bindingOf(record), replayed: false };
	}

	/**
	 * Sends a bound call once, when it is asked to; nothing here retries. The
	 * authority vouches for it again, the lease must still be the one it was
	 * bound under, and no call of its run may be unknown (which closes it) or
	 * being sent (which refuses it, still bound). These are checked again after
	 * the authority answers, with nothing awaited between the last check and
	 * storing it as dispatched, which comes before `send` is called with the
	 * binding. It is settled from what `send` gives: a known outcome closes it;
	 * an `unknown` outcome, an unreadable one, or a `send` that throws leaves it
	 * unknown, which latches its run. A `ControlRefused` from the dispatch
	 * authority sent nothing, and closes it.
	 */
	async dispatch(bindingId: string, send: (binding: NativeBinding) => Promise<NativeOutcome>): Promise<DispatchResult> {
		if (this.#blocked) return refuse("blocked", this.#blocked);
		const before = this.#find(bindingId);
		if (!before) return refuse("unknown_binding", "No such binding is remembered");
		if (before.status !== "bound") return this.#spent(before);
		const held = this.#runHeld(before);
		if (held) return held;
		const { conversationId, toolTaskId, callId } = before.identity;
		const verified = await this.#verify({ conversationId, toolTaskId, callId });
		// Everything from here to the claim is checked against the document as it is now, with nothing awaited.
		if (this.#blocked) return refuse("blocked", this.#blocked);
		const record = this.#find(bindingId);
		if (!record) return refuse("unknown_binding", "No such binding is remembered");
		if (record.status !== "bound") return this.#spent(record);
		// An authority that failed says nothing of the call, which stays bound for a later dispatch to check afresh; any other refusal closes it.
		if (!verified.ok) return verified.reason === "authority_failed" ? verified : this.#close(record, verified);
		if (!sameIdentity(record.identity, verified.identity)) return this.#close(record, refuse("changed", "The call isn't the one it was bound as"));
		const heldNow = this.#runHeld(record);
		if (heldNow) return heldNow;
		const lease = this.#currentLease();
		if (!lease || lease.epoch !== record.lease.epoch || lease.leaseId !== record.lease.leaseId) {
			return this.#close(record, refuse("stale_lease", "The lease the call was bound under isn't the current one"));
		}
		const binding = bindingOf(record);
		if (!this.#setStatus(record.id, "claimed")) return refuse("blocked", "The dispatch couldn't be stored");

		let outcome: NativeOutcome | null;
		try {
			outcome = readNativeOutcome(await send(binding));
		} catch (error) {
			if (error instanceof ControlRefused) {
				this.#setStatus(record.id, "closed");
				return refuse("control_refused", "The computer's control state refused it");
			}
			outcome = null;
		}
		if (!outcome) {
			this.#setStatus(record.id, "unknown");
			return refuse("uncertain", "The call may have run, and nothing says whether it did");
		}
		this.#setStatus(record.id, dispatchEffect(outcome).uncertain ? "unknown" : "closed");
		return { ok: true, outcome };
	}

	/** Closes a binding not yet dispatched, such as one whose approval was denied or whose chat stopped. Nothing it says can be sent after. */
	release(bindingId: string): boolean {
		const record = this.#find(bindingId);
		if (this.#blocked || !record || record.status !== "bound") return false;
		return this.#setStatus(record.id, "closed");
	}

	/** The status of a binding, or null when it isn't remembered. */
	status(bindingId: string): NativeBindingStatus | null {
		return this.#find(bindingId)?.status ?? null;
	}

	/** Whether a call of run `runAnchor` is unknown, whichever agent, task or call it was: the run then sends nothing more. */
	#runUnknown(runAnchor: string): boolean {
		return this.#doc.records.some((record) => record.identity.runAnchor === runAnchor && record.status === "unknown");
	}

	/**
	 * Why a bound call can't be sent now because of its run: a call of the run
	 * is unknown, which closes it for good, or another is being sent, which
	 * leaves it bound. One call of a run is out at a time, as the host's run
	 * allows (`busy` in docs/cua-native-mcp.md).
	 */
	#runHeld(record: BoundRecord): Refused | null {
		const { runAnchor } = record.identity;
		if (this.#runUnknown(runAnchor)) return this.#close(record, runUncertain());
		if (this.#doc.records.some((other) => other.identity.runAnchor === runAnchor && other.status === "claimed")) {
			return refuse("run_busy", "Another call of this run is being sent");
		}
		return null;
	}

	/** The agent's lease now, or null when the person has control or it can't be read. */
	#currentLease(): ControlLease | null {
		try {
			return readLease(this.#lease());
		} catch {
			return null;
		}
	}

	#find(id: string): BindingRecord | undefined {
		return this.#doc.records.find((record) => record.id === id);
	}

	async #verify(claim: NativeIdentityClaim): Promise<{ ok: true; identity: NativeIdentity } | Refused> {
		let answer: unknown;
		try {
			answer = await this.#authority.verify(Object.freeze({ ...claim }));
		} catch {
			return refuse("authority_failed", "Who makes the call couldn't be established");
		}
		const read = readAnswer(answer);
		if (!read) return refuse("authority_failed", "Who makes the call couldn't be established");
		if (read.status === "refused") return refuse(read.reason, `Who makes the call couldn't be established (${read.reason})`);
		const { identity } = read;
		if (identity.owner !== this.#owner || CLAIM_KEYS.some((key) => identity[key] !== claim[key])) {
			return refuse("identity", "The call's identity isn't the one claimed");
		}
		return { ok: true, identity };
	}

	#spent(record: SpentRecord): Refused {
		if (record.status === "claimed") return refuse("dispatched", "The call was dispatched already");
		if (record.status === "unknown") return refuse("uncertain", "The call was dispatched, and may have run without an answer saying so");
		return refuse("closed", "The binding was closed");
	}

	/** Closes a bound call that can never be sent, and refuses with why. */
	#close(record: BoundRecord, refused: Refused): Refused {
		this.#setStatus(record.id, "closed");
		return refused;
	}

	/** Moves a binding on from `bound`, keeping it as a tombstone without its arguments. */
	#setStatus(id: string, status: SpentRecord["status"]): boolean {
		const records = this.#doc.records.map((record): BindingRecord => (record.id === id ? { ...record, status, arguments: null } : record));
		return this.#write({ ...this.#doc, records });
	}

	#write(doc: Document): boolean {
		// Nothing more is written once blocked: a restart reads what was stored, and takes a dispatch it can't see the end of as unknown.
		if (this.#blocked) {
			this.#doc = doc;
			return false;
		}
		try {
			this.#storage.write(JSON.stringify(doc));
		} catch {
			// It may or may not have been stored, so nothing more is bound or sent until a restart reads what was.
			this.#blocked = "the native bindings could not be stored";
			// What was decided is remembered, so a dispatch in flight is still taken as unknown, not sent again.
			this.#doc = doc;
			return false;
		}
		this.#doc = doc;
		return true;
	}

	#parse(raw: string): Document | string {
		if (raw.length > MAX_NATIVE_BINDINGS_CHARS) return "the stored native bindings are too large";
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			return "the stored native bindings are not JSON";
		}
		const fields = exactly(value, ["version", "owner", "records"]);
		if (!fields) return "the stored native bindings are malformed";
		if (fields.version !== NATIVE_BINDINGS_VERSION) return "the stored native bindings have an unknown version";
		if (fields.owner !== this.#owner) return "the stored native bindings belong to another space";
		const { records } = fields;
		if (!Array.isArray(records) || records.length > MAX_NATIVE_BINDINGS) return "the stored native bindings are malformed";
		const read: BindingRecord[] = [];
		for (const each of records) {
			const record = readRecord(each, this.#owner);
			if (!record) return "a stored native binding is malformed";
			const clash = read.find(
				(other) =>
					other.id === record.id ||
					other.identity.toolTaskId === record.identity.toolTaskId ||
					(other.identity.runAnchor === record.identity.runAnchor && other.identity.callId === record.identity.callId),
			);
			if (clash) return "the stored native bindings repeat a binding, tool task or call";
			read.push(record);
		}
		return { version: NATIVE_BINDINGS_VERSION, owner: this.#owner, records: read };
	}
}

const runUncertain = () => refuse("run_uncertain", "A call of this run may have run without an answer saying so");

/** Whether `doc` is within the bounds. Nothing is let go to make it so. */
function fits(doc: Document): boolean {
	return doc.records.length <= MAX_NATIVE_BINDINGS && JSON.stringify(doc).length <= MAX_NATIVE_BINDINGS_CHARS;
}

function sameIdentity(a: NativeIdentity, b: NativeIdentity): boolean {
	return IDENTITY_KEYS.every((key) => a[key] === b[key]);
}

function sameCall(record: BoundRecord, identity: NativeIdentity, request: NativeRequest): boolean {
	return sameIdentity(record.identity, identity) && record.tool === request.tool && JSON.stringify(record.arguments) === JSON.stringify(request.arguments);
}

function bindingOf(record: BoundRecord): NativeBinding {
	return Object.freeze({
		id: record.id,
		identity: Object.freeze({ ...record.identity }),
		tool: record.tool,
		arguments: record.arguments,
		lease: Object.freeze({ epoch: record.lease.epoch, leaseId: record.lease.leaseId }),
	});
}

/** The own data properties of a plain object when it has exactly `keys`, each read once; null otherwise, or when reading throws. */
function exactly<K extends string>(value: unknown, keys: readonly K[]): Record<K, unknown> | null {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
		const own = Reflect.ownKeys(value);
		if (own.length !== keys.length) return null;
		const fields = {} as Record<K, unknown>;
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
			fields[key] = descriptor.value;
		}
		return fields;
	} catch {
		return null;
	}
}

const identityPart = (value: unknown): value is string => typeof value === "string" && NATIVE_IDENTITY.test(value);

function readClaim(value: unknown): NativeIdentityClaim | null {
	const fields = exactly(value, CLAIM_KEYS);
	if (!fields || !CLAIM_KEYS.every((key) => identityPart(fields[key]))) return null;
	return Object.freeze(fields as Record<(typeof CLAIM_KEYS)[number], string>);
}

function readIdentity(value: unknown): NativeIdentity | null {
	const fields = exactly(value, IDENTITY_KEYS);
	if (!fields || !IDENTITY_KEYS.every((key) => identityPart(fields[key]))) return null;
	return Object.freeze(fields as Record<(typeof IDENTITY_KEYS)[number], string>);
}

function readAnswer(value: unknown): AuthorityAnswer | null {
	const verified = exactly(value, ["status", "identity"]);
	if (verified) {
		const identity = verified.status === "verified" ? readIdentity(verified.identity) : null;
		return identity ? { status: "verified", identity } : null;
	}
	const refused = exactly(value, ["status", "reason"]);
	if (refused?.status === "refused" && (AUTHORITY_REFUSALS as readonly unknown[]).includes(refused.reason)) {
		return { status: "refused", reason: refused.reason as AuthorityRefusal };
	}
	return null;
}

function readLease(value: unknown): ControlLease | null {
	const fields = exactly(value, ["epoch", "leaseId"]);
	if (!fields) return null;
	const { epoch, leaseId } = fields;
	if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0 || typeof leaseId !== "string" || leaseId === "") return null;
	return { epoch, leaseId };
}

/** A stored binding: a bound one with arguments `readNativeRequest` accepts, or a tombstone with none. */
function readRecord(value: unknown, owner: string): BindingRecord | null {
	const fields = exactly(value, RECORD_KEYS);
	if (!fields || !identityPart(fields.id) || !STATUSES.includes(fields.status as NativeBindingStatus)) return null;
	const identity = readIdentity(fields.identity);
	const lease = readLease(fields.lease);
	if (!identity || identity.owner !== owner || !lease) return null;
	const bound = fields.status === "bound";
	if (!bound && fields.arguments !== null) return null;
	const request = readNativeRequest({
		owner,
		agentId: identity.agentId,
		runId: identity.runAnchor,
		callId: identity.callId,
		tool: fields.tool,
		arguments: bound ? fields.arguments : {},
	});
	if (!request) return null;
	const base = { id: fields.id, identity, tool: request.tool, lease };
	return bound ? { ...base, status: "bound", arguments: request.arguments } : { ...base, status: fields.status as SpentRecord["status"], arguments: null };
}
