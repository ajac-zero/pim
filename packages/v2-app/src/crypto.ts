import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { EnvelopeCrypto, KeySource, Sealed } from "@pim/v2-contracts/platform";

export class UnreadableError extends Error {
	constructor(message = "This value cannot be read: its key is missing or it was altered") {
		super(message);
		this.name = "UnreadableError";
	}
}

/** What the Cloudflare build derived its AES keys from `cookie_key` with (HKDF-SHA256, empty salt, this label). The git broker and gateway keys sign tokens and seal nothing. */
const COOKIE_KEY_LABELS: Partial<Record<Extract<KeySource, { kind: "legacy-cookie-key" }>["purpose"], string>> = { vault: "pim coding vault v1", gitea: "pim gitea connection v1" };

const FORMAT = 1;
const TAG = 16;
const WRAPPED = 12 + 32 + TAG; // wrap nonce, the 32-byte data key, its tag

function gcm(key: Uint8Array, nonce: Uint8Array, context: Uint8Array, data: Uint8Array, mode: "seal" | "open"): Uint8Array {
	if (mode === "seal") {
		const c = createCipheriv("aes-256-gcm", key, nonce);
		c.setAAD(context);
		return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
	}
	const d = createDecipheriv("aes-256-gcm", key, nonce);
	d.setAAD(context);
	d.setAuthTag(data.subarray(data.length - TAG));
	return Buffer.concat([d.update(data.subarray(0, data.length - TAG)), d.final()]);
}

/**
 * Envelope encryption over a keyring. Each value gets its own random data key, which encrypts it (AES-256-GCM, context as additional data);
 * the data key is wrapped under the current key-encryption key. `keyId` names that key, so rotation adds a key, seals new values under it,
 * and `rotate` re-seals old ones. Zero plaintext is kept anywhere.
 *
 * Sealed layout: `nonce` is the value's nonce; `ciphertext` is the wrap nonce, the wrapped data key, then the value's ciphertext and tag.
 * Values the Cloudflare build sealed stay readable through `importLegacyKey`: a legacy `Sealed` carries the old nonce and ciphertext
 * as they were stored, and `context` is the old additional data verbatim.
 */
export class KeyringCrypto implements EnvelopeCrypto {
	readonly #keys = new Map<string, Uint8Array>();
	readonly #legacy = new Map<string, Uint8Array>();

	constructor(private readonly currentKeyId: string, keys: Readonly<Record<string, Uint8Array>>) {
		for (const [id, key] of Object.entries(keys)) {
			if (key.length !== 32 || id.startsWith("legacy-")) throw new Error(`Key ${id} must be 32 bytes and not named legacy-*`);
			this.#keys.set(id, key);
		}
		if (!this.#keys.has(currentKeyId)) throw new Error("The current key is not in the keyring");
	}

	async seal(plaintext: Uint8Array, context: string): Promise<Sealed> {
		const dataKey = randomBytes(32);
		const nonce = randomBytes(12);
		const wrapNonce = randomBytes(12);
		const ad = Buffer.from(context);
		const wrapped = gcm(this.#keys.get(this.currentKeyId)!, wrapNonce, Buffer.from(`wrap\n${context}`), dataKey, "seal");
		const body = gcm(dataKey, nonce, ad, plaintext, "seal");
		return { keyId: this.currentKeyId, version: FORMAT, nonce, ciphertext: Buffer.concat([wrapNonce, wrapped, body]) };
	}

	async open(sealed: Sealed, context: string): Promise<Uint8Array> {
		try {
			const legacy = this.#legacy.get(sealed.keyId);
			if (sealed.keyId.startsWith("legacy-")) {
				if (!legacy) throw new UnreadableError("That legacy key is not imported");
				return new Uint8Array(gcm(legacy, sealed.nonce, Buffer.from(context), sealed.ciphertext, "open"));
			}
			const kek = this.#keys.get(sealed.keyId);
			if (!kek) throw new UnreadableError(`Key ${sealed.keyId} is not in the keyring`);
			const wrapNonce = sealed.ciphertext.subarray(0, 12);
			const dataKey = gcm(kek, wrapNonce, Buffer.from(`wrap\n${context}`), sealed.ciphertext.subarray(12, 12 + WRAPPED - 12), "open");
			return new Uint8Array(gcm(dataKey, sealed.nonce, Buffer.from(context), sealed.ciphertext.subarray(WRAPPED), "open"));
		} catch (error) {
			throw error instanceof UnreadableError ? error : new UnreadableError();
		}
	}

	async rotate(sealed: Sealed, context: string): Promise<Sealed> {
		if (sealed.keyId === this.currentKeyId) return sealed;
		return this.seal(await this.open(sealed, context), context);
	}

	async importLegacyKey(source: KeySource, secret: Uint8Array): Promise<string> {
		if (source.kind === "v2") {
			if (secret.length !== 32) throw new Error("A key is 32 bytes");
			this.#keys.set(source.keyId, secret);
			return source.keyId;
		}
		if (source.kind === "legacy-app-credentials") {
			if (secret.length !== 32) throw new Error("APP_CREDENTIALS_KEY must be 32 bytes");
			this.#legacy.set("legacy-app-credentials", secret);
			return "legacy-app-credentials";
		}
		const label = COOKIE_KEY_LABELS[source.purpose];
		if (!label) throw new UnreadableError(`${source.purpose} keys sign tokens; there is nothing sealed under them to open`);
		const id = `legacy-cookie-key:${source.purpose}`;
		this.#legacy.set(id, new Uint8Array(hkdfSync("sha256", secret, Buffer.alloc(0), Buffer.from(label), 32)));
		return id;
	}

	/** Whether `sealed` should be passed through `rotate`: it is under an old or legacy key. */
	needsRotation(sealed: Sealed): boolean {
		return sealed.keyId !== this.currentKeyId;
	}
}

/** The stored string `sealed:v1:<iv>.<ciphertext+tag>` of a native-app credential, as a `Sealed` for `open` with context the old additional data (`pim.app-credential.v1`, owner, connection, connector and purpose, newline-joined). */
export function legacyAppCredential(stored: string): Sealed {
	const [iv = "", body = ""] = stored.slice("sealed:v1:".length).split(".");
	return { keyId: "legacy-app-credentials", version: 0, nonce: new Uint8Array(Buffer.from(iv, "base64url")), ciphertext: new Uint8Array(Buffer.from(body, "base64url")) };
}

/** A coding vault blob (format byte, 12-byte nonce, ciphertext and tag) as a `Sealed`; the context is the old additional data, `JSON.stringify(["pim.coding-vault", format, owner, harness])`. */
export function legacyVaultBlob(blob: Uint8Array): Sealed {
	return { keyId: "legacy-cookie-key:vault", version: blob[0]!, nonce: blob.slice(1, 13), ciphertext: blob.slice(13) };
}

/** Reads a keyring from the environment: `PIM_KEYS` as `id:<base64url>,id:<base64url>` with `PIM_KEY_CURRENT` naming the one to seal under. */
export function keyringFromEnv(env: Record<string, string | undefined>): KeyringCrypto {
	const keys: Record<string, Uint8Array> = {};
	for (const entry of (env.PIM_KEYS ?? "").split(",").filter(Boolean)) {
		const [id = "", value = ""] = entry.split(":");
		keys[id] = new Uint8Array(Buffer.from(value, "base64url"));
	}
	const current = env.PIM_KEY_CURRENT ?? Object.keys(keys).at(-1) ?? "";
	return new KeyringCrypto(current, keys);
}
