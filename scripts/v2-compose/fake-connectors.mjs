// A stand-in for the services Pim's connectors talk to, for trying the connector screens on the Compose stack with no real provider account, credential or network:
// Google's OAuth (authorize, token, revoke) with Gmail's and Drive's APIs, Spotify's OAuth and Web API, and a remote MCP server that wants an OAuth sign-in of its own
// (protected-resource and authorization-server metadata, dynamic client registration, PKCE, refresh) with one tool.
//
//   docker run -d --name pim-fakeconnectors --network pim_internal --network-alias fakeconnectors -p 9100:9100 -v "$PWD/scripts/v2-compose/fake-connectors.mjs:/f.mjs:ro" node:26-bookworm-slim node /f.mjs
//
// and in deploy/compose/.env (the browser follows the PIM_*_AUTH_URL addresses, so they name the published port; Pim itself calls the rest by the network alias):
//
//   PIM_CONNECTOR_ALLOW_PRIVATE=1
//   GOOGLE_GMAIL_CLIENT_ID=demo GOOGLE_GMAIL_CLIENT_SECRET=demo GOOGLE_DRIVE_CLIENT_ID=demo-drive GOOGLE_DRIVE_CLIENT_SECRET=demo GOOGLE_DRIVE_API_KEY=demo GOOGLE_DRIVE_APP_ID=1 SPOTIFY_CLIENT_ID=demo SPOTIFY_CLIENT_SECRET=demo
//   PIM_GOOGLE_AUTH_URL=http://localhost:9100/google/auth  PIM_GOOGLE_TOKEN_URL=http://fakeconnectors:9100/google/token  PIM_GOOGLE_REVOKE_URL=http://fakeconnectors:9100/google/revoke
//   PIM_GMAIL_API_URL=http://fakeconnectors:9100/gmail  PIM_DRIVE_API_URL=http://fakeconnectors:9100/drive/files
//   PIM_SPOTIFY_AUTH_URL=http://localhost:9100/spotify/auth  PIM_SPOTIFY_TOKEN_URL=http://fakeconnectors:9100/spotify/token  PIM_SPOTIFY_API_URL=http://fakeconnectors:9100/spotify-api
//
// Connect "http://fakeconnectors:9100/mcp" as a custom server to see Pim sign in to an MCP server by itself. Access tokens last a minute, so renewal happens too.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PUBLIC = process.env.PUBLIC_URL ?? "http://localhost:9100"; // where the person's browser reaches this
const codes = new Map(), clients = new Map(), live = new Map(), issued = new Set();
let tokens = 0;
const b64 = (s) => Buffer.from(s).toString("base64url");
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly", DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const mails = [
	{ id: "m1", threadId: "t1", snippet: "Please review the Q3 plan before Friday", internalDate: "1763000000000", from: "Ada Lovelace <ada@example.test>", subject: "Q3 plan", body: "Hi,\nplease review the Q3 plan before Friday.\nAda" },
	{ id: "m2", threadId: "t2", snippet: "Lunch on Thursday?", internalDate: "1762900000000", from: "Grace Hopper <grace@example.test>", subject: "Lunch", body: "Lunch on Thursday?" },
];
const message = (m, full) => ({ id: m.id, threadId: m.threadId, snippet: m.snippet, internalDate: m.internalDate, payload: { mimeType: "text/plain", headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "Date", value: "Mon, 12 Nov 2026 10:00:00 +0000" }], ...(full ? { body: { size: m.body.length, data: b64(m.body) } } : {}) } });

createServer((req, res) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		const host = req.headers.host ?? "fakeconnectors:9100";
		const own = `http://${host}`; // what the caller reached this by
		const url = new URL(req.url ?? "/", own);
		const who = url.pathname.split("/")[1];
		const send = (status, body, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(typeof body === "string" ? body : JSON.stringify(body));
		console.log(new Date().toISOString(), req.method, url.pathname, req.headers.authorization ? "(bearer)" : "");
		if (["/google/auth", "/spotify/auth", "/mcpas/authorize"].includes(url.pathname)) {
			const redirect = url.searchParams.get("redirect_uri") ?? "", client = url.searchParams.get("client_id") ?? "";
			if (who === "mcpas" && !clients.get(client)?.redirects.includes(redirect)) return send(400, { error: "unregistered redirect" });
			if (url.searchParams.get("code_challenge_method") !== "S256") return send(400, { error: "PKCE required" });
			if (!url.searchParams.has("allow")) {
				const name = who === "google" ? "Google" : who === "spotify" ? "Spotify" : "the demo MCP server";
				url.searchParams.set("allow", "1");
				return void res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset=utf-8><title>${name} (stand-in)</title><body style="font:16px system-ui;max-width:30rem;margin:4rem auto"><h1>${name} (stand-in)</h1><p>Pim asks to connect to your account${url.searchParams.get("scope") ? ` with <code>${url.searchParams.get("scope")}</code>` : ""}.</p><p><a id="allow" href="${url.pathname}?${url.searchParams}" style="padding:.5rem 1rem;background:#111;color:#fff;border-radius:6px;text-decoration:none">Allow</a></p></body>`);
			}
			const code = `code-${randomBytes(6).toString("hex")}`;
			codes.set(code, { challenge: url.searchParams.get("code_challenge"), client, redirect, who });
			const back = new URL(redirect);
			back.searchParams.set("code", code);
			back.searchParams.set("state", url.searchParams.get("state") ?? "");
			return void res.writeHead(302, { location: back.toString() }).end();
		}
		if (["/google/token", "/spotify/token", "/mcpas/token"].includes(url.pathname)) {
			const f = new URLSearchParams(raw);
			const client = f.get("client_id") ?? "";
			const scope = who === "google" ? (client === "demo-drive" ? DRIVE_SCOPE : GMAIL_SCOPE) : who === "spotify" ? "user-read-currently-playing user-read-playback-state user-modify-playback-state" : "";
			const issue = (refresh) => (issued.add(`${who}-at-${++tokens}`), send(200, { access_token: `${who}-at-${tokens}`, refresh_token: refresh, expires_in: 60, token_type: "Bearer", ...(scope ? { scope } : {}) }));
			if (f.get("grant_type") === "authorization_code") {
				const c = codes.get(f.get("code") ?? "");
				codes.delete(f.get("code") ?? "");
				if (!c || createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge || f.get("redirect_uri") !== c.redirect) return send(400, { error: "invalid_grant", error_description: "bad code or verifier" });
				const refresh = `rt-${who}-${randomBytes(4).toString("hex")}`;
				live.set(refresh, who);
				return issue(refresh);
			}
			if (f.get("grant_type") === "refresh_token" && live.has(f.get("refresh_token") ?? "")) return issue(f.get("refresh_token"));
			return send(400, { error: "invalid_grant" });
		}
		if (url.pathname === "/google/revoke") return (live.delete(new URLSearchParams(raw).get("token") ?? ""), send(200, {}));
		if (/^\/(gmail|spotify-api|drive)\//.test(url.pathname)) {
			if (!issued.has((req.headers.authorization ?? "").slice(7))) return send(401, { error: { message: "bad token" } });
			if (url.pathname === "/gmail/messages") return send(200, { messages: mails.map(({ id, threadId }) => ({ id, threadId })) });
			const one = /^\/gmail\/messages\/(m\d)$/.exec(url.pathname);
			if (one) return send(200, message(mails.find((m) => m.id === one[1]), url.searchParams.get("format") === "full"));
			if (url.pathname === "/spotify-api/me/player/currently-playing") return send(200, { is_playing: true, progress_ms: 61000, item: { name: "Blue in Green", uri: "spotify:track:1", duration_ms: 337000, artists: [{ name: "Miles Davis" }], album: { name: "Kind of Blue" } } });
			if (url.pathname === "/drive/files/notes-file-001") return send(200, { id: "notes-file-001", name: "Notes.txt", mimeType: "text/plain" });
			return send(404, { error: { message: "no such thing", status: "NOT_FOUND" } });
		}
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return send(200, { resource: `${own}/mcp`, authorization_servers: [`${own}/mcpas`] });
		if (url.pathname === "/.well-known/oauth-authorization-server/mcpas") return send(200, { issuer: `${own}/mcpas`, authorization_endpoint: `${PUBLIC}/mcpas/authorize`, token_endpoint: `${own}/mcpas/token`, registration_endpoint: `${own}/mcpas/register`, code_challenge_methods_supported: ["S256"] });
		if (url.pathname === "/mcpas/register") {
			const meta = JSON.parse(raw);
			const id = `client-${randomBytes(4).toString("hex")}`;
			clients.set(id, { redirects: meta.redirect_uris });
			return send(201, { client_id: id, ...meta });
		}
		if (url.pathname === "/mcp") {
			if (req.method === "DELETE") return void res.writeHead(204).end();
			if (!issued.has((req.headers.authorization ?? "").slice(7))) return void res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${own}/.well-known/oauth-protected-resource"` }).end();
			const m = JSON.parse(raw);
			if (m.id === undefined) return void res.writeHead(202).end();
			const reply = (result) => send(200, { jsonrpc: "2.0", id: m.id, result }, { "mcp-session-id": "s1" });
			if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } });
			if (m.method === "tools/list") return reply({ tools: [{ name: "lookup", description: "Look a thing up", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } }] });
			if (m.method === "tools/call") return reply({ content: [{ type: "text", text: `The demo server found: ${m.params.arguments?.q}` }] });
		}
		send(404, {});
	});
}).listen(9100, () => console.log("fake connectors on :9100"));
