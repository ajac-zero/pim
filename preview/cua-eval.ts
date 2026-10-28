import { isHttpsOrigin } from "../src/cua-viewer";
import { type Account, type ClaimCode, Directory as RealDirectory, type Registration } from "../src/directory";
import { AutomationLedger, type AutomationRow, MAX_LIVE_SESSIONS } from "./automation";
import { type EvaluatorPhase, type EvaluatorRun, LaunchEvaluatorLedger } from "./launch-evaluator";
import { CLIENT_IP_HEADER, INGRESS_SECRET_HEADER, runtimeOf } from "../src/runtime";

/**
 * The preview's Cua evaluation mode (docs/cua-viewer-first-vm-plan.md): the
 * same preview Worker, made safe to put behind a public HTTPS address for one
 * person. It is opted into only by `PREVIEW_MODE=cua-eval` in the preview's
 * private environment; without it the preview is the local one, as before.
 *
 * In this mode:
 *
 * - **No sign-in without a passkey.** `/__dev/…` is not found, by any method or
 *   spelling, and no setup link is written to the logs (`/auth/setup-link` is
 *   not found), so a session comes only from a passkey ceremony at
 *   `PIM_PUBLIC_URL`, as in a deployment. The one exception is a runner's
 *   short, read-only automation session, off unless the private environment
 *   grants one for the claimed owner (./automation.ts).
 * - **One named runtime** (src/runtime.ts), `PIM_RUNTIME`, which must be set:
 *   - `celld`: the operator's ingress in front of a local Worker. Every request
 *     must carry `PIM_INGRESS_SECRET` and the client's address, as the ingress
 *     proxy sets them, and the Directory counts the rate limits.
 *   - `cloudflare`: a Worker of its own on Cloudflare (wrangler.cua-eval.jsonc).
 *     Cloudflare reports the client's address, and the `AUTH_LIMITER` and
 *     `API_LIMITER` bindings must be there to count the rate limits.
 *   On either, no claim window opens.
 * - **Only at Pim's address.** A request whose URL isn't at `PIM_PUBLIC_URL`
 *   is misdirected (`421`), loopback included; nothing is rewritten onto it,
 *   and no `Host` or forwarded header is taken as the authority.
 * - **Registration is closed**, whatever `PIM_REGISTRATION` says.
 * - **One owner, set up once.** The operator makes a claim code privately and
 *   gives the preview only its SHA-256 (`PREVIEW_EVAL_CLAIM_SHA256`). The
 *   person opens `/#claim=<code>` and registers as Pim's admin with it, then
 *   makes their passkey. The registration's JSON carries the code to the
 *   Worker, which hashes and compares it and keeps and logs none of it.
 *   `EvalDirectory` records that the claim began before it registers anyone,
 *   and from then on refuses every claim, whatever became of that one: a claim
 *   that didn't finish leaves the evaluation without an owner, for good. A
 *   Directory that already holds any account is never claimed.
 *
 * A misconfigured preview refuses every request rather than run in the local
 * mode by mistake: an HTTPS `PIM_PUBLIC_URL` without this mode, this mode
 * without an exact HTTPS address, a named runtime, that runtime's ingress
 * secret or rate limits, or a well-formed claim digest, and, in the local
 * mode, any request that carries the ingress's headers.
 */

export const EVAL_MODE = "cua-eval";

/** The headers only the operator's ingress sends (src/runtime.ts). A local preview never gets them. */
const INGRESS_HEADERS = [INGRESS_SECRET_HEADER, CLIENT_IP_HEADER];
/** A claim code as the operator makes it: 32 random bytes, base64url, as the Directory's own are. */
const CLAIM_CODE = /^[A-Za-z0-9_-]{43}$/;
/** Its SHA-256, in lowercase hex, which is all the preview is given. */
const CLAIM_DIGEST = /^[0-9a-f]{64}$/;

export type PreviewMode = { readonly mode: "local" } | { readonly mode: typeof EVAL_MODE; readonly env: Env } | { readonly refused: string };

const vars = (env: unknown) => env as Record<string, unknown>;

/** Whether this environment asks for the evaluation mode; what it then allows is `previewMode`'s. */
export const evaluating = (env: unknown) => vars(env).PREVIEW_MODE === EVAL_MODE;

/**
 * The mode the preview's environment chooses, with the environment the
 * evaluation mode serves with: the ingress profile and closed registration,
 * over whatever the environment set. Or why the preview refuses to serve.
 */
export function previewMode(env: Env): PreviewMode {
	const named = vars(env).PREVIEW_MODE;
	const publicUrl = vars(env).PIM_PUBLIC_URL;
	if (named === undefined || named === "") {
		const https = typeof publicUrl === "string" && URL.parse(publicUrl.trim())?.protocol === "https:";
		return https ? { refused: "https-without-mode" } : { mode: "local" };
	}
	if (named !== EVAL_MODE) return { refused: "mode" };
	if (typeof publicUrl !== "string" || !isHttpsOrigin(publicUrl)) return { refused: "public-url" };
	const digest = vars(env).PREVIEW_EVAL_CLAIM_SHA256;
	if (digest !== undefined && (typeof digest !== "string" || !CLAIM_DIGEST.test(digest))) return { refused: "claim-digest" };
	// The runtime is named, never assumed: unset would mean Cloudflare to the rest of Pim.
	const runtime = vars(env).PIM_RUNTIME;
	if (runtime !== "celld" && runtime !== "cloudflare") return { refused: "runtime" };
	// On Cloudflare, without the rate limits, nothing would slow guessing down (src/runtime.ts's `limited`).
	if (runtime === "cloudflare" && (!vars(env).AUTH_LIMITER || !vars(env).API_LIMITER)) return { refused: "limiters" };
	// Read through to the real environment for everything else, bindings included. On Cloudflare, no deploy's
	// date reaches the claim window, so none opens and the sign-in page never offers one.
	const overrides = { PIM_RUNTIME: runtime, PIM_REGISTRATION: "closed", ...(runtime === "cloudflare" ? { CF_VERSION_METADATA: undefined } : {}) };
	const hardened = Object.assign(Object.create(env as object), overrides) as Env;
	if (runtimeOf(hardened) !== runtime) return { refused: "ingress" };
	return { mode: EVAL_MODE, env: hardened };
}

/** Whether a local preview was reached through an ingress, which only the evaluation mode may be. */
export const throughIngress = (request: Request) => INGRESS_HEADERS.some((name) => request.headers.has(name));

/**
 * Whether the evaluation mode answers nothing at this path, before anything
 * else reads the request: everything under `/__dev`, however it is written
 * (case, percent-encoding, repeated slashes), and the setup link.
 */
export function closedInEvaluation(pathname: string): boolean {
	let path: string;
	try {
		path = decodeURIComponent(pathname).toLowerCase();
	} catch {
		return true;
	}
	const trimmed = path.replace(/^\/+/, "/").replace(/\/+$/, "");
	return trimmed === "/__dev" || trimmed.startsWith("/__dev/") || trimmed === "/auth/setup-link";
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const refused = (error: string): Registration => ({ ok: false, status: 403, error });

/** What the evaluation's Directory keeps of its one claim. */
export type Claimed = { readonly state: "claiming" | "claimed" | "failed" | "refused"; readonly username: string; readonly ownerId: string | null; readonly at: number };

const ONCE = "This evaluation's owner was set up once already, and isn't set up again.";

/**
 * The evaluation's one claim, as its Directory keeps it: one row, made once by
 * a plain insert (`begin`) before anyone is registered, and afterwards only
 * moved on from `claiming` (`finish`). Nothing replaces or deletes it. It is a
 * class of its own rather than methods of the Directory, so it adds nothing
 * anyone could call on the Directory, and tests can make its writes fail.
 */
export class ClaimRecord {
	constructor(readonly sql: SqlStorage) {
		sql.exec(
			"CREATE TABLE IF NOT EXISTS preview_eval_claim (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, username TEXT NOT NULL, owner_id TEXT, at INTEGER NOT NULL)",
		);
	}

	read(): Claimed | null {
		const row = this.sql.exec("SELECT state, username, owner_id, at FROM preview_eval_claim WHERE id = 1").toArray()[0];
		return row ? { state: row.state as Claimed["state"], username: String(row.username), ownerId: row.owner_id === null ? null : String(row.owner_id), at: Number(row.at) } : null;
	}

	/** The one claim, recorded: `claiming` before a registration, or `refused` for good. A second insert fails. */
	begin(state: "claiming" | "refused", username: string, at: number): void {
		this.sql.exec("INSERT INTO preview_eval_claim (id, state, username, owner_id, at) VALUES (1, ?, ?, NULL, ?)", state, username, at);
	}

	/** What became of a claim still `claiming`; anything else is left as it is. */
	finish(state: "claimed" | "failed", ownerId: string | null): void {
		this.sql.exec("UPDATE preview_eval_claim SET state = ?, owner_id = ? WHERE id = 1 AND state = 'claiming'", state, ownerId);
	}
}

const logClaim = (fields: Record<string, unknown>) => console.log(JSON.stringify({ event: "preview.eval_claim", ...fields }));

/**
 * The preview's Directory: the real one, and in the evaluation mode one claim
 * at most, with the operator's code, into a Directory that has no account.
 */
export class EvalDirectory extends RealDirectory {
	/** Whether `code` is the operator's: its SHA-256 is the one the environment gives, compared in constant time. */
	async #matches(code: string): Promise<boolean> {
		const expected = vars(this.env).PREVIEW_EVAL_CLAIM_SHA256;
		if (typeof expected !== "string" || !CLAIM_DIGEST.test(expected) || !CLAIM_CODE.test(code)) return false;
		const given = new TextEncoder().encode(hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))));
		return crypto.subtle.timingSafeEqual(given, new TextEncoder().encode(expected));
	}

	/**
	 * Says what became of the claim. A record that can't be moved on stays
	 * `claiming`, which refuses every later claim as surely, and that is logged.
	 */
	#finish(claims: ClaimRecord, state: "claimed" | "failed", ownerId: string | null): void {
		try {
			claims.finish(state, ownerId);
			logClaim({ state, ...(ownerId ? { owner: ownerId } : {}) });
		} catch {
			logClaim({ state: "claiming", unrecorded: state, ...(ownerId ? { owner: ownerId } : {}) });
		}
	}

	override async register(input: Parameters<RealDirectory["register"]>[0]): Promise<Registration> {
		if (!evaluating(this.env)) return super.register(input);
		const now = input.now ?? Date.now();
		const code = input.claim?.code;
		if (code === undefined) return refused("Registration is closed.");
		const claims = new ClaimRecord(this.ctx.storage.sql);
		if (claims.read() !== null) return refused(ONCE);
		if (!(await this.#matches(code))) return refused("That setup link isn't valid.");
		// From this check to the record nothing waits, so of two claims at once only one is recorded.
		if (claims.read() !== null) return refused(ONCE);
		const occupied = this.ctx.storage.sql.exec("SELECT 1 FROM accounts LIMIT 1").toArray().length > 0;
		try {
			claims.begin(occupied ? "refused" : "claiming", input.username, now);
		} catch {
			// Nothing was recorded, so nobody is registered.
			logClaim({ state: "unrecorded" });
			return { ok: false, status: 503, error: "The claim couldn't be recorded, so nobody was set up." };
		}
		logClaim({ state: occupied ? "refused" : "claiming" });
		if (occupied) return refused("This Pim already has accounts, so it isn't set up for an evaluation.");
		let result: Registration;
		try {
			result = await super.register({ username: input.username, ip: input.ip, policy: { ...input.policy, mode: "closed" }, claim: { window: true }, now });
		} catch (error) {
			this.#finish(claims, "failed", null);
			throw error;
		}
		const ok = result.ok && result.account.role === "admin";
		this.#finish(claims, ok ? "claimed" : "failed", ok ? result.account.ownerId : null);
		return result;
	}

	/**
	 * The account automation may sign in as (./automation.ts): only in the
	 * evaluation, only the owner its claim set up, and only while active.
	 */
	#automatable(owner: string): Account | null {
		if (!evaluating(this.env)) return null;
		const claimed = new ClaimRecord(this.ctx.storage.sql).read();
		const account = claimed?.state === "claimed" && claimed.ownerId === owner ? this.account(owner) : null;
		return account?.status === "active" ? account : null;
	}

	/** Records an automation session, unless its grant was revoked, it names anyone but the claimed, active owner, or the grant has too many open. */
	automationBegin(row: Omit<AutomationRow, "endedAt">): { ok: true; account: Account } | { ok: false; reason: "refused" | "revoked" | "full" } {
		const account = this.#automatable(row.owner);
		if (!account) return { ok: false, reason: "refused" };
		const ledger = new AutomationLedger(this.ctx.storage.sql);
		if (ledger.revoked(row.grant)) return { ok: false, reason: "revoked" };
		if (ledger.live(row.grant, row.createdAt) >= MAX_LIVE_SESSIONS) return { ok: false, reason: "full" };
		ledger.begin(row);
		return { ok: true, account };
	}

	/** The automation session a cookie's SHA-256 names, if it is neither ended, expired nor of a revoked grant, and its owner can still sign in; read afresh every time. */
	automationSession(digest: string, now: number): { session: AutomationRow; account: Account } | null {
		if (!evaluating(this.env)) return null;
		const ledger = new AutomationLedger(this.ctx.storage.sql);
		const session = ledger.read(digest);
		if (!session || session.endedAt !== null || session.expiresAt <= now || ledger.revoked(session.grant)) return null;
		const account = this.#automatable(session.owner);
		return account ? { session, account } : null;
	}

	automationEnd(digest: string, now: number): void {
		if (evaluating(this.env)) new AutomationLedger(this.ctx.storage.sql).end(digest, now);
	}

	/** Revokes a grant for good: every session it made stops at once, and its credential makes no more. */
	automationRevoke(grant: string, now: number): void {
		if (evaluating(this.env)) new AutomationLedger(this.ctx.storage.sql).revoke(grant, now);
	}

	/**
	 * Begins a launch evaluator's one run (./launch-evaluator.ts) as
	 * `launching`, for the claimed, active owner only. A grant that has a run
	 * already, in any phase, is spent.
	 */
	evaluatorClaim(row: Omit<EvaluatorRun, "phase" | "observation" | "updatedAt">): { ok: true } | { ok: false; reason: "refused" } | { ok: false; reason: "spent"; phase: EvaluatorPhase } {
		if (!this.#automatable(row.owner)) return { ok: false, reason: "refused" };
		const ledger = new LaunchEvaluatorLedger(this.ctx.storage.sql);
		if (ledger.claim(row)) return { ok: true };
		return { ok: false, reason: "spent", phase: ledger.read(row.grant)!.phase };
	}

	/** Records what the space answered the run's launch: `launching` moves on once, to `open` with the fresh ID or to a refusal or uncertainty. */
	evaluatorLaunched(grant: string, phase: "open" | "launch_refused" | "launch_uncertain", observation: string | null, now: number): boolean {
		if (!evaluating(this.env)) return false;
		return new LaunchEvaluatorLedger(this.ctx.storage.sql).move(grant, "launching", phase, now, observation);
	}

	/**
	 * Moves the run to `ending` if, now, it may end: its run token's digest
	 * matches, it is `open`, it names exactly `observation`, its owner is still
	 * the claimed active one, and its deadline hasn't come. An open run past
	 * its deadline becomes `expired` and never ends from here.
	 */
	evaluatorEnding(
		grant: string,
		run: string,
		observation: string,
		now: number,
	): { ok: true; observation: string } | { ok: false; reason: "none" | "run" | "phase" | "observation" | "expired" | "refused"; phase: EvaluatorPhase | null } {
		if (!evaluating(this.env)) return { ok: false, reason: "none", phase: null };
		const ledger = new LaunchEvaluatorLedger(this.ctx.storage.sql);
		const found = ledger.read(grant);
		if (!found) return { ok: false, reason: "none", phase: null };
		const bytes = new TextEncoder();
		if (run.length !== found.run.length || !crypto.subtle.timingSafeEqual(bytes.encode(run), bytes.encode(found.run))) return { ok: false, reason: "run", phase: found.phase };
		if (found.phase !== "open") return { ok: false, reason: "phase", phase: found.phase };
		if (now >= found.deadline) {
			ledger.move(grant, "open", "expired", now);
			return { ok: false, reason: "expired", phase: "expired" };
		}
		if (found.observation === null || found.observation !== observation) return { ok: false, reason: "observation", phase: found.phase };
		if (!this.#automatable(found.owner)) return { ok: false, reason: "refused", phase: found.phase };
		return ledger.move(grant, "open", "ending", now) ? { ok: true, observation: found.observation } : { ok: false, reason: "phase", phase: found.phase };
	}

	/** Records how the run's one End went: `ending` moves on once, and the run is over for good. */
	evaluatorEnded(grant: string, phase: "ended" | "end_refused" | "end_uncertain", now: number): boolean {
		if (!evaluating(this.env)) return false;
		return new LaunchEvaluatorLedger(this.ctx.storage.sql).move(grant, "ending", phase, now);
	}

	/** No claim code is made, or written to the logs, for an evaluation: the operator's is the only one. */
	override claimCode(now?: number): ClaimCode {
		if (evaluating(this.env)) throw new Error("This preview is set up with the operator's claim code, and makes none.");
		return super.claimCode(now);
	}
}
