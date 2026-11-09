import { type Harness, isLoginHarness } from "../vault/harnesses";
import { harnessEnv, HARNESS_HOME, type Restored, writeBackHarnessCredentials } from "../vault/inject";
import type { CodingVault } from "../vault/vault";
import { WORKSPACE_ROOT, type Workspace, type WorkspaceProvider, type WorkspaceRef, type WorkspaceSpec } from "../workspace/types";
import type { CliHarness, HarnessLoginFlow as CliLogin } from "./types";

/**
 * A person signing a CLI harness in with their own subscription, through
 * the CLI's own sign-in (`CliHarness.login`), in a short-lived workspace of
 * theirs. The CLI prints a URL, which Pim relays to the person, and then
 * one of two things happens (`mode`):
 *
 * - `paste_code`: they sign in in their browser and paste the code it
 *   shows, which Pim hands to the CLI on its standard input.
 * - `device_code`: the CLI also prints a code, which Pim relays too; they
 *   enter it on that page, and the CLI, which polls the vendor meanwhile,
 *   exits 0 once they have. Pim notices that on its own; the person's
 *   browser polls the sign-in's status to hear of it.
 *
 * The CLI saves its login, and Pim keeps the CLI's files in the person's
 * vault (../vault/), never opening them. Pim reads what the CLI prints only
 * to find the URL and the code, and neither logs nor keeps the codes or
 * anything the CLI prints.
 *
 * The workspace's commands take their standard input when they start, so
 * with `paste_code` the CLI reads it from a pipe that a loop in `sh` fills
 * once the code is written to a file only the workspace's user can read;
 * the file is gone as soon as it is read. The workspace is deleted when the
 * sign-in ends.
 */

/** Where a sign-in is. */
export type LoginState = "none" | "starting" | "waiting_code" | "completing" | "connected" | "failed";

/**
 * What the API says of a sign-in: never what the CLI printed but the URL
 * and, with `device_code`, the code to enter there (`userCode`). While
 * `waiting_code`, it waits for the code: pasted into Pim, or entered on the
 * vendor's page.
 */
export type LoginStatus = { readonly harness: Harness; readonly state: LoginState; readonly url: string | null; readonly userCode: string | null; readonly error: string | null };

export type LoginDeps = {
	readonly harness: CliHarness;
	readonly userId: string;
	readonly provider: WorkspaceProvider;
	readonly image: string;
	readonly vault: CodingVault;
	/** Keeps the workspace the sign-in made, so one left by a restart is deleted later; null once it is gone. */
	readonly remember?: (ref: WorkspaceRef | null) => void;
	/** After a login is kept: such as going on with the person's threads that waited for it. */
	readonly onConnected?: () => Promise<void>;
	/** How long the CLI has to print the URL, and the whole sign-in to finish. */
	readonly urlTimeoutMs?: number;
	readonly timeoutMs?: number;
};

/** The file the code is handed to the CLI through. */
export const LOGIN_CODE_FILE = `${WORKSPACE_ROOT}/.pim-login-code`;

/**
 * Waits for the code file, gives it to the command's standard input with a
 * newline and removes it, while the command (the CLI's sign-in, `"$@"`)
 * runs from the start, so it prints its URL at once.
 */
const LOGIN_SCRIPT = `(while [ ! -s "$PIM_LOGIN_CODE" ]; do sleep 1; done; cat "$PIM_LOGIN_CODE"; rm -f "$PIM_LOGIN_CODE") | "$@"`;

const MAX_OUTPUT = 64 * 1024;

/** What a code the person pastes may be: one line of printable characters. */
export function validLoginCode(code: unknown): code is string {
	return typeof code === "string" && code.trim().length > 0 && code.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(code.trim());
}

export class HarnessLoginFlow {
	readonly #deps: LoginDeps;
	#state: LoginState = "none";
	#url: string | null = null;
	#userCode: string | null = null;
	#error: string | null = null;
	#ref: WorkspaceRef | null = null;
	#workspace: Workspace | null = null;
	#controller = new AbortController();
	#output = "";
	#exit: Promise<number | null> | null = null;
	#urlFound: (() => void) | null = null;

	constructor(deps: LoginDeps) {
		this.#deps = deps;
	}

	status(): LoginStatus {
		return { harness: this.#deps.harness.id, state: this.#state, url: this.#url, userCode: this.#userCode, error: this.#error };
	}

	/**
	 * Makes the workspace and starts the CLI's sign-in; answers once the CLI
	 * printed its URL (and its code, with `device_code`), or failed to. With
	 * `device_code` the sign-in then finishes by itself when the CLI exits.
	 */
	async start(): Promise<LoginStatus> {
		const { harness, provider, image } = this.#deps;
		const login = harness.login;
		if (!login) return this.#fail(`${harness.name} has no sign-in Pim can relay`);
		this.#state = "starting";
		try {
			const sessionId = `login-${harness.id}-${crypto.randomUUID()}`;
			const spec: WorkspaceSpec = {
				sessionId,
				image,
				// No repository: the sign-in needs none.
				repo: { url: "", ref: "", branch: "" },
				limits: { cpu: 1, memMiB: 1024, diskMiB: 1024, pids: 256, wallClockMin: 20 },
				egress: { allow: [...harness.egress] },
				gitAuth: { mode: "none" },
			};
			this.#ref = await provider.create(spec);
			this.#deps.remember?.(this.#ref);
			this.#workspace = await provider.get(this.#ref);
			if (!this.#workspace) throw new Error("The workspace provider lost the workspace it just made");
		} catch (error) {
			await this.#cleanUp();
			return this.#fail(`Couldn't get a workspace for the sign-in: ${error instanceof Error ? error.message : String(error)}`);
		}
		const found = new Promise<void>((resolve) => {
			this.#urlFound = resolve;
		});
		const exit = this.#run(login);
		this.#exit = exit;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([found, exit, new Promise((resolve) => (timer = setTimeout(resolve, this.#deps.urlTimeoutMs ?? 60_000)))]);
		clearTimeout(timer);
		if (this.#printed()) {
			this.#state = "waiting_code";
			if (login.mode === "device_code") void exit.then((code) => this.#complete(code));
			return this.status();
		}
		const missing = this.#url ? "code" : "URL";
		await this.cancel();
		return this.#fail(`${harness.name} didn't print a sign-in ${missing}`);
	}

	/** Hands the code the person pasted to the CLI, waits for it to finish, and keeps the login it saved. A `device_code` sign-in takes none. */
	async submit(code: string): Promise<LoginStatus> {
		if (this.#state !== "waiting_code" || !this.#workspace || !this.#exit || this.#deps.harness.login?.mode !== "paste_code") return this.status();
		if (!validLoginCode(code)) return { ...this.status(), error: "Paste the code the sign-in page shows" };
		this.#state = "completing";
		try {
			await this.#workspace.writeFile(LOGIN_CODE_FILE, new TextEncoder().encode(`${code.trim()}\n`), 0o600);
		} catch (error) {
			await this.#cleanUp();
			return this.#fail(`The sign-in failed: ${error instanceof Error ? error.name : "error"}`);
		}
		return this.#complete(await this.#exit);
	}

	/** The CLI's sign-in ended with `exit`: keeps the login it saved when it succeeded, and deletes the workspace. */
	async #complete(exit: number | null): Promise<LoginStatus> {
		// A sign-in cancelled or started again meanwhile is over already.
		if ((this.#state !== "waiting_code" && this.#state !== "completing") || !this.#workspace) return this.status();
		const { harness, vault, userId } = this.#deps;
		this.#state = "completing";
		const workspace = this.#workspace;
		try {
			if (exit !== 0) {
				await this.#cleanUp();
				const retry = harness.login?.mode === "device_code" ? "start again" : "check the code and start again";
				return this.#fail(`${harness.name}'s sign-in didn't finish${exit === null ? "" : ` (it exited ${exit})`}: ${retry}`);
			}
			const id = harness.id;
			if (!isLoginHarness(id)) throw new Error("Only a harness whose login the vault keeps as files signs in here");
			const entry = (await vault.status(userId)).find((status) => status.harness === id);
			const restored: Restored = { userId, sessionId: this.#ref!.sessionId, harness: id, version: entry?.version ?? 0, connected: false, fingerprint: null };
			// The login workspace is the person's because this sign-in made it for them.
			const owns = async (user: string, session: string) => user === userId && session === this.#ref?.sessionId;
			const written = await writeBackHarnessCredentials(vault, owns, restored, { userId, ref: this.#ref!, workspace });
			await this.#cleanUp();
			if (written.outcome !== "saved") {
				return this.#fail(
					written.outcome === "conflict"
						? "Another sign-in or a disconnect finished first: start again"
						: written.outcome === "refused"
							? `${harness.name} left files Pim won't keep`
							: `${harness.name} didn't save a login`,
				);
			}
			this.#state = "connected";
			this.#error = null;
			console.info(JSON.stringify({ event: "pim.coding.harness_connected", user: userId, harness: harness.id, version: written.version }));
		} catch (error) {
			await this.#cleanUp();
			return this.#fail(`The sign-in failed: ${error instanceof Error ? error.name : "error"}`);
		}
		await this.#deps.onConnected?.().catch((error) => console.warn(JSON.stringify({ event: "pim.coding.harness_resume_failed", error: String(error) })));
		return this.status();
	}

	/** Stops the sign-in and deletes its workspace. */
	async cancel(): Promise<void> {
		if (this.#state !== "connected" && this.#state !== "failed") {
			this.#state = "none";
			this.#url = null;
			this.#userCode = null;
		}
		await this.#cleanUp();
	}

	/** Whether the CLI printed what the person needs: the URL, and with `device_code` the code to enter there. */
	#printed(): boolean {
		return this.#url !== null && (this.#deps.harness.login?.mode !== "device_code" || this.#userCode !== null);
	}

	/** Runs the sign-in, reading what it prints only for the URL and the code; resolves with its exit code. */
	async #run(login: CliLogin): Promise<number | null> {
		const { harness } = this.#deps;
		const paste = login.mode === "paste_code";
		const env = { HOME: HARNESS_HOME, ...harnessEnv(harness.id), ...harness.env, ...(paste ? { PIM_LOGIN_CODE: LOGIN_CODE_FILE } : {}) };
		const command = paste ? ["sh", "-c", LOGIN_SCRIPT, "pim-login", ...login.command] : [...login.command];
		let code: number | null = null;
		try {
			for await (const event of this.#workspace!.exec(command, {
				cwd: WORKSPACE_ROOT,
				env,
				timeoutMs: this.#deps.timeoutMs ?? 15 * 60_000,
				signal: this.#controller.signal,
			})) {
				if (event.type === "exit") code = event.code;
				else if (!this.#printed()) {
					this.#output = (this.#output + event.data).slice(-MAX_OUTPUT);
					this.#url ??= login.authorizationUrl(this.#output);
					if (!paste) this.#userCode ??= login.userCode?.(this.#output) ?? null;
					if (this.#printed()) {
						this.#output = "";
						this.#urlFound?.();
					}
				}
			}
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.harness_login_exec_failed", harness: harness.id, error: error instanceof Error ? error.name : "error" }));
		}
		return code;
	}

	#fail(error: string): LoginStatus {
		this.#state = "failed";
		this.#url = null;
		this.#userCode = null;
		this.#error = error;
		return this.status();
	}

	async #cleanUp(): Promise<void> {
		this.#controller.abort();
		this.#controller = new AbortController();
		this.#output = "";
		const ref = this.#ref;
		this.#ref = null;
		this.#workspace = null;
		if (!ref) return;
		try {
			await this.#deps.provider.destroy(ref);
			this.#deps.remember?.(null);
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.harness_login_destroy_failed", harness: this.#deps.harness.id, error: String(error) }));
		}
	}
}
