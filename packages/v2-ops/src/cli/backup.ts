import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import pg from "pg";
import { backupPhysical, restorePhysical } from "../backup/backup.ts";
import { markRestored, postRestoreSafetyPass, runnerMayStart } from "../backup/reconcile.ts";
import { FsObjectStore } from "../migration/objects.ts";
import { need } from "./common.ts";

const [command = "", ...rest] = process.argv.slice(2);
const { values } = parseArgs({
	args: rest,
	options: {
		"admin-url": { type: "string" },
		"database-url": { type: "string" },
		"data-dir": { type: "string" },
		"archive-dir": { type: "string" },
		"out-dir": { type: "string" },
		backup: { type: "string" },
		"backup-id": { type: "string" },
		target: { type: "string" },
		time: { type: "string" },
		immediate: { type: "boolean", default: false },
		"objects-dir": { type: "string" },
		"restore-id": { type: "string" },
		"known-effects": { type: "string" },
	},
});

async function main() {
	const objects = new FsObjectStore(need(values["objects-dir"], "--objects-dir"));
	if (command === "backup") {
		const manifest = await backupPhysical({ backupId: need(values["backup-id"], "--backup-id"), adminUrl: need(values["admin-url"], "--admin-url"), dataDir: need(values["data-dir"], "--data-dir"), archiveDir: need(values["archive-dir"], "--archive-dir"), outDir: need(values["out-dir"], "--out-dir"), objects, buckets: ["ARTIFACTS", "BLOBS", "pim-objects"] });
		console.log(JSON.stringify(manifest, null, 2));
		return 0;
	}
	if (command === "restore") {
		const manifest = await restorePhysical({ backupDir: need(values.backup, "--backup"), archiveDir: need(values["archive-dir"], "--archive-dir"), targetDataDir: need(values.target, "--target"), targetTime: values.time, targetImmediate: values.immediate, objects });
		console.log(`Restored ${manifest.backupId}. Start PostgreSQL on ${values.target} with Runners STOPPED, then run: post-restore`);
		return 0;
	}
	if (command === "post-restore") {
		const pool = new pg.Pool({ connectionString: need(values["database-url"], "--database-url"), max: 2 });
		try {
			const id = need(values["restore-id"], "--restore-id");
			await markRestored(pool, id, values["backup-id"], values.time);
			const knownEffects = values["known-effects"] ? (JSON.parse(await readFile(values["known-effects"], "utf8")) as { tenantId: string; idempotencyKey: string }[]) : [];
			const summary = await postRestoreSafetyPass(pool, { restoreId: id, backupId: values["backup-id"], targetTime: values.time, knownEffects });
			console.log(JSON.stringify({ ...summary, runnersMayStart: await runnerMayStart(pool) }, null, 2));
			return 0;
		} finally {
			await pool.end();
		}
	}
	console.error("Usage: v2-backup <backup|restore|post-restore> [options]; see docs/v2-operations.md");
	return 2;
}
process.exit(await main());
