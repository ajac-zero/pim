/**
 * What a space shares with other people and receives from them: circles and their guests, what a guest may see and call, the gallery's agents,
 * apps and bots, a bot's tools, and visits to other people's agents.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, TaskId } from "@earendil-works/pi-durable";
import { getAgentByName } from "agents";
import { type PiModel, PiHarness } from "agents/harness/pi";
import { ENTRY_FILES, type ArtifactFile, type ArtifactKind, type ArtifactSummary, ArtifactStore, type DataScope, readFiles } from "../artifacts";
import { OWN_PROVIDER } from "../providers";
import { type Circle, CircleStore, GUEST_CALLS_PER_DAY, type Guest, MAX_MEMBERS, type Member } from "../circles";
import { CHATGPT_PROVIDER } from "../chatgpt";
import { type BotTool, type BotToolCall, type BotToolResult, botToolError, botToolsExtension } from "../extensions/bot-tools";
import { drawImage, GENERATE_IMAGE, type ImageServices, SHARED_IMAGE_TOOL } from "../extensions/image-generation";
import type { DirectoryApp } from "../extensions/app-directory";
import { appToolPermission, type McpBridge, type McpServerInfo, type McpToolInfo, serverFor, summarizeCall, toContent, toolName, toText } from "../extensions/mcp";
import { MESSAGING_EXTENSION } from "../extensions/messaging";
import type { MemoryScope } from "../extensions/optmem";
import { HostedApps } from "../hosted";
import { FILES_ROOT, Files, filesPath } from "../files";
import { HttpError } from "@pim/shared/http";
import type { PublicApproval, ServerMessage } from "../protocol";
import type { Settings } from "../settings";
import { type Approval, type Notification, PimStore } from "../store";
import { type Agent, type AgentInput, AgentStore, agentInput, freeName, MAX_AGENTS } from "../agents";
import type { AgentIcon, ArtifactToPublish, Bot, BotModel, PublishedAgent } from "../gallery";
import type { Task } from "../tasks";
import { TELEMETRY_EXTENSION } from "../telemetry";
import { type Limits, UsageMeter } from "../usage";
import { type BriefResult, type GuestBrief, type GuestCallResult, VisitStore, visitExtension, visitExtensionName } from "../visits";
import type { Submit } from "./conversations";
import { APPROVAL_EXPIRY_CALLBACK, type OwnerStatus, type OwnerProfile, type GuestBot, LIMITS_KEY, ARTIFACT_ID } from "./shared";

/** How long a guest's request waits for the owner before it is denied. */
export const GUEST_APPROVAL_MS = 24 * 60 * 60 * 1000;

/** The action of an approval a bot's guest's call filed: the call itself runs the tool, once approved. */
export const BOT_TOOL_ACTION = "bot_tool";

/** In a guest's space: the bot they joined through, the agent that is their copy of it, and which sharing of it the copy follows. */
export const GUEST_BOT_KEY = "guest_bot";

/** An app API answer the browser must never keep: what it shows can be deleted, or the sign-in end. */
/** Where the author's space keeps what one of their bots' tools made for one guest: images, so far. */
export const botFolder = (botId: string, guest: string) => `${FILES_ROOT}/bots/${botId}/${guest}`;

/** What what the space shares and receives needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface SharingHost {
	readonly circles: CircleStore;
	readonly profile: () => OwnerProfile | null;
	readonly name: string;
	readonly env: Env;
	readonly assertOpen: () => void;
	readonly closed: () => boolean;
	readonly status: () => OwnerStatus;
	readonly apps: McpBridge;
	readonly store: PimStore;
	readonly circleMemory: (circle: Circle) => MemoryScope[];
	readonly memory: { store: import("../extensions/optmem").OptMemStore; extension: Extension<import("@earendil-works/pi-durable").ToolRegistration>; NapTask: import("@earendil-works/pi-durable").Task<Record<string, never>, { readonly phase: "next"; } | { readonly phase: "summarize"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number; } | { readonly phase: "retry"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number; readonly until: number; }, Record<string, never>, object>; view: (scopes: readonly MemoryScope[]) => string[]; search: (pattern: string, scopes: readonly string[]) => { text: string; isError: boolean; }; startNap: (starter: import("../extensions/optmem").NapStarter) => Promise<TaskId | undefined>; today: () => string; };
	readonly settings: () => Settings;
	readonly artifacts: ArtifactStore;
	readonly hosted: HostedApps;
	readonly artifactData: (key: string, scope: DataScope, op: string, args: Record<string, unknown>) => unknown;
	readonly visits: VisitStore;
	readonly schedule: (when: Date | string | number, callback: string, payload?: unknown, options?: { idempotent?: boolean }) => Promise<unknown>;
	readonly broadcastMessage: (message: ServerMessage) => void;
	readonly publicApproval: (approval: Approval) => PublicApproval;
	readonly deliverNotification: (notification: Notification, options?: { sockets?: boolean; push?: boolean; }) => Promise<void>;
	readonly expireApproval: (payload: { id: string; }) => Promise<void>;
	readonly agents: AgentStore;
	readonly artifactBridge: (key: string, sha: string, op: unknown, args: Record<string, unknown>, shared: (op: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<{ value: unknown; } | { needs: { capability: string; label: string; }; }>;
	readonly grantArtifact: (key: string, sha: string, capability: unknown) => string;
	readonly refreshCustomApps: (now?: boolean) => Promise<void>;
	readonly choice: (provider: string, id: string) => Promise<PiModel>;
	readonly chooseAgentModel: (agent: Agent, model: PiModel | null) => Promise<Agent>;
	readonly installed: (input: AgentInput) => Promise<AgentInput>;
	readonly registry: import("@earendil-works/pi-durable").Registry<import("@earendil-works/pi-durable").ToolRegistration>;
	readonly submitTo: Submit;
	readonly harness: PiHarness;
	readonly chosenModel: () => PiModel;
	readonly appsOf: (agent: Agent) => DirectoryApp[];
	readonly imageServices: () => ImageServices | null;
	readonly agent: (id: string) => Agent;
	readonly waitingCall: (approval: Pick<Approval, "session" | "callId">) => Promise<TaskId | null>;
	readonly resumeTask: (session: string, task: TaskId) => ReturnType<PiHarness["resumeTask"]>;
	readonly files: Files;
	readonly usage: UsageMeter;
}

export class Sharing {
	constructor(private readonly host: SharingHost) {}

	/** A circle, or 404. */
	circle(id: string): Circle {
		const circle = this.host.circles.circle(id);
		if (!circle) throw new HttpError(404, `No circle ${id}`);
		return circle;
	}

	// Circles: people the owner lets message this space, from their own spaces.

	/** This space's owner, as guests know them; null before registration provisioned it. */
	me(): Guest | null {
		const profile = this.host.profile();
		return profile === null ? null : { ownerId: this.host.name, username: profile.username };
	}

	/** Another person's space, to call. */
	pimOf(ownerId: string) {
		return getAgentByName(this.host.env.Pim, ownerId);
	}

	/**
	 * Puts someone in a circle, moving them from any other, and tells their
	 * space it may visit this one. The Worker calls it, having resolved
	 * their username.
	 */
	async addCircleMember(circleId: string, guest: Guest): Promise<Member> {
		this.host.assertOpen();
		this.circle(circleId);
		const me = this.me();
		if (me === null) throw new HttpError(400, "This space has no owner to share it yet");
		if (guest.ownerId === this.host.name) throw new HttpError(400, "You can't add yourself to a circle");
		const known = this.host.circles.member(guest.ownerId);
		if (!known && this.host.circles.members().length >= MAX_MEMBERS) {
			throw new HttpError(429, `Your circles can hold up to ${MAX_MEMBERS} people.`);
		}
		// Told first: someone in a circle whose space doesn't know of it couldn't use it.
		if (!known) await (await this.pimOf(guest.ownerId)).shareReceived(me);
		return this.host.circles.addMember(circleId, guest);
	}

	/** Takes someone out of the circles; their space is told, and their next call is refused either way. */
	async removeCircleMember(ownerId: string): Promise<boolean> {
		this.host.assertOpen();
		if (!this.host.circles.removeMember(ownerId)) return false;
		await this.tellRevoked([ownerId]);
		return true;
	}

	async tellRevoked(ownerIds: readonly string[]): Promise<void> {
		for (const ownerId of ownerIds) {
			try {
				await (await this.pimOf(ownerId)).shareRevoked(this.host.name);
			} catch (error) {
				console.warn(`telling ${ownerId} the share ended failed`, error);
			}
		}
	}

	/** Whether a guest may use this space now, and through which circle; or why not. */
	guestAccess(guest: Guest): { ok: true; circle: Circle; member: Member } | { ok: false; reason: string } {
		const host = this.host.profile()?.username ?? "This person";
		if (this.host.closed()) return { ok: false, reason: `${host}'s account was deleted.` };
		if (this.host.status() !== "active") return { ok: false, reason: `${host}'s account is suspended.` };
		const member = this.host.circles.member(guest.ownerId);
		if (!member) return { ok: false, reason: `${host} doesn't share their space with you.` };
		const circle = this.host.circles.circle(member.circle);
		if (!circle) return { ok: false, reason: `${host} doesn't share their space with you.` };
		if (!circle.enabled) return { ok: false, reason: `${host} has paused sharing their space with their "${circle.name}" circle.` };
		return { ok: true, circle, member };
	}

	/** The connector tools a circle may use now, with the permission each has. */
	#guestTools(circle: string) {
		const servers = new Map(this.host.apps.servers().map((server) => [server.id, server]));
		return this.host.apps.tools().flatMap((tool) => {
			const server = servers.get(tool.serverId);
			if (!server || server.state !== "ready") return [];
			const { permission } = appToolPermission(this.host.store, server, tool, circle);
			return permission === "off" ? [] : [{ server, tool, permission, name: toolName(server.id, tool.name) }];
		});
	}

	/**
	 * What a guest's space may know of this one and use: called by the guest's
	 * own space before each of their turns. Nothing but what the guest's circle
	 * was given.
	 */
	async guestBrief(guest: Guest): Promise<BriefResult> {
		const access = this.guestAccess(guest);
		if (!access.ok) return access;
		const me = this.me()!;
		const scopes = this.host.circleMemory(access.circle);
		const lines = this.host.memory.view(scopes);
		return {
			ok: true,
			brief: {
				host: me,
				circle: access.circle.name,
				timeZone: this.host.settings().timeZone,
				memory:
					scopes.length > 0
						? `<memory>\nWhat ${me.username}'s space remembers, oldest first; later memories override earlier ones:\n${lines.join("\n")}\n</memory>`
						: null,
				tools: this.#guestTools(access.circle.id).map(({ server, tool, permission, name }) => ({
					name,
					appName: server.name,
					description: tool.description ?? tool.annotations?.title ?? tool.name,
					inputSchema: tool.inputSchema,
					readOnly: tool.annotations?.readOnlyHint === true,
					asks: permission === "ask",
				})),
			},
		};
	}

	/** An app shared with a guest's circle, or why they can't see it. */
	#sharedArtifact(guest: Guest, id: string): { ok: true; artifact: ArtifactSummary } | { ok: false; status: number; reason: string } {
		const access = this.guestAccess(guest);
		if (!access.ok) return { ok: false, status: 403, reason: access.reason };
		const artifact = this.host.artifacts.get(id);
		if (!artifact || !this.host.artifacts.circlesOf(id).includes(access.circle.id)) return { ok: false, status: 404, reason: `No app ${id}` };
		return { ok: true, artifact };
	}

	/**
	 * The apps shared with a guest's circle, as their own space asks for
	 * them. Like a tool call, it's checked here every time: who they are,
	 * that their circle is on, and that the app is shared with it.
	 * Only the latest version is shared, and nothing of the chat it was made in.
	 */
	async guestArtifacts(guest: Guest): Promise<{ ok: true; artifacts: Omit<ArtifactSummary, "session">[] } | { ok: false; reason: string }> {
		const access = this.guestAccess(guest);
		if (!access.ok) return access;
		return { ok: true, artifacts: this.host.artifacts.sharedWith(access.circle.id).map(({ session: _session, ...artifact }) => artifact) };
	}

	/** An app shared with a guest, as its latest version. */
	async guestArtifact(
		guest: Guest,
		id: string,
	): Promise<
		{ ok: true; artifact: Omit<ArtifactSummary, "session">; files: ArtifactFile[]; address: string | null } | { ok: false; status: number; reason: string }
	> {
		const found = this.#sharedArtifact(guest, id);
		if (!found.ok) return found;
		const { session: _session, ...artifact } = found.artifact;
		// The guest's space reads the files from R2 itself, so they must be there.
		const stored = await this.host.artifacts.stored(id, artifact.version);
		// An app with a backend isn't shown in the guest's space: it is opened at its own address.
		return { ok: true, artifact, files: [...stored.files], address: artifact.kind === "hosted" ? this.host.hosted.origin(this.host.name, id) : null };
	}

	/** A guest's call on what an app shared with them keeps for everyone using it (`window.pim.shared`). */
	async guestArtifactShared(
		guest: Guest,
		id: string,
		call: { op: string; args: Record<string, unknown> },
	): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string }> {
		const found = this.#sharedArtifact(guest, id);
		if (!found.ok) return found;
		try {
			return { ok: true, value: this.host.artifactData(id, "shared", call.op, call.args) };
		} catch (error) {
			if (error instanceof HttpError) return { ok: false, status: error.status, reason: error.message };
			throw error;
		}
	}

	/**
	 * An app someone shared with this person, as their space answers for
	 * it now: its latest version, which `version` must still be.
	 */
	async othersArtifact(username: string, id: string, version?: string) {
		const share = this.host.visits.byUsername(username);
		const me = this.me();
		if (!share || share.revoked || me === null) throw new HttpError(404, `${username} doesn't share apps with you`);
		const host = await this.pimOf(share.ownerId);
		const found = await host.guestArtifact(me, id);
		if (!found.ok) throw new HttpError(found.status, found.reason);
		if (version !== undefined && Number(version) !== found.artifact.version) {
			throw new HttpError(404, `Only the latest version, ${found.artifact.version}, is shared`);
		}
		const files = found.files as ArtifactFile[];
		const load = () => readFiles(this.host.env.ARTIFACTS, share.ownerId, files);
		return { share, me, host, artifact: found.artifact, address: found.address, files, load, key: `${share.ownerId}/${found.artifact.id}` };
	}

	/**
	 * A guest's tool call, from their own space: the hard boundary. The guest's
	 * circle and the tool's permission are checked here at every call, as
	 * they are now, whatever the guest's space was told before. `on` runs it,
	 * `ask` files an approval for the owner and answers at once (the decision
	 * goes to the guest's conversation later), anything else is refused.
	 */
	async guestCall(
		guest: Guest,
		call: { tool: string; args: Record<string, unknown>; session: string; callId: string },
	): Promise<GuestCallResult> {
		const access = this.guestAccess(guest);
		if (!access.ok) return { text: access.reason, isError: true };
		const { circle } = access;
		const host = this.me()!.username;
		const log = (outcome: "ran" | "asked" | "refused", summary: string) =>
			this.host.circles.logActivity({ username: guest.username, circle: circle.id, tool: call.tool, outcome, summary });
		if (!this.host.circles.countCall(guest.ownerId)) {
			return { text: `${guest.username} has used today's ${GUEST_CALLS_PER_DAY} calls to ${host}'s space. It resets at midnight UTC.`, isError: true };
		}

		if (call.tool === "recall") {
			const scopes = this.host.circleMemory(circle).map((scope) => scope.key);
			if (scopes.length === 0) {
				log("refused", "recall");
				return { text: `${host} doesn't let you read their space's memory.`, isError: true };
			}
			const pattern = typeof call.args.pattern === "string" ? call.args.pattern : "";
			log("ran", `recall ${JSON.stringify(pattern)}`);
			return this.host.memory.search(pattern, scopes);
		}

		const found = this.#guestTools(circle.id).find((candidate) => candidate.name === call.tool);
		const summary = found ? summarizeCall(found.server.name, found.tool.name, call.args) : call.tool;
		if (!found) {
			log("refused", summary);
			return { text: `${host} doesn't let you use ${call.tool}.`, isError: true };
		}
		if (found.permission === "on") {
			log("ran", summary);
			const result = await this.host.apps.call(found.server.id, found.tool.name, call.args);
			return { text: toText(result), ...(result.isError ? { isError: true } : {}) };
		}
		return this.#askForGuest(guest, circle, found, call, summary, () => log("asked", summary));
	}

	/**
	 * Files an approval for a guest's call. The owner is notified; it is denied
	 * if they don't answer within a day, never approved by a timeout. The same
	 * call again (a replay in the guest's space) finds the request it filed.
	 */
	async #askForGuest(
		guest: Guest,
		circle: Circle,
		found: { server: McpServerInfo; tool: McpToolInfo; name: string },
		call: { args: Record<string, unknown>; session: string; callId: string },
		summary: string,
		logged: () => void,
	): Promise<GuestCallResult> {
		const host = this.me()!.username;
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${guest.ownerId}\n${call.session}\n${call.callId}`));
		const id = `g-${[...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
		const known = this.host.store.approval(id);
		if (known && known.status !== "pending") return { text: this.guestOutcome(known) };
		const now = Date.now();
		const approval = this.host.store.requestApproval({
			id,
			session: call.session,
			callId: call.callId,
			action: "mcp_call",
			tool: found.name,
			args: { server: found.server.id, tool: found.tool.name, arguments: call.args },
			summary,
			createdAt: now,
			expiresAt: now + GUEST_APPROVAL_MS,
			onTimeout: "deny",
			requestedBy: { ownerId: guest.ownerId, username: guest.username, circle: circle.id, circleName: circle.name },
		});
		if (!known) {
			logged();
			await this.host.schedule(new Date(approval.expiresAt!), APPROVAL_EXPIRY_CALLBACK, { id });
			this.host.broadcastMessage({ type: "approval", approval: this.host.publicApproval(approval) });
			const notification = this.host.store.addNotification({
				id: crypto.randomUUID(),
				session: null,
				title: `${guest.username} asked your agent`,
				body: `${guest.username} (${circle.name}) wants: ${summary}`,
			});
			// Open apps show the request itself, from the approval just broadcast; this reaches the others.
			await this.host.deliverNotification(notification, { sockets: false });
		}
		return {
			text: `${host} asks before this runs. The request is with ${host} now (approval ${id}); their answer will arrive in this conversation as a message starting with "[${host}'s answer". Tell ${guest.username} it was asked, and don't call it again.`,
		};
	}

	/** A guest approval's outcome, as the guest's space reads it. */
	guestOutcome(approval: Approval): string {
		const host = this.me()?.username ?? "The owner";
		const note = approval.note ? `\n${host}'s note: ${approval.note}` : "";
		const head = `[${host}'s answer to approval ${approval.id}]`;
		if (approval.status === "denied") {
			const why = approval.decidedBy === "timeout" ? `${host} didn't answer within a day, so it was not done` : `${host} said no`;
			return `${head} ${why}: ${approval.summary}${note}`;
		}
		return `${head} ${host} approved: ${approval.summary}${note}\nResult:\n${approval.result ?? ""}`;
	}

	/** Guests' expiries scheduled under their old name. */
	async expireGuestApproval(payload: { id: string }): Promise<void> {
		await this.host.expireApproval(payload);
	}

	/** The id of this space's majordomo, which host operations (./hostops.ts) check their caller against; null in an erased or guest's space. */
	async majordomoId(): Promise<string | null> {
		if (this.host.closed() || this.guestBot() !== null) return null;
		return this.host.agents.majordomo().id;
	}

	/**
	 * One of the owner's agents, with its uploaded icon, for the Worker to
	 * publish to the gallery: with its contacts, and theirs, which come with
	 * it, each by name and with its own uploaded icon.
	 */
	async agentToPublish(id: string): Promise<PublishedAgent | null> {
		this.host.assertOpen();
		const agent = this.host.agents.get(id);
		if (!agent) return null;
		const byId = new Map(this.host.agents.list().map((other) => [other.id, other]));
		const names = (contacts: readonly string[]) => contacts.flatMap((contact) => byId.get(contact)?.role ?? []);
		const bundle: Agent[] = [];
		const seen = new Set([agent.id]);
		for (const queue = [...agent.contacts]; queue.length > 0; ) {
			const other = byId.get(queue.shift()!);
			if (!other || seen.has(other.id)) continue;
			seen.add(other.id);
			bundle.push(other);
			queue.push(...other.contacts);
		}
		const { name, role, description, instructions, apps, symbol, color } = agent;
		return {
			id,
			name,
			role,
			description,
			instructions,
			apps,
			symbol,
			color,
			contacts: names(agent.contacts),
			bundle: bundle.map((other) => ({
				name: other.name,
				role: other.role,
				description: other.description,
				instructions: other.instructions,
				apps: other.apps,
				symbol: other.symbol,
				color: other.color,
				contacts: names(other.contacts),
				image: this.host.agents.icon(other.id) ?? null,
			})),
			image: this.host.agents.icon(id) ?? null,
		};
	}

	/** Records which template an agent is published as; null once unpublished. */
	async setAgentPublished(id: string, template: string | null): Promise<void> {
		this.host.assertOpen();
		if (this.host.agents.get(id)) this.host.agents.setPublished(id, template);
	}

	/** The latest version of one of the owner's apps, for the Worker to publish to the gallery. */
	async artifactToPublish(id: string): Promise<ArtifactToPublish | null> {
		this.host.assertOpen();
		const artifact = ARTIFACT_ID.test(id) ? this.host.artifacts.get(id) : undefined;
		if (!artifact) return null;
		// Viewers' spaces read the files from R2 under this owner's prefix, so they must be there.
		const latest = await this.host.artifacts.stored(artifact.id, artifact.version);
		return { id: artifact.id, version: latest.version, title: artifact.title, kind: artifact.kind, files: [...latest.files], sha256: latest.sha256, size: latest.size };
	}

	/**
	 * A bridge call from an app someone published, which the owner opened
	 * from the gallery. Like an app shared with them, it keeps what it
	 * keeps for them here (under `gallery/<id>`), and uses their model and
	 * tools once they allow its version. It keeps nothing for everyone.
	 */
	async publishedArtifactCall(
		published: { id: string; sha256: string },
		call: { op: unknown; args: Record<string, unknown> },
	): Promise<{ ok: true; answer: unknown } | { ok: false; status: number; reason: string }> {
		try {
			const shared = async () => {
				throw new HttpError(400, "A published app keeps nothing for everyone: pim.shared works only in apps shared with circles.");
			};
			return { ok: true, answer: await this.host.artifactBridge(`gallery/${published.id}`, published.sha256, call.op, call.args, shared) };
		} catch (error) {
			if (error instanceof HttpError) return { ok: false, status: error.status, reason: error.message };
			throw error;
		}
	}

	/** Lets the owner's model or a tool be used by a published app's version they opened. */
	async publishedArtifactGrant(
		published: { id: string; sha256: string },
		capability: unknown,
	): Promise<{ ok: true; granted: string } | { ok: false; status: number; reason: string }> {
		try {
			return { ok: true, granted: this.host.grantArtifact(`gallery/${published.id}`, published.sha256, capability) };
		} catch (error) {
			if (error instanceof HttpError) return { ok: false, status: error.status, reason: error.message };
			throw error;
		}
	}

	/** Makes a published app one of the owner's: a new app with copies of its files, theirs to change. */
	async adoptArtifact(published: { title: string; kind: ArtifactKind; owner: string; files: readonly ArtifactFile[] }): Promise<ArtifactSummary> {
		this.host.assertOpen();
		const loaded = await readFiles(this.host.env.ARTIFACTS, published.owner, published.files);
		const entry = ENTRY_FILES[published.kind];
		const files = Object.fromEntries([...loaded].filter(([path]) => path !== entry).map(([path, file]) => [path, file.bytes]));
		const id = crypto.randomUUID();
		await this.host.artifacts.create({ id, title: published.title, kind: published.kind, content: loaded.get(entry)!.bytes, files, session: null });
		return this.host.artifacts.get(id)!;
	}

	/** Makes a published template one of the owner's agents: a copy of it, theirs to change, with copies of the agents that come with it. */
	async adoptTemplate(template: Omit<PublishedAgent, "image"> & { author: string; image: AgentIcon | null }): Promise<Agent> {
		this.host.assertOpen();
		return this.#adopt(template, { template: template.id, author: template.author });
	}

	/** At registration: gives the person a copy of the agent the admin chose for everyone, its icon and the agents that come with it too, besides their majordomo. */
	async adoptEveryonesAgent(agent: Omit<PublishedAgent, "id" | "image"> & { author: string; image: AgentIcon | null }): Promise<Agent> {
		this.host.assertOpen();
		return this.#adopt(agent, { template: "default", author: agent.author });
	}

	/**
	 * At registration of a guest: their copy of the bot they joined through,
	 * on the bot's model, with the agents that come with it, and the bot's
	 * daily messages and tool calls as the space's limits on runs and tool
	 * calls. Their space never gets the agent everyone starts with.
	 */
	async adoptBot(bot: Omit<Bot, "icon" | "bundle"> & Pick<PublishedAgent, "bundle"> & { image: AgentIcon | null }): Promise<Agent> {
		this.host.assertOpen();
		// Its connectors' tools are the author's to share, as the bot's tools: the copy connects none of its own.
		const agent = await this.#adopt({ ...bot, apps: [] }, { template: bot.id, author: bot.author });
		this.host.store.setMeta(
			GUEST_BOT_KEY,
			JSON.stringify({ bot: bot.id, agent: agent.id, sharedAt: bot.sharedAt, owner: bot.ownerId, tools: bot.tools } satisfies GuestBot),
		);
		this.#guestLimit(bot);
		this.#botToolsChanged();
		return this.#guestModel(agent, bot.model);
	}

	/**
	 * A model the admin may give a bot's guests: one this Pim offers everyone,
	 * the deployment's or a provider the admin added for everyone, never the
	 * admin's own ChatGPT plan or providers.
	 */
	async botModel(provider: string, id: string): Promise<BotModel> {
		this.host.assertOpen();
		if (provider === CHATGPT_PROVIDER || provider.startsWith(OWN_PROVIDER)) {
			throw new HttpError(400, "Guests can't use your ChatGPT plan or your own providers: choose a model this Pim offers everyone.");
		}
		await this.host.refreshCustomApps(true);
		const model = await this.host.choice(provider, id);
		return { provider: model.provider, id: model.id };
	}

	/** Puts a guest's copy of their bot on the bot's model; one this space can't use, such as a provider the admin removed since, leaves it on the default. */
	async #guestModel(agent: Agent, model: BotModel | null): Promise<Agent> {
		const chosen = model ? await this.host.choice(model.provider, model.id).catch(() => null) : null;
		return this.host.chooseAgentModel(agent, chosen);
	}

	/** In a guest's space, the bot they joined through and their copy of it; null in anyone else's. */
	guestBot(): GuestBot | null {
		const json = this.host.store.meta(GUEST_BOT_KEY);
		return json === undefined ? null : (JSON.parse(json) as GuestBot);
	}

	/**
	 * Brings a guest's copy of their bot up to what its author shared last:
	 * its name, description, instructions, connectors, look and model, and the daily
	 * messages and tool calls it allows. The agents that came with it stay as they came.
	 * Null when its link was turned off: the guest can read their chats, and
	 * start nothing more.
	 */
	async syncBot(bot: (Omit<Bot, "icon" | "bundle"> & { image: AgentIcon | null }) | null): Promise<void> {
		this.host.assertOpen();
		const guest = this.guestBot();
		if (!guest) return;
		if (bot === null) return this.#guestLimit({ dailyMessages: 0, dailyToolCalls: 0 });
		if (guest.bot !== bot.id || (guest.sharedAt === bot.sharedAt && guest.owner !== undefined)) return;
		const copy = this.host.agents.get(guest.agent);
		if (copy) {
			const { name, description, instructions, symbol, color } = bot;
			const input = await this.host.installed(agentInput({ name, description, instructions, apps: [], symbol, color }, copy));
			// It keeps the role it was given, which may differ from the bot's beside the agents that came with it.
			this.host.agents.update(copy.id, { ...input, role: copy.role });
			if (bot.image) this.host.agents.setIcon(copy.id, bot.image.type, bot.image.data);
			else this.host.agents.removeIcon(copy.id);
			await this.#guestModel(this.host.agents.get(copy.id)!, bot.model);
		}
		this.host.store.setMeta(GUEST_BOT_KEY, JSON.stringify({ ...guest, sharedAt: bot.sharedAt, owner: bot.ownerId, tools: bot.tools } satisfies GuestBot));
		this.#guestLimit(bot);
		this.#botToolsChanged();
		this.host.broadcastMessage({ type: "sessions" });
	}

	/** A guest's runs a day are the messages their bot allows, and their tool calls the calls it allows; null leaves the deployment's limit. */
	#guestLimit({ dailyMessages, dailyToolCalls }: Pick<Bot, "dailyMessages" | "dailyToolCalls">): void {
		const own = JSON.parse(this.host.store.meta(LIMITS_KEY) ?? "{}") as Partial<Limits>;
		const { dailyRuns: _dailyRuns, dailyToolCalls: _dailyToolCalls, ...rest } = own;
		this.host.store.setMeta(
			LIMITS_KEY,
			JSON.stringify({ ...rest, ...(dailyMessages === null ? {} : { dailyRuns: dailyMessages }), ...(dailyToolCalls === null ? {} : { dailyToolCalls }) }),
		);
	}

	/**
	 * Copies an agent from the gallery into the owner's agents, and the agents
	 * that come with it, each with its uploaded icon and a contact of the
	 * copies that had it. A copy
	 * whose role one of the owner's agents already has gets a role of its own,
	 * so that agents hand it tasks by its role, and one whose name is taken gets
	 * another name.
	 */
	async #adopt(copy: Omit<PublishedAgent, "id" | "image"> & { image: AgentIcon | null }, source: NonNullable<Agent["source"]>): Promise<Agent> {
		const all = [copy, ...copy.bundle];
		if (all.length > 1 && this.host.agents.list().length + all.length > MAX_AGENTS) {
			throw new HttpError(429, `You can have up to ${MAX_AGENTS} agents, and ${copy.name} comes with ${all.length - 1} more.`);
		}
		const inputs: AgentInput[] = [];
		for (const { name, role, description, instructions, apps, symbol, color } of all) {
			inputs.push(await this.host.installed(agentInput({ name, role, description, instructions, apps, symbol, color })));
		}
		const taken = new Set(this.host.agents.list().map((agent) => agent.role.toLowerCase()));
		const names = new Set(this.host.agents.list().map((agent) => agent.name.toLowerCase()));
		const made = inputs.map((input, index) => {
			const role = freeName(input.role!, copy.name, taken);
			taken.add(role.toLowerCase());
			const name = freeName(input.name, index === 0 ? role : copy.name, names);
			names.add(name.toLowerCase());
			return this.host.agents.create({ ...input, name, role }, source, index === 0 ? source.template : `${source.template}/${all[index]!.role.toLowerCase()}`);
		});
		const copyOf = new Map(all.map((agent, index) => [agent.role.toLowerCase(), made[index]!]));
		for (const [index, agent] of all.entries()) {
			const contacts = agent.contacts.flatMap((role) => copyOf.get(role.toLowerCase())?.id ?? []).filter((id) => id !== made[index]!.id);
			if (contacts.length > 0) this.host.agents.update(made[index]!.id, agentInput({ contacts }, made[index]));
		}
		for (const [index, agent] of all.entries()) if (agent.image) this.host.agents.setIcon(made[index]!.id, agent.image.type, agent.image.data);
		return this.host.agents.get(made[0]!.id)!;
	}

	// Visits: spaces shared with this one's owner, and their conversations with them.

	/** From a host's space: its owner put this space's owner in a circle. */
	async shareReceived(host: Guest): Promise<void> {
		this.host.assertOpen();
		if (this.host.status() !== "active") throw new Error("This space is suspended");
		if (!this.host.visits.shared(host)) return;
		const notification = this.host.store.addNotification({
			id: crypto.randomUUID(),
			session: null,
			title: `${host.username} shared their space with you`,
			body: `You can message ${host.username}'s space now. Find it under Shared with you.`,
		});
		await this.host.deliverNotification(notification);
		this.host.broadcastMessage({ type: "visits" });
	}

	/** From a host's space: this space's owner is no longer in its circles. */
	async shareRevoked(hostOwnerId: string): Promise<void> {
		if (this.host.closed()) return;
		this.host.visits.revoked(hostOwnerId);
		this.host.registry.uninstall({ name: visitExtensionName(hostOwnerId) });
		this.host.broadcastMessage({ type: "visits" });
	}

	/** From a host's space: the owner decided on something this space's owner asked for; it continues the visit. */
	async visitAnswer(hostOwnerId: string, session: string, message: string, operationId: string): Promise<void> {
		this.host.assertOpen();
		const share = this.host.visits.share(hostOwnerId);
		// Only into the visit with that host: a host can't write into any other conversation.
		if (!share || share.session !== session) return;
		await this.host.submitTo(session, message, { operationId }, "pim");
	}

	/** A visit's conversation, started on first use. */
	async startVisit(username: string): Promise<string> {
		const share = this.host.visits.byUsername(username);
		if (!share) throw new HttpError(404, `${username} doesn't share their space with you`);
		if (share.revoked) throw new HttpError(403, `${username} no longer shares their space with you`);
		if (share.session !== null && !this.host.store.deletedSessions().has(share.session)) return share.session;
		const { id } = await this.host.harness.sessions.create();
		await this.host.harness.session(id).setModel(this.host.chosenModel());
		this.host.store.touchSession(id, `${username}'s space`);
		this.host.visits.setSession(share.ownerId, id);
		await this.refreshVisit(share.ownerId);
		return id;
	}

	/**
	 * Asks the host's space what this visit may use now, and gives the visit's
	 * conversation exactly that: its own extension, and nothing of the
	 * owner's. Refused, the visit can't go on.
	 */
	async refreshVisit(hostOwnerId: string): Promise<void> {
		const share = this.host.visits.share(hostOwnerId);
		const me = this.me();
		if (!share || share.session === null || me === null) throw new HttpError(404, "No such visit");
		if (share.revoked) throw new HttpError(403, `${share.username} no longer shares their space with you`);
		const result = (await (await this.pimOf(hostOwnerId)).guestBrief(me)) as BriefResult;
		if (!result.ok) {
			this.host.visits.setBrief(hostOwnerId, null);
			throw new HttpError(403, result.reason);
		}
		this.host.visits.setBrief(hostOwnerId, result.brief);
		const extension = this.installVisit(result.brief, me.username);
		const conversation = await this.host.harness.conversation(share.session);
		// The visitor reads what the visit sends them, as in any of their conversations.
		const snapshot = this.host.registry.snapshot();
		const messaging = snapshot.extension(MESSAGING_EXTENSION)!;
		await conversation.configure({ extensions: [extension, messaging, snapshot.extension(TELEMETRY_EXTENSION)!] }, BACKGROUND_CONTEXT);
	}

	/** Installs (or replaces) a visit's extension; its tools call the host's space. */
	installVisit(brief: GuestBrief, visitor: string) {
		const host = brief.host.ownerId;
		const extension = visitExtension(brief, visitor, async (tool, args, session, callId) => {
			this.host.assertOpen();
			const me = this.me();
			if (me === null) return { text: "This space can't visit others.", isError: true };
			return (await this.pimOf(host)).guestCall(me, { tool, args, session, callId });
		});
		this.host.registry.install(extension);
		return extension;
	}

	// Bots' shared tools: the author's side runs them (`runBotTool`), a guest's side calls them.

	/**
	 * The tools of one of the owner's agents they can share with a bot's
	 * guests, which then run here, as the owner: the tools of the agent's
	 * connected apps, and `generate_image` while this space makes images.
	 * Never the computer's own tools, which would open it to anyone.
	 */
	shareableTools(agent: Agent): BotTool[] {
		const servers = this.host.apps.servers();
		const tools = this.host.apps.tools();
		const shared: BotTool[] = this.host.appsOf(agent).flatMap((app) => {
			const server = serverFor(servers, app);
			if (server?.state !== "ready") return [];
			return tools
				.filter((tool) => tool.serverId === server.id)
				.map((tool) => ({
					name: toolName(server.id, tool.name),
					appName: server.name,
					description: `[${server.name}] ${tool.description ?? tool.annotations?.title ?? tool.name}`,
					parameters: JSON.stringify(tool.inputSchema),
					destructive: tool.annotations?.destructiveHint === true,
				}));
		});
		if (this.host.imageServices()) {
			shared.push({ name: GENERATE_IMAGE, appName: null, description: SHARED_IMAGE_TOOL.description, parameters: JSON.stringify(SHARED_IMAGE_TOOL.parameters), destructive: false });
		}
		return shared;
	}

	/** The tools named, as one of the owner's agents shares them now, and the names it can't share. */
	async botTools(agentId: string, names: readonly string[]): Promise<{ tools: BotTool[]; missing: string[] }> {
		this.host.assertOpen();
		await this.host.refreshCustomApps();
		const shareable = this.shareableTools(this.host.agent(agentId));
		const wanted = [...new Set(names)];
		return {
			tools: shareable.filter((tool) => wanted.includes(tool.name)),
			missing: wanted.filter((name) => !shareable.some((tool) => tool.name === name)),
		};
	}

	/**
	 * Runs a tool for a guest of one of the owner's bots, called by the
	 * guest's space: only one the bot shares now, as the owner, with their
	 * connections. An image is kept in the owner's files, in a folder of the
	 * guest's under `bots/`, which their chat reads it from (`botImage`).
	 * A tool the owner approves first runs only once they approve: the guest's
	 * `call` files an approval and gets null, and, woken by the decision, asks
	 * again and gets the outcome (`#askForBotGuest`).
	 */
	async runBotTool(botId: string, guest: string, name: string, args: Record<string, unknown>, call: BotToolCall | null = null): Promise<BotToolResult | null> {
		this.host.assertOpen();
		const bot = await this.host.env.Gallery.getByName("gallery").bot(botId);
		if (!bot || bot.ownerId !== this.host.name) return botToolError("This bot's link was turned off.");
		const tool = bot.tools.find((candidate) => candidate.name === name);
		if (!tool) return botToolError(`${bot.name} doesn't share ${name}.`);
		if (!tool.ask) return this.#runBotTool(botId, guest, name, args);
		// A guest's space that hasn't heard yet can't wait for a decision: it hears before their next message.
		if (!call) return botToolError(`${this.me()?.username ?? "Its author"} now approves each call to ${name} first. Tell the person to ask again in a new message.`);
		return this.#askForBotGuest(bot, guest, tool, args, call);
	}

	/** Runs a tool a bot shares, for one of its guests, checked already. */
	async #runBotTool(botId: string, guest: string, name: string, args: Record<string, unknown>): Promise<BotToolResult> {
		console.log(JSON.stringify({ event: "pim.bot_tool", bot: botId, guest, tool: name }));
		if (name === GENERATE_IMAGE) {
			const services = this.host.imageServices();
			if (!services) return botToolError("Images can't be made right now.");
			const { prompt, shape } = args as { prompt?: unknown; shape?: unknown };
			if (typeof prompt !== "string" || prompt === "") return botToolError("prompt is required.");
			const shapes = ["square", "landscape", "portrait"] as const;
			const target = `${botFolder(botId, guest)}/${new Date().toISOString().replace(/[:.]/g, "-")}`;
			return (await drawImage(
				services,
				prompt,
				shapes.find((candidate) => candidate === shape),
				target,
				undefined,
				"The person sees it in the chat now.",
			)) as BotToolResult;
		}
		const servers = this.host.apps.servers();
		for (const tool of this.host.apps.tools()) {
			const server = servers.find((candidate) => candidate.id === tool.serverId);
			if (!server || toolName(server.id, tool.name) !== name) continue;
			if (server.state !== "ready") break;
			const result = await this.host.apps.call(server.id, tool.name, args);
			return { content: toContent(result), ...(result.isError ? { isError: true } : {}) };
		}
		return botToolError(`${name} isn't available right now.`);
	}

	/**
	 * A bot's guest's call to a tool the owner approves first. The first time,
	 * it files an approval, which the owner is told about and which is denied
	 * if they don't answer within a day, and answers null: the guest's call
	 * waits. Once decided (see `decideApproval`), the call, woken, asks again:
	 * approved, the tool runs then, once, and later asks get what it answered.
	 */
	async #askForBotGuest(bot: Bot, guest: string, tool: BotTool, args: Record<string, unknown>, call: BotToolCall): Promise<BotToolResult | null> {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${bot.id}\n${guest}\n${call.session}\n${call.callId}`));
		const id = `b-${[...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
		const known = this.host.store.approval(id);
		if (known?.status === "denied") {
			const host = this.me()?.username ?? "Its author";
			const why = known.decidedBy === "timeout" ? `${host} didn't answer within a day` : `${host} said no`;
			return botToolError(`${why}, so ${tool.name} didn't run.${known.note ? ` ${host}'s note: ${known.note}` : ""}`);
		}
		if (known?.status === "approved") {
			if (known.result !== null) return known.result === "" ? botToolError(`${tool.name} was approved and started, but its result was lost.`) : { content: [{ type: "text", text: known.result }] };
			// Marked first, so it never runs twice for one approval.
			this.host.store.recordApprovalResult(id, "");
			const result = await this.#runBotTool(bot.id, guest, tool.name, args);
			this.host.store.recordApprovalResult(id, result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"));
			return result;
		}
		if (known) return null;
		const now = Date.now();
		const summary = summarizeCall(tool.appName ?? "Pim", tool.name, args);
		const approval = this.host.store.requestApproval({
			id,
			session: call.session,
			callId: call.callId,
			action: BOT_TOOL_ACTION,
			tool: null,
			args: { bot: bot.id, tool: tool.name, arguments: args },
			summary,
			createdAt: now,
			expiresAt: now + GUEST_APPROVAL_MS,
			onTimeout: "deny",
			requestedBy: { ownerId: guest, username: call.username, circle: "", circleName: bot.name, bot: bot.id },
		});
		await this.host.schedule(new Date(approval.expiresAt!), APPROVAL_EXPIRY_CALLBACK, { id });
		this.host.broadcastMessage({ type: "approval", approval: this.host.publicApproval(approval) });
		const notification = this.host.store.addNotification({
			id: crypto.randomUUID(),
			session: null,
			title: `${call.username} asked ${bot.name}`,
			body: `${call.username} (${bot.name}) wants: ${summary}`,
		});
		await this.host.deliverNotification(notification, { sockets: false });
		return null;
	}

	/** Whether the bot's guest's call that filed `approval` still waits for it, in their space. */
	async approvalWaitsOnBot(approval: Approval): Promise<boolean> {
		return (await this.pimOf(approval.requestedBy!.ownerId)).botCallWaits(this.host.name, approval.session, approval.callId ?? "").catch(() => false);
	}

	/** In a guest's space: whether a call to one of their bot's tools still waits for the bot's author (`owner`) to decide. */
	async botCallWaits(owner: string, session: string, callId: string): Promise<boolean> {
		this.host.assertOpen();
		return this.guestBot()?.owner === owner && (await this.host.waitingCall({ session, callId })) !== null;
	}

	/** In a guest's space: the bot's author decided about a call that waits for them. It runs again, and finds their decision. */
	async botToolDecided(owner: string, session: string, callId: string): Promise<void> {
		this.host.assertOpen();
		if (this.guestBot()?.owner !== owner) return;
		const call = await this.host.waitingCall({ session, callId });
		if (call) await this.host.resumeTask(session, call);
	}

	/**
	 * An image a guest of one of the owner's bots had made, from the guest's
	 * own folder only, for their chat to show. Null for anything else, or
	 * while the owner's computer is offline.
	 */
	async botImage(botId: string, guest: string, path: string): Promise<{ name: string; type: string; bytes: Uint8Array } | null> {
		this.host.assertOpen();
		const file = filesPath(path);
		if (file === null || !file.startsWith(`${botFolder(botId, guest)}/`)) return null;
		try {
			const found = await this.host.files.read(file);
			return { name: found.name, type: found.type, bytes: new Uint8Array(await new Response(found.body).arrayBuffer()) };
		} catch {
			return null;
		}
	}

	/**
	 * In a guest's space: stand-ins for the tools their bot shares, each run by
	 * its author's space. Installed in every space, with no tools but in a
	 * guest's, so that chats begun before a change see it.
	 */
	installBotTools(): void {
		const guest = this.guestBot();
		const owner = guest?.owner;
		this.host.registry.install(
			botToolsExtension(
				guest && owner !== undefined ? (guest.tools ?? []) : [],
				() => {
					this.host.assertOpen();
					return this.host.usage.reserveToolCall();
				},
				async (name, args, call) => (await this.pimOf(owner!)).runBotTool(guest!.bot, this.host.name, name, args, call),
				this.me()?.username ?? this.host.name,
			),
		);
	}

	/** The bot's tools changed: the guest's chats get the new set from their next request, once the harness is set up. */
	#botToolsChanged(): void {
		if (this.host.registry.snapshot().extension("pim.approvals")) this.installBotTools();
	}

	describeCircles() {
		const members = this.host.circles.members();
		return this.host.circles.circles().map((circle) => ({
			...circle,
			members: members.filter((member) => member.circle === circle.id).map(({ ownerId, username, addedAt }) => ({ ownerId, username, addedAt })),
		}));
	}
}
