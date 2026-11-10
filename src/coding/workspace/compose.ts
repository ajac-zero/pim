// The Docker Compose backend: a WorkspaceProvider that talks over HTTP to the sandbox-manager (spikes/coding-sandbox-manager), which runs one gVisor container per session. This file holds no Docker knowledge, only the manager's routes and how its answers map onto the provider contract.
//
// The manager is reached with a bearer token. The token is only ever sent in the Authorization header of requests to the manager: it is never logged, and it is scrubbed from the message of any error this file throws. The manager's URL must be https, unless its host is a loopback or private address (localhost, 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, fc00::/7, fe80::/10), where the traffic does not cross the public internet; and it may not carry a username or password.
//
// Routes used are the manager's own (sandbox-manager/README.md). What is worth knowing:
// - Exec uses `/exec/stream`, so output arrives as the command prints it; aborting drops the connection, which makes the manager kill the command.
// - The create body carries no repository, git auth or wall-clock limit, so the caller checks the repository out with exec and the manager's idle reaper bounds the lifetime. It carries `spec.environment`'s person and repository (`userId`, `repo`), which give the session its dependency cache volume and let it be snapshotted, and `restoreFrom`. It never says `hasRuntimeSecrets`: Pim puts no secrets in a workspace beyond a harness run, which removes them again, and snapshots one only before its first run.
// - Environment snapshots are the manager's `/snapshots` (V1 environment caching), keyed by the caller.
// - The manager's `stat` describes a symlink itself, while `Workspace.stat` follows it, so a symlink is resolved with `readlink -f` run through exec and its target is stat'ed, provided the target is inside /workspace. The workspace image ships coreutils.

import type { ManagerHealth } from "../provider-capacity";
import {
	type EnvironmentOwner,
	type EnvironmentSnapshot,
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
	/** Stands in for the wait between attempts at a request the manager answered transiently, for tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** A request the manager failed transiently is tried up to this many times, waiting 4 s, 8 s, 16 s, 32 s and 64 s (each varied by up to a quarter either way) between them: about two minutes for a manager that is restarting. */
const ATTEMPTS = 6;
const BACKOFF_MS = 4_000;

/** Whether a network error is a refused connection, which means the manager never saw the request. */
const refused = (error: unknown): boolean => {
	const e = error as { code?: string; cause?: unknown; message?: string } | undefined;
	return e?.code === "ECONNREFUSED" || /ECONNREFUSED|connection refused/i.test(e?.message ?? "") || (e?.cause !== undefined && refused(e.cause));
};

const wait = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done);
	});

/** Whether the manager's answer says to try again later: a gateway failure, or, except for a command (see `call`), a request timeout or a rate limit that is not the manager's capacity, which queues the thread instead. */
async function transientStatus(res: Response, exec: boolean): Promise<boolean> {
	if (res.status === 502 || res.status === 503 || res.status === 504) return true;
	if (exec) return false;
	if (res.status === 408) return true;
	if (res.status !== 429) return false;
	const body = (await res.clone().json().catch(() => ({}))) as { code?: string };
	return body.code !== "capacity";
}

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

/** The manager's own exec timeout ceiling, and how long past a command's timeout the client waits for the manager's answer before giving up on it. */
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
const GRACE_MS = 15_000;
const READLINK_TIMEOUT_MS = 10_000;

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

/** A snapshot as the manager describes it. */
type ManagerSnapshot = { key: string; repo: string; size?: number; createdAt: number; lastUsedAt?: number };

const snapshotOf = (s: ManagerSnapshot): EnvironmentSnapshot => ({ key: s.key, repo: s.repo, createdAt: s.createdAt, ...(s.lastUsedAt !== undefined ? { lastUsedAt: s.lastUsedAt } : {}), ...(s.size !== undefined ? { size: s.size } : {}) });

export class ComposeWorkspaceProvider implements WorkspaceProvider {
	readonly id = "compose";
	#capabilities: WorkspaceProvider["capabilities"] = { snapshot: false, environmentSnapshots: true, egressAllowlist: true };
	readonly #base: string;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

	constructor(opts: ComposeOptions & { maxConcurrent?: number }) {
		this.#base = checkManagerUrl(opts.managerUrl);
		this.#token = opts.token;
		this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
		this.#sleep = opts.sleep ?? wait;
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

	/** One request to the manager, tried again with exponential backoff and jitter when the manager can't be reached or answers 502, 503, 504, 408 or a rate limit, as it does while restarting; any other answer is returned at once, and after the last attempt so is the last answer or error. Network failures become an error that names no header. A request aborted through `signal` throws what `fetch` throws, for the caller to recognize. `retry: false` makes one attempt. */
	async call(method: string, path: string, init: { json?: unknown; body?: Uint8Array; signal?: AbortSignal; auth?: boolean; retry?: boolean } = {}): Promise<Response> {
		const attempts = init.retry === false ? 1 : ATTEMPTS;
		// A command may have run before its answer was lost, so exec is tried again only when the manager surely never took it: a refused connection or a gateway answer.
		const exec = /\/exec(\/stream)?$/.test(path);
		for (let attempt = 1; ; attempt++) {
			try {
				const res = await this.#once(method, path, init);
				if (attempt >= attempts || !(await transientStatus(res, exec))) return res;
			} catch (error) {
				if (init.signal?.aborted || attempt >= attempts || (exec && !(error as { refused?: boolean }).refused)) throw error;
			}
			await this.#sleep(BACKOFF_MS * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5), init.signal);
			if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
		}
	}

	async #once(method: string, path: string, init: { json?: unknown; body?: Uint8Array; signal?: AbortSignal; auth?: boolean }): Promise<Response> {
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
			throw Object.assign(new Error(this.#scrub(`Cannot reach the workspace manager: ${error instanceof Error ? error.message : String(error)}`)), { refused: refused(error) });
		}
	}

	/** Throws the error that the manager's answer means, unless it was a success. `path` names the file when the request was about one. */
	async check(res: Response, what: { path?: string; write?: boolean; file?: boolean } = {}): Promise<void> {
		if (res.ok) return;
		const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; limit?: number };
		const message = this.#scrub(body.error ?? `The workspace manager answered ${res.status}`);
		if (res.status === 429 && body.code === "capacity") {
			if (typeof body.limit === "number") this.#capabilities.maxConcurrent = body.limit;
			throw new WorkspaceCapacityError(message);
		}
		// The manager's total workspace disk is promised out, though it frees stopped workspaces first: wait for room as for a full backend.
		if (res.status === 507 && body.code === "workspace_quota") throw new WorkspaceCapacityError(message);
		if (body.code === "path_escape") throw new WorkspacePathError(what.path ?? message);
		if (res.status === 507 && body.code === "disk_full") throw new WorkspaceLimitError(message);
		if (res.status === 413 && what.write) throw new WorkspaceLimitError(message);
		// A 404 without a code is the session; agentd's own refusals carry one, and are about the path.
		if (res.status === 404 && !body.code) throw new WorkspaceNotFoundError(message);
		const sessionRefusal = body.code === "session_stopped" || body.code === "over_disk_quota";
		if (what.file && res.status >= 400 && res.status < 500 && !sessionRefusal && res.status !== 401) throw new WorkspaceFileError(message);
		throw new ComposeManagerError(message, res.status, body.code);
	}

	async create(spec: WorkspaceSpec): Promise<WorkspaceRef> {
		const owner = spec.environment;
		const res = await this.call("POST", "/sessions", {
			json: {
				sessionId: spec.sessionId,
				image: spec.image,
				limits: { cpu: spec.limits.cpu, memMiB: spec.limits.memMiB, diskMiB: spec.limits.diskMiB, pids: spec.limits.pids },
				egressAllow: spec.egress.allow,
				...(owner ? { userId: owner.userId, repo: owner.repo } : {}),
				...(owner?.restoreFrom !== undefined ? { restoreFrom: { key: owner.restoreFrom } } : {}),
			},
		});
		await this.check(res);
		return { id: spec.sessionId, providerId: this.id, sessionId: spec.sessionId };
	}

	async snapshotEnvironment(ref: WorkspaceRef, o: EnvironmentOwner & { key: string }): Promise<EnvironmentSnapshot> {
		const res = await this.call("POST", "/snapshots", { json: { userId: o.userId, repo: o.repo, key: o.key, sessionId: ref.id } });
		await this.check(res);
		return snapshotOf((await res.json()) as ManagerSnapshot);
	}

	async listEnvironments(owner: EnvironmentOwner): Promise<EnvironmentSnapshot[]> {
		const res = await this.call("GET", `/snapshots?userId=${encodeURIComponent(owner.userId)}&repo=${encodeURIComponent(owner.repo)}`);
		await this.check(res);
		return ((await res.json()) as ManagerSnapshot[]).map(snapshotOf);
	}

	async deleteEnvironment(userId: string, key: string): Promise<boolean> {
		const res = await this.call("DELETE", `/snapshots/${encodeURIComponent(key)}?userId=${encodeURIComponent(userId)}`);
		if (res.status === 404) return false;
		await this.check(res);
		return true;
	}

	async get(ref: WorkspaceRef): Promise<Workspace | null> {
		const res = await this.call("GET", `/sessions/${encodeURIComponent(ref.id)}`);
		if (res.status === 404) return null;
		await this.check(res);
		if (((await res.json()) as ManagerView).state === "gone") return null;
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
		const res = await this.call("GET", "/health", { auth: false, retry: false });
		await this.check(res);
		const h = (await res.json()) as { runsc?: boolean; freeDiskPct?: number | null; maxConcurrent: number; running: number; free: number; sessions?: number };
		this.#capabilities.maxConcurrent = h.maxConcurrent;
		return { freeDiskPct: typeof h.freeDiskPct === "number" ? h.freeDiskPct : Number.NaN, maxConcurrent: h.maxConcurrent, running: h.running, free: h.free, runscVerified: h.runsc === true, sessions: h.sessions ?? h.running };
	}
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
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		o.signal?.addEventListener("abort", onAbort);
		// The manager ends a stream itself a few seconds after the timeout; this only stops waiting on one that went silent.
		let silent = false;
		const timer = setTimeout(() => {
			silent = true;
			controller.abort();
		}, timeoutMs + GRACE_MS);
		try {
			const res = await this.provider.call("POST", `${this.base}/exec/stream`, {
				json: { cmd, cwd: o.cwd ? absolute(o.cwd) : undefined, timeoutMs, stdin: o.stdin, env: o.env },
				signal: controller.signal,
			});
			await this.provider.check(res);
			if (!res.body) throw new ComposeManagerError("The workspace manager sent no exec stream", 502);
			const decoder = new TextDecoder();
			const reader = res.body.getReader();
			let buffer = "";
			let exited = false;
			const parse = (line: string): ExecEvent | null => {
				if (!line.trim()) return null;
				const e = JSON.parse(line) as ExecEvent;
				return e.type === "exit" ? { type: "exit", code: e.code, ...(e.signal ? { signal: e.signal } : {}), ...(e.timedOut ? { timedOut: true } : {}) } : e;
			};
			for (;;) {
				const { done, value } = await reader.read();
				buffer += decoder.decode(value, { stream: !done });
				const lines = buffer.split("\n");
				buffer = done ? "" : (lines.pop() ?? "");
				if (done && lines.at(-1) === "") lines.pop();
				for (const line of lines) {
					const event = parse(line);
					if (!event) continue;
					if (event.type === "exit") exited = true;
					yield event;
				}
				if (done) break;
			}
			if (!exited) throw new ComposeManagerError("The workspace manager's exec stream ended without an exit", 502);
		} catch (error) {
			if (silent) yield { type: "exit", code: null, signal: "SIGKILL", timedOut: true };
			else if (o.signal?.aborted) yield aborted;
			else throw error;
		} finally {
			clearTimeout(timer);
			o.signal?.removeEventListener("abort", onAbort);
		}
	}

	private fileUrl(route: "file" | "list" | "stat", path: string, extra = "") {
		return `${this.base}/${route}?path=${encodeURIComponent(path)}${extra}`;
	}

	private async json<T>(url: string, path: string): Promise<T> {
		const res = await this.provider.call("GET", url);
		await this.provider.check(res, { path, file: true });
		return (await res.json()) as T;
	}

	async readFile(p: string): Promise<Uint8Array> {
		const res = await this.provider.call("GET", this.fileUrl("file", absolute(p)));
		await this.provider.check(res, { path: p, file: true });
		return new Uint8Array(await res.arrayBuffer());
	}

	async writeFile(p: string, data: Uint8Array, mode = 0o644): Promise<void> {
		const res = await this.provider.call("PUT", this.fileUrl("file", absolute(p), `&mode=${mode.toString(8).padStart(4, "0")}`), { body: data });
		await this.provider.check(res, { path: p, write: true, file: true });
	}

	async list(p: string): Promise<FileStat[]> {
		const entries = await this.json<FileStat[]>(this.fileUrl("list", absolute(p)), p);
		return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
	}

	/** The manager describes a symlink itself, so for one, finds where it leads and describes that, keeping the name asked for. */
	async stat(p: string): Promise<FileStat> {
		const path = absolute(p);
		const entry = await this.json<FileStat>(this.fileUrl("stat", path), p);
		if (entry.type !== "symlink") return entry;
		let target = "";
		for await (const e of this.exec(["readlink", "-f", "--", path], { timeoutMs: READLINK_TIMEOUT_MS })) {
			if (e.type === "stdout") target += e.data;
			if (e.type === "exit" && e.code !== 0) throw new WorkspaceFileError(`Cannot resolve the symbolic link: ${p}`);
		}
		// readlink -f follows every link, so what it prints is a real path; one outside /workspace is an escape.
		const resolved = absolute(target.trim());
		return { ...(await this.json<FileStat>(this.fileUrl("stat", resolved), p)), name: entry.name };
	}

	async remove(p: string): Promise<void> {
		const path = absolute(p);
		if (path === WORKSPACE_ROOT) throw new WorkspaceFileError("Cannot remove the workspace root");
		const res = await this.provider.call("DELETE", this.fileUrl("file", path, "&recursive=1"));
		await this.provider.check(res, { path: p, file: true });
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
