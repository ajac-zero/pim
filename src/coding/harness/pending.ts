import type { ApiKeyHarness } from "../vault/harnesses";
import type { CliHarness } from "./types";

/**
 * The CLI harness whose adapter isn't written yet: Amp. It says how it signs
 * in, with an API key in the environment variable its CLI reads, and the
 * hosts its workspace must reach, so the vault, the API and the web app can
 * connect it already. It runs nothing: a turn on it fails with a "not
 * implemented yet" error before any command starts. Its own adapter replaces
 * it.
 */
function pending(id: ApiKeyHarness, name: string, apiKeyEnv: string, egress: readonly string[]): CliHarness {
	const fail = (): never => {
		throw new Error(`${name} isn't implemented yet: Pim can't run its CLI`);
	};
	return { id, name, apiKeyEnv, egress, env: {}, shellTool: "", buildCommand: fail, parser: fail, signalCommand: fail };
}

// Amp reads its access token from AMP_API_KEY and calls ampcode.com; `*.` matches subdomains only, as the egress proxy reads it.
export const amp = pending("amp", "Amp", "AMP_API_KEY", ["ampcode.com", "*.ampcode.com"]);
