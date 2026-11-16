/**
 * Pulse: the best-effort fanout that tells Live a stream has a new event. It is a hint, never the source of
 * truth and never an authorization: a hint that is lost, duplicated or reordered costs latency, because Live
 * repairs from the PostgreSQL log (see hub.ts).
 */
import { connect, type NatsConnection } from "@nats-io/transport-node";
import type { PulseHint } from "../contracts.ts";

export interface Pulse {
	publish(hint: PulseHint): Promise<void>;
	/** Calls `handler` for each hint of one stream of one tenant; returns how to stop. */
	subscribe(tenantId: string, streamKey: string, handler: (hint: PulseHint) => void): () => void;
	/** Tells every Live replica that a tenant's access (or one session of it) ended, so they need not wait for their next check. */
	publishRevocation(tenantId: string, sessionId?: string): Promise<void>;
	onRevocation(handler: (revocation: { tenantId: string; sessionId?: string }) => void): () => void;
	close(): Promise<void>;
}

/** A NATS subject token for any string: characters outside [A-Za-z0-9-] become `_` and their hex code. */
export function token(value: string): string {
	return value.replace(/[^A-Za-z0-9-]/g, (char) => `_${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export const hintSubject = (tenantId: string, streamKey: string) => `pim.live.hint.${token(tenantId)}.${token(streamKey)}`;
export const REVOCATIONS = "pim.live.revoked";

export class NatsPulse implements Pulse {
	readonly #nc: NatsConnection;
	readonly #codec = new TextEncoder();

	private constructor(nc: NatsConnection) {
		this.#nc = nc;
	}

	static async connect(servers: string | string[]): Promise<NatsPulse> {
		return new NatsPulse(await connect({ servers, maxReconnectAttempts: -1, reconnectTimeWait: 250 }));
	}

	async publish(hint: PulseHint): Promise<void> {
		this.#nc.publish(hintSubject(hint.tenantId, hint.streamKey), this.#codec.encode(JSON.stringify(hint)));
	}

	subscribe(tenantId: string, streamKey: string, handler: (hint: PulseHint) => void): () => void {
		const sub = this.#nc.subscribe(hintSubject(tenantId, streamKey), {
			callback: (error, message) => {
				if (error) return;
				try {
					const hint = message.json<PulseHint>();
					// The subject is not trusted: a hint for another stream is ignored, and the log is read by the subscriber's own tenant.
					if (hint.tenantId === tenantId && hint.streamKey === streamKey) handler(hint);
				} catch {
					// A malformed hint is a missed hint.
				}
			},
		});
		return () => sub.unsubscribe();
	}

	async publishRevocation(tenantId: string, sessionId?: string): Promise<void> {
		this.#nc.publish(REVOCATIONS, this.#codec.encode(JSON.stringify({ tenantId, sessionId })));
	}

	onRevocation(handler: (revocation: { tenantId: string; sessionId?: string }) => void): () => void {
		const sub = this.#nc.subscribe(REVOCATIONS, {
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
	readonly #revocations = new Set<(revocation: { tenantId: string; sessionId?: string }) => void>();
	dropRate: number;
	duplicateRate = 0;
	/** While true every hint and revocation is lost, as if NATS were unreachable. */
	down = false;
	readonly random: () => number;
	published = 0;
	delivered = 0;

	constructor(options: FaultOptions = {}) {
		this.dropRate = options.dropRate ?? 0;
		this.random = options.random ?? Math.random;
	}

	async publish(hint: PulseHint): Promise<void> {
		this.published++;
		if (this.down || this.random() < this.dropRate) return;
		const handlers = this.#subs.get(hintSubject(hint.tenantId, hint.streamKey));
		for (const handler of handlers ?? []) {
			this.delivered++;
			queueMicrotask(() => handler(hint));
			if (this.random() < this.duplicateRate) queueMicrotask(() => handler(hint));
		}
	}

	subscribe(tenantId: string, streamKey: string, handler: (hint: PulseHint) => void): () => void {
		const subject = hintSubject(tenantId, streamKey);
		const set = this.#subs.get(subject) ?? new Set();
		this.#subs.set(subject, set);
		set.add(handler);
		return () => set.delete(handler);
	}

	async publishRevocation(tenantId: string, sessionId?: string): Promise<void> {
		if (this.down) return;
		for (const handler of this.#revocations) handler({ tenantId, ...(sessionId === undefined ? {} : { sessionId }) });
	}

	onRevocation(handler: (revocation: { tenantId: string; sessionId?: string }) => void): () => void {
		this.#revocations.add(handler);
		return () => this.#revocations.delete(handler);
	}

	async close(): Promise<void> {
		this.#subs.clear();
		this.#revocations.clear();
	}
}
