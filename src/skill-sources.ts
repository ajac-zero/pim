import type { FileEntry, Files } from "./files";
import { HttpError } from "./http";
import { MAX_SKILL_BYTES, MAX_SKILL_FILES } from "./skills";

/**
 * Skills someone published, as Agent Skills folders: a SKILL.md, whose
 * YAML frontmatter names and describes the skill, and the files beside it.
 * `install_skill` (./extensions/skills.ts) reads one from a folder in the
 * person's files or from GitHub, and files a `write_skill` request with
 * the instructions as they are written there and each file as a copy,
 * which that request names by its SHA-256 and checks again when it is made.
 *
 * From GitHub, the folder is read at the commit its address names now, and
 * each file is copied from that commit's raw address, which never changes.
 * GitHub's API, which finds the commit and lists the folder, allows a
 * limited number of requests from one address an hour; a refusal says to
 * clone the repository to the person's computer and install from there.
 */

/** A skill as its source has it, with where to copy each file from. */
export type SkillSource = {
	/** Where it was installed from: the GitHub folder at its commit, or the folder in the person's files. */
	readonly source: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly files: readonly ({ readonly path: string } & ({ readonly from_file: string } | { readonly from_url: string }))[];
};

/** Where GitHub serves a commit's files. */
export const RAW_GITHUB = "https://raw.githubusercontent.com/";
const API = "https://api.github.com";
/** How many entries a folder in the person's files may have, all its folders together, before reading it stops. */
const MAX_FOLDER_ENTRIES = 500;

/** A YAML block scalar's lines, without their indentation: `|` keeps line breaks, `>` folds them into spaces. */
function blockScalar(lines: readonly string[], folded: boolean): string {
	const indent = Math.min(...lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length));
	const text = lines.map((line) => line.slice(indent));
	return (folded ? text.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ") : text.join("\n")).trim();
}

/** A YAML flow scalar: quoted, or plain, over one or more lines. */
function flowScalar(value: string): string {
	const folded = value.replace(/\s*\n\s*/g, " ").trim();
	if (folded.startsWith('"') && folded.endsWith('"') && folded.length > 1) return JSON.parse(folded) as string;
	if (folded.startsWith("'") && folded.endsWith("'") && folded.length > 1) return folded.slice(1, -1).replaceAll("''", "'");
	return folded;
}

/**
 * A SKILL.md's name, description and instructions: the top-level scalars
 * of its frontmatter that a skill needs, and the Markdown after it. Other
 * fields, such as `license`, are left out.
 */
export function parseSkillMd(markdown: string): { name: string; description: string; instructions: string } {
	const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
	if (!match) throw new HttpError(400, "SKILL.md must start with YAML frontmatter, between --- lines, giving the skill's name and description");
	const lines = match[1]!.split(/\r?\n/);
	const fields: Record<string, string> = {};
	for (let index = 0; index < lines.length; index++) {
		const key = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(lines[index]!);
		if (!key) continue;
		const following: string[] = [];
		while (index + 1 < lines.length && (lines[index + 1]!.trim() === "" || /^\s/.test(lines[index + 1]!))) following.push(lines[++index]!);
		const value = (key[2] ?? "").trim();
		fields[key[1]!] = /^[|>][+-]?$/.test(value) ? blockScalar(following, value.startsWith(">")) : flowScalar([value, ...following].join("\n"));
	}
	const { name, description } = fields;
	if (!name || !description) throw new HttpError(400, "SKILL.md's frontmatter must give the skill's name and description");
	return { name, description, instructions: markdown.slice(match[0].length).trim() };
}

/** Whether a path inside a skill's folder is one it carries: hidden files and folders, such as .git, are left out. */
const carried = (path: string) => !path.split("/").some((part) => part.startsWith("."));

/** Reads a skill from a folder in the person's files. */
export async function skillFromFolder(files: Pick<Files, "list" | "bytes">, folder: string): Promise<SkillSource> {
	const found: { path: string; size: number }[] = [];
	let seen = 0;
	const walk = async (entries: readonly FileEntry[], prefix: string): Promise<void> => {
		seen += entries.length;
		if (seen > MAX_FOLDER_ENTRIES) throw new HttpError(413, `${folder} has more than ${MAX_FOLDER_ENTRIES} files and folders: give the skill's own folder`);
		for (const entry of entries) {
			const path = `${prefix}${entry.name}`;
			if (!carried(path)) continue;
			if (entry.type === "directory") await walk((await files.list(entry.path)).entries, `${path}/`);
			else found.push({ path, size: entry.size });
		}
	};
	const top = await files.list(folder);
	const root = top.path;
	await walk(top.entries, "");
	if (!found.some((file) => file.path === "SKILL.md")) throw new HttpError(404, `${root} has no SKILL.md`);
	checkSize(found.filter((file) => file.path !== "SKILL.md"));
	const skill = parseSkillMd(new TextDecoder().decode(await files.bytes(`${root}/SKILL.md`)));
	const copies = found.filter((file) => file.path !== "SKILL.md").map((file) => ({ path: file.path, from_file: `${root}/${file.path}` }));
	return { source: root, ...skill, files: copies };
}

/** Refuses a skill's files before reading them when there are too many, or too many bytes. */
function checkSize(files: readonly { size: number }[]): void {
	if (files.length > MAX_SKILL_FILES) throw new HttpError(413, `A skill can have up to ${MAX_SKILL_FILES} supporting files; this one has ${files.length}`);
	const size = files.reduce((total, file) => total + file.size, 0);
	if (size > MAX_SKILL_BYTES) throw new HttpError(413, `A skill's supporting files can take up to ${MAX_SKILL_BYTES} bytes together; these take ${size}`);
}

/** A repository on GitHub, and what its address names in it: a ref and a path, as segments, for a folder or a file. */
const GITHUB_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^?#]+))?\/?(?:[?#].*)?$/;

async function github(path: string, accept = "application/vnd.github+json"): Promise<Response> {
	const response = await fetch(`${API}${path}`, { headers: { accept, "user-agent": "pim", "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(20_000) });
	if (response.status === 403 || response.status === 429) {
		await response.body?.cancel();
		throw new HttpError(
			429,
			"GitHub refused to list the repository now, likely its limit on requests from one address: clone it to the person's computer with shell, then install the skill from that folder",
		);
	}
	return response;
}

/** The ref an address names, of its segments, and the path after it: the shortest prefix GitHub knows as a ref, since a ref can have slashes. */
async function resolveRef(repo: string, segments: readonly string[]): Promise<{ commit: string; path: string[] }> {
	for (let count = 1; count <= segments.length; count++) {
		const response = await github(`/repos/${repo}/commits/${encodeURIComponent(segments.slice(0, count).join("/"))}`, "application/vnd.github.sha");
		if (response.ok) return { commit: (await response.text()).trim(), path: segments.slice(count) };
		await response.body?.cancel();
		if (response.status !== 404 && response.status !== 422) throw new HttpError(502, `GitHub answered ${response.status} for ${repo}`);
	}
	throw new HttpError(404, `GitHub has no branch, tag or commit in ${repo} that this address names`);
}

/** Reads a skill from a folder of a GitHub repository, at the commit its address names now. */
export async function skillFromGitHub(url: string): Promise<SkillSource> {
	const match = GITHUB_URL.exec(url);
	if (!match) throw new HttpError(400, "Give a GitHub repository's address, or a folder's in it, such as https://github.com/owner/repo/tree/main/skills/name");
	const [, owner, name, kind, rest] = match;
	const repo = `${owner}/${name}`;
	const segments = rest ? rest.split("/").filter((part) => part !== "").map(decodeURIComponent) : ["HEAD"];
	const { commit, path } = await resolveRef(repo, segments);
	// An address of the SKILL.md itself names its folder.
	if (kind === "blob") {
		if (path.at(-1) !== "SKILL.md") throw new HttpError(400, "Give the address of the skill's folder, or of its SKILL.md");
		path.pop();
	}
	const folder = path.join("/");
	const listing = await github(`/repos/${repo}/git/trees/${commit}?recursive=1`);
	if (!listing.ok) {
		await listing.body?.cancel();
		throw new HttpError(502, `GitHub answered ${listing.status} listing ${repo}`);
	}
	const tree = (await listing.json()) as { tree: { path: string; type: string; size?: number }[]; truncated: boolean };
	const prefix = folder === "" ? "" : `${folder}/`;
	const found = tree.tree
		.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix))
		.map((entry) => ({ path: entry.path.slice(prefix.length), size: entry.size ?? 0 }))
		.filter((file) => carried(file.path));
	if (!found.some((file) => file.path === "SKILL.md")) {
		throw new HttpError(404, tree.truncated ? `${repo} is too large for GitHub to list whole: clone it to the person's computer and install from there` : `${url} has no SKILL.md`);
	}
	checkSize(found.filter((file) => file.path !== "SKILL.md"));
	const raw = (path: string) => `${RAW_GITHUB}${repo}/${commit}/${`${prefix}${path}`.split("/").map(encodeURIComponent).join("/")}`;
	const skill = parseSkillMd(new TextDecoder().decode(await readUrl(raw("SKILL.md"))));
	const copies = found.filter((file) => file.path !== "SKILL.md").map((file) => ({ path: file.path, from_url: raw(file.path) }));
	return { source: `https://github.com/${repo}/tree/${commit}${folder === "" ? "" : `/${folder}`}`, ...skill, files: copies };
}

/** A file of a commit on GitHub; only GitHub's raw addresses are read. */
export async function readUrl(url: string): Promise<Uint8Array> {
	if (!url.startsWith(RAW_GITHUB)) throw new HttpError(400, `Only files on ${RAW_GITHUB} are copied from the web`);
	const response = await fetch(url, { headers: { "user-agent": "pim" }, signal: AbortSignal.timeout(20_000) });
	if (!response.ok) {
		await response.body?.cancel();
		throw new HttpError(502, `GitHub answered ${response.status} for ${url}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}
