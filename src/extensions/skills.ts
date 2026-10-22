import { type Static, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { type AgentStore, agentInput } from "../agents";
import { sha256 } from "../artifacts";
import type { Files } from "../files";
import { HttpError } from "../http";
import { readUrl, skillFromFolder, skillFromGitHub } from "../skill-sources";
import { MAX_SKILL_DESCRIPTION, MAX_SKILL_FILE_CHARS, MAX_SKILL_FILES, MAX_SKILL_INSTRUCTIONS, type SkillFileContent, type SkillStore } from "../skills";
import type { Role } from "../tasks";
import { approvalNote, defineGatedAction, fileApproval, type GatedAction, ownToolPermission } from "./approvals";
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
 * `install_skill` installs a skill someone published (../skill-sources.ts)
 * through the same request: its instructions as written there, and its
 * files as copies from the person's files or from GitHub.
 */

export const WRITE_SKILL = "write_skill";
export const INSTALL_SKILL = "install_skill";

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
	base_version: Type.Optional(Type.Integer({ minimum: 1, description: "To rewrite an existing skill: its version, as read_skill gave it." })),
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

/** The approved write of a skill, made to the skill as it is then, and added to the agent that wrote it. */
export function writeSkillAction(skills: SkillStore, agents: Pick<AgentStore, "get" | "update">, copies: Pick<Files, "bytes">): GatedAction {
	return defineGatedAction({
		name: WRITE_SKILL,
		description: "An agent saves a skill, or rewrites one: instructions for work it does again, which the person's agents follow.",
		// Filed by the tool, which names the chat's agent.
		internal: true,
		parameters: Type.Object({ agent: Type.String(), ...Write.properties, files: Type.Optional(Type.Array(FileArg)), source: Type.Optional(Type.String()) }),
		summarize: ({ name }) => `Save the skill ${name}`,
		async run({ agent: id, name, description, instructions, files: given, base_version, source }) {
			try {
				const agent = agents.get(id);
				// A copy is saved only as the person approved it: one without the hash they saw is refused too.
				if (given?.some((file) => file.content === undefined && file.sha256 === undefined)) throw new HttpError(400, "A copied file needs the hash the person approved");
				const files = given && (await readCopies(copies, given)).contents;
				const skill = await skills.write({ name, description, instructions, files, baseVersion: base_version, author: agent?.name, source });
				if (agent && !agent.skills.includes(name)) agents.update(id, agentInput({ skills: [...agent.skills, name] }, agent));
				return `Saved the skill ${name}, version ${skill.version}${agent ? `, one of ${agent.name}'s skills` : ""}. It applies from the next step.`;
			} catch (error) {
				return `The skill was not saved: ${failure(error)}`;
			}
		},
	}) as GatedAction;
}

/** What a script or other file in a skill is for, where the person has a computer: the agent saves it there and uses it with `shell`. */
const SCRIPTS =
	"A skill can carry scripts and other files, such as templates: an agent that needs one saves it to the person's files with read_skill_file's save_to and runs it on their computer with shell.";

/** `canRunCode`: the person has a computer, where `shell` runs the scripts skills carry. */
export function skillsExtension(services: PimServices, roleOf: (session: string) => Role, skills: SkillStore, files: Pick<Files, "bytes" | "list">, canRunCode: boolean) {
	const permission = () => ownToolPermission(services.store, WRITE_SKILL).permission;

	const writeSkill = defineTool({
		name: WRITE_SKILL,
		description: `Save how to do something as one of your skills, so the work is done the same way next time, or rewrite one. Do it when the person asks you to remember how they want something done, or once you have worked out with them a task they'll ask for again. To rewrite a skill, load it with read_skill first and give its version as base_version with the complete new instructions.${canRunCode ? ` ${SCRIPTS}` : ""}${permission() === "ask" ? ` ${approvalNote(services)}` : ""}`,
		parameters: Write,
		replay: "safe",
		async execute(write: Write, api, context) {
			const { agent } = roleOf(String(api.conversationId));
			let summary: string;
			let args: FileArg[] | undefined;
			try {
				const copies = write.files && (await readCopies(files, write.files));
				args = copies?.args;
				await skills.check({ ...write, files: copies?.contents, baseVersion: write.base_version });
				// Checked now so a request the person would approve in vain is never filed.
				if (!agent.skills.includes(write.name)) agentInput({ skills: [...agent.skills, write.name] }, agent);
				summary = write.base_version === undefined ? `${agent.name} saves a new skill: ${write.name}` : `${agent.name} rewrites the skill ${write.name}`;
			} catch (error) {
				return text(failure(error), true);
			}
			summary = await api.memo(WRITE_SKILL, summary, context);
			return fileApproval(services, api, context, { action: WRITE_SKILL, tool: WRITE_SKILL, args: { agent: agent.id, ...write, ...(args ? { files: args } : {}) }, summary });
		},
	});

	const installSkill = defineTool({
		name: INSTALL_SKILL,
		description: `Install a skill someone published, as one of your skills, when the person asks for it: a folder in the Agent Skills format, with a SKILL.md, on GitHub or in the person's files. It is saved as its source has it, its instructions and files exactly, once the person approves. To update one of your skills from its source, give its version as base_version.${permission() === "ask" ? ` ${approvalNote(services)}` : ""}`,
		parameters: Type.Object({
			source: Type.String({
				description:
					"The skill's folder on GitHub, such as https://github.com/owner/repo/tree/main/skills/name (or a repository with SKILL.md at its root), or in the person's files, such as /workspace/skills/name.",
			}),
			base_version: Type.Optional(Type.Integer({ minimum: 1, description: "To update one of your skills: its version, as read_skill gave it." })),
		}),
		replay: "safe",
		async execute({ source, base_version }, api, context) {
			const { agent } = roleOf(String(api.conversationId));
			let summary: string;
			let args: Record<string, unknown>;
			try {
				const found = source.startsWith("/") ? await skillFromFolder(files, source) : await skillFromGitHub(source);
				const copies = await readCopies(files, found.files);
				const { name, description, instructions } = found;
				await skills.check({ name, description, instructions, files: copies.contents, baseVersion: base_version });
				if (!agent.skills.includes(name)) agentInput({ skills: [...agent.skills, name] }, agent);
				summary = `${agent.name} ${base_version === undefined ? "installs" : "updates"} the skill ${name} from ${found.source}`;
				args = { agent: agent.id, name, description, instructions, files: copies.args, source: found.source, ...(base_version === undefined ? {} : { base_version }) };
			} catch (error) {
				return text(failure(error), true);
			}
			summary = await api.memo(INSTALL_SKILL, summary, context);
			return fileApproval(services, api, context, { action: WRITE_SKILL, tool: WRITE_SKILL, args, summary });
		},
	});

	return defineExtension({
		name: "pim.skills",
		sections: [
			// Rendered at each request, so a chat sees a skill from the step after it is saved.
			section("your_skills", ({ conversationId }) => {
				const { agent, from } = roleOf(String(conversationId));
				const all = new Map(skills.list().map((skill) => [skill.name, skill]));
				const mine = agent.skills.flatMap((name) => all.get(name) ?? []);
				// Only in a chat: in a task, an agent works for another and writes none.
				const writes = from === null && permission() !== "off";
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
