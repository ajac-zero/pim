import type { HarnessInspection, TaskInspection } from "@earendil-works/pi-durable";

export type Assessment = {
	/** True when a Runner must keep the partition: something runs, is ready to run, or waits on something that does. */
	readonly needsOwner: boolean;
	/** The earliest time (ms since epoch) a parked partition must be reactivated for a retry, poll or sleep; undefined when only an outside signal can wake it. */
	readonly nextDueAt: number | undefined;
	readonly reasons: readonly string[];
};

/** The time a task's checkpoint says it sleeps until: a generation retry (`until`), a deferred poll (`pollAt`), a compaction retry. */
export function sleepUntil(checkpoint: unknown): number | undefined {
	if (typeof checkpoint !== "object" || checkpoint === null) return undefined;
	const record = checkpoint as Record<string, unknown>;
	const times = [record.until, record.pollAt, record.wakeAt].filter((v): v is number => typeof v === "number" && v > 0);
	return times.length === 0 ? undefined : Math.min(...times);
}

/** The due times `LiveDoc` publishes for one conversation: a retry's `at` and a deferred response's `pollAt`. */
export function liveDueTimes(live: { generation?: { retry?: { at: number }; deferred?: { pollAt: number } }; compactions?: readonly { retry?: { at: number } }[] } | undefined): number[] {
	const times: number[] = [];
	const generation = live?.generation;
	if (generation?.retry !== undefined && generation.retry.at > 0) times.push(generation.retry.at);
	if (generation?.deferred !== undefined && generation.deferred.pollAt > 0) times.push(generation.deferred.pollAt);
	for (const compaction of live?.compactions ?? []) if (compaction.retry !== undefined && compaction.retry.at > 0) times.push(compaction.retry.at);
	return times;
}

/**
 * Decide from pi's own report whether a partition needs a process. pi 1.1.0 has no wake callback, so the host derives
 * it: a task that is running, ready or completing needs an owner unless it sleeps until a time at least `longWaitMs`
 * away, which becomes a due time; a suspended or blocked task needs none (a signal wakes it); a waiting task is parked
 * when everything it waits on is. A queued input needs an owner unless a parked run of its conversation holds it.
 */
export function assessInspection(inspection: HarnessInspection, now: number, options: { longWaitMs: number; liveDue?: readonly number[] }): Assessment {
	const tasks = new Map<number, TaskInspection>(inspection.tasks.map((t) => [t.record.id, t]));
	const reasons: string[] = [];
	const due: number[] = [...(options.liveDue ?? [])];
	const memo = new Map<number, boolean>();
	const parked = (task: TaskInspection): boolean => {
		const known = memo.get(task.record.id);
		if (known !== undefined) return known;
		memo.set(task.record.id, false);
		let result: boolean;
		switch (task.state.kind) {
			case "suspended":
			case "blocked":
				result = true;
				break;
			case "waiting":
				result = task.state.on.length > 0 && task.state.on.every((id) => {
					const child = tasks.get(id);
					return child !== undefined && parked(child);
				});
				break;
			default: {
				const at = task.state.kind === "sleeping" ? task.state.until : task.state.kind === "completing" ? undefined : sleepUntil(task.record.state.checkpoint);
				result = at !== undefined && at - now >= options.longWaitMs;
				if (result && at !== undefined) due.push(at);
			}
		}
		if (!result) reasons.push(`task ${task.record.id} (${task.record.kind}) is ${task.state.kind}`);
		memo.set(task.record.id, result);
		return result;
	};
	let needsOwner = false;
	for (const task of inspection.tasks) if (!parked(task)) needsOwner = true;
	const live = new Map<number, boolean>();
	for (const task of inspection.tasks) live.set(task.record.conversationId, (live.get(task.record.conversationId) ?? true) && (memo.get(task.record.id) ?? false));
	for (const submission of inspection.submissions) {
		if (submission.status !== "queued") continue;
		// A queued input waits behind a run; only a parked run lets the partition sleep.
		if (live.get(submission.conversationId) !== true) {
			needsOwner = true;
			reasons.push(`submission ${submission.id} is queued`);
		}
	}
	const future = due.filter((at) => at > 0);
	return { needsOwner, nextDueAt: needsOwner || future.length === 0 ? undefined : Math.min(...future), reasons };
}
