// What an app does through `window.pim` over a real PostgreSQL with every migration applied: what it keeps (own and shared scope, limits, its viewer's space only),
// the grants that a new version asks for again, the model through a stand-in OpenAI-compatible server, a connector tool through a stand-in MCP server and only
// when the tool is On, and the sandboxed page an HTML or JSX app is shown as.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { adminCompatRoutes } from "../src/compat/admin.ts";
import { bridgeRoutes } from "../src/compat/app-bridge.ts";
import { createStack, type Stack } from "./support/stack.ts";

const listen = (server: Server) => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));

describe("an app's bridge and its page", () => {
	let stack: Stack;
	let app: App;
	let gate: Server;
	let model: Server;
	let mcp: Server;
	let spotify: Server;
	let spotifyId = "";
	let base: string;
	const asked: string[] = [];
	let connectorId = "";
	const people: Record<string, { token: string; ownerId: string }> = {};
	const call = async (who: string, method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${people[who]!.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const text = await res.text();
		return { status: res.status, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, headers: res.headers };
	};
	const bridge = (who: string, id: string, version: number, op: string, args: unknown = {}) => call(who, "POST", `/api/artifacts/${id}/versions/${version}/bridge`, { op, args });

	beforeAll(async () => {
		stack = await createStack();
		model = createServer(async (req, res) => {
			let body = "";
			for await (const c of req) body += c;
			const messages = JSON.parse(body).messages as { content: string }[];
			asked.push(messages.at(-1)!.content);
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `answer to ${messages.at(-1)!.content}` } }] }));
		});
		const modelUrl = await listen(model);
		mcp = createServer(async (req, res) => {
			let body = "";
			for await (const c of req) body += c;
			const rpc = body ? JSON.parse(body) : {};
			res.setHeader("content-type", "application/json");
			if (rpc.method === "initialize") return res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "1" } } }));
			if (rpc.method === "tools/call") return res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `ran ${rpc.params.name} ${JSON.stringify(rpc.params.arguments)}` }] } }));
			res.statusCode = 202;
			res.end();
		});
		const mcpUrl = await listen(mcp);
		// Spotify's Web API, as the native connector's tools call it.
		spotify = createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(req.url?.startsWith("/v1/search") && req.headers.authorization === "Bearer spotify-token" ? { tracks: { items: [{ name: "Fado", uri: "spotify:track:1", duration_ms: 1000, artists: [{ name: "Ana" }], album: { name: "Lisboa" } }] } } : {}));
		});
		const spotifyUrl = await listen(spotify);
		process.env.PIM_CONNECTOR_ALLOW_PRIVATE = "1";
		app = new App(connectApp(stack.url("gate"), 6), new MemoryObjectStore());
		const ada = await app.identity.register({ username: "ada", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000) });
		await app.identity.setRegistrationOpen({ kind: "user", ownerId: ada.ownerId, role: "admin", sessionId: "s" }, true);
		const bob = await app.identity.register({ username: "bob" });
		for (const [name, a] of [["ada", ada], ["bob", bob]] as const) people[name] = { ownerId: a.ownerId, token: await app.identity.createSession(a.ownerId) };
		const principal = { kind: "user", ownerId: ada.ownerId, role: "admin", sessionId: "s" } as never;
		const { connector } = await app.connectors.create(principal, { kind: "custom_mcp", name: "Notes", url: mcpUrl });
		await app.connectors.recordDiscovery(ada.ownerId, connector.id, [{ name: "read", annotations: { readOnlyHint: true } }, { name: "write" }]);
		await app.connectors.setEnabledTools(principal, connector.id, ["read", "write"]);
		connectorId = connector.id;
		// A native connector: Pim's own client of the service, with the person's credential and no MCP server behind it.
		const native = await app.connectors.create(principal, { kind: "native", name: "Spotify" });
		await app.db.owner(ada.ownerId, (tx) => tx.query("UPDATE pim_app.connectors SET app_ref = 'spotify/spotify', status = 'connected' WHERE id = $1", [native.connector.id]));
		await app.connectors.setCredential(ada.ownerId, native.connector.id, JSON.stringify({ access_token: "spotify-token", token_type: "Bearer" }));
		await app.connectors.recordDiscovery(ada.ownerId, native.connector.id, [{ name: "search", annotations: { readOnlyHint: true } }, { name: "play" }]);
		await app.connectors.setEnabledTools(principal, native.connector.id, ["search", "play"]);
		spotifyId = native.connector.id;
		gate = createGate(app, { first: [...bridgeRoutes({ PIM_SPOTIFY_API_URL: `${spotifyUrl}/v1`, PIM_AI_GATEWAY_URL: modelUrl, PIM_AI_GATEWAY_MODELS: "m", PIM_DEFAULT_MODEL: "gateway/m", PIM_CONNECTOR_ALLOW_PRIVATE: "1" }), ...adminCompatRoutes] });
		base = await listen(gate);
	}, 120_000);
	afterAll(async () => {
		for (const s of [gate, model, mcp, spotify]) await new Promise<void>((r) => s?.close(() => r()));
		await app?.db.end();
		await stack?.drop();
	});

	const html = (n: string) => ({ "index.html": `<!doctype html><p>${n}</p>` });

	it("keeps text per person and per app, within limits, and lets a circle's members share one scope", async () => {
		const id = (await call("ada", "POST", "/api/apps", { title: "Counter", kind: "html", files: html("1") })).json.id;
		expect((await bridge("ada", id, 1, "storage.get", { key: "n" })).json).toEqual({ value: null });
		await bridge("ada", id, 1, "storage.set", { key: "n", value: "3" });
		await bridge("ada", id, 1, "storage.set", { key: "n:2", value: "4" });
		expect((await bridge("ada", id, 1, "storage.get", { key: "n" })).json).toEqual({ value: "3" });
		expect((await bridge("ada", id, 1, "storage.list", { prefix: "n" })).json).toEqual({ value: ["n", "n:2"] });
		expect((await bridge("ada", id, 1, "storage.list", { prefix: "n:" })).json).toEqual({ value: ["n:2"] });
		// A new version keeps it; a number is not text; a key is bounded; a value is bounded per app.
		await call("ada", "POST", `/api/artifacts/${id}/versions`, { baseVersion: 1, content: "<!doctype html><p>2</p>" });
		expect((await bridge("ada", id, 2, "storage.get", { key: "n" })).json).toEqual({ value: "3" });
		expect((await bridge("ada", id, 2, "storage.set", { key: "n", value: 3 })).status).toBe(400);
		expect((await bridge("ada", id, 2, "storage.set", { key: "k".repeat(201), value: "x" })).status).toBe(400);
		const part = (key: string, n: number) => bridge("ada", id, 2, "storage.set", { key, value: "x".repeat(n) });
		expect((await part("big", 600_000)).status).toBe(200);
		expect((await part("big2", 600_000)).status).toBe(413);
		expect((await part("big2", 390_000)).status).toBe(200);
		// Replacing a key counts what it held as freed.
		expect((await part("big", 600_000)).status).toBe(200);
		expect((await bridge("ada", id, 2, "nope.x")).status).toBe(400);
		await bridge("ada", id, 2, "storage.delete", { key: "big" });
		expect((await bridge("ada", id, 2, "storage.get", { key: "big" })).json).toEqual({ value: null });

		// Bob cannot reach ada's app at all, and what he keeps for a shared one is his own.
		expect((await bridge("bob", id, 1, "storage.get", { key: "n" })).status).toBe(404);
		const circle = (await call("ada", "POST", "/api/circles", { name: "Friends" })).json;
		await call("ada", "POST", `/api/circles/${circle.id}/members`, { username: "bob" });
		await call("ada", "PUT", `/api/artifacts/${id}/circles`, { circles: [circle.id] });
		const viaBob = (op: string, args: unknown) => call("bob", "POST", `/api/shared-artifacts/ada/${id}/versions/2/bridge`, { op, args });
		expect((await viaBob("storage.get", { key: "n" })).json).toEqual({ value: null });
		await viaBob("storage.set", { key: "n", value: "bob's" });
		expect((await bridge("ada", id, 2, "storage.get", { key: "n" })).json).toEqual({ value: "3" });
		// What everyone using it sees is the owner's, written by either.
		await viaBob("shared.set", { key: "board", value: "from bob" });
		expect((await bridge("ada", id, 2, "shared.get", { key: "board" })).json).toEqual({ value: "from bob" });
		expect((await bridge("ada", id, 2, "storage.get", { key: "board" })).json).toEqual({ value: null });
		// A stale version of someone else's app is not theirs to use, and leaving the circle ends all of it.
		expect((await call("bob", "POST", `/api/shared-artifacts/ada/${id}/versions/1/bridge`, { op: "shared.get", args: { key: "board" } })).status).toBe(404);
		await call("ada", "PUT", `/api/artifacts/${id}/circles`, { circles: [] });
		expect((await viaBob("shared.get", { key: "board" })).status).toBe(404);
		// Deleting the app deletes what it kept.
		await call("ada", "DELETE", `/api/artifacts/${id}`);
		const left = await app.db.owner(people.ada!.ownerId, async (tx) => (await tx.query("SELECT count(*)::int AS n FROM pim_app.app_data WHERE app_key = $1", [id])).rows[0].n);
		expect(left).toBe(0);
	});

	it("asks the model only after the person grants it for this version, and asks again for a new one", async () => {
		const id = (await call("ada", "POST", "/api/apps", { title: "Ask", kind: "html", files: html("a") })).json.id;
		expect((await bridge("ada", id, 1, "model.ask", { prompt: "hi" })).json).toEqual({ needs: { capability: "model", label: "model" } });
		expect(asked).toEqual([]);
		expect((await bridge("ada", id, 1, "model.ask", { prompt: " " })).status).toBe(400);
		expect((await bridge("ada", id, 1, "model.ask", { prompt: "x".repeat(20_001) })).status).toBe(413);
		expect((await call("ada", "POST", `/api/artifacts/${id}/versions/1/grants`, { capability: "model" })).status).toBe(201);
		expect((await bridge("ada", id, 1, "model.ask", { prompt: "hi" })).json).toEqual({ value: "answer to hi" });
		expect(asked).toEqual(["hi"]);
		await call("ada", "POST", `/api/artifacts/${id}/versions`, { baseVersion: 1, content: "<!doctype html><p>b</p>" });
		expect((await bridge("ada", id, 2, "model.ask", { prompt: "hi" })).json).toMatchObject({ needs: { capability: "model" } });
		expect((await call("ada", "POST", `/api/artifacts/${id}/versions/2/grants`, { capability: "bogus" })).status).toBe(400);
	});

	it("calls a connector tool only after the person grants it to this version of the app, whatever agents may do with it", async () => {
		const id = (await call("ada", "POST", "/api/apps", { title: "Tool", kind: "html", files: html("t") })).json.id;
		const c = connectorId;
		expect((await bridge("ada", id, 1, "tools.call", { name: `${c}/read`, input: { q: 1 } })).json).toEqual({ needs: { capability: `tool:${c}/read`, label: "Notes: read" } });
		// No agent has the tool, and the person's grant is what an app needs: it asks for a tool with effects as it does for any other.
		expect((await bridge("ada", id, 1, "tools.call", { name: "write" })).json).toEqual({ needs: { capability: `tool:${c}/write`, label: "Notes: write" } });
		expect((await bridge("ada", id, 1, "tools.call", { name: "missing" })).status).toBe(404);
		await call("ada", "POST", `/api/artifacts/${id}/versions/1/grants`, { capability: `tool:${c}/read` });
		expect((await bridge("ada", id, 1, "tools.call", { name: "read", input: { q: 1 } })).json).toEqual({ value: 'ran read {"q":1}' });
		await call("ada", "POST", `/api/artifacts/${id}/versions/1/grants`, { capability: `tool:${c}/write` });
		expect((await bridge("ada", id, 1, "tools.call", { name: "write", input: { q: 2 } })).json).toEqual({ value: 'ran write {"q":2}' });
		// Bob has no connectors, so he finds nothing to call.
		const mine = (await call("bob", "POST", "/api/apps", { title: "Mine", kind: "html", files: html("b") })).json.id;
		expect((await bridge("bob", mine, 1, "tools.call", { name: "read" })).status).toBe(404);
	});

	it("calls a native connector's tool too, with the person's credential, once it is granted", async () => {
		const id = (await call("ada", "POST", "/api/apps", { title: "Songs", kind: "html", files: html("s") })).json.id;
		const name = `${spotifyId}/search`;
		expect((await bridge("ada", id, 1, "tools.call", { name, input: { query: "fado" } })).json).toEqual({ needs: { capability: `tool:${name}`, label: "Spotify: search" } });
		await call("ada", "POST", `/api/artifacts/${id}/versions/1/grants`, { capability: `tool:${name}` });
		expect((await bridge("ada", id, 1, "tools.call", { name, input: { query: "fado" } })).json).toEqual({ value: "- Fado by Ana · Lisboa [spotify:track:1]" });
	});

	it("shows an HTML app and a JSX app as sandboxed pages with the bridge, and refuses a JSX app that cannot run", async () => {
		const page = (await call("ada", "POST", "/api/apps", { title: "Page", kind: "html", files: { "index.html": '<!doctype html><link rel="stylesheet" href="s.css"><img src="i.svg"><script src="a.js"></script>', "s.css": "p{background:url(i.svg)}", "i.svg": "<svg/>", "a.js": "window.x=1" } })).json.id;
		const frame = await call("ada", "GET", `/api/artifacts/${page}/versions/1/frame`);
		expect(frame.json).toContain("window.pim=Object.freeze");
		expect(frame.json).toContain("<script >window.x=1</script>");
		expect(frame.json).toContain("<style>p{background:url(\"data:image/svg+xml;base64,");
		expect(frame.json).toMatch(/<img src="data:image\/svg\+xml;base64,/);
		expect(frame.json.indexOf("window.pim")).toBeLessThan(frame.json.indexOf("window.x=1"));
		const csp = frame.headers.get("content-security-policy")!;
		expect(csp).toContain("sandbox allow-scripts");
		expect(csp).toContain("connect-src 'none'");
		expect(csp).toContain("frame-ancestors http://127.0.0.1");
		expect(csp).not.toContain("unsafe-eval");
		expect(frame.headers.get("cache-control")).toContain("no-store");

		const jsx = (await call("ada", "POST", "/api/apps", { title: "J", kind: "jsx", files: { "App.jsx": 'import {useState} from "react";import {Star} from "lucide-react";import {n} from "./lib";export default function App(){const [c]=useState(n);return <b className="p-2">{c}<Star/></b>}', "lib.js": "export const n = 41 + 1;" } })).json.id;
		const jframe = await call("ada", "GET", `/api/artifacts/${jsx}/versions/1/frame?thumbnail=1`);
		expect(jframe.json).toContain("/artifact-runtime/react.js");
		expect(jframe.json).toContain("/artifact-runtime/lucide.js");
		expect(jframe.json).toContain("/artifact-runtime/thumbnail.js");
		expect(jframe.json).toContain("__pimMount(");
		expect(jframe.json).toContain("window.pim=Object.freeze");
		expect(jframe.headers.get("content-security-policy")).toMatch(/script-src 'unsafe-inline' http:\/\/127\.0\.0\.1:\d+\/artifact-runtime\//);
		for (const files of [{ "App.jsx": 'import x from "left-pad";export default function App(){return <i>{x}</i>}' }, { "App.jsx": "export default function App(){return <i>" }, { "App.jsx": "export const a = 1" }, { "App.jsx": 'import "./gone";export default () => null' }]) {
			expect((await call("ada", "POST", "/api/apps", { title: "Bad", kind: "jsx", files })).status, JSON.stringify(files)).toBe(400);
		}
		// Published, anyone with the link gets the same page, with no space around it.
		const pub = (await call("ada", "POST", `/api/artifacts/${jsx}/publish`, { public: true })).json;
		const open = await fetch(`${base}/p/${pub.id}`);
		expect(open.status).toBe(200);
		expect(open.headers.get("x-robots-tag")).toBe("noindex");
		expect(open.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
		expect(await open.text()).toContain("__pimMount(");
	});
});
