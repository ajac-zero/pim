import type { WorkspaceProviderRegistry } from "../workspace/registry";
import { DEFAULT_WORKSPACE_IMAGE } from "../workspace/registry";
import type { WorkspaceRef } from "../workspace/types";
import type { CommandRunner, OrbCommand, OrbCommandEvent } from "./amp-cli";

/** Takes a secret out of a stream even when an exec chunk cuts it in two. */
class SecretStream {
	#pending = "";
	constructor(readonly secret: string) {}

	push(text: string, end = false): string {
		const clean = (this.#pending + text).replaceAll(this.secret, "[redacted]");
		let keep = 0;
		if (!end) {
			for (let n = 1; n < this.secret.length && n <= clean.length; n++) {
				if (clean.endsWith(this.secret.slice(0, n))) keep = n;
			}
		}
		this.#pending = keep ? clean.slice(-keep) : "";
		return keep ? clean.slice(0, -keep) : clean;
	}
}

/**
 * Runs only the Amp control CLI, never repository code. Every command gets a
 * fresh, repository-free Compose sandbox, destroyed on exit or cancellation.
 * Cloudflare's pool cannot carry Amp's WebSocket, so there is no fallback.
 * The vault token is passed only in exec's environment, never in the spec,
 * argv, files or errors. No login files or environment snapshots are used.
 */
export class SandboxCommandRunner implements CommandRunner {
	constructor(readonly options: {
		providers: () => WorkspaceProviderRegistry;
		loadApiKey: () => Promise<string | null>;
	}) {}

	run(argv: readonly string[]): OrbCommand {
		const abort = new AbortController();
		return { events: this.#events(argv, abort.signal), kill: () => abort.abort() };
	}

	async *#events(argv: readonly string[], signal: AbortSignal): AsyncGenerator<OrbCommandEvent> {
		let ref: WorkspaceRef | null = null;
		let provider;
		try {
			if (signal.aborted) {
				yield { type: "exit", code: null, signal: "SIGTERM" };
				return;
			}
			const key = await this.options.loadApiKey();
			if (!key) {
				yield { type: "stderr", data: "Invalid or missing API key: connect Amp in the coding page" };
				yield { type: "exit", code: 1 };
				return;
			}
			provider = this.options.providers().get("compose");
			ref = await provider.create({
				sessionId: `amp-orb-${crypto.randomUUID()}`,
				image: DEFAULT_WORKSPACE_IMAGE,
				repo: { url: "", ref: "", branch: "" },
				limits: { cpu: 1, memMiB: 1024, diskMiB: 1024, pids: 256, wallClockMin: null },
				egress: { allow: ["ampcode.com", "*.ampcode.com"] },
				gitAuth: { mode: "none" },
			});
			const workspace = await provider.get(ref);
			if (!workspace) throw new Error("Missing control sandbox");
			const streams = { stdout: new SecretStream(key), stderr: new SecretStream(key) };
			let exited = false;
			for await (const event of workspace.exec([...argv], {
				cwd: "/workspace",
				env: { HOME: "/workspace", AMP_API_KEY: key, AMP_SKIP_UPDATE_CHECK: "1" },
				timeoutMs: 7 * 24 * 60 * 60_000,
				signal,
			})) {
				if (event.type === "exit") {
					for (const type of ["stdout", "stderr"] as const) {
						const data = streams[type].push("", true);
						if (data) yield { type, data };
					}
					yield event;
					exited = true;
					break;
				}
				const data = streams[event.type].push(event.data);
				if (data) yield { type: event.type, data };
			}
			if (!exited) throw new Error("Exec ended without an exit");
		} catch {
			// A backend error can repeat its request body, including env. Never
			// propagate it, even when it does not look like an Amp token.
			if (!signal.aborted) yield { type: "stderr", data: "Network failure running the Amp control CLI in the compose pool" };
			yield signal.aborted ? { type: "exit", code: null, signal: "SIGTERM" } : { type: "exit", code: 1 };
		} finally {
			if (ref && provider) {
				try { await provider.destroy(ref); } catch { /* The manager's idle reaper also bounds abandoned sandboxes. */ }
			}
		}
	}
}
