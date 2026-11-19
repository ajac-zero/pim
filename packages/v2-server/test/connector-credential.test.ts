// A connector's OAuth sign-in is renewed by one caller at a time, written only over the credential it began from, and marked as lost when its service says the grant is gone (v1:
// mcp.test.ts "refresh once", native-apps.test.ts "renew once for calls at once", "a call's renewal begun on an old sign-in must not overwrite the connection made again").
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KeyringCrypto, sealString } from "@pim/v2-app/crypto";
import { CredentialRenewals, type CredentialStore, SignInLost } from "../src/connector-credential.ts";

const crypto = new KeyringCrypto("k1", { k1: new Uint8Array(randomBytes(32)) });
const OWNER = "o1";
const aad = `connector:${OWNER}/c1`;
const bundle = (access: string, refresh = "refresh-1") => JSON.stringify({ access_token: access, refresh_token: refresh, expires_at: 1000, token_endpoint: "https://auth.example.test/token", client_id: "cl" });

/** A connector's one row, and what was done to it. */
function rig(initial: string) {
	const row = { credential: initial as string | null, gone: false, lost: undefined as string | undefined };
	const store: CredentialStore = {
		async current() {
			return row.gone ? undefined : row.credential;
		},
		async replace(_o, _i, expected, sealed) {
			if (row.credential !== expected) return false;
			row.credential = sealed;
			return true;
		},
		async lose(_o, _i, expected, error) {
			if (row.credential !== expected) return false;
			row.credential = null;
			row.lost = error;
			return true;
		},
	};
	return { row, store };
}
const answer = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const connector = (credential: string) => ({ id: "c1", name: "Board", url: "https://board.example.test/mcp", credential });

describe("renewing a connector's sign-in", () => {
	it("asks the service once for calls that find the sign-in run out together, and writes it over the credential it read", async () => {
		const stale = await sealString(crypto, bundle("old"), aad);
		const { row, store } = rig(stale);
		const requests: string[] = [];
		// The service rotates its refresh tokens: the second use of one would revoke the sign-in.
		const fetcher = (async (_url: string, init: RequestInit) => {
			requests.push(String(init.body));
			await new Promise((r) => setTimeout(r, 20));
			return answer(200, { access_token: "new", refresh_token: "refresh-2", expires_in: 3600 });
		}) as unknown as typeof fetch;
		const renewals = new CredentialRenewals({ crypto, store, fetch: fetcher, now: () => 5000 });
		const opened = await Promise.all([renewals.open(OWNER, connector(stale)), renewals.open(OWNER, connector(stale)), renewals.open(OWNER, connector(stale))]);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("refresh_token=refresh-1");
		expect(opened.map((o) => o.bearer)).toEqual(["new", "new", "new"]);
		expect(row.credential).not.toBe(stale);
		expect(opened[0]!.sealed).toBe(row.credential);
	});

	it("uses the sign-in the person made again meanwhile, and does not overwrite it with the renewal of the old one", async () => {
		const stale = await sealString(crypto, bundle("old"), aad);
		const again = await sealString(crypto, JSON.stringify({ access_token: "reconnected", refresh_token: "refresh-9", expires_at: 9_999_999 }), aad);
		const { row, store } = rig(stale);
		const fetcher = (async () => {
			// The person connects it again while the renewal is under way.
			row.credential = again;
			return answer(200, { access_token: "new", expires_in: 3600 });
		}) as unknown as typeof fetch;
		const opened = await new CredentialRenewals({ crypto, store, fetch: fetcher, now: () => 5000 }).open(OWNER, connector(stale));
		expect(opened.bearer).toBe("reconnected");
		expect(row.credential).toBe(again);
	});

	it("marks the connector as needing a sign-in when the service says the grant is gone, and tells the caller", async () => {
		const stale = await sealString(crypto, bundle("old"), aad);
		const { row, store } = rig(stale);
		const fetcher = (async () => answer(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })) as unknown as typeof fetch;
		const renewals = new CredentialRenewals({ crypto, store, fetch: fetcher, now: () => 5000 });
		await expect(renewals.open(OWNER, connector(stale))).rejects.toThrow(new SignInLost("Board"));
		expect(row).toMatchObject({ credential: null, lost: "Sign in again: Token has been expired or revoked." });
		// Nothing is left to use: the next call hears the same.
		await expect(renewals.open(OWNER, { ...connector(stale) })).rejects.toBeInstanceOf(SignInLost);
	});

	it("leaves the sign-in alone when the service only cannot answer now, or answers more than is read", async () => {
		const stale = await sealString(crypto, bundle("old"), aad);
		const { row, store } = rig(stale);
		for (const reply of [() => answer(503, { error: "temporarily_unavailable" }), () => answer(400, { error: "invalid_grant", error_description: "x".repeat(100_000) })]) {
			const opened = await new CredentialRenewals({ crypto, store, fetch: (async () => reply()) as unknown as typeof fetch, now: () => 5000 }).open(OWNER, connector(stale));
			expect(opened.bearer).toBe("old");
			expect(row).toMatchObject({ credential: stale, lost: undefined });
		}
	});

	it("does not take a revocation for the person's new sign-in when another caller renewed first", async () => {
		// This caller's request for the old refresh token is refused because another process already spent it and wrote the new credential.
		const stale = await sealString(crypto, bundle("old"), aad);
		const winner = await sealString(crypto, JSON.stringify({ access_token: "theirs", refresh_token: "refresh-2", expires_at: 9_999_999 }), aad);
		const { row, store } = rig(stale);
		const fetcher = (async () => {
			row.credential = winner;
			return answer(400, { error: "invalid_grant" });
		}) as unknown as typeof fetch;
		const opened = await new CredentialRenewals({ crypto, store, fetch: fetcher, now: () => 5000 }).open(OWNER, connector(stale));
		expect(opened.bearer).toBe("theirs");
		expect(row).toMatchObject({ credential: winner, lost: undefined });
	});

	it("renews a credential the service refused even though it has not expired, from the one that was refused", async () => {
		const fresh = await sealString(crypto, JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 9_999_999, token_endpoint: "https://auth.example.test/token" }), aad);
		const { row, store } = rig(fresh);
		const fetcher = (async () => answer(200, { access_token: "b", expires_in: 60 })) as unknown as typeof fetch;
		const renewals = new CredentialRenewals({ crypto, store, fetch: fetcher, now: () => 5000 });
		expect((await renewals.open(OWNER, connector(fresh))).bearer).toBe("a");
		const forced = await renewals.open(OWNER, connector(fresh), true);
		expect(forced.bearer).toBe("b");
		expect(row.credential).toBe(forced.sealed);
	});
});
