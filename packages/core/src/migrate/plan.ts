import type { BundleReader } from "./format.ts";

/** One conversation family: conversations joined by fork ancestry and owner edges. The unit of storage, mutation line and owner. */
export interface Family {
	/** Smallest conversation id in it; names the family's partition. */
	key: number;
	conversations: Set<number>;
	home: boolean;
}

export interface TenantPlan {
	tenantId: string;
	families: Family[];
	/** conversation id -> index in `families` */
	familyOf: Map<number, number>;
	maxId: number;
	maxSeq: number;
	violations: string[];
	counts: Record<string, number>;
}

class UnionFind {
	readonly parent = new Map<number, number>();
	find(x: number): number {
		if (!this.parent.has(x)) this.parent.set(x, x);
		let root = x;
		while (this.parent.get(root) !== root) root = this.parent.get(root)!;
		while (this.parent.get(x) !== root) {
			const next = this.parent.get(x)!;
			this.parent.set(x, root);
			x = next;
		}
		return root;
	}
	union(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
	}
}

/**
 * Splits a tenant's single storage into conversation families and checks the closure invariants that make the split
 * safe. Anything that crosses a family fails closed: a violation list, no import. This is the check the audit calls A6.6.
 */
export async function planTenant(bundle: BundleReader, tenantId: string): Promise<TenantPlan> {
	const base = `tenants/${tenantId}/pi`;
	const violations: string[] = [];
	const uf = new UnionFind();
	const conversations = await bundle.all<{ id: number; owner_conversation_id: number | null; owner_task_id: number | null; record: string }>(`${base}/conversations.ndjson`);
	const known = new Set(conversations.map((c) => c.id));
	const taskConversation = new Map<number, number>();
	let maxId = 0;
	let maxSeq = 0;
	const counts: Record<string, number> = { conversations: conversations.length };
	for (const c of conversations) {
		maxId = Math.max(maxId, c.id);
		uf.find(c.id);
		const record = JSON.parse(c.record) as { parent?: { conversationId: number; at: number }; owner?: { conversationId?: number; taskId?: number } };
		if (record.parent) {
			if (!known.has(record.parent.conversationId)) violations.push(`conversation ${c.id}: parent ${record.parent.conversationId} does not exist`);
			else uf.union(c.id, record.parent.conversationId);
		}
		if (c.owner_conversation_id !== null) {
			if (!known.has(c.owner_conversation_id)) violations.push(`conversation ${c.id}: owner conversation ${c.owner_conversation_id} does not exist`);
			else uf.union(c.id, c.owner_conversation_id);
		}
	}
	const tasks = await bundle.all<{ id: number; conversation_id: number; kind: string; status: string; record: string }>(`${base}/tasks.ndjson`);
	counts.tasks = tasks.length;
	for (const t of tasks) {
		maxId = Math.max(maxId, t.id);
		taskConversation.set(t.id, t.conversation_id);
		if (!known.has(t.conversation_id)) violations.push(`task ${t.id}: conversation ${t.conversation_id} does not exist`);
	}
	for (const c of conversations) {
		if (c.owner_task_id !== null) {
			const owner = taskConversation.get(c.owner_task_id);
			if (owner === undefined) violations.push(`conversation ${c.id}: owner task ${c.owner_task_id} does not exist`);
			else uf.union(c.id, owner);
		}
	}
	const entryConversation = new Map<number, number>();
	counts.entries = 0;
	for await (const e of bundle.ndjson<{ id: number; conversation_id: number; head: number | null; commit_seq: number; record: string }>(`${base}/entries.ndjson`)) {
		counts.entries++;
		maxId = Math.max(maxId, e.id);
		maxSeq = Math.max(maxSeq, e.commit_seq);
		entryConversation.set(e.id, e.conversation_id);
		if (!known.has(e.conversation_id)) violations.push(`entry ${e.id}: conversation ${e.conversation_id} does not exist`);
	}
	const sameFamily = (a: number, b: number) => uf.find(a) === uf.find(b);
	// Cross-references that must stay inside a family: a head marker, context edits and a tool task's assistant entry.
	for await (const e of bundle.ndjson<{ id: number; conversation_id: number; head: number | null; record: string }>(`${base}/entries.ndjson`)) {
		if (e.head !== null) {
			const home = entryConversation.get(e.head);
			if (home === undefined || !sameFamily(home, e.conversation_id)) violations.push(`entry ${e.id}: head ${e.head} is outside its family`);
		}
		if (e.record.includes('"edits"')) {
			for (const edit of (JSON.parse(e.record) as { edits?: { target: number }[] }).edits ?? []) {
				const home = entryConversation.get(edit.target);
				if (home === undefined || !sameFamily(home, e.conversation_id)) violations.push(`entry ${e.id}: edit target ${edit.target} is outside its family`);
			}
		}
	}
	for (const t of tasks) {
		// The kind column holds the JSON-encoded string, exactly as the storage writes it.
		if (JSON.parse(t.kind) !== "pi.tool") continue;
		const input = (JSON.parse(t.record) as { input?: { assistant?: number } }).input;
		if (input?.assistant !== undefined) {
			const home = entryConversation.get(input.assistant);
			if (home === undefined || !sameFamily(home, t.conversation_id)) violations.push(`task ${t.id}: assistant entry ${input.assistant} is outside its family`);
		}
	}
	const submissions = await bundle.all<{ id: number; conversation_id: number }>(`${base}/submissions.ndjson`);
	counts.submissions = submissions.length;
	for (const s of submissions) {
		maxId = Math.max(maxId, s.id);
		if (!known.has(s.conversation_id)) violations.push(`submission ${s.id}: conversation ${s.conversation_id} does not exist`);
	}
	const documents = await bundle.all<{ id: number; scope_kind: string; owner_id: number; created_at: number; retired_at: number | null }>(`${base}/documents.ndjson`);
	counts.documents = documents.length;
	for (const d of documents) {
		maxId = Math.max(maxId, d.id);
		maxSeq = Math.max(maxSeq, d.created_at, d.retired_at ?? 0);
		if (d.scope_kind === "conversation" && !known.has(d.owner_id)) violations.push(`document ${d.id}: scope conversation ${d.owner_id} does not exist`);
		if (d.scope_kind === "task" && !taskConversation.has(d.owner_id)) violations.push(`document ${d.id}: scope task ${d.owner_id} does not exist`);
	}
	counts.document_revisions = 0;
	for await (const r of bundle.ndjson<{ seq: number }>(`${base}/document_revisions.ndjson`)) {
		counts.document_revisions++;
		maxSeq = Math.max(maxSeq, r.seq);
	}
	// Every id is unique across record types in the source already; the check makes the claim explicit for the target.
	const seen = new Map<number, string>();
	const claim = (id: number, type: string) => {
		const prior = seen.get(id);
		if (prior !== undefined && !(prior === type && (type === "task" || type === "submission"))) violations.push(`id ${id} is both ${prior} and ${type}`);
		seen.set(id, type);
	};
	for (const c of conversations) claim(c.id, "conversation");
	for (const t of tasks) claim(t.id, "task");
	for (const s of submissions) claim(s.id, "submission");
	for (const d of documents) claim(d.id, "document");
	for (const id of entryConversation.keys()) claim(id, "entry");

	// Families, home first. Conversation 1 is the home family's root; a tenant with no conversation 1 gets an empty home.
	const groups = new Map<number, Set<number>>();
	for (const c of conversations) {
		const root = uf.find(c.id);
		(groups.get(root) ?? groups.set(root, new Set()).get(root)!).add(c.id);
	}
	const families: Family[] = [...groups.entries()].sort(([a], [b]) => a - b).map(([key, set]) => ({ key, conversations: set, home: set.has(1) }));
	if (!families.some((f) => f.home)) families.unshift({ key: 0, conversations: new Set(), home: true });
	const familyOf = new Map<number, number>();
	families.forEach((family, index) => family.conversations.forEach((id) => familyOf.set(id, index)));
	return { tenantId, families, familyOf, maxId, maxSeq, violations, counts };
}
