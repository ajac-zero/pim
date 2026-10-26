import * as fs from "node:fs/promises";
import { Workspace } from "@cloudflare/computer";
import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { NATIVE_TOOL_OP, readNativeOutcome } from "../computer/native-outcome";
import { type ExecArgs, type ExecResult, Link, type Machine } from "../computer/pim-computer";
import { IDLE_MS } from "../src/computer";
import type { Approval } from "../src/store";
import { api, apiUrl, connectTestComputer, opens, OWNER, pendingApproval, post, say, TOKEN, testBrowser, toolUse } from "./helpers";
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
let answer: (args: ExecArgs) => ExecResult = (args) => ({ exitCode: 0, signal: null, stdout: `ran ${args.command}\n`, stderr: "", timedOut: false, truncated: false });

const connectComputer = (token: string, root: string) =>
	connectTestComputer(token, root, async (args) => {
		ran.push(args);
		return answer(args);
	});

const ROOT = `/tmp/computer-${crypto.randomUUID()}`;
let computer: Awaited<ReturnType<typeof connectComputer>>;
let token = "";

describe("a space without a computer", () => {
	it("has no files, and no tools that need them", async () => {
		expect(await status()).toEqual({ state: "none", managed: false, pairedAt: null, computer: null, startable: true });
		expect((await api("/files")).status).toBe(404);
		const tools = await offeredTools();
		expect(tools).toContain("send_to_user");
		for (const tool of ["file_read", "file_write", "file_delete", "shell", "generate_image", "browser_open", "browser_click", "browser_screenshot"]) {
			expect(tools).not.toContain(tool);
		}
		const permissions = (await api("/permissions")).body.tools.map((permission: { name: string }) => permission.name);
		for (const tool of ["shell", "browser_click"]) expect(permissions).not.toContain(tool);
		expect((await api("/browser")).body).toEqual({ available: false, takeOver: true, page: null });
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
		expect(approval.summary).toBe("Run on your computer: npm test");
		expect(ran).toEqual([]);
		await post(`/approvals/${approval.id}/approve`);
		await testing;
		expect(ran).toEqual([{ command: "npm test", cwd: "/workspace/project", timeoutMs: 30_000, maxBytes: 64_000 }]);
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
		expect(await status()).toEqual({ state: "none", managed: false, pairedAt: null, computer: null, startable: true });
		expect((await opens("/computer/connect", token)).status).toBe(401);
		expect(await offeredTools()).not.toContain("file_read");
		expect((await api("/files")).status).toBe(404);
		expect(await fs.readFile(`${ROOT}/trips/lisbon.md`, "utf8")).toContain("Lisbon");
	});
});

describe("a computer Pim starts", () => {
	it("is a Sprite, set up once, woken when needed and let go when unused, and removed with everything on it", async () => {
		const requests: string[] = [];
		const launches: { cmd: string[]; letGo: boolean; closed: boolean; server: WebSocket }[] = [];
		const root = `/tmp/computer-${crypto.randomUUID()}`;
		// Its Chrome, which goes on running in these tests where a Sprite's would quit and open its pages again.
		const browser = testBrowser();
		/** A frame of an exec's output: its stream, then its bytes. */
		const frame = (stream: number, text: string) => {
			const bytes = new TextEncoder().encode(text);
			const framed = new Uint8Array(bytes.byteLength + 1);
			framed[0] = stream;
			framed.set(bytes, 1);
			return framed;
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			if (url.host !== "api.sprites.dev") throw new Error(`This test reaches only Sprites, not ${url}`);
			expect(request.headers.get("Authorization")).toBe("Bearer sprites-test-token");
			requests.push(`${request.method} ${url.pathname}`);
			if (url.pathname === "/v1/sprites" && request.method === "POST") return Response.json({ name: (await request.json<{ name: string }>()).name, status: "cold" }, { status: 201 });
			if (!url.pathname.endsWith("/exec")) return new Response(null, { status: 204 });
			const cmd = url.searchParams.getAll("cmd");
			const { 0: client, 1: server } = new WebSocketPair();
			server.binaryType = "arraybuffer";
			server.accept();
			if (!cmd.some((arg) => arg.includes("--stdio"))) {
				// Setting it up, which succeeds.
				server.send(Uint8Array.of(3, 0));
				return new Response(null, { status: 101, webSocket: client });
			}
			// pim-computer --stdio: the real Link, over the test's folder, a line at a time.
			await fs.mkdir(root, { recursive: true });
			const machine: Machine = {
				root: await fs.realpath(root),
				exec: async () => {
					throw new Error("This test's computer runs no commands.");
				},
				browser,
			};
			const launch = { cmd, letGo: false, closed: false, server };
			launches.push(launch);
			const link = new Link(machine, (message) => server.send(frame(1, `${message}\n`)));
			server.addEventListener("message", (event) => {
				const data = new Uint8Array(event.data as ArrayBuffer);
				if (data[0] === 4) {
					// Its input ended: it exits, as pim-computer does.
					launch.letGo = true;
					server.send(Uint8Array.of(3, 0));
					server.close(1000);
				} else for (const line of new TextDecoder().decode(data.subarray(1)).split("\n")) if (line) link.receive(line);
			});
			server.addEventListener("close", () => {
				launch.closed = true;
				link.close();
			});
			const hello = { type: "hello", version: 1, agent: "pim-computer/test", hostname: "sprite", platform: "linux", arch: "x64", user: "sprite", root: machine.root, browser: "chrome" };
			server.send(frame(1, `${JSON.stringify(hello)}\n`));
			return new Response(null, { status: 101, webSocket: client });
		});

		expect(await status()).toMatchObject({ state: "none", startable: true });
		const started = await post<Record<string, unknown>>("/computer", { managed: true });
		expect(started.status).toBe(201);
		// It's set up, then woken once, so it says what it is.
		expect(started.body).toMatchObject({ state: "online", managed: true, computer: { hostname: "sprite" } });
		expect(started.body.token).toBeUndefined();
		const name = new RegExp(`^GET /v1/sprites/pim-${OWNER.replace("_", "-")}-[0-9a-z]+/exec$`);
		expect(requests).toEqual(["POST /v1/sprites", expect.stringMatching(name), expect.stringMatching(name)]);
		const sprite = requests[1]!.slice("GET ".length, -"/exec".length);
		// pim-computer comes from this Pim.
		expect(launches[0]!.cmd.at(-1)).toBe("https://pim.test");
		// Another can't be paired in its place.
		expect((await post("/computer")).status).toBe(409);
		expect(await offeredTools()).toContain("shell");

		// What's asked of it is done there, through pim-computer's input and output.
		expect((await upload("/workspace/notes.md", "Started")).status).toBe(201);
		expect(await (await raw(`/files/content?path=${encodeURIComponent("/workspace/notes.md")}`)).text()).toBe("Started");

		// Just used, the space holds on to it; unused, it lets go, and the Sprite sleeps.
		await runInDurableObject(agent(), (instance: Pim) => instance.computer.letGoIfIdle());
		expect(launches[0]).toMatchObject({ letGo: false, closed: false });
		await runInDurableObject(agent(), (instance: Pim) => instance.computer.letGoIfIdle(Date.now() + IDLE_MS));
		await vi.waitFor(() => expect(launches[0]).toMatchObject({ letGo: true, closed: true }));
		expect(await status()).toMatchObject({ state: "offline", managed: true, computer: { hostname: "sprite" } });

		// Needed, it's woken again, and what was asked of it is done.
		expect((await upload("/workspace/notes.md", "Woke up")).status).toBe(201);
		expect(launches.length).toBe(2);
		expect(await (await raw(`/files/content?path=${encodeURIComponent("/workspace/notes.md")}`)).text()).toBe("Woke up");

		// The agents browse there. Asleep, its browser isn't running: the person sees the page it showed, and taking it over wakes it there.
		const notes = `data:text/html;charset=utf-8,${encodeURIComponent("<title>Notes</title><p>Woke up</p>")}`;
		await callTool("browser_open", { url: notes });
		// The Sprite goes away, as when it sleeps; its socket is the space's, so it's closed there.
		await runInDurableObject(agent(), () => launches[1]!.server.close(1000));
		await vi.waitFor(async () => expect((await api("/browser")).body.page).toEqual({ url: notes, title: "Notes", asleep: true }));
		const watching = await opens("/browser/live", TOKEN);
		const heard: { type: string }[] = [];
		watching.webSocket!.addEventListener("message", (event) => heard.push(JSON.parse(event.data as string)));
		watching.webSocket!.accept();
		await vi.waitFor(() => expect(heard).toContainEqual({ type: "page", url: notes, title: "Notes" }));
		expect(launches.length).toBe(3);
		expect((await api("/browser")).body.page).toEqual({ url: notes, title: "Notes" });

		// Removing it removes the Sprite, with everything on it.
		expect((await raw("/computer", { method: "DELETE" })).status).toBe(200);
		expect(requests.at(-1)).toBe(`DELETE ${sprite}`);
		await vi.waitFor(() => expect(launches[2]).toMatchObject({ letGo: true, closed: true }));
		expect(await status()).toMatchObject({ state: "none", managed: false });
	});
});

describe("pim-computer's optional native-app dispatcher", () => {
	const SECRET = "hunter2-secret-text";
	const request = { owner: "ada", agentId: "a1", runId: "r1", callId: "c1", tool: "click", arguments: { x: 1 } };
	const completed = { status: "completed", isError: false, code: null, content: [{ type: "text", text: "ok" }], presentation: [] };

	/** A Link over a temp folder, with the stand-in dispatcher if given, and a way to send it a call and read the reply. */
	async function link(native?: Machine["native"]) {
		const root = `/tmp/computer-native-${crypto.randomUUID()}`;
		await fs.mkdir(root, { recursive: true });
		const machine: Machine = {
			root: await fs.realpath(root),
			exec: async () => ({ exitCode: 0, signal: null, stdout: "ran", stderr: "", timedOut: false, truncated: false }),
			...(native ? { native } : {}),
		};
		const replies: Record<string, unknown>[] = [];
		const wire = new Link(machine, (message) => replies.push(JSON.parse(message)));
		return {
			async call(op: string, args: unknown) {
				const id = crypto.randomUUID();
				wire.receive(JSON.stringify({ type: "call", id, op, args }));
				await vi.waitFor(() => expect(replies.some((reply) => reply.id === id)).toBe(true));
				return replies.find((reply) => reply.id === id) as { result?: unknown; error?: { message: string; code?: string } };
			},
			replies,
		};
	}

	it("answers ENOSYS when no dispatcher was given", async () => {
		const reply = await (await link()).call(NATIVE_TOOL_OP, request);
		expect(reply.error?.code).toBe("ENOSYS");
		expect(reply).not.toHaveProperty("result");
	});

	it("gives the dispatcher only the request, once, and sends back its outcomes as results", async () => {
		const outcomes = [completed, { status: "rejected", reason: "busy" }, { status: "rpc_error", code: -32602 }, { status: "unknown", reason: "timeout" }];
		for (const outcome of outcomes) {
			const native = vi.fn(async () => outcome);
			const reply = await (await link(native)).call(NATIVE_TOOL_OP, request);
			expect(native).toHaveBeenCalledTimes(1);
			expect(native).toHaveBeenCalledWith(request);
			expect(reply.error).toBeUndefined();
			expect(readNativeOutcome(reply.result)).toEqual(outcome);
		}
	});

	it("keeps an unknown outcome unknown, and a bad one unreadable to the space", async () => {
		const unknown = await (await link(() => ({ status: "unknown", reason: "transport" }))).call(NATIVE_TOOL_OP, request);
		expect(readNativeOutcome(unknown.result)).toEqual({ status: "unknown", reason: "transport" });

		const circular: Record<string, unknown> = { status: "completed" };
		circular.self = circular;
		const bad: unknown[] = [undefined, null, "completed", [], { status: "done" }, { status: "completed", isError: false }, circular, { status: "unknown", reason: SECRET }];
		for (const answer of bad) {
			const native = vi.fn(() => answer);
			const reply = await (await link(native)).call(NATIVE_TOOL_OP, request);
			expect(native).toHaveBeenCalledTimes(1);
			// Either an error, or a result the space's own check refuses: never a known outcome.
			expect(reply.error ? null : readNativeOutcome(reply.result)).toBeNull();
			expect(JSON.stringify(reply)).not.toContain(SECRET);
		}
	});

	it("answers a throwing or rejecting dispatcher with a fixed error that carries nothing it said", async () => {
		for (const native of [
			() => {
				throw new Error(SECRET);
			},
			async () => {
				throw Object.assign(new Error(SECRET), { code: SECRET });
			},
			() => ({ toJSON: () => { throw new Error(SECRET); } }),
		]) {
			const reply = await (await link(native)).call(NATIVE_TOOL_OP, request);
			expect(reply.error?.code).toBe("EIO");
			expect(reply).not.toHaveProperty("result");
			expect(JSON.stringify(reply)).not.toContain(SECRET);
		}
	});

	it("refuses a malformed call without calling the dispatcher", async () => {
		const native = vi.fn(() => completed);
		const wire = await link(native);
		const bad = [
			undefined,
			{},
			{ ...request, extra: 1 },
			{ ...request, owner: 1 },
			{ ...request, arguments: [] },
			{ ...request, arguments: null },
			{ owner: "ada", agentId: "a1", runId: "r1", callId: "c1", tool: "click" },
		];
		for (const args of bad) expect((await wire.call(NATIVE_TOOL_OP, args)).error?.code).toBe("EINVAL");
		expect(native).not.toHaveBeenCalled();
	});

	it("calls once per call and leaves other operations as they were", async () => {
		const native = vi.fn(() => completed);
		const wire = await link(native);
		await wire.call(NATIVE_TOOL_OP, request);
		await wire.call(NATIVE_TOOL_OP, request);
		expect(native).toHaveBeenCalledTimes(2);

		expect((await wire.call("exec", { command: "true" })).result).toMatchObject({ stdout: "ran" });
		expect((await wire.call("stat", { path: "/workspace" })).result).toMatchObject({ isDirectory: true });
		expect((await wire.call("launch_app", { name: "x" })).error?.code).toBe("ENOSYS");
		expect((await (await link()).call("browser_stop", {})).error?.code).toBe("ENOSYS");
		expect(native).toHaveBeenCalledTimes(2);
	});
});
