import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KeyringCrypto, keyringFromEnv, legacyAppCredential, legacyVaultBlob, UnreadableError } from "../src/crypto.ts";

const key = () => new Uint8Array(randomBytes(32));
const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");
const bytes = (s: string) => new Uint8Array(Buffer.from(s));

describe("KeyringCrypto", () => {
	it("round-trips, binds a value to its context, and never repeats a ciphertext", async () => {
		const c = new KeyringCrypto("k1", { k1: key() });
		const sealed = await c.seal(bytes('{"token":"gho_secret"}'), "connector:o_1/gmail");
		expect(Buffer.from(sealed.ciphertext).includes(Buffer.from("gho_secret"))).toBe(false);
		expect(text(await c.open(sealed, "connector:o_1/gmail"))).toBe('{"token":"gho_secret"}');
		await expect(c.open(sealed, "connector:o_2/gmail")).rejects.toBeInstanceOf(UnreadableError); // moved to another owner
		const again = await c.seal(bytes("x"), "c");
		expect(Buffer.from(again.ciphertext).equals(Buffer.from((await c.seal(bytes("x"), "c")).ciphertext))).toBe(false);
		const tampered = { ...sealed, ciphertext: Uint8Array.from(sealed.ciphertext, (b, i) => (i === sealed.ciphertext.length - 1 ? b ^ 1 : b)) };
		await expect(c.open(tampered, "connector:o_1/gmail")).rejects.toBeInstanceOf(UnreadableError);
		// A wrapped data key is bound to the context too: swapping the data part under another context's wrap fails.
		const other = await c.seal(bytes("y"), "other");
		const spliced = { ...sealed, ciphertext: Uint8Array.from([...other.ciphertext.subarray(0, 60), ...sealed.ciphertext.subarray(60)]) };
		await expect(c.open(spliced, "connector:o_1/gmail")).rejects.toBeInstanceOf(UnreadableError);
	});

	it("rotates: old keys stay readable until values are re-sealed under the current key", async () => {
		const k1 = key();
		const old = await new KeyringCrypto("k1", { k1 }).seal(bytes("sk-live"), "provider:o_1/p");
		const c = new KeyringCrypto("k2", { k1, k2: key() });
		expect(c.needsRotation(old)).toBe(true);
		expect(text(await c.open(old, "provider:o_1/p"))).toBe("sk-live");
		const fresh = await c.rotate(old, "provider:o_1/p");
		expect(fresh.keyId).toBe("k2");
		expect(c.needsRotation(fresh)).toBe(false);
		expect(await c.rotate(fresh, "provider:o_1/p")).toBe(fresh);
		// Once k1 is retired the old value is unreadable, and says so rather than returning garbage.
		await expect(new KeyringCrypto("k2", { k2: key() }).open(old, "provider:o_1/p")).rejects.toBeInstanceOf(UnreadableError);
	});

	it("reads its keyring from the environment", async () => {
		const k = Buffer.from(key()).toString("base64url");
		const c = keyringFromEnv({ PIM_KEYS: `a:${k},b:${Buffer.from(key()).toString("base64url")}`, PIM_KEY_CURRENT: "b" });
		expect((await c.seal(bytes("v"), "c")).keyId).toBe("b");
	});

	it("opens what the Cloudflare build sealed with APP_CREDENTIALS_KEY and cookie_key, then re-seals it under a v2 key", async () => {
		const appKey = randomBytes(32);
		const cookieKey = randomBytes(32);
		// Exactly what src/extensions/native-apps.ts wrote: sealed:v1:<iv>.<ct+tag>, additional data joined by newlines.
		const aad = ["pim.app-credential.v1", "o_1", "conn1", "gmail", "credential"].join("\n");
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", appKey, iv);
		cipher.setAAD(Buffer.from(aad));
		const ct = Buffer.concat([cipher.update('{"refresh":"r"}'), cipher.final(), cipher.getAuthTag()]);
		const legacy = `sealed:v1:${iv.toString("base64url")}.${ct.toString("base64url")}`;
		// And a vault blob as packages/coding/src/vault/crypto.ts wrote it: format byte, nonce, ciphertext and tag under HKDF(cookie_key, "pim coding vault v1").
		const nonce = randomBytes(12);
		const vaultAad = JSON.stringify(["pim.coding-vault", 1, "o_1", "codex"]);
		const vc = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", cookieKey, Buffer.alloc(0), Buffer.from("pim coding vault v1"), 32)), nonce);
		vc.setAAD(Buffer.from(vaultAad));
		const vault = new Uint8Array(Buffer.concat([Buffer.from([1]), nonce, vc.update("auth.json"), vc.final(), vc.getAuthTag()]));

		const c = new KeyringCrypto("v2-1", { "v2-1": key() });
		await c.importLegacyKey({ kind: "legacy-app-credentials" }, appKey);
		await c.importLegacyKey({ kind: "legacy-cookie-key", purpose: "vault" }, cookieKey);
		expect(text(await c.open(legacyAppCredential(legacy), aad))).toBe('{"refresh":"r"}');
		await expect(c.open(legacyAppCredential(legacy), aad.replace("o_1", "o_2"))).rejects.toBeInstanceOf(UnreadableError);
		expect(text(await c.open(legacyVaultBlob(vault), vaultAad))).toBe("auth.json");
		await expect(c.open(legacyVaultBlob(vault), vaultAad.replace("codex", "amp"))).rejects.toBeInstanceOf(UnreadableError);
		// Token-signing keys derived from cookie_key seal nothing, so importing them as an encryption key is refused.
		await expect(c.importLegacyKey({ kind: "legacy-cookie-key", purpose: "gateway" }, cookieKey)).rejects.toBeInstanceOf(UnreadableError);

		const migrated = await c.rotate(legacyAppCredential(legacy), aad);
		expect(migrated.keyId).toBe("v2-1");
		expect(text(await c.open(migrated, aad))).toBe('{"refresh":"r"}');
		// Without the legacy keys imported, legacy values are unreadable, not misread.
		await expect(new KeyringCrypto("v2-1", { "v2-1": key() }).open(legacyAppCredential(legacy), aad)).rejects.toBeInstanceOf(UnreadableError);
	});
});
