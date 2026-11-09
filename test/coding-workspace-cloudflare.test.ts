import { describe, expect, it } from "vitest";
import { CloudflareSandboxProvider, type SandboxLike } from "../src/coding/workspace/cloudflare";
import { runConformanceSuite } from "../src/coding/workspace/conformance";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { type ExecEvent, WORKSPACE_ROOT, type Workspace, type WorkspaceSpec } from "../src/coding/workspace/types";

// The SDK is not imported anywhere. These tests run the provider against an in-memory SandboxLike built on the fake workspace: the fake runs the user's commands and holds the files, and a few POSIX utilities the provider uses for file operations (realpath, find, rm, chmod, test) are answered from the fake's file API. Nothing here proves how the real SDK behaves.

/** Undoes the single-quote quoting the provider applies to every word of a command line. */
function unquote(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let inQuote = false;
	let started = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i] as string;
		if (inQuote) {
			if (char === "'") inQuote = false;
			else current += char;
		} else if (char === "'") {
			inQuote = true;
			started = true;
		} else if (char === "\\" && line[i + 1] === "'") current += line[++i];
		else if (char === " ") {
			if (started || current) out.push(current);
			current = "";
			started = false;
		} else current += char;
	}
	if (started || current) out.push(current);
	return out;
}

const absolute = (p: string) => (p.startsWith("/") ? p : `${WORKSPACE_ROOT}/${p}`);
const statLine = (type: string, size: number, mode: number, mtimeMs: number, name: string) => `${type === "dir" ? "d" : type === "symlink" ? "l" : "f"}|${size}|${(mode & 0o777).toString(8)}|${mtimeMs / 1000}|${name}\n`;

class MemorySandbox implements SandboxLike {
	calls: string[] = [];
	private workspace!: Workspace;
	private ready: Promise<void>;

	constructor(
		private fake: FakeWorkspaceProvider,
		private sessionId: string,
		private withBackup: boolean,
	) {
		this.ready = this.open();
		if (!withBackup) {
			this.createBackup = undefined;
			this.restoreBackup = undefined;
		}
	}

	private async open() {
		const spec: WorkspaceSpec = { sessionId: this.sessionId, image: "x", repo: { url: "", ref: "", branch: "" }, limits: { cpu: 1, memMiB: 1, diskMiB: 64, pids: 1, wallClockMin: 1 }, egress: { allow: [] }, gitAuth: { mode: "none" } };
		this.workspace = (await this.fake.get(await this.fake.create(spec))) as Workspace;
	}

	async exec(command: string, o: Parameters<SandboxLike["exec"]>[1] = {}) {
		await this.ready;
		this.calls.push(command);
		const argv = unquote(command.startsWith("test ") ? command.replaceAll("'", "") : command);
		const [name, ...args] = argv;
		const reply = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: "" });
		const safely = async (work: () => Promise<{ exitCode: number; stdout?: string; stderr?: string }>) => {
			try {
				return await work();
			} catch (error) {
				return { exitCode: 1, stdout: "", stderr: String(error) };
			}
		};
		if (name === "realpath") {
			const path = absolute(args[args.length - 1] as string);
			try {
				await this.workspace.stat(path);
			} catch (error) {
				if ((error as Error).name === "WorkspacePathError") return reply("/outside\n");
			}
			return reply(`${path}\n`);
		}
		if (name === "test") return safely(async () => ((await this.workspace.stat(args[1] as string)).type === "dir" ? reply("") : reply("", 1)));
		if (name === "find") {
			const path = args[0] as string;
			return safely(async () => {
				if (args.includes("-type")) return reply((await this.workspace.stat(path)).type === "dir" ? `${path}\n` : "");
				if (args.includes("-mindepth")) return reply((await this.workspace.list(path)).map((e) => statLine(e.type, e.size, e.mode, e.mtimeMs, e.name)).join(""));
				const stat = await this.workspace.stat(path);
				return reply(statLine(stat.type, stat.size, stat.mode, stat.mtimeMs, path === WORKSPACE_ROOT ? "workspace" : stat.name));
			});
		}
		if (name === "rm") return safely(async () => (await this.workspace.remove(args[args.length - 1] as string), reply("")));
		if (name === "chmod")
			return safely(async () => {
				const path = args[1] as string;
				await this.workspace.writeFile(path, await this.workspace.readFile(path), Number.parseInt(args[0] as string, 8));
				return reply("");
			});
		for await (const event of this.workspace.exec(argv, { cwd: o.cwd, env: o.env, stdin: o.stdin, signal: o.signal, timeoutMs: 600_000 })) {
			if (event.type === "exit") {
				if (event.code === null) throw new Error("aborted");
				return { exitCode: event.code };
			}
			o.onOutput?.(event.type, event.data);
		}
		throw new Error("no exit");
	}

	async readFile(path: string) {
		await this.ready;
		return { content: btoa(Array.from(await this.workspace.readFile(path), (b) => String.fromCharCode(b)).join("")), encoding: "base64" };
	}

	async writeFile(path: string, content: string) {
		await this.ready;
		await this.workspace.writeFile(path, Uint8Array.from(atob(content), (c) => c.charCodeAt(0)));
	}

	async mkdir() {}

	createBackup: SandboxLike["createBackup"] = async () => {
		await this.ready;
		const id = (await this.workspace.snapshot()).id;
		return { id, dir: WORKSPACE_ROOT };
	};

	restoreBackup: SandboxLike["restoreBackup"] = async (backup) => {
		await this.ready;
		await this.workspace.restore({ id: backup.id, providerId: "fake" });
	};

	async destroy() {
		await this.ready;
		for (const entry of await this.workspace.list(WORKSPACE_ROOT)) await this.workspace.remove(entry.name);
	}
}

function makeProvider(options: { backup?: boolean } = {}) {
	const fake = new FakeWorkspaceProvider();
	const sandboxes = new Map<string, MemorySandbox>();
	const provider = new CloudflareSandboxProvider({
		sandboxFor: (id) => {
			let sandbox = sandboxes.get(id);
			if (!sandbox) sandboxes.set(id, (sandbox = new MemorySandbox(fake, id, options.backup ?? true)));
			return sandbox;
		},
		backup: options.backup === false ? undefined : {},
	});
	return { provider, sandboxes };
}

runConformanceSuite("cloudflare sandbox, with backups", () => makeProvider().provider);
runConformanceSuite("cloudflare sandbox, without backups", () => makeProvider({ backup: false }).provider);

const spec = (sessionId: string): WorkspaceSpec => ({ sessionId, image: "x", repo: { url: "", ref: "", branch: "" }, limits: { cpu: 1, memMiB: 1, diskMiB: 1, pids: 1, wallClockMin: 1 }, egress: { allow: [] }, gitAuth: { mode: "none" } });

/** A sandbox whose exec the test scripts; everything else is inert. */
function scripted(exec: SandboxLike["exec"]): SandboxLike {
	return { exec, readFile: async () => ({ content: "" }), writeFile: async () => {}, mkdir: async () => {} };
}

async function collect(workspace: Workspace, o: Parameters<Workspace["exec"]>[1]) {
	const events: ExecEvent[] = [];
	for await (const event of workspace.exec(["run"], o)) events.push(event);
	return events;
}

describe("cloudflare sandbox provider", () => {
	it("reports capabilities from what it was given", () => {
		const bare = new CloudflareSandboxProvider({ sandboxFor: () => scripted(async () => ({ exitCode: 0 })) });
		expect(bare.capabilities).toEqual({ snapshot: false, egressAllowlist: false, maxConcurrent: 2 });
		const full = new CloudflareSandboxProvider({ sandboxFor: () => scripted(async () => ({ exitCode: 0 })), backup: {}, applyEgress: async () => {}, maxConcurrent: 5 });
		expect(full.capabilities).toEqual({ snapshot: true, egressAllowlist: true, maxConcurrent: 5 });
	});

	it("hands the egress allowlist to the hook when a workspace is created", async () => {
		const seen: string[][] = [];
		const provider = new CloudflareSandboxProvider({ sandboxFor: () => scripted(async () => ({ exitCode: 0 })), applyEgress: async (_sandbox, allow) => void seen.push(allow) });
		await provider.create({ ...spec("s1"), egress: { allow: ["github.com"] } });
		expect(seen).toEqual([["github.com"]]);
	});

	it("shell-quotes each argument, so spaces and quotes stay one word", async () => {
		const lines: string[] = [];
		const provider = new CloudflareSandboxProvider({ sandboxFor: () => scripted(async (line) => (lines.push(line), { exitCode: 0 })) });
		const workspace = (await provider.get(await provider.create(spec("s2")))) as Workspace;
		for await (const _ of workspace.exec(["echo", "it's a $HOME"], { timeoutMs: 1000 }));
		expect(lines.at(-1)).toBe(`'echo' 'it'\\''s a $HOME'`);
	});

	it("kills on timeout even when the sandbox ignores the abort, and the exit is flagged", async () => {
		const provider = new CloudflareSandboxProvider({ sandboxFor: () => scripted(() => new Promise(() => {})) });
		const workspace = (await provider.get(await provider.create(spec("s3")))) as Workspace;
		const events = await collect(workspace, { timeoutMs: 50 });
		expect(events).toEqual([{ type: "exit", code: null, signal: "SIGKILL", timedOut: true }]);
	});

	it("passes the abort to the sandbox and reports an abort without timedOut", async () => {
		let sawSignal: AbortSignal | undefined;
		const provider = new CloudflareSandboxProvider({
			sandboxFor: () =>
				scripted((_line, o) => {
					sawSignal = o?.signal;
					return new Promise((_, reject) => o?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
				}),
		});
		const workspace = (await provider.get(await provider.create(spec("s4")))) as Workspace;
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const events = await collect(workspace, { timeoutMs: 10_000, signal: controller.signal });
		expect(events).toEqual([{ type: "exit", code: null, signal: "SIGTERM", timedOut: false }]);
		expect(sawSignal?.aborted).toBe(true);
		// An already-aborted signal kills without running anything to completion.
		const early = AbortSignal.abort();
		expect(await collect(workspace, { timeoutMs: 10_000, signal: early })).toEqual([{ type: "exit", code: null, signal: "SIGTERM", timedOut: false }]);
	});

	it("maps a sandbox failure to stderr and a SANDBOX_ERROR exit instead of throwing", async () => {
		const provider = new CloudflareSandboxProvider({
			sandboxFor: () =>
				scripted(async (line) => {
					if (line.startsWith("test")) return { exitCode: 0 };
					throw new Error("container unavailable");
				}),
		});
		const workspace = (await provider.get(await provider.create(spec("s5")))) as Workspace;
		const events = await collect(workspace, { timeoutMs: 1000 });
		expect(events).toEqual([
			{ type: "stderr", data: "sandbox error: container unavailable\n" },
			{ type: "exit", code: null, signal: "SANDBOX_ERROR" },
		]);
	});

	it("uses returned output when the SDK did not stream it", async () => {
		const provider = new CloudflareSandboxProvider({ sandboxFor: () => scripted(async () => ({ exitCode: 2, stdout: "o", stderr: "e" })) });
		const workspace = (await provider.get(await provider.create(spec("s6")))) as Workspace;
		expect(await collect(workspace, { timeoutMs: 1000 })).toEqual([
			{ type: "stdout", data: "o" },
			{ type: "stderr", data: "e" },
			{ type: "exit", code: 2 },
		]);
	});

	it("refuses a snapshot without backups", async () => {
		const { provider } = makeProvider({ backup: false });
		const workspace = (await provider.get(await provider.create(spec("s7")))) as Workspace;
		await expect(workspace.snapshot()).rejects.toThrow(/no backup/);
	});
});
