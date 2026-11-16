import { z } from "zod";
import { DEFAULT_POOL_BUDGETS, POOL_NAMES, type PoolBudgets } from "./db.ts";

export interface ObjectMetadata {
	readonly key: string;
	readonly size: number;
	readonly contentType: string;
	readonly etag: string;
}

export interface ObjectRange {
	readonly start: number;
	readonly end: number;
}

/**
 * S3-compatible storage for images, MP4/WebM, app bundles and Yjs snapshots. The bytes live here;
 * names, owners and access control live in PostgreSQL, which decides before a key or presigned URL is handed out.
 */
export interface ObjectStore {
	put(key: string, body: Uint8Array, options: { contentType: string }): Promise<ObjectMetadata>;
	get(key: string, range?: ObjectRange): Promise<{ body: Uint8Array; metadata: ObjectMetadata } | null>;
	head(key: string): Promise<ObjectMetadata | null>;
	delete(key: string): Promise<void>;
	presign(key: string, options: { method: "GET" | "PUT"; expiresInSeconds: number; contentType?: string }): Promise<string>;
}

/** Where a key came from: a v2 key, or a legacy secret imported so old ciphertext still opens. */
export type KeySource = { kind: "v2"; keyId: string } | { kind: "legacy-app-credentials" } | { kind: "legacy-cookie-key"; purpose: "vault" | "git-broker" | "gateway" | "gitea" };

export interface Sealed {
	/** The key that sealed it, so rotation can open old values and seal new ones with the current key. */
	readonly keyId: string;
	readonly version: number;
	readonly nonce: Uint8Array;
	readonly ciphertext: Uint8Array;
}

/** Versioned envelope encryption: a data key wrapped by a rotatable key, with authenticated encryption and the context bound in. */
export interface EnvelopeCrypto {
	seal(plaintext: Uint8Array, context: string): Promise<Sealed>;
	open(sealed: Sealed, context: string): Promise<Uint8Array>;
	/** Re-seals under the current key; the plaintext never leaves the call. */
	rotate(sealed: Sealed, context: string): Promise<Sealed>;
	/** Registers a legacy secret so values it sealed can be opened and then rotated. */
	importLegacyKey(source: KeySource, secret: Uint8Array): Promise<string>;
}

export const PROCESS_ROLES = ["gate", "live", "runner", "forge", "canvas", "relay", "maintenance", "all-in-one"] as const;
export const PimProcessRole = z.enum(PROCESS_ROLES);
export type PimProcessRole = z.infer<typeof PimProcessRole>;

/** The roles a process starts: `all-in-one` is every other role. */
export function rolesOf(role: PimProcessRole): readonly Exclude<PimProcessRole, "all-in-one">[] {
	return role === "all-in-one" ? PROCESS_ROLES.filter((r): r is Exclude<PimProcessRole, "all-in-one"> => r !== "all-in-one") : [role];
}

const poolMax = (name: string) => z.coerce.number().int().positive().default(DEFAULT_POOL_BUDGETS[name as keyof PoolBudgets].max);

const EnvSchema = z.object({
	PIM_ROLE: PimProcessRole.default("all-in-one"),
	PIM_PUBLIC_URL: z.url(),
	PIM_DATABASE_URL: z.string().min(1),
	PIM_NATS_URL: z.string().min(1),
	PIM_S3_ENDPOINT: z.url(),
	PIM_S3_BUCKET: z.string().min(1),
	PIM_S3_REGION: z.string().default("us-east-1"),
	PIM_RUNNER_HOLDER_ID: z.string().min(1).optional(),
	...Object.fromEntries(POOL_NAMES.map((name) => [`PIM_POOL_${name.toUpperCase()}_MAX`, poolMax(name)])),
});

export interface ProcessConfig {
	readonly role: PimProcessRole;
	readonly publicUrl: string;
	readonly databaseUrl: string;
	readonly natsUrl: string;
	readonly s3: { readonly endpoint: string; readonly bucket: string; readonly region: string };
	readonly runnerHolderId?: string;
	readonly pools: PoolBudgets;
}

/** Reads the process's configuration from environment variables; it throws one error naming every bad variable. It needs no Cloudflare runtime. */
export function loadProcessConfig(env: Readonly<Record<string, string | undefined>>): ProcessConfig {
	const parsed = EnvSchema.safeParse(env);
	if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
	const v = parsed.data as Record<string, string | number>;
	const pools = Object.fromEntries(POOL_NAMES.map((name) => [name, { ...DEFAULT_POOL_BUDGETS[name], max: v[`PIM_POOL_${name.toUpperCase()}_MAX`] as number }])) as unknown as PoolBudgets;
	return {
		role: v.PIM_ROLE as PimProcessRole,
		publicUrl: v.PIM_PUBLIC_URL as string,
		databaseUrl: v.PIM_DATABASE_URL as string,
		natsUrl: v.PIM_NATS_URL as string,
		s3: { endpoint: v.PIM_S3_ENDPOINT as string, bucket: v.PIM_S3_BUCKET as string, region: v.PIM_S3_REGION as string },
		...(v.PIM_RUNNER_HOLDER_ID ? { runnerHolderId: v.PIM_RUNNER_HOLDER_ID as string } : {}),
		pools,
	};
}
