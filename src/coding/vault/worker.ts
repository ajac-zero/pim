import { getAgentByName } from "agents";
import { base64UrlDecode } from "@pim/shared/encoding";
import { CachingVaultBackend } from "@pim/coding/vault/read-cache";
import { CodingVault, type Ownership, type VaultBackend } from "@pim/coding/vault/vault";
import type { Harness } from "@pim/shared/harnesses";
import { vaultKey } from "@pim/coding/vault/crypto";
import { codingScheduler } from "../scheduler-do";

// The coding vault (@pim/coding/vault/vault) as the Worker wires it: entries in each person's space, the key from the Directory, and thread ownership from the scheduler.

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

// What this isolate has read of the vault lately, shared by every coding thread and route in it (see CachingVaultBackend). Its backend is whichever environment last asked; one isolate's environments all reach the same spaces.
const reads = new CachingVaultBackend(null as unknown as VaultBackend);

/** Forgets what this isolate kept of a person's vault entry, as a rotation or disconnect, or a rejected credential, asks. */
export function forgetVaultReads(userId?: string, harness?: Harness): void {
	if (userId === undefined) reads.clear();
	else reads.invalidate(userId, harness);
}

/** The vault as the Worker and coding threads use it. */
export function codingVault(env: Env): CodingVault {
	reads.inner = spaceVaultBackend(env);
	return new CodingVault(reads, () => directoryVaultKey(env));
}

export function threadOwnership(env: Env): Ownership {
	return async (userId, sessionId) => (await codingScheduler(env, userId).thread(sessionId)) !== null;
}
