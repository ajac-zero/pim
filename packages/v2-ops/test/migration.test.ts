import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EnvelopeCrypto } from "../src/crypto/envelope.ts";
import { auditImport } from "../src/migration/audit.ts";
import { FIXTURE_CUTOVER_AT, type FixtureInfo, buildLegacySnapshot } from "../src/migration/fixture.ts";
import { importSnapshot } from "../src/migration/import.ts";
import { FsObjectStore } from "../src/migration/objects.ts";
import { buildReport, reportMarkdown } from "../src/migration/report.ts";
import { SnapshotReader } from "../src/migration/snapshot.ts";
import { usePostgres } from "./support/pg.ts";

const db = usePostgres();
let dir: string;
let info: FixtureInfo;
const crypto = new EnvelopeCrypto({ k1: Buffer.alloc(32, 1) }, "k1");

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pim-snap-"));
	info = await buildLegacySnapshot(join(dir, "snapshot"));
});

const options = (objects: FsObjectStore) => ({ cutoverId: "cut-1", crypto, objects, appCredentialsKey: info.keys.appCredentialsKey.toString("base64") });

describe("export -> import -> audit on a rich synthetic legacy snapshot", () => {
	it("imports with full parity and an all-green auditor, and the quiesced state is safe for a first Runner boot", async () => {
		const pool = await db.freshDatabase();
		const reader = new SnapshotReader(join(dir, "snapshot"));
		const objects = new FsObjectStore(join(dir, "s3-a"));
		const { summary } = await importSnapshot(pool, reader, options(objects));
		const audit = await auditImport(pool, reader, objects, { cutoverId: "cut-1" });
		expect(audit.checks.filter((c) => !c.ok)).toEqual([]);
		expect(audit.ok).toBe(true);

		// Splitting: Ada's single storage became several partitions with the root in home, forks with their parents.
		const dir2 = (await pool.query("SELECT conversation_id, partition_id FROM pim.conversation_directory WHERE tenant_id = 'own_ada' ORDER BY conversation_id")).rows;
		const by = Object.fromEntries(dir2.map((r) => [Number(r.conversation_id), r.partition_id as string]));
		expect(by[1]).toBe("home");
		const chat = async (id: string) => Number((await pool.query("SELECT conversation_id FROM pim.chats WHERE public_id = $1", [id])).rows[0].conversation_id);
		const branched = await chat(info.chats.branched);
		expect(by[await chat(info.chats.fork)]).toBe(by[branched]);
		expect(by[await chat(info.chats.nestedFork)]).toBe(by[branched]);
		expect(by[await chat(info.chats.earlyFork)]).toBe(by[branched]);
		expect(by[await chat(info.chats.plain)]).not.toBe(by[branched]);
		expect(by[await chat(info.chats.continuation)]).not.toBe(by[await chat(info.chats.plain)]);
		expect(by[branched]).not.toBe("home");
		expect(summary.partitions.own_ada!.length).toBeGreaterThanOrEqual(6);

		// Numeric ids are untouched: the fork's parent and fork point are the same numbers as before.
		const fork = (await pool.query("SELECT parent_conversation_id, parent_at FROM pim.pi_conversations WHERE tenant_id='own_ada' AND id = $1", [await chat(info.chats.fork)])).rows[0];
		expect(Number(fork.parent_conversation_id)).toBe(branched);
		expect(Number(fork.parent_at)).toBeGreaterThan(0);

		// Unresolved external tool and the pending approval are quarantined, never pending/in-flight.
		const ops = (await pool.query("SELECT kind, status FROM pim.external_operations WHERE tenant_id='own_ada' ORDER BY kind")).rows;
		expect(ops.filter((o) => o.status === "needs_reconciliation").map((o) => o.kind)).toEqual(expect.arrayContaining(["tool:http_request", "tool:send_message", "approval", "trigger_fire"]));
		expect((await pool.query("SELECT hold FROM pim.pi_tasks WHERE tenant_id='own_ada' AND kind='pi.tool'")).rows.every((r) => r.hold === "needs_reconciliation")).toBe(true);

		// Zero catch-up storm: a Runner's due scan one second after the cutover finds nothing; missed occurrences are recorded.
		const due = await pool.query("SELECT key FROM pim.due_work WHERE state = 'armed' AND next_due_at_ms <= $1", [FIXTURE_CUTOVER_AT + 1000]);
		expect(due.rows).toEqual([]);
		const missed = (await pool.query("SELECT key, missed, next_due_at_ms FROM pim.due_work WHERE kind LIKE 'trigger:%' ORDER BY key")).rows;
		const cron = missed.find((m) => m.key === "trg_cron")!;
		expect(cron.missed).toHaveLength(2); // 02:45 (last observed 02:38) and 03:00 are both within (last, cutover]
		expect(Number(cron.next_due_at_ms)).toBe(FIXTURE_CUTOVER_AT + 15 * 60_000);
		expect(missed.find((m) => m.key === "trg_future")!.next_due_at_ms).not.toBeNull();
		expect((await pool.query("SELECT state FROM pim.due_work WHERE key='trg_once'")).rows[0].state).toBe("dropped");

		// Amp session adopted by its remote id, its start recorded as done: a Runner reusing the start key finds nothing to start.
		const remote = (await pool.query("SELECT remote_id, adoption, started_operation_id FROM pim.remote_threads")).rows;
		expect(remote).toEqual([{ remote_id: info.amp.threadId, adoption: "adopt", started_operation_id: "start:thr_amp1" }]);
		expect((await pool.query("SELECT status FROM pim.external_operations WHERE idempotency_key = 'thr_amp1:start:thr_amp1'")).rows[0].status).toBe("succeeded");

		// Secrets: sealed under the envelope, the legacy ciphertext kept, plaintext nowhere else.
		const gmail = (await pool.query("SELECT envelope, legacy_sealed FROM pim.secret_envelopes WHERE name LIKE 'Pim.pim_app_connections.credential.%' AND legacy_sealed IS NOT NULL")).rows[0];
		expect(gmail.legacy_sealed).toMatch(/^sealed:v1:/);
		const opened = JSON.parse(crypto.open(gmail.envelope, ["own_ada", "Pim.pim_app_connections.credential.conn_gmail", "connector-credential"]).toString());
		expect(opened.refreshToken).toBe("1//example-refresh");
		expect(() => crypto.open(gmail.envelope, ["own_grace", "Pim.pim_app_connections.credential.conn_gmail", "connector-credential"])).toThrow();
		const cookie = (await pool.query("SELECT envelope FROM pim.secret_envelopes WHERE name = 'Directory.directory_meta.cookie_key'")).rows[0];
		expect(crypto.open(cookie.envelope, ["_deployment", "Directory.directory_meta.cookie_key", "meta"]).toString()).toBe(info.keys.cookieKey.toString("base64url"));

		// Report: machine-readable and Markdown.
		const report = buildReport(summary, audit, new Date("2026-11-20T04:00:00Z"));
		expect(report.verdict).toBe("pass");
		const md = reportMarkdown(report);
		expect(md).toContain("**Verdict: PASS**");
		expect(md).toContain("| own_ada entries | 17 | 17 |");
		await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
		expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).verdict).toBe("pass");
		await pool.end();
	});

	it("is idempotent: a second import of the same snapshot changes nothing", async () => {
		const pool = await db.freshDatabase();
		const reader = new SnapshotReader(join(dir, "snapshot"));
		const objects = new FsObjectStore(join(dir, "s3-b"));
		await importSnapshot(pool, reader, options(objects));
		const tables = ["tenants", "pi_entries", "pi_tasks", "legacy_rows", "secret_envelopes", "external_operations", "due_work", "objects", "chats"];
		const before = await Promise.all(tables.map(async (t) => (await pool.query(`SELECT count(*) n FROM pim.${t}`)).rows[0].n));
		await importSnapshot(pool, reader, options(objects));
		const after = await Promise.all(tables.map(async (t) => (await pool.query(`SELECT count(*) n FROM pim.${t}`)).rows[0].n));
		expect(after).toEqual(before);
		expect((await auditImport(pool, reader, objects, { cutoverId: "cut-1" })).ok).toBe(true);
		await pool.end();
	});

	it("the auditor catches corruption: a flipped object byte, a dropped entry, a changed settings key", async () => {
		const pool = await db.freshDatabase();
		const reader = new SnapshotReader(join(dir, "snapshot"));
		const objects = new FsObjectStore(join(dir, "s3-c"));
		await importSnapshot(pool, reader, options(objects));
		await objects.put("BLOBS", "own_ada/img_1.png", Buffer.from("tampered"), null);
		await pool.query("DELETE FROM pim.pi_entries WHERE tenant_id='own_ada' AND id = (SELECT max(id) FROM pim.pi_entries WHERE tenant_id='own_ada' AND conversation_id=1)");
		await pool.query(`UPDATE pim.legacy_rows SET row = jsonb_set(row, '{value}', '"{\\"timeZone\\":\\"Europe/Madrid\\",\\"approvalPolicy\\":\\"auto\\",\\"theme\\":null}"') WHERE table_name='pim_meta' AND pk='settings'`);
		const audit = await auditImport(pool, reader, objects, { cutoverId: "cut-1" });
		const failed = audit.checks.filter((c) => !c.ok).map((c) => c.name);
		expect(audit.ok).toBe(false);
		expect(failed).toEqual(expect.arrayContaining(["count own_ada entries", expect.stringContaining("SHA-256"), expect.stringContaining("nothing unset became an override")]));
		await pool.end();
	});

	it("refuses a snapshot whose files were altered, and a second cutover in a used database", async () => {
		const pool = await db.freshDatabase();
		const copy = join(dir, "snapshot-bad");
		await buildLegacySnapshot(copy);
		await writeFile(join(copy, "oauth_kv.json"), "[]");
		await expect(importSnapshot(pool, new SnapshotReader(copy), options(new FsObjectStore(join(dir, "s3-d"))))).rejects.toThrow(/does not match its manifest/);
		await importSnapshot(pool, new SnapshotReader(join(dir, "snapshot")), options(new FsObjectStore(join(dir, "s3-e"))));
		await expect(importSnapshot(pool, new SnapshotReader(join(dir, "snapshot")), { ...options(new FsObjectStore(join(dir, "s3-e"))), cutoverId: "cut-2" })).rejects.toThrow(/already owns this database/);
		await pool.end();
	});
});
