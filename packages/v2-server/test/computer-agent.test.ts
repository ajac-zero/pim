// An agent's turn on a real paired computer: the real `computer/pim-computer.ts` daemon is paired through the Gate's HTTP pairing route and connects to the Gate; a Runner (a separate
// process role, reaching it only over the Relay's NATS bus) runs `shell` after a person approves it, and reads, writes, edits and refuses files. Without a computer, the tools say so at once.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
		daemon = spawn(process.execPath, [COMPUTER, "--url", `http://127.0.0.1:${d.gatePort}`, "--token", token, "--root", root, ...extra], { stdio: "ignore", env: { ...process.env, HOME: home } });
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
