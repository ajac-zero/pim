import { dispatchEffect, NATIVE_IDENTITY, type NativeOutcome, type NativeRequest, readNativeOutcome, readNativeRequest } from "../computer/native-outcome";
import { type ConversationId, defineDoc, type TaskId, type Tx } from "@earendil-works/pi-durable";
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
 * run ID from a call, conversation, task or usage ID. Pim's authority is
 * `harnessAuthority`, which reads the run ID the harness minted when the run
 * started (Pim's local pi-durable patch, docs/pi-durable-run-identity.md).
 * The desktop's tools (./extensions/desktop.ts) make a binder only where
 * `Pim.nativeDesktop()` turns them on, which nothing but the tests does.
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
 * Each operation runs in one transaction its caller gives (`BinderScope`,
 * `Transact`): in Pim, one harness commit, holding the binder's document
 * (`NativeBindingsDoc`) and the authority's read of the call's tool task and
 * run, so an abort, a reset or a chat's deletion commits wholly before or
 * wholly after a claim. A write that fails latches the binder for as long as
 * the process lives; a restart reads what was stored, and a claim it can't
 * tell the end of comes back unknown.
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

/**
 * What one operation of the binder reads and writes, valid for one transaction only: the stored document and the
 * authority, both read in it. In Pim, that is one harness commit (`Tx`), so the authority's check of the tool task
 * and its run and the binder's write are one atomic step on the harness's commit line (docs/cua-native-identity.md).
 */
export type BinderScope = { readonly storage: NativeBindingStorage; readonly authority: NativeIdentityAuthority };
/** Runs `work` in one transaction, with that transaction's scope, and resolves once it has committed. */
export type Transact = <T>(work: (scope: BinderScope) => Promise<T> | T) => Promise<T>;
export type ClaimResult = { readonly ok: true; readonly binding: NativeBinding } | Refused;

export class NativeIdentityBinder {
	readonly #owner: string;
	readonly #lease: () => ControlLease | null;
	readonly #newId: () => string;
	/** Bindings this process claimed and hasn't settled: being sent. Any other claimed binding is from a process that ended, and is unknown. */
	readonly #inFlight = new Set<string>();
	/** Why a write failed; never cleared in this process. */
	#latched: string | null = null;

	/** A binder for space `owner`. It keeps no document: each operation reads the one its scope gives, and writes it back there. */
	constructor(owner: string, options: { lease: () => ControlLease | null; newId?: () => string }) {
		if (!NATIVE_IDENTITY.test(owner)) throw new TypeError("A native-call binder needs its space's own name as its owner.");
		this.#owner = owner;
		this.#lease = options.lease;
		this.#newId = options.newId ?? (() => crypto.randomUUID());
	}

	/** Why everything is refused in `scope`, or null: a write that failed in this process, or a stored document that can't be used. */
	blocked(scope: BinderScope): string | null {
		const loaded = this.#load(scope);
		return typeof loaded === "string" ? loaded : null;
	}

	/**
	 * Binds a native-app call before its approval is filed, in one transaction.
	 * The tool and arguments are copied (`readNativeRequest`) before anything is
	 * awaited, so the caller changing its objects while the authority answers
	 * changes nothing bound; then the authority vouches for the claim, and the
	 * binding is stored. A tool task bound before, such as one woken from its
	 * approval or rerun after a restart, gets its original binding back, lease
	 * included, if it is exactly the same call and its run is still sure; if
	 * the call differs, or a call of its run is unknown, the binding is closed.
	 * A tool task or call bound before and spent is never bound again.
	 */
	async bind(scope: BinderScope, claim: NativeIdentityClaim, tool: unknown, args: unknown): Promise<BindResult> {
		if (this.#latched) return refuse("blocked", this.#latched);
		const read = readClaim(claim);
		if (!read) return refuse("invalid_request", "The call's claim isn't a conversation, tool task and call ID");
		const copy = readNativeRequest({ owner: this.#owner, agentId: UNVERIFIED, runId: UNVERIFIED, callId: read.callId, tool, arguments: args });
		if (!copy) return refuse("invalid_request", "The call names no curated tool, or its arguments aren't a plain JSON object of a bounded size");
		const verified = await this.#verify(scope, read);
		if (!verified.ok) return verified;
		const { identity } = verified;
		const doc = this.#load(scope);
		if (typeof doc === "string") return refuse("blocked", doc);
		const { records } = doc;
		const earlier = records.find((record) => record.identity.toolTaskId === identity.toolTaskId);
		if (earlier) {
			if (earlier.status !== "bound") return this.#spent(earlier);
			if (!sameCall(earlier, identity, copy)) return this.#close(scope, doc, earlier, refuse("changed", "The call isn't the one its tool task was bound as"));
			if (runUnknown(doc, identity.runAnchor)) return this.#close(scope, doc, earlier, runUncertain());
			return { ok: true, binding: bindingOf(earlier), replayed: true };
		}
		if (records.some((record) => record.identity.runAnchor === identity.runAnchor && record.identity.callId === identity.callId)) {
			return refuse("ambiguous_call", "Another call of this run has the same call ID");
		}
		if (runUnknown(doc, identity.runAnchor)) return runUncertain();
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
		const next = { ...doc, records: [...records, record] };
		if (!fits(next)) return refuse("full", "The binder remembers as many bindings as it may");
		if (!this.#write(scope, next)) return refuse("blocked", "The binding couldn't be stored");
		return { ok: true, binding: bindingOf(record), replayed: false };
	}

	/**
	 * Claims a bound call for sending, in one transaction: the authority vouches
	 * for it again, the lease must still be the one it was bound under, and no
	 * call of its run may be unknown (which closes it) or being sent (which
	 * refuses it, still bound). It is then stored as claimed, and from that
	 * commit on it is taken as possibly sent: whatever commits after can't make
	 * it unsent. The caller sends it once and settles it (`settle`).
	 */
	async claim(scope: BinderScope, bindingId: string): Promise<ClaimResult> {
		if (this.#latched) return refuse("blocked", this.#latched);
		const before = this.#load(scope);
		if (typeof before === "string") return refuse("blocked", before);
		const found = before.records.find((record) => record.id === bindingId);
		if (!found) return refuse("unknown_binding", "No such binding is remembered");
		if (found.status !== "bound") return this.#spent(found);
		const { conversationId, toolTaskId, callId } = found.identity;
		const verified = await this.#verify(scope, { conversationId, toolTaskId, callId });
		const doc = this.#load(scope);
		if (typeof doc === "string") return refuse("blocked", doc);
		const record = doc.records.find((each) => each.id === bindingId);
		if (!record) return refuse("unknown_binding", "No such binding is remembered");
		if (record.status !== "bound") return this.#spent(record);
		// An authority that failed says nothing of the call, which stays bound for a later dispatch to check afresh; any other refusal closes it.
		if (!verified.ok) return verified.reason === "authority_failed" ? verified : this.#close(scope, doc, record, verified);
		if (!sameIdentity(record.identity, verified.identity)) return this.#close(scope, doc, record, refuse("changed", "The call isn't the one it was bound as"));
		if (runUnknown(doc, record.identity.runAnchor)) return this.#close(scope, doc, record, runUncertain());
		if (doc.records.some((other) => other.identity.runAnchor === record.identity.runAnchor && other.status === "claimed")) {
			return refuse("run_busy", "Another call of this run is being sent");
		}
		const lease = this.#currentLease();
		if (!lease || lease.epoch !== record.lease.epoch || lease.leaseId !== record.lease.leaseId) {
			return this.#close(scope, doc, record, refuse("stale_lease", "The lease the call was bound under isn't the current one"));
		}
		if (!this.#setStatus(scope, doc, record.id, "claimed")) return refuse("blocked", "The dispatch couldn't be stored");
		this.#inFlight.add(record.id);
		return { ok: true, binding: bindingOf(record) };
	}

	/**
	 * Settles a claimed call from what sending it gave: a known outcome closes
	 * it; an `unknown` outcome, an unreadable one, or a send that threw leaves
	 * it unknown for good, which latches its run. A `ControlRefused` thrown by
	 * the dispatch authority sent nothing, and closes it. If this isn't stored,
	 * the binding stays claimed, which a later operation reads as unknown.
	 */
	settle(scope: BinderScope, bindingId: string, sent: { readonly outcome: unknown } | { readonly thrown: unknown }): DispatchResult {
		this.#inFlight.delete(bindingId);
		let outcome: NativeOutcome | null = null;
		let refused = false;
		if ("thrown" in sent) refused = sent.thrown instanceof ControlRefused;
		else outcome = readNativeOutcome(sent.outcome);
		const status = refused ? "closed" : !outcome || dispatchEffect(outcome).uncertain ? "unknown" : "closed";
		const doc = this.#load(scope);
		if (typeof doc !== "string" && doc.records.some((record) => record.id === bindingId && (record.status === "claimed" || record.status === "unknown"))) {
			this.#setStatus(scope, doc, bindingId, status);
		}
		if (refused) return refuse("control_refused", "The computer's control state refused it");
		if (!outcome) return refuse("uncertain", "The call may have run, and nothing says whether it did");
		return { ok: true, outcome };
	}

	/**
	 * Sends a bound call once, when asked to; nothing here retries. It is
	 * claimed in one transaction (`claim`), sent with `send` outside any, and
	 * settled in another (`settle`).
	 */
	async dispatch(transact: Transact, bindingId: string, send: (binding: NativeBinding) => Promise<NativeOutcome>): Promise<DispatchResult> {
		let claimed: ClaimResult;
		try {
			claimed = await transact((scope) => this.claim(scope, bindingId));
		} catch {
			// The claim wasn't committed, so nothing may be sent; the binding is as it was stored.
			this.#inFlight.delete(bindingId);
			return refuse("blocked", "The dispatch couldn't be stored");
		}
		if (!claimed.ok) return claimed;
		let sent: { outcome: unknown } | { thrown: unknown };
		try {
			sent = { outcome: await send(claimed.binding) };
		} catch (thrown) {
			sent = { thrown };
		}
		try {
			return await transact((scope) => this.settle(scope, bindingId, sent));
		} catch {
			// Not stored: it stays claimed, which every later operation reads as unknown.
			this.#inFlight.delete(bindingId);
			return refuse("uncertain", "The call may have run, and its end couldn't be stored");
		}
	}

	/** Closes a binding not yet dispatched, such as one whose approval was denied or whose chat stopped. Nothing it says can be sent after. */
	release(scope: BinderScope, bindingId: string): boolean {
		if (this.#latched) return false;
		const doc = this.#load(scope);
		if (typeof doc === "string") return false;
		const record = doc.records.find((each) => each.id === bindingId);
		if (!record || record.status !== "bound") return false;
		return this.#setStatus(scope, doc, record.id, "closed");
	}

	/**
	 * The runs with a call whose end is unknown, each once, or why the
	 * document can't be used. A call claimed by a process that ended is
	 * unknown from this read on (`#load`); one this process is sending isn't.
	 */
	unknownRuns(scope: BinderScope): string[] | string {
		const doc = this.#load(scope);
		if (typeof doc === "string") return doc;
		return [...new Set(doc.records.filter((record) => record.status === "unknown").map((record) => record.identity.runAnchor))];
	}

	/** The status of a binding, or null when it isn't remembered or the document can't be read. */
	status(scope: BinderScope, bindingId: string): NativeBindingStatus | null {
		const doc = this.#load(scope);
		return typeof doc === "string" ? null : (doc.records.find((record) => record.id === bindingId)?.status ?? null);
	}

	/**
	 * The stored document, or why it can't be used. A binding stored as
	 * claimed that this process isn't sending was claimed by a process that
	 * ended before or after sending it: it is unknown, and written back so.
	 */
	#load(scope: BinderScope): Document | string {
		if (this.#latched) return this.#latched;
		let raw: string | undefined;
		try {
			raw = scope.storage.read();
		} catch {
			return "the stored native bindings can't be read";
		}
		if (raw === undefined) return { version: NATIVE_BINDINGS_VERSION, owner: this.#owner, records: [] };
		const loaded = this.#parse(raw);
		if (typeof loaded === "string") return loaded;
		if (!loaded.records.some((record) => record.status === "claimed" && !this.#inFlight.has(record.id))) return loaded;
		const records = loaded.records.map((record): BindingRecord =>
			record.status === "claimed" && !this.#inFlight.has(record.id) ? { ...record, status: "unknown" } : record,
		);
		const restored = { ...loaded, records };
		// Taken as unknown even if this write fails, which then latches the binder.
		this.#write(scope, restored);
		return this.#latched ?? restored;
	}

	/** The agent's lease now, or null when the person has control or it can't be read. */
	#currentLease(): ControlLease | null {
		try {
			return readLease(this.#lease());
		} catch {
			return null;
		}
	}

	async #verify(scope: BinderScope, claim: NativeIdentityClaim): Promise<{ ok: true; identity: NativeIdentity } | Refused> {
		let answer: unknown;
		try {
			answer = await scope.authority.verify(Object.freeze({ ...claim }));
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

	#spent(record: BindingRecord): Refused {
		if (record.status === "claimed") return refuse("dispatched", "The call was dispatched already");
		if (record.status === "unknown") return refuse("uncertain", "The call was dispatched, and may have run without an answer saying so");
		return refuse("closed", "The binding was closed");
	}

	/** Closes a bound call that can never be sent, and refuses with why. */
	#close(scope: BinderScope, doc: Document, record: BoundRecord, refused: Refused): Refused {
		this.#setStatus(scope, doc, record.id, "closed");
		return refused;
	}

	/** Moves a binding on from `bound`, keeping it as a tombstone without its arguments. */
	#setStatus(scope: BinderScope, doc: Document, id: string, status: SpentRecord["status"]): boolean {
		const records = doc.records.map((record): BindingRecord => (record.id === id ? { ...record, status, arguments: null } : record));
		return this.#write(scope, { ...doc, records });
	}

	#write(scope: BinderScope, doc: Document): boolean {
		// Nothing more is written once latched: a restart reads what was stored, and takes a dispatch it can't see the end of as unknown.
		if (this.#latched) return false;
		try {
			scope.storage.write(JSON.stringify(doc));
		} catch {
			// It may or may not have been stored, so nothing more is bound or sent until a restart reads what was.
			this.#latched = "the native bindings could not be stored";
			return false;
		}
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

/** Whether a call of run `runAnchor` is unknown, whichever agent, task or call it was: the run then sends nothing more. */
function runUnknown(doc: Document, runAnchor: string): boolean {
	return doc.records.some((record) => record.identity.runAnchor === runAnchor && record.status === "unknown");
}

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

/**
 * Where a space's harness keeps its binder's document: a Pim-defined document
 * on the harness's own commit line, so the authority's read of a call's tool
 * task and run and the binder's write are one transaction (`BinderScope`).
 * It holds the document's JSON as text, which the binder checks whole.
 */
export const NativeBindingsDoc = defineDoc<{ text?: string }>({ kind: "pim.native-bindings", version: 1, scope: "session", initial: () => ({}) });

/** The binder's scope in one harness transaction: its document there, and the authority reading that same transaction. */
export async function harnessScope(tx: Tx, authority: (tx: Tx) => NativeIdentityAuthority): Promise<BinderScope> {
	const draft = await tx.doc(NativeBindingsDoc);
	return {
		storage: {
			read: () => draft.text,
			write: (value) => {
				draft.text = value;
			},
		},
		authority: authority(tx),
	};
}

const LIVE_TASK = new Set(["pending", "running", "waiting"]);

/**
 * The run authority over Pim's harness, reading `tx`, the transaction the
 * binder writes in: the call's `pi.tool` task must exist, be live and not
 * marked for abort, be the claim's conversation and call, and carry the run
 * ID its generation stamped on it when it was made; the conversation's run
 * must be going now under that same ID (`Tx.run`, in Pim's local pi-durable
 * patch, docs/pi-durable-run-identity.md). The agent is the one Pim records
 * for the conversation (`agentOf`), and a chat Pim has marked deleted is
 * refused, as its run is about to be aborted. The run anchor is the run ID
 * the harness minted, as a string; nothing of it is derived from the call,
 * task or chat. A call or run from before run IDs is refused as `legacy`.
 */
export function harnessAuthority(
	tx: Tx,
	options: { owner: string; agentOf: (conversationId: string) => string; deleted: (conversationId: string) => boolean },
): NativeIdentityAuthority {
	const refused = (reason: AuthorityRefusal): AuthorityAnswer => ({ status: "refused", reason });
	return {
		async verify(claim) {
			const conversationId = Number(claim.conversationId);
			const toolTaskId = Number(claim.toolTaskId);
			if (!Number.isSafeInteger(conversationId) || !Number.isSafeInteger(toolTaskId) || String(toolTaskId) !== claim.toolTaskId || String(conversationId) !== claim.conversationId) {
				return refused("missing");
			}
			const task = await tx.task(toolTaskId as TaskId);
			if (!task) return refused("missing");
			const input = task.input as { callId?: unknown; runId?: unknown } | null;
			if (task.kind !== "pi.tool" || task.conversationId !== conversationId || input?.callId !== claim.callId) return refused("ambiguous");
			if (!LIVE_TASK.has(task.state.status) || task.abortRequested) return refused("stopped");
			if (typeof input.runId !== "number") return refused("legacy");
			const run = await tx.run(conversationId as ConversationId);
			if (!run) return refused("stopped");
			if (run.id === null) return refused("legacy");
			if (run.id !== input.runId) return refused("not_run_owned");
			if (options.deleted(claim.conversationId)) return refused("stopped");
			return { status: "verified", identity: { owner: options.owner, agentId: options.agentOf(claim.conversationId), ...claim, runAnchor: String(run.id) } };
		},
	};
}
