import type { ConversationRecord, DocumentRecord, EntryRecord, SubmissionRecord, TaskRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { createHash } from "node:crypto";
import { type Db, SCHEMA } from "./db.ts";
import { ident } from "./storage.ts";

const S = SCHEMA;
const CHUNK = 500;

type AnyTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

/** One owner's single legacy pi-durable storage (a space's SQLite `pi_*` tables), read into memory. */
export type LegacySpace = {
	conversations: ConversationRecord[];
	entries: { record: EntryRecord; commitSeq: number }[];
	tasks: AnyTask[];
	submissions: SubmissionRecord[];
	documents: {
		record: DocumentRecord;
		revisions: { seq: number; kind: "base" | "delta"; version: number; content: unknown }[];
	}[];
	/** `durable_metadata`: the next id and the next commit sequence the legacy storage would have used. */
	metadata: { nextId: number; nextSeq: number };
};

/** The partition each record belongs to, and why the split is what it is. */
export type FamilyPlan = {
	/** conversation id → partition id. */
	partitionOf: Map<number, string>;
	/** Partition ids with their conversations, the home partition first. */
	families: { partitionId: string; home: boolean; conversations: number[] }[];
	/** Partition of each task, submission and document id. */
	taskPartition: Map<number, string>;
};

/** Read the pi `durable_*` tables of a legacy SQLite file or an open `node:sqlite` database. */
export async function readLegacySqlite(source: string | { prepare(sql: string): { all(...params: unknown[]): unknown[] } }): Promise<LegacySpace> {
	let database: { prepare(sql: string): { all(...params: unknown[]): unknown[] }; close?: () => void };
	if (typeof source === "string") {
		const { DatabaseSync } = await import("node:sqlite");
		database = new DatabaseSync(source, { readOnly: true });
	} else {
		database = source;
	}
	try {
		const all = <T>(sql: string): T[] => database.prepare(sql).all() as T[];
		const parse = <T>(text: string): T => JSON.parse(text) as T;
		const meta = all<{ next_id: string; next_seq: number }>("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1")[0];
		if (meta === undefined) throw new Error("The legacy storage has no durable_metadata row");
		const revisions = new Map<number, LegacySpace["documents"][number]["revisions"]>();
		for (const row of all<{ document_id: number; seq: number; kind: "base" | "delta"; version: number; content: string }>("SELECT document_id, seq, kind, version, content FROM document_revisions ORDER BY document_id, seq")) {
			const list = revisions.get(row.document_id) ?? [];
			list.push({ seq: row.seq, kind: row.kind, version: row.version, content: parse(row.content) });
			revisions.set(row.document_id, list);
		}
		return {
			conversations: all<{ record: string }>("SELECT record FROM conversations ORDER BY id").map((r) => parse(r.record)),
			entries: all<{ record: string; commit_seq: number }>("SELECT record, commit_seq FROM entries ORDER BY id").map((r) => ({ record: parse(r.record), commitSeq: r.commit_seq })),
			tasks: all<{ record: string }>("SELECT record FROM tasks ORDER BY id").map((r) => parse(r.record)),
			submissions: all<{ record: string }>("SELECT record FROM submissions ORDER BY id").map((r) => parse(r.record)),
			documents: all<{ id: number; record: string }>("SELECT id, record FROM documents ORDER BY id").map((r) => ({ record: parse(r.record), revisions: revisions.get(r.id) ?? [] })),
			metadata: { nextId: Number(meta.next_id), nextSeq: meta.next_seq },
		};
	} finally {
		database.close?.();
	}
}

class UnionFind {
	readonly #parent = new Map<number, number>();
	add(id: number): void {
		if (!this.#parent.has(id)) this.#parent.set(id, id);
	}
	find(id: number): number {
		let root = id;
		while (this.#parent.get(root) !== root) root = this.#parent.get(root) as number;
		let node = id;
		while (node !== root) {
			const next = this.#parent.get(node) as number;
			this.#parent.set(node, root);
			node = next;
		}
		return root;
	}
	union(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		// The smaller id is the root, so a component is named by its oldest conversation.
		if (ra !== rb) this.#parent.set(Math.max(ra, rb), Math.min(ra, rb));
	}
}

/**
 * The partition a family gets: a UUID derived from the owner and the family's oldest conversation, so importing again
 * names the same partitions. The family of conversation 1 is the home partition.
 */
export function familyPartitionId(ownerId: string, oldestConversationId: number): string {
	const bytes = createHash("sha1").update(`pim-runtime-family:${ownerId}:${oldestConversationId}`).digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5 layout
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Compute the conversation families of a legacy space: connected components over fork parents and owner edges. Fails
 * closed when a record names a conversation, entry or task in another component, because that would mean a family
 * cannot be a partition.
 */
export function planFamilies(space: LegacySpace, ownerId: string): FamilyPlan {
	const uf = new UnionFind();
	const conversations = new Map<number, ConversationRecord>();
	for (const c of space.conversations) {
		conversations.set(c.id, c);
		uf.add(c.id);
	}
	const tasks = new Map<number, AnyTask>(space.tasks.map((t) => [t.id, t]));
	const conversationOf = (what: string, id: number): number => {
		if (!conversations.has(id)) throw new Error(`${what} names conversation ${id}, which does not exist`);
		return id;
	};
	for (const c of space.conversations) {
		if (c.parent !== undefined) uf.union(c.id, conversationOf(`Conversation ${c.id}'s parent`, c.parent.conversationId));
		if (c.owner !== undefined) {
			uf.union(c.id, conversationOf(`Conversation ${c.id}'s owner`, c.owner.conversationId));
			const ownerTask = tasks.get(c.owner.taskId);
			if (ownerTask === undefined) throw new Error(`Conversation ${c.id} is owned by task ${c.owner.taskId}, which does not exist`);
			uf.union(c.id, ownerTask.conversationId);
		}
	}
	const rootOf = (id: number): number => uf.find(id);
	const partitionForRoot = (root: number): string => familyPartitionId(ownerId, root);
	const sameFamily = (what: string, a: number, b: number): void => {
		if (rootOf(a) !== rootOf(b)) throw new Error(`${what} crosses conversation families (${a} and ${b})`);
	};
	for (const t of space.tasks) {
		conversationOf(`Task ${t.id}`, t.conversationId);
		if (t.owner !== undefined) {
			const owner = tasks.get(t.owner);
			if (owner === undefined) throw new Error(`Task ${t.id} is owned by task ${t.owner}, which does not exist`);
			sameFamily(`Task ${t.id}'s owner`, t.conversationId, owner.conversationId);
		}
	}
	for (const s of space.submissions) conversationOf(`Submission ${s.id}`, s.conversationId);
	const entryConversation = new Map<number, number>(space.entries.map((e) => [e.record.id, e.record.conversationId]));
	for (const { record: e } of space.entries) {
		conversationOf(`Entry ${e.id}`, e.conversationId);
		if (e.head !== undefined && e.head !== e.id) {
			const home = entryConversation.get(e.head);
			if (home === undefined) throw new Error(`Entry ${e.id}'s head ${e.head} does not exist`);
			sameFamily(`Entry ${e.id}'s head`, e.conversationId, home);
		}
		for (const edit of e.edits ?? []) {
			const home = entryConversation.get(edit.target);
			if (home === undefined) throw new Error(`Entry ${e.id} edits entry ${edit.target}, which does not exist`);
			sameFamily(`Entry ${e.id}'s edit`, e.conversationId, home);
		}
	}
	for (const t of space.tasks) {
		const assistant = (t.input as { assistant?: unknown } | null)?.assistant;
		if (typeof assistant === "number") {
			const home = entryConversation.get(assistant);
			if (home !== undefined) sameFamily(`Task ${t.id}'s assistant entry`, t.conversationId, home);
		}
	}
	// Members of each family, then the home family first.
	const members = new Map<number, number[]>();
	for (const id of conversations.keys()) {
		const root = rootOf(id);
		const list = members.get(root) ?? [];
		list.push(id);
		members.set(root, list);
	}
	const partitionOf = new Map<number, string>();
	const families: FamilyPlan["families"] = [];
	for (const root of [...members.keys()].sort((a, b) => a - b)) {
		const ids = (members.get(root) as number[]).sort((a, b) => a - b);
		const partitionId = partitionForRoot(root);
		families.push({ partitionId, home: root === 1, conversations: ids });
		for (const id of ids) partitionOf.set(id, partitionId);
	}
	if (!families.some((f) => f.home)) families.unshift({ partitionId: familyPartitionId(ownerId, 1), home: true, conversations: [] });
	families.sort((a, b) => Number(b.home) - Number(a.home));
	const taskPartition = new Map<number, string>(space.tasks.map((t) => [t.id, partitionOf.get(t.conversationId) as string]));
	for (const d of space.documents) {
		const scope = d.record.scope;
		if (scope.kind === "conversation") conversationOf(`Document ${d.record.id}`, scope.conversationId);
		if (scope.kind === "task" && !tasks.has(scope.taskId)) throw new Error(`Document ${d.record.id} belongs to task ${scope.taskId}, which does not exist`);
	}
	return { partitionOf, families, taskPartition };
}

export type ImportReport = {
	ownerId: string;
	partitions: { partitionId: string; home: boolean; conversations: number; entries: number; tasks: number; submissions: number; documents: number; needsOwner: boolean }[];
	highWater: number;
	nextSeq: number;
};

const LIVE = new Set(["pending", "running", "waiting", "completing"]);

/**
 * Split a legacy single-storage space into one partition per conversation family and write it, in one transaction,
 * with every numeric id, `asOf` ancestry, document revision and commit Seq unchanged. Session-scope documents go to the
 * home partition. The owner's id sequence is seeded above every id and above the legacy `next_id`, so ids minted later
 * cannot collide with imported ones. Refuses a owner that already has partitions.
 */
export async function importLegacySpace(db: Db, ownerId: string, space: LegacySpace, options: { publicChatIds?: ReadonlyMap<number, string> } = {}): Promise<ImportReport> {
	const plan = planFamilies(space, ownerId);
	return db.transaction(ownerId, async (client) => {
		const existing = await client.query(`SELECT 1 FROM ${S}.partitions WHERE owner_id = $1 LIMIT 1`, [ownerId]);
		if (existing.rowCount !== 0) throw new Error(`Owner ${ownerId} already has partitions; an import needs an empty owner`);
		const maxSeq = Math.max(0, ...space.entries.map((e) => e.commitSeq), ...space.documents.flatMap((d) => [d.record.createdAt, d.record.retiredAt ?? 0, ...d.revisions.map((r) => r.seq)]));
		const nextSeq = Math.max(space.metadata.nextSeq, maxSeq + 1);
		const maxId = Math.max(1, ...space.conversations.map((c) => c.id), ...space.entries.map((e) => e.record.id), ...space.tasks.map((t) => t.id), ...space.submissions.map((s) => s.id), ...space.documents.map((d) => d.record.id));
		const highWater = Math.max(maxId, space.metadata.nextId - 1);
		if (!Number.isSafeInteger(highWater)) throw new Error("The legacy id space does not fit in a safe integer");

		const report: ImportReport = { ownerId, partitions: [], highWater, nextSeq };
		const byPartition = new Map(plan.families.map((f) => [f.partitionId, { entries: 0, tasks: 0, submissions: 0, documents: 0, live: false }]));
		const home = plan.families.find((f) => f.home)?.partitionId as string;
		for (const family of plan.families) {
			await client.query(`INSERT INTO ${S}.partitions (owner_id, partition_id, kind, next_seq) VALUES ($1, $2, $3, $4)`, [ownerId, family.partitionId, family.home ? "home" : "family", nextSeq]);
		}
		const ids: { id: number; kind: string; partition: string }[] = [];
		const stats = (partition: string) => byPartition.get(partition) as { entries: number; tasks: number; submissions: number; documents: number; live: boolean };

		const conversations = space.conversations.map((c) => ({ c, p: plan.partitionOf.get(c.id) as string }));
		const entries = space.entries.map((e) => ({ e, p: plan.partitionOf.get(e.record.conversationId) as string }));
		const tasks = space.tasks.map((t) => ({ t, p: plan.taskPartition.get(t.id) as string }));
		const submissions = space.submissions.map((s) => ({ s, p: plan.partitionOf.get(s.conversationId) as string }));
		const documents = space.documents.map((d) => {
			const scope = d.record.scope;
			const p = scope.kind === "session" ? home : scope.kind === "conversation" ? (plan.partitionOf.get(scope.conversationId) as string) : (plan.taskPartition.get(scope.taskId) as string);
			return { d, p };
		});
		for (const { c, p } of conversations) ids.push({ id: c.id, kind: "conversation", partition: p });
		for (const { e, p } of entries) {
			ids.push({ id: e.record.id, kind: "entry", partition: p });
			stats(p).entries++;
		}
		for (const { t, p } of tasks) {
			ids.push({ id: t.id, kind: "task", partition: p });
			stats(p).tasks++;
			if (LIVE.has(t.state.status)) stats(p).live = true;
		}
		for (const { s, p } of submissions) {
			ids.push({ id: s.id, kind: "submission", partition: p });
			stats(p).submissions++;
			if (s.status === "queued") stats(p).live = true;
		}
		for (const { d, p } of documents) {
			ids.push({ id: d.record.id, kind: "document", partition: p });
			stats(p).documents++;
		}

		await each(ids, (chunk) =>
			client.query(`INSERT INTO ${S}.record_ids (owner_id, id, kind, partition_id) SELECT $1, x.id, x.kind, x.p::uuid FROM unnest($2::bigint[], $3::text[], $4::text[]) AS x(id, kind, p)`, [ownerId, chunk.map((r) => r.id), chunk.map((r) => r.kind), chunk.map((r) => r.partition)]),
		);
		await each(conversations, async (chunk) => {
			await client.query(
				`INSERT INTO ${S}.conversations (owner_id, partition_id, id, parent_conversation_id, parent_at, owner_conversation_id, owner_task_id, record)
				 SELECT $1, x.p::uuid, x.id, x.pc, x.pa, x.oc, x.ot, x.r FROM unnest($2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::text[]) AS x(p, id, pc, pa, oc, ot, r)`,
				[ownerId, chunk.map((x) => x.p), chunk.map((x) => x.c.id), chunk.map((x) => x.c.parent?.conversationId ?? null), chunk.map((x) => x.c.parent?.at ?? null), chunk.map((x) => x.c.owner?.conversationId ?? null), chunk.map((x) => x.c.owner?.taskId ?? null), chunk.map((x) => JSON.stringify(x.c))],
			);
			await client.query(`INSERT INTO ${S}.conversation_partitions (owner_id, conversation_id, partition_id, public_chat_id) SELECT $1, x.id, x.p::uuid, coalesce(x.pc::uuid, gen_random_uuid()) FROM unnest($2::bigint[], $3::text[], $4::text[]) AS x(id, p, pc)`, [ownerId, chunk.map((x) => x.c.id), chunk.map((x) => x.p), chunk.map((x) => options.publicChatIds?.get(x.c.id) ?? null)]);
		});
		await each(entries, (chunk) =>
			client.query(
				`INSERT INTO ${S}.entries (owner_id, partition_id, id, conversation_id, head, commit_seq, record)
				 SELECT $1, x.p::uuid, x.id, x.cid, x.h, x.s, x.r FROM unnest($2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[], $7::text[]) AS x(p, id, cid, h, s, r)`,
				[ownerId, chunk.map((x) => x.p), chunk.map((x) => x.e.record.id), chunk.map((x) => x.e.record.conversationId), chunk.map((x) => x.e.record.head ?? null), chunk.map((x) => x.e.commitSeq), chunk.map((x) => JSON.stringify(x.e.record))],
			),
		);
		await each(tasks, (chunk) =>
			client.query(
				`INSERT INTO ${S}.tasks (owner_id, partition_id, id, conversation_id, kind, status, outcome_status, abort_requested, background, record)
				 SELECT $1, x.p::uuid, x.id, x.cid, x.kind, x.status, x.outcome, x.abort, x.bg, x.r FROM unnest($2::text[], $3::bigint[], $4::bigint[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::boolean[], $10::text[]) AS x(p, id, cid, kind, status, outcome, abort, bg, r)`,
				[ownerId, chunk.map((x) => x.p), chunk.map((x) => x.t.id), chunk.map((x) => x.t.conversationId), chunk.map((x) => ident(x.t.kind)), chunk.map((x) => x.t.state.status), chunk.map((x) => x.t.state.outcome?.status ?? null), chunk.map((x) => x.t.abortRequested), chunk.map((x) => x.t.background), chunk.map((x) => JSON.stringify(x.t))],
			),
		);
		await each(submissions, (chunk) =>
			client.query(
				`INSERT INTO ${S}.submissions (owner_id, partition_id, id, conversation_id, status, request_id, record)
				 SELECT $1, x.p::uuid, x.id, x.cid, x.status, x.req, x.r FROM unnest($2::text[], $3::bigint[], $4::bigint[], $5::text[], $6::text[], $7::text[]) AS x(p, id, cid, status, req, r)`,
				[ownerId, chunk.map((x) => x.p), chunk.map((x) => x.s.id), chunk.map((x) => x.s.conversationId), chunk.map((x) => x.s.status), chunk.map((x) => (x.s.requestId === undefined ? null : ident(x.s.requestId))), chunk.map((x) => JSON.stringify(x.s))],
			),
		);
		for (const { d, p } of documents) {
			const { createdAt, retiredAt, ...record } = d.record as DocumentRecord & { history?: string; fork?: string };
			const scope = d.record.scope;
			await client.query(
				`INSERT INTO ${S}.documents (owner_id, partition_id, id, kind, doc_key, scope_kind, scope_id, history, fork, created_at, retired_at, record) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
				[
					ownerId,
					p,
					d.record.id,
					ident(d.record.kind),
					d.record.key === undefined ? null : ident(d.record.key),
					scope.kind,
					scope.kind === "conversation" ? scope.conversationId : scope.kind === "task" ? scope.taskId : null,
					(record as { history?: string }).history ?? null,
					(record as { fork?: string }).fork ?? null,
					createdAt,
					retiredAt ?? null,
					JSON.stringify(record),
				],
			);
			if (d.revisions.length > 0) {
				await each(d.revisions, (chunk) =>
					client.query(
						`INSERT INTO ${S}.document_revisions (owner_id, partition_id, document_id, seq, kind, version, content) SELECT $1, $2, $3, x.* FROM unnest($4::bigint[], $5::text[], $6::int[], $7::text[]) AS x`,
						[ownerId, p, d.record.id, chunk.map((r) => r.seq), chunk.map((r) => r.kind), chunk.map((r) => r.version), chunk.map((r) => JSON.stringify(r.content))],
					),
				);
			}
		}
		await client.query(
			`INSERT INTO ${S}.owner_id_allocators AS a (owner_id, high_water) VALUES ($1, $2) ON CONFLICT (owner_id) DO UPDATE SET high_water = greatest(a.high_water, $2)`,
			[ownerId, highWater],
		);
		for (const family of plan.families) {
			const s = stats(family.partitionId);
			// A partition with unfinished work needs a Runner; the others wait for a signal.
			await client.query(`INSERT INTO ${S}.due_work (owner_id, partition_id, state, reason) VALUES ($1, $2, $3, 'imported')`, [ownerId, family.partitionId, s.live || family.home ? "needs_owner" : "quiescent"]);
			report.partitions.push({ partitionId: family.partitionId, home: family.home, conversations: family.conversations.length, entries: s.entries, tasks: s.tasks, submissions: s.submissions, documents: s.documents, needsOwner: s.live || family.home });
		}
		return report;
	});
}

async function each<T>(items: readonly T[], run: (chunk: T[]) => Promise<unknown>): Promise<void> {
	for (let i = 0; i < items.length; i += CHUNK) await run(items.slice(i, i + CHUNK));
}

