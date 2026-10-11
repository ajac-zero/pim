import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
	type AgentChange,
	type AgentEventStream,
	type ConversationId,
	type UserInput,
	createRegistry,
	Harness,
	type HarnessSettings,
	type ModelRef,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { Agent, type Connection, type ConnectionContext, getAgentByName, type Schedule, type WSMessage } from "agents";
import { type PiModel, PiHarness, type PiOperationResult, type PiReceipt, ROOT_SESSION } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { ArtifactStore, artifactHeaders, downloadName, RESIZE_SCRIPT } from "./artifacts";
import { Email, type Mailer, mailerFrom } from "./email";
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
	describeWait,
	type GatedAction,
	httpRequest,
	ownToolPermission,
	type ResolvedPermission,
	resolvePermission,
} from "./extensions/approvals";
import { artifactsExtension } from "./extensions/artifacts";
import { goalsExtension } from "./extensions/goals";
import {
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
	slug,
	summarizeCall,
	toolDefinition,
	toolName,
	toText,
} from "./extensions/mcp";
import { MESSAGING_EXTENSION, messagingExtension, SEND_TO_USER } from "./extensions/messaging";
import { createOptMem } from "./extensions/optmem";
import { blockName, halves, parseBlock } from "./extensions/optmem/cover";
import { byteLength, ENTRY_BYTES, entryLine } from "./extensions/optmem/store";
import { personaExtension } from "./extensions/persona";
import { describeSchedule, SCHEDULE_EXTENSION, scheduleExtension } from "./extensions/schedule";
import type { PimServices, ScheduledTaskPayload } from "./extensions/services";
import { webExtension } from "./extensions/web";
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
import { type Persona, type PersonaInput, PersonaStore, personaInput, type TeamMember } from "./personas";
import { type Role, TEAM_EXTENSION, type TeamRun, TeamStore, teamExtension } from "./team";
import { projectEntries } from "./transcript";
import { deploymentLimits, type Limits, parseLimits, UsageMeter } from "./usage";
import { type BriefResult, type GuestBrief, type GuestCallResult, VISIT_PREFIX, VisitStore, visitExtension, visitExtensionName } from "./visits";

const SCHEDULED_TASK_CALLBACK = "runScheduledTask";
/** Operation ids of the inputs Pim gives itself: scheduled tasks, approvals' decisions, apps' events. */
const PIM_OPERATION = /^(schedule|approval|event):/;
/**
 * Set by the Worker on every request it forwards: the owner it resolved,
 * which must be the agent's own name. A request routed to the wrong agent is
 * refused rather than served.
 */
export const OWNER_HEADER = "x-pim-owner";

/** Where apps' sign-ins return, as `/mcp/callback/<owner>`, so the Worker knows whose agent the callback is for. */
export const MCP_CALLBACK_PATH = "/mcp/callback";
/** Where apps deliver event webhooks, as `/mcp/events/<owner>/<watch id>`; signed, so served without the API token. The agent sees `/mcp/events/<watch id>`. */
export const MCP_EVENTS_PATH = "/mcp/events/";
const WATCH_REFRESH_CALLBACK = "refreshAppWatch";
/** How long an approval waits for the user under the `auto` policy before it is granted, so background work never stalls. */
const APPROVAL_TIMEOUT_MS = 30_000;
/** Decides an approval its timeout reached, as it was filed to be decided. */
const APPROVAL_EXPIRY_CALLBACK = "expireApproval";

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
type AutoApproval = "timeout" | "always";

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

/** Whether the agent works: a suspended one answers nothing and runs nothing until its operator lifts it. */
export type OwnerStatus = "active" | "suspended";

/** What registration tells an agent about its owner when it provisions it. */
export type OwnerProfile = { readonly ownerId: string; readonly username: string; readonly publicUrl: string };
/** How long an erasure waits for runs to stop and apps to unsubscribe before wiping anyway. */
const ERASE_COURTESY_MS = 3_000;
/** `pim_meta` key of the model chosen through the API. */
const MODEL_KEY = "model";
/** `pim_meta` keys the Worker sets: the owner's profile, a suspension, the agent's own limits. */
const PROFILE_KEY = "owner";
const STATUS_KEY = "status";
const LIMITS_KEY = "limits";
/** Tools of the Pim the person talks with that its team members don't get, though their extensions stay. */
const LEAD_ONLY_TOOLS = new Set(["watch_app_event"]);
/** Set once chats' Pims come from the prompt's `pim` section, not from instructions stored in each chat. */
const PIM_SECTION_KEY = "pim_section";
/** The day the person was last told a limit stopped background work. */
const LIMIT_NOTICE_KEY = "limit_notice";
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

/** A session's default name: the start of the first thing the user said. */
function titleFrom(content: UserInput): string | undefined {
	const text =
		typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
	return text.trim() === "" ? undefined : clipTitle(text);
}

/** A model as the API shows it. */
function describeModel(model: PiModel) {
	return { provider: model.provider, id: model.id, name: "name" in model && typeof model.name === "string" ? model.name : model.id };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The agent. A deployment has exactly one instance, owned by the person who
 * deployed it. Its SQLite database holds pi's conversations, tasks and
 * transcripts, plus Pim's memories, goals, approvals and notifications.
 *
 * pi-durable runs every model turn and tool call as a durable task, and the
 * `PiHarness` lifecycle job wakes the object after an eviction so runs
 * resume where they stopped.
 */
export class Pim extends Agent<Env> {
	readonly store = new PimStore(this.ctx.storage.sql);
	/** People this Pim's owner shares it with, in circles. */
	readonly circles = new CircleStore(this.ctx.storage.sql);
	/** Pims shared with this Pim's owner, and their conversations with them. */
	readonly visits = new VisitStore(this.ctx.storage.sql);
	/** The owner's Pims: named agents with their own instructions, the default one first. */
	readonly personas = new PersonaStore(this.ctx.storage.sql);
	/** The tasks the Pims' teams were given, each in a conversation of its own. */
	readonly team = new TeamStore(this.ctx.storage.sql);
	/** What the agent made for its owner, with every version. */
	readonly artifacts = new ArtifactStore(this.ctx.storage.sql, () => this.limits(), {
		storageRoom: () => {
			const { storageBytes } = this.limits();
			return storageBytes === null ? null : storageBytes - this.ctx.storage.sql.databaseSize;
		},
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
	/** What this agent has used, and its limits. */
	readonly usage = new UsageMeter({
		sql: this.ctx.storage.sql,
		limits: () => this.limits(),
		// The person's own plan: its tokens are theirs, not the deployment's.
		planProviders: [CHATGPT_PROVIDER],
	});
	/** Actions that run only after the user approves them. */
	/** Connected apps: the SDK's MCP client, as the bridge pim's extension builds tools from. */
	readonly apps: McpBridge = {
		servers: () =>
			Object.entries(this.getMcpServers().servers).map(([id, server]) => ({
				id,
				name: server.name,
				url: server.server_url,
				state: server.state,
				error: server.error,
				authUrl: server.auth_url,
				instructions: server.instructions,
				approval: (this.store.mcpApproval(id) ?? "writes") as McpApproval,
			})),
		tools: () => this.mcp.listTools(),
		call: async (serverId, name, args) => {
			// Work still under way on an agent being erased acts on nobody's behalf.
			this.#assertOpen();
			return this.mcp.callTool({ serverId, name, arguments: args });
		},
		connect: (name, url) => this.connectApp(name, url),
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
	readonly actions: readonly GatedAction[] = [
		httpRequest as GatedAction,
		...mcpActions(this.apps),
		watchAction(this.apps, this.appEvents),
	];

	readonly harness = new PiHarness({
		harness: async ({ storage, context }) => {
			const services = this.services();
			this.#migrateAlwaysApproved();
			this.registry.install(personaExtension(services, (session) => this.#roleOf(session)));
			this.registry.install(goalsExtension(services));
			this.registry.install(scheduleExtension(services));
			this.registry.install(messagingExtension(services));
			this.registry.install(
				teamExtension({
					roleOf: (session) => this.#roleOf(session),
					runs: this.team,
					memberAgent: (member) => this.#memberAgent(member),
					ask: (conversation, task, operation) => this.#askMember(conversation, task, operation),
				}),
			);
			this.registry.install(approvalsExtension(services, this.actions));
			this.registry.install(webExtension({ ai: this.env.AI, searchProvider: this.env.PIM_WEB_SEARCH }));
			this.registry.install(artifactsExtension({ artifacts: this.artifacts, assertOpen: () => this.#assertOpen() }));
			// Restored connections reconnect in the background after a wake; give them a moment.
			await this.mcp.waitForConnections({ timeout: 5_000 });
			this.#migrateAlwaysApproved();
			const apps = mcpExtensions(this.apps, services, this.#appExtras(services));
			this.registry.install(apps.apps);
			this.registry.install(this.memory.extension);
			// Last: the apps' tools come and go, and pi only appends cheaply at the end.
			this.registry.install(apps.tools);
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
			// Chats started with a Pim used to store its instructions; the `pim` section gives them now.
			if (this.store.meta(PIM_SECTION_KEY) === undefined) {
				for (const session of this.personas.startedSessions()) {
					await (await harness.conversation(Number(session) as ConversationId, context))?.configure({ instructions: null }, context);
				}
				this.store.setMeta(PIM_SECTION_KEY, "1");
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
	 * Connects a remote MCP server under a new name. A failed connection
	 * leaves nothing behind; `authUrl` is set when the user must sign in.
	 */
	async connectApp(
		name: string,
		url: string,
		options: { headers?: Record<string, string>; approval?: McpApproval } = {},
	): Promise<{ id: string; state: string; authUrl?: string }> {
		const id = slug(name);
		const existing = this.apps.servers().find((server) => server.id === id);
		if (existing && existing.state !== "ready") {
			// A connection that failed, or is still waiting for sign-in (an abandoned or expired one), is not connected: clear it so the user can try again.
			await this.removeMcpServer(id).catch(() => undefined);
			this.store.deleteMcpApproval(id);
		} else if (existing) {
			throw new HttpError(409, `An app named ${name} is already connected`);
		}
		const { apps } = this.limits();
		if (apps !== null && this.apps.servers().filter((server) => server.id !== id).length >= apps) {
			throw new HttpError(429, `You can connect up to ${apps} apps. Remove one first.`);
		}
		this.store.setMcpApproval(id, options.approval ?? "writes");
		try {
			const result = await this.addMcpServer(name, url, {
				id,
				// The owner in the path tells the Worker whose agent the sign-in returns to.
				callbackPath: `${MCP_CALLBACK_PATH}/${this.name}`,
				...(options.headers ? { transport: { headers: options.headers } } : {}),
			});
			if (result.state === "ready") {
				await this.catalog.refresh(id).catch((error) => console.warn(`reading ${id}'s catalog failed`, error));
			}
			this.#installApps();
			return result;
		} catch (error) {
			await this.removeMcpServer(id).catch(() => undefined);
			this.store.deleteMcpApproval(id);
			throw new HttpError(502, `Could not connect ${name}: ${errorMessage(error)}`);
		}
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

	/** Rebuilds the connected apps' extension, once pi's registry has been set up. */
	#installApps(): void {
		if (!this.registry.snapshot().extension("pim.mcp")) return;
		this.#migrateAlwaysApproved();
		// Same names: each replaces its installed extension in place, keeping the order.
		const services = this.services();
		const apps = mcpExtensions(this.apps, services, this.#appExtras(services));
		this.registry.install(apps.apps);
		this.registry.install(apps.tools);
	}

	/** pi's run policy, shared by every session. */
	protected harnessSettings(): HarnessSettings {
		const registry = this.registry;
		return {
			// Every extension but visits': only a visit's own conversation selects its extension.
			get extensions() {
				return registry.snapshot().installed().filter((extension) => !extension.name.startsWith(VISIT_PREFIX));
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

	/** One catalog for pi and the API, so a token refresh is never run twice at once. Every request through it is metered. */
	modelCatalog(): Models {
		this.#modelCatalog ??= this.usage.meter(this.models());
		return this.#modelCatalog;
	}

	/** The person's settings: their own, else the deployment's. */
	settings(): Settings {
		return readSettings(this.store, this.env);
	}

	/** The deployment's limits (`PIM_LIMITS`), with this agent's own where its operator set them. */
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
			// Read at each use: the person can change these while the agent runs.
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
		this.store.touchSession(session, from === "user" && !this.visits.bySession(session) ? titleFrom(content) : undefined);
		try {
			receipt = await this.harness.submit(content, { session, ...options });
		} catch (error) {
			if (run !== undefined) this.usage.releaseRun(run);
			throw error;
		}
		// A retried submission (the same operation id) is not accepted again: one run, not two.
		if (run !== undefined && !receipt.accepted) this.usage.releaseRun(run);
		return receipt;
	}

	/**
	 * An operation's result with what it sent the person in its conversation:
	 * the messages of its run's `send_to_user` calls, in order. A message from
	 * the person that got nothing sent back (a model that forgot to) is
	 * answered with the run's final text instead; work Pim gave itself may
	 * stay silent.
	 */
	async #withReplies(result: PiOperationResult): Promise<PiOperationResult & { replies: string[] }> {
		if (result.status !== "done") return { ...result, replies: [] };
		const conversation = await this.harness.conversation(result.session);
		const record = await (await this.harness.storage()).submissionByRequest(conversation.id, result.operationId, BACKGROUND_CONTEXT);
		const replies: string[] = [];
		let sent = false;
		if (record?.type === "input" && record.status === "done") {
			for (const entry of await this.harness.session(result.session).messages()) {
				const message = entry.model?.[0];
				if (entry.id <= record.entry || entry.id > record.answer || message?.role !== "assistant") continue;
				for (const part of message.content) {
					if (part.type !== "toolCall" || part.name !== SEND_TO_USER) continue;
					sent = true;
					// What went to their inbox is not a reply here.
					if (typeof part.arguments.message === "string" && part.arguments.channel !== "email") replies.push(part.arguments.message);
				}
			}
		}
		const fallback = !sent && result.text && !PIM_OPERATION.test(result.operationId);
		return { ...result, replies: fallback ? [result.text!] : replies };
	}

	#storageRefusal(): string | null {
		const { storageBytes } = this.limits();
		if (storageBytes === null || this.ctx.storage.sql.databaseSize < storageBytes) return null;
		return `Pim storage quota exceeded: this Pim holds ${this.ctx.storage.sql.databaseSize} bytes, over its ${storageBytes}. Delete chats or memories to make room.`;
	}

	// Background work

	/**
	 * Fired by `schedule_task` schedules: hands the instruction to the session
	 * that made it. A firing a limit or a suspension refuses is skipped, not
	 * retried; the person hears about the limit once a day.
	 */
	async runScheduledTask(payload: ScheduledTaskPayload, schedule: Schedule<ScheduledTaskPayload>): Promise<void> {
		const label = payload.label ? ` "${payload.label}"` : "";
		try {
			await this.submitTo(
				payload.session,
				`[Scheduled task${label} ${schedule.id}] ${payload.instruction}`,
				// The same firing retried is one submission.
				{ operationId: `schedule:${schedule.id}:${schedule.time}` },
				"pim",
			);
		} catch (error) {
			if (!(error instanceof HttpError)) throw error;
			if (error.status === 429) await this.#tellLimitOnce(`Skipped scheduled task${label}`, error.message);
		}
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
	 * and an `auto` approval's timeout is set. The decision comes back later as
	 * a message (see `decideApproval`), so the turn need not wait for it.
	 */
	async #approvalFiled(approval: Approval, isNew: boolean): Promise<string> {
		if (approval.status !== "pending") return this.#outcome(approval);
		if (this.#approvalPermission(approval) === "on") {
			return this.#outcome(await this.decideApproval(approval.id, "approve", undefined, "always", { inTurn: true }));
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
		return policy === "explicit" ? null : APPROVAL_TIMEOUT_MS;
	}

	#outcome(approval: Approval): string {
		const note = approval.note ? `\nThe user's note: ${approval.note}` : "";
		const waited = describeWait((approval.expiresAt ?? approval.createdAt) - approval.createdAt);
		if (approval.status === "denied") {
			const who =
				approval.decidedBy === "timeout" ? `The user did not respond within ${waited}, so it was denied` : "The user denied";
			return `[Approval ${approval.id}] ${who}: ${approval.summary}${note}\nDo not perform this action.`;
		}
		const who =
			approval.decidedBy === "timeout"
				? `The user did not respond within ${waited}, so it was approved automatically`
				: approval.decidedBy === "always"
					? `The user always approves ${approval.tool}, so it was approved automatically`
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
		// An approval's timer can outlive the agent's erasure; its action must not run.
		this.#assertOpen();
		const approval = this.store.approval(id);
		if (!approval) throw new HttpError(404, `No approval ${id}`);
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
			// A member whose task already ended answers its Pim's chat once it has gone on; one still at work answers the task.
			const run = this.team.run(approval.session);
			if (run && run.status !== "running") {
				this.team.setStatus(run.conversation, "running");
				this.team.setReport(run.conversation, operation);
				void this.#report(run, operation);
			}
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
		if (app === "") return ownToolPermission(this.store, tool).permission;
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
						choices: TOOL_PERMISSIONS,
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

	// The owner's Pims, and their teams.

	/** The Pim a conversation talks as, and the team member it is, if it is one. */
	#roleOf(session: string): Role {
		const run = this.team.run(session);
		if (!run) return { pim: this.personas.ofSession(session), member: null };
		const pim = this.personas.get(run.persona) ?? this.personas.default();
		// A member taken off the team since keeps working on what it was given, with no instructions of its own.
		const member = pim.team.find((candidate) => candidate.name === run.member) ?? { name: run.member, instructions: "", tools: null };
		return { pim, member };
	}

	/**
	 * A member's conversation leaves out what only the Pim the person talks
	 * with does: talking to them, scheduling work and watching apps' events
	 * (both come back to the conversation that asked), and handing out tasks.
	 * A member with a list of tools gets only those.
	 */
	#memberAgent(member: TeamMember): AgentChange {
		const snapshot = this.registry.snapshot();
		const removed = [MESSAGING_EXTENSION, SCHEDULE_EXTENSION, TEAM_EXTENSION].flatMap((name) => snapshot.extension(name) ?? []);
		const kept = snapshot.tools().filter(({ extension, tool }) => !removed.includes(extension) && !LEAD_ONLY_TOOLS.has(tool.name));
		if (member.tools) return { extensions: { remove: removed }, tools: kept.filter(({ tool }) => member.tools!.includes(tool.name)).map(({ tool }) => tool) };
		const leadOnly = snapshot.tools().filter(({ tool }) => LEAD_ONLY_TOOLS.has(tool.name));
		return { extensions: { remove: removed }, ...(leadOnly.length > 0 ? { tools: { remove: leadOnly.map(({ tool }) => tool) } } : {}) };
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

	#persona(id: string): Persona {
		const persona = this.personas.get(id);
		if (!persona) throw new HttpError(404, `No Pim ${id}`);
		return persona;
	}

	/** The Pim a chat talks with; none in a visit, which talks with someone else's. */
	#personaRef(session: string): { id: string; name: string } | null {
		if (this.visits.bySession(session)) return null;
		const persona = this.personas.ofSession(session);
		return { id: persona.id, name: persona.name };
	}

	/** One of the owner's Pims, for the Worker to publish to the gallery. */
	async personaToPublish(id: string): Promise<Persona | null> {
		this.#assertOpen();
		return this.personas.get(id) ?? null;
	}

	/** Records which template a Pim is published as; null once unpublished. */
	async setPersonaPublished(id: string, template: string | null): Promise<void> {
		this.#assertOpen();
		if (this.personas.get(id)) this.personas.setPublished(id, template);
	}

	/** Makes a published template one of the owner's Pims: a copy of it, theirs to change. */
	async adoptTemplate(template: {
		id: string;
		author: string;
		name: string;
		description: string;
		instructions: string;
		apps: readonly { name: string; url: string }[];
		team: readonly TeamMember[];
	}): Promise<Persona> {
		this.#assertOpen();
		const input = personaInput({ ...template });
		return this.personas.create(input, { template: template.id, author: template.author });
	}

	/** At registration: makes the default Pim a copy of the one the admin chose for everyone. */
	async adoptDefaultPim(pim: PersonaInput & { author: string }): Promise<Persona> {
		this.#assertOpen();
		const { author, ...input } = pim;
		return this.personas.replaceDefault(personaInput({ ...input }), { template: "default", author });
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

	// Hosting: what the Worker in front tells the agent about its owner.

	/** Set while `deleteEverything` runs: the agent takes nothing new. */
	#erasing = false;

	/**
	 * Whether the agent is erased, or being erased. An erased agent keeps
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

	/** Every request comes through the Worker, which names the owner it resolved: it must be this agent's. */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get(OWNER_HEADER) !== this.name) {
			console.error(JSON.stringify({ event: "pim.misrouted", agent: this.name }));
			return Response.json({ error: "This request is not for this Pim" }, { status: 421 });
		}
		if (this.#closed()) return Response.json({ error: "This Pim was erased" }, { status: 410 });
		if (this.status() !== "active") return Response.json({ error: "This Pim is suspended" }, { status: 403 });
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

	/** Records who owns this agent and where it is served, so callbacks and pushes use that address. */
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

	/** Suspends or restores the agent. Suspending stops its runs and closes its sockets; its data stays. */
	async setStatus(status: OwnerStatus): Promise<void> {
		this.#assertOpen();
		if (status === "active") this.store.deleteMeta(STATUS_KEY);
		else this.store.setMeta(STATUS_KEY, status);
		if (status === "suspended") {
			for (const session of await this.harness.sessions.list()) await this.harness.session(session.id).abort();
			for (const connection of this.getConnections()) connection.close(4003, "Suspended");
		}
	}

	/** This agent's own limits, over the deployment's; null goes back to the deployment's. */
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
			storageBytes: this.ctx.storage.sql.databaseSize,
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
			schedules: (await this.services().listSchedules()).map(describeSchedule),
			approvals: this.store.approvals(),
			permissions: this.store.toolPermissions(),
			circles: this.#describeCircles(),
			personas: this.personas.list(),
			guestActivity: this.circles.activity(500),
			sharedWithMe: this.visits.shares().map(({ ownerId, username, sharedAt, revoked }) => ({ ownerId, username, sharedAt, revoked })),
			notifications: this.store.notifications({ unread: false }),
			apps: this.apps.servers().map(({ id, name, url, approval }) => ({ id, name, url, approval })),
			watches: this.appEvents.list(),
			artifacts: this.artifacts.export(),
			usage: this.usage.history(90),
		});
	}

	/**
	 * What of the person's data this agent still holds; nothing once
	 * `deleteEverything` has run. A deletion counts as done only when this
	 * says so, since destroying the agent ends the call that asked for it.
	 */
	async remainingData(): Promise<string[]> {
		const remaining = this.store.remainingData();
		if (this.memory.store.count() > 0) remaining.push("memories");
		const own = new Set([SCHEDULED_TASK_CALLBACK, WATCH_REFRESH_CALLBACK]);
		if ((await this.listSchedules()).some((schedule) => own.has(schedule.callback))) remaining.push("schedules");
		if (Object.keys(this.getMcpServers().servers).length > 0) remaining.push("app connections");
		return remaining;
	}

	/** Whether the agent is erased, and what of the person's data it still holds; a finished deletion is both. */
	async erasure(): Promise<{ sealed: boolean; remaining: string[] }> {
		return { sealed: this.store.erasedAt() !== null, remaining: await this.remainingData() };
	}

	/**
	 * Erases the agent: stops its runs, ends apps' event subscriptions,
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
						persona: this.#personaRef(session.id),
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
				const { title, persona: personaId } = await readJson<{ title: string; persona: string }>(request);
				const persona = personaId === undefined ? undefined : this.#persona(personaId);
				const { sessions } = this.limits();
				if (sessions !== null) {
					const hidden = this.#hiddenSessions();
					const open = (await this.harness.sessions.list()).filter((session) => !hidden.has(session.id)).length;
					if (open >= sessions) throw new HttpError(429, `You can have up to ${sessions} chats. Delete one first.`);
				}
				const { id } = await this.harness.sessions.create();
				await this.harness.session(id).setModel(this.chosenModel());
				// A chat with the default Pim isn't tied to it: it stays with whichever is the default.
				if (persona && !persona.default) this.personas.setSession(id, persona.id);
				this.store.touchSession(id, typeof title === "string" && title.trim() !== "" ? clipTitle(title) : undefined);
				return { id, ...this.store.sessionInfo(id), persona: this.#personaRef(id) };
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
		[
			"DELETE",
			"/sessions/:session",
			async ({ session }) => {
				const id = await this.#session(session!);
				this.store.deleteSession(id);
				const visit = this.visits.bySession(id);
				if (visit) this.visits.setSession(visit.ownerId, null);
				// Nothing keeps working in a chat the user can no longer see.
				await this.harness.session(id).abort();
				const services = this.services();
				for (const schedule of await services.listSchedules()) {
					if (schedule.payload.session === id) await services.cancelSchedule(schedule.id);
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
				if (typeof body.content !== "string" || body.content.trim() === "") {
					throw new HttpError(400, "content must be a non-empty string");
				}
				if (body.whenBusy !== undefined && body.whenBusy !== "followUp" && body.whenBusy !== "steer") {
					throw new HttpError(400, "whenBusy must be followUp or steer");
				}
				const receipt = await this.submitTo(
					id,
					body.content,
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
		// What a chat's Pim handed its team, and each member's conversation, read-only.
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
				return {
					model: describeModel(this.chosenModel()),
					default: describeModel(fallback),
					choices: [fallback, ...platform, ...chatgptModels].map(describeModel),
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
				if (provider === fallback.provider && this.#allowedModels()?.includes(id)) {
					return { model: describeModel(await this.chooseModel(this.ai(id))) };
				}
				const model = this.modelCatalog().getModel(provider, id);
				if (!model) throw new HttpError(400, `No model ${provider}/${id}`);
				if (provider === CHATGPT_PROVIDER && !(await this.chatgpt.status()).connected) {
					throw new HttpError(409, "Sign in with ChatGPT first");
				}
				return { model: describeModel(await this.chooseModel(model)) };
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

		// The owner's Pims: named agents with their own instructions, the default one first.
		["GET", "/personas", () => ({ personas: this.personas.list() })],
		["GET", "/personas/:persona", ({ persona }) => this.#persona(persona!)],
		[
			"POST",
			"/personas",
			async (_params, request) => {
				const persona = this.personas.create(personaInput(await readJson<Record<string, unknown>>(request)));
				return Response.json(persona, { status: 201 });
			},
		],
		[
			"PUT",
			"/personas/:persona",
			async ({ persona: id }, request) => {
				return this.personas.update(id!, personaInput(await readJson<Record<string, unknown>>(request), this.#persona(id!)));
			},
		],
		[
			"DELETE",
			"/personas/:persona",
			async ({ persona: id }) => {
				this.#persona(id!);
				this.personas.delete(id!);
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

		// Connected apps (remote MCP servers).
		["GET", "/mcp", () => ({ servers: this.#describeApps() })],
		[
			"POST",
			"/mcp",
			async (_params, request) => {
				const body = await readJson<{ name: string; url: string; headers: Record<string, string>; approval: McpApproval }>(
					request,
				);
				if (typeof body.name !== "string" || body.name.trim() === "") throw new HttpError(400, "name is required");
				if (typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) throw new HttpError(400, "url must be http(s)");
				if (body.approval !== undefined && !MCP_APPROVALS.includes(body.approval)) {
					throw new HttpError(400, `approval must be one of ${MCP_APPROVALS.join(", ")}`);
				}
				const headers = body.headers;
				if (headers !== undefined && (typeof headers !== "object" || Object.values(headers).some((v) => typeof v !== "string"))) {
					throw new HttpError(400, "headers must map names to strings");
				}
				const result = await this.connectApp(body.name.trim(), body.url, {
					...(headers ? { headers } : {}),
					...(body.approval ? { approval: body.approval } : {}),
				});
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
				await this.removeMcpServer(id!);
				this.store.deleteMcpApproval(id!);
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

	/** Rebuilds the extensions whose tools describe the approval policy, once pi's registry has been set up. */
	#reinstallApprovals(): void {
		if (!this.registry.snapshot().extension("pim.approvals")) return;
		this.registry.install(approvalsExtension(this.services(), this.actions));
		this.#installApps();
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
		return this.apps.servers().map((server) => ({
			...server,
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
					message.content,
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
