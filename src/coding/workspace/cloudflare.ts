// The Cloudflare Sandbox backend for coding workspaces. A workspace is one sandbox (a container behind a Durable Object) per coding session, reached through `SandboxLike`, a structural subset of the `@cloudflare/sandbox` client. This module deliberately imports nothing from `@cloudflare/*`: the Worker passes in `(sessionId) => getSandbox(env.Sandbox, sessionId)`, so nothing here runs, or is billed, until an owner adds the Sandbox binding. See docs/coding-cloudflare-sandbox.md.

import {
	type ExecEvent,
	type ExecOptions,
	type FileStat,
	type SnapshotRef,
	WORKSPACE_ROOT,
	WorkspaceCapacityError,
	WorkspaceFileError,
	type WorkspaceFilter,
	type WorkspaceInfo,
	WorkspaceNotFoundError,
	WorkspacePathError,
	type Workspace,
	type WorkspaceProvider,
	type WorkspaceRef,
	type WorkspaceSpec,
	type WorkspaceState,
	type WorkspaceStatus,
} from "./types";

/** A directory backup as the SDK's `createBackup` returns it: a handle that `restoreBackup` accepts. */
export type SandboxBackupLike = { id: string; dir: string };

/** The part of a `@cloudflare/sandbox` sandbox this backend uses. The SDK's own objects satisfy it; the method names and option shapes follow the SDK's documented `exec`, `readFile`, `writeFile`, `mkdir`, `createBackup`, `restoreBackup` and `destroy`. */
export interface SandboxLike {
	/** Runs a shell command line. Output goes to `onOutput` as it arrives; `signal` aborting kills the command. `stdin` is written to its standard input. A command that fails resolves with its exit code; a rejection means the sandbox itself failed (or the call was aborted). */
	exec(
		command: string,
		o?: { cwd?: string; env?: Record<string, string>; stdin?: string; signal?: AbortSignal; stream?: boolean; onOutput?: (stream: "stdout" | "stderr", data: string) => void },
	): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
	readFile(path: string, o?: { encoding?: string }): Promise<{ content: string; encoding?: string }>;
	writeFile(path: string, content: string, o?: { encoding?: string }): Promise<unknown>;
	mkdir(path: string, o?: { recursive?: boolean }): Promise<unknown>;
	/** Backs a directory up to the R2 bucket the sandbox is wired to. Present only when backups are set up. */
	createBackup?(o: { dir: string; ttl?: number }): Promise<SandboxBackupLike>;
	restoreBackup?(backup: SandboxBackupLike): Promise<unknown>;
	/** Stops the container and deletes its disk. */
	destroy?(): Promise<void>;
}

export type CloudflareSandboxOptions = {
	/** Opens the sandbox for a session; normally `(id) => getSandbox(env.Sandbox, id)`. */
	sandboxFor: (sessionId: string) => SandboxLike;
	/** Turns snapshots on, through the sandbox's directory backups. `ttlSeconds` is how long a backup is kept. Without it `capabilities.snapshot` is false. */
	backup?: { ttlSeconds?: number };
	/** Turns the egress allowlist on: called when a workspace is created with the hostnames it may reach, it must install an outbound handler on the sandbox that refuses every other hostname (the design is in docs/coding-cloudflare-sandbox.md). Without it `capabilities.egressAllowlist` is false and `spec.egress` is not enforced. */
	applyEgress?: (sandbox: SandboxLike, allow: string[]) => Promise<void>;
	/** The most workspaces at once, 2 when absent. */
	maxConcurrent?: number;
};

export type Entry = { ref: WorkspaceRef; sandbox: SandboxLike; state: WorkspaceState; createdAt: number; parked?: string };

const ROOT_PREFIX = `${WORKSPACE_ROOT}/`;
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
/** `find -printf` fields: type letter, size, octal permission bits, mtime in seconds, base name. */
const STAT_FORMAT = "%y|%s|%m|%T@|%f\\n";

/** Normalizes a path lexically to an absolute one under /workspace, or throws. */
function lexical(path: string): string {
	const stack: string[] = [];
	for (const part of (path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`).split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	const full = `/${stack.join("/")}`;
	if (full !== WORKSPACE_ROOT && !full.startsWith(ROOT_PREFIX)) throw new WorkspacePathError(path);
	return full;
}

const inside = (path: string) => path === WORKSPACE_ROOT || path.startsWith(ROOT_PREFIX);
const b64 = (data: Uint8Array) => btoa(Array.from(data, (byte) => String.fromCharCode(byte)).join(""));
const unb64 = (text: string) => Uint8Array.from(atob(text.replace(/\s/g, "")), (char) => char.charCodeAt(0));

function parseStat(line: string): FileStat {
	const [kind = "f", size = "0", mode = "644", mtime = "0", ...name] = line.split("|");
	return { name: name.join("|"), type: kind === "d" ? "dir" : kind === "l" ? "symlink" : "file", size: Number(size), mode: Number.parseInt(mode, 8), mtimeMs: Math.round(Number(mtime) * 1000) };
}

class CloudflareWorkspace implements Workspace {
	constructor(
		private entry: Entry,
		private provider: CloudflareSandboxProvider,
		private options: CloudflareSandboxOptions,
	) {}

	private get sandbox() {
		return this.entry.sandbox;
	}

	private live() {
		if (this.entry.state === "gone") throw new WorkspaceNotFoundError();
	}

	private running() {
		this.live();
		if (this.entry.state !== "running") throw new Error("The workspace is stopped");
	}

	/** Runs a plain command and gathers its output; used for the file operations. */
	private async sh(argv: string[]) {
		const out = await this.sandbox.exec(argv.map(quote).join(" "), { cwd: WORKSPACE_ROOT });
		return { code: out.exitCode, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
	}

	/** Finds the real path of `p`, following symlinks, and throws when it is or leads outside /workspace. With `keepLast` the final name is not followed, so a link itself can be removed. Checks the path in the sandbox after checking it lexically; a link made between the check and the use is not caught. */
	private async resolve(p: string, keepLast = false): Promise<string> {
		const path = lexical(p);
		const target = keepLast && path !== WORKSPACE_ROOT ? path.slice(0, path.lastIndexOf("/")) || "/" : path;
		const out = await this.sh(["realpath", "-m", "--", target]);
		const real = out.stdout.trim();
		if (out.code !== 0 || !inside(real)) throw new WorkspacePathError(p);
		return keepLast && path !== WORKSPACE_ROOT ? `${real}/${path.slice(path.lastIndexOf("/") + 1)}` : real;
	}

	private async statReal(real: string, p: string): Promise<FileStat> {
		const out = await this.sh(["find", real, "-maxdepth", "0", "-printf", STAT_FORMAT]);
		if (out.code !== 0 || !out.stdout.trim()) throw new WorkspaceFileError(`No such file or directory: ${p}`);
		const stat = parseStat(out.stdout.trim());
		return stat;
	}

	async readFile(p: string): Promise<Uint8Array> {
		this.running();
		const real = await this.resolve(p);
		if ((await this.statReal(real, p)).type !== "file") throw new WorkspaceFileError(`Not a file: ${p}`);
		const file = await this.sandbox.readFile(real, { encoding: "base64" });
		return file.encoding && file.encoding !== "base64" ? new TextEncoder().encode(file.content) : unb64(file.content);
	}

	async writeFile(p: string, data: Uint8Array, mode = 0o644): Promise<void> {
		this.running();
		const real = await this.resolve(p);
		if (real === WORKSPACE_ROOT) throw new WorkspaceFileError(`Is a directory: ${p}`);
		const existing = await this.sh(["find", real, "-maxdepth", "0", "-type", "d"]);
		if (existing.stdout.trim()) throw new WorkspaceFileError(`Is a directory: ${p}`);
		await this.sandbox.mkdir(real.slice(0, real.lastIndexOf("/")), { recursive: true });
		await this.sandbox.writeFile(real, b64(data), { encoding: "base64" });
		await this.sh(["chmod", mode.toString(8), real]);
	}

	async list(p: string): Promise<FileStat[]> {
		this.running();
		const real = await this.resolve(p);
		if ((await this.statReal(real, p)).type !== "dir") throw new WorkspaceFileError(`Not a directory: ${p}`);
		const out = await this.sh(["find", real, "-mindepth", "1", "-maxdepth", "1", "-printf", STAT_FORMAT]);
		if (out.code !== 0) throw new WorkspaceFileError(`Cannot list ${p}: ${out.stderr.trim()}`);
		return out.stdout
			.split("\n")
			.filter(Boolean)
			.map(parseStat)
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	async stat(p: string): Promise<FileStat> {
		this.running();
		return this.statReal(await this.resolve(p), p);
	}

	async remove(p: string): Promise<void> {
		this.running();
		const real = await this.resolve(p, true);
		if (real === WORKSPACE_ROOT) throw new WorkspaceFileError("Cannot remove the workspace root");
		await this.statReal(real, p);
		const out = await this.sh(["rm", "-rf", "--", real]);
		if (out.code !== 0) throw new WorkspaceFileError(`Cannot remove ${p}: ${out.stderr.trim()}`);
	}

	async snapshot(): Promise<SnapshotRef> {
		this.running();
		if (!this.options.backup || !this.sandbox.createBackup) throw new Error("This Cloudflare sandbox provider has no backup configured, so it cannot snapshot");
		const backup = await this.sandbox.createBackup({ dir: WORKSPACE_ROOT, ttl: this.options.backup.ttlSeconds });
		return { id: JSON.stringify({ id: backup.id, dir: backup.dir }), providerId: this.entry.ref.providerId };
	}

	async restore(s: SnapshotRef): Promise<void> {
		this.running();
		if (!this.sandbox.restoreBackup) throw new Error("This Cloudflare sandbox provider has no backup configured, so it cannot restore");
		await this.sandbox.restoreBackup(JSON.parse(s.id) as SandboxBackupLike);
	}

	async status(): Promise<WorkspaceStatus> {
		return { state: this.entry.state };
	}

	async stop(): Promise<void> {
		this.live();
		await this.provider.park(this.entry);
	}

	async start(): Promise<void> {
		this.live();
		await this.provider.wake(this.entry);
	}

	async *exec(cmd: string[], o: ExecOptions): AsyncGenerator<ExecEvent> {
		this.running();
		const cwd = o.cwd === undefined ? WORKSPACE_ROOT : await this.resolve(o.cwd);
		const abort = new AbortController();
		let reason: "timeout" | "abort" | undefined;
		const kill = (why: "timeout" | "abort") => {
			reason ??= why;
			abort.abort();
		};
		const timer = setTimeout(() => kill("timeout"), o.timeoutMs);
		const onAbort = () => kill("abort");
		if (o.signal?.aborted) kill("abort");
		else o.signal?.addEventListener("abort", onAbort);
		const killed = abort.signal.aborted ? Promise.resolve() : new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));

		const queue: ExecEvent[] = [];
		let wake = () => {};
		let streamed = false;
		let finished = false;
		let result: { exitCode: number; stdout?: string; stderr?: string } | { error: unknown } | undefined;
		const running = this.sandbox
			.exec(cmd.map(quote).join(" "), {
				cwd,
				env: o.env,
				stdin: o.stdin,
				signal: abort.signal,
				stream: true,
				onOutput: (type, data) => {
					streamed = true;
					queue.push({ type, data });
					wake();
				},
			})
			.then(
				(value) => void (result = value),
				(error) => void (result = { error }),
			)
			.finally(() => {
				finished = true;
				wake();
			});

		try {
			while (true) {
				while (queue.length > 0) yield queue.shift() as ExecEvent;
				if (finished || reason) break;
				await Promise.race([new Promise<void>((resolve) => (wake = resolve)), killed]);
			}
			if (reason) {
				yield { type: "exit", code: null, signal: reason === "timeout" ? "SIGKILL" : "SIGTERM", timedOut: reason === "timeout" };
				return;
			}
			await running;
			if (result && "error" in result) {
				yield { type: "stderr", data: `sandbox error: ${result.error instanceof Error ? result.error.message : String(result.error)}\n` };
				yield { type: "exit", code: null, signal: "SANDBOX_ERROR" };
				return;
			}
			// Some SDK versions return the output instead of streaming it.
			if (!streamed && result?.stdout) yield { type: "stdout", data: result.stdout };
			if (!streamed && result?.stderr) yield { type: "stderr", data: result.stderr };
			yield { type: "exit", code: result?.exitCode ?? null };
		} finally {
			clearTimeout(timer);
			o.signal?.removeEventListener("abort", onAbort);
			abort.abort();
		}
	}
}

/** Workspaces on Cloudflare Sandbox. Which workspaces exist is remembered in this instance only: after the Durable Object restarts `get` reopens a workspace from its ref by checking that `/workspace` exists in the sandbox, but `list` shows only workspaces made or opened since. */
export class CloudflareSandboxProvider implements WorkspaceProvider {
	readonly id = "cloudflare";
	readonly capabilities: WorkspaceProvider["capabilities"];
	private entries = new Map<string, Entry>();
	private kept = new Map<string, string>();

	constructor(private options: CloudflareSandboxOptions) {
		this.capabilities = { snapshot: options.backup !== undefined, egressAllowlist: options.applyEgress !== undefined, maxConcurrent: options.maxConcurrent ?? 2 };
	}

	private backupOf(sandbox: SandboxLike) {
		if (!this.options.backup || !sandbox.createBackup) return undefined;
		return async () => JSON.stringify(await sandbox.createBackup?.({ dir: WORKSPACE_ROOT, ttl: this.options.backup?.ttlSeconds }));
	}

	private async restoreFrom(sandbox: SandboxLike, handle: string) {
		await sandbox.restoreBackup?.(JSON.parse(handle) as SandboxBackupLike);
	}

	/** Stops a workspace. With backups its files are saved and the container is destroyed; without them it is only marked stopped (the container sleeps by itself when idle). */
	async park(entry: Entry): Promise<void> {
		if (entry.state === "stopped") return;
		const backup = this.backupOf(entry.sandbox);
		if (backup && entry.sandbox.destroy) {
			entry.parked = await backup();
			await entry.sandbox.destroy();
		}
		entry.state = "stopped";
	}

	async wake(entry: Entry): Promise<void> {
		if (entry.state === "running") return;
		if (entry.parked) {
			await entry.sandbox.mkdir(WORKSPACE_ROOT, { recursive: true });
			await this.restoreFrom(entry.sandbox, entry.parked);
			entry.parked = undefined;
		}
		entry.state = "running";
	}

	async create(spec: WorkspaceSpec): Promise<WorkspaceRef> {
		const existing = this.entries.get(spec.sessionId);
		if (existing && existing.state !== "gone") return existing.ref;
		const live = [...this.entries.values()].filter((entry) => entry.state !== "gone").length;
		if (live >= (this.capabilities.maxConcurrent ?? Number.POSITIVE_INFINITY)) throw new WorkspaceCapacityError();
		const sandbox = this.options.sandboxFor(spec.sessionId);
		await sandbox.mkdir(WORKSPACE_ROOT, { recursive: true });
		const handle = this.kept.get(spec.sessionId);
		if (handle) {
			await this.restoreFrom(sandbox, handle);
			this.kept.delete(spec.sessionId);
		}
		await this.options.applyEgress?.(sandbox, spec.egress.allow);
		const ref: WorkspaceRef = { id: spec.sessionId, providerId: this.id, sessionId: spec.sessionId };
		this.entries.set(spec.sessionId, { ref, sandbox, state: "running", createdAt: Date.now() });
		return ref;
	}

	async get(ref: WorkspaceRef): Promise<Workspace | null> {
		if (ref.providerId !== this.id) return null;
		let entry = this.entries.get(ref.sessionId);
		if (entry?.state === "gone") return null;
		if (!entry) {
			const sandbox = this.options.sandboxFor(ref.sessionId);
			try {
				if ((await sandbox.exec("test -d /workspace")).exitCode !== 0) return null;
			} catch {
				return null;
			}
			entry = { ref, sandbox, state: "running", createdAt: Date.now() };
			this.entries.set(ref.sessionId, entry);
		}
		return entry.ref.id === ref.id ? new CloudflareWorkspace(entry, this, this.options) : null;
	}

	async destroy(ref: WorkspaceRef, o: { keepVolume?: boolean } = {}): Promise<void> {
		const entry = this.entries.get(ref.sessionId);
		if (!entry || entry.state === "gone" || entry.ref.id !== ref.id) return;
		if (o.keepVolume) {
			// Without backups the container is left to sleep with its disk, the best a sandbox can do.
			const backup = this.backupOf(entry.sandbox);
			if (backup && entry.state === "running") {
				this.kept.set(ref.sessionId, await backup());
				await entry.sandbox.destroy?.();
			} else if (entry.parked) this.kept.set(ref.sessionId, entry.parked);
		} else await entry.sandbox.destroy?.();
		// The entry stays as a "gone" marker, so `get` does not reopen a sandbox whose disk was kept; `create` replaces it.
		entry.state = "gone";
		entry.parked = undefined;
	}

	async list(filter: WorkspaceFilter = {}): Promise<WorkspaceInfo[]> {
		return [...this.entries.values()]
			.filter((entry) => entry.state !== "gone" && (!filter.sessionId || entry.ref.sessionId === filter.sessionId) && (!filter.state || entry.state === filter.state))
			.map((entry) => ({ ref: entry.ref, state: entry.state, createdAt: entry.createdAt }));
	}
}
