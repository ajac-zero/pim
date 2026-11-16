import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ada, startReq, stack } from "./stack";

describe("transcript paging parity", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let id: string;
	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		id = (await s.forge.start(ada, startReq("tr-1", { harness: "claude-code" }))).threadId;
		const long = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
		await s.store.locked(id, async (q) => {
			await s.store.appendEvent(q, id, { kind: "message", role: "user", data: { text: "the task" } });
			for (let i = 0; i < 30; i++) {
				await s.store.appendEvent(q, id, { kind: "message", role: "assistant", data: { text: `answer ${i}`, toolCalls: [{ id: `c${i}`, name: "bash", arguments: { command: "ls" } }] } });
				await s.store.appendEvent(q, id, { kind: "message", role: "tool", data: { toolCallId: `c${i}`, name: "bash", text: i === 7 ? long : `out ${i}`, isError: false } });
			}
			await s.store.appendEvent(q, id, { kind: "message", role: "notice", data: { text: "budget note" } });
			await s.store.appendEvent(q, id, { kind: "thread.turn_ended" });
		});
	});
	afterAll(async () => s.close());

	it("pages oldest first with offset and limit, and says where the next page starts", async () => {
		const p = await s.forge.transcriptPage(ada, id, { offset: 0, limit: 25 });
		expect(p.total).toBe(62);
		expect(p.messages).toHaveLength(25);
		expect(p.messages[0]).toMatchObject({ role: "user", text: "the task" });
		expect(p.next_offset).toBe(25);
		const next = await s.forge.transcriptPage(ada, id, { offset: 25, limit: 50 });
		expect(next.messages).toHaveLength(37);
		expect(next.next_offset).toBeUndefined();
	});

	it("reads the tail, one role, and one-line summaries", async () => {
		const tail = await s.forge.transcriptPage(ada, id, { tail: true, limit: 3 });
		expect(tail).toMatchObject({ total: 62, offset: 59 });
		expect(tail.messages.map((m) => m.role)).toEqual(["assistant", "tool", "notice"]);
		expect(tail.messages.at(-1)).toMatchObject({ role: "notice", text: "budget note" });
		const assistants = await s.forge.transcriptPage(ada, id, { role: "assistant", tail: true, limit: 2 });
		expect(assistants.messages.map((m) => m.text)).toEqual([expect.stringContaining("answer 28"), expect.stringContaining("answer 29")]);
		expect(assistants.messages[0]!.text).toContain("bash(");
		const summary = await s.forge.transcriptPage(ada, id, { role: "tool", summary: true, limit: 50 });
		expect(summary.messages[7]!.text).toBe("line 1");
		// A role that only some messages have is counted among its own.
		expect((await s.forge.transcriptPage(ada, id, { role: "notice" })).total).toBe(1);
	});

	it("reads one message whole by id, by lines: offset from 1, at most 2000, with how to read on", async () => {
		const tool7 = (await s.forge.transcriptPage(ada, id, { role: "tool", limit: 50 })).messages[7]!;
		expect(tool7.text).toContain("more characters");
		const first = (await s.forge.transcriptOutput(ada, id, { id: tool7.id })).text;
		expect(first).toContain("line 1\n");
		expect(first).toContain("line 2000");
		expect(first).not.toContain("line 2001\n");
		expect(first).toMatch(/\[Lines 1-2000 of 5000\. Use offset=2001 to read on\.\]/);
		const second = (await s.forge.transcriptOutput(ada, id, { id: tool7.id, offset: 2001, limit: 10 })).text;
		expect(second.startsWith("line 2001\n")).toBe(true);
		expect(second).toContain("line 2010\n");
		expect(second).toMatch(/Lines 2001-2010 of 5000/);
		await expect(s.forge.transcriptOutput(ada, id, { id: "99999" })).rejects.toMatchObject({ code: "not_found" });
		// Without an id: the last assistant message, as before.
		expect((await s.forge.transcriptOutput(ada, id)).text).toContain("answer 29");
		// Someone else's thread isn't readable.
		await expect(s.forge.transcriptPage({ ownerId: "eve", role: "member" }, id)).rejects.toMatchObject({ code: "not_found" });
	});
});
