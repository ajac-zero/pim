import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { Workspace } from "@cloudflare/computer";
import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { DriverHost, ExecArgs, ExecResult, ScreenHost } from "../computer/pim-computer";
import type { Approval } from "../src/store";
import { COMPUTER_GRANT_ACTION, PROTOCOL, runtimeIdOf, TRIGGERS_ENVELOPE } from "../src/triggers/computer";
import { TRIGGER_TICK_CALLBACK } from "../src/triggers/engine";
import { Computer } from "../src/computer";
import { api, apiUrl, browserCalls, connectTestComputer, opens, OWNER, pendingApproval, post, say, signedIn, TOKEN, toolUse } from "./helpers";
import { faux, paintings, type Pim } from "./worker";

const agent = () => env.Pim.getByName(OWNER);

const raw = (path: string, init: RequestInit = {}) =>
	exports.default.fetch(new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } }));

const upload = (path: string, body: BodyInit) => raw(`/files/content?path=${encodeURIComponent(path)}`, { method: "PUT", body });

/** A 1×1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));

/** The last tool result's text, and the types of the images it shows the model. */
function lastToolResult(messages: readonly Message[]): { text: string; isError: boolean; images: string[] } {
	const result = messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("no tool result");
	return {
		text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
		isError: result.isError === true,
		images: result.content.flatMap((part) => (part.type === "image" ? [part.mimeType] : [])),
	};
}

async function callTool(name: string, args: Record<string, unknown>) {
	let result: ReturnType<typeof lastToolResult> = { text: "", isError: false, images: [] };
	faux.setResponses([
		toolUse(name, args as never),
		(context) => {
			result = lastToolResult(context.messages);
			return toolUse("send_to_user", { message: "Done." });
		},
	]);
	await say(`Please use ${name}`);
	return result;
}

/** The tools the model is offered in a chat now. */
async function offeredTools(): Promise<string[]> {
	let names: string[] = [];
	faux.setResponses([
		(context) => {
			// Every tool the system messages added, less those they removed.
			const tools = new Set<string>();
			for (const message of context.messages) {
				if (message.role !== "system") continue;
				for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
				for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
			}
			names = [...tools];
			return toolUse("send_to_user", { message: "Here." });
		},
	]);
	await say("What can you use?");
	return names;
}

const status = async () => (await api<{ state: string; computer: { hostname: string; root: string } | null }>("/computer")).body;

/** What the test computer ran, and what it answers commands with. */
const ran: ExecArgs[] = [];
let answer: (args: ExecArgs) => ExecResult | Promise<ExecResult> = (args) => ({ exitCode: 0, signal: null, stdout: `ran ${args.command}\n`, stderr: "", timedOut: false, truncated: false });

const connectComputer = (token: string, root: string) =>
	connectTestComputer(token, root, async (args) => {
		ran.push(args);
		return answer(args);
	});

/** The script, request and response files of the `node` command that sends an image request from the computer. */
const nodeArgs = (command: string) => /^node "(.+)" "(.+)" "(.+)"$/.exec(command)!.slice(1) as [string, string, string];

const ROOT = `/tmp/computer-${crypto.randomUUID()}`;
let computer: Awaited<ReturnType<typeof connectComputer>>;
let token = "";

describe("a space without a computer", () => {
	it("has no files, and no tools that need them", async () => {
		expect(await status()).toEqual({ state: "none", managed: false, pairedAt: null, computer: null, error: null });
		expect((await api("/files")).status).toBe(404);
		const tools = await offeredTools();
		expect(tools).toContain("send_to_user");
		for (const tool of ["file_read", "file_write", "file_delete", "shell", "generate_image", "browser_open", "browser_click", "browser_screenshot"]) {
			expect(tools).not.toContain(tool);
		}
		const permissions = (await api("/permissions")).body.tools.map((permission: { name: string }) => permission.name);
		for (const tool of ["shell", "browser_click"]) expect(permissions).not.toContain(tool);
		expect((await api("/browser")).body).toEqual({ available: false, page: null });
	});

	it("keeps the files it had, and moves them to the computer once one connects", async () => {
		// Files kept in the space before files moved to the computer: text in its Workspace, a PDF in R2.
		await runInDurableObject(agent(), async (_instance: Pim, state) => {
			const workspace = new Workspace({ storage: state.storage, output: false });
			await workspace.fs.mkdir("/workspace/trips", { recursive: true });
			await workspace.fs.writeFile("/workspace/trips/lisbon.md", "# Lisbon");
			await workspace.fs.writeFile("/workspace/notes.md", "from the space");
			await env.BLOBS.put(`${OWNER}/files/scan-1`, new Uint8Array([1, 2, 3]));
			state.storage.sql.exec("INSERT INTO pim_stored_files (path, id, type, bytes, updated_at) VALUES (?, ?, ?, ?, ?)", "/workspace/scan.pdf", "scan-1", "application/pdf", 3, 0);
		});
		const exported = (await (await raw("/export")).json()) as { files: { path: string }[] };
		expect(exported.files.map((file) => file.path)).toEqual(["/workspace/notes.md", "/workspace/scan.pdf", "/workspace/trips/lisbon.md"]);

		// The computer already has a file at one of their paths: that one moves in beside it.
		await fs.mkdir(ROOT, { recursive: true });
		await fs.writeFile(`${ROOT}/notes.md`, "the computer's own");
		const paired = await post<{ state: string; token: string }>("/computer");
		expect(paired.status).toBe(201);
		token = paired.body.token;
		computer = await connectComputer(token, ROOT);
		await vi.waitFor(async () => expect(await fs.readFile(`${ROOT}/trips/lisbon.md`, "utf8")).toBe("# Lisbon"));
		await vi.waitFor(async () => expect(new Uint8Array(await fs.readFile(`${ROOT}/scan.pdf`))).toEqual(new Uint8Array([1, 2, 3])));
		expect(await fs.readFile(`${ROOT}/notes.md`, "utf8")).toBe("the computer's own");
		expect(await fs.readFile(`${ROOT}/notes (from Pim).md`, "utf8")).toBe("from the space");
		// The space keeps none of them now.
		await vi.waitFor(async () => expect(((await (await raw("/export")).json()) as { files: unknown[] }).files).toEqual([]));
		expect((await env.BLOBS.list({ prefix: `${OWNER}/files/` })).objects).toEqual([]);
		await fs.rm(ROOT, { recursive: true });
		await fs.mkdir(ROOT);
	});
});

describe("the computer", () => {
	it("connects with its own token, which opens nothing else", async () => {
		expect(token).toMatch(new RegExp(`^pimc_${OWNER}_`));
		expect(await status()).toMatchObject({ state: "online", computer: { hostname: "test-box", root: computer.root } });
		// The computer's token isn't an API token, and an API token, or another token, doesn't connect a computer.
		expect((await raw("/sessions", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
		expect((await opens("/computer/connect", TOKEN)).status).toBe(401);
		expect((await opens("/computer/connect", `${token.slice(0, -2)}xx`)).status).toBe(401);
		const tools = await offeredTools();
		for (const tool of ["file_read", "file_write", "file_edit", "file_search", "shell", "generate_image", "browser_open", "browser_click"]) expect(tools).toContain(tool);
		// It has no desktop for agents: no Cua Driver.
		for (const tool of ["desktop_look", "desktop_read", "desktop_act"]) expect(tools).not.toContain(tool);
	});

	it("keeps the files the person and their agents share", async () => {
		// An agent writes a file: it's on the computer, and in Files.
		expect((await callTool("file_write", { path: "/workspace/trips/lisbon.md", content: "# Lisbon\nFlight TP 202" })).isError).toBe(false);
		expect(await fs.readFile(`${ROOT}/trips/lisbon.md`, "utf8")).toBe("# Lisbon\nFlight TP 202");
		const { body: root } = await api("/files");
		expect(root.entries).toContainEqual(expect.objectContaining({ name: "trips", path: "/workspace/trips", type: "directory" }));
		const { body: trips } = await api("/files?path=/workspace/trips");
		expect(trips.entries).toEqual([expect.objectContaining({ name: "lisbon.md", type: "file", size: 22 })]);
		const download = await raw("/files/content?path=/workspace/trips/lisbon.md&download");
		expect(await download.text()).toBe("# Lisbon\nFlight TP 202");
		expect(download.headers.get("content-disposition")).toContain('filename="lisbon.md"');

		// A player's playbar seeks with Range requests, which are answered with just those bytes.
		const slice = await raw("/files/content?path=/workspace/trips/lisbon.md", { headers: { range: "bytes=2-7" } });
		expect([slice.status, slice.headers.get("content-range"), slice.headers.get("content-length"), await slice.text()]).toEqual([206, "bytes 2-7/22", "6", "Lisbon"]);
		const tail = await raw("/files/content?path=/workspace/trips/lisbon.md", { headers: { range: "bytes=-3" } });
		expect([tail.status, await tail.text()]).toEqual([206, "202"]);
		expect((await raw("/files/content?path=/workspace/trips/lisbon.md", { headers: { range: "bytes=30-" } })).status).toBe(416);

		// The person uploads one, larger than one message carries; it arrives whole, and the agent reads it.
		const big = new TextEncoder().encode(`night,price\n${"1,140\n".repeat(400_000)}`);
		expect((await upload("/workspace/receipts/hotel.csv", big)).status).toBe(201);
		expect(new Uint8Array(await fs.readFile(`${ROOT}/receipts/hotel.csv`))).toEqual(big);
		expect(new Uint8Array(await (await raw("/files/content?path=/workspace/receipts/hotel.csv")).arrayBuffer())).toEqual(big);
		expect((await fs.readdir(`${ROOT}/receipts`)).length).toBe(1);
		const read = await callTool("file_read", { path: "/workspace/receipts/hotel.csv", limit: 3 });
		expect(read).toMatchObject({ isError: false, text: expect.stringContaining("1,140") });

		// Editing, searching and finding work on the computer's files; images are shown to the model.
		await callTool("file_edit", { path: "/workspace/trips/lisbon.md", edits: [{ oldText: "TP 202", newText: "TP 204" }] });
		expect(await fs.readFile(`${ROOT}/trips/lisbon.md`, "utf8")).toContain("TP 204");
		const searched = JSON.parse((await callTool("file_search", { query: "tp 204", ignoreCase: true })).text);
		expect(searched.matches).toEqual([expect.objectContaining({ path: "/workspace/trips/lisbon.md", line: 2 })]);
		const found = JSON.parse((await callTool("file_find", { pattern: "**/*.csv", exclude: "trips" })).text);
		expect(found.entries).toEqual([{ path: "/workspace/receipts/hotel.csv", type: "file" }]);
		await fs.writeFile(`${ROOT}/photo.png`, PNG);
		expect((await callTool("file_read", { path: "/workspace/photo.png" })).images).toEqual(["image/png"]);
	});

	it("keeps agents and the app inside /workspace, links included", async () => {
		for (const path of ["/workspaces/notes.md", "/workspace/../notes.md", "/notes.md"]) {
			const written = await callTool("file_write", { path, content: "secret" });
			expect(written).toMatchObject({ isError: true, text: expect.stringContaining("not one of the person's files") });
			expect((await upload(path, "secret")).status).toBe(400);
		}
		expect((await api("/files?path=/")).status).toBe(400);
		// A link in the folder doesn't lead out of it.
		await fs.mkdir(`${ROOT}-outside`, { recursive: true });
		await fs.writeFile(`${ROOT}-outside/secret.txt`, "secret");
		await fs.symlink(`${ROOT}-outside`, `${ROOT}/escape`);
		const escaped = await callTool("file_read", { path: "/workspace/escape/secret.txt" });
		expect(escaped).toMatchObject({ isError: true, text: expect.stringContaining("outside /workspace") });
		expect((await raw("/files/content?path=/workspace/escape/secret.txt")).status).toBe(403);
		expect((await callTool("file_write", { path: "/workspace/escape/planted.txt", content: "x" })).isError).toBe(true);
		await expect(fs.stat(`${ROOT}-outside/planted.txt`)).rejects.toThrow();
		await fs.rm(`${ROOT}/escape`);
	});

	it("serves files inert, whatever they contain", async () => {
		await upload("/workspace/page.html", "<script>alert(document.cookie)</script>");
		const response = await raw("/files/content?path=/workspace/page.html");
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		await response.body?.cancel();
	});

	it("deletes an agent's files only once the person approves; the person deletes their own", async () => {
		await upload("/workspace/old/draft.txt", "first draft");
		faux.setResponses([toolUse("file_delete", { path: "/workspace/old", recursive: true }), toolUse("send_to_user", { message: "Deleted." })]);
		const cleaning = say("Clean up the old folder.");
		const approval = await pendingApproval();
		expect(approval.summary).toBe("Delete /workspace/old and everything in it");
		expect(await fs.readFile(`${ROOT}/old/draft.txt`, "utf8")).toBe("first draft");
		expect((await post<Approval>(`/approvals/${approval.id}/approve`)).body.status).toBe("approved");
		expect(await cleaning).toMatchObject({ status: "done", replies: ["Deleted."] });
		await expect(fs.stat(`${ROOT}/old`)).rejects.toThrow();

		await upload("/workspace/gone.txt", "bye");
		expect((await raw("/files?path=/workspace/gone.txt", { method: "DELETE" })).status).toBe(200);
		expect((await raw("/files/content?path=/workspace/gone.txt")).status).toBe(404);
	});

	it("runs commands once the person approves, where the agent asks", async () => {
		await fs.mkdir(`${ROOT}/project`, { recursive: true });
		answer = (args) => ({ exitCode: 2, signal: null, stdout: `ran ${args.command}\n`, stderr: "warning: old npm\n", timedOut: false, truncated: false });
		let result = { text: "", isError: false, images: [] as string[] };
		faux.setResponses([
			toolUse("shell", { command: "npm test", cwd: "/workspace/project", timeout_seconds: 30 }),
			(context) => {
				result = lastToolResult(context.messages);
				return toolUse("send_to_user", { message: "Tested." });
			},
		]);
		const testing = say("Run the tests.");
		const approval = await pendingApproval();
		expect(approval.summary).toBe("Run a command");
		expect(ran).toEqual([]);
		await post(`/approvals/${approval.id}/approve`);
		await testing;
		expect(ran).toEqual([{ command: "npm test", cwd: "/workspace/project", timeoutMs: 30_000, maxBytes: 64_000, thread: "1" }]);
		expect(result.text).toContain("Exit code 2\nstdout:\nran npm test\n\nstderr:\nwarning: old npm");

		// A folder outside the files is refused before anything runs.
		faux.setResponses([toolUse("shell", { command: "ls", cwd: "/etc" }), toolUse("send_to_user", { message: "No." })]);
		const refused = say("List /etc.");
		await post(`/approvals/${(await pendingApproval()).id}/approve`);
		await refused;
		expect(ran.length).toBe(1);
		expect((await api("/permissions")).body.tools).toContainEqual(expect.objectContaining({ name: "shell", permission: "ask" }));
	});

	it("saves the images agents make, each counted as a model request", async () => {
		const model = "@cf/black-forest-labs/flux-2-klein-4b";
		const requests = async () =>
			(await api("/usage")).body.today.models.find((entry: { provider: string; model: string }) => entry.provider === "cloudflare" && entry.model === model)?.requests ?? 0;
		const before = { paintings: paintings.length, requests: await requests() };

		const made = await callTool("generate_image", { prompt: "A red fox asleep in snow, watercolor", shape: "portrait" });
		expect(made.isError).toBe(false);
		const { image } = JSON.parse(made.text);
		// Named by the time, with the extension of what the model drew.
		expect(image).toMatchObject({ model, type: "image/png", bytes: PNG.byteLength });
		expect(image.path).toMatch(/^\/workspace\/images\/[\dT-]+Z\.png$/);
		expect(new Uint8Array(await fs.readFile(`${ROOT}${image.path.slice("/workspace".length)}`))).toEqual(PNG);
		expect(paintings.slice(before.paintings)).toEqual([{ model, fields: { prompt: "A red fox asleep in snow, watercolor", width: "768", height: "1280" } }]);
		expect(await requests()).toBe(before.requests + 1);

		// One outside the files is refused before anything is drawn.
		const outside = await callTool("generate_image", { prompt: "A lighthouse", path: "/etc/lighthouse.png" });
		expect(outside).toMatchObject({ isError: true, text: expect.stringContaining("not one of the person's files") });
		expect(paintings.length).toBe(before.paintings + 1);
	});

	it("draws images for a bot's guests, kept in each guest's own folder, and shares nothing of the computer", async () => {
		const gallery = env.Gallery.getByName("gallery");
		const { tools, published } = await runInDurableObject(agent(), async (instance: Pim) => {
			const majordomo = instance.agents.majordomo();
			const shareable = instance.shareableTools(majordomo).map((tool) => tool.name);
			// Images can be shared; the computer's own tools never are.
			expect(shareable).toContain("generate_image");
			for (const tool of ["file_read", "file_write", "shell", "browser_open"]) expect(shareable).not.toContain(tool);
			return { ...(await instance.botTools(majordomo.id, ["generate_image"])), published: (await instance.agentToPublish(majordomo.id))! };
		});
		const bot = await gallery.shareBot(OWNER, "owner", published, { dailyMessages: null, dailyToolCalls: null, model: null, tools });
		const before = paintings.length;
		const { made, other } = await runInDurableObject(agent(), async (instance: Pim) => ({
			// The guest's model can't choose where it goes.
			made: await instance.runBotTool(bot.id, "o_guest", "generate_image", { prompt: "A lighthouse at dusk", path: "/workspace/notes.md" }),
			other: await instance.runBotTool(bot.id, "o_guest", "file_read", { path: "/workspace/notes.md" }),
		}));
		expect(made?.isError).toBeFalsy();
		const { image } = JSON.parse((made!.content[0] as { text: string }).text);
		expect(image.path).toMatch(new RegExp(`^/workspace/bots/${bot.id}/o_guest/[\\dT-]+Z\\.png$`));
		expect(new Uint8Array(await fs.readFile(`${ROOT}${image.path.slice("/workspace".length)}`))).toEqual(PNG);
		expect(paintings.length).toBe(before + 1);
		expect(other).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("doesn't share file_read") }] });

		// The guest's chat reads it back; no other guest can, nor anything outside the guest's folder.
		const read = (guest: string, path: string) => runInDurableObject(agent(), (instance: Pim) => instance.botImage(bot.id, guest, path));
		expect((await read("o_guest", image.path))?.bytes).toEqual(PNG);
		expect(await read("o_other", image.path)).toBeNull();
		expect(await read("o_guest", `/workspace/bots/${bot.id}/o_guest/../../../notes.md`)).toBeNull();
		await gallery.unshareBot(OWNER, bot.agentId);
		const off = await runInDurableObject(agent(), (instance: Pim) => instance.runBotTool(bot.id, "o_guest", "generate_image", { prompt: "Again" }));
		expect(off).toMatchObject({ isError: true });
		expect(paintings.length).toBe(before + 1);
	});

	it("draws with the ChatGPT plan from the computer while it's signed in for images, and refreshes the sign-in", async () => {
		const jwt = (claims: Record<string, unknown>) => `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.sig`;
		const auth = { "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } };
		// The first access token is spent as soon as it's issued, so the next image refreshes it.
		const tokens = [
			{ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 60, ...auth }), refresh_token: "refresh-1", id_token: jwt({ email: "me@example.com", ...auth }) },
			{ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, ...auth }), refresh_token: "refresh-2" },
		];
		const refreshed = tokens[1]!.access_token;
		const calls: { url: string; body: string }[] = [];
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (new URL(request.url).origin !== "https://auth.openai.com") return realFetch(input, init);
			calls.push({ url: request.url, body: await request.text() });
			return Response.json(tokens.shift());
		});
		// The computer's side: the request goes to it in a file, and it never goes from the Worker.
		const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
		const wasAnswer = answer;
		answer = async ({ command }) => {
			const [script, request, response] = nodeArgs(command);
			expect(await fs.readFile(script, "utf8")).toContain("fetch(url");
			sent.push(JSON.parse(await fs.readFile(request, "utf8")));
			await fs.rm(request);
			await fs.writeFile(response, JSON.stringify({ data: [{ b64_json: btoa(String.fromCharCode(...PNG)) }] }));
			return { exitCode: 0, signal: null, stdout: JSON.stringify({ status: 200, mitigated: null, ray: "r" }), stderr: "", timedOut: false, truncated: false };
		};
		try {
			const { url } = (await post("/chatgpt/images/login")).body;
			const state = new URL(url).searchParams.get("state");
			expect(new URL(url)).toMatchObject({ origin: "https://auth.openai.com", pathname: "/oauth/authorize" });
			const stranger = await post("/chatgpt/images/callback", { url: "http://localhost:1455/auth/callback?code=abc&state=other" });
			expect(stranger.status).toBe(400);
			const connected = await post("/chatgpt/images/callback", { url: `http://localhost:1455/auth/callback?code=abc&state=${state}` });
			expect(connected.body).toEqual({ connected: true, email: "me@example.com" });
			expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toMatchObject({ grant_type: "authorization_code", code: "abc", redirect_uri: "http://localhost:1455/auth/callback" });

			const before = paintings.length;
			const made = await callTool("generate_image", { prompt: "A red fox asleep in snow", shape: "landscape" });
			expect(made.isError).toBe(false);
			expect(JSON.parse(made.text).image).toMatchObject({ model: "gpt-image-2", type: "image/png" });
			// Workers AI wasn't asked; the plan was, through the computer, as an expired token refreshed first.
			expect(paintings.length).toBe(before);
			expect(JSON.parse(calls[1]!.body)).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token: "refresh-1" });
			expect(sent).toHaveLength(1);
			expect(sent[0]!.url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
			expect(sent[0]!.headers).toMatchObject({ authorization: `Bearer ${refreshed}`, "chatgpt-account-id": "acct-1" });
			expect(JSON.parse(sent[0]!.body).prompt).toBe("A red fox asleep in snow\n\nAspect ratio: 3:2, wide landscape (horizontal) canvas.");
			// Nothing is left on the computer.
			expect(await fs.readdir(`${ROOT}/.pim`)).toEqual([]);

			// A firewall's page is reported as one, with its ray.
			answer = async ({ command }) => {
				const [, request, response] = nodeArgs(command);
				await fs.rm(request);
				await fs.writeFile(response, "<html><head><title>Blocked</title></head></html>");
				return { exitCode: 0, signal: null, stdout: JSON.stringify({ status: 403, mitigated: null, ray: "abc123" }), stderr: "", timedOut: false, truncated: false };
			};
			const blocked = await callTool("generate_image", { prompt: "A red fox" });
			expect(blocked).toMatchObject({ isError: true, text: expect.stringContaining('answered 403: a web page "Blocked", ray abc123') });

			// Disconnected, images are Workers AI's again.
			expect((await api("/chatgpt/images", { method: "DELETE" })).body).toEqual({ connected: false, email: null });
			await callTool("generate_image", { prompt: "A red fox asleep in snow" });
			expect(paintings.length).toBe(before + 1);
		} finally {
			answer = wasAnswer;
			vi.restoreAllMocks();
		}
	});

	it("answers the computer's triggers runtime on its own connection wherever the space's triggers are on, with no deployment setting for it", async () => {
		expect(Object.keys(env).filter((name) => /COMPUTER/.test(name) && /TRIGGER/.test(name))).toEqual([]);
		await runInDurableObject(agent(), (pim: Pim) => pim.enableTriggerEngine());
		const answered: string[] = [];
		const listen = (event: MessageEvent) => {
			if (String(event.data).startsWith(TRIGGERS_ENVELOPE)) answered.push(String(event.data));
		};
		const digest = createHash("sha256").update(token).digest("hex");
		// The runtime's hello is answered on the same socket before the computer's own messages are read.
		computer.socket.addEventListener("message", listen);
		try {
			computer.socket.send(`${TRIGGERS_ENVELOPE}${JSON.stringify({ protocol: PROTOCOL, type: "hello", runtimeId: runtimeIdOf(digest), connectionId: "connection-2", lastEpoch: null, pending: 0 })}}`);
			computer.socket.send(JSON.stringify({ type: "hello", version: 1, agent: "pim-computer/test", hostname: "test-box", platform: "linux", arch: "x64", user: "ada", root: computer.root, browser: null, screen: false, desktop: false }));
			await vi.waitFor(() => expect(answered).toHaveLength(1));
		} finally {
			computer.socket.removeEventListener("message", listen);
		}
		expect(JSON.parse(answered[0]!)).toEqual({
			type: "triggers",
			frame: { protocol: PROTOCOL, type: "reconcile", binding: { space: OWNER, runtimeId: runtimeIdOf(digest) }, connectionId: "connection-2", serverEpoch: 1, desiredRevision: 1, leaseMs: 120_000, sources: [] },
		});
		await vi.waitFor(async () => expect(await status()).toMatchObject({ state: "online", computer: { hostname: "test-box" } }));
		await runInDurableObject(agent(), async (pim: Pim, state) => {
			expect(state.storage.sql.exec("SELECT runtime_id, server_epoch FROM pim_trigger_computer_runtimes").toArray()).toEqual([{ runtime_id: runtimeIdOf(digest), server_epoch: 1 }]);
			await pim.disableTriggerEngine();
		});
	});

	it("asks the person, through an agent, to grant a trigger's source on the computer, records only their approval, and tells the computer of each change", async () => {
		const runtimeId = runtimeIdOf(createHash("sha256").update(token).digest("hex"));
		const reconciles: { connectionId: string; serverEpoch: number; desiredRevision: number; sources: { triggerId: string; grant: { grantRef: string } }[] }[] = [];
		const listen = (event: MessageEvent) => {
			const data = String(event.data);
			if (data.startsWith(TRIGGERS_ENVELOPE)) reconciles.push(JSON.parse(data).frame);
		};
		const source = { kind: "stream", command: "tail -F /var/log/syslog", cwd: null } as const;
		const spec = { version: 1, owningAgentId: "majordomo", originChatId: "chat-1", label: "Syslog", instruction: "Tell me what it said.", destination: { type: "new_chat" }, source } as const;
		try {
			// The grant tool comes with the space's triggers.
			await runInDurableObject(agent(), (pim: Pim) => pim.enableTriggerEngine());
			expect(await offeredTools()).toContain("trigger_computer_grant");
			expect(await runInDurableObject(agent(), (pim: Pim) => pim.triggerEngine()!.store.create({ id: "syslog", spec }))).toMatchObject({ ok: true, trigger: { lifecycle: "draft" } });
			// With a computer paired, its source is one Pim runs, once granted.
			expect((await api("/triggers/syslog")).body).toMatchObject({ capability: { status: "available", delivers: true, reason: null }, grant: { required: true, state: "missing" } });
			computer.socket.addEventListener("message", listen);
			computer.socket.send(`${TRIGGERS_ENVELOPE}${JSON.stringify({ protocol: PROTOCOL, type: "hello", runtimeId, connectionId: "connection-3", lastEpoch: 1, pending: 0 })}}`);
			// The link from before, still open, heard of the new draft; the new connection takes its place in the same durable epoch, as the space kept it.
			await vi.waitFor(() => expect(reconciles.at(-1)).toMatchObject({ connectionId: "connection-3", serverEpoch: 1, sources: [] }));

			// The agent asks; the person is asked exactly for this source on this computer, with no timeout to decide it for them.
			let told: ReturnType<typeof lastToolResult> = { text: "", isError: false, images: [] };
			faux.setResponses([
				toolUse("trigger_computer_grant", { triggerId: "syslog" }),
				(context) => {
					told = lastToolResult(context.messages);
					return toolUse("send_to_user", { message: "Done." });
				},
			]);
			const said = say("Watch my syslog.");
			const approval = await pendingApproval();
			expect(approval).toMatchObject({ action: COMPUTER_GRANT_ACTION, args: { space: OWNER, runtimeId, triggerId: "syslog", sourceId: "syslog#1", configHash: expect.any(String) }, expiresAt: null });
			expect(approval.summary).toContain("`tail -F /var/log/syslog`");
			expect((await post(`/approvals/${approval.id}/approve`)).body).toMatchObject({ status: "approved", result: expect.stringMatching(/^Granted: /) });
			expect(await said).toMatchObject({ status: "done" });
			expect(told.text).toContain("Granted: ");
			const granted = await runInDurableObject(agent(), (pim: Pim) => pim.triggerEngine()!.store.get("syslog"));
			expect(granted).toMatchObject({ revision: 2, spec: { authorizationRef: approval.id } });

			// Enabled, the computer is told to run it, with its grant, and the space keeps a wake to renew the lease.
			expect(await runInDurableObject(agent(), (pim: Pim) => pim.triggerEngine()!.store.setLifecycle({ id: "syslog", to: "enabled", expectedRevision: 2 }))).toMatchObject({ ok: true });
			await vi.waitFor(() => expect(reconciles.at(-1)!.sources).toEqual([expect.objectContaining({ triggerId: "syslog", grant: expect.objectContaining({ grantRef: approval.id }) })]));
			expect(await runInDurableObject(agent(), async (pim: Pim) => (await pim.listSchedules()).filter((schedule) => schedule.callback === TRIGGER_TICK_CALLBACK).length)).toBeGreaterThan(0);

			// Revoked, it is taken off the computer at once, and the trigger needs a grant again.
			const before = reconciles.length;
			expect(await runInDurableObject(agent(), (pim: Pim) => pim.revokeComputerGrant(approval.id))).toBe(true);
			await vi.waitFor(() => expect(reconciles.length).toBeGreaterThan(before));
			expect(reconciles.at(-1)!.sources).toEqual([]);
			expect(await runInDurableObject(agent(), (pim: Pim) => pim.triggerEngine()!.store.get("syslog")!.health)).toBe("auth_required");
		} finally {
			computer.socket.removeEventListener("message", listen);
			await runInDurableObject(agent(), async (pim: Pim) => {
				pim.triggerEngine()?.store.remove({ id: "syslog" });
				await pim.disableTriggerEngine();
			});
		}
		expect(await offeredTools()).not.toContain("trigger_computer_grant");
	});

	it("is offline while it isn't connected, with the same tools", async () => {
		computer.socket.close(1000, "Going away");
		await vi.waitFor(async () => expect((await status()).state).toBe("offline"));
		expect(await status()).toMatchObject({ computer: { hostname: "test-box" } });
		expect((await api("/files")).status).toBe(503);
		const read = await callTool("file_read", { path: "/workspace/trips/lisbon.md" });
		expect(read).toMatchObject({ isError: true, text: expect.stringContaining("offline") });
		expect(await offeredTools()).toContain("file_read");

		// Connecting again brings it back; a second connection takes the place of the first.
		computer = await connectComputer(token, ROOT);
		const second = await connectComputer(token, ROOT);
		expect((await computer.closed).code).toBe(4409);
		expect((await api("/files")).status).toBe(200);
		computer = second;
	});

	it("is removed with its tools, and its token stops working; its files stay on it", async () => {
		expect((await raw("/computer", { method: "DELETE" })).status).toBe(200);
		expect((await computer.closed).code).toBe(4409);
		expect(await status()).toEqual({ state: "none", managed: false, pairedAt: null, computer: null, error: null });
		expect((await opens("/computer/connect", token)).status).toBe(401);
		expect(await offeredTools()).not.toContain("file_read");
		expect((await api("/files")).status).toBe(404);
		expect(await fs.readFile(`${ROOT}/trips/lisbon.md`, "utf8")).toContain("Lisbon");
	});
});

describe("a computer this Pim's host keeps", () => {
	const directory = () => env.Directory.getByName("directory");
	const sync = (token: string, body: unknown) =>
		exports.default.fetch(new Request("https://pim.test/api/computer-host/sync", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
	type Requests = { requests: { id: string; op: string; name: string; token?: string }[] };

	it("is asked of the host for each space, connects with its own token, and can't be replaced or removed", async () => {
		expect(await status()).toMatchObject({ state: "none" });
		const host = await directory().pairComputerHost();
		expect(host).toMatch(/^pimh_/);

		// Looked at, the space's computer is asked of the host, and is the space's from then on.
		expect(await status()).toMatchObject({ state: "offline", managed: true, computer: null, error: null });
		expect((await post("/computer")).status).toBe(409);
		expect((await raw("/computer", { method: "DELETE" })).status).toBe(409);
		expect(await offeredTools()).toContain("shell");

		// Only the host's token opens its work, which it gets once, until it says how it went.
		expect((await sync(`${host.slice(0, -2)}xx`, { results: [] })).status).toBe(401);
		expect((await sync(token, { results: [] })).status).toBe(401);
		// Checking its token, as `pim-host install` does, takes no work and doesn't count as the host connecting.
		expect(await (await sync(host, { results: [], check: true })).json()).toEqual({ requests: [] });
		expect(await directory().computerHost()).toMatchObject({ connected: false, seenAt: null });
		const first = await sync(host, { results: [], machines: [], image: "ghcr.io/trycua/omarchy:edge", kind: "vm", version: "0.1.0" });
		expect(first.status).toBe(200);
		const { requests } = await first.json<Requests>();
		const name = `pim-${OWNER.replace("_", "-")}`;
		expect(requests).toEqual([{ id: expect.any(String), op: "create", name, token: expect.stringMatching(new RegExp(`^pimc_${OWNER}_`)) }]);
		expect((await (await sync(host, { results: [] })).json<Requests>()).requests).toEqual([]);

		// It couldn't be made: the person hears why, and asking again gives the host a new token, which the old one doesn't open.
		await sync(host, { results: [{ id: requests[0]!.id, error: "No room on the machine for another computer" }] });
		expect(await status()).toMatchObject({ state: "offline", managed: true, error: "No room on the machine for another computer" });
		expect((await post("/computer", { managed: true })).status).toBe(201);
		const [again] = (await (await sync(host, { results: [] })).json<Requests>()).requests;
		expect(again).toMatchObject({ op: "create", name });
		expect(again!.token).not.toBe(requests[0]!.token);
		expect((await opens("/computer/connect", requests[0]!.token!)).status).toBe(401);
		await sync(host, { results: [{ id: again!.id }], machines: [{ name, running: true }] });
		expect(await directory().computerHost()).toMatchObject({ paired: true, connected: true, image: "ghcr.io/trycua/omarchy:edge", kind: "vm", machines: 1, running: 1, pending: 0 });

		// Set up, it connects with its token, with its desktop to show.
		const streams: { heard: string[]; closed: boolean; say(data: string | Uint8Array): void }[] = [];
		const screen: ScreenHost = {
			async clipboard() {
				return "copied on the computer";
			},
			async open(onMessage, onClose) {
				const stream = { heard: [] as string[], closed: false, say: onMessage };
				streams.push(stream);
				// The media plane speaks first, as soon as it opens.
				onMessage(JSON.stringify({ type: "hello", payload: { protocol: "rcdp" } }));
				return {
					send: (data) => stream.heard.push(data),
					close: () => {
						stream.closed = true;
						onClose();
					},
				};
			},
		};
		// Its agents use its desktop's apps with Cua Driver, which answers as Cua Driver would.
		const driven: { tool: string; args: Record<string, unknown> }[] = [];
		const driver: DriverHost = {
			async call(tool, args) {
				driven.push({ tool, args });
				if (tool === "get_desktop_state") {
					return { content: [{ type: "image", data: btoa(String.fromCharCode(...PNG)), mimeType: "image/png" }, { type: "text", text: "pid=3547 window_id=7 \"Untitled - Mousepad\"" }] };
				}
				return { content: [{ type: "text", text: `${tool} done` }] };
			},
		};
		const hosted = await connectTestComputer(again!.token!, `/tmp/computer-${crypto.randomUUID()}`, async () => answer({ command: "true" }), undefined, screen, driver);
		expect(await status()).toMatchObject({ state: "online", managed: true, error: null, computer: { screen: true, desktop: true } });

		// Looking runs at once, and shows the model the screen; acting asks first, naming what it does, and then runs in the agent's own driver session.
		expect(await offeredTools()).toEqual(expect.arrayContaining(["desktop_look", "desktop_read", "desktop_act"]));
		const looked = await callTool("desktop_look", {});
		expect(looked).toMatchObject({ isError: false, images: ["image/png"] });
		expect(looked.text).toContain("Untitled - Mousepad");
		faux.setResponses([
			toolUse("desktop_act", { action: "type_text", pid: 3547, window_id: 7, text: "Dear Ada," }),
			toolUse("send_to_user", { message: "Typed." }),
		]);
		const typing = say("Start the letter.");
		const typed = await pendingApproval();
		expect(typed.summary).toBe("Type “Dear Ada,” on your computer in app 3547");
		await post(`/approvals/${typed.id}/approve`);
		await typing;
		expect(driven.map(({ tool }) => tool)).toEqual(["get_desktop_state", "type_text"]);
		expect(driven[1]!.args).toEqual({ pid: 3547, window_id: 7, text: "Dear Ada,", session: driven[0]!.args.session });
		expect(driven[0]!.args.session).toMatch(/^pim-/);

		// Only the person's own signed-in browser shows the desktop, which takes input as if at the computer: not an API token.
		expect((await opens("/computer/screen", TOKEN)).status).toBe(403);
		const viewer = await exports.default.fetch(
			new Request(apiUrl("/computer/screen"), { headers: { Upgrade: "websocket", origin: "https://pim.test", cookie: await signedIn() } }),
		);
		expect(viewer.status).toBe(101);

		// The app shows its desktop: what the stream says reaches the app as it is, video as binary, and the app's input reaches the stream.
		const shown: (string | Uint8Array)[] = [];
		viewer.webSocket!.binaryType = "arraybuffer";
		viewer.webSocket!.addEventListener("message", (event) => {
			shown.push(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
		});
		viewer.webSocket!.accept();
		await vi.waitFor(() => expect(shown).toEqual([JSON.stringify({ type: "hello", payload: { protocol: "rcdp" } })]));
		const packet = Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 3, 123, 125, 0xff, 0x00, 0x7f);
		streams[0]!.say(packet);
		await vi.waitFor(() => expect(shown[1]).toEqual(packet));
		const input = JSON.stringify({ type: "interactive_input", payload: { first_sequence: 1, events: [{ kind: "text_commit", text: "hi" }] } });
		viewer.webSocket!.send(input);
		await vi.waitFor(() => expect(streams[0]!.heard).toEqual([input]));

		// The app times its round trips: the space answers with what it said and its own round trip to the computer, and the stream never hears of it.
		viewer.webSocket!.send(JSON.stringify({ type: "pim_ping", payload: { sent: 1234.5 } }));
		await vi.waitFor(() => expect(shown).toHaveLength(3));
		const pong = JSON.parse(shown[2] as string) as { type: string; payload: { sent: number; computer_ms: unknown } };
		expect(pong).toMatchObject({ type: "pim_pong", payload: { sent: 1234.5 } });
		expect(pong.payload.computer_ms).toEqual(expect.any(Number));
		expect(streams[0]!.heard).toEqual([input]);

		// What the person copied on the computer comes back to the app, which the stream never hears of either.
		viewer.webSocket!.send(JSON.stringify({ type: "pim_clipboard", payload: {} }));
		await vi.waitFor(() => expect(shown).toHaveLength(4));
		expect(JSON.parse(shown[3] as string)).toEqual({ type: "pim_clipboard_text", payload: { text: "copied on the computer" } });
		expect(streams[0]!.heard).toEqual([input]);

		// Closing the app closes the stream.
		viewer.webSocket!.close(1000);
		await vi.waitFor(() => expect(streams[0]!.closed).toBe(true));

		// A computer that disconnects takes its streams with it: the app showing one hears so, and connects again once it's back.
		const second = await exports.default.fetch(
			new Request(apiUrl("/computer/screen"), { headers: { Upgrade: "websocket", origin: "https://pim.test", cookie: await signedIn() } }),
		);
		const closedWith = new Promise<number>((resolve) => second.webSocket!.addEventListener("close", (event) => resolve(event.code)));
		second.webSocket!.accept();
		await vi.waitFor(() => expect(streams).toHaveLength(2));
		hosted.socket.close(1000);
		await hosted.closed;
		expect(await closedWith).toBe(4000);

		// Without a host, people connect their own computer again.
		await directory().forgetComputerHost();
		expect(await directory().computerHost()).toMatchObject({ paired: false });
		await runInDurableObject(agent(), (instance: Pim) => instance.computer.forget());
		expect(await status()).toMatchObject({ state: "none", managed: false });
	});

	it("is set up, like a person's own computer, by the install script this Pim serves for its address", async () => {
		const response = await exports.default.fetch(new Request("https://pim.test/install.sh"));
		expect(response.status).toBe(200);
		const script = await response.text();
		expect(script).toContain('PIM_URL="${PIM_URL:-https://pim.test}"');
		expect(script).toContain('host) program=pim-host; variable=PIM_HOST_TOKEN ;;');
		expect(script).toContain('computer) program=pim-computer; variable=PIM_COMPUTER_TOKEN ;;');
	});

	it("is forgotten when it was a Sprite Pim started before, which nothing reaches anymore", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			instance.store.setMeta("computer_machine", "pim-o-sprite");
			await instance.onStart();
		});
		expect(await status()).toEqual({ state: "none", managed: false, pairedAt: null, computer: null, error: null });
		// So the person can connect a computer of their own again.
		expect((await post("/computer")).status).toBe(201);
		await runInDurableObject(agent(), (instance: Pim) => instance.computer.forget());
	});
});

describe("browser calls name their thread", () => {
	it("carries the thread on browser_status, browser_connect, browser_disconnect and browser_stop, and keeps one channel for each", async () => {
		const meta = new Map<string, string>([["computer_token", "x"]]);
		const sent: { op: string; args: Record<string, unknown> }[] = [];
		let channels = 0;
		const computer: Computer = new Computer({
			meta: { meta: (key) => meta.get(key), setMeta: (key, value) => void meta.set(key, value), deleteMeta: (key) => void meta.delete(key) },
			sockets: () => [
				{
					readyState: WebSocket.OPEN,
					send: (raw: string) => {
						const message = JSON.parse(raw) as { type: string; id: string; op: string; args: Record<string, unknown> };
						if (message.type !== "call") return;
						sent.push({ op: message.op, args: message.args });
						const result = message.op === "browser_connect" ? { channel: ++channels } : message.op === "browser_status" ? { available: true, running: false } : null;
						queueMicrotask(() => computer.receive(JSON.stringify({ type: "reply", id: message.id, result })));
					},
				} as never,
			],
			screen: () => {},
		});
		await computer.browserStatus("conv-a");
		const a = await computer.connectBrowser("conv-a");
		const b = await computer.connectBrowser("conv-b");
		// Connecting for one thread leaves the other's connection open.
		let closed = "";
		a.onclose = () => void (closed += "a");
		b.onclose = () => void (closed += "b");
		await computer.connectBrowser("conv-b");
		expect(closed).toBe("b");
		a.close();
		await computer.stopBrowser("conv-b");
		await computer.stopBrowser();
		expect(sent.map(({ op, args }) => [op, args.thread])).toEqual([
			["browser_status", "conv-a"],
			["browser_connect", "conv-a"],
			["browser_connect", "conv-b"],
			["browser_connect", "conv-b"],
			["browser_disconnect", "conv-a"],
			["browser_stop", "conv-b"],
			["browser_stop", undefined],
		]);
		expect(sent.find((call) => call.op === "browser_disconnect")!.args.channel).toBe(1);
	});
});
