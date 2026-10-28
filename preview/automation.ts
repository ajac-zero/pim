import { isHttpsOrigin } from "../src/cua-viewer";
import { base64UrlEncode } from "../src/auth/encoding";
import type { Account } from "../src/directory";
import type { AutomationSessions } from "../src/gateway";
import type { EvalDirectory } from "./cua-eval";

/**
 * Automation sign-in for the preview's Cua evaluation (docs/preview-automation.md):
 * a runner the operator protects signs an isolated browser, and its own API
 * calls, in as the evaluation's one owner without a passkey, for a short
 * while, to read only.
 *
 * Only the evaluation mounts it (preview/worker.ts's `evaluation`), and only
 * through `serve`'s `automation` mount, which a deployment's entry point
 * (src/index.ts) never passes: copying these variables into a deployment
 * opens nothing. In the evaluation it is off unless both are set:
 *
 * - `PREVIEW_AUTOMATION=on`, the explicit opt-in;
 * - `PREVIEW_AUTOMATION_GRANT`, one JSON object naming the claimed owner, the
 *   evaluation, the deployment (`cua-eval@<PIM_RUNTIME>`), Pim's exact
 *   address, the SHA-256 of the operator's credential (never the credential)
 *   and the evaluation's absolute cleanup deadline.
 *
 * The runner trades the credential, in a header of a POST from Pim's own
 * origin, for a session cookie of its own kind: host-only, `Secure`,
 * `HttpOnly`, `SameSite=Strict`, for at most 30 minutes and never past the
 * deadline. The Directory keeps only the cookie's SHA-256 beside what it is
 * bound to. Every request that carries it, sockets included, is checked
 * again from the grant in the environment and the Directory's own record:
 * on, the same grant, owner, evaluation, deployment and address, not
 * expired, not ended, the grant not revoked, the owner still the claimed one
 * and active. Nothing is cached between requests, so revoking the grant, or
 * changing or removing it, ends every session it made at once.
 *
 * A session reads only: GET and HEAD, and none of the reads that reach the
 * computer, the browser, the viewer's host or a model, or export everything.
 * It opens no socket: every handshake on one is refused in the gateway,
 * before any space sees it. The space checks a socket only at its handshake,
 * for passkey sessions too, so an automation socket would outlive its
 * session's revocation; refusing them leaves no such connection to miss. It is never a passkey session: `/auth` manages nothing for it,
 * it makes no token, passkey or account, and the space is never told it is
 * the person's browser, except for the list of observations, which the space
 * answers from what it holds.
 */

export const AUTOMATION_COOKIE = "__Host-pim-automation";
/** The `Authorization` scheme the credential comes in, so it never rides in a URL or a body. */
export const AUTOMATION_SCHEME = "Pim-Automation";
export const SESSION_PATH = "/auth/automation/session";
export const REVOKE_PATH = "/auth/automation/revoke";
/** The longest a session lasts. */
export const MAX_SESSION_MS = 30 * 60 * 1000;
/** Sessions a grant may hold open at once. */
export const MAX_LIVE_SESSIONS = 8;
/** How far ahead a grant's deadline may be. */
const MAX_GRANT_MS = 7 * 24 * 60 * 60 * 1000;

/** The operator's credential: 32 random bytes, base64url, as the claim code is. The cookie is made the same way. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const OWNER = /^o_[0-9a-z]{26}$/;
/** As docs/cua-eval-credentials.md names evaluations. */
const EVALUATION = /^[a-z0-9][a-z0-9-]{2,62}$/;
const GRANT_KEYS = ["credentialSha256", "deployment", "evaluation", "notAfter", "origin", "owner"];
const IDENTITY_KEYS = ["deployment", "evaluation", "owner"];

/** What the grant in the environment allows: to whom, where, and until when. */
export type AutomationGrant = {
	readonly owner: string;
	readonly evaluation: string;
	readonly deployment: string;
	readonly origin: string;
	readonly credentialSha256: string;
	readonly notAfter: number;
};

/** A session as the Directory keeps it: the cookie's SHA-256 and what the session is bound to. */
export type AutomationRow = {
	readonly digest: string;
	readonly grant: string;
	readonly owner: string;
	readonly evaluation: string;
	readonly deployment: string;
	readonly origin: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly endedAt: number | null;
};

const vars = (env: unknown) => env as Record<string, unknown>;

/**
 * The grant the evaluation's environment holds, if automation is on and the
 * grant is well formed for this Worker now, or why it is off. `env` is the
 * evaluation's own (preview/cua-eval.ts's `previewMode`).
 */
export function automationGrant(env: Env, now: number): AutomationGrant | { off: string } {
	if (vars(env).PREVIEW_AUTOMATION !== "on") return { off: "flag" };
	const raw = vars(env).PREVIEW_AUTOMATION_GRANT;
	let grant: Record<string, unknown>;
	try {
		grant = typeof raw === "string" ? JSON.parse(raw) : null;
	} catch {
		return { off: "grant" };
	}
	if (!grant || typeof grant !== "object" || Array.isArray(grant) || Object.keys(grant).sort().join() !== GRANT_KEYS.join()) return { off: "grant" };
	const { owner, evaluation, deployment, origin, credentialSha256, notAfter } = grant;
	const deadline = typeof notAfter === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(notAfter) ? Date.parse(notAfter) : Number.NaN;
	if (typeof owner !== "string" || !OWNER.test(owner)) return { off: "owner" };
	if (typeof evaluation !== "string" || !EVALUATION.test(evaluation)) return { off: "evaluation" };
	if (vars(env).PREVIEW_MODE !== "cua-eval" || deployment !== `cua-eval@${vars(env).PIM_RUNTIME}`) return { off: "deployment" };
	if (typeof origin !== "string" || !isHttpsOrigin(origin) || origin !== vars(env).PIM_PUBLIC_URL) return { off: "origin" };
	if (typeof credentialSha256 !== "string" || !DIGEST.test(credentialSha256)) return { off: "digest" };
	if (!Number.isFinite(deadline) || deadline > now + MAX_GRANT_MS) return { off: "deadline" };
	if (deadline <= now) return { off: "expired" };
	return { owner, evaluation, deployment, origin, credentialSha256, notAfter: deadline };
}

/**
 * The evaluation Directory's automation sessions and revoked grants. Rows are
 * only added and moved on: a session ends, a grant is revoked, and neither
 * comes back.
 */
export class AutomationLedger {
	constructor(readonly sql: SqlStorage) {
		sql.exec(
			"CREATE TABLE IF NOT EXISTS preview_automation_sessions (digest TEXT PRIMARY KEY, grant_digest TEXT NOT NULL, owner TEXT NOT NULL, evaluation TEXT NOT NULL, deployment TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended_at INTEGER)",
		);
		sql.exec("CREATE TABLE IF NOT EXISTS preview_automation_revoked (grant_digest TEXT PRIMARY KEY, at INTEGER NOT NULL)");
	}

	read(digest: string): AutomationRow | null {
		const row = this.sql.exec("SELECT * FROM preview_automation_sessions WHERE digest = ?", digest).toArray()[0];
		if (!row) return null;
		return {
			digest: String(row.digest),
			grant: String(row.grant_digest),
			owner: String(row.owner),
			evaluation: String(row.evaluation),
			deployment: String(row.deployment),
			origin: String(row.origin),
			createdAt: Number(row.created_at),
			expiresAt: Number(row.expires_at),
			endedAt: row.ended_at === null ? null : Number(row.ended_at),
		};
	}

	/** Sessions of `grant` neither ended nor expired at `now`. */
	live(grant: string, now: number): number {
		return Number(this.sql.exec("SELECT COUNT(*) AS n FROM preview_automation_sessions WHERE grant_digest = ? AND ended_at IS NULL AND expires_at > ?", grant, now).one().n);
	}

	begin(row: Omit<AutomationRow, "endedAt">): void {
		this.sql.exec(
			"INSERT INTO preview_automation_sessions (digest, grant_digest, owner, evaluation, deployment, origin, created_at, expires_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
			row.digest,
			row.grant,
			row.owner,
			row.evaluation,
			row.deployment,
			row.origin,
			row.createdAt,
			row.expiresAt,
		);
	}

	end(digest: string, now: number): void {
		this.sql.exec("UPDATE preview_automation_sessions SET ended_at = ? WHERE digest = ? AND ended_at IS NULL", now, digest);
	}

	revoke(grant: string, now: number): void {
		this.sql.exec("INSERT OR IGNORE INTO preview_automation_revoked (grant_digest, at) VALUES (?, ?)", grant, now);
	}

	revoked(grant: string): boolean {
		return this.sql.exec("SELECT 1 FROM preview_automation_revoked WHERE grant_digest = ?", grant).toArray().length > 0;
	}
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (value: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

const directory = (env: Env) => (env.Directory as unknown as DurableObjectNamespace<EvalDirectory>).getByName("directory");

function readCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
	return null;
}

const cookie = (value: string, seconds: number) => `${AUTOMATION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;

function json(body: unknown, status = 200, cookies: string[] = []): Response {
	const response = Response.json(body, { status, headers: { "cache-control": "no-store" } });
	for (const value of cookies) response.headers.append("set-cookie", value);
	return response;
}

const fail = (status: number, error: string, cookies: string[] = []) => json({ error }, status, cookies);
const INVALID = "That automation credential isn't valid for this preview.";
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ event: "preview.automation", ...fields }));

/** A session that is good now, with its grant and the owner's account as the Directory has it. */
type Current = { readonly grant: AutomationGrant; readonly session: AutomationRow; readonly account: Account; readonly digest: string };

/** The request's automation session, checked again in full now, or null. */
async function current(request: Request, env: Env, now: number): Promise<Current | null> {
	const value = readCookie(request, AUTOMATION_COOKIE);
	if (value === null || !SECRET.test(value)) return null;
	const grant = automationGrant(env, now);
	if ("off" in grant || new URL(request.url).origin !== grant.origin) return null;
	const digest = await sha256(value);
	const found = await directory(env).automationSession(digest, now);
	if (!found) return null;
	const { session, account } = found;
	const bound =
		session.grant === grant.credentialSha256 &&
		session.owner === grant.owner &&
		session.evaluation === grant.evaluation &&
		session.deployment === grant.deployment &&
		session.origin === grant.origin;
	if (!bound || Math.min(session.expiresAt, grant.notAfter) <= now) return null;
	return { grant, session, account: account as Account, digest };
}

/** What the browser, and the banner, may know of a session: never the credential or the cookie. */
const view = ({ grant, session, account }: Pick<Current, "grant" | "session" | "account">) => ({
	kind: "automation",
	access: "read-only",
	owner: session.owner,
	username: account.username,
	evaluation: session.evaluation,
	deployment: session.deployment,
	origin: session.origin,
	expiresAt: new Date(Math.min(session.expiresAt, grant.notAfter)).toISOString(),
	notAfter: new Date(grant.notAfter).toISOString(),
});

/** Whether the request carries the operator's credential for `grant`, and names exactly its owner, evaluation and deployment. */
async function presents(request: Request, grant: AutomationGrant): Promise<string | null> {
	const header = request.headers.get("authorization") ?? "";
	const credential = header.startsWith(`${AUTOMATION_SCHEME} `) ? header.slice(AUTOMATION_SCHEME.length + 1) : "";
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!SECRET.test(credential)) return "credential";
	if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join() !== IDENTITY_KEYS.join()) return "body";
	const given = new TextEncoder().encode(await sha256(credential));
	if (!crypto.subtle.timingSafeEqual(given, new TextEncoder().encode(grant.credentialSha256))) return "credential";
	if (body.owner !== grant.owner) return "owner";
	if (body.evaluation !== grant.evaluation) return "evaluation";
	if (body.deployment !== grant.deployment) return "deployment";
	return null;
}

/** Trades the credential for a session cookie. */
async function exchange(request: Request, env: Env, grant: AutomationGrant, now: number): Promise<Response> {
	const wrong = await presents(request, grant);
	if (wrong) {
		log({ action: "exchange", outcome: "refused", reason: wrong });
		return fail(401, INVALID);
	}
	const value = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const expiresAt = Math.min(now + MAX_SESSION_MS, grant.notAfter);
	const row = { digest: await sha256(value), grant: grant.credentialSha256, owner: grant.owner, evaluation: grant.evaluation, deployment: grant.deployment, origin: grant.origin, createdAt: now, expiresAt };
	const begun = await directory(env).automationBegin(row);
	if (!begun.ok) {
		log({ action: "exchange", outcome: "refused", reason: begun.reason, owner: grant.owner });
		return begun.reason === "full" ? fail(429, `This grant already has ${MAX_LIVE_SESSIONS} sessions open. End one first.`) : fail(401, INVALID);
	}
	log({ action: "exchange", outcome: "issued", owner: grant.owner, expiresAt });
	const session = { ...row, endedAt: null };
	return json({ mode: "enabled", session: view({ grant, session, account: begun.account as Account }) }, 201, [cookie(value, Math.ceil((expiresAt - now) / 1000))]);
}

/** The read-only boundary: requests an automation session may make of the API, by path under `/api`. */
const READS = new Set(["GET", "HEAD"]);
/** Reads it may not make: the observations' status and anything under them (which may ask the viewer's host and settle a record), the agent's browser, a model's suggestions, ChatGPT's sign-in, and the export of everything. */
const NOT_READ = [/^\/observations\/./, /^\/browser(\/|$)/, /^\/agents\/[^/]+\/suggestions$/, /^\/chatgpt(\/|$)/, /^\/(account\/)?export$/];

/** The mount the evaluation passes to `serve` (src/gateway.ts). */
export const previewAutomation: AutomationSessions = {
	async auth(request, env) {
		const now = Date.now();
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		if (route === "GET /auth/session") {
			const found = await current(request, env, now);
			if (!found) return undefined;
			const { username, role } = found.account;
			const expiresAt = Math.min(found.session.expiresAt, found.grant.notAfter);
			return json({
				signedIn: true,
				method: "automation",
				passkey: null,
				credential: null,
				account: { username, role },
				name: null,
				providers: [],
				automation: view(found),
				agentPreview: { enabled: true, expiresAt },
			});
		}
		if (url.pathname !== SESSION_PATH && url.pathname !== REVOKE_PATH) return undefined;
		// Off, it isn't here: `/auth` answers these as a deployment does.
		const grant = automationGrant(env, now);
		if ("off" in grant) {
			log({ action: "route", outcome: "off", reason: grant.off });
			return undefined;
		}
		const origin = request.headers.get("origin");
		if (origin !== grant.origin && (origin !== null || !READS.has(request.method))) return fail(403, "Requests must come from this app");
		if (route === `GET ${SESSION_PATH}`) {
			const found = await current(request, env, now);
			return json({ mode: "enabled", session: found ? view(found) : null });
		}
		if (route === `POST ${SESSION_PATH}`) return exchange(request, env, grant, now);
		if (route === `DELETE ${SESSION_PATH}`) {
			const found = await current(request, env, now);
			if (found) {
				await directory(env).automationEnd(found.digest, now);
				log({ action: "end", outcome: "ended", owner: found.session.owner });
			}
			return json({ ok: true }, 200, [cookie("", 0)]);
		}
		if (route === `POST ${REVOKE_PATH}`) {
			const wrong = await presents(request, grant);
			if (wrong) {
				log({ action: "revoke", outcome: "refused", reason: wrong });
				return fail(401, INVALID);
			}
			await directory(env).automationRevoke(grant.credentialSha256, now);
			log({ action: "revoke", outcome: "revoked", owner: grant.owner });
			return json({ ok: true, revoked: true }, 200, [cookie("", 0)]);
		}
		return fail(405, `${url.pathname} takes ${url.pathname === SESSION_PATH ? "GET, POST and DELETE" : "POST"}`);
	},

	async describe(answer, env) {
		if (!answer.ok || "off" in automationGrant(env, Date.now())) return answer;
		const body = (await answer.json()) as Record<string, unknown>;
		const headers = new Headers(answer.headers);
		headers.delete("content-length");
		headers.set("cache-control", "no-store");
		return Response.json({ ...body, agentPreview: { enabled: true, expiresAt: null } }, { status: answer.status, headers });
	},

	async owner(request, env) {
		return (await current(request, env, Date.now()))?.session.owner ?? null;
	},

	refuses(path, request) {
		if (!READS.has(request.method) || request.headers.has("upgrade") || NOT_READ.some((pattern) => pattern.test(path))) {
			return Response.json({ error: "An automation session only reads, and not this." }, { status: 403, headers: { "cache-control": "no-store" } });
		}
		return undefined;
	},
};
