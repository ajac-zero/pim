/**
 * The tools with which an agent works with the person's other agents, ported from v1 (`src/tasks.ts`, `src/extensions/agents.ts`): `delegate` hands tasks to others, `create_agent` makes
 * a new agent and `update_agent` changes one. Whom an agent may hand a task to, and who the person's agents are, is `pim_app.runner_agents` (migration 0690), which the prompt reads too.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import { MAX_TASKS, MAX_TASK_DEPTH, TASK_UPDATE, type Roster, type RosterAgent } from "./agent-prompts.ts";
import { filesPath } from "./computer-tools.ts";
import type { Principal } from "@pim/v2-contracts/identity";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
type Define = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => ToolRegistration;

export type TeamDeps = {
	ownerId: string;
	runtime: RuntimeDb;
	fetch: typeof fetch;
	/** Refuses an address that is not on the public internet. */
	publicUrl(raw: string): Promise<URL>;
	/** Tools whose rerun after an eviction is safe, and those whose is not. */
	read: Define;
	write: Define;
};

const text = (s: string, isError = false): Result => ({ content: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });
const json = (v: unknown): Result => text(JSON.stringify(v, null, 1));

const COLORS = ["gray", "red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink"];
const MAX_AGENTS = 50;
const MAX_ICON_BYTES = 256 * 1024;
const TERMINAL = new Set(["completed", "failed", "canceled"]);

export const agentLabel = (a: Pick<RosterAgent, "name" | "role">) => (a.role.toLowerCase() === a.name.toLowerCase() ? a.name : `${a.name} (${a.role})`);

/** The agent someone means by `wanted`: its id, the one with that role, or else the only one with that name. */
export function agentCalled<A extends Pick<RosterAgent, "id" | "name" | "role">>(wanted: string, agents: readonly A[]): A | undefined {
	const key = wanted.trim().toLowerCase();
	const named = agents.filter((a) => a.name.toLowerCase() === key);
	return agents.find((a) => a.id === wanted.trim()) ?? agents.find((a) => a.role.toLowerCase() === key) ?? (named.length === 1 ? named[0] : undefined);
}

/** What a `delegate` call that waited returns for one of its tasks, once it is done. */
function waitedAnswer(t: { id: string; status: string; result: string | null; by: string }): string {
	if (t.status === "completed") return `Task ${t.id}: ${t.by} answered:\n${t.result}`;
	if (t.status === "canceled") return `Task ${t.id}: ${t.by}'s task was canceled: ${t.result}`;
	return `Task ${t.id}: ${t.by} didn't finish: ${t.result}`;
}

/** The agents of the person, and whom the chat's agent may hand a task to (migration 0690). */
export const rosterOf = async (runtime: RuntimeDb, ownerId: string, chat: string | null): Promise<Roster> => (await runtime.read<{ r: Roster }>(ownerId, "SELECT pim_app.runner_agents($1, $2, $3) AS r", [ownerId, chat, MAX_TASK_DEPTH])).rows[0]!.r;

export function teamTools(deps: TeamDeps): ToolRegistration[] {
	const { ownerId, runtime } = deps;
	const S = Type.String;
	const O = Type.Optional;
	const strings = Type.Array(Type.String());

	const roster_ = (call: Call) => rosterOf(runtime, ownerId, call.chat);
	/** The ids of the person's agents that `names` mean (an id, a role or a name); throws for one none of them is. */
	const idsOf = (names: readonly string[], agents: readonly RosterAgent[]): string[] =>
		names.map((name) => {
			const agent = agentCalled(name, agents);
			if (!agent) throw new Error(`The person has no agent called ${name}. Their agents: ${agents.map(agentLabel).join(", ")}.`);
			return agent.id;
		});

	const delegate = deps.read(
		"delegate",
		`Hand tasks to others, as your prompt lists them: each task to one, all working at the same time, each in a chat of its own. Returns at once with each task's id; the answers arrive later in this conversation, in a message starting with "${TASK_UPDATE}". With wait, returns the answers instead, once the tasks are done.`,
		Type.Object({
			tasks: Type.Array(
				Type.Object({
					to: S({ description: "Whom it is for: an agent's name, as your prompt lists them." }),
					task: S({ minLength: 1, maxLength: 20_000, description: "What to do, what you already know that it needs, and what to answer with. It remembers only what its own memory holds: give it what the task needs about the person, and nothing more." }),
					continues: O(S({ description: "The id of a finished task you handed the same one before, to carry on in its chat, where its earlier work is." })),
				}),
				{ minItems: 1, maxItems: MAX_TASKS },
			),
			wait: O(Type.Boolean({ description: "Wait for the answers and return them, when you need them to go on. The call returns once every task is done, including any waiting for the person's approval." })),
		}),
		async (app, call, a) => {
			if (!call.chat) return text("There is no chat to delegate from.", true);
			const roster = await roster_(call);
			if (roster.delegates.length === 0) return text("You have no one to hand tasks to: do the work yourself.", true);
			const problems: string[] = [];
			const given: { agent: RosterAgent; task: string; continues: string | undefined }[] = [];
			for (const { to, task, continues } of a.tasks as { to: string; task: string; continues?: string }[]) {
				const agent = agentCalled(to, roster.delegates);
				if (!agent) {
					problems.push(`No one called ${to} to hand tasks to. You can hand them to: ${roster.delegates.map(agentLabel).join(", ")}.`);
					continue;
				}
				const earlier = continues?.trim();
				if (earlier) {
					const found = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT agent_id, status FROM pim_app.tasks WHERE task_id = $1 AND started_by = $2", [earlier, call.chat])).rows[0])) as { agent_id: string | null; status: string } | undefined;
					if (!found || found.agent_id !== agent.id) {
						problems.push(`No task ${earlier} you handed ${agent.name}: leave out continues to start afresh.`);
						continue;
					}
					if (!TERMINAL.has(found.status)) {
						problems.push(`${agent.name} is still working on task ${earlier}: its answer will arrive here; follow up once it has.`);
						continue;
					}
				}
				given.push({ agent, task, continues: earlier || undefined });
			}
			if (problems.length > 0) return text(problems.join("\n"), true);
			const batch = `delegate:${ownerId}:${call.api.taskId}:${call.api.callId}`;
			const from = roster.agents.find((x) => x.id === roster.self)?.name;
			// The command is the call's: a rerun after an eviction, or the wake of a call that waited, finds the tasks it gave and gives none twice.
			const admission = await app.conversations.admit(call.p, {
				commandId: batch,
				kind: "delegate",
				chatId: call.chat,
				payload: { tasks: given.map((g) => ({ agentId: g.agent.id, text: g.task, ...(g.continues ? { continues: g.continues } : {}) })), ...(a.wait ? { waits: true, waiterTask: call.api.taskId } : {}), ...(from ? { fromName: from } : {}) },
			});
			if (a.wait) {
				const tasks = await app.conversations.batch(ownerId, batch);
				// Suspended, the call holds nothing: the application wakes it once all its tasks are done, and it runs again to here.
				if (tasks.some((t) => !TERMINAL.has(t.status))) return { content: [{ type: "text", text: "Waiting for the tasks." }], control: { suspend: true } } as never;
				await app.conversations.answered(ownerId, batch);
				return text(tasks.map(waitedAnswer).join("\n\n"));
			}
			const made = (admission.result?.tasks ?? []) as { taskId: string; agentId: string | null }[];
			return text(
				[
					...made.map((t) => `Task ${t.taskId}: ${roster.delegates.find((d) => d.id === t.agentId)?.name ?? "An agent"} is on it.`),
					`Their answers will arrive in this conversation in a message starting with "${TASK_UPDATE}". End your turn now unless there is other work to do meanwhile.`,
				].join("\n"),
			);
		},
	);

	/** An image for an agent's icon, from the person's files or the web, checked as an uploaded icon is. */
	const iconKey = async (app: App, p: Principal, source: string): Promise<string> => {
		let bytes: Uint8Array;
		if (filesPath(source) !== null) bytes = (await app.objects.serve(p, `${ownerId}/files${filesPath(source)}`)).body;
		else if (/^https?:\/\//.test(source)) {
			const response = await deps.fetch(await deps.publicUrl(source), { headers: { "user-agent": "pim-agent/0.1" }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
			if (!response.ok) throw new Error(`${source} answered HTTP ${response.status}.`);
			bytes = new Uint8Array(await response.arrayBuffer());
		} else throw new Error("icon must be a path under /workspace, an http(s) URL, or null");
		if (bytes.byteLength === 0) throw new Error("The icon is empty.");
		if (bytes.byteLength > MAX_ICON_BYTES) throw new Error(`An icon must be at most ${MAX_ICON_BYTES / 1024} KB.`);
		return (await app.objects.put(p, { bytes, contentType: "", purpose: "image", acl: "public" })).key;
	};

	const color = Type.Union(COLORS.map((c) => Type.Literal(c)), { description: "The color behind its emoji." });
	const createAgent = deps.read(
		"create_agent",
		"Make a new agent for the person: a named agent with its own instructions and the connectors it works with, with its own chats in the sidebar. Only when none of their agents already does what they want. Write its instructions as the person would: what it's for, what to focus on, how to answer. Give it an emoji and a color that fit what it's for, so the person tells it apart in the sidebar. Connectors are ids of connectors the person has; the person connects each the first time they use it.",
		Type.Object({
			name: S({ minLength: 1, maxLength: 60, description: "What the person calls it: a given name, such as Ada, which the person may change. Each agent has a name of its own." }),
			role: O(S({ minLength: 1, maxLength: 60, description: "What it is for, such as Researcher. Each of the person's agents has a role of its own; left out, it is the name." })),
			description: S({ maxLength: 280, description: "One line, shown under its name." }),
			instructions: O(S({ maxLength: 20_000 })),
			connectors: O(Type.Array(S({ description: "A connector's id." }), { maxItems: 10 })),
			contacts: O(Type.Array(S(), { maxItems: MAX_AGENTS, description: "Names of the person's other agents it hands parts of its work to with `delegate`, such as a planner's researcher. Make those first." })),
			emoji: O(S({ description: "One emoji shown as its icon, such as 🏃 for a running coach." })),
			color: O(color),
			model: O(Type.Object({ provider: S(), id: S() })),
			skills: O(strings),
			delegates: O(strings),
		}),
		async (app, call, a) => {
			const all = (await roster_(call)).agents;
			// A rerun, or a second ask for the same thing, finds the agent that has this role and makes no other.
			const existing = all.find((x) => x.role.toLowerCase() === (a.role ?? a.name).trim().toLowerCase());
			if (existing) return json({ exists: true, agent: { id: existing.id, name: existing.name, description: existing.description } });
			if (all.length >= MAX_AGENTS) return text(`The person already has ${MAX_AGENTS} agents. Use one of them.`, true);
			const { connectors, contacts, ...rest } = a;
			const created = await app.agents.create(call.p, { ...rest, ...(connectors ? { apps: connectors } : {}), ...(contacts ? { contacts: idsOf(contacts, all) } : {}) });
			const name = (id: string) => all.find((x) => x.id === id)?.name ?? id;
			return json({ created: true, agent: { id: created.id, name: created.name, description: created.description, connectors: created.apps, contacts: created.contacts.map(name) } });
		},
	);

	const updateAgent = deps.read(
		"update_agent",
		"Change yourself, the agent this chat is with: your name, your role, your description, your instructions, your contacts (the person's other agents you hand tasks to), or how you look in the sidebar: your emoji and color, or an image as your icon, such as one made with generate_image or found on the web. Do it when the person asks, or when handing parts of work you'll do again to another agent would help. Only the fields you give change, at once.",
		Type.Object({
			id: O(S({ description: "The id of another of the person's agents to change instead, from your_agents. Only their majordomo changes other agents." })),
			name: O(S({ minLength: 1, maxLength: 60 })),
			role: O(S({ minLength: 1, maxLength: 60, description: "What it is for, such as Researcher." })),
			description: O(S({ maxLength: 280 })),
			instructions: O(S({ maxLength: 20_000, description: "The complete new instructions: they replace the old ones." })),
			contacts: O(strings),
			add_contacts: O(Type.Array(S(), { maxItems: MAX_AGENTS, description: "Names of the person's other agents to hand tasks to with `delegate`." })),
			remove_contacts: O(Type.Array(S(), { maxItems: MAX_AGENTS, description: "Names of contacts to stop handing tasks to." })),
			emoji: O(S({ description: "One emoji shown as the icon." })),
			color: O(color),
			icon: O(Type.Union([S(), Type.Null()], { description: `An image shown as the icon in place of the emoji: a PNG, JPEG, WebP or GIF of at most ${MAX_ICON_BYTES / 1024} KB, as a path in the person's files, such as /workspace/images/coach.png, or the http(s) URL of an image on the web. null removes it, to show the emoji again.` })),
			model: O(Type.Object({ provider: S(), id: S() })),
			skills: O(strings),
			delegates: O(strings),
		}),
		async (app, call, a) => {
			const roster = await roster_(call);
			const { id, add_contacts, remove_contacts, icon, ...changes } = a;
			const self = roster.self;
			const target = id === undefined ? roster.agents.find((x) => x.id === self) : roster.agents.find((x) => x.id === id);
			if (!target) return text(id === undefined ? "You are not one of the person's agents, so there is nothing of yours to change." : `The person has no agent with the id ${id}. Use an id from your_agents.`, true);
			if (target.id !== self && !roster.majordomo) return text("Only the person's majordomo changes their other agents.", true);
			const current = await app.agents.get(call.p, target.id);
			const others = roster.agents.filter((x) => x.id !== target.id);
			let contacts = changes.contacts !== undefined ? idsOf(changes.contacts, others) : undefined;
			if (add_contacts || remove_contacts) {
				const removed = idsOf(remove_contacts ?? [], others);
				contacts = [...new Set([...(contacts ?? current.contacts).filter((c) => !removed.includes(c)), ...idsOf(add_contacts ?? [], others)])];
			}
			if (contacts?.some((c) => roster.agents.find((x) => x.id === c)?.majordomo)) return text("Contacts can't include the majordomo: it hands tasks to all of the person's agents.", true);
			const input: Record<string, unknown> = { ...changes, ...(contacts !== undefined ? { contacts } : {}) };
			let iconChanged = false;
			if (icon !== undefined) {
				input.icon = icon === null ? null : await iconKey(app, call.p, icon);
				iconChanged = true;
			}
			if (Object.keys(input).length === 0) return text("That changes nothing.", true);
			const updated = await app.agents.update(call.p, target.id, input);
			// The image an agent had before is not kept once another stands in for it.
			if (iconChanged && current.icon?.startsWith(`${ownerId}/`) && current.icon !== updated.icon) await app.objects.delete(call.p, current.icon).catch(() => undefined);
			return text(`${updated.name} is updated. The change applies from its next step.`);
		},
	);

	return [delegate, createAgent, updateAgent];
}
