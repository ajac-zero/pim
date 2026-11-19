import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fenceConfigText from "../src/fence-worker/wrangler.jsonc?raw";

/** Removes // and /* *\/ comments and trailing commas from JSONC, leaving string contents alone. */
function parseJsonc(text: string): any {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (inString) {
			out += c;
			if (c === "\\") out += text[++i] ?? "";
			else if (c === '"') inString = false;
		} else if (c === '"') {
			inString = true;
			out += c;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (c === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
		} else out += c;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const TOKEN = "fence-test-token-0123456789abcdef0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const fence = (path: string, init: RequestInit = {}) => fetchWorker(`https://pim.example.test${path}`, init);

import { exports } from "cloudflare:workers";
const fetchWorker = (url: string, init: RequestInit) => (exports.default as { fetch(request: Request): Promise<Response> }).fetch(new Request(url, init));

type Sqlish = { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
const seed = (stub: unknown, statements: string[], alarm?: number) =>
	runInDurableObject(stub as DurableObjectStub, async (_instance, state) => {
		const sql = state.storage.sql as unknown as Sqlish;
		for (const statement of statements) sql.exec(statement);
		if (alarm !== undefined) await state.storage.setAlarm(alarm);
	});

const JOBS = [
	"CREATE TABLE cf_agents_jobs (id TEXT PRIMARY KEY NOT NULL, capability TEXT NOT NULL, fn TEXT NOT NULL, time INTEGER NOT NULL, payload TEXT, running INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID",
	"INSERT INTO cf_agents_jobs (id, capability, fn, time, payload) VALUES ('j1', 'schedule', 'expireApproval', 1, '{\"a\":1}'), ('j2', 'schedule', 'runTriggerTick', 2, NULL), ('j3', 'schedule', 'pushReply', 3, NULL)",
];

describe("the inert fence worker", () => {
	it("answers every ordinary path with 503 Maintenance, and an export route without the token looks the same", async () => {
		for (const path of ["/", "/health", "/api/ws", "/auth/register", "/mcp", "/api/coding/gateway/anthropic/v1/messages", "/fence/v1/version"]) {
			const response = await fence(path);
			expect(response.status, path).toBe(503);
			expect(await response.json()).toMatchObject({ error: "Maintenance" });
		}
		expect((await fence("/fence/v1/version", { headers: { authorization: "Bearer wrong-token-wrong-token-wrong-token-1234" } })).status).toBe(503);
		expect((await fence("/fence/v1/version", { headers: auth })).status).toBe(200);
	});

	it("keeps the legacy Durable Object class and binding names, migrations and containers, as the legacy Worker declared them", () => {
		const config = parseJsonc(fenceConfigText);
		// The names the legacy Worker (the git tag `v1-final`) bound, and the classes its migrations created: they must not drift from what is deployed.
		expect(config.durable_objects.bindings).toEqual([
			{ name: "Pim", class_name: "Pim" },
			{ name: "Auth", class_name: "Auth" },
			{ name: "Directory", class_name: "Directory" },
			{ name: "Gallery", class_name: "Gallery" },
			{ name: "CodingScheduler", class_name: "CodingSchedulerDO" },
			{ name: "CodingThread", class_name: "CodingThreadDO" },
			{ name: "HostOps", class_name: "HostOps" },
			{ name: "WorkspaceContainer", class_name: "WorkspaceContainer" },
			{ name: "WorkspaceCatalog", class_name: "WorkspaceCatalog" },
		]);
		expect(config.migrations.map((m: any) => m.tag)).toEqual(["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"]);
		// Nothing is deleted, renamed or transferred; every migration only creates classes, and every bound class is created by one.
		expect(config.migrations.flatMap((m: any) => Object.keys(m)).filter((key: string) => key !== "tag" && key !== "new_sqlite_classes")).toEqual([]);
		const created = config.migrations.flatMap((m: any) => m.new_sqlite_classes);
		expect(created.slice().sort()).toEqual(config.durable_objects.bindings.map((b: any) => b.class_name).sort());
		expect(config.containers.map((c: any) => c.class_name)).toEqual(["WorkspaceContainer"]);
		expect(config.compatibility_date).toBe("2026-09-24");
		expect(config.main).toBe("./index.ts");
		expect(config.assets).toBeUndefined();
		// Every class the legacy Worker binds is exported by the shell and reachable through its binding.
		for (const binding of config.durable_objects.bindings) expect(env[binding.name as keyof typeof env], binding.name).toBeDefined();
	});

	it("consumes a due alarm on every alarming class without side effects, without deleting cf_agents_jobs rows and without re-arming", async () => {
		const due = Date.now() + 3_600_000;
		const stubs = {
			Pim: env.Pim.getByName("own_ada"),
			CodingThread: env.CodingThread.getByName("thr_1"),
			CodingScheduler: env.CodingScheduler.getByName("own_ada"),
			Directory: env.Directory.getByName("directory"),
			HostOps: env.HostOps.getByName("hostops"),
		};
		for (const [name, stub] of Object.entries(stubs)) {
			await seed(stub, [...JOBS, "CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY, note TEXT)", `INSERT INTO legacy_marker (note) VALUES ('${name}')`], due);
		}
		for (const [name, stub] of Object.entries(stubs)) {
			expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm()), `${name} alarm armed`).not.toBeNull();
			const ran = await runDurableObjectAlarm(stub);
			expect(ran, `${name} alarm ran`).toBe(true);
			await runInDurableObject(stub, async (_i, state) => {
				const sql = state.storage.sql as unknown as Sqlish;
				expect(sql.exec("SELECT id, fn FROM cf_agents_jobs ORDER BY id").toArray().map((r) => `${r.id}:${r.fn}`), `${name} jobs`).toEqual(["j1:expireApproval", "j2:runTriggerTick", "j3:pushReply"]);
				expect(sql.exec("SELECT note FROM legacy_marker").toArray(), `${name} marker`).toEqual([{ note: name }]);
				expect(await state.storage.getAlarm(), `${name} alarm not re-armed`).toBeNull();
			});
			expect(await runDurableObjectAlarm(stub), `${name} no second alarm`).toBe(false);
		}
	});

	it("exports every SQLite table, blob cell, key-value entry and alarm of a Durable Object through the authenticated routes, read-only", async () => {
		const stub = env.Pim.getByName("own_export");
		await seed(stub, [
			...JOBS,
			"CREATE TABLE pi_entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL) STRICT",
			...Array.from({ length: 1205 }, (_, i) => `INSERT INTO pi_entries (id, conversation_id, record) VALUES (${i}, 1, '{"n":${i}}')`),
			"CREATE TABLE pim_notes (id TEXT PRIMARY KEY, ydoc BLOB)",
			"INSERT INTO pim_notes VALUES ('n1', x'0001ff80')",
		]);
		await runInDurableObject(stub, async (_i, state) => {
			await state.storage.put("/own_export/conn/client/token", { access_token: "kv-secret" });
			await state.storage.put("plain", 42);
			await state.storage.setAlarm(Date.now() + 3_600_000);
		});
		const get = async (path: string) => (await fence(path, { headers: auth })).json() as Promise<any>;
		const tables = await get("/fence/v1/do/Pim/own_export/tables");
		expect(tables.map((t: any) => [t.name, t.rows]).sort()).toEqual([["cf_agents_jobs", 3], ["pi_entries", 1205], ["pim_notes", 1]]);
		expect(tables.find((t: any) => t.name === "cf_agents_jobs")).toMatchObject({ withoutRowid: true, pk: ["id"] });

		// Paged read of every row of a rowid table, then a WITHOUT ROWID table, then a blob.
		const ids: number[] = [];
		for (let after = 0, done = false; !done; ) {
			const page = await get(`/fence/v1/do/Pim/own_export/rows?table=pi_entries&after=${after}&limit=500`);
			ids.push(...page.rows.map((r: any) => r.id));
			after = page.next;
			done = page.done;
		}
		// optmem_log's first memory has id (and rowid) 0: a page cursor that skipped it lost that row, which the first real export found.
		expect(ids).toEqual(Array.from({ length: 1205 }, (_, i) => i));
		const jobs = [];
		for (let after = 0, done = false; !done; ) {
			const page = await get(`/fence/v1/do/Pim/own_export/rows?table=cf_agents_jobs&after=${after}&limit=2`);
			jobs.push(...page.rows.map((r: any) => r.id));
			after = page.next;
			done = page.done;
		}
		expect(jobs).toEqual(["j1", "j2", "j3"]);
		expect((await get("/fence/v1/do/Pim/own_export/rows?table=pim_notes&after=0&limit=10")).rows[0].ydoc).toEqual({ $b64: "AAH/gA==" });
		const kv = await get("/fence/v1/do/Pim/own_export/kv?limit=100");
		expect(kv.entries.map((e: any) => e.key).sort()).toEqual(["/own_export/conn/client/token", "plain"]);
		expect((await get("/fence/v1/do/Pim/own_export/alarm")).alarm).toBeGreaterThan(Date.now());
		expect((await get("/fence/v1/do/Pim/own_export/probe")).alive).toBe(true);

		// Only real tables are readable, and nothing writes: the SQL string cannot be injected, and POST is refused.
		expect((await fence('/fence/v1/do/Pim/own_export/rows?table=pi_entries"%3B%20DROP%20TABLE%20pi_entries%3B--&after=0&limit=1', { headers: auth })).status).toBe(500);
		expect((await fence("/fence/v1/do/Pim/own_export/tables", { method: "POST", headers: auth })).status).toBe(404);
		expect((await get("/fence/v1/do/Pim/own_export/tables")).find((t: any) => t.name === "pi_entries").rows).toBe(1205);
	});

	it("exports R2 objects and OAUTH_KV entries, and refuses to destroy a container unless the deploy allows it", async () => {
		await env.BLOBS.put("own_ada/img.png", new Uint8Array([1, 2, 3, 4]), { httpMetadata: { contentType: "image/png" } });
		await env.ARTIFACTS.put("own_ada/art/v1/index.html", "<p>hi</p>");
		await env.OAUTH_KV.put("client:1", JSON.stringify({ id: 1 }));
		const list = (await (await fence("/fence/v1/r2/BLOBS", { headers: auth })).json()) as any;
		expect(list.objects).toEqual([expect.objectContaining({ key: "own_ada/img.png", size: 4, contentType: "image/png" })]);
		const object = await fence("/fence/v1/r2/BLOBS/object?key=own_ada%2Fimg.png", { headers: auth });
		expect([...new Uint8Array(await object.arrayBuffer())]).toEqual([1, 2, 3, 4]);
		expect(((await (await fence("/fence/v1/kv/OAUTH_KV", { headers: auth })).json()) as any).keys.map((k: any) => k.name)).toEqual(["client:1"]);
		expect(((await (await fence("/fence/v1/kv/OAUTH_KV?key=client%3A1", { headers: auth })).json()) as any).value).toBe('{"id":1}');
		expect((await fence("/fence/v1/do/WorkspaceContainer/ws_1/destroy", { method: "POST", headers: auth })).status).toBe(403);
	});
});

import { FenceExporter } from "../src/migration/export.ts";
import type { DoDump } from "../src/migration/snapshot.ts";

describe("the exporter against the fence worker", () => {
	it("exports a Directory, its spaces, coding threads, objects and OAUTH_KV completely, every row counted", async () => {
		const owner = "own_exp";
		await seed(env.Directory.getByName("directory"), ["CREATE TABLE accounts (owner_id TEXT PRIMARY KEY, username TEXT, role TEXT, status TEXT)", `INSERT INTO accounts VALUES ('${owner}', 'exp', 'admin', 'active')`]);
		await seed(env.Auth.getByName(owner), ["CREATE TABLE auth_passkeys (id TEXT PRIMARY KEY, spki TEXT)", "INSERT INTO auth_passkeys VALUES ('pk1', 'abc')"]);
		await seed(env.Pim.getByName(owner), JOBS);
		await seed(env.CodingScheduler.getByName(owner), ["CREATE TABLE pim_coding_threads (thread_id TEXT PRIMARY KEY, harness TEXT)", "INSERT INTO pim_coding_threads VALUES ('thr_e1', 'amp')"]);
		await seed(env.CodingThread.getByName("thr_e1"), ["CREATE TABLE coding_thread (thread_id TEXT PRIMARY KEY, orb TEXT)", "INSERT INTO coding_thread VALUES ('thr_e1', '{\"threadId\":\"T-1\"}')"]);
		await runInDurableObject((env as unknown as Record<string, DurableObjectNamespace>).WorkspaceCatalog!.getByName("workspaces"), (_i, state) => state.storage.put("session:ws_1", true));
		await env.ARTIFACTS.put("own_exp/a/v1/index.html", "<p>x</p>");
		await env.BLOBS.put("own_exp/big.bin", new Uint8Array(300_000).fill(7), { httpMetadata: { contentType: "video/mp4" } });
		await env.OAUTH_KV.put("tok:1", JSON.stringify({ hash: "ff" }));

		const dumps: DoDump[] = [];
		const objects: { bucket: string; key: string; bytes: Uint8Array }[] = [];
		let kv: unknown[] = [];
		const result = await new FenceExporter({
			baseUrl: "https://pim.example.test",
			token: TOKEN,
			fetch: (request) => fetchWorker(request.url, { headers: request.headers }),
			sink: {
				dump: async (d) => void dumps.push(d),
				object: async (bucket, key, bytes) => void objects.push({ bucket, key, bytes }),
				oauthKv: async (entries) => void (kv = entries),
				finish: async () => undefined,
			},
		}).run();
		const by = (cls: string, name: string) => dumps.find((d) => d.class === cls && d.name === name);
		expect(result.spaces).toContain(owner);
		expect(by("Auth", owner)?.tables.auth_passkeys?.rows).toEqual([{ id: "pk1", spki: "abc" }]);
		expect(by("Pim", owner)?.tables.cf_agents_jobs?.rows.map((r) => r.id)).toEqual(["j1", "j2", "j3"]);
		expect(by("CodingThread", "thr_e1")?.tables.coding_thread?.rows[0]).toMatchObject({ orb: '{"threadId":"T-1"}' });
		expect(by("WorkspaceContainer", "ws_1")).toBeDefined();
		const big = objects.find((o) => o.key === "own_exp/big.bin")!;
		expect(big.bytes.length).toBe(300_000);
		expect(result.objects.find((o) => o.key === "own_exp/big.bin")).toMatchObject({ size: 300_000, contentType: "video/mp4", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect(kv).toContainEqual({ key: "tok:1", value: { hash: "ff" } });
	});
});
