import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OutboxSource, tableOutboxSource } from "../src/projections/outbox-source.ts";
import { Projector } from "../src/projections/projector.ts";
import { sidebarPage, transcriptPage } from "../src/projections/snapshots.ts";
import { withOwner } from "../src/owner-tx.ts";
import { type Database, POSTGRES, startPostgres, describeWith } from "./support/infra.ts";
import { ADA, C1, C2, GRACE, Outbox, P1, P2, P3, assistant, entry, reset, user } from "./support/fixtures.ts";

const live = describeWith(!!POSTGRES);

live("projections over PostgreSQL", () => {
	let db: Database;
	let outbox: Outbox;
	beforeAll(async () => {
		db = await startPostgres();
		outbox = new Outbox(db.admin);
	});
	afterAll(() => db?.stop());
	beforeEach(async () => {
		await reset(db.admin);
		outbox.reset();
	});

	const views = async () => ({
		transcript: (await db.admin.query("SELECT owner_id, stream_kind, chat_id, entry_id, position, partial, message, ui_state FROM pim_projection.chat_transcript_projection ORDER BY owner_id, chat_id, position")).rows,
		sidebar: (await db.admin.query("SELECT owner_id, chat_id, title, busy, unread, stalled, updated_at, summary FROM pim_projection.sidebar_session_projection ORDER BY owner_id, chat_id")).rows,
		coding: (await db.admin.query("SELECT owner_id, thread_id, title, harness, state, running, unread, updated_at, summary FROM pim_projection.coding_thread_projection ORDER BY owner_id, thread_id")).rows,
	});

	async function history() {
		await outbox.entry(P1, ADA, C1, user(10, "hello"));
		await outbox.commit(P1, ADA, C1, "chat.meta", { title: "Greeting", busy: true, updatedAt: 5 });
		await outbox.entry(P1, ADA, C1, assistant(11, "Hi th"), true);
		await outbox.entry(P1, ADA, C1, assistant(11, "Hi there", [{ type: "toolCall", id: "call-1", name: "send_to_user", arguments: { a: 1 } }]));
		await outbox.entry(P1, ADA, C1, entry(12, "pi.message", { role: "toolResult", toolCallId: "call-1", toolName: "send_to_user", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1012 }));
		await outbox.entry(P1, ADA, C1, entry(13, "pi.compaction", { role: "user", content: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nThey said hello.\n</summary>", timestamp: 1013 }));
		await outbox.commit(P1, ADA, C1, "chat.ui_state", { entryId: "11", block: "form", state: { picked: 2 } });
		await outbox.commit(P1, ADA, C1, "chat.meta", { busy: false, stalled: false, updatedAt: 9, summary: { agent: "Majordomo" } });
		await outbox.entry(P2, ADA, C2, user(20, "other chat"));
		await outbox.commit(P2, ADA, C2, "chat.meta", { title: "Second", updatedAt: 7 });
		await outbox.commit(P2, ADA, C2, "coding.thread", { threadId: "k1", title: "Fix bug", harness: "pi", state: "working", running: true, updatedAt: 8 });
		await outbox.commit(P2, ADA, C2, "chat.entry", { stream: "coding", threadId: "k1", entry: assistant(30, "patched") });
		await outbox.entry(P3, GRACE, C1, user(10, "grace's own c1"));
		await outbox.commit(P3, GRACE, C1, "runtime.something_else", { ignored: true });
	}

	it("projects messages with the shared transcript's fidelity, replacing a partial with its final message", async () => {
		await history();
		await new Projector(db.pool).drainAll();
		const page = await transcriptPage(db.pool, ADA, C1);
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
		// The same chat id under another owner is that owner's own.
		expect((await transcriptPage(db.pool, GRACE, C1)).messages.map((m) => (m.parts[0] as { text: string }).text)).toEqual(["grace's own c1"]);
		expect((await transcriptPage(db.pool, ADA, "k1", { kind: "coding" })).messages.map((m) => m.id)).toEqual(["30"]);
		// The page's cursor is the cursor of the topic's newest row, in the canonical form.
		expect(page.liveCursor).toBe(`${P1}:1:7`);
	});

	it("keeps the model an assistant message recorded, on the partial that shows it streaming and on the stored page, and none for one that recorded none", async () => {
		const recorded = (id: number, fields: Record<string, unknown>) => entry(id, "pi.message", { role: "assistant", content: [{ type: "text", text: "Hi" }], stopReason: "stop", timestamp: 1000 + id, ...fields });
		await outbox.entry(P1, ADA, C1, user(10, "hello"));
		await outbox.entry(P1, ADA, C1, recorded(-1, { provider: "ai-gateway", model: "gemini-4-neon" }), true);
		await outbox.entry(P1, ADA, C1, recorded(11, { provider: "openai", model: "gpt-6-sol", responseModel: "gpt-6-sol-2" }));
		await outbox.entry(P1, ADA, C1, recorded(12, {}));
		await new Projector(db.pool).drainAll();
		const page = await transcriptPage(db.pool, ADA, C1);
		expect(page.messages.map((message) => [message.id, message.model ?? null])).toEqual([
			["-1", { provider: "ai-gateway", model: "gemini-4-neon" }],
			["10", null],
			["11", { provider: "openai", model: "gpt-6-sol", served: "gpt-6-sol-2" }],
			["12", null],
		]);
	});

	it("is idempotent: applying commits again, from one projector or two at once, changes nothing", async () => {
		await history();
		const a = new Projector(db.pool);
		const b = new Projector(db.pool);
		const applied = await Promise.all([a.drain(ADA, P1), b.drain(ADA, P1), a.drain(ADA, P2), b.drain(ADA, P2), a.drain(GRACE, P3)]);
		expect(applied.reduce((sum, n) => sum + n, 0)).toBe(14);
		const first = await views();
		const log = (await db.admin.query("SELECT count(*)::int AS n FROM pim_projection.live_event_log")).rows[0].n;
		expect(await a.drainAll()).toBe(0);
		const rows = (await db.admin.query("SELECT * FROM pim_runtime.runtime_outbox WHERE partition_id = $1", [P1])).rows;
		for (const row of rows) {
			const again = await a.apply({ partitionId: row.partition_id, commitSeq: BigInt(row.commit_seq), projectionVersion: 1, ownerId: row.owner_id, publicChatId: row.public_chat_id, conversationId: 1, eventKind: row.event_kind, payload: row.payload, committedAt: row.committed_at.toISOString() });
			expect(again).toBe(false);
		}
		expect(await views()).toEqual(first);
		expect((await db.admin.query("SELECT count(*)::int AS n FROM pim_projection.live_event_log")).rows[0].n).toBe(log);
		// Stream seqs are dense per topic.
		const seqs = (await db.admin.query("SELECT array_agg(stream_seq ORDER BY stream_seq) AS s FROM pim_projection.live_event_log WHERE owner_id = $1 AND topic = $2", [ADA, `chat:${C1}`])).rows[0].s.map(Number);
		expect(seqs).toEqual(seqs.map((_: number, index: number) => index + 1));
	});

	it("rebuilds identical views from the outbox alone, with no effect repeated", async () => {
		await history();
		const projector = new Projector(db.pool);
		await projector.drainAll();
		const before = await views();
		const outboxRows = (await db.admin.query("SELECT * FROM pim_runtime.runtime_outbox ORDER BY partition_id, commit_seq")).rows;
		await db.admin.query("INSERT INTO pim_runtime.effects_ledger (what) VALUES ('model call billed once'), ('tool ran once')");
		// Truncate every projection table, as an operator would, then replay.
		await db.admin.query("TRUNCATE pim_projection.chat_transcript_projection, pim_projection.sidebar_session_projection, pim_projection.coding_thread_projection, pim_projection.live_event_log, pim_projection.live_stream_heads, pim_projection.projection_applied, pim_projection.projection_watermarks");
		expect(await views()).toEqual({ transcript: [], sidebar: [], coding: [] });
		await projector.drainAll();
		expect(await views()).toEqual(before);
		// The rebuild command does the same, owner by owner, as the Live role, with no TRUNCATE.
		expect(await projector.rebuild(ADA)).toBe(12);
		expect(await projector.rebuild(GRACE)).toBe(2);
		expect(await views()).toEqual(before);
		expect((await db.admin.query("SELECT * FROM pim_runtime.runtime_outbox ORDER BY partition_id, commit_seq")).rows).toEqual(outboxRows);
		expect((await db.admin.query("SELECT what FROM pim_runtime.effects_ledger ORDER BY id")).rows.map((row) => row.what)).toEqual(["model call billed once", "tool ran once"]);
	});

	it("waits at a gap in a partition's commits instead of skipping it", async () => {
		await outbox.commit(P1, ADA, C1, "chat.meta", { title: "a" });
		await db.admin.query("INSERT INTO pim_runtime.runtime_outbox (partition_id, commit_seq, projection_version, owner_id, public_chat_id, conversation_id, event_kind, payload) VALUES ($1, 3, 1, $2, $3, 1, 'chat.meta', '{\"title\":\"c\"}')", [P1, ADA, C1]);
		const projector = new Projector(db.pool);
		expect(await projector.drainAll()).toBe(1);
		expect((await projector.lag())[0]).toMatchObject({ projectedSeq: 1, maxCommitSeq: 3, lagCommits: 2 });
		await db.admin.query("INSERT INTO pim_runtime.runtime_outbox (partition_id, commit_seq, projection_version, owner_id, public_chat_id, conversation_id, event_kind, payload) VALUES ($1, 2, 1, $2, $3, 1, 'chat.meta', '{\"title\":\"b\"}')", [P1, ADA, C1]);
		expect(await projector.drainAll()).toBe(2);
		expect((await views()).sidebar[0]!.title).toBe("c");
	});

	it("projects text with a NUL, which jsonb refuses, and a partition that fails does not hold back the others", async () => {
		// The runtime keeps records as text, which holds a NUL; this fixture's outbox is jsonb, so the source puts the NULs back in.
		await outbox.entry(P1, ADA, C1, entry(10, "pi.message", { role: "toolResult", toolCallId: "call-1", toolName: "shell", content: [{ type: "text", text: "page<NUL>1" }], isError: false, timestamp: 1010 }));
		await outbox.commit(P1, ADA, C1, "chat.meta", { title: "a<NUL>b", busy: false, summary: { last: "<NUL>" } });
		await outbox.commit(P2, ADA, C2, "chat.meta", { title: "unreadable" });
		await outbox.entry(P3, GRACE, C1, user(10, "after the broken partition"));
		const table = tableOutboxSource(db.pool);
		const source: OutboxSource = {
			...table,
			commitsAfter: async (owner, partition, version, after, limit) => {
				if (partition === P2) throw new Error("unreadable commit");
				const commits = await table.commitsAfter(owner, partition, version, after, limit);
				return commits.map((c) => ({ ...c, events: c.events.map((e) => ({ ...e, payload: JSON.parse(JSON.stringify(e.payload).replaceAll("<NUL>", "\\u0000")) })) }));
			},
		};
		await expect(new Projector(db.pool, { source }).drainAll()).rejects.toThrow("unreadable commit");
		const { transcript, sidebar } = await views();
		expect(transcript.map((row) => [row.owner_id, JSON.stringify(row.message)])).toEqual([
			[ADA, expect.stringContaining('"page1"')],
			[GRACE, expect.stringContaining("after the broken partition")],
		]);
		expect(sidebar.map((row) => row.title)).toEqual(["ab"]);
	});

	it("keeps an owner's rows from every other owner, and from a connection that set none, by row-level security", async () => {
		await history();
		await new Projector(db.pool).drainAll();
		const count = (owner: string | null) =>
			db.pool.connect().then(async (client) => {
				try {
					await client.query("BEGIN");
					if (owner) await client.query("SELECT set_config('pim.owner_id', $1, true)", [owner]);
					const rows = await client.query("SELECT (SELECT count(*) FROM pim_projection.chat_transcript_projection)::int AS t, (SELECT count(*) FROM pim_projection.live_event_log)::int AS l");
					await client.query("ROLLBACK");
					return rows.rows[0] as { t: number; l: number };
				} finally {
					client.release();
				}
			});
		expect(await count(null)).toEqual({ t: 0, l: 0 });
		expect((await count(GRACE)).t).toBe(1);
		expect((await count(ADA)).t).toBe(6);
		// Writing another owner's row fails, whatever the statement says.
		await expect(withOwner(db.pool, GRACE, (client) => client.query("INSERT INTO pim_projection.live_stream_heads (owner_id, topic, head_seq) VALUES ($1, 'sidebar', 1)", [ADA]))).rejects.toThrow(/row-level security/);
	});

	it("reports projection lag in commits and in age", async () => {
		let now = Date.parse("2026-01-01T00:00:10Z");
		const projector = new Projector(db.pool, { now: () => now });
		await outbox.commit(P1, ADA, C1, "chat.meta", { title: "a" }, "2026-01-01T00:00:01Z");
		for (let i = 0; i < 8; i++) await outbox.commit(P1, ADA, C1, "chat.meta", { title: "b" }, "2026-01-01T00:00:04Z");
		const [first] = (await db.admin.query("SELECT * FROM pim_runtime.runtime_outbox WHERE commit_seq = 1")).rows;
		await projector.apply({ partitionId: first.partition_id, commitSeq: 1n, projectionVersion: 1, ownerId: first.owner_id, publicChatId: first.public_chat_id, conversationId: 1, eventKind: "chat.meta", payload: first.payload, committedAt: first.committed_at.toISOString() });
		expect(await projector.lag()).toEqual([{ ownerId: ADA, partitionId: P1, maxCommitSeq: 9, projectedSeq: 1, lagCommits: 8, oldestUnprojectedAgeMs: 6000 }]);
		now += 1000;
		await projector.drainAll();
		expect(await projector.lag()).toEqual([{ ownerId: ADA, partitionId: P1, maxCommitSeq: 9, projectedSeq: 9, lagCommits: 0, oldestUnprojectedAgeMs: 0 }]);
	});

	it("pages the sidebar and transcripts, and a page's liveCursor is the newest row it reflects", async () => {
		for (let index = 0; index < 7; index++) await outbox.commit(P1, ADA, `00000000-0000-4000-8000-00000000000${index}`, "chat.meta", { title: `Chat ${index}`, updatedAt: 100 + (index % 3) });
		for (let id = 1; id <= 5; id++) await outbox.entry(P2, ADA, C2, user(id, `m${id}`));
		await new Projector(db.pool).drainAll();
		const seen: string[] = [];
		let after: string | null = null;
		let pages = 0;
		do {
			const page = await sidebarPage(db.pool, ADA, { after, limit: 3 });
			seen.push(...page.sessions.map((row) => row.chatId));
			after = page.nextAfter;
			expect(page.liveCursor).toBe(`${P1}:1:7`);
			pages++;
		} while (after);
		expect(pages).toBe(3);
		expect(new Set(seen).size).toBe(7);
		expect((await sidebarPage(db.pool, ADA, { limit: 1 })).sessions[0]!.updatedAt).toBe(102);
		const newest = await transcriptPage(db.pool, ADA, C2, { limit: 2 });
		expect(newest.messages.map((m) => m.id)).toEqual(["4", "5"]);
		expect(newest.liveCursor).toBe(`${P2}:1:5`);
		const older = await transcriptPage(db.pool, ADA, C2, { limit: 2, before: newest.nextBefore });
		expect(older.messages.map((m) => m.id)).toEqual(["2", "3"]);
		expect((await transcriptPage(db.pool, ADA, C2, { limit: 2, before: older.nextBefore })).nextBefore).toBeNull();
		// A topic with no events has no cursor: a client subscribes from the start.
		expect((await transcriptPage(db.pool, GRACE, C2)).liveCursor).toBeNull();
	});

	it("projects a commit with several events in one transaction: one log row per topic, a final message replacing its partial", async () => {
		const at = (commitSeq: bigint, events: { eventKind: string; payload: Record<string, unknown> }[]) => ({
			commitSeq,
			committedAt: new Date(),
			events: events.map((e) => ({ partitionId: P1, commitSeq, projectionVersion: 1, ownerId: ADA, publicChatId: C1, conversationId: 1, committedAt: new Date().toISOString(), ...e })),
		});
		const commits = [
			at(1n, [{ eventKind: "chat.entry", payload: { entry: entry(-1, "pi.assistant", { role: "assistant", content: [{ type: "text", text: "Hel" }], stopReason: "pending", timestamp: 1 }), partial: true, position: 11 } }]),
			at(2n, [
				{ eventKind: "chat.entry", payload: { entry: assistant(11, "Hello"), replaces: "-1" } },
				{ eventKind: "chat.entry", payload: { entry: entry(12, "pi.message", { role: "toolResult", toolCallId: "c", toolName: "t", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 12 }) } },
				{ eventKind: "chat.meta", payload: { busy: false, updatedAt: 5 } },
			]),
			at(3n, []),
		];
		const source = {
			partitions: async () => [{ ownerId: ADA, partitionId: P1 }],
			partitionsOf: async () => [P1],
			commitsAfter: async (_o: string, _p: string, _v: number, after: number) => commits.filter((c) => Number(c.commitSeq) > after),
			heads: async () => [{ ownerId: ADA, partitionId: P1, maxSeq: 3 }],
			oldestAfter: async () => null,
		};
		const projector = new Projector(db.pool, { source });
		expect(await projector.drainAll()).toBe(3);
		const page = await transcriptPage(db.pool, ADA, C1);
		expect(page.messages.map((m) => [m.id, m.partial])).toEqual([["11", false], ["12", false]]);
		const log = (await db.admin.query("SELECT topic, commit_seq, event_kind, replaceable_key FROM pim_projection.live_event_log ORDER BY commit_seq, topic")).rows;
		expect(log).toEqual([
			{ topic: `chat:${C1}`, commit_seq: "1", event_kind: "message.partial", replaceable_key: "entry:-1" },
			{ topic: `chat:${C1}`, commit_seq: "2", event_kind: "batch", replaceable_key: null },
			{ topic: "sidebar", commit_seq: "2", event_kind: "sidebar.summary", replaceable_key: `chat:${C1}` },
		]);
		const batch = (await db.admin.query("SELECT payload FROM pim_projection.live_event_log WHERE commit_seq = 2 AND topic = $1", [`chat:${C1}`])).rows[0].payload;
		expect(batch.events.map((e: { kind: string; data: { replaces?: string } }) => [e.kind, e.data.replaces])).toEqual([["message", "-1"], ["message", undefined]]);
		// A commit with no events still moves the watermark, so the next one is not waiting on a hole.
		expect((await projector.lag())[0]).toMatchObject({ projectedSeq: 3, lagCommits: 0 });
		expect(await projector.rebuild(ADA)).toBe(3);
		expect((await transcriptPage(db.pool, ADA, C1)).messages.map((m) => m.id)).toEqual(["11", "12"]);
	});
});
