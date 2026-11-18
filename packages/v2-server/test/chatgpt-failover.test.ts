// Sign in with ChatGPT and provider failover on the real stack, against a fake OpenAI (auth server, token endpoint, JWKS and Responses API). The person signs in through the
// Gate, the credential is stored sealed, a Runner refreshes it before the first request (rotating the refresh token, once, even when two refresh at the same time), a chat
// turn runs on the plan, and a 429 moves the next turn to the next model of the list without anything of the failed attempt in the transcript.
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { chatgptContext } from "@pim/v2-app/chatgpt";
import { KeyringCrypto, openString, sealString } from "@pim/v2-app/crypto";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { chatgptCredentialStore } from "../src/chatgpt-auth.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const MODEL = "gpt-5";
const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** The parts of OpenAI the code talks to, with what it was asked kept for the assertions. */
async function fakeOpenAI() {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
	const port = await freePort();
	const issuer = `http://127.0.0.1:${port}`;
	const state = { grants: [] as URLSearchParams[], refreshes: 0, valid: "refresh-1", responses: [] as string[], limited: false, nonce: "" };
	const idToken = (clientId: string) => {
		const head = b64u(JSON.stringify({ alg: "RS256", kid: "k1" }));
		const body = b64u(JSON.stringify({ iss: issuer, aud: clientId, sub: "acct-1", email: "anibal@example.com", exp: Math.floor(Date.now() / 1000) + 3600, nonce: state.nonce }));
		return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey, "base64url")}`;
	};
	const server: Server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const text = Buffer.concat(chunks).toString();
		const json = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
		if (req.url === "/.well-known/jwks.json") return json(200, { keys: [jwk] });
		if (req.url === "/api/accounts/oauth/token") {
			const form = new URLSearchParams(text);
			state.grants.push(form);
			if (form.get("grant_type") === "authorization_code") {
				// Expires inside the refresh margin, so the first request has to refresh.
				return json(200, { access_token: "access-1", refresh_token: "refresh-1", id_token: idToken(form.get("client_id")!), scope: "openid chatgpt.tokens.use.direct", expires_in: 100 });
			}
			// A refresh token is single-use: spending one twice, or a stale one, is what a lost rotation looks like.
			if (form.get("refresh_token") !== state.valid) return json(400, { error: "invalid_grant" });
			state.refreshes++;
			state.valid = `refresh-${state.refreshes + 1}`;
			return json(200, { access_token: `access-${state.refreshes + 1}`, refresh_token: state.valid, expires_in: 3600 });
		}
		if (req.url?.endsWith("/responses")) {
			state.responses.push(String(req.headers.authorization));
			if (state.limited) return json(429, { error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } });
			const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`;
			const msg = { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "plan says hi", annotations: [] }] };
			const response = { id: "resp_1", object: "response", status: "completed", model: MODEL, output: [msg], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				sse("response.created", { response: { ...response, status: "in_progress", output: [] } }) +
					sse("response.output_item.added", { output_index: 0, item: { ...msg, status: "in_progress", content: [] } }) +
					sse("response.content_part.added", { item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }) +
					sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "plan says hi" }) +
					sse("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text: "plan says hi" }) +
					sse("response.content_part.done", { item_id: "msg_1", output_index: 0, content_index: 0, part: msg.content[0] }) +
					sse("response.output_item.done", { output_index: 0, item: msg }) +
					sse("response.completed", { response }),
			);
			return;
		}
		json(404, { error: "no such route" });
	});
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	return { issuer, state, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

real("Sign in with ChatGPT and provider failover", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let web: Client;
	let app: App;
	let openai: Awaited<ReturnType<typeof fakeOpenAI>>;
	let ownerId: string;
	let chatId: string;
	let n = 0;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const key = randomBytes(32);
	const crypto = new KeyringCrypto("k1", { k1: new Uint8Array(key) });

	const transcript = async (chat = chatId) => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0];
		return JSON.stringify(await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id)));
	};
	const say = async (words: string, expected: string, chat = chatId) => {
		const id = ++n;
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `m-${id}`, text: words })).status).toBe(202);
		await waitFor(`"${expected}" in the transcript`, async () => ((await transcript(chat)).includes(expected) ? true : undefined), 60_000);
	};
	const stored = async () => (await d.stack.admin.query("SELECT secret, email, version FROM pim_app.chatgpt_credentials")).rows[0];
	const opened = async () => JSON.parse(await openString(crypto, (await stored()).secret, chatgptContext(ownerId)));

	beforeAll(async () => {
		openai = await fakeOpenAI();
		// The model routes read the deployment's settings from the process environment, which the in-process Gate shares.
		process.env.PIM_DEFAULT_MODEL = "faux/m";
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		const env = { PIM_KEK_k1: key.toString("base64"), PIM_KEK_CURRENT: "k1", PIM_CHATGPT_ISSUER: openai.issuer, PIM_DEFAULT_MODEL: "faux/m" };
		gate = await start(d, "gate", {}, env);
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { ...env, PIM_CHATGPT_BASE_URL: openai.issuer, PIM_PROVIDER_COOLDOWN_MS: "600000"});
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
		await openai?.stop();
	}, 60_000);

	it("signs in through the Gate and keeps the credential sealed", async () => {
		expect((await web.call("GET", "/api/chatgpt")).json).toEqual({ connected: false, email: null });
		const login = await web.call("POST", "/api/chatgpt/login");
		expect(login.status).toBe(200);
		const url = new URL(login.json.url);
		expect(url.origin).toBe(openai.issuer);
		expect(url.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
		openai.state.nonce = url.searchParams.get("nonce")!;
		const landed = (state: string) => `http://127.0.0.1:1455/auth/callback?code=c1&state=${state}&client_id=client-1`;
		expect((await web.call("POST", "/api/chatgpt/callback", { url: landed("someone-elses") })).status).toBe(400);
		// A wrong address spends the sign-in: starting again is needed.
		expect((await web.call("POST", "/api/chatgpt/callback", { url: landed(url.searchParams.get("state")!) })).status).toBe(409);
		const again = new URL((await web.call("POST", "/api/chatgpt/login")).json.url);
		openai.state.nonce = again.searchParams.get("nonce")!;
		const done = await web.call("POST", "/api/chatgpt/callback", { url: landed(again.searchParams.get("state")!) });
		expect(done.json).toEqual({ connected: true, email: "anibal@example.com" });
		expect((await web.call("GET", "/api/chatgpt")).json).toEqual({ connected: true, email: "anibal@example.com" });
		const row = await stored();
		expect(row.secret).not.toContain("access-1");
		expect(await opened()).toMatchObject({ access: "access-1", refresh: "refresh-1", clientId: "client-1", subject: "acct-1" });
	}, 60_000);

	it("shows the plan and the person's providers in the model settings, and keeps the model they choose", async () => {
		const settings = (await web.call("GET", "/api/model")).json;
		expect(settings.chatgpt).toEqual({ connected: true, email: "anibal@example.com", error: null });
		expect(settings.default).toMatchObject({ provider: "faux", id: "m" });
		expect(settings.choices.map((c: { provider: string; id: string }) => `${c.provider}/${c.id}`)).toContain(`openai/${MODEL}`);
		const added = await web.call("POST", "/api/providers", { name: "Local", url: "http://127.0.0.1:9/v1", models: ["tiny"], key: "sk-local" });
		expect(added.status).toBe(201);
		expect(added.json.provider).toMatchObject({ name: "Local", url: "http://127.0.0.1:9/v1", hasKey: true, chosen: ["tiny"], models: [{ id: "tiny" }] });
		expect(JSON.stringify(added.json)).not.toContain("sk-local");
		const own = `own:${added.json.provider.id}`;
		const after = (await web.call("GET", "/api/model")).json;
		expect(after.providers).toMatchObject([{ provider: own, hasKey: true }]);
		expect(after.choices).toContainEqual(expect.objectContaining({ provider: own, id: "tiny" }));
		expect((await web.call("PUT", "/api/model", { provider: "nobody", id: "nothing" })).status).toBe(400);
		expect((await web.call("PUT", "/api/model", { provider: own, id: "tiny" })).json.model).toMatchObject({ provider: own, id: "tiny" });
		expect((await web.call("GET", "/api/model")).json.model).toMatchObject({ provider: own, id: "tiny" });
		// Choosing the default again follows it.
		expect((await web.call("PUT", "/api/model", { provider: "faux", id: "m" })).status).toBe(200);
		expect((await d.stack.admin.query("SELECT 1 FROM pim_app.owner_settings WHERE key = 'model'")).rowCount).toBe(0);
		expect((await web.call("DELETE", `/api/providers/${added.json.provider.id}`)).status).toBe(200);
	}, 60_000);

	it("runs a chat turn on the plan, refreshing the token first and writing the rotated one back", async () => {
		// Models of the person's list: the plan's first, then the deployment's default.
		expect((await web.call("PUT", "/api/model/fallbacks", { models: [{ provider: "openai", id: MODEL }, { provider: "faux", id: "m" }] })).status).toBe(200);
		chatId = (await web.call("POST", "/api/sessions", { title: "Plan" })).json.id;
		const before = (await stored()).version;
		await say("hello", "plan says hi");
		expect(openai.state.refreshes).toBe(1);
		expect(openai.state.responses).toEqual(["Bearer access-2"]);
		expect((await stored()).version).toBeGreaterThan(before);
		expect(await opened()).toMatchObject({ access: "access-2", refresh: "refresh-2", clientId: "client-1" });
		const calls = (await d.stack.admin.query("SELECT provider, model FROM pim_app.model_calls")).rows;
		expect(calls).toContainEqual({ provider: "openai", model: MODEL });
	}, 90_000);

	it("never spends a rotated refresh token twice when two Runners refresh at once", async () => {
		const expired = { ...(await opened()), expires: Date.now() - 1000 };
		await d.stack.admin.query("UPDATE pim_app.chatgpt_credentials SET secret = $1", [await sealString(crypto, JSON.stringify(expired), chatgptContext(ownerId))]);
		const endpoints = { issuer: openai.issuer, modelsUrl: `${openai.issuer}/v1/models`, resource: `${openai.issuer}/v1` };
		const { refreshChatGPT } = await import("@pim/v2-app/chatgpt");
		const refresh = () => chatgptCredentialStore(d.stack.runtime, crypto, ownerId).modify(async (current) => (current && current.expires <= Date.now() ? refreshChatGPT(current, { endpoints }) : undefined));
		const [a, b] = await Promise.all([refresh(), refresh()]);
		expect(openai.state.refreshes).toBe(2);
		expect(a?.access).toBe("access-3");
		expect(b?.access).toBe("access-3");
		expect(await opened()).toMatchObject({ access: "access-3", refresh: "refresh-3" });
	}, 60_000);

	it("moves to the next model on a 429, leaves nothing of the failed attempt, and skips the cooling model afterwards", async () => {
		openai.state.limited = true;
		faux.setResponses([fauxAssistantMessage([fauxToolCall("send_to_user", { message: "from the fallback" })], { stopReason: "toolUse" }), fauxAssistantMessage("ended the fallback")] as never);
		await say("hello again", "ended the fallback");
		const asked = openai.state.responses.length;
		expect(asked).toBeGreaterThanOrEqual(2);
		const shown = await transcript();
		expect(shown).not.toMatch(/rate limit/i);
		expect(shown).not.toContain('"stopReason":"error"');
		// The plan's model is cooling: the next turn goes straight to the fallback without asking it.
		faux.setResponses([fauxAssistantMessage([fauxToolCall("send_to_user", { message: "fallback again" })], { stopReason: "toolUse" }), fauxAssistantMessage("ended again")] as never);
		await say("and again", "ended again");
		expect(openai.state.responses).toHaveLength(asked);
		// The cooldown is in the database, where every other Runner reads it.
		expect((await d.stack.admin.query("SELECT ref FROM pim_runtime.provider_cooldowns WHERE until > now()")).rows.map((r) => r.ref)).toContain(`openai/${MODEL}`);
		const calls = (await d.stack.admin.query("SELECT provider, model FROM pim_app.model_calls")).rows;
		expect(calls).toContainEqual({ provider: "faux", model: "m" });
	}, 90_000);

	it("disconnects", async () => {
		expect((await web.call("DELETE", "/api/chatgpt")).json).toEqual({ connected: false, email: null });
		expect((await stored()).secret).toBeNull();
		expect((await web.call("GET", "/api/chatgpt")).json).toEqual({ connected: false, email: null });
	}, 30_000);
});
