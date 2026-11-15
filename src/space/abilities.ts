/**
 * What a chat offers beside the model: the abilities extensions give, the widgets a chat shows, and the suggestions it starts from.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionTask, defineExtension, type Extension, hook, type TaskId } from "@earendil-works/pi-durable";
import { type PiModel, PiHarness } from "agents/harness/pi";
import { digestHex } from "../auth/store";
import { ASSISTANT_STARTERS } from "../extensions/assistant";
import { gatedTools } from "../extensions/approvals";
import { appDirectory, type DirectoryApp } from "../extensions/app-directory";
import { ExtensionDataStore } from "../extensions/data";
import { type Ability, PimExtensions, type ShownWidget, type Widget, type WidgetContext, localize } from "../extensions/define";
import type { MemoryAccess, MemoryScope } from "../extensions/optmem";
import type { PimServices } from "../extensions/services";
import { HttpError } from "@pim/shared/http";
import type { ServerMessage } from "../protocol";
import type { Settings } from "../settings";
import { PimStore } from "../store";
import { type Agent, type AgentInput, AgentStore } from "../agents";
import { RoomStore } from "../rooms";
import { TriggerApi } from "@pim/triggers/api";
import { COMPUTER_GRANT_EXTENSION } from "../triggers/grant-action";
import { TRIGGERS_EXTENSION } from "../triggers/tools";
import { type Role, type Task, TaskStore } from "../tasks";
import { projectEntries } from "@pim/shared/transcript";
import { conversationText, type StructuredUtilityTask, SUGGEST_PROMPTS } from "../utility";
import { codingBackendIds } from "../compute";
import { workspaceBackends } from "../coding/workspace/registry";
import { VisitStore } from "../visits";
import { SUGGESTIONS_KEY } from "./shared";

/** The hook that carries a chat on in a new one when compaction would shorten it (`#continuationExtension`). */
export const CONTINUATION_EXTENSION = "pim.continuation";

/** What the utility model reads to suggest prompts: the chat, and how much of it and of memory. */
export const SUGGESTION_CHAT_CHARS = 2_000;

export const SUGGESTION_MEMORY_CHARS = 3_000;

/** What the space's abilities needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface AbilitiesHost {
	readonly env: Env;
	codingSandboxes: boolean | undefined;
	readonly environmentWorkspaceIds: () => string[];
	readonly abilities: Map<string, Ability>;
	readonly registry: import("@earendil-works/pi-durable").Registry<import("@earendil-works/pi-durable").ToolRegistration>;
	readonly visits: VisitStore;
	readonly taskApart: (conversation: string) => Task | undefined;
	readonly agents: AgentStore;
	readonly triggerApi: () => TriggerApi | null;
	readonly appExtensionsOf: (agent: Agent) => string[];
	readonly switchedOff: (agent: Agent) => Set<string>;
	readonly harness: PiHarness;
	readonly refreshCustomApps: (now?: boolean) => Promise<void>;
	readonly appDirectory: () => DirectoryApp[];
	readonly memory: { store: import("../extensions/optmem").OptMemStore; extension: Extension<import("@earendil-works/pi-durable").ToolRegistration>; NapTask: import("@earendil-works/pi-durable").Task<Record<string, never>, { readonly phase: "next"; } | { readonly phase: "summarize"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number; } | { readonly phase: "retry"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number; readonly until: number; }, Record<string, never>, object>; view: (scopes: readonly MemoryScope[]) => string[]; search: (pattern: string, scopes: readonly string[]) => { text: string; isError: boolean; }; startNap: (starter: import("../extensions/optmem").NapStarter) => Promise<TaskId | undefined>; today: () => string; };
	readonly memoryAccess: (agent: Agent) => MemoryAccess;
	readonly store: PimStore;
	readonly suggesting: Map<string, { of: string; promise: Promise<string[]>; }>;
	readonly utilityStructured: <T extends readonly unknown[]>(task: StructuredUtilityTask<T>, input: string) => Promise<T>;
	readonly extensions: PimExtensions;
	readonly settings: () => Settings;
	readonly extensionData: ExtensionDataStore;
	readonly tasks: TaskStore;
	readonly roleOf: (session: string) => Role;
	readonly hiddenSessions: () => Set<string>;
	readonly rooms: RoomStore;
	readonly sessionModel: (session: string, agent?: Agent) => PiModel;
	readonly broadcastMessage: (message: ServerMessage) => void;
}

export class Abilities {
	constructor(private readonly host: AbilitiesHost) {}

	/**
	 * Installs (or replaces, keeping their place) each ability as a pi
	 * extension named after its extension: its tools, its actions' tools as
	 * the person's permissions have them, sections, hooks and tasks.
	 */
	/** The ids of the workspace backends the deployment's environment sets up. */
	environmentWorkspaceIds(): string[] {
		return workspaceBackends(this.host.env).ids();
	}

	/**
	 * Reads which compute providers the admin set up, so a chat's next turn
	 * offers coding tools only while some provider can run a coding thread:
	 * the capability follows the configuration, with no flag of its own. A
	 * Gallery that can't be reached leaves what was read.
	 */
	async #refreshCompute(): Promise<void> {
		try {
			const configured = await this.host.env.Gallery.getByName("gallery").computeSummaries();
			this.host.codingSandboxes = codingBackendIds(this.host.environmentWorkspaceIds(), configured).length > 0;
		} catch (error) {
			console.warn("reading the admin's compute providers failed", error);
		}
	}

	/** Whether coding threads can get a workspace: what `#refreshCompute` last found. */
	hasCodingSandbox(): boolean {
		return (this.host.codingSandboxes ??= this.host.environmentWorkspaceIds().length > 0);
	}

	installAbilities(services: PimServices): void {
		for (const [id, { actions, offeredTo: _offeredTo, ...ability }] of this.host.abilities) {
			this.host.registry.install(defineExtension({ ...ability, name: id, tools: [...(ability.tools ?? []), ...gatedTools(services, actions ?? [])] }));
		}
	}

	/**
	 * Gives a chat the abilities its agent uses and the connectors it lists, less
	 * the connector tools switched off for the agent, as they are now, before its next
	 * run: its agent, the extensions, the connected connectors
	 * or the switches may have changed since.
	 * Visits choose their own extensions, and the conversations of tasks that
	 * aren't chats got theirs when made. A chat whose selection is unchanged
	 * isn't written to. Where the space's triggers are on, the grant tool comes
	 * after the connectors, so adding or taking it out only appends or removes
	 * at the end; where they are off, the selection is as it was without it.
	 */
	async selectAbilities(session: string): Promise<void> {
		if (this.host.visits.bySession(session) || this.host.taskApart(session)) return;
		await this.#refreshCompute();
		const agent = this.host.agents.ofSession(session);
		// Connectors last: their tools come and go, and pi only appends cheaply at the end.
		const grants = this.host.registry.snapshot().extension(COMPUTER_GRANT_EXTENSION) ? [COMPUTER_GRANT_EXTENSION] : [];
		// Triggers' tools last of all, only while the space's triggers are on: elsewhere the selection is as it was without them.
		const triggers = this.host.registry.snapshot().extension(TRIGGERS_EXTENSION) && this.host.triggerApi() ? [TRIGGERS_EXTENSION] : [];
		// The abilities offered to this agent come first, named so that a chat whose stored selection lacks one installed since gets it now.
		const offered = [...this.host.abilities].flatMap(([id, ability]) => (ability.offeredTo?.(agent) === false ? [] : [id]));
		const wanted = [...offered, ...this.host.appExtensionsOf(agent), ...grants, ...triggers];
		const off = [...this.host.switchedOff(agent)];
		const key = [...wanted, ...off.map((name) => `-${name}`)].join(" ");
		if ((this.host.agents.abilities(session) ?? "") === key) return;
		const snapshot = this.host.registry.snapshot();
		const add = wanted.flatMap((name) => snapshot.extension(name) ?? []);
		const remove = snapshot.tools().flatMap(({ tool }) => (off.includes(tool.name) ? [tool] : []));
		// Installed but not for this chat, such as in a guest's space: taken out if it was ever added.
		const drop = triggers.length === 0 ? snapshot.extension(TRIGGERS_EXTENSION) : undefined;
		const extensions = add.length > 0 || drop ? { ...(add.length > 0 ? { add } : {}), ...(drop ? { remove: [drop] } : {}) } : null;
		await (await this.host.harness.conversation(session)).configure(
			{ extensions, tools: remove.length > 0 ? { remove } : null },
			BACKGROUND_CONTEXT,
		);
		this.host.agents.setAbilities(session, key);
	}

	/** A copy's connectors that this deployment still offers. */
	async installed(input: AgentInput): Promise<AgentInput> {
		await this.host.refreshCustomApps(true);
		const directory = this.host.appDirectory();
		return {
			...input,
			apps: input.apps.filter((ref) => directory.some((app) => app.ref === ref)),
		};
	}

	/**
	 * The messages offered under a chat. Once the chat has something said in
	 * it, the utility model writes them from that chat and what Pim remembers,
	 * and writes them again only when either has changed since, so a chat nobody
	 * continues costs nothing. Until then, Pim's own starters; when the model
	 * can't, none, since starters rarely fit a chat already under way.
	 */
	async suggestions(agent: Agent, session: string, locale: string): Promise<string[]> {
		const starters = ASSISTANT_STARTERS.map((starter) => localize(starter, locale));
		const talk = conversationText(projectEntries(await this.host.harness.session(session).messages()), SUGGESTION_CHAT_CHARS);
		if (talk === "") return starters;

		const memory = this.host.memory.view(this.host.memoryAccess(agent).read).join("\n");
		const input = [
			`Assistant: ${agent.name}${agent.description === "" ? "" : `, ${agent.description}`}`,
			`Language: ${locale}`,
			memory === "" ? "" : `What it remembers about the person:\n${memory.length > SUGGESTION_MEMORY_CHARS ? `…${memory.slice(-SUGGESTION_MEMORY_CHARS)}` : memory}`,
			`The chat:\n\n${talk}`,
		]
			.filter((part) => part !== "")
			.join("\n\n");
		const key = `${SUGGESTIONS_KEY}${session}`;
		const of = await digestHex(input);
		const stored = this.host.store.meta(key);
		const cached = stored === undefined ? undefined : (JSON.parse(stored) as { of: string; items: string[] });
		if (cached?.of === of) return cached.items;

		// Two asks at once share one answer.
		let writing = this.host.suggesting.get(key);
		if (!writing || writing.of !== of) {
			const promise = this.host.utilityStructured(SUGGEST_PROMPTS, input).then((items) => {
				this.host.store.setMeta(key, JSON.stringify({ of, items }));
				return items;
			});
			writing = { of, promise };
			this.host.suggesting.set(key, writing);
			void promise.then(
				() => this.host.suggesting.delete(key),
				() => this.host.suggesting.delete(key),
			);
		}
		try {
			return await writing.promise;
		} catch (error) {
			if (!(error instanceof HttpError)) console.warn("prompt suggestions failed", error);
			return cached?.items ?? [];
		}
	}

	/** Loads an installed widget for one of the owner's agents. One that throws comes back failed. */
	async loadWidget(agent: Agent, ref: string): Promise<ShownWidget> {
		const widget = this.host.extensions.widget(ref)!;
		const deleted = this.host.store.deletedSessions();
		// A task's conversation that isn't a chat works for the chat the work began in.
		const chatFor = (session: string) => this.host.taskApart(session)?.root ?? session;
		const ofAgent = (session: string) => {
			const chat = chatFor(session);
			return !this.host.visits.bySession(chat) && this.host.agents.ofSession(chat).id === agent.id;
		};
		const context: WidgetContext = {
			agent: { id: agent.id, name: agent.name, majordomo: agent.majordomo },
			timeZone: this.host.settings().timeZone,
			chatOf: (session) => (ofAgent(session) && !deleted.has(chatFor(session)) ? this.host.store.publicId(chatFor(session)) : null),
			ofAgent,
			data: this.host.extensionData.for(ref.slice(0, ref.indexOf("/"))),
		};
		const shown = { id: ref, title: widget.title, empty: widget.empty };
		try {
			return { ...shown, ...(await widget.load(context)) };
		} catch (error) {
			console.warn(`widget ${ref} failed`, error);
			return { ...shown, failed: true };
		}
	}

	/** The widgets an agent can show: those of every installed extension. */
	#widgetsFor(): { ref: string; widget: Widget }[] {
		return this.host.extensions.list().flatMap((extension) => Object.entries(extension.widgets ?? {}).map(([name, widget]) => ({ ref: `${extension.id}/${name}`, widget })));
	}

	/** The widgets a chat can show with its messages: those its agent can show. None in a visit, or in a task's conversation. */
	chatWidgets(session: string): { ref: string; description: string }[] {
		if (this.host.visits.bySession(session) || this.host.taskApart(session)) return [];
		return this.#widgetsFor().map(({ ref, widget }) => ({ ref, description: widget.description }));
	}

	/** Who started a chat to hand its agent a task, from which chat, and how the task is going; null for a chat the person started. */
	startedBy(session: string): { session: string; agent: { id: string; name: string }; task: string; state: Task["state"] } | null {
		const continuation = this.host.store.continuation(session);
		const task = this.host.tasks.of(session) ?? (continuation === null ? undefined : this.host.tasks.of(continuation));
		if (!task?.chat || task.requester === null) return null;
		const agent = this.host.roleOf(task.requester).agent;
		return { session: this.host.store.publicId(task.root), agent: { id: agent.id, name: agent.name }, task: task.id, state: task.state };
	}

	/** The chat a chat carries on, under its public id; null for one the person started fresh. */
	continuedFrom(session: string): string | null {
		const from = this.host.store.continuedFrom(session);
		return from === null ? null : this.host.store.publicId(from);
	}

	/**
	 * Compaction would hide a long chat's early history in the chat itself. Instead the chat
	 * stays as it is, and a fork of it, compacted, is the chat the conversation goes on in: it
	 * opens with the summary, and the sidebar lists it in the place of the chat it carries on, which is archived. A chat is
	 * continued once; a run that already overflowed is still compacted in place, to go on.
	 */
	continuationExtension() {
		return defineExtension({
			name: CONTINUATION_EXTENSION,
			hooks: [
				hook(CompactionTask, {
					beforeCompact: async ({ reason }, api) => {
						const session = String(api.conversationId);
						// Chats the person talks in alone; tasks', rooms' and visits' stay as they were.
						if (reason === "manual" || this.host.hiddenSessions().has(session) || this.host.visits.bySession(session) || this.host.rooms.seats(session).length > 0) return undefined;
						if (!this.host.store.isContinued(session)) {
							const fork = await this.host.harness.sessions.fork(session);
							this.host.agents.setSession(fork.id, this.host.agents.ofSession(session).id);
							const abilities = this.host.agents.abilities(session);
							if (abilities !== null) this.host.agents.setAbilities(fork.id, abilities);
							this.host.store.touchSession(fork.id, this.host.store.sessionInfo(session)?.title ?? undefined);
							this.host.store.continueSession(fork.id, session);
							// The chat goes on with the model chosen for it.
							this.host.store.setSessionModel(fork.id, this.host.store.sessionInfo(session)?.model ?? null);
							await this.host.harness.session(fork.id).setModel(this.host.sessionModel(fork.id));
							await (await this.host.harness.conversation(fork.id)).compact(undefined, BACKGROUND_CONTEXT);
							this.host.broadcastMessage({ type: "sessions" });
						}
						return reason === "overflow" ? undefined : { decline: true as const };
					},
				}),
			],
		});
	}
}
