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
import { previewFirings } from "@pim/triggers/time";
import { runsOnComputer, TRIGGER_LIFECYCLES, type TriggerLifecycle, type TriggerSpec } from "@pim/triggers/spec";

const ms = (value: Date | string | null | undefined): number | null => (value ? new Date(value).getTime() : null);
const DAY = 86_400_000;
const DELIVERY_TTL_MS = DAY;

type Row = { id: string; lifecycle: TriggerLifecycle; spec: TriggerSpec; created_at: Date; updated_at: Date };
type Context = { computerPaired: boolean; granted: Set<string> };

async function contextOf(tx: Tx): Promise<Context> {
	const computerPaired = !!(await tx.query("SELECT 1 FROM pim_app.computers WHERE revoked_at IS NULL LIMIT 1")).rowCount;
	const granted = new Set((await tx.query("SELECT trigger_id FROM pim_app.trigger_computer_grants WHERE revoked_at IS NULL")).rows.map((r) => r.trigger_id as string));
	return { computerPaired, granted };
}

/** What a source can do here: a timetable and a connector's events run; what runs on the computer, or watches files, is kept as a draft. */
function capabilityOf(kind: string, ctx: Context) {
	if (kind === "time" || kind === "connector_event") return { status: "available", delivers: true, reason: null };
	if (kind === "file") return { status: "unavailable", delivers: false, reason: "not_wired" };
	return { status: "draft_only", delivers: false, reason: ctx.computerPaired ? "not_wired" : "computer_not_paired" };
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

const revisionOf = (row: Row) => row.updated_at.getTime();

async function viewOf(app: App, row: Row, ctx: Context) {
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
		health: "unknown",
		healthDetail: null,
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
		grant: { required, state: !required ? "not_required" : ctx.granted.has(row.id) ? "current" : "missing" },
		createdAt: row.created_at.getTime(),
		updatedAt: row.updated_at.getTime(),
	};
}

async function load(app: App, p: Principal, id: string) {
	return app.db.owner(p.ownerId, async (tx) => {
		const row = (await tx.query("SELECT id, lifecycle, spec, created_at, updated_at FROM pim_app.triggers WHERE id = $1 AND lifecycle <> 'deleted'", [id])).rows[0] as Row | undefined;
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
function instants(source: unknown): unknown {
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

const RUN_STATE: Record<string, { state: string; status: string }> = {
	fired: { state: "accepted", status: "delivered" },
	delivered: { state: "accepted", status: "delivered" },
	skipped: { state: "missed", status: "missed" },
	failed: { state: "not_submitted", status: "failed" },
};

export function triggerRoutes(): Route[] {
	return [
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
					`SELECT id, lifecycle, spec, created_at, updated_at FROM pim_app.triggers
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
		route("POST", "/api/triggers", async ({ app, principal, json }) => {
			const p = await principal();
			const b = await json();
			if (b.spec !== undefined) return ok(await app.triggers.create(p, { spec: b.spec }), 201);
			const spec = {
				version: 1, owningAgentId: typeof b.agentId === "string" ? b.agentId : await defaultAgent(app, p), originChatId: "api",
				label: b.label, instruction: b.instruction, source: instants(b.source), condition: b.condition ?? null, destination: b.destination, delivery: b.delivery, authorizationRef: null,
			};
			const made = await app.triggers.create(p, { spec });
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
			const dry = (await app.triggers.test(p, params[0]!, { ...(Number.isInteger(b.count) ? { count: b.count } : {}) })) as { firings?: unknown[]; skippedCount?: number; exhausted?: boolean };
			const blockers = [...(view.capability.status !== "available" ? ["source_not_wired"] : []), ...(view.grant.required && view.grant.state !== "current" ? ["grant_required"] : [])];
			return ok({
				dryRun: true, valid: true, sourceKind: row.spec.source.kind, capability: view.capability, grant: view.grant, policies: view.policies, blockers,
				id: row.id, revision: view.revision, lifecycle: row.lifecycle,
				...(dry.firings ? { firings: dry.firings, skippedCount: dry.skippedCount ?? 0, exhausted: dry.exhausted ?? false } : {}),
			});
		}),
		route("GET", "/api/triggers/:id/runs", async ({ app, principal, params, url }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const { row } = await load(app, p, params[0]!);
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
			const cursor = /^(\d+):(.+)$/.exec(url.searchParams.get("cursor") ?? "");
			const runs = await app.db.owner(p.ownerId, async (tx) => (await tx.query(
				`SELECT r.id, r.phase, r.command_id, r.detail, r.at, c.public_chat_id AS chat
				 FROM pim_app.trigger_runs r LEFT JOIN pim_app.accepted_commands c ON c.command_id = r.command_id AND c.owner_id = r.owner_id
				 WHERE r.trigger_id = $1 AND r.phase <> 'test' AND ($2::bigint IS NULL OR (r.at, r.id) < (to_timestamp($2::bigint / 1000.0), $3))
				 ORDER BY r.at DESC, r.id DESC LIMIT $4`,
				[params[0]!, cursor ? Number(cursor[1]) : null, cursor ? cursor[2] : null, limit + 1],
			)).rows);
			const page = runs.slice(0, limit);
			const last = page.at(-1);
			return ok({
				runs: page.map((r) => {
					const at = ms(r.at)!;
					const detail = (r.detail ?? {}) as { scheduledFor?: number; older?: unknown; event?: string };
					const mapped = RUN_STATE[r.phase as string] ?? { state: "outcome_unknown", status: "outcome_unknown" };
					return {
						id: r.id as string, triggerId: row.id, revision: revisionOf(row), state: mapped.state, outcomeKnown: mapped.state !== "accepted" && mapped.state !== "outcome_unknown", occurrenceStatus: mapped.status, phase: r.phase as string,
						dueAt: detail.scheduledFor ?? at,
						evidence: detail.scheduledFor !== undefined ? { reason: "time", scheduledFor: detail.scheduledFor, ...(detail.older === undefined ? {} : { older: detail.older }) } : { reason: detail.event ?? "event", truth: "true", observedAt: at, fields: [] },
						chatId: (r.chat as string | null) ?? null, deliverBy: null, submittedAt: r.phase === "fired" ? at : null, acceptedAt: r.phase === "fired" ? at : null, endedAt: r.phase === "fired" ? null : at,
						deferrals: 0, unknownAnswers: 0, createdAt: at, updatedAt: at,
					};
				}),
				nextCursor: runs.length > limit && last ? `${ms(last.at)}:${last.id}` : null,
			});
		}),
	];
}
