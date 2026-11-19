/**
 * `write_skill`, as v1 had it (`src/extensions/skills.ts`): a person approves every write, a rewrite names the version it read (`base_version`), and the skill is added to the list of the
 * agent it is for, which is what puts it in that agent's `your_skills`. Only the person's majordomo writes for another agent, and an agent at work on a task writes none.
 * `install_skill`, from a GitHub folder, stays with the other tools of `./agent-tools.ts`.
 */
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import type { Principal } from "@pim/v2-contracts/identity";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { rosterOf } from "./agent-team-tools.ts";
import { askFirst, recordResult } from "./tool-approval.ts";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
type Define = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => ToolRegistration;

const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

export function skillTools(deps: { ownerId: string; runtime: RuntimeDb; read: Define }): ToolRegistration[] {
	// A tool that waits for a person's approval is parked and run again when they decide, so it is one that may be run again: `read` defines such tools.
	const { ownerId, runtime, read } = deps;
	const S = Type.String;
	const O = Type.Optional;
	return [
		read("write_skill", "Save how to do something as one of your skills, so the work is done the same way next time, or rewrite one. Do it when the person asks you to remember how they want something done, or once you have worked out with them a task they'll ask for again. The person approves it first. To rewrite a skill, load it with read_skill first and give its version as base_version with the complete new instructions. Only the person's majordomo can give agent, to write a skill for another of their agents.", Type.Object({
			name: S({ description: "Lowercase letters, digits and hyphens, such as weekly-report." }),
			description: O(S({ maxLength: 1024, description: "What it does and when to use it, in a sentence or two: all an agent sees of it until it loads it." })),
			body: O(S({ description: "The whole procedure in Markdown, for an agent that knows nothing else about it: the steps, the connectors and tools to use, what to check, and what the result looks like. A rewrite replaces all of it." })),
			files: O(Type.Record(S(), S(), { description: "Supporting files the instructions point to, by path relative to the skill, such as references/guide.md. Every file the skill should have; leave out to keep the ones it has." })),
			base_version: O(Type.Integer({ minimum: 1, description: "To rewrite an existing skill: its version, as read_skill gave it." })),
			agent: O(S({ description: "The id of another of the person's agents to give the skill to instead, from your_agents. Only their majordomo writes skills for other agents." })),
		}), async (app, call, a) => {
			if (call.p.kind === "delegated") return text("An agent at work on a task writes no skills: only an agent in its chat with the person does.", true);
			const roster = await rosterOf(runtime, ownerId, call.chat);
			const by = roster.agents.find((x) => x.id === roster.self);
			const forId = a.agent ?? roster.self;
			// An agent's switch for skills, in Tool permissions: off, its chats write none, and the majordomo writes none for it.
			const switchedOff = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT 1 FROM pim_app.tool_permissions WHERE audience = ANY($1) AND app = '' AND tool = 'write_skill' AND permission = 'off'", [[roster.self, forId].filter(Boolean).map((id) => `agent:${id}`)])).rowCount);
			if (switchedOff) return text("The person turned skills off for this agent, so no skill is written.", true);
			const agents = await app.agents.list(call.p);
			// A space with no agent of its own to give the skill to keeps it among the person's skills, unlisted.
			const target = forId ? agents.find((x) => x.id === forId) : undefined;
			if (forId && !target) return text(`The person has no agent with the id ${forId}. Use an id from your_agents.`, true);
			if (target && target.id !== roster.self && !roster.majordomo) return text("Only the person's majordomo writes skills for their other agents.", true);
			// What the write would change for others, said before anyone is asked: a skill another agent lists, or one of the person's own that is not on this agent's list.
			const others = agents.filter((x) => x.id !== target?.id && x.skills.includes(a.name));
			if (others.length > 0) {
				const whose = others.map((x) => x.name).join(", ");
				return text(target?.skills.includes(a.name)
					? `${a.name} is one of ${whose}'s skills too, and a write would change it for them as well, so nothing is written. The person can take it off the others on the skill's page first.`
					: `${a.name} is one of ${whose}'s skills${target ? `, not ${target.name}'s, so it isn't written for ${target.name}` : ""}: give this one another name.`, true);
			}
			const existing = await app.agents.getSkill(call.p, a.name).catch(() => undefined);
			if (existing && target && !target.skills.includes(a.name)) return text(`The person has a skill named ${a.name} that isn't one of ${target.name}'s: give this one another name, or ask the person to give that one to ${target.name} first.`, true);
			if (existing && a.base_version === undefined) return text(`A skill named ${a.name} exists already: read it, then give its version as base_version to rewrite it`, true);
			if (!existing && a.base_version !== undefined) return text(`No skill named ${a.name}`, true);
			if (existing && a.base_version !== existing.version) return text(`${a.name} is at version ${existing.version} now, not ${a.base_version}: read it again before rewriting it`, true);
			if (!existing && !a.body) return text("Give the skill's instructions as body.", true);
			const forWhom = target?.name ?? "the person";
			const summary = existing ? `${by && target && by.id !== target.id ? `${by.name} rewrites ${forWhom}'s skill` : `${forWhom} rewrites the skill`} ${a.name}` : `${by && target && by.id !== target.id ? `${by.name} saves a new skill for ${forWhom}` : `${by?.name ?? "An agent"} saves a new skill`}: ${a.name}`;
			const waiting = await askFirst({ app, runtime, ownerId }, call, { action: "skill:write", tool: "write_skill", resource: { skill: a.name, ...(target ? { agent: target.id } : {}) }, summary, args: { name: a.name, ...(target ? { agent: target.id } : {}), description: a.description, instructions: a.body, files: a.files, ...(a.base_version === undefined ? {} : { base_version: a.base_version }) }, denied: "The person did not approve this skill, so it was not saved." });
			if (waiting) return waiting;
			// Written to the skill as it is when the person has approved, which must still be the version they were shown.
			const saved = existing
				? await app.agents.updateSkill(call.p, a.name, { description: a.description, body: a.body, files: a.files, baseVersion: a.base_version })
				: await app.agents.createSkill(call.p, { name: a.name, description: a.description, body: a.body, files: a.files });
			if (target && !target.skills.includes(a.name)) await app.agents.update(call.p, target.id, { skills: [...target.skills, a.name] });
			const done = `Saved the skill ${a.name}, version ${saved.version}${target ? `, one of ${target.name}'s skills. It applies from its next step` : ""}.`;
			await recordResult(app, ownerId, "skill:write", String(call.api.taskId), done);
			return text(done);
		}),
	];
}
