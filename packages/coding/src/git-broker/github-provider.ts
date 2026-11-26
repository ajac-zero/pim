import { apiHeaders, GITHUB_API, type Fetch, type GitHubApp, RepoNotInstalledError } from "./github-app";
import { GitBrokerError, listBranchesOverGit, readCapped, type RepoRef, parseRepoUrl, repoDefaultBranch } from "./broker";
import { GitBrokerNotConfiguredError } from "./config";
import { type GitAccess, type GitCredential, type GitProvider, GITHUB_INSTANCE, MAX_COMPARE_CHARS, type ProviderInstance, type PullRequestInput } from "./provider";

/**
 * github.com, through the deployment's GitHub App (./github-app.ts): every
 * credential is an installation token for one repository, at the least
 * access asked for. The behavior is the broker's own; this wraps it.
 */
export class GitHubProvider implements GitProvider {
	readonly instance: ProviderInstance = GITHUB_INSTANCE;
	readonly #app: GitHubApp | null;
	readonly #fetch: Fetch;

	/** `app` is null when the deployment hasn't set the App up: public repositories are still read anonymously. */
	constructor(app: GitHubApp | null, options: { fetch?: Fetch } = {}) {
		this.#app = app;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
	}

	parseRepoUrl(input: string): RepoRef {
		return parseRepoUrl(input);
	}

	repoUrl(repo: RepoRef): string {
		return `${this.instance.baseUrl}/${repo.fullName}`;
	}

	gitUrl(repo: RepoRef): string {
		return `${this.instance.baseUrl}/${repo.owner}/${repo.name}.git`;
	}

	async credential(repo: RepoRef, access: GitAccess): Promise<GitCredential | null> {
		if (!this.#app) {
			if (access === "read") return null;
			throw new GitBrokerNotConfiguredError();
		}
		try {
			return { username: "x-access-token", token: (await this.#app.installationToken(repo, access)).token };
		} catch (error) {
			if (access === "read" && error instanceof RepoNotInstalledError) return null;
			throw error;
		}
	}

	defaultBranch(repo: RepoRef): Promise<string> {
		return repoDefaultBranch({ app: this.#app, fetch: this.#fetch }, this.repoUrl(repo));
	}

	async listBranches(repo: RepoRef): Promise<ReadonlyMap<string, string>> {
		return listBranchesOverGit(this.#fetch, this.gitUrl(repo), await this.credential(repo, "read"));
	}

	/** A read of GitHub's API, with the repository's read token when there is one, and anonymously when there isn't. */
	async #read(repo: RepoRef, path: string, accept?: string): Promise<Response> {
		const credential = await this.credential(repo, "read");
		try {
			return await this.#fetch(`${GITHUB_API}/repos/${repo.owner}/${repo.name}${path}`, {
				headers: credential ? { ...apiHeaders(`Bearer ${credential.token}`), ...(accept ? { Accept: accept } : {}) } : { Accept: accept ?? "application/vnd.github+json", "User-Agent": "pim-git-broker", "X-GitHub-Api-Version": "2022-11-28" },
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
		} catch {
			throw new GitBrokerError(502, "GitHub couldn't be reached");
		}
	}

	async resolveCommit(repo: RepoRef, ref: string): Promise<string | null> {
		const response = await this.#read(repo, `/commits/${ref.split("/").map(encodeURIComponent).join("/")}`);
		if (response.status === 404 || response.status === 422) {
			await response.body?.cancel().catch(() => {});
			return null;
		}
		if (!response.ok) throw new GitBrokerError(502, `GitHub answered HTTP ${response.status} when looking up ${ref} on ${repo.fullName}`);
		const { sha } = (await response.json()) as { sha?: unknown };
		return typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
	}

	async compareDiff(repo: RepoRef, base: string, head: string): Promise<{ baseSha: string; headSha: string; diff: string } | null> {
		const [baseSha, headSha] = [/^[0-9a-f]{40}$/i.test(base) ? base.toLowerCase() : await this.resolveCommit(repo, base), /^[0-9a-f]{40}$/i.test(head) ? head.toLowerCase() : await this.resolveCommit(repo, head)];
		if (!baseSha || !headSha) return null;
		const response = await this.#read(repo, `/compare/${baseSha}...${headSha}`, "application/vnd.github.v3.diff");
		if (response.status === 404 || response.status === 422) {
			await response.body?.cancel().catch(() => {});
			return null;
		}
		if (!response.ok) throw new GitBrokerError(502, `GitHub answered HTTP ${response.status} when comparing commits of ${repo.fullName}`);
		return { baseSha, headSha, diff: await readCapped(response, MAX_COMPARE_CHARS) };
	}

	async createPullRequest({ repo, head, base, title, body }: PullRequestInput): Promise<{ url: string; number: number }> {
		const credential = await this.credential(repo, "write");
		if (!credential) throw new GitBrokerNotConfiguredError();
		let response: Response;
		try {
			response = await this.#fetch(`${GITHUB_API}/repos/${repo.owner}/${repo.name}/pulls`, {
				method: "POST",
				headers: { ...apiHeaders(`Bearer ${credential.token}`), "Content-Type": "application/json" },
				body: JSON.stringify({ head, base, title, body }),
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
		} catch {
			throw new GitBrokerError(502, "GitHub couldn't be reached");
		}
		let made: unknown;
		if (response.ok) made = await response.json();
		else {
			// 422 is also GitHub's answer when a pull request from the branch is open already: find it, so asking again is the same pull request.
			if (response.status === 422) {
				try {
					const listed = await this.#fetch(`${GITHUB_API}/repos/${repo.owner}/${repo.name}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${head}`)}&base=${encodeURIComponent(base)}`, {
						headers: apiHeaders(`Bearer ${credential.token}`),
						redirect: "manual",
						signal: AbortSignal.timeout(30_000),
					});
					if (listed.ok) made = ((await listed.json()) as unknown[])[0];
				} catch {}
			}
			if (!made) throw new GitBrokerError(502, `GitHub answered HTTP ${response.status} when opening a pull request on ${repo.fullName}`);
		}
		const { html_url: url, number } = made as { html_url?: unknown; number?: unknown };
		if (typeof url !== "string" || typeof number !== "number") throw new GitBrokerError(502, "GitHub's pull request answer was malformed");
		return { url, number };
	}
}
