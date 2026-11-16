import { copyFileSync, mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdAllocator } from "../src/ids.ts";
import { listTables, readRows } from "../src/migrate/export-api.ts";
import { FsBlobStore } from "../src/migrate/blobs.ts";
import { BundleReader } from "../src/migrate/format.ts";
import { importBundle } from "../src/migrate/import.ts";
import { pullExport } from "../src/migrate/pull.ts";
import { verifyImport } from "../src/migrate/verify.ts";
import { KeyRing } from "../src/secrets.ts";
import { createTestDb, type TestDb } from "./support/db.ts";
import { buildLegacyExport, type LegacyFixture } from "./support/legacy.ts";

let db: TestDb;
let fx: LegacyFixture;
beforeAll(async () => {
	db = await createTestDb();
	fx = await buildLegacyExport();
}, 120_000);
afterAll(async () => db.close());

/** Loads rows into a table, creating it from the first row's keys. */
function load(sqlite: DatabaseSync, table: string, rows: Record<string, unknown>[], ddl?: string) {
	if (rows.length === 0 && !ddl) return;
	sqlite.exec(ddl ?? `CREATE TABLE ${table} (${Object.keys(rows[0]!).map((k) => `"${k}"`).join(", ")})`);
	for (const row of rows) sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).map((k) => `"${k}"`).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
}

/** The old system, as the export Worker would see it: each Durable Object's SQLite, read through the same dump API. */
function legacySystem() {
	const bundle = new BundleReader(fx.dir);
	const root = join(fx.dir, "..");
	const dbs = new Map<string, DatabaseSync>();
	const open = (key: string, make: (d: DatabaseSync) => Promise<void> | void) => {
		const d = new DatabaseSync(":memory:");
		dbs.set(key, d);
		return make(d);
	};
	return (async () => {
		await open("directory:directory", async (d) => load(d, "accounts", await bundle.all("directory/accounts.ndjson")));
		for (const tenant of fx.tenants) {
			const copy = join(mkdtempSync(join(tmpdir(), "pim-do-")), `${tenant}.sqlite`);
			copyFileSync(join(root, `${tenant}.sqlite`), copy);
			const pim = new DatabaseSync(copy);
			dbs.set(`pim:${tenant}`, pim);
			for (const file of bundle.files(`tenants/${tenant}/host`)) load(pim, file.split("/").pop()!.replace(".ndjson", ""), await bundle.all(file));
			if (tenant === "ada") {
				load(pim, "pim_credentials", [{ provider: "openai", credential: "sk-legacy-plaintext-value" }]);
				load(pim, "pim_coding_threads", [{ thread_id: "ct-live" }, { thread_id: "ct-old" }]);
				load(pim, "cf_agents_jobs", [{ id: "job1" }]);
			}
			await open(`auth:${tenant}`, async (d) => {
				for (const t of ["auth_passkeys", "auth_tokens", "auth_recovery_codes"]) {
					const rows = await bundle.all(`tenants/${tenant}/auth/${t}.ndjson`);
					load(d, t, rows, rows.length === 0 ? `CREATE TABLE ${t} (id TEXT)` : undefined);
				}
			});
		}
		for (const [id, state, harness] of [["ct-live", "running", "claude-code"], ["ct-old", "done", "codex"]]) await open(`thread:${id}`, (d) => load(d, "coding_thread", [{ thread_id: id, space: "ada", state, harness, provider_kind: "agent", orb: JSON.stringify({ threadId: `remote-${id}` }), workspace_ref: null, pool_id: null, repo_url: "org/app", branch: "b", base_sha: "abc", orb_last_message: null, orb_cost_usd: 1.5, updated_at: 5 }]));
		const objects = new Map<string, Buffer>(fx.blobs.map((b, i) => [`ada/file-${i}`, b.body]));
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if ((init?.headers as Record<string, string>).authorization !== "Bearer export-token") return new Response("no", { status: 401 });
			const m = /^\/__export\/do\/([a-z]+)\/([^/]+)\/(tables|rows)$/.exec(url.pathname);
			if (m) {
				const d = dbs.get(`${m[1]}:${decodeURIComponent(m[2]!)}`);
				if (!d) return new Response("none", { status: 404 });
				const sql = { exec: (q: string, ...b: unknown[]) => ({ toArray: () => d.prepare(q).all(...(b as never[])) as Record<string, unknown>[] }) };
				return Response.json(m[3] === "tables" ? listTables(sql) : readRows(sql, url.searchParams.get("table")!, Number(url.searchParams.get("after")), Number(url.searchParams.get("limit"))));
			}
			if (/^\/__export\/r2\/blobs$/.test(url.pathname)) return Response.json({ objects: [...objects].map(([key, body]) => ({ key, size: body.length })), cursor: null });
			if (/^\/__export\/r2\/artifacts$/.test(url.pathname)) return Response.json({ objects: [], cursor: null });
			const o = /^\/__export\/r2\/blobs\/(.+)$/.exec(url.pathname);
			if (o) return new Response(objects.get(decodeURIComponent(o[1]!)) as never);
			return new Response("x", { status: 404 });
		}) as typeof fetch;
		return { fetchImpl, dbs };
	})();
}

describe("export runtime API and puller", () => {
	it("dumps only what it should: no scheduler rows, no writes, no arbitrary SQL", async () => {
		const { dbs } = await legacySystem();
		const sql = { exec: (q: string, ...b: unknown[]) => ({ toArray: () => dbs.get("pim:ada")!.prepare(q).all(...(b as never[])) as Record<string, unknown>[] }) };
		const tables = listTables(sql);
		expect(tables.find((t) => t.name === "cf_agents_jobs")?.rows).toBe(-1);
		expect(() => readRows(sql, "cf_agents_jobs", 0, 10)).toThrow(/not exportable/);
		expect(() => readRows(sql, 'conversations"; DROP TABLE entries; --', 0, 10)).toThrow(/not exportable/);
		expect(() => readRows(sql, "no_such_table", 0, 10)).toThrow(/Unknown/);
		expect(readRows(sql, "entries", 0, 3).rows.length).toBe(3);
		expect(readRows(sql, "entries", 0, 3).next).not.toBeNull();
	});

	it("pulls a bundle from the export API, and that bundle imports and verifies exactly like the direct one", async () => {
		const { fetchImpl } = await legacySystem();
		const out = join(mkdtempSync(join(tmpdir(), "pim-pull-")), "bundle");
		const pulled = await pullExport({ base: "https://export", token: "export-token", out, exportKey: fx.exportKey, fetchImpl, fence: { maintenance: true } });
		expect(pulled).toEqual({ tenants: ["ada", "bob"], handles: 2, blobs: 2 });
		const bundle = new BundleReader(out);
		expect(await bundle.checkIntegrity()).toEqual([]);
		expect((await bundle.all("tenants/ada/host/pim_credentials.ndjson")).length).toBe(0);
		expect(bundle.has("tenants/ada/secrets.json")).toBe(true);
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(join(out, "tenants/ada/secrets.json"), "utf8")).not.toContain("sk-legacy");
		expect(bundle.files("tenants/ada/host").some((f) => f.includes("cf_agents"))).toBe(false);
		const ring = new KeyRing(Buffer.alloc(32, 5), 1);
		const blobs = new FsBlobStore(mkdtempSync(join(tmpdir(), "pim-blobs-")));
		const reports = await importBundle(bundle, { pool: db.maint, blobs, keyRing: ring, exportKey: fx.exportKey, importId: "pulled" });
		expect(reports.map((r) => r.status)).toEqual(["imported", "imported"]);
		const verdict = await verifyImport(bundle, { pool: db.maint, ids: new IdAllocator(db.runtime), blobs, keyRing: ring, exportKey: fx.exportKey });
		for (const check of verdict.checks) expect(check, `${check.tenant}: ${check.name} ${check.detail ?? ""}`).toMatchObject({ ok: true });
		// The live coding thread is held for reconciliation, never restarted.
		const op = (await db.admin.query("SELECT state, handle FROM app.external_ops WHERE op_id = 'import:coding.thread:ct-live'")).rows[0];
		expect(op.state).toBe("reconciliation_needed");
		expect(op.handle.orb).toContain("remote-ct-live");
	});
});
