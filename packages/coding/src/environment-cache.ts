import type { EnvService } from "./env-config";
import type { EnvironmentDependencies, EnvironmentToolchain, TestCommand } from "./repo-environment";
import type { ExecEvent, Workspace } from "./workspace/types";

/**
 * A repository's prepared environment for coding threads: the checkout with
 * the toolchains and dependencies its files pin (./repo-environment.ts)
 * provisioned, then its setup script run, kept by the
 * workspace backend as a snapshot (`WorkspaceProvider.snapshotEnvironment`)
 * under a key, so a new thread starts from it instead of installing again.
 *
 * The key is a digest of everything the environment is made from: whose it
 * is (the person and the repository, so no one else's thread ever finds it),
 * the provisioning steps (with the versions they install), the setup
 * script, the repository's lockfiles and the workspace image. A
 * change to any of them is another key, so a snapshot is never stale; old
 * ones are left for the backend to collect.
 *
 * A snapshot is also one sandbox pool's (./pools.ts): what one pool's
 * provider made another's may not restore, so the key covers the pool too,
 * except for a provider's first pool, whose keys are the ones made before
 * snapshots were kept per pool. Those snapshots stay where they were made
 * and still resolve, so nothing is migrated or lost.
 *
 * The thread (./thread-do.ts) decides when to restore, build and snapshot;
 * this module holds what that needs and nothing that touches the thread.
 */

/** Where a thread's environment is: none to prepare (the repository itself declares no setup), unsupported (no longer produced: every backend runs the lifecycle; kept for old rows), being restored or built, ready from a snapshot, or failed (the thread goes on without it). */
export type EnvironmentState = "none" | "unsupported" | "restoring" | "cached" | "building" | "failed";

/** A thread's environment, as its row and its API view have it. Durations are in milliseconds, measured on a monotonic clock; times are ms since the epoch. */
export type CodingEnvironment = {
	readonly state: EnvironmentState;
	/** The sandbox pool whose snapshot the environment is: the one the thread restored from or, cold-provisioned, keeps its snapshot for; null before it is ready. */
	readonly pool: string | null;
	/** Why a thread saved as "unsupported" was; no longer set. */
	readonly reason?: string;
	/** The environment's key, once the repository is checked out and the setup script found; null without one. */
	readonly key: string | null;
	/** Where the setup script came from: the person's setting for the repository, `.pim/env.json` or `.pim/setup.sh` in it, or its mise or dev container configuration. */
	readonly source: "settings" | "env" | "repository" | "mise" | "devcontainer" | null;
	/** When the snapshot the thread has was made. */
	readonly builtAt: number | null;
	/** The snapshot the workspace was restored from, which may be an older key's when the repository moved on. */
	readonly restoredFromKey: string | null;
	/** Making the workspace and checking the repository out, restore included. */
	readonly provisionMs: number | null;
	/** Restoring the snapshot, as part of making the workspace. */
	readonly restoreMs: number | null;
	/** Provisioning the toolchains and dependencies, and running the setup script. */
	readonly setupMs: number | null;
	/** Keeping the snapshot after setup. */
	readonly snapshotMs: number | null;
	/** The size of the snapshot the thread took or was restored from, compressed, as the backend stores it; null when it doesn't say. */
	readonly snapshotBytes: number | null;
	/** Whether the snapshot was kept for the threads after it (`snapshotWorthKeeping`): false when restoring it would have taken longer than setting up again, so it was deleted or never taken; null before a build. */
	readonly snapshotKept: boolean | null;
	/** How the thread's environment became ready: restored from a snapshot, or by running the setup script in the thread's workspace; null until it is. */
	readonly readyFrom: "snapshot" | "setup" | null;
	/** When the thread last readied its environment: restored it, built it, failed, or found no setup script; null before it first does. */
	readonly preparedAt: number | null;
	/** Whether a rebuild was asked for and hasn't finished yet. */
	readonly rebuildRequested: boolean;
	/** Why it failed, briefly; the setup script's own words are untrusted and cut short. */
	readonly error?: string;
	/** The toolchains the repository's files pin, where each version came from, and how its install went. */
	readonly toolchains: readonly EnvironmentToolchain[];
	/** The dependency installs run for its lockfiles, and how each went. */
	readonly dependencies: readonly EnvironmentDependencies[];
	/** The commands the repository checks itself with, found in its files; the coding agent is told them. */
	readonly testCommands: readonly TestCommand[];
	/** What was found and isn't provisioned, such as the services its CI starts. */
	readonly notes: readonly string[];
	/** The services `.pim/env.json` declares; they are described, not started. */
	readonly services: readonly EnvService[];
	/** The paths `.pim/env.json` says are worth caching between threads. */
	readonly cachePaths: readonly string[];
};

/** A thread whose environment nothing has happened to yet. */
export const NO_ENVIRONMENT: CodingEnvironment = {
	state: "none",
	pool: null,
	key: null,
	source: null,
	builtAt: null,
	restoredFromKey: null,
	provisionMs: null,
	restoreMs: null,
	setupMs: null,
	snapshotMs: null,
	snapshotBytes: null,
	snapshotKept: null,
	readyFrom: null,
	preparedAt: null,
	rebuildRequested: false,
	toolchains: [],
	dependencies: [],
	testCommands: [],
	notes: [],
	services: [],
	cachePaths: [],
};

/** The setup script a repository can carry, relative to its root. */
export const SETUP_SCRIPT_PATH = ".pim/setup.sh";

/** The largest setup script, from a setting or the repository, in bytes. */
export const MAX_SETUP_SCRIPT_BYTES = 64 * 1024;

/** How long a setup script may run: as long as the coding tools' longest command. */
export const SETUP_TIMEOUT_MS = 15 * 60_000;

/** How fast a snapshot restores, in MB (10^6 bytes) of the stored snapshot a second, for a provider that doesn't say (`capabilities.restoreMBps`): about what the first live restores did. */
export const DEFAULT_RESTORE_MB_PER_S = 8;

/** How long restoring a snapshot of `bytes` is expected to take, in ms, on a provider that restores `restoreMBps` MB a second. */
export function estimatedRestoreMs(bytes: number, restoreMBps: number = DEFAULT_RESTORE_MB_PER_S): number {
	return bytes / (restoreMBps * 1_000);
}

/**
 * Whether a snapshot is worth keeping for the threads after it: only when
 * restoring it is expected to take less time than the setup did, so a
 * restore is never slower than running the setup again (from the warm
 * dependency cache), at the provider's own restore rate. A snapshot whose
 * backend doesn't report its size is kept, as before sizes were known.
 */
export function snapshotWorthKeeping(setupMs: number, snapshotBytes: number | null, restoreMBps: number = DEFAULT_RESTORE_MB_PER_S): boolean {
	return snapshotBytes === null || estimatedRestoreMs(snapshotBytes, restoreMBps) < setupMs;
}

/** The most of a failure kept on the thread. */
export const MAX_ENVIRONMENT_ERROR_CHARS = 500;

/** The most of the setup script's output looked at when it fails: its end. */
const OUTPUT_TAIL_CHARS = 4096;

const LOCKFILE_NAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "uv.lock", "poetry.lock", "go.sum", "mise.toml", ".mise.toml", ".tool-versions", "mise.lock"]);

/** Whether a file of this name pins what the environment installs: the lockfiles the key covers, `requirements*.txt`, and mise's configuration, which `mise install` installs as it is. */
export function isLockfile(name: string): boolean {
	return LOCKFILE_NAMES.has(name) || /^requirements[^/]*\.txt$/.test(name);
}

/** What an environment's key is made from. `lockfiles` maps each lockfile's path in the repository to its SHA-256. */
export type EnvironmentKeyInput = {
	readonly userId: string;
	readonly repo: string;
	/** The provisioning steps' scripts, in order (./repo-environment.ts): they name the versions they install. */
	readonly provision: readonly string[];
	/** What the setup is made from: the script, or for a setup the repository's configuration describes (a mise task, a dev container's commands) the text that defines it; null without a setup. */
	readonly setupScript: string | null;
	/** Where the setup came from (`settings`, `repository`, `mise`, `devcontainer`); null without one. A new source with the same content is another environment. */
	readonly setupSource?: string | null;
	/** The concrete versions, or the expiry periods, of the toolchains that aren't pinned (`unpinnedKeyParts` in ./repo-environment.ts), so `lts` and `latest` don't keep a snapshot forever. */
	readonly unpinned?: readonly string[];
	readonly lockfiles: Readonly<Record<string, string>>;
	/** The workspace image as the backend names it; a digest-pinned reference changes with the image. */
	readonly image: string;
	/** The sandbox pool the snapshot belongs to; absent for the key made before snapshots were kept per pool, which a provider's first pool keeps (`ownsLegacySnapshots`). */
	readonly pool?: string;
};

/** The environment's key: 64 hex digits of SHA-256 over every input, in an order that doesn't depend on how `lockfiles` was listed. */
export async function environmentKey(input: EnvironmentKeyInput): Promise<string> {
	const lockfiles = Object.entries(input.lockfiles).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const script = input.setupScript === null ? null : await sha256Hex(new TextEncoder().encode(input.setupScript));
	const parts = ["pim-environment/3", input.userId, input.repo, input.provision, input.setupSource ?? null, script, lockfiles, input.image, [...(input.unpinned ?? [])].sort()];
	if (input.pool !== undefined) parts.push(input.pool);
	return sha256Hex(new TextEncoder().encode(JSON.stringify(parts)));
}

/** The lockfiles at the repository's root and in its directories one level down (a workspace's packages), each with its SHA-256. Dot-directories and `node_modules` are skipped. */
export async function lockfileHashes(workspace: Workspace, root: string): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	const visit = async (dir: string, prefix: string, descend: boolean) => {
		for (const entry of await workspace.list(dir)) {
			if (entry.type === "file" && isLockfile(entry.name)) hashes[`${prefix}${entry.name}`] = await sha256Hex(await workspace.readFile(`${dir}/${entry.name}`));
			else if (descend && entry.type === "dir" && !entry.name.startsWith(".") && entry.name !== "node_modules") await visit(`${dir}/${entry.name}`, `${prefix}${entry.name}/`, false);
		}
	};
	await visit(root, "", true);
	return hashes;
}

/** A glob as a regular expression over repository paths: `*` stands for any characters within one name, `**` for any number of directories, so `a/**` followed by `/b` also matches `a/b`. */
export function globRegExp(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]!;
		if (char === "*" && pattern[i + 1] === "*") {
			if (pattern[i + 2] === "/") {
				source += "(?:.*/)?";
				i += 2;
			} else {
				source += ".*";
				i += 1;
			}
		} else if (char === "*") source += "[^/]*";
		else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

const MAX_CACHE_KEY_FILES = 200;
const MAX_CACHE_KEY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_KEY_DEPTH = 6;

/**
 * The SHA-256 of each file the `.pim/env.json` `cacheKeys` patterns match, named `env:<path>` so they sit beside the lockfiles in the key. A pattern with no `*` names one file; the others are matched while walking the repository up to 6 directories deep, skipping dot-directories and `node_modules`. At most 200 files of 2 MiB each are hashed. A pattern that matches nothing is returned in `missing`, and the key leaves it out.
 */
export async function cacheKeyHashes(workspace: Workspace, root: string, patterns: readonly string[]): Promise<{ hashes: Record<string, string>; missing: string[] }> {
	const hashes: Record<string, string> = {};
	const matched = new Set<string>();
	const plain = (pattern: string) => pattern.replace(/^\.\//, "");
	const hash = async (path: string) => {
		if (`env:${path}` in hashes || Object.keys(hashes).length >= MAX_CACHE_KEY_FILES) return;
		try {
			const stat = await workspace.stat(`${root}/${path}`);
			if (stat.type === "file" && stat.size <= MAX_CACHE_KEY_FILE_BYTES) hashes[`env:${path}`] = await sha256Hex(await workspace.readFile(`${root}/${path}`));
		} catch {}
	};
	const globs = patterns.filter((pattern) => pattern.includes("*")).map((pattern) => ({ pattern, regexp: globRegExp(plain(pattern)) }));
	for (const pattern of patterns) if (!pattern.includes("*")) await hash(plain(pattern));
	const visit = async (dir: string, prefix: string, depth: number) => {
		let entries: Awaited<ReturnType<Workspace["list"]>>;
		try {
			entries = await workspace.list(dir);
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const path = `${prefix}${entry.name}`;
			if (entry.type === "file") {
				const hits = globs.filter((each) => each.regexp.test(path));
				for (const hit of hits) matched.add(hit.pattern);
				if (hits.length > 0) await hash(path);
			} else if (entry.type === "dir" && depth < MAX_CACHE_KEY_DEPTH && !entry.name.startsWith(".") && entry.name !== "node_modules") await visit(`${dir}/${entry.name}`, `${path}/`, depth + 1);
		}
	};
	if (globs.length > 0) await visit(root, "", 1);
	const missing = patterns.filter((pattern) => (pattern.includes("*") ? !matched.has(pattern) : !(`env:${plain(pattern)}` in hashes)));
	return { hashes, missing };
}

/** The repository's own setup script, or null when it has none. Throws when it is bigger than `MAX_SETUP_SCRIPT_BYTES`. */
export async function repositorySetupScript(workspace: Workspace, root: string): Promise<string | null> {
	let stat: Awaited<ReturnType<Workspace["stat"]>>;
	try {
		stat = await workspace.stat(`${root}/${SETUP_SCRIPT_PATH}`);
	} catch {
		return null;
	}
	if (stat.type !== "file") return null;
	if (stat.size > MAX_SETUP_SCRIPT_BYTES) throw new Error(`${SETUP_SCRIPT_PATH} is larger than ${MAX_SETUP_SCRIPT_BYTES / 1024} KiB`);
	return new TextDecoder().decode(await workspace.readFile(`${root}/${SETUP_SCRIPT_PATH}`));
}

/** How a setup run ended: it worked, it failed (with what to tell the person), or the thread stopped it. */
export type SetupResult =
	| { readonly outcome: "ok"; readonly exitCode: 0; readonly ms: number; readonly output: string; readonly outputChars: number }
	| { readonly outcome: "failed"; readonly error: string; readonly exitCode: number | null; readonly ms: number; readonly output: string; readonly outputChars: number }
	| { readonly outcome: "stopped" };

/**
 * Runs a setup script with bash in the repository's directory. It runs as
 * every command of the workspace does (its user, egress allowlist and
 * limits), with nothing added to its environment but `CI` and a git that
 * never prompts: no secret of Pim's, and git reaches GitHub only through
 * the broker, as the thread set it up. What it prints is the repository's,
 * so only the end of it is kept, cleaned and cut short, for a failure.
 */
export async function runSetup(workspace: Workspace, script: string, o: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<SetupResult> {
	let tail = "";
	let outputChars = 0;
	const started = performance.now();
	let exit: Extract<ExecEvent, { type: "exit" }> | null = null;
	for await (const event of workspace.exec(["bash", "-c", script], { cwd: o.cwd, timeoutMs: o.timeoutMs ?? SETUP_TIMEOUT_MS, env: SETUP_ENV, signal: o.signal })) {
		if (event.type === "exit") exit = event;
		else {
			tail = (tail + event.data).slice(-OUTPUT_TAIL_CHARS);
			outputChars += event.data.length;
		}
	}
	const ms = Math.round(performance.now() - started);
	if (exit?.code === 0) return { outcome: "ok", exitCode: 0, ms, output: tail, outputChars };
	if (exit && exit.code === null && !exit.timedOut) return { outcome: "stopped" };
	const minutes = Math.round((o.timeoutMs ?? SETUP_TIMEOUT_MS) / 60_000);
	const how = exit === null ? "ended without an exit" : exit.timedOut ? `ran out of time after ${minutes} minutes` : `exited ${exit.code}`;
	return { outcome: "failed", error: environmentError(`The setup script ${how}`, tail), exitCode: exit?.code ?? null, ms, output: tail, outputChars };
}

/** The whole environment a setup script is given on top of the workspace's own. */
export const SETUP_ENV: Readonly<Record<string, string>> = { CI: "true", GIT_TERMINAL_PROMPT: "0" };

/** A failure as the thread keeps it: what happened, then the end of what was printed, without control characters, at most `MAX_ENVIRONMENT_ERROR_CHARS`. */
export function environmentError(what: string, output = ""): string {
	const clean = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
	const room = MAX_ENVIRONMENT_ERROR_CHARS - what.length - 2;
	if (!clean || room <= 0) return what.slice(0, MAX_ENVIRONMENT_ERROR_CHARS);
	return `${what}: ${clean.length > room ? `…${clean.slice(-(room - 1))}` : clean}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
