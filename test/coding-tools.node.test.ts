import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type CodingToolsDeps, createCodingTools, MemoryToolJournal, parseTestSummary, type TestRun } from "../src/coding/tools";
import { type FakeCommandHandler, FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import type { Workspace, WorkspaceSpec } from "../src/coding/workspace/types";

// The coding tools over the in-memory fake workspace. Like the workspace's own tests, these run in the Worker pool but touch no binding.
// The fake's shell knows echo, cat, sleep, exit and `>&2`; tests register stand-ins for rg, git and test runners to check what the tools run and how they read the results.

const spec: WorkspaceSpec = {
	sessionId: "coding-tools",
	image: "test",
	repo: { url: "https://example.com/repo.git", ref: "main", branch: "work" },
	limits: { cpu: 1, memMiB: 512, diskMiB: 64, pids: 64, wallClockMin: 60 },
	egress: { allow: [] },
	gitAuth: { mode: "none" },
};

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const textOf = (result: ToolExecutionResult) => (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

let tasks = 0;

async function setup(options: { handlers?: Record<string, FakeCommandHandler>; workspace?: (workspace: Workspace) => Workspace; deps?: Partial<CodingToolsDeps> } = {}) {
	const provider = new FakeWorkspaceProvider();
	for (const [name, handler] of Object.entries(options.handlers ?? {})) provider.register(name, handler);
	const workspace = (await provider.get(await provider.create(spec)))!;
	await workspace.writeFile("/workspace/repo/README.md", encode("# Hello\n"));
	const journal = new MemoryToolJournal();
	const runs: TestRun[] = [];
	const sunk: string[] = [];
	const seen = options.workspace?.(workspace) ?? workspace;
	const tools = createCodingTools({ workspace: async () => seen, journal, onTestRun: (run) => runs.push(run), sink: (event) => sunk.push(event.data), ...options.deps });
	/** Calls a tool as the harness would; the same `task` again is a rerun of that call after an interruption. */
	async function call(name: string, args: Record<string, unknown>, o: { task?: string; signal?: AbortSignal } = {}) {
		const output: string[] = [];
		const api = { taskId: o.task ?? `task-${++tasks}`, callId: "call-1", conversationId: "conversation", output: (chunk: string) => output.push(chunk), diagnostic: () => {} };
		const context = { abortSignal: o.signal, value: () => undefined };
		const tool = tools.find((each) => each.name === name);
		if (!tool) throw new Error(`No tool ${name}`);
		const result = await tool.execute(args as never, api as unknown as ToolExecutionApi, context as unknown as Context);
		return { result, text: textOf(result), isError: result.isError === true, streamed: output.join("") };
	}
	const file = async (path: string) => decode(await workspace.readFile(path));
	return { workspace, journal, runs, sunk, tools, call, file };
}

/** A command that counts how often it ran. */
function counter() {
	const state = { runs: 0 };
	const handler: FakeCommandHandler = () => {
		state.runs++;
		return { stdout: `run ${state.runs}\n` };
	};
	return { state, handler };
}

describe("the tool set", () => {
	it("offers each tool once, with a schema, and says which may run again", async () => {
		const { tools } = await setup();
		expect(tools.map((tool) => tool.name)).toEqual(["bash", "read", "write", "edit", "grep", "glob", "git", "test"]);
		for (const tool of tools) {
			expect(tool.description.length).toBeGreaterThan(80);
			expect((tool.parameters as { type?: unknown }).type).toBe("object");
			// Every tool handles its own rerun; the mutating ones through the journal.
			expect(tool.replay).toBe("safe");
		}
	});
});

describe("bash", () => {
	it("runs through sh -c in the repository and reports output and exit code", async () => {
		const { call, sunk } = await setup({ handlers: { pwd: ({ cwd }) => ({ stdout: `${cwd}\n` }) } });
		const { text, isError, streamed, result } = await call("bash", { command: "pwd; echo hello; echo oops >&2; exit 3" });
		expect(text).toBe("/workspace/repo\nhello\noops\n[Exit code 3]");
		expect(isError).toBe(true);
		expect(streamed).toBe("/workspace/repo\nhello\noops\n");
		expect(sunk.join("")).toBe(streamed);
		expect(result.details).toMatchObject({ exitCode: 3, timedOut: false });
		expect((await call("bash", { command: "echo fine" })).isError).toBe(false);
	});

	it("keeps the end of long output, with a notice", async () => {
		const lines = Array.from({ length: 10_000 }, (_, i) => `line ${i + 1}`).join("\n");
		const { call } = await setup({ handlers: { spew: () => ({ stdout: `${lines}\n` }) } });
		const { text } = await call("bash", { command: "spew" });
		expect(text).toMatch(/^\[Output truncated: the first \d+ bytes were left out; this is the end of it\.\]\n/);
		expect(text.endsWith("line 10000\n[Exit code 0]")).toBe(true);
		expect(text).not.toContain("line 1\n");
		expect(new TextEncoder().encode(text).byteLength).toBeLessThan(30_200);
	});

	it("keeps at most 2000 lines of short output", async () => {
		const { call } = await setup({ handlers: { spew: () => ({ stdout: "x\n".repeat(5_000) }) } });
		const { text } = await call("bash", { command: "spew" });
		expect(text.split("\n").filter((line) => line === "x")).toHaveLength(2_000);
		expect(text).toContain("the first 6000 bytes were left out");
	});

	it("kills a command at its timeout", async () => {
		const { call } = await setup();
		const { text, isError } = await call("bash", { command: "echo start; sleep 30", timeout: 1 });
		expect(text).toBe("start\n[Timed out after 1 s; the command was killed.]");
		expect(isError).toBe(true);
	});

	it("never shows secrets", async () => {
		const { call, sunk } = await setup();
		const { text } = await call("bash", { command: "echo GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789; echo https://bob:hunter22@example.com/x.git" });
		expect(text).not.toContain("ghp_");
		expect(text).not.toContain("hunter22");
		expect(text).toContain("GITHUB_TOKEN=[REDACTED]");
		expect(text).toContain("https://[REDACTED]@example.com/x.git");
		expect(sunk.join("")).not.toContain("hunter22");
	});

	it("kills the command on abort, and a rerun of the call reports it interrupted without running it", async () => {
		const { state, handler } = counter();
		const { call, journal } = await setup({ handlers: { count: handler } });
		const abort = new AbortController();
		const started = Date.now();
		setTimeout(() => abort.abort(), 50);
		await expect(call("bash", { command: "count; sleep 30" }, { task: "b1", signal: abort.signal })).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(journal.entries.get("b1")).toEqual({ state: "running", tool: "bash" });
		const rerun = await call("bash", { command: "count; sleep 30" }, { task: "b1" });
		expect(rerun.isError).toBe(true);
		expect(rerun.text).toMatch(/^bash was interrupted, state unknown: inspect before retrying\./);
		expect(state.runs).toBe(1);
	});

	it("returns a finished call's result when the call runs again", async () => {
		const { state, handler } = counter();
		const { call } = await setup({ handlers: { count: handler } });
		const first = await call("bash", { command: "count" }, { task: "b2" });
		const again = await call("bash", { command: "count" }, { task: "b2" });
		expect(again.text).toBe(first.text);
		expect(again.result.details).toEqual(first.result.details);
		expect(state.runs).toBe(1);
	});
});

describe("read", () => {
	const numbered = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

	it("reads a range of lines and says how to read on", async () => {
		const { call, workspace } = await setup();
		await workspace.writeFile("/workspace/repo/src/a.txt", encode(`${numbered}\n`));
		expect((await call("read", { path: "src/a.txt", offset: 3, limit: 2 })).text).toBe("line 3\nline 4\n\n[Lines 3-4 of 10. Use offset=5 to read on.]");
		expect((await call("read", { path: "/workspace/repo/src/a.txt", offset: 9 })).text).toBe("line 9\nline 10");
		expect((await call("read", { path: "./src/../src/a.txt" })).text).toBe(numbered);
		const past = await call("read", { path: "src/a.txt", offset: 11 });
		expect(past).toMatchObject({ isError: true, text: "offset 11 is past the end of src/a.txt, which has 10 lines." });
	});

	it("caps what it returns at about 30 KB", async () => {
		const { call, workspace } = await setup();
		await workspace.writeFile("/workspace/repo/big.txt", encode(`${"a".repeat(99)}\n`.repeat(1_000)));
		const { text } = await call("read", { path: "big.txt" });
		expect(text).toMatch(/\n\n\[Lines 1-300 of 1000\. Use offset=301 to read on\.\]$/);
	});

	it("refuses directories, missing, binary and oversized files", async () => {
		const { call, workspace } = await setup();
		await workspace.writeFile("/workspace/repo/logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
		await workspace.writeFile("/workspace/repo/huge.txt", new Uint8Array(5 * 1024 * 1024 + 1).fill(97));
		expect(await call("read", { path: "." })).toMatchObject({ isError: true, text: ". is a directory. Use glob to list the files in it." });
		expect(await call("read", { path: "missing.txt" })).toMatchObject({ isError: true, text: expect.stringContaining("No such file") });
		expect(await call("read", { path: "logo.png" })).toMatchObject({ isError: true, text: expect.stringContaining("binary") });
		expect(await call("read", { path: "huge.txt" })).toMatchObject({ isError: true, text: expect.stringContaining("more than read takes") });
	});

	it("refuses paths outside the workspace, including through a symlink", async () => {
		const { call } = await setup();
		for (const path of ["../../etc/passwd", "/etc/passwd", "/workspace/../etc/passwd"]) {
			expect(await call("read", { path })).toMatchObject({ isError: true, text: expect.stringContaining("outside /workspace") });
		}
		// Whether a link leads out is for the workspace to judge: it refuses to follow it.
		await call("bash", { command: "ln -s ../../tmp up" });
		expect(await call("read", { path: "up/x" })).toMatchObject({ isError: true, text: expect.stringContaining("escapes /workspace") });
	});

	it("hides secrets in what it reads", async () => {
		const { call, workspace } = await setup();
		await workspace.writeFile("/workspace/repo/.env", encode("DATABASE_PASSWORD=s3cret!\nAWS_KEY=AKIAABCDEFGHIJKLMNOP\nPORT=8080\n"));
		expect((await call("read", { path: ".env" })).text).toBe("DATABASE_PASSWORD=[REDACTED]\nAWS_KEY=[REDACTED]\nPORT=8080");
	});
});

describe("write", () => {
	it("creates files with their directories, and replaces them keeping their permissions", async () => {
		const { call, workspace, file } = await setup();
		expect((await call("write", { path: "src/deep/new.ts", content: "export {};\n" })).text).toBe("Created src/deep/new.ts (11 bytes).");
		expect(await file("/workspace/repo/src/deep/new.ts")).toBe("export {};\n");
		await workspace.writeFile("/workspace/repo/run.sh", encode("#!/bin/sh\n"), 0o755);
		expect((await call("write", { path: "run.sh", content: "#!/bin/sh\necho hi\n" })).text).toBe("Replaced run.sh (18 bytes).");
		expect((await workspace.stat("/workspace/repo/run.sh")).mode & 0o777).toBe(0o755);
		expect(await call("write", { path: "../../etc/x", content: "" })).toMatchObject({ isError: true, text: expect.stringContaining("outside /workspace") });
		expect(await call("write", { path: "src", content: "" })).toMatchObject({ isError: true, text: "src is a directory." });
	});

	it("records what it writes, and a rerun returns that result once the file holds it", async () => {
		const { call, journal, workspace, file } = await setup();
		const first = await call("write", { path: "notes.md", content: "one\n" }, { task: "w1" });
		expect(journal.entries.get("w1")).toMatchObject({ state: "file", tool: "write", path: "/workspace/repo/notes.md", before: null, after: expect.stringMatching(/^[0-9a-f]{64}$/) });
		// A rerun after the write landed reports what the first run did; running again would have said "Replaced".
		expect(await call("write", { path: "notes.md", content: "one\n" }, { task: "w1" })).toMatchObject({ isError: false, text: first.text });
		// Once something else changed the file, the rerun leaves it alone.
		await workspace.writeFile("/workspace/repo/notes.md", encode("changed\n"));
		const conflict = await call("write", { path: "notes.md", content: "one\n" }, { task: "w1" });
		expect(conflict.isError).toBe(true);
		expect(conflict.text).toMatch(/^write on notes\.md was interrupted, state unknown: inspect before retrying\./);
		expect(await file("/workspace/repo/notes.md")).toBe("changed\n");
	});

	it("writes on a rerun when the first run recorded its intent but its write never landed", async () => {
		let failNext = true;
		const { call, file, journal } = await setup({
			workspace: (inner) =>
				Object.assign(Object.create(inner) as Workspace, {
					writeFile: async (path: string, data: Uint8Array, mode?: number) => {
						if (failNext) {
							failNext = false;
							throw new Error("evicted");
						}
						return inner.writeFile(path, data, mode);
					},
				}),
		});
		await expect(call("write", { path: "README.md", content: "# New\n" }, { task: "w2" })).rejects.toThrow("evicted");
		expect(journal.entries.get("w2")).toMatchObject({ state: "file" });
		expect(await file("/workspace/repo/README.md")).toBe("# Hello\n");
		expect(await call("write", { path: "README.md", content: "# New\n" }, { task: "w2" })).toMatchObject({ isError: false, text: "Replaced README.md (6 bytes)." });
		expect(await file("/workspace/repo/README.md")).toBe("# New\n");
	});
});

describe("edit", () => {
	const source = "const a = 1;\nconst b = 2;\nconst a2 = 1;\n";

	it("replaces one exact, unique match", async () => {
		const { call, workspace, file } = await setup();
		await workspace.writeFile("/workspace/repo/x.ts", encode(source));
		expect((await call("edit", { path: "x.ts", old_string: "const b = 2;", new_string: "const b = $&3;" })).text).toBe("Edited x.ts: replaced 1 occurrence, the first at line 2.");
		// `$&` is text, not a replacement pattern.
		expect(await file("/workspace/repo/x.ts")).toBe("const a = 1;\nconst b = $&3;\nconst a2 = 1;\n");
	});

	it("refuses a match that isn't unique unless asked to replace all", async () => {
		const { call, workspace, file } = await setup();
		await workspace.writeFile("/workspace/repo/x.ts", encode(source));
		const twice = await call("edit", { path: "x.ts", old_string: " = 1;", new_string: " = 9;" });
		expect(twice).toMatchObject({ isError: true, text: expect.stringContaining("occurs 2 times in x.ts") });
		expect(await file("/workspace/repo/x.ts")).toBe(source);
		expect((await call("edit", { path: "x.ts", old_string: " = 1;", new_string: " = 9;", replace_all: true })).text).toBe("Edited x.ts: replaced 2 occurrences, the first at line 1.");
		expect(await file("/workspace/repo/x.ts")).toBe("const a = 9;\nconst b = 2;\nconst a2 = 9;\n");
	});

	it("explains what is wrong with an edit it can't make", async () => {
		const { call, workspace, file } = await setup();
		await workspace.writeFile("/workspace/repo/x.ts", encode(source));
		const cases: [Record<string, unknown>, string][] = [
			[{ path: "x.ts", old_string: "const  b", new_string: "y" }, "old_string was not found in x.ts"],
			[{ path: "x.ts", old_string: "", new_string: "y" }, "old_string is empty"],
			[{ path: "x.ts", old_string: "const b", new_string: "const b" }, "are the same"],
			[{ path: "nope.ts", old_string: "a", new_string: "b" }, "nope.ts does not exist. Use write to create it."],
		];
		for (const [args, message] of cases) expect(await call("edit", args)).toMatchObject({ isError: true, text: expect.stringContaining(message) });
		expect(await file("/workspace/repo/x.ts")).toBe(source);
	});

	it("returns the recorded result on a rerun instead of failing to find what it already replaced", async () => {
		const { call, workspace, file } = await setup();
		await workspace.writeFile("/workspace/repo/x.ts", encode(source));
		const args = { path: "x.ts", old_string: "const b = 2;", new_string: "const b = 3;" };
		const first = await call("edit", args, { task: "e1" });
		expect(await call("edit", args, { task: "e1" })).toMatchObject({ isError: false, text: first.text });
		// A new call with the same arguments is a new edit, and finds nothing to replace.
		expect((await call("edit", args, { task: "e2" })).isError).toBe(true);
		expect(await file("/workspace/repo/x.ts")).toBe("const a = 1;\nconst b = 3;\nconst a2 = 1;\n");
	});

	it("applies the edit once on a rerun when the first write never landed", async () => {
		let failNext = true;
		const { call, file } = await setup({
			workspace: (inner) =>
				Object.assign(Object.create(inner) as Workspace, {
					writeFile: async (path: string, data: Uint8Array, mode?: number) => {
						if (failNext) {
							failNext = false;
							throw new Error("evicted");
						}
						return inner.writeFile(path, data, mode);
					},
				}),
		});
		const args = { path: "README.md", old_string: "Hello", new_string: "Hello, world" };
		await expect(call("edit", args, { task: "e3" })).rejects.toThrow("evicted");
		expect((await call("edit", args, { task: "e3" })).isError).toBe(false);
		expect(await file("/workspace/repo/README.md")).toBe("# Hello, world\n");
	});
});

describe("grep and glob", () => {
	function rg(reply: (argv: string[]) => { stdout?: string; stderr?: string; code?: number }) {
		const calls: string[][] = [];
		const handler: FakeCommandHandler = ({ argv, cwd }) => {
			expect(cwd).toBe("/workspace/repo");
			calls.push(argv);
			return reply(argv);
		};
		return { calls, handler };
	}

	it("runs ripgrep with the pattern after -e and the path after --", async () => {
		const { calls, handler } = rg(() => ({ stdout: "src/a.ts:3:-foo()\nsrc/b.ts:9:-foo\n" }));
		const { call } = await setup({ handlers: { rg: handler } });
		const { text } = await call("grep", { pattern: "-foo", path: "src", glob: "*.ts", ignore_case: true });
		expect(text).toBe("src/a.ts:3:-foo()\nsrc/b.ts:9:-foo");
		expect(calls[0]).toEqual(["rg", "--line-number", "--no-heading", "--with-filename", "--color=never", "--max-columns=300", "--max-columns-preview", "--ignore-case", "--glob=*.ts", "-e", "-foo", "--", "src"]);
		await call("grep", { pattern: "x", path: "/workspace/other", fixed_strings: true });
		expect(calls[1]?.slice(-5)).toEqual(["--fixed-strings", "-e", "x", "--", "/workspace/other"]);
		await call("grep", { pattern: "x" });
		expect(calls[2]?.slice(-3)).toEqual(["-e", "x", "--"]);
	});

	it("reports no matches, failures, and refuses paths outside the workspace", async () => {
		let reply: { stdout?: string; stderr?: string; code?: number } = { code: 1 };
		const { calls, handler } = rg(() => reply);
		const { call } = await setup({ handlers: { rg: handler } });
		expect(await call("grep", { pattern: "nothing" })).toMatchObject({ isError: false, text: "No matches." });
		reply = { stderr: "regex parse error: unclosed group\n", code: 2 };
		expect(await call("grep", { pattern: "(" })).toMatchObject({ isError: true, text: "The search failed: regex parse error: unclosed group" });
		reply = { stdout: "a.ts:1:x\n", stderr: "secret.txt: Permission denied\n", code: 2 };
		expect((await call("grep", { pattern: "x" })).text).toBe("a.ts:1:x\n[Some files could not be searched: secret.txt: Permission denied]");
		expect(await call("grep", { pattern: "x", path: "../../.." })).toMatchObject({ isError: true, text: expect.stringContaining("outside /workspace") });
		expect(calls).toHaveLength(3);
	});

	it("caps the matches it returns", async () => {
		const { handler } = rg(() => ({ stdout: Array.from({ length: 1_000 }, (_, i) => `f.ts:${i + 1}:hit`).join("\n") }));
		const { call } = await setup({ handlers: { rg: handler } });
		const { text } = await call("grep", { pattern: "hit", max_results: 10 });
		expect(text.split("\n")).toHaveLength(11);
		expect(text.endsWith("f.ts:10:hit\n[Showing the first 10 matches; there are more. Narrow the pattern, path or glob.]")).toBe(true);
		const all = await call("grep", { pattern: "hit" });
		expect(all.text.split("\n")).toHaveLength(101);
	});

	it("lists files matching a glob, capped", async () => {
		let files = ["src/a.ts", "src/b.ts"];
		const { calls, handler } = rg(() => (files.length ? { stdout: `${files.join("\n")}\n` } : { code: 1 }));
		const { call } = await setup({ handlers: { rg: handler } });
		expect((await call("glob", { pattern: "**/*.ts" })).text).toBe("src/a.ts\nsrc/b.ts");
		expect(calls[0]).toEqual(["rg", "--files", "--color=never", "--sort=path", "--glob=**/*.ts", "--"]);
		files = Array.from({ length: 600 }, (_, i) => `f${i}.ts`);
		const { text } = await call("glob", { pattern: "*.ts" });
		expect(text.split("\n")).toHaveLength(501);
		expect(text).toContain("[Showing the first 500 paths");
		files = [];
		expect((await call("glob", { pattern: "*.zig" })).text).toBe("No files match.");
		expect(await call("glob", { pattern: "*", path: "/tmp" })).toMatchObject({ isError: true, text: expect.stringContaining("outside /workspace") });
	});
});

describe("git", () => {
	function gitStub(reply: (argv: string[]) => { stdout?: string; stderr?: string; code?: number } | Promise<{ stdout?: string; stderr?: string; code?: number }> = () => ({})) {
		const calls: { argv: string[]; env: Record<string, string> }[] = [];
		const handler: FakeCommandHandler = (context) => {
			calls.push({ argv: context.argv, env: context.env });
			return reply(context.argv);
		};
		return { calls, handler };
	}

	it("runs allowed subcommands without a pager, as the tool's own identity", async () => {
		const { calls, handler } = gitStub((argv) => (argv[2] === "status" ? { stdout: "On branch work\n" } : {}));
		const { call } = await setup({ handlers: { git: handler }, deps: { gitIdentity: { name: "Pim Coder", email: "coder@pim.test" } } });
		expect((await call("git", { subcommand: "status" })).text).toBe("On branch work\n");
		expect((await call("git", { subcommand: "commit", args: ["-m", "Fix the parser"] })).text).toBe("(no output)");
		expect((await call("git", { subcommand: "checkout", args: ["-b", "feature", "main"] })).isError).toBe(false);
		expect(calls.map((each) => each.argv)).toEqual([
			["git", "--no-pager", "status"],
			["git", "--no-pager", "commit", "-m", "Fix the parser"],
			["git", "--no-pager", "checkout", "-b", "feature", "main"],
		]);
		expect(calls[1]?.env).toMatchObject({ GIT_AUTHOR_NAME: "Pim Coder", GIT_AUTHOR_EMAIL: "coder@pim.test", GIT_COMMITTER_NAME: "Pim Coder", GIT_COMMITTER_EMAIL: "coder@pim.test", GIT_EDITOR: "true" });
	});

	it("refuses what could reach remotes, change config, write elsewhere or set the author", async () => {
		const { calls, handler } = gitStub();
		const { call } = await setup({ handlers: { git: handler } });
		const refused: Record<string, unknown>[] = [
			{ subcommand: "push" },
			{ subcommand: "remote", args: ["add", "x", "https://evil.test"] },
			{ subcommand: "config", args: ["user.name", "x"] },
			{ subcommand: "diff", args: ["--output=/tmp/x"] },
			{ subcommand: "diff", args: ["--out=/tmp/x"] },
			{ subcommand: "diff", args: ["--no-index", "/etc/passwd", "/dev/null"] },
			{ subcommand: "log", args: ["--ext-diff"] },
			{ subcommand: "commit", args: ["-m", "x", "--author=Mallory <m@x>"] },
			{ subcommand: "checkout", args: ["main"] },
			{ subcommand: "checkout", args: ["-b", "--orphan"] },
			{ subcommand: "checkout", args: ["--", "file.ts"] },
			{ subcommand: "branch", args: ["-u", "origin/main"] },
			{ subcommand: "branch", args: ["--set-upstream-to=origin/main"] },
		];
		for (const args of refused) expect(await call("git", args), JSON.stringify(args)).toMatchObject({ isError: true });
		expect(calls).toHaveLength(0);
		// `-u` means something else to add, and is fine there.
		expect((await call("git", { subcommand: "add", args: ["-u"] })).isError).toBe(false);
	});

	it("reports a failing command with its exit code", async () => {
		const { handler } = gitStub(() => ({ stderr: "fatal: not a git repository\n", code: 128 }));
		const { call } = await setup({ handlers: { git: handler } });
		expect(await call("git", { subcommand: "log" })).toMatchObject({ isError: true, text: "fatal: not a git repository\n[Exit code 128]" });
	});

	it("runs reading subcommands again on a rerun, but never one that changes things", async () => {
		let hang = false;
		const { calls, handler } = gitStub(async () => {
			if (hang) await new Promise(() => {});
			return { stdout: "ok\n" };
		});
		const { call } = await setup({ handlers: { git: handler } });
		await call("git", { subcommand: "status" }, { task: "g1" });
		await call("git", { subcommand: "status" }, { task: "g1" });
		expect(calls).toHaveLength(2);
		hang = true;
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 20);
		await expect(call("git", { subcommand: "commit", args: ["-m", "x"] }, { task: "g2", signal: abort.signal })).rejects.toThrow();
		const rerun = await call("git", { subcommand: "commit", args: ["-m", "x"] }, { task: "g2" });
		expect(rerun).toMatchObject({ isError: true, text: expect.stringMatching(/^git commit was interrupted, state unknown: inspect before retrying\./) });
		expect(calls).toHaveLength(3);
	});
});

describe("test", () => {
	const pytestOutput = "collected 13 items\n\ntests/test_a.py ..F.F.....s..\n\n==== 2 failed, 10 passed, 1 skipped in 0.42s ====\n";

	it("records the run, its counts, and tells onTestRun", async () => {
		const { call, runs, sunk } = await setup({ handlers: { pytest: () => ({ stdout: pytestOutput, code: 1 }) } });
		const { text, isError, result } = await call("test", { command: "pytest -q" });
		expect(isError).toBe(true);
		expect(text).toMatch(/^collected 13 items[\s\S]*in 0\.42s ====\n\[Exit code 1\] \[Took \d+\.\d s\.\]\n\[Tests: 2 failed, 10 passed, 1 skipped \(13 total\), read from pytest output\.\]$/);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ command: "pytest -q", exitCode: 1, timedOut: false, summary: { format: "pytest", passed: 10, failed: 2, skipped: 1, total: 13 }, output: pytestOutput });
		expect(runs[0]?.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.details).toMatchObject({ exitCode: 1, summary: { failed: 2 } });
		expect(sunk.join("")).toBe(pytestOutput);
	});

	it("reads a JUnit report the command writes", async () => {
		const xml = '<?xml version="1.0"?>\n<testsuites tests="7" failures="1" errors="1" skipped="2"><testsuite name="a" tests="7"/></testsuites>\n';
		const { call, runs } = await setup({
			handlers: {
				mvn: async ({ workspace }) => {
					await workspace.writeFile("/workspace/repo/target/report.xml", encode(xml));
					return { stdout: "BUILD FAILURE\n", code: 1 };
				},
			},
		});
		const { text } = await call("test", { command: "mvn test", junit_report: "target/report.xml" });
		expect(text).toContain("[Tests: 2 failed, 3 passed, 2 skipped (7 total), read from junit output.]");
		expect(runs[0]?.summary).toEqual({ format: "junit", passed: 3, failed: 2, skipped: 2, total: 7 });
		const missing = await call("test", { command: "echo done", junit_report: "nowhere.xml" });
		expect(missing.text).toContain("[No JUnit results could be read from nowhere.xml.]");
		expect(missing.text).toContain("[No test counts could be read from the output.]");
		expect(runs[1]).toMatchObject({ exitCode: 0, summary: null });
	});

	it("never runs an interrupted test run again", async () => {
		const { call, runs } = await setup();
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 20);
		await expect(call("test", { command: "sleep 30" }, { task: "t1", signal: abort.signal })).rejects.toThrow();
		expect(runs).toHaveLength(0);
		expect(await call("test", { command: "sleep 30" }, { task: "t1" })).toMatchObject({ isError: true, text: expect.stringMatching(/^test was interrupted, state unknown: inspect before retrying\./) });
		expect(runs).toHaveLength(0);
	});
});

describe("reading test summaries", () => {
	it("reads vitest's test line, not its file line, through ANSI colors", () => {
		const output = "\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m | \u001b[1m\u001b[32m4 passed\u001b[39m\u001b[22m (5)\n\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m3 failed\u001b[39m | \u001b[32m40 passed\u001b[39m | 2 skipped | 1 todo (46)\n   Start at  10:00:00\n";
		expect(parseTestSummary(output)).toEqual({ format: "vitest", passed: 40, failed: 3, skipped: 3, total: 46 });
	});

	it("reads pytest's summary with or without rules, counting errors as failures", () => {
		expect(parseTestSummary("1 failed, 2 passed, 3 errors, 1 xfailed, 4 warnings in 1.20s\n")).toEqual({ format: "pytest", passed: 2, failed: 4, skipped: 1, total: 7 });
		expect(parseTestSummary("=========== 5 passed in 0.01s ===========\n")).toEqual({ format: "pytest", passed: 5, failed: 0, skipped: 0, total: 5 });
		expect(parseTestSummary("===== no tests ran in 0.01s =====\n")).toEqual({ format: "pytest", passed: 0, failed: 0, skipped: 0, total: 0 });
	});

	it("adds up cargo's result for every test binary", () => {
		const output = [
			"running 3 tests",
			"test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s",
			"running 4 tests",
			"test result: FAILED. 2 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s",
		].join("\n");
		expect(parseTestSummary(output)).toEqual({ format: "cargo", passed: 5, failed: 2, skipped: 1, total: 8 });
	});

	it("reads TAP from its totals, or from its top-level lines", () => {
		const counted = "TAP version 13\n1..4\nok 1 - adds\nnot ok 2 - subtracts\n  ---\n  ok: nested detail\n  ...\nok 3 - divides # SKIP no floats\nok 4 - multiplies\n";
		expect(parseTestSummary(counted)).toEqual({ format: "tap", passed: 2, failed: 1, skipped: 1, total: 4 });
		const node = "TAP version 13\n# Subtest: a\n    ok 1 - inner\nok 1 - a\n1..1\n# tests 9\n# pass 7\n# fail 1\n# skipped 1\n# todo 0\n";
		expect(parseTestSummary(node)).toEqual({ format: "tap", passed: 7, failed: 1, skipped: 1, total: 9 });
	});

	it("adds up JUnit test suites when there are no totals", () => {
		const xml = '<testsuites><testsuite name="a" tests="4" failures="1" errors="0" skipped="1"></testsuite><testsuite name="b" tests="3" failures="0" errors="1"/></testsuites>';
		expect(parseTestSummary(xml)).toEqual({ format: "junit", passed: 4, failed: 2, skipped: 1, total: 7 });
	});

	it("gives nothing for output it doesn't recognize", () => {
		expect(parseTestSummary("ok\nall good\n")).toBeUndefined();
		expect(parseTestSummary("")).toBeUndefined();
	});
});

describe("raw command activity", () => {
	it("reports partial-line output activity without passing content or waiting for a newline", async () => {
		const active: string[] = [];
		const { call, sunk } = await setup({
			deps: { onActivity: (callId) => active.push(callId) },
			workspace: (inner) => Object.assign(Object.create(inner) as Workspace, {
				exec: async function* () {
					yield { type: "stdout", data: "partial" };
					expect(active).toEqual(["call-1"]);
					expect(sunk).toEqual([]);
					yield { type: "exit", code: 0 };
				},
			}),
		});
		await call("bash", { command: "test-command" });
		expect(sunk).toEqual(["partial"]);
	});
});
