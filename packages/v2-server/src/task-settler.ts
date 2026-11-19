/**
 * Ends the tasks agents hand each other, as v1 did when a task's run settled (`#taskSettled` in `src/space/conversations.ts`). A task is one agent working in a chat of its own on the
 * message that handed it out; when the run of that message ends, the task is over: its answer is what the agent sent while working on it (the application keeps those, `Conversations.taskSaid`),
 * or, when the run ended without an answer, the task failed. An agent that handed out tasks of its own while working on one answers its task only after those come back, so a run that
 * ended with some still at work does not end it yet; their update starts the run that does (`Conversations.deliverBatch`).
 *
 * A task is found across owners by the Runner with `pim_app.tasks_open` (migration 0691) and its run's outcome read from the runtime's own table of submissions, so nothing is added to
 * the turn. Every Runner may run this: ending a task twice does nothing.
 *
 * A `delegate` call that waits is woken by the application once its tasks are all done. When that call was stopped meanwhile (its pi task is over), nothing can be woken, and the batch
 * is found here and its answers go to the chat as an update, as v1 did when its call ended without them.
 */
import type pg from "pg";
import type { App } from "@pim/v2-app/app";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";

export type SettlerOptions = {
	pool: pg.Pool;
	db: RuntimeDb;
	app: App;
	pollMs?: number;
	onError?: (error: unknown) => void;
};

type Open = { owner_id: string; task_id: string; task_chat: string; wake_request: string; waits_on_tasks: boolean };

/** The words a person or an agent reads for why a run ended without an answer: what pi says, kept short. */
const reasonOf = (record: string): string => {
	try {
		const reason = (JSON.parse(record) as { reason?: unknown }).reason;
		return typeof reason === "string" && reason ? reason.slice(0, 200) : "unanswered";
	} catch {
		return "unanswered";
	}
};

/** One pass: the tasks whose run has settled are ended, and the calls waiting for tasks that can no longer be woken are told. */
export async function settleTasks(o: SettlerOptions): Promise<void> {
	const open = (await o.pool.query<Open>("SELECT * FROM pim_app.tasks_open($1)", [200])).rows;
	for (const task of open) {
		try {
			const submission = (await o.db.read<{ status: string; record: string }>(task.owner_id, "SELECT s.status, s.record FROM pim_runtime.conversation_partitions c JOIN pim_runtime.submissions s ON s.owner_id = c.owner_id AND s.conversation_id = c.conversation_id WHERE c.owner_id = $1 AND c.public_chat_id = $2 AND s.request_id = $3", [task.owner_id, task.task_chat, `w:${task.wake_request}`])).rows[0];
			if (!submission || (submission.status !== "done" && submission.status !== "unanswered")) continue;
			if (submission.status === "done") {
				if (task.waits_on_tasks) continue;
				await o.app.conversations.settleTask(task.owner_id, task.task_id);
			} else await o.app.conversations.settleTask(task.owner_id, task.task_id, reasonOf(submission.record));
		} catch (error) {
			o.onError?.(error);
		}
	}
	const waiting = (await o.pool.query<{ owner_id: string; batch: string; waiter_task: string }>("SELECT * FROM pim_app.task_waits_open($1)", [100])).rows;
	for (const call of waiting) {
		try {
			const over = (await o.db.read<{ status: string }>(call.owner_id, "SELECT status FROM pim_runtime.tasks WHERE owner_id = $1 AND id = $2", [call.owner_id, call.waiter_task])).rows[0];
			if (over?.status === "terminal") await o.app.conversations.stopWaiting(call.owner_id, call.batch);
		} catch (error) {
			o.onError?.(error);
		}
	}
}

export function startTaskSettler(o: SettlerOptions): { stop(): Promise<void> } {
	let stopped = false;
	let active: Promise<void> | undefined;
	const timer = setInterval(() => {
		if (!active && !stopped) active = settleTasks(o).catch((error) => o.onError?.(error)).finally(() => (active = undefined)) as Promise<void>;
	}, o.pollMs ?? 1_000);
	return {
		async stop() {
			stopped = true;
			clearInterval(timer);
			await active;
		},
	};
}
