import { randomUUID } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { applyImmutableBatches } from "@earendil-works/chord/delta";
import {
	type ConversationId,
	type ConversationQuery,
	type ConversationRecord,
	type Cursor,
	type DocumentAddress,
	type DocumentId,
	type DocumentPoint,
	type DocumentQuery,
	type DocumentRecord,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	type Id,
	type Page,
	type ScanOrder,
	type Seq,
	type Storage,
	type StorageWrite,
	StorageRejected,
	type StoredDocument,
	type SubmissionId,
	type SubmissionQuery,
	type SubmissionRecord,
	type TaskId,
	type TaskQuery,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import pg from "pg";
import { type Db, SCHEMA, setLocalSql } from "./db.ts";
import { AmbiguousCommit, OwnershipLost } from "./errors.ts";
import { IdAllocator } from "./ids.ts";

const S = SCHEMA;
const MAX_ID = Number.MAX_SAFE_INTEGER;

/**
 * An indexed string (a task or document kind, a document key, a request id) as it is stored: any JavaScript string,
 * lone surrogates included, becomes text PostgreSQL accepts, and two different strings never become the same text.
 */
export const ident = (value: string): string => (value.isWellFormed() ? `w:${value}` : `j:${JSON.stringify(value)}`);
const identOrNull = (value: string | undefined): string | null => (value === undefined ? null : ident(value));
const parse = <T>(text: string): T => JSON.parse(text) as T;

type AnyTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type DocumentWrite = Extract<StorageWrite, { type: "document.create" | "document.copy" | "document.change" | "document.retire" }>;
type DocContent = Extract<StorageWrite, { type: "document.change" }>["content"];

/** What a storage needs to know about the lease that lets it commit: who holds it, at which epoch, and whether it still looks valid locally. */
export interface OwnerFence {
	readonly tenantId: string;
	readonly partitionId: string;
	readonly ownerId: string;
	readonly epoch: number;
	/** False once the local view says the lease is gone; a commit then fails without a round trip. */
	isLocallyValid(): boolean;
}

export type PgPiStorageOptions = {
	readonly db: Db;
	readonly fence: OwnerFence;
	/** Ids per leased block; default 256. */
	readonly idBlockSize?: number;
	/** Called when a commit fails in a way the owner must act on: ownership lost, or an outcome that is unknown. */
	readonly onFault?: (error: OwnershipLost | AmbiguousCommit) => void;
	/** Test seam: change what a COMMIT does, to reproduce a lost acknowledgement. */
	readonly beforeCommit?: (info: { batchId: string; backendPid: number }) => Promise<void> | void;
};

/** What `commit` records about a batch that may or may not have landed. */
export type AmbiguousBatch = { readonly batchId: string; readonly backendPid: number | undefined; readonly tenantId: string; readonly partitionId: string };

/**
 * pi-durable's `Storage` over PostgreSQL, for one partition (one conversation family) of one tenant, written by one
 * fenced owner. The pi records are stored as written (json), with the columns pi's scans need beside them.
 *
 * Reads go through the pool and see committed state. A commit is one transaction that first takes the partition row
 * with `UPDATE ... WHERE owner_epoch = $epoch AND lease_expires_at > clock_timestamp()`, which is both the fence and the
 * sequence; a stale owner gets no row and fails with `OwnershipLost` before anything is written.
 */
export class PgPiStorage implements Storage {
	readonly db: Db;
	readonly fence: OwnerFence;
	readonly tenantId: string;
	readonly partitionId: string;
	readonly #ids: IdAllocator;
	readonly #beforeCommit: PgPiStorageOptions["beforeCommit"];
	readonly #onFault: PgPiStorageOptions["onFault"];
	#closed = false;
	#ambiguous: AmbiguousBatch | undefined;
	#home: boolean | undefined;

	constructor(options: PgPiStorageOptions) {
		this.db = options.db;
		this.fence = options.fence;
		this.tenantId = options.fence.tenantId;
		this.partitionId = options.fence.partitionId;
		this.#beforeCommit = options.beforeCommit;
		this.#onFault = options.onFault;
		this.#ids = new IdAllocator(this.db, this.tenantId, () => ({ partitionId: this.partitionId, epoch: this.fence.epoch }), options.idBlockSize);
	}

	/**
	 * Open the storage for the owner at `epoch`, after checking inside PostgreSQL that it still holds the lease. Call it
	 * before `Harness.open`, which reads and rewrites live tasks (running → pending): a fenced-out owner stops here, not
	 * after it has looked at state it no longer owns.
	 */
	static async openForOwner(options: PgPiStorageOptions): Promise<PgPiStorage> {
		const { fence, db } = options;
		if (!fence.isLocallyValid()) throw new OwnershipLost(fence.partitionId, fence.epoch, "the local lease has run out");
		const row = (
			await db.read<{ ok: boolean; owner_id: string | null; owner_epoch: string; kind: string }>(
				fence.tenantId,
				`SELECT (owner_id = $3 AND owner_epoch = $4 AND lease_expires_at > clock_timestamp()) AS ok, owner_id, owner_epoch, kind
				 FROM ${S}.partitions WHERE tenant_id = $1 AND partition_id = $2`,
				[fence.tenantId, fence.partitionId, fence.ownerId, fence.epoch],
			)
		).rows[0];
		if (row === undefined) throw new Error(`Partition ${fence.partitionId} of tenant ${fence.tenantId} does not exist`);
		if (!row.ok) throw new OwnershipLost(fence.partitionId, fence.epoch, `the lease belongs to ${row.owner_id ?? "nobody"} at epoch ${row.owner_epoch}`);
		const storage = new PgPiStorage(options);
		storage.#home = row.kind === "home";
		const mark = await db.read<{ high_water: string }>(fence.tenantId, `SELECT high_water FROM ${S}.tenant_id_allocators WHERE tenant_id = $1`, [fence.tenantId]);
		storage.#ids.startAt(Number(mark.rows[0]?.high_water ?? 1));
		return storage;
	}

	/** A storage for reading a partition's committed state without owning it (a projection or a test); every commit through it is fenced out. */
	static forReading(db: Db, tenantId: string, partitionId: string): PgPiStorage {
		const fence: OwnerFence = { tenantId, partitionId, ownerId: "reader", epoch: -1, isLocallyValid: () => false };
		return new PgPiStorage({ db, fence });
	}

	get isHome(): Promise<boolean> {
		if (this.#home !== undefined) return Promise.resolve(this.#home);
		return this.db
			.read<{ kind: string }>(this.tenantId, `SELECT kind FROM ${S}.partitions WHERE tenant_id = $1 AND partition_id = $2`, [this.tenantId, this.partitionId])
			.then((result) => {
				this.#home = result.rows[0]?.kind === "home";
				return this.#home;
			});
	}

	/** The batch whose outcome is unknown, if a commit failed that way; the storage refuses everything until it is reopened. */
	get ambiguousBatch(): AmbiguousBatch | undefined {
		return this.#ambiguous;
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.#assertUsable();
		return this.#ids.mint<I>();
	}

	// ---- commit ----

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.#assertUsable();
		if (!this.fence.isLocallyValid()) {
			const lost = new OwnershipLost(this.partitionId, this.fence.epoch, "the local lease has run out");
			this.#onFault?.(lost);
			throw lost;
		}
		const batchId = randomUUID();
		const batch = prepareBatch(writes);
		await this.#ids.observe(batch.maxId);
		const client = await this.db.pool.connect();
		let backendPid: number | undefined;
		let destroy: Error | undefined;
		let commitSent = false;
		try {
			try {
				const begun = (await client.query(
					`BEGIN; SELECT pg_backend_pid() AS pid; ${setLocalSql(client, this.tenantId)}; SET LOCAL synchronous_commit TO on`,
				)) as unknown as pg.QueryResult<{ pid: number }>[];
				backendPid = begun[1]?.rows[0]?.pid;
				const seq = await this.#apply(client, batch, batchId);
				await this.#beforeCommit?.({ batchId, backendPid: backendPid ?? 0 });
				commitSent = true;
				await client.query("COMMIT");
				return seq as Seq;
			} catch (error) {
				if (!commitSent || error instanceof pg.DatabaseError || error instanceof StorageRejected) {
					// Nothing reached COMMIT, or the server answered COMMIT with an error: the transaction did not commit.
					try {
						await client.query("ROLLBACK");
					} catch (rollback) {
						destroy = rollback instanceof Error ? rollback : new Error(String(rollback));
					}
					const rejected = rejection(error);
					if (rejected instanceof OwnershipLost) this.#onFault?.(rejected);
					throw rejected;
				}
				// COMMIT left this process and the connection failed before an answer came back: unknown.
				destroy = error instanceof Error ? error : new Error(String(error));
				this.#ambiguous = { batchId, backendPid, tenantId: this.tenantId, partitionId: this.partitionId };
				const ambiguous = new AmbiguousCommit(batchId, backendPid, { cause: error });
				this.#onFault?.(ambiguous);
				throw ambiguous;
			}
		} finally {
			client.release(destroy);
		}
	}

	async #apply(client: pg.PoolClient, batch: Batch, batchId: string): Promise<number> {
		const t = this.tenantId;
		const p = this.partitionId;
		// The fence and the sequence in one statement.
		const fenced = await client.query<{ seq: string; kind: string }>(
			`UPDATE ${S}.partitions SET next_seq = next_seq + 1
			 WHERE tenant_id = $1 AND partition_id = $2 AND owner_id = $3 AND owner_epoch = $4 AND lease_expires_at > clock_timestamp()
			 RETURNING next_seq - 1 AS seq, kind`,
			[t, p, this.fence.ownerId, this.fence.epoch],
		);
		const row = fenced.rows[0];
		if (row === undefined) {
			const now = await client.query<{ owner_id: string | null; owner_epoch: string; expired: boolean | null }>(
				`SELECT owner_id, owner_epoch, (lease_expires_at <= clock_timestamp()) AS expired FROM ${S}.partitions WHERE tenant_id = $1 AND partition_id = $2`,
				[t, p],
			);
			const cur = now.rows[0];
			throw new OwnershipLost(
				p,
				this.fence.epoch,
				cur === undefined ? "the partition does not exist" : cur.owner_id === this.fence.ownerId && Number(cur.owner_epoch) === this.fence.epoch ? "the lease expired" : `the lease is now ${cur.owner_id ?? "free"} at epoch ${cur.owner_epoch}`,
			);
		}
		const seq = Number(row.seq);
		this.#home = row.kind === "home";

		if (batch.conversations.some((c) => c.id === 1) && row.kind !== "home") {
			throw new StorageRejected("The root conversation 1 belongs to the home partition");
		}

		await claimIds(client, t, p, batch);
		await writeConversations(client, t, p, batch);
		await checkReferences(client, t, p, batch);
		await writeEntries(client, t, p, batch, seq);
		await writeTasks(client, t, p, batch);
		await writeSubmissions(client, t, p, batch);
		await writeDocuments(client, t, p, batch, seq);

		await client.query(
			`INSERT INTO ${S}.commit_receipts (tenant_id, partition_id, batch_id, commit_seq, owner_id, owner_epoch, write_count) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[t, p, batchId, seq, this.fence.ownerId, this.fence.epoch, batch.count],
		);
		await client.query(`INSERT INTO ${S}.runtime_outbox (tenant_id, partition_id, seq, changes) VALUES ($1, $2, $3, $4)`, [t, p, seq, JSON.stringify(batch.changes)]);
		await client.query("SELECT pg_notify('pim_runtime_outbox', $1)", [JSON.stringify({ tenantId: t, partitionId: p, seq })]);
		return seq;
	}

	// ---- reads ----

	#read<R extends pg.QueryResultRow>(text: string, values: unknown[]): Promise<R[]> {
		this.#assertUsable();
		return this.db.read<R>(this.tenantId, text, values).then((result) => result.rows);
	}

	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		const rows = await this.#read<{ record: string }>(
			`SELECT record FROM ${S}.conversations WHERE tenant_id = $1 AND partition_id = $2 AND id = $3`,
			[this.tenantId, this.partitionId, id],
		);
		return rows[0] === undefined ? undefined : parse(rows[0].record);
	}

	async scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<ConversationRecord, Cursor>> {
		const start = scanStart(query.order, cursor, "ascending");
		const where = new Where(this.tenantId, this.partitionId);
		where.eq("owner_task_id", query.ownerTaskId);
		where.eq("owner_conversation_id", query.ownerConversationId);
		return this.#scan<ConversationRecord>("conversations", where, start, limit);
	}

	async #scan<T extends { id: number }>(table: string, where: Where, start: { order: ScanOrder; after: number | undefined }, limit: number): Promise<Page<T, Cursor>> {
		if (start.after !== undefined) where.add(start.order === "ascending" ? "id >" : "id <", start.after);
		const rows = await this.#read<{ record: string }>(
			`SELECT record FROM ${S}.${table} WHERE ${where.sql} ORDER BY id ${start.order === "ascending" ? "ASC" : "DESC"} LIMIT ${where.param(limit + 1)}`,
			where.values,
		);
		return pageOf(rows.map((row) => parse<T>(row.record)), limit, start.order);
	}

	async entry(idOrConversationId: number, idOrContext?: number | Context, context?: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		if (context === undefined) {
			const rows = await this.#read<{ record: string; commit_seq: string }>(
				`SELECT record, commit_seq FROM ${S}.entries WHERE tenant_id = $1 AND partition_id = $2 AND id = $3`,
				[this.tenantId, this.partitionId, idOrConversationId],
			);
			const row = rows[0];
			return row === undefined ? undefined : { entry: parse<EntryRecord>(row.record), commitSeq: Number(row.commit_seq) as Seq };
		}
		if (typeof idOrContext !== "number") throw new TypeError("Storage.entry() requires an entry ID");
		await this.#requireConversation(idOrConversationId);
		const rows = await this.#read<{ record: string; commit_seq: string }>(
			`${CHAIN} SELECT e.record, e.commit_seq FROM chain JOIN ${S}.entries e ON e.tenant_id = $1 AND e.conversation_id = chain.conversation_id AND e.id <= chain.upper AND e.id >= $3 WHERE e.id = $3`,
			[this.tenantId, idOrConversationId, idOrContext, idOrContext, this.partitionId],
		);
		const row = rows[0];
		return row === undefined ? undefined : { entry: parse<EntryRecord>(row.record), commitSeq: Number(row.commit_seq) as Seq };
	}

	async findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		await this.#requireConversation(conversationId);
		const rows = await this.#read<{ record: string }>(
			`${CHAIN} SELECT e.record FROM chain JOIN ${S}.entries e ON e.tenant_id = $1 AND e.conversation_id = chain.conversation_id AND e.id <= chain.upper AND e.id >= $3 AND e.head IS NOT NULL ORDER BY e.id DESC LIMIT 1`,
			[this.tenantId, conversationId, 0, atOrBeforeEntryId ?? MAX_ID, this.partitionId],
		);
		return rows[0] === undefined ? undefined : parse(rows[0].record);
	}

	async scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<EntryRecord, Cursor>> {
		const { order, after } = scanStart(query.order, cursor, "descending");
		let min = query.minEntryId ?? 0;
		let max = query.maxEntryId ?? MAX_ID;
		if (after !== undefined && order === "descending") max = Math.min(max, after - 1);
		if (after !== undefined && order === "ascending") min = Math.max(min, after + 1);
		await this.#requireConversation(query.conversationId);
		const rows = await this.#read<{ record: string }>(
			`${CHAIN} SELECT e.record FROM chain JOIN ${S}.entries e ON e.tenant_id = $1 AND e.conversation_id = chain.conversation_id AND e.id <= chain.upper AND e.id >= $3 ORDER BY e.id ${order === "ascending" ? "ASC" : "DESC"} LIMIT ${limit + 1}`,
			[this.tenantId, query.conversationId, min, max, this.partitionId],
		);
		return pageOf(rows.map((row) => parse<EntryRecord>(row.record)), limit, order);
	}

	async #requireConversation(id: number): Promise<void> {
		const rows = await this.#read(`SELECT 1 FROM ${S}.conversations WHERE tenant_id = $1 AND partition_id = $2 AND id = $3`, [this.tenantId, this.partitionId, id]);
		if (rows.length === 0) throw new Error(`Unknown conversation: ${id}`);
	}

	async task(id: TaskId, _context: Context): Promise<AnyTask | undefined> {
		const rows = await this.#read<{ record: string }>(`SELECT record FROM ${S}.tasks WHERE tenant_id = $1 AND partition_id = $2 AND id = $3`, [this.tenantId, this.partitionId, id]);
		return rows[0] === undefined ? undefined : parse(rows[0].record);
	}

	async scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<AnyTask, Cursor>> {
		const start = scanStart(query.order, cursor, "ascending");
		const where = new Where(this.tenantId, this.partitionId);
		where.eq("conversation_id", query.conversationId);
		where.eq("kind", query.kind === undefined ? undefined : ident(query.kind));
		where.eq("status", query.status);
		where.eq("abort_requested", query.abortRequested);
		where.eq("background", query.background);
		return this.#scan<AnyTask>("tasks", where, start, limit);
	}

	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		const rows = await this.#read<{ record: string }>(`SELECT record FROM ${S}.submissions WHERE tenant_id = $1 AND partition_id = $2 AND id = $3`, [
			this.tenantId,
			this.partitionId,
			id,
		]);
		return rows[0] === undefined ? undefined : parse(rows[0].record);
	}

	async scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<SubmissionRecord, Cursor>> {
		const start = scanStart(query.order, cursor, "ascending");
		const where = new Where(this.tenantId, this.partitionId);
		where.eq("conversation_id", query.conversationId);
		where.eq("status", query.status);
		return this.#scan<SubmissionRecord>("submissions", where, start, limit);
	}

	async submissionByRequest(conversationId: ConversationId, requestId: string, _context: Context): Promise<SubmissionRecord | undefined> {
		const rows = await this.#read<{ record: string }>(
			`SELECT record FROM ${S}.submissions WHERE tenant_id = $1 AND partition_id = $2 AND conversation_id = $3 AND request_id = $4`,
			[this.tenantId, this.partitionId, conversationId, ident(requestId)],
		);
		return rows[0] === undefined ? undefined : parse(rows[0].record);
	}

	async findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
		const scopeId = scopeIdOf(address.scope);
		const rows = await this.#read<DocRow>(
			`SELECT * FROM ${S}.documents
			 WHERE tenant_id = $1 AND partition_id = $2 AND kind = $3 AND scope_kind = $4 AND coalesce(scope_id, 0) = $5
			   AND (doc_key IS NOT NULL) = $6 AND coalesce(doc_key, '') = $7 AND ${alive("$8")}
			 ORDER BY id LIMIT 1`,
			[this.tenantId, this.partitionId, ident(address.kind), address.scope.kind, scopeId ?? 0, address.key !== undefined, address.key === undefined ? "" : ident(address.key), at === "current" ? null : at],
		);
		return rows[0] === undefined ? undefined : docRecord(rows[0]);
	}

	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		return materialize((text, values) => this.#read(text, values), this.tenantId, this.partitionId, id, at);
	}

	async scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<DocumentRecord, Cursor>> {
		const { after } = scanStart("ascending", cursor, "ascending");
		const where = new Where(this.tenantId, this.partitionId);
		where.add("scope_kind =", query.scope.kind);
		where.add("coalesce(scope_id, 0) =", scopeIdOf(query.scope) ?? 0);
		where.eq("kind", query.kind === undefined ? undefined : ident(query.kind));
		if (after !== undefined) where.add("id >", after);
		const point = where.param(query.at === "current" ? null : query.at);
		const rows = await this.#read<DocRow>(`SELECT * FROM ${S}.documents WHERE ${where.sql} AND ${alive(point)} ORDER BY id LIMIT ${where.param(limit + 1)}`, where.values);
		return pageOf(rows.map(docRecord), limit, "ascending");
	}

	async close(_context: Context): Promise<void> {
		this.#closed = true;
	}

	#assertUsable(): void {
		if (this.#closed) throw new Error("PgPiStorage is closed");
		if (this.#ambiguous !== undefined) {
			throw new Error(`The storage of partition ${this.partitionId} is poisoned by commit batch ${this.#ambiguous.batchId}, whose outcome is unknown; reconcile and reopen it`);
		}
	}
}

// ---- scans ----

/** The fork chain of $2 from the newest ancestor segment back: each segment's conversation and the highest visible entry in it. $3 is the lowest wanted id, $4 the highest, $5 the partition. */
const CHAIN = `WITH RECURSIVE chain(conversation_id, upper) AS (
	SELECT $2::bigint, $4::bigint
	UNION ALL
	SELECT c.parent_conversation_id, LEAST(chain.upper, c.parent_at)
	FROM chain JOIN ${S}.conversations c ON c.tenant_id = $1 AND c.partition_id = $5 AND c.id = chain.conversation_id
	WHERE c.parent_conversation_id IS NOT NULL AND LEAST(chain.upper, c.parent_at) >= $3::bigint
)`;

function scanStart(requested: ScanOrder | undefined, cursor: Cursor | undefined, fallback: ScanOrder): { order: ScanOrder; after: number | undefined } {
	if (requested !== undefined && requested !== "ascending" && requested !== "descending") throw new TypeError(`Invalid scan order: ${String(requested)}`);
	if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
	const { after, order: stored } = cursor;
	if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new TypeError("Invalid storage cursor");
	if (stored !== undefined && stored !== "ascending" && stored !== "descending") throw new TypeError("Invalid storage cursor");
	const order = stored ?? fallback;
	if (requested !== undefined && requested !== order) throw new TypeError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
	return { order, after };
}

function pageOf<T extends { id: number }>(values: T[], limit: number, order: ScanOrder): Page<T, Cursor> {
	if (values.length <= limit) return { items: values };
	const items = values.slice(0, limit);
	return { items, next: { after: items.at(-1)?.id ?? 0, order } };
}

/** Accumulates a parameterized WHERE over tenant and partition; undefined filters add nothing. */
class Where {
	readonly values: unknown[] = [];
	readonly #clauses: string[] = [];
	constructor(tenantId: string, partitionId: string) {
		this.add("tenant_id =", tenantId);
		this.add("partition_id =", partitionId);
	}
	param(value: unknown): string {
		this.values.push(value);
		return `$${this.values.length}`;
	}
	add(prefix: string, value: unknown): void {
		this.#clauses.push(`${prefix} ${this.param(value)}`);
	}
	eq(column: string, value: unknown): void {
		if (value !== undefined) this.add(`${column} =`, value);
	}
	get sql(): string {
		return this.#clauses.join(" AND ");
	}
}

// ---- documents ----

type DocRow = {
	id: string;
	kind: string;
	doc_key: string | null;
	created_at: string;
	retired_at: string | null;
	scope_kind: string;
	scope_id: string | null;
	history: string | null;
	record: string;
};

const alive = (point: string): string => `(${point}::bigint IS NULL AND retired_at IS NULL OR created_at <= ${point}::bigint AND (retired_at IS NULL OR ${point}::bigint < retired_at))`;

function scopeIdOf(scope: DocumentRecord["scope"]): number | undefined {
	return scope.kind === "conversation" ? scope.conversationId : scope.kind === "task" ? scope.taskId : undefined;
}

function docRecord(row: DocRow): DocumentRecord {
	return { ...parse<Record<string, unknown>>(row.record), createdAt: Number(row.created_at), ...(row.retired_at === null ? {} : { retiredAt: Number(row.retired_at) }) } as unknown as DocumentRecord;
}

const isCurrentOnly = (record: { scope: { kind: string }; history?: string }): boolean => record.scope.kind !== "conversation" || record.history === "latest";

type Exec = (text: string, values: unknown[]) => Promise<pg.QueryResultRow[]>;

/** Materialize one document incarnation at a point: the newest base at or below it, plus the deltas after it. */
async function materialize(exec: Exec, tenantId: string, partitionId: string, id: number, at: DocumentPoint): Promise<StoredDocument | undefined> {
	const found = (await exec(`SELECT * FROM ${S}.documents WHERE tenant_id = $1 AND partition_id = $2 AND id = $3`, [tenantId, partitionId, id])) as DocRow[];
	const row = found[0];
	if (row === undefined) return undefined;
	const record = docRecord(row);
	if (at !== "current" && isCurrentOnly(record)) throw new Error(`Document ${id} does not retain historical content`);
	const aliveNow = at === "current" ? record.retiredAt === undefined : record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
	if (!aliveNow) return undefined;
	const bound = at === "current" ? MAX_ID : at;
	const revisions = (await exec(
		`SELECT seq, kind, version, content FROM ${S}.document_revisions
		 WHERE tenant_id = $1 AND document_id = $2 AND seq <= $3
		   AND seq >= coalesce((SELECT max(seq) FROM ${S}.document_revisions WHERE tenant_id = $1 AND document_id = $2 AND kind = 'base' AND seq <= $3), 0)
		 ORDER BY seq`,
		[tenantId, id, bound],
	)) as { seq: string; kind: "base" | "delta"; version: number; content: string }[];
	const base = revisions[0];
	if (base?.kind !== "base") throw new Error(`Document ${id} is missing a required base`);
	const deltas = revisions.slice(1);
	for (const delta of deltas) {
		if (delta.kind !== "delta" || delta.version !== base.version) throw new Error(`Document ${id} crosses a stored version boundary without a base`);
	}
	const value = applyImmutableBatches(parse(base.content) as never, (function* () {
		for (const delta of deltas) yield parse(delta.content) as never;
	})());
	return { record, version: base.version, value: value as StoredDocument["value"], deltasSinceBase: deltas.length };
}

// ---- commit preparation ----

type Batch = {
	count: number;
	conversations: ConversationRecord[];
	entries: EntryRecord[];
	tasks: AnyTask[];
	submissions: SubmissionRecord[];
	documents: DocumentWrite[];
	changes: unknown[];
	/** The largest record id the batch writes. */
	maxId: number;
};

function rejection(error: unknown): StorageRejected {
	if (error instanceof StorageRejected) return error;
	const reason = error instanceof Error ? error.message : String(error);
	if (error instanceof pg.DatabaseError && error.code === "23505" && error.constraint === "documents_one_current") {
		return new StorageRejected("Document address already has a current incarnation", { cause: error });
	}
	return new StorageRejected(`The batch was rejected: ${reason}`, { cause: error });
}

/** Split a batch by record type, keeping the last write of a task or submission written twice, and check what needs no database. */
function prepareBatch(writes: readonly StorageWrite[]): Batch {
	const batch: Batch = { count: writes.length, conversations: [], entries: [], tasks: [], submissions: [], documents: [], changes: [], maxId: 0 };
	const tasks = new Map<number, AnyTask>();
	const submissions = new Map<number, SubmissionRecord>();
	const claimed = new Map<number, string>();
	const claim = (id: number, table: string): void => {
		if (id > batch.maxId) batch.maxId = id;
		const earlier = claimed.get(id);
		if (table === "conversation" || table === "entry" || table === "document") {
			if (earlier !== undefined) throw new StorageRejected(`ID ${id} is written more than once`);
		} else if (earlier !== undefined && earlier !== table) {
			throw new StorageRejected(`ID ${id} is written as two record types`);
		}
		claimed.set(id, table);
	};
	for (const write of writes) {
		switch (write.type) {
			case "conversation":
				claim(write.value.id, "conversation");
				batch.conversations.push(write.value);
				batch.changes.push({ type: "conversation", id: write.value.id });
				break;
			case "entry":
				claim(write.value.id, "entry");
				batch.entries.push(write.value);
				batch.changes.push({ type: "entry", id: write.value.id, conversationId: write.value.conversationId, kind: write.value.kind });
				break;
			case "task":
				claim(write.value.id, "task");
				tasks.set(write.value.id, write.value);
				batch.changes.push({ type: "task", id: write.value.id, conversationId: write.value.conversationId, kind: write.value.kind, status: write.value.state.status });
				break;
			case "submission":
				claim(write.value.id, "submission");
				submissions.set(write.value.id, write.value);
				batch.changes.push({ type: "submission", id: write.value.id, conversationId: write.value.conversationId, status: write.value.status });
				break;
			case "document.create":
			case "document.copy":
				claim(write.record.id, "document");
				batch.documents.push(write);
				batch.changes.push({ type: write.type, id: write.record.id });
				break;
			case "document.change":
			case "document.retire":
				batch.documents.push(write);
				batch.changes.push({ type: write.type, id: write.id });
				break;
		}
	}
	batch.tasks = [...tasks.values()];
	batch.submissions = [...submissions.values()];
	return batch;
}

/** Record every new id in the tenant-wide table; a duplicate of another record's id fails the batch. */
async function claimIds(client: pg.PoolClient, t: string, p: string, batch: Batch): Promise<void> {
	const claims: { id: number; kind: string }[] = [
		...batch.conversations.map((v) => ({ id: v.id, kind: "conversation" })),
		...batch.entries.map((v) => ({ id: v.id, kind: "entry" })),
		...batch.tasks.map((v) => ({ id: v.id, kind: "task" })),
		...batch.submissions.map((v) => ({ id: v.id, kind: "submission" })),
		...batch.documents.filter((d) => d.type === "document.create" || d.type === "document.copy").map((d) => ({ id: (d as { record: { id: number } }).record.id, kind: "document" })),
	];
	if (claims.length === 0) return;
	for (const claim of claims) {
		if (!Number.isSafeInteger(claim.id) || claim.id < 1) throw new StorageRejected(`ID ${claim.id} is not a valid record ID`);
	}
	const inserted = await client.query<{ id: string }>(
		`INSERT INTO ${S}.record_ids (tenant_id, id, kind, partition_id) SELECT $1, x.id, x.kind, $2 FROM unnest($3::bigint[], $4::text[]) AS x(id, kind)
		 ON CONFLICT DO NOTHING RETURNING id`,
		[t, p, claims.map((c) => c.id), claims.map((c) => c.kind)],
	);
	const fresh = new Set(inserted.rows.map((r) => Number(r.id)));
	const existing = claims.filter((c) => !fresh.has(c.id));
	if (existing.length === 0) return;
	const owners = new Map(
		(
			await client.query<{ id: string; kind: string; partition_id: string }>(`SELECT id, kind, partition_id FROM ${S}.record_ids WHERE tenant_id = $1 AND id = ANY($2::bigint[])`, [
				t,
				existing.map((c) => c.id),
			])
		).rows.map((r) => [Number(r.id), r]),
	);
	for (const claim of existing) {
		const owner = owners.get(claim.id);
		if (claim.kind === "task" || claim.kind === "submission") {
			if (owner?.kind !== claim.kind) throw new StorageRejected(`ID ${claim.id} already belongs to ${owner?.kind}`);
			if (owner.partition_id !== p) throw new StorageRejected(`ID ${claim.id} already belongs to partition ${owner.partition_id}`);
		} else {
			throw new StorageRejected(`ID ${claim.id} already belongs to ${owner?.kind}`);
		}
	}
}

const text = (value: unknown): string => JSON.stringify(value);

async function writeConversations(client: pg.PoolClient, t: string, p: string, batch: Batch): Promise<void> {
	if (batch.conversations.length === 0) return;
	const rows = batch.conversations;
	await client.query(
		`INSERT INTO ${S}.conversations (tenant_id, partition_id, id, parent_conversation_id, parent_at, owner_conversation_id, owner_task_id, record)
		 SELECT $1, $2, x.* FROM unnest($3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::text[]) AS x`,
		[t, p, rows.map((c) => c.id), rows.map((c) => c.parent?.conversationId ?? null), rows.map((c) => c.parent?.at ?? null), rows.map((c) => c.owner?.conversationId ?? null), rows.map((c) => c.owner?.taskId ?? null), rows.map(text)],
	);
	await client.query(`INSERT INTO ${S}.conversation_partitions (tenant_id, conversation_id, partition_id) SELECT $1, x, $2 FROM unnest($3::bigint[]) AS x`, [t, p, rows.map((c) => c.id)]);
}

/** Closure: every conversation a record refers to, a fork's parent included, is in this partition. */
async function checkReferences(client: pg.PoolClient, t: string, p: string, batch: Batch): Promise<void> {
	const wanted = new Set<number>();
	for (const c of batch.conversations) if (c.parent !== undefined) wanted.add(c.parent.conversationId);
	for (const e of batch.entries) wanted.add(e.conversationId);
	for (const k of batch.tasks) wanted.add(k.conversationId);
	for (const s of batch.submissions) wanted.add(s.conversationId);
	for (const d of batch.documents) {
		const scope = d.type === "document.create" || d.type === "document.copy" ? d.record.scope : undefined;
		if (scope?.kind === "conversation") wanted.add(scope.conversationId);
	}
	if (wanted.size === 0) return;
	const present = await client.query<{ id: string }>(`SELECT id FROM ${S}.conversations WHERE tenant_id = $1 AND partition_id = $2 AND id = ANY($3::bigint[])`, [t, p, [...wanted]]);
	const found = new Set(present.rows.map((r) => Number(r.id)));
	for (const id of wanted) if (!found.has(id)) throw new StorageRejected(`Conversation ${id} is not in partition ${p}`);
}

async function writeEntries(client: pg.PoolClient, t: string, p: string, batch: Batch, seq: number): Promise<void> {
	if (batch.entries.length === 0) return;
	const rows = batch.entries;
	await client.query(
		`INSERT INTO ${S}.entries (tenant_id, partition_id, id, conversation_id, head, commit_seq, record)
		 SELECT $1, $2, x.id, x.conversation_id, x.head, $3, x.record FROM unnest($4::bigint[], $5::bigint[], $6::bigint[], $7::text[]) AS x(id, conversation_id, head, record)`,
		[t, p, seq, rows.map((e) => e.id), rows.map((e) => e.conversationId), rows.map((e) => e.head ?? null), rows.map(text)],
	);
}

async function writeTasks(client: pg.PoolClient, t: string, p: string, batch: Batch): Promise<void> {
	if (batch.tasks.length === 0) return;
	const rows = batch.tasks;
	await client.query(
		`INSERT INTO ${S}.tasks (tenant_id, partition_id, id, conversation_id, kind, status, outcome_status, abort_requested, background, record)
		 SELECT $1, $2, x.* FROM unnest($3::bigint[], $4::bigint[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::boolean[], $10::text[]) AS x
		 ON CONFLICT (tenant_id, id) DO UPDATE SET status = excluded.status, outcome_status = excluded.outcome_status,
		   abort_requested = excluded.abort_requested, background = excluded.background, record = excluded.record, kind = excluded.kind, conversation_id = excluded.conversation_id`,
		[
			t,
			p,
			rows.map((k) => k.id),
			rows.map((k) => k.conversationId),
			rows.map((k) => ident(k.kind)),
			rows.map((k) => k.state.status),
			rows.map((k) => k.state.outcome?.status ?? null),
			rows.map((k) => k.abortRequested),
			rows.map((k) => k.background),
			rows.map(text),
		],
	);
}

async function writeSubmissions(client: pg.PoolClient, t: string, p: string, batch: Batch): Promise<void> {
	if (batch.submissions.length === 0) return;
	const rows = batch.submissions;
	await client.query(
		`INSERT INTO ${S}.submissions (tenant_id, partition_id, id, conversation_id, status, request_id, record)
		 SELECT $1, $2, x.* FROM unnest($3::bigint[], $4::bigint[], $5::text[], $6::text[], $7::text[]) AS x
		 ON CONFLICT (tenant_id, id) DO UPDATE SET status = excluded.status, request_id = excluded.request_id, record = excluded.record, conversation_id = excluded.conversation_id`,
		[t, p, rows.map((r) => r.id), rows.map((r) => r.conversationId), rows.map((r) => r.status), rows.map((r) => identOrNull(r.requestId)), rows.map(text)],
	);
}

type DocAction = { create?: DocumentWrite & { type: "document.create" }; content?: DocContent; retire: boolean };

async function writeDocuments(client: pg.PoolClient, t: string, p: string, batch: Batch, seq: number): Promise<void> {
	if (batch.documents.length === 0) return;
	const exec: Exec = async (text, values) => (await client.query(text, values)).rows;
	// Copies read the source as committed before this batch.
	const resolved: DocumentWrite[] = [];
	const changed = new Set<number>();
	for (const write of batch.documents) {
		if (write.type === "document.create" || write.type === "document.copy") changed.add(write.record.id);
		else changed.add(write.id);
	}
	for (const write of batch.documents) {
		if (write.type !== "document.copy") {
			resolved.push(write);
			continue;
		}
		try {
			if (changed.has(write.source.id)) throw new Error(`Fork source document ${write.source.id} is changed in the copy batch`);
			const stored = await materialize(exec, t, p, write.source.id, write.source.at);
			if (stored === undefined) throw new Error(`Fork source document ${write.source.id} cannot be read`);
			const a = stored.record;
			const b = write.record;
			if (a.scope.kind !== "conversation" || b.scope.kind !== "conversation" || a.kind !== b.kind || a.key !== b.key || a.history !== b.history || a.fork !== b.fork) {
				throw new Error(`Fork source document ${write.source.id} does not match the copied record`);
			}
			resolved.push({ type: "document.create", record: write.record, content: { kind: "base", version: stored.version, value: stored.value } });
		} catch (error) {
			if (error instanceof StorageRejected) throw error;
			throw new StorageRejected(`Document copy ${write.record.id} was rejected`, { cause: error });
		}
	}

	const actions = new Map<number, DocAction>();
	for (const write of resolved) {
		const id = write.type === "document.create" ? write.record.id : (write as { id: number }).id;
		let action = actions.get(id);
		if (action === undefined) {
			action = { retire: false };
			actions.set(id, action);
		}
		if (write.type === "document.create") {
			if (action.create !== undefined || action.content !== undefined) throw new StorageRejected(`Document ${id} has more than one content command`);
			action.create = write;
			action.content = write.content;
		} else if (write.type === "document.change") {
			if (action.content !== undefined) throw new StorageRejected(`Document ${id} has more than one content command`);
			action.content = write.content;
		} else if (write.type === "document.retire") {
			if (action.retire) throw new StorageRejected(`Document ${id} is retired more than once`);
			action.retire = true;
		}
	}

	const existingIds = [...actions].filter(([, a]) => a.create === undefined).map(([id]) => id);
	const existing = new Map<number, DocRow & { last_version: number | null }>();
	if (existingIds.length > 0) {
		const rows = (await client.query(
			`SELECT d.*, (SELECT version FROM ${S}.document_revisions r WHERE r.tenant_id = d.tenant_id AND r.document_id = d.id ORDER BY seq DESC LIMIT 1) AS last_version
			 FROM ${S}.documents d WHERE d.tenant_id = $1 AND d.partition_id = $2 AND d.id = ANY($3::bigint[])`,
			[t, p, existingIds],
		)).rows as (DocRow & { last_version: number | null })[];
		for (const row of rows) existing.set(Number(row.id), row);
	}

	// Documents that already exist first (a retire frees an address a create in the same batch takes), then new ones.
	for (const [id, action] of actions) {
		if (action.create !== undefined) continue;
		const row = existing.get(id);
		if (row === undefined) throw new StorageRejected(`Unknown document: ${id}`);
		if (row.retired_at !== null) throw new StorageRejected(`Document ${id} is retired`);
		const currentOnly = isCurrentOnly({ scope: { kind: row.scope_kind }, history: row.history ?? undefined });
		if (action.content !== undefined) {
			if (action.content.kind === "delta") {
				if (row.last_version === null) throw new StorageRejected(`Document ${id} delta has no base`);
				if (row.last_version !== action.content.version) throw new StorageRejected(`Document ${id} version transition requires a base`);
			}
			await insertRevision(client, t, p, id, seq, action.content);
			if (action.content.kind === "base" && currentOnly) {
				await client.query(`DELETE FROM ${S}.document_revisions WHERE tenant_id = $1 AND document_id = $2 AND seq < $3`, [t, id, seq]);
			}
		}
		if (action.retire) {
			await client.query(`UPDATE ${S}.documents SET retired_at = $3 WHERE tenant_id = $1 AND id = $2`, [t, id, seq]);
			if (currentOnly) await client.query(`DELETE FROM ${S}.document_revisions WHERE tenant_id = $1 AND document_id = $2`, [t, id]);
		}
	}
	for (const [id, action] of actions) {
		const create = action.create;
		if (create === undefined) continue;
		const record = create.record;
		const scopeId = scopeIdOf(record.scope);
		await client.query(
			`INSERT INTO ${S}.documents (tenant_id, partition_id, id, kind, doc_key, scope_kind, scope_id, history, fork, created_at, retired_at, record)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
			[t, p, id, ident(record.kind), identOrNull(record.key), record.scope.kind, scopeId ?? null, (record as { history?: string }).history ?? null, (record as { fork?: string }).fork ?? null, seq, action.retire ? seq : null, JSON.stringify(record)],
		);
		if (action.content === undefined) throw new StorageRejected(`Document ${id} has no content`);
		// A document created and retired in one commit keeps its base only when it retains history.
		if (!(action.retire && isCurrentOnly(record as { scope: { kind: string }; history?: string }))) await insertRevision(client, t, p, id, seq, action.content);
	}
}

async function insertRevision(client: pg.PoolClient, t: string, p: string, id: number, seq: number, content: DocContent): Promise<void> {
	await client.query(`INSERT INTO ${S}.document_revisions (tenant_id, partition_id, document_id, seq, kind, version, content) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
		t,
		p,
		id,
		seq,
		content.kind,
		content.version,
		JSON.stringify(content.kind === "base" ? content.value : content.ops),
	]);
}

// ---- ambiguous commit reconciliation ----

export type AmbiguousOutcome = { readonly committed: true; readonly seq: number } | { readonly committed: false };

/**
 * Find out whether a batch whose COMMIT acknowledgement was lost landed. A commit takes the partition row as its first
 * write, so locking that row waits out the old backend's transaction; when the old backend cannot be waited out it is
 * terminated, which rolls its transaction back. Then the receipt written in that same transaction is there or it is not.
 */
export async function reconcileAmbiguousCommit(db: Db, batch: AmbiguousBatch, options: { lockTimeoutMs?: number } = {}): Promise<AmbiguousOutcome> {
	const lockTimeout = Math.max(1, Math.floor(options.lockTimeoutMs ?? 2_000));
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return await db.transaction(batch.tenantId, async (client) => {
				await client.query(`SET LOCAL lock_timeout = ${lockTimeout}`);
				await client.query(`SELECT 1 FROM ${S}.partitions WHERE tenant_id = $1 AND partition_id = $2 FOR UPDATE`, [batch.tenantId, batch.partitionId]);
				const receipt = await client.query<{ commit_seq: string }>(
					`SELECT commit_seq FROM ${S}.commit_receipts WHERE tenant_id = $1 AND partition_id = $2 AND batch_id = $3`,
					[batch.tenantId, batch.partitionId, batch.batchId],
				);
				const row = receipt.rows[0];
				return row === undefined ? { committed: false as const } : { committed: true as const, seq: Number(row.commit_seq) };
			});
		} catch (error) {
			if ((error as { code?: string }).code !== "55P03" || attempt === 1 || batch.backendPid === undefined) throw error;
			// The old backend still holds the row: end it, then look again.
			await db.pool.query("SELECT pg_terminate_backend($1)", [batch.backendPid]);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error("unreachable");
}
