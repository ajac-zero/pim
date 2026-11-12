import { getAgentByName } from "agents";
import { base64UrlDecode } from "../../auth/encoding";
import { codingScheduler } from "../scheduler-do";
import { ArchiveError, type ArchiveFile, packArchive, unpackArchive } from "./archive";
import { openBlob, sealBlob, VaultUnreadableError, vaultKey } from "./crypto";
import { type CodingVaultKey, type ApiKeyHarness, apiKeyProblem, HARNESS_FILES, type Harness, isApiKeyHarness, isHarness, isLoginHarness, type LoginHarness } from "./harnesses";
import type { VaultRecord, VaultStatus, VaultWriteResult } from "./store";

/**
 * The per-person credential vault for coding harnesses (./harnesses.ts).
 * Each person's entries live in their own space's database (./store.ts),
 * sealed (./crypto.ts) before they leave this module, so the space only
 * ever holds ciphertext; they are opened here, for that person's own
 * workspaces (./inject.ts), and nothing here reads the files inside.
 *
 * An entry is one of two kinds, by its harness: a subscription harness's
 * login, an archive of the CLI's files (`load`, `save`), or an API-key
 * harness's key, its UTF-8 bytes (`loadApiKey`, `saveApiKey`). Both are
 * sealed alike and bound to their person and harness, so neither opens as
 * the other.
 */

/** One person's sealed entries, wherever they are kept. Every call names the person; an implementation reaches only that person's. */
export interface VaultBackend {
	status(userId: string): Promise<VaultStatus[]>;
	read(userId: string, harness: CodingVaultKey): Promise<VaultRecord>;
	write(userId: string, harness: CodingVaultKey, sealed: Uint8Array, byteLength: number, expectedVersion: number): Promise<VaultWriteResult>;
	delete(userId: string, harness: Harness): Promise<VaultStatus>;
}

/** The entries kept in each person's space, the Pim Durable Object named by their owner id. */
export function spaceVaultBackend(env: Env): VaultBackend {
	const space = (userId: string) => getAgentByName(env.Pim, userId);
	return {
		status: async (userId) => (await space(userId)).codingVaultStatus(),
		read: async (userId, harness) => (await space(userId)).codingVaultRead(harness),
		write: async (userId, harness, sealed, byteLength, expectedVersion) => (await space(userId)).codingVaultWrite(harness, sealed, byteLength, expectedVersion),
		delete: async (userId, harness) => (await space(userId)).codingVaultDelete(harness),
	};
}

let keyPromise: Promise<CryptoKey> | null = null;

/** The vault's key, derived from the Directory's own key and read once per isolate. */
export function directoryVaultKey(env: Env): Promise<CryptoKey> {
	if (!keyPromise) {
		const key = env.Directory.getByName("directory")
			.cookieKey()
			.then((raw) => vaultKey(base64UrlDecode(raw)));
		keyPromise = key;
		key.catch(() => {
			if (keyPromise === key) keyPromise = null;
		});
	}
	return keyPromise;
}

/**
 * A person's login for one harness, opened: the version it was read at, and
 * its files, or null when not connected or when the entry doesn't open as
 * theirs (`unreadable`: tampered with, another person's or harness's, or
 * sealed under a key this Pim no longer has), which is as good as none.
 */
export type VaultEntry = { readonly version: number; readonly files: ArchiveFile[] | null; readonly unreadable: boolean };

export class CodingVault {
	constructor(
		readonly backend: VaultBackend,
		readonly key: () => Promise<CryptoKey>,
		readonly now: () => number = Date.now,
	) {}

	/** Optional machine credentials for Amp usage, provisioned through the vault, not the PAT Connect field. */
	async loadAmpM2m(userId: string): Promise<{ clientId: string; clientSecret: string } | null> {
		const record = await this.backend.read(userId, "amp-http-m2m");
		if (record.sealed === null) return null;
		try {
			const raw = await openBlob(await this.key(), { userId, harness: "amp-http-m2m" }, record.sealed);
			const value = JSON.parse(new TextDecoder().decode(raw));
			return typeof value?.clientId === "string" && value.clientId && typeof value?.clientSecret === "string" && value.clientSecret ? { clientId: value.clientId, clientSecret: value.clientSecret } : null;
		} catch { return null; }
	}

	/** Internal provisioning path for the optional usage credential. No HTTP route returns it. */
	async saveAmpM2m(userId: string, credentials: { clientId: string; clientSecret: string }, expectedVersion: number): Promise<VaultWriteResult> {
		if (!credentials.clientId || !credentials.clientSecret) throw new Error("Amp M2M needs a client id and secret");
		const raw = new TextEncoder().encode(JSON.stringify(credentials));
		const sealed = await sealBlob(await this.key(), { userId, harness: "amp-http-m2m" }, raw);
		return this.backend.write(userId, "amp-http-m2m", sealed, raw.byteLength, expectedVersion);
	}

	/** Each harness's entry for the person, never what it holds. */
	async status(userId: string): Promise<VaultStatus[]> {
		return this.backend.status(userId);
	}

	/** The person's entry, opened. */
	async load(userId: string, harness: LoginHarness): Promise<VaultEntry> {
		if (!isLoginHarness(harness)) throw new Error("No such coding harness login");
		const record = await this.backend.read(userId, harness);
		if (record.sealed === null) return { version: record.version, files: null, unreadable: false };
		try {
			const archive = await openBlob(await this.key(), { userId, harness }, record.sealed);
			return { version: record.version, files: unpackArchive(archive, HARNESS_FILES[harness].files), unreadable: false };
		} catch (error) {
			if (!(error instanceof VaultUnreadableError || error instanceof ArchiveError)) throw error;
			console.warn(JSON.stringify({ event: "pim.coding.vault_unreadable", user: userId, harness, version: record.version, error: error.name }));
			return { version: record.version, files: null, unreadable: true };
		}
	}

	/** Stores the person's files for a harness, if the entry is still at `expectedVersion`. */
	async save(userId: string, harness: LoginHarness, files: readonly ArchiveFile[], expectedVersion: number): Promise<VaultWriteResult> {
		if (!isLoginHarness(harness)) throw new Error("No such coding harness login");
		const archive = packArchive(files, HARNESS_FILES[harness].files);
		const sealed = await sealBlob(await this.key(), { userId, harness }, archive);
		return this.backend.write(userId, harness, sealed, archive.byteLength, expectedVersion);
	}

	/**
	 * The person's API key for `harness`, opened, or null when they have
	 * none or it doesn't open as theirs. Only for handing to that person's
	 * own CLI runs.
	 */
	async loadApiKey(userId: string, harness: ApiKeyHarness): Promise<string | null> {
		if (!isApiKeyHarness(harness)) throw new Error("No such coding harness API key");
		const record = await this.backend.read(userId, harness);
		if (record.sealed === null) return null;
		try {
			const key = new TextDecoder().decode(await openBlob(await this.key(), { userId, harness }, record.sealed));
			return apiKeyProblem(harness, key) === null ? key : null;
		} catch (error) {
			if (!(error instanceof VaultUnreadableError)) throw error;
			console.warn(JSON.stringify({ event: "pim.coding.vault_unreadable", user: userId, harness, version: record.version, error: error.name }));
			return null;
		}
	}

	/**
	 * Stores the person's API key for `harness`, in place of any they had.
	 * A key that doesn't look right is refused with `ApiKeyError`, whose
	 * message never quotes it.
	 */
	async saveApiKey(userId: string, harness: ApiKeyHarness, apiKey: string): Promise<VaultStatus> {
		if (!isApiKeyHarness(harness)) throw new Error("No such coding harness API key");
		const problem = apiKeyProblem(harness, apiKey);
		if (problem) throw new ApiKeyError(problem);
		const plaintext = new TextEncoder().encode(apiKey);
		const sealed = await sealBlob(await this.key(), { userId, harness }, plaintext);
		// The newest key wins: a write that lost to another is tried again on the version it lost to.
		let { version } = await this.backend.read(userId, harness);
		for (let attempt = 0; attempt < 3; attempt++) {
			const written = await this.backend.write(userId, harness, sealed, plaintext.byteLength, version);
			if (written.ok) return (await this.backend.status(userId)).find((status) => status.harness === harness)!;
			version = written.version;
		}
		throw new Error("The API key kept losing to other writes");
	}

	/** Disconnects the person's harness: their entry is deleted. */
	async delete(userId: string, harness: Harness): Promise<VaultStatus> {
		return this.backend.delete(userId, checked(harness));
	}
}

/** An API key that doesn't look right; the message says why without quoting it. */
export class ApiKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApiKeyError";
	}
}

function checked(harness: Harness): Harness {
	if (!isHarness(harness)) throw new Error("No such coding harness");
	return harness;
}

/** The vault as the Worker and coding threads use it. */
export function codingVault(env: Env): CodingVault {
	return new CodingVault(spaceVaultBackend(env), () => directoryVaultKey(env));
}

/** Whether a workspace's session is one of the person's coding threads: listed in their own space's list, whose ids are derived from the space. */
export type Ownership = (userId: string, sessionId: string) => Promise<boolean>;

export function threadOwnership(env: Env): Ownership {
	return async (userId, sessionId) => (await codingScheduler(env, userId).thread(sessionId)) !== null;
}
