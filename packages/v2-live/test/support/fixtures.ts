import type { IncomingMessage } from "node:http";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { type Authorizer, ForbiddenError } from "@pim/v2-contracts/authz";
import type { OwnerId, PartitionId, Principal, PublicChatId } from "@pim/v2-contracts/identity";
import type { Pool } from "pg";
import type { LiveIdentity } from "../../src/server/identity.ts";
import type { Transport } from "../../src/server/hub.ts";

type Model = Record<string, unknown>;

export const ADA = "o_ada" as OwnerId;
export const GRACE = "o_grace" as OwnerId;
export const P1 = "11111111-1111-4111-8111-111111111111" as PartitionId;
export const P2 = "22222222-2222-4222-8222-222222222222" as PartitionId;
export const P3 = "33333333-3333-4333-8333-333333333333" as PartitionId;
export const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as PublicChatId;
export const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as PublicChatId;

/** A pi entry as the runtime commits it. */
export function entry(id: number, kind: string, model?: Model): EntryRecord {
	return { id, kind, ...(model ? { model: [model] } : {}) } as unknown as EntryRecord;
}

export const user = (id: number, text: string) => entry(id, "pi.message", { role: "user", content: text, timestamp: 1000 + id });
export const assistant = (id: number, text: string, extra: Model[] = []) =>
	entry(id, "pi.message", { role: "assistant", content: [{ type: "text", text }, ...extra], stopReason: "stop", timestamp: 1000 + id });

/** Commits to `runtime_outbox` as the runtime would: gapless `commitSeq` per partition, one event per commit. */
export class Outbox {
	readonly #seq = new Map<string, number>();
	constructor(
		readonly admin: Pool,
		readonly version = 1,
	) {}
	reset() {
		this.#seq.clear();
	}
	async commit(partition: string, owner: string, chat: string, eventKind: string, payload: object, committedAt?: string): Promise<number> {
		const seq = (this.#seq.get(partition) ?? 0) + 1;
		this.#seq.set(partition, seq);
		await this.admin.query(
			"INSERT INTO pim_runtime.runtime_outbox (partition_id, commit_seq, projection_version, owner_id, public_chat_id, conversation_id, event_kind, payload, committed_at) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, coalesce($8::timestamptz, now()))",
			[partition, seq, this.version, owner, chat, eventKind, JSON.stringify(payload), committedAt ?? null],
		);
		return seq;
	}
	entry(partition: string, owner: string, chat: string, e: EntryRecord, partial = false) {
		return this.commit(partition, owner, chat, "chat.entry", { entry: e, partial });
	}
}

export async function addSession(admin: Pool, owner: string, sessionId: string): Promise<void> {
	await admin.query("INSERT INTO test_identity.accounts (owner_id) VALUES ($1) ON CONFLICT DO NOTHING", [owner]);
	await admin.query("INSERT INTO test_identity.sessions (session_id, owner_id) VALUES ($1, $2)", [sessionId, owner]);
}

export const principal = (owner: OwnerId, sessionId: string): Principal => ({ kind: "user", ownerId: owner, role: "member", sessionId });

/** Gate's part, as a fixture: the cookie names a session, and a revoked session or a suspended account is no longer valid. */
export class FixtureIdentity implements LiveIdentity {
	constructor(readonly admin: Pool) {}
	async authenticate(request: IncomingMessage): Promise<Principal | null> {
		const id = /pim_session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
		if (!id) return null;
		const { rows } = await this.admin.query("SELECT owner_id FROM test_identity.sessions WHERE session_id = $1", [id]);
		return rows[0] ? principal(rows[0].owner_id, id) : null;
	}
	async stillValid(p: Principal): Promise<boolean> {
		if (p.kind !== "user") return false;
		const { rows } = await this.admin.query(
			"SELECT 1 FROM test_identity.sessions s JOIN test_identity.accounts a ON a.owner_id = s.owner_id WHERE s.session_id = $1 AND s.owner_id = $2 AND s.revoked_at IS NULL AND a.status = 'active'",
			[p.sessionId, p.ownerId],
		);
		return rows.length > 0;
	}
}

/** The canonical Authorizer's answer for `live:subscribe`: allowed, except topics in `denied`. */
export class FixtureAuthorizer implements Authorizer {
	denied = new Set<string>();
	async authorize(request: Parameters<Authorizer["authorize"]>[0]) {
		if (request.action === "live:subscribe" && this.denied.has(request.resource?.topic ?? "")) throw new ForbiddenError(request.action, "denied in test");
		return { outcome: "allow" as const };
	}
}

export async function reset(admin: Pool): Promise<void> {
	await admin.query(
		"TRUNCATE pim_projection.chat_transcript_projection, pim_projection.sidebar_session_projection, pim_projection.coding_thread_projection, pim_projection.live_event_log, pim_projection.live_stream_heads, pim_projection.projection_applied, pim_projection.projection_watermarks, pim_runtime.runtime_outbox, pim_runtime.effects_ledger, test_identity.accounts, test_identity.sessions",
	);
}

/** A transport that records what it was sent; `buffer` makes it look like a slow reader. */
export class FakeTransport implements Transport {
	frames: Record<string, any>[] = [];
	closed: { code: number; reason: string } | null = null;
	buffer = 0;
	send(data: string): void {
		this.frames.push(JSON.parse(data));
	}
	buffered(): number {
		return this.buffer;
	}
	close(code: number, reason: string): void {
		this.closed = { code, reason };
	}
	/** Every event-bearing frame of a topic: `event` and `coalesced_progress`. */
	events(topic: string) {
		return this.frames.filter((frame) => (frame.type === "event" || frame.type === "coalesced_progress") && frame.topic === topic);
	}
	/** The commit sequences of a topic's events, in order of delivery. */
	commits(topic: string): number[] {
		return this.events(topic).map((frame) => Number(String(frame.cursor).split(":")[2]));
	}
	of(type: string) {
		return this.frames.filter((frame) => frame.type === type);
	}
}
