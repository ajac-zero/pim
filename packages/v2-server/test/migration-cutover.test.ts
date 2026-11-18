// A cutover rehearsal on the real stack: a legacy export (the ops package's synthetic snapshot) is imported into the landing schema, audited, promoted into the
// live schemas, and then real gate, live and runner processes serve it: an imported passkey signs in, imported forked chats read over the snapshot API,
// a new message in an imported chat runs on a Runner, and Forge adopts an imported Amp thread without starting it again.
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type HarnessOptions } from "@earendil-works/pi-durable";
import { FakeOrbClient } from "@pim/coding/orb/fake";
import { sealBlob, vaultKey } from "@pim/coding/vault/crypto";
import { HARNESS_API_KEYS } from "@pim/shared/harnesses";
import { ForgeVault } from "@pim/v2-forge/vault";
import { KeyringCrypto, openString } from "@pim/v2-app/crypto";
import { userHandle } from "@pim/v2-app/signin";
import { EnvelopeCrypto } from "@pim/v2-ops/crypto/envelope";
import { auditImport } from "@pim/v2-ops/migration/audit";
import { FIXTURE_CUTOVER_AT, type FixtureInfo, buildLegacySnapshot } from "@pim/v2-ops/migration/fixture";
import { importSnapshot } from "@pim/v2-ops/migration/import";
import { FsObjectStore } from "@pim/v2-ops/migration/objects";
import { SnapshotReader } from "@pim/v2-ops/migration/snapshot";
import type { Db as ForgeDb } from "@pim/v2-forge/db";
import { MemoryObjects } from "@pim/v2-forge/ports";
import { ForgeScheduler } from "@pim/v2-forge/scheduler";
import { ForgeStore } from "@pim/v2-forge/store";
import { ForgeWorker } from "@pim/v2-forge/worker";
import { chatUuid, promoteToLive } from "../src/migration-bridge.ts";
import type { Process } from "../src/main.ts";
import { waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Authenticator } from "./support/authenticator.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());

/** What the synthetic snapshot lacks of Ada's space: an agent, a skill with a file, memories, a goal, a circle and a chat link, as the legacy tables hold them. */
async function legacyDomain(admin: Pool, objects: FsObjectStore, conversation: string | number) {
	const sha = "ab".repeat(32);
	const legacy = (await admin.query("SELECT legacy_id FROM pim_ops.owner_map WHERE owner_id = $1", [ADA])).rows[0].legacy_id as string;
	await objects.put("BLOBS", `${legacy}/skills/${sha}`, Buffer.from("# reference\n"));
	const at = FIXTURE_CUTOVER_AT - 86_400_000;
	// A file kept in the space before files moved to computers: a row of `pim_stored_files`, its bytes in the BLOBS bucket at `<owner>/files/<id>` (B4.11).
	const bytes = Buffer.from("%PDF");
	await objects.put("BLOBS", `${legacy}/files/f1`, bytes);
	await admin.query("INSERT INTO pim_ops.objects (bucket, key, owner_id, size_bytes, sha256, content_type) VALUES ('BLOBS', $1, $2, 4, $3, 'application/pdf')", [`${legacy}/files/f1`, ADA, createHash("sha256").update(bytes).digest("hex")]);
	const rows: [string, string, unknown][] = [
		["pim_stored_files", "notes/old.pdf", { path: "notes/old.pdf", id: "f1", type: "application/pdf", bytes: 4, updated_at: at }],
		["pim_agents", "ag_poet", { id: "ag_poet", name: "Poet", instructions: "Answer in verse.", model: "faux/m", fallbacks: "[]", skills: "[\"Haiku\"]", apps: "[]", contacts: "[]", role: null, description: "", is_default: 0, symbol: "P", color: "blue", created_at: at }],
		["pim_agent_icons", "icon1", { agent: "ag_poet", type: "image/png", data: { $b64: PNG.toString("base64") }, updated_at: at }],
		["pim_skills", "Haiku", { name: "Haiku", created_at: at }],
		["pim_skill_versions", "Haiku:1", { name: "Haiku", version: 1, description: "Write haiku", instructions: "Five, seven, five.", created_at: at }],
		["pim_skill_files", "Haiku:1:ref.md", { name: "Haiku", version: 1, path: "ref.md", sha256: sha }],
		["optmem_log", "1", { id: 1, scope: "everyone", text: "Ada likes tea\nblack, no sugar", date: new Date(at).toISOString() }],
		["pim_goals", "g_5k", { id: "g_5k", title: "Run a 5k", status: "active", steps: "[\"Run 2k\",{\"title\":\"Run 4k\",\"done\":true}]", created_at: at }],
		["pim_circles", "c_friends", { id: "c_friends", name: "Friends" }],
		["pim_circle_members", "c_friends:grace", { circle_id: "c_friends", owner_id: "own_grace" }],
	];
	const session = String(conversation);
	rows.push(["pim_agent_sessions", session, { session, agent: "ag_poet" }], ["pim_chat_links", "lnk1", { id: "lnk1", session, shared_at: at }]);
	for (const [table, pk, row] of rows) await admin.query("INSERT INTO pim_ops.legacy_rows (owner_id, source, table_name, pk, row) VALUES ($1,'Pim',$2,$3,$4)", [ADA, table, pk, JSON.stringify(row)]);
}
const ADA = "o_own_ada";
/** A real one-pixel PNG: the icon object is sniffed as an image when served. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

real("a cutover rehearsal", () => {
	let d: Deployment;
	let info: FixtureInfo;
	let web: Client;
	const procs: Process[] = [];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const key = new Authenticator("ES256");
	const asked: string[] = [];
	let legacyObjects: FsObjectStore;
	const copied = new Map<string, Uint8Array>();
	const appKeys = new KeyringCrypto("a1", { a1: Buffer.alloc(32, 5) });
	const opsKeys = new EnvelopeCrypto({ k1: Buffer.alloc(32, 1) }, "k1");

	const ACTIVATED_AT = FIXTURE_CUTOVER_AT + 3_600_000;
	const promoteOptions = () => ({ rpId: "127.0.0.1", env: { GOOGLE_GMAIL_CLIENT_ID: "gmail-client", GOOGLE_GMAIL_CLIENT_SECRET: "gmail-secret" }, cutoverAt: FIXTURE_CUTOVER_AT, activatedAt: ACTIVATED_AT, defaultAgent: { provider: "faux", modelId: "m" }, crypto: { ops: opsKeys, app: appKeys }, objects: { get: (bucket: string, key: string) => legacyObjects.get(bucket, key), put: async (key: string, bytes: Uint8Array) => void copied.set(key, bytes) } });
	const hooks = () => {
		const models = createModels();
		models.setProvider(faux.provider);
		const agent = { model: { provider: "faux", modelId: "m" } };
		return { harnessOptions: (): HarnessOptions => ({ models, registry: createRegistry(), settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1_000 } } as never }), homeRoot: () => ({ agent }), chatAgent: () => agent, pollMs: 40 };
	};

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		const dir = await mkdtemp(join(tmpdir(), "pim-cutover-"));
		info = await buildLegacySnapshot(join(dir, "snapshot"));
		const reader = new SnapshotReader(join(dir, "snapshot"));
		const objects = new FsObjectStore(join(dir, "s3"));
		legacyObjects = objects;
		const crypto = opsKeys;
		await importSnapshot(stack.admin, reader, { cutoverId: "cut-1", crypto, objects, appCredentialsKey: info.keys.appCredentialsKey.toString("base64") });
		const audit = await auditImport(stack.admin, reader, objects, { cutoverId: "cut-1" });
		expect(audit.checks.filter((c) => !c.ok)).toEqual([]);
		// The synthetic snapshot's assistant messages are bare; pi's own carry a usage record and a stop reason, which pi reads back when it builds the next request.
		await stack.admin.query(`
			UPDATE pim_ops.pi_entries SET record = jsonb_set(record, '{model,0}', (record->'model'->0) || jsonb_build_object('usage', jsonb_build_object('input', 0, 'output', 0, 'cacheRead', 0, 'cacheWrite', 0, 'totalTokens', 0, 'cost', jsonb_build_object('input', 0, 'output', 0, 'cacheRead', 0, 'cacheWrite', 0, 'total', 0)), 'stopReason', 'stop', 'api', 'faux', 'provider', 'faux', 'model', 'm', 'timestamp', 1))
			WHERE record->'model'->0->>'role' = 'assistant'`);
		// The synthetic snapshot has no live document; a real one keeps the run of a chat cut off mid-tool (here the plain chat's http_request) in it.
		const cut = (await stack.admin.query("SELECT id, conversation_id, partition_id FROM pim_ops.pi_tasks WHERE owner_id = $1 AND record::text LIKE '%call_http_1%' ORDER BY id LIMIT 1", [ADA])).rows[0];
		const live = { run: { taskId: Number(cut.id), inputs: [] }, tools: [{ callId: "call_http_1", name: "http_request", taskId: Number(cut.id), status: "running" }], generation: { attempt: 1 } };
		const docRecord = { id: 9_000_000, kind: "pi.live", scope: { kind: "conversation", conversationId: Number(cut.conversation_id) }, history: "latest", fork: "initial", createdAt: 1 };
		await stack.admin.query("INSERT INTO pim_ops.pi_documents (owner_id, id, partition_id, kind, family, key_value, scope_kind, scope_owner_id, created_at, record) VALUES ($1,9000000,$2,'pi.live',0,'','conversation',$3,1,$4)", [ADA, cut.partition_id, cut.conversation_id, JSON.stringify(docRecord)]);
		await stack.admin.query("INSERT INTO pim_ops.pi_document_revisions (owner_id, document_id, seq, kind, version, content) VALUES ($1,9000000,1,'base',1,$2)", [ADA, JSON.stringify(live)]);
		// The fixture's own pi.agent documents of that chat and of the home chat are stubs without pi's document semantics; the promotion's default agent stands in for them.
		await stack.admin.query("DELETE FROM pim_ops.pi_document_revisions WHERE owner_id = $1 AND document_id IN (SELECT id FROM pim_ops.pi_documents WHERE owner_id = $1 AND kind = 'pi.agent' AND scope_owner_id IN ($2, 1))", [ADA, cut.conversation_id]);
		await stack.admin.query("DELETE FROM pim_ops.pi_documents WHERE owner_id = $1 AND kind = 'pi.agent' AND scope_owner_id IN ($2, 1)", [ADA, cut.conversation_id]);
		// A conversation last run on the old deployment's model (Workers AI), a provider the new one does not have: pi would answer every new message with "Model ... is not available".
		await stack.admin.query("UPDATE pim_ops.pi_document_revisions SET content = '{\"model\":{\"provider\":\"workers-ai\",\"modelId\":\"@cf/llama\"}}'::jsonb WHERE owner_id = $1 AND document_id = (SELECT max(id) FROM pim_ops.pi_documents WHERE owner_id = $1 AND kind = 'pi.agent' AND scope_owner_id NOT IN (1, $2))", [ADA, cut.conversation_id]);
		await legacyDomain(stack.admin, objects, cut.conversation_id);
		// The first conversation (the home partition's) is a chat of its own in a real space; the synthetic snapshot links it to none.
		await stack.admin.query("INSERT INTO pim_ops.chats (owner_id, public_id, conversation_id, title, created_at_ms, updated_at_ms) VALUES ($1, 'home-chat', 1, 'Home', 1, 1) ON CONFLICT DO NOTHING", [ADA]);
		// The synthetic passkeys' keys are random bytes; Ada's is replaced by a real one so the test can sign in with it.
		await stack.admin.query("UPDATE pim_ops.passkeys SET id = $1, spki = $2, algorithm = -7 WHERE owner_id = $3 AND id = (SELECT min(id) FROM pim_ops.passkeys WHERE owner_id = $3)", [key.id, key.spki, ADA]);
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled(procs.map((p) => p.close()));
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("promotes the landing into the live schemas, idempotently", async () => {
		const report = await promoteToLive(d.stack.admin, promoteOptions());
		expect(report.owners).toEqual(expect.arrayContaining([ADA]));
		expect(report.chats).toBeGreaterThanOrEqual(6);
		expect(report.messages).toBeGreaterThan(0);
		expect(report.orphanedTasks).toBeGreaterThan(0);
		expect(report.clearedRuns).toBe(1);
		expect(report.remappedModels).toBeGreaterThan(0);
		expect(await Number((await d.stack.admin.query("SELECT count(*) n FROM pim_runtime.document_revisions WHERE content::text LIKE '%workers-ai%'")).rows[0].n)).toBe(0);
		const count = async (sql: string) => Number((await d.stack.admin.query(sql)).rows[0].n);
		const before = [await count("SELECT count(*) n FROM pim_app.accounts"), await count("SELECT count(*) n FROM pim_app.conversations"), await count("SELECT count(*) n FROM pim_runtime.entries"), await count("SELECT count(*) n FROM pim_projection.chat_transcript_projection"), await count("SELECT count(*) n FROM pim_forge.forge_threads")];
		expect(before.every((n) => n > 0)).toBe(true);
		await promoteToLive(d.stack.admin, promoteOptions());
		expect([await count("SELECT count(*) n FROM pim_app.accounts"), await count("SELECT count(*) n FROM pim_app.conversations"), await count("SELECT count(*) n FROM pim_runtime.entries"), await count("SELECT count(*) n FROM pim_projection.chat_transcript_projection"), await count("SELECT count(*) n FROM pim_forge.forge_threads")]).toEqual(before);
		// Ada's space came across: agents, skills with their files, memories, goals, circles, shares, apps, notes, and the secrets under the new keys.
		const as = async <T>(sql: string, args: unknown[] = []) => (await d.stack.admin.query(sql, args)).rows as T[];
		expect((await as("SELECT instructions, config FROM pim_app.agents WHERE owner_id = $1 AND id = 'ag_poet'", [ADA]))[0]).toMatchObject({ instructions: "Answer in verse.", config: { model: { provider: "faux", id: "m" }, skills: ["Haiku"] } });
		// What the person chose for a connector's tool is carried: their own choice as it was, an agent's as on or off (asking meant off), a circle's not at all; the connector keeps its approval policy.
		expect(await as("SELECT audience, app, tool, permission FROM pim_app.tool_permissions WHERE owner_id = $1 ORDER BY audience", [ADA])).toEqual([{ audience: "agent:ag_1", app: "conn_gmail", tool: "send_email", permission: "off" }, { audience: "owner", app: "conn_gmail", tool: "send_email", permission: "ask" }]);
		expect(await as("SELECT approval FROM pim_app.connectors WHERE owner_id = $1 AND id = 'conn_gmail'", [ADA])).toEqual([{ approval: "all" }]);
		expect(await count(`SELECT count(*) n FROM pim_app.conversations WHERE owner_id = '${ADA}' AND agent_id = 'ag_poet'`)).toBeGreaterThan(0);
		expect((await as("SELECT body, files, version FROM pim_app.skills WHERE owner_id = $1 AND name = 'Haiku'", [ADA]))[0]).toMatchObject({ body: "Five, seven, five.", files: { "ref.md": "# reference\n" }, version: 1 });
		expect((await as("SELECT title, body FROM pim_app.memories WHERE owner_id = $1", [ADA]))[0]).toMatchObject({ title: "Ada likes tea", body: "Ada likes tea\nblack, no sugar" });
		expect((await as("SELECT title, done FROM pim_app.goal_steps WHERE owner_id = $1 AND goal_id = 'g_5k' ORDER BY position", [ADA])).map((r: any) => [r.title, r.done])).toEqual([["Run 2k", false], ["Run 4k", true]]);
		expect((await as("SELECT name, members FROM pim_app.circles WHERE owner_id = $1", [ADA]))[0]).toMatchObject({ name: "Friends" });
		expect(await count(`SELECT count(*) n FROM pim_app.shares WHERE owner_id = '${ADA}' AND link = 'lnk1'`)).toBe(1);
		expect(await count(`SELECT count(*) n FROM pim_app.artifact_versions WHERE owner_id = '${ADA}'`)).toBeGreaterThan(0);
		expect(await count(`SELECT count(*) n FROM pim_app.note_updates WHERE owner_id = '${ADA}'`)).toBeGreaterThan(0);
		// The ChatGPT sign-in came across as it was, sealed under the application's keys, with the same agent host id: nobody signs in again.
		const plan = (await as<{ secret: string; email: string; host_id: string }>("SELECT secret, email, host_id FROM pim_app.chatgpt_credentials WHERE owner_id = $1", [ADA]))[0]!;
		expect(plan).toMatchObject({ email: "ada@example.test", host_id: "urn:uuid:11111111-1111-4111-8111-111111111111" });
		expect(JSON.parse(await openString(appKeys, plan.secret, `chatgpt:${ADA}`))).toMatchObject({ type: "oauth", access: "chatgpt-access-example", refresh: "chatgpt-refresh-example", clientId: "client-example" });
		expect(await as("SELECT 1 FROM pim_app.providers WHERE owner_id = $1 AND kind = 'openai'", [ADA])).toHaveLength(0);
		// A connected MCP server comes across with its address and its tokens, and a native connector with its tokens converted to v2's bundle, all sealed under the application's keys.
		const mcp = (await as<{ kind: string; url: string; status: string; credential: string; approval: string }>("SELECT kind, url, status, credential, approval FROM pim_app.connectors WHERE owner_id = $1 AND id = 'mcp_notes'", [ADA]))[0]!;
		expect(mcp).toMatchObject({ kind: "custom_mcp", url: "https://mcp.example.test/mcp", status: "connected", approval: "none" });
		expect(JSON.parse(await openString(appKeys, mcp.credential, `connector:${ADA}/mcp_notes`))).toEqual({ access_token: "mcp-oauth-notes-access-example", refresh_token: "mcp-oauth-notes-refresh-example", client_id: "client_9", client_secret: "mcp-client-secret-notes-example" });
expect(await as("SELECT kind, app_ref, status FROM pim_app.connectors WHERE owner_id = $1 AND id = 'conn_gmail'", [ADA])).toEqual([{ kind: "native", app_ref: "google/gmail", status: "connected" }]);
		const gmail = (await as<{ credential: string }>("SELECT credential FROM pim_app.connectors WHERE owner_id = $1 AND id = 'conn_gmail'", [ADA]))[0]!;
		expect(JSON.parse(await openString(appKeys, gmail.credential, `connector:${ADA}/conn_gmail`))).toMatchObject({ access_token: "ya29.example-access", refresh_token: "1//example-refresh", expires_at: expect.any(Number), token_endpoint: "https://oauth2.googleapis.com/token", client_id: "gmail-client", client_secret: "gmail-secret" });
		// The deployment has no Spotify client: the tokens come across, and the report says they cannot be renewed.
		expect(report.skipped.join("\n")).toMatch(/connector conn_spot \(spotify\): promoted with its tokens.*no OAuth client/);
		// What the admin shared with everyone: a provider the Runner can call is the deployment's own, its key sealed for the deployment and not for any person; a built-in service stays in the landing.
		const shared = await as<{ id: string; config: { url: string }; secret: string }>("SELECT id, config, secret FROM pim_app.instance_providers");
		expect(shared.map((p) => p.id)).toEqual(["prov_1"]);
		expect(await openString(appKeys, shared[0]!.secret, "provider:_instance/prov_1")).toBe("sk-example-not-a-real-key-123");
		expect(report.skipped.join("\n")).toMatch(/shared provider prov_2: kept sealed in the landing; the built-in anthropic service/);
		expect(await as<{ p: { id: string; shared?: boolean }[] }>("SELECT pim_app.runner_providers($1) AS p", [ADA]).then((r) => r[0]!.p.filter((p) => p.shared).map((p) => p.id))).toEqual(["shared:prov_1"]);
		// Templates, the bot the admin shared (its own model named without the old catalog's prefix) and the agent everyone starts with.
		expect(await as("SELECT id, owner_id, agent_id, title, bundle, uses, default_for_everyone FROM pim_app.templates")).toEqual([{ id: "tpl_1", owner_id: ADA, agent_id: "agent_ada_1", title: "Researcher", bundle: { agent: { name: "Researcher", instructions: "Be brief.", emoji: "R", color: "blue" }, description: "Reads things", apps: [] }, uses: 3, default_for_everyone: true }]);
		expect(await as("SELECT id, owner_id, agent_id, name, settings FROM pim_app.bots")).toEqual([{ id: "b_ada1", owner_id: ADA, agent_id: "agent_ada_1", name: "Ask Ada", settings: { dailyMessages: 25, dailyToolCalls: 5, model: { provider: "prov_own", id: "m" }, tools: ["search", "create_ticket"], ask: ["create_ticket"] } }]);
		for (const p of await as<{ id: string; secret: string | null }>("SELECT id, secret FROM pim_app.providers WHERE owner_id = $1 AND secret IS NOT NULL", [ADA])) expect((await openString(appKeys, p.secret!, `provider:${ADA}/${p.id}`)).length).toBeGreaterThan(0);
		// A file from before files moved to computers: its bytes are an object under the new owner, and its path is kept in an index, since an object key has no room for it.
		expect(Buffer.from(copied.get(`${ADA}/files/f1`)!).toString()).toBe("%PDF");
		expect((await as("SELECT value FROM pim_app.owner_settings WHERE owner_id = $1 AND key = 'legacy_files'", [ADA]))[0]).toMatchObject({ value: [{ path: "notes/old.pdf", key: `${ADA}/files/f1`, type: "application/pdf", bytes: 4 }] });
		expect(await count(`SELECT count(*) n FROM pim_app.objects WHERE key = '${ADA}/files/f1' AND purpose = 'file'`)).toBe(1);
		// The agent's uploaded icon is a public image object under the person, which the agent's icon_key names; a second promotion leaves it and any icon uploaded since alone.
		expect(await as("SELECT icon_key FROM pim_app.agents WHERE owner_id = $1 AND id = 'ag_poet'", [ADA])).toEqual([{ icon_key: `${ADA}/agent-icons/ag_poet` }]);
		expect(Buffer.from(copied.get(`${ADA}/agent-icons/ag_poet`)!).equals(PNG)).toBe(true);
		expect(await count(`SELECT count(*) n FROM pim_app.objects WHERE key = '${ADA}/agent-icons/ag_poet' AND purpose = 'image' AND acl = 'public'`)).toBe(1);
		expect(report.domain["agent icons"]).toBe(1);
		// Nothing that was due while the fence stood comes back: a time trigger counts from the activation.
		const stale = await count(`SELECT count(*) n FROM pim_app.triggers WHERE owner_id = '${ADA}' AND source = 'time' AND watermark < ${ACTIVATED_AT}`);
		expect(stale).toBe(0);
		// The numeric ids are the legacy ones, and the app's chat ids are the runtime's.
		const same = await count("SELECT count(*) n FROM pim_app.conversations c JOIN pim_runtime.conversation_partitions p ON p.public_chat_id = c.public_chat_id AND p.conversation_id = c.conversation_id AND p.partition_id = c.partition_id");
		expect(same).toBe(await count("SELECT count(*) n FROM pim_app.conversations"));
		const held = await count("SELECT count(*) n FROM pim_runtime.tasks WHERE status <> 'terminal' AND id IN (SELECT id FROM pim_ops.pi_tasks WHERE hold IS NOT NULL)");
		expect(held).toBe(0);
	});

	it("promotes a v1-sealed coding credential into a v2 vault entry that opens to the same bytes, and leaves it alone the second time", async () => {
		const admin = d.stack.admin;
		const apiKey = `${HARNESS_API_KEYS.amp.prefix}${"k".repeat(40)}`;
		// What v1 wrote: sealed by its own code under the key made from the Directory's cookie key, bound to the legacy owner id and the harness.
		const sealed = await sealBlob(await vaultKey(info.keys.cookieKey), { userId: "own_ada", harness: "amp" }, new TextEncoder().encode(apiKey));
		await admin.query("INSERT INTO pim_ops.legacy_rows (owner_id, source, table_name, pk, row) VALUES ($1,'Pim:own_ada','pim_coding_vault','amp',$2)", [ADA, JSON.stringify({ sealed: { $b64: Buffer.from(sealed).toString("base64") }, harness: "amp", version: 3, updated_at: 1, byte_length: apiKey.length })]);
		const vault = new ForgeVault(admin as never, appKeys);
		expect(await vault.loadApiKey(ADA, "amp")).toBeNull();
		const report = await promoteToLive(admin, promoteOptions());
		expect(report.domain["coding credentials"]).toBe(1);
		expect(await vault.loadApiKey(ADA, "amp")).toBe(apiKey);
		const stored = (await admin.query("SELECT version, sealed FROM pim_forge.forge_vault WHERE owner_id = $1 AND harness = 'amp'", [ADA])).rows[0];
		expect(Buffer.from(stored.sealed).includes(Buffer.from(apiKey))).toBe(false);
		// Again, and after the person entered another key: nothing changes.
		await promoteToLive(admin, promoteOptions());
		expect((await admin.query("SELECT version, sealed FROM pim_forge.forge_vault WHERE owner_id = $1 AND harness = 'amp'", [ADA])).rows[0]).toEqual(stored);
		const newer = `${HARNESS_API_KEYS.amp.prefix}${"n".repeat(40)}`;
		await new ForgeVault(admin as never, appKeys).saveApiKey(ADA, "amp", newer);
		await promoteToLive(admin, promoteOptions());
		expect(await new ForgeVault(admin as never, appKeys).loadApiKey(ADA, "amp")).toBe(newer);
	});

	it("boots real processes that sign in with an imported passkey and read imported forked chats", async () => {
		const gate = await start(d, "gate");
		const live = await start(d, "live", { pollMs: 40 });
		procs.push(gate, live);
		web = new Client(base(gate), d.ingressSecret);
		const challenge = await web.call("POST", "/auth/sign-in/options");
		const signedIn = await web.call("POST", "/auth/sign-in", key.get(challenge.json, base(gate), userHandle(ADA)));
		expect(signedIn.status).toBe(200);
		expect((await web.call("GET", "/auth/session")).json).toMatchObject({ signedIn: true, account: { ownerId: ADA } });

		const read = async (chat: string) => (await web.call("GET", `/api/snapshot/chat/${chat}?limit=200`)).json as { messages: { id: string; role: string }[] };
		const branched = await read(info.chats.branched);
		const fork = await read(info.chats.fork);
		const nested = await read(info.chats.nestedFork);
		const plain = await read(info.chats.plain);
		for (const s of [branched, fork, nested, plain]) expect(s.messages.length).toBeGreaterThan(0);
		// A fork shows its parent's history up to the fork point, then its own: the shared prefix has the same entry ids.
		const shared = branched.messages.filter((m) => fork.messages.some((f) => f.id === m.id));
		expect(shared.length).toBeGreaterThan(0);
		expect(fork.messages.map((m) => m.id).slice(0, shared.length)).toEqual(shared.map((m) => m.id));
		expect(fork.messages.length).toBeGreaterThan(shared.length - 1);
		// The sidebar lists the imported chats.
		const sidebar = (await web.call("GET", "/api/snapshot/sidebar?limit=100")).json as { sessions: { chatId: string }[] };
		expect(sidebar.sessions.map((s) => s.chatId)).toEqual(expect.arrayContaining([info.chats.plain, info.chats.branched, info.chats.fork]));
	}, 60_000);

	it("runs a new message in an imported chat on a Runner, after the imported history, with projections continuing", async () => {
		// Any call the imported work makes gets a plain answer; the one this test sends gets its own.
		const answer = (ctx: { messages: { role: string; content: unknown }[] }) => {
			const last = JSON.stringify(ctx.messages.at(-1)?.content ?? "");
			asked.push(last);
			return fauxAssistantMessage(last.includes("what did we say before") ? "We said hello, and now we are on v2." : "Noted.");
		};
		faux.setResponses(Array.from({ length: 40 }, () => answer as never));
		const runner = await start(d, "runner", hooks());
		procs.push(runner);
		const read = async () => (await web.call("GET", `/api/snapshot/chat/${info.chats.nestedFork}?limit=200`)).json as { messages: { id: string; role: string; parts: { type: string; text?: string }[] }[] };
		const before = await read();
		const t0 = Date.now();
		expect((await web.call("POST", `/api/sessions/${info.chats.nestedFork}/messages`, { commandId: "after-cutover", text: "what did we say before?" })).status).toBe(202);
		expect(Date.now() - t0).toBeLessThan(2_000);
		const after = await waitFor("the answer to the new message", async () => {
			const s = await read();
			return s.messages.some((m) => m.parts.some((p) => p.text?.includes("now we are on v2"))) ? s : undefined;
		}, 60_000);
		// The imported messages are unchanged and in place; the new ones follow them, with ids above every imported one.
		expect(after.messages.slice(0, before.messages.length).map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
		const tail = after.messages.slice(before.messages.length);
		expect(tail.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(Math.min(...tail.map((m) => Number(m.id)))).toBeGreaterThan(Math.max(...before.messages.map((m) => Number(m.id))));
		expect(tail[0]!.parts[0]!.text).toBe("what did we say before?");

		// The plain chat was cut off mid-tool: its live document held the run of the orphaned http_request. The cutover cleared that run, so a new message runs at once.
		const readPlain = async () => (await web.call("GET", `/api/snapshot/chat/${info.chats.plain}?limit=200`)).json as { messages: { role: string; parts: { text?: string }[] }[] };
		expect((await web.call("POST", `/api/sessions/${info.chats.plain}/messages`, { commandId: "after-cutover-plain", text: "anyone there after the cut?" })).status).toBe(202);
		const plain = await waitFor("the answer in the chat that was cut off mid-tool", async () => {
			const s = await readPlain();
			return s.messages.some((m) => m.role === "assistant" && m.parts.some((p) => p.text === "Noted.")) && s.messages.some((m) => m.parts.some((p) => p.text === "anyone there after the cut?")) ? s : undefined;
		}, 60_000);
		expect(plain.messages.at(-1)!.role).toBe("assistant");

		// A chat in the home partition, which a real space's first chat and its forks share: the relay must not try to make that partition again as a family (a real rehearsal found it did).
		const home = (await d.stack.admin.query("SELECT c.public_id FROM pim_ops.chats c JOIN pim_ops.conversation_directory x ON x.owner_id = c.owner_id AND x.conversation_id = c.conversation_id JOIN pim_ops.partitions p ON p.owner_id = x.owner_id AND p.partition_id = x.partition_id WHERE c.owner_id = $1 AND p.home AND c.deleted_at_ms IS NULL LIMIT 1", [ADA])).rows[0]?.public_id as string | undefined;
		if (home) {
			const chat = chatUuid(home);
			expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "after-cutover-home", text: "anyone home?" })).status).toBe(202);
			await waitFor("the answer in a chat of the home partition", async () => {
				const s = (await web.call("GET", `/api/snapshot/chat/${chat}?limit=200`)).json as { messages: { role: string; parts: { text?: string }[] }[] };
				return s.messages.some((m) => m.parts.some((p) => p.text === "anyone home?")) && s.messages.at(-1)!.role === "assistant" ? s : undefined;
			}, 60_000);
		}
	}, 120_000);

	it("adopts an imported Amp thread in Forge without starting it again, and leaves a cut-off CLI thread idle", async () => {
		const forgeDb = d.stack.admin as unknown as ForgeDb;
		const store = new ForgeStore(forgeDb);
		const scheduler = new ForgeScheduler(forgeDb, store, Date.now);
		const rows = (await d.stack.admin.query("SELECT thread_id, harness, state, orb FROM pim_forge.forge_threads WHERE owner_id = $1 ORDER BY thread_id", [ADA])).rows;
		const amp = rows.find((r) => r.harness === "amp")!;
		const cli = rows.find((r) => r.harness === "claude-code")!;
		expect(amp.state).toBe("running");
		expect(amp.orb.threadId).toBe("T-fixture-amp-0001");
		expect(cli.state).toBe("idle");
		// Amp's cloud is a fake that already holds the thread the legacy deployment started.
		const orb = new FakeOrbClient();
		const remote = await orb.start({ key: "legacy-start", task: "legacy task", repo: "https://git.example.test/ada/app", branch: "pim/thr_amp1" } as never);
		orb.say(remote.threadId, "assistant", "Still working on it.");
		await d.stack.admin.query("UPDATE pim_forge.forge_threads SET orb = jsonb_build_object('threadId', $2::text) WHERE thread_id = $1", [amp.thread_id, remote.threadId]);
		const worker = new ForgeWorker({ store, scheduler, turns: {}, compute: null, orbs: () => orb, objects: new MemoryObjects(), defaultPool: "orbs" });
		await worker.step(amp.thread_id);
		expect(orb.started).toHaveLength(1); // only the legacy start: Forge started nothing
		const events = (await d.stack.admin.query("SELECT data FROM pim_forge.forge_events WHERE thread_id = $1", [amp.thread_id])).rows.map((r) => JSON.stringify(r.data));
		expect(events.join(" ")).toContain("Still working on it.");
	}, 60_000);
});
