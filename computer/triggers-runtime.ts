/**
 * The resident runtime for triggers' observers on the person's computer: it
 * keeps the computer sources the space wants running, and only those, fences
 * what a stopped or replaced observer still emits, and holds observations in
 * a bounded spool on disk until the space has durably taken them. The
 * protocol it speaks, `triggers.v1`, and its lifecycle are in
 * docs/triggers-runtime.md.
 *
 * Inert. Nothing imports this module: pim-computer doesn't run it, no service
 * starts it, and no message reaches it. It has no observers of its own
 * either. Running a poll, a stream, a process watch or a file watch is an
 * adapter's job (`ObserverAdapter`), and the only adapters so far are the
 * tests' fakes.
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
	readonly revision: number;
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
	/** Orders reconciles within an epoch; an older one is refused, the same one again only renews. */
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

export type SourceState = "starting" | "running" | "stale" | "invalid";
export type StopReason = "not_desired" | "reconfigured" | "consent_changed" | "revoked" | "invalid" | "lease_expired" | "epoch_replaced" | "start_failed" | "shutdown";
export type GapReason = "overflow" | "too_large" | "expired" | "epoch_replaced" | "corrupt";
export type GapCounts = { readonly [reason in GapReason]?: number };
/** A snapshot that stands for `count` snapshots taken from `from` to `to`, itself included; the others were never sent. */
export type Coalesced = { readonly count: number; readonly from: number; readonly to: number };

type Envelope<T extends string> = { readonly protocol: typeof PROTOCOL; readonly type: T };
export type RuntimeMessage =
	| (Envelope<"hello"> & { readonly runtimeId: string; readonly connectionId: string; readonly lastEpoch: number | null; readonly pending: number })
	| (Envelope<"error"> & { readonly code: string })
	| (Envelope<"reconciled"> & {
			readonly serverEpoch: number;
			readonly desiredRevision: number;
			readonly leaseMs: number;
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

function ident(value: unknown): string {
	const id = str(value, 256);
	if (/\s/.test(id)) throw new ProtocolError("invalid");
	return id;
}

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
		grant: { grantRef: ident(grant.grantRef), scopeHash: digestHex(grant.scopeHash) },
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
		return {
			protocol: PROTOCOL,
			type,
			binding: { space: ident(binding.space), runtimeId: ident(binding.runtimeId) },
			connectionId: ident(given.connectionId),
			serverEpoch: int(given.serverEpoch, 1, Number.MAX_SAFE_INTEGER),
			desiredRevision: int(given.desiredRevision, 0, Number.MAX_SAFE_INTEGER),
			leaseMs: int(given.leaseMs, 1, limits.leaseMs),
			sources,
		};
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
				reason: result.reason === undefined || result.reason === null ? null : ident(result.reason),
				retryAfterMs: result.retryAfterMs === undefined || result.retryAfterMs === null ? null : int(result.retryAfterMs, 0, HARD_LIMITS.spoolTtlMs),
			};
		});
		return { protocol: PROTOCOL, type, connectionId: ident(given.connectionId), serverEpoch: int(given.serverEpoch, 1, Number.MAX_SAFE_INTEGER), durable: true, results };
	}
	throw new ProtocolError("invalid");
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

type JournalRecord = { readonly t: "meta"; readonly epoch: number | null; readonly nextSeq: number } | { readonly t: "put"; readonly entry: SpoolEntry } | { readonly t: "del"; readonly seqs: readonly number[] };

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
/** What the journal's first record, which says the epoch and the next sequence, may take. */
const META_BYTES = 256;

async function writeAll(handle: fs.FileHandle, data: Buffer): Promise<void> {
	let offset = 0;
	while (offset < data.length) offset += (await handle.write(data, offset, data.length - offset)).bytesWritten;
	await handle.datasync();
}

function encode(record: JournalRecord): Buffer {
	const json = JSON.stringify(record);
	return Buffer.from(`${sha256(json).slice(0, 16)} ${json}\n`);
}

function decode(line: string): JournalRecord | null {
	const space = line.indexOf(" ");
	if (space !== 16) return null;
	const json = line.slice(17);
	if (sha256(json).slice(0, 16) !== line.slice(0, 16)) return null;
	try {
		const record = JSON.parse(json) as JournalRecord;
		if (record.t === "meta" && (record.epoch === null || Number.isSafeInteger(record.epoch)) && Number.isSafeInteger(record.nextSeq)) return record;
		if (record.t === "del" && Array.isArray(record.seqs) && record.seqs.every((seq) => Number.isSafeInteger(seq))) return record;
		if (record.t === "put" && Number.isSafeInteger(record.entry?.seq) && Number.isSafeInteger(record.entry.epoch) && (record.entry.kind === "observation" || record.entry.kind === "gap")) return record;
	} catch {}
	return null;
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
 * has settled it or its time is up. Until then it holds what an observer saw,
 * which can be sensitive, as plain JSON on the person's disk.
 *
 * Each record is a line with a digest of its JSON. Every write is synced
 * before it counts. A line cut short by a crash, or whose digest doesn't
 * match, is never read as a record; opening rewrites the journal without
 * them, through a temporary file renamed over it. The journal never grows
 * past `maxBytes`: before it would, it is rewritten with only what is live.
 */
export class ObservationSpool {
	readonly directory: string;
	readonly limits: { readonly maxBytes: number; readonly maxEntries: number; readonly reserveBytes: number; readonly reserveEntries: number };
	/** What opening found: a record cut short at the end, and records that failed their digest. */
	readonly recovery = { torn: false, corrupt: 0 };
	readonly #file: string;
	readonly #write: (handle: fs.FileHandle, data: Buffer) => Promise<void>;
	#entries = new Map<number, { entry: SpoolEntry; bytes: number }>();
	#events = new Map<string, number>();
	#epoch: number | null = null;
	#nextSeq = 1;
	#handle: fs.FileHandle | null = null;
	#fileBytes = 0;
	#liveBytes = 0;
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
		if (content) spool.#recover(content);
		// The journal is always rewritten on opening, so what follows starts from whole, checked records only.
		await spool.#rewrite(spool.#entries);
		return spool;
	}

	#recover(content: Buffer): void {
		let offset = 0;
		while (offset < content.length) {
			const end = content.indexOf(0x0a, offset);
			if (end === -1) {
				this.recovery.torn = true;
				break;
			}
			const record = decode(content.subarray(offset, end).toString("utf8"));
			offset = end + 1;
			if (!record) {
				this.recovery.corrupt++;
				continue;
			}
			if (record.t === "meta") {
				this.#epoch = record.epoch;
				this.#nextSeq = Math.max(this.#nextSeq, record.nextSeq);
			} else if (record.t === "put") {
				this.#entries.set(record.entry.seq, { entry: record.entry, bytes: encode(record).length });
				this.#nextSeq = Math.max(this.#nextSeq, record.entry.seq + 1);
			} else {
				for (const seq of record.seqs) this.#entries.delete(seq);
			}
		}
		this.#entries = new Map([...this.#entries].sort(([a], [b]) => a - b));
		this.#index();
	}

	#index(): void {
		this.#events = new Map([...this.#entries.values()].map(({ entry }) => [entry.eventId, entry.seq]));
		this.#liveBytes = [...this.#entries.values()].reduce((sum, { bytes }) => sum + bytes, 0);
	}

	get epoch(): number | null {
		return this.#epoch;
	}
	get count(): number {
		return this.#entries.size;
	}
	get bytes(): number {
		return this.#liveBytes + META_BYTES;
	}
	/** The entries in sequence order. */
	entries(): SpoolEntry[] {
		return [...this.#entries.values()].map(({ entry }) => entry);
	}
	get(seq: number): SpoolEntry | undefined {
		return this.#entries.get(seq)?.entry;
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
			bytes += encode({ t: "put", entry }).length - (held?.bytes ?? 0);
			if (!held) count++;
		}
		return { bytes: bytes + META_BYTES, count };
	}

	/** Whether the spool would hold these changes; only gaps may use the reserve. */
	fits(puts: readonly SpoolEntry[], removes: readonly number[], reserve: boolean): boolean {
		const after = this.#project(puts, removes);
		const { maxBytes, maxEntries, reserveBytes, reserveEntries } = this.limits;
		return after.bytes + (reserve ? 0 : reserveBytes) <= maxBytes && after.count + (reserve ? 0 : reserveEntries) <= maxEntries;
	}

	/** Puts entries (an entry with a sequence already held replaces it) and removes others, durably, before it returns. */
	async commit(puts: readonly SpoolEntry[], removes: readonly number[]): Promise<void> {
		if (this.#closed || this.#broken || !this.#handle) throw new SpoolError("unavailable");
		const after = this.#project(puts, removes);
		if (after.bytes > this.limits.maxBytes || after.count > this.limits.maxEntries) throw new SpoolError("full");
		const records: JournalRecord[] = puts.map((entry) => ({ t: "put", entry }));
		if (removes.length > 0) records.push({ t: "del", seqs: [...removes] });
		const data = Buffer.concat(records.map(encode));
		if (this.#fileBytes + data.length > this.limits.maxBytes) {
			const next = new Map(this.#entries);
			for (const seq of removes) next.delete(seq);
			for (const entry of puts) next.set(entry.seq, { entry, bytes: encode({ t: "put", entry }).length });
			await this.#rewrite(new Map([...next].sort(([a], [b]) => a - b)));
			return;
		}
		try {
			await this.#write(this.#handle, data);
		} catch {
			// Cut back to the last whole record, so what follows isn't written after half of one.
			try {
				await this.#handle.truncate(this.#fileBytes);
				await this.#handle.datasync();
			} catch {
				this.#broken = true;
			}
			throw new SpoolError("unavailable");
		}
		this.#fileBytes += data.length;
		for (const seq of removes) {
			const held = this.#entries.get(seq);
			if (held) {
				this.#entries.delete(seq);
				this.#events.delete(held.entry.eventId);
				this.#liveBytes -= held.bytes;
			}
		}
		for (const entry of puts) {
			const bytes = encode({ t: "put", entry }).length;
			this.#liveBytes += bytes - (this.#entries.get(entry.seq)?.bytes ?? 0);
			this.#entries.set(entry.seq, { entry, bytes });
			this.#events.set(entry.eventId, entry.seq);
		}
	}

	async setEpoch(epoch: number): Promise<void> {
		const previous = this.#epoch;
		this.#epoch = epoch;
		try {
			await this.#rewrite(this.#entries);
		} catch (error) {
			this.#epoch = previous;
			throw error;
		}
	}

	/** Writes `entries` as the whole journal: a temporary file, synced, renamed over the journal. */
	async #rewrite(entries: Map<number, { entry: SpoolEntry; bytes: number }>): Promise<void> {
		if (this.#closed) throw new SpoolError("unavailable");
		const data = Buffer.concat([encode({ t: "meta", epoch: this.#epoch, nextSeq: this.#nextSeq }), ...[...entries.values()].map(({ entry }) => encode({ t: "put", entry }))]);
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
		this.#broken = false;
		this.#entries = entries;
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
};
/** What an adapter observed. `key`, when it has one, makes the event id stable across re-reads, so the space takes it once. */
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
	/** Frames of observations sent in one flush. */
	readonly batch: number;
	readonly flushIntervalMs: number;
	/** How long an unsettled entry waits before it is sent again, doubling up to `maxResendMs`. */
	readonly resendAfterMs: number;
	readonly maxResendMs: number;
	/** How long to wait when the transport takes nothing. */
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
	check("batch", 1, 1_024);
	check("flushIntervalMs", 1, 60_000);
	check("resendAfterMs", 100, HARD_LIMITS.spoolTtlMs);
	check("maxResendMs", limits.resendAfterMs, HARD_LIMITS.spoolTtlMs);
	check("blockedRetryMs", 10, 600_000);
	check("startTimeoutMs", 1, 600_000);
	check("stopTimeoutMs", 1, 600_000);
	check("control", 16, 65_536);
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

type Outstanding = { readonly seq: number; readonly checkpoint: Checkpoint | null; settled: "acked" | "lost" | null };
type Run = {
	readonly token: number;
	readonly desired: DesiredSource;
	readonly abort: AbortController;
	adapter: ObserverAdapter | null;
	state: "validating" | "starting" | "installed" | "stopping" | "stopped";
	/** Set the moment the runtime decides to stop it: from then on nothing it emits is taken. */
	fenced: boolean;
	paused: boolean;
	/** Settles when its stop has returned, failed or timed out. */
	stopped: Promise<void>;
	/** What it emitted that the space hasn't settled, in order, for `commit`. */
	outstanding: Outstanding[];
};
type Slot = { run: Run | null; chain: Promise<void>; generation: number };
type Delivery = { sentAt: number | null; attempts: number; notBefore: number };

const SYSTEM_CLOCK: RuntimeClock = {
	now: () => Date.now(),
	setTimer: (ms, run) => {
		const timer = setTimeout(run, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

function readObserved(value: unknown): Required<Observed> | null {
	try {
		const given = fields(value, ["occurredAt", "data", "checkpoint", "key"]);
		if (!isJsonObject(given.data, 0)) return null;
		return {
			occurredAt: int(given.occurredAt, 0, Number.MAX_SAFE_INTEGER),
			data: given.data,
			checkpoint: given.checkpoint === undefined || given.checkpoint === null ? null : readCheckpoint(given.checkpoint),
			key: given.key === undefined || given.key === null ? null : str(given.key, 256),
		};
	} catch {
		return null;
	}
}

function isJsonObject(value: unknown, depth: number): value is JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value) || depth > 8) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isJsonValue(value: unknown, depth: number): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return depth <= 8 && value.every((item) => isJsonValue(item, depth + 1));
	return isJsonObject(value, depth);
}

function addCounts(a: GapCounts, b: GapCounts): GapCounts {
	const sum: { [reason in GapReason]?: number } = { ...a };
	for (const [reason, count] of Object.entries(b) as [GapReason, number][]) sum[reason] = (sum[reason] ?? 0) + count;
	return sum;
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
	/** Whether the current connection has had a reconcile, which observations wait for. */
	#reconciled = false;
	#desiredRevision = -1;
	#leaseExpiresAt: number | null = null;
	#leaseCancel: (() => void) | null = null;
	#flushCancel: (() => void) | null = null;
	#flushAt = Number.POSITIVE_INFINITY;
	#expiryCancel: (() => void) | null = null;
	#expiryAt = Number.POSITIVE_INFINITY;
	readonly #slots = new Map<string, Slot>();
	#control: RuntimeMessage[] = [];
	readonly #delivery = new Map<number, Delivery>();
	/** Sequences sent at least once since this runtime started: these are never coalesced or merged into. */
	readonly #transmitted = new Set<number>();
	#queue: Promise<void> = Promise.resolve();
	#pending = 0;
	#tokens = 0;
	#closed = false;

	constructor(options: TriggersRuntimeOptions) {
		this.#binding = { space: ident(options.binding.space), runtimeId: ident(options.binding.runtimeId) };
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
		this.#flushCancel?.();
		this.#flushCancel = null;
		this.#flushAt = Number.POSITIVE_INFINITY;
		this.#resetDelivery();
	}

	/** A new connection sends everything unsettled again, with its backoff started over. */
	#resetDelivery(): void {
		for (const delivery of this.#delivery.values()) {
			delivery.sentAt = null;
			delivery.attempts = 0;
		}
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
	sources(): { triggerId: string; sourceId: string; generation: number; state: Run["state"]; paused: boolean }[] {
		return [...this.#slots]
			.filter(([, slot]) => slot.run !== null)
			.map(([triggerId, slot]) => {
				const run = slot.run as Run;
				return { triggerId, sourceId: run.desired.sourceId, generation: run.desired.generation, state: run.state, paused: run.paused };
			});
	}

	/** Resolves once the queue has nothing left to do: for shutting down, and for tests. */
	async idle(): Promise<void> {
		do {
			await new Promise((resolve) => setImmediate(resolve));
			await this.#queue;
			await new Promise((resolve) => setImmediate(resolve));
		} while (this.#pending > 0);
	}

	/** Stops every observer, waits for their stops (each bounded by `stopTimeoutMs`), and closes the spool. */
	async close(): Promise<void> {
		if (this.#closed) return;
		const runs = [...this.#slots.values()].map((slot) => slot.run).filter((run): run is Run => run !== null);
		for (const run of runs) this.#stop(run, "shutdown");
		this.#closed = true;
		this.#transport = null;
		for (const cancel of [this.#leaseCancel, this.#flushCancel, this.#expiryCancel]) cancel?.();
		await Promise.all(runs.map((run) => run.stopped));
		await this.idle();
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

	async #afterOpen(): Promise<void> {
		const epoch = this.#spool.epoch;
		if (epoch !== null) {
			await this.#discardBefore(epoch);
			if (this.#spool.recovery.corrupt > 0) {
				this.#log({ code: "spool_corrupt", count: this.#spool.recovery.corrupt });
				const now = this.#clock.now();
				await this.#recordGap({ epoch, triggerId: null, sourceId: null, generation: null }, { corrupt: this.#spool.recovery.corrupt }, now, now);
			}
		}
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
		if (epoch === null || message.serverEpoch > epoch) {
			// A new epoch: nothing of the old one is sent again, and every observer starts over under the new one.
			for (const slot of this.#slots.values()) if (slot.run) this.#stop(slot.run, "epoch_replaced");
			try {
				await this.#spool.setEpoch(message.serverEpoch);
			} catch {
				this.#log({ code: "spool_unavailable" });
				this.#push({ protocol: PROTOCOL, type: "error", code: "spool_unavailable" });
				return;
			}
			this.#desiredRevision = -1;
			await this.#discardBefore(message.serverEpoch);
		} else if (message.desiredRevision < this.#desiredRevision) {
			this.#push({ protocol: PROTOCOL, type: "error", code: "stale_reconcile" });
			return;
		}
		this.#desiredRevision = message.desiredRevision;
		this.#reconciled = true;
		this.#renewLease(message.leaseMs);
		const results: { triggerId: string; sourceId: string; generation: number; state: SourceState }[] = [];
		for (const desired of message.sources) results.push({ triggerId: desired.triggerId, sourceId: desired.sourceId, generation: desired.generation, state: this.#want(desired) });
		const named = new Set(message.sources.map((desired) => desired.triggerId));
		for (const [triggerId, slot] of this.#slots) if (!named.has(triggerId) && slot.run) this.#stop(slot.run, "not_desired");
		this.#push({ protocol: PROTOCOL, type: "reconciled", serverEpoch: message.serverEpoch, desiredRevision: message.desiredRevision, leaseMs: message.leaseMs, sources: results });
		this.#scheduleFlush(0);
	}

	/** Makes one trigger's observer match what the space wants, starting one only when what runs differs. */
	#want(desired: DesiredSource): SourceState {
		let slot = this.#slots.get(desired.triggerId);
		if (!slot) {
			slot = { run: null, chain: Promise.resolve(), generation: -1 };
			this.#slots.set(desired.triggerId, slot);
		}
		const run = slot.run;
		if (desired.configHash !== sourceConfigHash(desired.source)) {
			if (run) this.#stop(run, "invalid");
			this.#push({ ...this.#ref(desired), protocol: PROTOCOL, type: "health", status: "error", code: "config_hash_mismatch" });
			return "invalid";
		}
		if (desired.generation < slot.generation) return "stale";
		if (run && !run.fenced) {
			const same = run.desired.sourceId === desired.sourceId && run.desired.generation === desired.generation && run.desired.configHash === desired.configHash;
			if (same && run.desired.grant.grantRef === desired.grant.grantRef && run.desired.grant.scopeHash === desired.grant.scopeHash) {
				this.#recheck(run);
				return run.state === "installed" ? "running" : "starting";
			}
			this.#stop(run, same ? "consent_changed" : "reconfigured");
		}
		this.#launch(slot, desired);
		return "starting";
	}

	#launch(slot: Slot, desired: DesiredSource): void {
		const previous = slot.run;
		const run: Run = { token: ++this.#tokens, desired, abort: new AbortController(), adapter: null, state: "validating", fenced: false, paused: false, stopped: Promise.resolve(), outstanding: [] };
		slot.run = run;
		slot.generation = Math.max(slot.generation, desired.generation);
		// One observer per trigger at a time: this one starts only once the one before it has stopped.
		slot.chain = Promise.all([slot.chain, previous?.stopped])
			.then(() => this.#begin(run))
			.catch(() => this.#log({ code: "internal_error", triggerId: desired.triggerId, generation: desired.generation }));
	}

	async #begin(run: Run): Promise<void> {
		if (run.fenced) return;
		if (!(await this.#authorized(run.desired))) {
			if (run.fenced) return;
			run.fenced = true;
			run.state = "stopped";
			this.#push({ ...this.#ref(run.desired), protocol: PROTOCOL, type: "health", status: "error", code: "auth_denied" });
			return;
		}
		if (run.fenced) return;
		let adapter: ObserverAdapter;
		try {
			adapter = this.#adapters(run.desired.source);
		} catch {
			run.fenced = true;
			run.state = "stopped";
			this.#push({ ...this.#ref(run.desired), protocol: PROTOCOL, type: "health", status: "error", code: "unsupported" });
			return;
		}
		run.adapter = adapter;
		run.state = "starting";
		const config: AdapterConfig = {
			triggerId: run.desired.triggerId,
			sourceId: run.desired.sourceId,
			generation: run.desired.generation,
			source: run.desired.source,
			resume: run.desired.checkpoint,
			signal: run.abort.signal,
		};
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
		if (run.fenced) return;
		if (outcome !== "returned") {
			this.#log({ code: "adapter_start_failed", triggerId: run.desired.triggerId, generation: run.desired.generation });
			this.#push({ ...this.#ref(run.desired), protocol: PROTOCOL, type: "health", status: "error", code: outcome === "timed_out" ? "start_timed_out" : "start_failed" });
			this.#stop(run, "start_failed");
			return;
		}
		run.state = "installed";
		this.#push({ ...this.#ref(run.desired), protocol: PROTOCOL, type: "installed", configHash: run.desired.configHash });
		this.#push({ ...this.#ref(run.desired), protocol: PROTOCOL, type: "health", status: "ok", code: "listening" });
	}

	async #authorized(desired: DesiredSource): Promise<boolean> {
		try {
			const verdict = await this.#authorize({
				binding: this.#binding,
				triggerId: desired.triggerId,
				sourceId: desired.sourceId,
				generation: desired.generation,
				configHash: desired.configHash,
				source: desired.source,
				grant: desired.grant,
				now: this.#clock.now(),
			});
			return typeof verdict === "object" && verdict !== null && verdict.ok === true;
		} catch {
			return false;
		}
	}

	/** Checks a running observer's grant again; a grant no longer good stops it. */
	#recheck(run: Run): void {
		void this.#authorized(run.desired).then((ok) =>
			this.#enqueue(() => {
				if (ok || run.fenced) return;
				this.#push({ ...this.#ref(run.desired), protocol: PROTOCOL, type: "health", status: "error", code: "auth_denied" });
				this.#stop(run, "revoked");
			}),
		);
	}

	/** Fences a run at once, then asks its own adapter, and only it, to stop. */
	#stop(run: Run, reason: StopReason): void {
		if (run.fenced) return;
		run.fenced = true;
		run.abort.abort();
		const adapter = run.adapter;
		if (!adapter) {
			run.state = "stopped";
			this.#push({ ...this.#ref(run.desired), protocol: PROTOCOL, type: "stopped", reason, adapter: "not_started" });
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
				this.#push({ ...this.#ref(run.desired), protocol: PROTOCOL, type: "stopped", reason, adapter: outcome });
			});
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
		this.#leaseCancel?.();
		this.#leaseCancel = this.#clock.setTimer(ms, () => {
			this.#leaseCancel = null;
			void this.#enqueue(() => this.#expireLease()).catch(() => undefined);
		});
	}

	#expireLease(): void {
		if (this.#leaseExpiresAt === null || this.#clock.now() < this.#leaseExpiresAt) return;
		this.#leaseExpiresAt = null;
		this.#log({ code: "lease_expired" });
		for (const slot of this.#slots.values()) if (slot.run) this.#stop(slot.run, "lease_expired");
	}

	#ref(desired: DesiredSource): SourceRef {
		return { serverEpoch: this.#spool.epoch ?? 0, triggerId: desired.triggerId, sourceId: desired.sourceId, generation: desired.generation };
	}

	#health(run: Run, report: unknown): void {
		if (run.fenced || run.state !== "installed") return;
		const given = report as AdapterHealth;
		if (typeof given !== "object" || given === null || !["ok", "degraded", "error"].includes(given.status) || typeof given.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(given.code)) {
			this.#log({ code: "adapter_health_invalid", triggerId: run.desired.triggerId, generation: run.desired.generation });
			return;
		}
		this.#push({ ...this.#ref(run.desired), protocol: PROTOCOL, type: "health", status: given.status, code: given.code });
	}

	#emit(run: Run, observed: Observed): Promise<EmitResult> {
		if (run.fenced) return Promise.resolve(refused("stopped"));
		if (run.state !== "installed") return Promise.resolve(refused("not_started"));
		const given = readObserved(observed);
		if (!given) return Promise.resolve(refused("invalid"));
		return this.#enqueue(() => this.#accept(run, given)).catch(() => refused("spool_unavailable"));
	}

	async #accept(run: Run, observed: Required<Observed>): Promise<EmitResult> {
		const now = this.#clock.now();
		if (this.#leaseExpiresAt !== null && now >= this.#leaseExpiresAt) this.#expireLease();
		const epoch = this.#spool.epoch;
		if (run.fenced || epoch === null) return refused("stopped");
		const desired = run.desired;
		const target = { epoch, triggerId: desired.triggerId, sourceId: desired.sourceId, generation: desired.generation };
		const eventId = observed.key === null ? `r_${randomUUID()}` : `k_${sha256(`${desired.sourceId}\n${observed.key}`).slice(0, 40)}`;
		if (observed.key !== null && this.#spool.findEvent(eventId)) return { ok: true, eventId, duplicate: true };
		let entry: ObservationEntry = {
			kind: "observation",
			seq: this.#spool.allocate(),
			eventId,
			epoch,
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
			await this.#recordGap(target, { too_large: 1 }, observed.occurredAt, observed.occurredAt);
			return refused("too_large");
		}
		if (run.paused) {
			await this.#recordGap(target, { overflow: 1 }, observed.occurredAt, observed.occurredAt);
			return refused("backpressure");
		}
		let removes: number[] = [];
		if (!this.#spool.fits([entry], [], false)) {
			// A state's snapshots not yet sent may give way to a newer one, which says how many it stands for. Events never do.
			const unsent =
				desired.source.kind === "poll"
					? this.#spool.entries().filter((held): held is ObservationEntry => held.kind === "observation" && held.sourceId === desired.sourceId && held.generation === desired.generation && held.epoch === epoch && !this.#transmitted.has(held.seq))
					: [];
			const coalesced = unsent.length === 0 ? entry : { ...entry, coalesced: { count: 1 + unsent.reduce((sum, held) => sum + (held.coalesced?.count ?? 1), 0), from: Math.min(...unsent.map((held) => held.coalesced?.from ?? held.occurredAt), entry.occurredAt), to: entry.occurredAt } };
			if (unsent.length > 0 && this.#spool.fits([coalesced], unsent.map((held) => held.seq), false) && Buffer.byteLength(this.#frame(coalesced)) <= this.#limits.frameBytes) {
				entry = coalesced;
				removes = unsent.map((held) => held.seq);
			} else {
				run.paused = true;
				try {
					run.adapter?.pause?.();
				} catch {}
				await this.#recordGap(target, { overflow: 1 }, observed.occurredAt, observed.occurredAt);
				this.#push({ ...this.#ref(desired), protocol: PROTOCOL, type: "health", status: "degraded", code: "backpressure" });
				return refused("backpressure");
			}
		}
		try {
			await this.#spool.commit([entry], removes);
		} catch {
			this.#log({ code: "spool_unavailable", triggerId: desired.triggerId, generation: desired.generation });
			this.#push({ ...this.#ref(desired), protocol: PROTOCOL, type: "health", status: "error", code: "spool_unavailable" });
			return refused("spool_unavailable");
		}
		if (removes.length > 0) {
			const gone = new Set(removes);
			for (const seq of removes) this.#delivery.delete(seq);
			run.outstanding = run.outstanding.filter((item) => !gone.has(item.seq));
		}
		run.outstanding.push({ seq: entry.seq, checkpoint: entry.checkpoint, settled: null });
		this.#delivery.set(entry.seq, { sentAt: null, attempts: 0, notBefore: 0 });
		this.#scheduleFlush(0);
		this.#scheduleExpiry();
		return { ok: true, eventId, duplicate: false };
	}

	/**
	 * Records a loss as a gap entry, which is sent and acknowledged as
	 * observations are. Losses of one source and generation merge into one
	 * entry until it has been sent, so gaps stay bounded. False when even the
	 * reserve is full.
	 */
	async #recordGap(target: { epoch: number; triggerId: string | null; sourceId: string | null; generation: number | null }, reasons: GapCounts, from: number, to: number): Promise<boolean> {
		const open = this.#spool
			.entries()
			.find((held): held is GapEntry => held.kind === "gap" && held.epoch === target.epoch && held.sourceId === target.sourceId && held.generation === target.generation && !this.#transmitted.has(held.seq));
		const entry: GapEntry = open
			? { ...open, reasons: addCounts(open.reasons, reasons), from: Math.min(open.from, from), to: Math.max(open.to, to) }
			: { kind: "gap", seq: this.#spool.allocate(), eventId: `g_${randomUUID()}`, recordedAt: this.#clock.now(), ...target, reasons, from, to };
		try {
			if (!this.#spool.fits([entry], [], true)) throw new SpoolError("full");
			await this.#spool.commit([entry], []);
		} catch {
			this.#log({ code: "gap_unrecorded", triggerId: target.triggerId ?? undefined });
			return false;
		}
		if (!open) this.#delivery.set(entry.seq, { sentAt: null, attempts: 0, notBefore: 0 });
		this.#scheduleFlush(0);
		return true;
	}

	/** Takes out what an older epoch left, recording how much as gaps in this one. */
	async #discardBefore(epoch: number): Promise<void> {
		const stale = this.#spool.entries().filter((entry) => entry.epoch < epoch);
		if (stale.length === 0) return;
		await this.#gapsFor(stale, epoch, "epoch_replaced");
		await this.#remove(stale.map((entry) => entry.seq), "lost");
	}

	/** Gives up observations held longer than `ttlMs`: they are never sent, and a gap says so. */
	async #sweepExpired(): Promise<void> {
		const now = this.#clock.now();
		const epoch = this.#spool.epoch;
		const expired = this.#spool.entries().filter((entry) => entry.kind === "observation" && entry.recordedAt + this.#limits.ttlMs <= now);
		if (expired.length > 0 && epoch !== null) {
			this.#log({ code: "spool_expired", count: expired.length });
			await this.#gapsFor(expired, epoch, "expired");
			await this.#remove(
				expired.map((entry) => entry.seq),
				"lost",
			);
		}
		this.#scheduleExpiry();
	}

	async #gapsFor(entries: readonly SpoolEntry[], epoch: number, reason: GapReason): Promise<void> {
		const groups = new Map<string, { target: { epoch: number; triggerId: string | null; sourceId: string | null; generation: number | null }; reasons: GapCounts; from: number; to: number }>();
		for (const entry of entries) {
			const key = `${entry.sourceId}\n${entry.generation}`;
			const group = groups.get(key) ?? { target: { epoch, triggerId: entry.triggerId, sourceId: entry.sourceId, generation: entry.generation }, reasons: {}, from: Number.POSITIVE_INFINITY, to: Number.NEGATIVE_INFINITY };
			group.reasons = addCounts(group.reasons, entry.kind === "gap" ? entry.reasons : { [reason]: 1 });
			group.from = Math.min(group.from, entry.kind === "gap" ? entry.from : entry.occurredAt);
			group.to = Math.max(group.to, entry.kind === "gap" ? entry.to : entry.occurredAt);
			groups.set(key, group);
		}
		// Gaps are written before the entries go, so a crash in between can count a loss twice, never not at all.
		for (const group of groups.values()) await this.#recordGap(group.target, group.reasons, group.from, group.to);
	}

	async #remove(seqs: readonly number[], settled: "acked" | "lost"): Promise<void> {
		try {
			await this.#spool.commit([], seqs);
		} catch {
			this.#log({ code: "spool_unavailable" });
			return;
		}
		for (const seq of seqs) {
			this.#delivery.delete(seq);
			this.#transmitted.delete(seq);
		}
		this.#settle(new Set(seqs), settled);
		this.#maybeResume();
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
		if (settled.size > 0) await this.#remove([...settled], "acked");
		this.#scheduleFlush(0);
	}

	/** Moves each observer's committed checkpoint over what the space has settled, in order; a loss is never passed. */
	#settle(seqs: ReadonlySet<number>, settled: "acked" | "lost"): void {
		for (const slot of this.#slots.values()) {
			const run = slot.run;
			if (!run) continue;
			for (const item of run.outstanding) if (seqs.has(item.seq)) item.settled = settled;
			let checkpoint: Checkpoint | null = null;
			while (run.outstanding[0]?.settled === "acked") {
				const item = run.outstanding.shift() as Outstanding;
				if (item.checkpoint) checkpoint = item.checkpoint;
			}
			if (checkpoint && !run.fenced && run.state === "installed") {
				try {
					run.adapter?.commit?.(checkpoint);
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
			if (!run || !run.paused || run.fenced) continue;
			run.paused = false;
			try {
				run.adapter?.resume?.();
			} catch {}
			this.#push({ ...this.#ref(run.desired), protocol: PROTOCOL, type: "health", status: "ok", code: "resumed" });
		}
	}

	#push(message: RuntimeMessage): void {
		// Control isn't kept across connections: the next reconcile's answer says where each source stands.
		if (!this.#transport || this.#closed) return;
		if (this.#control.length >= this.#limits.control) {
			const health = this.#control.findIndex((held) => held.type === "health");
			this.#control.splice(health >= 0 ? health : 0, 1);
			this.#log({ code: "control_dropped" });
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

	#scheduleFlush(delay: number): void {
		if (!this.#transport || this.#closed) return;
		const at = this.#clock.now() + Math.max(0, delay);
		if (this.#flushCancel && this.#flushAt <= at) return;
		this.#flushCancel?.();
		this.#flushAt = at;
		this.#flushCancel = this.#clock.setTimer(Math.max(0, delay), () => {
			this.#flushCancel = null;
			this.#flushAt = Number.POSITIVE_INFINITY;
			void this.#enqueue(() => this.#flush()).catch(() => undefined);
		});
	}

	#scheduleExpiry(): void {
		if (this.#closed) return;
		let oldest = Number.POSITIVE_INFINITY;
		for (const entry of this.#spool.entries()) if (entry.kind === "observation") oldest = Math.min(oldest, entry.recordedAt);
		if (oldest === Number.POSITIVE_INFINITY) return;
		const at = oldest + this.#limits.ttlMs;
		if (this.#expiryCancel && this.#expiryAt <= at) return;
		this.#expiryCancel?.();
		this.#expiryAt = at;
		this.#expiryCancel = this.#clock.setTimer(Math.max(0, at - this.#clock.now()), () => {
			this.#expiryCancel = null;
			this.#expiryAt = Number.POSITIVE_INFINITY;
			void this.#enqueue(() => this.#sweepExpired()).catch(() => undefined);
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
		for (const entry of this.#spool.entries()) {
			if (entry.epoch !== epoch) continue;
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
			if (!transport.send(this.#frame(entry))) {
				next = now + this.#limits.blockedRetryMs;
				break;
			}
			delivery.sentAt = now;
			delivery.attempts++;
			this.#transmitted.add(entry.seq);
			sent++;
			next = Math.min(next, now + this.#backoff(delivery.attempts));
		}
		if (next !== Number.POSITIVE_INFINITY) this.#scheduleFlush(next - now);
	}
}
