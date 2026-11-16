// Integrating a pushed branch onto the default branch in a throwaway clone: fast-forward when possible, else rebase, never a force push; a conflict is aborted and leaves the default branch alone.
// Used for Amp threads (their work is only ever on the git host) and for sandbox threads after Pim has pushed their branch.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type MergeOutcome } from "./ports";

const run = promisify(execFile);

export type Remote = {
	/** Where git fetches and pushes. */
	url: string;
	/** An `Authorization` header value for the host, passed through git's environment so it is never in an argument or a log. */
	authorization?: string | null;
};

const ID = ["-c", "user.name=Pim", "-c", "user.email=pim@users.noreply.pim"];

export async function mergeBranch(remote: Remote, base: string, branch: string): Promise<MergeOutcome> {
	const dir = await mkdtemp(join(tmpdir(), "forge-merge-"));
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
	if (remote.authorization) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${remote.authorization}` });
	const git = async (...args: string[]) => {
		try {
			const r = await run("git", [...ID, ...args], { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 });
			return { code: 0, out: r.stdout.trim(), err: r.stderr };
		} catch (e: any) {
			return { code: typeof e.code === "number" ? e.code : 1, out: String(e.stdout ?? "").trim(), err: String(e.stderr ?? e.message) };
		}
	};
	try {
		await git("init", "-q");
		for (let attempt = 0; attempt < 2; attempt++) {
			const f = await git("fetch", "-q", remote.url, `+refs/heads/${base}:refs/remotes/o/${base}`, `+refs/heads/${branch}:refs/remotes/o/${branch}`);
			if (f.code !== 0) return { outcome: "conflict", detail: `Couldn't fetch from the git host: ${scrub(f.err)}` };
			await git("checkout", "-q", "-B", "work", `refs/remotes/o/${branch}`);
			let method: "fast-forward" | "rebase" = "fast-forward";
			if ((await git("merge-base", "--is-ancestor", `refs/remotes/o/${base}`, "HEAD")).code !== 0) {
				const rb = await git("rebase", `refs/remotes/o/${base}`);
				if (rb.code !== 0) {
					await git("rebase", "--abort");
					return { outcome: "conflict", detail: (rb.err || rb.out).slice(0, 300) };
				}
				method = "rebase";
			}
			const sha = (await git("rev-parse", "HEAD")).out;
			// No force: a default branch that moved meanwhile is refused, and the loop tries once more from its new tip.
			const p = await git("push", "-q", remote.url, `HEAD:refs/heads/${base}`);
			if (p.code === 0) return { outcome: "merged", method, sha };
		}
		return { outcome: "conflict", detail: "The default branch kept moving" };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Pushes a bundle's HEAD to `branch` on the host (never forced) from a throwaway repository: Pim pushes for a sandbox that holds no host credential. */
export async function pushBundle(remote: Remote, bundle: Uint8Array, branch: string): Promise<{ sha: string }> {
	const { writeFile } = await import("node:fs/promises");
	const dir = await mkdtemp(join(tmpdir(), "forge-push-"));
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
	if (remote.authorization) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${remote.authorization}` });
	const git = (...args: string[]) => run("git", args, { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 });
	try {
		await git("init", "-q");
		await writeFile(join(dir, "in.bundle"), bundle);
		await git("fetch", "-q", join(dir, "in.bundle"), "HEAD");
		const sha = (await git("rev-parse", "FETCH_HEAD")).stdout.trim();
		try {
			await git("push", "-q", remote.url, `${sha}:refs/heads/${branch}`);
		} catch (e: any) {
			throw new Error(`The git host refused the push: ${scrub(String(e.stderr ?? e.message))}`);
		}
		return { sha };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Deletes a branch on the host. */
export async function deleteBranch(remote: Remote, branch: string): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "forge-del-"));
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
	if (remote.authorization) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${remote.authorization}` });
	try {
		await run("git", ["init", "-q"], { cwd: dir, env });
		await run("git", ["push", "-q", remote.url, `:refs/heads/${branch}`], { cwd: dir, env });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Keeps a header or token out of an error that is shown to people. */
const scrub = (s: string) => s.replace(/Authorization:[^\n]*/gi, "Authorization: [redacted]").replace(/https?:\/\/[^@\s]*@/g, "https://").slice(0, 300);
