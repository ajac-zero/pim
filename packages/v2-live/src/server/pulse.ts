/**
 * Pulse: the best-effort NATS fanout that tells Live a topic has something new. A message holds only
 * `{ownerId, cursor}` (the canonical `PulseHint`): where to catch up from. It is never the source of truth and
 * never an authorization. A hint that is lost, duplicated or reordered costs latency, because Live reads the
 * PostgreSQL log (see hub.ts).
 */
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { NATS_SUBJECT_ROOT, type PulseHint, pulseSubjects } from "@pim/v2-contracts/live-seam";
import { OwnerId } from "@pim/v2-contracts/identity";
import { subjectOf } from "../contracts.ts";

export interface Pulse {
	publish(topic: string, hint: PulseHint): Promise<void>;
	/** Calls `handler` for each hint of one topic of one owner; returns how to stop. */
	subscribe(ownerId: string, topic: string, handler: (hint: PulseHint) => void): () => void;
	/** Tells every Live replica that an owner's access (or one session of it) ended, so they need not wait for their next check. */
	publishRevocation(ownerId: string, sessionId?: string): Promise<void>;
	onRevocation(handler: (revocation: { ownerId: string; sessionId?: string }) => void): () => void;
	/** Tells an owner's open apps something at once (see the contracts' `NoticeFrame`): best effort, never stored. */
	publishNotice(ownerId: string, notice: Notice): Promise<void>;
	subscribeNotices(ownerId: string, handler: (notice: Notice) => void): () => void;
	/** What an owner's apps said over their Live sockets (`SayFrame`), for whichever process answers it; `connection` names the socket, so what it asked for can end with it. */
	publishSay(ownerId: string, said: Said): Promise<void>;
	/** Every owner's: a process that holds computers hears for all of them. */
	onSay(handler: (ownerId: string, said: Said) => void): () => void;
	close(): Promise<void>;
}

/** `key` names the change, so a notice told twice (by every Gate replica that heard it) is delivered once. */
export type Notice = { kind: string; data?: unknown; key?: string };
export type Said = { kind: string; data?: unknown; connection: string };
/** The most a notice or what an app says may weigh: both are hints, not payloads. */
export const MAX_NOTICE_BYTES = 32_768;
const ALL_SAY = `${NATS_SUBJECT_ROOT}.*.say`;

const revocationSubject = (ownerId: string) => `${NATS_SUBJECT_ROOT}.${OwnerId.parse(ownerId)}.revoked`;
const ALL_REVOCATIONS = `${NATS_SUBJECT_ROOT}.*.revoked`;

/** Whether NATS answers at `servers`: how long a round trip took in milliseconds, or what it said when it did not (it never retries, and it always closes). */
export async function probeNats(servers: string | string[], timeoutMs: number): Promise<number> {
	const nc = await connect({ servers, timeout: timeoutMs, maxReconnectAttempts: 0 });
	try {
		return await nc.rtt();
	} finally {
		await nc.close().catch(() => undefined);
	}
}

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

	async publishNotice(ownerId: string, notice: Notice): Promise<void> {
		const body = JSON.stringify(notice);
		if (body.length <= MAX_NOTICE_BYTES) this.#nc.publish(pulseSubjects.notice(OwnerId.parse(ownerId)), this.#codec.encode(body));
	}

	subscribeNotices(ownerId: string, handler: (notice: Notice) => void): () => void {
		const sub = this.#nc.subscribe(pulseSubjects.notice(OwnerId.parse(ownerId)), {
			callback: (error, message) => {
				if (error) return;
				try {
					const notice = message.json<Notice>();
					if (typeof notice?.kind === "string") handler(notice);
				} catch {
					// A malformed notice is a missed one.
				}
			},
		});
		return () => sub.unsubscribe();
	}

	async publishSay(ownerId: string, said: Said): Promise<void> {
		const body = JSON.stringify(said);
		if (body.length <= MAX_NOTICE_BYTES) this.#nc.publish(pulseSubjects.say(OwnerId.parse(ownerId)), this.#codec.encode(body));
	}

	onSay(handler: (ownerId: string, said: Said) => void): () => void {
		const sub = this.#nc.subscribe(ALL_SAY, {
			callback: (error, message) => {
				if (error) return;
				try {
					const owner = OwnerId.safeParse(message.subject.split(".")[3]);
					const said = message.json<Said>();
					if (owner.success && typeof said?.kind === "string" && typeof said.connection === "string") handler(owner.data, said);
				} catch {
					// A malformed message is a missed one.
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

	readonly #notices = new Map<string, Set<(notice: Notice) => void>>();
	readonly #says = new Set<(ownerId: string, said: Said) => void>();

	async publishNotice(ownerId: string, notice: Notice): Promise<void> {
		if (this.down) return;
		for (const handler of this.#notices.get(ownerId) ?? []) queueMicrotask(() => handler(notice));
	}

	subscribeNotices(ownerId: string, handler: (notice: Notice) => void): () => void {
		const set = this.#notices.get(ownerId) ?? new Set();
		this.#notices.set(ownerId, set);
		set.add(handler);
		return () => set.delete(handler);
	}

	async publishSay(ownerId: string, said: Said): Promise<void> {
		if (this.down) return;
		for (const handler of this.#says) queueMicrotask(() => handler(ownerId, said));
	}

	onSay(handler: (ownerId: string, said: Said) => void): () => void {
		this.#says.add(handler);
		return () => this.#says.delete(handler);
	}

	async close(): Promise<void> {
		this.#subs.clear();
		this.#revocations.clear();
		this.#notices.clear();
		this.#says.clear();
	}
}
