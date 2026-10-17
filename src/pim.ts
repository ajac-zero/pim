import { Workspace } from "@cloudflare/computer";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, JsonValue, Model } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
	type AgentChange,
	type AgentEventStream,
	type ConversationId,
	type UserInput,
	createRegistry,
	defineExtension,
	type Extension,
	Harness,
	type HarnessSettings,
	type ModelRef,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { type AgentMcpOAuthProvider, Agent as DurableAgent, type Connection, type ConnectionContext, DurableObjectOAuthClientProvider, getAgentByName, type Schedule, type WSMessage } from "agents";
import { type PiModel, PiHarness, type PiOperationResult, type PiReceipt, ROOT_SESSION } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { ArtifactStore, artifactHeaders, downloadName, RESIZE_SCRIPT } from "./artifacts";
import { digestHex } from "./auth/store";
import { Email, type Mailer, mailerFrom } from "./email";
import { ImageStore, userInput } from "./images";
import { serveMcp } from "./mcp-server";
import {
	type Circle,
	CircleStore,
	GUEST_CALLS_PER_DAY,
	type Guest,
	MAX_CIRCLE_NAME,
	MAX_CIRCLES,
	MAX_MEMBERS,
	type Member,
} from "./circles";
import { CHATGPT_PROVIDER, ChatGPT, chatgptCredentials } from "./chatgpt";
import { SqlCredentialStore } from "./credentials";
import { AppCatalog } from "./extensions/app-catalog";
import { AppEvents, eventTools, watchAction } from "./extensions/app-events";
import { skillTools } from "./extensions/app-skills";
import {
	approvalsExtension,
	gatedTools,
	describeWait,
	type GatedAction,
	httpRequest,
	ownToolPermission,
	type ResolvedPermission,
	resolvePermission,
} from "./extensions/approvals";
import pimConfig from "../pim.config";
import { artifactsExtension, artifactsWidgets } from "./extensions/artifacts";
import { type FileServices, fileDeleteAction, filesExtension } from "./extensions/files";
import { browserClickAction, browserExtension, browserTypeAction } from "./extensions/browser";
import { appDirectory, type CustomApp, type DirectoryApp } from "./extensions/app-directory";
import { ExtensionDataStore } from "./extensions/data";
import { NativeApps } from "./extensions/native-apps";
import {
	type Ability,
	checkToolNames,
	isNativeApp,
	secretsOf,
	type NativeAppDefinition,
	type ToolWidget,
	type PimConfig,
	PimExtensions,
	type ShownWidget,
	type WidgetContext,
	localize,
	widgetMarkdown,
} from "./extensions/define";
import { goalsExtension, goalsWidgets } from "./extensions/goals";
import {
	APP_PREFIX,
	appExtensionName,
	appToolPermission,
	MCP_APPROVALS,
	type McpApproval,
	type McpBridge,
	type McpCapabilities,
	type McpResourceContent,
	type McpServerInfo,
	type McpToolInfo,
	mcpActions,
	mcpExtensions,
	serverFor,
	slug,
	summarizeCall,
	toolDefinition,
	toolName,
	toText,
} from "./extensions/mcp";
import { MESSAGING_EXTENSION, messagingExtension, SEND_TO_USER } from "./extensions/messaging";
import { createOptMem, memoryWidgets } from "./extensions/optmem";
import { blockName, halves, parseBlock } from "./extensions/optmem/cover";
import { byteLength, ENTRY_BYTES, entryLine } from "./extensions/optmem/store";
import { CREATE_AGENT, agentExtension, MANAGE_APPS, manageAppsAction, RENAME_AGENT, renameAgentAction, UPDATE_AGENT, updateAgentAction } from "./extensions/agents";
import { describeSchedule, SCHEDULE_EXTENSION, scheduleExtension, scheduleWidgets } from "./extensions/schedule";
import type { PimServices, ScheduledTaskPayload } from "./extensions/services";
import { webExtension } from "./extensions/web";
import { CODE_BACKEND, codeBackends, codeLoader, FILES_ROOT, Files, fileHeaders, MAX_UPLOAD_BYTES } from "./files";
import { PimBrowser } from "./browser";
import { dispatch, HttpError, readJson, type Route } from "./http";
import type { ClientMessage, ServerMessage, ToolInfo } from "./protocol";
import { generateVapidKeys, type PushSubscription, sendPush, validSubscription, type VapidKeys } from "./push";
import { type ApprovalPolicy, readSettings, type Settings, updateSettings } from "./settings";
import {
	type Approval,
	type GoalStatus,
	type Notification,
	OWNER,
	PimStore,
	TOOL_PERMISSIONS,
	type ToolPermission,
} from "./store";
import { type Agent, type AgentInput, AgentStore, agentInput, type TeamMember } from "./agents";
import type { AgentIcon } from "./gallery";
import { type Role, TEAM_EXTENSION, type TeamRun, TeamStore, teamExtension } from "./team";
import { CHAT_REPORT, DECIDE_APPROVAL, MAJORDOMO_EXTENSION, introduction, majordomoExtension, majordomoSetup, REVIEW_EXTENSION, setupMemories, reviewExtension } from "./majordomo";
import { projectEntries } from "./transcript";
import { conversationText, IMPROVE_PROMPT, NAME_CHAT, SUMMARIZE_CHAT, type UtilityTask } from "./utility";
import { deploymentLimits, type Limits, parseLimits, UsageMeter } from "./usage";
import { type BriefResult, type GuestBrief, type GuestCallResult, VISIT_PREFIX, VisitStore, visitExtension, visitExtensionName } from "./visits";

const SCHEDULED_TASK_CALLBACK = "runScheduledTask";

/** Pim's own widgets: every chat can show them. */
const BUILT_IN_WIDGETS = ["pim.goals", "pim.schedule", "pim.memory", "pim.artifacts"];

/** The widgets a `send_to_user` result says went with the message; none in a plain "Sent." */
function shownWidgets(result: string): ShownWidget[] {
	try {
		const parsed = JSON.parse(result) as { widgets?: unknown };
		return Array.isArray(parsed.widgets) ? (parsed.widgets as ShownWidget[]) : [];
	} catch {
		return [];
	}
}
/**
 * Set by the Worker on every request it forwards: the owner it resolved,
 * which must be the agent's own name. A request routed to the wrong agent is
 * refused rather than served.
 */
export const OWNER_HEADER = "x-pim-owner";

/** Where apps' sign-ins return, as `/mcp/callback/<owner>`, so the Worker knows whose Pim the callback is for. */
export const MCP_CALLBACK_PATH = "/mcp/callback";
/**
 * Where sign-ins to the apps extensions implement return, the same for
 * everyone so services can have it registered: `state` names the owner,
 * `<owner>.<nonce>`. Owner ids start with `o_`, so it is nobody's `/mcp/callback/<owner>`.
 */
export const APPS_CALLBACK_PATH = `${MCP_CALLBACK_PATH}/apps`;
/** Pim's client metadata document for sign-ins that take one, as `/mcp/client/<owner>`: it names that owner's callback. */
export const MCP_CLIENT_PATH = "/mcp/client";
/** Where the Worker sends `/mcp`: this Pim as an MCP server (./mcp-server.ts). */
export const MCP_SERVER_PATH = "/mcp-server";
/** Where apps deliver event webhooks, as `/mcp/events/<owner>/<watch id>`; signed, so served without the API token. The Pim sees `/mcp/events/<watch id>`. */
export const MCP_EVENTS_PATH = "/mcp/events/";
const WATCH_REFRESH_CALLBACK = "refreshAppWatch";
/** How long an approval waits for the user under the `auto` policy before it is granted, so background work never stalls. */
const APPROVAL_TIMEOUT_MS = 30_000;
/** Decides an approval its timeout reached, as it was filed to be decided. */
const APPROVAL_EXPIRY_CALLBACK = "expireApproval";
/** How long the majordomo has to decide another agent's request before the person is asked anyway. */
const REVIEW_MS = 5 * 60 * 1000;
const REVIEW_EXPIRY_CALLBACK = "expireReview";

/** A circle's permission row for reading the owner's memory. */
const MEMORY_TOOL = "memory";
/** How long a guest's request waits for the owner before it is denied. */
const GUEST_APPROVAL_MS = 24 * 60 * 60 * 1000;

/** A circle's name as given: trimmed, not empty, not long. */
function circleName(name: unknown): string {
	if (typeof name !== "string" || name.trim() === "") throw new HttpError(400, "name must be a non-empty string");
	if (name.trim().length > MAX_CIRCLE_NAME) throw new HttpError(400, `name must be at most ${MAX_CIRCLE_NAME} characters`);
	return name.trim();
}

/** Why an approval was decided without the user deciding: it timed out, or the user always approves its tool. */
type AutoApproval = "timeout" | "always" | "majordomo";

/** A tool a permission can be set for, as the API shows it. */
export type ToolPermissionInfo = ResolvedPermission & {
	/** The connected app's id; null for Pim's own tools. */
	readonly app: string | null;
	readonly appName: string | null;
	/** The tool's own name, which its permission is set by. */
	readonly tool: string;
	/** The name the model sees. */
	readonly name: string;
	readonly description: string | null;
	/** The app says the tool only reads. */
	readonly readOnly: boolean;
	/** The permissions it can have. */
	readonly choices: readonly ToolPermission[];
};

/** Whether the Pim works: a suspended one answers nothing and runs nothing until its operator lifts it. */
export type OwnerStatus = "active" | "suspended";

/** What registration tells a Pim about its owner when it provisions it. */
export type OwnerProfile = { readonly ownerId: string; readonly username: string; readonly publicUrl: string };
/** How long an erasure waits for runs to stop and apps to unsubscribe before wiping anyway. */
const ERASE_COURTESY_MS = 3_000;
/** `pim_meta` keys of the models chosen through the API: for chats, and the utility model. */
const MODEL_KEY = "model";
const UTILITY_MODEL_KEY = "utility_model";
/** `pim_meta` keys the Worker sets: the owner's profile, a suspension, the Pim's own limits. */
const PROFILE_KEY = "owner";
const STATUS_KEY = "status";
const LIMITS_KEY = "limits";
/** Tools of the Pim the person talks with that its team members don't get, though their extensions stay. */
const LEAD_ONLY_TOOLS = new Set(["watch_app_event", CREATE_AGENT, UPDATE_AGENT, RENAME_AGENT, MANAGE_APPS]);
/** Set once chats' agents come from the prompt's `agent` section, not from instructions stored in each chat. */
/** The admin's apps, as this Pim last read them from the gallery, and how long before it reads them again. */
const CUSTOM_APPS_KEY = "custom_apps";
const CUSTOM_APPS_TTL_MS = 60_000;
const AGENT_SECTION_KEY = "pim_section";
/** The day the person was last told a limit stopped background work. */
const LIMIT_NOTICE_KEY = "limit_notice";
/** The chat each new-chat task last started, so a retried firing doesn't start another. */
const SCHEDULED_CHATS_KEY = "scheduled_chats";
/** Set by the Worker on requests that carried the API token. */
export const AUTHORIZED_HEADER = "x-pim-authorized";
/** Accepts any JSON-RPC result: pim checks the shapes of extension results itself. */
const ANY_RESULT = { "~standard": { version: 1, vendor: "pim", validate: (value: unknown) => ({ value }) } };

const SESSION_ID = /^[1-9][0-9]{0,15}$/;
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;

/** An artifact API answer the browser must never keep: what it shows can be deleted, or the sign-in end. */
function noStore(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store, private", "x-content-type-options": "nosniff" } });
}
const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "done", "abandoned"];

type SocketState = { readonly session: string };

function clipTitle(text: string): string {
	const line = text.trim().split(/\r?\n/)[0]!.trim();
	return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

function textOf(content: UserInput): string {
	return typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
}

/** A session's first name: the start of the first thing the user said, until the utility model names it. */
function titleFrom(content: UserInput): string | undefined {
	const text = textOf(content);
	return text.trim() === "" ? undefined : clipTitle(text);
}

function sameModel(a: PiModel, b: PiModel): boolean {
	return a.provider === b.provider && a.id === b.id;
}

/** A model as the API shows it; `images` says whether it can see them. */
function describeModel(model: PiModel) {
	return {
		provider: model.provider,
		id: model.id,
		name: "name" in model && typeof model.name === "string" ? model.name : model.id,
		images: "input" in model && Array.isArray(model.input) && model.input.includes("image"),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The Pim. A deployment has exactly one instance, owned by the person who
 * deployed it. Its SQLite database holds pi's conversations, tasks and
 * transcripts, plus Pim's memories, goals, approvals and notifications.
 *
 * pi-durable runs every model turn and tool call as a durable task, and the
 * `PiHarness` lifecycle job wakes the object after an eviction so runs
 * resume where they stopped.
 */
export class Pim extends DurableAgent<Env> {
	readonly store = new PimStore(this.ctx.storage.sql);
	/** People this Pim's owner shares it with, in circles. */
	readonly circles = new CircleStore(this.ctx.storage.sql);
	/** Pims shared with this Pim's owner, and their conversations with them. */
	readonly visits = new VisitStore(this.ctx.storage.sql);
	/** The owner's agents: each with its own instructions, the majordomo first. */
	readonly agents = new AgentStore(this.ctx.storage.sql, () => {
		// The majordomo until the person names it: built on the deployment's default blueprint, or bare.
		const ref = this.extensions.defaultBlueprint;
		const blueprint = ref === null ? undefined : this.extensions.blueprint(ref);
		return { name: "Majordomo", description: "", instructions: "", apps: [], team: [], blueprint: blueprint ? ref : null };
	}, () => this.appDirectory());
	/** The tasks the agents' teams were given, each in a conversation of its own. */
	readonly team = new TeamStore(this.ctx.storage.sql);
	/** Images the person sent, in R2; their messages keep their URLs. */
	readonly images = new ImageStore({
		sql: this.ctx.storage.sql,
		bucket: this.env.IMAGES,
		owner: () => this.name,
		publicOrigin: () => this.env.PIM_PUBLIC_URL || this.store.meta("public_origin"),
		meta: { get: (key) => this.store.meta(key), set: (key, value) => this.store.setMeta(key, value) },
	});
	/** What the agent made for its owner, with every version. */
	readonly artifacts = new ArtifactStore(this.ctx.storage.sql, () => this.limits(), {
		storageRoom: () => {
			const { storageBytes } = this.limits();
			return storageBytes === null ? null : storageBytes - this.storedBytes();
		},
	});
	#workspace: Workspace | undefined;
	/** The person's files, which they and their agents share (see ./files.ts). */
	readonly files = new Files(() => this.#files.workspace());
	readonly #files: FileServices = {
		workspace: () => (this.#workspace ??= new Workspace({ storage: this.ctx.storage, output: false, backends: codeBackends(this.env) })),
		codeBackend: () => (codeLoader(this.env) ? CODE_BACKEND : null),
		assertOpen: () => this.#assertOpen(),
		storageRefusal: () => this.#storageRefusal(),
	};
	/** The browser the person's agents share (see ./browser.ts). */
	readonly browser = new PimBrowser(this.env.BROWSER as BrowserRun | undefined, {
		get: (key) => this.store.meta(key) || null,
		set: (key, value) => this.store.setMeta(key, value ?? ""),
	});
	readonly ai = createAI({ binding: this.env.AI });
	/** The person's email address, and emailing them there. */
	readonly email = new Email(this.store, () => this.mailer());
	/** Model credentials (the ChatGPT plan's tokens), refreshed by pi-ai. */
	readonly credentials = new SqlCredentialStore(this.store);
	readonly chatgpt = new ChatGPT(this.store, chatgptCredentials(this.credentials));
	#modelCatalog: Models | undefined;
	/** Long-term memory: an OptMem-style log and summary tree. */
	readonly memory = createOptMem({
		sql: this.ctx.storage.sql,
		timeZone: () => this.settings().timeZone,
		viewLines: Number(this.env.PIM_MEMORY_LINES) || undefined,
		compressionModel: () => this.memoryModel(),
	});
	readonly registry = createRegistry();
	#extensions: PimExtensions | undefined;
	/** Extensions' own data, each apart from the others'. */
	readonly extensionData = new ExtensionDataStore(this.ctx.storage.sql);
	#abilities: Map<string, Ability> | undefined;
	/** What this Pim has used, and its limits. */
	readonly usage = new UsageMeter({
		sql: this.ctx.storage.sql,
		limits: () => this.limits(),
		// The person's own plan: its tokens are theirs, not the deployment's.
		planProviders: [CHATGPT_PROVIDER],
	});
	/** The person's connections to apps extensions implement themselves, with their sign-ins. */
	readonly nativeApps = new NativeApps({
		sql: this.ctx.storage.sql,
		app: (ref) => {
			const app = this.extensions.app(ref);
			return app && isNativeApp(app) ? app : undefined;
		},
		secrets: (app) => this.#secrets(app),
		callbackUrl: () => `${this.env.PIM_PUBLIC_URL || this.store.meta("public_origin")}${APPS_CALLBACK_PATH}`,
		owner: () => this.name,
		changed: () => this.#installApps(),
	});
	/**
	 * Connected apps: the SDK's MCP client, and the apps extensions implement,
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
			// Work still under way on a Pim being erased acts on nobody's behalf.
			this.#assertOpen();
			if (this.nativeApps.has(serverId)) return this.nativeApps.call(serverId, name, args);
			return this.mcp.callTool({ serverId, name, arguments: args });
		},
		connect: (app) => this.connectApp(app),
		capabilities: (serverId) => this.mcp.mcpConnections[serverId]?.serverCapabilities as McpCapabilities | undefined,
		request: async (serverId, method, params) => {
			const connection = this.mcp.mcpConnections[serverId];
			if (!connection) throw new Error(`The app ${serverId} is not connected`);
			return connection.client.request({ method, params } as never, ANY_RESULT as never);
		},
		readResource: async (serverId, uri) =>
			(await this.mcp.readResource({ serverId, uri })) as { contents: readonly McpResourceContent[] },
	};
	/** Apps' skills and event types, cached in this object's database. */
	readonly catalog = new AppCatalog(this.apps, this.store);
	/** Watches on apps' events (MCP Events, webhook delivery). */
	readonly appEvents = new AppEvents({
		bridge: this.apps,
		store: this.store,
		catalog: this.catalog,
		publicUrl: () => this.env.PIM_PUBLIC_URL || this.store.meta("public_origin"),
		owner: () => this.name,
		scheduleRefresh: (id, at) => this.#scheduleWatchRefresh(id, at),
		submit: async (session, content, operationId) => {
			await this.submitTo(session, content, { operationId }, "pim");
		},
		notify: async (title, body) => {
			const notification = this.store.addNotification({ id: crypto.randomUUID(), session: null, title, body });
			await this.deliverNotification(notification);
		},
	});
	/** Pim's own actions; the extensions' come with their abilities. */
	readonly #ownActions: readonly GatedAction[] = [
		httpRequest as GatedAction,
		...mcpActions(this.apps),
		watchAction(this.apps, this.appEvents),
		updateAgentAction(this.agents),
		renameAgentAction(this.agents),
		manageAppsAction(this.agents, this.apps, () => this.appDirectory()),
		fileDeleteAction(this.#files),
		...(this.browser.available ? [browserClickAction(this.browser), browserTypeAction(this.browser)] : []),
	];

	/** Every action an approval can be for: Pim's own, and the extensions'. */
	get actions(): readonly GatedAction[] {
		return [...this.#ownActions, ...[...this.abilities.values()].flatMap((ability) => ability.actions ?? [])];
	}

	readonly harness = new PiHarness({
		harness: async ({ storage, context }) => {
			const services = this.services();
			this.#migrateAlwaysApproved();
			this.registry.install(this.#agentExtension(services));
			this.registry.install(goalsExtension(services));
			this.registry.install(scheduleExtension(services));
			this.registry.install(messagingExtension(services));
			this.registry.install(
				teamExtension({
					roleOf: (session) => this.#roleOf(session),
					runs: this.team,
					memberAgent: (member, agent) => this.#memberAgent(member, agent),
					ask: (conversation, task, operation) => this.#askMember(conversation, task, operation),
				}),
			);
			this.registry.install(
				majordomoExtension({
					chatAgent: (session) => (this.team.run(session) || this.visits.bySession(session) ? null : this.agents.ofSession(session)),
					agents: () => this.agents.list(),
					sendToAgent: (handoff) => this.#sendToAgent(handoff),
				}),
			);
			this.registry.install(
				reviewExtension({ majordomo: () => this.agents.majordomo(), decide: (conversation, decision, note) => this.#reviewDecision(conversation, decision, note) }),
			);
			this.registry.install(approvalsExtension(services, this.#ownActions));
			this.registry.install(webExtension({ ai: this.env.AI, searchProvider: this.env.PIM_WEB_SEARCH }));
			this.registry.install(artifactsExtension({ artifacts: this.artifacts, assertOpen: () => this.#assertOpen() }));
			this.registry.install(filesExtension(this.#files));
			this.#installBrowser(services);
			// Restored connections reconnect in the background after a wake; give them a moment.
			await this.mcp.waitForConnections({ timeout: 5_000 });
			this.#migrateAlwaysApproved();
			const apps = this.#appExtensions(services);
			this.registry.install(apps.apps);
			this.registry.install(this.memory.extension);
			// No extension's tool may take the name of one of Pim's, or another extension's.
			checkToolNames(
				[...this.abilities].map(([id, ability]) => ({ id, ability })),
				[
					...this.registry
						.snapshot()
						.tools()
						// A harness opened again finds the abilities installed already: they don't count against themselves.
						.filter(({ extension }) => !this.abilities.has(extension.name))
						.map(({ tool }) => tool.name),
					...this.#ownActions.map((action) => action.name),
				],
			);
			this.#installAbilities(services);
			// Last: the apps' tools come and go, and pi only appends cheaply at the end.
			this.#installAppTools(apps.tools);
			// Visits' tools, as their hosts last allowed, so a visit's run resumes with them; each turn asks again.
			const visitor = this.profile()?.username;
			for (const share of this.visits.shares()) {
				const brief = this.visits.brief(share.ownerId);
				if (visitor && brief && !share.revoked) this.#installVisit(brief, visitor);
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

	/** pi agent-event watches, by connection id. In memory: rebuilt in `onStart`. */
	readonly #watches = new Map<string, AgentEventStream>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.lifecycle.use(this.harness);
		// A new, removed, signed-in or failed app changes the tools: pi uses the new set from the next request.
		this.mcp.onServerStateChanged(() => {
			this.#installApps();
			// An app that just became ready gets its skills and event types read once.
			for (const server of this.apps.servers()) {
				if (server.state === "ready" && !this.catalog.known(server.id)) {
					void this.catalog.refresh(server.id).catch((error) => console.warn(`reading ${server.id}'s catalog failed`, error));
				}
			}
		});
	}

	/**
	 * Connects one of the directory's apps. A failed connection leaves
	 * nothing behind; `authUrl` is set when the user must sign in.
	 */
	async connectApp(app: DirectoryApp, options: { approval?: McpApproval } = {}): Promise<{ id: string; state: string; authUrl?: string }> {
		const { name, url } = app;
		// A connection is the app's, found by its server: another app with the same name gets one of its own.
		let id = slug(name);
		const existing = serverFor(this.apps.servers(), app);
		if (existing) id = existing.id;
		else if (this.apps.servers().some((server) => server.id === id)) id = `${id.slice(0, 15)}_${crypto.randomUUID().slice(0, 8)}`;
		if (existing && existing.state !== "ready") {
			// A connection that failed, or is still waiting for sign-in (an abandoned or expired one), is not connected: clear it so the user can try again.
			await this.#disconnect(id);
		} else if (existing) {
			throw new HttpError(409, `${name} is already connected`);
		}
		this.store.setMcpApproval(id, options.approval ?? "writes");
		try {
			if (url === null) return await this.nativeApps.connect(app.ref, id);
			const result = await this.addMcpServer(name, url, {
				id,
				// The owner in the path tells the Worker whose Pim the sign-in returns to.
				callbackPath: `${MCP_CALLBACK_PATH}/${this.name}`,
			});
			if (result.state === "ready") {
				await this.catalog.refresh(id).catch((error) => console.warn(`reading ${id}'s catalog failed`, error));
			}
			this.#installApps();
			return result;
		} catch (error) {
			await this.#disconnect(id);
			throw new HttpError(502, `Could not connect ${name}: ${errorMessage(error)}`);
		}
	}

	/** Ends a connection, MCP or native, and forgets its approval policy. */
	async #disconnect(id: string): Promise<void> {
		if (!this.nativeApps.remove(id)) await this.removeMcpServer(id).catch(() => undefined);
		this.store.deleteMcpApproval(id);
	}

	/** The deployment's secrets a native app names, from the Worker's environment. */
	#secrets(app: NativeAppDefinition): Record<string, string> {
		return this.#env(app.secrets ?? []);
	}

	/** Those of the Worker's environment variables that are set. */
	#env(names: readonly string[]): Record<string, string> {
		const env = this.env as unknown as Record<string, unknown>;
		return Object.fromEntries(names.flatMap((name) => (typeof env[name] === "string" && env[name] !== "" ? [[name, env[name] as string]] : [])));
	}

	/**
	 * Signs in to MCP servers as the SDK does, registering Pim with each,
	 * except for an app whose definition says otherwise (see
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
			const env = this.#env([client.id, ...(client.secret ? [client.secret] : [])]);
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

	#appExtras(services: PimServices) {
		return {
			catalog: this.catalog,
			tools: [...skillTools(this.apps, this.catalog), ...eventTools(this.apps, this.catalog, this.appEvents, services)],
		};
	}

	/** One pending renewal per watch: a new one replaces the old. */
	async #scheduleWatchRefresh(id: string, at: Date): Promise<void> {
		for (const schedule of await this.listSchedules()) {
			if (schedule.callback === WATCH_REFRESH_CALLBACK && (schedule.payload as { id?: string } | undefined)?.id === id) {
				await this.cancelSchedule(schedule.id);
			}
		}
		await this.schedule(at, WATCH_REFRESH_CALLBACK, { id });
	}

	/** Fired by a watch's renewal schedule. */
	async refreshAppWatch(payload: { id: string }): Promise<void> {
		await this.appEvents.refresh(payload.id);
	}

	/** Rebuilds the connected apps' extensions, once pi's registry has been set up. */
	#installApps(): void {
		if (!this.registry.snapshot().extension("pim.apps")) return;
		this.#migrateAlwaysApproved();
		// Same names: each replaces its installed extension in place, keeping the order.
		const apps = this.#appExtensions(this.services());
		this.registry.install(apps.apps);
		this.#installAppTools(apps.tools);
	}

	#appExtensions(services: PimServices) {
		return mcpExtensions(
			this.apps,
			services,
			this.#appExtras(services),
			(session) => this.#appsOf(this.#roleOf(session).agent),
			() => this.appDirectory(),
		);
	}

	/** Installs each ready app's tools as its own extension, and takes out those of apps that no longer are. */
	#installAppTools(tools: readonly Extension[]): void {
		const names = new Set(tools.map((extension) => extension.name));
		for (const extension of this.registry.snapshot().installed()) {
			if (extension.name.startsWith(APP_PREFIX) && !names.has(extension.name)) this.registry.uninstall(extension);
		}
		for (const extension of tools) this.registry.install(extension);
	}

	/** The apps an agent works with: those of the blueprint it builds on, then its own. */
	#appsOf(agent: Agent): DirectoryApp[] {
		const blueprint = agent.blueprint === null ? [] : (this.extensions.blueprint(agent.blueprint)?.apps ?? []);
		const directory = this.appDirectory();
		return [...new Set([...blueprint, ...agent.apps])].flatMap((ref) => directory.find((app) => app.ref === ref) ?? []);
	}

	/** The apps people on this deployment can connect: the extensions', then the admin's, as last read from the gallery. */
	appDirectory(): DirectoryApp[] {
		const custom = this.store.meta(CUSTOM_APPS_KEY);
		return appDirectory(this.extensions.list(), custom === undefined ? [] : (JSON.parse(custom) as CustomApp[])).filter((app) => {
			// An extension's app is offered once the deployment set every secret it needs.
			const names = secretsOf(this.extensions.app(app.ref));
			return names.every((name) => name in this.#env(names));
		});
	}

	#customAppsReadAt = 0;

	/** Reads the admin's apps from the gallery again, at most once a minute unless `now`. */
	async #refreshCustomApps(now = false): Promise<void> {
		if (!now && Date.now() - this.#customAppsReadAt < CUSTOM_APPS_TTL_MS) return;
		this.#customAppsReadAt = Date.now();
		try {
			const custom = JSON.stringify(await this.env.Gallery.getByName("gallery").customApps());
			if (custom !== this.store.meta(CUSTOM_APPS_KEY)) this.store.setMeta(CUSTOM_APPS_KEY, custom);
		} catch (error) {
			console.warn("reading the admin's apps failed", error);
		}
	}

	/** Apps given through the API must be in the directory. */
	#checkApps<T extends { apps: readonly string[] }>(input: T): T {
		const directory = this.appDirectory();
		const missing = input.apps.find((ref) => !directory.some((app) => app.ref === ref));
		if (missing) throw new HttpError(400, `This Pim offers no app ${missing}`);
		return input;
	}

	/** The extensions of the connected apps an agent works with. */
	#appExtensionsOf(agent: Agent): string[] {
		const servers = this.apps.servers();
		return this.#appsOf(agent).flatMap((app) => {
			const server = serverFor(servers, app);
			return server ? [appExtensionName(server.id)] : [];
		});
	}

	/**
	 * Extensions only some conversations select: abilities, by the agents that
	 * use them; apps, by the agents that list them; the majordomo's own, by its
	 * chats; and reviews', by the majordomo's reviews.
	 */
	#perPim(name: string): boolean {
		return this.abilities.has(name) || name.startsWith(APP_PREFIX) || name === MAJORDOMO_EXTENSION || name === REVIEW_EXTENSION;
	}

	/** pi's run policy, shared by every session. */
	protected harnessSettings(): HarnessSettings {
		const registry = this.registry;
		const perPim = (name: string) => this.#perPim(name);
		return {
			// Every extension but visits', abilities', apps' and the majordomo's: a visit's own conversation selects its
			// extension, and the chats of agents that use an ability or list an app, or of the majordomo, select it.
			get extensions() {
				return registry
					.snapshot()
					.installed()
					.filter((extension) => !extension.name.startsWith(VISIT_PREFIX) && !perPim(extension.name));
			},
			// 1, 2, 4, 8, 16 s: about 30 s for a rate-limited model to recover.
			retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
			// Fewer storage writes while streaming; a crash loses at most this window.
			progress: { partialIntervalMs: 250, outputIntervalMs: 250 },
		};
	}

	/** The model catalog pi resolves sessions' models against: Workers AI, and the ChatGPT plan. */
	protected models(): Models {
		const models = createModels({ credentials: this.credentials });
		models.setProvider(this.ai.provider);
		models.setProvider(this.chatgpt.provider());
		return models;
	}

	/**
	 * One catalog for pi and the API, so a token refresh is never run twice at
	 * once. Every request through it is metered, and gets the chat's images.
	 */
	modelCatalog(): Models {
		this.#modelCatalog ??= this.images.resolving(this.usage.meter(this.models()));
		return this.#modelCatalog;
	}

	/** The person's settings: their own, else the deployment's. */
	settings(): Settings {
		return readSettings(this.store, this.env);
	}

	/** The deployment's limits (`PIM_LIMITS`), with this Pim's own where its operator set them. */
	limits(): Limits {
		const own = this.store.meta(LIMITS_KEY);
		return { ...deploymentLimits(this.env.PIM_LIMITS), ...(own === undefined ? {} : (JSON.parse(own) as Partial<Limits>)) };
	}

	/**
	 * Platform models besides the default that sessions may use: `PIM_MODELS`,
	 * comma-separated. Empty allows any Workers AI or AI Gateway model, as a
	 * deployment that doesn't mind the cost; one with members lists the ones it pays for.
	 */
	#allowedModels(): string[] | null {
		const list = (this.env.PIM_MODELS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
		return list.length === 0 ? null : list;
	}

	/** How this deployment sends email (`EMAIL` and `PIM_EMAIL_FROM`); null when it can't. */
	protected mailer(): Mailer | null {
		return mailerFrom(this.env);
	}

	/** The deployment's model (`PIM_MODEL`), used whenever no other is chosen. */
	protected defaultModel(): PiModel {
		return this.ai(this.env.PIM_MODEL);
	}

	/** The model every session uses: the one chosen through the API, or the default. */
	chosenModel(): PiModel {
		const json = this.store.meta(MODEL_KEY);
		if (json !== undefined) {
			const { provider, id } = JSON.parse(json) as { provider: string; id: string };
			const model = this.modelCatalog().getModel(provider, id);
			if (model) return model;
		}
		return this.defaultModel();
	}

	/**
	 * A model from `GET /model`'s choices, by provider and id: the deployment's,
	 * one it allows besides, or one on the connected ChatGPT plan.
	 */
	async #choice(provider: string, id: string): Promise<PiModel> {
		const fallback = this.defaultModel();
		if (provider === fallback.provider && id === fallback.id) return fallback;
		if (provider === fallback.provider && this.#allowedModels()?.includes(id)) return this.ai(id);
		const model = this.modelCatalog().getModel(provider, id);
		if (!model) throw new HttpError(400, `No model ${provider}/${id}`);
		if (provider === CHATGPT_PROVIDER && !(await this.chatgpt.status()).connected) {
			throw new HttpError(409, "Sign in with ChatGPT first");
		}
		return model;
	}

	/** Makes `model` every session's model, and new sessions'; null goes back to the default. */
	async chooseModel(model: PiModel | null): Promise<PiModel> {
		if (model === null) this.store.deleteMeta(MODEL_KEY);
		else this.store.setMeta(MODEL_KEY, JSON.stringify({ provider: model.provider, id: model.id }));
		const chosen = this.chosenModel();
		for (const session of await this.harness.sessions.list()) {
			await this.harness.session(session.id).setModel(chosen);
		}
		return chosen;
	}

	/**
	 * The model that compresses memories: `PIM_MEMORY_MODEL`, else `PIM_MODEL`
	 * on Workers AI. Never the chosen model, so background work does not spend
	 * a ChatGPT plan.
	 */
	protected memoryModel(): ModelRef | undefined {
		const model = this.ai(this.env.PIM_MEMORY_MODEL || this.env.PIM_MODEL);
		return { provider: model.provider, modelId: model.id };
	}

	/**
	 * The deployment's utility model (`PIM_UTILITY_MODEL` on Workers AI), for
	 * side jobs such as naming chats (see ./utility.ts). Empty turns them off.
	 */
	protected defaultUtilityModel(): Model<Api> | undefined {
		return this.env.PIM_UTILITY_MODEL ? this.ai(this.env.PIM_UTILITY_MODEL) : undefined;
	}

	/**
	 * The utility model: the one chosen through the API, or the default.
	 * A ChatGPT model counts only while the plan is connected.
	 */
	async utilityModel(): Promise<Model<Api> | undefined> {
		const json = this.store.meta(UTILITY_MODEL_KEY);
		if (json !== undefined) {
			const { provider, id } = JSON.parse(json) as { provider: string; id: string };
			const model = this.modelCatalog().getModel(provider, id);
			if (model && (provider !== CHATGPT_PROVIDER || (await this.chatgpt.status()).connected)) return model;
		}
		return this.defaultUtilityModel();
	}

	/**
	 * Runs a side job on the utility model and returns its answer, cleaned as
	 * the task says. It counts against the daily model limits, but not as a run.
	 */
	async utility(task: UtilityTask, input: string): Promise<string> {
		this.#assertOpen();
		if (this.status() !== "active") throw new HttpError(403, "This Pim is suspended");
		const model = await this.utilityModel();
		if (!model) throw new HttpError(503, "This Pim has no utility model");
		const answer = await this.modelCatalog().completeSimple(
			model,
			{ systemPrompt: task.instructions, messages: [{ role: "user", content: input, timestamp: Date.now() }] },
			// A reasoning model thinks as little as it can; a cap on its tokens could cut off the answer.
			{ ...(model.reasoning ? { reasoning: "minimal" } : { maxTokens: task.maxTokens }), signal: AbortSignal.timeout(60_000) },
		);
		const text = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		const result = task.clean ? task.clean(text) : text.trim();
		if (answer.stopReason === "error" || result === "") {
			throw new HttpError(502, `The utility model couldn't answer: ${answer.errorMessage ?? "it said nothing"}`);
		}
		return result;
	}

	/** A session's conversation as the utility model reads it; 409 when there is nothing in it yet. */
	async #conversationText(session: string, limit: number): Promise<string> {
		const text = conversationText(projectEntries(await this.harness.session(session).messages()), limit);
		if (text === "") throw new HttpError(409, "This chat has no conversation yet");
		return text;
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
			// Read at each use: the person can change these while the Pim runs.
			get timeZone() {
				return pim.settings().timeZone;
			},
			get approvalTimeoutMs() {
				return pim.approvalTimeoutMs();
			},
			schedule: async (when, payload) => {
				const { schedules } = this.limits();
				if (schedules !== null && (await this.services().listSchedules()).length >= schedules) {
					throw new Error(`The limit of ${schedules} scheduled tasks is reached. Cancel one first.`);
				}
				return this.schedule(when, SCHEDULED_TASK_CALLBACK, payload);
			},
			listSchedules: async () =>
				(await this.listSchedules()).filter(
					(schedule) => schedule.callback === SCHEDULED_TASK_CALLBACK,
				) as Schedule<ScheduledTaskPayload>[],
			cancelSchedule: async (id) => {
				const schedule = await this.getScheduleById(id);
				if (schedule?.callback !== SCHEDULED_TASK_CALLBACK) return false;
				return this.cancelSchedule(id);
			},
			notify: (notification) => this.deliverNotification(notification),
			get emailEnabled() {
				return pim.mailer() !== null;
			},
			sendEmail: (mail) => {
				const origin = this.env.PIM_PUBLIC_URL || this.store.meta("public_origin");
				const link = origin ? `\n\n—\nFrom your Pim: ${new URL(`/chat/${mail.session}`, origin)}` : "";
				return this.email.send({ ...mail, text: `${mail.text}${link}` });
			},
			approvalFiled: (approval, isNew) => this.#approvalFiled(approval, isNew),
			permission: (approval) => this.#approvalPermission(approval),
			teamMember: (session) => {
				const run = this.team.run(session);
				return run ? { name: run.member, session: run.session } : null;
			},
			widgetsFor: (session) => this.#chatWidgets(session),
			showWidget: async (session, ref) => {
				const kept = this.store.keptWidget<ToolWidget>(session, ref);
				if (!kept) return this.#loadWidget(this.agents.ofSession(session), ref);
				const { title, ...content } = kept;
				return { id: ref, title, empty: "", ...content };
			},
			keepWidget: (session, widget) => this.store.keepWidget(session, widget),
			keptWidgets: (session) => (this.visits.bySession(session) || this.team.run(session) ? [] : this.store.keptWidgets(session)),
		};
	}

	async onStart(): Promise<void> {
		this.mcp.configureOAuthCallback({
			customHandler: (result) =>
				new Response(
					result.authSuccess
						? "<!doctype html><title>Connected</title><p>Connected. You can close this window and go back to Pim.</p>"
						: `<!doctype html><title>Not connected</title><p>Sign-in failed: ${String(result.authError ?? "unknown error").replace(/[<&]/g, "")}</p>`,
					{ status: result.authSuccess ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } },
				),
		});
		// Sockets survive hibernation and restarts; their watches do not.
		for (const connection of this.getConnections<SocketState>()) {
			if (connection.state?.session) await this.#watch(connection, connection.state.session);
		}
		// Members' answers after an approval that an eviction kept from their chats.
		for (const { run, operation } of this.team.reports()) void this.#report(run, operation);
	}

	/**
	 * Every message into a session goes through here, so the session list
	 * knows its activity; the user's first message also names it. A new run
	 * (from the user, a schedule or an app) counts against the daily limit;
	 * an approval's outcome continues the run that asked, so it does not.
	 */
	async submitTo(
		session: string,
		content: UserInput,
		options: { operationId?: string; whenBusy?: "followUp" | "steer" },
		from: "user" | "pim" | "approval",
	): Promise<PiReceipt> {
		this.#assertOpen();
		if (this.status() !== "active") throw new HttpError(403, "This Pim is suspended");
		// Checked and counted before the first await, so concurrent submissions can't all pass the same check.
		let run: string | undefined;
		if (from !== "approval") {
			const storage = this.#storageRefusal();
			const reserved = storage === null ? this.usage.reserveRun() : ({ ok: false, refusal: storage } as const);
			if (!reserved.ok) {
				console.warn(JSON.stringify({ event: "pim.limit", limit: "run", owner: this.name, from, reason: reserved.refusal }));
				throw new HttpError(429, reserved.refusal);
			}
			run = reserved.reservation;
		}
		let receipt: PiReceipt;
		try {
			// A visit goes on only as its host allows now: what it may use is asked anew before each turn.
			const visit = this.visits.bySession(session);
			if (visit) await this.#refreshVisit(visit.ownerId);
		} catch (error) {
			if (run !== undefined) this.usage.releaseRun(run);
			throw error;
		}
		const title = from === "user" && !this.visits.bySession(session) ? titleFrom(content) : undefined;
		const named = (this.store.sessionInfo(session)?.title ?? null) !== null;
		this.store.touchSession(session, title);
		if (title !== undefined && !named) void this.keepAliveWhile(() => this.#nameSession(session, textOf(content), title));
		let kept: string[] = [];
		try {
			await this.#selectAbilities(session);
			// Images go to R2; the message keeps their URLs.
			const stored = await this.images.keep(session, content);
			kept = stored.ids;
			receipt = await this.harness.submit(stored.content, { session, ...options });
		} catch (error) {
			if (run !== undefined) this.usage.releaseRun(run);
			await this.images.delete(kept);
			throw error;
		}
		// A retried submission (the same operation id) is not accepted again: one run, not two, and its images once.
		if (!receipt.accepted) {
			if (run !== undefined) this.usage.releaseRun(run);
			await this.images.delete(kept);
		}
		return receipt;
	}

	/**
	 * Names a session from its first message with the utility model, in place
	 * of `first`, the message's start. A rename meanwhile stays, and so does
	 * `first` when there is no utility model or it fails.
	 */
	async #nameSession(session: string, message: string, first: string): Promise<void> {
		try {
			if (!(await this.utilityModel())) return;
			const title = clipTitle(await this.utility(NAME_CHAT, `Person: ${message.slice(0, 2_000)}`));
			if (this.store.retitleSession(session, first, title)) this.broadcastMessage({ type: "sessions" });
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
					// A client that can't draw widgets gets what they showed as text.
					const widgets = shownWidgets(outcome.text);
					replies.push([part.arguments.message, ...widgets.map((widget) => widgetMarkdown(widget))].join("\n\n"));
				}
			}
		}
		return { ...result, text: replies.length > 0 ? replies.join("\n\n") : undefined, replies };
	}

	/** What this Pim holds: its database, and the images sent to it. */
	storedBytes(): number {
		return this.ctx.storage.sql.databaseSize + this.images.bytes();
	}

	#storageRefusal(): string | null {
		const { storageBytes } = this.limits();
		const stored = this.storedBytes();
		if (storageBytes === null || stored < storageBytes) return null;
		return `Pim storage quota exceeded: this Pim holds ${stored} bytes, over its ${storageBytes}. Delete chats or memories to make room.`;
	}

	// Background work

	/**
	 * Fired by `schedule_task` schedules: hands the instruction to the session
	 * that made it, or to a new chat with its agent, and tells the person it
	 * started with a notification that links to that chat. A firing a limit or
	 * a suspension refuses is skipped, not retried; the person hears about the
	 * limit once a day.
	 */
	async runScheduledTask(payload: ScheduledTaskPayload, schedule: Schedule<ScheduledTaskPayload>): Promise<void> {
		const label = payload.label ? ` "${payload.label}"` : "";
		// The same firing retried is one submission and one notification.
		const firing = `schedule:${schedule.id}:${schedule.time}`;
		let started: string | null = null;
		try {
			if (payload.newChat) started = await this.#scheduledChat(payload, schedule);
			await this.submitTo(
				started ?? payload.session,
				`[Scheduled task${label} ${schedule.id}] ${payload.instruction}`,
				{ operationId: firing },
				"pim",
			);
		} catch (error) {
			if (!(error instanceof HttpError)) throw error;
			// A skipped firing leaves no empty chat behind.
			if (started !== null) this.store.deleteSession(started);
			if (error.status === 429) await this.#tellLimitOnce(`Skipped scheduled task${label}`, error.message);
			return;
		}
		if (this.store.notification(firing)) return;
		const title = payload.label ?? payload.instruction;
		const notification = this.store.addNotification({
			id: firing,
			session: started ?? payload.session,
			title: `Scheduled task ran: ${title.length > 80 ? `${title.slice(0, 79)}…` : title}`,
			body: payload.label ? payload.instruction : "",
		});
		await this.deliverNotification(notification);
	}

	/** A firing's new chat: started on its first try, and the same one when the firing is retried. */
	async #scheduledChat(payload: ScheduledTaskPayload, schedule: Schedule<ScheduledTaskPayload>): Promise<string> {
		const last = this.#scheduledChats()[schedule.id];
		if (last?.time === schedule.time && !this.store.deletedSessions().has(last.session)) return last.session;
		const id = await this.#startChat(this.agents.ofSession(payload.session), clipTitle(payload.label ?? payload.instruction));
		const live = new Set((await this.listSchedules()).map((scheduled) => scheduled.id));
		// Read again after the awaits, and keep only schedules still pending, so the record stays one entry per task.
		const chats = Object.fromEntries(Object.entries(this.#scheduledChats()).filter(([scheduled]) => live.has(scheduled)));
		chats[schedule.id] = { time: schedule.time, session: id };
		this.store.setMeta(SCHEDULED_CHATS_KEY, JSON.stringify(chats));
		this.broadcastMessage({ type: "sessions" });
		return id;
	}

	/** The chat each new-chat task's latest firing started, by schedule. */
	#scheduledChats(): Record<string, { time: number; session: string }> {
		return JSON.parse(this.store.meta(SCHEDULED_CHATS_KEY) ?? "{}");
	}

	/** Starts a chat with `agent`, within the person's limit on chats. */
	async #startChat(agent: Agent, title: string | undefined, handoff?: { from: string; key: string }): Promise<string> {
		const { sessions } = this.limits();
		if (sessions !== null) {
			const hidden = this.#hiddenSessions();
			const open = (await this.harness.sessions.list()).filter((session) => !hidden.has(session.id)).length;
			if (open >= sessions) throw new HttpError(429, `You can have up to ${sessions} chats. Delete one first.`);
		}
		const { id } = await this.harness.sessions.create();
		await this.harness.session(id).setModel(this.chosenModel());
		this.agents.setSession(id, agent.id, handoff);
		this.store.touchSession(id, title);
		return id;
	}

	/** This Pim as an MCP server (./mcp-server.ts): its clients talk with the majordomo, in a new chat or one they started before. */
	#mcpServer(request: Request): Promise<Response> {
		const majordomo = this.agents.majordomo();
		return serveMcp(request, {
			majordomo,
			send: async (message, conversation, signal) => {
				let session: string;
				if (conversation === undefined) session = await this.#startChat(majordomo, undefined);
				else {
					session = await this.#session(conversation).catch(() => "");
					if (!session || this.visits.bySession(session) || this.agents.ofSession(session).id !== majordomo.id) {
						throw new HttpError(404, `No conversation ${conversation} with ${majordomo.name}: leave out conversation to start one.`);
					}
				}
				// A message to a chat still busy with an earlier one is answered after it.
				const receipt = await this.submitTo(session, userInput(message), { operationId: crypto.randomUUID(), whenBusy: "followUp" }, "user");
				try {
					return { conversation: session, reply: await this.#withReplies(await this.harness.wait(receipt.operationId, { session, signal })) };
				} catch (error) {
					if (signal.aborted) return { conversation: session, reply: null };
					throw error;
				}
			},
		});
	}

	/** One notification a day about work a limit stopped, so a frequent schedule doesn't flood the person. */
	async #tellLimitOnce(title: string, body: string): Promise<void> {
		const today = new Date().toISOString().slice(0, 10);
		if (this.store.meta(LIMIT_NOTICE_KEY) === today) return;
		this.store.setMeta(LIMIT_NOTICE_KEY, today);
		const notification = this.store.addNotification({ id: crypto.randomUUID(), session: null, title, body });
		await this.deliverNotification(notification);
	}

	async deliverNotification(notification: Notification, options: { sockets?: boolean } = {}): Promise<void> {
		if (this.#closed()) return;
		if (options.sockets !== false) this.broadcastMessage({ type: "notification", notification });
		await Promise.all([this.#pushNotification(notification), this.#postWebhook(notification)]);
	}

	/** This deployment's VAPID keys, made the first time a browser asks to subscribe. */
	async #vapidKeys(): Promise<VapidKeys> {
		const stored = this.store.meta("vapid_keys");
		if (stored) return JSON.parse(stored) as VapidKeys;
		const keys = await generateVapidKeys();
		this.store.setMeta("vapid_keys", JSON.stringify(keys));
		return keys;
	}

	/** Web Push to every browser that turned notifications on, even with the app closed. */
	async #pushNotification({ id, session, title, body }: Notification): Promise<void> {
		const subscriptions = this.store.pushSubscriptions();
		if (subscriptions.length === 0) return;
		const keys = await this.#vapidKeys();
		const subject = this.env.PIM_PUBLIC_URL || this.store.meta("public_origin") || "https://pim.invalid";
		// A push message holds about 4 KB; the full text is in the app.
		const message = { id, session, title: title.slice(0, 120), body: body.slice(0, 500) };
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

	async #postWebhook(notification: Notification): Promise<void> {
		const webhook = this.settings().notifyWebhook;
		if (!webhook) return;
		try {
			const response = await fetch(webhook, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ notification }),
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) console.warn(`notification webhook answered ${response.status}`);
		} catch (error) {
			console.warn("notification webhook failed", error);
		}
	}

	/**
	 * What a gated tool call returns once its approval is filed. A decided
	 * approval (a replayed call) returns its outcome; a tool the user lets run
	 * without asking runs now, and the turn goes on with its result. Otherwise
	 * the user is asked, once: the request goes to their open apps and devices,
	 * and an `auto` approval's timeout is set. Under the `majordomo` policy,
	 * another agent's request goes to the majordomo instead, which asks the
	 * user only if it must (see `#review`). The decision comes back later as
	 * a message (see `decideApproval`), so the turn need not wait for it.
	 */
	async #approvalFiled(approval: Approval, isNew: boolean): Promise<string> {
		if (approval.status !== "pending") return this.#outcome(approval);
		if (this.#approvalPermission(approval) === "on") {
			return this.#outcome(await this.decideApproval(approval.id, "approve", undefined, "always", { inTurn: true }));
		}
		if (isNew && this.#reviewable(approval)) {
			this.store.setApprovalReview(approval.id, { status: "reviewing", note: null });
			const reviewing = this.store.approval(approval.id)!;
			// Open apps show the request, and that the majordomo is on it; the person can still decide first.
			this.broadcastMessage({ type: "approval", approval: reviewing });
			await this.schedule(new Date(Date.now() + REVIEW_MS), REVIEW_EXPIRY_CALLBACK, { id: approval.id });
			void this.keepAliveWhile(() => this.#review(reviewing));
		}
		if (this.store.approval(approval.id)?.review) {
			const { name } = this.agents.majordomo();
			return `[Approval ${approval.id}] Asked ${name}, the person's majordomo, who decides for them or asks them: ${approval.summary}. The decision, with the result, will arrive in this conversation as a message starting with "[Approval ${approval.id}]". Don't call it again; go on with anything that doesn't depend on it.`;
		}
		if (isNew) {
			this.broadcastMessage({ type: "approval", approval });
			const notification = this.store.addNotification({
				id: crypto.randomUUID(),
				// A team member's request shows in the chat it works for.
				session: approval.member?.session ?? approval.session,
				title: "Pim needs your approval",
				body: approval.summary,
			});
			// Open apps show the request itself, from the approval just broadcast; this reaches the others.
			await this.deliverNotification(notification, { sockets: false });
		}
		// Again on a replay: an approval filed before timeouts were scheduled gets one too. Deciding twice is refused.
		if (approval.expiresAt !== null) await this.schedule(new Date(approval.expiresAt), APPROVAL_EXPIRY_CALLBACK, { id: approval.id });
		return `[Approval ${approval.id}] Asked the user: ${approval.summary}. Their decision, with the result, will arrive in this conversation as a message starting with "[Approval ${approval.id}]". Don't call it again; go on with anything that doesn't depend on it.`;
	}

	/** How long approvals filed under `policy` wait before they are approved; null waits for the user however long. */
	protected approvalTimeoutMs(policy: ApprovalPolicy = this.settings().approvalPolicy): number | null {
		return policy === "auto" ? APPROVAL_TIMEOUT_MS : null;
	}

	#outcome(approval: Approval): string {
		const majordomo = approval.decidedBy === "majordomo" ? this.agents.majordomo().name : null;
		const note = approval.note ? `\n${majordomo ? `${majordomo}'s` : "The user's"} note: ${approval.note}` : "";
		const waited = describeWait((approval.expiresAt ?? approval.createdAt) - approval.createdAt);
		if (approval.status === "denied") {
			const who =
				approval.decidedBy === "timeout"
					? `The user did not respond within ${waited}, so it was denied`
					: majordomo
						? `${majordomo}, the user's majordomo, denied it for them`
						: "The user denied";
			return `[Approval ${approval.id}] ${who}: ${approval.summary}${note}\nDo not perform this action.`;
		}
		const who =
			approval.decidedBy === "timeout"
				? `The user did not respond within ${waited}, so it was approved automatically`
				: approval.decidedBy === "always"
					? `The user always approves ${approval.tool}, so it was approved automatically`
					: majordomo
						? `${majordomo}, the user's majordomo, approved it for them`
						: "The user approved";
		return `[Approval ${approval.id}] ${who}: ${approval.summary}${note}\nResult:\n${approval.result ?? ""}`;
	}

	/**
	 * Applies a decision (made without the user, with `auto`). An approved
	 * action runs here. The outcome goes to the requesting conversation as a
	 * message, joining its run if one is going; decided `inTurn`, the tool
	 * call that filed it returns the outcome itself.
	 */
	async decideApproval(
		id: string,
		decision: "approve" | "deny",
		note?: string,
		auto?: AutoApproval,
		options: { inTurn?: boolean } = {},
	): Promise<Approval> {
		// An approval's timer can outlive the Pim's erasure; its action must not run.
		this.#assertOpen();
		const approval = this.store.approval(id);
		if (!approval) throw new HttpError(404, `No approval ${id}`);
		if (decision === "approve" && this.actions.find((action) => action.name === approval.action)?.explicitApproval) {
			if (auto) throw new HttpError(400, "This action requires an explicit decision for each request");
			if (this.#approvalPermission(approval) === "off") throw new HttpError(403, "This capability is turned off");
		}
		if (!this.store.decideApproval(id, decision === "approve" ? "approved" : "denied", note ?? null, auto ?? "user")) {
			throw new HttpError(409, `Approval ${id} is already ${approval.status}`);
		}
		if (decision === "approve") {
			const action = this.actions.find((candidate) => candidate.name === approval.action);
			let result: string;
			try {
				result = action
					? await this.keepAliveWhile(() => action.run(approval.args as never))
					: `The action ${approval.action} is no longer available.`;
			} catch (error) {
				result = `The action failed: ${errorMessage(error)}`;
			}
			this.store.recordApprovalResult(id, result);
		}
		const decided = this.store.approval(id)!;
		this.broadcastMessage({ type: "approval", approval: decided });
		if (decided.requestedBy) {
			// A guest asked: the outcome continues their visit, in their own Pim, on their own usage.
			try {
				await (await this.#pimOf(decided.requestedBy.ownerId)).visitAnswer(
					this.name,
					decided.session,
					this.#guestOutcome(decided),
					`approval:${this.name}:${id}`,
				);
			} catch (error) {
				console.warn(`telling ${decided.requestedBy.username} about approval ${id} failed`, error);
			}
			return decided;
		}
		if (!options.inTurn) {
			const operation = `approval:${id}`;
			await this.submitTo(approval.session, this.#outcome(decided), { operationId: operation, whenBusy: "steer" }, "approval");
			// A member whose task already ended answers its agent's chat once it has gone on; one still at work answers the task.
			const run = this.team.run(approval.session);
			if (run && run.status !== "running") {
				this.team.setStatus(run.conversation, "running");
				this.team.setReport(run.conversation, operation);
				void this.#report(run, operation);
			}
			// What an agent says next in a chat the majordomo started reaches the majordomo too.
			const from = this.agents.handedBy(approval.session);
			if (from) void this.#forwardHandoff(approval.session, from, operation);
		}
		return decided;
	}

	/**
	 * Approves `id`, and lets its tool run without asking from now on: for
	 * the owner, or, when a guest asked, for the guest's circle. Other calls to
	 * that tool from the same side still waiting are approved too.
	 */
	async alwaysApprove(id: string, note?: string): Promise<Approval> {
		const approval = this.store.approval(id);
		if (!approval) throw new HttpError(404, `No approval ${id}`);
		if (approval.status !== "pending") throw new HttpError(409, `Approval ${id} is already ${approval.status}`);
		if (this.actions.find((action) => action.name === approval.action)?.explicitApproval) {
			throw new HttpError(400, "This action requires an explicit decision for each request");
		}
		const { app, tool } = this.#approvalTool(approval);
		const audience = approval.requestedBy?.circle ?? OWNER;
		// Remembered first, so calls filed while this action runs are not asked about.
		this.setToolPermission(audience, app, tool, "on");
		for (const pending of this.store.approvals("pending")) {
			const other = this.#approvalTool(pending);
			if (pending.id === id || other.app !== app || other.tool !== tool) continue;
			if ((pending.requestedBy?.circle ?? OWNER) !== audience) continue;
			void this.decideApproval(pending.id, "approve", undefined, "always").catch((error) =>
				console.warn(`approving ${pending.id} failed`, error),
			);
		}
		return this.decideApproval(id, "approve", note);
	}

	// Tool permissions: whether Pim may use each tool that acts on the world or comes from an app,
	// for its owner and for each circle.

	/** Pim's own tools that ask first unless the user chooses otherwise; `mcp_call` is filed by the apps' tools. */
	#ownGatedActions(): GatedAction[] {
		return this.actions.filter((action) => action.name !== "mcp_call");
	}

	/** The tool an approval was filed for, as permissions name it: by its app and the app's own name for it. */
	#approvalTool(approval: Approval): { app: string; tool: string } {
		if (approval.action === "mcp_call") {
			const { server, tool } = approval.args as { server: string; tool: string };
			return { app: server, tool };
		}
		return { app: "", tool: approval.action };
	}

	/** The permission of the tool that filed an approval, for whoever asked; `ask` for an app tool that is gone. */
	#approvalPermission(approval: Approval): ToolPermission {
		const { app, tool } = this.#approvalTool(approval);
		if (app === "") {
			const permission = ownToolPermission(this.store, tool).permission;
			return permission === "on" && this.actions.find((action) => action.name === tool)?.explicitApproval ? "ask" : permission;
		}
		const server = this.apps.servers().find((candidate) => candidate.id === app);
		const info = this.apps.tools().find((candidate) => candidate.serverId === app && candidate.name === tool);
		return server && info ? appToolPermission(this.store, server, info, approval.requestedBy?.circle ?? OWNER).permission : "ask";
	}

	/** A circle, or 404. */
	#circle(id: string): Circle {
		const circle = this.circles.circle(id);
		if (!circle) throw new HttpError(404, `No circle ${id}`);
		return circle;
	}

	/**
	 * Every tool a permission can be set for, for the owner (`OWNER`) or a
	 * circle, with the permission that applies. A circle has its own row for
	 * memory, and none for Pim's tools that change its setup.
	 */
	toolPermissions(audience: string = OWNER): ToolPermissionInfo[] {
		const own: ToolPermissionInfo[] =
			audience === OWNER
				? this.#ownGatedActions().map((action) => ({
						app: null,
						appName: null,
						tool: action.name,
						name: action.name,
						description: action.description,
						readOnly: false,
						choices: action.explicitApproval ? ["off", "ask"] : TOOL_PERMISSIONS,
						...ownToolPermission(this.store, action.name),
					}))
				: [
						{
							app: null,
							appName: null,
							tool: MEMORY_TOOL,
							name: MEMORY_TOOL,
							description: "Read what Pim remembers about you: its memory view, and searching every memory.",
							readOnly: true,
							choices: ["off", "on"],
							...resolvePermission(this.store, audience, "", MEMORY_TOOL, "off", null),
						},
					];
		const servers = new Map(this.apps.servers().map((server) => [server.id, server]));
		const apps = this.apps.tools().flatMap((tool) => {
			const server = servers.get(tool.serverId);
			if (!server) return [];
			return [
				{
					app: server.id,
					appName: server.name,
					tool: tool.name,
					name: toolName(server.id, tool.name),
					description: tool.description ?? tool.annotations?.title ?? null,
					readOnly: tool.annotations?.readOnlyHint === true,
					choices: TOOL_PERMISSIONS,
					...appToolPermission(this.store, server, tool, audience),
				},
			];
		});
		return [...own, ...apps];
	}

	/**
	 * Sets the permission of a tool for the owner (`OWNER`) or a circle: one of
	 * Pim's own (`app` empty) or an app's; null goes back to its default. An app
	 * tool's choice is tied to its definition now. The model sees the change
	 * from its next request; a guest, from their next call.
	 */
	setToolPermission(audience: string, app: string, tool: string, permission: ToolPermission | null): ToolPermissionInfo {
		if (audience !== OWNER) this.#circle(audience);
		let definition: string | null = null;
		if (app === "") {
			const known = audience === OWNER ? this.#ownGatedActions().some((action) => action.name === tool) : tool === MEMORY_TOOL;
			if (!known) throw new HttpError(404, `No tool ${tool}`);
			if (tool === MEMORY_TOOL && permission === "ask") throw new HttpError(400, "Memory is either on or off");
			if (permission === "on" && this.#ownGatedActions().find((action) => action.name === tool)?.explicitApproval) {
				throw new HttpError(400, "This tool can only be off or ask: every change requires explicit approval");
			}
		} else {
			const info = this.apps.tools().find((candidate) => candidate.serverId === app && candidate.name === tool);
			if (!info) throw new HttpError(404, `No tool ${tool} in the app ${app}`);
			definition = toolDefinition(info);
		}
		if (permission === null) this.store.clearToolPermission(audience, app, tool);
		else this.store.setToolPermission(audience, app, tool, permission, definition);
		if (audience === OWNER) this.#reinstallApprovals();
		return this.toolPermissions(audience).find((info) => (info.app ?? "") === app && info.tool === tool)!;
	}

	/**
	 * Turns each tool chosen with "Always approve" before tool permissions
	 * into an `on` permission, once the tool its name belongs to is known (an
	 * app's tools only once it is connected).
	 */
	#migrateAlwaysApproved(): void {
		for (const name of this.store.legacyAlwaysApproved()) {
			let app: string | undefined;
			let tool: string | undefined;
			let definition: string | null = null;
			if (this.#ownGatedActions().some((action) => action.name === name)) {
				app = "";
				tool = name;
			} else {
				const info = this.apps.tools().find((candidate) => toolName(candidate.serverId, candidate.name) === name);
				if (!info) continue;
				app = info.serverId;
				tool = info.name;
				definition = toolDefinition(info);
			}
			if (!this.store.toolPermission(OWNER, app, tool)) this.store.setToolPermission(OWNER, app, tool, "on", definition);
			this.store.forgetLegacyAlwaysApproved(name);
		}
	}

	// Circles: people the owner lets message this Pim, from their own Pims.

	/** This Pim's owner, as guests know them; null before registration provisioned it. */
	#me(): Guest | null {
		const profile = this.profile();
		return profile === null ? null : { ownerId: this.name, username: profile.username };
	}

	/** Another person's Pim, to call. */
	#pimOf(ownerId: string) {
		return getAgentByName(this.env.Pim, ownerId);
	}

	/**
	 * Puts someone in a circle, moving them from any other, and tells their
	 * Pim it may visit this one. The Worker calls it, having resolved
	 * their username.
	 */
	async addCircleMember(circleId: string, guest: Guest): Promise<Member> {
		this.#assertOpen();
		this.#circle(circleId);
		const me = this.#me();
		if (me === null) throw new HttpError(400, "This Pim has no owner to share it yet");
		if (guest.ownerId === this.name) throw new HttpError(400, "You can't add yourself to a circle");
		const known = this.circles.member(guest.ownerId);
		if (!known && this.circles.members().length >= MAX_MEMBERS) {
			throw new HttpError(429, `Your circles can hold up to ${MAX_MEMBERS} people.`);
		}
		// Told first: someone in a circle whose Pim doesn't know of it couldn't use it.
		if (!known) await (await this.#pimOf(guest.ownerId)).shareReceived(me);
		return this.circles.addMember(circleId, guest);
	}

	/** Takes someone out of the circles; their Pim is told, and their next call is refused either way. */
	async removeCircleMember(ownerId: string): Promise<boolean> {
		this.#assertOpen();
		if (!this.circles.removeMember(ownerId)) return false;
		await this.#tellRevoked([ownerId]);
		return true;
	}

	async #tellRevoked(ownerIds: readonly string[]): Promise<void> {
		for (const ownerId of ownerIds) {
			try {
				await (await this.#pimOf(ownerId)).shareRevoked(this.name);
			} catch (error) {
				console.warn(`telling ${ownerId} the share ended failed`, error);
			}
		}
	}

	/** Whether a guest may use this Pim now, and through which circle; or why not. */
	#guestAccess(guest: Guest): { ok: true; circle: Circle; member: Member } | { ok: false; reason: string } {
		const host = this.profile()?.username ?? "This person";
		if (this.#closed()) return { ok: false, reason: `${host}'s account was deleted.` };
		if (this.status() !== "active") return { ok: false, reason: `${host}'s account is suspended.` };
		const member = this.circles.member(guest.ownerId);
		if (!member) return { ok: false, reason: `${host} doesn't share their Pim with you.` };
		const circle = this.circles.circle(member.circle);
		if (!circle) return { ok: false, reason: `${host} doesn't share their Pim with you.` };
		if (!circle.enabled) return { ok: false, reason: `${host} has paused sharing their Pim with their "${circle.name}" circle.` };
		return { ok: true, circle, member };
	}

	/** The app tools a circle may use now, with the permission each has. */
	#guestTools(circle: string) {
		const servers = new Map(this.apps.servers().map((server) => [server.id, server]));
		return this.apps.tools().flatMap((tool) => {
			const server = servers.get(tool.serverId);
			if (!server || server.state !== "ready") return [];
			const { permission } = appToolPermission(this.store, server, tool, circle);
			return permission === "off" ? [] : [{ server, tool, permission, name: toolName(server.id, tool.name) }];
		});
	}

	/**
	 * What a guest's Pim may know of this one and use: called by the guest's
	 * own Pim before each of their turns. Nothing but what the guest's circle
	 * was given.
	 */
	async guestBrief(guest: Guest): Promise<BriefResult> {
		const access = this.#guestAccess(guest);
		if (!access.ok) return access;
		const me = this.#me()!;
		const memory = resolvePermission(this.store, access.circle.id, "", MEMORY_TOOL, "off", null).permission === "on";
		const lines = memory ? this.memory.view() : [];
		return {
			ok: true,
			brief: {
				host: me,
				circle: access.circle.name,
				timeZone: this.settings().timeZone,
				memory: memory
					? `<memory>\n${lines.length === 0 ? `${me.username}'s Pim remembers nothing yet.` : `What ${me.username}'s Pim remembers, oldest first; later memories override earlier ones:\n${lines.join("\n")}`}\n</memory>`
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

	/**
	 * A guest's tool call, from their own Pim: the hard boundary. The guest's
	 * circle and the tool's permission are checked here at every call, as
	 * they are now, whatever the guest's Pim was told before. `on` runs it,
	 * `ask` files an approval for the owner and answers at once (the decision
	 * goes to the guest's conversation later), anything else is refused.
	 */
	async guestCall(
		guest: Guest,
		call: { tool: string; args: Record<string, unknown>; session: string; callId: string },
	): Promise<GuestCallResult> {
		const access = this.#guestAccess(guest);
		if (!access.ok) return { text: access.reason, isError: true };
		const { circle } = access;
		const host = this.#me()!.username;
		const log = (outcome: "ran" | "asked" | "refused", summary: string) =>
			this.circles.logActivity({ username: guest.username, circle: circle.id, tool: call.tool, outcome, summary });
		if (!this.circles.countCall(guest.ownerId)) {
			return { text: `${guest.username} has used today's ${GUEST_CALLS_PER_DAY} calls to ${host}'s Pim. It resets at midnight UTC.`, isError: true };
		}

		if (call.tool === "recall") {
			if (resolvePermission(this.store, circle.id, "", MEMORY_TOOL, "off", null).permission !== "on") {
				log("refused", "recall");
				return { text: `${host} doesn't let you read their Pim's memory.`, isError: true };
			}
			const pattern = typeof call.args.pattern === "string" ? call.args.pattern : "";
			log("ran", `recall ${JSON.stringify(pattern)}`);
			return this.memory.search(pattern);
		}

		const found = this.#guestTools(circle.id).find((candidate) => candidate.name === call.tool);
		const summary = found ? summarizeCall(found.server.name, found.tool.name, call.args) : call.tool;
		if (!found) {
			log("refused", summary);
			return { text: `${host} doesn't let you use ${call.tool}.`, isError: true };
		}
		if (found.permission === "on") {
			log("ran", summary);
			const result = await this.apps.call(found.server.id, found.tool.name, call.args);
			return { text: toText(result), ...(result.isError ? { isError: true } : {}) };
		}
		return this.#askForGuest(guest, circle, found, call, summary, () => log("asked", summary));
	}

	/**
	 * Files an approval for a guest's call. The owner is notified; it is denied
	 * if they don't answer within a day, never approved by a timeout. The same
	 * call again (a replay in the guest's Pim) finds the request it filed.
	 */
	async #askForGuest(
		guest: Guest,
		circle: Circle,
		found: { server: McpServerInfo; tool: McpToolInfo; name: string },
		call: { args: Record<string, unknown>; session: string; callId: string },
		summary: string,
		logged: () => void,
	): Promise<GuestCallResult> {
		const host = this.#me()!.username;
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${guest.ownerId}\n${call.session}\n${call.callId}`));
		const id = `g-${[...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
		const known = this.store.approval(id);
		if (known && known.status !== "pending") return { text: this.#guestOutcome(known) };
		const now = Date.now();
		const approval = this.store.requestApproval({
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
			await this.schedule(new Date(approval.expiresAt!), APPROVAL_EXPIRY_CALLBACK, { id });
			this.broadcastMessage({ type: "approval", approval });
			const notification = this.store.addNotification({
				id: crypto.randomUUID(),
				session: null,
				title: `${guest.username} asked your Pim`,
				body: `${guest.username} (${circle.name}) wants: ${summary}`,
			});
			// Open apps show the request itself, from the approval just broadcast; this reaches the others.
			await this.deliverNotification(notification, { sockets: false });
		}
		return {
			text: `${host} asks before this runs. The request is with ${host} now (approval ${id}); their answer will arrive in this conversation as a message starting with "[${host}'s answer". Tell ${guest.username} it was asked, and don't call it again.`,
		};
	}

	/** A guest approval's outcome, as the guest's Pim reads it. */
	#guestOutcome(approval: Approval): string {
		const host = this.#me()?.username ?? "The owner";
		const note = approval.note ? `\n${host}'s note: ${approval.note}` : "";
		const head = `[${host}'s answer to approval ${approval.id}]`;
		if (approval.status === "denied") {
			const why = approval.decidedBy === "timeout" ? `${host} didn't answer within a day, so it was not done` : `${host} said no`;
			return `${head} ${why}: ${approval.summary}${note}`;
		}
		return `${head} ${host} approved: ${approval.summary}${note}\nResult:\n${approval.result ?? ""}`;
	}

	/** Fired when an approval's timeout passes: unanswered, it is decided as it was filed to be. */
	async expireApproval(payload: { id: string }): Promise<void> {
		if (this.#closed()) return;
		const approval = this.store.approval(payload.id);
		if (approval?.status !== "pending") return;
		await this.decideApproval(approval.id, approval.onTimeout, undefined, "timeout");
	}

	/** Guests' expiries scheduled under their old name. */
	async expireGuestApproval(payload: { id: string }): Promise<void> {
		await this.expireApproval(payload);
	}

	// The majordomo deciding other agents' approval requests for the person.

	/**
	 * Whether the majordomo decides `approval` first: under the `majordomo`
	 * policy, the request of any agent but the majordomo itself, in a chat
	 * with the person, where they are the ones to ask. Never a guest's, and
	 * never one that needs the person's own decision.
	 */
	#reviewable(approval: Approval): boolean {
		if (this.settings().approvalPolicy !== "majordomo" || approval.requestedBy) return false;
		if (this.actions.find((action) => action.name === approval.action)?.explicitApproval) return false;
		return approval.member !== null || !this.agents.ofSession(approval.session).majordomo;
	}

	/**
	 * The majordomo looks at another agent's request in a conversation of its
	 * own: who it is and how it decides, the person's memory, and the request.
	 * Whatever it leaves undecided, or a review that fails, goes to the
	 * person, as does one that outlasts `REVIEW_MS` (see `expireReview`).
	 */
	async #review(approval: Approval): Promise<void> {
		const call = `review:${approval.id}`;
		try {
			let run = this.team.byCall(call);
			if (!run) {
				const majordomo = this.agents.majordomo();
				const { id } = await this.harness.sessions.create();
				await this.harness.session(id).setModel(this.chosenModel());
				const snapshot = this.registry.snapshot();
				const extensions = [REVIEW_EXTENSION, this.memory.extension.name].flatMap((name) => snapshot.extension(name) ?? []);
				const tools = snapshot
					.tools()
					.filter(({ extension, tool }) => extensions.includes(extension) && [DECIDE_APPROVAL, "recall", "zoom"].includes(tool.name))
					.map(({ tool }) => tool);
				await (await this.harness.conversation(id)).configure({ extensions, tools }, BACKGROUND_CONTEXT);
				const chat = approval.member?.session ?? approval.session;
				this.team.start({ kind: "review", conversation: id, call, position: 0, session: chat, agent: majordomo.id, member: majordomo.name, task: approval.summary });
				run = this.team.run(id)!;
			}
			await this.harness.submit(this.#reviewRequest(approval), { session: run.conversation, operationId: call });
			const result = await this.harness.wait(call, { session: run.conversation });
			this.team.setStatus(run.conversation, result.status === "done" ? "done" : "failed");
		} catch (error) {
			console.warn(`the majordomo's review of ${approval.id} failed`, error);
		}
		await this.#escalate(approval.id, null);
	}

	/** What the majordomo reads to decide: who asks, for what, and in what chat. */
	#reviewRequest(approval: Approval): string {
		const asker = approval.member
			? `${approval.member.name}, a member of an agent's team`
			: (() => {
					const agent = this.agents.ofSession(approval.session);
					const chat = this.agents.handedBy(approval.session) ? "in a chat you started with it for the person" : "in a chat the person has with it";
					return `${agent.name}${agent.description ? ` (${agent.description})` : ""}, ${chat}`;
				})();
		const args = JSON.stringify(approval.args, null, 2);
		return [
			`[Approval review ${approval.id}] ${asker}, asks for approval.`,
			`Request: ${approval.summary}`,
			`Action: ${approval.action}`,
			`Details:\n${args.length > 4000 ? `${args.slice(0, 4000)}\n[... ${args.length - 4000} more characters]` : args}`,
		].join("\n");
	}

	/** The majordomo's decision, from its review. Once the person is asked, or decides, it is theirs. */
	async #reviewDecision(conversation: string, decision: "approve" | "deny" | "escalate", note: string): Promise<string> {
		const run = this.team.run(conversation);
		if (run?.kind !== "review") return "This conversation reviews no approval.";
		const id = run.call.slice("review:".length);
		const approval = this.store.approval(id);
		if (approval?.status !== "pending" || approval.review?.status !== "reviewing") return "It's no longer yours to decide: the person has it.";
		if (decision === "escalate") {
			await this.#escalate(id, note);
			return "Asked the person.";
		}
		try {
			const decided = await this.decideApproval(id, decision, note, "majordomo");
			return decided.status === "approved" ? `Approved. Result:\n${decided.result ?? ""}` : "Denied.";
		} catch (error) {
			return `It couldn't be decided: ${errorMessage(error)}`;
		}
	}

	/** Asks the person about a request the majordomo is still reviewing, with what it has to say. */
	async #escalate(id: string, note: string | null): Promise<void> {
		const approval = this.store.approval(id);
		if (approval?.status !== "pending" || approval.review?.status !== "reviewing" || this.#closed()) return;
		this.store.setApprovalReview(id, { status: "escalated", note });
		const escalated = this.store.approval(id)!;
		this.broadcastMessage({ type: "approval", approval: escalated });
		const { name } = this.agents.majordomo();
		const notification = this.store.addNotification({
			id: crypto.randomUUID(),
			session: approval.member?.session ?? approval.session,
			title: `${name} needs your approval`,
			body: note ? `${approval.summary}\n${note}` : approval.summary,
		});
		// Open apps show the request itself, from the approval just broadcast; this reaches the others.
		await this.deliverNotification(notification, { sockets: false });
	}

	/** Fired when a review has taken too long: the person is asked. */
	async expireReview(payload: { id: string }): Promise<void> {
		await this.#escalate(payload.id, null);
	}

	// The owner's agents, and their teams.

	/** The agent a conversation talks as, and the team member it is, if it is one. A review talks as the majordomo. */
	#roleOf(session: string): Role {
		const run = this.team.run(session);
		if (!run) return { agent: this.agents.ofSession(session), member: null };
		if (run.kind === "review") return { agent: this.agents.majordomo(), member: null };
		const agent = this.agents.get(run.agent) ?? this.agents.majordomo();
		// A member taken off the team since keeps working on what it was given, with no instructions of its own.
		const member = agent.team.find((candidate) => candidate.name === run.member) ?? { name: run.member, instructions: "", tools: null };
		return { agent, member };
	}

	/**
	 * A member's conversation leaves out what only the agent the person talks
	 * with does: talking to them, scheduling work and watching apps' events
	 * (both come back to the conversation that asked), and handing out tasks.
	 * A member with a list of tools gets only those.
	 */
	#memberAgent(member: TeamMember, agent: Agent): AgentChange {
		const snapshot = this.registry.snapshot();
		const removed = [MESSAGING_EXTENSION, SCHEDULE_EXTENSION, TEAM_EXTENSION].flatMap((name) => snapshot.extension(name) ?? []);
		// Members work with their agent's abilities and apps too.
		const added = [...this.extensions.abilitiesOf(agent.blueprint), ...this.#appExtensionsOf(agent)].flatMap((name) => snapshot.extension(name) ?? []);
		const extensions = { add: added, remove: removed };
		const kept = snapshot
			.tools()
			.filter(({ extension, tool }) => !removed.includes(extension) && !LEAD_ONLY_TOOLS.has(tool.name))
			.filter(({ extension }) => !this.#perPim(extension.name) || added.includes(extension));
		if (member.tools) return { extensions, tools: kept.filter(({ tool }) => member.tools!.includes(tool.name)).map(({ tool }) => tool) };
		const leadOnly = snapshot.tools().filter(({ tool }) => LEAD_ONLY_TOOLS.has(tool.name));
		return { extensions, ...(leadOnly.length > 0 ? { tools: { remove: leadOnly.map(({ tool }) => tool) } } : {}) };
	}

	/**
	 * The majordomo's handoff: its message goes into a chat of the person's
	 * with the agent as though they had sent it, a new chat or one the
	 * majordomo started before, and the agent answers there as it would
	 * answer them. What it sent comes back to the majordomo.
	 */
	async #sendToAgent({ from, agent, message, chat, key }: { from: string; agent: Agent; message: string; chat: string | undefined; key: string }): Promise<string> {
		let session = this.agents.byHandoff(key);
		if (!session && chat !== undefined) {
			const open = !this.#hiddenSessions().has(chat) && (await this.harness.sessions.list()).some((candidate) => candidate.id === chat);
			if (!open || this.agents.ofSession(chat).id !== agent.id) return `No chat ${chat} with ${agent.name}: leave out chat to start one.`;
			session = chat;
		}
		const operation = `handoff:${key}`;
		try {
			session ??= await this.#startChat(agent, undefined, { from, key });
			await this.submitTo(session, message, { operationId: operation, whenBusy: "followUp" }, "user");
		} catch (error) {
			return `It couldn't be sent: ${errorMessage(error)}`;
		}
		const result = await this.#withReplies(await this.harness.wait(operation, { session }));
		const where = `Chat ${session} with ${agent.name}, at /chat/${session}.`;
		if (result.status !== "done") return `${where}\n${agent.name} didn't finish: ${result.reason ?? "unanswered"}.`;
		const answer = result.replies.length > 0 ? result.replies.join("\n\n") : "(It sent nothing.)";
		return `${where}\n${agent.name} answered:\n${answer}`;
	}

	/**
	 * Passes on what an agent said in a chat the majordomo started, after the
	 * decision on its approval request, to the majordomo's chat, once.
	 */
	async #forwardHandoff(session: string, from: string, operation: string): Promise<void> {
		try {
			await this.keepAliveWhile(async () => {
				const { replies } = await this.#withReplies(await this.harness.wait(operation, { session }));
				if (replies.length === 0 || this.store.deletedSessions().has(from) || this.store.deletedSessions().has(session)) return;
				const { name } = this.agents.ofSession(session);
				await this.submitTo(
					from,
					`${CHAT_REPORT} ${name}] In chat ${session}, after the decision on its approval request, ${name} said:\n${replies.join("\n\n")}`,
					{ operationId: `handoff-report:${operation}`, whenBusy: "followUp" },
					"pim",
				);
			});
		} catch (error) {
			console.warn(`passing on what was said in ${session} failed`, error);
		}
	}

	/** Gives a member its task and waits for its answer. */
	async #askMember(conversation: string, task: string, operation: string): Promise<{ ok: boolean; text: string }> {
		await this.harness.submit(task, { session: conversation, operationId: operation });
		return this.#memberAnswer(conversation, operation);
	}

	/** Passes a member's answer after an approval's decision to the chat it works for, once. */
	async #report(run: TeamRun, operation: string): Promise<void> {
		try {
			await this.keepAliveWhile(async () => {
				const { ok, text } = await this.#memberAnswer(run.conversation, operation);
				this.team.setStatus(run.conversation, ok ? "done" : "failed");
				if (!this.store.deletedSessions().has(run.session)) {
					await this.submitTo(
						run.session,
						`[Team: ${run.member}] After the person's decision, ${run.member} answered:\n${text}`,
						{ operationId: `team-report:${run.conversation}:${operation}`, whenBusy: "followUp" },
						"pim",
					);
				}
				this.team.setReport(run.conversation, null);
			});
		} catch (error) {
			console.warn(`passing on ${run.member}'s answer failed`, error);
		}
	}

	/** What a member answered to an operation, once it settles. */
	async #memberAnswer(conversation: string, operation: string): Promise<{ ok: boolean; text: string }> {
		const result = await this.harness.wait(operation, { session: conversation });
		return result.status === "done"
			? { ok: true, text: result.text?.trim() || "(It gave no answer.)" }
			: { ok: false, text: `It didn't finish: ${result.reason ?? "unanswered"}.` };
	}

	#agent(id: string): Agent {
		const agent = this.agents.get(id);
		if (!agent) throw new HttpError(404, `No agent ${id}`);
		return agent;
	}

	// Extensions: the blueprints agents build on, and the widgets of their dashboards.

	/** The deployment's extensions (`pim.config.ts`). Tests add their own. */
	protected pimConfig(): PimConfig {
		return pimConfig;
	}

	/** Pim's own abilities' widgets, then the deployment's extensions, checked once. */
	get extensions(): PimExtensions {
		this.#extensions ??= new PimExtensions(
			[
				// Pim's own (BUILT_IN_WIDGETS): every chat can show their widgets.
				goalsWidgets(this.store),
				scheduleWidgets(() => this.services().listSchedules()),
				memoryWidgets(this.memory.store),
				artifactsWidgets(this.artifacts),
				...this.pimConfig().extensions,
			],
			this.pimConfig().defaultBlueprint,
		);
		return this.#extensions;
	}

	/** The extensions' abilities, built once for this Pim, by extension id. */
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
				});
				return [[extension.id, ability] as const];
			}),
		);
		return this.#abilities;
	}

	/**
	 * Installs (or replaces, keeping their place) each ability as a pi
	 * extension named after its extension: its tools, its actions' tools as
	 * the person's permissions have them, sections, hooks and tasks.
	 */
	#installAbilities(services: PimServices): void {
		for (const [id, { actions, ...ability }] of this.abilities) {
			this.registry.install(defineExtension({ ...ability, name: id, tools: [...(ability.tools ?? []), ...gatedTools(services, actions ?? [])] }));
		}
	}

	/**
	 * Gives a chat the abilities its agent uses and the apps it lists, and a
	 * chat with the majordomo the majordomo's own extension, as they
	 * are now, before its next run: its agent, the agent's blueprint, the extensions or
	 * the connected apps may have changed since.
	 * Visits choose their own extensions, and team members get theirs when
	 * made. A chat whose selection is unchanged isn't written to.
	 */
	async #selectAbilities(session: string): Promise<void> {
		if (this.visits.bySession(session) || this.team.run(session)) return;
		const agent = this.agents.ofSession(session);
		// Apps last: their tools come and go, and pi only appends cheaply at the end.
		const wanted = [...(agent.majordomo ? [MAJORDOMO_EXTENSION] : []), ...this.extensions.abilitiesOf(agent.blueprint), ...this.#appExtensionsOf(agent)];
		const key = wanted.join(" ");
		if ((this.agents.abilities(session) ?? "") === key) return;
		const snapshot = this.registry.snapshot();
		const add = wanted.flatMap((name) => snapshot.extension(name) ?? []);
		await (await this.harness.conversation(session)).configure({ extensions: add.length > 0 ? { add } : null }, BACKGROUND_CONTEXT);
		this.agents.setAbilities(session, key);
	}

	/** A copy's blueprint, if this deployment still has it, else the default blueprint; and those of its apps it still offers. */
	async #installed(input: AgentInput): Promise<AgentInput> {
		await this.#refreshCustomApps(true);
		const directory = this.appDirectory();
		return {
			...input,
			apps: input.apps.filter((ref) => directory.some((app) => app.ref === ref)),
			...(input.blueprint && !this.extensions.blueprint(input.blueprint) ? { blueprint: undefined } : {}),
		};
	}

	/** A blueprint given through the API must be a blueprint some installed extension brings. */
	#checkBlueprint(input: AgentInput): AgentInput {
		if (input.blueprint && !this.extensions.blueprint(input.blueprint)) throw new HttpError(400, `No installed extension brings the blueprint ${input.blueprint}`);
		return input;
	}

	/**
	 * An agent's dashboard: the widgets of the blueprint it builds on, each
	 * loaded for this agent. One that fails shows as failed; the others still load.
	 */
	async #dashboard(agent: Agent, locale: string) {
		const blueprint = agent.blueprint === null ? undefined : this.extensions.blueprint(agent.blueprint);
		const widgets = await Promise.all((blueprint?.dashboard ?? []).map((ref) => this.#loadWidget(agent, ref)));
		return {
			agent: { id: agent.id, name: agent.name, description: agent.description, majordomo: agent.majordomo, blueprint: agent.blueprint, icon: agent.icon, symbol: agent.symbol, color: agent.color },
			starters: (blueprint?.starters ?? []).map((starter) => localize(starter, locale)),
			widgets: widgets.map((widget) => ({ ...widget, title: localize(widget.title, locale), empty: localize(widget.empty, locale) })),
		};
	}

	/** Loads an installed widget for one of the owner's agents. One that throws comes back failed. */
	async #loadWidget(agent: Agent, ref: string): Promise<ShownWidget> {
		const widget = this.extensions.widget(ref)!;
		const deleted = this.store.deletedSessions();
		// A team member's conversation works for the chat that gave it its task.
		const chatFor = (session: string) => this.team.run(session)?.session ?? session;
		const ofAgent = (session: string) => {
			const chat = chatFor(session);
			return !this.visits.bySession(chat) && this.agents.ofSession(chat).id === agent.id;
		};
		const context: WidgetContext = {
			agent: { id: agent.id, name: agent.name, majordomo: agent.majordomo },
			timeZone: this.settings().timeZone,
			chatOf: (session) => (ofAgent(session) && !deleted.has(chatFor(session)) ? chatFor(session) : null),
			ofAgent,
			data: this.extensionData.for(ref.slice(0, ref.indexOf("/"))),
		};
		const shown = { id: ref, title: widget.title, empty: widget.empty };
		try {
			return { ...shown, ...(await widget.load(context)) };
		} catch (error) {
			console.warn(`widget ${ref} failed`, error);
			return { ...shown, failed: true };
		}
	}

	/**
	 * The widgets a chat can show with its messages: Pim's own, and those of
	 * the extensions its agent builds on and uses, each with a description for
	 * the model. None in a visit, or in a team member's conversation.
	 */
	#chatWidgets(session: string): { ref: string; description: string }[] {
		if (this.visits.bySession(session) || this.team.run(session)) return [];
		const blueprint = this.agents.ofSession(session).blueprint;
		const extensions = new Set([...BUILT_IN_WIDGETS, ...(blueprint ? [blueprint.slice(0, blueprint.indexOf("/"))] : []), ...this.extensions.abilitiesOf(blueprint)]);
		return this.extensions.list().flatMap((extension) =>
			extensions.has(extension.id)
				? Object.entries(extension.widgets ?? {}).flatMap(([name, widget]) =>
						widget.description ? [{ ref: `${extension.id}/${name}`, description: widget.description }] : [],
					)
				: [],
		);
	}

	/** The agent a chat talks with; none in a visit, which talks with someone else's. */
	#agentRef(session: string): { id: string; name: string } | null {
		if (this.visits.bySession(session)) return null;
		const agent = this.agents.ofSession(session);
		return { id: agent.id, name: agent.name };
	}

	/** One of the owner's agents, with its uploaded icon, for the Worker to publish to the gallery. */
	async agentToPublish(id: string): Promise<(Agent & { image: AgentIcon | null }) | null> {
		this.#assertOpen();
		const agent = this.agents.get(id);
		return agent ? { ...agent, image: this.agents.icon(id) ?? null } : null;
	}

	/** Records which template an agent is published as; null once unpublished. */
	async setAgentPublished(id: string, template: string | null): Promise<void> {
		this.#assertOpen();
		if (this.agents.get(id)) this.agents.setPublished(id, template);
	}

	/** Makes a published template one of the owner's agents: a copy of it, theirs to change. */
	async adoptTemplate(template: {
		id: string;
		author: string;
		name: string;
		description: string;
		instructions: string;
		apps: readonly string[];
		team: readonly TeamMember[];
		blueprint: string | null;
		symbol: string | null;
		color: string | null;
		image: AgentIcon | null;
	}): Promise<Agent> {
		this.#assertOpen();
		const { image, ...rest } = template;
		const input = await this.#installed(agentInput({ ...rest }));
		const agent = this.agents.create(input, { template: template.id, author: template.author });
		if (image) this.agents.setIcon(agent.id, image.type, image.data);
		return this.agents.get(agent.id)!;
	}

	/** At registration: gives the person a copy of the agent the admin chose for everyone, its icon too, besides their majordomo. */
	async adoptEveryonesAgent(agent: AgentInput & { author: string; image: AgentIcon | null }): Promise<Agent> {
		this.#assertOpen();
		const { author, image, ...input } = agent;
		const copy = this.agents.create(await this.#installed(agentInput({ ...input })), { template: "default", author });
		if (image) this.agents.setIcon(copy.id, image.type, image.data);
		return this.agents.get(copy.id)!;
	}

	// Visits: Pims shared with this one's owner, and their conversations with them.

	/** From a host's Pim: its owner put this Pim's owner in a circle. */
	async shareReceived(host: Guest): Promise<void> {
		this.#assertOpen();
		if (this.status() !== "active") throw new Error("This Pim is suspended");
		if (!this.visits.shared(host)) return;
		const notification = this.store.addNotification({
			id: crypto.randomUUID(),
			session: null,
			title: `${host.username} shared their Pim with you`,
			body: `You can message ${host.username}'s Pim now. Find it under Shared with you.`,
		});
		await this.deliverNotification(notification);
		this.broadcastMessage({ type: "visits" });
	}

	/** From a host's Pim: this Pim's owner is no longer in its circles. */
	async shareRevoked(hostOwnerId: string): Promise<void> {
		if (this.#closed()) return;
		this.visits.revoked(hostOwnerId);
		this.registry.uninstall({ name: visitExtensionName(hostOwnerId) });
		this.broadcastMessage({ type: "visits" });
	}

	/** From a host's Pim: the owner decided on something this Pim's owner asked for; it continues the visit. */
	async visitAnswer(hostOwnerId: string, session: string, message: string, operationId: string): Promise<void> {
		this.#assertOpen();
		const share = this.visits.share(hostOwnerId);
		// Only into the visit with that host: a host can't write into any other conversation.
		if (!share || share.session !== session) return;
		await this.submitTo(session, message, { operationId }, "pim");
	}

	/** A visit's conversation, started on first use. */
	async startVisit(username: string): Promise<string> {
		const share = this.visits.byUsername(username);
		if (!share) throw new HttpError(404, `${username} doesn't share their Pim with you`);
		if (share.revoked) throw new HttpError(403, `${username} no longer shares their Pim with you`);
		if (share.session !== null && !this.store.deletedSessions().has(share.session)) return share.session;
		const { id } = await this.harness.sessions.create();
		await this.harness.session(id).setModel(this.chosenModel());
		this.store.touchSession(id, `${username}'s Pim`);
		this.visits.setSession(share.ownerId, id);
		await this.#refreshVisit(share.ownerId);
		return id;
	}

	/**
	 * Asks the host's Pim what this visit may use now, and gives the visit's
	 * conversation exactly that: its own extension, and nothing of the
	 * owner's. Refused, the visit can't go on.
	 */
	async #refreshVisit(hostOwnerId: string): Promise<void> {
		const share = this.visits.share(hostOwnerId);
		const me = this.#me();
		if (!share || share.session === null || me === null) throw new HttpError(404, "No such visit");
		if (share.revoked) throw new HttpError(403, `${share.username} no longer shares their Pim with you`);
		const result = (await (await this.#pimOf(hostOwnerId)).guestBrief(me)) as BriefResult;
		if (!result.ok) {
			this.visits.setBrief(hostOwnerId, null);
			throw new HttpError(403, result.reason);
		}
		this.visits.setBrief(hostOwnerId, result.brief);
		const extension = this.#installVisit(result.brief, me.username);
		const conversation = await this.harness.conversation(share.session);
		// The visitor reads what the visit sends them, as in any of their conversations.
		const messaging = this.registry.snapshot().extension(MESSAGING_EXTENSION)!;
		await conversation.configure({ extensions: [extension, messaging] }, BACKGROUND_CONTEXT);
	}

	/** Installs (or replaces) a visit's extension; its tools call the host's Pim. */
	#installVisit(brief: GuestBrief, visitor: string) {
		const host = brief.host.ownerId;
		const extension = visitExtension(brief, visitor, async (tool, args, session, callId) => {
			this.#assertOpen();
			const me = this.#me();
			if (me === null) return { text: "This Pim can't visit others.", isError: true };
			return (await this.#pimOf(host)).guestCall(me, { tool, args, session, callId });
		});
		this.registry.install(extension);
		return extension;
	}

	tools(): ToolInfo[] {
		const gated = new Set(this.toolPermissions().flatMap((info) => (info.permission === "ask" ? [info.name] : [])));
		return this.registry
			.snapshot()
			.tools()
			.filter(({ extension }) => !extension.name.startsWith(VISIT_PREFIX))
			.map(({ tool }) => ({ name: tool.name, description: tool.description, requiresApproval: gated.has(tool.name) }));
	}

	// Hosting: what the Worker in front tells the Pim about its owner.

	/** Set while `deleteEverything` runs: the Pim takes nothing new. */
	#erasing = false;

	/**
	 * Whether the Pim is erased, or being erased. An erased Pim keeps
	 * only its mark and refuses everything: requests, sockets, alarms and the
	 * Worker's own writes. The check is here, in the one object every
	 * request reaches, so a request a Worker authorized before the deletion
	 * (or with an account it had cached) can't write after it.
	 */
	#closed(): boolean {
		return this.#erasing || this.store.erasedAt() !== null;
	}

	#assertOpen(): void {
		if (this.#closed()) throw new HttpError(410, "This Pim was erased");
	}

	/** Every request comes through the Worker, which names the owner it resolved: it must be this Pim's. */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get(OWNER_HEADER) !== this.name) {
			console.error(JSON.stringify({ event: "pim.misrouted", agent: this.name }));
			return Response.json({ error: "This request is not for this Pim" }, { status: 421 });
		}
		if (this.#closed()) return Response.json({ error: "This Pim was erased" }, { status: 410 });
		if (this.status() !== "active") return Response.json({ error: "This Pim is suspended" }, { status: 403 });
		await this.#refreshCustomApps();
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

	/** Records who owns this Pim and where it is served, so callbacks and pushes use that address. */
	async provision(profile: OwnerProfile): Promise<void> {
		this.#assertOpen();
		if (profile.ownerId !== this.name) throw new Error(`Owner ${profile.ownerId} is not this agent's (${this.name})`);
		this.store.setMeta(PROFILE_KEY, JSON.stringify(profile));
		this.store.setMeta("public_origin", new URL(profile.publicUrl).origin);
	}

	profile(): OwnerProfile | null {
		const json = this.store.meta(PROFILE_KEY);
		return json === undefined ? null : (JSON.parse(json) as OwnerProfile);
	}

	/** Changes the person's settings, as `PUT /settings` does; registration sets their time zone. */
	async applySettings(update: Record<string, unknown>): Promise<Settings> {
		this.#assertOpen();
		const before = this.settings().approvalPolicy;
		const settings = updateSettings(this.store, this.env, update);
		// The approval tools say how a request is decided: they must say it the new way.
		if (settings.approvalPolicy !== before) this.#reinstallApprovals();
		return settings;
	}

	/** Suspends or restores the Pim. Suspending stops its runs and closes its sockets; its data stays. */
	async setStatus(status: OwnerStatus): Promise<void> {
		this.#assertOpen();
		if (status === "active") this.store.deleteMeta(STATUS_KEY);
		else this.store.setMeta(STATUS_KEY, status);
		if (status === "suspended") {
			for (const session of await this.harness.sessions.list()) await this.harness.session(session.id).abort();
			for (const connection of this.getConnections()) connection.close(4003, "Suspended");
		}
	}

	/** This Pim's own limits, over the deployment's; null goes back to the deployment's. */
	async setLimits(limits: Partial<Limits> | null): Promise<Limits> {
		this.#assertOpen();
		if (limits === null) this.store.deleteMeta(LIMITS_KEY);
		else this.store.setMeta(LIMITS_KEY, JSON.stringify(parseLimits(limits)));
		return this.limits();
	}

	/** Usage today and on recent days, with the limits it counts against. */
	usageReport(days = 30) {
		return {
			limits: this.limits(),
			today: this.usage.today(),
			history: this.usage.history(days),
			storageBytes: this.storedBytes(),
		};
	}

	/**
	 * Everything the person put in or the agent made, as JSON they can take
	 * elsewhere: conversations, memories, goals, schedules, approvals,
	 * notifications, connected apps and settings. Credentials are not
	 * included: the ChatGPT plan's tokens, apps' sign-ins, webhook secrets
	 * and push keys stay behind. JSON text, ready to download.
	 */
	async exportData(): Promise<string> {
		const deleted = this.store.deletedSessions();
		const sessions = [];
		for (const session of await this.harness.sessions.list()) {
			if (deleted.has(session.id)) continue;
			const info = this.store.sessionInfo(session.id);
			sessions.push({
				id: session.id,
				title: info?.title ?? null,
				createdAt: info?.createdAt ?? null,
				updatedAt: info?.updatedAt ?? null,
				messages: projectEntries(await this.harness.session(session.id).messages()),
			});
		}
		return JSON.stringify({
			format: "pim-export",
			version: 1,
			exportedAt: new Date().toISOString(),
			owner: this.profile(),
			settings: this.settings(),
			model: describeModel(this.chosenModel()),
			sessions,
			memory: { entries: this.memory.store.page(Number.MAX_SAFE_INTEGER) },
			goals: this.store.goals(),
			extensions: this.extensionData.export(),
			schedules: (await this.services().listSchedules()).map(describeSchedule),
			approvals: this.store.approvals(),
			permissions: this.store.toolPermissions(),
			circles: this.#describeCircles(),
			agents: this.agents.list(),
			guestActivity: this.circles.activity(500),
			sharedWithMe: this.visits.shares().map(({ ownerId, username, sharedAt, revoked }) => ({ ownerId, username, sharedAt, revoked })),
			notifications: this.store.notifications({ unread: false }),
			apps: this.apps.servers().map(({ id, name, url, approval }) => ({ id, name, url, approval })),
			watches: this.appEvents.list(),
			artifacts: this.artifacts.export(),
			files: await this.files.export(),
			usage: this.usage.history(90),
		});
	}

	/**
	 * What of the person's data this Pim still holds; nothing once
	 * `deleteEverything` has run. A deletion counts as done only when this
	 * says so, since destroying the Pim ends the call that asked for it.
	 */
	async remainingData(): Promise<string[]> {
		const remaining = this.store.remainingData();
		if (this.memory.store.count() > 0) remaining.push("memories");
		const own = new Set([SCHEDULED_TASK_CALLBACK, WATCH_REFRESH_CALLBACK]);
		if ((await this.listSchedules()).some((schedule) => own.has(schedule.callback))) remaining.push("schedules");
		if (Object.keys(this.getMcpServers().servers).length > 0) remaining.push("app connections");
		if (await this.images.any()) remaining.push("images");
		return remaining;
	}

	/** Whether the Pim is erased, and what of the person's data it still holds; a finished deletion is both. */
	async erasure(): Promise<{ sealed: boolean; remaining: string[] }> {
		return { sealed: this.store.erasedAt() !== null, remaining: await this.remainingData() };
	}

	/**
	 * Erases the Pim: stops its runs, ends apps' event subscriptions,
	 * closes its sockets, wipes its storage (alarms included), then marks it
	 * erased, flushes the mark, and ends this instance, so nothing that was
	 * under way here can write afterwards. Later instances find the mark and
	 * refuse everything. The call that asked usually sees the instance end:
	 * check `erasure()` afterwards. Running it again on an erased agent wipes
	 * anything a request slipped in before the mark, and marks it again.
	 */
	async deleteEverything(): Promise<void> {
		this.#erasing = true;
		for (const connection of this.getConnections()) connection.close(4010, "Deleted");
		// Stopping runs and ending apps' subscriptions is courtesy: the wipe and the end of this
		// instance stop everything regardless. So they get a few seconds, and a hung model
		// request or app can't hold the deletion.
		const courtesy = async () => {
			const sessions = await this.harness.sessions.list();
			await Promise.allSettled(sessions.map((session) => this.harness.session(session.id).abort()));
			await Promise.allSettled(this.store.watches().map((watch) => this.appEvents.stop(watch.id)));
		};
		await Promise.race([courtesy().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ERASE_COURTESY_MS))]);
		// Images live outside this object's storage, so they go first, and the browser closes with
		// whatever was signed in there.
		await this.images.deleteAll();
		await this.browser.close().catch(() => undefined);
		await this.ctx.storage.deleteAll();
		this.store.markErased(Date.now());
		await this.ctx.storage.sync();
		this.ctx.abort("This Pim was erased");
	}

	// HTTP API

	async onRequest(request: Request): Promise<Response> {
		// Checked again here, not only in `fetch`: erasure may have begun while the request was on its way in.
		if (this.#closed()) return Response.json({ error: "This Pim was erased" }, { status: 410 });
		// Apps deliver events to callback URLs on this origin, so remember the one the owner uses.
		if (request.headers.get(AUTHORIZED_HEADER) === "1") {
			const origin = new URL(request.url).origin;
			if (this.store.meta("public_origin") !== origin) this.store.setMeta("public_origin", origin);
		}
		return dispatch(this.#routes, request, new URL(request.url).pathname);
	}

	/** Conversations that aren't the person's chats: deleted ones, and team members' at work. */
	#hiddenSessions(): Set<string> {
		return new Set([...this.store.deletedSessions(), ...this.team.conversations()]);
	}

	async #session(id: string): Promise<string> {
		// The root stays reachable when deleted: it is where API clients talk by default.
		if (id === ROOT_SESSION) return id;
		if (
			!SESSION_ID.test(id) ||
			this.#hiddenSessions().has(id) ||
			!(await this.harness.sessions.list()).some((session) => session.id === id)
		) {
			throw new HttpError(404, `No session ${id}`);
		}
		return id;
	}

	/**
	 * Answers an artifact request. A token in the address is refused: the API
	 * takes one there only for WebSockets, and an address with a token in it
	 * can be passed on, logged or kept in history.
	 */
	#artifactRequest(url: URL, answer: () => Response | Promise<Response>): Response | Promise<Response> {
		if (url.searchParams.has("token")) throw new HttpError(400, "Send the API token in the Authorization header, not the address");
		return answer();
	}

	/** The browser, or 404 where this deployment has none. */
	#browserIn(): PimBrowser {
		if (!this.browser.available) throw new HttpError(404, "This Pim has no browser");
		return this.browser;
	}

	#artifact(id: string) {
		const artifact = ARTIFACT_ID.test(id) ? this.artifacts.get(id) : undefined;
		if (!artifact) throw new HttpError(404, `No artifact ${id}`);
		return artifact;
	}

	#artifactVersion(id: string, version: string) {
		const artifact = this.#artifact(id);
		const found = VERSION.test(version) ? this.artifacts.version(artifact.id, Number(version)) : undefined;
		if (!found) throw new HttpError(404, `No version ${version} of artifact ${id}`);
		return { artifact, found };
	}

	readonly #routes: readonly Route[] = [
		[
			"GET",
			"/",
			() => ({
				model: this.chosenModel().id,
				timeZone: this.settings().timeZone,
				rootSession: ROOT_SESSION,
				tools: this.tools(),
			}),
		],
		// This Pim as an MCP server, for MCP clients such as Claude or ChatGPT.
		...(["POST", "GET", "DELETE"] as const).map((method): Route => [method, MCP_SERVER_PATH, (_params, request) => this.#mcpServer(request)]),

		// Sessions: separate conversations, each with its own transcript and runs.
		[
			"GET",
			"/sessions",
			async () => {
				const hidden = this.#hiddenSessions();
				const sessions = (await this.harness.sessions.list()).filter((session) => !hidden.has(session.id)).map((session) => {
					const info = this.store.sessionInfo(session.id);
					const visit = this.visits.bySession(session.id);
					return {
						...session,
						title: info?.title ?? null,
						createdAt: info?.createdAt ?? null,
						updatedAt: info?.updatedAt ?? null,
						visit: visit ? { username: visit.username, available: !visit.revoked } : null,
						agent: this.#agentRef(session.id),
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
				const agent = agentId === undefined ? this.agents.majordomo() : this.#agent(agentId);
				const id = await this.#startChat(agent, typeof title === "string" && title.trim() !== "" ? clipTitle(title) : undefined);
				return { id, ...this.store.sessionInfo(id), agent: this.#agentRef(id) };
			},
		],
		[
			"PUT",
			"/sessions/:session",
			async ({ session }, request) => {
				const id = await this.#session(session!);
				const { title } = await readJson<{ title: string }>(request);
				if (typeof title !== "string" || title.trim() === "") throw new HttpError(400, "title must be a non-empty string");
				this.store.renameSession(id, clipTitle(title));
				return this.store.sessionInfo(id);
			},
		],
		// Side jobs on the utility model (./utility.ts).
		[
			"POST",
			"/sessions/:session/title",
			async ({ session }) => {
				const id = await this.#session(session!);
				const title = clipTitle(await this.utility(NAME_CHAT, await this.#conversationText(id, 8_000)));
				this.store.renameSession(id, title);
				this.broadcastMessage({ type: "sessions" });
				return this.store.sessionInfo(id);
			},
		],
		[
			"GET",
			"/sessions/:session/summary",
			async ({ session }) => {
				const id = await this.#session(session!);
				const text = conversationText(projectEntries(await this.harness.session(id).messages()), 48_000);
				if (text === "") return { summary: null };
				// Written again only when what was said has changed since the last one.
				const of = await digestHex(text);
				let summary = this.store.sessionSummary(id, of);
				if (summary === undefined) {
					summary = await this.utility(SUMMARIZE_CHAT, text);
					this.store.setSessionSummary(id, summary, of);
				}
				return { summary };
			},
		],
		[
			"POST",
			"/prompts/improve",
			async (_params, request) => {
				const { text } = await readJson<{ text: string }>(request);
				if (typeof text !== "string" || text.trim() === "") throw new HttpError(400, "text must be a non-empty string");
				if (text.length > 8_000) throw new HttpError(413, "text is longer than 8,000 characters");
				return { text: await this.utility(IMPROVE_PROMPT, text) };
			},
		],
		[
			"DELETE",
			"/sessions/:session",
			async ({ session }) => {
				const id = await this.#session(session!);
				this.store.deleteSession(id);
				await this.images.deleteSession(id);
				const visit = this.visits.bySession(id);
				if (visit) this.visits.setSession(visit.ownerId, null);
				// Nothing keeps working in a chat the user can no longer see.
				await this.harness.session(id).abort();
				const services = this.services();
				// A task that starts new chats goes on without the chat that scheduled it.
				for (const schedule of await services.listSchedules()) {
					if (schedule.payload.session === id && !schedule.payload.newChat) await services.cancelSchedule(schedule.id);
				}
				for (const watch of this.store.watches()) {
					if (watch.session === id) await this.appEvents.stop(watch.id);
				}
				return { deleted: true };
			},
		],
		[
			"GET",
			"/sessions/:session/messages",
			async ({ session }) => {
				const id = await this.#session(session!);
				const handle = this.harness.session(id);
				const [entries, busy, pending] = await Promise.all([
					handle.messages(),
					handle.busy(),
					this.harness.pending({ session: id }),
				]);
				return { session, busy, pending, messages: projectEntries(entries) };
			},
		],
		[
			"POST",
			"/sessions/:session/messages",
			async ({ session }, request) => {
				const id = await this.#session(session!);
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
				const receipt = await this.submitTo(
					id,
					content,
					{
						...(body.whenBusy ? { whenBusy: body.whenBusy } : {}),
						...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
					},
					"user",
				);
				if (!body.wait) return Response.json(receipt, { status: 202 });
				return this.#withReplies(await this.harness.wait(receipt.operationId, { session: id }));
			},
		],
		[
			"GET",
			"/sessions/:session/operations/:operation",
			async ({ session, operation }, _request, url) => {
				const id = await this.#session(session!);
				const timeout = Math.min(Number(url.searchParams.get("timeout") ?? 25_000) || 25_000, 60_000);
				const signal = AbortSignal.timeout(timeout);
				try {
					return await this.#withReplies(await this.harness.wait(operation!, { session: id, signal }));
				} catch (error) {
					if (signal.aborted) return { operationId: operation, session: id, status: "pending" };
					throw error;
				}
			},
		],
		// What a chat's agent handed its team, and each member's conversation, read-only.
		[
			"GET",
			"/sessions/:session/team",
			async ({ session }) => ({ runs: this.team.ofSession(await this.#session(session!)) }),
		],
		[
			"GET",
			"/sessions/:session/team/:conversation",
			async ({ session, conversation }) => {
				const run = this.team.run(conversation!);
				if (!run || run.session !== (await this.#session(session!))) throw new HttpError(404, `No team task ${conversation}`);
				return { ...run, messages: projectEntries(await this.harness.session(run.conversation).messages()) };
			},
		],
		[
			"POST",
			"/sessions/:session/abort",
			async ({ session }, request) => {
				const id = await this.#session(session!);
				const { operationId } = await readJson<{ operationId: string }>(request);
				return { aborted: await this.harness.session(id).abort(operationId) };
			},
		],
		[
			"POST",
			"/sessions/:session/reset",
			async ({ session }, request) => {
				const id = await this.#session(session!);
				const { handoff } = await readJson<{ handoff: string }>(request);
				await this.harness.session(id).reset(typeof handoff === "string" ? handoff : undefined);
				return { reset: true };
			},
		],
		[
			"PUT",
			"/sessions/:session/model",
			async ({ session }, request) => {
				const id = await this.#session(session!);
				const { model } = await readJson<{ model: string }>(request);
				if (typeof model !== "string") throw new HttpError(400, "model must be a string");
				const allowed = this.#allowedModels();
				if (allowed && model !== this.defaultModel().id && !allowed.includes(model)) {
					throw new HttpError(403, `${model} is not available here. Choose one of GET /model's choices.`);
				}
				let resolved: PiModel;
				try {
					resolved = this.ai(model);
				} catch (error) {
					throw new HttpError(400, errorMessage(error));
				}
				await this.harness.session(id).setModel(resolved);
				return { model };
			},
		],

		// The model every session uses, and the ChatGPT plan it can run on.
		[
			"GET",
			"/model",
			async () => {
				const chatgpt = await this.chatgpt.status();
				let chatgptModels: PiModel[] = [];
				let chatgptError: string | null = null;
				if (chatgpt.connected) {
					try {
						chatgptModels = await this.chatgpt.models(this.modelCatalog());
					} catch (error) {
						chatgptError = errorMessage(error);
					}
				}
				const fallback = this.defaultModel();
				const platform = (this.#allowedModels() ?? []).filter((id) => id !== fallback.id).map((id) => this.ai(id));
				const choices = [fallback, ...platform, ...chatgptModels];
				const utilityDefault = this.defaultUtilityModel();
				const utility = await this.utilityModel();
				const utilityChoices =
					utilityDefault && !choices.some((model) => sameModel(model, utilityDefault)) ? [utilityDefault, ...choices] : choices;
				return {
					model: describeModel(this.chosenModel()),
					default: describeModel(fallback),
					choices: choices.map(describeModel),
					// The model for side jobs (./utility.ts); null when there is none.
					utility: {
						model: utility ? describeModel(utility) : null,
						default: utilityDefault ? describeModel(utilityDefault) : null,
						choices: utilityChoices.map(describeModel),
					},
					chatgpt: { ...chatgpt, error: chatgptError },
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
				const fallback = this.defaultModel();
				if (provider === fallback.provider && id === fallback.id) {
					return { model: describeModel(await this.chooseModel(null)) };
				}
				return { model: describeModel(await this.chooseModel(await this.#choice(provider, id))) };
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
				const fallback = this.defaultUtilityModel();
				if (fallback && provider === fallback.provider && id === fallback.id) this.store.deleteMeta(UTILITY_MODEL_KEY);
				else {
					const model = await this.#choice(provider, id);
					this.store.setMeta(UTILITY_MODEL_KEY, JSON.stringify({ provider: model.provider, id: model.id }));
				}
				const model = await this.utilityModel();
				return { model: model ? describeModel(model) : null };
			},
		],
		// The address Pim emails the person at, confirmed with a code it sends there.
		["GET", "/email", () => this.email.state()],
		["PUT", "/email", async (_params, request) => this.email.start((await readJson<{ address: unknown }>(request)).address)],
		["POST", "/email/confirm", async (_params, request) => this.email.confirm((await readJson<{ code: unknown }>(request)).code)],
		["DELETE", "/email", () => this.email.remove()],
		// The person's settings, and what they used.
		["GET", "/settings", () => this.#describeSettings()],
		[
			"PUT",
			"/settings",
			async (_params, request) => {
				await this.applySettings(await readJson<Record<string, unknown>>(request));
				return this.#describeSettings();
			},
		],
		["GET", "/usage", () => this.usageReport()],

		// Artifacts: what the agent made, every version kept. Their bytes are never kept by the browser,
		// and HTML in them runs only sandboxed (see ./artifacts.ts).
		["GET", "/artifacts", (_params, _request, url) => this.#artifactRequest(url, () => noStore({ artifacts: this.artifacts.list(), bytes: this.artifacts.totalBytes() }))],
		[
			"GET",
			"/artifacts/:id",
			({ id }, _request, url) =>
				this.#artifactRequest(url, () => {
					const artifact = this.#artifact(id!);
					return noStore({ ...artifact, history: this.artifacts.versions(artifact.id) });
				}),
		],
		[
			"DELETE",
			"/artifacts/:id",
			({ id }, _request, url) =>
				this.#artifactRequest(url, () => {
					this.#assertOpen();
					const artifact = this.#artifact(id!);
					this.artifacts.delete(artifact.id);
					return noStore({ deleted: true });
				}),
		],
		[
			"POST",
			"/artifacts/:id/restore",
			({ id }, request, url) =>
				this.#artifactRequest(url, async () => {
					const artifact = this.#artifact(id!);
					const { version, baseVersion } = await readJson<{ version: number; baseVersion: number }>(request);
					if (!Number.isSafeInteger(version) || !Number.isSafeInteger(baseVersion)) {
						throw new HttpError(400, "version and baseVersion must be version numbers");
					}
					this.#assertOpen();
					const restored = await this.artifacts.restore(artifact.id, version!, baseVersion!);
					return noStore({ ...this.artifacts.get(artifact.id), restored: restored.version }, 201);
				}),
		],
		[
			"GET",
			"/artifacts/:id/versions/:version",
			({ id, version }, _request, url) =>
				this.#artifactRequest(url, () => {
					const { artifact, found } = this.#artifactVersion(id!, version!);
					return noStore({ id: artifact.id, title: artifact.title, kind: artifact.kind, latest: artifact.version, ...found });
				}),
		],
		[
			"GET",
			"/artifacts/:id/versions/:version/frame",
			({ id, version }, _request, url) =>
				this.#artifactRequest(url, () => {
					const { artifact, found } = this.#artifactVersion(id!, version!);
					if (artifact.kind !== "html") throw new HttpError(404, "Only HTML artifacts are shown in a frame");
					return new Response(found.content + RESIZE_SCRIPT, { headers: artifactHeaders(url.origin, "text/html; charset=utf-8") });
				}),
		],
		[
			"GET",
			"/artifacts/:id/versions/:version/download",
			({ id, version }, _request, url) =>
				this.#artifactRequest(url, () => {
					const { artifact, found } = this.#artifactVersion(id!, version!);
					// Plain text, whatever the kind: the file is for saving, and a browser that shows it
					// anyway shows its source, still under the sandbox. Its name keeps the extension.
					const headers = artifactHeaders(url.origin, "text/plain; charset=utf-8");
					const { ascii, utf8 } = downloadName(artifact.title, found.version, artifact.kind);
					headers.set("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`);
					return new Response(found.content, { headers });
				}),
		],
		// Files: the person's, which their agents read and write too (see ./files.ts).
		["GET", "/files", (_params, _request, url) => this.#artifactRequest(url, async () => noStore(await this.files.list(url.searchParams.get("path") ?? FILES_ROOT)))],
		[
			"GET",
			"/files/content",
			(_params, _request, url) =>
				this.#artifactRequest(url, async () => {
					const file = await this.files.read(url.searchParams.get("path"));
					return new Response(file.body, { headers: fileHeaders(file, url.searchParams.has("download")) });
				}),
		],
		[
			"PUT",
			"/files/content",
			(_params, request, url) =>
				this.#artifactRequest(url, async () => {
					this.#assertOpen();
					const tooLarge = `A file can be at most ${MAX_UPLOAD_BYTES} bytes`;
					if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) throw new HttpError(413, tooLarge);
					const body = new Uint8Array(await request.arrayBuffer());
					if (body.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, tooLarge);
					const refusal = this.#storageRefusal();
					if (refusal) throw new HttpError(429, refusal);
					const { storageBytes } = this.limits();
					if (storageBytes !== null && body.byteLength > storageBytes - this.storedBytes()) {
						throw new HttpError(429, `Pim storage quota exceeded: there is room for ${Math.max(0, storageBytes - this.storedBytes())} more bytes.`);
					}
					return noStore(await this.files.write(url.searchParams.get("path"), body), 201);
				}),
		],
		[
			"DELETE",
			"/files",
			(_params, _request, url) =>
				this.#artifactRequest(url, async () => {
					this.#assertOpen();
					await this.files.remove(url.searchParams.get("path"));
					return noStore({ deleted: true });
				}),
		],
		// The agents' browser (see ./browser.ts): what it shows, a picture of it, taking it over, closing it.
		[
			"GET",
			"/browser",
			async () => noStore({ available: this.browser.available, page: this.browser.available ? await this.browser.current() : null }),
		],
		[
			"GET",
			"/browser/screenshot",
			async () => {
				const png = await this.#browserIn().screenshot();
				if (!png) throw new HttpError(404, "The browser is closed");
				return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-store, private", "x-content-type-options": "nosniff" } });
			},
		],
		[
			"POST",
			"/browser/live",
			async () => {
				let url: string | null;
				try {
					url = await this.#browserIn().liveView();
				} catch (error) {
					throw new HttpError(501, error instanceof Error ? error.message : String(error));
				}
				if (!url) throw new HttpError(404, "The browser is closed");
				return noStore({ url });
			},
		],
		[
			"DELETE",
			"/browser",
			async () => {
				await this.#browserIn().close();
				return noStore({ closed: true });
			},
		],
		[
			"GET",
			"/export",
			async () =>
				new Response(await this.exportData(), {
					headers: {
						"content-type": "application/json",
						"content-disposition": `attachment; filename="pim-export-${new Date().toISOString().slice(0, 10)}.json"`,
					},
				}),
		],
		["GET", "/chatgpt", () => this.chatgpt.status()],
		["POST", "/chatgpt/login", () => this.chatgpt.startLogin()],
		[
			"POST",
			"/chatgpt/callback",
			async (_params, request) => {
				const { url } = await readJson<{ url: string }>(request);
				if (typeof url !== "string" || url.trim() === "") throw new HttpError(400, "url must be the address the browser landed on");
				return this.chatgpt.finishLogin(url);
			},
		],
		[
			"DELETE",
			"/chatgpt",
			async () => {
				await this.chatgpt.logout();
				// Sessions on the plan would fail without it: back to the default.
				if (this.chosenModel().provider === CHATGPT_PROVIDER) await this.chooseModel(null);
				return this.chatgpt.status();
			},
		],

		// Long-term memory: what the agent knows about the person. They can always make it forget.
		[
			"GET",
			"/memory",
			() => ({
				count: this.memory.store.count(),
				pendingCompressions: this.memory.store.pending().length,
				view: this.memory.view(),
			}),
		],
		[
			"GET",
			"/memory/log",
			(_params, _request, url) => {
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
				const pattern = url.searchParams.get("q");
				if (pattern !== null) {
					let regex: RegExp;
					try {
						regex = new RegExp(pattern, "i");
					} catch (error) {
						throw new HttpError(400, errorMessage(error));
					}
					return this.memory.store.search(regex, limit);
				}
				const before = url.searchParams.get("before");
				return { entries: this.memory.store.page(limit, before === null ? undefined : Number(before)) };
			},
		],
		[
			"POST",
			"/memory/log",
			async (_params, request) => {
				const { text } = await readJson<{ text: string }>(request);
				const line = typeof text === "string" ? text.trim() : "";
				if (line === "" || /[\r\n]/.test(line)) throw new HttpError(400, "text must be one non-empty line");
				if (byteLength(line) > ENTRY_BYTES) throw new HttpError(400, `text is limited to ${ENTRY_BYTES} bytes`);
				const entry = this.memory.store.append(line, this.memory.today());
				await this.startMemoryNap();
				return Response.json(entry, { status: 201 });
			},
		],
		[
			"DELETE",
			"/memory/log/:id",
			async ({ id }) => {
				if (!/^\d+$/.test(id!) || !this.memory.store.forget(Number(id))) throw new HttpError(404, `No memory ${id}`);
				await this.startMemoryNap();
				return { forgotten: Number(id) };
			},
		],
		[
			"GET",
			"/memory/tree/:block",
			({ block: name }) => {
				const block = parseBlock(name!);
				if (!block) throw new HttpError(400, `${name} is not a block, like 16-31`);
				if (block[0] >= this.memory.store.count()) throw new HttpError(404, `No memories in ${name}`);
				return {
					block: blockName(block),
					summary: this.memory.store.summary(block) ?? null,
					halves: halves(block).map((half) =>
						half[1] - half[0] === 1
							? { block: String(half[0]), line: this.memory.store.entry(half[0]) ? entryLine(this.memory.store.entry(half[0])!) : null }
							: { block: blockName(half), summary: this.memory.store.summary(half) ?? null },
					),
				};
			},
		],
		[
			"DELETE",
			"/memory/tree/:block",
			async ({ block: name }) => {
				const block = parseBlock(name!);
				if (!block) throw new HttpError(400, `${name} is not a block, like 16-31`);
				const dropped = this.memory.store.dropSummary(block);
				if (dropped === 0) throw new HttpError(404, `No summary ${name}`);
				await this.startMemoryNap();
				return { dropped };
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
				return { goals: this.store.goals(status === null ? undefined : (status as GoalStatus)) };
			},
		],
		[
			"GET",
			"/goals/:id",
			({ id }) => this.store.goal(id!) ?? Promise.reject(new HttpError(404, `No goal ${id}`)),
		],
		[
			"DELETE",
			"/goals/:id",
			({ id }) => {
				if (!this.store.deleteGoal(id!)) throw new HttpError(404, `No goal ${id}`);
				return { deleted: true };
			},
		],

		// Background work the agent scheduled for itself.
		[
			"GET",
			"/schedules",
			async () => ({ schedules: (await this.services().listSchedules()).map(describeSchedule) }),
		],
		[
			"DELETE",
			"/schedules/:id",
			async ({ id }) => {
				if (!(await this.services().cancelSchedule(id!))) throw new HttpError(404, `No schedule ${id}`);
				return { deleted: true };
			},
		],

		// Approvals: actions waiting for the person's decision.
		[
			"GET",
			"/approvals",
			(_params, _request, url) => {
				const status = url.searchParams.get("status");
				if (status !== null && !["pending", "approved", "denied"].includes(status)) {
					throw new HttpError(400, "status must be pending, approved or denied");
				}
				return { approvals: this.store.approvals((status ?? undefined) as Approval["status"] | undefined) };
			},
		],
		[
			"GET",
			"/approvals/:id",
			({ id }) => this.store.approval(id!) ?? Promise.reject(new HttpError(404, `No approval ${id}`)),
		],
		[
			"POST",
			"/approvals/:id/approve",
			async ({ id }, request) => {
				const { note, always } = await readJson<{ note: string; always: boolean }>(request);
				const given = typeof note === "string" ? note : undefined;
				return always === true ? this.alwaysApprove(id!, given) : this.decideApproval(id!, "approve", given);
			},
		],
		[
			"POST",
			"/approvals/:id/deny",
			async ({ id }, request) => {
				const { note } = await readJson<{ note: string }>(request);
				return this.decideApproval(id!, "deny", typeof note === "string" ? note : undefined);
			},
		],
		// Tool permissions: which tools Pim may use, and which ask first.
		[
			"GET",
			"/permissions",
			(_params, _request, url) => {
				const circle = url.searchParams.get("circle");
				if (circle !== null) this.#circle(circle);
				return { tools: this.toolPermissions(circle ?? OWNER) };
			},
		],
		[
			"PUT",
			"/permissions",
			async (_params, request) => {
				const { circle, app, tool, permission } = await readJson<{
					circle: string | null;
					app: string | null;
					tool: string;
					permission: ToolPermission | null;
				}>(request);
				if (circle !== null && circle !== undefined && typeof circle !== "string") throw new HttpError(400, "circle must be a circle's id");
				if (app !== null && app !== undefined && (typeof app !== "string" || app === "")) {
					throw new HttpError(400, "app must be an app's id, or null for Pim's own tools");
				}
				if (typeof tool !== "string" || tool === "") throw new HttpError(400, "tool is required");
				if (permission === undefined || (permission !== null && !TOOL_PERMISSIONS.includes(permission))) {
					throw new HttpError(400, `permission must be one of ${TOOL_PERMISSIONS.join(", ")}, or null for the default`);
				}
				return this.setToolPermission(circle ?? OWNER, app ?? "", tool, permission);
			},
		],

		// The owner's agents, the majordomo first.
		["GET", "/agents", () => ({ agents: this.agents.list() })],
		// The majordomo, and whether the person has named it yet.
		["GET", "/majordomo", () => ({ agent: this.agents.majordomo(), introduced: this.agents.introduced() })],
		[
			"POST",
			"/majordomo",
			async (_params, request) => {
				// Named once, when the person first signs in; after that it is edited like any agent.
				if (this.agents.introduced()) throw new HttpError(409, "Your majordomo already has a name");
				const setup = majordomoSetup(await readJson<Record<string, unknown>>(request));
				const majordomo = this.agents.majordomo();
				const { name, symbol, color, instructions } = setup;
				this.agents.update(majordomo.id, agentInput({ name, symbol, color, instructions }, majordomo));
				const memories = setupMemories(setup);
				for (const memory of memories) this.memory.store.append(memory, this.memory.today());
				if (memories.length > 0) await this.startMemoryNap();
				this.agents.introduce();
				// It opens the person's first chat by introducing itself; they answer with whatever they like it to know.
				const title = setup.title ?? (setup.yourName ? `Welcome, ${setup.yourName}` : null);
				if (title) this.store.renameSession(ROOT_SESSION, title);
				try {
					await this.submitTo(ROOT_SESSION, introduction(this.agents.majordomo(), setup), { operationId: "introduction" }, "pim");
				} catch (error) {
					console.warn("the majordomo's introduction failed", error);
				}
				return { agent: this.agents.majordomo(), introduced: true, session: ROOT_SESSION };
			},
		],
		["GET", "/agents/:agent", ({ agent }) => this.#agent(agent!)],
		[
			"POST",
			"/agents",
			async (_params, request) => {
				const agent = this.agents.create(this.#checkApps(this.#checkBlueprint(agentInput(await readJson<Record<string, unknown>>(request)))));
				return Response.json(agent, { status: 201 });
			},
		],
		[
			"PUT",
			"/agents/:agent",
			async ({ agent: id }, request) => {
				return this.agents.update(id!, this.#checkApps(this.#checkBlueprint(agentInput(await readJson<Record<string, unknown>>(request), this.#agent(id!)))));
			},
		],
		// What a model provider fetches; the signature, not the API token, lets it in.
		[
			"GET",
			"/public-images/:image",
			async ({ image }, _request, url) => {
				const found = await this.images.readSigned(image!, url);
				if (!found) throw new HttpError(404, "No such image");
				return new Response(found.body, {
					headers: { "content-type": found.type, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" },
				});
			},
		],
		[
			"GET",
			"/images/:image",
			async ({ image }) => {
				const found = await this.images.read(image!);
				if (!found) throw new HttpError(404, "No such image");
				return new Response(found.body, {
					headers: {
						"content-type": found.type,
						"x-content-type-options": "nosniff",
						"content-security-policy": "default-src 'none'; sandbox",
						"cache-control": "private, max-age=31536000, immutable",
					},
				});
			},
		],
		[
			"GET",
			"/agents/:agent/icon",
			({ agent: id }) => {
				this.#agent(id!);
				const icon = this.agents.icon(id!);
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
				this.#agent(id!);
				const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
				this.agents.setIcon(id!, type, await request.arrayBuffer());
				return this.#agent(id!);
			},
		],
		[
			"DELETE",
			"/agents/:agent/icon",
			({ agent: id }) => {
				this.#agent(id!);
				this.agents.removeIcon(id!);
				return this.#agent(id!);
			},
		],
		["GET", "/agents/:agent/dashboard", ({ agent }, _request, url) => this.#dashboard(this.#agent(agent!), url.searchParams.get("locale") ?? "en")],
		[
			"GET",
			"/extensions",
			() => ({
				extensions: this.extensions.list().map((extension) => ({
					id: extension.id,
					name: extension.name,
					description: extension.description,
					blueprints: (extension.blueprints ?? []).map((blueprint) => ({
						ref: `${extension.id}/${blueprint.id}`,
						name: blueprint.name,
						description: blueprint.description,
						apps: blueprint.apps ?? [],
					})),
					widgets: Object.keys(extension.widgets ?? {}).map((widget) => `${extension.id}/${widget}`),
				})),
				defaultBlueprint: this.extensions.defaultBlueprint,
			}),
		],
		[
			"DELETE",
			"/agents/:agent",
			async ({ agent: id }) => {
				this.#agent(id!);
				this.agents.delete(id!);
				return { deleted: true };
			},
		],

		// Circles: who may message this Pim from their own, and what each circle may use.
		["GET", "/circles", () => ({ circles: this.#describeCircles() })],
		[
			"POST",
			"/circles",
			async (_params, request) => {
				const name = circleName((await readJson<{ name: string }>(request)).name);
				if (this.circles.circles().length >= MAX_CIRCLES) throw new HttpError(429, `You can have up to ${MAX_CIRCLES} circles.`);
				const circle = this.circles.createCircle(name);
				return Response.json(this.#describeCircles().find((candidate) => candidate.id === circle.id), { status: 201 });
			},
		],
		[
			"PUT",
			"/circles/:circle",
			async ({ circle }, request) => {
				this.#circle(circle!);
				const { name, enabled } = await readJson<{ name: string; enabled: boolean }>(request);
				if (enabled !== undefined && typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
				this.circles.updateCircle(circle!, { ...(name !== undefined ? { name: circleName(name) } : {}), ...(enabled !== undefined ? { enabled } : {}) });
				return this.#describeCircles().find((candidate) => candidate.id === circle);
			},
		],
		[
			"DELETE",
			"/circles/:circle",
			async ({ circle }) => {
				this.#circle(circle!);
				const members = this.circles.deleteCircle(circle!);
				this.store.clearAudience(circle!);
				await this.#tellRevoked(members.map((member) => member.ownerId));
				return { deleted: true };
			},
		],
		[
			"DELETE",
			"/circles/:circle/members/:member",
			async ({ circle, member }) => {
				this.#circle(circle!);
				if (this.circles.member(member!)?.circle !== circle) throw new HttpError(404, `No member ${member} in circle ${circle}`);
				await this.removeCircleMember(member!);
				return { deleted: true };
			},
		],
		["GET", "/circles/activity", () => ({ activity: this.circles.activity() })],

		// Visits: Pims shared with this one's owner.
		[
			"GET",
			"/visits",
			() => ({
				visits: this.visits.shares().map((share) => ({
					ownerId: share.ownerId,
					username: share.username,
					sharedAt: share.sharedAt,
					available: !share.revoked,
					session: share.session !== null && !this.store.deletedSessions().has(share.session) ? share.session : null,
				})),
			}),
		],
		["POST", "/visits/:username", async ({ username }) => ({ session: await this.startVisit(username!) })],

		// The apps people can connect, and the person's connections to them.
		[
			"GET",
			"/app-directory",
			async () => {
				await this.#refreshCustomApps(true);
				return { apps: this.appDirectory() };
			},
		],
		["GET", "/mcp", () => ({ servers: this.#describeApps() })],
		// Where the person comes back from signing in to an app its extension implements; the Worker found this Pim by its `state`.
		[
			"GET",
			APPS_CALLBACK_PATH,
			async (_params, _request, url) => {
				const result = await this.nativeApps.finish(url);
				const ok = "name" in result;
				return new Response(
					ok
						? "<!doctype html><title>Connected</title><p>Connected. You can close this window and go back to Pim.</p>"
						: `<!doctype html><title>Not connected</title><p>Sign-in failed: ${result.error.replace(/[<&]/g, "")}</p>`,
					{ status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } },
				);
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
				await this.#refreshCustomApps(true);
				const app = this.appDirectory().find((candidate) => candidate.ref === body.app);
				if (!app) throw new HttpError(400, "app must be the id of an app this Pim offers");
				const result = await this.connectApp(app, body.approval ? { approval: body.approval } : {});
				return Response.json(result, { status: 201 });
			},
		],
		[
			"PUT",
			"/mcp/:id",
			async ({ id }, request) => {
				if (!this.apps.servers().some((server) => server.id === id)) throw new HttpError(404, `No app ${id}`);
				const { approval } = await readJson<{ approval: McpApproval }>(request);
				if (!MCP_APPROVALS.includes(approval as McpApproval)) {
					throw new HttpError(400, `approval must be one of ${MCP_APPROVALS.join(", ")}`);
				}
				this.store.setMcpApproval(id!, approval!);
				this.#installApps();
				return this.#describeApps().find((server) => server.id === id);
			},
		],
		[
			"DELETE",
			"/mcp/:id",
			async ({ id }) => {
				if (!this.apps.servers().some((server) => server.id === id)) throw new HttpError(404, `No app ${id}`);
				for (const watch of this.store.watches(id)) await this.appEvents.stop(watch.id);
				await this.#disconnect(id!);
				this.catalog.forget(id!);
				this.#installApps();
				return { deleted: true };
			},
		],

		[
			"GET",
			"/mcp/:id/skills",
			({ id }) => {
				if (!this.apps.servers().some((server) => server.id === id)) throw new HttpError(404, `No app ${id}`);
				return { skills: this.catalog.skills(id!) };
			},
		],
		[
			"GET",
			"/mcp/:id/events",
			({ id }) => {
				if (!this.apps.servers().some((server) => server.id === id)) throw new HttpError(404, `No app ${id}`);
				return { events: this.catalog.events(id!) };
			},
		],
		// Deliveries from apps; authenticated by their Standard Webhooks signature, not the API token.
		["POST", "/mcp/events/:watch", ({ watch }, request) => this.appEvents.receive(watch!, request)],

		// Event watches.
		["GET", "/watches", () => ({ watches: this.appEvents.list() })],
		[
			"DELETE",
			"/watches/:id",
			async ({ id }) => {
				if (!(await this.appEvents.stop(id!))) throw new HttpError(404, `No watch ${id}`);
				return { deleted: true };
			},
		],

		// Web Push: the key a browser subscribes with, and the subscription it gets.
		["GET", "/push/key", async () => ({ publicKey: (await this.#vapidKeys()).publicKey })],
		[
			"PUT",
			"/push/subscription",
			async (_params, request) => {
				const subscription = await readJson<PushSubscription>(request);
				if (!validSubscription(subscription)) throw new HttpError(400, "Body must be a push subscription: https endpoint, p256dh and auth");
				this.store.putPushSubscription(subscription);
				return { subscribed: true };
			},
		],
		[
			"DELETE",
			"/push/subscription",
			async (_params, request) => {
				const { endpoint } = await readJson<{ endpoint: string }>(request);
				if (typeof endpoint !== "string") throw new HttpError(400, "Body must have an endpoint");
				this.store.deletePushSubscription(endpoint);
				return { subscribed: false };
			},
		],

		// Notifications the agent sent.
		[
			"GET",
			"/notifications",
			(_params, _request, url) => ({
				notifications: this.store.notifications({ unread: url.searchParams.get("unread") === "true" }),
			}),
		],
		[
			"POST",
			"/notifications/:id/read",
			({ id }) => {
				if (!this.store.notification(id!)) throw new HttpError(404, `No notification ${id}`);
				this.store.markNotificationRead(id!);
				return this.store.notification(id!);
			},
		],
	];

	#describeSettings() {
		const settings = this.settings();
		const timeout = this.approvalTimeoutMs(settings.approvalPolicy);
		return { ...settings, approvalTimeoutSeconds: timeout === null ? null : timeout / 1000 };
	}

	/** How every agent works, and the person's agents: rebuilt when whether `update_agent` asks first changes. */
	#agentExtension(services: PimServices) {
		return agentExtension(
			services,
			(session) => this.#roleOf(session),
			(agent) => (agent.blueprint === null ? undefined : this.extensions.blueprint(agent.blueprint)),
			{
				list: () => this.agents.list(),
				blueprints: () => this.extensions.blueprints().map(({ ref, blueprint }) => ({ ref, name: blueprint.name, description: blueprint.description })),
				apps: () => this.appDirectory(),
				create: (input) => this.agents.create(this.#checkApps(this.#checkBlueprint(agentInput(input)))),
			},
		);
	}

	/** Rebuilds the extensions whose tools describe the approval policy, once pi's registry has been set up. */
	#reinstallApprovals(): void {
		if (!this.registry.snapshot().extension("pim.approvals")) return;
		const services = this.services();
		this.registry.install(this.#agentExtension(services));
		this.registry.install(approvalsExtension(services, this.#ownActions));
		this.#installBrowser(services);
		this.#installAbilities(services);
		this.#installApps();
	}

	/** The browser's tools, where this deployment has a browser; clicking and typing follow their permissions. */
	#installBrowser(services: PimServices): void {
		if (!this.browser.available) return;
		this.registry.install(
			browserExtension(services, {
				browser: this.browser,
				saveScreenshot: async (path, png) => {
					this.#assertOpen();
					const refusal = this.#storageRefusal();
					if (refusal) throw new Error(refusal);
					const target = path ?? `${FILES_ROOT}/screenshots/${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
					return (await this.files.write(target, png)).path;
				},
			}),
		);
	}

	#describeCircles() {
		const members = this.circles.members();
		return this.circles.circles().map((circle) => ({
			...circle,
			members: members.filter((member) => member.circle === circle.id).map(({ ownerId, username, addedAt }) => ({ ownerId, username, addedAt })),
		}));
	}

	#describeApps() {
		const catalog = this.apps.tools();
		const servers = this.apps.servers();
		const directory = this.appDirectory();
		const agents = this.agents.list().map((agent) => ({ name: agent.name, servers: new Set(this.#appsOf(agent).map((app) => serverFor(servers, app)?.id)) }));
		return servers.map((server) => ({
			...server,
			// The directory's app it connects; null for one this Pim no longer offers.
			app: directory.find((app) => serverFor([server], app))?.ref ?? null,
			// The person's agents that list the app: only their chats get its tools.
			agents: agents.filter((agent) => agent.servers.has(server.id)).map((agent) => agent.name),
			tools: catalog
				.filter((tool) => tool.serverId === server.id)
				.map((tool) => {
					const { permission } = appToolPermission(this.store, server, tool);
					return {
						name: toolName(server.id, tool.name),
						description: tool.description ?? null,
						permission,
						requiresApproval: permission === "ask",
					};
				}),
		}));
	}

	// WebSocket API

	/** Pim speaks only its own protocol (see `protocol.ts`) on its sockets. */
	shouldSendProtocolMessages(): boolean {
		return false;
	}

	async onConnect(connection: Connection<SocketState>, ctx: ConnectionContext): Promise<void> {
		const requested = new URL(ctx.request.url).searchParams.get("session") || ROOT_SESSION;
		let session: string;
		try {
			session = await this.#session(requested);
		} catch (error) {
			this.#send(connection, { type: "error", message: errorMessage(error) });
			connection.close(4004, "Unknown session");
			return;
		}
		connection.setState({ session });
		this.#send(connection, { type: "hello", session, tools: this.tools() });
		await this.#watch(connection, session);
	}

	async onMessage(connection: Connection<SocketState>, raw: WSMessage): Promise<void> {
		if (typeof raw !== "string") return;
		let message: ClientMessage;
		try {
			message = JSON.parse(raw) as ClientMessage;
		} catch {
			this.#send(connection, { type: "error", message: "Malformed JSON" });
			return;
		}
		const session = connection.state?.session ?? ROOT_SESSION;
		try {
			const result = await this.#command(connection, session, message);
			if (message.id !== undefined) this.#send(connection, { type: "result", id: message.id, result });
		} catch (error) {
			this.#send(connection, {
				type: "error",
				...(message.id === undefined ? {} : { id: message.id }),
				message: errorMessage(error),
			});
		}
	}

	async onClose(connection: Connection): Promise<void> {
		await this.#unwatch(connection.id);
	}

	async onError(connection: Connection): Promise<void> {
		await this.#unwatch(connection.id);
	}

	async #command(connection: Connection, session: string, message: ClientMessage): Promise<JsonValue> {
		const handle = this.harness.session(session);
		switch (message.type) {
			case "submit":
				return await this.submitTo(
					session,
					userInput(message.content),
					{
						...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
						...(message.operationId ? { operationId: message.operationId } : {}),
					},
					"user",
				);
			case "abort":
				return await handle.abort(message.operationId);
			case "reset":
				await handle.reset(message.handoff);
				return null;
			case "resync":
				await this.#watch(connection, session);
				return null;
			default:
				throw new Error(`Unknown message type ${JSON.stringify((message as { type: unknown }).type)}`);
		}
	}

	async #watch(connection: Connection, session: string): Promise<void> {
		await this.#unwatch(connection.id);
		const stream = await this.harness.session(session).events();
		this.#watches.set(connection.id, stream);
		this.#send(connection, { type: "events", session, events: [stream.snapshot] });
		stream.start(async (events) => {
			if (connection.readyState !== WebSocket.OPEN) {
				void this.#unwatch(connection.id);
				return;
			}
			this.#send(connection, { type: "events", session, events });
		});
	}

	async #unwatch(connectionId: string): Promise<void> {
		const stream = this.#watches.get(connectionId);
		if (!stream) return;
		this.#watches.delete(connectionId);
		await stream.stop();
	}

	#send(connection: Connection, message: ServerMessage): void {
		if (connection.readyState !== WebSocket.OPEN) return;
		try {
			connection.send(JSON.stringify(message));
		} catch {
			// Closed between the check and the send.
		}
	}

	broadcastMessage(message: ServerMessage): void {
		this.broadcast(JSON.stringify(message));
	}
}
