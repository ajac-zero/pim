/**
 * Where a skill can be installed from: a folder of a GitHub repository (`https://github.com/<owner>/<repo>/tree/<ref>/<path>`, or `<owner>/<repo>/<path>`). The folder is read at the
 * commit its ref names at that moment, and every file is fetched at that commit, so what is installed is what was read and a branch moving meanwhile changes nothing. The
 * folder holds a SKILL.md (frontmatter with a name and a description, then the instructions) and any supporting files; each file's SHA-256 is returned so that what a person
 * approved can be checked against what is installed.
 */
import { createHash } from "node:crypto";

export type SkillFolder = { source: string; commit: string; name: string; description: string; body: string; files: Record<string, string>; hashes: Record<string, string> };

const MAX_ENTRIES = 500;
const MAX_FILE = 100_000;
const MAX_TOTAL = 500_000;

export function parseSource(raw: string): { owner: string; repo: string; ref: string | undefined; path: string } {
	const text = raw.trim().replace(/\/+$/, "");
	const url = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(.*))?)?$/.exec(text);
	if (url) return { owner: url[1]!, repo: url[2]!, ref: url[3], path: (url[4] ?? "").replace(/^\/+|\/+$/g, "") };
	const short = /^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/.exec(text);
	if (short && !text.includes(":")) return { owner: short[1]!, repo: short[2]!, ref: undefined, path: short[3] ?? "" };
	throw new Error("A skill source is a GitHub folder, such as https://github.com/owner/repo/tree/main/skills/name");
}

/** The name and description of a SKILL.md's frontmatter, and the instructions after it. */
export function parseSkillFile(content: string): { name: string | undefined; description: string; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!match) return { name: undefined, description: "", body: content };
	const field = (key: string) => {
		const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(match[1]!)?.[1]?.trim();
		return line === undefined ? undefined : line.replace(/^(["'])(.*)\1$/, "$2");
	};
	return { name: field("name"), description: field("description") ?? "", body: match[2]!.replace(/^\r?\n/, "") };
}

export async function readSkillFolder(fetchFn: typeof fetch, raw: string): Promise<SkillFolder> {
	const { owner, repo, ref, path } = parseSource(raw);
	const get = async (url: string, what: string) => {
		const response = await fetchFn(url, { headers: { "user-agent": "Pim/2", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) });
		if (!response.ok) throw new Error(`GitHub did not give ${what} (${response.status})`);
		return response;
	};
	const api = `https://api.github.com/repos/${owner}/${repo}`;
	const commit = ((await (await get(`${api}/commits/${encodeURIComponent(ref ?? (((await (await get(api, "the repository")).json()) as { default_branch: string }).default_branch))}`, "the commit")).json()) as { sha: string }).sha;
	const tree = (await (await get(`${api}/git/trees/${commit}?recursive=1`, "the folder")).json()) as { tree: { path: string; type: string; size?: number }[]; truncated?: boolean };
	const prefix = path ? `${path}/` : "";
	const entries = tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix));
	if (tree.truncated || entries.length > MAX_ENTRIES) throw new Error(`That folder has more than ${MAX_ENTRIES} files`);
	if (!entries.some((e) => e.path === `${prefix}SKILL.md`)) throw new Error("That folder has no SKILL.md");
	let total = 0;
	const files: Record<string, string> = {};
	const hashes: Record<string, string> = {};
	let skill = "";
	for (const entry of entries) {
		if ((entry.size ?? 0) > MAX_FILE) throw new Error(`${entry.path} is larger than ${MAX_FILE / 1000} kB`);
		const content = await (await get(`https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${entry.path.split("/").map(encodeURIComponent).join("/")}`, entry.path)).text();
		total += content.length;
		if (total > MAX_TOTAL) throw new Error(`That folder is larger than ${MAX_TOTAL / 1000} kB`);
		if (content.includes("\u0000")) throw new Error(`${entry.path} is not a text file`);
		const relative = entry.path.slice(prefix.length);
		hashes[relative] = createHash("sha256").update(content).digest("hex");
		if (relative === "SKILL.md") skill = content;
		else files[relative] = content;
	}
	const parsed = parseSkillFile(skill);
	const name = (parsed.name ?? path.split("/").at(-1) ?? repo).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
	if (!name) throw new Error("That skill has no name");
	return { source: `https://github.com/${owner}/${repo}/tree/${commit}${path ? `/${path}` : ""}`, commit, name, description: parsed.description, body: parsed.body, files, hashes };
}
