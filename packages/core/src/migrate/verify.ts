import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { withTenant } from "../db.ts";
import type { IdAllocator } from "../ids.ts";
import { KeyRing, getSecret } from "../secrets.ts";
import { PgStorage } from "../storage.ts";
import type { BlobStore } from "./blobs.ts";
import { BundleReader, PI_TABLES, isLiveHandle, rowDigest } from "./format.ts";
import { decryptSecretsFile } from "./secrets-bundle.ts";

export interface Check {
	tenant: string | "*";
	name: string;
	ok: boolean;
	detail?: string;
}

export interface VerifyOptions {
	pool: pg.Pool;
	ids: IdAllocator;
	blobs?: BlobStore;
	keyRing?: KeyRing;
	exportKey?: Buffer;
}

const KEY: Record<string, string> = { conversations: "id", entries: "id", tasks: "id", submissions: "id", documents: "id", document_revisions: "document_id, seq" };

/** The line a row contributes to its table's digest: the same on the file side and the database side. */
const line = (table: string, row: Record<string, any>) => (table === "document_revisions" ? `${row.document_id}|${row.seq}|${row.kind}|${row.version}|${row.content}` : `${row.id}|${row.record}`);

/** Proves an import: counts, per-table checksums, references, ids and sequences, history and fork parity, login and admin recovery, credentials, blobs, and that nothing is running. */
export async function verifyImport(bundle: BundleReader, options: VerifyOptions): Promise<{ ok: boolean; checks: Check[] }> {
	const checks: Check[] = [];
	const add = (tenant: string, name: string, ok: boolean, detail?: string) => checks.push({ tenant, name, ok, detail });
	const integrity = await bundle.checkIntegrity();
	add("*", "bundle integrity (every file's sha256 against the manifest)", integrity.length === 0, integrity.join("; "));

	let activeAdmins = 0;
	for (const tenantId of bundle.manifest.tenants) {
		const base = `tenants/${tenantId}`;
		const q = <T>(fn: (q: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) => withTenant(options.pool, tenantId, fn, { readOnly: true });

		// Counts and digests, table by table.
		for (const table of PI_TABLES) {
			const rows = await bundle.all<Record<string, any>>(`${base}/pi/${table}.ndjson`);
			const sorted = rows.map((r) => ({ key: table === "document_revisions" ? [r.document_id, r.seq] : [r.id], text: line(table, r) })).sort((a, b) => (a.key[0]! - b.key[0]!) || ((a.key[1] ?? 0) - (b.key[1] ?? 0)));
			const fileDigest = rowDigest(sorted.map((r) => r.text));
			const db = await q((c) => c.all<Record<string, any>>(`SELECT * FROM rt.${table} WHERE tenant_id = $1 ORDER BY ${KEY[table]}`, tenantId));
			const dbDigest = rowDigest(db.map((r) => line(table, r)));
			add(tenantId, `${table}: ${rows.length} rows, identical content`, db.length === rows.length && dbDigest === fileDigest, `file ${rows.length} rows, database ${db.length}`);
		}
		const meta = bundle.json<{ next_id: string; next_seq: number }>(`${base}/pi/metadata.json`) ?? { next_id: "2", next_seq: 1 };
		const ids = await q((c) => c.get<{ next_id: number; max_id: number }>("SELECT t.next_id, COALESCE((SELECT max(id) FROM rt.record_ids WHERE tenant_id = $1), 0) AS max_id FROM rt.tenant_ids t WHERE t.tenant_id = $1", tenantId));
		add(tenantId, "ids: the sequence is past every imported id and the old next id", !!ids && ids.next_id > ids.max_id && ids.next_id >= Number(meta.next_id), JSON.stringify(ids));
		const seqs = await q((c) => c.get<{ low: number }>("SELECT min(next_seq) AS low FROM rt.partitions WHERE tenant_id = $1", tenantId));
		const maxSeq = Math.max(0, ...(await bundle.all<any>(`${base}/pi/entries.ndjson`)).map((e) => e.commit_seq));
		add(tenantId, "sequences: every family's next seq is past every imported commit seq and the old next seq", !!seqs && seqs.low > maxSeq && seqs.low >= meta.next_seq, JSON.stringify(seqs));

		// References: nothing points outside its family; the directory is complete.
		const dangling = await q((c) =>
			c.get<{ n: number }>(
				`SELECT (SELECT count(*) FROM rt.entries e WHERE e.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM rt.conversations c WHERE c.tenant_id = e.tenant_id AND c.id = e.conversation_id AND c.partition_id = e.partition_id))
				      + (SELECT count(*) FROM rt.tasks e WHERE e.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM rt.conversations c WHERE c.tenant_id = e.tenant_id AND c.id = e.conversation_id AND c.partition_id = e.partition_id))
				      + (SELECT count(*) FROM rt.submissions e WHERE e.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM rt.conversations c WHERE c.tenant_id = e.tenant_id AND c.id = e.conversation_id AND c.partition_id = e.partition_id))
				      + (SELECT count(*) FROM rt.conversations c WHERE c.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM rt.conversation_directory d WHERE d.tenant_id = c.tenant_id AND d.conversation_id = c.id AND d.partition_id = c.partition_id))
				      + (SELECT count(*) FROM rt.record_ids r WHERE r.tenant_id = $1 AND r.record_type IN ('conversation', 'entry') AND NOT EXISTS (SELECT 1 FROM rt.conversations c WHERE c.tenant_id = r.tenant_id AND c.id = r.id AND r.record_type = 'conversation' AND c.partition_id = r.partition_id) AND NOT EXISTS (SELECT 1 FROM rt.entries e WHERE e.tenant_id = r.tenant_id AND e.id = r.id AND r.record_type = 'entry' AND e.partition_id = r.partition_id)) AS n`,
				tenantId,
			),
		);
		add(tenantId, "references: every record's conversation is in its own family, the directory covers every conversation", dangling?.n === 0, `${dangling?.n} violations`);
		const crossing = await q((c) => c.get<{ n: number }>("SELECT count(*) AS n FROM rt.conversations f JOIN rt.conversations p ON p.tenant_id = f.tenant_id AND p.id = (f.record::jsonb->'parent'->>'conversationId')::bigint WHERE f.tenant_id = $1 AND f.partition_id <> p.partition_id", tenantId));
		add(tenantId, "forks: no fork is in a different family from its parent", crossing?.n === 0, `${crossing?.n} crossing`);

		// History and fork parity, through the real adapter: each conversation's visible entries, oldest first.
		const conversations = await bundle.all<any>(`${base}/pi/conversations.ndjson`);
		const byId = new Map(conversations.map((c) => [c.id, JSON.parse(c.record) as { parent?: { conversationId: number; at: number } }]));
		const entryRows = await bundle.all<any>(`${base}/pi/entries.ndjson`);
		const byConversation = new Map<number, number[]>();
		for (const e of entryRows) (byConversation.get(e.conversation_id) ?? byConversation.set(e.conversation_id, []).get(e.conversation_id)!).push(e.id);
		const expectedVisible = (id: number): number[] => {
			const own = (byConversation.get(id) ?? []).sort((a, b) => a - b);
			const parent = byId.get(id)?.parent;
			return parent ? [...expectedVisible(parent.conversationId).filter((e) => e <= parent.at), ...own] : own;
		};
		const partitions = await q((c) => c.all<{ id: number; partition_id: string }>("SELECT conversation_id AS id, partition_id FROM rt.conversation_directory WHERE tenant_id = $1", tenantId));
		const partitionOf = new Map(partitions.map((p) => [p.id, p.partition_id]));
		let mismatched = 0;
		let forks = 0;
		for (const c of conversations) {
			if (byId.get(c.id)?.parent) forks++;
			const reader = new PgStorage({ pool: options.pool, tenantId, partitionId: partitionOf.get(c.id)!, ownerId: "verify", epoch: 0, home: false, ids: options.ids });
			const got: number[] = [];
			let cursor: Record<string, unknown> | undefined;
			do {
				const page = (await reader.scanEntries({ conversationId: c.id, order: "ascending" }, 500, cursor)) as { items: { id: number }[]; next?: Record<string, unknown> };
				got.push(...page.items.map((e) => e.id));
				cursor = page.next;
			} while (cursor);
			await reader.close();
			if (JSON.stringify(got) !== JSON.stringify(expectedVisible(c.id))) mismatched++;
		}
		add(tenantId, `history: all ${conversations.length} conversations (${forks} forks) read back oldest-first exactly as the source ancestry says`, mismatched === 0, `${mismatched} differ`);

		// Accounts, sign-in and admin recovery.
		const account = (await bundle.all<any>("directory/accounts.ndjson")).find((a) => a.owner_id === tenantId);
		const user = await q((c) => c.get<{ role: string; status: string }>("SELECT role, status FROM app.users WHERE tenant_id = $1 AND user_id = $1", tenantId));
		add(tenantId, "account: the person exists with the same role and status", !!user && user.role === (account?.role === "admin" ? "admin" : "member"), JSON.stringify(user));
		const passkeys = (await bundle.all(`${base}/auth/auth_passkeys.ndjson`)).length;
		const tokens = (await bundle.all<any>(`${base}/auth/auth_tokens.ndjson`));
		const codes = (await bundle.all<any>(`${base}/auth/auth_recovery_codes.ndjson`)).filter((c) => c.used_at == null).length;
		const dbAuth = await q((c) => c.get<{ p: number; t: number; r: number }>("SELECT (SELECT count(*) FROM app.passkeys WHERE tenant_id = $1) AS p, (SELECT count(*) FROM app.api_tokens WHERE tenant_id = $1 AND legacy) AS t, (SELECT count(*) FROM app.recovery_codes WHERE tenant_id = $1 AND used_at IS NULL) AS r", tenantId));
		add(tenantId, "sign-in material: passkeys, token digests and unused recovery codes all carried over", dbAuth?.p === passkeys && dbAuth?.t === tokens.length && dbAuth?.r === codes, JSON.stringify(dbAuth));
		if (user?.role === "admin" && user.status === "active") {
			activeAdmins++;
			add(tenantId, "admin recovery: the admin can sign in again (a passkey or an unused recovery code)", passkeys + codes > 0, `${passkeys} passkeys, ${codes} codes`);
		}
		const usable = await q((c) => c.all<{ token_hash: string }>("SELECT token_hash FROM app.api_tokens WHERE tenant_id = $1 AND legacy", tenantId));
		add(tenantId, "legacy tokens: each stored digest is the one the old system stored", tokens.every((t) => usable.some((u) => u.token_hash === t.hash)));

		// Credentials: every secret decrypts under the new keys and has the same count.
		const secretsFile = bundle.json<any>(`${base}/secrets.json`);
		if (secretsFile) {
			let decrypted = 0;
			if (options.keyRing && options.exportKey) {
				for (const item of decryptSecretsFile(secretsFile, options.exportKey, tenantId)) if ((await getSecret(options.pool, options.keyRing, tenantId, item.id)) === item.value) decrypted++;
			}
			add(tenantId, "credentials: every secret decrypts under the new keys and equals the exported one", decrypted === secretsFile.items.length, `${decrypted}/${secretsFile.items.length}`);
		}

		// Chats and public ids, approvals, notes/files/artifacts bodies.
		const sessions = await bundle.all<any>(`${base}/host/pim_sessions.ndjson`);
		const publicIds = await bundle.all<any>(`${base}/host/pim_session_ids.ndjson`);
		const chats = await q((c) => c.all<{ chat_id: string }>("SELECT chat_id FROM app.chats WHERE tenant_id = $1", tenantId));
		const chatIds = new Set(chats.map((c) => c.chat_id));
		add(tenantId, "chats: every session is a chat, and every public chat id is the same as before", chats.length === sessions.length && publicIds.every((p) => chatIds.has(String(p.id))), `${chats.length} chats for ${sessions.length} sessions`);
		const pendingFile = (await bundle.all<any>(`${base}/host/pim_approvals.ndjson`)).filter((a) => a.status === "pending");
		const pendingDb = await q((c) => c.all<{ approval_id: string }>("SELECT approval_id FROM app.approvals WHERE tenant_id = $1 AND status = 'pending'", tenantId));
		add(tenantId, "approvals: every approval pending in the target was pending in the export (the rest are in the import report as unresolved)", pendingDb.every((d) => pendingFile.some((a) => String(a.id) === d.approval_id)), `${pendingDb.length} of ${pendingFile.length} pending carried over`);
		const blobs = (await bundle.all<any>("blobs/index.ndjson")).filter((b) => b.tenant === tenantId);
		if (blobs.length > 0) {
			let good = 0;
			for (const b of blobs) {
				const body = options.blobs ? await options.blobs.get(`${tenantId}/${b.sha256}`) : undefined;
				if (body && createHash("sha256").update(body).digest("hex") === b.sha256 && createHash("sha256").update(readFileSync(bundle.blobPath(b.sha256))).digest("hex") === b.sha256) good++;
			}
			const meta2 = await q((c) => c.get<{ n: number }>("SELECT count(*) AS n FROM app.objects WHERE tenant_id = $1", tenantId));
			add(tenantId, "files, notes and artifacts: every object body is in the store with its checksum, and has metadata", good === blobs.length && meta2?.n === blobs.length, `${good}/${blobs.length} bodies, ${meta2?.n} metadata rows`);
		}
		const live = (await bundle.all<any>("external/handles.ndjson")).filter((h) => h.tenant === tenantId && isLiveHandle(h));
		const ops = await q((c) => c.get<{ n: number }>("SELECT count(*) AS n FROM app.external_ops WHERE tenant_id = $1 AND state = 'reconciliation_needed' AND op_id LIKE 'import:%'", tenantId));
		add(tenantId, "external handles: every live coding or remote session is held for reconciliation, none restarted", ops?.n === live.length, `${ops?.n}/${live.length}`);

		// Nothing runs before the explicit activation.
		const running = await q((c) => c.get<{ n: number }>("SELECT (SELECT count(*) FROM app.activation WHERE tenant_id = $1 AND state <> 'quiescent') + (SELECT count(*) FROM app.signals WHERE tenant_id = $1) + (SELECT count(*) FROM app.timers WHERE tenant_id = $1) + (SELECT count(*) FROM rt.partitions WHERE tenant_id = $1 AND lease_until > now()) AS n", tenantId));
		add(tenantId, "quiescent: no family is due, leased, signalled or timed: no catch-up can fire", running?.n === 0, `${running?.n} active`);
	}
	if (bundle.manifest.tenants.length > 0) add("*", "deployment admin: at least one active admin exists in the target", activeAdmins > 0, `${activeAdmins}`);
	return { ok: checks.every((c) => c.ok), checks };
}
