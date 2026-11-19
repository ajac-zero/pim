import type { Tx } from "./db.ts";
import { BadRequestError, PimError } from "./errors.ts";

/** What one space may use: a limit is a whole number, or null for none. The names are v1's (`src/usage.ts`), and the web app's `Limits`. */
export const LIMIT_NAMES = ["dailyTokens", "dailyModelRequests", "dailyRuns", "dailyToolCalls", "sessions", "schedules", "storageBytes", "artifacts", "artifactVersions", "artifactBytes", "artifactStorageBytes"] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];
export type Limits = Record<LimitName, number | null>;
export const UNLIMITED = Object.fromEntries(LIMIT_NAMES.map((name) => [name, null])) as Limits;

/** The refusal's start, as in v1: the Runner's cooldown logic and the app recognise a space's own limit by it. */
export const QUOTA_MESSAGE = "Space usage quota exceeded:";

export class QuotaError extends PimError {
	constructor(what: string) {
		super(429, "quota_exceeded", `${QUOTA_MESSAGE} ${what}`);
	}
}

/** The variable that sets each limit: `dailyTokens` is `PIM_LIMIT_DAILY_TOKENS`. */
export const limitVariable = (name: LimitName) => `PIM_LIMIT_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;

/** The deployment's limits for members, from `PIM_LIMIT_*`; a variable that is not a non-negative integer is no limit. */
export function deploymentLimits(env: Record<string, string | undefined>): Limits {
	return Object.fromEntries(LIMIT_NAMES.map((name) => {
		const text = env[limitVariable(name)]?.trim();
		return [name, text && /^\d+$/.test(text) ? Number(text) : null];
	})) as Limits;
}

/** Checks a partial limits object, as the admin sets one person's: each a non-negative integer or null. */
export function parseLimits(value: unknown): Partial<Limits> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BadRequestError("limits must be an object");
	const limits: Record<string, number | null> = {};
	for (const [name, limit] of Object.entries(value)) {
		if (!(LIMIT_NAMES as readonly string[]).includes(name)) throw new BadRequestError(`Unknown limit ${name}`);
		if (limit !== null && !(Number.isSafeInteger(limit) && (limit as number) >= 0)) throw new BadRequestError(`${name} must be a non-negative integer or null`);
		limits[name] = limit as number | null;
	}
	return limits as Partial<Limits>;
}

export type DayUsage = { day: string; tokens: number; planTokens: number; modelRequests: number; runs: number; toolCalls: number };

/**
 * Per-space limits and the day's meter. Days are UTC. Tokens count only models the deployment pays for, and model requests count every call;
 * runs and tool calls are counted in `pim_app.usage_days` (a Runner counts tool calls with `runner_count_tool_call`, migration 0621).
 * The admin's own space has no limits.
 */
export class Quota {
	constructor(private readonly env: Record<string, string | undefined> = process.env) {}

	/** The limits that apply to an owner: the deployment's, over which the admin's override for this person, and none at all for an admin. */
	async limits(tx: Tx, ownerId: string): Promise<Limits> {
		const role = (await tx.query("SELECT role FROM pim_app.accounts WHERE owner_id = $1", [ownerId])).rows[0]?.role;
		if (role === "admin") return { ...UNLIMITED };
		const override = (await tx.query("SELECT value FROM pim_app.owner_settings WHERE key = 'limits'")).rows[0]?.value as Partial<Limits> | undefined;
		return { ...deploymentLimits(this.env), ...(override ?? {}) };
	}

	/** What the admin set for one person alone, or null. */
	async override(tx: Tx): Promise<Partial<Limits> | null> {
		return ((await tx.query("SELECT value FROM pim_app.owner_settings WHERE key = 'limits'")).rows[0]?.value as Partial<Limits> | undefined) ?? null;
	}

	async setOverride(tx: Tx, ownerId: string, limits: Partial<Limits> | null): Promise<void> {
		if (limits === null) await tx.query("DELETE FROM pim_app.owner_settings WHERE owner_id = $1 AND key = 'limits'", [ownerId]);
		else await tx.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1,'limits',$2) ON CONFLICT (owner_id, key) DO UPDATE SET value = $2", [ownerId, JSON.stringify(limits)]);
	}

	/** Usage on each of the last `days` UTC days, oldest first; days with nothing are left out. */
	async history(tx: Tx, days = 30): Promise<DayUsage[]> {
		const calls = (await tx.query(
			`SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS requests,
			        coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) FILTER (WHERE coalesce(provider, '') NOT LIKE 'own:%' AND coalesce(provider, '') <> 'chatgpt'), 0)::bigint AS tokens,
			        coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) FILTER (WHERE provider LIKE 'own:%' OR provider = 'chatgpt'), 0)::bigint AS plan
			 FROM pim_app.model_calls WHERE at >= (now() AT TIME ZONE 'UTC')::date - $1::int + 1 GROUP BY 1`, [days])).rows;
		const counted = (await tx.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, runs, tool_calls, model_requests FROM pim_app.usage_days WHERE day >= (now() AT TIME ZONE 'UTC')::date - $1::int + 1", [days])).rows;
		const byDay = new Map<string, DayUsage>();
		const at = (day: string) => byDay.get(day) ?? (byDay.set(day, { day, tokens: 0, planTokens: 0, modelRequests: 0, runs: 0, toolCalls: 0 }), byDay.get(day)!);
		for (const r of calls) Object.assign(at(r.day), { tokens: Number(r.tokens), planTokens: Number(r.plan), modelRequests: r.requests });
		// A request is counted when it is sent, so one that failed before it used a token is a request too.
		for (const r of counted) Object.assign(at(r.day), { runs: r.runs, toolCalls: r.tool_calls, modelRequests: Math.max(at(r.day).modelRequests, r.model_requests) });
		return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
	}

	async today(tx: Tx): Promise<DayUsage> {
		const day = new Date().toISOString().slice(0, 10);
		return (await this.history(tx, 2)).find((d) => d.day === day) ?? { day, tokens: 0, planTokens: 0, modelRequests: 0, runs: 0, toolCalls: 0 };
	}

	/** A run is about to start (a message, a firing trigger): refused when a daily limit is used up, else counted. */
	async admitRun(tx: Tx, ownerId: string): Promise<void> {
		const limits = await this.limits(tx, ownerId);
		const today = await this.today(tx);
		if (limits.dailyRuns !== null && today.runs >= limits.dailyRuns) throw new QuotaError(`${limits.dailyRuns} runs a day. It resets at midnight UTC.`);
		if (limits.dailyTokens !== null && today.tokens >= limits.dailyTokens) throw new QuotaError(`${limits.dailyTokens} tokens a day. It resets at midnight UTC.`);
		if (limits.dailyModelRequests !== null && today.modelRequests >= limits.dailyModelRequests) throw new QuotaError(`${limits.dailyModelRequests} model requests a day. It resets at midnight UTC.`);
		await tx.query("INSERT INTO pim_app.usage_days (owner_id, day, runs) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1) ON CONFLICT (owner_id, day) DO UPDATE SET runs = pim_app.usage_days.runs + 1", [ownerId]);
	}

	/** Something countable is about to be made: refused when the person already has as many as they may. */
	async admitNew(tx: Tx, ownerId: string, what: "sessions" | "schedules"): Promise<void> {
		const limit = (await this.limits(tx, ownerId))[what];
		if (limit === null) return;
		const have = what === "sessions"
			? (await tx.query("SELECT count(*)::int AS n FROM pim_app.conversations WHERE deleted_at IS NULL AND kind IN ('normal', 'group')")).rows[0].n
			: (await tx.query("SELECT count(*)::int AS n FROM pim_app.schedules WHERE enabled")).rows[0].n;
		if (have >= limit) throw new QuotaError(`${limit} ${what}.`);
	}
}
