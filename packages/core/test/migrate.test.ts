import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptCommand, decideApproval, fileApproval } from "../src/commands.ts";
import { withTenant } from "../src/db.ts";
import { IdAllocator } from "../src/ids.ts";
import { authenticate, signInWithRecoveryCode } from "../src/auth.ts";
import { FsBlobStore } from "../src/migrate/blobs.ts";
import { BundleReader } from "../src/migrate/format.ts";
import { activateTenant, importBundle, importTenant } from "../src/migrate/import.ts";
import { planTenant } from "../src/migrate/plan.ts";
import { verifyImport } from "../src/migrate/verify.ts";
import { KeyRing } from "../src/secrets.ts";
import { Runner } from "../src/runner.ts";
import { createTestDb, type TestDb } from "./support/db.ts";
import { scriptedModel, until } from "./support/harness.ts";
import { buildLegacyExport, type LegacyFixture } from "./support/legacy.ts";

let db: TestDb;
let fx: LegacyFixture;
beforeAll(async () => {
	db = await createTestDb(20);
	fx = await buildLegacyExport();
}, 120_000);
afterAll(async () => db.close());

const ring = new KeyRing(Buffer.alloc(32, 3), 1);
const blobDir = () => mkdtempSync(join(tmpdir(), "pim-blobs-"));

describe("export bundle -> empty target (dry run)", () => {
	it("imports a real pi-durable export, quiescent, and verifies every check", async () => {
		const blobs = new FsBlobStore(blobDir());
		const bundle = new BundleReader(fx.dir);
		const reports = await importBundle(bundle, { pool: db.maint, blobs, keyRing: ring, exportKey: fx.exportKey, importId: "dry-1" });
		expect(reports.map((r) => r.status)).toEqual(["imported", "imported"]);
		const ada = reports.find((r) => r.tenantId === "ada")!;
		// Home family (root + its fork), chat A + its two forks, the approval chat: three families.
		expect(ada.families).toBe(3);
		expect(ada.remapped).toEqual([{ kind: "chat", from: "1", to: "root" }]);
		expect(ada.unresolved.filter((u) => u.kind === "coding.thread").length).toBe(1);

		const ids = new IdAllocator(db.runtime);
		const verdict = await verifyImport(bundle, { pool: db.maint, ids, blobs, keyRing: ring, exportKey: fx.exportKey });
		for (const check of verdict.checks) expect(check, `${check.tenant}: ${check.name} ${check.detail ?? ""}`).toMatchObject({ ok: true });
		expect(verdict.checks.length).toBeGreaterThan(25);
		console.log(`dry-run verification: ${verdict.checks.length} checks, all passed`);
	});

	it("is idempotent, refuses a target that is not empty, and refuses a different bundle", async () => {
		const bundle = new BundleReader(fx.dir);
		const again = await importBundle(bundle, { pool: db.maint, importId: "dry-1", blobs: new FsBlobStore(blobDir()), keyRing: ring, exportKey: fx.exportKey });
		expect(again.map((r) => r.status)).toEqual(["skipped", "skipped"]);
		await withTenant(db.maint, "ada", (q) => q.run("UPDATE app.import_ledger SET checksum = 'other' WHERE tenant_id = 'ada'"));
		await expect(importTenant(bundle, "ada", { pool: db.maint, importId: "x" })).rejects.toThrow(/different bundle/);
		await withTenant(db.maint, "ada", (q) => q.run("DELETE FROM app.import_ledger WHERE tenant_id = 'ada'"));
		await expect(importTenant(bundle, "ada", { pool: db.maint, importId: "x" })).rejects.toThrow(/not empty/);
	});

	it("detects an altered bundle before writing anything", async () => {
		const copy = join(mkdtempSync(join(tmpdir(), "pim-tamper-")), "b");
		cpSync(fx.dir, copy, { recursive: true });
		const file = join(copy, "tenants/bob/pi/entries.ndjson");
		writeFileSync(file, readFileSync(file, "utf8").replace("hello root", "hello r00t"));
		const target = await createTestDb();
		await expect(importBundle(new BundleReader(copy), { pool: target.maint, importId: "t", exportKey: fx.exportKey, keyRing: ring, blobs: new FsBlobStore(blobDir()) })).rejects.toThrow(/integrity/);
		expect((await target.admin.query("SELECT count(*)::int AS n FROM app.tenants")).rows[0].n).toBe(0);
		await target.close();
	});

	it("fails closed when a record would cross a family", async () => {
		const copy = join(mkdtempSync(join(tmpdir(), "pim-cross-")), "b");
		cpSync(fx.dir, copy, { recursive: true });
		// Point a task of the home family at a conversation of another family: the split would sever it.
		const file = join(copy, "tenants/ada/pi/tasks.ndjson");
		const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const homeTask = rows.find((r) => JSON.parse(r.kind) === "pi.generation");
		const other = JSON.parse(readFileSync(join(copy, "tenants/ada/pi/conversations.ndjson"), "utf8").trim().split("\n").at(-1)!).id;
		const original = homeTask.conversation_id;
		expect(other).not.toBe(original);
		homeTask.conversation_id = 999_999;
		writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
		const plan = await planTenant(new BundleReader(copy), "ada");
		expect(plan.violations.some((v) => v.includes("conversation 999999 does not exist"))).toBe(true);
		homeTask.conversation_id = original;
		const toolRow = rows.find((r) => JSON.parse(r.kind) === "pi.tool");
		toolRow.conversation_id = other === toolRow.conversation_id ? original : other;
		writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
		const crossing = await planTenant(new BundleReader(copy), "ada");
		expect(crossing.violations.some((v) => /assistant entry \d+ is outside its family/.test(v))).toBe(true);
		homeTask.conversation_id = 999_999;
		writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
		const target = await createTestDb();
		const report = await importTenant(new BundleReader(copy), "ada", { pool: target.maint, importId: "x", exportKey: fx.exportKey, keyRing: ring, blobs: new FsBlobStore(blobDir()) });
		expect(report.status).toBe("refused");
		expect((await target.admin.query("SELECT count(*)::int AS n FROM app.tenants")).rows[0].n).toBe(0);
		await target.close();
	});
});

describe("after the import", () => {
	it("keeps legacy tokens and recovery codes working, and loses no unmapped host data", async () => {
		const principal = await authenticate(db.gate, "ada", fx.token);
		expect(principal).toMatchObject({ userId: "ada", role: "admin", via: "token" });
		expect(await authenticate(db.gate, "bob", fx.token)).toBeUndefined();
		const session = await signInWithRecoveryCode(db.gate, "ada", "ada", fx.recoveryCode);
		expect((await authenticate(db.gate, "ada", session!))?.role).toBe("admin");
		const kept = await withTenant(db.maint, "ada", (q) => q.all<{ table_name: string }>("SELECT DISTINCT table_name FROM app.legacy_rows WHERE tenant_id = 'ada' ORDER BY 1"));
		expect(kept.map((r) => r.table_name)).toEqual(expect.arrayContaining(["pim_goals", "pim_meta", "mapped:pim_approvals", "mapped:pim_sessions"]));
	});

	it("starts nothing until activated: nothing is claimable, and a schedule from the old system does not catch up", async () => {
		const m = scriptedModel();
		const runner = new Runner({ ownerId: "pre", steward: db.steward, deps: { pool: db.runtime, ids: new IdAllocator(db.runtime), harnessOptions: () => m.options() } });
		expect(await runner.claimOnce()).toBe(0);
		expect((await db.admin.query("SELECT count(*)::int AS n FROM app.timers")).rows[0].n).toBe(0);
	});

	it("resumes the work the old system left parked: the approval is decided in the new system, the owner wakes the tool, the run finishes; forks continue", async () => {
		const m = scriptedModel();
		const effects: string[] = [];
		const ids = new IdAllocator(db.runtime);
		const runner = new Runner({
			ownerId: "post",
			steward: db.steward,
			deps: {
				pool: db.runtime,
				ids,
				leaseTtlMs: 5000,
				pollMs: 25,
				harnessOptions: (lease) => {
					const registry = createRegistry();
					registry.install(
						defineExtension({
							name: "legacy",
							tools: [
								defineTool({
									name: "approve",
									description: "Needs approval",
									parameters: Type.Object({ id: Type.String() }),
									replay: "safe",
									execute: async (args, api) => {
										const filed = await fileApproval(db.runtime, { tenantId: lease.tenantId, partitionId: lease.partitionId, conversationId: api.conversationId, taskId: api.taskId, callId: api.callId });
										if (filed.status === "pending") return { control: { suspend: true } };
										effects.push(args.id);
										return { content: [{ type: "text", text: "done" }] };
									},
								}),
							],
						}),
					);
					return { models: m.models, registry };
				},
			},
		});
		m.faux.setResponses(Array.from({ length: 50 }, (_, i) => fauxAssistantMessage(`after-import ${i}`)));
		// The imported approval is pending, with the suspended task attached.
		const pending = (await db.admin.query("SELECT approval_id, task_id, status FROM app.approvals WHERE tenant_id = 'ada'")).rows[0];
		expect(pending).toMatchObject({ approval_id: "apr-legacy-1", status: "pending" });
		expect(pending.task_id).not.toBeNull();
		// The person decides in the new system, then the tenant is activated at the end of downtime.
		expect(await decideApproval(db.gate, { tenantId: "ada", approvalId: "apr-legacy-1", decidedBy: "ada", approve: true })).toBe("decided");
		await activateTenant(db.maint, "ada");
		// Continue a fork that only existed in the old system, by its public chat id.
		const forkChat = (await db.admin.query("SELECT chat_id, partition_id FROM app.chats WHERE tenant_id = 'ada' AND title = 'Fork of fork'")).rows[0];
		await acceptCommand(db.gate, { tenantId: "ada", commandId: "after-1", actor: "ada", kind: "chat.send", partitionId: forkChat.partition_id, payload: { chatId: forkChat.chat_id, content: "continue the deep fork" }, signal: { kind: "input" } });
		runner.start();
		await until(() => effects.length === 1, "the parked tool ran once after approval", 30_000);
		await until(async () => (await db.admin.query("SELECT count(*)::int AS n FROM rt.entries WHERE tenant_id = 'ada' AND record LIKE '%after-import%'")).rows[0].n >= 2, "the run finished and the fork continued", 30_000);
		expect(effects).toEqual(["x1"]);
		// The imported history is untouched and the new entries took fresh ids above every old one.
		const oldMax = Math.max(...readFileSync(join(fx.dir, "tenants/ada/pi/entries.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l).id));
		const fresh = (await db.admin.query("SELECT min(id) AS id FROM rt.entries WHERE tenant_id = 'ada' AND record LIKE '%after-import%'")).rows[0].id;
		expect(fresh).toBeGreaterThan(oldMax);
		await runner.drain();
	});
});
