/**
 * Where a skill can be installed from: a folder in the person's files (`/workspace/skills/name`), or a folder of a GitHub repository (`https://github.com/<owner>/<repo>/tree/<ref>/<path>`, or `<owner>/<repo>/<path>`). The folder is read at the
 * commit its ref names at that moment, and every file is fetched at that commit, so what is installed is what was read and a branch moving meanwhile changes nothing. The
 * folder holds a SKILL.md (frontmatter with a name and a description, then the instructions) and any supporting files; each file's SHA-256 is returned so that what a person
 * approved can be checked against what is installed.
 */
import { createHash } from "node:crypto";
import { binaryValue } from "@pim/v2-app/app-files";

export type SkillFolder = { source: string; commit: string; name: string; description: string; body: string; files: Record<string, string>; hashes: Record<string, string> };

/** As v1: up to 50 supporting files and 10 MB together, whatever they are. */
const MAX_FILES = 50;
const MAX_TOTAL = 10_000_000;
/** A file of the folder is carried unless it, or a folder it is in, is hidden (`.git`). */
const carried = (path: string) => !path.split("/").some((part) => part.startsWith("."));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** A file as a skill keeps it: its text, or `pim-binary:` and its bytes when it is not text. */
export const fileValue = (bytes: Uint8Array): string => {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return binaryValue(bytes);
	}
};

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

/** Where a GitHub request may lead when GitHub sends it elsewhere: only the addresses skills are read from, so a request never leaves them. */
const allowed = (next: URL) => next.protocol === "https:" && next.port === "" && next.username === "" && next.password === "" && (next.hostname === "api.github.com" || next.hostname === "raw.githubusercontent.com");

export async function readSkillFolder(fetchFn: typeof fetch, raw: string): Promise<SkillFolder> {
	const { owner, repo, ref, path } = parseSource(raw);
	const get = async (url: string, what: string) => {
		let at = url;
		for (let redirects = 0; ; redirects++) {
			const response = await fetchFn(at, { headers: { "user-agent": "Pim/2", accept: "application/vnd.github+json" }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel().catch(() => undefined);
				const next = response.headers.get("location") ? URL.parse(response.headers.get("location")!, at) : null;
				if (redirects >= 3 || next === null || !allowed(next)) throw new Error(`GitHub sent ${new URL(at).origin} elsewhere, so nothing was read from it`);
				at = next.href;
				continue;
			}
			if (response.status === 403 || response.status === 429) throw new Error("GitHub refused to list the repository now, likely its limit on requests from one address: clone it to the person's computer, then install the skill from that folder");
			if (!response.ok) throw new Error(`GitHub did not give ${what} (${response.status})`);
			return response;
		}
	};
	const api = `https://api.github.com/repos/${owner}/${repo}`;
	const commit = ((await (await get(`${api}/commits/${encodeURIComponent(ref ?? (((await (await get(api, "the repository")).json()) as { default_branch: string }).default_branch))}`, "the commit")).json()) as { sha: string }).sha;
	const tree = (await (await get(`${api}/git/trees/${commit}?recursive=1`, "the folder")).json()) as { tree: { path: string; type: string; size?: number }[]; truncated?: boolean };
	const prefix = path ? `${path}/` : "";
	const entries = tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix) && carried(e.path.slice(prefix.length)));
	if (!entries.some((e) => e.path === `${prefix}SKILL.md`)) throw new Error(tree.truncated ? `${owner}/${repo} is too large for GitHub to list whole: clone it to the person's computer and install from there` : "That folder has no SKILL.md");
	const others = entries.filter((e) => e.path !== `${prefix}SKILL.md`);
	if (others.length > MAX_FILES) throw new Error(`A skill can have up to ${MAX_FILES} supporting files; this one has ${others.length}`);
	if (others.reduce((total, e) => total + (e.size ?? 0), 0) > MAX_TOTAL) throw new Error(`A skill's supporting files can take up to ${MAX_TOTAL} bytes together`);
	let total = 0;
	const files: Record<string, string> = {};
	const hashes: Record<string, string> = {};
	let skill = "";
	for (const entry of entries) {
		const bytes = new Uint8Array(await (await get(`https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${entry.path.split("/").map(encodeURIComponent).join("/")}`, entry.path)).arrayBuffer());
		total += bytes.length;
		if (total > MAX_TOTAL) throw new Error(`That folder is larger than ${MAX_TOTAL} bytes`);
		const relative = entry.path.slice(prefix.length);
		hashes[relative] = sha256(bytes);
		if (relative === "SKILL.md") skill = new TextDecoder().decode(bytes);
		else files[relative] = fileValue(bytes);
	}
	return finish(`https://github.com/${owner}/${repo}/tree/${commit}${path ? `/${path}` : ""}`, commit, skill, files, hashes, path.split("/").at(-1) || repo);
}

/** A skill in a folder of the person's files: `list` finds what is in it and `read` gives a file's bytes (the folder's own path, then a path relative to it). Its `commit` is the folder's path, since a folder has none. */
export async function readSkillFromFiles(io: { list(folder: string): Promise<{ path: string; size: number }[]>; read(path: string): Promise<Uint8Array> }, folder: string): Promise<SkillFolder> {
	const root = folder.replace(/\/+$/, "");
	const found = await io.list(root);
	if (!found.some((f) => f.path === "SKILL.md")) throw new Error(`${root} has no SKILL.md`);
	const others = found.filter((f) => f.path !== "SKILL.md");
	if (others.length > MAX_FILES) throw new Error(`A skill can have up to ${MAX_FILES} supporting files; this one has ${others.length}`);
	if (others.reduce((total, f) => total + f.size, 0) > MAX_TOTAL) throw new Error(`A skill's supporting files can take up to ${MAX_TOTAL} bytes together`);
	const files: Record<string, string> = {};
	const hashes: Record<string, string> = {};
	let skill = "";
	for (const entry of found) {
		const bytes = await io.read(`${root}/${entry.path}`);
		hashes[entry.path] = sha256(bytes);
		if (entry.path === "SKILL.md") skill = new TextDecoder().decode(bytes);
		else files[entry.path] = fileValue(bytes);
	}
	return finish(root, root, skill, files, hashes, root.split("/").at(-1) ?? "skill");
}

function finish(source: string, commit: string, skill: string, files: Record<string, string>, hashes: Record<string, string>, fallbackName: string): SkillFolder {
	const parsed = parseSkillFile(skill);
	const name = (parsed.name ?? fallbackName).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
	if (!name) throw new Error("That skill has no name");
	return { source, commit, name, description: parsed.description, body: parsed.body, files, hashes };
}
