import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvelopeCrypto, keyringFromEnv, UnreadableError } from "../src/crypto.ts";

const key = () => new Uint8Array(randomBytes(32));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

describe("EnvelopeCrypto", () => {
	it("round-trips, binds a value to its context and purpose, and never repeats a ciphertext", () => {
		const c = new EnvelopeCrypto({ current: "v1", keys: { v1: key() } });
		const sealed = c.seal("connector-credential", '{"token":"gho_secret"}', "o_1/gmail");
		expect(sealed).not.toContain("gho_secret");
		expect(c.open(sealed, "o_1/gmail")).toBe('{"token":"gho_secret"}');
		expect(() => c.open(sealed, "o_2/gmail")).toThrow(UnreadableError); // moved to another owner
		expect(c.seal("connector-credential", "x", "c")).not.toBe(c.seal("connector-credential", "x", "c"));
		// A purpose is part of the key, so editing the tag to another purpose cannot open it.
		expect(() => c.open(sealed.replace(":connector-credential:", ":vault:"), "o_1/gmail")).toThrow(UnreadableError);
		expect(() => c.open(sealed.slice(0, -3) + "AAA", "o_1/gmail")).toThrow(UnreadableError);
	});

	it("rotates: old versions stay readable until re-sealed under the current one", () => {
		const k1 = key();
		const old = new EnvelopeCrypto({ current: "v1", keys: { v1: k1 } }).seal("provider-secret", "sk-live", "o_1/p");
		const c = new EnvelopeCrypto({ current: "v2", keys: { v1: k1, v2: key() } });
		expect(c.needsRotation(old)).toBe(true);
		expect(c.open(old, "o_1/p")).toBe("sk-live");
		const fresh = c.rotate(old, "o_1/p");
		expect(fresh.startsWith("pimenc:v2:provider-secret:")).toBe(true);
		expect(c.needsRotation(fresh)).toBe(false);
		// Once v1 is retired the old value is unreadable, and says so rather than returning garbage.
		expect(() => new EnvelopeCrypto({ current: "v2", keys: { v2: c["ring"].keys.v2! } }).open(old, "o_1/p")).toThrow(/not configured/);
	});

	it("reads keys from the environment", () => {
		const ring = keyringFromEnv({ PIM_KEYS: `v1:${b64(key())},v2:${b64(key())}`, PIM_KEY_CURRENT: "v2" });
		expect(ring.current).toBe("v2");
		expect(Object.keys(ring.keys)).toEqual(["v1", "v2"]);
	});

	it("opens what the Cloudflare build sealed with APP_CREDENTIALS_KEY and cookie_key, then re-seals it", () => {
		const appKey = randomBytes(32);
		const cookieKey = randomBytes(32);
		// Exactly what src/extensions/native-apps.ts wrote: sealed:v1:<iv>.<ct+tag>, AAD joined by newlines.
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", appKey, iv);
		cipher.setAAD(Buffer.from(["pim.app-credential.v1", "o_1", "conn1", "gmail", "credential"].join("\n")));
		const ct = Buffer.concat([cipher.update('{"refresh":"r"}'), cipher.final(), cipher.getAuthTag()]);
		const legacy = `sealed:v1:${b64(iv)}.${b64(ct)}`;
		// And a vault blob as packages/coding/src/vault/crypto.ts wrote it: format byte, nonce, ciphertext+tag under HKDF(cookie_key, "pim coding vault v1").
		const nonce = randomBytes(12);
		const vc = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", cookieKey, Buffer.alloc(0), Buffer.from("pim coding vault v1"), 32)), nonce);
		vc.setAAD(Buffer.from(JSON.stringify(["pim.coding-vault", 1, "o_1", "codex"])));
		const vault = Buffer.concat([Buffer.from([1]), nonce, vc.update("auth.json"), vc.final(), vc.getAuthTag()]);

		const c = new EnvelopeCrypto({ current: "v1", keys: { v1: key() } }, { appCredentialsKey: appKey.toString("base64url"), cookieKey: b64(cookieKey) });
		const binding = { kind: "app-credential", owner: "o_1", id: "conn1", app: "gmail", purpose: "credential" } as const;
		expect(c.openLegacy(legacy, binding)).toBe('{"refresh":"r"}');
		expect(() => c.openLegacy(legacy, { ...binding, owner: "o_2" })).toThrow(UnreadableError);
		expect(c.openLegacy(new Uint8Array(vault), { kind: "vault", owner: "o_1", harness: "codex" })).toBe("auth.json");
		expect(() => c.openLegacy(new Uint8Array(vault), { kind: "vault", owner: "o_1", harness: "amp" })).toThrow(UnreadableError);

		const resealed = c.rotate(legacy, "o_1/conn1", { binding, purpose: "connector-credential" });
		expect(resealed.startsWith("pimenc:v1:connector-credential:")).toBe(true);
		expect(c.open(resealed, "o_1/conn1")).toBe('{"refresh":"r"}');
		// Without the legacy keys configured, legacy values are unreadable, not misread.
		expect(() => new EnvelopeCrypto({ current: "v1", keys: { v1: key() } }).openLegacy(legacy, binding)).toThrow(UnreadableError);
	});
});
