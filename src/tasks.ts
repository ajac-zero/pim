import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { text } from "./extensions/services";
import type { Agent } from "./agents";

/**
 * Agents handing work to each other. An agent hands a task to another with
 * `delegate`: the majordomo to any of the person's other agents, and any
 * agent to its contacts. Each task runs in a conversation of its own, not
 * a chat: the person reads it, read-only, from the chat the work began in,
 * where the tasks show as a tree. In a chat the person talks with an agent;
 * in a task an agent talks with the one that handed it the task, and nothing
 * there is the person's.
 *
 * Handing out tasks doesn't wait for them, as in A2A's task model: the call
 * returns their ids at once, and the agent goes on, or ends its turn. Each
 * task is `working` until its agent answers (`completed`), gives up
 * (`failed`) or the person cancels it (`canceled`); while its agent waits
 * for the person's approval it is `auth-required`. The answers come back to
 * the conversation that asked, as one message starting with "[Task update]"
 * for the tasks handed out together, once none of them is still working: a
 * task waiting for the person doesn't hold up the others' answers, and comes
 * in an update of its own when it is done. Each task is told once.
 *
 * An agent that hands out tasks of its own while working on one answers its
 * task only once those come back: its task completes with its answer after
 * the last of them. Work never goes round in a circle: no agent is handed a
 * task by one working, directly or not, on a task it handed out, and a chain
 * of tasks ends `MAX_TASK_DEPTH` deep.
 *
 * A review, the majordomo deciding another agent's approval request for the
 * person (see ./majordomo.ts), is a task too, which Pim gives and waits for
 * itself; no chat shows it.
 */

/** Who does a task: another of the person's agents, or the majordomo reviewing an approval. */
export type TaskKind = "agent" | "review";

/** A2A's task states, those Pim's tasks go through. */
export type TaskState = "working" | "auth-required" | "completed" | "failed" | "canceled";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "canceled"]);

/** One task an agent handed another, in the other's own conversation. */
export type Task = {
	/** Its public id, which agents and the API use. */
	readonly id: string;
	readonly kind: TaskKind;
	/** The conversation of the agent doing it. */
	readonly conversation: string;
	/** The conversation that asked, which hears the answer; null for a review, which Pim asked for. */
	readonly requester: string | null;
	/** The task its requester was doing when it asked, if it was doing one; null when a chat asked. */
	readonly parent: string | null;
	/** The chat the work began in, which shows it. */
	readonly root: string;
	/** The `delegate` call that gave it: tasks handed out together share it, and are answered together. */
	readonly batch: string;
	/** The agent doing it. */
	readonly agent: string;
	readonly task: string;
	readonly state: TaskState;
	/** Its answer, or why it didn't finish, once it is done. */
	readonly result: string | null;
	/** The latest input given to its conversation, whose settling may finish it. */
	readonly operation: string;
	/** The update that gives its answer to its requester, once there is one. */
	readonly update: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_tasks (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	conversation TEXT NOT NULL,
	requester TEXT,
	parent TEXT,
	root TEXT NOT NULL,
	batch TEXT NOT NULL,
	position INTEGER NOT NULL,
	agent TEXT NOT NULL,
	member TEXT,
	task TEXT NOT NULL,
	state TEXT NOT NULL,
	result TEXT,
	operation TEXT NOT NULL,
	update_op TEXT,
	delivered INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (batch, position)
);
CREATE INDEX IF NOT EXISTS pim_tasks_by_conversation ON pim_tasks (conversation, created_at);
CREATE INDEX IF NOT EXISTS pim_tasks_by_requester ON pim_tasks (requester, created_at);
CREATE INDEX IF NOT EXISTS pim_tasks_by_root ON pim_tasks (root, created_at);
`;

/** Whether a task's answer has gone to its requester: not yet, being given, or given. */
const DELIVERY = { none: 0, giving: 1, given: 2 } as const;

type Row = Record<string, SqlStorageValue>;

const nullable = (value: SqlStorageValue | undefined) => (value == null ? null : String(value));

const taskOf = (row: Row): Task => ({
	id: String(row.id),
	kind: String(row.kind) as TaskKind,
	conversation: String(row.conversation),
	requester: nullable(row.requester),
	parent: nullable(row.parent),
	root: String(row.root),
	batch: String(row.batch),
	agent: String(row.agent),
	task: String(row.task),
	state: String(row.state) as TaskState,
	result: nullable(row.result),
	operation: String(row.operation),
	update: nullable(row.update_op),
	createdAt: Number(row.created_at),
	updatedAt: Number(row.updated_at),
});

/** A short public id: unique in the space, and easy for an agent to repeat. */
const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);

export class TaskStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
		// Team members' tasks were once kept apart, and waited for: those still running when that changed are over. Older ones named the agent `persona`. Each keeps its member's name, so that it becomes the task of the agent the member becomes (see ./agents.ts).
		const old = this.#sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pim_team_runs'").toArray();
		if (old.length > 0) {
			for (const row of this.#sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM pim_team_runs").toArray()) {
				const review = String(row.kind) === "review";
				this.#sql.exec(
					"INSERT OR IGNORE INTO pim_tasks (id, kind, conversation, requester, parent, root, batch, position, agent, member, task, state, result, operation, delivered, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, '', ?, ?, ?)",
					newId(),
					review ? "review" : "agent",
					row.conversation ?? null,
					review ? null : row.session,
					row.session ?? null,
					row.call ?? null,
					row.position ?? null,
					row.agent ?? row.persona ?? null,
					row.member ?? null,
					row.task ?? null,
					String(row.status) === "done" ? "completed" : "failed",
					DELIVERY.given,
					row.created_at ?? null,
					row.updated_at ?? null,
				);
			}
			this.#sql.exec("DROP TABLE pim_team_runs");
		}
	}

	/** Records a task given; idempotent on its call and position, so a replayed call finds the task it gave. */
	start(task: {
		kind: TaskKind;
		conversation: string;
		requester: string | null;
		parent: string | null;
		root: string;
		batch: string;
		position: number;
		agent: string;
		task: string;
	}): Task {
		const existing = this.at(task.batch, task.position);
		if (existing) return existing;
		const id = newId();
		const now = Date.now();
		this.#sql.exec(
			"INSERT INTO pim_tasks (id, kind, conversation, requester, parent, root, batch, position, agent, task, state, operation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?, ?)",
			id,
			task.kind,
			task.conversation,
			task.requester,
			task.parent,
			task.root,
			task.batch,
			task.position,
			task.agent,
			task.task,
			`task:${id}`,
			now,
			now,
		);
		return this.get(id)!;
	}

	get(id: string): Task | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_tasks WHERE id = ?", id).toArray();
		return row ? taskOf(row) : undefined;
	}

	at(batch: string, position: number): Task | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_tasks WHERE batch = ? AND position = ?", batch, position).toArray();
		return row ? taskOf(row) : undefined;
	}

	/** The task a conversation works on: its latest, as a follow-up task continues the conversation of an earlier one. */
	of(conversation: string): Task | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_tasks WHERE conversation = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", conversation).toArray();
		return row ? taskOf(row) : undefined;
	}

	/** Tasks handed out together, in the order given. */
	inBatch(batch: string): Task[] {
		return this.#sql.exec("SELECT * FROM pim_tasks WHERE batch = ? ORDER BY position", batch).toArray().map(taskOf);
	}

	/** The tasks a conversation handed out, oldest first. */
	byRequester(requester: string): Task[] {
		return this.#sql.exec("SELECT * FROM pim_tasks WHERE requester = ? ORDER BY created_at, position", requester).toArray().map(taskOf);
	}

	/** The tasks the work begun in a chat led to, oldest first; reviews aren't among them. */
	ofRoot(root: string): Task[] {
		return this.#sql.exec("SELECT * FROM pim_tasks WHERE root = ? AND kind != 'review' ORDER BY created_at, position", root).toArray().map(taskOf);
	}

	/** Tasks agents handed out not yet done, for picking up again after a restart; reviews, which Pim waits for itself, aren't among them. */
	open(): Task[] {
		return this.#sql.exec("SELECT * FROM pim_tasks WHERE state IN ('working', 'auth-required') AND kind != 'review' ORDER BY created_at").toArray().map(taskOf);
	}

	/**
	 * Whether a conversation still waits for tasks it handed out: one not yet
	 * done, or done with its answer not yet given to it.
	 */
	waitsOnTasks(conversation: string): boolean {
		const [row] = this.#sql
			.exec(`SELECT 1 FROM pim_tasks WHERE requester = ? AND (state IN ('working', 'auth-required') OR delivered != ${DELIVERY.given}) LIMIT 1`, conversation)
			.toArray();
		return row !== undefined;
	}

	/**
	 * Whether a conversation will hear more from tasks it handed out: one is
	 * working, or done with its answer not yet given. Tasks waiting for the
	 * person may take a while: they don't count.
	 */
	awaitsAnswers(conversation: string): boolean {
		const [row] = this.#sql
			.exec(`SELECT 1 FROM pim_tasks WHERE requester = ? AND (state = 'working' OR (state IN ('completed', 'failed', 'canceled') AND delivered != ${DELIVERY.given})) LIMIT 1`, conversation)
			.toArray();
		return row !== undefined;
	}

	setState(id: string, state: "working" | "auth-required"): boolean {
		return this.#sql.exec("UPDATE pim_tasks SET state = ?, updated_at = ? WHERE id = ? AND state IN ('working', 'auth-required') AND state != ?", state, Date.now(), id, state).rowsWritten > 0;
	}

	/** Ends a task with its answer, once: false when it had already ended. */
	finish(id: string, state: "completed" | "failed" | "canceled", result: string): boolean {
		return (
			this.#sql.exec("UPDATE pim_tasks SET state = ?, result = ?, updated_at = ? WHERE id = ? AND state IN ('working', 'auth-required')", state, result, Date.now(), id)
				.rowsWritten > 0
		);
	}

	/** The latest input given to a task's conversation. */
	setOperation(id: string, operation: string): void {
		this.#sql.exec("UPDATE pim_tasks SET operation = ? WHERE id = ?", operation, id);
	}

	/** Done tasks whose answers no update has given yet. */
	unanswered(batch: string): Task[] {
		return this.#sql
			.exec(`SELECT * FROM pim_tasks WHERE batch = ? AND state IN ('completed', 'failed', 'canceled') AND delivered = ${DELIVERY.none} ORDER BY position`, batch)
			.toArray()
			.map(taskOf);
	}

	/** Marks answers as being given by the update `operation`, before it is submitted. */
	giving(ids: readonly string[], operation: string): void {
		for (const id of ids) this.#sql.exec(`UPDATE pim_tasks SET delivered = ${DELIVERY.giving}, update_op = ? WHERE id = ?`, operation, id);
	}

	given(operation: string): void {
		this.#sql.exec(`UPDATE pim_tasks SET delivered = ${DELIVERY.given} WHERE update_op = ?`, operation);
	}

	/** Updates marked as being given whose submission may not have happened, by their operation. */
	beingGiven(): { operation: string; batch: string }[] {
		return this.#sql
			.exec(`SELECT DISTINCT update_op, batch FROM pim_tasks WHERE delivered = ${DELIVERY.giving}`)
			.toArray()
			.map((row) => ({ operation: String(row.update_op), batch: String(row.batch) }));
	}

	/** Gives up on telling a requester that is gone. */
	drop(batch: string): void {
		this.#sql.exec(`UPDATE pim_tasks SET delivered = ${DELIVERY.given} WHERE batch = ? AND state IN ('completed', 'failed', 'canceled')`, batch);
	}

	/** Every task's conversation: none of them is a chat of the person's. */
	conversations(): Set<string> {
		return new Set(this.#sql.exec("SELECT conversation FROM pim_tasks").toArray().map((row) => String(row.conversation)));
	}
}

/**
 * What a conversation is: a chat with one of the person's agents, or a task
 * one agent handed another. `from` names who handed it the task.
 */
export type Role = { readonly agent: Agent; readonly from: string | null };

/** What `delegate` needs from the space. */
export type TasksHost = {
	roleOf(session: string): Role;
	/** Whom a conversation can hand tasks to: the majordomo, the person's other agents; any other agent, its contacts. */
	delegates(session: string): Agent[];
	/**
	 * Gives the tasks, each to its agent, in a new conversation or the one of
	 * an earlier task it continues. Idempotent on `batch`: a replayed call
	 * gives none twice.
	 */
	start(requester: string, batch: string, tasks: { to: Agent; task: string; continues: Task | null }[]): Promise<Task[]>;
	readonly tasks: TaskStore;
};

export const TASKS_EXTENSION = "pim.tasks";
export const DELEGATE = "delegate";
/** How a message giving tasks' answers starts. */
export const TASK_UPDATE = "[Task update]";
/** The most tasks one `delegate` call hands out. */
export const MAX_TASKS = 8;
/** How deep a chain of tasks goes: an agent this many tasks away from the chat the work began in hands out none. */
export const MAX_TASK_DEPTH = 3;

/** What an agent reads before its own instructions, in a task's conversation, in place of the habits of talking to the person. */
export function taskPreamble(self: string, from: string): string {
	return `You are "${self}", working on a task ${from} handed you, for the person they both work for. This conversation is with ${from}, not the person: every message in it is from ${from}.

- Do the task with your tools, then answer with your result. Your final answer, as plain text, is all ${from} sees of your work: make it complete and self-contained, with what you found or did and anything left open.
- You never talk to the person. ${from} does, with what you report.
- Tools that change things outside this conversation need the person's approval: calling one asks them and waits for their decision, which the call returns with the action's result. Don't call it again.
- Be honest about what you did. Never claim an action happened unless a tool result says so.`;
}

/** Whom an agent can hand tasks to, and how it hears back. */
function delegatesSection(self: Agent, delegates: Agent[]): string {
	return [
		`Hand tasks to others with \`${DELEGATE}\`: each works on its own, at the same time as the others, in a conversation of its own that the person can read. Hand one agent several tasks at once when the work splits into parts it can do side by side.`,
		self.majordomo ? "The person's other agents:" : "Your contacts, the person's agents you hand tasks to:",
		...delegates.map((agent) => `- ${agent.name}${agent.description ? `: ${agent.description}` : ""}`),
		`A task's agent knows only its own instructions and the task: give it everything it needs. \`${DELEGATE}\` returns at once with the tasks' ids. Don't wait for them, check on them or do their work yourself: say what you handed out if it helps, then end your turn. Their answers arrive later in this conversation, all those you handed out together in one message starting with "${TASK_UPDATE}"; then carry on with them. To follow up on a task, hand out another that \`continues\` it.`,
	].join("\n");
}

export function tasksExtension(host: TasksHost) {
	const delegate = defineTool({
		name: DELEGATE,
		description: `Hand tasks to others, as your prompt lists them: each task to one, all working at the same time, each in a conversation of its own. Returns at once with each task's id; the answers arrive later in this conversation, in a message starting with "${TASK_UPDATE}".`,
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					to: Type.String({ description: "Whom it is for: an agent's name, as your prompt lists them." }),
					task: Type.String({ minLength: 1, maxLength: 20_000, description: "What to do, what you already know, and what to answer with." }),
					continues: Type.Optional(
						Type.String({ description: "The id of a finished task you handed the same one before, to carry on in its conversation, where its earlier work is." }),
					),
				}),
				{ minItems: 1, maxItems: MAX_TASKS },
			),
		}),
		// A rerun after an eviction finds the tasks the call gave, and gives none twice.
		replay: "safe",
		async execute(args, api) {
			const session = String(api.conversationId);
			const delegates = host.delegates(session);
			if (delegates.length === 0) return text("You have no one to hand tasks to: do the work yourself.", true);
			const problems: string[] = [];
			const given = args.tasks.map(({ to, task, continues }) => {
				const agent = delegates.find((candidate) => candidate.name.toLowerCase() === to.trim().toLowerCase());
				if (!agent) {
					problems.push(`No one called ${to} to hand tasks to. You can hand them to: ${delegates.map((candidate) => candidate.name).join(", ")}.`);
					return null;
				}
				if (continues === undefined || continues.trim() === "") return { to: agent, task, continues: null };
				const earlier = host.tasks.get(continues.trim());
				if (!earlier || earlier.requester !== session || earlier.agent !== agent.id) {
					problems.push(`No task ${continues} you handed ${agent.name}: leave out continues to start afresh.`);
					return null;
				}
				if (!TERMINAL_STATES.has(host.tasks.of(earlier.conversation)!.state)) {
					problems.push(`${agent.name} is still working on task ${earlier.id}: its answer will arrive here; follow up once it has.`);
					return null;
				}
				return { to: agent, task, continues: earlier };
			});
			if (problems.length > 0) return text(problems.join("\n"), true);
			const started = await host.start(session, String(api.taskId), given.map((entry) => entry!));
			return text(
				[
					...started.map((task) => `Task ${task.id}: ${host.roleOf(task.conversation).agent.name} is on it.`),
					`Their answers will arrive in this conversation in a message starting with "${TASK_UPDATE}". End your turn now unless there is other work to do meanwhile.`,
				].join("\n"),
			);
		},
	});

	return defineExtension({
		name: TASKS_EXTENSION,
		sections: [
			section("delegates", ({ conversationId }) => {
				const delegates = host.delegates(String(conversationId));
				return delegates.length === 0 ? undefined : delegatesSection(host.roleOf(String(conversationId)).agent, delegates);
			}),
		],
		tools: [delegate],
	});
}

/** The message that gives a requester the answers of tasks it handed out together, and says which of them still wait for the person. */
export function taskUpdate(done: readonly { task: Task; by: string }[], waiting: readonly { task: Task; by: string }[]): string {
	const outcome = (task: Task, by: string) =>
		task.state === "completed"
			? `${by} finished task ${task.id}:\n${task.result}`
			: task.state === "canceled"
				? `Task ${task.id} for ${by} was canceled: ${task.result}`
				: `${by} didn't finish task ${task.id}: ${task.result}`;
	const headline = ({ task, by }: { task: Task; by: string }) =>
		`${by} ${task.state === "completed" ? "answered" : task.state === "canceled" ? "was canceled" : "didn't finish"}`;
	return [
		`${TASK_UPDATE} ${done.map(headline).join("; ")}`,
		...done.map(({ task, by }) => outcome(task, by)),
		...waiting.map(({ task, by }) => `${by} is waiting for the person's approval on task ${task.id}; its answer will come in a later update.`),
	].join("\n\n");
}
