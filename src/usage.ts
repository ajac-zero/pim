import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type Usage as ModelUsage,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { HttpError } from "./http";

/**
 * What this agent has used, by UTC day, and the limits on it. A self-hosted
 * Pim has no limits unless `PIM_LIMITS` sets some; a hosted service sets them
 * for everyone, and its operator can change one person's.
 *
 * Model usage is counted where every request goes through, the model catalog,
 * so conversations, compactions and memory compression all count.
 */

export type Limits = {
	/** Tokens per UTC day on models the deployment pays for. The ChatGPT plan's are the person's own and do not count. */
	readonly dailyTokens: number | null;
	/** Model requests per UTC day, on any model, the ChatGPT plan's included: a ceiling for runaway loops. */
	readonly dailyModelRequests: number | null;
	/** Runs started per UTC day: messages into sessions, scheduled tasks firing, and app events. */
	readonly dailyRuns: number | null;
	/** Open conversations. */
	readonly sessions: number | null;
	/** Pending scheduled tasks. */
	readonly schedules: number | null;
	/** Connected apps. */
	readonly apps: number | null;
	/** The agent's database, in bytes. */
	readonly storageBytes: number | null;
};

export const LIMIT_NAMES = [
	"dailyTokens",
	"dailyModelRequests",
	"dailyRuns",
	"sessions",
	"schedules",
	"apps",
	"storageBytes",
] as const satisfies readonly (keyof Limits)[];

export const UNLIMITED: Limits = Object.fromEntries(LIMIT_NAMES.map((name) => [name, null])) as unknown as Limits;

/** Checks a partial limits object, as `PIM_LIMITS` or an operator sets it: each a non-negative integer or null. */
export function parseLimits(value: unknown): Partial<Limits> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "limits must be an object");
	const limits: Record<string, number | null> = {};
	for (const [name, limit] of Object.entries(value)) {
		if (!LIMIT_NAMES.includes(name as keyof Limits)) throw new HttpError(400, `Unknown limit ${name}`);
		if (limit !== null && !(Number.isSafeInteger(limit) && (limit as number) >= 0)) {
			throw new HttpError(400, `${name} must be a non-negative integer or null`);
		}
		limits[name] = limit as number | null;
	}
	return limits as Partial<Limits>;
}

/** `PIM_LIMITS`: empty means none. A malformed value fails closed, to no runs at all, rather than lifting every limit. */
export function deploymentLimits(json: string | undefined): Limits {
	if (!json || json.trim() === "") return UNLIMITED;
	try {
		return { ...UNLIMITED, ...parseLimits(JSON.parse(json)) };
	} catch (error) {
		console.error("PIM_LIMITS is not valid; refusing model requests and runs until it is fixed", error);
		return { ...UNLIMITED, dailyTokens: 0, dailyModelRequests: 0, dailyRuns: 0 };
	}
}

export type DayUsage = {
	readonly day: string;
	/** Tokens on models the deployment pays for. */
	readonly tokens: number;
	/** Tokens on the person's own plans (ChatGPT). */
	readonly planTokens: number;
	readonly modelRequests: number;
	readonly runs: number;
	readonly models: readonly { provider: string; model: string; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_usage_models (
	day TEXT NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	requests INTEGER NOT NULL DEFAULT 0,
	input INTEGER NOT NULL DEFAULT 0,
	output INTEGER NOT NULL DEFAULT 0,
	cache_read INTEGER NOT NULL DEFAULT 0,
	cache_write INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, provider, model)
);
CREATE TABLE IF NOT EXISTS pim_usage_runs (
	day TEXT PRIMARY KEY,
	runs INTEGER NOT NULL DEFAULT 0
);
`;

/** Days of usage kept: enough for a monthly view. */
const KEEP_DAYS = 90;

type StreamFn = (model: Model<Api>, context: unknown, options?: unknown) => AssistantMessageEventStream;

export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Wording pi-ai classifies as a non-retryable quota error, so a run stops at once instead of retrying. */
export const QUOTA_MESSAGE = "Pim usage quota exceeded";

export class UsageMeter {
	readonly #sql: SqlStorage;
	readonly #limits: () => Limits;
	/** Providers that bill the person's own plan, not the deployment. */
	readonly #planProviders: ReadonlySet<string>;
	readonly #now: () => number;
	#pruned: string | undefined;

	constructor(options: { sql: SqlStorage; limits: () => Limits; planProviders: Iterable<string>; now?: () => number }) {
		this.#sql = options.sql;
		this.#limits = options.limits;
		this.#planProviders = new Set(options.planProviders);
		this.#now = options.now ?? Date.now;
		this.#sql.exec(SCHEMA);
	}

	#today(): string {
		const day = utcDay(this.#now());
		if (this.#pruned !== day) {
			this.#pruned = day;
			const cutoff = utcDay(this.#now() - KEEP_DAYS * 86_400_000);
			this.#sql.exec("DELETE FROM pim_usage_models WHERE day < ?", cutoff);
			this.#sql.exec("DELETE FROM pim_usage_runs WHERE day < ?", cutoff);
		}
		return day;
	}

	recordModel(provider: string, model: string, usage: ModelUsage | undefined): void {
		this.#sql.exec(
			`INSERT INTO pim_usage_models (day, provider, model, requests, input, output, cache_read, cache_write) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
			ON CONFLICT (day, provider, model) DO UPDATE SET requests = requests + 1, input = input + excluded.input, output = output + excluded.output,
				cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write`,
			this.#today(),
			provider,
			model,
			usage?.input ?? 0,
			usage?.output ?? 0,
			usage?.cacheRead ?? 0,
			usage?.cacheWrite ?? 0,
		);
	}

	recordRun(): void {
		this.#sql.exec(
			"INSERT INTO pim_usage_runs (day, runs) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET runs = runs + 1",
			this.#today(),
		);
	}

	day(day: string): DayUsage {
		const models = this.#sql
			.exec("SELECT provider, model, requests, input, output, cache_read, cache_write FROM pim_usage_models WHERE day = ? ORDER BY provider, model", day)
			.toArray()
			.map((row) => ({
				provider: String(row.provider),
				model: String(row.model),
				requests: Number(row.requests),
				input: Number(row.input),
				output: Number(row.output),
				cacheRead: Number(row.cache_read),
				cacheWrite: Number(row.cache_write),
			}));
		let tokens = 0;
		let planTokens = 0;
		for (const model of models) {
			const used = model.input + model.output + model.cacheRead + model.cacheWrite;
			if (this.#planProviders.has(model.provider)) planTokens += used;
			else tokens += used;
		}
		const runs = Number(this.#sql.exec("SELECT runs FROM pim_usage_runs WHERE day = ?", day).toArray()[0]?.runs ?? 0);
		return { day, tokens, planTokens, modelRequests: models.reduce((n, model) => n + model.requests, 0), runs, models };
	}

	today(): DayUsage {
		return this.day(this.#today());
	}

	/** The last `days` days with any use, newest first. */
	history(days = 30): DayUsage[] {
		const since = utcDay(this.#now() - (days - 1) * 86_400_000);
		const rows = this.#sql
			.exec(
				"SELECT day FROM pim_usage_models WHERE day >= ? UNION SELECT day FROM pim_usage_runs WHERE day >= ? ORDER BY day DESC",
				since,
				since,
			)
			.toArray();
		return rows.map((row) => this.day(String(row.day)));
	}

	/** Why a request to `provider` may not run now, or null. */
	modelRefusal(provider: string): string | null {
		const limits = this.#limits();
		if (limits.dailyTokens === null && limits.dailyModelRequests === null) return null;
		const today = this.today();
		if (limits.dailyModelRequests !== null && today.modelRequests >= limits.dailyModelRequests) {
			return `${QUOTA_MESSAGE}: today's ${limits.dailyModelRequests} model requests are used up. It resets at midnight UTC.`;
		}
		if (limits.dailyTokens !== null && !this.#planProviders.has(provider) && today.tokens >= limits.dailyTokens) {
			return `${QUOTA_MESSAGE}: today's ${limits.dailyTokens} tokens are used up. It resets at midnight UTC.`;
		}
		return null;
	}

	/** Why another run may not start today, or null. */
	runRefusal(): string | null {
		const { dailyRuns } = this.#limits();
		if (dailyRuns === null || this.today().runs < dailyRuns) return null;
		return `${QUOTA_MESSAGE}: today's ${dailyRuns} runs are used up. It resets at midnight UTC.`;
	}

	/**
	 * The catalog with every request metered: refused with an error response
	 * once a limit is reached, and its usage recorded once it ends.
	 */
	meter(models: Models): Models {
		const failed = (model: Model<Api>, reason: string): AssistantMessage => ({
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			errorMessage: reason,
			timestamp: this.#now(),
		});
		const metered =
			(stream: StreamFn): StreamFn =>
			(model, context, options) => {
				const refusal = this.modelRefusal(model.provider);
				if (refusal !== null) {
					console.warn(JSON.stringify({ event: "pim.limit", limit: "model", provider: model.provider, reason: refusal }));
					const events = createAssistantMessageEventStream();
					const message = failed(model, refusal);
					events.push({ type: "error", reason: "error", error: message });
					events.end(message);
					return events;
				}
				const events = stream(model, context, options);
				events.result().then(
					(message) => this.recordModel(model.provider, model.id, message.usage),
					() => this.recordModel(model.provider, model.id, undefined),
				);
				return events;
			};
		const stream = metered((model, context, options) => models.stream(model, context as never, options as never));
		const streamSimple = metered((model, context, options) => models.streamSimple(model, context as never, options as never));
		// `Models` keeps private state: everything else runs on the original, and the one-shot calls go through the metered streams.
		return new Proxy(models, {
			get(target, property) {
				switch (property) {
					case "stream":
						return stream;
					case "streamSimple":
						return streamSimple;
					case "complete":
						return (model: Model<Api>, context: unknown, options?: unknown) => stream(model, context, options).result();
					case "completeSimple":
						return (model: Model<Api>, context: unknown, options?: unknown) => streamSimple(model, context, options).result();
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
}
