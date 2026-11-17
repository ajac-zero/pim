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
 * - the space's domain (`promoteDomain`): agents, skills and their versions, memories, goals, triggers (with the post-cutover skip so nothing catches up),
 *   providers and connectors (secrets re-sealed from the ops envelopes under the application's keys), circles, chat links, profiles, apps with their versions, notes
 *   (the Yjs document as the first update), objects' metadata and ACLs, and the settings a person explicitly set.
 *
 * It is idempotent per tenant and runs as the schema owner. **Not promoted** (they remain in `pim_ops.legacy_rows` and the ops ledger, listed in
 * docs/architecture/v2-implementation-status.md): legacy schedules (they are triggers, promoted as such), deployment-level providers, templates and bots,
 * standing approvals and grants (an admin records those again, deliberately).
 */
import { createHash } from "node:crypto";
import type { ConversationRecord, DocumentRecord, EntryRecord, SubmissionRecord, TaskRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { projectEntries } from "@pim/shared/transcript";
import { KeyringCrypto, sealString } from "@pim/v2-app/crypto";
import { mergeNoteUpdates, noteUpdateFromText } from "@pim/v2-app/note-import";
import { userHandle } from "@pim/v2-app/signin";
import type { EnvelopeCrypto as OpsCrypto } from "@pim/v2-ops/crypto/envelope";
import { applyImmutable, decoder } from "@earendil-works/chord/delta";
import { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { importLegacySpace, type LegacySpace } from "@pim/v2-runtime/splitter";
import { PgPiStorage } from "@pim/v2-runtime/storage";
import type { Pool, PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";

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
	/** When the new deployment goes live: a time trigger counts firings from here, never from before it, so nothing the cutover missed fires. Default: now. */
	activatedAt?: number;
	/** What re-seals the secrets the landing holds: the ops envelopes are opened with `ops`, and sealed again under the application's own keys with `app`. Without it connectors and providers are promoted without credentials, to be connected again. */
	crypto?: { ops: OpsCrypto; app: KeyringCrypto };
	/** Where the legacy objects' bytes are: skills' files, apps' files and media. Without it those rows are reported as skipped, not promoted empty. */
	objects?: { get(bucket: string, key: string): Promise<Uint8Array | null>; put?(key: string, bytes: Uint8Array, contentType: string | null): Promise<void> };
};

/** `domain` counts what was promoted per kind; `skipped` says what was left in the landing and why. */
export type PromoteReport = { owners: string[]; chats: number; messages: number; forgeThreads: number; orphanedTasks: number; clearedRuns: number; remappedModels: number; domain: Record<string, number>; skipped: string[] };

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
async function legacySpace(pool: Pool, owner: string, cutoverAt: number, defaultAgent?: PromoteOptions["defaultAgent"], usable: ReadonlySet<string> = new Set()): Promise<{ space: LegacySpace; orphaned: number; clearedRuns: number; remappedModels: number }> {
	const q = async (sql: string) => (await pool.query(sql, [owner])).rows;
	const conversations = (await q("SELECT record FROM pim_ops.pi_conversations WHERE owner_id = $1 ORDER BY id")).map((r) => r.record as ConversationRecord);
	const entries = (await q("SELECT record, commit_seq FROM pim_ops.pi_entries WHERE owner_id = $1 ORDER BY id")).map((r) => ({ record: r.record as EntryRecord, commitSeq: Number(r.commit_seq) }));
	let orphaned = 0;
	/** The tasks orphaned, by conversation: the run that waited on one must not outlive it. */
	const orphanedIn = new Map<number, Set<number>>();
	const orphan = (t: Record<string, unknown>, reason: string) => {
		orphaned++;
		(orphanedIn.get(Number(t.conversationId)) ?? orphanedIn.set(Number(t.conversationId), new Set()).get(Number(t.conversationId))!).add(Number(t.id));
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
	const clearedRuns = clearOrphanedRuns(documents, orphanedIn);
	// A conversation's `pi.agent` document names the model it was last run on, and a legacy one names the old deployment's (Workers AI, the preview stand-in): a provider this deployment does not have. pi would
	// fail every new message with "Model ... is not available", so each such revision names the deployment's default model instead. A model of a provider the deployment has stays.
	let remappedModels = 0;
	if (defaultAgent) {
		for (const doc of documents) {
			if (doc.record.kind !== "pi.agent") continue;
			doc.revisions = doc.revisions.map((rev) => {
				const model = (rev.content as { model?: { provider?: string } } | null)?.model;
				if (!model?.provider || usable.has(model.provider)) return rev;
				remappedModels++;
				return { ...rev, content: { ...(rev.content as object), model: defaultAgent } };
			});
		}
	}
	return { clearedRuns, remappedModels, space: { conversations, entries, tasks: tasks as never, submissions, documents, metadata: { nextId: Math.max(next, ...documents.map((x) => x.record.id + 1)), nextSeq: Math.max(nextSeq, ...documents.map((x) => x.record.createdAt + 1)) } }, orphaned };
}

/**
 * A conversation cut off mid-tool keeps `run` in its live document: the task that settles the run's inputs, and `tools`, the round's calls. The tasks are orphaned (never
 * replayed), but nothing would ever end that run, so a message sent after the cutover would queue behind it forever. A live document whose run, or any of whose tool slots,
 * names an orphaned task of its conversation is rewritten without `run`, `generation` and `tools`, as pi's own `endRun` leaves it. Its history is `latest`, so one base
 * revision holding that value replaces the revisions. A document whose value cannot be rebuilt is left as it is. Returns how many runs were cleared.
 */
function clearOrphanedRuns(documents: { record: DocumentRecord; revisions: { seq: number; kind: "base" | "delta"; version: number; content: unknown }[] }[], orphanedIn: Map<number, Set<number>>): number {
	let cleared = 0;
	for (const doc of documents) {
		if (doc.record.kind !== "pi.live" || doc.record.scope.kind !== "conversation") continue;
		const orphans = orphanedIn.get(doc.record.scope.conversationId);
		if (!orphans || orphans.size === 0) continue;
		const revisions = [...doc.revisions].sort((a, b) => a.seq - b.seq);
		const base = revisions.findLast((r) => r.kind === "base");
		if (!base) continue;
		let value: Record<string, any>;
		try {
			const dec = decoder();
			value = revisions.filter((r) => r.seq >= base.seq).slice(1).reduce((v, r) => applyImmutable(v, dec.decode(r.content as never) as never), base.content as Record<string, any>);
		} catch {
			continue;
		}
		const slots: { taskId?: number }[] = Array.isArray(value.tools) ? value.tools : [];
		const waiting = (value.run && orphans.has(Number(value.run.taskId))) || slots.some((slot) => slot.taskId !== undefined && orphans.has(Number(slot.taskId)));
		if (!waiting) continue;
		const { run: _run, generation: _generation, tools: _tools, ...rest } = value;
		doc.revisions = [{ seq: revisions[0]!.seq, kind: "base", version: base.version, content: rest }];
		cleared++;
	}
	return cleared;
}

/** The ids of the custom model providers a space had (its models are still named by them, and the promotion keeps those ids). */
async function ownProviderIds(pool: Pool, owner: string, options: PromoteOptions): Promise<string[]> {
	const meta = (await pool.query("SELECT row FROM pim_ops.legacy_rows WHERE owner_id = $1 AND table_name = 'pim_meta' AND pk = 'own_providers'", [owner])).rows[0]?.row as { value?: { $secret?: string } } | undefined;
	const name = meta?.value?.$secret;
	const found = name ? (await pool.query("SELECT envelope FROM pim_ops.secret_envelopes WHERE owner_id = $1 AND name = $2", [owner, name])).rows[0] : undefined;
	if (!found || !options.crypto) return [];
	try {
		return (parseJson(options.crypto.ops.open(found.envelope, [owner, name!, "meta"]).toString(), []) as { id: string }[]).map((p) => p.id);
	} catch {
		return [];
	}
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


// ---- the space's domain ----

const parseJson = (value: unknown, fallback: unknown = null): any => {
	if (value === null || value === undefined) return fallback;
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
};
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "item";

type Domain = { counts: Record<string, number>; skipped: string[] };
const bump = (d: Domain, kind: string, n = 1) => void (d.counts[kind] = (d.counts[kind] ?? 0) + n);

/** The legacy rows of one table of one tenant, as the landing kept them. */
async function legacyRows(pool: Pool, owner: string, table: string): Promise<Record<string, any>[]> {
	return (await pool.query("SELECT row FROM pim_ops.legacy_rows WHERE owner_id = $1 AND table_name = $2 ORDER BY pk", [owner, table])).rows.map((r) => r.row as Record<string, any>);
}

/**
 * Agents, skills, memories, goals, triggers, providers, connectors, circles, chat links, profiles, apps, notes, objects and explicit settings of one tenant, from the landing into
 * `pim_app`. Every insert is `ON CONFLICT DO NOTHING`, so it can be run again. A row that refers to something that is not in the new deployment (a member who never joined, an
 * app without its files) is skipped and said so, never promoted half.
 */
async function promoteDomain(pool: Pool, owner: string, options: PromoteOptions, d: Domain): Promise<void> {
	const legacyId = (await pool.query("SELECT legacy_id FROM pim_ops.owner_map WHERE owner_id = $1", [owner])).rows[0]?.legacy_id as string | undefined;
	const owners = new Map((await pool.query("SELECT legacy_id, owner_id FROM pim_ops.owner_map")).rows.map((r) => [r.legacy_id as string, r.owner_id as string]));
	const rows = (table: string) => legacyRows(pool, owner, table);
	const secret = async (cell: unknown, purpose: string): Promise<string | null> => {
		if (!cell || typeof cell !== "object" || !("$secret" in cell) || !options.crypto) return null;
		const name = String((cell as { $secret: string }).$secret);
		const found = (await pool.query("SELECT envelope, purpose FROM pim_ops.secret_envelopes WHERE owner_id = $1 AND name = $2", [owner, name])).rows[0];
		if (!found) return null;
		const plaintext = options.crypto.ops.open(found.envelope, [owner, name, found.purpose]).toString();
		void purpose;
		return plaintext === "" ? null : plaintext;
	};
	const sealed = async (plaintext: string, context: string) => sealString(options.crypto!.app, plaintext, context);
	const chatOf = new Map<string, string>();
	// A legacy session is named by its conversation id; the landing keeps that link as `chats` (its `pim_session_ids` is a pi table, not a legacy row).
	for (const r of (await pool.query("SELECT conversation_id, public_id FROM pim_ops.chats WHERE owner_id = $1", [owner])).rows) chatOf.set(String(r.conversation_id), chatUuid(String(r.public_id)));
	const ms = (v: unknown) => (v === null || v === undefined ? new Date() : new Date(Number(v)));

	const agents = await rows("pim_agents");
	const skills = await rows("pim_skills");
	const skillVersions = await rows("pim_skill_versions");
	const skillFiles = await rows("pim_skill_files");
	const memories = await rows("optmem_log");
	const goals = await rows("pim_goals");
	const connections = await rows("pim_app_connections");
	const credentials = await rows("pim_credentials");
	const triggers = await rows("pim_triggers");
	const revisions = await rows("pim_trigger_revisions");
	const circles = await rows("pim_circles");
	const members = await rows("pim_circle_members");
	const links = await rows("pim_chat_links");
	const artifacts = await rows("pim_artifacts");
	const artifactVersions = await rows("pim_artifact_versions");
	const artifactFiles = await rows("pim_artifact_files");
	const noteUpdates = await rows("pim_note_updates");
	const storedFiles = await rows("pim_stored_files");
	const agentSessions = await rows("pim_agent_sessions");
	const meta = await rows("pim_meta");
	const profile = (await pool.query("SELECT row FROM pim_ops.legacy_rows WHERE table_name = 'profiles' AND row->>'owner_id' = ANY($1)", [[legacyId ?? "", owner]])).rows[0]?.row as Record<string, any> | undefined;
	const dueWork = new Map((await pool.query("SELECT key, state, skip_before_ms FROM pim_ops.due_work WHERE owner_id = $1 AND kind LIKE 'trigger:%'", [owner])).rows.map((r) => [r.key as string, r]));
	const objectRows = (await pool.query("SELECT bucket, key, size_bytes, sha256, content_type FROM pim_ops.objects WHERE owner_id = $1", [owner])).rows;

	// Sealed values are made first: they need no transaction.
	const providerSecrets = new Map<string, string>();
	for (const c of credentials) {
		const plain = await secret(c.credential, "provider-credential");
		const key = plain ? (parseJson(plain, {}) as { apiKey?: string }).apiKey : undefined;
		if (key) providerSecrets.set(String(c.provider), await sealed(key, `provider:${owner}/pv_legacy_${slug(String(c.provider))}`));
	}
	const connectorSecrets = new Map<string, string>();
	for (const c of connections) {
		const plain = await secret(c.credential, "connector-credential");
		if (plain) connectorSecrets.set(String(c.id), await sealed(plain, `connector:${owner}/${c.id}`));
	}

	// Files that live in the object store: skills' and apps'.
	const skillContent = new Map<string, string>();
	for (const f of skillFiles) {
		if (!options.objects || !legacyId) continue;
		const bytes = await options.objects.get("BLOBS", `${legacyId}/skills/${f.sha256}`);
		if (bytes) skillContent.set(`${f.name}\n${f.version}\n${f.path}`, Buffer.from(bytes).toString("utf8"));
	}
	// Apps and notes. A legacy app is a row of `pim_artifacts` whose versions are rows of `pim_artifact_versions`, each with its files in `pim_artifact_files`, whose bytes are in the
	// ARTIFACTS bucket at `<owner>/<sha256>`. A note is such an app of kind `markdown` with one README.md.
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const MAIN = { html: "index.html", jsx: "App.jsx", markdown: "README.md" } as const;
	type PlannedApp = { a: Record<string, any>; kind: "html" | "jsx" | "backend" | "note"; versions: { v: number; files: Record<string, string>; at: unknown }[] };
	const plannedApps: PlannedApp[] = [];
	for (const a of artifacts) {
		const kind = a.kind === "jsx" ? "jsx" : a.kind === "hosted" ? "backend" : a.kind === "html" || a.kind === "app" ? "html" : a.kind === "markdown" ? "note" : null;
		if (!kind) {
			d.skipped.push(`app ${a.id}: a ${a.kind} is not promoted as an app (kept in the landing)`);
			continue;
		}
		const versions: PlannedApp["versions"] = [];
		for (const v of artifactVersions.filter((x) => x.artifact === a.id).sort((x, y) => Number(x.version) - Number(y.version))) {
			const files: Record<string, string> = {};
			for (const f of artifactFiles.filter((x) => x.artifact === a.id && Number(x.version) === Number(v.version))) {
				const bytes = options.objects && legacyId ? await options.objects.get("ARTIFACTS", `${legacyId}/${f.sha256}`) : null;
				if (!bytes) {
					d.skipped.push(`app ${a.id} v${v.version}: ${f.path} has no bytes to promote`);
					continue;
				}
				try {
					files[String(f.path)] = decoder.decode(bytes);
				} catch {
					d.skipped.push(`app ${a.id} v${v.version}: ${f.path} is binary; its bytes are copied as an object, not inlined in the version`);
				}
			}
			// A version from before files were kept apart holds its main file in the row.
			if (Object.keys(files).length === 0 && typeof v.content === "string" && v.content !== "") files[MAIN[kind === "note" ? "markdown" : kind === "backend" ? "html" : kind]] = v.content;
			versions.push({ v: Number(v.version), files, at: v.created_at });
		}
		if (versions.length === 0 || Object.keys(versions.at(-1)!.files).length === 0) {
			d.skipped.push(`app ${a.id}: its files were not given, so it was not promoted empty`);
			continue;
		}
		plannedApps.push({ a, kind, versions });
	}
	// A note's words: the Yjs updates it was edited with when it has them (a live edit not yet saved as a version is only there), else its latest version as the first update.
	const noteBody = (p: PlannedApp): Uint8Array => {
		const updates = noteUpdates.filter((u) => u.artifact === p.a.id && u.data && typeof u.data === "object" && "$b64" in u.data).map((u) => new Uint8Array(Buffer.from(String(u.data.$b64), "base64")));
		return updates.length > 0 ? mergeNoteUpdates(updates).update : noteUpdateFromText(p.versions.at(-1)!.files["README.md"] ?? Object.values(p.versions.at(-1)!.files)[0] ?? "");
	};

	// Custom model providers: one JSON array in `pim_meta`, sealed whole on landing, each with its API key. The id stays the legacy one, so an agent's model reference still names it.
	const ownMeta = meta.find((m) => m.key === "own_providers");
	const ownProviders: { id: string; name?: string; url?: string; key?: string; models?: unknown[]; structuredOutput?: boolean }[] = ownMeta ? parseJson(await secret(ownMeta.value, "own-providers"), []) : [];
	if (ownMeta && ownProviders.length === 0 && !options.crypto) d.skipped.push("custom model providers: not promoted, no keys were given to open them");
	const ownSecrets = new Map<string, string>();
	for (const p of ownProviders) if (p.key) ownSecrets.set(p.id, await sealed(p.key, `provider:${owner}/${p.id}`));

	await asOwner(pool, owner, async (c) => {
		// Agents, and which chat each one answers.
		for (const a of agents) {
			const model = parseJson(a.model, typeof a.model === "string" ? a.model : null);
			const ref = typeof model === "string" ? (model.includes("/") ? { provider: model.split("/")[0], id: model.split("/").slice(1).join("/") } : null) : model;
			const config = { ...(ref ? { model: ref } : {}), fallbacks: parseJson(a.fallbacks, []), skills: parseJson(a.skills, []), apps: parseJson(a.apps, []), contacts: parseJson(a.contacts, []), delegates: [], legacy: { role: a.role ?? null, description: a.description ?? "", isDefault: a.is_default === 1 } };
			const r = await c.query("INSERT INTO pim_app.agents (id, owner_id, name, instructions, config, emoji, color, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", [a.id, owner, a.name, a.instructions ?? "", JSON.stringify(config), a.symbol ?? null, a.color ?? null, ms(a.created_at)]);
			bump(d, "agents", r.rowCount ?? 0);
		}
		for (const s of agentSessions) {
			const chat = chatOf.get(String(s.session));
			if (chat) await c.query("UPDATE pim_app.conversations SET agent_id = $2 WHERE public_chat_id = $1 AND agent_id IS NULL", [chat, s.agent]);
		}
		// Skills with every version; the latest is the skill.
		for (const sk of skills) {
			const versions = skillVersions.filter((v) => v.name === sk.name).sort((a, b) => Number(a.version) - Number(b.version));
			const latest = versions.at(-1);
			if (!latest) continue;
			const filesOf = (v: Record<string, any>) => {
				const out: Record<string, string> = {};
				for (const f of skillFiles.filter((x) => x.name === sk.name && Number(x.version) === Number(v.version))) {
					const text = skillContent.get(`${sk.name}\n${v.version}\n${f.path}`);
					if (text !== undefined) out[f.path] = text;
				}
				return out;
			};
			const lost = skillFiles.filter((x) => x.name === sk.name && Number(x.version) === Number(latest.version)).length - Object.keys(filesOf(latest)).length;
			if (lost > 0) d.skipped.push(`skill ${sk.name}: ${lost} supporting file(s) whose bytes were not given`);
			const id = `sk_legacy_${slug(String(sk.name))}`;
			const inserted = await c.query("INSERT INTO pim_app.skills (id, owner_id, name, description, body, files, version, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", [id, owner, sk.name, latest.description ?? "", latest.instructions ?? "", JSON.stringify(filesOf(latest)), Number(latest.version), ms(sk.created_at)]);
			if (!inserted.rowCount) continue;
			bump(d, "skills");
			for (const v of versions) await c.query("INSERT INTO pim_app.skill_versions (owner_id, skill_id, version, body, files, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [owner, id, Number(v.version), v.instructions ?? "", JSON.stringify(filesOf(v)), ms(v.created_at)]);
		}
		for (const m of memories) {
			const text = String(m.text ?? "");
			const r = await c.query("INSERT INTO pim_app.memories (id, owner_id, scope, title, body, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$6,$7) ON CONFLICT DO NOTHING", [`m_legacy_${m.id}`, owner, m.scope ?? "everyone", text.split("\n")[0]!.slice(0, 80), text, new Date(String(m.date)).toString() === "Invalid Date" ? new Date() : new Date(String(m.date)), m.forgotten === 1 ? new Date() : null]);
			bump(d, "memories", r.rowCount ?? 0);
		}
		for (const g of goals) {
			const status = /done|complete/i.test(String(g.status)) ? "done" : /drop|abandon|cancel/i.test(String(g.status)) ? "dropped" : "active";
			const r = await c.query("INSERT INTO pim_app.goals (id, owner_id, title, status, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [g.id, owner, g.title, status, ms(g.created_at)]);
			if (!r.rowCount) continue;
			bump(d, "goals");
			for (const [i, step] of (parseJson(g.steps, []) as unknown[]).entries()) {
				const st = typeof step === "string" ? { title: step, done: false } : (step as { title?: string; text?: string; done?: boolean; status?: string });
				await c.query("INSERT INTO pim_app.goal_steps (goal_id, owner_id, position, title, done) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [g.id, owner, i, st.title ?? st.text ?? "", st.done === true || st.status === "done"]);
			}
		}
		// Providers and connectors, with their secrets under the application's keys. Without keys they come without credentials, to be connected again.
		for (const p of credentials) {
			const kind = ["anthropic", "openai", "google"].includes(String(p.provider)) ? String(p.provider) : "custom";
			const r = await c.query("INSERT INTO pim_app.providers (id, owner_id, kind, config, secret) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [`pv_legacy_${slug(String(p.provider))}`, owner, kind, JSON.stringify({ name: p.provider }), providerSecrets.get(String(p.provider)) ?? null]);
			bump(d, "providers", r.rowCount ?? 0);
			if (!providerSecrets.has(String(p.provider))) d.skipped.push(`provider ${p.provider}: no credential promoted (${options.crypto ? "its secret could not be opened" : "no keys were given"})`);
		}
		for (const k of connections) {
			const native = ["gmail", "google", "google-drive", "spotify"].includes(String(k.app));
			const credential = connectorSecrets.get(String(k.id)) ?? null;
			const eventSecret = options.crypto ? await sealed(randomBytes(32).toString("base64url"), `connector-events:${owner}/${k.id}`) : null;
			const r = await c.query(
				"INSERT INTO pim_app.connectors (id, owner_id, kind, name, credential, event_key, event_secret, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
				[k.id, owner, native ? "native" : "builtin", k.name ?? k.app, credential, randomBytes(12).toString("base64url"), eventSecret, credential && k.state === "connected" ? "connected" : "auth_required", ms(k.created_at)],
			);
			bump(d, "connectors", r.rowCount ?? 0);
			if (!credential) d.skipped.push(`connector ${k.id} (${k.app}): connected again by its owner`);
		}
		// Triggers. A time trigger is counted from the later of the cutover's skip guard and the activation, so what the cutover missed never fires.
		const activated = options.activatedAt ?? Date.now();
		for (const t of triggers) {
			const rev = revisions.filter((r) => r.trigger_id === t.id).sort((a, b) => Number(b.revision) - Number(a.revision))[0];
			const spec = parseJson(rev?.spec, null);
			if (!spec?.source) continue;
			// A legacy trigger names its chat by the numeric session id; the chat is a UUID here, and a firing addressed to "1" would reach nothing.
			if (spec.originChatId !== undefined) spec.originChatId = chatOf.get(String(spec.originChatId)) ?? spec.originChatId;
			if (spec.destination?.chatId !== undefined) spec.destination = { ...spec.destination, chatId: chatOf.get(String(spec.destination.chatId)) ?? spec.destination.chatId };
			const due = dueWork.get(String(t.id));
			const computer = ["poll", "stream", "process", "file"].includes(spec.source.kind);
			const ended = due && (due.state === "done" || due.state === "dropped");
			const lifecycle = t.lifecycle === "deleted" ? "deleted" : ended ? "ended" : t.lifecycle === "active" || t.lifecycle === "enabled" ? (computer ? "paused" : "enabled") : ["draft", "paused", "ended"].includes(String(t.lifecycle)) ? String(t.lifecycle) : "paused";
			const watermark = spec.source.kind === "time" ? Math.max(Number(due?.skip_before_ms ?? options.cutoverAt), options.cutoverAt, activated) : null;
			const r = await c.query(
				"INSERT INTO pim_app.triggers (id, owner_id, agent_id, source, spec, enabled, lifecycle, title, origin_chat, watermark, enabled_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'legacy',$9,$10,$11) ON CONFLICT DO NOTHING",
				[t.id, owner, spec.owningAgentId ?? null, spec.source.kind, JSON.stringify(spec), lifecycle === "enabled", lifecycle, String(spec.label ?? t.id).slice(0, 120), watermark, lifecycle === "enabled" ? new Date(activated) : null, ms(t.created_at)],
			);
			bump(d, "triggers", r.rowCount ?? 0);
			if (computer) d.skipped.push(`trigger ${t.id}: runs on a computer, so it is paused until it is granted one`);
		}
		// Circles and their members; a member who has not joined the new deployment is left out.
		for (const ci of circles) {
			const mine = members.filter((m) => m.circle_id === ci.id).map((m) => owners.get(String(m.owner_id)) ?? String(m.owner_id));
			const known = new Set((await c.query("SELECT owner_id FROM pim_app.accounts WHERE owner_id = ANY($1)", [mine])).rows.map((r) => r.owner_id));
			for (const m of mine) if (!known.has(m)) d.skipped.push(`circle ${ci.id}: member ${m} has no account here`);
			const r = await c.query("INSERT INTO pim_app.circles (id, owner_id, name, members) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [ci.id, owner, ci.name, mine.filter((m) => known.has(m))]);
			bump(d, "circles", r.rowCount ?? 0);
		}
		for (const l of links) {
			const chat = chatOf.get(String(l.session));
			if (!chat) continue;
			const r = await c.query("INSERT INTO pim_app.shares (id, owner_id, kind, resource_id, audience, link, created_at) VALUES ($1,$2,'chat',$3,'link',$4,$5) ON CONFLICT DO NOTHING", [`sh_legacy_${l.id}`, owner, chat, l.id, ms(l.shared_at)]);
			bump(d, "shares", r.rowCount ?? 0);
		}
		if (profile) {
			const r = await c.query("INSERT INTO pim_app.profiles (owner_id, display_name, bio, published) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING", [owner, profile.display_name ?? "", profile.bio ?? ""]);
			bump(d, "profiles", r.rowCount ?? 0);
		}
		// Custom providers, with their keys sealed under the application's own keys.
		for (const p of ownProviders) {
			const r = await c.query("INSERT INTO pim_app.providers (id, owner_id, kind, config, secret) VALUES ($1,$2,'openai_compatible',$3,$4) ON CONFLICT DO NOTHING", [p.id, owner, JSON.stringify({ name: p.name ?? p.id, url: p.url, models: p.models ?? [], structuredOutput: p.structuredOutput === true }), ownSecrets.get(p.id) ?? null]);
			bump(d, "providers", r.rowCount ?? 0);
		}
		// Apps: every version with its files; notes: the Yjs document as the first update of the log.
		for (const p of plannedApps) {
			const { a, kind, versions } = p;
			if (kind === "note") {
				const r = await c.query("INSERT INTO pim_app.notes (note_id, owner_id, title, version, created_at) VALUES ($1,$2,$3,1,$4) ON CONFLICT DO NOTHING", [a.id, owner, a.title ?? "", ms(a.created_at)]);
				if (!r.rowCount) continue;
				bump(d, "notes");
				await c.query("INSERT INTO pim_app.note_updates (owner_id, note_id, seq, data, origin, fence) VALUES ($1,$2,1,$3,'import',0) ON CONFLICT DO NOTHING", [owner, a.id, Buffer.from(noteBody(p))]);
				continue;
			}
			const r = await c.query("INSERT INTO pim_app.artifacts (id, owner_id, title, kind, latest_version, access, created_at) VALUES ($1,$2,$3,$4,$5,'private',$6) ON CONFLICT DO NOTHING", [a.id, owner, a.title, kind, versions.at(-1)!.v, ms(a.created_at)]);
			if (!r.rowCount) continue;
			bump(d, "apps");
			for (const v of versions) await c.query("INSERT INTO pim_app.artifact_versions (artifact_id, owner_id, version, files, message, created_at) VALUES ($1,$2,$3,$4,'Imported',$5) ON CONFLICT DO NOTHING", [a.id, owner, v.v, JSON.stringify(v.files), ms(v.at)]);
		}
		// Objects: metadata and ACL, under the new owner's key; bytes are copied when the caller can. Vault blobs and skills' content-addressed files are not objects here.
		for (const o of objectRows) {
			if (/\/(vault|skills)\//.test(o.key)) continue;
			const rest = String(o.key).split("/").slice(1).join("/");
			const key = `${owner}/${rest}`;
			const type = String(o.content_type ?? "application/octet-stream");
			const purpose = type.startsWith("image/") ? "image" : /^(video|audio)\//.test(type) ? "media" : o.bucket === "ARTIFACTS" ? "artifact_file" : "file";
			if (options.objects?.put) {
				const bytes = await options.objects.get(o.bucket, o.key);
				if (bytes) await options.objects.put(key, bytes, type);
			}
			const r = await c.query("INSERT INTO pim_app.objects (key, owner_id, purpose, content_type, size, sha256, acl) VALUES ($1,$2,$3,$4,$5,$6,'private') ON CONFLICT DO NOTHING", [key, owner, purpose, type, Number(o.size_bytes), o.sha256]);
			bump(d, "objects", r.rowCount ?? 0);
		}
		// Files kept in the space before files moved to computers (`pim_stored_files`, bytes at `<owner>/files/<id>`): the bytes are objects above; this index keeps their paths, which an object key has no room for.
		if (storedFiles.length > 0) {
			const index = storedFiles.map((f) => ({ path: f.path, key: `${owner}/files/${f.id}`, type: f.type, bytes: Number(f.bytes), updatedAt: Number(f.updated_at) }));
			const r = await c.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1,'legacy_files',$2) ON CONFLICT DO NOTHING", [owner, JSON.stringify(index)]);
			bump(d, "legacyFiles", r.rowCount ? index.length : 0);
		}
		// Settings: only what the person set. A key they never changed stays absent, so the deployment's default still applies to it.
		for (const m of meta.filter((x) => x.key === "settings")) {
			const settings = parseJson(m.value, {}) as Record<string, unknown>;
			for (const [key, value] of Object.entries(settings)) {
				if (value === null || value === undefined) continue;
				const r = await c.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [owner, `settings.${key}`, JSON.stringify(value)]);
				bump(d, "settings", r.rowCount ?? 0);
			}
		}
	});
}

/** Promotes every tenant of the landing; the owners done. Safe to run again: what is already in place is left as it is. */
export async function promoteToLive(pool: Pool, options: PromoteOptions): Promise<PromoteReport> {
	const runtime = new RuntimeDb(pool);
	const owners = (await pool.query("SELECT owner_id FROM pim_ops.tenants WHERE owner_id <> '_deployment' ORDER BY owner_id")).rows.map((r) => r.owner_id as string);
	const report: PromoteReport = { owners: [], chats: 0, messages: 0, forgeThreads: 0, orphanedTasks: 0, clearedRuns: 0, remappedModels: 0, domain: {}, skipped: [] };
	// Every account exists before any space is promoted: a circle names members who may sort after its owner.
	for (const owner of owners) await promoteIdentity(pool, owner, options.rpId);
	for (const owner of owners) {
		const has = (await runtime.read(owner, "SELECT 1 FROM pim_runtime.partitions WHERE owner_id = $1 LIMIT 1", [owner])).rowCount;
		const hasPi = (await pool.query("SELECT 1 FROM pim_ops.pi_conversations WHERE owner_id = $1 LIMIT 1", [owner])).rowCount;
		if (!has && hasPi) {
			const own = await ownProviderIds(pool, owner, options);
			const { space, orphaned, clearedRuns, remappedModels } = await legacySpace(pool, owner, options.cutoverAt, options.defaultAgent, new Set(["anthropic", "openai", "google", "gateway", ...own]));
			report.remappedModels += remappedModels;
			const publicChatIds = new Map((await pool.query("SELECT conversation_id, public_id FROM pim_ops.chats WHERE owner_id = $1", [owner])).rows.map((r) => [Number(r.conversation_id), chatUuid(r.public_id)]));
			await importLegacySpace(runtime, owner, space, { publicChatIds });
			report.orphanedTasks += orphaned;
			report.clearedRuns += clearedRuns;
			const c = await promoteChats(pool, runtime, owner);
			report.chats += c.chats;
			report.messages += c.messages;
		}
		const domain: Domain = { counts: report.domain, skipped: report.skipped };
		await promoteDomain(pool, owner, options, domain);
		report.forgeThreads += await promoteForge(pool, owner);
		report.owners.push(owner);
	}
	return report;
}
