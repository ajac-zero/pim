import { MAX_SETUP_SCRIPT_BYTES } from "./environment-cache";
import type { ExecEvent, Workspace } from "./workspace/types";

/**
 * What a repository needs to be worked on, read from its checkout: the
 * toolchains it pins (Go, Node, Python, Rust and the package managers), the
 * dependencies that are cheap to install, and the commands it checks itself
 * with. The thread (./thread-do.ts) turns that into provisioning steps that
 * run in the workspace before the repository's own setup script, as part of
 * its environment (./environment-cache.ts), so the steps' versions are in
 * the environment's key and a snapshot keeps what they installed.
 *
 * Toolchains are installed with mise, which the workspace image carries:
 * a repository's own mise configuration (`mise.toml`, `.mise.toml`,
 * `.tool-versions`) is installed as it is, and every other pinned tool is
 * added to mise's global configuration in the workspace's home. mise's shims
 * are on the workspace's PATH, so every command finds them.
 *
 * Nothing here is trusted: the files are the repository's. Versions that
 * aren't plain version words are ignored, so nothing from a file reaches a
 * script but a checked word, and every text kept is cut short.
 */

/** A repository's files, by path relative to its root. */
export interface RepoFiles {
	/** The entries of a directory; none when it doesn't exist. `""` is the root. */
	list(dir: string): Promise<readonly RepoEntry[]>;
	/** A file's text; null when it can't be read. */
	read(path: string): Promise<string | null>;
}

export type RepoEntry = { readonly name: string; readonly dir: boolean; readonly size: number };

/** Where a toolchain's version came from, strongest first. `image`: the workspace image has it and nothing pins another. */
export type ToolchainSource = "mise" | "devcontainer" | "manifest" | "dockerfile" | "default" | "image";

export type DetectedToolchain = {
	readonly tool: string;
	/** As mise takes it: an exact version, a prefix (`1.22` is the newest 1.22.x), `lts`, `stable` or `latest`; null for the image's own. */
	readonly version: string | null;
	readonly source: ToolchainSource;
	/** The file it was read from. */
	readonly from: string;
};

export type DetectedDependencies = {
	readonly tool: string;
	readonly command: string;
	readonly from: string;
	/** The toolchains the command runs with: when one of them couldn't be installed, the command isn't run. */
	readonly needs: readonly string[];
};

export type TestCommandSource = "mise" | "make" | "package.json" | "ci" | "default" | "pim";

/** A command the repository checks itself with: its tests, linters and type checks. */
export type TestCommand = { readonly command: string; readonly source: TestCommandSource; readonly from: string };

export type RepoProfile = {
	readonly toolchains: readonly DetectedToolchain[];
	readonly dependencies: readonly DetectedDependencies[];
	readonly testCommands: readonly TestCommand[];
	/** What was found and isn't provisioned, such as the services a CI workflow starts. */
	readonly notes: readonly string[];
	/** The repository's mise configuration, which `mise install` installs; null without one. */
	readonly mise: string | null;
};

/** One step of provisioning: a bash script run in the repository's directory. */
export type ProvisionStep = {
	readonly id: string;
	readonly kind: "toolchain" | "dependencies";
	readonly tool: string;
	readonly script: string;
	readonly needs: readonly string[];
};

/** The Python a repository gets when it needs Python and pins none. */
export const DEFAULT_PYTHON = "3.13";

/** The largest file read to detect anything. */
const MAX_FILE_BYTES = 256 * 1024;
/** The most test commands kept, and the longest. */
const MAX_TEST_COMMANDS = 12;
const MAX_COMMAND_CHARS = 200;
const MAX_NOTES = 8;

/** What mise calls a tool, where it isn't the tool's own name. */
const MISE_NAMES: Readonly<Record<string, string>> = { pnpm: "npm:pnpm", yarn: "npm:yarn" };
/** asdf's names for tools, as `.tool-versions` may have them. */
const ASDF_NAMES: Readonly<Record<string, string>> = { golang: "go", nodejs: "node" };
/** The tools a devcontainer feature or a Docker image provides, by the feature's or image's name. */
const IMAGE_TOOLS: Readonly<Record<string, string>> = { go: "go", golang: "go", node: "node", "javascript-node": "node", "typescript-node": "node", python: "python", rust: "rust", java: "java", ruby: "ruby", deno: "deno", bun: "bun" };
const MISE_CONFIGS = ["mise.toml", ".mise.toml", ".tool-versions"];
const CI_DIRS = [".github/workflows", ".gitea/workflows"];
const MISE_TASK_DIRS = ["mise-tasks", ".mise/tasks", ".mise-tasks"];
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

const RANK: Record<ToolchainSource, number> = { mise: 0, devcontainer: 1, manifest: 2, dockerfile: 3, default: 5, image: 6 };
/** A loose constraint, such as `engines.node` or `requires-python`: weaker than a Dockerfile's image. */
const LOOSE = 4;

type Candidate = DetectedToolchain & { readonly rank: number };

/** Reads what the repository needs. Never throws: a file that can't be read or understood is passed over. */
export async function detectRepository(files: RepoFiles): Promise<RepoProfile> {
	const root = await files.list("");
	const entry = (name: string) => root.find((each) => each.name === name);
	const has = (name: string) => entry(name) !== undefined;
	const read = async (path: string, size?: number): Promise<string | null> => {
		if (size !== undefined && size > MAX_FILE_BYTES) return null;
		const text = await files.read(path).catch(() => null);
		return text === null || text.length > MAX_FILE_BYTES ? null : text;
	};
	const readRoot = async (name: string) => {
		const found = entry(name);
		return found && !found.dir ? read(name, found.size) : null;
	};
	const listDir = async (dir: string) => {
		const first = dir.split("/")[0]!;
		if (!entry(first)?.dir) return [];
		return files.list(dir).catch(() => []);
	};

	const candidates: Candidate[] = [];
	const notes: string[] = [];
	/** Adds a candidate version for a tool; false when the version isn't a plain version word, and nothing was added. */
	const add = (tool: string, version: string | null, source: ToolchainSource, from: string, rank = RANK[source]): boolean => {
		const clean = version === null ? null : cleanVersion(version);
		if (version !== null && clean === null) return false;
		candidates.push({ tool, version: clean, source, from, rank });
		return true;
	};

	// mise: what the repository's own configuration lists is installed by `mise install`.
	let mise: string | null = null;
	const miseTasks: TestCommand[] = [];
	for (const name of MISE_CONFIGS) {
		const text = await readRoot(name);
		if (text === null) continue;
		mise ??= name;
		const tools = name === ".tool-versions" ? toolVersions(text) : miseTools(text);
		for (const [tool, version] of tools) add(ASDF_NAMES[tool] ?? tool, version, "mise", name);
		if (name !== ".tool-versions") for (const task of miseTaskNames(text)) miseTasks.push({ command: `mise run ${task}`, source: "mise", from: name });
	}
	for (const dir of MISE_TASK_DIRS) {
		for (const each of await listDir(dir)) if (!each.dir && checkName(each.name) && isCheckName(each.name)) miseTasks.push({ command: `mise run ${each.name}`, source: "mise", from: dir });
	}

	// Dev containers: their features install tools; their image only hints at versions.
	const devcontainerPath = entry(".devcontainer")?.dir ? ".devcontainer/devcontainer.json" : has(".devcontainer.json") ? ".devcontainer.json" : null;
	const devcontainer = devcontainerPath ? parseJsonc(await read(devcontainerPath)) : null;
	if (devcontainerPath && isObject(devcontainer)) {
		const features = devcontainer.features;
		if (isObject(features)) {
			for (const [id, options] of Object.entries(features)) {
				const name = id.replace(/[:@].*$/, "").split("/").pop() ?? id;
				const tool = IMAGE_TOOLS[name];
				if (!tool) {
					notes.push(`The dev container feature ${short(name, 60)} (${devcontainerPath}) isn't installed`);
					continue;
				}
				const version = isObject(options) && typeof options.version === "string" ? options.version : typeof options === "string" ? options : "latest";
				if (version === "none" || version === "os-provided") continue;
				add(tool, version, "devcontainer", devcontainerPath);
			}
		}
		if (typeof devcontainer.image === "string") {
			const hint = imageHint(devcontainer.image, true);
			if (hint) add(hint.tool, hint.version, "dockerfile", devcontainerPath);
		}
	}
	const dockerfile = await readRoot("Dockerfile");
	if (dockerfile !== null) {
		for (const match of dockerfile.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/gim)) {
			const hint = imageHint(match[1]!, false);
			if (hint) add(hint.tool, hint.version, "dockerfile", "Dockerfile");
		}
	}

	// Which tools the repository needs at all, from its manifests.
	const needed = new Set<string>();
	const dependencies: DetectedDependencies[] = [];
	const defaults: TestCommand[] = [];

	const goMod = await readRoot("go.mod");
	if (goMod !== null) {
		needed.add("go");
		const toolchain = /^toolchain\s+go(\S+)/m.exec(goMod)?.[1];
		const directive = /^go\s+(\d+(?:\.\d+){1,2})\s*$/m.exec(goMod)?.[1];
		if (!(toolchain && add("go", toolchain, "manifest", "go.mod")) && directive) add("go", directive, "manifest", "go.mod");
		add("go", "latest", "default", "go.mod");
		if (has("go.sum")) dependencies.push({ tool: "go", command: "go mod download", from: "go.sum", needs: ["go"] });
		defaults.push({ command: "go vet ./...", source: "default", from: "go.mod" }, { command: "go test ./...", source: "default", from: "go.mod" });
	}

	const packageJson = parseJson(await readRoot("package.json"));
	let packageManager = "npm";
	if (isObject(packageJson) || has(".nvmrc") || has(".node-version")) needed.add("node");
	for (const name of [".nvmrc", ".node-version"]) {
		const text = await readRoot(name);
		const version = text === null ? null : nodeVersionFile(text);
		if (version) add("node", version, "manifest", name);
	}
	if (isObject(packageJson)) {
		const engines = isObject(packageJson.engines) && typeof packageJson.engines.node === "string" ? nodeRange(packageJson.engines.node) : null;
		if (engines) add("node", engines, "manifest", "package.json", LOOSE);
		const declared = typeof packageJson.packageManager === "string" ? /^(npm|pnpm|yarn|bun)@([^+\s]+)/.exec(packageJson.packageManager) : null;
		const lockfile = has("pnpm-lock.yaml") ? "pnpm" : has("bun.lock") || has("bun.lockb") ? "bun" : has("yarn.lock") ? "yarn" : has("package-lock.json") || has("npm-shrinkwrap.json") ? "npm" : null;
		packageManager = declared?.[1] ?? lockfile ?? "npm";
		if (declared && declared[1] !== "npm") add(declared[1]!, declared[2]!, "manifest", "package.json");
		if (packageManager !== "npm") needed.add(packageManager);
		const install: Record<string, [string, string]> = {
			pnpm: ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
			bun: [has("bun.lock") ? "bun.lock" : "bun.lockb", "bun install --frozen-lockfile"],
			yarn: ["yarn.lock", has(".yarnrc.yml") ? "yarn install --immutable" : "yarn install --frozen-lockfile"],
			npm: [has("npm-shrinkwrap.json") ? "npm-shrinkwrap.json" : "package-lock.json", "npm ci"],
		};
		const [lock, command] = install[packageManager]!;
		if (has(lock)) dependencies.push({ tool: packageManager, command, from: lock, needs: packageManager === "npm" ? ["node"] : ["node", packageManager] });
		else notes.push("package.json has no lockfile, so its dependencies aren't installed");
	}

	const pyproject = await readRoot("pyproject.toml");
	const requirements = root.filter((each) => !each.dir && /^(requirements|requirements-dev|dev-requirements)\.txt$/.test(each.name)).map((each) => each.name);
	const pythonVersionFile = await readRoot(".python-version");
	if (pyproject !== null || requirements.length > 0 || has("uv.lock") || has("setup.py") || pythonVersionFile !== null || has("Pipfile")) {
		needed.add("python");
		const pinned = pythonVersionFile?.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
		if (pinned) add("python", pinned, "manifest", ".python-version");
		const requires = pyproject === null ? null : tomlString(tomlTables(pyproject).get("project")?.get("requires-python"));
		const lower = requires ? pythonRange(requires) : null;
		if (lower) add("python", lower, "manifest", "pyproject.toml", LOOSE);
		add("python", DEFAULT_PYTHON, "default", pyproject !== null ? "pyproject.toml" : (requirements[0] ?? ".python-version"));
		const uv = has("uv.lock");
		if (uv) dependencies.push({ tool: "uv", command: "uv sync --frozen", from: "uv.lock", needs: ["python", "uv"] });
		else if (requirements.length > 0) dependencies.push({ tool: "uv", command: `uv venv --allow-existing && uv pip install ${requirements.map((name) => `-r ${name}`).join(" ")}`, from: requirements.join(", "), needs: ["python", "uv"] });
		if (has("poetry.lock")) notes.push("Poetry isn't installed, so poetry.lock's dependencies aren't");
		if (uv || requirements.length > 0) {
			needed.add("uv");
			add("uv", "latest", "default", uv ? "uv.lock" : requirements[0]!);
		}
		const texts: [string, string | null][] = [["pyproject.toml", pyproject], ...(await Promise.all(requirements.map(async (name) => [name, await readRoot(name)] as [string, string | null])))];
		const pytest = texts.find(([, text]) => text?.includes("pytest"))?.[0] ?? ["pytest.ini", "conftest.py"].find(has);
		if (pytest) defaults.push({ command: uv ? "uv run pytest" : requirements.length > 0 ? ".venv/bin/python -m pytest" : "python -m pytest", source: "default", from: pytest });
	}

	const cargo = has("Cargo.toml");
	for (const name of ["rust-toolchain.toml", "rust-toolchain"]) {
		const text = await readRoot(name);
		if (text === null) continue;
		needed.add("rust");
		const channel = tomlString(tomlTables(text).get("toolchain")?.get("channel")) ?? (text.includes("[") ? null : text.trim().split(/\s+/)[0]);
		if (channel) add("rust", channel, "manifest", name);
	}
	if (cargo) {
		needed.add("rust");
		add("rust", "stable", "default", "Cargo.toml");
		if (has("Cargo.lock")) dependencies.push({ tool: "cargo", command: "cargo fetch --locked", from: "Cargo.lock", needs: ["rust"] });
		defaults.push({ command: "cargo test", source: "default", from: "Cargo.toml" });
	}

	// One toolchain per tool: the strongest source's. A tool nothing needs is installed only when mise or a dev container feature asks for it.
	const best = new Map<string, Candidate>();
	for (const each of candidates) {
		const current = best.get(each.tool);
		if (!current || each.rank < current.rank) best.set(each.tool, each);
	}
	const toolchains: DetectedToolchain[] = [];
	for (const each of best.values()) {
		if (each.source !== "mise" && each.source !== "devcontainer" && !needed.has(each.tool)) continue;
		toolchains.push({ tool: each.tool, version: each.version, source: each.source, from: each.from });
	}
	// Node, pnpm and Yarn come with the image when nothing pins them.
	if (needed.has("node") && !best.has("node")) toolchains.push({ tool: "node", version: null, source: "image", from: has("package.json") ? "package.json" : ".nvmrc" });
	if (isObject(packageJson) && (packageManager === "pnpm" || packageManager === "yarn") && !best.has(packageManager)) toolchains.push({ tool: packageManager, version: null, source: "image", from: "package.json" });
	if (needed.has("bun") && !best.has("bun")) toolchains.push({ tool: "bun", version: "latest", source: "default", from: "package.json" });

	// The commands it checks itself with, in the order a person would look for them.
	const commands: TestCommand[] = [...miseTasks];
	for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
		const text = await readRoot(name);
		if (text === null) continue;
		for (const target of makeTargets(text)) commands.push({ command: `make ${target}`, source: "make", from: name });
		break;
	}
	if (isObject(packageJson) && isObject(packageJson.scripts)) {
		for (const [name, script] of Object.entries(packageJson.scripts)) {
			if (typeof script !== "string" || !isCheckName(name) || /no test specified/.test(script) || !checkName(name)) continue;
			commands.push({ command: `${packageManager} run ${name}`, source: "package.json", from: "package.json" });
		}
	}
	for (const dir of CI_DIRS) {
		for (const each of await listDir(dir)) {
			if (each.dir || !/\.ya?ml$/.test(each.name)) continue;
			const path = `${dir}/${each.name}`;
			const text = await read(path, each.size);
			if (text === null) continue;
			for (const command of workflowCommands(text)) commands.push({ command, source: "ci", from: path });
			const services = workflowServices(text);
			if (services.length > 0) notes.push(`${path} starts the services ${services.map((name) => short(name, 40)).join(", ")}, which aren't running here`);
		}
	}
	if (commands.length === 0) commands.push(...defaults);
	const seen = new Set<string>();
	const testCommands = commands.filter((each) => !seen.has(each.command) && seen.add(each.command)).slice(0, MAX_TEST_COMMANDS);

	return { toolchains, dependencies, testCommands, notes: notes.slice(0, MAX_NOTES), mise };
}

/**
 * The steps that provision what `profile` found, in order: the repository's
 * mise configuration, then each other pinned toolchain, then dependencies.
 * Toolchains that come from the image need no step.
 */
export function provisionPlan(profile: RepoProfile): ProvisionStep[] {
	const steps: ProvisionStep[] = [];
	if (profile.mise && profile.toolchains.some((each) => each.source === "mise")) steps.push({ id: "mise", kind: "toolchain", tool: "mise", script: "mise trust --yes --quiet && mise install --yes", needs: [] });
	for (const each of profile.toolchains) {
		const id = stepOf(each);
		if (id === null || id === "mise") continue;
		const install = `mise use --global --yes ${miseName(each.tool, each.version!)}@${each.version}`;
		steps.push({ id, kind: "toolchain", tool: each.tool, script: [install, ...(each.tool === "pnpm" ? [pnpmPostinstall(each.version!)] : []), verifyTool(each.tool)].join(" && "), needs: [] });
	}
	for (const each of profile.dependencies) steps.push({ id: stepOf(each)!, kind: "dependencies", tool: each.tool, script: each.command, needs: each.needs });
	return steps;
}

/**
 * mise installs npm packages without running their install scripts. pnpm 12 ships its executable as a placeholder text
 * file, `pnpm` in the package's root, that its `preinstall` script (`install.js`) replaces with the native binary, so
 * the shim would make Node parse the placeholder as JavaScript and crash. This runs that script when the placeholder is
 * still there, points mise's \`.bin\` entries at the package's own executables (they would otherwise run the native binary
 * with Node), and rebuilds mise's shims. Earlier pnpm versions have no placeholder and are left alone.
 */
export function pnpmPostinstall(version: string): string {
	return `dir=$(mise where npm:pnpm@${version}) && pkg=$(find "$dir" -type f -path '*/node_modules/pnpm/package.json' | head -n 1 | sed 's|/package.json$||') && if [ -n "$pkg" ] && grep -qs "This is a placeholder" "$pkg/pnpm"; then (cd "$pkg" && node install.js) && for n in pnpm pn pnpx pnx; do ln -sf "$pkg/$n" "$dir/node_modules/.bin/$n"; done && mise reshim; fi`;
}

/** What each toolchain is asked, once installed, to show that it runs; `<tool> --version` for the rest. */
const VERSION_COMMANDS: Readonly<Record<string, string>> = { go: "go version", rust: "rustc --version", java: "java -version" };

/**
 * A command that fails, saying which tool and how, unless the installed tool runs. An install that exits 0 can still leave
 * a binary that crashes, such as pnpm's placeholder, and the toolchain is then failed instead of reported as installed.
 */
export function verifyTool(tool: string): string {
	const command = VERSION_COMMANDS[tool] ?? `${tool} --version`;
	return `{ ${command} >/dev/null || { echo "${command} failed: the installed ${tool} doesn't run" >&2; exit 1; }; }`;
}

/** What mise calls a tool: pnpm and Yarn 1 are npm packages, and Yarn 2 and later is `@yarnpkg/cli-dist`. */
function miseName(tool: string, version: string): string {
	if (tool === "yarn" && /^[2-9]|^\d{2}/.test(version)) return "npm:@yarnpkg/cli-dist";
	return MISE_NAMES[tool] ?? tool;
}

/** How far a toolchain or a repository's dependencies got. `present`: the image has it, so nothing installs it. `cached`: it came with the snapshot the workspace was restored from. `skipped`: a toolchain it needs couldn't be installed. */
export type ProvisionStatus = "pending" | "installed" | "cached" | "failed" | "skipped" | "present";

export type EnvironmentToolchain = DetectedToolchain & { readonly status: ProvisionStatus; readonly error?: string };
export type EnvironmentDependencies = Omit<DetectedDependencies, "needs"> & { readonly status: ProvisionStatus; readonly error?: string };

/** The id of the step that installs a toolchain or dependencies; null for a toolchain the image has. */
export function stepOf(item: { readonly tool: string; readonly source?: ToolchainSource; readonly command?: string; readonly version?: string | null }): string | null {
	if (item.command !== undefined) return `dependencies:${item.tool}`;
	if (item.source === "mise") return "mise";
	if (item.source === "image" || item.version === null || item.version === undefined) return null;
	return `toolchain:${item.tool}`;
}

/** The profile as a thread's environment shows it before anything ran: every item pending, but what the image has. */
export function pendingItems(profile: RepoProfile): { toolchains: EnvironmentToolchain[]; dependencies: EnvironmentDependencies[] } {
	return {
		toolchains: profile.toolchains.map((each) => ({ ...each, status: stepOf(each) === null ? "present" : "pending" })),
		dependencies: profile.dependencies.map(({ needs: _, ...each }) => ({ ...each, status: "pending" })),
	};
}

/** Whatever a step gets in its environment besides the setup script's: mise answers yes, trusts the checkout's configuration, and uv uses the Python mise installed. */
export const PROVISION_ENV: Readonly<Record<string, string>> = { MISE_YES: "1", MISE_TRUSTED_CONFIG_PATHS: "/workspace", UV_PYTHON_PREFERENCE: "system" };

/** Put before every step, so mise's shims are found even on an image whose PATH lacks them. */
const PATH_PREAMBLE = 'export PATH="$HOME/.local/share/mise/shims:$PATH"\n';

/** How long one step may run. */
export const PROVISION_STEP_TIMEOUT_MS = 10 * 60_000;

/** How a step ended. */
export type StepResult =
	| { readonly outcome: "ok"; readonly ms: number; readonly exitCode: 0; readonly output: string; readonly outputChars: number }
	| { readonly outcome: "failed"; readonly ms: number; readonly exitCode: number | null; readonly output: string; readonly outputChars: number; readonly how: string }
	| { readonly outcome: "stopped" };

/** Runs one step with bash in `cwd`, keeping only the end of what it printed. */
export async function runProvisionStep(workspace: Workspace, step: ProvisionStep, o: { cwd: string; env: Readonly<Record<string, string>>; signal?: AbortSignal; timeoutMs?: number }): Promise<StepResult> {
	const started = performance.now();
	let tail = "";
	let outputChars = 0;
	let exit: Extract<ExecEvent, { type: "exit" }> | null = null;
	const timeoutMs = o.timeoutMs ?? PROVISION_STEP_TIMEOUT_MS;
	try {
		for await (const event of workspace.exec(["bash", "-c", `${PATH_PREAMBLE}${step.script}`], { cwd: o.cwd, timeoutMs, env: { ...o.env, ...PROVISION_ENV }, signal: o.signal })) {
			if (event.type === "exit") exit = event;
			else {
				tail = (tail + event.data).slice(-2048);
				outputChars += event.data.length;
			}
		}
	} catch (error) {
		if (o.signal?.aborted) return { outcome: "stopped" };
		return { outcome: "failed", ms: Math.round(performance.now() - started), exitCode: null, output: String(error), outputChars: String(error).length, how: "couldn't start" };
	}
	const ms = Math.round(performance.now() - started);
	if (exit?.code === 0) return { outcome: "ok", ms, exitCode: 0, output: tail, outputChars };
	if (exit && exit.code === null && !exit.timedOut) return { outcome: "stopped" };
	const how = exit === null ? "ended without an exit" : exit.timedOut ? `ran out of time after ${Math.round(timeoutMs / 60_000)} minutes` : `exited ${exit.code}`;
	return { outcome: "failed", ms, exitCode: exit?.code ?? null, output: tail, outputChars, how };
}

/** A repository's files in a workspace, under `root`. */
export function workspaceFiles(workspace: Workspace, root: string): RepoFiles {
	return {
		list: async (dir) => {
			try {
				return (await workspace.list(dir ? `${root}/${dir}` : root)).map((each) => ({ name: each.name, dir: each.type === "dir", size: each.size }));
			} catch {
				return [];
			}
		},
		read: async (path) => {
			try {
				return new TextDecoder().decode(await workspace.readFile(`${root}/${path}`));
			} catch {
				return null;
			}
		},
	};
}

/** A version as mise takes it, or null for anything that isn't a plain version word. */
function cleanVersion(version: string): string | null {
	const trimmed = version.trim().replace(/^v(?=\d)/, "");
	return VERSION.test(trimmed) ? trimmed : null;
}

/** `.nvmrc`'s version: `lts/*` and `lts/<name>` are mise's `lts`, `node` is `latest`. */
function nodeVersionFile(text: string): string | null {
	const line = text.split(/\r?\n/).map((each) => each.trim()).find((each) => each && !each.startsWith("#"));
	if (!line) return null;
	if (line.startsWith("lts/")) return "lts";
	if (line === "node" || line === "stable" || line === "current") return "latest";
	return line;
}

/**
 * The version to install for a semver range such as `engines.node`: the
 * prefix an exact, caret, tilde or x-range names (`^20.11.0` is `20`,
 * `~20.11` is `20.11`), the last alternative of `||`, and null for open
 * ranges such as `>=18`, which the image's Node meets.
 */
export function nodeRange(range: string): string | null {
	const last = range.split("||").pop()!.trim();
	const exact = /^=?v?(\d+(?:\.\d+){0,2})$/.exec(last);
	if (exact) return exact[1]!;
	const caret = /^\^v?(\d+)(?:\.\d+){0,2}$/.exec(last);
	if (caret) return caret[1]!;
	const tilde = /^~v?(\d+(?:\.\d+)?)(?:\.\d+)?$/.exec(last);
	if (tilde) return tilde[1]!;
	const x = /^v?(\d+)(?:\.(\d+|[x*]))?(?:\.[x*])?$/.exec(last);
	if (x) return x[2] && /\d/.test(x[2]) ? `${x[1]}.${x[2]}` : x[1]!;
	return null;
}

/** The Python to install for `requires-python`: the version an `==` or `~=` names, else the lower bound of `>=`, which meets the range. */
export function pythonRange(range: string): string | null {
	const pinned = /(?:==|~=)\s*(\d+\.\d+)/.exec(range);
	if (pinned) return pinned[1]!;
	const lower = />=\s*(\d+\.\d+)/.exec(range);
	return lower ? lower[1]! : null;
}

/** A tool and version from a Docker image reference such as `golang:1.22-alpine` or, for a dev container's image, `mcr.microsoft.com/devcontainers/go:1-1.22-bookworm`. */
function imageHint(ref: string, devcontainer: boolean): { tool: string; version: string } | null {
	if (ref.includes("$")) return null;
	const [path, tag] = ref.split("@")[0]!.split(/:(?=[^/]*$)/);
	const name = path?.split("/").pop() ?? "";
	const tool = IMAGE_TOOLS[name];
	if (!tool || !tag || tool === "deno" || tool === "bun") return null;
	if (devcontainer) {
		// Dev container images tag their own version first: `1-1.22-bookworm` is image 1 with Go 1.22. Rust's tags name only the image.
		const version = /^\d+-(\d+(?:\.\d+)*)/.exec(tag)?.[1];
		return version && tool !== "rust" ? { tool, version } : null;
	}
	if (/^lts\b/.test(tag) && tool === "node") return { tool, version: "lts" };
	const version = /^(\d+(?:\.\d+){0,2})(?![\w.])/.exec(tag)?.[1];
	return version ? { tool, version } : null;
}

/** `.tool-versions`: a tool and its first version on each line. */
function toolVersions(text: string): [string, string][] {
	const tools: [string, string][] = [];
	for (const line of text.split(/\r?\n/)) {
		const [tool, version] = line.replace(/#.*$/, "").trim().split(/\s+/);
		if (tool && version) tools.push([tool, version]);
	}
	return tools;
}

/** mise.toml's `[tools]`: a tool's version is a string, the first of an array, or an inline table's `version`. */
function miseTools(text: string): [string, string][] {
	const tools: [string, string][] = [];
	for (const [key, raw] of tomlTables(text).get("tools") ?? []) {
		const inline = /^\{.*\bversion\s*=\s*("[^"]*"|'[^']*')/.exec(raw)?.[1];
		const version = tomlString(inline ?? raw);
		// Backends such as `npm:prettier` or `aqua:owner/tool` are mise's to install; they are shown under their own name.
		if (version) tools.push([key, version]);
	}
	return tools;
}

/** The names of mise.toml's tasks that check something: `[tasks.test]`, `[tasks."lint:go"]`, and `test = "..."` under `[tasks]`. */
function miseTaskNames(text: string): string[] {
	const names: string[] = [];
	for (const [table, keys] of tomlTables(text)) {
		if (table === "tasks") names.push(...keys.keys());
		else if (table.startsWith("tasks.")) names.push(unquote(table.slice("tasks.".length)));
	}
	return names.filter((name) => checkName(name) && isCheckName(name));
}

/** Whether a task, target or script name is one that checks: tests, linters and type checks, and not one that fixes or watches. */
function isCheckName(name: string): boolean {
	return /^(test|tests|check|checks|lint|vet|typecheck|type-check|types)([:._-][\w:.-]+)?$/.test(name) && !/[:._-](fix|watch|update|write|dev)$/.test(name);
}

/** A name safe to put in a command without quoting. */
function checkName(name: string): boolean {
	return /^[\w.:-]{1,64}$/.test(name);
}

/** The Makefile's targets that check something, in the order it has them. */
export function makeTargets(text: string): string[] {
	const targets: string[] = [];
	for (const match of text.matchAll(/^([A-Za-z0-9][\w./ -]*?)\s*:(?!:?=)/gm)) {
		for (const target of match[1]!.split(/\s+/)) if (checkName(target) && isCheckName(target) && !targets.includes(target)) targets.push(target);
	}
	return targets;
}

/** Commands in a workflow's `run:` steps that test, lint or check. Install, setup and deploy lines, and lines that use the workflow's expressions, are left out. */
export function workflowCommands(text: string): string[] {
	const lines: string[] = [];
	const source = text.split(/\r?\n/);
	for (let i = 0; i < source.length; i++) {
		const match = /^(\s*(?:-\s+)?)run:\s*(.*?)\s*$/.exec(source[i]!);
		if (!match) continue;
		const keyIndent = match[1]!.length;
		const value = match[2]!;
		if (/^[|>][-+0-9]*(\s+#.*)?$/.test(value)) {
			// A literal block (`|`) is a line per command; a folded one (`>`) is one command.
			const block: string[] = [];
			while (i + 1 < source.length) {
				const line = source[i + 1]!;
				if (line.trim() !== "" && line.length - line.trimStart().length <= keyIndent) break;
				i++;
				if (line.trim() !== "") block.push(line.trim());
			}
			if (value.startsWith(">")) lines.push(block.join(" "));
			else lines.push(...block);
		} else lines.push(unquote(value.replace(/\s+#.*$/, "")));
	}
	const commands: string[] = [];
	let pending = "";
	for (const line of lines) {
		if (line.trimEnd().endsWith("\\")) {
			pending += `${line.trimEnd().slice(0, -1).trim()} `;
			continue;
		}
		const command = `${pending}${line}`.trim();
		pending = "";
		if (!command || command.startsWith("#") || command.includes("${{") || command.length > MAX_COMMAND_CHARS) continue;
		if (/^(sudo\s|apt(-get)?\s|brew\s|echo\s|export\s|cd\s|curl\s|wget\s|docker\s|pip3?\s|python3?\s+-m\s+pip\s|npm\s+(ci|install|i)\b|pnpm\s+(install|i)\b|yarn(\s+install)?$|bun\s+install|go\s+(install|get|mod)\s|cargo\s+install|uv\s+(sync|pip|venv)|rustup\s|mise\s+(install|use)|git\s)/.test(command)) continue;
		if (!/\b(test|tests|lint|vet|check|clippy|pytest|typecheck|type-check|tsc|eslint|biome|ruff|mypy|golangci-lint|staticcheck)\b/.test(command)) continue;
		if (/[\u0000-\u001f]/.test(command)) continue;
		commands.push(command);
	}
	return commands;
}

/** The names of the services a workflow's jobs start, such as `postgres`. */
export function workflowServices(text: string): string[] {
	const names: string[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = /^(\s*)services:\s*$/.exec(lines[i]!);
		if (!match) continue;
		const indent = match[1]!.length;
		let child = -1;
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j]!;
			if (line.trim() === "" || line.trim().startsWith("#")) continue;
			const lead = line.length - line.trimStart().length;
			if (lead <= indent) break;
			if (child < 0) child = lead;
			const key = lead === child ? /^\s*([\w.-]+):/.exec(line)?.[1] : undefined;
			if (key && !names.includes(key)) names.push(key);
		}
	}
	return names;
}

/** A small reading of TOML: each table's keys and their values' text, enough for the keys read here. Multi-line arrays are joined. */
export function tomlTables(text: string): Map<string, Map<string, string>> {
	const tables = new Map<string, Map<string, string>>([["", new Map()]]);
	let current = tables.get("")!;
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = stripTomlComment(lines[i]!).trim();
		if (!line) continue;
		const header = /^\[\[?\s*(.+?)\s*\]\]?$/.exec(line);
		if (header) {
			const name = header[1]!.replace(/\s*\.\s*/g, ".");
			current = tables.get(name) ?? new Map();
			tables.set(name, current);
			continue;
		}
		const pair = /^("[^"]+"|'[^']+'|[\w.:/@-]+)\s*=\s*(.*)$/.exec(line);
		if (!pair) continue;
		let value = pair[2]!;
		while ((value.startsWith("[") || value.startsWith("{")) && depth(value) > 0 && i + 1 < lines.length) value += ` ${stripTomlComment(lines[++i]!).trim()}`;
		current.set(unquote(pair[1]!), value);
	}
	return tables;
}

/** A TOML value's string: a quoted string, or an array's first one. */
function tomlString(raw: string | undefined): string | null {
	if (raw === undefined) return null;
	const match = /^\[?\s*("([^"]*)"|'([^']*)')/.exec(raw.trim());
	return match ? (match[2] ?? match[3] ?? null) : null;
}

function stripTomlComment(line: string): string {
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (quote) {
			if (char === quote) quote = null;
		} else if (char === '"' || char === "'") quote = char;
		else if (char === "#") return line.slice(0, i);
	}
	return line;
}

function depth(value: string): number {
	let open = 0;
	let quote: string | null = null;
	for (const char of value) {
		if (quote) {
			if (char === quote) quote = null;
		} else if (char === '"' || char === "'") quote = char;
		else if (char === "[" || char === "{") open++;
		else if (char === "]" || char === "}") open--;
	}
	return open;
}

function unquote(value: string): string {
	return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

function parseJson(text: string | null): unknown {
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** JSON with comments and trailing commas, as devcontainer.json is written. */
export function parseJsonc(text: string | null): unknown {
	if (text === null) return null;
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		if (inString) {
			out += char;
			if (char === "\\") out += text[++i] ?? "";
			else if (char === '"') inString = false;
		} else if (char === '"') {
			inString = true;
			out += char;
		} else if (char === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (char === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2);
			if (i < 0) break;
			i++;
		} else out += char;
	}
	return parseJson(out.replace(/,(\s*[}\]])/g, "$1"));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function short(text: string, max: number): string {
	const clean = text.replace(/[\u0000-\u001f\u007f]/g, "");
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** What a thread's environment has, for the coding agent's instructions: its toolchains, what couldn't be installed, and the commands the repository checks itself with. Null when nothing was found. */
export function environmentBrief(env: {
	readonly state?: string;
	readonly error?: string;
	readonly reason?: string;
	readonly toolchains: readonly EnvironmentToolchain[];
	readonly dependencies: readonly EnvironmentDependencies[];
	readonly testCommands: readonly TestCommand[];
	readonly notes: readonly string[];
	readonly services?: readonly { readonly name: string; readonly command: string; readonly port: number }[];
}): string | null {
	const lines: string[] = [];
	if (env.state === "failed" && env.error) lines.push(`The environment's setup failed: ${short(env.error, 400)}\nThe workspace is as the checkout and the image left it, so dependencies may be missing. Say so if it blocks you; the person can retry the environment.`);
	if (env.reason) lines.push(`${env.reason}, so the workspace has only what the image brings.`);
	const broken = (each: { status: ProvisionStatus }) => each.status === "failed" || each.status === "skipped";
	const ready = env.toolchains.filter((each) => !broken(each));
	if (ready.length > 0) {
		const names = ready.map((each) => (each.version === null ? `${each.tool} (the workspace's own)` : `${each.tool} ${each.version} (from ${each.from})`));
		lines.push(`Toolchains set up for this repository: ${names.join(", ")}. mise manages them; \`mise use -g <tool>@<version>\` adds another.`);
	}
	const ran = env.dependencies.filter((each) => !broken(each));
	if (ran.length > 0) lines.push(`Dependencies already installed with: ${ran.map((each) => `\`${each.command}\``).join(", ")}.`);
	for (const each of [...env.toolchains, ...env.dependencies].filter(broken)) {
		const what = "command" in each ? `\`${each.command}\`` : `${each.tool}${each.version ? ` ${each.version}` : ""}`;
		const why = each.error ? `: ${short(each.error.split("\n").find((line) => line.trim()) ?? "", 160)}` : "";
		lines.push(`${what} (from ${each.from}) ${each.status === "skipped" ? "wasn't run, since a toolchain it needs is missing" : "failed while the workspace was set up"}${why}.`);
	}
	if (env.testCommands.length > 0) {
		lines.push("Commands the repository checks itself with, found in its files (run the ones that cover your change):");
		for (const each of env.testCommands) lines.push(`- \`${each.command}\` (${each.source === "default" ? `the usual for ${each.from}` : each.from})`);
	}
	if (env.services && env.services.length > 0) {
		lines.push("Services the repository declares in .pim/env.json (not started for you):");
		for (const each of env.services) lines.push(`- ${each.name}: \`${each.command}\` on port ${each.port}`);
	}
	for (const note of env.notes) lines.push(`${note}.`);
	return lines.length > 0 ? lines.join("\n") : null;
}

/** A setup the repository's own configuration describes: the script to run, and the text of what defines it, which the environment's key covers. */
export type ConfiguredSetup = { readonly script: string; readonly source: "mise" | "devcontainer"; readonly content: string };

/** The devcontainer.json lifecycle commands that prepare a checkout, in the order a dev container runs them. */
const DEVCONTAINER_COMMANDS = ["onCreateCommand", "updateContentCommand", "postCreateCommand"] as const;
const DEVCONTAINER_PATHS = [".devcontainer/devcontainer.json", ".devcontainer.json"];

/**
 * The setup a repository's configuration describes when it has no `.pim/setup.sh`: a mise task named `setup` in
 * `mise.toml` or `.mise.toml`, run with `mise run setup`; else the dev container's lifecycle commands. Only the first
 * found is returned. Throws when a devcontainer's commands add up to more than `MAX_SETUP_SCRIPT_BYTES`.
 */
export async function detectConfiguredSetup(files: RepoFiles): Promise<ConfiguredSetup | null> {
	const read = (path: string) => files.read(path).catch(() => null);
	for (const name of ["mise.toml", ".mise.toml"]) {
		const text = await read(name);
		if (text !== null && text.length <= MAX_FILE_BYTES && hasMiseTask(text, "setup")) return { script: "mise trust --yes --quiet && mise run setup", source: "mise", content: `${name}\n${text}` };
	}
	for (const path of DEVCONTAINER_PATHS) {
		const text = await read(path);
		if (text === null || text.length > MAX_FILE_BYTES) continue;
		const script = devcontainerSetupScript(parseJsonc(text));
		if (script === null) continue;
		if (script.length > MAX_SETUP_SCRIPT_BYTES) throw new Error(`The lifecycle commands in ${path} are larger than ${MAX_SETUP_SCRIPT_BYTES / 1024} KiB`);
		return { script, source: "devcontainer", content: script };
	}
	return null;
}

/** Whether mise's configuration defines a task: `[tasks.name]`, `[tasks."name"]`, `name = ...` under `[tasks]`, or `tasks.name = ...`. */
export function hasMiseTask(text: string, name: string): boolean {
	for (const [table, keys] of tomlTables(text)) {
		if (table === "tasks" && keys.has(name)) return true;
		if (table === `tasks.${name}` || table === `tasks."${name}"` || table === `tasks.'${name}'`) return true;
		if (table === "" && keys.has(`tasks.${name}`)) return true;
	}
	return false;
}

/**
 * A bash script for a devcontainer.json's `onCreateCommand`, `updateContentCommand` and `postCreateCommand`, in that
 * order; null when it has none. A command is a string (run by a shell), an array (one program and its arguments, run
 * without a shell) or an object of either, whose entries a dev container runs in parallel and this runs one after another.
 * Each runs in a subshell in the repository's directory, and the script stops at the first that fails.
 */
export function devcontainerSetupScript(devcontainer: unknown): string | null {
	if (!isObject(devcontainer)) return null;
	const commands: string[] = [];
	const one = (value: unknown) => {
		if (typeof value === "string" && value.trim()) commands.push(`(\n${value.trim()}\n)`);
		else if (Array.isArray(value) && value.length > 0 && value.every((each) => typeof each === "string")) commands.push(value.map(shellQuote).join(" "));
	};
	for (const key of DEVCONTAINER_COMMANDS) {
		const value = devcontainer[key];
		if (isObject(value)) for (const each of Object.values(value)) one(each);
		else one(value);
	}
	return commands.length > 0 ? `set -e\n${commands.join("\n")}\n` : null;
}

function shellQuote(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** How long a snapshot of an unpinned toolchain is trusted when its concrete version can't be resolved: the key changes every week. */
export const UNPINNED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether a toolchain's version names a moving target: `lts`, `stable`, `latest` and the like. */
export function isUnpinned(version: string | null): boolean {
	return version !== null && /^(lts|stable|latest|current|nightly|beta|x|\*)$/i.test(version);
}

/**
 * What an environment's key takes from the toolchains that aren't pinned to a version, so a snapshot of `lts` or
 * `latest` doesn't outlive the release it was built with: each one's concrete version as mise resolves it in the
 * workspace (`mise latest node@lts`), or, when that can't be resolved, the number of the `UNPINNED_TTL_MS` period `now`
 * falls in. Sorted; empty when every toolchain is pinned.
 */
export async function unpinnedKeyParts(workspace: Workspace, toolchains: readonly DetectedToolchain[], now: number, cwd: string): Promise<string[]> {
	const parts = new Set<string>();
	for (const each of toolchains) {
		if (!isUnpinned(each.version)) continue;
		const resolved = await resolveVersion(workspace, `${miseName(each.tool, each.version!)}@${each.version}`, cwd);
		parts.add(`${each.tool}@${each.version}=${resolved ?? `ttl:${Math.floor(now / UNPINNED_TTL_MS)}`}`);
	}
	return [...parts].sort();
}

/** The version `mise latest <spec>` prints; null when mise can't tell. */
async function resolveVersion(workspace: Workspace, spec: string, cwd: string): Promise<string | null> {
	let out = "";
	let code: number | null = null;
	try {
		for await (const event of workspace.exec(["bash", "-c", `${PATH_PREAMBLE}mise latest "$0"`, spec], { cwd, timeoutMs: 60_000, env: PROVISION_ENV })) {
			if (event.type === "stdout") out += event.data;
			else if (event.type === "exit") code = event.code;
		}
	} catch {
		return null;
	}
	const version = out.trim();
	return code === 0 && /^\d[\w.+-]{0,63}$/.test(version) ? version : null;
}
