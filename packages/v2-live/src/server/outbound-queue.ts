import { type ServerFrame, serializeCursor } from "../contracts.ts";
import type { LiveEvent } from "../contracts.ts";

/**
 * A socket's bounded queue of events it has not been sent yet.
 *
 * - Replaceable progress (a streaming partial) with the same `replaceableKey` replaces the queued one, so a slow
 *   reader holds one of each, not hundreds. It goes out as a `coalesced_progress` frame saying how many updates
 *   it stands for.
 * - Canonical events (a committed message) are never dropped to make room.
 * - When the queue would still exceed its byte cap, it empties and reports overflow: the reader must take an
 *   HTTP snapshot, which is cheaper for everyone than an unbounded buffer or a silent hole.
 *
 * Order is kept: a replacement moves to the tail, so the cursors of one partition only ever increase.
 */
type Queued = { id: number; event: LiveEvent; bytes: number; skipped: number };

export class OutboundQueue {
	readonly #items = new Map<number, Queued>();
	readonly #byKey = new Map<string, number>();
	#next = 0;
	#bytes = 0;
	/** How many queued updates were replaced by a newer one, over the queue's life. */
	coalesced = 0;

	constructor(readonly maxBytes: number) {}

	get bytes(): number {
		return this.#bytes;
	}

	get length(): number {
		return this.#items.size;
	}

	/** Forgets a topic: its queued events go. */
	drop(topic: string): void {
		for (const [id, item] of this.#items) {
			if (item.event.topic !== topic) continue;
			this.#items.delete(id);
			this.#bytes -= item.bytes;
		}
		for (const [key, id] of this.#byKey) if (!this.#items.has(id)) this.#byKey.delete(key);
	}

	/** Queues an event. False when the queue overflowed and was emptied. */
	push(event: LiveEvent): boolean {
		const bytes = JSON.stringify(event.data).length + 200;
		let skipped = 0;
		if (event.replaceableKey !== null) {
			const key = `${event.topic}\u0000${event.replaceableKey}`;
			const old = this.#byKey.get(key);
			const queued = old === undefined ? undefined : this.#items.get(old);
			if (queued) {
				this.#items.delete(queued.id);
				this.#bytes -= queued.bytes;
				skipped = queued.skipped + 1;
				this.coalesced++;
			}
			this.#byKey.set(key, this.#next);
		}
		this.#items.set(this.#next, { id: this.#next++, event, bytes, skipped });
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
		const { event } = item;
		if (event.replaceableKey !== null) {
			const key = `${event.topic}\u0000${event.replaceableKey}`;
			if (this.#byKey.get(key) === id) this.#byKey.delete(key);
		}
		const cursor = serializeCursor(event.cursor);
		return item.skipped > 0
			? { type: "coalesced_progress", topic: event.topic, cursor, skipped: item.skipped, data: event.data }
			: { type: "event", topic: event.topic, cursor, kind: event.kind, data: event.data };
	}
}
