/**
 * `/api/triggers` as the triggers screen reads it: a trigger's own fields (agent, label, instruction, source, condition, destination), the
 * revision it is changed at, what it can do on this Pim, and its runs. V2 keeps a trigger as a validated spec with a lifecycle; this puts the
 * app's flat shape over it, and `If-Match` over the time it last changed, so a change made on a stale screen is refused, not applied.
 */
import { BadRequestError, NotFoundError } from "@pim/v2-app/errors";
import { ok, type Reply, type Route, route } from "@pim/v2-app/http";
import type { App } from "@pim/v2-app/app";
import type { Tx } from "@pim/v2-app/db";
import type { Principal } from "@pim/v2-contracts/identity";
import { grantComputerTrigger, sourceConfigHash } from "../computer-triggers.ts";
import { previewFirings } from "@pim/triggers/time";
import { runsOnComputer, TRIGGER_LIFECYCLES, type TriggerHealth, type TriggerLifecycle, type TriggerSpec } from "@pim/triggers/spec";

const ms = (value: Date | string | null | undefined): number | null => (value ? new Date(value).getTime() : null);
const DAY = 86_400_000;
const DELIVERY_TTL_MS = DAY;

export type Row = { id: string; lifecycle: TriggerLifecycle; spec: TriggerSpec; created_at: Date; updated_at: Date; health: TriggerHealth; health_detail: string | null; last_observed_at: Date | null; failures: number; retry_after: Date | null };
const COLUMNS = "id, lifecycle, spec, created_at, updated_at, health, health_detail, last_observed_at, failures, retry_after";
export type Context = { computerPaired: boolean; granted: Map<string, string | null> };

export async function contextOf(tx: Tx): Promise<Context> {
	const computerPaired = !!(await tx.query("SELECT 1 FROM pim_app.computers WHERE revoked_at IS NULL LIMIT 1")).rowCount;
	const granted = new Map((await tx.query("SELECT trigger_id, config_hash FROM pim_app.trigger_computer_grants WHERE revoked_at IS NULL")).rows.map((r) => [r.trigger_id as string, r.config_hash as string | null] as const));
	return { computerPaired, granted };
}

/** What a source can do here: a timetable and a connector's events run; a poll, stream or process runs on the paired computer; watching files is kept as a draft, as nothing observes files yet. */
export function capabilityOf(kind: string, ctx: Context) {
	if (kind === "time" || kind === "connector_event") return { status: "available", delivers: true, reason: null };
	if (kind === "file") return { status: "unavailable", delivers: false, reason: "not_wired" };
	return ctx.computerPaired ? { status: "available", delivers: true, reason: null } : { status: "draft_only", delivers: false, reason: "computer_not_paired" };
}

/** Every kind of source, and what it can do here now: the same answer for the triggers screen and for an agent's `list_trigger_sources`. */
export function sourcesOf(ctx: Context) {
	return ["time", "connector_event", "poll", "stream", "process", "file"].map((kind) => ({ kind, ...capabilityOf(kind, ctx), ...(kind === "time" ? { schedules: ["once", "cron", "interval"] } : {}), ...(kind === "poll" || kind === "stream" || kind === "process" ? { requiresGrant: true, computerPaired: ctx.computerPaired } : {}) }));
}

function policiesOf(spec: TriggerSpec) {
	const source = spec.source;
	return {
		lateness: source.kind !== "time" ? null : source.schedule === "once" ? { maxLatenessMs: source.maxLatenessMs, missed: "recorded" } : { catchUpMs: source.catchUpMs, coalesce: "latest_due" },
		maxPendingEvents: spec.delivery.maxPendingEvents,
		pendingSnapshots: spec.delivery.maxPendingEvents === null ? 1 : null,
		rawSamples: false,
		runsAtOnce: 1,
		deliveryTtlMs: DELIVERY_TTL_MS,
		replayHorizonMs: source.kind === "time" ? null : 7 * DAY,
		staleAfterMs: spec.condition?.staleAfterMs ?? null,
	};
}

export const revisionOf = (row: Row) => row.updated_at.getTime();

export async function viewOf(app: App, row: Row, ctx: Context) {
	const spec = row.spec;
	const live = row.lifecycle !== "deleted" && row.lifecycle !== "ended";
	let nextFiringAt: number | null = null;
	if (spec.source.kind === "time" && live) {
		try {
			nextFiringAt = previewFirings(spec.source, { now: Date.now(), count: 1 }).firings[0]?.at ?? null;
		} catch {
			// A clock outside what the time engine takes in has no next firing to show.
		}
	}
	void app;
	const required = runsOnComputer(spec.source);
	return {
		id: row.id,
		revision: revisionOf(row),
		lifecycle: row.lifecycle,
		// An enabled trigger on the computer with no computer paired is waiting for one; otherwise what the computer's runtime and its connection said last.
		health: required && row.lifecycle === "enabled" && !ctx.computerPaired ? "waiting_computer" : row.health,
		healthDetail: row.health_detail,
		...(required ? { observation: { lastObservedAt: ms(row.last_observed_at), failures: row.failures, retryAfter: ms(row.retry_after) } } : {}),
		agentId: spec.owningAgentId,
		label: spec.label,
		instruction: spec.instruction,
		source: spec.source,
		condition: spec.condition,
		destination: spec.destination,
		origin: spec.originChatId === "api" ? { type: "api" } : { type: "chat", chatId: spec.originChatId },
		policies: policiesOf(spec),
		schedule: spec.source.kind === "time" ? { nextFiringAt, nextCheckAt: null } : null,
		capability: capabilityOf(spec.source.kind, ctx),
		grant: { required, state: !required ? "not_required" : !ctx.granted.has(row.id) ? "missing" : ctx.granted.get(row.id) === sourceConfigHash(spec.source) ? "current" : "not_current" },
		createdAt: row.created_at.getTime(),
		updatedAt: row.updated_at.getTime(),
	};
}

export async function load(app: App, p: Principal, id: string) {
	return app.db.owner(p.ownerId, async (tx) => {
		const row = (await tx.query(`SELECT ${COLUMNS} FROM pim_app.triggers WHERE id = $1 AND lifecycle <> 'deleted'`, [id])).rows[0] as Row | undefined;
		if (!row) throw new NotFoundError("No such trigger");
		return { row, ctx: await contextOf(tx) };
	});
}

const answer = async (app: App, p: Principal, id: string, status = 200): Promise<Reply> => {
	const { row, ctx } = await load(app, p, id);
	return ok(await viewOf(app, row, ctx), status, { etag: `"${revisionOf(row)}"` });
};

/** `If-Match: "3"`: the revision the person reviewed. A change without one is refused, and so is one made on another revision. */
function staleRevision(header: string | string[] | undefined, row: Row): Reply | null {
	const text = Array.isArray(header) ? header[0] : header;
	if (!text) return { status: 428, body: { error: "Name the revision this change is for (If-Match)", code: "revision_required" } };
	const named = /^"?(\d+)"?$/.exec(text.trim());
	if (!named) throw new BadRequestError('If-Match must name a revision, such as "3"');
	return Number(named[1]) === revisionOf(row) ? null : { status: 409, body: { error: "The trigger was changed since that revision", code: "revision_conflict", currentRevision: revisionOf(row) } };
}

/** Instants may be given as ISO 8601 text with an offset. */
export function instants(source: unknown): unknown {
	if (typeof source !== "object" || source === null) return source;
	const s = { ...(source as Record<string, unknown>) };
	for (const key of ["at", "anchorAt", "expiresAt"]) {
		if (typeof s[key] === "string") {
			const t = Date.parse(s[key] as string);
			if (Number.isNaN(t)) throw new BadRequestError(`${key} is not a time`);
			s[key] = t;
		}
	}
	return s;
}

async function defaultAgent(app: App, p: Principal): Promise<string> {
	const id = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.agents WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1")).rows[0]?.id as string | undefined);
	if (!id) throw new BadRequestError("Make an agent first: a trigger is an agent's work");
	return id;
}

/** Where a run is, as the triggers screen words it. A run handed to a chat is `queued` until the Runner has taken it, then `running` until its turn ends; the turn ending is `completed`, never that its work succeeded. */
function runState(r: Record<string, any>): { state: string; status: string } {
	const reason = ((r.detail ?? {}) as { reason?: string }).reason;
	switch (r.phase as string) {
		case "pending": return { state: "pending", status: "pending" };
		case "fired": return r.command_state === "runtime_committed" ? { state: "running", status: "delivered" } : { state: "queued", status: "delivered" };
		case "delivered": return { state: "accepted", status: "delivered" };
		case "completed": return { state: "completed", status: "delivered" };
		case "unknown": return { state: "outcome_unknown", status: "outcome_unknown" };
		case "failed": return { state: "failed", status: "failed" };
		case "skipped": return reason === "superseded" ? { state: "superseded", status: "superseded" } : reason === "missed" ? { state: "missed", status: "missed" } : { state: "not_submitted", status: "skipped" };
		default: return { state: "outcome_unknown", status: "outcome_unknown" };
	}
}
const RUN_FINAL = new Set(["completed", "failed", "missed", "superseded", "not_submitted", "cancelled"]);

/** A run as the triggers screen and `GET /api/trigger-runs/:run` read it: what the occurrence was, and where it got to. */
function runView(r: Record<string, any>, row: Row) {
	const at = ms(r.at)!;
	const detail = (r.detail ?? {}) as { scheduledFor?: number; older?: unknown; event?: string };
	const mapped = runState(r);
	const delivered = ms(r.delivered_at);
	return {
		id: r.id as string, triggerId: row.id, revision: revisionOf(row), state: mapped.state, outcomeKnown: RUN_FINAL.has(mapped.state), occurrenceStatus: mapped.status, phase: r.phase as string,
		dueAt: detail.scheduledFor ?? at,
		evidence: detail.scheduledFor !== undefined ? { reason: "time", scheduledFor: detail.scheduledFor, ...(detail.older === undefined ? {} : { older: detail.older }) } : { reason: detail.event ?? "event", truth: "true", observedAt: at, fields: [] },
		chatId: (r.chat as string | null) ?? null, deliverBy: null, submittedAt: delivered ?? (r.phase === "fired" ? at : null), acceptedAt: r.command_state === "runtime_committed" ? ms(r.committed_at) : null, endedAt: ms(r.ended_at),
		deferrals: 0, unknownAnswers: mapped.state === "outcome_unknown" ? 1 : 0, createdAt: at, updatedAt: ms(r.ended_at) ?? delivered ?? at,
		...(r.last_error ? { error: r.last_error as string } : {}),
	};
}

export function triggerRoutes(): Route[] {
	return [
		// The person's consent to run one trigger's source, as it is now, on their computer; the grant is bound to that source's configuration (../computer-triggers.ts).
		route("POST", "/api/triggers/:id/computer-grant", async ({ app, principal, params, json }) => {
			await grantComputerTrigger(app, await principal(), params[0]!, String(((await json()) as { computerId?: unknown }).computerId ?? ""));
			return ok({ ok: true });
		}),
		route("GET", "/api/triggers", async ({ app, principal, url }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const q = url.searchParams;
			const lifecycle = q.get("lifecycle");
			if (lifecycle && !TRIGGER_LIFECYCLES.includes(lifecycle as TriggerLifecycle)) throw new BadRequestError(`lifecycle is one of ${TRIGGER_LIFECYCLES.join(", ")}`);
			const limit = Math.min(Math.max(Number(q.get("limit")) || 20, 1), 50);
			const cursor = /^(\d+):(.+)$/.exec(q.get("cursor") ?? "");
			const { rows, ctx } = await app.db.owner(p.ownerId, async (tx) => ({
				rows: (await tx.query(
					`SELECT ${COLUMNS} FROM pim_app.triggers
					 WHERE lifecycle <> 'deleted' AND ($1::text IS NULL OR lifecycle = $1) AND ($2::text IS NULL OR spec->>'owningAgentId' = $2) AND ($3::text IS NULL OR spec->'source'->>'kind' = $3)
					   AND ($4::bigint IS NULL OR (created_at, id) > (to_timestamp($4::bigint / 1000.0), $5))
					 ORDER BY created_at, id LIMIT $6`,
					[lifecycle, q.get("agentId"), q.get("sourceKind"), cursor ? Number(cursor[1]) : null, cursor ? cursor[2] : null, limit + 1],
				)).rows as Row[],
				ctx: await contextOf(tx),
			}));
			const page = rows.slice(0, limit);
			const last = page.at(-1);
			return ok({ triggers: await Promise.all(page.map((r) => viewOf(app, r, ctx))), nextCursor: rows.length > limit && last ? `${last.created_at.getTime()}:${last.id}` : null });
		}),
		route("GET", "/api/triggers/:id", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			return answer(app, p, params[0]!);
		}),
		route("POST", "/api/triggers", async ({ app, principal, json, req }) => {
			const p = await principal();
			const b = await json();
			// A retried create with the same `Idempotency-Key` gives the trigger the first one made.
			const header = req.headers["idempotency-key"];
			const key = (Array.isArray(header) ? header[0] : header)?.trim() || null;
			if (key !== null && key.length > 128) throw new BadRequestError("Idempotency-Key is at most 128 characters");
			if (b.spec !== undefined) return ok(await app.triggers.create(p, { spec: b.spec, key }), 201);
			const spec = {
				version: 1, owningAgentId: typeof b.agentId === "string" ? b.agentId : await defaultAgent(app, p), originChatId: "api",
				label: b.label, instruction: b.instruction, source: instants(b.source), condition: b.condition ?? null, destination: b.destination, delivery: b.delivery, authorizationRef: null,
			};
			const made = await app.triggers.create(p, { spec, key });
			if (made.replayed) return answer(app, p, made.id, 200);
			if (b.enabled === true) await app.triggers.setLifecycle(p, made.id, "enabled");
			return answer(app, p, made.id, 201);
		}),
		route("PATCH", "/api/triggers/:id", async ({ app, principal, params, json, req }) => {
			const p = await principal();
			const { row } = await load(app, p, params[0]!);
			const stale = staleRevision(req.headers["if-match"], row);
			if (stale) return stale;
			const b = await json();
			for (const key of Object.keys(b)) if (!["label", "instruction", "source", "condition", "destination", "delivery"].includes(key)) throw new BadRequestError(`${key} cannot be changed`);
			const spec = { ...row.spec, ...(b.source === undefined ? {} : { source: instants(b.source) }), ...Object.fromEntries(["label", "instruction", "condition", "destination", "delivery"].filter((k) => b[k] !== undefined).map((k) => [k, b[k]])) };
			// Delivery follows the source's kind: a source of another kind starts from its own defaults, not the old one's.
			if (b.source !== undefined && b.delivery === undefined && (b.source as { kind?: string }).kind !== row.spec.source.kind) delete (spec as { delivery?: unknown }).delivery;
			await app.triggers.update(p, params[0]!, { spec });
			return answer(app, p, params[0]!);
		}),
		route("POST", "/api/triggers/:id/pause", async ({ app, principal, params, req }) => {
			const p = await principal();
			const { row } = await load(app, p, params[0]!);
			const stale = staleRevision(req.headers["if-match"], row);
			if (stale) return stale;
			await app.triggers.setLifecycle(p, params[0]!, "paused");
			return answer(app, p, params[0]!);
		}),
		route("POST", "/api/triggers/:id/resume", async ({ app, principal, params, req }) => {
			const p = await principal();
			const { row } = await load(app, p, params[0]!);
			const stale = staleRevision(req.headers["if-match"], row);
			if (stale) return stale;
			await app.triggers.setLifecycle(p, params[0]!, "enabled");
			return answer(app, p, params[0]!);
		}),
		route("DELETE", "/api/triggers/:id", async ({ app, principal, params, req }) => {
			const p = await principal();
			const { row, ctx } = await load(app, p, params[0]!);
			const stale = staleRevision(req.headers["if-match"], row);
			if (stale) return stale;
			const trigger = await viewOf(app, row, ctx);
			await app.triggers.setLifecycle(p, params[0]!, "deleted");
			return ok({ deleted: true, trigger: { ...trigger, lifecycle: "deleted" } });
		}),
		route("POST", "/api/triggers/:id/test", async ({ app, principal, params, json }) => {
			const p = await principal();
			const { row, ctx } = await load(app, p, params[0]!);
			const view = await viewOf(app, row, ctx);
			const b = await json();
			const dry = (await app.triggers.test(p, params[0]!, { ...(Number.isInteger(b.count) ? { count: b.count } : {}), ...(b.samples !== undefined ? { samples: b.samples } : {}) })) as { firings?: unknown[]; skippedCount?: number; exhausted?: boolean; evaluations?: unknown[] };
			const blockers = [...(view.capability.status !== "available" ? ["source_not_wired"] : []), ...(view.grant.required && view.grant.state !== "current" ? ["grant_required"] : [])];
			return ok({
				dryRun: true, valid: true, sourceKind: row.spec.source.kind, capability: view.capability, grant: view.grant, policies: view.policies, blockers,
				id: row.id, revision: view.revision, lifecycle: row.lifecycle,
				...(dry.firings ? { firings: dry.firings, skippedCount: dry.skippedCount ?? 0, exhausted: dry.exhausted ?? false } : {}),
				...(dry.evaluations ? { evaluations: dry.evaluations } : {}),
			});
		}),
		route("GET", "/api/trigger-runs/:run", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const run = () => app.db.owner(p.ownerId, async (tx) => (await tx.query(
				`SELECT r.id, r.trigger_id, r.phase, r.command_id, r.detail, r.at, r.delivered_at, r.ended_at, r.last_error, c.public_chat_id AS chat, c.state AS command_state, c.committed_at
				 FROM pim_app.trigger_runs r LEFT JOIN pim_app.accepted_commands c ON c.command_id = r.command_id AND c.owner_id = r.owner_id
				 WHERE r.id = $1 AND r.phase <> 'test'`, [params[0]!])).rows[0]);
			const found = await run();
			if (!found) throw new NotFoundError("No such trigger run");
			// A run that is over says so: settled before it is shown.
			await app.triggers.settle(p.ownerId, found.trigger_id);
			return ok(runView((await run())!, (await load(app, p, found.trigger_id)).row));
		}),
		route("GET", "/api/triggers/:id/runs", async ({ app, principal, params, url }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const { row } = await load(app, p, params[0]!);
			await app.triggers.settle(p.ownerId, row.id);
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
			const cursor = /^(\d+):(.+)$/.exec(url.searchParams.get("cursor") ?? "");
			const runs = await app.db.owner(p.ownerId, async (tx) => (await tx.query(
				`SELECT r.id, r.phase, r.command_id, r.detail, r.at, r.delivered_at, r.ended_at, r.last_error, c.public_chat_id AS chat, c.state AS command_state, c.committed_at
				 FROM pim_app.trigger_runs r LEFT JOIN pim_app.accepted_commands c ON c.command_id = r.command_id AND c.owner_id = r.owner_id
				 WHERE r.trigger_id = $1 AND r.phase <> 'test' AND ($2::bigint IS NULL OR (r.at, r.id) < (to_timestamp($2::bigint / 1000.0), $3))
				 ORDER BY r.at DESC, r.id DESC LIMIT $4`,
				[params[0]!, cursor ? Number(cursor[1]) : null, cursor ? cursor[2] : null, limit + 1],
			)).rows);
			const page = runs.slice(0, limit);
			const last = page.at(-1);
			return ok({
				runs: page.map((r) => runView(r, row)),
				nextCursor: runs.length > limit && last ? `${ms(last.at)}:${last.id}` : null,
			});
		}),
	];
}
