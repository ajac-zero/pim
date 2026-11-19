import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupPhysical, restorePhysical } from "../src/backup/backup.ts";
import { markRestored, postRestoreSafetyPass, runnerMayStart } from "../src/backup/reconcile.ts";
import { EnvelopeCrypto } from "../src/crypto/envelope.ts";
import { auditImport } from "../src/migration/audit.ts";
import { buildLegacySnapshot } from "../src/migration/fixture.ts";
import { importSnapshot } from "../src/migration/import.ts";
import { FsObjectStore } from "../src/migration/objects.ts";
import { SnapshotReader } from "../src/migration/snapshot.ts";
import { loadAllMigrations, migrate } from "../src/pg/migrate.ts";
import { type EmbeddedPostgres, startEmbeddedPostgres } from "../src/pg/embedded.ts";
import { FakeProvider, runPendingOperations } from "./support/runner.ts";

const crypto = new EnvelopeCrypto({ k1: Buffer.alloc(32, 1) }, "k1");
const keys = { APP_CREDENTIALS_KEY: Buffer.alloc(32, 7), "directory.cookie_key": Buffer.alloc(32, 9) };

describe("backup, restore and the post-restore safety pass (real PostgreSQL, physical base backup + archived WAL)", () => {
	let root: string;
	let live: EmbeddedPostgres;
	let pool: pg.Pool;
	let objects: FsObjectStore;
	let reader: SnapshotReader;
	const provider = new FakeProvider();
	let backupDir: string;
	let archiveDir: string;
	let tY: string;
	const restored: EmbeddedPostgres[] = [];

	const op = (id: string, key: string, status: string) =>
		pool.query("INSERT INTO pim_ops.external_operations (id, owner_id, kind, idempotency_key, status, origin) VALUES ($1, 'o_own_ada', 'http_request', $2, $3, 'runner')", [id, key, status]);

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pim-backup-"));
		archiveDir = join(root, "wal");
		backupDir = join(root, "backups");
		objects = new FsObjectStore(join(root, "s3"));
		live = await startEmbeddedPostgres({ dataDir: join(root, "live"), archiveDir });
		pool = new pg.Pool({ connectionString: live.url(), max: 4 }).on("error", () => undefined);
		await migrate(pool, await loadAllMigrations());
		await buildLegacySnapshot(join(root, "snapshot"));
		reader = new SnapshotReader(join(root, "snapshot"));
		await importSnapshot(pool, reader, { cutoverId: "cut-1", crypto, objects });

		// State at the backup point: one operation in flight and one pending.
		await op("op_x", "purchase:order-1", "in_flight");
		await op("op_y", "http:order-7", "pending");
		await backupPhysical({ backupId: "b1", adminUrl: live.url(), dataDir: join(live.dataDir, "data"), archiveDir, outDir: backupDir, objects, buckets: ["ARTIFACTS", "BLOBS"], keys });

		// After the backup a Runner performs the pending effect, and later work lands.
		expect(await runPendingOperations(pool, provider)).toEqual(["http:order-7"]);
		tY = (await pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS t")).rows[0].t;
		await new Promise((r) => setTimeout(r, 300));
		await op("op_z", "later:z", "succeeded");
		await pool.query("SELECT pg_switch_wal()");
		await new Promise((r) => setTimeout(r, 1500));
		await pool.end();
		await live.stop();
	});

	afterAll(async () => {
		for (const server of restored) await server.stop().catch(() => undefined);
	});

	async function restore(name: string, options: { targetTime?: string; targetImmediate?: boolean }) {
		const dataDir = join(root, name);
		const manifest = await restorePhysical({ backupDir: join(backupDir, "b1"), archiveDir, targetDataDir: join(dataDir, "data"), objects: new FsObjectStore(join(root, `s3-${name}`)), ...options });
		const server = await startEmbeddedPostgres({ dataDir, existing: true });
		restored.push(server);
		const restoredPool = new pg.Pool({ connectionString: server.url(), max: 4 }).on("error", () => undefined);
		for (let i = 0; i < 60; i++) {
			try {
				if (!(await restoredPool.query("SELECT pg_is_in_recovery() AS r")).rows[0].r) break;
			} catch {}
			await new Promise((r) => setTimeout(r, 250));
		}
		return { pool: restoredPool, manifest, objects: new FsObjectStore(join(root, `s3-${name}`)) };
	}

	it("restores the base backup alone: data intact, the pending operation is back, and without the safety pass it would run twice", async () => {
		const r = await restore("restore-base", { targetImmediate: true });
		expect((await r.pool.query("SELECT status FROM pim_ops.external_operations WHERE id IN ('op_x','op_y') ORDER BY id")).rows.map((x) => x.status)).toEqual(["in_flight", "pending"]);
		expect((await r.pool.query("SELECT count(*) n FROM pim_ops.external_operations WHERE id = 'op_z'")).rows[0].n).toBe("0");
		expect((await auditImport(r.pool, reader, r.objects, { cutoverId: "cut-1" })).ok).toBe(true);
		expect(r.manifest.keyMaterial.map((k) => k.name)).toEqual(["APP_CREDENTIALS_KEY", "directory.cookie_key"]);
		expect(r.manifest.objects).toHaveLength(5);

		// Negative control: a Runner started on this database without the pass repeats the effect.
		await markRestored(r.pool, "restore-base", "b1");
		expect(await runnerMayStart(r.pool)).toBe(false);
		const control = new FakeProvider();
		control.execute("http:order-7"); // the world already did it once
		const copy = await r.pool.query("SELECT 1");
		void copy;
		await runPendingOperations(r.pool, control);
		expect(control.duplicates).toEqual(["http:order-7"]);
		await r.pool.query("UPDATE pim_ops.external_operations SET status = 'pending' WHERE id = 'op_y'"); // put the control back

		// The pass, told which effects the outside world remembers.
		const summary = await postRestoreSafetyPass(r.pool, { restoreId: "restore-base", backupId: "b1", knownEffects: [{ tenantId: "o_own_ada", idempotencyKey: "http:order-7" }], now: Date.now() });
		expect(summary.inFlightQuarantined).toBe(1);
		expect(summary.knownEffectsRecorded).toBe(1);
		expect(summary.toolTasksHeld).toBe(0); // the import already held them
		expect(await runnerMayStart(r.pool)).toBe(true);
		expect(await runPendingOperations(r.pool, provider)).toEqual([]);
		expect(provider.executions.get("http:order-7")).toBe(1);
		expect(provider.duplicates).toEqual([]);
		expect((await r.pool.query("SELECT id, status FROM pim_ops.external_operations WHERE id IN ('op_x','op_y') ORDER BY id")).rows).toEqual([
			{ id: "op_x", status: "needs_reconciliation" },
			{ id: "op_y", status: "needs_reconciliation" },
		]);
		// Idempotent, and nothing is left armed in the past.
		expect(await postRestoreSafetyPass(r.pool, { restoreId: "restore-base" })).toMatchObject({ inFlightQuarantined: 0, pendingQuarantined: 0 });
		expect((await r.pool.query("SELECT count(*) n FROM pim_ops.due_work WHERE state = 'armed' AND next_due_at_ms <= $1", [Date.now()])).rows[0].n).toBe("0");
		await r.pool.end();
	});

	it("point-in-time recovery to just after the effect: the effect is remembered, later work is gone, and the pass quarantines only what is unsettled", async () => {
		const r = await restore("restore-pitr", { targetTime: tY });
		expect((await r.pool.query("SELECT id, status FROM pim_ops.external_operations WHERE id IN ('op_x','op_y','op_z') ORDER BY id")).rows).toEqual([
			{ id: "op_x", status: "in_flight" },
			{ id: "op_y", status: "succeeded" },
		]);
		expect((await auditImport(r.pool, reader, r.objects, { cutoverId: "cut-1" })).ok).toBe(true);
		await markRestored(r.pool, "restore-pitr", "b1", tY);
		const summary = await postRestoreSafetyPass(r.pool, { restoreId: "restore-pitr", backupId: "b1", targetTime: tY });
		expect(summary).toMatchObject({ inFlightQuarantined: 1, pendingQuarantined: 0 });
		expect(await runPendingOperations(r.pool, provider)).toEqual([]);
		expect(provider.duplicates).toEqual([]);
		expect((await r.pool.query("SELECT status FROM pim_ops.external_operations WHERE id = 'op_y'")).rows[0].status).toBe("succeeded");
		await r.pool.end();
	});

	it("refuses a corrupt backed-up object on restore", async () => {
		const { writeFile } = await import("node:fs/promises");
		const file = join(backupDir, "b1", "objects", "BLOBS", encodeURIComponent("own_ada/img_1.png"));
		await writeFile(file, "corrupt");
		await expect(restorePhysical({ backupDir: join(backupDir, "b1"), archiveDir, targetDataDir: join(root, "restore-bad", "data"), objects: new FsObjectStore(join(root, "s3-bad")), targetImmediate: true })).rejects.toThrow(/corrupt/);
	});
});
