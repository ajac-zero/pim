// `generate_image` on the real stack, against stand-ins of the providers' endpoints: an OpenAI-compatible image endpoint (a person's own provider) and ChatGPT's Codex image
// service with its token endpoint. Without any of them the tool says images are not available; with a provider the image lands in the person's files, bytes intact; the
// ChatGPT images sign-in goes through the Gate (paste-back), is sealed, is refreshed once by the Runner under the row's lock, and is what draws once connected.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { KeyringCrypto, openString } from "@pim/v2-app/crypto";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { codexContext } from "../src/codex-images.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");
// A real 1x1 PNG, so the file's type is sniffed from its bytes as for any image.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const OTHER_PNG = Buffer.concat([PNG.subarray(0, PNG.length - 12), Buffer.from("0000000049454e44ae426082", "hex")]);

/** The parts of the providers the code talks to, with what it was asked kept for the assertions. */
async function standIn() {
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const state = { compatible: [] as { auth: string | undefined; body: any }[], codex: [] as { auth: string; account: string; body: any }[], refreshes: 0, valid: "refresh-1", tokenForms: [] as URLSearchParams[] };
	const accessToken = (n: number, lifetimeSeconds: number) =>
		`${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + lifetimeSeconds, "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" }, n }))}.sig`;
	const idToken = `${b64u("{}")}.${b64u(JSON.stringify({ email: "anibal@example.com" }))}.sig`;
	const server: Server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const text = Buffer.concat(chunks).toString();
		const json = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
		if (req.url === "/oauth/token") {
			const form = text.startsWith("{") ? new URLSearchParams(Object.entries(JSON.parse(text))) : new URLSearchParams(text);
			state.tokenForms.push(form);
			if (form.get("grant_type") === "authorization_code") return json(200, { access_token: accessToken(1, 100), refresh_token: "refresh-1", id_token: idToken });
			// A refresh token is single-use: a stale one is what a lost rotation looks like.
			if (form.get("refresh_token") !== state.valid) return json(400, { error: "invalid_grant" });
			state.refreshes++;
			state.valid = `refresh-${state.refreshes + 1}`;
			return json(200, { access_token: accessToken(state.refreshes + 1, 3600), refresh_token: state.valid });
		}
		if (req.url === "/v1/images/generations") {
			const body = JSON.parse(text);
			state.compatible.push({ auth: req.headers.authorization, body });
			return json(200, { data: [{ b64_json: PNG.toString("base64") }] });
		}
		if (req.url === "/codex/images") {
			state.codex.push({ auth: String(req.headers.authorization), account: String(req.headers["chatgpt-account-id"]), body: JSON.parse(text) });
			return json(200, { data: [{ b64_json: OTHER_PNG.toString("base64") }] });
		}
		json(404, { error: "no such route" });
	});
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	return { origin, state, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

real("generate_image", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let web: Client;
	let app: App;
	let providers: Awaited<ReturnType<typeof standIn>>;
	let ownerId: string;
	let chatId: string;
	let n = 0;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const key = randomBytes(32);
	const crypto = new KeyringCrypto("k1", { k1: new Uint8Array(key) });
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

	const transcript = async () => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_app.conversations WHERE public_chat_id = $1", [chatId])).rows[0];
		return JSON.stringify(await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id)));
	};
	const draw = async (prompt: string, extra: Record<string, unknown> = {}) => {
		const id = ++n;
		faux.setResponses([toolUse(fauxToolCall("generate_image", { prompt, ...extra })), fauxAssistantMessage(`done ${id}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${id}`, text: prompt })).status).toBe(202);
		await waitFor(`turn ${id} to end`, async () => ((await transcript()).includes(`done ${id}`) ? true : undefined), 60_000);
		const results = (JSON.parse(await transcript()) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === "generate_image").map((m) => m.content.map((c) => c.text ?? "").join("")));
		return results[results.length - 1]!;
	};
	const file = async (path: string) => {
		const res = await fetch(`${web.base}/api/files/content?path=${encodeURIComponent(path)}`, { headers: { "x-pim-ingress-secret": web.ingress, cookie: web.cookie } });
		return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
	};

	beforeAll(async () => {
		providers = await standIn();
		process.env.PIM_CODEX_AUTH_URL = providers.origin;
		process.env.PIM_DEFAULT_MODEL = "faux/m";
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		const env = { PIM_KEK_k1: key.toString("base64"), PIM_KEK_CURRENT: "k1", PIM_DEFAULT_MODEL: "faux/m", PIM_CODEX_AUTH_URL: providers.origin, PIM_CODEX_IMAGES_URL: `${providers.origin}/codex/images` };
		gate = await start(d, "gate", {}, env);
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		chatId = (await web.call("POST", "/api/sessions", { title: "Pictures" })).json.id;
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider], fetch: ((url: string | URL, init?: RequestInit) => fetch(url, init)) as typeof fetch }, { ...env, PIM_APP_DATABASE_URL: stack.url("gate"), PIM_IMAGE_MODEL: "local/img-1" });
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
		await providers?.stop();
	}, 60_000);

	it("says images are not available when no provider can draw them", async () => {
		const answer = await draw("a red kite over a hill");
		expect(answer).toMatch(/Images are not available on this Pim/);
		expect(answer).toMatch(/ChatGPT plan for images/);
		expect((await file("/workspace/images/anything.png")).status).toBe(404);
	}, 90_000);

	it("draws on one of the person's own image-capable providers and keeps the image in their files", async () => {
		const added = await web.call("POST", "/api/providers", { name: "Local", url: `${providers.origin}/v1`, models: ["img-1"], key: "sk-local" });
		expect(added.status).toBe(201);
		// The deployment names the provider (PIM_IMAGE_MODEL=local/img-1) by the name the person gave it.
		const answer = await draw("a red kite over a hill", { shape: "landscape", path: "/workspace/images/kite.png" });
		const saved = JSON.parse(answer);
		expect(saved.image).toMatchObject({ path: "/workspace/images/kite.png", model: "local/img-1", type: "image/png", bytes: PNG.length });
		expect(providers.state.compatible).toHaveLength(1);
		expect(providers.state.compatible[0]).toMatchObject({ auth: "Bearer sk-local", body: { model: "img-1", prompt: "a red kite over a hill", size: "1536x1024" } });
		const stored = await file("/workspace/images/kite.png");
		expect(stored.status, stored.bytes.toString()).toBe(200);
		expect(stored.bytes.equals(PNG)).toBe(true);
		// It is one of the files of the Files screen too.
		const listed = await web.call("GET", "/api/files?path=/workspace/images");
		expect(listed.json.entries.map((e: { name: string }) => e.name)).toEqual(["kite.png"]);
		// A path outside the files is refused before anything is drawn.
		expect(await draw("a tree", { path: "/etc/passwd" })).toMatch(/not one of the person's files/);
		expect(providers.state.compatible).toHaveLength(1);
		// The call is in the cost ledger as a request.
		expect((await d.stack.admin.query("SELECT model FROM pim_app.model_calls WHERE provider = 'images'")).rows).toEqual([{ model: "local/img-1" }]);
	}, 90_000);

	it("signs in with ChatGPT for images, seals the credential, and draws with it after one refresh", async () => {
		expect((await web.call("GET", "/api/chatgpt/images")).json).toEqual({ connected: false, email: null });
		const login = await web.call("POST", "/api/chatgpt/images/login");
		const url = new URL(login.json.url);
		expect(url.origin).toBe(providers.origin);
		expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		const landed = (state: string) => `http://localhost:1455/auth/callback?code=c1&state=${state}`;
		expect((await web.call("POST", "/api/chatgpt/images/callback", { url: landed("someone-elses") })).status).toBe(400);
		// A wrong address spends the sign-in: starting again is needed.
		expect((await web.call("POST", "/api/chatgpt/images/callback", { url: landed(url.searchParams.get("state")!) })).status).toBe(409);
		const again = new URL((await web.call("POST", "/api/chatgpt/images/login")).json.url);
		const done = await web.call("POST", "/api/chatgpt/images/callback", { url: landed(again.searchParams.get("state")!) });
		expect(done.json).toEqual({ connected: true, email: "anibal@example.com" });
		expect((await web.call("GET", "/api/model")).json.chatgptImages).toEqual({ connected: true, email: "anibal@example.com" });
		const row = (await d.stack.admin.query("SELECT secret FROM pim_app.chatgpt_image_credentials")).rows[0];
		expect(row.secret).not.toContain("refresh-1");
		expect(JSON.parse(await openString(crypto, row.secret, codexContext(ownerId)))).toMatchObject({ refresh: "refresh-1", accountId: "acct-9" });

		// The first access token lives 100 seconds, inside the refresh margin, so drawing refreshes first, once.
		const answer = await draw("a blue boat", { shape: "portrait" });
		expect(JSON.parse(answer).image).toMatchObject({ model: "gpt-image-2", type: "image/png", bytes: OTHER_PNG.length });
		expect(providers.state.refreshes).toBe(1);
		expect(providers.state.codex).toHaveLength(1);
		expect(providers.state.codex[0]).toMatchObject({ account: "acct-9", body: { model: "gpt-image-2" } });
		expect(providers.state.codex[0]!.body.prompt).toContain("a blue boat");
		expect(providers.state.codex[0]!.body.prompt).toContain("2:3");
		expect(providers.state.codex[0]!.auth).toMatch(/^Bearer /);
		const written = JSON.parse(await openString(crypto, (await d.stack.admin.query("SELECT secret FROM pim_app.chatgpt_image_credentials")).rows[0].secret, codexContext(ownerId)));
		expect(written.refresh).toBe("refresh-2");
		const saved = JSON.parse(answer).image.path as string;
		expect(saved).toMatch(/^\/workspace\/images\/.+\.png$/);
		expect((await file(saved)).bytes.equals(OTHER_PNG)).toBe(true);
		// The provider above was not used for it, and a second image needs no second refresh.
		expect(providers.state.compatible).toHaveLength(1);
		await draw("a green door");
		expect(providers.state.refreshes).toBe(1);
		expect(providers.state.codex).toHaveLength(2);
	}, 120_000);

	it("signs out, and the provider draws again", async () => {
		expect((await web.call("DELETE", "/api/chatgpt/images")).json).toEqual({ connected: false, email: null });
		expect((await web.call("GET", "/api/chatgpt/images")).json).toEqual({ connected: false, email: null });
		expect((await d.stack.admin.query("SELECT secret FROM pim_app.chatgpt_image_credentials")).rows[0].secret).toBeNull();
		await draw("a yellow sun");
		expect(providers.state.compatible).toHaveLength(2);
	}, 90_000);
});
