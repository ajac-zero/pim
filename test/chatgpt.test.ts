import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_NAME } from "../src/agent";
import { type ChatGPTCredential, verifyIdToken } from "../src/chatgpt";
import { api, post, say } from "./helpers";
import { faux, type Pim } from "./worker";

/*
 * A scripted OpenAI behind `fetch`: the token endpoint, its signing keys, the
 * account's model list and the Responses API. Bodies are read in the Durable
 * Object that made the request.
 */

const CLIENT_ID = "oaiapp_test";
const REDIRECT = "http://127.0.0.1:1455/auth/callback";
const PLAN_SCOPES = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";

type KeyPair = { privateKey: CryptoKey; jwk: JsonWebKey & { kid: string } };

async function keyPair(kid: string): Promise<KeyPair> {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
	return { privateKey: pair.privateKey, jwk: { ...jwk, kid } };
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
	const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return btoa(String.fromCharCode(...array)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const json = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function idToken(key: KeyPair, claims: Record<string, unknown>): Promise<string> {
	const head = json({ alg: "RS256", kid: key.jwk.kid });
	const body = json({
		iss: "https://auth.openai.com",
		aud: [CLIENT_ID],
		sub: "user-123",
		email: "me@example.com",
		exp: Math.floor(Date.now() / 1000) + 3600,
		...claims,
	});
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${head}.${body}`));
	return `${head}.${body}.${b64url(signature)}`;
}

/** A Responses stream that says `text`. */
function responseStream(text: string): Response {
	const events = [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

type Call = { url: string; headers: Record<string, string>; body: string };

let signing: KeyPair;
let stranger: KeyPair;
/** What OpenAI's token endpoint answers next; a function sees the request's form. */
let tokenAnswer: (form: URLSearchParams) => Promise<Record<string, unknown>>;
let calls: Call[];

const callsTo = (path: string) => calls.filter((call) => new URL(call.url).pathname === path);
const forms = (path: string) => callsTo(path).map((call) => new URLSearchParams(call.body));

beforeAll(async () => {
	signing = await keyPair("openai-1");
	stranger = await keyPair("openai-1");
});

beforeEach(() => {
	calls = [];
	tokenAnswer = async () => {
		throw new Error("unexpected token request");
	};
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin !== "https://auth.openai.com" && url.origin !== "https://api.openai.com") return realFetch(input, init);
		calls.push({ url: request.url, headers: Object.fromEntries(request.headers), body: await request.text() });
		switch (url.pathname) {
			case "/api/accounts/oauth/token":
				return Response.json(await tokenAnswer(new URLSearchParams(calls.at(-1)!.body)));
			case "/.well-known/jwks.json":
				return Response.json({ keys: [signing.jwk] });
			case "/v1/models":
				return Response.json({
					models: [
						{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
						{ slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "hide" },
						{ slug: "gpt-unknown-to-pi", display_name: "Mystery", visibility: "list" },
					],
				});
			case "/v1/responses":
				return responseStream("Hello from Sol");
			default:
				return new Response("not found", { status: 404 });
		}
	});
});

/** Starts a sign-in and returns its URL's parameters. */
async function startLogin() {
	const { status, body } = await post<{ url: string }>("/chatgpt/login");
	expect(status).toBe(200);
	return new URL(body.url).searchParams;
}

/** The address the browser lands on after approval. */
function landing(params: URLSearchParams, extra: Record<string, string> = {}) {
	return `${REDIRECT}?${new URLSearchParams({ code: "code-1", state: params.get("state")!, client_id: CLIENT_ID, scope: PLAN_SCOPES, ...extra })}`;
}

async function credential(): Promise<ChatGPTCredential | undefined> {
	return runInDurableObject(env.Pim.getByName(AGENT_NAME), async (instance: Pim) =>
		(await instance.credentials.read("openai")) as ChatGPTCredential | undefined,
	);
}

describe("Sign in with ChatGPT", () => {
	it("refuses a sign-in that does not grant plan use, or whose ID token does not check out", async () => {
		const cases: [string, (params: URLSearchParams) => Promise<Record<string, unknown>>, number][] = [
			[
				"no plan scope",
				async (params) => ({
					access_token: "a",
					refresh_token: "r",
					expires_in: 3600,
					scope: "openid profile email offline_access",
					id_token: await idToken(signing, { nonce: params.get("nonce") }),
				}),
				403,
			],
			[
				"another nonce",
				async () => ({
					access_token: "a",
					refresh_token: "r",
					expires_in: 3600,
					scope: PLAN_SCOPES,
					id_token: await idToken(signing, { nonce: "replayed" }),
				}),
				502,
			],
			[
				"a key OpenAI never published",
				async (params) => ({
					access_token: "a",
					refresh_token: "r",
					expires_in: 3600,
					scope: PLAN_SCOPES,
					id_token: await idToken(stranger, { nonce: params.get("nonce") }),
				}),
				502,
			],
		];
		for (const [name, answer, expected] of cases) {
			const params = await startLogin();
			tokenAnswer = () => answer(params);
			const { status } = await post("/chatgpt/callback", { url: landing(params) });
			expect(status, name).toBe(expected);
		}
		expect((await api("/chatgpt")).body).toEqual({ connected: false, email: null });
		expect(await credential()).toBeUndefined();
	});

	it("signs in from the pasted address, with PKCE, as one stable agent host", async () => {
		const first = await startLogin();
		const params = await startLogin();
		expect(Object.fromEntries(params)).toMatchObject({
			client_id: "dynamic_agent_client",
			agent_name_hint: "Pim",
			response_type: "code",
			redirect_uri: REDIRECT,
			resource: "https://api.openai.com/v1",
			code_challenge_method: "S256",
		});
		expect(params.get("scope")!.split(" ")).toContain("chatgpt.tokens.use.direct");
		expect(params.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
		expect(params.get("ext_agent_host_id")).toBe(first.get("ext_agent_host_id"));

		// An address from the earlier, replaced attempt is refused, and does not spend this one.
		expect((await post("/chatgpt/callback", { url: landing(first) })).status).toBe(400);
		expect((await post("/chatgpt/callback", { url: "https://example.com/?code=x" })).status).toBe(400);

		tokenAnswer = async () => ({
			access_token: "access-1",
			refresh_token: "refresh-1",
			expires_in: 3600,
			scope: PLAN_SCOPES,
			id_token: await idToken(signing, { nonce: params.get("nonce") }),
		});
		const { status, body } = await post("/chatgpt/callback", { url: landing(params) });
		expect(status).toBe(200);
		expect(body).toEqual({ connected: true, email: "me@example.com" });

		const [exchange] = forms("/api/accounts/oauth/token");
		expect(Object.fromEntries(exchange!)).toMatchObject({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: "code-1",
			redirect_uri: REDIRECT,
			resource: "https://api.openai.com/v1",
		});
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange!.get("code_verifier")!));
		expect(b64url(digest)).toBe(params.get("code_challenge"));

		expect(await credential()).toMatchObject({ type: "oauth", access: "access-1", refresh: "refresh-1", clientId: CLIENT_ID });
		// A code is single-use, and so is the sign-in it finished.
		expect((await post("/chatgpt/callback", { url: landing(params) })).status).toBe(409);

		// Signing in again reuses the issued client and identifies the account.
		const again = await startLogin();
		expect(again.get("client_id")).toBe(CLIENT_ID);
		expect(again.has("agent_name_hint")).toBe(false);
		expect(again.get("id_token_hint")).toBeTruthy();
	});

	it("runs every session on the chosen ChatGPT model with the plan's token", async () => {
		const { body: model } = await api("/model");
		expect(model.chatgpt).toEqual({ connected: true, email: "me@example.com", error: null });
		// Only models the account lists and pi-ai knows how to call.
		expect(model.choices.map((choice: { id: string }) => choice.id)).toEqual(["faux-model", "gpt-6.1-sol"]);

		expect((await api("/model", { method: "PUT", body: JSON.stringify({ provider: "openai", id: "gpt-6.1-sol" }) })).status).toBe(200);
		expect((await say("Hello?")).text).toBe("Hello from Sol");

		const [request] = callsTo("/v1/responses");
		expect(request!.headers.authorization).toBe("Bearer access-1");
		const sent = JSON.parse(request!.body);
		expect(sent).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true });
		// Sign in with ChatGPT rejects these.
		for (const field of ["temperature", "max_output_tokens", "prompt_cache_retention"]) {
			expect(sent, field).not.toHaveProperty(field);
		}

		// New sessions follow the choice too.
		const { body: created } = await post<{ id: string }>("/sessions");
		expect((await say("And you?", created.id)).text).toBe("Hello from Sol");
		expect(callsTo("/v1/responses")).toHaveLength(2);
	});

	it("refreshes an expired token once, however many sessions need it at the same time", async () => {
		await runInDurableObject(env.Pim.getByName(AGENT_NAME), async (instance: Pim) => {
			await instance.credentials.modify("openai", async (current) => ({ ...current!, expires: Date.now() - 1 }) as ChatGPTCredential);
		});
		tokenAnswer = async () => ({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: PLAN_SCOPES });

		const { body: second } = await post<{ id: string }>("/sessions");
		const answers = await Promise.all([say("One?"), say("Two?", second.id)]);
		expect(answers.map((answer) => answer.text)).toEqual(["Hello from Sol", "Hello from Sol"]);

		const refreshes = forms("/api/accounts/oauth/token");
		expect(refreshes).toHaveLength(1);
		expect(Object.fromEntries(refreshes[0]!)).toMatchObject({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: "refresh-1",
		});
		expect(callsTo("/v1/responses").map((call) => call.headers.authorization)).toEqual(["Bearer access-2", "Bearer access-2"]);
		expect(await credential()).toMatchObject({ access: "access-2", refresh: "refresh-2", email: "me@example.com" });
	});

	it("goes back to the default model when ChatGPT is disconnected", async () => {
		const { body } = await api("/chatgpt", { method: "DELETE" });
		expect(body).toEqual({ connected: false, email: null });
		expect((await api("/model")).body.model.id).toBe("faux-model");

		faux.setResponses([fauxAssistantMessage("Back on the default.")]);
		expect((await say("Still there?")).text).toBe("Back on the default.");
		expect(callsTo("/v1/responses")).toHaveLength(0);
		expect((await api("/model", { method: "PUT", body: JSON.stringify({ provider: "openai", id: "gpt-6.1-sol" }) })).status).toBe(409);
	});
});

describe("verifyIdToken", () => {
	it("rejects tokens for another client or past their expiry", async () => {
		const good = await idToken(signing, { nonce: "n" });
		await expect(verifyIdToken(good, { clientId: CLIENT_ID, nonce: "n" })).resolves.toEqual({
			sub: "user-123",
			email: "me@example.com",
		});
		await expect(verifyIdToken(good, { clientId: "oaiapp_other", nonce: "n" })).rejects.toThrow("another client");
		const expired = await idToken(signing, { nonce: "n", exp: Math.floor(Date.now() / 1000) - 1 });
		await expect(verifyIdToken(expired, { clientId: CLIENT_ID, nonce: "n" })).rejects.toThrow("expired");
		const foreign = await idToken(signing, { nonce: "n", iss: "https://evil.example" });
		await expect(verifyIdToken(foreign, { clientId: CLIENT_ID, nonce: "n" })).rejects.toThrow("another issuer");
	});
});
