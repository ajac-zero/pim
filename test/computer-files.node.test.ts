// These run in Node, not in workerd, whose file system keeps no modes and no inodes.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { handle, type Machine } from "../computer/pim-computer";

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
