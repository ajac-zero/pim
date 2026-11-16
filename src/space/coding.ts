/**
 * Pim's side of its coding threads (src/coding/): what a thread asks of the space over RPC, such as its model provider and the ChatGPT token,
 * waking the chat that started one, asking to approve a push, noticing a stall, and the vault of the harnesses' logins.
 */
import { ActivityWatch, type Activity } from "../activity";
import type { Models } from "@earendil-works/pi-ai/models";
import type { PiModel } from "agents/harness/pi";
import { digestHex } from "../auth/store";
import type { CustomProvider } from "../providers";
import { CHATGPT_PROVIDER } from "../chatgpt";
import { byteLength } from "../extensions/optmem/store";
import { HttpError } from "@pim/shared/http";
import type { PublicApproval, ServerMessage } from "../protocol";
import { type Approval, type ApprovalStatus, type Notification, PimStore } from "../store";
import { RoomStore } from "../rooms";
import { codingScheduler } from "../coding/scheduler-do";
import { HARNESSES, type CodingVaultKey, type Harness as CodingHarness, isHarness } from "@pim/shared/harnesses";
import { type VaultRecord, type VaultStatus, VaultStore, type VaultWriteResult } from "@pim/coding/vault/store";
import type { Submit } from "./conversations";

/** Meta marking a coding thread's turn whose end has woken the agent's chat, by the turn's key (`codingTurnEnded`). */
export const CODING_WAKE_KEY = "coding_woken:";

/** What the space's side of its coding threads needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface CodingHost {
	readonly customProviders: () => { catalogId: string; shared: boolean; provider: CustomProvider; }[];
	readonly closed: () => boolean;
	readonly chosenModel: () => PiModel;
	readonly modelCatalog: () => Models;
	readonly broadcastMessage: (message: ServerMessage) => void;
	readonly store: PimStore;
	readonly rooms: RoomStore;
	readonly selectAbilities: (session: string) => Promise<void>;
	readonly submitTo: Submit;
	readonly carriedOn: (session: string) => Promise<string>;
	readonly name: string;
	readonly assertOpen: () => void;
	readonly publicApproval: (approval: Approval) => PublicApproval;
	readonly deliverNotification: (notification: Notification, options?: { sockets?: boolean; push?: boolean; }) => Promise<void>;
	readonly ctx: DurableObjectState<{}>;
	readonly env: Env;
	readonly activityWatch: ActivityWatch;
	readonly note: (event: string, fields: Record<string, unknown>) => void;
	readonly keepImage: (session: string, bytes: Uint8Array, type: string) => Promise<string | null>;
	readonly codingTurnEnded: (chat: string, text: string, key: string, agent?: string) => Promise<boolean>;
}

export class SpaceCoding {
	constructor(private readonly host: CodingHost) {}

	/**
	 * One of the space's model providers by its catalog id, key included, or
	 * null. Only for the space's coding threads (src/coding/thread-do.ts),
	 * which call their model from their own Durable Objects and keep the
	 * provider in memory only; it is never served by the API.
	 */
	async codingModelProvider(catalogId: string): Promise<CustomProvider | null> {
		return this.host.customProviders().find((entry) => entry.catalogId === catalogId)?.provider ?? null;
	}

	/**
	 * The space's key for a family of model APIs, for a coding thread's model
	 * gateway (src/coding/model-gateway.ts), which adds it to what a CLI in
	 * the thread's workspace sends: the built-in provider of that service the
	 * thread runs on, else the person's own, else the admin's. Null when the
	 * space has none, or is closed. The thread keeps it in memory for the one
	 * request only.
	 */
	async codingGatewayCredential(family: string, preferred: string | null): Promise<{ providerId: string; url: string; key: string } | null> {
		if (this.host.closed()) return null;
		const keyed = this.host.customProviders().filter((entry) => entry.provider.builtin === family && entry.provider.key);
		const chosen = keyed.find((entry) => entry.catalogId === preferred) ?? keyed.find((entry) => !entry.shared) ?? keyed[0];
		return chosen ? { providerId: chosen.catalogId, url: chosen.provider.url, key: chosen.provider.key! } : null;
	}

	/**
	 * The model a coding thread started without one runs on: the space's, as
	 * agents without a model of their own use it, the ChatGPT plan's included.
	 * Never the deployment's default in its place: that is Workers AI, which
	 * the person doesn't want coding threads on.
	 */
	async codingDefaultProfile(): Promise<{ providerId: string; model: string }> {
		const model = this.host.chosenModel();
		return { providerId: model.provider, model: model.id };
	}

	/**
	 * The ChatGPT plan's access token, for a coding thread's model calls
	 * (src/coding/thread-do.ts), which keep it in memory for the one request.
	 * Refreshed here, through the space's one catalog, so a thread never
	 * refreshes it and never races this Pim's own refresh. Null when not signed in.
	 */
	async codingChatgptToken(): Promise<string | null> {
		if (this.host.closed()) return null;
		return (await this.host.modelCatalog().getAuth(CHATGPT_PROVIDER))?.auth.apiKey ?? null;
	}

	/**
	 * Keeps an image or MP4/WebM video a coding thread's agent showed, such as an Amp attachment the thread fetched with the
	 * space's Amp login, as the thread's own: its `/api/images/<id>` URL, or null when it isn't an image
	 * or video Pim keeps or the space has no room for it. Archiving the thread keeps it, as the transcript stays readable.
	 */
	async codingKeepImage(threadId: string, bytes: Uint8Array, type: string): Promise<string | null> {
		if (this.host.closed()) return null;
		return this.host.keepImage(`coding:${threadId}`, bytes, type);
	}

	/** The space's coding threads changed (one started, changed state or archived): open pages refresh their lists, as for a chat. */
	codingThreadsChanged(): void {
		this.host.broadcastMessage({ type: "sessions" });
	}

	/**
	 * A coding thread an agent started ended a turn: the chat it started the
	 * thread from, by its public ID, is woken with `text`, as a scheduled task
	 * wakes a chat, once for each `key`. A chat that was deleted, or a space
	 * that can't take it now (erased, suspended, at a limit), is left be. Says
	 * whether it woke.
	 */
	async codingTurnEnded(chat: string, text: string, key: string, agent?: string): Promise<boolean> {
		const named = this.host.store.sessionOf(chat);
		// A thread recorded under an agent's own conversation in a room belongs to the room's chat.
		const session = named === undefined ? undefined : (this.host.rooms.of(named)?.room ?? named);
		if (this.host.closed() || session === undefined || !this.host.store.sessionInfo(session) || this.host.store.deletedSessions().has(session)) return false;
		const woken = `${CODING_WAKE_KEY}${key}`;
		if (this.host.store.meta(woken) !== undefined) return false;
		// Claimed first, so the same turn told twice at once wakes the chat once.
		this.host.store.setMeta(woken, "1");
		try {
			// In a room it is the agent that started the thread that is woken, in its seat.
			const seat = agent === undefined ? undefined : this.host.rooms.at(session, agent);
			const target = seat?.conversation ?? session;
			if (seat) await this.host.selectAbilities(target);
			await this.host.submitTo(await this.host.carriedOn(target), text, { operationId: key, whenBusy: "followUp" }, "pim");
			if (seat && seat.conversation !== seat.room) this.host.broadcastMessage({ type: "sessions" });
			return true;
		} catch (error) {
			this.host.store.deleteMeta(woken);
			if (!(error instanceof HttpError)) throw error;
			console.warn(JSON.stringify({ event: "pim.coding.wake_skipped", owner: this.host.name, status: error.status }));
			return false;
		}
	}

	/**
	 * Asks the person to approve pushing a coding thread's branch, from the
	 * API (src/coding/api.ts): an approval of the `coding_push_for_approval` action
	 * (src/extensions/coding.ts) that no tool call waits for, which runs the
	 * push once approved. Asking again for the same push is the same approval.
	 */
	async codingRequestPush(threadId: string, push: { branch: string; checkpoint: string; head: string; summary: string }): Promise<{ id: string; status: ApprovalStatus }> {
		this.host.assertOpen();
		const id = `cp-${(await digestHex(`${threadId}\n${push.branch}\n${push.head}`)).slice(0, 32)}`;
		const known = this.host.store.approval(id);
		if (known) return { id, status: known.status };
		const approval = this.host.store.requestApproval({
			id,
			session: `coding:${threadId}`,
			callId: null,
			action: "coding_push_for_approval",
			tool: null,
			args: { thread_id: threadId, branch: push.branch, checkpoint: push.checkpoint, head: push.head },
			summary: push.summary,
			createdAt: Date.now(),
			expiresAt: null,
			onTimeout: "deny",
		});
		this.host.broadcastMessage({ type: "approval", approval: this.host.publicApproval(approval) });
		const notification = this.host.store.addNotification({ id: crypto.randomUUID(), session: null, title: "Pim needs your approval", body: approval.summary });
		await this.host.deliverNotification(notification, { sockets: false });
		return { id, status: approval.status };
	}

	/** The space's coding harness logins (src/coding/vault), made on first use. */
	#codingVaultStore: VaultStore | null = null;

	#codingVault(harness?: unknown): VaultStore {
		this.host.assertOpen();
		if (harness !== undefined && harness !== "amp-http-m2m" && !isHarness(harness)) throw new HttpError(404, "No such coding harness");
		return (this.#codingVaultStore ??= new VaultStore(this.host.ctx.storage.sql));
	}

	/**
	 * The coding vault (packages/coding/src/vault/vault.ts) keeps each harness's login
	 * here, sealed before it arrives: this object stores the blob and its
	 * version and never opens it. Only for the vault, over RPC; the API
	 * serves the status alone.
	 */
	async codingVaultStatus(): Promise<VaultStatus[]> {
		const vault = this.#codingVault();
		return HARNESSES.map((harness) => vault.status(harness));
	}

	async codingVaultRead(harness: CodingVaultKey): Promise<VaultRecord> {
		return this.#codingVault(harness).read(harness);
	}

	async codingVaultWrite(harness: CodingVaultKey, sealed: Uint8Array, byteLength: number, expectedVersion: number): Promise<VaultWriteResult> {
		return this.#codingVault(harness).write(harness, sealed, byteLength, expectedVersion, Date.now());
	}

	async codingVaultDelete(harness: CodingHarness): Promise<VaultStatus> {
		return this.#codingVault(harness).delete(harness, Date.now());
	}

	/**
	 * A stalled coding thread wakes the chat of the agent that started it, once per quiet spell, and no other.
	 * A thread the person started has no parent to tell, and a thread that is no longer running has nothing
	 * left to stall: both are dropped, never sent to another chat.
	 */
	async codingStalled(threadId: string, activity: Activity): Promise<void> {
		const thread = await codingScheduler(this.host.env, this.host.name).thread(threadId);
		if (!thread || thread.state !== "running" || thread.createdBy.type !== "agent") return;
		await this.#notifyStalls(`coding:${threadId}`, activity, thread.createdBy.chat, thread.createdBy.agent);
	}

	async #notifyStalls(source: string, activity: Activity, chat: string, agent?: string): Promise<void> {
		for (const stall of activity.stalls) {
			const key = `stall:${source}:${stall.key}`;
			if (!this.host.activityWatch.claim(key, Date.now())) continue;
			this.host.note("activity_stalled", { source, reason: stall.reason, since: stall.since });
			try {
				await this.host.codingTurnEnded(chat, `[Coding thread ${source}] Stalled: ${stall.reason}. Last activity: ${new Date(activity.lastActivityAt).toISOString()}. ${activity.current.map((tool) => `${tool.name}: ${tool.summary} (${Math.floor(tool.elapsedMs / 1000)} s)`).join("; ")}`, key, agent);
			} catch (error) {
				this.host.activityWatch.retry(key);
				throw error;
			}
		}
	}
}
