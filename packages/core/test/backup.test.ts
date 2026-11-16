import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticate } from "../src/auth.ts";
import { IdAllocator } from "../src/ids.ts";
import { backupDatabase, restoreDatabase, verifyAgainstManifest, readBackupManifest } from "../src/migrate/backup.ts";
import { FsBlobStore, S3BlobStore, signV4 } from "../src/migrate/blobs.ts";
import { BundleReader } from "../src/migrate/format.ts";
import { importBundle } from "../src/migrate/import.ts";
import { verifyImport } from "../src/migrate/verify.ts";
import { KeyRing } from "../src/secrets.ts";
import { createTestDb, type TestDb } from "./support/db.ts";
import { buildLegacyExport, type LegacyFixture } from "./support/legacy.ts";

let source: TestDb;
let fx: LegacyFixture;
beforeAll(async () => {
	source = await createTestDb();
	fx = await buildLegacyExport();
}, 120_000);
afterAll(async () => source.close());

const ring = new KeyRing(Buffer.alloc(32, 3), 1);

describe("backup and restore", () => {
	it("restores a backup into an empty target and proves it: every table's digest, then the same verification the import passed", async () => {
		const blobs = new FsBlobStore(mkdtempSync(join(tmpdir(), "pim-blobs-")));
		await importBundle(new BundleReader(fx.dir), { pool: source.maint, blobs, keyRing: ring, exportKey: fx.exportKey, importId: "b1" });
		const dir = mkdtempSync(join(tmpdir(), "pim-backup-"));
		const manifest = await backupDatabase(source.admin, dir);
		expect(manifest.tables["rt.entries"]!.rows).toBeGreaterThan(10);
		expect(manifest.keyVersionsInUse).toEqual([1]);

		const target = await createTestDb();
		try {
			const result = await restoreDatabase(target.admin, dir);
			expect(result.mismatches).toEqual([]);
			expect(result.restored).toBeGreaterThan(100);
			// A target with rows is refused.
			await expect(restoreDatabase(target.admin, dir)).rejects.toThrow(/not empty/);
			expect(await verifyAgainstManifest(target.admin, readBackupManifest(dir))).toEqual([]);
			// The restored system is the imported one: sign-in works, and the whole import verification passes against it.
			expect((await authenticate(target.gate, "ada", fx.token))?.role).toBe("admin");
			const verdict = await verifyImport(new BundleReader(fx.dir), { pool: target.maint, ids: new IdAllocator(target.runtime), blobs, keyRing: ring, exportKey: fx.exportKey });
			for (const check of verdict.checks) expect(check, check.name).toMatchObject({ ok: true });
			// A flipped byte is caught.
			await target.admin.query("UPDATE rt.entries SET record = replace(record, 'hello', 'hellp') WHERE id = (SELECT min(id) FROM rt.entries WHERE record LIKE '%hello%')");
			expect((await verifyAgainstManifest(target.admin, readBackupManifest(dir))).length).toBe(1);
			// Identity columns continue after the restore.
			await target.admin.query("INSERT INTO app.audit (tenant_id, actor, action, outcome) VALUES ('ada', 'x', 'y', 'ok')");
		} finally {
			await target.close();
		}
	});
});

describe("S3 object store", () => {
	it("signs requests as AWS Signature V4 does (the documented GET Object example)", () => {
		const authorization = signV4({
			method: "GET",
			host: "examplebucket.s3.amazonaws.com",
			path: "/test.txt",
			headers: { range: "bytes=0-9", "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "x-amz-date": "20130524T000000Z" },
			payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			region: "us-east-1",
			service: "s3",
			accessKeyId: "AKIAIOSFODNN7EXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			amzDate: "20130524T000000Z",
		});
		expect(authorization).toContain("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
	});

	it("puts, gets and heads objects over HTTP with a signed request", async () => {
		const store = new Map<string, Buffer>();
		const seen: string[] = [];
		const server = createServer((req, res) => {
			seen.push(String(req.headers.authorization).slice(0, 16));
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const key = req.url!;
				if (req.method === "PUT") return void (store.set(key, Buffer.concat(chunks)), res.writeHead(200).end());
				const body = store.get(key);
				if (!body) return void res.writeHead(404).end();
				res.writeHead(200, { "content-length": body.length }).end(req.method === "HEAD" ? undefined : body);
			});
		}).listen(0);
		const { port } = server.address() as { port: number };
		const s3 = new S3BlobStore({ endpoint: `http://127.0.0.1:${port}`, bucket: "pim", accessKeyId: "id", secretAccessKey: "secret" });
		await s3.put("ada/abc def", Buffer.from("hello"), "text/plain");
		expect((await s3.get("ada/abc def"))?.toString()).toBe("hello");
		expect(await s3.head("ada/abc def")).toEqual({ size: 5 });
		expect(await s3.get("nope")).toBeUndefined();
		expect(seen.every((a) => a.startsWith("AWS4-HMAC-SHA256"))).toBe(true);
		server.close();
	});
});
