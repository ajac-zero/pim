import { apiHeaders, GITHUB_API, type Fetch, type GitHubApp, RepoNotInstalledError } from "./github-app";
import { GitBrokerError, type RepoRef, parseRepoUrl, repoDefaultBranch } from "./broker";
import { type BrokerPolicy, GitBrokerNotConfiguredError } from "./config";
import { type GitAccess, type GitCredential, type GitProvider, GITHUB_INSTANCE, type ProviderInstance, type PullRequestInput } from "./provider";

/**
 * github.com, through the deployment's GitHub App (./github-app.ts): every
 * credential is an installation token for one repository, at the least
 * access asked for. The behavior is the broker's own; this wraps it.
 */
export class GitHubProvider implements GitProvider {
	readonly instance: ProviderInstance = GITHUB_INSTANCE;
	readonly #app: GitHubApp | null;
	readonly #fetch: Fetch;
	readonly #policy: BrokerPolicy;

	/** `app` is null when the deployment hasn't set the App up: public repositories are still read anonymously. */
	constructor(app: GitHubApp | null, options: { fetch?: Fetch; policy?: BrokerPolicy } = {}) {
		this.#app = app;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#policy = options.policy ?? { branchPrefix: null, repos: null };
	}

	parseRepoUrl(input: string, policy: Pick<BrokerPolicy, "repos"> = { repos: null }): RepoRef {
		return parseRepoUrl(input, policy);
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
		return repoDefaultBranch({ app: this.#app, policy: this.#policy, fetch: this.#fetch }, this.repoUrl(repo));
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
		if (!response.ok) throw new GitBrokerError(502, `GitHub answered HTTP ${response.status} when opening a pull request on ${repo.fullName}`);
		const made = (await response.json()) as { html_url?: unknown; number?: unknown };
		if (typeof made.html_url !== "string" || typeof made.number !== "number") throw new GitBrokerError(502, "GitHub's pull request answer was malformed");
		return { url: made.html_url, number: made.number };
	}
}
