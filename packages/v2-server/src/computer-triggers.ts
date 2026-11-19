/**
 * The space's side of triggers that run on the person's computer: what pim-computer's triggers runtime (computer/triggers-runtime.ts, docs/triggers-runtime.md)
 * says over the computer's own connection, in `triggers.v1`, is answered here. The Gate that holds the computer's socket speaks for the owner: it checks the runtime's
 * `hello` against the id the token names, keeps the epoch and desired revision with that runtime in PostgreSQL, reconciles the enabled poll, stream and process
 * triggers that have a current grant (and renews the lease before it lapses, and sooner when the desired set changed), and hands each observation to the trigger's
 * chat through `fireComputerEvent`, acknowledging it only once that has returned. What it says is codes and ids, never what the computer observed.
 */
import { createHash } from "node:crypto";
import type { App } from "@pim/v2-app/app";
import { type ComputerTriggersHost, TRIGGERS_ENVELOPE } from "@pim/v2-app/relay";
import { runsOnComputer, type TriggerHealth, type TriggerSpec } from "@pim/triggers/spec";
import { RETRY_AFTER_MS } from "@pim/v2-app/triggers";
import { evaluate } from "@pim/triggers/condition";
import { type FiringEvidence, firingText } from "@pim/triggers/firing-text";
import type { JsonValue } from "@pim/triggers/validate";
import type { Principal } from "@pim/v2-contracts/identity";
import { BadRequestError, NotFoundError } from "@pim/v2-app/errors";
import { CapabilityUnavailableError } from "@pim/v2-contracts/authz";
import { newId } from "@pim/v2-app/ids";

export const PROTOCOL = "triggers.v1";
const INBOUND_BYTES = 65_536 + TRIGGERS_ENVELOPE.length + 1;
const LEASE_MS = 120_000;
const RENEW_MS = 40_000;
const CHECK_MS = 5_000;
const MAX_SOURCES = 256;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/** The digest of a source's configuration, as the runtime computes it: every field of it (`sourceConfigHash` in computer/triggers-runtime.ts). */
export const sourceConfigHash = (source: object): string => sha256(`${PROTOCOL}/source\n${canonical(source)}`);

/** The digest of what a grant consents to, as the host checks it (`grantScopeHash` in computer/triggers-host.ts): one source of one trigger, on one computer, under one grant. */
export const grantScopeHash = (scope: { space: string; runtimeId: string; triggerId: string; sourceId: string; configHash: string; grantRef: string }): string =>
	sha256(`${PROTOCOL}/grant\n${JSON.stringify({ configHash: scope.configHash, grantRef: scope.grantRef, runtimeId: scope.runtimeId, sourceId: scope.sourceId, space: scope.space, triggerId: scope.triggerId })}`);

/** The id of the runtime of the computer with this token, as computer/triggers-host.ts makes it from the token alone. */
export const runtimeIdOfToken = (token: string): string => `rt_${sha256(`${PROTOCOL}/runtime\n${sha256(token)}`).slice(0, 32)}`;

/** A trigger's revision, which is also its generation here: it changes whenever the trigger does, and with it the source's identity. */
export const revisionOf = (updatedAt: Date): number => Math.max(1, updatedAt.getTime());

type Frame = Record<string, unknown> & { type: string };

/** One computer's connection, as far as triggers need it: its owner, which computer it is, and a way to send. */
export type TriggersConnection = { readonly ownerId: string; readonly computerId: string; sendRaw(text: string): void };

export class ComputerTriggers implements ComputerTriggersHost {
	constructor(private readonly app: App) {}

	/** Starts speaking `triggers.v1` on a computer's connection; it sends nothing until the runtime says hello. */
	open(connection: TriggersConnection, token: string): { receive(raw: string): void; close(): void } {
		return new Link(this.app, connection, runtimeIdOfToken(token));
	}
}

class Link {
	#connectionId: string | null = null;
	#epoch = 0;
	#timer: NodeJS.Timeout | null = null;
	#sentAt = 0;
	#lastDigest: string | null = null;
	#serial: Promise<unknown> = Promise.resolve();
	#closed = false;

	constructor(private readonly app: App, private readonly connection: TriggersConnection, private readonly runtimeId: string) {}

	get #db() {
		return this.app.db;
	}

	receive(raw: string): void {
		if (raw.length > INBOUND_BYTES || Buffer.byteLength(raw) > INBOUND_BYTES || !raw.endsWith("}")) return;
		let frame: unknown;
		try {
			frame = JSON.parse(raw.slice(TRIGGERS_ENVELOPE.length, -1));
		} catch {
			return;
		}
		if (typeof frame !== "object" || frame === null || (frame as Frame).protocol !== PROTOCOL || typeof (frame as Frame).type !== "string") return;
		const f = frame as Frame;
		this.#serial = this.#serial.then(() => this.#handle(f)).catch(() => undefined);
	}

	close(): void {
		this.#closed = true;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		// The computer's connection is gone: what it ran is reconnecting until it says hello again.
		if (this.#connectionId !== null) void this.#healthAll("reconnecting", null).catch(() => undefined);
	}

	async #handle(f: Frame): Promise<void> {
		if (this.#closed) return;
		if (f.type === "hello") return this.#hello(f);
		// Everything else is read only on the connection the runtime said hello on, in the epoch the space reconciled it in.
		if (this.#connectionId === null || this.#epoch === 0 || f.serverEpoch !== this.#epoch) return;
		if (f.type === "observation") return this.#observation(f);
		if (f.type === "reconciled" || f.type === "installed" || f.type === "health" || f.type === "stopped") return this.#health(f);
		if (f.type === "gap") return this.#ack([{ sequence: f.sequence, eventId: f.eventId, result: "accepted", reason: null, retryAfterMs: null }]);
	}

	async #hello(f: Frame): Promise<void> {
		// A runtime that has seen no epoch says `lastEpoch: null`.
		const last = f.lastEpoch === null ? 0 : f.lastEpoch;
		if (f.runtimeId !== this.runtimeId || typeof f.connectionId !== "string" || !Number.isSafeInteger(last)) return;
		const { ownerId } = this.connection;
		this.#connectionId = f.connectionId;
		// The epoch is kept per runtime: a reconnect resumes it unless the runtime has seen a newer one than the space remembers.
		this.#epoch = await this.#db.owner(ownerId, async (tx) => {
			const row = (await tx.query("SELECT server_epoch FROM pim_app.trigger_computer_runtimes WHERE runtime_id = $1", [this.runtimeId])).rows[0];
			const epoch = row ? (last as number <= row.server_epoch ? (row.server_epoch as number) : (last as number) + 1) : (last as number) + 1;
			await tx.query("INSERT INTO pim_app.trigger_computer_runtimes (owner_id, runtime_id, server_epoch) VALUES ($1,$2,$3) ON CONFLICT (owner_id, runtime_id) DO UPDATE SET server_epoch = $3, updated_at = now()", [ownerId, this.runtimeId, epoch]);
			return epoch;
		});
		// Until the runtime answers the reconcile that follows, every trigger it runs is reconnecting.
		await this.#healthAll("reconnecting", null);
		await this.#reconcile(true);
		if (!this.#timer && !this.#closed) {
			this.#timer = setInterval(() => void (this.#serial = this.#serial.then(() => this.#reconcile(false)).catch(() => undefined)), CHECK_MS);
			this.#timer.unref();
		}
	}

	/** Sends the desired set: the same revision again, to renew the lease, when nothing changed; the next revision when something did. */
	async #reconcile(force: boolean): Promise<void> {
		if (this.#closed || this.#connectionId === null) return;
		const { ownerId, computerId } = this.connection;
		const desired = await desiredOnComputer(this.app, ownerId, computerId);
		const sources = desired.slice(0, MAX_SOURCES).map((d) => ({
			triggerId: d.triggerId,
			sourceId: `${d.triggerId}#${d.revision}`,
			revision: d.revision,
			generation: d.revision,
			configHash: d.configHash,
			source: d.source,
			grant: { grantRef: d.grantRef, scopeHash: grantScopeHash({ space: ownerId, runtimeId: this.runtimeId, triggerId: d.triggerId, sourceId: `${d.triggerId}#${d.revision}`, configHash: d.configHash, grantRef: d.grantRef }) },
			checkpoint: d.checkpoint,
		}));
		// A checkpoint moves with every observation, which is not a change of what runs: the digest leaves it out, so the revision stays while an observer works.
		const digest = sha256(canonical(sources.map(({ checkpoint: _checkpoint, ...rest }) => rest)));
		const now = Date.now();
		if (!force && digest === this.#lastDigest && now - this.#sentAt < RENEW_MS) return;
		const revision = await this.#db.owner(ownerId, async (tx) => {
			const row = (await tx.query("SELECT desired_revision, desired_digest FROM pim_app.trigger_computer_runtimes WHERE runtime_id = $1", [this.runtimeId])).rows[0];
			const next = row && row.desired_digest === digest ? (row.desired_revision as number) : ((row?.desired_revision as number | undefined) ?? 0) + 1;
			await tx.query("UPDATE pim_app.trigger_computer_runtimes SET desired_revision = $2, desired_digest = $3, updated_at = now() WHERE runtime_id = $1", [this.runtimeId, next, digest]);
			return next;
		});
		this.#lastDigest = digest;
		this.#sentAt = now;
		this.#send({ protocol: PROTOCOL, type: "reconcile", binding: { space: ownerId, runtimeId: this.runtimeId }, connectionId: this.#connectionId, serverEpoch: this.#epoch, desiredRevision: revision, leaseMs: LEASE_MS, sources });
	}

	async #observation(f: Frame): Promise<void> {
		const { sequence, eventId, triggerId, generation, occurredAt } = f;
		if (!Number.isSafeInteger(sequence) || typeof eventId !== "string" || typeof triggerId !== "string" || !Number.isSafeInteger(generation) || !Number.isSafeInteger(occurredAt)) return;
		const verdict = await fireComputerEvent(this.app, this.connection.ownerId, this.connection.computerId, { triggerId, generation: generation as number, eventId, observedAt: occurredAt as number, data: (f.data ?? null) as never, gap: f.coalesced !== null && f.coalesced !== undefined, checkpoint: checkpointOf(f.checkpoint) });
		// The ack is sent after the occurrence was admitted, which is durable; a failure above sends none, and the runtime sends the observation again.
		this.#ack([{ sequence, eventId, result: verdict.result, reason: verdict.reason ?? null, retryAfterMs: verdict.result === "deferred" ? (verdict.retryAfterMs ?? RETRY_AFTER_MS) : null }]);
	}

	/** What the runtime says of a source (it was installed, it runs, it is degraded or failed, it stopped) is the trigger's health, as codes only; a frame of an older generation says nothing of the trigger as it is now. */
	async #health(f: Frame): Promise<void> {
		const { ownerId } = this.connection;
		const triggerId = f.triggerId;
		if (typeof triggerId !== "string" || !Number.isSafeInteger(f.generation)) return;
		const row = await this.#db.owner(ownerId, async (tx) => (await tx.query("SELECT updated_at FROM pim_app.triggers WHERE id = $1 AND lifecycle <> 'deleted'", [triggerId])).rows[0]);
		if (!row || revisionOf(row.updated_at as Date) !== f.generation) return;
		const set = (health: TriggerHealth, detail: string | null, from?: readonly TriggerHealth[]) => this.app.triggers.setHealth(ownerId, triggerId, health, detail, from);
		const code = (value: unknown) => (typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null);
		if (f.type === "installed") return set("healthy", null);
		if (f.type === "health") {
			const detail = code(f.code);
			if (detail === null) return;
			if (f.status === "ok") return set("healthy", null);
			if (f.status === "degraded") return set("gap", detail);
			if (f.status === "error") return set(detail === "auth_denied" ? "auth_required" : "configuration_error", detail);
			return;
		}
		if (f.type === "stopped") {
			const reason = code(f.reason);
			if (reason === "revoked" || reason === "consent_changed") return set("auth_required", reason);
			if (reason === "invalid" || reason === "start_failed") return set("configuration_error", reason);
			return;
		}
		// The answer to a reconcile: a source that runs is healthy again unless something worse is recorded, and one that is invalid is a configuration error.
		if (f.type === "reconciled" && Array.isArray(f.sources)) {
			for (const source of f.sources as { triggerId?: unknown; generation?: unknown; state?: unknown }[]) {
				if (typeof source.triggerId !== "string") continue;
				const current = await this.#db.owner(ownerId, async (tx) => (await tx.query("SELECT updated_at FROM pim_app.triggers WHERE id = $1 AND lifecycle <> 'deleted'", [source.triggerId])).rows[0]);
				if (!current || revisionOf(current.updated_at as Date) !== source.generation) continue;
				if (source.state === "invalid") await this.app.triggers.setHealth(ownerId, source.triggerId, "configuration_error", "invalid");
				else if (source.state === "running") await this.app.triggers.setHealth(ownerId, source.triggerId, "healthy", null, ["reconnecting", "waiting_computer", "unknown"]);
			}
		}
	}

	/** Every enabled trigger this computer runs takes the state of the connection; a missing grant or a configuration error stays as it is. */
	async #healthAll(health: TriggerHealth, detail: string | null): Promise<void> {
		const { ownerId, computerId } = this.connection;
		const ids = await this.#db.owner(ownerId, async (tx) => (await tx.query("SELECT t.id FROM pim_app.triggers t JOIN pim_app.trigger_computer_grants g ON g.trigger_id = t.id AND g.computer_id = $1 AND g.revoked_at IS NULL WHERE t.lifecycle = 'enabled' AND t.source IN ('poll', 'stream', 'process')", [computerId])).rows.map((r) => r.id as string));
		for (const id of ids) await this.app.triggers.setHealth(ownerId, id, health, detail, ["unknown", "healthy", "reconnecting", "waiting_computer", "gap"]);
	}

	#ack(results: object[]): void {
		if (this.#connectionId === null) return;
		this.#send({ protocol: PROTOCOL, type: "ack", connectionId: this.#connectionId, serverEpoch: this.#epoch, durable: true, results });
	}

	#send(frame: object): void {
		if (!this.#closed) this.connection.sendRaw(`${TRIGGERS_ENVELOPE}${JSON.stringify(frame)}}`);
	}
}

/**
 * Lets one trigger use the person's computer, for exactly the source it has now: the grant keeps the digest of that source's configuration, so any change of what
 * runs or how often needs a grant again. It is the person's own act (`trigger:computer`); an agent can't make it. A `file` source can be granted, but nothing on a
 * computer observes files yet, so it is never sent to one.
 */
export async function grantComputerTrigger(app: App, p: Principal, triggerId: string, computerId = ""): Promise<void> {
	await app.identity.authz.enforce(p, "trigger:computer");
	await recordComputerGrant(app, p.ownerId, triggerId, p.kind === "user" ? p.sessionId : p.kind, computerId);
}

/** Records the grant a person's own act gave: their request through the API, or their approval of an agent's `trigger_computer_grant`. */
export async function recordComputerGrant(app: App, ownerId: string, triggerId: string, grantedBy: string, computerId = ""): Promise<void> {
	await app.db.owner(ownerId, async (tx) => {
		const r = (await tx.query("SELECT spec FROM pim_app.triggers WHERE id = $1 AND lifecycle <> 'deleted'", [triggerId])).rows[0];
		if (!r) throw new NotFoundError("No such trigger");
		const source = (r.spec as TriggerSpec).source;
		if (!runsOnComputer(source)) throw new BadRequestError("Only a trigger that runs on a computer needs a grant");
		// A person has one computer, so the grant needs no id for it.
		const computer = (await tx.query("SELECT id FROM pim_app.computers WHERE revoked_at IS NULL AND ($1 = '' OR id = $1) ORDER BY id LIMIT 1", [computerId])).rows[0];
		if (!computer) throw new CapabilityUnavailableError("computer", "that computer is not paired");
		await tx.query("INSERT INTO pim_app.trigger_computer_grants (owner_id, trigger_id, computer_id, granted_by, config_hash, grant_ref) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (owner_id, trigger_id, computer_id) DO UPDATE SET revoked_at = NULL, granted_at = now(), granted_by = $4, config_hash = $5, grant_ref = $6", [ownerId, triggerId, computer.id, grantedBy, sourceConfigHash(source), newId("tgr")]);
	});
}

/** The enabled poll, stream and process triggers with a current grant on this computer: what its runtime is to run now, as `triggers.v1` reconciles it. */
async function desiredOnComputer(app: App, ownerId: string, computerId: string): Promise<{ triggerId: string; revision: number; configHash: string; source: object; grantRef: string; checkpoint: { position: number; cursor: string | null } | null }[]> {
	const rows = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT t.id, t.spec, t.updated_at, t.checkpoint, g.config_hash, g.grant_ref FROM pim_app.triggers t JOIN pim_app.trigger_computer_grants g ON g.trigger_id = t.id AND g.computer_id = $1 AND g.revoked_at IS NULL WHERE t.lifecycle = 'enabled' AND t.source IN ('poll', 'stream', 'process') ORDER BY t.created_at, t.id", [computerId])).rows);
	return rows.flatMap((r) => {
		const source = (r.spec as TriggerSpec).source;
		// A grant is for the source it was given for: a changed one is not run until it is granted again.
		return sourceConfigHash(source) === r.config_hash && r.grant_ref ? [{ triggerId: r.id as string, revision: revisionOf(r.updated_at as Date), configHash: r.config_hash as string, source, grantRef: r.grant_ref as string, checkpoint: (r.checkpoint as { position: number; cursor: string | null } | null) ?? null }] : [];
	});
}

/** The oldest an observation may be and still be taken in: a source that replays further back than this has lost its place, and says so as a gap. */
const REPLAY_HORIZON_MS = 7 * 86_400_000;

/** What an observation says of where its source has got to (a stream's position, a poll's cursor), when it says it. */
const checkpointOf = (value: unknown): { position: number; cursor: string | null } | null => {
	const given = value as { position?: unknown; cursor?: unknown } | null | undefined;
	return given && Number.isSafeInteger(given.position) && (given.position as number) >= 0 && (given.cursor === null || typeof given.cursor === "string") ? { position: given.position as number, cursor: given.cursor as string | null } : null;
};

/**
 * What a computer observed reaches the trigger's chat, once per event: its grant, its generation and its source are checked again here, so a revoked or changed
 * trigger takes nothing at once, before the next reconcile stops its observer. The trigger's condition reads what was observed (a poll fires on an edge, a stream on
 * each line that matches) and what it remembers is kept with the trigger. The occurrence says why it fired and when, never what was observed.
 */

async function fireComputerEvent(app: App, ownerId: string, computerId: string, event: { triggerId: string; generation: number; eventId: string; observedAt: number; data: JsonValue; gap: boolean; checkpoint: { position: number; cursor: string | null } | null }): Promise<{ result: "accepted" | "duplicate" | "rejected" | "deferred"; reason?: string; retryAfterMs?: number }> {
	const row = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT t.lifecycle, t.spec, t.updated_at, t.condition_state, t.last_observed_at, t.retry_after, g.config_hash FROM pim_app.triggers t LEFT JOIN pim_app.trigger_computer_grants g ON g.trigger_id = t.id AND g.computer_id = $2 AND g.revoked_at IS NULL WHERE t.id = $1 AND t.lifecycle <> 'deleted'", [event.triggerId, computerId])).rows[0]);
	if (!row) return { result: "rejected", reason: "not_found" };
	const spec = row.spec as TriggerSpec;
	const source = spec.source;
	// Where the source has got to is kept once the observation is taken (fired, or read and found not to match), and only moves forward, so a computer that restarts resumes from it.
	const keep = () => (event.checkpoint === null ? undefined : app.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.triggers SET checkpoint = $2 WHERE id = $1 AND (checkpoint IS NULL OR (checkpoint->>'position')::bigint <= $3)", [event.triggerId, JSON.stringify(event.checkpoint), event.checkpoint!.position])));
	if (row.lifecycle !== "enabled") return { result: "rejected", reason: "not_enabled" };
	if (source.kind !== "poll" && source.kind !== "stream" && source.kind !== "process") return { result: "rejected", reason: "wrong_source" };
	if (!row.config_hash || row.config_hash !== sourceConfigHash(source)) return { result: "rejected", reason: "not_granted" };
	if (event.generation !== revisionOf(row.updated_at as Date)) return { result: "rejected", reason: "stale_generation" };
	const now = Date.now();
	// A process is watched until it exits, and only until its handle expires.
	if (source.kind === "process" && now > source.expiresAt) return { result: "rejected", reason: "expired" };
	if (event.observedAt < now - REPLAY_HORIZON_MS) return { result: "rejected", reason: "too_old" };
	// A source that reports a state (a poll) refuses an observation no newer than the last one it gave.
	const last = row.last_observed_at ? (row.last_observed_at as Date).getTime() : null;
	if (source.kind === "poll" && last !== null && event.observedAt <= last) return { result: "rejected", reason: "out_of_order" };
	let advanced: string | undefined;
	if (spec.condition) {
		const evaluation = evaluate(spec.condition, source.kind === "poll" ? "edge" : "filter", (row.condition_state ?? null) as never, { value: event.data, observedAt: event.observedAt, gap: event.gap }, now);
		if (!evaluation.fire) {
			await app.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.triggers SET condition_state = $2 WHERE id = $1", [event.triggerId, JSON.stringify(evaluation.state)]));
			await app.triggers.noteObservation(ownerId, event.triggerId, "observed", new Date(event.observedAt));
			return (await keep(), { result: "accepted", reason: "condition_not_met" });
		}
		// The condition's state moves only with an observation the trigger has room for: one that is deferred is offered again and read again.
		advanced = JSON.stringify(evaluation.state);
	}
	let taken: Awaited<ReturnType<App["triggers"]["fireOccurrence"]>>;
	try {
		const evidence: FiringEvidence = { kind: "computer_event", triggerId: event.triggerId, label: spec.label, source: source.kind, eventId: event.eventId, observedAt: event.observedAt };
		taken = await app.triggers.fireOccurrence(ownerId, event.triggerId, `computer:${event.eventId}`, { source: source.kind, eventId: event.eventId, observedAt: event.observedAt }, firingText(spec.instruction, evidence));
	} catch {
		// A handover that failed backs off: the source is told when to offer it again, and the trigger shows the failures.
		const retryAfter = await app.triggers.noteObservation(ownerId, event.triggerId, "failed");
		return { result: "deferred", reason: "handover_failed", retryAfterMs: Math.max(1_000, (retryAfter?.getTime() ?? now) - now) };
	}
	if (taken === "full") return { result: "deferred", reason: "backpressure", retryAfterMs: RETRY_AFTER_MS };
	// Its agent or chat is gone: the run is recorded as failed and the trigger's health says why, so the source is told it is not wanted.
	if (taken === "failed") return { result: "rejected", reason: "configuration_error" };
	if (advanced !== undefined) await app.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.triggers SET condition_state = $2 WHERE id = $1", [event.triggerId, advanced]));
	await app.triggers.noteObservation(ownerId, event.triggerId, "observed", new Date(event.observedAt));
	await keep();
	// A process's exit is its only event: the trigger ends with it.
	if (source.kind === "process" && taken !== "duplicate") await app.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.triggers SET lifecycle = 'ended', enabled = false, updated_at = now() WHERE id = $1 AND lifecycle = 'enabled'", [event.triggerId]));
	return taken === "duplicate" ? { result: "duplicate" } : { result: "accepted" };
}
