// The directory's connectors on the real stack, against local stand-ins of the services (no real provider, credential or network): a native connector's OAuth sign-in
// (Gmail, Spotify, Google Drive) and its tools called by an agent through the Runner, token renewal, revocation on disconnect; and a remote MCP server's own OAuth
// sign-in (discovery, dynamic registration, PKCE, refresh) that makes an agent's connector tool work with no pasted token.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
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
				if (m.method === "tools/call") return reply({ content: [{ type: "text", text: `found ${m.params.arguments.q}` }] });
			}
			send(404, {});
		});
	});
	return { server, log, clients, live, grant, setOrigin: (o: string) => (origin = o), calls: (path: string) => log.filter((l) => l.path === path) };
}

real("native and OAuth connectors", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let web: Client;
	let app: App;
	let ownerId: string;
	let chatId: string;
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
		faux.setResponses([...script, fauxAssistantMessage(`done ${++n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		await waitFor(`the turn "${words}" to end`, async () => ((await transcript()).includes(`done ${n}`) ? true : undefined), 60_000);
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
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate", {}, keys);
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		origin = `http://127.0.0.1:${d.gatePort}`;
		chatId = (await web.call("POST", "/api/sessions", { title: "Work" })).json.id;
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
		// All three are read-only, so they run without asking.
		const perms = (await web.call("GET", "/api/permissions")).json.tools as { app: string; tool: string; permission: string; readOnly: boolean }[];
		expect(perms.filter((t) => t.app === connected!.id).map((t) => [t.tool, t.permission, t.readOnly])).toEqual([["search", "on", true], ["get_message", "on", true], ["get_thread", "on", true]]);

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

	it("connects Spotify, whose playback tools ask first, and reads what is playing", async () => {
		const started = (await web.call("POST", "/api/mcp", { app: "spotify/spotify" })).json;
		expect((await signIn(started.authUrl)).json).toContain("Spotify is connected");
		const c = (await connection("spotify/spotify"))!;
		expect(c.tools.map((t) => t.name)).toEqual(["now_playing", "search", "play", "pause"]);
		const perms = (await web.call("GET", "/api/permissions")).json.tools as { app: string; tool: string; permission: string }[];
		expect(Object.fromEntries(perms.filter((t) => t.app === c.id).map((t) => [t.tool, t.permission]))).toEqual({ now_playing: "on", search: "on", play: "ask", pause: "ask" });
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
		await send("look it up", toolUse(fauxToolCall("connector_call", { connector: started.id, tool: "lookup", arguments: { q: "widgets" } })));
		expect((await results("connector_call")).at(-1)).toBe("found widgets");
		// The token expired in a second: the Runner renewed it at the server's own token endpoint with the refresh token and the registered client.
		const renewed = stand.log.filter((l) => l.path === "POST /mcpas/token" && l.body.includes("grant_type=refresh_token"));
		expect(renewed.length).toBeGreaterThan(0);
		expect(renewed[0]!.body).toContain(`client_id=${registered[0]}`);
		expect((await web.call("GET", `/mcp/client/${ownerId}`)).json).toMatchObject({ client_name: "Pim", token_endpoint_auth_method: "none" });
	}, 180_000);
});
