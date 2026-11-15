import { type RepoRef, GitBrokerError, repoAllowed } from "./broker";
import { type BrokerPolicy } from "./config";
import { GiteaConnection } from "./gitea-connection";
import type { Fetch } from "./github-app";
import type { GitAccess, GitCredential, GitProvider, ProviderInstance, PullRequestInput } from "./provider";

/**
 * A Gitea instance, through the one account Pim is connected as
 * (./gitea-connection.ts): every credential is that account's OAuth access
 * token, refreshed first when it is near its end. Gitea takes an OAuth
 * token as the password of git's HTTP basic auth, so the same credential
 * clones, fetches and pushes, and calls the API as a bearer token. The
 * account's own permissions decide which repositories that reaches.
 */

const OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The instance at `baseUrl` (its origin), as `id` names it. */
export const giteaInstance = (id: string, baseUrl: string): ProviderInstance => ({ id, kind: "gitea", baseUrl, label: "Gitea" });

export class GiteaProvider implements GitProvider {
	readonly instance: ProviderInstance;
	readonly connection: GiteaConnection;
	readonly #fetch: Fetch;

	constructor(instance: ProviderInstance, connection: GiteaConnection, options: { fetch?: Fetch } = {}) {
		this.instance = instance;
		this.connection = connection;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
	}

	/** A repository by its URL on this instance: `<base>/<owner>/<name>`, `.git` and a trailing slash optional, and nothing else. */
	parseRepoUrl(input: string, policy: Pick<BrokerPolicy, "repos"> = { repos: null }): RepoRef {
		const refuse = () => new GitBrokerError(400, `A repository must be ${this.instance.baseUrl}/<owner>/<name>`);
		if (typeof input !== "string" || input.length > 300 || !/^[A-Za-z0-9:/._-]+$/.test(input)) throw refuse();
		const url = URL.parse(input);
		const base = URL.parse(this.instance.baseUrl);
		if (!url || !base || url.protocol !== "https:" || url.host !== base.host || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw refuse();
		const parts = url.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
		if (parts.length !== 2) throw refuse();
		const [owner, given] = [parts[0]!, parts[1]!];
		const name = given.endsWith(".git") ? given.slice(0, -4) : given;
		if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") throw refuse();
		const repo = { owner, name, fullName: `${owner}/${name}` };
		if (!repoAllowed(repo, policy.repos)) throw new GitBrokerError(403, `This Pim doesn't let coding threads use ${repo.fullName}`);
		return repo;
	}

	repoUrl(repo: RepoRef): string {
		return `${this.instance.baseUrl}/${repo.fullName}`;
	}

	gitUrl(repo: RepoRef): string {
		return `${this.instance.baseUrl}/${repo.owner}/${repo.name}.git`;
	}

	/** The connected account's token, as the basic-auth password; throws `GiteaNotConnectedError` when there is none, for reading too: Gitea repositories are never cloned anonymously. */
	async credential(_repo: RepoRef, _access: GitAccess): Promise<GitCredential | null> {
		return { username: "oauth2", token: await this.connection.accessToken() };
	}

	async #api(repo: RepoRef, path: string, init: RequestInit = {}): Promise<Response> {
		const { token } = (await this.credential(repo, "read"))!;
		try {
			return await this.#fetch(`${this.instance.baseUrl}/api/v1/repos/${repo.owner}/${repo.name}${path}`, {
				...init,
				headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
		} catch {
			throw new GitBrokerError(502, "Gitea couldn't be reached");
		}
	}

	async defaultBranch(repo: RepoRef): Promise<string> {
		const response = await this.#api(repo, "");
		if (!response.ok) throw new GitBrokerError(502, `Gitea answered HTTP ${response.status} when asked about ${repo.fullName}`);
		const { default_branch: name } = (await response.json()) as { default_branch?: unknown };
		if (typeof name !== "string" || name === "") throw new GitBrokerError(502, `Gitea didn't say ${repo.fullName}'s default branch`);
		return name;
	}

	/**
	 * Whether `ancestor` is reachable from `descendant`, which the instance
	 * must already have (a push moves a branch forward only if so): comparing
	 * `descendant...ancestor` lists the commits `ancestor` has that
	 * `descendant` lacks, and there are none exactly when it is.
	 */
	async isAncestor(repo: RepoRef, ancestor: string, descendant: string): Promise<boolean> {
		const response = await this.#api(repo, `/compare/${descendant}...${ancestor}`);
		if (!response.ok) throw new GitBrokerError(502, `Gitea answered HTTP ${response.status} when comparing commits of ${repo.fullName}`);
		const { total_commits: total } = (await response.json()) as { total_commits?: unknown };
		if (typeof total !== "number") throw new GitBrokerError(502, "Gitea's comparison answer was malformed");
		return total === 0;
	}

	/**
	 * Opens a pull request, or finds the open one from `head` into `base` when
	 * Gitea says there is one already (409, or 422 for some versions), so asking
	 * again for the same branch answers with the same pull request.
	 */
	async createPullRequest({ repo, head, base, title, body }: PullRequestInput): Promise<{ url: string; number: number }> {
		const response = await this.#api(repo, "/pulls", { method: "POST", body: JSON.stringify({ head, base, title, body }) });
		if (response.ok) return pullRequestOf(await response.json());
		if (response.status === 409 || response.status === 422) {
			const listed = await this.#api(repo, "/pulls?state=open&limit=50");
			if (listed.ok) {
				const open = (await listed.json()) as { head?: { ref?: unknown }; base?: { ref?: unknown }; html_url?: unknown; number?: unknown }[];
				const existing = Array.isArray(open) ? open.find((pull) => pull.head?.ref === head && pull.base?.ref === base) : undefined;
				if (existing) return pullRequestOf(existing);
			}
		}
		throw new GitBrokerError(502, `Gitea answered HTTP ${response.status} when opening a pull request on ${repo.fullName}`);
	}
}

function pullRequestOf(made: unknown): { url: string; number: number } {
	const { html_url: url, number } = (made ?? {}) as { html_url?: unknown; number?: unknown };
	if (typeof url !== "string" || typeof number !== "number") throw new GitBrokerError(502, "Gitea's pull request answer was malformed");
	return { url, number };
}
