import { getAgentByName } from "agents";
import { base64UrlEncode } from "../src/auth/encoding";
import { type ObservationState, unresolvedObservations } from "../src/cua-observation";
import { isHttpsOrigin } from "../src/cua-viewer";
import type { EvalDirectory } from "./cua-eval";

/**
 * The launch evaluator for the preview's Cua evaluation (docs/launch-evaluator.md):
 * one Watch, one viewer and one End, for the evaluation's claimed owner,
 * authorized once by the operator and never again.
 *
 * It is not automation sign-in (./automation.ts) and shares nothing with it
 * but the evaluation it runs in. It has its own opt-in, its own grant with its
 * own credential (which must differ from the automation grant's), its own
 * `Authorization` scheme and its own two routes under `/auth`. It makes no
 * session and sets no cookie: nothing it hands out signs anyone in to `/api`,
 * a page or a socket. Only the evaluation mounts it (preview/worker.ts's
 * `evaluation`), through `serve`'s `launchEvaluator` mount, which a
 * deployment's entry point (src/index.ts) never passes. In the evaluation it
 * is off unless both are set:
 *
 * - `PREVIEW_LAUNCH_EVALUATOR=on`;
 * - `PREVIEW_LAUNCH_EVALUATOR_GRANT`, one JSON object: `kind`
 *   (`"launch-evaluator"`), the claimed owner, the evaluation, the deployment
 *   (`cua-eval@<PIM_RUNTIME>`), Pim's exact address, the SHA-256 of the
 *   operator's credential, the last moment a run may begin, and
 *   `existingUnconfirmed`: `null`, or the ID of the one earlier record the
 *   operator found `unconfirmed` (below).
 *
 * A grant runs once. The Directory keeps one row per grant (keyed by the
 * credential's digest) and only moves it forward, in this order:
 *
 *   launching → open | launch_refused | launch_uncertain
 *   open → ending | expired
 *   ending → ended | end_refused | end_uncertain
 *
 * `POST /auth/launch-evaluator/launch` inserts the row (a second insert for
 * the grant is refused, whatever the first became), then asks the owner's
 * space for one fresh observation over RPC, never over HTTP: the space
 * refuses unless its ledger holds nothing unresolved, so the launch can't
 * replay, watch or touch any earlier observation. The fresh ID the space
 * answers is recorded on the row, and a random run token is answered with
 * it. `POST /auth/launch-evaluator/end` needs the credential, the run token,
 * the row `open` and before its deadline, and names exactly the recorded ID;
 * the row moves to `ending` before the space is asked, so a second End is
 * refused, and to its final phase after. No route reads, ends or names any
 * other observation, and no route retries. A run's deadline is at most 10
 * minutes after it began, and never past the grant's `notAfter`.
 *
 * **The isolated-preview exception.** The space admits one unresolved
 * observation at a time, and its earlier Watch left one `unconfirmed`, which
 * stays so: nothing here reconciles, reads, ends or changes it. Only for this
 * evaluator, and only when its grant names that record in
 * `existingUnconfirmed`, the space starts one fresh observation beside it,
 * if, at that moment, it is the one unresolved record and `unconfirmed`
 * (`evaluatorAdmission`; the desk checks the same again). Beside a record
 * `pending_open`, `open` or `revoking`, beside two, beside another than the
 * named one, or without the name, nothing starts. The person's Watch and every
 * other route keep the rule as it was, a deployment has none of this, and
 * once the fresh record exists there are two unresolved, so no grant can
 * start a third.
 */

export const LAUNCH_EVALUATOR_PREFIX = "/auth/launch-evaluator";
export const LAUNCH_PATH = `${LAUNCH_EVALUATOR_PREFIX}/launch`;
export const END_PATH = `${LAUNCH_EVALUATOR_PREFIX}/end`;
/** The `Authorization` scheme of the operator's evaluator credential, distinct from automation's `Pim-Automation`. */
export const EVALUATOR_SCHEME = "Pim-Launch-Evaluator";
/** The header the run token comes back in, on the End only. */
export const RUN_HEADER = "x-pim-launch-evaluator-run";
/** The longest a run lasts from its launch. */
export const MAX_RUN_MS = 10 * 60 * 1000;
/** How far ahead a grant's `notAfter` may be: a grant is for one planned run, not a standing permission. */
const MAX_GRANT_MS = 24 * 60 * 60 * 1000;
const KIND = "launch-evaluator";

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const OWNER = /^o_[0-9a-z]{26}$/;
const EVALUATION = /^[a-z0-9][a-z0-9-]{2,62}$/;
/** An observation's ID, as the ledger allows them (src/cua-observation.ts). */
const OBSERVATION_ID = /^[A-Za-z0-9_-]{16,64}$/;
const GRANT_KEYS = ["credentialSha256", "deployment", "evaluation", "existingUnconfirmed", "kind", "notAfter", "origin", "owner"];
const LAUNCH_KEYS = ["deployment", "evaluation", "owner"];
const END_KEYS = ["deployment", "evaluation", "observation", "owner"];

export type EvaluatorGrant = {
	readonly owner: string;
	readonly evaluation: string;
	readonly deployment: string;
	readonly origin: string;
	readonly credentialSha256: string;
	readonly notAfter: number;
	/** The one earlier `unconfirmed` record the fresh observation may start beside, or null for none. */
	readonly existingUnconfirmed: string | null;
};

export type EvaluatorPhase = "launching" | "open" | "launch_refused" | "launch_uncertain" | "expired" | "ending" | "ended" | "end_refused" | "end_uncertain";

/** A run as the Directory keeps it: never the credential or the run token, only their digests. */
export type EvaluatorRun = {
	readonly grant: string;
	readonly owner: string;
	readonly evaluation: string;
	readonly deployment: string;
	readonly origin: string;
	readonly run: string;
	readonly phase: EvaluatorPhase;
	readonly observation: string | null;
	/** The earlier unconfirmed record the fresh observation started beside, if it did. */
	readonly alongside: string | null;
	readonly createdAt: number;
	readonly deadline: number;
	readonly updatedAt: number;
};

/** What the owner's space answers the evaluator's launch, over RPC (preview/worker.ts's `Pim`). */
export type SpaceLaunch =
	| { readonly outcome: "open"; readonly observation: { readonly id: string; readonly notAfter: number }; readonly viewer: string; readonly alongside: string | null }
	| { readonly outcome: "refused"; readonly reason: string }
	| { readonly outcome: "uncertain"; readonly observation: string | null };
/** What the owner's space answers the evaluator's End. */
export type SpaceEnd = { readonly outcome: "requested" | "final" | "refused" | "uncertain"; readonly status: string | null };
/** The two RPC methods the evaluator calls on the owner's space, and nothing else of it. */
export type EvaluatorSpace = { launchForEvaluator(): Promise<SpaceLaunch>; endForEvaluator(observation: string): Promise<SpaceEnd> };

const vars = (env: unknown) => env as Record<string, unknown>;

/** The automation grant's credential digest, if one is set at all: the evaluator's must differ. */
function automationDigest(env: Env): string | null {
	try {
		const raw = vars(env).PREVIEW_AUTOMATION_GRANT;
		const digest = typeof raw === "string" ? (JSON.parse(raw) as { credentialSha256?: unknown })?.credentialSha256 : undefined;
		return typeof digest === "string" ? digest : null;
	} catch {
		return null;
	}
}

/** The evaluator grant the evaluation's environment holds, if it is on and well formed for this Worker now, or why it is off. */
export function launchEvaluatorGrant(env: Env, now: number): EvaluatorGrant | { off: string } {
	if (vars(env).PREVIEW_LAUNCH_EVALUATOR !== "on") return { off: "flag" };
	const raw = vars(env).PREVIEW_LAUNCH_EVALUATOR_GRANT;
	let grant: Record<string, unknown>;
	try {
		grant = typeof raw === "string" ? JSON.parse(raw) : null;
	} catch {
		return { off: "grant" };
	}
	if (!grant || typeof grant !== "object" || Array.isArray(grant) || Object.keys(grant).sort().join() !== GRANT_KEYS.join() || grant.kind !== KIND) return { off: "grant" };
	const { owner, evaluation, deployment, origin, credentialSha256, notAfter, existingUnconfirmed } = grant;
	const deadline = typeof notAfter === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(notAfter) ? Date.parse(notAfter) : Number.NaN;
	if (typeof owner !== "string" || !OWNER.test(owner)) return { off: "owner" };
	if (typeof evaluation !== "string" || !EVALUATION.test(evaluation)) return { off: "evaluation" };
	if (vars(env).PREVIEW_MODE !== "cua-eval" || deployment !== `cua-eval@${vars(env).PIM_RUNTIME}`) return { off: "deployment" };
	if (typeof origin !== "string" || !isHttpsOrigin(origin) || origin !== vars(env).PIM_PUBLIC_URL) return { off: "origin" };
	if (typeof credentialSha256 !== "string" || !DIGEST.test(credentialSha256)) return { off: "digest" };
	if (credentialSha256 === automationDigest(env)) return { off: "shared-credential" };
	if (!Number.isFinite(deadline) || deadline > now + MAX_GRANT_MS) return { off: "deadline" };
	if (deadline <= now) return { off: "expired" };
	if (existingUnconfirmed !== null && (typeof existingUnconfirmed !== "string" || !OBSERVATION_ID.test(existingUnconfirmed))) return { off: "existing" };
	return { owner, evaluation, deployment, origin, credentialSha256, notAfter: deadline, existingUnconfirmed };
}

/**
 * Whether the evaluator's one fresh observation may start in a ledger in
 * `state`, and beside which record: with nothing unresolved, when the grant
 * names none; or beside exactly `existingUnconfirmed`, when that is the one
 * unresolved record and `unconfirmed`. Nothing else.
 */
export function evaluatorAdmission(state: ObservationState, existingUnconfirmed: string | null): { ok: true; alongside: string | null } | { ok: false; reason: "unresolved" | "named-not-found" | "named-not-unconfirmed" } {
	const unresolved = unresolvedObservations(state);
	if (existingUnconfirmed === null) return unresolved.length === 0 ? { ok: true, alongside: null } : { ok: false, reason: "unresolved" };
	if (unresolved.length > 1) return { ok: false, reason: "unresolved" };
	const [only] = unresolved;
	if (only?.observationId !== existingUnconfirmed) return { ok: false, reason: only ? "unresolved" : "named-not-found" };
	if (only.status !== "unconfirmed") return { ok: false, reason: "named-not-unconfirmed" };
	return { ok: true, alongside: existingUnconfirmed };
}

/**
 * The evaluation Directory's evaluator runs: one row per grant, inserted once
 * and only moved forward from the phase it is in. Nothing deletes a row.
 */
export class LaunchEvaluatorLedger {
	constructor(readonly sql: SqlStorage) {
		sql.exec(
			"CREATE TABLE IF NOT EXISTS preview_launch_evaluator_runs (grant_digest TEXT PRIMARY KEY, owner TEXT NOT NULL, evaluation TEXT NOT NULL, deployment TEXT NOT NULL, origin TEXT NOT NULL, run_digest TEXT NOT NULL, phase TEXT NOT NULL, observation_id TEXT, alongside_id TEXT, created_at INTEGER NOT NULL, deadline INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		);
	}

	read(grant: string): EvaluatorRun | null {
		const row = this.sql.exec("SELECT * FROM preview_launch_evaluator_runs WHERE grant_digest = ?", grant).toArray()[0];
		if (!row) return null;
		return {
			grant: String(row.grant_digest),
			owner: String(row.owner),
			evaluation: String(row.evaluation),
			deployment: String(row.deployment),
			origin: String(row.origin),
			run: String(row.run_digest),
			phase: String(row.phase) as EvaluatorPhase,
			observation: row.observation_id === null ? null : String(row.observation_id),
			alongside: row.alongside_id === null ? null : String(row.alongside_id),
			createdAt: Number(row.created_at),
			deadline: Number(row.deadline),
			updatedAt: Number(row.updated_at),
		};
	}

	/** Inserts the grant's one run as `launching`; false if the grant has a run already, whatever its phase. */
	claim(row: Omit<EvaluatorRun, "phase" | "observation" | "alongside" | "updatedAt">): boolean {
		return (
			this.sql.exec(
				"INSERT OR IGNORE INTO preview_launch_evaluator_runs (grant_digest, owner, evaluation, deployment, origin, run_digest, phase, observation_id, created_at, deadline, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'launching', NULL, ?, ?, ?)",
				row.grant,
				row.owner,
				row.evaluation,
				row.deployment,
				row.origin,
				row.run,
				row.createdAt,
				row.deadline,
				row.createdAt,
			).rowsWritten > 0
		);
	}

	/** Moves the run from exactly `from` to `to`, recording the launch's `observation` and what it started beside if given; false if it wasn't in `from`. */
	move(grant: string, from: EvaluatorPhase, to: EvaluatorPhase, now: number, launched?: { observation: string | null; alongside: string | null }): boolean {
		const cursor =
			launched === undefined
				? this.sql.exec("UPDATE preview_launch_evaluator_runs SET phase = ?, updated_at = ? WHERE grant_digest = ? AND phase = ?", to, now, grant, from)
				: this.sql.exec(
						"UPDATE preview_launch_evaluator_runs SET phase = ?, observation_id = ?, alongside_id = ?, updated_at = ? WHERE grant_digest = ? AND phase = ? AND observation_id IS NULL",
						to,
						launched.observation,
						launched.alongside,
						now,
						grant,
						from,
					);
		return cursor.rowsWritten > 0;
	}
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (value: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
const directory = (env: Env) => (env.Directory as unknown as DurableObjectNamespace<EvalDirectory>).getByName("directory");
const space = async (env: Env, owner: string) => (await getAgentByName(env.Pim, owner)) as unknown as EvaluatorSpace;

function json(body: unknown, status: number): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const INVALID = "That launch evaluator credential isn't valid for this preview.";
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ event: "preview.launch-evaluator", ...fields }));

/** Whether the request carries the evaluator credential for `grant` and a body of exactly `keys` naming the grant's owner, evaluation and deployment; the body if so. */
async function presents(request: Request, grant: EvaluatorGrant, keys: string[]): Promise<Record<string, unknown> | string> {
	const header = request.headers.get("authorization") ?? "";
	const credential = header.startsWith(`${EVALUATOR_SCHEME} `) ? header.slice(EVALUATOR_SCHEME.length + 1) : "";
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!SECRET.test(credential)) return "credential";
	if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join() !== keys.join()) return "body";
	const given = new TextEncoder().encode(await sha256(credential));
	if (!crypto.subtle.timingSafeEqual(given, new TextEncoder().encode(grant.credentialSha256))) return "credential";
	if (body.owner !== grant.owner) return "owner";
	if (body.evaluation !== grant.evaluation) return "evaluation";
	if (body.deployment !== grant.deployment) return "deployment";
	return body;
}

/** The one launch: claims the grant's run, asks the space once for a fresh observation, and records what it answered. */
async function launch(request: Request, env: Env, grant: EvaluatorGrant, now: number): Promise<Response> {
	const body = await presents(request, grant, LAUNCH_KEYS);
	if (typeof body === "string") {
		log({ action: "launch", outcome: "refused", reason: body });
		return fail(401, INVALID);
	}
	const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const deadline = Math.min(now + MAX_RUN_MS, grant.notAfter);
	const row = { grant: grant.credentialSha256, owner: grant.owner, evaluation: grant.evaluation, deployment: grant.deployment, origin: grant.origin, run: await sha256(token), createdAt: now, deadline };
	const claimed = await directory(env).evaluatorClaim(row);
	if (!claimed.ok) {
		log({ action: "launch", outcome: "refused", reason: claimed.reason });
		return claimed.reason === "spent" ? fail(409, "This launch evaluator grant has run already; it runs once.", { run: { phase: claimed.phase } }) : fail(401, INVALID);
	}
	let answer: SpaceLaunch;
	try {
		answer = await (await space(env, grant.owner)).launchForEvaluator();
	} catch {
		answer = { outcome: "uncertain", observation: null };
	}
	const at = Date.now();
	if (answer.outcome === "open" && OBSERVATION_ID.test(answer.observation.id)) {
		const recorded = await directory(env).evaluatorLaunched(row.grant, "open", answer.observation.id, answer.alongside, at);
		if (recorded) {
			log({ action: "launch", outcome: "open", owner: grant.owner, observation: answer.observation.id, alongside: answer.alongside, deadline });
			return json(
				{
					run: {
						phase: "open",
						deadline: new Date(deadline).toISOString(),
						observation: { id: answer.observation.id, status: "open", notAfter: answer.observation.notAfter },
						alongside: answer.alongside,
					},
					viewer: answer.viewer,
					runToken: token,
				},
				201,
			);
		}
		// The row moved under the launch (it can't, but if it did): the observation exists, and nothing may end it from here.
		log({ action: "launch", outcome: "uncertain", reason: "row", owner: grant.owner });
		return fail(502, "The launch's result couldn't be recorded; it is uncertain. Nothing is retried and nothing will end it from here.", { run: { phase: "launch_uncertain" } });
	}
	if (answer.outcome === "refused") {
		await directory(env).evaluatorLaunched(row.grant, "launch_refused", null, null, at);
		log({ action: "launch", outcome: "launch_refused", reason: answer.reason, owner: grant.owner });
		return fail(409, "The space started no observation.", { run: { phase: "launch_refused", reason: answer.reason } });
	}
	const observation = answer.outcome === "uncertain" ? answer.observation : null;
	await directory(env).evaluatorLaunched(row.grant, "launch_uncertain", observation !== null && OBSERVATION_ID.test(observation) ? observation : null, null, at);
	log({ action: "launch", outcome: "launch_uncertain", owner: grant.owner });
	return fail(502, "Whether an observation started is uncertain. Nothing is retried, and nothing may end it from here.", { run: { phase: "launch_uncertain" } });
}

/** The one End: only of the run's recorded observation, with its run token, while the run is open and before its deadline. */
async function end(request: Request, env: Env, grant: EvaluatorGrant, now: number): Promise<Response> {
	const token = request.headers.get(RUN_HEADER) ?? "";
	const body = await presents(request, grant, END_KEYS);
	if (typeof body === "string" || !SECRET.test(token) || typeof body.observation !== "string" || !OBSERVATION_ID.test(body.observation)) {
		log({ action: "end", outcome: "refused", reason: typeof body === "string" ? body : "run" });
		return fail(401, INVALID);
	}
	const ending = await directory(env).evaluatorEnding(grant.credentialSha256, await sha256(token), body.observation, now);
	if (!ending.ok) {
		log({ action: "end", outcome: "refused", reason: ending.reason, phase: ending.phase });
		if (ending.reason === "run" || ending.reason === "none") return fail(401, INVALID);
		return fail(409, "This run can't end that observation now.", { run: { phase: ending.phase } });
	}
	let answer: SpaceEnd;
	try {
		answer = await (await space(env, grant.owner)).endForEvaluator(ending.observation);
	} catch {
		answer = { outcome: "uncertain", status: null };
	}
	const phase: EvaluatorPhase = answer.outcome === "requested" || answer.outcome === "final" ? "ended" : answer.outcome === "refused" ? "end_refused" : "end_uncertain";
	await directory(env).evaluatorEnded(grant.credentialSha256, phase, Date.now());
	log({ action: "end", outcome: phase, owner: grant.owner, observation: ending.observation });
	const run = { phase, observation: { id: ending.observation, status: answer.status } };
	if (phase === "ended") return json({ run }, answer.outcome === "requested" ? 202 : 200);
	return fail(502, phase === "end_refused" ? "The space didn't ask for the end. Nothing is retried." : "Whether the end was asked for is uncertain. Nothing is retried.", { run });
}

/** The mount the evaluation passes to `serve` (src/gateway.ts): its two routes, or `undefined` for every other path, and for these while it is off. */
export async function previewLaunchEvaluator(request: Request, env: Env): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== LAUNCH_EVALUATOR_PREFIX && !url.pathname.startsWith(`${LAUNCH_EVALUATOR_PREFIX}/`)) return undefined;
	const now = Date.now();
	// Off, it isn't here: `/auth` answers these as a deployment does.
	const grant = launchEvaluatorGrant(env, now);
	if ("off" in grant) {
		log({ action: "route", outcome: "off", reason: grant.off });
		return undefined;
	}
	if (url.pathname !== LAUNCH_PATH && url.pathname !== END_PATH) return fail(404, "Not found");
	if (request.method !== "POST") return fail(405, `${url.pathname} takes POST`);
	if (url.search !== "" || request.headers.has("upgrade")) return fail(404, "Not found");
	if (url.origin !== grant.origin || request.headers.get("origin") !== grant.origin) return fail(403, "Requests must come from this app");
	return url.pathname === LAUNCH_PATH ? launch(request, env, grant, now) : end(request, env, grant, now);
}
