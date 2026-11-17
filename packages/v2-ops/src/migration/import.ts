import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { EnvelopeCrypto, type Envelope } from "../crypto/envelope.ts";
import { decodeCredentialsKey, legacyBinding, openLegacyCredential } from "../crypto/legacy.ts";
import { inTransaction } from "../pg/migrate.ts";
import type { ObjectStore } from "./objects.ts";
import { type QuiescencePlan, planQuiescence } from "./quiesce.ts";
import { META_TABLE, SECRET_COLUMNS, SECRET_KV, SECRET_META_KEYS, legacyKey, canonical } from "./secrets.ts";
import { type DoDump, jsonbText, type Row, type SnapshotReader, rowsOf, sha256, isBlob } from "./snapshot.ts";
import { ownerIdOf, partitionUuid } from "./ids.ts";
import { HOME_PARTITION, readPi, splitFamilies } from "./split.ts";

/** The reason the fence procedure gives when it suspends accounts: those accounts are active again after the cutover. */
export const FENCE_SUSPEND_REASON = "cutover fence";
export const DEPLOYMENT_TENANT = "_deployment";

export type ImportOptions = {
	readonly cutoverId: string;
	readonly crypto: EnvelopeCrypto;
	readonly objects: ObjectStore;
	/** The legacy APP_CREDENTIALS_KEY (base64), to open native-app credentials; without it they stay sealed in legacy_sealed only. */
	readonly appCredentialsKey?: string;
	/** WebAuthn rp id of the legacy deployment and of the new one: passkeys only work when the hostname is the same. */
	readonly legacyRpId?: string;
	readonly newRpId?: string;
};

export type ImportSummary = {
	readonly cutoverId: string;
	readonly cutoverAt: number;
	readonly manifestSha256: string;
	readonly tenants: number;
	readonly partitions: Record<string, string[]>;
	readonly normalizedFenceSuspensions: string[];
	readonly quiescence: { operations: number; needsReconciliation: number; dueWork: number; missedOccurrences: number; remoteThreadsAdopted: number; heldTasks: number; resumableTasks: Record<string, number> };
	readonly objects: number;
	readonly warnings: string[];
};

type Column = readonly [name: string, type: string];

/** Bulk insert through jsonb_to_recordset: one round trip per table per tenant, `ON CONFLICT DO NOTHING` so a rerun adds nothing. */
async function bulk(client: PoolClient, table: string, columns: readonly Column[], rows: readonly Record<string, unknown>[]) {
	if (rows.length === 0) return;
	const names = columns.map(([name]) => `"${name}"`).join(", ");
	const typed = columns.map(([name, type]) => `"${name}" ${type}`).join(", ");
	for (let i = 0; i < rows.length; i += 2000) {
		await client.query(`INSERT INTO pim_ops.${table} (${names}) SELECT ${names} FROM jsonb_to_recordset($1::jsonb) AS x(${typed}) ON CONFLICT DO NOTHING`, [jsonbText(JSON.stringify(rows.slice(i, i + 2000)))]);
	}
}

const ownerIdOfKey = (key: string) => {
	try {
		return ownerIdOf(key.split("/")[0]!);
	} catch {
		return null;
	}
};
const parse = (text: unknown) => JSON.parse(String(text));
const num = (cell: unknown) => (cell === null || cell === undefined ? null : Number(cell));

/** Replaces a row's secret columns with references, returning the secrets found: [name, purpose, plaintext, legacy format, legacy ciphertext]. */
function liftSecrets(cls: string, legacyOwner: string, table: string, row: Row, pk: string, key: Buffer | null): { row: Row; secrets: { name: string; purpose: string; plaintext: string; format: string; legacy: string | null }[] } {
	const secrets: { name: string; purpose: string; plaintext: string; format: string; legacy: string | null }[] = [];
	let out: Row = row;
	for (const col of SECRET_COLUMNS[cls] ?? []) {
		if (col.table !== table || typeof row[col.column] !== "string") continue;
		const stored = row[col.column] as string;
		const name = `${cls}.${table}.${col.column}.${pk}`;
		let plaintext = stored;
		let legacy: string | null = null;
		if (col.format === "native-app-sealed" && stored.startsWith("sealed:v1:")) {
			legacy = stored;
			if (!key) {
				// Cannot open: keep only the sealed legacy value (wrapped below), flagged by an empty plaintext.
				plaintext = "";
			} else plaintext = openLegacyCredential(stored, key, legacyBinding(legacyOwner, String(row.id), String(row.app), "credential"));
		}
		secrets.push({ name, purpose: col.purpose, plaintext, format: col.format === "native-app-sealed" && legacy ? "native-app-sealed:v1" : "plain", legacy });
		out = { ...out, [col.column]: { $secret: name } as never };
	}
	if (META_TABLE[cls] === table && SECRET_META_KEYS[cls]?.includes(String(row.key))) {
		const name = `${cls}.${table}.${String(row.key)}`;
		secrets.push({ name, purpose: "meta", plaintext: String(row.value), format: "plain", legacy: null });
		out = { ...out, value: { $secret: name } as never };
	}
	return { row: out, secrets };
}

/**
 * Imports a legacy snapshot into an empty (or partly imported) database and object store. Idempotent: every insert is
 * `ON CONFLICT DO NOTHING`, and a second run over the same snapshot changes nothing. The pi history of each space is split into
 * conversation-family partitions; secrets move under envelope encryption; unsettled effects and due schedules are quarantined
 * by the quiescence plan before any Runner could start. Nothing is executed: the import only writes rows and objects.
 */
export async function importSnapshot(pool: Pool, reader: SnapshotReader, options: ImportOptions): Promise<{ summary: ImportSummary; plan: QuiescencePlan }> {
	const problems = await reader.verifyFiles();
	if (problems.length > 0) throw new Error(`The snapshot does not match its manifest: ${problems.join("; ")}`);
	const manifest = await reader.manifest();
	const identity = await reader.identity();
	const warnings: string[] = [];
	if (options.legacyRpId && options.newRpId && options.legacyRpId !== options.newRpId) warnings.push(`The WebAuthn rp id changes from ${options.legacyRpId} to ${options.newRpId}: every existing passkey stops working, and recovery codes are the only way in.`);
	const credentialsKey = options.appCredentialsKey ? decodeCredentialsKey(options.appCredentialsKey) : null;
	const plan = await planQuiescence(reader, manifest.cutoverAt);

	const client = await pool.connect();
	const partitionsReport: Record<string, string[]> = {};
	const normalized: string[] = [];
	try {
		const existing = await client.query("SELECT source_manifest_sha256, state FROM pim_ops.ops_cutover WHERE cutover_id = $1", [options.cutoverId]);
		const other = await client.query("SELECT cutover_id FROM pim_ops.ops_cutover WHERE cutover_id <> $1 AND state IN ('importing','imported','verified','activated')", [options.cutoverId]);
		if (other.rowCount) throw new Error(`Another cutover (${other.rows[0].cutover_id}) already owns this database; import into an empty one`);
		if (existing.rowCount && existing.rows[0].source_manifest_sha256 !== identity) throw new Error("This cutover id was imported from a different snapshot");
		if (existing.rowCount && ["activated"].includes(existing.rows[0].state)) throw new Error("This cutover is already activated; a re-import would change live data");
		await client.query("INSERT INTO pim_ops.ops_cutover (cutover_id, cutover_at_ms, state, source_manifest_sha256) VALUES ($1,$2,'importing',$3) ON CONFLICT DO NOTHING", [options.cutoverId, manifest.cutoverAt, identity]);

		const secretRows: { owner_id: string; name: string; purpose: string; envelope: Envelope; legacy_format: string; legacy_sealed: string | null }[] = [];
		const addSecrets = (tenant: string, secrets: { name: string; purpose: string; plaintext: string; format: string; legacy: string | null }[]) => {
			for (const s of secrets) secretRows.push({ owner_id: tenant, name: s.name, purpose: s.purpose, envelope: options.crypto.seal(Buffer.from(s.plaintext), [tenant, s.name, s.purpose]), legacy_format: s.format, legacy_sealed: s.legacy });
		};
		const legacyRows: { owner_id: string; source: string; table_name: string; pk: string; row: unknown }[] = [];
		/** Keeps every row of the tables not promoted to typed tables, with secrets lifted out. */
		const keepRows = (cls: string, tenant: string, dump: DoDump, skip: ReadonlySet<string>, legacyOwner = tenant) => {
			for (const [table, dumped] of Object.entries(dump.tables)) {
				if (skip.has(table)) continue;
				const seen = new Set<string>();
				for (const row of dumped.rows) {
					const pk = legacyKey(table, row, seen);
					const lifted = liftSecrets(cls, legacyOwner, table, row, pk, credentialsKey);
					addSecrets(tenant, lifted.secrets);
					legacyRows.push({ owner_id: tenant, source: `${dump.class}:${dump.name}`, table_name: table, pk, row: lifted.row });
				}
			}
			for (const entry of dump.kv) {
				const secret = SECRET_KV.test(entry.key);
				const name = `${cls}.kv.${entry.key}`;
				if (secret) addSecrets(tenant, [{ name, purpose: "kv", plaintext: JSON.stringify(entry.value), format: "plain", legacy: null }]);
				legacyRows.push({ owner_id: tenant, source: `${dump.class}:${dump.name}`, table_name: "$kv", pk: entry.key, row: { key: entry.key, value: secret ? { $secret: name } : entry.value } });
			}
			if (dump.alarm !== null) legacyRows.push({ owner_id: tenant, source: `${dump.class}:${dump.name}`, table_name: "$alarm", pk: "alarm", row: { at: dump.alarm } });
		};

		await inTransaction(client, async () => {
			// Directory and tenants.
			const directory = await reader.dump("Directory", "directory");
			const tenantRows = rowsOf(directory, "accounts").map((a) => {
				const suspendedByFence = a.status === "suspended" && a.status_reason === FENCE_SUSPEND_REASON;
				if (suspendedByFence) normalized.push(ownerIdOf(String(a.owner_id)));
				return { owner_id: ownerIdOf(String(a.owner_id)), username: a.username, role: a.role, status: suspendedByFence ? "active" : a.status, created_at_ms: num(a.created_at), activated_at_ms: num(a.activated_at), status_reason: suspendedByFence ? null : a.status_reason };
			});
			await bulk(client, "owner_map", [["legacy_id", "text"], ["owner_id", "text"]], rowsOf(directory, "accounts").map((a) => ({ legacy_id: a.owner_id, owner_id: ownerIdOf(String(a.owner_id)) })));
			await bulk(client, "tenants", [["owner_id", "text"], ["username", "text"], ["role", "text"], ["status", "text"], ["created_at_ms", "bigint"], ["activated_at_ms", "bigint"], ["status_reason", "text"]], tenantRows);
			await bulk(client, "identities", [["issuer", "text"], ["subject", "text"], ["owner_id", "text"]], rowsOf(directory, "identities").map((r) => ({ issuer: r.issuer, subject: r.subject, owner_id: ownerIdOf(String(r.owner_id)) })));
			keepRows("Directory", DEPLOYMENT_TENANT, directory, new Set(["accounts", "identities"]));

			// Auth, per owner.
			for (const legacy of await reader.names("Auth")) {
				const owner = ownerIdOf(legacy);
				const auth = await reader.dump("Auth", legacy);
				await bulk(client, "passkeys", [["owner_id", "text"], ["id", "text"], ["spki", "text"], ["algorithm", "integer"], ["name", "text"], ["created_at_ms", "bigint"], ["last_used_at_ms", "bigint"]], rowsOf(auth, "auth_passkeys").map((r) => ({ owner_id: owner, id: r.id, spki: r.spki, algorithm: r.algorithm, name: r.name, created_at_ms: r.created_at, last_used_at_ms: r.last_used_at })));
				await bulk(client, "api_tokens", [["owner_id", "text"], ["id", "text"], ["name", "text"], ["hash", "text"], ["created_at_ms", "bigint"], ["last_used_at_ms", "bigint"]], rowsOf(auth, "auth_tokens").map((r) => ({ owner_id: owner, id: r.id, name: r.name, hash: r.hash, created_at_ms: r.created_at, last_used_at_ms: r.last_used_at })));
				await bulk(client, "recovery_codes", [["owner_id", "text"], ["hash", "text"], ["created_at_ms", "bigint"], ["used_at_ms", "bigint"]], rowsOf(auth, "auth_recovery_codes").map((r) => ({ owner_id: owner, hash: r.hash, created_at_ms: r.created_at, used_at_ms: r.used_at })));
				keepRows("Auth", owner, auth, new Set(["auth_passkeys", "auth_tokens", "auth_recovery_codes"]), legacy);
			}

			// Gallery and every other deployment-wide object.
			for (const cls of ["Gallery", "HostOps", "WorkspaceCatalog"]) for (const name of await reader.names(cls)) keepRows(cls, DEPLOYMENT_TENANT, await reader.dump(cls, name), new Set());
			for (const entry of await reader.oauthKv()) legacyRows.push({ owner_id: DEPLOYMENT_TENANT, source: "OAUTH_KV", table_name: "$kv", pk: entry.key, row: entry });
			for (const name of await reader.names("WorkspaceContainer")) keepRows("WorkspaceContainer", DEPLOYMENT_TENANT, await reader.dump("WorkspaceContainer", name), new Set());

			// Spaces.
			for (const legacy of await reader.names("Pim")) {
				const owner = ownerIdOf(legacy);
				const dump = await reader.dump("Pim", legacy);
				const pi = readPi(dump);
				const split = splitFamilies(pi);
				partitionsReport[owner] = split.partitions.map((p) => partitionUuid(owner, p));
				const home = split.partitions.includes(HOME_PARTITION);
				if (!home) warnings.push(`${owner} has no conversation 1: its space has no home partition`);
				await bulk(client, "owner_id_sequence", [["owner_id", "text"], ["next_id", "bigint"]], [{ owner_id: owner, next_id: pi.nextId.toString() }]);
				await bulk(client, "partitions", [["owner_id", "text"], ["partition_id", "uuid"], ["home", "boolean"], ["next_commit_seq", "bigint"]], split.partitions.map((p) => ({ owner_id: owner, partition_id: partitionUuid(owner, p), home: p === HOME_PARTITION, next_commit_seq: (split.maxSeq.get(p) ?? 0) + 1 })));
				const part = (conversation: unknown) => partitionUuid(owner, split.partitionOf.get(Number(conversation))!);
				await bulk(client, "conversation_directory", [["owner_id", "text"], ["conversation_id", "bigint"], ["partition_id", "uuid"]], pi.conversations.map((c) => ({ owner_id: owner, conversation_id: c.id, partition_id: part(c.id) })));
				await bulk(client, "pi_conversations", [["owner_id", "text"], ["id", "bigint"], ["partition_id", "uuid"], ["parent_conversation_id", "bigint"], ["parent_at", "bigint"], ["owner_conversation_id", "bigint"], ["owner_task_id", "bigint"], ["record", "jsonb"]], pi.conversations.map((c) => {
					const record = parse(c.record);
					return { owner_id: owner, id: c.id, partition_id: part(c.id), parent_conversation_id: record.parent?.conversationId ?? null, parent_at: record.parent?.at ?? null, owner_conversation_id: c.owner_conversation_id, owner_task_id: c.owner_task_id, record };
				}));
				await bulk(client, "pi_entries", [["owner_id", "text"], ["id", "bigint"], ["partition_id", "uuid"], ["conversation_id", "bigint"], ["head", "bigint"], ["commit_seq", "bigint"], ["record", "jsonb"]], pi.entries.map((e) => ({ owner_id: owner, id: e.id, partition_id: part(e.conversation_id), conversation_id: e.conversation_id, head: e.head, commit_seq: e.commit_seq, record: parse(e.record) })));
				const held = new Set(plan.taskHolds.filter((h) => h.tenantId === owner).map((h) => h.taskId));
				await bulk(client, "pi_tasks", [["owner_id", "text"], ["id", "bigint"], ["partition_id", "uuid"], ["conversation_id", "bigint"], ["kind", "text"], ["status", "text"], ["abort_requested", "boolean"], ["background", "boolean"], ["hold", "text"], ["record", "jsonb"]], pi.tasks.map((t) => ({ owner_id: owner, id: t.id, partition_id: part(t.conversation_id), conversation_id: t.conversation_id, kind: t.kind, status: t.status, abort_requested: t.abort_requested === 1, background: t.background === 1, hold: held.has(Number(t.id)) ? "needs_reconciliation" : null, record: parse(t.record) })));
				await bulk(client, "pi_submissions", [["owner_id", "text"], ["id", "bigint"], ["partition_id", "uuid"], ["conversation_id", "bigint"], ["request_id", "text"], ["status", "text"], ["record", "jsonb"]], pi.submissions.map((s) => ({ owner_id: owner, id: s.id, partition_id: part(s.conversation_id), conversation_id: s.conversation_id, request_id: s.request_id, status: s.status, record: parse(s.record) })));
				await bulk(client, "pi_documents", [["owner_id", "text"], ["id", "bigint"], ["partition_id", "uuid"], ["kind", "text"], ["family", "integer"], ["key_value", "text"], ["scope_kind", "text"], ["scope_owner_id", "bigint"], ["created_at", "bigint"], ["retired_at", "bigint"], ["record", "jsonb"]], pi.documents.map((d) => ({ owner_id: owner, id: d.id, partition_id: partitionUuid(owner, split.documentPartition.get(Number(d.id))!), kind: d.kind, family: d.family, key_value: d.key_value, scope_kind: d.scope_kind, scope_owner_id: d.owner_id, created_at: d.created_at, retired_at: d.retired_at, record: parse(d.record) })));
				await bulk(client, "pi_document_revisions", [["owner_id", "text"], ["document_id", "bigint"], ["seq", "bigint"], ["kind", "text"], ["version", "integer"], ["content", "jsonb"]], pi.revisions.map((r) => ({ owner_id: owner, document_id: r.document_id, seq: r.seq, kind: r.kind, version: r.version, content: parse(r.content) })));

				// Chats: the public UUID names a pi conversation by its numeric id.
				const sessions = new Map(rowsOf(dump, "pim_sessions").map((s) => [String(s.id), s]));
				const chats = rowsOf(dump, "pim_session_ids").flatMap((link) => {
					const s = sessions.get(String(link.session));
					return s ? [{ owner_id: owner, public_id: link.id, conversation_id: Number(link.session), title: s.title, created_at_ms: s.created_at, updated_at_ms: s.updated_at, deleted_at_ms: s.deleted_at, summary: s.summary, summary_of: s.summary_of }] : [];
				});
				await bulk(client, "chats", [["owner_id", "text"], ["public_id", "text"], ["conversation_id", "bigint"], ["title", "text"], ["created_at_ms", "bigint"], ["updated_at_ms", "bigint"], ["deleted_at_ms", "bigint"], ["summary", "text"], ["summary_of", "text"]], chats);
				const linked = new Set(chats.map((c) => String(c.conversation_id)));
				const piTables = new Set(["pi_durable_metadata", "pi_record_ids", "pi_conversations", "pi_entries", "pi_tasks", "pi_submissions", "pi_documents", "pi_document_revisions", "pim_session_ids"]);
				// pim_sessions rows that became chats are not kept twice.
				const slim: DoDump = { ...dump, tables: { ...dump.tables, pim_sessions: { columns: dump.tables.pim_sessions?.columns ?? [], rows: rowsOf(dump, "pim_sessions").filter((s) => !linked.has(String(s.id))) } } };
				keepRows("Pim", owner, slim, piTables, legacy);
			}

			// Coding scheduler and threads: verbatim, with their pi stores (own id spaces) kept as rows.
			for (const cls of ["CodingScheduler", "CodingThread"]) for (const name of await reader.names(cls)) {
				const dump = await reader.dump(cls, name);
				const legacySpace = cls === "CodingScheduler" ? name : String(rowsOf(dump, "coding_thread")[0]?.space ?? "");
				keepRows(cls, legacySpace ? ownerIdOf(legacySpace) : DEPLOYMENT_TENANT, dump, new Set(), legacySpace || DEPLOYMENT_TENANT);
			}

			await bulk(client, "secret_envelopes", [["owner_id", "text"], ["name", "text"], ["purpose", "text"], ["envelope", "jsonb"], ["legacy_format", "text"], ["legacy_sealed", "text"]], secretRows);
			await bulk(client, "legacy_rows", [["owner_id", "text"], ["source", "text"], ["table_name", "text"], ["pk", "text"], ["row", "jsonb"]], legacyRows);

			// Quarantine.
			await bulk(client, "external_operations", [["id", "text"], ["owner_id", "text"], ["kind", "text"], ["idempotency_key", "text"], ["status", "text"], ["payload", "jsonb"], ["origin", "text"], ["reason", "text"]], plan.operations.map((o) => ({ id: `op_${sha256(`${o.tenantId}|${o.idempotencyKey}`).slice(0, 24)}`, owner_id: o.tenantId, kind: o.kind, idempotency_key: o.idempotencyKey, status: o.status, payload: o.payload, origin: `cutover:${options.cutoverId}`, reason: o.reason })));
			await bulk(client, "due_work", [["owner_id", "text"], ["kind", "text"], ["key", "text"], ["state", "text"], ["next_due_at_ms", "bigint"], ["skip_before_ms", "bigint"], ["missed", "jsonb"], ["spec", "jsonb"]], plan.dueWork.map((d) => ({ owner_id: d.tenantId, kind: d.kind, key: d.key, state: d.state, next_due_at_ms: d.nextDueAtMs, skip_before_ms: manifest.cutoverAt, missed: d.missed, spec: d.spec })));
			await bulk(client, "remote_threads", [["owner_id", "text"], ["thread_id", "text"], ["provider", "text"], ["remote_id", "text"], ["adoption", "text"], ["state", "text"], ["last_event_at_ms", "bigint"], ["started_operation_id", "text"]], plan.remoteThreads.map((r) => ({ owner_id: r.tenantId, thread_id: r.threadId, provider: r.provider, remote_id: r.remoteId, adoption: r.adoption, state: r.state, last_event_at_ms: r.lastEventAtMs, started_operation_id: r.startOperationId })));

			// Objects, with the checksum measured again at the destination.
			const index = await reader.objects();
			const objectRows = [];
			for (const entry of index) {
				const bytes = await reader.object(entry.bucket, entry.key);
				if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.size) throw new Error(`Object ${entry.bucket}/${entry.key} does not match its manifest entry`);
				await options.objects.put(entry.bucket, entry.key, bytes, entry.contentType);
				const written = await options.objects.get(entry.bucket, entry.key);
				if (!written || sha256(written) !== entry.sha256) throw new Error(`Object ${entry.bucket}/${entry.key} changed on the way into the object store`);
				objectRows.push({ bucket: entry.bucket, key: entry.key, owner_id: ownerIdOfKey(entry.key), size_bytes: entry.size, sha256: entry.sha256, content_type: entry.contentType });
			}
			await bulk(client, "objects", [["bucket", "text"], ["key", "text"], ["owner_id", "text"], ["size_bytes", "bigint"], ["sha256", "text"], ["content_type", "text"]], objectRows);
			await client.query("UPDATE pim_ops.ops_cutover SET state = 'imported', updated_at = now() WHERE cutover_id = $1 AND state = 'importing'", [options.cutoverId]);
		});
	} finally {
		client.release();
	}
	const summary: ImportSummary = {
		cutoverId: options.cutoverId,
		cutoverAt: manifest.cutoverAt,
		manifestSha256: identity,
		tenants: Object.keys(partitionsReport).length,
		partitions: partitionsReport,
		normalizedFenceSuspensions: normalized,
		quiescence: {
			operations: plan.operations.length,
			needsReconciliation: plan.operations.filter((o) => o.status === "needs_reconciliation").length,
			dueWork: plan.dueWork.length,
			missedOccurrences: plan.dueWork.reduce((n, d) => n + d.missed.length, 0),
			remoteThreadsAdopted: plan.remoteThreads.filter((r) => r.adoption === "adopt").length,
			heldTasks: plan.taskHolds.length,
			resumableTasks: plan.resumableTasks,
		},
		objects: (await reader.objects()).length,
		warnings,
	};
	void randomUUID;
	void isBlob;
	void canonical;
	return { summary, plan };
}
