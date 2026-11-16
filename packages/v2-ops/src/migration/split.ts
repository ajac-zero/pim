import { type DoDump, type Row, rowsOf } from "./snapshot.ts";

export const HOME_PARTITION = "home";

export type PiRows = {
	readonly conversations: readonly Row[];
	readonly entries: readonly Row[];
	readonly tasks: readonly Row[];
	readonly submissions: readonly Row[];
	readonly documents: readonly Row[];
	readonly revisions: readonly Row[];
	readonly nextId: bigint;
};

export type Split = {
	/** partition id by conversation id; the root conversation (1) is in the home partition. */
	readonly partitionOf: ReadonlyMap<number, string>;
	/** partition id by document id. */
	readonly documentPartition: ReadonlyMap<number, string>;
	readonly partitions: readonly string[];
	/** Highest commit sequence of an entry or document revision in each partition, so each continues above it. */
	readonly maxSeq: ReadonlyMap<string, number>;
};

export function readPi(dump: DoDump): PiRows {
	const meta = rowsOf(dump, "pi_durable_metadata")[0];
	return {
		conversations: rowsOf(dump, "pi_conversations"),
		entries: rowsOf(dump, "pi_entries"),
		tasks: rowsOf(dump, "pi_tasks"),
		submissions: rowsOf(dump, "pi_submissions"),
		documents: rowsOf(dump, "pi_documents"),
		revisions: rowsOf(dump, "pi_document_revisions"),
		nextId: BigInt(String(meta?.next_id ?? "2")),
	};
}

const record = (row: Row) => JSON.parse(String(row.record)) as { parent?: { conversationId: number; at: number } };

/**
 * Splits one tenant's single pi storage into conversation families: the smallest groups closed under fork ancestry and
 * task-owner edges. Conversation 1 and everything attached to it stays in the home partition; a plain chat, a continuation,
 * a delegated task's conversation, a trigger chat each start a family of their own. Ids are not renumbered.
 */
export function splitFamilies(pi: PiRows): Split {
	const parent = new Map<number, number>();
	const find = (x: number): number => {
		let root = x;
		while ((parent.get(root) ?? root) !== root) root = parent.get(root)!;
		parent.set(x, root);
		return root;
	};
	const union = (a: number, b: number) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
	};
	const ids = new Set(pi.conversations.map((row) => Number(row.id)));
	for (const id of ids) parent.set(id, id);
	for (const row of pi.conversations) {
		const id = Number(row.id);
		const from = record(row).parent?.conversationId;
		if (from !== undefined) {
			if (!ids.has(from)) throw new Error(`Conversation ${id} forks conversation ${from}, which is not in the storage`);
			union(id, from);
		}
		if (row.owner_conversation_id !== null) union(id, Number(row.owner_conversation_id));
	}
	const homeRoot = ids.has(1) ? find(1) : undefined;
	const partitionOf = new Map<number, string>();
	for (const id of [...ids].sort((a, b) => a - b)) {
		const root = find(id);
		partitionOf.set(id, root === homeRoot ? HOME_PARTITION : `fam-${root}`);
	}
	const taskConversation = new Map(pi.tasks.map((row) => [Number(row.id), Number(row.conversation_id)]));
	const documentPartition = new Map<number, string>();
	for (const row of pi.documents) {
		const owner = Number(row.owner_id);
		const conversation = row.scope_kind === "conversation" ? owner : row.scope_kind === "task" ? taskConversation.get(owner) : undefined;
		const partition = conversation === undefined ? HOME_PARTITION : partitionOf.get(conversation);
		if (partition === undefined) throw new Error(`Document ${row.id} belongs to conversation ${conversation}, which is not in the storage`);
		documentPartition.set(Number(row.id), partition);
	}
	const maxSeq = new Map<string, number>();
	const bump = (partition: string, seq: number) => maxSeq.set(partition, Math.max(maxSeq.get(partition) ?? 0, seq));
	for (const row of pi.entries) {
		const partition = partitionOf.get(Number(row.conversation_id));
		if (partition === undefined) throw new Error(`Entry ${row.id} belongs to unknown conversation ${row.conversation_id}`);
		bump(partition, Number(row.commit_seq));
	}
	for (const row of pi.revisions) bump(documentPartition.get(Number(row.document_id)) ?? HOME_PARTITION, Number(row.seq));
	return { partitionOf, documentPartition, partitions: [...new Set(partitionOf.values())].sort(), maxSeq };
}

/** The entries a conversation shows, oldest first: each ancestor's entries up to the fork point (inclusive), then its own. */
export function visibleEntryIds(conversation: number, conversations: ReadonlyMap<number, { parent?: { conversationId: number; at: number } }>, entriesOf: (conversation: number) => readonly number[]): number[] {
	const chain: { id: number; upTo: number }[] = [];
	let current = conversation;
	let upTo = Number.POSITIVE_INFINITY;
	for (;;) {
		chain.unshift({ id: current, upTo });
		const parent = conversations.get(current)?.parent;
		if (!parent) break;
		upTo = parent.at;
		current = parent.conversationId;
	}
	return chain.flatMap(({ id, upTo: limit }) => entriesOf(id).filter((entry) => entry <= limit));
}
