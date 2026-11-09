/**
 * The settings of coding threads' git broker (./broker.ts): the GitHub App
 * it reads and pushes repositories with, and the rules for what it pushes.
 *
 * The App is the deployment's own, set as Worker secrets, as the sign-in
 * providers' clients are (../../auth/oauth.ts): secrets, not variables,
 * because a deploy keeps them.
 *
 * - `PIM_GITHUB_APP_ID`: the App's numeric ID.
 * - `PIM_GITHUB_APP_PRIVATE_KEY`: a private key of the App, the PEM file
 *   GitHub gives (`BEGIN RSA PRIVATE KEY`), or the same key as PKCS #8
 *   (`BEGIN PRIVATE KEY`).
 * - `PIM_GITHUB_APP_INSTALLATION_ID` (optional): the one installation to
 *   use; without it, Pim asks GitHub which installation has each repository.
 * - `PIM_GITHUB_APP_WEBHOOK_SECRET` (optional): for the App's webhooks,
 *   which nothing receives yet.
 *
 * Until the ID and key are both set, the App is not configured: anything
 * that needs it fails with `GitBrokerNotConfiguredError`, and public
 * repositories are still cloned anonymously.
 *
 * Two variables set the rules, whether or not the App is configured:
 *
 * - `PIM_GIT_BRANCH_PREFIX`: what every branch Pim pushes starts with,
 *   `pim/` when unset; `none` lets it push any branch but the default one,
 *   `main` and `master`.
 * - `PIM_GIT_REPOS`: the repositories coding threads may use, such as
 *   `acme/*, me/notes`; unset allows any on github.com.
 */

export const GITHUB_APP_SECRETS = {
	appId: "PIM_GITHUB_APP_ID",
	privateKey: "PIM_GITHUB_APP_PRIVATE_KEY",
	installationId: "PIM_GITHUB_APP_INSTALLATION_ID",
	webhookSecret: "PIM_GITHUB_APP_WEBHOOK_SECRET",
} as const;

export const NOT_CONFIGURED = "GitHub App not configured";

/** Something needed the GitHub App and the deployment hasn't set it up: a state to show, not a crash. */
export class GitBrokerNotConfiguredError extends Error {
	override readonly name = "GitBrokerNotConfiguredError";
	/** What to set, by name; null when nothing is set. */
	readonly problem: string | null;

	constructor(problem: string | null = null) {
		super(NOT_CONFIGURED);
		this.problem = problem;
	}
}

/** The App, with its private key: only ./github-app.ts reads it. */
export type GitHubAppConfig = {
	readonly appId: string;
	readonly privateKey: string;
	readonly installationId: string | null;
	readonly webhookSecret: string | null;
};

/** Whether the App is set up, as the admin may see it: never a secret. */
export type GitHubAppStatus =
	| { readonly configured: false; readonly reason: typeof NOT_CONFIGURED; readonly problem: string | null }
	| { readonly configured: true; readonly appId: string; readonly installationId: string | null; readonly webhookSecret: boolean };

function value(env: object, name: string): string | null {
	const given = (env as Record<string, unknown>)[name];
	const text = typeof given === "string" ? given.trim() : "";
	return text === "" ? null : text;
}

/** The App's settings, or what's wrong with them (null when none is set). Problems name variables, never values. */
function readGitHubApp(env: object): { config: GitHubAppConfig } | { problem: string | null } {
	const appId = value(env, GITHUB_APP_SECRETS.appId);
	// Secrets pasted on one line keep their line breaks as `\n`.
	const privateKey = value(env, GITHUB_APP_SECRETS.privateKey)?.replace(/\\n/g, "\n").trim() ?? null;
	const installationId = value(env, GITHUB_APP_SECRETS.installationId);
	const webhookSecret = value(env, GITHUB_APP_SECRETS.webhookSecret);
	if (appId === null && privateKey === null) return { problem: null };
	if (appId === null || privateKey === null) return { problem: `Set ${appId === null ? GITHUB_APP_SECRETS.appId : GITHUB_APP_SECRETS.privateKey} too.` };
	if (!/^\d{1,20}$/.test(appId)) return { problem: `${GITHUB_APP_SECRETS.appId} must be the App's numeric ID.` };
	if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKey)) return { problem: `${GITHUB_APP_SECRETS.privateKey} must be one of the App's private keys, in PEM.` };
	if (installationId !== null && !/^\d{1,20}$/.test(installationId)) return { problem: `${GITHUB_APP_SECRETS.installationId} must be a numeric installation ID.` };
	return { config: { appId, privateKey, installationId, webhookSecret } };
}

/** Whether the deployment set up the GitHub App, without any of its secrets. */
export function githubAppStatus(env: object): GitHubAppStatus {
	const read = readGitHubApp(env);
	if ("problem" in read) return { configured: false, reason: NOT_CONFIGURED, problem: read.problem };
	const { appId, installationId, webhookSecret } = read.config;
	return { configured: true, appId, installationId, webhookSecret: webhookSecret !== null };
}

/** The App's settings; throws `GitBrokerNotConfiguredError` without them. */
export function githubAppConfig(env: object): GitHubAppConfig {
	const read = readGitHubApp(env);
	if ("problem" in read) throw new GitBrokerNotConfiguredError(read.problem);
	return read.config;
}

/** What the broker lets coding threads do. */
export type BrokerPolicy = {
	/** What every pushed branch starts with; null for any branch (but the default one, `main` and `master`). */
	readonly branchPrefix: string | null;
	/** `owner/name` and `owner/*` patterns, lowercase; null for any repository. */
	readonly repos: readonly string[] | null;
};

export const DEFAULT_BRANCH_PREFIX = "pim/";

const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const REPO_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})\/(?:\*|[a-z0-9._-]{1,100})$/;

/**
 * The broker's rules. A prefix Pim can't read stays `pim/`, and a list of
 * repositories it can't read allows none, so a typo never loosens either.
 */
export function brokerPolicy(env: object): BrokerPolicy {
	const prefix = value(env, "PIM_GIT_BRANCH_PREFIX");
	const branchPrefix = prefix === null ? DEFAULT_BRANCH_PREFIX : prefix === "none" ? null : PREFIX.test(prefix) && !/\.\.|\/\/|\/\./.test(prefix) ? prefix : DEFAULT_BRANCH_PREFIX;
	const list = value(env, "PIM_GIT_REPOS");
	if (list === null) return { branchPrefix, repos: null };
	const patterns = list.toLowerCase().split(/[\s,]+/).filter(Boolean);
	return { branchPrefix, repos: patterns.every((pattern) => REPO_PATTERN.test(pattern)) ? patterns : [] };
}
