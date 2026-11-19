// The Gate's own limits (sign-in and registration per address, the API per owner, public addresses per address; a limit that cannot be read is 0) and the providers an
// admin shares with everyone: listed beside a person's own, never with a key, usable by a Runner for anyone with the key opened under the admin's id.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@pim/v2-app/app";
import { KeyringCrypto } from "@pim/v2-app/crypto";
import { connect as connectApp } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { adminCompatRoutes } from "../src/compat/admin.ts";
import { modelRoutes } from "../src/compat/model.ts";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAgentHost } from "../src/agent-host.ts";
import { gateBefore } from "../src/limits.ts";
import { createStack, type Stack } from "./support/stack.ts";

describe("limits and shared providers", () => {
	let stack: Stack;
	let app: App;
	let crypto: KeyringCrypto;
	const servers: Server[] = [];
	const people: Record<string, { token: string; ownerId: string }> = {};
	const listen = async (build: (app: App) => Server) => {
		const s = build(app);
		servers.push(s);
		await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
		return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
	};
	const call = async (url: string, who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
		const res = await fetch(url + path, { method, headers: { ...(who ? { authorization: `Bearer ${people[who]!.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const text = await res.text();
		return { status: res.status, json: res.headers.get("content-type")?.includes("json") && text ? JSON.parse(text) : text, headers: res.headers };
	};

	beforeAll(async () => {
		stack = await createStack();
		crypto = new KeyringCrypto("t1", { t1: new Uint8Array(randomBytes(32)) });
		app = new App(connectApp(stack.url("gate"), 6), new MemoryObjectStore(), { crypto });
		const ada = await app.identity.register({ username: "ada", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000) });
		await app.identity.setRegistrationOpen({ kind: "user", ownerId: ada.ownerId, role: "admin", sessionId: "s" }, true);
		const bob = await app.identity.register({ username: "bob" });
		for (const [name, a] of [["ada", ada], ["bob", bob]] as const) people[name] = { ownerId: a.ownerId, token: await app.identity.createSession(a.ownerId) };
	}, 120_000);
	afterAll(async () => {
		await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
		await app?.db.end();
		await stack?.drop();
	});

	it("limits sign-in per address, the API per owner and public addresses per address, and reads a bad limit as 0", async () => {
		const gate = await listen((a) => createGate(a, { first: adminCompatRoutes, before: gateBefore(a, { PIM_RATE_AUTH: "3", PIM_RATE_API: "5", PIM_RATE_PUBLIC: "2" }) }));
		const statuses = async (n: number, f: () => Promise<{ status: number }>) => {
			const out: number[] = [];
			for (let i = 0; i < n; i++) out.push((await f()).status);
			return out;
		};
		// The API is counted per owner: Ada's sixth request is refused, Bob's first is not.
		expect(await statuses(6, () => call(gate, "ada", "GET", "/api/admin/stats"))).toEqual([200, 200, 200, 200, 200, 429]);
		const refused = await call(gate, "ada", "GET", "/api/admin/stats");
		expect(refused.json).toMatchObject({ error: "rate_limited", message: "Too many requests. Slow down a little." });
		expect(refused.headers.get("retry-after")).toBe("60");
		expect((await call(gate, "bob", "GET", "/api/builtin-apps")).status).toBe(200);
		// Sign-in and registration writes are counted per address, reads are not.
		expect(await statuses(4, () => call(gate, null, "POST", "/auth/sign-out", {}))).toEqual([expect.any(Number), expect.any(Number), expect.any(Number), 429]);
		expect((await call(gate, null, "POST", "/auth/register", {})).json.message).toBe("Too many attempts. Wait a minute and try again.");
		expect((await call(gate, null, "GET", "/auth/username?name=ok")).status).not.toBe(429);
		// Public addresses are counted per address.
		expect(await statuses(3, () => call(gate, null, "GET", "/api/bots/b_unknown"))).toEqual([404, 404, 429]);
		// A limit that cannot be read is 0: refusing everything, never lifting the limit.
		const zero = await listen((a) => createGate(a, { first: adminCompatRoutes, before: gateBefore(a, { PIM_RATE_API: "lots" }) }));
		expect((await call(zero, "bob", "GET", "/api/builtin-apps")).status).toBe(429);
	});

	it("counts by the address the proxy sets only when the deployment trusts the proxy, and a window ends", async () => {
		const gate = await listen((a) => createGate(a, { first: adminCompatRoutes, before: gateBefore(a, { PIM_RATE_AUTH: "1", PIM_INGRESS_SECRET: "s".repeat(32) }) }));
		const post = (ip: string) => call(gate, null, "POST", "/auth/sign-out", {}, { "x-pim-client-ip": ip }).then((r) => r.status);
		expect(await post("203.0.113.1")).not.toBe(429);
		expect(await post("203.0.113.2")).not.toBe(429);
		expect(await post("203.0.113.1")).toBe(429);
		// Without the secret the header is the client's to forge, so it is ignored: every request here comes from one socket.
		const open = await listen((a) => createGate(a, { first: adminCompatRoutes, before: gateBefore(a, { PIM_RATE_AUTH: "1" }) }));
		const spoof = (ip: string) => call(open, null, "POST", "/auth/sign-out", {}, { "x-pim-client-ip": ip }).then((r) => r.status);
		expect([await spoof("198.51.100.1"), await spoof("198.51.100.2")]).toEqual([expect.any(Number), 429]);
		expect(await app.limits.hit("t", "k", 1, 60)).toBe(true);
		expect(await app.limits.hit("t", "k", 1, 60)).toBe(false);
		await new Promise((r) => setTimeout(r, 90));
		expect(await app.limits.hit("t", "k", 1, 60)).toBe(true);
	});

	it("shares an admin's provider with everyone, without its key, and a Runner calls it with the key opened under the admin's id", async () => {
		const seen: { url?: string; authorization?: string }[] = [];
		const upstream = createServer((req, res) => {
			seen.push({ url: req.url, authorization: req.headers.authorization });
			req.resume();
			req.on("end", () => {
				const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "team-large", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				res.writeHead(200, { "content-type": "text/event-stream" }).end(chunk({ role: "assistant", content: "hello from the team" }) + chunk({}, "stop") + "data: [DONE]\n\n");
			});
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		servers.push(upstream);
		const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
		const gate = await listen((a) => createGate(a, { first: [...adminCompatRoutes, ...modelRoutes({})] }));

		// Only an admin shares one.
		expect((await call(gate, "bob", "POST", "/api/admin/providers", { name: "Team", url, key: "sk-team", models: ["team-large"] })).status).toBe(403);
		const made = await call(gate, "ada", "POST", "/api/admin/providers", { name: "Team", url, key: "sk-team", models: ["team-large"] });
		expect(made.status).toBe(201);
		const id = made.json.provider.id as string;
		expect(JSON.stringify(made.json)).not.toContain("sk-team");

		const bobModel = (await call(gate, "bob", "GET", "/api/model")).json;
		expect(bobModel.choices).toEqual(expect.arrayContaining([expect.objectContaining({ provider: `shared:${id}`, id: "team-large" })]));
		expect(bobModel.providers).toEqual([expect.objectContaining({ id, provider: `shared:${id}`, name: "Team", shared: true, hasKey: true })]);
		expect(JSON.stringify(bobModel)).not.toContain("sk-team");
		// The admin sees it once, as shared, and chooses it as anyone does.
		const adaModel = (await call(gate, "ada", "GET", "/api/model")).json;
		expect(adaModel.providers.map((p: any) => [p.provider, p.shared])).toEqual([[`shared:${id}`, true]]);
		expect((await call(gate, "bob", "PUT", "/api/model", { provider: `shared:${id}`, id: "team-large" })).status).toBe(200);
		// Bob's own provider stays his: Ada never sees it, and setting the flag on it shares nothing.
		const own = await app.providers.create({ kind: "user", ownerId: people.bob!.ownerId as never, role: "member", sessionId: "s" }, { kind: "openai_compatible", name: "Mine", config: { baseUrl: url, models: [{ id: "mine" }], shared: true }, apiKey: "sk-bob" });
		expect((await call(gate, "ada", "GET", "/api/model")).json.providers.map((p: any) => p.name)).toEqual(["Team"]);
		await app.providers.remove({ kind: "user", ownerId: people.bob!.ownerId as never, role: "member", sessionId: "s" }, own.id);

		// A Runner builds Bob's catalog with it, and a call goes out with the key the admin set.
		const host = createAgentHost({ db: stack.runtime, env: {}, crypto });
		const partition = (await stack.admin.query("SELECT partition_id FROM pim_app.partitions WHERE owner_id = $1 AND home", [people.bob!.ownerId])).rows[0].partition_id;
		const options = await host.harnessOptions({ ownerId: people.bob!.ownerId, partitionId: partition, home: true, lease: {} as never });
		const available = await (options.models as any).getAvailable();
		expect(available.map((m: any) => `${m.provider}/${m.id}`)).toContain(`shared:${id}/team-large`);
		const model = available.find((m: any) => m.provider === `shared:${id}`);
		const reply = await (options.models as any).complete(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
		expect(JSON.stringify(reply.content)).toContain("hello from the team");
		expect(seen.at(-1)).toMatchObject({ authorization: "Bearer sk-team" });

		// Taking it away takes it from everyone's catalog.
		expect((await call(gate, "ada", "DELETE", `/api/admin/providers/${id}`)).json).toEqual({ deleted: true });
		expect((await call(gate, "bob", "GET", "/api/model")).json.providers).toEqual([]);
	});
	it("refuses a model request once the day's requests or tokens are used up, counting each request as it is sent, and never an admin's", async () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const host = createAgentHost({ db: stack.runtime, env: { PIM_LIMIT_DAILY_MODEL_REQUESTS: "2", PIM_LIMIT_DAILY_TOKENS: "100" }, crypto, providers: () => [faux.provider] });
		const request = async (who: string) => {
			const partition = (await stack.admin.query("SELECT partition_id FROM pim_app.partitions WHERE owner_id = $1 AND home", [people[who]!.ownerId])).rows[0].partition_id;
			const options = await host.harnessOptions({ ownerId: people[who]!.ownerId, partitionId: partition, home: true, lease: {} as never });
			const models = options.models as any;
			const model = (await models.getAvailable()).find((m: any) => m.provider === "faux");
			faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("hi")) as never);
			const message = await models.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, {}).result();
			return message.stopReason === "error" ? message.errorMessage : "answered";
		};
		// Three requests at once: two take the allowance and one is refused, whichever it is.
		const answers = await Promise.all([request("bob"), request("bob"), request("bob")]);
		expect(answers.filter((a) => a === "answered")).toHaveLength(2);
		expect(answers.find((a) => a !== "answered")).toBe("Space usage quota exceeded: 2 model requests a day. It resets at midnight UTC.");
		// Tokens are known once a request ends: the day's 100 are used, so the next request is refused. A plan's tokens are not the deployment's.
		const cy = await app.identity.register({ username: "cy" });
		people.cy = { ownerId: cy.ownerId, token: "" };
		await app.usage.record(cy.ownerId, { id: "plan", runKind: "chat", provider: "chatgpt", model: "gpt", inputTokens: 5000, outputTokens: 0, costMicroUsd: 0 });
		expect(await request("cy")).toBe("answered");
		await app.usage.record(cy.ownerId, { id: "paid", runKind: "chat", provider: "faux", model: "m", inputTokens: 60, outputTokens: 30, cacheReadTokens: 20, costMicroUsd: 0 });
		expect(await request("cy")).toBe("Space usage quota exceeded: 100 tokens a day. It resets at midnight UTC.");
		// An admin has no limits.
		expect(await Promise.all([request("ada"), request("ada"), request("ada")])).toEqual(["answered", "answered", "answered"]);
	});
});
