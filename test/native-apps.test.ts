import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { googleApp } from "../src/extensions/google";
import { NativeApps } from "../src/extensions/native-apps";
import { api, comeBack, OWNER, post, ROOT, say, signedIn, toolUse, url } from "./helpers";
import { faux, type Pim } from "./worker";

/**
 * Apps an extension implements (the test extension's Bank): their sign-in
 * through the one callback address, their tools with the person's
 * credential, and the widgets their results show. bank.example.test is an
 * OAuth service the tests answer, checking what a real one would. So are
 * Google's sign-in and APIs, for the Google apps (test/worker.ts's `google`).
 */

const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/** What Google's token endpoint was asked, by client; what its revocation endpoint was given; and the API requests, with their tokens. */
const google = {
	grants: [] as (Record<string, string> & { client: string })[],
	revoked: [] as string[],
	requests: [] as { method: string; url: string; token: string }[],
	/** How the next refreshes are answered; by default with a new access token and no refresh token, as Google does. */
	refresh: null as null | (() => Response | Promise<Response>),
	revoke: () => new Response(null, { status: 200 }),
	/** How Google's APIs answer. */
	api: (_request: Request, _token: string): Response => Response.json({ emailAddress: "ada@example.com" }),
};
let accessTokens = 1;

const BASIC = `Basic ${btoa("bank-client:bank-secret")}`;
const grants: Record<string, string>[] = [];
const tokensUsed: string[] = [];
let challenge = "";

const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

beforeEach(() => {
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const { origin, pathname } = new URL(request.url);
		if (origin === "https://oauth2.googleapis.com" && pathname === "/token") {
			const clients: Record<string, string> = { [`Basic ${btoa("gmail-client:gmail-secret")}`]: "gmail", [`Basic ${btoa("drive-client:drive-secret")}`]: "drive" };
			const client = clients[request.headers.get("authorization") ?? ""];
			if (!client) return Response.json({ error: "invalid_client" }, { status: 401 });
			const form = Object.fromEntries(new URLSearchParams(await request.text()));
			google.grants.push({ ...form, client });
			if (form.grant_type === "authorization_code") {
				if (form.redirect_uri !== "https://pim.test/mcp/callback/apps" || !form.code_verifier) return Response.json({ error: "invalid_grant" }, { status: 400 });
				const scopes: Record<string, string> = {
					"good-mail": GMAIL,
					"good-files": DRIVE_FILE,
					spaced: `  ${DRIVE_FILE}  `,
					partial: "",
					broad: `${DRIVE_FILE} https://www.googleapis.com/auth/drive`,
				};
				const scope = scopes[form.code!];
				if (scope === undefined) return Response.json({ error: "invalid_grant", error_description: "Bad Request" }, { status: 400 });
				return Response.json({ access_token: `${client}-access-${accessTokens++}`, refresh_token: `${client}-refresh`, expires_in: 3599, scope, token_type: "Bearer" });
			}
			if (google.refresh) return google.refresh();
			if (form.refresh_token !== `${client}-refresh`) return Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
			return Response.json({ access_token: `${client}-access-${accessTokens++}`, expires_in: 3599, scope: client === "gmail" ? GMAIL : DRIVE_FILE, token_type: "Bearer" });
		}
		if (origin === "https://oauth2.googleapis.com" && pathname === "/revoke") {
			google.revoked.push(new URLSearchParams(await request.text()).get("token") ?? "");
			return google.revoke();
		}
		if (origin === "https://gmail.googleapis.com") {
			const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			google.requests.push({ method: request.method, url: request.url, token });
			return google.api(request, token);
		}
		if (origin !== "https://bank.example.test") return realFetch(input, init);
		if (pathname === "/token") {
			if (request.headers.get("authorization") !== BASIC) return Response.json({ error: "invalid_client" }, { status: 401 });
			const form = Object.fromEntries(new URLSearchParams(await request.text()));
			grants.push(form);
			if (form.grant_type === "authorization_code") {
				// The verifier must be the one the challenge was made from (S256), and the redirect the one the sign-in used.
				const hashed = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.code_verifier)));
				if (form.code !== "good" || hashed !== challenge || form.redirect_uri !== "https://pim.test/mcp/callback/apps") {
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				}
				return Response.json({ access_token: "token-1", refresh_token: "refresh-1", expires_in: 3600 });
			}
			if (form.grant_type === "refresh_token" && form.refresh_token === "refresh-1") return Response.json({ access_token: "token-2", expires_in: 3600 });
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		}
		if (pathname === "/balances") {
			tokensUsed.push(request.headers.get("authorization") ?? "");
			return Response.json([
				{ name: "Checking", balance: 120 },
				{ name: "Savings", balance: 900 },
			]);
		}
		return new Response("not found", { status: 404 });
	});
});

/** A connection's row as the space's database keeps it. */
const stored = (id: string) =>
	runInDurableObject(env.Pim.getByName(OWNER), (_instance: Pim, state) => state.storage.sql.exec("SELECT * FROM pim_app_connections WHERE id = ?", id).toArray()[0]);

/** Runs one of a connection's tools as an agent's call does. */
const callTool = (id: string, args: Record<string, unknown>) =>
	runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) => instance.nativeApps.call(id, "request", args));

const lastToolResult = (messages: readonly Message[]) => {
	const last = messages.findLast((message) => message.role === "toolResult");
	return last?.role === "toolResult" ? last.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
};

describe("apps extensions implement", () => {
	it("are offered once their secrets are set, and sign in once through the one callback address", async () => {
		const directory = (await api("/app-directory")).body.apps as { ref: string; url: string | null }[];
		expect(directory).toContainEqual({ ref: "test.ledger/bank", name: "Bank", description: "Balances and transfers.", url: null, custom: false, icon: null, category: null });
		// Its secret isn't set: nobody is offered it, or can connect it.
		expect(directory.some((app) => app.ref === "test.ledger/vault")).toBe(false);
		expect((await post("/mcp", { app: "test.ledger/vault" })).status).toBe(400);

		const started = await post("/mcp", { app: "test.ledger/bank" });
		expect(started).toMatchObject({ status: 201, body: { id: "bank", state: "authenticating" } });
		const authUrl = new URL(started.body.authUrl);
		const params = Object.fromEntries(authUrl.searchParams);
		expect(`${authUrl.origin}${authUrl.pathname}`).toBe("https://bank.example.test/authorize");
		expect(params).toMatchObject({
			response_type: "code",
			client_id: "bank-client",
			redirect_uri: "https://pim.test/mcp/callback/apps",
			scope: "balances transfers",
			code_challenge_method: "S256",
		});
		expect(params.state!.startsWith(`${OWNER}.`)).toBe(true);
		challenge = params.code_challenge!;
		expect((await api("/mcp")).body.servers).toEqual([
			expect.objectContaining({ id: "bank", app: "test.ledger/bank", state: "authenticating", authUrl: started.body.authUrl, tools: [] }),
		]);

		// A state nobody started finds no sign-in; one naming nobody finds no space.
		const cookie = await signedIn();
		expect((await comeBack({ state: `${OWNER}.forged`, code: "good" }, cookie)).status).toBe(400);
		expect((await comeBack({ state: "o_nobody.x", code: "good" }, cookie)).status).toBe(404);

		// The service sends the person back, without Pim's API token, to their own signed-in browser.
		const back = await comeBack({ state: params.state!, code: "good" }, cookie);
		expect(back.status).toBe(200);
		expect(await back.text()).toContain("Connected.");
		expect(grants.at(-1)).toMatchObject({ grant_type: "authorization_code", code: "good" });
		const [bank] = (await api("/mcp")).body.servers;
		expect(bank).toMatchObject({ state: "ready", authUrl: null, approval: "writes" });
		expect(bank.tools.map((tool: { name: string }) => tool.name)).toEqual(["bank_balance", "bank_transfer"]);
		// Finished once: the same return can't sign in again.
		expect((await comeBack({ state: params.state!, code: "good" }, cookie)).status).toBe(400);
		expect((await post("/mcp", { app: "test.ledger/bank" })).status).toBe(409);
	});

	it("run their tools with the person's credential, show results as widgets, and leave destructive ones off until switched on", async () => {
		const [agent] = (await api("/agents")).body.agents;
		await api(`/agents/${agent.id}`, { method: "PUT", body: JSON.stringify({ apps: ["test.ledger/bank"] }) });
		let read = "";
		faux.setResponses([
			toolUse("bank_balance", {}),
			(context) => {
				read = lastToolResult(context.messages);
				const ref = /"(tool:[\w]+)"/.exec(read)?.[1] ?? "none";
				return toolUse("send_to_user", { message: "Your balances:", widgets: [ref] });
			},
		]);
		await say("What's in my accounts?");
		expect(tokensUsed.at(-1)).toBe("Bearer token-1");
		expect(read).toContain("Checking: 120\nSavings: 900");
		// The person sees the result as a widget under the message, as it was when sent.
		const transcript = JSON.stringify((await api(`/sessions/${ROOT}/messages`)).body.messages);
		expect(transcript).toContain('\\"title\\":\\"Balances\\"');
		expect(transcript).toContain('{\\"title\\":\\"Savings\\",\\"detail\\":\\"900\\"}');

		// A tool the app flags destructive is off, even when the app otherwise trusts all calls, until the person switches it on.
		await api("/mcp/bank", { method: "PUT", body: JSON.stringify({ approval: "none" }) });
		const transfer = async () =>
			(await api(`/permissions?agent=${agent.id}`)).body.tools.find((tool: { name: string }) => tool.name === "bank_transfer");
		expect(await transfer()).toMatchObject({ permission: "off", destructive: true });
		await api("/permissions", { method: "PUT", body: JSON.stringify({ agent: agent.id, app: "bank", tool: "transfer", permission: "on" }) });
		expect(await transfer()).toMatchObject({ permission: "on", chosen: "on" });
		let moved = "";
		faux.setResponses([
			toolUse("bank_transfer", { amount: 5 }),
			(context) => {
				moved = lastToolResult(context.messages);
				return toolUse("send_to_user", { message: "Moved." });
			},
		]);
		expect(await say("Move 5 to savings")).toMatchObject({ status: "done", replies: ["Moved."] });
		expect(moved).toContain("Moved 5.");
		expect((await api("/approvals")).body.approvals).toEqual([]);
		await api("/mcp/bank", { method: "PUT", body: JSON.stringify({ approval: "writes" }) });
	});

	it("keep credentials encrypted, and renew one about to expire before using it, once", async () => {
		// Kept encrypted, bound to this space, connection and app: no token in the database.
		const sealed = String((await stored("bank"))!.credential);
		expect(sealed.startsWith("sealed:v1:")).toBe(true);
		expect(sealed).not.toMatch(/token-1|refresh-1/);
		// One kept before the deployment had a key, about to expire: renewed once, then encrypted.
		await runInDurableObject(env.Pim.getByName(OWNER), (_instance: Pim, state) => {
			state.storage.sql.exec("UPDATE pim_app_connections SET credential = ? WHERE id = 'bank'", JSON.stringify({ accessToken: "token-1", refreshToken: "refresh-1", expiresAt: 0 }));
		});
		faux.setResponses([toolUse("bank_balance", {}), toolUse("bank_balance", {}), toolUse("send_to_user", { message: "ok" })]);
		await say("Balances again, twice");
		expect(grants.filter((grant) => grant.grant_type === "refresh_token")).toEqual([{ grant_type: "refresh_token", refresh_token: "refresh-1" }]);
		expect(tokensUsed.slice(-2)).toEqual(["Bearer token-2", "Bearer token-2"]);
		const renewed = String((await stored("bank"))!.credential);
		expect(renewed.startsWith("sealed:v1:")).toBe(true);
		expect(renewed).not.toMatch(/token-2|refresh-1/);
	});
});

describe("Google apps", () => {
	/** Starts connecting a Google app: the sign-in's parameters, as Google gets them. */
	const start = async (ref: string) => {
		const started = await post("/mcp", { app: ref });
		expect(started.status).toBe(201);
		return { id: started.body.id as string, params: Object.fromEntries(new URL(started.body.authUrl).searchParams) };
	};
	let cookie = "";

	beforeEach(() => {
		google.grants.length = 0;
		google.revoked.length = 0;
		google.requests.length = 0;
		google.refresh = null;
		google.revoke = () => new Response(null, { status: 200 });
		google.api = () => Response.json({ emailAddress: "ada@example.com" });
	});

	it("are offered with their own client and the key, ask only for what they need, and come back only to the person's own signed-in browser", async () => {
		const offered = ((await api("/app-directory")).body.apps as { ref: string }[]).map((app) => app.ref);
		expect(offered).toEqual(expect.arrayContaining(["test.google/mail", "test.google/files"]));
		// Its client isn't set: nobody is offered it.
		expect(offered).not.toContain("test.google/unset");
		// A broader scope than Gmail's read-only or Drive's picked files doesn't make an app.
		expect(() =>
			googleApp({ id: "drive", name: "Drive", description: "", client: { id: "A", secret: "B" }, scopes: ["https://www.googleapis.com/auth/drive" as never], tools: [] }),
		).toThrow(/may ask Google only for/);

		const { id, params } = await start("test.google/mail");
		expect(params).toMatchObject({
			client_id: "gmail-client",
			scope: GMAIL,
			access_type: "offline",
			prompt: "consent",
			include_granted_scopes: "true",
			redirect_uri: "https://pim.test/mcp/callback/apps",
			code_challenge_method: "S256",
		});
		expect(params.state).toMatch(new RegExp(`^${OWNER}\\.[\\w-]{43}$`));

		// The page Google sends the browser to carries what came back only as escaped form fields, with no other script.
		const page = await exports.default.fetch(url(`/mcp/callback/apps?state=${params.state}&code=good-mail&x=${encodeURIComponent('"><script>alert(1)</script>')}`));
		const html = await page.text();
		expect(html).not.toContain("<script>alert");
		expect(html).toContain('value="&#34;&#62;&#60;script&#62;alert(1)&#60;/script&#62;"');
		expect(page.headers.get("content-security-policy")).toMatch(/script-src 'sha256-[\w+/=]+'; form-action 'self'/);
		expect(page.headers.get("referrer-policy")).toBe("same-origin");
		expect(page.headers.get("cache-control")).toBe("no-store");

		// Not signed in, or signed in as someone else: refused, and the sign-in is left for the person.
		const directory = env.Directory.getByName("directory");
		const stranger = await directory.register({ username: "stranger", ip: "192.0.2.9", policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
		if (!stranger.ok) throw new Error(stranger.error);
		await directory.activate(stranger.account.ownerId);
		expect((await comeBack({ state: params.state!, code: "good-mail" })).status).toBe(403);
		expect((await comeBack({ state: params.state!, code: "good-mail" }, await signedIn(stranger.account.ownerId))).status).toBe(403);
		expect(google.grants).toEqual([]);
		expect((await stored(id))!.state).toBe("authenticating");

		cookie = await signedIn();
		const back = await comeBack({ state: params.state!, code: "good-mail" }, cookie);
		expect(await back.text()).toContain("Connected.");
		expect(google.grants).toEqual([expect.objectContaining({ client: "gmail", grant_type: "authorization_code", code: "good-mail" })]);
		// Once only.
		expect((await comeBack({ state: params.state!, code: "good-mail" }, cookie)).status).toBe(400);

		// No token in the database, nor in what the API says about the connection.
		const row = (await stored(id))!;
		expect(row).toMatchObject({ state: "ready", pending: null, sign_in_state: null });
		expect(String(row.credential)).toMatch(/^sealed:v1:/);
		const described = JSON.stringify((await api("/mcp")).body);
		for (const text of [String(row.credential), described]) expect(text).not.toMatch(/gmail-access|gmail-refresh/);
		expect((await api("/mcp")).body.servers).toContainEqual(expect.objectContaining({ id: "mail", app: "test.google/mail", state: "ready" }));
	});

	it("refuse a sign-in that took too long, or a grant with less or more than the app asks for, revoking only a grant of its own", async () => {
		const late = await start("test.google/files");
		await runInDurableObject(env.Pim.getByName(OWNER), (_instance: Pim, state) => {
			state.storage.sql.exec("UPDATE pim_app_connections SET created_at = ? WHERE id = ?", Date.now() - 16 * 60_000, late.id);
		});
		expect(await (await comeBack({ state: late.params.state!, code: "good-files" }, cookie)).text()).toContain("expired");
		expect((await stored(late.id))!.state).toBe("failed");
		expect(google.grants).toEqual([]);

		for (const code of ["partial", "broad"]) {
			const { id, params } = await start("test.google/files");
			const back = await comeBack({ state: params.state!, code }, cookie);
			expect(back.status).toBe(400);
			expect((await stored(id))!).toMatchObject({
				state: "failed",
				credential: null,
				error: code === "partial" ? expect.stringContaining("didn't grant everything Files needs") : expect.stringContaining("granted more than Files asks for"),
			});
			// A grant with less is only this app's, and is revoked; one with more is the project's, shared with something else, and is left alone.
			expect(google.revoked).toEqual(code === "partial" ? ["drive-refresh"] : []);
			google.revoked.length = 0;
		}

		// Google's scopes, in any order and spacing, are the app's exactly.
		const { params } = await start("test.google/files");
		expect(await (await comeBack({ state: params.state!, code: "spaced" }, cookie)).text()).toContain("Connected.");
		// Each app signs in with its own client.
		expect(google.grants.filter((grant) => grant.grant_type === "authorization_code").map((grant) => grant.client)).toEqual(["drive", "drive", "drive"]);
	});

	it("call Google with the person's token, retrying a busy Google a bounded number of times, and only Google", async () => {
		let busy = 1;
		google.api = () => (busy-- > 0 ? Response.json({ error: { code: 503, message: "Backend Error" } }, { status: 503 }) : Response.json({ emailAddress: "ada@example.com" }));
		expect(await callTool("mail", { url: PROFILE })).toEqual({ content: [{ type: "text", text: '{"emailAddress":"ada@example.com"}' }] });
		expect(google.requests.map((request) => request.token)).toEqual(["gmail-access-1", "gmail-access-1"]);

		// Always busy: three tries, then the error; the connection stays.
		google.requests.length = 0;
		google.api = () => Response.json({ error: { code: 429, message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded" }] } }, { status: 429, headers: { "retry-after": "0" } });
		expect(await callTool("mail", { url: PROFILE })).toEqual({ content: [{ type: "text", text: "Google: Quota exceeded" }], isError: true });
		expect(google.requests).toHaveLength(3);
		// A request that isn't idempotent is sent once.
		google.requests.length = 0;
		expect((await callTool("mail", { url: PROFILE, method: "POST" })).isError).toBe(true);
		expect(google.requests).toHaveLength(1);
		// A refusal is not retried, and says Google's reason, never the token.
		google.requests.length = 0;
		google.api = () => Response.json({ error: { code: 403, message: "Mail service not enabled", errors: [{ reason: "failedPrecondition" }] } }, { status: 403 });
		const refused = await callTool("mail", { url: PROFILE });
		expect(refused).toEqual({ content: [{ type: "text", text: "Google: Mail service not enabled" }], isError: true });
		expect(google.requests).toHaveLength(1);
		// Nowhere but Google's APIs, and no redirect away from them.
		google.requests.length = 0;
		expect((await callTool("mail", { url: "https://example.com/steal" })).isError).toBe(true);
		google.api = () => new Response(null, { status: 302, headers: { location: "https://example.com/steal" } });
		expect(await callTool("mail", { url: PROFILE })).toMatchObject({ content: [{ text: "Google: unexpected redirect (302)" }], isError: true });
		expect(google.requests).toHaveLength(1);
		expect((await stored("mail"))!.state).toBe("ready");
	});

	it("renew a refused token once for calls at once, keeping the refresh token Google leaves out", async () => {
		google.api = (_request, token) => (token === "gmail-access-1" ? Response.json({ error: { code: 401 } }, { status: 401 }) : Response.json({ token }));
		const results = await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) =>
			Promise.all([instance.nativeApps.call("mail", "request", { url: PROFILE }), instance.nativeApps.call("mail", "request", { url: PROFILE })]),
		);
		const refreshes = () => google.grants.filter((grant) => grant.grant_type === "refresh_token");
		expect(refreshes()).toEqual([expect.objectContaining({ client: "gmail", refresh_token: "gmail-refresh" })]);
		const tokens = results.map((result) => JSON.parse((result.content![0] as { text: string }).text).token as string);
		const renewed = tokens[0]!;
		expect(tokens).toEqual([renewed, renewed]);
		expect(renewed).not.toBe("gmail-access-1");

		// Refused again later: the refresh token Google left out of its answer is still the one Pim sends.
		google.api = (_request, token) => (token === renewed ? Response.json({ error: { code: 401 } }, { status: 401 }) : Response.json({ token }));
		expect((await callTool("mail", { url: PROFILE })).isError).toBeUndefined();
		expect(refreshes().map((grant) => grant.refresh_token)).toEqual(["gmail-refresh", "gmail-refresh"]);
	});

	it("stay connected while Google can't renew a sign-in, and need connecting again once Google revoked it", async () => {
		google.api = () => Response.json({ error: { code: 401 } }, { status: 401 });
		google.refresh = () => Response.json({ error: "temporarily_unavailable" }, { status: 503 });
		expect((await callTool("mail", { url: PROFILE })).isError).toBe(true);
		expect((await stored("mail"))!.state).toBe("ready");
		// An answer larger than Pim reads from a token endpoint says only its status, and isn't taken for a revocation.
		google.refresh = () => Response.json({ error: "invalid_grant", error_description: "x".repeat(100_000) }, { status: 400 });
		expect(await callTool("mail", { url: PROFILE })).toEqual({ content: [{ type: "text", text: "The token endpoint answered 400" }], isError: true });
		expect((await stored("mail"))!.state).toBe("ready");

		google.refresh = () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
		expect(await callTool("mail", { url: PROFILE })).toEqual({ content: [{ type: "text", text: "Mail needs the person to connect it again from the Apps page." }], isError: true });
		expect((await stored("mail"))!).toMatchObject({ state: "failed", credential: null, error: "Sign in again: Token has been expired or revoked." });
		expect((await api("/mcp")).body.servers.find((server: { id: string }) => server.id === "mail").tools).toEqual([]);
	});

	it("keep each credential to its own connection", async () => {
		// Mail connected again; its credential moved to Files' connection can't be read there.
		const { params } = await start("test.google/mail");
		expect(await (await comeBack({ state: params.state!, code: "good-mail" }, cookie)).text()).toContain("Connected.");
		const files = (await stored("files"))!.credential;
		await runInDurableObject(env.Pim.getByName(OWNER), (_instance: Pim, state) => {
			state.storage.sql.exec("UPDATE pim_app_connections SET credential = (SELECT credential FROM pim_app_connections WHERE id = 'mail') WHERE id = 'files'");
		});
		google.api = (_request, token) => Response.json({ token });
		expect((await callTool("files", { url: PROFILE })).isError).toBe(true);
		expect((await stored("files"))!.state).toBe("failed");
		expect(String((await stored("mail"))!.credential)).not.toBe(files);
		expect((await callTool("mail", { url: PROFILE })).isError).toBeUndefined();
	});

	it("leave a connection made again alone when a call on the old one learns its grant is gone", async () => {
		// A call's renewal is under way when the person disconnects (revoking the grant) and connects again.
		let refuse = () => {};
		google.refresh = () => new Promise((resolve) => (refuse = () => resolve(Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }))));
		google.api = () => Response.json({ error: { code: 401 } }, { status: 401 });
		const result = await runInDurableObject(env.Pim.getByName(OWNER), async (instance: Pim) => {
			const call = instance.nativeApps.call("mail", "request", { url: PROFILE });
			await vi.waitFor(() => expect(google.grants.some((grant) => grant.grant_type === "refresh_token")).toBe(true));
			await instance.nativeApps.remove("mail");
			const { authUrl } = await instance.nativeApps.connect("test.google/mail", "mail");
			const state = new URL(authUrl).searchParams.get("state")!;
			expect(await instance.nativeApps.finish(new URL(`https://pim.test/mcp/callback/apps?state=${state}&code=good-mail`))).toEqual({ name: "Mail" });
			refuse();
			return call;
		});
		expect(result).toMatchObject({ isError: true, content: [{ text: "Mail needs the person to connect it again from the Apps page." }] });
		expect((await stored("mail"))!).toMatchObject({ state: "ready", error: null, credential: expect.stringMatching(/^sealed:v1:/) });
	});

	it("disconnect one without the other: Pim forgets the credential, then revokes its grant at Google", async () => {
		const { params } = await start("test.google/files");
		expect(await (await comeBack({ state: params.state!, code: "good-files" }, cookie)).text()).toContain("Connected.");

		expect((await api("/mcp/mail", { method: "DELETE" })).body).toEqual({ deleted: true });
		expect(google.revoked).toEqual(["gmail-refresh"]);
		expect(await stored("mail")).toBeUndefined();
		expect((await stored("files"))!.state).toBe("ready");

		// Google can't be reached: the connection is gone all the same.
		google.revoke = () => new Response("unavailable", { status: 503 });
		expect((await api("/mcp/files", { method: "DELETE" })).body).toEqual({ deleted: true });
		expect(google.revoked).toEqual(["gmail-refresh", "drive-refresh"]);
		expect(await stored("files")).toBeUndefined();
	});
});

describe("connections made before sign-ins had generations", () => {
	it("get one each", async () => {
		const generations = await runInDurableObject(env.Pim.getByName(OWNER), (_instance: Pim, state) => {
			const { sql } = state.storage;
			sql.exec("ALTER TABLE pim_app_connections DROP COLUMN generation");
			for (const id of ["old_a", "old_b"]) {
				sql.exec("INSERT INTO pim_app_connections (id, app, name, state, credential, created_at) VALUES (?, ?, 'Old', 'ready', '{}', 1)", id, `test.old/${id}`);
			}
			new NativeApps({ sql, app: () => undefined, secrets: () => ({}), credentialsKey: () => null, callbackUrl: () => "", owner: () => OWNER, changed: () => {} });
			const found = sql.exec("SELECT generation FROM pim_app_connections WHERE id IN ('old_a', 'old_b')").toArray().map((row) => row.generation);
			sql.exec("DELETE FROM pim_app_connections WHERE id IN ('old_a', 'old_b')");
			return found;
		});
		expect(generations).toHaveLength(2);
		expect(generations.every((generation) => typeof generation === "string" && generation.length >= 22)).toBe(true);
		expect(generations[0]).not.toBe(generations[1]);
	});
});
