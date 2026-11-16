import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Projector } from "../src/projections/projector.ts";
import { sidebarPage, transcriptPage } from "../src/projections/snapshots.ts";
import { type Database, POSTGRES, startPostgres } from "./support/infra.ts";
import { assistant, commit, entry, reset, user } from "./support/fixtures.ts";

const live = POSTGRES ? describe : describe.skip;

live("projections over PostgreSQL", () => {
	let db: Database;
	beforeAll(async () => {
		db = await startPostgres();
	});
	afterAll(() => db?.stop());
	beforeEach(() => reset(db.pool));

	const views = async () => ({
		transcript: (await db.pool.query("SELECT stream_kind, chat_id, entry_id, position, partial, message, ui_state FROM pim_projection.chat_transcript_projection ORDER BY tenant_id, chat_id, position")).rows,
		sidebar: (await db.pool.query("SELECT tenant_id, chat_id, title, busy, unread, stalled, updated_at, summary FROM pim_projection.sidebar_session_projection ORDER BY tenant_id, chat_id")).rows,
		coding: (await db.pool.query("SELECT tenant_id, thread_id, title, harness, state, running, unread, updated_at, summary FROM pim_projection.coding_thread_projection ORDER BY tenant_id, thread_id")).rows,
	});

	async function history() {
		await commit(db.pool, "p1", 1, "t1", [
			{ kind: "chat.entry", chatId: "c1", entry: user(10, "hello") },
			{ kind: "chat.meta", chatId: "c1", title: "Greeting", busy: true, updatedAt: 5 },
		]);
		await commit(db.pool, "p1", 2, "t1", [{ kind: "chat.entry", chatId: "c1", entry: assistant(11, "Hi th"), partial: true }]);
		await commit(db.pool, "p1", 4, "t1", [
			{ kind: "chat.entry", chatId: "c1", entry: assistant(11, "Hi there", [{ type: "toolCall", id: "call-1", name: "send_to_user", arguments: { a: 1 } }]) },
			{ kind: "chat.entry", chatId: "c1", entry: entry(12, "pi.message", { role: "toolResult", toolCallId: "call-1", toolName: "send_to_user", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1012 }) },
			{ kind: "chat.entry", chatId: "c1", entry: entry(13, "pi.compaction", { role: "user", content: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nThey said hello.\n</summary>", timestamp: 1013 }) },
			{ kind: "chat.ui_state", chatId: "c1", entryId: "11", block: "form", state: { picked: 2 } },
			{ kind: "chat.meta", chatId: "c1", busy: false, stalled: false, updatedAt: 9, summary: { agent: "Majordomo" } },
		]);
		await commit(db.pool, "p2", 1, "t1", [
			{ kind: "chat.entry", chatId: "c2", entry: user(20, "other chat") },
			{ kind: "chat.meta", chatId: "c2", title: "Second", updatedAt: 7 },
			{ kind: "coding.thread", threadId: "k1", title: "Fix bug", harness: "pi", state: "working", running: true, updatedAt: 8 },
			{ kind: "chat.entry", stream: "coding", chatId: "k1", entry: assistant(30, "patched") },
		]);
		await commit(db.pool, "p9", 1, "t2", [{ kind: "chat.entry", chatId: "c1", entry: user(10, "tenant two's own c1") }]);
	}

	it("projects messages with the shared transcript's fidelity, replacing a partial with its final message", async () => {
		await history();
		const projector = new Projector(db.pool);
		await projector.drainAll();
		const page = await transcriptPage(db.pool, "t1", "c1");
		expect(page.messages.map((message) => [message.id, message.role, message.partial])).toEqual([
			["10", "user", false],
			["11", "assistant", false],
			["12", "tool", false],
			["13", "notice", false],
		]);
		expect(page.messages[1]!.parts.map((part) => part.type)).toEqual(["text", "tool-call"]);
		expect((page.messages[1]!.parts[0] as { text: string }).text).toBe("Hi there");
		expect(page.messages[2]!.parts[0]).toMatchObject({ type: "tool-result", id: "call-1", error: false });
		expect(page.messages[3]).toMatchObject({ compaction: true, parts: [{ type: "text", text: "They said hello." }] });
		expect(page.messages[1]!.uiState).toEqual({ form: { picked: 2 } });
		// Tenant two's chat with the same id is its own.
		expect((await transcriptPage(db.pool, "t2", "c1")).messages).toHaveLength(1);
		// The coding thread's transcript is separate from chats'.
		expect((await transcriptPage(db.pool, "t1", "k1", { kind: "coding" })).messages.map((m) => m.id)).toEqual(["30"]);
	});

	it("is idempotent: applying commits again, from one projector or two at once, changes nothing", async () => {
		await history();
		const a = new Projector(db.pool);
		const b = new Projector(db.pool);
		const applied = await Promise.all([a.drain("p1"), b.drain("p1"), a.drain("p2"), b.drain("p2"), a.drain("p9")]);
		expect(applied.reduce((sum, n) => sum + n, 0)).toBe(5);
		const first = await views();
		const log = (await db.pool.query("SELECT count(*)::int AS n FROM pim_projection.live_event_log")).rows[0].n;
		expect(await a.drainAll()).toBe(0);
		// Even forcing the same commit through again is a no-op.
		const rows = (await db.pool.query("SELECT partition_id, commit_seq, tenant_id, payload, created_at FROM pim_runtime.runtime_outbox WHERE partition_id = 'p1'")).rows;
		for (const row of rows) expect(await a.apply({ partitionId: row.partition_id, commitSeq: Number(row.commit_seq), tenantId: row.tenant_id, events: row.payload.events, createdAt: row.created_at })).toBe(false);
		expect(await views()).toEqual(first);
		expect((await db.pool.query("SELECT count(*)::int AS n FROM pim_projection.live_event_log")).rows[0].n).toBe(log);
		// Stream seqs are dense per stream.
		const seqs = (await db.pool.query("SELECT array_agg(stream_seq ORDER BY stream_seq) AS s FROM pim_projection.live_event_log WHERE tenant_id = 't1' AND stream_key = 'chat:c1'")).rows[0].s.map(Number);
		expect(seqs).toEqual(seqs.map((_: number, index: number) => index + 1));
	});

	it("rebuilds identical views from the outbox alone, with no effect repeated", async () => {
		await history();
		const projector = new Projector(db.pool);
		await projector.drainAll();
		const before = await views();
		const outbox = (await db.pool.query("SELECT * FROM pim_runtime.runtime_outbox ORDER BY partition_id, commit_seq")).rows;
		await db.pool.query("INSERT INTO pim_runtime.effects_ledger (what) VALUES ('model call billed once'), ('tool ran once')");
		// Truncate every projection table, as an operator would, then replay.
		await db.pool.query("TRUNCATE pim_projection.chat_transcript_projection, pim_projection.sidebar_session_projection, pim_projection.coding_thread_projection, pim_projection.live_event_log, pim_projection.live_stream_heads, pim_projection.projection_applied, pim_projection.projection_watermarks");
		expect(await views()).toEqual({ transcript: [], sidebar: [], coding: [] });
		await projector.drainAll();
		expect(await views()).toEqual(before);
		// The rebuild command does the same in one step.
		expect(await projector.rebuild()).toBe(5);
		expect(await views()).toEqual(before);
		// Only projections were written: the outbox is byte-identical and the effects ledger untouched.
		expect((await db.pool.query("SELECT * FROM pim_runtime.runtime_outbox ORDER BY partition_id, commit_seq")).rows).toEqual(outbox);
		expect((await db.pool.query("SELECT what FROM pim_runtime.effects_ledger ORDER BY id")).rows.map((row) => row.what)).toEqual(["model call billed once", "tool ran once"]);
	});

	it("reports projection lag in commits and in age", async () => {
		let now = Date.parse("2026-01-01T00:00:10Z");
		const projector = new Projector(db.pool, { now: () => now });
		await commit(db.pool, "p1", 1, "t1", [{ kind: "chat.meta", chatId: "c1", title: "a" }]);
		await commit(db.pool, "p1", 5, "t1", [{ kind: "chat.meta", chatId: "c1", title: "b" }]);
		await commit(db.pool, "p1", 9, "t1", [{ kind: "chat.meta", chatId: "c1", title: "c" }]);
		await db.pool.query("UPDATE pim_runtime.runtime_outbox SET created_at = '2026-01-01T00:00:04Z' WHERE commit_seq > 1");
		await projector.apply({ partitionId: "p1", commitSeq: 1, tenantId: "t1", events: [{ kind: "chat.meta", chatId: "c1", title: "a" }], createdAt: new Date() });
		expect(await projector.lag()).toEqual([{ partitionId: "p1", maxCommitSeq: 9, projectedSeq: 1, lagCommits: 8, oldestUnprojectedAgeMs: 6000 }]);
		now += 1000;
		await projector.drainAll();
		expect(await projector.lag()).toEqual([{ partitionId: "p1", maxCommitSeq: 9, projectedSeq: 9, lagCommits: 0, oldestUnprojectedAgeMs: 0 }]);
	});

	it("pages the sidebar and transcripts, and a page's liveCursor is the head it reflects", async () => {
		const events = Array.from({ length: 7 }, (_, index) => ({ kind: "chat.meta" as const, chatId: `c${index}`, title: `Chat ${index}`, updatedAt: 100 + (index % 3) }));
		for (const [index, event] of events.entries()) await commit(db.pool, "p1", index + 1, "t1", [event]);
		for (let id = 1; id <= 5; id++) await commit(db.pool, "p1", 100 + id, "t1", [{ kind: "chat.entry", chatId: "long", entry: user(id, `m${id}`) }]);
		await new Projector(db.pool).drainAll();
		const seen: string[] = [];
		let after: string | null = null;
		let pages = 0;
		do {
			const page = await sidebarPage(db.pool, "t1", { after, limit: 3 });
			seen.push(...page.sessions.map((row) => row.chatId));
			after = page.nextAfter;
			expect(page.liveCursor).toBe(7);
			pages++;
		} while (after);
		expect(pages).toBe(3);
		expect(new Set(seen).size).toBe(7);
		const [first] = (await sidebarPage(db.pool, "t1", { limit: 1 })).sessions;
		expect(first!.updatedAt).toBe(102);
		const newest = await transcriptPage(db.pool, "t1", "long", { limit: 2 });
		expect(newest.messages.map((m) => m.id)).toEqual(["4", "5"]);
		expect(newest.liveCursor).toBe(5);
		const older = await transcriptPage(db.pool, "t1", "long", { limit: 2, before: newest.nextBefore });
		expect(older.messages.map((m) => m.id)).toEqual(["2", "3"]);
		expect((await transcriptPage(db.pool, "t1", "long", { limit: 2, before: older.nextBefore })).nextBefore).toBeNull();
	});
});
