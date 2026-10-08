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
import { CHATGPT_PROVIDER, ChatGPT, chatgptCredentials } from "./chatgpt";
import { SqlCredentialStore } from "./credentials";
import { AppCatalog } from "./extensions/app-catalog";
import { AppEvents, eventTools, watchAction } from "./extensions/app-events";
import { skillTools } from "./extensions/app-skills";
import { approvalsExtension, type GatedAction, httpRequest } from "./extensions/approvals";
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
import { type Approval, type GoalStatus, type Notification, PimStore } from "./store";
import { projectEntries } from "./transcript";

const SCHEDULED_TASK_CALLBACK = "runScheduledTask";
/** Where MCP servers send the user back after OAuth sign-in; served without the API token. */
/**
 * A deployment is one person's agent: every request goes to the same
 * Durable Object. Anyone who wants their own Pim deploys their own copy.
 * (Not exported from the entry module: workerd reads its named exports as
 * entrypoints and refuses a string.)
 */
export const AGENT_NAME = "pim";

export const MCP_CALLBACK_PATH = "/mcp/callback";
/** Where apps deliver event webhooks, as `/mcp/events/<watch id>`; signed, so served without the API token. */
export const MCP_EVENTS_PATH = "/mcp/events/";
const WATCH_REFRESH_CALLBACK = "refreshAppWatch";
/** `pim_meta` key of the model chosen through the API. */
const MODEL_KEY = "model";
/** Set by the Worker on requests that carried the API token. */
export const AUTHORIZED_HEADER = "x-pim-authorized";
/** Accepts any JSON-RPC result: pim checks the shapes of extension results itself. */
const ANY_RESULT = { "~standard": { version: 1, vendor: "pim", validate: (value: unknown) => ({ value }) } };

const SESSION_ID = /^[1-9][0-9]{0,15}$/;
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
	readonly ai = createAI({ binding: this.env.AI });
	/** Model credentials (the ChatGPT plan's tokens), refreshed by pi-ai. */
	readonly credentials = new SqlCredentialStore(this.store);
	readonly chatgpt = new ChatGPT(this.store, chatgptCredentials(this.credentials));
	#modelCatalog: Models | undefined;
	/** Long-term memory: an OptMem-style log and summary tree. */
	readonly memory = createOptMem({
		sql: this.ctx.storage.sql,
		timeZone: this.env.PIM_TIME_ZONE || "UTC",
		viewLines: Number(this.env.PIM_MEMORY_LINES) || undefined,
		compressionModel: () => this.memoryModel(),
	});
	readonly registry = createRegistry();
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
		call: async (serverId, name, args) => this.mcp.callTool({ serverId, name, arguments: args }),
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
		if (this.apps.servers().some((server) => server.id === id)) {
			throw new HttpError(409, `An app named ${name} is already connected`);
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

	/** One catalog for pi and the API, so a token refresh is never run twice at once. */
	modelCatalog(): Models {
		this.#modelCatalog ??= this.models();
		return this.#modelCatalog;
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
		return {
			store: this.store,
			timeZone: this.env.PIM_TIME_ZONE || "UTC",
			schedule: (when, payload) => this.schedule(when, SCHEDULED_TASK_CALLBACK, payload),
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
	 * knows its activity; the user's first message also names it.
	 */
	async submitTo(
		session: string,
		content: UserInput,
		options: { operationId?: string; whenBusy?: "followUp" | "steer" },
		from: "user" | "pim",
	): Promise<PiReceipt> {
		this.store.touchSession(session, from === "user" ? titleFrom(content) : undefined);
		return this.harness.submit(content, { session, ...options });
	}

	// Background work

	/** Fired by `schedule_task` schedules: hands the instruction to the session that made it. */
	async runScheduledTask(payload: ScheduledTaskPayload, schedule: Schedule<ScheduledTaskPayload>): Promise<void> {
		const label = payload.label ? ` "${payload.label}"` : "";
		await this.submitTo(
			payload.session,
			`[Scheduled task${label} ${schedule.id}] ${payload.instruction}`,
			// The same firing retried is one submission.
			{ operationId: `schedule:${schedule.id}:${schedule.time}` },
			"pim",
		);
	}

	async deliverNotification(notification: Notification): Promise<void> {
		this.broadcastMessage({ type: "notification", notification });
		const webhook = this.env.PIM_NOTIFY_WEBHOOK;
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
	 * Applies the user's decision. An approved action runs here, outside any
	 * model turn; either way the outcome goes to the requesting session as a
	 * new message so the agent can carry on.
	 */
	async decideApproval(id: string, decision: "approve" | "deny", note?: string): Promise<Approval> {
		const approval = this.store.approval(id);
		if (!approval) throw new HttpError(404, `No approval ${id}`);
		if (!this.store.decideApproval(id, decision === "approve" ? "approved" : "denied", note ?? null)) {
			throw new HttpError(409, `Approval ${id} is already ${approval.status}`);
		}
		const noteLine = note ? `\nThe user's note: ${note}` : "";
		let message: string;
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
			message = `[Approval ${id}] The user approved: ${approval.summary}${noteLine}\nResult:\n${result}`;
		} else {
			message = `[Approval ${id}] The user denied: ${approval.summary}${noteLine}\nDo not perform this action.`;
		}
		await this.submitTo(approval.session, message, { operationId: `approval:${id}` }, "pim");
		const decided = this.store.approval(id)!;
		this.broadcastMessage({ type: "approval", approval: decided });
		return decided;
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

	// HTTP API

	async onRequest(request: Request): Promise<Response> {
		// Apps deliver events to callback URLs on this origin, so remember the one the owner uses.
		if (request.headers.get(AUTHORIZED_HEADER) === "1") {
			const origin = new URL(request.url).origin;
			if (this.store.meta("public_origin") !== origin) this.store.setMeta("public_origin", origin);
		}
		return dispatch(this.#routes, request, new URL(request.url).pathname);
	}

	async #session(id: string): Promise<string> {
		if (id === ROOT_SESSION) return id;
		if (!SESSION_ID.test(id) || !(await this.harness.sessions.list()).some((session) => session.id === id)) {
			throw new HttpError(404, `No session ${id}`);
		}
		return id;
	}

	readonly #routes: readonly Route[] = [
		[
			"GET",
			"/",
			() => ({
				model: this.chosenModel().id,
				timeZone: this.env.PIM_TIME_ZONE || "UTC",
				rootSession: ROOT_SESSION,
				tools: this.tools(),
			}),
		],

		// Sessions: separate conversations, each with its own transcript and runs.
		[
			"GET",
			"/sessions",
			async () => {
				const sessions = (await this.harness.sessions.list()).map((session) => {
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
				return {
					model: describeModel(this.chosenModel()),
					default: describeModel(fallback),
					choices: [fallback, ...chatgptModels].map(describeModel),
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
				const model = this.modelCatalog().getModel(provider, id);
				if (!model) throw new HttpError(400, `No model ${provider}/${id}`);
				if (provider === CHATGPT_PROVIDER && !(await this.chatgpt.status()).connected) {
					throw new HttpError(409, "Sign in with ChatGPT first");
				}
				return { model: describeModel(await this.chooseModel(model)) };
			},
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
				const { note } = await readJson<{ note: string }>(request);
				return this.decideApproval(id!, "approve", typeof note === "string" ? note : undefined);
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
