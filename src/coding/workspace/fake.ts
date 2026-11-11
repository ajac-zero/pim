// An in-memory workspace provider for tests. It keeps files in a map, runs a tiny scripted shell, and is the first backend the shared conformance suite (conformance.ts) runs against. It is a reference for the contract in types.ts, not a sandbox.

import {
	type EnvironmentOwner,
	type EnvironmentSnapshot,
	type ExecEvent,
	type ExecOptions,
	type FileStat,
	type SnapshotRef,
	WORKSPACE_ROOT,
	WorkspaceCapacityError,
	type WorkspaceFilter,
	WorkspaceFileError,
	type WorkspaceInfo,
	WorkspaceLimitError,
	WorkspaceNotFoundError,
	WorkspacePathError,
	type WorkspaceProvider,
	type WorkspaceRef,
	type WorkspaceSpec,
	type Workspace,
	type WorkspaceState,
	type WorkspaceStatus,
} from "./types";

type Node = { type: "dir"; mode: number; mtimeMs: number } | { type: "file"; data: Uint8Array; mode: number; mtimeMs: number } | { type: "symlink"; target: string; mode: number; mtimeMs: number };

type Nodes = Map<string, Node>;

/** What a registered command receives. `killed` resolves when the command is killed by a timeout or an abort, and a handler that waits should stop then. */
export type FakeCommandContext = { argv: string[]; cwd: string; env: Record<string, string>; stdin: string; killed: Promise<void>; workspace: Workspace };

/** What a registered command produces: its output and exit code (0 when absent). */
export type FakeCommandResult = { stdout?: string; stderr?: string; code?: number };

export type FakeCommandHandler = (context: FakeCommandContext) => FakeCommandResult | Promise<FakeCommandResult>;

export type FakeProviderOptions = {
	/** The most workspaces that exist at once; unlimited when absent. */
	maxConcurrent?: number;
};

const MIB = 1024 * 1024;
const MAX_LINK_DEPTH = 32;

/** Turns a path into its segments below the workspace root, or throws when it leaves the root. Lexical only; symlinks are followed by the caller. */
function segmentsOf(path: string): string[] {
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
	return stack.slice(1);
}

const join = (segments: string[]) => (segments.length === 0 ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${segments.join("/")}`);

/** Splits a script line into words, honoring single and double quotes. */
function words(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | null = null;
	let started = false;
	for (const char of line) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			started = true;
		} else if (/\s/.test(char)) {
			if (started || current) out.push(current);
			current = "";
			started = false;
		} else current += char;
	}
	if (started || current) out.push(current);
	return out;
}

/** Tracks one running command's timeout and abort signal. */
class Kill {
	reason?: "timeout" | "abort";
	readonly promise: Promise<void>;
	private timer?: ReturnType<typeof setTimeout>;
	private release: () => void = () => {};
	private onAbort?: () => void;

	constructor(
		timeoutMs: number,
		private signal?: AbortSignal,
	) {
		this.promise = new Promise<void>((resolve) => {
			this.release = resolve;
		});
		this.timer = setTimeout(() => this.kill("timeout"), timeoutMs);
		if (signal?.aborted) this.kill("abort");
		else if (signal) {
			this.onAbort = () => this.kill("abort");
			signal.addEventListener("abort", this.onAbort);
		}
	}

	private kill(reason: "timeout" | "abort") {
		this.reason ??= reason;
		this.release();
	}

	/** Waits `ms`, or less if the command is killed; returns whether it was killed. */
	async sleep(ms: number): Promise<boolean> {
		if (this.reason) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))), this.promise]);
		clearTimeout(timer);
		return this.reason !== undefined;
	}

	dispose() {
		clearTimeout(this.timer);
		if (this.onAbort) this.signal?.removeEventListener("abort", this.onAbort);
	}
}

class FakeWorkspace implements Workspace {
	state: WorkspaceState = "running";
	nodes: Nodes = new Map();

	constructor(
		readonly ref: WorkspaceRef,
		readonly spec: WorkspaceSpec,
		private handlers: Map<string, FakeCommandHandler>,
		private snapshots: Map<string, Nodes>,
	) {}

	private live() {
		if (this.state === "gone") throw new WorkspaceNotFoundError();
	}

	private running() {
		this.live();
		if (this.state !== "running") throw new Error("The workspace is stopped");
	}

	/** Finds the real path a path names, following symlinks in every segment (the last only when `followLast`). Throws when a link leads out of the root. */
	private resolve(path: string, followLast: boolean): string[] {
		let segments = segmentsOf(path);
		for (let hops = 0; ; hops++) {
			if (hops > MAX_LINK_DEPTH) throw new WorkspaceFileError(`Too many symbolic links: ${path}`);
			let redirected = false;
			for (let i = 0; i < segments.length && !redirected; i++) {
				const node = this.nodes.get(join(segments.slice(0, i + 1)));
				if (node?.type !== "symlink" || (i === segments.length - 1 && !followLast)) continue;
				const target = node.target.startsWith("/") ? node.target : `${join(segments.slice(0, i))}/${node.target}`;
				segments = [...segmentsOf(target), ...segments.slice(i + 1)];
				redirected = true;
			}
			if (!redirected) return segments;
		}
	}

	private mkdirs(segments: string[]) {
		for (let i = 1; i <= segments.length; i++) {
			const path = join(segments.slice(0, i));
			const node = this.nodes.get(path);
			if (!node) this.nodes.set(path, { type: "dir", mode: 0o755, mtimeMs: Date.now() });
			else if (node.type !== "dir") throw new WorkspaceFileError(`Not a directory: ${path}`);
		}
	}

	private lookup(path: string, followLast = true): { path: string; node: Node } {
		const real = join(this.resolve(path, followLast));
		const node = this.nodes.get(real);
		if (!node) throw new WorkspaceFileError(`No such file or directory: ${path}`);
		return { path: real, node };
	}

	private sizeOf(node: Node) {
		return node.type === "file" ? node.data.byteLength : node.type === "symlink" ? node.target.length : 0;
	}

	private statOf(path: string, node: Node): FileStat {
		return { name: path.split("/").pop() ?? "", type: node.type, size: this.sizeOf(node), mode: node.mode, mtimeMs: node.mtimeMs };
	}

	async readFile(p: string): Promise<Uint8Array> {
		this.live();
		const { node } = this.lookup(p);
		if (node.type !== "file") throw new WorkspaceFileError(`Not a file: ${p}`);
		return node.data.slice();
	}

	async writeFile(p: string, data: Uint8Array, mode = 0o644): Promise<void> {
		this.live();
		const segments = this.resolve(p, true);
		if (segments.length === 0) throw new WorkspaceFileError(`Is a directory: ${p}`);
		const path = join(segments);
		if (this.nodes.get(path)?.type === "dir") throw new WorkspaceFileError(`Is a directory: ${p}`);
		const used = [...this.nodes.entries()].reduce((sum, [key, node]) => (key === path ? sum : sum + this.sizeOf(node)), 0);
		if (used + data.byteLength > this.spec.limits.diskMiB * MIB) throw new WorkspaceLimitError(`Writing ${p} would pass the ${this.spec.limits.diskMiB} MiB disk limit`);
		this.mkdirs(segments.slice(0, -1));
		this.nodes.set(path, { type: "file", data: data.slice(), mode, mtimeMs: Date.now() });
	}

	async list(p: string): Promise<FileStat[]> {
		this.live();
		const { path, node } = this.lookup(p);
		if (node.type !== "dir") throw new WorkspaceFileError(`Not a directory: ${p}`);
		const prefix = `${path}/`;
		return [...this.nodes.entries()]
			.filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
			.map(([key, child]) => this.statOf(key, child))
			.sort((a, b) => (a.name < b.name ? -1 : 1));
	}

	async stat(p: string): Promise<FileStat> {
		this.live();
		const { path, node } = this.lookup(p);
		return this.statOf(path, node);
	}

	async remove(p: string): Promise<void> {
		this.live();
		const { path } = this.lookup(p, false);
		if (path === WORKSPACE_ROOT) throw new WorkspaceFileError("Cannot remove the workspace root");
		for (const key of [...this.nodes.keys()]) if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
	}

	async snapshot(): Promise<SnapshotRef> {
		this.live();
		const id = `snap-${this.snapshots.size + 1}-${this.ref.id}`;
		this.snapshots.set(id, cloneNodes(this.nodes));
		return { id, providerId: this.ref.providerId };
	}

	async restore(s: SnapshotRef): Promise<void> {
		this.live();
		const saved = this.snapshots.get(s.id);
		if (!saved) throw new WorkspaceNotFoundError(`No such snapshot: ${s.id}`);
		this.nodes = cloneNodes(saved);
	}

	async status(): Promise<WorkspaceStatus> {
		if (this.state === "gone") return { state: "gone" };
		let diskBytes = 0;
		for (const node of this.nodes.values()) diskBytes += this.sizeOf(node);
		return { state: this.state, diskBytes };
	}

	async stop(): Promise<void> {
		this.live();
		this.state = "stopped";
	}

	async start(): Promise<void> {
		this.live();
		this.state = "running";
	}

	async *exec(cmd: string[], o: ExecOptions): AsyncGenerator<ExecEvent> {
		this.running();
		const cwd = join(this.resolve(o.cwd ?? WORKSPACE_ROOT, true));
		if (this.nodes.get(cwd)?.type !== "dir") throw new WorkspaceFileError(`Not a directory: ${o.cwd}`);
		const kill = new Kill(o.timeoutMs, o.signal);
		try {
			const code = yield* this.run(cmd, { cwd, env: o.env ?? {}, stdin: o.stdin ?? "", kill });
			if (kill.reason) yield { type: "exit", code: null, signal: kill.reason === "timeout" ? "SIGKILL" : "SIGTERM", timedOut: kill.reason === "timeout" };
			else yield { type: "exit", code };
		} finally {
			kill.dispose();
		}
	}

	/** Runs one command and returns its exit code. It stops early once the command is killed. */
	private async *run(argv: string[], ctx: { cwd: string; env: Record<string, string>; stdin: string; kill: Kill }): AsyncGenerator<ExecEvent, number> {
		const [name = "", ...args] = argv;
		const out = (data: string): ExecEvent => ({ type: "stdout", data });
		const err = (data: string): ExecEvent => ({ type: "stderr", data });
		const handler = this.handlers.get(name);
		if (handler) {
			const result = await Promise.race([Promise.resolve(handler({ argv, cwd: ctx.cwd, env: ctx.env, stdin: ctx.stdin, killed: ctx.kill.promise, workspace: this })), ctx.kill.promise.then(() => undefined)]);
			if (!result) return 137;
			if (result.stdout) yield out(result.stdout);
			if (result.stderr) yield err(result.stderr);
			return result.code ?? 0;
		}
		switch (name) {
			case "echo":
				yield out(`${args.join(" ")}\n`);
				return 0;
			case "cat": {
				if (args.length === 0) {
					if (ctx.stdin) yield out(ctx.stdin);
					return 0;
				}
				for (const file of args) {
					try {
						yield out(new TextDecoder().decode(await this.readFile(file.startsWith("/") ? file : `${ctx.cwd}/${file}`)));
					} catch (error) {
						yield err(`cat: ${error instanceof Error ? error.message : error}\n`);
						return 1;
					}
				}
				return 0;
			}
			case "sleep":
				return (await ctx.kill.sleep(Number(args[0]) * 1000)) ? 137 : 0;
			case "ln": {
				const [flag, target, link] = args;
				if (flag !== "-s" || !target || !link) {
					yield err("usage: ln -s TARGET LINK\n");
					return 1;
				}
				const segments = this.resolve(link.startsWith("/") ? link : `${ctx.cwd}/${link}`, false);
				this.mkdirs(segments.slice(0, -1));
				this.nodes.set(join(segments), { type: "symlink", target, mode: 0o777, mtimeMs: Date.now() });
				return 0;
			}
			case "curl": {
				const host = new URL(args[args.length - 1] ?? "").hostname;
				if (!this.spec.egress.allow.includes(host)) {
					yield err(`curl: could not connect to ${host}\n`);
					return 7;
				}
				yield out("ok\n");
				return 0;
			}
			case "mkdir":
				return 0;
			case "exec":
				return yield* this.run(args, ctx);
			case "sh": {
				if (args[0] !== "-c" || args[1] === undefined) {
					yield err("sh: only -c SCRIPT is supported\n");
					return 2;
				}
				let code = 0;
				for (const statement of args[1].split(/&&|[;\n]/)) {
					if (ctx.kill.reason) return 137;
					// `"$@"` is the arguments after the script and `$0`, as the CLI harnesses' `sh -c 'mkdir -p "$TMPDIR" && exec "$@"'` wrappers use it.
					const line = words(statement).flatMap((word) => (word === "$@" ? args.slice(3) : [word]));
					if (line.length === 0) continue;
					if (line[0] === "exit") return Number(line[1] ?? code);
					const toStderr = line[line.length - 1] === ">&2";
					code = yield* this.redirect(this.run(toStderr ? line.slice(0, -1) : line, ctx), toStderr);
				}
				return code;
			}
			default:
				yield err(`${name}: command not found\n`);
				return 127;
		}
	}

	private async *redirect(events: AsyncGenerator<ExecEvent, number>, toStderr: boolean): AsyncGenerator<ExecEvent, number> {
		while (true) {
			const next = await events.next();
			if (next.done) return next.value;
			yield toStderr && next.value.type === "stdout" ? { type: "stderr", data: next.value.data } : next.value;
		}
	}
}

function cloneNodes(nodes: Nodes): Nodes {
	return new Map([...nodes].map(([key, node]) => [key, node.type === "file" ? { ...node, data: node.data.slice() } : { ...node }]));
}

/** A provider whose workspaces live in memory. Its shell understands `echo`, `cat`, `sleep`, `ln -s`, `curl` (which only reaches hosts in the spec's egress list), and `sh -c` over `;`-separated `echo`, `exit` and those commands, with `>&2` after a command. `register` adds or replaces a command by name. Environment snapshots are copies of a workspace's files, kept per person and key as the sandbox manager keeps them. */
export class FakeWorkspaceProvider implements WorkspaceProvider {
	readonly id = "fake";
	readonly capabilities: WorkspaceProvider["capabilities"];
	private handlers = new Map<string, FakeCommandHandler>();
	private workspaces = new Map<string, { workspace: FakeWorkspace; createdAt: number }>();
	private keptVolumes = new Map<string, Nodes>();
	private snapshots = new Map<string, Nodes>();
	/** Environment snapshots by owner and key. A test may mark one `corrupt`: restoring it then fails and deletes it, as the sandbox manager does. */
	readonly environments = new Map<string, EnvironmentSnapshot & { userId: string; nodes: Nodes; corrupt?: boolean }>();
	/** The size new environment snapshots report, as the sandbox manager reports their compressed size; none when unset. */
	environmentSize: number | undefined;
	private counter = 0;

	constructor(options: FakeProviderOptions = {}) {
		this.capabilities = { snapshot: true, environmentSnapshots: true, egressAllowlist: true, maxConcurrent: options.maxConcurrent };
	}

	/** Makes `name` run `handler` in every workspace of this provider. */
	register(name: string, handler: FakeCommandHandler): void {
		this.handlers.set(name, handler);
	}

	async create(spec: WorkspaceSpec): Promise<WorkspaceRef> {
		const existing = this.workspaces.get(spec.sessionId);
		if (existing) return existing.workspace.ref;
		const max = this.capabilities.maxConcurrent;
		if (max !== undefined && this.workspaces.size >= max) throw new WorkspaceCapacityError();
		const kept = this.keptVolumes.get(spec.sessionId);
		const restore = kept ? undefined : spec.environment?.restoreFrom;
		let restored: Nodes | undefined;
		if (restore !== undefined && spec.environment) {
			const id = environmentId(spec.environment.userId, restore);
			const saved = this.environments.get(id);
			if (!saved || saved.repo !== spec.environment.repo) throw new WorkspaceNotFoundError(`No such environment snapshot: ${restore}`);
			if (saved.corrupt) {
				this.environments.delete(id);
				throw new Error("The environment snapshot is corrupt and was deleted");
			}
			saved.lastUsedAt = Date.now();
			restored = cloneNodes(saved.nodes);
		}
		const ref: WorkspaceRef = { id: `fake-${++this.counter}`, providerId: this.id, sessionId: spec.sessionId };
		const workspace = new FakeWorkspace(ref, spec, this.handlers, this.snapshots);
		workspace.nodes = kept ?? restored ?? new Map([[WORKSPACE_ROOT, { type: "dir", mode: 0o755, mtimeMs: Date.now() }]]);
		this.keptVolumes.delete(spec.sessionId);
		this.workspaces.set(spec.sessionId, { workspace, createdAt: Date.now() });
		return ref;
	}

	async get(ref: WorkspaceRef): Promise<Workspace | null> {
		const found = this.workspaces.get(ref.sessionId);
		return found?.workspace.ref.id === ref.id ? found.workspace : null;
	}

	/** Forgets the files a deleted workspace kept (`destroy` with `keepVolume`), as when its host loses the volume. */
	loseVolume(sessionId: string): void {
		this.keptVolumes.delete(sessionId);
	}

	async destroy(ref: WorkspaceRef, o: { keepVolume?: boolean } = {}): Promise<void> {
		const found = this.workspaces.get(ref.sessionId);
		if (found?.workspace.ref.id !== ref.id) return;
		if (o.keepVolume) this.keptVolumes.set(ref.sessionId, found.workspace.nodes);
		found.workspace.state = "gone";
		this.workspaces.delete(ref.sessionId);
	}

	async list(filter: WorkspaceFilter = {}): Promise<WorkspaceInfo[]> {
		return [...this.workspaces.values()]
			.filter(({ workspace }) => (!filter.sessionId || workspace.ref.sessionId === filter.sessionId) && (!filter.state || workspace.state === filter.state))
			.map(({ workspace, createdAt }) => ({ ref: workspace.ref, state: workspace.state, createdAt }));
	}

	/** Refuses a workspace that isn't the owner's, as the sandbox manager does. */
	async snapshotEnvironment(ref: WorkspaceRef, o: EnvironmentOwner & { key: string }): Promise<EnvironmentSnapshot> {
		const found = this.workspaces.get(ref.sessionId);
		if (found?.workspace.ref.id !== ref.id || found.workspace.state !== "running") throw new WorkspaceNotFoundError();
		const owner = found.workspace.spec.environment;
		if (owner?.userId !== o.userId || owner.repo !== o.repo) throw new Error("The workspace isn't this person's, of this repository");
		const id = environmentId(o.userId, o.key);
		const existing = this.environments.get(id);
		if (existing) {
			if (existing.repo !== o.repo) throw new Error("A snapshot with this key exists for another repository");
			return snapshotView(existing);
		}
		const now = Date.now();
		const saved = { userId: o.userId, repo: o.repo, key: o.key, createdAt: now, lastUsedAt: now, ...(this.environmentSize !== undefined ? { size: this.environmentSize } : {}), nodes: cloneNodes(found.workspace.nodes) };
		this.environments.set(id, saved);
		return snapshotView(saved);
	}

	async listEnvironments(owner: EnvironmentOwner): Promise<EnvironmentSnapshot[]> {
		return [...this.environments.values()]
			.filter((saved) => saved.userId === owner.userId && saved.repo === owner.repo)
			.sort((a, b) => b.createdAt - a.createdAt)
			.map(snapshotView);
	}

	async deleteEnvironment(userId: string, key: string): Promise<boolean> {
		return this.environments.delete(environmentId(userId, key));
	}
}

const environmentId = (userId: string, key: string) => `${userId}\0${key}`;

const snapshotView = (saved: EnvironmentSnapshot): EnvironmentSnapshot => ({ key: saved.key, repo: saved.repo, createdAt: saved.createdAt, lastUsedAt: saved.lastUsedAt, ...(saved.size !== undefined ? { size: saved.size } : {}) });
