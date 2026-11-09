import type { AdmissionConditions, CodingScheduler } from "./scheduler";

/**
 * How many coding workspaces a space may hold at once unless it is
 * configured otherwise. A provider with no manager of its own, such as
 * Cloudflare Sandbox, has only this cap, set through `setLimit`.
 */
export const DEFAULT_SPACE_CAP = 2;

/** Below this percentage of free disk the workspace manager refuses new workspaces with `low_disk`, so the queue waits instead. */
export const LOW_DISK_PCT = 15;

/** What the workspace manager's `GET /health` reports of the machine that runs workspaces. */
export type ManagerHealth = {
	/** NaN when the manager couldn't read its disk. */
	readonly freeDiskPct: number;
	readonly maxConcurrent: number;
	readonly running: number;
	readonly free: number;
};

/** What `ProviderCapacity` changes of a scheduler; a Durable Object's `CodingScheduler` has it. */
export type CapacityTarget = Pick<CodingScheduler, "conditions" | "setConditions" | "setLimit">;

/**
 * Keeps a space's scheduler in line with the workspace manager: its disk and
 * how many workspaces it runs at once. It only maps what the manager says to
 * the scheduler's conditions and limit; whoever reads `/health` or gets the
 * manager's refusal calls it.
 */
export class ProviderCapacity {
	readonly #target: CapacityTarget;
	readonly #spaceCap: number;

	constructor(target: CapacityTarget, spaceCap = DEFAULT_SPACE_CAP) {
		this.#target = target;
		this.#spaceCap = spaceCap;
	}

	/**
	 * Holds the queue while the manager's disk is under 15% free (or it
	 * couldn't read it), and sets the limit to the space's cap or the
	 * manager's, whichever is lower. The budget cap is left as it was.
	 * Whichever change holds the queue goes first, so nobody is admitted in
	 * between whom the two together wouldn't admit. Returns the threads
	 * admitted.
	 */
	refreshConditions(health: ManagerHealth): string[] {
		const conditions = conditionsFromHealth(health, this.#target.conditions());
		const limit = Math.min(this.#spaceCap, health.maxConcurrent);
		if (conditions.lowDisk || conditions.budgetCapped) return [...this.#target.setConditions(conditions), ...this.#target.setLimit(limit)];
		return [...this.#target.setLimit(limit), ...this.#target.setConditions(conditions)];
	}

	/**
	 * Takes in a refusal from the manager: `low_disk` holds the queue until
	 * the next health check says the disk has room; `capacity` changes
	 * nothing, since the thread already waits in the queue for a slot. Returns
	 * the threads admitted, which is always none.
	 */
	onManagerError(code: string): string[] {
		if (code !== "low_disk") return [];
		return this.#target.setConditions({ lowDisk: true, budgetCapped: this.#target.conditions().budgetCapped });
	}
}

/**
 * The conditions the manager's health means, from the current ones: the
 * disk's say whether it is low, with how much is free as the detail, and
 * the budget cap stays. Once the disk has room again its detail goes, as
 * while the disk was low the detail was the disk's.
 */
export function conditionsFromHealth(health: ManagerHealth, current: AdmissionConditions): AdmissionConditions {
	// NaN fails the comparison, so a disk the manager couldn't read counts as low: it would refuse the workspace anyway.
	const lowDisk = !(health.freeDiskPct >= LOW_DISK_PCT);
	if (lowDisk) {
		const detail = Number.isFinite(health.freeDiskPct) ? `${health.freeDiskPct}% of the disk free` : "the disk's free space is unknown";
		return { lowDisk, budgetCapped: current.budgetCapped, detail };
	}
	const detail = current.lowDisk ? undefined : current.detail;
	return detail === undefined ? { lowDisk, budgetCapped: current.budgetCapped } : { lowDisk, budgetCapped: current.budgetCapped, detail };
}
