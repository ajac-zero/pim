/**
 * What a person used and may use: `GET /api/usage` (today, recent days, the limits they count against), `GET /api/usage/costs` in the shape of the
 * usage screen's cost report, and the admin's per-person limits. The meter is `Quota` (packages/v2-app/src/quota.ts); money is the model-call
 * ledger, whose prices were applied when each call was recorded.
 */
import type { App } from "@pim/v2-app/app";
import { BadRequestError, NotFoundError } from "@pim/v2-app/errors";
import { ok, type Route, route } from "@pim/v2-app/http";
import { parseLimits } from "@pim/v2-app/quota";
import type { Principal } from "@pim/v2-contracts/identity";

/** `usage`, as `GET /api/usage` and `GET /api/account` carry it: limits, today, the last 30 days and the bytes kept. */
export async function usageReport(app: App, ownerId: string, days = 30) {
	return app.db.owner(ownerId, async (tx) => ({
		limits: await app.quota.limits(tx, ownerId),
		today: await app.quota.today(tx),
		history: await app.quota.history(tx, days),
		storageBytes: Number((await tx.query("SELECT coalesce(sum(size), 0)::bigint AS n FROM pim_app.objects")).rows[0].n),
	}));
}

type ComputeQuota = { maxConcurrentWorkspaces: number | null; monthlySandboxMinutes: number | null; maxSessionMinutes: number | null };
const NO_COMPUTE_QUOTA: ComputeQuota = { maxConcurrentWorkspaces: null, monthlySandboxMinutes: null, maxSessionMinutes: null };
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** Forge keeps a quota as `max_concurrent` and `compute_minutes` (and `usd`, which the app has no field for); the longest session has no counterpart, so it is never set. */
const quotaOf = (row: Record<string, unknown> | undefined): Partial<ComputeQuota> | null => (row ? { maxConcurrentWorkspaces: num(row.max_concurrent), monthlySandboxMinutes: num(row.compute_minutes) } : null);

/** What a person may use of the deployment's compute for coding sandboxes, and what they used: Forge's quota rows (the person's own over the deployment's) and its compute ledger. */
export async function computeReport(app: App, ownerId: string) {
	return app.db.owner(ownerId, async (tx) => {
		const rows = (await tx.query("SELECT subject_type, max_concurrent, compute_minutes FROM pim_forge.forge_quotas WHERE (subject_type, subject_id) IN (('user', $1), ('deployment', '*'))", [ownerId])).rows;
		const own = quotaOf(rows.find((r) => r.subject_type === "user"));
		const deployment = quotaOf(rows.find((r) => r.subject_type === "deployment"));
		const minutes = `coalesce(sum(extract(epoch FROM (coalesce(ended_at, now()) - began_at))) / 60, 0)`;
		const months = (await tx.query(`SELECT to_char(began_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, provider, ${minutes} AS minutes, count(*) FILTER (WHERE ended_at IS NULL)::int AS running FROM pim_forge.forge_compute_usage WHERE began_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1, 2`)).rows;
		const month = new Date().toISOString().slice(0, 7);
		const total = (list: typeof months) => Math.round(list.reduce((n, r) => n + Number(r.minutes), 0));
		const thisMonth = months.filter((r) => r.month === month);
		return {
			quota: { ...NO_COMPUTE_QUOTA, ...(deployment ?? {}), ...Object.fromEntries(Object.entries(own ?? {}).filter(([, v]) => v !== null)) } as ComputeQuota,
			own,
			usage: {
				month, minutes: total(thisMonth), running: thisMonth.reduce((n, r) => n + r.running, 0),
				byProvider: thisMonth.map((r) => ({ provider: r.provider as string, minutes: Math.round(Number(r.minutes)), running: r.running as number })),
				history: [...new Set(months.map((r) => r.month as string))].sort().map((m) => ({ month: m, minutes: total(months.filter((r) => r.month === m)) })),
			},
		};
	});
}

/** The compute quota as the admin sets it, over `forge_quotas`: whole numbers or null, and no longest session, which Forge does not limit. */
function parseComputeQuota(value: unknown): { max_concurrent: number | null; compute_minutes: number | null } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BadRequestError("quota must be an object");
	const q = value as Record<string, unknown>;
	for (const name of Object.keys(q)) if (!["maxConcurrentWorkspaces", "monthlySandboxMinutes", "maxSessionMinutes"].includes(name)) throw new BadRequestError(`Unknown quota ${name}`);
	const whole = (name: string) => {
		const v = q[name];
		if (v === null || v === undefined) return null;
		if (!(Number.isSafeInteger(v) && (v as number) >= 0)) throw new BadRequestError(`${name} must be a non-negative integer or null`);
		return v as number;
	};
	if (whole("maxSessionMinutes") !== null) throw new BadRequestError("maxSessionMinutes is not limited on this deployment");
	return { max_concurrent: whole("maxConcurrentWorkspaces"), compute_minutes: whole("monthlySandboxMinutes") };
}

async function setComputeQuota(app: App, subject: ["user" | "deployment", string], quota: ReturnType<typeof parseComputeQuota> | null): Promise<void> {
	await app.db.anonymous(async (tx) => {
		if (quota === null || (quota.max_concurrent === null && quota.compute_minutes === null)) await tx.query("UPDATE pim_forge.forge_quotas SET max_concurrent = NULL, compute_minutes = NULL WHERE subject_type = $1 AND subject_id = $2", subject);
		else await tx.query("INSERT INTO pim_forge.forge_quotas (subject_type, subject_id, max_concurrent, compute_minutes) VALUES ($1,$2,$3,$4) ON CONFLICT (subject_type, subject_id) DO UPDATE SET max_concurrent = $3, compute_minutes = $4", [...subject, quota.max_concurrent, quota.compute_minutes]);
	});
}

const dollars = (micro: unknown) => Number(micro) / 1_000_000;
type Spend = { key: string | null; costUsd: number };

/** What model calls cost over the last `days` days, in the usage screen's shape. A call that cost nothing and used tokens is counted as unpriced. */
async function costs(app: App, p: Principal, days: number) {
	await app.identity.authz.enforce(p, "api:read");
	return app.db.owner(p.ownerId, async (tx) => {
		const since = `(now() AT TIME ZONE 'UTC')::date - ${days - 1}`;
		const rows = (await tx.query(
			`SELECT to_char(m.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, m.run_kind, m.provider || '/' || m.model AS model, c.agent_id,
			        count(*)::int AS calls, sum(m.output_tokens)::bigint AS output, sum(m.cost_microusd)::bigint AS cost,
			        count(*) FILTER (WHERE m.cost_microusd = 0 AND m.input_tokens + m.output_tokens > 0)::int AS unpriced
			 FROM pim_app.model_calls m LEFT JOIN pim_app.conversations c ON c.public_chat_id = m.public_chat_id
			 WHERE m.at >= ${since} GROUP BY 1, 2, 3, 4 ORDER BY 1`)).rows;
		const spend = (list: typeof rows, key: "agent_id" | "model" | "run_kind"): Spend[] => {
			const sums = new Map<string | null, number>();
			for (const r of list) sums.set(r[key] ?? null, (sums.get(r[key] ?? null) ?? 0) + dollars(r.cost));
			return [...sums].map(([k, costUsd]) => ({ key: k, costUsd })).sort((a, b) => b.costUsd - a.costUsd);
		};
		const byDay = [...Map.groupBy(rows, (r) => r.day as string)].map(([day, list]) => ({
			day, costUsd: list.reduce((n, r) => n + dollars(r.cost), 0), calls: list.reduce((n, r) => n + r.calls, 0), cacheHitRatio: null,
			byAgent: spend(list, "agent_id"), byModel: spend(list, "model"), byRunKind: spend(list, "run_kind"),
		}));
		const total = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
		const output = total((r) => Number(r.output));
		const top = async (kind: "chat" | "coding_thread") =>
			(await tx.query(
				`SELECT ${kind === "chat" ? "public_chat_id::text" : "NULL"} AS id, sum(cost_microusd)::bigint AS cost, count(*)::int AS calls FROM pim_app.model_calls
				 WHERE at >= ${since} AND run_kind ${kind === "chat" ? "<> 'coding_thread' AND public_chat_id IS NOT NULL" : "= 'coding_thread' AND false"} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`)).rows
				.map((r) => ({ id: r.id as string, costUsd: dollars(r.cost), calls: r.calls as number, turns: 0, avgPromptBytes: 0 }));
		const totalCostUsd = dollars(total((r) => Number(r.cost)));
		return {
			days, since: new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10), priceVersion: "ledger", totalCostUsd,
			unpricedCalls: total((r) => r.unpriced), calls: total((r) => r.calls), errors: 0,
			costPer1kOutputTokens: output > 0 ? (totalCostUsd / output) * 1000 : null, cacheHitRatio: null, byDay,
			topChats: await top("chat"), topCodingThreads: await top("coding_thread"),
		};
	});
}

export function usageRoutes(): Route[] {
	return [
		route("GET", "/api/usage", async ({ app, principal }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			return ok({ ...(await usageReport(app, p.ownerId)), compute: await computeReport(app, p.ownerId) });
		}),
		route("GET", "/api/usage/costs", async ({ app, principal, url }) => {
			const days = Number(url.searchParams.get("days") ?? 30);
			return ok(await costs(app, await principal(), Math.min(Math.max(Math.floor(days) || 30, 1), 400)));
		}),
		route("PUT", "/api/admin/compute/quota", async ({ app, principal, json }) => {
			await app.identity.authz.enforce(await principal(), "admin:compute");
			const { quota } = await json();
			const parsed = quota === null ? null : parseComputeQuota(quota);
			await setComputeQuota(app, ["deployment", "*"], parsed);
			return ok({ quota: { ...NO_COMPUTE_QUOTA, ...(parsed ? quotaOf(parsed) : {}) } });
		}),
		route("PUT", "/api/admin/accounts/:username/compute-quota", async ({ app, principal, params, json }) => {
			await app.identity.authz.enforce(await principal(), "admin:compute");
			const owner = (await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE username = $1 AND status <> 'deleted'", [params[0]!.toLowerCase()])).rows[0]))?.owner_id as string | undefined;
			if (!owner) throw new NotFoundError("No such account");
			const { quota } = await json();
			await setComputeQuota(app, ["user", owner], quota === null ? null : parseComputeQuota(quota));
			return ok({ quota: { ...NO_COMPUTE_QUOTA, ...((await computeReport(app, owner)).own ?? {}) } });
		}),
		// The admin's override for one person's limits; `null` goes back to the deployment's.
		route("PUT", "/api/admin/accounts/:username/limits", async ({ app, principal, params, json }) => {
			await app.identity.authz.enforce(await principal(), "admin:accounts");
			const owner = (await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE username = $1 AND status <> 'deleted'", [params[0]!.toLowerCase()])).rows[0]))?.owner_id as string | undefined;
			if (!owner) throw new NotFoundError("No such account");
			const body = await json();
			if (!("limits" in body)) throw new BadRequestError("Send { limits } (an object, or null)");
			const parsed = body.limits === null ? null : parseLimits(body.limits);
			return ok({ limits: await app.db.owner(owner, async (tx) => (await app.quota.setOverride(tx, owner, parsed), app.quota.limits(tx, owner))) });
		}),
	];
}
