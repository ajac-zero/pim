/**
 * Signing in with another account: Google, GitHub, or any OpenID Connect
 * provider (Microsoft, GitLab, Authentik, Keycloak...). None is required:
 * each is on once the deployment's environment gives it the client ID and secret
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

import { createHash, randomBytes } from "node:crypto";

const base64UrlEncode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const base64UrlDecode = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64url"));

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

/**
 * Who signed in, as a provider says. `label` is shown in Settings: an email
 * or a username. `name` is what the provider says the person is called, if
 * it says: their given name when it knows it.
 */
export type Identity = { readonly issuer: string; readonly subject: string; readonly label: string; readonly name: string | null };

/** A provider's name for the person, if it is one line of a sensible length. */
function personName(...candidates: unknown[]): string | null {
	const name = candidates.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
	return name && name.length <= 80 && !/[\r\n]/.test(name) ? name : null;
}

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
 * and optionally `PIM_OIDC_NAME`. A provider
 * with only some of them set stays off, and `problems` says what's missing.
 */
export function configuredProviders(vars: Readonly<Record<string, string | undefined>>) {
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
export const randomValue = () => base64UrlEncode(randomBytes(32));

export async function pkceChallenge(verifier: string): Promise<string> {
	return base64UrlEncode(createHash("sha256").update(verifier).digest());
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
		headers.authorization = `Basic ${Buffer.from(`${encode(settings.clientId)}:${encode(settings.clientSecret)}`).toString("base64")}`;
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
	return { issuer, subject: claims.sub as string, label: (label as string | undefined) ?? (claims.sub as string), name: personName(claims.given_name, claims.name) };
}

async function githubIdentity(accessToken: string): Promise<Identity> {
	const response = await fetch("https://api.github.com/user", {
		headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "pim" },
	});
	const user = (await response.json().catch(() => null)) as { id?: unknown; login?: unknown; name?: unknown } | null;
	if (!response.ok || typeof user?.id !== "number") throw new Error("GitHub didn't say who signed in.");
	return { issuer: GITHUB_ISSUER, subject: String(user.id), label: typeof user.login === "string" ? user.login : String(user.id), name: personName(user.name) };
}

// ---- the flow: start at the provider, finish when it sends the browser back ----

import type { Db } from "./db.ts";
import { NotFoundError, UnauthorizedError } from "./errors.ts";
import type { Principal } from "@pim/v2-contracts/identity";
import { digest } from "./ids.ts";
import type { Identity as IdentityService } from "./identity.ts";
import { type Site, type SignIn, splitOwnedCode } from "./signin.ts";

export const OAUTH_MS = 10 * 60_000;

export type OAuthFlow = {
	provider: ProviderId;
	state: string;
	nonce: string;
	verifier: string;
	redirectUri: string;
	/** Linking to a signed-in person's account: the session must still be theirs on return. */
	link?: { owner: string; sessionId: string };
	/** Adding the first credential with a setup code. */
	setup?: { owner: string; code: string };
	returnTo?: string;
};

export type OAuthResult = { redirect: string; session?: string };

/** Google, GitHub and OpenID Connect sign-in and account linking, over `SignIn`'s identity table (unique on (issuer, subject) across the instance). */
export class ExternalSignIn {
	constructor(
		private readonly db: Db,
		private readonly signin: SignIn,
		private readonly identity: IdentityService,
		private readonly providers: Partial<Record<ProviderId, ProviderSettings>>,
	) {}

	buttons() {
		return Object.entries(this.providers).map(([id, settings]) => ({ id, name: providerName(id as ProviderId, settings) }));
	}

	async start(providerId: string, site: Site, session: Principal | null, body: { setup?: unknown; returnTo?: unknown }, now = new Date()): Promise<{ url: string; flow: string }> {
		const settings = isProviderId(providerId) ? this.providers[providerId] : undefined;
		if (!isProviderId(providerId) || !settings) throw new NotFoundError("That sign-in method isn't set up on this Pim.");
		const flow: OAuthFlow = {
			provider: providerId,
			state: randomValue(),
			nonce: randomValue(),
			verifier: randomValue(),
			redirectUri: `${site.origin}/auth/oauth/${providerId}/callback`,
			// A path here, never another site.
			...(typeof body.returnTo === "string" && /^\/(?![/\\])/.test(body.returnTo) && body.returnTo.length <= 2000 ? { returnTo: body.returnTo } : {}),
		};
		const setup = splitOwnedCode(body.setup);
		if (session) flow.link = { owner: session.ownerId, sessionId: session.kind === "user" ? session.sessionId : "" };
		else if (setup) {
			const account = await this.identity.authz.account(setup.owner);
			const live = account && account.status !== "suspended" && (await this.db.owner(setup.owner, async (tx) => !!(await tx.query("SELECT 1 FROM pim_app.setup_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2", [digest(setup.code), now])).rowCount));
			if (!live) throw new UnauthorizedError("This setup link has expired or was already used.");
			flow.setup = setup;
		}
		const url = await authorizationUrl(providerId, settings, flow);
		return { url, flow: await this.signin.startFlow("oauth", flow, OAUTH_MS, now) };
	}

	/** Where a provider sends the browser back: signs it in, adds the first credential with a setup code, or links the identity. `error` rides back to the app. */
	async finish(flowId: string | undefined, providerId: string, query: URLSearchParams, now = new Date()): Promise<OAuthResult & { error?: string }> {
		const flow = await this.signin.flow<OAuthFlow>(flowId, "oauth", { consume: true, now });
		const back = (to: string, error?: string, session?: string): OAuthResult & { error?: string } => ({ redirect: error ? `${to}#auth-error=${encodeURIComponent(error)}` : to, ...(session ? { session } : {}), ...(error ? { error } : {}) });
		if (!flow || flow.provider !== providerId || flow.state !== query.get("state")) return back("/", "Signing in took too long, or started in another browser. Try again.");
		const to = flow.link ? "/?dialog=settings&tab=account" : (flow.returnTo ?? "/");
		const settings = this.providers[flow.provider];
		const name = providerName(flow.provider, settings);
		if (!settings) return back(to, `Signing in with ${name} isn't set up on this Pim anymore.`);
		const refused = query.get("error");
		if (refused) return back(to, refused === "access_denied" ? undefined : `${name} didn't sign you in: ${query.get("error_description") ?? refused}.`);
		let identity: Identity;
		try {
			identity = await exchangeCode(flow.provider, settings, { redirectUri: flow.redirectUri, code: query.get("code") ?? "", verifier: flow.verifier, nonce: flow.nonce }, now.getTime());
		} catch (error) {
			return back(to, error instanceof Error ? error.message : String(error));
		}
		const taken = `That ${name} account already signs in to someone else on this Pim.`;

		if (flow.link) {
			const account = await this.identity.authz.account(flow.link.owner);
			if (account?.status !== "active") return back("/", "Sign in again to link an account.");
			if (flow.link.sessionId && !(await this.#sessionLive(flow.link.owner, flow.link.sessionId))) return back("/", "Sign in again to link an account.");
			if (!(await this.signin.linkIdentity(flow.link.owner, flow.provider, identity, now))) return back(to, taken);
			return back(to);
		}
		if (flow.setup) {
			const account = await this.identity.authz.account(flow.setup.owner);
			if (!account || account.status === "suspended") return back(to, "This account can't sign in.");
			const owner = account.ownerId;
			const spent = await this.db.owner(owner, async (tx) => (await tx.query("UPDATE pim_app.setup_codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2", [digest(flow.setup!.code), now])).rowCount);
			if (!spent) return back(to, "This setup link has expired or was already used.");
			const linked = await this.signin.linkIdentity(owner, flow.provider, identity, now);
			if (!linked) return back(to, taken);
			if (account.status === "pending") await this.db.owner(owner, (tx) => tx.query("UPDATE pim_app.accounts SET status = 'active', activated_at = $2 WHERE owner_id = $1", [owner, now]));
			await this.signin.voidRegistrationLinks(owner, now);
			return back(to, undefined, await this.identity.createSession(owner, { credentialId: linked.id, now }));
		}
		const owner = await this.signin.identityOwner(identity);
		const account = owner ? await this.identity.authz.account(owner) : null;
		if (!account || !owner || account.status === "pending") return back(to, `Nobody on this Pim signs in with that ${name} account. Sign in another way and link it in Settings, or join first.`);
		if (account.status === "suspended") return back(to, "Your account is suspended. Ask the person who runs this Pim.");
		if (account.status !== "active") return back(to, "Nobody on this Pim signs in with that account.");
		const key = `${identity.issuer}\n${identity.subject}`;
		const linkedId = await this.db.lookup(key, async (tx) => (await tx.query("SELECT id FROM pim_app.oidc_identities WHERE identity_key = $1", [key])).rows[0]?.id as string);
		await this.signin.touchIdentity(owner, linkedId, identity.label, identity.name, now);
		return back(to, undefined, await this.identity.createSession(owner, { credentialId: linkedId, now }));
	}

	async #sessionLive(owner: string, sessionId: string): Promise<boolean> {
		return this.db.owner(owner, async (tx) => !!(await tx.query("SELECT 1 FROM pim_app.browser_sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()", [sessionId])).rowCount);
	}
}
