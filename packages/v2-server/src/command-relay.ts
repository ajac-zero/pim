/**
 * Gate to runtime. The Gate admits a chat command in one short transaction (`pim_app.accepted_commands` and `command_inbox`) and answers at
 * once. This relay, which runs in the Runner, carries each command into the runtime's own inbox, where a Runner holding the chat's partition
 * delivers it to pi, and tells the application's ledger once pi has taken it (`inbox_accepted` to `runtime_committed`).
 *
 * The application chooses a chat's partition and public id; the runtime allocates pi's numeric ids. So the first command of a chat creates its
 * family partition under the application's partition id and a conversation under its public chat id (`create_conversation`), waits for the runtime to
 * route the chat, and only then sends the real command addressed to the conversation pi made. Every step is idempotent by command id, so a
 * relay that crashes anywhere simply repeats it.
 */
import { OwnerId, PartitionId, PublicChatId } from "@pim/v2-contracts/identity";
import { CommandSubmission } from "@pim/v2-contracts/runtime-seam";
import type { Db } from "@pim/v2-runtime/db";
import type { PartitionDirectory } from "@pim/v2-runtime/directory";
import type { PartitionInbox } from "@pim/v2-runtime/signals";
import type { Pool } from "pg";

type Claimed = { owner_id: string; command_id: string; kind: string; public_chat_id: string; pi_request_id: string; payload: Record<string, unknown>; accepted_at: Date; partition_id: string; provisional_conversation_id: string };

export type RelayDeps = {
	/** A connection as `pim_runtime`: it reaches the application only through the relay functions. */
	pool: Pool;
	db: Db;
	inbox: PartitionInbox;
	directory: PartitionDirectory;
	holder: string;
	/** How long a claim holds a row before another relay may take it: the time to hand off and confirm one batch. */
	leaseMs?: number;
	batch?: number;
	onError?: (error: unknown) => void;
};

export class CommandRelay {
	/** Commands handed to the runtime and not yet taken by pi, to confirm without waiting for their claim to lapse. */
	readonly #handed = new Map<string, { ownerId: string; partitionId: string; commandId: string }>();
	readonly #deps: RelayDeps;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running = false;

	constructor(deps: RelayDeps) {
		this.#deps = deps;
	}

	/** One pass: confirm what pi has taken, then claim and hand over what is queued. Returns how many commands it handed over. */
	async tick(): Promise<number> {
		await this.#confirm();
		const { rows } = await this.#deps.pool.query<Claimed>("SELECT * FROM pim_app.relay_claim($1, $2, $3)", [this.#deps.holder, this.#deps.batch ?? 20, this.#deps.leaseMs ?? 15_000]);
		let handed = 0;
		for (const row of rows) {
			try {
				if (await this.#hand(row)) handed++;
			} catch (error) {
				this.#deps.onError?.(error);
				await this.#deps.pool.query("SELECT pim_app.relay_release($1, $2)", [row.owner_id, row.command_id]).catch(() => undefined);
			}
		}
		return handed;
	}

	async #hand(row: Claimed): Promise<boolean> {
		const owner = OwnerId.parse(row.owner_id);
		const partition = PartitionId.parse(row.partition_id);
		const chat = PublicChatId.parse(row.public_chat_id);
		const { directory, inbox, pool } = this.#deps;
		// A chat's partition is made on its first command, as a family; one that already exists (an imported home partition, which holds a person's first chat) is left as it is.
		const known = await this.#deps.db.read(owner, "SELECT 1 FROM pim_runtime.partitions WHERE owner_id = $1 AND partition_id = $2", [owner, partition]);
		if (!known.rowCount) await directory.createPartition(owner, { partitionId: partition, kind: "family" });
		// A fork is made in its family from its parent's conversation, so that is where its command goes; any other command goes to its own chat.
		const route = await directory.routeChat(owner, row.kind === "fork" ? PublicChatId.parse(row.payload.parent) : chat);
		if (!route) {
			// The conversation does not exist yet: ask for it, and look again at the next pass.
			if (row.kind !== "fork") await inbox.enqueueCreateConversation(owner, partition, { commandId: `create:${chat}`, publicChatId: chat, firstInput: null });
			await pool.query("SELECT pim_app.relay_release($1, $2)", [owner, row.command_id]);
			return false;
		}
		const { _fingerprint: _f, _result: _r, ...payload } = row.payload as Record<string, unknown>;
		await inbox.enqueueCommand(
			CommandSubmission.parse({
				commandId: row.command_id,
				ownerId: owner,
				partitionId: route.partitionId,
				conversationId: route.conversationId,
				publicChatId: chat,
				piRequestId: row.pi_request_id,
				kind: row.kind,
				payload,
				submittedAt: row.accepted_at.toISOString(),
			}),
		);
		this.#handed.set(`${owner}\n${row.command_id}`, { ownerId: owner, partitionId: route.partitionId, commandId: row.command_id });
		return true;
	}

	/** A command is committed once the runtime's inbox row is done, which a Runner marks only after pi durably admitted it. */
	async #confirm(): Promise<void> {
		for (const [key, h] of [...this.#handed]) {
			const done = await this.#deps.db.read<{ done_at: Date | null }>(h.ownerId, "SELECT done_at FROM pim_runtime.command_inbox WHERE owner_id = $1 AND partition_id = $2 AND command_id = $3", [h.ownerId, h.partitionId, h.commandId]);
			if (done.rows[0]?.done_at) {
				await this.#deps.pool.query("SELECT pim_app.relay_committed($1, $2)", [h.ownerId, h.commandId]);
				this.#handed.delete(key);
			}
		}
	}

	start(pollMs = 100): void {
		if (this.#running) return;
		this.#running = true;
		const loop = async () => {
			if (!this.#running) return;
			let busy = 0;
			try {
				busy = await this.tick();
			} catch (error) {
				this.#deps.onError?.(error);
			}
			if (this.#running) this.#timer = setTimeout(loop, busy > 0 ? 0 : pollMs);
		};
		void loop();
	}

	stop(): void {
		this.#running = false;
		if (this.#timer) clearTimeout(this.#timer);
	}
}
