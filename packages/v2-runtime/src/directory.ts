import { randomUUID } from "node:crypto";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { type Db, SCHEMA } from "./db.ts";

const S = SCHEMA;

/** The identifier of the partition that holds conversation 1 and the root-attached optmem.nap. */
export const HOME_PARTITION_ID = "home";

/** The id pi uses for the space's root conversation; it always routes to the home partition. */
export const ROOT_SESSION = String(ROOT_CONVERSATION_ID);

export type PartitionKind = "home" | "family";

/**
 * Where conversations live. A partition is one conversation family (a conversation and every fork of it); the
 * directory is the only translation between a pi conversation id (or a public chat UUID) and the partition that holds it.
 * `ROOT_SESSION` is routed explicitly to the tenant's home partition and never to "the local family root".
 */
export class PartitionDirectory {
	readonly #db: Db;
	constructor(db: Db) {
		this.#db = db;
	}

	/** Create a partition and its due-work row, so a Runner claims it. Idempotent for the same id and kind. */
	async createPartition(tenantId: string, options: { partitionId?: string; kind?: PartitionKind } = {}): Promise<string> {
		const kind = options.kind ?? "family";
		const partitionId = options.partitionId ?? (kind === "home" ? HOME_PARTITION_ID : `p_${randomUUID().replaceAll("-", "")}`);
		await this.#db.transaction(tenantId, async (client) => {
			const inserted = await client.query(`INSERT INTO ${S}.partitions (tenant_id, partition_id, kind) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, partition_id) DO NOTHING RETURNING 1`, [tenantId, partitionId, kind]);
			if (inserted.rowCount === 0) {
				const existing = await client.query<{ kind: string }>(`SELECT kind FROM ${S}.partitions WHERE tenant_id = $1 AND partition_id = $2`, [tenantId, partitionId]);
				if (existing.rows[0]?.kind !== kind) throw new Error(`Partition ${partitionId} already exists with another kind`);
			}
			await client.query(`INSERT INTO ${S}.due_work (tenant_id, partition_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [tenantId, partitionId]);
		});
		return partitionId;
	}

	/** The tenant's home partition, created on first use. */
	ensureHome(tenantId: string): Promise<string> {
		return this.createPartition(tenantId, { kind: "home" });
	}

	async homePartition(tenantId: string): Promise<string | undefined> {
		const result = await this.#db.read<{ partition_id: string }>(tenantId, `SELECT partition_id FROM ${S}.partitions WHERE tenant_id = $1 AND kind = 'home'`, [tenantId]);
		return result.rows[0]?.partition_id;
	}

	/** The partition of a conversation: conversation 1 is the home partition, every other id comes from the directory. */
	async routeConversation(tenantId: string, conversationId: number | string): Promise<string | undefined> {
		const id = Number(conversationId);
		if (!Number.isSafeInteger(id) || id < 1) throw new TypeError(`Not a conversation id: ${String(conversationId)}`);
		if (id === ROOT_CONVERSATION_ID) return this.homePartition(tenantId);
		const result = await this.#db.read<{ partition_id: string }>(tenantId, `SELECT partition_id FROM ${S}.conversation_partitions WHERE tenant_id = $1 AND conversation_id = $2`, [tenantId, id]);
		return result.rows[0]?.partition_id;
	}

	/** The partition and conversation of a public chat id (a UUID). */
	async routeChat(tenantId: string, publicChatId: string): Promise<{ partitionId: string; conversationId: number } | undefined> {
		const result = await this.#db.read<{ partition_id: string; conversation_id: string }>(
			tenantId,
			`SELECT partition_id, conversation_id FROM ${S}.conversation_partitions WHERE tenant_id = $1 AND public_chat_id = $2`,
			[tenantId, publicChatId],
		);
		const row = result.rows[0];
		return row === undefined ? undefined : { partitionId: row.partition_id, conversationId: Number(row.conversation_id) };
	}

	/** Attach the public chat UUID to a conversation the directory already knows. */
	async registerPublicChat(tenantId: string, publicChatId: string, conversationId: number): Promise<void> {
		const result = await this.#db.read(tenantId, `UPDATE ${S}.conversation_partitions SET public_chat_id = $3 WHERE tenant_id = $1 AND conversation_id = $2 AND (public_chat_id IS NULL OR public_chat_id = $3) RETURNING 1`, [
			tenantId,
			conversationId,
			publicChatId,
		]);
		if (result.rowCount === 0) throw new Error(`Conversation ${conversationId} is unknown or already has another public chat id`);
	}
}
