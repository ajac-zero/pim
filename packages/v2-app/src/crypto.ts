import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Versioned envelope encryption. A value is sealed with AES-256-GCM under a key derived (HKDF-SHA256) from one master key
 * per version and per purpose, so a key used for connector credentials never opens a vault entry. The version tag in the value
 * lets the master key rotate: new values use the current version, old ones open under theirs until `rotate` re-seals them.
 *
 *   pimenc:<keyVersion>:<purpose>:<iv>.<ciphertext+tag>     (base64url)
 *
 * The additional data binds a value to its purpose and a caller-given context (owner, row id), so a value moved to another row fails to open.
 * Values sealed by the Cloudflare build open through `LegacyKeys` until they are re-sealed.
 */
export type Purpose = "connector-credential" | "provider-secret" | "vault" | "oauth-client-secret" | "webhook-signing" | "computer-token";

export class UnreadableError extends Error {
	constructor(message = "This value cannot be read: its key is missing or it was altered") {
		super(message);
		this.name = "UnreadableError";
	}
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));
const PREFIX = "pimenc:";

export type Keyring = { readonly current: string; readonly keys: Readonly<Record<string, Uint8Array>> };

/** The keys a Cloudflare deployment used, so what it sealed stays readable: `APP_CREDENTIALS_KEY` and the Directory's `cookie_key`. */
export type LegacyKeys = { readonly appCredentialsKey?: string; readonly cookieKey?: string };

function aead(purpose: string, context: string): Buffer {
	return Buffer.from(`pim.envelope.v1\n${purpose}\n${context}`);
}

export class EnvelopeCrypto {
	constructor(
		private readonly ring: Keyring,
		private readonly legacy: LegacyKeys = {},
	) {
		if (!ring.keys[ring.current]) throw new Error("The current key version is not in the keyring");
		for (const [version, key] of Object.entries(ring.keys)) if (key.length !== 32 || /[:.]/.test(version)) throw new Error(`Key ${version} must be 32 bytes with a plain version name`);
	}

	#derive(version: string, purpose: string): Buffer {
		const master = this.ring.keys[version];
		if (!master) throw new UnreadableError(`Key version ${version} is not configured`);
		return Buffer.from(hkdfSync("sha256", master, Buffer.from("pim.envelope"), Buffer.from(purpose), 32));
	}

	seal(purpose: Purpose, plaintext: string, context: string): string {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.#derive(this.ring.current, purpose), iv);
		cipher.setAAD(aead(purpose, context));
		const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
		return `${PREFIX}${this.ring.current}:${purpose}:${b64(iv)}.${b64(body)}`;
	}

	open(sealed: string, context: string): string {
		if (!sealed.startsWith(PREFIX)) throw new UnreadableError("Not an envelope value");
		const [version = "", purpose = "", rest = ""] = sealed.slice(PREFIX.length).split(":");
		const [iv = "", body = ""] = rest.split(".");
		try {
			const data = unb64(body);
			const decipher = createDecipheriv("aes-256-gcm", this.#derive(version, purpose), unb64(iv));
			decipher.setAAD(aead(purpose, context));
			decipher.setAuthTag(data.subarray(data.length - 16));
			return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
		} catch (error) {
			throw error instanceof UnreadableError ? error : new UnreadableError();
		}
	}

	/** Whether a value is under an old key version or a legacy format and should be re-sealed. */
	needsRotation(sealed: string): boolean {
		return !sealed.startsWith(`${PREFIX}${this.ring.current}:`);
	}

	/** Re-seals under the current key. */
	rotate(sealed: string, context: string, legacy?: { binding: LegacyContext; purpose: Purpose }): string {
		if (sealed.startsWith(PREFIX)) return this.seal(sealed.slice(PREFIX.length).split(":")[1] as Purpose, this.open(sealed, context), context);
		if (!legacy) throw new UnreadableError("A legacy value needs its binding to be re-sealed");
		return this.seal(legacy.purpose, this.openLegacy(sealed, legacy.binding), context);
	}

	/** Opens a value the Cloudflare build sealed: native-app credentials (`sealed:v1:`, `APP_CREDENTIALS_KEY`) or a coding vault blob (cookie_key). */
	openLegacy(sealed: string | Uint8Array, binding?: LegacyContext): string {
		try {
			if (typeof sealed === "string" && sealed.startsWith("sealed:v1:")) {
				if (!this.legacy.appCredentialsKey || binding?.kind !== "app-credential") throw new UnreadableError();
				const key = unb64(this.legacy.appCredentialsKey.trim());
				const [iv = "", body = ""] = sealed.slice("sealed:v1:".length).split(".");
				const data = unb64(body);
				const decipher = createDecipheriv("aes-256-gcm", key, unb64(iv));
				decipher.setAAD(Buffer.from(["pim.app-credential.v1", binding.owner, binding.id, binding.app, binding.purpose].join("\n")));
				decipher.setAuthTag(data.subarray(data.length - 16));
				return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
			}
			if (typeof sealed !== "string") {
				if (!this.legacy.cookieKey || binding?.kind !== "vault") throw new UnreadableError();
				const key = Buffer.from(hkdfSync("sha256", unb64(this.legacy.cookieKey), Buffer.alloc(0), Buffer.from("pim coding vault v1"), 32));
				const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
				decipher.setAAD(Buffer.from(JSON.stringify(["pim.coding-vault", sealed[0], binding.owner, binding.harness])));
				decipher.setAuthTag(sealed.subarray(sealed.length - 16));
				return Buffer.concat([decipher.update(sealed.subarray(13, sealed.length - 16)), decipher.final()]).toString("utf8");
			}
		} catch (error) {
			throw error instanceof UnreadableError ? error : new UnreadableError();
		}
		throw new UnreadableError("Not a legacy value");
	}
}

export type LegacyContext =
	| { kind: "app-credential"; owner: string; id: string; app: string; purpose: string }
	| { kind: "vault"; owner: string; harness: string };

/** Reads a keyring from the environment: `PIM_KEYS` as `v1:<base64>,v2:<base64>` with `PIM_KEY_CURRENT` naming the one to seal under. */
export function keyringFromEnv(env: Record<string, string | undefined>): Keyring {
	const keys: Record<string, Uint8Array> = {};
	for (const entry of (env.PIM_KEYS ?? "").split(",").filter(Boolean)) {
		const [version = "", value = ""] = entry.split(":");
		keys[version] = unb64(value);
	}
	return { current: env.PIM_KEY_CURRENT ?? Object.keys(keys).at(-1) ?? "", keys };
}
