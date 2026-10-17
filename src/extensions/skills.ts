import { type Static, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { type AgentStore, agentInput } from "../agents";
import { HttpError } from "../http";
import { MAX_SKILL_DESCRIPTION, MAX_SKILL_INSTRUCTIONS, type SkillStore } from "../skills";
import type { Role } from "../team";
import { approvalNote, defineGatedAction, fileApproval, type GatedAction, ownToolPermission } from "./approvals";
import { type PimServices, text } from "./services";

/**
 * The person's own skills in their agents' chats: the `your_skills` section
 * lists the chat's agent's skills, `read_skill` loads one (./app-skills.ts),
 * and `write_skill` saves a new one or rewrites one once the person approves,
 * since a skill steers every later run that loads it.
 */

export const WRITE_SKILL = "write_skill";

const Write = Type.Object({
	name: Type.String({ description: "Lowercase letters, digits and hyphens, such as weekly-report." }),
	description: Type.String({
		maxLength: MAX_SKILL_DESCRIPTION,
		description: "What it does and when to use it, in a sentence or two: all an agent sees of it until it loads it.",
	}),
	instructions: Type.String({
		maxLength: MAX_SKILL_INSTRUCTIONS,
		description:
			"The whole procedure in Markdown, for an agent that knows nothing else about it: the steps, the apps and tools to use, what to check, and what the result looks like. A rewrite replaces all of it.",
	}),
	base_version: Type.Optional(Type.Integer({ minimum: 1, description: "To rewrite an existing skill: its version, as read_skill gave it." })),
});
type Write = Static<typeof Write>;

const failure = (error: unknown) => {
	if (error instanceof HttpError) return error.message;
	throw error;
};

/** The approved write of a skill, made to the skill as it is then, and added to the agent that wrote it. */
export function writeSkillAction(skills: SkillStore, agents: Pick<AgentStore, "get" | "update">): GatedAction {
	return defineGatedAction({
		name: WRITE_SKILL,
		description: "An agent saves a skill, or rewrites one: instructions for work it does again, which the person's agents follow.",
		// Filed by the tool, which names the chat's agent.
		internal: true,
		parameters: Type.Object({ agent: Type.String(), ...Write.properties }),
		summarize: ({ name }) => `Save the skill ${name}`,
		async run({ agent: id, name, description, instructions, base_version }) {
			try {
				const agent = agents.get(id);
				const skill = skills.write({ name, description, instructions, baseVersion: base_version, author: agent?.name });
				if (agent && !agent.skills.includes(name)) agents.update(id, agentInput({ skills: [...agent.skills, name] }, agent));
				return `Saved the skill ${name}, version ${skill.version}${agent ? `, one of ${agent.name}'s skills` : ""}. It applies from the next step.`;
			} catch (error) {
				return `The skill was not saved: ${failure(error)}`;
			}
		},
	}) as GatedAction;
}

export function skillsExtension(services: PimServices, roleOf: (session: string) => Role, skills: SkillStore) {
	const permission = () => ownToolPermission(services.store, WRITE_SKILL).permission;

	const writeSkill = defineTool({
		name: WRITE_SKILL,
		description: `Save how to do something as one of your skills, so the work is done the same way next time, or rewrite one. Do it when the person asks you to remember how they want something done, or once you have worked out with them a task they'll ask for again. To rewrite a skill, load it with read_skill first and give its version as base_version with the complete new instructions.${permission() === "ask" ? ` ${approvalNote(services)}` : ""}`,
		parameters: Write,
		replay: "safe",
		async execute(write: Write, api, context) {
			const { agent } = roleOf(String(api.conversationId));
			let summary: string;
			try {
				const checked = skills.check({ ...write, baseVersion: write.base_version });
				// Checked now so a request the person would approve in vain is never filed.
				if (!agent.skills.includes(checked.name)) agentInput({ skills: [...agent.skills, checked.name] }, agent);
				summary = write.base_version === undefined ? `${agent.name} saves a new skill: ${checked.name}` : `${agent.name} rewrites the skill ${checked.name}`;
			} catch (error) {
				return text(failure(error), true);
			}
			summary = await api.memo(WRITE_SKILL, summary, context);
			return fileApproval(services, api, context, { action: WRITE_SKILL, tool: WRITE_SKILL, args: { agent: agent.id, ...write }, summary });
		},
	});

	return defineExtension({
		name: "pim.skills",
		sections: [
			// Rendered at each request, so a chat sees a skill from the step after it is saved.
			section("your_skills", ({ conversationId }) => {
				const { agent, member } = roleOf(String(conversationId));
				const mine = agent.skills.flatMap((name) => skills.get(name) ?? []);
				const writes = !member && permission() !== "off";
				if (mine.length === 0 && !writes) return undefined;
				return [
					...(mine.length === 0
						? ["You have no skills yet."]
						: [
								"Your skills: how the person wants work that comes up again done. Before such work, load its skill with read_skill (its name, no app) and follow it.",
								...mine.map((skill) => `- ${skill.name}: ${skill.description}`),
							]),
					...(writes ? ["When the person asks you to remember how to do something, or you have worked out with them how to do a task they'll ask for again, save it with write_skill."] : []),
				].join("\n");
			}),
		],
		tools: permission() === "off" ? [] : [writeSkill],
	});
}
