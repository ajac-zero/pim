/**
 * The resident runtime for triggers' observers on the person's computer: it
 * keeps the computer sources the space wants running, and only those, fences
 * what a stopped or replaced observer still emits, and holds observations in
 * a bounded spool on disk until the space has durably taken them. The
 * protocol it speaks, `triggers.v1`, and its lifecycle are in
 * docs/triggers-runtime.md.
 *
 * Only pim-computer's triggers host (./triggers-host.ts) runs it, which
 * pim-computer loads as it starts (`loadTriggers`). It has no observers
 * of its own: running a poll, a stream or a process watch is an adapter's
 * job (`ObserverAdapter`, ./triggers-adapters/).
 *
 * The space stays the authority. Which sources run, under which generation
 * and grant, comes only from the space's `reconcile`; nothing on disk starts
 * an observer, and a grant is checked by the host's `authorize` before every
 * start and again on every reconcile. Observers run as the user who runs
 * pim-computer, with that user's access: a grant is consent to run one
 * source, not a sandbox, and nothing here confines what an adapter does.
 */

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FileSource, PollSource, ProcessSource, StreamSource } from "../src/triggers/spec.ts";

export const PROTOCOL = "triggers.v1";

/** The most any setting may be; a host may set less, never more. */
export const HARD_LIMITS = {
	/** The longest a reconcile's lease may run; also the default. */
	leaseMs: 120_000,
	/** The most bytes one frame the runtime sends may have. */
	frameBytes: 65_536,
	/** The most bytes an observation's data may have as JSON: what the space's store takes (`ADMISSION_LIMITS.payload`). */
	dataBytes: 16_384,
	/** The most bytes one frame from the space may have. */
	inboundBytes: 4 * 1_048_576,
	spoolBytes: 32 * 1_048_576,
	spoolEntries: 100_000,
	/** The longest an observation waits in the spool before it is given up, with a gap. */
	spoolTtlMs: 24 * 60 * 60_000,
	/** The longest an entry's bytes may stay in the journal file after it has left the spool. */
	scrubAfterMs: 600_000,
	sources: 256,
} as const;

// ---------------------------------------------------------------------------
// The protocol.

export type ComputerSource = PollSource | StreamSource | ProcessSource | FileSource;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** Where a source can resume from, as the store keeps it (`pim_trigger_sources`). */
export type Checkpoint = { readonly position: number; readonly cursor: string | null };
/** The one owner a runtime serves, from its own configuration. A message can only match it, never change it. */
export type Binding = { readonly space: string; readonly runtimeId: string };
/** An opaque grant reference and a digest of what it consents to; never a credential. */
export type Grant = { readonly grantRef: string; readonly scopeHash: string };

/** One source the space wants running, in a reconcile. */
export type DesiredSource = {
	readonly triggerId: string;
	/** The store's source identity, `<triggerId>#<revision>`. */
	readonly sourceId: string;
	/** The revision the source was set in, the suffix of `sourceId`. */
	readonly revision: number;
	/** Fixes `sourceId`, `revision` and `configHash`: the same generation with others is refused. Only its grant may change. */
	readonly generation: number;
	/** `sourceConfigHash(source)`, which the runtime checks. */
	readonly configHash: string;
	readonly source: ComputerSource;
	readonly grant: Grant;
	/** The checkpoint the space has durably taken, which a new observer resumes from. */
	readonly checkpoint: Checkpoint | null;
};

export type ReconcileMessage = {
	readonly protocol: typeof PROTOCOL;
	readonly type: "reconcile";
	readonly binding: Binding;
	readonly connectionId: string;
	readonly serverEpoch: number;
	/** Orders reconciles within an epoch; an older one is refused, and the same one again, which only renews, must say the same. */
	readonly desiredRevision: number;
	/** How long this reconcile holds, from when the runtime takes it in. */
	readonly leaseMs: number;
	readonly sources: readonly DesiredSource[];
};

/**
 * What the space did with one observation or gap, after its own write is
 * durable. `accepted`, `duplicate` (it had it already) and `rejected` (stale,
 * invalid, deleted: it never will take it) are final, and the entry leaves
 * the spool. `deferred` (a quota or backpressure) is not: the entry stays and
 * is sent again, with the same id, from `retryAfterMs`.
 */
export type AckResult = {
	readonly sequence: number;
	readonly eventId: string;
	readonly result: "accepted" | "duplicate" | "rejected" | "deferred";
	readonly reason: string | null;
	readonly retryAfterMs: number | null;
};
export type AckMessage = {
	readonly protocol: typeof PROTOCOL;
	readonly type: "ack";
	readonly connectionId: string;
	readonly serverEpoch: number;
	readonly durable: true;
	readonly results: readonly AckResult[];
};
export type ServerMessage = ReconcileMessage | AckMessage;

/** `ended`: this generation's observer ended for good and its end is durable; nothing runs it again but a new generation. */
export type SourceState = "starting" | "running" | "ended" | "stale" | "invalid";
export type StopReason =
	| "not_desired"
	| "reconfigured"
	| "consent_changed"
	| "revoked"
	| "invalid"
	| "lease_expired"
	| "epoch_replaced"
	| "start_failed"
	| "spool_unavailable"
	| "shutdown"
	| "ended";
/**
 * Why a gap was recorded. `interrupted`: no observer of the source ran from
 * `from` to `to`. `coverage_unknown`: an observer started at `to`, and what
 * came before, since this runtime started, isn't known. The rest count
 * observations that were seen but will never be sent.
 */
export type GapReason = "overflow" | "too_large" | "expired" | "epoch_replaced" | "corrupt" | "interrupted" | "coverage_unknown";
export type GapCounts = { readonly [reason in GapReason]?: number };
/** A snapshot that stands for `count` snapshots taken from `from` to `to`, itself included; the others were never sent. */
export type Coalesced = { readonly count: number; readonly from: number; readonly to: number };

type Envelope<T extends string> = { readonly protocol: typeof PROTOCOL; readonly type: T };
export type RuntimeMessage =
	| (Envelope<"hello"> & { readonly runtimeId: string; readonly connectionId: string; readonly lastEpoch: number | null; readonly pending: number })
	| (Envelope<"error"> & { readonly code: string })
	/**
	 * The answer to a reconcile, in `parts` frames numbered from 1, each
	 * within `frameBytes`. Only all of them together acknowledge it.
	 */
	| (Envelope<"reconciled"> & {
			readonly serverEpoch: number;
			readonly desiredRevision: number;
			readonly leaseMs: number;
			readonly part: number;
			readonly parts: number;
			readonly sources: readonly { readonly triggerId: string; readonly sourceId: string; readonly generation: number; readonly state: SourceState }[];
	  })
	| (Envelope<"installed"> & SourceRef & { readonly configHash: string })
	| (Envelope<"health"> & SourceRef & { readonly status: "ok" | "degraded" | "error"; readonly code: string })
	/**
	 * The runtime's own adapter handle for this generation was asked to stop:
	 * `returned` means its `stop` returned, not that a process or anything it
	 * started was cancelled or undone.
	 */
	| (Envelope<"stopped"> & SourceRef & { readonly reason: StopReason; readonly adapter: "returned" | "timed_out" | "failed" | "not_started" })
	| (Envelope<"observation"> & {
			readonly serverEpoch: number;
			readonly eventId: string;
			readonly triggerId: string;
			readonly sourceId: string;
			readonly revision: number;
			readonly generation: number;
			readonly sequence: number;
			readonly occurredAt: number;
			readonly data: JsonObject;
			readonly checkpoint: Checkpoint | null;
			readonly coalesced: Coalesced | null;
	  })
	| (Envelope<"gap"> & {
			readonly serverEpoch: number;
			readonly eventId: string;
			readonly triggerId: string | null;
			readonly sourceId: string | null;
			readonly generation: number | null;
			readonly sequence: number;
			readonly reasons: GapCounts;
			readonly from: number;
			readonly to: number;
	  });
type SourceRef = { readonly serverEpoch: number; readonly triggerId: string; readonly sourceId: string; readonly generation: number };

/** A frame from the space that isn't `triggers.v1` as this runtime reads it. Its `code` is all that is reported. */
export class ProtocolError extends Error {
	readonly code: "invalid" | "unsupported_protocol" | "too_large";
	constructor(code: ProtocolError["code"]) {
		super(code);
		this.name = "ProtocolError";
		this.code = code;
	}
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProtocolError("invalid");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new ProtocolError("invalid");
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ProtocolError("invalid");
	return value as Record<string, unknown>;
}

function int(value: unknown, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new ProtocolError("invalid");
	return value;
}

function str(value: unknown, max: number, multiline = false): string {
	if (typeof value !== "string" || value.length < 1 || value.length > max) throw new ProtocolError("invalid");
	if (multiline ? CONTROL.test(value) : /[\u0000-\u001f\u007f]/.test(value)) throw new ProtocolError("invalid");
	return value;
}

/**
 * An id in the protocol: printable ASCII other than `"` and `\`, so it
 * takes as many bytes in a frame as it has characters, up to `max` (160, as
 * the store's ids and source identities are well within; a grant reference
 * takes up to 256, and never appears in what the runtime sends).
 */
function ident(value: unknown, max = ID_LENGTH): string {
	const id = str(value, max);
	if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(id)) throw new ProtocolError("invalid");
	return id;
}

const ID_LENGTH = 160;

function digestHex(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new ProtocolError("invalid");
	return value;
}

function readCheckpoint(value: unknown): Checkpoint {
	const given = fields(value, ["position", "cursor"]);
	return { position: int(given.position, 0, Number.MAX_SAFE_INTEGER), cursor: given.cursor === null ? null : str(given.cursor, 1_024) };
}

/**
 * Reads a computer source as the space sends it: with every field present,
 * as a stored spec has them. Bounds are the space's to check; the runtime
 * checks the shape, and that the source is what `configHash` says.
 */
function readSource(value: unknown): ComputerSource {
	const kind = (fields(value, ["kind", "command", "cwd", "intervalMs", "deadlineMs", "handle", "expiresAt", "path", "events", "recursive"]) as { kind?: unknown }).kind;
	const cwd = (given: Record<string, unknown>) => (given.cwd === null ? null : str(given.cwd, 4_096));
	switch (kind) {
		case "poll": {
			const given = fields(value, ["kind", "command", "cwd", "intervalMs", "deadlineMs"]);
			return { kind, command: str(given.command, 4_000, true), cwd: cwd(given), intervalMs: int(given.intervalMs, 1, Number.MAX_SAFE_INTEGER), deadlineMs: int(given.deadlineMs, 1, Number.MAX_SAFE_INTEGER) };
		}
		case "stream": {
			const given = fields(value, ["kind", "command", "cwd"]);
			return { kind, command: str(given.command, 4_000, true), cwd: cwd(given) };
		}
		case "process": {
			const given = fields(value, ["kind", "handle", "expiresAt"]);
			return { kind, handle: ident(given.handle), expiresAt: int(given.expiresAt, 0, Number.MAX_SAFE_INTEGER) };
		}
		case "file": {
			const given = fields(value, ["kind", "path", "events", "recursive"]);
			if (!Array.isArray(given.events) || given.events.length < 1 || given.events.length > 3) throw new ProtocolError("invalid");
			const events = given.events.map((event) => {
				if (event !== "created" && event !== "modified" && event !== "deleted") throw new ProtocolError("invalid");
				return event;
			});
			if (typeof given.recursive !== "boolean") throw new ProtocolError("invalid");
			return { kind, path: str(given.path, 4_096), events, recursive: given.recursive };
		}
		default:
			throw new ProtocolError("invalid");
	}
}

function readDesired(value: unknown): DesiredSource {
	const given = fields(value, ["triggerId", "sourceId", "revision", "generation", "configHash", "source", "grant", "checkpoint"]);
	const grant = fields(given.grant, ["grantRef", "scopeHash"]);
	return {
		triggerId: ident(given.triggerId),
		sourceId: ident(given.sourceId),
		revision: int(given.revision, 1, Number.MAX_SAFE_INTEGER),
		generation: int(given.generation, 0, Number.MAX_SAFE_INTEGER),
		configHash: digestHex(given.configHash),
		source: readSource(given.source),
		grant: { grantRef: ident(grant.grantRef, 256), scopeHash: digestHex(grant.scopeHash) },
		checkpoint: given.checkpoint === null ? null : readCheckpoint(given.checkpoint),
	};
}

/** Reads one frame from the space; throws a `ProtocolError` for anything else. */
export function parseServerMessage(frame: string, limits: { inboundBytes: number; leaseMs: number; sources: number } = HARD_LIMITS): ServerMessage {
	if (Buffer.byteLength(frame) > limits.inboundBytes) throw new ProtocolError("too_large");
	let value: unknown;
	try {
		value = JSON.parse(frame);
	} catch {
		throw new ProtocolError("invalid");
	}
	if (typeof value !== "object" || value === null || (value as { protocol?: unknown }).protocol !== PROTOCOL) throw new ProtocolError("unsupported_protocol");
	const type = (value as { type?: unknown }).type;
	if (type === "reconcile") {
		const given = fields(value, ["protocol", "type", "binding", "connectionId", "serverEpoch", "desiredRevision", "leaseMs", "sources"]);
		const binding = fields(given.binding, ["space", "runtimeId"]);
		if (!Array.isArray(given.sources) || given.sources.length > limits.sources) throw new ProtocolError("invalid");
		const sources = given.sources.map(readDesired);
		if (new Set(sources.map((source) => source.triggerId)).size !== sources.length) throw new ProtocolError("invalid");
		return deepFreeze({
			protocol: PROTOCOL,
			type,
			binding: { space: ident(binding.space), runtimeId: ident(binding.runtimeId) },
			connectionId: ident(given.connectionId),
			serverEpoch: int(given.serverEpoch, 1, Number.MAX_SAFE_INTEGER),
			desiredRevision: int(given.desiredRevision, 0, Number.MAX_SAFE_INTEGER),
			leaseMs: int(given.leaseMs, 1, limits.leaseMs),
			sources,
		});
	}
	if (type === "ack") {
		const given = fields(value, ["protocol", "type", "connectionId", "serverEpoch", "durable", "results"]);
		if (given.durable !== true || !Array.isArray(given.results) || given.results.length > 1_024) throw new ProtocolError("invalid");
		const results = given.results.map((item): AckResult => {
			const result = fields(item, ["sequence", "eventId", "result", "reason", "retryAfterMs"]);
			if (result.result !== "accepted" && result.result !== "duplicate" && result.result !== "rejected" && result.result !== "deferred") throw new ProtocolError("invalid");
			return {
				sequence: int(result.sequence, 1, Number.MAX_SAFE_INTEGER),
				eventId: ident(result.eventId),
				result: result.result,
				reason: result.reason === undefined || result.reason === null ? null : ident(result.reason, 64),
				retryAfterMs: result.retryAfterMs === undefined || result.retryAfterMs === null ? null : int(result.retryAfterMs, 0, HARD_LIMITS.spoolTtlMs),
			};
		});
		return deepFreeze({ protocol: PROTOCOL, type, connectionId: ident(given.connectionId), serverEpoch: int(given.serverEpoch, 1, Number.MAX_SAFE_INTEGER), durable: true, results });
	}
	throw new ProtocolError("invalid");
}

/** Freezes a value built here, and everything in it, so nothing handed out can change what the runtime holds. */
function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
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

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * The digest a source's configuration is consented to and run under: every
 * field, its command, path, interval and events included, so any change to
 * what runs or how often is a different configuration.
 */
export function sourceConfigHash(source: ComputerSource): string {
	return sha256(`${PROTOCOL}/source\n${canonical(source)}`);
}

// ---------------------------------------------------------------------------
// The spool.

type EntryBase = { readonly seq: number; readonly eventId: string; readonly epoch: number; readonly recordedAt: number };
export type ObservationEntry = EntryBase & {
	readonly kind: "observation";
	readonly triggerId: string;
	readonly sourceId: string;
	readonly revision: number;
	readonly generation: number;
	readonly occurredAt: number;
	readonly data: JsonObject;
	readonly checkpoint: Checkpoint | null;
	readonly coalesced: Coalesced | null;
};
/** What was lost, and why, counted; it carries nothing observed. A null source is the whole spool's. */
export type GapEntry = EntryBase & {
	readonly kind: "gap";
	readonly triggerId: string | null;
	readonly sourceId: string | null;
	readonly generation: number | null;
	readonly reasons: GapCounts;
	readonly from: number;
	readonly to: number;
};
export type SpoolEntry = ObservationEntry | GapEntry;
/**
 * That one generation's observer of a trigger ended for good, when, and why:
 * written with the gap that says so, kept across restarts and epochs so the
 * same generation is never run again, and replaced or removed only when a
 * newer generation of the trigger starts. It holds ids, a digest, times and
 * a code: nothing observed, no command and no grant.
 */
export type EndRecord = {
	readonly triggerId: string;
	readonly sourceId: string;
	readonly generation: number;
	readonly configHash: string;
	readonly at: number;
	readonly code: string;
	readonly recordedAt: number;
};
/** The most end records the journal keeps; past that, the oldest of a trigger no longer wanted goes. */
export const MAX_END_RECORDS = 1_024;

/**
 * One line of the journal: everything one commit changes. A line is read
 * back whole, with its digest, or not at all, so a commit is too. `ends` and
 * `unend` put and remove end records by trigger; a journal written before
 * they existed has none, and is read as it was.
 */
type Txn = {
	readonly t: "txn";
	readonly meta?: { readonly epoch: number | null; readonly nextSeq: number };
	readonly put?: readonly SpoolEntry[];
	readonly del?: readonly number[];
	readonly ends?: readonly EndRecord[];
	readonly unend?: readonly string[];
};

const HEALTH_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Whether a value read back from the journal is an end record, exactly. */
function isEndRecord(value: unknown): value is EndRecord {
	try {
		const given = fields(value, ["triggerId", "sourceId", "generation", "configHash", "at", "code", "recordedAt"]);
		ident(given.triggerId);
		ident(given.sourceId);
		int(given.generation, 0, Number.MAX_SAFE_INTEGER);
		digestHex(given.configHash);
		int(given.at, 0, Number.MAX_SAFE_INTEGER);
		int(given.recordedAt, 0, Number.MAX_SAFE_INTEGER);
		return typeof given.code === "string" && HEALTH_CODE.test(given.code);
	} catch {
		return false;
	}
}

function endBytes(ends: ReadonlyMap<string, EndRecord>): number {
	let bytes = 0;
	for (const record of ends.values()) bytes += encode({ t: "txn", ends: [record] }).length;
	return bytes;
}

export type SpoolOptions = {
	/** The most bytes the journal may take; at most `HARD_LIMITS.spoolBytes`, which is the default. */
	readonly maxBytes?: number;
	readonly maxEntries?: number;
	/** Room kept for gap entries, which observations can't use. */
	readonly reserveBytes?: number;
	readonly reserveEntries?: number;
	/** Writes and syncs `data` at the file's end; the tests replace it to fail part-way. */
	readonly write?: (handle: fs.FileHandle, data: Buffer) => Promise<void>;
};

export class SpoolError extends Error {
	readonly code: "full" | "unavailable" | "unsafe_path" | "oversize";
	constructor(code: SpoolError["code"]) {
		super(code);
		this.name = "SpoolError";
		this.code = code;
	}
}

export const SPOOL_FILE = "journal";
/** What the journal's first line, which says the epoch and the next sequence, may take. */
const META_BYTES = 256;

async function writeAll(handle: fs.FileHandle, data: Buffer): Promise<void> {
	let offset = 0;
	while (offset < data.length) offset += (await handle.write(data, offset, data.length - offset)).bytesWritten;
	await handle.datasync();
}

function encode(txn: Txn): Buffer {
	const json = JSON.stringify(txn);
	return Buffer.from(`${sha256(json).slice(0, 16)} ${json}\n`);
}

function entryBytes(entry: SpoolEntry): number {
	return encode({ t: "txn", put: [entry] }).length;
}

function decode(line: string): Txn | null {
	if (line.length < 18 || line[16] !== " ") return null;
	const json = line.slice(17);
	if (sha256(json).slice(0, 16) !== line.slice(0, 16)) return null;
	try {
		const txn = JSON.parse(json) as Txn;
		if (txn?.t !== "txn") return null;
		if (txn.meta !== undefined && !((txn.meta.epoch === null || Number.isSafeInteger(txn.meta.epoch)) && Number.isSafeInteger(txn.meta.nextSeq))) return null;
		if (txn.del !== undefined && !(Array.isArray(txn.del) && txn.del.every((seq) => Number.isSafeInteger(seq)))) return null;
		if (txn.put !== undefined && !(Array.isArray(txn.put) && txn.put.every((entry) => Number.isSafeInteger(entry?.seq) && Number.isSafeInteger(entry.epoch) && (entry.kind === "observation" || entry.kind === "gap")))) return null;
		if (txn.ends !== undefined && !(Array.isArray(txn.ends) && txn.ends.every(isEndRecord))) return null;
		if (txn.unend !== undefined && !(Array.isArray(txn.unend) && txn.unend.every((triggerId) => typeof triggerId === "string"))) return null;
		return deepFreeze(txn);
	} catch {
		return null;
	}
}

/** Checks a path is ours and not a link, and takes away any access others have to it. */
async function makePrivate(target: string, kind: "directory" | "file"): Promise<void> {
	const stat = await fs.lstat(target);
	if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) throw new SpoolError("unsafe_path");
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new SpoolError("unsafe_path");
	if ((stat.mode & 0o077) !== 0) await fs.chmod(target, kind === "directory" ? 0o700 : 0o600);
}

/**
 * The runtime's transport spool: a journal of observations and gaps not yet
 * durably taken by the space, in one file in a directory only its user can
 * read. It is not history and not a log: an entry leaves it once the space
 * has settled it, its time is up, or its epoch is replaced. Until then it
 * holds what an observer saw, which can be sensitive, as plain JSON.
 *
 * Each commit is one line with a digest of its JSON, synced before it
 * counts, so recovery applies a commit whole or not at all. A line cut short
 * by a crash is cut off; a line whose digest doesn't match is skipped and
 * counted, and stays until the runtime has recorded the loss and rewritten
 * the journal. Removing an entry appends a line, so the entry's bytes stay in
 * the file until a rewrite (`compact`): `retiredBytes` says how many there
 * are. The journal never grows past `maxBytes`: before it would, it is
 * rewritten with only what is live, through a temporary file renamed over it.
 * Entries handed out are frozen.
 */
export class ObservationSpool {
	readonly directory: string;
	readonly limits: { readonly maxBytes: number; readonly maxEntries: number; readonly reserveBytes: number; readonly reserveEntries: number };
	/** What opening found: a line cut short at the end, and lines that failed their digest. */
	readonly recovery = { torn: false, corrupt: 0 };
	readonly #file: string;
	readonly #write: (handle: fs.FileHandle, data: Buffer) => Promise<void>;
	#entries = new Map<number, { entry: SpoolEntry; bytes: number }>();
	#events = new Map<string, number>();
	#ends = new Map<string, EndRecord>();
	#endBytes = 0;
	#epoch: number | null = null;
	#nextSeq = 1;
	#handle: fs.FileHandle | null = null;
	#fileBytes = 0;
	#liveBytes = 0;
	#retiredBytes = 0;
	#broken = false;
	#closed = false;

	private constructor(directory: string, limits: ObservationSpool["limits"], write: (handle: fs.FileHandle, data: Buffer) => Promise<void>) {
		this.directory = directory;
		this.limits = limits;
		this.#file = path.join(directory, SPOOL_FILE);
		this.#write = write;
	}

	static async open(directory: string, options: SpoolOptions = {}): Promise<ObservationSpool> {
		const maxBytes = options.maxBytes ?? HARD_LIMITS.spoolBytes;
		const maxEntries = options.maxEntries ?? HARD_LIMITS.spoolEntries;
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 4_096 || maxBytes > HARD_LIMITS.spoolBytes) throw new RangeError(`maxBytes must be from 4096 to ${HARD_LIMITS.spoolBytes}`);
		if (!Number.isSafeInteger(maxEntries) || maxEntries < 4 || maxEntries > HARD_LIMITS.spoolEntries) throw new RangeError(`maxEntries must be from 4 to ${HARD_LIMITS.spoolEntries}`);
		const reserveBytes = options.reserveBytes ?? Math.min(65_536, Math.floor(maxBytes / 8));
		const reserveEntries = options.reserveEntries ?? Math.min(256, Math.floor(maxEntries / 4));
		if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0 || reserveBytes >= maxBytes / 2) throw new RangeError("reserveBytes must be less than half of maxBytes");
		if (!Number.isSafeInteger(reserveEntries) || reserveEntries < 0 || reserveEntries >= maxEntries / 2) throw new RangeError("reserveEntries must be less than half of maxEntries");
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		await makePrivate(directory, "directory");
		const spool = new ObservationSpool(directory, { maxBytes, maxEntries, reserveBytes, reserveEntries }, options.write ?? writeAll);
		await fs.rm(`${spool.#file}.tmp`, { force: true });
		let content: Buffer | null = null;
		try {
			await makePrivate(spool.#file, "file");
			const handle = await fs.open(spool.#file, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				if ((await handle.stat()).size > 2 * HARD_LIMITS.spoolBytes) throw new SpoolError("oversize");
				content = await handle.readFile();
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const whole = content ? spool.#recover(content) : 0;
		if (spool.recovery.corrupt === 0) {
			// Rewritten on opening, so what follows starts from checked lines only, and nothing retired before is kept.
			await spool.#rewrite(spool.#entries, spool.#epoch);
		} else {
			// Kept as it is, past a cut-off end, so the corrupt lines count again until the loss is recorded and the journal rewritten.
			const handle = await fs.open(spool.#file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
			await handle.truncate(whole);
			await handle.datasync();
			spool.#handle = handle;
			spool.#fileBytes = whole;
			spool.#retiredBytes = Math.max(1, whole - spool.#liveBytes);
		}
		return spool;
	}

	/** Applies every whole, checked line; returns where the last whole line ends. */
	#recover(content: Buffer): number {
		let offset = 0;
		while (offset < content.length) {
			const end = content.indexOf(0x0a, offset);
			if (end === -1) {
				this.recovery.torn = true;
				break;
			}
			const txn = decode(content.subarray(offset, end).toString("utf8"));
			offset = end + 1;
			if (!txn) {
				this.recovery.corrupt++;
				continue;
			}
			if (txn.meta) {
				this.#epoch = txn.meta.epoch;
				this.#nextSeq = Math.max(this.#nextSeq, txn.meta.nextSeq);
			}
			for (const seq of txn.del ?? []) this.#entries.delete(seq);
			for (const entry of txn.put ?? []) {
				this.#entries.set(entry.seq, { entry, bytes: entryBytes(entry) });
				this.#nextSeq = Math.max(this.#nextSeq, entry.seq + 1);
			}
			for (const triggerId of txn.unend ?? []) this.#ends.delete(triggerId);
			for (const record of txn.ends ?? []) this.#ends.set(record.triggerId, record);
		}
		this.#entries = new Map([...this.#entries].sort(([a], [b]) => a - b));
		// Entries are written only under the epoch then current, so a lost first line can't leave it unknown.
		for (const { entry } of this.#entries.values()) if (this.#epoch === null || entry.epoch > this.#epoch) this.#epoch = entry.epoch;
		this.#index();
		return offset;
	}

	#index(): void {
		this.#events = new Map([...this.#entries.values()].map(({ entry }) => [entry.eventId, entry.seq]));
		this.#liveBytes = [...this.#entries.values()].reduce((sum, { bytes }) => sum + bytes, 0);
		this.#endBytes = endBytes(this.#ends);
	}

	get epoch(): number | null {
		return this.#epoch;
	}
	get count(): number {
		return this.#entries.size;
	}
	get bytes(): number {
		return this.#liveBytes + this.#endBytes + META_BYTES;
	}
	/** Bytes in the file of entries that have left, which only a rewrite takes out. */
	get retiredBytes(): number {
		return this.#retiredBytes;
	}
	/** The entries in sequence order. */
	entries(): SpoolEntry[] {
		return [...this.#entries.values()].map(({ entry }) => entry);
	}
	get(seq: number): SpoolEntry | undefined {
		return this.#entries.get(seq)?.entry;
	}
	/** The end record of a trigger, if one is kept. */
	end(triggerId: string): EndRecord | undefined {
		return this.#ends.get(triggerId);
	}
	ends(): EndRecord[] {
		return [...this.#ends.values()];
	}
	findEvent(eventId: string): SpoolEntry | undefined {
		const seq = this.#events.get(eventId);
		return seq === undefined ? undefined : this.get(seq);
	}
	/** The next sequence number; it is durable once an entry with it is put. */
	allocate(): number {
		return this.#nextSeq++;
	}

	#project(puts: readonly SpoolEntry[], removes: readonly number[]): { bytes: number; count: number } {
		let bytes = this.#liveBytes;
		let count = this.#entries.size;
		const gone = new Set(removes);
		for (const seq of gone) {
			const held = this.#entries.get(seq);
			if (held) {
				bytes -= held.bytes;
				count--;
			}
		}
		for (const entry of puts) {
			const held = gone.has(entry.seq) ? undefined : this.#entries.get(entry.seq);
			bytes += entryBytes(entry) - (held?.bytes ?? 0);
			if (!held) count++;
		}
		return { bytes: bytes + this.#endBytes + META_BYTES, count };
	}

	/** Whether the spool would hold these changes; only gaps may use the reserve. */
	fits(puts: readonly SpoolEntry[], removes: readonly number[], reserve: boolean): boolean {
		const after = this.#project(puts, removes);
		const { maxBytes, maxEntries, reserveBytes, reserveEntries } = this.limits;
		return after.bytes + (reserve ? 0 : reserveBytes) <= maxBytes && after.count + (reserve ? 0 : reserveEntries) <= maxEntries;
	}

	/**
	 * Puts entries (one with a sequence already held replaces it), removes
	 * others, and sets the epoch if given, all in one line, durably, before it
	 * returns; or changes nothing and throws. `rewrite` writes the whole
	 * journal instead, so nothing removed stays in the file. `unend` removes
	 * end records by trigger and `ends` puts them, in the same line.
	 */
	async commit(
		puts: readonly SpoolEntry[],
		removes: readonly number[],
		options: { epoch?: number; rewrite?: boolean; ends?: readonly EndRecord[]; unend?: readonly string[] } = {},
	): Promise<void> {
		if (this.#closed || this.#broken || !this.#handle) throw new SpoolError("unavailable");
		const ends = (options.ends ?? []).map(deepFreeze);
		const unend = options.unend ?? [];
		const nextEnds = new Map(this.#ends);
		for (const triggerId of unend) nextEnds.delete(triggerId);
		for (const record of ends) nextEnds.set(record.triggerId, record);
		const after = this.#project(puts, removes);
		const bytes = after.bytes - this.#endBytes + endBytes(nextEnds);
		if (bytes > this.limits.maxBytes || after.count > this.limits.maxEntries || nextEnds.size > MAX_END_RECORDS) throw new SpoolError("full");
		puts = puts.map(deepFreeze);
		const epoch = options.epoch ?? this.#epoch;
		const data = encode({
			t: "txn",
			...(options.epoch === undefined ? {} : { meta: { epoch, nextSeq: this.#nextSeq } }),
			...(puts.length > 0 ? { put: puts } : {}),
			...(removes.length > 0 ? { del: removes } : {}),
			...(unend.length > 0 ? { unend } : {}),
			...(ends.length > 0 ? { ends } : {}),
		});
		if (options.rewrite || this.#fileBytes + data.length > this.limits.maxBytes) {
			const next = new Map(this.#entries);
			for (const seq of removes) next.delete(seq);
			for (const entry of puts) next.set(entry.seq, { entry, bytes: entryBytes(entry) });
			await this.#rewrite(new Map([...next].sort(([a], [b]) => a - b)), epoch, nextEnds);
			return;
		}
		try {
			await this.#write(this.#handle, data);
		} catch {
			// Cut back to the last whole line, so what follows isn't written after half of one.
			try {
				await this.#handle.truncate(this.#fileBytes);
				await this.#handle.datasync();
			} catch {
				this.#broken = true;
			}
			throw new SpoolError("unavailable");
		}
		this.#fileBytes += data.length;
		this.#epoch = epoch;
		for (const seq of removes) {
			const held = this.#entries.get(seq);
			if (held) {
				this.#entries.delete(seq);
				this.#events.delete(held.entry.eventId);
				this.#liveBytes -= held.bytes;
				this.#retiredBytes += held.bytes;
			}
		}
		for (const entry of puts) {
			const bytes = entryBytes(entry);
			const held = this.#entries.get(entry.seq);
			if (held) this.#retiredBytes += held.bytes;
			this.#liveBytes += bytes - (held?.bytes ?? 0);
			this.#entries.set(entry.seq, { entry, bytes });
			this.#events.set(entry.eventId, entry.seq);
		}
		this.#ends = nextEnds;
		this.#endBytes = endBytes(nextEnds);
	}

	/** Rewrites the journal with only what is live, so nothing that left stays in the file. */
	async compact(): Promise<void> {
		await this.#rewrite(this.#entries, this.#epoch);
	}

	/** Writes `entries` as the whole journal: a temporary file, synced, renamed over the journal. */
	async #rewrite(entries: Map<number, { entry: SpoolEntry; bytes: number }>, epoch: number | null, ends: Map<string, EndRecord> = this.#ends): Promise<void> {
		if (this.#closed) throw new SpoolError("unavailable");
		const data = Buffer.concat([
			encode({ t: "txn", meta: { epoch, nextSeq: this.#nextSeq } }),
			...[...ends.values()].map((record) => encode({ t: "txn", ends: [record] })),
			...[...entries.values()].map(({ entry }) => encode({ t: "txn", put: [entry] })),
		]);
		if (data.length > this.limits.maxBytes) throw new SpoolError("full");
		const temporary = `${this.#file}.tmp`;
		try {
			await fs.rm(temporary, { force: true });
			const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try {
				await this.#write(handle, data);
			} finally {
				await handle.close();
			}
			await fs.rename(temporary, this.#file);
			const directory = await fs.open(this.directory, constants.O_RDONLY);
			try {
				await directory.sync();
			} catch {
			} finally {
				await directory.close();
			}
		} catch (error) {
			await fs.rm(temporary, { force: true }).catch(() => undefined);
			throw error instanceof SpoolError ? error : new SpoolError("unavailable");
		}
		await this.#handle?.close().catch(() => undefined);
		this.#handle = await fs.open(this.#file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
		this.#fileBytes = data.length;
		this.#retiredBytes = 0;
		this.#broken = false;
		this.#epoch = epoch;
		this.#entries = entries;
		this.#ends = ends;
		this.#index();
	}

	async close(): Promise<void> {
		this.#closed = true;
		await this.#handle?.close().catch(() => undefined);
		this.#handle = null;
	}
}

// ---------------------------------------------------------------------------
// The runtime.

export type Transport = {
	/** Sends one frame; false when it can't take more now, and the frame isn't sent. */
	send(frame: string): boolean;
};
/** The runtime's clock and timers, injected so tests drive them. */
export type RuntimeClock = { now(): number; setTimer(ms: number, run: () => void): () => void };
export type AuthorizationRequest = {
	readonly binding: Binding;
	readonly triggerId: string;
	readonly sourceId: string;
	readonly generation: number;
	readonly configHash: string;
	readonly source: ComputerSource;
	readonly grant: Grant;
	readonly now: number;
};
export type AuthorizationVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };
/** The host's check that `grant` consents to exactly this source's configuration. Without one, every source is denied. */
export type AuthorizationCheck = (request: AuthorizationRequest) => AuthorizationVerdict | Promise<AuthorizationVerdict>;

export type AdapterConfig = {
	readonly triggerId: string;
	readonly sourceId: string;
	readonly generation: number;
	readonly source: ComputerSource;
	/** The checkpoint the space has durably taken, or null to start fresh. */
	readonly resume: Checkpoint | null;
	/** Aborted when the runtime stops this adapter. */
	readonly signal: AbortSignal;
	/**
	 * Says this observer's coverage ended for good at `at`, for `code`. The
	 * runtime always gives it; it is optional only so an adapter can be
	 * started without a runtime.
	 */
	readonly endCoverage?: EndCoverage;
};
/** When an observer's coverage ended, by its own clock reading, and why, as a health code. */
export type CoverageEnd = { readonly at: number; readonly code: string };
/**
 * `recorded`: the end, its gap and the generation's end record are durable,
 * and the observer is stopped. `stopped`: the observer is fenced, by this or
 * anything else. `not_started`: it isn't installed yet; nothing was
 * recorded, try again. `unavailable`: nothing was recorded, try again.
 * `invalid`: not a `CoverageEnd`; nothing was recorded.
 */
export type EndCoverageResult = "recorded" | "stopped" | "not_started" | "unavailable" | "invalid";
export type EndCoverage = (end: CoverageEnd) => Promise<EndCoverageResult>;
/**
 * What an adapter observed. The runtime copies it when `emit` is called, so
 * changing it afterwards changes nothing. `key`, when it has one, makes the
 * event id stable across re-reads, so the space takes it once.
 */
export type Observed = { readonly occurredAt: number; readonly data: JsonObject; readonly checkpoint?: Checkpoint | null; readonly key?: string | null };
/**
 * Whether the runtime has durably spooled an observation. When it hasn't,
 * nothing of it was kept, and the adapter must not move its own cursor past
 * it: `backpressure` asks it to hold off until `resume`.
 */
export type EmitResult =
	| { readonly ok: true; readonly eventId: string; readonly duplicate: boolean }
	| { readonly ok: false; readonly reason: "stopped" | "not_started" | "invalid" | "too_large" | "backpressure" | "spool_unavailable" };
/** A short code, such as `poll_timeout`; never an error's text or anything observed. */
export type AdapterHealth = { readonly status: "ok" | "degraded" | "error"; readonly code: string };
export type Emit = (observed: Observed) => Promise<EmitResult>;

/**
 * One observer of one generation of one source. The runtime calls `start`
 * at most once and `stop` at most once, possibly while `start` is still
 * running. `stop` must release what this adapter started and nothing else:
 * its own process, watch or handle, never one found by name.
 */
export interface ObserverAdapter {
	start(config: AdapterConfig, emit: Emit, health: (report: AdapterHealth) => void): Promise<void>;
	stop(reason: StopReason): Promise<void>;
	/** The space has durably taken everything up to `checkpoint`; the adapter may keep it as where to resume. */
	commit?(checkpoint: Checkpoint): void;
	pause?(): void;
	resume?(): void;
}
export type AdapterFactory = (source: ComputerSource) => ObserverAdapter;
/** What the runtime logs: codes and counts, never what was observed, a command or an error's text. */
export type RuntimeLogEvent = { readonly code: string; readonly triggerId?: string; readonly generation?: number; readonly count?: number };

export type RuntimeLimits = {
	readonly leaseMs: number;
	readonly frameBytes: number;
	readonly dataBytes: number;
	readonly inboundBytes: number;
	readonly sources: number;
	readonly ttlMs: number;
	/** How soon after entries leave the spool the journal is rewritten without them. */
	readonly scrubAfterMs: number;
	/** Frames of observations sent in one flush. */
	readonly batch: number;
	readonly flushIntervalMs: number;
	/** How long an unsettled entry waits before it is sent again, doubling up to `maxResendMs`. */
	readonly resendAfterMs: number;
	readonly maxResendMs: number;
	/** How long to wait when the transport takes nothing, or the spool can't be written. */
	readonly blockedRetryMs: number;
	readonly startTimeoutMs: number;
	readonly stopTimeoutMs: number;
	/** Control messages held for the current connection. */
	readonly control: number;
};

export const DEFAULT_LIMITS: RuntimeLimits = {
	leaseMs: HARD_LIMITS.leaseMs,
	frameBytes: HARD_LIMITS.frameBytes,
	dataBytes: HARD_LIMITS.dataBytes,
	inboundBytes: 1_048_576,
	sources: HARD_LIMITS.sources,
	ttlMs: HARD_LIMITS.spoolTtlMs,
	scrubAfterMs: 60_000,
	batch: 32,
	flushIntervalMs: 10,
	resendAfterMs: 30_000,
	maxResendMs: 300_000,
	blockedRetryMs: 1_000,
	startTimeoutMs: 30_000,
	stopTimeoutMs: 10_000,
	control: 1_024,
};

function runtimeLimits(given: Partial<RuntimeLimits>): RuntimeLimits {
	const limits = { ...DEFAULT_LIMITS, ...given };
	const check = (name: keyof RuntimeLimits, min: number, max: number) => {
		const value = limits[name];
		if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be from ${min} to ${max}`);
	};
	check("leaseMs", 1_000, HARD_LIMITS.leaseMs);
	check("frameBytes", 1_024, HARD_LIMITS.frameBytes);
	check("dataBytes", 1, HARD_LIMITS.dataBytes);
	check("inboundBytes", 1_024, HARD_LIMITS.inboundBytes);
	check("sources", 1, HARD_LIMITS.sources);
	check("ttlMs", 1_000, HARD_LIMITS.spoolTtlMs);
	check("scrubAfterMs", 1, HARD_LIMITS.scrubAfterMs);
	check("batch", 1, 1_024);
	check("flushIntervalMs", 1, 60_000);
	check("resendAfterMs", 100, HARD_LIMITS.spoolTtlMs);
	check("maxResendMs", limits.resendAfterMs, HARD_LIMITS.spoolTtlMs);
	check("blockedRetryMs", 10, 600_000);
	check("startTimeoutMs", 1, 600_000);
	check("stopTimeoutMs", 1, 600_000);
	// Room for the most parts an answer to a reconcile can take, and more.
	check("control", limits.sources + 16, 65_536);
	return limits;
}

export type TriggersRuntimeOptions = {
	readonly binding: Binding;
	readonly spool: ObservationSpool;
	readonly adapters: AdapterFactory;
	readonly authorize?: AuthorizationCheck;
	readonly clock?: RuntimeClock;
	readonly log?: (event: RuntimeLogEvent) => void;
	readonly limits?: Partial<RuntimeLimits>;
};

type Run = {
	readonly token: number;
	readonly desired: DesiredSource;
	/** The epoch it was started in; everything it reports is labelled with it, and dropped once that epoch is replaced. */
	readonly epoch: number;
	readonly abort: AbortController;
	adapter: ObserverAdapter | null;
	state: "validating" | "starting" | "installed" | "stopping" | "stopped";
	/** Set the moment the runtime decides to stop it: from then on nothing it emits is taken. */
	fenced: boolean;
	paused: boolean;
	/** Settles when its stop has returned, failed or timed out. */
	stopped: Promise<void>;
	/**
	 * What it emitted that the space hasn't settled, in order, with settled
	 * stretches between them merged into one item, so it holds at most about
	 * twice its entries in the spool.
	 */
	pending: { seq: number; checkpoint: Checkpoint | null; settled: boolean }[];
	/** Set at its first loss or refusal: from then on it commits no checkpoint, and only a new observer, from the space's checkpoint, does. */
	barrier: boolean;
	/** When it was installed. */
	installedAt: number | null;
	/** When the runtime paused it, until it resumes it: nothing it saw since has been taken. */
	pausedAt: number | null;
	/** Its end being recorded: a repeated call while one is outstanding gets the same answer, so callers can't pile up. */
	ending: Promise<EndCoverageResult> | null;
};
type Slot = {
	run: Run | null;
	chain: Promise<void>;
	/** What the trigger's latest generation is; the same generation with another source is refused. */
	identity: { readonly generation: number; readonly sourceId: string; readonly revision: number; readonly configHash: string } | null;
	/** Whether the latest reconcile wants it. A slot not wanted goes once its observer has stopped. */
	wanted: boolean;
	/** When its last installed observer stopped: the start of a break in coverage not yet recorded. */
	coveredUntil: number | null;
};
type TimerName = "lease" | "flush" | "expiry" | "scrub" | "losses";
type Delivery = { sentAt: number | null; attempts: number; notBefore: number };
type LossTarget = { readonly epoch: number; readonly triggerId: string | null; readonly sourceId: string | null; readonly generation: number | null };
/** `apart`: written as a gap of its own, never merged into another, so its window keeps its meaning. */
type Loss = { readonly target: LossTarget; readonly reasons: GapCounts; readonly from: number; readonly to: number; readonly apart?: boolean };

const SYSTEM_CLOCK: RuntimeClock = {
	now: () => Date.now(),
	setTimer: (ms, run) => {
		const timer = setTimeout(run, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

/** The most values one observation's data may hold, so copying it is bounded before its size is known. */
const MAX_DATA_VALUES = 16_384;

/**
 * Copies what an adapter emitted into frozen plain JSON, reading each field
 * once: a getter, a symbol-keyed or inherited property, a non-plain object, a
 * number that isn't finite, or too much nesting is refused. Nothing the
 * adapter keeps can change the copy.
 */
function snapshotObserved(value: unknown): Required<Observed> | null {
	try {
		const given = fields(value, ["occurredAt", "data", "checkpoint", "key"]);
		const occurredAt = int(given.occurredAt, 0, Number.MAX_SAFE_INTEGER);
		const checkpointValue = given.checkpoint;
		const keyValue = given.key;
		const budget = { values: 0 };
		const data = copyJson(given.data, 0, budget);
		if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
		return Object.freeze({
			occurredAt,
			data: data as JsonObject,
			checkpoint: checkpointValue === undefined || checkpointValue === null ? null : Object.freeze(readCheckpoint(copyJson(checkpointValue, 0, budget))),
			key: keyValue === undefined || keyValue === null ? null : str(keyValue, 256),
		});
	} catch {
		return null;
	}
}

function copyJson(value: unknown, depth: number, budget: { values: number }): JsonValue {
	if (++budget.values > MAX_DATA_VALUES || depth > 8) throw new ProtocolError("invalid");
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new ProtocolError("invalid");
		return value;
	}
	if (typeof value !== "object") throw new ProtocolError("invalid");
	const prototype = Object.getPrototypeOf(value);
	if (Array.isArray(value)) {
		if (prototype !== Array.prototype) throw new ProtocolError("invalid");
		const length = value.length;
		const copy: JsonValue[] = [];
		for (let index = 0; index < length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, index);
			if (!descriptor || !("value" in descriptor)) throw new ProtocolError("invalid");
			copy.push(copyJson(descriptor.value, depth + 1, budget));
		}
		return Object.freeze(copy) as JsonValue[];
	}
	if (prototype !== Object.prototype && prototype !== null) throw new ProtocolError("invalid");
	if (Object.getOwnPropertySymbols(value).length > 0) throw new ProtocolError("invalid");
	const copy: JsonObject = {};
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (!("value" in descriptor) || !descriptor.enumerable) throw new ProtocolError("invalid");
		Object.defineProperty(copy, key, { value: copyJson(descriptor.value, depth + 1, budget), enumerable: true, writable: false, configurable: false });
	}
	return Object.freeze(copy);
}

function addCounts(a: GapCounts, b: GapCounts): GapCounts {
	const sum: { [reason in GapReason]?: number } = { ...a };
	for (const [reason, count] of Object.entries(b) as [GapReason, number][]) sum[reason] = (sum[reason] ?? 0) + count;
	return sum;
}

/** Coverage gaps (`interrupted`, `coverage_unknown`) carry a time window of their own, so they merge only with each other. */
function family(reasons: GapCounts): "coverage" | "loss" {
	return "interrupted" in reasons || "coverage_unknown" in reasons ? "coverage" : "loss";
}

function lossKey(target: LossTarget, reasons: GapCounts): string {
	return `${target.epoch}\n${target.sourceId}\n${target.generation}\n${family(reasons)}`;
}

const refused = (reason: Extract<EmitResult, { ok: false }>["reason"]): EmitResult => ({ ok: false, reason });

/**
 * Runs the computer sources one space wants, for the one owner it was
 * configured with. The host gives it a spool, the adapters, the grant check
 * and the connection; see docs/triggers-runtime.md for what each message
 * does. Every change of its state happens in one queue, so a reconcile, an
 * acknowledgement, an emission and a timer never interleave inside a step.
 */
export class TriggersRuntime {
	readonly #binding: Binding;
	readonly #spool: ObservationSpool;
	readonly #adapters: AdapterFactory;
	readonly #authorize: AuthorizationCheck;
	readonly #clock: RuntimeClock;
	readonly #log: (event: RuntimeLogEvent) => void;
	readonly #limits: RuntimeLimits;

	#transport: Transport | null = null;
	#connectionId: string | null = null;
	/** Whether the current connection has had a reconcile, which observations and observers' reports wait for. */
	#reconciled = false;
	#desiredRevision = -1;
	/** The digest of the reconcile last taken at `#desiredRevision`, which the same revision again must match. */
	#appliedDigest: string | null = null;
	#leaseExpiresAt: number | null = null;
	readonly #timers: { [name in TimerName]: { cancel: (() => void) | null; at: number } } = {
		lease: { cancel: null, at: Number.POSITIVE_INFINITY },
		flush: { cancel: null, at: Number.POSITIVE_INFINITY },
		expiry: { cancel: null, at: Number.POSITIVE_INFINITY },
		scrub: { cancel: null, at: Number.POSITIVE_INFINITY },
		losses: { cancel: null, at: Number.POSITIVE_INFINITY },
	};
	readonly #slots = new Map<string, Slot>();
	#control: RuntimeMessage[] = [];
	readonly #delivery = new Map<number, Delivery>();
	/** Sequences sent at least once since this runtime started: these are never coalesced or merged into. */
	readonly #transmitted = new Set<number>();
	/** Losses seen but not yet durable as gaps, one per source, generation and epoch; written with the next commit that can be. */
	readonly #losses = new Map<string, Loss>();
	#queue: Promise<void> = Promise.resolve();
	#pending = 0;
	#tokens = 0;
	#closed = false;

	constructor(options: TriggersRuntimeOptions) {
		this.#binding = deepFreeze({ space: ident(options.binding.space), runtimeId: ident(options.binding.runtimeId) });
		this.#spool = options.spool;
		this.#adapters = options.adapters;
		this.#authorize = options.authorize ?? (() => ({ ok: false, reason: "no authorization check is configured" }));
		this.#clock = options.clock ?? SYSTEM_CLOCK;
		this.#log = options.log ?? (() => undefined);
		this.#limits = runtimeLimits(options.limits ?? {});
		// What a previous run left may already have been sent.
		for (const entry of this.#spool.entries()) this.#transmitted.add(entry.seq);
		void this.#enqueue(() => this.#afterOpen()).catch(() => undefined);
	}

	/** Starts using a connection to the space. Nothing is sent but `hello` until the space reconciles on it. */
	attach(transport: Transport, connectionId: string): void {
		if (this.#closed) return;
		this.#transport = transport;
		this.#connectionId = ident(connectionId);
		this.#reconciled = false;
		this.#control = [];
		this.#resetDelivery();
		this.#push({ protocol: PROTOCOL, type: "hello", runtimeId: this.#binding.runtimeId, connectionId, lastEpoch: this.#spool.epoch, pending: this.#spool.count });
	}

	/** The connection is gone. Observers keep running, and spooling, until the lease runs out. */
	detach(connectionId: string): void {
		if (connectionId !== this.#connectionId) return;
		this.#transport = null;
		this.#connectionId = null;
		this.#reconciled = false;
		this.#control = [];
		this.#cancel("flush");
		this.#resetDelivery();
	}

	/** Takes one frame from the space, on the connection it came in on. */
	receive(connectionId: string, frame: string): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#closed || connectionId !== this.#connectionId) return;
			let message: ServerMessage;
			try {
				message = parseServerMessage(frame, this.#limits);
			} catch (error) {
				const code = error instanceof ProtocolError ? error.code : "invalid";
				this.#log({ code: `message_${code}` });
				this.#push({ protocol: PROTOCOL, type: "error", code });
				return;
			}
			if (message.connectionId !== this.#connectionId) {
				this.#push({ protocol: PROTOCOL, type: "error", code: "wrong_connection" });
				return;
			}
			if (message.type === "reconcile") await this.#reconcile(message);
			else await this.#acknowledged(message);
		}).catch(() => undefined);
	}

	/** Each trigger's current observer, for the host's status and the tests. */
	sources(): { triggerId: string; sourceId: string; generation: number; epoch: number; state: Run["state"]; paused: boolean; outstanding: number; barrier: boolean }[] {
		const listed = [];
		for (const [triggerId, slot] of this.#slots) {
			const run = slot.run;
			if (run) listed.push({ triggerId, sourceId: run.desired.sourceId, generation: run.desired.generation, epoch: run.epoch, state: run.state, paused: run.paused, outstanding: run.pending.length, barrier: run.barrier });
		}
		return listed;
	}

	/** How many triggers the runtime keeps state for; at most the latest desired set and observers still stopping. */
	get slotCount(): number {
		return this.#slots.size;
	}

	/** Resolves once the queue has nothing left to do: for shutting down, and for tests. */
	async idle(): Promise<void> {
		do {
			await new Promise((resolve) => setImmediate(resolve));
			await this.#queue;
			await new Promise((resolve) => setImmediate(resolve));
		} while (this.#pending > 0);
	}

	/** Stops every observer, waits for their stops (each bounded by `stopTimeoutMs`), takes retired bytes out of the journal, and closes the spool. */
	async close(): Promise<void> {
		if (this.#closed) return;
		const runs = [...this.#slots.values()].map((slot) => slot.run).filter((run): run is Run => run !== null);
		for (const run of runs) this.#stop(run, "shutdown");
		this.#closed = true;
		this.#transport = null;
		for (const name of Object.keys(this.#timers) as (TimerName)[]) this.#cancel(name);
		await Promise.all(runs.map((run) => run.stopped));
		await this.idle();
		if (this.#spool.retiredBytes > 0) await this.#spool.compact().catch(() => this.#log({ code: "spool_unavailable" }));
		await this.#spool.close();
	}

	#enqueue<T>(task: () => Promise<T> | T): Promise<T> {
		this.#pending++;
		const result = this.#queue.then(task);
		this.#queue = result.then(
			() => {
				this.#pending--;
			},
			() => {
				this.#pending--;
				this.#log({ code: "internal_error" });
			},
		);
		return result;
	}

	#timer(name: TimerName, delay: number, task: () => Promise<void> | void): void {
		const timer = this.#timers[name];
		const at = this.#clock.now() + Math.max(0, delay);
		if (this.#closed || (timer.cancel && timer.at <= at)) return;
		timer.cancel?.();
		timer.at = at;
		timer.cancel = this.#clock.setTimer(Math.max(0, delay), () => {
			timer.cancel = null;
			timer.at = Number.POSITIVE_INFINITY;
			void this.#enqueue(task).catch(() => undefined);
		});
	}

	#cancel(name: TimerName): void {
		const timer = this.#timers[name];
		timer.cancel?.();
		timer.cancel = null;
		timer.at = Number.POSITIVE_INFINITY;
	}

	async #afterOpen(): Promise<void> {
		const epoch = this.#spool.epoch;
		const corrupt = this.#spool.recovery.corrupt;
		if (corrupt > 0) this.#log({ code: "spool_corrupt", count: corrupt });
		if (epoch === null) {
			// Nothing was ever written under an epoch, so nothing observed was lost; the corrupt lines just go.
			if (corrupt > 0) await this.#spool.compact().catch(() => this.#log({ code: "spool_unavailable" }));
			return;
		}
		const now = this.#clock.now();
		if (corrupt > 0) this.#noteLoss({ epoch, triggerId: null, sourceId: null, generation: null }, { corrupt }, now, now);
		const stale = this.#spool.entries().filter((entry) => entry.epoch < epoch);
		if (stale.length === 0 && corrupt === 0) return this.#sweepExpired();
		// One commit records the losses and takes out what they stand for; the journal is rewritten, so the corrupt lines go only then.
		const written = await this.#commitLosses(this.#lossesOf(stale, epoch, "epoch_replaced"), stale.map((entry) => entry.seq), { rewrite: true });
		if (written) this.#settle(new Set(stale.map((entry) => entry.seq)), "lost");
		await this.#sweepExpired();
	}

	async #reconcile(message: ReconcileMessage): Promise<void> {
		if (message.binding.space !== this.#binding.space || message.binding.runtimeId !== this.#binding.runtimeId) {
			this.#log({ code: "binding_mismatch" });
			this.#push({ protocol: PROTOCOL, type: "error", code: "binding_mismatch" });
			return;
		}
		const epoch = this.#spool.epoch;
		if (epoch !== null && message.serverEpoch < epoch) {
			this.#push({ protocol: PROTOCOL, type: "error", code: "stale_epoch" });
			return;
		}
		const digest = sha256(canonical({ sources: message.sources, leaseMs: message.leaseMs }));
		if (epoch === message.serverEpoch) {
			if (message.desiredRevision < this.#desiredRevision) {
				this.#push({ protocol: PROTOCOL, type: "error", code: "stale_reconcile" });
				return;
			}
			if (message.desiredRevision === this.#desiredRevision && digest !== this.#appliedDigest) {
				this.#log({ code: "divergent_reconcile" });
				this.#push({ protocol: PROTOCOL, type: "error", code: "divergent_reconcile" });
				return;
			}
		} else {
			// A new epoch: from now on nothing of the old one goes out, neither an observation, sent again or
			// not, nor a report still queued, whether or not the change below can be written. Every observer
			// stops. The new epoch, the gaps that count what the old one held, and taking that out are one
			// commit; until it is durable, the epoch hasn't changed and nothing is reported as reconciled.
			this.#reconciled = false;
			this.#control = this.#control.filter((held) => !("serverEpoch" in held));
			for (const slot of this.#slots.values()) if (slot.run) this.#stop(slot.run, "epoch_replaced");
			const stale = this.#spool.entries();
			const seqs = stale.map((entry) => entry.seq);
			if (!(await this.#commitLosses(this.#lossesOf(stale, message.serverEpoch, "epoch_replaced"), seqs, { epoch: message.serverEpoch, rewrite: true }))) {
				this.#push({ protocol: PROTOCOL, type: "error", code: "spool_unavailable" });
				return;
			}
			this.#settle(new Set(seqs), "lost");
			this.#desiredRevision = -1;
			this.#appliedDigest = null;
		}
		this.#desiredRevision = message.desiredRevision;
		this.#appliedDigest = digest;
		this.#reconciled = true;
		this.#renewLease(message.leaseMs);
		for (const slot of this.#slots.values()) slot.wanted = false;
		const results: { triggerId: string; sourceId: string; generation: number; state: SourceState }[] = [];
		for (const desired of message.sources) results.push({ triggerId: desired.triggerId, sourceId: desired.sourceId, generation: desired.generation, state: this.#want(desired) });
		for (const slot of [...this.#slots.values()]) {
			if (slot.wanted) continue;
			if (slot.run) this.#stop(slot.run, "not_desired");
			this.#prune(slot);
		}
		this.#answer(message, results);
		this.#scheduleFlush(0);
	}

	/** Sends the answer to a reconcile in as many parts as `frameBytes` needs; an older answer still queued goes, since this one says where everything stands. */
	#answer(message: ReconcileMessage, results: { triggerId: string; sourceId: string; generation: number; state: SourceState }[]): void {
		this.#control = this.#control.filter((held) => held.type !== "reconciled");
		const head = { protocol: PROTOCOL, type: "reconciled", serverEpoch: message.serverEpoch, desiredRevision: message.desiredRevision, leaseMs: message.leaseMs } as const;
		const most = results.length + 1;
		const overhead = Buffer.byteLength(JSON.stringify({ ...head, part: most, parts: most, sources: [] }));
		const chunks: (typeof results)[] = [[]];
		let size = overhead;
		for (const result of results) {
			const bytes = Buffer.byteLength(JSON.stringify(result)) + 1;
			if ((chunks.at(-1) as typeof results).length > 0 && size + bytes > this.#limits.frameBytes) {
				chunks.push([]);
				size = overhead;
			}
			(chunks.at(-1) as typeof results).push(result);
			size += bytes;
		}
		chunks.forEach((sources, index) => this.#push({ ...head, part: index + 1, parts: chunks.length, sources }));
	}

	/** Makes one trigger's observer match what the space wants, starting one only when what runs differs. */
	#want(desired: DesiredSource): SourceState {
		let slot = this.#slots.get(desired.triggerId);
		if (!slot) {
			slot = { run: null, chain: Promise.resolve(), identity: null, wanted: true, coveredUntil: null };
			this.#slots.set(desired.triggerId, slot);
		}
		slot.wanted = true;
		const run = slot.run;
		const refuse = (code: string): SourceState => {
			if (run) this.#stop(run, "invalid");
			this.#push({ protocol: PROTOCOL, type: "health", serverEpoch: this.#spool.epoch ?? 0, triggerId: desired.triggerId, sourceId: desired.sourceId, generation: desired.generation, status: "error", code });
			return "invalid";
		};
		if (desired.configHash !== sourceConfigHash(desired.source)) return refuse("config_hash_mismatch");
		const identity = slot.identity;
		if (identity && desired.generation < identity.generation) return "stale";
		if (identity && desired.generation === identity.generation && (identity.sourceId !== desired.sourceId || identity.revision !== desired.revision || identity.configHash !== desired.configHash)) {
			return refuse("generation_mismatch");
		}
		slot.identity = { generation: desired.generation, sourceId: desired.sourceId, revision: desired.revision, configHash: desired.configHash };
		const ended = this.#spool.end(desired.triggerId);
		if (ended && ended.generation === desired.generation && ended.sourceId === desired.sourceId && ended.configHash === desired.configHash) {
			// This generation ended for good, durably: nothing runs it again, however often it is asked for, until a new generation.
			this.#push({ protocol: PROTOCOL, type: "health", serverEpoch: this.#spool.epoch ?? 0, triggerId: desired.triggerId, sourceId: desired.sourceId, generation: desired.generation, status: "error", code: ended.code });
			return "ended";
		}
		if (run && !run.fenced) {
			if (run.desired.generation === desired.generation) {
				if (run.desired.grant.grantRef === desired.grant.grantRef && run.desired.grant.scopeHash === desired.grant.scopeHash) {
					this.#recheck(run);
					return run.state === "installed" ? "running" : "starting";
				}
				this.#stop(run, "consent_changed");
			} else {
				this.#stop(run, "reconfigured");
			}
		}
		this.#launch(slot, desired);
		return "starting";
	}

	#launch(slot: Slot, desired: DesiredSource): void {
		const previous = slot.run;
		const run: Run = {
			token: ++this.#tokens,
			desired,
			epoch: this.#spool.epoch as number,
			abort: new AbortController(),
			adapter: null,
			state: "validating",
			fenced: false,
			paused: false,
			stopped: Promise.resolve(),
			pending: [],
			barrier: false,
			installedAt: null,
			pausedAt: null,
			ending: null,
		};
		slot.run = run;
		// One observer per trigger at a time: this one starts only once the one before it has stopped.
		slot.chain = Promise.all([slot.chain, previous?.stopped])
			.then(() => this.#begin(run))
			.catch(() => this.#log({ code: "internal_error", triggerId: desired.triggerId, generation: desired.generation }));
	}

	/** Whether a run is still its trigger's observer in the current epoch; checked again after everything it waits for. */
	#current(run: Run): boolean {
		return !run.fenced && run.epoch === this.#spool.epoch && this.#slots.get(run.desired.triggerId)?.run === run;
	}

	async #begin(run: Run): Promise<void> {
		if (!this.#current(run)) return;
		const allowed = await this.#authorized(run.desired);
		if (!this.#current(run)) return;
		if (!allowed) {
			run.fenced = true;
			run.state = "stopped";
			this.#report(run, { status: "error", code: "auth_denied" });
			return;
		}
		let adapter: ObserverAdapter;
		try {
			adapter = this.#adapters(run.desired.source);
		} catch {
			run.fenced = true;
			run.state = "stopped";
			this.#report(run, { status: "error", code: "unsupported" });
			return;
		}
		run.adapter = adapter;
		run.state = "starting";
		const config: AdapterConfig = Object.freeze({
			triggerId: run.desired.triggerId,
			sourceId: run.desired.sourceId,
			generation: run.desired.generation,
			source: run.desired.source,
			resume: run.desired.checkpoint,
			signal: run.abort.signal,
			endCoverage: (end: CoverageEnd) => this.#endCoverage(run, end),
		});
		let outcome: "returned" | "timed_out" | "failed";
		try {
			outcome = await this.#bounded(
				Promise.resolve().then(() =>
					adapter.start(
						config,
						(observed) => this.#emit(run, observed),
						(report) => this.#health(run, report),
					),
				),
				this.#limits.startTimeoutMs,
			);
		} catch {
			outcome = "failed";
		}
		// A run stopped while it started has already been asked to stop, and is never reported as installed.
		if (!this.#current(run)) return;
		if (outcome !== "returned") {
			this.#log({ code: "adapter_start_failed", triggerId: run.desired.triggerId, generation: run.desired.generation });
			this.#report(run, { status: "error", code: outcome === "timed_out" ? "start_timed_out" : "start_failed" });
			this.#stop(run, "start_failed");
			return;
		}
		// The space hears of the break in coverage, durably, before anything this observer sees.
		const written = await this.#enqueue(async () => {
			if (!this.#current(run)) return false;
			const slot = this.#slots.get(run.desired.triggerId) as Slot;
			const now = this.#clock.now();
			const loss: Loss =
				slot.coveredUntil === null
					? { target: this.#target(run), reasons: { coverage_unknown: 1 }, from: now, to: now }
					: { target: this.#target(run), reasons: { interrupted: 1 }, from: slot.coveredUntil, to: now };
			// An older generation's end record goes with the gap that starts the newer one.
			const ended = this.#spool.end(run.desired.triggerId);
			if (!(await this.#commitLosses([loss], [], ended ? { unend: [ended.triggerId] } : {}))) return false;
			slot.coveredUntil = null;
			return true;
		}).catch(() => false);
		if (!this.#current(run)) return;
		if (!written) {
			this.#report(run, { status: "error", code: "spool_unavailable" });
			this.#stop(run, "spool_unavailable");
			return;
		}
		run.state = "installed";
		run.installedAt = this.#clock.now();
		this.#pushFor(run, { ...this.#ref(run), protocol: PROTOCOL, type: "installed", configHash: run.desired.configHash });
		this.#report(run, { status: "ok", code: "listening" });
	}

	async #authorized(desired: DesiredSource): Promise<boolean> {
		try {
			const verdict = await this.#authorize(
				Object.freeze({
					binding: this.#binding,
					triggerId: desired.triggerId,
					sourceId: desired.sourceId,
					generation: desired.generation,
					configHash: desired.configHash,
					source: desired.source,
					grant: desired.grant,
					now: this.#clock.now(),
				}),
			);
			return typeof verdict === "object" && verdict !== null && verdict.ok === true;
		} catch {
			return false;
		}
	}

	/** Checks a running observer's grant again; a grant no longer good stops it. */
	#recheck(run: Run): void {
		void this.#authorized(run.desired).then((ok) =>
			this.#enqueue(() => {
				if (ok || !this.#current(run)) return;
				this.#report(run, { status: "error", code: "auth_denied" });
				this.#stop(run, "revoked");
			}),
		);
	}

	/** Fences a run at once, then asks its own adapter, and only it, to stop. */
	#stop(run: Run, reason: StopReason): void {
		if (run.fenced) return;
		run.fenced = true;
		run.abort.abort();
		const slot = this.#slots.get(run.desired.triggerId);
		// Coverage ends now, or when the runtime paused it if it never resumed: nothing it saw since was taken.
		if (slot?.run === run && run.state === "installed") slot.coveredUntil = run.pausedAt ?? this.#clock.now();
		const adapter = run.adapter;
		if (!adapter) {
			run.state = "stopped";
			this.#pushFor(run, { ...this.#ref(run), protocol: PROTOCOL, type: "stopped", reason, adapter: "not_started" });
			if (slot) this.#prune(slot);
			return;
		}
		run.state = "stopping";
		run.stopped = this.#bounded(
			Promise.resolve().then(() => adapter.stop(reason)),
			this.#limits.stopTimeoutMs,
		)
			.catch(() => "failed" as const)
			.then((outcome) => {
				run.state = "stopped";
				if (outcome !== "returned") this.#log({ code: `adapter_stop_${outcome}`, triggerId: run.desired.triggerId, generation: run.desired.generation });
				this.#pushFor(run, { ...this.#ref(run), protocol: PROTOCOL, type: "stopped", reason, adapter: outcome });
				const current = this.#slots.get(run.desired.triggerId);
				if (current) this.#prune(current);
			});
	}

	/** Forgets a trigger no reconcile wants, once its observer has stopped. Its generation and coverage go with it. */
	#prune(slot: Slot): void {
		if (slot.wanted || (slot.run && slot.run.state !== "stopped")) return;
		for (const [triggerId, held] of this.#slots) if (held === slot) this.#slots.delete(triggerId);
	}

	#bounded(work: Promise<unknown>, ms: number): Promise<"returned" | "timed_out"> {
		return new Promise((resolve, reject) => {
			const cancel = this.#clock.setTimer(ms, () => resolve("timed_out"));
			work.then(
				() => {
					cancel();
					resolve("returned");
				},
				(error) => {
					cancel();
					reject(error);
				},
			);
		});
	}

	#renewLease(ms: number): void {
		this.#leaseExpiresAt = this.#clock.now() + ms;
		this.#cancel("lease");
		this.#timer("lease", ms, () => this.#expireLease());
	}

	#expireLease(): void {
		if (this.#leaseExpiresAt === null) return;
		// A timer may run before `now()` has reached its time: Node's run on libuv's monotonic clock, which can be up to a millisecond behind `Date.now()`. The lease isn't over yet, so its timer is set again for what is left.
		const left = this.#leaseExpiresAt - this.#clock.now();
		if (left > 0) {
			this.#timer("lease", left, () => this.#expireLease());
			return;
		}
		this.#leaseExpiresAt = null;
		this.#log({ code: "lease_expired" });
		for (const slot of this.#slots.values()) if (slot.run) this.#stop(slot.run, "lease_expired");
	}

	#ref(run: Run): SourceRef {
		return { serverEpoch: run.epoch, triggerId: run.desired.triggerId, sourceId: run.desired.sourceId, generation: run.desired.generation };
	}

	#target(run: Run): LossTarget {
		return { epoch: run.epoch, triggerId: run.desired.triggerId, sourceId: run.desired.sourceId, generation: run.desired.generation };
	}

	/**
	 * Control from or about a run goes only to a connection the space has
	 * reconciled on, and only while the run's epoch is current: the next
	 * reconcile's answer, and the gaps in the spool, cover what is dropped.
	 */
	#pushFor(run: Run, message: RuntimeMessage): void {
		if (!this.#reconciled || run.epoch !== this.#spool.epoch) return;
		this.#push(message);
	}

	#report(run: Run, health: AdapterHealth): void {
		this.#pushFor(run, { ...this.#ref(run), protocol: PROTOCOL, type: "health", status: health.status, code: health.code });
	}

	#health(run: Run, report: unknown): void {
		if (!this.#current(run) || run.state !== "installed") return;
		const given = report as AdapterHealth;
		if (typeof given !== "object" || given === null || !["ok", "degraded", "error"].includes(given.status) || typeof given.code !== "string" || !HEALTH_CODE.test(given.code)) {
			this.#log({ code: "adapter_health_invalid", triggerId: run.desired.triggerId, generation: run.desired.generation });
			return;
		}
		this.#report(run, { status: given.status, code: given.code });
	}

	/**
	 * An observer says its coverage ended for good. One call at a time per
	 * observer: a repeat while one is outstanding gets the same answer. What
	 * it is given is read now, before anything waits; the work runs in the
	 * queue, so nothing else changes the observer, the epoch or the spool
	 * while it does.
	 */
	#endCoverage(run: Run, end: unknown): Promise<EndCoverageResult> {
		if (run.fenced) return Promise.resolve("stopped");
		if (run.ending) return run.ending;
		let given: CoverageEnd;
		try {
			const read = fields(end, ["at", "code"]);
			const code = read.code;
			if (typeof code !== "string" || !HEALTH_CODE.test(code)) return Promise.resolve("invalid");
			given = { at: int(read.at, 0, Number.MAX_SAFE_INTEGER), code };
		} catch {
			return Promise.resolve("invalid");
		}
		const ending: Promise<EndCoverageResult> = this.#enqueue(() => this.#recordEnd(run, given))
			.catch((): EndCoverageResult => "unavailable")
			.finally(() => {
				if (run.ending === ending) run.ending = null;
			});
		run.ending = ending;
		return ending;
	}

	/**
	 * Records an end in one commit: a gap of its own, `interrupted` from the
	 * end to now, and the generation's end record, which replaces any other of
	 * the trigger's. The end is the adapter's, bounded to when the observer
	 * was installed and now. Only once that is durable is the observer
	 * stopped and the trigger's coverage counted as broken from the end; if
	 * it can't be written, nothing changes and the adapter may try again.
	 */
	async #recordEnd(run: Run, given: CoverageEnd): Promise<EndCoverageResult> {
		if (!this.#current(run)) return "stopped";
		if (run.state !== "installed" || run.installedAt === null) return "not_started";
		const now = this.#clock.now();
		const at = Math.min(Math.max(given.at, run.installedAt), now);
		const { triggerId, sourceId, generation, configHash } = run.desired;
		const record: EndRecord = { triggerId, sourceId, generation, configHash, at, code: given.code, recordedAt: now };
		const loss: Loss = { target: this.#target(run), reasons: { interrupted: 1 }, from: at, to: now, apart: true };
		if (!(await this.#commitLosses([loss], [], { ends: [record], unend: this.#evictEnd(triggerId) }))) {
			this.#log({ code: "end_unrecorded", triggerId, generation });
			return "unavailable";
		}
		this.#log({ code: "observer_ended", triggerId, generation });
		// Durable now. Whatever fenced the observer meanwhile, the next generation's gap starts at the end.
		const current = this.#current(run);
		if (current) this.#report(run, { status: "error", code: given.code });
		this.#stop(run, "ended");
		const slot = this.#slots.get(triggerId);
		if (slot?.run === run) slot.coveredUntil = at;
		return current ? "recorded" : "stopped";
	}

	/** Which end record goes to make room for another trigger's: the oldest of a trigger no longer kept, else the oldest. */
	#evictEnd(triggerId: string): string[] {
		const ends = this.#spool.ends();
		if (this.#spool.end(triggerId) || ends.length < MAX_END_RECORDS) return [];
		const oldest = (records: EndRecord[]) => records.sort((a, b) => a.recordedAt - b.recordedAt)[0];
		const victim = oldest(ends.filter((record) => !this.#slots.has(record.triggerId))) ?? oldest(ends);
		return victim ? [victim.triggerId] : [];
	}

	#emit(run: Run, observed: unknown): Promise<EmitResult> {
		if (run.fenced) return Promise.resolve(refused("stopped"));
		if (run.state !== "installed") return Promise.resolve(refused("not_started"));
		// Copied now, before anything waits, so what the adapter does with its object afterwards changes nothing.
		const given = snapshotObserved(observed);
		if (!given) return Promise.resolve(refused("invalid"));
		return this.#enqueue(() => this.#accept(run, given)).catch(() => refused("spool_unavailable"));
	}

	async #accept(run: Run, observed: Required<Observed>): Promise<EmitResult> {
		const now = this.#clock.now();
		if (this.#leaseExpiresAt !== null && now >= this.#leaseExpiresAt) this.#expireLease();
		if (!this.#current(run)) return refused("stopped");
		const desired = run.desired;
		const eventId = observed.key === null ? `r_${randomUUID()}` : `k_${sha256(`${desired.sourceId}\n${observed.key}`).slice(0, 40)}`;
		if (observed.key !== null && this.#spool.findEvent(eventId)) return { ok: true, eventId, duplicate: true };
		let entry: ObservationEntry = {
			kind: "observation",
			seq: this.#spool.allocate(),
			eventId,
			epoch: run.epoch,
			recordedAt: now,
			triggerId: desired.triggerId,
			sourceId: desired.sourceId,
			revision: desired.revision,
			generation: desired.generation,
			occurredAt: observed.occurredAt,
			data: observed.data,
			checkpoint: observed.checkpoint,
			coalesced: null,
		};
		if (Buffer.byteLength(JSON.stringify(entry.data)) > this.#limits.dataBytes || Buffer.byteLength(this.#frame(entry)) > this.#limits.frameBytes) {
			return this.#refuse(run, "too_large", { too_large: 1 }, observed.occurredAt);
		}
		if (run.paused) return this.#refuse(run, "backpressure", { overflow: 1 }, observed.occurredAt);
		let removes: number[] = [];
		if (!this.#spool.fits([entry], [], false)) {
			// A state's snapshots not yet sent may give way to a newer one, which says how many it stands for. Events never do.
			const unsent =
				desired.source.kind === "poll"
					? this.#spool.entries().filter((held): held is ObservationEntry => held.kind === "observation" && held.sourceId === desired.sourceId && held.generation === desired.generation && held.epoch === run.epoch && !this.#transmitted.has(held.seq))
					: [];
			const coalesced: ObservationEntry =
				unsent.length === 0
					? entry
					: {
							...entry,
							coalesced: {
								count: 1 + unsent.reduce((sum, held) => sum + (held.coalesced?.count ?? 1), 0),
								from: Math.min(...unsent.map((held) => held.coalesced?.from ?? held.occurredAt), entry.occurredAt),
								to: entry.occurredAt,
							},
						};
			if (unsent.length > 0 && this.#spool.fits([coalesced], unsent.map((held) => held.seq), false) && Buffer.byteLength(this.#frame(coalesced)) <= this.#limits.frameBytes) {
				entry = coalesced;
				removes = unsent.map((held) => held.seq);
			} else {
				run.paused = true;
				run.pausedAt ??= now;
				try {
					run.adapter?.pause?.();
				} catch {}
				this.#report(run, { status: "degraded", code: "backpressure" });
				return this.#refuse(run, "backpressure", { overflow: 1 }, observed.occurredAt);
			}
		}
		try {
			await this.#spool.commit([entry], removes);
		} catch {
			this.#log({ code: "spool_unavailable", triggerId: desired.triggerId, generation: desired.generation });
			this.#report(run, { status: "error", code: "spool_unavailable" });
			this.#setBarrier(run);
			return refused("spool_unavailable");
		}
		if (removes.length > 0) {
			const gone = new Set(removes);
			for (const seq of removes) this.#delivery.delete(seq);
			run.pending = run.pending.filter((item) => !gone.has(item.seq));
			this.#scheduleScrub();
		}
		if (!run.barrier) run.pending.push({ seq: entry.seq, checkpoint: entry.checkpoint, settled: false });
		this.#delivery.set(entry.seq, { sentAt: null, attempts: 0, notBefore: 0 });
		this.#scheduleFlush(0);
		this.#scheduleExpiry();
		return { ok: true, eventId, duplicate: false };
	}

	/** Refuses an emission: the run commits nothing more, and the refusal is counted in a gap, durably as soon as the spool can take it. */
	async #refuse(run: Run, reason: "too_large" | "backpressure", reasons: GapCounts, at: number): Promise<EmitResult> {
		this.#setBarrier(run);
		this.#noteLoss(this.#target(run), reasons, at, at);
		if (!(await this.#commitLosses([], []))) this.#report(run, { status: "error", code: "loss_unrecorded" });
		return refused(reason);
	}

	#setBarrier(run: Run): void {
		run.barrier = true;
		run.pending = [];
	}

	#noteLoss(target: LossTarget, reasons: GapCounts, from: number, to: number): void {
		const key = lossKey(target, reasons);
		const held = this.#losses.get(key);
		this.#losses.set(key, held ? { target, reasons: addCounts(held.reasons, reasons), from: Math.min(held.from, from), to: Math.max(held.to, to) } : { target, reasons, from, to });
	}

	/** Counts what `entries` held, one loss per source and generation, under `epoch`; a gap among them adds its own counts. */
	#lossesOf(entries: readonly SpoolEntry[], epoch: number, reason: GapReason): Loss[] {
		const groups = new Map<string, { target: LossTarget; reasons: GapCounts; from: number; to: number }>();
		for (const entry of entries) {
			const target: LossTarget = { epoch, triggerId: entry.triggerId, sourceId: entry.sourceId, generation: entry.generation };
			const key = lossKey(target, entry.kind === "gap" ? entry.reasons : { [reason]: 1 });
			const group = groups.get(key) ?? { target, reasons: {}, from: Number.POSITIVE_INFINITY, to: Number.NEGATIVE_INFINITY };
			group.reasons = addCounts(group.reasons, entry.kind === "gap" ? entry.reasons : { [reason]: 1 });
			group.from = Math.min(group.from, entry.kind === "gap" ? entry.from : entry.occurredAt);
			group.to = Math.max(group.to, entry.kind === "gap" ? entry.to : entry.occurredAt);
			groups.set(key, group);
		}
		return [...groups.values()];
	}

	/**
	 * Writes, in one commit: every loss not yet durable and `extra` as gap
	 * entries (merged into a gap of the same source not yet sent), the removal
	 * of `removes`, and the new epoch if given. Either all of it is durable or
	 * none of it is: on failure the entries stay, the epoch stays, `extra` is
	 * not kept (its entries still stand for it), and losses not yet durable
	 * wait for the next try.
	 */
	async #commitLosses(
		extra: readonly Loss[],
		removes: readonly number[],
		options: { epoch?: number; rewrite?: boolean; ends?: readonly EndRecord[]; unend?: readonly string[] } = {},
	): Promise<boolean> {
		const epoch = options.epoch ?? this.#spool.epoch;
		if (epoch === null) return false;
		const removing = new Set(removes);
		const merged = new Map<string, Loss>();
		for (const [index, loss] of [...this.#losses.values(), ...extra].entries()) {
			// A loss of an epoch being replaced is counted in the new one; nothing is sent under the old.
			const target = loss.target.epoch < epoch ? { ...loss.target, epoch } : loss.target;
			const key = loss.apart ? `apart\n${index}` : lossKey(target, loss.reasons);
			const held = merged.get(key);
			merged.set(key, held ? { target, reasons: addCounts(held.reasons, loss.reasons), from: Math.min(held.from, loss.from), to: Math.max(held.to, loss.to) } : { ...loss, target });
		}
		const gaps: GapEntry[] = [];
		const now = this.#clock.now();
		for (const loss of merged.values()) {
			const open = loss.apart
				? undefined
				: this.#spool
						.entries()
						.find(
							(held): held is GapEntry =>
								held.kind === "gap" &&
								lossKey(held, held.reasons) === lossKey(loss.target, loss.reasons) &&
								!this.#transmitted.has(held.seq) &&
								!removing.has(held.seq),
						);
			gaps.push(
				open
					? { ...open, reasons: addCounts(open.reasons, loss.reasons), from: Math.min(open.from, loss.from), to: Math.max(open.to, loss.to) }
					: { kind: "gap", seq: this.#spool.allocate(), eventId: `g_${randomUUID()}`, recordedAt: now, ...loss.target, reasons: loss.reasons, from: loss.from, to: loss.to },
			);
		}
		if (gaps.length === 0 && removes.length === 0 && options.epoch === undefined && !options.rewrite && !options.ends?.length && !options.unend?.length) return true;
		try {
			if (!this.#spool.fits(gaps, removes, true)) throw new SpoolError("full");
			await this.#spool.commit(gaps, removes, options);
		} catch {
			this.#log({ code: "loss_unrecorded" });
			if (this.#losses.size > 0) this.#timer("losses", this.#limits.blockedRetryMs, () => this.#commitLosses([], []).then(() => undefined));
			return false;
		}
		this.#losses.clear();
		for (const gap of gaps) if (!this.#delivery.has(gap.seq)) this.#delivery.set(gap.seq, { sentAt: null, attempts: 0, notBefore: 0 });
		for (const seq of removes) {
			this.#delivery.delete(seq);
			this.#transmitted.delete(seq);
		}
		this.#scheduleScrub();
		this.#scheduleFlush(0);
		return true;
	}

	/** Gives up observations held longer than `ttlMs`: they are never sent, and a gap says so, in the same commit that rewrites them out of the journal. */
	async #sweepExpired(): Promise<void> {
		if (this.#losses.size > 0) await this.#commitLosses([], []);
		const now = this.#clock.now();
		const epoch = this.#spool.epoch;
		const expired = this.#spool.entries().filter((entry) => entry.kind === "observation" && entry.recordedAt + this.#limits.ttlMs <= now);
		if (expired.length > 0 && epoch !== null) {
			const seqs = expired.map((entry) => entry.seq);
			if (await this.#commitLosses(this.#lossesOf(expired, epoch, "expired"), seqs, { rewrite: true })) {
				this.#log({ code: "spool_expired", count: expired.length });
				this.#settle(new Set(seqs), "lost");
				this.#maybeResume();
			}
		}
		this.#scheduleExpiry();
	}

	async #acknowledged(message: AckMessage): Promise<void> {
		if (message.serverEpoch !== this.#spool.epoch) {
			this.#log({ code: "ack_stale_epoch" });
			return;
		}
		const now = this.#clock.now();
		const settled = new Set<number>();
		for (const result of message.results) {
			const entry = this.#spool.get(result.sequence);
			if (!entry || entry.eventId !== result.eventId) {
				this.#log({ code: entry ? "ack_mismatch" : "ack_unknown" });
				continue;
			}
			if (result.result === "deferred") {
				const delivery = this.#delivery.get(entry.seq);
				if (delivery) delivery.notBefore = now + Math.min(Math.max(result.retryAfterMs ?? this.#limits.resendAfterMs, this.#limits.resendAfterMs), this.#limits.maxResendMs);
				continue;
			}
			if (result.result === "rejected") this.#log({ code: "observation_rejected", triggerId: entry.triggerId ?? undefined });
			settled.add(entry.seq);
		}
		if (settled.size > 0) {
			try {
				await this.#spool.commit([], [...settled]);
			} catch {
				// Still held, so it is sent again, and the space answers duplicate.
				this.#log({ code: "spool_unavailable" });
				return;
			}
			for (const seq of settled) {
				this.#delivery.delete(seq);
				this.#transmitted.delete(seq);
			}
			this.#settle(settled, "acked");
			this.#maybeResume();
			this.#scheduleScrub();
		}
		this.#scheduleFlush(0);
	}

	/**
	 * Moves each observer's committed checkpoint over what the space has
	 * settled, in order. A loss sets the observer's barrier instead: it never
	 * commits past a gap, and keeps nothing more to do so.
	 */
	#settle(seqs: ReadonlySet<number>, how: "acked" | "lost"): void {
		for (const slot of this.#slots.values()) {
			const run = slot.run;
			if (!run || run.barrier || !run.pending.some((item) => seqs.has(item.seq))) continue;
			if (how === "lost") {
				this.#setBarrier(run);
				continue;
			}
			const merged: Run["pending"] = [];
			for (const item of run.pending) {
				const settled = item.settled || seqs.has(item.seq);
				const last = merged.at(-1);
				if (settled && last?.settled) {
					last.seq = item.seq;
					if (item.checkpoint) last.checkpoint = item.checkpoint;
				} else {
					merged.push({ seq: item.seq, checkpoint: item.checkpoint, settled });
				}
			}
			run.pending = merged;
			const head = run.pending[0];
			if (!head?.settled) continue;
			run.pending.shift();
			if (head.checkpoint && this.#current(run) && run.state === "installed") {
				try {
					run.adapter?.commit?.(head.checkpoint);
				} catch {
					this.#log({ code: "adapter_commit_failed", triggerId: run.desired.triggerId, generation: run.desired.generation });
				}
			}
		}
	}

	#maybeResume(): void {
		const { maxBytes, maxEntries } = this.#spool.limits;
		if (this.#spool.bytes > maxBytes / 2 || this.#spool.count > maxEntries / 2) return;
		for (const slot of this.#slots.values()) {
			const run = slot.run;
			if (!run || !run.paused || !this.#current(run)) continue;
			run.paused = false;
			run.pausedAt = null;
			try {
				run.adapter?.resume?.();
			} catch {}
			this.#report(run, { status: "ok", code: "resumed" });
		}
	}

	#push(message: RuntimeMessage): void {
		// Control isn't kept across connections: the next reconcile's answer says where each source stands.
		if (!this.#transport || this.#closed) return;
		// Every frame is within frameBytes; one that wouldn't be is never cut, and with the ids bounded, none is.
		if (Buffer.byteLength(JSON.stringify(message)) > this.#limits.frameBytes) {
			this.#log({ code: "control_too_large" });
			return;
		}
		if (this.#control.length >= this.#limits.control) {
			// Health first, then the oldest other report; never part of the latest answer to a reconcile.
			const health = this.#control.findIndex((held) => held.type === "health");
			const index = health >= 0 ? health : this.#control.findIndex((held) => held.type !== "reconciled");
			this.#log({ code: "control_dropped" });
			if (index < 0) return;
			this.#control.splice(index, 1);
		}
		this.#control.push(message);
		this.#scheduleFlush(0);
	}

	#frame(entry: SpoolEntry): string {
		const message: RuntimeMessage =
			entry.kind === "observation"
				? {
						protocol: PROTOCOL,
						type: "observation",
						serverEpoch: entry.epoch,
						eventId: entry.eventId,
						triggerId: entry.triggerId,
						sourceId: entry.sourceId,
						revision: entry.revision,
						generation: entry.generation,
						sequence: entry.seq,
						occurredAt: entry.occurredAt,
						data: entry.data,
						checkpoint: entry.checkpoint,
						coalesced: entry.coalesced,
					}
				: {
						protocol: PROTOCOL,
						type: "gap",
						serverEpoch: entry.epoch,
						eventId: entry.eventId,
						triggerId: entry.triggerId,
						sourceId: entry.sourceId,
						generation: entry.generation,
						sequence: entry.seq,
						reasons: entry.reasons,
						from: entry.from,
						to: entry.to,
					};
		return JSON.stringify(message);
	}

	/** A new connection sends everything unsettled again, with its backoff started over. */
	#resetDelivery(): void {
		for (const delivery of this.#delivery.values()) {
			delivery.sentAt = null;
			delivery.attempts = 0;
		}
	}

	#scheduleFlush(delay: number): void {
		if (!this.#transport) return;
		this.#timer("flush", delay, () => this.#flush());
	}

	#scheduleExpiry(): void {
		let oldest = Number.POSITIVE_INFINITY;
		for (const entry of this.#spool.entries()) if (entry.kind === "observation") oldest = Math.min(oldest, entry.recordedAt);
		if (oldest === Number.POSITIVE_INFINITY) return;
		const now = this.#clock.now();
		const at = oldest + this.#limits.ttlMs;
		// Something already past its time is only here because a sweep couldn't write; try again shortly.
		this.#timer("expiry", at <= now ? this.#limits.blockedRetryMs : at - now, () => this.#sweepExpired());
	}

	/** Rewrites the journal within `scrubAfterMs` of entries leaving it, so what they held doesn't stay in the file. */
	#scheduleScrub(): void {
		if (this.#spool.retiredBytes === 0) return;
		this.#timer("scrub", this.#limits.scrubAfterMs, async () => {
			if (this.#spool.retiredBytes === 0) return;
			try {
				await this.#spool.compact();
			} catch {
				// Still visible: `retiredBytes` stays above zero, and this is logged on every try.
				this.#log({ code: "scrub_failed" });
				this.#timer("scrub", this.#limits.blockedRetryMs, () => this.#scheduleScrub());
			}
		});
	}

	/** How long after its `attempts`th sending an unsettled entry is sent again. */
	#backoff(attempts: number): number {
		return Math.min(this.#limits.resendAfterMs * 2 ** Math.max(0, attempts - 1), this.#limits.maxResendMs);
	}

	/**
	 * Sends control first, then a bounded batch of what is due, in sequence
	 * order. It always ends by setting a timer for a later instant, or none:
	 * it never loops, and a transport that takes nothing waits `blockedRetryMs`.
	 * An observation past its time to live is never sent, even while the sweep
	 * that records it as lost can't be written.
	 */
	async #flush(): Promise<void> {
		const transport = this.#transport;
		if (!transport || this.#closed) return;
		while (this.#control.length > 0) {
			if (!transport.send(JSON.stringify(this.#control[0]))) {
				this.#scheduleFlush(this.#limits.blockedRetryMs);
				return;
			}
			this.#control.shift();
		}
		if (!this.#reconciled) return;
		await this.#sweepExpired();
		if (this.#transport !== transport) return;
		const now = this.#clock.now();
		const epoch = this.#spool.epoch;
		let sent = 0;
		let next = Number.POSITIVE_INFINITY;
		const oversized: SpoolEntry[] = [];
		for (const entry of this.#spool.entries()) {
			if (entry.epoch !== epoch || (entry.kind === "observation" && entry.recordedAt + this.#limits.ttlMs <= now)) continue;
			let delivery = this.#delivery.get(entry.seq);
			if (!delivery) {
				delivery = { sentAt: null, attempts: 0, notBefore: 0 };
				this.#delivery.set(entry.seq, delivery);
			}
			const due = delivery.sentAt === null ? delivery.notBefore : Math.max(delivery.notBefore, delivery.sentAt + this.#backoff(delivery.attempts));
			if (due > now) {
				next = Math.min(next, due);
				continue;
			}
			if (sent >= this.#limits.batch) {
				next = Math.min(next, now + this.#limits.flushIntervalMs);
				break;
			}
			const frame = this.#frame(entry);
			if (Buffer.byteLength(frame) > this.#limits.frameBytes) {
				// Written under a larger frameBytes than now: never cut, it is given up as too large, with a gap.
				oversized.push(entry);
				continue;
			}
			if (!transport.send(frame)) {
				next = now + this.#limits.blockedRetryMs;
				break;
			}
			delivery.sentAt = now;
			delivery.attempts++;
			this.#transmitted.add(entry.seq);
			sent++;
			next = Math.min(next, now + this.#backoff(delivery.attempts));
		}
		if (oversized.length > 0 && epoch !== null) {
			const seqs = oversized.map((entry) => entry.seq);
			if (await this.#commitLosses(this.#lossesOf(oversized, epoch, "too_large"), seqs, { rewrite: true })) this.#settle(new Set(seqs), "lost");
			else next = Math.min(next, now + this.#limits.blockedRetryMs);
		}
		if (next !== Number.POSITIVE_INFINITY) this.#scheduleFlush(next - now);
	}
}
