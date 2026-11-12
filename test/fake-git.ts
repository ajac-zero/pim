import { WORKSPACE_GIT_AUTH_DIR } from "../src/coding/git-broker/workspace-credential";
import type { FakeCommandHandler } from "../src/coding/workspace/fake";
import type { EgressPolicy, Workspace } from "../src/coding/workspace/types";

/**
 * A git for the in-memory workspace (src/coding/workspace/fake.ts), enough
 * for a coding thread and its tools: `clone`, `remote set-url`, `fetch`, `checkout -B`,
 * `rev-parse HEAD`, `status`, `add`, `commit`, `diff A B` or `diff`
 * of the working tree, and `update-ref` and `bundle create` for pushes, and for merges
 * `fetch origin +<ref>:<ref>`, `merge-base`, `checkout --detach` and `rebase <base>`
 * (which takes the thread's changes onto the base, or conflicts where both
 * changed a file differently), and for autosaves `write-tree` (of the working
 * tree, whatever the index), `commit-tree`, `reset --mixed` and a fetch from
 * a bundle, whose commits follow its pack as JSON. It keeps its
 * commits as files under `.git`, so a workspace's kept volume keeps them.
 * Remotes are `fakeRemotes`, by URL; cloning any other fails as a missing
 * repository does, printing the HTTP header it was given, as a verbose git
 * prints what it sent.
 */

/** The files each remote's default branch has, by URL. */
export const fakeRemotes = new Map<string, Record<string, string>>();

/** Each clone tried, with the environment git ran in. */
export const fakeClones: { url: string; env: Record<string, string> }[] = [];

/** Clones of a URL that fail with the given error output, this many more times, before it clones as usual: a rate limited host. */
export const fakeCloneFailures = new Map<string, { times: number; stderr: string }>();

/** Each `git push` tried, with the environment git ran in. */
export const fakePushes: { url: string; refspec: string; sha: string; env: Record<string, string> }[] = [];

/** Pushes to a URL that fail with the given error output, this many more times, before they work: a branch that moved on. */
export const fakePushFailures = new Map<string, { times: number; stderr: string }>();

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

/** A fake commit's name as git's: 40 hex digits. */
export const hex40 = (sha: string) => [...encoder.encode(sha)].map((byte) => byte.toString(16).padStart(2, "0")).join("").padEnd(40, "0").slice(0, 40);

const write = (workspace: Workspace, path: string, text: string) => workspace.writeFile(path, encoder.encode(text));

/** Where a fake bundle's commits start, after its pack. */
const BUNDLE_COMMITS = "\n#commits ";

/** A short name for what `text` holds. */
const digest = (text: string) => [...text].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1_000_003, 7);
const read = async (workspace: Workspace, path: string) => decoder.decode(await workspace.readFile(path));

export const fakeGit: FakeCommandHandler = async ({ argv, cwd, env, workspace }) => {
	const args = argv.slice(1);
	while (args[0] === "-c" || args[0] === "--no-pager") args.splice(0, args[0] === "-c" ? 2 : 1);
	const [command, ...rest] = args;
	const objects = (sha: string) => `${cwd}/.git/objects/${sha}`;
	const lineage = async (sha: string) => {
		const chain: string[] = [];
		for (let at: string | null = sha; at; at = await read(workspace, `${objects(at)}.parent`).catch(() => null)) chain.push(at);
		return chain;
	};
	const commit = async (sha: string) => JSON.parse(await read(workspace, objects(sha))) as Files;
	switch (command) {
		case "config": {
			if (!rest.includes("--global")) return { code: 1 };
			const [key, value] = rest.filter(arg => !arg.startsWith("--")) as [string, string];
			const config = JSON.parse(await read(workspace, "/workspace/.gitconfig").catch(() => "{}")) as Record<string, string[]>;
			config[key] = rest.includes("--add") ? [...(config[key] ?? []), value] : [value];
			await write(workspace, "/workspace/.gitconfig", JSON.stringify(config));
			return {};
		}
		case "clone": {
			const [url, dir] = rest.filter((arg) => !arg.startsWith("--"));
			if (url) fakeClones.push({ url, env });
			const failing = url ? fakeCloneFailures.get(url) : undefined;
			if (failing && failing.times > 0) {
				failing.times--;
				// A failed clone leaves its directory behind, as git does until it cleans up after itself.
				if (dir) await write(workspace, `${dir.startsWith("/") ? dir : `${cwd}/${dir}`}/partial`, "x");
				return { stderr: failing.stderr, code: 128 };
			}
			// Like git with GIT_CURL_VERBOSE, a failed clone prints the headers it sent, a token among them.
			const sent = env.GIT_CONFIG_KEY_0 === "http.extraHeader" ? `> ${env.GIT_CONFIG_VALUE_0}\n` : "";
			if (!url || !dir || !fakeRemotes.has(url)) return { stderr: `${sent}fatal: repository '${url}' not found\n`, code: 128 };
			const root = dir.startsWith("/") ? dir : `${cwd}/${dir}`;
			await write(workspace, `${root}/.git/origin`, url);
			return {};
		}
		case "remote": {
			// `remote set-url origin <url>`.
			const url = rest[2];
			if (rest[0] !== "set-url" || rest[1] !== "origin" || !url) return { stderr: "usage: git remote set-url origin <url>\n", code: 129 };
			await write(workspace, `${cwd}/.git/origin`, url);
			return {};
		}
		case "fetch": {
			// `fetch <file>.bundle +<ref>:<ref>`: the bundle's commits, and the ref set to its tip.
			if (rest[0]?.endsWith(".bundle")) {
				const text = decoder.decode(await workspace.readFile(rest[0]));
				const at = text.indexOf(BUNDLE_COMMITS);
				if (at < 0) return { stderr: `fatal: '${rest[0]}' does not look like a v2 or v3 bundle file\n`, code: 128 };
				const { tip, commits: carried } = JSON.parse(text.slice(at + BUNDLE_COMMITS.length)) as { tip: string; commits: Record<string, { files: Files; parent: string | null }> };
				for (const [sha, each] of Object.entries(carried)) {
					await write(workspace, objects(sha), JSON.stringify(each.files));
					if (each.parent) await write(workspace, `${objects(sha)}.parent`, each.parent);
				}
				const dest = rest[1]?.replace(/^\+/, "").split(":")[1];
				if (dest) await write(workspace, `${cwd}/.git/${dest}`, tip);
				return {};
			}
			// Like git against the broker, a fetch without its bearer header is refused.
			// Git uses the global helper, a command header, or an injecting egress proxy.
			const injected = (workspace as { egress?: EgressPolicy }).egress?.inject?.some((rule) => rule.headers.authorization?.startsWith("Bearer "));
			const origin = await read(workspace, `${cwd}/.git/origin`);
			const global = JSON.parse(await read(workspace, "/workspace/.gitconfig").catch(() => "{}")) as Record<string, string[]>;
			const grant = JSON.parse(await read(workspace, `${WORKSPACE_GIT_AUTH_DIR}/credential.json`).catch(() => "{}")) as { url?: string; token?: string };
			const helper = global[`credential.${origin}.helper`]?.includes(`!node ${WORKSPACE_GIT_AUTH_DIR}/helper.mjs`) && grant.url === origin && grant.token?.startsWith("pimgit_");
			if (!injected && !helper && !env.GIT_CONFIG_VALUE_0?.startsWith("Authorization: Bearer ")) return { stderr: "fatal: could not read Username for 'https://pim.invalid': terminal prompts disabled\n", code: 128 };
			const files = fakeRemotes.get(await read(workspace, `${cwd}/.git/origin`));
			if (!files) return { stderr: "fatal: could not read from remote\n", code: 128 };
			const dest = rest.find((arg) => arg.includes(":"))?.split(":")[1];
			if (dest) {
				// A merge's fetch of the default branch: the clone's own commit while it hasn't moved, else a commit on top of it.
				const base = JSON.parse(await read(workspace, objects("base0000"))) as Files;
				const moved = JSON.stringify(Object.entries(files).sort()) !== JSON.stringify(Object.entries(base).sort());
				const sha = moved ? `m${[...JSON.stringify(Object.entries(files).sort())].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1_000_003, 7)}` : "base0000";
				if (moved) {
					await write(workspace, objects(sha), JSON.stringify(files));
					await write(workspace, `${objects(sha)}.parent`, "base0000");
				}
				await write(workspace, `${cwd}/.git/${dest}`, sha);
				return {};
			}
			await write(workspace, objects("base0000"), JSON.stringify(files));
			await write(workspace, `${cwd}/.git/FETCH_HEAD`, "base0000");
			return {};
		}
		case "symbolic-ref": {
			// `symbolic-ref --short -q HEAD`: the branch, or failing with no output when HEAD is detached.
			if (await read(workspace, `${cwd}/.git/detached`).catch(() => "")) return { code: 1 };
			return { stdout: `${await read(workspace, `${cwd}/.git/branch`).catch(() => "")}\n` };
		}
		case "push": {
			// `push origin HEAD:refs/heads/<branch>`, authorized as a fetch is; the broker's own checks are tested elsewhere.
			const origin = await read(workspace, `${cwd}/.git/origin`);
			const failing = fakePushFailures.get(origin);
			const sent = env.GIT_CONFIG_KEY_0 === "http.extraHeader" ? `> ${env.GIT_CONFIG_VALUE_0}\n` : "";
			if (failing && failing.times > 0) {
				failing.times--;
				return { stderr: `${sent}${failing.stderr}`, code: 1 };
			}
			const refspec = rest[1] ?? "";
			fakePushes.push({ url: origin, refspec, sha: await read(workspace, `${cwd}/.git/HEAD`), env });
			return {};
		}
		case "checkout": {
			// `checkout [-f] -B <branch> FETCH_HEAD`: the branch is kept in `.git/branch`; `--detach` leaves it, with a mark that HEAD is not on it.
			const branch = rest[rest.indexOf("-B") + 1];
			if (rest.includes("-B") && branch) await write(workspace, `${cwd}/.git/branch`, branch);
			await write(workspace, `${cwd}/.git/detached`, rest.includes("--detach") ? "1" : "");
			const target = rest.at(-1)!;
			const sha = target === "FETCH_HEAD" || target === branch ? await read(workspace, `${cwd}/.git/FETCH_HEAD`) : target === "HEAD" ? await read(workspace, `${cwd}/.git/HEAD`) : target;
			const files = await commit(sha);
			if (target !== "FETCH_HEAD") for (const path of Object.keys(await readFiles(workspace, cwd))) if (!(path in files)) await workspace.remove(`${cwd}/${path}`);
			for (const [path, text] of Object.entries(files)) await write(workspace, `${cwd}/${path}`, text);
			await write(workspace, `${cwd}/.git/HEAD`, sha);
			return {};
		}
		case "rev-parse": {
			// HEAD and the current branch are the commit last made; another ref is what `update-ref` or a fetch set, if anything.
			const ref = rest[0] ?? "HEAD";
			const current = await read(workspace, `${cwd}/.git/branch`).catch(() => "");
			const named = ref === "HEAD" || ref === `refs/heads/${current}` ? null : await read(workspace, `${cwd}/.git/${ref}`).catch(() => null);
			return { stdout: `${named ?? (await read(workspace, `${cwd}/.git/HEAD`))}\n` };
		}
		case "merge-base": {
			// `merge-base A B`: the nearest commit each descends from, where commits made here follow the one before.
			const [a, b] = rest as [string, string];
			const [chainA, chainB] = [await lineage(a), await lineage(b)];
			const common = chainA.find((sha) => chainB.includes(sha));
			return common ? { stdout: `${common}\n` } : { code: 1 };
		}
		case "rebase": {
			// `rebase <base>` of the detached HEAD: the base's files, with what the thread changed since the two diverged.
			if (rest[0] === "--abort") return {};
			const base = rest[0]!;
			const head = await read(workspace, `${cwd}/.git/HEAD`);
			const baseChain = await lineage(base);
			const root = (await lineage(head)).find((sha) => baseChain.includes(sha))!;
			const [theirs, ours, original] = [await commit(base), await commit(head), await commit(root)];
			const merged = { ...theirs };
			for (const path of new Set([...Object.keys(original), ...Object.keys(ours)])) {
				if (ours[path] === original[path]) continue;
				if (theirs[path] !== original[path] && theirs[path] !== ours[path]) return { stdout: `CONFLICT (content): Merge conflict in ${path}\n`, stderr: `error: could not apply ${head}\n`, code: 1 };
				if (ours[path] === undefined) delete merged[path];
				else merged[path] = ours[path];
			}
			const sha = `c${String(++commits).padStart(7, "0")}`;
			await write(workspace, objects(sha), JSON.stringify(merged));
			await write(workspace, `${objects(sha)}.parent`, base);
			await write(workspace, `${cwd}/.git/HEAD`, sha);
			return {};
		}
		case "update-ref": {
			const [ref, sha] = rest;
			await write(workspace, `${cwd}/.git/${ref}`, sha!);
			return {};
		}
		case "bundle": {
			// `bundle create <file> [<base>..]<ref>`: a bundle git could make, with each commit's name as 40 hex digits.
			const [, file, range] = rest;
			const [base, ref] = range!.includes("..") ? range!.split("..") : [null, range!];
			const sha = await read(workspace, `${cwd}/.git/${ref}`).catch(() => read(workspace, `${cwd}/.git/HEAD`));
			const header = `# v2 git bundle\n${base ? `-${hex40(base)}\n` : ""}${hex40(sha)} ${ref}\n\n`;
			const pack = new Uint8Array(32);
			pack.set(encoder.encode("PACK"));
			pack[7] = 2;
			// The commits since the base follow the pack, for a fetch from the bundle to read.
			const carried: Record<string, { files: Files; parent: string | null }> = {};
			for (const each of await lineage(sha)) {
				if (each === base) break;
				carried[each] = { files: await commit(each), parent: await read(workspace, `${objects(each)}.parent`).catch(() => null) };
			}
			const bytes = new Uint8Array([...encoder.encode(header), ...pack, ...encoder.encode(`${BUNDLE_COMMITS}${JSON.stringify({ tip: sha, commits: carried })}`)]);
			await workspace.writeFile(file!.startsWith("/") ? file! : `${cwd}/${file}`, bytes);
			return {};
		}
		case "add":
			return {};
		case "write-tree": {
			const files = await readFiles(workspace, cwd);
			const sha = `t${digest(JSON.stringify(Object.entries(files).sort()))}`;
			await write(workspace, objects(sha), JSON.stringify(files));
			return { stdout: `${sha}\n` };
		}
		case "commit-tree": {
			// `commit-tree <tree> -p <parent> -m <message>`.
			const sha = `c${String(++commits).padStart(7, "0")}`;
			await write(workspace, objects(sha), await read(workspace, objects(rest[0]!)));
			await write(workspace, `${objects(sha)}.parent`, rest[rest.indexOf("-p") + 1]!);
			return { stdout: `${sha}\n` };
		}
		case "reset": {
			// `reset --mixed <commit>`: the branch moves, the files stay.
			await write(workspace, `${cwd}/.git/HEAD`, rest.at(-1)!);
			return {};
		}
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
			await write(workspace, `${objects(sha)}.parent`, await read(workspace, `${cwd}/.git/HEAD`));
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
