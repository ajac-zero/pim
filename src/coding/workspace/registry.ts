import { CloudflareSandboxProvider, type SandboxLike } from "./cloudflare";
import { ComposeWorkspaceProvider } from "./compose";
import type { WorkspaceProvider } from "./types";

/**
 * The workspace providers a deployment offers coding threads, by id, such as
 * "compose" or "cloudflare". A thread keeps the id of the provider that made
 * its workspace and asks the registry for it again after a restart.
 */
export interface WorkspaceProviderRegistry {
	/** The provider with this id. Throws `NoWorkspaceBackendError` when there is none. */
	get(id: string): WorkspaceProvider;
	/** The provider new threads use when they don't name one, or null when there is none. */
	defaultId(): string | null;
}

/** The machine image workspaces start from: the sandbox manager's default (sandbox-manager/compose.yaml builds it from workspace-agentd/Dockerfile). */
export const DEFAULT_WORKSPACE_IMAGE = "pim-workspace:local";

/** Coding threads can't get a workspace: the deployment has no backend for them, or not the one asked for. A state to show the person (`failed(no_backend)`), not a crash. */
export class NoWorkspaceBackendError extends Error {
	override readonly name = "NoWorkspaceBackendError";
	readonly code = "no_backend";

	constructor(message: string) {
		super(message);
	}
}

/** What the person is told when the deployment has no backend at all. */
export const NO_BACKEND_MESSAGE =
	"This Pim has no workspace backend for coding threads. Its admin sets PIM_CODING_MANAGER_URL and PIM_CODING_MANAGER_TOKEN to use a sandbox manager.";

/** A registry of the given providers, the first of them the default. `missing` says why there is none when asked for one it doesn't have. */
export function workspaceRegistry(providers: readonly WorkspaceProvider[], missing = NO_BACKEND_MESSAGE): WorkspaceProviderRegistry {
	const byId = new Map(providers.map((provider) => [provider.id, provider]));
	return {
		get(id) {
			const provider = byId.get(id);
			if (provider) return provider;
			throw new NoWorkspaceBackendError(providers.length === 0 ? missing : `This Pim has no workspace backend "${id}" for coding threads.`);
		},
		defaultId: () => providers[0]?.id ?? null,
	};
}

let cached: { signature: string; registry: WorkspaceProviderRegistry } | null = null;

/**
 * The backends this deployment has, read from its environment when a thread
 * asks, so turning one on needs no flag and no deploy of code:
 *
 * - The Compose sandbox manager, when `PIM_CODING_MANAGER_URL` and the
 *   secret `PIM_CODING_MANAGER_TOKEN` are both set.
 * - Cloudflare Sandbox, when the Worker has a `Sandbox` Durable Object
 *   binding (docs/coding-cloudflare-sandbox.md); it has none today.
 *
 * The first is the default. With neither, every thread fails with
 * `NoWorkspaceBackendError`. Made once per isolate and settings, so a
 * provider's own state, such as Cloudflare's list of workspaces, lasts.
 */
export function workspaceBackends(env: object): WorkspaceProviderRegistry {
	const vars = env as Record<string, unknown>;
	const managerUrl = typeof vars.PIM_CODING_MANAGER_URL === "string" ? vars.PIM_CODING_MANAGER_URL.trim() : "";
	const managerToken = typeof vars.PIM_CODING_MANAGER_TOKEN === "string" ? vars.PIM_CODING_MANAGER_TOKEN.trim() : "";
	const sandbox = vars.Sandbox as DurableObjectNamespace | undefined;
	const signature = JSON.stringify([managerUrl, managerToken, sandbox !== undefined]);
	if (cached?.signature === signature) return cached.registry;
	const providers: WorkspaceProvider[] = [];
	let missing = NO_BACKEND_MESSAGE;
	if (managerUrl && managerToken) {
		try {
			providers.push(new ComposeWorkspaceProvider({ managerUrl, token: managerToken }));
		} catch (error) {
			// Such as a plain http URL to a public host: the provider says what is wrong, and never with the token.
			missing = `PIM_CODING_MANAGER_URL can't be used, so coding threads have no workspace backend: ${error instanceof Error ? error.message : String(error)}.`;
		}
	} else if (managerUrl || managerToken) {
		missing = `${managerUrl ? "PIM_CODING_MANAGER_TOKEN" : "PIM_CODING_MANAGER_URL"} isn't set, so coding threads have no workspace backend. Set both to use the sandbox manager.`;
	}
	if (sandbox) {
		// TODO(coding): unverified until `@cloudflare/sandbox` is installed; use its `getSandbox(env.Sandbox, id)` here then (docs/coding-cloudflare-sandbox.md, step 4).
		providers.push(new CloudflareSandboxProvider({ sandboxFor: (id) => sandbox.getByName(id) as unknown as SandboxLike }));
	}
	const registry = workspaceRegistry(providers, missing);
	cached = { signature, registry };
	return registry;
}
