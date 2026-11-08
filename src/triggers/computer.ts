/**
 * The space's side of triggers that run on the person's computer: what
 * pim-computer's triggers runtime (../../computer/triggers-runtime.ts and
 * ../../computer/triggers-host.ts) says over the computer's own connection,
 * in `triggers.v1`, is answered here, as docs/triggers-runtime.md, "What the
 * space must do", asks. The runtime's `hello` is checked against the runtime
 * id the stored token's digest names; the space keeps its epoch with that
 * runtime durably; it reconciles the enabled computer triggers that have a
 * current grant, with a lease it renews; it takes observations into
 * `TriggerStore` with `admit` and gaps with `recordGap`, and acknowledges
 * each only once that write has returned from its transaction; and it reads
 * everything else the runtime says as health, never as an observation.
 *
 * A grant is the person's own decision. `ComputerGrants` keeps one record
 * per grant, named by the approval it came from, and a grant is current
 * only while that approval was approved by the person themselves (not a
 * timeout, an "always approve" or the majordomo), for exactly one source of
 * one trigger on one computer, and the record isn't revoked. Nothing files
 * such approvals yet, and nothing here asks for one.
 *
 * Behind a gate. Pim builds this only when `PIM_TRIGGERS_COMPUTER` is
 * `internal`, which nothing sets, in a space whose trigger engine is on
 * (./engine.ts). Off, nothing of it is built, no table is made, and a
 * triggers message from the computer goes where it went before, to
 * `Computer.receive`, which ignores it. Computer triggers' occurrences are
 * taken into the store's outbox, and nothing hands them on yet: the
 * coordinator hands on only time firings and connectors' events.
 */

import { createHash } from "node:crypto";
import type { Approval } from "../store";
import { type FileSource, type PollSource, type ProcessSource, runsOnComputer, type StreamSource, type TriggerHealth } from "./spec";
import type { Admission, AuthorizationRequest, AuthorizationVerdict, Trigger, TriggerStore } from "./store";
import { TriggerValidationError } from "./validate";

/** The deployment's gate: unset, or anything but `internal`, and nothing of computer triggers is built. */
export const COMPUTER_TRIGGERS_VARIABLE = "PIM_TRIGGERS_COMPUTER";

/** Whether this deployment answers computer triggers, in spaces whose trigger engine is on. */
export function computerTriggersAllowed(env: unknown): boolean {
	return (env as Record<string, unknown> | null)?.[COMPUTER_TRIGGERS_VARIABLE] === "internal";
}

export const PROTOCOL = "triggers.v1";

/** How every triggers message on the computer's connection begins, both ways (computer/triggers-host.ts's `TRIGGERS_ENVELOPE`); the frame follows as it is, then one `}`. */
export const TRIGGERS_ENVELOPE = '{"type":"triggers","frame":';

/** The approval's action a grant comes from. Its arguments are exactly the grant's scope. */
export const COMPUTER_GRANT_ACTION = "trigger_computer_source";

/** Every table this makes, for the person's export and what a space still holds. */
export const COMPUTER_TABLES = ["pim_trigger_computer_runtimes", "pim_trigger_computer_grants"] as const;

export const COMPUTER_LIMITS = {
	/** The lease each reconcile asks for, and the most the runtime takes. */
	leaseMs: 120_000,
	/** The most bytes one reconcile may have: what the runtime reads by default (`inboundBytes`). */
	reconcileBytes: 1_048_576,
	/** The most sources one reconcile may want. */
	sources: 256,
	/** The most bytes a message from the computer may have: the runtime's largest frame (64 KiB) in its envelope. */
	inboundBytes: 65_536 + TRIGGERS_ENVELOPE.length + 1,
} as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_trigger_computer_runtimes (
	runtime_id TEXT PRIMARY KEY,
	server_epoch INTEGER NOT NULL,
	desired_revision INTEGER NOT NULL,
	desired_digest TEXT,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_trigger_computer_grants (
	grant_ref TEXT PRIMARY KEY,
	trigger_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	config_hash TEXT NOT NULL,
	runtime_id TEXT NOT NULL,
	granted_at INTEGER NOT NULL,
	revoked_at INTEGER
);
`;

type ComputerSource = PollSource | StreamSource | ProcessSource | FileSource;

/** An id as the protocol takes it: printable ASCII other than `"` and `\`. */
const IDENT = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const ID_LENGTH = 160;
const GRANT_REF_LENGTH = 256;
const HEALTH_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** The digest of a source's configuration, as the runtime computes it (`sourceConfigHash` there): every field of it. */
export function sourceConfigHash(source: ComputerSource): string {
	return sha256(`${PROTOCOL}/source\n${canonical(source)}`);
}

/** The scope a grant consents to: one source's exact configuration, of one trigger, on one computer of one space. */
export type GrantScope = { readonly space: string; readonly runtimeId: string; readonly triggerId: string; readonly sourceId: string; readonly configHash: string };

/** The digest of a grant's scope under its reference, as the computer checks it (`grantScopeHash` in computer/triggers-host.ts). */
export function grantScopeHash(scope: GrantScope & { readonly grantRef: string }): string {
	const sorted = { configHash: scope.configHash, grantRef: scope.grantRef, runtimeId: scope.runtimeId, sourceId: scope.sourceId, space: scope.space, triggerId: scope.triggerId };
	return sha256(`${PROTOCOL}/grant\n${JSON.stringify(sorted)}`);
}

/** The runtime id of the computer whose token has this digest (the digest the space keeps), as computer/triggers-host.ts's `triggersBinding` makes it; null with none. */
export function runtimeIdOf(tokenDigest: string | null): string | null {
	return tokenDigest === null ? null : `rt_${sha256(`${PROTOCOL}/runtime\n${tokenDigest}`).slice(0, 32)}`;
}

function ident(value: unknown, max = ID_LENGTH): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= max && IDENT.test(value);
}

function int(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function plain(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** An object with exactly these keys. */
function exactly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (!plain(value)) return false;
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** The scope an approval consents to, when it is current: a grant of a computer source that the person themselves approved for this space. */
function approvedScope(approval: Approval | undefined, space: string): GrantScope | null {
	if (!approval || approval.action !== COMPUTER_GRANT_ACTION || approval.status !== "approved" || approval.decidedBy !== "user" || approval.requestedBy !== null) return null;
	const args = approval.args;
	if (!exactly(args, ["space", "runtimeId", "triggerId", "sourceId", "configHash"])) return null;
	const { runtimeId, triggerId, sourceId, configHash } = args;
	if (args.space !== space || !ident(runtimeId) || !ident(triggerId) || !ident(sourceId) || typeof configHash !== "string" || !HEX64.test(configHash)) return null;
	return { space, runtimeId, triggerId, sourceId, configHash };
}

const sameScope = (a: GrantScope, b: GrantScope) => a.space === b.space && a.runtimeId === b.runtimeId && a.triggerId === b.triggerId && a.sourceId === b.sourceId && a.configHash === b.configHash;

/**
 * The grants of computer sources: one record per grant, named by the
 * approval it came from (`grant_ref`, the approval's id, which is the
 * trigger's `authorizationRef`). A record is made only from an approval the
 * person approved for exactly that scope, and is current only while it
 * isn't revoked and its approval still says so.
 */
export class ComputerGrants {
	readonly #sql: SqlStorage;
	readonly #approval: (id: string) => Approval | undefined;
	readonly #space: string;
	readonly #now: () => number;

	constructor(sql: SqlStorage, options: { readonly approval: (id: string) => Approval | undefined; readonly space: string; readonly now: () => number }) {
		this.#sql = sql;
		this.#approval = options.approval;
		this.#space = options.space;
		this.#now = options.now;
		this.#sql.exec(SCHEMA);
	}

	/** Records the grant an approval gives. Refused for an approval that isn't the person's own decision to grant one computer source, and for one revoked before. */
	record(approvalId: string): { ok: true; scope: GrantScope } | { ok: false; reason: "not_approved" | "revoked" } {
		const scope = approvedScope(this.#approval(approvalId), this.#space);
		if (!scope) return { ok: false, reason: "not_approved" };
		const known = this.#sql.exec("SELECT revoked_at FROM pim_trigger_computer_grants WHERE grant_ref = ?", approvalId).toArray()[0];
		if (known && known.revoked_at !== null) return { ok: false, reason: "revoked" };
		if (!known) {
			this.#sql.exec(
				"INSERT INTO pim_trigger_computer_grants (grant_ref, trigger_id, source_id, config_hash, runtime_id, granted_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
				approvalId,
				scope.triggerId,
				scope.sourceId,
				scope.configHash,
				scope.runtimeId,
				this.#now(),
			);
		}
		return { ok: true, scope };
	}

	/** Revokes a grant, for good: its source stops at the next reconcile, and nothing it observes is taken in from now on. */
	revoke(grantRef: string): boolean {
		return this.#sql.exec("UPDATE pim_trigger_computer_grants SET revoked_at = ? WHERE grant_ref = ? AND revoked_at IS NULL", this.#now(), grantRef).rowsWritten > 0;
	}

	/** The scope of a current grant: recorded, not revoked, and its approval still the person's own for exactly that scope. */
	current(grantRef: string | null): GrantScope | null {
		if (grantRef === null) return null;
		const row = this.#sql.exec("SELECT * FROM pim_trigger_computer_grants WHERE grant_ref = ? AND revoked_at IS NULL", grantRef).toArray()[0];
		if (!row) return null;
		const scope = approvedScope(this.#approval(grantRef), this.#space);
		const recorded: GrantScope = { space: this.#space, runtimeId: String(row.runtime_id), triggerId: String(row.trigger_id), sourceId: String(row.source_id), configHash: String(row.config_hash) };
		return scope && sameScope(scope, recorded) ? scope : null;
	}

	/** Whether `grantRef` is a current grant of exactly this scope. */
	covers(grantRef: string | null, scope: GrantScope): boolean {
		const current = this.current(grantRef);
		return current !== null && sameScope(current, scope);
	}

	/**
	 * The store's `authorize` (TriggerStore's option): a computer source may
	 * be enabled only under a current grant for this trigger, this exact
	 * configuration and the computer paired now (`runtimeId`). Which source
	 * identity it is for is checked at every reconcile and admission.
	 */
	authorize(runtimeId: () => string | null): (request: AuthorizationRequest) => AuthorizationVerdict {
		return (request) => {
			const source = request.spec.source;
			if (!runsOnComputer(source)) return { ok: false, reason: "not a computer source" };
			const scope = this.current(request.authorizationRef);
			const paired = runtimeId();
			if (!scope || paired === null || scope.runtimeId !== paired) return { ok: false, reason: "no current grant for this computer" };
			if (scope.triggerId !== request.triggerId || scope.configHash !== sourceConfigHash(source as ComputerSource)) return { ok: false, reason: "the grant is for another source" };
			return { ok: true };
		};
	}
}

/** The computer's connection, as much as this uses: an id per socket, and sending a text message on it. */
export type TriggersSocket = { readonly id: string; send(message: string): void };

export type ComputerTriggersOptions = {
	readonly store: TriggerStore;
	readonly grants: ComputerGrants;
	/** The database's transactions (`transactionSync`). */
	readonly transaction: <T>(work: () => T) => T;
	readonly now: () => number;
	/** The space's owner, which the computer's token names. */
	readonly space: string;
	/** The digest of the paired computer's token, as the space keeps it; null with none paired. */
	readonly tokenDigest: () => string | null;
	readonly setTimer: (ms: number, run: () => void) => () => void;
	/** The lease each reconcile asks for: at most, and by default, 120 seconds. */
	readonly leaseMs?: number;
	/** The most bytes one reconcile may have; at most, and by default, 1 MiB. */
	readonly reconcileBytes?: number;
};

type Desired = {
	readonly triggerId: string;
	readonly sourceId: string;
	readonly revision: number;
	readonly generation: number;
	readonly configHash: string;
	readonly source: ComputerSource;
	readonly grant: { readonly grantRef: string; readonly scopeHash: string };
	readonly checkpoint: { readonly position: number; readonly cursor: string | null } | null;
};

/** One socket the runtime said `hello` on. */
type Link = {
	readonly socket: TriggersSocket;
	/** Null when its `hello` named another runtime: nothing of triggers is said on it. */
	readonly runtimeId: string | null;
	readonly connectionId: string;
	readonly epoch: number;
	/** Reconciles sent and not yet answered in full, oldest first, with when each was sent. */
	sent: { revision: number; at: number }[];
	/** The answer being put together: its revision and the parts seen. */
	answer: { revision: number; parts: number; seen: Map<number, readonly { triggerId: string; generation: number; state: string }[]> } | null;
	/** Until when the space takes observations on this socket: a lease counted from when the last reconcile answered in full was sent. */
	leaseUntil: number;
	renew: (() => void) | null;
};

/** What a message from the computer says, read strictly; anything else is dropped. */
type Frame = Record<string, unknown> & { readonly type: string };

const ACK_RESULT: Record<Admission["status"], "accepted" | "duplicate" | "deferred" | "rejected"> = {
	accepted: "accepted",
	duplicate: "duplicate",
	backpressure: "deferred",
	inbox_full: "deferred",
	not_found: "rejected",
	deleted: "rejected",
	stale_generation: "rejected",
	not_enabled: "rejected",
	wrong_source: "rejected",
	out_of_order: "rejected",
	too_old: "rejected",
	expired: "rejected",
	not_due: "rejected",
	schedule_mismatch: "rejected",
	before_enabled: "rejected",
};

/** The healths the computer's connection may replace. */
const CONNECTION_HEALTHS: readonly TriggerHealth[] = ["unknown", "healthy", "reconnecting", "waiting_computer", "gap"];

/** How long a deferred observation waits before the runtime sends it again. */
const RETRY_AFTER_MS = 30_000;

/**
 * Computer triggers over the computer's connection. `receive` takes every
 * triggers message from the computer (and only those: it returns false for
 * anything else); `closed` is told when a socket closes; `refresh` sends the
 * desired set again after a trigger or a grant changed.
 */
export class ComputerTriggers {
	readonly #sql: SqlStorage;
	readonly #options: ComputerTriggersOptions;
	readonly #leaseMs: number;
	readonly #reconcileBytes: number;
	#link: Link | null = null;

	constructor(sql: SqlStorage, options: ComputerTriggersOptions) {
		this.#sql = sql;
		this.#options = options;
		this.#leaseMs = Math.min(options.leaseMs ?? COMPUTER_LIMITS.leaseMs, COMPUTER_LIMITS.leaseMs);
		this.#reconcileBytes = Math.min(options.reconcileBytes ?? COMPUTER_LIMITS.reconcileBytes, COMPUTER_LIMITS.reconcileBytes);
		this.#sql.exec(SCHEMA);
	}

	/** The runtime id of the computer paired now, or null with none. */
	runtimeId(): string | null {
		return runtimeIdOf(this.#options.tokenDigest());
	}

	/** A message from the computer on `socket`. A triggers message is taken here, whatever it holds, and true returned; anything else is left alone. */
	receive(socket: TriggersSocket, message: string): boolean {
		if (!message.startsWith(TRIGGERS_ENVELOPE)) return false;
		if (message.length > COMPUTER_LIMITS.inboundBytes || bytes(message) > COMPUTER_LIMITS.inboundBytes || !message.endsWith("}")) return true;
		let frame: unknown;
		try {
			frame = JSON.parse(message.slice(TRIGGERS_ENVELOPE.length, -1));
		} catch {
			return true;
		}
		if (!plain(frame) || frame.protocol !== PROTOCOL || typeof frame.type !== "string") return true;
		const read = frame as Frame;
		if (read.type === "hello") {
			this.#hello(socket, read);
			return true;
		}
		const link = this.#link;
		if (!link || link.socket.id !== socket.id || link.runtimeId === null) return true;
		switch (read.type) {
			case "reconciled":
				this.#reconciled(link, read);
				break;
			case "observation":
				this.#observation(link, read);
				break;
			case "gap":
				this.#gap(link, read);
				break;
			case "installed":
			case "health":
			case "stopped":
				this.#health(link, read);
				break;
		}
		return true;
	}

	/** The socket closed: its triggers wait for the computer, and nothing more is sent on it. */
	closed(socket: TriggersSocket): void {
		const link = this.#link;
		if (!link || link.socket.id !== socket.id) return;
		link.renew?.();
		this.#link = null;
		if (link.runtimeId !== null) this.#setHealthAll("waiting_computer", null);
	}

	/** Says nothing more on the current socket, and renews nothing: for turning triggers off. */
	stop(): void {
		this.#link?.renew?.();
		this.#link = null;
	}

	/** Sends the desired set again on the current socket, as after a trigger or a grant changed. */
	refresh(): void {
		const link = this.#link;
		if (link && link.runtimeId !== null) this.#reconcile(link);
	}

	// What the runtime says.

	#hello(socket: TriggersSocket, frame: Frame): void {
		if (!exactly(frame, ["protocol", "type", "runtimeId", "connectionId", "lastEpoch", "pending"])) return;
		const { runtimeId, connectionId, lastEpoch, pending } = frame;
		if (!ident(runtimeId) || !ident(connectionId) || !(lastEpoch === null || int(lastEpoch, 0)) || !int(pending, 0)) return;
		this.#link?.renew?.();
		this.#link = null;
		const expected = this.runtimeId();
		if (expected === null || runtimeId !== expected) {
			// Another computer's runtime, or a token since replaced: this socket's triggers are ignored.
			this.#link = { socket, runtimeId: null, connectionId, epoch: 0, sent: [], answer: null, leaseUntil: 0, renew: null };
			return;
		}
		const epoch = this.#options.transaction(() => this.#epochFor(runtimeId, lastEpoch));
		const link: Link = { socket, runtimeId, connectionId, epoch, sent: [], answer: null, leaseUntil: 0, renew: null };
		this.#link = link;
		this.#setHealthAll("reconnecting", null);
		this.#reconcile(link);
	}

	#reconciled(link: Link, frame: Frame): void {
		if (!exactly(frame, ["protocol", "type", "serverEpoch", "desiredRevision", "leaseMs", "part", "parts", "sources"])) return;
		const { serverEpoch, desiredRevision, part, parts, sources } = frame;
		if (serverEpoch !== link.epoch || !int(desiredRevision, 0) || !int(parts, 1, COMPUTER_LIMITS.sources) || !int(part, 1, parts) || !Array.isArray(sources)) return;
		const read: { triggerId: string; generation: number; state: string }[] = [];
		for (const source of sources) {
			if (!exactly(source, ["triggerId", "sourceId", "generation", "state"]) || !ident(source.triggerId) || !int(source.generation, 0) || typeof source.state !== "string") return;
			read.push({ triggerId: source.triggerId, generation: source.generation, state: source.state });
		}
		if (!link.sent.some((sent) => sent.revision === desiredRevision)) return;
		if (!link.answer || link.answer.revision !== desiredRevision || link.answer.parts !== parts) link.answer = { revision: desiredRevision, parts, seen: new Map() };
		link.answer.seen.set(part, read);
		if (link.answer.seen.size < parts) return;
		// Answered in full: the lease holds from when the earliest reconcile of this revision still unanswered was sent.
		const index = link.sent.findIndex((sent) => sent.revision === desiredRevision);
		link.leaseUntil = Math.max(link.leaseUntil, link.sent[index]!.at + this.#leaseMs);
		link.sent = link.sent.slice(index + 1);
		const answered = [...link.answer.seen.values()].flat();
		link.answer = null;
		for (const source of answered) {
			if (source.state === "invalid") this.#setHealth(source.triggerId, source.generation, "configuration_error", "invalid");
			else if (source.state === "running") this.#setHealth(source.triggerId, source.generation, "healthy", null, ["reconnecting", "waiting_computer", "unknown"]);
		}
	}

	#health(link: Link, frame: Frame): void {
		const base = ["protocol", "type", "serverEpoch", "triggerId", "sourceId", "generation"];
		const keys = frame.type === "installed" ? [...base, "configHash"] : frame.type === "health" ? [...base, "status", "code"] : [...base, "reason", "adapter"];
		if (!exactly(frame, keys) || frame.serverEpoch !== link.epoch) return;
		const { triggerId, generation } = frame;
		if (!ident(triggerId) || !int(generation, 0)) return;
		if (frame.type === "installed") {
			this.#setHealth(triggerId, generation, "healthy", null);
			return;
		}
		if (frame.type === "health") {
			const { status, code } = frame;
			if (typeof code !== "string" || !HEALTH_CODE.test(code)) return;
			if (status === "ok") this.#setHealth(triggerId, generation, "healthy", null);
			else if (status === "degraded") this.#setHealth(triggerId, generation, "gap", code);
			else if (status === "error") this.#setHealth(triggerId, generation, code === "auth_denied" ? "auth_required" : "configuration_error", code);
			return;
		}
		const reason = frame.reason;
		if (typeof reason !== "string" || !HEALTH_CODE.test(reason)) return;
		if (reason === "revoked" || reason === "consent_changed") this.#setHealth(triggerId, generation, "auth_required", reason);
		else if (reason === "invalid" || reason === "start_failed") this.#setHealth(triggerId, generation, "configuration_error", reason);
	}

	#observation(link: Link, frame: Frame): void {
		const keys = ["protocol", "type", "serverEpoch", "eventId", "triggerId", "sourceId", "revision", "generation", "sequence", "occurredAt", "data", "checkpoint", "coalesced"];
		if (!exactly(frame, keys) || frame.serverEpoch !== link.epoch || !this.#taking(link)) return;
		const { eventId, triggerId, sourceId, revision, generation, sequence, occurredAt, data, checkpoint, coalesced } = frame;
		if (!ident(eventId) || !ident(triggerId) || !ident(sourceId) || !int(revision, 1) || !int(generation, 0) || !int(sequence, 1) || !int(occurredAt, 0) || !plain(data)) return;
		if (!(checkpoint === null || (exactly(checkpoint, ["position", "cursor"]) && int(checkpoint.position, 0) && (checkpoint.cursor === null || typeof checkpoint.cursor === "string")))) return;
		if (!(coalesced === null || (exactly(coalesced, ["count", "from", "to"]) && int(coalesced.count, 1)))) return;
		const point = checkpoint as { position: number; cursor: string | null } | null;
		let result: "accepted" | "duplicate" | "deferred" | "rejected";
		let reason: string;
		try {
			const refusal = this.#refusal(link, triggerId, sourceId, generation);
			if (refusal) {
				result = "rejected";
				reason = refusal;
			} else {
				// The write is one transaction; it has returned, so it is durable before the ack is sent.
				const admission = this.#options.store.admit({ id: triggerId, generation, eventId, observedAt: occurredAt, payload: data, ...(point ? { checkpoint: point } : {}), gap: coalesced !== null });
				result = ACK_RESULT[admission.status];
				reason = admission.status;
			}
		} catch (error) {
			if (!(error instanceof TriggerValidationError)) return; // Not written: no ack, so the runtime sends it again.
			result = "rejected";
			reason = "invalid";
		}
		this.#ack(link, [{ sequence, eventId, result, reason, retryAfterMs: result === "deferred" ? RETRY_AFTER_MS : null }]);
	}

	#gap(link: Link, frame: Frame): void {
		const keys = ["protocol", "type", "serverEpoch", "eventId", "triggerId", "sourceId", "generation", "sequence", "reasons", "from", "to"];
		if (!exactly(frame, keys) || frame.serverEpoch !== link.epoch || !this.#taking(link)) return;
		const { eventId, triggerId, generation, sequence } = frame;
		if (!ident(eventId) || !int(sequence, 1) || !(triggerId === null || ident(triggerId)) || !(generation === null || int(generation, 0))) return;
		let result: "accepted" | "rejected";
		try {
			result = this.#options.transaction(() => {
				if (triggerId === null) {
					// The whole spool's: every computer trigger may have missed something.
					for (const trigger of this.#computerTriggers()) this.#options.store.recordGap({ id: trigger.id, generation: trigger.generation });
					return "accepted";
				}
				if (generation === null) return "rejected";
				return this.#options.store.recordGap({ id: triggerId, generation }).ok ? "accepted" : "rejected";
			});
		} catch {
			return; // Not written: no ack.
		}
		this.#ack(link, [{ sequence, eventId, result, reason: result === "accepted" ? null : "stale_generation", retryAfterMs: null }]);
	}

	/** Why an observation of this trigger isn't taken, before the store looks: it isn't a computer trigger, isn't this source, or has no current grant on this computer. */
	#refusal(link: Link, triggerId: string, sourceId: string, generation: number): string | null {
		const trigger = this.#options.store.get(triggerId);
		if (!trigger || !runsOnComputer(trigger.spec.source)) return "not_found";
		if (trigger.generation !== generation) return "stale_generation";
		const state = this.#options.store.sourceState(triggerId);
		if (!state || state.identity !== sourceId) return "wrong_source";
		const scope = { space: this.#options.space, runtimeId: link.runtimeId!, triggerId, sourceId, configHash: sourceConfigHash(trigger.spec.source as ComputerSource) };
		return this.#options.grants.covers(trigger.spec.authorizationRef, scope) ? null : "not_granted";
	}

	/**
	 * Whether observations are taken on this socket: once a reconcile was
	 * answered in full, and while its lease holds on the space's side too. A
	 * socket whose lease lapsed, as when renewals couldn't be sent, is sent
	 * a reconcile now, and what came meanwhile is sent again after it.
	 */
	#taking(link: Link): boolean {
		if (this.#options.now() < link.leaseUntil) return true;
		if (link.leaseUntil > 0 && link.sent.length === 0) this.#reconcile(link);
		return false;
	}

	#ack(link: Link, results: { sequence: number; eventId: string; result: string; reason: string | null; retryAfterMs: number | null }[]): void {
		this.#send(link, { protocol: PROTOCOL, type: "ack", connectionId: link.connectionId, serverEpoch: link.epoch, durable: true, results });
	}

	// What the space says.

	/** Sends the whole desired set, under a revision that goes up whenever it says something new, and renews it every third of the lease. */
	#reconcile(link: Link): void {
		const runtimeId = link.runtimeId;
		if (runtimeId === null || this.#link !== link) return;
		const sources = this.#desired(runtimeId);
		const digest = sha256(canonical({ sources, leaseMs: this.#leaseMs }));
		const revision = this.#options.transaction(() => this.#revisionFor(runtimeId, digest));
		const at = this.#options.now();
		// A reconcile sent a lease ago and still unanswered can't extend the lease any more.
		link.sent = link.sent.filter((sent) => sent.at + this.#leaseMs > at);
		link.sent.push({ revision, at });
		this.#send(link, {
			protocol: PROTOCOL,
			type: "reconcile",
			binding: { space: this.#options.space, runtimeId },
			connectionId: link.connectionId,
			serverEpoch: link.epoch,
			desiredRevision: revision,
			leaseMs: this.#leaseMs,
			sources,
		});
		link.renew?.();
		link.renew = this.#options.setTimer(Math.floor(this.#leaseMs / 3), () => {
			link.renew = null;
			this.#reconcile(link);
		});
	}

	/**
	 * The enabled computer triggers this computer should run, each with its
	 * grant, within the reconcile's bounds. One without a current grant for
	 * exactly its source on this computer is left out, so it stops, and
	 * marked `auth_required`; one the protocol can't carry, or past the
	 * bounds, is left out and marked `configuration_error`.
	 */
	#desired(runtimeId: string): Desired[] {
		const sources: Desired[] = [];
		const empty = { protocol: PROTOCOL, type: "reconcile", binding: { space: this.#options.space, runtimeId }, connectionId: "x".repeat(ID_LENGTH), serverEpoch: Number.MAX_SAFE_INTEGER, desiredRevision: Number.MAX_SAFE_INTEGER, leaseMs: this.#leaseMs, sources: [] };
		let size = bytes(JSON.stringify(empty));
		for (const trigger of this.#computerTriggers()) {
			const state = this.#options.store.sourceState(trigger.id);
			const source = trigger.spec.source as ComputerSource;
			const grantRef = trigger.spec.authorizationRef;
			if (!state) continue;
			const configHash = sourceConfigHash(source);
			const scope: GrantScope = { space: this.#options.space, runtimeId, triggerId: trigger.id, sourceId: state.identity, configHash };
			if (!carried(trigger.id, state.identity, source, grantRef)) {
				this.#setHealth(trigger.id, trigger.generation, "configuration_error", "unsupported_source");
				continue;
			}
			if (!this.#options.grants.covers(grantRef, scope)) {
				this.#setHealth(trigger.id, trigger.generation, "auth_required", "no_current_grant");
				continue;
			}
			const desired: Desired = {
				triggerId: trigger.id,
				sourceId: state.identity,
				revision: state.sourceRevision,
				generation: trigger.generation,
				configHash,
				source,
				grant: { grantRef: grantRef!, scopeHash: grantScopeHash({ ...scope, grantRef: grantRef! }) },
				checkpoint: state.position === null ? null : { position: state.position, cursor: state.cursor },
			};
			const more = bytes(JSON.stringify(desired)) + 1;
			if (sources.length >= COMPUTER_LIMITS.sources || size + more > this.#reconcileBytes) {
				this.#setHealth(trigger.id, trigger.generation, "configuration_error", "too_many_sources");
				continue;
			}
			size += more;
			sources.push(desired);
		}
		return sources;
	}

	#send(link: Link, frame: object): void {
		if (this.#link !== link) return;
		link.socket.send(`${TRIGGERS_ENVELOPE}${JSON.stringify(frame)}}`);
	}

	// What the space keeps.

	/**
	 * The epoch for a runtime that said `hello` with `lastEpoch`: the one the
	 * space keeps, while the runtime's is no newer, so a reconnect resumes it;
	 * otherwise one above both, kept before it is used.
	 */
	#epochFor(runtimeId: string, lastEpoch: number | null): number {
		const row = this.#sql.exec("SELECT server_epoch FROM pim_trigger_computer_runtimes WHERE runtime_id = ?", runtimeId).toArray()[0];
		const kept = row ? Number(row.server_epoch) : null;
		if (kept !== null && kept >= 1 && (lastEpoch === null || lastEpoch <= kept)) return kept;
		return this.#nextEpoch(runtimeId, Math.max(kept ?? 0, lastEpoch ?? 0));
	}

	#nextEpoch(runtimeId: string, above: number): number {
		const epoch = above + 1;
		this.#sql.exec(
			"INSERT INTO pim_trigger_computer_runtimes (runtime_id, server_epoch, desired_revision, desired_digest, updated_at) VALUES (?, ?, 0, NULL, ?) ON CONFLICT (runtime_id) DO UPDATE SET server_epoch = excluded.server_epoch, updated_at = excluded.updated_at",
			runtimeId,
			epoch,
			this.#options.now(),
		);
		return epoch;
	}

	/** The revision for a desired set with this digest: the same as last time for the same set, so a renewal says exactly the same; otherwise the next, kept before it is sent. */
	#revisionFor(runtimeId: string, digest: string): number {
		const row = this.#sql.exec("SELECT desired_revision, desired_digest FROM pim_trigger_computer_runtimes WHERE runtime_id = ?", runtimeId).one();
		if (row.desired_digest === digest) return Number(row.desired_revision);
		const revision = Number(row.desired_revision) + 1;
		this.#sql.exec("UPDATE pim_trigger_computer_runtimes SET desired_revision = ?, desired_digest = ?, updated_at = ? WHERE runtime_id = ?", revision, digest, this.#options.now(), runtimeId);
		return revision;
	}

	/** Enabled triggers whose source runs on the computer, oldest first. */
	#computerTriggers(): Trigger[] {
		return this.#options.store.list().filter((trigger) => trigger.lifecycle === "enabled" && runsOnComputer(trigger.spec.source));
	}

	/** The connection's state, for every computer trigger whose health is about the connection: a missing grant or a configuration error stays as it is. */
	#setHealthAll(health: TriggerHealth, detail: string | null): void {
		for (const trigger of this.#computerTriggers()) this.#setHealth(trigger.id, trigger.generation, health, detail, CONNECTION_HEALTHS);
	}

	/** Records a trigger's health, as codes only, when it changes; with `from`, only from one of those. */
	#setHealth(id: string, generation: number, health: TriggerHealth, detail: string | null, from?: readonly TriggerHealth[]): void {
		const trigger = this.#options.store.get(id);
		if (!trigger || trigger.generation !== generation || !runsOnComputer(trigger.spec.source)) return;
		if (from && !from.includes(trigger.health)) return;
		if (trigger.health === health && trigger.healthDetail === detail) return;
		this.#options.store.setHealth({ id, generation, health, detail });
	}
}

/** Whether the protocol can carry this source as the runtime reads it: its ids, its grant's reference, and its paths. */
function carried(triggerId: string, sourceId: string, source: ComputerSource, grantRef: string | null): boolean {
	if (!ident(triggerId) || !ident(sourceId) || (grantRef !== null && !ident(grantRef, GRANT_REF_LENGTH))) return false;
	const text = (value: string | null, max: number) => value === null || (value.length <= max && !CONTROL.test(value));
	switch (source.kind) {
		case "poll":
		case "stream":
			return text(source.command, 4_000) && text(source.cwd, 4_096);
		case "process":
			return ident(source.handle);
		case "file":
			return text(source.path, 4_096) && !/[\n\t]/.test(source.path);
	}
}
