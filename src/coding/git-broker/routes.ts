import { base64UrlDecode } from "../../auth/encoding";
import { dispatch, type Route } from "../../http";
import { type BrokerClaims, brokerKey, GitBrokerError, type RepoRef, repoRef, verifyBrokerToken } from "./broker";
import { type BrokerPolicy, brokerPolicy, GITEA_INSTANCE_ID, giteaBaseUrl, giteaConfig, githubAppConfig, githubAppStatus } from "./config";
import { GiteaConnection, type GiteaBackend, giteaKeyFrom, GiteaNotConnectedError } from "./gitea-connection";
import { giteaInstance, GiteaProvider } from "./gitea-provider";
import { type Fetch, GitHubApp } from "./github-app";
import { GitHubProvider } from "./github-provider";
import { basicAuth, GITHUB_INSTANCE_ID, type GitProvider, ProviderRegistry } from "./provider";

/**
 * The broker's one public door, under `/api`: git's smart HTTP protocol for
 * cloning and fetching, at `/api/coding/git/<owner>/<name>.git`, for a
 * workspace that holds a broker token for that repository (./broker.ts).
 * Git sends the token as the password of HTTP basic auth (any user name),
 * or as a bearer token (`http.extraHeader`). Only `git-upload-pack` is
 * served, so the workspace can read the repository and never write to it;
 * pushes are Pim's own, after approval (`pushBranch`).
 *
 * The broker asks GitHub with a read-only installation token for that
 * repository when the GitHub App is installed on it, and anonymously
 * otherwise, which is enough for public repositories.
 */

export const GIT_BROKER_PATH = "/coding/git";

/** The largest request git sends while negotiating a fetch: 8 MiB. */
export const MAX_UPLOAD_REQUEST_BYTES = 8 * 1024 * 1024;
/** The most the broker passes on from GitHub in one answer: 1 GiB. */
export const MAX_FETCH_RESPONSE_BYTES = 1024 * 1024 * 1024;

export type GitBrokerDeps = {
	/** The key broker tokens are signed with (`brokerKey`). */
	readonly key: CryptoKey;
	/** The deployment's GitHub App; null when it isn't configured. */
	readonly app: GitHubApp | null;
	readonly policy: BrokerPolicy;
	/** The deployment's git providers; without them, only GitHub's. */
	readonly providers?: ProviderRegistry;
	readonly fetch?: Fetch;
	readonly now?: () => number;
	readonly maxRequestBytes?: number;
	readonly maxResponseBytes?: number;
};

const text = (status: number, message: string, headers: Record<string, string> = {}) =>
	new Response(`${message}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });

/** The token git presented: the password of basic auth, or a bearer token. */
function presentedToken(request: Request): string | null {
	const header = request.headers.get("Authorization") ?? "";
	if (header.startsWith("Bearer ")) return header.slice(7).trim();
	if (!header.startsWith("Basic ")) return null;
	try {
		const decoded = atob(header.slice(6).trim());
		const colon = decoded.indexOf(":");
		return colon < 0 ? null : decoded.slice(colon + 1);
	} catch {
		return null;
	}
}

/** The repository a request is for, if its broker token is for it; else the answer that makes git ask for credentials, or refuses. */
async function admit(deps: GitBrokerDeps, params: Readonly<Record<string, string>>, request: Request): Promise<{ repo: RepoRef; claims: BrokerClaims; provider: GitProvider } | Response> {
	const token = presentedToken(request);
	const claims = token ? await verifyBrokerToken(deps.key, token, (deps.now ?? Date.now)()) : null;
	if (!claims) return text(401, "This needs the coding session's broker token", { "WWW-Authenticate": 'Basic realm="Pim git broker"' });
	const instance = params.instance ?? GITHUB_INSTANCE_ID;
	if (claims.instance !== instance) throw new GitBrokerError(403, "This broker token is for another repository");
	const provider = providerOf(deps, instance);
	const repo = instance === GITHUB_INSTANCE_ID ? repoRef(params.owner!, params.repo!, deps.policy) : provider.parseRepoUrl(`${provider.instance.baseUrl}/${params.owner}/${params.repo}`, deps.policy);
	if (claims.repo !== repo.fullName.toLowerCase()) throw new GitBrokerError(403, "This broker token is for another repository");
	return { repo, claims, provider };
}

/** The provider of an instance: GitHub's, made from the App, unless the deployment has its own providers. */
function providerOf(deps: GitBrokerDeps, instance: string): GitProvider {
	return deps.providers ? deps.providers.get(instance) : new GitHubProvider(deps.app);
}

/** How the broker signs in to GitHub for `repo`: a read-only token when the App is installed on it, else nothing. */
async function credentials(provider: GitProvider, repo: RepoRef): Promise<string | null> {
	try {
		const credential = await provider.credential(repo, "read");
		return credential && basicAuth(credential);
	} catch (error) {
		if (error instanceof GiteaNotConnectedError) throw error;
		throw new GitBrokerError(502, `Pim couldn't get access to ${repo.fullName} from ${provider.instance.label}`);
	}
}

/** `request`'s body, refused past `max` bytes, whatever its length says. */
async function readCapped(request: Request, max: number): Promise<Uint8Array> {
	const tooLarge = () => new GitBrokerError(413, `git's request is larger than the ${max} bytes the broker takes`);
	if (Number(request.headers.get("Content-Length") ?? 0) > max) throw tooLarge();
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			throw tooLarge();
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}
	return body;
}

/** Asks GitHub for `path` of `repo`'s smart HTTP service and passes the answer on, up to the size cap. */
async function proxy(
	deps: GitBrokerDeps,
	admitted: { repo: RepoRef; claims: BrokerClaims; provider: GitProvider },
	request: Request,
	path: string,
	init: { method: string; body?: Uint8Array; contentType: string; expected: string },
): Promise<Response> {
	const { repo, claims, provider } = admitted;
	const name = provider.instance.label;
	const headers: Record<string, string> = { "User-Agent": "git/pim-git-broker", Accept: init.expected };
	const authorization = await credentials(provider, repo);
	if (authorization) headers.Authorization = authorization;
	if (init.body) headers["Content-Type"] = init.contentType;
	const encoding = request.headers.get("Content-Encoding");
	if (init.body && encoding === "gzip") headers["Content-Encoding"] = encoding;
	const protocol = request.headers.get("Git-Protocol");
	if (protocol && /^[A-Za-z0-9=:. -]{1,100}$/.test(protocol)) headers["Git-Protocol"] = protocol;
	let answer: Response;
	try {
		answer = await (deps.fetch ?? ((input, init) => fetch(input, init)))(`${provider.gitUrl(repo)}${path}`, {
			method: init.method,
			headers,
			...(init.body ? { body: init.body } : {}),
			// A redirect could lead anywhere; the broker reaches its providers' hosts only.
			redirect: "manual",
		});
	} catch {
		return text(502, `${name} couldn't be reached`);
	}
	const ok = answer.status === 200 && answer.headers.get("Content-Type")?.split(";")[0]!.trim() === init.expected && answer.body !== null;
	if (!ok) {
		console.log(JSON.stringify({ event: "pim.git_broker.fetch", session: claims.sessionId, repo: repo.fullName, status: answer.status }));
		await answer.body?.cancel();
		if ([301, 302, 307, 308, 401, 403, 404].includes(answer.status)) {
			const why = provider.instance.kind === "gitea" ? "Pim's Gitea account can't read it" : deps.app ? "the GitHub App isn't installed on it" : "this Pim's GitHub App isn't configured";
			return text(404, `Pim can't read ${repo.fullName} on ${name}: it is private, moved or gone, or ${why}`);
		}
		return text(502, `${name} answered HTTP ${answer.status}`);
	}
	const max = deps.maxResponseBytes ?? MAX_FETCH_RESPONSE_BYTES;
	let seen = 0;
	const body = answer.body!.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				if (seen > max) controller.error(new GitBrokerError(413, `${repo.fullName} is larger than the ${max} bytes the broker passes on at once`));
				else controller.enqueue(chunk);
			},
		}),
	);
	return new Response(body, { status: 200, headers: { "Content-Type": init.expected, "Cache-Control": "no-cache" } });
}

/**
 * The broker's routes, under `/api`. Nothing else is public. GitHub's
 * repositories are at `<owner>/<name>.git`; another instance's at
 * `<instance>/<owner>/<name>.git`.
 */
export function gitBrokerRoutes(deps: GitBrokerDeps): Route[] {
	return ["/:owner/:repo", "/:instance/:owner/:repo"].flatMap((repoPath): Route[] => [
		[
			"GET",
			`${GIT_BROKER_PATH}${repoPath}/info/refs`,
			async (params, request, url) => {
				const admitted = await admit(deps, params, request);
				if (admitted instanceof Response) return admitted;
				if (url.searchParams.get("service") !== "git-upload-pack") {
					return text(403, "The broker only clones and fetches: Pim pushes for the workspace once the person approves");
				}
				return proxy(deps, admitted, request, "/info/refs?service=git-upload-pack", {
					method: "GET",
					contentType: "",
					expected: "application/x-git-upload-pack-advertisement",
				});
			},
		],
		[
			"POST",
			`${GIT_BROKER_PATH}${repoPath}/git-upload-pack`,
			async (params, request) => {
				const admitted = await admit(deps, params, request);
				if (admitted instanceof Response) return admitted;
				if (request.headers.get("Content-Type") !== "application/x-git-upload-pack-request") return text(415, "This takes git's upload-pack requests");
				const body = await readCapped(request, deps.maxRequestBytes ?? MAX_UPLOAD_REQUEST_BYTES);
				return proxy(deps, admitted, request, "/git-upload-pack", {
					method: "POST",
					body,
					contentType: "application/x-git-upload-pack-request",
					expected: "application/x-git-upload-pack-result",
				});
			},
		],
	]);
}

/** Answers a request for `path` (under `/api`) with the broker's routes. */
export function handleGitBroker(request: Request, path: string, deps: GitBrokerDeps): Promise<Response> {
	return dispatch(gitBrokerRoutes(deps), request, path);
}

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
	return handleGitBroker(request, path, { key: await brokerTokenKey(env), app: deploymentGitHubApp(env), policy: brokerPolicy(env), providers: deploymentProviders(env) });
}
