import type { Principal } from "@pim/v2-contracts/identity";
import { Authorizer } from "./authz.ts";
import type { Db } from "./db.ts";
import { BadRequestError } from "./errors.ts";

export type CallRecord = { id: string; runKind: "chat" | "background" | "coding_thread"; chatId?: string; provider?: string; model?: string; inputTokens: number; outputTokens: number; costMicroUsd: number; at?: Date };

/**
 * The cost ledger: one row per model call, whether a chat turn, background work (compaction, titles, summaries) or a coding thread's own calls.
 * Recording is idempotent on the call id, so a redelivered event counts once.
 */
export class Usage {
	constructor(private readonly db: Db, private readonly authz = new Authorizer(db)) {}

	/** Called by the Runner and Forge with the owner they act for; it is not an HTTP route. */
	async record(ownerId: string, call: CallRecord): Promise<boolean> {
		if (![call.inputTokens, call.outputTokens, call.costMicroUsd].every((n) => Number.isInteger(n) && n >= 0)) throw new BadRequestError("Counts are whole numbers, never negative");
		return this.db.owner(ownerId, async (tx) =>
			!!(await tx.query("INSERT INTO pim_app.model_calls (id, owner_id, run_kind, public_chat_id, provider, model, input_tokens, output_tokens, cost_microusd, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING", [
				call.id, ownerId, call.runKind, call.chatId ?? null, call.provider ?? null, call.model ?? null, call.inputTokens, call.outputTokens, call.costMicroUsd, call.at ?? new Date(),
			])).rowCount,
		);
	}

	/** `GET /api/usage/costs?days=30`: totals, by run kind, by model and by UTC day. */
	async costs(p: Principal, days = 30, now = new Date()) {
		await this.authz.enforce(p, "api:read");
		if (!Number.isInteger(days) || days < 1 || days > 400) throw new BadRequestError("days is 1 to 400");
		const since = new Date(now.getTime() - days * 86_400_000);
		return this.db.owner(p.ownerId, async (tx) => {
			const group = async (expr: string) => (await tx.query(`SELECT ${expr} AS key, count(*)::int AS calls, sum(input_tokens)::bigint AS input, sum(output_tokens)::bigint AS output, sum(cost_microusd)::bigint AS cost FROM pim_app.model_calls WHERE at >= $1 AND at <= $2 GROUP BY 1 ORDER BY 1`, [since, now])).rows.map((r) => ({ key: r.key as string, calls: r.calls as number, inputTokens: Number(r.input), outputTokens: Number(r.output), costMicroUsd: Number(r.cost) }));
			const byKind = await group("run_kind");
			const sum = (k: "calls" | "inputTokens" | "outputTokens" | "costMicroUsd") => byKind.reduce((s, r) => s + r[k], 0);
			return { days, total: { calls: sum("calls"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), costMicroUsd: sum("costMicroUsd") }, byRunKind: byKind, byModel: await group("coalesce(provider, '') || '/' || coalesce(model, '')"), byDay: await group("to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD')") };
		});
	}
}
