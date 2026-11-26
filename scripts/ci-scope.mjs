#!/usr/bin/env node
// Which parts of Pim a change reaches, so CI, the image builds and the smoke test run only what it can affect (docs/v2-operations.md, "What CI runs").
//
// The unit is a component: each workspace package under packages/, and each top-level directory that holds code (web, web-host, computer, displayd, sandbox-manager,
// workspace-agentd, deploy, scripts, docs, config). The graph between them is read from the code, not written down: `workspace:` dependencies in package.json, and every
// import, `new URL(...)` and path literal in a source file that is written relative to it and leads into another component; `DECLARED_INPUTS` adds the few reads that are not
// written that way (a test that reads a manifest). A change reaches its component and everything that depends on it, transitively, so a shared package fans out to its dependents
// and a change to the web app reaches none of the backend. Anything not understood is the whole of Pim, never nothing: a file outside every known component, the toolchain
// (the root package.json, the lockfile, the workspace file, Node's version, the TypeScript and test configuration, patches), the workflows themselves, a diff that cannot be
// made (no base commit, a rewritten history) and a manual run.
//
//   node scripts/ci-scope.mjs --event pull_request --base <sha> --head <sha>      prints the scope as JSON; with $GITHUB_OUTPUT set, also writes `scope=<json>`
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Top-level directories that are components, by what they hold. Anything else at the top level is unknown. */
const TOP_LEVEL = ["web", "web-host", "computer", "displayd", "sandbox-manager", "workspace-agentd", "deploy", "scripts", "docs", "config"];

/** Directories no job reads: tooling for the orb, not Pim. */
const IGNORED_TOP_LEVEL = [".agents", ".amp", ".pim"];

/** Files at the root that change what everything is built, installed or checked with. */
const TOOLCHAIN = [/^package\.json$/, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/, /^\.nvmrc$/, /^tsconfig[^/]*\.json$/, /^vitest[^/]*\.config\.[^/]+$/, /^workerd-runtime\.d\.ts$/, /^\.dockerignore$/, /^\.gitignore$/, /^patches\//, /^\.github\//, /^scripts\/(ci-|image-)[^/]+$/, /^deploy\/IMAGE_EPOCH$/];

/** What is only to be read: no job's result depends on it. */
const PROSE = [/^README\.md$/, /^LICENSE$/, /^AGENTS\.md$/, /^docs\/(?!architecture\/).+/, /\.md$/];

/**
 * Reads that no import shows. `from` is a component; its entries are repository paths (a directory or a file) whose change can change its results. The guard test
 * (scripts/ci-scope.test.ts) fails when a test of a package names a path of the repository that is neither imported nor declared here.
 */
export const DECLARED_INPUTS = {
	// The deployment checks read the Compose and Kubernetes files, the Caddyfile and the Dockerfiles (all of deploy/), and the development preview.
	"packages/v2-ops": ["deploy", "scripts/v2-dev/preview.mjs"],
};

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP = new Set(["node_modules", "dist", ".wrangler", ".git", "coverage"]);

function walk(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...walk(path));
		else found.push(path);
	}
	return found;
}

/** The component a repository-relative path belongs to: `packages/<name>`, a top-level directory, "root" for a file there, or null for what no component owns. */
export function componentOf(path) {
	const parts = path.split("/");
	if (parts.length === 1) return TOP_LEVEL.includes(path) ? path : "root";
	if (parts[0] === "packages") return parts.length > 2 ? `packages/${parts[1]}` : null;
	if (TOP_LEVEL.includes(parts[0])) return parts[0];
	return null;
}

const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;,{(])\/\/.*$/gm, "$1");

/** Whether a path is `base` or inside it. */
const inside = (path, base) => path === base || path.startsWith(`${base}/`);

/**
 * The graph of the repository at `root`: every component, and the reads that tie one to another. A read is a path that can change what a component's code or tests do. Reading
 * another component's code (a package, an import, a path that names a script) is reading all of it; reading a data file (a manifest, a document) is reading that path only.
 */
export function buildGraph(root = ROOT) {
	const components = new Set(TOP_LEVEL);
	const names = new Map();
	for (const entry of existsSync(join(root, "packages")) ? readdirSync(join(root, "packages"), { withFileTypes: true }) : []) {
		if (!entry.isDirectory() || !existsSync(join(root, "packages", entry.name, "package.json"))) continue;
		components.add(`packages/${entry.name}`);
		names.set(JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")).name, `packages/${entry.name}`);
	}
	const reads = [];
	const seen = new Set();
	const read = (from, path) => {
		const key = `${from}\0${path}`;
		if (!seen.has(key) && !inside(path, from)) {
			seen.add(key);
			reads.push({ from, path });
		}
	};

	for (const component of components) {
		const dir = join(root, component);
		if (!existsSync(dir)) continue;
		// Declared dependencies, as the package manager installs them.
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const json = JSON.parse(readFileSync(manifest, "utf8"));
			for (const name of Object.keys({ ...json.dependencies, ...json.devDependencies })) if (names.has(name)) read(component, names.get(name));
		}
		for (const file of walk(dir).filter((f) => SOURCE.test(f))) {
			const source = withoutComments(readFileSync(file, "utf8"));
			// A workspace package named in an import.
			for (const [, name] of source.matchAll(/["'`](@pim\/[a-z0-9-]+)(?:\/[^"'`]*)?["'`]/g)) if (names.has(name)) read(component, names.get(name));
			// A path written relative to the file (an import, a `new URL`, a join): wherever it leads out of the component.
			for (const [, literal] of source.matchAll(/["'`](\.{1,2}\/[^"'`\s$]*)["'`]/g)) {
				const target = relative(root, resolve(dirname(file), literal)).split(sep).join("/").replace(/\/$/, "");
				if (target === "" || target.startsWith("..") || target.includes("node_modules")) continue;
				const owner = componentOf(target);
				if (!owner || owner === "root" || owner === component || !components.has(owner)) continue;
				// Code is read whole (what it imports is part of it); anything else, as the path names it.
				read(component, SOURCE.test(target) ? owner : target);
			}
		}
	}
	for (const [from, paths] of Object.entries(DECLARED_INPUTS)) for (const path of paths) read(from, path);
	return { components: [...components].sort(), reads };
}

/** What `component` reads, as paths. */
export const readsOf = (graph, component) => graph.reads.filter((r) => r.from === component).map((r) => r.path).sort();

/** The components that hold code. The rest (deploy, docs, config) hold data that code reads: a change to it re-tests its readers, and goes no further. */
const CODE = (component) => component === "scripts" || component === "web" || component === "web-host" || component === "computer" || component === "displayd" || component === "sandbox-manager" || component === "workspace-agentd" || component.startsWith("packages/");

/**
 * The components a set of changed files reaches. A changed file reaches the component that holds it (unless it is prose no code is part of) and every component that reads a path
 * containing it. When the code of a component changed, every component that reads all of it is reached too, and so on: a shared package reaches its dependents, and a web app that
 * nothing reads reaches nothing else. A component reached only because it reads a changed *data* file (a manifest, a document, a Compose file) has its own tests to run, but its code
 * did not change, so what imports that code is not reached.
 */
export function reach(graph, files) {
	const reached = new Set();
	const changed = new Set();
	const queue = [];
	const touch = (component) => component && component !== "root" && reached.add(component);
	const code = (component) => touch(component) && !changed.has(component) && (changed.add(component), queue.push(component));
	for (const file of files) {
		const prose = PROSE.some((p) => p.test(file)) || IGNORED_TOP_LEVEL.includes(file.split("/")[0]);
		const owner = componentOf(file);
		if (!prose && owner) (CODE(owner) ? code(owner) : touch(owner));
		for (const { from, path } of graph.reads) if (inside(file, path)) (graph.components.includes(path) && CODE(path) ? code(from) : touch(from));
	}
	while (queue.length) {
		const component = queue.shift();
		for (const { from, path } of graph.reads) if (path === component) code(from);
	}
	return reached;
}

/** The Dockerfiles, and the images each builds. */
export const IMAGES = { backend: "deploy/Dockerfile.v2", web: "deploy/Dockerfile.web", computer: "deploy/Dockerfile.computer" };

/** The paths a Dockerfile copies into its image (not from another stage), relative to the repository: what its build can read. */
export function copySources(dockerfile, root = ROOT) {
	const lines = readFileSync(join(root, dockerfile), "utf8").replace(/\\\n/g, " ").split("\n");
	const sources = [];
	for (const line of lines) {
		const match = /^\s*(?:COPY|ADD)\s+(.*)$/i.exec(line);
		if (!match) continue;
		const words = match[1].trim().split(/\s+/);
		if (words.some((w) => w.startsWith("--from="))) continue;
		const args = words.filter((w) => !w.startsWith("--"));
		for (const source of args.slice(0, -1)) sources.push(source.replace(/^\.\//, "").replace(/\/$/, ""));
	}
	return [...new Set(sources)];
}

/**
 * What a set of changed files reaches. `files` is every path the change touched, old names of renames and deleted files included (or null when no diff could be made).
 * Returns booleans and lists for the workflows, `full` and why, and the components reached.
 */
export function selectScope(files, graph = buildGraph(), options = {}) {
	const root = options.root ?? ROOT;
	const scopeOf = ({ full, reason, changed, reached }) => {
		const packages = [...reached].filter((c) => c.startsWith("packages/")).map((c) => c.slice("packages/".length)).sort();
		const has = (c) => full || reached.has(c);
		const direct = (c) => full || changed.some((f) => componentOf(f) === c);
		// An image is rebuilt when a file its Dockerfile copies, or the Dockerfile, changed: what its build can read, not what the repository's graph says.
		const image = (name) => full || changed.some((f) => f === IMAGES[name] || f === ".dockerignore" || copySources(IMAGES[name], root).some((source) => source === "." || inside(f, source)));
		const images = Object.fromEntries(Object.keys(IMAGES).map((name) => [name, image(name)]));
		const proseOnly = !full && changed.every((f) => PROSE.some((p) => p.test(f)) || IGNORED_TOP_LEVEL.includes(f.split("/")[0]));
		const checks = {
			typecheck: { root: full || has("computer") || direct("scripts"), packages: full ? graph.components.filter((c) => c.startsWith("packages/")).map((c) => c.slice(9)) : packages, web: has("web") },
			packages: { rest: packages.filter((p) => p !== "v2-server"), v2Server: packages.includes("v2-server") },
			daemons: ["displayd", "sandbox-manager", "workspace-agentd", "web-host"].filter((d) => has(d)),
		};
		return {
			full,
			reason,
			components: [...reached].sort(),
			// The CI jobs, by name: which run. The workflow's `if` and the aggregate check both read this one table.
			jobs: {
				lint: true,
				"lint-web": has("web"),
				typecheck: checks.typecheck.root || checks.typecheck.packages.length > 0 || checks.typecheck.web,
				web: has("web"),
				"web-build": has("web") || has("web-host"),
				daemons: checks.daemons.length > 0,
				node: has("computer") || !proseOnly || reached.has("scripts"),
				desktop: has("computer") || has("displayd"),
				packages: checks.packages.rest.length > 0,
				"v2-server": checks.packages.v2Server,
				"image-backend": images.backend,
				"image-web": images.web,
				"image-computer": images.computer,
			},
			// What each job runs. Biome covers the web app only; the root's TypeScript project is the computer's and the scripts'.
			typecheck: checks.typecheck,
			daemons: checks.daemons,
			packages: checks.packages,
			// The root's Node project: the computer's tests when the computer is reached, and the repository's own scripts' tests (the import rules, the coverage matrix) for anything but prose.
			node: { computer: has("computer"), scripts: !proseOnly || reached.has("scripts") },
			desktop: has("computer") || has("displayd"),
			images,
			// The smoke test boots the whole stack from the two images and the Compose files.
			smoke: full || images.backend || images.web || changed.some((f) => inside(f, "deploy/compose") || inside(f, "scripts/v2-compose") || inside(f, "scripts/v2-backup")),
		};
	};
	const everything = (reason) => {
		const reached = new Set(graph.components);
		return scopeOf({ full: true, reason, changed: files ?? [], reached });
	};

	if (files === null) return everything("no diff could be made");
	for (const file of files) {
		if (TOOLCHAIN.some((p) => p.test(file))) return everything(`${file} changes what everything is built or checked with`);
		const prose = PROSE.some((p) => p.test(file)) || IGNORED_TOP_LEVEL.includes(file.split("/")[0]);
		if (!prose && (componentOf(file) === null || componentOf(file) === "root")) return everything(`${file} is in no known component`);
	}
	return scopeOf({ full: false, reason: files.length ? "dependency graph" : "no files changed", changed: files, reached: reach(graph, files) });
}

const ZEROS = /^0+$/;

function git(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * The files a change touched, or null when they cannot be known (the caller then takes everything). A pull request is its merge base with its base branch up to its head, so what
 * the base gained since is not counted; a push is the range the push made; any other event has no range. Deleted files and both names of a rename are listed.
 */
export function changedFiles({ event, base, head }, cwd = ROOT) {
	if (!["pull_request", "push"].includes(event) || !base || !head || ZEROS.test(base)) return null;
	try {
		git(["cat-file", "-e", `${base}^{commit}`], cwd);
		git(["cat-file", "-e", `${head}^{commit}`], cwd);
		const from = event === "pull_request" ? git(["merge-base", base, head], cwd).trim() : base;
		return git(["diff", "--name-only", "--no-renames", "-z", from, head], cwd).split("\0").filter(Boolean);
	} catch {
		return null;
	}
}

function main() {
	const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []));
	const event = args.event ?? process.env.GITHUB_EVENT_NAME;
	const files = changedFiles({ event, base: args.base, head: args.head });
	const scope = selectScope(files);
	const json = JSON.stringify(scope);
	console.log(JSON.stringify(scope, null, 2));
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${json}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
