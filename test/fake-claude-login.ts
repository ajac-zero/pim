import { LOGIN_CODE_FILE } from "../src/coding/harness/login";
import { codexDeviceLogin, isCodexLogin } from "./fake-codex-login";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import type { ExecEvent, ExecOptions, Workspace, WorkspaceProvider, WorkspaceRef } from "../src/coding/workspace/types";

/**
 * Claude Code's sign-in, `claude auth login`, as it behaves where the
 * browser can't reach it (https://code.claude.com/docs/en/authentication):
 * it prints a URL, waits for the code the sign-in page shows on its
 * standard input, and with the right code saves its login in its config
 * directory. Here it runs in an in-memory workspace, where the `sh` loop
 * Pim wraps it in (src/coding/harness/login.ts) is played by reading the
 * code file the same way.
 */

/** The URL it prints, and the one code it takes. */
export const LOGIN_URL = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=abc&code_challenge_method=S256&state=xyz";
export const GOOD_CODE = "Xk3p9-ZQh2#xyz";
export const SAVED_LOGIN = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-from-login","refreshToken":"sk-ant-ort01-from-login","subscriptionType":"max"}}';

/** What the fake sign-in saw: each run's command and environment, and each code it was given. */
export const loginRuns: { cmd: string[]; env: Record<string, string> }[] = [];
export const codesGiven: string[] = [];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function* claudeAuthLogin(workspace: Workspace, options: ExecOptions): AsyncGenerator<ExecEvent> {
	yield { type: "stdout", data: `Opening browser to sign in…\n\u001b[2mBrowser didn't open? Use the url below to sign in:\u001b[22m\n\n${LOGIN_URL}\n\n` };
	yield { type: "stdout", data: "Paste code here if prompted > " };
	let code: string | null = null;
	while (code === null) {
		if (options.signal?.aborted) {
			yield { type: "exit", code: null, signal: "SIGTERM" };
			return;
		}
		code = await workspace.readFile(LOGIN_CODE_FILE).then(
			(data) => decoder.decode(data),
			() => null,
		);
		if (code === null) await new Promise((resolve) => setTimeout(resolve, 5));
	}
	await workspace.remove(LOGIN_CODE_FILE);
	codesGiven.push(code);
	if (code !== `${GOOD_CODE}\n`) {
		yield { type: "stderr", data: "\nOAuth error: Invalid code\n" };
		yield { type: "exit", code: 1 };
		return;
	}
	const dir = options.env!.CLAUDE_CONFIG_DIR!;
	await workspace.writeFile(`${dir}/.credentials.json`, encoder.encode(SAVED_LOGIN), 0o600);
	await workspace.writeFile(`${dir}/.claude.json`, encoder.encode('{"hasCompletedOnboarding":true}'), 0o600);
	yield { type: "stdout", data: "\nLogin successful.\n" };
	yield { type: "exit", code: 0 };
}

/** An in-memory provider whose workspaces run `claude auth login` as above, wrapped as Pim runs it, and Codex's sign-in (./fake-codex-login.ts). */
export function loginProvider(): WorkspaceProvider & { readonly backing: FakeWorkspaceProvider } {
	const backing = new FakeWorkspaceProvider();
	const wrap = (workspace: Workspace): Workspace =>
		new Proxy(workspace, {
			get(target, property) {
				if (property === "exec") {
					return (cmd: string[], options: ExecOptions) => {
						if (cmd[0] === "sh" && cmd.slice(-3).join(" ") === "claude auth login") {
							loginRuns.push({ cmd, env: options.env ?? {} });
							return claudeAuthLogin(target, options);
						}
						if (isCodexLogin(cmd)) return codexDeviceLogin(target, cmd, options);
						return target.exec(cmd, options);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	return {
		id: backing.id,
		capabilities: backing.capabilities,
		backing,
		create: (spec) => backing.create(spec),
		get: async (ref: WorkspaceRef) => {
			const workspace = await backing.get(ref);
			return workspace && wrap(workspace);
		},
		destroy: (ref, options) => backing.destroy(ref, options),
		list: (filter) => backing.list(filter),
		snapshotEnvironment: (ref, o) => backing.snapshotEnvironment(ref, o),
		listEnvironments: (owner) => backing.listEnvironments(owner),
		deleteEnvironment: (userId, key) => backing.deleteEnvironment(userId, key),
	};
}
