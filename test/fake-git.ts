import type { FakeCommandHandler } from "../src/coding/workspace/fake";
import type { Workspace } from "../src/coding/workspace/types";

/**
 * A git for the in-memory workspace (src/coding/workspace/fake.ts), enough
 * for a coding thread and its tools: `clone`, `fetch`, `checkout -B`,
 * `rev-parse HEAD`, `status`, `add`, `commit`, and `diff A B` or `diff`
 * of the working tree. It keeps its
 * commits as files under `.git`, so a workspace's kept volume keeps them.
 * Remotes are `fakeRemotes`, by URL; cloning any other fails as a missing
 * repository does.
 */

/** The files each remote's default branch has, by URL. */
export const fakeRemotes = new Map<string, Record<string, string>>();

/** Each clone, with the environment git ran in. */
export const fakeClones: { url: string; env: Record<string, string> }[] = [];

type Files = Record<string, string>;

let commits = 0;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function readFiles(workspace: Workspace, root: string, dir = root): Promise<Files> {
	const files: Files = {};
	for (const entry of await workspace.list(dir)) {
		const path = `${dir}/${entry.name}`;
		if (path === `${root}/.git`) continue;
		if (entry.type === "dir") Object.assign(files, await readFiles(workspace, root, path));
		else if (entry.type === "file") files[path.slice(root.length + 1)] = decoder.decode(await workspace.readFile(path));
	}
	return files;
}

const write = (workspace: Workspace, path: string, text: string) => workspace.writeFile(path, encoder.encode(text));
const read = async (workspace: Workspace, path: string) => decoder.decode(await workspace.readFile(path));

export const fakeGit: FakeCommandHandler = async ({ argv, cwd, env, workspace }) => {
	const args = argv.slice(1);
	while (args[0] === "-c" || args[0] === "--no-pager") args.splice(0, args[0] === "-c" ? 2 : 1);
	const [command, ...rest] = args;
	const objects = (sha: string) => `${cwd}/.git/objects/${sha}`;
	const commit = async (sha: string) => JSON.parse(await read(workspace, objects(sha))) as Files;
	switch (command) {
		case "clone": {
			const [url, dir] = rest.filter((arg) => !arg.startsWith("--"));
			if (!url || !dir || !fakeRemotes.has(url)) return { stderr: `fatal: repository '${url}' not found\n`, code: 128 };
			fakeClones.push({ url, env });
			const root = dir.startsWith("/") ? dir : `${cwd}/${dir}`;
			await write(workspace, `${root}/.git/origin`, url);
			return {};
		}
		case "fetch": {
			const files = fakeRemotes.get(await read(workspace, `${cwd}/.git/origin`));
			if (!files) return { stderr: "fatal: could not read from remote\n", code: 128 };
			await write(workspace, objects("base0000"), JSON.stringify(files));
			await write(workspace, `${cwd}/.git/FETCH_HEAD`, "base0000");
			return {};
		}
		case "checkout": {
			const sha = await read(workspace, `${cwd}/.git/FETCH_HEAD`);
			for (const [path, text] of Object.entries(await commit(sha))) await write(workspace, `${cwd}/${path}`, text);
			await write(workspace, `${cwd}/.git/HEAD`, sha);
			return {};
		}
		case "rev-parse":
			return { stdout: `${await read(workspace, `${cwd}/.git/HEAD`)}\n` };
		case "add":
			return {};
		case "status": {
			const head = await commit(await read(workspace, `${cwd}/.git/HEAD`));
			const now = await readFiles(workspace, cwd);
			const lines = [...new Set([...Object.keys(head), ...Object.keys(now)])]
				.sort()
				.flatMap((path) => (head[path] === now[path] ? [] : [`${path in head ? (path in now ? " M" : " D") : "??"} ${path}`]));
			return { stdout: lines.map((line) => `${line}\n`).join("") };
		}
		case "commit": {
			const head = await commit(await read(workspace, `${cwd}/.git/HEAD`));
			const now = await readFiles(workspace, cwd);
			if (JSON.stringify(Object.entries(head).sort()) === JSON.stringify(Object.entries(now).sort())) return { stdout: "nothing to commit\n", code: 1 };
			const sha = `c${String(++commits).padStart(7, "0")}`;
			await write(workspace, objects(sha), JSON.stringify(now));
			await write(workspace, `${cwd}/.git/HEAD`, sha);
			return { stdout: `[${sha}] ${rest[rest.indexOf("-m") + 1]}\n` };
		}
		case "diff": {
			// `diff A B` between commits; with none, the working tree against HEAD.
			const [from, to] = rest;
			const a = await commit(from ?? (await read(workspace, `${cwd}/.git/HEAD`)));
			const b = to ? await commit(to) : await readFiles(workspace, cwd);
			const out = [...new Set([...Object.keys(a), ...Object.keys(b)])]
				.sort()
				.filter((path) => a[path] !== b[path])
				.map((path) => {
					const minus = a[path] === undefined ? [] : a[path].split("\n").filter(Boolean).map((line) => `-${line}`);
					const plus = b[path] === undefined ? [] : b[path].split("\n").filter(Boolean).map((line) => `+${line}`);
					return [`diff --git a/${path} b/${path}`, `--- ${path in a ? `a/${path}` : "/dev/null"}`, `+++ ${path in b ? `b/${path}` : "/dev/null"}`, ...minus, ...plus].join("\n");
				});
			return { stdout: out.map((block) => `${block}\n`).join("") };
		}
		default:
			return { stderr: `git: '${command}' is not a git command\n`, code: 1 };
	}
};
