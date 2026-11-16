import { readFileSync } from "node:fs";
import { createPool, migrate } from "../db.ts";
import { IdAllocator } from "../ids.ts";
import { KeyRing } from "../secrets.ts";
import { backupDatabase, readBackupManifest, restoreDatabase, verifyAgainstManifest } from "./backup.ts";
import { type BlobStore, FsBlobStore, S3BlobStore } from "./blobs.ts";
import { BundleReader } from "./format.ts";
import { activateTenant, importBundle } from "./import.ts";
import { planTenant } from "./plan.ts";
import { verifyImport } from "./verify.ts";

/**
 * pim-migrate: the export-bundle importer, verifier, backup and restore. Credentials and keys come from files named in
 * the environment (PIM_DB_URL_MAINT, PIM_DB_URL_OWNER, PIM_EXPORT_KEY_FILE, PIM_MASTER_KEY_FILE, PIM_S3_*_FILE), never from arguments.
 * Nothing here talks to the old system: it reads a bundle. Importing into a target starts nothing; `activate` does.
 */
const env = process.env;
const need = (name: string) => {
	const v = env[name];
	if (!v) throw new Error(`${name} is required`);
	return v;
};
const file = (name: string) => readFileSync(need(name));
const text = (name: string) => file(name).toString("utf8").trim();

function blobStore(): BlobStore | undefined {
	if (env.PIM_BLOB_DIR) return new FsBlobStore(env.PIM_BLOB_DIR);
	if (env.PIM_S3_ENDPOINT) return new S3BlobStore({ endpoint: env.PIM_S3_ENDPOINT, bucket: need("PIM_S3_BUCKET"), accessKeyId: text("PIM_S3_ACCESS_KEY_FILE"), secretAccessKey: text("PIM_S3_SECRET_KEY_FILE") });
	return undefined;
}
const ring = () => (env.PIM_MASTER_KEY_FILE ? new KeyRing(file("PIM_MASTER_KEY_FILE"), Number(env.PIM_KEY_VERSION ?? 1), (env.PIM_KEY_VERSIONS ?? "").split(",").filter(Boolean).map(Number)) : undefined);
const exportKey = () => (env.PIM_EXPORT_KEY_FILE ? file("PIM_EXPORT_KEY_FILE") : undefined);

const [command, arg, ...rest] = process.argv.slice(2);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 1));

async function main() {
	switch (command) {
		case "inventory": {
			const bundle = new BundleReader(arg!);
			const tenants = [];
			for (const tenantId of bundle.manifest.tenants) {
				const plan = await planTenant(bundle, tenantId);
				tenants.push({ tenantId, families: plan.families.length, counts: plan.counts, maxId: plan.maxId, maxSeq: plan.maxSeq, violations: plan.violations });
			}
			print({ format: bundle.manifest.format, createdAt: bundle.manifest.createdAt, source: bundle.manifest.source, integrityProblems: await bundle.checkIntegrity(), blobs: (await bundle.all("blobs/index.ndjson")).length, externalHandles: (await bundle.all("external/handles.ndjson")).length, tenants });
			break;
		}
		case "plan": {
			const bundle = new BundleReader(arg!);
			print(await Promise.all(bundle.manifest.tenants.map(async (t) => { const p = await planTenant(bundle, t); return { tenant: t, families: p.families.map((f) => ({ key: f.key, home: f.home, conversations: f.conversations.size })), violations: p.violations }; })));
			break;
		}
		case "import": {
			const pool = createPool({ connectionString: need("PIM_DB_URL_MAINT"), max: 4 });
			const reports = await importBundle(new BundleReader(arg!), { pool, blobs: blobStore(), keyRing: ring(), exportKey: exportKey(), importId: rest[0] ?? `import-${Date.now()}`, log: console.error });
			print(reports);
			await pool.end();
			if (reports.some((r) => r.status === "refused")) process.exitCode = 2;
			break;
		}
		case "verify": {
			const pool = createPool({ connectionString: need("PIM_DB_URL_MAINT"), max: 4 });
			const verdict = await verifyImport(new BundleReader(arg!), { pool, ids: new IdAllocator(pool), blobs: blobStore(), keyRing: ring(), exportKey: exportKey() });
			print(verdict);
			await pool.end();
			if (!verdict.ok) process.exitCode = 3;
			break;
		}
		case "activate": {
			const pool = createPool({ connectionString: need("PIM_DB_URL_MAINT"), max: 2 });
			for (const tenant of [arg!, ...rest]) print({ tenant, activated: await activateTenant(pool, tenant) });
			await pool.end();
			break;
		}
		case "migrate-schema": {
			const pool = createPool({ connectionString: need("PIM_DB_URL_OWNER"), max: 2 });
			print({ applied: await migrate(pool) });
			await pool.end();
			break;
		}
		case "backup": {
			const pool = createPool({ connectionString: need("PIM_DB_URL_OWNER"), max: 2 });
			print(await backupDatabase(pool, arg!));
			await pool.end();
			break;
		}
		case "restore": {
			const pool = createPool({ connectionString: need("PIM_DB_URL_OWNER"), max: 2 });
			const result = await restoreDatabase(pool, arg!);
			print(result);
			await pool.end();
			if (result.mismatches.length) process.exitCode = 4;
			break;
		}
		case "backup-verify": {
			const pool = createPool({ connectionString: need("PIM_DB_URL_OWNER"), max: 2 });
			const mismatches = await verifyAgainstManifest(pool, readBackupManifest(arg!));
			print({ mismatches });
			await pool.end();
			if (mismatches.length) process.exitCode = 4;
			break;
		}
		default:
			console.error("usage: pim-migrate inventory|plan|import|verify|activate|migrate-schema|backup|restore|backup-verify <bundle-or-dir> [...]");
			process.exitCode = 64;
	}
}
main().catch((error) => {
	console.error(`pim-migrate: ${(error as Error).message}`);
	process.exit(1);
});
