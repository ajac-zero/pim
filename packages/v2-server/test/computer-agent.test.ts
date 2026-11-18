// An agent's turn on a real paired computer: the real `computer/pim-computer.ts` daemon is paired through the Gate's HTTP pairing route and connects to the Gate; a Runner (a separate
// process role, reaching it only over the Relay's NATS bus) runs `shell` after a person approves it, and reads, writes, edits and refuses files. Without a computer, the tools say so at once.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
/** A Chrome for the browser test: `PIM_TEST_CHROME`, or the one the orb's agent-browser keeps; the test is skipped without one. */
const browsers = join(homedir(), ".agent-browser/browsers");
const CHROME = process.env.PIM_TEST_CHROME ?? (existsSync(browsers) ? readdirSync(browsers, { withFileTypes: true }).map((e) => join(browsers, e.name, "chrome")).find(existsSync) : undefined);
const COMPUTER = fileURLToPath(new URL("../../../computer/pim-computer.ts", import.meta.url));

real("an agent on a paired computer", () => {
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
	let token: string;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	const transcript = async () => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_app.conversations WHERE public_chat_id = $1", [chatId])).rows[0];
		return JSON.stringify(await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id)));
	};
	const results = async (tool: string) =>
		(JSON.parse(await transcript()) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === tool).map((m) => m.content.map((c) => c.text ?? "").join("")));
	const ask = async (words: string, ...script: unknown[]) => {
		faux.setResponses([...script, fauxAssistantMessage(`done ${++n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		const mine = n;
		return () => waitFor(`the turn "${words}" to end`, async () => ((await transcript()).includes(`done ${mine}`) ? true : undefined), 60_000);
	};
	const connected = (online: boolean) => waitFor(`the computer to be ${online ? "online" : "offline"}`, async () => ((await web.call("GET", "/api/computer")).json.state === (online ? "online" : "offline") ? true : undefined), 30_000);
	const startDaemon = (...extra: string[]) => {
		daemon = spawn(process.execPath, [COMPUTER, "--url", `http://127.0.0.1:${d.gatePort}`, "--token", token, "--root", root, ...extra], { stdio: process.env.PIM_TEST_DAEMON_LOG ? "inherit" : "ignore", env: { ...process.env, HOME: home } });
	};

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "pim-computer-home-"));
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
	}, 180_000);
	afterAll(async () => {
		daemon?.kill("SIGKILL");
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
		if (home) rmSync(home, { recursive: true, force: true });
	}, 60_000);

	it("says at once that there is no computer, and pairs one through the same HTTP shapes as v1", async () => {
		const end = await ask("look at my files", toolUse(fauxToolCall("file_list", { path: "/workspace" }), fauxToolCall("browser_open", { url: "https://example.com" })));
		await end();
		expect((await results("file_list"))[0]).toMatch(/Unavailable: file_list.*none is connected/);
		expect((await results("browser_open"))[0]).toMatch(/Unavailable: browser/);
		expect((await web.call("GET", "/api/computer")).json).toMatchObject({ state: "none", managed: false, pairedAt: null, computer: null });

		const paired = await web.call("POST", "/api/computer", {});
		expect(paired.status).toBe(201);
		expect(paired.json).toMatchObject({ state: "offline", managed: false });
		expect(paired.json.token).toMatch(/^pimc_/);
		expect(typeof paired.json.pairedAt).toBe("number");
		token = paired.json.token;
		// What a machine fetches before it has paired, and to update itself.
		const script = await fetch(`${base(gate)}/install.sh`);
		expect(await script.text()).toContain("pim-computer");
		expect((await fetch(`${base(gate)}/pim-computer.ts`)).status).toBe(200);
	}, 120_000);

	it("runs a shell command after a person approves it, and reads, writes and edits files on the real daemon", async () => {
		startDaemon();
		await connected(true);
		expect((await web.call("GET", "/api/computer")).json.computer).toMatchObject({ agent: expect.stringContaining("pim-computer"), root: expect.any(String) });
		writeFileSync(join(root, "hello.txt"), "line one\nline two\n");

		const end = await ask("run a command", toolUse(fauxToolCall("shell", { command: "echo from-the-computer > made.txt; cat hello.txt" })), toolUse(fauxToolCall("file_read", { path: "/workspace/made.txt" })), toolUse(fauxToolCall("send_to_user", { message: "Done." })));
		const approval = await waitFor("the approval to be filed", async () => (await d.stack.admin.query("SELECT id, tool, args FROM pim_app.approvals WHERE state = 'waiting'")).rows[0], 60_000);
		expect(approval.tool).toBe("computer:shell");
		expect(approval.args).toMatchObject({ command: "echo from-the-computer > made.txt; cat hello.txt" });
		// Nothing ran before the decision.
		expect(existsSync(join(root, "made.txt"))).toBe(false);
		expect((await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: true })).status).toBe(200);
		await end();
		expect(readFileSync(join(root, "made.txt"), "utf8")).toBe("from-the-computer\n");
		expect((await results("shell"))[0]).toMatch(/Exit code 0[\s\S]*line one/);
		expect((await results("file_read"))[0]).toContain("from-the-computer");
		expect((await d.stack.admin.query("SELECT state, tool_name FROM pim_runtime.external_operations WHERE owner_id = $1", [ownerId])).rows).toEqual([{ state: "completed", tool_name: "shell" }]);

		// Files: write, then a conflicting edit is refused, an edit lands, and a path outside /workspace is refused.
		const end2 = await ask(
			"work on files",
			toolUse(fauxToolCall("file_write", { path: "/workspace/notes/a.md", content: "alpha\nbeta\n" })),
			toolUse(fauxToolCall("file_edit", { path: "/workspace/hello.txt", edits: [{ oldText: "line two", newText: "line 2" }] }), fauxToolCall("file_read", { path: "/etc/passwd" }), fauxToolCall("file_find", { pattern: "**/*.md" })),
			toolUse(fauxToolCall("send_to_user", { message: "Done." })),
		);
		await end2();
		expect(readFileSync(join(root, "notes/a.md"), "utf8")).toBe("alpha\nbeta\n");
		expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("line one\nline 2\n");
		expect((await results("file_read")).at(-1)).toMatch(/not one of the person's files/);
		expect((await results("file_find")).at(-1)).toContain("/workspace/notes/a.md");
		// The person sees the same files through the Gate.
		const listing = await web.call("GET", "/api/files?path=/workspace");
		expect(listing.json.entries.map((e: { name: string }) => e.name)).toEqual(expect.arrayContaining(["hello.txt", "notes", "made.txt"]));
		const content = await fetch(`${base(gate)}/api/files/content?path=/workspace/hello.txt`, { headers: { cookie: web.cookie ?? "" } });
		expect(content.status === 200 ? await content.text() : "").toBe("line one\nline 2\n");
	}, 180_000);

	it("answers at once when the computer's answer is bigger than the bus carries, and tells the model where /workspace is in the shell", async () => {
		// A 1.5 MB attachment, as a PDF: a read of it asked for 1 MiB, which as base64 is more than NATS's default 1 MB limit, and the Gate waited out its timeout.
		writeFileSync(join(root, "big.pdf"), Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1_500_000, 0)]));
		writeFileSync(join(root, "big.txt"), "x".repeat(1_500_000));
		const started = Date.now();
		const end = await ask(
			"read the pdf",
			toolUse(fauxToolCall("file_read", { path: "/workspace/big.pdf" }), fauxToolCall("file_edit", { path: "/workspace/big.txt", edits: [{ oldText: "x", newText: "y" }] })),
			toolUse(fauxToolCall("send_to_user", { message: "Done." })),
		);
		await end();
		expect(Date.now() - started).toBeLessThan(25_000);
		// The read takes less than the bus carries, finds the binary file, and says where the shell sees it.
		const read = (await results("file_read")).at(-1)!;
		expect(read).toContain("binary file (1500009 bytes)");
		expect(read).toContain(`${realpathSync(root)}/big.pdf`);
		expect(read).toContain("$PIM_WORKSPACE/big.pdf");
		// A call that needs a bigger answer fails at once, naming its size.
		expect((await results("file_edit")).at(-1)).toMatch(/answer is \d+ bytes, more than the 1048576 bytes/);
	}, 120_000);

	it("shows the model a photo attached to a message, and one file_read opens, scaled down to what a model takes", async () => {
		// A noisy 3000x2000 JPEG, a few MB as a phone photo is: more than a request or one answer of the bus should carry as it is.
		const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 60 } } }).jpeg({ quality: 70 }).toBuffer();
		expect(photo.length).toBeGreaterThan(2_000_000);
		expect(photo.length).toBeLessThan(5_000_000);
		writeFileSync(join(root, "photo.jpg"), photo);
		type Seen = { type: string; data?: string; mimeType?: string }[];
		const fitted = (part: { data?: string }) => Buffer.from(part.data ?? "", "base64");
		const sizeOf = async (bytes: Buffer) => sharp(bytes).metadata();

		// The attachment: the message carries the photo as an image part, and the model's request has it.
		const mine = ++n;
		let asked: Seen = [];
		faux.setResponses([
			(context: { messages: { role: string; content: string | Seen }[] }) => {
				asked = context.messages.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((part) => part.type === "image") : []));
				return fauxAssistantMessage(`done ${mine}`);
			},
		] as never);
		const content = [{ type: "text", text: "What is this?" }, { type: "image", data: photo.toString("base64"), mimeType: "image/jpeg" }];
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${mine}`, operationId: `m-${mine}`, text: "What is this?", content })).status).toBe(202);
		await waitFor("the turn with the photo to end", async () => ((await transcript()).includes(`done ${mine}`) ? true : undefined), 60_000);
		expect(asked).toHaveLength(1);
		expect(asked[0]!.mimeType).toBe("image/jpeg");
		expect(fitted(asked[0]!).length).toBeLessThan(750_000);
		expect((await sizeOf(fitted(asked[0]!))).width!).toBeLessThanOrEqual(1568);
		// The Runner's user entry, which the chat is projected from, keeps the photo as an image part beside the text.
		const entries = JSON.parse(await transcript()) as { model?: { role: string; content: Seen | string }[] }[];
		const kept = entries.flatMap((e) => e.model ?? []).find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((part) => part.type === "image"))!;
		expect((kept.content as Seen).map((part) => part.type)).toEqual(["text", "image"]);
		// A picture that is no picture is refused, not sent on as one.
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: "bad", content: [{ type: "image", data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" }] })).status).toBe(400);

		// file_read: the whole photo is read in pieces, and the model's next request has it as a tool result's image, with a note.
		let read: Seen = [];
		let note = "";
		const end = await ask(
			"look at photo.jpg",
			toolUse(fauxToolCall("file_read", { path: "/workspace/photo.jpg" })),
			(context: { messages: { role: string; content: Seen }[] }) => {
				const result = context.messages.findLast((m) => m.role === "toolResult")!;
				read = result.content.filter((part) => part.type === "image");
				note = result.content.map((part) => (part as { text?: string }).text ?? "").join("");
				return toolUse(fauxToolCall("send_to_user", { message: "Seen." }));
			},
		);
		await end();
		expect(read).toHaveLength(1);
		expect(read[0]!.mimeType).toBe("image/jpeg");
		expect(fitted(read[0]!).length).toBeLessThan(750_000);
		expect(note).toContain(`/workspace/photo.jpg (${photo.length} bytes; scaled down to fit)`);
	}, 120_000);

	it("does nothing when the person declines, and goes unavailable when the computer leaves", async () => {
		const end = await ask("remove it", toolUse(fauxToolCall("shell", { command: "touch declined.txt" })), toolUse(fauxToolCall("send_to_user", { message: "Ok." })));
		const approval = await waitFor("the approval to be filed", async () => (await d.stack.admin.query("SELECT id FROM pim_app.approvals WHERE state = 'waiting'")).rows[0], 60_000);
		expect((await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: false })).status).toBe(200);
		await end();
		expect(existsSync(join(root, "declined.txt"))).toBe(false);
		expect((await results("shell")).at(-1)).toMatch(/did not approve/);

		daemon?.kill("SIGKILL");
		await connected(false);
		const started = Date.now();
		const end2 = await ask("again", toolUse(fauxToolCall("shell", { command: "true" }), fauxToolCall("file_read", { path: "/workspace/hello.txt" })));
		await end2();
		expect(Date.now() - started).toBeLessThan(20_000);
		expect((await results("shell")).at(-1)).toMatch(/Unavailable/);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.approvals WHERE state = 'waiting'")).rows[0].n).toBe(0);
	}, 180_000);

	it("looks at the desktop of a computer with a Cua desktop and no displayd, and waits for a person before acting on it", async () => {
		const asked: { name: string; arguments: Record<string, unknown> }[] = [];
		const spacesd = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				const m = JSON.parse(body || "{}") as { id?: number; method?: string; params?: { name: string; arguments: Record<string, unknown> } };
				if (m.method === "initialize") return void res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "cua", version: "0" } } }));
				if (m.id === undefined) return void res.writeHead(202).end();
				asked.push(m.params!);
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${m.params!.name} done` }] } }));
			});
		});
		await new Promise<void>((resolve) => spacesd.listen(0, "127.0.0.1", resolve));
		const tokenFile = join(home, "spacesd-token");
		writeFileSync(tokenFile, "t0ken");
		process.env.PIM_SPACESD_TOKEN_FILE = tokenFile;
		try {
			daemon?.kill("SIGKILL");
			startDaemon("--spacesd", `http://127.0.0.1:${(spacesd.address() as { port: number }).port}`);
			await connected(true);
			// Looking runs at once, on the one desktop the chats share.
			await (await ask("look", toolUse(fauxToolCall("desktop_look", {}))))();
			expect((await results("desktop_look")).at(-1)).toContain("get_desktop_state done");
			// Acting is filed first and does nothing until it is approved.
			const end = await ask("click", toolUse(fauxToolCall("desktop_act", { action: "click", pid: 7, x: 5, y: 6 })));
			const approval = await waitFor("the approval to be filed", async () => (await d.stack.admin.query("SELECT id, tool FROM pim_app.approvals WHERE state = 'waiting'")).rows[0], 60_000);
			expect(approval.tool).toBe("computer:desktop");
			expect(asked.map((a) => a.name)).toEqual(["get_desktop_state"]);
			expect((await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: true })).status).toBe(200);
			await end();
			expect(asked.map((a) => a.name)).toEqual(["get_desktop_state", "click"]);
			expect(asked[1]!.arguments).toMatchObject({ pid: 7, x: 5, y: 6 });
		} finally {
			delete process.env.PIM_SPACESD_TOKEN_FILE;
			daemon?.kill("SIGKILL");
			await connected(false);
			spacesd.close();
		}
	}, 240_000);

	it("runs a stream trigger on the computer only under a grant for exactly that source, and hands what it saw to the chat", async () => {
		daemon?.kill("SIGKILL");
		await connected(false);
		startDaemon();
		await connected(true);
		const computerId = "";
		const agentId = (await web.call("POST", "/api/agents", { name: "Watcher" })).json.id as string;
		const made = (await web.call("POST", "/api/triggers", { label: "Watch", instruction: "Tell me what the stream saw.", agentId, source: { kind: "stream", command: "echo '{\"m\":0}'; echo '{\"n\":1}'; sleep 300" }, condition: { when: { op: "exists", path: ["n"] } }, destination: { type: "existing_chat", chatId } })).json;
		expect(made).toMatchObject({ lifecycle: "draft", capability: { status: "available", delivers: true }, grant: { required: true, state: "missing" } });
		const resume = (revision: number) => web.call("POST", `/api/triggers/${made.id}/resume`, {}, { "if-match": `"${revision}"` });
		// Without a grant nothing is enabled, and nothing runs on the computer.
		expect((await resume(made.revision)).status).toBeGreaterThanOrEqual(400);
		const grant = await web.call("POST", `/api/triggers/${made.id}/computer-grant`, { computerId });
		expect(grant.status, JSON.stringify(grant.json)).toBe(200);
		const granted = (await web.call("GET", `/api/triggers/${made.id}`)).json;
		expect(granted.grant.state).toBe("current");
		faux.setResponses([fauxAssistantMessage("It saw n=1.")] as never);
		expect((await resume(granted.revision)).json.lifecycle).toBe("enabled");
		const fired = () => d.stack.admin.query("SELECT detail FROM pim_app.trigger_runs WHERE trigger_id = $1 AND phase = 'fired'", [made.id]);
		const run = await waitFor("the stream's matching line to reach the chat", async () => (await fired()).rows[0], 90_000);
		// What it says is why it fired, never what was observed.
		expect(run.detail).toMatchObject({ source: "stream" });
		expect(JSON.stringify(run.detail)).not.toContain('"n"');
		// The line that doesn't match the condition fired nothing: one run in all.
		expect((await fired()).rowCount).toBe(1);
		// Changing what runs makes the grant stale: it is not run again until it is granted anew.
		const changed = (await web.call("PATCH", `/api/triggers/${made.id}`, { source: { kind: "stream", command: "echo '{\"n\":2}'; sleep 300" } }, { "if-match": `"${(await web.call("GET", `/api/triggers/${made.id}`)).json.revision}"` })).json;
		expect(changed.grant.state).toBe("not_current");
		const stale = await d.stack.admin.query("SELECT 1 FROM pim_app.trigger_computer_grants WHERE trigger_id = $1 AND config_hash IS NOT NULL", [made.id]);
		expect(stale.rowCount).toBe(1);
		daemon?.kill("SIGKILL");
		await connected(false);
	}, 240_000);

	it.skipIf(!CHROME)("opens pages and clicks links freely, but sending a form waits for a person (the real daemon's Chrome)", async () => {
		const posts: string[] = [];
		const site = createServer((req, res) => {
			if (req.method === "POST") {
				posts.push(req.url ?? "");
				req.resume();
				return void res.writeHead(200, { "content-type": "text/html" }).end("<h1>Ordered</h1>");
			}
			res.writeHead(200, { "content-type": "text/html" }).end(req.url === "/next" ? "<h1>Next page</h1>" : '<h1>Shop</h1><a href="/next">Go next</a><form method="post" action="/buy"><button>Buy now</button></form>');
		});
		await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
		try {
			startDaemon("--chrome", CHROME!);
			await connected(true);
			const end = await ask("shop", toolUse(fauxToolCall("browser_open", { url })));
			await end();
			const page = (await results("browser_open")).at(-1)!;
			expect(page).toContain("Shop");
			// A page's numbers count up each time it is read, so a number is taken from the latest reading.
			const ref = async (label: string) => Number(new RegExp(`\\[(\\d+) [a-z]+ “${label}”`).exec((await results("browser_open")).at(-1)!)?.[1]);
			// A link is followed without asking.
			const end2 = await ask("follow the link", toolUse(fauxToolCall("browser_click", { ref: await ref("Go next") })));
			await end2();
			expect((await results("browser_click")).at(-1)).toContain("Next page");
			// A button of a form that posts is not: it is filed, shown as the page names it, and nothing is sent until it is approved.
			await (await ask("shop again", toolUse(fauxToolCall("browser_open", { url }))))();
			const end3 = await ask("buy", toolUse(fauxToolCall("browser_click", { ref: await ref("Buy now") })));
			const approval = await waitFor("the approval to be filed", async () => (await d.stack.admin.query("SELECT id, tool, args FROM pim_app.approvals WHERE state = 'waiting'")).rows[0], 60_000);
			expect(approval.tool).toBe("computer:browser_submit");
			expect(approval.args.summary).toMatch(/click the button “Buy now”/);
			expect(posts).toHaveLength(0);
			expect((await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: true })).status).toBe(200);
			await end3();
			expect(posts).toEqual(["/buy"]);
			expect((await results("browser_click")).at(-1)).toContain("Ordered");
		} finally {
			site.close();
		}
	}, 240_000);
});
