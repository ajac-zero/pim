import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { type Agent, type AgentStore, agentInput, agentLabel } from "../agents";
import { sha256 } from "../artifacts";
import type { Files } from "../files";
import { HttpError } from "../http";
import { readUrl, skillFromFolder, skillFromGitHub } from "../skill-sources";
import { MAX_SKILL_DESCRIPTION, MAX_SKILL_FILE_CHARS, MAX_SKILL_FILES, MAX_SKILL_INSTRUCTIONS, SKILL_NAME, type SkillFileContent, type SkillStore } from "../skills";
import type { PimStore } from "../store";
import type { Role } from "../tasks";
import { approvalNote, defineGatedAction, fileApproval, type GatedAction, ownToolPermission, type ResolvedPermission, resolvePermission } from "./approvals";
import { agentAudience } from "./mcp";
import { type PimServices, text } from "./services";

/**
 * The person's own skills in their agents' chats: the `your_skills` section
 * lists the chat's agent's skills, `read_skill` loads one (./app-skills.ts),
 * and `write_skill` saves a new one or rewrites one once the person approves,
 * since a skill steers every later run that loads it.
 *
 * A supporting file is text the agent writes, or a copy of one of the
 * person's files (`from_file`), such as a template or a font. A copy is
 * read when the agent asks, and the request names its SHA-256; when it is
 * approved, the file is read again and saved only if it is still the same,
 * so what is saved is what the person approved.
 *
 * `write_skill` with `from`, or `install_skill`, installs a skill someone
 * published (../skill-sources.ts) through the same request: its
 * instructions as written there, and its files as copies from the person's
 * files or from GitHub.
 *
 * Who may write which skill: an agent writes only its own skills, and the
 * majordomo also those of the person's other agents (`agent`). Each agent
 * has a switch for skills (`skillsSwitch`), on unless the person turned it
 * off: off, its chats aren't offered these tools and no agent, the majordomo
 * included, writes skills for it. Only the person flips it. Skills are the
 * person's, by name, and an agent uses those on its list: a write changes
 * only a skill on the list of the agent it is for and on no other agent's,
 * so no agent changes a skill another agent uses, or one it merely guessed
 * the name of. All of it is checked when the agent asks and again, as things
 * are then, when the request is approved.
 */

export const WRITE_SKILL = "write_skill";
export const INSTALL_SKILL = "install_skill";

const SOURCE =
	"The skill's folder on GitHub, such as https://github.com/owner/repo/tree/main/skills/name (or a repository with SKILL.md at its root), or in the person's files, such as /workspace/skills/name.";
const FOR_AGENT = Type.Optional(
	Type.String({
		description: "The id of another of the person's agents to give the skill to instead, from your_agents. Only their majordomo writes skills for other agents.",
	}),
);

const Write = Type.Object({
	name: Type.Optional(Type.String({ description: "Lowercase letters, digits and hyphens, such as weekly-report." })),
	description: Type.Optional(
		Type.String({
			maxLength: MAX_SKILL_DESCRIPTION,
			description: "What it does and when to use it, in a sentence or two: all an agent sees of it until it loads it.",
		}),
	),
	instructions: Type.Optional(
		Type.String({
			maxLength: MAX_SKILL_INSTRUCTIONS,
			description:
				"The whole procedure in Markdown, for an agent that knows nothing else about it: the steps, the apps and tools to use, what to check, and what the result looks like. A rewrite replaces all of it.",
		}),
	),
	files: Type.Optional(
		Type.Array(
			Type.Object({
				path: Type.String({ description: "Relative to the skill, such as references/guide.md or scripts/convert.js." }),
				content: Type.Optional(Type.String({ maxLength: MAX_SKILL_FILE_CHARS, description: "The file's text." })),
				from_file: Type.Optional(
					Type.String({ description: "Instead of content: a path in the person's files, such as /workspace/templates/report.docx, to copy, for a file that isn't text or that is there already." }),
				),
			}),
			{
				maxItems: MAX_SKILL_FILES,
				description:
					"Supporting files the instructions point to, such as references, templates and scripts, each with content or from_file. Every file the skill should have; leave out to keep the ones it has.",
			},
		),
	),
	from: Type.Optional(
		Type.String({
			description: `Instead of name, description, instructions and files: a skill someone published, to install as its source has it. ${SOURCE}`,
		}),
	),
	base_version: Type.Optional(Type.Integer({ minimum: 1, description: "To rewrite or update an existing skill: its version, as read_skill gave it." })),
	agent: FOR_AGENT,
});
type Write = Static<typeof Write>;

/** A supporting file as the approval request has it: a copy names the hash of what the person approved. */
const FileArg = Type.Object({
	path: Type.String(),
	content: Type.Optional(Type.String()),
	from_file: Type.Optional(Type.String()),
	from_url: Type.Optional(Type.String()),
	sha256: Type.Optional(Type.String()),
	size: Type.Optional(Type.Integer()),
});
type FileArg = Static<typeof FileArg>;

/** Reads a write's copies, of the person's files or of files on GitHub: each file's content, and the request's account of it. */
async function readCopies(files: Pick<Files, "bytes">, given: readonly FileArg[]): Promise<{ contents: SkillFileContent[]; args: FileArg[] }> {
	const read = await Promise.all(
		given.map(async (file) => {
			if ([file.content, file.from_file, file.from_url].filter((source) => source !== undefined).length !== 1) {
				throw new HttpError(400, `${file.path}: give either content or from_file`);
			}
			if (file.content !== undefined) return { content: { path: file.path, content: file.content }, arg: { path: file.path, content: file.content } };
			const from = file.from_file === undefined ? { from_url: file.from_url! } : { from_file: file.from_file };
			const bytes = from.from_file === undefined ? await readUrl(from.from_url!) : await files.bytes(from.from_file);
			const hash = await sha256(bytes);
			if (file.sha256 !== undefined && file.sha256 !== hash) {
				throw new HttpError(409, `${from.from_file ?? from.from_url} changed after the person approved copying it, so nothing was copied: ask again`);
			}
			return { content: { path: file.path, content: bytes }, arg: { path: file.path, ...from, sha256: hash, size: bytes.byteLength } };
		}),
	);
	return { contents: read.map((file) => file.content), args: read.map((file) => file.arg) };
}

const failure = (error: unknown) => {
	if (error instanceof HttpError) return error.message;
	throw error;
};

/**
 * An agent's switch for skills: on, it writes and installs skills, and the
 * majordomo may for it; off, no agent changes its skills. On unless the
 * person turned it off, as agents wrote skills before there were switches.
 * Kept with its app tools' switches (`agent:<id>`), and only the person sets it.
 */
export function skillsSwitch(store: PimStore, agent: string): ResolvedPermission {
	return resolvePermission(store, agentAudience(agent), "", WRITE_SKILL, "on", null);
}

/** What deciding who writes a skill reads, as it is at the moment. */
export type SkillWriters = {
	readonly agents: Pick<AgentStore, "get" | "list" | "update">;
	readonly store: PimStore;
	readonly skills: Pick<SkillStore, "has">;
	roleOf(session: string): Role;
};

/**
 * The agent writing a skill (`by`, the conversation's own) and the agent it
 * is for, as they are now; throws what is refused: skills turned off for
 * every agent or for either of them, a task's conversation, an agent that no
 * longer exists, or another's skills written by any agent but the majordomo.
 */
function writersOf(writers: SkillWriters, session: string, byId: string, forId: string): { by: Agent; target: Agent } {
	if (ownToolPermission(writers.store, WRITE_SKILL).permission === "off") throw new HttpError(403, "The person turned off write_skill, so no agent writes or installs skills.");
	const role = writers.roleOf(session);
	// A task's tools leave out write_skill: an agent working for another writes none, whatever it is asked.
	if (role.from !== null) throw new HttpError(403, "An agent at work on a task writes no skills: only an agent in its chat with the person does.");
	const by = writers.agents.get(byId);
	if (!by || role.agent.id !== by.id) throw new HttpError(404, "The agent that asked for this skill no longer exists, so nothing was saved.");
	const target = writers.agents.get(forId);
	if (!target) throw new HttpError(404, `The person has no agent with the id ${forId}. Use an id from your_agents.`);
	if (target.id !== by.id && !by.majordomo) throw new HttpError(403, "Only the person's majordomo writes skills for their other agents.");
	for (const agent of by.id === target.id ? [by] : [by, target]) {
		if (skillsSwitch(writers.store, agent.id).permission === "off") {
			throw new HttpError(403, `The person turned off skills for ${agent.name}. Only they can turn them on again, on its page in Agents.`);
		}
	}
	return { by, target };
}

/**
 * Refuses a skill name the agent a write is for doesn't control: one another
 * agent lists, which the write would change for it too, or one of the
 * person's skills not on its own list. The author's name recorded with a
 * version decides nothing.
 */
function checkName(writers: SkillWriters, target: Agent, name: string): void {
	const others = writers.agents.list().filter((agent) => agent.id !== target.id && agent.skills.includes(name));
	if (others.length > 0) {
		const whose = others.map((agent) => agent.name).join(", ");
		throw new HttpError(
			409,
			target.skills.includes(name)
				? `${name} is one of ${whose}'s skills too, and a write would change it for them as well, so nothing is written. The person can take it off the others on the skill's page first.`
				: `${name} is one of ${whose}'s skills, not ${target.name}'s, so it isn't written for ${target.name}: give this one another name.`,
		);
	}
	// A name no skill can have is refused by the store, as any write's is.
	if (target.skills.includes(name) || !SKILL_NAME.test(name)) return;
	if (writers.skills.has(name)) {
		throw new HttpError(409, `The person has a skill named ${name} that isn't one of ${target.name}'s: give this one another name, or ask the person to give that one to ${target.name} first.`);
	}
	// Room on its list, checked before anything is written.
	agentInput({ skills: [...target.skills, name] }, target);
}

/** What the person reads to decide. */
function summarize(by: Agent, target: Agent, name: string, rewrite: boolean, source: string | undefined): string {
	if (by.id === target.id) {
		if (source !== undefined) return `${by.name} ${rewrite ? "updates" : "installs"} the skill ${name} from ${source}`;
		return rewrite ? `${by.name} rewrites the skill ${name}` : `${by.name} saves a new skill: ${name}`;
	}
	const [who, whom] = [agentLabel(by), agentLabel(target)];
	if (source !== undefined) return rewrite ? `${who} updates ${whom}'s skill ${name} from ${source}` : `${who} installs the skill ${name} for ${whom} from ${source}`;
	return rewrite ? `${who} rewrites ${whom}'s skill ${name}` : `${who} saves a new skill for ${whom}: ${name}`;
}

/** The approved write of a skill, made to the skill as it is then, and added to the agent it is for. */
export function writeSkillAction(skills: SkillStore, writers: SkillWriters, copies: Pick<Files, "bytes">): GatedAction {
	return defineGatedAction({
		name: WRITE_SKILL,
		description: "An agent saves a skill, or rewrites one: instructions for work it does again, which the person's agents follow.",
		// Filed by the tool, which names the agent asking (`by`) and the agent the skill is for.
		internal: true,
		parameters: Type.Object({
			// Requests filed before agents wrote skills for others name only the agent, which asked for itself.
			by: Type.Optional(Type.String()),
			agent: Type.String(),
			name: Type.String(),
			description: Type.String(),
			instructions: Type.String(),
			files: Type.Optional(Type.Array(FileArg)),
			base_version: Type.Optional(Type.Integer()),
			source: Type.Optional(Type.String()),
		}),
		summarize: ({ name }) => `Save the skill ${name}`,
		async run({ by: byId, agent: id, name, description, instructions, files: given, base_version, source }, { session }) {
			try {
				const check = () => {
					const found = writersOf(writers, session, byId ?? id, id);
					checkName(writers, found.target, name);
					return found;
				};
				const { by } = check();
				// A copy is saved only as the person approved it: one without the hash they saw is refused too.
				if (given?.some((file) => file.content === undefined && file.sha256 === undefined)) throw new HttpError(400, "A copied file needs the hash the person approved");
				const files = given && (await readCopies(copies, given)).contents;
				// Checked again as it is written, after the copies are read.
				const skill = await skills.write({ name, description, instructions, files, baseVersion: base_version, author: by.name, source }, () => void check());
				const target = writers.agents.get(id);
				if (!target) return `Saved the skill ${name}, version ${skill.version}.`;
				if (!target.skills.includes(name)) writers.agents.update(id, agentInput({ skills: [...target.skills, name] }, target));
				return `Saved the skill ${name}, version ${skill.version}, one of ${target.name}'s skills. It applies from its next step.`;
			} catch (error) {
				return `The skill was not saved: ${failure(error)}`;
			}
		},
	}) as GatedAction;
}

/** What a skill is written from: the agent's own words, or a published skill's source, with its files' contents. */
type Draft = {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly files?: FileArg[];
	readonly contents?: SkillFileContent[];
	readonly source?: string;
};

/** A filed request, kept so a call woken by the decision finds it again as it was asked, without reading its sources again. */
const FILED = "write_skill_request";
type Filed = { readonly summary: string; readonly args: Record<string, string | number | FileArg[]> };

/** What a script or other file in a skill is for, where the person has a computer: the agent saves it there and uses it with `shell`. */
const SCRIPTS =
	"A skill can carry scripts and other files, such as templates: an agent that needs one saves it to the person's files with read_skill_file's save_to and runs it on their computer with shell.";

/** `canRunCode`: the person has a computer, where `shell` runs the scripts skills carry. */
export function skillsExtension(services: PimServices, writers: SkillWriters, skills: SkillStore, files: Pick<Files, "bytes" | "list">, canRunCode: boolean) {
	const permission = () => ownToolPermission(services.store, WRITE_SKILL).permission;

	/** A published skill as its source has it, with its files read and hashed. */
	const published = async (source: string): Promise<Draft> => {
		const found = source.startsWith("/") ? await skillFromFolder(files, source) : await skillFromGitHub(source);
		const copies = await readCopies(files, found.files);
		const { name, description, instructions } = found;
		return { name, description, instructions, files: copies.args, contents: copies.contents, source: found.source };
	};

	/**
	 * Checks a write as the agent asks for it and files the request: who
	 * writes it, and for whom, before anything is read; then the skill.
	 */
	const request = async (
		api: ToolExecutionApi,
		context: Context,
		wanted: { agent?: string; base_version?: number },
		draft: () => Promise<Draft>,
	) => {
		const session = String(api.conversationId);
		let filed = await api.memo<Filed>(FILED, context);
		if (filed === undefined) {
			try {
				const self = writers.roleOf(session).agent;
				const { by, target } = writersOf(writers, session, self.id, wanted.agent ?? self.id);
				const { contents, ...write } = await draft();
				checkName(writers, target, write.name);
				await skills.check({ ...write, files: contents, baseVersion: wanted.base_version });
				const summary = summarize(by, target, write.name, wanted.base_version !== undefined, write.source);
				const args = {
					by: by.id,
					agent: target.id,
					...Object.fromEntries(Object.entries(write).filter(([, value]) => value !== undefined)),
					...(wanted.base_version === undefined ? {} : { base_version: wanted.base_version }),
				};
				filed = await api.memo<Filed>(FILED, { summary, args }, context);
			} catch (error) {
				return text(failure(error), true);
			}
		}
		return fileApproval(services, api, context, { action: WRITE_SKILL, tool: WRITE_SKILL, args: filed.args, summary: filed.summary });
	};

	const install = (source: string, wanted: { agent?: string; base_version?: number }, api: ToolExecutionApi, context: Context) =>
		request(api, context, wanted, () => published(source));

	const asks = () => (permission() === "ask" ? ` ${approvalNote(services)}` : "");

	const writeSkill = defineTool({
		name: WRITE_SKILL,
		description: `Save how to do something as one of your skills, so the work is done the same way next time, or rewrite one. Do it when the person asks you to remember how they want something done, or once you have worked out with them a task they'll ask for again. To rewrite a skill, load it with read_skill first and give its version as base_version with the complete new instructions. To install a skill someone published instead, give only from (with base_version to update one from its source). Only the person's majordomo can give agent, to write a skill for another of their agents.${canRunCode ? ` ${SCRIPTS}` : ""}${asks()}`,
		parameters: Write,
		replay: "safe",
		async execute({ from, agent, base_version, ...authored }: Write, api, context) {
			const wanted = { agent, base_version };
			const given = Object.entries(authored).flatMap(([field, value]) => (value === undefined ? [] : [field]));
			if (from !== undefined) {
				if (given.length > 0) {
					return text(`Give either from, to install a published skill as its source has it, or name, description, instructions and files, to write one, not both: ${given.join(", ")} came with from.`, true);
				}
				return install(from, wanted, api, context);
			}
			const { name, description, instructions, files: copies } = authored;
			if (name === undefined || description === undefined || instructions === undefined) {
				return text("Give name, description and instructions to write a skill, or only from to install a published one.", true);
			}
			return request(api, context, wanted, async () => {
				const read = copies && (await readCopies(files, copies));
				return { name, description, instructions, ...(read ? { files: read.args, contents: read.contents } : {}) };
			});
		},
	});

	const installSkill = defineTool({
		name: INSTALL_SKILL,
		description: `Install a skill someone published, as one of your skills, when the person asks for it: a folder in the Agent Skills format, with a SKILL.md, on GitHub or in the person's files. It is saved as its source has it, its instructions and files exactly, once the person approves. To update one of your skills from its source, give its version as base_version. The same as write_skill with from. Only the person's majordomo can give agent, to install it for another of their agents.${asks()}`,
		parameters: Type.Object({
			source: Type.String({ description: SOURCE }),
			base_version: Type.Optional(Type.Integer({ minimum: 1, description: "To update one of your skills: its version, as read_skill gave it." })),
			agent: FOR_AGENT,
		}),
		replay: "safe",
		async execute({ source, base_version, agent }, api, context) {
			return install(source, { agent, base_version }, api, context);
		},
	});

	return defineExtension({
		name: "pim.skills",
		sections: [
			// Rendered at each request, so a chat sees a skill from the step after it is saved.
			section("your_skills", ({ conversationId }) => {
				const { agent, from } = writers.roleOf(String(conversationId));
				const all = new Map(skills.list().map((skill) => [skill.name, skill]));
				const mine = agent.skills.flatMap((name) => all.get(name) ?? []);
				// Only in a chat: in a task, an agent works for another and writes none.
				const writes = from === null && permission() !== "off" && skillsSwitch(services.store, agent.id).permission !== "off";
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
		tools: permission() === "off" ? [] : [writeSkill, installSkill],
	});
}
