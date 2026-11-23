// The directory's connectors on the real stack, against local stand-ins of the services (no real provider, credential or network): a native connector's OAuth sign-in
// (Gmail, Spotify, Google Drive) and its tools called by an agent through the Runner, token renewal, revocation on disconnect; and a remote MCP server's own OAuth
// sign-in (discovery, dynamic registration, PKCE, refresh) that makes an agent's connector tool work with no pasted token.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { signWebhook } from "@pim/shared/webhook";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { keyringFromProcessEnv } from "../src/roles.ts";
import { reconcileWatches, renewDue } from "../src/watches.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats, sentAndAnswered } from "./support/stack.ts";

const real = describeWith(hasNats());
const b64 = (s: string) => Buffer.from(s).toString("base64url");

/**
 * One server standing in for Google, Spotify and a remote MCP server with its own authorization server. Every path says whose it is; every call is recorded so the test can see what
 * Pim sent (the client, the PKCE verifier, the bearer).
 */
function providers() {
	const log: { path: string; auth: string | undefined; body: string }[] = [];
	const codes = new Map<string, { challenge: string; client: string; redirect: string; who: string }>();
	const clients = new Map<string, { redirects: string[] }>();
	const live = new Map<string, string>(); // refresh token -> who
	let tokens = 0;
	let origin = "";
	/** What Google grants Drive's client, when a test wants it wrong. */
	const grant = { drive: "https://www.googleapis.com/auth/drive.file" };
	const issued = new Set<string>();
	const subscribed: { name: string; arguments: unknown; delivery: { url: string; secret: string }; cursor: unknown }[] = [];
	const unsubscribed: { name: string; delivery: { url: string } }[] = [];
	/** How the server answers `events/subscribe`: as it should, with an error of its own (a refusal), or not at all (it is down). */
	const answer = { subscribe: "ok" as "ok" | "refuse" | "down" };
	const mcpTools = [{ name: "lookup", description: "Look a thing up", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } }];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const url = new URL(req.url ?? "/", origin);
			log.push({ path: `${req.method} ${url.pathname}`, auth: req.headers.authorization, body: raw });
			const send = (status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(typeof body === "string" ? body : JSON.stringify(body));
			const who = url.pathname.split("/")[1] ?? "";
			// The sign-in page: it would ask the person, and sends the browser back with a code.
			if (url.pathname === "/google/auth" || url.pathname === "/spotify/auth" || url.pathname === "/mcpas/authorize") {
				const redirect = url.searchParams.get("redirect_uri") ?? "";
				const client = url.searchParams.get("client_id") ?? "";
				if (who === "mcpas" && !clients.get(client)?.redirects.includes(redirect)) return send(400, { error: "unregistered redirect" });
				if (url.searchParams.get("code_challenge_method") !== "S256") return send(400, { error: "pkce required" });
				const code = `code-${randomBytes(6).toString("hex")}`;
				codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", client, redirect, who });
				const back = new URL(redirect);
				back.searchParams.set("code", code);
				back.searchParams.set("state", url.searchParams.get("state") ?? "");
				return void res.writeHead(302, { location: back.toString() }).end();
			}
			if (url.pathname === "/google/token" || url.pathname === "/spotify/token" || url.pathname === "/mcpas/token") {
				const form = new URLSearchParams(raw);
				const clientId = form.get("client_id") ?? "";
				const scope = who === "google" ? (clientId === "drive-client" ? grant.drive : "https://www.googleapis.com/auth/gmail.readonly") : who === "spotify" ? "user-read-currently-playing user-read-playback-state user-modify-playback-state" : "";
				const issue = (refresh: string) => {
					const access = `${who}-at-${++tokens}`;
					issued.add(access);
					return send(200, { access_token: access, refresh_token: refresh, expires_in: 1, token_type: "Bearer", ...(scope ? { scope } : {}) });
				};
				if (form.get("grant_type") === "authorization_code") {
					const c = codes.get(form.get("code") ?? "");
					codes.delete(form.get("code") ?? "");
					if (!c || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== c.challenge || form.get("redirect_uri") !== c.redirect || form.get("client_id") !== c.client) return send(400, { error: "invalid_grant", error_description: "bad code or verifier" });
					const refresh = `rt-${who}-${randomBytes(4).toString("hex")}`;
					live.set(refresh, who);
					return issue(refresh);
				}
				if (form.get("grant_type") === "refresh_token" && live.has(form.get("refresh_token") ?? "")) return issue(form.get("refresh_token")!);
				return send(400, { error: "invalid_grant" });
			}
			if (url.pathname === "/google/revoke") {
				live.delete(new URLSearchParams(raw).get("token") ?? "");
				return send(200, {});
			}
			// Gmail, Spotify and Drive's APIs: only a token this stand-in issued is good.
			if (/^\/(gmail|spotify-api|drive)\//.test(url.pathname)) {
				if (!req.headers.authorization || !issued.has(req.headers.authorization.slice(7))) return send(401, { error: { message: "bad token" } });
				if (url.pathname === "/gmail/messages") return send(200, { messages: [{ id: "m1", threadId: "t1" }] });
				if (url.pathname === "/gmail/messages/m1") return send(200, { id: "m1", threadId: "t1", snippet: "Please review", internalDate: "1700000000000", payload: { mimeType: "text/plain", headers: [{ name: "From", value: "Ada <ada@example.test>" }, { name: "Subject", value: "Quarterly plan" }], body: { size: 5, data: b64("Hello") } } });
				if (url.pathname === "/spotify-api/me/player/currently-playing") return send(200, { is_playing: true, progress_ms: 61_000, item: { name: "Song", uri: "spotify:track:1", duration_ms: 180_000, artists: [{ name: "Band" }], album: { name: "Album" } } });
				if (url.pathname === "/drive/files/abcdefghij1") return send(200, { id: "abcdefghij1", name: "Notes.txt", mimeType: "text/plain" });
				return send(404, { error: { message: "no such thing", status: "NOT_FOUND" } });
			}
			// A remote MCP server that wants a sign-in (the MCP authorization spec): resource metadata, authorization server metadata, registration, then tools.
			if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") return send(200, { resource: `${origin}/mcp`, authorization_servers: [`${origin}/mcpas`] });
			if (url.pathname === "/.well-known/oauth-authorization-server/mcpas") return send(200, { issuer: `${origin}/mcpas`, authorization_endpoint: `${origin}/mcpas/authorize`, token_endpoint: `${origin}/mcpas/token`, registration_endpoint: `${origin}/mcpas/register`, code_challenge_methods_supported: ["S256"] });
			if (url.pathname === "/mcpas/register") {
				const meta = JSON.parse(raw) as { redirect_uris: string[] };
				const id = `client-${randomBytes(4).toString("hex")}`;
				clients.set(id, { redirects: meta.redirect_uris });
				return send(201, { client_id: id, ...meta });
			}
			if (url.pathname === "/mcp") {
				if (req.method === "DELETE") return void res.writeHead(204).end();
				const bearer = req.headers.authorization?.slice(7) ?? "";
				if (!issued.has(bearer)) return void res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }).end();
				const m = JSON.parse(raw);
				if (m.id === undefined) return void res.writeHead(202).end();
				const reply = (result: unknown) => send(200, { jsonrpc: "2.0", id: m.id, result }, { "mcp-session-id": "s1" });
				if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
				if (m.method === "tools/list") return reply({ tools: mcpTools });
				if (m.method === "events/list") return reply({ events: [{ name: "ticket.created", description: "A ticket was opened", delivery: ["webhook"], inputSchema: { type: "object", properties: { project: { type: "string" } } } }, { name: "polled.only", description: "No webhook", delivery: ["poll"] }] });
				if (m.method === "events/subscribe") {
					if (answer.subscribe === "down") return send(503, {});
					if (answer.subscribe === "refuse") return send(200, { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "No such project" } });
					subscribed.push(m.params);
					return reply({ id: "sub-1", refreshBefore: new Date(Date.now() + 60_000).toISOString() });
				}
				if (m.method === "events/unsubscribe") {
					unsubscribed.push(m.params);
					return reply({});
				}
				if (m.method === "tools/call") return reply({ content: [{ type: "text", text: `found ${m.params.arguments.q}` }] });
			}
			send(404, {});
		});
	});
	return { server, log, clients, live, grant, subscribed, unsubscribed, answer, setOrigin: (o: string) => (origin = o), calls: (path: string) => log.filter((l) => l.path === path) };
}

real("native and OAuth connectors", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let web: Client;
	let app: App;
	let ownerId: string;
	let chatId: string;
	let majordomo: string;
	let n = 0;
	let origin = "";
	let standOrigin = "";
	const stand = providers();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	const transcript = async () => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_app.conversations WHERE public_chat_id = $1", [chatId])).rows[0];
		return JSON.stringify(await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id)));
	};
	const results = async (tool: string) =>
		(JSON.parse(await transcript()) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === tool).map((m) => m.content.map((c) => c.text ?? "").join("")));
	const send = async (words: string, ...script: unknown[]) => {
		faux.setResponses([...script, toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` })), fauxAssistantMessage(`ended ${n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		await waitFor(`the turn "${words}" to end`, async () => (sentAndAnswered(await transcript(), `done ${n}`) ? true : undefined), 60_000);
	};
	/** The person's browser: goes to the sign-in address, which sends it back to Pim with a code; Pim's own callback page is what it ends on. */
	let lastReturn = "";
	const signIn = async (authUrl: string) => {
		const sent = await fetch(authUrl, { redirect: "manual" });
		expect(sent.status).toBe(302);
		const back = new URL(sent.headers.get("location")!);
		lastReturn = back.pathname + back.search;
		return web.call("GET", lastReturn);
	};
	/** What the majordomo may do with a connector's tools, as its page lists them (every tool is off until the person sets it), and sets them to `permission`. */
	const toolsOf = async (connector: string) => ((await web.call("GET", `/api/permissions?agent=${majordomo}`)).json.tools as { app: string; tool: string; permission: string; readOnly: boolean }[]).filter((t) => t.app === connector);
	const allow = async (connector: string, tools: string[], permission = "on") => {
		for (const tool of tools) expect((await web.call("PUT", "/api/permissions", { agent: majordomo, app: connector, tool, permission })).status).toBe(200);
	};
	const directory = async () => ((await web.call("GET", "/api/app-directory")).json.apps as { ref: string; name: string; url: string | null }[]);
	const connection = async (ref: string) => ((await web.call("GET", "/api/mcp")).json.servers as { id: string; app: string | null; state: string; error: string | null; authUrl: string | null; tools: { name: string }[] }[]).find((s) => s.app === ref);

	beforeAll(async () => {
		await new Promise<void>((r) => stand.server.listen(0, "127.0.0.1", r));
		const at = `http://127.0.0.1:${(stand.server.address() as { port: number }).port}`;
		standOrigin = at;
		stand.setOrigin(at);
		// The deployment's OAuth clients, and the services' addresses pointed at the stand-in. The Gate and the Runner run in this process, so they read these.
		Object.assign(process.env, {
			PIM_CONNECTOR_ALLOW_PRIVATE: "1",
			GOOGLE_GMAIL_CLIENT_ID: "gmail-client", GOOGLE_GMAIL_CLIENT_SECRET: "gmail-secret",
			GOOGLE_DRIVE_CLIENT_ID: "drive-client", GOOGLE_DRIVE_CLIENT_SECRET: "drive-secret", GOOGLE_DRIVE_API_KEY: "key", GOOGLE_DRIVE_APP_ID: "123",
			SPOTIFY_CLIENT_ID: "spotify-client", SPOTIFY_CLIENT_SECRET: "spotify-secret",
			PIM_GOOGLE_AUTH_URL: `${at}/google/auth`, PIM_GOOGLE_TOKEN_URL: `${at}/google/token`, PIM_GOOGLE_REVOKE_URL: `${at}/google/revoke`,
			PIM_GMAIL_API_URL: `${at}/gmail`, PIM_DRIVE_API_URL: `${at}/drive/files`,
			PIM_SPOTIFY_AUTH_URL: `${at}/spotify/auth`, PIM_SPOTIFY_TOKEN_URL: `${at}/spotify/token`, PIM_SPOTIFY_API_URL: `${at}/spotify-api`,
		});
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		const keys = { PIM_KEK_T1: randomBytes(32).toString("base64"), PIM_KEK_CURRENT: "t1", PIM_CONNECTOR_ALLOW_PRIVATE: "1" };
		process.env.PIM_KEK_T1_TEST = keys.PIM_KEK_T1;
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate", {}, keys);
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		origin = `http://127.0.0.1:${d.gatePort}`;
		process.env.PIM_PUBLIC_URL = origin;
		chatId = (await web.call("POST", "/api/sessions", { title: "Work" })).json.id;
		// The majordomo answers this chat, and works with the directory's connectors these tests connect.
		majordomo = (await web.call("GET", "/api/majordomo")).json.agent.id as string;
		expect((await web.call("PUT", `/api/agents/${majordomo}`, { apps: ["google/gmail", "google/drive", "spotify/spotify"] })).status).toBe(200);
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), ...keys });
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await new Promise((r) => stand.server.close(r));
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("offers the popular servers always, and a native connector once the deployment's OAuth client is set", async () => {
		const refs = (await directory()).map((a) => a.ref);
		expect(refs).toEqual(expect.arrayContaining(["pim.apps/linear", "google/gmail", "google/drive", "spotify/spotify"]));
		// GitHub's server takes no registration, so it is offered only with the admin's OAuth app.
		expect(refs).not.toContain("pim.apps/github");
		expect((await directory()).find((a) => a.ref === "google/drive")).toMatchObject({ url: null });
		const asked = await web.call("POST", "/api/mcp", { app: "pim.apps/github" });
		expect(asked.status).toBe(400);
	});

	it("signs in to Gmail with PKCE, keeps the credential sealed, and an agent searches mail with it", async () => {
		const started = (await web.call("POST", "/api/mcp", { app: "google/gmail" })).json;
		expect(started).toMatchObject({ state: "authenticating" });
		const url = new URL(started.authUrl);
		expect(started.authUrl.startsWith(`${process.env.PIM_GOOGLE_AUTH_URL}?`)).toBe(true);
		expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "gmail-client", response_type: "code", redirect_uri: `${origin}/mcp/callback/apps`, code_challenge_method: "S256", access_type: "offline", prompt: "consent", scope: "https://www.googleapis.com/auth/gmail.readonly" });
		expect(await connection("google/gmail")).toMatchObject({ state: "authenticating", authUrl: started.authUrl });
		// A return nobody started finds nothing.
		expect((await web.call("GET", "/mcp/callback/apps?code=x&state=nope")).json).toContain("expired");

		const page = await signIn(started.authUrl);
		expect(page.status).toBe(200);
		expect(page.json).toContain("Gmail is connected");
		// The same return arriving twice finishes once.
		expect((await web.call("GET", lastReturn)).json).toContain("expired");
		const connected = await connection("google/gmail");
		expect(connected).toMatchObject({ state: "ready", authUrl: null, tools: [{ name: "search" }, { name: "get_message" }, { name: "get_thread" }] });
		const stored = (await d.stack.admin.query("SELECT credential, status, kind, app_ref FROM pim_app.connectors WHERE id = $1", [connected!.id])).rows[0];
		expect(stored).toMatchObject({ status: "connected", kind: "native", app_ref: "google/gmail" });
		expect(stored.credential).not.toContain("gmail-secret");
		expect(stored.credential).not.toContain("rt-google");
		// All three are read-only, and still off for the majordomo until the person turns them on.
		expect((await toolsOf(connected!.id)).map((t) => [t.tool, t.permission, t.readOnly])).toEqual([["search", "off", true], ["get_message", "off", true], ["get_thread", "off", true]]);
		await allow(connected!.id, ["search", "get_message", "get_thread"]);

		await send("find the plan mail", toolUse(fauxToolCall("connector_call", { connector: connected!.id, tool: "search", arguments: { query: "plan" } })));
		const result = (await results("connector_call"))[0]!;
		expect(result).toContain("Quarterly plan");
		expect(result).toContain("Message m1");
		// The access token was one hour short of nothing (expires in 1 s), so it was renewed with the refresh token first, and the API saw the renewed one.
		const refreshes = stand.log.filter((l) => l.path === "POST /google/token" && l.body.includes("grant_type=refresh_token"));
		expect(refreshes.length).toBeGreaterThan(0);
		expect(refreshes[0]!.body).toContain("client_id=gmail-client");
		expect(stand.calls("GET /gmail/messages").every((c) => /^Bearer google-at-\d+$/.test(c.auth ?? ""))).toBe(true);
		expect(stand.calls("GET /gmail/messages").length).toBeGreaterThan(0);
	}, 180_000);

	it("connects Spotify, whose playback tools run like the rest, and reads what is playing", async () => {
		const started = (await web.call("POST", "/api/mcp", { app: "spotify/spotify" })).json;
		expect((await signIn(started.authUrl)).json).toContain("Spotify is connected");
		const c = (await connection("spotify/spotify"))!;
		expect(c.tools.map((t) => t.name)).toEqual(["now_playing", "search", "play", "pause"]);
		expect(Object.fromEntries((await toolsOf(c.id)).map((t) => [t.tool, t.permission]))).toEqual({ now_playing: "off", search: "off", play: "off", pause: "off" });
		await allow(c.id, ["now_playing", "play"]);
		expect(Object.fromEntries((await toolsOf(c.id)).map((t) => [t.tool, t.permission]))).toEqual({ now_playing: "on", search: "off", play: "on", pause: "off" });
		await send("what is playing?", toolUse(fauxToolCall("connector_call", { connector: c.id, tool: "now_playing" })));
		expect((await results("connector_call")).at(-1)).toContain("Playing: Song by Band · Album (61s of 180s)");
	}, 120_000);

	it("keeps the files a person picks in Drive, checks each with Google, and lets an agent list them", async () => {
		const started = (await web.call("POST", "/api/mcp", { app: "google/drive" })).json;
		expect((await signIn(started.authUrl)).json).toContain("Google Drive is connected");
		const dir = (await directory()).find((a) => a.ref === "google/drive") as { page?: { url: string } };
		expect(dir.page?.url).toBe("/app-pages/google/drive");
		const page = await web.call("GET", "/app-pages/google/drive");
		expect(page.status).toBe(200);
		expect(page.json).toContain("Drive files for Pim");
		const picked = await web.call("POST", "/api/app-actions/google/drive/select", { files: [{ id: "abcdefghij1" }, { id: "zzzzzzzzzz9" }, { id: "bad id" }] });
		expect(picked.status).toBe(200);
		expect(picked.json.result.added).toEqual([{ id: "abcdefghij1", name: "Notes.txt", mimeType: "text/plain" }]);
		expect(picked.json.result.rejected.map((r: { id: string }) => r.id)).toEqual(["zzzzzzzzzz9", "bad id"]);
		expect((await web.call("POST", "/api/app-actions/google/drive/files", {})).json.result.files).toHaveLength(1);
		expect((await web.call("POST", "/api/app-actions/google/drive/nothing", {})).status).toBe(404);
		const c = (await connection("google/drive"))!;
		await allow(c.id, ["list_files"]);
		await send("what files?", toolUse(fauxToolCall("connector_call", { connector: c.id, tool: "list_files" })));
		expect((await results("connector_call")).at(-1)).toContain("Notes.txt [abcdefghij1]");
		expect((await web.call("POST", "/api/app-actions/google/drive/forget", { id: "abcdefghij1" })).json.result.files).toEqual([]);
	}, 120_000);

	it("revokes the grant at the service when a native connector is disconnected", async () => {
		const c = (await connection("google/gmail"))!;
		const before = stand.live.size;
		expect((await web.call("DELETE", `/api/mcp/${c.id}`)).json).toEqual({ deleted: true });
		expect(stand.calls("POST /google/revoke").length).toBe(1);
		expect(stand.live.size).toBe(before - 1);
		expect(await connection("google/gmail")).toBeUndefined();
		// Connecting it again starts fresh.
		expect((await web.call("POST", "/api/mcp", { app: "google/gmail" })).json).toMatchObject({ state: "authenticating" });
	}, 60_000);

	it("refuses a Google sign-in that granted less than the connector asks for", async () => {
		stand.grant.drive = "https://www.googleapis.com/auth/gmail.readonly";
		expect((await web.call("DELETE", `/api/mcp/${(await connection("google/drive"))!.id}`)).status).toBe(200);
		const started = (await web.call("POST", "/api/mcp", { app: "google/drive" })).json;
		const page = await signIn(started.authUrl);
		expect(page.json).toContain("didn't connect");
		const c = (await connection("google/drive"))!;
		expect(c).toMatchObject({ state: "failed" });
		expect(c.error).toMatch(/granted more than|didn't grant everything/);
		expect((await d.stack.admin.query("SELECT credential FROM pim_app.connectors WHERE id = $1", [c.id])).rows[0].credential).toBeNull();
	}, 60_000);

	it("signs in to a remote MCP server by itself: discovery, registration, PKCE, and a tool call with the token", async () => {
		const started = (await web.call("POST", "/api/mcp", { url: `${standOrigin}/mcp`, name: "Lookup" })).json;
		expect(started, JSON.stringify(started)).toMatchObject({ state: "authenticating" });
		// A server connected by its address is not in the directory: the majordomo lists it by its connection.
		const major = (await web.call("GET", "/api/majordomo")).json.agent as { id: string; apps: string[] };
		expect((await web.call("PUT", `/api/agents/${major.id}`, { apps: [...major.apps, started.id] })).status).toBe(200);
		const url = new URL(started.authUrl);
		expect(url.pathname).toBe("/mcpas/authorize");
		const registered = [...stand.clients.entries()].at(-1)!;
		expect(url.searchParams.get("client_id")).toBe(registered[0]);
		expect(registered[1].redirects).toEqual([`${origin}/mcp/callback/${ownerId}`]);
		expect(url.searchParams.get("resource")).toBe(`${standOrigin}/mcp`);
		const page = await signIn(started.authUrl);
		expect(page.json).toContain("Lookup is connected");
		const listed = (await web.call("GET", "/api/mcp")).json.servers.find((s: { id: string }) => s.id === started.id);
		expect(listed).toMatchObject({ state: "ready", authUrl: null, tools: [{ name: "lookup" }] });
		await allow(started.id, ["lookup"]);
		await send("look it up", toolUse(fauxToolCall("connector_call", { connector: started.id, tool: "lookup", arguments: { q: "widgets" } })));
		expect((await results("connector_call")).at(-1)).toBe("found widgets");
		// The token expired in a second: the Runner renewed it at the server's own token endpoint with the refresh token and the registered client.
		const renewed = stand.log.filter((l) => l.path === "POST /mcpas/token" && l.body.includes("grant_type=refresh_token"));
		expect(renewed.length).toBeGreaterThan(0);
		expect(renewed[0]!.body).toContain(`client_id=${registered[0]}`);
		expect((await web.call("GET", `/mcp/client/${ownerId}`)).json).toMatchObject({ client_name: "Pim", token_endpoint_auth_method: "none" });
	}, 180_000);

	it("watches a server's events: subscribes with its own secret, takes each signed delivery once, tells the chat, renews the grant and stops", async () => {
		const mcpId = (await web.call("GET", "/api/mcp")).json.servers.find((x: { url: string }) => x.url === `${standOrigin}/mcp`).id as string;
		faux.setResponses([toolUse(fauxToolCall("list_connector_events", {})), toolUse(fauxToolCall("watch_connector_event", { connector: mcpId, event: "ticket.created", arguments: { project: "P" }, instruction: "Summarise the ticket" })), toolUse(fauxToolCall("watch_connector_event", { connector: mcpId, event: "nothing", instruction: "x" })), toolUse(fauxToolCall("list_watches", {})), toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` })), fauxAssistantMessage(`ended ${n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: "watch tickets" })).status).toBe(202);
		await waitFor("the watch turn", async () => (sentAndAnswered(await transcript(), `done ${n}`) ? true : undefined), 60_000);
		const listed = (await results("list_connector_events"))[0]!;
		expect(listed).toContain("ticket.created");
		expect(listed).not.toContain("polled.only");
		expect((await results("watch_connector_event"))[0]).toContain('Watching Lookup for "ticket.created"');
		expect((await results("watch_connector_event"))[1]).toContain("has no event named nothing");
		expect(stand.subscribed).toHaveLength(1);
		const sub = stand.subscribed[0]!;
		expect(sub).toMatchObject({ name: "ticket.created", arguments: { project: "P" } });
		const key = (await d.stack.admin.query("SELECT event_key FROM pim_app.connectors WHERE id = $1", [mcpId])).rows[0].event_key;
		expect(sub.delivery.url).toBe(`${origin}/mcp/events/${ownerId}/${key}`);
		expect(sub.delivery.secret).toMatch(/^whsec_/);
		const stored = (await d.stack.admin.query("SELECT secret, status, provider_id FROM pim_app.watch_subscriptions")).rows[0];
		expect(stored).toMatchObject({ status: "active", provider_id: "sub-1" });
		expect(stored.secret).not.toContain(sub.delivery.secret);
		const listing = JSON.parse((await results("list_watches"))[0]!);
		expect(listing).toEqual([expect.objectContaining({ app: "Lookup", event: "ticket.created", instruction: "Summarise the ticket", status: "active", session: chatId })]);
		const watchId = listing[0].id as string;

		// A server delivers: Standard Webhooks, signed with the watch's secret, naming its subscription.
		const deliver = async (body: object, over: { id?: string; secret?: string; sub?: string } = {}) => {
			const raw = JSON.stringify(body);
			const id = over.id ?? (body as { eventId?: string }).eventId ?? "x";
			const ts = String(Math.floor(Date.now() / 1000));
			return fetch(`${base(gate)}/mcp/events/${ownerId}/${key}`, { method: "POST", headers: { "content-type": "application/json", "x-pim-ingress-secret": d.ingressSecret, "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": await signWebhook(over.secret ?? sub.delivery.secret, id, ts, raw), "x-mcp-subscription-id": over.sub ?? "sub-1" }, body: raw });
		};
		const event = { eventId: "evt-1", name: "ticket.created", timestamp: new Date().toISOString(), data: { title: "Printer on fire" }, cursor: "c1" };
		expect(await deliver({ type: "verification", challenge: "abc" }, { id: "v1" }).then((r) => r.json())).toEqual({ challenge: "abc" });
		expect((await deliver(event, { secret: "whsec_" + Buffer.from("wrong").toString("base64") })).status).toBe(401);
		expect((await deliver(event, { sub: "someone-else" })).status).toBe(401);
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` })), fauxAssistantMessage(`ended ${n}`)] as never);
		expect((await deliver(event)).status).toBe(204);
		await waitFor("the event's turn", async () => (sentAndAnswered(await transcript(), `done ${n}`) ? true : undefined), 60_000);
		expect(await transcript()).toContain("[Connector event] ticket.created");
		expect(await transcript()).toContain("Printer on fire");
		// The same event retried is taken once.
		expect((await deliver(event)).status).toBe(204);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.trigger_runs WHERE trigger_id = $1 AND phase = 'fired'", [watchId])).rows[0].n).toBe(1);
		expect((await d.stack.admin.query("SELECT cursor, last_event_at IS NOT NULL AS heard FROM pim_app.watch_subscriptions")).rows[0]).toEqual({ cursor: "c1", heard: true });

		// The grant runs out within a minute: the maintenance pass asks again with the same callback and secret, and the cursor.
		const crypto = keyringFromProcessEnv({ PIM_KEK_T1: process.env.PIM_KEK_T1_TEST!, PIM_KEK_CURRENT: "t1" })!;
		const renewed = await renewDue({ app, crypto, transport: { fetch, allowPrivate: true, check: async (u) => new URL(u) }, publicUrl: origin, now: Date.now }, d.stack.admin as never);
		expect(renewed).toBe(1);
		expect(stand.subscribed).toHaveLength(2);
		expect(stand.subscribed[1]).toMatchObject({ delivery: sub.delivery, cursor: "c1" });

		// The server ends the subscription: the watch says so.
		expect((await deliver({ type: "terminated", error: { code: -32012, message: "gone" } }, { id: "t1" })).status).toBe(204);
		expect((await d.stack.admin.query("SELECT status, last_error FROM pim_app.watch_subscriptions")).rows[0]).toMatchObject({ status: "ended", last_error: expect.stringContaining("-32012") });
		expect((await deliver({ ...event, eventId: "evt-2" })).status).toBe(401);

		faux.setResponses([toolUse(fauxToolCall("stop_watch", { id: watchId })), toolUse(fauxToolCall("stop_watch", { id: watchId })), toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` })), fauxAssistantMessage(`ended ${n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: "stop watching" })).status).toBe(202);
		await waitFor("the stop turn", async () => (sentAndAnswered(await transcript(), `done ${n}`) ? true : undefined), 60_000);
		expect((await results("stop_watch"))[0]).toBe("Stopped.");
		expect((await results("stop_watch"))[1]).toContain("No watch with id");
		expect(stand.unsubscribed).toEqual([{ name: "ticket.created", arguments: { project: "P" }, delivery: { url: sub.delivery.url } }]);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.watch_subscriptions")).rows[0].n).toBe(0);
		expect((await d.stack.admin.query("SELECT lifecycle FROM pim_app.triggers WHERE id = $1", [watchId])).rows[0]?.lifecycle ?? "deleted").toBe("deleted");
	}, 240_000);
	it("subscribes a connector-event trigger however it was made, and unsubscribes it when it is paused or deleted, so nothing is renewed for a trigger that is gone", async () => {
		const mcpId = (await web.call("GET", "/api/mcp")).json.servers.find((x: { url: string }) => x.url === `${standOrigin}/mcp`).id as string;
		const agent = (await web.call("POST", "/api/agents", { name: "Watcher", description: "Watches", instructions: "Watch.", apps: [], contacts: [] })).json.id as string;
		const crypto = keyringFromProcessEnv({ PIM_KEK_T1: process.env.PIM_KEK_T1_TEST!, PIM_KEK_CURRENT: "t1" })!;
		const deps = { app, crypto, transport: { fetch, allowPrivate: true, check: async (u: string) => new URL(u) }, publicUrl: origin, now: Date.now };
		const rows = async () => (await d.stack.admin.query("SELECT trigger_id, status FROM pim_app.watch_subscriptions")).rows;
		const subscribedBefore = stand.subscribed.length;
		const unsubscribedBefore = stand.unsubscribed.length;
		// Made on the Triggers screen, not by watch_connector_event: nothing subscribes it until the maintenance pass matches subscriptions to triggers.
		const made = await web.call("POST", "/api/triggers", { agentId: agent, label: "Tickets", instruction: "Look at the ticket", destination: { type: "new_chat" }, source: { kind: "connector_event", connectorId: mcpId, event: "ticket.created", arguments: { project: "Q" } }, enabled: true });
		expect(made.status, JSON.stringify(made.json)).toBe(201);
		const id = made.json.id as string;
		expect(await rows()).toEqual([]);
		expect(await reconcileWatches(deps, d.stack.admin as never)).toBe(1);
		expect(stand.subscribed).toHaveLength(subscribedBefore + 1);
		expect(stand.subscribed.at(-1)).toMatchObject({ name: "ticket.created", arguments: { project: "Q" } });
		expect(await rows()).toEqual([{ trigger_id: id, status: "active" }]);
		expect(await reconcileWatches(deps, d.stack.admin as never)).toBe(0); // nothing to do
		// Paused: the server is told to stop, and the grant is no longer renewed.
		const revision = made.json.revision as number;
		expect((await web.call("POST", `/api/triggers/${id}/pause`, undefined, { "if-match": `"${revision}"` })).status).toBe(200);
		expect(await reconcileWatches(deps, d.stack.admin as never)).toBe(1);
		expect(stand.unsubscribed).toHaveLength(unsubscribedBefore + 1);
		expect(stand.unsubscribed.at(-1)).toMatchObject({ name: "ticket.created", arguments: { project: "Q" } });
		expect(await rows()).toEqual([]);
		// Resumed: subscribed again. Deleted: unsubscribed, and renewDue finds nothing to renew.
		const paused = (await web.call("GET", `/api/triggers/${id}`)).json;
		expect((await web.call("POST", `/api/triggers/${id}/resume`, undefined, { "if-match": `"${paused.revision}"` })).status).toBe(200);
		expect(await reconcileWatches(deps, d.stack.admin as never)).toBe(1);
		expect(await rows()).toEqual([{ trigger_id: id, status: "active" }]);
		await d.stack.admin.query("UPDATE pim_app.watch_subscriptions SET renew_before = now() WHERE trigger_id = $1", [id]);
		const live = (await web.call("GET", `/api/triggers/${id}`)).json;
		expect((await web.call("DELETE", `/api/triggers/${id}`, undefined, { "if-match": `"${live.revision}"` })).status).toBe(200);
		expect(await renewDue(deps, d.stack.admin as never)).toBe(0); // a deleted watch is not renewed
		expect(await reconcileWatches(deps, d.stack.admin as never)).toBe(1);
		expect(stand.unsubscribed).toHaveLength(unsubscribedBefore + 2);
		expect(await rows()).toEqual([]);
	}, 120_000);
	it("fires only the trigger of the watch that delivered an event and applies its condition, and shows a subscription's trouble on the trigger, backing off when the server is down", async () => {
		const mcpId = (await web.call("GET", "/api/mcp")).json.servers.find((x: { url: string }) => x.url === `${standOrigin}/mcp`).id as string;
		const agent = (await web.call("POST", "/api/agents", { name: "Repos", description: "Watches repos", instructions: "Watch.", apps: [], contacts: [] })).json.id as string;
		const crypto = keyringFromProcessEnv({ PIM_KEK_T1: process.env.PIM_KEK_T1_TEST!, PIM_KEK_CURRENT: "t1" })!;
		const clock = { at: Date.now() };
		const deps = { app, crypto, transport: { fetch, allowPrivate: true, check: async (u: string) => new URL(u) }, publicUrl: origin, now: () => clock.at };
		const key = (await d.stack.admin.query("SELECT event_key FROM pim_app.connectors WHERE id = $1", [mcpId])).rows[0].event_key;
		const make = async (project: string, extra: object = {}) => {
			const made = await web.call("POST", "/api/triggers", { agentId: agent, label: `Repo ${project}`, instruction: `Look at ${project}`, destination: { type: "new_chat" }, source: { kind: "connector_event", connectorId: mcpId, event: "ticket.created", arguments: { project } }, enabled: true, ...extra });
			expect(made.status, JSON.stringify(made.json)).toBe(201);
			return made.json.id as string;
		};
		const [repoA, repoB] = [await make("A"), await make("B", { condition: { when: { op: "compare", path: ["priority"], cmp: "gt", value: 2 } } })];
		const before = stand.subscribed.length;
		expect(await reconcileWatches(deps, d.stack.admin as never)).toBe(2);
		const secrets = Object.fromEntries(stand.subscribed.slice(before).map((s) => [(s.arguments as { project: string }).project, s.delivery.secret]));
		const deliver = async (project: string, eventId: string, data: object) => {
			const raw = JSON.stringify({ eventId, name: "ticket.created", timestamp: new Date().toISOString(), data });
			const ts = String(Math.floor(Date.now() / 1000));
			return fetch(`${base(gate)}/mcp/events/${ownerId}/${key}`, { method: "POST", headers: { "content-type": "application/json", "x-pim-ingress-secret": d.ingressSecret, "webhook-id": eventId, "webhook-timestamp": ts, "webhook-signature": await signWebhook(secrets[project]!, eventId, ts, raw), "x-mcp-subscription-id": "sub-1" }, body: raw });
		};
		const runs = async (id: string) => (await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.trigger_runs WHERE trigger_id = $1 AND phase IN ('fired', 'pending')", [id])).rows[0].n as number;
		// Each firing starts a turn of its own, which answers with what is scripted here (two firings are expected).
		faux.setResponses([fauxAssistantMessage("noted A"), fauxAssistantMessage("noted B")] as never);
		// Repo A's server delivers: repo B's trigger, watching the same event with other arguments, takes nothing of it.
		expect((await deliver("A", "x-1", { title: "A's ticket", priority: 1 })).status).toBe(204);
		expect([await runs(repoA), await runs(repoB)]).toEqual([1, 0]);
		// The same event id from the other watch is its own delivery; its condition holds back a low priority and lets a high one through.
		expect((await deliver("B", "x-1", { title: "B's ticket", priority: 1 })).status).toBe(204);
		expect([await runs(repoA), await runs(repoB)]).toEqual([1, 0]);
		expect((await deliver("B", "x-2", { title: "B's urgent ticket", priority: 3 })).status).toBe(204);
		expect([await runs(repoA), await runs(repoB)]).toEqual([1, 1]);
		await waitFor("the two firings' turns", async () => (faux.getPendingResponseCount() === 0 ? true : undefined), 60_000);
		const health = async (id: string) => (await d.stack.admin.query("SELECT health, health_detail, failures, retry_after FROM pim_app.triggers WHERE id = $1", [id])).rows[0];
		expect(await health(repoA)).toMatchObject({ health: "healthy" });

		// The server goes down when the grant is to be renewed: the trigger says it is reconnecting and the next try waits, doubling; when it is back, it is well again.
		await d.stack.admin.query("UPDATE pim_app.watch_subscriptions SET renew_before = $2 WHERE trigger_id = $1", [repoA, new Date(clock.at)]);
		stand.answer.subscribe = "down";
		expect(await renewDue(deps, d.stack.admin as never)).toBe(0);
		expect(await health(repoA)).toMatchObject({ health: "reconnecting", failures: 1 });
		expect(await renewDue(deps, d.stack.admin as never)).toBe(0); // inside the backoff: nobody asks
		expect((await health(repoA)).failures).toBe(1);
		clock.at += 40_000;
		expect(await renewDue(deps, d.stack.admin as never)).toBe(0);
		expect((await health(repoA)).failures).toBe(2);
		stand.answer.subscribe = "ok";
		clock.at += 70_000;
		expect(await renewDue(deps, d.stack.admin as never)).toBe(2); // both watches are due now
		expect(await health(repoA)).toMatchObject({ health: "healthy", failures: 0, retry_after: null });

		// A server that refuses the request itself ends the watch for good, and the trigger says why.
		await d.stack.admin.query("UPDATE pim_app.watch_subscriptions SET status = 'pending', created_at = now() - interval '5 minutes' WHERE trigger_id = $1", [repoB]);
		stand.answer.subscribe = "refuse";
		await reconcileWatches(deps, d.stack.admin as never);
		stand.answer.subscribe = "ok";
		expect((await d.stack.admin.query("SELECT status, last_error FROM pim_app.watch_subscriptions WHERE trigger_id = $1", [repoB])).rows[0]).toMatchObject({ status: "ended", last_error: "No such project" });
		expect(await health(repoB)).toMatchObject({ health: "configuration_error", health_detail: "No such project" });
	}, 120_000);
	it("lets an agent find, connect, add and remove connectors, asking the person before it changes anything", async () => {
		const newAgent = async (name: string, apps: string[] = []) => (await web.call("POST", "/api/agents", { name, description: `${name} helps`, instructions: `You are ${name}.`, apps, contacts: [] })).json.id as string;
		// An agent connects only the connectors it lists.
		const listed = ["google/drive", "spotify/spotify"];
		const [boss, helper] = [await newAgent("Boss"), await newAgent("Helper", listed)];
		await d.stack.admin.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1, 'majordomo', to_jsonb($2::text)) ON CONFLICT (owner_id, key) DO UPDATE SET value = to_jsonb($2::text)", [ownerId, boss]);
		const bossChat = (await web.call("POST", "/api/sessions", { title: "Boss", agentId: boss })).json.id as string;
		const helperChat = (await web.call("POST", "/api/sessions", { title: "Helper", agentId: helper })).json.id as string;
		const resultsIn = async (chat: string, tool: string) => {
			const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_runtime.conversation_partitions WHERE public_chat_id = $1", [chat])).rows[0];
			if (!c) return [];
			return (await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id)) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === tool).map((m) => m.content.map((c) => c.text ?? "").join("")));
		};
		/** A turn in `chat`; a call that asks first is answered as `decide` says, and the turn is waited for. */
		const turn = async (chat: string, calls: ReturnType<typeof fauxToolCall>[], decide?: { tool: string; approve: boolean }) => {
			const before = (await resultsIn(chat, "send_to_user")).length;
			faux.setResponses([toolUse(...calls), toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` })), fauxAssistantMessage(`ended ${n}`)] as never);
			expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `m-${n}`, text: `go ${n}` })).status).toBe(202);
			if (decide) {
				const filed = await waitFor(`the ${decide.tool} approval`, async () => (await d.stack.admin.query("SELECT id, args FROM pim_app.approvals WHERE tool = $1 AND state = 'waiting' AND public_chat_id = $2", [decide.tool, chat])).rows[0], 60_000);
				expect(filed.args.explicit).toBe(true);
				expect((await web.call("POST", `/api/approvals/${filed.id}/decision`, { approve: decide.approve })).status).toBe(200);
			}
			await waitFor("the turn to end", async () => ((await resultsIn(chat, "send_to_user")).length > before ? true : undefined), 30_000);
		};
		const appsOf = async (id: string) => (await d.stack.admin.query("SELECT config->'apps' AS apps FROM pim_app.agents WHERE id = $1", [id])).rows[0].apps as string[];

		// Finding, listing and connecting need no approval: the person is only given a link to sign in at.
		await turn(helperChat, [fauxToolCall("find_connector", { connector: "spotify" }), fauxToolCall("list_connectors", {}), fauxToolCall("connect_connector", { connector: "google/drive" }), fauxToolCall("connect_connector", { connector: "spotify/spotify" }), fauxToolCall("connect_connector", { connector: "nonesuch" }), fauxToolCall("connect_connector", { connector: "google/gmail" })]);
		expect((await resultsIn(helperChat, "find_connector"))[0]).toMatch(/- Spotify \[id: spotify\/spotify\] \(connected\)/);
		expect(JSON.parse((await resultsIn(helperChat, "list_connectors"))[0]!)).toEqual(expect.arrayContaining([expect.objectContaining({ app: "spotify/spotify", state: "ready", tools: ["now_playing", "search", "play", "pause"] })]));
		// The calls of one turn run side by side: what each answered is found by what it says, not by its place.
		const connects = await resultsIn(helperChat, "connect_connector");
		const find = (re: RegExp) => connects.find((r) => re.test(r))!;
		const link = /Give them this link: (\S+)/.exec(find(/Google Drive needs/))?.[1];
		expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/google\/auth\?/);
		// The link is the real one: signing in at it connects the connector.
		stand.grant.drive = "https://www.googleapis.com/auth/drive.file";
		expect((await signIn(link!)).json).toContain("Google Drive is connected");
		expect(find(/^Spotify is already/)).toMatch(/^Spotify is already connected/);
		expect(find(/nonesuch/)).toMatch(/offers no connector nonesuch/);
		expect(find(/google\/gmail/)).toMatch(/^This agent doesn't work with google\/gmail; its connectors are Google Drive, Spotify\. /);

		// Changing the agent's connectors asks first, every time, and nothing changes before the person says yes.
		const lookup = (await web.call("POST", "/api/admin/apps", { name: "Lookup two", url: `${standOrigin}/mcp`, description: "Looks things up" })).json.app.id as string;
		await turn(helperChat, [fauxToolCall("manage_connectors", { add: [lookup] })], { tool: "connector:manage", approve: false });
		expect((await resultsIn(helperChat, "manage_connectors"))[0]).toMatch(/did not approve/);
		expect(await appsOf(helper)).toEqual(listed);
		await turn(helperChat, [fauxToolCall("manage_connectors", { add: [lookup] })], { tool: "connector:manage", approve: true });
		expect((await resultsIn(helperChat, "manage_connectors"))[1]).toMatch(/Helper's connectors are updated[\s\S]*Lookup two needs the person to sign in\. Give them this link: http:\/\/127\.0\.0\.1:\d+\/mcpas\/authorize/);
		expect(await appsOf(helper)).toEqual([...listed, lookup]);
		await turn(helperChat, [fauxToolCall("manage_connectors", { remove: [lookup] })], { tool: "connector:manage", approve: true });
		expect(await appsOf(helper)).toEqual(listed);

		// Only the majordomo adds a connector to this Pim, with the person's yes, and it is then one of its connectors.
		await turn(helperChat, [fauxToolCall("add_custom_connector", { name: "Mine", url: `${standOrigin}/mcp` })]);
		expect((await resultsIn(helperChat, "add_custom_connector"))[0]).toBe("Only the person's majordomo does that.");
		// A server this Pim has a connector for already is that connector, not a second one.
		await turn(bossChat, [fauxToolCall("add_custom_connector", { name: "Same server", url: `${standOrigin}/mcp` })], { tool: "connector:add", approve: true });
		expect((await resultsIn(bossChat, "add_custom_connector"))[0]).toMatch(/^Lookup two is one of this Pim's connectors \[id: custom\/lookup-two\], and one of yours\./);
		await turn(bossChat, [fauxToolCall("add_custom_connector", { name: "Mine", url: `${standOrigin}/other-mcp` })], { tool: "connector:add", approve: true });
		const added = (await d.stack.admin.query("SELECT value FROM pim_app.instance_settings WHERE key = 'custom_apps'")).rows[0].value as { id: string; name: string; url: string }[];
		expect(added.filter((c) => c.name === "Same server")).toEqual([]);
		expect(added.find((c) => c.name === "Mine")).toMatchObject({ url: `${standOrigin}/other-mcp` });
		expect((await resultsIn(bossChat, "add_custom_connector"))[1]).toMatch(/^Mine is one of this Pim's connectors \[id: custom\/mine-[0-9a-f]+\], and one of yours\./);
		expect((await appsOf(boss)).map((ref) => ref.replace(/-[0-9a-f]{6}$/, ""))).toEqual(["custom/lookup-two", "custom/mine"]);
	}, 240_000);
});
