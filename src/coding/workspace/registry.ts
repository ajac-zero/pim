import { COMPUTE_KINDS, type ComputeProvider, workspaceProviderOf, workspaceRole } from "../../compute";
import { containerProvider } from "./cloudflare";
import { ComposeWorkspaceProvider } from "./compose";
import type { WorkspaceProvider } from "./types";

/**
 * The workspace providers a deployment offers coding threads, by id, such as
 * "compose" or "cloudflare". A new thread runs on the first, the default,
 * and on the others in order when the ones before have no room for it. A
 * thread keeps the id of the provider that made its workspace and asks the
 * registry for it again after a restart.
 */
export interface WorkspaceProviderRegistry {
	/** The provider with this id. Throws `NoWorkspaceBackendError` when there is none. */
	get(id: string): WorkspaceProvider;
	/** The provider new threads use when they don't name one, or null when there is none. */
	defaultId(): string | null;
	/** The ids of every provider, the default first, then each a full thread overflows to, in order. */
	ids(): string[];
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
	"This Pim has no workspace backend for coding threads. Its admin adds a compute provider under Settings → Compute, or sets PIM_CODING_MANAGER_URL and PIM_CODING_MANAGER_TOKEN to use a sandbox manager.";

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
		ids: () => providers.map((provider) => provider.id),
	};
}

let cached: { env: object; signature: string; registry: WorkspaceProviderRegistry } | null = null;

/**
 * The backends this deployment has, read from its environment when a thread
 * asks, so turning one on needs no flag and no deploy of code:
 *
 * - The Compose sandbox manager, when `PIM_CODING_MANAGER_URL` and the
 *   secret `PIM_CODING_MANAGER_TOKEN` are both set.
 * - Cloudflare Containers, when the Worker has both workspace Durable Object
 *   bindings (docs/coding-cloudflare-sandbox.md).
 *
 * The providers the admin set up for the deployment (./compute.ts) replace
 * the one of the same backend the environment sets up, and one the admin
 * switched off for coding is left out whichever way it was set up. Primary
 * backends (by their kind's role) come before overflow ones, so the sandbox
 * manager stays the default and Cloudflare Containers takes the threads it
 * has no room for; within a role, the admin's come first. With no backend at all,
 * every thread fails with `NoWorkspaceBackendError`. Made once per isolate
 * and settings; Cloudflare lifecycle state lives in Durable Objects.
 */
export function workspaceBackends(env: object, configured: readonly ComputeProvider[] = []): WorkspaceProviderRegistry {
	const vars = env as Record<string, unknown>;
	const managerUrl = typeof vars.PIM_CODING_MANAGER_URL === "string" ? vars.PIM_CODING_MANAGER_URL.trim() : "";
	const managerToken = typeof vars.PIM_CODING_MANAGER_TOKEN === "string" ? vars.PIM_CODING_MANAGER_TOKEN.trim() : "";
	const containers = containerProvider(env);
	const signature = JSON.stringify([managerUrl, managerToken, containers !== null, configured]);
	if (cached?.env === env && cached.signature === signature) return cached.registry;
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
	if (containers) providers.push(containers);
	const off = new Set(configured.filter((provider) => !provider.codingSandbox).map((provider) => COMPUTE_KINDS[provider.kind].workspace as string));
	const added: WorkspaceProvider[] = [];
	for (const provider of configured) {
		if (!provider.codingSandbox) continue;
		try {
			const made = workspaceProviderOf(provider, env);
			if (made) added.push(made);
		} catch (error) {
			// The provider says what is wrong, never with a credential.
			missing = `The compute provider ${provider.name} can't be used, so coding threads have no workspace backend: ${error instanceof Error ? error.message : String(error)}.`;
		}
	}
	const taken = new Set(added.map((provider) => provider.id));
	const usable = [...added, ...providers.filter((provider) => !taken.has(provider.id) && !off.has(provider.id))];
	const registry = workspaceRegistry([...usable.filter((provider) => workspaceRole(provider.id) === "primary"), ...usable.filter((provider) => workspaceRole(provider.id) === "overflow")], missing);
	cached = { env, signature, registry };
	return registry;
}
