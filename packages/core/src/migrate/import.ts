import { createHash } from "node:crypto";
import type pg from "pg";
import { type Q, withTenant } from "../db.ts";
import { KeyRing, putSecret } from "../secrets.ts";
import type { BlobStore } from "./blobs.ts";
import { BundleReader, PI_TABLES, isLiveHandle, rowDigest } from "./format.ts";
import { type TenantPlan, planTenant } from "./plan.ts";
import { decryptSecretsFile } from "./secrets-bundle.ts";

type Col = { name: string; type: string };

/** One multi-row insert per chunk, through unnest: a few statements per thousand rows, not one per row. */
async function insertMany(q: Q, table: string, cols: Col[], rows: unknown[][], suffix = "", chunk = 1000): Promise<void> {
	for (let i = 0; i < rows.length; i += chunk) {
		const part = rows.slice(i, i + chunk);
		const arrays = cols.map((_, c) => part.map((row) => row[c] ?? null));
		await q.run(`INSERT INTO ${table} (${cols.map((c) => c.name).join(", ")}) SELECT * FROM unnest(${cols.map((c, n) => `$${n + 1}::${c.type}[]`).join(", ")}) ${suffix}`, ...arrays);
	}
}

export interface ImportOptions {
	/** The maintenance pool: it writes every table under each tenant's context. */
	pool: pg.Pool;
	blobs?: BlobStore;
	keyRing?: KeyRing;
	/** The export key file's contents, for `secrets.json`. Never an argument. */
	exportKey?: Buffer;
	importId: string;
	log?: (message: string) => void;
}

export interface TenantReport {
	tenantId: string;
	status: "imported" | "skipped" | "refused";
	families: number;
	rows: Record<string, number>;
	violations: string[];
	remapped: { kind: string; from: string; to: string }[];
	unresolved: { kind: string; ref: string; reason: string }[];
	checksum: string;
}

const hash8 = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);
export const partitionIdFor = (tenantId: string, family: { key: number; home: boolean }) => (family.home ? `home-${hash8(tenantId)}-${tenantId}`.slice(0, 64) : `f${family.key}-${hash8(tenantId)}`);

const ACCOUNT_STATUS: Record<string, "active" | "suspended" | "deleting"> = { active: "active", suspended: "suspended", pending: "suspended", deleting: "deleting", erased: "deleting" };

/**
 * Imports every tenant of a bundle into an empty target, one transaction per tenant, idempotently.
 * Nothing runs: every family is imported quiescent (no owner, no due time), so no model call, schedule, trigger or tool
 * starts at import. `activateTenant` is the explicit, later step that lets owners claim them.
 */
export async function importBundle(bundle: BundleReader, options: ImportOptions): Promise<TenantReport[]> {
	const problems = await bundle.checkIntegrity();
	if (problems.length > 0) throw new Error(`The bundle failed its integrity check: ${problems.slice(0, 5).join("; ")}`);
	const reports: TenantReport[] = [];
	for (const tenantId of bundle.manifest.tenants) reports.push(await importTenant(bundle, tenantId, options));
	return reports;
}

export async function importTenant(bundle: BundleReader, tenantId: string, options: ImportOptions): Promise<TenantReport> {
	const plan = await planTenant(bundle, tenantId);
	const base = `tenants/${tenantId}`;
	const checksum = bundle.manifest.files[`${base}/pi/entries.ndjson`]?.sha256 ?? "none";
	const report: TenantReport = { tenantId, status: "refused", families: plan.families.length, rows: { ...plan.counts }, violations: plan.violations, remapped: [], unresolved: [], checksum };
	if (plan.violations.length > 0) return report;

	const prior = await withTenant(options.pool, tenantId, (q) => q.get<{ checksum: string }>("SELECT checksum FROM app.import_ledger WHERE tenant_id = $1 AND unit = 'tenant'", tenantId), { readOnly: true });
	if (prior) {
		if (prior.checksum !== checksum) throw new Error(`Tenant ${tenantId} was imported from a different bundle`);
		return { ...report, status: "skipped" };
	}
	const existing = await withTenant(options.pool, tenantId, (q) => q.get("SELECT 1 FROM app.tenants WHERE tenant_id = $1", tenantId), { readOnly: true });
	if (existing) throw new Error(`Tenant ${tenantId} exists in the target without an import record: the target is not empty`);

	const metadata = bundle.json<{ next_id: string; next_seq: number }>(`${base}/pi/metadata.json`) ?? { next_id: "2", next_seq: 1 };
	const account = (await bundle.all<Record<string, any>>("directory/accounts.ndjson")).find((a) => a.owner_id === tenantId);
	const partitionOf = (conversationId: number) => partitionIdFor(tenantId, plan.families[plan.familyOf.get(conversationId)!]!);
	const homeFamily = plan.families.find((f) => f.home)!;
	const homePartition = partitionIdFor(tenantId, homeFamily);
	// Tool task ids by (conversation, call id), to attach pending approvals to the task they suspend.
	const toolTask = new Map<string, { id: number; status: string }>();

	await withTenant(
		options.pool,
		tenantId,
		async (q) => {
			const status = ACCOUNT_STATUS[String(account?.status ?? "active")] ?? "suspended";
			await q.run("INSERT INTO app.tenants (tenant_id, status) VALUES ($1, $2)", tenantId, status === "active" ? "active" : status === "deleting" ? "deleting" : "suspended");
			// The id sequence continues past every imported id: ids are tenant-wide and unchanged, so no new id can collide with an old one.
			const nextId = Math.max(Number(metadata.next_id), plan.maxId + 1);
			if (!Number.isSafeInteger(nextId)) throw new Error("The imported ids leave no safe integer for new ones");
			await q.run("INSERT INTO rt.tenant_ids (tenant_id, next_id) VALUES ($1, $2)", tenantId, nextId);
			const nextSeq = Math.max(metadata.next_seq, plan.maxSeq + 1);
			for (const family of plan.families) {
				const id = partitionIdFor(tenantId, family);
				await q.run("INSERT INTO rt.partitions (partition_id, tenant_id, home, next_seq) VALUES ($1, $2, $3, $4)", id, tenantId, family.home, nextSeq);
				// Quiescent and never due: nothing starts until activateTenant.
				await q.run("INSERT INTO app.activation (partition_id, tenant_id, state, due_at) VALUES ($1, $2, 'quiescent', 'infinity')", id, tenantId);
			}
			const claims: unknown[][] = [];
			const claim = (id: number, partition: string, type: string) => claims.push([tenantId, id, partition, type]);

			const conversations = await bundle.all<any>(`${base}/pi/conversations.ndjson`);
			for (const c of conversations) claim(c.id, partitionOf(c.id), "conversation");
			await insertMany(q, "rt.conversations", [{ name: "tenant_id", type: "text" }, { name: "partition_id", type: "text" }, { name: "id", type: "bigint" }, { name: "owner_conversation_id", type: "bigint" }, { name: "owner_task_id", type: "bigint" }, { name: "record", type: "text" }], conversations.map((c) => [tenantId, partitionOf(c.id), c.id, c.owner_conversation_id, c.owner_task_id, c.record]));
			await insertMany(q, "rt.conversation_directory", [{ name: "tenant_id", type: "text" }, { name: "conversation_id", type: "bigint" }, { name: "partition_id", type: "text" }], conversations.map((c) => [tenantId, c.id, partitionOf(c.id)]));

			const entries: unknown[][] = [];
			const flushEntries = async () => {
				await insertMany(q, "rt.entries", [{ name: "tenant_id", type: "text" }, { name: "partition_id", type: "text" }, { name: "id", type: "bigint" }, { name: "conversation_id", type: "bigint" }, { name: "head", type: "bigint" }, { name: "commit_seq", type: "bigint" }, { name: "record", type: "text" }], entries);
				entries.length = 0;
			};
			for await (const e of bundle.ndjson<any>(`${base}/pi/entries.ndjson`)) {
				claim(e.id, partitionOf(e.conversation_id), "entry");
				entries.push([tenantId, partitionOf(e.conversation_id), e.id, e.conversation_id, e.head, e.commit_seq, e.record]);
				if (entries.length >= 2000) await flushEntries();
			}
			await flushEntries();

			const tasks = await bundle.all<any>(`${base}/pi/tasks.ndjson`);
			for (const t of tasks) {
				claim(t.id, partitionOf(t.conversation_id), "task");
				if (JSON.parse(t.kind) === "pi.tool") {
					const input = (JSON.parse(t.record) as { input?: { callId?: string } }).input;
					if (input?.callId) toolTask.set(`${t.conversation_id}:${input.callId}`, { id: t.id, status: t.status });
				}
			}
			await insertMany(q, "rt.tasks", [{ name: "tenant_id", type: "text" }, { name: "partition_id", type: "text" }, { name: "id", type: "bigint" }, { name: "conversation_id", type: "bigint" }, { name: "kind", type: "text" }, { name: "status", type: "text" }, { name: "abort_requested", type: "boolean" }, { name: "background", type: "boolean" }, { name: "record", type: "text" }], tasks.map((t) => [tenantId, partitionOf(t.conversation_id), t.id, t.conversation_id, t.kind, t.status, !!t.abort_requested, !!t.background, t.record]));

			const submissions = await bundle.all<any>(`${base}/pi/submissions.ndjson`);
			for (const s of submissions) claim(s.id, partitionOf(s.conversation_id), "submission");
			await insertMany(q, "rt.submissions", [{ name: "tenant_id", type: "text" }, { name: "partition_id", type: "text" }, { name: "id", type: "bigint" }, { name: "conversation_id", type: "bigint" }, { name: "request_id", type: "text" }, { name: "status", type: "text" }, { name: "record", type: "text" }], submissions.map((s) => [tenantId, partitionOf(s.conversation_id), s.id, s.conversation_id, s.request_id, s.status, s.record]));

			const taskConv = new Map(tasks.map((t) => [t.id, t.conversation_id as number]));
			const documents = await bundle.all<any>(`${base}/pi/documents.ndjson`);
			const docPartition = new Map<number, string>();
			for (const d of documents) {
				const conv = d.scope_kind === "conversation" ? d.owner_id : d.scope_kind === "task" ? taskConv.get(d.owner_id)! : undefined;
				const partition = conv === undefined ? homePartition : partitionOf(conv);
				docPartition.set(d.id, partition);
				claim(d.id, partition, "document");
			}
			await insertMany(q, "rt.documents", [{ name: "tenant_id", type: "text" }, { name: "partition_id", type: "text" }, { name: "id", type: "bigint" }, { name: "kind", type: "text" }, { name: "family", type: "smallint" }, { name: "key_value", type: "text" }, { name: "scope_kind", type: "text" }, { name: "owner_id", type: "bigint" }, { name: "created_at", type: "bigint" }, { name: "retired_at", type: "bigint" }, { name: "record", type: "text" }], documents.map((d) => [tenantId, docPartition.get(d.id), d.id, d.kind, d.family, d.key_value, d.scope_kind, d.owner_id, d.created_at, d.retired_at, d.record]));
			const revisions: unknown[][] = [];
			const flushRevisions = async () => {
				await insertMany(q, "rt.document_revisions", [{ name: "tenant_id", type: "text" }, { name: "partition_id", type: "text" }, { name: "document_id", type: "bigint" }, { name: "seq", type: "bigint" }, { name: "kind", type: "text" }, { name: "version", type: "integer" }, { name: "content", type: "text" }], revisions);
				revisions.length = 0;
			};
			for await (const r of bundle.ndjson<any>(`${base}/pi/document_revisions.ndjson`)) {
				revisions.push([tenantId, docPartition.get(r.document_id), r.document_id, r.seq, r.kind, r.version, r.content]);
				if (revisions.length >= 2000) await flushRevisions();
			}
			await flushRevisions();
			await insertMany(q, "rt.record_ids", [{ name: "tenant_id", type: "text" }, { name: "id", type: "bigint" }, { name: "partition_id", type: "text" }, { name: "record_type", type: "text" }], claims);

			await importAccounts(q, bundle, tenantId, account, report);
			await importChats(q, bundle, tenantId, plan, partitionOf, homePartition, report);
			await importApprovals(q, bundle, tenantId, partitionOf, toolTask, report);
			await importHostRows(q, bundle, tenantId, report);
			await importHandles(q, bundle, tenantId, report);
			await q.run("INSERT INTO app.import_ledger (tenant_id, import_id, unit, checksum, rows_imported) VALUES ($1, $2, 'tenant', $3, $4)", tenantId, options.importId, checksum, Object.values(plan.counts).reduce((a, b) => a + b, 0));
		},
		{ statementTimeoutMs: 600_000 },
	);
	// Secrets and blobs go to their own stores; both are re-runnable (put by id), and the ledger row above is what marks the tenant imported.
	await importSecrets(bundle, tenantId, options, report);
	await importBlobs(bundle, tenantId, options, report);
	report.status = "imported";
	return report;
}

async function importAccounts(q: Q, bundle: BundleReader, tenantId: string, account: Record<string, any> | undefined, report: TenantReport) {
	const username = account?.username ?? tenantId;
	const status = ACCOUNT_STATUS[String(account?.status ?? "active")] ?? "suspended";
	await q.run("INSERT INTO app.users (tenant_id, user_id, username, role, status) VALUES ($1, $2, $3, $4, $5)", tenantId, tenantId, username, account?.role === "admin" ? "admin" : "member", status);
	const base = `tenants/${tenantId}/auth`;
	for (const p of await bundle.all<any>(`${base}/auth_passkeys.ndjson`)) {
		await q.run("INSERT INTO app.passkeys (tenant_id, user_id, credential_id, public_key, counter, created_at) VALUES ($1, $2, $3, $4, 0, to_timestamp($5 / 1000.0))", tenantId, tenantId, p.id, Buffer.from(String(p.spki), "base64url"), p.created_at ?? 0);
	}
	// Legacy tokens keep working: their stored digest is the same SHA-256 the new system checks. Their scope is every scope, as before.
	for (const t of await bundle.all<any>(`${base}/auth_tokens.ndjson`)) {
		await q.run("INSERT INTO app.api_tokens (tenant_id, token_id, token_hash, user_id, name, scopes, legacy, created_at) VALUES ($1, $2, $3, $4, $5, ARRAY['*'], true, to_timestamp($6 / 1000.0))", tenantId, t.id, t.hash, tenantId, t.name, t.created_at ?? 0);
	}
	for (const r of await bundle.all<any>(`${base}/auth_recovery_codes.ndjson`)) {
		await q.run("INSERT INTO app.recovery_codes (tenant_id, user_id, code_hash, used_at) VALUES ($1, $2, $3, CASE WHEN $4::bigint IS NULL THEN NULL ELSE to_timestamp($4::bigint / 1000.0) END)", tenantId, tenantId, r.hash, r.used_at ?? null);
	}
	report.rows.passkeys = (await bundle.all(`${base}/auth_passkeys.ndjson`)).length;
	report.rows.tokens = (await bundle.all(`${base}/auth_tokens.ndjson`)).length;
	report.rows.recovery_codes = (await bundle.all(`${base}/auth_recovery_codes.ndjson`)).length;
	// Browser sessions are not carried over: people sign in again, after admin sign-in and recovery have been verified.
}

async function importChats(q: Q, bundle: BundleReader, tenantId: string, plan: TenantPlan, partitionOf: (id: number) => string, homePartition: string, report: TenantReport) {
	const sessions = await bundle.all<any>(`tenants/${tenantId}/host/pim_sessions.ndjson`);
	const publicIds = await bundle.all<any>(`tenants/${tenantId}/host/pim_session_ids.ndjson`);
	const publicOf = new Map(publicIds.map((row) => [String(row.session), String(row.id)]));
	let imported = 0;
	for (const s of sessions) {
		const conversationId = Number(s.id);
		if (!plan.familyOf.has(conversationId)) {
			report.unresolved.push({ kind: "chat", ref: String(s.id), reason: "the session has no conversation in the export" });
			continue;
		}
		// The public chat id (a UUID) survives. The root session has none today, so it gets `root`; any other without one gets `s<id>`: both are reported as remaps.
		let chatId = publicOf.get(String(conversationId));
		if (chatId === undefined) {
			chatId = conversationId === 1 ? "root" : `s${conversationId}`;
			report.remapped.push({ kind: "chat", from: String(conversationId), to: chatId });
		}
		await q.run(
			"INSERT INTO app.chats (tenant_id, chat_id, partition_id, conversation_id, title, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))",
			tenantId,
			chatId,
			partitionOf(conversationId),
			conversationId,
			s.title ?? null,
			tenantId,
			s.created_at ?? 0,
		);
		imported++;
	}
	// A family holds one chat; a conversation that is a fork shares its parent's. UNIQUE (tenant, partition) on chats would reject two chats in one family, so forks are listed as chats of their own below only when they have a session row in a separate family; forks inside a family are reachable through their parent chat.
	report.rows.chats = imported;
	void homePartition;
}

async function importApprovals(q: Q, bundle: BundleReader, tenantId: string, partitionOf: (id: number) => string, toolTask: Map<string, { id: number; status: string }>, report: TenantReport) {
	let imported = 0;
	for (const a of await bundle.all<any>(`tenants/${tenantId}/host/pim_approvals.ndjson`)) {
		const conversationId = Number(a.session);
		if (!Number.isFinite(conversationId) || a.call_id == null) continue;
		const task = toolTask.get(`${conversationId}:${a.call_id}`);
		const status = ["pending", "approved", "denied", "expired"].includes(a.status) ? a.status : a.status === "rejected" ? "denied" : undefined;
		if (status === undefined) continue;
		if (task === undefined && status === "pending") {
			report.unresolved.push({ kind: "approval", ref: String(a.id), reason: "pending approval with no suspended tool task: needs a person to look at it" });
			continue;
		}
		const live = task !== undefined && task.status !== "terminal";
		await q.run(
			`INSERT INTO app.approvals (tenant_id, approval_id, partition_id, conversation_id, task_id, call_id, status, decided_by, decided_at, applied_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9::bigint IS NULL THEN NULL ELSE to_timestamp($9::bigint / 1000.0) END, CASE WHEN $7 = 'pending' OR $10 THEN NULL ELSE now() END)`,
			tenantId,
			String(a.id),
			partitionOf(conversationId),
			conversationId,
			task?.id ?? null,
			a.call_id,
			status,
			a.decided_by ?? null,
			a.decided_at ?? null,
			live,
		);
		imported++;
	}
	report.rows.approvals = imported;
}

/** Tables with a v2 home are mapped above; every other host row is kept whole in app.legacy_rows, to be ported with its feature. */
const MAPPED_HOST = new Set(["pim_sessions", "pim_session_ids", "pim_approvals"]);
async function importHostRows(q: Q, bundle: BundleReader, tenantId: string, report: TenantReport) {
	let kept = 0;
	for (const file of bundle.files(`tenants/${tenantId}/host`)) {
		const table = file.split("/").pop()!.replace(/\.ndjson$/, "");
		const rows: unknown[][] = [];
		let n = 0;
		for await (const row of bundle.ndjson<Record<string, unknown>>(file)) {
			const pk = String(row.id ?? row.key ?? row.session ?? row.provider ?? row.tool ?? row.endpoint ?? `${table}#${n}`);
			n++;
			// Mapped tables keep their raw rows too (evidence), under a prefixed name; the rest are the only copy.
			rows.push([tenantId, MAPPED_HOST.has(table) ? `mapped:${table}` : table, `${pk}#${n}`, JSON.stringify(row)]);
		}
		await insertMany(q, "app.legacy_rows", [{ name: "tenant_id", type: "text" }, { name: "table_name", type: "text" }, { name: "pk", type: "text" }, { name: "row", type: "jsonb" }], rows);
		kept += rows.length;
	}
	report.rows.legacy_rows = kept;
}

async function importHandles(q: Q, bundle: BundleReader, tenantId: string, report: TenantReport) {
	let n = 0;
	for (const h of await bundle.all<any>("external/handles.ndjson")) {
		if (h.tenant !== tenantId) continue;
		const live = isLiveHandle(h);
		// Never restarted and never assumed finished: a live handle is for the reconciler to adopt or cancel, exactly once.
		await q.run(
			"INSERT INTO app.external_ops (tenant_id, op_id, kind, state, idempotent, handle, request) VALUES ($1, $2, $3, $4, false, $5, $6)",
			tenantId,
			`import:${h.kind}:${h.id}`,
			h.kind,
			live ? "reconciliation_needed" : h.state === "done" ? "succeeded" : h.state === "cancelled" ? "cancelled" : "failed",
			JSON.stringify(h.handle ?? {}),
			JSON.stringify({ imported: true, harness: h.harness ?? null, lastEventAt: h.lastEventAt ?? null }),
		);
		if (live) report.unresolved.push({ kind: h.kind, ref: String(h.id), reason: "live external handle: adopt or cancel through the reconciler; it is never started again" });
		n++;
	}
	report.rows.external_handles = (report.rows.external_handles ?? 0) + n;
}

async function importSecrets(bundle: BundleReader, tenantId: string, options: ImportOptions, report: TenantReport) {
	const file = bundle.json<{ items: { id: string; purpose: string; nonce: string; ct: string }[] }>(`tenants/${tenantId}/secrets.json`);
	if (!file) return;
	if (!options.exportKey || !options.keyRing) throw new Error("The bundle has secrets: an export key and a key ring are required");
	let n = 0;
	for (const item of decryptSecretsFile(file as never, options.exportKey, tenantId)) {
		await putSecret(options.pool, options.keyRing, { tenantId, secretId: item.id, purpose: item.purpose, value: item.value });
		n++;
	}
	report.rows.secrets = n;
}

async function importBlobs(bundle: BundleReader, tenantId: string, options: ImportOptions, report: TenantReport) {
	let n = 0;
	for (const b of await bundle.all<any>("blobs/index.ndjson")) {
		if (b.tenant !== tenantId) continue;
		if (!options.blobs) throw new Error("The bundle has blobs: a blob store is required");
		const body = (await import("node:fs")).readFileSync(bundle.blobPath(b.sha256));
		if (createHash("sha256").update(body).digest("hex") !== b.sha256) throw new Error(`Blob ${b.sha256} does not match its checksum`);
		const key = `${tenantId}/${b.sha256}`;
		await options.blobs.put(key, body, b.content_type ?? "application/octet-stream");
		await withTenant(options.pool, tenantId, (q) => q.run("INSERT INTO app.objects (tenant_id, object_id, s3_key, size_bytes, sha256, content_type, owner_user) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING", tenantId, String(b.legacy_key ?? b.sha256), key, body.length, b.sha256, b.content_type ?? "application/octet-stream", tenantId));
		n++;
	}
	report.rows.blobs = n;
}

/** The explicit step that lets Runners claim a tenant's families. Not part of import: it is what ends the downtime. */
export async function activateTenant(pool: pg.Pool, tenantId: string): Promise<number> {
	return withTenant(pool, tenantId, (q) => q.run("UPDATE app.activation SET state = 'needs_owner', due_at = now() WHERE tenant_id = $1", tenantId));
}

export { rowDigest, PI_TABLES };
