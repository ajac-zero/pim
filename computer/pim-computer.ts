/**
 * pim-computer: connects a machine of the person's (a server, a VM, a box at
 * home) to their space on a Pim, so their agents can use it: run commands
 * with `shell`, and keep their files there. Pim shows that folder as Files.
 *
 * It connects out to `<Pim>/api/computer/connect` over a WebSocket with the
 * token Settings → Computer gives, and answers the space's calls; it needs no
 * open port. The calls are this file's `handle`. File calls name paths under
 * `/workspace`, which is the folder `--root` names here (`~/pim` unless set),
 * and never reach outside it, through `..` or a link. Commands run as the user
 * who runs this, with that folder as their working directory.
 *
 * Runs on Node.js 22.18 or later, with nothing to install:
 *
 *   PIM_URL=https://pim.example.com PIM_COMPUTER_TOKEN=pimc_… node pim-computer.ts
 *
 * Settings take flags too: `--url`, `--token`, `--root`. The token can also
 * be in a file named by `PIM_COMPUTER_TOKEN_FILE`.
 */

import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION = "0.1.0";

/** The folder the space's file calls name; it is `root` on this machine. */
export const WORKSPACE = "/workspace";

/** The close code a connection gets when another computer connects in its place. */
export const REPLACED = 4409;

/** The most bytes one read returns; larger files are read in parts. */
export const MAX_READ_BYTES = 1_048_576;

/** A failure the space gets back, with a code like Node's (`ENOENT`) where there is one. */
export class CallError extends Error {
	readonly code: string | undefined;
	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

/** What a command run gives back. */
export type ExecResult = {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	/** Output past `maxBytes` was cut from the middle. */
	readonly truncated: boolean;
};

export type ExecArgs = { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number; readonly maxBytes?: number };

/** Where this computer keeps the space's files, and how it runs commands (tests give their own). */
export type Machine = {
	/** The real path of the folder `/workspace` stands for. */
	readonly root: string;
	exec(args: ExecArgs, cwd: string): Promise<ExecResult>;
};

/** `/workspace/a/b` as a path relative to the root (`a/b`), or a refusal for anything outside it. */
function relative(virtual: unknown): string {
	if (typeof virtual !== "string" || !virtual.startsWith("/") || virtual.includes("\0")) {
		throw new CallError(`${String(virtual)} is not an absolute path under ${WORKSPACE}`, "EINVAL");
	}
	const resolved = path.posix.resolve(virtual);
	if (resolved === WORKSPACE) return "";
	if (!resolved.startsWith(`${WORKSPACE}/`)) throw new CallError(`${virtual} is outside ${WORKSPACE}`, "EACCES");
	return resolved.slice(WORKSPACE.length + 1);
}

/** A path on this machine as the space names it. */
function virtualOf(machine: Machine, local: string): string {
	const rest = path.relative(machine.root, local);
	return rest === "" ? WORKSPACE : `${WORKSPACE}/${rest.split(path.sep).join("/")}`;
}

/**
 * The local path for a space's path, checked to be in the root after links
 * are followed: the deepest part of it that exists must resolve inside.
 */
async function local(machine: Machine, virtual: unknown): Promise<string> {
	const rest = relative(virtual);
	const target = rest === "" ? machine.root : path.join(machine.root, ...rest.split("/"));
	let existing = target;
	while (true) {
		try {
			const real = await fs.realpath(existing);
			if (real !== machine.root && !real.startsWith(`${machine.root}${path.sep}`)) {
				throw new CallError(`${String(virtual)} leads outside ${WORKSPACE}`, "EACCES");
			}
			return target;
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT" || existing === machine.root) throw failure(error, String(virtual));
			existing = path.dirname(existing);
		}
	}
}

/** A Node error as the space reads it: its code, and the space's path instead of this machine's. */
function failure(error: unknown, virtual: string): CallError {
	if (error instanceof CallError) return error;
	const code = (error as { code?: string }).code;
	const syscall = (error as { syscall?: string }).syscall;
	const reasons: Record<string, string> = {
		ENOENT: "no such file or directory",
		EEXIST: "file already exists",
		ENOTDIR: "not a directory",
		EISDIR: "is a directory",
		ENOTEMPTY: "directory not empty",
		EACCES: "permission denied",
		EPERM: "operation not permitted",
	};
	if (code && reasons[code]) return new CallError(`${code}: ${reasons[code]}${syscall ? `, ${syscall}` : ""} '${virtual}'`, code);
	return new CallError(error instanceof Error ? error.message : String(error), code);
}

/** A glob as the tools read it: `*` within a segment, `**` across them, `?` one character. */
export function globPattern(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index]!;
		if (char === "*" && glob[index + 1] === "*") {
			index++;
			if (glob[index + 1] === "/") {
				index++;
				source += "(?:.*/)?";
			} else source += ".*";
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

function globs(value: unknown): RegExp[] {
	const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
	return list.map((glob) => globPattern(String(glob)));
}

/**
 * Everything under `folder`, depth first in name order, as paths relative to
 * it. Excluded paths are skipped with everything below them; links are listed
 * but not followed.
 */
async function* walk(folder: string, exclude: RegExp[], prefix = ""): AsyncGenerator<{ relative: string; local: string; directory: boolean }> {
	let entries;
	try {
		entries = await fs.readdir(folder, { withFileTypes: true });
	} catch (error) {
		if ((error as { code?: string }).code === "EACCES") return;
		throw error;
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (exclude.some((glob) => glob.test(rel))) continue;
		const full = path.join(folder, entry.name);
		yield { relative: rel, local: full, directory: entry.isDirectory() };
		if (entry.isDirectory()) yield* walk(full, exclude, rel);
	}
}

function page<T>(items: T[], args: { offset?: unknown; limit?: unknown }): T[] {
	const offset = Number(args.offset ?? 0);
	const limit = args.limit === undefined ? items.length : Number(args.limit);
	return items.slice(offset, offset + limit);
}

/** How much of a file decides whether it is text. */
const SNIFF_BYTES = 8192;
/** Files larger than this aren't searched. */
const MAX_GREP_FILE_BYTES = 10_000_000;

async function grepFile(file: string, matcher: RegExp, context: number): Promise<{ line: number; text: string; context?: { line: number; text: string; isMatch: boolean }[] }[]> {
	const stat = await fs.stat(file);
	if (stat.size > MAX_GREP_FILE_BYTES) return [];
	const bytes = await fs.readFile(file);
	if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return [];
	const lines = bytes.toString("utf8").split(/\r?\n/);
	const found = [];
	for (let index = 0; index < lines.length; index++) {
		matcher.lastIndex = 0;
		if (!matcher.test(lines[index]!)) continue;
		const match: { line: number; text: string; context?: { line: number; text: string; isMatch: boolean }[] } = { line: index + 1, text: lines[index]! };
		if (context > 0) {
			match.context = [];
			for (let near = Math.max(0, index - context); near <= Math.min(lines.length - 1, index + context); near++) {
				matcher.lastIndex = 0;
				match.context.push({ line: near + 1, text: lines[near]!, isMatch: matcher.test(lines[near]!) });
			}
		}
		found.push(match);
	}
	return found;
}

type Args = Record<string, unknown>;

/** Answers one of the space's calls. */
export async function handle(machine: Machine, op: string, args: Args): Promise<unknown> {
	const at = String(args.path ?? WORKSPACE);
	try {
		switch (op) {
			case "stat": {
				const file = await local(machine, args.path);
				const stat = await fs.stat(file);
				const link = await fs.lstat(file);
				return {
					name: path.basename(file),
					inode: stat.ino,
					mode: stat.mode,
					mtime: stat.mtimeMs,
					size: stat.size,
					isFile: stat.isFile(),
					isDirectory: stat.isDirectory(),
					isSymbolicLink: link.isSymbolicLink(),
				};
			}
			case "read": {
				const file = await local(machine, args.path);
				const offset = Number(args.offset ?? 0);
				const length = Math.min(Number(args.length ?? MAX_READ_BYTES), MAX_READ_BYTES);
				const handle = await fs.open(file, "r");
				try {
					const { size } = await handle.stat();
					const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
					const { bytesRead } = buffer.length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, buffer.length, offset);
					return { data: buffer.subarray(0, bytesRead).toString("base64"), size };
				} finally {
					await handle.close();
				}
			}
			case "write": {
				const file = await local(machine, args.path);
				const data = Buffer.from(String(args.data ?? ""), "base64");
				const mode = typeof args.mode === "number" ? args.mode & 0o777 : undefined;
				if (args.append === true) await fs.appendFile(file, data);
				else await fs.writeFile(file, data, mode === undefined ? {} : { mode });
				return null;
			}
			case "mkdir": {
				await fs.mkdir(await local(machine, args.path), { recursive: args.recursive === true });
				return null;
			}
			case "rm": {
				const file = await local(machine, args.path);
				if (file === machine.root) throw new CallError(`${WORKSPACE} itself can't be deleted`, "EPERM");
				await fs.rm(file, { recursive: args.recursive === true, force: args.force === true });
				return null;
			}
			case "rename": {
				const from = await local(machine, args.from);
				const to = await local(machine, args.to);
				await fs.rename(from, to);
				return null;
			}
			case "readdir": {
				const folder = await local(machine, args.path);
				const names = (await fs.readdir(folder)).sort();
				const entries = [];
				for (const name of page(names, args)) {
					const full = path.join(folder, name);
					const link = await fs.lstat(full);
					// A link's size and type are its target's, when it has one.
					const stat = link.isSymbolicLink() ? await fs.stat(full).catch(() => link) : link;
					entries.push({
						name,
						parentPath: virtualOf(machine, folder),
						size: stat.isDirectory() ? 0 : stat.size,
						mtime: stat.mtimeMs,
						isFile: stat.isFile(),
						isDirectory: stat.isDirectory(),
						isSymbolicLink: link.isSymbolicLink(),
					});
				}
				return entries;
			}
			case "find": {
				const folder = await local(machine, args.path ?? WORKSPACE);
				const pattern = globPattern(String(args.pattern ?? "**"));
				const found = [];
				const end = Number(args.offset ?? 0) + Number(args.limit ?? Number.POSITIVE_INFINITY);
				for await (const entry of walk(folder, globs(args.exclude))) {
					if (!pattern.test(entry.relative)) continue;
					found.push({ path: virtualOf(machine, entry.local), type: entry.directory ? "dir" : "file" });
					if (found.length >= end) break;
				}
				return page(found, args);
			}
			case "grep": {
				const target = await local(machine, args.path ?? WORKSPACE);
				const query = String(args.query ?? "");
				const flags = args.ignoreCase === true ? "i" : "";
				const matcher = args.regex === true ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
				const context = Math.min(Number(args.context ?? 0), 10);
				const include = args.include === undefined ? null : globs(args.include);
				const end = Number(args.offset ?? 0) + Number(args.limit ?? Number.POSITIVE_INFINITY);
				const files: string[] = [];
				if ((await fs.stat(target)).isDirectory()) {
					for await (const entry of walk(target, globs(args.exclude))) {
						if (entry.directory || (include && !include.some((glob) => glob.test(entry.relative)))) continue;
						files.push(entry.local);
					}
				} else files.push(target);
				const matches = [];
				for (const file of files) {
					for (const match of await grepFile(file, matcher, context).catch(() => [])) {
						matches.push({ path: virtualOf(machine, file), ...match });
					}
					if (matches.length >= end) break;
				}
				return page(matches, args);
			}
			case "exec": {
				if (typeof args.command !== "string" || args.command.trim() === "") throw new CallError("command must be a shell command", "EINVAL");
				const cwd = args.cwd === undefined ? machine.root : await local(machine, args.cwd);
				return await machine.exec(args as ExecArgs, cwd);
			}
			default:
				throw new CallError(`This computer doesn't know the call ${op}. Update pim-computer.`, "ENOSYS");
		}
	} catch (error) {
		throw failure(error, at);
	}
}

/** Keeps a stream's first and last `max / 2` bytes, and says whether it dropped any in between. */
class Output {
	readonly #half: number;
	#head = Buffer.alloc(0);
	#tail: Buffer[] = [];
	#tailBytes = 0;
	dropped = false;

	constructor(max: number) {
		this.#half = Math.floor(max / 2);
	}

	add(chunk: Buffer): void {
		if (this.#head.length < this.#half) {
			const room = this.#half - this.#head.length;
			this.#head = Buffer.concat([this.#head, chunk.subarray(0, room)]);
			chunk = chunk.subarray(room);
		}
		if (chunk.length === 0) return;
		this.#tail.push(chunk);
		this.#tailBytes += chunk.length;
		while (this.#tailBytes - (this.#tail[0]?.length ?? 0) >= this.#half) {
			this.#tailBytes -= this.#tail.shift()!.length;
			this.dropped = true;
		}
	}

	text(): string {
		let tail = Buffer.concat(this.#tail);
		if (tail.length > this.#half) {
			tail = tail.subarray(tail.length - this.#half);
			this.dropped = true;
		}
		const head = this.#head.toString("utf8");
		return this.dropped ? `${head}\n[… output cut …]\n${tail.toString("utf8")}` : head + tail.toString("utf8");
	}
}

/** Runs a command in a login shell, in its own process group, killed with it at the timeout. `$PIM_WORKSPACE` is the root. */
async function runCommand({ command, timeoutMs = 120_000, maxBytes = 64_000 }: ExecArgs, cwd: string, root: string): Promise<ExecResult> {
	const { spawn } = await import("node:child_process");
	const shell = process.env.SHELL || "/bin/bash";
	const child = spawn(shell, ["-lc", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PIM_WORKSPACE: root } });
	const stdout = new Output(maxBytes);
	const stderr = new Output(maxBytes);
	child.stdout!.on("data", (chunk: Buffer) => stdout.add(chunk));
	child.stderr!.on("data", (chunk: Buffer) => stderr.add(chunk));
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			process.kill(-child.pid!, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, timeoutMs);
	return new Promise((resolve) => {
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ exitCode: null, signal: null, stdout: "", stderr: error.message, timedOut: false, truncated: false });
		});
		child.on("close", (exitCode, signal) => {
			clearTimeout(timer);
			resolve({ exitCode, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut, truncated: stdout.dropped || stderr.dropped });
		});
	});
}

const USAGE = `pim-computer ${VERSION}: connects this machine to your Pim, for your agents to use.

  PIM_URL=https://pim.example.com PIM_COMPUTER_TOKEN=pimc_… node pim-computer.ts

Options (or the environment variables in brackets):
  --url <address>   Your Pim's address (PIM_URL)
  --token <token>   The token from Settings → Computer (PIM_COMPUTER_TOKEN, or a file named by PIM_COMPUTER_TOKEN_FILE)
  --root <folder>   The folder your files are kept in (PIM_COMPUTER_ROOT; ~/pim unless set)`;

async function main(): Promise<void> {
	const { parseArgs } = await import("node:util");
	const os = await import("node:os");
	const { values } = parseArgs({ options: { url: { type: "string" }, token: { type: "string" }, root: { type: "string" }, help: { type: "boolean" } } });
	const env = process.env;
	const tokenFile = env.PIM_COMPUTER_TOKEN_FILE;
	const url = values.url ?? env.PIM_URL;
	const token = values.token ?? env.PIM_COMPUTER_TOKEN ?? (tokenFile ? (await fs.readFile(tokenFile, "utf8")).trim() : undefined);
	if (values.help || !url || !token) {
		console.log(USAGE);
		process.exit(values.help ? 0 : 1);
	}
	const folder = path.resolve(values.root ?? env.PIM_COMPUTER_ROOT ?? path.join(os.homedir(), "pim"));
	await fs.mkdir(folder, { recursive: true });
	const root = await fs.realpath(folder);
	const machine: Machine = { root, exec: (args, cwd) => runCommand(args, cwd, root) };
	const address = new URL("/api/computer/connect", url.replace(/^http/, "ws"));
	const hello = {
		type: "hello",
		version: 1,
		agent: `pim-computer/${VERSION}`,
		hostname: os.hostname(),
		platform: os.platform(),
		arch: os.arch(),
		release: os.release(),
		user: os.userInfo().username,
		root: machine.root,
		shell: env.SHELL || "/bin/bash",
	};
	let wait = 1_000;
	const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
	const connect = () => {
		// Node's WebSocket (undici) takes headers, so the token stays out of the address.
		const socket = new (WebSocket as unknown as new (url: URL, init: unknown) => WebSocket)(address, { headers: { Authorization: `Bearer ${token}` } });
		let ping: ReturnType<typeof setInterval> | undefined;
		socket.addEventListener("open", () => {
			wait = 1_000;
			log(`Connected to ${url}, with ${machine.root} as ${WORKSPACE}.`);
			socket.send(JSON.stringify(hello));
			// The space answers "ping" without waking; it keeps the connection through proxies and NATs.
			ping = setInterval(() => socket.send("ping"), 30_000);
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string" || event.data === "pong") return;
			let call: { type?: string; id?: string; op?: string; args?: Args };
			try {
				call = JSON.parse(event.data);
			} catch {
				return;
			}
			if (call.type !== "call" || typeof call.id !== "string" || typeof call.op !== "string") return;
			if (call.op === "exec") log(`Running: ${String(call.args?.command)}`);
			const { id } = call;
			handle(machine, call.op, call.args ?? {}).then(
				(result) => socket.send(JSON.stringify({ type: "reply", id, result })),
				(error: CallError) => socket.send(JSON.stringify({ type: "reply", id, error: { message: error.message, code: error.code } })),
			);
		});
		socket.addEventListener("close", (event) => {
			clearInterval(ping);
			if (event.code === REPLACED) {
				log("Another computer connected with this token, so this one stops.");
				process.exit(1);
			}
			// A token Pim doesn't know is refused before the connection opens, which looks the same as being offline.
			log(`${ping ? "Disconnected" : "Couldn't connect"}${event.reason ? ` (${event.reason})` : ""}; trying again in ${wait / 1000} s.`);
			setTimeout(connect, wait);
			wait = Math.min(wait * 2, 60_000);
		});
		socket.addEventListener("error", () => {
			// "close" follows, and tries again.
		});
	};
	connect();
}

// Run as a program, not when tests import `handle`.
if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
