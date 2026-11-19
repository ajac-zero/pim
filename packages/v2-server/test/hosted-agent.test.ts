// Apps with a backend, end to end on the real `computer/pim-computer.ts` daemon: an agent deploys a folder of the person's files with `app_deploy` once the person approves it, the backend
// runs on the computer from a copy of the folder (a binary file byte for byte), the `/hosted/...` address reaches it through the relay, and the person's own routes and the agent's `app_logs`
// and `app_stop` see it and stop it. Nothing is run before the approval.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { computerAppId } from "@pim/v2-app/hosted-run";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats, sentAndAnswered } from "./support/stack.ts";

const real = describeWith(hasNats());
const COMPUTER = fileURLToPath(new URL("../../../computer/pim-computer.ts", import.meta.url));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

real("an app with a backend, deployed by an agent", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let web: Client;
	let app: App;
	let ownerId: string;
	let chatId: string;
	let n = 0;
	let daemon: ChildProcess | undefined;
	let home: string;
	let root: string;
	let appId: string;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	const transcript = async () => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_app.conversations WHERE public_chat_id = $1", [chatId])).rows[0];
		return JSON.stringify(await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id)));
	};
	const results = async (tool: string) =>
		(JSON.parse(await transcript()) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === tool).map((m) => m.content.map((c) => c.text ?? "").join("")));
	const ask = async (words: string, ...script: unknown[]) => {
		faux.setResponses([...script, toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` })), fauxAssistantMessage(`ended ${n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		const mine = n;
		return () => waitFor(`the turn "${words}" to end`, async () => (sentAndAnswered(await transcript(), `done ${mine}`) ? true : undefined), 90_000);
	};
	const connected = (online: boolean) => waitFor(`the computer to be ${online ? "online" : "offline"}`, async () => ((await web.call("GET", "/api/computer")).json.state === (online ? "online" : "offline") ? true : undefined), 30_000);
	const backend = () => web.call("GET", `/api/artifacts/${appId}/backend`);
	const settled = (state: string) => waitFor(`the backend to be ${state}`, async () => ((await backend()).json.status?.state === state ? true : undefined), 30_000);

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "pim-hosted-home-"));
		root = join(home, "files");
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate");
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		chatId = (await web.call("POST", "/api/sessions", { title: "Work" })).json.id;
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate") });
		const token = (await web.call("POST", "/api/computer", {})).json.token as string;
		daemon = spawn(process.execPath, [COMPUTER, "--url", `http://127.0.0.1:${d.gatePort}`, "--token", token, "--root", root], { stdio: process.env.PIM_TEST_DAEMON_LOG ? "inherit" : "ignore", env: { ...process.env, HOME: home } });
		await connected(true);
		mkdirSync(join(root, "site/images"), { recursive: true });
		writeFileSync(join(root, "site/pim.app.json"), JSON.stringify({ backend: { command: "node server.js" } }));
		writeFileSync(join(root, "site/server.js"), `require("http").createServer((req, res) => res.end("hello from the backend " + req.url + " v" + require("fs").readFileSync(__dirname + "/version.txt", "utf8"))).listen(Number(process.env.PORT), "127.0.0.1");`);
		writeFileSync(join(root, "site/version.txt"), "1");
		writeFileSync(join(root, "site/images/dot.png"), PNG);
	}, 180_000);
	afterAll(async () => {
		// A backend is a process of its own: stopped through the computer, since killing the daemon leaves it running.
		if (appId) await web?.call("POST", `/api/artifacts/${appId}/backend/stop`, {}).catch(() => undefined);
		daemon?.kill("SIGKILL");
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
		if (home) rmSync(home, { recursive: true, force: true });
	}, 60_000);

	it("runs the folder's backend only after the person approves, and the address reaches it", async () => {
		const end = await ask("deploy the site", toolUse(fauxToolCall("app_deploy", { path: "/workspace/site", title: "Site" })));
		const approval = await waitFor("the deploy to wait for the person", async () => (await d.stack.admin.query("SELECT id, tool, args FROM pim_app.approvals WHERE state = 'waiting'")).rows[0], 60_000);
		expect(approval.args.summary).toBe("Deploy /workspace/site as the app Site, and run its backend on your computer");
		// Nothing has run: no app, no release on the computer.
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.artifacts")).rows[0].n).toBe(0);
		expect(existsSync(join(root, ".pim/apps"))).toBe(false);
		expect((await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: true })).status).toBe(200);
		await end();
		expect((await results("app_deploy"))[0]).toMatch(/Deployed app ar_\w+, version 1: its backend is running/);
		appId = (await d.stack.admin.query("SELECT id FROM pim_app.artifacts")).rows[0].id;

		// The backend runs on the computer from a copy of the folder, the picture byte for byte.
		const release = join(root, ".pim/apps", computerAppId(appId), "v1");
		expect(readFileSync(join(release, "images/dot.png"))).toEqual(PNG);
		await settled("running");
		expect((await backend()).json).toMatchObject({ version: 1, computer: "online", access: "owner", status: { state: "running" } });
		// The version keeps the picture as bytes, and a download gives them back.
		const version = await web.call("GET", `/api/artifacts/${appId}/versions/1`);
		expect(version.json.files.find((f: { path: string }) => f.path === "images/dot.png")).toMatchObject({ size: PNG.length, type: "image/png" });
		expect(version.json.kind).toBe("hosted");
		const download = await fetch(`${base(gate)}/api/artifacts/${appId}/versions/1/download?path=images/dot.png`, { headers: { "x-pim-ingress-secret": d.ingressSecret, cookie: web.cookie } });
		expect(Buffer.from(await download.arrayBuffer())).toEqual(PNG);

		// The app's address, with its token, reaches the backend through the relay; the frame of the app sends the browser there.
		const { path } = (await web.call("POST", `/api/apps/${appId}/open`, {})).json;
		const page = await web.call("GET", `${path}hello?x=1`);
		expect(page).toMatchObject({ status: 200, json: "hello from the backend /hello?x=1 v1" });
		const frame = await web.call("GET", `/api/artifacts/${appId}/versions/1/frame`);
		expect(frame.status).toBe(302);
	}, 240_000);

	it("shows the agent the backend's state and stops it; the person runs a version again", async () => {
		const end = await ask("how is it", toolUse(fauxToolCall("app_logs", { id: appId })));
		await end();
		expect((await results("app_logs"))[0]).toMatch(/^running, restarted 0 times, version 1\./);
		expect((await web.call("GET", `/api/artifacts/${appId}/backend/logs`)).json).toHaveProperty("text");

		await (await ask("stop it", toolUse(fauxToolCall("app_stop", { id: appId }))))();
		expect((await results("app_stop"))[0]).toBe("Stopped.");
		await settled("stopped");
		const { path } = (await web.call("POST", `/api/apps/${appId}/open`, {})).json;
		expect((await web.call("GET", path)).status).toBeGreaterThanOrEqual(500);

		// Only the person's browser runs a version without an approval, and an unknown one is refused.
		expect((await web.call("POST", `/api/artifacts/${appId}/backend/run`, { version: 9 })).status).toBe(404);
		expect((await web.call("POST", `/api/artifacts/${appId}/backend/run`, { version: 1 })).json).toEqual({ running: 1 });
		await settled("running");
		expect((await web.call("GET", path)).json).toBe("hello from the backend / v1");
	}, 240_000);

	it("deploys a new version of the same app, and refuses an access the manifest does not say", async () => {
		writeFileSync(join(root, "site/version.txt"), "2");
		const wrong = await ask("deploy as public", toolUse(fauxToolCall("app_deploy", { path: "/workspace/site", id: appId, access: "public" })));
		await wrong();
		expect((await results("app_deploy")).at(-1)).toMatch(/says access is "owner", but this deploy asked for "public"/);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.approvals WHERE state = 'waiting'")).rows[0].n).toBe(0);

		const end = await ask("deploy again", toolUse(fauxToolCall("app_deploy", { path: "/workspace/site", id: appId })));
		const approval = await waitFor("the second deploy to wait", async () => (await d.stack.admin.query("SELECT id FROM pim_app.approvals WHERE state = 'waiting'")).rows[0], 60_000);
		await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: true });
		await end();
		expect((await results("app_deploy")).at(-1)).toContain("version 2");
		expect((await backend()).json.version).toBe(2);
		const { path } = (await web.call("POST", `/api/apps/${appId}/open`, {})).json;
		await waitFor("the new version to answer", async () => ((await web.call("GET", path)).json === "hello from the backend / v2" ? true : undefined), 30_000);
		expect((await d.stack.admin.query("SELECT latest_version, kind FROM pim_app.artifacts WHERE id = $1", [appId])).rows[0]).toEqual({ latest_version: 2, kind: "backend" });
	}, 240_000);
	it("copies one of the person's files into an app, a picture as bytes, and shows it inline", async () => {
		const end = await ask("make a page with the picture", toolUse(fauxToolCall("app_create", { title: "Pic", kind: "html", files: { "index.html": '<!doctype html><img src="images/dot.png">' }, copy_files: [{ path: "images/dot.png", from_file: "/workspace/site/images/dot.png" }, { path: "notes.txt", from_file: "/workspace/site/version.txt" }] }), fauxToolCall("app_create", { title: "Bad", kind: "html", files: { "index.html": "<p>x</p>" }, copy_files: [{ path: "x.png", from_file: "/etc/passwd" }] })));
		await end();
		const all = await results("app_create");
		const made = all.find((r) => r.startsWith("{"));
		const refused = all.find((r) => !r.startsWith("{"));
		expect(JSON.parse(made!).artifact).toMatchObject({ title: "Pic", kind: "html", version: 1 });
		expect(refused).toMatch(/not one of the person's files/);
		const id = JSON.parse(made!).artifact.id as string;
		const stored = (await d.stack.admin.query("SELECT files FROM pim_app.artifact_versions WHERE artifact_id = $1", [id])).rows[0].files;
		expect(stored["images/dot.png"]).toBe(`pim-binary:${PNG.toString("base64")}`);
		expect(stored["notes.txt"]).toBe("2");
		const frame = await fetch(`${base(gate)}/api/artifacts/${id}/versions/1/frame`, { headers: { "x-pim-ingress-secret": d.ingressSecret, cookie: web.cookie } });
		expect(await frame.text()).toContain(`src="data:image/png;base64,${PNG.toString("base64")}"`);
	}, 240_000);
	it("streams a file of the computer of any size, and answers a Range with 206 so a player seeks", async () => {
		// Bigger than the 25 MB an upload may be: it is read as it is sent, not held, and not refused.
		const big = Buffer.alloc(26_000_000);
		for (let at = 0; at < big.length; at += 1000) big.writeUInt32BE(at / 1000, at);
		writeFileSync(join(root, "movie.bin"), big);
		const get = (range?: string) => fetch(`${base(gate)}/api/files/content?path=/workspace/movie.bin`, { headers: { "x-pim-ingress-secret": d.ingressSecret, cookie: web.cookie, ...(range ? { range } : {}) } });
		const whole = await get();
		expect(whole.status).toBe(200);
		expect(whole.headers.get("accept-ranges")).toBe("bytes");
		expect(whole.headers.get("content-length")).toBe(String(big.length));
		expect(Buffer.from(await whole.arrayBuffer()).equals(big)).toBe(true);
		const middle = await get("bytes=25000000-25000009");
		expect(middle.status).toBe(206);
		expect(middle.headers.get("content-range")).toBe(`bytes 25000000-25000009/${big.length}`);
		expect(Buffer.from(await middle.arrayBuffer())).toEqual(big.subarray(25_000_000, 25_000_010));
		const tail = await get("bytes=-5");
		expect(tail.headers.get("content-range")).toBe(`bytes ${big.length - 5}-${big.length - 1}/${big.length}`);
		expect(Buffer.from(await tail.arrayBuffer())).toEqual(big.subarray(big.length - 5));
		const across = await get("bytes=523000-530000"); // over the part the relay carries at once
		expect(Buffer.from(await across.arrayBuffer())).toEqual(big.subarray(523_000, 530_001));
		const past = await get(`bytes=${big.length}-`);
		expect(past.status).toBe(416);
		expect(past.headers.get("content-range")).toBe(`bytes */${big.length}`);
	}, 240_000);
});
