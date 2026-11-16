import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectEntries } from "@pim/shared/transcript";
import { Projector } from "@pim/v2-live/projections/projector";
import { transcriptPage } from "@pim/v2-live/projections/snapshots";
import { runtimeOutboxSource } from "../src/runtime-source.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { createStack, type Stack } from "./support/stack.ts";
import { ADA, createTurnRig, fauxAssistantMessage, LEAD } from "./support/turn.ts";

type Rig = Awaited<ReturnType<typeof createTurnRig>>;

describe("Live's projector over the runtime's own tables", () => {
	let stack: Stack;
	let rig: Rig;
	let projector: Projector;
	let loop: ReturnType<typeof setInterval>;

	beforeAll(async () => {
		stack = await createStack();
		rig = await createTurnRig(stack);
		projector = new Projector(stack.live, { source: runtimeOutboxSource(stack.live) });
		loop = setInterval(() => void projector.drainAll().catch(() => {}), 40);
	});
	afterAll(async () => {
		clearInterval(loop);
		await rig?.runner.stop();
		await stack?.drop();
	});

	it("projects a Runner's turn: streamed partials, the tool call, and a final answer that replaces its partial; a rebuild repeats nothing", async () => {
		rig.faux.setResponses([fauxAssistantMessage("Hello, Ada.")]);
		await rig.submit("c1", "hi");
		const chat = await waitFor("the home conversation's public id", () => rig.chatId());
		await waitFor("the first answer", async () => (await transcriptPage(stack.live, ADA, chat)).messages.some((m) => m.role === "assistant" && !m.partial));
		rig.scriptTurn();
		await rig.submit("c2", "please echo ping");
		await waitFor("the final answer", async () => (await transcriptPage(stack.live, ADA, chat)).messages.some((m) => !m.partial && m.parts.some((p) => "text" in p && p.text?.includes("All done"))), 30_000);
		await waitFor("the projector to catch up", async () => ((await projector.lag()).every((l) => l.lagCommits === 0) ? true : undefined));

		// What the log says happened: partials of one answer that grow, then the answer, which names the partial it replaces.
		const log = (await stack.admin.query("SELECT event_kind, payload FROM pim_projection.live_event_log WHERE topic = $1 ORDER BY stream_seq", [`chat:${chat}`])).rows;
		const events = log.flatMap((row) => (row.event_kind === "batch" ? row.payload.events : [{ kind: row.event_kind, data: row.payload }])) as { kind: string; data: { message: { role: string; parts: { text?: string }[] }; partial: boolean; replaces?: string } }[];
		const partialTexts = events.filter((e) => e.kind === "message.partial").map((e) => e.data.message.parts.map((p) => p.text ?? "").join(""));
		// The scripted answer streams in steps: its partials are ever longer prefixes of it, and never ahead of it.
		const steps = partialTexts.filter((t) => t.length > 0 && LEAD.startsWith(t)).map((t) => t.length);
		expect(steps.length).toBeGreaterThan(1);
		expect(steps).toEqual([...steps].sort((x, y) => x - y));
		expect(new Set(steps).size).toBeGreaterThan(1);
		const finals = events.filter((e) => e.kind === "message" && e.data.message.role !== "user").map((e) => e.data.message.role);
		expect(finals).toEqual(["assistant", "assistant", "tool", "assistant"]);
		expect(events.filter((e) => e.kind === "message" && e.data.replaces !== undefined)).toHaveLength(3);
		expect(rig.echoRuns).toEqual(["ping"]);

		// The projection is the runtime's committed transcript, with no partial left, and the sidebar is idle.
		const committed = projectEntries(await readTranscript(stack.runtime, ADA, rig.home, 1)).map((m) => m.id);
		const shown = await transcriptPage(stack.live, ADA, chat);
		expect(shown.messages.some((m) => m.partial)).toBe(false);
		expect(shown.messages.map((m) => m.id)).toEqual(committed);

		// Rebuilding from the runtime's tables alone gives the same views, and runs no tool again.
		const entries = (await stack.admin.query("SELECT count(*) AS n FROM pim_runtime.entries")).rows[0].n;
		await projector.rebuild(ADA);
		expect(JSON.stringify((await transcriptPage(stack.live, ADA, chat)).messages)).toBe(JSON.stringify(shown.messages));
		expect((await stack.admin.query("SELECT count(*) AS n FROM pim_runtime.entries")).rows[0].n).toBe(entries);
		expect(rig.echoRuns).toEqual(["ping"]);
	});

	it("lets Live read only what projection needs, and only as one owner", async () => {
		await expect(stack.live.query("SELECT count(*) FROM pim_runtime.entries")).resolves.toMatchObject({ rows: [{ count: "0" }] });
		await expect(stack.live.query("INSERT INTO pim_runtime.commit_receipts (owner_id, partition_id, batch_id, commit_seq, holder_id, epoch, write_count) VALUES ('o_x', gen_random_uuid(), gen_random_uuid(), 1, 'h', 1, 1)")).rejects.toThrow(/permission denied/);
		await expect(stack.live.query("SELECT * FROM pim_runtime.command_inbox")).rejects.toThrow(/permission denied/);
		const asOwner = async (owner: string) => {
			const client = await stack.live.connect();
			try {
				await client.query("BEGIN");
				await client.query("SELECT set_config('pim.owner_id', $1, true)", [owner]);
				return Number((await client.query("SELECT count(*) AS n FROM pim_runtime.entries")).rows[0].n);
			} finally {
				await client.query("ROLLBACK");
				client.release();
			}
		};
		expect(await asOwner("o_ada")).toBeGreaterThan(0);
		expect(await asOwner("o_grace")).toBe(0);
		// Discovery names partitions and the newest commit, and reaches nothing else of `partitions`.
		const client = await stack.live.connect();
		try {
			await client.query("BEGIN");
			const found = await client.query("SELECT owner_id, last_seq FROM pim_runtime.live_partitions()");
			expect(found.rows.map((r) => r.owner_id)).toEqual(["o_ada"]);
			await expect(client.query("SELECT count(*) FROM pim_runtime.partitions")).rejects.toThrow(/permission denied/);
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});
});
