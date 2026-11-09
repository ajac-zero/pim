import type { ExecEvent, ExecOptions, Workspace } from "../src/coding/workspace/types";

/**
 * Codex's device-code sign-in, `codex login --device-auth`, as 0.167.0
 * behaves (codex-rs/login/src/device_code_auth.rs): it prints the page to
 * open and a one-time code, polls OpenAI until the person has entered the
 * code there, saves its login in `$CODEX_HOME/auth.json` and exits 0; it
 * exits 1 when OpenAI refuses the sign-in. Here a test decides how it ends
 * (`deviceLogin`), and it runs in an in-memory workspace. It stops, as the
 * real one is stopped, when the workspace's command is aborted or runs out
 * of time.
 */

export const DEVICE_URL = "https://auth.openai.com/codex/device";
export const USER_CODE = "K7QM-4XT9P";
export const SAVED_AUTH = '{"auth_mode":"chatgpt","tokens":{"id_token":"eyJ-device-id","access_token":"eyJ-device-access","refresh_token":"rt_device_login","account_id":"acc_1"},"last_refresh":"2026-11-09T17:00:00Z"}';

/** How the next sign-in ends: approved, refused, or never (it polls until stopped). */
export const deviceLogin: { outcome: "approve" | "refuse" | null; runs: { cmd: string[]; env: Record<string, string> }[] } = { outcome: null, runs: [] };

const PROMPT = `\nWelcome to Codex [v\u001b[90m0.167.0\u001b[0m]\n\u001b[90mOpenAI's command-line coding agent\u001b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94m${DEVICE_URL}\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94m${USER_CODE}\u001b[0m\n\n\u001b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u001b[0m\n\n`;

/** Whether `cmd` is Codex's sign-in as Pim runs it. */
export const isCodexLogin = (cmd: readonly string[]) => cmd[0] === "sh" && cmd.at(-1)?.endsWith("exec codex login --device-auth") === true;

export async function* codexDeviceLogin(workspace: Workspace, cmd: string[], options: ExecOptions): AsyncGenerator<ExecEvent> {
	const env = options.env ?? {};
	deviceLogin.runs.push({ cmd, env });
	// What `mkdir -p "$CODEX_HOME"` before it is for: Codex won't start without its directory.
	if (!env.CODEX_HOME) {
		yield { type: "stderr", data: "Error finding codex home\n" };
		yield { type: "exit", code: 1 };
		return;
	}
	// Printed in two pieces, as the page and the code may arrive apart.
	const half = PROMPT.indexOf("2. Enter");
	yield { type: "stdout", data: PROMPT.slice(0, half) };
	yield { type: "stdout", data: PROMPT.slice(half) };
	const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
	while (deviceLogin.outcome === null) {
		if (options.signal?.aborted) {
			yield { type: "exit", code: null, signal: "SIGTERM" };
			return;
		}
		if (Date.now() >= deadline) {
			yield { type: "exit", code: null, signal: "SIGKILL", timedOut: true };
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (deviceLogin.outcome === "refuse") {
		yield { type: "stderr", data: "Error logging in with device code: device auth failed with status 400 Bad Request\n" };
		yield { type: "exit", code: 1 };
		return;
	}
	await workspace.writeFile(`${env.CODEX_HOME}/auth.json`, new TextEncoder().encode(SAVED_AUTH), 0o600);
	yield { type: "stdout", data: "Successfully logged in\n" };
	yield { type: "exit", code: 0 };
}
