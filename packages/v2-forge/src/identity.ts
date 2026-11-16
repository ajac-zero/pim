// A coding thread's identity, as Pim has always derived it, so pre-cutover IDs, /coding/<id> URLs and replayed coding_start calls resolve to the same thread.

/** The canonical thread id: sha256 of the owner and the start operation, as Pim has always derived it. */
export { codingThreadId } from "@pim/v2-contracts/forge-seam";

/** A thread a caller names: one of Pim's by its id, or an Amp thread by its `T-…` id. */
export type ThreadRef = { readonly kind: "pim" | "amp"; readonly id: string };

/** What a caller may give for a thread: an id, its page (`/coding/<id>`, with or without an origin), an Amp thread id or its page. */
export function threadRef(input: string): ThreadRef {
	const given = typeof input === "string" ? input.trim() : "";
	if (/^T-[A-Za-z0-9_-]+$/.test(given)) return { kind: "amp", id: given };
	const amp = /^https?:\/\/(?:www\.)?ampcode\.com\/threads\/(T-[A-Za-z0-9_-]+)\/?(?:[?#].*)?$/.exec(given);
	if (amp) return { kind: "amp", id: amp[1]! };
	const page = /^(?:https?:\/\/[^/\s]+)?\/coding\/([^/?#\s]+)\/?(?:[?#].*)?$/.exec(given);
	return { kind: "pim", id: page ? page[1]! : given };
}
