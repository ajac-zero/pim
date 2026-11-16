import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { sealWithPassphrase, keyFingerprint } from "../crypto/envelope.ts";
import { decodeCredentialsKey } from "../crypto/legacy.ts";
import { auditImport } from "../migration/audit.ts";
import { FenceExporter } from "../migration/export.ts";
import { buildLegacySnapshot } from "../migration/fixture.ts";
import { importSnapshot } from "../migration/import.ts";
import { FsObjectStore } from "../migration/objects.ts";
import { buildReport, reportMarkdown } from "../migration/report.ts";
import { SnapshotReader, SnapshotWriter } from "../migration/snapshot.ts";
import { loadMigrations, migrate } from "../pg/migrate.ts";
import { startEmbeddedPostgres } from "../pg/embedded.ts";
import { cryptoFromEnv, need } from "./common.ts";

const [command = "", ...rest] = process.argv.slice(2);
const { values } = parseArgs({
	args: rest,
	options: {
		url: { type: "string" },
		"token-env": { type: "string", default: "FENCE_EXPORT_TOKEN" },
		out: { type: "string" },
		snapshot: { type: "string" },
		"cutover-at": { type: "string" },
		"database-url": { type: "string" },
		"objects-dir": { type: "string" },
		"cutover-id": { type: "string" },
		report: { type: "string" },
		"legacy-rp-id": { type: "string" },
		"new-rp-id": { type: "string" },
		"key-backup-passphrase-env": { type: "string", default: "PIM_KEY_BACKUP_PASSPHRASE" },
	},
});

/** Export, import-and-verify, verify, and a self-contained rehearsal on a synthetic snapshot. */
async function main() {
	if (command === "export") {
		const out = need(values.out, "--out");
		const token = need(process.env[values["token-env"]!], values["token-env"]!);
		const keyMaterial: { name: string; fingerprint: string }[] = [];
		const credentialsKey = process.env.APP_CREDENTIALS_KEY;
		if (credentialsKey) keyMaterial.push({ name: "APP_CREDENTIALS_KEY", fingerprint: keyFingerprint(decodeCredentialsKey(credentialsKey)) });
		const writer = new SnapshotWriter(out);
		const { spaces, objects } = await new FenceExporter({ baseUrl: need(values.url, "--url"), token, sink: writer, cutoverAt: values["cutover-at"] ? Date.parse(values["cutover-at"]) : undefined, keyMaterial, onProgress: (l) => console.log(l) }).run();
		console.log(`Exported ${spaces.length} space(s) and ${objects.length} object(s) to ${out}`);
		// The original key backup: sealed under an operator passphrase, kept beside the snapshot, never inside it.
		const passphrase = process.env[values["key-backup-passphrase-env"]!];
		if (passphrase && credentialsKey) {
			await mkdir(out, { recursive: true });
			await writeFile(join(out, "..", `${out.split("/").pop()}.keys.backup.json`), sealWithPassphrase(Buffer.from(JSON.stringify({ APP_CREDENTIALS_KEY: credentialsKey })), passphrase), { mode: 0o600 });
			console.log("Wrote the sealed key backup next to the snapshot.");
		} else console.warn("No key backup written: set APP_CREDENTIALS_KEY and the passphrase variable to keep the original keys.");
		return 0;
	}
	if (command === "import" || command === "verify") {
		const reader = new SnapshotReader(need(values.snapshot, "--snapshot"));
		const pool = new pg.Pool({ connectionString: need(values["database-url"], "--database-url"), max: 4 });
		const objects = new FsObjectStore(need(values["objects-dir"], "--objects-dir"));
		const cutoverId = need(values["cutover-id"], "--cutover-id");
		try {
			let summary;
			if (command === "import") {
				await migrate(pool, await loadMigrations());
				summary = (await importSnapshot(pool, reader, { cutoverId, crypto: cryptoFromEnv(), objects, appCredentialsKey: process.env.APP_CREDENTIALS_KEY, legacyRpId: values["legacy-rp-id"], newRpId: values["new-rp-id"] })).summary;
			}
			const audit = await auditImport(pool, reader, objects, { cutoverId });
			if (!summary) throw new Error("verify needs the import summary; run import, which verifies as it goes");
			const report = buildReport(summary, audit);
			const target = need(values.report, "--report");
			await mkdir(target, { recursive: true });
			await writeFile(join(target, "cutover-report.json"), JSON.stringify(report, null, 2));
			await writeFile(join(target, "cutover-report.md"), reportMarkdown(report));
			console.log(`${report.verdict.toUpperCase()}: ${audit.checks.filter((c) => c.ok).length}/${audit.checks.length} checks. Report in ${target}`);
			if (report.verdict !== "pass") await Promise.all(audit.checks.filter((c) => !c.ok).map((c) => console.error(`FAILED ${c.name}`)));
			return report.verdict === "pass" ? 0 : 1;
		} finally {
			await pool.end();
		}
	}
	if (command === "rehearse") {
		// A full dry run on a synthetic snapshot and a throwaway PostgreSQL: nothing real is touched.
		const out = need(values.out, "--out");
		const info = await buildLegacySnapshot(join(out, "snapshot"));
		const server = await startEmbeddedPostgres();
		try {
			await server.createDatabase("rehearsal");
			const pool = new pg.Pool({ connectionString: server.url("rehearsal"), max: 4 });
			await migrate(pool, await loadMigrations());
			const reader = new SnapshotReader(join(out, "snapshot"));
			const objects = new FsObjectStore(join(out, "objects"));
			const { summary } = await importSnapshot(pool, reader, { cutoverId: "rehearsal", crypto: cryptoFromEnv({ PIM_KEK_CURRENT: "r1", PIM_KEK_r1: Buffer.alloc(32, 1).toString("base64") }), objects, appCredentialsKey: info.keys.appCredentialsKey.toString("base64") });
			const audit = await auditImport(pool, reader, objects, { cutoverId: "rehearsal" });
			const report = buildReport(summary, audit);
			await mkdir(join(out, "report"), { recursive: true });
			await writeFile(join(out, "report", "cutover-report.json"), JSON.stringify(report, null, 2));
			await writeFile(join(out, "report", "cutover-report.md"), reportMarkdown(report));
			console.log(`${report.verdict.toUpperCase()}: ${audit.checks.filter((c) => c.ok).length}/${audit.checks.length} checks. Report in ${join(out, "report")}`);
			await pool.end();
			return report.verdict === "pass" ? 0 : 1;
		} finally {
			await server.stop();
		}
	}
	console.error("Usage: v2-migrate <export|import|rehearse> [options]; see docs/v2-operations.md");
	return 2;
}

process.exit(await main());
