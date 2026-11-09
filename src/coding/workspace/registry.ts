import type { WorkspaceProvider } from "./types";

/**
 * The workspace providers a deployment offers coding threads, by id, such as
 * "compose" or "cloudflare". A thread keeps the id of the provider that made
 * its workspace and asks the registry for it again after a restart.
 */
export interface WorkspaceProviderRegistry {
	/** The provider with this id. Throws `NoWorkspaceProviderError` when there is none. */
	get(id: string): WorkspaceProvider;
	/** The provider new threads use when they don't name one, or null when there is none. */
	defaultId(): string | null;
}

/** No provider has this id, or the deployment has none at all. */
export class NoWorkspaceProviderError extends Error {
	constructor(id: string | null) {
		super(
			id === null
				? "This Pim has no workspace provider for coding threads"
				: `This Pim has no workspace provider "${id}" for coding threads`,
		);
		this.name = "NoWorkspaceProviderError";
	}
}

/** A registry of the given providers, the first of them the default. */
export function workspaceRegistry(providers: readonly WorkspaceProvider[]): WorkspaceProviderRegistry {
	const byId = new Map(providers.map((provider) => [provider.id, provider]));
	return {
		get(id) {
			const provider = byId.get(id);
			if (!provider) throw new NoWorkspaceProviderError(id);
			return provider;
		},
		defaultId: () => providers[0]?.id ?? null,
	};
}

/** What a deployment offers until its providers are wired in: none, so every thread fails with a clear error. */
export const noWorkspaceProviders: WorkspaceProviderRegistry = workspaceRegistry([]);
