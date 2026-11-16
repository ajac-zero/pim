/**
 * Pulse: the best-effort NATS fanout that tells Live a topic has something new. A message holds only
 * `{ownerId, cursor}` (the canonical `PulseHint`): where to catch up from. It is never the source of truth and
 * never an authorization. A hint that is lost, duplicated or reordered costs latency, because Live reads the
 * PostgreSQL log (see hub.ts).
 */
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { NATS_SUBJECT_ROOT, type PulseHint } from "@pim/v2-contracts/live-seam";
import { OwnerId } from "@pim/v2-contracts/identity";
import { subjectOf } from "../contracts.ts";

export interface Pulse {
	publish(topic: string, hint: PulseHint): Promise<void>;
	/** Calls `handler` for each hint of one topic of one owner; returns how to stop. */
	subscribe(ownerId: string, topic: string, handler: (hint: PulseHint) => void): () => void;
	/** Tells every Live replica that an owner's access (or one session of it) ended, so they need not wait for their next check. */
	publishRevocation(ownerId: string, sessionId?: string): Promise<void>;
	onRevocation(handler: (revocation: { ownerId: string; sessionId?: string }) => void): () => void;
	close(): Promise<void>;
}

const revocationSubject = (ownerId: string) => `${NATS_SUBJECT_ROOT}.${OwnerId.parse(ownerId)}.revoked`;
const ALL_REVOCATIONS = `${NATS_SUBJECT_ROOT}.*.revoked`;

export class NatsPulse implements Pulse {
	readonly #nc: NatsConnection;
	readonly #codec = new TextEncoder();

	private constructor(nc: NatsConnection) {
		this.#nc = nc;
	}

	static async connect(servers: string | string[]): Promise<NatsPulse> {
		return new NatsPulse(await connect({ servers, maxReconnectAttempts: -1, reconnectTimeWait: 250 }));
	}

	async publish(topic: string, hint: PulseHint): Promise<void> {
		this.#nc.publish(subjectOf(hint.ownerId, topic), this.#codec.encode(JSON.stringify(hint)));
	}

	subscribe(ownerId: string, topic: string, handler: (hint: PulseHint) => void): () => void {
		const sub = this.#nc.subscribe(subjectOf(OwnerId.parse(ownerId), topic), {
			callback: (error, message) => {
				if (error) return;
				try {
					const hint = message.json<PulseHint>();
					// The subject is not trusted: a hint that names another owner is ignored.
					if (hint.ownerId === ownerId && typeof hint.cursor === "string") handler(hint);
				} catch {
					// A malformed hint is a missed hint.
				}
			},
		});
		return () => sub.unsubscribe();
	}

	async publishRevocation(ownerId: string, sessionId?: string): Promise<void> {
		this.#nc.publish(revocationSubject(ownerId), this.#codec.encode(JSON.stringify({ ownerId, sessionId })));
	}

	onRevocation(handler: (revocation: { ownerId: string; sessionId?: string }) => void): () => void {
		const sub = this.#nc.subscribe(ALL_REVOCATIONS, {
			callback: (error, message) => {
				if (error) return;
				try {
					handler(message.json());
				} catch {
					// Ignored: the periodic check catches it.
				}
			},
		});
		return () => sub.unsubscribe();
	}

	get connection(): NatsConnection {
		return this.#nc;
	}

	async close(): Promise<void> {
		await this.#nc.drain().catch(() => {});
	}
}

export type FaultOptions = {
	/** The share of hints lost, 0 to 1. */
	dropRate?: number;
	/** A seeded random source, so a run is repeatable. */
	random?: () => number;
};

/** An in-process Pulse that can lose hints, duplicate them, or go down entirely: for tests of what Live does without its bus. */
export class MemoryPulse implements Pulse {
	readonly #subs = new Map<string, Set<(hint: PulseHint) => void>>();
	readonly #revocations = new Set<(revocation: { ownerId: string; sessionId?: string }) => void>();
	dropRate: number;
	duplicateRate = 0;
	/** While true every hint and revocation is lost, as if NATS were unreachable. */
	down = false;
	readonly random: () => number;
	published = 0;

	constructor(options: FaultOptions = {}) {
		this.dropRate = options.dropRate ?? 0;
		this.random = options.random ?? Math.random;
	}

	async publish(topic: string, hint: PulseHint): Promise<void> {
		this.published++;
		if (this.down || this.random() < this.dropRate) return;
		for (const handler of this.#subs.get(subjectOf(hint.ownerId, topic)) ?? []) {
			queueMicrotask(() => handler(hint));
			if (this.random() < this.duplicateRate) queueMicrotask(() => handler(hint));
		}
	}

	subscribe(ownerId: string, topic: string, handler: (hint: PulseHint) => void): () => void {
		const subject = subjectOf(OwnerId.parse(ownerId), topic);
		const set = this.#subs.get(subject) ?? new Set();
		this.#subs.set(subject, set);
		set.add(handler);
		return () => set.delete(handler);
	}

	async publishRevocation(ownerId: string, sessionId?: string): Promise<void> {
		if (this.down) return;
		for (const handler of this.#revocations) handler({ ownerId, ...(sessionId === undefined ? {} : { sessionId }) });
	}

	onRevocation(handler: (revocation: { ownerId: string; sessionId?: string }) => void): () => void {
		this.#revocations.add(handler);
		return () => this.#revocations.delete(handler);
	}

	async close(): Promise<void> {
		this.#subs.clear();
		this.#revocations.clear();
	}
}
