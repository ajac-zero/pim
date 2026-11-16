/**
 * The promotion of an imported snapshot into the live schemas. `@pim/v2-ops` lands a legacy export in `pim_ops` (typed identity and pi history, every
 * other row verbatim); this reads that landing and writes what the running product reads:
 *
 * - `pim_app`: accounts and usernames, passkeys (bound to the new relying party id), OIDC identities, recovery codes, API token hashes (as legacy tokens), the
 *   chat directory (partitions, conversations with their forks).
 * - `pim_runtime`: each tenant's pi history through the runtime's own importer, with every numeric id, `asOf` ancestry, document revision and commit sequence
 *   kept, public chat ids equal to the application's, and tasks that were mid-effect at the cutover orphaned instead of replayed.
 * - `pim_projection`: a baseline of every imported chat and its sidebar row, so snapshots and Live show history at once; the watermark continues from the
 *   partition's next commit.
 * - `pim_forge`: coding threads (a remote Amp thread keeps its handle and is adopted, never started again).
 *
 * It is idempotent per tenant and runs as the schema owner. **Not promoted** (they remain in `pim_ops.legacy_rows` and the ops ledger, listed in
 * docs/architecture/v2-implementation-status.md): agents, skills, memories, goals, schedules, triggers, providers, connectors, circles, shares, apps, notes,
 * objects' ACLs, settings, standing approvals and grants.
 */
import { createHash } from "node:crypto";
import type { ConversationRecord, DocumentRecord, EntryRecord, SubmissionRecord, TaskRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { projectEntries } from "@pim/shared/transcript";
import { userHandle } from "@pim/v2-app/signin";
import { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { importLegacySpace, type LegacySpace } from "@pim/v2-runtime/splitter";
import { PgPiStorage } from "@pim/v2-runtime/storage";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";

export type PromoteOptions = {
	/** The relying party id of the new deployment: a passkey works only under the hostname it was made for. */
	rpId: string;
	/** When the legacy deployment stopped; tasks that were mid-effect then are orphaned. */
	cutoverAt: number;
	/**
	 * The model a conversation with no agent of its own is given. A legacy conversation names a legacy provider's model; the new deployment's providers are the
	 * application's, so a conversation without a usable agent would answer "no model is configured". A deployment names its default here (a later step resolves it
	 * per owner from `pim_app.agents` and `pim_app.providers`).
	 */
	defaultAgent?: { provider: string; modelId: string };
};

export type PromoteReport = { owners: string[]; chats: number; messages: number; forgeThreads: number; orphanedTasks: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A chat's public id as a UUID: the legacy id when it is one, else one derived from it, the same every time. */
export function chatUuid(publicId: string): string {
	if (UUID.test(publicId)) return publicId.toLowerCase();
	const h = createHash("sha256").update(`pim chat\n${publicId}`).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const ts = (ms: number | string | null) => (ms === null ? null : new Date(Number(ms)));

async function asOwner<T>(pool: Pool, owner: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
	const c = await pool.connect();
	try {
		await c.query("BEGIN");
		await c.query("SELECT set_config('pim.owner_id', $1, true), set_config('pim.lookup', '', true)", [owner]);
		const out = await fn(c);
		await c.query("COMMIT");
		return out;
	} catch (error) {
		await c.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		c.release();
	}
}

/** Accounts, credentials and tokens. Hashes and public keys only: no secret is ever opened here. */
async function promoteIdentity(pool: Pool, owner: string, rpId: string): Promise<void> {
	await asOwner(pool, owner, async (c) => {
		const t = (await c.query("SELECT * FROM pim_ops.tenants WHERE owner_id = $1", [owner])).rows[0];
		await c.query(
			"INSERT INTO pim_app.accounts (owner_id, username, role, status, bot, created_at, activated_at, status_reason) VALUES ($1,$2,$3,$4,false,$5,$6,$7) ON CONFLICT (owner_id) DO NOTHING",
			[owner, t.username, t.role, t.status, ts(t.created_at_ms), ts(t.activated_at_ms), t.status_reason],
		);
		await c.query("INSERT INTO pim_app.usernames (username, owner_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [t.username, owner]);
		for (const k of (await c.query("SELECT * FROM pim_ops.passkeys WHERE owner_id = $1", [owner])).rows) {
			await c.query(
				"INSERT INTO pim_app.passkeys (credential_id, owner_id, user_handle, rp_id, spki, algorithm, name, created_at, last_used_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
				[k.id, owner, userHandle(owner), rpId, k.spki, k.algorithm, k.name, ts(k.created_at_ms), ts(k.last_used_at_ms)],
			);
		}
		for (const i of (await c.query("SELECT * FROM pim_ops.identities WHERE owner_id = $1", [owner])).rows) {
			const provider = /accounts\.google\.com/.test(i.issuer) ? "google" : /github/.test(i.issuer) ? "github" : "oidc";
			await c.query(
				"INSERT INTO pim_app.oidc_identities (id, owner_id, provider, issuer, subject, label) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
				[`oi_${createHash("sha256").update(`${i.issuer}\n${i.subject}`).digest("hex").slice(0, 16)}`, owner, provider, i.issuer, i.subject, new URL(i.issuer.startsWith("http") ? i.issuer : `https://${i.issuer}`).host],
			);
		}
		for (const k of (await c.query("SELECT * FROM pim_ops.api_tokens WHERE owner_id = $1", [owner])).rows) {
			await c.query(
				"INSERT INTO pim_app.api_tokens (id, owner_id, name, token_hash, scopes, legacy, created_at, last_used_at) VALUES ($1,$2,$3,$4,'{*}',true,$5,$6) ON CONFLICT DO NOTHING",
				[k.id, owner, k.name, k.hash, ts(k.created_at_ms), ts(k.last_used_at_ms)],
			);
		}
		for (const r of (await c.query("SELECT * FROM pim_ops.recovery_codes WHERE owner_id = $1", [owner])).rows) {
			await c.query("INSERT INTO pim_app.recovery_codes (code_hash, owner_id, created_at, used_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [r.hash, owner, ts(r.created_at_ms), ts(r.used_at_ms)]);
		}
	});
}

/** The landing's pi tables as the runtime's `LegacySpace`. A task that was running a tool at the cutover (held for reconciliation) ends as orphaned: it is never replayed. */
async function legacySpace(pool: Pool, owner: string, cutoverAt: number, defaultAgent?: PromoteOptions["defaultAgent"]): Promise<{ space: LegacySpace; orphaned: number }> {
	const q = async (sql: string) => (await pool.query(sql, [owner])).rows;
	const conversations = (await q("SELECT record FROM pim_ops.pi_conversations WHERE owner_id = $1 ORDER BY id")).map((r) => r.record as ConversationRecord);
	const entries = (await q("SELECT record, commit_seq FROM pim_ops.pi_entries WHERE owner_id = $1 ORDER BY id")).map((r) => ({ record: r.record as EntryRecord, commitSeq: Number(r.commit_seq) }));
	let orphaned = 0;
	const orphan = (t: Record<string, unknown>, reason: string) => {
		orphaned++;
		return { ...t, state: { status: "terminal", outcome: { status: "orphaned", reason } }, endedAt: cutoverAt };
	};
	const tasks = (await q("SELECT id, conversation_id, kind, status, abort_requested, background, hold, record FROM pim_ops.pi_tasks WHERE owner_id = $1 ORDER BY id")).map((r) => {
		const t = r.record as Record<string, unknown>;
		const complete = { ...t, id: Number(r.id), conversationId: Number(r.conversation_id), kind: r.kind, version: t.version ?? 1, input: t.input ?? {}, background: r.background, abortRequested: r.abort_requested };
		// A task whose effect was unknown at the cutover is never replayed.
		if (r.hold !== null) return orphan(complete, "The effect of this call was unknown at the cutover; it was not repeated. Reconcile it.");
		if (t.state !== undefined) return complete;
		// A record without a durable state (the landing keeps the typed columns): a finished task stays finished; one that was live cannot resume without its state.
		return r.status === "terminal" ? { ...complete, state: { status: "terminal", outcome: { status: "completed", result: t.result ?? null } } } : orphan(complete, "The task had no recorded state to resume from at the cutover.");
	});
	const submissions = (await q("SELECT record FROM pim_ops.pi_submissions WHERE owner_id = $1 ORDER BY id")).map((r) => r.record as SubmissionRecord);
	const revisions = await q("SELECT document_id, seq, kind, version, content FROM pim_ops.pi_document_revisions WHERE owner_id = $1 ORDER BY document_id, seq");
	// The landing keeps a document's creation and retirement in columns of their own, outside its record.
	const scopeOf = (kind: string, id: number) => (kind === "session" ? { kind: "session" } : kind === "task" ? { kind: "task", taskId: id } : { kind: "conversation", conversationId: id });
	const documents = (await q("SELECT id, record, created_at, retired_at, scope_kind, scope_owner_id FROM pim_ops.pi_documents WHERE owner_id = $1 ORDER BY id")).map((r) => ({
		record: { ...r.record, ...(typeof r.record.scope === "object" && r.record.scope !== null ? {} : { scope: scopeOf(r.scope_kind, Number(r.scope_owner_id)) }), createdAt: Number(r.created_at), ...(r.retired_at === null ? {} : { retiredAt: Number(r.retired_at) }) } as DocumentRecord,
		revisions: revisions.filter((v) => Number(v.document_id) === Number(r.id)).map((v) => ({ seq: Number(v.seq), kind: v.kind as "base" | "delta", version: v.version as number, content: v.content as unknown })),
	}));
	const next = Number((await q("SELECT next_id FROM pim_ops.owner_id_sequence WHERE owner_id = $1"))[0]?.next_id ?? 1);
	const nextSeq = Math.max(1, ...(await q("SELECT next_commit_seq FROM pim_ops.partitions WHERE owner_id = $1")).map((r) => Number(r.next_commit_seq)));
	// pi keeps its own state in four documents per conversation, and a model in `pi.agent`. A legacy conversation has the first four (they are made with it); one that lacks
	// any gets them as pi would have made them, so that pi can run it, and `pi.agent` names the deployment's default model when the conversation has none.
	const builtins: { kind: string; history: "latest" | "rewindable"; fork: "initial" | "asOf"; content: () => unknown }[] = [
		{ kind: "pi.live", history: "latest", fork: "initial", content: () => ({}) },
		{ kind: "pi.inbox", history: "latest", fork: "initial", content: () => ({ items: [] }) },
		{ kind: "pi.usage", history: "latest", fork: "initial", content: () => ({ models: {}, tools: {} }) },
		{ kind: "pi.provider", history: "latest", fork: "initial", content: () => ({ sessionId: randomUUID() }) },
		...(defaultAgent ? [{ kind: "pi.agent", history: "rewindable" as const, fork: "asOf" as const, content: () => ({ model: defaultAgent }) }] : []),
	];
	let id = Math.max(next - 1, 1, ...conversations.map((c) => c.id), ...entries.map((e) => e.record.id), ...(tasks as { id: number }[]).map((t) => t.id), ...submissions.map((x) => x.id), ...documents.map((x) => x.record.id));
	const seq = Math.max(nextSeq, ...entries.map((e) => e.commitSeq + 1));
	for (const c of conversations) {
		for (const b of builtins) {
			if (documents.some((x) => x.record.kind === b.kind && x.record.scope.kind === "conversation" && x.record.scope.conversationId === c.id)) continue;
			documents.push({ record: { id: ++id, kind: b.kind, scope: { kind: "conversation", conversationId: c.id }, history: b.history, fork: b.fork, createdAt: seq } as unknown as DocumentRecord, revisions: [{ seq, kind: "base", version: 1, content: b.content() }] });
		}
	}
	return { space: { conversations, entries, tasks: tasks as never, submissions, documents, metadata: { nextId: Math.max(next, ...documents.map((x) => x.record.id + 1)), nextSeq: Math.max(nextSeq, ...documents.map((x) => x.record.createdAt + 1)) } }, orphaned };
}

/** The application's chat directory and a baseline projection of what the runtime now holds. */
async function promoteChats(pool: Pool, runtime: RuntimeDb, owner: string): Promise<{ chats: number; messages: number }> {
	const chats = (await pool.query("SELECT * FROM pim_ops.chats WHERE owner_id = $1 ORDER BY conversation_id", [owner])).rows;
	const parts = (await runtime.read<{ partition_id: string; kind: string; next_seq: string }>(owner, "SELECT partition_id, kind, next_seq FROM pim_runtime.partitions WHERE owner_id = $1", [owner])).rows;
	const route = new Map((await runtime.read<{ conversation_id: string; partition_id: string; public_chat_id: string }>(owner, "SELECT conversation_id, partition_id, public_chat_id FROM pim_runtime.conversation_partitions WHERE owner_id = $1", [owner])).rows.map((r) => [Number(r.conversation_id), r]));
	const parents = new Map((await runtime.read<{ id: string; parent_conversation_id: string | null }>(owner, "SELECT id, parent_conversation_id FROM pim_runtime.conversations WHERE owner_id = $1", [owner])).rows.map((r) => [Number(r.id), r.parent_conversation_id === null ? null : Number(r.parent_conversation_id)]));
	const chatOf = new Map(chats.map((c) => [Number(c.conversation_id), chatUuid(c.public_id)]));
	const highWater = Number((await runtime.read<{ high_water: string }>(owner, "SELECT high_water FROM pim_runtime.owner_id_allocators WHERE owner_id = $1", [owner])).rows[0]?.high_water ?? 1);
	let messages = 0;
	// The application's side: partitions, then conversations.
	await asOwner(pool, owner, async (c) => {
		for (const p of parts) await c.query("INSERT INTO pim_app.partitions (partition_id, owner_id, home, next_conversation_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [p.partition_id, owner, p.kind === "home", p.kind === "home" ? highWater + 1 : 2]);
		for (const ch of chats) {
			const r = route.get(Number(ch.conversation_id));
			if (!r) continue;
			await c.query(
				"INSERT INTO pim_app.conversations (public_chat_id, owner_id, partition_id, conversation_id, title, summary, summary_of, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
				[chatUuid(ch.public_id), owner, r.partition_id, ch.conversation_id, ch.title, ch.summary, ch.summary_of ? chatUuid(ch.summary_of) : null, ts(ch.created_at_ms), ts(ch.updated_at_ms), ts(ch.deleted_at_ms)],
			);
		}
		for (const ch of chats) {
			const parent = parents.get(Number(ch.conversation_id));
			const parentChat = parent == null ? undefined : chatOf.get(parent);
			if (parentChat) await c.query("UPDATE pim_app.conversations SET forked_from = $2 WHERE public_chat_id = $1", [chatUuid(ch.public_id), parentChat]);
		}
	});
	// The projection's baseline: each chat's transcript and sidebar line, and the watermark just before the partition's next commit.
	for (const ch of chats) {
		if (ch.deleted_at_ms !== null) continue;
		const r = route.get(Number(ch.conversation_id));
		if (!r) continue;
		const storage = PgPiStorage.forReading(runtime, owner, r.partition_id);
		const entries: EntryRecord[] = [];
		let cursor: never | undefined;
		for (;;) {
			const page = await storage.scanEntries({ conversationId: Number(ch.conversation_id) as never, order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
			entries.push(...page.items);
			if (!page.next) break;
			cursor = page.next as never;
		}
		const part = parts.find((p) => p.partition_id === r.partition_id)!;
		const seq = Number(part.next_seq) - 1;
		await asOwner(pool, owner, async (c) => {
			for (const entry of entries) {
				for (const m of projectEntries([entry])) {
					messages++;
					await c.query(
						"INSERT INTO pim_projection.chat_transcript_projection (owner_id, stream_kind, chat_id, entry_id, position, partial, message, partition_id, commit_seq, projection_version) VALUES ($1,'chat',$2,$3,$4,false,$5,$6,$7,1) ON CONFLICT DO NOTHING",
						[owner, chatUuid(ch.public_id), m.id, Number(entry.id), JSON.stringify(m), r.partition_id, seq],
					);
				}
			}
			await c.query(
				"INSERT INTO pim_projection.sidebar_session_projection (owner_id, chat_id, title, updated_at, partition_id, commit_seq, projection_version) VALUES ($1,$2,$3,$4,$5,$6,1) ON CONFLICT DO NOTHING",
				[owner, chatUuid(ch.public_id), ch.title, Number(ch.updated_at_ms), r.partition_id, seq],
			);
		});
	}
	await asOwner(pool, owner, async (c) => {
		for (const p of parts) {
			await c.query("INSERT INTO pim_projection.projection_watermarks (owner_id, partition_id, projection_version, projected_seq) VALUES ($1,$2,1,$3) ON CONFLICT DO NOTHING", [owner, p.partition_id, Number(p.next_seq) - 1]);
		}
	});
	return { chats: chats.length, messages };
}

/** Coding threads from the legacy rows: a thread keeps its id; an Amp thread keeps its remote handle and is adopted by Forge, never started again. */
async function promoteForge(pool: Pool, owner: string): Promise<number> {
	const legacyId = (await pool.query("SELECT legacy_id FROM pim_ops.owner_map WHERE owner_id = $1", [owner])).rows[0]?.legacy_id;
	const rows = (await pool.query("SELECT row, source FROM pim_ops.legacy_rows WHERE owner_id = $1 AND table_name = 'coding_thread'", [owner])).rows.map((r) => r.row as Record<string, any>);
	const remote = new Map((await pool.query("SELECT * FROM pim_ops.remote_threads WHERE owner_id = $1", [owner])).rows.map((r) => [r.thread_id as string, r]));
	void legacyId;
	let n = 0;
	for (const t of rows) {
		const r = remote.get(t.thread_id);
		const orb = typeof t.orb === "string" ? JSON.parse(t.orb) : t.orb;
		// A thread that was running and had a process (a sandbox, a CLI run) has none now: it is idle and a person steers it. A remote thread is adopted.
		const adopted = t.harness === "amp" && orb && r?.adoption === "adopt";
		const state = adopted ? "running" : t.state === "archived" ? "archived" : "idle";
		const inserted = await pool.query(
			`INSERT INTO pim_forge.forge_threads (thread_id, owner_id, start_operation, harness, state, state_reason, task, repo, ref, branch, created_by, orb, gateway_nonce)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$2,$11,$12) ON CONFLICT (thread_id) DO NOTHING`,
			[t.thread_id, owner, t.start_operation ?? `imported:${t.thread_id}`, t.harness, state, adopted ? null : "imported", t.task ?? "(imported thread)", t.repo_url, t.base_ref ?? null, t.branch ?? null, orb ? JSON.stringify(orb) : null, randomUUID()],
		);
		if (inserted.rowCount) n++;
		// Its transcript: the events the legacy thread kept, in order.
		const events = (await pool.query("SELECT row FROM pim_ops.legacy_rows WHERE owner_id = $1 AND source = 'CodingThread' AND table_name = 'coding_event' AND pk LIKE $2 ORDER BY pk", [owner, `${t.thread_id}%`])).rows.map((e) => e.row as Record<string, any>);
		for (const e of events) {
			await pool.query("INSERT INTO pim_forge.forge_events (thread_id, seq, kind, data, at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [t.thread_id, e.seq, e.kind, typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? {}), ts(e.at)]);
		}
	}
	return n;
}

/** Promotes every tenant of the landing; the owners done. Safe to run again: what is already in place is left as it is. */
export async function promoteToLive(pool: Pool, options: PromoteOptions): Promise<PromoteReport> {
	const runtime = new RuntimeDb(pool);
	const owners = (await pool.query("SELECT owner_id FROM pim_ops.tenants WHERE owner_id <> '_deployment' ORDER BY owner_id")).rows.map((r) => r.owner_id as string);
	const report: PromoteReport = { owners: [], chats: 0, messages: 0, forgeThreads: 0, orphanedTasks: 0 };
	for (const owner of owners) {
		await promoteIdentity(pool, owner, options.rpId);
		const has = (await runtime.read(owner, "SELECT 1 FROM pim_runtime.partitions WHERE owner_id = $1 LIMIT 1", [owner])).rowCount;
		const hasPi = (await pool.query("SELECT 1 FROM pim_ops.pi_conversations WHERE owner_id = $1 LIMIT 1", [owner])).rowCount;
		if (!has && hasPi) {
			const { space, orphaned } = await legacySpace(pool, owner, options.cutoverAt, options.defaultAgent);
			const publicChatIds = new Map((await pool.query("SELECT conversation_id, public_id FROM pim_ops.chats WHERE owner_id = $1", [owner])).rows.map((r) => [Number(r.conversation_id), chatUuid(r.public_id)]));
			await importLegacySpace(runtime, owner, space, { publicChatIds });
			report.orphanedTasks += orphaned;
			const c = await promoteChats(pool, runtime, owner);
			report.chats += c.chats;
			report.messages += c.messages;
		}
		report.forgeThreads += await promoteForge(pool, owner);
		report.owners.push(owner);
	}
	return report;
}
