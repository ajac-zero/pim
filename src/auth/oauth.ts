/**
 * Signing in with another account: Google, GitHub, or any OpenID Connect
 * provider (Microsoft, GitLab, Authentik, Keycloak...). None is required:
 * each is on once the deployment's secrets give it the client ID and secret
 * of an app made at the provider (`configuredProviders`).
 *
 * Google and custom providers are OpenID Connect: their endpoints come from
 * the issuer's discovery document, and who signed in from the ID token.
 * The token comes straight from the provider's token endpoint over TLS, in
 * exchange for a code and the PKCE verifier only this flow knows, so its
 * signature isn't checked (OpenID Connect Core 3.1.3.7, step 6); its
 * issuer, audience, nonce and expiry are. GitHub is plain OAuth: who signed
 * in is its API's `/user`.
 *
 * An identity is its provider's issuer and subject (`sub`, GitHub's user
 * ID), never an email address, which an account at a provider can change or
 * claim without owning.
 */

import { base64UrlDecode, base64UrlEncode } from "./encoding";

export const PROVIDER_IDS = ["google", "github", "oidc"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const isProviderId = (value: string): value is ProviderId => (PROVIDER_IDS as readonly string[]).includes(value);

/** What the deployment gives for one provider. `issuer` and `name` are for the custom one. */
export type ProviderSettings = {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly issuer?: string;
	readonly name?: string;
};

/** Who signed in, as a provider says. `label` is shown in Settings: an email or a username. */
export type Identity = { readonly issuer: string; readonly subject: string; readonly label: string };

const GOOGLE_ISSUER = "https://accounts.google.com";
const GITHUB_ISSUER = "https://github.com";

/** The issuer whose subjects a provider's identities are: a custom provider's own, which changing makes different people. */
export function issuerOf(provider: ProviderId, settings: ProviderSettings): string {
	return provider === "google" ? GOOGLE_ISSUER : provider === "github" ? GITHUB_ISSUER : settings.issuer!;
}

/** The button's name: "Google", "GitHub", or the custom provider's. */
export function providerName(provider: ProviderId, settings?: ProviderSettings): string {
	return provider === "google" ? "Google" : provider === "github" ? "GitHub" : settings?.name?.trim() || "Single sign-on";
}

/** The secrets that turn a provider on; the custom one also takes `PIM_OIDC_NAME`, its button's name. */
export function providerSecrets(id: ProviderId): string[] {
	const fields = id === "oidc" ? ["ISSUER", "CLIENT_ID", "CLIENT_SECRET"] : ["CLIENT_ID", "CLIENT_SECRET"];
	return fields.map((field) => `PIM_${id.toUpperCase()}_${field}`);
}

/**
 * The providers the deployment turns on, with its secrets: `PIM_GOOGLE_CLIENT_ID`
 * and `PIM_GOOGLE_CLIENT_SECRET`, the same for `GITHUB`, and for single
 * sign-on `PIM_OIDC_ISSUER`, `PIM_OIDC_CLIENT_ID`, `PIM_OIDC_CLIENT_SECRET`
 * and optionally `PIM_OIDC_NAME`. Secrets, not variables, because a deploy
 * replaces variables set in the dashboard, but keeps its secrets. A provider
 * with only some of them set stays off, and `problems` says what's missing.
 */
export function configuredProviders(env: Env) {
	const vars = env as unknown as Partial<Record<string, string>>;
	const providers: Partial<Record<ProviderId, ProviderSettings>> = {};
	const problems: Partial<Record<ProviderId, string>> = {};
	for (const id of PROVIDER_IDS) {
		const value = (field: string) => vars[`PIM_${id.toUpperCase()}_${field}`]?.trim() ?? "";
		const missing = providerSecrets(id).filter((name) => (vars[name]?.trim() ?? "") === "");
		if (missing.length === providerSecrets(id).length) continue;
		if (missing.length > 0) {
			problems[id] = `Set ${missing.join(" and ")} too.`;
			continue;
		}
		providers[id] = {
			clientId: value("CLIENT_ID"),
			clientSecret: value("CLIENT_SECRET"),
			...(id === "oidc" ? { issuer: value("ISSUER").replace(/\/$/, ""), name: value("NAME") } : {}),
		};
	}
	return { providers, problems };
}

type Endpoints = { authorize: string; token: string; basicAuth: boolean };

const GITHUB: Endpoints = {
	authorize: "https://github.com/login/oauth/authorize",
	token: "https://github.com/login/oauth/access_token",
	basicAuth: false,
};

/** Discovery documents, by issuer, for an hour. */
const discovered = new Map<string, { endpoints: Promise<Endpoints>; at: number }>();
const DISCOVERY_MS = 60 * 60 * 1000;

/** An issuer's endpoints, from its discovery document, which must name the same issuer. */
export function discover(issuer: string, now = Date.now()): Promise<Endpoints> {
	const cached = discovered.get(issuer);
	if (cached && now - cached.at < DISCOVERY_MS) return cached.endpoints;
	const endpoints = (async () => {
		const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
		if (!response.ok) throw new Error(`${issuer} has no OpenID Connect discovery document (it answered ${response.status}).`);
		const document = (await response.json().catch(() => null)) as Record<string, unknown> | null;
		const { issuer: named, authorization_endpoint: authorize, token_endpoint: token } = document ?? {};
		if (named !== issuer) throw new Error(`${issuer}'s discovery document names another issuer: ${String(named)}.`);
		if (typeof authorize !== "string" || typeof token !== "string") throw new Error(`${issuer}'s discovery document has no authorization or token endpoint.`);
		const methods = document!.token_endpoint_auth_methods_supported;
		// client_secret_basic is the default; use the body only for a provider that takes nothing else.
		const basicAuth = !Array.isArray(methods) || methods.includes("client_secret_basic") || !methods.includes("client_secret_post");
		return { authorize, token, basicAuth };
	})();
	discovered.set(issuer, { endpoints, at: now });
	endpoints.catch(() => discovered.delete(issuer));
	return endpoints;
}

const endpointsOf = (provider: ProviderId, settings: ProviderSettings) => (provider === "github" ? Promise.resolve(GITHUB) : discover(issuerOf(provider, settings)));

/** A random value for `state`, `nonce` and the PKCE verifier. */
export const randomValue = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

async function pkceChallenge(verifier: string): Promise<string> {
	return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** The provider's sign-in page to send the browser to. */
export async function authorizationUrl(
	provider: ProviderId,
	settings: ProviderSettings,
	flow: { redirectUri: string; state: string; nonce: string; verifier: string },
): Promise<string> {
	const { authorize } = await endpointsOf(provider, settings);
	const url = new URL(authorize);
	const params: Record<string, string> = {
		response_type: "code",
		client_id: settings.clientId,
		redirect_uri: flow.redirectUri,
		state: flow.state,
		code_challenge: await pkceChallenge(flow.verifier),
		code_challenge_method: "S256",
		// GitHub's public profile needs no scope.
		...(provider === "github" ? { allow_signup: "false" } : { scope: "openid email profile", nonce: flow.nonce }),
		// Let someone signed in to several Google accounts pick one.
		...(provider === "google" ? { prompt: "select_account" } : {}),
	};
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url.toString();
}

/** Trades the code the provider sent back for who signed in. Throws, with a message for the person, when it can't. */
export async function exchangeCode(
	provider: ProviderId,
	settings: ProviderSettings,
	flow: { redirectUri: string; code: string; verifier: string; nonce: string },
	now = Date.now(),
): Promise<Identity> {
	const name = providerName(provider, settings);
	const endpoints = await endpointsOf(provider, settings);
	const body = new URLSearchParams({ grant_type: "authorization_code", code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier });
	const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
	if (endpoints.basicAuth) {
		const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
		headers.authorization = `Basic ${btoa(`${encode(settings.clientId)}:${encode(settings.clientSecret)}`)}`;
	} else {
		body.set("client_id", settings.clientId);
		body.set("client_secret", settings.clientSecret);
	}
	const response = await fetch(endpoints.token, { method: "POST", headers, body });
	const tokens = (await response.json().catch(() => null)) as Record<string, unknown> | null;
	if (!response.ok || !tokens || typeof tokens.error === "string") {
		const reason = typeof tokens?.error_description === "string" ? tokens.error_description : typeof tokens?.error === "string" ? tokens.error : `it answered ${response.status}`;
		throw new Error(`${name} didn't confirm the sign-in: ${reason}.`);
	}
	if (provider === "github") return githubIdentity(String(tokens.access_token ?? ""));
	return idTokenIdentity(issuerOf(provider, settings), settings.clientId, tokens.id_token, flow.nonce, name, now);
}

function idTokenIdentity(issuer: string, clientId: string, token: unknown, nonce: string, name: string, now: number): Identity {
	let claims: Record<string, unknown>;
	try {
		const [, payload] = String(token).split(".");
		claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload!)));
	} catch {
		throw new Error(`${name} didn't say who signed in.`);
	}
	const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	const valid =
		claims.iss === issuer &&
		audience.includes(clientId) &&
		claims.nonce === nonce &&
		typeof claims.exp === "number" &&
		claims.exp * 1000 > now - 60_000 &&
		typeof claims.sub === "string" &&
		claims.sub !== "";
	if (!valid) throw new Error(`${name}'s answer wasn't for this sign-in. Try again.`);
	const label = [claims.email, claims.preferred_username, claims.name].find((value) => typeof value === "string" && value !== "");
	return { issuer, subject: claims.sub as string, label: (label as string | undefined) ?? (claims.sub as string) };
}

async function githubIdentity(accessToken: string): Promise<Identity> {
	const response = await fetch("https://api.github.com/user", {
		headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "pim" },
	});
	const user = (await response.json().catch(() => null)) as { id?: unknown; login?: unknown } | null;
	if (!response.ok || typeof user?.id !== "number") throw new Error("GitHub didn't say who signed in.");
	return { issuer: GITHUB_ISSUER, subject: String(user.id), label: typeof user.login === "string" ? user.login : String(user.id) };
}
