// A coding thread's identity, as Pim has always derived it, so pre-cutover IDs, /coding/<id> URLs and replayed coding_start calls resolve to the same thread.
import { createHash } from "node:crypto";

/** A thread's ID: from the space and the start's operation, so starting again with it reaches the same thread, and no other space's. */
export function codingThreadId(space: string, operationId: string): string {
	const hex = createHash("sha256").update(`pim coding thread\n${space}\n${operationId}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

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
