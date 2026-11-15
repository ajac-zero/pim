/**
 * Approvals: filing an action that waits for the person, deciding it (by the person, a timeout, "always approve" or the majordomo's review),
 * and the permissions that say which tools ask first.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { UserInput, Extension, TaskId } from "@earendil-works/pi-durable";
import { type PiModel, PiHarness, type PiReceipt } from "agents/harness/pi";
import type { Circle } from "../circles";
import { skillsSwitch, WRITE_SKILL } from "../extensions/skills";
import { describeWait, type GatedAction, ownToolPermission, type ResolvedPermission } from "../extensions/approvals";
import type { DirectoryApp } from "../extensions/app-directory";
import { type Ability, PimExtensions } from "../extensions/define";
import { agentAudience, agentToolPermission, appToolPermission, type McpBridge, type McpServerInfo, type McpToolInfo, serverFor, toolDefinition, toolName } from "../extensions/mcp";
import type { MemoryScope } from "../extensions/optmem";
import { UPDATE_AGENT } from "../extensions/agents";
import { HttpError } from "@pim/shared/http";
import type { PublicApproval, ServerMessage } from "../protocol";
import type { ApprovalPolicy, Settings } from "../settings";
import { type Approval, type Notification, OWNER, PimStore, TOOL_PERMISSIONS, type ToolPermission } from "../store";
import { type Agent, AgentStore } from "../agents";
import { type Role, type Task, TaskStore } from "../tasks";
import { DECIDE_APPROVAL, REVIEW_EXTENSION } from "../majordomo";
import { TELEMETRY_EXTENSION } from "../telemetry";
import type { Pim } from "../pim";
import { APPROVAL_EXPIRY_CALLBACK, type AutoApproval, type ToolPermissionInfo, WATCH_APP_EVENT, errorMessage } from "./shared";

/** How long an approval waits for the user under the `auto` policy before it is granted, so background work never stalls. */
export const APPROVAL_TIMEOUT_MS = 30_000;

/** How long the majordomo has to decide another agent's request before the person is asked anyway. */
export const REVIEW_MS = 5 * 60 * 1000;

export const REVIEW_EXPIRY_CALLBACK = "expireReview";

/** Pim's own tools that asked first once and run without asking now: their settings are only Off or On, as `WATCH_APP_EVENT`'s. */
export const UNASKED_TOOLS: readonly string[] = [WATCH_APP_EVENT, UPDATE_AGENT];

/** Pim's own tools with no action to approve, only an Off or On switch in Tool permissions. */
export const SWITCHED_TOOLS: readonly { readonly name: string; readonly description: string }[] = [
	{ name: WATCH_APP_EVENT, description: "Have a connected connector notify Pim whenever an event happens, with what to do each time." },
];

/** What the space's approvals needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface ApprovalsHost {
	readonly store: PimStore;
	readonly broadcastMessage: (message: ServerMessage) => void;
	readonly publicApproval: (approval: Approval) => PublicApproval;
	readonly schedule: (when: Date | string | number, callback: string, payload?: unknown, options?: { idempotent?: boolean }) => Promise<unknown>;
	readonly keepAliveWhile: <T>(fn: () => Promise<T>) => Promise<T>;
	readonly taskWaits: (session: string) => Promise<void>;
	readonly deliverNotification: (notification: Notification, options?: { sockets?: boolean; push?: boolean; }) => Promise<void>;
	readonly settings: () => Settings;
	readonly agents: AgentStore;
	readonly assertOpen: () => void;
	readonly approvalWaitsOnBot: (approval: Approval) => Promise<boolean>;
	readonly actions: readonly GatedAction[];
	readonly pimOf: (ownerId: string) => Promise<DurableObjectStub<Pim>>;
	readonly name: string;
	readonly guestOutcome: (approval: Approval) => string;
	readonly selectAbilities: (session: string) => Promise<void>;
	readonly tasks: TaskStore;
	readonly tasksChanged: (root: string) => void;
	readonly resumeTask: (session: string, task: TaskId) => ReturnType<PiHarness["resumeTask"]>;
	readonly harness: PiHarness;
	readonly offeredActions: () => GatedAction[];
	readonly ownActions: readonly GatedAction[];
	readonly apps: McpBridge;
	readonly extensions: PimExtensions;
	readonly abilities: Map<string, Ability>;
	readonly appsOf: (agent: Agent) => DirectoryApp[];
	readonly circle: (id: string) => Circle;
	readonly reinstallApprovals: () => void;
	readonly closed: () => boolean;
	readonly agentModel: (agent: Agent) => PiModel;
	readonly registry: import("@earendil-works/pi-durable").Registry<import("@earendil-works/pi-durable").ToolRegistration>;
	readonly memory: { store: import("../extensions/optmem").OptMemStore; extension: Extension<import("@earendil-works/pi-durable").ToolRegistration>; NapTask: import("@earendil-works/pi-durable").Task<Record<string, never>, { readonly phase: "next"; } | { readonly phase: "summarize"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number; } | { readonly phase: "retry"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number; readonly until: number; }, Record<string, never>, object>; view: (scopes: readonly MemoryScope[]) => string[]; search: (pattern: string, scopes: readonly string[]) => { text: string; isError: boolean; }; startNap: (starter: import("../extensions/optmem").NapStarter) => Promise<TaskId | undefined>; today: () => string; };
	readonly submit: (session: string, content: UserInput, options: { operationId?: string; whenBusy?: "followUp" | "steer"; }, from: string) => Promise<PiReceipt>;
	readonly roleOf: (session: string) => Role;
	readonly taskUnderway: (conversation: string) => Task | undefined;
}

export class Approvals {
	constructor(private readonly host: ApprovalsHost) {}

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
	async approvalFiled(approval: Approval, isNew: boolean): Promise<string | null> {
		if (approval.status !== "pending") return this.#outcome(approval);
		if (this.approvalPermission(approval) === "on") {
			return this.#outcome(await this.decideApproval(approval.id, "approve", undefined, "always", { inTurn: true }));
		}
		if (isNew && this.#reviewable(approval)) {
			this.host.store.setApprovalReview(approval.id, { status: "reviewing", note: null });
			const reviewing = this.host.store.approval(approval.id)!;
			// Open apps show the request, and that the majordomo is on it; the person can still decide first.
			this.host.broadcastMessage({ type: "approval", approval: this.host.publicApproval(reviewing) });
			await this.host.schedule(new Date(Date.now() + REVIEW_MS), REVIEW_EXPIRY_CALLBACK, { id: approval.id });
			void this.host.keepAliveWhile(() => this.#review(reviewing));
		}
		// A task's agent waits now, for the majordomo or the person.
		await this.host.taskWaits(approval.session);
		if (this.host.store.approval(approval.id)?.review) return null;
		if (isNew) {
			this.host.broadcastMessage({ type: "approval", approval: this.host.publicApproval(approval) });
			const notification = this.host.store.addNotification({
				id: crypto.randomUUID(),
				// The request of an agent at work on a task shows in the chat the work began in.
				session: approval.member?.session ?? approval.session,
				title: "Pim needs your approval",
				body: approval.summary,
			});
			// Open apps show the request itself, from the approval just broadcast; this reaches the others.
			await this.host.deliverNotification(notification, { sockets: false });
		}
		// Again on a replay: an approval filed before timeouts were scheduled gets one too. Deciding twice is refused.
		if (approval.expiresAt !== null) await this.host.schedule(new Date(approval.expiresAt), APPROVAL_EXPIRY_CALLBACK, { id: approval.id });
		return null;
	}

	/** How long approvals filed under `policy` wait before they are approved; null waits for the user however long. */
	approvalTimeoutMs(policy: ApprovalPolicy = this.host.settings().approvalPolicy): number | null {
		return policy === "auto" ? APPROVAL_TIMEOUT_MS : null;
	}

	#outcome(approval: Approval): string {
		const majordomo = approval.decidedBy === "majordomo" ? this.host.agents.majordomo().name : null;
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
		this.host.assertOpen();
		const approval = this.host.store.approval(id);
		if (!approval) throw new HttpError(404, `No approval ${id}`);
		if (decision === "approve" && this.#requiresExplicitApproval(approval)) {
			if (auto) throw new HttpError(400, "This action requires an explicit decision for each request");
			if (this.approvalPermission(approval) === "off") throw new HttpError(403, "This capability is turned off");
		}
		// One the person asked for outside any chat, such as a coding thread's push (`codingRequestPush`), has no call to wake.
		const call = approval.requestedBy || options.inTurn || approval.callId === null ? undefined : await this.waitingCall(approval);
		// A bot's guest's call waits in their own space, and runs its tool there once it wakes.
		const bot = approval.requestedBy?.bot !== undefined;
		const stopped = call === null || (bot && decision === "approve" && !(await this.host.approvalWaitsOnBot(approval)));
		if (stopped) {
			decision = "deny";
			note = "Its chat stopped before the decision, so nothing ran.";
		}
		if (!this.host.store.decideApproval(id, decision === "approve" ? "approved" : "denied", note ?? null, auto ?? "user")) {
			throw new HttpError(409, `Approval ${id} is already ${approval.status}`);
		}
		if (decision === "approve" && !bot) {
			const action = this.host.actions.find((candidate) => candidate.name === approval.action);
			let result: string;
			this.running.add(id);
			try {
				result = action
					? await this.host.keepAliveWhile(() => action.run(approval.args as never, { session: approval.session, approval: approval.id }))
					: `The action ${approval.action} is no longer available.`;
			} catch (error) {
				result = `The action failed: ${errorMessage(error)}`;
			} finally {
				this.running.delete(id);
			}
			this.host.store.recordApprovalResult(id, result);
		}
		const decided = this.host.store.approval(id)!;
		this.host.broadcastMessage({ type: "approval", approval: this.host.publicApproval(decided) });
		if (decided.requestedBy) {
			// A guest asked: the outcome continues their visit, in their own space, on their own usage;
			// a bot's guest's call, waiting there, wakes and asks for it.
			try {
				const guest = await this.host.pimOf(decided.requestedBy.ownerId);
				if (bot) await guest.botToolDecided(this.host.name, decided.session, decided.callId ?? "");
				else await guest.visitAnswer(this.host.name, decided.session, this.host.guestOutcome(decided), `approval:${this.host.name}:${id}`);
			} catch (error) {
				console.warn(`telling ${decided.requestedBy.username} about approval ${id} failed`, error);
			}
			return decided;
		}
		if (call) {
			// What it approved may have changed the agent, such as its connectors: the turn goes on with the tools it has now.
			await this.host.selectAbilities(approval.session);
			const task = this.host.tasks.of(approval.session);
			if (task && this.host.tasks.setState(task.id, "working")) this.host.tasksChanged(task.root);
			await this.host.resumeTask(approval.session, call);
		}
		return decided;
	}

	/** Approved actions running now, by approval: after a restart, an approved action not in it was cut short. */
	readonly running = new Set<string>();

	/** The task of the tool call waiting for `approval`'s decision, or null when none is. */
	async waitingCall(approval: Pick<Approval, "session" | "callId">): Promise<TaskId | null> {
		const { tasks } = await (await this.host.harness.pi()).inspect(BACKGROUND_CONTEXT);
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
		const approval = this.host.store.approval(id);
		if (!approval) throw new HttpError(404, `No approval ${id}`);
		if (approval.status !== "pending") throw new HttpError(409, `Approval ${id} is already ${approval.status}`);
		if (this.#requiresExplicitApproval(approval)) {
			throw new HttpError(400, "This action requires an explicit decision for each request");
		}
		const { app, tool } = this.#approvalTool(approval);
		const audience = approval.requestedBy?.circle ?? OWNER;
		// Remembered first, so calls filed while this action runs are not asked about.
		this.setToolPermission(audience, app, tool, "on");
		for (const pending of this.host.store.approvals("pending")) {
			const other = this.#approvalTool(pending);
			if (pending.id === id || other.app !== app || other.tool !== tool) continue;
			if ((pending.requestedBy?.circle ?? OWNER) !== audience) continue;
			void this.decideApproval(pending.id, "approve", undefined, "always").catch((error) =>
				console.warn(`approving ${pending.id} failed`, error),
			);
		}
		return this.decideApproval(id, "approve", note);
	}

	// Tool permissions: whether Pim may use each tool that acts on the world or comes from a connector,
	// for its owner and for each circle.

	/** Pim's own tools that ask first unless the user chooses otherwise; `mcp_call` is filed by the connectors' tools. */
	#ownGatedActions(): GatedAction[] {
		const offered = new Set(this.host.offeredActions().map((action) => action.name));
		return this.host.actions.filter((action) => action.name !== "mcp_call" && (offered.has(action.name) || !this.host.ownActions.includes(action)));
	}

	/** The permission of a tool that no longer asks first: on unless switched off, whatever else was chosen before it stopped asking. */
	#unaskedPermission(tool: string): ResolvedPermission {
		const { chosen } = ownToolPermission(this.host.store, tool);
		return { permission: chosen === "off" ? "off" : "on", default: "on", chosen: chosen === "ask" ? null : chosen, changed: false };
	}

	/** The tool an approval was filed for, as permissions name it: by its connector and the connector's own name for it. */
	#approvalTool(approval: Approval): { app: string; tool: string } {
		if (approval.action === "mcp_call") {
			const { server, tool } = approval.args as { server: string; tool: string };
			return { app: server, tool };
		}
		return { app: "", tool: approval.action };
	}

	/** Risky tools always need the person's decision, even when assigned to an agent, as does every call a bot's guest asks for. */
	#requiresExplicitApproval(approval: Approval): boolean {
		if (approval.requestedBy?.bot !== undefined) return true;
		if (approval.action !== "mcp_call") return this.host.actions.some((action) => action.name === approval.action && action.explicitApproval);
		if (approval.tool === null) return true;
		const { app, tool } = this.#approvalTool(approval);
		return this.host.apps.tools().some((info) => info.serverId === app && info.name === tool && info.annotations?.destructiveHint === true);
	}

	/** The permission of the tool that filed an approval, for whoever asked; `ask` for a connector tool that is gone. */
	approvalPermission(approval: Approval): ToolPermission {
		const { app, tool } = this.#approvalTool(approval);
		if (app === "") {
			const resolved = ownToolPermission(this.host.store, tool);
			// An approval filed before its tool stopped asking stays pending unless the person switched the tool off.
			if (UNASKED_TOOLS.includes(tool)) return resolved.chosen === "off" ? "off" : "ask";
			if (this.#requiresExplicitApproval(approval)) return resolved.permission === "off" ? "off" : "ask";
			if (!approval.requestedBy && resolved.chosen === null) {
				const assigned = this.host.extensions.withAbilities();
				if (assigned.some((id) => this.host.abilities.get(id)?.actions?.some((action) => action.name === tool))) return "on";
			}
			return resolved.permission;
		}
		const server = this.host.apps.servers().find((candidate) => candidate.id === app);
		const info = this.host.apps.tools().find((candidate) => candidate.serverId === app && candidate.name === tool);
		if (!server || !info) return "ask";
		const resolved = appToolPermission(this.host.store, server, info, approval.requestedBy?.circle ?? OWNER);
		if (this.#requiresExplicitApproval(approval)) return resolved.permission === "off" ? "off" : "ask";
		return resolved.permission;
	}

	/**
	 * Every tool a permission can be set for, for the owner (`OWNER`) or a
	 * circle, with the permission that applies: for the owner, Pim's own tools
	 * that act on the world, since each agent has its own switches for its
	 * connectors' tools; for a circle, every connector's tools. What a circle remembers is
	 * the memory scopes ticked for it.
	 */
	toolPermissions(audience: string = OWNER): ToolPermissionInfo[] {
		if (audience === OWNER) {
			const switched = SWITCHED_TOOLS.map((tool) => ({
				app: null,
				appName: null,
				tool: tool.name,
				name: tool.name,
				description: tool.description,
				readOnly: false,
				destructive: false,
				choices: ["off", "on"] as const,
				...this.#unaskedPermission(tool.name),
			}));
			const gated = this.#ownGatedActions().map((action): ToolPermissionInfo => ({
				app: null,
				appName: null,
				tool: action.name,
				name: action.name,
				description: action.description,
				readOnly: false,
				destructive: false,
				choices: UNASKED_TOOLS.includes(action.name) ? ["off", "on"] : action.explicitApproval ? ["off", "ask"] : TOOL_PERMISSIONS,
				...(UNASKED_TOOLS.includes(action.name) ? this.#unaskedPermission(action.name) : ownToolPermission(this.host.store, action.name)),
			}));
			return [...gated, ...switched];
		}
		const servers = new Map(this.host.apps.servers().map((server) => [server.id, server]));
		const apps = this.host.apps.tools().flatMap((tool) => {
			const server = servers.get(tool.serverId);
			if (!server) return [];
			const choices = tool.annotations?.destructiveHint === true ? (["off", "ask"] as const) : TOOL_PERMISSIONS;
			return [{ ...this.#appToolInfo(server, tool), choices, ...appToolPermission(this.host.store, server, tool, audience) }];
		});
		return apps;
	}

	/** What a permission row says about a connector's tool, besides the permission. */
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

	/** The tools of the connectors an agent works with, each with its switch for that agent. */
	agentToolPermissions(agent: Agent): ToolPermissionInfo[] {
		const servers = this.host.apps.servers();
		const tools = this.host.apps.tools();
		return this.host.appsOf(agent).flatMap((app) => {
			const server = serverFor(servers, app);
			if (!server) return [];
			return tools
				.filter((tool) => tool.serverId === server.id)
				.map((tool) => ({ ...this.#appToolInfo(server, tool), choices: ["off", "on"] as const, ...agentToolPermission(this.host.store, agent.id, server, tool) }));
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
			...skillsSwitch(this.host.store, agent.id),
		};
	}

	/**
	 * Switches a connector's tool on or off for one agent, or back to its default
	 * (null); or, as Pim's own `write_skill` (`app` empty), its switch for
	 * skills. Switched on, a connector's tool is held to the tool's definition now.
	 * The agent's conversations see it from their next request.
	 */
	setAgentToolPermission(agent: Agent, app: string, tool: string, permission: ToolPermission | null): ToolPermissionInfo {
		if (permission === "ask") throw new HttpError(400, "An agent's connector tools are either on or off");
		if (app === "") {
			if (tool !== WRITE_SKILL) throw new HttpError(404, `${agent.name} has no switch for ${tool}`);
			if (permission === null) this.host.store.clearToolPermission(agentAudience(agent.id), "", WRITE_SKILL);
			else this.host.store.setToolPermission(agentAudience(agent.id), "", WRITE_SKILL, permission, null);
			return this.agentSkillsPermission(agent);
		}
		const found = this.agentToolPermissions(agent).find((info) => info.app === app && info.tool === tool);
		if (!found) throw new HttpError(404, `${agent.name} has no tool ${tool} in the connector ${app}`);
		const info = this.host.apps.tools().find((candidate) => candidate.serverId === app && candidate.name === tool)!;
		if (permission === null) this.host.store.clearToolPermission(agentAudience(agent.id), app, tool);
		else this.host.store.setToolPermission(agentAudience(agent.id), app, tool, permission, toolDefinition(info));
		return this.agentToolPermissions(agent).find((candidate) => candidate.app === app && candidate.tool === tool)!;
	}

	/**
	 * Sets the permission of a tool for the owner (`OWNER`) or a circle: one of
	 * Pim's own (`app` empty), or, for a circle, a connector's; null goes back to its
	 * default. A connector tool's choice is tied to its definition now. The model sees
	 * the change from its next request; a guest, from their next call.
	 */
	setToolPermission(audience: string, app: string, tool: string, permission: ToolPermission | null): ToolPermissionInfo {
		if (audience !== OWNER) this.host.circle(audience);
		let definition: string | null = null;
		if (app === "") {
			const known = audience === OWNER && (this.#ownGatedActions().some((action) => action.name === tool) || SWITCHED_TOOLS.some((switched) => switched.name === tool));
			if (!known) throw new HttpError(404, `No tool ${tool}`);
			if (UNASKED_TOOLS.includes(tool) && permission === "ask") throw new HttpError(400, "This tool can only be off or on: it runs without asking");
			if (permission === "on" && this.#ownGatedActions().find((action) => action.name === tool)?.explicitApproval) {
				throw new HttpError(400, "This tool can only be off or ask: every change requires explicit approval");
			}
		} else {
			if (audience === OWNER) throw new HttpError(400, "A connector's tools are switched on or off for each agent");
			const info = this.host.apps.tools().find((candidate) => candidate.serverId === app && candidate.name === tool);
			if (!info) throw new HttpError(404, `No tool ${tool} in the connector ${app}`);
			if (permission === "on" && info.annotations?.destructiveHint === true) {
				throw new HttpError(400, "This tool can only be off or ask: every call requires explicit approval");
			}
			definition = toolDefinition(info);
		}
		if (permission === null) this.host.store.clearToolPermission(audience, app, tool);
		else this.host.store.setToolPermission(audience, app, tool, permission, definition);
		if (audience === OWNER) this.host.reinstallApprovals();
		return this.toolPermissions(audience).find((info) => (info.app ?? "") === app && info.tool === tool)!;
	}

	/**
	 * Turns each tool chosen with "Always approve" before tool permissions
	 * into an `on` permission, once the tool its name belongs to is known (an
	 * connector's tools only once it is connected).
	 */
	migrateAlwaysApproved(): void {
		for (const name of this.host.store.legacyAlwaysApproved()) {
			let app: string | undefined;
			let tool: string | undefined;
			let definition: string | null = null;
			if (this.#ownGatedActions().some((action) => action.name === name)) {
				app = "";
				tool = name;
			} else {
				const info = this.host.apps.tools().find((candidate) => toolName(candidate.serverId, candidate.name) === name);
				if (!info) continue;
				app = info.serverId;
				tool = info.name;
				definition = toolDefinition(info);
			}
			if (!this.host.store.toolPermission(OWNER, app, tool)) this.host.store.setToolPermission(OWNER, app, tool, "on", definition);
			this.host.store.forgetLegacyAlwaysApproved(name);
		}
	}

	/** Fired when an approval's timeout passes: unanswered, it is decided as it was filed to be. */
	async expireApproval(payload: { id: string }): Promise<void> {
		if (this.host.closed()) return;
		const approval = this.host.store.approval(payload.id);
		if (approval?.status !== "pending") return;
		await this.decideApproval(approval.id, approval.onTimeout, undefined, "timeout");
	}

	// The majordomo deciding other agents' approval requests for the person.

	/**
	 * Whether the majordomo decides `approval` first: under the `majordomo`
	 * policy, the request of any agent but the majordomo itself, in a chat
	 * with the person, where they are the ones to ask. Never a guest's, and
	 * never one that needs the person's own decision.
	 */
	#reviewable(approval: Approval): boolean {
		if (this.host.settings().approvalPolicy !== "majordomo" || approval.requestedBy) return false;
		if (this.#requiresExplicitApproval(approval)) return false;
		return approval.member !== null || !this.host.agents.ofSession(approval.session).majordomo;
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
			let review = this.host.tasks.at(call, 0);
			if (!review) {
				const majordomo = this.host.agents.majordomo();
				const { id } = await this.host.harness.sessions.create();
				await this.host.harness.session(id).setModel(this.host.agentModel(majordomo));
				const snapshot = this.host.registry.snapshot();
				const extensions = [REVIEW_EXTENSION, this.host.memory.extension.name, TELEMETRY_EXTENSION].flatMap((name) => snapshot.extension(name) ?? []);
				const tools = snapshot
					.tools()
					.filter(({ extension, tool }) => extensions.includes(extension) && [DECIDE_APPROVAL, "recall", "zoom"].includes(tool.name))
					.map(({ tool }) => tool);
				await (await this.host.harness.conversation(id)).configure({ extensions, tools }, BACKGROUND_CONTEXT);
				const chat = approval.member?.session ?? approval.session;
				review = this.host.tasks.start({
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
			await this.host.submit(review.conversation, this.#reviewRequest(approval), { operationId: call }, "review");
			const result = await this.host.harness.wait(call, { session: review.conversation });
			this.host.tasks.finish(review.id, result.status === "done" ? "completed" : "failed", result.text?.trim() || result.reason || "");
		} catch (error) {
			console.warn(`the majordomo's review of ${approval.id} failed`, error);
		}
		await this.#escalate(approval.id, null);
	}

	/** What the majordomo reads to decide: who asks, for what, and in what chat. */
	#reviewRequest(approval: Approval): string {
		const { agent, from } = this.host.roleOf(approval.session);
		const task = this.host.taskUnderway(approval.session);
		const handedBy = from ?? (task ? this.host.roleOf(task.requester!).agent.name : null);
		const asker = `${agent.name}${agent.description ? ` (${agent.description})` : ""}, ${handedBy === null ? "in a chat the person has with it" : `working on a task ${handedBy} handed it for the person`}`;
		const args = JSON.stringify(approval.args, null, 2);
		return [
			`[Approval review ${approval.id}] ${asker}, asks for approval.`,
			`Request: ${approval.summary}`,
			`Action: ${approval.action}`,
			`Details:\n${args.length > 4000 ? `${args.slice(0, 4000)}\n[... ${args.length - 4000} more characters]` : args}`,
		].join("\n");
	}

	/** The majordomo's decision, from its review. Once the person is asked, or decides, it is theirs. */
	async reviewDecision(conversation: string, decision: "approve" | "deny" | "escalate", note: string): Promise<string> {
		const review = this.host.tasks.of(conversation);
		if (review?.kind !== "review") return "This conversation reviews no approval.";
		const id = review.batch.slice("review:".length);
		const approval = this.host.store.approval(id);
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
		const approval = this.host.store.approval(id);
		if (approval?.status !== "pending" || approval.review?.status !== "reviewing" || this.host.closed()) return;
		this.host.store.setApprovalReview(id, { status: "escalated", note });
		const escalated = this.host.store.approval(id)!;
		this.host.broadcastMessage({ type: "approval", approval: this.host.publicApproval(escalated) });
		const { name } = this.host.agents.majordomo();
		const notification = this.host.store.addNotification({
			id: crypto.randomUUID(),
			session: approval.member?.session ?? approval.session,
			title: `${name} needs your approval`,
			body: note ? `${approval.summary}\n${note}` : approval.summary,
		});
		// Open apps show the request itself, from the approval just broadcast; this reaches the others.
		await this.host.deliverNotification(notification, { sockets: false });
	}

	/** Fired when a review has taken too long: the person is asked. */
	async expireReview(payload: { id: string }): Promise<void> {
		await this.#escalate(payload.id, null);
	}
}
