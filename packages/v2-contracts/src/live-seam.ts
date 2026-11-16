import { z } from "zod";
import type { OwnerId, PartitionId } from "./identity.ts";

/** A position in a partition's projection stream: the last commit applied and the projection's version. */
export interface ProjectionCursor {
	readonly partitionId: PartitionId;
	readonly commitSeq: bigint;
	readonly projectionVersion: number;
}

/** Orders cursors of one partition: negative when `a` is behind `b`. A different projection version has no order and must be rebuilt from a snapshot. */
export function compareCursors(a: ProjectionCursor, b: ProjectionCursor): number {
	if (a.partitionId !== b.partitionId) throw new Error("Cursors of different partitions have no order");
	if (a.projectionVersion !== b.projectionVersion) throw new Error("Cursors of different projection versions have no order");
	return a.commitSeq < b.commitSeq ? -1 : a.commitSeq > b.commitSeq ? 1 : 0;
}

/** `partitionId:projectionVersion:commitSeq`, the form that travels in frames and URLs. */
export function serializeCursor(cursor: ProjectionCursor): string {
	return `${cursor.partitionId}:${cursor.projectionVersion}:${cursor.commitSeq}`;
}

export function parseCursor(text: string): ProjectionCursor {
	const match = /^([0-9a-f-]{36}):(\d+):(\d+)$/i.exec(text);
	if (!match) throw new Error(`Not a cursor: ${text}`);
	return { partitionId: match[1] as PartitionId, projectionVersion: Number(match[2]), commitSeq: BigInt(match[3]!) };
}

/**
 * NATS carries wake and hint envelopes only. It never holds canonical state and never decides who may see
 * what: a subscriber learns that something changed, then reads PostgreSQL through Gate, which authorizes.
 */
export const NATS_SUBJECT_ROOT = "pim.v2.tenant";

export const pulseSubjects = {
	chat: (ownerId: OwnerId, chatId: string) => `${NATS_SUBJECT_ROOT}.${ownerId}.chat.${chatId}`,
	sidebar: (ownerId: OwnerId) => `${NATS_SUBJECT_ROOT}.${ownerId}.sidebar`,
	coding: (ownerId: OwnerId, threadId: string) => `${NATS_SUBJECT_ROOT}.${ownerId}.coding.${threadId}`,
} as const;

/** The only thing a Pulse message holds: where to catch up from. */
export interface PulseHint {
	readonly ownerId: OwnerId;
	readonly cursor: string;
}

/** Frames a client sends and receives on the Live WebSocket. */
export const SubscribeFrame = z.object({ type: z.literal("subscribe"), topic: z.string(), cursor: z.string().optional() });
export const AckFrame = z.object({ type: z.literal("ack"), cursor: z.string() });
export const CursorReplayFrame = z.object({ type: z.literal("cursor_replay"), topic: z.string(), from: z.string(), to: z.string() });
export const EventFrame = z.object({ type: z.literal("event"), topic: z.string(), cursor: z.string(), kind: z.string(), data: z.unknown() });
/** Many progress updates folded into the latest one, for a slow client. */
export const CoalescedProgressFrame = z.object({ type: z.literal("coalesced_progress"), topic: z.string(), cursor: z.string(), skipped: z.number().int().nonnegative(), data: z.unknown() });
/** The client is too far behind or on another projection version: fetch a snapshot, then subscribe from its cursor. */
export const SnapshotRequiredFrame = z.object({ type: z.literal("snapshot_required"), topic: z.string(), reason: z.enum(["gap", "projection_version", "expired"]) });
export const ErrorFrame = z.object({ type: z.literal("error"), code: z.string(), message: z.string() });

export const ClientFrame = z.discriminatedUnion("type", [SubscribeFrame, AckFrame]);
export const ServerFrame = z.discriminatedUnion("type", [CursorReplayFrame, EventFrame, CoalescedProgressFrame, SnapshotRequiredFrame, AckFrame, ErrorFrame]);
export type ClientFrame = z.infer<typeof ClientFrame>;
export type ServerFrame = z.infer<typeof ServerFrame>;
