import { EnvelopeCrypto } from "../crypto/envelope.ts";

/**
 * The key ring from the environment: `PIM_KEK_<ID>` holds a base64 32-byte key-encryption key for each ID, and `PIM_KEK_CURRENT` names the one
 * that wraps new data keys. A deployment fills these from OpenBao or a Kubernetes Secret; they are never written to disk by these tools.
 */
export function cryptoFromEnv(env: NodeJS.ProcessEnv = process.env): EnvelopeCrypto {
	const ring: Record<string, Buffer> = {};
	for (const [name, value] of Object.entries(env)) {
		const id = /^PIM_KEK_(?!CURRENT$)([A-Za-z0-9_]+)$/.exec(name)?.[1];
		if (id && value) ring[id] = Buffer.from(value, "base64");
	}
	const current = env.PIM_KEK_CURRENT;
	if (!current) throw new Error("Set PIM_KEK_CURRENT to the id of the key-encryption key to wrap new data keys with, and PIM_KEK_<id> to its base64 value");
	return new EnvelopeCrypto(ring, current);
}

export function need(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}
