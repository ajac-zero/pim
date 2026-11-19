/**
 * `write_skill`, as v1 had it (`src/extensions/skills.ts`): a person approves every write, a rewrite names the version it read (`base_version`), and the skill is added to the list of the
 * agent it is for, which is what puts it in that agent's `your_skills`. Only the person's majordomo writes for another agent, and an agent at work on a task writes none.
 * A supporting file is text the agent writes, or a copy of one of the person's files (`copy_files`, a template or a font, text or not): the approval names each copy's SHA-256, and the file is read again
 * when the person has decided and saved only if it is still the same. `install_skill`, from a GitHub folder or one in the person's files, stays with the other tools of `./agent-tools.ts`.
 */
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Agent } from "@pim/v2-app/agents";
import type { App } from "@pim/v2-app/app";
import { bytesOf, sizeOfFile } from "@pim/v2-app/app-files";
import type { Principal } from "@pim/v2-contracts/identity";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { rosterOf } from "./agent-team-tools.ts";
import { askFirst, recordResult } from "./tool-approval.ts";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
type Define = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => ToolRegistration;

const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

/**
 * Who writes a skill and for whom, as v1 decided it: an agent at work on a task writes none; an agent writes its own skills, and only the majordomo another agent's; each agent has a switch for skills
 * in Tool permissions; and a write changes only a skill on the list of the agent it is for, never one another agent lists, or one of the person's that is not on its list.
 */
export async function resolveWriter(deps: { ownerId: string; runtime: RuntimeDb }, app: App, call: Call, name: string, forAgent: string | undefined): Promise<{ error: Result } | { by: { id: string; name: string } | undefined; target: Agent | undefined; existing: { version: number } | undefined }> {
	const { ownerId, runtime } = deps;
	const refuse = (message: string) => ({ error: text(message, true) });
	if (call.p.kind === "delegated") return refuse("An agent at work on a task writes no skills: only an agent in its chat with the person does.");
	const roster = await rosterOf(runtime, ownerId, call.chat);
	const by = roster.agents.find((x) => x.id === roster.self);
	const forId = forAgent ?? roster.self;
	// An agent's switch for skills, in Tool permissions: off, its chats write none, and the majordomo writes none for it.
	const switchedOff = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT 1 FROM pim_app.tool_permissions WHERE audience = ANY($1) AND app = '' AND tool = 'write_skill' AND permission = 'off'", [[roster.self, forId].filter(Boolean).map((id) => `agent:${id}`)])).rowCount);
	if (switchedOff) return refuse("The person turned skills off for this agent, so no skill is written.");
	const agents = await app.agents.list(call.p);
	// A space with no agent of its own to give the skill to keeps it among the person's skills, unlisted.
	const target = forId ? agents.find((x) => x.id === forId) : undefined;
	if (forId && !target) return refuse(`The person has no agent with the id ${forId}. Use an id from your_agents.`);
	if (target && target.id !== roster.self && !roster.majordomo) return refuse("Only the person's majordomo writes skills for their other agents.");
	// What the write would change for others, said before anyone is asked: a skill another agent lists, or one of the person's own that is not on this agent's list.
	const others = agents.filter((x) => x.id !== target?.id && x.skills.includes(name));
	if (others.length > 0) {
		const whose = others.map((x) => x.name).join(", ");
		return refuse(target?.skills.includes(name)
			? `${name} is one of ${whose}'s skills too, and a write would change it for them as well, so nothing is written. The person can take it off the others on the skill's page first.`
			: `${name} is one of ${whose}'s skills${target ? `, not ${target.name}'s, so it isn't written for ${target.name}` : ""}: give this one another name.`);
	}
	const existing = await app.agents.getSkill(call.p, name).catch(() => undefined);
	if (existing && target && !target.skills.includes(name)) return refuse(`The person has a skill named ${name} that isn't one of ${target.name}'s: give this one another name, or ask the person to give that one to ${target.name} first.`);
	return { by, target, existing: existing && { version: existing.version } };
}

/** What a filed approval of this call was shown, for checking again what was approved when the person has decided. */
export async function filedArgs(app: App, ownerId: string, action: string, call: { api: { taskId: unknown; callId: unknown } }): Promise<Record<string, any> | undefined> {
	return (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT args FROM pim_app.approvals WHERE tool = $1 AND args->>'taskId' = $2 AND args->>'callId' = $3 ORDER BY id DESC LIMIT 1", [action, String(call.api.taskId), String(call.api.callId)])).rows[0]?.args)) as Record<string, any> | undefined;
}

export const sha256 = (value: string) => createHash("sha256").update(bytesOf(value)).digest("hex");

export function skillTools(deps: { ownerId: string; runtime: RuntimeDb; read: Define; /** Copies the person's files by path, as a skill keeps them: text as text, bytes as `pim-binary:` (`app-from-files.ts`). */ copy: (app: App, call: Call, list: { path: string; from_file: string }[]) => Promise<Record<string, string>> }): ToolRegistration[] {
	// A tool that waits for a person's approval is parked and run again when they decide, so it is one that may be run again: `read` defines such tools.
	const { ownerId, runtime, read } = deps;
	const S = Type.String;
	const O = Type.Optional;
	return [
		read("write_skill", "Save how to do something as one of your skills, so the work is done the same way next time, or rewrite one. Do it when the person asks you to remember how they want something done, or once you have worked out with them a task they'll ask for again. The person approves it first. To rewrite a skill, load it with read_skill first and give its version as base_version with the complete new instructions. Only the person's majordomo can give agent, to write a skill for another of their agents.", Type.Object({
			name: S({ description: "Lowercase letters, digits and hyphens, such as weekly-report." }),
			description: O(S({ maxLength: 1024, description: "What it does and when to use it, in a sentence or two: all an agent sees of it until it loads it." })),
			body: O(S({ description: "The whole procedure in Markdown, for an agent that knows nothing else about it: the steps, the connectors and tools to use, what to check, and what the result looks like. A rewrite replaces all of it." })),
			files: O(Type.Record(S(), S(), { description: "Supporting files the instructions point to, by path relative to the skill, such as references/guide.md. Every file the skill should have (with copy_files); leave out to keep the ones it has." })),
			copy_files: O(Type.Array(Type.Object({ path: S({ description: "Relative to the skill, such as templates/report.docx." }), from_file: S({ description: "A path in the person's files, such as /workspace/templates/report.docx, to copy: for a file that isn't text, or that is there already." }) }), { maxItems: 50, description: "Supporting files copied from the person's files, each shown to the person with its SHA-256 and saved only if still the same when they approve." })),
			base_version: O(Type.Integer({ minimum: 1, description: "To rewrite an existing skill: its version, as read_skill gave it." })),
			agent: O(S({ description: "The id of another of the person's agents to give the skill to instead, from your_agents. Only their majordomo writes skills for other agents." })),
		}), async (app, call, a) => {
			const who = await resolveWriter(deps, app, call, a.name, a.agent);
			if ("error" in who) return who.error;
			const { by, target, existing } = who;
			if (existing && a.base_version === undefined) return text(`A skill named ${a.name} exists already: read it, then give its version as base_version to rewrite it`, true);
			if (!existing && a.base_version !== undefined) return text(`No skill named ${a.name}`, true);
			if (existing && a.base_version !== existing.version) return text(`${a.name} is at version ${existing.version} now, not ${a.base_version}: read it again before rewriting it`, true);
			if (!existing && !a.body) return text("Give the skill's instructions as body.", true);
			// The person's files to copy, read as they are now: each copy is shown with its hash, and saved only as it was shown.
			const given: { path: string; from_file: string }[] = a.copy_files ?? [];
			let copied: Record<string, string> = {};
			if (given.length > 0) {
				if (given.some((c) => (a.files ?? {})[c.path] !== undefined) || new Set(given.map((c) => c.path)).size !== given.length) return text("A file is given twice: each path of files and copy_files is one file of the skill.", true);
				try {
					copied = await deps.copy(app, call, given);
				} catch (error) {
					return text(`Not copied: ${error instanceof Error ? error.message : String(error)}`, true);
				}
			}
			const copies = given.map((c) => ({ path: c.path, from_file: c.from_file, sha256: sha256(copied[c.path]!), size: sizeOfFile(copied[c.path]!) }));
			const forWhom = target?.name ?? "the person";
			const summary = existing ? `${by && target && by.id !== target.id ? `${by.name} rewrites ${forWhom}'s skill` : `${forWhom} rewrites the skill`} ${a.name}` : `${by && target && by.id !== target.id ? `${by.name} saves a new skill for ${forWhom}` : `${by?.name ?? "An agent"} saves a new skill`}: ${a.name}`;
			const shown = copies.length ? `${summary}, with ${copies.length} file${copies.length === 1 ? "" : "s"} copied from the person's own (${copies.slice(0, 6).map((c) => `${c.from_file} sha256 ${c.sha256.slice(0, 12)}`).join(", ")}${copies.length > 6 ? ", …" : ""})` : summary;
			const waiting = await askFirst({ app, runtime, ownerId }, call, { action: "skill:write", tool: "write_skill", resource: { skill: a.name, ...(target ? { agent: target.id } : {}) }, summary: shown, args: { name: a.name, ...(target ? { agent: target.id } : {}), description: a.description, instructions: a.body, files: a.files, ...(copies.length ? { copies } : {}), ...(a.base_version === undefined ? {} : { base_version: a.base_version }) }, denied: "The person did not approve this skill, so it was not saved." });
			if (waiting) return waiting;
			// What was approved is what is saved: a copy that changed since the person was shown it is not made.
			const shownCopies = ((await filedArgs(app, ownerId, "skill:write", call))?.copies ?? []) as { path: string; from_file: string; sha256: string }[];
			const changed = shownCopies.find((c) => copies.find((now) => now.path === c.path)?.sha256 !== c.sha256);
			if (changed) return text(`${changed.from_file} changed after the person approved copying it, so nothing was copied: ask again`, true);
			const files = given.length > 0 || a.files !== undefined ? { ...(a.files ?? {}), ...copied } : undefined;
			// Written to the skill as it is when the person has approved, which must still be the version they were shown.
			const saved = existing
				? await app.agents.updateSkill(call.p, a.name, { description: a.description, body: a.body, files, baseVersion: a.base_version })
				: await app.agents.createSkill(call.p, { name: a.name, description: a.description, body: a.body, files });
			if (target && !target.skills.includes(a.name)) await app.agents.update(call.p, target.id, { skills: [...target.skills, a.name] });
			const done = `Saved the skill ${a.name}, version ${saved.version}${target ? `, one of ${target.name}'s skills. It applies from its next step` : ""}.`;
			await recordResult(app, ownerId, "skill:write", String(call.api.taskId), done);
			return text(done);
		}),
	];
}
