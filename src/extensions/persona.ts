import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { type Static, Type } from "@earendil-works/pi-ai";
import {
	MAX_APPS,
	MAX_DESCRIPTION,
	MAX_INSTRUCTIONS,
	MAX_NAME,
	MAX_TEAM,
	type Persona,
	type PersonaInput,
	type PersonaStore,
	personaInput,
	personaInstructions,
} from "../personas";
import { memberInstructions, memberPreamble, type Role } from "../team";
import { approvalNote, defineGatedAction, fileApproval, type GatedAction, ownToolPermission } from "./approvals";
import type { BaseDefinition } from "./define";
import { type PimServices, json, text } from "./services";

export const CREATE_PIM = "create_pim";
export const UPDATE_PIM = "update_pim";

const App = Type.Object({ name: Type.String(), url: Type.String({ description: "The app's remote MCP server, https." }) });
const Member = Type.Object({
	name: Type.String(),
	instructions: Type.String({ description: "Everything it needs to know: it starts each task knowing only these and the task." }),
	tools: Type.Optional(Type.Array(Type.String(), { description: "The only tools it may use, by name; leave out for all a member can have." })),
});

/** What `update_pim` changes. Apps and members are added and removed one by one: a Pim doesn't see all of its team's instructions. */
const Changes = Type.Object({
	description: Type.Optional(Type.String({ maxLength: MAX_DESCRIPTION })),
	instructions: Type.Optional(Type.String({ maxLength: MAX_INSTRUCTIONS, description: "Your complete new instructions: they replace the old ones." })),
	add_apps: Type.Optional(Type.Array(App, { maxItems: MAX_APPS })),
	remove_apps: Type.Optional(Type.Array(Type.String(), { description: "Names of your apps to stop working with." })),
	set_members: Type.Optional(Type.Array(Member, { maxItems: MAX_TEAM, description: "Team members to add, or to replace if one has the name." })),
	remove_members: Type.Optional(Type.Array(Type.String(), { description: "Names of team members to remove." })),
});
type Changes = Static<typeof Changes>;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A Pim with `changes` made, checked as the API checks an edit; throws what it refuses. */
function changed(pim: Persona, changes: Changes): PersonaInput {
	const set = changes.set_members ?? [];
	const team = pim.team
		.filter((member) => !changes.remove_members?.some((name) => same(name, member.name)))
		// Replaced, a member keeps its name as it was written.
		.map((member) => {
			const given = set.find((candidate) => same(candidate.name, member.name));
			return given ? { ...given, name: member.name } : member;
		});
	const added = changes.add_apps ?? [];
	const apps = pim.apps.filter((app) => !changes.remove_apps?.some((name) => same(name, app.name)) && !added.some((given) => given.url === app.url));
	return personaInput(
		{
			description: changes.description,
			instructions: changes.instructions,
			apps: [...apps, ...added],
			team: [...team, ...set.filter((given) => !team.some((member) => same(member.name, given.name)))],
		},
		pim,
	);
}

/** What an edit changes, for the person to approve: empty if nothing. */
function describeChanges(pim: Persona, next: PersonaInput): string[] {
	const names = (list: readonly { name: string }[]) => list.map((item) => item.name);
	const missing = (from: readonly { name: string }[], to: readonly { name: string }[]) => names(from.filter((item) => !to.some((other) => same(other.name, item.name))));
	const editedMembers = next.team.filter((member) => {
		const before = pim.team.find((other) => same(other.name, member.name));
		return before && JSON.stringify(before) !== JSON.stringify(member);
	});
	return [
		...(next.description !== pim.description ? ["changes its description"] : []),
		...(next.instructions !== pim.instructions ? ["changes its instructions"] : []),
		...missing(next.apps, pim.apps).map((name) => `adds the app ${name}`),
		...missing(pim.apps, next.apps).map((name) => `removes the app ${name}`),
		...missing(next.team, pim.team).map((name) => `adds ${name} to its team`),
		...names(editedMembers).map((name) => `changes ${name} on its team`),
		...missing(pim.team, next.team).map((name) => `removes ${name} from its team`),
	];
}

/** The approved edit of a Pim, made to it as it is then. */
export function updatePimAction(personas: Pick<PersonaStore, "get" | "update">): GatedAction {
	return defineGatedAction({
		name: UPDATE_PIM,
		description: "A Pim changes its own instructions, description, apps or team.",
		// Filed by the tool, which names the chat's Pim.
		internal: true,
		parameters: Type.Object({ pim: Type.String(), ...Changes.properties }),
		summarize: ({ pim }) => `Change the Pim ${pim}`,
		async run({ pim: id, ...changes }) {
			const pim = personas.get(id);
			if (!pim) return "That Pim no longer exists.";
			const updated = personas.update(id, changed(pim, changes));
			return `${updated.name} is updated. The change applies from its next step.`;
		},
	}) as GatedAction;
}

/** The person's Pims, for a chat's Pim to know them and make new ones. */
export type PimsHost = {
	list(): readonly Persona[];
	/** The bases a new Pim can build on. */
	bases(): readonly { ref: string; name: string; description: string }[];
	/** Checked as the API checks a new Pim; throws what it refuses. */
	create(input: Record<string, unknown>): Persona;
};

/** What the Pim a person talks with knows of their other Pims, and when to make one. */
function pimsSection(self: Persona, host: PimsHost): string {
	const bases = host.bases();
	return [
		"The person's Pims. Each has its own chats in the sidebar; they share memory, apps, goals and schedules.",
		...host
			.list()
			.map(
				(pim) =>
					`- ${pim.name}${pim.id === self.id ? " (you)" : ""}${pim.default ? " (default)" : ""}${pim.description ? `: ${pim.description}` : ""}`,
			),
		`When the person wants ongoing help of the kind another of these is for, tell them to start a chat with it from the sidebar. When they want ongoing help none of these covers, such as a coding helper or a trip planner, make one with \`${CREATE_PIM}\` without asking first, then tell them it's in the sidebar. Don't make one for a one-off question: answer it yourself.`,
		...(bases.length > 1
			? [
					"A new Pim can build on one of these bases, which gives it their habits and tools; give it as `base`, or leave it out for the deployment's default:",
					...bases.map((base) => `- ${base.ref}: ${base.name}${base.description ? `, ${base.description}` : ""}`),
				]
			: []),
	].join("\n");
}

/**
 * How every Pim works, whatever it is for: how it talks to the person, and
 * the rules no Pim's instructions change. Who it is and what it is good at
 * come in the `pim` section, from the base it builds on and the person's own
 * instructions.
 */
const PREAMBLE = `You are a Pim, an AI agent working for one person. Who you are in this conversation, and how you work, is in the \`pim\` section.

How you talk to the person:
- They see only what you send with \`send_to_user\`. Everything else you write, between tool calls or at the end of your work, is private working notes they never see.
- When they message you, answer with \`send_to_user\`: usually once, when you have the answer. For long work, a short note first that you're on it is fine.
- When something else wakes you (a scheduled task, an app event, an approval's decision), do the work and send only what is worth their attention. Staying silent is fine, and often right.
- Write like a capable assistant messaging them: short, warm, direct. No filler.

Rules that always hold:
- Ask before acting on the world. Tools that change things outside this conversation (sending requests, messages or purchases) need the person's approval. Calling them files an approval request; do not retry. The decision and result arrive later as a message starting with "[Approval".
- Be honest about what you can and cannot do. Never claim an action happened unless a tool result says so.
- Times: call \`current_time\` when the time matters.`;

/**
 * How every Pim works, and the Pim each chat talks as, or the team member it
 * is (`roleOf` its session). A Pim's instructions are those of the
 * base it builds on (`baseOf`), then the person's own.
 */
export function personaExtension(
	services: PimServices,
	roleOf: (session: string) => Role,
	baseOf: (pim: Persona) => BaseDefinition | undefined,
	pims: PimsHost,
) {
	const createPim = defineTool({
		name: CREATE_PIM,
		description:
			"Make a new Pim for the person: a named agent with its own instructions and the apps it works with, with its own chats in the sidebar. Only when none of their Pims already does what they want. Write its instructions as the person would: what it's for, what to focus on, how to answer. Apps are remote MCP servers by https URL, such as ones `find_app` finds; the person connects each the first time they use it.",
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: MAX_NAME }),
			description: Type.String({ maxLength: MAX_DESCRIPTION, description: "One line, shown under its name." }),
			instructions: Type.String({ maxLength: MAX_INSTRUCTIONS }),
			apps: Type.Optional(Type.Array(App, { maxItems: MAX_APPS })),
			team: Type.Optional(
				Type.Array(Member, {
					maxItems: MAX_TEAM,
					description: "Members it hands parts of its work to with `delegate`, all working at once, such as a planner's researchers.",
				}),
			),
			base: Type.Optional(Type.String({ description: "The base it builds on, such as pim.assistant/pim; the default base if left out." })),
		}),
		// A rerun finds the Pim it made by its name, and makes no other.
		replay: "safe",
		async execute(args) {
			const existing = pims.list().find((pim) => pim.name.toLowerCase() === args.name.trim().toLowerCase());
			if (existing) return json({ exists: true, pim: { id: existing.id, name: existing.name, description: existing.description } });
			try {
				const pim = pims.create(args);
				return json({
					created: true,
					pim: { id: pim.id, name: pim.name, description: pim.description, apps: pim.apps, team: pim.team.map((member) => member.name) },
				});
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	});

	const editing = ownToolPermission(services.store, UPDATE_PIM).permission;
	const updatePim = defineTool({
		name: UPDATE_PIM,
		description: `Change yourself, the Pim this chat is with: your description, your instructions, the apps you work with, or your team. Do it when the person asks, or when a team would help with work you'll do again. Only the fields you give change.${editing === "ask" ? ` ${approvalNote(services)}` : ""}`,
		parameters: Changes,
		replay: "safe",
		async execute(changes, api, context) {
			const { pim } = roleOf(String(api.conversationId));
			let edits: string[];
			try {
				edits = describeChanges(pim, changed(pim, changes));
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
			// A rerun after the edit was made finds nothing left to change: it keeps what it asked.
			const summary = await api.memo("update_pim", edits.length === 0 ? "" : `${pim.name} ${edits.join(", ")}`, context);
			if (summary === "") return text("That changes nothing.", true);
			return fileApproval(services, api, context, { action: UPDATE_PIM, tool: UPDATE_PIM, args: { pim: pim.id, ...changes }, summary });
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
		name: "pim.persona",
		sections: [
			section(
				"preamble",
				({ conversationId }) => {
					const { pim, member } = roleOf(String(conversationId));
					return member ? memberPreamble(pim, member) : PREAMBLE;
				},
				{ tag: false },
			),
			section("user_time_zone", () => services.timeZone),
			// Rendered at each request, so a chat follows its Pim's edits from the next one.
			section("pim", ({ conversationId }) => {
				const { pim, member } = roleOf(String(conversationId));
				return member ? memberInstructions(member) : personaInstructions(pim, baseOf(pim));
			}),
			section("your_pims", ({ conversationId }) => {
				const { pim, member } = roleOf(String(conversationId));
				return member ? undefined : pimsSection(pim, pims);
			}),
		],
		tools: [currentTime, createPim, ...(editing === "off" ? [] : [updatePim])],
	});
}
