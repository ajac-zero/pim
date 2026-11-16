import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** The prefix src/extensions/native-apps.ts gives a credential it sealed under APP_CREDENTIALS_KEY. */
export const LEGACY_PREFIX = "sealed:v1:";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** What a sealed native-app credential is bound to (`NativeApps.#binding`): the space, the connection, the connector and the purpose. */
export const legacyBinding = (owner: string, id: string, app: string, purpose: string) => Buffer.from(["pim.app-credential.v1", owner, id, app, purpose].join("\n"));

/** Reads an APP_CREDENTIALS_KEY value (base64 or base64url, any padding) into its 32 bytes. */
export function decodeCredentialsKey(raw: string): Buffer {
	const bytes = Buffer.from(raw.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64url");
	if (bytes.length !== 32) throw new Error("APP_CREDENTIALS_KEY must be 32 bytes");
	return bytes;
}

/** Opens a credential the legacy Worker sealed: `sealed:v1:<iv>.<ciphertext+tag>` (AES-256-GCM), or plain JSON when it was never sealed. */
export function openLegacyCredential(stored: string, key: Buffer, binding: Buffer): string {
	if (!stored.startsWith(LEGACY_PREFIX)) return stored;
	const [iv = "", sealed = ""] = stored.slice(LEGACY_PREFIX.length).split(".");
	const body = Buffer.from(sealed, "base64url");
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
	decipher.setAAD(binding);
	decipher.setAuthTag(body.subarray(body.length - 16));
	return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
}

/** Seals a credential exactly as the legacy Worker does; used to build fixtures and to prove the reader matches. */
export function sealLegacyCredential(json: string, key: Buffer, binding: Buffer): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(binding);
	const body = Buffer.concat([cipher.update(json, "utf8"), cipher.final(), cipher.getAuthTag()]);
	return `${LEGACY_PREFIX}${b64(iv)}.${b64(body)}`;
}

/** The coding vault's AES key: HKDF-SHA256 over the Directory's `cookie_key`, empty salt, label "pim coding vault v1" (packages/coding/src/vault/crypto.ts). */
export const vaultKeyFromCookieKey = (cookieKey: Buffer): Buffer => Buffer.from(hkdfSync("sha256", cookieKey, new Uint8Array(0), "pim coding vault v1", 32));

/** Opens a vault blob `[format byte][12-byte nonce][ciphertext+tag]` bound to a person and harness. */
export function openLegacyVaultBlob(blob: Buffer, key: Buffer, userId: string, harness: string): Buffer {
	const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(1, 13));
	decipher.setAAD(Buffer.from(JSON.stringify(["pim.coding-vault", blob[0], userId, harness])));
	const body = blob.subarray(13);
	decipher.setAuthTag(body.subarray(body.length - 16));
	return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
}

export function sealLegacyVaultBlob(plaintext: Buffer, key: Buffer, userId: string, harness: string): Buffer {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(Buffer.from(JSON.stringify(["pim.coding-vault", 1, userId, harness])));
	return Buffer.concat([Buffer.from([1]), nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
