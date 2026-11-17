// What a real v1 Worker exports looks different from the hand-written fixture in four ways the first rehearsal on a real export found: pi-durable stores a task's
// `kind` as JSON text (`"pi.tool"` with its quotes), a tool task keeps its call id and arguments inside `input` and its checkpoint, a trigger's lifecycle is `enabled`
// (not `active`), and `cf_agents_jobs.time` is milliseconds. Each made the quiescence plan or the audit pass vacuously; these rows are copied from that export.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planQuiescence } from "../src/migration/quiesce.ts";
import { SnapshotReader, SnapshotWriter } from "../src/migration/snapshot.ts";
import { readPi } from "../src/migration/split.ts";

const CUTOVER = 1794888000000 - 3_600_000;
const owner = "o_realshape";

const assistant = { model: [{ role: "assistant", content: [{ type: "toolCall", id: "tool:1:abc", name: "http_request", arguments: { method: "GET", url: "https://example.com" } }] }], kind: "pi.assistant", id: 149, conversationId: 139 };
const toolTask = { id: 150, conversationId: 139, kind: "pi.tool", input: { assistant: 149, callId: "tool:1:abc" }, owner: 147, state: { status: "waiting", checkpoint: { phase: "execute", arguments: { method: "GET", url: "https://example.com" }, replay: "safe" } }, memos: { approval: "ap1" } };
const spec = (source: unknown) => JSON.stringify({ version: 1, label: "Weekly", source });

async function snapshot() {
	const dir = await mkdtemp(join(tmpdir(), "pim-real-"));
	const writer = new SnapshotWriter(dir);
	const table = (columns: string[], rows: Record<string, unknown>[]) => ({ columns, rows: rows as never });
	await writer.dump({
		class: "Pim",
		name: owner,
		alarm: null,
		kv: [],
		tables: {
			pi_tasks: table(["id", "conversation_id", "kind", "status", "abort_requested", "background", "record"], [{ id: 150, conversation_id: 139, kind: '"pi.tool"', status: "waiting", abort_requested: 0, background: 0, record: JSON.stringify(toolTask) }]),
			pi_entries: table(["id", "conversation_id", "head", "commit_seq", "record"], [{ id: 149, conversation_id: 139, head: null, commit_seq: 278, record: JSON.stringify(assistant) }]),
			pi_documents: table(["id", "kind", "key_value"], [{ id: 2, kind: '"pi.live"', key_value: '""' }]),
			pi_submissions: table(["id", "request_id"], [{ id: 8, request_id: '"c803b011"' }]),
			pim_approvals: table(["id", "action", "status", "call_id", "result", "decided_at", "on_timeout"], [{ id: "ap1", action: "http_request", status: "pending", call_id: "tool:1:abc", result: null, decided_at: null, on_timeout: "deny" }]),
			pim_triggers: table(["id", "revision", "lifecycle", "created_at"], [{ id: "t1", revision: 1, lifecycle: "enabled", created_at: CUTOVER - 86_400_000 }]),
			pim_trigger_revisions: table(["trigger_id", "revision", "spec"], [{ trigger_id: "t1", revision: 1, spec: spec({ kind: "time", schedule: "cron", expression: "0 9 * * 1", timeZone: "UTC" }) }]),
			cf_agents_jobs: table(["id", "fn", "time", "payload"], [{ id: "future", fn: "runTriggerTick", time: CUTOVER + 3_600_000, payload: null }, { id: "past", fn: "keepAlive", time: CUTOVER - 1000, payload: null }]),
		},
	});
	await writer.finish({ cutoverAt: CUTOVER, exportedAt: CUTOVER, source: "real", keyMaterial: [] });
	return new SnapshotReader(dir);
}

describe("a real v1 export's shapes", () => {
	it("reads pi-durable's JSON-text scalar columns bare", async () => {
		const pi = readPi(await (await snapshot()).dump("Pim", owner));
		expect(pi.tasks[0]!.kind).toBe("pi.tool");
		expect(pi.documents[0]).toMatchObject({ kind: "pi.live", key_value: "" });
		expect(pi.submissions[0]!.request_id).toBe("c803b011");
	});

	it("holds a waiting tool task and names its tool and arguments from the real record", async () => {
		const plan = await planQuiescence(await snapshot(), CUTOVER);
		expect(plan.taskHolds.map((h) => h.taskId)).toEqual([150]);
		const op = plan.operations.find((o) => o.idempotencyKey === `tool:${owner}:150`)!;
		expect(op).toMatchObject({ kind: "tool:http_request", status: "needs_reconciliation", payload: { callId: "tool:1:abc", approval: "ap1" } });
		expect(op.payload.argsSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("plans an enabled time trigger from the cutover on, and reads agents job times as milliseconds", async () => {
		const plan = await planQuiescence(await snapshot(), CUTOVER);
		const trigger = plan.dueWork.find((d) => d.kind === "trigger:cron")!;
		expect(trigger).toMatchObject({ state: "armed", key: "t1" });
		expect(trigger.nextDueAtMs).toBeGreaterThan(CUTOVER);
		expect(trigger.nextDueAtMs).toBeLessThan(CUTOVER + 8 * 86_400_000);
		expect(plan.dueWork.find((d) => d.key === "future")).toMatchObject({ state: "armed", nextDueAtMs: CUTOVER + 3_600_000 });
		expect(plan.dueWork.find((d) => d.key === "past")).toMatchObject({ state: "dropped", missed: [CUTOVER - 1000] });
	});
});
