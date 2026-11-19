import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGate } from "../src/gate.ts";
import { App } from "../src/app.ts";
import { connect } from "../src/db.ts";
import { bearerOf } from "../src/http.ts";
import { MemoryObjectStore } from "../src/objects.ts";
import { userHandle } from "../src/signin.ts";
import { Authenticator } from "./support/authenticator.ts";
import { freshDatabase, bootstrap } from "./support/fixture.ts";

type Jar = Map<string, string>;
const jarHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

class Client {
	readonly jar: Jar = new Map();
	constructor(readonly base: string, readonly origin?: string) {}
	async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: any; res: Response }> {
		const form = body instanceof URLSearchParams;
		const res = await fetch(this.base + path, {
			method, redirect: "manual",
			headers: { ...(body && !form ? { "content-type": "application/json" } : {}), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(this.jar.size ? { cookie: jarHeader(this.jar) } : {}), ...extra },
			...(body === undefined ? {} : { body: form ? body.toString() : JSON.stringify(body) }),
		});
		for (const line of res.headers.getSetCookie()) {
			const [pair = "", ...attrs] = line.split("; ");
			const [name = "", ...v] = pair.split("=");
			if (attrs.some((a) => a === "Max-Age=0")) this.jar.delete(name);
			else this.jar.set(name, v.join("="));
		}
		const text = await res.text();
		return { status: res.status, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, res };
	}
}

let urls: Awaited<ReturnType<typeof freshDatabase>>;
let app: App;
let server: Server;
let base: string;
let idp: Server;
let idpBase: string;
let idpNonce = "";
let idpSubject = "sub-1";

beforeAll(async () => {
	urls = await freshDatabase();
	// A fake OpenID Connect provider: discovery and a token endpoint that answers with an unsigned ID token, as the real exchange is not signature-checked.
	idp = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			res.setHeader("content-type", "application/json");
			if (req.url === "/.well-known/openid-configuration") return res.end(JSON.stringify({ issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token` }));
			const claims = { iss: idpBase, aud: "client-1", sub: idpSubject, nonce: idpNonce, exp: Math.floor(Date.now() / 1000) + 600, email: `${idpSubject}@idp.example`, given_name: "Idp" };
			const jwt = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
			res.end(JSON.stringify({ id_token: `${jwt({ alg: "none" })}.${jwt(claims)}.sig` }));
		});
	});
	await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
	idpBase = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
	app = new App(connect(urls.appUrl, 6), new MemoryObjectStore(), { providers: { oidc: { clientId: "client-1", clientSecret: "secret", issuer: idpBase, name: "Acme SSO" } } });
	const root = await bootstrap(app, "rootly");
	await app.identity.setRegistrationOpen(root.principal, true);
	server = createGate(app);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	await new Promise<void>((r) => server.close(() => r()));
	await new Promise<void>((r) => idp.close(() => r()));
	await app.db.end();
});

const rp = () => new URL(base).hostname;

async function join(username: string): Promise<{ c: Client; ownerId: string }> {
	await app.db.anonymous((tx) => tx.query("DELETE FROM pim_app.registration_attempts")); // every test client is 127.0.0.1
	const c = new Client(base);
	const r = await c.call("POST", "/auth/register", { username });
	expect(r.status).toBe(201);
	return { c, ownerId: r.json.account.ownerId };
}

async function enroll(c: Client, auth: Authenticator, body: object = {}) {
	const options = await c.call("POST", "/auth/passkeys/options", body);
	expect(options.status).toBe(200);
	return c.call("POST", "/auth/passkeys", { ...auth.create(options.json, base), name: `${auth.alg} key` });
}

async function signInWith(c: Client, auth: Authenticator, ownerId: string, overrides: { rpId?: string } = {}) {
	const options = await c.call("POST", "/auth/sign-in/options");
	return c.call("POST", "/auth/sign-in", auth.get(options.json, base, userHandle(ownerId), overrides));
}

describe("passkeys", () => {
	it.each(["EdDSA", "ES256", "RS256"] as const)("enrolls and signs in with a %s passkey, bound to the hostname", async (alg) => {
		const { c, ownerId } = await join(`pk-${alg.toLowerCase()}`);
		const auth = new Authenticator(alg);
		const added = await enroll(c, auth);
		expect(added.status).toBe(200);
		expect(added.json).toMatchObject({ id: auth.id, name: `${alg} key` });
		expect((await c.call("GET", "/auth/session")).json).toMatchObject({ signedIn: true, method: "passkey" });
		await c.call("POST", "/auth/sign-out");
		expect((await c.call("GET", "/auth/session")).json.signedIn).toBe(false);

		// A passkey made for another relying party fails, as does one signed by another key.
		const wrongRp = await signInWith(c, auth, ownerId, { rpId: "evil.example" });
		expect(wrongRp.status).toBe(401);
		const stranger = await signInWith(c, new Authenticator(alg), ownerId);
		expect(stranger.status).toBe(401);
		const okay = await signInWith(c, auth, ownerId);
		expect(okay.status).toBe(200);
		expect(c.jar.has("pim_session")).toBe(true);
		const session = await c.call("GET", "/auth/session");
		expect(session.json).toMatchObject({ signedIn: true, passkey: auth.id, account: { ownerId } });
	});

	it("answers a challenge once, and refuses a passkey under another owner's user handle", async () => {
		const a = await join("pk-replay-a");
		const b = await join("pk-replay-b");
		const keyA = new Authenticator("ES256");
		await enroll(a.c, keyA);
		await a.c.call("POST", "/auth/sign-out");
		const options = await a.c.call("POST", "/auth/sign-in/options");
		const assertion = keyA.get(options.json, base, userHandle(a.ownerId));
		expect((await a.c.call("POST", "/auth/sign-in", assertion)).status).toBe(200);
		await a.c.call("POST", "/auth/sign-out");
		// The same assertion cannot be played again: its challenge is spent (the browser's challenge cookie is gone).
		const replay = new Client(base);
		replay.jar.set("pim_challenge", "stale");
		expect((await replay.call("POST", "/auth/sign-in", assertion)).status).toBe(400);
		// Owner B's handle with owner A's passkey: not one of B's.
		expect((await signInWith(new Client(base), keyA, b.ownerId)).status).toBe(401);
	});

	it("blocks a suspended account's sign-in, and ends sessions when the passkey is removed", async () => {
		const { c, ownerId } = await join("pk-remove");
		const k1 = new Authenticator("EdDSA");
		const k2 = new Authenticator("ES256");
		await enroll(c, k1);
		await enroll(c, k2);
		const other = new Client(base);
		expect((await signInWith(other, k2, ownerId)).status).toBe(200);
		const removed = await c.call("DELETE", `/auth/passkeys/${k2.id}`);
		expect(removed.status).toBe(200);
		expect((await other.call("GET", "/auth/session")).json.signedIn).toBe(false); // opens nothing once its credential is gone
		expect((await c.call("GET", "/auth/session")).json.signedIn).toBe(true);
		const admin = (await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'rootly'")).rows[0].owner_id)) as string;
		await app.identity.setStatus({ kind: "user", ownerId: admin as never, role: "admin", sessionId: "x" }, ownerId, "suspended");
		const refused = await signInWith(new Client(base), k1, ownerId);
		expect(refused.status).toBe(403);
		expect(refused.json.error).toBe("suspended");
	});
});

describe("setup codes, recovery codes and device links", () => {
	it("lets a setup code make the first passkey once", async () => {
		const { ownerId } = await join("pk-setup");
		const { code } = await app.signin.issueSetupCode(ownerId);
		const first = new Client(base);
		const auth = new Authenticator("EdDSA");
		expect((await enroll(first, auth, { setup: code })).status).toBe(200);
		expect(first.jar.has("pim_session")).toBe(true);
		// Spent: a second attempt, even with a new key, is refused at the options step.
		const second = await new Client(base).call("POST", "/auth/passkeys/options", { setup: code });
		expect(second.status).toBe(401);
		expect((await new Client(base).call("POST", "/auth/passkeys/options", { setup: `${ownerId}.nope` })).status).toBe(401);
		expect((await new Client(base).call("POST", "/auth/passkeys/options", {})).status).toBe(401);
	});

	it("races two tabs on one setup code: one passkey wins", async () => {
		const { ownerId } = await join("pk-race");
		const { code } = await app.signin.issueSetupCode(ownerId);
		const tabs = [new Client(base), new Client(base)];
		const keys = [new Authenticator("EdDSA"), new Authenticator("ES256")];
		const opts = await Promise.all(tabs.map((t) => t.call("POST", "/auth/passkeys/options", { setup: code })));
		expect(opts.map((o) => o.status)).toEqual([200, 200]);
		const done = await Promise.all(tabs.map((t, i) => t.call("POST", "/auth/passkeys", { ...keys[i]!.create(opts[i]!.json, base), name: "k" })));
		expect(done.map((d) => d.status).sort()).toEqual([200, 401]);
	});

	it("issues ten recovery codes that each work once with the username", async () => {
		const { c, ownerId } = await join("pk-recover");
		await enroll(c, new Authenticator("ES256"));
		const { json } = await c.call("POST", "/auth/recovery-codes");
		expect(json.codes).toHaveLength(10);
		expect((await c.call("GET", "/auth/recovery-codes")).json).toEqual({ left: 10 });
		const code = (json.codes[0] as string).toUpperCase().replace("-", " "); // typed any way
		const lost = new Client(base);
		expect((await lost.call("POST", "/auth/passkeys/options", { recovery: code, username: "@PK-RECOVER" })).status).toBe(200);
		const fresh = new Authenticator("EdDSA");
		const opts = await lost.call("POST", "/auth/passkeys/options", { recovery: code, username: "pk-recover" });
		expect((await lost.call("POST", "/auth/passkeys", { ...fresh.create(opts.json, base), name: "new phone" })).status).toBe(200);
		expect((await c.call("GET", "/auth/recovery-codes")).json).toEqual({ left: 9 });
		expect((await new Client(base).call("POST", "/auth/passkeys/options", { recovery: code, username: "pk-recover" })).status).toBe(401);
		expect((await new Client(base).call("POST", "/auth/passkeys/options", { recovery: json.codes[1], username: "someone-else" })).status).toBe(401);
		void ownerId;
	});

	it("makes a device link that adds one passkey and dies with the session that made it", async () => {
		const { c } = await join("pk-device");
		await enroll(c, new Authenticator("ES256"));
		const link = await c.call("POST", "/auth/device-links");
		expect(link.status).toBe(201);
		const device = new URL(link.json.url).hash.replace("#device=", "");
		const phone = new Client(base);
		const key = new Authenticator("EdDSA");
		expect((await enroll(phone, key, { device })).status).toBe(200);
		expect((await new Client(base).call("POST", "/auth/passkeys/options", { device })).status).toBe(401); // used

		const another = await c.call("POST", "/auth/device-links");
		const code2 = new URL(another.json.url).hash.replace("#device=", "");
		await c.call("POST", "/auth/sign-out"); // the link dies with the session
		expect((await new Client(base).call("POST", "/auth/passkeys/options", { device: code2 })).status).toBe(401);
	});

	it("reports username availability, never offering a name that was ever claimed", async () => {
		expect((await new Client(base).call("GET", "/auth/username?name=pk-device")).json).toMatchObject({ available: false });
		expect((await new Client(base).call("GET", "/auth/username?name=totally-free")).json).toEqual({ available: true });
		expect((await new Client(base).call("GET", "/auth/username?name=X")).json.available).toBe(false);
	});
});

describe("cookies and credentials", () => {
	it("uses the __Host- session cookie on https and the plain name only on http", async () => {
		const https = createGate(app, { publicUrl: "https://pim.example.com" });
		await new Promise<void>((r) => https.listen(0, "127.0.0.1", r));
		const port = (https.address() as { port: number }).port;
		const secure = new Client(`http://127.0.0.1:${port}`);
		await app.db.anonymous((tx) => tx.query("DELETE FROM pim_app.registration_attempts"));
		const r = await secure.call("POST", "/auth/register", { username: "tls-user" });
		const header = r.res.headers.get("set-cookie")!;
		expect(header).toMatch(/^__Host-pim-session=pims_/);
		expect(header).toMatch(/Secure; HttpOnly; SameSite=Strict/);
		// Passkeys belong to the public hostname, not whatever address reached the process.
		const opts = await secure.call("POST", "/auth/sign-in/options");
		expect(opts.json.rpId).toBe("pim.example.com");
		expect(secure.jar.has("__Host-pim-session")).toBe(true);
		expect((await secure.call("GET", "/api/account")).status).toBe(200);
		await new Promise<void>((resolve) => https.close(() => resolve()));
		const plain = await new Client(base).call("POST", "/auth/register", { username: "plain-user" });
		expect(plain.res.headers.get("set-cookie")).toMatch(/^pim_session=pims_.*HttpOnly/);
		expect(plain.res.headers.get("set-cookie")).not.toMatch(/Secure/);
	});

	it("accepts ?token= only on a WebSocket upgrade or a read of the API, never on published or app paths or a write", () => {
		const req = (upgrade?: string, method = "GET") => ({ method, headers: upgrade ? { upgrade } : {} }) as never;
		const url = (p: string) => new URL(p, "http://x");
		expect(bearerOf(req("websocket"), url("/api/notes/live?token=pim_abc"), false).bearer).toBe("pim_abc");
		expect(bearerOf(req("websocket"), url("/hosted/o/app/t/x?token=pim_abc"), false).bearer).toBeUndefined();
		expect(bearerOf(req("websocket"), url("/p/pa_1?token=pim_abc"), false).bearer).toBeUndefined();
		expect(bearerOf(req(), url("/api/account?token=pim_abc"), false).bearer).toBe("pim_abc");
		expect(bearerOf(req(undefined, "POST"), url("/api/sessions?token=pim_abc"), false).bearer).toBeUndefined();
		expect(bearerOf(req(), url("/shared/o/x?token=pim_abc"), false).bearer).toBeUndefined();
		expect(bearerOf(req(), url("/health?token=pim_abc"), false).bearer).toBeUndefined();
		expect(bearerOf({ headers: { authorization: "Bearer h" } } as never, url("/x?token=q"), false).bearer).toBe("h");
	});

	it("answers a wrong method with 405 and what the path takes, rejects a body that is not an object, and lets MCP clients in pages in with CORS", async () => {
		const { c } = await join("shapes-user");
		const wrong = await c.call("PUT", "/api/sessions", {});
		expect(wrong.status).toBe(405);
		expect(wrong.res.headers.get("allow")).toContain("POST");
		expect((await c.call("GET", "/api/nope")).status).toBe(404);
		expect((await c.call("POST", "/api/sessions", [1])).status).toBe(400);
		const mcp = await c.call("GET", "/mcp");
		expect(mcp.status).toBe(405);
		expect(mcp.res.headers.get("access-control-allow-origin")).toBe("*");
		const preflight = await c.call("OPTIONS", "/mcp", undefined, { origin: "https://client.example", "access-control-request-method": "POST" });
		expect(preflight.status).toBe(204);
		expect(preflight.res.headers.get("access-control-allow-headers")).toContain("Authorization");
		expect((await c.call("OPTIONS", "/.well-known/oauth-authorization-server")).status).toBe(204);
	});

	it("refuses a cookie request from another site, and a sign-out ends the session on the server", async () => {
		const { c } = await join("cookie-user");
		expect((await c.call("POST", "/api/sessions", {}, { origin: "https://evil.example" })).status).toBe(403);
		const stolen = new Client(base);
		stolen.jar.set("pim_session", c.jar.get("pim_session")!);
		expect((await stolen.call("GET", "/api/account")).status).toBe(200);
		await c.call("POST", "/auth/sign-out");
		expect((await stolen.call("GET", "/api/account")).status).toBe(401);
	});
});

describe("external sign-in (OpenID Connect)", () => {
	const startAt = async (c: Client, body: object = {}) => {
		const r = await c.call("POST", "/auth/oauth/oidc", body);
		expect(r.status).toBe(200);
		const url = new URL(r.json.url);
		idpNonce = url.searchParams.get("nonce")!;
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		return url;
	};
	const back = (c: Client, url: URL, extra = "") => c.call("GET", `/auth/oauth/oidc/callback?code=c1&state=${url.searchParams.get("state")}${extra}`);

	it("lists the provider, links an account, signs in with it, and unlinks it", async () => {
		const { c, ownerId } = await join("idp-user");
		expect((await c.call("GET", "/auth/session")).json.providers).toEqual([{ id: "oidc", name: "Acme SSO" }]);
		idpSubject = "sub-link";
		const linking = await back(c, await startAt(c));
		expect(linking.status).toBe(302);
		expect(linking.res.headers.get("location")).toBe("/?dialog=settings&tab=account");
		const { identities } = (await c.call("GET", "/auth/identities")).json;
		expect(identities).toHaveLength(1);
		expect(identities[0]).toMatchObject({ provider: "oidc", label: "sub-link@idp.example" });

		const out = new Client(base);
		const signedIn = await back(out, await startAt(out));
		expect(signedIn.res.headers.get("location")).toBe("/");
		expect((await out.call("GET", "/auth/session")).json).toMatchObject({ signedIn: true, method: "identity", account: { ownerId }, name: "Idp" });

		// Another account cannot take it: (issuer, subject) is unique across the instance.
		const rival = await join("idp-rival");
		const refused = await back(rival.c, await startAt(rival.c));
		expect(refused.res.headers.get("location")).toMatch(/#auth-error=.*already%20signs%20in%20to%20someone%20else/);
		expect((await rival.c.call("GET", "/auth/identities")).json.identities).toEqual([]);

		// A state that is not this browser's is refused.
		const stray = await startAt(c);
		expect((await c.call("GET", "/auth/oauth/oidc/callback?code=c1&state=wrong")).res.headers.get("location")).toMatch(/auth-error/);
		void stray;

		await c.call("DELETE", `/auth/identities/${identities[0].id}`);
		expect((await out.call("GET", "/auth/session")).json.signedIn).toBe(false); // the session made with it ended
		const gone = new Client(base);
		const nobody = await back(gone, await startAt(gone));
		expect(nobody.res.headers.get("location")).toMatch(/Nobody%20on%20this%20Pim/);
		// And it is free to link elsewhere now.
		expect((await back(rival.c, await startAt(rival.c))).res.headers.get("location")).toBe("/?dialog=settings&tab=account");
	});

	it("adds the first credential with a setup code, spent once", async () => {
		const { ownerId } = await join("idp-setup");
		const { code } = await app.signin.issueSetupCode(ownerId);
		idpSubject = "sub-setup";
		const c = new Client(base);
		const done = await back(c, await startAt(c, { setup: code }));
		expect(done.res.headers.get("location")).toBe("/");
		expect((await c.call("GET", "/auth/session")).json).toMatchObject({ signedIn: true, account: { ownerId } });
		const again = new Client(base);
		expect((await again.call("POST", "/auth/oauth/oidc", { setup: code })).status).toBe(401);
		expect((await new Client(base).call("POST", "/auth/oauth/github")).status).toBe(404); // not set up here
	});
});

describe("MCP OAuth 2.1 server", () => {
	const pkce = () => {
		const verifier = randomBytes(32).toString("base64url");
		return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
	};
	const redirect = "http://127.0.0.1:9999/callback";

	async function connect(c: Client, opts: { challenge?: string } = {}) {
		const anon = new Client(base);
		const reg = await anon.call("POST", "/oauth/register", { client_name: "Claude", redirect_uris: [redirect] });
		expect(reg.status).toBe(201);
		const { verifier, challenge } = pkce();
		const q = new URLSearchParams({ client_id: reg.json.client_id, redirect_uri: redirect, response_type: "code", code_challenge: opts.challenge ?? challenge, code_challenge_method: "S256", state: "st" });
		const consent = await c.call("GET", `/auth/authorize?${q}`);
		return { reg: reg.json, verifier, consent, anon };
	}

	it("serves discovery metadata and refuses unsafe registrations", async () => {
		const anon = new Client(base);
		expect((await anon.call("GET", "/.well-known/oauth-authorization-server")).json).toMatchObject({ token_endpoint: `${base}/oauth/token`, code_challenge_methods_supported: ["S256"] });
		expect((await anon.call("GET", "/.well-known/oauth-protected-resource/mcp")).json).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
		expect((await anon.call("POST", "/oauth/register", { redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
		expect((await anon.call("POST", "/oauth/register", {})).json.error).toBe("invalid_redirect_uri");
		const unauth = await anon.call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" });
		expect(unauth.status).toBe(401);
		expect(unauth.res.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
	});

	it("runs the code flow with PKCE, calls the tool, rotates refresh tokens, and disconnects", async () => {
		const { c, ownerId } = await join("mcp-user");
		const { reg, verifier, consent, anon } = await connect(c);
		expect(consent.json).toMatchObject({ client: { name: "Claude", redirectHost: "127.0.0.1:9999", local: true } });
		const allowed = await c.call("POST", "/auth/authorize", { handle: consent.json.handle, allow: true });
		const to = new URL(allowed.json.redirectTo);
		expect(to.searchParams.get("state")).toBe("st");
		const code = to.searchParams.get("code")!;
		const form = (o: Record<string, string>) => new URLSearchParams(o);
		// A wrong verifier burns the code.
		expect((await anon.call("POST", "/oauth/token", form({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: "wrong" }))).json.error).toBe("invalid_grant");
		expect((await anon.call("POST", "/oauth/token", form({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }))).status).toBe(400);

		const second = await connect(c);
		const code2 = new URL((await c.call("POST", "/auth/authorize", { handle: second.consent.json.handle, allow: true })).json.redirectTo).searchParams.get("code")!;
		const tokens = await anon.call("POST", "/oauth/token", form({ grant_type: "authorization_code", code: code2, client_id: second.reg.client_id, redirect_uri: redirect, code_verifier: second.verifier }));
		expect(tokens.status).toBe(200);
		expect(tokens.json).toMatchObject({ token_type: "Bearer", expires_in: 3600 });

		const rpc = (token: string, body: object) => anon.call("POST", "/mcp", { jsonrpc: "2.0", id: 1, ...body }, { authorization: `Bearer ${token}` });
		expect((await rpc(tokens.json.access_token, { method: "initialize", params: {} })).json.result.serverInfo.name).toBe("Pim");
		expect((await rpc(tokens.json.access_token, { method: "tools/list" })).json.result.tools.map((t: { name: string }) => t.name)).toEqual(["pim"]);
		const call = await rpc(tokens.json.access_token, { method: "tools/call", params: { name: "pim", arguments: { message: "hello majordomo" } } });
		const chat = call.json.result.structuredContent.conversation as string;
		expect(call.json.result.isError).toBe(false);
		// The message is accepted into the command inbox, with no model in the way.
		expect((await app.conversations.pending(ownerId, chat)).map((p) => [p.kind, p.inboxAccepted])).toEqual([["user_message", true]]);
		await rpc(tokens.json.access_token, { method: "tools/call", params: { name: "pim", arguments: { message: "and again", conversation: chat } } });
		expect(await app.conversations.pending(ownerId, chat)).toHaveLength(2);

		const refreshed = await anon.call("POST", "/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.json.refresh_token, client_id: second.reg.client_id }));
		expect(refreshed.status).toBe(200);
		expect((await anon.call("POST", "/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.json.refresh_token, client_id: second.reg.client_id }))).status).toBe(400); // rotated
		const { connections } = (await c.call("GET", "/auth/connections")).json;
		expect(connections).toHaveLength(1);
		expect(connections[0].name).toBe("Claude");
		await c.call("DELETE", `/auth/connections/${connections[0].id}`);
		expect((await rpc(refreshed.json.access_token, { method: "ping" })).status).toBe(401);
		expect((await anon.call("POST", "/oauth/token", form({ grant_type: "refresh_token", refresh_token: refreshed.json.refresh_token, client_id: second.reg.client_id }))).status).toBe(400);
	});

	it("checks the account and scopes on every call: suspended 403, deleted 410, guests refused, an unscoped API token kept out", async () => {
		const admin = (await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'rootly'")).rows[0].owner_id)) as string;
		const adminP = { kind: "user", ownerId: admin as never, role: "admin", sessionId: "x" } as const;
		const { c, ownerId } = await join("mcp-checks");
		const anon = new Client(base);
		const grant = async () => {
			const { reg, verifier, consent } = await connect(c);
			const code = new URL((await c.call("POST", "/auth/authorize", { handle: consent.json.handle, allow: true })).json.redirectTo).searchParams.get("code")!;
			const t = await anon.call("POST", "/oauth/token", new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }));
			return t.json.access_token as string;
		};
		const access = await grant();
		const ping = (token: string) => anon.call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: `Bearer ${token}` });
		expect((await ping(access)).status).toBe(200);

		// A read-only API token has no mcp:call; an unscoped one (a legacy token) opens it.
		const session = await app.identity.authenticate(c.jar.get("pim_session"));
		const readOnly = await app.identity.createToken(session, { name: "ro", scopes: ["api:read"] });
		expect((await ping(readOnly.token)).status).toBe(403);
		const star = await app.identity.createToken(session, { name: "all", scopes: ["*"] });
		expect((await ping(star.token)).status).toBe(200);

		await app.identity.setStatus(adminP, ownerId, "suspended");
		expect((await ping(access)).status).toBe(403);
		expect((await ping(star.token)).status).toBe(403);
		await app.identity.setStatus(adminP, ownerId, "active");
		expect((await ping(access)).status).toBe(200);

		// A guest may not connect, and a token it already held stops working when it becomes one.
		await app.identity.setRole(adminP, ownerId, "guest");
		expect((await ping(access)).status).toBe(403);
		const denied = await connect(c);
		expect(denied.consent.status).toBe(403);
		await app.identity.setRole(adminP, ownerId, "member");

		await app.identity.setStatus(adminP, ownerId, "deleted");
		expect((await ping(access)).status).toBe(401); // its tokens were revoked with the account
	});

	it("refuses an authorization request without PKCE S256 by sending the client back with an error", async () => {
		const { c } = await join("mcp-pkce");
		const anon = new Client(base);
		const reg = await anon.call("POST", "/oauth/register", { redirect_uris: [redirect] });
		const q = new URLSearchParams({ client_id: reg.json.client_id, redirect_uri: redirect, response_type: "code", state: "s" });
		const r = await c.call("GET", `/auth/authorize?${q}`);
		expect(new URL(r.json.redirectTo).searchParams.get("error")).toBe("invalid_request");
		const bad = await c.call("GET", `/auth/authorize?${new URLSearchParams({ client_id: reg.json.client_id, redirect_uri: "http://127.0.0.1:1/other", response_type: "code" })}`);
		expect(bad.status).toBe(400); // an unregistered redirect never receives anything
	});
});
