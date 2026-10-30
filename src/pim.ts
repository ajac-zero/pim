import { Workspace } from "@cloudflare/computer";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, JsonValue, Model } from "@earendil-works/pi-ai";
import { createModels, type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
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
	type TaskId,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { type AgentMcpOAuthProvider, Agent as DurableAgent, type Connection, type ConnectionContext, DurableObjectOAuthClientProvider, getAgentByName, type Schedule, type WSMessage } from "agents";
import { type PiModel, PiHarness, type PiOperationResult, type PiReceipt, ROOT_SESSION } from "agents/harness/pi";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import {
	ENTRY_FILES,
	type ArtifactFile,
	type ArtifactKind,
	type ArtifactSummary,
	ArtifactStore,
	artifactHeaders,
	checkFiles,
	checkPath,
	checkTitle,
	type DataScope,
	downloadName,
	fileType,
	isTextType,
	framePage,
	hasWidget,
	type LoadedFiles,
	readFiles,
	textOf as fileText,
} from "./artifacts";
import { digestHex } from "./auth/store";
import { Email, type Mailer, mailerFrom } from "./email";
import {
	answersInSchema,
	builtinProviders,
	type CustomProvider,
	MAX_PROVIDERS,
	OWN_PROVIDER,
	piProvider,
	providerModel,
	prepareProvider,
	providerInfo,
	type ProviderInput,
	SHARED_PROVIDER,
} from "./providers";
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
import { INSTALL_SKILL, type SkillWriters, skillsExtension, skillsSwitch, WRITE_SKILL, writeSkillAction } from "./extensions/skills";
import { SKILL_NAME, SkillStore } from "./skills";
import {
	approvalsExtension,
	gatedTools,
	describeWait,
	type GatedAction,
	httpRequest,
	ownToolPermission,
	type ResolvedPermission,
} from "./extensions/approvals";
import pimConfig from "../pim.config";
import { artifactsExtension, artifactsWidgets } from "./extensions/artifacts";
import { type FileServices, fileDeleteAction, filesExtension, SHELL, shellAction } from "./extensions/files";
import { BROWSER_CLICK, BROWSER_EXTENSION, BROWSER_TYPE, BROWSER_UPLOAD, browserClickAction, browserExtension, browserTypeAction, browserUploadAction } from "./extensions/browser";
import { DESKTOP_ACT, DESKTOP_EXTENSION, desktopAction, desktopExtension } from "./extensions/desktop";
import { IMAGES_EXTENSION, type ImageModel, imageGenerationExtension, workersAiImageModel } from "./extensions/image-generation";
import { appDirectory, type CustomApp, type DirectoryApp } from "./extensions/app-directory";
import { ExtensionDataStore } from "./extensions/data";
import { NativeApps } from "./extensions/native-apps";
import {
	type Ability,
	APP_CREDENTIALS_KEY,
	checkToolNames,
	CUSTOM_APPS,
	isNativeApp,
	secretsOf,
	type NativeAppDefinition,
	type ToolWidget,
	type PimConfig,
	PimExtensions,
	type ShownWidget,
	shownWidgets,
	type Widget,
	type WidgetContext,
	localize,
	widgetMarkdown,
} from "./extensions/define";
import { chatsExtension } from "./extensions/chats";
import { goalsExtension, goalsWidgets } from "./extensions/goals";
import { DEFAULT_WIDGET_SIZE, dashboardExtension, MAX_DASHBOARD, UPDATE_DASHBOARD, WIDGET_SIZES, type WidgetSize } from "./extensions/dashboard";
import {
	agentAudience,
	agentToolPermission,
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
import { MESSAGING_EXTENSION, messagingExtension, NOT_DELIVERED, plainReply, SEND_TO_USER } from "./extensions/messaging";
import { CREATE_MEMORY_SCOPE, createOptMem, type MemoryAccess, type MemoryScope, memoryWidgets } from "./extensions/optmem";
import { blockName, halves, parseBlock } from "./extensions/optmem/cover";
import { byteLength, ENTRY_BYTES, EVERYONE_SCOPE, entryLine, MAX_NAMED_SCOPES, MAX_SCOPE_NAME, PRIVATE_SCOPE } from "./extensions/optmem/store";
import {
	ADD_CUSTOM_APP,
	addCustomAppAction,
	CREATE_AGENT,
	agentExtension,
	MANAGE_APPS,
	manageAppsAction,
	requestedIcon,
	SHARE_MEMORY_SCOPE,
	shareMemoryScopeAction,
	UPDATE_AGENT,
	updateAgentAction,
} from "./extensions/agents";
import { describeSchedule, SCHEDULE_EXTENSION, scheduleExtension, scheduleWidgets } from "./extensions/schedule";
import type { PimServices, ScheduledTaskPayload } from "./extensions/services";
import { webExtension } from "./extensions/web";
import { COMPUTER_PATH, COMPUTER_SCREEN_PATH, COMPUTER_TAG, COMPUTER_TOKEN_HEADER, Computer, SCREEN_TAG } from "./computer";
import { machineName } from "./computer-host";
import { FILES_ROOT, Files, fileHeaders, MAX_UPLOAD_BYTES } from "./files";
import { LegacyFiles } from "./legacy-files";
import { BROWSER_LIVE_PATH, BROWSER_TAG, type BrowserInput, type BrowserLiveMessage, PimBrowser } from "./browser";
import { type DeploymentSettings, deploymentSettings } from "./deployment";
import { dispatch, HttpError, readJson, type Route } from "./http";
import type { ClientMessage, PublicApproval, ServerMessage, ToolInfo } from "./protocol";
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
import { type Agent, type AgentInput, type AgentModel, AgentStore, agentInput, checkContacts, freeName, MAX_AGENTS } from "./agents";
import { ChatLinkStore, LINK_ID, MAX_SHARED_BYTES, type SharedChat, sharedMessages } from "./chat-links";
import type { AgentIcon, ArtifactToPublish, PublishedAgent } from "./gallery";
import { MAX_ROOM_DEPTH, mentioned, mentionsPerson, ROOM_ENTRY, ROOM_HISTORY_CHARS, ROOM_NOTICE, ROOM_POST, type RoomMode, RoomStore, roomHistory, roomPost, roomsExtension, type Seat } from "./rooms";
import { MAX_TASK_DEPTH, type Role, type Task, TaskStore, TERMINAL_STATES, tasksExtension, taskUpdate } from "./tasks";
import { DECIDE_APPROVAL, introduction, majordomoPreferences, majordomoSetup, REVIEW_EXTENSION, setupMemories, reviewExtension, withPreferences } from "./majordomo";
import { Progress } from "./progress";
import { exporterFrom, TELEMETRY_EXTENSION, Telemetry, type TelemetryEnv } from "./telemetry";
import { projectEntries } from "./transcript";
import { ARTIFACT_ASK, conversationText, DESCRIBE_WORK, IMPROVE_PROMPT, NAME_CHAT, type StructuredUtilityTask, SUGGEST_PROMPTS, SUMMARIZE_CHAT, type UtilityTask, withJsonSchema } from "./utility";
import { type Limits, parseLimits, sessionCost, UsageMeter } from "./usage";
import { type BriefResult, type GuestBrief, type GuestCallResult, VISIT_PREFIX, VisitStore, visitExtension, visitExtensionName } from "./visits";

const SCHEDULED_TASK_CALLBACK = "runScheduledTask";

/** Pim's own widgets: every chat can show them. */
const BUILT_IN_WIDGETS = ["pim.goals", "pim.schedule", "pim.memory", "pim.artifacts"];
/** Pim's own actions that use the person's computer, offered only while one is paired. */
const COMPUTER_ACTIONS: ReadonlySet<string> = new Set(["file_delete", SHELL, BROWSER_CLICK, BROWSER_TYPE, BROWSER_UPLOAD, DESKTOP_ACT]);
/** How a dashboard names an artifact pinned to it: `artifact:<id>`. */
const PINNED_ARTIFACT = "artifact:";

/**
 * Set by the Worker on every request it forwards: the owner it resolved,
 * which must be the agent's own name. A request routed to the wrong agent is
 * refused rather than served.
 */
export const OWNER_HEADER = "x-pim-owner";
/**
 * Set by the Worker, and only by it, on API requests from the person's
 * signed-in browser rather than an API token: what runs this Pim, such as
 * approving an app for everyone on it, needs that, as the admin API does.
 */
export const SIGNED_IN_HEADER = "x-pim-signed-in";

/** Where apps' sign-ins return, as `/mcp/callback/<owner>`, so the Worker knows whose space the callback is for. */
export const MCP_CALLBACK_PATH = "/mcp/callback";
/**
 * Where sign-ins to the apps extensions implement return, the same for
 * everyone so services can have it registered: `state` names the owner,
 * `<owner>.<nonce>`. Owner ids start with `o_`, so it is nobody's `/mcp/callback/<owner>`.
 */
export const APPS_CALLBACK_PATH = `${MCP_CALLBACK_PATH}/apps`;
/** Pim's client metadata document for sign-ins that take one, as `/mcp/client/<owner>`: it names that owner's callback. */
export const MCP_CLIENT_PATH = "/mcp/client";
/** Where the Worker sends `/mcp`: this space as an MCP server (./mcp-server.ts). */
export const MCP_SERVER_PATH = "/mcp-server";
/** Where apps deliver event webhooks, as `/mcp/events/<owner>/<watch id>`; signed, so served without the API token. The space sees `/mcp/events/<watch id>`. */
export const MCP_EVENTS_PATH = "/mcp/events/";
const WATCH_REFRESH_CALLBACK = "refreshAppWatch";
/** How long an approval waits for the user under the `auto` policy before it is granted, so background work never stalls. */
const APPROVAL_TIMEOUT_MS = 30_000;
/** Decides an approval its timeout reached, as it was filed to be decided. */
const APPROVAL_EXPIRY_CALLBACK = "expireApproval";
/** How long the majordomo has to decide another agent's request before the person is asked anyway. */
const REVIEW_MS = 5 * 60 * 1000;
const REVIEW_EXPIRY_CALLBACK = "expireReview";
/** How long a reply may stay unread before it is pushed: time for an open chat to mark it read. */
const REPLY_PUSH_DELAY_SECONDS = 10;
const REPLY_PUSH_CALLBACK = "pushReply";

/** How long a guest's request waits for the owner before it is denied. */
const GUEST_APPROVAL_MS = 24 * 60 * 60 * 1000;
/** How long a chat goes without activity before it is archived: listed apart, not deleted. */
const ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** The page a browser lands on after signing in to an app: what happened, and a way back to Pim. */
function signInResultPage(connected: boolean, home: string | undefined, error?: string): Response {
	const escape = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
	const title = connected ? "Connected" : "Not connected";
	const detail = connected ? "The app is ready to use. You can close this tab or go back to Pim." : `Sign-in failed: ${escape(error ?? "unknown error")}`;
	const back = home ? `<a href="${escape(home)}">Back to Pim</a>` : "";
	const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;text-align:center;padding:1.5rem;box-sizing:border-box}
main{max-width:22rem}
.logo{width:4rem;display:block;margin:0 auto 2rem}
.mark{width:3rem;height:3rem;border-radius:50%;margin:0 auto 1.25rem;display:grid;place-items:center;font-size:1.5rem;color:#fff;background:${connected ? "#2e9e5b" : "#d1434b"}}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0 0 1.5rem;opacity:.7;line-height:1.5}
a{display:inline-block;padding:.6rem 1.2rem;border-radius:999px;background:#3d59a1;color:#fff;text-decoration:none;font-weight:500}
</style>
<main><svg class="logo" viewBox="0 0 8 4" shape-rendering="crispEdges" aria-hidden="true"><path fill="#e48a7a" d="M0 0h3v1H0zM2 1h1v1H2z"/><path fill="#4f8eb3" d="M0 1h1v3H0zM1 2h1v1H1z"/><path fill="#eab65d" d="M3 2h1v2H3z"/><path fill="#a88cd6" d="M4 1h4v1H4zM5 2h1v2H5zM7 2h1v2H7z"/></svg><div class="mark">${connected ? "&#10003;" : "!"}</div><h1>${title}</h1><p>${detail}</p>${back}</main>`;
	return new Response(body, { status: connected ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/** A circle's name as given: trimmed, not empty, not long. */
function circleName(name: unknown): string {
	if (typeof name !== "string" || name.trim() === "") throw new HttpError(400, "name must be a non-empty string");
	if (name.trim().length > MAX_CIRCLE_NAME) throw new HttpError(400, `name must be at most ${MAX_CIRCLE_NAME} characters`);
	return name.trim();
}

/** A named memory scope's name as given: trimmed, not empty, not long. */
function scopeName(name: unknown): string {
	if (typeof name !== "string" || name.trim() === "") throw new HttpError(400, "name must be a non-empty string");
	if (name.trim().length > MAX_SCOPE_NAME) throw new HttpError(400, `name must be at most ${MAX_SCOPE_NAME} characters`);
	return name.trim();
}

/** A memory scope as the API shows it. */
export type MemoryScopeInfo = {
	readonly key: string;
	/**
	 * `private`: the majordomo's own; `everyone`: every agent reads it;
	 * `agent`: an agent's own, which copies of it share; `named`: one the
	 * person made, for the agents they choose; `former`: left by an agent or
	 * named scope since deleted, which only the majordomo reads.
	 */
	readonly kind: "private" | "everyone" | "agent" | "named" | "former";
	/** A named scope's name, or the names of the agents whose own scope it is; null for the others. */
	readonly name: string | null;
	/** The agents whose own scope it is, by id. */
	readonly agents: readonly string[];
	/** The agents that read it, by id: the majordomo reads every scope. */
	readonly readers: readonly string[];
	/** The memories in it, those forgotten too. */
	readonly count: number;
};

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
	/** The app says the tool may delete or overwrite things. */
	readonly destructive: boolean;
	/** The permissions it can have. */
	readonly choices: readonly ToolPermission[];
};

/** Whether the space works: a suspended one answers nothing and runs nothing until its operator lifts it. */
export type OwnerStatus = "active" | "suspended";

/** What registration tells a space about its owner when it provisions it. */
export type OwnerProfile = { readonly ownerId: string; readonly username: string };
/** How long an erasure waits for runs to stop and apps to unsubscribe before wiping anyway. */
const ERASE_COURTESY_MS = 3_000;
/** `pim_meta` keys of the models chosen through the API: for chats, and the utility model. */
const MODEL_KEY = "model";
/** What a deployment without the `AI` binding has for Workers AI: it fails every request with a way forward. */
type AiEnv = { readonly AI?: Ai };
const NO_WORKERS_AI = {
	run: async () => {
		throw new Error("No model is set up. Add a model provider in Settings → Model → Providers, or ask this Pim's admin to.");
	},
} as unknown as Ai;
const UTILITY_MODEL_KEY = "utility_model";
/** `pim_meta` keys of an agent's dashboard suggestions (see `Pim.#suggestions`) start with this, then its id. */
const SUGGESTIONS_KEY = "suggestions:";
/** What the utility model reads to suggest prompts: the latest chats, and how much of each and of memory. */
const SUGGESTION_CHATS = 3;
const SUGGESTION_CHAT_CHARS = 2_000;
/** How much of a chat an agent reads with `read_chat`: its latest part. */
const READ_CHAT_CHARS = 48_000;
const SUGGESTION_MEMORY_CHARS = 3_000;
/** `pim_meta` keys the Worker sets: the owner's profile, a suspension, the space's own limits. */
const PROFILE_KEY = "owner";
/** What the person told their majordomo to call them, when they set it up. */
const PERSON_NAME_KEY = "person_name";
const STATUS_KEY = "status";
const LIMITS_KEY = "limits";
/** Tools of the space the person talks with that an agent at work on a task doesn't get, though their extensions stay. */
/**
 * Only the majordomo is offered these: naming memory scopes and choosing which agents read them, as it reads every
 * scope; and, in the admin's space, adding apps to this Pim.
 */
const MAJORDOMO_TOOLS = [CREATE_MEMORY_SCOPE, SHARE_MEMORY_SCOPE, ADD_CUSTOM_APP];
/** Subscribing to an app's events needs no approval, so its setting is only Off or On, and Ask (from before) counts as On. */
const WATCH_APP_EVENT = "watch_app_event";
const LEAD_ONLY_TOOLS = new Set([WATCH_APP_EVENT, CREATE_AGENT, UPDATE_AGENT, MANAGE_APPS, ADD_CUSTOM_APP, WRITE_SKILL, INSTALL_SKILL]);
/** Set once chats' agents come from the prompt's `agent` section, not from instructions stored in each chat. */
/** The admin's apps, as this space last read them from the gallery, and how long before it reads them again. */
const CUSTOM_APPS_KEY = "custom_apps";
/** "1" when the owner is this Pim's admin, as last read from the directory with the admin's apps. */
const OWNER_ADMIN_KEY = "owner_admin";
/** How long what the admin shares through the gallery (apps and model providers) is used before it's read again. */
const CUSTOM_APPS_TTL_MS = 60_000;
/** The person's own model providers (./providers.ts), keys included. */
const OWN_PROVIDERS_KEY = "own_providers";
/** The admin's model providers, as last read from the gallery. */
const SHARED_PROVIDERS_KEY = "shared_providers";
const AGENT_SECTION_KEY = "pim_section";
/** The day the person was last told a limit stopped background work. */
const LIMIT_NOTICE_KEY = "limit_notice";
/** The chat each new-chat task last started, so a retried firing doesn't start another. */
const SCHEDULED_CHATS_KEY = "scheduled_chats";
/** Accepts any JSON-RPC result: pim checks the shapes of extension results itself. */
const ANY_RESULT = { "~standard": { version: 1, vendor: "pim", validate: (value: unknown) => ({ value }) } };

const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;

/** An artifact API answer the browser must never keep: what it shows can be deleted, or the sign-in end. */
function noStore(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store, private", "x-content-type-options": "nosniff" } });
}
const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "done", "abandoned"];

/** A socket's chat, or for an app showing the computer's desktop, the channel its stream comes on. */
type SocketState = { readonly session: string; readonly channel?: number };

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
		// The majordomo until the person names it: built on the deployment's default blueprint, or bare.
		const ref = this.extensions.defaultBlueprint;
		const blueprint = ref === null ? undefined : this.extensions.blueprint(ref);
		return { name: "Majordomo", description: "", instructions: "", apps: [], skills: [], contacts: [], blueprint: blueprint ? ref : null };
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
	/** The person's computer, which their agents use, if they have one (see ./computer.ts). */
	readonly computer: Computer = new Computer({
		meta: this.store,
		sockets: () => [...this.getConnections(COMPUTER_TAG)],
		screen: (channel, data) => this.#screenSaid(channel, data),
	});
	/** The person's files, on their computer, which they and their agents share (see ./files.ts). */
	readonly files = new Files(this.computer);
	readonly #files: FileServices = { computer: this.computer, assertOpen: () => this.#assertOpen() };
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
	#modelCatalog: Models | undefined;
	/** Long-term memory: an OptMem-style log and summary tree for each scope, each conversation reading those of its agent. */
	readonly memory = createOptMem({
		sql: this.ctx.storage.sql,
		timeZone: () => this.settings().timeZone,
		viewLines: this.deployment().memoryLines,
		compressionModel: () => this.memoryModel(),
		access: (conversation) => this.#memoryAccess(this.#roleOf(conversation).agent),
	});
	/** Traces of the agents' runs, model requests and tool calls, for the deployment's OpenTelemetry backend (./telemetry.ts). */
	readonly telemetry = new Telemetry({
		exporter: this.spanExporter(),
		content: (this.env as TelemetryEnv).OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === "true",
		service: (this.env as TelemetryEnv).OTEL_SERVICE_NAME || "pim",
		instance: this.ctx.id.toString(),
		agentOf: (conversation) => {
			const { agent } = this.#roleOf(conversation);
			return { id: agent.id, name: agent.name };
		},
		idOf: (conversation) => this.store.publicId(conversation),
	});
	readonly registry = this.telemetry.instrument(createRegistry());
	/** What agents are doing, in a few words, for those who have their chats open (see ./progress.ts). */
	readonly #progress = new Progress({
		watched: (session) => this.#watchers(session).length > 0,
		describe: (input) => this.utility(DESCRIBE_WORK, input),
		show: (session, line, calls) => {
			for (const connection of this.#watchers(session)) this.#send(connection, { type: "progress", session: this.store.publicId(session), text: line, calls });
		},
		keepAliveWhile: (work) => this.keepAliveWhile(work),
	});
	#extensions: PimExtensions | undefined;
	/** Extensions' own data, each apart from the others'. */
	readonly extensionData = new ExtensionDataStore(this.ctx.storage.sql);
	#abilities: Map<string, Ability> | undefined;
	/** What this space has used, and its limits. */
	readonly usage = new UsageMeter({
		sql: this.ctx.storage.sql,
		limits: () => this.limits(),
		// The person's own plan and providers: their tokens are theirs, not the deployment's.
		ownProvider: (provider) => provider === CHATGPT_PROVIDER || provider.startsWith(OWN_PROVIDER),
	});
	/** The person's connections to apps extensions implement themselves, with their sign-ins. */
	readonly nativeApps = new NativeApps({
		sql: this.ctx.storage.sql,
		app: (ref) => {
			const app = this.extensions.app(ref);
			return app && isNativeApp(app) ? app : undefined;
		},
		secrets: (app) => this.#secrets(app),
		credentialsKey: () => this.#env([APP_CREDENTIALS_KEY])[APP_CREDENTIALS_KEY] ?? null,
		callbackUrl: () => `${this.deployment().publicUrl}${APPS_CALLBACK_PATH}`,
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
			// Work still under way on a space being erased acts on nobody's behalf.
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
		publicUrl: () => this.deployment().publicUrl ?? undefined,
		owner: () => this.name,
		scheduleRefresh: (id, at) => this.#scheduleWatchRefresh(id, at),
		submit: async (session, content, operationId) => {
			await this.submitTo(session, content, { operationId }, "pim");
			// A member's own conversation isn't the one the person reads, so the chat is told too.
			const seat = this.#rooms.of(session);
			if (seat && seat.conversation !== seat.room) {
				const name = this.agents.get(seat.agent)?.name ?? "An agent";
				const first = content.split("\n")[0]?.replace(/^\[App event\]\s*/, "") ?? "";
				await this.#write(seat.room, `${ROOM_NOTICE} ${name} got an app event: ${first}`, `event:${operationId}`);
				this.broadcastMessage({ type: "sessions" });
			}
		},
		notify: async (title, body) => {
			const notification = this.store.addNotification({ id: crypto.randomUUID(), session: null, title, body });
			await this.deliverNotification(notification);
		},
	});
	/** What decides who writes which skill, read as it is at each check (./extensions/skills.ts). */
	readonly #skillWriters: SkillWriters = { agents: this.agents, store: this.store, skills: this.skills, roleOf: (session) => this.#roleOf(session) };
	/** Pim's own actions; the extensions' come with their abilities. */
	readonly #ownActions: readonly GatedAction[] = [
		httpRequest as GatedAction,
		...mcpActions(this.apps),
		watchAction(this.apps, this.appEvents),
		updateAgentAction(this.agents, this.files),
		shareMemoryScopeAction(this.agents, () => this.memory.store.namedScopes()),
		manageAppsAction(this.agents, this.apps, () => this.appDirectory()),
		addCustomAppAction(this.agents, this.apps, (app) => this.#addCustomApp(app)),
		fileDeleteAction(this.#files),
		shellAction(this.computer),
		browserClickAction(this.browser, (conversation) => this.#browserWindowOf(conversation)),
		browserTypeAction(this.browser, (conversation) => this.#browserWindowOf(conversation)),
		browserUploadAction(
			this.browser,
			(conversation) => this.#browserWindowOf(conversation),
			(path) => this.computer.localPath(path),
		),
		desktopAction(this.computer),
		writeSkillAction(this.skills, this.#skillWriters, this.files),
	];

	/**
	 * Pim's own actions whose tools agents are offered now: those that use the
	 * computer only while one is paired (its desktop's, while it has one they
	 * can use), and adding apps to this Pim only in its admin's space.
	 */
	#offeredActions(): GatedAction[] {
		const computer = this.computer.paired();
		const desktop = this.computer.desktop();
		const admin = this.store.meta(OWNER_ADMIN_KEY) === "1";
		return this.#ownActions.filter(
			(action) =>
				(computer || !COMPUTER_ACTIONS.has(action.name)) && (desktop || action.name !== DESKTOP_ACT) && (admin || action.name !== ADD_CUSTOM_APP),
		);
	}

	/** Every action an approval can be for: Pim's own, and the extensions'. */
	get actions(): readonly GatedAction[] {
		return [...this.#ownActions, ...[...this.abilities.values()].flatMap((ability) => ability.actions ?? [])];
	}

	readonly harness = new PiHarness({
		harness: async ({ storage, context }) => {
			const services = this.services();
			this.#migrateAlwaysApproved();
			this.registry.install(this.telemetry.extension());
			this.registry.install(this.#progress.extension());
			this.registry.install(this.#agentExtension(services));
			this.registry.install(this.#skillsExtension(services));
			this.registry.install(goalsExtension(services));
			this.registry.install(scheduleExtension(services, (session) => this.#roleOf(session), (id) => this.agents.get(id)));
			this.registry.install(messagingExtension(services));
			this.registry.install(
				chatsExtension(async (id) => {
					const session = await this.#session(id).catch(() => null);
					if (session === null) return null;
					return { title: this.store.sessionInfo(session)?.title ?? null, conversation: conversationText(projectEntries(await this.harness.session(session).messages()), READ_CHAT_CHARS) };
				}),
			);
			this.registry.install(
				tasksExtension({
					roleOf: (session) => this.#roleOf(session),
					delegates: (session) => this.#delegates(session),
					start: (requester, batch, tasks, options) => this.#startTasks(requester, batch, tasks, options),
					tasks: this.#tasks,
				}),
			);
			this.registry.install(
				roomsExtension({
					rooms: this.#rooms,
					speaker: (conversation) => (this.#roomable(conversation) || this.#rooms.of(conversation) ? this.#roleOf(conversation).agent : null),
					agent: (id) => this.agents.get(id),
					invitable: (conversation) => this.#invitable(conversation),
					remove: (seat) => this.#leave(seat),
					person: () => this.#personNames(),
					history: async (seat) => {
						const said = projectEntries(await this.harness.session(seat.room).messages()).filter((message) => message.timestamp < seat.joinedAt);
						return roomHistory(said, this.agents.ofSession(seat.room).name, ROOM_HISTORY_CHARS);
					},
				}),
			);
			this.registry.install(
				reviewExtension({ majordomo: () => this.agents.majordomo(), decide: (conversation, decision, note) => this.#reviewDecision(conversation, decision, note) }),
			);
			this.registry.install(approvalsExtension(services, this.#offeredActions()));
			this.registry.install(webExtension);
			this.registry.install(
				artifactsExtension({
					artifacts: this.artifacts,
					assertOpen: () => this.#assertOpen(),
					readFile: (path) => this.files.bytes(path),
				}),
			);
			this.registry.install(filesExtension(this.#files));
			this.registry.install(
				dashboardExtension({
					agentOf: (session) => (this.visits.bySession(session) ? null : this.#roleOf(session).agent),
					change: (agent, changes) => this.#changeDashboard(agent, changes),
				}),
			);
			this.#installImageGeneration();
			this.#installBrowser(services);
			this.#installDesktop();
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

	/** Streams of the desktop whose socket went, which have been asked to close. */
	readonly #orphanedScreens = new Set<number>();
	/** pi agent-event watches, by connection id. In memory: rebuilt in `onStart`. */
	readonly #watches = new Map<string, AgentEventStream>();
	/** Each connection's latest watch request: one that finishes setting up after a newer one is dropped. */
	readonly #watchRequests = new Map<string, object>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// The computer pings to keep its connection open; the answer doesn't wake the space.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
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
				// The owner in the path tells the Worker whose space the sign-in returns to.
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
		if (!(await this.nativeApps.remove(id))) await this.removeMcpServer(id).catch(() => undefined);
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
			tools: [...skillTools(this.apps, this.catalog, this.skills, this.files), ...eventTools(
					this.apps,
					this.catalog,
					this.appEvents,
					(session) => this.#appsOf(this.#roleOf(session).agent),
					() => ownToolPermission(this.store, WATCH_APP_EVENT).chosen === "off",
				)],
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
			(session, server, tool) => agentToolPermission(this.store, this.#roleOf(session).agent.id, server, tool).permission,
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

	/**
	 * Reads the admin's apps and model providers from the gallery again, and
	 * whether the owner is the admin from the directory, at most once a minute
	 * unless `now`.
	 */
	async #refreshCustomApps(now = false): Promise<void> {
		if (!now && Date.now() - this.#customAppsReadAt < CUSTOM_APPS_TTL_MS) return;
		this.#customAppsReadAt = Date.now();
		try {
			const gallery = this.env.Gallery.getByName("gallery");
			// The directory failing to answer leaves what it said before.
			const [apps, providers, admin] = await Promise.all([gallery.customApps(), gallery.sharedProviders(), this.#ownerIsAdmin().catch(() => null)]);
			const custom = JSON.stringify(apps);
			if (custom !== this.store.meta(CUSTOM_APPS_KEY)) this.store.setMeta(CUSTOM_APPS_KEY, custom);
			if (admin !== null && (admin ? "1" : "0") !== this.store.meta(OWNER_ADMIN_KEY)) {
				this.store.setMeta(OWNER_ADMIN_KEY, admin ? "1" : "0");
				this.#reinstallApprovals();
			}
			const shared = JSON.stringify(providers);
			if (shared !== (this.store.meta(SHARED_PROVIDERS_KEY) ?? "[]")) {
				this.store.setMeta(SHARED_PROVIDERS_KEY, shared);
				await this.#providersChanged();
			}
		} catch (error) {
			console.warn("reading the admin's apps and providers failed", error);
		}
	}

	/** Whether this space's owner runs this Pim, as the directory says now. */
	async #ownerIsAdmin(): Promise<boolean> {
		const account = await this.env.Directory.getByName("directory").account(this.name);
		return account?.role === "admin" && account.status === "active";
	}

	/**
	 * The admin's majordomo adds a remote MCP server to this Pim's apps, as
	 * the admin does in Apps → Create new app (`POST /admin/apps`), and gets
	 * it back from the directory. A server the directory has already is that
	 * app, whoever added it.
	 */
	async #addCustomApp(input: { name: string; url: string; description?: string }): Promise<DirectoryApp> {
		if (!(await this.#ownerIsAdmin())) throw new Error("Only this Pim's admin adds apps to it.");
		const url = input.url.trim();
		await this.#refreshCustomApps(true);
		let app = this.appDirectory().find((candidate) => candidate.url === url);
		if (!app) {
			const added = await this.env.Gallery.getByName("gallery").addCustomApp({ name: input.name, url, description: input.description });
			console.log(JSON.stringify({ event: "pim.app_added", app: added.id, by: this.name }));
			await this.#refreshCustomApps(true);
			app = this.appDirectory().find((candidate) => candidate.ref === `${CUSTOM_APPS}/${added.id}`);
		}
		if (!app) throw new Error(`${input.name} was added to this Pim, but this space doesn't see it yet. Try again in a minute.`);
		return app;
	}

	/** Apps given through the API must be in the directory. */
	#checkApps<T extends { apps: readonly string[] }>(input: T): T {
		const directory = this.appDirectory();
		const missing = input.apps.find((ref) => !directory.some((app) => app.ref === ref));
		if (missing) throw new HttpError(400, `This Pim offers no app ${missing}`);
		return input;
	}

	/** One of the person's skills, or 404. */
	#skill(name: string) {
		const skill = SKILL_NAME.test(name) ? this.skills.get(name) : undefined;
		if (!skill) throw new HttpError(404, `No skill ${name}`);
		return skill;
	}

	/** The agents that use a skill. */
	#skillAgents(name: string) {
		return this.agents
			.list()
			.filter((agent) => agent.skills.includes(name))
			.map(({ id, name: agentName }) => ({ id, name: agentName }));
	}

	/** A skill as its latest version, with the versions kept and the agents that use it. */
	#describeSkill(name: string) {
		return { ...this.#skill(name), history: this.skills.history(name), agents: this.#skillAgents(name) };
	}

	/** Skills given through the API must be the person's. */
	#checkSkills<T extends { skills: readonly string[] }>(input: T): T {
		const missing = input.skills.find((name) => !this.skills.has(name));
		if (missing) throw new HttpError(400, `You have no skill ${missing}`);
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
	 * use them; apps, by the agents that list them; and reviews', by the
	 * majordomo's reviews.
	 */
	#perPim(name: string): boolean {
		return this.abilities.has(name) || name.startsWith(APP_PREFIX) || name === REVIEW_EXTENSION;
	}

	/** pi's run policy, shared by every session. */
	protected harnessSettings(): HarnessSettings {
		const registry = this.registry;
		const perPim = (name: string) => this.#perPim(name);
		return {
			// Every extension but visits', abilities', apps' and reviews': a visit's own conversation selects its
			// extension, the chats of agents that use an ability or list an app select it, and reviews select theirs.
			get extensions() {
				return registry
					.snapshot()
					.installed()
					.filter((extension) => !extension.name.startsWith(VISIT_PREFIX) && !perPim(extension.name));
			},
			// 1, 2, 4, 8, 16 s: about 30 s for a rate-limited model to recover.
			// A model that still fails after that, such as one whose plan ran out, holds the run until the person says to try again.
			retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000, suspend: (message, conversation) => this.#holdsRun(message, String(conversation)) },
			// Fewer storage writes while streaming; a crash loses at most this window.
			progress: { partialIntervalMs: 250, outputIntervalMs: 250 },
		};
	}

	/**
	 * Whether a run whose model failed for good is held for the person to try again. Only a chat is: a task or a review has
	 * no one watching it, and its requester or caller needs the failure to go on.
	 */
	#holdsRun(message: { errorMessage?: string }, conversation: string): boolean {
		if (message.errorMessage === NOT_DELIVERED || this.#tasks.of(conversation)) return false;
		// The chat list stops showing it as working once the hold is committed, just after this answers.
		setTimeout(() => this.broadcastMessage({ type: "sessions" }), 1000);
		return true;
	}

	/** The conversations whose runs are held after a model error: not working, but waiting for the person to try again. */
	async #heldSessions(): Promise<Set<string>> {
		const { tasks } = await (await this.harness.pi()).inspect(BACKGROUND_CONTEXT);
		return new Set(tasks.filter(({ record }) => this.#isHeld(record)).map(({ record }) => String(record.conversationId)));
	}

	/** Asks the model again in a conversation whose run is held after a model error; false when none is. */
	async #resumeHeld(conversation: string): Promise<boolean> {
		const { tasks } = await (await this.harness.pi()).inspect(BACKGROUND_CONTEXT);
		const held = tasks.find(({ record }) => String(record.conversationId) === conversation && this.#isHeld(record));
		if (!held) return false;
		await this.harness.resumeTask(conversation, held.record.id);
		return true;
	}

	#isHeld(record: { kind: string; state: { status: string; on?: readonly unknown[] } }): boolean {
		return record.kind === "pi.generation" && record.state.status === "waiting" && record.state.on?.length === 0;
	}

	/** The model catalog pi resolves sessions' models against: Workers AI, and the ChatGPT plan. People's providers join it in `modelCatalog`. */
	protected models(): MutableModels {
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
		if (!this.#modelCatalog) {
			this.#models = this.models();
			this.#syncProviders();
			this.#modelCatalog = this.images.resolving(this.usage.meter(this.#models));
		}
		return this.#modelCatalog;
	}

	/** The catalog before metering, which providers are added to and taken from as they change. */
	#models: MutableModels | undefined;

	/** The model providers the person can use, by catalog id: the admin's, then their own. Keys included. */
	customProviders(): { catalogId: string; shared: boolean; provider: CustomProvider }[] {
		const read = (key: string) => JSON.parse(this.store.meta(key) ?? "[]") as CustomProvider[];
		return [
			...read(SHARED_PROVIDERS_KEY).map((provider) => ({ catalogId: `${SHARED_PROVIDER}${provider.id}`, shared: true, provider })),
			...read(OWN_PROVIDERS_KEY).map((provider) => ({ catalogId: `${OWN_PROVIDER}${provider.id}`, shared: false, provider })),
		];
	}

	/** Puts the providers as they are now in the catalog, which pi keeps, and takes out those that are gone. */
	#syncProviders(): void {
		const models = this.#models;
		if (!models) return;
		const current = this.customProviders();
		const gone = models
			.getProviders()
			.map((provider) => provider.id)
			.filter((id) => (id.startsWith(OWN_PROVIDER) || id.startsWith(SHARED_PROVIDER)) && !current.some((entry) => entry.catalogId === id));
		for (const id of gone) models.deleteProvider(id);
		for (const { catalogId, provider } of current) models.setProvider(piProvider(catalogId, provider));
	}

	/** After providers change: sessions and side jobs on a model that's gone go back to the defaults. */
	async #providersChanged(): Promise<void> {
		// A catalog not built yet will have them when it is.
		if (this.#modelCatalog) this.#syncProviders();
		const catalog = this.modelCatalog();
		const missing = (key: string) => {
			const json = this.store.meta(key);
			if (json === undefined) return false;
			const { provider, id } = JSON.parse(json) as { provider: string; id: string };
			return (provider.startsWith(OWN_PROVIDER) || provider.startsWith(SHARED_PROVIDER)) && !catalog.getModel(provider, id);
		};
		if (missing(UTILITY_MODEL_KEY)) this.store.deleteMeta(UTILITY_MODEL_KEY);
		this.#dropModels(({ provider, id }) => (provider.startsWith(OWN_PROVIDER) || provider.startsWith(SHARED_PROVIDER)) && !catalog.getModel(provider, id));
		// Without Workers AI, the default is a provider's model, so it changes as providers come and go.
		if (missing(MODEL_KEY) || (!this.#hasWorkersAi() && this.store.meta(MODEL_KEY) === undefined)) await this.chooseModel(null);
	}

	/** The person adds a model provider of their own, or changes one; its models are read from the server again. */
	async #putOwnProvider(id: string | null, input: ProviderInput): Promise<CustomProvider> {
		const own = () => JSON.parse(this.store.meta(OWN_PROVIDERS_KEY) ?? "[]") as CustomProvider[];
		const providers = own();
		const existing = id === null ? null : (providers.find((provider) => provider.id === id) ?? null);
		if (id !== null && !existing) throw new HttpError(404, `No provider ${id}`);
		if (!existing && providers.length >= MAX_PROVIDERS) throw new HttpError(400, `You can add up to ${MAX_PROVIDERS} providers.`);
		const provider = await prepareProvider(input, existing, new Set(providers.map((candidate) => candidate.id)));
		// Reading the models took a while: another may have been added, or this one removed, since.
		const now = own();
		if (now.some((candidate) => candidate.id === provider.id) !== (existing !== null)) {
			throw new HttpError(409, existing ? "That provider was just removed." : "Another provider was just added: try again.");
		}
		const next = existing ? now.map((candidate) => (candidate.id === provider.id ? provider : candidate)) : [...now, provider];
		this.store.setMeta(OWN_PROVIDERS_KEY, JSON.stringify(next));
		await this.#providersChanged();
		return provider;
	}

	/** The person's settings: their own, else the deployment's. */
	settings(): Settings {
		return readSettings(this.store, this.#defaultSettings());
	}

	#defaultSettings(): Settings {
		const { timeZone, approvalPolicy } = this.deployment();
		return { timeZone, approvalPolicy };
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

	/**
	 * Platform models besides the default that sessions may use: `PIM_MODELS`.
	 * None allows any Workers AI or AI Gateway model, as a deployment that
	 * doesn't mind the cost; one with members lists the ones it pays for.
	 */
	#allowedModels(): readonly string[] | null {
		const { models } = this.deployment();
		return models.length === 0 ? null : models;
	}

	/** How this deployment sends email (`EMAIL` and `PIM_EMAIL_FROM`); null when it can't. */
	protected mailer(): Mailer | null {
		return mailerFrom(this.env);
	}

	/** The deployment's model (`PIM_MODEL`), used whenever no other is chosen. */
	protected defaultModel(): PiModel {
		if (!this.#hasWorkersAi()) {
			// The first model of the first provider: the admin's, then the person's own.
			for (const { catalogId, provider } of this.customProviders()) {
				if (provider.models[0]) return providerModel(catalogId, provider, provider.models[0]);
			}
		}
		return this.ai(this.deployment().model);
	}

	/** Whether this deployment has Workers AI: the `AI` binding. */
	#hasWorkersAi(): boolean {
		return (this.env as AiEnv).AI !== undefined;
	}

	/** The model of agents that have none of their own: the one chosen for the space through the API, or the default. */
	chosenModel(): PiModel {
		const json = this.store.meta(MODEL_KEY);
		if (json !== undefined) {
			const { provider, id } = JSON.parse(json) as { provider: string; id: string };
			const model = this.modelCatalog().getModel(provider, id);
			if (model) return model;
		}
		return this.defaultModel();
	}

	/** The model an agent's conversations run on: its own, else the space's. One that's gone, or on a plan that isn't connected, is not read: see `#dropModels`. */
	agentModel(agent: Agent): PiModel {
		if (agent.model) {
			const model = this.modelCatalog().getModel(agent.model.provider, agent.model.id);
			if (model) return model;
		}
		return this.chosenModel();
	}

	/**
	 * A model from `GET /model`'s choices, by provider and id: the deployment's,
	 * one it allows besides, or one on the connected ChatGPT plan.
	 */
	async #choice(provider: string, id: string): Promise<PiModel> {
		const fallback = this.defaultModel();
		if (provider === fallback.provider && id === fallback.id) return fallback;
		if (this.#hasWorkersAi() && provider === fallback.provider && this.#allowedModels()?.includes(id)) return this.ai(id);
		const model = this.modelCatalog().getModel(provider, id);
		if (!model) throw new HttpError(400, `No model ${provider}/${id}`);
		if (provider === CHATGPT_PROVIDER && !(await this.chatgpt.status()).connected) {
			throw new HttpError(409, "Sign in with ChatGPT first");
		}
		return model;
	}

	/** Makes `model` the space's, for agents that have none of their own; null goes back to the default. */
	async chooseModel(model: PiModel | null): Promise<PiModel> {
		if (model === null) this.store.deleteMeta(MODEL_KEY);
		else this.store.setMeta(MODEL_KEY, JSON.stringify({ provider: model.provider, id: model.id }));
		await this.#syncModels();
		return this.chosenModel();
	}

	/** Makes `model` an agent's; null follows the space's again. */
	async chooseAgentModel(agent: Agent, model: PiModel | null): Promise<Agent> {
		const changed = this.agents.setModel(agent.id, model);
		await this.#syncModels();
		return changed;
	}

	/** Puts every session on its agent's model. */
	async #syncModels(): Promise<void> {
		for (const session of await this.harness.sessions.list()) {
			await this.harness.session(session.id).setModel(this.agentModel(this.agents.ofSession(session.id)));
		}
	}

	/** Agents whose model `gone` says can't be used any more go back to following the space's. */
	#dropModels(gone: (model: AgentModel) => boolean): void {
		for (const agent of this.agents.list()) {
			if (agent.model && gone(agent.model)) this.agents.setModel(agent.id, null);
		}
	}

	/**
	 * The model that compresses memories: `PIM_MEMORY_MODEL`, else `PIM_MODEL`.
	 * Never the chosen model, so background work does not spend a ChatGPT plan.
	 */
	protected memoryModel(): ModelRef | undefined {
		if (!this.#hasWorkersAi()) return undefined;
		const { memoryModel, model: fallback } = this.deployment();
		const model = this.ai(memoryModel ?? fallback);
		return { provider: model.provider, modelId: model.id };
	}

	/**
	 * The deployment's utility model (`PIM_UTILITY_MODEL` on Workers AI), for
	 * side jobs such as naming chats (see ./utility.ts). `off` turns them off.
	 */
	protected defaultUtilityModel(): Model<Api> | undefined {
		const { utilityModel } = this.deployment();
		return utilityModel && this.#hasWorkersAi() ? this.ai(utilityModel) : undefined;
	}

	/**
	 * Whether a provider's models may be the utility model: the ChatGPT plan's,
	 * and those of a provider that answers in a JSON schema (see `answersInSchema`),
	 * which structured jobs need. The deployment's default is the admin's choice.
	 */
	#utilityProvider(provider: string): boolean {
		return provider === CHATGPT_PROVIDER || this.customProviders().some((entry) => entry.catalogId === provider && answersInSchema(entry.provider));
	}

	/**
	 * The utility model: the one chosen through the API, or the default.
	 * A ChatGPT model counts only while the plan is connected, and a chosen
	 * model whose provider no longer answers in a schema is skipped.
	 */
	async utilityModel(): Promise<Model<Api> | undefined> {
		const json = this.store.meta(UTILITY_MODEL_KEY);
		if (json !== undefined) {
			const { provider, id } = JSON.parse(json) as { provider: string; id: string };
			const model = this.modelCatalog().getModel(provider, id);
			if (model && this.#utilityProvider(provider) && (provider !== CHATGPT_PROVIDER || (await this.chatgpt.status()).connected)) return model;
		}
		return this.defaultUtilityModel();
	}

	/**
	 * Runs a side job on the utility model and returns its answer, cleaned as
	 * the task says. It counts against the daily model limits, but not as a run.
	 */
	async utility(task: UtilityTask, input: string): Promise<string> {
		const answer = await this.#askUtility(task.instructions, task.maxTokens, input);
		const text = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		const result = task.clean ? task.clean(text) : text.trim();
		if (answer.stopReason === "error" || result === "") {
			throw new HttpError(502, `The utility model couldn't answer: ${answer.errorMessage ?? "it said nothing"}`);
		}
		return result;
	}

	/**
	 * Runs a side job whose answer is structured: the model answers in JSON
	 * that follows the task's schema, which its provider enforces. Only models
	 * that can are the utility model (see `utilityModel`).
	 */
	async utilityStructured<T extends readonly unknown[]>(task: StructuredUtilityTask<T>, input: string): Promise<T> {
		const answer = await this.#askUtility(task.instructions, task.maxTokens, input, (payload, model) => withJsonSchema(model.api, payload, task.schema));
		const text = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {}
		const result = task.result(parsed);
		if (answer.stopReason === "error" || result.length === 0) {
			throw new HttpError(502, `The utility model couldn't answer: ${answer.errorMessage ?? "it didn't answer in the schema"}`);
		}
		return result;
	}

	async #askUtility(instructions: string, maxTokens: number, input: string, onPayload?: (payload: unknown, model: Model<Api>) => unknown) {
		this.#assertOpen();
		if (this.status() !== "active") throw new HttpError(403, "This space is suspended");
		const model = await this.utilityModel();
		if (!model) throw new HttpError(503, "This space has no utility model");
		return this.modelCatalog().completeSimple(
			model,
			{ systemPrompt: instructions, messages: [{ role: "user", content: input, timestamp: Date.now() }] },
			// A reasoning model thinks as little as it can; a cap on its tokens could cut off the answer.
			{ ...(model.reasoning ? { reasoning: "minimal" } : { maxTokens }), ...(onPayload && { onPayload }), signal: AbortSignal.timeout(60_000) },
		);
	}

	/** A session's conversation as the utility model reads it; 409 when there is nothing in it yet. */
	async #conversationText(session: string, limit: number): Promise<string> {
		const text = conversationText(projectEntries(await this.harness.session(session).messages()), limit);
		if (text === "") throw new HttpError(409, "This chat has no conversation yet");
		return text;
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
				// A task's conversation is not one of the person's chats.
				if (alert === undefined || this.#tasks.of(session) || this.store.pushSubscriptions().length === 0) return;
				// Idempotent, so a replayed reply is checked once.
				const body = session === conversation ? alert : `${this.#roleOf(conversation).agent.name}: ${alert}`;
				await this.schedule(REPLY_PUSH_DELAY_SECONDS, REPLY_PUSH_CALLBACK, { session, at, body: body.slice(0, 500) }, { idempotent: true });
			},
			posted: (session, message, at, images) => this.#posted(session, message, at, images),
			maySkip: (session, input) => {
				const seat = this.#rooms.of(session);
				if (!seat) return false;
				if (input.startsWith(ROOM_NOTICE)) return true;
				const named = mentioned(input, this.#seated(this.#rooms.seats(seat.room)));
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
				const origin = this.deployment().publicUrl;
				const link = origin ? `\n\n—\nFrom your Pim: ${new URL(`/chat/${this.store.publicId(mail.session)}`, origin)}` : "";
				return this.email.send({ ...mail, text: `${mail.text}${link}` });
			},
			approvalFiled: (approval, isNew) => this.#approvalFiled(approval, isNew),
			permission: (approval) => this.#approvalPermission(approval),
			taskAgent: (session) => {
				const task = this.#tasks.of(session);
				if (task && task.kind !== "review") return { name: this.#roleOf(session).agent.name, session: task.root };
				// An agent in a room asks in the room's chat.
				const seat = this.#rooms.of(session);
				return seat && seat.conversation !== seat.room ? { name: this.#roleOf(session).agent.name, session: seat.room } : null;
			},
			widgetsFor: (session) => this.#chatWidgets(session),
			showWidget: async (session, ref) => {
				const kept = this.store.keptWidget<ToolWidget>(session, ref);
				if (!kept) return this.#loadWidget(this.agents.ofSession(session), ref);
				const { title, ...content } = kept;
				return { id: ref, title, empty: "", ...content };
			},
			keepWidget: (session, widget) => this.store.keepWidget(session, widget),
			keptWidgets: (session) => (this.visits.bySession(session) || this.#tasks.of(session) ? [] : this.store.keptWidgets(session)),
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
		this.mcp.configureOAuthCallback({
			customHandler: (result) => signInResultPage(result.authSuccess, this.deployment().publicUrl ?? undefined, String(result.authError ?? "")),
		});
		// Sockets survive hibernation and restarts; their watches do not. They
		// are restored without holding up startup, which answers no request
		// until it ends: each loads its chat's events, which takes long for a
		// long chat. A watch the socket asks for meanwhile replaces its restored one.
		for (const connection of this.getConnections<SocketState>()) {
			if (connection.state?.session) {
				void this.#watch(connection, connection.state.session).catch((error) => console.warn("restoring a watch failed", error));
			}
		}
		void this.#resumeTasks().catch((error) => console.warn("resuming tasks failed", error));
		// A Sprite Pim started before it kept computers with a host is out of reach: the space has no computer until it gets another.
		const sprite = this.computer.forgetSprite();
		if (sprite) console.warn(JSON.stringify({ event: "pim.sprite_forgotten", owner: this.name, sprite }));
	}

	/**
	 * Every message into a session goes through here, so the session list
	 * knows its activity; the user's first message also names it. A new run
	 * (from the user, a schedule or an app) counts against the daily limit;
	 * an approval's outcome, or tasks' answers, continue work already
	 * counted, so they do not.
	 */
	async submitTo(
		session: string,
		content: UserInput,
		options: { operationId?: string; whenBusy?: "followUp" | "steer" },
		from: "user" | "pim" | "approval" | "task",
	): Promise<PiReceipt> {
		this.#assertOpen();
		if (this.status() !== "active") throw new HttpError(403, "This space is suspended");
		// Checked and counted before the first await, so concurrent submissions can't all pass the same check.
		let run: string | undefined;
		if (from !== "approval" && from !== "task") {
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
			receipt = from === "user" ? await this.#personSays(session, stored.content, options) : await this.#submit(session, stored.content, options, from);
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

	/** Gives pi input for a conversation, traced as part of its run (see ./telemetry.ts). */
	async #submit(session: string, content: UserInput, options: { operationId?: string; whenBusy?: "followUp" | "steer" }, from: string): Promise<PiReceipt> {
		const withdraw = this.telemetry.submitting(session, content, from);
		let receipt: PiReceipt;
		try {
			receipt = await this.harness.submit(content, { session, ...options });
		} catch (error) {
			withdraw();
			throw error;
		}
		if (!receipt.accepted) withdraw();
		else if (this.telemetry.enabled) void this.keepAliveWhile(async () => this.telemetry.settled(session, await this.harness.wait(receipt.operationId, { session })));
		return receipt;
	}

	/** Where traces go: the OTLP endpoint the deployment sets, or nowhere. */
	protected spanExporter(): SpanExporter | null {
		return exporterFrom(this.env as TelemetryEnv);
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
					// A client that can't draw widgets or cards gets what they showed as text.
					const widgets = shownWidgets(outcome.text);
					replies.push([plainReply(part.arguments.message), ...widgets.map((widget) => widgetMarkdown(widget))].join("\n\n"));
				}
			}
		}
		return { ...result, text: replies.length > 0 ? replies.join("\n\n") : undefined, replies };
	}

	/** What this space holds: its database, and in R2 the images sent to it, its stored files, and its artifacts' and skills' files. */
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

	// Background work

	/**
	 * Fired by `schedule_task` schedules: hands the instruction to the session
	 * that made it, or to a new chat with its agent or the agent the majordomo
	 * scheduled it for, and tells the person it started with a notification
	 * that links to that chat. A firing a limit or a suspension refuses is
	 * skipped, not retried; the person hears about the limit once a day.
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
		// Work scheduled for an agent deleted since goes on with the agent of the chat that scheduled it.
		const agent = (payload.agent && this.agents.get(payload.agent)) || this.agents.ofSession(payload.session);
		const id = await this.#startChat(agent, clipTitle(payload.label ?? payload.instruction));
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
	async #startChat(agent: Agent, title: string | undefined): Promise<string> {
		const { sessions } = this.limits();
		if (sessions !== null) {
			const hidden = this.#hiddenSessions();
			const open = (await this.harness.sessions.list()).filter((session) => !hidden.has(session.id)).length;
			if (open >= sessions) throw new HttpError(429, `You can have up to ${sessions} chats. Delete one first.`);
		}
		const { id } = await this.harness.sessions.create();
		await this.harness.session(id).setModel(this.agentModel(agent));
		this.agents.setSession(id, agent.id);
		this.store.touchSession(id, title);
		return id;
	}

	/** This space as an MCP server (./mcp-server.ts): its clients talk with the majordomo, in a new chat or one they started before. */
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
				// Tasks the majordomo hands out answer in updates, later: the client hears what it says of them too, while it waits.
				const updates = this.#listenForUpdates(session);
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
		const shown = this.#publicNotification(notification);
		if (options.sockets !== false) this.broadcastMessage({ type: "notification", notification: shown });
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
	 */
	async pushReply(payload: { session: string; at: number; body: string }): Promise<void> {
		const info = this.store.sessionInfo(payload.session);
		if (this.#closed() || !info?.unread || info.responseAt !== payload.at || this.#hiddenSessions().has(payload.session)) return;
		await this.#pushNotification({
			// The same reply pushed twice shows once.
			id: `reply-${this.store.publicId(payload.session)}-${payload.at}`,
			session: payload.session,
			title: info.title ?? this.#agentRef(payload.session)?.name ?? "Pim",
			body: payload.body,
			reply: true,
		});
	}

	/**
	 * Web Push to every browser that turned notifications on, even with the
	 * app closed. A `reply` shows unless its own chat is on screen; anything
	 * else shows only while the app is not, since the app shows it itself.
	 */
	async #pushNotification(notification: Pick<Notification, "id" | "session" | "title" | "body"> & { reply?: boolean }): Promise<void> {
		const subscriptions = this.store.pushSubscriptions();
		if (subscriptions.length === 0) return;
		const keys = await this.#vapidKeys();
		const subject = this.deployment().publicUrl ?? "https://pim.invalid";
		const { id, session, title, body, reply, agent } = this.#publicNotification(notification);
		// A device alert shows only the first sentence, and a push message
		// holds about 4 KB; the full text is in the app.
		const first = new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(body.trim())[Symbol.iterator]().next().value;
		const message = { id, session, agent, title: title.slice(0, 120), body: (first?.segment.trim() ?? "").slice(0, 500), ...(reply ? { reply } : {}) };
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

	/**
	 * What a gated tool call returns once its approval is filed. A decided
	 * approval (the call its decision woke) returns its outcome; a tool the
	 * user lets run without asking runs now, and the turn goes on with its
	 * result. Otherwise the user is asked, once: the request goes to their
	 * open apps and devices, and an `auto` approval's timeout is set. Under the
	 * `majordomo` policy, another agent's request goes to the majordomo
	 * instead, which asks the user only if it must (see `#review`). Then it
	 * returns null, and the call waits, suspended, until the decision wakes it
	 * (see `decideApproval`).
	 */
	async #approvalFiled(approval: Approval, isNew: boolean): Promise<string | null> {
		if (approval.status !== "pending") return this.#outcome(approval);
		if (this.#approvalPermission(approval) === "on") {
			return this.#outcome(await this.decideApproval(approval.id, "approve", undefined, "always", { inTurn: true }));
		}
		if (isNew && this.#reviewable(approval)) {
			this.store.setApprovalReview(approval.id, { status: "reviewing", note: null });
			const reviewing = this.store.approval(approval.id)!;
			// Open apps show the request, and that the majordomo is on it; the person can still decide first.
			this.broadcastMessage({ type: "approval", approval: this.#publicApproval(reviewing) });
			await this.schedule(new Date(Date.now() + REVIEW_MS), REVIEW_EXPIRY_CALLBACK, { id: approval.id });
			void this.keepAliveWhile(() => this.#review(reviewing));
		}
		// A task's agent waits now, for the majordomo or the person.
		await this.#taskWaits(approval.session);
		if (this.store.approval(approval.id)?.review) return null;
		if (isNew) {
			this.broadcastMessage({ type: "approval", approval: this.#publicApproval(approval) });
			const notification = this.store.addNotification({
				id: crypto.randomUUID(),
				// The request of an agent at work on a task shows in the chat the work began in.
				session: approval.member?.session ?? approval.session,
				title: "Pim needs your approval",
				body: approval.summary,
			});
			// Open apps show the request itself, from the approval just broadcast; this reaches the others.
			await this.deliverNotification(notification, { sockets: false });
		}
		// Again on a replay: an approval filed before timeouts were scheduled gets one too. Deciding twice is refused.
		if (approval.expiresAt !== null) await this.schedule(new Date(approval.expiresAt), APPROVAL_EXPIRY_CALLBACK, { id: approval.id });
		return null;
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
	 * action runs here. The decision wakes the tool call that filed it, which
	 * waits suspended, and the call returns the outcome; decided `inTurn`, the
	 * call returns it at once. A request whose call no longer waits, because
	 * its chat was stopped, deleted or reset, is denied without running.
	 */
	async decideApproval(
		id: string,
		decision: "approve" | "deny",
		note?: string,
		auto?: AutoApproval,
		options: { inTurn?: boolean } = {},
	): Promise<Approval> {
		// An approval's timer can outlive the space's erasure; its action must not run.
		this.#assertOpen();
		const approval = this.store.approval(id);
		if (!approval) throw new HttpError(404, `No approval ${id}`);
		if (decision === "approve" && this.#requiresExplicitApproval(approval)) {
			if (auto) throw new HttpError(400, "This action requires an explicit decision for each request");
			if (this.#approvalPermission(approval) === "off") throw new HttpError(403, "This capability is turned off");
		}
		const call = approval.requestedBy || options.inTurn ? undefined : await this.#waitingCall(approval);
		const stopped = call === null;
		if (stopped) {
			decision = "deny";
			note = "Its chat stopped before the decision, so nothing ran.";
		}
		if (!this.store.decideApproval(id, decision === "approve" ? "approved" : "denied", note ?? null, auto ?? "user")) {
			throw new HttpError(409, `Approval ${id} is already ${approval.status}`);
		}
		if (decision === "approve") {
			const action = this.actions.find((candidate) => candidate.name === approval.action);
			let result: string;
			try {
				result = action
					? await this.keepAliveWhile(() => action.run(approval.args as never, { session: approval.session }))
					: `The action ${approval.action} is no longer available.`;
			} catch (error) {
				result = `The action failed: ${errorMessage(error)}`;
			}
			this.store.recordApprovalResult(id, result);
		}
		const decided = this.store.approval(id)!;
		this.broadcastMessage({ type: "approval", approval: this.#publicApproval(decided) });
		if (decided.requestedBy) {
			// A guest asked: the outcome continues their visit, in their own space, on their own usage.
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
		if (call) {
			// What it approved may have changed the agent, such as its apps: the turn goes on with the tools it has now.
			await this.#selectAbilities(approval.session);
			const task = this.#tasks.of(approval.session);
			if (task && this.#tasks.setState(task.id, "working")) this.#tasksChanged(task.root);
			await this.harness.resumeTask(approval.session, call);
		}
		return decided;
	}

	/** The task of the tool call waiting for `approval`'s decision, or null when none is. */
	async #waitingCall(approval: Approval): Promise<TaskId | null> {
		const { tasks } = await (await this.harness.pi()).inspect(BACKGROUND_CONTEXT);
		const call = tasks.find(
			({ record }) =>
				record.kind === "pi.tool" &&
				String(record.conversationId) === approval.session &&
				(record.input as { callId?: unknown }).callId === approval.callId,
		);
		return call?.record.id ?? null;
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
		if (this.#requiresExplicitApproval(approval)) {
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
		const offered = new Set(this.#offeredActions().map((action) => action.name));
		return this.actions.filter((action) => action.name !== "mcp_call" && (offered.has(action.name) || !this.#ownActions.includes(action)));
	}

	/** `watch_app_event`'s permission: on unless switched off, whatever else was chosen before it stopped asking. */
	#watchPermission(): ResolvedPermission {
		const { chosen } = ownToolPermission(this.store, WATCH_APP_EVENT);
		return { permission: chosen === "off" ? "off" : "on", default: "on", chosen: chosen === "ask" ? null : chosen, changed: false };
	}

	/** The tool an approval was filed for, as permissions name it: by its app and the app's own name for it. */
	#approvalTool(approval: Approval): { app: string; tool: string } {
		if (approval.action === "mcp_call") {
			const { server, tool } = approval.args as { server: string; tool: string };
			return { app: server, tool };
		}
		return { app: "", tool: approval.action };
	}

	/** Risky tools always need the person's decision, even when assigned to an agent. */
	#requiresExplicitApproval(approval: Approval): boolean {
		if (approval.action !== "mcp_call") return this.actions.some((action) => action.name === approval.action && action.explicitApproval);
		if (approval.tool === null) return true;
		const { app, tool } = this.#approvalTool(approval);
		return this.apps.tools().some((info) => info.serverId === app && info.name === tool && info.annotations?.destructiveHint === true);
	}

	/** The permission of the tool that filed an approval, for whoever asked; `ask` for an app tool that is gone. */
	#approvalPermission(approval: Approval): ToolPermission {
		const { app, tool } = this.#approvalTool(approval);
		if (app === "") {
			const resolved = ownToolPermission(this.store, tool);
			// An approval filed before watching needed none stays pending unless the person switched the tool off.
			if (tool === WATCH_APP_EVENT) return resolved.chosen === "off" ? "off" : "ask";
			if (this.#requiresExplicitApproval(approval)) return resolved.permission === "off" ? "off" : "ask";
			if (!approval.requestedBy && resolved.chosen === null) {
				const assigned = this.extensions.abilitiesOf(this.#roleOf(approval.session).agent.blueprint);
				if (assigned.some((id) => this.abilities.get(id)?.actions?.some((action) => action.name === tool))) return "on";
			}
			return resolved.permission;
		}
		const server = this.apps.servers().find((candidate) => candidate.id === app);
		const info = this.apps.tools().find((candidate) => candidate.serverId === app && candidate.name === tool);
		if (!server || !info) return "ask";
		const resolved = appToolPermission(this.store, server, info, approval.requestedBy?.circle ?? OWNER);
		if (this.#requiresExplicitApproval(approval)) return resolved.permission === "off" ? "off" : "ask";
		return resolved.permission;
	}

	/** A circle, or 404. */
	#circle(id: string): Circle {
		const circle = this.circles.circle(id);
		if (!circle) throw new HttpError(404, `No circle ${id}`);
		return circle;
	}

	/**
	 * Every tool a permission can be set for, for the owner (`OWNER`) or a
	 * circle, with the permission that applies: for the owner, Pim's own tools
	 * that act on the world, since each agent has its own switches for its
	 * apps' tools; for a circle, every app's tools. What a circle remembers is
	 * the memory scopes ticked for it.
	 */
	toolPermissions(audience: string = OWNER): ToolPermissionInfo[] {
		if (audience === OWNER) {
			return this.#ownGatedActions().map((action) => ({
				app: null,
				appName: null,
				tool: action.name,
				name: action.name,
				description: action.description,
				readOnly: false,
				destructive: false,
				choices: action.name === WATCH_APP_EVENT ? ["off", "on"] : action.explicitApproval ? ["off", "ask"] : TOOL_PERMISSIONS,
				...(action.name === WATCH_APP_EVENT ? this.#watchPermission() : ownToolPermission(this.store, action.name)),
			}));
		}
		const servers = new Map(this.apps.servers().map((server) => [server.id, server]));
		const apps = this.apps.tools().flatMap((tool) => {
			const server = servers.get(tool.serverId);
			if (!server) return [];
			const choices = tool.annotations?.destructiveHint === true ? (["off", "ask"] as const) : TOOL_PERMISSIONS;
			return [{ ...this.#appToolInfo(server, tool), choices, ...appToolPermission(this.store, server, tool, audience) }];
		});
		return apps;
	}

	/** What a permission row says about an app's tool, besides the permission. */
	#appToolInfo(server: McpServerInfo, tool: McpToolInfo) {
		return {
			app: server.id,
			appName: server.name,
			tool: tool.name,
			name: toolName(server.id, tool.name),
			description: tool.description ?? tool.annotations?.title ?? null,
			readOnly: tool.annotations?.readOnlyHint === true,
			destructive: tool.annotations?.destructiveHint === true,
		};
	}

	/** The tools of the connected apps an agent works with, each with its switch for that agent. */
	agentToolPermissions(agent: Agent): ToolPermissionInfo[] {
		const servers = this.apps.servers();
		const tools = this.apps.tools();
		return this.#appsOf(agent).flatMap((app) => {
			const server = serverFor(servers, app);
			if (!server) return [];
			return tools
				.filter((tool) => tool.serverId === server.id)
				.map((tool) => ({ ...this.#appToolInfo(server, tool), choices: ["off", "on"] as const, ...agentToolPermission(this.store, agent.id, server, tool) }));
		});
	}

	/**
	 * An agent's switch for skills: on, its chats write and install skills
	 * (with approval, as `write_skill`'s permission has it), and the majordomo
	 * may for it; off, no agent changes its skills. On by default.
	 */
	agentSkillsPermission(agent: Agent): ToolPermissionInfo {
		return {
			app: null,
			appName: null,
			tool: WRITE_SKILL,
			name: WRITE_SKILL,
			description: "Write and install skills for this agent, asking first as write_skill's permission says",
			readOnly: false,
			destructive: false,
			choices: ["off", "on"],
			...skillsSwitch(this.store, agent.id),
		};
	}

	/**
	 * Switches an app's tool on or off for one agent, or back to its default
	 * (null); or, as Pim's own `write_skill` (`app` empty), its switch for
	 * skills. Switched on, an app's tool is held to the tool's definition now.
	 * The agent's conversations see it from their next request.
	 */
	setAgentToolPermission(agent: Agent, app: string, tool: string, permission: ToolPermission | null): ToolPermissionInfo {
		if (permission === "ask") throw new HttpError(400, "An agent's app tools are either on or off");
		if (app === "") {
			if (tool !== WRITE_SKILL) throw new HttpError(404, `${agent.name} has no switch for ${tool}`);
			if (permission === null) this.store.clearToolPermission(agentAudience(agent.id), "", WRITE_SKILL);
			else this.store.setToolPermission(agentAudience(agent.id), "", WRITE_SKILL, permission, null);
			return this.agentSkillsPermission(agent);
		}
		const found = this.agentToolPermissions(agent).find((info) => info.app === app && info.tool === tool);
		if (!found) throw new HttpError(404, `${agent.name} has no tool ${tool} in the app ${app}`);
		const info = this.apps.tools().find((candidate) => candidate.serverId === app && candidate.name === tool)!;
		if (permission === null) this.store.clearToolPermission(agentAudience(agent.id), app, tool);
		else this.store.setToolPermission(agentAudience(agent.id), app, tool, permission, toolDefinition(info));
		return this.agentToolPermissions(agent).find((candidate) => candidate.app === app && candidate.tool === tool)!;
	}

	/**
	 * Sets the permission of a tool for the owner (`OWNER`) or a circle: one of
	 * Pim's own (`app` empty), or, for a circle, an app's; null goes back to its
	 * default. An app tool's choice is tied to its definition now. The model sees
	 * the change from its next request; a guest, from their next call.
	 */
	setToolPermission(audience: string, app: string, tool: string, permission: ToolPermission | null): ToolPermissionInfo {
		if (audience !== OWNER) this.#circle(audience);
		let definition: string | null = null;
		if (app === "") {
			const known = audience === OWNER && this.#ownGatedActions().some((action) => action.name === tool);
			if (!known) throw new HttpError(404, `No tool ${tool}`);
			if (tool === WATCH_APP_EVENT && permission === "ask") throw new HttpError(400, "This tool can only be off or on: watching an app's events needs no approval");
			if (permission === "on" && this.#ownGatedActions().find((action) => action.name === tool)?.explicitApproval) {
				throw new HttpError(400, "This tool can only be off or ask: every change requires explicit approval");
			}
		} else {
			if (audience === OWNER) throw new HttpError(400, "An app's tools are switched on or off for each agent");
			const info = this.apps.tools().find((candidate) => candidate.serverId === app && candidate.name === tool);
			if (!info) throw new HttpError(404, `No tool ${tool} in the app ${app}`);
			if (permission === "on" && info.annotations?.destructiveHint === true) {
				throw new HttpError(400, "This tool can only be off or ask: every call requires explicit approval");
			}
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

	// Circles: people the owner lets message this space, from their own spaces.

	/** This space's owner, as guests know them; null before registration provisioned it. */
	#me(): Guest | null {
		const profile = this.profile();
		return profile === null ? null : { ownerId: this.name, username: profile.username };
	}

	/** Another person's space, to call. */
	#pimOf(ownerId: string) {
		return getAgentByName(this.env.Pim, ownerId);
	}

	/**
	 * Puts someone in a circle, moving them from any other, and tells their
	 * space it may visit this one. The Worker calls it, having resolved
	 * their username.
	 */
	async addCircleMember(circleId: string, guest: Guest): Promise<Member> {
		this.#assertOpen();
		this.#circle(circleId);
		const me = this.#me();
		if (me === null) throw new HttpError(400, "This space has no owner to share it yet");
		if (guest.ownerId === this.name) throw new HttpError(400, "You can't add yourself to a circle");
		const known = this.circles.member(guest.ownerId);
		if (!known && this.circles.members().length >= MAX_MEMBERS) {
			throw new HttpError(429, `Your circles can hold up to ${MAX_MEMBERS} people.`);
		}
		// Told first: someone in a circle whose space doesn't know of it couldn't use it.
		if (!known) await (await this.#pimOf(guest.ownerId)).shareReceived(me);
		return this.circles.addMember(circleId, guest);
	}

	/** Takes someone out of the circles; their space is told, and their next call is refused either way. */
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

	/** Whether a guest may use this space now, and through which circle; or why not. */
	#guestAccess(guest: Guest): { ok: true; circle: Circle; member: Member } | { ok: false; reason: string } {
		const host = this.profile()?.username ?? "This person";
		if (this.#closed()) return { ok: false, reason: `${host}'s account was deleted.` };
		if (this.status() !== "active") return { ok: false, reason: `${host}'s account is suspended.` };
		const member = this.circles.member(guest.ownerId);
		if (!member) return { ok: false, reason: `${host} doesn't share their space with you.` };
		const circle = this.circles.circle(member.circle);
		if (!circle) return { ok: false, reason: `${host} doesn't share their space with you.` };
		if (!circle.enabled) return { ok: false, reason: `${host} has paused sharing their space with their "${circle.name}" circle.` };
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
	 * What a guest's space may know of this one and use: called by the guest's
	 * own space before each of their turns. Nothing but what the guest's circle
	 * was given.
	 */
	async guestBrief(guest: Guest): Promise<BriefResult> {
		const access = this.#guestAccess(guest);
		if (!access.ok) return access;
		const me = this.#me()!;
		const scopes = this.#circleMemory(access.circle);
		const lines = this.memory.view(scopes);
		return {
			ok: true,
			brief: {
				host: me,
				circle: access.circle.name,
				timeZone: this.settings().timeZone,
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

	/** An artifact shared with a guest's circle, or why they can't see it. */
	#sharedArtifact(guest: Guest, id: string): { ok: true; artifact: ArtifactSummary } | { ok: false; status: number; reason: string } {
		const access = this.#guestAccess(guest);
		if (!access.ok) return { ok: false, status: 403, reason: access.reason };
		const artifact = this.artifacts.get(id);
		if (!artifact || !this.artifacts.circlesOf(id).includes(access.circle.id)) return { ok: false, status: 404, reason: `No artifact ${id}` };
		return { ok: true, artifact };
	}

	/**
	 * The artifacts shared with a guest's circle, as their own space asks for
	 * them. Like a tool call, it's checked here every time: who they are,
	 * that their circle is on, and that the artifact is shared with it.
	 * Only the latest version is shared, and nothing of the chat it was made in.
	 */
	async guestArtifacts(guest: Guest): Promise<{ ok: true; artifacts: Omit<ArtifactSummary, "session">[] } | { ok: false; reason: string }> {
		const access = this.#guestAccess(guest);
		if (!access.ok) return access;
		return { ok: true, artifacts: this.artifacts.sharedWith(access.circle.id).map(({ session: _session, ...artifact }) => artifact) };
	}

	/** An artifact shared with a guest, as its latest version. */
	async guestArtifact(
		guest: Guest,
		id: string,
	): Promise<{ ok: true; artifact: Omit<ArtifactSummary, "session">; files: ArtifactFile[] } | { ok: false; status: number; reason: string }> {
		const found = this.#sharedArtifact(guest, id);
		if (!found.ok) return found;
		const { session: _session, ...artifact } = found.artifact;
		// The guest's space reads the files from R2 itself, so they must be there.
		const stored = await this.artifacts.stored(id, artifact.version);
		return { ok: true, artifact, files: [...stored.files] };
	}

	/** A guest's call on what an artifact shared with them keeps for everyone using it (`window.pim.shared`). */
	async guestArtifactShared(
		guest: Guest,
		id: string,
		call: { op: string; args: Record<string, unknown> },
	): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string }> {
		const found = this.#sharedArtifact(guest, id);
		if (!found.ok) return found;
		try {
			return { ok: true, value: this.#artifactData(id, "shared", call.op, call.args) };
		} catch (error) {
			if (error instanceof HttpError) return { ok: false, status: error.status, reason: error.message };
			throw error;
		}
	}

	/**
	 * An artifact someone shared with this person, as their space answers for
	 * it now: its latest version, which `version` must still be.
	 */
	async #othersArtifact(username: string, id: string, version?: string) {
		const share = this.visits.byUsername(username);
		const me = this.#me();
		if (!share || share.revoked || me === null) throw new HttpError(404, `${username} doesn't share artifacts with you`);
		const host = await this.#pimOf(share.ownerId);
		const found = await host.guestArtifact(me, id);
		if (!found.ok) throw new HttpError(found.status, found.reason);
		if (version !== undefined && Number(version) !== found.artifact.version) {
			throw new HttpError(404, `Only the latest version, ${found.artifact.version}, is shared`);
		}
		const files = found.files as ArtifactFile[];
		const load = () => readFiles(this.env.ARTIFACTS, share.ownerId, files);
		return { share, me, host, artifact: found.artifact, files, load, key: `${share.ownerId}/${found.artifact.id}` };
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
		const access = this.#guestAccess(guest);
		if (!access.ok) return { text: access.reason, isError: true };
		const { circle } = access;
		const host = this.#me()!.username;
		const log = (outcome: "ran" | "asked" | "refused", summary: string) =>
			this.circles.logActivity({ username: guest.username, circle: circle.id, tool: call.tool, outcome, summary });
		if (!this.circles.countCall(guest.ownerId)) {
			return { text: `${guest.username} has used today's ${GUEST_CALLS_PER_DAY} calls to ${host}'s space. It resets at midnight UTC.`, isError: true };
		}

		if (call.tool === "recall") {
			const scopes = this.#circleMemory(circle).map((scope) => scope.key);
			if (scopes.length === 0) {
				log("refused", "recall");
				return { text: `${host} doesn't let you read their space's memory.`, isError: true };
			}
			const pattern = typeof call.args.pattern === "string" ? call.args.pattern : "";
			log("ran", `recall ${JSON.stringify(pattern)}`);
			return this.memory.search(pattern, scopes);
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
			this.broadcastMessage({ type: "approval", approval: this.#publicApproval(approval) });
			const notification = this.store.addNotification({
				id: crypto.randomUUID(),
				session: null,
				title: `${guest.username} asked your agent`,
				body: `${guest.username} (${circle.name}) wants: ${summary}`,
			});
			// Open apps show the request itself, from the approval just broadcast; this reaches the others.
			await this.deliverNotification(notification, { sockets: false });
		}
		return {
			text: `${host} asks before this runs. The request is with ${host} now (approval ${id}); their answer will arrive in this conversation as a message starting with "[${host}'s answer". Tell ${guest.username} it was asked, and don't call it again.`,
		};
	}

	/** A guest approval's outcome, as the guest's space reads it. */
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
		if (this.#requiresExplicitApproval(approval)) return false;
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
			let review = this.#tasks.at(call, 0);
			if (!review) {
				const majordomo = this.agents.majordomo();
				const { id } = await this.harness.sessions.create();
				await this.harness.session(id).setModel(this.agentModel(majordomo));
				const snapshot = this.registry.snapshot();
				const extensions = [REVIEW_EXTENSION, this.memory.extension.name, TELEMETRY_EXTENSION].flatMap((name) => snapshot.extension(name) ?? []);
				const tools = snapshot
					.tools()
					.filter(({ extension, tool }) => extensions.includes(extension) && [DECIDE_APPROVAL, "recall", "zoom"].includes(tool.name))
					.map(({ tool }) => tool);
				await (await this.harness.conversation(id)).configure({ extensions, tools }, BACKGROUND_CONTEXT);
				const chat = approval.member?.session ?? approval.session;
				review = this.#tasks.start({
					kind: "review",
					conversation: id,
					requester: null,
					parent: null,
					root: chat,
					batch: call,
					position: 0,
					agent: majordomo.id,
					task: approval.summary,
				});
			}
			await this.#submit(review.conversation, this.#reviewRequest(approval), { operationId: call }, "review");
			const result = await this.harness.wait(call, { session: review.conversation });
			this.#tasks.finish(review.id, result.status === "done" ? "completed" : "failed", result.text?.trim() || result.reason || "");
		} catch (error) {
			console.warn(`the majordomo's review of ${approval.id} failed`, error);
		}
		await this.#escalate(approval.id, null);
	}

	/** What the majordomo reads to decide: who asks, for what, and in what chat. */
	#reviewRequest(approval: Approval): string {
		const { agent, from } = this.#roleOf(approval.session);
		const asker = `${agent.name}${agent.description ? ` (${agent.description})` : ""}, ${from === null ? "in a chat the person has with it" : `working on a task ${from} handed it for the person`}`;
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
		const review = this.#tasks.of(conversation);
		if (review?.kind !== "review") return "This conversation reviews no approval.";
		const id = review.batch.slice("review:".length);
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
		this.broadcastMessage({ type: "approval", approval: this.#publicApproval(escalated) });
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

	// The owner's agents, and the tasks they hand each other (./tasks.ts).

	/** The agent a conversation talks as, and who handed it its task. A review talks as the majordomo. */
	#roleOf(session: string): Role {
		const task = this.#tasks.of(session);
		if (!task) return { agent: this.agents.ofSession(session), from: null };
		if (task.kind === "review") return { agent: this.agents.majordomo(), from: null };
		const agent = this.agents.get(task.agent) ?? this.agents.majordomo();
		return { agent, from: this.#roleOf(task.requester!).agent.name };
	}

	/**
	 * Whom a conversation can hand tasks to: the majordomo, the person's other
	 * agents; any other agent, its contacts. None of the agents already on the
	 * chain of tasks that led to it, so work never goes round in a circle, and
	 * none at all `MAX_TASK_DEPTH` tasks down the chain.
	 */
	#delegates(session: string): Agent[] {
		if (this.visits.bySession(session) || this.#tasks.of(session)?.kind === "review") return [];
		const chain: string[] = [];
		for (let conversation: string | null = session; conversation !== null; ) {
			chain.push(this.#roleOf(conversation).agent.id);
			conversation = this.#tasks.of(conversation)?.requester ?? null;
		}
		if (chain.length > MAX_TASK_DEPTH) return [];
		const { agent } = this.#roleOf(session);
		const candidates = agent.majordomo ? this.agents.list() : agent.contacts.flatMap((id) => this.agents.get(id) ?? []);
		return candidates.filter((other) => !other.majordomo && !chain.includes(other.id));
	}

	/**
	 * A task's conversation leaves out what only an agent the person talks
	 * with does: talking to them, scheduling work and watching apps' events
	 * (both come back to the conversation that asked), and changing agents,
	 * apps and skills. App tools switched off for its agent are left out.
	 */
	#taskAgent(agent: Agent): AgentChange {
		const snapshot = this.registry.snapshot();
		const off = this.#switchedOff(agent);
		const removed = [MESSAGING_EXTENSION, SCHEDULE_EXTENSION].flatMap((name) => snapshot.extension(name) ?? []);
		// It works with its agent's abilities and apps.
		const added = [...this.extensions.abilitiesOf(agent.blueprint), ...this.#appExtensionsOf(agent)].flatMap((name) => snapshot.extension(name) ?? []);
		const left = snapshot.tools().filter(({ tool }) => LEAD_ONLY_TOOLS.has(tool.name) || off.has(tool.name));
		return { extensions: { add: added, remove: removed }, ...(left.length > 0 ? { tools: { remove: left.map(({ tool }) => tool) } } : {}) };
	}

	/**
	 * The names of the tools an agent's conversations aren't offered: the app
	 * tools switched off for it, writing and installing skills when its switch
	 * for skills is off, and, for any agent but the majordomo, the majordomo's
	 * own: naming and sharing memory scopes, and adding apps.
	 */
	#switchedOff(agent: Agent): Set<string> {
		const off = this.agentToolPermissions(agent).flatMap((info) => (info.permission === "off" ? [info.name] : []));
		if (skillsSwitch(this.store, agent.id).permission === "off") off.push(WRITE_SKILL, INSTALL_SKILL);
		return new Set(agent.majordomo ? off : [...off, ...MAJORDOMO_TOOLS]);
	}

	/**
	 * Gives out tasks a conversation hands out, each in a new conversation of
	 * its own or that of the earlier task it continues. Their answers come
	 * back in an update (see `#deliver`), or, when the call `waits`, as what
	 * it returns. A replayed call finds the tasks it gave, and gives them
	 * again only where giving didn't finish.
	 */
	async #startTasks(
		requester: string,
		batch: string,
		given: { to: Agent; task: string; continues: Task | null }[],
		{ call, waits }: { call: string; waits: boolean },
	): Promise<Task[]> {
		const asking = this.#tasks.of(requester);
		// Work an agent in a room hands out shows in the room's chat.
		const root = asking?.root ?? this.#rooms.of(requester)?.room ?? requester;
		const started: Task[] = [];
		for (const [position, { to, task, continues }] of given.entries()) {
			let record = this.#tasks.at(batch, position);
			if (!record) {
				const conversation = continues?.conversation ?? (await this.#taskConversation(to));
				record = this.#tasks.start({
					kind: "agent",
					conversation,
					requester,
					parent: asking && asking.kind !== "review" ? asking.id : null,
					root,
					batch,
					call,
					waits,
					position,
					agent: to.id,
					task,
				});
			}
			// Submitting the same operation again is a no-op: a replay gives the task once.
			await this.#submit(record.conversation, task, { operationId: `task:${record.id}`, whenBusy: "followUp" }, "task");
			this.#watchTask(record.conversation, `task:${record.id}`);
			started.push(record);
		}
		this.#tasksChanged(root);
		return started;
	}

	/** A new conversation for a task, as the agent it is for. */
	async #taskConversation(agent: Agent): Promise<string> {
		const { id } = await this.harness.sessions.create();
		await this.harness.session(id).setModel(this.agentModel(agent));
		await (await this.harness.conversation(id)).configure(this.#taskAgent(agent), BACKGROUND_CONTEXT);
		this.agents.setSession(id, agent.id);
		return id;
	}

	/**
	 * Waits, in memory, for an input to a task's conversation to settle, which
	 * may finish the task. Nothing keeps the space up for it: a run keeps it
	 * up, and after a restart `onStart` waits again (`#resumeTasks`).
	 */
	#watchTask(conversation: string, operation: string): void {
		void this.harness
			.wait(operation, { session: conversation })
			.then((result) => this.#taskSettled(conversation, result))
			.catch((error) => console.warn(`waiting for ${operation} failed`, error));
	}

	/**
	 * A task is done once its agent has answered its latest input and waits
	 * for no task it handed out: its answer is that last turn's. A run that
	 * ended unanswered fails it.
	 */
	async #taskSettled(conversation: string, result: PiOperationResult): Promise<void> {
		const task = this.#tasks.of(conversation);
		if (!task || task.kind === "review" || TERMINAL_STATES.has(task.state)) return;
		if (result.operationId !== task.operation || this.#tasks.waitsOnTasks(conversation)) return;
		const done = result.status === "done";
		const answer = done ? result.text?.trim() || "(It gave no answer.)" : `It didn't finish: ${result.reason ?? "unanswered"}.`;
		if (!this.#tasks.finish(task.id, done ? "completed" : "failed", answer)) return;
		this.#tasksChanged(task.root);
		await this.#deliver(task.batch);
	}

	/**
	 * Gives a conversation the answers of tasks it handed out together, once
	 * none of them is working: in one message, which wakes it. Those waiting
	 * for the person are named, and answered in a later update of their own.
	 * When the call that gave them waits, it waits for all of them, those
	 * waiting for the person too, and the last answer wakes it to return them.
	 */
	async #deliver(batch: string): Promise<void> {
		const tasks = this.#tasks.inBatch(batch);
		const requester = tasks[0]?.requester;
		if (!requester || tasks.some((task) => task.state === "working")) return;
		// No one is left to tell: the chat that asked was deleted, or the task that asked was canceled.
		if (this.store.deletedSessions().has(requester) || this.#tasks.of(requester)?.state === "canceled") {
			this.#tasks.drop(batch);
			return;
		}
		if (tasks[0]!.waits) {
			if (tasks.some((task) => !TERMINAL_STATES.has(task.state))) return;
			if ((await this.harness.resumeTask(requester, Number(batch) as TaskId)) !== "terminal") return;
			// The call ended without them, as when its chat was stopped: the answers come in an update.
			this.#tasks.stopWaiting(batch);
		}
		const done = this.#tasks.unanswered(batch);
		if (done.length === 0) return;
		const operation = `task-update:${done.map((task) => task.id).join(",")}`;
		this.#tasks.giving(
			done.map((task) => task.id),
			operation,
		);
		await this.#giveUpdate(requester, batch, operation);
	}

	/** Submits an update `#deliver` marked as being given; again after a restart, which gives it once. */
	async #giveUpdate(requester: string, batch: string, operation: string): Promise<void> {
		const tasks = this.#tasks.inBatch(batch);
		const by = (task: Task) => ({ task, by: this.agents.get(task.agent)?.name ?? "An agent" });
		const text = taskUpdate(
			tasks.filter((task) => task.update === operation).map(by),
			tasks.filter((task) => task.state === "auth-required").map(by),
		);
		try {
			await this.submitTo(requester, text, { operationId: operation, whenBusy: "followUp" }, "task");
		} catch (error) {
			console.warn(`giving ${operation} failed`, error);
			return;
		}
		this.#tasks.given(operation);
		// An agent at work on a task of its own goes on with the answers, and finishes its task once it has them all.
		const asking = this.#tasks.of(requester);
		if (asking && asking.kind !== "review" && !TERMINAL_STATES.has(asking.state)) {
			this.#tasks.setOperation(asking.id, operation);
			this.#watchTask(requester, operation);
		}
		for (const listener of this.#updateListeners.get(requester) ?? []) listener(operation);
	}

	/** After a restart: waits again for open tasks, gives a task that may not have been given, and updates that may not have been. */
	async #resumeTasks(): Promise<void> {
		for (const task of this.#tasks.open()) {
			// Giving the same operation again is a no-op: this gives a task only if the restart came between recording and giving it.
			if (task.operation === `task:${task.id}`) await this.#submit(task.conversation, task.task, { operationId: task.operation, whenBusy: "followUp" }, "task");
			this.#watchTask(task.conversation, task.operation);
		}
		for (const { batch, operation } of this.#tasks.beingGiven()) {
			const requester = this.#tasks.inBatch(batch)[0]?.requester;
			if (requester) await this.#giveUpdate(requester, batch, operation);
		}
		// A call waiting for tasks that finished just before the restart may not have been woken.
		for (const batch of this.#tasks.waiting()) await this.#deliver(batch);
	}

	// Rooms: chats grown into group chats (./rooms.ts).

	/** Whether a conversation is one of the person's chats with their own agents, which can grow into a room. */
	#roomable(conversation: string): boolean {
		const seat = this.#rooms.of(conversation);
		return !this.visits.bySession(conversation) && !this.#tasks.of(conversation) && (!seat || seat.room === conversation);
	}

	/** The agents in a room's seats, in order. */
	#seated(seats: readonly Seat[]): Agent[] {
		return seats.flatMap((seat) => this.agents.get(seat.agent) ?? []);
	}

	/**
	 * The agents a conversation can bring into its chat by mentioning them:
	 * the majordomo, any of the person's other agents; any other agent, its
	 * contacts. None already there.
	 */
	#invitable(conversation: string): Agent[] {
		const seat = this.#rooms.of(conversation);
		if (!seat && !this.#roomable(conversation)) return [];
		const { agent } = this.#roleOf(conversation);
		const present = new Set(seat ? this.#rooms.seats(seat.room).map((other) => other.agent) : [agent.id]);
		const candidates = agent.majordomo ? this.agents.list() : agent.contacts.flatMap((id) => this.agents.get(id) ?? []);
		return candidates.filter((other) => !present.has(other.id));
	}

	/**
	 * What the person says in a chat. Any of their agents it mentions that
	 * isn't there joins first. In a chat with one agent it is that agent's
	 * input, as ever; in a room it goes to every seat, waking the agents it is
	 * for: those it mentions, or the host when it mentions no one, or everyone
	 * in an open room. The others hear it without being woken.
	 */
	async #personSays(session: string, content: UserInput, options: { operationId?: string; whenBusy?: "followUp" | "steer" }): Promise<PiReceipt> {
		if (!this.#roomable(session)) return this.#submit(session, content, options, "user");
		const text = textOf(content);
		const host = this.agents.ofSession(session);
		for (const agent of mentioned(text, this.agents.list().filter((other) => other.id !== host.id))) await this.#join(session, agent);
		const seats = this.#rooms.seats(session);
		if (seats.length === 0) return this.#submit(session, content, options, "user");
		const operationId = options.operationId ?? crypto.randomUUID();
		const named = new Set(mentioned(text, this.#seated(seats)).map((agent) => agent.id));
		const open = this.#rooms.mode(session) === "open";
		const wakes = (seat: Seat) => open || named.has(seat.agent) || (seat.conversation === session && named.size === 0);
		const [hosting, ...members] = seats as [Seat, ...Seat[]];
		this.#logTurns("person", session, seats, named, wakes);
		const receipt = wakes(hosting) ? await this.#submit(session, content, { ...options, operationId }, "user") : await this.#write(session, content, operationId);
		// A message sent again reaches no one twice.
		if (!receipt.accepted) return receipt;
		if (wakes(hosting)) {
			await this.#resumeHeld(session);
			this.#rooms.setDepth(session, 0);
		}
		for (const seat of members) await this.#hear(seat, content, `${operationId}:${seat.agent}`, wakes(seat), 0);
		return receipt;
	}

	/** Says in the log who a message in a room was for and who it woke, so a silent agent can be told from one that was never asked. */
	#logTurns(from: string, room: string, seats: readonly Seat[], named: ReadonlySet<string>, wakes: (seat: Seat) => boolean, depth = 0): void {
		const name = (seat: Seat) => this.agents.get(seat.agent)?.name ?? seat.agent;
		console.log(JSON.stringify({ event: "pim.room", owner: this.name, room, from, depth, mode: this.#rooms.mode(room), mentioned: [...named].map((id) => this.agents.get(id)?.name ?? id), seats: seats.map(name), woke: seats.filter(wakes).map(name) }));
	}

	/**
	 * An agent sent a message in a chat (`send_to_user`), with Pim's copies
	 * of the images it shows, by their addresses. An agent it mentions that it may bring in joins
	 * the chat first. In a room the other seats hear it: those it mentions,
	 * or everyone in an open room, take a turn, one further from the person's
	 * message than the turn that sent it; the others hear it without being woken.
	 */
	async #posted(conversation: string, message: string, at: number, images: Readonly<Record<string, string>>): Promise<void> {
		// An agent taken out of a room, still finishing a message, brings no one in and is heard by no one.
		if (this.store.deletedSessions().has(conversation)) return;
		if (!this.#rooms.of(conversation) && !this.#roomable(conversation)) return;
		const room = this.#rooms.of(conversation)?.room ?? conversation;
		const speaker = this.#roleOf(conversation).agent;
		await this.#mentionPerson(room, speaker, message, at);
		for (const agent of mentioned(message, this.#invitable(conversation))) await this.#join(room, agent);
		// The chat shows the images as the sender's own message does, from Pim's copies.
		const said = Object.entries(images).reduce((text, [url, copy]) => text.replaceAll(url, copy), message);
		const seat = this.#rooms.of(conversation);
		if (!seat) return;
		const seats = this.#rooms.seats(room);
		const named = new Set(mentioned(message, this.#seated(seats)).map((agent) => agent.id));
		const open = this.#rooms.mode(room) === "open";
		const depth = seat.depth + 1;
		this.#logTurns(speaker.name, room, seats, named, (other) => other.conversation !== conversation && (open || named.has(other.agent)) && depth < MAX_ROOM_DEPTH, depth);
		for (const other of seats) {
			if (other.conversation === conversation) continue;
			const wake = (open || named.has(other.agent)) && depth < MAX_ROOM_DEPTH;
			await this.#hear(other, roomPost(speaker.name, said), `post:${conversation}:${at}:${other.agent}`, wake, depth);
		}
	}

	/** What an agent can call the person, from what this space knows: their username, and the name they gave their majordomo. */
	#personNames(): string[] {
		const username = this.profile()?.username;
		return username ? [...new Set([username, this.store.meta(PERSON_NAME_KEY)].filter((name): name is string => !!name))] : [];
	}

	/** Those, and the display name on their public profile, which they can change in Settings. */
	async #personNamesWithProfile(): Promise<string[]> {
		const names = this.#personNames();
		const username = this.profile()?.username;
		if (!username) return names;
		const shown = (await this.env.Gallery.getByName("gallery").profile(username).catch(() => null))?.displayName;
		return shown ? [...new Set([...names, shown])] : names;
	}

	/** Tells the person an agent mentioned them, as `@username`: a notification of its own kind, once however often the message is replayed. */
	async #mentionPerson(room: string, speaker: Agent, message: string, at: number): Promise<void> {
		if (!message.includes("@") || !mentionsPerson(message, await this.#personNamesWithProfile())) return;
		const id = `mention-${this.store.publicId(room)}-${speaker.id}-${at}`;
		if (this.store.notification(id)) return;
		const notification = this.store.addNotification({ id, kind: "mention", session: room, title: `${speaker.name} mentioned you`, body: plainReply(message).slice(0, 500) });
		await this.deliverNotification(notification);
	}

	/**
	 * Gives a seat what was said in its room: as input, which wakes its agent,
	 * `depth` turns from the person's latest message, or written in without
	 * waking it, for it to know when it next speaks.
	 */
	async #hear(seat: Seat, content: UserInput, operationId: string, wake: boolean, depth: number): Promise<void> {
		// A suspended space's agents set nothing more off.
		if (!wake || this.status() !== "active") {
			await this.#write(seat.conversation, content, operationId);
			return;
		}
		await this.#selectAbilities(seat.conversation);
		const receipt = await this.#submit(seat.conversation, content, { operationId, whenBusy: "followUp" }, "room");
		if (!receipt.accepted) return;
		// An agent whose run is held after a model error has no Try again of its own in a room: what it is now asked answers for it, or queues behind the error for good.
		await this.#resumeHeld(seat.conversation);
		this.#rooms.setDepth(seat.conversation, depth);
		// The chat shows who is at work in it: its list changes as an agent starts, and again when it's done.
		if (seat.conversation === seat.room) return;
		this.broadcastMessage({ type: "sessions" });
		void this.harness
			.wait(operationId, { session: seat.conversation })
			.then(() => this.broadcastMessage({ type: "sessions" }))
			.catch((error) => console.warn(`waiting for ${operationId} failed`, error));
	}

	/**
	 * Writes a message into a conversation without waking its agent: it is
	 * in the agent's context from its next request. While the agent works it
	 * waits for its next step. Writing the same operation again writes nothing.
	 */
	async #write(session: string, content: UserInput, operationId: string): Promise<PiReceipt> {
		const conversation = await this.harness.conversation(session);
		const known = await (await this.harness.storage()).submissionByRequest(conversation.id, operationId, BACKGROUND_CONTEXT);
		if (!known) {
			await conversation.submit(
				{ type: "write", requestId: operationId, entry: { kind: ROOM_ENTRY, model: [{ role: "user", content, timestamp: Date.now() }] } },
				BACKGROUND_CONTEXT,
			);
		}
		return { operationId, session, accepted: !known };
	}

	/**
	 * Brings an agent into a chat, which becomes a room if it wasn't one. It
	 * gets a seat: a conversation of its own, as a chat with it is, which
	 * starts with nothing of what was said before (it reads that with
	 * `chat_history`); everyone else hears it joined. The message that
	 * brought it in is the first thing it hears.
	 */
	#join(room: string, agent: Agent): Promise<Seat> {
		const seated = this.#rooms.at(room, agent.id);
		if (seated) return Promise.resolve(seated);
		const key = `${room}:${agent.id}`;
		let joining = this.#joining.get(key);
		if (!joining) {
			joining = this.#seat(room, agent).finally(() => this.#joining.delete(key));
			this.#joining.set(key, joining);
		}
		return joining;
	}

	async #seat(room: string, agent: Agent): Promise<Seat> {
		const host = this.agents.ofSession(room);
		const { id } = await this.harness.sessions.create();
		await this.harness.session(id).setModel(this.agentModel(agent));
		this.agents.setSession(id, agent.id);
		this.#rooms.open(room, host.id);
		const others = this.#rooms.seats(room);
		const seat = this.#rooms.seat(room, agent.id, id);
		const names = this.#seated(others).map((other) => other.name);
		await this.#write(id, `${ROOM_NOTICE} You joined this chat, with the person and ${names.join(", ")}.`, `join:${id}`);
		for (const other of others) await this.#write(other.conversation, `${ROOM_NOTICE} ${agent.name} joined the chat.`, `joined:${id}:${other.agent}`);
		this.broadcastMessage({ type: "sessions" });
		return seat;
	}

	/**
	 * Takes an agent out of a room, as its host or the person asks. Its
	 * conversation is put away as a deleted chat's is: it stops, the tasks it
	 * handed out are canceled and its approval requests denied. Everyone left
	 * hears it left. Brought in again, it gets a seat afresh.
	 */
	async #leave(seat: Seat): Promise<void> {
		if (seat.conversation === seat.room || !this.#rooms.of(seat.conversation)) return;
		this.#rooms.unseat(seat);
		this.store.deleteSession(seat.conversation);
		const reason = "It was taken out of the chat.";
		for (const approval of this.store.approvals("pending")) {
			if (approval.session !== seat.conversation || !this.store.decideApproval(approval.id, "denied", reason, "user")) continue;
			this.broadcastMessage({ type: "approval", approval: this.#publicApproval(this.store.approval(approval.id)!) });
		}
		await this.harness.session(seat.conversation).abort();
		for (const task of this.#tasks.byRequester(seat.conversation)) await this.#cancelTask(task, reason);
		const name = this.agents.get(seat.agent)?.name ?? "An agent";
		for (const other of this.#rooms.seats(seat.room)) await this.#write(other.conversation, `${ROOM_NOTICE} ${name} left the chat.`, `left:${seat.conversation}:${other.agent}`);
		this.broadcastMessage({ type: "sessions" });
	}

	/** A room as the chat list shows it, read now. */
	async #roomOf(session: string) {
		const held = await this.#heldSessions();
		const busy = new Set((await this.harness.sessions.list()).flatMap((info) => (info.busy && !held.has(info.id) ? [info.id] : [])));
		return this.#roomInfo(session, busy, await this.#heldErrors(held));
	}

	/**
	 * What failed for each agent of a group chat whose run is held: its last error, which the chat classifies as it does a
	 * held chat's own. An agent in a room has no chat of its own to show it in.
	 */
	async #heldErrors(held: ReadonlySet<string>): Promise<Map<string, string>> {
		const errors = new Map<string, string>();
		for (const conversation of held) {
			const seat = this.#rooms.of(conversation);
			if (!seat || seat.conversation === seat.room) continue;
			const failed = projectEntries(await this.harness.session(conversation).messages()).findLast((message) => message.role === "assistant" && message.error !== undefined);
			errors.set(conversation, failed && "error" in failed && failed.error ? failed.error : "");
		}
		return errors;
	}

	/** What the chat list says of a room: how agents take turns, and who is in it besides the host, each with whether it is at work. Every chat of the person's with their own agents is a room, with no one but its host at first. */
	#roomInfo(session: string, busy: ReadonlySet<string>, held: ReadonlyMap<string, string>): { mode: RoomMode; members: { id: string; name: string; busy: boolean; held: boolean; error: string | null }[] } | null {
		const [host, ...members] = this.#rooms.seats(session);
		if (!host && !this.#roomable(session)) return null;
		return {
			mode: this.#rooms.mode(session),
			members: members.flatMap((seat) => {
				const agent = this.agents.get(seat.agent);
				return agent ? [{ id: agent.id, name: agent.name, busy: busy.has(seat.conversation), held: held.has(seat.conversation), error: held.get(seat.conversation) ?? null }] : [];
			}),
		};
	}

	/** A task's agent waits for the person's decision on an approval: it is `auth-required` until the decision. */
	async #taskWaits(session: string): Promise<void> {
		const task = this.#tasks.of(session);
		if (!task || task.kind === "review" || !this.#tasks.setState(task.id, "auth-required")) return;
		this.#tasksChanged(task.root);
		await this.#deliver(task.batch);
	}

	/**
	 * Cancels a task not yet done, and the tasks it handed out: their agents
	 * stop, and their approval requests are denied. Its requester hears it
	 * was canceled, as it would hear its answer.
	 */
	async #cancelTask(task: Task, reason: string): Promise<void> {
		if (!this.#tasks.finish(task.id, "canceled", reason)) return;
		for (const handed of this.#tasks.byRequester(task.conversation)) await this.#cancelTask(handed, "The task it was part of was canceled.");
		for (const approval of this.store.approvals("pending")) {
			if (approval.session !== task.conversation || !this.store.decideApproval(approval.id, "denied", reason, "user")) continue;
			this.broadcastMessage({ type: "approval", approval: this.#publicApproval(this.store.approval(approval.id)!) });
		}
		await this.harness.session(task.conversation).abort();
		this.#tasksChanged(task.root);
		await this.#deliver(task.batch);
	}

	/** Open apps show a chat's tasks anew. */
	#tasksChanged(root: string): void {
		this.broadcastMessage({ type: "tasks", session: this.store.publicId(root) });
	}

	/** Who waits for updates to a conversation, as the MCP server does for its client. */
	readonly #updateListeners = new Map<string, Set<(operation: string) => void>>();

	/** Collects the updates given to `session` from now on, in order, until closed. */
	#listenForUpdates(session: string): { pending(): boolean; next(signal: AbortSignal): Promise<string>; close(): void } {
		const queue: string[] = [];
		let wake: (() => void) | null = null;
		const listener = (operation: string) => {
			queue.push(operation);
			wake?.();
		};
		const listeners = this.#updateListeners.get(session) ?? new Set();
		listeners.add(listener);
		this.#updateListeners.set(session, listeners);
		return {
			pending: () => queue.length > 0,
			next: async (signal) => {
				while (queue.length === 0) {
					signal.throwIfAborted();
					await new Promise<void>((resolve, reject) => {
						wake = resolve;
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
					wake = null;
				}
				return queue.shift()!;
			},
			close: () => {
				listeners.delete(listener);
				if (listeners.size === 0) this.#updateListeners.delete(session);
			},
		};
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
				memoryWidgets(this.memory.store, (id) => this.#memoryAccess(this.agents.get(id) ?? this.agents.majordomo()).read.map((scope) => scope.key)),
				artifactsWidgets(this.artifacts),
				...this.pimConfig().extensions,
			],
			this.pimConfig().defaultBlueprint,
		);
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
	 * Gives a chat the abilities its agent uses and the apps it lists, less
	 * the app tools switched off for the agent, as they are now, before its next
	 * run: its agent, the agent's blueprint, the extensions, the connected apps
	 * or the switches may have changed since.
	 * Visits choose their own extensions, and tasks' conversations get theirs
	 * when made. A chat whose selection is unchanged isn't written to.
	 */
	async #selectAbilities(session: string): Promise<void> {
		if (this.visits.bySession(session) || this.#tasks.of(session)) return;
		const agent = this.agents.ofSession(session);
		// Apps last: their tools come and go, and pi only appends cheaply at the end.
		const wanted = [...this.extensions.abilitiesOf(agent.blueprint), ...this.#appExtensionsOf(agent)];
		const off = [...this.#switchedOff(agent)];
		const key = [...wanted, ...off.map((name) => `-${name}`)].join(" ");
		if ((this.agents.abilities(session) ?? "") === key) return;
		const snapshot = this.registry.snapshot();
		const add = wanted.flatMap((name) => snapshot.extension(name) ?? []);
		const remove = snapshot.tools().flatMap(({ tool }) => (off.includes(tool.name) ? [tool] : []));
		await (await this.harness.conversation(session)).configure(
			{ extensions: add.length > 0 ? { add } : null, tools: remove.length > 0 ? { remove } : null },
			BACKGROUND_CONTEXT,
		);
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

	/** What an agent's dashboard shows: its own, once it has been changed, or else its blueprint's. */
	#dashboardItems(agent: Agent): readonly string[] {
		if (agent.dashboard) return agent.dashboard;
		return (agent.blueprint === null ? undefined : this.extensions.blueprint(agent.blueprint))?.dashboard ?? [];
	}

	/** The artifact a dashboard item pins: undefined for a widget, null for an artifact since deleted. */
	#pinnedArtifact(item: string) {
		if (!item.startsWith(PINNED_ARTIFACT)) return undefined;
		return this.artifacts.get(item.slice(PINNED_ARTIFACT.length)) ?? null;
	}

	/**
	 * An agent's dashboard: each widget loaded for this agent, and each pinned
	 * artifact as its latest version, which the app runs. A widget that fails
	 * shows as failed; the others still load. A widget no installed extension
	 * brings anymore, and an artifact since deleted, are left out.
	 */
	async #dashboard(agent: Agent, locale: string) {
		const items = await Promise.all(
			this.#dashboardItems(agent).map(async (item) => {
				const artifact = this.#pinnedArtifact(item);
				if (artifact !== undefined) {
					if (!artifact) return null;
					const widget = hasWidget(artifact.kind, this.artifacts.version(artifact.id)!.files);
					const size = agent.dashboardSizes[item] ?? DEFAULT_WIDGET_SIZE;
					return { id: item, title: artifact.title, size, artifact: { id: artifact.id, kind: artifact.kind, version: artifact.version, widget } };
				}
				if (!this.extensions.widget(item)) return null;
				const widget = await this.#loadWidget(agent, item);
				return { ...widget, title: localize(widget.title, locale), empty: localize(widget.empty, locale) };
			}),
		);
		return {
			agent: { id: agent.id, name: agent.name, description: agent.description, majordomo: agent.majordomo, blueprint: agent.blueprint, icon: agent.icon, symbol: agent.symbol, color: agent.color },
			widgets: items.filter((item) => item !== null),
		};
	}

	/**
	 * The messages an agent's dashboard offers to start a chat with. Once the
	 * agent has had a chat, the utility model writes them from its latest chats,
	 * what Pim remembers and what its dashboard shows, and writes them again
	 * only when that has changed since, so an agent nobody talks to costs
	 * nothing. Until then, and when the model can't, its blueprint's starters.
	 */
	async #suggestions(agent: Agent, locale: string): Promise<string[]> {
		const blueprint = agent.blueprint === null ? undefined : this.extensions.blueprint(agent.blueprint);
		const starters = (blueprint?.starters ?? []).map((starter) => localize(starter, locale));
		const hidden = this.#hiddenSessions();
		const chats = (await this.harness.sessions.list())
			.filter((session) => !hidden.has(session.id) && this.#agentRef(session.id)?.id === agent.id)
			.sort((a, b) => (this.store.sessionInfo(b.id)?.updatedAt ?? 0) - (this.store.sessionInfo(a.id)?.updatedAt ?? 0))
			.slice(0, SUGGESTION_CHATS);
		const talked = (await Promise.all(chats.map(async (chat) => conversationText(projectEntries(await this.harness.session(chat.id).messages()), SUGGESTION_CHAT_CHARS)))).filter((text) => text !== "");
		if (talked.length === 0) return starters;

		const pinned = this.#dashboardItems(agent).flatMap((item) => this.#pinnedArtifact(item)?.title ?? []);
		const memory = this.memory.view(this.#memoryAccess(agent).read).join("\n");
		const input = [
			`Assistant: ${agent.name}${agent.description === "" ? "" : `, ${agent.description}`}`,
			`Language: ${locale}`,
			memory === "" ? "" : `What it remembers about the person:\n${memory.length > SUGGESTION_MEMORY_CHARS ? `…${memory.slice(-SUGGESTION_MEMORY_CHARS)}` : memory}`,
			pinned.length === 0 ? "" : `On its dashboard: ${pinned.join("; ")}`,
			`Recent chats, latest first:\n\n${talked.join("\n\n---\n\n")}`,
		]
			.filter((part) => part !== "")
			.join("\n\n");
		const key = `${SUGGESTIONS_KEY}${agent.id}`;
		const of = await digestHex(input);
		const stored = this.store.meta(key);
		const cached = stored === undefined ? undefined : (JSON.parse(stored) as { of: string; items: string[] });
		if (cached?.of === of) return cached.items;

		// Two dashboards opened together share one answer.
		let writing = this.#suggesting.get(key);
		if (!writing || writing.of !== of) {
			const promise = this.utilityStructured(SUGGEST_PROMPTS, input).then((items) => {
				this.store.setMeta(key, JSON.stringify({ of, items }));
				return items;
			});
			writing = { of, promise };
			this.#suggesting.set(key, writing);
			void promise.then(
				() => this.#suggesting.delete(key),
				() => this.#suggesting.delete(key),
			);
		}
		try {
			return await writing.promise;
		} catch (error) {
			if (!(error instanceof HttpError)) console.warn("prompt suggestions failed", error);
			return cached?.items ?? starters;
		}
	}

	/**
	 * Sets what an agent's dashboard shows, in order. Each item must be on it
	 * already, a widget the agent can show, or one of the person's artifacts
	 * with a widget, which is what the dashboard shows of it; anything else is
	 * refused, with the reason. `sizes` changes the size of artifacts' widgets,
	 * by item; the others keep theirs.
	 */
	#setDashboard(agent: Agent, items: readonly string[], sizes: Readonly<Record<string, unknown>> = {}) {
		const current = this.#dashboardItems(agent);
		const widgets = this.#widgetsFor(agent.blueprint);
		const next = [...new Set(items)];
		for (const item of next) {
			if (current.includes(item) || widgets.some(({ ref }) => ref === item)) continue;
			const artifact = this.#pinnedArtifact(item);
			if (artifact) {
				if (hasWidget(artifact.kind, this.artifacts.version(artifact.id)!.files)) continue;
				throw new HttpError(
					400,
					`${artifact.title} has no widget, the small view of it a dashboard shows: add widget.html to a page, or Widget.jsx to an app, with artifact_update, then pin it. Only html and jsx artifacts have widgets.`,
				);
			}
			throw new HttpError(
				400,
				`${item} is neither one of your artifacts (as ${PINNED_ARTIFACT}<id>) nor a widget this dashboard can show. Widgets it can show: ${widgets.map(({ ref }) => ref).join(", ")}.`,
			);
		}
		if (next.length > MAX_DASHBOARD) throw new HttpError(400, `A dashboard shows at most ${MAX_DASHBOARD} things: take some off first.`);
		for (const [item, size] of Object.entries(sizes)) {
			if (!next.includes(item) || !item.startsWith(PINNED_ARTIFACT)) throw new HttpError(400, `Only an artifact's widget on the dashboard has a size, and ${item} isn't one.`);
			if (!WIDGET_SIZES.includes(size as WidgetSize)) throw new HttpError(400, `A widget's size is ${WIDGET_SIZES.join(", ")}.`);
		}
		// Kept only for what's still on it, and only where it isn't the default.
		const merged = { ...agent.dashboardSizes, ...(sizes as Record<string, WidgetSize>) };
		const kept = Object.fromEntries(next.flatMap((item) => (merged[item] && merged[item] !== DEFAULT_WIDGET_SIZE ? [[item, merged[item]]] : [])));
		this.agents.setDashboard(agent.id, next, kept);
		return { items: next, sizes: kept };
	}

	/**
	 * `update_dashboard`: pins artifacts, by id, and widgets, by name, after
	 * what's there; unpins others; sizes artifacts' widgets. Answers with what
	 * the dashboard shows then and the widgets it could also show, for the model.
	 */
	#changeDashboard(agent: Agent, { pin, unpin, sizes }: { pin: readonly string[]; unpin: readonly string[]; sizes: Readonly<Record<string, WidgetSize>> }) {
		const widgets = this.#widgetsFor(agent.blueprint);
		// A widget by its name, or an artifact by its id, with or without the prefix.
		const item = (given: string) => {
			const name = given.trim();
			if (name.startsWith(PINNED_ARTIFACT) || widgets.some(({ ref }) => ref === name) || this.extensions.widget(name)) return name;
			return `${PINNED_ARTIFACT}${name}`;
		};
		const current = this.#dashboardItems(agent);
		const removed = new Set(unpin.map(item));
		const missing = [...removed].filter((name) => !current.includes(name));
		if (missing.length > 0) throw new Error(`Not on your dashboard: ${missing.join(", ")}. Call ${UPDATE_DASHBOARD} with nothing to see what is.`);
		// What's gone from under it, a deleted artifact or an uninstalled widget, goes with this change.
		const kept = current.filter((name) => !removed.has(name) && (this.#pinnedArtifact(name) ?? this.extensions.widget(name)));
		const sized = Object.fromEntries(Object.entries(sizes).map(([name, size]) => [item(name), size]));
		const next = this.#setDashboard({ ...agent, dashboard: kept }, [...kept, ...pin.map(item)], sized);
		const titled = (name: string) => {
			const artifact = this.#pinnedArtifact(name);
			if (artifact) return { artifact: artifact.id, title: artifact.title, size: next.sizes[name] ?? DEFAULT_WIDGET_SIZE };
			return { widget: name, title: localize(this.extensions.widget(name)!.title, "en") };
		};
		return {
			dashboard: next.items.map(titled),
			...(next.items.length === 0 ? { note: "Your dashboard is empty." } : {}),
			widgets_you_could_pin: widgets.filter(({ ref }) => !next.items.includes(ref)).map(({ ref, widget }) => ({ name: ref, title: localize(widget.title, "en") })),
		};
	}

	/** Loads an installed widget for one of the owner's agents. One that throws comes back failed. */
	async #loadWidget(agent: Agent, ref: string): Promise<ShownWidget> {
		const widget = this.extensions.widget(ref)!;
		const deleted = this.store.deletedSessions();
		// A task's conversation works for the chat the work began in.
		const chatFor = (session: string) => this.#tasks.of(session)?.root ?? session;
		const ofAgent = (session: string) => {
			const chat = chatFor(session);
			return !this.visits.bySession(chat) && this.agents.ofSession(chat).id === agent.id;
		};
		const context: WidgetContext = {
			agent: { id: agent.id, name: agent.name, majordomo: agent.majordomo },
			timeZone: this.settings().timeZone,
			chatOf: (session) => (ofAgent(session) && !deleted.has(chatFor(session)) ? this.store.publicId(chatFor(session)) : null),
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

	/** The widgets an agent built on `blueprint` can show: Pim's own, and those of the extensions it builds on and uses. */
	#widgetsFor(blueprint: string | null): { ref: string; widget: Widget }[] {
		const extensions = new Set([...BUILT_IN_WIDGETS, ...(blueprint ? [blueprint.slice(0, blueprint.indexOf("/"))] : []), ...this.extensions.abilitiesOf(blueprint)]);
		return this.extensions
			.list()
			.flatMap((extension) => (extensions.has(extension.id) ? Object.entries(extension.widgets ?? {}).map(([name, widget]) => ({ ref: `${extension.id}/${name}`, widget })) : []));
	}

	/**
	 * The widgets a chat can show with its messages: those its agent can show
	 * that have a description for the model. None in a visit, or in a task's
	 * conversation.
	 */
	#chatWidgets(session: string): { ref: string; description: string }[] {
		if (this.visits.bySession(session) || this.#tasks.of(session)) return [];
		return this.#widgetsFor(this.agents.ofSession(session).blueprint).flatMap(({ ref, widget }) => (widget.description ? [{ ref, description: widget.description }] : []));
	}

	/** The agent a chat talks with; none in a visit, which talks with someone else's. */
	#agentRef(session: string): { id: string; name: string } | null {
		if (this.visits.bySession(session)) return null;
		const agent = this.agents.ofSession(session);
		return { id: agent.id, name: agent.name };
	}

	/**
	 * One of the owner's agents, with its uploaded icon, for the Worker to
	 * publish to the gallery: with its contacts, and theirs, which come with
	 * it, each by name and with its own uploaded icon.
	 */
	async agentToPublish(id: string): Promise<PublishedAgent | null> {
		this.#assertOpen();
		const agent = this.agents.get(id);
		if (!agent) return null;
		const byId = new Map(this.agents.list().map((other) => [other.id, other]));
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
		const { name, role, description, instructions, apps, blueprint, symbol, color } = agent;
		return {
			id,
			name,
			role,
			description,
			instructions,
			apps,
			blueprint,
			symbol,
			color,
			contacts: names(agent.contacts),
			bundle: bundle.map((other) => ({
				name: other.name,
				role: other.role,
				description: other.description,
				instructions: other.instructions,
				apps: other.apps,
				blueprint: other.blueprint,
				symbol: other.symbol,
				color: other.color,
				contacts: names(other.contacts),
				image: this.agents.icon(other.id) ?? null,
			})),
			image: this.agents.icon(id) ?? null,
		};
	}

	/** Records which template an agent is published as; null once unpublished. */
	async setAgentPublished(id: string, template: string | null): Promise<void> {
		this.#assertOpen();
		if (this.agents.get(id)) this.agents.setPublished(id, template);
	}

	/** The latest version of one of the owner's artifacts, for the Worker to publish to the gallery. */
	async artifactToPublish(id: string): Promise<ArtifactToPublish | null> {
		this.#assertOpen();
		const artifact = ARTIFACT_ID.test(id) ? this.artifacts.get(id) : undefined;
		if (!artifact) return null;
		// Viewers' spaces read the files from R2 under this owner's prefix, so they must be there.
		const latest = await this.artifacts.stored(artifact.id, artifact.version);
		return { id: artifact.id, version: latest.version, title: artifact.title, kind: artifact.kind, files: [...latest.files], sha256: latest.sha256, size: latest.size };
	}

	/**
	 * A bridge call from an artifact someone published, which the owner opened
	 * from the gallery. Like an artifact shared with them, it keeps what it
	 * keeps for them here (under `gallery/<id>`), and uses their model and
	 * tools once they allow its version. It keeps nothing for everyone.
	 */
	async publishedArtifactCall(
		published: { id: string; sha256: string },
		call: { op: unknown; args: Record<string, unknown> },
	): Promise<{ ok: true; answer: unknown } | { ok: false; status: number; reason: string }> {
		try {
			const shared = async () => {
				throw new HttpError(400, "A published artifact keeps nothing for everyone: pim.shared works only in artifacts shared with circles.");
			};
			return { ok: true, answer: await this.#artifactBridge(`gallery/${published.id}`, published.sha256, call.op, call.args, shared) };
		} catch (error) {
			if (error instanceof HttpError) return { ok: false, status: error.status, reason: error.message };
			throw error;
		}
	}

	/** Lets the owner's model or a tool be used by a published artifact's version they opened. */
	async publishedArtifactGrant(
		published: { id: string; sha256: string },
		capability: unknown,
	): Promise<{ ok: true; granted: string } | { ok: false; status: number; reason: string }> {
		try {
			return { ok: true, granted: this.#grantArtifact(`gallery/${published.id}`, published.sha256, capability) };
		} catch (error) {
			if (error instanceof HttpError) return { ok: false, status: error.status, reason: error.message };
			throw error;
		}
	}

	/** Makes a published artifact one of the owner's: a new artifact with copies of its files, theirs to change. */
	async adoptArtifact(published: { title: string; kind: ArtifactKind; owner: string; files: readonly ArtifactFile[] }): Promise<ArtifactSummary> {
		this.#assertOpen();
		const loaded = await readFiles(this.env.ARTIFACTS, published.owner, published.files);
		const entry = ENTRY_FILES[published.kind];
		const files = Object.fromEntries([...loaded].filter(([path]) => path !== entry).map(([path, file]) => [path, file.bytes]));
		const id = crypto.randomUUID();
		await this.artifacts.create({ id, title: published.title, kind: published.kind, content: loaded.get(entry)!.bytes, files, session: null });
		return this.artifacts.get(id)!;
	}

	/** Makes a published template one of the owner's agents: a copy of it, theirs to change, with copies of the agents that come with it. */
	async adoptTemplate(template: Omit<PublishedAgent, "image"> & { author: string; image: AgentIcon | null }): Promise<Agent> {
		this.#assertOpen();
		return this.#adopt(template, { template: template.id, author: template.author });
	}

	/** At registration: gives the person a copy of the agent the admin chose for everyone, its icon and the agents that come with it too, besides their majordomo. */
	async adoptEveryonesAgent(agent: Omit<PublishedAgent, "id" | "image"> & { author: string; image: AgentIcon | null }): Promise<Agent> {
		this.#assertOpen();
		return this.#adopt(agent, { template: "default", author: agent.author });
	}

	/**
	 * Copies an agent from the gallery into the owner's agents, and the agents
	 * that come with it, each with its uploaded icon and a contact of the
	 * copies that had it. A copy
	 * whose role one of the owner's agents already has gets a role of its own,
	 * so that agents hand it tasks by its role.
	 */
	async #adopt(copy: Omit<PublishedAgent, "id" | "image"> & { image: AgentIcon | null }, source: NonNullable<Agent["source"]>): Promise<Agent> {
		const all = [copy, ...copy.bundle];
		if (all.length > 1 && this.agents.list().length + all.length > MAX_AGENTS) {
			throw new HttpError(429, `You can have up to ${MAX_AGENTS} agents, and ${copy.name} comes with ${all.length - 1} more.`);
		}
		const inputs: AgentInput[] = [];
		for (const { name, role, description, instructions, apps, blueprint, symbol, color } of all) {
			inputs.push(await this.#installed(agentInput({ name, role, description, instructions, apps, blueprint, symbol, color })));
		}
		const taken = new Set(this.agents.list().map((agent) => agent.role.toLowerCase()));
		const made = inputs.map((input, index) => {
			const role = freeName(input.role!, copy.name, taken);
			taken.add(role.toLowerCase());
			return this.agents.create({ ...input, role }, source, index === 0 ? source.template : `${source.template}/${all[index]!.role.toLowerCase()}`);
		});
		const copyOf = new Map(all.map((agent, index) => [agent.role.toLowerCase(), made[index]!]));
		for (const [index, agent] of all.entries()) {
			const contacts = agent.contacts.flatMap((role) => copyOf.get(role.toLowerCase())?.id ?? []).filter((id) => id !== made[index]!.id);
			if (contacts.length > 0) this.agents.update(made[index]!.id, agentInput({ contacts }, made[index]));
		}
		for (const [index, agent] of all.entries()) if (agent.image) this.agents.setIcon(made[index]!.id, agent.image.type, agent.image.data);
		return this.agents.get(made[0]!.id)!;
	}

	// Visits: spaces shared with this one's owner, and their conversations with them.

	/** From a host's space: its owner put this space's owner in a circle. */
	async shareReceived(host: Guest): Promise<void> {
		this.#assertOpen();
		if (this.status() !== "active") throw new Error("This space is suspended");
		if (!this.visits.shared(host)) return;
		const notification = this.store.addNotification({
			id: crypto.randomUUID(),
			session: null,
			title: `${host.username} shared their space with you`,
			body: `You can message ${host.username}'s space now. Find it under Shared with you.`,
		});
		await this.deliverNotification(notification);
		this.broadcastMessage({ type: "visits" });
	}

	/** From a host's space: this space's owner is no longer in its circles. */
	async shareRevoked(hostOwnerId: string): Promise<void> {
		if (this.#closed()) return;
		this.visits.revoked(hostOwnerId);
		this.registry.uninstall({ name: visitExtensionName(hostOwnerId) });
		this.broadcastMessage({ type: "visits" });
	}

	/** From a host's space: the owner decided on something this space's owner asked for; it continues the visit. */
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
		if (!share) throw new HttpError(404, `${username} doesn't share their space with you`);
		if (share.revoked) throw new HttpError(403, `${username} no longer shares their space with you`);
		if (share.session !== null && !this.store.deletedSessions().has(share.session)) return share.session;
		const { id } = await this.harness.sessions.create();
		await this.harness.session(id).setModel(this.chosenModel());
		this.store.touchSession(id, `${username}'s space`);
		this.visits.setSession(share.ownerId, id);
		await this.#refreshVisit(share.ownerId);
		return id;
	}

	/**
	 * Asks the host's space what this visit may use now, and gives the visit's
	 * conversation exactly that: its own extension, and nothing of the
	 * owner's. Refused, the visit can't go on.
	 */
	async #refreshVisit(hostOwnerId: string): Promise<void> {
		const share = this.visits.share(hostOwnerId);
		const me = this.#me();
		if (!share || share.session === null || me === null) throw new HttpError(404, "No such visit");
		if (share.revoked) throw new HttpError(403, `${share.username} no longer shares their space with you`);
		const result = (await (await this.#pimOf(hostOwnerId)).guestBrief(me)) as BriefResult;
		if (!result.ok) {
			this.visits.setBrief(hostOwnerId, null);
			throw new HttpError(403, result.reason);
		}
		this.visits.setBrief(hostOwnerId, result.brief);
		const extension = this.#installVisit(result.brief, me.username);
		const conversation = await this.harness.conversation(share.session);
		// The visitor reads what the visit sends them, as in any of their conversations.
		const snapshot = this.registry.snapshot();
		const messaging = snapshot.extension(MESSAGING_EXTENSION)!;
		await conversation.configure({ extensions: [extension, messaging, snapshot.extension(TELEMETRY_EXTENSION)!] }, BACKGROUND_CONTEXT);
	}

	/** Installs (or replaces) a visit's extension; its tools call the host's space. */
	#installVisit(brief: GuestBrief, visitor: string) {
		const host = brief.host.ownerId;
		const extension = visitExtension(brief, visitor, async (tool, args, session, callId) => {
			this.#assertOpen();
			const me = this.#me();
			if (me === null) return { text: "This space can't visit others.", isError: true };
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

	/** Every request comes through the Worker, which names the owner it resolved: it must be this space's. */
	override async fetch(request: Request): Promise<Response> {
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

	/** Records who owns this space. */
	async provision(profile: OwnerProfile): Promise<void> {
		this.#assertOpen();
		if (profile.ownerId !== this.name) throw new Error(`Owner ${profile.ownerId} is not this agent's (${this.name})`);
		this.store.setMeta(PROFILE_KEY, JSON.stringify(profile));
	}

	profile(): OwnerProfile | null {
		const json = this.store.meta(PROFILE_KEY);
		return json === undefined ? null : (JSON.parse(json) as OwnerProfile);
	}

	/** Changes the person's settings, as `PUT /settings` does; registration sets their time zone. */
	async applySettings(update: Record<string, unknown>): Promise<Settings> {
		this.#assertOpen();
		const before = this.settings().approvalPolicy;
		const settings = updateSettings(this.store, this.#defaultSettings(), update);
		// The approval tools say how a request is decided: they must say it the new way.
		if (settings.approvalPolicy !== before) this.#reinstallApprovals();
		return settings;
	}

	/** Suspends or restores the space. Suspending stops its runs and closes its sockets; its data stays. */
	async setStatus(status: OwnerStatus): Promise<void> {
		this.#assertOpen();
		if (status === "active") this.store.deleteMeta(STATUS_KEY);
		else this.store.setMeta(STATUS_KEY, status);
		if (status === "suspended") {
			for (const session of await this.harness.sessions.list()) await this.harness.session(session.id).abort();
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
				id: this.store.publicId(session.id),
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
			// Without their keys, as everywhere.
			providers: this.customProviders().flatMap(({ shared, provider }) => (shared ? [] : [providerInfo(provider)])),
			sessions,
			memory: { scopes: this.memoryScopes(), entries: this.memory.store.page(Number.MAX_SAFE_INTEGER) },
			goals: this.store.goals().map((goal) => this.#publicSession(goal)),
			extensions: this.extensionData.export(),
			schedules: (await this.services().listSchedules()).map((schedule) => describeSchedule(schedule, this.store)),
			approvals: this.store.approvals().map((approval) => this.#publicApproval(approval)),
			permissions: this.store.toolPermissions(),
			circles: this.#describeCircles(),
			agents: this.agents.list(),
			guestActivity: this.circles.activity(500),
			sharedWithMe: this.visits.shares().map(({ ownerId, username, sharedAt, revoked }) => ({ ownerId, username, sharedAt, revoked })),
			notifications: this.store.notifications({ unread: false }).map((notification) => this.#publicSession(notification)),
			apps: this.apps.servers().map(({ id, name, url, approval }) => ({ id, name, url, approval })),
			watches: this.appEvents.list(),
			...(await this.artifacts.export().then(({ artifacts, files }) => ({ artifacts: artifacts.map((artifact) => this.#publicSession(artifact)), artifactFiles: files }))),
			othersArtifactData: this.artifacts.othersData(),
			// Files the space still keeps; those on the person's computer are theirs already.
			files: await this.legacyFiles.export(),
			...(await this.skills.export().then(({ skills, files }) => ({ skills, skillFiles: files }))),
			usage: this.usage.history(90),
		});
	}

	/**
	 * What of the person's data this space still holds; nothing once
	 * `deleteEverything` has run. A deletion counts as done only when this
	 * says so, since destroying the space ends the call that asked for it.
	 */
	async remainingData(): Promise<string[]> {
		const remaining = this.store.remainingData();
		if (this.memory.store.count() > 0) remaining.push("memories");
		const own = new Set([SCHEDULED_TASK_CALLBACK, WATCH_REFRESH_CALLBACK]);
		if ((await this.listSchedules()).some((schedule) => own.has(schedule.callback))) remaining.push("schedules");
		if (Object.keys(this.getMcpServers().servers).length > 0) remaining.push("app connections");
		if (await this.images.any()) remaining.push("images");
		if (await this.artifacts.anyFiles()) remaining.push("artifact files");
		return remaining;
	}

	/** Whether the space is erased, and what of the person's data it still holds; a finished deletion is both. */
	async erasure(): Promise<{ sealed: boolean; remaining: string[] }> {
		return { sealed: this.store.erasedAt() !== null, remaining: await this.remainingData() };
	}

	/**
	 * Erases the space: stops its runs, ends apps' event subscriptions,
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
			await this.nativeApps.revokeAll();
		};
		await Promise.race([courtesy().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ERASE_COURTESY_MS))]);
		// Images and stored files live outside this object's storage, in R2 under the owner's prefix,
		// so they go first, and the browser on the person's computer quits.
		await this.images.deleteAll();
		await this.artifacts.deleteAllFiles();
		await this.browser.quit().catch(() => undefined);
		await this.#removeMachine().catch((error) => console.error("removing the computer's machine", error));
		await this.ctx.storage.deleteAll();
		this.store.markErased(Date.now());
		await this.ctx.storage.sync();
		this.ctx.abort("This space was erased");
	}

	// HTTP API

	async onRequest(request: Request): Promise<Response> {
		// Checked again here, not only in `fetch`: erasure may have begun while the request was on its way in.
		if (this.#closed()) return Response.json({ error: "This space was erased" }, { status: 410 });
		return dispatch(this.#routes, request, new URL(request.url).pathname);
	}

	/** A task as the API shows it: who does it for whom, and how it went. */
	#publicTask(task: Task) {
		const by = (conversation: string) => {
			const { agent } = this.#roleOf(conversation);
			return { id: agent.id, name: agent.name };
		};
		return {
			id: task.id,
			parent: task.parent,
			call: task.call,
			agent: by(task.conversation),
			from: by(task.requester!),
			task: task.task,
			state: task.state,
			result: task.result,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
		};
	}

	/** One of the tasks the work begun in a chat led to; 404 for any other. */
	async #taskOf(session: string, id: string): Promise<Task> {
		const task = this.#tasks.get(id);
		if (!task || task.kind === "review" || task.root !== (await this.#session(session))) throw new HttpError(404, `No task ${id}`);
		return task;
	}

	/** Conversations that aren't the person's chats: deleted ones, tasks', and those agents talk in in rooms. */
	#hiddenSessions(): Set<string> {
		return new Set([...this.store.deletedSessions(), ...this.#tasks.conversations(), ...this.#rooms.conversations()]);
	}

	/** The session a public id names (see `PimStore.publicId`), if it is one of the person's chats. */
	async #session(id: string): Promise<string> {
		const session = this.store.sessionOf(id);
		// The root stays reachable when deleted: it is where API clients talk by default.
		if (session === ROOT_SESSION) return session;
		if (
			session === undefined ||
			this.#hiddenSessions().has(session) ||
			!(await this.harness.sessions.list()).some((candidate) => candidate.id === session)
		) {
			throw new HttpError(404, `No session ${id}`);
		}
		return session;
	}

	/** A chat's public link as its owner sees it, with its address; null without one. */
	#chatLink(session: string) {
		const link = this.chatLinks.of(session);
		return link ? { ...link, url: `${this.deployment().publicUrl}/shared/${this.name}/${link.id}` } : null;
	}

	/** A session's name and activity, under its public id. */
	#sessionInfo(session: string) {
		const info = this.store.sessionInfo(session);
		return info && { ...info, id: this.store.publicId(session) };
	}

	/** A record as it leaves the space: with its session's public id. */
	#publicSession<T extends { readonly session: string | null }>(record: T): T {
		return record.session === null ? record : { ...record, session: this.store.publicId(record.session) };
	}

	/** Notifications carry the look of their chat's agent, but no private instructions or settings. */
	#publicNotification<T extends { readonly session: string | null }>(notification: T) {
		const agent = notification.session !== null && !this.visits.bySession(notification.session) && this.store.sessionInfo(notification.session)
			? this.agents.ofSession(notification.session)
			: null;
		return { ...this.#publicSession(notification), agent: agent ? { id: agent.id, icon: agent.icon, symbol: agent.symbol, color: agent.color } : null };
	}

	/** An artifact as it leaves the space. One a task made belongs to the chat the task began in, where the person can open it beside the chat. */
	#publicArtifact<T extends { readonly session: string | null }>(artifact: T): T {
		const session = artifact.session === null ? null : (this.#tasks.of(artifact.session)?.root ?? artifact.session);
		return this.#publicSession({ ...artifact, session });
	}

	/** An approval as it leaves the space. A guest's conversation is in the guest's own space, so it has none here. */
	#publicApproval(approval: Approval): PublicApproval {
		return {
			...approval,
			session: approval.requestedBy ? null : this.store.publicId(approval.session),
			member: approval.member && { ...approval.member, session: this.store.publicId(approval.member.session) },
		};
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

	/**
	 * The window a chat (`?session=`, the root chat without one) shows in
	 * the browser: its own, or that of a task it handed out, whichever was
	 * used last, so the person sees, and takes over, where work is going on.
	 */
	async #browserWindow(url: URL): Promise<string> {
		const requested = url.searchParams.get("session");
		const chat = requested ? await this.#session(requested) : ROOT_SESSION;
		return this.browser.lastUsed([chat, ...this.#tasks.ofRoot(chat).map((task) => task.conversation)]);
	}

	/** The window an agent's conversation browses in: in a group chat, the chat's, which its agents share. */
	#browserWindowOf(conversation: string): string {
		return this.#rooms.of(conversation)?.room ?? conversation;
	}

	/** The browser, or 404 while the person has no computer for it to run on. */
	#browserIn(): PimBrowser {
		if (!this.browser.available) throw new HttpError(404, "This space has no browser: connect a computer in Settings → Computer");
		return this.browser;
	}

	#artifact(id: string) {
		const artifact = ARTIFACT_ID.test(id) ? this.artifacts.get(id) : undefined;
		if (!artifact) throw new HttpError(404, `No artifact ${id}`);
		return artifact;
	}

	/**
	 * An app tool an artifact may call, by its pi name: one the owner lets
	 * run without asking. A tool that asks first can't be used from an
	 * artifact, since nothing there could show the person what it's about to do.
	 */
	#artifactTool(name: unknown) {
		const servers = new Map(this.apps.servers().map((server) => [server.id, server]));
		for (const tool of this.apps.tools()) {
			const server = servers.get(tool.serverId);
			if (!server || toolName(server.id, tool.name) !== name) continue;
			if (server.state !== "ready") throw new HttpError(503, `${server.name} isn't connected right now.`);
			if (appToolPermission(this.store, server, tool).permission !== "on") {
				throw new HttpError(403, `${server.name}'s ${tool.name} asks you before it runs, or is off, so an artifact can't use it.`);
			}
			return { server, tool, label: `${server.name}: ${tool.annotations?.title ?? tool.name}` };
		}
		throw new HttpError(404, `No app tool ${String(name)}`);
	}

	/**
	 * One call an artifact made through the bridge, as the app relays it,
	 * for the person this space is: on their own artifact, or one shared with
	 * them, which this space knows by `key` (its own artifact's id, or
	 * `<host>/<id>`). What it keeps for them (`storage`) and needs no
	 * permission is kept here; the model and app tools are theirs too, and
	 * need their permission, given to this version (`needs` asks for it).
	 * What everyone using it sees (`shared`) is the artifact owner's,
	 * reached through `shared`.
	 */
	async #artifactBridge(
		key: string,
		sha: string,
		op: unknown,
		args: Record<string, unknown>,
		shared: (op: string, args: Record<string, unknown>) => Promise<unknown>,
	): Promise<{ value: unknown } | { needs: { capability: string; label: string } }> {
		if (typeof op === "string" && op.startsWith("shared.")) return { value: await shared(op, args) };
		switch (op) {
			case "storage.get":
			case "storage.list":
			case "storage.set":
			case "storage.delete":
				return { value: this.#artifactData(key, "own", op, args) };
			case "model.ask": {
				const prompt = args.prompt;
				if (typeof prompt !== "string" || prompt.trim() === "") throw new HttpError(400, "pim.ask needs a prompt");
				if (prompt.length > 20_000) throw new HttpError(413, "A prompt can be at most 20,000 characters");
				if (!this.artifacts.granted(key, sha, "model")) return { needs: { capability: "model", label: "model" } };
				return { value: await this.utility(ARTIFACT_ASK, prompt) };
			}
			case "tools.call": {
				const { server, tool, label } = this.#artifactTool(args.name);
				const capability = `tool:${toolName(server.id, tool.name)}`;
				if (!this.artifacts.granted(key, sha, capability)) return { needs: { capability, label } };
				const input = args.input ?? {};
				if (typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "A tool's input must be an object");
				this.#assertOpen();
				const result = await this.apps.call(server.id, tool.name, input as Record<string, unknown>);
				if (result.isError) throw new HttpError(502, toText(result));
				return { value: toText(result) };
			}
			default:
				throw new HttpError(400, `There is no pim.${String(op)}`);
		}
	}

	/** A storage call (`storage.get`, `shared.set`, ...) on what an artifact keeps here, in a scope. */
	#artifactData(key: string, scope: DataScope, op: string, args: Record<string, unknown>): unknown {
		switch (op.slice(op.indexOf(".") + 1)) {
			case "get":
				return this.artifacts.dataGet(key, scope, args.key as string);
			case "list":
				return this.artifacts.dataKeys(key, scope, typeof args.prefix === "string" ? args.prefix : "");
			case "set":
				this.#assertOpen();
				this.artifacts.dataSet(key, scope, args.key as string, args.value as string);
				return null;
			case "delete":
				this.#assertOpen();
				this.artifacts.dataDelete(key, scope, args.key as string);
				return null;
			default:
				throw new HttpError(400, `There is no pim.${op}`);
		}
	}

	/** Lets the person use `capability` from a version of an artifact, by the key this space knows it by. */
	#grantArtifact(key: string, sha: string, capability: unknown): string {
		if (capability !== "model") {
			if (typeof capability !== "string" || !capability.startsWith("tool:")) throw new HttpError(400, "capability must be model or tool:<name>");
			this.#artifactTool(capability.slice("tool:".length));
		}
		this.#assertOpen();
		this.artifacts.grant(key, sha, capability);
		return capability;
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
				rootSession: this.store.publicId(ROOT_SESSION),
				tools: this.tools(),
			}),
		],
		// This space as an MCP server, for MCP clients such as Claude or ChatGPT.
		...(["POST", "GET", "DELETE"] as const).map((method): Route => [method, MCP_SERVER_PATH, (_params, request) => this.#mcpServer(request)]),

		// Sessions: separate conversations, each with its own transcript and runs.
		[
			"GET",
			"/sessions",
			async () => {
				const hidden = this.#hiddenSessions();
				const archiveBefore = Date.now() - ARCHIVE_AFTER_MS;
				// A run held for the person to try again isn't at work.
				const held = await this.#heldSessions();
				const heldErrors = await this.#heldErrors(held);
				const all = (await this.harness.sessions.list()).map((session) => ({ ...session, busy: session.busy && !held.has(session.id) }));
				const busy = new Set(all.flatMap((session) => (session.busy ? [session.id] : [])));
				const sessions = all.filter((session) => !hidden.has(session.id)).map((session) => {
					const info = this.store.sessionInfo(session.id);
					const visit = this.visits.bySession(session.id);
					const unread = info?.unread ?? false;
					return {
						id: this.store.publicId(session.id),
						busy: session.busy,
						held: held.has(session.id),
						title: info?.title ?? null,
						createdAt: info?.createdAt ?? null,
						updatedAt: info?.updatedAt ?? null,
						responseAt: info?.responseAt ?? null,
						unread,
						// A chat still working, or with a reply not yet read, stays in the list however old it is.
						archived: info?.archivedAt != null || (!session.busy && !unread && info !== undefined && info.updatedAt < archiveBefore),
						visit: visit ? { username: visit.username, available: !visit.revoked } : null,
						agent: this.#agentRef(session.id),
						room: this.#roomInfo(session.id, busy, heldErrors),
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
				return { ...this.#sessionInfo(id), agent: this.#agentRef(id) };
			},
		],
		[
			"POST",
			"/sessions/:session/read",
			async ({ session }, request) => {
				const id = await this.#session(session!);
				const { responseAt } = await readJson<{ responseAt: number }>(request);
				if (typeof responseAt !== "number" || !Number.isSafeInteger(responseAt) || responseAt < 0) throw new HttpError(400, "responseAt must be a non-negative integer");
				this.store.readSession(id, responseAt);
				if (!this.store.sessionInfo(id)?.unread) this.store.readMentions(id);
				this.broadcastMessage({ type: "sessions" });
				return this.#sessionInfo(id);
			},
		],
		[
			"POST",
			"/sessions/:session/archive",
			async ({ session }) => {
				const id = await this.#session(session!);
				this.store.archiveSession(id);
				this.broadcastMessage({ type: "sessions" });
				return this.#sessionInfo(id);
			},
		],
		[
			"POST",
			"/sessions/:session/unarchive",
			async ({ session }) => {
				const id = await this.#session(session!);
				this.store.unarchiveSession(id);
				this.broadcastMessage({ type: "sessions" });
				return this.#sessionInfo(id);
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
				return this.#sessionInfo(id);
			},
		],
		// How the agents in a group chat take turns (./rooms.ts).
		[
			"PUT",
			"/sessions/:session/room",
			async ({ session }, request) => {
				const id = await this.#session(session!);
				const { mode } = await readJson<{ mode: RoomMode }>(request);
				if (mode !== "mentions" && mode !== "open") throw new HttpError(400, "mode must be mentions or open");
				if (!this.#roomable(id)) throw new HttpError(400, "Only a chat with your own agents can be a group chat");
				this.#rooms.open(id, this.agents.ofSession(id).id);
				this.#rooms.setMode(id, mode);
				this.broadcastMessage({ type: "sessions" });
				return { room: await this.#roomOf(id) };
			},
		],
		[
			"POST",
			"/sessions/:session/room/members",
			async ({ session }, request) => {
				const id = await this.#session(session!);
				const { agent } = await readJson<{ agent: string }>(request);
				const joining = typeof agent === "string" ? this.agents.get(agent) : undefined;
				if (!joining) throw new HttpError(404, "No such agent");
				if (!this.#roomable(id)) throw new HttpError(400, "Only a chat with your own agents can be a group chat");
				if (joining.id !== this.agents.ofSession(id).id) await this.#join(id, joining);
				return { room: await this.#roomOf(id) };
			},
		],
		[
			"DELETE",
			"/sessions/:session/room/members/:agent",
			async ({ session, agent }) => {
				const id = await this.#session(session!);
				const seat = this.#rooms.at(id, agent!);
				if (!seat || seat.conversation === id) throw new HttpError(404, "No such agent in this chat besides its host");
				await this.#leave(seat);
				return { room: await this.#roomOf(id) };
			},
		],
		// Asks an agent of a group chat again, whose run is held after a model error; the host has its own Try again.
		[
			"POST",
			"/sessions/:session/room/members/:agent/retry",
			async ({ session, agent }) => {
				const id = await this.#session(session!);
				const seat = this.#rooms.at(id, agent!);
				if (!seat || seat.conversation === id) throw new HttpError(404, "No such agent in this chat besides its host");
				if (!(await this.#resumeHeld(seat.conversation))) throw new HttpError(409, "This agent isn't waiting to try again");
				this.broadcastMessage({ type: "sessions" });
				return { room: await this.#roomOf(id) };
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
				return this.#sessionInfo(id);
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
		// Public links to chats (./chat-links.ts): a copy of the chat as it is now, for anyone with the link.
		["GET", "/sessions/:session/link", async ({ session }) => ({ link: this.#chatLink(await this.#session(session!)) })],
		[
			"PUT",
			"/sessions/:session/link",
			async ({ session }) => {
				const id = await this.#session(session!);
				if (this.visits.bySession(id)) throw new HttpError(400, "A chat with someone else's agent can't have a public link");
				const agent = this.agents.ofSession(id);
				const chat: SharedChat = {
					title: this.store.sessionInfo(id)?.title ?? null,
					agent: { name: agent.name, symbol: agent.symbol, color: agent.color },
					sharedAt: Date.now(),
					messages: sharedMessages(await this.harness.session(id).messages()),
				};
				if (chat.messages.length === 0) throw new HttpError(409, "This chat has nothing to share yet");
				if (new TextEncoder().encode(JSON.stringify(chat)).byteLength > MAX_SHARED_BYTES) throw new HttpError(413, "This chat is too long for a public link");
				this.#assertOpen();
				this.chatLinks.save(id, chat);
				return { link: this.#chatLink(id) };
			},
		],
		["DELETE", "/sessions/:session/link", async ({ session }) => ({ deleted: this.chatLinks.delete(await this.#session(session!)) })],
		// What a chat's link shows. The Worker serves it to anyone who has the link, with no token.
		[
			"GET",
			"/shared/:link",
			({ link }) => {
				const chat = LINK_ID.test(link!) ? this.chatLinks.chat(link!) : undefined;
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
				return { text: await this.utility(IMPROVE_PROMPT, text) };
			},
		],
		[
			"DELETE",
			"/sessions/:session",
			async ({ session }) => {
				const id = await this.#session(session!);
				this.store.deleteSession(id);
				this.chatLinks.delete(id);
				await this.images.deleteSession(id);
				const visit = this.visits.bySession(id);
				if (visit) this.visits.setSession(visit.ownerId, null);
				// Nothing keeps working in a chat the user can no longer see, nor in the tasks it handed out, nor do the other agents in it.
				for (const seat of this.#rooms.seats(id).filter((seat) => seat.conversation !== id)) {
					await this.harness.session(seat.conversation).abort();
					for (const task of this.#tasks.byRequester(seat.conversation)) await this.#cancelTask(task, "Its chat was deleted.");
				}
				await this.harness.session(id).abort();
				for (const task of this.#tasks.byRequester(id)) await this.#cancelTask(task, "Its chat was deleted.");
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
		["GET", "/sessions/:session/cost", async ({ session }) => sessionCost(await this.harness.session(await this.#session(session!)).messages())],
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
				if (!body.wait) return Response.json({ ...receipt, session }, { status: 202 });
				return { ...(await this.#withReplies(await this.harness.wait(receipt.operationId, { session: id }))), session };
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
					return { ...(await this.#withReplies(await this.harness.wait(operation!, { session: id, signal }))), session };
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
			async ({ session }) => ({ tasks: this.#tasks.ofRoot(await this.#session(session!)).map((task) => this.#publicTask(task)) }),
		],
		[
			"GET",
			"/sessions/:session/tasks/:task",
			async ({ session, task: id }) => {
				const task = await this.#taskOf(session!, id!);
				return { ...this.#publicTask(task), messages: projectEntries(await this.harness.session(task.conversation).messages()) };
			},
		],
		[
			"POST",
			"/sessions/:session/tasks/:task/cancel",
			async ({ session, task: id }) => {
				const task = await this.#taskOf(session!, id!);
				await this.#cancelTask(task, "The person canceled it.");
				return this.#publicTask(this.#tasks.get(task.id)!);
			},
		],
		// Asks the model again in a chat held after a model error, picking up where it stopped, with whatever model the agent has now.
		[
			"POST",
			"/sessions/:session/retry",
			async ({ session }) => {
				const id = await this.#session(session!);
				if (!(await this.#resumeHeld(id))) throw new HttpError(409, "This chat isn't waiting to try again");
				this.broadcastMessage({ type: "sessions" });
				return { session };
			},
		],
		[
			"POST",
			"/sessions/:session/abort",
			async ({ session }, request) => {
				const id = await this.#session(session!);
				const { operationId } = await readJson<{ operationId: string }>(request);
				// Stopping a group chat stops every agent at work in it.
				let others = false;
				if (operationId === undefined) {
					for (const seat of this.#rooms.seats(id).filter((seat) => seat.conversation !== id)) others = (await this.harness.session(seat.conversation).abort()) || others;
				}
				return { aborted: (await this.harness.session(id).abort(operationId)) || others };
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
					if (!this.#hasWorkersAi()) throw new Error("This Pim has no Workers AI");
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
				await this.#refreshCustomApps(true);
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
				const platform = this.#hasWorkersAi() ? (this.#allowedModels() ?? []).filter((id) => id !== fallback.id).map((id) => this.ai(id)) : [];
				const providers = this.customProviders();
				const custom = providers.flatMap(({ catalogId, provider }) => provider.models.flatMap((model) => this.modelCatalog().getModel(catalogId, model.id) ?? []));
				// Without Workers AI the default is a provider's model, already among `custom`, or nothing to choose.
				const choices = [...(this.#hasWorkersAi() ? [fallback] : []), ...platform, ...chatgptModels, ...custom];
				const utilityDefault = this.defaultUtilityModel();
				const utility = await this.utilityModel();
				// Only models that can answer in a JSON schema, for the jobs that need one.
				const utilityChoices = [...(utilityDefault ? [utilityDefault] : []), ...[...chatgptModels, ...custom].filter((model) => this.#utilityProvider(model.provider) && !(utilityDefault && sameModel(model, utilityDefault)))];
				return {
					model: describeModel(this.chosenModel()),
					default: describeModel(fallback),
					choices: choices.map(describeModel),
					workersAi: this.#hasWorkersAi(),
					// The model for side jobs (./utility.ts); null when there is none.
					utility: {
						model: utility ? describeModel(utility) : null,
						default: utilityDefault ? describeModel(utilityDefault) : null,
						choices: utilityChoices.map(describeModel),
					},
					chatgpt: { ...chatgpt, error: chatgptError },
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
					if (!this.#utilityProvider(model.provider)) {
						throw new HttpError(400, "That model can't be the utility model: its provider isn't known to answer in a JSON schema. For a custom endpoint, say in its settings that it does.");
					}
					this.store.setMeta(UTILITY_MODEL_KEY, JSON.stringify({ provider: model.provider, id: model.id }));
				}
				const model = await this.utilityModel();
				return { model: model ? describeModel(model) : null };
			},
		],
		// The person's own model providers (./providers.ts); the admin's are under /api/admin/providers.
		["GET", "/providers/built-in", async () => ({ providers: await builtinProviders() })],
		[
			"POST",
			"/providers",
			async (_params, request) => ({ provider: providerInfo(await this.#putOwnProvider(null, await readJson<ProviderInput>(request))) }),
		],
		[
			"PUT",
			"/providers/:id",
			async ({ id }, request) => ({ provider: providerInfo(await this.#putOwnProvider(id!, await readJson<ProviderInput>(request))) }),
		],
		[
			"DELETE",
			"/providers/:id",
			async ({ id }) => {
				const providers = JSON.parse(this.store.meta(OWN_PROVIDERS_KEY) ?? "[]") as CustomProvider[];
				if (!providers.some((provider) => provider.id === id)) throw new HttpError(404, `No provider ${id}`);
				this.store.setMeta(OWN_PROVIDERS_KEY, JSON.stringify(providers.filter((provider) => provider.id !== id)));
				await this.#providersChanged();
				return { deleted: true };
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
		["GET", "/artifacts", (_params, _request, url) => this.#artifactRequest(url, () => noStore({ artifacts: this.artifacts.list().map((artifact) => this.#publicArtifact(artifact)), bytes: this.artifacts.totalBytes() }))],
		[
			"GET",
			"/artifacts/:id",
			({ id }, _request, url) =>
				this.#artifactRequest(url, () => {
					const artifact = this.#artifact(id!);
					return noStore({ ...this.#publicArtifact(artifact), history: this.artifacts.versions(artifact.id), circles: this.artifacts.circlesOf(artifact.id) });
				}),
		],
		[
			"DELETE",
			"/artifacts/:id",
			({ id }, _request, url) =>
				this.#artifactRequest(url, async () => {
					this.#assertOpen();
					const artifact = this.#artifact(id!);
					await this.artifacts.delete(artifact.id);
					return noStore({ deleted: true });
				}),
		],
		[
			"POST",
			"/artifacts/:id/versions",
			({ id }, request, url) =>
				this.#artifactRequest(url, async () => {
					const artifact = this.#artifact(id!);
					const { baseVersion, content, title, path } = await readJson<{ baseVersion: number; content: string; title: string; path: string }>(request);
					if (!Number.isSafeInteger(baseVersion)) throw new HttpError(400, "baseVersion must be a version number");
					if (typeof content !== "string") throw new HttpError(400, "content must be a string");
					const file = path === undefined ? ENTRY_FILES[artifact.kind] : checkPath(path);
					// Checked with the version's other files, when it's based on the latest; append refuses it otherwise.
					if (baseVersion === artifact.version) {
						const files = new Map(await this.artifacts.read(artifact.id, artifact.version));
						if (path !== undefined && !files.has(file)) throw new HttpError(404, `Version ${artifact.version} has no file ${file}`);
						files.set(file, { type: fileType(file), bytes: new TextEncoder().encode(content) });
						checkFiles(artifact.kind, files);
					}
					const name = title === undefined ? undefined : checkTitle(title);
					this.#assertOpen();
					const { version, changed } = await this.artifacts.append(artifact.id, {
						baseVersion: baseVersion!,
						files: { [file]: content },
						source: "person",
						...(name !== undefined ? { title: name } : {}),
					});
					return noStore({ ...this.#publicSession(this.artifacts.get(artifact.id)!), saved: version.version, changed }, changed ? 201 : 200);
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
					return noStore({ ...this.#publicSession(this.artifacts.get(artifact.id)!), restored: restored.version }, 201);
				}),
		],
		[
			"GET",
			"/artifacts/:id/versions/:version",
			({ id, version }, _request, url) =>
				this.#artifactRequest(url, async () => {
					const { artifact, found } = this.#artifactVersion(id!, version!);
					const path = url.searchParams.get("path") ?? ENTRY_FILES[artifact.kind];
					const file = found.files.find((candidate) => candidate.path === path);
					if (!file) throw new HttpError(404, `Version ${found.version} has no file ${path}`);
					// Only text is sent as content: anything else, the file's download has.
					const content = isTextType(file.type) ? await this.artifacts.text(artifact.id, found.version, path) : null;
					return noStore({ id: artifact.id, title: artifact.title, kind: artifact.kind, latest: artifact.version, ...found, path, content });
				}),
		],
		[
			"GET",
			"/artifacts/:id/versions/:version/frame",
			({ id, version }, _request, url) =>
				this.#artifactRequest(url, async () => {
					const { artifact, found } = this.#artifactVersion(id!, version!);
					// A dashboard shows an artifact's widget, a page of its own (`?view=widget`).
					const widget = url.searchParams.get("view") === "widget";
					return framePage(artifact.kind, await this.artifacts.read(artifact.id, found.version), url.origin, { widget });
				}),
		],
		[
			"POST",
			"/artifacts/:id/versions/:version/bridge",
			({ id, version }, request, url) =>
				this.#artifactRequest(url, async () => {
					const { artifact, found } = this.#artifactVersion(id!, version!);
					const { op, args } = await readJson<{ op: string; args: Record<string, unknown> }>(request);
					const shared = async (call: string, input: Record<string, unknown>) => this.#artifactData(artifact.id, "shared", call, input);
					return noStore(await this.#artifactBridge(artifact.id, found.sha256, op, args && typeof args === "object" ? args : {}, shared));
				}),
		],
		[
			"POST",
			"/artifacts/:id/versions/:version/grants",
			({ id, version }, request, url) =>
				this.#artifactRequest(url, async () => {
					const { artifact, found } = this.#artifactVersion(id!, version!);
					const { capability } = await readJson<{ capability: string }>(request);
					return noStore({ granted: this.#grantArtifact(artifact.id, found.sha256, capability) }, 201);
				}),
		],
		[
			"PUT",
			"/artifacts/:id/circles",
			({ id }, request, url) =>
				this.#artifactRequest(url, async () => {
					const artifact = this.#artifact(id!);
					const { circles } = await readJson<{ circles: string[] }>(request);
					if (!Array.isArray(circles)) throw new HttpError(400, "circles must be a list of circle ids");
					for (const circle of circles) this.#circle(String(circle));
					this.#assertOpen();
					this.artifacts.setCircles(artifact.id, circles.map(String));
					return noStore({ ...this.#publicSession(this.artifacts.get(artifact.id)!), circles: this.artifacts.circlesOf(artifact.id) });
				}),
		],
		// Artifacts others shared with this person, from their spaces, which check each request.
		[
			"GET",
			"/shared-artifacts",
			(_params, _request, url) =>
				this.#artifactRequest(url, async () => {
					const me = this.#me();
					const shared = [];
					for (const share of this.visits.shares().filter((candidate) => !candidate.revoked)) {
						if (me === null) break;
						try {
							const found = await (await this.#pimOf(share.ownerId)).guestArtifacts(me);
							if (found.ok) shared.push(...found.artifacts.map((artifact) => ({ ...artifact, host: share.username })));
						} catch (error) {
							console.warn(`listing ${share.username}'s shared artifacts failed`, error);
						}
					}
					return noStore({ artifacts: shared.sort((a, b) => b.updatedAt - a.updatedAt) });
				}),
		],
		[
			"GET",
			"/shared-artifacts/:host/:id",
			({ host, id }, _request, url) =>
				this.#artifactRequest(url, async () => {
					const { artifact } = await this.#othersArtifact(host!, id!);
					return noStore({ ...artifact, host });
				}),
		],
		[
			"GET",
			"/shared-artifacts/:host/:id/versions/:version",
			({ host, id, version }, _request, url) =>
				this.#artifactRequest(url, async () => {
					const { artifact, files, load } = await this.#othersArtifact(host!, id!, version!);
					const content = fileText((await load()).get(ENTRY_FILES[artifact.kind])!.bytes);
					return noStore({ id: artifact.id, title: artifact.title, kind: artifact.kind, latest: artifact.version, version: artifact.version, sha256: artifact.sha256, size: artifact.size, files, content });
				}),
		],
		[
			"GET",
			"/shared-artifacts/:host/:id/versions/:version/frame",
			({ host, id, version }, _request, url) =>
				this.#artifactRequest(url, async () => {
					const { artifact, load } = await this.#othersArtifact(host!, id!, version!);
					return framePage(artifact.kind, await load(), url.origin);
				}),
		],
		[
			"POST",
			"/shared-artifacts/:host/:id/versions/:version/bridge",
			({ host, id, version }, request, url) =>
				this.#artifactRequest(url, async () => {
					const found = await this.#othersArtifact(host!, id!, version!);
					const { op, args } = await readJson<{ op: string; args: Record<string, unknown> }>(request);
					const shared = async (call: string, input: Record<string, unknown>) => {
						const answer = (await found.host.guestArtifactShared(found.me, found.artifact.id, { op: call, args: input })) as
							| { ok: true; value: unknown }
							| { ok: false; status: number; reason: string };
						if (answer.ok) return answer.value;
						throw new HttpError(answer.status, answer.reason);
					};
					return noStore(await this.#artifactBridge(found.key, found.artifact.sha256, op, args && typeof args === "object" ? args : {}, shared));
				}),
		],
		[
			"POST",
			"/shared-artifacts/:host/:id/versions/:version/grants",
			({ host, id, version }, request, url) =>
				this.#artifactRequest(url, async () => {
					const found = await this.#othersArtifact(host!, id!, version!);
					const { capability } = await readJson<{ capability: string }>(request);
					return noStore({ granted: this.#grantArtifact(found.key, found.artifact.sha256, capability) }, 201);
				}),
		],
		[
			"GET",
			"/artifacts/:id/versions/:version/download",
			({ id, version }, _request, url) =>
				this.#artifactRequest(url, async () => {
					const { artifact, found } = this.#artifactVersion(id!, version!);
					const path = url.searchParams.get("path") ?? ENTRY_FILES[artifact.kind];
					const file = found.files.find((candidate) => candidate.path === path);
					if (!file) throw new HttpError(404, `Version ${found.version} has no file ${path}`);
					// Plain text, whatever the kind, or bytes to save: the file is for saving, and a browser that
					// shows it anyway shows its source, still under the sandbox. Its name keeps the extension.
					const headers = artifactHeaders(url.origin, isTextType(file.type) ? "text/plain; charset=utf-8" : "application/octet-stream");
					const { ascii, utf8 } = downloadName(artifact.title, found.version, artifact.kind, path === ENTRY_FILES[artifact.kind] ? undefined : path);
					headers.set("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`);
					return new Response((await this.artifacts.read(artifact.id, found.version, [path])).get(path)!.bytes, { headers });
				}),
		],
		// The person's computer (see ./computer.ts): whether one is connected, and pairing or removing their own.
		// Where this Pim has a computer host, the space's computer is the one it keeps, asked for the first time it's looked at.
		[
			"GET",
			"/computer",
			async () => {
				if (!this.computer.paired() && !this.#closed() && (await this.#directory().hasComputerHost())) await this.#provideComputer();
				return noStore(this.computer.status());
			},
		],
		[
			"POST",
			"/computer",
			async (_params, request) => {
				this.#assertOpen();
				const body = await request.text();
				const { managed } = (body ? JSON.parse(body) : {}) as { managed?: unknown };
				// Asking for the host's computer again sets it up again, as after it failed to be.
				if (managed === true) {
					if (!(await this.#directory().hasComputerHost())) throw new HttpError(404, "This Pim has no computer host to keep a computer for you. Connect one of your own.");
					await this.#provideComputer();
					return noStore(this.computer.status(), 201);
				}
				if (this.computer.machine() || (await this.#directory().hasComputerHost())) {
					throw new HttpError(409, "This Pim keeps a computer for you, so you can't connect another.");
				}
				const token = await this.computer.pair(this.name, Date.now());
				this.#computerChanged();
				return noStore({ ...this.computer.status(), token }, 201);
			},
		],
		[
			"DELETE",
			"/computer",
			async () => {
				if (this.computer.machine()) throw new HttpError(409, "This Pim keeps this computer for you for as long as you're here: it can't be removed.");
				this.computer.forget();
				this.#computerChanged();
				return noStore(this.computer.status());
			},
		],
		// Files: the person's, on their computer, which their agents read and write too (see ./files.ts).
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
					// Files are on the person's computer, so they don't count toward the space's storage.
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
		// The agents' browser (see ./browser.ts): what a chat's window shows, a picture of it, closing it. Taking it over is a socket.
		[
			"GET",
			"/browser",
			async (_params, _request, url) =>
				noStore({ available: this.browser.available, page: this.browser.available ? await this.browser.current(await this.#browserWindow(url)) : null }),
		],
		[
			"GET",
			"/browser/screenshot",
			async (_params, _request, url) => {
				const png = await this.#browserIn().screenshot(await this.#browserWindow(url));
				if (!png) throw new HttpError(404, "The browser is closed");
				return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-store, private", "x-content-type-options": "nosniff" } });
			},
		],
		[
			"DELETE",
			"/browser",
			async (_params, _request, url) => {
				await this.#browserIn().close(await this.#browserWindow(url));
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
				this.#dropModels(({ provider }) => provider === CHATGPT_PROVIDER);
				if (this.chosenModel().provider === CHATGPT_PROVIDER) await this.chooseModel(null);
				else await this.#syncModels();
				return this.chatgpt.status();
			},
		],

		// Long-term memory: what the agents know about the person, in scopes that different agents read. They can always make it forget.
		[
			"GET",
			"/memory",
			() => ({
				count: this.memory.store.count(),
				pendingCompressions: this.memory.store.pending().length,
				// The majordomo's view: every scope.
				view: this.memory.view(this.#memoryAccess(this.agents.majordomo()).read),
				scopes: this.memoryScopes(),
			}),
		],
		[
			"GET",
			"/memory/log",
			(_params, _request, url) => {
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
				const scope = url.searchParams.get("scope");
				const scopes = scope === null ? undefined : [this.#memoryScope(scope).key];
				const pattern = url.searchParams.get("q");
				if (pattern !== null) {
					let regex: RegExp;
					try {
						regex = new RegExp(pattern, "i");
					} catch (error) {
						throw new HttpError(400, errorMessage(error));
					}
					return this.memory.store.search(regex, limit, scopes);
				}
				const before = url.searchParams.get("before");
				return { entries: this.memory.store.page(limit, before === null ? undefined : Number(before), scopes) };
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
				const entry = this.memory.store.append(line, this.memory.today(), { scope: scope === undefined ? PRIVATE_SCOPE : this.#memoryScope(scope).key });
				await this.startMemoryNap();
				return Response.json(entry, { status: 201 });
			},
		],
		[
			"PUT",
			"/memory/log/:id",
			async ({ id }, request) => {
				// Moving a memory to another scope: it gets a new id there.
				const { scope } = await readJson<{ scope: string }>(request);
				const entry = /^\d+$/.test(id!) ? this.memory.store.entry(Number(id)) : undefined;
				if (!entry) throw new HttpError(404, `No memory ${id}`);
				if (typeof scope !== "string") throw new HttpError(400, "scope must be a memory scope's key");
				const target = this.#memoryScope(scope).key;
				if (entry.forgotten) throw new HttpError(409, `Memory ${id} was forgotten`);
				if (target === entry.scope) return entry;
				const moved = this.memory.store.move(entry.id, target);
				await this.startMemoryNap();
				return moved;
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
			"/memory/tree/:scope/:block",
			({ scope, block: name }) => {
				const block = parseBlock(name!);
				if (!block) throw new HttpError(400, `${name} is not a block, like 16-31`);
				if (block[0] >= this.memory.store.size(scope!)) throw new HttpError(404, `No memories in ${scope}/${name}`);
				return {
					block: blockName(block),
					summary: this.memory.store.summary(scope!, block) ?? null,
					halves: halves(block).map((half) => {
						if (half[1] - half[0] > 1) return { block: blockName(half), summary: this.memory.store.summary(scope!, half) ?? null };
						const entry = this.memory.store.at(scope!, half[0]);
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
				const dropped = this.memory.store.dropSummary(scope!, block);
				if (dropped === 0) throw new HttpError(404, `No summary ${scope}/${name}`);
				await this.startMemoryNap();
				return { dropped };
			},
		],
		// Named memory scopes: ones the person makes, such as Work, for the agents and circles they choose.
		[
			"POST",
			"/memory/scopes",
			async (_params, request) => {
				const name = scopeName((await readJson<{ name: string }>(request)).name);
				if (this.memory.store.namedScopes().length >= MAX_NAMED_SCOPES) throw new HttpError(429, `You can have up to ${MAX_NAMED_SCOPES} named memory scopes.`);
				const { key } = this.memory.store.createScope(name);
				return Response.json(this.#memoryScope(key), { status: 201 });
			},
		],
		[
			"PUT",
			"/memory/scopes/:key",
			async ({ key }, request) => {
				if (this.#memoryScope(key!).kind !== "named") throw new HttpError(400, "Only a scope you named can be renamed");
				this.memory.store.renameScope(key!, scopeName((await readJson<{ name: string }>(request)).name));
				return this.#memoryScope(key!);
			},
		],
		[
			"DELETE",
			"/memory/scopes/:key",
			async ({ key }) => {
				// Its memories stay, and only the majordomo reads them, until the person moves or forgets them.
				if (this.#memoryScope(key!).kind !== "named") throw new HttpError(400, "Only a scope you named can be deleted");
				this.memory.store.deleteScope(key!);
				this.agents.dropMemoryScope(key!);
				this.circles.dropMemoryScope(key!);
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
				return { goals: this.store.goals(status === null ? undefined : (status as GoalStatus)).map((goal) => this.#publicSession(goal)) };
			},
		],
		[
			"GET",
			"/goals/:id",
			({ id }) => {
				const goal = this.store.goal(id!);
				if (!goal) throw new HttpError(404, `No goal ${id}`);
				return this.#publicSession(goal);
			},
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
			async () => ({ schedules: (await this.services().listSchedules()).map((schedule) => describeSchedule(schedule, this.store)) }),
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
				return { approvals: this.store.approvals((status ?? undefined) as Approval["status"] | undefined).map((approval) => this.#publicApproval(approval)) };
			},
		],
		[
			"GET",
			"/approvals/:id",
			({ id }) => {
				const approval = this.store.approval(id!);
				if (!approval) throw new HttpError(404, `No approval ${id}`);
				return this.#publicApproval(approval);
			},
		],
		[
			"GET",
			"/approvals/:id/icon",
			async ({ id }) => {
				const approval = this.store.approval(id!);
				if (approval?.action !== UPDATE_AGENT) throw new HttpError(404, `No approval ${id} with an icon`);
				const { type, bytes } = await requestedIcon(approval.args, this.files);
				return new Response(bytes, { headers: { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" } });
			},
		],
		[
			"POST",
			"/approvals/:id/approve",
			async ({ id }, request) => {
				if (this.store.approval(id!)?.action === ADD_CUSTOM_APP && request.headers.get(SIGNED_IN_HEADER) !== "1") {
					throw new HttpError(403, "Adding an app to this Pim needs you signed in to the app.");
				}
				const { note, always } = await readJson<{ note: string; always: boolean }>(request);
				const given = typeof note === "string" ? note : undefined;
				return this.#publicApproval(always === true ? await this.alwaysApprove(id!, given) : await this.decideApproval(id!, "approve", given));
			},
		],
		[
			"POST",
			"/approvals/:id/deny",
			async ({ id }, request) => {
				const { note } = await readJson<{ note: string }>(request);
				return this.#publicApproval(await this.decideApproval(id!, "deny", typeof note === "string" ? note : undefined));
			},
		],
		// Tool permissions: which tools Pim may use, and which ask first.
		[
			"GET",
			"/permissions",
			(_params, _request, url) => {
				// One of the owner's agents: the switches of its apps' tools, and its switch for skills.
				const agent = url.searchParams.get("agent");
				if (agent !== null) {
					const found = this.#agent(agent);
					return { tools: this.agentToolPermissions(found), skills: this.agentSkillsPermission(found) };
				}
				const circle = url.searchParams.get("circle");
				if (circle !== null) this.#circle(circle);
				return { tools: this.toolPermissions(circle ?? OWNER) };
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
					if (typeof app !== "string" || typeof tool !== "string") throw new HttpError(400, "app and tool name an app's tool");
					if (permission !== null && permission !== "on" && permission !== "off") throw new HttpError(400, "permission must be on, off, or null for the default");
					return this.setAgentToolPermission(this.#agent(agent), app, tool, permission);
				}
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
		[
			"GET",
			"/majordomo",
			() => {
				const agent = this.agents.majordomo();
				return { agent, introduced: this.agents.introduced(), preferences: majordomoPreferences(agent.instructions), yourName: this.store.meta(PERSON_NAME_KEY) ?? null };
			},
		],
		[
			"PUT",
			"/majordomo/preferences",
			async (_params, request) => {
				// How it talks and how much it handles on its own, as at setup: lines of its instructions, in place of those it had.
				const majordomo = this.agents.majordomo();
				const instructions = withPreferences(majordomo.instructions, await readJson<Record<string, unknown>>(request));
				const agent = this.agents.update(majordomo.id, agentInput({ instructions }, majordomo));
				return { agent, introduced: this.agents.introduced(), preferences: majordomoPreferences(agent.instructions), yourName: this.store.meta(PERSON_NAME_KEY) ?? null };
			},
		],
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
				if (setup.yourName) this.store.setMeta(PERSON_NAME_KEY, setup.yourName);
				const memories = setupMemories(setup);
				for (const { text, everyone } of memories) this.memory.store.append(text, this.memory.today(), { scope: everyone ? EVERYONE_SCOPE : PRIVATE_SCOPE });
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
				return { agent: this.agents.majordomo(), introduced: true, session: this.store.publicId(ROOT_SESSION) };
			},
		],
		["GET", "/agents/:agent", ({ agent }) => this.#agent(agent!)],
		[
			"POST",
			"/agents",
			async (_params, request) => {
				const input = this.#checkSkills(this.#checkApps(this.#checkBlueprint(agentInput(await readJson<Record<string, unknown>>(request)))));
				this.#checkNamedScopes(input.memoryScopes ?? []);
				const agent = this.agents.create(checkContacts(null, input, this.agents.list()));
				return Response.json(agent, { status: 201 });
			},
		],
		[
			"PUT",
			"/agents/:agent",
			async ({ agent: id }, request) => {
				const agent = this.#agent(id!);
				const input = this.#checkSkills(this.#checkApps(this.#checkBlueprint(agentInput(await readJson<Record<string, unknown>>(request), agent))));
				this.#checkNamedScopes(input.memoryScopes ?? []);
				return this.agents.update(id!, checkContacts(agent, input, this.agents.list()));
			},
		],
		// The model an agent runs on, from `GET /model`'s choices; null follows the space's.
		[
			"PUT",
			"/agents/:agent/model",
			async ({ agent: id }, request) => {
				const agent = this.#agent(id!);
				const { provider, id: model } = (await readJson<{ provider: string | null; id: string | null }>(request)) ?? {};
				if (provider === null && model === null) return this.chooseAgentModel(agent, null);
				if (typeof provider !== "string" || typeof model !== "string") throw new HttpError(400, "provider and id must be strings, or both null");
				return this.chooseAgentModel(agent, await this.#choice(provider, model));
			},
		],
		// Skills the agents wrote, with the person's approval, every version kept; each agent lists the ones it uses.
		[
			"GET",
			"/skills",
			() => ({
				skills: this.skills.list().map((skill) => ({ ...skill, agents: this.#skillAgents(skill.name) })),
			}),
		],
		["GET", "/skills/:name", ({ name }) => this.#describeSkill(this.#skill(name!).name)],
		[
			"GET",
			"/skills/:name/versions/:version",
			({ name, version }) => {
				const found = VERSION.test(version!) ? this.skills.version(this.#skill(name!).name, Number(version)) : undefined;
				if (!found) throw new HttpError(404, `No version ${version} of the skill ${name}`);
				return found;
			},
		],
		// A supporting file's bytes, to show or, with `download`, to save.
		[
			"GET",
			"/skills/:name/versions/:version/file",
			({ name, version }, _request, url) =>
				this.#artifactRequest(url, async () => {
					const skill = this.#skill(name!);
					if (!VERSION.test(version!) || !this.skills.version(skill.name, Number(version))) throw new HttpError(404, `No version ${version} of the skill ${name}`);
					const { file, bytes } = await this.skills.read(skill.name, Number(version), url.searchParams.get("path") ?? "");
					const type = isTextType(file.type) ? `${file.type}; charset=utf-8` : file.type;
					return new Response(bytes, { headers: fileHeaders({ name: file.path.slice(file.path.lastIndexOf("/") + 1), size: file.size, type }, url.searchParams.has("download")) });
				}),
		],
		[
			"POST",
			"/skills/:name/restore",
			async ({ name }, request) => {
				const skill = this.#skill(name!);
				const { version, baseVersion } = await readJson<{ version: number; baseVersion: number }>(request);
				if (!Number.isSafeInteger(version) || !Number.isSafeInteger(baseVersion)) {
					throw new HttpError(400, "version and baseVersion must be version numbers");
				}
				await this.skills.restore(skill.name, version!, baseVersion!);
				return Response.json(this.#describeSkill(skill.name), { status: 201 });
			},
		],
		[
			"DELETE",
			"/skills/:name",
			async ({ name }) => {
				const skill = this.#skill(name!);
				for (const agent of this.agents.list().filter((candidate) => candidate.skills.includes(skill.name))) {
					this.agents.update(agent.id, agentInput({ skills: agent.skills.filter((other) => other !== skill.name) }, agent));
				}
				await this.skills.delete(skill.name);
				return { deleted: skill.name };
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
		["GET", "/agents/:agent/suggestions", async ({ agent }, _request, url) => ({ suggestions: await this.#suggestions(this.#agent(agent!), url.searchParams.get("locale") ?? "en") })],
		[
			"PUT",
			"/agents/:agent/dashboard",
			async ({ agent }, request) => {
				const { items, sizes } = await readJson<{ items?: unknown; sizes?: unknown }>(request);
				if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) throw new HttpError(400, "items must be a list of a dashboard's items");
				if (sizes !== undefined && (typeof sizes !== "object" || sizes === null || Array.isArray(sizes))) throw new HttpError(400, "sizes must be an object of widget sizes by item");
				return this.#setDashboard(this.#agent(agent!), items as string[], (sizes ?? {}) as Record<string, unknown>);
			},
		],
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
				logo: this.pimConfig().logo ?? null,
			}),
		],
		[
			"DELETE",
			"/agents/:agent",
			async ({ agent: id }) => {
				this.#agent(id!);
				// Its tasks stop with it: no other agent takes them over. It leaves the contacts of the agents that had it.
				for (const task of this.#tasks.open()) if (task.agent === id) await this.#cancelTask(task, "Its agent was deleted.");
				this.agents.delete(id!);
				this.store.deleteMeta(`${SUGGESTIONS_KEY}${id}`);
				this.store.clearAudience(agentAudience(id!));
				return { deleted: true };
			},
		],

		// Circles: who may message this space from their own, and what each circle may use.
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
				const { name, enabled, memoryScopes } = await readJson<{ name: string; enabled: boolean; memoryScopes: string[] }>(request);
				if (enabled !== undefined && typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
				if (memoryScopes !== undefined) {
					if (!Array.isArray(memoryScopes) || memoryScopes.some((key) => typeof key !== "string")) throw new HttpError(400, "memoryScopes must be a list of memory scopes' keys");
					this.#checkNamedScopes(memoryScopes.filter((key) => key !== EVERYONE_SCOPE));
				}
				this.circles.updateCircle(circle!, {
					...(name !== undefined ? { name: circleName(name) } : {}),
					...(enabled !== undefined ? { enabled } : {}),
					...(memoryScopes !== undefined ? { memoryScopes: [...new Set(memoryScopes)] } : {}),
				});
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
				this.artifacts.forgetCircle(circle!);
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

		// Visits: spaces shared with this one's owner.
		[
			"GET",
			"/visits",
			() => ({
				visits: this.visits.shares().map((share) => ({
					ownerId: share.ownerId,
					username: share.username,
					sharedAt: share.sharedAt,
					available: !share.revoked,
					session: share.session !== null && !this.store.deletedSessions().has(share.session) ? this.store.publicId(share.session) : null,
				})),
			}),
		],
		["POST", "/visits/:username", async ({ username }) => ({ session: this.store.publicId(await this.startVisit(username!)) })],

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
		// Where the person comes back from signing in to an app its extension implements: the Worker found this space by
		// its `state`, and posts what the service sent back (as a form) only from a browser signed in as this owner.
		[
			"POST",
			APPS_CALLBACK_PATH,
			async (_params, request) => {
				if (request.headers.get(SIGNED_IN_HEADER) !== "1") throw new HttpError(403, "Sign in to Pim in this browser first");
				const url = new URL(`${this.deployment().publicUrl}${APPS_CALLBACK_PATH}`);
				for (const [name, value] of await request.formData()) if (typeof value === "string") url.searchParams.append(name, value);
				const result = await this.nativeApps.finish(url);
				return "name" in result ? signInResultPage(true, this.deployment().publicUrl ?? undefined) : signInResultPage(false, this.deployment().publicUrl ?? undefined, result.error);
			},
		],
		// An app's action, for the person in their own browser only (see `NativeAppDefinition.actions`), such as Drive's file picker.
		[
			"POST",
			"/app-actions/:extension/:app/:action",
			async ({ extension, app, action }, request) => {
				if (request.headers.get(SIGNED_IN_HEADER) !== "1") throw new HttpError(403, "Only the person, signed in to Pim in their browser, can do this");
				if (Number(request.headers.get("content-length") ?? 0) > 65_536) throw new HttpError(413, "Too large");
				const ref = `${extension}/${app}`;
				if (!this.appDirectory().some((candidate) => candidate.ref === ref)) {
					const definition = this.extensions.app(ref);
					const names = secretsOf(definition);
					const missing = names.filter((name) => !(name in this.#env(names)));
					// Names of what its admin must set, never values.
					throw new HttpError(404, definition && missing.length > 0 ? `This Pim isn't set up for ${definition.name} yet: its admin must set ${missing.join(", ")}.` : `This Pim doesn't offer ${ref}`);
				}
				const input = await readJson<Record<string, unknown>>(request);
				try {
					const result = await this.nativeApps.act(ref, action!, input);
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
				notifications: this.store.notifications({ unread: url.searchParams.get("unread") === "true" }).map((notification) => this.#publicNotification(notification)),
			}),
		],
		[
			"POST",
			"/notifications/:id/read",
			({ id }) => {
				if (!this.store.notification(id!)) throw new HttpError(404, `No notification ${id}`);
				this.store.markNotificationRead(id!);
				return this.#publicNotification(this.store.notification(id!)!);
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
				create: (input) => this.agents.create(checkContacts(null, this.#checkApps(this.#checkBlueprint(agentInput(input))), this.agents.list())),
				files: this.files,
			},
		);
	}

	/** The person's skills in their agents' chats: rebuilt when whether `write_skill` asks first changes. */
	#skillsExtension(services: PimServices) {
		return skillsExtension(services, this.#skillWriters, this.skills, this.files, this.computer.paired());
	}

	/** Rebuilds the extensions whose tools describe the approval policy, once pi's registry has been set up. */
	#reinstallApprovals(): void {
		if (!this.registry.snapshot().extension("pim.approvals")) return;
		const services = this.services();
		this.registry.install(this.#agentExtension(services));
		this.registry.install(this.#skillsExtension(services));
		this.registry.install(approvalsExtension(services, this.#offeredActions()));
		this.#installBrowser(services);
		this.#installDesktop();
		this.#installAbilities(services);
		this.#installApps();
	}

	/**
	 * A computer was paired or removed: the tools that use it come or go, from
	 * the next request, and open apps hear of it. Its connecting and dropping
	 * off change no tools.
	 */
	#computerChanged(): void {
		this.broadcastMessage({ type: "computer" });
		if (!this.registry.snapshot().extension("pim.approvals")) return;
		// Replaced in place, so chats begun before see the change, as they do an approval policy's.
		this.registry.install(filesExtension(this.#files));
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
				windowOf: (conversation) => this.#browserWindowOf(conversation),
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

	/** `generate_image`, where the deployment has an image model. Each image counts as a model request. */
	#installImageGeneration(): void {
		const model = this.imageModel();
		if (!model) return;
		// Images are saved to the person's files, on their computer: without one, the extension is there with no tool.
		if (!this.computer.paired()) {
			this.registry.install(defineExtension({ name: IMAGES_EXTENSION, tools: [] }));
			return;
		}
		this.registry.install(
			imageGenerationExtension({
				model,
				reserve: () => {
					this.#assertOpen();
					const reserved = this.usage.reserveModel(CLOUDFLARE_PROVIDER_ID, model.id);
					return reserved.ok ? null : reserved.refusal;
				},
				save: async (path, bytes) => (await this.files.write(path, bytes)).path,
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
			// Each agent has its own switches for them (`GET /permissions?agent=`).
			tools: catalog
				.filter((tool) => tool.serverId === server.id)
				.map((tool) => ({ name: toolName(server.id, tool.name), description: tool.description ?? null })),
		}));
	}

	// WebSocket API

	/** Pim speaks only its own protocol (see `protocol.ts`) on its sockets. */
	shouldSendProtocolMessages(): boolean {
		return false;
	}

	/** The computer's connection is tagged, so the space finds it, and leaves it out of what it tells the app. */
	override getConnectionTags(_connection: Connection, ctx: ConnectionContext): string[] {
		const { pathname } = new URL(ctx.request.url);
		if (pathname === COMPUTER_SCREEN_PATH) return [SCREEN_TAG];
		return pathname === COMPUTER_PATH ? [COMPUTER_TAG] : pathname === BROWSER_LIVE_PATH ? [BROWSER_TAG] : [];
	}

	#isComputer(connection: Connection): boolean {
		return connection.tags.includes(COMPUTER_TAG);
	}

	#isBrowserWatcher(connection: Connection): boolean {
		return connection.tags.includes(BROWSER_TAG);
	}

	#isScreenViewer(connection: Connection): boolean {
		return connection.tags.includes(SCREEN_TAG);
	}

	/**
	 * An app shows the computer's desktop on this socket: a stream of it
	 * opens on a channel of its own, numbered here and kept as the socket's
	 * state, so the stream finds its socket after the space slept. What the
	 * stream says goes to the socket as it is, and what the app sends goes to
	 * the stream (Cua's media plane, rcdp wire v2).
	 */
	async #viewScreen(connection: Connection<SocketState>): Promise<void> {
		const channel = crypto.getRandomValues(new Uint32Array(1))[0]! || 1;
		connection.setState({ session: ROOT_SESSION, channel });
		try {
			const status = this.computer.status();
			if (status.state === "none") throw new Error("This space has no computer.");
			if (status.state === "offline") throw new Error("The computer is offline.");
			if (!status.computer?.screen) throw new Error("This computer doesn't stream its desktop.");
			await this.computer.openScreen(channel);
		} catch (error) {
			connection.close(4004, errorMessage(error).slice(0, 120));
		}
	}

	/** What a stream of the desktop said, for the socket it's for; null when it closed. */
	#screenSaid(channel: number, data: string | ArrayBuffer | null): void {
		const viewer = [...this.getConnections<SocketState>(SCREEN_TAG)].find((connection) => connection.state?.channel === channel);
		if (!viewer) {
			// Its socket went: the stream goes too, asked once.
			if (data !== null && !this.#orphanedScreens.has(channel)) {
				this.#orphanedScreens.add(channel);
				this.computer.closeScreen(channel);
			}
			if (data === null) this.#orphanedScreens.delete(channel);
			return;
		}
		if (data === null) viewer.close(4000, "The computer's desktop closed");
		else if (viewer.readyState === WebSocket.OPEN) viewer.send(data);
	}

	/**
	 * Someone takes a chat's window over on this socket (`?session=`, as the
	 * socket's state): it gets the page as pictures, and its mouse and
	 * keyboard go to the page. It closes when the window does. One that
	 * isn't open opens where it was, waking the computer if it's asleep.
	 */
	async #watchBrowser(connection: Connection<SocketState>, request?: Request): Promise<boolean> {
		const send = (message: BrowserLiveMessage) => {
			if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(message));
		};
		try {
			if (!this.browser.available) throw new Error("This space has no browser: connect a computer in Settings → Computer.");
			if (request) connection.setState({ session: await this.#browserWindow(new URL(request.url)) });
			await this.browser.watch(connection.state?.session ?? ROOT_SESSION, connection.id, {
				frame: (frame) => send({ type: "frame", ...frame }),
				page: (page) => send({ type: "page", ...page }),
				closed: () => connection.close(4000, "The window closed"),
			});
			return true;
		} catch (error) {
			send({ type: "error", message: errorMessage(error) });
			connection.close(4004, "The window couldn't open");
			return false;
		}
	}

	async onConnect(connection: Connection<SocketState>, ctx: ConnectionContext): Promise<void> {
		if (this.#isComputer(connection)) {
			this.computer.connected(connection);
			return;
		}
		if (this.#isBrowserWatcher(connection)) {
			await this.#watchBrowser(connection, ctx.request);
			return;
		}
		if (this.#isScreenViewer(connection)) {
			await this.#viewScreen(connection);
			return;
		}
		const requested = new URL(ctx.request.url).searchParams.get("session");
		let session: string;
		try {
			session = requested ? await this.#session(requested) : ROOT_SESSION;
		} catch (error) {
			this.#send(connection, { type: "error", message: errorMessage(error) });
			connection.close(4004, "Unknown session");
			return;
		}
		connection.setState({ session });
		this.#send(connection, { type: "hello", session: this.store.publicId(session), tools: this.tools() });
		await this.#watch(connection, session);
	}

	async onMessage(connection: Connection<SocketState>, raw: WSMessage): Promise<void> {
		if (this.#isComputer(connection)) return this.#computerSaid(raw);
		if (typeof raw !== "string") return;
		if (this.#isScreenViewer(connection)) {
			if (connection.state?.channel) this.computer.screenInput(connection.state.channel, raw);
			return;
		}
		if (this.#isBrowserWatcher(connection)) {
			// A space that slept since forgot who was watching: they go on where they were.
			if (!this.browser.watching(connection.id) && !(await this.#watchBrowser(connection))) return;
			try {
				await this.browser.input(connection.id, JSON.parse(raw) as BrowserInput);
			} catch (error) {
				if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "error", message: errorMessage(error) } satisfies BrowserLiveMessage));
			}
			return;
		}
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
		if (this.#isComputer(connection)) return this.#computerDisconnected();
		if (this.#isBrowserWatcher(connection)) return this.browser.unwatch(connection.id);
		if (this.#isScreenViewer(connection)) return this.#stopViewing(connection);
		this.#watchRequests.delete(connection.id);
		await this.#unwatch(connection.id);
	}

	async onError(connection: Connection): Promise<void> {
		if (this.#isComputer(connection)) return this.#computerDisconnected();
		if (this.#isBrowserWatcher(connection)) return this.browser.unwatch(connection.id);
		if (this.#isScreenViewer(connection)) return this.#stopViewing(connection);
		this.#watchRequests.delete(connection.id);
		await this.#unwatch(connection.id);
	}

	/** The app stopped showing the desktop: its stream closes. */
	#stopViewing(connection: Connection): void {
		const { channel } = (connection.state ?? {}) as Partial<SocketState>;
		if (channel) this.computer.closeScreen(channel);
	}

	/** A message from the computer: what it is, when it has just connected, an answer, or what a stream of its desktop says. */
	#computerSaid(raw: string | ArrayBuffer | ArrayBufferView): void {
		const message = typeof raw === "string" || raw instanceof ArrayBuffer ? raw : (raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
		const hello = typeof message === "string" && message.startsWith('{"type":"hello"');
		const desktop = hello && this.computer.desktop();
		this.computer.receive(message);
		if (!hello) return;
		// A computer of the person's own that now has a desktop agents can use, or no longer has one: its tools come or go.
		if (this.computer.desktop() !== desktop) this.#computerChanged();
		this.#computerConnected();
	}

	/**
	 * The computer connected and said what it is: open apps hear of it, and
	 * files kept in the space before files moved to the computer move there.
	 */
	#computerConnected(): void {
		this.broadcastMessage({ type: "computer" });
		void this.keepAliveWhile(async () => {
			try {
				if (!(await this.legacyFiles.any())) return;
				const moved = await this.legacyFiles.moveTo(this.files);
				if (moved > 0) this.broadcastMessage({ type: "computer" });
			} catch (error) {
				// It goes on from where it stopped the next time the computer connects.
				console.warn("moving files to the computer failed", error);
			}
		});
	}

	#computerDisconnected(): void {
		this.computer.disconnected();
		this.broadcastMessage({ type: "computer" });
	}

	async #command(connection: Connection<SocketState>, session: string, message: ClientMessage): Promise<JsonValue> {
		const handle = this.harness.session(session);
		switch (message.type) {
			case "submit": {
				const receipt = await this.submitTo(
					session,
					userInput(message.content),
					{
						...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
						...(message.operationId ? { operationId: message.operationId } : {}),
					},
					"user",
				);
				return { ...receipt, session: this.store.publicId(session) };
			}
			case "abort":
				return await handle.abort(message.operationId);
			case "reset":
				await handle.reset(message.handoff);
				return null;
			case "resync":
				await this.#watch(connection, session);
				return null;
			case "follow":
				await this.#watch(connection, this.#session(message.session));
				return null;
			case "snapshot": {
				const stream = await this.harness.session(await this.#session(message.session)).events();
				await stream.stop();
				return stream.snapshot as unknown as JsonValue;
			}
			default:
				throw new Error(`Unknown message type ${JSON.stringify((message as { type: unknown }).type)}`);
		}
	}

	/**
	 * Sends a session's snapshot on the socket, then its events, in place of
	 * what the socket followed. A socket can switch quickly, as someone flips
	 * through chats: only its latest request is kept.
	 */
	async #watch(connection: Connection<SocketState>, which: string | Promise<string>): Promise<void> {
		const request = {};
		this.#watchRequests.set(connection.id, request);
		const session = await which;
		await this.#unwatch(connection.id);
		const stream = await this.harness.session(session).events();
		if (this.#watchRequests.get(connection.id) !== request) {
			await stream.stop();
			return;
		}
		connection.setState({ session });
		this.#watches.set(connection.id, stream);
		const id = this.store.publicId(session);
		this.#send(connection, { type: "events", session: id, events: [stream.snapshot] });
		stream.start(async (events) => {
			// Chats only say that a request failed; the provider's own words are for whoever runs the deployment.
			for (const event of events) {
				if (event.type === "task_failed") {
					console.warn(JSON.stringify({ event: "pim.task_failed", kind: event.kind, error: event.message.slice(0, 1000) }));
				} else if (event.type === "submission" && event.record.status === "unanswered" && event.record.reason === "model_error") {
					console.warn(JSON.stringify({ event: "pim.model_error", error: String(event.record.detail ?? "").slice(0, 1000) }));
				}
			}
			if (connection.readyState !== WebSocket.OPEN) {
				void this.#unwatch(connection.id);
				return;
			}
			this.#send(connection, { type: "events", session: id, events });
		});
	}

	async #unwatch(connectionId: string): Promise<void> {
		const stream = this.#watches.get(connectionId);
		if (!stream) return;
		this.#watches.delete(connectionId);
		await stream.stop();
	}

	/** The sockets following `session`. */
	#watchers(session: string): Connection<SocketState>[] {
		return [...this.getConnections<SocketState>()].filter((connection) => connection.state?.session === session);
	}

	#send(connection: Connection, message: ServerMessage): void {
		if (connection.readyState !== WebSocket.OPEN) return;
		try {
			connection.send(JSON.stringify(message));
		} catch {
			// Closed between the check and the send.
		}
	}

	/** Tells every open app; the computer's connection, and those taking the browser over or showing the desktop, speak other protocols. */
	broadcastMessage(message: ServerMessage): void {
		this.broadcast(
			JSON.stringify(message),
			[...this.getConnections(COMPUTER_TAG), ...this.getConnections(BROWSER_TAG), ...this.getConnections(SCREEN_TAG)].map((connection) => connection.id),
		);
	}
}
