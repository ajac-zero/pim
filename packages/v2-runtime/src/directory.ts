import { randomUUID } from "node:crypto";
import { PartitionId, ROOT_CONVERSATION_ID } from "@pim/v2-contracts/identity";
import { type Db, SCHEMA } from "./db.ts";

const S = SCHEMA;

/** The id pi uses for the space's root conversation; it always routes to the home partition. */
export const ROOT_SESSION = String(ROOT_CONVERSATION_ID);

export type PartitionKind = "home" | "family";

/**
 * Where conversations live. A partition is one conversation family (a conversation and every fork of it); the
 * directory is the only translation between a pi conversation id (or a public chat UUID) and the partition that holds it.
 * `ROOT_SESSION` is routed explicitly to the owner's home partition and never to "the local family root".
 */
export class PartitionDirectory {
	readonly #db: Db;
	constructor(db: Db) {
		this.#db = db;
	}

	/** Create a partition and its due-work row, so a Runner claims it. Idempotent for the same id and kind. */
	async createPartition(ownerId: string, options: { partitionId?: string; kind?: PartitionKind } = {}): Promise<PartitionId> {
		const kind = options.kind ?? "family";
		const partitionId = PartitionId.parse(options.partitionId ?? randomUUID());
		await this.#db.transaction(ownerId, async (client) => {
			const inserted = await client.query(`INSERT INTO ${S}.partitions (owner_id, partition_id, kind) VALUES ($1, $2, $3) ON CONFLICT (owner_id, partition_id) DO NOTHING RETURNING 1`, [ownerId, partitionId, kind]);
			if (inserted.rowCount === 0) {
				const existing = await client.query<{ kind: string }>(`SELECT kind FROM ${S}.partitions WHERE owner_id = $1 AND partition_id = $2`, [ownerId, partitionId]);
				if (existing.rows[0]?.kind !== kind) throw new Error(`Partition ${partitionId} already exists with another kind`);
			}
			await client.query(`INSERT INTO ${S}.due_work (owner_id, partition_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ownerId, partitionId]);
		});
		return partitionId;
	}

	/** The owner's home partition, created on first use. */
	async ensureHome(ownerId: string): Promise<PartitionId> {
		return (await this.homePartition(ownerId)) ?? this.createPartition(ownerId, { kind: "home" });
	}

	async homePartition(ownerId: string): Promise<PartitionId | undefined> {
		const result = await this.#db.read<{ partition_id: string }>(ownerId, `SELECT partition_id FROM ${S}.partitions WHERE owner_id = $1 AND kind = 'home'`, [ownerId]);
		return result.rows[0] === undefined ? undefined : PartitionId.parse(result.rows[0].partition_id);
	}

	/** The partition of a conversation: conversation 1 is the home partition, every other id comes from the directory. */
	async routeConversation(ownerId: string, conversationId: number | string): Promise<PartitionId | undefined> {
		const id = Number(conversationId);
		if (!Number.isSafeInteger(id) || id < 1) throw new TypeError(`Not a conversation id: ${String(conversationId)}`);
		if (id === ROOT_CONVERSATION_ID) return this.homePartition(ownerId);
		const result = await this.#db.read<{ partition_id: string }>(ownerId, `SELECT partition_id FROM ${S}.conversation_partitions WHERE owner_id = $1 AND conversation_id = $2`, [ownerId, id]);
		return result.rows[0] === undefined ? undefined : PartitionId.parse(result.rows[0].partition_id);
	}

	/** The public chat id (a UUID) of a conversation: the one clients and URLs use. */
	async publicChatId(ownerId: string, conversationId: number): Promise<string | undefined> {
		const result = await this.#db.read<{ public_chat_id: string }>(ownerId, `SELECT public_chat_id FROM ${S}.conversation_partitions WHERE owner_id = $1 AND conversation_id = $2`, [ownerId, conversationId]);
		return result.rows[0]?.public_chat_id;
	}

	/** The partition and conversation of a public chat id (a UUID). */
	async routeChat(ownerId: string, publicChatId: string): Promise<{ partitionId: string; conversationId: number } | undefined> {
		const result = await this.#db.read<{ partition_id: string; conversation_id: string }>(
			ownerId,
			`SELECT partition_id, conversation_id FROM ${S}.conversation_partitions WHERE owner_id = $1 AND public_chat_id = $2`,
			[ownerId, publicChatId],
		);
		const row = result.rows[0];
		return row === undefined ? undefined : { partitionId: row.partition_id, conversationId: Number(row.conversation_id) };
	}

	/**
	 * Replace the public chat id of a conversation, only while nothing has been published with the old one: the commit that
	 * creates a conversation writes an outbox event carrying its id, so a conversation made by a commit cannot be renamed.
	 * Use `PgPiStorage.reservePublicChatId` to choose the id of a conversation about to be created; this is for a conversation that has no events.
	 */
	async registerPublicChat(ownerId: string, publicChatId: string, conversationId: number): Promise<void> {
		const result = await this.#db.read(ownerId, `UPDATE ${S}.conversation_partitions SET public_chat_id = $3 WHERE owner_id = $1 AND conversation_id = $2 AND NOT EXISTS (SELECT 1 FROM ${S}.runtime_outbox o WHERE o.owner_id = $1 AND o.conversation_id = $2 AND o.public_chat_id <> $3) RETURNING 1`, [
			ownerId,
			conversationId,
			publicChatId,
		]);
		if (result.rowCount === 0) throw new Error(`Conversation ${conversationId} is unknown or has already been published under another public chat id`);
	}
}
