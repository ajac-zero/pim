import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGrant, revokeGrant } from "../src/authz.ts";
import { withTenant } from "../src/db.ts";
import { acquireLease } from "../src/partitions.ts";
import { type Effector, EffectFailed, getOp, listUnresolved, requestCancel, resolveOp, runOp, settleCancel, type OpSpec } from "../src/ops.ts";
import { createTestDb, type TestDb } from "./support/db.ts";
import { tenantWithPeople } from "./support/people.ts";

let db: TestDb;
beforeAll(async () => {
	db = await createTestDb();
});
afterAll(async () => db.close());

const counting = (impl?: Effector["send"]) => {
	const sent: string[] = [];
	const effector: Effector = {
		send: async (key, request, record) => {
			sent.push(key);
			return impl ? impl(key, request, record) : { ok: true, key };
		},
	};
	return { sent, effector };
};
const spec = (tenantId: string, opId: string, extra: Partial<OpSpec> = {}): OpSpec => ({ tenantId, opId, kind: "email.send", idempotent: false, request: { to: "x" }, ...extra });

describe("external operations", () => {
	it("sends once under a stable id and returns the stored receipt on every later call", async () => {
		const t = await tenantWithPeople(db);
		const { sent, effector } = counting();
		const first = await runOp({ pool: db.runtime }, spec(t.tenantId, "op1"), effector);
		const again = await runOp({ pool: db.runtime }, spec(t.tenantId, "op1"), effector);
		expect(first.state).toBe("succeeded");
		expect(again.state).toBe("succeeded");
		expect(again.receipt).toEqual(first.receipt);
		expect(sent).toEqual(["op1"]);
	});

	it("never re-sends a non-idempotent effect whose outcome is unknown: reconciliation-needed until resolved", async () => {
		const t = await tenantWithPeople(db);
		const { sent, effector } = counting(async () => {
			throw new Error("socket hang up");
		});
		expect((await runOp({ pool: db.runtime }, spec(t.tenantId, "amb"), effector)).state).toBe("reconciliation_needed");
		expect((await runOp({ pool: db.runtime }, spec(t.tenantId, "amb"), effector)).state).toBe("reconciliation_needed");
		expect(sent.length).toBe(1);
		expect((await listUnresolved(db.runtime, t.tenantId)).map((o) => o.op_id)).toContain("amb");
		await resolveOp(db.runtime, t.tenantId, "amb", "succeeded", { by: "operator", evidence: "provider shows one delivery" });
		expect((await getOp(db.runtime, t.tenantId, "amb"))?.state).toBe("succeeded");
	});

	it("re-sends an idempotent effect under the same key after an unknown outcome", async () => {
		const t = await tenantWithPeople(db);
		let fail = true;
		const { sent, effector } = counting(async (key) => {
			if (fail) {
				fail = false;
				throw new Error("timeout");
			}
			return { key };
		});
		expect((await runOp({ pool: db.runtime }, spec(t.tenantId, "idem", { idempotent: true }), effector)).state).toBe("effecting");
		expect((await runOp({ pool: db.runtime }, spec(t.tenantId, "idem", { idempotent: true }), effector)).state).toBe("succeeded");
		expect(sent).toEqual(["idem", "idem"]);
	});

	it("records a failure that definitely did not happen as failed", async () => {
		const t = await tenantWithPeople(db);
		const { effector } = counting(async () => {
			throw new EffectFailed("400 bad address");
		});
		expect((await runOp({ pool: db.runtime }, spec(t.tenantId, "bad"), effector)).state).toBe("failed");
	});

	it("adopts a remote session by its persisted handle after a crash instead of starting a second paid run", async () => {
		const t = await tenantWithPeople(db);
		let started = 0;
		const crashing: Effector = {
			send: async (_key, _req, record) => {
				started++;
				await record({ remoteSession: "sess-42" });
				throw new Error("runner died");
			},
			adopt: async (handle) => ({ state: handle.remoteSession === "sess-42" ? "succeeded" : "failed", receipt: { adopted: handle.remoteSession } }),
		};
		expect((await runOp({ pool: db.runtime }, spec(t.tenantId, "code1", { kind: "coding.run" }), crashing)).state).toBe("reconciliation_needed");
		// A crash before the error is observed: put it back to `effecting` with its handle, as a killed process leaves it.
		await db.admin.query("UPDATE app.external_ops SET state = 'effecting' WHERE op_id = 'code1'");
		const after = await runOp({ pool: db.runtime }, spec(t.tenantId, "code1", { kind: "coding.run" }), crashing);
		expect(after.state).toBe("succeeded");
		expect(after.receipt).toEqual({ adopted: "sess-42" });
		expect(started).toBe(1);
	});

	it("revalidates the capability when the effect starts: a revoked grant sends nothing", async () => {
		const t = await tenantWithPeople(db);
		const admin = await t.login("admin");
		await createGrant(db.gate, admin, { grantId: "gr", subjectUser: "ada", kind: "coding", pools: ["p"] });
		const { sent, effector } = counting();
		await revokeGrant(db.gate, admin, "gr");
		const result = await runOp({ pool: db.runtime }, spec(t.tenantId, "denied", { grantId: "gr", kind: "coding.run" }), effector);
		expect(result.state).toBe("failed");
		expect(result.receipt).toEqual({ denied: "grant_revoked_or_expired" });
		expect(sent).toEqual([]);
	});

	it("refuses to start an effect for an owner whose lease is gone", async () => {
		const t = await tenantWithPeople(db);
		const { provisionTenant } = await import("../src/partitions.ts");
		const { homePartitionId } = await provisionTenant(db.maint, t.tenantId);
		const lease = (await acquireLease(db.runtime, t.tenantId, homePartitionId, "o1", 300))!;
		const { sent, effector } = counting();
		await new Promise((r) => setTimeout(r, 400));
		await expect(runOp({ pool: db.runtime, lease }, spec(t.tenantId, "stale"), effector)).rejects.toThrow(/Ownership lost/);
		expect(sent).toEqual([]);
		const fresh = (await acquireLease(db.runtime, t.tenantId, homePartitionId, "o2", 60_000))!;
		expect((await runOp({ pool: db.runtime, lease: fresh }, spec(t.tenantId, "fresh"), effector)).state).toBe("succeeded");
		void withTenant;
	});

	it("tracks cancellation as requested, then confirmed, uncertain or too late", async () => {
		const t = await tenantWithPeople(db);
		for (const [name, outcome, expected] of [["c1", "confirmed", "cancelled"], ["c2", "uncertain", "cancel_uncertain"], ["c3", "too_late", "succeeded"]] as const) {
			await runOp({ pool: db.runtime }, spec(t.tenantId, name, { idempotent: true }), { send: async () => { throw new Error("pending"); } });
			expect(await requestCancel(db.runtime, t.tenantId, name)).toBe("cancel_requested");
			expect(await settleCancel(db.runtime, t.tenantId, name, outcome)).toBe(expected);
		}
		// A cancel-uncertain operation is not retried by runOp.
		const { sent, effector } = counting();
		expect((await runOp({ pool: db.runtime }, spec(t.tenantId, "c2", { idempotent: true }), effector)).state).toBe("cancel_uncertain");
		expect(sent).toEqual([]);
	});
});
