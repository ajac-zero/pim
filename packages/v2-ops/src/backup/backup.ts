import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { keyFingerprint } from "../crypto/envelope.ts";
import type { ObjectStore } from "../migration/objects.ts";
import { sha256 } from "../migration/snapshot.ts";

export type BackupManifest = {
	readonly format: 1;
	readonly backupId: string;
	readonly takenAt: string;
	/** The WAL position at the end of the base backup: recovery to any time after it needs archived WAL from here on. */
	readonly stopLsn: string;
	readonly objects: readonly { readonly bucket: string; readonly key: string; readonly size: number; readonly sha256: string }[];
	/** Key material by name and public fingerprint. The keys themselves are backed up separately, sealed under a passphrase. */
	readonly keyMaterial: readonly { readonly name: string; readonly fingerprint: string }[];
};

export type BackupInput = {
	readonly backupId: string;
	/** An admin connection string (a role allowed to call pg_backup_start). */
	readonly adminUrl: string;
	readonly dataDir: string;
	readonly archiveDir: string;
	readonly outDir: string;
	readonly objects: ObjectStore;
	readonly buckets: readonly string[];
	readonly keys?: Readonly<Record<string, Uint8Array>>;
};

/** Files a base backup leaves out: they are recreated on start, or WAL, which recovery reads from the archive instead. */
const SKIP = new Set(["postmaster.pid", "postmaster.opts", "pg_wal", "pg_replslot", "pg_stat_tmp", "pg_dynshmem", "pg_notify", "pg_serial", "pg_snapshots", "pg_subtrans"]);

/**
 * A physical base backup of a running cluster through the low-level API (`pg_backup_start`, copy, `pg_backup_stop`), plus every
 * object in the given buckets with its SHA-256, plus the names and fingerprints of the key material. Together with the archived WAL it
 * restores to any time after `stopLsn`. Nothing here stops or locks the database.
 */
export async function backupPhysical(input: BackupInput): Promise<BackupManifest> {
	const out = join(input.outDir, input.backupId);
	await rm(out, { recursive: true, force: true });
	await mkdir(join(out, "pgdata"), { recursive: true });
	const client = new pg.Client({ connectionString: input.adminUrl });
	await client.connect();
	try {
		await client.query("SELECT pg_backup_start($1, true)", [input.backupId]);
		let label: { labelfile: string; spcmapfile: string };
		try {
			for (const name of await readdir(input.dataDir)) {
				if (SKIP.has(name)) continue;
				await cp(join(input.dataDir, name), join(out, "pgdata", name), { recursive: true });
			}
			// Directories the server needs to exist, emptied: their contents are not part of a base backup.
			for (const name of SKIP) if (name.startsWith("pg_")) await mkdir(join(out, "pgdata", name), { recursive: true });
		} finally {
			label = (await client.query("SELECT labelfile, spcmapfile FROM pg_backup_stop(true)")).rows[0];
		}
		await writeFile(join(out, "pgdata", "backup_label"), label.labelfile);
		if (label.spcmapfile) await writeFile(join(out, "pgdata", "tablespace_map"), label.spcmapfile);
		const stopLsn = (await client.query("SELECT pg_current_wal_lsn()::text AS lsn")).rows[0].lsn as string;
		// Finish the current WAL segment so that recovery to "now" has it in the archive.
		await client.query("SELECT pg_switch_wal()");
		await waitForArchive(client);
		const objects: BackupManifest["objects"][number][] = [];
		for (const bucket of input.buckets) {
			for (const { key } of await input.objects.list(bucket)) {
				const bytes = (await input.objects.get(bucket, key))!;
				await mkdir(join(out, "objects", bucket), { recursive: true });
				await writeFile(join(out, "objects", bucket, encodeURIComponent(key)), bytes);
				objects.push({ bucket, key, size: bytes.length, sha256: sha256(bytes) });
			}
		}
		const manifest: BackupManifest = {
			format: 1,
			backupId: input.backupId,
			takenAt: new Date().toISOString(),
			stopLsn,
			objects,
			keyMaterial: Object.entries(input.keys ?? {}).map(([name, key]) => ({ name, fingerprint: keyFingerprint(key) })),
		};
		await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
		return manifest;
	} finally {
		await client.end();
	}
}

async function waitForArchive(client: pg.Client) {
	for (let i = 0; i < 100; i++) {
		const { rows } = await client.query("SELECT archived_count, failed_count FROM pg_stat_archiver");
		const before = Number(rows[0].archived_count);
		await new Promise((r) => setTimeout(r, 100));
		const after = Number((await client.query("SELECT archived_count FROM pg_stat_archiver")).rows[0].archived_count);
		if (after === before && before > 0) return;
	}
	throw new Error("WAL archiving did not settle: check archive_command");
}

export type RestoreInput = {
	readonly backupDir: string;
	readonly archiveDir: string;
	/** The data directory a restored server will start in (embedded: `<dir>/data`). */
	readonly targetDataDir: string;
	/** Recover to this instant (an ISO time); omitted means replay all archived WAL. */
	readonly targetTime?: string;
	/** Stop at the end of the base backup (`recovery_target = 'immediate'`): the state as of the backup, with no archived WAL replayed past consistency. */
	readonly targetImmediate?: boolean;
	readonly objects: ObjectStore;
};

/** Lays a base backup down, writes recovery settings that replay archived WAL to the target, and restores the objects, verifying checksums. Returns the manifest. */
export async function restorePhysical(input: RestoreInput): Promise<BackupManifest> {
	const manifest = JSON.parse(await readFile(join(input.backupDir, "manifest.json"), "utf8")) as BackupManifest;
	await rm(input.targetDataDir, { recursive: true, force: true });
	await mkdir(input.targetDataDir, { recursive: true, mode: 0o700 });
	await cp(join(input.backupDir, "pgdata"), input.targetDataDir, { recursive: true });
	const conf = [
		`restore_command = 'cp ${input.archiveDir}/%f %p'`,
		input.targetTime ? `recovery_target_time = '${input.targetTime}'` : "",
		input.targetImmediate ? "recovery_target = 'immediate'" : "",
		"recovery_target_action = 'promote'",
		"",
	].join("\n");
	const auto = join(input.targetDataDir, "postgresql.auto.conf");
	const existing = await readFile(auto, "utf8").catch(() => "");
	await writeFile(auto, `${existing}\n${conf}`);
	await writeFile(join(input.targetDataDir, "recovery.signal"), "");
	for (const entry of manifest.objects) {
		const bytes = await readFile(join(input.backupDir, "objects", entry.bucket, encodeURIComponent(entry.key)));
		if (sha256(bytes) !== entry.sha256) throw new Error(`Backed-up object ${entry.bucket}/${entry.key} is corrupt`);
		await input.objects.put(entry.bucket, entry.key, bytes, null);
	}
	void stat;
	return manifest;
}
