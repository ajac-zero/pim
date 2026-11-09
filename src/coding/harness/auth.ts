import { type ApiKeyHarness, isApiKeyHarness } from "../vault/harnesses";
import type { CodingThreadRow } from "../thread-store";
import type { HarnessAuth } from "./runner";
import type { CliHarness } from "./types";

/**
 * SEAM: how a thread's CLI harness signs in.
 *
 * A harness with API-key sign-in (`apiKeyEnv`, such as Mistral Vibe or Amp)
 * runs with the person's own key from the coding vault, in the environment
 * variable its CLI reads: `{ mode: "env" }`, so the runner (./runner.ts)
 * neither restores a login nor takes the person's lock, and takes the key
 * out of everything the CLI prints. Without a key it is `signed_out`, and
 * the thread waits for the person to give one. Every other harness runs
 * with the person's subscription login, from the vault.
 *
 * The gateway mode, where a subscription harness is given a key for Pim's
 * model gateway instead of a login (such as `ANTHROPIC_BASE_URL` and
 * `ANTHROPIC_AUTH_TOKEN`), is a separate task: it returns `{ mode: "env",
 * env, secrets }` here too. The gateway's environment and the host its
 * egress needs come from `CodingThreadDO.modelGatewayEnv("claude-code")`
 * (../thread-do.ts), which issues a token, so that task also adds the host
 * to the workspace's egress. Codex in that mode also needs its `CODEX_HOME`
 * directory made first, which a restored login otherwise makes
 * (../../../docs/coding-codex.md).
 */
export async function authEnv(_thread: CodingThreadRow, harness: CliHarness, apiKey: (harness: ApiKeyHarness) => Promise<string | null>): Promise<HarnessAuth> {
	if (!harness.apiKeyEnv) return { mode: "subscription" };
	// A harness whose key the vault doesn't keep never runs signed in.
	const key = isApiKeyHarness(harness.id) ? await apiKey(harness.id) : null;
	if (key === null) return { mode: "signed_out" };
	return { mode: "env", env: { [harness.apiKeyEnv]: key }, secrets: [key] };
}
