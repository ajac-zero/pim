import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { type Static, Type } from "@earendil-works/pi-ai";
import {
	AGENT_COLORS,
	checkIcon,
	MAX_APPS,
	MAX_ICON_BYTES,
	MAX_DESCRIPTION,
	MAX_INSTRUCTIONS,
	MAX_NAME,
	MAX_AGENTS,
	type Agent,
	type AgentInput,
	type AgentStore,
	agentInput,
	agentInstructions,
	checkContacts,
} from "../agents";
import { sha256 } from "../artifacts";
import { FILES_ROOT, type Files, filesPath, imageType } from "../files";
import { HttpError } from "../http";
import { majordomoRole } from "../majordomo";
import { DELEGATE, type Role, taskPreamble } from "../tasks";
import { approvalNote, defineGatedAction, fileApproval, type GatedAction, ownToolPermission } from "./approvals";
import type { DirectoryApp } from "./app-directory";
import type { BlueprintDefinition } from "./define";
import { type McpBridge, serverFor } from "./mcp";
import type { NamedScope } from "./optmem/store";
import { type PimServices, json, text } from "./services";

export const CREATE_AGENT = "create_agent";
export const UPDATE_AGENT = "update_agent";
export const RENAME_AGENT = "rename_agent";
export const MANAGE_APPS = "manage_apps";
export const ADD_CUSTOM_APP = "add_custom_app";
export const SHARE_MEMORY_SCOPE = "share_memory_scope";

/** What `update_agent` changes. Contacts are added and removed by name. */
const Changes = Type.Object({
	description: Type.Optional(Type.String({ maxLength: MAX_DESCRIPTION })),
	instructions: Type.Optional(Type.String({ maxLength: MAX_INSTRUCTIONS, description: "The complete new instructions: they replace the old ones." })),
	add_contacts: Type.Optional(
		Type.Array(Type.String(), { maxItems: MAX_AGENTS, description: `Names of the person's other agents to hand tasks to with \`${DELEGATE}\`.` }),
	),
	remove_contacts: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_AGENTS, description: "Names of contacts to stop handing tasks to." })),
	emoji: Type.Optional(Type.String({ description: "One emoji shown as the icon." })),
	color: Type.Optional(Type.Union(AGENT_COLORS.map((color) => Type.Literal(color)), { description: "The color behind the emoji." })),
	icon: Type.Optional(
		Type.Union([Type.String(), Type.Null()], {
			description: `An image shown as the icon in place of the emoji: a PNG, JPEG, WebP or GIF of at most ${MAX_ICON_BYTES / 1024} KB, as a path in the person's files, such as ${FILES_ROOT}/images/coach.png, or the http(s) URL of an image on the web. null removes it, to show the emoji again.`,
		}),
	),
});
type Changes = Static<typeof Changes>;

/** An image for an agent's icon, from the person's files or the web, checked as an uploaded icon is. */
async function readIcon(source: string, files: Pick<Files, "bytes">): Promise<Uint8Array> {
	let bytes: Uint8Array;
	if (filesPath(source) !== null) bytes = await files.bytes(source);
	else if (/^https?:\/\//.test(source)) {
		const response = await fetch(source, { headers: { "user-agent": "pim-agent/0.1" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
		if (!response.ok) {
			await response.body?.cancel();
			throw new HttpError(502, `${source} answered HTTP ${response.status}.`);
		}
		bytes = new Uint8Array(await response.arrayBuffer());
	} else throw new HttpError(400, `icon must be a path under ${FILES_ROOT}, an http(s) URL, or null`);
	checkIcon(imageType(bytes) ?? "", bytes.byteLength);
	return bytes;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The ids of the person's agents called `names`; throws for a name none of them has. */
function agentIds(names: readonly string[], agents: readonly Agent[]): string[] {
	return names.map((name) => {
		const agent = agents.find((candidate) => same(candidate.name, name));
		if (!agent) throw new Error(`The person has no agent called ${name}. Their agents: ${agents.map((candidate) => candidate.name).join(", ")}.`);
		return agent.id;
	});
}

/** An agent with `changes` made, checked as the API checks an edit; throws what it refuses. */
function changed(agent: Agent, changes: Changes, agents: readonly Agent[]): AgentInput {
	const added = agentIds(changes.add_contacts ?? [], agents);
	const removed = agentIds(changes.remove_contacts ?? [], agents);
	const contacts = [...agent.contacts.filter((id) => !removed.includes(id)), ...added.filter((id) => !agent.contacts.includes(id) && !removed.includes(id))];
	const { description, instructions, emoji: symbol, color } = changes;
	return checkContacts(agent, agentInput({ description, instructions, contacts, symbol, color }, agent), agents);
}

/** What an edit changes, for the person to approve: empty if nothing. `whose` is "its", or the agent's name when another agent edits it. */
function describeChanges(agent: Agent, next: AgentInput, icon: Changes["icon"], agents: readonly Agent[], whose: string): string[] {
	const name = (id: string) => agents.find((other) => other.id === id)?.name ?? id;
	return [
		...(next.description !== agent.description ? [`changes ${whose} description`] : []),
		...(next.instructions !== agent.instructions ? [`changes ${whose} instructions`] : []),
		...next.contacts.filter((id) => !agent.contacts.includes(id)).map((id) => `adds ${name(id)} to ${whose} contacts, to hand tasks to`),
		...agent.contacts.filter((id) => !next.contacts.includes(id)).map((id) => `removes ${name(id)} from ${whose} contacts`),
		...(next.symbol !== undefined && next.symbol !== agent.symbol ? [`makes ${whose} emoji ${next.symbol}`] : []),
		...(next.color !== undefined && next.color !== agent.color ? [`makes ${whose} color ${next.color}`] : []),
		...(typeof icon === "string" ? [`makes ${whose} icon the image at ${icon}`] : []),
		...(icon === null && agent.icon !== null ? [`removes ${whose} icon image`] : []),
	];
}

/**
 * The image an `update_agent` request makes an agent's icon, read again: the
 * approval card shows it, and approving sets it. Refused when it is no longer
 * the image the agent asked for, whose hash the request names.
 */
export async function requestedIcon(args: unknown, files: Pick<Files, "bytes">): Promise<{ type: string; bytes: Uint8Array }> {
	const { icon, icon_sha256 } = (args ?? {}) as { icon?: unknown; icon_sha256?: unknown };
	if (typeof icon !== "string") throw new HttpError(404, "This request sets no icon image.");
	const bytes = await readIcon(icon, files);
	if ((await sha256(bytes)) !== icon_sha256) throw new HttpError(409, `${icon} changed since it was asked for, so it isn't the image the person approved.`);
	return { type: imageType(bytes)!, bytes };
}

/** The approved edit of an agent, made to it as it is then. An icon is set only if its image is still the one the person approved. */
export function updateAgentAction(agents: Pick<AgentStore, "get" | "update" | "list" | "setIcon" | "removeIcon">, files: Pick<Files, "bytes">): GatedAction {
	return defineGatedAction({
		name: UPDATE_AGENT,
		description: "An agent changes itself, or the majordomo changes another agent: instructions, description, contacts or icon.",
		// Filed by the tool, which names the agent to change.
		internal: true,
		parameters: Type.Object({ agent: Type.String(), ...Changes.properties, icon_sha256: Type.Optional(Type.String()) }),
		summarize: ({ agent }) => `Change the agent ${agent}`,
		async run(args) {
			const { agent: id, icon, icon_sha256: _, ...changes } = args;
			const agent = agents.get(id);
			if (!agent) return "That agent no longer exists.";
			let image: { type: string; bytes: Uint8Array } | undefined;
			if (typeof icon === "string") {
				try {
					image = await requestedIcon(args, files);
				} catch (error) {
					return `Nothing changed: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
			const updated = agents.update(id, changed(agent, changes, agents.list()));
			if (image) agents.setIcon(id, image.type, image.bytes.buffer as ArrayBuffer);
			else if (icon === null) agents.removeIcon(id);
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
			const added = apps.filter((app) => changes.add?.includes(app.ref) && updated.apps.includes(app.ref));
			return [`${agent.name}'s apps are updated. Shared connections and their tool permissions are unchanged.`, ...(await connectAdded(bridge, added))].join("\n");
		},
	}) as GatedAction;
}

/** Connects apps just added to an agent, saying for each what came of it. */
async function connectAdded(bridge: Pick<McpBridge, "servers" | "connect">, apps: readonly DirectoryApp[]): Promise<string[]> {
	const results: string[] = [];
	for (const app of apps) {
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
	return results;
}

/**
 * The admin's majordomo adds a remote MCP server to this Pim's apps, as the
 * admin does in Apps → Create new app, then works with it and connects it.
 * The space offers it only to the admin's majordomo; `add` checks again.
 */
export function addCustomAppAction(
	agents: Pick<AgentStore, "majordomo" | "update">,
	bridge: Pick<McpBridge, "servers" | "connect">,
	/** Puts the server in the directory, unless an app there has its URL already, and returns that app. */
	add: (app: { name: string; url: string; description?: string }) => Promise<DirectoryApp>,
): GatedAction {
	return defineGatedAction({
		name: ADD_CUSTOM_APP,
		description:
			"The person runs this Pim: add a remote MCP server they give you to its apps, for everyone on it, then add it to your apps and connect it. Only for an app find_app doesn't find. Give the server's https URL as the person gave it, never with credentials in it; if it needs a sign-in, you get the link to give them. Then hand it to an agent with create_agent's apps, or they add it to one in Your agents.",
		explicitApproval: true,
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: 60, description: "The app's name, as people will see it." }),
			url: Type.String({ pattern: "^https://\\S+$", maxLength: 500, description: "The MCP server's https URL." }),
			description: Type.Optional(Type.String({ maxLength: 160, description: "What it does, in a sentence." })),
		}),
		summarize: ({ name, url }) => `Add ${name} (${url}) to this Pim's apps for everyone, and connect it`,
		async run(input) {
			const app = await add(input);
			const majordomo = agents.majordomo();
			agents.update(majordomo.id, agentInput({ apps: [...new Set([...majordomo.apps, app.ref])] }, majordomo));
			return [`${app.name} is one of this Pim's apps [id: ${app.ref}], and one of yours.`, ...(await connectAdded(bridge, [app]))].join("\n");
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

/**
 * The majordomo lets another agent read one of the person's named memory
 * scopes, or stop reading it: who knows what about them is theirs to say,
 * so it asks first.
 */
export function shareMemoryScopeAction(agents: Pick<AgentStore, "get" | "update">, scopes: () => readonly NamedScope[]): GatedAction {
	const named = (key: string) => scopes().find((scope) => scope.key === key);
	return defineGatedAction({
		name: SHARE_MEMORY_SCOPE,
		description:
			"Let another of the person's agents read one of their named memory scopes, as your memory lists it, or with `stop` no longer read it, when the agent needs what it holds for its work or the person asks. Use the agent's id from your_agents.",
		parameters: Type.Object({
			scope: Type.String({ description: "A named scope's key, such as s_0123456789ab, as your memory lists it." }),
			agent: Type.String({ description: "The agent's id from your_agents." }),
			stop: Type.Optional(Type.Boolean({ description: "True to stop it reading the scope." })),
		}),
		summarize: ({ scope, agent, stop }) => {
			const who = JSON.stringify(agents.get(agent)?.name ?? agent);
			const what = JSON.stringify(named(scope)?.name ?? scope);
			return stop ? `Stop ${who} reading the memory scope ${what}` : `Let ${who} read the memory scope ${what}`;
		},
		async run({ scope: key, agent: id, stop }) {
			const scope = named(key);
			if (!scope) return `There is no named memory scope ${key}: only a scope the person or you named can be shared.`;
			const agent = agents.get(id);
			if (!agent) return "That agent no longer exists.";
			if (agent.majordomo) return "You read every scope already.";
			const memoryScopes = stop ? agent.memoryScopes.filter((other) => other !== key) : [...new Set([...agent.memoryScopes, key])];
			agents.update(id, agentInput({ memoryScopes }, agent));
			return stop ? `${agent.name} no longer reads "${scope.name}".` : `${agent.name} reads "${scope.name}" from its next step.`;
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
	/** The person's files, where an agent's new icon can come from. */
	files: Pick<Files, "bytes">;
};

/** What the agent a person talks with knows of their other agents, and when to make one. */
function agentsSection(self: Agent, host: AgentsHost): string {
	const blueprints = host.blueprints();
	return [
		"The person's agents. Each has its own chats in the sidebar; they share apps, goals and schedules, and each remembers what its memory scopes hold.",
		...host
			.list()
			.map(
				(agent) =>
					`- ${agent.name}${agent.id === self.id ? " (you)" : ""}${agent.majordomo ? " (their majordomo)" : ""}${agent.description ? `: ${agent.description}` : ""} [id: ${agent.id}]`,
			),
		self.majordomo
			? `Hand work to these with \`${DELEGATE}\`. When none of them is right for it, such as a coding helper or a trip planner, make one with \`${CREATE_AGENT}\` without asking first, then hand it the task. Each is in the sidebar too, with its own chats, for the person to talk with it directly.`
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
- Ask before acting on the world. Tools that change things outside this conversation (sending requests, messages or purchases) need the person's approval. Calling one asks for it and waits for the decision, which the call returns with the action's result; do not retry.
- Be honest about what you can and cannot do. Never claim an action happened unless a tool result says so.
- Times: call \`current_time\` when the time matters.`;

/**
 * How every agent works, and the agent each chat talks as, or the agent at
 * work on a task (`roleOf` its session). An agent's instructions are those of the
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
			contacts: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: MAX_AGENTS,
					description: `Names of the person's other agents it hands parts of its work to with \`${DELEGATE}\`, such as a planner's researcher. Make those first.`,
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
				const { emoji, contacts, ...rest } = args;
				const all = agents.list();
				const agent = agents.create({ ...rest, symbol: emoji, contacts: agentIds(contacts ?? [], all) });
				const name = (id: string) => all.find((other) => other.id === id)?.name ?? id;
				return json({
					created: true,
					agent: { id: agent.id, name: agent.name, description: agent.description, apps: agent.apps, contacts: agent.contacts.map(name) },
				});
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	});

	const editing = ownToolPermission(services.store, UPDATE_AGENT).permission;
	const updateAgent = defineTool({
		name: UPDATE_AGENT,
		description: `Change yourself, the agent this chat is with: your description, your instructions, your contacts (the person's other agents you hand tasks to), or how you look in the sidebar: your emoji and color, or an image as your icon, such as one made with generate_image or found on the web. App changes use manage_apps instead. Do it when the person asks, or when handing parts of work you'll do again to another agent would help. Only the fields you give change.${editing === "ask" ? ` ${approvalNote(services)}` : ""}`,
		parameters: Type.Object({
			agent: Type.Optional(
				Type.String({ description: "The id of another of the person's agents to change instead, from your_agents. Only their majordomo changes other agents." }),
			),
			...Changes.properties,
		}),
		replay: "safe",
		async execute({ agent: id, ...changes }, api, context) {
			const { agent: self } = roleOf(String(api.conversationId));
			const all = agents.list();
			const agent = id === undefined ? self : all.find((other) => other.id === id);
			if (!agent) return text(`The person has no agent with the id ${id}. Use an id from your_agents.`, true);
			if (agent.id !== self.id && !self.majordomo) return text("Only the person's majordomo changes their other agents.", true);
			let edits: string[];
			let icon_sha256: string | undefined;
			try {
				edits = describeChanges(agent, changed(agent, changes, all), changes.icon, all, agent.id === self.id ? "its" : `${agent.name}'s`);
				if (typeof changes.icon === "string") icon_sha256 = await sha256(await readIcon(changes.icon, agents.files));
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
			// A rerun after the edit was made finds nothing left to change: it keeps what it asked, and the image it read.
			const summary = await api.memo("update_agent", edits.length === 0 ? "" : `${self.name} ${edits.join(", ")}`, context);
			if (summary === "") return text("That changes nothing.", true);
			if (icon_sha256 !== undefined) icon_sha256 = await api.memo("icon_sha256", icon_sha256, context);
			return fileApproval(services, api, context, { action: UPDATE_AGENT, tool: UPDATE_AGENT, args: { agent: agent.id, ...changes, icon_sha256 }, summary });
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
					const { agent, from } = roleOf(String(conversationId));
					return from === null ? PREAMBLE : taskPreamble(agent.name, from);
				},
				{ tag: false },
			),
			section("user_time_zone", () => services.timeZone),
			// Rendered at each request, so a chat follows its agent's edits from the next one.
			section("agent", ({ conversationId }) => {
				const { agent } = roleOf(String(conversationId));
				return agentInstructions(agent, blueprintOf(agent), agent.majordomo ? majordomoRole(agent) : undefined);
			}),
			section("your_agents", ({ conversationId }) => {
				const { agent, from } = roleOf(String(conversationId));
				return from === null ? agentsSection(agent, agents) : undefined;
			}),
		],
		tools: [currentTime, createAgent, ...(editing === "off" ? [] : [updateAgent]), ...(ownToolPermission(services.store, MANAGE_APPS).permission === "off" ? [] : [manageApps])],
	});
}
