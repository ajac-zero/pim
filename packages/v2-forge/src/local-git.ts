// A GitHost over local bare repositories: for tests and local development. Branch policy is Forge's (authz.ts); this only moves refs, and never forces.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repoName } from "./authz";
import { type ComputeHandle } from "./compute";
import { ForgeError } from "./errors";
import { type MergeOutcome, type PushOutcome, type GitHost } from "./ports";
import { type LocalSandboxProvider } from "./local-sandbox";

const run = promisify(execFile);
const ID = ["-c", "user.name=Forge", "-c", "user.email=forge@example.invalid"];

export class LocalGitHost implements GitHost {
	readonly pullRequests: { repo: string; branch: string; base: string; title: string; number: number }[] = [];

	/** `bare` maps `owner/name` to a bare repository directory. */
	constructor(
		private readonly sandboxes: LocalSandboxProvider,
		private readonly bare: Record<string, string>,
	) {}

	private dir(repo: string): string {
		const d = this.bare[repoName(repo) ?? ""];
		if (!d) throw new ForgeError("not_found", `No repository ${repo}`);
		return d;
	}

	private async host(repo: string, ...args: string[]) {
		return (await run("git", ["--git-dir", this.dir(repo), ...args])).stdout.trim();
	}

	private async ws(h: ComputeHandle, ...args: string[]) {
		const r = await this.sandboxes.exec(h, ["git", ...ID, ...args]);
		return { ...r, out: r.stdout.trim() };
	}

	async defaultBranch(repo: string): Promise<string> {
		return this.host(repo, "symbolic-ref", "--short", "HEAD");
	}

	async hasBranch(repo: string, branch: string): Promise<boolean> {
		return run("git", ["--git-dir", this.dir(repo), "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
	}

	async push(h: ComputeHandle, repo: string, branch: string): Promise<PushOutcome> {
		const head = (await this.ws(h, "rev-parse", "HEAD")).out;
		if (!head) throw new ForgeError("nothing_to_push", "The workspace has no commits");
		const remote = (await this.hasBranch(repo, branch)) ? await this.host(repo, "rev-parse", `refs/heads/${branch}`) : null;
		if (remote === head) return { outcome: "unchanged", sha: head };
		const r = await this.ws(h, "push", this.dir(repo), `HEAD:refs/heads/${branch}`);
		if (r.code !== 0) throw new ForgeError("conflict", `The host refused the push (not a fast-forward): ${r.stderr.slice(0, 200)}`);
		return { outcome: "pushed", sha: head };
	}

	async merge(h: ComputeHandle, repo: string, branch: string): Promise<MergeOutcome> {
		const base = await this.defaultBranch(repo);
		for (let attempt = 0; attempt < 2; attempt++) {
			await this.ws(h, "fetch", this.dir(repo), `refs/heads/${base}`);
			const fast = (await this.ws(h, "merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD")).code === 0;
			let method: "fast-forward" | "rebase" = "fast-forward";
			if (!fast) {
				const rebased = await this.ws(h, "rebase", "FETCH_HEAD");
				if (rebased.code !== 0) {
					await this.ws(h, "rebase", "--abort");
					return { outcome: "conflict", detail: rebased.stderr.slice(0, 300) || rebased.stdout.slice(0, 300) };
				}
				method = "rebase";
			}
			const head = (await this.ws(h, "rev-parse", "HEAD")).out;
			// Without --force: a default branch that moved meanwhile is refused, and the loop retries once from the new tip.
			const pushed = await this.ws(h, "push", this.dir(repo), `HEAD:refs/heads/${base}`);
			if (pushed.code === 0) {
				return { outcome: "merged", method, sha: head };
			}
		}
		return { outcome: "conflict", detail: "The default branch kept moving" };
	}

	async deleteBranch(repo: string, branch: string): Promise<void> {
		await this.host(repo, "update-ref", "-d", `refs/heads/${branch}`);
	}

	async openPullRequest(repo: string, branch: string, base: string, title: string) {
		if (!(await this.hasBranch(repo, branch))) throw new ForgeError("not_pushed", `${branch} isn't on the host yet`);
		const number = this.pullRequests.length + 1;
		this.pullRequests.push({ repo, branch, base, title, number });
		return { url: `https://git.example.test/${repoName(repo)}/pull/${number}`, number };
	}

	async remoteDiff(repo: string, branch: string): Promise<string | null> {
		if (!(await this.hasBranch(repo, branch))) return null;
		return this.host(repo, "diff", `${await this.defaultBranch(repo)}...${branch}`);
	}
}
