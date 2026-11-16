import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type pg from "pg";
import { withTenant } from "./db.ts";

/**
 * Envelope encryption with versioned, separated keys.
 *
 * Each secret has its own random data key. The data key is wrapped by a key-encryption key (KEK) derived from the
 * deployment's master secret with HKDF under a label no other use shares (session signing, token hashing and the
 * like derive their keys under their own labels, so a leak of one purpose does not open another). Both layers are
 * AES-256-GCM and bind tenant, secret id and purpose as additional authenticated data, so a ciphertext copied to
 * another row or purpose fails to decrypt. Rotation re-wraps data keys under a new KEK version without touching
 * the secret's ciphertext or exposing its plaintext.
 */
export class KeyRing {
	readonly #keys = new Map<number, Buffer>();
	constructor(
		master: Buffer | string,
		readonly current: number,
		versions: number[] = [current],
	) {
		const ikm = typeof master === "string" ? Buffer.from(master, "utf8") : master;
		if (ikm.length < 32) throw new Error("The master secret must be at least 32 bytes");
		for (const version of new Set([current, ...versions])) this.#keys.set(version, Buffer.from(hkdfSync("sha256", ikm, Buffer.from("pim-v2-kek"), Buffer.from(`pim/secrets/kek/v${version}`), 32)));
	}
	key(version: number): Buffer {
		const key = this.#keys.get(version);
		if (!key) throw new Error(`Key version ${version} is not available`);
		return key;
	}
}

const aad = (tenantId: string, secretId: string, purpose: string) => Buffer.from(`${tenantId}\u0000${secretId}\u0000${purpose}`);

function seal(key: Buffer, plaintext: Buffer, additional: Buffer): { nonce: Buffer; blob: Buffer } {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(additional);
	const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return { nonce, blob: Buffer.concat([cipher.getAuthTag(), body]) };
}

function open(key: Buffer, nonce: Buffer, blob: Buffer, additional: Buffer): Buffer {
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAAD(additional);
	decipher.setAuthTag(blob.subarray(0, 16));
	return Buffer.concat([decipher.update(blob.subarray(16)), decipher.final()]);
}

export async function putSecret(pool: pg.Pool, ring: KeyRing, input: { tenantId: string; secretId: string; purpose: string; value: string }): Promise<void> {
	const additional = aad(input.tenantId, input.secretId, input.purpose);
	const dek = randomBytes(32);
	const data = seal(dek, Buffer.from(input.value, "utf8"), additional);
	const wrapped = seal(ring.key(ring.current), dek, additional);
	await withTenant(pool, input.tenantId, (q) =>
		q.run(
			`INSERT INTO app.secrets (tenant_id, secret_id, purpose, key_version, wrapped_key, nonce, ciphertext) VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (tenant_id, secret_id) DO UPDATE SET purpose = excluded.purpose, key_version = excluded.key_version, wrapped_key = excluded.wrapped_key, nonce = excluded.nonce, ciphertext = excluded.ciphertext, rotated_at = now()`,
			input.tenantId,
			input.secretId,
			input.purpose,
			ring.current,
			Buffer.concat([wrapped.nonce, wrapped.blob]),
			data.nonce,
			data.blob,
		),
	);
}

export async function getSecret(pool: pg.Pool, ring: KeyRing, tenantId: string, secretId: string): Promise<string | undefined> {
	const row = await withTenant(pool, tenantId, (q) => q.get<{ purpose: string; key_version: number; wrapped_key: Buffer; nonce: Buffer; ciphertext: Buffer }>("SELECT purpose, key_version, wrapped_key, nonce, ciphertext FROM app.secrets WHERE tenant_id = $1 AND secret_id = $2", tenantId, secretId), { readOnly: true });
	if (row === undefined) return undefined;
	const additional = aad(tenantId, secretId, row.purpose);
	const dek = open(ring.key(row.key_version), row.wrapped_key.subarray(0, 12), row.wrapped_key.subarray(12), additional);
	return open(dek, row.nonce, row.ciphertext, additional).toString("utf8");
}

/** Re-wraps every secret's data key under the ring's current version. Returns how many moved. Plaintext never leaves this function's scope for any secret. */
export async function rotateSecrets(pool: pg.Pool, ring: KeyRing, tenantId: string): Promise<number> {
	return withTenant(pool, tenantId, async (q) => {
		const rows = await q.all<{ secret_id: string; purpose: string; key_version: number; wrapped_key: Buffer }>("SELECT secret_id, purpose, key_version, wrapped_key FROM app.secrets WHERE tenant_id = $1 AND key_version <> $2 FOR UPDATE", tenantId, ring.current);
		for (const row of rows) {
			const additional = aad(tenantId, row.secret_id, row.purpose);
			const dek = open(ring.key(row.key_version), row.wrapped_key.subarray(0, 12), row.wrapped_key.subarray(12), additional);
			const wrapped = seal(ring.key(ring.current), dek, additional);
			await q.run("UPDATE app.secrets SET key_version = $3, wrapped_key = $4, rotated_at = now() WHERE tenant_id = $1 AND secret_id = $2", tenantId, row.secret_id, ring.current, Buffer.concat([wrapped.nonce, wrapped.blob]));
		}
		return rows.length;
	});
}
