import type { Harness } from "./harnesses";

/**
 * How the vault (./vault.ts) encrypts an archive: AES-256-GCM with a random
 * 96-bit nonce, under a key derived by HKDF-SHA256 from the Directory's own
 * key with a label of the vault's own, so it is independent of the cookie
 * and git broker keys made from the same secret. The additional data binds
 * a sealed blob to its format, its person and its harness, so a blob moved
 * to another person or harness, or edited, fails to open.
 *
 * A sealed blob is the format byte, the nonce, then the ciphertext with its
 * 16-byte tag.
 */

export const VAULT_FORMAT = 1;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
/** The bytes a sealed blob adds to its plaintext. */
export const SEAL_OVERHEAD = 1 + NONCE_BYTES + TAG_BYTES;

const KEY_INFO = "pim coding vault v1";
const encoder = new TextEncoder();

/** Whose and which a blob is: the person's owner id and the harness. */
export type VaultBinding = { readonly userId: string; readonly harness: Harness };

/** A sealed blob that does not open: tampered with, made for another person or harness, or under another key. */
export class VaultUnreadableError extends Error {
	constructor(message = "This vault entry can't be read: sign the harness in again") {
		super(message);
		this.name = "VaultUnreadableError";
	}
}

/** The vault's AES-GCM key, derived from `secret` (the Directory's key). */
export async function vaultKey(secret: Uint8Array): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(KEY_INFO) },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

function additionalData(format: number, { userId, harness }: VaultBinding): Uint8Array {
	if (typeof userId !== "string" || userId === "") throw new Error("A vault entry needs its person's id");
	return encoder.encode(JSON.stringify(["pim.coding-vault", format, userId, harness]));
}

/** Encrypts an archive for one person and harness. */
export async function sealBlob(key: CryptoKey, binding: VaultBinding, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: additionalData(VAULT_FORMAT, binding) }, key, plaintext as BufferSource),
	);
	const out = new Uint8Array(1 + NONCE_BYTES + sealed.byteLength);
	out[0] = VAULT_FORMAT;
	out.set(nonce, 1);
	out.set(sealed, 1 + NONCE_BYTES);
	return out;
}

/** Decrypts a blob `sealBlob` made for the same person and harness, or throws `VaultUnreadableError`. */
export async function openBlob(key: CryptoKey, binding: VaultBinding, sealed: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	if (sealed.byteLength < SEAL_OVERHEAD) throw new VaultUnreadableError();
	const format = sealed[0]!;
	if (format !== VAULT_FORMAT) throw new VaultUnreadableError("This vault entry's format is not one Pim reads: sign the harness in again");
	try {
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: sealed.slice(1, 1 + NONCE_BYTES), additionalData: additionalData(format, binding) },
				key,
				sealed.slice(1 + NONCE_BYTES),
			),
		);
	} catch {
		throw new VaultUnreadableError();
	}
}
