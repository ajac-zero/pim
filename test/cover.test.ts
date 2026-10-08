import { describe, expect, it } from "vitest";
import { type Block, buildableBlocks, cover, parseBlock } from "../src/extensions/optmem/cover";
import { summaryLine } from "../src/extensions/optmem/index";
import { byteLength } from "../src/extensions/optmem/store";

function popcount(n: number): number {
	let count = 0;
	for (let value = n; value > 0; value = Math.floor(value / 2)) count += value % 2;
	return count;
}

function checkTiling(total: number, budget: number, blocks: Block[]) {
	expect(blocks[0]![0]).toBe(0);
	expect(blocks.at(-1)![1]).toBe(total);
	for (let i = 0; i < blocks.length; i++) {
		const [lo, hi] = blocks[i]!;
		const size = hi - lo;
		// Aligned powers of two: real nodes of the tree.
		expect(size & (size - 1)).toBe(0);
		expect(lo % size).toBe(0);
		if (i > 0) {
			// Contiguous, and never finer in the past than in the present.
			expect(lo).toBe(blocks[i - 1]![1]);
			expect(size).toBeLessThanOrEqual(blocks[i - 1]![1] - blocks[i - 1]![0]);
		}
	}
	if (total <= budget) expect(blocks.every(([lo, hi]) => hi - lo === 1)).toBe(true);
	// The budget is spent exactly whenever the tree can be cut that fine.
	else if (budget >= popcount(total)) expect(blocks).toHaveLength(budget);
}

describe("cover", () => {
	it("tiles every log size with aligned blocks, fading with age, within the budget", () => {
		for (const budget of [1, 2, 3, 8, 96]) {
			for (let total = 1; total <= 600; total++) checkTiling(total, budget, cover(total, budget));
			for (const total of [1023, 1024, 1025, 4096, 100_000, 1_000_000]) checkTiling(total, budget, cover(total, budget));
		}
	});

	it("matches small cases worked out by hand", () => {
		expect(cover(0, 8)).toEqual([]);
		expect(cover(3, 8)).toEqual([[0, 1], [1, 2], [2, 3]]);
		expect(cover(4, 2)).toEqual([[0, 2], [2, 4]]);
		// The oldest pairs fold first; the newest memory stays verbatim.
		expect(cover(5, 3)).toEqual([[0, 2], [2, 4], [4, 5]]);
		expect(cover(9, 4)).toEqual([[0, 4], [4, 6], [6, 8], [8, 9]]);
	});

	it("keeps the newest memories verbatim in a large log", () => {
		const blocks = cover(1_000_000, 96);
		expect(blocks.slice(-4)).toEqual([[999_996, 999_997], [999_997, 999_998], [999_998, 999_999], [999_999, 1_000_000]]);
		expect(blocks[0]![1] - blocks[0]![0]).toBeGreaterThanOrEqual(2 ** 16);
	});
});

describe("blocks", () => {
	it("lists buildable blocks smallest first", () => {
		expect([...buildableBlocks(5)]).toEqual([[0, 2], [2, 4], [0, 4]]);
		expect([...buildableBlocks(1)]).toEqual([]);
	});

	it("parses only real tree nodes", () => {
		expect(parseBlock("16-31")).toEqual([16, 32]);
		expect(parseBlock("#0-1")).toEqual([0, 2]);
		expect(parseBlock("4-5")).toEqual([4, 6]);
		// Unaligned, not a power of two, a single memory, or not a range.
		for (const bad of ["5-6", "0-2", "3-3", "8-23", "abc", "-1-0"]) expect(parseBlock(bad)).toBeUndefined();
	});
});

describe("summaryLine", () => {
	it("takes the first line, unquoted", () => {
		expect(summaryLine('\n  "Ana is the user\'s sister."  \nSecond line')).toBe("Ana is the user's sister.");
	});

	it("clips to 280 bytes without splitting a character", () => {
		const clipped = summaryLine("é".repeat(200));
		expect(byteLength(clipped)).toBeLessThanOrEqual(280);
		expect(clipped.endsWith("é…")).toBe(true);
		expect(summaryLine("x".repeat(280))).toBe("x".repeat(280));
	});
});
