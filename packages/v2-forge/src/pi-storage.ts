// A coding `pi` thread's pi-durable 1.1.0 storage on PostgreSQL, in `pim_forge`: apart from every normal agent's partition, so a coding turn is never stepped by (or starves) a normal agent's Runner.
// It is an event-sourced Storage: every commit pi-durable accepts is validated by the in-memory engine, then appended to `forge_pi_commits` under the thread's lease epoch (a worker that lost the lease is refused and writes nothing), and opening replays the log.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { type Row } from "./db";
import { type ForgeStore } from "./store";

type Mem = Storage;

export class PgPiStorage implements Storage {
	private constructor(
		private readonly mem: Mem,
		private readonly store: ForgeStore,
		private readonly threadId: string,
		private readonly epoch: number,
	) {}

	/** Opens the thread's storage at the given lease epoch, replaying every commit it has. */
	static async open(store: ForgeStore, threadId: string, epoch: number): Promise<PgPiStorage> {
		const mem = new MemoryStorage();
		const rows = (await store.db.query<Row>("select writes from pim_forge.forge_pi_commits where thread_id = $1 order by seq", [threadId])).rows;
		for (const r of rows) await mem.commit(r.writes as StorageWrite[], BACKGROUND_CONTEXT);
		return new PgPiStorage(mem, store, threadId, epoch);
	}

	async commit(writes: readonly StorageWrite[], context: Context) {
		// The engine validates first (it rejects a write that conflicts with what is stored), then the log keeps it.
		const seq = await this.mem.commit(writes, context);
		const { threadId } = this;
		await this.store.fenced(threadId, this.epoch, (q) => q.query("insert into pim_forge.forge_pi_commits (thread_id, seq, writes) select $1, coalesce(max(seq), 0) + 1, $2 from pim_forge.forge_pi_commits where thread_id = $1", [threadId, JSON.stringify(writes)]));
		return seq;
	}
	mintId: Storage["mintId"] = () => this.mem.mintId();
	conversation: Storage["conversation"] = (id, c) => this.mem.conversation(id, c);
	scanConversations: Storage["scanConversations"] = (q, l, cur, c) => this.mem.scanConversations(q, l, cur, c);
	entry = ((...args: any[]) => (this.mem.entry as any)(...args)) as Storage["entry"];
	findLatestHeadMarker: Storage["findLatestHeadMarker"] = (id, at, c) => this.mem.findLatestHeadMarker(id, at, c);
	scanEntries: Storage["scanEntries"] = (q, l, cur, c) => this.mem.scanEntries(q, l, cur, c);
	task: Storage["task"] = (id, c) => this.mem.task(id, c);
	scanTasks: Storage["scanTasks"] = (q, l, cur, c) => this.mem.scanTasks(q, l, cur, c);
	submission: Storage["submission"] = (id, c) => this.mem.submission(id, c);
	scanSubmissions: Storage["scanSubmissions"] = (q, l, cur, c) => this.mem.scanSubmissions(q, l, cur, c);
	submissionByRequest: Storage["submissionByRequest"] = (cid, rid, c) => this.mem.submissionByRequest(cid, rid, c);
	findDocument: Storage["findDocument"] = (a, at, c) => this.mem.findDocument(a, at, c);
	document: Storage["document"] = (id, at, c) => this.mem.document(id, at, c);
	scanDocuments: Storage["scanDocuments"] = (q, l, cur, c) => this.mem.scanDocuments(q, l, cur, c);
	close: Storage["close"] = (c) => this.mem.close(c);
}

/** The commits a thread has, for tests and inspection. */
export async function piCommitCount(store: ForgeStore, threadId: string): Promise<number> {
	return Number((await store.db.query<Row>("select count(*) c from pim_forge.forge_pi_commits where thread_id = $1", [threadId])).rows[0]!.c);
}
