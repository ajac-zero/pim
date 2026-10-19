import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BRIDGE_SCRIPT, MAX_ARTIFACT_STORAGE_BYTES } from "../src/artifacts";
import type { Limits } from "../src/usage";
import { api, apiUrl, connect, OWNER, post, ROOT, say, TOKEN, toolUse } from "./helpers";
import { faux, type Pim, utility } from "./worker";

const agent = () => env.Pim.getByName(OWNER);
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
async function callTool(name: string, args: Record<string, unknown>, session = ROOT) {
	let result = { text: "", isError: false };
	faux.setResponses([
		toolUse(name, args as never),
		(context) => {
			result = lastToolResult(context.messages);
			return toolUse("send_to_user", { message: "Done." });
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
		expect(list.artifacts).toEqual([expect.objectContaining({ id: made.id, title: "Tip calculator", kind: "html", version: 1, versions: 1, session: ROOT })]);
		const { body: version } = await api(`/artifacts/${made.id}/versions/1`);
		expect(version).toMatchObject({ content: PAGE, sha256: made.sha256, source: "agent", latest: 1 });

		// Reading returns the source it was asked for.
		const read = await callTool("artifact_read", { id: made.id });
		expect(read.text).toContain(PAGE);
		const part = await callTool("artifact_read", { id: made.id, offset: PAGE.length - 10 });
		expect(part.text).toContain(PAGE.slice(-10));
		expect(part.text).not.toContain("<!doctype");

		// Found by words of its title, and shown again as the same reference, changing nothing.
		await makePage("<p>Notes</p>", "Meeting notes");
		const found = await callTool("artifact_list", { query: "CALCULATOR tip" });
		expect(found.text).toContain(made.id);
		expect(found.text).not.toContain("Meeting notes");
		expect((await callTool("artifact_list", { query: "robot" })).text).toBe("No artifact's title has robot.");
		const shown = await callTool("artifact_show", { id: made.id });
		expect(JSON.parse(shown.text).artifact).toEqual({ ...made, title: "Tip calculator", kind: "html" });
		expect((await api(`/artifacts/${made.id}`)).body).toMatchObject({ version: 1, history: [expect.anything()] });
		expect((await callTool("artifact_show", { id: made.id, version: 2 })).isError).toBe(true);
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
		// The artifact as it was made, with the bridge after its doctype, then the one script that reports its height.
		const doctype = "<!doctype html>";
		const page = doctype + BRIDGE_SCRIPT + PAGE.slice(doctype.length);
		expect(body.startsWith(page)).toBe(true);
		expect(body.slice(page.length)).toMatch(/^<script>.*pim:artifact-height.*<\/script>$/);
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

	it("draw SVG and Mermaid in the same sandbox, loading only Pim's own runtime and only for diagrams", async () => {
		const drawing = await callTool("artifact_create", { title: "Logo", kind: "svg", content: '<svg viewBox="0 0 10 10"><circle r="4" cx="5" cy="5"/></svg>' });
		const svg = JSON.parse(drawing.text).artifact.id;
		const svgFrame = await raw(`/artifacts/${svg}/versions/1/frame`);
		expect(svgFrame.headers.get("content-security-policy")).toContain("script-src 'unsafe-inline';");
		expect(await svgFrame.text()).toMatch(/^<!doctype html>.*<body><svg viewBox="0 0 10 10"><circle r="4" cx="5" cy="5"\/><\/svg><\/body><\/html><script>/);
		expect((await raw(`/artifacts/${svg}/versions/1/download`)).headers.get("content-disposition")).toMatch(/-v1\.svg"/);

		// Diagram source is text in the page: markup in it is escaped, never parsed.
		const source = 'flowchart LR\n  A["</pre><script>parent.x=1</script>"] --> B';
		const diagram = await callTool("artifact_create", { title: "Flow", kind: "mermaid", content: source });
		const mermaid = JSON.parse(diagram.text).artifact.id;
		const mermaidFrame = await raw(`/artifacts/${mermaid}/versions/1/frame`);
		const directives = mermaidFrame.headers.get("content-security-policy")!.split(";").map((directive) => directive.trim());
		expect(directives).toEqual(expect.arrayContaining(["sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "script-src 'unsafe-inline' https://pim.test/artifact-runtime/"]));
		const page = await mermaidFrame.text();
		expect(page).toContain('<pre class="mermaid">flowchart LR\n  A["&lt;/pre&gt;&lt;script&gt;parent.x=1&lt;/script&gt;"] --&gt; B</pre>');
		expect(page).toContain('<script src="https://pim.test/artifact-runtime/mermaid.js"></script>');
		expect(page).not.toContain("<script>parent.x=1");
		expect((await raw(`/artifacts/${mermaid}/versions/1/download`)).headers.get("content-disposition")).toMatch(/-v1\.mmd"/);

		// Content its kind can't show is refused, to the model, before anything is kept.
		const notSvg = await callTool("artifact_create", { title: "Bad", kind: "svg", content: "<div>hi</div>" });
		expect(notSvg).toMatchObject({ isError: true, text: expect.stringContaining("<svg") });
		const broken = await callTool("artifact_update", { id: svg, base_version: 1, content: "<p>no</p>" });
		expect(broken.isError).toBe(true);
		expect((await api(`/artifacts/${svg}`)).body.version).toBe(1);
	});

	it("run JSX compiled, on Pim's React runtime and only the modules it imports, and refuse what won't run", async () => {
		const source = `import { useState } from "react";
import { LineChart, Line } from "recharts";
export default function App() {
	const [count, setCount] = useState<number>(0);
	const note = "</script><script>parent.x=1</script> <!-- <script>";
	return <div className="p-4" onClick={() => setCount(count + 1)} title={note}>{count}<LineChart data={[]}><Line /></LineChart></div>;
}`;
		const made = await callTool("artifact_create", { title: "Counter", kind: "jsx", content: source });
		expect(made.isError).toBe(false);
		const id = JSON.parse(made.text).artifact.id;
		// The stored version is the source; the frame is what it compiles to.
		expect((await api(`/artifacts/${id}/versions/1`)).body.content).toBe(source);
		const frame = await raw(`/artifacts/${id}/versions/1/frame`);
		expect(frame.headers.get("content-security-policy")).toContain("script-src 'unsafe-inline' https://pim.test/artifact-runtime/");
		const page = await frame.text();
		const sources = [...page.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
		expect(sources).toEqual(["https://pim.test/artifact-runtime/react.js", "https://pim.test/artifact-runtime/recharts.js", "https://pim.test/artifact-runtime/tailwind.js"]);
		// The page closes only its own scripts: the bridge, those, the component, and the height script. Its strings can't close one.
		expect(page.match(/<\/script>/g)).toHaveLength(6);
		expect(page).toContain("<\\/script><script>parent.x=1<\\/script> <\\!-- <script>");
		expect(page).not.toContain("useState<number>");
		expect((await raw(`/artifacts/${id}/versions/1/download`)).headers.get("content-disposition")).toMatch(/-v1\.jsx"/);

		for (const [content, error] of [
			["export default () => <div>", "doesn't compile"],
			['import fs from "node:fs";\nexport default () => <div>{String(fs)}</div>', 'not "node:fs"'],
			["export function App() { return <div /> }", "export its component as the default"],
		] as const) {
			const refused = await callTool("artifact_create", { title: "Bad", kind: "jsx", content });
			expect(refused).toMatchObject({ isError: true, text: expect.stringContaining(error) });
		}
		expect((await api("/artifacts")).body.artifacts.filter((artifact: { kind: string }) => artifact.kind === "jsx")).toHaveLength(1);
	});

	it("span several files: a page's scripts, styles and images, and an app's modules, data and styles, put inline when shown", async () => {
		// An image from the person's files, copied in.
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		expect((await raw("/files/content?path=/workspace/dot.png", { method: "PUT", body: png })).status).toBeLessThan(300);
		const page = `<!doctype html><html><head><link rel="stylesheet" href="./style.css"><link rel="stylesheet" href="https://example.com/x.css"></head>
<body><img src="images/dot.png"><p id="out"></p><script type="application/json" id="data" src="data.json"></script><script src="app.js"></script><script src="missing.js"></script></body></html>`;
		const made = await callTool("artifact_create", {
			title: "Several",
			kind: "html",
			content: page,
			files: [
				{ path: "app.js", content: 'document.getElementById("out").textContent = JSON.parse(document.getElementById("data").textContent).name + "</script>";' },
				{ path: "style.css", content: "body{background:url(images/dot.png)} p{color:red} /* </style><script>x</script> */" },
				{ path: "data.json", content: '{"name":"Ada"}' },
				{ path: "images/dot.png", from_file: "/workspace/dot.png" },
			],
		});
		expect(made.isError).toBe(false);
		const { id, files } = JSON.parse(made.text).artifact;
		expect(files).toEqual(["app.js", "data.json", "images/dot.png", "index.html", "style.css"]);
		const dot = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;
		const html = await (await raw(`/artifacts/${id}/versions/1/frame`)).text();
		expect(html).toContain(`<img src="${dot}">`);
		expect(html).toContain(`<style>body{background:url("${dot}")} p{color:red} /* <\\/style><script>x</script> */</style>`);
		expect(html).toContain('<link rel="stylesheet" href="https://example.com/x.css">');
		expect(html).toContain('<script type="application/json" id="data">{"name":"Ada"}</script>');
		expect(html).toContain('+ "<\\/script>";</script>');
		expect(html).toContain('<script src="missing.js"></script>');
		// The model reads one file at a time, and the person downloads each.
		const read = await callTool("artifact_read", { id, path: "app.js" });
		expect(read.text).toContain("Its files: app.js");
		expect((await callTool("artifact_read", { id, path: "images/dot.png" })).text).toContain("image/png file of 7 bytes");
		expect((await api(`/artifacts/${id}/versions/1?path=data.json`)).body).toMatchObject({ path: "data.json", content: '{"name":"Ada"}' });
		const download = await raw(`/artifacts/${id}/versions/1/download?path=images/dot.png`);
		expect(download.headers.get("content-disposition")).toContain('-v1-dot.png"');
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(png);

		// A change to one file keeps the others, and deleting one takes it out.
		const edited = await callTool("artifact_update", { id, base_version: 1, path: "data.json", edits: [{ find: "Ada", replace: "Bo" }], delete_files: ["images/dot.png"] });
		expect(JSON.parse(edited.text).artifact).toMatchObject({ version: 2, files: ["app.js", "data.json", "index.html", "style.css"] });
		expect(await (await raw(`/artifacts/${id}/versions/2/frame`)).text()).toContain('{"name":"Bo"}');
		expect((await callTool("artifact_update", { id, base_version: 2, delete_files: ["index.html"] })).text).toContain("main file");
		expect((await callTool("artifact_create", { title: "Doc", kind: "markdown", content: "# Hi", files: [{ path: "a.md", content: "x" }] })).text).toContain("Only HTML and JSX");
		expect((await callTool("artifact_create", { title: "Bad path", kind: "html", content: "<p>", files: [{ path: "../up.js", content: "x" }] })).isError).toBe(true);

		// An app of modules: components, JSON, CSS and an image, compiled into one script.
		const app = await callTool("artifact_create", {
			title: "App",
			kind: "jsx",
			content: 'import Chart from "./components/Chart";\nimport rows from "./data.json";\nimport "./app.css";\nexport default function App() { return <Chart rows={rows} />; }',
			files: [
				{ path: "components/Chart.tsx", content: 'import logo from "../logo.png";\nimport { LineChart } from "recharts";\nexport default function Chart({ rows }: { rows: number[] }) { return <div><img src={logo} />{rows.length}<LineChart data={[]} /></div>; }' },
				{ path: "data.json", content: "[1, 2, 3]" },
				{ path: "app.css", content: ".x{color:red}" },
				{ path: "logo.png", from_file: "/workspace/dot.png" },
			],
		});
		expect(app.isError).toBe(false);
		const appPage = await (await raw(`/artifacts/${JSON.parse(app.text).artifact.id}/versions/1/frame`)).text();
		expect(appPage).toContain("https://pim.test/artifact-runtime/recharts.js");
		expect(appPage).toContain('"components/Chart.tsx": [function');
		expect(appPage).toContain(`module.exports = ${JSON.stringify(dot)};`);
		expect(appPage).toContain('{"./components/Chart":"components/Chart.tsx","./data.json":"data.json","./app.css":"app.css"}');
		expect(appPage).not.toContain("rows: number[]");
		const broken = await callTool("artifact_create", { title: "Broken", kind: "jsx", content: 'import Missing from "./Missing";\nexport default () => <Missing />;' });
		expect(broken.text).toContain('imports "./Missing", which isn\'t one of the artifact\'s files');
	});

	it("keep their own data through the bridge, and ask the model only once the person allows the version", async () => {
		const made = await makePage();
		const bridge = (op: string, args: unknown, version = 1) => post(`/artifacts/${made.id}/versions/${version}/bridge`, { op, args });
		// The page gets the bridge first, after its doctype, so it stays in standards mode and its scripts find it.
		const page = await (await raw(`/artifacts/${made.id}/versions/1/frame`)).text();
		expect(page).toMatch(/^<!doctype html><script>.*window\.pim=.*<\/script><html><head><title>Tip<\/title>/);

		expect((await bridge("storage.get", { key: "tips" })).body).toEqual({ value: null });
		expect((await bridge("storage.set", { key: "tips", value: "[10,15]" })).body).toEqual({ value: null });
		await bridge("storage.set", { key: "tip:last", value: "15" });
		await bridge("storage.set", { key: "other", value: "x" });
		expect((await bridge("storage.list", { prefix: "tip" })).body).toEqual({ value: ["tip:last", "tips"] });
		expect((await bridge("storage.set", { key: "n", value: 5 })).status).toBe(400);
		expect((await bridge("storage.set", { key: "", value: "x" })).status).toBe(400);
		expect((await bridge("storage.set", { key: "big", value: "x".repeat(1_000_000) })).status).toBe(413);
		await bridge("storage.delete", { key: "other" });
		// Kept across versions, and in the export.
		await callTool("artifact_update", { id: made.id, base_version: 1, content: "<p>Second</p>" });
		expect((await bridge("storage.get", { key: "tips" }, 2)).body).toEqual({ value: "[10,15]" });
		const exported = JSON.parse(await (await raw("/export")).text());
		expect(exported.artifacts.find((artifact: { id: string }) => artifact.id === made.id).data).toEqual({ "tip:last": "15", tips: "[10,15]" });

		// The model: asked for permission, then answered, and only for the version allowed.
		expect((await bridge("model.ask", { prompt: "A tip tip" })).body).toEqual({ needs: { capability: "model", label: "model" } });
		expect((await post(`/artifacts/${made.id}/versions/1/grants`, { capability: "model" })).status).toBe(201);
		utility.setResponses([fauxAssistantMessage("Round up.")]);
		expect((await bridge("model.ask", { prompt: "A tip tip" })).body).toEqual({ value: "Round up." });
		expect((await bridge("model.ask", { prompt: "A tip tip" }, 2)).body).toMatchObject({ needs: { capability: "model" } });
		expect((await post(`/artifacts/${made.id}/versions/1/grants`, { capability: "everything" })).status).toBe(400);
		expect((await bridge("fetch", {})).status).toBe(400);

		// Deleting the artifact deletes what it kept.
		await api(`/artifacts/${made.id}`, { method: "DELETE" });
		await runInDurableObject(agent(), (instance: Pim) => {
			expect(instance.artifacts.dataBytes(made.id, "own")).toBe(0);
		});
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

	it("take the person's edits as new versions, only from the latest, which the model then reads as theirs", async () => {
		const made = await makePage();
		const saved = await post(`/artifacts/${made.id}/versions`, { baseVersion: 1, content: "<p>Mine</p>", title: "My page" });
		expect(saved.status).toBe(201);
		expect(saved.body).toMatchObject({ version: 2, title: "My page", saved: 2, changed: true });
		// The agent's base is now stale, and so is a second edit from version 1.
		const stale = await callTool("artifact_update", { id: made.id, base_version: 1, content: "<p>Agent</p>" });
		expect(stale.text).toContain("not the latest");
		expect((await post(`/artifacts/${made.id}/versions`, { baseVersion: 1, content: "<p>Late</p>" })).status).toBe(409);
		// The same content again makes no version; content the kind can't show makes none either.
		expect((await post(`/artifacts/${made.id}/versions`, { baseVersion: 2, content: "<p>Mine</p>" })).body).toMatchObject({ version: 2, changed: false });
		const drawing = await callTool("artifact_create", { title: "Logo", kind: "svg", content: "<svg></svg>" });
		const svg = JSON.parse(drawing.text).artifact.id;
		expect((await post(`/artifacts/${svg}/versions`, { baseVersion: 1, content: "<div></div>" })).status).toBe(400);

		const read = await callTool("artifact_read", { id: made.id });
		expect(read.text).toContain('"My page" (html), version 2 of 2 (edited by the user)');
		expect(read.text).toContain("<p>Mine</p>");
		const { body } = await api(`/artifacts/${made.id}`);
		expect(body.history.map((version: { source: string }) => version.source)).toEqual(["person", "agent"]);
	});

	it("are deleted with every version, and are in the export until then", async () => {
		const made = await makePage();
		await callTool("artifact_update", { id: made.id, base_version: 1, content: "<p>Second</p>" });
		const exported = JSON.parse(await (await raw("/export")).text());
		const mine = exported.artifacts.find((artifact: { id: string }) => artifact.id === made.id);
		const contents = new Map(exported.artifactFiles.map((file: { sha256: string; content: string }) => [file.sha256, file.content]));
		expect(
			mine.versions.map((version: { version: number; files: { path: string; sha256: string }[] }) => [
				version.version,
				version.files.map((file) => [file.path, contents.get(file.sha256)]),
			]),
		).toEqual([
			[1, [["index.html", PAGE]]],
			[2, [["index.html", "<p>Second</p>"]]],
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

	it("keep each file once in R2, free it when no version has it, and read versions from before files", async () => {
		const stored = (hash: string) => env.ARTIFACTS.head(`${OWNER}/${hash}`).then((object) => object !== null);
		const outcome = await runInDurableObject(agent(), async (instance: Pim, state) => {
			const content = `<p>Shared by two ${crypto.randomUUID()}</p>`;
			const one = await instance.artifacts.create({ id: crypto.randomUUID(), title: "One", kind: "html", content, session: null });
			const before = instance.artifacts.fileBytes();
			const two = await instance.artifacts.create({ id: crypto.randomUUID(), title: "Two", kind: "html", content, session: null });
			const hash = one.files[0]!.sha256;
			const counted = instance.artifacts.fileBytes() - before;
			await instance.artifacts.delete(one.artifact);
			const keptForTwo = await stored(hash);
			await instance.artifacts.delete(two.artifact);
			const freed = !(await stored(hash));

			// A version from before files: its one file in the version row, and none listed.
			const old = crypto.randomUUID();
			const page = "<p>From before files</p>";
			const oldHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(page)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
			state.storage.sql.exec("INSERT INTO pim_artifacts (id, title, kind, session, head, created_at, updated_at) VALUES (?, 'Old', 'html', NULL, 1, 0, 0)", old);
			state.storage.sql.exec(
				"INSERT INTO pim_artifact_versions (artifact, version, content, sha256, size, source, restored_from, call_id, created_at) VALUES (?, 1, ?, ?, ?, 'agent', NULL, NULL, 0)",
				old,
				page,
				oldHash,
				page.length,
			);
			const read = await instance.artifacts.text(old, 1);
			const listed = instance.artifacts.version(old, 1)!.files;
			const inR2Before = await stored(oldHash);
			// Someone else needs it: it moves to R2, keeping its hash, so permissions given to it still hold.
			const moved = await instance.artifacts.stored(old, 1);
			const inR2After = await stored(oldHash);
			const row = state.storage.sql.exec("SELECT content, sha256 FROM pim_artifact_versions WHERE artifact = ?", old).one();
			const readAfter = await instance.artifacts.text(old, 1);
			// A new version keeps its files: the unchanged one isn't stored again.
			const next = await instance.artifacts.append(old, { baseVersion: 1, files: { "extra.css": "p{color:red}" }, source: "agent" });
			await instance.artifacts.delete(old);
			const freedOld = !(await stored(oldHash));
			return {
				counted: counted === 0,
				keptForTwo,
				freed,
				read,
				listed,
				inR2Before,
				moved: moved.sha256 === oldHash && inR2After,
				freedOld,
				row: { content: row.content, sha256: row.sha256 === oldHash },
				readAfter,
				next: next.version.files.map((file) => file.path),
			};
		});
		expect(outcome).toEqual({
			counted: true,
			keptForTwo: true,
			freed: true,
			read: "<p>From before files</p>",
			listed: [{ path: "index.html", sha256: expect.any(String), size: 24, type: "text/html" }],
			inR2Before: false,
			moved: true,
			freedOld: true,
			row: { content: "", sha256: true },
			readAfter: "<p>From before files</p>",
			next: ["extra.css", "index.html"],
		});
	});

	it("are left whole when the record of their deletion can't be written", async () => {
		const outcome = await runInDurableObject(agent(), async (instance: Pim, state) => {
			const made = await instance.artifacts.create({ id: crypto.randomUUID(), title: "Whole", kind: "html", content: "<p>kept</p>", session: null });
			state.storage.sql.exec("ALTER TABLE pim_artifact_deleted RENAME TO pim_artifact_deleted_away");
			const failed = await instance.artifacts.delete(made.artifact).then(
				() => false,
				() => true,
			);
			const left = await instance.artifacts.text(made.artifact, 1);
			state.storage.sql.exec("ALTER TABLE pim_artifact_deleted_away RENAME TO pim_artifact_deleted");
			await instance.artifacts.delete(made.artifact);
			return { failed, left };
		});
		expect(outcome).toEqual({ failed: true, left: "<p>kept</p>" });
	});

	it("are not brought back by a replayed create after they were deleted", async () => {
		const outcome = await runInDurableObject(agent(), async (instance: Pim, state) => {
			const id = crypto.randomUUID();
			const input = { id, title: "Replayed", kind: "html" as const, content: "<p>secret</p>", session: null };
			await instance.artifacts.create(input);
			// Before deletion a replay returns the version it made.
			const replayed = (await instance.artifacts.create(input)).version;
			await instance.artifacts.delete(id);
			const afterDelete = await instance.artifacts.create(input).then(() => "created", (error: { status?: number }) => error.status);
			const fresh = await instance.artifacts.create({ ...input, id: crypto.randomUUID() });
			// Deleting what never existed remembers nothing; the export lists only what exists.
			const never = crypto.randomUUID();
			await instance.artifacts.delete(never);
			const tombstones = Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM pim_artifact_deleted WHERE id = ?", never).one().n);
			const exported = (await instance.artifacts.export()).artifacts.some((artifact) => artifact.id === id);
			const kept = state.storage.sql.exec("SELECT * FROM pim_artifact_deleted WHERE id = ?", id).toArray();
			await instance.artifacts.delete(fresh.artifact);
			return { replayed, afterDelete, listed: instance.artifacts.get(id), tombstones, exported, fresh: fresh.version, kept: kept.map((row) => Object.keys(row).sort()) };
		});
		expect(outcome).toEqual({ replayed: 1, afterDelete: 410, listed: undefined, tombstones: 0, exported: false, fresh: 1, kept: [["deleted_at", "id"]] });
	});

	it("export near their total cap, which holds whatever the limits say, inlining what fits and listing the rest", async () => {
		// Versions of nearly the most one can be, made straight in the store: about the most artifacts can hold.
		const size = 9_500_000;
		const ids = await runInDurableObject(agent(), async (instance: Pim) => {
			const made: string[] = [];
			const room = MAX_ARTIFACT_STORAGE_BYTES - instance.artifacts.totalBytes();
			for (let index = 0; index < Math.floor(room / size); index++) {
				const id = crypto.randomUUID();
				// Each different, so each is stored and counted.
				await instance.artifacts.create({ id, title: `Big ${index}`, kind: "html", content: `<p>${index}${"z".repeat(size - 7 - String(index).length)}</p>`, session: null });
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
				const made: string[] = [];
				const settle = (id: string, fill: string) =>
					instance.artifacts.create({ id, title: "Racing for room", kind: "html", content: fill.repeat(Math.floor(room * 0.6)), session: null }).then(
						() => (made.push(id), "ok"),
						(error: { status?: number }) => error.status,
					);
				const outcomes = await Promise.all([settle(crypto.randomUUID(), "q"), settle(crypto.randomUUID(), "r")]);
				const total = instance.artifacts.totalBytes();
				for (const id of made) await instance.artifacts.delete(id);
				return { outcomes: outcomes.sort(), withinCap: total <= MAX_ARTIFACT_STORAGE_BYTES };
			});
			expect(race).toEqual({ outcomes: [429, "ok"], withinCap: true });
			const left = MAX_ARTIFACT_STORAGE_BYTES - (await api("/artifacts")).body.bytes;
			expect(left).toBeLessThan(size);
			const over = await runInDurableObject(agent(), (instance: Pim) =>
				instance.artifacts
					.create({ id: crypto.randomUUID(), title: "Over the cap", kind: "html", content: "x".repeat(left + 1), session: null })
					.then(() => "written", (error: Error) => error.message),
			);
			expect(over).toContain("in all");
			// The same content again takes no more room: it's stored once.
			const again = await runInDurableObject(agent(), async (instance: Pim) => {
				const before = instance.artifacts.totalBytes();
				const id = crypto.randomUUID();
				const content = await instance.artifacts.text(ids[0]!, 1);
				await instance.artifacts.create({ id, title: "Twin", kind: "html", content, session: null });
				const after = instance.artifacts.totalBytes();
				await instance.artifacts.delete(id);
				return after - before;
			});
			expect(again).toBe(0);
			const response = await raw("/export");
			expect(response.status).toBe(200);
			const exported = JSON.parse(await response.text());
			const big = exported.artifacts.filter((artifact: { id: string }) => ids.includes(artifact.id));
			expect(big).toHaveLength(ids.length);
			const hashes = new Set(big.map((artifact: { versions: { files: { sha256: string }[] }[] }) => artifact.versions[0]!.files[0]!.sha256));
			const files = exported.artifactFiles.filter((file: { sha256: string }) => hashes.has(file.sha256));
			expect(files).toHaveLength(ids.length);
			const inlined = files.filter((file: { content?: string }) => file.content !== undefined);
			expect(inlined.length).toBeGreaterThanOrEqual(3);
			expect(inlined.length).toBeLessThan(ids.length);
			expect(inlined.every((file: { content: string; size: number }) => file.content.length === size && file.size === size)).toBe(true);
		} finally {
			for (const id of ids) expect((await api(`/artifacts/${id}`, { method: "DELETE" })).status).toBe(200);
		}
	});

	it("change nothing on a refused write: not the title, time, latest version, history or content", async () => {
		const refusals = await runInDurableObject(agent(), async (instance: Pim) => {
			const id = crypto.randomUUID();
			await instance.artifacts.create({ id, title: "Kept", kind: "html", content: "<p>1</p>", session: null });
			await instance.artifacts.append(id, { baseVersion: 1, content: "<p>2</p>", source: "agent" });
			const snapshot = async () =>
				JSON.stringify({ artifact: instance.artifacts.get(id), history: instance.artifacts.versions(id), content: await instance.artifacts.text(id, instance.artifacts.get(id)!.version) });
			const before = await snapshot();
			const attempt = async (limits: Partial<Limits> | null, baseVersion: number, content: string) => {
				await instance.setLimits(limits);
				const status = await instance.artifacts.append(id, { baseVersion, content, source: "agent", title: "Renamed" }).then(
					() => "written",
					(error: { status?: number }) => error.status,
				);
				return { status, unchanged: (await snapshot()) === before };
			};
			const results = {
				tooBig: await attempt({ artifactBytes: 10 }, 2, "x".repeat(11)),
				tooManyVersions: await attempt({ artifactVersions: 2 }, 2, "<p>3</p>"),
				tooMuchInAll: await attempt({ artifactStorageBytes: instance.artifacts.totalBytes() + 5 }, 2, "x".repeat(6)),
				stale: await attempt(null, 1, "<p>3</p>"),
				restoreStale: await instance.artifacts.restore(id, 1, 1).then(() => "written", (error: { status?: number }) => error.status),
			};
			const afterRestore = (await snapshot()) === before;
			await instance.setLimits(null);
			await instance.artifacts.delete(id);
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
				settle(instance.artifacts.create({ id: crypto.randomUUID(), title: `Racer ${index}`, kind: "html", content: String(index).repeat(1_000), session: null }));
			const created = await Promise.all([big(1), big(2)]);
			const total = instance.artifacts.totalBytes();
			const limit = instance.limits().artifactStorageBytes!;
			// A refused version changes nothing: not the title, the latest version or its content.
			const before = JSON.stringify({ ...instance.artifacts.get(id)!, content: await instance.artifacts.text(id, 2) });
			await instance.setLimits({ artifactBytes: 10 });
			const renamed = await settle(instance.artifacts.append(id, { baseVersion: 2, content: "x".repeat(11), source: "agent", title: "Renamed" }));
			const after = instance.artifacts.get(id)!;
			const title = after.title;
			const unchanged = JSON.stringify({ ...after, content: await instance.artifacts.text(id, after.version) }) === before;
			for (const artifact of instance.artifacts.list()) if (artifact.title === "Race" || artifact.title.startsWith("Racer")) await instance.artifacts.delete(artifact.id);
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

		// The whole space's storage: a write that would go over is refused before it's made, not after.
		const size = await runInDurableObject(agent(), (_instance: Pim, state) => state.storage.sql.databaseSize);
		await setLimits({ storageBytes: size + 20_000 });
		const over = await callTool("artifact_create", { title: "Overflow", kind: "html", content: "y".repeat(40_000) });
		expect(over.isError).toBe(true);
		expect(over.text).toContain("storage quota");
		expect((await api("/artifacts")).body.artifacts.some((artifact: { title: string }) => artifact.title === "Overflow")).toBe(false);
	});
});
