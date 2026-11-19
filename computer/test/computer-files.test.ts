// These run in Node, not in workerd, whose file system keeps no modes and no inodes.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handle, type Machine, newerProgram, supervision } from "../pim-computer";

let root: string;
let machine: Machine;

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pim-files-")));
	machine = { root, exec: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false }) };
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

const write = (target: string, text: string, extra: Record<string, unknown> = {}) => handle(machine, "write", { path: target, data: Buffer.from(text).toString("base64"), ...extra });

it("keeps a file's mode when it replaces it, with a new file in its place", async () => {
	await fs.writeFile(path.join(root, "run.sh"), "old", { mode: 0o750 });
	await fs.chmod(path.join(root, "run.sh"), 0o750);
	const before = (await fs.stat(path.join(root, "run.sh"))).ino;
	await write("/workspace/run.sh", "new");
	expect((await fs.stat(path.join(root, "run.sh"))).mode & 0o777).toBe(0o750);
	// Not a rewrite in place: a reader that has the old file open never sees a partial one.
	expect((await fs.stat(path.join(root, "run.sh"))).ino).not.toBe(before);
	// A new file takes the mode it is given.
	await write("/workspace/private.txt", "x", { mode: 0o600 });
	expect((await fs.stat(path.join(root, "private.txt"))).mode & 0o777).toBe(0o600);
});

it("leaves no temporary file when a conditional write is refused or fails", async () => {
	await fs.writeFile(path.join(root, "a.txt"), "one");
	await expect(write("/workspace/a.txt", "two", { expectedHash: "0".repeat(64) })).rejects.toMatchObject({ code: "conflict" });
	await fs.mkdir(path.join(root, "dir"));
	await expect(write("/workspace/dir", "x")).rejects.toMatchObject({ code: "EISDIR" });
	expect((await fs.readdir(root)).sort()).toEqual(["a.txt", "dir"]);
	expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("one");
});

it("restarts to update only for a program that is not the one running", async () => {
	const running = path.join(root, "pim-computer.ts");
	await fs.writeFile(running, "export const v = 1;\n");
	const serve = (body: string, status = 200) => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
	// A newer one, with the trailing slash of the address dropped.
	const newer = serve("export const v = 2;\n");
	expect(await newerProgram("https://pim.example/", running, newer)).toBe("export const v = 2;\n");
	expect(newer).toHaveBeenCalledWith("https://pim.example/pim-computer.ts", expect.anything());
	// The same one, so a restart would only come back here: no loop.
	expect(await newerProgram("https://pim.example", running, serve("export const v = 1;\n"))).toBeNull();
	// Not a program: a page, nothing, an error answer, or no answer.
	expect(await newerProgram("https://pim.example", running, serve("<!doctype html><title>Pim</title>"))).toBeNull();
	expect(await newerProgram("https://pim.example", running, serve(" \n"))).toBeNull();
	expect(await newerProgram("https://pim.example", running, serve("export const v = 2;", 502))).toBeNull();
	expect(await newerProgram("https://pim.example", running, vi.fn(async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).toBeNull();
});

it("exits to update only where something starts it again", () => {
	expect(supervision({ PIM_COMPUTER_TOKEN_FILE: "/t" }, 4242, false)).toBe("service");
	expect(supervision({}, 4242, true)).toBe("container");
	expect(supervision({}, 1, false)).toBe("container");
	// A terminal: it stays up, and tells the person to update.
	expect(supervision({}, 4242, false)).toBeNull();
});
