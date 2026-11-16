// A coding `pi` thread's own pi-durable partition. It is keyed by thread and fenced by the thread's lease, and it is never one of the normal agents' runner partitions, so a coding turn can't be stepped by (or starve) a normal agent's Runner.
import { type ForgeStore } from "./store";
import { type Row } from "./db";

export class PgPiLog {
	constructor(private readonly store: ForgeStore) {}

	/** Appends one entry under the lease epoch; a stale epoch throws LeaseLostError and writes nothing. */
	async append(threadId: string, epoch: number, entry: object): Promise<number> {
		return this.store.fenced(threadId, epoch, async (q) => {
			const seq = Number((await q.query<Row>("select coalesce(max(seq), 0) + 1 n from pim_forge.forge_pi_entries where thread_id = $1", [threadId])).rows[0]!.n);
			await q.query("insert into pim_forge.forge_pi_entries (thread_id, seq, entry) values ($1,$2,$3)", [threadId, seq, entry]);
			return seq;
		});
	}

	async read(threadId: string): Promise<object[]> {
		return (await this.store.db.query<Row>("select entry from pim_forge.forge_pi_entries where thread_id = $1 order by seq", [threadId])).rows.map((r) => r.entry);
	}
}
