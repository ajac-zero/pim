/**
 * The shape of an OptMem-style memory, after Victor Taelin's OptMem
 * (github.com/VictorTaelin/OptMem), reimplemented from its description.
 *
 * Memories are numbered 0, 1, 2, ... in an append-only log. A BLOCK is an
 * aligned power-of-two range [lo, hi) of them, summarized in one line;
 * blocks form a binary tree: [lo, hi) summarizes [lo, mid) and [mid, hi).
 */

/** [lo, hi): memories lo through hi - 1. */
export type Block = readonly [lo: number, hi: number];

/** Blocks up to this many memories are summarized from the raw log; larger ones from their two halves. */
export const RAW_MAX = 16;

/**
 * Tiles [0, total) with aligned power-of-two blocks, keeping a block whole
 * only when its size is at most `alpha` times its age (distance from the
 * newest memory). Larger alpha keeps older memories coarser.
 */
function tile(total: number, alpha: number): Block[] {
	let root = 1;
	while (root < total) root *= 2;
	const out: Block[] = [];
	const stack: Block[] = [[0, root]];
	while (stack.length > 0) {
		const [lo, hi] = stack.pop()!;
		if (lo >= total) continue;
		const size = hi - lo;
		if (size > 1 && (hi > total || size > alpha * (total - lo))) {
			const mid = (lo + hi) / 2;
			stack.push([mid, hi], [lo, mid]);
		} else {
			out.push([lo, hi]);
		}
	}
	return out.sort((a, b) => a[0] - b[0]);
}

/**
 * The blocks the memory view shows: oldest first, at most `budget` of them,
 * with detail decaying with age. Everything is raw while it fits.
 */
export function cover(total: number, budget: number): Block[] {
	if (total <= 0) return [];
	if (total <= budget) return Array.from({ length: total }, (_, i): Block => [i, i + 1]);
	let low = 0;
	let high = 1;
	// The coarsest tiling is one line per power of two, so a budget of a few
	// dozen lines covers astronomically many memories; alpha only grows past 1
	// for tiny budgets.
	while (tile(total, high).length > budget && high < 2 ** 40) high *= 2;
	for (let i = 0; i < 60; i++) {
		const mid = (low + high) / 2;
		if (tile(total, mid).length > budget) low = mid;
		else high = mid;
	}
	const out = tile(total, high);
	// Sizes jump in powers of two, so the search can undershoot the budget;
	// spend what is left on the newest blocks, where detail is worth most.
	while (out.length < budget) {
		const index = out.findLastIndex(([lo, hi]) => hi - lo > 1);
		if (index < 0) break;
		const [lo, hi] = out[index]!;
		const mid = (lo + hi) / 2;
		out.splice(index, 1, [lo, mid], [mid, hi]);
	}
	return out;
}

/** Every block that can be built over `total` memories, smallest first, then oldest first. */
export function* buildableBlocks(total: number): Generator<Block> {
	for (let size = 2; size <= total; size *= 2) {
		for (let lo = 0; lo + size <= total; lo += size) yield [lo, lo + size];
	}
}

/** The two halves of a block. */
export function halves([lo, hi]: Block): [Block, Block] {
	const mid = (lo + hi) / 2;
	return [
		[lo, mid],
		[mid, hi],
	];
}

export function isBlock([lo, hi]: Block): boolean {
	const size = hi - lo;
	return Number.isSafeInteger(lo) && lo >= 0 && size >= 2 && (size & (size - 1)) === 0 && lo % size === 0;
}

/** `#lo-last` as the model reads and writes it, inclusive at both ends. */
export function blockName([lo, hi]: Block): string {
	return `${lo}-${hi - 1}`;
}

/** Parses `a-b` or `#a-b` (inclusive), or returns undefined when it is not a block. */
export function parseBlock(name: string): Block | undefined {
	const match = /^#?(\d+)-(\d+)$/.exec(name.trim());
	if (!match) return undefined;
	const block: Block = [Number(match[1]), Number(match[2]) + 1];
	return isBlock(block) ? block : undefined;
}
