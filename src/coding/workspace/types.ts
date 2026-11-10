// The interface between a coding thread's agent loop and the machine its code lives on. The loop runs in a Durable Object; a workspace is a dumb remote machine reached through these types, so Compose, Cloudflare Sandbox and Kubernetes backends can all stand behind one contract. Nothing here may depend on a particular backend.

/** Every path a workspace accepts is inside this directory. */
export const WORKSPACE_ROOT = "/workspace";

/** What a new workspace is made from and how far it may go. */
export type WorkspaceSpec = {
	/** The coding thread the workspace belongs to. Creating twice with one session id returns the same workspace. */
	sessionId: string;
	/** The machine image to start from, named as the backend names images. */
	image: string;
	/** The repository checked out into the workspace: where it comes from, the ref to start at, the branch to work on, and optionally how many commits of history to fetch. */
	repo: { url: string; ref: string; branch: string; depth?: number };
	/** The most the workspace may use: CPU cores, memory and disk in MiB, process count, and minutes of wall clock before it is stopped. */
	limits: { cpu: number; memMiB: number; diskMiB: number; pids: number; wallClockMin: number | null };
	/** The hosts the workspace may reach over the network; everything else is refused, on backends that can enforce it. */
	egress: { allow: string[] };
	/** How git authenticates: "none" for public repositories, "broker" for credentials a broker supplies outside the workspace so the machine never holds them. */
	gitAuth: { mode: "none" | "broker" };
	/**
	 * Whose workspace it is, on a backend with `capabilities.environmentSnapshots`: the person and repository its
	 * dependency caches and environment snapshots belong to. With `restoreFrom`, the workspace starts from that
	 * person's snapshot of that repository with this key instead of empty; a restore that fails throws and makes
	 * nothing. A workspace that already exists, or comes back from a kept volume, keeps its own files.
	 */
	environment?: EnvironmentOwner & { restoreFrom?: string };
};

/** One person's prepared environments of one repository: what keeps their caches and snapshots apart from everyone else's. */
export type EnvironmentOwner = { userId: string; repo: string };

/** A snapshot of a prepared environment: a workspace's files once the repository's setup ran, kept by key for its owner. */
export type EnvironmentSnapshot = { key: string; repo: string; createdAt: number; lastUsedAt?: number; size?: number };

/** A durable handle on one workspace. It is plain data, so it can be stored and used again after the Durable Object restarts. */
export type WorkspaceRef = {
	/** The backend's own name for the workspace. */
	id: string;
	/** The id of the provider that made it. */
	providerId: string;
	/** The session the workspace was created for. */
	sessionId: string;
};

/** A handle on a snapshot of a workspace's files, to hand back to `restore`. */
export type SnapshotRef = { id: string; providerId: string };

/** What a workspace is doing. "gone" means it no longer exists. */
export type WorkspaceState = "creating" | "running" | "stopped" | "gone";

/** One line of a provider's listing. */
export type WorkspaceInfo = { ref: WorkspaceRef; state: WorkspaceState; createdAt: number };

/** What `list` may be narrowed by. */
export type WorkspaceFilter = { sessionId?: string; state?: WorkspaceState };

/** One thing that happens while a command runs: output as it arrives, and finally exactly one exit. `code` is null and `signal` names the signal when the command was killed; `timedOut` is true when the kill was because `timeoutMs` ran out. */
export type ExecEvent = { type: "stdout" | "stderr"; data: string } | { type: "exit"; code: number | null; signal?: string; timedOut?: boolean };

/** How a command is run. */
export type ExecOptions = {
	/** The directory to run in, inside the workspace; the workspace root when absent. */
	cwd?: string;
	/** Environment variables added to the command's own. */
	env?: Record<string, string>;
	/** How long the command may run before it is killed and reported as timed out. */
	timeoutMs: number;
	/** Text written to the command's standard input. */
	stdin?: string;
	/** Aborting this kills the command; its exit event then has `timedOut` unset. */
	signal?: AbortSignal;
};

/** What `stat` and `list` report about one path. */
export type FileStat = { name: string; type: "file" | "dir" | "symlink"; size: number; mode: number; mtimeMs: number };

/** A workspace's own state, as far as the backend can tell. */
export type WorkspaceStatus = { state: WorkspaceState; diskBytes?: number; cpu?: number; mem?: number };

/** One running (or stopped) workspace. Every path is under `/workspace`, written absolute or relative to it; a path that leaves it, by `..` or through a symlink, throws `WorkspacePathError`. */
export interface Workspace {
	/** Runs a command, streaming its output and ending with one exit event. It never throws for a failing command; a non-zero exit is an event. Iterating starts the command and the timeout. */
	exec(cmd: string[], o: ExecOptions): AsyncIterable<ExecEvent>;
	/** Reads a whole file. Throws `WorkspaceFileError` when it does not exist or is a directory. */
	readFile(p: string): Promise<Uint8Array>;
	/** Writes a whole file, making parent directories, replacing what was there. `mode` is the permission bits, 0o644 when absent. */
	writeFile(p: string, data: Uint8Array, mode?: number): Promise<void>;
	/** Lists the entries of a directory, sorted by name. */
	list(p: string): Promise<FileStat[]>;
	/** Describes one path, following symlinks. Throws `WorkspaceFileError` when it does not exist. */
	stat(p: string): Promise<FileStat>;
	/** Removes a file, a symlink (not what it points to) or a directory with everything in it. Throws `WorkspaceFileError` when it does not exist. */
	remove(p: string): Promise<void>;
	/** Captures the files so `restore` can return to them. Throws when the provider's `capabilities.snapshot` is false. */
	snapshot(): Promise<SnapshotRef>;
	/** Replaces the files with those of a snapshot taken from this workspace. */
	restore(s: SnapshotRef): Promise<void>;
	/** Reports the workspace's state and, where the backend can say, its resource use. */
	status(): Promise<WorkspaceStatus>;
	/** Stops the workspace, keeping its files. Stopping a stopped workspace does nothing. */
	stop(): Promise<void>;
	/** Starts a stopped workspace again. Starting a running one does nothing. */
	start(): Promise<void>;
}

/** A way of making workspaces. */
export interface WorkspaceProvider {
	/** A stable name for the backend, such as "compose" or "fake". */
	id: string;
	/** What the backend can do; callers and the conformance suite check it before relying on optional features. */
	capabilities: {
		/** Whether `snapshot` and `restore` work. */
		snapshot: boolean;
		/** Whether keyed environment snapshots work: `spec.environment.restoreFrom`, `snapshotEnvironment`, `listEnvironments` and `deleteEnvironment`. */
		environmentSnapshots: boolean;
		/** Whether `spec.egress.allow` is enforced. */
		egressAllowlist: boolean;
		/** The most workspaces the backend runs at once, when it has a limit. */
		maxConcurrent?: number;
	};
	/** Makes a workspace, or returns the one that already exists for `spec.sessionId`. Throws `WorkspaceCapacityError` when the backend is full. */
	create(spec: WorkspaceSpec): Promise<WorkspaceRef>;
	/** Opens a workspace, or returns null when it does not exist. */
	get(ref: WorkspaceRef): Promise<Workspace | null>;
	/** Deletes a workspace; destroying one that is already gone does nothing. With `keepVolume` its files are kept, and creating again for the same session brings them back. */
	destroy(ref: WorkspaceRef, o?: { keepVolume?: boolean }): Promise<void>;
	/** Lists the workspaces that exist, optionally narrowed. */
	list(filter?: WorkspaceFilter): Promise<WorkspaceInfo[]>;
	/**
	 * Keeps the files of a running workspace made with `spec.environment` of this owner as the owner's environment
	 * snapshot with `key`, or returns the one already kept with it. The caller makes sure the workspace holds no
	 * secrets then; a backend may also leave out credential files it knows. Throws when
	 * `capabilities.environmentSnapshots` is false.
	 */
	snapshotEnvironment(ref: WorkspaceRef, o: EnvironmentOwner & { key: string }): Promise<EnvironmentSnapshot>;
	/** The owner's environment snapshots of the repository, newest first. Throws when `capabilities.environmentSnapshots` is false. */
	listEnvironments(owner: EnvironmentOwner): Promise<EnvironmentSnapshot[]>;
	/** Deletes the person's environment snapshot with `key`; false when they have none. Throws when `capabilities.environmentSnapshots` is false. */
	deleteEnvironment(userId: string, key: string): Promise<boolean>;
}

/** The backend is running as many workspaces as it can; try again after one is destroyed. */
export class WorkspaceCapacityError extends Error {
	constructor(message = "The workspace backend is at capacity") {
		super(message);
		this.name = "WorkspaceCapacityError";
	}
}

/** The workspace does not exist, or was destroyed. */
export class WorkspaceNotFoundError extends Error {
	constructor(message = "No such workspace") {
		super(message);
		this.name = "WorkspaceNotFoundError";
	}
}

/**
 * The workspace stopped answering for good: its container, its manager or
 * its host died, and what ran in it was lost. Its files may still be there
 * (a kept volume): the thread makes the workspace again from them.
 */
export class WorkspaceLostError extends Error {
	constructor(message = "The workspace stopped answering: its container or the machine it ran on went down, so what ran in it was lost. The workspace is made again from its saved files: check what state it is in (git status) before going on.") {
		super(message);
		this.name = "WorkspaceLostError";
	}
}

/** A path left `/workspace`, directly or through a symlink. */
export class WorkspacePathError extends Error {
	constructor(path: string) {
		super(`Path escapes ${WORKSPACE_ROOT}: ${path}`);
		this.name = "WorkspacePathError";
	}
}

/** A file operation failed because of what is at the path, such as a missing file or a directory where a file was expected. */
export class WorkspaceFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceFileError";
	}
}

/** A write would take the workspace past its disk limit. */
export class WorkspaceLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceLimitError";
	}
}
