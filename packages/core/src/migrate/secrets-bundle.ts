import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** `secrets.json` of an export bundle: each secret AES-256-GCM encrypted under the export key, bound to its tenant and id. The key is a file, never an argument or a bundle member. */
export interface SecretsFile {
	alg: "aes-256-gcm";
	items: { id: string; purpose: string; nonce: string; ct: string }[];
}

const aad = (tenantId: string, id: string, purpose: string) => Buffer.from(`${tenantId}\u0000${id}\u0000${purpose}`);

export function encryptSecretsFile(items: { id: string; purpose: string; value: string }[], key: Buffer, tenantId: string): SecretsFile {
	if (key.length !== 32) throw new Error("The export key must be 32 bytes");
	return {
		alg: "aes-256-gcm",
		items: items.map((item) => {
			const nonce = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, nonce);
			cipher.setAAD(aad(tenantId, item.id, item.purpose));
			const ct = Buffer.concat([cipher.update(item.value, "utf8"), cipher.final(), cipher.getAuthTag()]);
			return { id: item.id, purpose: item.purpose, nonce: nonce.toString("base64"), ct: ct.toString("base64") };
		}),
	};
}

export function decryptSecretsFile(file: SecretsFile, key: Buffer, tenantId: string): { id: string; purpose: string; value: string }[] {
	return file.items.map((item) => {
		const ct = Buffer.from(item.ct, "base64");
		const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(item.nonce, "base64"));
		decipher.setAAD(aad(tenantId, item.id, item.purpose));
		decipher.setAuthTag(ct.subarray(ct.length - 16));
		return { id: item.id, purpose: item.purpose, value: Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString("utf8") };
	});
}
