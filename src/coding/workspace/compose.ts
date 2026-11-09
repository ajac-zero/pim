// The Docker Compose backend: a WorkspaceProvider that talks over HTTP to the sandbox-manager (spikes/coding-sandbox-manager), which runs one gVisor container per session. This file holds no Docker knowledge, only the manager's routes and how its answers map onto the provider contract.
//
// The manager is reached with a bearer token. The token is only ever sent in the Authorization header of requests to the manager: it is never logged, and it is scrubbed from the message of any error this file throws. The manager's URL must be https, unless its host is a loopback or private address (localhost, 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, fc00::/7, fe80::/10), where the traffic does not cross the public internet; and it may not carry a username or password.
//
// What the manager does not do yet, and so what this provider assumes or works around:
// - Exec is one buffered request: output arrives as stdout, stderr and exit events when the command has ended, not while it runs. Aborting cancels the request, but today's manager only kills a command at its own timeout, which is why `timeoutMs` is always sent.
// - `env` has no field in the manager's exec body, so it goes through `env(1)`. `stat`, `list`, `remove` and a file's mode have no routes, so they run as small `sh` scripts through exec (see `SCRIPTS`), which resolve symlinks inside the container as the manager's own file scripts do.
// - The create body carries no repository, git auth or wall-clock limit, so the caller checks the repository out with exec and the manager's idle reaper bounds the lifetime.
// - `GET /sessions` (list), `POST /sessions/:id/stop` and `/start`, `DELETE /sessions/:id?keepVolume=1`, and a 507 `disk_full` on a file write past the disk limit are routes and answers the manager has to gain. Until it does, these calls fail with the manager's 404 or 405.

import type { ManagerHealth } from "../provider-capacity";
import {
	type ExecEvent,
	type ExecOptions,
	type FileStat,
	type SnapshotRef,
	WORKSPACE_ROOT,
	type Workspace,
	WorkspaceCapacityError,
	WorkspaceFileError,
	type WorkspaceFilter,
	type WorkspaceInfo,
	WorkspaceLimitError,
	WorkspaceNotFoundError,
	WorkspacePathError,
	type WorkspaceProvider,
	type WorkspaceRef,
	type WorkspaceSpec,
	type WorkspaceState,
	type WorkspaceStatus,
} from "./types";

export type ComposeOptions = {
	/** The manager's base URL, such as `https://manager.example` or `http://10.0.0.5:8080`. */
	managerUrl: string;
	/** The manager's bearer token. */
	token: string;
	/** Stands in for the global `fetch`, for tests. */
	fetch?: typeof fetch;
};

/** What `managerHealth` reports: the fields `ProviderCapacity` reads, and what an operator also wants to see. */
export type ComposeManagerHealth = ManagerHealth & {
	/** Whether the gVisor runtime is installed and verified, without which the manager refuses to start workspaces. */
	runscVerified: boolean;
	/** Live sessions, including ones over the limit. */
	sessions: number;
};

/** The manager refused or failed in a way with no workspace error of its own: a refusal for low disk has `code` "low_disk", which `ProviderCapacity.onManagerError` takes. */
export class ComposeManagerError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
		this.name = "ComposeManagerError";
	}
}

/** The scripts that run inside a workspace for what the manager has no route for. Each starts by resolving its path argument `$1` in the container and exits 77 when the result is outside /workspace, 78 when nothing is there, and 79 when a directory was expected. */
export const SCRIPTS = {
	stat: 'p=$(realpath -m -- "$1") || exit 70; case "$p" in /workspace|/workspace/*) ;; *) exit 77;; esac; [ -e "$p" ] || exit 78; stat -L -c \'%F|%s|%a|%Y|%n\' "$p"',
	list: 'p=$(realpath -m -- "$1") || exit 70; case "$p" in /workspace|/workspace/*) ;; *) exit 77;; esac; [ -e "$p" ] || exit 78; [ -d "$p" ] || exit 79; find "$p" -mindepth 1 -maxdepth 1 -exec stat -c \'%F|%s|%a|%Y|%n\' {} +',
	remove:
		'd=$(realpath -m -- "$(dirname -- "$1")") || exit 70; case "$d" in /workspace|/workspace/*) ;; *) exit 77;; esac; t="$d/$(basename -- "$1")"; [ "$t" = /workspace ] && exit 77; [ -e "$t" ] || [ -L "$t" ] || exit 78; rm -rf -- "$t"',
	chmod: 'p=$(realpath -m -- "$1") || exit 70; case "$p" in /workspace/*) ;; *) exit 77;; esac; [ -f "$p" ] || exit 78; chmod "$2" "$p"',
} as const;

/** The manager's own exec timeout ceiling, and how long past a command's timeout the client waits for the manager's answer before giving up on it. */
const MAX_TIMEOUT_MS = 600_000;
const GRACE_MS = 15_000;
const SCRIPT_TIMEOUT_MS = 60_000;

/** Whether a host is one where plain http is acceptable. */
function isLocalHost(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
	}
	return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/** Checks the manager's URL and returns it without a trailing slash. */
function checkManagerUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("The workspace manager URL is not a valid URL");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
		throw new Error("The workspace manager URL must be https, or http only to a loopback or private address");
	}
	if (url.username || url.password) throw new Error("The workspace manager URL must not contain a username or password");
	return url.href.replace(/\/+$/, "");
}

/** Turns a path into its absolute form below the workspace root, or throws when it leaves the root. Lexical only; the manager follows symlinks inside the container. */
function absolute(path: string): string {
	const full = path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`;
	const stack: string[] = [];
	for (const part of full.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			stack.pop();
			if (stack.length === 0) throw new WorkspacePathError(path);
		} else stack.push(part);
	}
	if (stack[0] !== WORKSPACE_ROOT.slice(1)) throw new WorkspacePathError(path);
	return `/${stack.join("/")}`;
}

type ManagerView = { sessionId: string; state?: WorkspaceState; createdAt?: number };

export class ComposeWorkspaceProvider implements WorkspaceProvider {
	readonly id = "compose";
	#capabilities: WorkspaceProvider["capabilities"] = { snapshot: false, egressAllowlist: true };
	readonly #base: string;
	readonly #token: string;
	readonly #fetch: typeof fetch;

	constructor(opts: ComposeOptions & { maxConcurrent?: number }) {
		this.#base = checkManagerUrl(opts.managerUrl);
		this.#token = opts.token;
		this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
		this.#capabilities.maxConcurrent = opts.maxConcurrent;
	}

	/** `maxConcurrent` is the manager's limit as last seen: from `opts.maxConcurrent`, then refreshed by `managerHealth()` and by a refusal for capacity. It is absent until one of those. */
	get capabilities(): WorkspaceProvider["capabilities"] {
		return { ...this.#capabilities };
	}

	/** Removes the token from text that may reach a log or a caller. */
	#scrub(text: string): string {
		return this.#token ? text.split(this.#token).join("[token]") : text;
	}

	/** One request to the manager. Network failures become an error that names no header. A request aborted through `signal` throws what `fetch` throws, for the caller to recognize. */
	async call(method: string, path: string, init: { json?: unknown; body?: Uint8Array; signal?: AbortSignal; auth?: boolean } = {}): Promise<Response> {
		const headers: Record<string, string> = {};
		if (init.auth !== false) headers.authorization = `Bearer ${this.#token}`;
		if (init.json !== undefined) headers["content-type"] = "application/json";
		try {
			return await this.#fetch(`${this.#base}${path}`, {
				method,
				headers,
				body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
				signal: init.signal,
			});
		} catch (error) {
			if (init.signal?.aborted) throw error;
			throw new Error(this.#scrub(`Cannot reach the workspace manager: ${error instanceof Error ? error.message : String(error)}`));
		}
	}

	/** Throws the error that the manager's answer means, unless it was a success. `path` names the file when the request was about one. */
	async check(res: Response, what: { path?: string; write?: boolean } = {}): Promise<void> {
		if (res.ok) return;
		const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; limit?: number };
		const message = this.#scrub(body.error ?? `The workspace manager answered ${res.status}`);
		if (res.status === 429 && body.code === "capacity") {
			if (typeof body.limit === "number") this.#capabilities.maxConcurrent = body.limit;
			throw new WorkspaceCapacityError(message);
		}
		if (res.status === 403 && what.path !== undefined) throw new WorkspacePathError(what.path);
		if (res.status === 404) {
			if (/no such file/i.test(message)) throw new WorkspaceFileError(message);
			throw new WorkspaceNotFoundError(message);
		}
		if (what.write && (res.status === 413 || (res.status === 507 && body.code !== "low_disk"))) throw new WorkspaceLimitError(message);
		throw new ComposeManagerError(message, res.status, body.code);
	}

	async create(spec: WorkspaceSpec): Promise<WorkspaceRef> {
		const res = await this.call("POST", "/sessions", {
			json: { sessionId: spec.sessionId, image: spec.image, limits: { cpu: spec.limits.cpu, memMiB: spec.limits.memMiB, diskMiB: spec.limits.diskMiB, pids: spec.limits.pids }, egressAllow: spec.egress.allow },
		});
		await this.check(res);
		return { id: spec.sessionId, providerId: this.id, sessionId: spec.sessionId };
	}

	async get(ref: WorkspaceRef): Promise<Workspace | null> {
		const res = await this.call("GET", `/sessions/${encodeURIComponent(ref.id)}`);
		if (res.status === 404) return null;
		await this.check(res);
		return new ComposeWorkspace(this, ref.id);
	}

	async destroy(ref: WorkspaceRef, o: { keepVolume?: boolean } = {}): Promise<void> {
		const res = await this.call("DELETE", `/sessions/${encodeURIComponent(ref.id)}${o.keepVolume ? "?keepVolume=1" : ""}`);
		if (res.status === 404) return;
		await this.check(res);
	}

	async list(filter: WorkspaceFilter = {}): Promise<WorkspaceInfo[]> {
		const res = await this.call("GET", "/sessions");
		await this.check(res);
		const views = (await res.json()) as ManagerView[];
		return views
			.map((view): WorkspaceInfo => ({ ref: { id: view.sessionId, providerId: this.id, sessionId: view.sessionId }, state: view.state ?? "running", createdAt: view.createdAt ?? 0 }))
			.filter((info) => (!filter.sessionId || info.ref.sessionId === filter.sessionId) && (!filter.state || info.state === filter.state));
	}

	/** Reads the manager's `/health`, which needs no token, and refreshes `capabilities.maxConcurrent`. `freeDiskPct` is NaN when the manager couldn't read its disk, which `ProviderCapacity` counts as low. */
	async managerHealth(): Promise<ComposeManagerHealth> {
		const res = await this.call("GET", "/health", { auth: false });
		await this.check(res);
		const h = (await res.json()) as { runsc?: boolean; freeDiskPct?: number | null; maxConcurrent: number; running: number; free: number; sessions?: number };
		this.#capabilities.maxConcurrent = h.maxConcurrent;
		return { freeDiskPct: typeof h.freeDiskPct === "number" ? h.freeDiskPct : Number.NaN, maxConcurrent: h.maxConcurrent, running: h.running, free: h.free, runscVerified: h.runsc === true, sessions: h.sessions ?? h.running };
	}
}

const statType = (kind: string): FileStat["type"] => (kind.startsWith("directory") ? "dir" : kind.startsWith("symbolic") ? "symlink" : "file");

/** Parses lines of `%F|%s|%a|%Y|%n` from stat. */
function parseStats(out: string): FileStat[] {
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [kind = "", size = "0", mode = "0", mtime = "0", ...name] = line.split("|");
			return { name: name.join("|").split("/").pop() ?? "", type: statType(kind), size: Number(size), mode: Number.parseInt(mode, 8), mtimeMs: Number(mtime) * 1000 };
		});
}

class ComposeWorkspace implements Workspace {
	constructor(
		private provider: ComposeWorkspaceProvider,
		private id: string,
	) {}

	private get base() {
		return `/sessions/${encodeURIComponent(this.id)}`;
	}

	async *exec(cmd: string[], o: ExecOptions): AsyncGenerator<ExecEvent> {
		const aborted: ExecEvent = { type: "exit", code: null, signal: "SIGTERM" };
		if (o.signal?.aborted) return yield aborted;
		const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.ceil(o.timeoutMs)));
		const env = Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${v}`);
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		o.signal?.addEventListener("abort", onAbort);
		// The manager enforces the timeout itself; this only stops waiting on a manager that went silent.
		let silent = false;
		const timer = setTimeout(() => {
			silent = true;
			controller.abort();
		}, timeoutMs + GRACE_MS);
		try {
			const res = await this.provider.call("POST", `${this.base}/exec`, { json: { cmd: env.length ? ["env", ...env, ...cmd] : cmd, cwd: o.cwd ? absolute(o.cwd) : undefined, timeoutMs, stdin: o.stdin }, signal: controller.signal });
			await this.provider.check(res);
			const r = (await res.json()) as { stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean };
			if (r.stdout) yield { type: "stdout", data: r.stdout };
			if (r.stderr) yield { type: "stderr", data: r.stderr };
			// A killed command has no meaningful exit code, whatever the shell inside reported.
			yield r.timedOut ? { type: "exit", code: null, signal: "SIGKILL", timedOut: true } : { type: "exit", code: r.exitCode };
		} catch (error) {
			if (silent) yield { type: "exit", code: null, signal: "SIGKILL", timedOut: true };
			else if (o.signal?.aborted) yield aborted;
			else throw error;
		} finally {
			clearTimeout(timer);
			o.signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Runs one of `SCRIPTS` and returns what it printed, mapping its exit codes to errors. */
	private async script(name: keyof typeof SCRIPTS, path: string, ...rest: string[]): Promise<string> {
		const res = await this.provider.call("POST", `${this.base}/exec`, { json: { cmd: ["sh", "-c", SCRIPTS[name], "sh", path, ...rest], timeoutMs: SCRIPT_TIMEOUT_MS } });
		await this.provider.check(res);
		const r = (await res.json()) as { stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean };
		if (r.exitCode === 77) throw new WorkspacePathError(path);
		if (r.exitCode === 78) throw new WorkspaceFileError(`No such file or directory: ${path}`);
		if (r.exitCode === 79) throw new WorkspaceFileError(`Not a directory: ${path}`);
		if (r.exitCode !== 0) throw new ComposeManagerError(`${name} failed in the workspace${r.timedOut ? " (timed out)" : `: ${r.stderr.slice(0, 200)}`}`, 500);
		return r.stdout;
	}

	async readFile(p: string): Promise<Uint8Array> {
		const path = absolute(p);
		const res = await this.provider.call("GET", `${this.base}/files?path=${encodeURIComponent(path)}`);
		await this.provider.check(res, { path: p });
		return new Uint8Array(await res.arrayBuffer());
	}

	async writeFile(p: string, data: Uint8Array, mode = 0o644): Promise<void> {
		const path = absolute(p);
		const res = await this.provider.call("PUT", `${this.base}/files?path=${encodeURIComponent(path)}`, { body: data });
		await this.provider.check(res, { path: p, write: true });
		await this.script("chmod", path, mode.toString(8));
	}

	async list(p: string): Promise<FileStat[]> {
		return parseStats(await this.script("list", absolute(p))).sort((a, b) => (a.name < b.name ? -1 : 1));
	}

	async stat(p: string): Promise<FileStat> {
		const [found] = parseStats(await this.script("stat", absolute(p)));
		if (!found) throw new WorkspaceFileError(`No such file or directory: ${p}`);
		return found;
	}

	async remove(p: string): Promise<void> {
		const path = absolute(p);
		if (path === WORKSPACE_ROOT) throw new WorkspaceFileError("Cannot remove the workspace root");
		await this.script("remove", path);
	}

	async snapshot(): Promise<SnapshotRef> {
		throw new Error("The compose backend cannot snapshot");
	}

	async restore(): Promise<void> {
		throw new Error("The compose backend cannot snapshot");
	}

	async status(): Promise<WorkspaceStatus> {
		const res = await this.provider.call("GET", this.base);
		if (res.status === 404) return { state: "gone" };
		await this.provider.check(res);
		const view = (await res.json()) as { state?: WorkspaceState };
		return { state: view.state ?? "running" };
	}

	async stop(): Promise<void> {
		await this.provider.check(await this.provider.call("POST", `${this.base}/stop`));
	}

	async start(): Promise<void> {
		await this.provider.check(await this.provider.call("POST", `${this.base}/start`));
	}
}
