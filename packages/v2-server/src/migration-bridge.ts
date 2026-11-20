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
 *   providers and connectors (secrets re-sealed from the ops envelopes under the application's keys), circles, chat links, profiles, apps with their versions (binary files as
 *   bytes, drawings, diagrams, backend apps with their port) and what belongs to them (data, grants, circles, published address), notes (the Yjs document as the first update),
 *   rooms and their seats, circles' tool permissions and guest activity, the models' cost history, objects' metadata and ACLs, and the settings a person explicitly set.
 *
 * It is idempotent per tenant and runs as the schema owner. **Not promoted** (they remain in `pim_ops.legacy_rows` and the ops ledger, listed in
 * docs/architecture/v2-implementation-status.md): legacy schedules (they are triggers, promoted as such), a bot's snapshot of its agent, the Gitea connection,
 * standing approvals (an admin records those again, deliberately). Coding grants: v1 had none (any member could code), so a person who had coding threads is given one (`promoteCodingGrant`) and everyone else waits for an admin.
 */
import { createHash } from "node:crypto";
import type { ConversationRecord, DocumentRecord, EntryRecord, SubmissionRecord, TaskRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { projectEntries } from "@pim/shared/transcript";
import { binaryValue } from "@pim/v2-app/app-files";
import { appLabel, parseManifest } from "@pim/v2-app/apps";
import type { Bundle, BundleAgent } from "@pim/v2-app/bundles";
import { chatgptContext } from "@pim/v2-app/chatgpt";
import { KeyringCrypto, sealString } from "@pim/v2-app/crypto";
import { mergeNoteUpdates, noteUpdateFromText } from "@pim/v2-app/note-import";
import { OWN_TOOLS } from "@pim/v2-app/tool-permissions";
import { userHandle } from "@pim/v2-app/signin";
import type { EnvelopeCrypto as OpsCrypto } from "@pim/v2-ops/crypto/envelope";
import { applyImmutable, decoder } from "@earendil-works/chord/delta";
import { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { importLegacySpace, type LegacySpace } from "@pim/v2-runtime/splitter";
import { PgPiStorage } from "@pim/v2-runtime/storage";
import type { Pool, PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { openBlob, vaultKey } from "@pim/coding/vault/crypto";
import { digestOf } from "./compat/admin-util.ts";
import { base64UrlDecode } from "@pim/shared/encoding";
import { type CodingVaultKey, HARNESSES } from "@pim/shared/harnesses";
import { ForgeVault } from "@pim/v2-forge/vault";

export type PromoteOptions = {
	/** The relying party id of the new deployment: a passkey works only under the hostname it was made for. */
	rpId: string;
	/** The old deployment's relying party id, when it differs: a promoted passkey stays marked with the host it was made for, which is not this one, so it is never offered here. */
	legacyRpId?: string;
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
	/** The deployment's environment: a native connector's credential is promoted with the provider's token endpoint and the deployment's OAuth client (`GOOGLE_GMAIL_CLIENT_ID`/`_SECRET`, `GOOGLE_DRIVE_*`, `SPOTIFY_*`, `PIM_GOOGLE_TOKEN_URL`, `PIM_SPOTIFY_TOKEN_URL`), so it can be renewed. */
	env?: Record<string, string | undefined>;
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

/**
 * An agent's uploaded icon: v1 kept it as a row of `pim_agent_icons` (agent, type, data); v2 keeps it as a public image object under the owner whose key the agent's
 * `icon_key` names. Written for each agent that exists here and has no icon yet, so it can be run again and never replaces an icon the person has uploaded since.
 * v1 kept no profile picture (a profile is a name and a bio), so there is none to carry.
 */
export async function promoteAgentIcons(pool: Pool, owner: string, put: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>, d: Domain): Promise<void> {
	for (const row of await legacyRows(pool, owner, "pim_agent_icons")) {
		const b64 = row.data && typeof row.data === "object" ? (row.data as { $b64?: unknown }).$b64 : undefined;
		if (typeof b64 !== "string" || typeof row.agent !== "string") continue;
		const bytes = Buffer.from(b64, "base64");
		const type = typeof row.type === "string" && /^image\//.test(row.type) ? row.type : bytes[0] === 0xff ? "image/jpeg" : "image/png";
		const key = `${owner}/agent-icons/${row.agent}`;
		const done = await asOwner(pool, owner, async (c) => {
			if (!(await c.query("SELECT 1 FROM pim_app.agents WHERE id = $1 AND icon_key IS NULL AND deleted_at IS NULL", [row.agent])).rowCount) return false;
			await put(key, bytes, type);
			await c.query("INSERT INTO pim_app.objects (key, owner_id, purpose, content_type, size, sha256, acl) VALUES ($1,$2,'image',$3,$4,$5,'public') ON CONFLICT (key) DO UPDATE SET content_type = $3, size = $4, sha256 = $5, acl = 'public', deleted_at = NULL", [key, owner, type, bytes.length, createHash("sha256").update(bytes).digest("hex")]);
			await c.query("UPDATE pim_app.agents SET icon_key = $2, updated_at = now() WHERE id = $1", [row.agent, key]);
			return true;
		});
		bump(d, "agent icons", done ? 1 : 0);
	}
}

/** Accounts, credentials and tokens. Hashes and public keys only: no secret is ever opened here. */
async function promoteIdentity(pool: Pool, owner: string, rpId: string, legacyRpId?: string): Promise<void> {
	await asOwner(pool, owner, async (c) => {
		const t = (await c.query("SELECT * FROM pim_ops.tenants WHERE owner_id = $1", [owner])).rows[0];
		await c.query(
			"INSERT INTO pim_app.accounts (owner_id, username, role, status, bot, created_at, activated_at, status_reason) VALUES ($1,$2,$3,$4,$8,$5,$6,$7) ON CONFLICT (owner_id) DO NOTHING",
			[owner, t.username, t.role, t.status, ts(t.created_at_ms), ts(t.activated_at_ms), t.status_reason, t.role === "guest"],
		);
		await c.query("INSERT INTO pim_app.usernames (username, owner_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [t.username, owner]);
		for (const k of (await c.query("SELECT * FROM pim_ops.passkeys WHERE owner_id = $1", [owner])).rows) {
			await c.query(
				"INSERT INTO pim_app.passkeys (credential_id, owner_id, user_handle, rp_id, spki, algorithm, name, created_at, last_used_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
				[k.id, owner, userHandle(owner), legacyRpId ?? rpId, k.spki, k.algorithm, k.name, ts(k.created_at_ms), ts(k.last_used_at_ms)],
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
				// A person's own provider keeps its id here, without the old catalog's `own:` prefix.
				if (model.provider.startsWith("own:") && usable.has(model.provider.slice(4))) return { ...rev, content: { ...(rev.content as object), model: { ...model, provider: model.provider.slice(4) } } };
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
	// The setup script a person saved for a repository (v1 kept them in the person's scheduler, by lowercase `owner/name`).
	const scripts = (await pool.query("SELECT row FROM pim_ops.legacy_rows WHERE owner_id = $1 AND table_name = 'pim_coding_repo_settings'", [owner])).rows.map((r) => r.row as Record<string, any>);
	for (const r of scripts) {
		if (typeof r.repo !== "string" || typeof r.setup_script !== "string" || r.setup_script === "" || r.setup_script.length > 65_536) continue;
		await pool.query("INSERT INTO pim_forge.forge_repo_settings (owner_id, repo, setup_script, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [owner, r.repo, r.setup_script, ts(r.updated_at)]);
	}
	// v1 let every member code; v2 asks for a grant. A person who had coding threads keeps coding: they are given what an admin would give (start, steer, abort, and push, pull request and merge with a person's yes), on any repository.
	// Someone who never coded is left for an admin to grant, as is a guest.
	if (rows.length) await promoteCodingGrant(pool, owner);
	return n;
}

/** The coding grant of a person whose v1 space had coding threads: one row in the application and its mirror in Forge, once (a person who has a live grant already keeps theirs). */
async function promoteCodingGrant(pool: Pool, owner: string): Promise<void> {
	const account = (await pool.query("SELECT role FROM pim_app.accounts WHERE owner_id = $1", [owner])).rows[0];
	if (!account || account.role === "guest") return;
	if ((await pool.query("SELECT 1 FROM pim_app.coding_grants WHERE owner_id = $1 AND revoked_at IS NULL", [owner])).rowCount) return;
	const grantId = `cg_${randomUUID().replace(/-/g, "")}`;
	await pool.query("INSERT INTO pim_app.coding_grants (grant_id, owner_id, permissions, pools, repositories, quota, granted_by) VALUES ($1,$2,$3,'{}','{*}','{}',$4)", [grantId, owner, ["coding:start", "coding:steer", "coding:push", "coding:pr", "coding:merge"], "migration"]);
	for (const permission of ["coding:start", "coding:steer", "coding:abort", "coding:push", "coding:pr", "coding:merge"]) {
		await pool.query("INSERT INTO pim_forge.forge_grants (subject_type, subject_id, permission, requires_approval, granted_by, source_grant_id) VALUES ('user',$1,$2,$3,'migration',$4)", [owner, permission, ["coding:push", "coding:pr", "coding:merge"].includes(permission), grantId]);
	}
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

/** What an app with a backend says about how it runs, or nothing when its manifest is not one this Pim reads: the app is promoted all the same. */
function safeManifest(text: string | undefined): object {
	try {
		return parseManifest(text ?? "");
	} catch {
		return {};
	}
}
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
async function promoteDomain(pool: Pool, owner: string, options: PromoteOptions, d: Domain, usable: ReadonlySet<string> = new Set()): Promise<void> {
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
	const memoryScopes = await rows("optmem_scopes");
	const goals = await rows("pim_goals");
	const connections = await rows("pim_app_connections");
	const toolPermissions = await rows("pim_tool_permissions");
	const mcpServers = await rows("pim_mcp_servers");
	const mcpConnections = await rows("cf_agents_mcp_servers");
	const kv = await rows("$kv");
	const credentials = await rows("pim_credentials");
	const triggers = await rows("pim_triggers");
	const revisions = await rows("pim_trigger_revisions");
	const circles = await rows("pim_circles");
	const members = await rows("pim_circle_members");
	const links = await rows("pim_chat_links");
	const artifacts = await rows("pim_artifacts");
	const artifactVersions = await rows("pim_artifact_versions");
	const artifactFiles = await rows("pim_artifact_files");
	const artifactData = await rows("pim_artifact_data");
	const artifactGrants = await rows("pim_artifact_grants");
	const artifactCircles = await rows("pim_artifact_circles");
	const hostedApps = await rows("pim_hosted_apps");
	const guestActivity = await rows("pim_guest_activity");
	const rooms = await rows("pim_rooms");
	const roomSeats = await rows("pim_room_seats");
	const modelCalls = await rows("pim_model_calls");
	const usageDaily = await rows("pim_usage_daily");
	const publishedApps = (await legacyRows(pool, "_deployment", "published_artifacts")).filter((r) => String(r.owner_id) === legacyId);
	const deploymentBots = (await legacyRows(pool, "_deployment", "bots")) as Record<string, any>[];
	const notifications = await rows("pim_notifications");
	const noteUpdates = await rows("pim_note_updates");
	const storedFiles = await rows("pim_stored_files");
	const agentSessions = await rows("pim_agent_sessions");
	const meta = await rows("pim_meta");
	const profile = (await pool.query("SELECT row FROM pim_ops.legacy_rows WHERE table_name = 'profiles' AND row->>'owner_id' = ANY($1)", [[legacyId ?? "", owner]])).rows[0]?.row as Record<string, any> | undefined;
	const dueWork = new Map((await pool.query("SELECT key, state, skip_before_ms FROM pim_ops.due_work WHERE owner_id = $1 AND kind LIKE 'trigger:%'", [owner])).rows.map((r) => [r.key as string, r]));
	const objectRows = (await pool.query("SELECT bucket, key, size_bytes, sha256, content_type FROM pim_ops.objects WHERE owner_id = $1", [owner])).rows;

	// Sealed values are made first: they need no transaction.
	const providerSecrets = new Map<string, string>();
	// A ChatGPT sign-in is the `openai` credential in its OAuth form: it moves to the ChatGPT store, sealed again as it is, so nobody signs in again after the cutover.
	let chatgpt: { sealed: string; email: string | null } | undefined;
	for (const c of credentials) {
		const plain = await secret(c.credential, "provider-credential");
		const oauth = plain ? (parseJson(plain, {}) as { type?: string; access?: string; refresh?: string; email?: string | null }) : undefined;
		if (c.provider === "openai" && oauth?.type === "oauth" && oauth.access && oauth.refresh) {
			chatgpt = { sealed: await sealed(JSON.stringify(oauth), chatgptContext(owner)), email: oauth.email ?? null };
			continue;
		}
		const key = plain ? (parseJson(plain, {}) as { apiKey?: string }).apiKey : undefined;
		if (key) providerSecrets.set(String(c.provider), await sealed(key, `provider:${owner}/pv_legacy_${slug(String(c.provider))}`));
	}
	// A native connector's sign-in (Gmail, Drive, Spotify) `{accessToken, refreshToken, expiresAt, scope, files?}` becomes the bundle v2's native connectors keep
	// (`{access_token, refresh_token, expires_at, token_endpoint, client_id, client_secret, scope, files?}`), with the provider's token endpoint and the deployment's client,
	// sealed under `connector:<owner>/<id>`. Without the client in the environment the tokens still work until they expire, and the report says so.
	const env = options.env ?? {};
	const NATIVE: Record<string, { ref: string; token: string; id?: string; secret?: string }> = {
		gmail: { ref: "google/gmail", token: env.PIM_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token", ...(env.GOOGLE_GMAIL_CLIENT_ID ? { id: env.GOOGLE_GMAIL_CLIENT_ID } : {}), ...(env.GOOGLE_GMAIL_CLIENT_SECRET ? { secret: env.GOOGLE_GMAIL_CLIENT_SECRET } : {}) },
		"google-drive": { ref: "google/drive", token: env.PIM_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token", ...(env.GOOGLE_DRIVE_CLIENT_ID ? { id: env.GOOGLE_DRIVE_CLIENT_ID } : {}), ...(env.GOOGLE_DRIVE_CLIENT_SECRET ? { secret: env.GOOGLE_DRIVE_CLIENT_SECRET } : {}) },
		spotify: { ref: "spotify/spotify", token: env.PIM_SPOTIFY_TOKEN_URL ?? "https://accounts.spotify.com/api/token", ...(env.SPOTIFY_CLIENT_ID ? { id: env.SPOTIFY_CLIENT_ID } : {}), ...(env.SPOTIFY_CLIENT_SECRET ? { secret: env.SPOTIFY_CLIENT_SECRET } : {}) },
	};
	const nativeSecrets = new Map<string, string>();
	for (const k of connections) {
		const def = NATIVE[String(k.app)];
		const plain = def ? await secret(k.credential, "connector-credential") : null;
		const v1 = plain ? (parseJson(plain, null) as { accessToken?: string; refreshToken?: string; expiresAt?: number; scope?: string; files?: unknown } | null) : null;
		if (!def || !v1?.accessToken) continue;
		const bundle = { access_token: v1.accessToken, ...(v1.refreshToken ? { refresh_token: v1.refreshToken } : {}), ...(v1.expiresAt ? { expires_at: v1.expiresAt } : {}), token_endpoint: def.token, ...(def.id ? { client_id: def.id } : {}), ...(def.secret ? { client_secret: def.secret } : {}), ...(v1.scope ? { scope: v1.scope } : {}), ...(v1.files ? { files: v1.files } : {}) };
		nativeSecrets.set(String(k.id), await sealed(JSON.stringify(bundle), `connector:${owner}/${k.id}`));
	}
	// A connected MCP server (the `agents` library's `cf_agents_mcp_servers`, with its OAuth tokens in the space's key-value store) has one: the Runner's connector tools.
	// The tokens' key is `/<client name>/<server id>/<client id>/token`, the registered client's `.../client_info/`; the sign-in's discovery state is dropped once tokens are saved, so
	// the token endpoint a refresh needs is found again from the server's address when the Runner first has to refresh.
	const mcpSecrets = new Map<string, string>();
	const mcpKv = (server: string, leaf: string) => kv.find((e) => typeof e.key === "string" && e.key.startsWith("/") && e.key.split("/")[2] === server && new RegExp(`^/[^/]+/[^/]+/[^/]+/${leaf}/?$`).test(e.key));
	for (const m of mcpConnections) {
		const token = parseJson(await secret(mcpKv(String(m.id), "token")?.value, "kv"), null) as { access_token?: string; refresh_token?: string } | null;
		const info = parseJson(await secret(mcpKv(String(m.id), "client_info")?.value, "kv"), null) as { client_id?: string; client_secret?: string } | null;
		if (!token?.access_token) continue;
		const bundle = { access_token: token.access_token, ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}), ...(info?.client_id ?? m.client_id ? { client_id: info?.client_id ?? m.client_id } : {}), ...(info?.client_secret ? { client_secret: info.client_secret } : {}) };
		mcpSecrets.set(String(m.id), await sealed(JSON.stringify(bundle), `connector:${owner}/${m.id}`));
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
	const MAIN = { html: "index.html", jsx: "App.jsx", markdown: "README.md", svg: "image.svg", mermaid: "diagram.mmd", hosted: "pim.app.json" } as const;
	type PlannedApp = { a: Record<string, any>; kind: "html" | "jsx" | "svg" | "mermaid" | "backend" | "note"; versions: { v: number; files: Record<string, string>; at: unknown; sha256: string | null }[] };
	const plannedApps: PlannedApp[] = [];
	for (const a of artifacts) {
		const kind = a.kind === "jsx" ? "jsx" : a.kind === "hosted" ? "backend" : a.kind === "html" || a.kind === "app" ? "html" : a.kind === "svg" ? "svg" : a.kind === "mermaid" ? "mermaid" : a.kind === "markdown" ? "note" : null;
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
				// A file that is not text (a picture, a dataset) is kept in the version as its bytes, as v2's apps keep them.
				try {
					files[String(f.path)] = decoder.decode(bytes);
				} catch {
					files[String(f.path)] = binaryValue(bytes);
				}
			}
			// A version from before files were kept apart holds its main file in the row.
			if (Object.keys(files).length === 0 && typeof v.content === "string" && v.content !== "") files[MAIN[kind === "note" ? "markdown" : kind === "backend" ? "hosted" : kind]] = v.content;
			versions.push({ v: Number(v.version), files, at: v.created_at, sha256: typeof v.sha256 === "string" ? v.sha256 : null });
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
	const ownProviders: { id: string; name?: string; url?: string; key?: string; models?: unknown[]; structuredOutput?: boolean; api?: string }[] = ownMeta ? parseJson(await secret(ownMeta.value, "own-providers"), []) : [];
	if (ownMeta && ownProviders.length === 0 && !options.crypto) d.skipped.push("custom model providers: not promoted, no keys were given to open them");
	const ownSecrets = new Map<string, string>();
	for (const p of ownProviders) if (p.key) ownSecrets.set(p.id, await sealed(p.key, `provider:${owner}/${p.id}`));

	await asOwner(pool, owner, async (c) => {
		// Agents, and which chat each one answers.
		for (const a of agents) {
			const model = parseJson(a.model, typeof a.model === "string" ? a.model : null);
			const named = typeof model === "string" ? (model.includes("/") ? { provider: model.split("/")[0], id: model.split("/").slice(1).join("/") } : null) : model;
			// The same as a chat's `pi.agent` above: a model of a provider this deployment lacks names the default instead, since a Runner chooses each turn's model from the agent's.
			const ref = named?.provider && !usable.has(named.provider) && !(named.provider.startsWith("own:") && usable.has(named.provider.slice(4))) && options.defaultAgent ? { provider: options.defaultAgent.provider, id: options.defaultAgent.modelId } : named?.provider?.startsWith("own:") && usable.has(named.provider.slice(4)) ? { ...named, provider: named.provider.slice(4) } : named;
			const config = { ...(ref ? { model: ref } : {}), fallbacks: parseJson(a.fallbacks, []), skills: parseJson(a.skills, []), apps: parseJson(a.apps, []), contacts: parseJson(a.contacts, []), delegates: [], ...(a.memory_scope ? { memoryScope: String(a.memory_scope) } : {}), memoryScopes: parseJson(a.memory_scopes, []), legacy: { role: a.role ?? null, description: a.description ?? "", isDefault: a.is_default === 1 } };
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
		// The scopes the person named, which agents read through `memoryScopes` in their config. An agent's own scope is `memoryScope` (the majordomo's is `private`).
		for (const sc of memoryScopes) {
			const r = await c.query("INSERT INTO pim_app.memory_scopes (owner_id, key, name, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [owner, sc.key, sc.name, ms(sc.created_at)]);
			bump(d, "memory scopes", r.rowCount ?? 0);
		}
		for (const m of memories) {
			const text = String(m.text ?? "");
			const r = await c.query("INSERT INTO pim_app.memories (id, owner_id, scope, title, body, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$6,$7) ON CONFLICT DO NOTHING", [`m_legacy_${m.id}`, owner, m.scope ?? "everyone", text.split("\n")[0]!.slice(0, 80), text, new Date(String(m.date)).toString() === "Invalid Date" ? new Date() : new Date(String(m.date)), m.forgotten === 1 ? new Date() : null]);
			bump(d, "memories", r.rowCount ?? 0);
		}
		for (const g of goals) {
			const status = /done|complete/i.test(String(g.status)) ? "done" : /drop|abandon|cancel/i.test(String(g.status)) ? "dropped" : /paus/i.test(String(g.status)) ? "paused" : "active";
			// The progress notes the agent kept, each with when it was written.
			const notes = (parseJson(g.notes, []) as { at?: unknown; text?: unknown }[]).flatMap((n) => (typeof n?.text === "string" ? [{ at: Number(n.at) || Date.now(), text: n.text }] : []));
			const r = await c.query("INSERT INTO pim_app.goals (id, owner_id, title, status, notes, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [g.id, owner, g.title, status, JSON.stringify(notes), ms(g.created_at)]);
			if (!r.rowCount) continue;
			bump(d, "goals");
			for (const [i, step] of (parseJson(g.steps, []) as unknown[]).entries()) {
				const st = typeof step === "string" ? { title: step, done: false } : (step as { title?: string; text?: string; done?: boolean; status?: string });
				await c.query("INSERT INTO pim_app.goal_steps (goal_id, owner_id, position, title, done) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [g.id, owner, i, st.title ?? st.text ?? "", st.done === true || st.status === "done"]);
			}
		}
		// Providers and connectors, with their secrets under the application's keys. Without keys they come without credentials, to be connected again.
		if (chatgpt) {
			const hostId = meta.find((x) => x.key === "chatgpt_host_id")?.value;
			const r = await c.query("INSERT INTO pim_app.chatgpt_credentials (owner_id, host_id, secret, email, version) VALUES ($1,$2,$3,$4,1) ON CONFLICT DO NOTHING", [owner, typeof hostId === "string" && hostId ? parseJson(hostId, hostId) : `urn:uuid:${randomUUID()}`, chatgpt.sealed, chatgpt.email]);
			bump(d, "chatgpt", r.rowCount ?? 0);
		}
		// `chatgpt-images` is the ChatGPT image sign-in, not a model provider: it has no endpoint or models to promote.
		for (const p of credentials.filter((x) => x.provider !== "chatgpt-images" && !(chatgpt && x.provider === "openai" && !providerSecrets.has("openai")))) {
			const kind = ["anthropic", "openai", "google"].includes(String(p.provider)) ? String(p.provider) : "custom";
			const r = await c.query("INSERT INTO pim_app.providers (id, owner_id, kind, config, secret) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [`pv_legacy_${slug(String(p.provider))}`, owner, kind, JSON.stringify({ name: p.provider }), providerSecrets.get(String(p.provider)) ?? null]);
			bump(d, "providers", r.rowCount ?? 0);
			if (!providerSecrets.has(String(p.provider))) d.skipped.push(`provider ${p.provider}: no credential promoted (${options.crypto ? "its secret could not be opened" : "no keys were given"})`);
		}
		for (const k of connections) {
			const def = NATIVE[String(k.app)];
			const credential = nativeSecrets.get(String(k.id)) ?? null;
			const eventSecret = options.crypto ? await sealed(randomBytes(32).toString("base64url"), `connector-events:${owner}/${k.id}`) : null;
			const r = await c.query(
				"INSERT INTO pim_app.connectors (id, owner_id, kind, name, app_ref, credential, event_key, event_secret, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
				[k.id, owner, def ? "native" : "builtin", k.name ?? k.app, def?.ref ?? null, credential, randomBytes(12).toString("base64url"), eventSecret, credential ? "connected" : "auth_required", ms(k.created_at)],
			);
			bump(d, "connectors", r.rowCount ?? 0);
			if (!credential) d.skipped.push(`connector ${k.id} (${k.app}): connected again by its owner (${def ? "it held no credential that could be opened" : "this deployment has no connector for it"}); any sign-in stays sealed in the landing`);
			else if (!def!.id) d.skipped.push(`connector ${k.id} (${k.app}): promoted with its tokens, but this deployment's environment has no OAuth client for it, so it cannot be renewed once its access token expires`);
		}
		// Connected MCP servers: the server's address and, when the person had signed in, its tokens sealed under the application's keys. The server's tools are discovered again and
		// switched on by the person (the old Pim did not keep the list), except the choices carried below.
		for (const m of mcpConnections) {
			const credential = mcpSecrets.get(String(m.id)) ?? null;
			const eventSecret = options.crypto ? await sealed(randomBytes(32).toString("base64url"), `connector-events:${owner}/${m.id}`) : null;
			const r = await c.query(
				"INSERT INTO pim_app.connectors (id, owner_id, kind, name, url, credential, event_key, event_secret, status) VALUES ($1,$2,'custom_mcp',$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
				[m.id, owner, m.name ?? m.id, m.server_url, credential, randomBytes(12).toString("base64url"), eventSecret, credential ? "connected" : "auth_required"],
			);
			bump(d, "mcp connections", r.rowCount ?? 0);
			if (!credential) d.skipped.push(`MCP server ${m.id}: signed in again by its owner (${options.crypto ? "it held no tokens" : "no keys were given"})`);
			else d.skipped.push(`MCP server ${m.id}: its tools are not switched on until its owner enables them (the old Pim did not keep the list)`);
		}
		// What the person chose for each connector tool (Off, Ask, On), and each connector's approval policy, for themselves, for each agent, and for each circle (the audience `circle:<id>`).
				for (const m of mcpServers) {
			if (["writes", "all", "none"].includes(String(m.approval))) await c.query("UPDATE pim_app.connectors SET approval = $2 WHERE id = $1", [m.id, m.approval]);
		}
		for (const t of toolPermissions) {
			const circle = circles.find((ci) => ci.id === t.audience);
			const audience = t.audience === "" ? "owner" : String(t.audience).startsWith("agent:") ? String(t.audience) : circle ? `circle:${circle.id}` : null;
			// What the person chose for one of Pim's own tools, or an agent's switch for skills, carries over as it was; a tool that always needs their own decision was never On.
			const own = !t.app && ["off", "ask", "on"].includes(String(t.permission)) ? (audience === "owner" ? OWN_TOOLS.find((o) => o.tool === t.tool) : audience?.startsWith("agent:") && t.tool === "write_skill" ? { tool: "write_skill" } : undefined) : undefined;
			if (own) {
				const choice = "explicit" in own && own.explicit && t.permission === "on" ? "ask" : audience === "owner" ? t.permission : t.permission === "off" ? "off" : "on";
				const r = await c.query("INSERT INTO pim_app.tool_permissions (owner_id, audience, app, tool, permission) VALUES ($1,$2,'',$3,$4) ON CONFLICT DO NOTHING", [owner, audience, own.tool, choice]);
				bump(d, "tool permissions", r.rowCount ?? 0);
				continue;
			}
			if (!audience || !t.app || !["off", "ask", "on"].includes(String(t.permission))) {
				d.skipped.push(`tool permission ${t.audience || "owner"}/${t.app || "pim"}/${t.tool}: ${audience && t.app ? "unknown choice" : t.app ? "its audience is neither the owner, an agent nor a circle" : "that tool of Pim's has no switch here"}`);
				continue;
			}
			// An agent's switch is on or off; asking meant off there.
			const permission = audience === "owner" || audience.startsWith("circle:") ? t.permission : t.permission === "on" ? "on" : "off";
			const r = await c.query("INSERT INTO pim_app.tool_permissions (owner_id, audience, app, tool, permission) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [owner, audience, t.app, t.tool, permission]);
			bump(d, "tool permissions", r.rowCount ?? 0);
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
			const r = await c.query("INSERT INTO pim_app.circles (id, owner_id, name, members, memory_scopes, enabled) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [ci.id, owner, ci.name, mine.filter((m) => known.has(m)), parseJson(ci.memory_scopes, []), ci.enabled === 0 ? false : true]);
			bump(d, "circles", r.rowCount ?? 0);
		}
		// A group chat is its host chat (with how its agents take turns) and a seat for each other agent, which is a chat of its own that sits in the room.
		for (const room of rooms) {
			const host = chatOf.get(String(room.session));
			if (!host) {
				d.skipped.push(`room ${room.session}: its chat was not promoted`);
				continue;
			}
			await c.query("UPDATE pim_app.conversations SET room_mode = $2, kind = CASE WHEN kind = 'normal' THEN 'group' ELSE kind END WHERE public_chat_id = $1", [host, room.mode === "open" ? "open" : "mentions"]);
			for (const seat of roomSeats.filter((x) => String(x.room) === String(room.session))) {
				const seatChat = chatOf.get(String(seat.conversation)) ?? null;
				const known = (await c.query("SELECT 1 FROM pim_app.agents WHERE id = $1", [String(seat.agent)])).rowCount;
				if (!known) {
					d.skipped.push(`room ${room.session}: its seat for agent ${seat.agent} has no agent here`);
					continue;
				}
				const r = await c.query("INSERT INTO pim_app.room_members (public_chat_id, owner_id, member, role, seat_chat_id) VALUES ($1,$2,$3,'agent',$4) ON CONFLICT DO NOTHING", [host, owner, String(seat.agent), seatChat]);
				if (seatChat) await c.query("UPDATE pim_app.conversations SET room_of = $2 WHERE public_chat_id = $1 AND room_of IS NULL", [seatChat, host]);
				bump(d, "room seats", r.rowCount ?? 0);
			}
			bump(d, "rooms");
		}
		// What the person's models cost them: each call the old Pim still had, and for the days before those, its daily totals as one entry each (a day's number of calls is lost, its tokens and cost are not).
		const firstCall = modelCalls.reduce((least, x) => Math.min(least, Number(x.ts)), Number.POSITIVE_INFINITY);
		const kindOf = (kind: unknown, thread: unknown) => (thread ? "coding_thread" : kind === "chat" || kind === null || kind === undefined ? "chat" : "background");
		for (const x of modelCalls) {
			const r = await c.query("INSERT INTO pim_app.model_calls (id, owner_id, run_kind, public_chat_id, provider, model, input_tokens, output_tokens, cost_microusd, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING", [`legacy-${x.id}`, owner, kindOf(x.run_kind, x.coding_thread_id), chatOf.get(String(x.chat_id)) ?? null, String(x.provider), String(x.model), Number(x.input ?? 0) + Number(x.cache_read ?? 0) + Number(x.cache_write_5m ?? 0) + Number(x.cache_write_1h ?? 0), Number(x.output ?? 0), Math.round(Number(x.cost_usd ?? 0) * 1_000_000), ms(x.ts)]);
			bump(d, "model calls", r.rowCount ?? 0);
		}
		let daily = 0;
		for (const x of usageDaily) {
			const at = Date.parse(`${x.day}T12:00:00Z`);
			if (!(at < firstCall)) continue;
			const r = await c.query("INSERT INTO pim_app.model_calls (id, owner_id, run_kind, public_chat_id, provider, model, input_tokens, output_tokens, cost_microusd, at) VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING", [`legacy-day-${x.day}-${daily++}`, owner, kindOf(x.run_kind, null), chatOf.get(String(x.chat_id)) ?? null, String(x.model), Number(x.input ?? 0) + Number(x.cache_read ?? 0) + Number(x.cache_write_5m ?? 0) + Number(x.cache_write_1h ?? 0), Number(x.output ?? 0), Math.round(Number(x.cost_usd ?? 0) * 1_000_000), new Date(at)]);
			bump(d, "usage days", r.rowCount ?? 0);
		}
		// What guests of those circles did with the person's tools, newest last as it was kept.
		for (const g of guestActivity) {
			const guest = (await c.query("SELECT owner_id FROM pim_app.accounts WHERE username = $1", [String(g.username)])).rows[0]?.owner_id as string | undefined;
			const outcome = ["ran", "asked", "refused"].includes(String(g.outcome)) ? String(g.outcome) : "refused";
			const r = await c.query("INSERT INTO pim_app.guest_activity (owner_id, at, guest, username, audience, tool, outcome, summary) SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE NOT EXISTS (SELECT 1 FROM pim_app.guest_activity WHERE owner_id = $1 AND at = $2 AND username = $4 AND tool = $6 AND summary = $8)", [owner, ms(g.at), guest ?? String(g.username), String(g.username), `circle:${g.circle_id}`, String(g.tool), outcome, String(g.summary ?? "")]);
			bump(d, "guest activity", r.rowCount ?? 0);
		}
		for (const l of links) {
			const chat = chatOf.get(String(l.session));
			if (!chat) continue;
			const r = await c.query("INSERT INTO pim_app.shares (id, owner_id, kind, resource_id, audience, link, created_at) VALUES ($1,$2,'chat',$3,'link',$4,$5) ON CONFLICT DO NOTHING", [`sh_legacy_${l.id}`, owner, chat, l.id, ms(l.shared_at)]);
			bump(d, "shares", r.rowCount ?? 0);
		}
		// A guest of a bot the admin shared: which bot, whose it is and which agent is their copy of it (v1 kept it in the guest's space and on the Directory's account; here it is one row).
		for (const m of meta.filter((x) => x.key === "guest_bot")) {
			const joined = parseJson(m.value, null) as { bot?: string; agent?: string; owner?: string; sharedAt?: number } | null;
			if (!joined?.bot || !joined.agent) continue;
			const hostLegacy = joined.owner ?? deploymentBots.find((b) => String(b.id) === joined.bot)?.owner_id;
			const host = hostLegacy ? owners.get(String(hostLegacy)) : undefined;
			if (!host) {
				d.skipped.push(`guest of bot ${joined.bot}: its host has no account here`);
				continue;
			}
			const r = await c.query("INSERT INTO pim_app.guest_bots (owner_id, bot_id, host_owner, agent_id, shared_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner_id) DO NOTHING", [owner, joined.bot, host, joined.agent, ms(joined.sharedAt)]);
			bump(d, "guest bots", r.rowCount ?? 0);
		}
		// The bell's list: what the person had not read stays unread.
		for (const n of notifications) {
			const r = await c.query("INSERT INTO pim_app.notifications (id, owner_id, kind, public_chat_id, title, body, created_at, read_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", [`legacy-${n.id}`, owner, ["general", "mention", "scheduled"].includes(String(n.kind)) ? n.kind : "general", chatOf.get(String(n.session)) ?? null, String(n.title ?? ""), String(n.body ?? ""), ms(n.created_at), n.read_at ? ms(n.read_at) : null]);
			bump(d, "notifications", r.rowCount ?? 0);
		}
		if (profile) {
			const r = await c.query("INSERT INTO pim_app.profiles (owner_id, display_name, bio, published) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING", [owner, profile.display_name ?? "", profile.bio ?? ""]);
			bump(d, "profiles", r.rowCount ?? 0);
		}
		// Custom providers, with their keys sealed under the application's own keys.
		for (const p of ownProviders) {
			const r = await c.query("INSERT INTO pim_app.providers (id, owner_id, kind, config, secret) VALUES ($1,$2,'openai_compatible',$3,$4) ON CONFLICT DO NOTHING", [p.id, owner, JSON.stringify({ name: p.name ?? p.id, url: p.url, models: p.models ?? [], structuredOutput: p.structuredOutput === true, ...(p.api === "anthropic-messages" ? { api: p.api } : {}) }), ownSecrets.get(p.id) ?? null]);
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
			// Who may open it: the circles it was shared with, or what a backend app was last run with. An app with a backend keeps its port and the version run last, which is
			// still running on the person's computer, so it answers at once after the cutover.
			const circlesOf = artifactCircles.filter((x) => x.artifact === a.id).map((x) => String(x.circle));
			const hosted = hostedApps.find((x) => x.artifact === a.id);
			const access = kind === "backend" && hosted ? (hosted.access === "public" ? "public" : hosted.access === "circles" ? "shared" : "private") : circlesOf.length > 0 ? "shared" : "private";
			const r = await c.query("INSERT INTO pim_app.artifacts (id, owner_id, title, kind, latest_version, access, circles, label, backend_port, backend_version, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING", [a.id, owner, a.title, kind, versions.at(-1)!.v, access, access === "shared" ? circlesOf : [], kind === "backend" ? appLabel(owner, a.id) : null, kind === "backend" && hosted ? Number(hosted.port) : null, kind === "backend" && hosted ? Number(hosted.version) : null, ms(a.created_at), ms(a.updated_at ?? a.created_at)]);
			if (!r.rowCount) continue;
			bump(d, "apps");
			for (const v of versions) await c.query("INSERT INTO pim_app.artifact_versions (artifact_id, owner_id, version, files, message, manifest, created_at) VALUES ($1,$2,$3,$4,'Imported',$5,$6) ON CONFLICT DO NOTHING", [a.id, owner, v.v, JSON.stringify(v.files), JSON.stringify(kind === "backend" ? safeManifest(v.files["pim.app.json"]) : {}), ms(v.at)]);
			// What the app kept through the bridge (`window.pim.storage` and `.shared`), and what the person let each version use: a grant is for a version's digest, which here is the digest of its files.
			for (const x of artifactData.filter((x) => x.artifact === a.id)) {
				const k = await c.query("INSERT INTO pim_app.app_data (owner_id, app_key, scope, key, value, size, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [owner, a.id, x.scope === "shared" ? "shared" : "own", x.key, x.value, Number(x.size), ms(x.updated_at)]);
				bump(d, "app data", k.rowCount ?? 0);
			}
			for (const x of artifactGrants.filter((x) => x.artifact === a.id)) {
				const version = versions.find((v) => v.sha256 === x.sha256);
				if (!version) continue;
				const k = await c.query("INSERT INTO pim_app.app_grants (owner_id, app_key, sha256, capability, granted_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [owner, a.id, digestOf(version.files), x.capability, ms(x.granted_at)]);
				bump(d, "app grants", k.rowCount ?? 0);
			}
		}
		// What the person published: the gallery's entry keeps its id (its public link works as before) and points at the version that was published.
		for (const x of publishedApps) {
			const app = plannedApps.find((p) => p.a.id === x.artifact_id);
			if (!app || app.kind === "note" || app.kind === "backend" || !app.versions.some((v) => v.v === Number(x.version))) {
				d.skipped.push(`published app ${x.id}: its app ${x.artifact_id} (version ${x.version}) was not promoted`);
				continue;
			}
			const k = await c.query("INSERT INTO pim_app.published_artifacts (public_id, owner_id, artifact_id, version, public, published_at, uses) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [x.id, owner, x.artifact_id, Number(x.version), Number(x.public) === 1, ms(x.published_at), Number(x.uses ?? 0)]);
			bump(d, "published apps", k.rowCount ?? 0);
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
		// The models the person chose in Settings: the default, the fallbacks in order, and the utility model. Without them a chat with no agent of its own
		// would run on whatever the catalog lists first. A model of the person's own provider loses v1's `own:` prefix.
		const chosen = (m: any) => (m && typeof m.provider === "string" && typeof m.id === "string" ? { provider: m.provider.replace(/^own:/, ""), id: m.id } : null);
		for (const [legacy, key] of [["model", "model"], ["utility_model", "model_utility"], ["model_fallbacks", "model_fallbacks"]] as const) {
			const row = meta.find((x) => x.key === legacy);
			if (!row) continue;
			const parsed = parseJson(row.value, null);
			const value = legacy === "model_fallbacks" ? (Array.isArray(parsed) ? parsed.map(chosen).filter((m) => m !== null) : null) : chosen(parsed);
			if (!value) continue;
			const r = await c.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [owner, key, JSON.stringify(value)]);
			bump(d, "settings", r.rowCount ?? 0);
		}
	});
}


type SharedProvider = { id: string; row: Record<string, any>; provider: { name?: string; url?: string; key?: string | null; models?: unknown[]; builtin?: string; api?: string; structuredOutput?: boolean } | null; runnable: boolean };

/** The providers the admin shared with everyone, opened: `runnable` ones are what this deployment's Runner can call (an OpenAI-compatible endpoint with an address). */
async function sharedProviders(pool: Pool, options: PromoteOptions): Promise<SharedProvider[]> {
	const out: SharedProvider[] = [];
	for (const row of await legacyRows(pool, "_deployment", "providers")) {
		const cell = row.provider as { $secret?: string } | undefined;
		const found = cell?.$secret && options.crypto ? (await pool.query("SELECT envelope FROM pim_ops.secret_envelopes WHERE owner_id = '_deployment' AND name = $1", [cell.$secret])).rows[0] : undefined;
		const provider = found ? (parseJson(options.crypto!.ops.open(found.envelope, ["_deployment", cell!.$secret!, "model-provider"]).toString(), null) as SharedProvider["provider"]) : null;
		out.push({ id: String(row.id), row, provider, runnable: provider !== null && !provider.builtin && !provider.api && typeof provider.url === "string" });
	}
	return out;
}

type LegacyBundled = { name?: string; role?: string; description?: string; instructions?: string; apps?: string[]; symbol?: string | null; color?: string | null; contacts?: string[] };

/**
 * What a v1 template, bot or default agent carried, as a v2 bundle: the agent with its role, description, connectors, look and contacts, the agents that came with it (the
 * newer `bundle`, or the older `team` of name and instructions), and every uploaded icon as a public image object under the author (`<owner>/bundle-icons/<holder>/<position>`,
 * position -1 being the agent's own). Without somewhere to put the bytes the icons are left in the landing and said so.
 */
async function legacyBundle(pool: Pool, owner: string, holder: string, row: Record<string, any>, put: PromoteOptions["objects"], d: Domain): Promise<Bundle> {
	const apps = parseJson(row.apps, []) as string[];
	const team = parseJson(row.team, []) as { name: string; instructions: string }[];
	const others: BundleAgent[] = team.length > 0
		? team.map((m) => ({ name: m.name, role: m.name, description: (m.instructions.trim().split(/\r?\n/)[0] ?? "").slice(0, 280), instructions: m.instructions, apps, emoji: null, color: row.color ?? null, contacts: [], icon: null }))
		: (parseJson(row.bundle, []) as LegacyBundled[]).map((a) => ({ name: String(a.name ?? ""), role: a.role ?? String(a.name ?? ""), description: a.description ?? "", instructions: a.instructions ?? "", apps: a.apps ?? [], emoji: a.symbol ?? null, color: a.color ?? null, contacts: a.contacts ?? [], icon: null }));
	const contacts = team.length > 0 ? team.map((m) => m.name) : (parseJson(row.contacts, []) as string[]);
	const keep = async (position: number, cell: unknown, type: unknown): Promise<string | null> => {
		const b64 = cell && typeof cell === "object" ? (cell as { $b64?: unknown }).$b64 : undefined;
		if (typeof b64 !== "string") return null;
		if (!put?.put) {
			d.skipped.push(`${holder}: an uploaded icon was not carried, no object store was given`);
			return null;
		}
		const bytes = Buffer.from(b64, "base64");
		const contentType = typeof type === "string" && /^image\//.test(type) ? type : bytes[0] === 0xff ? "image/jpeg" : "image/png";
		const key = `${owner}/bundle-icons/${holder}/${position}`;
		await put.put(key, bytes, contentType);
		await asOwner(pool, owner, (c) => c.query("INSERT INTO pim_app.objects (key, owner_id, purpose, content_type, size, sha256, acl) VALUES ($1,$2,'image',$3,$4,$5,'public') ON CONFLICT (key) DO UPDATE SET content_type = $3, size = $4, sha256 = $5, acl = 'public', deleted_at = NULL", [key, owner, contentType, bytes.length, createHash("sha256").update(bytes).digest("hex")]));
		return key;
	};
	const icon = await keep(-1, row.icon_data, row.icon_type);
	for (const r of await legacyRows(pool, "_deployment", "bundle_icons")) {
		const position = Number(r.position);
		if (String(r.holder) !== holder || !others[position]) continue;
		const key = await keep(position, r.data, r.type);
		if (key) others[position] = { ...others[position]!, icon: key };
	}
	const agent: BundleAgent = { name: String(row.name), role: String(row.role ?? row.name), description: row.description ?? "", instructions: row.instructions ?? "", apps, emoji: row.symbol ?? null, color: row.color ?? null, contacts, icon };
	return { agent, description: agent.description, apps, ...(icon ? { icon } : {}), ...(others.length > 0 ? { bundle: others } : {}) };
}

/**
 * What the old Pim's Gallery kept for the deployment: the providers its admin shared with everyone (the deployment's own here, with their keys sealed for the deployment, not
 * for any person), the templates people published, the bots the admin shared, and the agent everyone starts with. A template, bot or default agent whose author has no account here is
 * left in the landing and said so; so is a shared provider this deployment cannot run (a built-in service, or one that speaks another API than chat completions).
 */
async function promoteDeployment(pool: Pool, options: PromoteOptions, d: Domain): Promise<void> {
	const owners = new Map((await pool.query("SELECT legacy_id, owner_id FROM pim_ops.owner_map")).rows.map((r) => [r.legacy_id as string, r.owner_id as string]));
	const accounts = new Set((await pool.query("SELECT owner_id FROM pim_app.accounts")).rows.map((r) => r.owner_id as string));
	const rows = (table: string) => legacyRows(pool, "_deployment", table);
	const ms = (v: unknown) => (v === null || v === undefined ? new Date() : new Date(Number(v)));
	const author = (row: Record<string, any>) => {
		const owner = owners.get(String(row.owner_id)) ?? String(row.owner_id);
		return accounts.has(owner) ? owner : null;
	};
	// A model named `own:<id>` is the author's own provider, whose id this deployment keeps; `shared:<id>` stays as the catalog names it.
	const modelRef = (value: unknown): { provider: string; id: string } | null => {
		const m = parseJson(value, null) as { provider?: unknown; id?: unknown } | null;
		return m && typeof m.provider === "string" && typeof m.id === "string" ? { provider: m.provider.replace(/^own:/, ""), id: m.id } : null;
	};

	// Invitations that were not used yet still work: only their digests were kept, and the code a person was given hashes to the same. They belong to the admin who has been here longest.
	const issuer = (await pool.query("SELECT owner_id FROM pim_app.accounts WHERE role = 'admin' ORDER BY created_at LIMIT 1")).rows[0]?.owner_id as string | undefined;
	for (const i of await rows("invites")) {
		if (!issuer) {
			d.skipped.push("invitations: not promoted, this deployment has no admin yet");
			break;
		}
		const usedBy = i.used_by ? (owners.get(String(i.used_by)) ?? null) : null;
		const r = await asOwner(pool, issuer, (c) => c.query("INSERT INTO pim_app.invites (code_hash, owner_id, note, created_at, used_by, used_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [i.hash, issuer, i.note ?? null, ms(i.created_at), usedBy, i.used_at ? ms(i.used_at) : null]));
		bump(d, "invitations", r.rowCount ?? 0);
	}

	for (const { id, row, provider, runnable } of await sharedProviders(pool, options)) {
		if (!provider) {
			d.skipped.push(`shared provider ${id}: not promoted, ${options.crypto ? "its record could not be opened" : "no keys were given to open it"}`);
			continue;
		}
		if (!runnable) {
			d.skipped.push(`shared provider ${id}: kept sealed in the landing; ${provider.builtin ? `the built-in ${provider.builtin} service` : provider.api ? `an endpoint that speaks ${provider.api}` : "a provider without an address"} needs the deployment's own configuration (PIM_AI_GATEWAY_*, or a provider key in the environment)`);
			continue;
		}
		const secret = provider.key ? await sealString(options.crypto!.app, provider.key, `provider:_instance/${id}`) : null;
		const r = await pool.query("INSERT INTO pim_app.instance_providers (id, kind, config, secret, created_at) VALUES ($1,'openai_compatible',$2,$3,$4) ON CONFLICT DO NOTHING", [id, JSON.stringify({ name: provider.name ?? id, url: provider.url, models: provider.models ?? [], structuredOutput: provider.structuredOutput === true }), secret, ms(row.created_at)]);
		bump(d, "shared providers", r.rowCount ?? 0);
	}

	for (const t of await rows("templates")) {
		const owner = author(t);
		if (!owner) {
			d.skipped.push(`template ${t.id}: its author ${t.username} has no account here`);
			continue;
		}
		const bundle = await legacyBundle(pool, owner, t.id, t, options.objects, d);
		// The tables are sealed to their owner: a row is written as the person it belongs to.
		const r = await asOwner(pool, owner, (c) => c.query("INSERT INTO pim_app.templates (id, owner_id, agent_id, title, bundle, published_at, uses) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [t.id, owner, t.agent_id, t.name, JSON.stringify(bundle), ms(t.published_at), Number(t.uses ?? 0)]));
		bump(d, "templates", r.rowCount ?? 0);
	}

	for (const b of await rows("bots")) {
		const owner = author(b);
		if (!owner) {
			d.skipped.push(`bot ${b.id}: its host ${b.username} has no account here`);
			continue;
		}
		const tools = parseJson(b.tools, []) as { name?: string; ask?: boolean }[];
		const settings = { dailyMessages: b.daily_messages ?? null, dailyToolCalls: b.daily_tool_calls ?? null, model: modelRef(b.model), tools: tools.map((x) => x.name).filter(Boolean), ask: tools.filter((x) => x.ask).map((x) => x.name).filter(Boolean) };
		const r = await asOwner(pool, owner, (c) => c.query("INSERT INTO pim_app.bots (id, owner_id, name, agent_id, settings, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [b.id, owner, b.name, b.agent_id, JSON.stringify(settings), ms(b.shared_at)]));
		bump(d, "bots", r.rowCount ?? 0);
		// A bot here shows its agent's own picture, and v1's was a copy of it made when the bot was shared: it becomes the agent's icon when the agent has none.
		const b64 = b.icon_data && typeof b.icon_data === "object" ? (b.icon_data as { $b64?: unknown }).$b64 : undefined;
		if (typeof b64 === "string" && options.objects?.put) {
			const bytes = Buffer.from(b64, "base64");
			const type = typeof b.icon_type === "string" && /^image\//.test(b.icon_type) ? b.icon_type : bytes[0] === 0xff ? "image/jpeg" : "image/png";
			const key = `${owner}/agent-icons/${b.agent_id}`;
			const lacks = await asOwner(pool, owner, async (c) => (await c.query("SELECT 1 FROM pim_app.agents WHERE id = $1 AND icon_key IS NULL AND deleted_at IS NULL", [b.agent_id])).rowCount);
			if (lacks) {
				await options.objects.put(key, bytes, type);
				await asOwner(pool, owner, async (c) => {
					await c.query("INSERT INTO pim_app.objects (key, owner_id, purpose, content_type, size, sha256, acl) VALUES ($1,$2,'image',$3,$4,$5,'public') ON CONFLICT (key) DO NOTHING", [key, owner, type, bytes.length, createHash("sha256").update(bytes).digest("hex")]);
					await c.query("UPDATE pim_app.agents SET icon_key = $2, updated_at = now() WHERE id = $1 AND icon_key IS NULL", [b.agent_id, key]);
				});
				bump(d, "bot icons");
			}
		} else if (b64) d.skipped.push(`bot ${b.id}: its icon was not carried, no object store was given`);
	}

	// The admin's own connector catalog (custom connectors with their address, icon and category) and the built-in apps the admin turned off; each is one deployment setting here.
	const customApps = (await rows("apps")).map((a) => ({ id: String(a.id), name: String(a.name), description: String(a.description ?? ""), url: String(a.url), icon: a.icon ?? null, category: a.category ?? null }));
	if (customApps.length > 0) bump(d, "custom connectors", (await pool.query("INSERT INTO pim_app.instance_settings (key, value) VALUES ('custom_apps', $1) ON CONFLICT DO NOTHING", [JSON.stringify(customApps)])).rowCount ?? 0 ? customApps.length : 0);
	const disabledApps = (await rows("disabled_builtin_apps")).map((a) => String(a.id));
	if (disabledApps.length > 0) bump(d, "disabled built-in apps", (await pool.query("INSERT INTO pim_app.instance_settings (key, value) VALUES ('disabled_builtin_apps', $1) ON CONFLICT DO NOTHING", [JSON.stringify(disabledApps)])).rowCount ?? 0 ? disabledApps.length : 0);

	// The agent everyone starts with is a template an admin marks as the default; one that was never published as a template becomes one.
	for (const a of await rows("default_agent")) {
		const owner = author(a);
		if (!owner) {
			d.skipped.push(`default agent ${a.agent_id}: its author ${a.username} has no account here`);
			continue;
		}
		const marked = await asOwner(pool, owner, (c) => c.query("UPDATE pim_app.templates SET default_for_everyone = true WHERE owner_id = $1 AND agent_id = $2 AND NOT EXISTS (SELECT 1 FROM pim_app.templates WHERE default_for_everyone)", [owner, a.agent_id]));
		if (marked.rowCount) continue;
		const bundle = await legacyBundle(pool, owner, "default", a, options.objects, d);
		const r = await asOwner(pool, owner, (c) => c.query("INSERT INTO pim_app.templates (id, owner_id, agent_id, title, bundle, published_at, default_for_everyone) SELECT $1,$2,$3,$4,$5,$6,true WHERE NOT EXISTS (SELECT 1 FROM pim_app.templates WHERE default_for_everyone) ON CONFLICT DO NOTHING", [`tpl_legacy_default`, owner, a.agent_id, a.name, JSON.stringify(bundle), ms(a.updated_at)]));
		bump(d, "default agent", r.rowCount ?? 0);
	}
}

/**
 * The coding credentials v1 kept sealed in `pim_coding_vault` (one row per harness in each space's Pim object), resealed into `pim_forge.forge_vault` under the
 * application's keys. v1 sealed each under a key HKDF-derived from the Directory's `cookie_key` (kept in the landing as a secret of the deployment), bound to the
 * person's legacy owner id and the harness. A harness that already has a v2 entry is left alone, so this can be run again and never overwrites a credential entered since.
 * No plaintext leaves this function; a row that does not open is reported by owner and harness only.
 */
export async function promoteCodingVault(pool: Pool, owner: string, crypto: { ops: OpsCrypto; app: KeyringCrypto }, d: Domain): Promise<void> {
	const legacyId = (await pool.query("SELECT legacy_id FROM pim_ops.owner_map WHERE owner_id = $1", [owner])).rows[0]?.legacy_id as string | undefined;
	const rows = (await pool.query("SELECT row FROM pim_ops.legacy_rows WHERE owner_id = $1 AND table_name = 'pim_coding_vault' AND source LIKE 'Pim:%' ORDER BY pk", [owner])).rows.map((r) => r.row as Record<string, any>).filter((r) => r.sealed?.$b64 && typeof r.harness === "string");
	if (!legacyId || rows.length === 0) return;
	const ref = (await pool.query("SELECT row FROM pim_ops.legacy_rows WHERE owner_id = '_deployment' AND table_name = 'directory_meta' AND pk = 'cookie_key'")).rows[0]?.row as { value?: { $secret?: string } } | undefined;
	const name = ref?.value?.$secret;
	const found = name ? (await pool.query("SELECT envelope FROM pim_ops.secret_envelopes WHERE owner_id = '_deployment' AND name = $1", [name])).rows[0] : undefined;
	if (!found) {
		d.skipped.push(`coding credentials of ${owner}: the v1 Directory key was not found, so they were not carried`);
		return;
	}
	const key = await vaultKey(base64UrlDecode(crypto.ops.open(found.envelope, ["_deployment", name!, "meta"]).toString()));
	const vault = new ForgeVault(pool as never, crypto.app);
	for (const row of rows) {
		const harness = row.harness as CodingVaultKey;
		if (harness !== "amp-http-m2m" && !(HARNESSES as readonly string[]).includes(harness)) continue;
		try {
			const plaintext = await openBlob(key, { userId: legacyId, harness }, new Uint8Array(Buffer.from(row.sealed.$b64, "base64")));
			bump(d, "coding credentials", (await vault.adopt(owner, harness, plaintext)) ? 1 : 0);
		} catch {
			d.skipped.push(`coding credential ${harness} of ${owner}: it did not open under the v1 key`);
		}
	}
}

/** Promotes every tenant of the landing; the owners done. Safe to run again: what is already in place is left as it is. */
export async function promoteToLive(pool: Pool, options: PromoteOptions): Promise<PromoteReport> {
	const runtime = new RuntimeDb(pool);
	const owners = (await pool.query("SELECT owner_id FROM pim_ops.tenants WHERE owner_id <> '_deployment' ORDER BY owner_id")).rows.map((r) => r.owner_id as string);
	const shared = (await sharedProviders(pool, options)).flatMap((p) => (p.runnable ? [p.id] : []));
	const report: PromoteReport = { owners: [], chats: 0, messages: 0, forgeThreads: 0, orphanedTasks: 0, clearedRuns: 0, remappedModels: 0, domain: {}, skipped: [] };
	// Every account exists before any space is promoted: a circle names members who may sort after its owner.
	for (const owner of owners) await promoteIdentity(pool, owner, options.rpId, options.legacyRpId);
	for (const owner of owners) {
		const has = (await runtime.read(owner, "SELECT 1 FROM pim_runtime.partitions WHERE owner_id = $1 LIMIT 1", [owner])).rowCount;
		const hasPi = (await pool.query("SELECT 1 FROM pim_ops.pi_conversations WHERE owner_id = $1 LIMIT 1", [owner])).rowCount;
		if (!has && hasPi) {
			const own = await ownProviderIds(pool, owner, options);
			const { space, orphaned, clearedRuns, remappedModels } = await legacySpace(pool, owner, options.cutoverAt, options.defaultAgent, new Set(["anthropic", "openai", "google", "gateway", ...own, ...shared.map((id) => `shared:${id}`)]));
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
		await promoteDomain(pool, owner, options, domain, new Set(["anthropic", "openai", "google", "gateway", ...(await ownProviderIds(pool, owner, options)), ...shared.map((id) => `shared:${id}`)]));
		if (options.objects?.put) {
			const put = options.objects.put;
			await promoteAgentIcons(pool, owner, (key, bytes, type) => put(key, bytes, type), domain);
		}
		report.forgeThreads += await promoteForge(pool, owner);
		if (options.crypto) await promoteCodingVault(pool, owner, options.crypto, domain);
		report.owners.push(owner);
	}
	await promoteDeployment(pool, options, { counts: report.domain, skipped: report.skipped });
	return report;
}
