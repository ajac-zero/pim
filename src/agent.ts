import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
	type AgentEventStream,
	type UserInput,
	createRegistry,
	Harness,
	type HarnessSettings,
	type ModelRef,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { Agent, type Connection, type ConnectionContext, type Schedule, type WSMessage } from "agents";
import { type PiModel, PiHarness, type PiReceipt, ROOT_SESSION } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { ArtifactStore, artifactHeaders, downloadName, RESIZE_SCRIPT } from "./artifacts";
import { CHATGPT_PROVIDER, ChatGPT, chatgptCredentials } from "./chatgpt";
import { SqlCredentialStore } from "./credentials";
import { AppCatalog } from "./extensions/app-catalog";
import { AppEvents, eventTools, watchAction } from "./extensions/app-events";
import { skillTools } from "./extensions/app-skills";
import { approvalsExtension, describeWait, type GatedAction, httpRequest } from "./extensions/approvals";
import { artifactsExtension } from "./extensions/artifacts";
import { goalsExtension } from "./extensions/goals";
import {
	MCP_APPROVALS,
	type McpApproval,
	type McpBridge,
	type McpCapabilities,
	type McpResourceContent,
	mcpActions,
	mcpExtensions,
	needsApproval,
	slug,
	toolName,
} from "./extensions/mcp";
import { notifyExtension } from "./extensions/notify";
import { createOptMem } from "./extensions/optmem";
import { blockName, halves, parseBlock } from "./extensions/optmem/cover";
import { byteLength, ENTRY_BYTES, entryLine } from "./extensions/optmem/store";
import { personaExtension } from "./extensions/persona";
import { describeSchedule, scheduleExtension } from "./extensions/schedule";
import type { PimServices, ScheduledTaskPayload } from "./extensions/services";
import { webExtension } from "./extensions/web";
import { dispatch, HttpError, readJson, type Route } from "./http";
import type { ClientMessage, ServerMessage, ToolInfo } from "./protocol";
import { generateVapidKeys, type PushSubscription, sendPush, validSubscription, type VapidKeys } from "./push";
import { type ApprovalPolicy, readSettings, type Settings, updateSettings } from "./settings";
import { type Approval, type GoalStatus, type Notification, PimStore } from "./store";
import { projectEntries } from "./transcript";
import { deploymentLimits, type Limits, parseLimits, UsageMeter } from "./usage";

const SCHEDULED_TASK_CALLBACK = "runScheduledTask";
/**
 * The name of a self-hosted deployment's one agent. A hosted service names
 * each person's agent by their owner ID instead (see ./gateway.ts). (Not
 * exported from the entry module: workerd reads its named exports as
 * entrypoints and refuses a string.)
 */
export const AGENT_NAME = "pim";
/**
 * Set by the Worker on every request it forwards: the owner it resolved,
 * which must be the agent's own name. A request routed to the wrong agent is
 * refused rather than served.
 */
export const OWNER_HEADER = "x-pim-owner";

export const MCP_CALLBACK_PATH = "/mcp/callback";
/** Where apps deliver event webhooks, as `/mcp/events/<watch id>`; signed, so served without the API token. */
export const MCP_EVENTS_PATH = "/mcp/events/";
const WATCH_REFRESH_CALLBACK = "refreshAppWatch";
/** How long a tool call waits for the user under the `auto` policy before the approval is granted, so no task is blocked indefinitely. */
const APPROVAL_TIMEOUT_MS = 30_000;
/** How long a tool call waits under the `explicit` policy before the approval is denied. */
const EXPLICIT_APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** Why an approval was decided without the user deciding: it timed out, or the user always approves its tool. */
type AutoApproval = "timeout" | "always";

/** Whether the agent works: a suspended one answers nothing and runs nothing until its operator lifts it. */
export type OwnerStatus = "active" | "suspended";

/** What a hosted service tells an agent about its owner when it provisions it. */
export type OwnerProfile = { readonly ownerId: string; readonly username: string; readonly publicUrl: string };
/** How long an erasure waits for runs to stop and apps to unsubscribe before wiping anyway. */
const ERASE_COURTESY_MS = 3_000;
/** `pim_meta` key of the model chosen through the API. */
const MODEL_KEY = "model";
/** `pim_meta` keys a hosting service sets: the owner's profile, a suspension, the agent's own limits. */
const PROFILE_KEY = "owner";
const STATUS_KEY = "status";
const LIMITS_KEY = "limits";
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
	/** What the agent made for its owner, with every version. */
	readonly artifacts = new ArtifactStore(this.ctx.storage.sql, () => this.limits(), {
		storageRoom: () => {
			const { storageBytes } = this.limits();
			return storageBytes === null ? null : storageBytes - this.ctx.storage.sql.databaseSize;
		},
	});
	readonly ai = createAI({ binding: this.env.AI });
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
			this.registry.install(personaExtension(services));
			this.registry.install(goalsExtension(services));
			this.registry.install(scheduleExtension(services));
			this.registry.install(notifyExtension(services));
			this.registry.install(approvalsExtension(services, this.actions));
			this.registry.install(webExtension({ ai: this.env.AI, searchProvider: this.env.PIM_WEB_SEARCH }));
			this.registry.install(artifactsExtension({ artifacts: this.artifacts, assertOpen: () => this.#assertOpen() }));
			// Restored connections reconnect in the background after a wake; give them a moment.
			await this.mcp.waitForConnections({ timeout: 5_000 });
			const apps = mcpExtensions(this.apps, services, this.#appExtras(services));
			this.registry.install(apps.apps);
			this.registry.install(this.memory.extension);
			// Last: the apps' tools come and go, and pi only appends cheaply at the end.
			this.registry.install(apps.tools);
			return Harness.open(
				storage,
				{
					models: this.modelCatalog(),
					registry: this.registry,
					settings: this.harnessSettings(),
					onReport: (error) => console.warn("pi report", error),
				},
				context,
			);
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
				callbackPath: MCP_CALLBACK_PATH,
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
		// Same names: each replaces its installed extension in place, keeping the order.
		const services = this.services();
		const apps = mcpExtensions(this.apps, services, this.#appExtras(services));
		this.registry.install(apps.apps);
		this.registry.install(apps.tools);
	}

	/** pi's run policy, shared by every session. */
	protected harnessSettings(): HarnessSettings {
		return {
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
	 * self-hosted Pim always has; a hosted service lists the ones it pays for.
	 */
	#allowedModels(): string[] | null {
		const list = (this.env.PIM_MODELS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
		return list.length === 0 ? null : list;
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
			get approvalPolicy() {
				return pim.settings().approvalPolicy;
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
			approvalRequested: async (approval) => this.broadcastMessage({ type: "approval", approval }),
			awaitApproval: (approval) => this.#awaitApproval(approval),
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
		this.store.touchSession(session, from === "user" ? titleFrom(content) : undefined);
		let receipt: PiReceipt;
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

	async deliverNotification(notification: Notification): Promise<void> {
		if (this.#closed()) return;
		this.broadcastMessage({ type: "notification", notification });
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

	/** Tool calls waiting for a decision, by approval id; each resolves with the outcome the model reads. */
	readonly #approvalWaiters = new Map<string, (outcome: string) => void>();

	/**
	 * Holds a tool call until the user decides or the approval's timeout
	 * passes, which decides it as the policy it was filed under says: approved
	 * (`auto`) or denied (`explicit`). A tool the user always approves is
	 * approved at once. Returns the outcome, so the turn carries on. A decided
	 * approval (a replayed call) returns its recorded outcome at once.
	 */
	async #awaitApproval(approval: Approval): Promise<string> {
		if (approval.status !== "pending") return this.#outcome(approval);
		return this.keepAliveWhile(async () => {
			const decided = new Promise<string>((resolve) => this.#approvalWaiters.set(approval.id, resolve));
			const always = approval.tool !== null && this.store.alwaysApproves(approval.tool);
			const onTimeout = always ? "approve" : approval.onTimeout;
			const timer = setTimeout(
				() => {
					this.decideApproval(approval.id, onTimeout, undefined, always ? "always" : "timeout").catch((error) =>
						console.warn(`deciding ${approval.id} on its timeout failed`, error),
					);
				},
				always ? 0 : Math.max(0, (approval.expiresAt ?? Date.now() + this.approvalTimeoutMs()) - Date.now()),
			);
			try {
				return await decided;
			} finally {
				clearTimeout(timer);
				this.#approvalWaiters.delete(approval.id);
			}
		});
	}

	/** How long approvals filed under `policy` wait for the user. */
	protected approvalTimeoutMs(policy: ApprovalPolicy = this.settings().approvalPolicy): number {
		return policy === "explicit" ? EXPLICIT_APPROVAL_TIMEOUT_MS : APPROVAL_TIMEOUT_MS;
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
	 * action runs here. The outcome goes to the tool call waiting for it, so
	 * its turn continues; with no call waiting (it was evicted, or the turn was
	 * stopped) it goes to the requesting session as a new message instead.
	 */
	async decideApproval(id: string, decision: "approve" | "deny", note?: string, auto?: AutoApproval): Promise<Approval> {
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
		const message = this.#outcome(decided);
		const waiter = this.#approvalWaiters.get(id);
		if (waiter) waiter(message);
		else await this.submitTo(approval.session, message, { operationId: `approval:${id}` }, "approval");
		this.broadcastMessage({ type: "approval", approval: decided });
		return decided;
	}

	/**
	 * Approves `id` and every later call to the same tool. Other calls to that
	 * tool still waiting for the user are approved too.
	 */
	async alwaysApprove(id: string, note?: string): Promise<Approval> {
		const approval = this.store.approval(id);
		if (!approval) throw new HttpError(404, `No approval ${id}`);
		if (approval.tool === null) throw new HttpError(400, `Approval ${id} does not record its tool`);
		if (approval.status !== "pending") throw new HttpError(409, `Approval ${id} is already ${approval.status}`);
		// Remembered first, so calls filed while this action runs are not asked about.
		this.store.alwaysApprove(approval.tool);
		for (const pending of this.store.approvals("pending")) {
			if (pending.tool !== approval.tool || pending.id === id) continue;
			void this.decideApproval(pending.id, "approve", undefined, "always").catch((error) =>
				console.warn(`approving ${pending.id} failed`, error),
			);
		}
		return this.decideApproval(id, "approve", note);
	}

	tools(): ToolInfo[] {
		const gated = new Set(this.actions.map((action) => action.name));
		const servers = new Map(this.apps.servers().map((server) => [server.id, server]));
		for (const tool of this.apps.tools()) {
			const server = servers.get(tool.serverId);
			if (server && needsApproval(tool, server.approval)) gated.add(toolName(server.id, tool.name));
		}
		return this.registry
			.snapshot()
			.tools()
			.map(({ tool }) => ({ name: tool.name, description: tool.description, requiresApproval: gated.has(tool.name) }));
	}

	// Hosting: what the Worker in front tells the agent about its owner.

	/** Set while `deleteEverything` runs: the agent takes nothing new. */
	#erasing = false;

	/**
	 * Whether the agent is erased, or being erased. An erased agent keeps
	 * only its mark and refuses everything: requests, sockets, alarms and the
	 * hosting service's writes. The check is here, in the one object every
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

	/** Changes the person's settings, as `PUT /settings` does; a hosted service sets their time zone at registration. */
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
			alwaysApproved: this.store.alwaysApproved(),
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

	async #session(id: string): Promise<string> {
		// The root stays reachable when deleted: it is where API clients talk by default.
		if (id === ROOT_SESSION) return id;
		if (
			!SESSION_ID.test(id) ||
			this.store.deletedSessions().has(id) ||
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
				const deleted = this.store.deletedSessions();
				const sessions = (await this.harness.sessions.list()).filter((session) => !deleted.has(session.id)).map((session) => {
					const info = this.store.sessionInfo(session.id);
					return {
						...session,
						title: info?.title ?? null,
						createdAt: info?.createdAt ?? null,
						updatedAt: info?.updatedAt ?? null,
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
				const { title } = await readJson<{ title: string }>(request);
				const { sessions } = this.limits();
				if (sessions !== null) {
					const deleted = this.store.deletedSessions();
					const open = (await this.harness.sessions.list()).filter((session) => !deleted.has(session.id)).length;
					if (open >= sessions) throw new HttpError(429, `You can have up to ${sessions} chats. Delete one first.`);
				}
				const { id } = await this.harness.sessions.create();
				await this.harness.session(id).setModel(this.chosenModel());
				this.store.touchSession(id, typeof title === "string" && title.trim() !== "" ? clipTitle(title) : undefined);
				return { id, ...this.store.sessionInfo(id) };
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
				return this.harness.wait(receipt.operationId, { session: id });
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
					return await this.harness.wait(operation!, { session: id, signal });
				} catch (error) {
					if (signal.aborted) return { operationId: operation, session: id, status: "pending" };
					throw error;
				}
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
		["GET", "/always-approved", () => ({ tools: this.store.alwaysApproved() })],
		[
			"DELETE",
			"/always-approved/:tool",
			({ tool }) => {
				if (!this.store.stopAlwaysApproving(tool!)) throw new HttpError(404, `${tool} is not always approved`);
				return { deleted: true };
			},
		],

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
		return { ...settings, approvalTimeoutSeconds: this.approvalTimeoutMs(settings.approvalPolicy) / 1000 };
	}

	/** Rebuilds the extensions whose tools describe the approval policy, once pi's registry has been set up. */
	#reinstallApprovals(): void {
		if (!this.registry.snapshot().extension("pim.approvals")) return;
		this.registry.install(approvalsExtension(this.services(), this.actions));
		this.#installApps();
	}

	#describeApps() {
		const catalog = this.apps.tools();
		return this.apps.servers().map((server) => ({
			...server,
			tools: catalog
				.filter((tool) => tool.serverId === server.id)
				.map((tool) => ({
					name: toolName(server.id, tool.name),
					description: tool.description ?? null,
					requiresApproval: needsApproval(tool, server.approval),
				})),
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
