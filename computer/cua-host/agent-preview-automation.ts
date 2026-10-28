/**
 * The adapter for the preview's automation sign-in, as the auth branch
 * defines it (review/preview-automation-auth-20261028 at 67e338f6, its
 * docs/preview-automation.md): `POST /auth/automation/session` with
 * `Origin: <origin>`, `Authorization: Pim-Automation <credential>` and the
 * JSON body `{owner, evaluation, deployment}`, answered `201` with
 * `{mode: "enabled", session: {…, expiresAt: <ISO>}}` and the host-only
 * `__Host-pim-automation` cookie (Secure, HttpOnly, SameSite=Strict, Path=/).
 *
 * The operator's configuration file is JSON, written by the auth branch's
 * `scripts/preview-automation-grant.mjs`:
 *
 *   { "version": 1, "origin": "https://…", "owner": "o_…",
 *     "evaluation": "…", "deployment": "cua-eval@cloudflare", "credential": "<43 base64url>" }
 *
 * Every field is checked for exactly its format, and nothing about a bad
 * file is ever said but that it is invalid. The credential is held here and
 * goes only into the exchange's Authorization header.
 */

import { AgentPreviewError, type ExchangeAdapter, exactOrigin, type ParsedConfig } from "./agent-preview.ts";

export const AUTOMATION_PATH = "/auth/automation/session";
export const AUTOMATION_COOKIE = "__Host-pim-automation";
export const AUTOMATION_SCHEME = "Pim-Automation";

const KEYS = ["credential", "deployment", "evaluation", "origin", "owner", "version"];
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const OWNER = /^o_[0-9a-z]{26}$/;
const EVALUATION = /^[a-z0-9][a-z0-9-]{2,62}$/;
const DEPLOYMENT = /^cua-eval@[a-z0-9][a-z0-9-]{0,30}$/;

const invalid = () => new AgentPreviewError("config", "The configuration file's content is not valid.");

/** Parses the configuration file's text into the origin, the adapter and the credential to scrub. */
export function parseAutomationConfig(text: string): ParsedConfig {
	let config: Record<string, unknown>;
	try {
		config = JSON.parse(text);
	} catch {
		throw invalid();
	}
	if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).sort().join() !== KEYS.join() || config.version !== 1) throw invalid();
	const { origin, owner, evaluation, deployment, credential } = config;
	if (typeof origin !== "string" || typeof owner !== "string" || typeof evaluation !== "string" || typeof deployment !== "string" || typeof credential !== "string") throw invalid();
	if (!OWNER.test(owner) || !EVALUATION.test(evaluation) || !DEPLOYMENT.test(deployment) || !CREDENTIAL.test(credential)) throw invalid();
	try {
		exactOrigin(origin);
	} catch {
		throw invalid();
	}
	return { origin, secrets: [credential], adapter: automationAdapter({ origin, owner, evaluation, deployment, credential }) };
}

/** The adapter itself. */
export function automationAdapter(config: { origin: string; owner: string; evaluation: string; deployment: string; credential: string }): ExchangeAdapter {
	return {
		path: AUTOMATION_PATH,
		cookieName: AUTOMATION_COOKIE,
		request: () => ({
			headers: { authorization: `${AUTOMATION_SCHEME} ${config.credential}`, "content-type": "application/json" },
			data: { owner: config.owner, evaluation: config.evaluation, deployment: config.deployment },
		}),
		accept(status, body) {
			if (status !== 201 || !body || typeof body !== "object") return null;
			const answer = body as { mode?: unknown; session?: Record<string, unknown> | null };
			const session = answer.session;
			// The answer must describe exactly the session asked for: read-only, for this owner, evaluation, deployment and origin.
			if (answer.mode !== "enabled" || !session || typeof session !== "object") return null;
			if (session.kind !== "automation" || session.access !== "read-only" || session.owner !== config.owner || session.evaluation !== config.evaluation || session.deployment !== config.deployment || session.origin !== config.origin) return null;
			if (typeof session.expiresAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(session.expiresAt)) return null;
			const expiresAt = Date.parse(session.expiresAt);
			return Number.isFinite(expiresAt) ? { expiresAt } : null;
		},
	};
}
