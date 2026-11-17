/**
 * What an admin reads to debug this Pim without the web app, as v1's `pim_diagnostics` gave the admin's majordomo (`src/diagnostics.ts`,
 * `src/space/reports.ts`): a bounded, read-only report of the admin's own space, by kind, and a health report of the deployment. Everything that
 * leaves is cut short and scrubbed of what looks like a secret, an address or an email. The admin majordomo's tool is a thin caller of
 * `diagnose`, which is exported for it.
 *
 * Not available on v2, and said so in the report rather than faked: the provider cooldowns (each Runner keeps its own, in memory), the
 * reading of a chat's turns (needs the transcript's tool steps), and the event log (v2 writes its events to the process logs and metrics).
 */
import type { App } from "@pim/v2-app/app";
import { BadRequestError } from "@pim/v2-app/errors";
import { ok, type Route, route } from "@pim/v2-app/http";
import { redact, redactSecrets } from "@pim/shared/redact";
import type { Principal } from "@pim/v2-contracts/identity";

export const DIAGNOSTIC_KINDS = ["now", "stalls", "runs", "turns", "triggers", "model_calls", "provider_cooldowns", "coding", "connectors", "approvals", "events"] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|credential|cookie|bearer/i;
const TEXT_LENGTH = 300;
const DURATION = /^(\d+)\s*(m|h|d)$/;

/** `text` without credentials, addresses (the path is kept) or emails, and cut to `max` characters. */
export function scrub(text: string, max = TEXT_LENGTH): string {
	const clean = redactSecrets(redact(text))
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>/?#]*([^\s"'<>?#]*)[^\s"'<>]*/gi, (_url, path: string) => `[address]${path}`)
		.replace(/[^\s@"'<>,;]+@[^\s@"'<>,;]+\.[^\s@"'<>,;]+/g, "[email]");
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** `value` with every string scrubbed and every secret-looking field left out. */
export function scrubValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return scrub(value);
	if (value instanceof Date) return value.toISOString();
	if (typeof value !== "object" || value === null) return value;
	if (depth > 4) return "[deep]";
	if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubValue(item, depth + 1));
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[redacted]" : scrubValue(item, depth + 1)]));
}

const unavailable = (why: string) => ({ available: false, note: why });

export type DiagnosticQuery = { since?: string; kind?: string; limit?: number; chat?: string };

/** The report of `kind` (default `now`) for one owner's space; `since` is a count and a unit (`30m`, `6h`, `2d`), default 24h. */
export async function diagnose(app: App, ownerId: string, query: DiagnosticQuery = {}) {
	const kind = (query.kind ?? "now") as DiagnosticKind;
	if (!DIAGNOSTIC_KINDS.includes(kind)) throw new BadRequestError(`kind is one of ${DIAGNOSTIC_KINDS.join(", ")}`);
	const match = DURATION.exec(query.since ?? "24h");
	if (!match) throw new BadRequestError("since is a count and a unit: 30m, 6h or 2d");
	const sinceMs = Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
	const since = new Date(Date.now() - sinceMs);
	const limit = Math.min(Math.max(Math.floor(query.limit ?? 20), 1), 50);
	const rows = (sql: string, params: unknown[] = []) => app.db.owner(ownerId, async (tx) => (await tx.query(sql, params)).rows);
	const base = { kind, since: since.toISOString(), generatedAt: new Date().toISOString() };
	switch (kind) {
		case "now": {
			const [c] = await rows(`SELECT (SELECT count(*) FROM pim_app.conversations WHERE deleted_at IS NULL)::int AS chats,
				(SELECT count(*) FROM pim_app.approvals WHERE state = 'waiting')::int AS waiting_approvals,
				(SELECT count(*) FROM pim_app.accepted_commands WHERE state = 'inbox_accepted')::int AS commands_not_taken,
				(SELECT count(*) FROM pim_app.triggers WHERE lifecycle = 'enabled')::int AS triggers_on,
				(SELECT count(*) FROM pim_app.schedules WHERE enabled)::int AS schedules_on,
				(SELECT count(*) FROM pim_app.model_calls WHERE at >= $1)::int AS model_calls`, [since]);
			return scrubValue({ ...base, counts: c });
		}
		case "runs":
		case "stalls": {
			const busy = await rows("SELECT chat_id, title, busy, stalled, updated_at FROM pim_projection.sidebar_session_projection WHERE " + (kind === "stalls" ? "stalled" : "busy") + " ORDER BY updated_at DESC LIMIT $1", [limit]);
			const waiting = await rows("SELECT public_chat_id AS chat, tool, created_at FROM pim_app.approvals WHERE state = 'waiting' ORDER BY created_at LIMIT $1", [limit]);
			return scrubValue({ ...base, chats: busy.map((r) => ({ chat: r.chat_id, title: r.title, stalled: r.stalled, updatedAt: new Date(Number(r.updated_at)).toISOString() })), waitingOnApprovals: waiting });
		}
		case "triggers":
			return scrubValue({ ...base, failures: await rows("SELECT trigger_id, phase, detail, at FROM pim_app.trigger_runs WHERE phase IN ('failed', 'skipped') AND at >= $1 ORDER BY at DESC LIMIT $2", [since, limit]) });
		case "model_calls": {
			const calls = await rows("SELECT id, run_kind, public_chat_id AS chat, provider, model, input_tokens AS input, output_tokens AS output, cost_microusd AS cost, at FROM pim_app.model_calls WHERE at >= $1 ORDER BY at DESC LIMIT $2", [since, limit]);
			const [t] = await rows("SELECT count(*)::int AS calls, coalesce(sum(input_tokens), 0)::bigint AS input, coalesce(sum(output_tokens), 0)::bigint AS output FROM pim_app.model_calls WHERE at >= $1", [since]);
			return scrubValue({ ...base, totals: { calls: t.calls, input: Number(t.input), output: Number(t.output) }, recent: calls, failures: unavailable("v2 records a model call when it returns; a failed one is in the Runner's log and its metrics") });
		}
		case "coding":
			return scrubValue({ ...base, threads: await rows("SELECT thread_id, state, state_reason, repo, branch, last_seen_at FROM pim_forge.forge_threads WHERE last_seen_at >= $1 OR state NOT IN ('idle', 'done') ORDER BY last_seen_at DESC NULLS LAST LIMIT $2", [since, limit]).catch(() => []) });
		case "connectors":
			return scrubValue({ ...base, connectors: await rows("SELECT id, kind, name, status, enabled_tools FROM pim_app.connectors ORDER BY created_at LIMIT $1", [limit]) });
		case "approvals":
			return scrubValue({ ...base, approvals: await rows("SELECT id, tool, state, public_chat_id AS chat, created_at, decided_at FROM pim_app.approvals WHERE created_at >= $1 ORDER BY created_at DESC LIMIT $2", [since, limit]) });
		case "provider_cooldowns":
			return { ...base, ...unavailable("each Runner keeps its provider cooldowns in its own memory; they are not readable from the Gate") };
		case "turns":
			return { ...base, ...unavailable("a chat's turns are read from its transcript in the web app's chat view") };
		case "events":
			return { ...base, ...unavailable("v2 has no event log of its own: slow requests and failures are in the roles' logs and metrics") };
	}
}

/** How this deployment is doing: what the database holds and whether the roles' work is moving. No address and no key is in it. */
export async function health(app: App, env: Readonly<Record<string, string | undefined>>) {
	const [counts] = (await app.db.anonymous((tx) => tx.query(`SELECT (SELECT count(*) FROM pim_app.accounts WHERE status = 'active')::int AS active_accounts,
		(SELECT count(*) FROM pim_app.accounts WHERE status = 'deleting')::int AS accounts_being_erased,
		(SELECT count(*) FROM pim_app.approvals WHERE state = 'waiting')::int AS waiting_approvals,
		(SELECT count(*) FROM pim_app.command_inbox)::int AS commands_not_taken`))).rows;
	return scrubValue({
		generatedAt: new Date().toISOString(),
		counts,
		deployment: { publicUrlSet: !!env.PIM_PUBLIC_URL, appsOriginSet: !!env.PIM_APPS_ORIGIN, contentOriginSet: !!env.PIM_CONTENT_ORIGIN, defaultModel: env.PIM_DEFAULT_MODEL ?? null, approvalPolicy: env.PIM_APPROVAL_POLICY ?? "explicit" },
	});
}

export function diagnosticsRoutes(env: Readonly<Record<string, string | undefined>>): Route[] {
	const admin = async (app: App, p: Principal) => app.identity.authz.enforce(p, "admin:settings");
	return [
		route("GET", "/api/admin/diagnostics", async ({ app, principal, url }) => {
			const p = await principal();
			await admin(app, p);
			const limit = url.searchParams.get("limit");
			return ok(await diagnose(app, p.ownerId, { ...(url.searchParams.get("kind") ? { kind: url.searchParams.get("kind")! } : {}), ...(url.searchParams.get("since") ? { since: url.searchParams.get("since")! } : {}), ...(limit ? { limit: Number(limit) } : {}) }));
		}),
		route("GET", "/api/admin/health", async ({ app, principal }) => (await admin(app, await principal()), ok(await health(app, env)))),
	];
}
