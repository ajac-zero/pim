import type { CodingThreadRow } from "../thread-store";
import type { HarnessAuth } from "./runner";

/**
 * SEAM: how a thread's CLI harness signs in.
 *
 * Every thread runs its harness with the person's own subscription login,
 * from the coding vault, for now. The API-key and gateway mode, where the
 * CLI is given a key through its environment (such as `ANTHROPIC_API_KEY`
 * or `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for Pim's model
 * gateway) instead of a login, is a separate task: it returns `{ mode:
 * "env", env }` here, and the runner (./runner.ts) then neither restores a
 * login nor takes the person's lock. The gateway's environment and the host
 * its egress needs come from `CodingThreadDO.modelGatewayEnv("claude-code")`
 * (../thread-do.ts), which is async and issues a token, so that task also
 * makes this function async and adds the host to the workspace's egress.
 */
export function authEnv(_thread: CodingThreadRow): HarnessAuth {
	return { mode: "subscription" };
}
