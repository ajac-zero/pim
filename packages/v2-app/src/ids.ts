import { createHash, randomBytes } from "node:crypto";

/** SHA-256 hex: how every bearer secret is stored. Secrets are random, so the digest alone is safe to keep. */
export const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
export const secret = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const newOwnerId = (): string => `o_${randomBytes(12).toString("hex")}`;
export const newId = (prefix: string): string => `${prefix}_${randomBytes(9).toString("hex")}`;
