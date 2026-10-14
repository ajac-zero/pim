import { Type } from "@earendil-works/pi-ai";
import { type AgentChange, configure, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { text } from "./extensions/services";
import { MAX_TEAM, type Agent, type TeamMember } from "./agents";

/**
 * An agent's team at work. An agent with a team hands tasks to its members with
 * `delegate`; each task runs in a conversation of its own, owned by the call,
 * and all of them at once. The call returns every member's answer, and the
 * agent tells the person what came of it: members never talk to the person.
 *
 * A member asking for the person's approval files it as an agent does, shown in
 * the chat it works for (see `ApprovalMember`). The decision goes to the
 * member's own conversation, and what the member answers then comes back to
 * that chat as a message starting with "[Team".
 */

/** How a member's task went: running, answered, or not (failed, aborted). */
export type TeamRunStatus = "running" | "done" | "failed";

/** One task a member was given, in its own conversation. */
export type TeamRun = {
	/** The member's conversation. */
	readonly conversation: string;
	/** The `delegate` call that gave it: tasks handed out together share it. */
	readonly call: string;
	/** The chat whose agent handed it the task. */
	readonly session: string;
	readonly agent: string;
	readonly member: string;
	readonly task: string;
	readonly status: TeamRunStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_team_runs (
	conversation TEXT PRIMARY KEY,
	call TEXT NOT NULL,
	position INTEGER NOT NULL,
	session TEXT NOT NULL,
	agent TEXT NOT NULL,
	member TEXT NOT NULL,
	task TEXT NOT NULL,
	status TEXT NOT NULL,
	report TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pim_team_runs_by_session ON pim_team_runs (session, created_at);
`;

type Row = Record<string, SqlStorageValue>;

const runOf = (row: Row): TeamRun => ({
	conversation: String(row.conversation),
	call: String(row.call),
	session: String(row.session),
	agent: String(row.agent),
	member: String(row.member),
	task: String(row.task),
	status: String(row.status) as TeamRunStatus,
	createdAt: Number(row.created_at),
	updatedAt: Number(row.updated_at),
});

export class TeamStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
		// Agents were once called personas: renamed in place, keeping the rows.
		const columns = this.#sql.exec("PRAGMA table_info(pim_team_runs)").toArray().map((row) => String(row.name));
		if (columns.includes("persona")) this.#sql.exec("ALTER TABLE pim_team_runs RENAME COLUMN persona TO agent");
	}

	/** Idempotent on the conversation: a replayed call finds the runs it started. */
	start(run: { conversation: string; call: string; position: number; session: string; agent: string; member: string; task: string }): void {
		const now = Date.now();
		this.#sql.exec(
			"INSERT OR IGNORE INTO pim_team_runs (conversation, call, position, session, agent, member, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)",
			run.conversation,
			run.call,
			run.position,
			run.session,
			run.agent,
			run.member,
			run.task,
			now,
			now,
		);
	}

	setStatus(conversation: string, status: TeamRunStatus): void {
		this.#sql.exec("UPDATE pim_team_runs SET status = ?, updated_at = ? WHERE conversation = ?", status, Date.now(), conversation);
	}

	/** A member's answer after the person decided an approval, still to be passed on to its chat; null once it is. */
	setReport(conversation: string, operation: string | null): void {
		this.#sql.exec("UPDATE pim_team_runs SET report = ? WHERE conversation = ?", operation, conversation);
	}

	reports(): { run: TeamRun; operation: string }[] {
		return this.#sql
			.exec("SELECT * FROM pim_team_runs WHERE report IS NOT NULL")
			.toArray()
			.map((row) => ({ run: runOf(row), operation: String(row.report) }));
	}

	run(conversation: string): TeamRun | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_team_runs WHERE conversation = ?", conversation).toArray();
		return row ? runOf(row) : undefined;
	}

	/** What a chat's team was given, newest first. */
	ofSession(session: string, limit = 50): TeamRun[] {
		return this.#sql
			.exec("SELECT * FROM pim_team_runs WHERE session = ? ORDER BY created_at DESC, position DESC LIMIT ?", session, limit)
			.toArray()
			.map(runOf);
	}

	/** Every member conversation: they are not chats of the person's. */
	conversations(): Set<string> {
		return new Set(this.#sql.exec("SELECT conversation FROM pim_team_runs").toArray().map((row) => String(row.conversation)));
	}
}

/** What a conversation is: a chat with one of the person's agents, or a member of its team at work. */
export type Role = { readonly agent: Agent; readonly member: TeamMember | null };

/** What the team's tool needs from the agent. */
export type TeamHost = {
	roleOf(session: string): Role;
	readonly runs: TeamStore;
	/** How a member's conversation differs from its agent's: its tools. */
	memberAgent(member: TeamMember, agent: Agent): AgentChange;
	/** Gives a member's conversation its task and waits for the answer. */
	ask(conversation: string, task: string, operation: string): Promise<{ ok: boolean; text: string }>;
};

export const TEAM_EXTENSION = "pim.team";
export const DELEGATE = "delegate";

/** The first line of a member's instructions, as the agent's roster shows it. */
function gist(instructions: string): string {
	const line = instructions.trim().split(/\r?\n/)[0] ?? "";
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** What a member reads before its own instructions, in place of an agent's habits of talking to the person. */
export function memberPreamble(agent: Agent, member: TeamMember): string {
	return `You are "${member.name}", a member of the team of "${agent.name}", a personal AI agent working for a person. ${agent.name} hands you a task; do it with your tools, then answer with your result.

- Your final answer, as plain text, is all ${agent.name} sees of your work: make it complete and self-contained, with what you found or did and anything left open.
- You never talk to the person. ${agent.name} does, with what you report.
- Tools that change things outside this conversation need the person's approval: calling one asks them and returns at once. Don't call it again. If the rest of the task depends on the decision, say in your answer what you are waiting for: the decision arrives later in this conversation as a message starting with "[Approval", and what you answer after it goes to ${agent.name}.
- Be honest about what you did. Never claim an action happened unless a tool result says so.`;
}

/** A member's own instructions, which come before its general habits. */
export function memberInstructions(member: TeamMember): string {
	return `Your instructions, which come before your general habits wherever the two differ:\n${member.instructions}`;
}

/** The roster an agent with a team reads, and how to work with it. */
function roster(agent: Agent): string {
	return [
		`You lead a team. Hand its members tasks with \`${DELEGATE}\`: they work at the same time, each in a conversation of its own, and the call returns all their answers.`,
		...agent.team.map((member) => `- ${member.name}: ${gist(member.instructions)}`),
		"Give them the parts of the work that can go on at once, each with everything it needs: a member knows only its task. Then combine what they bring back. They never talk to the person; you do.",
		'A member that asks for the person\'s approval answers once it is decided, in a message starting with "[Team".',
	].join("\n");
}

export function teamExtension(host: TeamHost) {
	const delegate = defineTool({
		name: DELEGATE,
		description:
			"Hand tasks to members of your team, if your prompt lists one. Each task goes to one member, all of them work at the same time, and you get every answer back together. A member starts with nothing but its task: say what to do, what you already know, and what to answer with.",
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					member: Type.String({ description: "The member's name, as your team lists it." }),
					task: Type.String({ minLength: 1, maxLength: 20_000 }),
				}),
				{ minItems: 1, maxItems: MAX_TEAM },
			),
		}),
		// A rerun after an eviction finds the members' conversations and their tasks, and waits again.
		replay: "safe",
		async execute(args, api, context) {
			const session = String(api.conversationId);
			const { agent, member: self } = host.roleOf(session);
			if (self) return text("Team members can't hand out tasks.", true);
			if (agent.team.length === 0) return text(`${agent.name} has no team: do the work yourself.`, true);
			const members = args.tasks.map(({ member }) =>
				agent.team.find((candidate) => candidate.name.toLowerCase() === member.trim().toLowerCase()),
			);
			const unknown = args.tasks.filter((_, index) => !members[index]).map(({ member }) => member);
			if (unknown.length > 0) {
				return text(`No team member called ${unknown.join(", ")}. The team: ${agent.team.map((member) => member.name).join(", ")}.`, true);
			}
			const call = String(api.taskId);
			const conversations = await api.commit(async (tx) => {
				// The ownership index remembers them: a rerun reuses them, in the order they were made.
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, MAX_TEAM)).items;
				if (existing.length > 0) return existing.map((conversation) => conversation.id);
				const created = [];
				for (const member of members) {
					const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, conversation.id, host.memberAgent(member!, agent));
					created.push(conversation.id);
				}
				return created;
			}, context);
			conversations.forEach((conversation, position) =>
				host.runs.start({
					conversation: String(conversation),
					call,
					position,
					session,
					agent: agent.id,
					member: members[position]!.name,
					task: args.tasks[position]!.task,
				}),
			);
			const answers = await Promise.all(
				conversations.map(async (conversation, position) => {
					const result = await host.ask(String(conversation), args.tasks[position]!.task, `team:${call}:${position}`);
					host.runs.setStatus(String(conversation), result.ok ? "done" : "failed");
					return `## ${members[position]!.name}\n${result.text}`;
				}),
			);
			return text(answers.join("\n\n"));
		},
	});

	return defineExtension({
		name: TEAM_EXTENSION,
		sections: [
			section("team", ({ conversationId }) => {
				const { agent, member } = host.roleOf(String(conversationId));
				return member || agent.team.length === 0 ? undefined : roster(agent);
			}),
		],
		tools: [delegate],
	});
}
