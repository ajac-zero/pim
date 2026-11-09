import { getAgentByName } from "agents";
import { base64UrlDecode } from "../../auth/encoding";
import { codingScheduler } from "../scheduler-do";
import { ArchiveError, type ArchiveFile, packArchive, unpackArchive } from "./archive";
import { openBlob, sealBlob, VaultUnreadableError, vaultKey } from "./crypto";
import { HARNESS_FILES, type Harness, isHarness } from "./harnesses";
import type { VaultRecord, VaultStatus, VaultWriteResult } from "./store";

/**
 * The per-person credential vault for coding harnesses (./harnesses.ts).
 * Each person's entries live in their own space's database (./store.ts),
 * sealed (./crypto.ts) before they leave this module, so the space only
 * ever holds ciphertext; they are opened here, for that person's own
 * workspaces (./inject.ts), and nothing here reads the files inside.
 */

/** One person's sealed entries, wherever they are kept. Every call names the person; an implementation reaches only that person's. */
export interface VaultBackend {
	status(userId: string): Promise<VaultStatus[]>;
	read(userId: string, harness: Harness): Promise<VaultRecord>;
	write(userId: string, harness: Harness, sealed: Uint8Array, byteLength: number, expectedVersion: number): Promise<VaultWriteResult>;
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

	/** Each harness's entry for the person, never what it holds. */
	async status(userId: string): Promise<VaultStatus[]> {
		return this.backend.status(userId);
	}

	/** The person's entry, opened. */
	async load(userId: string, harness: Harness): Promise<VaultEntry> {
		checked(harness);
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
	async save(userId: string, harness: Harness, files: readonly ArchiveFile[], expectedVersion: number): Promise<VaultWriteResult> {
		checked(harness);
		const archive = packArchive(files, HARNESS_FILES[harness].files);
		const sealed = await sealBlob(await this.key(), { userId, harness }, archive);
		return this.backend.write(userId, harness, sealed, archive.byteLength, expectedVersion);
	}

	/** Disconnects the person's harness: their entry is deleted. */
	async delete(userId: string, harness: Harness): Promise<VaultStatus> {
		return this.backend.delete(userId, checked(harness));
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
