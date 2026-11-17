/** The recurring passes of the `maintenance` role that no single service owns. */
import type { App } from "@pim/v2-app/app";
import { forgePartitionId } from "./forge-source.ts";
import type { Pool } from "pg";

/**
 * Applies approval timeouts and carries each one to the runtime like a person's decision. An approval that times out is denied (or, by its own policy, approved), and
 * the parked task it names is woken with that outcome, so a timeout never leaves a task parked forever. The command id is the approval's, as an explicit decision's is: a
 * decision and a timeout racing deliver one command. Returns how many timeouts were delivered.
 */
export async function sweepApprovals(app: App, pool: Pool, now = new Date()): Promise<number> {
	const client = await pool.connect();
	let owners: string[];
	try {
		await client.query("BEGIN");
		await client.query("SELECT set_config('pim.scope', 'all', true)");
		owners = (await client.query("SELECT DISTINCT owner_id FROM pim_app.approvals WHERE state = 'waiting' AND expires_at IS NOT NULL AND expires_at <= $1", [now])).rows.map((r) => r.owner_id as string);
		await client.query("COMMIT");
	} finally {
		client.release();
	}
	let delivered = 0;
	for (const owner of owners) {
		await app.approvals.sweep(owner, now);
		const timedOut = await app.db.owner(owner, async (tx) => (await tx.query("SELECT id, public_chat_id, args, state FROM pim_app.approvals WHERE state IN ('timed_out_denied', 'timed_out_approved') AND args ? 'taskId' AND (public_chat_id IS NOT NULL OR args ? 'guestChat')")).rows);
		for (const a of timedOut) {
			// A guest's approval parks a task in the guest's own space, so its timeout is delivered there.
			const guest = a.args.guestOwner as string | undefined;
			const admitted = await app.conversations.admit({ kind: "user", ownerId: (guest ?? owner) as never, role: guest ? "guest" : "member", sessionId: "approval-timeout" }, { commandId: `approval:${a.id}`, kind: "approval_decision", chatId: guest ? a.args.guestChat : a.public_chat_id, payload: { taskId: a.args.taskId, approved: a.state === "timed_out_approved", approvalId: a.id, timedOut: true } });
			if (!admitted.duplicate) delivered++;
		}
	}
	return delivered;
}

/**
 * Keeps Forge's outbox bounded. A `projection` row goes once Live has projected past it (Live's watermark for the owner's Forge stream); a `wake` or `cost_ledger` row goes
 * once delivered and older than `retainMs`. What was trimmed is still in `forge_events` and the thread rows, which are what a Forge projection rebuild reads from then on.
 */
export async function trimForgeOutbox(pool: Pool, retainMs = 7 * 86_400_000): Promise<number> {
	let removed = 0;
	const owners = (await pool.query("SELECT owner_id FROM pim_forge.forge_outbox_counters")).rows.map((r) => r.owner_id as string);
	for (const owner of owners) {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT set_config('pim.owner_id', $1, true)", [owner]);
			const mark = Number((await client.query("SELECT projected_seq FROM pim_projection.projection_watermarks WHERE partition_id = $1 AND projection_version = 1", [forgePartitionId(owner)])).rows[0]?.projected_seq ?? 0);
			const r = await client.query(
				"DELETE FROM pim_forge.forge_outbox WHERE owner_id = $1 AND ((topic = 'projection' AND owner_seq <= $2) OR (topic IN ('wake', 'cost_ledger') AND delivered_at IS NOT NULL AND delivered_at < now() - ($3 || ' milliseconds')::interval))",
				[owner, mark, String(retainMs)],
			);
			removed += r.rowCount ?? 0;
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}
	return removed;
}
