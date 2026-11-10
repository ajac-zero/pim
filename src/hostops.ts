import { getAgentByName } from "agents";
import { DurableObject } from "cloudflare:workers";
import { base64UrlEncode } from "./auth/encoding";
import type { Account } from "./directory";
import { HttpError, json, readJson } from "./http";
import { limited } from "./runtime";

/**
 * Host operations: a few fixed operations on the machine this Pim runs on,
 * such as deploying a new version or reading a service's logs, which the
 * admin's majordomo asks for and a small daemon on the host (`hostopsd`)
 * carries out. The daemon dials out to Pim, so the operations wait in a
 * queue here, in one Durable Object for the deployment, until it polls for
 * them, and it reports each one's result back.
 *
 * Only the admin's majordomo may ask for an operation (`assertHostOpsCaller`),
 * whatever tool or route the request came through. The admin, signed in to
 * the app, reads the audit log and the daemon's status and issues the
 * daemon's credential, but asks for operations through their majordomo. The
 * daemon opens only its own routes, with that credential. Every request for an
 * operation, refused or not, and every change of an operation's state is in
 * the audit log, with anything that looks like a secret taken out.
 */

/** The one instance, for the whole deployment. */
export const HOSTOPS_NAME = "hostops";

/** The daemon's routes under `/api`, opened by its credential only. */
export const HOSTOPS_AGENT_PATH = "/hostops/agent";

export const HOST_OPS = ["stats", "deploy", "rollback", "restart", "logs", "set_slot_limit"] as const;
export type HostOpName = (typeof HOST_OPS)[number];

export const HOST_SERVICES = ["sandbox-manager", "egress-proxy", "docker-socket-proxy", "hostopsd"] as const;

export type HostOpState = "queued" | "running" | "succeeded" | "failed" | "rolled_back" | "expired";
const FINISHED: readonly HostOpState[] = ["succeeded", "failed", "rolled_back", "expired"];

/** How long an operation waits for the daemon to take it before it expires. */
export const QUEUED_MS = 10 * 60_000;
/** How long the daemon has to report an operation it took: a deploy builds, so it has longer. */
export const deadlineOf = (op: HostOpName) => (op === "deploy" ? 15 * 60_000 : 2 * 60_000);
/** The longest a poll waits for an operation. */
export const MAX_POLL_WAIT_MS = 25_000;
export const MAX_SUMMARY = 2000;
export const MAX_DATA_BYTES = 64 * 1024;
/** The audit log keeps the newest rows, at most this many. */
export const AUDIT_ROWS = 10_000;

/**
 * Who asks for an operation, as the Worker's code that took the request knows
 * it: an agent running in a space (`chatId` is its chat), a person signed in
 * to the app (`session`), an API or MCP token (`token`), or nobody.
 */
export type HostOpsCaller =
	| { readonly kind: "agent"; readonly accountId: string; readonly agentId: string; readonly chatId: string | null }
	| { readonly kind: "session"; readonly accountId: string }
	| { readonly kind: "token"; readonly accountId: string }
	| { readonly kind: "anonymous"; readonly address?: string };

/** An operation's arguments, which are all strings and numbers. */
export type HostOpArgs = Record<string, string | number>;
/** What the daemon reports of an operation: any JSON object. */
export type HostOpData = Record<string, string | number | boolean | null | object>;

export type HostOpView = {
	id: string;
	op: HostOpName;
	args: HostOpArgs;
	state: HostOpState;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	summary: string | null;
	data: HostOpData | null;
	caller: { accountId: string; agentId: string; chatId: string | null };
};

export type AuditRow = {
	id: number;
	ts: number;
	actorKind: string;
	actorId: string | null;
	action: string;
	opId: string | null;
	args: HostOpData | null;
	outcome: string;
	detail: string | null;
};

export type HostOpsStatus = {
	credential: { present: boolean; revoked: boolean; createdAt: number | null; revokedAt: number | null };
	agent: { lastSeenAt: number | null; version: string | null; commit: string | null };
	queue: { queued: number; running: number };
};

type Refusal = { ok: false; status: number; error: string };

/**
 * Whether `caller` may ask for host operations: only the majordomo of the
 * admin's space. Throws the `HttpError` to answer anyone else with, 401 for
 * nobody and 403 for everyone else. Every request for an operation passes
 * here, in the Durable Object, whatever took it.
 */
export async function assertHostOpsCaller(env: Env, caller: HostOpsCaller): Promise<void> {
	if (caller.kind === "anonymous") throw new HttpError(401, "Unauthorized");
	const refused = new HttpError(403, "Only the admin's majordomo can run operations on this Pim's host.");
	if (caller.kind !== "agent") throw refused;
	const account = await env.Directory.getByName("directory").account(caller.accountId);
	if (!account || account.status !== "active" || account.role !== "admin") throw refused;
	const majordomo = await (await getAgentByName(env.Pim, account.ownerId)).majordomoId();
	if (majordomo === null || majordomo !== caller.agentId) throw refused;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

const ARG_KEYS: Record<HostOpName, readonly string[]> = {
	stats: [],
	deploy: ["ref"],
	rollback: ["commit"],
	restart: ["service"],
	logs: ["service", "lines"],
	set_slot_limit: ["maxConcurrent"],
};

/** A ref git takes as a revision and never as an option. */
const REF = /^[A-Za-z0-9._/-]{1,100}$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;

/** The operation and its arguments with their defaults, if `op` is one of the allowed operations and `args` are exactly its arguments; a 400 otherwise. */
export function checkHostOp(op: unknown, args: unknown): { op: HostOpName; args: HostOpArgs } {
	const bad = (message: string) => new HttpError(400, message);
	if (typeof op !== "string" || !(HOST_OPS as readonly string[]).includes(op)) throw bad(`op must be one of ${HOST_OPS.join(", ")}`);
	const name = op as HostOpName;
	const given = args ?? {};
	if (!isObject(given)) throw bad("args must be an object");
	const unknown = Object.keys(given).filter((key) => !ARG_KEYS[name].includes(key));
	if (unknown.length > 0) throw bad(`${name} takes no ${unknown.join(", ")}`);
	const service = (value: unknown) => {
		if (typeof value !== "string" || !(HOST_SERVICES as readonly string[]).includes(value)) throw bad(`service must be one of ${HOST_SERVICES.join(", ")}`);
		return value;
	};
	switch (name) {
		case "stats":
			return { op: name, args: {} };
		case "deploy": {
			const ref = given.ref ?? "origin/main";
			if (typeof ref !== "string" || !REF.test(ref) || ref.startsWith("-")) throw bad("ref must be a git ref of letters, digits and . _ / -, up to 100 characters");
			return { op: name, args: { ref } };
		}
		case "rollback":
			if (typeof given.commit !== "string" || !COMMIT.test(given.commit)) throw bad("commit must be 7 to 40 hex digits");
			return { op: name, args: { commit: given.commit } };
		case "restart":
			return { op: name, args: { service: service(given.service) } };
		case "logs": {
			const lines = given.lines ?? 100;
			if (!isInt(lines, 1, 500)) throw bad("lines must be a whole number from 1 to 500");
			return { op: name, args: { service: service(given.service), lines } };
		}
		case "set_slot_limit":
			if (!isInt(given.maxConcurrent, 1, 16)) throw bad("maxConcurrent must be a whole number from 1 to 16");
			return { op: name, args: { maxConcurrent: given.maxConcurrent } };
	}
}

/** A run of 20 or more base64 or hex characters that isn't plain words: a digit, or both cases. */
const TOKEN_LIKE = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const looksSecret = (run: string) => /\d/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run));

/** `text` with what looks like a secret taken out: bearer credentials, and long token-like runs. */
export function redactSecrets(text: string): string {
	return text.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(TOKEN_LIKE, (run) => (looksSecret(run) ? "[redacted]" : run));
}

/** `value` with every string in it redacted, for the audit log. */
export function redactValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return value.map(redactValue);
	if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
	return value;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	caller_agent_id TEXT NOT NULL,
	caller_chat_id TEXT,
	caller_account_id TEXT NOT NULL,
	op TEXT NOT NULL,
	args_json TEXT NOT NULL,
	state TEXT NOT NULL,
	started_at INTEGER,
	finished_at INTEGER,
	summary TEXT,
	data_json TEXT
);
CREATE INDEX IF NOT EXISTS ops_by_state ON ops (state, created_at);
CREATE TABLE IF NOT EXISTS audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	actor_kind TEXT NOT NULL,
	actor_id TEXT,
	action TEXT NOT NULL,
	op_id TEXT,
	args_redacted_json TEXT,
	outcome TEXT NOT NULL,
	detail TEXT
);
CREATE TABLE IF NOT EXISTS credential (
	hash TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER,
	agent_version TEXT,
	agent_commit TEXT,
	revoked_at INTEGER
);
`;

const CREDENTIAL_PREFIX = "pimhostops_";

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const unhex = (text: string) => new Uint8Array(text.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
const sha256 = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

type Actor = { kind: string; id: string | null };
const actorOf = (caller: HostOpsCaller): Actor => {
	switch (caller.kind) {
		case "agent":
			return { kind: "agent", id: `${caller.accountId}/${caller.agentId}` };
		case "anonymous":
			return { kind: "anonymous", id: caller.address ?? null };
		default:
			return { kind: caller.kind, id: caller.accountId };
	}
};
const HOSTD: Actor = { kind: "hostd", id: null };
const SYSTEM: Actor = { kind: "system", id: null };

/** What the daemon reports, as it reports it. */
export type HostdHello = { agentVersion: string | null; commit: string | null };
export type HostdResult = { id: string; ok: boolean; state: "succeeded" | "failed" | "rolled_back"; summary: string; data: HostOpData };
export type PolledOp = { id: string; name: HostOpName; args: HostOpArgs; deadlineMs: number };

export class HostOps extends DurableObject<Env> {
	/** Polls waiting for an operation, woken when one is queued. */
	readonly #pollers = new Set<() => void>();
	/** Callers waiting for operations to finish, woken whenever one changes. */
	readonly #watchers = new Set<() => void>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(SCHEMA);
	}

	#sql(query: string, ...bindings: unknown[]) {
		return this.ctx.storage.sql.exec(query, ...bindings);
	}

	#audit(actor: Actor, action: string, outcome: string, opId: string | null = null, args: unknown = undefined, detail: string | null = null): void {
		const full = args === undefined ? null : JSON.stringify(redactValue(args) ?? null);
		const redacted = full === null || full.length <= 4000 ? full : JSON.stringify({ truncated: full.slice(0, 4000) });
		this.#sql(
			"INSERT INTO audit (ts, actor_kind, actor_id, action, op_id, args_redacted_json, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			Date.now(),
			actor.kind,
			actor.id,
			action,
			opId,
			redacted,
			outcome,
			detail === null ? null : redactSecrets(detail).slice(0, MAX_SUMMARY),
		);
		this.#sql("DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - ?", AUDIT_ROWS);
	}

	#view(row: Record<string, SqlStorageValue>): HostOpView {
		return {
			id: String(row.id),
			op: row.op as HostOpName,
			args: JSON.parse(String(row.args_json)),
			state: row.state as HostOpState,
			createdAt: Number(row.created_at),
			startedAt: row.started_at === null ? null : Number(row.started_at),
			finishedAt: row.finished_at === null ? null : Number(row.finished_at),
			summary: row.summary === null ? null : String(row.summary),
			data: row.data_json === null ? null : JSON.parse(String(row.data_json)),
			caller: { accountId: String(row.caller_account_id), agentId: String(row.caller_agent_id), chatId: row.caller_chat_id === null ? null : String(row.caller_chat_id) },
		};
	}

	#row(id: string) {
		return this.#sql("SELECT * FROM ops WHERE id = ?", id).toArray()[0];
	}

	#wake(waiters: Set<() => void>): void {
		for (const wake of [...waiters]) wake();
	}

	/** Waits until `ms` pass or something wakes `waiters`. */
	#sleep(ms: number, waiters: Set<() => void>): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				waiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, Math.max(0, ms));
			waiters.add(done);
		});
	}

	/** Expires operations nobody took in time and fails those the daemon didn't report in time, then sets the alarm for the next. */
	async sweep(): Promise<void> {
		const now = Date.now();
		let changed = false;
		for (const row of this.#sql("SELECT id FROM ops WHERE state = 'queued' AND created_at <= ?", now - QUEUED_MS).toArray()) {
			this.#sql("UPDATE ops SET state = 'expired', finished_at = ? WHERE id = ?", now, row.id);
			this.#audit(SYSTEM, "expire", "expired", String(row.id), undefined, "not taken by the host within 10 minutes");
			changed = true;
		}
		for (const row of this.#sql("SELECT id, op, started_at FROM ops WHERE state = 'running'").toArray()) {
			if (Number(row.started_at) + deadlineOf(row.op as HostOpName) > now) continue;
			this.#sql("UPDATE ops SET state = 'failed', finished_at = ?, summary = 'timed out' WHERE id = ?", now, row.id);
			this.#audit(SYSTEM, "timeout", "failed", String(row.id), undefined, "timed out");
			changed = true;
		}
		if (changed) this.#wake(this.#watchers);
		const due = [
			...this.#sql("SELECT created_at FROM ops WHERE state = 'queued'")
				.toArray()
				.map((row) => Number(row.created_at) + QUEUED_MS),
			...this.#sql("SELECT op, started_at FROM ops WHERE state = 'running'")
				.toArray()
				.map((row) => Number(row.started_at) + deadlineOf(row.op as HostOpName)),
		];
		if (due.length === 0) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(Math.min(...due));
	}

	override async alarm(): Promise<void> {
		await this.sweep();
	}

	/** Queues an operation for the host, if the caller may ask for it and it is allowed; the audit log keeps the request either way. */
	async enqueue(caller: HostOpsCaller, op: unknown, args: unknown): Promise<{ ok: true; op: HostOpView } | Refusal> {
		const actor = actorOf(caller);
		const asked = { op, args };
		try {
			await assertHostOpsCaller(this.env, caller);
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 403;
			const message = error instanceof Error ? error.message : String(error);
			this.#audit(actor, "enqueue", "rejected", null, asked, message);
			return { ok: false, status, error: message };
		}
		let checked: ReturnType<typeof checkHostOp>;
		try {
			checked = checkHostOp(op, args);
		} catch (error) {
			const message = (error as Error).message;
			this.#audit(actor, "enqueue", "invalid", null, asked, message);
			return { ok: false, status: 400, error: message };
		}
		await this.sweep();
		// No awaits from here to the insert: checking for another deploy and queueing this one is one step.
		if (checked.op === "deploy" || checked.op === "rollback") {
			const busy = this.#sql("SELECT id FROM ops WHERE op IN ('deploy', 'rollback') AND state IN ('queued', 'running') LIMIT 1").toArray()[0];
			if (busy) {
				const message = `A deploy or rollback (${busy.id}) is already queued or running.`;
				this.#audit(actor, "enqueue", "conflict", null, checked, message);
				return { ok: false, status: 409, error: message };
			}
		}
		const agent = caller as Extract<HostOpsCaller, { kind: "agent" }>;
		const id = crypto.randomUUID();
		this.#sql(
			"INSERT INTO ops (id, created_at, caller_agent_id, caller_chat_id, caller_account_id, op, args_json, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')",
			id,
			Date.now(),
			agent.agentId,
			agent.chatId,
			agent.accountId,
			checked.op,
			JSON.stringify(checked.args),
		);
		this.#audit(actor, "enqueue", "queued", id, checked);
		this.#wake(this.#pollers);
		await this.sweep();
		return { ok: true, op: this.#view(this.#row(id)!) };
	}

	async get(id: string): Promise<HostOpView | null> {
		await this.sweep();
		const row = this.#row(id);
		return row ? this.#view(row) : null;
	}

	/** The operation once it finishes, or as it is after `timeoutMs`; null when there is none. */
	async waitFor(id: string, timeoutMs: number): Promise<HostOpView | null> {
		const until = Date.now() + Math.max(0, Math.min(timeoutMs, QUEUED_MS + deadlineOf("deploy")));
		for (;;) {
			const op = await this.get(id);
			if (!op || FINISHED.includes(op.state) || Date.now() >= until) return op;
			await this.#sleep(until - Date.now(), this.#watchers);
		}
	}

	async status(): Promise<HostOpsStatus> {
		await this.sweep();
		const credential = this.#sql("SELECT * FROM credential ORDER BY created_at DESC, rowid DESC LIMIT 1").toArray()[0];
		const count = (state: string) => Number(this.#sql("SELECT COUNT(*) AS n FROM ops WHERE state = ?", state).one().n);
		const text = (value: SqlStorageValue | undefined) => (value === null || value === undefined ? null : String(value));
		const number = (value: SqlStorageValue | undefined) => (value === null || value === undefined ? null : Number(value));
		return {
			credential: {
				present: credential !== undefined && credential.revoked_at === null,
				revoked: credential !== undefined && credential.revoked_at !== null,
				createdAt: number(credential?.created_at),
				revokedAt: number(credential?.revoked_at),
			},
			agent: { lastSeenAt: number(credential?.last_seen_at), version: text(credential?.agent_version), commit: text(credential?.agent_commit) },
			queue: { queued: count("queued"), running: count("running") },
		};
	}

	/** The audit log, newest first. */
	audit(limit: number): AuditRow[] {
		return this.#sql("SELECT * FROM audit ORDER BY id DESC LIMIT ?", limit)
			.toArray()
			.map((row) => ({
				id: Number(row.id),
				ts: Number(row.ts),
				actorKind: String(row.actor_kind),
				actorId: row.actor_id === null ? null : String(row.actor_id),
				action: String(row.action),
				opId: row.op_id === null ? null : String(row.op_id),
				args: row.args_redacted_json === null ? null : JSON.parse(String(row.args_redacted_json)),
				outcome: String(row.outcome),
				detail: row.detail === null ? null : String(row.detail),
			}));
	}

	/** A new credential for the daemon, in place of any other, which stops working now. It is returned only here; only its digest is kept. */
	async issueCredential(adminId: string): Promise<{ token: string; rotated: boolean }> {
		const token = `${CREDENTIAL_PREFIX}${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
		const hash = hex(await sha256(token));
		const now = Date.now();
		const rotated = this.#sql("UPDATE credential SET revoked_at = ? WHERE revoked_at IS NULL", now).rowsWritten > 0;
		this.#sql("INSERT INTO credential (hash, created_at) VALUES (?, ?)", hash, now);
		this.#audit({ kind: "admin", id: adminId }, rotated ? "credential.rotate" : "credential.issue", "ok");
		return { token, rotated };
	}

	/** Revokes the daemon's credential at once. Whether there was one. */
	revokeCredential(adminId: string): boolean {
		const revoked = this.#sql("UPDATE credential SET revoked_at = ? WHERE revoked_at IS NULL", Date.now()).rowsWritten > 0;
		this.#audit({ kind: "admin", id: adminId }, "credential.revoke", revoked ? "ok" : "none");
		return revoked;
	}

	/** The digest of the credential `token` is, if it is the current one; compared in constant time. */
	async #credential(token: string): Promise<string | null> {
		const given = await sha256(token);
		const current = this.#sql("SELECT hash FROM credential WHERE revoked_at IS NULL LIMIT 1").toArray()[0];
		if (!current) return null;
		return crypto.subtle.timingSafeEqual(given, unhex(String(current.hash))) ? String(current.hash) : null;
	}

	/** Whether `hash` is still the current credential: one revoked while a poll waited takes nothing. */
	#current(hash: string): boolean {
		return this.#sql("SELECT 1 FROM credential WHERE hash = ? AND revoked_at IS NULL", hash).toArray().length > 0;
	}

	/** The daemon asking for work: the oldest queued operation, which it runs now, waiting up to `waitMs` for one; null when none came. */
	async poll(token: string, hello: HostdHello, waitMs: number): Promise<{ ok: false; status: 401 } | { ok: true; op: PolledOp | null }> {
		const hash = await this.#credential(token);
		if (!hash) return { ok: false, status: 401 };
		this.#sql("UPDATE credential SET last_seen_at = ?, agent_version = ?, agent_commit = ? WHERE hash = ?", Date.now(), hello.agentVersion, hello.commit, hash);
		const until = Date.now() + waitMs;
		for (;;) {
			await this.sweep();
			if (!this.#current(hash)) return { ok: false, status: 401 };
			const row = this.#sql("SELECT * FROM ops WHERE state = 'queued' ORDER BY created_at, rowid LIMIT 1").toArray()[0];
			if (row) {
				const op = this.#view(row);
				this.#sql("UPDATE ops SET state = 'running', started_at = ? WHERE id = ?", Date.now(), op.id);
				this.#audit(HOSTD, "claim", "running", op.id);
				this.#wake(this.#watchers);
				await this.sweep();
				return { ok: true, op: { id: op.id, name: op.op, args: op.args, deadlineMs: deadlineOf(op.op) } };
			}
			if (Date.now() >= until) return { ok: true, op: null };
			await this.#sleep(until - Date.now(), this.#pollers);
		}
	}

	/** The daemon reporting how an operation it took went. */
	async result(token: string, result: HostdResult): Promise<{ status: number; error?: string; op?: HostOpView }> {
		const hash = await this.#credential(token);
		if (!hash) return { status: 401, error: "Unauthorized" };
		this.#sql("UPDATE credential SET last_seen_at = ? WHERE hash = ?", Date.now(), hash);
		await this.sweep();
		const row = this.#row(result.id);
		if (!row) return { status: 404, error: `No operation ${result.id}` };
		if (row.state !== "running") {
			const error = `Operation ${result.id} isn't running: it is ${row.state}.`;
			this.#audit(HOSTD, "result", "conflict", result.id, undefined, error);
			return { status: 409, error };
		}
		this.#sql(
			"UPDATE ops SET state = ?, finished_at = ?, summary = ?, data_json = ? WHERE id = ?",
			result.state,
			Date.now(),
			result.summary,
			JSON.stringify(result.data),
			result.id,
		);
		this.#audit(HOSTD, "result", result.state, result.id, undefined, result.summary);
		this.#wake(this.#watchers);
		await this.sweep();
		return { status: 200, op: this.#view(this.#row(result.id)!) };
	}
}

const hostOps = (env: Env) => env.HostOps.getByName(HOSTOPS_NAME);

/** Queues an operation on the host for `caller`, which must be the admin's majordomo; throws the `HttpError` to answer otherwise. */
export async function enqueueHostOp(env: Env, caller: HostOpsCaller, op: unknown, args: unknown): Promise<HostOpView> {
	const queued = await hostOps(env).enqueue(caller, op, args);
	if (!queued.ok) throw new HttpError(queued.status, queued.error);
	return queued.op;
}

export async function getHostOp(env: Env, id: string): Promise<HostOpView | null> {
	return hostOps(env).get(id);
}

/** The operation once it finishes, or as it is after `timeoutMs`. */
export async function waitForHostOp(env: Env, id: string, timeoutMs: number): Promise<HostOpView | null> {
	return hostOps(env).waitFor(id, timeoutMs);
}

const fail = (status: number, error: string) => json({ error }, status);

/**
 * `/api/hostops/*` for a person the Worker signed in, or nobody (`account`
 * null, after the Worker refused the request as `refused`). Asking for an
 * operation (`POST /hostops/ops`) goes to the Durable Object, which refuses
 * everyone here, as none of them is the majordomo, and keeps the refusal. The
 * admin, signed in to the app, reads the status, the audit log and operations,
 * and issues or revokes the daemon's credential.
 */
export async function hostOpsApi(
	env: Env,
	request: Request,
	path: string,
	caller: { account: Account; viaSession: boolean } | { refused: Response; address: string },
): Promise<Response> {
	const route = `${request.method} ${path}`;
	if ("refused" in caller) {
		// Asking with no valid sign-in is kept too, as often as sign-ins may be tried from one address.
		if (route === "POST /hostops/ops" && caller.refused.status === 401 && !(await limited(env, "auth", caller.address))) {
			await hostOps(env)
				.enqueue({ kind: "anonymous", address: caller.address }, null, null)
				.catch(() => undefined);
		}
		return caller.refused;
	}
	const { account, viaSession } = caller;
	try {
		if (route === "POST /hostops/ops") {
			const body = await readJson<{ op: unknown; args: unknown }>(request).catch(() => ({}) as { op?: unknown; args?: unknown });
			const who: HostOpsCaller = viaSession ? { kind: "session", accountId: account.ownerId } : { kind: "token", accountId: account.ownerId };
			return json(await enqueueHostOp(env, who, body.op, body.args), 201);
		}
		if (account.role !== "admin") return fail(403, "Only the admin can do that.");
		if (!viaSession) return fail(403, "Running this Pim needs you signed in to the app.");
		if (route === "GET /hostops/status") return json(await hostOps(env).status());
		if (route === "GET /hostops/audit") {
			const limit = Number(new URL(request.url).searchParams.get("limit") ?? 100);
			if (!isInt(limit, 1, AUDIT_ROWS)) return fail(400, `limit must be a whole number from 1 to ${AUDIT_ROWS}`);
			return json({ audit: await hostOps(env).audit(limit) });
		}
		if (route === "POST /hostops/credential") return json(await hostOps(env).issueCredential(account.ownerId), 201);
		if (route === "DELETE /hostops/credential") return json({ revoked: await hostOps(env).revokeCredential(account.ownerId) });
		const op = /^GET \/hostops\/ops\/([^/]+)$/.exec(route);
		if (op) {
			const found = await getHostOp(env, decodeURIComponent(op[1]!));
			return found ? json(found) : fail(404, "No such operation");
		}
		return fail(404, "Not found");
	} catch (error) {
		if (error instanceof HttpError) return fail(error.status, error.message);
		throw error;
	}
}

/** `/api/hostops/agent/*`: the daemon polling for work and reporting results, with its credential as a bearer token and nothing else. */
export async function serveHostOpsAgent(request: Request, env: Env, path: string): Promise<Response> {
	const header = request.headers.get("Authorization");
	const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
	if (!token) return fail(401, "Unauthorized");
	if (request.method !== "POST") return fail(405, `/api${path} takes POST`);
	let body: Record<string, unknown>;
	try {
		body = await readJson<Record<string, unknown>>(request);
	} catch (error) {
		return fail(400, (error as Error).message);
	}
	const text = (value: unknown, name: string) => {
		if (value === undefined || value === null) return null;
		if (typeof value !== "string" || value.length > 200) throw new HttpError(400, `${name} must be a string of up to 200 characters`);
		return value;
	};
	try {
		if (path === `${HOSTOPS_AGENT_PATH}/poll`) {
			const waitMs = body.waitMs ?? MAX_POLL_WAIT_MS;
			if (!isInt(waitMs, 0, MAX_POLL_WAIT_MS)) return fail(400, `waitMs must be a whole number from 0 to ${MAX_POLL_WAIT_MS}`);
			const polled = await hostOps(env).poll(token, { agentVersion: text(body.agentVersion, "agentVersion"), commit: text(body.commit, "commit") }, waitMs);
			if (!polled.ok) return fail(401, "Unauthorized");
			return polled.op ? json({ op: polled.op }) : new Response(null, { status: 204 });
		}
		if (path === `${HOSTOPS_AGENT_PATH}/result`) {
			const { id, ok, state, summary, data } = body;
			if (typeof id !== "string" || id === "") return fail(400, "id must be the operation's id");
			if (typeof ok !== "boolean") return fail(400, "ok must be true or false");
			if (state !== "succeeded" && state !== "failed" && state !== "rolled_back") return fail(400, "state must be succeeded, failed or rolled_back");
			if (ok !== (state === "succeeded")) return fail(400, "ok must be true exactly when state is succeeded");
			if (typeof summary !== "string" || summary.length > MAX_SUMMARY) return fail(400, `summary must be a string of up to ${MAX_SUMMARY} characters`);
			if (!isObject(data)) return fail(400, "data must be an object");
			if (new TextEncoder().encode(JSON.stringify(data)).length > MAX_DATA_BYTES) return fail(400, `data must be at most ${MAX_DATA_BYTES} bytes of JSON`);
			const reported = await hostOps(env).result(token, { id, ok, state, summary, data: data as HostOpData });
			return reported.op ? json(reported.op) : fail(reported.status, reported.error ?? "Failed");
		}
		return fail(404, "Not found");
	} catch (error) {
		if (error instanceof HttpError) return fail(error.status, error.message);
		throw error;
	}
}
