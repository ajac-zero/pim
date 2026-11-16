/**
 * The space's API: every route `/api` serves once the Worker has resolved whose space it is, grouped by what they are about. Each builder
 * answers over `SpaceRouteHost`, which `Pim` implements with its own members, so this file never imports `Pim`.
 */
import { activityOf } from "../activity";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { type ConversationId, type ConversationInit, type EntryId, type Extension, type TaskId, UsageDoc } from "@earendil-works/pi-durable";
import { type PiModel, PiHarness, type PiOperationResult, ROOT_SESSION } from "agents/harness/pi";
import { ENTRY_FILES, type ArtifactFile, type ArtifactKind, type ArtifactSummary, ArtifactStore, artifactHeaders, checkFiles, checkPath, checkTitle, type DataScope, downloadName, fileType, isTextType, framePage, textOf as fileText } from "../artifacts";
import { digestHex } from "../auth/store";
import { Email } from "../email";
import { builtinProviders, type CustomProvider, providerInfo, type ProviderInput } from "../providers";
import { ImageStore, userInput } from "../images";
import { type Circle, CircleStore, type Guest, MAX_CIRCLE_NAME, MAX_CIRCLES } from "../circles";
import { CHATGPT_PROVIDER, ChatGPT } from "../chatgpt";
import { CodexImages } from "../codex-images";
import { AppCatalog } from "../extensions/app-catalog";
import { SkillStore } from "../skills";
import pimConfig from "../../pim.config";
import { BUILTIN_APPS } from "../builtin-apps";
import type { BotTool } from "../extensions/bot-tools";
import { appDirectory, type DirectoryApp } from "../extensions/app-directory";
import { NativeApps } from "../extensions/native-apps";
import { secretsOf, type PimConfig, PimExtensions } from "../extensions/define";
import { agentAudience, MCP_APPROVALS, type McpApproval, type McpBridge } from "../extensions/mcp";
import type { MemoryAccess, MemoryScope } from "../extensions/optmem";
import { blockName, halves, parseBlock } from "../extensions/optmem/cover";
import { byteLength, ENTRY_BYTES, EVERYONE_SCOPE, entryLine, MAX_NAMED_SCOPES, MAX_SCOPE_NAME, PRIVATE_SCOPE } from "../extensions/optmem/store";
import { ADD_CUSTOM_CONNECTOR, requestedIcon, UPDATE_AGENT } from "../extensions/agents";
import { cancelTask, type ScheduleHost, scheduledTriggers } from "../extensions/schedule";
import { HostedApps } from "../hosted";
import { Computer, type ComputerDisplay } from "../computer";
import { byteRange, etagOf, etags, FILES_ROOT, Files, fileHeaders, MAX_UPLOAD_BYTES } from "../files";
import { NoteStore } from "../notes";
import { PimBrowser } from "../browser";
import type { DeploymentSettings } from "../deployment";
import type { Turn } from "../diagnostics";
import { HttpError, readJson, type Route } from "@pim/shared/http";
import type { PublicApproval, ServerMessage, ToolInfo } from "../protocol";
import { type PushSubscription, validSubscription, type VapidKeys } from "../push";
import type { ApprovalPolicy, Settings } from "../settings";
import { type Approval, type GoalStatus, OWNER, PimStore, TOOL_PERMISSIONS, type ToolPermission } from "../store";
import { type Agent, type AgentModel, AgentStore, agentInput, checkContacts } from "../agents";
import { ChatLinkStore, LINK_ID, MAX_SHARED_BYTES, type SharedChat, sharedMessages } from "../chat-links";
import { type RoomMode, RoomStore, type Seat } from "../rooms";
import { PERSON, TriggerApi } from "@pim/triggers/api";
import type { ConnectorEventSource, TriggerDestination } from "@pim/triggers/spec";
import { type Task, TaskStore } from "../tasks";
import { introduction, majordomoPreferences, majordomoStart, withPreferences } from "../majordomo";
import { forkPoint, projectEntries } from "@pim/shared/transcript";
import { checkUiState, type UiProgram } from "@pim/ui-lang";
import { conversationText, IMPROVE_PROMPT, NAME_CHAT, MAX_SUGGESTIONS, SUMMARIZE_CHAT, type UtilityTask } from "../utility";
import type { ComputeQuota } from "../compute";
import { type Limits, sessionCost } from "../usage";
import { VisitStore } from "../visits";
import type { Submit } from "./conversations";
import type { Pim } from "../pim";
import { SIGNED_IN_HEADER, APPS_CALLBACK_PATH, MCP_SERVER_PATH, signInResultPage, type MemoryScopeInfo, type AutoApproval, type ToolPermissionInfo, type GuestBot, UTILITY_MODEL_KEY, SUGGESTIONS_KEY, FORK_KEY, PERSON_NAME_KEY, OWN_PROVIDERS_KEY, VERSION, within, clipTitle, sameModel, describeModel, errorMessage } from "./shared";

/** How long a chat goes without activity before it is archived: listed apart, not deleted. */
export const ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** A circle's name as given: trimmed, not empty, not long. */
export function circleName(name: unknown): string {
	if (typeof name !== "string" || name.trim() === "") throw new HttpError(400, "name must be a non-empty string");
	if (name.trim().length > MAX_CIRCLE_NAME) throw new HttpError(400, `name must be at most ${MAX_CIRCLE_NAME} characters`);
	return name.trim();
}

/** A named memory scope's name as given: trimmed, not empty, not long. */
export function scopeName(name: unknown): string {
	if (typeof name !== "string" || name.trim() === "") throw new HttpError(400, "name must be a non-empty string");
	if (name.trim().length > MAX_SCOPE_NAME) throw new HttpError(400, `name must be at most ${MAX_SCOPE_NAME} characters`);
	return name.trim();
}

export function noStore(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store, private", "x-content-type-options": "nosniff" } });
}

export const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "done", "abandoned"];

/** What the routes of the space's API needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface SpaceRouteHost {
	readonly chosenModel: () => PiModel;
	readonly settings: () => Settings;
	readonly store: PimStore;
	readonly tools: () => ToolInfo[];
	readonly mcpServer: (request: Request) => Promise<Response>;
	readonly hiddenSessions: () => Set<string>;
	readonly heldSessions: () => Promise<Set<string>>;
	readonly heldErrors: (held: ReadonlySet<string>) => Promise<Map<string, string>>;
	readonly harness: PiHarness;
	readonly visits: VisitStore;
	readonly sessionModelInfo: (session: string) => { model: ReturnType<typeof describeModel>; override: boolean; };
	readonly agentRef: (session: string) => { id: string; name: string; } | null;
	readonly roomInfo: (session: string, busy: ReadonlySet<string>, held: ReadonlyMap<string, string>) => { mode: RoomMode; members: { id: string; name: string; busy: boolean; held: boolean; error: string | null; model: { model: ReturnType<typeof describeModel>; override: boolean; }; }[]; } | null;
	readonly startedBy: (session: string) => { session: string; agent: { id: string; name: string; }; task: string; state: Task["state"]; } | null;
	readonly continuedFrom: (session: string) => string | null;
	readonly guestBot: () => GuestBot | null;
	readonly agent: (id: string) => Agent;
	readonly agents: AgentStore;
	readonly startChat: (agent: Agent, title: string | undefined, from?: { session: string; at: EntryId; }, init?: ConversationInit) => Promise<string>;
	readonly sessionInfo: (session: string) => { id: string; title: string | null; createdAt: number; updatedAt: number; responseAt: number | null; unread: boolean; archivedAt: number | null; model: { provider: string; id: string; } | null; } | undefined;
	readonly session: (id: string) => Promise<string>;
	readonly rooms: RoomStore;
	readonly forkTitle: (session: string) => Promise<string | undefined>;
	readonly broadcastMessage: (message: ServerMessage) => void;
	readonly archive: (session: string) => void;
	readonly unarchive: (session: string) => void;
	readonly roomable: (conversation: string) => boolean;
	readonly roomOf: (session: string) => Promise<{ mode: RoomMode; members: { id: string; name: string; busy: boolean; held: boolean; error: string | null; model: { model: ReturnType<typeof describeModel>; override: boolean; }; }[]; } | null>;
	readonly join: (room: string, agent: Agent) => Promise<Seat>;
	readonly leave: (seat: Seat) => Promise<void>;
	readonly resumeHeld: (conversation: string) => Promise<boolean>;
	readonly utility: (task: UtilityTask, input: string) => Promise<string>;
	readonly conversationText: (session: string, limit: number) => Promise<string>;
	readonly chatLink: (session: string) => { url: string; id: string; sharedAt: number; messages: number; } | null;
	readonly assertOpen: () => void;
	readonly chatLinks: ChatLinkStore;
	readonly deleteImages: (session: string) => Promise<void>;
	readonly sweepUiState: ({ now }?: { now?: boolean | undefined; }) => Promise<number>;
	readonly abort: (conversation: string) => Promise<void>;
	readonly tasks: TaskStore;
	readonly cancelTask: (task: Task, reason: string) => Promise<void>;
	readonly denyPending: (conversation: string, reason: string) => void;
	readonly triggerApi: () => TriggerApi | null;
	readonly scheduleHost: () => ScheduleHost;
	readonly stopConnectorTriggers: (which: (source: ConnectorEventSource, destination: TriggerDestination) => boolean) => Promise<void>;
	readonly turns: (chat: string | null, since: number) => Promise<{ chat: string; agent: string; turn: Turn; }[]>;
	readonly uiBlocks: (id: string, within?: string) => Promise<Map<string, UiProgram>>;
	readonly submitTo: Submit;
	readonly withReplies: (result: PiOperationResult) => Promise<PiOperationResult & { replies: string[]; }>;
	readonly publicTask: (task: Task) => { id: string; parent: string | null; call: string | null; session: string | null; agent: { id: string; name: string; }; from: { id: string; name: string; }; task: string; state: import("../tasks").TaskState; result: string | null; createdAt: number; updatedAt: number; };
	readonly taskOf: (session: string, id: string) => Promise<Task>;
	readonly stop: (session: string, note?: string) => Promise<void>;
	readonly changeQueued: (session: string, id: number, change: "steer" | "cancel" | { readonly text: string; }) => Promise<void>;
	readonly changeSessionModel: (id: string, request: Request) => Promise<{ model: { provider: string; id: string; name: string; images: boolean; }; override: null; } | { model: { provider: string; id: string; name: string; images: boolean; }; override: { provider: string; id: string; name: string; images: boolean; }; }>;
	readonly refreshCustomApps: (now?: boolean) => Promise<void>;
	readonly chatgpt: ChatGPT;
	readonly modelCatalog: () => Models;
	readonly defaultModel: () => PiModel;
	readonly hasWorkersAi: () => boolean;
	readonly allowedModels: () => readonly string[] | null;
	readonly ai: import("agents/models/pi-ai").AI;
	readonly customProviders: () => { catalogId: string; shared: boolean; provider: CustomProvider; }[];
	readonly defaultUtilityModel: () => Model<Api> | undefined;
	readonly utilityModel: () => Promise<Model<Api> | undefined>;
	readonly utilityProvider: (provider: string) => boolean;
	readonly codexImages: CodexImages;
	readonly chooseModel: (model: PiModel | null) => Promise<PiModel>;
	readonly choice: (provider: string, id: string) => Promise<PiModel>;
	readonly workspaceFallbacks: () => PiModel[];
	readonly chooseModelFallbacks: (models: PiModel[]) => PiModel[];
	readonly putOwnProvider: (id: string | null, input: ProviderInput) => Promise<CustomProvider>;
	readonly providersChanged: () => Promise<void>;
	readonly email: Email;
	readonly describeSettings: () => { approvalTimeoutSeconds: number | null; timeZone: string; approvalPolicy: ApprovalPolicy; deviceAlerts: import("../settings").DeviceAlerts; colorMode?: import("../settings").ColorMode; colorTheme?: string; locale?: import("@pim/shared/locales").Locale; };
	readonly applySettings: (update: Record<string, unknown>) => Promise<Settings>;
	readonly usageReport: (days?: number) => { limits: Limits; today: import("../usage").DayUsage; history: import("../usage").DayUsage[]; storageBytes: number; };
	readonly computeReport: () => Promise<{ quota: ComputeQuota; own: Partial<ComputeQuota> | null; usage: { readonly month: string; readonly minutes: number; readonly running: number; readonly byProvider: readonly { readonly provider: string; readonly minutes: number; readonly running: number; }[]; readonly history: readonly { readonly month: string; readonly minutes: number; }[]; } & Disposable; }>;
	readonly usageCosts: (days?: number) => import("../model-calls").CostReport;
	readonly artifactRequest: (url: URL, answer: () => Response | Promise<Response>) => Response | Promise<Response>;
	readonly artifacts: ArtifactStore;
	readonly publicArtifact: <T extends { readonly session: string | null; }>(artifact: T) => T;
	readonly artifact: (id: string) => ArtifactSummary;
	readonly hosted: HostedApps;
	readonly notes: NoteStore;
	readonly builtinOn: (id: string) => boolean;
	readonly publicSession: <T extends { readonly session: string | null; }>(record: T) => T;
	readonly artifactVersion: (id: string, version: string) => { artifact: ArtifactSummary; found: import("../artifacts").ArtifactVersion; };
	readonly name: string;
	readonly artifactData: (key: string, scope: DataScope, op: string, args: Record<string, unknown>) => unknown;
	readonly artifactBridge: (key: string, sha: string, op: unknown, args: Record<string, unknown>, shared: (op: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<{ value: unknown; } | { needs: { capability: string; label: string; }; }>;
	readonly grantArtifact: (key: string, sha: string, capability: unknown) => string;
	readonly hostedApp: (id: string) => ArtifactSummary;
	readonly computer: Computer;
	readonly deployment: () => DeploymentSettings;
	readonly circle: (id: string) => Circle;
	readonly me: () => Guest | null;
	readonly pimOf: (ownerId: string) => Promise<DurableObjectStub<Pim>>;
	readonly othersArtifact: (username: string, id: string, version?: string) => Promise<{ share: import("../visits").Share; me: Guest; host: DurableObjectStub<Pim>; artifact: { readonly id: string; readonly size: number; readonly files: number; readonly title: string; readonly kind: ArtifactKind; readonly version: number; readonly versions: number; readonly sha256: string; readonly createdAt: number; readonly updatedAt: number; }; address: string | null; files: ArtifactFile[]; load: () => Promise<Map<string, { type: string; bytes: Uint8Array; }>>; key: string; }>;
	readonly closed: () => boolean;
	readonly directory: () => DurableObjectStub<import("../directory").Directory>;
	readonly provideComputer: () => Promise<void>;
	readonly displayControl: Map<string, { control: "agent" | "user"; at: number; }>;
	readonly computerChanged: () => void;
	readonly files: Files;
	readonly browser: PimBrowser;
	readonly browserWindow: (url: URL) => Promise<string>;
	readonly browserIn: () => PimBrowser;
	readonly exportData: () => Promise<string>;
	readonly dropModels: (gone: (model: AgentModel) => boolean) => void;
	readonly syncModels: () => Promise<void>;
	readonly imagesChanged: () => void;
	readonly memory: { store: import("../extensions/optmem").OptMemStore; extension: Extension<import("@earendil-works/pi-durable").ToolRegistration>; NapTask: import("@earendil-works/pi-durable").Task<Record<string, never>, { readonly phase: "next"; } | { readonly phase: "summarize"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number; } | { readonly phase: "retry"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number; readonly until: number; }, Record<string, never>, object>; view: (scopes: readonly MemoryScope[]) => string[]; search: (pattern: string, scopes: readonly string[]) => { text: string; isError: boolean; }; startNap: (starter: import("../extensions/optmem").NapStarter) => Promise<TaskId | undefined>; today: () => string; };
	readonly memoryAccess: (agent: Agent) => MemoryAccess;
	readonly memoryScopes: () => MemoryScopeInfo[];
	readonly memoryScope: (key: string) => MemoryScopeInfo;
	readonly startMemoryNap: () => Promise<void>;
	readonly circles: CircleStore;
	readonly scheduledTasks: () => { agent?: string | undefined; session: string | null; label: string | null; instruction: string; newChat: boolean; intervalSeconds?: number | undefined; timeZone?: string | undefined; cron?: string | undefined; id: string; type: string; next: string | null; }[];
	readonly publicApproval: (approval: Approval) => PublicApproval;
	readonly alwaysApprove: (id: string, note?: string) => Promise<Approval>;
	readonly decideApproval: (id: string, decision: "approve" | "deny", note?: string, auto?: AutoApproval, options?: { inTurn?: boolean; }) => Promise<Approval>;
	readonly agentToolPermissions: (agent: Agent) => ToolPermissionInfo[];
	readonly agentSkillsPermission: (agent: Agent) => ToolPermissionInfo;
	readonly toolPermissions: (audience?: string) => ToolPermissionInfo[];
	readonly setAgentToolPermission: (agent: Agent, app: string, tool: string, permission: ToolPermission | null) => ToolPermissionInfo;
	readonly setToolPermission: (audience: string, app: string, tool: string, permission: ToolPermission | null) => ToolPermissionInfo;
	readonly shareableTools: (agent: Agent) => BotTool[];
	readonly checkSkills: <T extends { skills: readonly string[]; }>(input: T) => T;
	readonly checkApps: <T extends { apps: readonly string[]; }>(input: T) => T;
	readonly checkNamedScopes: (keys: readonly string[]) => void;
	readonly chooseAgentModel: (agent: Agent, model: PiModel | null) => Promise<Agent>;
	readonly chooseAgentFallbacks: (agent: Agent, models: PiModel[]) => Promise<Agent>;
	readonly skills: SkillStore;
	readonly skillAgents: (name: string) => { id: string; name: string; }[];
	readonly describeSkill: (name: string) => { history: import("../skills").SkillVersionInfo[]; agents: { id: string; name: string; }[]; version: number; author: string | null; restoredFrom: number | null; source: string | null; createdAt: number; name: string; description: string; instructions: string; files: readonly import("../skills").SkillFile[]; updatedAt: number; };
	readonly skill: (name: string) => import("../skills").Skill;
	readonly images: ImageStore;
	readonly suggestions: (agent: Agent, session: string, locale: string) => Promise<string[]>;
	readonly extensions: PimExtensions;
	readonly pimConfig: () => PimConfig;
	readonly describeCircles: () => { members: { ownerId: string; username: string; addedAt: number; }[]; id: string; name: string; enabled: boolean; memoryScopes: readonly string[]; createdAt: number; }[];
	readonly tellRevoked: (ownerIds: readonly string[]) => Promise<void>;
	readonly removeCircleMember: (ownerId: string) => Promise<boolean>;
	readonly startVisit: (username: string) => Promise<string>;
	readonly appDirectory: () => DirectoryApp[];
	readonly describeApps: () => { app: string | null; agents: string[]; tools: { name: string; description: string | null; }[]; id: string; name: string; url: string; state: string; error: string | null; authUrl: string | null; instructions: string | null; approval: McpApproval; }[];
	readonly nativeApps: NativeApps;
	readonly env: (names: readonly string[]) => Record<string, string>;
	readonly connectApp: (app: DirectoryApp, options?: { approval?: McpApproval; }) => Promise<{ id: string; state: string; authUrl?: string; }>;
	readonly apps: McpBridge;
	readonly installApps: () => void;
	readonly disconnect: (id: string) => Promise<void>;
	readonly catalog: AppCatalog;
	readonly receiveConnectorEvent: (key: string, request: Request) => Promise<Response>;
	readonly vapidKeys: () => Promise<VapidKeys>;
	readonly publicNotification: <T extends { readonly session: string | null; }>(notification: T) => T & { agent: { id: string; icon: number | null; symbol: string | null; color: string | null; } | null; };
}

/** The root, this space as an MCP server, chats, group chats, side jobs on the utility model, chat links, ui blocks, tasks and queued messages. */
function chatRoutes(space: SpaceRouteHost): Route[] {
	return [
		[
			"GET",
			"/",
			() => ({
				model: space.chosenModel().id,
				timeZone: space.settings().timeZone,
				rootSession: space.store.publicId(ROOT_SESSION),
				tools: space.tools(),
			}),
		],
		// This space as an MCP server, for MCP clients such as Claude or ChatGPT.
		...(["POST", "GET", "DELETE"] as const).map((method): Route => [method, MCP_SERVER_PATH, (_params, request) => space.mcpServer(request)]),
		// Sessions: separate conversations, each with its own transcript and runs.
		[
			"GET",
			"/sessions",
			async () => {
				const hidden = space.hiddenSessions();
				const archiveBefore = Date.now() - ARCHIVE_AFTER_MS;
				// A run held for the person to try again isn't at work.
				const held = await space.heldSessions();
				const heldErrors = await space.heldErrors(held);
				const all = (await space.harness.sessions.list()).map((session) => ({ ...session, busy: session.busy && !held.has(session.id) }));
				const busy = new Set(all.flatMap((session) => (session.busy ? [session.id] : [])));
				const sessions = all.filter((session) => !hidden.has(session.id)).map((session) => {
					const info = space.store.sessionInfo(session.id);
					const visit = space.visits.bySession(session.id);
					const unread = info?.unread ?? false;
					return {
						id: space.store.publicId(session.id),
						busy: session.busy,
						held: held.has(session.id),
						error: heldErrors.get(session.id) ?? null,
						title: info?.title ?? null,
						model: space.sessionModelInfo(session.id),
						createdAt: info?.createdAt ?? null,
						updatedAt: info?.updatedAt ?? null,
						responseAt: info?.responseAt ?? null,
						unread,
						// A chat still working, or with a reply not yet read, stays in the list however old it is.
						// A chat that has been carried on is archived: the chat that carries it on has taken its place.
						archived: info?.archivedAt != null || space.store.isContinued(session.id) || (!session.busy && !unread && info !== undefined && info.updatedAt < archiveBefore),
						visit: visit ? { username: visit.username, available: !visit.revoked } : null,
						agent: space.agentRef(session.id),
						room: space.roomInfo(session.id, busy, heldErrors),
						startedBy: space.startedBy(session.id),
						continuedFrom: space.continuedFrom(session.id),
					};
				});
				// Most recently active first; sessions never used last.
				return { sessions: sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) };
			},
		],
		[
			"POST",
			"/sessions",
			async (_params, request) => {
				const { title, agent: agentId } = await readJson<{ title: string; agent: string }>(request);
				// A guest chats with their bot alone.
				const guest = space.guestBot();
				const agent = guest ? space.agent(guest.agent) : agentId === undefined ? space.agents.majordomo() : space.agent(agentId);
				const id = await space.startChat(agent, typeof title === "string" && title.trim() !== "" ? clipTitle(title) : undefined);
				return { ...space.sessionInfo(id), agent: space.agentRef(id) };
			},
		],
		// A new chat with what was said in this one: through an agent's message, or up to one of the person's, to send it again changed.
		[
			"POST",
			"/sessions/:session/fork",
			async ({ session }, request) => {
				const id = await space.session(session!);
				const { at, before } = await readJson<{ at: string; before: string }>(request);
				const message = before ?? at;
				if (typeof message !== "string" || (at !== undefined && before !== undefined)) throw new HttpError(400, "Give either at or before: a message's id");
				if (space.visits.bySession(id)) throw new HttpError(400, "A chat with someone else's agent can't be forked");
				if (space.rooms.seats(id).some((seat) => seat.conversation !== id)) throw new HttpError(400, "A group chat can't be forked");
				const point = forkPoint(await space.harness.session(id).messages(), message, before !== undefined);
				if (point === undefined) throw new HttpError(400, before !== undefined ? "before must be one of your messages in this chat" : "at must be one of the agent's messages in this chat");
				const title = await space.forkTitle(id);
				const fork = await space.startChat(space.agents.ofSession(id), title, point ? { session: id, at: point.id } : undefined);
				// The person's next message in it names it anew, for where it went.
				if (title !== undefined) space.store.setMeta(`${FORK_KEY}${fork}`, title);
				space.broadcastMessage({ type: "sessions" });
				return { ...space.sessionInfo(fork), agent: space.agentRef(fork) };
			},
		],
		[
			"POST",
			"/sessions/:session/read",
			async ({ session }, request) => {
				const id = await space.session(session!);
				const { responseAt } = await readJson<{ responseAt: number }>(request);
				if (typeof responseAt !== "number" || !Number.isSafeInteger(responseAt) || responseAt < 0) throw new HttpError(400, "responseAt must be a non-negative integer");
				space.store.readSession(id, responseAt);
				if (!space.store.sessionInfo(id)?.unread) space.store.readMentions(id);
				space.broadcastMessage({ type: "sessions" });
				return space.sessionInfo(id);
			},
		],
		[
			"POST",
			"/sessions/:session/archive",
			async ({ session }) => {
				const id = await space.session(session!);
				space.archive(id);
				return space.sessionInfo(id);
			},
		],
		[
			"POST",
			"/sessions/:session/unarchive",
			async ({ session }) => {
				const id = await space.session(session!);
				space.unarchive(id);
				return space.sessionInfo(id);
			},
		],
		[
			"PUT",
			"/sessions/:session",
			async ({ session }, request) => {
				const id = await space.session(session!);
				const { title } = await readJson<{ title: string }>(request);
				if (typeof title !== "string" || title.trim() === "") throw new HttpError(400, "title must be a non-empty string");
				space.store.renameSession(id, clipTitle(title));
				return space.sessionInfo(id);
			},
		],
		// How the agents in a group chat take turns (./rooms.ts).
		[
			"PUT",
			"/sessions/:session/room",
			async ({ session }, request) => {
				const id = await space.session(session!);
				const { mode } = await readJson<{ mode: RoomMode }>(request);
				if (mode !== "mentions" && mode !== "open") throw new HttpError(400, "mode must be mentions or open");
				if (!space.roomable(id)) throw new HttpError(400, "Only a chat with your own agents can be a group chat");
				space.rooms.open(id, space.agents.ofSession(id).id);
				space.rooms.setMode(id, mode);
				space.broadcastMessage({ type: "sessions" });
				return { room: await space.roomOf(id) };
			},
		],
		[
			"POST",
			"/sessions/:session/room/members",
			async ({ session }, request) => {
				const id = await space.session(session!);
				const { agent } = await readJson<{ agent: string }>(request);
				const joining = typeof agent === "string" ? space.agents.get(agent) : undefined;
				if (!joining) throw new HttpError(404, "No such agent");
				if (!space.roomable(id)) throw new HttpError(400, "Only a chat with your own agents can be a group chat");
				if (joining.id !== space.agents.ofSession(id).id) await space.join(id, joining);
				return { room: await space.roomOf(id) };
			},
		],
		[
			"DELETE",
			"/sessions/:session/room/members/:agent",
			async ({ session, agent }) => {
				const id = await space.session(session!);
				const seat = space.rooms.at(id, agent!);
				if (!seat || seat.conversation === id) throw new HttpError(404, "No such agent in this chat besides its host");
				await space.leave(seat);
				return { room: await space.roomOf(id) };
			},
		],
		// Asks an agent of a group chat again, whose run is held after a model error; the host has its own Try again.
		[
			"POST",
			"/sessions/:session/room/members/:agent/retry",
			async ({ session, agent }) => {
				const id = await space.session(session!);
				const seat = space.rooms.at(id, agent!);
				if (!seat || seat.conversation === id) throw new HttpError(404, "No such agent in this chat besides its host");
				if (!(await space.resumeHeld(seat.conversation))) throw new HttpError(409, "This agent isn't waiting to try again");
				space.broadcastMessage({ type: "sessions" });
				return { room: await space.roomOf(id) };
			},
		],
		// Side jobs on the utility model (./utility.ts).
		[
			"POST",
			"/sessions/:session/title",
			async ({ session }) => {
				const id = await space.session(session!);
				const title = clipTitle(await space.utility(NAME_CHAT, await space.conversationText(id, 8_000)));
				space.store.renameSession(id, title);
				space.broadcastMessage({ type: "sessions" });
				return space.sessionInfo(id);
			},
		],
		[
			"GET",
			"/sessions/:session/summary",
			async ({ session }) => {
				const id = await space.session(session!);
				const text = conversationText(projectEntries(await space.harness.session(id).messages()), 48_000);
				if (text === "") return { summary: null };
				// Written again only when what was said has changed since the last one.
				const of = await digestHex(text);
				let summary = space.store.sessionSummary(id, of);
				if (summary === undefined) {
					summary = await space.utility(SUMMARIZE_CHAT, text);
					space.store.setSessionSummary(id, summary, of);
				}
				return { summary };
			},
		],
		// Public links to chats (./chat-links.ts): a copy of the chat as it is now, for anyone with the link.
		["GET", "/sessions/:session/link", async ({ session }) => ({ link: space.chatLink(await space.session(session!)) })],
		[
			"PUT",
			"/sessions/:session/link",
			async ({ session }) => {
				const id = await space.session(session!);
				if (space.visits.bySession(id)) throw new HttpError(400, "A chat with someone else's agent can't have a public link");
				const agent = space.agents.ofSession(id);
				const chat: SharedChat = {
					title: space.store.sessionInfo(id)?.title ?? null,
					agent: { name: agent.name, symbol: agent.symbol, color: agent.color },
					sharedAt: Date.now(),
					messages: sharedMessages(await space.harness.session(id).messages()),
				};
				if (chat.messages.length === 0) throw new HttpError(409, "This chat has nothing to share yet");
				if (new TextEncoder().encode(JSON.stringify(chat)).byteLength > MAX_SHARED_BYTES) throw new HttpError(413, "This chat is too long for a public link");
				space.assertOpen();
				space.chatLinks.save(id, chat);
				return { link: space.chatLink(id) };
			},
		],
		["DELETE", "/sessions/:session/link", async ({ session }) => ({ deleted: space.chatLinks.delete(await space.session(session!)) })],
		// What a chat's link shows. The Worker serves it to anyone who has the link, with no token.
		[
			"GET",
			"/shared/:link",
			({ link }) => {
				const chat = LINK_ID.test(link!) ? space.chatLinks.chat(link!) : undefined;
				if (!chat) throw new HttpError(404, "No such link");
				return chat;
			},
		],
		[
			"POST",
			"/prompts/improve",
			async (_params, request) => {
				const { text } = await readJson<{ text: string }>(request);
				if (typeof text !== "string" || text.trim() === "") throw new HttpError(400, "text must be a non-empty string");
				if (text.length > 8_000) throw new HttpError(413, "text is longer than 8,000 characters");
				return { text: await space.utility(IMPROVE_PROMPT, text) };
			},
		],
		[
			"DELETE",
			"/sessions/:session",
			async ({ session }) => {
				const id = await space.session(session!);
				space.store.deleteSession(id);
				space.store.deleteMeta(`${SUGGESTIONS_KEY}${id}`);
				space.store.deleteMeta(`${FORK_KEY}${id}`);
				space.chatLinks.delete(id);
				await space.deleteImages(id);
				await space.sweepUiState({ now: true }).catch(() => 0);
				const visit = space.visits.bySession(id);
				if (visit) space.visits.setSession(visit.ownerId, null);
				// Nothing keeps working in a chat the user can no longer see, nor in the tasks it handed out, nor do the other agents in it.
				for (const seat of space.rooms.seats(id).filter((seat) => seat.conversation !== id)) {
					await space.abort(seat.conversation);
					for (const task of space.tasks.byRequester(seat.conversation)) await space.cancelTask(task, "Its chat was deleted.");
				}
				// A task's chat is canceled before its run is stopped, so that the run ending doesn't fail the task first: its requester hears it was canceled.
				space.denyPending(id, "Its chat was deleted.");
				const own = space.tasks.of(id);
				if (own?.chat) await space.cancelTask(own, "The person deleted its chat.");
				for (const task of space.tasks.byRequester(id)) await space.cancelTask(task, "Its chat was deleted.");
				await space.abort(id);
				// A scheduled task that runs in it ends with it, as schedules did; one that starts new chats goes on without the chat that scheduled it.
				const triggers = space.triggerApi();
				for (const trigger of triggers ? scheduledTriggers(triggers, PERSON) : []) {
					if (trigger.destination.type !== "existing_chat" || trigger.destination.chatId !== session) continue;
					if (space.scheduleHost().tasks().of(trigger.id) !== undefined) await triggers?.remove(PERSON, trigger.id);
				}
				// A watch delivers to its chat only: it goes with it.
				await space.stopConnectorTriggers((_source, destination) => destination.type === "existing_chat" && destination.chatId === id);
				return { deleted: true };
			},
		],
		[
			"GET",
			"/sessions/:session/activity",
			async ({ session }) => {
				await space.session(session!);
				const turns = (await space.turns(session!, 0)).map((item) => item.turn);
				return activityOf(turns, Date.now(), { running: turns.at(-1)?.inProgress ?? false, startedAt: turns.at(-1)?.startedAt ?? 0 });
			},
		],
		[
			"GET",
			"/sessions/:session/messages",
			async ({ session }) => {
				const id = await space.session(session!);
				const handle = space.harness.session(id);
				const [entries, busy, pending] = await Promise.all([
					handle.messages(),
					handle.busy(),
					space.harness.pending({ session: id }),
				]);
				return { session, busy, pending, messages: projectEntries(entries) };
			},
		],
		// What a ```ui block of a message holds, kept as the person changes it so that a reload finds it as it was.
		[
			"GET",
			"/messages/:message/ui-state",
			async ({ message }) => {
				await space.uiBlocks(message!);
				return { blocks: space.store.uiStates(message!) };
			},
		],
		[
			"PUT",
			"/messages/:message/ui-state/:block",
			async ({ message, block }, request) => {
				space.assertOpen();
				const program = (await space.uiBlocks(message!)).get(block!);
				if (program === undefined) throw new HttpError(404, `Message ${message} has no ui block ${block}`);
				const body = await readJson<{ version: unknown; state: unknown; submitted: unknown }>(request);
				if (!Number.isInteger(body.version) || (body.version as number) < 0) throw new HttpError(400, "version must be the version you last read, 0 for none");
				if (body.submitted !== undefined && typeof body.submitted !== "boolean") throw new HttpError(400, "submitted must be true or false");
				const checked = checkUiState(program, body.state);
				if (!checked.ok) throw new HttpError(400, checked.error);
				const current = space.store.uiState(message!, block!);
				// A block that was submitted stays as it was submitted; one written since the version the caller read isn't overwritten unseen.
				if (current?.submitted || (current?.version ?? 0) !== body.version) {
					return Response.json(
						{ error: current?.submitted ? "This block was submitted and can't be changed" : "This block was saved since the version you sent", current: current ?? null },
						{ status: 409 },
					);
				}
				if (body.submitted === true && Object.keys(checked.state.submitted).length === 0) throw new HttpError(400, "A block with no form submitted can't be marked submitted");
				const kept = space.store.setUiState(message!, block!, checked.state, body.submitted === true, current?.version ?? 0);
				// A write is a good time to tidy: what a deleted chat left behind goes, a few messages at a time.
				await space.sweepUiState().catch(() => 0);
				return kept;
			},
		],
		[
			"GET",
			"/sessions/:session/cost",
			async ({ session }) => {
				const id = await space.session(session!);
				const pi = await space.harness.pi();
				// The chat's cost includes every task its agents handed out, and the tasks those handed out in turn.
				const conversations = new Set<string>();
				const pending = [id];
				for (let chat = pending.pop(); chat !== undefined; chat = pending.pop()) {
					for (const conversation of space.rooms.everyConversation(chat)) {
						if (conversations.has(conversation)) continue;
						conversations.add(conversation);
						for (const task of space.tasks.byRequester(conversation)) pending.push(task.conversation);
					}
				}
				const ledgers = await Promise.all(
					[...conversations].map((conversation) => pi.snapshot(UsageDoc, Number(conversation) as ConversationId, BACKGROUND_CONTEXT)),
				);
				return sessionCost(ledgers.filter((ledger) => ledger !== undefined));
			},
		],
		[
			"POST",
			"/sessions/:session/messages",
			async ({ session }, request) => {
				const id = await space.session(session!);
				const body = await readJson<{
					content: unknown;
					whenBusy: "followUp" | "steer";
					operationId: string;
					wait: boolean;
				}>(request);
				const content = userInput(body.content);
				if (body.whenBusy !== undefined && body.whenBusy !== "followUp" && body.whenBusy !== "steer") {
					throw new HttpError(400, "whenBusy must be followUp or steer");
				}
				const receipt = await space.submitTo(
					id,
					content,
					{
						...(body.whenBusy ? { whenBusy: body.whenBusy } : {}),
						...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
					},
					"user",
				);
				if (!body.wait) return Response.json({ ...receipt, session }, { status: 202 });
				return { ...(await space.withReplies(await space.harness.wait(receipt.operationId, { session: id }))), session };
			},
		],
		[
			"GET",
			"/sessions/:session/operations/:operation",
			async ({ session, operation }, _request, url) => {
				const id = await space.session(session!);
				const timeout = Math.min(Number(url.searchParams.get("timeout") ?? 25_000) || 25_000, 60_000);
				const signal = AbortSignal.timeout(timeout);
				try {
					return { ...(await space.withReplies(await space.harness.wait(operation!, { session: id, signal }))), session };
				} catch (error) {
					if (signal.aborted) return { operationId: operation, session, status: "pending" };
					throw error;
				}
			},
		],
		// The tasks the work begun in a chat led to, as a tree by `parent`, and each task's conversation, read-only.
		[
			"GET",
			"/sessions/:session/tasks",
			async ({ session }) => ({ tasks: space.tasks.ofRoot(await space.session(session!)).map((task) => space.publicTask(task)) }),
		],
		[
			"GET",
			"/sessions/:session/tasks/:task",
			async ({ session, task: id }) => {
				const task = await space.taskOf(session!, id!);
				return { ...space.publicTask(task), messages: projectEntries(await space.harness.session(task.conversation).messages()) };
			},
		],
		[
			"POST",
			"/sessions/:session/tasks/:task/cancel",
			async ({ session, task: id }) => {
				const task = await space.taskOf(session!, id!);
				await space.cancelTask(task, "The person canceled it.");
				return space.publicTask(space.tasks.get(task.id)!);
			},
		],
		// Asks the model again in a chat held after a model error, picking up where it stopped, with whatever model the agent has now.
		[
			"POST",
			"/sessions/:session/retry",
			async ({ session }) => {
				const id = await space.session(session!);
				if (!(await space.resumeHeld(id))) throw new HttpError(409, "This chat isn't waiting to try again");
				space.broadcastMessage({ type: "sessions" });
				return { session };
			},
		],
		[
			"POST",
			"/sessions/:session/abort",
			async ({ session }, request) => {
				const id = await space.session(session!);
				const { operationId } = await readJson<{ operationId: string }>(request);
				if (operationId !== undefined) return { aborted: await space.harness.session(id).abort(operationId) };
				// Stopping a group chat stops every agent at work in it.
				// What they were waiting on from the person is withdrawn with them, so no request is left that nothing can wake.
				for (const seat of space.rooms.seats(id).filter((seat) => seat.conversation !== id)) {
					space.denyPending(seat.conversation, "Its chat was stopped.");
					await space.stop(seat.conversation);
				}
				space.denyPending(id, "Its chat was stopped.");
				await space.stop(id);
				return { aborted: true };
			},
		],
		// The person's messages queued behind the work in a chat, by their `id` in pi's inbox, before the agent reads them.
		[
			"POST",
			"/sessions/:session/queue/:id/steer",
			async ({ session, id }) => {
				await space.changeQueued(await space.session(session!), Number(id), "steer");
				return { id: Number(id) };
			},
		],
		[
			"PUT",
			"/sessions/:session/queue/:id",
			async ({ session, id }, request) => {
				const { text } = await readJson<{ text: string }>(request);
				if (typeof text !== "string") throw new HttpError(400, "text must be a string");
				await space.changeQueued(await space.session(session!), Number(id), { text });
				return { id: Number(id) };
			},
		],
		[
			"DELETE",
			"/sessions/:session/queue/:id",
			async ({ session, id }) => {
				await space.changeQueued(await space.session(session!), Number(id), "cancel");
				return { id: Number(id) };
			},
		],
		[
			"POST",
			"/sessions/:session/reset",
			async ({ session }, request) => {
				const id = await space.session(session!);
				const { handoff } = await readJson<{ handoff: string }>(request);
				await space.harness.session(id).reset(typeof handoff === "string" ? handoff : undefined);
				return { reset: true };
			},
		],
		[
			"PUT",
			"/sessions/:session/model",
			async ({ session }, request) => space.changeSessionModel(await space.session(session!), request),
		],
	];
}

/** Models and their choice for a chat, agent or the space, model providers, the person's email address and settings. */
function modelAndSettingsRoutes(space: SpaceRouteHost): Route[] {
	return [
		// A group chat's agent besides its host has a conversation of its own; its model is chosen for that, never for the agent.
		[
			"PUT",
			"/sessions/:session/room/members/:agent/model",
			async ({ session, agent }, request) => {
				const id = await space.session(session!);
				const seat = space.rooms.at(id, agent!);
				if (!seat || seat.conversation === id) throw new HttpError(404, "No such agent in this chat besides its host");
				return space.changeSessionModel(seat.conversation, request);
			},
		],
		// The model every session uses, and the ChatGPT plan it can run on.
		[
			"GET",
			"/model",
			async () => {
				await space.refreshCustomApps(true);
				const chatgpt = await space.chatgpt.status();
				let chatgptModels: PiModel[] = [];
				let chatgptError: string | null = null;
				if (chatgpt.connected) {
					try {
						chatgptModels = await space.chatgpt.models(space.modelCatalog());
					} catch (error) {
						chatgptError = errorMessage(error);
					}
				}
				const fallback = space.defaultModel();
				const platform = space.hasWorkersAi() ? (space.allowedModels() ?? []).filter((id) => id !== fallback.id).map((id) => space.ai(id)) : [];
				const providers = space.customProviders();
				const custom = providers.flatMap(({ catalogId, provider }) => provider.models.flatMap((model) => space.modelCatalog().getModel(catalogId, model.id) ?? []));
				// Without Workers AI the default is a provider's model, already among `custom`, or nothing to choose.
				const choices = [...(space.hasWorkersAi() ? [fallback] : []), ...platform, ...chatgptModels, ...custom];
				const utilityDefault = space.defaultUtilityModel();
				const utility = await space.utilityModel();
				// Only models that can answer in a JSON schema, for the jobs that need one.
				const utilityChoices = [...(utilityDefault ? [utilityDefault] : []), ...[...chatgptModels, ...custom].filter((model) => space.utilityProvider(model.provider) && !(utilityDefault && sameModel(model, utilityDefault)))];
				return {
					model: describeModel(space.chosenModel()),
					default: describeModel(fallback),
					choices: choices.map(describeModel),
					workersAi: space.hasWorkersAi(),
					// The model for side jobs (./utility.ts); null when there is none.
					utility: {
						model: utility ? describeModel(utility) : null,
						default: utilityDefault ? describeModel(utilityDefault) : null,
						choices: utilityChoices.map(describeModel),
					},
					chatgpt: { ...chatgpt, error: chatgptError },
					chatgptImages: await space.codexImages.status(),
					// The providers the person can use besides Workers AI and the ChatGPT plan: the admin's, then their own.
					providers: providers.map(({ catalogId, shared, provider }) => ({ ...providerInfo(provider), provider: catalogId, shared })),
				};
			},
		],
		[
			"PUT",
			"/model",
			async (_params, request) => {
				const { provider, id } = await readJson<{ provider: string; id: string }>(request);
				if (typeof provider !== "string" || typeof id !== "string") {
					throw new HttpError(400, "provider and id must be strings");
				}
				const fallback = space.defaultModel();
				if (provider === fallback.provider && id === fallback.id) {
					return { model: describeModel(await space.chooseModel(null)) };
				}
				return { model: describeModel(await space.chooseModel(await space.choice(provider, id))) };
			},
		],
		// The models runs move on to, in order, when an agent's own and its fallbacks fail, from `GET /model`'s choices.
		["GET", "/model/fallbacks", () => ({ models: space.workspaceFallbacks().map(describeModel) })],
		[
			"PUT",
			"/model/fallbacks",
			async (_params, request) => {
				const { models } = (await readJson<{ models: { provider: string; id: string }[] }>(request)) ?? {};
				if (!Array.isArray(models) || models.some((model) => typeof model?.provider !== "string" || typeof model.id !== "string")) {
					throw new HttpError(400, "models must be a list of provider and id");
				}
				return { models: space.chooseModelFallbacks(await Promise.all(models.map((model) => space.choice(model.provider, model.id)))).map(describeModel) };
			},
		],
		[
			"PUT",
			"/model/utility",
			async (_params, request) => {
				const { provider, id } = await readJson<{ provider: string; id: string }>(request);
				if (typeof provider !== "string" || typeof id !== "string") {
					throw new HttpError(400, "provider and id must be strings");
				}
				const fallback = space.defaultUtilityModel();
				if (fallback && provider === fallback.provider && id === fallback.id) space.store.deleteMeta(UTILITY_MODEL_KEY);
				else {
					const model = await space.choice(provider, id);
					if (!space.utilityProvider(model.provider)) {
						throw new HttpError(400, "That model can't be the utility model: its provider isn't known to answer in a JSON schema. For a custom endpoint, say in its settings that it does.");
					}
					space.store.setMeta(UTILITY_MODEL_KEY, JSON.stringify({ provider: model.provider, id: model.id }));
				}
				const model = await space.utilityModel();
				return { model: model ? describeModel(model) : null };
			},
		],
		// The person's own model providers (./providers.ts); the admin's are under /api/admin/providers.
		["GET", "/providers/built-in", async () => ({ providers: await builtinProviders() })],
		[
			"POST",
			"/providers",
			async (_params, request) => ({ provider: providerInfo(await space.putOwnProvider(null, await readJson<ProviderInput>(request))) }),
		],
		[
			"PUT",
			"/providers/:id",
			async ({ id }, request) => ({ provider: providerInfo(await space.putOwnProvider(id!, await readJson<ProviderInput>(request))) }),
		],
		[
			"DELETE",
			"/providers/:id",
			async ({ id }) => {
				const providers = JSON.parse(space.store.meta(OWN_PROVIDERS_KEY) ?? "[]") as CustomProvider[];
				if (!providers.some((provider) => provider.id === id)) throw new HttpError(404, `No provider ${id}`);
				space.store.setMeta(OWN_PROVIDERS_KEY, JSON.stringify(providers.filter((provider) => provider.id !== id)));
				await space.providersChanged();
				return { deleted: true };
			},
		],
		// The address Pim emails the person at, confirmed with a code it sends there.
		["GET", "/email", () => space.email.state()],
		["PUT", "/email", async (_params, request) => space.email.start((await readJson<{ address: unknown }>(request)).address)],
		["POST", "/email/confirm", async (_params, request) => space.email.confirm((await readJson<{ code: unknown }>(request)).code)],
		["DELETE", "/email", () => space.email.remove()],
		// The person's settings, and what they used.
		["GET", "/settings", () => space.describeSettings()],
		[
			"PUT",
			"/settings",
			async (_params, request) => {
				await space.applySettings(await readJson<Record<string, unknown>>(request));
				return space.describeSettings();
			},
		],
		["GET", "/usage", async () => ({ ...space.usageReport(), compute: await space.computeReport() })],
		["GET", "/usage/costs", (_params, _request, url) => space.usageCosts(Number(url.searchParams.get("days") ?? 30))],
	];
}

/** Apps agents made, notes, the backend an app can have, and apps others shared with this person. */
function appRoutes(space: SpaceRouteHost): Route[] {
	return [
		// Apps: what the agent made, every version kept. Their bytes are never kept by the browser,
		// and HTML in them runs only sandboxed (see ./artifacts.ts).
		["GET", "/artifacts", (_params, _request, url) => space.artifactRequest(url, () => noStore({ artifacts: space.artifacts.list().map((artifact) => space.publicArtifact(artifact)), bytes: space.artifacts.totalBytes() }))],
		[
			"GET",
			"/artifacts/:id",
			({ id }, _request, url) =>
				space.artifactRequest(url, () => {
					const artifact = space.artifact(id!);
					return noStore({ ...space.publicArtifact(artifact), history: space.artifacts.versions(artifact.id), circles: space.artifacts.circlesOf(artifact.id) });
				}),
		],
		[
			"DELETE",
			"/artifacts/:id",
			({ id }, _request, url) =>
				space.artifactRequest(url, async () => {
					space.assertOpen();
					const artifact = space.artifact(id!);
					await space.hosted.forget(artifact.id);
					space.notes.forget(artifact.id);
					await space.artifacts.delete(artifact.id);
					return noStore({ deleted: true });
				}),
		],
		[
			"PUT",
			"/artifacts/:id",
			({ id }, request, url) =>
				space.artifactRequest(url, async () => {
					const artifact = space.artifact(id!);
					const { title } = await readJson<{ title: unknown }>(request);
					if (typeof title !== "string") throw new HttpError(400, "title must be a string");
					space.assertOpen();
					return noStore(space.publicArtifact(space.artifacts.rename(artifact.id, title)));
				}),
		],
		// A note the person starts themselves, empty, to write in with their agents.
		[
			"POST",
			"/notes",
			(_params, request, url) =>
				space.artifactRequest(url, async () => {
					const { title } = await readJson<{ title: unknown }>(request);
					if (typeof title !== "string") throw new HttpError(400, "title must be a string");
					space.assertOpen();
					if (!space.builtinOn("notes")) throw new HttpError(403, "Notes is off on this Pim.");
					const id = crypto.randomUUID();
					await space.artifacts.create({ id, title: checkTitle(title), kind: "markdown", content: "", session: null });
					return noStore(space.publicArtifact(space.artifacts.get(id)!), 201);
				}),
		],
		[
			"POST",
			"/artifacts/:id/versions",
			({ id }, request, url) =>
				space.artifactRequest(url, async () => {
					const artifact = space.artifact(id!);
					const { baseVersion, content, title, path } = await readJson<{ baseVersion: number; content: string; title: string; path: string }>(request);
					if (!Number.isSafeInteger(baseVersion)) throw new HttpError(400, "baseVersion must be a version number");
					if (typeof content !== "string") throw new HttpError(400, "content must be a string");
					const file = path === undefined ? ENTRY_FILES[artifact.kind] : checkPath(path);
					// Checked with the version's other files, when it's based on the latest; append refuses it otherwise.
					if (baseVersion === artifact.version) {
						const files = new Map(await space.artifacts.read(artifact.id, artifact.version));
						if (path !== undefined && !files.has(file)) throw new HttpError(404, `Version ${artifact.version} has no file ${file}`);
						files.set(file, { type: fileType(file), bytes: new TextEncoder().encode(content) });
						checkFiles(artifact.kind, files);
					}
					const name = title === undefined ? undefined : checkTitle(title);
					space.assertOpen();
					const change = { baseVersion: baseVersion!, source: "person", ...(name !== undefined ? { title: name } : {}) } as const;
					// A note's whole new text goes into its live text too, where the person's editors see it.
					const { version, changed } =
						artifact.kind === "markdown"
							? await space.notes.write(artifact.id, { ...change, content })
							: await space.artifacts.append(artifact.id, { ...change, files: { [file]: content } });
					return noStore({ ...space.publicSession(space.artifacts.get(artifact.id)!), saved: version.version, changed }, changed ? 201 : 200);
				}),
		],
		[
			"POST",
			"/artifacts/:id/restore",
			({ id }, request, url) =>
				space.artifactRequest(url, async () => {
					const artifact = space.artifact(id!);
					const { version, baseVersion } = await readJson<{ version: number; baseVersion: number }>(request);
					if (!Number.isSafeInteger(version) || !Number.isSafeInteger(baseVersion)) {
						throw new HttpError(400, "version and baseVersion must be version numbers");
					}
					space.assertOpen();
					const restored =
						artifact.kind === "markdown"
							? await space.notes.restore(artifact.id, version!, baseVersion!)
							: await space.artifacts.restore(artifact.id, version!, baseVersion!);
					return noStore({ ...space.publicSession(space.artifacts.get(artifact.id)!), restored: restored.version }, 201);
				}),
		],
		[
			"GET",
			"/artifacts/:id/versions/:version",
			({ id, version }, _request, url) =>
				space.artifactRequest(url, async () => {
					const { artifact, found } = space.artifactVersion(id!, version!);
					const path = url.searchParams.get("path") ?? ENTRY_FILES[artifact.kind];
					const file = found.files.find((candidate) => candidate.path === path);
					if (!file) throw new HttpError(404, `Version ${found.version} has no file ${path}`);
					// Only text is sent as content: anything else, the file's download has.
					const content = isTextType(file.type) ? await space.artifacts.text(artifact.id, found.version, path) : null;
					return noStore({ id: artifact.id, title: artifact.title, kind: artifact.kind, latest: artifact.version, ...found, path, content });
				}),
		],
		[
			"GET",
			"/artifacts/:id/versions/:version/frame",
			({ id, version }, _request, url) =>
				space.artifactRequest(url, async () => {
					const { artifact, found } = space.artifactVersion(id!, version!);
					// An app with a backend loads from its own address, whichever version is asked for: the one running.
					if (artifact.kind === "hosted") {
						if (space.hosted.version(artifact.id) === undefined) throw new HttpError(409, "This app's backend hasn't been run yet. Deploy it, and it opens here.");
						return new Response(null, { status: 302, headers: { location: await space.hosted.address(space.name, artifact.id), "cache-control": "no-store, private" } });
					}
					return framePage(artifact.kind, await space.artifacts.read(artifact.id, found.version), url.origin, { thumbnail: url.searchParams.has("thumbnail") });
				}),
		],
		[
			"POST",
			"/artifacts/:id/versions/:version/bridge",
			({ id, version }, request, url) =>
				space.artifactRequest(url, async () => {
					const { artifact, found } = space.artifactVersion(id!, version!);
					const { op, args } = await readJson<{ op: string; args: Record<string, unknown> }>(request);
					const shared = async (call: string, input: Record<string, unknown>) => space.artifactData(artifact.id, "shared", call, input);
					return noStore(await space.artifactBridge(artifact.id, found.sha256, op, args && typeof args === "object" ? args : {}, shared));
				}),
		],
		[
			"POST",
			"/artifacts/:id/versions/:version/grants",
			({ id, version }, request, url) =>
				space.artifactRequest(url, async () => {
					const { artifact, found } = space.artifactVersion(id!, version!);
					const { capability } = await readJson<{ capability: string }>(request);
					return noStore({ granted: space.grantArtifact(artifact.id, found.sha256, capability) }, 201);
				}),
		],
		// The backend of an app that has one (see ./hosted.ts): how it is doing, what it printed, and the person's own choice to stop it or run a version.
		[
			"GET",
			"/artifacts/:id/backend",
			({ id }, _request, url) =>
				space.artifactRequest(url, async () => {
					const app = space.hostedApp(id!);
					return noStore({
						version: space.hosted.version(app.id) ?? null,
						status: await space.hosted.status(app.id),
						computer: space.computer.status().state,
						access: space.hosted.access(app.id),
						// Where the app is at an address of its own, when this Pim has one for apps.
						address: space.hosted.origin(space.name, app.id),
					});
				}),
		],
		[
			"GET",
			"/artifacts/:id/backend/logs",
			({ id }, _request, url) =>
				space.artifactRequest(url, async () => {
					const app = space.hostedApp(id!);
					// A backend that has never run has printed nothing.
					const text = await space.hosted.logs(app.id, 16_000).catch((error: unknown) => {
						if ((error as { code?: unknown }).code === "ENOENT") return "";
						throw error;
					});
					return noStore({ text });
				}),
		],
		[
			"POST",
			"/artifacts/:id/backend/stop",
			({ id }, _request, url) =>
				space.artifactRequest(url, async () => {
					space.assertOpen();
					await space.hosted.stop(space.hostedApp(id!).id);
					return noStore({ stopped: true });
				}),
		],
		[
			"POST",
			"/artifacts/:id/backend/run",
			({ id }, request, url) =>
				space.artifactRequest(url, async () => {
					// Running a version starts its program on the computer: only the person, in their browser, chooses that without an approval.
					if (request.headers.get(SIGNED_IN_HEADER) !== "1") throw new HttpError(403, "Only the person, signed in to Pim in their browser, can run an app's backend");
					space.assertOpen();
					const app = space.hostedApp(id!);
					const wanted = Number((await readJson<{ version?: unknown }>(request)).version);
					if (!Number.isInteger(wanted) || !space.artifacts.version(app.id, wanted)) throw new HttpError(404, `No version ${wanted} of app ${app.id}`);
					await space.hosted.run(app.id, wanted);
					return noStore({ running: wanted });
				}),
		],
		[
			"PUT",
			"/artifacts/:id/circles",
			({ id }, request, url) =>
				space.artifactRequest(url, async () => {
					const artifact = space.artifact(id!);
					if (artifact.kind === "hosted" && space.deployment().appsOrigin === null) {
						throw new HttpError(400, "An app with a backend is shared at an address of its own, which this Pim doesn't have: its admin sets PIM_APPS_ORIGIN.");
					}
					const { circles } = await readJson<{ circles: string[] }>(request);
					if (!Array.isArray(circles)) throw new HttpError(400, "circles must be a list of circle ids");
					for (const circle of circles) space.circle(String(circle));
					space.assertOpen();
					space.artifacts.setCircles(artifact.id, circles.map(String));
					return noStore({ ...space.publicSession(space.artifacts.get(artifact.id)!), circles: space.artifacts.circlesOf(artifact.id) });
				}),
		],
		// Apps others shared with this person, from their spaces, which check each request.
		[
			"GET",
			"/shared-artifacts",
			(_params, _request, url) =>
				space.artifactRequest(url, async () => {
					const me = space.me();
					const shared = [];
					for (const share of space.visits.shares().filter((candidate) => !candidate.revoked)) {
						if (me === null) break;
						try {
							const found = await (await space.pimOf(share.ownerId)).guestArtifacts(me);
							if (found.ok) shared.push(...found.artifacts.map((artifact) => ({ ...artifact, host: share.username })));
						} catch (error) {
							console.warn(`listing ${share.username}'s shared apps failed`, error);
						}
					}
					return noStore({ artifacts: shared.sort((a, b) => b.updatedAt - a.updatedAt) });
				}),
		],
		[
			"GET",
			"/shared-artifacts/:host/:id",
			({ host, id }, _request, url) =>
				space.artifactRequest(url, async () => {
					const { artifact, address } = await space.othersArtifact(host!, id!);
					return noStore({ ...artifact, host, address });
				}),
		],
		[
			"GET",
			"/shared-artifacts/:host/:id/versions/:version",
			({ host, id, version }, _request, url) =>
				space.artifactRequest(url, async () => {
					const { artifact, files, load } = await space.othersArtifact(host!, id!, version!);
					const content = fileText((await load()).get(ENTRY_FILES[artifact.kind])!.bytes);
					return noStore({ id: artifact.id, title: artifact.title, kind: artifact.kind, latest: artifact.version, version: artifact.version, sha256: artifact.sha256, size: artifact.size, files, content });
				}),
		],
		[
			"GET",
			"/shared-artifacts/:host/:id/versions/:version/frame",
			({ host, id, version }, _request, url) =>
				space.artifactRequest(url, async () => {
					const { artifact, load } = await space.othersArtifact(host!, id!, version!);
					return framePage(artifact.kind, await load(), url.origin, { thumbnail: url.searchParams.has("thumbnail") });
				}),
		],
		[
			"POST",
			"/shared-artifacts/:host/:id/versions/:version/bridge",
			({ host, id, version }, request, url) =>
				space.artifactRequest(url, async () => {
					const found = await space.othersArtifact(host!, id!, version!);
					const { op, args } = await readJson<{ op: string; args: Record<string, unknown> }>(request);
					const shared = async (call: string, input: Record<string, unknown>) => {
						const answer = (await found.host.guestArtifactShared(found.me, found.artifact.id, { op: call, args: input })) as
							| { ok: true; value: unknown }
							| { ok: false; status: number; reason: string };
						if (answer.ok) return answer.value;
						throw new HttpError(answer.status, answer.reason);
					};
					return noStore(await space.artifactBridge(found.key, found.artifact.sha256, op, args && typeof args === "object" ? args : {}, shared));
				}),
		],
		[
			"POST",
			"/shared-artifacts/:host/:id/versions/:version/grants",
			({ host, id, version }, request, url) =>
				space.artifactRequest(url, async () => {
					const found = await space.othersArtifact(host!, id!, version!);
					const { capability } = await readJson<{ capability: string }>(request);
					return noStore({ granted: space.grantArtifact(found.key, found.artifact.sha256, capability) }, 201);
				}),
		],
		[
			"GET",
			"/artifacts/:id/versions/:version/download",
			({ id, version }, _request, url) =>
				space.artifactRequest(url, async () => {
					const { artifact, found } = space.artifactVersion(id!, version!);
					const path = url.searchParams.get("path") ?? ENTRY_FILES[artifact.kind];
					const file = found.files.find((candidate) => candidate.path === path);
					if (!file) throw new HttpError(404, `Version ${found.version} has no file ${path}`);
					// Plain text, whatever the kind, or bytes to save: the file is for saving, and a browser that
					// shows it anyway shows its source, still under the sandbox. Its name keeps the extension.
					const headers = artifactHeaders(url.origin, isTextType(file.type) ? "text/plain; charset=utf-8" : "application/octet-stream");
					const { ascii, utf8 } = downloadName(artifact.title, found.version, artifact.kind, path === ENTRY_FILES[artifact.kind] ? undefined : path);
					headers.set("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`);
					return new Response((await space.artifacts.read(artifact.id, found.version, [path])).get(path)!.bytes, { headers });
				}),
		],
	];
}

/** The person's computer and its displays, their files, and the agents' browser. */
function computerAndFileRoutes(space: SpaceRouteHost): Route[] {
	return [
		// The person's computer (see ./computer.ts): whether one is connected, and pairing or removing their own.
		// Where this Pim has a computer host, the space's computer is the one it keeps, asked for the first time it's looked at.
		[
			"GET",
			"/computer",
			async () => {
				if (!space.computer.paired() && !space.closed() && (await space.directory().hasComputerHost())) await space.provideComputer();
				return noStore(space.computer.status());
			},
		],
		// The computer's per-thread displays, for the Computer view to list and take over (the desktop itself streams at /computer/screen?display=).
		[
			"GET",
			"/computer/displays",
			async () => {
				// displayd knows threads by the id the chat has inside the space; the app knows them by their public id, with a title.
				const shown = (one: ComputerDisplay) => ({ ...one, threadId: space.store.publicId(one.threadId), title: space.store.sessionInfo(one.threadId)?.title ?? null });
				const { displays, queue } = await space.computer.displays();
				return noStore({ displays: displays.map(shown), queue: queue.map(shown) });
			},
		],
		[
			"POST",
			"/computer/displays/control",
			async (_params, request) => {
				const { thread, mode } = (await request.json().catch(() => ({}))) as { thread?: unknown; mode?: unknown };
				if (typeof thread !== "string" || !thread) throw new HttpError(400, "thread must name the thread whose display to take over");
				if (mode !== "user" && mode !== "agent") throw new HttpError(400, "mode must be 'user' or 'agent'");
				const inside = space.store.sessionOf(thread) ?? thread;
				const done = await space.computer.displayControl(inside, mode);
				space.displayControl.set(inside, { control: done.control, at: Date.now() });
				return noStore(done);
			},
		],
		[
			"POST",
			"/computer",
			async (_params, request) => {
				space.assertOpen();
				const body = await request.text();
				const { managed } = (body ? JSON.parse(body) : {}) as { managed?: unknown };
				// Asking for the host's computer again sets it up again, as after it failed to be.
				if (managed === true) {
					if (!(await space.directory().hasComputerHost())) throw new HttpError(404, "This Pim has no computer host to keep a computer for you. Connect one of your own.");
					await space.provideComputer();
					return noStore(space.computer.status(), 201);
				}
				if (space.computer.machine() || (await space.directory().hasComputerHost())) {
					throw new HttpError(409, "This Pim keeps a computer for you, so you can't connect another.");
				}
				const token = await space.computer.pair(space.name, Date.now());
				space.computerChanged();
				return noStore({ ...space.computer.status(), token }, 201);
			},
		],
		[
			"DELETE",
			"/computer",
			async () => {
				if (space.computer.machine()) throw new HttpError(409, "This Pim keeps this computer for you for as long as you're here: it can't be removed.");
				space.computer.forget();
				space.computerChanged();
				return noStore(space.computer.status());
			},
		],
		// Files: the person's, on their computer, which their agents read and write too (see ./files.ts).
		["GET", "/files", (_params, _request, url) => space.artifactRequest(url, async () => noStore(await space.files.list(url.searchParams.get("path") ?? FILES_ROOT)))],
		[
			"GET",
			"/files/content",
			(_params, request, url) =>
				space.artifactRequest(url, async () => {
					// A guest has no files: the images their bot made are in its author's, where only this guest's folder is theirs to read.
					const guest = space.guestBot();
					if (guest?.owner !== undefined) {
						const image = await (await space.pimOf(guest.owner)).botImage(guest.bot, space.name, url.searchParams.get("path") ?? "");
						if (!image) throw new HttpError(404, "No such image");
						return new Response(image.bytes, { headers: fileHeaders({ name: image.name, size: image.bytes.byteLength, type: image.type }, url.searchParams.has("download")) });
					}
					const path = url.searchParams.get("path");
					const whole = await space.files.read(path);
					const validators: Record<string, string> = whole.sha256 === null ? {} : { etag: etagOf(whole.sha256), "x-file-sha256": whole.sha256 };
					if (whole.sha256 !== null && !request.headers.has("range") && etags(request.headers.get("if-none-match")).some((tag) => tag === "*" || tag === whole.sha256)) {
						await whole.body.cancel();
						return new Response(null, { status: 304, headers: validators });
					}
					// A video's playbar seeks with a Range request; answering it with the whole file makes the player snap back.
					const range = byteRange(request.headers.get("range"), whole.size);
					if (range === "unsatisfiable") {
						await whole.body.cancel();
						return new Response(null, { status: 416, headers: { "content-range": `bytes */${whole.size}` } });
					}
					if (!range) {
						const headers = fileHeaders(whole, url.searchParams.has("download"));
						for (const [name, value] of Object.entries(validators)) headers.set(name, value);
						return new Response(whole.body, { headers });
					}
					await whole.body.cancel();
					const part = await space.files.read(path, range);
					const headers = fileHeaders({ ...part, size: range.end - range.start + 1 }, url.searchParams.has("download"));
					for (const [name, value] of Object.entries(validators)) headers.set(name, value);
					headers.set("content-range", `bytes ${range.start}-${range.end}/${part.size}`);
					return new Response(part.body, { status: 206, headers });
				}),
		],
		// A file's validators without its bytes: ETag and X-File-Sha256 (past 5 MiB, none), X-File-Size and X-File-Mtime.
		[
			"HEAD",
			"/files/content",
			(_params, _request, url) =>
				space.artifactRequest(url, async () => {
					if (space.guestBot()?.owner !== undefined) throw new HttpError(404, "No such file");
					const stat = await space.files.stat(url.searchParams.get("path"));
					const headers = new Headers({ "x-file-size": String(stat.size), "x-file-mtime": String(stat.mtime), "cache-control": "no-store, private" });
					if (stat.sha256 !== null) {
						headers.set("etag", etagOf(stat.sha256));
						headers.set("x-file-sha256", stat.sha256);
					}
					return new Response(null, { headers });
				}),
		],
		[
			"PUT",
			"/files/content",
			(_params, request, url) =>
				space.artifactRequest(url, async () => {
					space.assertOpen();
					const tooLarge = `A file can be at most ${MAX_UPLOAD_BYTES} bytes`;
					if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) throw new HttpError(413, tooLarge);
					const body = new Uint8Array(await request.arrayBuffer());
					if (body.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, tooLarge);
					// `If-Match` writes only over a file with that hash; `If-None-Match: *` only where there is none. Neither: over whatever is there.
					const match = etags(request.headers.get("if-match"));
					const none = etags(request.headers.get("if-none-match"));
					if (match.length > 1 || (match.length === 1 && !/^[0-9a-f]{64}$/.test(match[0]!))) throw new HttpError(400, "If-Match must be one file hash, as the ETag a read gave");
					if (none.length > 0 && !(none.length === 1 && none[0] === "*")) throw new HttpError(400, "If-None-Match must be * on a write");
					if (match.length > 0 && none.length > 0) throw new HttpError(400, "Send If-Match or If-None-Match, not both");
					const expectedHash = match[0] ?? (none.length > 0 ? "absent" : undefined);
					// Files are on the person's computer, so they don't count toward the space's storage.
					const written = await space.files.write(url.searchParams.get("path"), body, expectedHash === undefined ? {} : { expectedHash });
					const response = noStore(written);
					if (written.sha256 !== null) response.headers.set("etag", etagOf(written.sha256));
					return response;
				}),
		],
		[
			"DELETE",
			"/files",
			(_params, _request, url) =>
				space.artifactRequest(url, async () => {
					space.assertOpen();
					await space.files.remove(url.searchParams.get("path"));
					return noStore({ deleted: true });
				}),
		],
		// The agents' browser (see ./browser.ts): what a chat's window shows, a picture of it, closing it. Taking it over is a socket.
		[
			"GET",
			"/browser",
			async (_params, _request, url) =>
				noStore({ available: space.browser.available, page: space.browser.available ? await space.browser.current(await space.browserWindow(url)) : null }),
		],
		[
			"GET",
			"/browser/screenshot",
			async (_params, _request, url) => {
				const png = await space.browserIn().screenshot(await space.browserWindow(url));
				if (!png) throw new HttpError(404, "The browser is closed");
				return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-store, private", "x-content-type-options": "nosniff" } });
			},
		],
		[
			"DELETE",
			"/browser",
			async (_params, _request, url) => {
				await space.browserIn().close(await space.browserWindow(url));
				return noStore({ closed: true });
			},
		],
		[
			"GET",
			"/export",
			async () =>
				new Response(await space.exportData(), {
					headers: {
						"content-type": "application/json",
						"content-disposition": `attachment; filename="pim-export-${new Date().toISOString().slice(0, 10)}.json"`,
					},
				}),
		],
		["GET", "/chatgpt", () => space.chatgpt.status()],
		["POST", "/chatgpt/login", () => space.chatgpt.startLogin()],
		[
			"POST",
			"/chatgpt/callback",
			async (_params, request) => {
				const { url } = await readJson<{ url: string }>(request);
				if (typeof url !== "string" || url.trim() === "") throw new HttpError(400, "url must be the address the browser landed on");
				return space.chatgpt.finishLogin(url);
			},
		],
		[
			"DELETE",
			"/chatgpt",
			async () => {
				await space.chatgpt.logout();
				// Sessions on the plan would fail without it: back to the default.
				space.dropModels(({ provider }) => provider === CHATGPT_PROVIDER);
				if (space.chosenModel().provider === CHATGPT_PROVIDER) await space.chooseModel(null);
				else await space.syncModels();
				return space.chatgpt.status();
			},
		],
		["GET", "/chatgpt/images", () => space.codexImages.status()],
		["POST", "/chatgpt/images/login", () => space.codexImages.startLogin()],
		[
			"POST",
			"/chatgpt/images/callback",
			async (_params, request) => {
				const { url } = await readJson<{ url: string }>(request);
				if (typeof url !== "string" || url.trim() === "") throw new HttpError(400, "url must be the address the browser landed on");
				const status = await space.codexImages.finishLogin(url);
				space.imagesChanged();
				return status;
			},
		],
		[
			"DELETE",
			"/chatgpt/images",
			async () => {
				await space.codexImages.logout();
				space.imagesChanged();
				return space.codexImages.status();
			},
		],
	];
}

/** Memory and its scopes, goals, and the background work an agent scheduled. */
function memoryAndGoalRoutes(space: SpaceRouteHost): Route[] {
	return [
		// Long-term memory: what the agents know about the person, in scopes that different agents read. They can always make it forget.
		[
			"GET",
			"/memory",
			() => ({
				count: space.memory.store.count(),
				pendingCompressions: space.memory.store.pending().length,
				// The majordomo's view: every scope.
				view: space.memory.view(space.memoryAccess(space.agents.majordomo()).read),
				scopes: space.memoryScopes(),
			}),
		],
		[
			"GET",
			"/memory/log",
			(_params, _request, url) => {
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
				const scope = url.searchParams.get("scope");
				const scopes = scope === null ? undefined : [space.memoryScope(scope).key];
				const pattern = url.searchParams.get("q");
				if (pattern !== null) {
					let regex: RegExp;
					try {
						regex = new RegExp(pattern, "i");
					} catch (error) {
						throw new HttpError(400, errorMessage(error));
					}
					return space.memory.store.search(regex, limit, scopes);
				}
				const before = url.searchParams.get("before");
				return { entries: space.memory.store.page(limit, before === null ? undefined : Number(before), scopes) };
			},
		],
		[
			"POST",
			"/memory/log",
			async (_params, request) => {
				const { text, scope } = await readJson<{ text: string; scope?: string }>(request);
				const line = typeof text === "string" ? text.trim() : "";
				if (line === "" || /[\r\n]/.test(line)) throw new HttpError(400, "text must be one non-empty line");
				if (byteLength(line) > ENTRY_BYTES) throw new HttpError(400, `text is limited to ${ENTRY_BYTES} bytes`);
				if (scope !== undefined && typeof scope !== "string") throw new HttpError(400, "scope must be a memory scope's key");
				const entry = space.memory.store.append(line, space.memory.today(), { scope: scope === undefined ? PRIVATE_SCOPE : space.memoryScope(scope).key });
				await space.startMemoryNap();
				return Response.json(entry, { status: 201 });
			},
		],
		[
			"PUT",
			"/memory/log/:id",
			async ({ id }, request) => {
				// Moving a memory to another scope: it gets a new id there.
				const { scope } = await readJson<{ scope: string }>(request);
				const entry = /^\d+$/.test(id!) ? space.memory.store.entry(Number(id)) : undefined;
				if (!entry) throw new HttpError(404, `No memory ${id}`);
				if (typeof scope !== "string") throw new HttpError(400, "scope must be a memory scope's key");
				const target = space.memoryScope(scope).key;
				if (entry.forgotten) throw new HttpError(409, `Memory ${id} was forgotten`);
				if (target === entry.scope) return entry;
				const moved = space.memory.store.move(entry.id, target);
				await space.startMemoryNap();
				return moved;
			},
		],
		[
			"DELETE",
			"/memory/log/:id",
			async ({ id }) => {
				if (!/^\d+$/.test(id!) || !space.memory.store.forget(Number(id))) throw new HttpError(404, `No memory ${id}`);
				await space.startMemoryNap();
				return { forgotten: Number(id) };
			},
		],
		[
			"GET",
			"/memory/tree/:scope/:block",
			({ scope, block: name }) => {
				const block = parseBlock(name!);
				if (!block) throw new HttpError(400, `${name} is not a block, like 16-31`);
				if (block[0] >= space.memory.store.size(scope!)) throw new HttpError(404, `No memories in ${scope}/${name}`);
				return {
					block: blockName(block),
					summary: space.memory.store.summary(scope!, block) ?? null,
					halves: halves(block).map((half) => {
						if (half[1] - half[0] > 1) return { block: blockName(half), summary: space.memory.store.summary(scope!, half) ?? null };
						const entry = space.memory.store.at(scope!, half[0]);
						return { block: String(half[0]), line: entry ? entryLine(entry) : null };
					}),
				};
			},
		],
		[
			"DELETE",
			"/memory/tree/:scope/:block",
			async ({ scope, block: name }) => {
				const block = parseBlock(name!);
				if (!block) throw new HttpError(400, `${name} is not a block, like 16-31`);
				const dropped = space.memory.store.dropSummary(scope!, block);
				if (dropped === 0) throw new HttpError(404, `No summary ${scope}/${name}`);
				await space.startMemoryNap();
				return { dropped };
			},
		],
		// Named memory scopes: ones the person makes, such as Work, for the agents and circles they choose.
		[
			"POST",
			"/memory/scopes",
			async (_params, request) => {
				const name = scopeName((await readJson<{ name: string }>(request)).name);
				if (space.memory.store.namedScopes().length >= MAX_NAMED_SCOPES) throw new HttpError(429, `You can have up to ${MAX_NAMED_SCOPES} named memory scopes.`);
				const { key } = space.memory.store.createScope(name);
				return Response.json(space.memoryScope(key), { status: 201 });
			},
		],
		[
			"PUT",
			"/memory/scopes/:key",
			async ({ key }, request) => {
				if (space.memoryScope(key!).kind !== "named") throw new HttpError(400, "Only a scope you named can be renamed");
				space.memory.store.renameScope(key!, scopeName((await readJson<{ name: string }>(request)).name));
				return space.memoryScope(key!);
			},
		],
		[
			"DELETE",
			"/memory/scopes/:key",
			async ({ key }) => {
				// Its memories stay, and only the majordomo reads them, until the person moves or forgets them.
				if (space.memoryScope(key!).kind !== "named") throw new HttpError(400, "Only a scope you named can be deleted");
				space.memory.store.deleteScope(key!);
				space.agents.dropMemoryScope(key!);
				space.circles.dropMemoryScope(key!);
				return { deleted: true };
			},
		],
		// Goals and their plans.
		[
			"GET",
			"/goals",
			(_params, _request, url) => {
				const status = url.searchParams.get("status");
				if (status !== null && !GOAL_STATUSES.includes(status as GoalStatus)) {
					throw new HttpError(400, `status must be one of ${GOAL_STATUSES.join(", ")}`);
				}
				return { goals: space.store.goals(status === null ? undefined : (status as GoalStatus)).map((goal) => space.publicSession(goal)) };
			},
		],
		[
			"GET",
			"/goals/:id",
			({ id }) => {
				const goal = space.store.goal(id!);
				if (!goal) throw new HttpError(404, `No goal ${id}`);
				return space.publicSession(goal);
			},
		],
		[
			"DELETE",
			"/goals/:id",
			({ id }) => {
				if (!space.store.deleteGoal(id!)) throw new HttpError(404, `No goal ${id}`);
				return { deleted: true };
			},
		],
		// Background work the agent scheduled for itself.
		[
			"GET",
			"/schedules",
			() => ({ schedules: space.scheduledTasks() }),
		],
		[
			"DELETE",
			"/schedules/:id",
			async ({ id }) => {
				const api = space.triggerApi();
				if (api === null || !(await cancelTask(api, PERSON, id!))) throw new HttpError(404, `No schedule ${id}`);
				return { deleted: true };
			},
		],
	];
}

/** Approvals and tool permissions. */
function approvalRoutes(space: SpaceRouteHost): Route[] {
	return [
		// Approvals: actions waiting for the person's decision.
		[
			"GET",
			"/approvals",
			(_params, _request, url) => {
				const status = url.searchParams.get("status");
				if (status !== null && !["pending", "approved", "denied"].includes(status)) {
					throw new HttpError(400, "status must be pending, approved or denied");
				}
				return { approvals: space.store.approvals((status ?? undefined) as Approval["status"] | undefined).map((approval) => space.publicApproval(approval)) };
			},
		],
		[
			"GET",
			"/approvals/:id",
			({ id }) => {
				const approval = space.store.approval(id!);
				if (!approval) throw new HttpError(404, `No approval ${id}`);
				return space.publicApproval(approval);
			},
		],
		[
			"GET",
			"/approvals/:id/icon",
			async ({ id }) => {
				const approval = space.store.approval(id!);
				if (approval?.action !== UPDATE_AGENT) throw new HttpError(404, `No approval ${id} with an icon`);
				const { type, bytes } = await requestedIcon(approval.args, space.files);
				return new Response(bytes, { headers: { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" } });
			},
		],
		[
			"POST",
			"/approvals/:id/approve",
			async ({ id }, request) => {
				if (space.store.approval(id!)?.action === ADD_CUSTOM_CONNECTOR && request.headers.get(SIGNED_IN_HEADER) !== "1") {
					throw new HttpError(403, "Adding a connector to this Pim needs you signed in to the app.");
				}
				const { note, always } = await readJson<{ note: string; always: boolean }>(request);
				const given = typeof note === "string" ? note : undefined;
				return space.publicApproval(always === true ? await space.alwaysApprove(id!, given) : await space.decideApproval(id!, "approve", given));
			},
		],
		[
			"POST",
			"/approvals/:id/deny",
			async ({ id }, request) => {
				const { note } = await readJson<{ note: string }>(request);
				return space.publicApproval(await space.decideApproval(id!, "deny", typeof note === "string" ? note : undefined));
			},
		],
		// Tool permissions: which tools Pim may use, and which ask first.
		[
			"GET",
			"/permissions",
			(_params, _request, url) => {
				// One of the owner's agents: the switches of its connectors' tools, and its switch for skills.
				const agent = url.searchParams.get("agent");
				if (agent !== null) {
					const found = space.agent(agent);
					return { tools: space.agentToolPermissions(found), skills: space.agentSkillsPermission(found) };
				}
				const circle = url.searchParams.get("circle");
				if (circle !== null) space.circle(circle);
				return { tools: space.toolPermissions(circle ?? OWNER) };
			},
		],
		[
			"PUT",
			"/permissions",
			async (_params, request) => {
				const { agent, circle, app, tool, permission } = await readJson<{
					agent: string | null;
					circle: string | null;
					app: string | null;
					tool: string;
					permission: ToolPermission | null;
				}>(request);
				if (agent !== null && agent !== undefined) {
					if (typeof agent !== "string") throw new HttpError(400, "agent must be an agent's id");
					if (typeof app !== "string" || typeof tool !== "string") throw new HttpError(400, "app and tool name a connector's tool");
					if (permission !== null && permission !== "on" && permission !== "off") throw new HttpError(400, "permission must be on, off, or null for the default");
					return space.setAgentToolPermission(space.agent(agent), app, tool, permission);
				}
				if (circle !== null && circle !== undefined && typeof circle !== "string") throw new HttpError(400, "circle must be a circle's id");
				if (app !== null && app !== undefined && (typeof app !== "string" || app === "")) {
					throw new HttpError(400, "app must be a connector's id, or null for Pim's own tools");
				}
				if (typeof tool !== "string" || tool === "") throw new HttpError(400, "tool is required");
				if (permission === undefined || (permission !== null && !TOOL_PERMISSIONS.includes(permission))) {
					throw new HttpError(400, `permission must be one of ${TOOL_PERMISSIONS.join(", ")}, or null for the default`);
				}
				return space.setToolPermission(circle ?? OWNER, app ?? "", tool, permission);
			},
		],
	];
}

/** Agents, the majordomo, and skills. */
function agentAndSkillRoutes(space: SpaceRouteHost): Route[] {
	return [
		// The owner's agents, the majordomo first.
		["GET", "/agents", () => ({ agents: space.agents.list() })],
		// What of an agent's the owner can share with a bot's guests, to run here as the owner.
		[
			"GET",
			"/agents/:id/bot-tools",
			async ({ id }) => {
				await space.refreshCustomApps();
				return { tools: space.shareableTools(space.agent(id!)) };
			},
		],
		// The majordomo, and whether it has opened the person's first chat yet.
		[
			"GET",
			"/majordomo",
			() => {
				const agent = space.agents.majordomo();
				return { agent, introduced: space.agents.introduced(), preferences: majordomoPreferences(agent.instructions), yourName: space.store.meta(PERSON_NAME_KEY) ?? null };
			},
		],
		[
			"PUT",
			"/majordomo/preferences",
			async (_params, request) => {
				// How it talks and how much it handles on its own, as its page sets them: lines of its instructions, in place of those it had.
				const majordomo = space.agents.majordomo();
				const instructions = withPreferences(majordomo.instructions, await readJson<Record<string, unknown>>(request));
				const agent = space.agents.update(majordomo.id, agentInput({ instructions }, majordomo));
				return { agent, introduced: space.agents.introduced(), preferences: majordomoPreferences(agent.instructions), yourName: space.store.meta(PERSON_NAME_KEY) ?? null };
			},
		],
		[
			"POST",
			"/majordomo",
			async (_params, request) => {
				// The first time the person opens Pim: their majordomo opens the main chat, where they set it up by talking with it.
				const start = majordomoStart(await readJson<Record<string, unknown>>(request));
				const session = space.store.publicId(ROOT_SESSION);
				// Once; checked and marked before anything awaits, so a second tab doesn't start it again.
				if (space.agents.introduced()) return { agent: space.agents.majordomo(), introduced: true, session };
				space.agents.introduce();
				// Their name, as they gave it when they joined, or as the account they joined with says it:
				// one agents can mention them by, which every agent remembers.
				const yourName = space.store.meta(PERSON_NAME_KEY) ?? start.yourName;
				if (yourName) {
					space.store.setMeta(PERSON_NAME_KEY, yourName);
					space.memory.store.append(`Their name is ${yourName}.`, space.memory.today(), { scope: EVERYONE_SCOPE });
					await space.startMemoryNap();
				}
				const title = start.title ?? (yourName ? `Welcome, ${yourName}` : "Welcome");
				space.store.renameSession(ROOT_SESSION, title);
				try {
					await space.submitTo(ROOT_SESSION, introduction(space.agents.majordomo(), { ...start, yourName }), { operationId: "introduction" }, "pim");
				} catch (error) {
					console.warn("the majordomo's introduction failed", error);
				}
				return { agent: space.agents.majordomo(), introduced: true, session };
			},
		],
		["GET", "/agents/:agent", ({ agent }) => space.agent(agent!)],
		[
			"POST",
			"/agents",
			async (_params, request) => {
				const input = space.checkSkills(space.checkApps(agentInput(await readJson<Record<string, unknown>>(request))));
				space.checkNamedScopes(input.memoryScopes ?? []);
				const agent = space.agents.create(checkContacts(null, input, space.agents.list()));
				return Response.json(agent, { status: 201 });
			},
		],
		[
			"PUT",
			"/agents/:agent",
			async ({ agent: id }, request) => {
				const agent = space.agent(id!);
				const input = space.checkSkills(space.checkApps(agentInput(await readJson<Record<string, unknown>>(request), agent)));
				space.checkNamedScopes(input.memoryScopes ?? []);
				return space.agents.update(id!, checkContacts(agent, input, space.agents.list()));
			},
		],
		// The model an agent runs on, from `GET /model`'s choices; null follows the space's.
		[
			"PUT",
			"/agents/:agent/model",
			async ({ agent: id }, request) => {
				const agent = space.agent(id!);
				const { provider, id: model } = (await readJson<{ provider: string | null; id: string | null }>(request)) ?? {};
				if (provider === null && model === null) return space.chooseAgentModel(agent, null);
				if (typeof provider !== "string" || typeof model !== "string") throw new HttpError(400, "provider and id must be strings, or both null");
				return space.chooseAgentModel(agent, await space.choice(provider, model));
			},
		],
		// The models an agent moves on to, in order, when its own fails for good, from `GET /model`'s choices.
		[
			"PUT",
			"/agents/:agent/fallbacks",
			async ({ agent: id }, request) => {
				const agent = space.agent(id!);
				const { models } = (await readJson<{ models: { provider: string; id: string }[] }>(request)) ?? {};
				if (!Array.isArray(models) || models.some((model) => typeof model?.provider !== "string" || typeof model.id !== "string")) {
					throw new HttpError(400, "models must be a list of provider and id");
				}
				return space.chooseAgentFallbacks(agent, await Promise.all(models.map((model) => space.choice(model.provider, model.id))));
			},
		],
		// Skills the agents wrote, with the person's approval, every version kept; each agent lists the ones it uses.
		[
			"GET",
			"/skills",
			() => ({
				skills: space.skills.list().map((skill) => ({ ...skill, agents: space.skillAgents(skill.name) })),
			}),
		],
		["GET", "/skills/:name", ({ name }) => space.describeSkill(space.skill(name!).name)],
		[
			"GET",
			"/skills/:name/versions/:version",
			({ name, version }) => {
				const found = VERSION.test(version!) ? space.skills.version(space.skill(name!).name, Number(version)) : undefined;
				if (!found) throw new HttpError(404, `No version ${version} of the skill ${name}`);
				return found;
			},
		],
		// A supporting file's bytes, to show or, with `download`, to save.
		[
			"GET",
			"/skills/:name/versions/:version/file",
			({ name, version }, _request, url) =>
				space.artifactRequest(url, async () => {
					const skill = space.skill(name!);
					if (!VERSION.test(version!) || !space.skills.version(skill.name, Number(version))) throw new HttpError(404, `No version ${version} of the skill ${name}`);
					const { file, bytes } = await space.skills.read(skill.name, Number(version), url.searchParams.get("path") ?? "");
					const type = isTextType(file.type) ? `${file.type}; charset=utf-8` : file.type;
					return new Response(bytes, { headers: fileHeaders({ name: file.path.slice(file.path.lastIndexOf("/") + 1), size: file.size, type }, url.searchParams.has("download")) });
				}),
		],
		[
			"POST",
			"/skills/:name/restore",
			async ({ name }, request) => {
				const skill = space.skill(name!);
				const { version, baseVersion } = await readJson<{ version: number; baseVersion: number }>(request);
				if (!Number.isSafeInteger(version) || !Number.isSafeInteger(baseVersion)) {
					throw new HttpError(400, "version and baseVersion must be version numbers");
				}
				await space.skills.restore(skill.name, version!, baseVersion!);
				return Response.json(space.describeSkill(skill.name), { status: 201 });
			},
		],
		[
			"DELETE",
			"/skills/:name",
			async ({ name }) => {
				const skill = space.skill(name!);
				for (const agent of space.agents.list().filter((candidate) => candidate.skills.includes(skill.name))) {
					space.agents.update(agent.id, agentInput({ skills: agent.skills.filter((other) => other !== skill.name) }, agent));
				}
				await space.skills.delete(skill.name);
				return { deleted: skill.name };
			},
		],
	];
}

/** What a model provider fetches, circles, and visits. */
function sharingRoutes(space: SpaceRouteHost): Route[] {
	return [
		// What a model provider fetches; the signature, not the API token, lets it in.
		[
			"GET",
			"/public-images/:image",
			async ({ image }, _request, url) => {
				const found = await space.images.readSigned(image!, url);
				if (!found) throw new HttpError(404, "No such image");
				return new Response(found.body, {
					headers: { "content-type": found.type, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" },
				});
			},
		],
		[
			"GET",
			"/images/:image",
			async ({ image }, request) => {
				const name = /^([\w-]+)(?:\.(mp4|webm))?$/.exec(image!);
				const found = name && (await space.images.read(name[1]!, name[2], request.headers.get("range")));
				if (!found) throw new HttpError(404, "No such image");
				const headers: Record<string, string> = {
					"x-content-type-options": "nosniff",
					"content-security-policy": "default-src 'none'; sandbox",
					"cross-origin-resource-policy": "same-origin",
					"referrer-policy": "no-referrer",
					"accept-ranges": "bytes",
				};
				if ("unsatisfiable" in found) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${found.unsatisfiable}` } });
				headers["content-type"] = found.type;
				headers["cache-control"] = "private, max-age=31536000, immutable";
				const { range } = found;
				if (!range) return new Response(found.body, { headers: { ...headers, "content-length": String(found.size) } });
				headers["content-length"] = String(range.end - range.start + 1);
				headers["content-range"] = `bytes ${range.start}-${range.end}/${found.size}`;
				return new Response(found.body, { status: 206, headers });
			},
		],
		[
			"GET",
			"/agents/:agent/icon",
			({ agent: id }) => {
				space.agent(id!);
				const icon = space.agents.icon(id!);
				if (!icon) throw new HttpError(404, "This agent has no icon");
				return new Response(icon.data, {
					headers: { "content-type": icon.type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" },
				});
			},
		],
		[
			"PUT",
			"/agents/:agent/icon",
			async ({ agent: id }, request) => {
				space.agent(id!);
				const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
				space.agents.setIcon(id!, type, await request.arrayBuffer());
				return space.agent(id!);
			},
		],
		[
			"DELETE",
			"/agents/:agent/icon",
			({ agent: id }) => {
				space.agent(id!);
				space.agents.removeIcon(id!);
				return space.agent(id!);
			},
		],
		[
			"GET",
			"/sessions/:session/suggestions",
			async ({ session }, _request, url) => {
				const id = await space.session(session!);
				const agent = space.agents.ofSession(id);
				return { suggestions: (await space.suggestions(agent, id, url.searchParams.get("locale") ?? "en")).slice(0, MAX_SUGGESTIONS) };
			},
		],
		[
			"GET",
			"/extensions",
			() => ({
				extensions: space.extensions.list().map((extension) => ({
					id: extension.id,
					name: extension.name,
					description: extension.description,
					widgets: Object.keys(extension.widgets ?? {}).map((widget) => `${extension.id}/${widget}`),
				})),
				logo: space.pimConfig().logo ?? null,
			}),
		],
		[
			"DELETE",
			"/agents/:agent",
			async ({ agent: id }) => {
				space.agent(id!);
				// Its tasks stop with it: no other agent takes them over. It leaves the contacts of the agents that had it.
				for (const task of space.tasks.open()) if (task.agent === id) await space.cancelTask(task, "Its agent was deleted.");
				space.agents.delete(id!);
				space.store.clearAudience(agentAudience(id!));
				return { deleted: true };
			},
		],
		// Circles: who may message this space from their own, and what each circle may use.
		["GET", "/circles", () => ({ circles: space.describeCircles() })],
		[
			"POST",
			"/circles",
			async (_params, request) => {
				const name = circleName((await readJson<{ name: string }>(request)).name);
				if (space.circles.circles().length >= MAX_CIRCLES) throw new HttpError(429, `You can have up to ${MAX_CIRCLES} circles.`);
				const circle = space.circles.createCircle(name);
				return Response.json(space.describeCircles().find((candidate) => candidate.id === circle.id), { status: 201 });
			},
		],
		[
			"PUT",
			"/circles/:circle",
			async ({ circle }, request) => {
				space.circle(circle!);
				const { name, enabled, memoryScopes } = await readJson<{ name: string; enabled: boolean; memoryScopes: string[] }>(request);
				if (enabled !== undefined && typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
				if (memoryScopes !== undefined) {
					if (!Array.isArray(memoryScopes) || memoryScopes.some((key) => typeof key !== "string")) throw new HttpError(400, "memoryScopes must be a list of memory scopes' keys");
					space.checkNamedScopes(memoryScopes.filter((key) => key !== EVERYONE_SCOPE));
				}
				space.circles.updateCircle(circle!, {
					...(name !== undefined ? { name: circleName(name) } : {}),
					...(enabled !== undefined ? { enabled } : {}),
					...(memoryScopes !== undefined ? { memoryScopes: [...new Set(memoryScopes)] } : {}),
				});
				return space.describeCircles().find((candidate) => candidate.id === circle);
			},
		],
		[
			"DELETE",
			"/circles/:circle",
			async ({ circle }) => {
				space.circle(circle!);
				const members = space.circles.deleteCircle(circle!);
				space.store.clearAudience(circle!);
				space.artifacts.forgetCircle(circle!);
				await space.tellRevoked(members.map((member) => member.ownerId));
				return { deleted: true };
			},
		],
		[
			"DELETE",
			"/circles/:circle/members/:member",
			async ({ circle, member }) => {
				space.circle(circle!);
				if (space.circles.member(member!)?.circle !== circle) throw new HttpError(404, `No member ${member} in circle ${circle}`);
				await space.removeCircleMember(member!);
				return { deleted: true };
			},
		],
		["GET", "/circles/activity", () => ({ activity: space.circles.activity() })],
		// Visits: spaces shared with this one's owner.
		[
			"GET",
			"/visits",
			() => ({
				visits: space.visits.shares().map((share) => ({
					ownerId: share.ownerId,
					username: share.username,
					sharedAt: share.sharedAt,
					available: !share.revoked,
					session: share.session !== null && !space.store.deletedSessions().has(share.session) ? space.store.publicId(share.session) : null,
				})),
			}),
		],
		["POST", "/visits/:username", async ({ username }) => ({ session: space.store.publicId(await space.startVisit(username!)) })],
	];
}

/** Built-in apps, connectors and their sign-ins, deliveries from connectors, web push and notifications. */
function connectorAndNotificationRoutes(space: SpaceRouteHost): Route[] {
	return [
		// The apps Pim brings that the admin left on.
		[
			"GET",
			"/builtin-apps",
			async () => {
				await space.refreshCustomApps(true);
				return { apps: BUILTIN_APPS.filter((app) => space.builtinOn(app.id)) };
			},
		],
		// The connectors people can connect, and the person's connections to them.
		[
			"GET",
			"/app-directory",
			async () => {
				await space.refreshCustomApps(true);
				return { apps: space.appDirectory() };
			},
		],
		["GET", "/mcp", () => ({ servers: space.describeApps() })],
		// Where the person comes back from signing in to a connector its extension implements: the Worker found this space by
		// its `state`, and posts what the service sent back (as a form) only from a browser signed in as this owner.
		[
			"POST",
			APPS_CALLBACK_PATH,
			async (_params, request) => {
				if (request.headers.get(SIGNED_IN_HEADER) !== "1") throw new HttpError(403, "Sign in to Pim in this browser first");
				const url = new URL(`${space.deployment().publicUrl}${APPS_CALLBACK_PATH}`);
				for (const [name, value] of await request.formData()) if (typeof value === "string") url.searchParams.append(name, value);
				const result = await space.nativeApps.finish(url);
				return "name" in result ? signInResultPage(true, space.deployment().publicUrl ?? undefined) : signInResultPage(false, space.deployment().publicUrl ?? undefined, result.error);
			},
		],
		// A connector's action, for the person in their own browser only (see `NativeAppDefinition.actions`), such as Drive's file picker.
		[
			"POST",
			"/app-actions/:extension/:app/:action",
			async ({ extension, app, action }, request) => {
				if (request.headers.get(SIGNED_IN_HEADER) !== "1") throw new HttpError(403, "Only the person, signed in to Pim in their browser, can do this");
				if (Number(request.headers.get("content-length") ?? 0) > 65_536) throw new HttpError(413, "Too large");
				const ref = `${extension}/${app}`;
				if (!space.appDirectory().some((candidate) => candidate.ref === ref)) {
					const definition = space.extensions.app(ref);
					const names = secretsOf(definition);
					const missing = names.filter((name) => !(name in space.env(names)));
					// Names of what its admin must set, never values.
					throw new HttpError(404, definition && missing.length > 0 ? `This Pim isn't set up for ${definition.name} yet: its admin must set ${missing.join(", ")}.` : `This Pim doesn't offer ${ref}`);
				}
				const input = await readJson<Record<string, unknown>>(request);
				try {
					const result = await space.nativeApps.act(ref, action!, input);
					return Response.json({ result: result ?? null }, { headers: { "cache-control": "no-store" } });
				} catch (error) {
					throw new HttpError(400, errorMessage(error));
				}
			},
		],
		[
			"POST",
			"/mcp",
			async (_params, request) => {
				const body = await readJson<{ app: string; approval: McpApproval }>(request);
				if (body.approval !== undefined && !MCP_APPROVALS.includes(body.approval)) {
					throw new HttpError(400, `approval must be one of ${MCP_APPROVALS.join(", ")}`);
				}
				await space.refreshCustomApps(true);
				const app = space.appDirectory().find((candidate) => candidate.ref === body.app);
				if (!app) throw new HttpError(400, "app must be the id of a connector this Pim offers");
				const result = await space.connectApp(app, body.approval ? { approval: body.approval } : {});
				return Response.json(result, { status: 201 });
			},
		],
		[
			"PUT",
			"/mcp/:id",
			async ({ id }, request) => {
				if (!space.apps.servers().some((server) => server.id === id)) throw new HttpError(404, `No connector ${id}`);
				const { approval } = await readJson<{ approval: McpApproval }>(request);
				if (!MCP_APPROVALS.includes(approval as McpApproval)) {
					throw new HttpError(400, `approval must be one of ${MCP_APPROVALS.join(", ")}`);
				}
				space.store.setMcpApproval(id!, approval!);
				space.installApps();
				return space.describeApps().find((server) => server.id === id);
			},
		],
		[
			"DELETE",
			"/mcp/:id",
			async ({ id }) => {
				if (!space.apps.servers().some((server) => server.id === id)) throw new HttpError(404, `No connector ${id}`);
				// Unsubscribed while the connector can still be asked.
				await space.stopConnectorTriggers((source) => source.connectorId === id);
				await space.disconnect(id!);
				space.catalog.forget(id!);
				space.installApps();
				return { deleted: true };
			},
		],
		[
			"GET",
			"/mcp/:id/skills",
			({ id }) => {
				if (!space.apps.servers().some((server) => server.id === id)) throw new HttpError(404, `No connector ${id}`);
				return { skills: space.catalog.skills(id!) };
			},
		],
		[
			"GET",
			"/mcp/:id/events",
			({ id }) => {
				if (!space.apps.servers().some((server) => server.id === id)) throw new HttpError(404, `No connector ${id}`);
				return { events: space.catalog.events(id!) };
			},
		],
		// Deliveries from connectors; authenticated by their Standard Webhooks signature, not the API token.
		["POST", "/mcp/events/:key", ({ key }, request) => space.receiveConnectorEvent(key!, request)],
		// Web Push: the key a browser subscribes with, and the subscription it gets.
		["GET", "/push/key", async () => ({ publicKey: (await space.vapidKeys()).publicKey })],
		[
			"PUT",
			"/push/subscription",
			async (_params, request) => {
				const subscription = await readJson<PushSubscription>(request);
				if (!validSubscription(subscription)) throw new HttpError(400, "Body must be a push subscription: https endpoint, p256dh and auth");
				space.store.putPushSubscription(subscription);
				return { subscribed: true };
			},
		],
		[
			"DELETE",
			"/push/subscription",
			async (_params, request) => {
				const { endpoint } = await readJson<{ endpoint: string }>(request);
				if (typeof endpoint !== "string") throw new HttpError(400, "Body must have an endpoint");
				space.store.deletePushSubscription(endpoint);
				return { subscribed: false };
			},
		],
		// Notifications the agent sent.
		[
			"GET",
			"/notifications",
			(_params, _request, url) => ({
				notifications: space.store.notifications({ unread: url.searchParams.get("unread") === "true" }).map((notification) => space.publicNotification(notification)),
			}),
		],
		[
			"POST",
			"/notifications/:id/read",
			({ id }) => {
				if (!space.store.notification(id!)) throw new HttpError(404, `No notification ${id}`);
				space.store.markNotificationRead(id!);
				return space.publicNotification(space.store.notification(id!)!);
			},
		],
	];
}

/** Every route of the space's API, in the order they are matched. */
export function spaceRoutes(space: SpaceRouteHost): readonly Route[] {
	return [
		...chatRoutes(space),
		...modelAndSettingsRoutes(space),
		...appRoutes(space),
		...computerAndFileRoutes(space),
		...memoryAndGoalRoutes(space),
		...approvalRoutes(space),
		...agentAndSkillRoutes(space),
		...sharingRoutes(space),
		...connectorAndNotificationRoutes(space),
	];
}
