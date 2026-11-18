import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import S3rver from "s3rver";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGate } from "../src/gate.ts";
import { Canvas, LeaseLostError } from "../src/canvas.ts";
import { MemoryObjectStore, Objects, parseRange, S3ObjectStore } from "../src/objects.ts";
import type { ObjectStore } from "@pim/v2-contracts/platform";
import { fixture, member } from "./support/fixture.ts";
import type { Server } from "node:http";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 100 }, (_, i) => i)]);
const mp4 = new Uint8Array(1000).map((_, i) => i % 251);

let f: Awaited<ReturnType<typeof fixture>>;
let u: Awaited<ReturnType<typeof member>>;
let s3: S3rver;
let s3Store: S3ObjectStore;
beforeAll(async () => {
	f = await fixture();
	u = await member(f.app, f.admin.principal, "mia");
	const dir = mkdtempSync(join(tmpdir(), "pim-s3-"));
	const port = 41000 + Math.floor(Math.random() * 5000);
	s3 = new S3rver({ port, address: "127.0.0.1", silent: true, directory: dir, configureBuckets: [{ name: "pim", configs: [] }] });
	await s3.run();
	s3Store = new S3ObjectStore("pim", { endpoint: `http://127.0.0.1:${port}`, region: "us-east-1", credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } });
});
afterAll(async () => {
	await s3.close();
	await f.close();
});

describe("parseRange", () => {
	it("handles open, suffix, clamped and unsatisfiable ranges", () => {
		expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
		expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
		expect(parseRange("bytes=100-", 100)).toBeNull();
		expect(parseRange("bytes=9-5", 100)).toBeNull();
		expect(parseRange("items=1-2", 100)).toBe("whole");
	});
});

for (const [label, make] of [["memory store", () => f.store as ObjectStore], ["S3 protocol (s3rver)", () => s3Store as ObjectStore]] as const) {
	describe(`Objects over ${label}`, () => {
		it("serves 206 ranges for video, validates images by magic bytes, and enforces ACLs", async () => {
			const objects = new Objects(f.db, make());
			const video = await objects.put(u.principal, { bytes: mp4, contentType: "video/mp4", purpose: "media", acl: "public" });
			const whole = await objects.serve(null, video.key);
			expect([whole.status, whole.headers["accept-ranges"], whole.body.length]).toEqual([200, "bytes", 1000]);
			const part = await objects.serve(null, video.key, "bytes=100-199");
			expect(part).toMatchObject({ status: 206, headers: { "content-range": "bytes 100-199/1000", "content-length": "100", "content-type": "video/mp4" } });
			expect([...part.body]).toEqual([...mp4.slice(100, 200)]);
			expect([...(await objects.serve(null, video.key, "bytes=-5")).body]).toEqual([...mp4.slice(995)]);
			expect((await objects.serve(null, video.key, "bytes=2000-")).status).toBe(416);

			await expect(objects.put(u.principal, { bytes: new TextEncoder().encode("<script>alert(1)</script>"), contentType: "image/png", purpose: "image" })).rejects.toMatchObject({ status: 400 });
			const image = await objects.put(u.principal, { bytes: png, contentType: "text/html", purpose: "image" });
			expect(image.contentType).toBe("image/png"); // the bytes decide, not the claim

			// Private objects answer only to their owner, and look absent to others.
			expect((await objects.serve(u.principal, image.key)).status).toBe(200);
			await expect(objects.serve(null, image.key)).rejects.toMatchObject({ status: 404 });
			const other = await member(f.app, f.admin.principal, `other-${label.length}`);
			await expect(objects.serve(other.principal, image.key)).rejects.toMatchObject({ status: 404 });
			await expect(objects.put(other.principal, { bytes: png, contentType: "image/png", purpose: "image", key: image.key })).rejects.toMatchObject({ status: 400 });
		});

		it("stops serving a deleted author's public object (410), and a suspended author's only when the instance hides it", async () => {
			const author = await member(f.app, f.admin.principal, `auth-${label.length}`);
			const o = new Objects(f.db, make());
			const hiding = new Objects(f.db, make(), { hideSuspended: true });
			const { key } = await o.put(author.principal, { bytes: png, contentType: "image/png", purpose: "image", acl: "public" });
			await f.app.identity.setStatus(f.admin.principal, author.account.ownerId, "suspended");
			expect((await o.serve(null, key)).status).toBe(200);
			await expect(hiding.serve(null, key)).rejects.toMatchObject({ status: 404 });
			await f.app.identity.setStatus(f.admin.principal, author.account.ownerId, "deleted");
			await expect(o.serve(null, key)).rejects.toMatchObject({ status: 410 });
		});
	});
}

describe("Canvas", () => {
	it("keeps live typing when an agent edits at the current version, and refuses an edit based on a stale one", async () => {
		const canvas = new Canvas(f.db, f.store);
		const note = await canvas.create(u.principal, "plan", "Hello world");
		let { text, version } = await canvas.read(u.account.ownerId, note);
		expect([text, version]).toEqual(["Hello world", 1]);

		// A person types at the end in a live editor holding a copy of the document.
		const editor = new Y.Doc();
		Y.applyUpdate(editor, (await canvas.state(u.account.ownerId, note)).update);
		const typed: Uint8Array[] = [];
		editor.on("update", (up: Uint8Array) => typed.push(up));
		editor.getText("markdown").insert(11, "!!!");
		await canvas.applyLive(u.account.ownerId, note, "ada", typed[0]!);

		// The agent read version 1, so its edit is stale: the person's typing is not overwritten, the agent is told to read again.
		await expect(canvas.edit(u.principal, note, 1, "world", "there")).rejects.toMatchObject({ code: "version_conflict" });
		({ text, version } = await canvas.read(u.account.ownerId, note));
		expect([text, version]).toEqual(["Hello world!!!", 2]);

		// Reading again, the edit applies on top, and the person's live editor merges it without losing what was typed meanwhile.
		const before = typed.length;
		editor.getText("markdown").insert(0, ">> ");
		expect(await canvas.edit(u.principal, note, 2, "world", "there")).toEqual({ version: 3 });
		await canvas.applyLive(u.account.ownerId, note, "ada", typed[before]!);
		Y.applyUpdate(editor, (await canvas.state(u.account.ownerId, note)).update);
		const merged = (await canvas.read(u.account.ownerId, note)).text;
		expect(merged).toBe(">> Hello there!!!");
		expect(editor.getText("markdown").toString()).toBe(merged);
		await expect(canvas.edit(u.principal, note, 4, "absent", "x")).rejects.toMatchObject({ code: "text_not_found" });
	});

	it("races a live edit against note_edit on one version: exactly one wins, and nothing is lost", async () => {
		const canvas = new Canvas(f.db, f.store);
		const note = await canvas.create(u.principal, "race", "abc");
		const editor = new Y.Doc();
		Y.applyUpdate(editor, (await canvas.state(u.account.ownerId, note)).update);
		const ups: Uint8Array[] = [];
		editor.on("update", (up: Uint8Array) => ups.push(up));
		editor.getText("markdown").insert(3, "-typed");
		const [live, edit] = await Promise.allSettled([canvas.applyLive(u.account.ownerId, note, "ada", ups[0]!), canvas.edit(u.principal, note, 1, "abc", "ABC")]);
		const { text, version } = await canvas.read(u.account.ownerId, note);
		expect(live.status).toBe("fulfilled"); // typing always lands
		if (edit.status === "fulfilled") expect(text).toContain("ABC");
		else expect(edit.reason).toMatchObject({ code: "version_conflict" });
		expect(text).toContain("-typed");
		expect(version).toBe(2);
	});

	it("keeps versions at pauses and around agent changes, not one per update", async () => {
		const canvas = new Canvas(f.db, f.store);
		const owner = u.account.ownerId;
		const note = await canvas.create(u.principal, "kept", "Hello");
		const editor = new Y.Doc();
		Y.applyUpdate(editor, (await canvas.state(owner, note)).update);
		const typed: Uint8Array[] = [];
		editor.on("update", (up: Uint8Array) => typed.push(up));
		for (const ch of " there") editor.getText("markdown").insert(editor.getText("markdown").length, ch);
		for (const up of typed) await canvas.applyLive(owner, note, "ada", up);
		// Six updates are still one kept version, until the person pauses.
		expect(await canvas.read(owner, note)).toEqual({ text: "Hello there", version: 1 });
		expect(await canvas.keep(owner, note, "person")).toBe(2);
		expect(await canvas.keep(owner, note, "person")).toBe(2);
		// An agent change is kept before and after: the person's text stays readable as it was.
		expect(await canvas.edit(u.principal, note, 2, "there", "world")).toEqual({ version: 3 });
		expect((await canvas.versions(owner, note)).map((v) => [v.version, v.source, v.text])).toEqual([[3, "agent", "Hello world"], [2, "person", "Hello there"], [1, "person", "Hello"]]);
		// Restoring an old version is a new version, and the text it replaced is kept.
		expect(await canvas.restore(u.principal, note, 1)).toEqual({ version: 4 });
		expect((await canvas.versions(owner, note))[0]).toMatchObject({ version: 4, source: "restore", restoredFrom: 1, text: "Hello" });
		expect((await canvas.read(owner, note)).text).toBe("Hello");
	});

	it("keeps a note made before versions as version 1 the first time it is read", async () => {
		const canvas = new Canvas(f.db, f.store);
		const note = await canvas.create(u.principal, "old", "Old text");
		await f.db.owner(u.account.ownerId, async (tx) => {
			await tx.query("DELETE FROM pim_app.note_versions WHERE note_id = $1", [note]);
			await tx.query("UPDATE pim_app.notes SET kept_version = 0, version = 280 WHERE note_id = $1", [note]);
		});
		expect(await canvas.read(u.account.ownerId, note)).toEqual({ text: "Old text", version: 1 });
	});

	it("fences a writer whose lease was taken over", async () => {
		const a = new Canvas(f.db, f.store, "canvas-a");
		const b = new Canvas(f.db, f.store, "canvas-b");
		const note = await a.create(u.principal, "fence", "x");
		const stale = await a.acquire(u.account.ownerId, note, "canvas-a");
		await expect(b.acquire(u.account.ownerId, note, "canvas-b")).rejects.toMatchObject({ code: "lease_held" });
		const later = new Date(Date.now() + 60_000);
		const taken = await b.acquire(u.account.ownerId, note, "canvas-b", later);
		expect(taken.fence).toBe(stale.fence + 1);
		const doc = new Y.Doc();
		doc.getText("markdown").insert(0, "zombie");
		await expect(a.append(u.account.ownerId, stale, Y.encodeStateAsUpdate(doc), "user:a")).rejects.toBeInstanceOf(LeaseLostError);
		expect((await b.read(u.account.ownerId, note)).text).toBe("x");
	});

	it("compacts the log into an object-store snapshot and reads the same text", async () => {
		const canvas = new Canvas(f.db, s3Store);
		const note = await canvas.create(u.principal, "snap", "one");
		for (const word of ["two", "three"]) {
			const { text, version } = await canvas.read(u.account.ownerId, note);
			await canvas.edit(u.principal, note, version, text, `${text} ${word}`);
		}
		await canvas.compact(u.account.ownerId, note);
		const left = await f.db.owner(u.account.ownerId, async (tx) => (await tx.query("SELECT count(*)::int AS n FROM pim_app.note_updates WHERE note_id = $1", [note])).rows[0].n);
		expect(left).toBe(0);
		expect((await canvas.read(u.account.ownerId, note)).text).toBe("one two three");
		const [{ updates }] = [{ updates: await canvas.applyLive(u.account.ownerId, note, "ada", (() => { const d = new Y.Doc(); d.getText("markdown").insert(0, "x"); return Y.encodeStateAsUpdate(d); })()) }];
		expect(updates).toBe(4);
	});
});

describe("Gate over HTTP", () => {
	let server: Server;
	let base: string;
	beforeAll(async () => {
		server = createGate(f.app);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	afterAll(() => new Promise<void>((r) => server.close(() => r())));

	const call = (path: string, init: RequestInit & { token?: string } = {}) =>
		fetch(base + path, { ...init, headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), "content-type": "application/json", ...(init.headers as object) } });

	it("answers health without blocking, and rejects unauthenticated and malformed calls with typed errors", async () => {
		expect((await call("/health")).status).toBe(200);
		expect((await call("/health/ready")).status).toBe(200);
		expect((await call("/api/account")).status).toBe(401);
		expect((await call("/api/nope", { token: "x" })).status).toBe(404);
		const bad = await call("/auth/register", { method: "POST", body: "{" });
		expect(bad.status).toBe(400);
	});

	it("registers, admits chat commands idempotently and immediately, serves ranges, and signs out server-side", async () => {
		await f.app.identity.setRegistrationOpen(f.admin.principal, true);
		const reg = await call("/auth/register", { method: "POST", body: JSON.stringify({ username: "gateuser" }) });
		expect(reg.status).toBe(201);
		const cookie = reg.headers.get("set-cookie")!.split(";")[0]!;
		const asCookie = { headers: { cookie } };
		const chat = (await (await call("/api/sessions", { method: "POST", body: JSON.stringify({ title: "t" }), ...asCookie })).json()) as { id: string };
		const t0 = Date.now();
		const body = JSON.stringify({ commandId: "gate-1", text: "hello" });
		const first = await call(`/api/sessions/${chat.id}/messages`, { method: "POST", body, ...asCookie });
		const second = await call(`/api/sessions/${chat.id}/messages`, { method: "POST", body, ...asCookie });
		expect([first.status, second.status]).toEqual([202, 200]);
		expect(Date.now() - t0).toBeLessThan(2000); // no runner, model or bus is running, and none is waited for
		const pending = (await (await call(`/api/sessions/${chat.id}/pending`, asCookie)).json()) as { commands: { commandId: string; inboxAccepted: boolean }[] };
		expect(pending.commands).toMatchObject([{ commandId: "gate-1", inboxAccepted: true }]);

		const upload = await call("/api/images", { method: "POST", body: png, headers: { "content-type": "image/png", cookie } });
		const { key } = (await upload.json()) as { key: string };
		const ranged = await call(`/api/images/${key}`, { headers: { range: "bytes=0-7", cookie } });
		expect(ranged.status).toBe(206);
		expect(ranged.headers.get("content-range")).toBe(`bytes 0-7/${png.length}`);
		expect((await call(`/api/images/${key}`)).status).toBe(404); // private, anonymous

		// A cookie request from another site is refused; the bearer form is not subject to that.
		expect((await call("/api/sessions", { method: "POST", body: "{}", headers: { cookie, origin: "https://evil.example" } })).status).toBe(403);
		expect((await call("/auth/sign-out", { method: "POST", ...asCookie })).status).toBe(200);
		expect((await call("/api/account", asCookie)).status).toBe(401); // the copied cookie is dead
	});

	it("keeps ordinary chat, notes, goals and memories working with no computer, coding pool or connector", async () => {
		const token = await f.app.identity.createSession(u.account.ownerId);
		const note = (await (await call("/api/notes", { method: "POST", token, body: JSON.stringify({ title: "n", text: "hi" }) })).json()) as { id: string };
		expect(((await (await call(`/api/notes/${note.id}`, { token })).json()) as { text: string }).text).toBe("hi");
		expect((await call("/api/goals", { method: "POST", token, body: JSON.stringify({ title: "g", steps: ["a"] }) })).status).toBe(201);
		expect((await call("/api/memory/log", { method: "POST", token, body: JSON.stringify({ title: "m", body: "b" }) })).status).toBe(201);
		// Dependent tools say what is missing; nothing else is affected.
		expect(() => f.app.relay.require(u.account.ownerId, "desktop_screenshot")).toThrowError(expect.objectContaining({ name: "CapabilityUnavailableError" }));
		const guest = await member(f.app, f.admin.principal, "guest1");
		await f.app.identity.setRole(f.admin.principal, guest.account.ownerId, "guest");
		await expect(f.app.relay.pair(guest.principal, "x", 2)).rejects.toMatchObject({ reason: "guest" }); // a guest cannot pair a computer
	});
});
