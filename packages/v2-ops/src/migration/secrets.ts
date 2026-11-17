import { createHash } from "node:crypto";
import type { Cell, Row } from "./snapshot.ts";

/** Marks a column whose value moved into `pim_ops.secret_envelopes`; the row keeps this reference, never the secret. */
export type SecretRef = { readonly $secret: string };
export const isSecretRef = (cell: unknown): cell is SecretRef => typeof cell === "object" && cell !== null && "$secret" in cell;

/** What a legacy table keeps in clear or sealed that the new system holds under envelope encryption. `json` reads the secret out of a JSON column's whole value. */
export type SecretColumn = { readonly table: string; readonly column: string; readonly purpose: string; readonly format: "plain" | "native-app-sealed" };

/** Per Durable Object class, the columns that hold secrets. */
export const SECRET_COLUMNS: Readonly<Record<string, readonly SecretColumn[]>> = {
	Gallery: [
		{ table: "providers", column: "provider", purpose: "model-provider", format: "plain" },
		{ table: "compute_providers", column: "provider", purpose: "compute-provider", format: "plain" },
	],
	Pim: [
		{ table: "pim_credentials", column: "credential", purpose: "provider-credential", format: "plain" },
		{ table: "pim_app_connections", column: "credential", purpose: "connector-credential", format: "native-app-sealed" },
		{ table: "pim_push_subscriptions", column: "auth", purpose: "push-auth", format: "plain" },
	],
	Directory: [{ table: "computer_requests", column: "token", purpose: "computer-token", format: "plain" }],
};

/** `directory_meta`, `pim_meta` and `auth_meta` keys whose values are secrets. */
export const SECRET_META_KEYS: Readonly<Record<string, readonly string[]>> = {
	Directory: ["cookie_key", "salt", "claim_code"],
	// `own_providers` is the person's custom model providers as one JSON array with each API key in it; the others are keys the Worker made for the space.
	Pim: ["hosted_key", "vapid_keys", "own_providers", "computer_token", "images_signing_key", "email_pending"],
	Auth: ["setup_code"],
};
export const META_TABLE: Readonly<Record<string, string>> = { Directory: "directory_meta", Pim: "pim_meta", Auth: "auth_meta" };

/** Durable Object KV keys (the `agents` MCP OAuth client store) that hold tokens, client secrets or PKCE verifiers. */
export const SECRET_KV = /\/(token|client_info|code_verifier|verifier)(\/|$)/;

/** A stable key for a row of a table without a known primary key. */
export const rowDigest = (row: Row) => createHash("sha256").update(canonical(row)).digest("hex").slice(0, 32);

/** JSON with sorted keys: the form two systems compare rows in. */
export function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
}

/** Primary keys of the tables whose rows go to legacy_rows; any other table is keyed by a digest of the row. */
export const KNOWN_PKS: Readonly<Record<string, readonly string[]>> = {
	invites: ["hash"],
	registrations: [],
	rate_limits: ["name", "key"],
	computer_requests: ["owner_id"],
	directory_meta: ["key"],
	auth_identities: ["id"],
	auth_device_links: ["hash"],
	auth_meta: ["key"],
	profiles: ["owner_id"],
	templates: ["id"],
	providers: ["id"],
	compute_providers: ["id"],
	apps: ["id"],
	published_artifacts: ["id"],
	pim_meta: ["key"],
	pim_credentials: ["provider"],
	pim_app_connections: ["id"],
	pim_push_subscriptions: ["endpoint"],
	pim_approvals: ["id"],
	pim_tasks: ["id"],
	pim_notes: ["id"],
	pim_artifacts: ["id"],
	pim_triggers: ["id"],
	pim_trigger_revisions: ["trigger_id", "revision"],
	pim_trigger_sources: ["trigger_id"],
	pim_trigger_occurrences: ["id"],
	pim_trigger_outbox: ["id"],
	cf_agents_jobs: ["id"],
};

/** A row's key in legacy_rows: its primary-key columns when known, else a digest of the whole row. */
export function legacyKey(table: string, row: Row, seen: Set<string>): string {
	const cols = KNOWN_PKS[table];
	let key = cols && cols.length > 0 ? cols.map((c) => String(cellText(row[c]))).join("\u001f") : rowDigest(row);
	for (let n = 1; seen.has(key); n++) key = `${key}#${n}`;
	seen.add(key);
	return key;
}

const cellText = (cell: Cell | undefined) => (cell === null || cell === undefined ? "" : typeof cell === "object" ? canonical(cell) : cell);
