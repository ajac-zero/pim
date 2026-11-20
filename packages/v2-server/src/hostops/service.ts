/**
 * Host operations, ported from v1 (`src/hostops.ts`): a few fixed operations on the machine the stack runs on, such as reading a service's logs, restarting it or deploying a
 * new version, which the admin's majordomo asks for and a small daemon beside the stack (`sandbox-manager/hostopsd`) carries out. The daemon dials out with its own credential
 * (`pimhostops_…`, only its digest is kept here) and the stack never holds the Docker socket, so the operations wait in a queue here until it polls, and it reports each
 * result back. Arbitrary shell never runs in any role of the stack: `exec` is a command the daemon runs, as an unprivileged user, on the host.
 *
 * Only the admin's majordomo or Pimbot may ask (`assertCaller`), whatever tool or route a request came through; the admin, signed in to the app, reads the status and the audit log and
 * issues the daemon's credential. Every operation runs only under an approval a person gave in the app for exactly that operation and its arguments, and each approval runs
 * one operation (v1 asked only for `exec`; here everything that reaches the host asks), except reading the host's stats and a service's logs (`READ_ONLY_OPS`). Every request, refused or not, and every change of an
 * operation's state is in the audit log with anything that looks like a secret taken out. What the daemon is allowed to run is checked again by the daemon.
 */
import { createHash } from "node:crypto";
import { redactText } from "@pim/v2-ops/observability/redact";
import type { Db, Tx } from "@pim/v2-app/db";
import { BadRequestError, ConflictError, ForbiddenError, PimError, UnauthorizedError } from "@pim/v2-app/errors";
import { newId, secret } from "@pim/v2-app/ids";

export const HOST_OPS = ["stats", "deploy", "rollback", "restart", "logs", "set_slot_limit", "exec", "update"] as const;
export type HostOpName = (typeof HOST_OPS)[number];
/** The services the daemon may restart or read the logs of: the stack's Compose services, and the daemon itself. Its own copy in `sandbox-manager/hostopsd/validate.js` must say the same (a test checks). */
export const HOST_SERVICES = ["caddy", "postgres", "pgbouncer", "nats", "seaweedfs", "gate", "live", "runner", "forge", "maintenance", "canvas", "relay", "pim-computer", "sandbox-manager", "hostopsd"] as const;

export type HostOpState = "queued" | "running" | "succeeded" | "failed" | "rolled_back" | "expired";
/** The operations that replace what the stack runs, one at a time. */
const REPLACES_STACK: readonly HostOpName[] = ["deploy", "rollback", "update"];
const FINISHED: readonly HostOpState[] = ["succeeded", "failed", "rolled_back", "expired"];

export const QUEUED_MS = 10 * 60_000;
export const EXEC_MAX_COMMAND = 2000;
export const EXEC_DEFAULT_TIMEOUT = 60;
export const EXEC_MAX_TIMEOUT = 300;
export const EXEC_MAX_OUTPUT = 64 * 1024;
export const MAX_POLL_WAIT_MS = 25_000;
export const MAX_SUMMARY = 2000;
export const MAX_DATA_BYTES = 64 * 1024;
export const AUDIT_ROWS = 10_000;
const AUDIT_ARGS_CHARS = 8000;
const AUDIT_OUTPUT_CHARS = 3000;
const CREDENTIAL_PREFIX = "pimhostops_";
const POLL_STEP_MS = 500;

export type HostOpArgs = Record<string, string | number>;
export type HostOpData = Record<string, string | number | boolean | null | object>;

/** How long the daemon has to report an operation it took: a deploy builds, so it has longer, and a command has its own timeout and a little more. */
export const deadlineOf = (op: HostOpName, args?: HostOpArgs) => (op === "deploy" || op === "update" ? 15 * 60_000 : op === "exec" ? Number(args?.timeoutSeconds ?? EXEC_MAX_TIMEOUT) * 1000 + 30_000 : 2 * 60_000);

/** Who asks, as the code that took the request knows it: an agent running in a chat, a person signed in to the app, an API token, or nobody. */
export type HostOpsCaller =
	| { readonly kind: "agent"; readonly ownerId: string; readonly agentId: string; readonly chatId: string | null }
	| { readonly kind: "session"; readonly ownerId: string }
	| { readonly kind: "token"; readonly ownerId: string }
	| { readonly kind: "anonymous"; readonly address?: string };

export type HostOpView = { id: string; op: HostOpName; args: HostOpArgs; state: HostOpState; createdAt: number; startedAt: number | null; finishedAt: number | null; summary: string | null; data: HostOpData | null; caller: { ownerId: string; agentId: string; chatId: string | null } };
export type AuditRow = { id: number; ts: number; actorKind: string; actorId: string | null; chatId: string | null; op: string | null; action: string; opId: string | null; args: HostOpData | null; outcome: string; detail: string | null };
export type HostOpsStatus = { credential: { present: boolean; revoked: boolean; createdAt: number | null; revokedAt: number | null }; agent: { lastSeenAt: number | null; version: string | null; commit: string | null }; queue: { queued: number; running: number } };
export type PolledOp = { id: string; name: HostOpName; args: HostOpArgs; deadlineMs: number };
export type HostdResult = { id: string; ok: boolean; state: "succeeded" | "failed" | "rolled_back"; summary: string; data: HostOpData };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const ARG_KEYS: Record<HostOpName, readonly string[]> = {
	stats: ["approval"],
	deploy: ["ref", "approval"],
	rollback: ["commit", "approval"],
	restart: ["service", "approval"],
	logs: ["service", "lines", "approval"],
	set_slot_limit: ["maxConcurrent", "approval"],
	exec: ["command", "timeoutSeconds", "maxOutputBytes", "approval"],
	update: ["tag", "approval"],
};
/** Operations that only read, so the admin's majordomo or Pimbot asks for them without an approval; the daemon takes the secrets out of what they return, and each request is in the audit log. */
export const READ_ONLY_OPS: readonly HostOpName[] = ["stats", "logs"];
/** What the daemon is not told of an operation: which approval it ran under, and who approved. */
const NOT_FOR_DAEMON = ["approval", "approver"];
const REF = /^[A-Za-z0-9._/-]{1,100}$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;
/** An image tag: `stable`, `edge`, `2.1`, `2.1.0`, `sha-0123456789ab`. */
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const APPROVAL = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A command with its limits, or the 400 to answer with: what `hostops_exec` asks to run, before the person is asked. */
export function checkExecArgs(given: Record<string, unknown>): { command: string; timeoutSeconds: number; maxOutputBytes: number } {
	const { command, timeoutSeconds = EXEC_DEFAULT_TIMEOUT, maxOutputBytes = EXEC_MAX_OUTPUT } = given;
	if (typeof command !== "string" || command.trim() === "" || command.length > EXEC_MAX_COMMAND || command.includes("\0")) throw new BadRequestError(`command must be 1 to ${EXEC_MAX_COMMAND} characters, without a NUL byte`);
	if (!isInt(timeoutSeconds, 1, EXEC_MAX_TIMEOUT)) throw new BadRequestError(`timeoutSeconds must be a whole number from 1 to ${EXEC_MAX_TIMEOUT}`);
	if (!isInt(maxOutputBytes, 1, EXEC_MAX_OUTPUT)) throw new BadRequestError(`maxOutputBytes must be a whole number from 1 to ${EXEC_MAX_OUTPUT}`);
	return { command, timeoutSeconds, maxOutputBytes };
}

/** The operation and its arguments with their defaults, if `op` is one of the allowed operations and `args` are exactly its arguments; a 400 otherwise. Without `approval` it checks what a person will be asked to approve. */
export function checkHostOp(op: unknown, args: unknown, { approval = true }: { approval?: boolean } = {}): { op: HostOpName; args: HostOpArgs } {
	if (typeof op !== "string" || !(HOST_OPS as readonly string[]).includes(op)) throw new BadRequestError(`op must be one of ${HOST_OPS.join(", ")}`);
	const name = op as HostOpName;
	const given = args ?? {};
	if (!isObject(given)) throw new BadRequestError("args must be an object");
	const unknown_ = Object.keys(given).filter((key) => !ARG_KEYS[name].includes(key));
	if (unknown_.length > 0) throw new BadRequestError(`${name} takes no ${unknown_.join(", ")}`);
	const service = (value: unknown) => {
		if (typeof value !== "string" || !(HOST_SERVICES as readonly string[]).includes(value)) throw new BadRequestError(`service must be one of ${HOST_SERVICES.join(", ")}`);
		return value;
	};
	let checked: HostOpArgs;
	switch (name) {
		case "stats":
			checked = {};
			break;
		case "deploy": {
			const ref = given.ref ?? "origin/main";
			if (typeof ref !== "string" || !REF.test(ref) || ref.startsWith("-")) throw new BadRequestError("ref must be a git ref of letters, digits and . _ / -, up to 100 characters");
			checked = { ref };
			break;
		}
		case "rollback":
			if (typeof given.commit !== "string" || !COMMIT.test(given.commit)) throw new BadRequestError("commit must be 7 to 40 hex digits");
			checked = { commit: given.commit };
			break;
		case "restart":
			checked = { service: service(given.service) };
			break;
		case "logs": {
			const lines = given.lines ?? 100;
			if (!isInt(lines, 1, 500)) throw new BadRequestError("lines must be a whole number from 1 to 500");
			checked = { service: service(given.service), lines };
			break;
		}
		case "set_slot_limit":
			if (!isInt(given.maxConcurrent, 1, 16)) throw new BadRequestError("maxConcurrent must be a whole number from 1 to 16");
			checked = { maxConcurrent: given.maxConcurrent };
			break;
		case "exec":
			checked = checkExecArgs(given);
			break;
		case "update":
			if (given.tag !== undefined && (typeof given.tag !== "string" || !TAG.test(given.tag))) throw new BadRequestError("tag must be an image tag of letters, digits and . _ -, up to 128 characters");
			checked = given.tag === undefined ? {} : { tag: given.tag as string };
			break;
	}
	if (!approval) return { op: name, args: checked };
	if (typeof given.approval !== "string" || !APPROVAL.test(given.approval)) throw new BadRequestError(`${name} needs the id of the approval it runs under`);
	return { op: name, args: { ...checked, approval: given.approval } };
}

/** A run of 20 or more base64 or hex characters that isn't plain words: a digit, or both cases. */
const TOKEN_LIKE = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const looksSecret = (run: string) => /\d/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run));
/** `text` with what looks like a secret taken out: the known credential shapes, bearer credentials, and long token-like runs. */
export function redactSecrets(text: string): string {
	return redactText(text).replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(TOKEN_LIKE, (run) => (looksSecret(run) ? "[redacted]" : run));
}
/** Fields of the audit log's arguments that are ids made here, which look like tokens but are the point of the row. */
const PLAIN_FIELDS = ["approval", "approver"];
export function redactArgs(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return value.map(redactArgs);
	if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, PLAIN_FIELDS.includes(key) ? item : redactArgs(item)]));
	return value;
}

type Actor = { kind: string; id: string | null; chatId?: string | null };
const actorOf = (caller: HostOpsCaller): Actor => (caller.kind === "agent" ? { kind: "agent", id: `${caller.ownerId}/${caller.agentId}`, chatId: caller.chatId } : caller.kind === "anonymous" ? { kind: "anonymous", id: caller.address ?? null } : { kind: caller.kind, id: caller.ownerId });
const HOSTD: Actor = { kind: "hostd", id: null };
const HOST: Actor = { kind: "host", id: null };
const SYSTEM: Actor = { kind: "system", id: null };

/** What the audit log keeps of a command that ran: what it was, who approved it, how it ended, and the end of its output. */
function execAudit(args: HostOpArgs, data: HostOpData) {
	const output = typeof data.output === "string" ? data.output : "";
	return { command: args.command, approver: args.approver, exitCode: data.exitCode ?? null, timedOut: data.timedOut === true, durationMs: data.durationMs ?? null, truncated: data.truncated === true || output.length > AUDIT_OUTPUT_CHARS, output: output.length > AUDIT_OUTPUT_CHARS ? `…${output.slice(-AUDIT_OUTPUT_CHARS)}` : output };
}

type OpRow = Record<string, any>;
const view = (r: OpRow): HostOpView => ({ id: r.id, op: r.op, args: r.args, state: r.state, createdAt: r.created_at.getTime(), startedAt: ms(r.started_at), finishedAt: ms(r.finished_at), summary: r.summary, data: r.data, caller: { ownerId: r.caller_owner_id, agentId: r.caller_agent_id, chatId: r.caller_chat_id } });

export class HostOps {
	/** `enrollSecret` is what the host shares with the stack to ask for the daemon's credential (`PIM_HOSTOPS_ENROLL_TOKEN`, else the sandbox manager's `PIM_CODING_MANAGER_TOKEN`, as in v1). */
	constructor(private readonly db: Db, private readonly options: { enrollSecret?: string | undefined } = {}) {}

	#audit(tx: Tx, actor: Actor, action: string, outcome: string, opId: string | null = null, args: unknown = undefined, detail: string | null = null) {
		const full = args === undefined ? null : JSON.stringify(redactArgs(args) ?? null);
		const stored = full === null || full.length <= AUDIT_ARGS_CHARS ? full : JSON.stringify({ truncated: full.slice(0, AUDIT_ARGS_CHARS) });
		return tx
			.query("INSERT INTO pim_app.hostops_audit (actor_kind, actor_id, action, op_id, args, outcome, detail, chat_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [actor.kind, actor.id, action, opId, stored, outcome, detail === null ? null : redactSecrets(detail).slice(0, MAX_SUMMARY), actor.chatId ?? null])
			.then(() => tx.query("DELETE FROM pim_app.hostops_audit WHERE id <= (SELECT max(id) FROM pim_app.hostops_audit) - $1", [AUDIT_ROWS]));
	}

	/** Keeps a refusal in the audit log, in a transaction of its own (the caller's work is rolled back by the throw that follows). */
	async #refused(actor: Actor, action: string, asked: unknown, message: string, outcome = "rejected"): Promise<void> {
		// An anonymous caller can write only so many rows a minute from one address, so the log cannot be flooded.
		if (actor.kind === "anonymous") {
			const recent = await this.db.anonymous(async (tx) => Number((await tx.query("SELECT count(*) AS n FROM pim_app.hostops_audit WHERE actor_kind = 'anonymous' AND actor_id IS NOT DISTINCT FROM $1 AND ts > now() - interval '1 minute'", [actor.id])).rows[0]!.n));
			if (recent >= 10) return;
		}
		await this.db.anonymous((tx) => this.#audit(tx, actor, action, outcome, null, asked, message));
	}

	/**
	 * Whether `caller` may ask for host operations: only the majordomo or Pimbot of the admin's space; the majordomo is the agent a chat answers as when it names none (`pim`) or the one the admin
	 * named. Throws the error to answer anyone else with, 401 for nobody and 403 for everyone else; the refusal is kept in the audit log.
	 */
	async assertCaller(caller: HostOpsCaller, action: string, asked: unknown): Promise<void> {
		const refuse = async (error: PimError | ForbiddenError): Promise<never> => {
			await this.#refused(actorOf(caller), action, asked, error.message);
			throw error;
		};
		if (caller.kind === "anonymous") return refuse(new UnauthorizedError());
		const refusal = new PimError(403, "forbidden", "Only the admin's majordomo or Pimbot can run operations on this Pim's host.");
		if (caller.kind !== "agent") return refuse(refusal);
		const row = await this.db.owner(caller.ownerId, async (tx) => ({
			account: (await tx.query("SELECT role, status FROM pim_app.accounts WHERE owner_id = $1", [caller.ownerId])).rows[0],
			majordomo: (await tx.query("SELECT pim_app.majordomo_id() AS id")).rows[0]?.id as string | undefined,
			pimbot: (await tx.query("SELECT value #>> '{}' AS id FROM pim_app.owner_settings WHERE key = 'pimbot'")).rows[0]?.id as string | undefined,
		}));
		if (!row.account || row.account.status !== "active" || row.account.role !== "admin") return refuse(refusal);
		if (caller.agentId !== "pim" && caller.agentId !== row.majordomo && caller.agentId !== row.pimbot) return refuse(refusal);
	}

	/**
	 * Who approved an operation, as the audit log keeps it, if the approval it names is the person's own decision, for exactly this operation and its arguments, and nothing ran under
	 * it before. The application's own record of the approval is what counts, not what the caller says of it.
	 */
	async #approver(ownerId: string, op: HostOpName, args: HostOpArgs): Promise<string> {
		const id = String(args.approval);
		const row = await this.db.owner(ownerId, async (tx) => (await tx.query("SELECT tool, args, state, decided_by, decided_at FROM pim_app.approvals WHERE id = $1", [id])).rows[0]);
		const { approval: _a, ...asked } = args;
		const given = row?.args as { op?: unknown; args?: unknown } | undefined;
		if (!row || row.tool !== `hostops_${op}` || row.state !== "approved" || !String(row.decided_by ?? "").startsWith("user:") || given?.op !== op || JSON.stringify(sortKeys(given.args)) !== JSON.stringify(sortKeys(asked))) throw new PimError(403, "approval_required", "An operation runs only after the person approves exactly it.");
		return `${ownerId} (approval ${id}, ${row.decided_at ? new Date(row.decided_at).toISOString() : "?"})`;
	}

	/** Expires operations nobody took in time and fails those the daemon did not report in time. */
	async sweep(): Promise<void> {
		await this.db.anonymous(async (tx) => {
			for (const r of (await tx.query("UPDATE pim_app.hostops_ops SET state = 'expired', finished_at = now() WHERE state = 'queued' AND created_at <= now() - $1::int * interval '1 millisecond' RETURNING id", [QUEUED_MS])).rows) await this.#audit(tx, SYSTEM, "expire", "expired", r.id, undefined, "not taken by the host within 10 minutes");
			for (const r of (await tx.query("SELECT id, op, args, started_at FROM pim_app.hostops_ops WHERE state = 'running'")).rows) {
				if (r.started_at.getTime() + deadlineOf(r.op, r.args) > Date.now()) continue;
				const failed = await tx.query("UPDATE pim_app.hostops_ops SET state = 'failed', finished_at = now(), summary = 'timed out' WHERE id = $1 AND state = 'running'", [r.id]);
				if (failed.rowCount) await this.#audit(tx, SYSTEM, "timeout", "failed", r.id, undefined, "timed out");
			}
		});
	}

	/** Queues an operation for the host, if the caller may ask for it, it is allowed and a person approved it; the audit log keeps the request either way. `key` makes asking again the same call: it finds the operation already queued. */
	async enqueue(caller: HostOpsCaller, op: unknown, args: unknown, key?: string): Promise<HostOpView> {
		const asked = { op, args };
		await this.assertCaller(caller, "enqueue", asked);
		const agent = caller as Extract<HostOpsCaller, { kind: "agent" }>;
		const actor = actorOf(caller);
		let checked: ReturnType<typeof checkHostOp>;
		try {
			checked = checkHostOp(op, args, { approval: !READ_ONLY_OPS.includes(op as HostOpName) });
		} catch (error) {
			await this.#refused(actor, "enqueue", asked, (error as Error).message, "invalid");
			throw error;
		}
		await this.sweep();
		if (key) {
			const existing = await this.db.anonymous(async (tx) => (await tx.query("SELECT * FROM pim_app.hostops_ops WHERE request_key = $1", [key])).rows[0]);
			if (existing) return view(existing);
		}
		let approver: string;
		try {
			approver = READ_ONLY_OPS.includes(checked.op) ? `${agent.ownerId} (read only, no approval asked)` : await this.#approver(agent.ownerId, checked.op, checked.args);
		} catch (error) {
			await this.#refused(actor, "enqueue", checked, (error as Error).message);
			throw error;
		}
		return this.#queue(actor, agent, checked, approver, key);
	}

	/** Puts a checked, approved operation in the queue; `asker` is who is recorded as having asked. Deploys, rollbacks and updates queue behind one lock, since each replaces the running stack. */
	async #queue(actor: Actor, asker: { ownerId: string; agentId: string; chatId: string | null }, checked: ReturnType<typeof checkHostOp>, approver: string, key?: string): Promise<HostOpView> {
		const stored = { ...checked.args, approver };
		const id = newId("ho");
		try {
			return await this.db.anonymous(async (tx) => {
				if (REPLACES_STACK.includes(checked.op)) {
					await tx.query("SELECT pg_advisory_xact_lock(hashtext('pim.hostops.deploy'))");
					const busy = (await tx.query("SELECT id FROM pim_app.hostops_ops WHERE op = ANY($1) AND state IN ('queued', 'running') LIMIT 1", [REPLACES_STACK])).rows[0];
					if (busy) throw new ConflictError(`A deploy, rollback or update (${busy.id}) is already queued or running.`);
				}
				const row = (await tx.query("INSERT INTO pim_app.hostops_ops (id, request_key, approval_id, caller_owner_id, caller_agent_id, caller_chat_id, op, args, state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING *", [id, key ?? null, checked.args.approval === undefined ? null : String(checked.args.approval), asker.ownerId, asker.agentId, asker.chatId, checked.op, JSON.stringify(stored)])).rows[0];
				await this.#audit(tx, actor, "enqueue", "queued", id, { op: checked.op, args: stored });
				return view(row);
			});
		} catch (error) {
			const code = (error as { code?: string; constraint?: string }).code;
			if (code === "23505") {
				const existing = key ? await this.db.anonymous(async (tx) => (await tx.query("SELECT * FROM pim_app.hostops_ops WHERE request_key = $1", [key])).rows[0]) : undefined;
				if (existing) return view(existing);
				const message = "That approval already ran its operation: each operation needs its own approval.";
				await this.#refused(actor, "enqueue", checked, message, "conflict");
				throw new ConflictError(message);
			}
			if (error instanceof ConflictError) await this.#refused(actor, "enqueue", checked, error.message, "conflict");
			throw error;
		}
	}

	/**
	 * The admin's own button in Settings → Deployment: one `update`, which the admin confirmed by pressing it with the operation in front of them (the screen says what it runs), so
	 * the click is the approval for this call and for no other. Only an active admin account may ask, there must be a host daemon to take it, and the request is in the audit log.
	 */
	async requestUpdate(adminId: string, tag?: string): Promise<HostOpView> {
		const actor: Actor = { kind: "admin", id: adminId };
		const asked = { op: "update", args: tag === undefined ? {} : { tag } };
		const account = await this.db.owner(adminId, async (tx) => (await tx.query("SELECT role, status FROM pim_app.accounts WHERE owner_id = $1", [adminId])).rows[0]);
		if (!account || account.status !== "active" || account.role !== "admin") {
			await this.#refused(actor, "enqueue", asked, "Only the admin can update this Pim.");
			throw new ForbiddenError("hostops", "admin-only");
		}
		let checked: ReturnType<typeof checkHostOp>;
		try {
			checked = checkHostOp("update", { ...asked.args, approval: `settings_${newId("ap")}` });
		} catch (error) {
			await this.#refused(actor, "enqueue", asked, (error as Error).message, "invalid");
			throw error;
		}
		await this.sweep();
		if (!(await this.status()).credential.present) throw new ConflictError("This Pim has no host daemon to carry out an update: set up hostopsd first.");
		return this.#queue(actor, { ownerId: adminId, agentId: "settings", chatId: null }, checked, `${adminId} (confirmed in Settings, ${new Date().toISOString()})`);
	}

	/** The newest update, if one was asked for in the last hour: what Settings → Deployment shows while it runs and once it ends. */
	async latestUpdate(): Promise<HostOpView | null> {
		await this.sweep();
		const row = await this.db.anonymous(async (tx) => (await tx.query("SELECT * FROM pim_app.hostops_ops WHERE op = 'update' AND created_at > now() - interval '1 hour' ORDER BY created_at DESC LIMIT 1")).rows[0]);
		return row ? view(row) : null;
	}

	async get(id: string): Promise<HostOpView | null> {
		await this.sweep();
		const row = await this.db.anonymous(async (tx) => (await tx.query("SELECT * FROM pim_app.hostops_ops WHERE id = $1", [id])).rows[0]);
		return row ? view(row) : null;
	}

	/** The operation once it finishes, or as it is after `timeoutMs`; null when there is none. */
	async waitFor(id: string, timeoutMs: number): Promise<HostOpView | null> {
		const until = Date.now() + Math.max(0, Math.min(timeoutMs, QUEUED_MS + deadlineOf("deploy")));
		for (;;) {
			const op = await this.get(id);
			if (!op || FINISHED.includes(op.state) || Date.now() >= until) return op;
			await sleep(Math.min(POLL_STEP_MS, until - Date.now()));
		}
	}

	async readFor(caller: HostOpsCaller, id: string, timeoutMs: number): Promise<HostOpView | null> {
		await this.assertCaller(caller, "read", { id });
		return this.waitFor(id, timeoutMs);
	}

	async statusFor(caller: HostOpsCaller): Promise<HostOpsStatus> {
		await this.assertCaller(caller, "status", undefined);
		return this.status();
	}

	async status(): Promise<HostOpsStatus> {
		await this.sweep();
		return this.db.anonymous(async (tx) => {
			const c = (await tx.query("SELECT * FROM pim_app.hostops_credential ORDER BY created_at DESC, hash LIMIT 1")).rows[0];
			const counts = Object.fromEntries((await tx.query("SELECT state, count(*)::int AS n FROM pim_app.hostops_ops WHERE state IN ('queued', 'running') GROUP BY state")).rows.map((r) => [r.state, r.n]));
			return { credential: { present: !!c && !c.revoked_at, revoked: !!c && !!c.revoked_at, createdAt: ms(c?.created_at), revokedAt: ms(c?.revoked_at) }, agent: { lastSeenAt: ms(c?.last_seen_at), version: c?.agent_version ?? null, commit: c?.agent_commit ?? null }, queue: { queued: counts.queued ?? 0, running: counts.running ?? 0 } };
		});
	}

	/** The audit log, newest first, from `since` (a time in ms) on, and only the rows about operation `op` or with action `op`. */
	async audit(limit: number, { since, op }: { since?: number; op?: string } = {}): Promise<AuditRow[]> {
		const rows = (await this.db.anonymous((tx) => tx.query(
			`SELECT a.*, COALESCE(a.chat_id, o.caller_chat_id) AS chat, o.op AS op_name FROM pim_app.hostops_audit a LEFT JOIN pim_app.hostops_ops o ON o.id = a.op_id
			WHERE a.ts >= $1 AND ($2::text IS NULL OR o.op = $2 OR a.action = $2) ORDER BY a.id DESC LIMIT $3`,
			[new Date(since ?? 0), op ?? null, limit],
		))).rows;
		return rows.map((r) => {
			const given = isObject(r.args?.args) ? (r.args.args as Record<string, unknown>) : r.args;
			return { id: Number(r.id), ts: r.ts.getTime(), actorKind: r.actor_kind, actorId: r.actor_id, chatId: r.chat, op: r.op_name ?? (typeof given?.command === "string" ? "exec" : null), action: r.action, opId: r.op_id, args: r.args, outcome: r.outcome, detail: r.detail };
		});
	}

	async auditFor(caller: HostOpsCaller, limit: number, filter: { since?: number; op?: string }): Promise<AuditRow[]> {
		await this.assertCaller(caller, "audit", filter);
		return this.audit(limit, filter);
	}

	// ---- the daemon's credential ----

	async #mint(actor: Actor, issueAction: string, rotateAction: string): Promise<{ token: string; rotated: boolean }> {
		const token = `${CREDENTIAL_PREFIX}${secret()}`;
		return this.db.anonymous(async (tx) => {
			const rotated = ((await tx.query("UPDATE pim_app.hostops_credential SET revoked_at = now() WHERE revoked_at IS NULL")).rowCount ?? 0) > 0;
			await tx.query("INSERT INTO pim_app.hostops_credential (hash) VALUES ($1)", [digestOf(token)]);
			await this.#audit(tx, actor, rotated ? rotateAction : issueAction, "ok");
			return { token, rotated };
		});
	}

	/** A new credential for the daemon, in place of any other, which stops working now. It is returned only here. */
	issueCredential(adminId: string) {
		return this.#mint({ kind: "admin", id: adminId }, "credential.issue", "credential.rotate");
	}

	async revokeCredential(adminId: string): Promise<boolean> {
		return this.db.anonymous(async (tx) => {
			const revoked = ((await tx.query("UPDATE pim_app.hostops_credential SET revoked_at = now() WHERE revoked_at IS NULL")).rowCount ?? 0) > 0;
			await this.#audit(tx, { kind: "admin", id: adminId }, "credential.revoke", revoked ? "ok" : "none");
			return revoked;
		});
	}

	/** The host enrolling its daemon with the shared secret: a new credential as `issueCredential` makes one, unless the admin revoked the newest, which stays revoked until the admin issues another (null then). A Pim with no secret has nothing to enroll with: 404. */
	async enroll(given: string, address: string): Promise<{ token: string } | null> {
		const expected = this.options.enrollSecret;
		if (!expected) throw new PimError(404, "not_found", "Not found");
		if (!given || digestOf(given) !== digestOf(expected)) {
			await this.#refused({ kind: "anonymous", id: address }, "credential.enroll", undefined, "wrong enrollment token");
			throw new UnauthorizedError("Unauthorized");
		}
		const newest = await this.db.anonymous(async (tx) => (await tx.query("SELECT revoked_at FROM pim_app.hostops_credential ORDER BY created_at DESC, hash LIMIT 1")).rows[0]);
		if (newest?.revoked_at) {
			await this.db.anonymous((tx) => this.#audit(tx, HOST, "credential.enroll", "revoked", null, undefined, "refused: the admin revoked the credential"));
			return null;
		}
		const { token } = await this.#mint(HOST, "credential.enroll", "credential.enroll");
		return { token };
	}

	// ---- the daemon ----

	async #current(token: string): Promise<string | null> {
		const hash = digestOf(token);
		const row = await this.db.anonymous(async (tx) => (await tx.query("SELECT hash FROM pim_app.hostops_credential WHERE hash = $1 AND revoked_at IS NULL", [hash])).rows[0]);
		return row ? hash : null;
	}

	/** The daemon asking for work: the oldest queued operation, which it runs now, waiting up to `waitMs` for one; null when none came, and `unauthorized` for a credential that is not the current one. */
	async poll(token: string, hello: { agentVersion: string | null; commit: string | null }, waitMs: number): Promise<{ op: PolledOp | null } | "unauthorized"> {
		const hash = await this.#current(token);
		if (!hash) return "unauthorized";
		await this.db.anonymous((tx) => tx.query("UPDATE pim_app.hostops_credential SET last_seen_at = now(), agent_version = $2, agent_commit = $3 WHERE hash = $1", [hash, hello.agentVersion, hello.commit]));
		const until = Date.now() + waitMs;
		for (;;) {
			await this.sweep();
			const claimed = await this.db.anonymous(async (tx) => {
				if (!(await tx.query("SELECT 1 FROM pim_app.hostops_credential WHERE hash = $1 AND revoked_at IS NULL", [hash])).rowCount) return "unauthorized" as const;
				const row = (await tx.query("UPDATE pim_app.hostops_ops SET state = 'running', started_at = now() WHERE id = (SELECT id FROM pim_app.hostops_ops WHERE state = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *")).rows[0];
				if (row) await this.#audit(tx, HOSTD, "claim", "running", row.id);
				return row ? view(row) : null;
			});
			if (claimed === "unauthorized") return "unauthorized";
			if (claimed) return { op: { id: claimed.id, name: claimed.op, args: Object.fromEntries(Object.entries(claimed.args).filter(([k]) => !NOT_FOR_DAEMON.includes(k))), deadlineMs: deadlineOf(claimed.op, claimed.args) } };
			if (Date.now() >= until) return { op: null };
			await sleep(Math.min(POLL_STEP_MS, until - Date.now()));
		}
	}

	/** The daemon reporting how an operation it took went. */
	async result(token: string, result: HostdResult): Promise<{ status: number; error?: string; op?: HostOpView }> {
		const hash = await this.#current(token);
		if (!hash) return { status: 401, error: "Unauthorized" };
		await this.db.anonymous((tx) => tx.query("UPDATE pim_app.hostops_credential SET last_seen_at = now() WHERE hash = $1", [hash]));
		await this.sweep();
		return this.db.anonymous(async (tx) => {
			const row = (await tx.query("SELECT * FROM pim_app.hostops_ops WHERE id = $1 FOR UPDATE", [result.id])).rows[0];
			if (!row) return { status: 404, error: `No operation ${result.id}` };
			if (row.state !== "running") {
				const error = `Operation ${result.id} isn't running: it is ${row.state}.`;
				await this.#audit(tx, HOSTD, "result", "conflict", result.id, undefined, error);
				return { status: 409, error };
			}
			const done = (await tx.query("UPDATE pim_app.hostops_ops SET state = $2, finished_at = now(), summary = $3, data = $4 WHERE id = $1 RETURNING *", [result.id, result.state, result.summary, JSON.stringify(result.data)])).rows[0];
			await this.#audit(tx, HOSTD, "result", result.state, result.id, row.op === "exec" ? execAudit(row.args, result.data) : undefined, result.summary);
			return { status: 200, op: view(done) };
		});
	}
}

const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
	return value;
}
