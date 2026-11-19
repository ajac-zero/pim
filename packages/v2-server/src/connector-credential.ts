/**
 * A connector's sign-in, opened for use and renewed when it has run out. A sealed credential is a bearer token or a JSON bundle of an OAuth sign-in (`native/oauth-client.ts`).
 * Renewing it is where a careless caller loses the person's sign-in, as v1 knew, so it is done one way for everyone (the Runner's tools, a bot's guests, the Gate's own screens):
 *
 * - one renewal at a time for a connector: calls that find the credential run out together share one request, since a service that rotates its refresh tokens would take the second
 *   use of the old one for theft and revoke the sign-in;
 * - the new credential is written only over the one the renewal started from (a compare-and-swap), and when someone else changed it meanwhile (the person connected it again, or another
 *   process renewed first) that credential is the one used and nothing is overwritten;
 * - a grant the service says is gone (`invalid_grant`) is not an error to shrug off: the connector is marked as needing the person to sign in again, its credential cleared. A service that
 *   merely cannot answer now (a 5xx, an answer too large to read) leaves it as it was, and the call goes on with the credential it has.
 */
import type { App } from "@pim/v2-app/app";
import { openString, sealString } from "@pim/v2-app/crypto";
import type { EnvelopeCrypto } from "@pim/v2-contracts/platform";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { bundleOf, GrantGone, tokenRequest } from "./native/oauth-client.ts";

export type OAuthBundle = { access_token: string; refresh_token?: string; expires_at?: number; token_endpoint?: string; client_id?: string; client_secret?: string };

/** A stored credential is a bearer token, or a JSON object of an OAuth sign-in that can be refreshed. */
export function parseCredential(stored: string): { bearer: string; bundle: OAuthBundle | null } {
	if (stored.startsWith("{")) {
		try {
			const b = JSON.parse(stored) as OAuthBundle;
			if (typeof b.access_token === "string") return { bearer: b.access_token, bundle: b };
		} catch {
			// A token that merely begins with a brace is a bearer.
		}
	}
	return { bearer: stored, bundle: null };
}

/** The sign-in is gone for good: only the person connecting the connector again helps. Its message says so for whoever reads a tool's answer. */
export class SignInLost extends Error {
	constructor(readonly connector: string) {
		super(`${connector} needs the person to connect it again from the Connectors page.`);
	}
}

/** Where a connector's sealed credential is kept: read it, replace it over the one a renewal started from, or mark the sign-in lost over it (each answers whether it was still that one). */
export type CredentialStore = {
	/** The sealed credential now (`null` when it has none), or `undefined` when the connector is gone. */
	current(ownerId: string, id: string): Promise<string | null | undefined>;
	replace(ownerId: string, id: string, expected: string, sealed: string): Promise<boolean>;
	lose(ownerId: string, id: string, expected: string, error: string): Promise<boolean>;
};

export type Opened = { bearer: string | null; bundle: OAuthBundle | null; /** The sealed credential this was opened from, to hand back when the service refuses it. */ sealed: string | null };
export type Renewable = { id: string; name: string; url: string | null; credential: string | null };

export type RenewalOptions = {
	crypto: EnvelopeCrypto | undefined;
	store: CredentialStore;
	fetch: typeof fetch;
	now: () => number;
	/** How long before it expires a credential is renewed. */
	leadMs?: number;
	/** Where a credential that holds no token endpoint renews (found from the server's address); absent for native connectors, whose bundle always has one. */
	endpoint?: (url: string, bundle: OAuthBundle) => Promise<string | null>;
};

/** The renewals in flight in this process, whoever asked (the Runner's tools, the watches, the Gate): one per sign-in, so a second caller does not spend the refresh token again. */
const flights = new Map<string, Promise<Opened>>();

export class CredentialRenewals {
	constructor(private readonly o: RenewalOptions) {}

	/** The credential `c` holds, opened; renewed first when it has expired, or when `force` says the service refused it. */
	async open(ownerId: string, c: Renewable, force = false): Promise<Opened> {
		if (!c.credential) return { bearer: null, bundle: null, sealed: null };
		const opened = await this.#open(ownerId, c.id, c.credential);
		const { bundle } = opened;
		if (!bundle || !(force || (bundle.expires_at !== undefined && bundle.expires_at <= this.o.now() + (this.o.leadMs ?? 30_000)))) return opened;
		const key = `${ownerId}\u0000${c.id}\u0000${c.credential}`;
		let flight = flights.get(key);
		if (!flight) {
			flight = this.#renew(ownerId, c, opened).finally(() => flights.delete(key));
			flights.set(key, flight);
		}
		return flight;
	}

	async #open(ownerId: string, id: string, sealed: string): Promise<Opened> {
		if (!this.o.crypto) throw new Error("This Runner has no keys (PIM_KEK_<id> and PIM_KEK_CURRENT), so it cannot open a connector's credential.");
		const { bearer, bundle } = parseCredential(await openString(this.o.crypto, sealed, `connector:${ownerId}/${id}`));
		return { bearer, bundle, sealed };
	}

	/** What another caller left in place of `stale`, opened; the connector's sign-in lost or the connector gone is what the person must hear of. */
	async #adopt(ownerId: string, c: Renewable): Promise<Opened> {
		const now = await this.o.store.current(ownerId, c.id);
		if (now === undefined) throw new Error(`${c.name} was removed.`);
		if (now === null) throw new SignInLost(c.name);
		return this.#open(ownerId, c.id, now);
	}

	async #renew(ownerId: string, c: Renewable, started: Opened): Promise<Opened> {
		const { bundle } = started;
		if (!bundle) return started;
		const stale = c.credential!;
		const current = await this.o.store.current(ownerId, c.id);
		if (current !== stale) return this.#adopt(ownerId, c);
		const endpoint = bundle.token_endpoint ?? (bundle.refresh_token && this.o.endpoint ? await this.o.endpoint(c.url ?? "", bundle).catch(() => null) : null);
		if (!bundle.refresh_token || !endpoint) return started;
		let renewed: OAuthBundle;
		try {
			const answer = await tokenRequest(this.o.fetch, endpoint, { grant_type: "refresh_token", refresh_token: bundle.refresh_token, ...(bundle.client_id ? { client_id: bundle.client_id } : {}), ...(bundle.client_secret ? { client_secret: bundle.client_secret } : {}) });
			renewed = bundleOf(answer, { ...bundle, token_endpoint: endpoint }, this.o.now()) as OAuthBundle;
		} catch (error) {
			if (!(error instanceof GrantGone)) return started;
			// Gone for good, unless another caller renewed or the person connected again while this asked: then theirs stands.
			if (await this.o.store.lose(ownerId, c.id, stale, `Sign in again: ${error.message}`)) throw new SignInLost(c.name);
			return this.#adopt(ownerId, c);
		}
		const sealed = await sealString(this.o.crypto!, JSON.stringify(renewed), `connector:${ownerId}/${c.id}`);
		if (await this.o.store.replace(ownerId, c.id, stale, sealed)) return { bearer: renewed.access_token, bundle: renewed, sealed };
		return this.#adopt(ownerId, c);
	}
}

/** The credential as the Runner reaches it: through the application's SECURITY DEFINER functions (migration 0708). */
export const runtimeStore = (runtime: RuntimeDb): CredentialStore => ({
	async current(ownerId, id) {
		const found = (await runtime.read<{ r: { credential: string | null } | null }>(ownerId, "SELECT pim_app.runner_connector_credential($1, $2) AS r", [ownerId, id])).rows[0]!.r;
		return found === null ? undefined : found.credential;
	},
	async replace(ownerId, id, expected, sealed) {
		return (await runtime.read<{ ok: boolean }>(ownerId, "SELECT pim_app.runner_replace_connector_credential($1, $2, $3, $4) AS ok", [ownerId, id, expected, sealed])).rows[0]!.ok;
	},
	async lose(ownerId, id, expected, error) {
		return (await runtime.read<{ ok: boolean }>(ownerId, "SELECT pim_app.runner_connector_signin_lost($1, $2, $3, $4) AS ok", [ownerId, id, expected, error])).rows[0]!.ok;
	},
});

/** The credential as the Gate reaches it, as the owner. */
export const appStore = (app: App): CredentialStore => ({
	async current(ownerId, id) {
		const row = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT credential FROM pim_app.connectors WHERE id = $1", [id])).rows[0])) as { credential: string | null } | undefined;
		return row ? row.credential : undefined;
	},
	async replace(ownerId, id, expected, sealed) {
		return (await app.db.owner(ownerId, async (tx) => (await tx.query("UPDATE pim_app.connectors SET credential = $3, status = 'connected', auth_url = NULL, error = NULL WHERE id = $1 AND credential = $2", [id, expected, sealed])).rowCount)) === 1;
	},
	async lose(ownerId, id, expected, error) {
		return (await app.db.owner(ownerId, async (tx) => (await tx.query("UPDATE pim_app.connectors SET credential = NULL, status = 'auth_required', auth_url = NULL, error = $3, signin_lost_at = now() WHERE id = $1 AND credential = $2", [id, expected, error])).rowCount)) === 1;
	},
});
