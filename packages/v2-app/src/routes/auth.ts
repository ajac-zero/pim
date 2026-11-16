import { BadRequestError } from "../errors.ts";
import { bearerOf, challengeCookieName, clearCookie, fromAnotherSite, ok, oauthCookieName, type Reply, route, type Route, sessionCookieName, setCookie } from "../http.ts";
import { ForbiddenError } from "@pim/v2-contracts/authz";

const SESSION_SECONDS = 30 * 24 * 3600;
const CHALLENGE_SECONDS = 5 * 60;
const OAUTH_SECONDS = 10 * 60;

const str = (body: Record<string, any>, ...fields: string[]) => {
	for (const f of fields) if (typeof body[f] !== "string") throw new BadRequestError(`${f} is required`);
};

/**
 * `/auth/*`, `/oauth/*`, `/.well-known/*` and `/mcp`: sign-in with passkeys and linked accounts, enrollment, device links, recovery codes,
 * server-side sessions, and Pim as an OAuth 2.1 authorization server for its MCP endpoint. A write that carries the browser's cookie must come
 * from this site.
 */
export const authRoutes: Route[] = [
	// ---- joining ----
	route("GET", "/auth/username", async ({ app, url }) => ok(await app.signin.usernameAvailable((url.searchParams.get("name") ?? "").trim().toLowerCase()))),
	route("POST", "/auth/register", async ({ app, json, req, secure }) => {
		if (fromAnotherSite(req)) throw new ForbiddenError("register", "csrf");
		const b = await json();
		const account = await app.identity.register({ username: String(b.username ?? ""), invite: b.invite, bootstrap: b.bootstrap ?? b.claim, address: req.socket.remoteAddress });
		const session = await app.identity.createSession(account.ownerId, { userAgent: req.headers["user-agent"] });
		return ok({ account }, 201, { "set-cookie": setCookie(sessionCookieName(secure), session, SESSION_SECONDS, secure) });
	}),
	// Anyone may ask; only the operator reads the log the code lands in. The answer never holds the code.
	route("POST", "/auth/setup-link", async ({ app, origin, req }) => {
		if (fromAnotherSite(req)) throw new ForbiddenError("setup-link", "csrf");
		const admin = await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id, username FROM pim_app.accounts WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1")).rows[0]);
		if (!admin) {
			const code = await app.identity.issueClaim("bootstrap", null, 15 * 60_000);
			console.log(`Pim setup link. Open it to set this Pim up and become its admin; it works once, for 15 minutes: ${origin}/#claim=${code}`);
			return ok({ expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
		}
		const { code, expiresAt } = await app.signin.issueSetupCode(admin.owner_id);
		console.log(`Pim setup link for ${admin.username}, the admin. Open it to add a passkey; it works once, until ${expiresAt.toISOString()}: ${origin}/#setup=${code}`);
		return ok({ expiresAt: expiresAt.toISOString() });
	}),
	route("POST", "/auth/recover", async ({ app, json, secure }) => {
		const { session, account } = await app.identity.recoverAdmin(String((await json()).claim ?? ""));
		return ok({ account }, 200, { "set-cookie": setCookie(sessionCookieName(secure), session, SESSION_SECONDS, secure) });
	}),

	// ---- the session ----
	route("GET", "/auth/session", async ({ app, maybePrincipal }) => {
		const p = await maybePrincipal();
		const providers = app.external.buttons();
		if (!p || p.kind !== "user") return ok({ signedIn: false, method: null, passkey: null, credential: null, account: null, providers });
		const credential = await app.signin.sessionCredential(p.ownerId, p.sessionId);
		const identity = credential?.startsWith("idp_") ?? false;
		const name = (await app.signin.identities(p.ownerId)).find((i) => i.name !== null)?.name ?? null;
		return ok({ signedIn: true, method: identity ? "identity" : "passkey", passkey: identity ? null : credential, credential, account: await app.identity.authz.account(p.ownerId), name, providers });
	}),
	route("POST", "/auth/sign-out", async ({ app, maybePrincipal, secure }) => {
		const p = await maybePrincipal().catch(() => null);
		if (p?.kind === "user") {
			await app.signin.voidDeviceLinks(p);
			await app.identity.revokeSession(p.ownerId, p.sessionId);
		}
		return ok({ ok: true }, 200, { "set-cookie": clearCookie(sessionCookieName(secure), secure) });
	}),
	route("GET", "/auth/sessions", async ({ app, principal }) => ok({ sessions: await app.identity.listSessions((await principal()).ownerId) })),
	route("DELETE", "/auth/sessions/:id", async ({ app, principal, params }) => {
		const p = await principal();
		await app.identity.authz.enforce(p, "session:revoke");
		await app.identity.revokeSession(p.ownerId, params[0]!);
		return ok({ ok: true });
	}),

	// ---- passkey sign-in ----
	route("POST", "/auth/sign-in/options", async ({ app, origin, secure }) => {
		const { flow, options } = await app.signin.signInOptions({ rpId: new URL(origin).hostname, origin });
		return ok(options, 200, { "set-cookie": setCookie(challengeCookieName(secure), flow, CHALLENGE_SECONDS, secure) });
	}),
	route("POST", "/auth/sign-in", async ({ app, origin, secure, json, cookie, req }) => {
		const b = await json();
		str(b, "id", "clientDataJSON", "authenticatorData", "signature", "userHandle");
		const { session } = await app.signin.signIn(cookie(challengeCookieName(secure)), b as never, { rpId: new URL(origin).hostname, origin }, { userAgent: req.headers["user-agent"] });
		return ok({ ok: true }, 200, { "set-cookie": [setCookie(sessionCookieName(secure), session, SESSION_SECONDS, secure), clearCookie(challengeCookieName(secure), secure)] });
	}),

	// ---- passkey enrollment and management ----
	route("POST", "/auth/passkeys/options", async ({ app, origin, secure, json, maybePrincipal }) => {
		const { flow, options } = await app.signin.passkeyOptions(await maybePrincipal(), await json(), { rpId: new URL(origin).hostname, origin });
		return ok(options, 200, { "set-cookie": setCookie(challengeCookieName(secure), flow, CHALLENGE_SECONDS, secure) });
	}),
	route("POST", "/auth/passkeys", async ({ app, origin, secure, json, cookie, maybePrincipal, req }) => {
		const b = await json();
		str(b, "id", "clientDataJSON", "authenticatorData", "publicKey", "name");
		if (typeof b.publicKeyAlgorithm !== "number") throw new BadRequestError("publicKeyAlgorithm is required");
		const { passkey, session } = await app.signin.addPasskey(cookie(challengeCookieName(secure)), b as never, await maybePrincipal(), { rpId: new URL(origin).hostname, origin }, { userAgent: req.headers["user-agent"] });
		const cookies = [clearCookie(challengeCookieName(secure), secure)];
		if (session) cookies.push(setCookie(sessionCookieName(secure), session, SESSION_SECONDS, secure));
		return ok(passkey, 200, { "set-cookie": cookies });
	}),
	route("GET", "/auth/passkeys", async ({ app, principal }) => ok({ passkeys: await app.signin.passkeys((await principal()).ownerId) })),
	route("DELETE", "/auth/passkeys/:id", async ({ app, principal, params, secure }) => {
		const p = await principal();
		await app.identity.authz.enforce(p, "passkey:manage");
		const mine = p.kind === "user" && (await app.signin.sessionCredential(p.ownerId, p.sessionId)) === params[0];
		await app.signin.removePasskey(p.ownerId, params[0]!);
		return ok({ ok: true }, 200, mine ? { "set-cookie": clearCookie(sessionCookieName(secure), secure) } : undefined);
	}),

	// ---- device links and recovery codes ----
	route("POST", "/auth/device-links", async ({ app, principal, origin }) => {
		const link = await app.signin.newDeviceLink(await principal(), origin);
		return ok({ url: link.url, expiresAt: link.expiresAt.toISOString() }, 201);
	}),
	route("DELETE", "/auth/device-links", async ({ app, principal }) => {
		await app.signin.voidDeviceLinks(await principal());
		return ok({ ok: true });
	}),
	route("GET", "/auth/recovery-codes", async ({ app, principal }) => ok({ left: await app.signin.recoveryCodesLeft((await principal()).ownerId) })),
	route("POST", "/auth/recovery-codes", async ({ app, principal }) => {
		const p = await principal();
		await app.identity.authz.enforce(p, "passkey:manage");
		return ok({ codes: await app.signin.newRecoveryCodes(p.ownerId) });
	}),

	// ---- Google, GitHub and OpenID Connect ----
	route("GET", "/auth/oauth/:provider/callback", async ({ app, params, url, cookie, secure }) => {
		const result = await app.external.finish(cookie(oauthCookieName(secure)), params[0]!, url.searchParams);
		const cookies = [clearCookie(oauthCookieName(secure), secure)];
		if (result.session) cookies.push(setCookie(sessionCookieName(secure), result.session, SESSION_SECONDS, secure));
		return { status: 302, headers: { location: result.redirect, "set-cookie": cookies } };
	}),
	route("POST", "/auth/oauth/:provider", async ({ app, params, origin, secure, json, maybePrincipal, req }) => {
		if (fromAnotherSite(req)) throw new ForbiddenError("oauth", "csrf");
		const session = await maybePrincipal();
		const { url, flow } = await app.external.start(params[0]!, { rpId: new URL(origin).hostname, origin }, session?.kind === "user" ? session : null, await json());
		// Lax, unlike the others: the provider's redirect back is a navigation from another site, and must bring it.
		return ok({ url }, 200, { "set-cookie": setCookie(oauthCookieName(secure), flow, OAUTH_SECONDS, secure, "Lax") });
	}),
	route("GET", "/auth/identities", async ({ app, principal }) => ok({ identities: (await app.signin.identities((await principal()).ownerId)).map(({ id, provider, label, createdAt, lastUsedAt }) => ({ id, provider, label, createdAt, lastUsedAt })) })),
	route("DELETE", "/auth/identities/:id", async ({ app, principal, params, secure }) => {
		const p = await principal();
		await app.identity.authz.enforce(p, "passkey:manage");
		const mine = p.kind === "user" && (await app.signin.sessionCredential(p.ownerId, p.sessionId)) === params[0];
		await app.signin.removeIdentity(p.ownerId, params[0]!);
		return ok({ ok: true }, 200, mine ? { "set-cookie": clearCookie(sessionCookieName(secure), secure) } : undefined);
	}),

	// ---- MCP OAuth 2.1 ----
	route("GET", "/.well-known/oauth-authorization-server", async ({ app, origin }) => ok(app.mcp.authorizationServerMetadata(origin))),
	route("GET", "/.well-known/oauth-protected-resource/mcp", async ({ app, origin }) => ok(app.mcp.protectedResourceMetadata(origin))),
	route("POST", "/oauth/register", async ({ app, json }) => ok(await app.mcp.register(await json()), 201)),
	route("POST", "/oauth/token", async ({ app, form }) => ok(await app.mcp.token(await form()))),
	route("GET", "/auth/authorize", async ({ app, principal, url }) => ok(await app.mcp.describeConsent(await principal(), url.searchParams))),
	route("POST", "/auth/authorize", async ({ app, principal, json }) => {
		const b = await json();
		str(b, "handle");
		return ok(await app.mcp.answerConsent(await principal(), b.handle, b.allow === true));
	}),
	route("GET", "/auth/connections", async ({ app, principal }) => ok({ connections: await app.mcp.connections((await principal()).ownerId) })),
	route("DELETE", "/auth/connections/:id", async ({ app, principal, params }) => {
		await app.mcp.disconnect((await principal()).ownerId, params[0]!);
		return ok({ ok: true });
	}),
	route("POST", "/mcp", async ({ app, req, url, json, secure, origin }): Promise<Reply> => {
		const { bearer } = bearerOf(req, url, secure);
		if (!bearer) return { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }, body: { error: "unauthorized" } };
		const { status, body } = await app.mcp.rpc(bearer, await json());
		return { status, ...(body === undefined ? {} : { body }) };
	}),
];
