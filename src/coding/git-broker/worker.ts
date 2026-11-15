import { base64UrlDecode } from "@pim/shared/encoding";
import { brokerKey } from "@pim/coding/git-broker/broker";
import { brokerPolicy, GITEA_INSTANCE_ID, giteaBaseUrl, giteaConfig, githubAppConfig, githubAppStatus } from "@pim/coding/git-broker/config";
import { type GiteaBackend, GiteaConnection, giteaKeyFrom } from "@pim/coding/git-broker/gitea-connection";
import { giteaInstance, GiteaProvider } from "@pim/coding/git-broker/gitea-provider";
import { type Fetch, GitHubApp } from "@pim/coding/git-broker/github-app";
import { GitHubProvider } from "@pim/coding/git-broker/github-provider";
import { ProviderRegistry } from "@pim/coding/git-broker/provider";
import { handleGitBroker } from "@pim/coding/git-broker/routes";

// The git broker (@pim/coding/git-broker/routes) as the Worker wires it: keys, the App and Gitea from the Directory and the environment, and a push told to its thread.

let keyPromise: Promise<CryptoKey> | null = null;

/** The key this Pim signs broker tokens with, derived from the Directory's own key and read once per isolate. */
export function brokerTokenKey(env: Env): Promise<CryptoKey> {
	if (!keyPromise) {
		const key = env.Directory.getByName("directory")
			.cookieKey()
			.then((raw) => brokerKey(base64UrlDecode(raw)));
		keyPromise = key;
		key.catch(() => {
			if (keyPromise === key) keyPromise = null;
		});
	}
	return keyPromise;
}

let cachedApp: { signature: string; app: GitHubApp } | null = null;

/** The deployment's GitHub App, made once per isolate and settings, or null when it isn't configured. */
export function deploymentGitHubApp(env: object): GitHubApp | null {
	if (!githubAppStatus(env).configured) return null;
	const config = githubAppConfig(env);
	const signature = JSON.stringify(config);
	if (cachedApp?.signature !== signature) cachedApp = { signature, app: new GitHubApp(config) };
	return cachedApp.app;
}

/** The Directory's Gitea connection store, which holds only sealed tokens. */
export function directoryGiteaBackend(env: Env): GiteaBackend {
	const directory = () => env.Directory.getByName("directory");
	return {
		read: async (instance) => directory().giteaRead(instance),
		write: async (instance, sealed, login, expectedVersion) => directory().giteaWrite(instance, sealed, login, expectedVersion),
		claimRefresh: async (instance, version, leaseMs) => directory().giteaClaimRefresh(instance, version, leaseMs),
		releaseRefresh: async (instance, version) => directory().giteaReleaseRefresh(instance, version),
		markNeedsReconnect: async (instance, expectedVersion) => directory().giteaMarkNeedsReconnect(instance, expectedVersion),
		disconnect: async (instance) => directory().giteaDisconnect(instance),
		createState: async (hash, ownerId, ttlMs) => directory().giteaCreateState(hash, ownerId, ttlMs),
		consumeState: async (hash) => directory().giteaConsumeState(hash),
	};
}

/** Stands in for the base URL while `PIM_GITEA_BASE_URL` is unset: reserved, never reachable, and the provider is then not registered. */
const UNSET_GITEA_URL = "https://gitea.invalid";

/** The deployment's Gitea: always registered, and not connected until the owner signs in (./gitea-connection.ts). */
export function deploymentGitea(env: Env, options: { fetch?: Fetch } = {}): GiteaProvider {
	const connection = new GiteaConnection({
		instanceId: GITEA_INSTANCE_ID,
		config: giteaConfig(env),
		backend: directoryGiteaBackend(env),
		key: async () => giteaKeyFrom(await env.Directory.getByName("directory").cookieKey()),
		...options,
	});
	return new GiteaProvider(giteaInstance(GITEA_INSTANCE_ID, giteaBaseUrl(env) ?? UNSET_GITEA_URL), connection, options);
}

/** The git providers of this deployment: GitHub, with its App when it is configured, and Gitea. */
export function deploymentProviders(env: Env, options: { fetch?: Fetch; app?: GitHubApp | null } = {}): ProviderRegistry {
	const { app = deploymentGitHubApp(env), ...rest } = options;
	return new ProviderRegistry([new GitHubProvider(app, { policy: brokerPolicy(env), ...rest }), ...(giteaBaseUrl(env) === null ? [] : [deploymentGitea(env, rest)])]);
}

/** The broker, as the Worker serves it at `/api` + `path`. */
export async function serveGitBroker(request: Request, env: Env, path: string): Promise<Response> {
	return handleGitBroker(request, path, { key: await brokerTokenKey(env), app: deploymentGitHubApp(env), policy: brokerPolicy(env), providers: deploymentProviders(env), onPushed: ({ sessionId, ...event }) => env.CodingThread.getByName(sessionId).recordSandboxPush(event) });
}
