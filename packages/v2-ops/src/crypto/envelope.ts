import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

/** A sealed value: its data key wrapped under a named key-encryption key, the data under the data key. */
export type Envelope = {
	readonly v: 1;
	/** Which key-encryption key wrapped the data key, so rotation can find what to rewrap. */
	readonly kek: string;
	readonly wrappedDek: string;
	readonly iv: string;
	readonly ciphertext: string;
};

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url");

function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): { iv: Buffer; sealed: Buffer } {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(aad);
	const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return { iv, sealed: Buffer.concat([body, cipher.getAuthTag()]) };
}

function open(key: Uint8Array, iv: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer {
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAAD(aad);
	decipher.setAuthTag(Buffer.from(sealed.subarray(sealed.length - 16)));
	return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}

/**
 * Envelope encryption with AES-256-GCM: every value gets its own random data key, wrapped under a key-encryption
 * key that a deployment supplies from OpenBao, a Kubernetes Secret or an environment file. The binding (tenant,
 * name, purpose) is authenticated as additional data on both layers, so a sealed value moved to another tenant or
 * name fails to open.
 */
export class EnvelopeCrypto {
	readonly #keks = new Map<string, Buffer>();
	readonly #current: string;

	constructor(keks: Readonly<Record<string, Uint8Array>>, current: string) {
		for (const [id, key] of Object.entries(keks)) {
			if (key.length !== 32) throw new Error(`Key-encryption key ${id} must be 32 bytes`);
			this.#keks.set(id, Buffer.from(key));
		}
		if (!this.#keks.has(current)) throw new Error(`Current key-encryption key ${current} is not in the key ring`);
		this.#current = current;
	}

	seal(plaintext: Uint8Array, binding: readonly string[]): Envelope {
		const aad = Buffer.from(JSON.stringify(["pim.envelope.v1", ...binding]));
		const dek = randomBytes(32);
		const wrapped = seal(this.#keks.get(this.#current)!, dek, aad);
		const data = seal(dek, plaintext, aad);
		return { v: 1, kek: this.#current, wrappedDek: b64(Buffer.concat([wrapped.iv, wrapped.sealed])), iv: b64(data.iv), ciphertext: b64(data.sealed) };
	}

	open(envelope: Envelope, binding: readonly string[]): Buffer {
		const kek = this.#keks.get(envelope.kek);
		if (kek === undefined) throw new Error(`Key-encryption key ${envelope.kek} is not in the key ring`);
		const aad = Buffer.from(JSON.stringify(["pim.envelope.v1", ...binding]));
		const wrapped = unb64(envelope.wrappedDek);
		const dek = open(kek, wrapped.subarray(0, 12), wrapped.subarray(12), aad);
		return open(dek, unb64(envelope.iv), unb64(envelope.ciphertext), aad);
	}
}

/** A short public fingerprint of a key, for reports and backups: it names the key without revealing it. */
export const keyFingerprint = (key: Uint8Array) => createHash("sha256").update("pim.key-fingerprint.v1").update(key).digest("hex").slice(0, 16);

/** Seals a key bundle under a passphrase (scrypt + AES-256-GCM): the original-key backup a cutover keeps. */
export function sealWithPassphrase(plaintext: Uint8Array, passphrase: string): string {
	const salt = randomBytes(16);
	const key = scryptSync(passphrase, salt, 32);
	const { iv, sealed } = seal(new Uint8Array(key), plaintext, Buffer.from("pim.key-backup.v1"));
	return JSON.stringify({ v: 1, kdf: "scrypt", salt: b64(salt), iv: b64(iv), ciphertext: b64(sealed) });
}

export function openWithPassphrase(text: string, passphrase: string): Buffer {
	const parsed = JSON.parse(text) as { salt: string; iv: string; ciphertext: string };
	const key = scryptSync(passphrase, unb64(parsed.salt), 32);
	return open(new Uint8Array(key), unb64(parsed.iv), unb64(parsed.ciphertext), Buffer.from("pim.key-backup.v1"));
}
