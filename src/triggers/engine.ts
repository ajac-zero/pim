/**
 * Time triggers in one space, built only where they are turned on: the
 * store, the coordinator and Pim's host over the space's own database
 * (docs/triggers.md). Every person's own space turns them on as it starts
 * and as they register; a guest's space, or one not yet provisioned, never
 * does, and then nothing is built, no table made and no alarm set.
 * Turning it off again keeps everything it recorded, which the person's
 * export holds either way (`triggerHistory`).
 */

import { API_TABLES } from "./api";
import { COMPUTER_TABLES } from "./computer";
import { COORDINATOR_TABLES, TriggerCoordinator } from "./coordinator";
import { HOST_TABLES, PimTriggerHost, type TriggerSpace, type TriggerTakeover } from "./host";
import { type AuthorizationRequest, type AuthorizationVerdict, TRIGGER_TABLES, TriggerStore } from "./store";
import { SUBSCRIPTION_PRIVATE_COLUMNS, SUBSCRIPTION_TABLES } from "./subscriptions";

/** The method of `Pim` its trigger wake calls. */
export const TRIGGER_TICK_CALLBACK = "runTriggerTick";

/** In the space's meta: its triggers are on. */
export const ENGINE_KEY = "triggers:engine";

/** Runs of a space's triggers that may hold compute at once: below the coordinator's own ceiling, as planned for Pim. */
export const ENGINE_MAX_RUNNING = 2;

/** Every table the engine makes, for what a space still holds and for erasing it. */
export const ENGINE_TABLES = [...TRIGGER_TABLES, ...COORDINATOR_TABLES, ...HOST_TABLES] as const;

export type TriggerEngineOptions = {
	/** The database's transactions (`transactionSync`). */
	readonly transaction: <T>(work: () => T) => T;
	/** The triggers' clock. */
	readonly now: () => number;
	readonly space: TriggerSpace;
	/**
	 * The check of computer sources' grants (./computer.ts), without which no
	 * computer source can be enabled or its occurrence handed on; and what to
	 * tell of each trigger that changes, so the computer hears what it should
	 * run now. Pim gives both in every space. With `authorize`, the
	 * coordinator hands on what the computer saw.
	 */
	readonly authorize?: (request: AuthorizationRequest) => AuthorizationVerdict;
	readonly changed?: (id: string) => void;
	/** How a run reads and what it tells once submitted, for triggers `schedule_task` made and triggers on connectors' events. */
	readonly takeover?: TriggerTakeover;
};

/**
 * Every row of the engine's tables that exist, as stored, for the person's
 * export: whether the engine is on now or not, since turning it off keeps
 * what it recorded. Connector subscriptions' bindings (./subscriptions.ts),
 * which nothing in Pim makes yet, are in it too when their table exists,
 * without their callback key or secret, and so are computer triggers' epochs
 * and grants (./computer.ts), and the API's creation keys (./api.ts),
 * which are digests. What connector events carried (./connector.ts,
 * `ConnectorEventData`) is not in it. Read only: it makes no table, and
 * builds nothing. Null when the space has none of the tables.
 */
export function triggerHistory(sql: SqlStorage): Record<string, Record<string, SqlStorageValue>[]> | null {
	const existing = new Set(
		sql
			.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
			.toArray()
			.map((row) => String(row.name)),
	);
	const tables = [...ENGINE_TABLES, ...SUBSCRIPTION_TABLES, ...COMPUTER_TABLES, ...API_TABLES].filter((table) => existing.has(table));
	if (tables.length === 0) return null;
	return Object.fromEntries(
		tables.map((table) => {
			const rows = sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray();
			if (!(SUBSCRIPTION_TABLES as readonly string[]).includes(table)) return [table, rows];
			return [table, rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !(SUBSCRIPTION_PRIVATE_COLUMNS as readonly string[]).includes(column))))];
		}),
	);
}

export class TriggerEngine {
	readonly store: TriggerStore;
	readonly coordinator: TriggerCoordinator;
	readonly host: PimTriggerHost;
	/** What the host may do in the space. */
	readonly space: TriggerSpace;

	constructor(sql: SqlStorage, options: TriggerEngineOptions) {
		this.space = options.space;
		// Without `authorize`, no computer source can be enabled, and none's occurrence is handed on.
		const computer = options.authorize ? { authorize: options.authorize } : {};
		this.store = new TriggerStore(sql, {
			transaction: options.transaction,
			now: options.now,
			...computer,
			...(options.changed ? { changed: options.changed } : {}),
		});
		this.host = new PimTriggerHost(sql, options.space, Date.now, options.takeover ?? null);
		this.coordinator = new TriggerCoordinator(sql, {
			store: this.store,
			host: this.host,
			transaction: options.transaction,
			now: options.now,
			maxRunning: ENGINE_MAX_RUNNING,
			...(options.authorize ? { computerEvents: true, authorize: options.authorize } : {}),
			connectorEvents: true,
		});
	}

	/** Erases everything the engine recorded, for erasing the space. */
	eraseAll(): void {
		this.store.eraseAll();
		this.coordinator.eraseAll();
		this.host.eraseAll();
	}
}
