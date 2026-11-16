import { describe, expect, it } from "vitest";
import type { LiveEvent } from "../src/contracts.ts";
import { OutboundQueue } from "../src/server/outbound-queue.ts";
import { P1 } from "./support/fixtures.ts";

const ev = (seq: number, key: string | null, size = 10, topic = "sidebar"): LiveEvent => ({ topic, seq, cursor: { partitionId: P1, projectionVersion: 1, commitSeq: BigInt(seq) }, kind: key ? "partial" : "message", replaceableKey: key, data: "x".repeat(size) });
const drain = (queue: OutboundQueue) => {
	const out: { type: string; cursor?: string; skipped?: number }[] = [];
	for (let frame = queue.shift(); frame; frame = queue.shift()) out.push(frame as never);
	return out.map((frame) => ({ type: frame.type, cursor: frame.cursor?.split(":")[2], ...(frame.skipped ? { skipped: frame.skipped } : {}) }));
};

describe("OutboundQueue", () => {
	it("replaces replaceable updates, counts what a survivor stands for, keeps order and canonical frames", () => {
		const queue = new OutboundQueue(10_000);
		for (const event of [ev(1, "a"), ev(2, null), ev(3, "a"), ev(4, "b"), ev(5, "a"), ev(6, null)]) expect(queue.push(event)).toBe(true);
		// 1 and 3 were replaced by 5; 4 is another key.
		expect(drain(queue)).toEqual([{ type: "event", cursor: "2" }, { type: "event", cursor: "4" }, { type: "coalesced_progress", cursor: "5", skipped: 2 }, { type: "event", cursor: "6" }]);
		expect(queue.coalesced).toBe(2);
		expect(queue.bytes).toBe(0);
	});

	it("overflows by emptying itself, not by dropping the oldest canonical event", () => {
		const queue = new OutboundQueue(1_000);
		let overflowed = false;
		for (let seq = 1; seq <= 20 && !overflowed; seq++) overflowed = !queue.push(ev(seq, null, 100));
		expect(overflowed).toBe(true);
		expect(queue.length).toBe(0);
		expect(queue.bytes).toBe(0);
	});

	it("forgets a topic's queued events without touching another's", () => {
		const queue = new OutboundQueue(10_000);
		queue.push(ev(1, "k", 10, "a"));
		queue.push(ev(1, "k", 10, "b"));
		queue.drop("a");
		expect(queue.length).toBe(1);
		expect(queue.shift()).toMatchObject({ topic: "b" });
	});
});
