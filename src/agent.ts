import type { JsonValue } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { type AgentEventStream, createRegistry, Harness } from "@earendil-works/pi-durable";
import { Agent, type Connection, type ConnectionContext, type Schedule, type WSMessage } from "agents";
import { type PiModel, PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { approvalsExtension, type GatedAction, httpRequest } from "./extensions/approvals";
import { goalsExtension } from "./extensions/goals";
import { memoryExtension } from "./extensions/memory";
import { notifyExtension } from "./extensions/notify";
import { personaExtension } from "./extensions/persona";
import { describeSchedule, scheduleExtension } from "./extensions/schedule";
import type { PimServices, ScheduledTaskPayload } from "./extensions/services";
import { webExtension } from "./extensions/web";
import { dispatch, HttpError, readJson, type Route } from "./http";
import type { ClientMessage, ServerMessage, ToolInfo } from "./protocol";
import { type Approval, type GoalStatus, type Notification, PimStore } from "./store";
import { projectEntries } from "./transcript";

const SCHEDULED_TASK_CALLBACK = "runScheduledTask";
const SESSION_ID = /^[1-9][0-9]{0,15}$/;
const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "done", "abandoned"];

type SocketState = { readonly session: string };

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
	readonly registry = createRegistry();
	/** Actions that run only after the user approves them. */
	readonly actions: readonly GatedAction[] = [httpRequest as GatedAction];

	readonly harness = new PiHarness({
		harness: ({ storage, context }) => {
			const services = this.services();
			this.registry.install(personaExtension(services));
			this.registry.install(memoryExtension(services));
			this.registry.install(goalsExtension(services));
			this.registry.install(scheduleExtension(services));
			this.registry.install(notifyExtension(services));
			this.registry.install(approvalsExtension(services, this.actions));
			this.registry.install(webExtension({ ai: this.env.AI, searchProvider: this.env.PIM_WEB_SEARCH }));
			return Harness.open(
				storage,
				{
					models: this.models(),
					registry: this.registry,
					settings: {
						// 1, 2, 4, 8, 16 s: about 30 s for a rate-limited model to recover.
						retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
						// Fewer storage writes while streaming; a crash loses at most this window.
						progress: { partialIntervalMs: 250, outputIntervalMs: 250 },
					},
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
	}

	/** The model catalog pi resolves sessions' models against. */
	protected models(): Models {
		const models = createModels();
		models.setProvider(this.ai.provider);
		return models;
	}

	/** The model new sessions start with. */
	protected defaultModel(): PiModel {
		return this.ai(this.env.PIM_MODEL);
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
		// Sockets survive hibernation and restarts; their watches do not.
		for (const connection of this.getConnections<SocketState>()) {
			if (connection.state?.session) await this.#watch(connection, connection.state.session);
		}
	}

	// Background work

	/** Fired by `schedule_task` schedules: hands the instruction to the session that made it. */
	async runScheduledTask(payload: ScheduledTaskPayload, schedule: Schedule<ScheduledTaskPayload>): Promise<void> {
		const label = payload.label ? ` "${payload.label}"` : "";
		await this.harness.submit(`[Scheduled task${label} ${schedule.id}] ${payload.instruction}`, {
			session: payload.session,
			// The same firing retried is one submission.
			operationId: `schedule:${schedule.id}:${schedule.time}`,
		});
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
		await this.harness.submit(message, { session: approval.session, operationId: `approval:${id}` });
		const decided = this.store.approval(id)!;
		this.broadcastMessage({ type: "approval", approval: decided });
		return decided;
	}

	tools(): ToolInfo[] {
		const gated = new Set(this.actions.map((action) => action.name));
		return this.registry
			.snapshot()
			.tools()
			.map(({ tool }) => ({ name: tool.name, description: tool.description, requiresApproval: gated.has(tool.name) }));
	}

	// HTTP API

	async onRequest(request: Request): Promise<Response> {
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
				model: this.env.PIM_MODEL,
				timeZone: this.env.PIM_TIME_ZONE || "UTC",
				rootSession: ROOT_SESSION,
				tools: this.tools(),
			}),
		],

		// Sessions: separate conversations, each with its own transcript and runs.
		["GET", "/sessions", async () => ({ sessions: await this.harness.sessions.list() })],
		["POST", "/sessions", async () => ({ id: (await this.harness.sessions.create()).id })],
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
				const receipt = await this.harness.submit(body.content, {
					session: id,
					...(body.whenBusy ? { whenBusy: body.whenBusy } : {}),
					...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
				});
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

		// Memory: what the agent knows about the person. They can always make it forget.
		[
			"GET",
			"/memories",
			(_params, _request, url) => {
				const query = url.searchParams.get("q");
				return { memories: query ? this.store.searchMemories(query, 100) : this.store.memories() };
			},
		],
		[
			"POST",
			"/memories",
			async (_params, request) => {
				const { content } = await readJson<{ content: string }>(request);
				if (typeof content !== "string" || content.trim() === "") throw new HttpError(400, "content must be a non-empty string");
				return Response.json(this.store.addMemory(content.trim()), { status: 201 });
			},
		],
		[
			"DELETE",
			"/memories/:id",
			({ id }) => {
				if (!this.store.deleteMemory(id!)) throw new HttpError(404, `No memory ${id}`);
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
				return await handle.submit(message.content, {
					...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
					...(message.operationId ? { operationId: message.operationId } : {}),
				});
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
