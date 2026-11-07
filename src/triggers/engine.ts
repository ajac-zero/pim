/**
 * Time triggers in one space, built only where they are turned on: the
 * store, the coordinator and Pim's host over the space's own database
 * (docs/triggers.md). Nothing is built, no table made and no alarm set
 * unless the deployment allows it (`PIM_TRIGGERS_ENGINE` set to
 * `internal`, which no deployment sets) and the space was opted in, which
 * only internal code does: there is no route, tool or setting for it.
 * Turning it off again keeps everything it recorded, which the person's
 * export holds either way (`triggerHistory`).
 */

import { COORDINATOR_TABLES, TriggerCoordinator } from "./coordinator";
import { HOST_TABLES, PimTriggerHost, type TriggerSpace } from "./host";
import { TRIGGER_TABLES, TriggerStore } from "./store";

/** The method of `Pim` its trigger wake calls. */
export const TRIGGER_TICK_CALLBACK = "runTriggerTick";

/** The deployment's gate: unset, or anything but `internal`, and no space can be opted in. */
export const ENGINE_VARIABLE = "PIM_TRIGGERS_ENGINE";

/** The space's own opt-in, in its meta. */
export const ENGINE_KEY = "triggers:engine";

/** Runs of a space's triggers that may hold compute at once: below the coordinator's own ceiling, as planned for Pim. */
export const ENGINE_MAX_RUNNING = 2;

/** Every table the engine makes, for what a space still holds and for erasing it. */
export const ENGINE_TABLES = [...TRIGGER_TABLES, ...COORDINATOR_TABLES, ...HOST_TABLES] as const;

/** Whether this deployment lets a space be opted in. */
export function engineAllowed(env: unknown): boolean {
	return (env as Record<string, unknown> | null)?.[ENGINE_VARIABLE] === "internal";
}

export type TriggerEngineOptions = {
	/** The database's transactions (`transactionSync`). */
	readonly transaction: <T>(work: () => T) => T;
	/** The triggers' clock. */
	readonly now: () => number;
	readonly space: TriggerSpace;
};

/**
 * Every row of the engine's tables that exist, as stored, for the person's
 * export: whether the engine is on now or not, since turning it off keeps
 * what it recorded. Read only: it makes no table, and builds nothing. Null
 * when the space has none of the tables.
 */
export function triggerHistory(sql: SqlStorage): Record<string, Record<string, SqlStorageValue>[]> | null {
	const existing = new Set(
		sql
			.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
			.toArray()
			.map((row) => String(row.name)),
	);
	const tables = ENGINE_TABLES.filter((table) => existing.has(table));
	if (tables.length === 0) return null;
	return Object.fromEntries(tables.map((table) => [table, sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray()]));
}

export class TriggerEngine {
	readonly store: TriggerStore;
	readonly coordinator: TriggerCoordinator;
	readonly host: PimTriggerHost;
	/** What the host may do in the space. */
	readonly space: TriggerSpace;

	constructor(sql: SqlStorage, options: TriggerEngineOptions) {
		this.space = options.space;
		// No `authorize`: no computer source can be enabled until grants are checked here.
		this.store = new TriggerStore(sql, { transaction: options.transaction, now: options.now });
		this.host = new PimTriggerHost(sql, options.space);
		this.coordinator = new TriggerCoordinator(sql, {
			store: this.store,
			host: this.host,
			transaction: options.transaction,
			now: options.now,
			maxRunning: ENGINE_MAX_RUNNING,
		});
	}

	/** Erases everything the engine recorded, for erasing the space. */
	eraseAll(): void {
		this.store.eraseAll();
		this.coordinator.eraseAll();
		this.host.eraseAll();
	}
}
