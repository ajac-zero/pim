import { getAgentByName } from "agents";
import { base64UrlDecode } from "@pim/shared/encoding";
import { CodingVault, type Ownership, type VaultBackend } from "@pim/coding/vault/vault";
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

/** The vault as the Worker and coding threads use it. */
export function codingVault(env: Env): CodingVault {
	return new CodingVault(spaceVaultBackend(env), () => directoryVaultKey(env));
}

export function threadOwnership(env: Env): Ownership {
	return async (userId, sessionId) => (await codingScheduler(env, userId).thread(sessionId)) !== null;
}
