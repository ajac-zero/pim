import { isHttpsOrigin } from "../src/cua-viewer";
import { type ClaimCode, Directory as RealDirectory, type Registration } from "../src/directory";
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
 *   `PIM_PUBLIC_URL`, as in a deployment.
 * - **Only through the operator's ingress.** The Worker runs with the ingress
 *   profile a celld deployment uses (src/runtime.ts): every request must carry
 *   `PIM_INGRESS_SECRET` and the client's address, as the ingress proxy sets
 *   them, and the Directory counts the rate limits. No claim window opens.
 * - **Registration is closed**, whatever `PIM_REGISTRATION` says.
 * - **One owner, set up once.** The operator makes a claim code privately and
 *   gives the preview only its SHA-256 (`PREVIEW_EVAL_CLAIM_SHA256`). The
 *   person opens `/#claim=<code>` and registers as Pim's admin with it, then
 *   makes their passkey. `EvalDirectory` records that the claim began before it
 *   registers anyone, and from then on refuses every claim, whatever became of
 *   that one: a claim that didn't finish leaves the evaluation without an owner,
 *   for good. A Directory that already holds any account is never claimed.
 *
 * A misconfigured preview refuses every request rather than run in the local
 * mode by mistake: an HTTPS `PIM_PUBLIC_URL` without this mode, this mode
 * without an exact HTTPS address, a usable ingress secret or a well-formed
 * claim digest, and, in the local mode, any request that carries the ingress's
 * headers.
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
	// Read through to the real environment for everything else, bindings included.
	const hardened = Object.assign(Object.create(env as object), { PIM_RUNTIME: "celld", PIM_REGISTRATION: "closed" }) as Env;
	if (runtimeOf(hardened) !== "celld") return { refused: "ingress" };
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
type Claimed = { readonly state: "claiming" | "claimed" | "failed" | "refused"; readonly username: string; readonly ownerId: string | null; readonly at: number };

/**
 * The preview's Directory: the real one, and in the evaluation mode one claim
 * at most, with the operator's code, into a Directory that has no account.
 */
export class EvalDirectory extends RealDirectory {
	#claimed(): Claimed | null {
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS preview_eval_claim (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, username TEXT NOT NULL, owner_id TEXT, at INTEGER NOT NULL)",
		);
		const row = this.ctx.storage.sql.exec("SELECT state, username, owner_id, at FROM preview_eval_claim WHERE id = 1").toArray()[0];
		return row ? { state: row.state as Claimed["state"], username: String(row.username), ownerId: row.owner_id === null ? null : String(row.owner_id), at: Number(row.at) } : null;
	}

	#record(claimed: Claimed): void {
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO preview_eval_claim (id, state, username, owner_id, at) VALUES (1, ?, ?, ?, ?)",
			claimed.state,
			claimed.username,
			claimed.ownerId,
			claimed.at,
		);
		console.log(JSON.stringify({ event: "preview.eval_claim", state: claimed.state, ...(claimed.ownerId ? { owner: claimed.ownerId } : {}) }));
	}

	/** Whether `code` is the operator's: its SHA-256 is the one the environment gives, compared in constant time. */
	async #matches(code: string): Promise<boolean> {
		const expected = vars(this.env).PREVIEW_EVAL_CLAIM_SHA256;
		if (typeof expected !== "string" || !CLAIM_DIGEST.test(expected) || !CLAIM_CODE.test(code)) return false;
		const given = new TextEncoder().encode(hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))));
		return crypto.subtle.timingSafeEqual(given, new TextEncoder().encode(expected));
	}

	override async register(input: Parameters<RealDirectory["register"]>[0]): Promise<Registration> {
		if (!evaluating(this.env)) return super.register(input);
		const now = input.now ?? Date.now();
		const code = input.claim?.code;
		if (code === undefined) return refused("Registration is closed.");
		if (this.#claimed() !== null) return refused("This evaluation's owner was set up once already, and isn't set up again.");
		if (!(await this.#matches(code))) return refused("That setup link isn't valid.");
		// From here to the record, nothing waits, so two claims can't both pass.
		if (this.#claimed() !== null) return refused("This evaluation's owner was set up once already, and isn't set up again.");
		if (this.ctx.storage.sql.exec("SELECT 1 FROM accounts LIMIT 1").toArray().length > 0) {
			this.#record({ state: "refused", username: input.username, ownerId: null, at: now });
			return refused("This Pim already has accounts, so it isn't set up for an evaluation.");
		}
		// Recorded before anyone is registered: whatever happens next, this was the one claim.
		this.#record({ state: "claiming", username: input.username, ownerId: null, at: now });
		let result: Registration;
		try {
			result = await super.register({ username: input.username, ip: input.ip, policy: { ...input.policy, mode: "closed" }, claim: { window: true }, now });
		} catch (error) {
			this.#record({ state: "failed", username: input.username, ownerId: null, at: now });
			throw error;
		}
		const ok = result.ok && result.account.role === "admin";
		this.#record({ state: ok ? "claimed" : "failed", username: input.username, ownerId: ok ? result.account.ownerId : null, at: now });
		return result;
	}

	/** No claim code is made, or written to the logs, for an evaluation: the operator's is the only one. */
	override claimCode(now?: number): ClaimCode {
		if (evaluating(this.env)) throw new Error("This preview is set up with the operator's claim code, and makes none.");
		return super.claimCode(now);
	}
}
