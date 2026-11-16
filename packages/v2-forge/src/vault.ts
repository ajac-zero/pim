// The coding credential vault on PostgreSQL. Entries are sealed with the contracts' `EnvelopeCrypto`, bound to their person and harness, and only ever stored as ciphertext;
// reads are cached 30 seconds with singleflight and invalidated by writes (`CachingVaultBackend`, PR #29). A stale write is refused by its version.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { type ArchiveFile, packArchive, unpackArchive, ArchiveError } from "@pim/coding/vault/archive";
import { CachingVaultBackend } from "@pim/coding/vault/read-cache";
import type { VaultRecord, VaultStatus, VaultWriteResult } from "@pim/coding/vault/store";
import { ApiKeyError, CodingVault, type VaultBackend, type VaultEntry } from "@pim/coding/vault/vault";
import { apiKeyProblem, type ApiKeyHarness, type CodingVaultKey, HARNESS_FILES, HARNESSES, type Harness, isApiKeyHarness, isLoginHarness, type LoginHarness } from "@pim/shared/harnesses";
import type { EnvelopeCrypto, KeySource, Sealed } from "@pim/v2-contracts/platform";
import { type Db, type Row } from "./db";

export { ApiKeyError };

/** The largest sealed entry (an archive of the CLI's files, sealed). */
export const MAX_SEALED_BYTES = 512 * 1024 + 4096;

export class PgVaultBackend implements VaultBackend {
	constructor(
		private readonly db: Db,
		private readonly now: () => number = Date.now,
	) {}

	private static status(harness: Harness, r: Row | undefined): VaultStatus {
		const connected = !!r?.sealed;
		return { harness, connected, updatedAt: r ? new Date(r.updated_at).getTime() : null, byteLength: connected ? Number(r!.byte_length) : null, version: r ? r.version : 0 };
	}

	async status(userId: string): Promise<VaultStatus[]> {
		const rows = (await this.db.query<Row>("select * from pim_forge.forge_vault where owner_id = $1", [userId])).rows;
		return HARNESSES.map((h) => PgVaultBackend.status(h, rows.find((r) => r.harness === h)));
	}

	async read(userId: string, harness: CodingVaultKey): Promise<VaultRecord> {
		const r = (await this.db.query<Row>("select version, sealed from pim_forge.forge_vault where owner_id = $1 and harness = $2", [userId, harness])).rows[0];
		return { version: r?.version ?? 0, sealed: r?.sealed ? new Uint8Array(r.sealed) : null };
	}

	/** Compare-and-set on the version, in one statement, so two writers from the same version can't both win. */
	async write(userId: string, harness: CodingVaultKey, sealed: Uint8Array, byteLength: number, expectedVersion: number): Promise<VaultWriteResult> {
		if (sealed.byteLength > MAX_SEALED_BYTES) throw new Error(`A vault entry holds at most ${MAX_SEALED_BYTES} bytes`);
		const r =
			expectedVersion === 0
				? await this.db.query<Row>("insert into pim_forge.forge_vault (owner_id, harness, version, sealed, byte_length) values ($1,$2,1,$3,$4) on conflict do nothing returning version", [userId, harness, Buffer.from(sealed), byteLength])
				: await this.db.query<Row>("update pim_forge.forge_vault set version = version + 1, sealed = $3, byte_length = $4, updated_at = now() where owner_id = $1 and harness = $2 and version = $5 returning version", [userId, harness, Buffer.from(sealed), byteLength, expectedVersion]);
		if (r.rows[0]) return { ok: true, version: r.rows[0].version };
		return { ok: false, version: (await this.read(userId, harness)).version };
	}

	/** Disconnecting keeps the row without its blob and moves the version on, so a write based on the deleted login is refused too. */
	async delete(userId: string, harness: Harness): Promise<VaultStatus> {
		await this.db.query("update pim_forge.forge_vault set sealed = null, byte_length = null, version = version + 1, updated_at = now() where owner_id = $1 and harness = $2 and sealed is not null", [userId, harness]);
		return (await this.status(userId)).find((s) => s.harness === harness)!;
	}
}

/** A reference EnvelopeCrypto: AES-256-GCM under named master keys, the context as authenticated data, rotation to the current key. A deployment wires its KMS-backed one in its place. */
export class LocalEnvelopeCrypto implements EnvelopeCrypto {
	private readonly keys = new Map<string, Buffer>();
	constructor(
		private current: { keyId: string; key: Buffer },
	) {
		this.keys.set(current.keyId, current.key);
	}
	async seal(plaintext: Uint8Array, context: string): Promise<Sealed> {
		const nonce = randomBytes(12);
		const c = createCipheriv("aes-256-gcm", this.current.key, nonce);
		c.setAAD(Buffer.from(context));
		const ciphertext = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
		return { keyId: this.current.keyId, version: 1, nonce, ciphertext };
	}
	async open(sealed: Sealed, context: string): Promise<Uint8Array> {
		const key = this.keys.get(sealed.keyId);
		if (!key) throw new Error(`Unknown key ${sealed.keyId}`);
		const d = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce));
		d.setAAD(Buffer.from(context));
		d.setAuthTag(Buffer.from(sealed.ciphertext.subarray(sealed.ciphertext.length - 16)));
		return Buffer.concat([d.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16)), d.final()]);
	}
	async rotate(sealed: Sealed, context: string): Promise<Sealed> {
		return this.seal(await this.open(sealed, context), context);
	}
	async importLegacyKey(source: KeySource, secret: Uint8Array): Promise<string> {
		const id = source.kind === "legacy-cookie-key" ? `legacy-${source.purpose}` : source.kind;
		this.keys.set(id, Buffer.from(secret));
		return id;
	}
}

const encodeSealed = (s: Sealed): Uint8Array => new TextEncoder().encode(JSON.stringify({ k: s.keyId, v: s.version, n: Buffer.from(s.nonce).toString("base64"), c: Buffer.from(s.ciphertext).toString("base64") }));
const decodeSealed = (b: Uint8Array): Sealed => {
	const j = JSON.parse(new TextDecoder().decode(b));
	return { keyId: j.k, version: j.v, nonce: Buffer.from(j.n, "base64"), ciphertext: Buffer.from(j.c, "base64") };
};
const context = (userId: string, harness: string) => `pim forge vault v1\n${userId}\n${harness}`;

/** The vault as the vendor CLI runner and the HTTP routes use it. It is a `CodingVault`, so `restoreHarnessCredentials` takes it as it is. */
export class ForgeVault extends CodingVault {
	readonly cache: CachingVaultBackend;

	constructor(
		db: Db,
		private readonly crypto: EnvelopeCrypto,
		now: () => number = Date.now,
	) {
		const cache = new CachingVaultBackend(new PgVaultBackend(db, now), undefined, undefined, now);
		super(cache, async () => { throw new Error("ForgeVault seals with EnvelopeCrypto"); }, now);
		this.cache = cache;
	}

	private async openRaw(userId: string, harness: CodingVaultKey, fresh = false): Promise<{ version: number; plaintext: Uint8Array | null; unreadable: boolean }> {
		const rec = await this.backend.read(userId, harness, fresh ? { fresh: true } : undefined);
		if (rec.sealed === null) return { version: rec.version, plaintext: null, unreadable: false };
		try {
			return { version: rec.version, plaintext: await this.crypto.open(decodeSealed(rec.sealed), context(userId, harness)), unreadable: false };
		} catch {
			// Tampered with, another person's or harness's, or sealed under a key this Forge no longer has: as good as none.
			return { version: rec.version, plaintext: null, unreadable: true };
		}
	}

	private async sealRaw(userId: string, harness: CodingVaultKey, plaintext: Uint8Array, expectedVersion: number): Promise<VaultWriteResult> {
		const sealed = encodeSealed(await this.crypto.seal(plaintext, context(userId, harness)));
		return this.backend.write(userId, harness, sealed, plaintext.byteLength, expectedVersion);
	}

	override async load(userId: string, harness: LoginHarness): Promise<VaultEntry> {
		if (!isLoginHarness(harness)) throw new Error("No such coding harness login");
		const o = await this.openRaw(userId, harness, true);
		if (!o.plaintext) return { version: o.version, files: null, unreadable: o.unreadable };
		try {
			return { version: o.version, files: unpackArchive(o.plaintext, HARNESS_FILES[harness].files), unreadable: false };
		} catch (e) {
			if (!(e instanceof ArchiveError)) throw e;
			return { version: o.version, files: null, unreadable: true };
		}
	}

	override async save(userId: string, harness: LoginHarness, files: readonly ArchiveFile[], expectedVersion: number): Promise<VaultWriteResult> {
		if (!isLoginHarness(harness)) throw new Error("No such coding harness login");
		return this.sealRaw(userId, harness, packArchive(files, HARNESS_FILES[harness].files), expectedVersion);
	}

	override async loadApiKey(userId: string, harness: ApiKeyHarness): Promise<string | null> {
		if (!isApiKeyHarness(harness)) throw new Error("No such coding harness API key");
		const o = await this.openRaw(userId, harness);
		if (!o.plaintext) return null;
		const key = new TextDecoder().decode(o.plaintext);
		return apiKeyProblem(harness, key) === null ? key : null;
	}

	override async saveApiKey(userId: string, harness: ApiKeyHarness, apiKey: string): Promise<VaultStatus> {
		if (!isApiKeyHarness(harness)) throw new Error("No such coding harness API key");
		const problem = apiKeyProblem(harness, apiKey);
		if (problem) throw new ApiKeyError(problem);
		let { version } = await this.backend.read(userId, harness, { fresh: true });
		for (let attempt = 0; attempt < 3; attempt++) {
			const w = await this.sealRaw(userId, harness, new TextEncoder().encode(apiKey), version);
			if (w.ok) return (await this.backend.status(userId)).find((s) => s.harness === harness)!;
			version = w.version;
		}
		throw new Error("The API key kept losing to other writes");
	}

	override async loadAmpM2m(userId: string): Promise<{ clientId: string; clientSecret: string } | null> {
		const o = await this.openRaw(userId, "amp-http-m2m");
		if (!o.plaintext) return null;
		try {
			const v = JSON.parse(new TextDecoder().decode(o.plaintext));
			return typeof v?.clientId === "string" && typeof v?.clientSecret === "string" ? v : null;
		} catch {
			return null;
		}
	}
}
