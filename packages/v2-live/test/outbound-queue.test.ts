import { describe, expect, it } from "vitest";
import type { LiveEvent } from "../src/contracts.ts";
import { OutboundQueue } from "../src/server/outbound-queue.ts";

const ev = (seq: number, key: string | null, size = 10): LiveEvent => ({ streamKey: "s", seq, commitSeq: seq, kind: key ? "partial" : "message", replaceableKey: key, payload: "x".repeat(size) });
const drain = (queue: OutboundQueue) => {
	const out: { seq: number; coalesced?: true }[] = [];
	for (let frame = queue.shift(); frame; frame = queue.shift()) out.push(frame.type === "event" ? { seq: frame.seq, ...(frame.coalesced ? { coalesced: true as const } : {}) } : { seq: -1 });
	return out;
};

describe("OutboundQueue", () => {
	it("keeps seqs increasing, flags only frames after a skipped one, and keeps canonical frames", () => {
		const queue = new OutboundQueue(10_000);
		queue.startAt("s", 0);
		for (const event of [ev(1, "a"), ev(2, null), ev(3, "a"), ev(4, "b"), ev(5, "a"), ev(6, null)]) expect(queue.push("s", event)).toBe(true);
		// seq 1 and 3 were replaced by 5; 4 is another key.
		expect(drain(queue)).toEqual([{ seq: 2, coalesced: true }, { seq: 4, coalesced: true }, { seq: 5 }, { seq: 6 }]);
		expect(queue.coalesced).toBe(2);
		expect(queue.bytes).toBe(0);
	});

	it("overflows by emptying itself, not by dropping the oldest canonical event", () => {
		const queue = new OutboundQueue(1_000);
		queue.startAt("s", 0);
		let overflowed = false;
		for (let seq = 1; seq <= 20 && !overflowed; seq++) overflowed = !queue.push("s", ev(seq, null, 100));
		expect(overflowed).toBe(true);
		expect(queue.length).toBe(0);
		expect(queue.bytes).toBe(0);
	});

	it("forgets a stream's queued events without touching another's", () => {
		const queue = new OutboundQueue(10_000);
		queue.push("a", { ...ev(1, "k"), streamKey: "a" });
		queue.push("b", { ...ev(1, "k"), streamKey: "b" });
		queue.drop("a");
		expect(queue.length).toBe(1);
		expect(queue.shift()).toMatchObject({ stream: "b" });
	});
});
