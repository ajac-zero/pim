// A ComputeProvider that runs each sandbox as a directory and child processes on this machine: for tests and local development, not a security boundary.
// What it does enforce is what Forge promises of every provider: one checkout per thread, a cleared environment (no PostgreSQL or runtime credentials), and paths kept inside the sandbox.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { type ComputeHandle, type ComputeProvider, type ExecOptions, type ExecResult } from "./compute";

export class LocalSandboxProvider implements ComputeProvider {
	readonly id = "local";
	/** Every create call, including ones whose answer a test dropped. */
	created: string[] = [];

	constructor(private readonly root: string) {
		mkdirSync(root, { recursive: true });
	}

	private dir(tag: string) {
		return join(this.root, createHash("sha256").update(tag).digest("hex").slice(0, 24));
	}

	workdir(handle: ComputeHandle) {
		return join(this.dir(handle.tag), "workspace");
	}

	async find(tag: string): Promise<ComputeHandle | null> {
		return existsSync(join(this.dir(tag), "tag")) ? { id: this.dir(tag), provider: this.id, tag } : null;
	}

	async create(tag: string, _spec: { image?: string } = {}): Promise<ComputeHandle> {
		this.created.push(tag);
		const d = this.dir(tag);
		mkdirSync(join(d, "workspace"), { recursive: true });
		mkdirSync(join(d, "home"), { recursive: true });
		writeFileSync(join(d, "tag"), tag);
		return { id: d, provider: this.id, tag };
	}

	async exec(handle: ComputeHandle, command: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
		const base = resolve(this.workdir(handle));
		const cwd = resolve(base, options.cwd ?? ".");
		if (cwd !== base && !cwd.startsWith(base + sep)) throw new Error(`Path escapes the sandbox: ${options.cwd}`);
		const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(this.dir(handle.tag), "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...options.env };
		return new Promise((done) => {
			const child = spawn(command[0]!, command.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timer = options.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), options.timeoutMs) : null;
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			child.on("error", (e) => done({ code: null, stdout, stderr: String(e) }));
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				done({ code, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
			});
			// A command that exits without reading its input is not an error of ours.
			child.stdin.on("error", () => {});
			child.stdin.end(options.stdin ?? "");
		});
	}

	/** Just enough of a Workspace for readers of staged files: absolute paths on this machine. */
	async workspace(_handle: ComputeHandle): Promise<import("@pim/coding/workspace/types").Workspace> {
		return { readFile: async (p: string) => new Uint8Array(readFileSync(p)), writeFile: async (p: string, d: Uint8Array) => writeFileSync(p, d) } as never;
	}

	async destroy(handle: ComputeHandle): Promise<void> {
		rmSync(this.dir(handle.tag), { recursive: true, force: true });
	}

	/** Tags of the sandboxes that exist. */
	list(): string[] {
		return readdirSync(this.root).flatMap((d) => (existsSync(join(this.root, d, "tag")) ? [readFileSync(join(this.root, d, "tag"), "utf8")] : []));
	}
}
