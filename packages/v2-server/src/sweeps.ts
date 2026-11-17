/** The recurring passes of the `maintenance` role that no single service owns. */
import type { App } from "@pim/v2-app/app";
import { forgePartitionId } from "./forge-source.ts";
import type { ObjectStore } from "@pim/v2-contracts/platform";
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
		const timedOut = await app.db.owner(owner, async (tx) => (await tx.query("SELECT id, public_chat_id, args, state FROM pim_app.approvals WHERE state IN ('timed_out_denied', 'timed_out_approved') AND args ? 'taskId' AND public_chat_id IS NOT NULL")).rows);
		for (const a of timedOut) {
			const admitted = await app.conversations.admit({ kind: "user", ownerId: owner as never, role: "member", sessionId: "approval-timeout" }, { commandId: `approval:${a.id}`, kind: "approval_decision", chatId: a.public_chat_id, payload: { taskId: a.args.taskId, approved: a.state === "timed_out_approved", approvalId: a.id, timedOut: true } });
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

/** The schemas besides the application's that hold a person's rows, each sealed to its owner by row-level security. */
const ERASED_SCHEMAS = ["pim_runtime", "pim_projection", "pim_forge"];

/**
 * Erases the accounts their owners (or an admin) deleted. A deleting account is already gone to every surface (410); this removes what it held, in
 * the order that lets a failure be tried again: its objects (images, app files, uploads), its rows in the runtime, the projections and Forge, and last
 * the application's own (`purgeOwner`), which also marks the account `deleted`, so an account that is still `deleting` is one not yet fully erased.
 * Returns the owners finished. Gitea repositories and workspaces Forge made are not reached from here.
 */
export async function sweepErasures(app: App, pool: Pool, objects: ObjectStore, limit = 5): Promise<string[]> {
	const owners = (await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE status = 'deleting' ORDER BY status_changed_at LIMIT $1", [limit])).rows)).map((r) => r.owner_id as string);
	const done: string[] = [];
	for (const owner of owners) {
		const keys = (await app.db.owner(owner, async (tx) => (await tx.query("SELECT key FROM pim_app.objects")).rows)).map((r) => r.key as string);
		for (const key of keys) await objects.delete(key);
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT set_config('pim.owner_id', $1, true)", [owner]);
			const tables = (await client.query("SELECT table_schema, table_name FROM information_schema.columns WHERE column_name = 'owner_id' AND table_schema = ANY($1)", [ERASED_SCHEMAS])).rows.map((r) => `${r.table_schema}.${r.table_name}`);
			// Rows refer to one another: a table that a foreign key still holds is tried again after the others.
			for (let pending = tables, pass = 0; pending.length && pass < 6; pass++) {
				const next: string[] = [];
				for (const table of pending) {
					await client.query("SAVEPOINT erase");
					try {
						await client.query(`DELETE FROM ${table} WHERE owner_id = $1`, [owner]);
						await client.query("RELEASE SAVEPOINT erase");
					} catch (error) {
						if ((error as { code?: string }).code !== "23503") throw error;
						await client.query("ROLLBACK TO SAVEPOINT erase");
						next.push(table);
					}
				}
				pending = next;
				if (pass === 5 && next.length) throw new Error(`Could not erase ${next.join(", ")}`);
			}
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			console.error("erasure", owner, error);
			continue;
		} finally {
			client.release();
		}
		await app.identity.purgeOwner(owner);
		done.push(owner);
	}
	return done;
}

/**
 * Fires the schedules that are due, owner by owner. `schedule_wakeups` holds each owner's next moment, so an owner with nothing due costs nothing.
 * A failing owner does not hold up the others. Returns how many schedules fired.
 */
export async function tickSchedules(app: App, now = new Date()): Promise<number> {
	let fired = 0;
	for (const owner of await app.schedules.dueOwners(now)) {
		try {
			fired += (await app.schedules.tick(owner, now)).fired;
		} catch (error) {
			console.error("schedule tick", owner, error);
		}
	}
	return fired;
}

/**
 * Fires the time triggers that are due, for each owner who has one switched on. Which owners those are is read across owners (`pim.scope = 'all'`,
 * migration 0623); what fires, and when, is the owner's own. Returns how many triggers fired.
 */
export async function tickTriggers(app: App, pool: Pool, now = new Date()): Promise<number> {
	const client = await pool.connect();
	let owners: string[];
	try {
		await client.query("BEGIN");
		await client.query("SELECT set_config('pim.scope', 'all', true)");
		owners = (await client.query("SELECT DISTINCT owner_id FROM pim_app.triggers WHERE lifecycle = 'enabled' AND source = 'time'")).rows.map((r) => r.owner_id as string);
		await client.query("COMMIT");
	} finally {
		client.release();
	}
	let fired = 0;
	for (const owner of owners) {
		try {
			fired += (await app.triggers.tickTime(owner, now)).fired;
		} catch (error) {
			console.error("trigger tick", owner, error);
		}
	}
	return fired;
}
