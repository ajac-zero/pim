import type { Usage as ModelUsage } from "@earendil-works/pi-ai";
import PRICES from "../config/model-prices.json";

/**
 * One row for every model call, written when the call settles, and the
 * daily rollup of those rows: who spends, by agent, chat, run kind and
 * model. Prices are in config/model-prices.json; a call is priced when it
 * is recorded, and keeps the version of the table that priced it.
 *
 * Recording never throws into the model call: a failure is logged and the
 * call goes on unrecorded.
 */

export type RunKind = "interactive" | "scheduled" | "trigger" | "delegated" | "coding_thread" | "background";

/** What a call is attributed to; whatever is unknown is null. */
export type RunTags = {
	readonly agentId?: string | null;
	readonly chatId?: string | null;
	readonly runKind?: RunKind | null;
	readonly codingThreadId?: string | null;
	readonly scheduleOrTriggerId?: string | null;
	readonly parentRunId?: string | null;
};

export type PriceEntry = {
	readonly input: number;
	readonly output: number;
	readonly cache_read: number;
	readonly cache_write_5m: number | null;
	readonly cache_write_1h: number | null;
	readonly estimated?: boolean;
	readonly cache_write_1h_estimated?: boolean;
};

export type PriceTable = { readonly version: string; readonly effectiveFrom: string; readonly models: Readonly<Record<string, PriceEntry>> };

export const PRICE_TABLE: PriceTable = PRICES;

/** Ids compared loosely: case, a gateway prefix (`anthropic/`, `@cf/`), a `:tag`, a date or `-latest` suffix, and `.`/`-`/`_` in version numbers don't matter. */
const canonical = (id: string) =>
	id
		.toLowerCase()
		.slice(id.lastIndexOf("/") + 1)
		.replace(/:[^:]*$/, "")
		.replace(/-(latest|\d{8}|\d{4}-\d{2}-\d{2})$/, "")
		.replace(/[._]/g, "-");

/** The price of a model by the id Pim sees it under: exactly, or by its normalised id (see `canonical`). */
export function priceOf(model: string, table: PriceTable = PRICE_TABLE): PriceEntry | undefined {
	const exact = table.models[model] ?? table.models[model.slice(model.lastIndexOf("/") + 1)];
	if (exact) return exact;
	const want = canonical(model);
	for (const [id, price] of Object.entries(table.models)) if (canonical(id) === want) return price;
	return undefined;
}

/** The tokens of one call by billing tier: `cacheWrite` of pi-ai's usage holds the 1h writes too, which are billed apart. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };

export function tokensOf(usage: ModelUsage | undefined): Tokens {
	const count = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
	const cacheWrite = count(usage?.cacheWrite);
	const cacheWrite1h = Math.min(count(usage?.cacheWrite1h), cacheWrite);
	return { input: count(usage?.input), output: count(usage?.output), cacheRead: count(usage?.cacheRead), cacheWrite5m: cacheWrite - cacheWrite1h, cacheWrite1h };
}

/** Dollars for `tokens` at `price`; null without one. A tier the price table doesn't price costs nothing. */
export function costOf(tokens: Tokens, price: PriceEntry | undefined): number | null {
	if (!price) return null;
	return (
		(tokens.input * price.input +
			tokens.output * price.output +
			tokens.cacheRead * price.cache_read +
			tokens.cacheWrite5m * (price.cache_write_5m ?? 0) +
			tokens.cacheWrite1h * (price.cache_write_1h ?? 0)) /
		1_000_000
	);
}

/** What the model was asked, for the call's size columns: JSON characters, as an approximation of bytes. */
export type RequestShape = { readonly promptBytes: number; readonly toolCount: number; readonly toolSchemaBytes: number; readonly turnIndex: number };

export function shapeOf(context: unknown): RequestShape {
	const { systemPrompt, messages, tools } = (context ?? {}) as { systemPrompt?: unknown; messages?: unknown; tools?: unknown };
	const size = (value: unknown) => (value === undefined ? 0 : (JSON.stringify(value) ?? "").length);
	const list = Array.isArray(messages) ? messages : [];
	return {
		promptBytes: size(systemPrompt) + size(list),
		toolCount: Array.isArray(tools) ? tools.length : 0,
		toolSchemaBytes: size(tools),
		// Assistant turns already in the context: how deep into the conversation the call is.
		turnIndex: list.filter((message) => (message as { role?: unknown } | null)?.role === "assistant").length,
	};
}

export type ModelCall = {
	readonly ts: number;
	readonly tags: RunTags;
	readonly provider: string;
	readonly model: string;
	readonly usage: ModelUsage | undefined;
	readonly stopReason: string;
	readonly latencyMs: number;
	readonly shape: RequestShape | undefined;
	/** The call ran on a subscription (the ChatGPT plan), which bills nothing per call. A custom endpoint is not one: it is priced by model id. */
	readonly plan: boolean;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_model_calls (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	agent_id TEXT,
	chat_id TEXT,
	run_kind TEXT,
	coding_thread_id TEXT,
	schedule_or_trigger_id TEXT,
	parent_run_id TEXT,
	turn_index INTEGER,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	input INTEGER NOT NULL,
	output INTEGER NOT NULL,
	cache_read INTEGER NOT NULL,
	cache_write_5m INTEGER NOT NULL,
	cache_write_1h INTEGER NOT NULL,
	stop_reason TEXT,
	latency_ms INTEGER,
	prompt_bytes INTEGER,
	tool_count INTEGER,
	tool_schema_bytes INTEGER,
	cost_usd REAL,
	price_version TEXT,
	plan INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pim_model_calls_by_ts ON pim_model_calls (ts);
CREATE TABLE IF NOT EXISTS pim_usage_daily (
	day TEXT NOT NULL,
	agent_id TEXT,
	model TEXT NOT NULL,
	run_kind TEXT,
	chat_id TEXT,
	calls INTEGER NOT NULL,
	errors INTEGER NOT NULL,
	input INTEGER NOT NULL,
	output INTEGER NOT NULL,
	cache_read INTEGER NOT NULL,
	cache_write_5m INTEGER NOT NULL,
	cache_write_1h INTEGER NOT NULL,
	cost_usd REAL,
	unpriced_calls INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pim_usage_daily_by_day ON pim_usage_daily (day);
CREATE TABLE IF NOT EXISTS pim_usage_rollup (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	rolled_at INTEGER NOT NULL
);
`;

/** Days the calls themselves are kept, and the days of the rollups. */
export const RAW_KEEP_DAYS = 90;
export const DAILY_KEEP_DAYS = 400;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

/** The calls in a time range, summed the way the rollup keeps them. */
const AGGREGATE = `
	SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, agent_id, model, run_kind, chat_id,
		COUNT(*) AS calls,
		SUM(stop_reason IN ('error', 'aborted')) AS errors,
		SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
		SUM(cache_write_5m) AS cache_write_5m, SUM(cache_write_1h) AS cache_write_1h,
		SUM(cost_usd) AS cost_usd,
		SUM(cost_usd IS NULL AND plan = 0) AS unpriced_calls
	FROM pim_model_calls WHERE ts >= ? AND ts < ?
	GROUP BY day, agent_id, model, run_kind, chat_id`;

const COLUMNS = "day, agent_id, model, run_kind, chat_id, calls, errors, input, output, cache_read, cache_write_5m, cache_write_1h, cost_usd, unpriced_calls";

type DailyRow = {
	day: string;
	agent_id: string | null;
	model: string;
	run_kind: string | null;
	chat_id: string | null;
	calls: number;
	errors: number;
	input: number;
	output: number;
	cache_read: number;
	cache_write_5m: number;
	cache_write_1h: number;
	cost_usd: number | null;
	unpriced_calls: number;
};

export type Spend = { readonly key: string | null; readonly costUsd: number };

export type CostReport = {
	readonly days: number;
	readonly since: string;
	readonly priceVersion: string;
	readonly totalCostUsd: number;
	/** Calls on a model with no price (the person's own plans aside), whose cost is unknown and counted in none of the dollars. */
	readonly unpricedCalls: number;
	readonly calls: number;
	readonly errors: number;
	/** Dollars per 1,000 output tokens; null when nothing was output. */
	readonly costPer1kOutputTokens: number | null;
	/** cache_read / (input + cache_read + cache_write), over the whole period; null without tokens. */
	readonly cacheHitRatio: number | null;
	readonly byDay: readonly {
		readonly day: string;
		readonly costUsd: number;
		readonly calls: number;
		readonly cacheHitRatio: number | null;
		readonly byAgent: readonly Spend[];
		readonly byModel: readonly Spend[];
		readonly byRunKind: readonly Spend[];
	}[];
	/** The chats that cost the most, from the calls themselves, which are kept 90 days; `turns` is the most assistant turns any call had before it. */
	readonly topChats: readonly TopSpender[];
	readonly topCodingThreads: readonly TopSpender[];
};

export type TopSpender = { readonly id: string; readonly costUsd: number; readonly calls: number; readonly turns: number; readonly avgPromptBytes: number };

const ratio = (read: number, input: number, write: number) => (input + read + write > 0 ? read / (input + read + write) : null);

type Summed = "cost_usd" | "calls" | "errors" | "input" | "output" | "cache_read" | "cache_write_5m" | "cache_write_1h" | "unpriced_calls";

export class ModelCallLedger {
	readonly #sql: SqlStorage;
	readonly #prices: PriceTable;
	/** Whether calls were recorded since the last rollup: when the rollup is due. */
	#dirty: boolean;

	constructor(options: { sql: SqlStorage; prices?: PriceTable }) {
		this.#sql = options.sql;
		this.#prices = options.prices ?? PRICE_TABLE;
		this.#sql.exec(SCHEMA);
		this.#dirty = this.#unrolled();
	}

	/** Records a settled call, and says whether it made a rollup due that wasn't. Never throws. */
	record(call: ModelCall): boolean {
		try {
			const tokens = tokensOf(call.usage);
			const price = call.plan ? undefined : priceOf(call.model, this.#prices);
			const cost = costOf(tokens, price);
			const { tags, shape } = call;
			this.#sql.exec(
				`INSERT INTO pim_model_calls (ts, agent_id, chat_id, run_kind, coding_thread_id, schedule_or_trigger_id, parent_run_id, turn_index, provider, model,
					input, output, cache_read, cache_write_5m, cache_write_1h, stop_reason, latency_ms, prompt_bytes, tool_count, tool_schema_bytes, cost_usd, price_version, plan)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				call.ts,
				tags.agentId ?? null,
				tags.chatId ?? null,
				tags.runKind ?? null,
				tags.codingThreadId ?? null,
				tags.scheduleOrTriggerId ?? null,
				tags.parentRunId ?? null,
				shape?.turnIndex ?? null,
				call.provider,
				call.model,
				tokens.input,
				tokens.output,
				tokens.cacheRead,
				tokens.cacheWrite5m,
				tokens.cacheWrite1h,
				call.stopReason,
				Math.max(0, Math.round(call.latencyMs)),
				shape?.promptBytes ?? null,
				shape?.toolCount ?? null,
				shape?.toolSchemaBytes ?? null,
				cost,
				price ? this.#prices.version : null,
				call.plan ? 1 : 0,
			);
			// One structured line per call, so what was priced (and what was not, and why) can be read from the logs.
			console.log(
				JSON.stringify({ event: "pim.model_call", provider: call.provider, model: call.model, plan: call.plan, input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite5m + tokens.cacheWrite1h, costUsd: cost, priceVersion: price ? this.#prices.version : null, stop: call.stopReason }),
			);
			const wasDirty = this.#dirty;
			this.#dirty = true;
			return !wasDirty;
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.model_call_record_failed", error: String(error).slice(0, 500) }));
			return false;
		}
	}

	#rolledAt(): number | undefined {
		const row = this.#sql.exec("SELECT rolled_at FROM pim_usage_rollup WHERE id = 1").toArray()[0];
		return row ? Number(row.rolled_at) : undefined;
	}

	#unrolled(): boolean {
		return this.#sql.exec("SELECT 1 FROM pim_model_calls WHERE ts >= ? LIMIT 1", this.#rolledAt() ?? 0).toArray().length > 0;
	}

	/** When the next rollup is due, the top of the next hour, or null when nothing was recorded since the last. */
	nextRollupAt(now: number): number | null {
		return this.#dirty ? Math.floor(now / HOUR) * HOUR + HOUR : null;
	}

	/**
	 * Recomputes from the calls every day they were recorded on since the last
	 * rollup, replacing what the rollup had for those days, so running it again
	 * changes nothing; then drops what is past its retention. A day whose calls
	 * are all gone keeps its rollup.
	 */
	rollup(now: number): void {
		const first = this.#rolledAt() ?? Number(this.#sql.exec("SELECT MIN(ts) AS ts FROM pim_model_calls").toArray()[0]?.ts ?? now);
		for (let start = dayStart(utcDay(first)); start <= now; start += DAY) {
			if (this.#sql.exec("SELECT 1 FROM pim_model_calls WHERE ts >= ? AND ts < ? LIMIT 1", start, start + DAY).toArray().length === 0) continue;
			this.#sql.exec("DELETE FROM pim_usage_daily WHERE day = ?", utcDay(start));
			this.#sql.exec(`INSERT INTO pim_usage_daily (${COLUMNS}) ${AGGREGATE}`, start, start + DAY);
		}
		this.#sql.exec("INSERT INTO pim_usage_rollup (id, rolled_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET rolled_at = excluded.rolled_at", now);
		this.prune(now);
		this.#dirty = false;
	}

	prune(now: number): void {
		this.#sql.exec("DELETE FROM pim_model_calls WHERE ts < ?", now - RAW_KEEP_DAYS * DAY);
		this.#sql.exec("DELETE FROM pim_usage_daily WHERE day < ?", utcDay(now - DAILY_KEEP_DAYS * DAY));
	}

	/** The rollup's rows from `sinceDay` on, with the days since the last rollup summed from the calls. */
	#daily(sinceDay: string, now: number): DailyRow[] {
		const rolled = this.#rolledAt();
		const boundary = rolled === undefined ? sinceDay : utcDay(rolled);
		const live = boundary > sinceDay ? boundary : sinceDay;
		const kept = this.#sql.exec(`SELECT ${COLUMNS} FROM pim_usage_daily WHERE day >= ? AND day < ?`, sinceDay, live).toArray() as unknown as DailyRow[];
		const fresh = this.#sql.exec(AGGREGATE, dayStart(live), now + 1).toArray() as unknown as DailyRow[];
		return [...kept, ...fresh];
	}

	costs(days: number, now: number): CostReport {
		const since = utcDay(now - (days - 1) * DAY);
		const byDay = new Map<string, DailyRow[]>();
		for (const row of this.#daily(since, now)) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
		const total = { cost: 0, unpriced: 0, calls: 0, errors: 0, input: 0, output: 0, read: 0, write: 0 };
		const spend = (list: DailyRow[], key: "agent_id" | "model" | "run_kind"): Spend[] => {
			const sums = new Map<string | null, number>();
			for (const row of list) sums.set(row[key], (sums.get(row[key]) ?? 0) + (row.cost_usd ?? 0));
			return [...sums].map(([k, costUsd]) => ({ key: k, costUsd })).sort((a, b) => b.costUsd - a.costUsd);
		};
		const daily = [...byDay]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([day, list]) => {
				const sum = (field: Summed) => list.reduce((n, row) => n + (row[field] ?? 0), 0);
				const write = sum("cache_write_5m") + sum("cache_write_1h");
				total.cost += sum("cost_usd");
				total.unpriced += sum("unpriced_calls");
				total.calls += sum("calls");
				total.errors += sum("errors");
				total.input += sum("input");
				total.output += sum("output");
				total.read += sum("cache_read");
				total.write += write;
				return {
					day,
					costUsd: sum("cost_usd"),
					calls: sum("calls"),
					cacheHitRatio: ratio(sum("cache_read"), sum("input"), write),
					byAgent: spend(list, "agent_id"),
					byModel: spend(list, "model"),
					byRunKind: spend(list, "run_kind"),
				};
			});
		const from = dayStart(since);
		return {
			days,
			since,
			priceVersion: this.#prices.version,
			totalCostUsd: total.cost,
			unpricedCalls: total.unpriced,
			calls: total.calls,
			errors: total.errors,
			costPer1kOutputTokens: total.output > 0 ? (total.cost / total.output) * 1000 : null,
			cacheHitRatio: ratio(total.read, total.input, total.write),
			byDay: daily,
			topChats: this.#top("chat_id", from, now + 1),
			topCodingThreads: this.#top("coding_thread_id", from, now + 1),
		};
	}

	#top(column: "chat_id" | "coding_thread_id", from: number, until: number): TopSpender[] {
		return this.#sql
			.exec(
				`SELECT ${column} AS id, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS calls, COALESCE(MAX(turn_index), 0) AS turns, COALESCE(AVG(prompt_bytes), 0) AS prompt
				FROM pim_model_calls WHERE ts >= ? AND ts < ? AND ${column} IS NOT NULL GROUP BY ${column} ORDER BY cost DESC, calls DESC LIMIT 20`,
				from,
				until,
			)
			.toArray()
			.map((row) => ({ id: String(row.id), costUsd: Number(row.cost), calls: Number(row.calls), turns: Number(row.turns), avgPromptBytes: Math.round(Number(row.prompt)) }));
	}
}
