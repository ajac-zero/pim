import type { ApiKeyHarness } from "../vault/harnesses";
import type { CliHarness } from "./types";

/**
 * The CLI harnesses whose adapters aren't written yet: Mistral Vibe and Amp.
 * Each says how it signs in, with an API key in the environment variable
 * its CLI reads, and the hosts its workspace must reach, so the vault, the
 * API and the web app can connect it already. Neither runs anything: a turn
 * on one fails with a "not implemented yet" error before any command
 * starts. Their own adapters replace these.
 */
function pending(id: ApiKeyHarness, name: string, apiKeyEnv: string, egress: readonly string[]): CliHarness {
	const fail = (): never => {
		throw new Error(`${name} isn't implemented yet: Pim can't run its CLI`);
	};
	return { id, name, apiKeyEnv, egress, env: {}, reportsCost: false, shellTool: "", buildCommand: fail, parser: fail, signalCommand: fail };
}

// Vibe reads its key from MISTRAL_API_KEY and calls Mistral's API.
export const mistralVibe = pending("mistral-vibe", "Mistral Vibe", "MISTRAL_API_KEY", ["api.mistral.ai"]);

// Amp reads its access token from AMP_API_KEY and calls ampcode.com; `*.` matches subdomains only, as the egress proxy reads it.
export const amp = pending("amp", "Amp", "AMP_API_KEY", ["ampcode.com", "*.ampcode.com"]);
