import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Pool } from "pg";
import type { OutboxEvent } from "../../src/contracts.ts";
import type { Transport } from "../../src/server/hub.ts";

type Model = Record<string, unknown>;

/** A pi entry as the runtime commits it. */
export function entry(id: number, kind: string, model?: Model): EntryRecord {
	return { id, kind, ...(model ? { model: [model] } : {}) } as unknown as EntryRecord;
}

export const user = (id: number, text: string) => entry(id, "pi.message", { role: "user", content: text, timestamp: 1000 + id });
export const assistant = (id: number, text: string, extra: Model[] = []) =>
	entry(id, "pi.message", { role: "assistant", content: [{ type: "text", text }, ...extra], stopReason: "stop", timestamp: 1000 + id });

/** Commits one outbox row, as the runtime would. */
export async function commit(pool: Pool, partitionId: string, commitSeq: number, tenantId: string, events: OutboxEvent[]): Promise<void> {
	await pool.query("INSERT INTO pim_runtime.runtime_outbox (partition_id, commit_seq, tenant_id, payload) VALUES ($1, $2, $3, $4)", [partitionId, commitSeq, tenantId, JSON.stringify({ events })]);
}

export async function addAccount(pool: Pool, tenantId: string, sessionId: string, userId = "user-1"): Promise<void> {
	await pool.query("INSERT INTO pim_identity.accounts (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [tenantId]);
	await pool.query("INSERT INTO pim_identity.sessions (session_id, tenant_id, user_id) VALUES ($1, $2, $3)", [sessionId, tenantId, userId]);
}

export async function reset(pool: Pool): Promise<void> {
	await pool.query(
		"TRUNCATE pim_projection.chat_transcript_projection, pim_projection.sidebar_session_projection, pim_projection.coding_thread_projection, pim_projection.live_event_log, pim_projection.live_stream_heads, pim_projection.projection_applied, pim_projection.projection_watermarks, pim_runtime.runtime_outbox, pim_runtime.effects_ledger, pim_identity.accounts, pim_identity.sessions",
	);
}

/** A transport that records what it was sent; `buffer` makes it look like a slow reader. */
export class FakeTransport implements Transport {
	frames: Record<string, unknown>[] = [];
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
	events(stream: string) {
		return this.frames.filter((frame) => frame.type === "event" && frame.stream === stream) as { seq: number; kind: string; payload: any; replaceableKey: string | null; coalesced?: true }[];
	}
	seqs(stream: string): number[] {
		return this.events(stream).map((event) => event.seq);
	}
	of(type: string) {
		return this.frames.filter((frame) => frame.type === type) as any[];
	}
}
