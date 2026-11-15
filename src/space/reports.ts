/**
 * What the space reports about itself and hands over: diagnostics and health, usage and compute, exporting what it holds, and erasing it.
 */
import { codingThread } from "../coding/thread-do";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, type Extension, LiveDoc, type LiveState, ProviderDoc, type TaskId } from "@earendil-works/pi-durable";
import type { Connection } from "agents";
import { type PiModel, PiHarness } from "agents/harness/pi";
import { ArtifactStore } from "../artifacts";
import { type CustomProvider, providerInfo } from "../providers";
import { ImageStore } from "../images";
import { CircleStore } from "../circles";
import { SkillStore } from "../skills";
import { ExtensionDataStore } from "../extensions/data";
import { NativeApps } from "../extensions/native-apps";
import type { McpBridge } from "../extensions/mcp";
import type { MemoryScope } from "../extensions/optmem";
import { LegacyFiles } from "../legacy-files";
import { NoteStore } from "../notes";
import { PimBrowser } from "../browser";
import { readDeployment } from "../deployment";
import { DiagnosticEvents, diagnose, scrub, scrubValue, type Turn, turnsOf } from "../diagnostics";
import type { PublicApproval } from "../protocol";
import type { Settings } from "../settings";
import { type Approval, type ApprovalDecider, type ApprovalStatus, PimStore } from "../store";
import { AgentStore } from "../agents";
import { triggerFailures } from "@pim/triggers/failures";
import { TriggerEngine, triggerHistory } from "@pim/triggers/engine";
import { ConnectorSubscriptionManager } from "@pim/triggers/subscriptions";
import { type Role, type Task, TaskStore, TERMINAL_STATES } from "../tasks";
import { codingScheduler } from "../coding/scheduler-do";
import { projectEntries } from "@pim/shared/transcript";
import { RunWatch, runKey } from "../run-guard";
import type { RunTags } from "../model-calls";
import { type ComputeQuota, resolveQuota } from "../compute";
import { type CallInfo, type Limits, UsageMeter } from "../usage";
import { VisitStore } from "../visits";
import { type MemoryScopeInfo, type OwnerProfile, describeModel } from "./shared";

/** The most chats the diagnostics read the turns of at once, those at work most recently. */
export const TURN_CHATS = 20;

/** How long an erasure waits for runs to stop and connectors to unsubscribe before wiping anyway. */
export const ERASE_COURTESY_MS = 3_000;

/** What what the space reports and hands over needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface ReportsHost {
	readonly closed: () => boolean;
	readonly store: PimStore;
	readonly assertOpen: () => void;
	readonly ctx: DurableObjectState<{}>;
	readonly diagnosticEvents: DiagnosticEvents;
	readonly heldSessions: () => Promise<Set<string>>;
	readonly heldErrors: (held: ReadonlySet<string>) => Promise<Map<string, string>>;
	readonly roleOf: (session: string) => Role;
	readonly triggerEngine: () => TriggerEngine | null;
	readonly apps: McpBridge;
	readonly env: Env;
	readonly name: string;
	readonly harness: PiHarness;
	readonly runWatch: RunWatch;
	readonly tasks: TaskStore;
	readonly agents: AgentStore;
	readonly scheduledTasks: () => { agent?: string | undefined; session: string | null; label: string | null; instruction: string; newChat: boolean; intervalSeconds?: number | undefined; timeZone?: string | undefined; cron?: string | undefined; id: string; type: string; next: string | null; }[];
	readonly visits: VisitStore;
	readonly ownComputeQuota: () => Partial<ComputeQuota> | null;
	readonly providerSessions: Map<string, string>;
	readonly usage: UsageMeter;
	readonly triggerClock: () => number;
	readonly limits: () => Limits;
	readonly storedBytes: () => number;
	readonly notes: NoteStore;
	readonly profile: () => OwnerProfile | null;
	readonly settings: () => Settings;
	readonly chosenModel: () => PiModel;
	readonly customProviders: () => { catalogId: string; shared: boolean; provider: CustomProvider; }[];
	readonly memoryScopes: () => MemoryScopeInfo[];
	readonly memory: { store: import("../extensions/optmem").OptMemStore; extension: Extension<import("@earendil-works/pi-durable").ToolRegistration>; NapTask: import("@earendil-works/pi-durable").Task<Record<string, never>, { readonly phase: "next"; } | { readonly phase: "summarize"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number; } | { readonly phase: "retry"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number; readonly until: number; }, Record<string, never>, object>; view: (scopes: readonly MemoryScope[]) => string[]; search: (pattern: string, scopes: readonly string[]) => { text: string; isError: boolean; }; startNap: (starter: import("../extensions/optmem").NapStarter) => Promise<TaskId | undefined>; today: () => string; };
	readonly publicSession: <T extends { readonly session: string | null; }>(record: T) => T;
	readonly extensionData: ExtensionDataStore;
	readonly publicApproval: (approval: Approval) => PublicApproval;
	readonly describeCircles: () => { members: { ownerId: string; username: string; addedAt: number; }[]; id: string; name: string; enabled: boolean; memoryScopes: readonly string[]; createdAt: number; }[];
	readonly circles: CircleStore;
	readonly artifacts: ArtifactStore;
	readonly legacyFiles: LegacyFiles;
	readonly skills: SkillStore;
	readonly getMcpServers: () => import("agents").MCPServersState;
	readonly images: ImageStore;
	erasing: boolean;
	readonly getConnections: <TState = unknown>(tag?: string) => Iterable<Connection<TState>>;
	readonly connectorSubscriptionsKept: { readonly engine: TriggerEngine; readonly manager: ConnectorSubscriptionManager; } | undefined;
	readonly nativeApps: NativeApps;
	readonly browser: PimBrowser;
	readonly removeMachine: () => Promise<void>;
}

export class Reports {
	constructor(private readonly host: ReportsHost) {}

	/** An approval as host operations (./hostops.ts) check it before they run a command: what it was for, and whether and by whom it was decided. Null when there is none. */
	async hostopsApproval(id: string): Promise<{ action: string; argsJson: string; status: ApprovalStatus; decidedBy: ApprovalDecider | null; decidedAt: number | null; guest: boolean } | null> {
		if (this.host.closed()) return null;
		const approval = this.host.store.approval(id);
		if (!approval) return null;
		const { action, args, status, decidedBy, decidedAt, requestedBy } = approval;
		return { action, argsJson: JSON.stringify(args), status, decidedBy, decidedAt, guest: requestedBy !== null };
	}

	/** What went wrong in this space lately, by kind, for the admin's majordomo (see ./diagnostics.ts). */
	diagnosticsReport(query: { since?: string; kind?: string; limit?: number; chat?: string }) {
		this.host.assertOpen();
		return diagnose(
			{
				sql: this.host.ctx.storage.sql,
				events: this.host.diagnosticEvents,
				now: Date.now(),
				heldRuns: async () => {
					const held = await this.host.heldSessions();
					const errors = await this.host.heldErrors(held);
					return [...held].map((conversation) => ({ chat: this.host.store.publicId(conversation), agent: this.host.roleOf(conversation).agent.name, error: errors.get(conversation) ?? "" }));
				},
				busyRuns: () => this.#busyRuns(),
				turns: (chat, since) => this.turns(chat, since),
				chatId: (session) => this.host.store.publicId(session),
				triggerFailures: (since, limit) => (this.host.triggerEngine() ? triggerFailures(this.host.ctx.storage.sql, since, limit) : null),
				connectors: () => this.host.apps.servers(),
				codingThreads: async () => Promise.all((await codingScheduler(this.host.env, this.host.name).threads()).map(async (thread) => ({ ...thread, activity: await codingThread(this.host.env, thread.threadId).activity() }))),
			},
			query,
		);
	}

	/**
	 * The turns of a chat, by its public id, or else those of the chats at work
	 * since `since`, the most recently first and at most `TURN_CHATS` of them,
	 * from their transcripts and the approvals their calls filed.
	 */
	async turns(chat: string | null, since: number): Promise<{ chat: string; agent: string; turn: Turn }[]> {
		const now = Date.now();
		const all = await this.host.harness.sessions.list();
		const busy = new Set(all.flatMap((info) => (info.busy ? [info.id] : [])));
		let sessions: string[];
		if (chat !== null) {
			const session = this.host.store.sessionOf(chat);
			if (session === undefined) throw new Error(`No chat ${chat}`);
			sessions = [session];
		} else {
			const updated = (session: string) => this.host.store.sessionInfo(session)?.updatedAt ?? 0;
			sessions = all
				.map((info) => info.id)
				.filter((session) => busy.has(session) || updated(session) >= since)
				.sort((a, b) => updated(b) - updated(a))
				.slice(0, TURN_CHATS);
		}
		const approvals = this.host.store.approvals();
		const found = [];
		for (const session of sessions) {
			const calls = new Map(
				approvals.flatMap((approval) =>
					approval.session === session && approval.callId !== null
						? [[approval.callId, { id: approval.id, status: approval.status, createdAt: approval.createdAt, decidedAt: approval.decidedAt, decidedBy: approval.decidedBy }] as const]
						: [],
				),
			);
			const messages = (await this.host.harness.session(session).messages()).flatMap((entry) => entry.model ?? []);
			for (const turn of turnsOf(messages, calls, now, busy.has(session))) {
				if (turn.endedAt >= since) found.push({ chat: this.host.store.publicId(session), agent: this.host.roleOf(session).agent.name, turn });
			}
		}
		return found;
	}

	/**
	 * The chats whose run is at work, or waits, now: what each waits on, and,
	 * as the watchdog saw it, since when it has been at work and since when
	 * nothing about it changed. Runs held after a model error are told apart.
	 */
	async #busyRuns(): Promise<{ chat: string; agent: string; waitingOn: string; seenAt: number | null; unchangedSince: number | null }[]> {
		const pi = await this.host.harness.pi();
		const { tasks } = await pi.inspect(BACKGROUND_CONTEXT);
		const held = await this.host.heldSessions();
		const byConversation = new Map<string, typeof tasks[number][]>();
		for (const task of tasks) if (!task.record.background) byConversation.set(String(task.record.conversationId), [...(byConversation.get(String(task.record.conversationId)) ?? []), task]);
		const pending = this.host.store.approvals().filter((approval) => approval.status === "pending");
		const runs = [];
		for (const [session, group] of byConversation) {
			if (held.has(session)) continue;
			const live = await pi.snapshot(LiveDoc, Number(session) as ConversationId, BACKGROUND_CONTEXT);
			if (live?.run === undefined) continue;
			const seen = this.host.runWatch.seen(session);
			const known = seen?.run === runKey(live.run) ? seen : undefined;
			runs.push({
				chat: this.host.store.publicId(session),
				agent: this.host.roleOf(session).agent.name,
				waitingOn: this.#waitingOn(live, group, pending.filter((approval) => approval.session === session)),
				seenAt: known?.seenAt ?? null,
				unchangedSince: known?.since ?? null,
			});
		}
		return runs;
	}

	/** What a run waits on, in a few words: the person, tasks it handed out, a retry, its tools or the model. Its free text is scrubbed, and its ids are left whole to look up. */
	#waitingOn(live: LiveState, group: readonly { record: { id: TaskId; kind: string }; state: { kind: string } }[], approvals: readonly Approval[]): string {
		// Only the approvals its own calls wait for: one filed outside a call has none to hold.
		const calls = new Set((live.tools ?? []).map((slot) => slot.callId));
		const waits: string[] = approvals.filter((approval) => approval.callId !== null && calls.has(approval.callId)).map((approval) =>
			approval.review?.status === "reviewing" ? `the majordomo's review of approval ${approval.id}: ${scrub(approval.summary, 200)}` : `the person's decision on approval ${approval.id}: ${scrub(approval.summary, 200)}`,
		);
		for (const task of group) {
			if (task.record.kind !== "pi.tool" || task.state.kind !== "suspended") continue;
			const handed = this.host.tasks.inBatch(String(task.record.id)).filter((given) => !TERMINAL_STATES.has(given.state));
			if (handed.length > 0) waits.push(`tasks it handed out: ${handed.map((given) => `${given.id} to ${this.host.roleOf(given.conversation).agent.name} (${given.state})`).join(", ")}`);
		}
		if (waits.length > 0) return waits.join("; ");
		const retry = live.generation?.retry ?? live.compactions?.find((compaction) => compaction.retry !== undefined)?.retry;
		if (retry) return `a retry of the model at ${new Date(retry.at).toISOString()}, after: ${scrub(retry.error, 200)}`;
		if (live.generation?.deferred) return "the model's deferred answer";
		if (live.compactions?.some((compaction) => compaction.blocking)) return "compacting the chat";
		const running = (live.tools ?? []).filter((slot) => slot.status !== "done").map((slot) => slot.name);
		if (running.length > 0) return `its tool calls: ${running.join(", ")}`;
		return "the model's answer";
	}

	/** How this Pim is doing: its version, its Durable Object, what it holds and how the deployment is set, for the admin's majordomo. Addresses and keys are left out. */
	async healthReport() {
		this.host.assertOpen();
		const sql = this.host.ctx.storage.sql;
		const count = (query: string) => Number(sql.exec(query).one().n);
		const has = (table: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length > 0;
		const grouped = (query: string) => Object.fromEntries(sql.exec(query).toArray().map((row) => [String(row.k), Number(row.n)]));
		const servers = this.host.apps.servers();
		const version = this.host.env.CF_VERSION_METADATA;
		const { settings, variables } = readDeployment(this.host.env);
		const { publicUrl, contentOrigin, appsOrigin, emailFrom, ...shown } = settings;
		const alarm = await this.host.ctx.storage.getAlarm();
		const threads = await codingScheduler(this.host.env, this.host.name)
			.threads()
			.then((all) => all.reduce<Record<string, number>>((byState, thread) => ({ ...byState, [thread.state]: (byState[thread.state] ?? 0) + 1 }), {}))
			.catch(() => null);
		return scrubValue({
			generated_at: new Date().toISOString(),
			version: { id: version?.id ?? null, tag: version?.tag || null, deployed_at: version?.timestamp ?? null, note: "The host daemon's commit is in hostops_status." },
			durable_object: { status: "open", triggers_engine: this.host.triggerEngine() ? "on" : "off", next_alarm_at: alarm === null ? null : new Date(alarm).toISOString() },
			counts: {
				agents: this.host.agents.list().length,
				chats: count("SELECT COUNT(*) AS n FROM pim_sessions WHERE deleted_at IS NULL"),
				triggers: has("pim_triggers") ? grouped("SELECT lifecycle AS k, COUNT(*) AS n FROM pim_triggers WHERE lifecycle != 'deleted' GROUP BY lifecycle") : {},
				schedules: this.host.scheduledTasks().length,
				pending_approvals: count("SELECT COUNT(*) AS n FROM pim_approvals WHERE status = 'pending'"),
				connectors: { total: servers.length, not_ready: servers.filter((server) => server.state !== "ready").length },
				coding_threads: threads,
				diagnostic_events: this.host.diagnosticEvents.count(),
			},
			deployment: {
				...shown,
				configured: { public_url: publicUrl !== null, content_origin: contentOrigin !== null, apps_origin: appsOrigin !== null, email_from: emailFrom !== null },
				problems: variables.flatMap((variable) => (variable.problem ? [variable.problem] : [])),
			},
		});
	}

	/** The agent a chat talks with; none in a visit, which talks with someone else's. */
	agentRef(session: string): { id: string; name: string } | null {
		if (this.host.visits.bySession(session)) return null;
		const agent = this.host.agents.ofSession(session);
		return { id: agent.id, name: agent.name };
	}

	/** The person's compute: what they may use, whether the admin set it for them, and the sandbox minutes they have used by provider and month. */
	async computeReport() {
		const gallery = this.host.env.Gallery.getByName("gallery");
		const [deployment, usage] = await Promise.all([gallery.computeQuota(), gallery.computeUsageOf(this.host.name)]);
		const own = this.host.ownComputeQuota();
		return { quota: resolveQuota(deployment, own), own, usage };
	}

	/**
	 * What a model call is for. A call carries the provider session id of its
	 * conversation, so the conversation is found from that, then its agent, and
	 * how its run started: a task's conversation is delegated work, a chat a
	 * trigger is running in is the trigger's (scheduled when it fires on a
	 * time), and any other is the person's. A call with no session, such as
	 * naming a chat or compressing memory, is background work, as is a
	 * compaction's summary.
	 */
	async callTags({ sessionId, context }: CallInfo): Promise<RunTags> {
		const first = (context as { messages?: { role?: string; content?: unknown }[] } | undefined)?.messages?.[0];
		if (sessionId === undefined || (first?.role === "system" && String(first.content).startsWith("You are a context summarization assistant"))) return { runKind: "background" };
		const session = await this.#sessionOfProvider(sessionId);
		if (session === undefined) return {};
		const agentId = this.host.agents.findOfSession(session)?.id ?? null;
		const task = this.host.tasks.of(session);
		if (task) return { agentId, runKind: "delegated", chatId: this.host.store.publicId(task.root || session), parentRunId: task.id };
		const chatId = this.host.store.publicId(session);
		try {
			const [run] = this.host.ctx.storage.sql
				.exec("SELECT trigger_id, revision FROM pim_trigger_runs WHERE chat_id = ? AND phase NOT IN ('completed', 'failed', 'cancelled', 'not_submitted') ORDER BY created_at DESC, rowid DESC LIMIT 1", session)
				.toArray();
			if (run) {
				const source = this.host.triggerEngine()?.store.revision(String(run.trigger_id), Number(run.revision))?.source;
				return { agentId, chatId, runKind: source?.kind === "time" ? "scheduled" : "trigger", scheduleOrTriggerId: String(run.trigger_id) };
			}
		} catch {
			// No triggers table: this space never had the engine on.
		}
		return { agentId, chatId, runKind: "interactive" };
	}

	/** The conversation whose provider session id is `id`, found by asking the conversations this space knows, newest first, the first time. */
	async #sessionOfProvider(id: string): Promise<string | undefined> {
		const known = this.host.providerSessions.get(id);
		if (known !== undefined) return known;
		const sql = this.host.ctx.storage.sql;
		const sessions = sql
			.exec("SELECT id AS session FROM pim_sessions UNION SELECT session FROM pim_agent_sessions UNION SELECT conversation AS session FROM pim_tasks")
			.toArray()
			.map((row) => String(row.session))
			.filter((session) => /^[1-9]\d*$/.test(session) && ![...this.host.providerSessions.values()].includes(session));
		const pi = await this.host.harness.pi();
		await Promise.all(
			sessions.map(async (session) => {
				const provider = await pi.snapshot(ProviderDoc, Number(session) as ConversationId, BACKGROUND_CONTEXT);
				if (provider) this.host.providerSessions.set(provider.sessionId, session);
			}),
		);
		return this.host.providerSessions.get(id);
	}

	/** What model calls have cost over the last `days` days (at most 400), from the daily rollup and the calls since it. */
	usageCosts(days = 30) {
		return this.host.usage.calls.costs(Math.min(Math.max(Math.floor(days) || 30, 1), 400), this.host.triggerClock());
	}

	/** Usage today and on recent days, with the limits it counts against. */
	usageReport(days = 30) {
		return {
			limits: this.host.limits(),
			today: this.host.usage.today(),
			history: this.host.usage.history(days),
			storageBytes: this.host.storedBytes(),
		};
	}

	/**
	 * Everything the person put in or the agent made, as JSON they can take
	 * elsewhere: conversations, memories, goals, schedules, approvals,
	 * notifications, connectors and settings. Credentials are not
	 * included: the ChatGPT plan's tokens, connectors' sign-ins, webhook secrets
	 * and push keys stay behind. JSON text, ready to download.
	 */
	async exportData(): Promise<string> {
		// What the person wrote in a note since its last version is part of it.
		await this.host.notes.checkpointAll();
		const deleted = this.host.store.deletedSessions();
		const triggers = triggerHistory(this.host.ctx.storage.sql);
		const sessions = [];
		for (const session of await this.host.harness.sessions.list()) {
			if (deleted.has(session.id)) continue;
			const info = this.host.store.sessionInfo(session.id);
			sessions.push({
				id: this.host.store.publicId(session.id),
				title: info?.title ?? null,
				createdAt: info?.createdAt ?? null,
				updatedAt: info?.updatedAt ?? null,
				messages: projectEntries(await this.host.harness.session(session.id).messages()),
			});
		}
		return JSON.stringify({
			format: "pim-export",
			version: 1,
			exportedAt: new Date().toISOString(),
			owner: this.host.profile(),
			settings: this.host.settings(),
			model: describeModel(this.host.chosenModel()),
			// Without their keys, as everywhere.
			providers: this.host.customProviders().flatMap(({ shared, provider }) => (shared ? [] : [providerInfo(provider)])),
			sessions,
			memory: { scopes: this.host.memoryScopes(), entries: this.host.memory.store.page(Number.MAX_SAFE_INTEGER) },
			goals: this.host.store.goals().map((goal) => this.host.publicSession(goal)),
			extensions: this.host.extensionData.export(),
			schedules: this.host.scheduledTasks(),
			approvals: this.host.store.approvals().map((approval) => this.host.publicApproval(approval)),
			permissions: this.host.store.toolPermissions(),
			circles: this.host.describeCircles(),
			agents: this.host.agents.list(),
			guestActivity: this.host.circles.activity(500),
			sharedWithMe: this.host.visits.shares().map(({ ownerId, username, sharedAt, revoked }) => ({ ownerId, username, sharedAt, revoked })),
			notifications: this.host.store.notifications({ unread: false }).map((notification) => this.host.publicSession(notification)),
			apps: this.host.apps.servers().map(({ id, name, url, approval }) => ({ id, name, url, approval })),
			// Whatever triggers recorded, read as it is, whether they are on now or not.
			...(triggers ? { triggers } : {}),
			...(await this.host.artifacts.export().then(({ artifacts, files }) => ({ artifacts: artifacts.map((artifact) => this.host.publicSession(artifact)), artifactFiles: files }))),
			othersArtifactData: this.host.artifacts.othersData(),
			// Files the space still keeps; those on the person's computer are theirs already.
			files: await this.host.legacyFiles.export(),
			...(await this.host.skills.export().then(({ skills, files }) => ({ skills, skillFiles: files }))),
			usage: this.host.usage.history(90),
		});
	}

	/**
	 * What of the person's data this space still holds; nothing once
	 * `deleteEverything` has run. A deletion counts as done only when this
	 * says so, since destroying the space ends the call that asked for it.
	 */
	async remainingData(): Promise<string[]> {
		const remaining = this.host.store.remainingData();
		if (this.host.memory.store.count() > 0) remaining.push("memories");
		if (Object.keys(this.host.getMcpServers().servers).length > 0) remaining.push("connector connections");
		if (await this.host.images.any()) remaining.push("images");
		if (await this.host.artifacts.anyFiles()) remaining.push("app files");
		return remaining;
	}

	/** Whether the space is erased, and what of the person's data it still holds; a finished deletion is both. */
	async erasure(): Promise<{ sealed: boolean; remaining: string[] }> {
		return { sealed: this.host.store.erasedAt() !== null, remaining: await this.remainingData() };
	}

	/**
	 * Erases the space: stops its runs, ends connectors' event subscriptions,
	 * closes its sockets, wipes its storage (alarms included), then marks it
	 * erased, flushes the mark, and ends this instance, so nothing that was
	 * under way here can write afterwards. Later instances find the mark and
	 * refuse everything. The call that asked usually sees the instance end:
	 * check `erasure()` afterwards. Running it again on an erased agent wipes
	 * anything a request slipped in before the mark, and marks it again.
	 */
	async deleteEverything(): Promise<void> {
		this.host.erasing = true;
		for (const connection of this.host.getConnections()) connection.close(4010, "Deleted");
		// Stopping runs and ending connectors' subscriptions is courtesy: the wipe and the end of this
		// instance stop everything regardless. So they get a few seconds, and a hung model
		// request or connector can't hold the deletion.
		const courtesy = async () => {
			const sessions = await this.host.harness.sessions.list();
			await Promise.allSettled(sessions.map((session) => this.host.harness.session(session.id).abort()));
			// Connectors' subscriptions are undone as stopping their triggers would; the space reads as closed now, so through the manager it already has.
			const subscriptions = this.host.connectorSubscriptionsKept;
			if (subscriptions) {
				for (const trigger of subscriptions.engine.store.list()) {
					if (trigger.lifecycle !== "deleted" && trigger.spec.source.kind === "connector_event") subscriptions.engine.store.remove({ id: trigger.id });
				}
				await subscriptions.manager.tick();
			}
			await this.host.nativeApps.revokeAll();
		};
		await Promise.race([courtesy().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ERASE_COURTESY_MS))]);
		// Images and stored files live outside this object's storage, in R2 under the owner's prefix,
		// so they go first, and the browser on the person's computer quits.
		await this.host.images.deleteAll();
		await this.host.artifacts.deleteAllFiles();
		await this.host.browser.quit().catch(() => undefined);
		await this.host.removeMachine().catch((error) => console.error("removing the computer's machine", error));
		await this.host.ctx.storage.deleteAll();
		this.host.store.markErased(Date.now());
		await this.host.ctx.storage.sync();
		this.host.ctx.abort("This space was erased");
	}
}
