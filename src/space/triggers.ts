/**
 * Pim's bridge to `@pim/triggers`: the engine and its wake, handing a trigger's run on to a chat, the computer's grants and triggers, the
 * subscriptions of triggers on connectors' events and their deliveries, and the triggers' API and routes.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ConversationInit, EntryId } from "@earendil-works/pi-durable";
import type { Connection } from "agents";
import { type PiModel, PiHarness } from "agents/harness/pi";
import { AppCatalog } from "../extensions/app-catalog";
import type { WatchHost, WatchSubscription } from "../extensions/app-events";
import type { DirectoryApp } from "../extensions/app-directory";
import { type McpBridge, serverFor } from "../extensions/mcp";
import { describeTask, type ScheduleHost, ScheduledTasks, scheduledTaskText, scheduledTriggers } from "../extensions/schedule";
import type { PimServices } from "../extensions/services";
import { COMPUTER_TAG, Computer } from "../computer";
import type { DeploymentSettings } from "../deployment";
import type { Route } from "@pim/shared/http";
import type { ServerMessage } from "../protocol";
import { type Notification, PimStore } from "../store";
import { type Agent, AgentStore } from "../agents";
import { idempotencyKey, ifMatch, PERSON, queryOf, type TriggerAnswer, TriggerApi, TriggerApiError, triggerBody } from "@pim/triggers/api";
import { COMPUTER_GRANT_ACTION, ComputerGrants, ComputerTriggers, runtimeIdOf } from "@pim/triggers/computer";
import { type ComputerGrantHost, computerGrantAction, grantRequest, recordGrant } from "../triggers/grant-action";
import { ENGINE_KEY, TRIGGER_TICK_CALLBACK, TriggerEngine } from "@pim/triggers/engine";
import { ConnectorEventData, ConnectorIngress, eventContents, ingressResponse } from "@pim/triggers/connector";
import { ConnectorSubscriptionManager, type ProviderAnswer, type SubscriptionProvider } from "@pim/triggers/subscriptions";
import { TriggerChatDoc, type TriggerSpace, type TriggerTakeover } from "@pim/triggers/host";
import type { ConnectorEventSource, TriggerDestination } from "@pim/triggers/spec";
import { TRIGGERS_EXTENSION, triggersExtension } from "../triggers/tools";
import type { Role } from "../tasks";
import { type Limits, UsageMeter } from "../usage";
import { VisitStore } from "../visits";
import type { Submit } from "./conversations";
import { MCP_EVENTS_PATH, type OwnerStatus, type OwnerProfile, type GuestBot, clipTitle } from "./shared";

/** What the space's bridge to `@pim/triggers` needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface TriggersHost {
	readonly ctx: DurableObjectState<{}>;
	readonly roleOf: (session: string) => Role;
	readonly agents: AgentStore;
	readonly limits: () => Limits;
	readonly triggerClock: () => number;
	readonly store: PimStore;
	readonly closed: () => boolean;
	readonly computer: Computer;
	readonly deliverNotification: (notification: Notification, options?: { sockets?: boolean; push?: boolean; }) => Promise<void>;
	readonly apps: McpBridge;
	readonly name: string;
	readonly getConnections: <TState = unknown>(tag?: string) => Iterable<Connection<TState>>;
	readonly assertOpen: () => void;
	readonly registry: import("@earendil-works/pi-durable").Registry<import("@earendil-works/pi-durable").ToolRegistration>;
	readonly profile: () => OwnerProfile | null;
	readonly guestBot: () => GuestBot | null;
	readonly note: (event: string, fields: Record<string, unknown>) => void;
	readonly deployment: () => DeploymentSettings;
	readonly appsOf: (agent: Agent) => DirectoryApp[];
	readonly catalog: AppCatalog;
	readonly installComputerGrants: (services: PimServices) => void;
	readonly services: () => PimServices;
	readonly mcp: import("../../node_modules/agents/dist/agent-routing-Bhdbvf7s").It;
	readonly usage: UsageMeter;
	readonly listSchedules: (criteria?: import("agents").ScheduleCriteria) => Promise<import("agents").Schedule<unknown>[]>;
	readonly cancelSchedule: (id: string) => Promise<boolean>;
	readonly schedule: (when: Date | string | number, callback: string, payload?: unknown, options?: { idempotent?: boolean }) => Promise<unknown>;
	readonly status: () => OwnerStatus;
	readonly hiddenSessions: () => Set<string>;
	readonly visits: VisitStore;
	readonly harness: PiHarness;
	readonly carriedOn: (session: string) => Promise<string>;
	readonly startChat: (agent: Agent, title: string | undefined, from?: { session: string; at: EntryId; }, init?: ConversationInit) => Promise<string>;
	readonly broadcastMessage: (message: ServerMessage) => void;
	readonly sessionModel: (session: string, agent?: Agent) => PiModel;
	readonly submitTo: Submit;
}

export class SpaceTriggers {
	constructor(private readonly host: TriggersHost) {}

	// Background work

	#scheduledTasksKept: ScheduledTasks | undefined;

	/** What scheduling (./extensions/schedule.ts) needs of the space: its triggers, as the agent or the person. */
	scheduleHost(): ScheduleHost {
		return {
			api: () => this.triggerApi(),
			tasks: () => {
				this.#scheduledTasksKept ??= new ScheduledTasks(this.host.ctx.storage.sql);
				return this.#scheduledTasksKept;
			},
			roleOf: (session) => this.host.roleOf(session),
			agentOf: (id) => this.host.agents.get(id),
			limit: () => this.host.limits().schedules,
			now: () => this.host.triggerClock(),
			chatAgent: (chat) => {
				const session = this.host.store.sessionOf(chat);
				return session === undefined ? null : (this.host.agents.findOfSession(session)?.id ?? null);
			},
			sessionOf: (chat) => this.host.store.sessionOf(chat) ?? null,
		};
	}

	/** The scheduled tasks of the space, as the person sees them; none where its triggers are off. */
	scheduledTasks() {
		const api = this.triggerApi();
		const host = this.scheduleHost();
		return api ? scheduledTriggers(api, PERSON).map((trigger) => describeTask(host, trigger)) : [];
	}

	// Triggers (docs/triggers.md), built only where turned on.

	#triggerEngine: TriggerEngine | undefined;

	/** Changes to the trigger wake, one after another. */
	#triggerWake: Promise<void> = Promise.resolve();

	/**
	 * This space's time triggers, once they are on (`enableTriggerEngine`,
	 * which `ensureTriggerEngine` calls in a person's own space as it starts
	 * and as they register); null otherwise, and then nothing of them exists:
	 * no table, no wake.
	 */
	triggerEngine(): TriggerEngine | null {
		if (this.host.closed() || this.host.store.meta(ENGINE_KEY) !== "on") return null;
		this.#triggerEngine ??= new TriggerEngine(this.host.ctx.storage.sql, {
			transaction: (work) => this.host.ctx.storage.transactionSync(work),
			now: () => this.host.triggerClock(),
			space: this.#triggerSpace(),
			// Computer sources' grants are checked against the computer paired now, so with none no grant is current; their occurrences are handed on, and the computer told of changes.
			authorize: this.#computerGrants().authorize(() => runtimeIdOf(this.host.computer.tokenDigest())),
			changed: () => this.computerTriggers()?.refresh(),
			takeover: this.#triggerTakeover(),
		});
		return this.#triggerEngine;
	}

	/**
	 * How a trigger `schedule_task` made reads and notifies as its schedules
	 * did (./extensions/schedule.ts). And for every trigger on a connector's
	 * event, as watches always did: its run is told what the event carried,
	 * which the events route kept, and which is forgotten once pi has it.
	 */
	#triggerTakeover(): TriggerTakeover {
		const sql = this.host.ctx.storage.sql;
		const task = (evidence: { kind: string; triggerId: string }) => (evidence.kind === "time" ? this.scheduleHost().tasks().of(evidence.triggerId) : undefined);
		// As schedules notified: once per firing, by its key, to open apps only; the chat's own reply is pushed when it is ready.
		const notify = async (submissionKey: string, chatId: string, title: string) => {
			if (this.host.store.notification(submissionKey)) return;
			const notification = this.host.store.addNotification({ id: submissionKey, kind: "scheduled", session: chatId, title: title.length > 80 ? `${title.slice(0, 79)}…` : title, body: "" });
			await this.host.deliverNotification(notification, { push: false });
		};
		return {
			text: (instruction, evidence) => {
				const scheduled = task(evidence);
				return scheduled ? scheduledTaskText(evidence.triggerId, scheduled.label, instruction) : null;
			},
			contents: (evidence) => {
				if (evidence.kind !== "connector_event") return null;
				const data = new ConnectorEventData(sql).read(evidence.triggerId, evidence.eventId, this.host.triggerClock());
				if (data === null) return null;
				const app = this.host.apps.servers().find((server) => server.id === evidence.connectorId)?.name ?? evidence.connectorId;
				return eventContents(app, data);
			},
			delivered: async (evidence, chatId, submissionKey) => {
				if (evidence.kind === "connector_event") {
					new ConnectorEventData(sql).forget(evidence.triggerId, evidence.eventId);
					return;
				}
				const scheduled = task(evidence);
				if (scheduled && evidence.kind === "time") await notify(submissionKey, chatId, scheduled.label ?? evidence.label);
			},
		};
	}

	#computerGrantsKept: ComputerGrants | undefined;

	#computerTriggersKept: ComputerTriggers | undefined;

	/** The grants of computer sources. */
	#computerGrants(): ComputerGrants {
		this.#computerGrantsKept ??= new ComputerGrants(this.host.ctx.storage.sql, { approval: (id) => this.host.store.approval(id), space: this.host.name, now: () => this.host.triggerClock() });
		return this.#computerGrantsKept;
	}

	/**
	 * Triggers on the person's computer (./triggers/computer.ts), when the
	 * space's trigger engine is on; null otherwise, and then nothing of them
	 * exists.
	 */
	computerTriggers(): ComputerTriggers | null {
		const engine = this.triggerEngine();
		if (!engine) return null;
		this.#computerTriggersKept ??= new ComputerTriggers(this.host.ctx.storage.sql, {
			store: engine.store,
			grants: this.#computerGrants(),
			transaction: (work) => this.host.ctx.storage.transactionSync(work),
			now: () => this.host.triggerClock(),
			space: this.host.name,
			tokenDigest: () => this.host.computer.tokenDigest(),
			socket: (id) => [...this.host.getConnections(COMPUTER_TAG)].find((connection) => connection.id === id && connection.readyState === WebSocket.OPEN),
			// Renewals and handoffs go by the triggers' wake, an alarm, which outlasts the Durable Object's eviction.
			wake: () => void this.wakeTriggers().catch((error) => console.warn("setting the trigger wake failed", error)),
		});
		return this.#computerTriggersKept;
	}

	/** What asking for and recording a computer source's grant may do in this space. */
	computerGrantHost(): ComputerGrantHost {
		const off = "Triggers on the computer are off in this space.";
		return {
			request: (triggerId) => {
				const triggers = this.computerTriggers();
				const engine = this.triggerEngine();
				return triggers && engine ? grantRequest(engine.store, this.host.name, triggers.runtimeId(), triggerId) : { refused: off };
			},
			granted: (approvalId) => {
				const triggers = this.computerTriggers();
				const engine = this.triggerEngine();
				if (!triggers || !engine) throw new Error(off);
				const said = recordGrant(engine.store, this.#computerGrants(), approvalId);
				triggers.refresh();
				// A trigger pointed at its grant may have work due now, which only the wake hands on.
				void this.wakeTriggers().catch((error) => console.warn("setting the trigger wake failed", error));
				return said;
			},
		};
	}

	/** The action an approved grant runs, which refuses where the space's trigger engine is off. */
	readonly computerGrantAction = computerGrantAction(() => (this.computerTriggers() ? this.computerGrantHost() : null));

	/**
	 * Internal: revokes a grant of a computer source, for good. What its
	 * source observes is refused from now on, its observer stops at once,
	 * and an occurrence not yet handed on never is. False where there was no
	 * such grant, or the space's triggers are off.
	 */
	revokeComputerGrant(grantRef: string): boolean {
		const triggers = this.computerTriggers();
		if (!triggers) return false;
		const revoked = this.#computerGrants().revoke(grantRef);
		triggers.refresh();
		return revoked;
	}

	/** Internal: turns this space's triggers on, whoever's space it is; `ensureTriggerEngine` is what decides who gets them. */
	async enableTriggerEngine(): Promise<void> {
		this.host.assertOpen();
		this.host.store.setMeta(ENGINE_KEY, "on");
		// Once pi's registry is set up; before, setting it up installs them.
		if (this.host.registry.snapshot().extension("pim.approvals")) this.installTriggerTools();
		await this.wakeTriggers();
	}

	/**
	 * Internal: turns the space's triggers off, until it next starts or
	 * `enableTriggerEngine` is called. Nothing is handed on and no wake is
	 * kept until they are on again; everything they recorded stays, and runs
	 * already going go on.
	 */
	async disableTriggerEngine(): Promise<void> {
		// Nothing hands an event on while triggers are off, and no wake sweeps: what was kept of connector events goes now. A run handed on later is told it isn't kept.
		new ConnectorEventData(this.host.ctx.storage.sql).clear();
		this.host.store.deleteMeta(ENGINE_KEY);
		this.#triggerEngine = undefined;
		this.#computerTriggersKept?.stop();
		this.#computerTriggersKept = undefined;
		this.connectorSubscriptionsKept = undefined;
		this.installTriggerTools();
		await this.wakeTriggers();
	}

	/**
	 * Turns triggers on in a person's own space, as it starts and as they
	 * register; a guest's space, or one not yet provisioned, is left without
	 * them. Idempotent: a space that has them keeps them and everything they
	 * recorded. It never throws, so a failure can't keep the space from
	 * starting: the space is left without them, as it was, the failure is
	 * logged, and the next start tries again.
	 */
	async ensureTriggerEngine(): Promise<void> {
		try {
			if (this.host.closed() || this.host.store.meta(ENGINE_KEY) === "on" || this.host.profile() === null || this.host.guestBot() !== null) return;
			await this.enableTriggerEngine();
			console.log(JSON.stringify({ event: "pim.triggers_on", owner: this.host.name }));
		} catch (error) {
			this.host.note("triggers_on_failed", { error: String(error) });
			try {
				this.host.store.deleteMeta(ENGINE_KEY);
				this.#triggerEngine = undefined;
				if (this.host.registry.snapshot().extension(TRIGGERS_EXTENSION)) this.installTriggerTools();
			} catch (undoing) {
				this.host.note("triggers_on_failed", { error: String(undoing) });
			}
		}
	}

	connectorSubscriptionsKept: { readonly engine: TriggerEngine; readonly manager: ConnectorSubscriptionManager } | undefined;

	/**
	 * The subscriptions of triggers on connectors' events
	 * (./triggers/subscriptions.ts), where the space's triggers are on; null
	 * otherwise. Each is made, renewed and undone through the connector's MCP
	 * client, with a callback URL on `MCP_EVENTS_PATH`, and ticked from the
	 * trigger wake.
	 */
	#connectorSubscriptions(): ConnectorSubscriptionManager | null {
		const engine = this.triggerEngine();
		if (!engine) return null;
		if (this.connectorSubscriptionsKept?.engine !== engine) {
			const request = async (connectorId: string, method: string, params: Record<string, unknown>): Promise<ProviderAnswer<never>> => {
				try {
					return { ok: true, value: (await this.host.apps.request(connectorId, method, params)) as never };
				} catch (error) {
					// The connector's refusal, with its code; anything else (not connected, no answer) is unknown, and tried again.
					const code = (error as { code?: unknown } | null)?.code;
					if (typeof code === "number" && Number.isSafeInteger(code)) return { ok: false, code };
					throw error;
				}
			};
			const provider: SubscriptionProvider = {
				connector: (id) => {
					const server = this.host.apps.servers().find((candidate) => candidate.id === id);
					return !server ? "removed" : server.state === "ready" ? "connected" : "disconnected";
				},
				subscribe: ({ connectorId, name, arguments: args, delivery, cursor, ttlMs }) => request(connectorId, "events/subscribe", { name, arguments: args, delivery, cursor, ttlMs }),
				unsubscribe: ({ connectorId, name, arguments: args, delivery }) => request(connectorId, "events/unsubscribe", { name, arguments: args, delivery }),
			};
			const manager = new ConnectorSubscriptionManager(this.host.ctx.storage.sql, {
				store: engine.store,
				provider,
				transaction: (work) => this.host.ctx.storage.transactionSync(work),
				now: () => this.host.triggerClock(),
				owner: () => this.host.name,
				callbackUrl: ({ owner, key }) => `${(this.host.deployment().publicUrl ?? "").replace(/\/$/, "")}${MCP_EVENTS_PATH}${owner}/${key}`,
			});
			this.connectorSubscriptionsKept = { engine, manager };
		}
		return this.connectorSubscriptionsKept.manager;
	}

	/** Sends what triggers' subscriptions call for now, then sets the wake for what is left. Never throws. */
	async #syncConnectorSubscriptions(): Promise<void> {
		try {
			await this.#connectorSubscriptions()?.tick();
			await this.wakeTriggers();
		} catch (error) {
			console.warn("keeping connector subscriptions failed", error);
		}
	}

	/** What the watch tools (./extensions/app-events.ts) need: watches are triggers on connectors' events. */
	readonly watchHost: WatchHost = {
		api: () => this.triggerApi(),
		actor: (session) => {
			const { agent } = this.host.roleOf(session);
			return { kind: "agent", agentId: agent.id, majordomo: agent.majordomo, chatId: session };
		},
		publicUrl: () => this.host.deployment().publicUrl ?? null,
		sync: () => this.#syncConnectorSubscriptions(),
		subscription: (triggerId): WatchSubscription => {
			const engine = this.triggerEngine();
			const trigger = engine?.store.get(triggerId);
			const lastEventAt = engine?.store.sourceState(triggerId)?.lastObservedAt ?? null;
			const binding = trigger ? this.#connectorSubscriptions()?.bindings(triggerId).filter((candidate) => candidate.generation === trigger.generation).at(-1) : undefined;
			if (!binding) return { status: "pending", lastError: null, renewsBefore: null, lastEventAt };
			const status = binding.phase !== "open" || binding.status !== "active" ? "ended" : binding.grant ? "active" : "pending";
			return { status, lastError: binding.lastError, renewsBefore: binding.grant?.refreshBefore ?? null, lastEventAt };
		},
	};

	/**
	 * Deletes the triggers on connectors' events `which` picks, and asks
	 * their connectors to unsubscribe now, as stopping a watch always did:
	 * for a chat deleted, or a connector about to be removed.
	 */
	async stopConnectorTriggers(which: (source: ConnectorEventSource, destination: TriggerDestination) => boolean): Promise<void> {
		const engine = this.triggerEngine();
		if (!engine) return;
		let stopped = false;
		for (const trigger of engine.store.list()) {
			const spec = trigger.spec;
			if (trigger.lifecycle === "deleted" || spec.source.kind !== "connector_event" || !which(spec.source, spec.destination)) continue;
			engine.store.remove({ id: trigger.id });
			stopped = true;
		}
		if (stopped) await this.#syncConnectorSubscriptions();
	}

	/**
	 * One delivery to `/mcp/events/<owner>/<key>`, which names a trigger's
	 * subscription: taken in by the ingress adapter (./triggers/connector.ts)
	 * with the binding's own secret and provider subscription id, and what
	 * the event carried kept for its run until pi has it. Anything else
	 * answers as the adapter says: `410` for a key that names nothing.
	 */
	async receiveConnectorEvent(key: string, request: Request): Promise<Response> {
		const engine = this.triggerEngine();
		const subscriptions = this.#connectorSubscriptions();
		if (!engine || !subscriptions) return new Response("Gone", { status: 410 });
		const sql = this.host.ctx.storage.sql;
		const ingress = new ConnectorIngress({
			store: engine.store,
			now: () => this.host.triggerClock(),
			transaction: (work) => this.host.ctx.storage.transactionSync(work),
			host: {
				...subscriptions.ingressHost(),
				// A subscription is the connector's, whether or not its client is up here; removing the connector ends it.
				connector: (id) => (this.host.apps.servers().some((server) => server.id === id) ? "connected" : "removed"),
			},
			kept: (admitted) => new ConnectorEventData(sql).keep({ ...admitted, data: JSON.stringify(admitted.data, null, 2) }),
		});
		const outcome = await ingress.receive({ owner: this.host.name, key }, request);
		if (outcome.disposition === "accepted" && outcome.reason === "admitted") await this.wakeTriggers();
		return ingressResponse(outcome);
	}

	#triggerApiKept: TriggerApi | undefined;

	/**
	 * Triggers' API (./triggers/api.ts), where the space's triggers are on and
	 * it isn't a guest's space; null otherwise, and then no route or tool of
	 * it exists.
	 */
	triggerApi(): TriggerApi | null {
		const engine = this.triggerEngine();
		if (!engine || this.host.guestBot()) return null;
		if (this.#triggerApiKept?.engine !== engine) {
			this.#triggerApiKept = new TriggerApi(this.host.ctx.storage.sql, {
				engine,
				transaction: (work) => this.host.ctx.storage.transactionSync(work),
				now: () => this.host.triggerClock(),
				// The wake is the only thing that ticks the coordinator: a trigger made or changed, through a route or a tool, is due by it.
				changed: () => this.wakeTriggers(),
				host: {
					agentExists: (id) => this.host.agents.get(id) !== undefined,
					majordomoId: () => this.host.agents.majordomo().id,
					chatAgent: (chat) => this.host.agents.findOfSession(chat)?.id ?? null,
					chatOpen: (chat) => this.#triggerSpace().chatOpen(chat),
					publicChat: (chat) => this.host.store.publicId(chat),
					chatOf: (id) => this.host.store.sessionOf(id) ?? null,
					connectors: (agentId) => {
						const servers = this.host.apps.servers();
						const agent = agentId === null ? undefined : this.host.agents.get(agentId);
						const offered = agentId === null ? servers : agent ? this.host.appsOf(agent).flatMap((app) => serverFor(servers, app) ?? []) : [];
						return offered.map((server) => ({ connectorId: server.id, name: server.name, events: this.host.catalog.events(server.id).map((event) => event.name) }));
					},
					computer: () => ({ paired: this.host.computer.paired() }),
					grant: (trigger) => {
						const ref = trigger.spec.authorizationRef;
						if (ref !== null && this.#computerGrants().authorize(() => runtimeIdOf(this.host.computer.tokenDigest()))({ triggerId: trigger.id, spec: trigger.spec, authorizationRef: ref, now: this.host.triggerClock() }).ok) return "current";
						const asked = this.host.store.approvals("pending").some((approval) => approval.action === COMPUTER_GRANT_ACTION && (approval.args as { triggerId?: unknown }).triggerId === trigger.id);
						return asked ? "pending_approval" : ref === null ? "missing" : "not_current";
					},
				},
			});
		}
		return this.#triggerApiKept;
	}

	/** Agents' tools for triggers, and the computer's grant tool, installed only while the API exists; chats select them (`#selectAbilities`). */
	installTriggerTools(): void {
		if (this.triggerApi()) this.host.registry.install(triggersExtension({ api: () => this.triggerApi(), roleOf: (session) => this.host.roleOf(session) }));
		else if (this.host.registry.snapshot().extension(TRIGGERS_EXTENSION)) this.host.registry.uninstall({ name: TRIGGERS_EXTENSION });
		this.host.installComputerGrants(this.host.services());
	}

	/** Answers a triggers' route: the API's value, or its refusal with its code; nothing else of an error. */
	async #triggersAnswer(work: (api: TriggerApi) => Promise<TriggerAnswer> | TriggerAnswer): Promise<Response> {
		const api = this.triggerApi();
		if (!api) return Response.json({ error: "Not found" }, { status: 404 });
		const headers: Record<string, string> = { "cache-control": "no-store" };
		try {
			const { status = 200, body, revision } = await work(api);
			if (revision !== undefined) headers.etag = `"${revision}"`;
			return Response.json(body, { status, headers });
		} catch (error) {
			if (error instanceof TriggerApiError) return Response.json(error.body(), { status: error.status, headers });
			console.error("a triggers request failed", error instanceof Error ? error.name : typeof error);
			return Response.json({ error: "Something went wrong", code: "internal" }, { status: 500, headers });
		}
	}

	/** Triggers' HTTP API (docs/triggers.md, "The API"), as the person: reached only where `#triggerApi` exists. */
	readonly triggerRoutes: readonly Route[] = [
		["GET", "/triggers", (_params, _request, url) => this.#triggersAnswer((api) => ({ body: api.list(PERSON, queryOf(url, ["lifecycle", "agentId", "sourceKind", "cursor", "limit"])) }))],
		[
			"POST",
			"/triggers",
			(_params, request) =>
				this.#triggersAnswer(async (api) => {
					const key = idempotencyKey(request);
					const made = await api.create(PERSON, await triggerBody(request), key);
					return { status: made.replayed ? 200 : 201, body: made.trigger, revision: made.trigger.revision };
				}),
		],
		// Before `/triggers/:id`, which would read it as a trigger's id.
		[
			"GET",
			"/triggers/:id",
			({ id }) =>
				this.#triggersAnswer((api) => {
					const trigger = api.get(PERSON, id);
					return { body: trigger, revision: trigger.revision };
				}),
		],
		[
			"PATCH",
			"/triggers/:id",
			({ id }, request) =>
				this.#triggersAnswer(async (api) => {
					const expected = ifMatch(request);
					const trigger = await api.update(PERSON, id, expected, await triggerBody(request));
					return { body: trigger, revision: trigger.revision };
				}),
		],
		["DELETE", "/triggers/:id", ({ id }, request) => this.#triggersAnswer(async (api) => ({ body: await api.remove(PERSON, id, ifMatch(request)) }))],
		[
			"POST",
			"/triggers/:id/pause",
			({ id }, request) =>
				this.#triggersAnswer(async (api) => {
					const trigger = await api.pause(PERSON, id, ifMatch(request));
					return { body: trigger, revision: trigger.revision };
				}),
		],
		[
			"POST",
			"/triggers/:id/resume",
			({ id }, request) =>
				this.#triggersAnswer(async (api) => {
					const trigger = await api.resume(PERSON, id, ifMatch(request));
					return { body: trigger, revision: trigger.revision };
				}),
		],
		[
			"POST",
			"/triggers/:id/test",
			({ id }, request) =>
				this.#triggersAnswer(async (api) => {
					const given = await triggerBody(request);
					if (typeof given === "object" && given !== null && ("id" in given || "trigger" in given)) {
						throw new TriggerApiError(400, "invalid_request", "request: the trigger is the one in the path", { field: "request" });
					}
					return { body: await api.test(PERSON, typeof given === "object" && given !== null && !Array.isArray(given) ? { ...given, id } : given) };
				}),
		],
		["GET", "/triggers/:id/runs", ({ id }, _request, url) => this.#triggersAnswer((api) => ({ body: api.runs(PERSON, id, queryOf(url, ["cursor", "limit"])) }))],
		["GET", "/trigger-runs/:run", ({ run }) => this.#triggersAnswer((api) => ({ body: api.run(PERSON, run) }))],
	];

	/** Fired by the trigger wake: one tick of the coordinator, then the wake for its next. */
	async runTriggerTick(): Promise<void> {
		try {
			this.computerTriggers()?.renew();
			const subscriptions = this.#connectorSubscriptions();
			// The wake usually starts the space afresh, with its connectors still reconnecting in the background: a subscription is renewed only once its connector is ready, so it doesn't lapse while it waits.
			if (subscriptions) await this.host.mcp.waitForConnections({ timeout: 20_000 });
			// Subscriptions first, so a trigger enabled since is subscribed before anything else waits on the connector.
			await subscriptions?.tick();
			await this.triggerEngine()?.coordinator.tick();
			// What connector events carried is kept a day at most.
			if (this.triggerEngine()) new ConnectorEventData(this.host.ctx.storage.sql).sweep(this.host.triggerClock());
			this.host.usage.calls.rollup(this.host.triggerClock());
		} finally {
			await this.wakeTriggers();
		}
	}

	/**
	 * Keeps the space's one trigger wake, a schedule like Pim's others, at
	 * when the coordinator next has work, at least a second on; with no work,
	 * or no engine, there is none.
	 */
	wakeTriggers(): Promise<void> {
		const next = this.#triggerWake.then(async () => {
			// The coordinator's next work, keeping connectors' subscriptions, renewing the computer's lease on its triggers, or sweeping what connector events carried, whichever comes first.
			const engine = this.triggerEngine();
			const schedules = await this.host.listSchedules();
			const due = [
				engine?.coordinator.nextWakeAt() ?? null,
				this.#connectorSubscriptions()?.nextWakeAt() ?? null,
				this.computerTriggers()?.renewAt() ?? null,
				engine ? new ConnectorEventData(this.host.ctx.storage.sql).nextSweepAt() : null,
				this.host.usage.calls.nextRollupAt(this.host.triggerClock()),
			].filter((at) => at !== null);
			const wake = due.length === 0 ? null : Math.min(...due);
			const at = wake === null ? null : Math.ceil((Date.now() + Math.max(1_000, wake - this.host.triggerClock())) / 1000);
			const wakes = schedules.filter((schedule) => schedule.callback === TRIGGER_TICK_CALLBACK);
			if (at !== null && wakes.length === 1 && wakes[0]!.time === at) return;
			for (const schedule of wakes) await this.host.cancelSchedule(schedule.id);
			if (at !== null) await this.host.schedule(new Date(at * 1000), TRIGGER_TICK_CALLBACK);
		});
		this.#triggerWake = next.catch(() => undefined);
		return next;
	}

	/** What the triggers' host may do in this space: what anything else that starts a run does, through `submitTo`. */
	#triggerSpace(): TriggerSpace {
		const conversation = (chatId: string) => (/^[1-9]\d*$/.test(chatId) ? (Number(chatId) as ConversationId) : null);
		return {
			state: () => (this.host.closed() ? "closed" : this.host.status()),
			agentExists: (agentId) => this.host.agents.get(agentId) !== undefined,
			chatAgent: (chatId) => this.host.agents.ofSession(chatId).id,
			chatOpen: async (chatId) => {
				const id = conversation(chatId);
				// Not a deleted chat, another agent's seat in a group chat, an old task's conversation, or a visit to another space.
				if (id === null || this.host.hiddenSessions().has(chatId) || this.host.visits.bySession(chatId)) return false;
				return (await (await this.host.harness.pi()).conversation(id, BACKGROUND_CONTEXT)) !== undefined;
			},
			carriedOn: (chatId) => this.host.carriedOn(chatId),
			continuation: (chatId) => this.host.store.continuation(chatId),
			startChat: async (agentId, title, init) => {
				const agent = this.host.agents.get(agentId);
				if (!agent) throw new Error("The agent was deleted");
				const id = await this.host.startChat(agent, clipTitle(title), undefined, init);
				this.host.broadcastMessage({ type: "sessions" });
				return id;
			},
			adoptChat: async (chatId, agentId, title) => {
				const agent = this.host.agents.get(agentId);
				if (!agent) throw new Error("The agent was deleted");
				await this.host.harness.session(chatId).setModel(this.host.sessionModel(chatId, agent));
				this.host.agents.setSession(chatId, agent.id);
				// A chat deleted since stays deleted.
				if (!this.host.store.deletedSessions().has(chatId)) this.host.store.touchSession(chatId, clipTitle(title));
				this.host.broadcastMessage({ type: "sessions" });
			},
			chatOrigin: async (chatId) => {
				const id = conversation(chatId);
				if (id === null) return null;
				const origin = await (await this.host.harness.pi()).snapshot(TriggerChatDoc, id, BACKGROUND_CONTEXT);
				return origin?.operationId || null;
			},
			submit: (chatId, content, operation) => this.host.submitTo(chatId, content, operation, "pim"),
			submission: async (chatId, key) => {
				const record = await (await this.host.harness.storage()).submissionByRequest((await this.host.harness.conversation(chatId)).id, key, BACKGROUND_CONTEXT);
				return record?.type === "input" ? { status: record.status, ...(record.reason === undefined ? {} : { reason: record.reason }) } : undefined;
			},
			approvalPending: (chatId, since) => this.host.store.approvals("pending").some((approval) => approval.session === chatId && approval.createdAt >= since),
		};
	}
}
