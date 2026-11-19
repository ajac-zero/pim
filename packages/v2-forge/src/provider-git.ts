// The real GitHost: `@pim/coding`'s GitProvider (the GitHub App or Gitea) behind Forge's port, and the broker's upstream resolver over the same providers.
import { basicAuth, type GitProvider, type ProviderRegistry } from "@pim/coding/git-broker/provider";
import { type BrokerPolicy } from "@pim/coding/git-broker/config";
import { type ComputeHandle, type ComputeProvider } from "./compute";
import { deleteBranch, mergeBranch, pushBundle, type Remote } from "./gitops";
import { ForgeError } from "./errors";
import { type GitHost, type MergeOutcome, type PushOutcome } from "./ports";
import { type GitUpstream } from "./http/git-broker";

export type ProviderGitDeps = { registry: ProviderRegistry; policy?: Pick<BrokerPolicy, "repos">; compute?: ComputeProvider; /** Where the checkout is in a sandbox, and where a push's bundle is staged. */ repoDir?: string; scratchDir?: string };

async function remoteOf(provider: GitProvider, repo: ReturnType<GitProvider["parseRepoUrl"]>, access: "read" | "write"): Promise<Remote> {
	const cred = await provider.credential(repo, access);
	return { url: provider.gitUrl(repo), authorization: cred ? basicAuth(cred) : null };
}

/** The broker's upstream: the host's smart HTTP endpoint and the deployment's credential for it, which never reaches a sandbox. */
export function providerUpstream(d: ProviderGitDeps): GitUpstream {
	return async (repoUrl, access) => {
		const { provider, repo } = d.registry.resolveUrl(repoUrl, d.policy);
		const r = await remoteOf(provider, repo, access);
		return { url: r.url, authorization: r.authorization ?? null };
	};
}

export class ProviderGitHost implements GitHost {
	constructor(private readonly d: ProviderGitDeps) {}

	private resolve(repoUrl: string) {
		return this.d.registry.resolveUrl(repoUrl, this.d.policy);
	}

	defaultBranch(repoUrl: string) {
		const { provider, repo } = this.resolve(repoUrl);
		return provider.defaultBranch(repo);
	}

	async hasBranch(repoUrl: string, branch: string) {
		const { provider, repo } = this.resolve(repoUrl);
		return (await provider.listBranches(repo)).has(branch);
	}

	async branches(repoUrl: string) {
		const { provider, repo } = this.resolve(repoUrl);
		return provider.listBranches(repo);
	}

	async resolveCommit(repoUrl: string, ref: string) {
		const { provider, repo } = this.resolve(repoUrl);
		return provider.resolveCommit(repo, ref);
	}

	async remoteDiff(repoUrl: string, branch: string, since?: string): Promise<string | null> {
		const { provider, repo } = this.resolve(repoUrl);
		// A commit of the host is as good as a branch to compare to.
		if (!(await this.hasBranch(repoUrl, branch)) && !/^[0-9a-f]{7,40}$/i.test(branch)) return null;
		return (await provider.compareDiff(repo, since ?? (await provider.defaultBranch(repo)), branch))?.diff ?? null;
	}

	async openPullRequest(repoUrl: string, branch: string, base: string, title: string, body = "") {
		const { provider, repo } = this.resolve(repoUrl);
		return provider.createPullRequest({ repo, head: branch, base, title, body });
	}

	async isAncestor(repoUrl: string, ancestor: string, descendant: string): Promise<boolean> {
		const { provider, repo } = this.resolve(repoUrl);
		if (!provider.isAncestor) throw new ForgeError("push_refused", `${provider.instance.label} can't tell whether a push only moves a branch forward`);
		return provider.isAncestor(repo, ancestor, descendant);
	}

	async deleteBranch(repoUrl: string, branch: string): Promise<void> {
		const { provider, repo } = this.resolve(repoUrl);
		await deleteBranch(await remoteOf(provider, repo, "write"), branch);
	}

	/** Pim pushes for the sandbox: the checkout's HEAD is bundled, brought here and pushed with the deployment's credential. */
	async push(h: ComputeHandle, repoUrl: string, branch: string): Promise<PushOutcome> {
		const { compute } = this.d;
		if (!compute?.workspace) throw new ForgeError("workspace_not_running", "No sandbox to push from");
		const repoDir = this.d.repoDir ?? "/workspace/repo";
		const bundlePath = `${this.d.scratchDir ?? "/workspace"}/.pim-push.bundle`;
		const head = (await compute.exec(h, ["git", "-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();
		if (!head) throw new ForgeError("nothing_to_push", "The workspace has no commits");
		const { provider, repo } = this.resolve(repoUrl);
		if ((await provider.listBranches(repo)).get(branch) === head) return { outcome: "unchanged", sha: head };
		const made = await compute.exec(h, ["git", "-C", repoDir, "bundle", "create", bundlePath, "HEAD"]);
		if (made.code !== 0) throw new ForgeError("nothing_to_push", "The workspace has nothing to push");
		try {
			const ws = await compute.workspace(h);
			const bundle = await ws.readFile(bundlePath);
			if (bundle.length > 64 * 1024 * 1024) throw new ForgeError("push_refused", "The push is too big");
			const { sha } = await pushBundle(await remoteOf(provider, repo, "write"), bundle, branch);
			return { outcome: "pushed", sha };
		} finally {
			await compute.exec(h, ["rm", "-f", bundlePath]).catch(() => {});
		}
	}

	async mergeBranch(repoUrl: string, branch: string): Promise<MergeOutcome> {
		const { provider, repo } = this.resolve(repoUrl);
		return mergeBranch(await remoteOf(provider, repo, "write"), await provider.defaultBranch(repo), branch);
	}
}
