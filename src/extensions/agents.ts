import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { type Static, Type } from "@earendil-works/pi-ai";
import {
	AGENT_COLORS,
	MAX_APPS,
	MAX_DESCRIPTION,
	MAX_INSTRUCTIONS,
	MAX_NAME,
	MAX_TEAM,
	type Agent,
	type AgentInput,
	type AgentStore,
	agentInput,
	agentInstructions,
} from "../agents";
import { majordomoRole, SEND_TO_AGENT } from "../majordomo";
import { memberInstructions, memberPreamble, type Role } from "../team";
import { approvalNote, defineGatedAction, fileApproval, type GatedAction, ownToolPermission } from "./approvals";
import type { DirectoryApp } from "./app-directory";
import type { BlueprintDefinition } from "./define";
import { type McpBridge, serverFor } from "./mcp";
import { type PimServices, json, text } from "./services";

export const CREATE_AGENT = "create_agent";
export const UPDATE_AGENT = "update_agent";
export const RENAME_AGENT = "rename_agent";
export const MANAGE_APPS = "manage_apps";

const Member = Type.Object({
	name: Type.String(),
	instructions: Type.String({ description: "Everything it needs to know: it starts each task knowing only these and the task." }),
	tools: Type.Optional(Type.Array(Type.String(), { description: "The only tools it may use, by name; leave out for all a member can have." })),
});

/** What `update_agent` changes. Members are added and removed one by one: an agent doesn't see all of its team's instructions. */
const Changes = Type.Object({
	description: Type.Optional(Type.String({ maxLength: MAX_DESCRIPTION })),
	instructions: Type.Optional(Type.String({ maxLength: MAX_INSTRUCTIONS, description: "Your complete new instructions: they replace the old ones." })),
	set_members: Type.Optional(Type.Array(Member, { maxItems: MAX_TEAM, description: "Team members to add, or to replace if one has the name." })),
	remove_members: Type.Optional(Type.Array(Type.String(), { description: "Names of team members to remove." })),
});
type Changes = Static<typeof Changes>;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** An agent with `changes` made, checked as the API checks an edit; throws what it refuses. */
function changed(agent: Agent, changes: Changes): AgentInput {
	const set = changes.set_members ?? [];
	const team = agent.team
		.filter((member) => !changes.remove_members?.some((name) => same(name, member.name)))
		// Replaced, a member keeps its name as it was written.
		.map((member) => {
			const given = set.find((candidate) => same(candidate.name, member.name));
			return given ? { ...given, name: member.name } : member;
		});
	return agentInput(
		{
			description: changes.description,
			instructions: changes.instructions,
			team: [...team, ...set.filter((given) => !team.some((member) => same(member.name, given.name)))],
		},
		agent,
	);
}

/** What an edit changes, for the person to approve: empty if nothing. */
function describeChanges(agent: Agent, next: AgentInput): string[] {
	const names = (list: readonly { name: string }[]) => list.map((item) => item.name);
	const missing = (from: readonly { name: string }[], to: readonly { name: string }[]) => names(from.filter((item) => !to.some((other) => same(other.name, item.name))));
	const editedMembers = next.team.filter((member) => {
		const before = agent.team.find((other) => same(other.name, member.name));
		return before && JSON.stringify(before) !== JSON.stringify(member);
	});
	return [
		...(next.description !== agent.description ? ["changes its description"] : []),
		...(next.instructions !== agent.instructions ? ["changes its instructions"] : []),
		...missing(next.team, agent.team).map((name) => `adds ${name} to its team`),
		...names(editedMembers).map((name) => `changes ${name} on its team`),
		...missing(agent.team, next.team).map((name) => `removes ${name} from its team`),
	];
}

/** The approved edit of an agent, made to it as it is then. */
export function updateAgentAction(agents: Pick<AgentStore, "get" | "update">): GatedAction {
	return defineGatedAction({
		name: UPDATE_AGENT,
		description: "An agent changes its own instructions, description or team.",
		// Filed by the tool, which names the chat's agent.
		internal: true,
		parameters: Type.Object({ agent: Type.String(), ...Changes.properties }),
		summarize: ({ agent }) => `Change the agent ${agent}`,
		async run({ agent: id, ...changes }) {
			const agent = agents.get(id);
			if (!agent) return "That agent no longer exists.";
			const updated = agents.update(id, changed(agent, changes));
			return `${updated.name} is updated. The change applies from its next step.`;
		},
	}) as GatedAction;
}

const AppChanges = Type.Object({
	add: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_APPS, description: "Ids of apps to add and connect after approval, as find_app gives them." })),
	remove: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_APPS, description: "Ids of apps to remove from this agent. The person's connection stays, for their other agents." })),
});
type AppChanges = Static<typeof AppChanges>;

/** Applies only the approved additions and removals to the agent as it is now; an app this Pim doesn't offer is refused. */
function changedApps(agent: Agent, changes: AppChanges, directory: readonly DirectoryApp[]): AgentInput {
	for (const ref of changes.add ?? []) {
		if (!directory.some((app) => app.ref === ref)) throw new Error(`This Pim offers no app ${ref}. Use find_app for an app's id.`);
	}
	const kept = agent.apps.filter((ref) => !changes.remove?.includes(ref));
	return agentInput({ apps: [...new Set([...kept, ...(changes.add ?? [])])] }, agent);
}

/** Changes this agent's app list and connects additions; never disconnects a shared app. */
export function manageAppsAction(
	agents: Pick<AgentStore, "get" | "update">,
	bridge: Pick<McpBridge, "servers" | "connect">,
	directory: () => readonly DirectoryApp[],
): GatedAction {
	return defineGatedAction({
		name: MANAGE_APPS,
		description: "An agent manages its own apps with explicit approval for every change.",
		internal: true,
		explicitApproval: true,
		parameters: Type.Object({ agent: Type.String(), ...AppChanges.properties }),
		summarize: ({ agent }) => `Change the apps of ${agent}`,
		async run({ agent: id, ...changes }) {
			const agent = agents.get(id);
			if (!agent) return "That agent no longer exists.";
			const apps = directory();
			const updated = agents.update(id, changedApps(agent, changes, apps));
			const results = [`${agent.name}'s apps are updated. Shared connections and their tool permissions are unchanged.`];
			for (const app of apps.filter((app) => changes.add?.includes(app.ref) && updated.apps.includes(app.ref))) {
				if (serverFor(bridge.servers(), app)?.state === "ready") {
					results.push(`${app.name} is already connected.`);
					continue;
				}
				try {
					const result = await bridge.connect(app);
					results.push(result.authUrl ? `${app.name} needs the person to sign in: ${result.authUrl}` : `Connected ${app.name}.`);
				} catch (error) {
					results.push(`${app.name} was added, but connecting failed: ${error instanceof Error ? error.message : String(error)}. Use connect_app to retry.`);
				}
			}
			return results.join("\n");
		},
	}) as GatedAction;
}

/** Renames one of the person's agents without changing its instructions or connections. */
export function renameAgentAction(agents: Pick<AgentStore, "get" | "update">): GatedAction {
	return defineGatedAction({
		name: RENAME_AGENT,
		description: "Rename one of the person's agents, including yourself, when they ask. Use its id from your_agents. Its chats and settings stay the same.",
		parameters: Type.Object({
			agent: Type.String({ description: "The agent's id from your_agents." }),
			name: Type.String({ minLength: 1, maxLength: MAX_NAME, pattern: "\\S", description: "The new name." }),
		}),
		summarize: ({ agent, name }) => `Rename ${JSON.stringify(agents.get(agent)?.name ?? agent)} to ${JSON.stringify(name.trim())}`,
		async run({ agent: id, name }) {
			const agent = agents.get(id);
			if (!agent) return "That agent no longer exists.";
			const updated = agents.update(id, agentInput({ name }, agent));
			return `${JSON.stringify(agent.name)} is now named ${JSON.stringify(updated.name)}. Its chats and settings are unchanged.`;
		},
	}) as GatedAction;
}

/** The person's agents, for a chat's agent to know them and make new ones. */
export type AgentsHost = {
	list(): readonly Agent[];
	/** The blueprints a new agent can build on. */
	blueprints(): readonly { ref: string; name: string; description: string }[];
	/** The apps the person can connect. */
	apps(): readonly DirectoryApp[];
	/** Checked as the API checks a new agent; throws what it refuses. */
	create(input: Record<string, unknown>): Agent;
};

/** What the agent a person talks with knows of their other agents, and when to make one. */
function agentsSection(self: Agent, host: AgentsHost): string {
	const blueprints = host.blueprints();
	return [
		"The person's agents. Each has its own chats in the sidebar; they share memory, apps, goals and schedules.",
		...host
			.list()
			.map(
				(agent) =>
					`- ${agent.name}${agent.id === self.id ? " (you)" : ""}${agent.majordomo ? " (their majordomo)" : ""}${agent.description ? `: ${agent.description}` : ""} [id: ${agent.id}]`,
			),
		self.majordomo
			? `Hand work to these with \`${SEND_TO_AGENT}\`. When none of them is right for it, such as a coding helper or a trip planner, make one with \`${CREATE_AGENT}\` without asking first, then send it the task. Each is in the sidebar too, with the chats you start with it, for the person to read and carry on.`
			: `When the person wants ongoing help of the kind another of these is for, tell them to start a chat with it from the sidebar. When they want ongoing help none of these covers, such as a coding helper or a trip planner, make one with \`${CREATE_AGENT}\` without asking first, then tell them it's in the sidebar. Don't make one for a one-off question: answer it yourself.`,
		...(blueprints.length > 1
			? [
					"A new agent can build on one of these blueprints, which gives it their habits and tools; give it as `blueprint`, or leave it out for the deployment's default:",
					...blueprints.map((blueprint) => `- ${blueprint.ref}: ${blueprint.name}${blueprint.description ? `, ${blueprint.description}` : ""}`),
				]
			: []),
	].join("\n");
}

/**
 * How every agent works, whatever it is for: how it talks to the person, and
 * the rules no agent's instructions change. Who it is and what it is good at
 * come in the `agent` section, from the blueprint it builds on and the person's own
 * instructions.
 */
const PREAMBLE = `You are an AI agent working for one person. Who you are in this conversation, and how you work, is in the \`agent\` section.

How you talk to the person:
- They see only what you send with \`send_to_user\`. Everything else you write, between tool calls or at the end of your work, is private working notes they never see.
- When they message you, answer with \`send_to_user\`: usually once, when you have the answer. A successful send finishes the turn by default: call it separately, after all other tools. For long work, a short note first with \`complete: false\` is fine, but you must still send the final answer when done.
- A failed send does not finish the turn; fix it or send a chat message explaining the problem.
- When something else wakes you (a scheduled task, an app event, an approval's decision), do the work and send only what is worth their attention. Staying silent is fine, and often right.
- Write like a capable assistant messaging them: short, warm, direct. No filler.

Rules that always hold:
- Ask before acting on the world. Tools that change things outside this conversation (sending requests, messages or purchases) need the person's approval. Calling them files an approval request; do not retry. The decision and result arrive later as a message starting with "[Approval".
- Be honest about what you can and cannot do. Never claim an action happened unless a tool result says so.
- Times: call \`current_time\` when the time matters.`;

/**
 * How every agent works, and the agent each chat talks as, or the team member it
 * is (`roleOf` its session). An agent's instructions are those of the
 * blueprint it builds on (`blueprintOf`), then the person's own.
 */
export function agentExtension(
	services: PimServices,
	roleOf: (session: string) => Role,
	blueprintOf: (agent: Agent) => BlueprintDefinition | undefined,
	agents: AgentsHost,
) {
	const createAgent = defineTool({
		name: CREATE_AGENT,
		description:
			"Make a new agent for the person: a named agent with its own instructions and the apps it works with, with its own chats in the sidebar. Only when none of their agents already does what they want. Write its instructions as the person would: what it's for, what to focus on, how to answer. Give it an emoji and a color that fit what it's for, so the person tells it apart in the sidebar. Apps are ids of apps this Pim offers, as `find_app` finds them; the person connects each the first time they use it.",
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: MAX_NAME }),
			description: Type.String({ maxLength: MAX_DESCRIPTION, description: "One line, shown under its name." }),
			instructions: Type.String({ maxLength: MAX_INSTRUCTIONS }),
			apps: Type.Optional(Type.Array(Type.String({ description: "An app's id, from find_app." }), { maxItems: MAX_APPS })),
			team: Type.Optional(
				Type.Array(Member, {
					maxItems: MAX_TEAM,
					description: "Members it hands parts of its work to with `delegate`, all working at once, such as a planner's researchers.",
				}),
			),
			blueprint: Type.Optional(Type.String({ description: "The blueprint it builds on, such as pim.assistant/pim; the default blueprint if left out." })),
			emoji: Type.Optional(Type.String({ description: "One emoji shown as its icon, such as 🏃 for a running coach." })),
			color: Type.Optional(Type.Union(AGENT_COLORS.map((color) => Type.Literal(color)), { description: "The color behind its emoji." })),
		}),
		// A rerun finds the agent it made by its name, and makes no other.
		replay: "safe",
		async execute(args) {
			const existing = agents.list().find((agent) => agent.name.toLowerCase() === args.name.trim().toLowerCase());
			if (existing) return json({ exists: true, agent: { id: existing.id, name: existing.name, description: existing.description } });
			try {
				const { emoji, ...rest } = args;
				const agent = agents.create({ ...rest, symbol: emoji });
				return json({
					created: true,
					agent: { id: agent.id, name: agent.name, description: agent.description, apps: agent.apps, team: agent.team.map((member) => member.name) },
				});
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	});

	const editing = ownToolPermission(services.store, UPDATE_AGENT).permission;
	const updateAgent = defineTool({
		name: UPDATE_AGENT,
		description: `Change yourself, the agent this chat is with: your description, your instructions, or your team. App changes use manage_apps instead. Do it when the person asks, or when a team would help with work you'll do again. Only the fields you give change.${editing === "ask" ? ` ${approvalNote(services)}` : ""}`,
		parameters: Changes,
		replay: "safe",
		async execute(changes, api, context) {
			const { agent } = roleOf(String(api.conversationId));
			let edits: string[];
			try {
				edits = describeChanges(agent, changed(agent, changes));
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
			// A rerun after the edit was made finds nothing left to change: it keeps what it asked.
			const summary = await api.memo("update_agent", edits.length === 0 ? "" : `${agent.name} ${edits.join(", ")}`, context);
			if (summary === "") return text("That changes nothing.", true);
			return fileApproval(services, api, context, { action: UPDATE_AGENT, tool: UPDATE_AGENT, args: { agent: agent.id, ...changes }, summary });
		},
	});

	const manageApps = defineTool({
		name: MANAGE_APPS,
		description: `Change the apps this agent works with when the person asks: add apps this Pim offers, by their ids from find_app, or remove them. Approval connects additions automatically; continue the original task once the result arrives. Removing an app affects only this agent, not the person's connection, which their other agents share. ${approvalNote(services, true)}`,
		parameters: AppChanges,
		replay: "safe",
		async execute(changes, api, context) {
			if (ownToolPermission(services.store, MANAGE_APPS).permission === "off") return text("The user turned off app management. Do not try it another way.", true);
			const { agent } = roleOf(String(api.conversationId));
			let summary: string;
			try {
				const apps = agents.apps();
				const next = changedApps(agent, changes, apps);
				const name = (ref: string) => apps.find((app) => app.ref === ref)?.name ?? ref;
				const removed = agent.apps.filter((ref) => !next.apps.includes(ref));
				const added = next.apps.filter((ref) => !agent.apps.includes(ref));
				summary = removed.length === 0 && added.length === 0 ? "" : `${agent.name}: ${[...removed.map((ref) => `remove ${name(ref)}`), ...added.map((ref) => `add and connect ${name(ref)}`)].join("; ")}`;
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
			summary = await api.memo(MANAGE_APPS, summary, context);
			if (summary === "") return text("That changes no editable apps. Apps inherited from the blueprint cannot be removed here. Use connect_app if an existing app needs connecting.", true);
			return fileApproval(services, api, context, { action: MANAGE_APPS, tool: null, args: { agent: agent.id, add: changes.add, remove: changes.remove }, summary }, true);
		},
	});

	const currentTime = defineTool({
		name: "current_time",
		description: "The current date and time, in UTC and in the user's time zone.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			const now = new Date();
			return json({
				utc: now.toISOString(),
				timeZone: services.timeZone,
				local: now.toLocaleString("en-US", { timeZone: services.timeZone, dateStyle: "full", timeStyle: "long" }),
			});
		},
	});

	return defineExtension({
		name: "pim.agents",
		sections: [
			section(
				"preamble",
				({ conversationId }) => {
					const { agent, member } = roleOf(String(conversationId));
					return member ? memberPreamble(agent, member) : PREAMBLE;
				},
				{ tag: false },
			),
			section("user_time_zone", () => services.timeZone),
			// Rendered at each request, so a chat follows its agent's edits from the next one.
			section("agent", ({ conversationId }) => {
				const { agent, member } = roleOf(String(conversationId));
				if (member) return memberInstructions(member);
				return agentInstructions(agent, blueprintOf(agent), agent.majordomo ? majordomoRole(agent) : undefined);
			}),
			section("your_agents", ({ conversationId }) => {
				const { agent, member } = roleOf(String(conversationId));
				return member ? undefined : agentsSection(agent, agents);
			}),
		],
		tools: [currentTime, createAgent, ...(editing === "off" ? [] : [updateAgent]), ...(ownToolPermission(services.store, MANAGE_APPS).permission === "off" ? [] : [manageApps])],
	});
}
