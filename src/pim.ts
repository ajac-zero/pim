import { ActivityWatch, type Activity } from "./activity";
import { Workspace } from "@cloudflare/computer";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import { type AgentEventStream, type ConversationId, type UserInput, createRegistry, defineExtension, Harness, type HarnessSettings, type ModelRef, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { type AgentMcpOAuthProvider, Agent as DurableAgent, type Connection, type ConnectionContext, DurableObjectOAuthClientProvider, type WSMessage } from "agents";
import { type PiModel, PiHarness, type PiOperationResult, type PiReceipt } from "agents/harness/pi";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import { type ArtifactFile, type ArtifactKind, type ArtifactSummary, ArtifactStore } from "./artifacts";
import { Email, type Mailer } from "./email";
import { type CustomProvider, OWN_PROVIDER } from "./providers";
import { ImageStore, userInput } from "./images";
import { serveMcp } from "./mcp-server";
import { type Circle, CircleStore, type Guest, type Member } from "./circles";
import { CHATGPT_PROVIDER, ChatGPT, chatgptCredentials } from "./chatgpt";
import { ProviderCooldowns } from "./provider-cooldowns";
import { CodexImages } from "./codex-images";
import { SqlCredentialStore } from "./credentials";
import { AppCatalog } from "./extensions/app-catalog";
import { type SkillWriters, skillsExtension, writeSkillAction } from "./extensions/skills";
import { SkillStore } from "./skills";
import { approvalsExtension, type GatedAction, httpRequest } from "./extensions/approvals";
import pimConfig from "../pim.config";
import { artifactsExtension } from "./extensions/artifacts";
import { APP_DEPLOY, appDeployAction, hostedExtension } from "./extensions/hosted";
import { type CanvasAnswer, canvasExtension } from "./extensions/canvas";
import { type FileServices, fileDeleteAction, filesExtension, SHELL, shellAction } from "./extensions/files";
import { BROWSER_CLICK, BROWSER_EXTENSION, BROWSER_TYPE, BROWSER_UPLOAD, browserClickAction, browserExtension, browserTypeAction, browserUploadAction } from "./extensions/browser";
import { DESKTOP_ACT, DESKTOP_EXTENSION, desktopAction, desktopExtension } from "./extensions/desktop";
import { type BotTool, type BotToolCall, type BotToolResult } from "./extensions/bot-tools";
import { IMAGES_EXTENSION, type ImageModel, type ImageServices, imageGenerationExtension, workersAiImageModel } from "./extensions/image-generation";
import { appDirectory, type DirectoryApp } from "./extensions/app-directory";
import { ExtensionDataStore } from "./extensions/data";
import { NativeApps } from "./extensions/native-apps";
import { type Ability, APP_CREDENTIALS_KEY, checkToolNames, isNativeApp, type ToolWidget, type PimConfig, PimExtensions, shownWidgets, widgetMarkdown } from "./extensions/define";
import { chatsExtension } from "./extensions/chats";
import { goalsExtension, goalsWidgets } from "./extensions/goals";
import { type McpApproval, type McpBridge, type McpCapabilities, type McpResourceContent, mcpActions, serverFor, toolName } from "./extensions/mcp";
import { messagingExtension, plainReply, SEND_TO_USER } from "./extensions/messaging";
import { createOptMem, type MemoryAccess, type MemoryScope, memoryWidgets } from "./extensions/optmem";
import { byteLength, EVERYONE_SCOPE, PRIVATE_SCOPE } from "./extensions/optmem/store";
import { ADD_CUSTOM_CONNECTOR, addCustomAppAction, agentExtension, manageAppsAction, shareMemoryScopeAction, updateAgentAction } from "./extensions/agents";
import { cancelTask, scheduleExtension, scheduleWidgets } from "./extensions/schedule";
import type { PimServices } from "./extensions/services";
import { webExtension } from "./extensions/web";
import { HostedApps, SESSION_COOKIE as HOSTED_SESSION_COOKIE } from "./hosted";
import { COMPUTER_PATH, COMPUTER_TAG, COMPUTER_TOKEN_HEADER, Computer } from "./computer";
import { machineName } from "./computer-host";
import { FILES_ROOT, Files } from "./files";
import { LegacyFiles } from "./legacy-files";
import { NOTE_TAG, NoteStore } from "./notes";
import { PimBrowser } from "./browser";
import { type DeploymentSettings, deploymentSettings } from "./deployment";
import { DiagnosticEvents } from "./diagnostics";
import { dispatch, HttpError, type Route, routeOf } from "@pim/shared/http";
import type { ServerMessage, ToolInfo } from "./protocol";
import { generateVapidKeys, sendPush, type VapidKeys } from "./push";
import { themes as ownThemes } from "./extensions/themes";
import { type ApprovalPolicy, readSettings, type Settings, updateSettings } from "./settings";
import { type Approval, type ApprovalDecider, type ApprovalStatus, type Notification, OWNER, PimStore, type ToolPermission } from "./store";
import { type Agent, AgentStore, agentInput, checkContacts } from "./agents";
import { ChatLinkStore } from "./chat-links";
import type { AgentIcon, ArtifactToPublish, Bot, BotModel, PublishedAgent } from "./gallery";
import { mentioned, ROOM_HISTORY_CHARS, ROOM_NOTICE, ROOM_POST, RoomStore, roomHistory, roomsExtension, type Seat } from "./rooms";
import { TRIGGER_PATHS } from "@pim/triggers/api";
import { COMPUTER_GRANT_EXTENSION, computerGrantExtension } from "./triggers/grant-action";
import { TriggerEngine } from "@pim/triggers/engine";
import { type StableOperation } from "@pim/triggers/host";
import { TaskStore, tasksExtension } from "./tasks";
import { reviewExtension } from "./majordomo";
import { Progress } from "./progress";
import { type CodingVaultKey, type Harness as CodingHarness } from "@pim/shared/harnesses";
import { type VaultRecord, type VaultStatus, type VaultWriteResult } from "@pim/coding/vault/store";
import { exporterFrom, Telemetry, type TelemetryEnv } from "./telemetry";
import { projectEntries } from "@pim/shared/transcript";
import { RunWatch, stoppable } from "./run-guard";
import { conversationText, DESCRIBE_WORK, NAME_CHAT, type StructuredUtilityTask, type UtilityTask } from "./utility";
import { type ComputeQuota, parseComputeQuota, resolveQuota } from "./compute";
import { type Limits, parseLimits, UsageMeter } from "./usage";
import { type BriefResult, type GuestCallResult, VISIT_PREFIX, VisitStore } from "./visits";
import { spaceRoutes, type SpaceRouteHost } from "./space/routes";
import { Approvals, type ApprovalsHost } from "./space/approvals";
import { Conversations, type ConversationsHost } from "./space/conversations";
import { SpaceModels, type ModelsHost } from "./space/models";
import { Connectors, type ConnectorsHost } from "./space/connectors";
import { Reports, type ReportsHost } from "./space/reports";
import { Abilities, type AbilitiesHost } from "./space/abilities";
import { Views, type ViewsHost } from "./space/views";
import { Sockets, type SocketsHost } from "./space/sockets";
import { SpaceTriggers, type TriggersHost } from "./space/triggers";
import { SpaceCoding, type CodingHost } from "./space/coding";
import { Sharing, type SharingHost } from "./space/sharing";
import { ARCHIVE_WHEN_IDLE_KEY, APPS_CALLBACK_PATH, awaitingKey, signInResultPage, PERSON_NAME_KEY, LIMITS_KEY, OWNER_ADMIN_KEY, ARTIFACT_ID, clipTitle, errorMessage, type MemoryScopeInfo, type AutoApproval, type ToolPermissionInfo, type OwnerStatus, type OwnerProfile, type GuestBot, type AiEnv, type SocketState, type NoteSocketState } from "./space/shared";

export { SIGNED_IN_HEADER, MCP_CALLBACK_PATH, APPS_CALLBACK_PATH, MCP_SERVER_PATH, MCP_EVENTS_PATH } from "./space/shared";
export type { MemoryScopeInfo, ToolPermissionInfo, OwnerStatus, OwnerProfile, GuestBot } from "./space/shared";

/** Pim's own actions that use the person's computer, offered only while one is paired. */
const COMPUTER_ACTIONS: ReadonlySet<string> = new Set(["file_delete", SHELL, APP_DEPLOY, BROWSER_CLICK, BROWSER_TYPE, BROWSER_UPLOAD, DESKTOP_ACT]);

/**
 * Set by the Worker on every request it forwards: the owner it resolved,
 * which must be the agent's own name. A request routed to the wrong agent is
 * refused rather than served.
 */
export const OWNER_HEADER = "x-pim-owner";

/** Pim's client metadata document for sign-ins that take one, as `/mcp/client/<owner>`: it names that owner's callback. */
export const MCP_CLIENT_PATH = "/mcp/client";

/** How long a reply may stay unread before it is pushed: time for an open chat to mark it read. */
const REPLY_PUSH_DELAY_SECONDS = 10;
const REPLY_PUSH_CALLBACK = "pushReply";
/** How long a reply waits to be checked again while its chat is still at work. */
const REPLY_PUSH_RETRY_SECONDS = 30;

/** A device alert keeps adding sentences until it has this many characters, and never goes past the longer one. */
const PUSH_BODY_MINIMUM = 90;
const PUSH_BODY_LENGTH = 240;

/** What an agent's model is told about who reads one of the scopes it reads; `names` are the agents' names by id. */
function memoryScopeAbout(scope: MemoryScopeInfo, agent: Agent, names: ReadonlyMap<string, string>): string {
	switch (scope.kind) {
		case "private":
			return "your own: only you read it";
		case "everyone":
			return "which all of the person's agents read";
		case "agent":
			if (!scope.agents.includes(agent.id)) return `the own scope of ${scope.name}`;
			return scope.agents.length === 1 ? "your own: only you and the majordomo read it" : "your own, which your copies share: only you, they and the majordomo read it";
		case "named": {
			const others = scope.readers.filter((id) => id !== agent.id && names.has(id)).map((id) => names.get(id)!);
			return `"${scope.name}", which ${others.length === 0 ? "only you read" : `you and ${others.join(", ")} read`}`;
		}
		case "former":
			return "left by an agent or scope since deleted: only you read it";
	}
}

/** How long an agent's run may go without any progress before it is stopped, with a note: a call that never returns can't hold a chat's events for good. A wait for the person, or for a retry, is not a stall. */
const STALL_MS = 30 * 60 * 1000;

const NO_WORKERS_AI = {
	run: async () => {
		throw new Error("No model is set up. Add a model provider in Settings → Model → Providers, or ask this Pim's admin to.");
	},
} as unknown as Ai;

/** How much of a chat an agent reads with `read_chat`: its latest part. */
const READ_CHAT_CHARS = 48_000;

/** `pim_meta` keys the Worker sets: the owner's profile, a suspension, the space's own limits. */
const PROFILE_KEY = "owner";

const STATUS_KEY = "status";

/** The space's own compute quota (./compute.ts), over the deployment's; absent when the admin gave none. */
const COMPUTE_QUOTA_KEY = "compute_quota";

/** A request to the space slower than this is logged (`pim.slow_request`). */
const SLOW_REQUEST_MS = 5_000;

const AGENT_SECTION_KEY = "pim_section";
/** Accepts any JSON-RPC result: pim checks the shapes of extension results itself. */
const ANY_RESULT = { "~standard": { version: 1, vendor: "pim", validate: (value: unknown) => ({ value }) } };

/**
 * The person's space, named by their owner ID. Its SQLite database holds
 * pi's conversations, tasks and transcripts, plus the space's memories,
 * goals, approvals and notifications.
 *
 * pi-durable runs every model turn and tool call as a durable task, and the
 * `PiHarness` lifecycle job wakes the object after an eviction so runs
 * resume where they stopped.
 */
export class Pim extends DurableAgent<Env> {
	readonly store = new PimStore(this.ctx.storage.sql);
	/** People this space's owner shares it with, in circles. */
	readonly circles = new CircleStore(this.ctx.storage.sql);
	/** Spaces shared with this space's owner, and their conversations with them. */
	readonly visits = new VisitStore(this.ctx.storage.sql);
	/** The tasks agents handed each other, each in a conversation of its own (./tasks.ts); made before the agents, which make their old teams' tasks their own. */
	readonly #tasks = new TaskStore(this.ctx.storage.sql);
	/** Chats grown into group chats, and the conversations their agents talk in there (./rooms.ts). */
	readonly #rooms = new RoomStore(this.ctx.storage.sql);
	/** Agents being brought into rooms, by room and agent, so one mentioned twice at once joins once. In memory. */
	readonly #joining = new Map<string, Promise<Seat>>();
	/** Suggestions being written, by their `pim_meta` key. In memory. */
	readonly #suggesting = new Map<string, { of: string; promise: Promise<string[]> }>();
	/** The owner's agents: each with its own instructions, the majordomo first. */
	readonly agents = new AgentStore(this.ctx.storage.sql, () => {
		// The majordomo until the person names it.
		return { name: "Majordomo", description: "", instructions: "", apps: [], skills: [], contacts: [] };
	}, () => this.appDirectory());
	/** The skills the owner's agents wrote for work they do again. */
	readonly skills = new SkillStore(this.ctx.storage.sql, {
		storageRoom: () => this.#storageRoom(),
		bucket: this.env.BLOBS,
		owner: () => this.name,
		transaction: (work) => this.ctx.storage.transactionSync(work),
	});
	/** Public links to the owner's chats, each with the copy of its chat it shows. */
	readonly chatLinks = new ChatLinkStore(this.ctx.storage.sql);
	/** Images the person sent, in R2; their messages keep their URLs. */
	readonly images = new ImageStore({
		sql: this.ctx.storage.sql,
		bucket: this.env.BLOBS,
		owner: () => this.name,
		publicOrigin: () => this.deployment().publicUrl ?? undefined,
		meta: { get: (key) => this.store.meta(key), set: (key, value) => this.store.setMeta(key, value) },
	});
	/** What the agent made for its owner, with every version. */
	readonly artifacts = new ArtifactStore(this.ctx.storage.sql, () => this.limits(), {
		bucket: this.env.ARTIFACTS,
		owner: () => this.name,
		storageRoom: () => this.#storageRoom(),
	});
	/** Notes: the live text of Markdown apps, which the person and the agent write in together (see ./notes.ts). */
	readonly notes = new NoteStore(this.ctx.storage.sql, this.artifacts, (note) =>
		[...this.getConnections<NoteSocketState>(NOTE_TAG)].filter((connection) => connection.state?.note === note).map((connection) => this.#sockets.notePeer(connection)),
	);
	/** The person's computer, which their agents use, if they have one (see ./computer.ts). */
	readonly computer: Computer = new Computer({
		meta: this.store,
		sockets: () => [...this.getConnections(COMPUTER_TAG)],
		screen: (channel, data) => this.#sockets.screenSaid(channel, data),
	});
	/** The person's files, on their computer, which they and their agents share (see ./files.ts). */
	readonly files = new Files(this.computer);
	readonly #files: FileServices = { computer: this.computer, assertOpen: () => this.#assertOpen(), saw: (session, path, sha256) => this.#conversations.sawFile(session, path, sha256) };
	/** The canvas tools' reach into the apps showing a chat (see ./extensions/canvas.ts). */
	readonly #canvas = { computer: this.computer, open: (session: string, path: string, line?: number) => this.#sockets.canvasOpen(session, path, line), ask: (session: string, what: "tabs" | "selection") => this.#sockets.canvasAsk(session, what) };
	/** The files each app socket watches, by connection id, with how many times it asked for each. In memory: a socket that outlives a restart is asked for them again (`file_resync`). */
	readonly #fileHolds = new Map<string, Map<string, number>>();
	/** Questions to an app about its canvas, by request id, waiting for its answer. */
	readonly #canvasAsks = new Map<string, (answer: CanvasAnswer) => void>();
	/** The apps with a backend on that computer. */
	readonly hosted = new HostedApps(this.ctx.storage.sql, {
		computer: this.computer,
		artifacts: this.artifacts,
		meta: this.store,
		appsOrigin: () => this.deployment().appsOrigin,
	});
	readonly #hostedServices = { computer: this.computer, artifacts: this.artifacts, hosted: this.hosted, assertOpen: () => this.#assertOpen() };
	#legacyWorkspace: Workspace | undefined;
	/** Files kept in the space before they moved to the computer, until they move there (see ./legacy-files.ts). */
	readonly legacyFiles = new LegacyFiles({
		workspace: () => (this.#legacyWorkspace ??= new Workspace({ storage: this.ctx.storage, output: false })),
		sql: this.ctx.storage.sql,
		bucket: this.env.BLOBS,
		owner: () => this.name,
	});
	/** The browser the person's agents share (see ./browser.ts). */
	readonly browser = new PimBrowser(this.computer, {
		get: (key) => this.store.meta(key) || null,
		set: (key, value) => this.store.setMeta(key, value ?? ""),
	});
	/**
	 * Workers AI, when the deployment has the `AI` binding. Without it, models
	 * come from the providers people add, and a request to Workers AI says so.
	 */
	readonly ai = createAI({ binding: (this.env as AiEnv).AI ?? NO_WORKERS_AI });
	/** The person's email address, and emailing them there. */
	readonly email = new Email(this.store, () => this.mailer());
	/** Model credentials (the ChatGPT plan's tokens), refreshed by pi-ai. */
	readonly credentials = new SqlCredentialStore(this.store);
	readonly chatgpt = new ChatGPT(this.store, chatgptCredentials(this.credentials));
	/** The ChatGPT plan's images, through Codex's own sign-in. */
	readonly codexImages = new CodexImages(this.store, this.credentials);
	#modelCatalog: Models | undefined;
	/** Long-term memory: an OptMem-style log and summary tree for each scope, each conversation reading those of its agent. */
	readonly memory = createOptMem({
		sql: this.ctx.storage.sql,
		timeZone: () => this.settings().timeZone,
		viewLines: this.deployment().memoryLines,
		compressionModel: () => this.memoryModel(),
		access: (conversation) => this.#memoryAccess(this.#conversations.roleOf(conversation).agent),
	});
	/** Traces of the agents' runs, model requests and tool calls, for the deployment's OpenTelemetry backend (./telemetry.ts). */
	readonly telemetry = new Telemetry({
		exporter: this.spanExporter(),
		batch: this.batchSpans(),
		content: (this.env as TelemetryEnv).OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === "true",
		service: (this.env as TelemetryEnv).OTEL_SERVICE_NAME || "pim",
		instance: this.ctx.id.toString(),
		agentOf: (conversation) => {
			const { agent } = this.#conversations.roleOf(conversation);
			return { id: agent.id, name: agent.name };
		},
		idOf: (conversation) => this.store.publicId(conversation),
	});
	readonly registry = this.telemetry.instrument(stoppable(createRegistry()));
	/** What agents are doing, in a few words, for those who have their chats open (see ./progress.ts). */
	readonly #progress = new Progress({
		watched: (session) => this.#sockets.watchers(session).length > 0,
		describe: (input) => this.utility(DESCRIBE_WORK, input),
		show: (session, line, calls) => {
			for (const connection of this.#sockets.watchers(session)) this.#sockets.send(connection, { type: "progress", session: this.store.publicId(session), text: line, calls });
		},
		keepAliveWhile: (work) => this.keepAliveWhile(work),
	});
	#extensions: PimExtensions | undefined;
	/** Extensions' own data, each apart from the others'. */
	readonly extensionData = new ExtensionDataStore(this.ctx.storage.sql);
	#abilities: Map<string, Ability> | undefined;
	/** Whether a coding sandbox provider is configured, as read before the chat's latest turn (`#refreshCompute`); until then, whether the deployment's environment has one. */
	#codingSandboxes: boolean | undefined;
	/** What this space has used, and its limits. */
	readonly usage = new UsageMeter({
		sql: this.ctx.storage.sql,
		limits: () => this.limits(),
		// The person's own plan and providers: their tokens are theirs, not the deployment's.
		ownProvider: (provider) => provider === CHATGPT_PROVIDER || provider.startsWith(OWN_PROVIDER),
		// Only the ChatGPT subscription is free per call: a custom endpoint bills per token, so its calls are priced.
		subscription: (provider) => this.#models.subscription(provider),
		tags: (call) => this.#reports.callTags(call),
		// The hourly rollup of model calls rides the triggers' wake.
		rollupDue: () => void this.wakeTriggers().catch((error) => console.warn("setting the usage rollup wake failed", error)),
	});
	/** The last events that were only logged before, for the majordomo's diagnostics (./diagnostics.ts). */
	readonly diagnosticEvents = new DiagnosticEvents(this.ctx.storage.sql);
	/** Subscriptions cooling down after their usage limit, whose runs go to the deployment's default model meanwhile. */
	readonly providerCooldowns = new ProviderCooldowns(this.ctx.storage.sql);
	/** The conversation each provider session id names; a conversation's id never changes. */
	readonly #providerSessions = new Map<string, string>();
	/** The person's connections to connectors extensions implement themselves, with their sign-ins. */
	readonly nativeApps = new NativeApps({
		sql: this.ctx.storage.sql,
		app: (ref) => {
			const app = this.extensions.app(ref);
			return app && isNativeApp(app) ? app : undefined;
		},
		secrets: (app) => this.#connectors.secrets(app),
		credentialsKey: () => this.#connectors.env([APP_CREDENTIALS_KEY])[APP_CREDENTIALS_KEY] ?? null,
		callbackUrl: () => `${this.deployment().publicUrl}${APPS_CALLBACK_PATH}`,
		owner: () => this.name,
		changed: () => this.#connectors.installApps(),
	});
	/**
	 * Connectors: the SDK's MCP client, and the connectors extensions implement,
	 * as the bridge pim's extension builds tools from.
	 */
	readonly apps: McpBridge = {
		servers: () => [
			...Object.entries(this.getMcpServers().servers).map(([id, server]) => ({
				id,
				name: server.name,
				url: server.server_url,
				state: server.state,
				error: server.error,
				authUrl: server.auth_url,
				instructions: server.instructions,
				approval: (this.store.mcpApproval(id) ?? "writes") as McpApproval,
			})),
			...this.nativeApps.connections().map(({ id, app, name, state, error, authUrl }) => ({
				id,
				app,
				name,
				url: "",
				state,
				error,
				authUrl,
				instructions: null,
				approval: (this.store.mcpApproval(id) ?? "writes") as McpApproval,
			})),
		],
		tools: () => [...this.mcp.listTools(), ...this.nativeApps.tools()],
		call: async (serverId, name, args) => {
			// Work still under way on a space being erased acts on nobody's behalf.
			this.#assertOpen();
			const refusal = this.usage.reserveToolCall();
			if (refusal !== null) {
				console.warn(JSON.stringify({ event: "pim.limit", limit: "toolCalls", reason: refusal }));
				return { content: [{ type: "text", text: refusal }], isError: true };
			}
			if (this.nativeApps.has(serverId)) return this.nativeApps.call(serverId, name, args);
			const call = () => this.mcp.callTool({ serverId, name, arguments: args });
			try {
				return await call();
			} catch (error) {
				if (!UnauthorizedError.isInstance(error) && !(SdkHttpError.isInstance(error) && error.status === 401)) throw error;
				// The connector refused the sign-in, which expired or was revoked. Connecting again finds out whether
				// it still works; when it doesn't, the connection waits for the person to sign in again, with a new
				// link, instead of showing as connected.
				const again = await this.mcp.connectToServer(serverId);
				if (again.state === "connected" && (await this.mcp.discoverIfConnected(serverId))?.success) return call();
				const app = this.apps.servers().find((server) => server.id === serverId)?.name ?? serverId;
				const next =
					again.state === "authenticating"
						? `The person must sign in to ${app} again before it can be used. Give them this link: ${again.authUrl}`
						: `${app} could not connect again${again.state === "failed" ? `: ${again.error}` : ""}.`;
				return { content: [{ type: "text", text: `${app} refused its sign-in. ${next}` }], isError: true };
			}
		},
		connect: (app) => this.connectApp(app),
		capabilities: (serverId) => this.mcp.mcpConnections[serverId]?.serverCapabilities as McpCapabilities | undefined,
		request: async (serverId, method, params) => {
			const connection = this.mcp.mcpConnections[serverId];
			if (!connection) throw new Error(`The connector ${serverId} is not connected`);
			return connection.client.request({ method, params } as never, ANY_RESULT as never);
		},
		readResource: async (serverId, uri) =>
			(await this.mcp.readResource({ serverId, uri })) as { contents: readonly McpResourceContent[] },
	};
	/** Connectors' skills and event types, cached in this object's database. */
	readonly catalog = new AppCatalog(this.apps, this.store);
	/** What decides who writes which skill, read as it is at each check (./extensions/skills.ts). */
	readonly #skillWriters: SkillWriters = { agents: this.agents, store: this.store, skills: this.skills, roleOf: (session) => this.#conversations.roleOf(session) };
	/** Pim's own actions; the extensions' come with their abilities. */
	readonly #ownActions: readonly GatedAction[] = [
		httpRequest as GatedAction,
		...mcpActions(this.apps),
		updateAgentAction(this.agents, this.files),
		shareMemoryScopeAction(this.agents, () => this.memory.store.namedScopes()),
		manageAppsAction(this.agents, this.apps, () => this.appDirectory()),
		addCustomAppAction(this.agents, this.apps, (app) => this.#connectors.addCustomApp(app)),
		fileDeleteAction(this.#files),
		shellAction(this.computer),
		appDeployAction(this.#hostedServices),
		browserClickAction(this.browser),
		browserTypeAction(this.browser),
		browserUploadAction(
			this.browser,
			(path) => this.computer.localPath(path),
		),
		desktopAction(this.computer),
		writeSkillAction(this.skills, this.#skillWriters, this.files),
	];

	/**
	 * Pim's own actions whose tools agents are offered now: those that use the
	 * computer only while one is paired (its desktop's, while it has one they
	 * can use), and adding connectors to this Pim only in its admin's space.
	 */
	#offeredActions(): GatedAction[] {
		const computer = this.computer.paired();
		const desktop = this.computer.desktop();
		const admin = this.store.meta(OWNER_ADMIN_KEY) === "1";
		return this.#ownActions.filter(
			(action) =>
				(computer || !COMPUTER_ACTIONS.has(action.name)) && (desktop || action.name !== DESKTOP_ACT) && (admin || action.name !== ADD_CUSTOM_CONNECTOR),
		);
	}

	/** Every action an approval can be for: Pim's own, and the extensions'. */
	get actions(): readonly GatedAction[] {
		return [
			...this.#ownActions,
			...[...this.abilities.values()].flatMap((ability) => ability.actions ?? []),
			this.#triggers.computerGrantAction,
		];
	}

	readonly harness = new PiHarness({
		harness: async ({ storage, context }) => {
			const services = this.services();
			this.#approvals.migrateAlwaysApproved();
			this.registry.install(this.telemetry.extension());
			this.registry.install(this.#progress.extension());
			this.registry.install(this.#abilitiesOf.continuationExtension());
			this.registry.install(this.#agentExtension(services));
			this.registry.install(this.#skillsExtension(services));
			this.registry.install(goalsExtension(services));
			this.registry.install(scheduleExtension(this.#triggers.scheduleHost()));
			this.registry.install(messagingExtension(services));
			this.registry.install(
				chatsExtension(async (id) => {
					const session = await this.#views.session(id).catch(() => null);
					if (session === null) return null;
					return { title: this.store.sessionInfo(session)?.title ?? null, conversation: conversationText(projectEntries(await this.harness.session(session).messages()), READ_CHAT_CHARS) };
				}),
			);
			this.registry.install(
				tasksExtension({
					roleOf: (session) => this.#conversations.roleOf(session),
					delegates: (session) => this.#conversations.delegates(session),
					start: (requester, batch, tasks, options) => this.#conversations.startTasks(requester, batch, tasks, options),
					archive: async (conversation) => {
						// A chat still at work is archived once it stops, so that what it says on the way does not list it again.
						if (await this.harness.session(conversation).busy()) this.store.setMeta(`${ARCHIVE_WHEN_IDLE_KEY}${conversation}`, "1");
						else this.#conversations.archive(conversation);
					},
					tasks: this.#tasks,
				}),
			);
			this.registry.install(
				roomsExtension({
					rooms: this.#rooms,
					speaker: (conversation) => (this.#conversations.roomable(conversation) || this.#rooms.of(conversation) ? this.#conversations.roleOf(conversation).agent : null),
					agent: (id) => this.agents.get(id),
					invitable: (conversation) => this.#conversations.invitable(conversation),
					remove: (seat) => this.#conversations.leave(seat),
					person: () => this.#conversations.personNames(),
					history: async (seat) => {
						const said = projectEntries(await this.harness.session(seat.room).messages()).filter((message) => message.timestamp < seat.joinedAt);
						return roomHistory(said, this.agents.ofSession(seat.room).name, ROOM_HISTORY_CHARS);
					},
				}),
			);
			this.registry.install(
				reviewExtension({ majordomo: () => this.agents.majordomo(), decide: (conversation, decision, note) => this.#approvals.reviewDecision(conversation, decision, note) }),
			);
			this.registry.install(approvalsExtension(services, this.#offeredActions()));
			this.#triggers.installTriggerTools();
			this.registry.install(webExtension);
			this.registry.install(
				artifactsExtension({
					artifacts: this.artifacts,
					assertOpen: () => this.#assertOpen(),
					readFile: (path) => this.files.bytes(path),
				}),
			);
			this.#connectors.installNotes();
			this.registry.install(filesExtension(this.#files));
			this.registry.install(canvasExtension(this.#canvas));
			this.registry.install(hostedExtension(this.#hostedServices));
			this.#installImageGeneration();
			this.#sharing.installBotTools();
			this.#installBrowser(services);
			this.#installDesktop();
			// Restored connections reconnect in the background after a wake; give them a moment.
			await this.mcp.waitForConnections({ timeout: 5_000 });
			this.#approvals.migrateAlwaysApproved();
			const apps = this.#connectors.appExtensions(services);
			this.registry.install(apps.apps);
			// No extension's tool may take the name of one of Pim's, or another extension's.
			checkToolNames(
				[...this.abilities].map(([id, ability]) => ({ id, ability })),
				[
					...this.registry
						.snapshot()
						.tools()
						// A harness opened again finds the abilities installed already: they don't count against themselves.
						.filter(({ extension }) => !this.abilities.has(extension.name) && extension.name !== this.memory.extension.name)
						.map(({ tool }) => tool.name),
					...(this.memory.extension.tools ?? []).map((tool) => tool.name),
					...this.#ownActions.map((action) => action.name),
				],
			);
			// Before memory, whose view changes as the conversation goes: a section after it would make pi send every section again.
			this.#abilitiesOf.installAbilities(services);
			this.registry.install(this.memory.extension);
			// Last: the apps' tools come and go, and pi only appends cheaply at the end.
			this.#connectors.installAppTools(apps.tools);
			// Visits' tools, as their hosts last allowed, so a visit's run resumes with them; each turn asks again.
			const visitor = this.profile()?.username;
			for (const share of this.visits.shares()) {
				const brief = this.visits.brief(share.ownerId);
				if (visitor && brief && !share.revoked) this.#sharing.installVisit(brief, visitor);
			}
			const harness = await Harness.open(
				storage,
				{
					models: this.modelCatalog(),
					registry: this.registry,
					settings: this.harnessSettings(),
					onReport: (error) => console.warn("pi report", error),
				},
				context,
			);
			// Chats started with an agent used to store its instructions; the `agent` section gives them now.
			if (this.store.meta(AGENT_SECTION_KEY) === undefined) {
				for (const session of this.agents.startedSessions()) {
					await (await harness.conversation(Number(session) as ConversationId, context))?.configure({ instructions: null }, context);
				}
				this.store.setMeta(AGENT_SECTION_KEY, "1");
			}
			return harness;
		},
		defaults: { model: this.defaultModel(), thinkingLevel: "low" },
	});

	/** Streams of the desktop whose socket went, which have been asked to close. */
	readonly #orphanedScreens = new Set<number>();
	/** Whether each display's person has it, as displayd last said, for `#mayDrive`: kept a few seconds, so input needn't ask for every event. */
	readonly #displayControl = new Map<string, { control: "agent" | "user"; at: number }>();
	#displayLookup: Promise<void> | null = null;
	/** pi agent-event watches, by connection id. In memory: rebuilt in `onStart`. */
	readonly #watches = new Map<string, AgentEventStream>();
	/** Each connection's latest watch request: one that finishes setting up after a newer one is dropped. */
	readonly #watchRequests = new Map<string, object>();

	/** The space's approvals and tool permissions (src/space/approvals.ts). */
	readonly #approvals = new Approvals(this.#approvalsHost());

	/** Tasks, group chats and runs (src/space/conversations.ts). */
	readonly #conversations = new Conversations(this.#conversationsHost());

	/** The space's models and providers (src/space/models.ts). */
	readonly #models = new SpaceModels(this.#modelsHost());

	/** The space's connectors (src/space/connectors.ts). */
	readonly #connectors = new Connectors(this.#connectorsHost());

	/** What the space reports and hands over (src/space/reports.ts). */
	readonly #reports = new Reports(this.#reportsHost());

	/** The space's abilities, widgets and suggestions (src/space/abilities.ts). */
	readonly #abilitiesOf = new Abilities(this.#abilitiesHost());

	/** What the API shows of chats and apps (src/space/views.ts). */
	readonly #views = new Views(this.#viewsHost());

	/** The space's WebSockets (src/space/sockets.ts). */
	readonly #sockets = new Sockets(this.#socketsHost());

	/** The space's triggers (src/space/triggers.ts). */
	readonly #triggers = new SpaceTriggers(this.#triggersHost());

	/** The space's side of its coding threads (src/space/coding.ts). */
	readonly #coding = new SpaceCoding(this.#codingHost());

	/** What the space shares and receives (src/space/sharing.ts). */
	readonly #sharing = new Sharing(this.#sharingHost());

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// The computer pings to keep its connection open; the answer doesn't wake the space.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		this.lifecycle.use(this.harness);
		// A new, removed, signed-in or failed connector changes the tools: pi uses the new set from the next request.
		this.mcp.onServerStateChanged(() => {
			this.#connectors.installApps();
			// A connector that just became ready gets its skills and event types read once.
			for (const server of this.apps.servers()) {
				if (server.state === "ready" && !this.catalog.known(server.id)) {
					void this.catalog.refresh(server.id).catch((error) => console.warn(`reading ${server.id}'s catalog failed`, error));
				}
			}
		});
	}

	/**
	 * Connects one of the directory's connectors. A failed connection leaves nothing behind; `authUrl` is
	 * set when the user must sign in.
	 */
	async connectApp(app: DirectoryApp, options: { approval?: McpApproval } = {}): Promise<{ id: string; state: string; authUrl?: string }> {
		return this.#connectors.connectApp(app, options);
	}

	/**
	 * Signs in to MCP servers as the SDK does, registering Pim with each,
	 * except for a connector whose definition says otherwise (see
	 * `McpAppDefinition.client`): the client the deployment registered
	 * beforehand, or Pim's client metadata document.
	 */
	override createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
		const clientOf = (serverId: string) => {
			const url = this.getMcpServers().servers[serverId]?.server_url;
			const app = this.appDirectory().find((candidate) => candidate.url !== null && candidate.url === url);
			const definition = app && this.extensions.app(app.ref);
			return definition && !isNativeApp(definition) ? definition.client : undefined;
		};
		const metadataDocument = new URL(`${MCP_CLIENT_PATH}/${this.name}`, callbackUrl).href;
		const registered = (serverId: string) => {
			const client = clientOf(serverId);
			if (typeof client !== "object") return undefined;
			const env = this.#connectors.env([client.id, ...(client.secret ? [client.secret] : [])]);
			return {
				client_id: env[client.id]!,
				...(client.secret ? { client_secret: env[client.secret]!, token_endpoint_auth_method: "client_secret_post" } : {}),
				redirect_uris: [callbackUrl],
			};
		};
		return new (class extends DurableObjectOAuthClientProvider {
			// Services show the name on their consent screens; the SDK would register the owner's id,
			// which some refuse. Its client_uri, the Pim's origin, is optional, and some refuse a host
			// they can't reach (Make refuses localhost).
			override get clientMetadata() {
				const { client_uri: _origin, ...metadata } = super.clientMetadata;
				return { ...metadata, client_name: "Pim" };
			}

			// The SDK names Pim by it when the sign-in takes metadata documents.
			get clientMetadataUrl() {
				return clientOf(this.serverId) === "metadata-document" ? metadataDocument : undefined;
			}

			override async clientInformation(context?: Parameters<DurableObjectOAuthClientProvider["clientInformation"]>[0]) {
				const client = registered(this.serverId);
				if (!client) return super.clientInformation(context);
				this.clientId = client.client_id;
				return client;
			}
		})(this.ctx.storage, this.name, callbackUrl);
	}

	/**
	 * The connectors people on this deployment can connect: the extensions', then the admin's, as last
	 * read from the gallery.
	 */
	appDirectory(): DirectoryApp[] {
		return this.#connectors.appDirectory();
	}

	/** pi's run policy, shared by every session. */
	protected harnessSettings(): HarnessSettings {
		const registry = this.registry;
		const perPim = (name: string) => this.#connectors.perPim(name);
		return {
			// Every extension but visits', connectors' and reviews': a visit's own conversation selects its
			// extension, the chats of agents that list a connector select it, and reviews select theirs.
			get extensions() {
				return registry
					.snapshot()
					.installed()
					.filter((extension) => !extension.name.startsWith(VISIT_PREFIX) && !perPim(extension.name));
			},
			// 1, 2, 4, 8, 16 s: about 30 s for a rate-limited model to recover.
			// A model that still fails after that, such as one whose plan ran out, holds the run until the person says to try again.
			retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000, suspend: (message, conversation) => this.#models.holdsRun(message, String(conversation)) },
			// Fewer storage writes while streaming; a crash loses at most this window.
			progress: { partialIntervalMs: 250, outputIntervalMs: 250 },
		};
	}

	/**
	 * Asks the model again in the chats held on a subscription's error once it has cooled down, or at once
	 * when another model can take them meanwhile. While it still cools down with nowhere else to go, wakes
	 * again at the cooldown's end, which `until` names, so each end is armed once.
	 */
	async retryAfterCooldown({ provider, until }: { provider: string; until?: number }): Promise<void> {
		return this.#models.retryAfterCooldown({ provider, until });
	}

	/**
	 * The model catalog pi resolves sessions' models against: Workers AI, and the ChatGPT plan. People's
	 * providers join it in `modelCatalog`.
	 */
	protected models(): MutableModels {
		return this.#models.models();
	}

	/**
	 * One catalog for pi and the API, so a token refresh is never run twice at once. Every request through
	 * it is metered, and gets the chat's images. A request to the ChatGPT plan while it cools down after
	 * its usage limit, or one that finds the limit, goes to the deployment's default model.
	 */
	modelCatalog(): Models {
		return this.#models.modelCatalog();
	}

	/**
	 * The model a subscription's runs go to while it cools down: the deployment's default, when that is
	 * another provider's and can run here; else none, and the runs wait for the limit to reset.
	 */
	protected fallbackModel(provider: string, session?: string): Model<Api> | undefined {
		return this.#models.fallbackModel(provider, session);
	}

	/** The model providers the person can use, by catalog id: the admin's, then their own. Keys included. */
	customProviders(): { catalogId: string; shared: boolean; provider: CustomProvider }[] {
		return this.#models.customProviders();
	}

	/**
	 * One of the space's model providers by its catalog id, key included, or null. Only for the space's
	 * coding threads (src/coding/thread-do.ts), which call their model from their own Durable Objects and
	 * keep the provider in memory only; it is never served by the API.
	 */
	async codingModelProvider(catalogId: string): Promise<CustomProvider | null> {
		return this.#coding.codingModelProvider(catalogId);
	}

	/**
	 * The space's key for a family of model APIs, for a coding thread's model gateway
	 * (src/coding/model-gateway.ts), which adds it to what a CLI in the thread's workspace sends: the
	 * built-in provider of that service the thread runs on, else the person's own, else the admin's. Null
	 * when the space has none, or is closed. The thread keeps it in memory for the one request only.
	 */
	async codingGatewayCredential(family: string, preferred: string | null): Promise<{ providerId: string; url: string; key: string } | null> {
		return this.#coding.codingGatewayCredential(family, preferred);
	}

	/**
	 * The model a coding thread started without one runs on: the space's, as agents without a model of
	 * their own use it, the ChatGPT plan's included. Never the deployment's default in its place: that is
	 * Workers AI, which the person doesn't want coding threads on.
	 */
	async codingDefaultProfile(): Promise<{ providerId: string; model: string }> {
		return this.#coding.codingDefaultProfile();
	}

	/**
	 * The ChatGPT plan's access token, for a coding thread's model calls (src/coding/thread-do.ts), which
	 * keep it in memory for the one request. Refreshed here, through the space's one catalog, so a thread
	 * never refreshes it and never races this Pim's own refresh. Null when not signed in.
	 */
	async codingChatgptToken(): Promise<string | null> {
		return this.#coding.codingChatgptToken();
	}

	/**
	 * The space's coding threads changed (one started, changed state or archived): open pages refresh
	 * their lists, as for a chat.
	 */
	codingThreadsChanged(): void {
		return this.#coding.codingThreadsChanged();
	}

	/**
	 * A coding thread an agent started ended a turn: the chat it started the thread from, by its public
	 * ID, is woken with `text`, as a scheduled task wakes a chat, once for each `key`. A chat that was
	 * deleted, or a space that can't take it now (erased, suspended, at a limit), is left be. Says whether
	 * it woke.
	 */
	async codingTurnEnded(chat: string, text: string, key: string, agent?: string): Promise<boolean> {
		return this.#coding.codingTurnEnded(chat, text, key, agent);
	}

	/**
	 * Asks the person to approve pushing a coding thread's branch, from the API (src/coding/api.ts): an
	 * approval of the `coding_push_for_approval` action (src/extensions/coding.ts) that no tool call waits
	 * for, which runs the push once approved. Asking again for the same push is the same approval.
	 */
	async codingRequestPush(threadId: string, push: { branch: string; checkpoint: string; head: string; summary: string }): Promise<{ id: string; status: ApprovalStatus }> {
		return this.#coding.codingRequestPush(threadId, push);
	}

	/**
	 * The coding vault (packages/coding/src/vault/vault.ts) keeps each harness's login here, sealed before
	 * it arrives: this object stores the blob and its version and never opens it. Only for the vault, over
	 * RPC; the API serves the status alone.
	 */
	async codingVaultStatus(): Promise<VaultStatus[]> {
		return this.#coding.codingVaultStatus();
	}

	async codingVaultRead(harness: CodingVaultKey): Promise<VaultRecord> {
		return this.#coding.codingVaultRead(harness);
	}

	async codingVaultWrite(harness: CodingVaultKey, sealed: Uint8Array, byteLength: number, expectedVersion: number): Promise<VaultWriteResult> {
		return this.#coding.codingVaultWrite(harness, sealed, byteLength, expectedVersion);
	}

	async codingVaultDelete(harness: CodingHarness): Promise<VaultStatus> {
		return this.#coding.codingVaultDelete(harness);
	}

	/** The person's settings: their own, else the deployment's. */
	settings(): Settings {
		return readSettings(this.store, this.#defaultSettings());
	}

	#defaultSettings(): Settings {
		const { timeZone, approvalPolicy } = this.deployment();
		return { timeZone, approvalPolicy, deviceAlerts: "important" };
	}

	/** Logs something worth a look, and keeps it in the diagnostics' log, which the admin's majordomo reads. */
	#note(event: string, fields: Record<string, unknown>): void {
		console.warn(JSON.stringify({ event: `pim.${event}`, owner: this.name, ...fields }));
		if (!this.#closed()) this.diagnosticEvents.record(event, fields);
	}

	/** How this deployment runs for everyone, from its variables (see ./deployment.ts). */
	deployment(): DeploymentSettings {
		return deploymentSettings(this.env);
	}

	/** The deployment's limits for members, with this space's own where the admin set them. */
	limits(): Limits {
		const own = this.store.meta(LIMITS_KEY);
		return { ...this.deployment().limits, ...(own === undefined ? {} : (JSON.parse(own) as Partial<Limits>)) };
	}

	/** How this deployment sends email (`EMAIL` and `PIM_EMAIL_FROM`); null when it can't. */
	protected mailer(): Mailer | null {
		return this.#models.mailer();
	}

	/** The deployment's model (`PIM_MODEL`), used whenever no other is chosen. */
	protected defaultModel(): PiModel {
		return this.#models.defaultModel();
	}

	/** The model of agents that have none of their own: the one chosen for the space through the API, or the default. */
	chosenModel(): PiModel {
		return this.#models.chosenModel();
	}

	/**
	 * The model an agent's conversations run on: its own, else the space's. One that's gone, or on a plan
	 * that isn't connected, is not read: see `#dropModels`.
	 */
	agentModel(agent: Agent): PiModel {
		return this.#models.agentModel(agent);
	}

	/**
	 * The model a chat runs on: the one chosen for it alone, else its agent's, else the space's. One
	 * that's gone is not read.
	 */
	sessionModel(session: string, agent: Agent = this.agents.ofSession(session)): PiModel {
		return this.#models.sessionModel(session, agent);
	}

	/** Sets the models every agent moves on to after its own fallbacks, from `GET /model`'s choices. */
	chooseModelFallbacks(models: PiModel[]): PiModel[] {
		return this.#models.chooseModelFallbacks(models);
	}

	/** Makes `model` the space's, for agents that have none of their own; null goes back to the default. */
	async chooseModel(model: PiModel | null): Promise<PiModel> {
		return this.#models.chooseModel(model);
	}

	/** Makes `model` an agent's; null follows the space's again. */
	async chooseAgentModel(agent: Agent, model: PiModel | null): Promise<Agent> {
		return this.#models.chooseAgentModel(agent, model);
	}

	/** Sets the models an agent moves on to when its own fails, from `GET /model`'s choices. */
	async chooseAgentFallbacks(agent: Agent, models: PiModel[]): Promise<Agent> {
		return this.#models.chooseAgentFallbacks(agent, models);
	}

	/** Makes `model` the model of one chat alone, over its agent's; null follows the agent's again. */
	async chooseSessionModel(session: string, model: PiModel | null): Promise<PiModel> {
		return this.#models.chooseSessionModel(session, model);
	}

	/**
	 * The model that compresses memories: `PIM_MEMORY_MODEL`, else `PIM_MODEL`. Never the chosen model, so
	 * background work does not spend a ChatGPT plan.
	 */
	protected memoryModel(): ModelRef | undefined {
		return this.#models.memoryModel();
	}

	/**
	 * The deployment's utility model (`PIM_UTILITY_MODEL` on Workers AI), for side jobs such as naming
	 * chats (see ./utility.ts). `off` turns them off.
	 */
	protected defaultUtilityModel(): Model<Api> | undefined {
		return this.#models.defaultUtilityModel();
	}

	/**
	 * The utility model: the one chosen through the API, or the default. A ChatGPT model counts only while
	 * the plan is connected, and a chosen model whose provider no longer answers in a schema is skipped.
	 */
	async utilityModel(): Promise<Model<Api> | undefined> {
		return this.#models.utilityModel();
	}

	/**
	 * Runs a side job on the utility model and returns its answer, cleaned as the task says. It counts
	 * against the daily model limits, but not as a run.
	 */
	async utility(task: UtilityTask, input: string): Promise<string> {
		return this.#models.utility(task, input);
	}

	/**
	 * Runs a side job whose answer is structured: the model answers in JSON that follows the task's
	 * schema, which its provider enforces. Only models that can are the utility model (see
	 * `utilityModel`).
	 */
	async utilityStructured<T extends readonly unknown[]>(task: StructuredUtilityTask<T>, input: string): Promise<T> {
		return this.#models.utilityStructured(task, input);
	}

	/**
	 * Every memory scope, in the order the majordomo's memory shows them:
	 * its own, the private scope; everyone's, which every agent reads; each
	 * agent's own, which copies of one agent share; the scopes the person
	 * named, which the agents they chose read; and those left by agents and
	 * named scopes since deleted, which only the majordomo reads, as it reads
	 * every scope.
	 */
	memoryScopes(): MemoryScopeInfo[] {
		const agents = this.agents.list();
		const majordomo = agents.find((agent) => agent.majordomo)!;
		const counts = this.memory.store.counts();
		const own = Map.groupBy(
			agents.filter((agent) => !agent.majordomo),
			(agent) => agent.memoryScope,
		);
		const scopes: Omit<MemoryScopeInfo, "count">[] = [
			{ key: PRIVATE_SCOPE, kind: "private", name: null, agents: [majordomo.id], readers: [majordomo.id] },
			{ key: EVERYONE_SCOPE, kind: "everyone", name: null, agents: [], readers: agents.map((agent) => agent.id) },
			...[...own].map(([key, copies]) => ({
				key,
				kind: "agent" as const,
				name: copies.map((agent) => agent.name).join(", "),
				agents: copies.map((agent) => agent.id),
				readers: [majordomo.id, ...copies.map((agent) => agent.id)],
			})),
			...this.memory.store.namedScopes().map(({ key, name }) => ({
				key,
				kind: "named" as const,
				name,
				agents: [],
				readers: [majordomo.id, ...agents.filter((agent) => agent.memoryScopes.includes(key)).map((agent) => agent.id)],
			})),
		];
		const known = new Set(scopes.map((scope) => scope.key));
		const former = [...counts.keys()].filter((key) => !known.has(key)).map((key) => ({ key, kind: "former" as const, name: null, agents: [], readers: [majordomo.id] }));
		return [...scopes, ...former].map((scope) => ({ ...scope, count: counts.get(scope.key) ?? 0 }));
	}

	/** The memory scopes an agent reads, its own first, each with what its model is told about who reads it, and where its notes go. */
	#memoryAccess(agent: Agent): MemoryAccess {
		const reads = this.memoryScopes().filter((scope) => scope.readers.includes(agent.id));
		const own = reads.filter((scope) => scope.key === agent.memoryScope);
		const names = new Map(this.agents.list().map((other) => [other.id, other.name]));
		const read = [...own, ...reads.filter((scope) => scope.key !== agent.memoryScope)].map((scope) => ({ key: scope.key, about: memoryScopeAbout(scope, agent, names) }));
		return { read, own: agent.memoryScope };
	}

	/** The memory scopes a circle reads: those ticked for it that are still the person's, with what a guest's model is told of each. */
	#circleMemory(circle: Circle): MemoryScope[] {
		return this.memoryScopes()
			.filter((scope) => (scope.kind === "everyone" || scope.kind === "named") && circle.memoryScopes.includes(scope.key))
			.map((scope) => ({ key: scope.key, about: scope.kind === "named" ? `"${scope.name}"` : "what all of the space's agents know" }));
	}

	/** A memory scope the person may keep memories in, read by the scopes' key; 404 for none. */
	#memoryScope(key: string): MemoryScopeInfo {
		const scope = this.memoryScopes().find((candidate) => candidate.key === key);
		if (!scope) throw new HttpError(404, `No memory scope ${key}`);
		return scope;
	}

	/** Named memory scopes an agent or a circle is to read must be the person's. */
	#checkNamedScopes(keys: readonly string[]): void {
		const named = new Set(this.memory.store.namedScopes().map((scope) => scope.key));
		for (const key of keys) if (!named.has(key)) throw new HttpError(400, `${key} isn't one of your named memory scopes`);
	}

	/**
	 * Starts memory compression from outside a tool call, such as after the
	 * user edits memory through the API. The task belongs to the root session.
	 */
	async startMemoryNap(): Promise<void> {
		const pi = await this.harness.pi();
		const context = BACKGROUND_CONTEXT;
		const root = await pi.conversation(ROOT_CONVERSATION_ID, context);
		if (!root) return;
		const id = await this.memory.startNap({
			getTask: (task) => pi.getTask(task, context),
			createTask: () =>
				root.commit(
					(tx) => tx.createTask(this.memory.NapTask, {}, { ownership: { kind: "conversation" }, background: true }),
					context,
				),
		});
		// No session run is waiting on it, so keep the object up until it settles.
		if (id !== undefined) void this.keepAliveWhile(() => pi.waitForTask(id, context));
	}

	protected services(): PimServices {
		const pim = this;
		return {
			store: this.store,
			responseSent: async (conversation, at, alert) => {
				// What an agent says in a room, it says in the room's chat.
				const session = this.#rooms.of(conversation)?.room ?? conversation;
				if (this.store.deletedSessions().has(session)) return;
				this.store.recordResponse(session, at);
				this.broadcastMessage({ type: "sessions" });
				// A task's conversation is not one of the person's chats, and a chat at work on a task answers the agent that asked, which tells the person.
				if (alert === undefined || this.#conversations.taskApart(session) || this.#conversations.taskUnderway(session) || this.store.pushSubscriptions().length === 0) return;
				// Idempotent, so a replayed reply is checked once.
				const body = session === conversation ? alert : `${this.#conversations.roleOf(conversation).agent.name}: ${alert}`;
				await this.schedule(REPLY_PUSH_DELAY_SECONDS, REPLY_PUSH_CALLBACK, { session, at, body: body.slice(0, 500) }, { idempotent: true });
			},
			posted: (session, message, at, images) => this.#conversations.posted(session, message, at, images),
			messageOfCall: async (session, callId) => {
				const entries = await this.harness.session(session).messages();
				return entries.findLast((entry) => entry.model?.[0]?.role === "assistant" && entry.model[0].content.some((part) => part.type === "toolCall" && part.id === callId))?.id.toString();
			},
			uiBlocksOf: async (session, message) => {
				try {
					return { blocks: await this.#views.uiBlocks(message, session) };
				} catch (error) {
					if (error instanceof HttpError && error.status === 404) return { error: `No message ${message} in this chat.` };
					throw error;
				}
			},
			maySkip: (session, input) => {
				const seat = this.#rooms.of(session);
				if (!seat) return false;
				if (input.startsWith(ROOM_NOTICE)) return true;
				const named = mentioned(input, this.#conversations.seated(this.#rooms.seats(seat.room)));
				if (named.some((agent) => agent.id === seat.agent)) return false;
				// What the person says to no one in particular is for the host.
				return ROOM_POST.test(input) || seat.conversation !== seat.room || named.length > 0;
			},
			// Read at each use: the person can change these while the space runs.
			get timeZone() {
				return pim.settings().timeZone;
			},
			get approvalTimeoutMs() {
				return pim.approvalTimeoutMs();
			},
			notify: (notification) => this.deliverNotification(notification),
			get emailEnabled() {
				return pim.mailer() !== null;
			},
			sendEmail: (mail) => {
				const origin = this.deployment().publicUrl;
				const link = origin ? `\n\n—\nFrom your Pim: ${new URL(`/chat/${this.store.publicId(mail.session)}`, origin)}` : "";
				return this.email.send({ ...mail, text: `${mail.text}${link}` });
			},
			approvalFiled: (approval, isNew) => this.#approvals.approvalFiled(approval, isNew),
			permission: (approval) => this.#approvals.approvalPermission(approval),
			taskAgent: (session) => {
				// A task's conversation that isn't a chat asks in the chat the work began in; a chat a task started asks in itself, like any chat.
				const task = this.#conversations.taskApart(session);
				if (task && task.kind !== "review") return { name: this.#conversations.roleOf(session).agent.name, session: task.root };
				// An agent in a room asks in the room's chat.
				const seat = this.#rooms.of(session);
				return seat && seat.conversation !== seat.room ? { name: this.#conversations.roleOf(session).agent.name, session: seat.room } : null;
			},
			widgetsFor: (session) => this.#abilitiesOf.chatWidgets(session),
			showWidget: async (session, ref) => {
				const kept = this.store.keptWidget<ToolWidget>(session, ref);
				if (!kept) return this.#abilitiesOf.loadWidget(this.agents.ofSession(session), ref);
				const { title, ...content } = kept;
				return { id: ref, title, empty: "", ...content };
			},
			keepWidget: (session, widget) => this.store.keepWidget(session, widget),
			keptWidgets: (session) => (this.visits.bySession(session) || this.#conversations.taskApart(session) ? [] : this.store.keptWidgets(session)),
			unseenImages: async (session, urls) => {
				if (urls.length === 0) return [];
				const results = (await this.harness.session(session).messages())
					.flatMap((entry) => {
						const message = entry.model?.[0];
						// A refused send names the images it refused.
						if (message?.role !== "toolResult" || message.toolName === SEND_TO_USER) return [];
						return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
					})
					.join("\n");
				return urls.filter((url) => !results.includes(url));
			},
			keepImages: async (session, urls) => {
				// A guest's browser can't load the host's images.
				if (this.visits.bySession(session)) return {};
				const kept: Record<string, string> = {};
				for (const url of urls) {
					const { storageBytes } = this.limits();
					const copy = await this.images.keepFrom(session, url, storageBytes === null ? null : storageBytes - this.storedBytes());
					if (copy) kept[url] = copy;
				}
				return kept;
			},
		};
	}

	async onStart(): Promise<void> {
		const started = Date.now();
		this.mcp.configureOAuthCallback({
			customHandler: (result) => signInResultPage(result.authSuccess, this.deployment().publicUrl ?? undefined, String(result.authError ?? "")),
		});
		// Sockets survive hibernation and restarts; their watches do not. They
		// are restored without holding up startup, which answers no request
		// until it ends: each loads its chat's events, which takes long for a
		// long chat. A watch the socket asks for meanwhile replaces its restored one.
		// One that fails closes its socket (`#watch`), so the app connects again.
		let watches = 0;
		for (const connection of this.getConnections<SocketState>()) {
			if (connection.state?.session) {
				watches++;
				void this.#sockets.watch(connection, connection.state.session, "watch restore failed").catch(() => undefined);
			}
		}
		void this.#conversations.resumeTasks().catch((error) => console.warn("resuming tasks failed", error));
		void this.#conversations.resumeDecided().catch((error) => console.warn("resuming decided approvals failed", error));
		void this.#conversations.armWatchdog().catch((error) => console.warn("arming the run watchdog failed", error));
		// Before any request, so the first one already finds them. It never throws: a failure is logged and tried again at the next start.
		await this.ensureTriggerEngine();
		// A tick cut short leaves no wake: the next is set again, where triggers are on.
		void Promise.resolve()
			.then(() => (this.triggerEngine() ? this.wakeTriggers() : undefined))
			.catch((error) => console.warn("setting the trigger wake failed", error));
		// The files apps watch: the computer's watches from before this start have no owner, and each socket that outlived it asks for its own again.
		this.computer.onFileEvent((event) => this.#sockets.fileEvent(event));
		this.computer.onWatchResumed((state) => this.#sockets.fileEvent({ event: "file_changed", path: state.path, kind: state.exists ? "modified" : "deleted", sha256: state.sha256, size: state.size, mtime: null }));
		void this.computer.call("unwatch_all", {}).catch(() => undefined);
		for (const connection of this.getConnections<SocketState>()) if (connection.state?.session) this.#sockets.send(connection, { type: "file_resync" });
		// A Sprite Pim started before it kept computers with a host is out of reach: the space has no computer until it gets another.
		const sprite = this.computer.forgetSprite();
		if (sprite) console.warn(JSON.stringify({ event: "pim.sprite_forgotten", owner: this.name, sprite }));
		console.log(JSON.stringify({ event: "pim.do_start", owner: this.name, ms: Date.now() - started, watches }));
	}

	/**
	 * Every message into a session goes through here, so the session list knows its activity; the user's
	 * first message also names it. A new run (from the user, a schedule or a connector) counts against the
	 * daily limit; an approval's outcome, or tasks' answers, continue work already counted, so they do
	 * not.
	 */
	async submitTo(
		session: string,
		content: UserInput,
		options: { operationId?: string; whenBusy?: "followUp" | "steer"; stable?: StableOperation },
		from: "user" | "pim" | "approval" | "task",
	): Promise<PiReceipt> {
		return this.#conversations.submitTo(session, content, options, from);
	}

	/** Whether spans wait to be sent in batches, as to an OTLP backend; a test's exporter takes each as it ends, with no timers left running. */
	protected batchSpans(): boolean {
		return true;
	}

	/** Where traces go: the OTLP endpoint the deployment sets, or nowhere. */
	protected spanExporter(): SpanExporter | null {
		return exporterFrom(this.env as TelemetryEnv);
	}

	/**
	 * Names a session with the utility model from `conversation`, its first
	 * message or, for a fork, what was said up to its first, in place of
	 * `current`, the title it has now. A rename meanwhile stays, and so does
	 * `current` when there is no utility model or it fails.
	 */
	async #nameSession(session: string, conversation: string, current: string): Promise<void> {
		try {
			if (!(await this.utilityModel())) return;
			const title = clipTitle(await this.utility(NAME_CHAT, conversation));
			if (this.store.retitleSession(session, current, title)) this.broadcastMessage({ type: "sessions" });
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.title", owner: this.name, error: errorMessage(error) }));
		}
	}

	/**
	 * An operation's result with what it sent the person in its conversation:
	 * only the messages of its run's successful `send_to_user` calls, in order.
	 * Final text is private working notes, never a fallback reply.
	 */
	async #withReplies(result: PiOperationResult): Promise<PiOperationResult & { replies: string[] }> {
		if (result.status !== "done") return { ...result, text: undefined, replies: [] };
		const conversation = await this.harness.conversation(result.session);
		const record = await (await this.harness.storage()).submissionByRequest(conversation.id, result.operationId, BACKGROUND_CONTEXT);
		const replies: string[] = [];
		if (record?.type === "input" && record.status === "done") {
			const entries = (await this.harness.session(result.session).messages()).filter((entry) => entry.id > record.entry);
			// Each send_to_user call's result: a refused one sent nothing; a sent one may say what its widgets showed.
			const results = new Map<string, { text: string; isError: boolean }>();
			for (const entry of entries) {
				const message = entry.model?.[0];
				if (message?.role !== "toolResult") continue;
				const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
				results.set(message.toolCallId, { text, isError: message.isError });
			}
			for (const entry of entries) {
				// A terminating send settles at its assistant entry, before its result entries.
				if (entry.id > record.answer) break;
				const message = entry.model?.[0];
				if (message?.role !== "assistant") continue;
				for (const part of message.content) {
					if (part.type !== "toolCall" || part.name !== SEND_TO_USER) continue;
					const outcome = results.get(part.id);
					if (!outcome || outcome.isError) continue;
					// What went to their inbox is not a reply here.
					if (typeof part.arguments.message !== "string" || part.arguments.channel === "email") continue;
					// A client that can't draw widgets or cards gets what they showed as text.
					const widgets = shownWidgets(outcome.text);
					replies.push([plainReply(part.arguments.message), ...widgets.map((widget) => widgetMarkdown(widget))].join("\n\n"));
				}
			}
		}
		return { ...result, text: replies.length > 0 ? replies.join("\n\n") : undefined, replies };
	}

	/** What this space holds: its database, and in R2 the images sent to it, its stored files, and its apps' and skills' files. */
	storedBytes(): number {
		return this.ctx.storage.sql.databaseSize + this.images.bytes() + this.legacyFiles.storedBytes() + this.artifacts.fileBytes() + this.skills.fileBytes();
	}

	/** Bytes the space may still grow by, or null for no limit. */
	#storageRoom(): number | null {
		const { storageBytes } = this.limits();
		return storageBytes === null ? null : storageBytes - this.storedBytes();
	}

	#storageRefusal(): string | null {
		const { storageBytes } = this.limits();
		const stored = this.storedBytes();
		if (storageBytes === null || stored < storageBytes) return null;
		return `Space storage quota exceeded: this space holds ${stored} bytes, over its ${storageBytes}. Delete chats or memories to make room.`;
	}

	/**
	 * This space's time triggers, once they are on (`enableTriggerEngine`, which `ensureTriggerEngine`
	 * calls in a person's own space as it starts and as they register); null otherwise, and then nothing
	 * of them exists: no table, no wake.
	 */
	triggerEngine(): TriggerEngine | null {
		return this.#triggers.triggerEngine();
	}

	/**
	 * Internal: revokes a grant of a computer source, for good. What its source observes is refused from
	 * now on, its observer stops at once, and an occurrence not yet handed on never is. False where there
	 * was no such grant, or the space's triggers are off.
	 */
	revokeComputerGrant(grantRef: string): boolean {
		return this.#triggers.revokeComputerGrant(grantRef);
	}

	/**
	 * Internal: turns this space's triggers on, whoever's space it is; `ensureTriggerEngine` is what
	 * decides who gets them.
	 */
	async enableTriggerEngine(): Promise<void> {
		return this.#triggers.enableTriggerEngine();
	}

	/**
	 * Internal: turns the space's triggers off, until it next starts or `enableTriggerEngine` is called.
	 * Nothing is handed on and no wake is kept until they are on again; everything they recorded stays,
	 * and runs already going go on.
	 */
	async disableTriggerEngine(): Promise<void> {
		return this.#triggers.disableTriggerEngine();
	}

	/**
	 * Turns triggers on in a person's own space, as it starts and as they register; a guest's space, or
	 * one not yet provisioned, is left without them. Idempotent: a space that has them keeps them and
	 * everything they recorded. It never throws, so a failure can't keep the space from starting: the
	 * space is left without them, as it was, the failure is logged, and the next start tries again.
	 */
	async ensureTriggerEngine(): Promise<void> {
		return this.#triggers.ensureTriggerEngine();
	}

	/** The triggers' clock. */
	protected triggerClock(): number {
		return Date.now();
	}

	/** Fired by the trigger wake: one tick of the coordinator, then the wake for its next. */
	async runTriggerTick(): Promise<void> {
		return this.#triggers.runTriggerTick();
	}

	/**
	 * Keeps the space's one trigger wake, a schedule like Pim's others, at when the coordinator next has
	 * work, at least a second on; with no work, or no engine, there is none.
	 */
	wakeTriggers(): Promise<void> {
		return this.#triggers.wakeTriggers();
	}

	/** This space as an MCP server (./mcp-server.ts): its clients talk with the majordomo, in a new chat or one they started before. */
	#mcpServer(request: Request): Promise<Response> {
		const majordomo = this.agents.majordomo();
		return serveMcp(request, {
			majordomo,
			send: async (message, conversation, signal) => {
				let session: string;
				if (conversation === undefined) session = await this.#conversations.startChat(majordomo, undefined);
				else {
					session = await this.#views.session(conversation).catch(() => "");
					if (!session || this.visits.bySession(session) || this.agents.ofSession(session).id !== majordomo.id) {
						throw new HttpError(404, `No conversation ${conversation} with ${majordomo.name}: leave out conversation to start one.`);
					}
				}
				// Tasks the majordomo hands out answer in updates, later: the client hears what it says of them too, while it waits.
				const updates = this.#conversations.listenForUpdates(session);
				const replies: string[] = [];
				const id = this.store.publicId(session);
				try {
					// A message to a chat still busy with an earlier one is answered after it.
					const receipt = await this.submitTo(session, userInput(message), { operationId: crypto.randomUUID(), whenBusy: "followUp" }, "user");
					let result = await this.#withReplies(await this.harness.wait(receipt.operationId, { session, signal }));
					replies.push(...result.replies);
					while (result.status === "done" && (updates.pending() || this.#tasks.awaitsAnswers(session))) {
						result = await this.#withReplies(await this.harness.wait(await updates.next(signal), { session, signal }));
						replies.push(...result.replies);
					}
					return { conversation: id, reply: { ...result, replies } };
				} catch (error) {
					if (!signal.aborted) throw error;
					return { conversation: id, reply: replies.length === 0 ? null : { status: "done", replies: [...replies, `${majordomo.name} is still waiting on some of this work. Ask again in a little while, in this conversation.`] } };
				} finally {
					updates.close();
				}
			},
		});
	}

	/** Tells the person: open apps through the socket, other devices by push. A notification that only repeats what a device already hears, such as a task's own reply, can skip the push. */
	async deliverNotification(notification: Notification, options: { sockets?: boolean; push?: boolean } = {}): Promise<void> {
		if (this.#closed()) return;
		const shown = this.#views.publicNotification(notification);
		if (options.sockets !== false) this.broadcastMessage({ type: "notification", notification: shown });
		if (options.push === false) return;
		// A mention shows on a device unless its chat is on screen, as a reply does.
		await this.#pushNotification({ ...notification, reply: notification.kind === "mention" });
	}

	/** This deployment's VAPID keys, made the first time a browser asks to subscribe. */
	async #vapidKeys(): Promise<VapidKeys> {
		const stored = this.store.meta("vapid_keys");
		if (stored) return JSON.parse(stored) as VapidKeys;
		const keys = await generateVapidKeys();
		this.store.setMeta("vapid_keys", JSON.stringify(keys));
		return keys;
	}

	/**
	 * Pushes a reply that no client has read since it was sent (see
	 * `responseSent`): an open chat marks its replies read, on any device, so
	 * only a person who isn't looking at the conversation is alerted. A later
	 * reply in the chat has its own check.
	 *
	 * Unless the person asked for every reply, only an answer is pushed: one
	 * to a message they sent, once the chat has finished working on it, so
	 * its progress and what agents do on their own stay quiet. An agent that
	 * needs the person says so with a mention or an approval.
	 */
	async pushReply(payload: { session: string; at: number; body: string }): Promise<void> {
		const info = this.store.sessionInfo(payload.session);
		if (this.#closed() || info?.responseAt !== payload.at || this.#views.hiddenSessions().has(payload.session)) return;
		const all = this.settings().deviceAlerts === "all";
		if (!all) {
			// Still at work: this may be progress, so look again, unless a later reply takes over.
			if (await this.#working(payload.session)) {
				await this.schedule(REPLY_PUSH_RETRY_SECONDS, REPLY_PUSH_CALLBACK, payload);
				return;
			}
			const asked = this.store.meta(awaitingKey(payload.session)) === "1";
			this.store.setMeta(awaitingKey(payload.session), "");
			if (!asked) return;
		}
		if (!info.unread) return;
		await this.#pushNotification({
			// The same reply pushed twice shows once.
			id: `reply-${this.store.publicId(payload.session)}-${payload.at}`,
			session: payload.session,
			title: info.title ?? this.#reports.agentRef(payload.session)?.name ?? "Pim",
			body: payload.body,
			reply: true,
			chatReply: true,
		});
	}

	/** Whether the chat, or an agent in its room, is at work on something now. */
	async #working(session: string): Promise<boolean> {
		const ids = new Set([session, ...this.#rooms.seats(session).map((seat) => seat.conversation)]);
		return (await this.harness.sessions.list()).some((info) => info.busy && ids.has(info.id));
	}

	/**
	 * Web Push to every browser that turned notifications on, even with the
	 * app closed. A `reply` shows unless its own chat is on screen; anything
	 * else shows only while the app is not, since the app shows it itself.
	 */
	async #pushNotification(notification: Pick<Notification, "id" | "session" | "title" | "body"> & { reply?: boolean; chatReply?: boolean }): Promise<void> {
		const subscriptions = this.store.pushSubscriptions();
		if (subscriptions.length === 0) return;
		const keys = await this.#vapidKeys();
		const subject = this.deployment().publicUrl ?? "https://pim.invalid";
		const { id, session, title, body, reply, agent } = this.#views.publicNotification(notification);
		// A device alert shows the opening sentences, enough to know what it is
		// about, and a push message holds about 4 KB; the full text is in the app.
		const plain = body.replace(/\*\*|`|^#+\s+/gm, "").replace(/\s*\n\s*/g, " ").trim();
		let opening = "";
		for (const { segment } of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(plain)) {
			if (opening !== "" && opening.length + segment.length > PUSH_BODY_LENGTH) break;
			opening += segment;
			if (opening.length >= PUSH_BODY_MINIMUM) break;
		}
		const message = { id, session, agent, title: title.slice(0, 120), body: opening.trim().slice(0, PUSH_BODY_LENGTH), ...(reply ? { reply } : {}), ...(notification.chatReply ? { kind: "reply" } : {}) };
		await Promise.all(
			subscriptions.map(async (subscription) => {
				try {
					if (!(await sendPush(subscription, message, keys, subject))) this.store.deletePushSubscription(subscription.endpoint);
				} catch (error) {
					console.warn("web push failed", error);
				}
			}),
		);
	}

	/** How long approvals filed under `policy` wait before they are approved; null waits for the user however long. */
	protected approvalTimeoutMs(policy: ApprovalPolicy = this.settings().approvalPolicy): number | null {
		return this.#approvals.approvalTimeoutMs(policy);
	}

	/**
	 * Applies a decision (made without the user, with `auto`). An approved action runs here. The decision
	 * wakes the tool call that filed it, which waits suspended, and the call returns the outcome; decided
	 * `inTurn`, the call returns it at once. A request whose call no longer waits, because its chat was
	 * stopped, deleted or reset, is denied without running.
	 */
	async decideApproval(
		id: string,
		decision: "approve" | "deny",
		note?: string,
		auto?: AutoApproval,
		options: { inTurn?: boolean } = {},
	): Promise<Approval> {
		return this.#approvals.decideApproval(id, decision, note, auto, options);
	}

	/**
	 * Approves `id`, and lets its tool run without asking from now on: for the owner, or, when a guest
	 * asked, for the guest's circle. Other calls to that tool from the same side still waiting are
	 * approved too.
	 */
	async alwaysApprove(id: string, note?: string): Promise<Approval> {
		return this.#approvals.alwaysApprove(id, note);
	}

	/**
	 * Every tool a permission can be set for, for the owner (`OWNER`) or a circle, with the permission
	 * that applies: for the owner, Pim's own tools that act on the world, since each agent has its own
	 * switches for its connectors' tools; for a circle, every connector's tools. What a circle remembers
	 * is the memory scopes ticked for it.
	 */
	toolPermissions(audience: string = OWNER): ToolPermissionInfo[] {
		return this.#approvals.toolPermissions(audience);
	}

	/** The tools of the connectors an agent works with, each with its switch for that agent. */
	agentToolPermissions(agent: Agent): ToolPermissionInfo[] {
		return this.#approvals.agentToolPermissions(agent);
	}

	/**
	 * An agent's switch for skills: on, its chats write and install skills (with approval, as
	 * `write_skill`'s permission has it), and the majordomo may for it; off, no agent changes its skills.
	 * On by default.
	 */
	agentSkillsPermission(agent: Agent): ToolPermissionInfo {
		return this.#approvals.agentSkillsPermission(agent);
	}

	/**
	 * Switches a connector's tool on or off for one agent, or back to its default (null); or, as Pim's own
	 * `write_skill` (`app` empty), its switch for skills. Switched on, a connector's tool is held to the
	 * tool's definition now. The agent's conversations see it from their next request.
	 */
	setAgentToolPermission(agent: Agent, app: string, tool: string, permission: ToolPermission | null): ToolPermissionInfo {
		return this.#approvals.setAgentToolPermission(agent, app, tool, permission);
	}

	/**
	 * Sets the permission of a tool for the owner (`OWNER`) or a circle: one of Pim's own (`app` empty),
	 * or, for a circle, a connector's; null goes back to its default. A connector tool's choice is tied to
	 * its definition now. The model sees the change from its next request; a guest, from their next call.
	 */
	setToolPermission(audience: string, app: string, tool: string, permission: ToolPermission | null): ToolPermissionInfo {
		return this.#approvals.setToolPermission(audience, app, tool, permission);
	}

	/**
	 * Puts someone in a circle, moving them from any other, and tells their space it may visit this one.
	 * The Worker calls it, having resolved their username.
	 */
	async addCircleMember(circleId: string, guest: Guest): Promise<Member> {
		return this.#sharing.addCircleMember(circleId, guest);
	}

	/** Takes someone out of the circles; their space is told, and their next call is refused either way. */
	async removeCircleMember(ownerId: string): Promise<boolean> {
		return this.#sharing.removeCircleMember(ownerId);
	}

	/**
	 * What a guest's space may know of this one and use: called by the guest's own space before each of
	 * their turns. Nothing but what the guest's circle was given.
	 */
	async guestBrief(guest: Guest): Promise<BriefResult> {
		return this.#sharing.guestBrief(guest);
	}

	/**
	 * The apps shared with a guest's circle, as their own space asks for them. Like a tool call, it's
	 * checked here every time: who they are, that their circle is on, and that the app is shared with it.
	 * Only the latest version is shared, and nothing of the chat it was made in.
	 */
	async guestArtifacts(guest: Guest): Promise<{ ok: true; artifacts: Omit<ArtifactSummary, "session">[] } | { ok: false; reason: string }> {
		return this.#sharing.guestArtifacts(guest);
	}

	/** An app shared with a guest, as its latest version. */
	async guestArtifact(
		guest: Guest,
		id: string,
	): Promise<
		{ ok: true; artifact: Omit<ArtifactSummary, "session">; files: ArtifactFile[]; address: string | null } | { ok: false; status: number; reason: string }
	> {
		return this.#sharing.guestArtifact(guest, id);
	}

	/** A guest's call on what an app shared with them keeps for everyone using it (`window.pim.shared`). */
	async guestArtifactShared(
		guest: Guest,
		id: string,
		call: { op: string; args: Record<string, unknown> },
	): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string }> {
		return this.#sharing.guestArtifactShared(guest, id, call);
	}

	/**
	 * A guest's tool call, from their own space: the hard boundary. The guest's circle and the tool's
	 * permission are checked here at every call, as they are now, whatever the guest's space was told
	 * before. `on` runs it, `ask` files an approval for the owner and answers at once (the decision goes
	 * to the guest's conversation later), anything else is refused.
	 */
	async guestCall(
		guest: Guest,
		call: { tool: string; args: Record<string, unknown>; session: string; callId: string },
	): Promise<GuestCallResult> {
		return this.#sharing.guestCall(guest, call);
	}

	/** Fired when an approval's timeout passes: unanswered, it is decided as it was filed to be. */
	async expireApproval(payload: { id: string }): Promise<void> {
		return this.#approvals.expireApproval(payload);
	}

	/** Guests' expiries scheduled under their old name. */
	async expireGuestApproval(payload: { id: string }): Promise<void> {
		return this.#sharing.expireGuestApproval(payload);
	}

	/** Fired when a review has taken too long: the person is asked. */
	async expireReview(payload: { id: string }): Promise<void> {
		return this.#approvals.expireReview(payload);
	}

	/** How long a run may make no progress before it is stopped. */
	protected stallMs(): number {
		return STALL_MS;
	}

	readonly #runWatch = new RunWatch(this.ctx.storage.sql);
	readonly #activityWatch = new ActivityWatch(this.ctx.storage.sql);

	/**
	 * A stalled coding thread wakes the chat of the agent that started it, once per quiet spell, and no
	 * other. A thread the person started has no parent to tell, and a thread that is no longer running has
	 * nothing left to stall: both are dropped, never sent to another chat.
	 */
	async codingStalled(threadId: string, activity: Activity): Promise<void> {
		return this.#coding.codingStalled(threadId, activity);
	}

	/**
	 * Stops the run of an agent that has made no progress for a long while, with a note to the agent, so
	 * that one call that never returns can't hold a chat and what is queued behind it for good. A run
	 * waiting for the person's decision, for tasks it handed out, or for a retry, makes none by design,
	 * and is left be: Stop ends those. Every run is noted, with when it was first seen at work, for the
	 * diagnostics to tell.
	 */
	async watchRuns(look?: { via: "delayed" | "scheduled" }): Promise<void> {
		return this.#conversations.watchRuns(look);
	}

	#agent(id: string): Agent {
		const agent = this.agents.get(id);
		if (!agent) throw new HttpError(404, `No agent ${id}`);
		return agent;
	}

	// Extensions: the abilities every agent has, and the widgets their chats show.

	/** The deployment's extensions (`pim.config.ts`). Tests add their own. */
	protected pimConfig(): PimConfig {
		return pimConfig;
	}

	/** Pim's own abilities' widgets, then the deployment's extensions, checked once. */
	get extensions(): PimExtensions {
		this.#extensions ??= new PimExtensions([
				// Pim's own: every chat can show their widgets.
				goalsWidgets(this.store),
				scheduleWidgets(this.#triggers.scheduleHost()),
				memoryWidgets(this.memory.store, (id) => this.#memoryAccess(this.agents.get(id) ?? this.agents.majordomo()).read.map((scope) => scope.key)),
			...this.pimConfig().extensions,
		]);
		return this.#extensions;
	}

	/** The extensions' abilities, built once for this space, by extension id. */
	get abilities(): Map<string, Ability> {
		if (this.#abilities) return this.#abilities;
		const pim = this;
		this.#abilities = new Map(
			this.extensions.list().flatMap((extension) => {
				if (!extension.ability) return [];
				const ability = extension.ability({
					data: this.extensionData.for(extension.id),
					get timeZone() {
						return pim.settings().timeZone;
					},
					notify: async (title, body) => {
						const notification = this.store.addNotification({ id: crypto.randomUUID(), session: null, title, body });
						await this.deliverNotification(notification);
					},
					space: this.name,
					get admin() {
						return pim.store.meta(OWNER_ADMIN_KEY) === "1";
					},
					ui: {
						routes: () => this.#routes,
						request: (request) => dispatch(this.#routes, request, new URL(request.url).pathname),
						audit: (entry) => this.store.addUiAudit(entry),
						audited: (limit) => this.store.uiAudit(limit),
					},
					conversationOf: (session) => {
						const { id, name, majordomo } = this.agents.ofSession(session);
						// An agent in a room is in the room's chat, which is where its work shows.
						return { chat: this.store.publicId(this.#rooms.of(session)?.room ?? session), agent: { id, name, majordomo } };
					},
					diagnostics: { report: (query) => this.diagnosticsReport(query), health: () => this.healthReport() },
					compute: { codingSandbox: () => this.#abilitiesOf.hasCodingSandbox() },
				});
				return [[extension.id, ability] as const];
			}),
		);
		return this.#abilities;
	}

	/** The ids of the workspace backends the deployment's environment sets up. */
	protected environmentWorkspaceIds(): string[] {
		return this.#abilitiesOf.environmentWorkspaceIds();
	}

	/**
	 * An approval as host operations (./hostops.ts) check it before they run a command: what it was for,
	 * and whether and by whom it was decided. Null when there is none.
	 */
	async hostopsApproval(id: string): Promise<{ action: string; argsJson: string; status: ApprovalStatus; decidedBy: ApprovalDecider | null; decidedAt: number | null; guest: boolean } | null> {
		return this.#reports.hostopsApproval(id);
	}

	/** What went wrong in this space lately, by kind, for the admin's majordomo (see ./diagnostics.ts). */
	diagnosticsReport(query: { since?: string; kind?: string; limit?: number; chat?: string }) {
		return this.#reports.diagnosticsReport(query);
	}

	/**
	 * How this Pim is doing: its version, its Durable Object, what it holds and how the deployment is set,
	 * for the admin's majordomo. Addresses and keys are left out.
	 */
	async healthReport() {
		return this.#reports.healthReport();
	}

	/**
	 * The id of this space's majordomo, which host operations (./hostops.ts) check their caller against;
	 * null in an erased or guest's space.
	 */
	async majordomoId(): Promise<string | null> {
		return this.#sharing.majordomoId();
	}

	/**
	 * One of the owner's agents, with its uploaded icon, for the Worker to publish to the gallery: with
	 * its contacts, and theirs, which come with it, each by name and with its own uploaded icon.
	 */
	async agentToPublish(id: string): Promise<PublishedAgent | null> {
		return this.#sharing.agentToPublish(id);
	}

	/** Records which template an agent is published as; null once unpublished. */
	async setAgentPublished(id: string, template: string | null): Promise<void> {
		return this.#sharing.setAgentPublished(id, template);
	}

	/** The latest version of one of the owner's apps, for the Worker to publish to the gallery. */
	async artifactToPublish(id: string): Promise<ArtifactToPublish | null> {
		return this.#sharing.artifactToPublish(id);
	}

	/**
	 * A bridge call from an app someone published, which the owner opened from the gallery. Like an app
	 * shared with them, it keeps what it keeps for them here (under `gallery/<id>`), and uses their model
	 * and tools once they allow its version. It keeps nothing for everyone.
	 */
	async publishedArtifactCall(
		published: { id: string; sha256: string },
		call: { op: unknown; args: Record<string, unknown> },
	): Promise<{ ok: true; answer: unknown } | { ok: false; status: number; reason: string }> {
		return this.#sharing.publishedArtifactCall(published, call);
	}

	/** Lets the owner's model or a tool be used by a published app's version they opened. */
	async publishedArtifactGrant(
		published: { id: string; sha256: string },
		capability: unknown,
	): Promise<{ ok: true; granted: string } | { ok: false; status: number; reason: string }> {
		return this.#sharing.publishedArtifactGrant(published, capability);
	}

	/** Makes a published app one of the owner's: a new app with copies of its files, theirs to change. */
	async adoptArtifact(published: { title: string; kind: ArtifactKind; owner: string; files: readonly ArtifactFile[] }): Promise<ArtifactSummary> {
		return this.#sharing.adoptArtifact(published);
	}

	/**
	 * Makes a published template one of the owner's agents: a copy of it, theirs to change, with copies of
	 * the agents that come with it.
	 */
	async adoptTemplate(template: Omit<PublishedAgent, "image"> & { author: string; image: AgentIcon | null }): Promise<Agent> {
		return this.#sharing.adoptTemplate(template);
	}

	/**
	 * At registration: gives the person a copy of the agent the admin chose for everyone, its icon and the
	 * agents that come with it too, besides their majordomo.
	 */
	async adoptEveryonesAgent(agent: Omit<PublishedAgent, "id" | "image"> & { author: string; image: AgentIcon | null }): Promise<Agent> {
		return this.#sharing.adoptEveryonesAgent(agent);
	}

	/**
	 * At registration of a guest: their copy of the bot they joined through, on the bot's model, with the
	 * agents that come with it, and the bot's daily messages and tool calls as the space's limits on runs
	 * and tool calls. Their space never gets the agent everyone starts with.
	 */
	async adoptBot(bot: Omit<Bot, "icon" | "bundle"> & Pick<PublishedAgent, "bundle"> & { image: AgentIcon | null }): Promise<Agent> {
		return this.#sharing.adoptBot(bot);
	}

	/**
	 * A model the admin may give a bot's guests: one this Pim offers everyone, the deployment's or a
	 * provider the admin added for everyone, never the admin's own ChatGPT plan or providers.
	 */
	async botModel(provider: string, id: string): Promise<BotModel> {
		return this.#sharing.botModel(provider, id);
	}

	/** In a guest's space, the bot they joined through and their copy of it; null in anyone else's. */
	guestBot(): GuestBot | null {
		return this.#sharing.guestBot();
	}

	/**
	 * Brings a guest's copy of their bot up to what its author shared last: its name, description,
	 * instructions, connectors, look and model, and the daily messages and tool calls it allows. The
	 * agents that came with it stay as they came. Null when its link was turned off: the guest can read
	 * their chats, and start nothing more.
	 */
	async syncBot(bot: (Omit<Bot, "icon" | "bundle"> & { image: AgentIcon | null }) | null): Promise<void> {
		return this.#sharing.syncBot(bot);
	}

	/** From a host's space: its owner put this space's owner in a circle. */
	async shareReceived(host: Guest): Promise<void> {
		return this.#sharing.shareReceived(host);
	}

	/** From a host's space: this space's owner is no longer in its circles. */
	async shareRevoked(hostOwnerId: string): Promise<void> {
		return this.#sharing.shareRevoked(hostOwnerId);
	}

	/** From a host's space: the owner decided on something this space's owner asked for; it continues the visit. */
	async visitAnswer(hostOwnerId: string, session: string, message: string, operationId: string): Promise<void> {
		return this.#sharing.visitAnswer(hostOwnerId, session, message, operationId);
	}

	/** A visit's conversation, started on first use. */
	async startVisit(username: string): Promise<string> {
		return this.#sharing.startVisit(username);
	}

	tools(): ToolInfo[] {
		const gated = new Set(this.toolPermissions().flatMap((info) => (info.permission === "ask" ? [info.name] : [])));
		return this.registry
			.snapshot()
			.tools()
			.filter(({ extension }) => !extension.name.startsWith(VISIT_PREFIX))
			.map(({ tool }) => ({ name: tool.name, description: tool.description, requiresApproval: gated.has(tool.name) }));
	}

	// Hosting: what the Worker in front tells the space about its owner.

	/** Set while `deleteEverything` runs: the space takes nothing new. */
	#erasing = false;

	/**
	 * Whether the space is erased, or being erased. An erased space keeps
	 * only its mark and refuses everything: requests, sockets, alarms and the
	 * Worker's own writes. The check is here, in the one object every
	 * request reaches, so a request a Worker authorized before the deletion
	 * (or with an account it had cached) can't write after it.
	 */
	#closed(): boolean {
		return this.#erasing || this.store.erasedAt() !== null;
	}

	#assertOpen(): void {
		if (this.#closed()) throw new HttpError(410, "This space was erased");
	}

	/**
	 * Every request comes through the Worker, which names the owner it
	 * resolved: it must be this space's. One slower than `SLOW_REQUEST_MS` is
	 * logged when it passes that, in case it never ends, and when it ends.
	 */
	override async fetch(request: Request): Promise<Response> {
		const started = Date.now();
		const slow = (fields: Record<string, unknown>) =>
			this.#note("slow_request", { method: request.method, path: this.#routeOf(request.url), ...fields });
		const timer = setTimeout(() => slow({ ms: Date.now() - started, status: null }), SLOW_REQUEST_MS);
		let status: number | "error" = "error";
		try {
			const response = await this.#fetch(request);
			status = response.status;
			return response;
		} finally {
			clearTimeout(timer);
			const ms = Date.now() - started;
			if (ms > SLOW_REQUEST_MS) slow({ ms, status });
		}
	}

	/** A request's route, as logs name it: its pattern, or its first segment where no route of the space's own answers it. */
	#routeOf(url: string): string {
		const path = new URL(url).pathname;
		const route = routeOf(this.#routes, path) ?? routeOf(this.#triggers.triggerRoutes, path);
		if (route) return route;
		const [first, ...rest] = path.split("/").filter(Boolean);
		return `/${first ?? ""}${rest.length > 0 ? "/…" : ""}`;
	}

	async #fetch(request: Request): Promise<Response> {
		if (request.headers.get(OWNER_HEADER) !== this.name) {
			console.error(JSON.stringify({ event: "pim.misrouted", agent: this.name }));
			return Response.json({ error: "This request is not for this space" }, { status: 421 });
		}
		if (this.#closed()) return Response.json({ error: "This space was erased" }, { status: 410 });
		if (this.status() !== "active") return Response.json({ error: "This space is suspended" }, { status: 403 });
		if (new URL(request.url).pathname === COMPUTER_PATH) {
			// The person's computer connects with its own token, which the Worker passes along unchecked.
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "Computers connect with a WebSocket" }, { status: 426 });
			if (!(await this.computer.checkToken(request.headers.get(COMPUTER_TOKEN_HEADER)))) {
				return Response.json({ error: "This isn't the token of this space's computer" }, { status: 401 });
			}
			return super.fetch(request);
		}
		await this.#connectors.refreshCustomApps();
		return super.fetch(request);
	}

	status(): OwnerStatus {
		return this.store.meta(STATUS_KEY) === "suspended" ? "suspended" : "active";
	}

	/** An erased agent runs no scheduled work: none should be left, and none may start. */
	override async alarm(): Promise<void> {
		if (this.#closed()) return;
		return super.alarm();
	}

	/** Records who owns this space, and the name they gave when they joined, if they gave one, for their majordomo to greet them by. */
	async provision(profile: OwnerProfile, name: string | null = null): Promise<void> {
		this.#assertOpen();
		if (profile.ownerId !== this.name) throw new Error(`Owner ${profile.ownerId} is not this agent's (${this.name})`);
		this.store.setMeta(PROFILE_KEY, JSON.stringify(profile));
		if (name) this.store.setMeta(PERSON_NAME_KEY, name);
	}

	profile(): OwnerProfile | null {
		const json = this.store.meta(PROFILE_KEY);
		return json === undefined ? null : (JSON.parse(json) as OwnerProfile);
	}

	/** Changes the person's settings, as `PUT /settings` does; registration sets their time zone. */
	async applySettings(update: Record<string, unknown>): Promise<Settings> {
		this.#assertOpen();
		const before = this.settings().approvalPolicy;
		const themeIds = [ownThemes, ...this.pimConfig().extensions].flatMap((extension) => extension.themes?.map((theme) => theme.id) ?? []);
		const settings = updateSettings(this.store, this.#defaultSettings(), update, themeIds);
		// The approval tools say how a request is decided: they must say it the new way.
		if (settings.approvalPolicy !== before) this.#reinstallApprovals();
		// Open clients show what changed, such as the look of the app, whether the person or an agent changed it.
		this.broadcastMessage({ type: "settings" });
		return settings;
	}

	/** Suspends or restores the space. Suspending stops its runs and closes its sockets; its data stays. */
	async setStatus(status: OwnerStatus): Promise<void> {
		this.#assertOpen();
		if (status === "active") this.store.deleteMeta(STATUS_KEY);
		else this.store.setMeta(STATUS_KEY, status);
		if (status === "suspended") {
			for (const session of await this.harness.sessions.list()) await this.#conversations.abort(session.id);
			for (const connection of this.getConnections()) connection.close(4003, "Suspended");
		}
	}

	/** This space's own limits, over the deployment's; null goes back to the deployment's. */
	async setLimits(limits: Partial<Limits> | null): Promise<Limits> {
		this.#assertOpen();
		if (limits === null) this.store.deleteMeta(LIMITS_KEY);
		else this.store.setMeta(LIMITS_KEY, JSON.stringify(parseLimits(limits)));
		return this.limits();
	}

	/** What this space may use of the deployment's compute: the admin's default, with this space's own where the admin set it (`setComputeQuota`). Read fresh, as a workspace is about to be made on it. */
	async computeQuota(): Promise<ComputeQuota> {
		return resolveQuota(await this.env.Gallery.getByName("gallery").computeQuota(), this.#ownComputeQuota());
	}

	#ownComputeQuota(): Partial<ComputeQuota> | null {
		const own = this.store.meta(COMPUTE_QUOTA_KEY);
		return own === undefined ? null : (JSON.parse(own) as Partial<ComputeQuota>);
	}

	/** This space's own compute quota, over the deployment's; null goes back to the deployment's. Returns what applies now. */
	async setComputeQuota(quota: Partial<ComputeQuota> | null): Promise<ComputeQuota> {
		this.#assertOpen();
		if (quota === null) this.store.deleteMeta(COMPUTE_QUOTA_KEY);
		else this.store.setMeta(COMPUTE_QUOTA_KEY, JSON.stringify(parseComputeQuota(quota)));
		return this.computeQuota();
	}

	/**
	 * The person's compute: what they may use, whether the admin set it for them, and the sandbox minutes
	 * they have used by provider and month.
	 */
	async computeReport() {
		return this.#reports.computeReport();
	}

	/**
	 * What model calls have cost over the last `days` days (at most 400), from the daily rollup and the
	 * calls since it.
	 */
	usageCosts(days = 30) {
		return this.#reports.usageCosts(days);
	}

	/** Usage today and on recent days, with the limits it counts against. */
	usageReport(days = 30) {
		return this.#reports.usageReport(days);
	}

	/**
	 * Everything the person put in or the agent made, as JSON they can take elsewhere: conversations,
	 * memories, goals, schedules, approvals, notifications, connectors and settings. Credentials are not
	 * included: the ChatGPT plan's tokens, connectors' sign-ins, webhook secrets and push keys stay
	 * behind. JSON text, ready to download.
	 */
	async exportData(): Promise<string> {
		return this.#reports.exportData();
	}

	/**
	 * What of the person's data this space still holds; nothing once `deleteEverything` has run. A
	 * deletion counts as done only when this says so, since destroying the space ends the call that asked
	 * for it.
	 */
	async remainingData(): Promise<string[]> {
		return this.#reports.remainingData();
	}

	/** Whether the space is erased, and what of the person's data it still holds; a finished deletion is both. */
	async erasure(): Promise<{ sealed: boolean; remaining: string[] }> {
		return this.#reports.erasure();
	}

	/**
	 * Erases the space: stops its runs, ends connectors' event subscriptions, closes its sockets, wipes
	 * its storage (alarms included), then marks it erased, flushes the mark, and ends this instance, so
	 * nothing that was under way here can write afterwards. Later instances find the mark and refuse
	 * everything. The call that asked usually sees the instance end: check `erasure()` afterwards. Running
	 * it again on an erased agent wipes anything a request slipped in before the mark, and marks it again.
	 */
	async deleteEverything(): Promise<void> {
		return this.#reports.deleteEverything();
	}

	// HTTP API

	async onRequest(request: Request): Promise<Response> {
		// Checked again here, not only in `fetch`: erasure may have begun while the request was on its way in.
		if (this.#closed()) return Response.json({ error: "This space was erased" }, { status: 410 });
		const { pathname, search } = new URL(request.url);
		if (pathname.startsWith("/hosted/")) return this.#hostedRequest(request, pathname, search);
		if (pathname.startsWith("/hosted-origin/")) return this.#hostedOwnRequest(request, pathname, search);
		// Triggers' routes exist only where the space's triggers are on; elsewhere they are any unknown path's 404.
		if (TRIGGER_PATHS.test(pathname) && this.#triggers.triggerApi()) return dispatch(this.#triggers.triggerRoutes, request, pathname);
		return dispatch(this.#routes, request, pathname);
	}

	/**
	 * A request for an app's backend, made by the page it loaded
	 * (`/hosted/<id>/<token>/…`, see ./hosted.ts): the token is what lets it in,
	 * since the page sends no cookies. The Worker hands these over without
	 * knowing who asked.
	 */
	async #hostedRequest(request: Request, pathname: string, search: string): Promise<Response> {
		const match = /^\/hosted\/([0-9a-f-]{36})\/([^/]+)(\/.*)?$/.exec(pathname);
		const found = match ? this.artifacts.get(match[1]!) : undefined;
		if (!match || !found || found.kind !== "hosted" || !(await this.hosted.allows(found.id, match[2]!))) {
			return new Response("Open this app again from Pim.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
		}
		// A page's address with no trailing slash would make its relative addresses wrong.
		if (match[3] === undefined) return Response.redirect(`${new URL(request.url).origin}/hosted/${this.name}/${found.id}/${match[2]}/${search}`, 308);
		return this.hosted.relay(request, found.id, `${match[3]}${search}`, { prefix: `/hosted/${this.name}/${found.id}/${match[2]}/` });
	}

	/**
	 * A request for an app's backend at the app's own address
	 * (`/hosted-origin/<id>/…`, which the Worker makes of it): the cookie there
	 * says who is asking, and the app's access says whether they may, now.
	 * Without one who may, a page gets `401` and the Worker sends it to sign
	 * in to Pim.
	 */
	async #hostedOwnRequest(request: Request, pathname: string, search: string): Promise<Response> {
		const match = /^\/hosted-origin\/([0-9a-f-]{36})(\/.*)$/.exec(pathname);
		const found = match ? this.artifacts.get(match[1]!) : undefined;
		if (!match || !found || found.kind !== "hosted" || this.hosted.version(found.id) === undefined) {
			return new Response("This app isn't here.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
		}
		let visitor = null;
		const cookie = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${HOSTED_SESSION_COOKIE}=`));
		if (cookie) {
			const known = await this.hosted.visitor(found.id, cookie.slice(HOSTED_SESSION_COOKIE.length + 1));
			if (known && this.#hostedMayOpen(found.id, known.id)) visitor = known;
		}
		if (!visitor && this.hosted.access(found.id) !== "public") return new Response(null, { status: 401, headers: { "x-pim-sign-in": "1", "cache-control": "no-store" } });
		const url = new URL(request.url);
		return this.hosted.relay(request, found.id, `${match[2]}${search}`, { own: { host: request.headers.get("host") ?? url.host, proto: url.protocol.slice(0, -1), visitor } });
	}

	/** Whether a person may open an app at its own address now: its owner always, others as the app's access says. */
	#hostedMayOpen(id: string, person: string): boolean {
		if (person === this.name) return true;
		if (this.hosted.access(id) !== "circles") return false;
		const access = this.#sharing.guestAccess({ ownerId: person, username: "" });
		return access.ok && this.artifacts.circlesOf(id).includes(access.circle.id);
	}

	/**
	 * A person signed in to Pim asks to open an app at its own address, which
	 * the Worker has checked is them: they get a token for it, good for a
	 * minute, to trade for the app's cookie there. Asked every time, so what
	 * the app's access and circles say now decides.
	 */
	async hostedEnter(visitor: Guest, id: string): Promise<{ ok: true; token: string } | { ok: false; status: number; reason: string }> {
		if (this.#closed()) return { ok: false, status: 410, reason: "This account was deleted." };
		if (this.status() !== "active") return { ok: false, status: 403, reason: "This account is suspended." };
		const app = ARTIFACT_ID.test(id) ? this.artifacts.get(id) : undefined;
		if (!app || app.kind !== "hosted" || this.hosted.version(id) === undefined) return { ok: false, status: 404, reason: "This app isn't here." };
		if (!this.#hostedMayOpen(id, visitor.ownerId)) {
			return { ok: false, status: 403, reason: `${this.profile()?.username ?? "Its owner"} hasn't shared this app with you.` };
		}
		return { ok: true, token: await this.hosted.enterToken(id, { id: visitor.ownerId, name: visitor.username }) };
	}

	/** The cookie an app's own address keeps, for a token `hostedEnter` made; null for any other. */
	async hostedSession(id: string, token: string): Promise<{ cookie: string; maxAge: number } | null> {
		if (this.#closed() || this.status() !== "active") return null;
		return this.hosted.session(id, token);
	}

		readonly #routes: readonly Route[] = spaceRoutes(this.#routeHost());

	#describeSettings() {
		const settings = this.settings();
		const timeout = this.approvalTimeoutMs(settings.approvalPolicy);
		return { ...settings, approvalTimeoutSeconds: timeout === null ? null : timeout / 1000 };
	}

	/** How every agent works, and the person's agents: rebuilt when `update_agent` is switched off or on. */
	#agentExtension(services: PimServices) {
		return agentExtension(
			services,
			(session) => this.#conversations.roleOf(session),
			{
				list: () => this.agents.list(),
				apps: () => this.appDirectory(),
				create: (input) => this.agents.create(checkContacts(null, this.#connectors.checkApps(agentInput(input)), this.agents.list())),
				editor: this.agents,
				files: this.files,
			},
		);
	}

	/** The person's skills in their agents' chats: rebuilt when whether `write_skill` asks first changes. */
	#skillsExtension(services: PimServices) {
		return skillsExtension(services, this.#skillWriters, this.skills, this.files, this.computer.paired());
	}

	/**
	 * The tool that asks the person to grant a trigger's source on their
	 * computer, installed only while triggers' API exists, as their other
	 * tools are. Chats select it (`#selectAbilities`), so where the space's
	 * triggers are off nothing of it is in any chat.
	 */
	#installComputerGrants(services: PimServices): void {
		if (this.#triggers.triggerApi()) this.registry.install(computerGrantExtension(services, this.#triggers.computerGrantHost()));
		else if (this.registry.snapshot().extension(COMPUTER_GRANT_EXTENSION)) this.registry.uninstall({ name: COMPUTER_GRANT_EXTENSION });
	}

	/** Rebuilds the extensions whose tools describe the approval policy, once pi's registry has been set up. */
	#reinstallApprovals(): void {
		if (!this.registry.snapshot().extension("pim.approvals")) return;
		const services = this.services();
		this.registry.install(this.#agentExtension(services));
		this.registry.install(this.#skillsExtension(services));
		this.registry.install(approvalsExtension(services, this.#offeredActions()));
		this.#installComputerGrants(services);
		this.#installBrowser(services);
		this.#installDesktop();
		this.#abilitiesOf.installAbilities(services);
		this.#connectors.installApps();
	}

	/**
	 * A computer was paired or removed: the tools that use it come or go, from
	 * the next request, and open apps hear of it. Its connecting and dropping
	 * off change no tools.
	 */
	#computerChanged(): void {
		this.broadcastMessage({ type: "computer" });
		// Triggers on the computer follow the one paired now: with none, or another, they wait for it.
		this.#triggers.computerTriggers()?.refresh();
		if (!this.registry.snapshot().extension("pim.approvals")) return;
		// Replaced in place, so chats begun before see the change, as they do an approval policy's.
		this.registry.install(filesExtension(this.#files));
		this.registry.install(canvasExtension(this.#canvas));
		this.registry.install(hostedExtension(this.#hostedServices));
		this.#installImageGeneration();
		this.#reinstallApprovals();
	}

	/** The ChatGPT plan's images were connected or disconnected: `generate_image` changes models from the next request, in chats begun before too. */
	#imagesChanged(): void {
		if (!this.registry.snapshot().extension("pim.approvals")) return;
		this.#installImageGeneration();
		this.#reinstallApprovals();
	}

	#directory() {
		return this.env.Directory.getByName("directory");
	}

	/**
	 * Asks this Pim's computer host for the space's computer (./computer-host.ts),
	 * with a new token for it to connect with: the host makes it, or sets up
	 * the one it has again. It is paired from now, offline until it connects.
	 */
	async #provideComputer(): Promise<void> {
		const name = machineName(this.name);
		const token = await this.computer.provide(this.name, name, Date.now());
		await this.#directory().requestComputer(this.name, name, token);
		this.#computerChanged();
	}

	/** The computer host couldn't set the space's computer up: the person hears why, and can ask again. */
	async computerSetupFailed(message: string): Promise<void> {
		this.computer.setupFailed(message);
		this.broadcastMessage({ type: "computer" });
	}

	/** Asks the computer host to remove the space's computer, with everything on it, when it keeps one. */
	async #removeMachine(): Promise<void> {
		const machine = this.computer.machine();
		if (machine) await this.#directory().requestComputerRemoval(this.name, machine);
	}

	/** The browser's tools, while the person has a computer; clicking and typing follow their permissions. */
	#installBrowser(services: PimServices): void {
		if (!this.browser.available) {
			this.registry.install(defineExtension({ name: BROWSER_EXTENSION, tools: [] }));
			return;
		}
		this.registry.install(
			browserExtension(services, {
				browser: this.browser,
				saveScreenshot: async (path, png) => {
					this.#assertOpen();
					const target = path ?? `${FILES_ROOT}/screenshots/${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
					return (await this.files.write(target, png)).path;
				},
				localPath: (path) => this.computer.localPath(path),
			}),
		);
	}

	/** The desktop's tools, while the person's computer has a desktop agents can use. */
	#installDesktop(): void {
		this.registry.install(this.computer.desktop() ? desktopExtension(this.computer) : defineExtension({ name: DESKTOP_EXTENSION, tools: [] }));
	}

	/** The model `generate_image` draws with: `PIM_IMAGE_MODEL` on Workers AI, or null when it's off. */
	protected imageModel(): ImageModel | null {
		const { imageModel } = this.deployment();
		const ai = (this.env as AiEnv).AI;
		return imageModel && ai ? workersAiImageModel(ai, imageModel) : null;
	}

	/**
	 * How this space makes images: with the ChatGPT plan's images while it's
	 * signed in for them, else with the deployment's image model, saved to the
	 * person's files, on their computer. Null without a model or a computer.
	 * Each image counts as a model request.
	 */
	#imageServices(): ImageServices | null {
		const plan = this.codexImages.connected();
		const model = plan ? this.codexImages.model(this.computer) : this.imageModel();
		if (!model || !this.computer.paired()) return null;
		return {
			model,
			reserve: () => {
				this.#assertOpen();
				const reserved = this.usage.reserveModel(plan ? CHATGPT_PROVIDER : CLOUDFLARE_PROVIDER_ID, model.id);
				return reserved.ok ? null : reserved.refusal;
			},
			save: async (path, bytes) => (await this.files.write(path, bytes)).path,
		};
	}

	/** `generate_image`, as `#imageServices` makes images. */
	#installImageGeneration(): void {
		const plan = this.codexImages.connected();
		if (!(plan ? this.codexImages.model(this.computer) : this.imageModel())) return;
		const services = this.#imageServices();
		// Images are saved to the person's files, on their computer: without one, the extension is there with no tool.
		this.registry.install(services ? imageGenerationExtension(services) : defineExtension({ name: IMAGES_EXTENSION, tools: [] }));
	}

	/**
	 * The tools of one of the owner's agents they can share with a bot's guests, which then run here, as
	 * the owner: the tools of the agent's connected apps, and `generate_image` while this space makes
	 * images. Never the computer's own tools, which would open it to anyone.
	 */
	shareableTools(agent: Agent): BotTool[] {
		return this.#sharing.shareableTools(agent);
	}

	/** The tools named, as one of the owner's agents shares them now, and the names it can't share. */
	async botTools(agentId: string, names: readonly string[]): Promise<{ tools: BotTool[]; missing: string[] }> {
		return this.#sharing.botTools(agentId, names);
	}

	/**
	 * Runs a tool for a guest of one of the owner's bots, called by the guest's space: only one the bot
	 * shares now, as the owner, with their connections. An image is kept in the owner's files, in a folder
	 * of the guest's under `bots/`, which their chat reads it from (`botImage`). A tool the owner approves
	 * first runs only once they approve: the guest's `call` files an approval and gets null, and, woken by
	 * the decision, asks again and gets the outcome (`#askForBotGuest`).
	 */
	async runBotTool(botId: string, guest: string, name: string, args: Record<string, unknown>, call: BotToolCall | null = null): Promise<BotToolResult | null> {
		return this.#sharing.runBotTool(botId, guest, name, args, call);
	}

	/**
	 * In a guest's space: whether a call to one of their bot's tools still waits for the bot's author
	 * (`owner`) to decide.
	 */
	async botCallWaits(owner: string, session: string, callId: string): Promise<boolean> {
		return this.#sharing.botCallWaits(owner, session, callId);
	}

	/**
	 * In a guest's space: the bot's author decided about a call that waits for them. It runs again, and
	 * finds their decision.
	 */
	async botToolDecided(owner: string, session: string, callId: string): Promise<void> {
		return this.#sharing.botToolDecided(owner, session, callId);
	}

	/**
	 * An image a guest of one of the owner's bots had made, from the guest's own folder only, for their
	 * chat to show. Null for anything else, or while the owner's computer is offline.
	 */
	async botImage(botId: string, guest: string, path: string): Promise<{ name: string; type: string; bytes: Uint8Array } | null> {
		return this.#sharing.botImage(botId, guest, path);
	}

	#describeApps() {
		const catalog = this.apps.tools();
		const servers = this.apps.servers();
		const directory = this.appDirectory();
		const agents = this.agents.list().map((agent) => ({ name: agent.name, servers: new Set(this.#connectors.appsOf(agent).map((app) => serverFor(servers, app)?.id)) }));
		return servers.map((server) => ({
			...server,
			// The directory's connector it connects; null for one this Pim no longer offers.
			app: directory.find((app) => serverFor([server], app))?.ref ?? null,
			// The person's agents that list the connector: only their chats get its tools.
			agents: agents.filter((agent) => agent.servers.has(server.id)).map((agent) => agent.name),
			// Each agent has its own switches for them (`GET /permissions?agent=`).
			tools: catalog
				.filter((tool) => tool.serverId === server.id)
				.map((tool) => ({ name: toolName(server.id, tool.name), description: tool.description ?? null })),
		}));
	}

	/** Pim speaks only its own protocol (see `protocol.ts`) on its sockets. */
	shouldSendProtocolMessages(): boolean {
		return this.#sockets.shouldSendProtocolMessages();
	}

	/** The computer's connection is tagged, so the space finds it, and leaves it out of what it tells the app. */
	override getConnectionTags(_connection: Connection, ctx: ConnectionContext): string[] {
		return this.#sockets.getConnectionTags(_connection, ctx);
	}

	async onConnect(connection: Connection<SocketState>, ctx: ConnectionContext): Promise<void> {
		return this.#sockets.onConnect(connection, ctx);
	}

	async onMessage(connection: Connection<SocketState>, raw: WSMessage): Promise<void> {
		return this.#sockets.onMessage(connection, raw);
	}

	async onClose(connection: Connection): Promise<void> {
		return this.#sockets.onClose(connection);
	}

	async onError(connection: Connection): Promise<void> {
		return this.#sockets.onError(connection);
	}

	/**
	 * Tells every open app; the computer's connection, and those taking the browser over, showing the
	 * desktop or editing a note, speak other protocols.
	 */
	broadcastMessage(message: ServerMessage): void {
		return this.#sockets.broadcastMessage(message);
	}

	/** What the routes of the space's API needs of this space (src/space/routes.ts). */
	#routeHost(): SpaceRouteHost {
		const self = this;
		return {
			chosenModel: (...args) => self.chosenModel(...args),
			settings: (...args) => self.settings(...args),
			get store() { return self.store; },
			tools: (...args) => self.tools(...args),
			mcpServer: (...args) => self.#mcpServer(...args),
			hiddenSessions: (...args) => self.#views.hiddenSessions(...args),
			heldSessions: (...args) => self.#models.heldSessions(...args),
			heldErrors: (...args) => self.#conversations.heldErrors(...args),
			get harness() { return self.harness; },
			get visits() { return self.visits; },
			sessionModelInfo: (...args) => self.#views.sessionModelInfo(...args),
			agentRef: (...args) => self.#reports.agentRef(...args),
			roomInfo: (...args) => self.#conversations.roomInfo(...args),
			startedBy: (...args) => self.#abilitiesOf.startedBy(...args),
			continuedFrom: (...args) => self.#abilitiesOf.continuedFrom(...args),
			guestBot: (...args) => self.guestBot(...args),
			agent: (...args) => self.#agent(...args),
			get agents() { return self.agents; },
			startChat: (...args) => self.#conversations.startChat(...args),
			sessionInfo: (...args) => self.#views.sessionInfo(...args),
			session: (...args) => self.#views.session(...args),
			get rooms() { return self.#rooms; },
			forkTitle: (...args) => self.#views.forkTitle(...args),
			broadcastMessage: (...args) => self.broadcastMessage(...args),
			archive: (...args) => self.#conversations.archive(...args),
			unarchive: (...args) => self.#conversations.unarchive(...args),
			roomable: (...args) => self.#conversations.roomable(...args),
			roomOf: (...args) => self.#conversations.roomOf(...args),
			join: (...args) => self.#conversations.join(...args),
			leave: (...args) => self.#conversations.leave(...args),
			resumeHeld: (...args) => self.#models.resumeHeld(...args),
			utility: (...args) => self.utility(...args),
			conversationText: (...args) => self.#models.conversationText(...args),
			chatLink: (...args) => self.#views.chatLink(...args),
			assertOpen: (...args) => self.#assertOpen(...args),
			get chatLinks() { return self.chatLinks; },
			deleteImages: (...args) => self.#views.deleteImages(...args),
			sweepUiState: (...args) => self.#views.sweepUiState(...args),
			abort: (...args) => self.#conversations.abort(...args),
			get tasks() { return self.#tasks; },
			cancelTask: (...args) => self.#conversations.cancelTask(...args),
			denyPending: (...args) => self.#conversations.denyPending(...args),
			triggerApi: (...args) => self.#triggers.triggerApi(...args),
			scheduleHost: (...args) => self.#triggers.scheduleHost(...args),
			stopConnectorTriggers: (...args) => self.#triggers.stopConnectorTriggers(...args),
			turns: (...args) => self.#reports.turns(...args),
			uiBlocks: (...args) => self.#views.uiBlocks(...args),
			submitTo: (...args) => self.submitTo(...args),
			withReplies: (...args) => self.#withReplies(...args),
			publicTask: (...args) => self.#views.publicTask(...args),
			taskOf: (...args) => self.#views.taskOf(...args),
			stop: (...args) => self.#conversations.stop(...args),
			changeQueued: (...args) => self.#conversations.changeQueued(...args),
			changeSessionModel: (...args) => self.#views.changeSessionModel(...args),
			refreshCustomApps: (...args) => self.#connectors.refreshCustomApps(...args),
			get chatgpt() { return self.chatgpt; },
			modelCatalog: (...args) => self.modelCatalog(...args),
			defaultModel: (...args) => self.defaultModel(...args),
			hasWorkersAi: (...args) => self.#models.hasWorkersAi(...args),
			allowedModels: (...args) => self.#models.allowedModels(...args),
			get ai() { return self.ai; },
			customProviders: (...args) => self.customProviders(...args),
			defaultUtilityModel: (...args) => self.defaultUtilityModel(...args),
			utilityModel: (...args) => self.utilityModel(...args),
			utilityProvider: (...args) => self.#models.utilityProvider(...args),
			get codexImages() { return self.codexImages; },
			chooseModel: (...args) => self.chooseModel(...args),
			choice: (...args) => self.#models.choice(...args),
			workspaceFallbacks: (...args) => self.#models.workspaceFallbacks(...args),
			chooseModelFallbacks: (...args) => self.chooseModelFallbacks(...args),
			putOwnProvider: (...args) => self.#models.putOwnProvider(...args),
			providersChanged: (...args) => self.#models.providersChanged(...args),
			get email() { return self.email; },
			describeSettings: (...args) => self.#describeSettings(...args),
			applySettings: (...args) => self.applySettings(...args),
			usageReport: (...args) => self.usageReport(...args),
			computeReport: (...args) => self.computeReport(...args),
			usageCosts: (...args) => self.usageCosts(...args),
			artifactRequest: (...args) => self.#views.artifactRequest(...args),
			get artifacts() { return self.artifacts; },
			publicArtifact: (...args) => self.#views.publicArtifact(...args),
			artifact: (...args) => self.#views.artifact(...args),
			get hosted() { return self.hosted; },
			get notes() { return self.notes; },
			builtinOn: (...args) => self.#connectors.builtinOn(...args),
			publicSession: (...args) => self.#views.publicSession(...args),
			artifactVersion: (...args) => self.#views.artifactVersion(...args),
			get name() { return self.name; },
			artifactData: (...args) => self.#views.artifactData(...args),
			artifactBridge: (...args) => self.#views.artifactBridge(...args),
			grantArtifact: (...args) => self.#views.grantArtifact(...args),
			hostedApp: (...args) => self.#views.hostedApp(...args),
			get computer() { return self.computer; },
			deployment: (...args) => self.deployment(...args),
			circle: (...args) => self.#sharing.circle(...args),
			me: (...args) => self.#sharing.me(...args),
			pimOf: (...args) => self.#sharing.pimOf(...args),
			othersArtifact: (...args) => self.#sharing.othersArtifact(...args),
			closed: (...args) => self.#closed(...args),
			directory: (...args) => self.#directory(...args),
			provideComputer: (...args) => self.#provideComputer(...args),
			get displayControl() { return self.#displayControl; },
			computerChanged: (...args) => self.#computerChanged(...args),
			get files() { return self.files; },
			get browser() { return self.browser; },
			browserWindow: (...args) => self.#views.browserWindow(...args),
			browserIn: (...args) => self.#views.browserIn(...args),
			exportData: (...args) => self.exportData(...args),
			dropModels: (...args) => self.#models.dropModels(...args),
			syncModels: (...args) => self.#models.syncModels(...args),
			imagesChanged: (...args) => self.#imagesChanged(...args),
			get memory() { return self.memory; },
			memoryAccess: (...args) => self.#memoryAccess(...args),
			memoryScopes: (...args) => self.memoryScopes(...args),
			memoryScope: (...args) => self.#memoryScope(...args),
			startMemoryNap: (...args) => self.startMemoryNap(...args),
			get circles() { return self.circles; },
			scheduledTasks: (...args) => self.#triggers.scheduledTasks(...args),
			publicApproval: (...args) => self.#views.publicApproval(...args),
			alwaysApprove: (...args) => self.alwaysApprove(...args),
			decideApproval: (...args) => self.decideApproval(...args),
			agentToolPermissions: (...args) => self.agentToolPermissions(...args),
			agentSkillsPermission: (...args) => self.agentSkillsPermission(...args),
			toolPermissions: (...args) => self.toolPermissions(...args),
			setAgentToolPermission: (...args) => self.setAgentToolPermission(...args),
			setToolPermission: (...args) => self.setToolPermission(...args),
			shareableTools: (...args) => self.shareableTools(...args),
			checkSkills: (...args) => self.#connectors.checkSkills(...args),
			checkApps: (...args) => self.#connectors.checkApps(...args),
			checkNamedScopes: (...args) => self.#checkNamedScopes(...args),
			chooseAgentModel: (...args) => self.chooseAgentModel(...args),
			chooseAgentFallbacks: (...args) => self.chooseAgentFallbacks(...args),
			get skills() { return self.skills; },
			skillAgents: (...args) => self.#connectors.skillAgents(...args),
			describeSkill: (...args) => self.#connectors.describeSkill(...args),
			skill: (...args) => self.#connectors.skill(...args),
			get images() { return self.images; },
			suggestions: (...args) => self.#abilitiesOf.suggestions(...args),
			get extensions() { return self.extensions; },
			pimConfig: (...args) => self.pimConfig(...args),
			describeCircles: (...args) => self.#sharing.describeCircles(...args),
			tellRevoked: (...args) => self.#sharing.tellRevoked(...args),
			removeCircleMember: (...args) => self.removeCircleMember(...args),
			startVisit: (...args) => self.startVisit(...args),
			appDirectory: (...args) => self.appDirectory(...args),
			describeApps: (...args) => self.#describeApps(...args),
			get nativeApps() { return self.nativeApps; },
			env: (...args) => self.#connectors.env(...args),
			connectApp: (...args) => self.connectApp(...args),
			get apps() { return self.apps; },
			installApps: (...args) => self.#connectors.installApps(...args),
			disconnect: (...args) => self.#connectors.disconnect(...args),
			get catalog() { return self.catalog; },
			receiveConnectorEvent: (...args) => self.#triggers.receiveConnectorEvent(...args),
			vapidKeys: (...args) => self.#vapidKeys(...args),
			publicNotification: (...args) => self.#views.publicNotification(...args),
		};
	}

	/** What the space's approvals needs of this space (src/space/approvals.ts). */
	#approvalsHost(): ApprovalsHost {
		const self = this;
		return {
			decideApproval: (...args) => self.decideApproval(...args),
			get store() { return self.store; },
			broadcastMessage: (...args) => self.broadcastMessage(...args),
			publicApproval: (...args) => self.#views.publicApproval(...args),
			schedule: (when, callback, payload, options) => self.schedule(when, callback as never, payload, options),
			keepAliveWhile: (...args) => self.keepAliveWhile(...args),
			taskWaits: (...args) => self.#conversations.taskWaits(...args),
			deliverNotification: (...args) => self.deliverNotification(...args),
			settings: (...args) => self.settings(...args),
			get agents() { return self.agents; },
			assertOpen: (...args) => self.#assertOpen(...args),
			approvalWaitsOnBot: (...args) => self.#sharing.approvalWaitsOnBot(...args),
			get actions() { return self.actions; },
			pimOf: (...args) => self.#sharing.pimOf(...args),
			get name() { return self.name; },
			guestOutcome: (...args) => self.#sharing.guestOutcome(...args),
			selectAbilities: (...args) => self.#abilitiesOf.selectAbilities(...args),
			get tasks() { return self.#tasks; },
			tasksChanged: (...args) => self.#conversations.tasksChanged(...args),
			resumeTask: (...args) => self.#conversations.resumeTask(...args),
			get harness() { return self.harness; },
			setToolPermission: (...args) => self.setToolPermission(...args),
			offeredActions: (...args) => self.#offeredActions(...args),
			get ownActions() { return self.#ownActions; },
			get apps() { return self.apps; },
			get extensions() { return self.extensions; },
			get abilities() { return self.abilities; },
			appsOf: (...args) => self.#connectors.appsOf(...args),
			agentSkillsPermission: (...args) => self.agentSkillsPermission(...args),
			agentToolPermissions: (...args) => self.agentToolPermissions(...args),
			circle: (...args) => self.#sharing.circle(...args),
			reinstallApprovals: (...args) => self.#reinstallApprovals(...args),
			toolPermissions: (...args) => self.toolPermissions(...args),
			closed: (...args) => self.#closed(...args),
			agentModel: (...args) => self.agentModel(...args),
			get registry() { return self.registry; },
			get memory() { return self.memory; },
			submit: (...args) => self.#conversations.submit(...args),
			roleOf: (...args) => self.#conversations.roleOf(...args),
			taskUnderway: (...args) => self.#conversations.taskUnderway(...args),
		};
	}

	/** What the space's conversations needs of this space (src/space/conversations.ts). */
	#conversationsHost(): ConversationsHost {
		const self = this;
		return {
			assertOpen: (...args) => self.#assertOpen(...args),
			status: (...args) => self.status(...args),
			storageRefusal: (...args) => self.#storageRefusal(...args),
			get usage() { return self.usage; },
			get name() { return self.name; },
			get tasks() { return self.#tasks; },
			get visits() { return self.visits; },
			refreshVisit: (...args) => self.#sharing.refreshVisit(...args),
			get store() { return self.store; },
			keepAliveWhile: (...args) => self.keepAliveWhile(...args),
			nameSession: (...args) => self.#nameSession(...args),
			get harness() { return self.harness; },
			selectAbilities: (...args) => self.#abilitiesOf.selectAbilities(...args),
			get images() { return self.images; },
			broadcastMessage: (...args) => self.broadcastMessage(...args),
			get telemetry() { return self.telemetry; },
			get agents() { return self.agents; },
			workspaceFallbacks: (...args) => self.#models.workspaceFallbacks(...args),
			runModel: (...args) => self.#models.runModel(...args),
			get computer() { return self.computer; },
			limits: (...args) => self.limits(...args),
			hiddenSessions: (...args) => self.#views.hiddenSessions(...args),
			sessionModel: (...args) => self.sessionModel(...args),
			agentToolPermissions: (...args) => self.agentToolPermissions(...args),
			get abilities() { return self.abilities; },
			get rooms() { return self.#rooms; },
			withReplies: (...args) => self.#withReplies(...args),
			submitTo: (...args) => self.submitTo(...args),
			resumeHeld: (...args) => self.#models.resumeHeld(...args),
			profile: (...args) => self.profile(...args),
			get env() { return self.env; },
			deliverNotification: (...args) => self.deliverNotification(...args),
			get joining() { return self.#joining; },
			heldSessions: (...args) => self.#models.heldSessions(...args),
			sessionModelInfo: (...args) => self.#views.sessionModelInfo(...args),
			publicApproval: (...args) => self.#views.publicApproval(...args),
			stallMs: (...args) => self.stallMs(...args),
			schedule: (when, callback, payload, options) => self.schedule(when, callback as never, payload, options),
			closed: (...args) => self.#closed(...args),
			get runWatch() { return self.#runWatch; },
			note: (...args) => self.#note(...args),
			get running() { return self.#approvals.running; },
		};
	}

	/** What the space's models needs of this space (src/space/models.ts). */
	#modelsHost(): ModelsHost {
		const self = this;
		return {
			get rooms() { return self.#rooms; },
			taskApart: (...args) => self.#conversations.taskApart(...args),
			taskUnderway: (...args) => self.#conversations.taskUnderway(...args),
			broadcastMessage: (...args) => self.broadcastMessage(...args),
			keepAliveWhile: (...args) => self.keepAliveWhile(...args),
			get providerCooldowns() { return self.providerCooldowns; },
			fallbackModel: (...args) => self.fallbackModel(...args),
			retryAfterCooldown: (...args) => self.retryAfterCooldown(...args),
			closed: (...args) => self.#closed(...args),
			schedule: (when, callback, payload, options) => self.schedule(when, callback as never, payload, options),
			get harness() { return self.harness; },
			get agents() { return self.agents; },
			agentModel: (...args) => self.agentModel(...args),
			sessionModel: (...args) => self.sessionModel(...args),
			note: (...args) => self.#note(...args),
			resumeTask: (...args) => self.#conversations.resumeTask(...args),
			get credentials() { return self.credentials; },
			get ai() { return self.ai; },
			get chatgpt() { return self.chatgpt; },
			get catalogKept() { return self.#modelCatalog; },
			set catalogKept(value) { self.#modelCatalog = value; },
			models: (...args) => self.models(...args),
			get images() { return self.images; },
			get usage() { return self.usage; },
			get providerSessions() { return self.#providerSessions; },
			modelCatalog: (...args) => self.modelCatalog(...args),
			defaultModel: (...args) => self.defaultModel(...args),
			customProviders: (...args) => self.customProviders(...args),
			get store() { return self.store; },
			chooseModel: (...args) => self.chooseModel(...args),
			deployment: (...args) => self.deployment(...args),
			get env() { return self.env; },
			chosenModel: (...args) => self.chosenModel(...args),
			defaultUtilityModel: (...args) => self.defaultUtilityModel(...args),
			assertOpen: (...args) => self.#assertOpen(...args),
			status: (...args) => self.status(...args),
			utilityModel: (...args) => self.utilityModel(...args),
		};
	}

	/** What the space's connectors needs of this space (src/space/connectors.ts). */
	#connectorsHost(): ConnectorsHost {
		const self = this;
		return {
			get apps() { return self.apps; },
			get mcp() { return self.mcp; },
			get catalog() { return self.catalog; },
			get store() { return self.store; },
			get nativeApps() { return self.nativeApps; },
			addMcpServer: (serverName, url, options) => self.addMcpServer(serverName, url, options),
			get name() { return self.name; },
			removeMcpServer: (...args) => self.removeMcpServer(...args),
			get env() { return self.env; },
			get skills() { return self.skills; },
			get files() { return self.files; },
			roleOf: (...args) => self.#conversations.roleOf(...args),
			get watchHost() { return self.#triggers.watchHost; },
			get registry() { return self.registry; },
			migrateAlwaysApproved: (...args) => self.#approvals.migrateAlwaysApproved(...args),
			services: (...args) => self.services(...args),
			appDirectory: (...args) => self.appDirectory(...args),
			get extensions() { return self.extensions; },
			note: (...args) => self.#note(...args),
			reinstallApprovals: (...args) => self.#reinstallApprovals(...args),
			providersChanged: (...args) => self.#models.providersChanged(...args),
			get artifacts() { return self.artifacts; },
			get notes() { return self.notes; },
			assertOpen: (...args) => self.#assertOpen(...args),
			get agents() { return self.agents; },
		};
	}

	/** What what the space reports and hands over needs of this space (src/space/reports.ts). */
	#reportsHost(): ReportsHost {
		const self = this;
		return {
			closed: (...args) => self.#closed(...args),
			get store() { return self.store; },
			assertOpen: (...args) => self.#assertOpen(...args),
			get ctx() { return self.ctx; },
			get diagnosticEvents() { return self.diagnosticEvents; },
			heldSessions: (...args) => self.#models.heldSessions(...args),
			heldErrors: (...args) => self.#conversations.heldErrors(...args),
			roleOf: (...args) => self.#conversations.roleOf(...args),
			triggerEngine: (...args) => self.triggerEngine(...args),
			get apps() { return self.apps; },
			get env() { return self.env; },
			get name() { return self.name; },
			get harness() { return self.harness; },
			get runWatch() { return self.#runWatch; },
			get tasks() { return self.#tasks; },
			get agents() { return self.agents; },
			scheduledTasks: (...args) => self.#triggers.scheduledTasks(...args),
			get visits() { return self.visits; },
			ownComputeQuota: (...args) => self.#ownComputeQuota(...args),
			get providerSessions() { return self.#providerSessions; },
			get usage() { return self.usage; },
			triggerClock: (...args) => self.triggerClock(...args),
			limits: (...args) => self.limits(...args),
			storedBytes: (...args) => self.storedBytes(...args),
			get notes() { return self.notes; },
			profile: (...args) => self.profile(...args),
			settings: (...args) => self.settings(...args),
			chosenModel: (...args) => self.chosenModel(...args),
			customProviders: (...args) => self.customProviders(...args),
			memoryScopes: (...args) => self.memoryScopes(...args),
			get memory() { return self.memory; },
			publicSession: (...args) => self.#views.publicSession(...args),
			get extensionData() { return self.extensionData; },
			publicApproval: (...args) => self.#views.publicApproval(...args),
			describeCircles: (...args) => self.#sharing.describeCircles(...args),
			get circles() { return self.circles; },
			get artifacts() { return self.artifacts; },
			get legacyFiles() { return self.legacyFiles; },
			get skills() { return self.skills; },
			getMcpServers: (...args) => self.getMcpServers(...args),
			get images() { return self.images; },
			remainingData: (...args) => self.remainingData(...args),
			get erasing() { return self.#erasing; },
			set erasing(value) { self.#erasing = value; },
			getConnections: (...args) => self.getConnections(...args),
			get connectorSubscriptionsKept() { return self.#triggers.connectorSubscriptionsKept; },
			get nativeApps() { return self.nativeApps; },
			get browser() { return self.browser; },
			removeMachine: (...args) => self.#removeMachine(...args),
		};
	}

	/** What the space's abilities needs of this space (src/space/abilities.ts). */
	#abilitiesHost(): AbilitiesHost {
		const self = this;
		return {
			get env() { return self.env; },
			get codingSandboxes() { return self.#codingSandboxes; },
			set codingSandboxes(value) { self.#codingSandboxes = value; },
			environmentWorkspaceIds: (...args) => self.environmentWorkspaceIds(...args),
			get abilities() { return self.abilities; },
			get registry() { return self.registry; },
			get visits() { return self.visits; },
			taskApart: (...args) => self.#conversations.taskApart(...args),
			get agents() { return self.agents; },
			triggerApi: (...args) => self.#triggers.triggerApi(...args),
			appExtensionsOf: (...args) => self.#connectors.appExtensionsOf(...args),
			switchedOff: (...args) => self.#conversations.switchedOff(...args),
			get harness() { return self.harness; },
			refreshCustomApps: (...args) => self.#connectors.refreshCustomApps(...args),
			appDirectory: (...args) => self.appDirectory(...args),
			get memory() { return self.memory; },
			memoryAccess: (...args) => self.#memoryAccess(...args),
			get store() { return self.store; },
			get suggesting() { return self.#suggesting; },
			utilityStructured: (...args) => self.utilityStructured(...args),
			get extensions() { return self.extensions; },
			settings: (...args) => self.settings(...args),
			get extensionData() { return self.extensionData; },
			get tasks() { return self.#tasks; },
			roleOf: (...args) => self.#conversations.roleOf(...args),
			hiddenSessions: (...args) => self.#views.hiddenSessions(...args),
			get rooms() { return self.#rooms; },
			sessionModel: (...args) => self.sessionModel(...args),
			broadcastMessage: (...args) => self.broadcastMessage(...args),
		};
	}

	/** What what the API shows of the space needs of this space (src/space/views.ts). */
	#viewsHost(): ViewsHost {
		const self = this;
		return {
			roleOf: (...args) => self.#conversations.roleOf(...args),
			get store() { return self.store; },
			get tasks() { return self.#tasks; },
			get rooms() { return self.#rooms; },
			get harness() { return self.harness; },
			get images() { return self.images; },
			get chatLinks() { return self.chatLinks; },
			deployment: (...args) => self.deployment(...args),
			get name() { return self.name; },
			chooseSessionModel: (...args) => self.chooseSessionModel(...args),
			defaultModel: (...args) => self.defaultModel(...args),
			customProviders: (...args) => self.customProviders(...args),
			choice: (...args) => self.#models.choice(...args),
			allowedModels: (...args) => self.#models.allowedModels(...args),
			hasWorkersAi: (...args) => self.#models.hasWorkersAi(...args),
			get ai() { return self.ai; },
			sessionModel: (...args) => self.sessionModel(...args),
			get visits() { return self.visits; },
			get agents() { return self.agents; },
			taskApart: (...args) => self.#conversations.taskApart(...args),
			get browser() { return self.browser; },
			get artifacts() { return self.artifacts; },
			get apps() { return self.apps; },
			utility: (...args) => self.utility(...args),
			assertOpen: (...args) => self.#assertOpen(...args),
		};
	}

	/** What the space's WebSockets needs of this space (src/space/sockets.ts). */
	#socketsHost(): SocketsHost {
		const self = this;
		return {
			get artifacts() { return self.artifacts; },
			get notes() { return self.notes; },
			getConnections: (...args) => self.getConnections(...args),
			get store() { return self.store; },
			get computer() { return self.computer; },
			get displayControl() { return self.#displayControl; },
			get displayLookup() { return self.#displayLookup; },
			set displayLookup(value) { self.#displayLookup = value; },
			get orphanedScreens() { return self.#orphanedScreens; },
			get browser() { return self.browser; },
			browserWindow: (...args) => self.#views.browserWindow(...args),
			session: (...args) => self.#views.session(...args),
			tools: (...args) => self.tools(...args),
			get watchRequests() { return self.#watchRequests; },
			computerTriggers: (...args) => self.#triggers.computerTriggers(...args),
			computerChanged: (...args) => self.#computerChanged(...args),
			broadcastMessage: (...args) => self.broadcastMessage(...args),
			keepAliveWhile: (...args) => self.keepAliveWhile(...args),
			get legacyFiles() { return self.legacyFiles; },
			get files() { return self.files; },
			get harness() { return self.harness; },
			submitTo: (...args) => self.submitTo(...args),
			get canvasAsks() { return self.#canvasAsks; },
			get watches() { return self.#watches; },
			note: (...args) => self.#note(...args),
			get fileHolds() { return self.#fileHolds; },
			broadcast: (...args) => self.broadcast(...args),
		};
	}

	/** What the space's bridge to `@pim/triggers` needs of this space (src/space/triggers.ts). */
	#triggersHost(): TriggersHost {
		const self = this;
		return {
			get ctx() { return self.ctx; },
			roleOf: (...args) => self.#conversations.roleOf(...args),
			get agents() { return self.agents; },
			limits: (...args) => self.limits(...args),
			triggerClock: (...args) => self.triggerClock(...args),
			get store() { return self.store; },
			closed: (...args) => self.#closed(...args),
			get computer() { return self.computer; },
			deliverNotification: (...args) => self.deliverNotification(...args),
			get apps() { return self.apps; },
			get name() { return self.name; },
			triggerEngine: (...args) => self.triggerEngine(...args),
			getConnections: (...args) => self.getConnections(...args),
			wakeTriggers: (...args) => self.wakeTriggers(...args),
			assertOpen: (...args) => self.#assertOpen(...args),
			get registry() { return self.registry; },
			profile: (...args) => self.profile(...args),
			guestBot: (...args) => self.guestBot(...args),
			enableTriggerEngine: (...args) => self.enableTriggerEngine(...args),
			note: (...args) => self.#note(...args),
			deployment: (...args) => self.deployment(...args),
			appsOf: (...args) => self.#connectors.appsOf(...args),
			get catalog() { return self.catalog; },
			installComputerGrants: (...args) => self.#installComputerGrants(...args),
			services: (...args) => self.services(...args),
			get mcp() { return self.mcp; },
			get usage() { return self.usage; },
			listSchedules: (...args) => self.listSchedules(...args),
			cancelSchedule: (...args) => self.cancelSchedule(...args),
			schedule: (when, callback, payload, options) => self.schedule(when, callback as never, payload, options),
			status: (...args) => self.status(...args),
			hiddenSessions: (...args) => self.#views.hiddenSessions(...args),
			get visits() { return self.visits; },
			get harness() { return self.harness; },
			carriedOn: (...args) => self.#conversations.carriedOn(...args),
			startChat: (...args) => self.#conversations.startChat(...args),
			broadcastMessage: (...args) => self.broadcastMessage(...args),
			sessionModel: (...args) => self.sessionModel(...args),
			submitTo: (...args) => self.submitTo(...args),
		};
	}

	/** What the space's side of its coding threads needs of this space (src/space/coding.ts). */
	#codingHost(): CodingHost {
		const self = this;
		return {
			customProviders: (...args) => self.customProviders(...args),
			closed: (...args) => self.#closed(...args),
			chosenModel: (...args) => self.chosenModel(...args),
			modelCatalog: (...args) => self.modelCatalog(...args),
			broadcastMessage: (...args) => self.broadcastMessage(...args),
			get store() { return self.store; },
			get rooms() { return self.#rooms; },
			selectAbilities: (...args) => self.#abilitiesOf.selectAbilities(...args),
			submitTo: (...args) => self.submitTo(...args),
			carriedOn: (...args) => self.#conversations.carriedOn(...args),
			get name() { return self.name; },
			assertOpen: (...args) => self.#assertOpen(...args),
			publicApproval: (...args) => self.#views.publicApproval(...args),
			deliverNotification: (...args) => self.deliverNotification(...args),
			get ctx() { return self.ctx; },
			get env() { return self.env; },
			get activityWatch() { return self.#activityWatch; },
			note: (...args) => self.#note(...args),
			codingTurnEnded: (...args) => self.codingTurnEnded(...args),
		};
	}

	/** What what the space shares and receives needs of this space (src/space/sharing.ts). */
	#sharingHost(): SharingHost {
		const self = this;
		return {
			get circles() { return self.circles; },
			profile: (...args) => self.profile(...args),
			get name() { return self.name; },
			get env() { return self.env; },
			assertOpen: (...args) => self.#assertOpen(...args),
			closed: (...args) => self.#closed(...args),
			status: (...args) => self.status(...args),
			get apps() { return self.apps; },
			get store() { return self.store; },
			circleMemory: (...args) => self.#circleMemory(...args),
			get memory() { return self.memory; },
			settings: (...args) => self.settings(...args),
			get artifacts() { return self.artifacts; },
			get hosted() { return self.hosted; },
			artifactData: (...args) => self.#views.artifactData(...args),
			get visits() { return self.visits; },
			schedule: (when, callback, payload, options) => self.schedule(when, callback as never, payload, options),
			broadcastMessage: (...args) => self.broadcastMessage(...args),
			publicApproval: (...args) => self.#views.publicApproval(...args),
			deliverNotification: (...args) => self.deliverNotification(...args),
			expireApproval: (...args) => self.expireApproval(...args),
			guestBot: (...args) => self.guestBot(...args),
			get agents() { return self.agents; },
			artifactBridge: (...args) => self.#views.artifactBridge(...args),
			grantArtifact: (...args) => self.#views.grantArtifact(...args),
			refreshCustomApps: (...args) => self.#connectors.refreshCustomApps(...args),
			choice: (...args) => self.#models.choice(...args),
			chooseAgentModel: (...args) => self.chooseAgentModel(...args),
			installed: (...args) => self.#abilitiesOf.installed(...args),
			get registry() { return self.registry; },
			submitTo: (...args) => self.submitTo(...args),
			get harness() { return self.harness; },
			chosenModel: (...args) => self.chosenModel(...args),
			appsOf: (...args) => self.#connectors.appsOf(...args),
			imageServices: (...args) => self.#imageServices(...args),
			shareableTools: (...args) => self.shareableTools(...args),
			agent: (...args) => self.#agent(...args),
			waitingCall: (...args) => self.#approvals.waitingCall(...args),
			resumeTask: (...args) => self.#conversations.resumeTask(...args),
			get files() { return self.files; },
			get usage() { return self.usage; },
		};
	}
}
