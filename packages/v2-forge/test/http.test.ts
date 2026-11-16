import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GiteaConnection } from "../src/gitea";
import { type Authenticate, codingGitea, codingRest, codingVault, compose } from "../src/http";
import { ForgeVault, LocalEnvelopeCrypto } from "../src/vault";
import { ScriptedPort, ada, startReq, stack } from "./stack";

const people: Record<string, any> = {
	ada: { actor: { ownerId: "ada", role: "member" }, via: "session" },
	adaToken: { actor: { ownerId: "ada", role: "member" }, via: "token" },
	eve: { actor: { ownerId: "eve", role: "member" }, via: "session" },
	guest: { actor: { ownerId: "gus", role: "guest" }, via: "session" },
	root: { actor: { ownerId: "root", role: "admin" }, via: "session" },
	rootToken: { actor: { ownerId: "root", role: "admin" }, via: "token" },
};
const authenticate: Authenticate = async (req) => people[req.headers.get("x-user") ?? ""] ?? null;

describe("coding REST routes", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let api: ReturnType<typeof codingRest>;
	const call = async (who: string | null, method: string, path: string, body?: object) => {
		const res = await api(new Request(`https://pim.example.test${path}`, { method, headers: { ...(who ? { "x-user": who } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
		return { status: res!.status, body: (await res!.json()) as any };
	};
	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		api = codingRest({ forge: s.forge, scheduler: s.scheduler, store: s.store, db: s.db, authenticate });
	});
	afterAll(async () => s.close());

	it("answers 403 to no sign-in, a guest and a person with no coding grant, and falls through for other paths", async () => {
		expect((await call(null, "GET", "/api/coding/threads")).status).toBe(403);
		expect((await call("guest", "GET", "/api/coding/threads")).status).toBe(403);
		const denied = await call("eve", "POST", "/api/coding/threads", { repo: "https://github.com/acme/app", task: "x" });
		expect(denied).toMatchObject({ status: 403, body: { code: "forbidden" } });
		expect(await api(new Request("https://pim.example.test/api/chats"))).toBeNull();
	});

	it("starts a thread (201), the same operation again is the same thread (200), and lists, reads, steers and archives it", async () => {
		const first = await call("ada", "POST", "/api/coding/threads", { repo: "https://github.com/acme/app", task: "Fix it", harness: "claude-code", operationId: "rest-1" });
		expect(first.status).toBe(201);
		const again = await call("ada", "POST", "/api/coding/threads", { repo: "https://github.com/acme/app", task: "Fix it", harness: "claude-code", operationId: "rest-1" });
		expect(again).toMatchObject({ status: 200, body: { threadId: first.body.threadId, created: false } });
		const id = first.body.threadId;
		await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed", text: "Done. Branch ready." }, { outcome: "completed", text: "More." }]) } }).step(id);
		expect((await call("ada", "GET", "/api/coding/threads")).body.threads.map((t: any) => t.threadId)).toContain(id);
		expect((await call("ada", "GET", `/api/coding/threads/${id}`)).body).toMatchObject({ threadId: id, state: "idle", capabilities: { family: "sandbox-cli" } });
		expect((await call("eve", "GET", `/api/coding/threads/${id}`)).status).toBe(404);
		const t = await call("ada", "GET", `/api/coding/threads/${id}/transcript?tail=1&limit=1&role=assistant`);
		expect(t.body).toMatchObject({ total: 1, messages: [{ role: "assistant", text: "Done. Branch ready." }] });
		const out = await call("ada", "GET", `/api/coding/threads/${id}/output?id=${t.body.messages[0].id}`);
		expect(out.body.text).toBe("Done. Branch ready.");
		expect((await call("ada", "POST", `/api/coding/threads/${id}/steer`, { text: "more", operationId: "s1" })).status).toBe(202);
		expect((await call("ada", "GET", `/api/coding/threads/${id}/tests`)).body).toEqual({ runs: [] });
		expect((await call("ada", "GET", `/api/coding/threads/${id}/events?after=0`)).body.events.length).toBeGreaterThan(0);
		expect((await call("ada", "POST", `/api/coding/threads/${id}/seen`)).status).toBe(200);
		expect((await call("ada", "POST", `/api/coding/threads/${id}/cancel`)).body).toMatchObject({ code: "not_cancellable" });
		expect((await call("ada", "POST", `/api/coding/threads/${id}/pull-request`, {})).body).toMatchObject({ code: "not_pushed" });
		expect((await call("ada", "POST", `/api/coding/threads/${id}/archive`)).status).toBe(200);
		expect((await call("ada", "GET", "/api/coding/threads")).body.threads.map((t: any) => t.threadId)).not.toContain(id);
		expect((await call("ada", "GET", "/api/coding/threads?archived=1")).body.threads.map((t: any) => t.threadId)).toContain(id);
		expect((await call("ada", "POST", `/api/coding/threads/${id}/steer`, { text: "again" })).body.code).toBe("archived");
		expect((await call("ada", "GET", "/api/coding/threads/nope")).status).toBe(404);
	});

	it("files an approval for a push that needs one (202), and a deployment with no pool answers 503 while reads still work", async () => {
		await s.grantAll("bo", { requiresApproval: true });
		const bo = { actor: { ownerId: "bo", role: "member" }, via: "session" };
		people.bo = bo;
		const start = await call("bo", "POST", "/api/coding/threads", { repo: "https://github.com/acme/app", task: "t", harness: "claude-code", operationId: "bo-1" });
		await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed" }]) } }).step(start.body.threadId);
		await s.commit(start.body.threadId, "x.txt", "x");
		const push = await call("bo", "POST", `/api/coding/threads/${start.body.threadId}/push`);
		expect(push).toMatchObject({ status: 202, body: { status: "approval_required" } });
		await s.pool.query("update pim_forge.forge_pools set enabled = false");
		const none = await call("ada", "POST", "/api/coding/threads", { repo: "https://github.com/acme/app", task: "t", operationId: "nopool-1" });
		expect(none).toMatchObject({ status: 503, body: { code: "unavailable" } });
		expect((await call("ada", "GET", "/api/coding/threads")).status).toBe(200);
		await s.pool.query("update pim_forge.forge_pools set enabled = true");
	});

	it("keeps a person's setup script per repository, refuses an oversized one and a repository the deployment doesn't allow", async () => {
		expect((await call("ada", "GET", "/api/coding/repos/acme/app/settings")).body).toMatchObject({ repo: "acme/app", setupScript: "" });
		expect((await call("ada", "PUT", "/api/coding/repos/acme/app/settings", { setupScript: "pnpm i" })).body.setupScript).toBe("pnpm i");
		expect((await call("ada", "GET", "/api/coding/repos/acme/app/settings")).body.setupScript).toBe("pnpm i");
		expect((await call("eve", "GET", "/api/coding/repos/acme/app/settings")).status).toBe(403);
		expect((await call("ada", "PUT", "/api/coding/repos/acme/app/settings", { setupScript: "x".repeat(70_000) })).status).toBe(400);
		expect((await call("ada", "GET", "/api/coding/repos/evil/repo/settings")).status).toBe(403);
	});

	it("manages pools for an admin's browser session only, and records who changed them", async () => {
		expect((await call("ada", "GET", "/api/admin/coding/pools")).status).toBe(403);
		expect((await call("rootToken", "GET", "/api/admin/coding/pools")).status).toBe(403);
		expect((await call("root", "PUT", "/api/admin/coding/pools/gpu", { provider: "compose", size: 2, priority: 5 })).status).toBe(200);
		expect((await call("root", "PUT", "/api/admin/coding/pools/Bad_Id", { provider: "compose", size: 2 })).status).toBe(400);
		expect((await call("root", "PUT", "/api/admin/coding/pools/gpu", { provider: "compose", size: 5000 })).status).toBe(400);
		const list = (await call("root", "GET", "/api/admin/coding/pools")).body.pools;
		expect(list.find((p: any) => p.id === "gpu")).toMatchObject({ size: 2, priority: 5, enabled: true, held: 0 });
		await call("root", "PUT", "/api/admin/coding/pools/gpu", { provider: "compose", size: 3 });
		expect((await call("root", "DELETE", "/api/admin/coding/pools/gpu")).status).toBe(200);
		const audit = await s.pool.query("select payload ->> 'type' t from pim_forge.forge_outbox where payload ->> 'poolId' = 'gpu' order by id");
		expect(audit.rows.map((r) => r.t)).toEqual(["pim.sandbox_pool_added", "pim.sandbox_pool_changed", "pim.sandbox_pool_removed"]);
		expect((await call("root", "DELETE", "/api/admin/coding/pools/gpu")).status).toBe(404);
	});
});

describe("coding vault and Gitea routes", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let vault: ForgeVault;
	let handler: ReturnType<typeof compose>;
	let giteaServer: ReturnType<typeof createServer>;
	let gitea: GiteaConnection;
	let now = Date.now();
	const grants = { refresh: 0, failRefresh: false };
	const call = async (who: string | null, method: string, path: string, body?: object) => {
		const res = await handler(new Request(`https://pim.example.test${path}`, { method, headers: { ...(who ? { "x-user": who } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
		return { status: res!.status, text: await res!.text() };
	};
	const jsonOf = (r: { text: string }) => JSON.parse(r.text);

	beforeAll(async () => {
		s = await stack();
		const crypto = new LocalEnvelopeCrypto({ keyId: "k", key: randomBytes(32) });
		vault = new ForgeVault(s.db, crypto);
		giteaServer = createServer(async (req, res) => {
			let body = "";
			for await (const c of req) body += c;
			if (req.url === "/login/oauth/access_token") {
				const b = JSON.parse(body);
				if (b.grant_type === "refresh_token") {
					grants.refresh++;
					if (grants.failRefresh) return void res.writeHead(400, { "content-type": "application/json" }).end("{}");
					return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }));
				}
				if (!b.code_verifier || b.code !== "good-code") return void res.writeHead(400, { "content-type": "application/json" }).end("{}");
				return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }));
			}
			if (req.url === "/api/v1/user") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ login: "pim-bot" }));
			res.writeHead(404).end();
		});
		await new Promise<void>((r) => giteaServer.listen(0, "127.0.0.1", r));
		gitea = new GiteaConnection(s.db, crypto, { baseUrl: `http://127.0.0.1:${(giteaServer.address() as AddressInfo).port}`, clientId: "cid", clientSecret: "csecret", redirectUri: "https://pim.example.test/api/coding/gitea/callback" }, fetch, () => now);
		const login = { start: async (o: string, h: string) => ({ started: h, o }), status: async () => ({ state: "waiting" }), cancel: async () => ({}), submitCode: async (_o: string, c: string) => ({ got: c }) };
		handler = compose(codingVault({ vault, authenticate, login }), codingGitea({ gitea, authenticate }));
	});
	afterAll(async () => {
		giteaServer.closeAllConnections();
		giteaServer.close();
		await s.close();
	});

	it("keeps an API key write-only: status says connected, never the key, and a bad key is refused without being quoted", async () => {
		const key = "sgamp_abcdefghijklmnop1234567890";
		const put = await call("ada", "PUT", "/api/coding/vault/amp/api-key", { apiKey: key });
		expect(put.status).toBe(200);
		const status = await call("ada", "GET", "/api/coding/vault");
		expect(jsonOf(status).harnesses.find((h: any) => h.harness === "amp")).toMatchObject({ connected: true });
		expect(status.text + put.text).not.toContain("abcdefghijklmnop");
		expect(await vault.loadApiKey("ada", "amp")).toBe(key);
		// Sealed at rest, bound to the person: not readable as another person's or in the clear.
		const raw = (await s.pool.query("select sealed from pim_forge.forge_vault where owner_id = 'ada' and harness = 'amp'")).rows[0].sealed as Buffer;
		expect(raw.toString()).not.toContain("abcdefghijklmnop");
		await s.pool.query("insert into pim_forge.forge_vault (owner_id, harness, version, sealed, byte_length) values ('eve', 'amp', 1, $1, 1)", [raw]);
		expect(await vault.loadApiKey("eve", "amp")).toBeNull();
		const bad = await call("ada", "PUT", "/api/coding/vault/amp/api-key", { apiKey: "short" });
		expect(bad.status).toBe(400);
		expect(bad.text).not.toContain("short\"");
		expect((await call("ada", "PUT", "/api/coding/vault/claude-code/api-key", { apiKey: key })).status).toBe(404);
		expect((await call("ada", "PUT", "/api/coding/vault/nonsense/api-key", { apiKey: key })).status).toBe(404);
		expect((await call("guest", "GET", "/api/coding/vault")).status).toBe(403);
	});

	it("a tampered entry reads as none, and disconnecting takes effect at once despite the read cache", async () => {
		expect(await vault.loadApiKey("ada", "amp")).toBeTruthy();
		await s.pool.query("update pim_forge.forge_vault set sealed = set_byte(sealed, 40, get_byte(sealed, 40) # 1) where owner_id = 'ada' and harness = 'amp'");
		vault.cache.clear();
		expect(await vault.loadApiKey("ada", "amp")).toBeNull();
		await s.pool.query("delete from pim_forge.forge_vault where owner_id = 'ada'");
		await call("ada", "PUT", "/api/coding/vault/amp/api-key", { apiKey: "sgamp_abcdefghijklmnop1234567890" });
		expect(await vault.loadApiKey("ada", "amp")).toBeTruthy();
		expect(jsonOf(await call("ada", "DELETE", "/api/coding/vault/amp")).connected).toBe(false);
		expect(await vault.loadApiKey("ada", "amp")).toBeNull();
	});

	it("keeps a stale login write from overwriting a newer one", async () => {
		const file = (text: string) => [{ path: "auth.json", mode: 0o600, data: new TextEncoder().encode(text) }];
		expect((await vault.save("ada", "codex", file("v1"), 0)).ok).toBe(true);
		expect((await vault.save("ada", "codex", file("v2"), 1)).ok).toBe(true);
		const stale = await vault.save("ada", "codex", file("stale"), 1);
		expect(stale).toMatchObject({ ok: false, version: 2 });
		expect(new TextDecoder().decode((await vault.load("ada", "codex")).files![0]!.data)).toBe("v2");
	});

	it("passes the CLI sign-in routes to the deployment's login workspace, and says 503 when there is none", async () => {
		expect(jsonOf(await call("ada", "POST", "/api/coding/vault/codex/login"))).toMatchObject({ started: "codex" });
		expect(jsonOf(await call("ada", "POST", "/api/coding/vault/claude-code/login/code", { code: "abc" }))).toEqual({ got: "abc" });
		const bare = compose(codingVault({ vault, authenticate }));
		const res = await bare(new Request("https://pim.example.test/api/coding/vault/codex/login", { method: "POST", headers: { "x-user": "ada" } }));
		expect(res!.status).toBe(503);
	});

	it("connects Gitea for the admin only: PKCE state is single-use and the admin's own, tokens are sealed, refresh works and a refused refresh asks for a reconnect", async () => {
		expect(jsonOf(await call("ada", "GET", "/api/coding/gitea/status"))).toMatchObject({ connected: false });
		expect((await call("ada", "POST", "/api/coding/gitea/connect")).status).toBe(403);
		expect((await call("rootToken", "POST", "/api/coding/gitea/connect")).status).toBe(403);
		const url = new URL(jsonOf(await call("root", "POST", "/api/coding/gitea/connect")).url);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("client_id")).toBe("cid");
		const state = url.searchParams.get("state")!;
		expect((await call("root", "GET", "/api/coding/gitea/callback?code=good-code&state=bogus")).status).toBe(400);
		expect((await call("root", "GET", `/api/coding/gitea/callback?code=bad-code&state=${state}`)).status).toBe(400);
		// A failed exchange used the state up.
		expect((await call("root", "GET", `/api/coding/gitea/callback?code=good-code&state=${state}`)).status).toBe(400);
		const state2 = new URL(jsonOf(await call("root", "POST", "/api/coding/gitea/connect")).url).searchParams.get("state")!;
		expect(jsonOf(await call("root", "GET", `/api/coding/gitea/callback?code=good-code&state=${state2}`))).toMatchObject({ connected: true, login: "pim-bot" });
		expect(jsonOf(await call("ada", "GET", "/api/coding/gitea/status"))).toMatchObject({ connected: true, login: "pim-bot" });
		const sealed = (await s.pool.query("select sealed from pim_forge.forge_gitea_connection")).rows[0].sealed as Buffer;
		expect(sealed.toString()).not.toContain("at-1");
		expect(await gitea.accessToken()).toBe("at-1");
		now += 3_599_000;
		expect(await gitea.accessToken()).toBe("at-2");
		expect(grants.refresh).toBe(1);
		now += 3_599_000;
		grants.failRefresh = true;
		expect(await gitea.accessToken()).toBeNull();
		expect(jsonOf(await call("ada", "GET", "/api/coding/gitea/status"))).toMatchObject({ connected: false, needsReconnect: true });
		expect((await call("ada", "POST", "/api/coding/gitea/disconnect")).status).toBe(403);
		expect(jsonOf(await call("root", "POST", "/api/coding/gitea/disconnect")).login).toBeNull();
	});
});
