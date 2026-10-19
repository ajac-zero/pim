import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { Approval } from "../src/store";
import type { Limits } from "../src/usage";
import { api, apiUrl, OWNER, pendingApproval, post, say, TOKEN, toolUse } from "./helpers";
import { faux, paintings, type Pim } from "./worker";

const agent = () => env.Pim.getByName(OWNER);
const setLimits = (limits: Partial<Limits> | null) => runInDurableObject(agent(), (instance: Pim) => instance.setLimits(limits));

afterEach(async () => {
	await setLimits(null);
});

const raw = (path: string, init: RequestInit = {}) =>
	exports.default.fetch(new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } }));

const upload = (path: string, body: BodyInit) => raw(`/files/content?path=${encodeURIComponent(path)}`, { method: "PUT", body });

/** A 1×1 PNG, and the start of a PDF: not UTF-8, though it has no NUL byte. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));
const PDF = new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3, ...new TextEncoder().encode("\n1 0 obj\n")]);

/** How many of the space's files R2 holds. */
const storedObjects = async () => (await env.BLOBS.list({ prefix: `${OWNER}/files/` })).objects.length;

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

describe("files", () => {
	it("are one folder the person and their agents share", async () => {
		// The agent writes a file; the person finds it in a folder and downloads it.
		expect((await callTool("file_write", { path: "/workspace/trips/lisbon.md", content: "# Lisbon\nFlight TP 202" })).isError).toBe(false);
		const { body: root } = await api("/files");
		expect(root.entries).toContainEqual(expect.objectContaining({ name: "trips", path: "/workspace/trips", type: "directory" }));
		const { body: trips } = await api("/files?path=/workspace/trips");
		expect(trips.entries).toEqual([expect.objectContaining({ name: "lisbon.md", type: "file", size: 22 })]);
		const download = await raw("/files/content?path=/workspace/trips/lisbon.md&download");
		expect(await download.text()).toBe("# Lisbon\nFlight TP 202");
		expect(download.headers.get("content-disposition")).toContain('filename="lisbon.md"');

		// The person uploads one; the agent reads it.
		expect((await upload("/workspace/receipts/hotel.csv", "night,price\n1,140\n")).status).toBe(201);
		const read = await callTool("file_read", { path: "/workspace/receipts/hotel.csv" });
		expect(read.isError).toBe(false);
		expect(read.text).toContain("1,140");
	});

	it("are only the ones under /workspace, for tools and the API alike", async () => {
		for (const path of ["/workspaces/notes.md", "/workspace/../notes.md", "/notes.md"]) {
			const written = await callTool("file_write", { path, content: "secret" });
			expect(written).toMatchObject({ isError: true });
			expect(written.text).toContain("not one of the person's files");
			expect((await upload(path, "secret")).status).toBe(400);
		}
		expect((await api("/files?path=/")).status).toBe(400);
	});

	it("are what agents' code works on, with no network", async () => {
		await upload("/workspace/costs/march.csv", "item,eur\nrent,900\nfood,310.5\n");
		const source = `
			import { readFile, writeFile } from "node:fs/promises";
			export default async function () {
				const rows = (await readFile("costs/march.csv", "utf8")).trim().split("\\n").slice(1);
				const total = rows.reduce((sum, row) => sum + Number(row.split(",")[1]), 0);
				await writeFile("/workspace/costs/total.json", JSON.stringify({ total }));
				return { total, rows: rows.length };
			}`;
		const ran = await callTool("run_javascript", { command: source });
		// The result is the code's return value and output, without the code sent back.
		expect(JSON.parse(ran.text)).toEqual({ cwd: null, backend: "javascript", exitCode: 0, stdout: "", stderr: "", result: { total: 1210.5, rows: 2 } });
		expect(await (await raw("/files/content?path=/workspace/costs/total.json")).text()).toBe('{"total":1210.5}');

		const fetched = await callTool("run_javascript", { command: `export default async () => (await fetch("https://example.com")).status;` });
		expect(JSON.parse(fetched.text)).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("not permitted to access the internet") });

		const outside = await callTool("run_javascript", { command: `export default () => 1;`, cwd: "/" });
		expect(outside).toMatchObject({ isError: true });
		// Code reaches no further than the person's files either.
		const escaped = await callTool("run_javascript", {
			command: `import { writeFile } from "node:fs/promises"; export default () => writeFile("/workspace/../escaped.txt", "out");`,
		});
		expect(JSON.parse(escaped.text)).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("must stay under /workspace") });
	});

	it("are served inert, whatever they contain", async () => {
		await upload("/workspace/page.html", "<script>alert(document.cookie)</script>");
		const response = await raw("/files/content?path=/workspace/page.html");
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		await response.body?.cancel();
	});

	it("are deleted by an agent only once the person approves, stored ones too", async () => {
		await upload("/workspace/old/draft.txt", "first draft");
		const before = await storedObjects();
		await upload("/workspace/old/scan.pdf", PDF);
		expect(await storedObjects()).toBe(before + 1);
		faux.setResponses([toolUse("file_delete", { path: "/workspace/old", recursive: true }), toolUse("send_to_user", { message: "Deleted." })]);
		const cleaning = say("Clean up the old folder.");
		const approval = await pendingApproval();
		expect(approval.summary).toBe("Delete /workspace/old and everything in it");
		expect((await raw("/files/content?path=/workspace/old/draft.txt")).status).toBe(200);

		const decided = await post<Approval>(`/approvals/${approval.id}/approve`);
		expect(decided.body.status).toBe("approved");
		expect(await cleaning).toMatchObject({ status: "done", replies: ["Deleted."] });
		expect((await api("/files?path=/workspace/old")).status).toBe(404);
		expect(await storedObjects()).toBe(before);
	});

	it("count toward the space's storage, which refuses more once full", async () => {
		await setLimits({ storageBytes: 1 });
		expect((await upload("/workspace/big.bin", new Uint8Array(10))).status).toBe(429);
		await setLimits(null);
		// Stored files count too, though R2 holds them, not the space's database.
		const before = await runInDurableObject(agent(), (instance: Pim) => instance.storedBytes());
		expect((await upload("/workspace/quota/scan.pdf", new Uint8Array(100_000))).status).toBe(201);
		await setLimits({ storageBytes: before + 50_000 });
		expect((await upload("/workspace/quota/note.txt", "x")).status).toBe(429);
		await setLimits(null);
		await raw("/files?path=/workspace/quota", { method: "DELETE" });
		// The person's own delete needs no approval.
		await upload("/workspace/gone.txt", "bye");
		expect((await raw("/files?path=/workspace/gone.txt", { method: "DELETE" })).status).toBe(200);
		expect((await raw("/files/content?path=/workspace/gone.txt")).status).toBe(404);
	});

	it("go into the account export: text inline, stored files by path", async () => {
		await upload("/workspace/export/note.txt", "keep me");
		await upload("/workspace/export/pixel.bin", new Uint8Array([0, 255, 1]));
		const exported = (await (await raw("/export")).json()) as { files: { path: string; encoding?: string; content?: string }[] };
		expect(exported.files).toContainEqual(expect.objectContaining({ path: "/workspace/export/note.txt", encoding: "utf8", content: "keep me" }));
		expect(exported.files).toContainEqual({ path: "/workspace/export/pixel.bin", size: 3, updatedAt: expect.any(String) });
	});

	it("that aren't text are kept in R2, in the same folders as the rest", async () => {
		const before = await storedObjects();
		await upload("/workspace/trip/photo.png", PNG);
		await upload("/workspace/trip/ticket.pdf", PDF);
		// A character cut off where the type is judged still leaves this text.
		await upload("/workspace/trip/notes.txt", `a${"é".repeat(5000)}`);
		expect(await storedObjects()).toBe(before + 2);

		// The person sees one folder, and gets the same bytes back.
		const { body: trip } = await api("/files?path=/workspace/trip");
		expect(trip.entries.map((entry: { name: string; size: number }) => [entry.name, entry.size])).toEqual([
			["notes.txt", 10_001],
			["photo.png", PNG.length],
			["ticket.pdf", PDF.length],
		]);
		expect(new Uint8Array(await (await raw("/files/content?path=/workspace/trip/photo.png")).arrayBuffer())).toEqual(PNG);

		// Agents see them too, marked stored, and find them by name; text stays searchable.
		const listed = JSON.parse((await callTool("file_list", { path: "/workspace/trip" })).text);
		expect(listed.count).toBe(3);
		expect(listed.entries).toContainEqual(expect.objectContaining({ name: "photo.png", size: PNG.length, stored: true }));
		expect(listed.entries.find((entry: { name: string }) => entry.name === "notes.txt").stored).toBeUndefined();
		const found = JSON.parse((await callTool("file_find", { path: "/workspace", pattern: "**/*.pdf" })).text);
		expect(found.entries).toContainEqual({ path: "/workspace/trip/ticket.pdf", type: "file", stored: true });
		const pruned = JSON.parse((await callTool("file_find", { path: "/workspace", pattern: "**/*.pdf", exclude: "trip" })).text);
		expect(pruned.entries).not.toContainEqual(expect.objectContaining({ path: "/workspace/trip/ticket.pdf" }));
		expect(JSON.parse((await callTool("file_search", { path: "/workspace/trip", query: "éé" })).text).count).toBeGreaterThan(0);

		// Reading shows the model an image, and says what anything else is.
		expect((await callTool("file_read", { path: "/workspace/trip/photo.png" })).images).toEqual(["image/png"]);
		const ticket = await callTool("file_read", { path: "/workspace/trip/ticket.pdf" });
		expect(ticket).toMatchObject({ isError: false, images: [] });
		expect(ticket.text).toContain("file_load");

		// Text saved over a stored file replaces it, and deleting a folder deletes what's stored in it.
		await upload("/workspace/trip/ticket.pdf", "cancelled");
		expect(await storedObjects()).toBe(before + 1);
		expect(await (await raw("/files/content?path=/workspace/trip/ticket.pdf")).text()).toBe("cancelled");
		expect((await raw("/files?path=/workspace/trip", { method: "DELETE" })).status).toBe(200);
		expect(await storedObjects()).toBe(before);
	});

	it("that are stored reach agents' code once loaded, and what code makes that isn't text is stored", async () => {
		await upload("/workspace/data/blob.bin", new Uint8Array([0, 1, 2, 255]));
		const unseen = await callTool("run_javascript", {
			command: `import { readFile } from "node:fs/promises"; export default async () => (await readFile("data/blob.bin")).length;`,
		});
		expect(JSON.parse(unseen.text)).toMatchObject({ exitCode: 1 });
		expect((await callTool("file_load", { path: "/workspace/data/blob.bin" })).text).toContain("/workspace/.loaded/data/blob.bin");

		const before = await storedObjects();
		const ran = await callTool("run_javascript", {
			command: `
				import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
				export default async function () {
					const bytes = await readFile(".loaded/data/blob.bin");
					await mkdir("out", { recursive: true });
					await writeFile("/workspace/out/chart.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...bytes]));
					await rm("data", { recursive: true });
					return bytes.reduce((sum, byte) => sum + byte, 0);
				}`,
		});
		expect(JSON.parse(ran.text)).toMatchObject({ stderr: "", exitCode: 0, result: 258 });
		// The chart is stored; the folder code removed comes back with the file it never saw.
		expect(await storedObjects()).toBe(before + 1);
		expect(new Uint8Array(await (await raw("/files/content?path=/workspace/out/chart.png")).arrayBuffer())).toEqual(
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 1, 2, 255]),
		);
		expect((await api("/files?path=/workspace/data")).body.entries).toEqual([expect.objectContaining({ name: "blob.bin", size: 4 })]);
		// The person doesn't see agents' copies.
		expect((await api("/files")).body.entries.map((entry: { name: string }) => entry.name)).not.toContain(".loaded");

		// Text code writes over a stored file replaces it.
		await callTool("run_javascript", { command: `import { writeFile } from "node:fs/promises"; export default () => writeFile("out/chart.png", "redrawn");` });
		expect(await storedObjects()).toBe(before);
		expect(await (await raw("/files/content?path=/workspace/out/chart.png")).text()).toBe("redrawn");
	});

	it("include the images agents make, each counted as a model request", async () => {
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
		expect(new Uint8Array(await (await raw(`/files/content?path=${encodeURIComponent(image.path)}`)).arrayBuffer())).toEqual(PNG);
		expect(paintings.slice(before.paintings)).toEqual([{ model, fields: { prompt: "A red fox asleep in snow, watercolor", width: "768", height: "1280" } }]);
		expect(await requests()).toBe(before.requests + 1);

		// A path the agent names gets the extension it lacks; one outside the files is refused before anything is drawn.
		expect(JSON.parse((await callTool("generate_image", { prompt: "A lighthouse", path: "/workspace/cards/lighthouse" })).text).image.path).toBe(
			"/workspace/cards/lighthouse.png",
		);
		const outside = await callTool("generate_image", { prompt: "A lighthouse", path: "/etc/lighthouse.png" });
		expect(outside).toMatchObject({ isError: true, text: expect.stringContaining("not one of the person's files") });
		expect(paintings.length).toBe(before.paintings + 2);
		expect(await requests()).toBe(before.requests + 2);
	});
});
