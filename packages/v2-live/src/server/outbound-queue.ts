import type { LiveEvent, ServerFrame } from "../contracts.ts";

/**
 * A socket's bounded queue of events it has not been sent yet.
 *
 * - Replaceable progress (a streaming partial, a tool's stdout) with the same `replaceableKey` replaces the
 *   queued one, so a slow reader holds one of each, not hundreds.
 * - Canonical events (a committed message, a turn's end) are never dropped to make room.
 * - When the queue would still exceed its byte cap, it empties and reports overflow: the reader must take an
 *   HTTP snapshot, which is cheaper for everyone than an unbounded buffer or a silent hole.
 *
 * Order is kept by seq: a replacement moves to the tail, so seqs only ever increase. The frame after a
 * dropped one says `coalesced`, so a client tells an intended skip from a lost frame.
 */
type Queued = { id: number; stream: string; event: LiveEvent; bytes: number };

export class OutboundQueue {
	readonly #items = new Map<number, Queued>();
	readonly #byKey = new Map<string, number>();
	/** The seq last handed out, per stream, to tell whether the next one skips what coalescing dropped. */
	readonly #sent = new Map<string, number>();
	#next = 0;
	#bytes = 0;
	coalesced = 0;

	constructor(readonly maxBytes: number) {}

	get bytes(): number {
		return this.#bytes;
	}

	get length(): number {
		return this.#items.size;
	}

	/** Where a stream's sent seqs begin: the cursor it subscribed at. */
	startAt(stream: string, cursor: number): void {
		this.#sent.set(stream, cursor);
	}

	/** Forgets a stream: its queued events go. */
	drop(stream: string): void {
		for (const [id, item] of this.#items) {
			if (item.stream !== stream) continue;
			this.#items.delete(id);
			this.#bytes -= item.bytes;
		}
		for (const [key, id] of this.#byKey) if (!this.#items.has(id)) this.#byKey.delete(key);
		this.#sent.delete(stream);
	}

	/** Queues an event. False when the queue overflowed and was emptied. */
	push(stream: string, event: LiveEvent): boolean {
		const bytes = JSON.stringify(event.payload).length + 160;
		if (event.replaceableKey !== null) {
			const key = `${stream}\u0000${event.replaceableKey}`;
			const old = this.#byKey.get(key);
			const queued = old === undefined ? undefined : this.#items.get(old);
			if (queued) {
				this.#items.delete(queued.id);
				this.#bytes -= queued.bytes;
				this.coalesced++;
			}
			this.#byKey.set(key, this.#next);
		}
		this.#items.set(this.#next, { id: this.#next++, stream, event, bytes });
		this.#bytes += bytes;
		if (this.#bytes <= this.maxBytes) return true;
		this.clear();
		return false;
	}

	clear(): void {
		this.#items.clear();
		this.#byKey.clear();
		this.#bytes = 0;
	}

	/** The next frame to send, or null. */
	shift(): ServerFrame | null {
		const first = this.#items.entries().next();
		if (first.done) return null;
		const [id, item] = first.value;
		this.#items.delete(id);
		this.#bytes -= item.bytes;
		if (item.event.replaceableKey !== null) {
			const key = `${item.stream}\u0000${item.event.replaceableKey}`;
			if (this.#byKey.get(key) === id) this.#byKey.delete(key);
		}
		const previous = this.#sent.get(item.stream) ?? 0;
		this.#sent.set(item.stream, item.event.seq);
		const { event } = item;
		return {
			type: "event",
			stream: item.stream,
			seq: event.seq,
			commitSeq: event.commitSeq,
			kind: event.kind,
			replaceableKey: event.replaceableKey,
			payload: event.payload,
			...(event.seq !== previous + 1 ? { coalesced: true as const } : {}),
		};
	}
}
