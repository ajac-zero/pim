import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { Approval } from "../src/store";
import type { Limits } from "../src/usage";
import { api, apiUrl, decisionRun, OWNER, pendingApproval, post, say, TOKEN, toolUse } from "./helpers";
import { faux, type Pim } from "./worker";

const agent = () => env.Pim.getByName(OWNER);
const setLimits = (limits: Partial<Limits> | null) => runInDurableObject(agent(), (instance: Pim) => instance.setLimits(limits));

afterEach(async () => {
	await setLimits(null);
});

const raw = (path: string, init: RequestInit = {}) =>
	exports.default.fetch(new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } }));

const upload = (path: string, body: BodyInit) => raw(`/files/content?path=${encodeURIComponent(path)}`, { method: "PUT", body });

function lastToolResult(messages: readonly Message[]): { text: string; isError: boolean } {
	const result = messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("no tool result");
	return { text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""), isError: result.isError === true };
}

async function callTool(name: string, args: Record<string, unknown>) {
	let result = { text: "", isError: false };
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

	it("are served inert, whatever they contain", async () => {
		await upload("/workspace/page.html", "<script>alert(document.cookie)</script>");
		const response = await raw("/files/content?path=/workspace/page.html");
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		await response.body?.cancel();
	});

	it("are deleted by an agent only once the person approves", async () => {
		await upload("/workspace/old/draft.txt", "first draft");
		faux.setResponses([toolUse("file_delete", { path: "/workspace/old", recursive: true }), toolUse("send_to_user", { message: "Asked." })]);
		await say("Clean up the old folder.");
		const approval = await pendingApproval();
		expect(approval.summary).toBe("Delete /workspace/old and everything in it");
		expect((await raw("/files/content?path=/workspace/old/draft.txt")).status).toBe(200);

		faux.setResponses([toolUse("send_to_user", { message: "Deleted." })]);
		const decided = await post<Approval>(`/approvals/${approval.id}/approve`);
		expect(decided.body.status).toBe("approved");
		expect(await decisionRun(approval)).toMatchObject({ status: "done" });
		expect((await api("/files?path=/workspace/old")).status).toBe(404);
	});

	it("count toward the Pim's storage, which refuses more once full", async () => {
		await setLimits({ storageBytes: 1 });
		expect((await upload("/workspace/big.bin", new Uint8Array(10))).status).toBe(429);
		await setLimits(null);
		// The person's own delete needs no approval.
		await upload("/workspace/gone.txt", "bye");
		expect((await raw("/files?path=/workspace/gone.txt", { method: "DELETE" })).status).toBe(200);
		expect((await raw("/files/content?path=/workspace/gone.txt")).status).toBe(404);
	});

	it("go into the account export, binary ones as base64", async () => {
		await upload("/workspace/export/note.txt", "keep me");
		await upload("/workspace/export/pixel.bin", new Uint8Array([0, 255, 1]));
		const exported = (await (await raw("/export")).json()) as { files: { path: string; encoding?: string; content?: string }[] };
		expect(exported.files).toContainEqual(expect.objectContaining({ path: "/workspace/export/note.txt", encoding: "utf8", content: "keep me" }));
		expect(exported.files).toContainEqual(expect.objectContaining({ path: "/workspace/export/pixel.bin", encoding: "base64", content: "AP8B" }));
	});
});
