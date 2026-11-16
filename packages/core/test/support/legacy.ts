import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BundleWriter, PI_TABLES } from "../../src/migrate/format.ts";
import { encryptSecretsFile } from "../../src/migrate/secrets-bundle.ts";
import { ctx, scriptedModel, until } from "./harness.ts";

export interface LegacyFixture {
	dir: string;
	exportKey: Buffer;
	tenants: string[];
	token: string;
	recoveryCode: string;
	approvalCall: string;
	blobs: { sha256: string; body: Buffer }[];
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The legacy approval-gated tool: parks the call until the (legacy) approval row says approved. */
export const legacyApproveTool = () =>
	defineExtension({
		name: "legacy",
		tools: [
			defineTool({
				name: "approve",
				description: "Needs approval",
				parameters: Type.Object({ id: Type.String() }),
				replay: "safe",
				execute: async () => ({ control: { suspend: true } }),
			}),
		],
	});

/**
 * Builds an export bundle the way the old system would hold the data: a real pi-durable SQLite storage per person,
 * produced by a real Harness (roots, chats, forks, documents, a tool call suspended for approval), plus the host,
 * auth and directory tables an export runtime would read. The records are pi's own; nothing is hand-shaped.
 */
export async function buildLegacyExport(options: { bigFamilyTurns?: number } = {}): Promise<LegacyFixture> {
	const dir = mkdtempSync(join(tmpdir(), "pim-export-"));
	const writer = new BundleWriter(join(dir, "bundle"));
	const exportKey = randomBytes(32);
	const token = `pim_ada_${randomBytes(12).toString("hex")}`;
	const recoveryCode = "aaaa-bbbb-cccc-dddd";
	const blobs = [Buffer.from("note body one"), randomBytes(2048)].map((body) => ({ sha256: sha(body), body }));
	let approvalCall = "";
	const tenants = ["ada", "bob"];

	for (const tenant of tenants) {
		const m = scriptedModel();
		m.registry.install(legacyApproveTool());
		const file = join(dir, `${tenant}.sqlite`);
		const storage = await openNodeSqliteStorage(file);
		const harness = await Harness.open(storage, m.options(), ctx);
		const root = await harness.root(ctx, { agent: m.agent as never });
		const answer = async (conv: typeof root, text: string, reply: string) => {
			m.faux.appendResponses([fauxAssistantMessage(reply)]);
			await (await conv.submit({ type: "input", content: text }, ctx)).wait(ctx);
		};
		await answer(root, "hello root", "hi there");
		await answer(root, "second", "again");
		const entries = (await root.entries({ order: "ascending" }, 50, undefined, ctx)).items;
		const firstAnswer = entries.find((e) => e.kind === "pi.assistant")!;
		const sessions: { id: number; public: string; title: string }[] = [{ id: root.id, public: "", title: "Home" }];
		const chatA = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: m.agent as never }, ctx);
		await answer(chatA, "chat A question", "chat A answer");
		sessions.push({ id: chatA.id, public: `00000000-0000-4000-8000-${String(chatA.id).padStart(12, "0")}`, title: "Chat A" });
		// Forks: one of the root, one of chat A, and a fork of a fork. Each is a chat of its own, in its parent's family.
		const forkRoot = await root.fork(firstAnswer.id, { ownership: { kind: "ownerless" } }, ctx);
		await answer(forkRoot, "forked question", "forked answer");
		sessions.push({ id: forkRoot.id, public: `00000000-0000-4000-8000-${String(forkRoot.id).padStart(12, "0")}`, title: "Fork of home" });
		const aEntries = (await chatA.entries({ order: "ascending" }, 50, undefined, ctx)).items;
		const forkA = await chatA.fork(aEntries.find((e) => e.kind === "pi.assistant")!.id, { ownership: { kind: "ownerless" } }, ctx);
		const forkFork = await forkA.fork((await forkA.entries({ order: "ascending" }, 50, undefined, ctx)).items.at(-1)!.id, { ownership: { kind: "ownerless" } }, ctx);
		await answer(forkFork, "deep fork", "deep answer");
		sessions.push({ id: forkA.id, public: `00000000-0000-4000-8000-${String(forkA.id).padStart(12, "0")}`, title: "Fork of A" }, { id: forkFork.id, public: `00000000-0000-4000-8000-${String(forkFork.id).padStart(12, "0")}`, title: "Fork of fork" });
		// A separate chat with a tool call parked for approval: the run is suspended, no process holds it.
		let approval: { id: string; conversation: number; call: string } | undefined;
		if (tenant === "ada") {
			const chatB = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: m.agent as never }, ctx);
			m.faux.appendResponses([fauxAssistantMessage(fauxToolCall("approve", { id: "x1" }), { stopReason: "toolUse" })]);
			await chatB.submit({ type: "input", content: "do the thing" }, ctx);
			const parked = await until(async () => (await harness.inspect(ctx)).tasks.find((t) => t.record.kind === "pi.tool" && t.state.kind === "suspended"), "tool task suspended");
			approvalCall = (parked.record.input as { callId: string }).callId;
			approval = { id: "apr-legacy-1", conversation: chatB.id, call: approvalCall };
			sessions.push({ id: chatB.id, public: `00000000-0000-4000-8000-${String(chatB.id).padStart(12, "0")}`, title: "Waiting for approval" });
		}
		for (let i = 0; i < (options.bigFamilyTurns ?? 0) && tenant === "ada"; i++) await answer(root, `bulk ${i}`, `bulk answer ${i}`);
		await harness.close(ctx);
		await storage.close(ctx);

		// Read the storage the way an export runtime would: rows verbatim.
		const db = new DatabaseSync(file, { readOnly: true });
		for (const table of PI_TABLES) await writer.ndjson(`tenants/${tenant}/pi/${table}.ndjson`, (db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]).map((r) => ({ ...r })));
		const meta = db.prepare("SELECT next_id, next_seq FROM durable_metadata").get() as { next_id: string; next_seq: number };
		writer.json(`tenants/${tenant}/pi/metadata.json`, { next_id: String(meta.next_id), next_seq: Number(meta.next_seq) });
		db.close();
		writer.tenants.add(tenant);
		await writer.ndjson(`tenants/${tenant}/host/pim_sessions.ndjson`, sessions.map((s) => ({ id: String(s.id), title: s.title, created_at: 1_700_000_000_000, updated_at: 1_700_000_100_000, deleted_at: null, summary: null, summary_of: null })));
		await writer.ndjson(`tenants/${tenant}/host/pim_session_ids.ndjson`, sessions.filter((s) => s.public).map((s) => ({ id: s.public, session: String(s.id) })));
		await writer.ndjson(`tenants/${tenant}/host/pim_approvals.ndjson`, approval ? [{ id: approval.id, session: String(approval.conversation), action: "approve", args: "{}", summary: "do x1", status: "pending", created_at: 1_700_000_050_000, call_id: approval.call, tool: "approve" }] : []);
		await writer.ndjson(`tenants/${tenant}/host/pim_goals.ndjson`, [{ id: `goal-${tenant}`, title: "Run a 5k", status: "open", steps: "[]", notes: "", session: "1", created_at: 1, updated_at: 2 }]);
		await writer.ndjson(`tenants/${tenant}/host/pim_meta.ndjson`, [{ key: "schedule:morning", value: JSON.stringify({ cron: "0 8 * * *", missed: "catch-up" }) }]);
		await writer.ndjson(`tenants/${tenant}/auth/auth_passkeys.ndjson`, tenant === "ada" ? [{ id: "cred-ada-1", spki: randomBytes(65).toString("base64url"), algorithm: -7, name: "laptop", created_at: 1_700_000_000_000, last_used_at: 1_700_000_900_000 }] : []);
		await writer.ndjson(`tenants/${tenant}/auth/auth_tokens.ndjson`, tenant === "ada" ? [{ id: "tok1", name: "cli", hash: sha(token), created_at: 1_700_000_000_000, last_used_at: null }] : []);
		await writer.ndjson(`tenants/${tenant}/auth/auth_recovery_codes.ndjson`, tenant === "ada" ? [{ hash: sha(recoveryCode), created_at: 1_700_000_000_000, used_at: null }] : []);
		if (tenant === "ada") writer.json(`tenants/${tenant}/secrets.json`, encryptSecretsFile([{ id: "provider:openai", purpose: "model-provider", value: "sk-legacy-plaintext-value" }, { id: "gmail", purpose: "connector", value: "gmail-oauth-token" }], exportKey, tenant));
	}
	await writer.ndjson("directory/accounts.ndjson", [
		{ owner_id: "ada", username: "ada", role: "admin", status: "active", created_at: 1_700_000_000_000 },
		{ owner_id: "bob", username: "bob", role: "member", status: "active", created_at: 1_700_000_000_000 },
	]);
	await writer.ndjson("blobs/index.ndjson", blobs.map((b, i) => ({ tenant: "ada", legacy_key: `file-${i}`, sha256: b.sha256, size: b.body.length, content_type: "application/octet-stream" })));
	for (const b of blobs) writer.blob(b.sha256, b.body);
	await writer.ndjson("external/handles.ndjson", [
		{ tenant: "ada", kind: "coding.thread", id: "ct-live", state: "running", harness: "claude-code", handle: { remote: "sess-123" }, lastEventAt: 1_700_000_800_000 },
		{ tenant: "ada", kind: "coding.thread", id: "ct-old", state: "done", harness: "codex", handle: { remote: "sess-9" } },
	]);
	writer.finish({ system: "pim-legacy-fixture", fence: { maintenance: true } });
	writeFileSync(join(dir, "token.txt"), "x");
	return { dir: join(dir, "bundle"), exportKey, tenants, token, recoveryCode, approvalCall, blobs };
}
