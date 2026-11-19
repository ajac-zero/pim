/**
 * Skills a connected MCP server publishes over the MCP Skills extension (`io.modelcontextprotocol/skills`), as v1 read them (`src/extensions/app-skills.ts`, `app-catalog.ts`). The prompt lists each
 * connector's skills by name and description; an agent loads one with `read_skill` (naming the connector) and its supporting files with `read_skill_file`. Every file is checked against the digest
 * and size in the connector's manifest, and where it came from is said wherever it enters the model's context: a connector's skill is as untrusted as its instructions.
 */
import { type Transport, withSession } from "./connector-tools.ts";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
export type SkillFile = { uri: string; digest: string; size: number };
export type ConnectorSkill = {
	/** The URI of its `SKILL.md`; with the connector, the skill's identity. */
	uri: string;
	name: string;
	description: string;
	/** The manifest of every file with its digest, or "dynamic" when the connector cannot publish one. */
	files: SkillFile[] | "dynamic";
};

/** How long a listing is kept when the connector gives no TTL, and the longest any is kept. */
export const DEFAULT_TTL_MS = 3_600_000;
const MAX_TTL_MS = 86_400_000;
const MAX_PAGES = 10;
const MAX_SKILL_CHARS = 50_000;

const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** A skills/list entry, or undefined when it does not follow the extension. */
export function parseSkill(value: unknown): ConnectorSkill | undefined {
	const entry = record(value);
	const frontmatter = record(entry?.frontmatter);
	if (!entry || !frontmatter || typeof entry.uri !== "string") return undefined;
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
	let files: SkillFile[] | "dynamic";
	if (entry.resources === "dynamic") files = "dynamic";
	else if (Array.isArray(entry.resources)) {
		files = [];
		for (const file of entry.resources) {
			const item = record(file);
			if (!item || typeof item.uri !== "string" || typeof item.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.digest) || typeof item.size !== "number") return undefined;
			files.push({ uri: item.uri, digest: item.digest, size: item.size });
		}
	} else return undefined;
	return { uri: entry.uri, name: frontmatter.name, description: frontmatter.description, files };
}

/** The skills a server lists, and how long to keep them; none for a server that does not declare the extension. */
export async function listSkills(transport: Transport, url: string, bearer: string | null): Promise<{ skills: ConnectorSkill[]; ttlMs: number }> {
	return withSession(transport, url, bearer, async (rpc, capabilities) => {
		if (record(record(capabilities)?.extensions)?.[SKILLS_EXTENSION] === undefined) return { skills: [], ttlMs: DEFAULT_TTL_MS };
		const skills: ConnectorSkill[] = [];
		let cursor: string | undefined;
		let ttlMs: number | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const result = record(await rpc("skills/list", cursor ? { cursor } : {}));
			if (Array.isArray(result?.skills)) {
				for (const item of result.skills) {
					const skill = parseSkill(item);
					if (skill) skills.push(skill);
				}
			}
			// The shortest TTL of any page bounds the whole listing.
			if (typeof result?.ttlMs === "number" && result.ttlMs > 0) ttlMs = Math.min(ttlMs ?? result.ttlMs, result.ttlMs);
			if (typeof result?.nextCursor !== "string" || result.nextCursor === "") break;
			cursor = result.nextCursor;
		}
		return { skills, ttlMs: Math.min(ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS) };
	});
}

/** The `name` in a SKILL.md's YAML frontmatter. */
export function frontmatterName(markdown: string): string | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
	const line = match?.[1]?.split(/\r?\n/).find((candidate) => /^name\s*:/.test(candidate));
	return line?.replace(/^name\s*:\s*/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
}

/** The directory a skill's files live under: its SKILL.md URI without the file name. */
export const skillRoot = (skill: ConnectorSkill) => skill.uri.slice(0, skill.uri.length - "SKILL.md".length);

/** A supporting file's URI from its path relative to the skill, refusing paths that leave the skill. */
export function fileUri(skill: ConnectorSkill, path: string): string | undefined {
	const parts = path.replace(/^\.\//, "").split("/");
	if (path.startsWith("/") || parts.some((part) => part === ".." || part === "")) return undefined;
	return `${skillRoot(skill)}${parts.join("/")}`;
}

/** What failed the check of a skill against what its connector published: the connector may have updated it since its listing was read. */
export class VerificationError extends Error {}

type Content = { uri?: string; mimeType?: string; text?: string; blob?: string };

const bytesOf = (content: Content): Uint8Array => (content.text !== undefined ? new TextEncoder().encode(content.text) : content.blob !== undefined ? Uint8Array.from(Buffer.from(content.blob, "base64")) : new Uint8Array());

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Reads one file of a skill and checks it against the skill's manifest. */
export async function readSkillResource(read: (uri: string) => Promise<{ contents?: Content[] }>, skill: ConnectorSkill, uri: string): Promise<{ content: Content; bytes: Uint8Array }> {
	const declared = skill.files === "dynamic" ? undefined : skill.files.find((file) => file.uri === uri);
	if (skill.files !== "dynamic" && !declared) throw new VerificationError(`${uri} is not part of this skill.`);
	const result = await read(uri);
	const content = result.contents?.find((candidate) => candidate.uri === uri) ?? result.contents?.[0];
	if (!content) throw new VerificationError(`The connector returned nothing for ${uri}.`);
	const bytes = bytesOf(content);
	if (declared && (bytes.length !== declared.size || (await sha256(bytes)) !== declared.digest)) throw new VerificationError(`${uri} does not match the digest the connector published for it.`);
	return { content, bytes };
}

export function clip(value: string): string {
	return value.length > MAX_SKILL_CHARS ? `${value.slice(0, MAX_SKILL_CHARS)}\n[... ${value.length - MAX_SKILL_CHARS} more characters]` : value;
}

/** The skills of a connector as its prompt lists them. */
export const skillLines = (name: string, skills: readonly ConnectorSkill[]): string[] =>
	skills.length === 0 ? [] : [`Skills from ${name} (load with read_skill, naming the connector):`, ...skills.map((skill) => `- ${skill.name}: ${skill.description.length > 300 ? `${skill.description.slice(0, 300)}…` : skill.description}`)];
