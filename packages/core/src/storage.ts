import { randomUUID } from "node:crypto";
import { apply } from "@earendil-works/chord/delta";
import { StorageRejected } from "@earendil-works/pi-durable";
import type { ConversationRecord, DocumentRecord, EntryRecord, Storage, StorageWrite, SubmissionRecord, TaskRecord } from "@earendil-works/pi-durable";
import pg from "pg";
import { type Q, withTenant } from "./db.ts";
import type { IdAllocator } from "./ids.ts";

/** The family's lease or epoch no longer matches: nothing was written. Not a `StorageRejected`, so pi poisons the Session and the Runner must close the Harness. */
export class OwnershipLost extends Error {
	constructor(readonly partitionId: string, readonly epoch: number) {
		super(`Ownership of partition ${partitionId} at epoch ${epoch} was lost`);
		this.name = "OwnershipLost";
	}
}

/** COMMIT was sent and its outcome is unknown. Resolved against the commit receipt, never retried. */
class AmbiguousCommit extends Error {}

/** Fault injection for qualification: both hooks run on the committing connection. */
export interface CommitFaults {
	/** Before COMMIT is sent. */
	beforeCommit?: (client: pg.PoolClient) => Promise<void>;
	/** After COMMIT was acknowledged; throw a plain Error to lose the acknowledgement. */
	afterCommit?: () => Promise<void>;
}

export interface PgStorageOptions {
	pool: pg.Pool;
	tenantId: string;
	partitionId: string;
	ownerId: string;
	/** The epoch this owner acquired. */
	epoch: number;
	/** Whether this is the tenant's home family, the only one that may hold conversation 1. */
	home: boolean;
	ids: IdAllocator;
	faults?: CommitFaults;
	/** Called once, after a commit is durable, with its sequence and a summary of what changed. */
	onCommitted?: (seq: number, summary: readonly CommitChange[]) => void;
	/** Called when a commit finds the lease or epoch no longer ours. */
	onOwnershipLost?: (error: OwnershipLost) => void;
	/** How long to wait for the previous backend's transaction while resolving an unknown COMMIT. */
	resolveTimeoutMs?: number;
}

export type CommitChange = { t: "conversation" | "entry" | "task" | "submission" | "document.create" | "document.copy" | "document.change" | "document.retire"; id: number; c?: number; s?: string };

type Cursor = Readonly<Record<string, any>>;
type Order = "ascending" | "descending";

const ROOT_CONVERSATION = 1;

const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value);
// JSON encoding keeps indexed identities lossless, including lone surrogates a text column could not hold.
const encodeIndexed = (value: string): string => JSON.stringify(value);

function scanStart(requested: Order | undefined, cursor: Cursor | undefined, fallback: Order): { order: Order; after: number | undefined } {
	if (requested !== undefined && requested !== "ascending" && requested !== "descending") throw new TypeError(`Invalid scan order: ${String(requested)}`);
	if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
	const { after, order: stored } = cursor as { after?: unknown; order?: unknown };
	if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new TypeError("Invalid storage cursor");
	if (stored !== undefined && stored !== "ascending" && stored !== "descending") throw new TypeError("Invalid storage cursor");
	const order = (stored as Order | undefined) ?? fallback;
	if (requested !== undefined && requested !== order) throw new TypeError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
	return { order, after };
}

function page<T extends { id: number }>(values: T[], limit: number, order: Order = "ascending"): { items: T[]; next?: Cursor } {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: { after: items.at(-1)!.id, order } };
}

const scanSql = (start: { order: Order; after: number | undefined }, column: string, at: number) =>
	start.order === "ascending"
		? { clause: `${column} > $${at}`, param: start.after ?? -1, direction: "ASC" }
		: { clause: `${column} < $${at}`, param: start.after ?? Number.MAX_SAFE_INTEGER, direction: "DESC" };

type Scope = { kind: "session" } | { kind: "conversation"; conversationId: number } | { kind: "task"; taskId: number };
const scopeColumns = (scope: Scope) => {
	switch (scope.kind) {
		case "session":
			return { scopeKind: "session", ownerId: 0 };
		case "conversation":
			return { scopeKind: "conversation", ownerId: scope.conversationId };
		case "task":
			return { scopeKind: "task", ownerId: scope.taskId };
	}
};
type Address = { kind: string; scope: Scope; key?: string };
const addressParts = (address: Address) => ({ kind: encodeIndexed(address.kind), ...scopeColumns(address.scope), family: address.key === undefined ? 0 : 1, keyValue: encodeIndexed(address.key ?? "") });
const addressKey = (address: Address) => {
	const p = addressParts(address);
	return JSON.stringify([p.kind, p.scopeKind, p.ownerId, p.family, p.keyValue]);
};

const isAliveAt = (record: DocumentRecord, at: "current" | number) => (at === "current" ? record.retiredAt === undefined : record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt));
const isCurrentOnly = (record: DocumentRecord) => record.scope.kind !== "conversation" || (record as { history?: string }).history === "latest";

const writeId = (write: StorageWrite): number | undefined => {
	switch (write.type) {
		case "conversation":
		case "entry":
		case "task":
		case "submission":
			return write.value.id;
		case "document.create":
		case "document.copy":
			return write.record.id;
		default:
			return undefined;
	}
};

type DocAction = { create?: any; content?: any; copy?: { id: number; at: number | "current" }; retire: boolean };

/**
 * pi-durable's `Storage` over PostgreSQL, for one conversation family.
 *
 * Every mutating transaction first advances the family's commit sequence through the row that holds its owner,
 * epoch and lease; zero rows updated means ownership was lost and nothing was written, so a stale owner can neither
 * open-and-rewrite running tasks nor commit. COMMIT's acknowledgement is lost safely: the commit's receipt is
 * inserted in the same transaction and an unknown outcome is resolved from it, never retried.
 */
export class PgStorage implements Storage {
	readonly #o: PgStorageOptions;
	#closed = false;
	#reads = 0;
	#drained: (() => void) | undefined;
	#writes = 0;
	#lost = false;

	constructor(options: PgStorageOptions) {
		this.#o = options;
	}

	get partitionId(): string {
		return this.#o.partitionId;
	}
	get epoch(): number {
		return this.#o.epoch;
	}

	// ---- commit ---------------------------------------------------------------------------------------------

	async commit(writes: readonly StorageWrite[], _context?: unknown): Promise<any> {
		this.#assertOpen();
		if (this.#lost) throw new OwnershipLost(this.#o.partitionId, this.#o.epoch);
		const docActions = this.#prepareDocumentActions(writes);
		const token = randomUUID();
		this.#writes++;
		try {
			try {
				return await this.#attempt(writes, docActions, token);
			} catch (error) {
				if (error instanceof AmbiguousCommit) return await this.#resolve(token);
				if (error instanceof OwnershipLost) {
					this.#lost = true;
					this.#o.onOwnershipLost?.(error);
				}
				throw error;
			}
		} finally {
			this.#writes--;
			if (this.#writes === 0 && this.#reads === 0) this.#drained?.();
		}
	}

	async #attempt(writes: readonly StorageWrite[], docActions: Map<number, DocAction>, token: string): Promise<number> {
		const { pool, tenantId, partitionId } = this.#o;
		const client = await pool.connect();
		// A backend killed mid-transaction emits on the checked-out client; the failed query reports it.
		const ignore = () => undefined;
		client.on("error", ignore);
		let sent = false;
		let discard = false;
		try {
			const q: Q = {
				client,
				all: async (sql, ...p) => (await client.query(sql, p as unknown[])).rows,
				get: async (sql, ...p) => (await client.query(sql, p as unknown[])).rows[0],
				run: async (sql, ...p) => (await client.query(sql, p as unknown[])).rowCount ?? 0,
			};
			await client.query("BEGIN");
			await client.query("SELECT set_config('pim.tenant_id', $1, true)", [tenantId]);
			// Fence and sequence in one statement, first in the transaction: it takes the row lock that an
			// unknown-COMMIT resolver later waits on, and it fails when the lease or epoch is not ours.
			const fenced = await q.get<{ seq: number }>(
				`UPDATE rt.partitions SET next_seq = next_seq + 1
				 WHERE partition_id = $1 AND tenant_id = $2 AND owner_id = $3 AND epoch = $4 AND lease_until > clock_timestamp()
				 RETURNING next_seq - 1 AS seq`,
				partitionId,
				tenantId,
				this.#o.ownerId,
				this.#o.epoch,
			);
			if (fenced === undefined) throw new OwnershipLost(partitionId, this.#o.epoch);
			const seq = fenced.seq;
			await this.#checkGlobalIds(q, writes);
			await this.#checkDocumentActions(q, docActions);
			const summary: CommitChange[] = [];
			let maxId = 0;
			for (const write of writes) {
				await this.#applyTableWrite(q, write, seq, summary);
				const id = writeId(write);
				if (id !== undefined && id > maxId) maxId = id;
			}
			await this.#applyDocumentActions(q, docActions, seq, summary);
			// Imported or externally chosen ids move the tenant sequence past them; no row is locked unless one must move.
			if (maxId > 0) await q.run("UPDATE rt.tenant_ids SET next_id = $2 WHERE tenant_id = $1 AND next_id <= $3", tenantId, maxId + 1, maxId);
			await q.run("INSERT INTO rt.commits (partition_id, seq, tenant_id, epoch, token, summary) VALUES ($1, $2, $3, $4, $5, $6)", partitionId, seq, tenantId, this.#o.epoch, token, JSON.stringify(summary));
			await this.#o.faults?.beforeCommit?.(client);
			sent = true;
			await client.query("COMMIT");
			await this.#o.faults?.afterCommit?.();
			this.#o.ids.observe(tenantId, maxId);
			this.#o.onCommitted?.(seq, summary);
			return seq;
		} catch (error) {
			if (sent && !(error instanceof pg.DatabaseError)) {
				// COMMIT was sent and the acknowledgement did not arrive, or a later step lost the connection.
				discard = true;
				throw new AmbiguousCommit("COMMIT outcome unknown", { cause: error });
			}
			if (!sent) {
				try {
					await client.query("ROLLBACK");
				} catch {
					discard = true;
				}
			}
			throw error;
		} finally {
			client.off("error", ignore);
			client.release(discard ? true : undefined);
		}
	}

	/** Called after an unknown COMMIT: waits for the old backend to finish through the family row it locked first, then reads the receipt. */
	async #resolve(token: string): Promise<number> {
		const { pool, tenantId, partitionId } = this.#o;
		let lastError: unknown;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				return await withTenant(
					pool,
					tenantId,
					async (q) => {
						await q.run(`SET LOCAL lock_timeout = ${Math.trunc(this.#o.resolveTimeoutMs ?? 15_000)}`);
						await q.get("SELECT 1 FROM rt.partitions WHERE partition_id = $1 FOR UPDATE", partitionId);
						const receipt = await q.get<{ seq: number }>("SELECT seq FROM rt.commits WHERE partition_id = $1 AND token = $2", partitionId, token);
						if (receipt === undefined) throw new StorageRejected("Commit was not applied");
						return receipt.seq;
					},
				);
			} catch (error) {
				if (error instanceof StorageRejected) throw error;
				lastError = error;
				await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
			}
		}
		// The database cannot be reached, so whether the commit landed is unknown: not a StorageRejected, so pi poisons the Session.
		throw new Error("Commit outcome could not be resolved; reopen the Harness from the database", { cause: lastError });
	}

	async mintId<I>(): Promise<I> {
		this.#assertOpen();
		return (await this.#o.ids.next(this.#o.tenantId)) as I;
	}

	// ---- reads ----------------------------------------------------------------------------------------------

	async #read<T>(fn: (q: Q) => Promise<T>): Promise<T> {
		this.#assertOpen();
		this.#reads++;
		try {
			return await withTenant(this.#o.pool, this.#o.tenantId, fn, { readOnly: true });
		} finally {
			if (--this.#reads === 0 && this.#writes === 0) this.#drained?.();
		}
	}

	async conversation(id: number): Promise<ConversationRecord | undefined> {
		return this.#read(async (q) => this.#conversation(q, id));
	}
	async #conversation(q: Q, id: number): Promise<ConversationRecord | undefined> {
		const row = await q.get<{ record: string }>("SELECT record FROM rt.conversations WHERE partition_id = $1 AND id = $2", this.#o.partitionId, id);
		return row === undefined ? undefined : parseJson(row.record);
	}

	async scanConversations(query: { order?: Order; ownerConversationId?: number; ownerTaskId?: number }, limit: number, cursor?: Cursor) {
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start, "id", 2);
		const clauses = ["partition_id = $1", scan.clause];
		const params: unknown[] = [this.#o.partitionId, scan.param];
		if (query.ownerConversationId !== undefined) clauses.push(`owner_conversation_id = $${params.push(query.ownerConversationId)}`);
		if (query.ownerTaskId !== undefined) clauses.push(`owner_task_id = $${params.push(query.ownerTaskId)}`);
		params.push(limit + 1);
		const rows = await this.#read((q) => q.all<{ record: string }>(`SELECT record FROM rt.conversations WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT $${params.length}`, ...params));
		return page(rows.map((row) => parseJson<ConversationRecord>(row.record)) as any[], limit, start.order);
	}

	entry(a: number, b?: any, c?: any): Promise<any> {
		return this.#read((q) => this.#entry(q, a, b, c));
	}
	async #entry(q: Q, a: number, b: any, c: any) {
		const conversationForm = c !== undefined && typeof b === "number";
		const id = conversationForm ? (b as number) : a;
		if (c !== undefined && !conversationForm) throw new TypeError("Storage.entry() requires an entry ID");
		let conversation: ConversationRecord | undefined;
		if (conversationForm) {
			conversation = await this.#conversation(q, a);
			if (conversation === undefined) throw new Error(`Unknown conversation: ${a}`);
		}
		const row = await q.get<{ record: string; commit_seq: number }>("SELECT record, commit_seq FROM rt.entries WHERE partition_id = $1 AND id = $2", this.#o.partitionId, id);
		if (row === undefined) return undefined;
		const entry = parseJson<EntryRecord>(row.record);
		if (conversation !== undefined) {
			let upper = Number.POSITIVE_INFINITY;
			while (conversation.id !== entry.conversationId) {
				if (conversation.parent === undefined) return undefined;
				upper = Math.min(upper, conversation.parent.at);
				conversation = (await this.#conversation(q, conversation.parent.conversationId))!;
			}
			if (entry.id > upper) return undefined;
		}
		return { entry, commitSeq: row.commit_seq };
	}

	findLatestHeadMarker(conversationId: number, atOrBeforeEntryId?: number): Promise<any> {
		return this.#read(async (q) => {
			let conversation = await this.#conversation(q, conversationId);
			if (conversation === undefined) throw new Error(`Unknown conversation: ${conversationId}`);
			let upper = atOrBeforeEntryId;
			while (true) {
				const row =
					upper === undefined
						? await q.get<{ record: string }>("SELECT record FROM rt.entries WHERE partition_id = $1 AND conversation_id = $2 AND head IS NOT NULL ORDER BY id DESC LIMIT 1", this.#o.partitionId, conversation.id)
						: await q.get<{ record: string }>("SELECT record FROM rt.entries WHERE partition_id = $1 AND conversation_id = $2 AND head IS NOT NULL AND id <= $3 ORDER BY id DESC LIMIT 1", this.#o.partitionId, conversation.id, upper);
				if (row !== undefined) return parseJson(row.record);
				if (conversation.parent === undefined) return undefined;
				upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
				conversation = (await this.#conversation(q, conversation.parent.conversationId))!;
			}
		});
	}

	scanEntries(query: { conversationId: number; order?: Order; minEntryId?: number; maxEntryId?: number }, limit: number, cursor?: Cursor): Promise<any> {
		return this.#read(async (q) => {
			const { order, after } = scanStart(query.order, cursor, "descending");
			const partition = this.#o.partitionId;
			if (order === "ascending") {
				const segments: { conversationId: number; upper: number | undefined }[] = [];
				let conversation = await this.#conversation(q, query.conversationId);
				if (conversation === undefined) throw new Error(`Unknown conversation: ${query.conversationId}`);
				let upper = query.maxEntryId;
				while (true) {
					segments.push({ conversationId: conversation.id, upper });
					if (conversation.parent === undefined) break;
					upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
					if (query.minEntryId !== undefined && upper < query.minEntryId) break;
					conversation = (await this.#conversation(q, conversation.parent.conversationId))!;
				}
				let lower = query.minEntryId;
				if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
				const values: EntryRecord[] = [];
				for (const segment of segments.reverse()) {
					const clauses = ["partition_id = $1", "conversation_id = $2"];
					const params: unknown[] = [partition, segment.conversationId];
					if (lower !== undefined) clauses.push(`id >= $${params.push(lower)}`);
					if (segment.upper !== undefined) clauses.push(`id <= $${params.push(segment.upper)}`);
					params.push(limit + 1 - values.length);
					const rows = await q.all<{ record: string }>(`SELECT record FROM rt.entries WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT $${params.length}`, ...params);
					values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
					if (values.length > limit) break;
				}
				return page(values as any[], limit, "ascending");
			}
			let conversation = await this.#conversation(q, query.conversationId);
			if (conversation === undefined) throw new Error(`Unknown conversation: ${query.conversationId}`);
			let upper = query.maxEntryId;
			if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
			const values: EntryRecord[] = [];
			while (true) {
				const clauses = ["partition_id = $1", "conversation_id = $2"];
				const params: unknown[] = [partition, conversation.id];
				if (query.minEntryId !== undefined) clauses.push(`id >= $${params.push(query.minEntryId)}`);
				if (upper !== undefined) clauses.push(`id <= $${params.push(upper)}`);
				params.push(limit + 1 - values.length);
				const rows = await q.all<{ record: string }>(`SELECT record FROM rt.entries WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT $${params.length}`, ...params);
				values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
				if (values.length > limit || conversation.parent === undefined) break;
				upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
				if (query.minEntryId !== undefined && upper < query.minEntryId) break;
				conversation = (await this.#conversation(q, conversation.parent.conversationId))!;
			}
			return page(values as any[], limit, "descending");
		});
	}

	async task(id: number): Promise<any> {
		const row = await this.#read((q) => q.get<{ record: string }>("SELECT record FROM rt.tasks WHERE partition_id = $1 AND id = $2", this.#o.partitionId, id));
		return row === undefined ? undefined : parseJson<TaskRecord<any, any, any>>(row.record);
	}

	async scanTasks(query: { order?: Order; conversationId?: number; kind?: string; status?: string; abortRequested?: boolean; background?: boolean }, limit: number, cursor?: Cursor): Promise<any> {
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start, "id", 2);
		const clauses = ["partition_id = $1", scan.clause];
		const params: unknown[] = [this.#o.partitionId, scan.param];
		if (query.conversationId !== undefined) clauses.push(`conversation_id = $${params.push(query.conversationId)}`);
		if (query.kind !== undefined) clauses.push(`kind = $${params.push(encodeIndexed(query.kind))}`);
		if (query.status !== undefined) clauses.push(`status = $${params.push(query.status)}`);
		if (query.abortRequested !== undefined) clauses.push(`abort_requested = $${params.push(query.abortRequested)}`);
		if (query.background !== undefined) clauses.push(`background = $${params.push(query.background)}`);
		params.push(limit + 1);
		const rows = await this.#read((q) => q.all<{ record: string }>(`SELECT record FROM rt.tasks WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT $${params.length}`, ...params));
		return page(rows.map((row) => parseJson<{ id: number }>(row.record)), limit, start.order);
	}

	async submission(id: number): Promise<any> {
		const row = await this.#read((q) => q.get<{ record: string }>("SELECT record FROM rt.submissions WHERE partition_id = $1 AND id = $2", this.#o.partitionId, id));
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
	}

	async scanSubmissions(query: { order?: Order; conversationId?: number; status?: string }, limit: number, cursor?: Cursor): Promise<any> {
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start, "id", 2);
		const clauses = ["partition_id = $1", scan.clause];
		const params: unknown[] = [this.#o.partitionId, scan.param];
		if (query.conversationId !== undefined) clauses.push(`conversation_id = $${params.push(query.conversationId)}`);
		if (query.status !== undefined) clauses.push(`status = $${params.push(query.status)}`);
		params.push(limit + 1);
		const rows = await this.#read((q) => q.all<{ record: string }>(`SELECT record FROM rt.submissions WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT $${params.length}`, ...params));
		return page(rows.map((row) => parseJson<{ id: number }>(row.record)), limit, start.order);
	}

	async submissionByRequest(conversationId: number, requestId: string): Promise<any> {
		const row = await this.#read((q) => q.get<{ record: string }>("SELECT record FROM rt.submissions WHERE partition_id = $1 AND conversation_id = $2 AND request_id = $3", this.#o.partitionId, conversationId, encodeIndexed(requestId)));
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
	}

	async findDocument(address: Address, at: "current" | number): Promise<any> {
		const p = addressParts(address);
		const base = [this.#o.partitionId, p.kind, p.scopeKind, p.ownerId, p.family, p.keyValue];
		const row = await this.#read((q) =>
			at === "current"
				? q.get<{ record: string }>(
						`SELECT record FROM rt.documents WHERE partition_id = $1 AND kind = $2 AND scope_kind = $3 AND owner_id = $4 AND family = $5 AND key_value = $6 AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`,
						...base,
					)
				: q.get<{ record: string }>(
						`SELECT record FROM rt.documents WHERE partition_id = $1 AND kind = $2 AND scope_kind = $3 AND owner_id = $4 AND family = $5 AND key_value = $6
						 AND created_at <= $7 AND (retired_at IS NULL OR retired_at > $7) ORDER BY created_at DESC LIMIT 1`,
						...base,
						at,
					),
		);
		return row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
	}

	async document(id: number, at: "current" | number): Promise<any> {
		// The record and revision queries must observe one committed state; one read-only transaction gives that.
		return this.#read((q) => this.#materialize(q, id, at));
	}

	async scanDocuments(query: { scope: Scope; kind?: string; at: "current" | number }, limit: number, cursor?: Cursor): Promise<any> {
		const scope = scopeColumns(query.scope);
		const after = cursor === undefined ? -1 : (cursor as { after?: number }).after;
		if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new TypeError("Invalid storage cursor");
		const clauses = ["partition_id = $1", "scope_kind = $2", "owner_id = $3", "id > $4"];
		const params: unknown[] = [this.#o.partitionId, scope.scopeKind, scope.ownerId, after];
		if (query.kind !== undefined) clauses.push(`kind = $${params.push(encodeIndexed(query.kind))}`);
		if (query.at === "current") clauses.push("retired_at IS NULL");
		else {
			const n = params.push(query.at);
			clauses.push(`created_at <= $${n}`, `(retired_at IS NULL OR retired_at > $${n})`);
		}
		params.push(limit + 1);
		const rows = await this.#read((q) => q.all<{ record: string }>(`SELECT record FROM rt.documents WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT $${params.length}`, ...params));
		return page(rows.map((row) => parseJson<{ id: number }>(row.record)), limit);
	}

	async close(_context?: unknown): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#reads > 0 || this.#writes > 0) await new Promise<void>((resolve) => (this.#drained = resolve));
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("PgStorage is closed");
	}

	// ---- documents ------------------------------------------------------------------------------------------

	async #materialize(q: Q, id: number, at: "current" | number) {
		const row = await q.get<{ record: string }>("SELECT record FROM rt.documents WHERE partition_id = $1 AND id = $2", this.#o.partitionId, id);
		if (row === undefined) return undefined;
		const record = parseJson<DocumentRecord>(row.record);
		if (at !== "current" && isCurrentOnly(record)) throw new Error(`Document ${id} does not retain historical content`);
		if (!isAliveAt(record, at)) return undefined;
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		const base = await q.get<{ seq: number; kind: string; version: number; content: string }>(
			"SELECT seq, kind, version, content FROM rt.document_revisions WHERE tenant_id = $1 AND document_id = $2 AND kind = 'base' AND seq <= $3 ORDER BY seq DESC LIMIT 1",
			this.#o.tenantId,
			id,
			upper,
		);
		if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
		let value = parseJson<any>(base.content);
		const tail = await q.all<{ seq: number; kind: string; version: number; content: string }>(
			"SELECT seq, kind, version, content FROM rt.document_revisions WHERE tenant_id = $1 AND document_id = $2 AND seq > $3 AND seq <= $4 ORDER BY seq",
			this.#o.tenantId,
			id,
			base.seq,
			upper,
		);
		for (const revision of tail) {
			if (revision.kind !== "delta" || revision.version !== base.version) throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			value = apply(value, parseJson(revision.content));
		}
		return { record, version: base.version, value, deltasSinceBase: tail.length };
	}

	#prepareDocumentActions(writes: readonly StorageWrite[]): Map<number, DocAction> {
		const actions = new Map<number, DocAction>();
		for (const write of writes) {
			if (write.type !== "document.create" && write.type !== "document.copy" && write.type !== "document.change" && write.type !== "document.retire") continue;
			const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
			let action = actions.get(id);
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				case "document.create":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) throw new Error(`Document ${id} has more than one content command`);
					action.create = write.record;
					action.content = write.content;
					break;
				case "document.copy":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) throw new Error(`Document ${id} has more than one content command`);
					action.create = write.record;
					action.copy = write.source as any;
					break;
				case "document.change":
					if (action.content !== undefined || action.copy !== undefined) throw new Error(`Document ${id} has more than one content command`);
					action.content = write.content;
					break;
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	async #checkDocumentActions(q: Q, actions: Map<number, DocAction>): Promise<void> {
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id)) throw new StorageRejected(`Document copy ${id} source is changed in the copy batch`);
			const row = await q.get<{ record: string }>("SELECT record FROM rt.documents WHERE partition_id = $1 AND id = $2", this.#o.partitionId, id);
			const existing = row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const previous = await q.get<{ version: number }>("SELECT version FROM rt.document_revisions WHERE tenant_id = $1 AND document_id = $2 ORDER BY seq DESC LIMIT 1", this.#o.tenantId, id);
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version) throw new Error(`Document ${id} version transition requires a base`);
			}
			const record = (action.create ?? existing) as Address;
			const key = addressKey(record);
			let live = liveCounts.get(key);
			if (live === undefined) live = (await this.#currentDocumentId(q, record)) === undefined ? 0 : 1;
			if (action.retire && existing !== undefined) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) if (live > 1) throw new Error("Document address already has a current incarnation");
	}

	async #currentDocumentId(q: Q, address: Address): Promise<number | undefined> {
		const p = addressParts(address);
		const row = await q.get<{ id: number }>(
			"SELECT id FROM rt.documents WHERE partition_id = $1 AND kind = $2 AND scope_kind = $3 AND owner_id = $4 AND family = $5 AND key_value = $6 AND retired_at IS NULL LIMIT 1",
			this.#o.partitionId,
			p.kind,
			p.scopeKind,
			p.ownerId,
			p.family,
			p.keyValue,
		);
		return row?.id;
	}

	async #applyDocumentActions(q: Q, actions: Map<number, DocAction>, seq: number, summary: CommitChange[]): Promise<void> {
		const { tenantId, partitionId } = this.#o;
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy !== undefined) {
				try {
					const stored = await this.#materialize(q, action.copy.id, action.copy.at);
					if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
					const create = action.create;
					const source = stored.record as any;
					if (source.scope.kind !== "conversation" || create.scope.kind !== "conversation" || source.kind !== create.kind || source.key !== create.key || source.history !== create.history || source.fork !== create.fork) {
						throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
					}
					content = { kind: "base", version: stored.version, value: stored.value };
				} catch (error) {
					if (error instanceof StorageRejected) throw error;
					if (error instanceof pg.DatabaseError || (error as Error).message === "PgStorage is closed") throw error;
					throw new StorageRejected(`Document copy ${id} was rejected`, { cause: error });
				}
			}
			let record: any;
			if (action.create !== undefined) {
				record = { ...action.create, createdAt: seq, ...(action.retire ? { retiredAt: seq } : {}) };
				const p = addressParts(record);
				await this.#claimId(q, id, "document");
				await q.run(
					`INSERT INTO rt.documents (tenant_id, partition_id, id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
					tenantId,
					partitionId,
					id,
					p.kind,
					p.family,
					p.keyValue,
					p.scopeKind,
					p.ownerId,
					seq,
					action.retire ? seq : null,
					encodeJson(record),
				);
				summary.push({ t: action.copy ? "document.copy" : "document.create", id });
			} else {
				const row = (await q.get<{ record: string }>("SELECT record FROM rt.documents WHERE partition_id = $1 AND id = $2", partitionId, id))!;
				record = parseJson(row.record);
			}
			if (content !== undefined) {
				if (content.kind === "base" && isCurrentOnly(record)) await q.run("DELETE FROM rt.document_revisions WHERE tenant_id = $1 AND document_id = $2", tenantId, id);
				const encoded = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
				await q.run("INSERT INTO rt.document_revisions (tenant_id, partition_id, document_id, seq, kind, version, content) VALUES ($1, $2, $3, $4, $5, $6, $7)", tenantId, partitionId, id, seq, content.kind, content.version, encoded);
				if (action.create === undefined) summary.push({ t: "document.change", id });
			}
			if (action.retire) {
				if (action.create === undefined) {
					record = { ...record, retiredAt: seq };
					await q.run("UPDATE rt.documents SET retired_at = $3, record = $4 WHERE partition_id = $1 AND id = $2", partitionId, id, seq, encodeJson(record));
				}
				if (isCurrentOnly(record)) await q.run("DELETE FROM rt.document_revisions WHERE tenant_id = $1 AND document_id = $2", tenantId, id);
				summary.push({ t: "document.retire", id });
			}
		}
	}

	// ---- table writes ---------------------------------------------------------------------------------------

	async #checkGlobalIds(q: Q, writes: readonly StorageWrite[]): Promise<void> {
		const claimed = new Map<number, string>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table = document ? "document" : write.type;
			const id = document ? (write as any).record.id : (write as any).value.id;
			const existing = (await q.get<{ record_type: string }>("SELECT record_type FROM rt.record_ids WHERE tenant_id = $1 AND id = $2", this.#o.tenantId, id))?.record_type;
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	async #claimId(q: Q, id: number, type: string): Promise<void> {
		await q.run("INSERT INTO rt.record_ids (tenant_id, id, partition_id, record_type) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", this.#o.tenantId, id, this.#o.partitionId, type);
	}

	async #applyTableWrite(q: Q, write: StorageWrite, seq: number, summary: CommitChange[]): Promise<void> {
		const { tenantId, partitionId } = this.#o;
		switch (write.type) {
			case "conversation": {
				const value = write.value;
				if (value.id === ROOT_CONVERSATION && !this.#o.home) throw new Error("Conversation 1 belongs to the tenant's home partition");
				await this.#claimId(q, value.id, "conversation");
				await q.run("INSERT INTO rt.conversations (tenant_id, partition_id, id, owner_conversation_id, owner_task_id, record) VALUES ($1, $2, $3, $4, $5, $6)", tenantId, partitionId, value.id, value.owner?.conversationId ?? null, value.owner?.taskId ?? null, encodeJson(value));
				// Immutable, and in the transaction that creates the conversation, so the directory can never disagree with storage.
				await q.run("INSERT INTO rt.conversation_directory (tenant_id, conversation_id, partition_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", tenantId, value.id, partitionId);
				summary.push({ t: "conversation", id: value.id });
				break;
			}
			case "entry": {
				const value = write.value;
				await this.#claimId(q, value.id, "entry");
				await q.run("INSERT INTO rt.entries (tenant_id, partition_id, id, conversation_id, head, commit_seq, record) VALUES ($1, $2, $3, $4, $5, $6, $7)", tenantId, partitionId, value.id, value.conversationId, value.head ?? null, seq, encodeJson(value));
				summary.push({ t: "entry", id: value.id, c: value.conversationId });
				break;
			}
			case "task": {
				const value = write.value;
				await this.#claimId(q, value.id, "task");
				await q.run(
					`INSERT INTO rt.tasks (tenant_id, partition_id, id, conversation_id, kind, status, abort_requested, background, record)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
					 ON CONFLICT (tenant_id, id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind, status = excluded.status,
					 abort_requested = excluded.abort_requested, background = excluded.background, record = excluded.record`,
					tenantId,
					partitionId,
					value.id,
					value.conversationId,
					encodeIndexed(value.kind),
					value.state.status,
					value.abortRequested ? true : false,
					value.background ? true : false,
					encodeJson(value),
				);
				summary.push({ t: "task", id: value.id, c: value.conversationId, s: value.state.status });
				break;
			}
			case "submission": {
				const value = write.value;
				await this.#claimId(q, value.id, "submission");
				await q.run(
					`INSERT INTO rt.submissions (tenant_id, partition_id, id, conversation_id, request_id, status, record) VALUES ($1, $2, $3, $4, $5, $6, $7)
					 ON CONFLICT (tenant_id, id) DO UPDATE SET conversation_id = excluded.conversation_id, request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
					tenantId,
					partitionId,
					value.id,
					value.conversationId,
					value.requestId === undefined ? null : encodeIndexed(value.requestId),
					value.status,
					encodeJson(value),
				);
				summary.push({ t: "submission", id: value.id, c: value.conversationId, s: value.status });
				break;
			}
			default:
				break;
		}
	}
}
