import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_NAME } from "../src/agent";
import { MAX_ARTIFACT_STORAGE_BYTES } from "../src/artifacts";
import type { Limits } from "../src/usage";
import { api, apiUrl, connect, post, say, TOKEN, toolUse } from "./helpers";
import { faux, type Pim } from "./worker";

const agent = () => env.Pim.getByName(AGENT_NAME);
const setLimits = (limits: Partial<Limits> | null) => runInDurableObject(agent(), (instance: Pim) => instance.setLimits(limits));

afterEach(async () => {
	await setLimits(null);
});

/** Raw response for an artifact path, with the API token in the header. */
const raw = (path: string, init: RequestInit = {}) =>
	exports.default.fetch(new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } }));

/** What the model got back from the tool call it made last. */
function lastToolResult(messages: readonly Message[]): { text: string; isError: boolean } {
	const result = messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("no tool result");
	return {
		text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
		isError: result.isError === true,
	};
}

/** Runs one tool call through the model, as the model would, and returns what the tool answered. */
async function callTool(name: string, args: Record<string, unknown>, session = "1") {
	let result = { text: "", isError: false };
	faux.setResponses([
		toolUse(name, args as never),
		(context) => {
			result = lastToolResult(context.messages);
			return fauxAssistantMessage("Done.");
		},
	]);
	await say(`Please use ${name}`, session);
	return result;
}

const PAGE = `<!doctype html><html><head><title>Tip</title><style>body{font:16px sans-serif}</style></head><body><h1>Tip calculator</h1><p id="total">0</p><script>document.getElementById("total").textContent = String(12 * 1.2);</script></body></html>`;

async function makePage(content = PAGE, title = "Tip calculator") {
	const result = await callTool("artifact_create", { title, kind: "html", content });
	expect(result.isError).toBe(false);
	return JSON.parse(result.text).artifact as { id: string; version: number; sha256: string; size: number };
}

describe("artifacts", () => {
	it("are made by the model, answered with a reference, and kept with their source", async () => {
		const made = await makePage();
		expect(made).toMatchObject({ version: 1, size: new TextEncoder().encode(PAGE).byteLength });
		expect(made.sha256).toMatch(/^[0-9a-f]{64}$/);
		const { body: list } = await api("/artifacts");
		expect(list.artifacts).toEqual([expect.objectContaining({ id: made.id, title: "Tip calculator", kind: "html", version: 1, versions: 1, session: "1" })]);
		const { body: version } = await api(`/artifacts/${made.id}/versions/1`);
		expect(version).toMatchObject({ content: PAGE, sha256: made.sha256, source: "agent", latest: 1 });

		// Reading returns the source it was asked for.
		const read = await callTool("artifact_read", { id: made.id });
		expect(read.text).toContain(PAGE);
		const part = await callTool("artifact_read", { id: made.id, offset: PAGE.length - 10 });
		expect(part.text).toContain(PAGE.slice(-10));
		expect(part.text).not.toContain("<!doctype");
	});

	it("are described to the model without promising they can't send data out", async () => {
		const { tools } = (await api<{ tools: { name: string; description: string }[] }>("/")).body;
		const create = tools.find((tool) => tool.name === "artifact_create")!;
		expect(create.description).not.toMatch(/no network/i);
		expect(create.description).toContain("navigate itself away");
	});

	it("are shown only in an opaque sandbox that loads no resources, and never cached", async () => {
		const made = await makePage();
		const response = await raw(`/artifacts/${made.id}/versions/1/frame`);
		expect(response.status).toBe(200);
		const csp = response.headers.get("content-security-policy")!;
		const directives = csp.split(";").map((directive) => directive.trim());
		// The sandbox gives the page an opaque origin: no cookies, storage or API of this one.
		expect(directives).toContain("sandbox allow-scripts");
		for (const unsafe of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals", "allow-downloads"]) {
			expect(csp).not.toContain(unsafe);
		}
		expect(directives).toEqual(
			expect.arrayContaining(["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors https://pim.test"]),
		);
		expect(response.headers.get("cache-control")).toBe("no-store, private");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		const body = await response.text();
		// The artifact as it was made, then the one script that reports its height.
		expect(body.startsWith(PAGE)).toBe(true);
		expect(body.slice(PAGE.length)).toMatch(/^<script>.*pim:artifact-height.*<\/script>$/);
	});

	it("download as plain-text attachments with safe names and the same sandbox", async () => {
		const made = await makePage(PAGE, 'Q3 "plan"\r\nX-Evil: 1 / ünïcode');
		const response = await raw(`/artifacts/${made.id}/versions/1/download`);
		// Even HTML: a browser that shows it anyway shows its source.
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		const disposition = response.headers.get("content-disposition")!;
		expect(disposition).toMatch(/^attachment; filename="[^"\r\n]*-v1\.html"; filename\*=UTF-8''/);
		expect(disposition).not.toMatch(/[\r\n]/);
		expect(disposition).not.toContain("X-Evil: 1");
		expect(disposition).toContain(encodeURIComponent("ünïcode"));
		expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
		expect(response.headers.get("cache-control")).toBe("no-store, private");
		expect(await response.text()).toBe(PAGE);

		// Markdown is never served as anything that runs, and isn't shown in a frame.
		const notes = await callTool("artifact_create", { title: "Notes", kind: "markdown", content: "# Notes\n\n<script>alert(1)</script>" });
		const id = JSON.parse(notes.text).artifact.id;
		const markdown = await raw(`/artifacts/${id}/versions/1/download`);
		expect(markdown.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(markdown.headers.get("content-disposition")).toMatch(/-v1\.md"/);
		expect((await raw(`/artifacts/${id}/versions/1/frame`)).status).toBe(404);
	});

	it("refuse an API token in the address, which WebSockets still use", async () => {
		const made = await makePage();
		for (const path of [`/artifacts/${made.id}/versions/1/frame`, `/artifacts/${made.id}/versions/1/download`, `/artifacts/${made.id}/versions/1`, "/artifacts"]) {
			const response = await exports.default.fetch(new Request(apiUrl(`${path}?token=${TOKEN}`)));
			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toContain("application/json");
		}
		const { socket } = await connect();
		socket.close();
	});

	it("get new versions only from the latest, with edits that match once", async () => {
		const made = await makePage();
		const edited = await callTool("artifact_update", {
			id: made.id,
			base_version: 1,
			edits: [{ find: "<h1>Tip calculator</h1>", replace: "<h1>Tips</h1>" }],
		});
		expect(JSON.parse(edited.text).artifact).toMatchObject({ id: made.id, version: 2 });
		expect((await api(`/artifacts/${made.id}/versions/2`)).body.content).toBe(PAGE.replace("<h1>Tip calculator</h1>", "<h1>Tips</h1>"));

		// Based on version 1, which is no longer the latest: refused, and nothing is written.
		const stale = await callTool("artifact_update", { id: made.id, base_version: 1, content: "<p>Overwritten</p>" });
		expect(stale).toMatchObject({ isError: true });
		expect(stale.text).toContain("not the latest");
		// A find text that isn't there, or is there twice, changes nothing.
		const missing = await callTool("artifact_update", { id: made.id, base_version: 2, edits: [{ find: "<h2>", replace: "" }] });
		expect(missing.isError).toBe(true);
		const twice = await callTool("artifact_update", { id: made.id, base_version: 2, edits: [{ find: "body", replace: "main" }] });
		expect(twice.text).toContain("more than once");
		// The same content again makes no version.
		const same = await callTool("artifact_update", { id: made.id, base_version: 2, content: (await api(`/artifacts/${made.id}/versions/2`)).body.content });
		expect(JSON.parse(same.text).artifact.version).toBe(2);
		expect((await api(`/artifacts/${made.id}`)).body).toMatchObject({ version: 2, versions: 2 });
	});

	it("restore an older version as a new one, only from the latest", async () => {
		const made = await makePage();
		await callTool("artifact_update", { id: made.id, base_version: 1, content: "<p>Second</p>" });
		expect((await post(`/artifacts/${made.id}/restore`, { version: 1, baseVersion: 1 })).status).toBe(409);
		const restored = await post(`/artifacts/${made.id}/restore`, { version: 1, baseVersion: 2 });
		expect(restored.status).toBe(201);
		expect(restored.body).toMatchObject({ version: 3, versions: 3, sha256: made.sha256, restored: 3 });
		const { body } = await api(`/artifacts/${made.id}`);
		// Nothing was rewritten: every version is still there as it was made.
		expect(body.history.map((version: { version: number; source: string; restoredFrom: number | null }) => [version.version, version.source, version.restoredFrom])).toEqual([
			[3, "restore", 1],
			[2, "agent", null],
			[1, "agent", null],
		]);
		expect((await post(`/artifacts/${made.id}/restore`, { version: 9, baseVersion: 3 })).status).toBe(404);
	});

	it("are deleted with every version, and are in the export until then", async () => {
		const made = await makePage();
		await callTool("artifact_update", { id: made.id, base_version: 1, content: "<p>Second</p>" });
		const exported = JSON.parse(await (await raw("/export")).text());
		const mine = exported.artifacts.find((artifact: { id: string }) => artifact.id === made.id);
		expect(mine.versions.map((version: { version: number; content: string }) => [version.version, version.content])).toEqual([
			[1, PAGE],
			[2, "<p>Second</p>"],
		]);

		expect((await api(`/artifacts/${made.id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await raw(`/artifacts/${made.id}/versions/1/frame`)).status).toBe(404);
		expect((await raw(`/artifacts/${made.id}/versions/2/download`)).status).toBe(404);
		expect((await api(`/artifacts/${made.id}`, { method: "DELETE" })).status).toBe(404);
		const rows = await runInDurableObject(agent(), (_instance: Pim, state) =>
			state.storage.sql.exec("SELECT COUNT(*) AS count FROM pim_artifact_versions WHERE artifact = ?", made.id).one().count,
		);
		expect(rows).toBe(0);
		// The model can't find it either.
		expect((await callTool("artifact_read", { id: made.id })).isError).toBe(true);
	});

	it("export in full near their total cap, which holds whatever the limits say", async () => {
		// Ten versions of nearly 1 MB each, made straight in the store: about the most artifacts can hold.
		const ids = await runInDurableObject(agent(), async (instance: Pim) => {
			const made: string[] = [];
			const room = MAX_ARTIFACT_STORAGE_BYTES - instance.artifacts.totalBytes();
			const size = 950_000;
			for (let index = 0; index < Math.floor(room / size); index++) {
				const id = crypto.randomUUID();
				await instance.artifacts.create({ id, title: `Big ${index}`, kind: "html", content: `<p>${"z".repeat(size - 7)}</p>`, session: null });
				made.push(id);
			}
			return made;
		});
		try {
		expect(ids.length).toBeGreaterThanOrEqual(9);
		// Even with no limits set, the cap holds.
		// Two writes racing for the room left, each fitting alone: one is refused, and the hard cap holds.
		const race = await runInDurableObject(agent(), async (instance: Pim) => {
			const room = MAX_ARTIFACT_STORAGE_BYTES - instance.artifacts.totalBytes();
			const size = Math.floor(room * 0.6);
			const made: string[] = [];
			const settle = (id: string) =>
				instance.artifacts.create({ id, title: "Racing for room", kind: "html", content: "q".repeat(size), session: null }).then(
					() => (made.push(id), "ok"),
					(error: { status?: number }) => error.status,
				);
			const outcomes = await Promise.all([settle(crypto.randomUUID()), settle(crypto.randomUUID())]);
			const total = instance.artifacts.totalBytes();
			for (const id of made) instance.artifacts.delete(id);
			return { outcomes: outcomes.sort(), withinCap: total <= MAX_ARTIFACT_STORAGE_BYTES };
		});
		expect(race).toEqual({ outcomes: [429, "ok"], withinCap: true });
		const left = MAX_ARTIFACT_STORAGE_BYTES - (await api("/artifacts")).body.bytes;
		expect(left).toBeLessThan(950_000);
		// In a chat of its own: what it sends stays out of the others' context.
		const chat = (await post("/sessions")).body.id;
		const over = await callTool("artifact_create", { title: "Over the cap", kind: "html", content: "x".repeat(left + 1) }, chat);
		expect(over.text).toContain("in all");
		const response = await raw("/export");
		expect(response.status).toBe(200);
		const exported = JSON.parse(await response.text());
		const big = exported.artifacts.filter((artifact: { id: string }) => ids.includes(artifact.id));
		expect(big).toHaveLength(ids.length);
		expect(big.every((artifact: { versions: { content: string }[] }) => artifact.versions[0]!.content.length === 950_000)).toBe(true);
		} finally {
			for (const id of ids) expect((await api(`/artifacts/${id}`, { method: "DELETE" })).status).toBe(200);
		}
	});

	it("change nothing on a refused write: not the title, time, latest version, history or content", async () => {
		const refusals = await runInDurableObject(agent(), async (instance: Pim) => {
			const id = crypto.randomUUID();
			await instance.artifacts.create({ id, title: "Kept", kind: "html", content: "<p>1</p>", session: null });
			await instance.artifacts.append(id, { baseVersion: 1, content: "<p>2</p>", source: "agent" });
			const snapshot = () =>
				JSON.stringify({ artifact: instance.artifacts.get(id), history: instance.artifacts.versions(id), content: instance.artifacts.version(id)!.content });
			const before = snapshot();
			const attempt = async (limits: Partial<Limits> | null, baseVersion: number, content: string) => {
				await instance.setLimits(limits);
				const status = await instance.artifacts.append(id, { baseVersion, content, source: "agent", title: "Renamed" }).then(
					() => "written",
					(error: { status?: number }) => error.status,
				);
				return { status, unchanged: snapshot() === before };
			};
			const results = {
				tooBig: await attempt({ artifactBytes: 10 }, 2, "x".repeat(11)),
				tooManyVersions: await attempt({ artifactVersions: 2 }, 2, "<p>3</p>"),
				tooMuchInAll: await attempt({ artifactStorageBytes: instance.artifacts.totalBytes() + 5 }, 2, "x".repeat(6)),
				stale: await attempt(null, 1, "<p>3</p>"),
				restoreStale: await instance.artifacts.restore(id, 1, 1).then(() => "written", (error: { status?: number }) => error.status),
			};
			const afterRestore = snapshot() === before;
			await instance.setLimits(null);
			instance.artifacts.delete(id);
			return { ...results, afterRestore };
		});
		expect(refusals).toEqual({
			tooBig: { status: 413, unchanged: true },
			tooManyVersions: { status: 429, unchanged: true },
			tooMuchInAll: { status: 429, unchanged: true },
			stale: { status: 409, unchanged: true },
			restoreStale: 409,
			afterRestore: true,
		});
	});

	it("take one of two writes racing on the same version, and keep to their limits when writes race", async () => {
		const outcome = await runInDurableObject(agent(), async (instance: Pim) => {
			const settle = (work: Promise<unknown>) =>
				work.then(
					() => "ok",
					(error: { status?: number; message?: string }) => error.status ?? error.message,
				);
			const id = crypto.randomUUID();
			await instance.artifacts.create({ id, title: "Race", kind: "html", content: "<p>1</p>", session: null });
			// The agent's edit and the person's restore, both based on version 1.
			const raced = await Promise.all([
				settle(instance.artifacts.append(id, { baseVersion: 1, content: "<p>2</p>", source: "agent" })),
				settle(instance.artifacts.restore(id, 1, 1)),
			]);
			// Two new artifacts that each fit, but not both.
			await instance.setLimits({ artifactStorageBytes: instance.artifacts.totalBytes() + 1_500 });
			const big = (index: number) =>
				settle(instance.artifacts.create({ id: crypto.randomUUID(), title: `Racer ${index}`, kind: "html", content: "r".repeat(1_000), session: null }));
			const created = await Promise.all([big(1), big(2)]);
			const total = instance.artifacts.totalBytes();
			const limit = instance.limits().artifactStorageBytes!;
			// A refused version changes nothing: not the title, the latest version or its content.
			const before = JSON.stringify({ ...instance.artifacts.get(id)!, content: instance.artifacts.version(id)!.content });
			await instance.setLimits({ artifactBytes: 10 });
			const renamed = await settle(instance.artifacts.append(id, { baseVersion: 2, content: "x".repeat(11), source: "agent", title: "Renamed" }));
			const after = instance.artifacts.get(id)!;
			const title = after.title;
			const unchanged = JSON.stringify({ ...after, content: instance.artifacts.version(id)!.content }) === before;
			for (const artifact of instance.artifacts.list()) if (artifact.title === "Race" || artifact.title.startsWith("Racer")) instance.artifacts.delete(artifact.id);
			return { raced: raced.sort(), created: created.sort(), withinLimit: total <= limit, renamed, title, unchanged };
		});
		expect(outcome).toEqual({ raced: [409, "ok"], created: [429, "ok"], withinLimit: true, renamed: 413, title: "Race", unchanged: true });
	});

	it("stay within their limits, checked before anything is written", async () => {
		// One version's size.
		await setLimits({ artifactBytes: 100 });
		const big = await callTool("artifact_create", { title: "Big", kind: "html", content: "x".repeat(101) });
		expect(big.isError).toBe(true);
		expect(big.text).toContain("at most 100 bytes");
		// Bytes, not characters: 50 three-byte characters are 150 bytes.
		expect((await callTool("artifact_create", { title: "Wide", kind: "markdown", content: "€".repeat(50) })).isError).toBe(true);

		// Versions of one artifact.
		await setLimits({ artifactVersions: 2 });
		const made = await makePage("<p>1</p>", "Counted");
		await callTool("artifact_update", { id: made.id, base_version: 1, content: "<p>2</p>" });
		const third = await callTool("artifact_update", { id: made.id, base_version: 2, content: "<p>3</p>" });
		expect(third.text).toContain("2 versions");
		expect((await post(`/artifacts/${made.id}/restore`, { version: 1, baseVersion: 2 })).status).toBe(429);

		// How many artifacts.
		const count = (await api("/artifacts")).body.artifacts.length;
		await setLimits({ artifacts: count });
		expect((await callTool("artifact_create", { title: "One more", kind: "html", content: "<p>no</p>" })).isError).toBe(true);

		// All of them together.
		const used = (await api("/artifacts")).body.bytes as number;
		await setLimits({ artifactStorageBytes: used + 10 });
		expect((await callTool("artifact_create", { title: "Too much", kind: "html", content: "x".repeat(11) })).isError).toBe(true);
		expect((await callTool("artifact_create", { title: "Just fits", kind: "html", content: "x".repeat(10) })).isError).toBe(false);

		// The whole Pim's storage: a write that would go over is refused before it's made, not after.
		const size = await runInDurableObject(agent(), (_instance: Pim, state) => state.storage.sql.databaseSize);
		await setLimits({ storageBytes: size + 20_000 });
		const over = await callTool("artifact_create", { title: "Overflow", kind: "html", content: "y".repeat(40_000) });
		expect(over.isError).toBe(true);
		expect(over.text).toContain("storage quota");
		expect((await api("/artifacts")).body.artifacts.some((artifact: { title: string }) => artifact.title === "Overflow")).toBe(false);
	});
});
