import { type BrokerPolicy } from "./config";
import type { RepoRef } from "./broker";
import { GitBrokerError } from "./broker";

/**
 * The git hosts coding threads can work with. A provider instance is one
 * host, such as github.com; a provider is how the broker talks to it: it
 * reads a repository's URL, signs in to the host's git for a repository,
 * names where git clones and pushes, finds the default branch, and opens a
 * pull request. What Pim allows is not the provider's to decide: push
 * approvals and the branch rules (`pim/` prefix, protected `main` and
 * `master`) are the broker's, the same for every provider.
 *
 * A repository is identified by its instance's id and its `owner/name`.
 * Threads stored before instances existed have none, which means GitHub.
 */

export type ProviderKind = "github" | "gitea";

export type ProviderInstance = {
	readonly id: string;
	readonly kind: ProviderKind;
	/** The host's origin, such as `https://github.com`, with no path and no trailing slash. */
	readonly baseUrl: string;
	/** What people see it called. */
	readonly label: string;
};

/** The instance a thread belongs to when it doesn't say. */
export const GITHUB_INSTANCE_ID = "github";

/** The one instance Pim is seeded with. */
export const GITHUB_INSTANCE: ProviderInstance = { id: GITHUB_INSTANCE_ID, kind: "github", baseUrl: "https://github.com", label: "GitHub" };

export const SEEDED_INSTANCES: readonly ProviderInstance[] = [GITHUB_INSTANCE];

/** How git signs in to a host: HTTP basic auth with this user name and token. Never logged, never in a URL. */
export type GitCredential = { readonly username: string; readonly token: string };

/** What a token may do with the repository's contents. */
export type GitAccess = "read" | "write";

export type PullRequestInput = { readonly repo: RepoRef; readonly head: string; readonly base: string; readonly title: string; readonly body: string };

export interface GitProvider {
	readonly instance: ProviderInstance;
	/** The repository a URL on this provider's host names, if the policy lets it be used; throws `GitBrokerError` otherwise. */
	parseRepoUrl(input: string, policy?: Pick<BrokerPolicy, "repos">): RepoRef;
	/** The repository's canonical web URL, which threads store. */
	repoUrl(repo: RepoRef): string;
	/** The URL git clones, fetches and pushes: the repository's smart HTTP endpoint, ending in `.git`. */
	gitUrl(repo: RepoRef): string;
	/**
	 * A credential for git smart HTTP. Reading returns null when the provider
	 * has none for the repository (a public one is cloned anonymously);
	 * writing throws when there is none.
	 */
	credential(repo: RepoRef, access: GitAccess): Promise<GitCredential | null>;
	/** The name of the repository's default branch. */
	defaultBranch(repo: RepoRef): Promise<string>;
	/**
	 * Whether `ancestor` is reachable from `descendant`, a commit the host already has. A provider whose
	 * host can't move a branch forward only (GitHub does, in its API) answers this, so that the broker can.
	 */
	isAncestor?(repo: RepoRef, ancestor: string, descendant: string): Promise<boolean>;
	/** Opens a pull request from `head` into `base`. */
	createPullRequest(input: PullRequestInput): Promise<{ readonly url: string; readonly number: number }>;
}

/** The `Authorization` header value for git over HTTP. */
export const basicAuth = (credential: GitCredential) => `Basic ${btoa(`${credential.username}:${credential.token}`)}`;

/** The providers of a deployment, by instance id. */
export class ProviderRegistry {
	readonly #providers = new Map<string, GitProvider>();

	constructor(providers: readonly GitProvider[]) {
		for (const provider of providers) {
			if (this.#providers.has(provider.instance.id)) throw new Error(`Two git provider instances are called ${provider.instance.id}`);
			this.#providers.set(provider.instance.id, provider);
		}
		if (!this.#providers.has(GITHUB_INSTANCE_ID)) throw new Error("The git providers must include the github instance");
	}

	instances(): ProviderInstance[] {
		return [...this.#providers.values()].map((provider) => provider.instance);
	}

	/** The provider of an instance; `undefined` or `null` means GitHub, as for threads stored before instances existed. */
	get(id: string | null | undefined): GitProvider {
		const provider = this.#providers.get(id ?? GITHUB_INSTANCE_ID);
		if (!provider) throw new GitBrokerError(400, `This Pim has no git provider instance ${id}`);
		return provider;
	}

	/**
	 * The provider whose host `input` is a URL on, and the repository it names.
	 * A URL on no known host is held to GitHub's rules, which refuse it.
	 */
	resolveUrl(input: string, policy?: Pick<BrokerPolicy, "repos">): { readonly provider: GitProvider; readonly repo: RepoRef } {
		const host = typeof input === "string" ? URL.parse(input)?.hostname : undefined;
		const provider = (host && [...this.#providers.values()].find((candidate) => URL.parse(candidate.instance.baseUrl)?.hostname === host)) || this.get(GITHUB_INSTANCE_ID);
		return { provider, repo: provider.parseRepoUrl(input, policy) };
	}
}
