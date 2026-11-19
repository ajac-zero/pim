// These run in Node, not in workerd: they watch a real folder.
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FSWatcher } from "node:fs";
import { Link, MAX_WATCHES, type Machine, WATCH_DEBOUNCE_MS } from "../pim-computer";

const fake = vi.hoisted(() => ({ failStat: false, mute: false, watchers: [] as unknown[], listeners: [] as ((event: string, name: string) => void)[] }));
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return {
		...actual,
		statSync: ((...args: Parameters<typeof actual.statSync>) => {
			if (fake.failStat) throw Object.assign(new Error("gone"), { code: "EIO" });
			return actual.statSync(...args);
		}) as typeof actual.statSync,
		watch: ((...args: unknown[]) => {
			// The folder's listener is kept so a test can tell it of a change itself, and the file system's own notifications can be muted meanwhile.
			const at = args.findIndex((arg) => typeof arg === "function");
			const listener = args[at] as (event: string, name: string) => void;
			fake.listeners.push(listener);
			args[at] = (event: string, name: string) => void (fake.mute || listener(event, name));
			const watcher = (actual.watch as (...args: unknown[]) => FSWatcher)(...args);
			vi.spyOn(watcher, "close");
			fake.watchers.push(watcher);
			return watcher;
		}) as typeof actual.watch,
	};
});

let root: string;
let link: Link;
let messages: Record<string, unknown>[];
let next = 0;

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pim-watch-")));
	const machine: Machine = { root, exec: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false }) };
	messages = [];
	link = new Link(machine, (message) => void messages.push(JSON.parse(String(message))));
});
afterEach(async () => {
	fake.mute = false;
	vi.useRealTimers();
	link.close();
	await fs.rm(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const events = () => messages.filter((message) => message.type === "event");

/** Calls the Link as the space does and returns its result, or the error it replied with. */
async function call(op: string, args: Record<string, unknown>): Promise<any> {
	const id = `c${++next}`;
	link.receive(JSON.stringify({ type: "call", id, op, args }));
	await vi.waitFor(() => expect(messages.some((message) => message.id === id)).toBe(true));
	const reply = messages.find((message) => message.id === id)!;
	if (reply.error) throw Object.assign(new Error(String((reply.error as { message: string }).message)), reply.error);
	return reply.result;
}

const eventsOf = async (count: number) => {
	await vi.waitFor(() => expect(events().length).toBeGreaterThanOrEqual(count), { timeout: 3000 });
	return events();
};

it("reports a file created, changed, replaced by a rename and deleted by another process", async () => {
	expect(await call("watch", { path: "/workspace/a.ts" })).toEqual({ watching: true, sha256: null, size: null, exists: false });
	await fs.writeFile(path.join(root, "a.ts"), "one");
	expect((await eventsOf(1))[0]).toMatchObject({ type: "event", event: "file_changed", path: "/workspace/a.ts", kind: "created", sha256: hash("one"), size: 3 });
	await fs.writeFile(path.join(root, "a.ts"), "two!");
	expect((await eventsOf(2))[1]).toMatchObject({ kind: "modified", sha256: hash("two!"), size: 4 });
	// A temp file renamed over it, as an atomic write does: the file's inode is replaced.
	await fs.writeFile(path.join(root, ".a.ts.tmp"), "three");
	await fs.rename(path.join(root, ".a.ts.tmp"), path.join(root, "a.ts"));
	expect((await eventsOf(3))[2]).toMatchObject({ kind: "renamed", sha256: hash("three") });
	await fs.rm(path.join(root, "a.ts"));
	expect((await eventsOf(4))[3]).toMatchObject({ kind: "deleted", sha256: null, size: null, mtime: null });
	// Gone and made again is seen, too.
	await fs.writeFile(path.join(root, "a.ts"), "four");
	expect((await eventsOf(5))[4]).toMatchObject({ kind: "created", sha256: hash("four") });
	expect(events()).toHaveLength(5);
});

it("reports a file that exists when it is watched, with its hash", async () => {
	await fs.writeFile(path.join(root, "b.txt"), "hello");
	expect(await call("watch", { path: "/workspace/b.txt" })).toEqual({ watching: true, sha256: hash("hello"), size: 5, exists: true });
	// The same bytes written again are not a change.
	await fs.writeFile(path.join(root, "b.txt"), "hello");
	await sleep(400);
	expect(events()).toEqual([]);
});

it("reports a burst of writes as one event, with the final state, after the debounce", async () => {
	const file = path.join(root, "c.txt");
	await fs.writeFile(file, "0");
	await call("watch", { path: "/workspace/c.txt" });
	// The file system tells the folder's listener of a change when it likes, which would race the fake clock: the burst is told to it by hand instead.
	fake.mute = true;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const changed = fake.listeners.at(-1)!;
	// The Link checks a file after the debounce, reading it from disk. Asking to watch the file again is answered once every check before it is done, on the real clock, which the fake one doesn't move.
	const checked = async () => {
		const id = `c${++next}`;
		link.receive(JSON.stringify({ type: "call", id, op: "watch", args: { path: "/workspace/c.txt" } }));
		while (!messages.some((message) => message.id === id)) await new Promise((resolve) => setImmediate(resolve));
	};
	for (const text of ["1", "22", "333", "4444"]) {
		await fs.writeFile(file, text);
		changed("change", "c.txt");
		// Each write comes inside the debounce of the one before it, though the burst as a whole outlasts it.
		await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS - 1);
		await checked();
		expect(events()).toEqual([]);
	}
	await vi.advanceTimersByTimeAsync(1);
	await checked();
	expect(events()).toHaveLength(1);
	expect(events()[0]).toMatchObject({ kind: "modified", sha256: hash("4444"), size: 4 });
});

it("does not report what this computer's own write op wrote, but reports the next outside change", async () => {
	await fs.writeFile(path.join(root, "d.txt"), "old");
	await call("watch", { path: "/workspace/d.txt" });
	await call("write", { path: "/workspace/d.txt", data: Buffer.from("mine").toString("base64") });
	await sleep(500);
	expect(events()).toEqual([]);
	await fs.writeFile(path.join(root, "d.txt"), "theirs");
	expect((await eventsOf(1))[0]).toMatchObject({ kind: "modified", sha256: hash("theirs") });
});

it("counts watches: one unwatch of two keeps watching, the last closes the watcher", async () => {
	await call("watch", { path: "/workspace/e.txt" });
	await call("watch", { path: "/workspace/e.txt" });
	expect(await call("unwatch", { path: "/workspace/e.txt" })).toEqual({ watching: true });
	await fs.writeFile(path.join(root, "e.txt"), "x");
	await eventsOf(1);
	expect(await call("unwatch", { path: "/workspace/e.txt" })).toEqual({ watching: false });
	await fs.writeFile(path.join(root, "e.txt"), "y");
	await sleep(400);
	expect(events()).toHaveLength(1);
	// Unwatching what isn't watched is nothing.
	expect(await call("unwatch", { path: "/workspace/e.txt" })).toEqual({ watching: false });
	expect(await call("unwatch", { path: "/workspace/../nowhere" })).toEqual({ watching: false });
	// It can be watched again after.
	await call("watch", { path: "/workspace/e.txt" });
	await fs.writeFile(path.join(root, "e.txt"), "z");
	await eventsOf(2);
});

it("refuses paths outside the folder, and directories", async () => {
	await expect(call("watch", { path: "/workspace/../etc/passwd" })).rejects.toMatchObject({ code: "EACCES" });
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pim-outside-"));
	try {
		await fs.symlink(outside, path.join(root, "out"));
		await expect(call("watch", { path: "/workspace/out/x.txt" })).rejects.toMatchObject({ code: "EACCES" });
		await fs.writeFile(path.join(outside, "f"), "secret");
		await fs.symlink(path.join(outside, "f"), path.join(root, "link"));
		await expect(call("watch", { path: "/workspace/link" })).rejects.toMatchObject({ code: "EACCES" });
	} finally {
		await fs.rm(outside, { recursive: true, force: true });
	}
	await fs.mkdir(path.join(root, "dir"));
	await expect(call("watch", { path: "/workspace/dir" })).rejects.toMatchObject({ code: "EISDIR" });
	await expect(call("watch", { path: "/workspace/nodir/x.txt" })).rejects.toMatchObject({ code: "ENOENT" });
});

it("stops at the most files it may watch, counting a file once however often it is asked for", async () => {
	for (let index = 0; index < MAX_WATCHES; index++) await call("watch", { path: `/workspace/f${index}` });
	await call("watch", { path: "/workspace/f0" });
	await expect(call("watch", { path: "/workspace/one-too-many" })).rejects.toMatchObject({ code: "EWATCHLIMIT" });
	await call("unwatch", { path: "/workspace/f1" });
	await call("watch", { path: "/workspace/one-too-many" });
});

it("releases every watch when the link closes", async () => {
	await call("watch", { path: "/workspace/g.txt" });
	link.close();
	await fs.writeFile(path.join(root, "g.txt"), "x");
	await sleep(400);
	expect(events()).toEqual([]);
});

it("keeps watching a file after its folder is deleted and made again", async () => {
	await fs.mkdir(path.join(root, "d"));
	await fs.writeFile(path.join(root, "d", "f.txt"), "one");
	await call("watch", { path: "/workspace/d/f.txt" });
	await fs.rm(path.join(root, "d"), { recursive: true });
	await fs.mkdir(path.join(root, "d"));
	await sleep(400);
	expect(events().filter((event) => event.event === "watch_error")).toEqual([]);
	await fs.writeFile(path.join(root, "d", "f.txt"), "two");
	await vi.waitFor(() => expect(events().find((event) => event.kind === "created")).toMatchObject({ event: "file_changed", sha256: hash("two") }), { timeout: 3000 });
});

it("says watch_error once, and lets go, when the folder is gone for good", async () => {
	await fs.mkdir(path.join(root, "g"));
	await call("watch", { path: "/workspace/g/f.txt" });
	await fs.rm(path.join(root, "g"), { recursive: true });
	await vi.waitFor(() => expect(events().filter((event) => event.event === "watch_error")).toHaveLength(1), { timeout: 3000 });
	expect(events().find((event) => event.event === "watch_error")).toMatchObject({ path: "/workspace/g/f.txt", code: "ENOENT" });
	await sleep(300);
	expect(events().filter((event) => event.event === "watch_error")).toHaveLength(1);
	// The space can watch again once the folder is back.
	await fs.mkdir(path.join(root, "g"));
	await call("watch", { path: "/workspace/g/f.txt" });
});

it("shares a folder's watcher, and keeps it until the last file in it is let go", async () => {
	await call("watch", { path: "/workspace/s1" });
	await call("watch", { path: "/workspace/s2" });
	await call("unwatch", { path: "/workspace/s1" });
	await fs.writeFile(path.join(root, "s2"), "x");
	await eventsOf(1);
	expect(events()[0]).toMatchObject({ path: "/workspace/s2", kind: "created" });
	await fs.writeFile(path.join(root, "s1"), "x");
	await sleep(400);
	expect(events()).toHaveLength(1);
});

it("tells our own write followed by a change from outside apart from a rename", async () => {
	await call("watch", { path: "/workspace/w.txt" });
	await call("write", { path: "/workspace/w.txt", data: Buffer.from("mine").toString("base64") });
	await sleep(400);
	expect(events()).toEqual([]);
	await fs.writeFile(path.join(root, "w.txt"), "theirs");
	expect((await eventsOf(1))[0]).toMatchObject({ kind: "modified", sha256: hash("theirs") });
});

it("lets go of every watch on unwatch_all", async () => {
	await call("watch", { path: "/workspace/u.txt" });
	await call("unwatch_all", {});
	await fs.writeFile(path.join(root, "u.txt"), "x");
	await sleep(400);
	expect(events()).toEqual([]);
});

it("closes a watcher it couldn't finish setting up, and leaves no error unhandled", async () => {
	fake.failStat = true;
	try {
		await expect(call("watch", { path: "/workspace/x.txt" })).rejects.toMatchObject({ code: "EIO" });
	} finally {
		fake.failStat = false;
	}
	const watcher = fake.watchers.at(-1) as FSWatcher;
	expect(watcher.close).toHaveBeenCalled();
	// A late error from it has a listener, so it doesn't crash the process.
	expect(() => watcher.emit("error", new Error("late"))).not.toThrow();
	// And nothing is left registered: the file can be watched afterwards.
	await call("watch", { path: "/workspace/x.txt" });
});
