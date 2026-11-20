/**
 * The memory tree, v1's OptMem (`src/extensions/optmem` at the tag v1-final, after Victor Taelin's OptMem) over V2's memories: each scope's memories have places 0, 1, 2, … in
 * the order they were kept (migration 0712), an aligned power-of-two block of places is summarized in one line, and the prompt's memory shows a fixed number of lines where the
 * newest memories are as they were kept and older ones fade into coarser summaries.
 *
 * - The view (`memoryView`): each scope the agent reads gets its share of `PIM_MEMORY_LINES`, tiled by `cover`; a block not summarized yet shows its halves until the pass catches
 *   up. A memory is `[id] title`; a summary is `#<scope>/<first>-<last> text`, which `zoom` opens into its halves.
 * - The pass (`compressPass`), on the Runner's memory loop beside the nap: for owners with a block that can be built and is not, the smallest first, a block of up to 16 places is
 *   summarized from its memories' titles and a larger one from its halves, on the memory model (`PIM_MEMORY_MODEL`, else the utility model, else the chosen one). A summary is
 *   kept only if what it was made from is unchanged when it is written: a memory changed, forgotten or moved meanwhile drops the summaries over its place (0712's trigger) under
 *   the same lock.
 */
import type { App } from "@pim/v2-app/app";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import type { Tx } from "@pim/v2-app/db";
import type { Pool } from "pg";

/** [lo, hi): places lo through hi - 1. */
export type Block = readonly [lo: number, hi: number];

/** Blocks up to this many places are summarized from their memories; larger ones from their two halves. */
export const RAW_MAX = 16;
/** The longest a summary may be, in UTF-8 bytes, as a memory's title. */
const SUMMARY_BYTES = 280;
const OWNERS_PER_PASS = 5;
const BLOCKS_PER_OWNER = 20;
const RETRY_AFTER_MS = 10 * 60_000;

const SYSTEM = `You compress an agent's long-term memory about the person it works for.
Write ONE line of at most ${SUMMARY_BYTES} bytes that summarizes the memories you are given.
Keep what has lasting effect: facts about the person and the people in their life, preferences, decisions, commitments, outcomes. Keep the names, dates and numbers that matter. Drop what does not last.
Invent nothing. Answer with the line only.`;

/**
 * Tiles [0, total) with aligned power-of-two blocks, keeping a block whole only when its size is at most `alpha` times its age (its distance from the newest place). A larger
 * alpha keeps older memories coarser.
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
		} else out.push([lo, hi]);
	}
	return out.sort((a, b) => a[0] - b[0]);
}

/** The blocks the view shows of `total` places: oldest first, at most `budget` of them, with detail fading with age. Everything is a place of its own while it fits. */
export function cover(total: number, budget: number): Block[] {
	if (total <= 0) return [];
	if (total <= budget) return Array.from({ length: total }, (_, i): Block => [i, i + 1]);
	let low = 0;
	let high = 1;
	// The coarsest tiling is one line per power of two, so alpha only grows past 1 for tiny budgets.
	while (tile(total, high).length > budget && high < 2 ** 40) high *= 2;
	for (let i = 0; i < 60; i++) {
		const mid = (low + high) / 2;
		if (tile(total, mid).length > budget) low = mid;
		else high = mid;
	}
	const out = tile(total, high);
	// Sizes jump in powers of two, so the search can undershoot the budget: what is left goes to the newest blocks, where detail is worth most.
	while (out.length < budget) {
		const index = out.findLastIndex(([lo, hi]) => hi - lo > 1);
		if (index < 0) break;
		const [lo, hi] = out[index]!;
		const mid = (lo + hi) / 2;
		out.splice(index, 1, [lo, mid], [mid, hi]);
	}
	return out;
}

/** Every block that can be built over `total` places, smallest first, then oldest first. */
export function* buildableBlocks(total: number): Generator<Block> {
	for (let size = 2; size <= total; size *= 2) for (let lo = 0; lo + size <= total; lo += size) yield [lo, lo + size];
}

export const halves = ([lo, hi]: Block): [Block, Block] => [[lo, (lo + hi) / 2], [(lo + hi) / 2, hi]];

/** `first-last` as the model reads and writes it, inclusive at both ends. */
export const blockName = ([lo, hi]: Block) => `${lo}-${hi - 1}`;

/** A block as the model names it, `<scope>/a-b` (with or without `#`), or undefined when it is not one. */
export function parseScopedBlock(name: string): { scope: string; block: Block } | undefined {
	const m = /^#?([^\s/#]+)\/(\d+)-(\d+)$/.exec(name.trim());
	if (!m) return undefined;
	const lo = Number(m[2]);
	const size = Number(m[3]) + 1 - lo;
	return Number.isSafeInteger(lo) && size >= 2 && (size & (size - 1)) === 0 && lo % size === 0 ? { scope: m[1]!, block: [lo, lo + size] } : undefined;
}

/** How many of the view's lines each scope gets: an equal share, never more than a scope holds, and what a small scope leaves goes to the others. */
export function shares(sizes: readonly number[], lines: number): number[] {
	const out = sizes.map(() => 0);
	let left = lines;
	const order = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
	for (const [n, { size, index }] of order.entries()) {
		out[index] = Math.min(size, Math.max(1, Math.floor(left / (order.length - n))));
		left -= out[index]!;
	}
	return out;
}

/** The first non-empty line of a model's answer, unquoted and clipped to a summary's size. */
export function summaryLine(answer: string): string {
	const line = answer.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== "");
	if (!line) return "";
	const clean = line.replace(/^["'`]+|["'`]+$/g, "").trim();
	if (Buffer.byteLength(clean) <= SUMMARY_BYTES) return clean;
	const chars = [...clean];
	while (Buffer.byteLength(`${chars.join("")}…`) > SUMMARY_BYTES) chars.pop();
	return `${chars.join("").trimEnd()}…`;
}

type Shown = { scope: string; lo: number; hi: number; id: string | null; text: string };
const lineOf = (row: Shown) => (row.id ? `[${row.id}] ${row.text}` : `#${row.scope}/${blockName([row.lo, row.hi])} ${row.text}`);

/**
 * An agent's memory as its prompt shows it: each scope it reads (every scope where `scopes` is null, as the majordomo reads them), under a line naming it, sharing `lines`
 * lines. Empty when nothing is remembered.
 */
export async function memoryView(db: RuntimeDb, ownerId: string, scopes: readonly string[] | null, lines: number, own?: string): Promise<string[]> {
	const sizes = (await db.read<{ s: Record<string, number> }>(ownerId, "SELECT pim_app.runner_memory_sizes($1, $2) AS s", [ownerId, scopes])).rows[0]?.s ?? {};
	// The agent's own scope first, then `everyone`, then the rest by name.
	const rank = (scope: string) => (scope === own ? 0 : scope === "everyone" ? 1 : 2);
	const shown = Object.keys(sizes).filter((scope) => sizes[scope]! > 0).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
	if (shown.length === 0) return [];
	const budget = shares(shown.map((scope) => sizes[scope]!), lines);
	const blocks = shown.flatMap((scope, i) => cover(sizes[scope]!, budget[i]!).map(([lo, hi]) => ({ scope, lo, hi })));
	const rows = (await db.read<{ b: Shown[] }>(ownerId, "SELECT pim_app.runner_memory_blocks($1, $2) AS b", [ownerId, JSON.stringify(blocks)])).rows[0]?.b ?? [];
	return shown.flatMap((scope, i) => {
		const mine = rows.filter((row) => row.scope === scope).sort((a, b) => a.lo - b.lo).map(lineOf);
		const limit = Math.max(2, budget[i]! * 2);
		const body = mine.length <= limit ? mine : ["(Older memories are still being summarized; use recall or zoom for them.)", ...mine.slice(mine.length - limit)];
		return [`Scope ${scope}${scope === own ? " (your own)" : ""}:`, ...(body.length ? body : ["(nothing kept now)"])];
	});
}

/** What `zoom` shows of a block: its two halves, each a memory or a summary, or a note that it is not summarized yet. */
export async function zoomBlock(app: App, ownerId: string, scope: string, block: Block): Promise<string[] | string> {
	return app.db.owner(ownerId, async (tx) => {
		const size = Number((await tx.query("SELECT coalesce(max(pos) + 1, 0) AS n FROM pim_app.memories WHERE scope = $1", [scope])).rows[0].n);
		if (block[0] >= size) return `#${scope}/${blockName(block)} is beyond that scope: it holds ${size} places.`;
		const out: string[] = [];
		for (const half of halves(block).filter(([lo]) => lo < size)) {
			if (half[1] - half[0] === 1) {
				const m = (await tx.query("SELECT id, title FROM pim_app.memories WHERE scope = $1 AND pos = $2 AND deleted_at IS NULL", [scope, half[0]])).rows[0];
				if (m) out.push(`[${m.id}] ${m.title}`);
				continue;
			}
			const s = (await tx.query("SELECT text FROM pim_app.memory_summaries WHERE scope = $1 AND size = $2 AND lo = $3", [scope, half[1] - half[0], half[0]])).rows[0];
			if (s?.text !== "") out.push(`#${scope}/${blockName(half)} ${s ? s.text : "(not summarized yet; zoom further)"}`);
		}
		return out.length ? out : `Nothing is kept in #${scope}/${blockName(block)} now.`;
	});
}

/** What summarizing a block takes: its memories' titles, or its halves' summaries; undefined when it is built, or waits on a half. */
async function inputOf(tx: Tx, scope: string, [lo, hi]: Block): Promise<string[] | undefined> {
	if ((await tx.query("SELECT 1 FROM pim_app.memory_summaries WHERE scope = $1 AND size = $2 AND lo = $3", [scope, hi - lo, lo])).rows.length) return undefined;
	if (hi - lo <= RAW_MAX) {
		const rows = (await tx.query("SELECT title, created_at FROM pim_app.memories WHERE scope = $1 AND pos >= $2 AND pos < $3 AND deleted_at IS NULL ORDER BY pos", [scope, lo, hi])).rows;
		return rows.map((r) => `${(r.created_at as Date).toISOString().slice(0, 10)} ${r.title}`);
	}
	const parts = (await tx.query("SELECT lo, text FROM pim_app.memory_summaries WHERE scope = $1 AND size = $2 AND lo = ANY($3) ORDER BY lo", [scope, (hi - lo) / 2, [lo, (lo + hi) / 2]])).rows;
	if (parts.length < 2) return undefined;
	return parts.map((p) => p.text as string).filter((t) => t !== "");
}

/** The next block of the owner's memory to summarize, smallest first, and what it is made from. */
async function nextBlock(tx: Tx): Promise<{ scope: string; block: Block; input: string[] } | undefined> {
	const sizes = (await tx.query("SELECT scope, max(pos) + 1 AS n FROM pim_app.memories GROUP BY scope ORDER BY scope")).rows as { scope: string; n: number }[];
	const built = new Set((await tx.query("SELECT scope, size, lo FROM pim_app.memory_summaries")).rows.map((r) => `${r.scope}:${r.size}:${r.lo}`));
	const pending = sizes.flatMap(({ scope, n }) => [...buildableBlocks(Number(n))].filter((b) => !built.has(`${scope}:${b[1] - b[0]}:${b[0]}`)).map((block) => ({ scope, block })));
	pending.sort((a, b) => a.block[1] - a.block[0] - (b.block[1] - b.block[0]));
	for (const { scope, block } of pending) {
		const input = await inputOf(tx, scope, block);
		if (input) return { scope, block, input };
	}
	return undefined;
}

export type CompressOptions = {
	/** The runtime's pool, for the one read across owners. */
	pool: Pool;
	app: App;
	complete(ownerId: string, system: string, prompt: string, maxTokens?: number): Promise<string | undefined>;
	onError?: (error: unknown) => void;
};

/** Summarizes the blocks due now; returns how many summaries it kept. `failed` holds owners whose model failed, until they may be tried again. */
export async function compressPass(options: CompressOptions, failed = new Map<string, number>(), now = Date.now()): Promise<number> {
	const { pool, app } = options;
	const owners = (await pool.query<{ owner_id: string }>("SELECT owner_id FROM pim_app.memory_tree_owners($1)", [OWNERS_PER_PASS + failed.size])).rows.map((r) => r.owner_id).filter((o) => (failed.get(o) ?? 0) <= now).slice(0, OWNERS_PER_PASS);
	let kept = 0;
	for (const owner of owners) {
		try {
			for (let i = 0; i < BLOCKS_PER_OWNER; i++) {
				const next = await app.db.owner(owner, nextBlock);
				if (!next) break;
				const { scope, block, input } = next;
				let line: string;
				// A block with nothing left in it, or with one half empty, needs no model.
				if (input.length === 0) line = "";
				else if (block[1] - block[0] > RAW_MAX && input.length === 1) line = input[0]!;
				else {
					const what = block[1] - block[0] > RAW_MAX ? "the summaries of its two halves" : "its memories, each with the day it was kept";
					line = summaryLine((await options.complete(owner, SYSTEM, `Compress memories #${blockName(block)} of the scope ${scope} into one line. Here are ${what}:\n${input.join("\n")}`, 200)) ?? "");
					if (line === "") {
						failed.set(owner, now + RETRY_AFTER_MS);
						break;
					}
				}
				// Kept only if what it was made from is still what it would be made from now: the lock orders this against 0712's trigger.
				const stored = await app.db.owner(owner, async (tx) => {
					await tx.query("SELECT pim_app.lock_memory_tree($1)", [owner]);
					const again = await inputOf(tx, scope, block);
					if (!again || JSON.stringify(again) !== JSON.stringify(input)) return false;
					await tx.query("INSERT INTO pim_app.memory_summaries (owner_id, scope, size, lo, text) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [owner, scope, block[1] - block[0], block[0], line]);
					return true;
				});
				if (stored) kept++;
			}
			if (failed.get(owner) !== undefined && failed.get(owner)! <= now) failed.delete(owner);
		} catch (error) {
			failed.set(owner, now + RETRY_AFTER_MS);
			options.onError?.(error);
		}
	}
	return kept;
}
