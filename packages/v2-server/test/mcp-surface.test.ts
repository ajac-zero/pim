// Pim as an MCP server, end to end on the real stack: an MCP client signs in with OAuth (registration, consent, PKCE) and calls the `pim` tool; the call waits for what the agent
// sends the person in that turn (as v1's did), continues a conversation, and the tool is described as v1 described it (title, input and output schemas).
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());

real("Pim's MCP server", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let live: Process;
	let web: Client;
	let app: App;
	let token = "";
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	const rpc = async (body: object, bearer = token) => {
		const res = await fetch(`${base(gate)}/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-pim-ingress-secret": d.ingressSecret, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) });
		return { status: res.status, json: (await res.json().catch(() => null)) as any };
	};

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		const keys = { PIM_KEK_T1: randomBytes(32).toString("base64"), PIM_KEK_CURRENT: "t1" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate", {}, keys);
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		expect((await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true })).status).toBe(201);
		live = await start(d, "live", { pollMs: 40 }, keys);
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), ...keys });
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([runner?.close(), live?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("signs a client in with OAuth 2.1 (registration, consent, PKCE) and lists the pim tool as v1 described it", async () => {
		const redirect = "http://127.0.0.1:9999/callback";
		const reg = await fetch(`${base(gate)}/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "x-pim-ingress-secret": d.ingressSecret }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect] }) }).then((r) => r.json() as Promise<any>);
		const verifier = randomBytes(32).toString("base64url");
		const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: redirect, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "st" });
		const consent = await web.call("GET", `/auth/authorize?${q}`);
		expect(consent.json).toMatchObject({ client: { name: "Claude" } });
		const code = new URL((await web.call("POST", "/auth/authorize", { handle: consent.json.handle, allow: true })).json.redirectTo).searchParams.get("code")!;
		const issued = await fetch(`${base(gate)}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-pim-ingress-secret": d.ingressSecret }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }) }).then((r) => r.json() as Promise<any>);
		token = issued.access_token;
		expect(token).toBeTruthy();
		const listed = (await rpc({ method: "tools/list" })).json.result.tools;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ name: "pim", title: "Message Pim", annotations: { readOnlyHint: false, openWorldHint: true } });
		expect(listed[0].inputSchema.required).toEqual(["message"]);
		expect(listed[0].outputSchema.required).toEqual(["conversation", "reply"]);
		expect(listed[0].description).toContain("pass it back as conversation to continue");
	});

	it("waits for what the agent sends the person, and continues the conversation it names", async () => {
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: "Hello from the majordomo." })), fauxAssistantMessage("done")] as never);
		const first = (await rpc({ method: "tools/call", params: { name: "pim", arguments: { message: "Say hello" } } })).json.result;
		expect(first.isError).toBe(false);
		expect(first.structuredContent.reply).toBe("Hello from the majordomo.");
		expect(first.content[0].text).toBe(`Hello from the majordomo.\n\n[conversation: ${first.structuredContent.conversation}]`);

		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: "Second answer." })), fauxAssistantMessage("done again")] as never);
		const second = (await rpc({ method: "tools/call", params: { name: "pim", arguments: { message: "And again", conversation: first.structuredContent.conversation } } })).json.result;
		// Only what this turn sent: not the first answer again.
		expect(second.structuredContent).toEqual({ conversation: first.structuredContent.conversation, reply: "Second answer." });
		expect((await rpc({ method: "tools/call", params: { name: "pim", arguments: { message: "x", conversation: "00000000-0000-4000-8000-000000000000" } } })).status).toBe(400);
		expect((await rpc({ method: "tools/call", params: { name: "other", arguments: {} } })).json.error.message).toBe("Unknown tool");
		expect((await rpc({ method: "tools/list" }, "wrong")).status).toBe(401);
	}, 120_000);
});
