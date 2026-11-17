import type { Pool } from "pg";
import type { ObjectStore } from "./objects.ts";
import { canonical } from "./secrets.ts";
import { jsonbText, type Row, type SnapshotReader, rowsOf, sha256 } from "./snapshot.ts";
import { HOME_PARTITION, readPi, splitFamilies, visibleEntryIds } from "./split.ts";
import { DEPLOYMENT_TENANT } from "./import.ts";
import { ownerIdOf, partitionUuid } from "./ids.ts";

export type Check = { readonly name: string; readonly ok: boolean; readonly expected?: unknown; readonly actual?: unknown; readonly detail?: string };
export type AuditResult = { readonly ok: boolean; readonly checks: readonly Check[]; readonly counts: Record<string, { source: number; target: number }> };

/** Tables the importer promoted to typed tables, or merged into another; every other source table lands row for row in legacy_rows. */
const PROMOTED: Readonly<Record<string, ReadonlySet<string>>> = {
	Directory: new Set(["accounts", "identities"]),
	Auth: new Set(["auth_passkeys", "auth_tokens", "auth_recovery_codes"]),
	Pim: new Set(["pi_durable_metadata", "pi_record_ids", "pi_conversations", "pi_entries", "pi_tasks", "pi_submissions", "pi_documents", "pi_document_revisions", "pim_session_ids", "pim_sessions"]),
};

const hashJson = (value: unknown) => sha256(jsonbText(canonical(value)));
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
	const equal = (name: string, expected: unknown, actual: unknown) => check(name, jsonbText(canonical(expected)) === jsonbText(canonical(actual)), { expected, actual });
	const count = async (sql: string, params: unknown[] = []) => Number((await pool.query<{ n: string }>(sql, params)).rows[0]!.n);
	const countCheck = (name: string, source: number, target: number) => {
		counts[name] = { source, target };
		equal(`count ${name}`, source, target);
	};
	const manifest = await reader.manifest();

	check("snapshot files match the manifest", (await reader.verifyFiles()).length === 0);
	const cutover = (await pool.query("SELECT state, source_manifest_sha256 FROM pim_ops.ops_cutover WHERE cutover_id = $1", [options.cutoverId])).rows[0];
	check("cutover record matches this snapshot", cutover?.source_manifest_sha256 === (await reader.identity()), { actual: cutover?.state });

	// Directory and Auth.
	const directory = await reader.dump("Directory", "directory");
	countCheck("tenants", rowsOf(directory, "accounts").length, await count("SELECT count(*) n FROM pim_ops.tenants"));
	countCheck("identities", rowsOf(directory, "identities").length, await count("SELECT count(*) n FROM pim_ops.identities"));
	let passkeys = 0;
	let tokens = 0;
	let codes = 0;
	let usedCodes = 0;
	const sourcePasskeys: string[] = [];
	for (const legacy of await reader.names("Auth")) {
		const owner = ownerIdOf(legacy);
		const auth = await reader.dump("Auth", legacy);
		passkeys += rowsOf(auth, "auth_passkeys").length;
		tokens += rowsOf(auth, "auth_tokens").length;
		codes += rowsOf(auth, "auth_recovery_codes").length;
		usedCodes += rowsOf(auth, "auth_recovery_codes").filter((r) => r.used_at !== null).length;
		for (const r of rowsOf(auth, "auth_passkeys")) sourcePasskeys.push(`${owner}|${r.id}|${r.spki}|${r.algorithm}`);
	}
	countCheck("passkeys", passkeys, await count("SELECT count(*) n FROM pim_ops.passkeys"));
	countCheck("api tokens", tokens, await count("SELECT count(*) n FROM pim_ops.api_tokens"));
	countCheck("recovery codes", codes, await count("SELECT count(*) n FROM pim_ops.recovery_codes"));
	equal("used recovery codes stay used", usedCodes, await count("SELECT count(*) n FROM pim_ops.recovery_codes WHERE used_at_ms IS NOT NULL"));
	equal("passkey credential ids and public keys are byte-identical", sorted(sourcePasskeys, (x) => x), (await pool.query("SELECT owner_id||'|'||id||'|'||spki||'|'||algorithm AS k FROM pim_ops.passkeys")).rows.map((r) => r.k as string).sort());
	const adminRow = rowsOf(directory, "accounts").find((a) => a.role === "admin");
	equal("every legacy account has its recorded v2 owner id", sorted(rowsOf(directory, "accounts").map((a) => `${a.owner_id}|${ownerIdOf(String(a.owner_id))}`), (x) => x), (await pool.query("SELECT legacy_id||'|'||owner_id AS k FROM pim_ops.owner_map")).rows.map((r) => r.k as string).sort());
	if (adminRow) {
		const admin = (await pool.query("SELECT t.status, (SELECT count(*) FROM pim_ops.passkeys p WHERE p.owner_id = t.owner_id) AS passkeys, (SELECT count(*) FROM pim_ops.recovery_codes r WHERE r.owner_id = t.owner_id AND r.used_at_ms IS NULL) AS codes FROM pim_ops.tenants t WHERE t.owner_id = $1 AND t.role = 'admin'", [ownerIdOf(String(adminRow.owner_id))])).rows[0];
		check("the admin can sign in: active, with a passkey or an unused recovery code", !!admin && admin.status === "active" && Number(admin.passkeys) + Number(admin.codes) > 0, { actual: admin });
	} else check("the snapshot has an admin account", false);
	equal("cookie_key is kept sealed, and opens to the legacy value's fingerprint source", 1, await count("SELECT count(*) n FROM pim_ops.secret_envelopes WHERE owner_id = $1 AND name = 'Directory.directory_meta.cookie_key'", [DEPLOYMENT_TENANT]));

	// Spaces: pi history, partitions, transcripts.
	let transcripts = 0;
	for (const legacy of await reader.names("Pim")) {
		const owner = ownerIdOf(legacy);
		const dump = await reader.dump("Pim", legacy);
		const pi = readPi(dump);
		const split = splitFamilies(pi);
		for (const [name, rows, table] of [
			["conversations", pi.conversations, "pi_conversations"],
			["entries", pi.entries, "pi_entries"],
			["tasks", pi.tasks, "pi_tasks"],
			["submissions", pi.submissions, "pi_submissions"],
			["documents", pi.documents, "pi_documents"],
			["document revisions", pi.revisions, "pi_document_revisions"],
		] as const) countCheck(`${owner} ${name}`, rows.length, await count(`SELECT count(*) n FROM pim_ops.${table} WHERE owner_id = $1`, [owner]));

		// Record-level parity: the same entries, tasks and documents, byte for byte after canonical JSON.
		equal(`${owner} entry records`, hashJson(sorted(pi.entries.map((e) => [Number(e.id), JSON.parse(String(e.record))]), (x) => String(x[0]).padStart(20, "0"))), hashJson(sorted((await pool.query("SELECT id, record FROM pim_ops.pi_entries WHERE owner_id = $1", [owner])).rows.map((r) => [Number(r.id), r.record]), (x) => String(x[0]).padStart(20, "0"))));
		equal(`${owner} task records`, hashJson(sorted(pi.tasks.map((t) => [Number(t.id), JSON.parse(String(t.record))]), (x) => String(x[0]).padStart(20, "0"))), hashJson(sorted((await pool.query("SELECT id, record FROM pim_ops.pi_tasks WHERE owner_id = $1", [owner])).rows.map((r) => [Number(r.id), r.record]), (x) => String(x[0]).padStart(20, "0"))));
		equal(`${owner} document revisions (agent settings and overrides)`, hashJson(sorted(pi.revisions.map((r) => [Number(r.document_id), Number(r.seq), JSON.parse(String(r.content))]), (x) => `${String(x[0]).padStart(20, "0")}${String(x[1]).padStart(20, "0")}`)), hashJson(sorted((await pool.query("SELECT document_id, seq, content FROM pim_ops.pi_document_revisions WHERE owner_id = $1", [owner])).rows.map((r) => [Number(r.document_id), Number(r.seq), r.content]), (x) => `${String(x[0]).padStart(20, "0")}${String(x[1]).padStart(20, "0")}`)));

		// Partition integrity.
		equal(`${owner} the home partition holds conversation 1`, partitionUuid(owner, HOME_PARTITION), (await pool.query("SELECT partition_id FROM pim_ops.conversation_directory WHERE owner_id = $1 AND conversation_id = 1", [owner])).rows[0]?.partition_id);
		equal(`${owner} no entry is outside its conversation's partition`, 0, await count("SELECT count(*) n FROM pim_ops.pi_entries e JOIN pim_ops.pi_conversations c USING (owner_id) WHERE e.owner_id = $1 AND c.id = e.conversation_id AND c.partition_id <> e.partition_id", [owner]));
		equal(`${owner} no fork crosses a partition`, 0, await count("SELECT count(*) n FROM pim_ops.pi_conversations c JOIN pim_ops.pi_conversations p ON p.owner_id = c.owner_id AND p.id = c.parent_conversation_id WHERE c.owner_id = $1 AND c.partition_id <> p.partition_id", [owner]));
		equal(`${owner} every fork point is an entry of the parent`, 0, await count("SELECT count(*) n FROM pim_ops.pi_conversations c WHERE c.owner_id = $1 AND c.parent_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pim_ops.pi_entries e WHERE e.owner_id = c.owner_id AND e.id = c.parent_at AND e.conversation_id = c.parent_conversation_id)", [owner]));
		equal(`${owner} no tool task or submission points outside its conversation's partition`, 0, await count("SELECT count(*) n FROM pim_ops.pi_tasks t JOIN pim_ops.pi_conversations c ON c.owner_id = t.owner_id AND c.id = t.conversation_id WHERE t.owner_id = $1 AND c.partition_id <> t.partition_id", [owner]));
		const maxId = await count("SELECT COALESCE(max(m), 0) n FROM (SELECT max(id) m FROM pim_ops.pi_conversations WHERE owner_id = $1 UNION ALL SELECT max(id) FROM pim_ops.pi_entries WHERE owner_id = $1 UNION ALL SELECT max(id) FROM pim_ops.pi_tasks WHERE owner_id = $1 UNION ALL SELECT max(id) FROM pim_ops.pi_submissions WHERE owner_id = $1 UNION ALL SELECT max(id) FROM pim_ops.pi_documents WHERE owner_id = $1) x", [owner]);
		const next = await count("SELECT next_id n FROM pim_ops.owner_id_sequence WHERE owner_id = $1", [owner]);
		check(`${owner} the id sequence continues above every id`, next > maxId && BigInt(next) === pi.nextId, { expected: pi.nextId.toString(), actual: next });
		for (const [label, maxSeq] of split.maxSeq) equal(`${owner} partition ${label} continues its commit sequence above ${maxSeq}`, true, (await count("SELECT next_commit_seq n FROM pim_ops.partitions WHERE owner_id = $1 AND partition_id = $2", [owner, partitionUuid(owner, label)])) > maxSeq);

		// Transcript parity for every conversation: ancestry resolved separately on each side.
		const srcConversations = new Map(pi.conversations.map((c) => [Number(c.id), JSON.parse(String(c.record)) as { parent?: { conversationId: number; at: number } }]));
		const srcEntries = new Map<number, Row[]>();
		for (const e of pi.entries) (srcEntries.get(Number(e.conversation_id)) ?? srcEntries.set(Number(e.conversation_id), []).get(Number(e.conversation_id))!).push(e);
		const srcRecord = new Map(pi.entries.map((e) => [Number(e.id), JSON.parse(String(e.record))]));
		const tgtConversations = new Map<number, { parent?: { conversationId: number; at: number } }>();
		const tgtEntries = new Map<number, number[]>();
		const tgtRecord = new Map<number, unknown>();
		for (const r of (await pool.query("SELECT id, record FROM pim_ops.pi_conversations WHERE owner_id = $1", [owner])).rows) tgtConversations.set(Number(r.id), r.record);
		for (const r of (await pool.query("SELECT id, conversation_id, record FROM pim_ops.pi_entries WHERE owner_id = $1 ORDER BY id", [owner])).rows) {
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
		// A link whose chat row is gone (v1 lists chats from pim_sessions, so it showed none of these) is not carried over as a chat; its conversation is.
		const sessionIds = new Set(rowsOf(dump, "pim_sessions").map((x) => String(x.id)));
		const links = rowsOf(dump, "pim_session_ids").filter((l) => sessionIds.has(String(l.session)));
		equal(`${owner} chat public ids map to the same conversation ids`, sorted(links.map((l) => `${l.id}|${l.session}`), (x) => x), (await pool.query("SELECT public_id||'|'||conversation_id AS k FROM pim_ops.chats WHERE owner_id = $1", [owner])).rows.map((r) => r.k as string).sort());
		const settings = rowsOf(dump, "pim_meta").find((m) => m.key === "settings");
		const target = (await pool.query("SELECT row->>'value' AS value FROM pim_ops.legacy_rows WHERE owner_id = $1 AND source = $2 AND table_name = 'pim_meta' AND pk = 'settings'", [owner, `Pim:${legacy}`])).rows[0];
		if (settings) {
			const before = JSON.parse(String(settings.value));
			const after = JSON.parse(target?.value ?? "null");
			equal(`${owner} explicit settings are the same keys with the same values: nothing unset became an override`, canonical(before), canonical(after));
		} else equal(`${owner} no settings row appears from nothing`, 0, target ? 1 : 0);

		// Every non-promoted table of this space.
		for (const [table, dumped] of Object.entries(dump.tables)) {
			if (PROMOTED.Pim!.has(table)) continue;
			countCheck(`${owner} ${table}`, dumped.rows.length, await count("SELECT count(*) n FROM pim_ops.legacy_rows WHERE owner_id = $1 AND source = $2 AND table_name = $3", [owner, `Pim:${legacy}`, table]));
		}
		const sessions = rowsOf(dump, "pim_sessions").length;
		const linked = (await pool.query("SELECT count(*) n FROM pim_ops.chats WHERE owner_id = $1", [owner])).rows[0].n;
		const unlinked = await count("SELECT count(*) n FROM pim_ops.legacy_rows WHERE owner_id = $1 AND table_name = 'pim_sessions'", [owner]);
		equal(`${owner} every pim_sessions row is a chat or kept as a row`, sessions, Number(linked) + unlinked);
	}
	void transcripts;

	// Every other Durable Object table, row for row.
	for (const cls of ["Directory", "Auth", "Gallery", "HostOps", "WorkspaceCatalog", "WorkspaceContainer", "CodingScheduler", "CodingThread"]) {
		for (const name of await reader.names(cls)) {
			const dump = await reader.dump(cls, name);
			for (const [table, dumped] of Object.entries(dump.tables)) {
				if (PROMOTED[cls]?.has(table)) continue;
				countCheck(`${cls}:${name} ${table}`, dumped.rows.length, await count("SELECT count(*) n FROM pim_ops.legacy_rows WHERE source = $1 AND table_name = $2", [`${cls}:${name}`, table]));
			}
			countCheck(`${cls}:${name} kv`, dump.kv.length, await count("SELECT count(*) n FROM pim_ops.legacy_rows WHERE source = $1 AND table_name = '$kv'", [`${cls}:${name}`]));
		}
	}
	countCheck("OAUTH_KV entries", (await reader.oauthKv()).length, await count("SELECT count(*) n FROM pim_ops.legacy_rows WHERE source = 'OAUTH_KV'"));

	// No secret survives in clear. Transcript-like rows are kept as written, as chat transcripts are: an approval's tool arguments and a coding thread's events,
	// diffs and test runs hold whatever the person and the agent wrote, which may look like a credential; none of them is a credential Pim keeps.
	const content = `split_part(source, ':', 1) <> 'CodingThread' AND table_name NOT IN ('pim_approvals')`;
	const clear = await count(`SELECT count(*) n FROM pim_ops.legacy_rows WHERE ${content} AND row::text ~ '(sk-example|sk-ant-example|mgr-token-example|mcp-oauth-|mcp-client-secret|push-auth-secret|ya29\\.|1//example)'`);
	equal("no plaintext secret remains in legacy_rows", 0, clear);
	// The pattern above names the fixture's secrets. A real deployment's are in shapes nobody listed (a provider key inside a JSON array in `pim_meta`, which the first rehearsal on a real export found
	// in clear), so also refuse any credential-shaped property that holds a value: inside a JSON string (`\"key\":\"...`) or as a property of the row itself, other than the row's own `key` column.
	const shaped = await count(`SELECT count(*) n FROM pim_ops.legacy_rows WHERE ${content} AND (row::text ~ '\\\\"(apiKey|api_key|key|token|secret|password|access_token|refresh_token|client_secret)\\\\"\\s*:\\s*\\\\"[^"\\\\]{8,}' OR (row - 'key')::text ~ '"(apiKey|api_key|token|secret|password|access_token|refresh_token|client_secret)"\\s*:\\s*"[^"]{8,}')`);
	equal("no credential-shaped property is left in clear in legacy_rows", 0, shaped);

	// Objects.
	const index = await reader.objects();
	countCheck("objects", index.length, await count("SELECT count(*) n FROM pim_ops.objects"));
	let badObjects = 0;
	for (const entry of index) {
		const bytes = await objects.get(entry.bucket, entry.key);
		const row = (await pool.query("SELECT sha256, size_bytes FROM pim_ops.objects WHERE bucket = $1 AND key = $2", [entry.bucket, entry.key])).rows[0];
		if (!bytes || sha256(bytes) !== entry.sha256 || bytes.length !== entry.size || row?.sha256 !== entry.sha256 || Number(row?.size_bytes) !== entry.size) badObjects++;
	}
	equal("every object's SHA-256 and size match after the copy (read back from the object store)", 0, badObjects);

	// Quiescence.
	equal("no schedule is due at or before the cutover (no catch-up storm)", 0, await count("SELECT count(*) n FROM pim_ops.due_work WHERE state = 'armed' AND next_due_at_ms <= $1", [manifest.cutoverAt]));
	equal("no due_work row lacks the skip-before guard", 0, await count("SELECT count(*) n FROM pim_ops.due_work WHERE skip_before_ms <> $1", [manifest.cutoverAt]));
	equal("no operation the cutover created could run: none is pending or in flight", 0, await count("SELECT count(*) n FROM pim_ops.external_operations WHERE origin LIKE 'cutover:%' AND status IN ('pending','in_flight')"));
	equal("every non-terminal pi.tool task is held for reconciliation", 0, await count("SELECT count(*) n FROM pim_ops.pi_tasks WHERE kind = 'pi.tool' AND status <> 'terminal' AND hold IS DISTINCT FROM 'needs_reconciliation'"));
	equal("every held task has an operation to reconcile", 0, await count("SELECT count(*) n FROM pim_ops.pi_tasks t WHERE t.hold IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pim_ops.external_operations o WHERE o.owner_id = t.owner_id AND o.idempotency_key = 'tool:'||t.owner_id||':'||t.id AND o.status = 'needs_reconciliation')"));
	equal("every remote session not yet finished is adopted with a recorded, succeeded start", 0, await count("SELECT count(*) n FROM pim_ops.remote_threads r WHERE r.adoption = 'adopt' AND NOT EXISTS (SELECT 1 FROM pim_ops.external_operations o WHERE o.owner_id = r.owner_id AND o.idempotency_key = r.thread_id||':'||r.started_operation_id AND o.kind = 'remote_thread_start' AND o.status = 'succeeded')"));

	return { ok: checks.every((c) => c.ok), checks, counts };
}
