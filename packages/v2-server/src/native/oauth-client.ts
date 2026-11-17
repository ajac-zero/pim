/**
 * Pim as an OAuth 2.1 client of other services: the authorization-code flow with PKCE (S256) for the native connectors (a client the admin registered, in the environment) and for
 * remote MCP servers (the MCP authorization spec: the server's protected-resource metadata, the authorization server's metadata, dynamic client registration or a client the admin
 * registered). What comes back is a credential bundle, kept sealed in `pim_app.connectors.credential` and renewed by whoever uses it (`refresh` in `connector-tools.ts`):
 *
 *     { access_token, refresh_token?, expires_at?, token_endpoint, client_id, client_secret?, scope?, files? }
 *
 * (`expires_at` in milliseconds; `files` is Google Drive's picked files). A bundle in this shape is all a migrated v1 connection needs to become a working connector here.
 */
import { createHash, randomBytes } from "node:crypto";
import { readJsonObject, serviceText } from "./http.ts";

export type Fetcher = typeof fetch;
/** How a remote server is reached: with what `fetch`, and whether a private address may be. `check` refuses a private address unless it is allowed. */
export type Guard = { fetch: Fetcher; allowPrivate: boolean; check: (url: string) => Promise<URL> };

export type Bundle = { access_token: string; refresh_token?: string; expires_at?: number; token_endpoint?: string; client_id?: string; client_secret?: string; scope?: string; [more: string]: unknown };

export const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
export const newVerifier = () => base64url(randomBytes(32));
export const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

const TOKEN_BYTES = 64 * 1024;
const TIMEOUT_MS = 15_000;

/** The bundle a token endpoint's answer makes; a refresh keeps the old refresh token when the service leaves it out. */
export function bundleOf(answer: Record<string, unknown>, keep: Partial<Bundle>, now: number): Bundle {
	const expires = typeof answer.expires_in === "number" ? answer.expires_in : Number(answer.expires_in);
	return {
		...keep,
		access_token: String(answer.access_token),
		...(typeof answer.refresh_token === "string" ? { refresh_token: answer.refresh_token } : {}),
		...(Number.isFinite(expires) && expires > 0 ? { expires_at: now + expires * 1000 } : {}),
		...(typeof answer.scope === "string" ? { scope: answer.scope } : {}),
	};
}

/** A grant the service says is gone: only signing in again helps. */
export class GrantGone extends Error {}

/** Posts a token request and reads its answer: the answer, or a throw with the service's reason. */
export async function tokenRequest(fetcher: Fetcher, endpoint: string, params: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await fetcher(endpoint, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(TIMEOUT_MS) });
	const answer = await readJsonObject(response, TOKEN_BYTES);
	if (!response.ok || typeof answer.access_token !== "string") {
		const told = typeof answer.error_description === "string" ? answer.error_description : typeof answer.error === "string" ? answer.error : "";
		const reason = serviceText(told) || `The token endpoint answered ${response.status}`;
		throw answer.error === "invalid_grant" ? new GrantGone(reason) : new Error(reason);
	}
	return answer;
}

/** The address the person is sent to in order to sign in. */
export function authorizeUrl(endpoint: string, p: { clientId: string; redirectUri: string; scope?: string; state: string; verifier: string; resource?: string; extra?: Readonly<Record<string, string>> }): string {
	const url = new URL(endpoint);
	for (const [k, v] of Object.entries({ ...p.extra, response_type: "code", client_id: p.clientId, redirect_uri: p.redirectUri, ...(p.scope ? { scope: p.scope } : {}), state: p.state, code_challenge: challengeOf(p.verifier), code_challenge_method: "S256", ...(p.resource ? { resource: p.resource } : {}) })) url.searchParams.set(k, v);
	return url.toString();
}

// ---- remote MCP servers ----

const PROTOCOL = "2025-06-18";

/** What reaching a server without a credential showed: it is open, or it wants a sign-in (and where its metadata is, and what scope it asks for). */
export type Probe = { open: true } | { open: false; resourceMetadata: string | null; scope: string | null };

/** `Bearer resource_metadata="…", scope="…"`: what a server's 401 says about where to find its metadata. */
export function challengeParams(header: string | null): { resourceMetadata: string | null; scope: string | null } {
	const get = (name: string) => new RegExp(`${name}="([^"]*)"`, "i").exec(header ?? "")?.[1] ?? null;
	return { resourceMetadata: get("resource_metadata"), scope: get("scope") };
}

/** Asks the server to initialize without a credential. */
export async function probe(guard: Guard, serverUrl: string): Promise<Probe> {
	const target = guard.allowPrivate ? new URL(serverUrl) : await guard.check(serverUrl);
	const response = await guard.fetch(target, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "Pim", version: "2.0.0" } } }) });
	await response.body?.cancel().catch(() => undefined);
	if (response.ok) return { open: true };
	if (response.status === 401 || response.status === 403) return { open: false, ...challengeParams(response.headers.get("www-authenticate")) };
	throw new Error(`The server answered ${response.status}`);
}

export type AuthServer = { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; scopes_supported?: string[] };

async function getJson(guard: Guard, url: string): Promise<Record<string, unknown> | null> {
	try {
		const target = guard.allowPrivate ? new URL(url) : await guard.check(url);
		const response = await guard.fetch(target, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			return null;
		}
		return await readJsonObject(response, TOKEN_BYTES);
	} catch {
		return null;
	}
}

/** The authorization server a resource names, from its protected-resource metadata (RFC 9728) and the server's own metadata (RFC 8414, or OpenID's). */
export async function discover(guard: Guard, serverUrl: string, found: Probe & { open: false }): Promise<AuthServer & { resource: string }> {
	const server = new URL(serverUrl);
	const path = server.pathname.replace(/\/+$/, "");
	const resourceMeta = (found.resourceMetadata ? await getJson(guard, found.resourceMetadata) : null) ?? (await getJson(guard, `${server.origin}/.well-known/oauth-protected-resource${path}`)) ?? (await getJson(guard, `${server.origin}/.well-known/oauth-protected-resource`));
	const issuer = new URL(Array.isArray(resourceMeta?.authorization_servers) && typeof resourceMeta.authorization_servers[0] === "string" ? resourceMeta.authorization_servers[0] : server.origin);
	const issuerPath = issuer.pathname.replace(/\/+$/, "");
	const meta =
		(await getJson(guard, `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`)) ??
		(await getJson(guard, `${issuer.origin}/.well-known/openid-configuration${issuerPath}`)) ??
		(await getJson(guard, `${issuer.origin}${issuerPath}/.well-known/openid-configuration`));
	if (!meta || typeof meta.authorization_endpoint !== "string" || typeof meta.token_endpoint !== "string") throw new Error("The server asks for a sign-in but says nowhere to sign in.");
	const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : null;
	if (methods && !methods.includes("S256")) throw new Error("The server's sign-in does not support PKCE (S256).");
	return {
		authorization_endpoint: meta.authorization_endpoint,
		token_endpoint: meta.token_endpoint,
		...(typeof meta.registration_endpoint === "string" ? { registration_endpoint: meta.registration_endpoint } : {}),
		...(Array.isArray(resourceMeta?.scopes_supported) ? { scopes_supported: resourceMeta.scopes_supported.filter((s): s is string => typeof s === "string") } : {}),
		resource: typeof resourceMeta?.resource === "string" ? resourceMeta.resource : serverUrl,
	};
}

/** RFC 7591 dynamic registration of Pim as a public client at the server's authorization server. */
export async function registerClient(guard: Guard, endpoint: string, redirectUri: string): Promise<{ client_id: string; client_secret?: string }> {
	const target = guard.allowPrivate ? new URL(endpoint) : await guard.check(endpoint);
	const response = await guard.fetch(target, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ client_name: "Pim", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
	const answer = await readJsonObject(response, TOKEN_BYTES);
	if (!response.ok || typeof answer.client_id !== "string") throw new Error(`The server did not let Pim register as a client (${response.status}${typeof answer.error === "string" ? `: ${serviceText(answer.error)}` : ""}).`);
	return { client_id: answer.client_id, ...(typeof answer.client_secret === "string" ? { client_secret: answer.client_secret } : {}) };
}
