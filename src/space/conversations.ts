/**
 * The work in conversations: tasks agents hand to each other, group chats and their seats, the person's messages and the queue behind a run,
 * stopping and resuming runs, and the watchdog that finds a run that stalled.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, type ConversationInit, type EntryId, type UserInput, InboxDoc, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { type PiModel, PiHarness, type PiOperationResult, type PiReceipt } from "agents/harness/pi";
import { ImageStore } from "../images";
import { INSTALL_SKILL, skillsSwitch, WRITE_SKILL } from "../extensions/skills";
import { describeWait } from "../extensions/approvals";
import type { Ability } from "../extensions/define";
import { plainReply } from "../extensions/messaging";
import { CREATE_MEMORY_SCOPE } from "../extensions/optmem";
import { ADD_CUSTOM_CONNECTOR, SHARE_MEMORY_SCOPE } from "../extensions/agents";
import { cancelTask } from "../extensions/schedule";
import { Computer } from "../computer";
import { HttpError } from "@pim/shared/http";
import type { PublicApproval, ServerMessage } from "../protocol";
import { type Approval, type Notification, PimStore } from "../store";
import { type Agent, AgentStore } from "../agents";
import { MAX_ROOM_DEPTH, mentioned, mentionsPerson, ROOM_ENTRY, ROOM_NOTICE, type RoomMode, RoomStore, roomPost, type Seat } from "../rooms";
import type { StableOperation } from "@pim/triggers/host";
import { fromAgent, MAX_TASK_DEPTH, type Role, type Task, TaskStore, TERMINAL_STATES, taskUpdate } from "../tasks";
import { Telemetry } from "../telemetry";
import { changeOf, changesBlock, type FileNow, MAX_SEEN_BYTES, MAX_SEEN_FILES, sha256Hex, textOf as fileTextOf } from "../file-changes";
import { CODING_EVENT, fromPerson, projectEntries } from "@pim/shared/transcript";
import { RunWatch, runKey } from "../run-guard";
import { conversationText } from "../utility";
import { type Limits, UsageMeter } from "../usage";
import { VisitStore } from "../visits";
import { ARCHIVE_WHEN_IDLE_KEY, awaitingKey, type ToolPermissionInfo, type OwnerStatus, type OwnerProfile, FORK_KEY, PERSON_NAME_KEY, within, clipTitle, describeModel } from "./shared";

/** Starts the operation id of an input that wakes the agent of a finished task. */
export const WAKE = "wake:";

/** How long Stop waits for a chat's work to end before it answers anyway: the work was told to stop, and ends when it can. */
export const STOP_WAIT_MS = 5_000;

export const WATCHDOG_CALLBACK = "watchRuns";

/** Tools of the space the person talks with that an agent at work on a task doesn't get, though their extensions stay. */
/**
 * Only the majordomo is offered these: naming memory scopes and choosing which agents read them, as it reads every
 * scope; and, in the admin's space, adding connectors to this Pim.
 */
export const MAJORDOMO_TOOLS = [CREATE_MEMORY_SCOPE, SHARE_MEMORY_SCOPE, ADD_CUSTOM_CONNECTOR];

export function textOf(content: UserInput): string {
	return typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
}

/** A session's first name: the start of the first thing the user said, until the utility model names it. */
export function titleFrom(content: UserInput): string | undefined {
	const text = textOf(content);
	return text.trim() === "" ? undefined : clipTitle(text);
}

/** `submitTo`'s shape, for the collaborators that hand a message in. */
export type Submit = (session: string, content: UserInput, options: { operationId?: string; whenBusy?: "followUp" | "steer"; stable?: StableOperation }, from: "user" | "pim" | "approval" | "task") => Promise<PiReceipt>;

/** What the space's conversations needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface ConversationsHost {
	readonly assertOpen: () => void;
	readonly status: () => OwnerStatus;
	readonly storageRefusal: () => string | null;
	readonly usage: UsageMeter;
	readonly name: string;
	readonly tasks: TaskStore;
	readonly visits: VisitStore;
	readonly refreshVisit: (hostOwnerId: string) => Promise<void>;
	readonly store: PimStore;
	readonly keepAliveWhile: <T>(fn: () => Promise<T>) => Promise<T>;
	readonly nameSession: (session: string, conversation: string, current: string) => Promise<void>;
	readonly harness: PiHarness;
	readonly selectAbilities: (session: string) => Promise<void>;
	readonly images: ImageStore;
	readonly broadcastMessage: (message: ServerMessage) => void;
	readonly telemetry: Telemetry;
	readonly agents: AgentStore;
	readonly workspaceFallbacks: () => PiModel[];
	readonly runModel: (session: string) => PiModel;
	readonly computer: Computer;
	readonly limits: () => Limits;
	readonly hiddenSessions: () => Set<string>;
	readonly sessionModel: (session: string, agent?: Agent) => PiModel;
	readonly agentToolPermissions: (agent: Agent) => ToolPermissionInfo[];
	readonly abilities: Map<string, Ability>;
	readonly rooms: RoomStore;
	readonly withReplies: (result: PiOperationResult) => Promise<PiOperationResult & { replies: string[]; }>;
	readonly submitTo: Submit;
	readonly resumeHeld: (conversation: string) => Promise<boolean>;
	readonly profile: () => OwnerProfile | null;
	readonly env: Env;
	readonly deliverNotification: (notification: Notification, options?: { sockets?: boolean; push?: boolean; }) => Promise<void>;
	readonly joining: Map<string, Promise<Seat>>;
	readonly heldSessions: () => Promise<Set<string>>;
	readonly sessionModelInfo: (session: string) => { model: ReturnType<typeof describeModel>; override: boolean; };
	readonly publicApproval: (approval: Approval) => PublicApproval;
	readonly stallMs: () => number;
	readonly schedule: (when: Date | string | number, callback: string, payload?: unknown, options?: { idempotent?: boolean }) => Promise<unknown>;
	readonly closed: () => boolean;
	readonly runWatch: RunWatch;
	readonly note: (event: string, fields: Record<string, unknown>) => void;
	readonly running: Set<string>;
}

export class Conversations {
	constructor(private readonly host: ConversationsHost) {}

	/**
	 * Every message into a session goes through here, so the session list
	 * knows its activity; the user's first message also names it. A new run
	 * (from the user, a schedule or a connector) counts against the daily limit;
	 * an approval's outcome, or tasks' answers, continue work already
	 * counted, so they do not.
	 *
	 * `stable` is for a caller that must keep one key for an operation
	 * across retries, as a trigger's handoff does (./triggers/host.ts): it is
	 * told the key the input goes in under before anything is submitted, and
	 * with `exact` the key it recorded is used as it is, never rewritten.
	 */
	async submitTo(
		session: string,
		content: UserInput,
		options: { operationId?: string; whenBusy?: "followUp" | "steer"; stable?: StableOperation },
		from: "user" | "pim" | "approval" | "task",
	): Promise<PiReceipt> {
		const { stable, ...given } = options;
		if (stable && given.operationId === undefined) throw new Error("A stable operation needs its operation id");
		this.host.assertOpen();
		if (this.host.status() !== "active") throw new HttpError(403, "This space is suspended");
		// Checked and counted before the first await, so concurrent submissions can't all pass the same check.
		let run: string | undefined;
		if (from !== "approval" && from !== "task") {
			const storage = this.host.storageRefusal();
			const reserved = storage === null ? this.host.usage.reserveRun() : ({ ok: false, refusal: storage } as const);
			if (!reserved.ok) {
				console.warn(JSON.stringify({ event: "pim.limit", limit: "run", owner: this.host.name, from, reason: reserved.refusal }));
				throw new HttpError(429, reserved.refusal);
			}
			run = reserved.reservation;
		}
		// An event waking the agent of a finished task puts the task back to work, so that its answer reaches the agent that asked.
		const finished = from === "pim" ? this.host.tasks.of(session) : undefined;
		// A key given exactly keeps its form: it wakes the task only if it was recorded as a wake, so a retry after the task reopened, or finished, goes in under the same key.
		const mayWake = !stable?.exact || given.operationId!.startsWith(WAKE);
		const waking = finished?.chat && finished.requester !== null && finished.kind !== "review" && TERMINAL_STATES.has(finished.state) && mayWake ? finished : undefined;
		options = waking && !stable?.exact ? { ...given, operationId: `${WAKE}${given.operationId ?? crypto.randomUUID()}` } : given;
		let receipt: PiReceipt;
		try {
			stable?.keep(options.operationId!);
			// A visit goes on only as its host allows now: what it may use is asked anew before each turn.
			const visit = this.host.visits.bySession(session);
			if (visit) await this.host.refreshVisit(visit.ownerId);
		} catch (error) {
			if (run !== undefined) this.host.usage.releaseRun(run);
			throw error;
		}
		const title = from === "user" && !this.host.visits.bySession(session) ? titleFrom(content) : undefined;
		const named = (this.host.store.sessionInfo(session)?.title ?? null) !== null;
		// The person going on in a chat that was carried on keeps it: nothing is forwarded from it any more.
		if (from === "user") this.host.store.resumeContinuedSession(session);
		this.host.store.touchSession(session, title);
		const said = `Person: ${textOf(content).slice(0, 2_000)}`;
		if (title !== undefined && !named) void this.host.keepAliveWhile(() => this.host.nameSession(session, said, title));
		// A fork's first message is where it leaves the chat it came from: it is named from what was said before, and that.
		const forked = from === "user" ? this.host.store.meta(`${FORK_KEY}${session}`) : undefined;
		let kept: string[] = [];
		try {
			if (forked !== undefined) {
				this.host.store.deleteMeta(`${FORK_KEY}${session}`);
				const before = conversationText(projectEntries(await this.host.harness.session(session).messages()), 6_000);
				void this.host.keepAliveWhile(() => this.host.nameSession(session, before === "" ? said : `${before}\n\n${said}`, forked));
			}
			await this.host.selectAbilities(session);
			// Images go to R2; the message keeps their URLs.
			const stored = await this.host.images.keep(session, content);
			kept = stored.ids;
			receipt = from === "user" ? await this.#personSays(session, stored.content, options) : await this.submit(session, stored.content, options, from);
		} catch (error) {
			if (run !== undefined) this.host.usage.releaseRun(run);
			await this.host.images.delete(kept);
			throw error;
		}
		if (receipt.accepted && from === "user") {
			this.host.store.setMeta(awaitingKey(session), "1");
			// Something said in a chat lists it again: an archive waiting for it to stop no longer applies.
			this.host.store.deleteMeta(`${ARCHIVE_WHEN_IDLE_KEY}${session}`);
		}
		if (receipt.accepted) {
			void this.armWatchdog().catch((error) => console.warn("arming the run watchdog failed", error));
			void this.host.keepAliveWhile(async () => {
				await this.host.harness.wait(receipt.operationId, { session });
				const key = `${ARCHIVE_WHEN_IDLE_KEY}${session}`;
				if (this.host.store.meta(key) === undefined || (await this.host.harness.session(session).busy())) return;
				this.host.store.deleteMeta(key);
				this.archive(session);
			});
		}
		if (receipt.accepted && waking) {
			this.host.tasks.reopen(waking.id, receipt.operationId);
			this.#watchTask(session, receipt.operationId);
			this.tasksChanged(waking.root);
		}
		// A retried submission (the same operation id) is not accepted again: one run, not two, and its images once.
		if (!receipt.accepted) {
			if (run !== undefined) this.host.usage.releaseRun(run);
			await this.host.images.delete(kept);
		}
		return receipt;
	}

	/** Archives a chat as the person's Archive does by hand, with the chats of the tasks it handed out, and theirs: a chat is only done once its tasks are. */
	archive(session: string): void {
		this.#setArchived(session, true);
	}

	/** Lists a chat again, with the chats of the tasks it handed out, and theirs, as archiving it took them away together. */
	unarchive(session: string): void {
		this.#setArchived(session, false);
	}

	#setArchived(session: string, archive: boolean): void {
		const archived = new Set<string>();
		for (const pending = [session]; pending.length > 0; ) {
			const chat = pending.pop()!;
			if (archived.has(chat)) continue;
			archived.add(chat);
			if (archive) this.host.store.archiveSession(chat);
			else {
				this.host.store.resumeContinuedSession(chat);
				this.host.store.unarchiveSession(chat);
			}
			for (const task of this.host.tasks.byRequester(chat)) if (task.chat && task.kind !== "review") pending.push(task.conversation);
		}
		this.host.broadcastMessage({ type: "sessions" });
	}

	/** Gives pi input for a conversation, traced as part of its run (see ./telemetry.ts). */
	async submit(session: string, content: UserInput, options: { operationId?: string; whenBusy?: "followUp" | "steer" }, from: string): Promise<PiReceipt> {
		const withdraw = this.host.telemetry.submitting(session, content, from);
		// A conversation that moved on to a fallback model tries the agent's own again.
		const agent = this.host.agents.ofSession(session);
		if (agent.fallbacks.length > 0 || this.host.workspaceFallbacks().length > 0) await this.host.harness.session(session).setModel(this.host.runModel(session));
		let receipt: PiReceipt;
		try {
			// Files the agent saw that changed since go before what the person said, as a part of their own: no prompt section, so the prompt cache holds.
			const changes = from === "user" ? await this.#fileChanges(session) : null;
			const given = changes ? [{ type: "text" as const, text: changes.block }, ...(typeof content === "string" ? [{ type: "text" as const, text: content }] : content)] : content;
			receipt = await this.host.harness.submit(given, { session, ...options });
			if (receipt.accepted) changes?.seen();
		} catch (error) {
			withdraw();
			throw error;
		}
		if (!receipt.accepted) withdraw();
		else if (this.host.telemetry.enabled) void this.host.keepAliveWhile(async () => this.host.telemetry.settled(session, await this.host.harness.wait(receipt.operationId, { session })));
		return receipt;
	}

	/**
	 * Remembers that the agent of `session` saw `path` as it is on the computer
	 * now (or as `sha256`, when it read it): its hash, and its text while it is
	 * small, to show later what the person changed. A file that is gone, or
	 * has no hash, is forgotten.
	 */
	async sawFile(session: string, path: string, sha256?: string): Promise<void> {
		const now = await this.#fileNow(path);
		if (!now.exists) return this.host.store.forgetSeenFile(session, path);
		const same = sha256 === undefined || sha256 === now.sha256;
		this.host.store.keepSeenFile(session, path, same ? now.sha256 : sha256, same ? now.text : null, MAX_SEEN_FILES);
	}

	/** A file on the computer as it is: gone, or its hash and size, and its text when it is small text. A file too big to hash stands for itself by its size and time. */
	async #fileNow(path: string): Promise<FileNow> {
		const stat = await this.host.computer.fs.stat(path).catch(() => null);
		if (!stat?.isFile) return { exists: false };
		if (stat.size > MAX_SEEN_BYTES) return { exists: true, sha256: stat.sha256 ?? `${stat.size}:${stat.mtime}`, size: stat.size, text: null };
		const bytes = new Uint8Array(await new Response(await this.host.computer.fs.readFile(path)).arrayBuffer());
		return { exists: true, sha256: await sha256Hex(bytes), size: bytes.byteLength, text: fileTextOf(bytes) };
	}

	/**
	 * The block telling the agent of `session` which of the files it saw have
	 * changed since, and what changed: by the person in the editor, or by any
	 * program on the computer other than the agent's own file tools. `seen`
	 * takes the files as they are now for what the agent is about to read, so
	 * each change is told once. Null with nothing changed, or no computer.
	 */
	async #fileChanges(session: string): Promise<{ block: string; seen: () => void } | null> {
		const known = this.host.store.seenFiles(session);
		if (known.length === 0 || !this.host.computer.paired()) return null;
		const now = await Promise.all(known.map((file) => this.#fileNow(file.path).catch(() => null)));
		const changes: string[] = [];
		const after: { path: string; now: FileNow }[] = [];
		known.forEach((file, index) => {
			const here = now[index];
			if (!here) return;
			const change = changeOf(file.path, file, here);
			if (change === null) return;
			changes.push(change);
			after.push({ path: file.path, now: here });
		});
		const block = changesBlock(changes);
		if (block === null) return null;
		return {
			block,
			seen: () => {
				for (const { path, now: here } of after) {
					if (here.exists) this.host.store.keepSeenFile(session, path, here.sha256, here.text, MAX_SEEN_FILES);
					else this.host.store.forgetSeenFile(session, path);
				}
			},
		};
	}

	/**
	 * Starts a chat with `agent`, within the person's limit on chats: a new
	 * one, or a fork of `session` that keeps what was said through entry `at`.
	 * `init` runs in the commit that makes a new one, as pi makes it.
	 */
	async startChat(agent: Agent, title: string | undefined, from?: { session: string; at: EntryId }, init?: ConversationInit): Promise<string> {
		const { sessions } = this.host.limits();
		if (sessions !== null) {
			const hidden = this.host.hiddenSessions();
			// Chats tasks started are the agents' doing, and don't count against the person's.
			const open = (await this.host.harness.sessions.list()).filter((session) => !hidden.has(session.id) && !this.host.tasks.of(session.id)?.chat).length;
			if (open >= sessions) throw new HttpError(429, `You can have up to ${sessions} chats. Delete one first.`);
		}
		const id = from
			? String((await (await this.host.harness.conversation(from.session)).fork(from.at, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT)).id)
			: init
				? String((await (await this.host.harness.pi()).createConversation({ ownership: { kind: "ownerless" }, agent: this.host.harness.agentDefaults(), init }, BACKGROUND_CONTEXT)).id)
				: (await this.host.harness.sessions.create()).id;
		// A fork keeps the model chosen for the chat it came from.
		if (from) this.host.store.setSessionModel(id, this.host.store.sessionInfo(from.session)?.model ?? null);
		await this.host.harness.session(id).setModel(this.host.sessionModel(id, agent));
		this.host.agents.setSession(id, agent.id);
		this.host.store.touchSession(id, title);
		return id;
	}

	// The owner's agents, and the tasks they hand each other (./tasks.ts).

	/**
	 * The task a conversation is when it isn't one of the person's chats: a
	 * review, or a task from before tasks were chats. A chat a task started
	 * is a chat like any other.
	 */
	taskApart(conversation: string): Task | undefined {
		const task = this.host.tasks.of(conversation);
		return task?.chat ? undefined : task;
	}

	/** The task a chat another agent started is still working on for it, during which the chat answers that agent rather than the person. */
	taskUnderway(conversation: string): Task | undefined {
		const task = this.host.tasks.of(conversation);
		return task && task.kind !== "review" && !TERMINAL_STATES.has(task.state) ? task : undefined;
	}

	/** The agent a conversation talks as, and who handed it its task, unless it is a chat. A review talks as the majordomo. */
	roleOf(session: string): Role {
		const task = this.taskApart(session);
		if (!task) return { agent: this.host.agents.ofSession(session), from: null };
		if (task.kind === "review") return { agent: this.host.agents.majordomo(), from: null };
		const agent = this.host.agents.get(task.agent) ?? this.host.agents.majordomo();
		return { agent, from: this.roleOf(task.requester!).agent.name };
	}

	/**
	 * Whom a conversation can hand tasks to: the majordomo, the person's other
	 * agents; any other agent, its contacts. None of the agents already on the
	 * chain of tasks that led to it, so work never goes round in a circle, and
	 * none at all `MAX_TASK_DEPTH` tasks down the chain.
	 */
	delegates(session: string): Agent[] {
		if (this.host.visits.bySession(session) || this.host.tasks.of(session)?.kind === "review") return [];
		const chain: string[] = [];
		for (let conversation: string | null = session; conversation !== null; ) {
			chain.push(this.roleOf(conversation).agent.id);
			conversation = this.host.tasks.of(conversation)?.requester ?? null;
		}
		if (chain.length > MAX_TASK_DEPTH) return [];
		const { agent } = this.roleOf(session);
		const candidates = agent.majordomo ? this.host.agents.list() : agent.contacts.flatMap((id) => this.host.agents.get(id) ?? []);
		return candidates.filter((other) => !other.majordomo && !chain.includes(other.id));
	}

	/**
	 * The names of the tools an agent's conversations aren't offered: the connector
	 * tools switched off for it, writing and installing skills when its switch
	 * for skills is off, the tools of abilities not offered to it, and, for
	 * any agent but the majordomo, the majordomo's own: naming and sharing
	 * memory scopes, and adding connectors.
	 */
	switchedOff(agent: Agent): Set<string> {
		const off = this.host.agentToolPermissions(agent).flatMap((info) => (info.permission === "off" ? [info.name] : []));
		if (skillsSwitch(this.host.store, agent.id).permission === "off") off.push(WRITE_SKILL, INSTALL_SKILL);
		for (const { tools, actions, offeredTo } of this.host.abilities.values()) {
			if (offeredTo?.(agent) !== false) continue;
			off.push(...(tools ?? []).map((tool) => tool.name), ...(actions ?? []).map((action) => action.name));
		}
		return new Set(agent.majordomo ? off : [...off, ...MAJORDOMO_TOOLS]);
	}

	/**
	 * Gives out tasks a conversation hands out, each in a new chat of its own
	 * or that of the earlier task it continues, under the chat that asked.
	 * Their answers come back in an update (see `#deliver`), or, when the
	 * call `waits`, as what it returns. A replayed call finds the tasks it
	 * gave, and gives them again only where giving didn't finish.
	 */
	async startTasks(
		requester: string,
		batch: string,
		given: { to: Agent; task: string; continues: Task | null }[],
		{ call, waits }: { call: string; waits: boolean },
	): Promise<Task[]> {
		const asking = this.host.tasks.of(requester);
		// Work shows in the chat that handed it out, and work an agent in a room hands out in the room's chat. A task's conversation that isn't a chat has none: its work shows where its own began.
		const root = this.taskApart(requester)?.root ?? this.host.rooms.of(requester)?.room ?? requester;
		const started: Task[] = [];
		for (const [position, { to, task, continues }] of given.entries()) {
			let record = this.host.tasks.at(batch, position);
			if (!record) {
				// A chat that grew too long carries on in a new one, so a follow-up goes on there: the old chat is full.
				const conversation = continues ? await this.carriedOn(continues.conversation) : await this.#taskConversation(to);
				record = this.host.tasks.start({
					kind: "agent",
					conversation,
					requester,
					parent: asking && asking.kind !== "review" ? asking.id : null,
					root,
					batch,
					call,
					waits,
					// A follow-up goes on where the earlier task worked, a chat or not.
					chat: continues?.chat ?? true,
					position,
					agent: to.id,
					task,
				});
				// Named after the task, a new chat joins the list, and the utility model names it as it names the person's; a follow-up brings its chat up again.
				if (record.chat) {
					const title = continues ? undefined : clipTitle(task);
					this.host.store.touchSession(record.conversation, title);
					if (title !== undefined) void this.host.keepAliveWhile(() => this.host.nameSession(record!.conversation, task, title));
					this.host.broadcastMessage({ type: "sessions" });
				}
			}
			// Submitting the same operation again is a no-op: a replay gives the task once.
			await this.submit(record.conversation, this.#taskInput(record), { operationId: `task:${record.id}`, whenBusy: "followUp" }, "task");
			this.#watchTask(record.conversation, `task:${record.id}`);
			started.push(record);
		}
		this.tasksChanged(root);
		return started;
	}

	/** A new chat for a task, with the agent it is for. It is listed once the task is recorded, so a replay leaves no empty chat behind. */
	async #taskConversation(agent: Agent): Promise<string> {
		const { id } = await this.host.harness.sessions.create();
		await this.host.harness.session(id).setModel(this.host.sessionModel(id, agent));
		this.host.agents.setSession(id, agent.id);
		await this.host.selectAbilities(id);
		return id;
	}

	/** What a task's agent is given: in a chat, the task as a message from the agent that handed it out. */
	#taskInput(task: Task): string {
		return task.chat ? `${fromAgent(this.roleOf(task.requester!).agent.name)}\n${task.task}` : task.task;
	}

	/**
	 * Waits, in memory, for an input to a task's conversation to settle, which
	 * may finish the task. Nothing keeps the space up for it: a run keeps it
	 * up, and after a restart `onStart` waits again (`#resumeTasks`).
	 */
	#watchTask(conversation: string, operation: string): void {
		void this.host.harness
			.wait(operation, { session: conversation })
			.then((result) => this.#taskSettled(conversation, result))
			.catch((error) => this.#taskWaitFailed(conversation, operation, error));
	}

	/** A wait that threw, as when the task's run crashed: the task fails and its requester is told, rather than it staying at work for good. */
	async #taskWaitFailed(conversation: string, operation: string, error: unknown): Promise<void> {
		console.warn(`waiting for ${operation} failed`, error);
		try {
			const task = this.host.tasks.of(conversation);
			if (!task || task.kind === "review" || TERMINAL_STATES.has(task.state)) return;
			const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
			if (!this.host.tasks.finish(task.id, "failed", `It didn't finish: ${reason}.`)) return;
			this.tasksChanged(task.root);
			await this.#deliver(task.batch);
		} catch (failure) {
			console.warn(`failing the task of ${conversation} failed`, failure);
		}
	}

	/**
	 * A task is done once its agent has answered its latest input and waits
	 * for no task it handed out: its answer is that last turn's, in a chat
	 * what it sent there. A run that ended unanswered fails it.
	 */
	async #taskSettled(conversation: string, result: PiOperationResult): Promise<void> {
		const task = this.host.tasks.of(conversation);
		if (!task || task.kind === "review" || TERMINAL_STATES.has(task.state)) return;
		if (result.operationId !== task.operation || this.host.tasks.waitsOnTasks(conversation)) return;
		const done = result.status === "done";
		const said = task.chat ? (await this.host.withReplies(result)).text : result.text;
		const answer = done ? said?.trim() || "(It gave no answer.)" : `It didn't finish: ${result.reason ?? "unanswered"}.`;
		if (!this.host.tasks.finish(task.id, done ? "completed" : "failed", answer)) return;
		this.tasksChanged(task.root);
		// Woken by an event with nothing to say: nothing to tell the agent that asked.
		if (done && !said?.trim() && task.operation.startsWith(WAKE)) {
			this.host.tasks.drop(task.batch);
			return;
		}
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
		const tasks = this.host.tasks.inBatch(batch);
		const requester = tasks[0]?.requester;
		if (!requester || tasks.some((task) => task.state === "working")) return;
		// No one is left to tell: the chat that asked was deleted, or the task that asked was canceled since. A chat whose task was canceled may still hand out more for the person.
		const asking = this.host.tasks.of(requester);
		if (this.host.store.deletedSessions().has(requester) || (asking?.state === "canceled" && asking.updatedAt >= tasks[0]!.createdAt)) {
			this.host.tasks.drop(batch);
			return;
		}
		if (tasks[0]!.waits) {
			if (tasks.some((task) => !TERMINAL_STATES.has(task.state))) return;
			if ((await this.resumeTask(requester, Number(batch) as TaskId)) !== "terminal") return;
			// The call ended without them, as when its chat was stopped: the answers come in an update.
			this.host.tasks.stopWaiting(batch);
		}
		const done = this.host.tasks.unanswered(batch);
		if (done.length === 0) return;
		// A task woken again and answered anew is told again, as another update.
		const operation = `task-update:${done.map((task) => `${task.id}@${task.updatedAt}`).join(",")}`;
		this.host.tasks.giving(
			done.map((task) => task.id),
			operation,
		);
		await this.#giveUpdate(requester, batch, operation);
	}

	/**
	 * Where what is sent to a chat goes: a chat that grew too long is carried on in a new one,
	 * which then hears the answers to the tasks the chat handed out, its schedules, triggers and events,
	 * and which a task's follow-ups go to, since the old chat is full. The tasks the chat did or
	 * handed out move over, so the new chat is the one recorded for them, only once the old chat
	 * is at rest: nothing at work for it, no call waiting in it for answers, and no task of its
	 * own under way. Until then the old chat is the one that is still going on.
	 */
	async carriedOn(session: string): Promise<string> {
		for (let next = this.host.store.continuation(session); next !== null; next = this.host.store.continuation(session)) {
			if (this.host.tasks.isWaiting(session) || this.taskUnderway(session) || (await this.host.harness.session(session).busy())) return session;
			if (this.host.tasks.byRequester(session).some((task) => task.state === "working" || task.state === "auth-required")) return session;
			this.host.tasks.carryOn(session, next);
			session = next;
		}
		return session;
	}

	/** Submits an update `#deliver` marked as being given; again after a restart, which gives it once. */
	async #giveUpdate(requester: string, batch: string, operation: string): Promise<void> {
		const tasks = this.host.tasks.inBatch(batch);
		const by = (task: Task) => ({ task, by: this.host.agents.get(task.agent)?.name ?? "An agent" });
		const text = taskUpdate(
			tasks.filter((task) => task.update === operation).map(by),
			tasks.filter((task) => task.state === "auth-required").map(by),
		);
		try {
			await this.host.submitTo(await this.carriedOn(requester), text, { operationId: operation, whenBusy: "followUp" }, "task");
		} catch (error) {
			console.warn(`giving ${operation} failed`, error);
			return;
		}
		this.host.tasks.given(operation);
		// An agent at work on a task of its own goes on with the answers, and finishes its task once it has them all.
		const asking = this.host.tasks.of(requester);
		if (asking && asking.kind !== "review" && !TERMINAL_STATES.has(asking.state)) {
			this.host.tasks.setOperation(asking.id, operation);
			this.#watchTask(requester, operation);
		}
		for (const listener of this.#updateListeners.get(requester) ?? []) listener(operation);
	}

	/** After a restart: waits again for open tasks, gives a task that may not have been given, and updates that may not have been. */
	async resumeTasks(): Promise<void> {
		for (const task of this.host.tasks.open()) {
			// Giving the same operation again is a no-op: this gives a task only if the restart came between recording and giving it.
			if (task.operation === `task:${task.id}`) {
				try {
					await this.submit(task.conversation, this.#taskInput(task), { operationId: task.operation, whenBusy: "followUp" }, "task");
				} catch (error) {
					await this.#taskWaitFailed(task.conversation, task.operation, error);
					continue;
				}
			}
			this.#watchTask(task.conversation, task.operation);
		}
		for (const { batch, operation } of this.host.tasks.beingGiven()) {
			const requester = this.host.tasks.inBatch(batch)[0]?.requester;
			if (requester) await this.#giveUpdate(requester, batch, operation);
		}
		// A call waiting for tasks that finished just before the restart may not have been woken.
		for (const batch of this.host.tasks.waiting()) await this.#deliver(batch);
	}

	// Rooms: chats grown into group chats (./rooms.ts).

	/** Whether a conversation is one of the person's chats with their own agents, which can grow into a room. */
	roomable(conversation: string): boolean {
		const seat = this.host.rooms.of(conversation);
		return !this.host.visits.bySession(conversation) && !this.taskApart(conversation) && (!seat || seat.room === conversation);
	}

	/** The agents in a room's seats, in order. */
	seated(seats: readonly Seat[]): Agent[] {
		return seats.flatMap((seat) => this.host.agents.get(seat.agent) ?? []);
	}

	/**
	 * The agents a conversation can bring into its chat by mentioning them:
	 * the majordomo, any of the person's other agents; any other agent, its
	 * contacts. None already there.
	 */
	invitable(conversation: string): Agent[] {
		const seat = this.host.rooms.of(conversation);
		if (!seat && !this.roomable(conversation)) return [];
		const { agent } = this.roleOf(conversation);
		const present = new Set(seat ? this.host.rooms.seats(seat.room).map((other) => other.agent) : [agent.id]);
		const candidates = agent.majordomo ? this.host.agents.list() : agent.contacts.flatMap((id) => this.host.agents.get(id) ?? []);
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
		if (!this.roomable(session)) return this.submit(session, content, options, "user");
		const text = textOf(content);
		const host = this.host.agents.ofSession(session);
		for (const agent of mentioned(text, this.host.agents.list().filter((other) => other.id !== host.id))) await this.join(session, agent);
		const seats = this.host.rooms.seats(session);
		if (seats.length === 0) return this.submit(session, content, options, "user");
		const operationId = options.operationId ?? crypto.randomUUID();
		const named = new Set(mentioned(text, this.seated(seats)).map((agent) => agent.id));
		const open = this.host.rooms.mode(session) === "open";
		const wakes = (seat: Seat) => open || named.has(seat.agent) || (seat.conversation === session && named.size === 0);
		const [hosting, ...members] = seats as [Seat, ...Seat[]];
		this.#logTurns("person", session, seats, named, wakes);
		const receipt = wakes(hosting) ? await this.submit(session, content, { ...options, operationId }, "user") : await this.#write(session, content, operationId);
		// A message sent again reaches no one twice.
		if (!receipt.accepted) return receipt;
		if (wakes(hosting)) {
			await this.host.resumeHeld(session);
			this.host.rooms.setDepth(session, 0);
		}
		for (const seat of members) await this.#hear(seat, content, `${operationId}:${seat.agent}`, wakes(seat), 0);
		return receipt;
	}

	/** Says in the log who a message in a room was for and who it woke, so a silent agent can be told from one that was never asked. */
	#logTurns(from: string, room: string, seats: readonly Seat[], named: ReadonlySet<string>, wakes: (seat: Seat) => boolean, depth = 0): void {
		const name = (seat: Seat) => this.host.agents.get(seat.agent)?.name ?? seat.agent;
		console.log(JSON.stringify({ event: "pim.room", owner: this.host.name, room, from, depth, mode: this.host.rooms.mode(room), mentioned: [...named].map((id) => this.host.agents.get(id)?.name ?? id), seats: seats.map(name), woke: seats.filter(wakes).map(name) }));
	}

	/**
	 * An agent sent a message in a chat (`send_to_user`), with Pim's copies
	 * of the images it shows, by their addresses. An agent it mentions that it may bring in joins
	 * the chat first. In a room the other seats hear it: those it mentions,
	 * or everyone in an open room, take a turn, one further from the person's
	 * message than the turn that sent it; the others hear it without being woken.
	 */
	async posted(conversation: string, message: string, at: number, images: Readonly<Record<string, string>>): Promise<void> {
		// An agent taken out of a room, still finishing a message, brings no one in and is heard by no one.
		if (this.host.store.deletedSessions().has(conversation)) return;
		if (!this.host.rooms.of(conversation) && !this.roomable(conversation)) return;
		const room = this.host.rooms.of(conversation)?.room ?? conversation;
		const speaker = this.roleOf(conversation).agent;
		await this.#mentionPerson(room, speaker, message, at);
		for (const agent of mentioned(message, this.invitable(conversation))) await this.join(room, agent);
		// The chat shows the images as the sender's own message does, from Pim's copies.
		const said = Object.entries(images).reduce((text, [url, copy]) => text.replaceAll(url, copy), message);
		const seat = this.host.rooms.of(conversation);
		if (!seat) return;
		const seats = this.host.rooms.seats(room);
		const named = new Set(mentioned(message, this.seated(seats)).map((agent) => agent.id));
		const open = this.host.rooms.mode(room) === "open";
		const depth = seat.depth + 1;
		this.#logTurns(speaker.name, room, seats, named, (other) => other.conversation !== conversation && (open || named.has(other.agent)) && depth < MAX_ROOM_DEPTH, depth);
		for (const other of seats) {
			if (other.conversation === conversation) continue;
			const wake = (open || named.has(other.agent)) && depth < MAX_ROOM_DEPTH;
			await this.#hear(other, roomPost(speaker.name, said), `post:${conversation}:${at}:${other.agent}`, wake, depth);
		}
	}

	/** What an agent can call the person, from what this space knows: their username, and the name they gave their majordomo. */
	personNames(): string[] {
		const username = this.host.profile()?.username;
		return username ? [...new Set([username, this.host.store.meta(PERSON_NAME_KEY)].filter((name): name is string => !!name))] : [];
	}

	/** Those, and the display name on their public profile, which they can change in Settings. */
	async #personNamesWithProfile(): Promise<string[]> {
		const names = this.personNames();
		const username = this.host.profile()?.username;
		if (!username) return names;
		const shown = (await this.host.env.Gallery.getByName("gallery").profile(username).catch(() => null))?.displayName;
		return shown ? [...new Set([...names, shown])] : names;
	}

	/** Tells the person an agent mentioned them, as `@username`: a notification of its own kind, once however often the message is replayed. */
	async #mentionPerson(room: string, speaker: Agent, message: string, at: number): Promise<void> {
		if (!message.includes("@") || !mentionsPerson(message, await this.#personNamesWithProfile())) return;
		const id = `mention-${this.host.store.publicId(room)}-${speaker.id}-${at}`;
		if (this.host.store.notification(id)) return;
		const notification = this.host.store.addNotification({ id, kind: "mention", session: room, title: `${speaker.name} mentioned you`, body: plainReply(message).slice(0, 500) });
		await this.host.deliverNotification(notification);
	}

	/**
	 * Gives a seat what was said in its room: as input, which wakes its agent,
	 * `depth` turns from the person's latest message, or written in without
	 * waking it, for it to know when it next speaks.
	 */
	async #hear(seat: Seat, content: UserInput, operationId: string, wake: boolean, depth: number): Promise<void> {
		// A suspended space's agents set nothing more off.
		if (!wake || this.host.status() !== "active") {
			await this.#write(seat.conversation, content, operationId);
			return;
		}
		await this.host.selectAbilities(seat.conversation);
		const receipt = await this.submit(seat.conversation, content, { operationId, whenBusy: "followUp" }, "room");
		if (!receipt.accepted) return;
		// An agent whose run is held after a model error has no Try again of its own in a room: what it is now asked answers for it, or queues behind the error for good.
		await this.host.resumeHeld(seat.conversation);
		this.host.rooms.setDepth(seat.conversation, depth);
		// The chat shows who is at work in it: its list changes as an agent starts, and again when it's done.
		if (seat.conversation === seat.room) return;
		this.host.broadcastMessage({ type: "sessions" });
		void this.host.harness
			.wait(operationId, { session: seat.conversation })
			.then(() => this.host.broadcastMessage({ type: "sessions" }))
			.catch((error) => console.warn(`waiting for ${operationId} failed`, error));
	}

	/**
	 * Writes a message into a conversation without waking its agent: it is
	 * in the agent's context from its next request. While the agent works it
	 * waits for its next step. Writing the same operation again writes nothing.
	 */
	async #write(session: string, content: UserInput, operationId: string): Promise<PiReceipt> {
		const conversation = await this.host.harness.conversation(session);
		const known = await (await this.host.harness.storage()).submissionByRequest(conversation.id, operationId, BACKGROUND_CONTEXT);
		if (!known) {
			await conversation.submit(
				{ type: "write", requestId: operationId, entry: { kind: ROOM_ENTRY, model: [{ role: "user", content, timestamp: Date.now() }] } },
				BACKGROUND_CONTEXT,
			);
		}
		return { operationId, session, accepted: !known };
	}

	/**
	 * Changes one of the person's messages queued behind the work in a chat,
	 * before the agent reads it: `steer` has it join the running work after
	 * the agent's current step, rather than wait for the run to end; `text`
	 * rewrites it, keeping its images; `cancel` takes it back. Only the chat's
	 * own agent's queue changes: in a group chat, the other agents keep what they heard.
	 */
	async changeQueued(session: string, id: number, change: "steer" | "cancel" | { readonly text: string }): Promise<void> {
		const conversation = await this.host.harness.conversation(session);
		const outcome = await conversation.commit(async (tx) => {
			const items = (await tx.doc(InboxDoc, conversation.id)).items;
			const index = items.findIndex((item) => item.id === id);
			const item = items[index];
			if (!item) return "gone";
			if (item.mode === "write" || !fromPerson(textOf(item.content as UserInput))) return "not_yours";
			if (change === "steer") {
				item.mode = "steer";
			} else if (change === "cancel") {
				tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
				items.splice(index, 1);
			} else {
				const content = item.content as UserInput;
				const images = typeof content === "string" ? [] : content.filter((part) => part.type !== "text");
				if (change.text.trim() === "" && images.length === 0) return "empty";
				item.content = (images.length === 0 ? change.text : [...(change.text.trim() === "" ? [] : [{ type: "text", text: change.text }]), ...images]) as typeof item.content;
			}
			return "changed";
		}, BACKGROUND_CONTEXT);
		if (outcome === "gone") throw new HttpError(409, "The agent has this message already");
		if (outcome === "not_yours") throw new HttpError(404, "No such message of yours is queued");
		if (outcome === "empty") throw new HttpError(400, "A message needs text or an image");
	}

	/**
	 * Brings an agent into a chat, which becomes a room if it wasn't one. It
	 * gets a seat: a conversation of its own, as a chat with it is, which
	 * starts with nothing of what was said before (it reads that with
	 * `chat_history`); everyone else hears it joined. The message that
	 * brought it in is the first thing it hears.
	 */
	join(room: string, agent: Agent): Promise<Seat> {
		const seated = this.host.rooms.at(room, agent.id);
		if (seated) return Promise.resolve(seated);
		const key = `${room}:${agent.id}`;
		let joining = this.host.joining.get(key);
		if (!joining) {
			joining = this.#seat(room, agent).finally(() => this.host.joining.delete(key));
			this.host.joining.set(key, joining);
		}
		return joining;
	}

	async #seat(room: string, agent: Agent): Promise<Seat> {
		const host = this.host.agents.ofSession(room);
		const { id } = await this.host.harness.sessions.create();
		await this.host.harness.session(id).setModel(this.host.sessionModel(id, agent));
		this.host.agents.setSession(id, agent.id);
		this.host.rooms.open(room, host.id);
		const others = this.host.rooms.seats(room);
		const seat = this.host.rooms.seat(room, agent.id, id);
		const names = this.seated(others).map((other) => other.name);
		await this.#write(id, `${ROOM_NOTICE} You joined this chat, with the person and ${names.join(", ")}.`, `join:${id}`);
		for (const other of others) await this.#write(other.conversation, `${ROOM_NOTICE} ${agent.name} joined the chat.`, `joined:${id}:${other.agent}`);
		this.host.broadcastMessage({ type: "sessions" });
		return seat;
	}

	/**
	 * Takes an agent out of a room, as its host or the person asks. Its
	 * conversation is put away as a deleted chat's is: it stops, the tasks it
	 * handed out are canceled and its approval requests denied. Everyone left
	 * hears it left. Brought in again, it gets a seat afresh.
	 */
	async leave(seat: Seat): Promise<void> {
		if (seat.conversation === seat.room || !this.host.rooms.of(seat.conversation)) return;
		this.host.rooms.unseat(seat);
		this.host.store.deleteSession(seat.conversation);
		const reason = "It was taken out of the chat.";
		this.denyPending(seat.conversation, reason);
		await this.abort(seat.conversation);
		for (const task of this.host.tasks.byRequester(seat.conversation)) await this.cancelTask(task, reason);
		const name = this.host.agents.get(seat.agent)?.name ?? "An agent";
		for (const other of this.host.rooms.seats(seat.room)) await this.#write(other.conversation, `${ROOM_NOTICE} ${name} left the chat.`, `left:${seat.conversation}:${other.agent}`);
		this.host.broadcastMessage({ type: "sessions" });
	}

	/** A room as the chat list shows it, read now. */
	async roomOf(session: string) {
		const held = await this.host.heldSessions();
		const busy = new Set((await this.host.harness.sessions.list()).flatMap((info) => (info.busy && !held.has(info.id) ? [info.id] : [])));
		return this.roomInfo(session, busy, await this.heldErrors(held));
	}

	/**
	 * What failed for each conversation whose run is held: its last error, which the chat classifies. An agent in a room has no
	 * chat of its own to show it in, and a chat opened after Pim restarted has lost the live error, so the list carries it.
	 */
	async heldErrors(held: ReadonlySet<string>): Promise<Map<string, string>> {
		const errors = new Map<string, string>();
		for (const conversation of held) {
			const failed = projectEntries(await this.host.harness.session(conversation).messages()).findLast((message) => message.role === "assistant" && message.error !== undefined);
			errors.set(conversation, failed && "error" in failed && failed.error ? failed.error : "");
		}
		return errors;
	}

	/** What the chat list says of a room: how agents take turns, and who is in it besides the host, each with whether it is at work. Every chat of the person's with their own agents is a room, with no one but its host at first. */
	roomInfo(session: string, busy: ReadonlySet<string>, held: ReadonlyMap<string, string>): { mode: RoomMode; members: { id: string; name: string; busy: boolean; held: boolean; error: string | null; model: { model: ReturnType<typeof describeModel>; override: boolean } }[] } | null {
		const [host, ...members] = this.host.rooms.seats(session);
		if (!host && !this.roomable(session)) return null;
		return {
			mode: this.host.rooms.mode(session),
			members: members.flatMap((seat) => {
				const agent = this.host.agents.get(seat.agent);
				return agent ? [{ id: agent.id, name: agent.name, busy: busy.has(seat.conversation), held: held.has(seat.conversation), error: held.get(seat.conversation) ?? null, model: this.host.sessionModelInfo(seat.conversation) }] : [];
			}),
		};
	}

	/** A task's agent waits for the person's decision on an approval: it is `auth-required` until the decision. */
	async taskWaits(session: string): Promise<void> {
		const task = this.host.tasks.of(session);
		if (!task || task.kind === "review" || !this.host.tasks.setState(task.id, "auth-required")) return;
		this.tasksChanged(task.root);
		await this.#deliver(task.batch);
	}

	/**
	 * Cancels a task not yet done, and the tasks it handed out: their agents
	 * stop, and their approval requests are denied. Its requester hears it
	 * was canceled, as it would hear its answer.
	 */
	async cancelTask(task: Task, reason: string): Promise<void> {
		if (!this.host.tasks.finish(task.id, "canceled", reason)) return;
		for (const handed of this.host.tasks.byRequester(task.conversation)) await this.cancelTask(handed, "The task it was part of was canceled.");
		this.denyPending(task.conversation, reason);
		await this.abort(task.conversation);
		this.tasksChanged(task.root);
		await this.#deliver(task.batch);
	}

	/** Denies the requests a conversation's agent is waiting on, as its chat is put away. */
	denyPending(conversation: string, reason: string): void {
		for (const approval of this.host.store.approvals("pending")) {
			if (approval.session !== conversation || !this.host.store.decideApproval(approval.id, "denied", reason, "user")) continue;
			this.host.broadcastMessage({ type: "approval", approval: this.host.publicApproval(this.host.store.approval(approval.id)!) });
		}
	}

	/**
	 * Tells a conversation's work to stop, and waits for it to end, but not
	 * for long: work that is slow to stop ends when it can, and the person,
	 * the deletion or the cancellation asking is not held up by it.
	 */
	async abort(conversation: string): Promise<void> {
		await within(this.host.harness.session(conversation).abort(), STOP_WAIT_MS);
	}

	/**
	 * Stops what an agent is doing in a conversation, as Stop does: its calls
	 * and the waits of its calls for the person end, and its run with them.
	 * Pi withdraws what was queued behind the run, which is how the person
	 * takes back their own messages, but the events queued for the agent
	 * (a coding thread's turn ended, a task answered) are no one's to take
	 * back: they are given again, to the agent's next run. `note` says why the
	 * agent was stopped, when it was not the person.
	 */
	async stop(session: string, note?: string): Promise<void> {
		const conversation = await this.host.harness.conversation(session);
		const queued = (await (await this.host.harness.pi()).snapshot(InboxDoc, conversation.id, BACKGROUND_CONTEXT))?.items ?? [];
		const events = queued.flatMap((item) => {
			if (item.mode === "write") return [];
			const text = textOf(item.content as UserInput);
			return fromPerson(text) && !CODING_EVENT.test(text) ? [] : [{ id: item.id, content: item.content as UserInput }];
		});
		await this.abort(session);
		const again: [UserInput, string][] = events.map((event) => [event.content, `requeued:${session}:${event.id}`]);
		if (note !== undefined) again.unshift([note, `stopped:${session}:${Date.now()}`]);
		for (const [content, operationId] of again) {
			await this.host.submitTo(session, content, { operationId, whenBusy: "followUp" }, "pim").catch((error) => {
				if (!(error instanceof HttpError)) throw error;
				console.warn(JSON.stringify({ event: "pim.stop.requeue_skipped", owner: this.host.name, status: error.status }));
			});
		}
	}

	/** Wakes a suspended task of `session`, and the watchdog with it: nothing watched its run while it waited. */
	async resumeTask(session: string, task: TaskId): ReturnType<PiHarness["resumeTask"]> {
		const result = await this.host.harness.resumeTask(session, task);
		void this.armWatchdog().catch((error) => console.warn("arming the run watchdog failed", error));
		return result;
	}

	/**
	 * Looks at the runs again in a while, once, whoever asks: a space with no
	 * run at work has nothing to watch, and sleeps. A look arms the next with
	 * the other kind of timing than its own: the schedule running is still
	 * there, and arming the same kind would only find it.
	 */
	async armWatchdog(via: "delayed" | "scheduled" = "scheduled"): Promise<void> {
		const ms = Math.max(1_000, Math.min(60_000, this.host.stallMs() / 2));
		await this.host.schedule(via === "scheduled" ? new Date(Date.now() + ms) : Math.ceil(ms / 1000), WATCHDOG_CALLBACK, { via }, { idempotent: true });
	}

	/**
	 * Stops the run of an agent that has made no progress for a long while,
	 * with a note to the agent, so that one call that never returns can't hold
	 * a chat and what is queued behind it for good. A run waiting for the
	 * person's decision, for tasks it handed out, or for a retry, makes none by
	 * design, and is left be: Stop ends those. Every run is noted, with when it
	 * was first seen at work, for the diagnostics to tell.
	 */
	async watchRuns(look?: { via: "delayed" | "scheduled" }): Promise<void> {
		if (this.host.closed()) return;
		const pi = await this.host.harness.pi();
		const { tasks } = await pi.inspect(BACKGROUND_CONTEXT);
		const byConversation = new Map<string, typeof tasks[number][]>();
		for (const task of tasks) if (!task.record.background) byConversation.set(String(task.record.conversationId), [...(byConversation.get(String(task.record.conversationId)) ?? []), task]);
		const now = Date.now();
		const seen = new Set<string>();
		const watched = new Set<string>();
		const stalled: string[] = [];
		for (const [session, group] of byConversation) {
			const live = await pi.snapshot(LiveDoc, Number(session) as ConversationId, BACKGROUND_CONTEXT);
			if (live?.run === undefined) continue;
			seen.add(session);
			// In task order: a restart lists them in another.
			const unchanged = await this.host.runWatch.observe(session, runKey(live.run), JSON.stringify([[...group].sort((a, b) => a.record.id - b.record.id).map((task) => [task.record.id, task.state.kind]), live]), now);
			if (group.some((task) => task.state.kind === "suspended") || live.generation?.retry !== undefined || live.generation?.deferred !== undefined || live.compactions?.some((compaction) => compaction.retry !== undefined)) continue;
			watched.add(session);
			if (unchanged >= this.host.stallMs()) stalled.push(session);
		}
		this.host.runWatch.keepOnly(new Set([...seen].filter((session) => !stalled.includes(session))));
		for (const session of stalled) {
			this.host.note("run_stalled", { session, ms: this.host.stallMs() });
			await this.stop(session, `[Pim] Your last turn was stopped: it made no progress for ${describeWait(this.host.stallMs())}, so a call of yours may be stuck. Look at what you were doing, and carry on or tell the person.`).catch((error) => console.warn("stopping a stalled run failed", error));
		}
		// Watching goes on while anything is at work.
		if (watched.size > 0) await this.armWatchdog(look?.via === "scheduled" ? "delayed" : "scheduled");
	}

	/**
	 * After a restart: wakes the tool calls whose approval was decided but
	 * never woke them, because the space restarted in between. Such a call
	 * waits suspended for a wake that won't come, holding its chat's run, and
	 * everything queued behind it, for good. An approved action that was
	 * running when the space restarted may have partly run: its result says
	 * so, and it isn't run again.
	 */
	async resumeDecided(): Promise<void> {
		const pi = await this.host.harness.pi();
		const { tasks } = await pi.inspect(BACKGROUND_CONTEXT);
		for (const { record, state } of tasks) {
			if (record.kind !== "pi.tool" || state.kind !== "suspended") continue;
			const session = String(record.conversationId);
			const callId = (record.input as { callId?: unknown }).callId;
			const approval = this.host.store.approvals().find((candidate) => candidate.session === session && candidate.callId === callId && !candidate.requestedBy);
			if (!approval || approval.status === "pending" || this.host.running.has(approval.id)) continue;
			if (approval.status === "approved" && approval.result === null) {
				this.host.store.recordApprovalResult(approval.id, "The space restarted while this was running, so it may have partly run, and it was not run again. Check before asking again.");
			}
			console.warn(JSON.stringify({ event: "pim.approval_resumed", owner: this.host.name, session, approval: approval.id, status: approval.status }));
			await this.resumeTask(session, record.id);
		}
	}

	/** Open apps show a chat's tasks anew. */
	tasksChanged(root: string): void {
		this.host.broadcastMessage({ type: "tasks", session: this.host.store.publicId(root) });
		// The chat list shows how the chats tasks started are doing.
		this.host.broadcastMessage({ type: "sessions" });
	}

	/** Who waits for updates to a conversation, as the MCP server does for its client. */
	readonly #updateListeners = new Map<string, Set<(operation: string) => void>>();

	/** Collects the updates given to `session` from now on, in order, until closed. */
	listenForUpdates(session: string): { pending(): boolean; next(signal: AbortSignal): Promise<string>; close(): void } {
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
}
