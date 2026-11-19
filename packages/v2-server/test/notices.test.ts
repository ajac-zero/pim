// What an open app hears of at once: PostgreSQL announces the rows that change (approvals, notifications, settings, visits) whichever process wrote them, the Gate's bridge tells
// Pulse, and a socket that asks to watch a file hears of its changes. Over a real PostgreSQL with every migration; Pulse is in memory.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@pim/v2-app/app";
import { connect } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { FileEvent } from "@pim/v2-app/relay";
import { MemoryPulse, type Notice } from "@pim/v2-live/server/pulse";
import { serveSays } from "../src/live-says.ts";
import { startNoticeBridge } from "../src/notice-bridge.ts";
import { createStack, type Stack } from "./support/stack.ts";

let stack: Stack;
let app: App;
let pulse: MemoryPulse;
let ada: string;
let bob: string;
let stopBridge: () => Promise<void>;
const heard: Record<string, Notice[]> = {};

const until = async <T>(what: string, look: () => T | undefined | false, ms = 5_000): Promise<T> => {
	const end = Date.now() + ms;
	for (;;) {
		const found = look();
		if (found) return found;
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};
const notices = (owner: string, kind: string) => (heard[owner] ?? []).filter((n) => n.kind === kind);

beforeAll(async () => {
	stack = await createStack();
	app = new App(connect(stack.url("gate"), 4), new MemoryObjectStore());
	pulse = new MemoryPulse();
	const a = await app.identity.register({ username: "ada", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000) });
	await app.identity.setRegistrationOpen({ kind: "user", ownerId: a.ownerId, role: "admin", sessionId: "s" }, true);
	const b = await app.identity.register({ username: "bob" });
	[ada, bob] = [a.ownerId, b.ownerId];
	for (const owner of [ada, bob]) pulse.subscribeNotices(owner, (notice) => (heard[owner] ??= []).push(notice));
	stopBridge = startNoticeBridge(app, pulse, stack.url("gate"));
	// The listener connects in the background: a first change made before it is listening would be missed, as it would in a deployment (the app reloads on reconnect).
	await new Promise((resolve) => setTimeout(resolve, 300));
});
afterAll(async () => {
	await stopBridge?.();
	await app?.db.end();
	await stack?.drop();
});

describe("what changed in a person's space, told to their open apps", () => {
	it("tells of an approval filed and decided, with what the app reads of it, and only its owner", async () => {
		await app.db.owner(ada, (tx) => tx.query("INSERT INTO pim_app.approvals (id, owner_id, public_chat_id, tool, args, timeout_policy, expires_at) VALUES ('ap-1',$1,NULL,'http_request','{\"summary\":\"GET x\"}','deny', now() + interval '1 hour')", [ada]));
		const filed = await until("the approval", () => notices(ada, "approval")[0]);
		expect(filed.data).toMatchObject({ id: "ap-1", action: "http_request", status: "pending" });
		await app.db.owner(ada, (tx) => tx.query("UPDATE pim_app.approvals SET state = 'approved', decided_by = 'user', decided_at = now() WHERE id = 'ap-1'"));
		await until("its decision", () => notices(ada, "approval").length === 2);
		expect(notices(ada, "approval")[1]!.data).toMatchObject({ id: "ap-1", status: "approved" });
		expect(notices(bob, "approval")).toEqual([]);
	});

	it("tells of a notification, with its title and body for a toast", async () => {
		await app.db.owner(ada, (tx) => tx.query("INSERT INTO pim_app.notifications (id, owner_id, kind, title, body) VALUES ('n-1',$1,'general','Reminder','Water the plants')", [ada]));
		const made = await until("the notification", () => notices(ada, "notification")[0]);
		expect(made.data).toMatchObject({ id: "n-1", kind: "general", title: "Reminder", body: "Water the plants", session: null });
	});

	it("tells of a changed setting, but not of the model's or the majordomo's bookkeeping, and of a visit", async () => {
		await app.db.owner(bob, (tx) => tx.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1,'majordomo_chat','\"x\"')", [bob]));
		await app.db.owner(bob, (tx) => tx.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1,'settings.colorMode','\"dark\"')", [bob]));
		await until("the setting", () => notices(bob, "settings").length === 1);
		await app.db.owner(bob, (tx) => tx.query("INSERT INTO pim_app.visits (id, owner_id, visitor) VALUES ('v1',$1,$2)", [bob, ada]));
		await until("the visit", () => notices(bob, "visits").length === 1);
		expect(notices(bob, "settings")).toHaveLength(1);
		expect(notices(ada, "settings")).toEqual([]);
	});
});

describe("watching a file over the Live socket", () => {
	it("holds a file for as long as a socket does, tells of its changes, and lets go with the socket", async () => {
		const watched: string[] = [];
		const unwatched: string[] = [];
		let listener: ((event: FileEvent) => void) | undefined;
		(app.relay as unknown as { acquire: unknown }).acquire = async () => ({
			onFileEvent: (l: (event: FileEvent) => void) => ((listener = l), () => (listener = undefined)),
			watch: async (path: string) => (watched.push(path), { watching: true, exists: true, sha256: "abc", size: 3 }),
			unwatch: async (path: string) => (unwatched.push(path), true),
		});
		const stop = serveSays(app, pulse);
		try {
			await pulse.publishSay(ada, { kind: "watch_file", data: { path: "/workspace/notes/a.md" }, connection: "c1" });
			await pulse.publishSay(ada, { kind: "watch_file", data: { path: "/etc/passwd" }, connection: "c1" }); // not one of the person's files
			const first = await until("the file as it is", () => notices(ada, "file_changed")[0]);
			expect(first.data).toEqual({ path: "/workspace/notes/a.md", kind: "modified", sha256: "abc", size: 3 });
			expect(watched).toEqual(["/workspace/notes/a.md"]);
			// An agent changes it: the socket's app hears.
			listener!({ event: "file_changed", path: "/workspace/notes/a.md", kind: "modified", sha256: "def", size: 4, mtime: 1 } as FileEvent);
			await until("the change", () => notices(ada, "file_changed").length === 2);
			expect(notices(ada, "file_changed")[1]!.data).toEqual({ path: "/workspace/notes/a.md", kind: "modified", sha256: "def", size: 4 });
			// The socket ends: what it held goes.
			await pulse.publishSay(ada, { kind: "closed", connection: "c1" });
			await until("the computer to stop watching", () => unwatched.length === 1);
			expect(unwatched).toEqual(["/workspace/notes/a.md"]);
		} finally {
			stop();
		}
	});
});
