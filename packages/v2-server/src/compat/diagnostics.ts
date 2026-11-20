/**
 * What an admin reads to debug this Pim without the web app, as v1's `pim_diagnostics` gave the admin's majordomo (`src/diagnostics.ts`,
 * `src/space/reports.ts`): a bounded, read-only report of the admin's own space, by kind, and a health report of the deployment. Everything that
 * leaves is cut short and scrubbed of what looks like a secret, an address or an email. The admin majordomo's tool is a thin caller of
 * `diagnose`, which is exported for it.
 *
 * The event log is `pim_app.diagnostic_events`, which the Runners and the Gate write: a model that failed over, a provider's cooldown, a request that failed for good or was slow. A chat's turns and
 * what a chat at work waits on are read from its transcript, the ledger and its approvals (`./activity.ts`).
 */
import type { App } from "@pim/v2-app/app";
import { BadRequestError } from "@pim/v2-app/errors";
import { S3ObjectStore } from "@pim/v2-app/objects";
import { probeNats } from "@pim/v2-live/server/pulse";
import { ok, type Route, route } from "@pim/v2-app/http";
import { redact, redactSecrets } from "@pim/shared/redact";
import type { Principal } from "@pim/v2-contracts/identity";
import { activityOf, chatTurns } from "./activity.ts";
import { SLOW_CALL_MS } from "../call-details.ts";

export const DIAGNOSTIC_KINDS = ["now", "stalls", "runs", "turns", "triggers", "model_calls", "provider_cooldowns", "coding", "connectors", "approvals", "events", "services"] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|credential|cookie|bearer/i;
const TEXT_LENGTH = 300;
/** The most chats at work that are looked into at once. */
const MAX_AT_WORK = 50;
const DURATION = /^(\d+)\s*(m|h|d)$/;

/** `text` without credentials, addresses (the path is kept) or emails, and cut to `max` characters. */
export function scrub(text: string, max = TEXT_LENGTH): string {
	const clean = redactSecrets(redact(text))
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>/?#]*([^\s"'<>?#]*)[^\s"'<>]*/gi, (_url, path: string) => `[address]${path}`)
		.replace(/[^\s@"'<>,;]+@[^\s@"'<>,;]+\.[^\s@"'<>,;]+/g, "[email]");
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** A failed model call's error as the ledger keeps it, already without credentials, and without addresses or emails. */
function modelError(text: string): string {
	const clean = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>/?#]*([^\s"'<>?#]*)[^\s"'<>]*/gi, (_url, path: string) => `[address]${path}`).replace(/[^\s@"'<>,;]+@[^\s@"'<>,;]+\.[^\s@"'<>,;]+/g, "[email]");
	return clean.length > 4000 ? `${clean.slice(0, 4000)}…` : clean;
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

/** How long a probe of a service the Pim needs may take before it counts as failed. */
const PROBE_MS = 4000;
type Probe = { service: string; status: "ok" | "failed" | "not_configured"; ms?: number; error?: string; /** The service of the host operations (`hostops_logs`) whose log says more. */ logs?: string; detail?: unknown };

/** Whether each service this Pim needs answers from here (the process the tool runs in): PostgreSQL, NATS, the object store and, when set, the sandbox manager. Each is tried alone with a time limit, and a failure says what the service answered. */
async function probeServices(app: App, env: Readonly<Record<string, string | undefined>>): Promise<Probe[]> {
	const timed = async <T>(work: Promise<T>): Promise<T> => {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${PROBE_MS / 1000} s`)), PROBE_MS); })]);
		} finally {
			clearTimeout(timer);
		}
	};
	const probe = async (service: string, logs: string, work: () => Promise<unknown>): Promise<Probe> => {
		const began = Date.now();
		try {
			const detail = await timed(work());
			return { service, status: "ok", ms: Date.now() - began, logs, ...(detail === undefined ? {} : { detail }) };
		} catch (error) {
			return { service, status: "failed", ms: Date.now() - began, logs, error: scrub(error instanceof Error ? `${error.name}: ${error.message}` : String(error)) };
		}
	};
	const absent = (service: string, logs: string, what: string): Probe => ({ service, status: "not_configured", logs, error: what });
	const pool = app.db.pool as unknown as { totalCount?: number; idleCount?: number; waitingCount?: number };
	return Promise.all([
		probe("postgres", "postgres", async () => {
			await app.db.anonymous((tx) => tx.query("SELECT 1"));
			// A waiting count above 0 for long is a pool that is too small for the load, or a database that is slow to answer.
			return { pool: { total: pool.totalCount ?? null, idle: pool.idleCount ?? null, waiting: pool.waitingCount ?? null } };
		}),
		env.PIM_NATS_URL ? probe("nats", "nats", async () => ({ round_trip_ms: await probeNats(env.PIM_NATS_URL!.split(","), PROBE_MS) })) : absent("nats", "nats", "PIM_NATS_URL is not set"),
		env.PIM_S3_ENDPOINT && env.PIM_S3_BUCKET
			? probe("object_store", "seaweedfs", async () => void (await new S3ObjectStore(env.PIM_S3_BUCKET!, { endpoint: env.PIM_S3_ENDPOINT!, region: env.PIM_S3_REGION ?? "us-east-1", ...(env.PIM_S3_ACCESS_KEY && env.PIM_S3_SECRET_KEY ? { credentials: { accessKeyId: env.PIM_S3_ACCESS_KEY, secretAccessKey: env.PIM_S3_SECRET_KEY } } : {}) }).check()))
			: absent("object_store", "seaweedfs", "PIM_S3_ENDPOINT or PIM_S3_BUCKET is not set"),
		env.PIM_CODING_MANAGER_URL
			? probe("sandbox_manager", "sandbox-manager", async () => {
				const res = await fetch(new URL("/health", env.PIM_CODING_MANAGER_URL), { signal: AbortSignal.timeout(PROBE_MS), ...(env.PIM_CODING_MANAGER_TOKEN ? { headers: { authorization: `Bearer ${env.PIM_CODING_MANAGER_TOKEN}` } } : {}) });
				if (!res.ok) throw new Error(`/health answered ${res.status}`);
			})
			: absent("sandbox_manager", "sandbox-manager", "PIM_CODING_MANAGER_URL is not set, so coding threads have no sandbox"),
	]);
}

export type DiagnosticQuery = { since?: string; kind?: string; limit?: number; chat?: string };

/** The report of `kind` (default `now`) for one owner's space; `since` is an ISO time, or a count and a unit (`30m`, `6h`, `2d`), default 24h. */
export async function diagnose(app: App, ownerId: string, query: DiagnosticQuery = {}, env: Readonly<Record<string, string | undefined>> = process.env) {
	const kind = (query.kind ?? "now") as DiagnosticKind;
	if (!DIAGNOSTIC_KINDS.includes(kind)) throw new BadRequestError(`kind is one of ${DIAGNOSTIC_KINDS.join(", ")}`);
	const match = DURATION.exec(query.since ?? "24h");
	const at = match ? undefined : /^\d{4}-\d{2}-\d{2}T/.test(query.since ?? "") ? new Date(query.since!) : undefined;
	if (!match && (!at || Number.isNaN(at.getTime()))) throw new BadRequestError("since is an ISO time, or a count and a unit: 30m, 6h or 2d");
	const since = at ?? new Date(Date.now() - Number(match![1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match![2] as "m" | "h" | "d"]);
	const limit = Math.min(Math.max(Math.floor(query.limit ?? 20), 1), 50);
	const rows = (sql: string, params: unknown[] = []) => app.db.owner(ownerId, async (tx) => (await tx.query(sql, params)).rows);
	const base = { kind, since: since.toISOString(), generatedAt: new Date().toISOString() };
	/** The chats at work now, longest first, each with what it waits on: its model's answer, a tool that is running, or a person's approval; and, where it has gone quiet, why. */
	const atWork = async (take: number) => {
		const busy = await rows("SELECT chat_id, title FROM pim_projection.sidebar_session_projection WHERE busy ORDER BY updated_at DESC LIMIT $1", [MAX_AT_WORK]);
		const at = Date.now();
		const found = await Promise.all(busy.map(async (r) => {
			const { turns } = await chatTurns(app, ownerId, r.chat_id as string, at);
			const turn = turns.at(-1);
			const activity = activityOf(turns, at, { running: true, startedAt: turn?.startedAt ?? at });
			const approving = (turn?.steps ?? []).flatMap((step) => (step.kind === "tool" && step.ms === null && step.approval?.status === "pending" ? [step.name] : []));
			const waitingOn = approving.length > 0 ? `a person's approval of ${approving.join(", ")}` : activity.current.length > 0 ? `tool ${activity.current.map((tool) => `${tool.name} ${tool.summary}`.trim()).join("; ")}` : "the model's answer";
			return {
				chat: r.chat_id as string, title: r.title as string | null, waiting_on: waitingOn, working_since: turn ? new Date(turn.startedAt).toISOString() : null, working_minutes: turn ? Math.round((at - turn.startedAt) / 60_000) : null,
				last_activity_at: new Date(activity.lastActivityAt).toISOString(), current: activity.current.map((tool) => ({ name: tool.name, summary: tool.summary, elapsed_ms: tool.elapsedMs, timeout_ms: tool.timeoutMs })), stalls: activity.stalls.map((stall) => ({ reason: stall.reason, since: new Date(stall.since).toISOString(), ...(stall.actionable === false ? { actionable: false } : {}) })),
			};
		}));
		return found.sort((a, b) => (a.working_since ?? "").localeCompare(b.working_since ?? "")).slice(0, take);
	};
	switch (kind) {
		case "now": {
			const [c] = await rows(`SELECT (SELECT count(*) FROM pim_app.conversations WHERE deleted_at IS NULL)::int AS chats,
				(SELECT count(*) FROM pim_app.approvals WHERE state = 'waiting')::int AS waiting_approvals,
				(SELECT count(*) FROM pim_app.accepted_commands WHERE state = 'inbox_accepted')::int AS commands_not_taken,
				(SELECT count(*) FROM pim_app.triggers WHERE lifecycle = 'enabled')::int AS triggers_on,
				(SELECT count(*) FROM pim_app.schedules WHERE enabled)::int AS schedules_on,
				(SELECT count(*) FROM pim_app.model_calls WHERE at >= $1)::int AS model_calls`, [since]);
			return scrubValue({ ...base, counts: c, working: await atWork(limit) });
		}
		case "runs":
		case "stalls": {
			// The longest at work first: a run that should have ended long ago is what to look at.
			const chats = await atWork(kind === "stalls" ? MAX_AT_WORK : limit);
			const waiting = await rows("SELECT public_chat_id AS chat, tool, created_at FROM pim_app.approvals WHERE state = 'waiting' ORDER BY created_at LIMIT $1", [limit]);
			const listed = kind === "stalls" ? chats.filter((c) => c.stalls.length > 0) : chats;
			return scrubValue({ ...base, chats: listed.slice(0, limit), waitingOnApprovals: waiting, note: "Working runs are those at work now, with what each waits on and since when; a stall is a tool past its declared timeout or quiet for five minutes." });
		}
		case "turns": {
			// With a chat, its turns that went on in the window, newest first, step by step; without, the longest turns of the chats at work, with only their totals.
			const stepsOf = (turn: Awaited<ReturnType<typeof chatTurns>>["turns"][number]) => turn.steps.slice(-120).map((step) => (step.kind === "model" ? { step: "model", at: new Date(step.at).toISOString(), ms: step.ms, model: step.model, stop_reason: step.stop, ...(step.error === null ? {} : { error: step.error }) } : { step: "tool", at: new Date(step.at).toISOString(), ms: step.ms, name: step.name, summary: step.summary, timeout_ms: step.timeoutMs, output_bytes: step.outputBytes, ...(step.error ? { error: true } : {}), ...(step.approval ? { approval: { id: step.approval.id, status: step.approval.status, decided_by: step.approval.decidedBy, waited_ms: step.approval.waitedMs } } : {}) }));
			const totals = (chat: string, turn: Awaited<ReturnType<typeof chatTurns>>["turns"][number]) => {
				const total = turn.endedAt - turn.startedAt;
				return { chat, started_at: new Date(turn.startedAt).toISOString(), ended_at: turn.inProgress ? null : new Date(turn.endedAt).toISOString(), in_progress: turn.inProgress, total_ms: total, model_ms: turn.modelMs, tools_ms: turn.toolsMs, approvals_ms: turn.approvalsMs, other_ms: Math.max(0, total - turn.modelMs - turn.toolsMs - turn.approvalsMs), model_calls: turn.steps.filter((x) => x.kind === "model").length, tool_calls: turn.steps.filter((x) => x.kind === "tool").length };
			};
			const note = "Times are in ms. model_ms is the model's time to answer, over all its calls, failed ones included; tools_ms is the time tool calls ran, apart from waiting for approvals; approvals_ms is the time they waited for a decision; other_ms is the rest, such as waiting to retry the model.";
			if (query.chat) {
				const { turns } = await chatTurns(app, ownerId, query.chat);
				const inWindow = turns.filter((turn) => turn.endedAt >= since.getTime()).reverse().slice(0, limit);
				return scrubValue({ ...base, count: turns.length, items: inWindow.map((turn) => ({ ...totals(query.chat!, turn), steps: stepsOf(turn) })), note });
			}
			const busy = await rows("SELECT chat_id FROM pim_projection.sidebar_session_projection WHERE busy ORDER BY updated_at DESC LIMIT $1", [MAX_AT_WORK]);
			const found = (await Promise.all(busy.map(async (r) => ({ chat: r.chat_id as string, turn: (await chatTurns(app, ownerId, r.chat_id as string)).turns.at(-1) })))).flatMap((x) => (x.turn?.inProgress ? [{ chat: x.chat, turn: x.turn }] : []));
			found.sort((a, b) => b.turn.endedAt - b.turn.startedAt - (a.turn.endedAt - a.turn.startedAt));
			return scrubValue({ ...base, count: found.length, items: found.slice(0, limit).map((x) => totals(x.chat, x.turn)), note: `${note} These are the longest turns of the chats at work now: give chat to read one chat's turns step by step.` });
		}
		case "triggers":
			return scrubValue({ ...base, failures: await rows("SELECT trigger_id, phase, detail, at FROM pim_app.trigger_runs WHERE phase IN ('failed', 'skipped') AND at >= $1 ORDER BY at DESC LIMIT $2", [since, limit]) });
		case "model_calls": {
			const columns = "run_kind, public_chat_id AS chat, agent_id AS agent, provider, model, stop_reason, latency_ms, input_tokens AS input, output_tokens AS output, cost_microusd AS cost, error, request, at";
			const call = (why: string) => (r: Record<string, any>) => ({
				...(scrubValue({ why: why || `stopped with ${r.stop_reason}`, at: r.at, provider: r.provider, model: r.model, run_kind: r.run_kind, agent: r.agent, chat: r.chat, stop_reason: r.stop_reason, latency_ms: r.latency_ms, cost_usd: Number(r.cost) / 1_000_000, input_tokens: Number(r.input), output_tokens: Number(r.output), ...(r.request ? { request: r.request } : {}) }) as object),
				// The provider's own words, already without credentials, are not scrubbed further: `scrub` takes long ids and words such as `max_tokens` for secrets, and they are often what a refused request is about.
				...(r.error ? { error: modelError(String(r.error)) } : {}),
			});
			const failed = (await rows(`SELECT ${columns} FROM pim_app.model_calls WHERE at >= $1 AND stop_reason IN ('error', 'aborted') ORDER BY at DESC LIMIT $2`, [since, limit])).map(call(""));
			const unpriced = (await rows(`SELECT ${columns} FROM pim_app.model_calls WHERE at >= $1 AND cost_microusd = 0 AND input_tokens + output_tokens > 0 ORDER BY at DESC LIMIT $2`, [since, limit])).map(call("no price for this model"));
			const slow = (await rows(`SELECT ${columns} FROM pim_app.model_calls WHERE at >= $1 AND latency_ms >= $3 ORDER BY latency_ms DESC LIMIT $2`, [since, limit, SLOW_CALL_MS])).map(call("slow"));
			const costly = (await rows(`SELECT ${columns} FROM pim_app.model_calls WHERE at >= $1 AND cost_microusd >= 1000000 ORDER BY cost_microusd DESC LIMIT $2`, [since, limit])).map(call("costly"));
			const recent = await rows("SELECT id, run_kind, public_chat_id AS chat, provider, model, input_tokens AS input, output_tokens AS output, cost_microusd AS cost, stop_reason, latency_ms, at FROM pim_app.model_calls WHERE at >= $1 ORDER BY at DESC LIMIT $2", [since, limit]);
			const [t] = await rows("SELECT count(*)::int AS calls, count(*) FILTER (WHERE stop_reason IN ('error', 'aborted'))::int AS errors, coalesce(sum(input_tokens), 0)::bigint AS input, coalesce(sum(output_tokens), 0)::bigint AS output FROM pim_app.model_calls WHERE at >= $1", [since]);
			return {
				...(scrubValue({ ...base, totals: { calls: t.calls, errors: t.errors, input: Number(t.input), output: Number(t.output) }, recent }) as object),
				failures: [...failed, ...unpriced, ...slow, ...costly].slice(0, limit),
				note: `${t.calls} calls in the window, ${t.errors} of them errors or aborted. Slow is ${SLOW_CALL_MS / 1000} s or more, costly $1 or more. A failed or slow call has the request's settings without its content and, under phases, where its time went: preFetchMs is Pim's own preparation before the first request was sent, headersMs the wait for the provider's response headers (a gateway's 524 or 504 arrives here), firstByteMs and firstEventMs the wait from the headers to the first body bytes and the first parsed event, streamMs the rest of the stream, and httpAttempts how many requests the call sent. A failed call also has the provider's error as it answered, and a model that failed and went to the next one is a call of its own.`,
			};
		}
		case "coding":
			return scrubValue({ ...base, threads: await rows("SELECT thread_id, state, state_reason, repo, branch, last_seen_at FROM pim_forge.forge_threads WHERE last_seen_at >= $1 OR state NOT IN ('idle', 'done') ORDER BY last_seen_at DESC NULLS LAST LIMIT $2", [since, limit]).catch(() => []) });
		case "connectors":
			return scrubValue({ ...base, connectors: await rows("SELECT id, kind, name, status, enabled_tools FROM pim_app.connectors ORDER BY created_at LIMIT $1", [limit]) });
		case "approvals":
			return scrubValue({ ...base, approvals: await rows("SELECT id, tool, state, public_chat_id AS chat, created_at, decided_at FROM pim_app.approvals WHERE created_at >= $1 ORDER BY created_at DESC LIMIT $2", [since, limit]) });
		case "provider_cooldowns": {
			const all = await rows("SELECT ref, until, reason FROM pim_app.owner_provider_cooldowns($1) ORDER BY until DESC", [ownerId]);
			return scrubValue({ ...base, count: all.length, items: all.slice(0, limit).map((r) => ({ model: r.ref, active: new Date(r.until).getTime() > Date.now(), until: r.until, reason: r.reason })), note: "While a model cools down after a failure, requests go to the next model of the chat's list; a usage limit's cooldown lasts until it resets. A model's entry goes once it answers again." });
		}
		case "services": {
			const probes = await probeServices(app, env);
			return scrubValue({ ...base, services: probes, failing: probes.filter((p) => p.status === "failed").map((p) => p.service), note: "Each service was tried from the process that ran this tool, with a limit of 4 s. For one that failed, read its log with hostops_logs (the service named in logs) and the host's containers with hostops_stats. The other roles (gate, live, runner, forge, maintenance, canvas, relay) and the proxy are read the same way." });
		}
		case "events": {
			const items = await rows("SELECT at, kind, detail FROM pim_app.diagnostic_events WHERE at >= $1 ORDER BY id DESC LIMIT $2", [since, limit]);
			return {
				...(scrubValue({ ...base, count: items.length }) as object),
				items: items.map((r) => ({ ...(scrubValue({ at: r.at, kind: r.kind, detail: { ...r.detail, error: undefined } }) as object), ...(typeof r.detail?.error === "string" && r.detail.error ? { error: modelError(r.detail.error) } : {}) })),
				note: "The log keeps the last 200 events: models that failed, were slow or cooled down.",
			};
		}
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
		deployment: { publicUrlSet: !!env.PIM_PUBLIC_URL, appsOriginSet: !!env.PIM_APPS_ORIGIN, contentOriginSet: !!env.PIM_CONTENT_ORIGIN, defaultModel: env.PIM_DEFAULT_MODEL ?? null, approvalPolicy: env.PIM_APPROVAL_POLICY ?? "majordomo" },
	});
}

export function diagnosticsRoutes(env: Readonly<Record<string, string | undefined>>): Route[] {
	const admin = async (app: App, p: Principal) => app.identity.authz.enforce(p, "admin:settings");
	return [
		route("GET", "/api/admin/diagnostics", async ({ app, principal, url }) => {
			const p = await principal();
			await admin(app, p);
			const limit = url.searchParams.get("limit");
			return ok(await diagnose(app, p.ownerId, { ...(url.searchParams.get("chat") ? { chat: url.searchParams.get("chat")! } : {}), ...(url.searchParams.get("kind") ? { kind: url.searchParams.get("kind")! } : {}), ...(url.searchParams.get("since") ? { since: url.searchParams.get("since")! } : {}), ...(limit ? { limit: Number(limit) } : {}) }, env));
		}),
		route("GET", "/api/admin/health", async ({ app, principal }) => (await admin(app, await principal()), ok(await health(app, env)))),
	];
}
