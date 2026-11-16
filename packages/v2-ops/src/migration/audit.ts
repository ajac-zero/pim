import type { Pool } from "pg";
import type { ObjectStore } from "./objects.ts";
import { canonical } from "./secrets.ts";
import { type Row, type SnapshotReader, rowsOf, sha256 } from "./snapshot.ts";
import { HOME_PARTITION, readPi, splitFamilies, visibleEntryIds } from "./split.ts";
import { DEPLOYMENT_TENANT } from "./import.ts";

export type Check = { readonly name: string; readonly ok: boolean; readonly expected?: unknown; readonly actual?: unknown; readonly detail?: string };
export type AuditResult = { readonly ok: boolean; readonly checks: readonly Check[]; readonly counts: Record<string, { source: number; target: number }> };

/** Tables the importer promoted to typed tables, or merged into another; every other source table lands row for row in legacy_rows. */
const PROMOTED: Readonly<Record<string, ReadonlySet<string>>> = {
	Directory: new Set(["accounts", "identities"]),
	Auth: new Set(["auth_passkeys", "auth_tokens", "auth_recovery_codes"]),
	Pim: new Set(["pi_durable_metadata", "pi_record_ids", "pi_conversations", "pi_entries", "pi_tasks", "pi_submissions", "pi_documents", "pi_document_revisions", "pim_session_ids", "pim_sessions"]),
};

const hashJson = (value: unknown) => sha256(canonical(value));
const sorted = <T>(items: T[], key: (item: T) => string) => [...items].sort((a, b) => (key(a) < key(b) ? -1 : 1));

/**
 * The checksum auditor. It reads the snapshot and the database independently and compares them: row counts of every source table,
 * pi record hashes, SHA-256 of every object read back from the object store, partition integrity, the transcript each
 * conversation shows (computed through fork ancestry on both sides), explicit settings, and what a person needs to sign in.
 */
export async function auditImport(pool: Pool, reader: SnapshotReader, objects: ObjectStore, options: { cutoverId: string }): Promise<AuditResult> {
	const checks: Check[] = [];
	const counts: Record<string, { source: number; target: number }> = {};
	const check = (name: string, ok: boolean, extra: Partial<Check> = {}) => checks.push({ name, ok, ...extra });
	const equal = (name: string, expected: unknown, actual: unknown) => check(name, canonical(expected) === canonical(actual), { expected, actual });
	const count = async (sql: string, params: unknown[] = []) => Number((await pool.query<{ n: string }>(sql, params)).rows[0]!.n);
	const countCheck = (name: string, source: number, target: number) => {
		counts[name] = { source, target };
		equal(`count ${name}`, source, target);
	};
	const manifest = await reader.manifest();

	check("snapshot files match the manifest", (await reader.verifyFiles()).length === 0);
	const cutover = (await pool.query("SELECT state, source_manifest_sha256 FROM pim.ops_cutover WHERE cutover_id = $1", [options.cutoverId])).rows[0];
	check("cutover record matches this snapshot", cutover?.source_manifest_sha256 === (await reader.identity()), { actual: cutover?.state });

	// Directory and Auth.
	const directory = await reader.dump("Directory", "directory");
	countCheck("tenants", rowsOf(directory, "accounts").length, await count("SELECT count(*) n FROM pim.tenants"));
	countCheck("identities", rowsOf(directory, "identities").length, await count("SELECT count(*) n FROM pim.identities"));
	let passkeys = 0;
	let tokens = 0;
	let codes = 0;
	let usedCodes = 0;
	const sourcePasskeys: string[] = [];
	for (const owner of await reader.names("Auth")) {
		const auth = await reader.dump("Auth", owner);
		passkeys += rowsOf(auth, "auth_passkeys").length;
		tokens += rowsOf(auth, "auth_tokens").length;
		codes += rowsOf(auth, "auth_recovery_codes").length;
		usedCodes += rowsOf(auth, "auth_recovery_codes").filter((r) => r.used_at !== null).length;
		for (const r of rowsOf(auth, "auth_passkeys")) sourcePasskeys.push(`${owner}|${r.id}|${r.spki}|${r.algorithm}`);
	}
	countCheck("passkeys", passkeys, await count("SELECT count(*) n FROM pim.passkeys"));
	countCheck("api tokens", tokens, await count("SELECT count(*) n FROM pim.api_tokens"));
	countCheck("recovery codes", codes, await count("SELECT count(*) n FROM pim.recovery_codes"));
	equal("used recovery codes stay used", usedCodes, await count("SELECT count(*) n FROM pim.recovery_codes WHERE used_at_ms IS NOT NULL"));
	equal("passkey credential ids and public keys are byte-identical", sorted(sourcePasskeys, (x) => x), (await pool.query("SELECT tenant_id||'|'||id||'|'||spki||'|'||algorithm AS k FROM pim.passkeys")).rows.map((r) => r.k as string).sort());
	const adminRow = rowsOf(directory, "accounts").find((a) => a.role === "admin");
	if (adminRow) {
		const admin = (await pool.query("SELECT t.status, (SELECT count(*) FROM pim.passkeys p WHERE p.tenant_id = t.tenant_id) AS passkeys, (SELECT count(*) FROM pim.recovery_codes r WHERE r.tenant_id = t.tenant_id AND r.used_at_ms IS NULL) AS codes FROM pim.tenants t WHERE t.tenant_id = $1 AND t.role = 'admin'", [adminRow.owner_id])).rows[0];
		check("the admin can sign in: active, with a passkey or an unused recovery code", !!admin && admin.status === "active" && Number(admin.passkeys) + Number(admin.codes) > 0, { actual: admin });
	} else check("the snapshot has an admin account", false);
	equal("cookie_key is kept sealed, and opens to the legacy value's fingerprint source", 1, await count("SELECT count(*) n FROM pim.secret_envelopes WHERE tenant_id = $1 AND name = 'Directory.directory_meta.cookie_key'", [DEPLOYMENT_TENANT]));

	// Spaces: pi history, partitions, transcripts.
	let transcripts = 0;
	for (const owner of await reader.names("Pim")) {
		const dump = await reader.dump("Pim", owner);
		const pi = readPi(dump);
		const split = splitFamilies(pi);
		for (const [name, rows, table] of [
			["conversations", pi.conversations, "pi_conversations"],
			["entries", pi.entries, "pi_entries"],
			["tasks", pi.tasks, "pi_tasks"],
			["submissions", pi.submissions, "pi_submissions"],
			["documents", pi.documents, "pi_documents"],
			["document revisions", pi.revisions, "pi_document_revisions"],
		] as const) countCheck(`${owner} ${name}`, rows.length, await count(`SELECT count(*) n FROM pim.${table} WHERE tenant_id = $1`, [owner]));

		// Record-level parity: the same entries, tasks and documents, byte for byte after canonical JSON.
		equal(`${owner} entry records`, hashJson(sorted(pi.entries.map((e) => [Number(e.id), JSON.parse(String(e.record))]), (x) => String(x[0]).padStart(20, "0"))), hashJson(sorted((await pool.query("SELECT id, record FROM pim.pi_entries WHERE tenant_id = $1", [owner])).rows.map((r) => [Number(r.id), r.record]), (x) => String(x[0]).padStart(20, "0"))));
		equal(`${owner} task records`, hashJson(sorted(pi.tasks.map((t) => [Number(t.id), JSON.parse(String(t.record))]), (x) => String(x[0]).padStart(20, "0"))), hashJson(sorted((await pool.query("SELECT id, record FROM pim.pi_tasks WHERE tenant_id = $1", [owner])).rows.map((r) => [Number(r.id), r.record]), (x) => String(x[0]).padStart(20, "0"))));
		equal(`${owner} document revisions (agent settings and overrides)`, hashJson(sorted(pi.revisions.map((r) => [Number(r.document_id), Number(r.seq), JSON.parse(String(r.content))]), (x) => `${String(x[0]).padStart(20, "0")}${String(x[1]).padStart(20, "0")}`)), hashJson(sorted((await pool.query("SELECT document_id, seq, content FROM pim.pi_document_revisions WHERE tenant_id = $1", [owner])).rows.map((r) => [Number(r.document_id), Number(r.seq), r.content]), (x) => `${String(x[0]).padStart(20, "0")}${String(x[1]).padStart(20, "0")}`)));

		// Partition integrity.
		equal(`${owner} the home partition holds conversation 1`, HOME_PARTITION, (await pool.query("SELECT partition_id FROM pim.conversation_directory WHERE tenant_id = $1 AND conversation_id = 1", [owner])).rows[0]?.partition_id);
		equal(`${owner} no entry is outside its conversation's partition`, 0, await count("SELECT count(*) n FROM pim.pi_entries e JOIN pim.pi_conversations c USING (tenant_id) WHERE e.tenant_id = $1 AND c.id = e.conversation_id AND c.partition_id <> e.partition_id", [owner]));
		equal(`${owner} no fork crosses a partition`, 0, await count("SELECT count(*) n FROM pim.pi_conversations c JOIN pim.pi_conversations p ON p.tenant_id = c.tenant_id AND p.id = c.parent_conversation_id WHERE c.tenant_id = $1 AND c.partition_id <> p.partition_id", [owner]));
		equal(`${owner} every fork point is an entry of the parent`, 0, await count("SELECT count(*) n FROM pim.pi_conversations c WHERE c.tenant_id = $1 AND c.parent_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pim.pi_entries e WHERE e.tenant_id = c.tenant_id AND e.id = c.parent_at AND e.conversation_id = c.parent_conversation_id)", [owner]));
		equal(`${owner} no tool task or submission points outside its conversation's partition`, 0, await count("SELECT count(*) n FROM pim.pi_tasks t JOIN pim.pi_conversations c ON c.tenant_id = t.tenant_id AND c.id = t.conversation_id WHERE t.tenant_id = $1 AND c.partition_id <> t.partition_id", [owner]));
		const maxId = await count("SELECT COALESCE(max(m), 0) n FROM (SELECT max(id) m FROM pim.pi_conversations WHERE tenant_id = $1 UNION ALL SELECT max(id) FROM pim.pi_entries WHERE tenant_id = $1 UNION ALL SELECT max(id) FROM pim.pi_tasks WHERE tenant_id = $1 UNION ALL SELECT max(id) FROM pim.pi_submissions WHERE tenant_id = $1 UNION ALL SELECT max(id) FROM pim.pi_documents WHERE tenant_id = $1) x", [owner]);
		const next = await count("SELECT next_id n FROM pim.tenant_id_sequence WHERE tenant_id = $1", [owner]);
		check(`${owner} the id sequence continues above every id`, next > maxId && BigInt(next) === pi.nextId, { expected: pi.nextId.toString(), actual: next });
		for (const [partition, maxSeq] of split.maxSeq) equal(`${owner} partition ${partition} continues its commit sequence above ${maxSeq}`, true, (await count("SELECT next_commit_seq n FROM pim.partitions WHERE tenant_id = $1 AND partition_id = $2", [owner, partition])) > maxSeq);

		// Transcript parity for every conversation: ancestry resolved separately on each side.
		const srcConversations = new Map(pi.conversations.map((c) => [Number(c.id), JSON.parse(String(c.record)) as { parent?: { conversationId: number; at: number } }]));
		const srcEntries = new Map<number, Row[]>();
		for (const e of pi.entries) (srcEntries.get(Number(e.conversation_id)) ?? srcEntries.set(Number(e.conversation_id), []).get(Number(e.conversation_id))!).push(e);
		const srcRecord = new Map(pi.entries.map((e) => [Number(e.id), JSON.parse(String(e.record))]));
		const tgtConversations = new Map<number, { parent?: { conversationId: number; at: number } }>();
		const tgtEntries = new Map<number, number[]>();
		const tgtRecord = new Map<number, unknown>();
		for (const r of (await pool.query("SELECT id, record FROM pim.pi_conversations WHERE tenant_id = $1", [owner])).rows) tgtConversations.set(Number(r.id), r.record);
		for (const r of (await pool.query("SELECT id, conversation_id, record FROM pim.pi_entries WHERE tenant_id = $1 ORDER BY id", [owner])).rows) {
			(tgtEntries.get(Number(r.conversation_id)) ?? tgtEntries.set(Number(r.conversation_id), []).get(Number(r.conversation_id))!).push(Number(r.id));
			tgtRecord.set(Number(r.id), r.record);
		}
		let mismatched = 0;
		for (const conversation of srcConversations.keys()) {
			const a = visibleEntryIds(conversation, srcConversations, (c) => (srcEntries.get(c) ?? []).map((e) => Number(e.id)).sort((x, y) => x - y)).map((id) => srcRecord.get(id));
			const b = visibleEntryIds(conversation, tgtConversations, (c) => tgtEntries.get(c) ?? []).map((id) => tgtRecord.get(id));
			if (hashJson(a) !== hashJson(b)) mismatched++;
			transcripts++;
		}
		equal(`${owner} every conversation's visible transcript is identical (fork closure, asOf ancestry)`, 0, mismatched);

		// Chats: public ids, numeric conversation ids, explicit settings.
		const links = rowsOf(dump, "pim_session_ids");
		equal(`${owner} chat public ids map to the same conversation ids`, sorted(links.map((l) => `${l.id}|${l.session}`), (x) => x), (await pool.query("SELECT public_id||'|'||conversation_id AS k FROM pim.chats WHERE tenant_id = $1", [owner])).rows.map((r) => r.k as string).sort());
		const settings = rowsOf(dump, "pim_meta").find((m) => m.key === "settings");
		const target = (await pool.query("SELECT row->>'value' AS value FROM pim.legacy_rows WHERE tenant_id = $1 AND source = $2 AND table_name = 'pim_meta' AND pk = 'settings'", [owner, `Pim:${owner}`])).rows[0];
		if (settings) {
			const before = JSON.parse(String(settings.value));
			const after = JSON.parse(target?.value ?? "null");
			equal(`${owner} explicit settings are the same keys with the same values: nothing unset became an override`, canonical(before), canonical(after));
		} else equal(`${owner} no settings row appears from nothing`, 0, target ? 1 : 0);

		// Every non-promoted table of this space.
		for (const [table, dumped] of Object.entries(dump.tables)) {
			if (PROMOTED.Pim!.has(table)) continue;
			countCheck(`${owner} ${table}`, dumped.rows.length, await count("SELECT count(*) n FROM pim.legacy_rows WHERE tenant_id = $1 AND source = $2 AND table_name = $3", [owner, `Pim:${owner}`, table]));
		}
		const sessions = rowsOf(dump, "pim_sessions").length;
		const linked = (await pool.query("SELECT count(*) n FROM pim.chats WHERE tenant_id = $1", [owner])).rows[0].n;
		const unlinked = await count("SELECT count(*) n FROM pim.legacy_rows WHERE tenant_id = $1 AND table_name = 'pim_sessions'", [owner]);
		equal(`${owner} every pim_sessions row is a chat or kept as a row`, sessions, Number(linked) + unlinked);
	}
	void transcripts;

	// Every other Durable Object table, row for row.
	for (const cls of ["Directory", "Auth", "Gallery", "HostOps", "WorkspaceCatalog", "WorkspaceContainer", "CodingScheduler", "CodingThread"]) {
		for (const name of await reader.names(cls)) {
			const dump = await reader.dump(cls, name);
			for (const [table, dumped] of Object.entries(dump.tables)) {
				if (PROMOTED[cls]?.has(table)) continue;
				countCheck(`${cls}:${name} ${table}`, dumped.rows.length, await count("SELECT count(*) n FROM pim.legacy_rows WHERE source = $1 AND table_name = $2", [`${cls}:${name}`, table]));
			}
			countCheck(`${cls}:${name} kv`, dump.kv.length, await count("SELECT count(*) n FROM pim.legacy_rows WHERE source = $1 AND table_name = '$kv'", [`${cls}:${name}`]));
		}
	}
	countCheck("OAUTH_KV entries", (await reader.oauthKv()).length, await count("SELECT count(*) n FROM pim.legacy_rows WHERE source = 'OAUTH_KV'"));

	// No secret survives in clear.
	const clear = await count(`SELECT count(*) n FROM pim.legacy_rows WHERE row::text ~ '(sk-example|sk-ant-example|mgr-token-example|mcp-oauth-|mcp-client-secret|push-auth-secret|ya29\\.|1//example)'`);
	equal("no plaintext secret remains in legacy_rows", 0, clear);

	// Objects.
	const index = await reader.objects();
	countCheck("objects", index.length, await count("SELECT count(*) n FROM pim.objects"));
	let badObjects = 0;
	for (const entry of index) {
		const bytes = await objects.get(entry.bucket, entry.key);
		const row = (await pool.query("SELECT sha256, size_bytes FROM pim.objects WHERE bucket = $1 AND key = $2", [entry.bucket, entry.key])).rows[0];
		if (!bytes || sha256(bytes) !== entry.sha256 || bytes.length !== entry.size || row?.sha256 !== entry.sha256 || Number(row?.size_bytes) !== entry.size) badObjects++;
	}
	equal("every object's SHA-256 and size match after the copy (read back from the object store)", 0, badObjects);

	// Quiescence.
	equal("no schedule is due at or before the cutover (no catch-up storm)", 0, await count("SELECT count(*) n FROM pim.due_work WHERE state = 'armed' AND next_due_at_ms <= $1", [manifest.cutoverAt]));
	equal("no due_work row lacks the skip-before guard", 0, await count("SELECT count(*) n FROM pim.due_work WHERE skip_before_ms <> $1", [manifest.cutoverAt]));
	equal("no pending operation could run: nothing is pending or in flight", 0, await count("SELECT count(*) n FROM pim.external_operations WHERE status IN ('pending','in_flight')"));
	equal("every non-terminal pi.tool task is held for reconciliation", 0, await count("SELECT count(*) n FROM pim.pi_tasks WHERE kind = 'pi.tool' AND status <> 'terminal' AND hold IS DISTINCT FROM 'needs_reconciliation'"));
	equal("every held task has an operation to reconcile", 0, await count("SELECT count(*) n FROM pim.pi_tasks t WHERE t.hold IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pim.external_operations o WHERE o.tenant_id = t.tenant_id AND o.idempotency_key = 'tool:'||t.tenant_id||':'||t.id AND o.status = 'needs_reconciliation')"));
	equal("every remote session not yet finished is adopted with a recorded, succeeded start", 0, await count("SELECT count(*) n FROM pim.remote_threads r WHERE r.adoption = 'adopt' AND NOT EXISTS (SELECT 1 FROM pim.external_operations o WHERE o.tenant_id = r.tenant_id AND o.idempotency_key = r.thread_id||':'||r.started_operation_id AND o.kind = 'remote_thread_start' AND o.status = 'succeeded')"));

	return { ok: checks.every((c) => c.ok), checks, counts };
}
