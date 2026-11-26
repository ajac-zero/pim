// What CI, the image builds and the smoke test run for a change (scripts/ci-scope.mjs, ci-aggregate.mjs, image-identity.mjs): the selection against the repository's real
// dependency graph, the diff each kind of event makes (merge base, push range, renames, deletions, a missing base), the aggregate check's verdicts, and what an image's
// identity does and does not depend on.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: plain JavaScript modules
import { aggregate } from "./ci-aggregate.mjs";
// @ts-expect-error: plain JavaScript modules
import { buildGraph, changedFiles, copySources, IMAGES, reach, readsOf, selectScope } from "./ci-scope.mjs";
// @ts-expect-error: plain JavaScript modules
import { identity, plan } from "./image-identity.mjs";

const root = path.resolve(__dirname, "..");
const graph = buildGraph(root);
const scope = (...files: string[]) => selectScope(files, graph, { root });
const jobs = (s: ReturnType<typeof scope>) => Object.entries(s.jobs as Record<string, boolean>).filter(([, on]) => on).map(([name]) => name).sort();
const ALL_JOBS = ["daemons", "desktop", "image-backend", "image-computer", "image-web", "lint", "lint-web", "node", "packages", "registry", "typecheck", "v2-server", "web", "web-build"];

describe("what a change reaches", () => {
	it("runs only the web app's jobs, and publishes only its image, for a change to the interface", () => {
		const s = scope("web/src/components/chat/thread.tsx");
		expect(s.full).toBe(false);
		expect(jobs(s)).toEqual(["image-web", "lint", "lint-web", "node", "typecheck", "web", "web-build"]);
		expect(s.typecheck).toEqual({ root: false, packages: [], web: true });
		// Nothing of the backend: not its packages, not its integration tests, not its image, and nothing of the computer or the daemons.
		expect(s.packages).toEqual({ rest: [], v2Server: false });
		expect(s.images).toEqual({ backend: false, web: true, computer: false });
		expect(s.daemons).toEqual([]);
		expect(s.components).toEqual(["web"]);
		// The stack's smoke test still needs the new image.
		expect(s.smoke).toBe(true);
	});

	it("runs the affected backend packages and their dependents, and builds only the backend image, for a change to a package", () => {
		const s = scope("packages/v2-app/src/apps.ts");
		expect(s.full).toBe(false);
		expect(s.packages).toEqual({ rest: ["v2-app"], v2Server: true });
		expect(s.typecheck.packages).toEqual(["v2-app", "v2-server"]);
		expect(jobs(s)).toEqual(["image-backend", "lint", "node", "packages", "typecheck", "v2-server"]);
		// The web app, its jobs and its image are untouched.
		expect(s.jobs.web).toBe(false);
		expect(s.jobs["web-build"]).toBe(false);
		expect(s.images).toEqual({ backend: true, web: false, computer: false });
		// A leaf package of the backend has no dependents but the server.
		expect(scope("packages/v2-runtime/src/storage.ts").packages).toEqual({ rest: ["v2-runtime"], v2Server: true });
		expect(scope("packages/v2-runtime/src/storage.ts").components).not.toContain("packages/v2-live");
	});

	it("fans a shared package out to everything that depends on it, the web app included", () => {
		const s = scope("packages/shared/src/live-client.ts");
		expect(s.full).toBe(false);
		for (const component of ["web", "packages/coding", "packages/triggers", "packages/v2-live", "packages/v2-forge", "packages/v2-app", "packages/v2-server", "computer"]) expect(s.components).toContain(component);
		expect(s.components).not.toContain("packages/v2-runtime");
		expect(s.components).not.toContain("web-host");
		expect(s.jobs.web).toBe(true);
		expect(s.jobs["v2-server"]).toBe(true);
		expect(s.images).toEqual({ backend: true, web: true, computer: false });
		// A package only the backend uses does not reach the web app, and one only the web app uses (the block language) reaches the server that renders it.
		expect(scope("packages/v2-live/src/server/hub.ts").jobs.web).toBe(false);
		const ui = scope("packages/ui-lang/src/index.ts");
		expect(ui.jobs.web).toBe(true);
		expect(ui.packages.v2Server).toBe(true);
	});

	it("selects the computer's jobs and the desktop test for the computer and displayd, and the daemons for their own", () => {
		const s = scope("computer/pim-computer.ts");
		expect(s.node.computer).toBe(true);
		expect(s.jobs.desktop).toBe(true);
		expect(s.typecheck.root).toBe(true);
		// The server serves the computer's files and bundles displayd, so its integration tests run; the web app does not.
		expect(s.packages.v2Server).toBe(true);
		expect(s.jobs.web).toBe(false);
		expect(s.images).toEqual({ backend: true, web: false, computer: true });
		expect(scope("sandbox-manager/src/manager.js").daemons).toEqual(["sandbox-manager"]);
		expect(scope("web-host/src/assets.js").daemons).toEqual(["web-host"]);
		expect(scope("web-host/src/assets.js").images).toEqual({ backend: false, web: true, computer: false });
		expect(scope("displayd/src/main.js").packages.v2Server).toBe(true);
	});

	it("reads data files by the path, not the directory: a document reaches what reads it, and no other", () => {
		expect(readsOf(graph, "packages/ui-lang")).toContain("docs/reference.md");
		expect(scope("docs/reference.md").components).toContain("packages/ui-lang");
		// Its tests re-run, but its code did not change, so what imports it is not reached.
		expect(scope("docs/reference.md").jobs.web).toBe(false);
		expect(scope("docs/reference.md").packages).toEqual({ rest: ["ui-lang"], v2Server: false });
		// Prose nothing reads selects nothing but the aggregate.
		const docs = scope("docs/apps.md", "README.md");
		expect(jobs(docs)).toEqual(["lint"]);
		expect(docs.images).toEqual({ backend: false, web: false, computer: false });
		expect(docs.smoke).toBe(false);
		// The architecture notes are read by the coverage matrix's test, which is the scripts' own.
		expect(scope("docs/architecture/inventory/B1-identity-sharing-public-surface.md").node.scripts).toBe(true);
		// The deployment files reach the deployment checks, and the smoke test, and no image.
		const deploy = scope("deploy/compose/compose.yaml");
		expect(deploy.packages).toEqual({ rest: ["v2-ops"], v2Server: false });
		expect(deploy.smoke).toBe(true);
		expect(deploy.images).toEqual({ backend: false, web: false, computer: false });
	});

	it("takes everything for a change to the toolchain, the workflows, a file nothing owns, or a diff that was not made", () => {
		for (const [file, why] of [["pnpm-lock.yaml", /pnpm-lock/], [".github/workflows/ci.yml", /workflows/], [".github/actions/setup/action.yml", /actions/], ["package.json", /package\.json/], [".nvmrc", /nvmrc/], ["patches/agents@0.27.0.patch", /patches/], ["tsconfig.json", /tsconfig/], ["scripts/ci-scope.mjs", /ci-scope/], ["deploy/IMAGE_EPOCH", /IMAGE_EPOCH/], ["somewhere/new/file.ts", /no known component/], ["packages/new-thing", /no known component/]] as const) {
			const s = scope(file);
			expect(s.full, file).toBe(true);
			expect(s.reason, file).toMatch(why);
			expect(jobs(s), file).toEqual(ALL_JOBS);
			expect(s.images, file).toEqual({ backend: true, web: true, computer: true });
			expect(s.smoke, file).toBe(true);
		}
		const none = selectScope(null, graph, { root });
		expect(none.full).toBe(true);
		expect(none.reason).toMatch(/no diff/);
		// A package's own manifest is that package and its dependents, not everything.
		const manifest = scope("packages/v2-live/package.json");
		expect(manifest.full).toBe(false);
		expect(manifest.components).toContain("packages/v2-server");
		expect(manifest.jobs.web).toBe(false);
		// Nothing changed is nothing selected.
		expect(jobs(selectScope([], graph, { root }))).toEqual(["lint"]);
	});

	it("counts a deleted file and both names of a renamed one", () => {
		// The diff lists the old path of a rename and of a deletion; the old path is in the old component.
		const moved = scope("web/src/old-name.tsx", "packages/v2-app/src/new-name.ts");
		expect(moved.components).toEqual(expect.arrayContaining(["web", "packages/v2-app", "packages/v2-server"]));
		expect(moved.images).toEqual({ backend: true, web: true, computer: false });
		const deleted = scope("packages/v2-forge/src/removed.ts");
		expect(deleted.packages.rest).toEqual(["v2-forge"]);
	});

	it("keeps the web app and the backend apart in the graph and in what each image copies", () => {
		// What the web app reads: its two packages, and nothing of the backend.
		expect(readsOf(graph, "web")).toEqual(["packages/shared", "packages/ui-lang"]);
		for (const backend of ["packages/v2-app", "packages/v2-server", "packages/v2-live", "packages/v2-forge", "packages/v2-runtime", "packages/v2-ops", "computer"]) expect(readsOf(graph, backend)).not.toContain("web");
		const web = copySources(IMAGES.web, root);
		expect(web).toEqual(expect.arrayContaining(["web", "web-host/src", "packages/shared", "packages/ui-lang"]));
		for (const other of ["packages", "packages/v2-server", "packages/v2-app", "computer", "displayd"]) expect(web).not.toContain(other);
		const backend = copySources(IMAGES.backend, root);
		expect(backend).toEqual(expect.arrayContaining(["packages", "computer", "displayd/src"]));
		for (const ui of ["web", "web-host", "web-host/src"]) expect(backend).not.toContain(ui);
		expect(copySources(IMAGES.computer, root)).not.toContain("web");
	});

	it("knows every path a package's tests read: a read the graph does not show is declared", () => {
		const names = ["deploy", "scripts", "docs", "web-host", "computer", "displayd", "web", "sandbox-manager", "workspace-agentd", "config"];
		const pattern = new RegExp(`["'\`]((?:${names.join("|")})/[A-Za-z0-9_./@-]*)`, "g");
		const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" ? [] : e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
		const unreached: string[] = [];
		for (const pkg of readdirSync(path.join(root, "packages"))) {
			for (const file of files(path.join(root, "packages", pkg, "test")).filter((f) => /\.ts$/.test(f))) {
				const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;,{(])\/\/.*$/gm, "$1");
				for (const [, target] of source.matchAll(pattern)) {
					const clean = target!.replace(/\/$/, "");
					// A named path that is a file or directory of the repository, read by this package's tests: changing it must reach the package.
					if (!reach(graph, [clean]).has(`packages/${pkg}`)) unreached.push(`packages/${pkg}: ${clean}`);
				}
			}
		}
		expect([...new Set(unreached)]).toEqual([]);
	});
});

/** A repository to diff: `main` with a first commit, and helpers to commit files. */
function repo() {
	const dir = mkdtempSync(path.join(tmpdir(), "pim-scope-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();
	git("init", "-q", "-b", "main");
	const write = (file: string, text: string) => (mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }), writeFileSync(path.join(dir, file), text));
	const commit = (message: string) => (git("add", "-A"), git("commit", "-q", "-m", message), git("rev-parse", "HEAD"));
	return { dir, git, write, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("the files a change touched", () => {
	it("is a pull request's merge base up to its head, so what the base gained since is not the change", () => {
		const r = repo();
		try {
			r.write("web/a.ts", "1");
			r.write("packages/x/a.ts", "1");
			const start = r.commit("start");
			r.git("checkout", "-q", "-b", "topic");
			r.write("web/a.ts", "2");
			const head = r.commit("ui");
			r.git("checkout", "-q", "main");
			r.write("packages/x/a.ts", "2");
			const base = r.commit("backend lands on main meanwhile");
			expect(changedFiles({ event: "pull_request", base, head }, r.dir)).toEqual(["web/a.ts"]);
			// A push is the range it made: the two moves together.
			expect(changedFiles({ event: "push", base: start, head: base }, r.dir)).toEqual(["packages/x/a.ts"]);
		} finally {
			r.cleanup();
		}
	});

	it("lists a deleted file, and a renamed file by both of its names", () => {
		const r = repo();
		try {
			r.write("web/old.ts", "same content\n".repeat(20));
			r.write("packages/x/gone.ts", "x");
			const before = r.commit("start");
			r.git("mv", "web/old.ts", "packages/x/new.ts");
			r.git("rm", "-q", "packages/x/gone.ts");
			const after = r.commit("move and delete");
			expect(changedFiles({ event: "push", base: before, head: after }, r.dir)?.sort()).toEqual(["packages/x/gone.ts", "packages/x/new.ts", "web/old.ts"]);
		} finally {
			r.cleanup();
		}
	});

	it("is nothing known, and so everything, when the base is missing, zero, unreachable or the event has no range", () => {
		const r = repo();
		try {
			r.write("web/a.ts", "1");
			const head = r.commit("start");
			const missing = "1234567890123456789012345678901234567890";
			expect(changedFiles({ event: "push", base: missing, head }, r.dir)).toBeNull();
			expect(changedFiles({ event: "push", base: "0".repeat(40), head }, r.dir)).toBeNull();
			expect(changedFiles({ event: "pull_request", base: missing, head }, r.dir)).toBeNull();
			expect(changedFiles({ event: "push", base: undefined, head }, r.dir)).toBeNull();
			expect(changedFiles({ event: "workflow_dispatch", base: head, head }, r.dir)).toBeNull();
			expect(changedFiles({ event: "schedule", base: head, head }, r.dir)).toBeNull();
			// And that takes every job.
			expect(selectScope(changedFiles({ event: "push", base: missing, head }, r.dir), graph, { root }).full).toBe(true);
			// An empty range is a real answer: nothing changed.
			expect(changedFiles({ event: "push", base: head, head }, r.dir)).toEqual([]);
		} finally {
			r.cleanup();
		}
	});
});

describe("the aggregate check", () => {
	const needs = (results: Record<string, string>, selected: Record<string, boolean>) => ({
		changes: { result: "success", outputs: { scope: JSON.stringify({ jobs: selected }) } },
		...Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result }])),
	});
	const uiOnly = { lint: true, web: true, "web-build": true, "v2-server": false, packages: false };

	it("passes when every selected job succeeded and the rest were skipped", () => {
		const verdict = aggregate(needs({ lint: "success", web: "success", "web-build": "success", "v2-server": "skipped", packages: "skipped" }, uiOnly));
		expect(verdict.ok).toBe(true);
		expect(verdict.selected).toEqual(["lint", "web", "web-build"]);
		expect(verdict.skipped).toEqual(["v2-server", "packages"]);
	});

	it("fails when a selected job failed or was cancelled, even if the others passed", () => {
		expect(aggregate(needs({ lint: "success", web: "failure", "web-build": "success", "v2-server": "skipped", packages: "skipped" }, uiOnly))).toMatchObject({ ok: false, problems: ["web failure"] });
		expect(aggregate(needs({ lint: "success", web: "success", "web-build": "cancelled", "v2-server": "skipped", packages: "skipped" }, uiOnly)).ok).toBe(false);
		// A job nobody selected that failed anyway is a failure too.
		expect(aggregate(needs({ lint: "success", web: "success", "web-build": "success", "v2-server": "failure", packages: "skipped" }, uiOnly)).problems).toEqual(["v2-server failure"]);
	});

	it("fails a selected job that was skipped, so a broken condition or a failed dependency cannot pass", () => {
		const verdict = aggregate(needs({ lint: "success", web: "skipped", "web-build": "success", "v2-server": "skipped", packages: "skipped" }, uiOnly));
		expect(verdict).toMatchObject({ ok: false, problems: ["web was selected but skipped"] });
	});

	it("fails when the selection itself failed or said nothing, and for a job the table does not know", () => {
		expect(aggregate({ changes: { result: "failure", outputs: {} }, lint: { result: "skipped" } }).ok).toBe(false);
		expect(aggregate({ changes: { result: "success", outputs: { scope: "not json" } }, lint: { result: "success" } }).ok).toBe(false);
		expect(aggregate({ lint: { result: "success" } }).ok).toBe(false);
		expect(aggregate(needs({ lint: "success", mystery: "success" }, { lint: true })).problems).toEqual(["mystery is not in the scope's table of jobs"]);
	});

	it("agrees with the selection: the aggregate waits for exactly the jobs the table names", () => {
		const table = Object.keys(scope("web/src/main.tsx").jobs).filter((job) => job !== "lint-web");
		const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
		const waits = /\n  ci:\n[\s\S]*?needs: \[([^\]]+)\]/.exec(workflow)![1]!.split(",").map((j) => j.trim()).filter((j) => j !== "changes");
		expect(waits.sort()).toEqual(table.sort());
		// Every job reads its condition from the same table, and the table is the only place that says what runs.
		for (const job of table) expect(workflow, job).toContain(`needs.changes.outputs.scope).jobs.${job}`);
	});
});

describe("an image's identity", () => {
	function project() {
		const r = repo();
		r.write("Dockerfile", "FROM scratch\nCOPY app ./app\nCOPY lib/package.json ./lib/\nCOPY --from=other /x /y\n");
		r.write("app/main.js", "1");
		r.write("app/main.test.js", "t1");
		r.write("lib/package.json", "{}");
		r.write("lib/other.js", "o");
		r.write("unrelated/file.txt", "u");
		r.write(".dockerignore", "**/*.test.js\n");
		r.write("deploy/IMAGE_EPOCH", "1\n");
		r.commit("start");
		return r;
	}
	const id = (r: ReturnType<typeof repo>) => identity({ root: r.dir, dockerfile: "Dockerfile" }) as string;

	it("changes with a file the Dockerfile copies, its own text and the epoch, and with nothing else", () => {
		const r = project();
		try {
			const first = id(r);
			expect(first).toMatch(/^[0-9a-f]{16}$/);
			// What it does not copy, what .dockerignore leaves out and a stage it copies from: the same image.
			r.write("unrelated/file.txt", "changed");
			r.write("app/main.test.js", "t2");
			r.write("lib/other.js", "changed");
			r.commit("unrelated");
			expect(id(r)).toBe(first);
			// A copied file, a file under a copied directory, the Dockerfile, the epoch and .dockerignore: a new image.
			const seen = new Set([first]);
			for (const [file, text] of [["app/main.js", "2"], ["app/new.js", "n"], ["lib/package.json", "{\"a\":1}"], ["Dockerfile", "FROM scratch\nCOPY app ./app\nCOPY lib/package.json ./lib/\n"], ["deploy/IMAGE_EPOCH", "2\n"], [".dockerignore", ""]] as const) {
				r.write(file, text);
				r.commit(`change ${file}`);
				const next = id(r);
				expect(seen.has(next), file).toBe(false);
				seen.add(next);
			}
		} finally {
			r.cleanup();
		}
	});

	it("is the same for the same inputs on another commit, and does not read the working tree", () => {
		const r = project();
		try {
			const first = id(r);
			r.write("unrelated/other.txt", "more");
			r.commit("another commit");
			expect(id(r)).toBe(first);
			// An uncommitted edit is not in the image CI builds, which is the commit.
			r.write("app/main.js", "uncommitted");
			expect(id(r)).toBe(first);
		} finally {
			r.cleanup();
		}
	});

	it("is not changed by a change to another image's inputs in the real repository, and is by its own", () => {
		// The web image copies two packages and the web files; the backend image copies the packages and the computer.
		const web = identity({ root, dockerfile: IMAGES.web, ref: "HEAD" });
		const backend = identity({ root, dockerfile: IMAGES.backend, ref: "HEAD" });
		expect(web).not.toBe(backend);
		expect(identity({ root, dockerfile: IMAGES.web, ref: "HEAD" })).toBe(web);
	});

	it("plans a build only for an image the registry does not have, and always the backend for a release, and everything when forced", () => {
		const r = project();
		try {
			const real = (opts: { release?: boolean; force?: boolean; has: (repo: string, id: string) => boolean }) => plan({ owner: "owner", release: opts.release ?? false, force: opts.force ?? false, exists: opts.has, root });
			const have = new Set<string>();
			const names = (p: { name: string; build: boolean }[]) => p.filter((i) => i.build).map((i) => i.name);
			expect(names(real({ has: () => false }))).toEqual(["backend", "web", "computer"]);
			const first = real({ has: () => false });
			for (const i of first) have.add(`${i.repository}:${i.identity}`);
			const exists = (repository: string, id: string) => have.has(`${repository}:${id}`);
			// Everything already published: nothing to build, for a push.
			expect(names(real({ has: exists }))).toEqual([]);
			// A release builds the backend again (its version is baked in) and reuses the rest.
			expect(names(real({ has: exists, release: true }))).toEqual(["backend"]);
			expect(names(real({ has: exists, force: true }))).toEqual(["backend", "web", "computer"]);
			// One image's inputs not in the registry: only that one.
			have.delete(`${first[1]!.repository}:${first[1]!.identity}`);
			expect(names(real({ has: exists }))).toEqual(["web"]);
			expect(first.map((i: { image: string }) => i.image)).toEqual(["pim", "pim-web", "pim-computer"]);
		} finally {
			r.cleanup();
		}
	});
});
