import type { WorkspaceProviderRegistry } from "../workspace/registry";
import { AmpCliOrbClient, type CommandRunner, type OrbIdempotencyStore } from "./amp-cli";
import { SandboxCommandRunner } from "./command-runner";
import type { OrbClientFactory } from "./types";

/** The default agent-hosted provider, kept alive across a thread's polls. */
export function ampOrbClients(options: {
	providers: () => WorkspaceProviderRegistry;
	loadApiKey: (space: string) => Promise<string | null>;
	keys: OrbIdempotencyStore;
	/** Tests can script the CLI without making a sandbox or reaching Amp. */
	runner?: CommandRunner;
}): OrbClientFactory {
	const clients = new Map<string, AmpCliOrbClient>();
	return (context) => {
		if (context.providerId !== "amp-cli") return null;
		const key = JSON.stringify([context.space, context.threadId]);
		let client = clients.get(key);
		if (!client) {
			client = new AmpCliOrbClient({
				runner: options.runner ?? new SandboxCommandRunner({ providers: options.providers, loadApiKey: () => options.loadApiKey(context.space) }),
				keys: options.keys,
			});
			clients.set(key, client);
		}
		return client;
	};
}
