/**
 * The account surfaces the web app's settings and sign-in screens call, in the shapes the app reads: who is signed in (and whether this Pim has
 * its admin yet), passkeys and linked identities with their times as epoch milliseconds, API tokens, the device link, and the email and push
 * email setting, which this Pim does not have and answers as such (push is `notifications.ts`).
 */
import { BadRequestError, CapabilityUnavailableError } from "@pim/v2-app/errors";
import { ok, type Reply, type Route, route } from "@pim/v2-app/http";

const ms = (value: Date | string | null | undefined): number | null => (value ? new Date(value).getTime() : null);

const unavailable = (what: string, why: string): never => {
	throw new CapabilityUnavailableError(what, why);
};

export function accountRoutes(): Route[] {
	const tokenList: Route["run"] = async ({ app, principal }) => {
		const p = await principal();
		await app.identity.authz.enforce(p, "api:read");
		const rows = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, name, created_at, last_used_at FROM pim_app.api_tokens WHERE revoked_at IS NULL ORDER BY created_at")).rows);
		return ok({ tokens: rows.map((r) => ({ id: r.id as string, name: r.name as string, createdAt: ms(r.created_at), lastUsedAt: ms(r.last_used_at) })) });
	};
	// Tokens imported from v1 are listed and revoked like any other. The app's tokens are for other clients of the person's own space, so they carry everything a token may do.
	const tokenCreate: Route["run"] = async ({ app, principal, json }): Promise<Reply> => {
		const p = await principal();
		const name = String((await json()).name ?? "").trim().slice(0, 64);
		if (!name) throw new BadRequestError("Give the token a name, such as the app that will use it.");
		const created = await app.identity.createToken(p, { name, scopes: ["*"] });
		return ok({ id: created.id, name, createdAt: Date.now(), lastUsedAt: null, token: created.token }, 201);
	};
	const noEmail = ok({ available: false, address: null, pending: null });
	return [
		route("GET", "/auth/session", async ({ app, maybePrincipal }) => {
			const p = await maybePrincipal();
			const providers = app.external.buttons();
			if (!p || p.kind !== "user") {
				const state = await app.db.anonymous(async (tx) => ({
					claimed: (await tx.query("SELECT EXISTS (SELECT 1 FROM pim_app.accounts) AS claimed")).rows[0].claimed as boolean,
					open: (await tx.query("SELECT value FROM pim_app.instance_settings WHERE key = 'registration_open'")).rows[0]?.value === true,
				}));
				return ok({ signedIn: false, method: null, passkey: null, credential: null, account: null, providers, claimed: state.claimed, canClaim: !state.claimed, registration: state.open ? "open" : "invite" });
			}
			const credential = await app.signin.sessionCredential(p.ownerId, p.sessionId);
			const identity = credential?.startsWith("idp_") ?? false;
			const name = (await app.signin.identities(p.ownerId)).find((i) => i.name !== null)?.name ?? null;
			return ok({ signedIn: true, method: identity ? "identity" : "passkey", passkey: identity ? null : credential, credential, account: await app.identity.authz.account(p.ownerId), name, providers });
		}),
		route("GET", "/auth/passkeys", async ({ app, principal }) => ok({ passkeys: (await app.signin.passkeys((await principal()).ownerId)).map((k) => ({ id: k.id, name: k.name, createdAt: ms(k.createdAt), lastUsedAt: ms(k.lastUsedAt) })) })),
		route("GET", "/auth/identities", async ({ app, principal }) => ok({ identities: (await app.signin.identities((await principal()).ownerId)).map(({ id, provider, label, createdAt, lastUsedAt }) => ({ id, provider, label, createdAt: ms(createdAt), lastUsedAt: ms(lastUsedAt) })) })),
		route("POST", "/auth/device-link", async ({ app, principal, origin }) => {
			const link = await app.signin.newDeviceLink(await principal(), origin);
			return ok({ url: link.url, expiresAt: link.expiresAt.toISOString() }, 201);
		}),
		route("DELETE", "/auth/device-link", async ({ app, principal }) => {
			await app.signin.voidDeviceLinks(await principal());
			return ok({ ok: true });
		}),
		route("GET", "/auth/tokens", tokenList),
		route("POST", "/auth/tokens", tokenCreate),
		route("DELETE", "/auth/tokens/:id", async ({ app, principal, params }) => {
			await app.identity.revokeToken(await principal(), params[0]!);
			return ok({ ok: true });
		}),
		route("GET", "/api/tokens", tokenList),

		// Email needs a mail sender this Pim does not run: the settings show it as not available.
		route("GET", "/api/email", async ({ principal }) => (await principal(), noEmail)),
		route("PUT", "/api/email", async ({ principal }) => (await principal(), unavailable("email", "this Pim cannot send email"))),
		route("POST", "/api/email/confirm", async ({ principal }) => (await principal(), unavailable("email", "this Pim cannot send email"))),
		route("DELETE", "/api/email", async ({ principal }) => (await principal(), noEmail)),
	];
}
