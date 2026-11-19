import { randomBytes } from "node:crypto";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import type { Account } from "./authz.ts";
import type { Db } from "./db.ts";
import { BadRequestError, NotFoundError, RefusedError, UnauthorizedError } from "./errors.ts";
import { digest, newId, secret } from "./ids.ts";
import type { Identity } from "./identity.ts";
import { usernameProblem } from "./registration.ts";
import { ALGORITHMS, type Assertion, type PublicKey, type Registration, verifyAssertion, verifyRegistration } from "./webauthn.ts";

/** What a ceremony is bound to: the hostname passkeys belong to and the page's origin. */
export type Site = { rpId: string; origin: string };

export const CHALLENGE_MS = 5 * 60_000;
export const SETUP_CODE_MS = 24 * 3600_000;
export const DEVICE_LINK_MS = 10 * 60_000;
export const RECOVERY_CODES = 10;

/** The WebAuthn user handle for an owner: their owner id's bytes, base64url. */
export const userHandle = (ownerId: string): string => Buffer.from(ownerId).toString("base64url");
export function ownerOfHandle(handle: string): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(handle, "base64url"));
	} catch {
		return null;
	}
}
/** `<owner>.<code>`, as setup and device links carry them. */
export const ownedCode = (ownerId: string, code: string) => `${ownerId}.${code}`;
export function splitOwnedCode(value: unknown): { owner: string; code: string } | null {
	if (typeof value !== "string") return null;
	const dot = value.indexOf(".");
	return dot <= 0 || dot === value.length - 1 ? null : { owner: value.slice(0, dot), code: value.slice(dot + 1) };
}
/** A recovery code as typed: any case, with or without dashes and spaces. */
export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[\s-]/g, "");
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const recoveryCode = () => {
	const chars = [...randomBytes(15)].map((b) => ALPHABET[b & 31]);
	return [0, 5, 10].map((i) => chars.slice(i, i + 5).join("")).join("-");
};

type AllowedBy = { setup?: string; recovery?: string; device?: string };
export type PasskeyRow = { id: string; name: string; createdAt: Date; lastUsedAt: Date | null };

/**
 * Passkey sign-in and enrollment, ported from the Worker's Auth: no attestation (a new passkey is trusted because whoever makes it is signed in or
 * holds a setup code, recovery code or device link), the user handle is base64url(ownerId), and the relying party id is the hostname. A ceremony
 * is a row in `auth_flows` the browser holds the id of in a cookie; it answers once and expires after five minutes.
 */
export class SignIn {
	constructor(private readonly db: Db, private readonly identity: Identity) {}

	// ---- flows ----

	async startFlow(kind: "challenge" | "oauth" | "consent" | "code" | "hosted" | "hosted_enter", data: object, ttlMs: number, now = new Date()): Promise<string> {
		const id = secret();
		await this.db.anonymous(async (tx) => {
			await tx.query("DELETE FROM pim_app.auth_flows WHERE expires_at <= $1", [now]);
			await tx.query("INSERT INTO pim_app.auth_flows (id, kind, data, expires_at) VALUES ($1, $2, $3, $4)", [digest(id), kind, JSON.stringify(data), new Date(now.getTime() + ttlMs)]);
		});
		return id;
	}

	/** Reads a live flow of `kind`; `consume` removes it so it answers once. */
	async flow<T = Record<string, any>>(id: string | undefined, kind: string, opts: { consume?: boolean; now?: Date } = {}): Promise<T | null> {
		if (!id) return null;
		const now = opts.now ?? new Date();
		return this.db.anonymous(async (tx) => {
			const sql = opts.consume ? "DELETE FROM pim_app.auth_flows WHERE id = $1 AND kind = $2 AND expires_at > $3 RETURNING data" : "SELECT data FROM pim_app.auth_flows WHERE id = $1 AND kind = $2 AND expires_at > $3";
			return ((await tx.query(sql, [digest(id), kind, now])).rows[0]?.data as T | undefined) ?? null;
		});
	}

	// ---- sign in ----

	async signInOptions(site: Site, now = new Date()) {
		const challenge = secret();
		const flow = await this.startFlow("challenge", { challenge, ceremony: "get" }, CHALLENGE_MS, now);
		return { flow, options: { challenge, rpId: site.rpId, userVerification: "required", timeout: CHALLENGE_MS } };
	}

	/** Verifies an assertion and starts a server-side session. The passkey must be one of the owner its user handle names. */
	async signIn(flowId: string | undefined, assertion: Assertion & { userHandle: string }, site: Site, opts: { userAgent?: string; now?: Date } = {}): Promise<{ session: string; account: Account }> {
		const now = opts.now ?? new Date();
		const pending = await this.flow<{ challenge: string; ceremony: string }>(flowId, "challenge", { consume: true, now });
		if (pending?.ceremony !== "get") throw new BadRequestError("Signing in took too long. Try again.");
		const owner = ownerOfHandle(assertion.userHandle);
		const known = owner && OwnerId.safeParse(owner).success ? await this.identity.authz.account(owner) : null;
		const key = known ? await this.db.owner(known.ownerId, async (tx): Promise<PublicKey | null> => {
			const r = (await tx.query("SELECT spki, algorithm FROM pim_app.passkeys WHERE credential_id = $1", [assertion.id])).rows[0];
			return r ? { spki: r.spki, algorithm: r.algorithm } : null;
		}) : null;
		const valid = key && (await verifyAssertion(assertion, key, { ...site, challenge: pending.challenge }));
		if (!known || !valid) throw new UnauthorizedError("That passkey isn't one of this Pim's.");
		if (known.status === "suspended") throw new RefusedError("Your account is suspended. Ask the person who runs this Pim.", "suspended");
		if (known.status !== "active") throw new UnauthorizedError("That passkey isn't one of this Pim's.");
		await this.db.owner(known.ownerId, (tx) => tx.query("UPDATE pim_app.passkeys SET last_used_at = $2, sign_count = sign_count + 1 WHERE credential_id = $1", [assertion.id, now]));
		return { session: await this.identity.createSession(known.ownerId, { credentialId: assertion.id, ...(opts.userAgent ? { userAgent: opts.userAgent } : {}), now }), account: known };
	}

	// ---- enrollment ----

	/**
	 * Options for making a passkey. Allowed to a signed-in person, or to one holding a setup code (`<owner>.<code>`), a recovery code with
	 * their username, or a device link. Anything else is refused.
	 */
	async passkeyOptions(session: Principal | null, body: { setup?: unknown; recovery?: unknown; username?: unknown; device?: unknown }, site: Site, now = new Date()) {
		let account: Account | null = null;
		let allowedBy: AllowedBy = {};
		if (session) account = await this.identity.authz.account(session.ownerId);
		else {
			const setup = splitOwnedCode(body.setup);
			const device = splitOwnedCode(body.device);
			if (setup) {
				account = await this.identity.authz.account(setup.owner);
				if (account && account.status !== "suspended" && (await this.#setupLive(setup.owner, setup.code, now))) allowedBy = { setup: setup.code };
				else throw new UnauthorizedError("This setup link has expired or was already used.");
			} else if (typeof body.recovery === "string" && typeof body.username === "string") {
				const owner = await this.#ownerByUsername(body.username.trim().toLowerCase().replace(/^@/, ""));
				account = owner ? await this.identity.authz.account(owner) : null;
				const hash = digest(normalizeRecoveryCode(body.recovery));
				if (account && account.status !== "suspended" && (await this.db.owner(account.ownerId, async (tx) => (await tx.query("SELECT 1 FROM pim_app.recovery_codes WHERE code_hash = $1 AND used_at IS NULL", [hash])).rowCount))) allowedBy = { recovery: hash };
				else throw new UnauthorizedError("That username and recovery code don't go together, or the code was already used.");
			} else if (device) {
				account = await this.identity.authz.account(device.owner);
				if (account?.status === "active" && (await this.#deviceLive(device.owner, device.code, now))) allowedBy = { device: device.code };
				else throw new UnauthorizedError("This link has expired or was already used. Make a new one on a device that's signed in.");
			} else throw new UnauthorizedError("Sign in to add a passkey.");
		}
		if (!account || account.status === "suspended") throw new RefusedError("This account can't add passkeys.", "suspended");
		const challenge = secret();
		const flow = await this.startFlow("challenge", { challenge, ceremony: "create", owner: account.ownerId, ...allowedBy }, CHALLENGE_MS, now);
		const existing = await this.passkeys(account.ownerId);
		return {
			flow,
			options: {
				challenge,
				rp: { id: site.rpId, name: "Pim" },
				user: { id: userHandle(account.ownerId), name: account.username, displayName: account.username },
				pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
				authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
				attestation: "none",
				timeout: CHALLENGE_MS,
				excludeCredentials: existing.map(({ id }) => ({ type: "public-key", id })),
			},
		};
	}

	/** Finishes enrollment. Without a link the person must still be signed in; with one, the link is spent first, so two tabs cannot both finish. */
	async addPasskey(flowId: string | undefined, registration: Registration & { name: string }, session: Principal | null, site: Site, opts: { userAgent?: string; now?: Date } = {}): Promise<{ passkey: PasskeyRow; session: string | null }> {
		const now = opts.now ?? new Date();
		const pending = await this.flow<{ challenge: string; ceremony: string; owner?: string } & AllowedBy>(flowId, "challenge", { consume: true, now });
		if (pending?.ceremony !== "create" || !pending.owner) throw new BadRequestError("Creating the passkey took too long. Try again.");
		const account = await this.identity.authz.account(pending.owner);
		if (!account || account.status === "suspended") throw new RefusedError("This account can't add passkeys.", "suspended");
		if (registration.id.length > 1400) throw new BadRequestError("Couldn't read the passkey.");
		const key = await verifyRegistration(registration, { ...site, challenge: pending.challenge });
		if (!key) throw new BadRequestError("Couldn't verify the passkey.");
		const viaLink = Boolean(pending.setup || pending.recovery || pending.device);
		if (!viaLink && session?.ownerId !== account.ownerId) throw new UnauthorizedError("Sign in to add a passkey.");
		const owner = account.ownerId;
		await this.db.owner(owner, async (tx) => {
			const spend = async (sql: string, params: unknown[], message: string) => {
				if (!(await tx.query(sql, params)).rowCount) throw new UnauthorizedError(message);
			};
			if (pending.setup) await spend("UPDATE pim_app.setup_codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2", [digest(pending.setup), now], "This setup link was already used.");
			if (pending.recovery) await spend("UPDATE pim_app.recovery_codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL", [pending.recovery, now], "That recovery code was already used.");
			if (pending.device) await spend("DELETE FROM pim_app.device_links WHERE code_hash = $1 AND expires_at > $2", [digest(pending.device), now], "This link has expired or was already used. Make a new one on a device that's signed in.");
			await tx.query("INSERT INTO pim_app.passkeys (credential_id, owner_id, user_handle, rp_id, spki, algorithm, name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
				registration.id, owner, userHandle(owner), site.rpId, key.spki, key.algorithm, registration.name.trim().slice(0, 64) || "Passkey", now,
			]);
			if (account.status === "pending") await tx.query("UPDATE pim_app.accounts SET status = 'active', activated_at = $2, pending_until = NULL WHERE owner_id = $1 AND pending_until > $2", [owner, now]);
			// With a passkey the account has a way in: the link its registration handed back, if still unused, dies.
			await tx.query("UPDATE pim_app.setup_codes SET used_at = $2 WHERE owner_id = $1 AND kind = 'registration' AND used_at IS NULL", [owner, now]);
		});
		const rows = await this.passkeys(owner);
		const passkey = rows.find((p) => p.id === registration.id)!;
		// A browser already signed in stays on its own session.
		const started = session ? null : await this.identity.createSession(owner, { credentialId: registration.id, ...(opts.userAgent ? { userAgent: opts.userAgent } : {}), now });
		return { passkey, session: started };
	}

	async passkeys(ownerId: string): Promise<PasskeyRow[]> {
		return this.db.owner(ownerId, async (tx) => (await tx.query("SELECT credential_id, name, created_at, last_used_at FROM pim_app.passkeys ORDER BY created_at")).rows.map((r) => ({ id: r.credential_id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })));
	}

	/** Removes a passkey; sessions made with it end with it. */
	async removePasskey(ownerId: string, id: string): Promise<void> {
		await this.#removeCredential(ownerId, id, "pim_app.passkeys", "credential_id");
	}

	async #removeCredential(ownerId: string, id: string, table: string, column: string): Promise<void> {
		await this.db.owner(ownerId, async (tx) => {
			if (!(await tx.query(`DELETE FROM ${table} WHERE ${column} = $1`, [id])).rowCount) throw new NotFoundError("No such credential");
			await tx.query("UPDATE pim_app.browser_sessions SET revoked_at = coalesce(revoked_at, now()) WHERE credential_id = $1", [id]);
			await tx.query("DELETE FROM pim_app.device_links WHERE credential_id = $1", [id]);
		});
	}

	// ---- setup codes, device links, recovery codes ----

	/** An admin (or the operator's CLI) issues a setup code for an account that has no credential yet. Returns the `<owner>.<code>` to put in a link. */
	async issueSetupCode(ownerId: string, now = new Date(), kind: "registration" | "admin" = "admin"): Promise<{ code: string; expiresAt: Date }> {
		const code = secret(16);
		const expiresAt = new Date(now.getTime() + SETUP_CODE_MS);
		await this.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.setup_codes (code_hash, owner_id, expires_at, kind) VALUES ($1, $2, $3, $4)", [digest(code), ownerId, expiresAt, kind]));
		return { code: ownedCode(ownerId, code), expiresAt };
	}

	/**
	 * The setup code the operator's log gets for an account (`POST /auth/setup-link`): the one still live, so asking again logs the same link until it expires or is used,
	 * else a new one.
	 */
	async operatorSetupCode(ownerId: string, now = new Date()): Promise<{ code: string; expiresAt: Date }> {
		const live = await this.db.owner(ownerId, async (tx) => (await tx.query("SELECT plain, expires_at FROM pim_app.setup_codes WHERE owner_id = $1 AND kind = 'operator' AND used_at IS NULL AND expires_at > $2 AND plain IS NOT NULL ORDER BY created_at DESC LIMIT 1", [ownerId, now])).rows[0]);
		if (live) return { code: ownedCode(ownerId, live.plain as string), expiresAt: live.expires_at as Date };
		const code = secret(16);
		const expiresAt = new Date(now.getTime() + SETUP_CODE_MS);
		await this.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.setup_codes (code_hash, owner_id, expires_at, kind, plain) VALUES ($1, $2, $3, 'operator', $4)", [digest(code), ownerId, expiresAt, code]));
		return { code: ownedCode(ownerId, code), expiresAt };
	}

	/** The account has a way in now, so the link its registration handed back dies. Never the ones an admin or the operator issued. */
	async voidRegistrationLinks(ownerId: string, now = new Date()): Promise<void> {
		await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.setup_codes SET used_at = $2 WHERE owner_id = $1 AND kind = 'registration' AND used_at IS NULL", [ownerId, now]));
	}

	async #setupLive(ownerId: string, code: string, now: Date): Promise<boolean> {
		return this.db.owner(ownerId, async (tx) => !!(await tx.query("SELECT 1 FROM pim_app.setup_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2", [digest(code), now])).rowCount);
	}

	/** A link to add another device, made by a signed-in browser; it makes one passkey, once, before it expires, and dies with the session that made it. */
	async newDeviceLink(session: Principal, origin: string, now = new Date()): Promise<{ url: string; expiresAt: Date }> {
		if (session.kind !== "user") throw new RefusedError("Only a signed-in browser makes device links.", "session-only");
		const code = secret();
		const expiresAt = new Date(now.getTime() + DEVICE_LINK_MS);
		const credential = await this.db.owner(session.ownerId, async (tx) => {
			const cred = (await tx.query("SELECT credential_id FROM pim_app.browser_sessions WHERE id = $1", [session.sessionId])).rows[0]?.credential_id ?? session.sessionId;
			await tx.query("DELETE FROM pim_app.device_links WHERE expires_at <= $1 OR credential_id = $2", [now, cred]);
			await tx.query("INSERT INTO pim_app.device_links (code_hash, owner_id, credential_id, expires_at) VALUES ($1,$2,$3,$4)", [digest(code), session.ownerId, cred, expiresAt]);
			return cred;
		});
		void credential;
		// The code goes in the fragment, so it never reaches a server's logs or a Referer header.
		return { url: `${origin}/#device=${ownedCode(session.ownerId, code)}`, expiresAt };
	}

	async voidDeviceLinks(session: Principal): Promise<void> {
		if (session.kind !== "user") return;
		await this.db.owner(session.ownerId, async (tx) => {
			const cred = (await tx.query("SELECT credential_id FROM pim_app.browser_sessions WHERE id = $1", [session.sessionId])).rows[0]?.credential_id ?? session.sessionId;
			await tx.query("DELETE FROM pim_app.device_links WHERE credential_id = $1", [cred]);
		});
	}

	async #deviceLive(ownerId: string, code: string, now: Date): Promise<boolean> {
		return this.db.owner(ownerId, async (tx) => !!(await tx.query("SELECT 1 FROM pim_app.device_links WHERE code_hash = $1 AND expires_at > $2", [digest(code), now])).rowCount);
	}

	async newRecoveryCodes(ownerId: string): Promise<string[]> {
		const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
		await this.db.owner(ownerId, async (tx) => {
			await tx.query("DELETE FROM pim_app.recovery_codes");
			for (const code of codes) await tx.query("INSERT INTO pim_app.recovery_codes (code_hash, owner_id) VALUES ($1, $2)", [digest(normalizeRecoveryCode(code)), ownerId]);
		});
		return codes;
	}

	async recoveryCodesLeft(ownerId: string): Promise<number> {
		return this.db.owner(ownerId, async (tx) => (await tx.query("SELECT count(*)::int AS n FROM pim_app.recovery_codes WHERE used_at IS NULL")).rows[0].n);
	}

	async #ownerByUsername(username: string): Promise<string | null> {
		return this.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE username = $1 AND status <> 'deleted'", [username])).rows[0]?.owner_id ?? null);
	}

	/** Whether a username is free: never claimed, now or in the past. */
	async usernameAvailable(name: string): Promise<{ available: boolean; reason?: string }> {
		const problem = usernameProblem(name);
		if (problem) return { available: false, reason: problem };
		const taken = await this.db.anonymous(async (tx) => !!(await tx.query("SELECT 1 FROM pim_app.usernames WHERE username = $1", [name])).rowCount);
		return taken ? { available: false, reason: "That username is taken." } : { available: true };
	}

	// ---- linked identities (the (issuer, subject) is unique across the whole instance) ----

	async identities(ownerId: string) {
		return this.db.owner(ownerId, async (tx) => (await tx.query("SELECT id, provider, label, name, created_at, last_used_at FROM pim_app.oidc_identities ORDER BY created_at")).rows.map((r) => ({ id: r.id as string, provider: r.provider as string, label: r.label as string, name: r.name as string | null, createdAt: r.created_at as Date, lastUsedAt: r.last_used_at as Date | null })));
	}

	/** The owner an identity belongs to, if any. Instance-wide. */
	async identityOwner(identity: { issuer: string; subject: string }): Promise<string | null> {
		return this.db.lookup(`${identity.issuer}\n${identity.subject}`, async (tx) => (await tx.query("SELECT owner_id FROM pim_app.oidc_identities WHERE identity_key = $1", [`${identity.issuer}\n${identity.subject}`])).rows[0]?.owner_id ?? null);
	}

	/** Links an identity to an owner: null when it is already someone else's. */
	async linkIdentity(ownerId: string, provider: string, identity: { issuer: string; subject: string; label: string; name: string | null }, now = new Date()): Promise<{ id: string } | null> {
		const id = `idp_${newId("i").slice(2)}`;
		return this.db.owner(ownerId, async (tx) => {
			const r = await tx.query(
				"INSERT INTO pim_app.oidc_identities (id, owner_id, provider, issuer, subject, label, name, created_at, last_used_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (issuer, subject) DO UPDATE SET label = excluded.label, name = excluded.name WHERE pim_app.oidc_identities.owner_id = excluded.owner_id RETURNING id",
				[id, ownerId, provider, identity.issuer, identity.subject, identity.label, identity.name, now],
			);
			return r.rows[0] ? { id: r.rows[0].id as string } : null;
		});
	}

	async removeIdentity(ownerId: string, id: string): Promise<void> {
		await this.#removeCredential(ownerId, id, "pim_app.oidc_identities", "id");
	}

	async touchIdentity(ownerId: string, id: string, label: string, name: string | null, now = new Date()): Promise<void> {
		await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.oidc_identities SET last_used_at = $2, label = $3, name = coalesce($4, name) WHERE id = $1", [id, now, label, name]));
	}

	/** Whether a session's credential (a passkey or a linked identity) still exists, for the "signed in" answer. */
	async sessionCredential(ownerId: string, sessionId: string): Promise<string | null> {
		return this.db.owner(ownerId, async (tx) => (await tx.query("SELECT credential_id FROM pim_app.browser_sessions WHERE id = $1", [sessionId])).rows[0]?.credential_id ?? null);
	}
}
