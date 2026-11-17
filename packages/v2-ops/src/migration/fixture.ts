// A rich synthetic legacy snapshot, shaped like what the inert fence worker exports from a real deployment: a few people
// (one of them the admin), their passkeys, tokens and sealed credentials, chats with forks, a continuation, a delegated task,
// a trigger chat, a pending approval, an external tool call that was running at the fence, schedules that were due while
// the fence stood, a Yjs note, a hosted app with its files, media, and coding threads (one in Amp's cloud, one a CLI run).
// Nothing here is real data. Ids and times are fixed so that two runs build the same snapshot.
import { randomBytes } from "node:crypto";
import { LEGACY_PREFIX, legacyBinding, sealLegacyCredential, sealLegacyVaultBlob, vaultKeyFromCookieKey } from "../crypto/legacy.ts";
import { keyFingerprint } from "../crypto/envelope.ts";
import { type DoDump, type Row, type TableDump, SnapshotWriter, b64 } from "./snapshot.ts";

export const FIXTURE_CUTOVER_AT = Date.UTC(2026, 10, 20, 3, 0, 0);
const MIN = 60_000;

export type FixtureKeys = { readonly appCredentialsKey: Buffer; readonly cookieKey: Buffer };

export type FixtureInfo = {
	readonly keys: FixtureKeys;
	readonly owners: { readonly anibal: string; readonly ada: string; readonly grace: string };
	/** Public chat ids of the interesting chats of Ada's space. */
	readonly chats: { readonly plain: string; readonly branched: string; readonly continuation: string; readonly fork: string; readonly nestedFork: string; readonly earlyFork: string };
	readonly amp: { readonly threadId: string; readonly codingThread: string };
	readonly mediaBytes: number;
};

const table = (columns: string[], rows: Row[]): TableDump => ({ columns, rows });
const json = (value: unknown) => JSON.stringify(value);
const text = (role: "user" | "assistant", body: string) => ({ role, content: [{ type: "text", text: body }] });

/** Builds one storage's pi-durable tables the way pi lays them out: one id space, one commit sequence. */
class Pi {
	nextId = 2;
	seq = 1;
	conversations: Row[] = [];
	entries: Row[] = [];
	tasks: Row[] = [];
	submissions: Row[] = [];
	documents: Row[] = [];
	revisions: Row[] = [];
	ids: Row[] = [];
	#mint(type: string) {
		const id = this.nextId++;
		this.ids.push({ id, record_type: type });
		return id;
	}
	conversation(options: { id?: number; parent?: { conversationId: number; at: number }; owner?: { conversationId: number; taskId: number } } = {}): number {
		let id = options.id;
		if (id === undefined) id = this.#mint("conversation");
		else this.ids.push({ id, record_type: "conversation" });
		this.conversations.push({
			id,
			owner_conversation_id: options.owner?.conversationId ?? null,
			owner_task_id: options.owner?.taskId ?? null,
			record: json({ id, ...(options.parent ? { parent: options.parent } : {}), ...(options.owner ? { owner: options.owner } : {}) }),
		});
		return id;
	}
	entry(conversationId: number, kind: string, extra: { model?: unknown[]; data?: unknown; head?: number; edits?: unknown[] } = {}): number {
		const id = this.#mint("entry");
		this.entries.push({ id, conversation_id: conversationId, head: extra.head ?? null, commit_seq: this.seq++, record: json({ id, conversationId, kind, ...extra }) });
		return id;
	}
	message(conversationId: number, role: "user" | "assistant", body: string) {
		return this.entry(conversationId, "message", { model: [text(role, body)] });
	}
	task(conversationId: number, kind: string, status: string, record: Record<string, unknown>, options: { background?: boolean } = {}): number {
		const id = this.#mint("task");
		this.tasks.push({ id, conversation_id: conversationId, kind, status, abort_requested: 0, background: options.background ? 1 : 0, record: json({ id, conversationId, kind, status, ...record }) });
		return id;
	}
	submission(conversationId: number, requestId: string | null, status: string) {
		const id = this.#mint("submission");
		this.submissions.push({ id, conversation_id: conversationId, request_id: requestId, status, record: json({ id, conversationId, requestId, status }) });
		return id;
	}
	document(kind: string, scope: "session" | "conversation" | "task", owner: number, content: unknown, deltas: unknown[] = []): number {
		const id = this.#mint("document");
		this.documents.push({ id, kind, family: 0, key_value: "", scope_kind: scope, owner_id: owner, created_at: this.seq, retired_at: null, record: json({ id, kind, scope, owner }) });
		this.revisions.push({ document_id: id, seq: this.seq++, kind: "base", version: 1, content: json(content) });
		for (const delta of deltas) this.revisions.push({ document_id: id, seq: this.seq++, kind: "delta", version: 1, content: json(delta) });
		return id;
	}
	tables(): Record<string, TableDump> {
		const t = (columns: string[], rows: Row[]) => table(columns, rows);
		return {
			pi_durable_metadata: t(["singleton", "next_id", "next_seq"], [{ singleton: 1, next_id: String(this.nextId), next_seq: this.seq }]),
			pi_record_ids: t(["id", "record_type"], this.ids),
			pi_conversations: t(["id", "owner_conversation_id", "owner_task_id", "record"], this.conversations),
			pi_entries: t(["id", "conversation_id", "head", "commit_seq", "record"], this.entries),
			pi_tasks: t(["id", "conversation_id", "kind", "status", "abort_requested", "background", "record"], this.tasks),
			pi_submissions: t(["id", "conversation_id", "request_id", "status", "record"], this.submissions),
			pi_documents: t(["id", "kind", "family", "key_value", "scope_kind", "owner_id", "created_at", "retired_at", "record"], this.documents),
			pi_document_revisions: t(["document_id", "seq", "kind", "version", "content"], this.revisions),
		};
	}
}

function pseudoBytes(seed: string, size: number): Buffer {
	const out = Buffer.alloc(size);
	let state = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
	for (let i = 0; i < size; i++) {
		state = (state * 1664525 + 1013904223) >>> 0;
		out[i] = state >>> 24;
	}
	return out;
}

const dump = (cls: string, name: string, tables: Record<string, TableDump>, extra: Partial<Pick<DoDump, "kv" | "alarm">> = {}): DoDump => ({ class: cls, name, tables, kv: extra.kv ?? [], alarm: extra.alarm ?? null });

/** Writes the snapshot to `dir` and returns what a test needs to know about it. */
export async function buildLegacySnapshot(dir: string, options: { cutoverAt?: number } = {}): Promise<FixtureInfo> {
	const cutoverAt = options.cutoverAt ?? FIXTURE_CUTOVER_AT;
	const keys: FixtureKeys = { appCredentialsKey: Buffer.alloc(32, 7), cookieKey: Buffer.alloc(32, 9) };
	const owners = { anibal: "own_anibal", ada: "own_ada", grace: "own_grace" };
	const writer = new SnapshotWriter(dir);
	const chats = { plain: "5f0c1d52-0000-4000-8000-000000000002", branched: "5f0c1d52-0000-4000-8000-000000000003", continuation: "5f0c1d52-0000-4000-8000-000000000007", fork: "5f0c1d52-0000-4000-8000-000000000004", nestedFork: "5f0c1d52-0000-4000-8000-000000000005", earlyFork: "5f0c1d52-0000-4000-8000-000000000006" };

	// Directory: accounts, identities, and the Directory's own keys in clear, as the legacy Directory keeps them.
	await writer.dump(
		dump("Directory", "directory", {
			accounts: table(["owner_id", "username", "role", "status", "created_at", "activated_at", "pending_until", "status_reason", "status_changed_at"], [
				{ owner_id: owners.anibal, username: "anibal", role: "admin", status: "active", created_at: cutoverAt - 400 * 86_400_000, activated_at: cutoverAt - 400 * 86_400_000, pending_until: null, status_reason: null, status_changed_at: null },
				{ owner_id: owners.ada, username: "ada", role: "member", status: "suspended", created_at: cutoverAt - 200 * 86_400_000, activated_at: cutoverAt - 200 * 86_400_000, pending_until: null, status_reason: "cutover fence", status_changed_at: cutoverAt - 30 * MIN },
				{ owner_id: owners.grace, username: "grace", role: "member", status: "suspended", created_at: cutoverAt - 90 * 86_400_000, activated_at: cutoverAt - 90 * 86_400_000, pending_until: null, status_reason: "cutover fence", status_changed_at: cutoverAt - 30 * MIN },
			]),
			identities: table(["issuer", "subject", "owner_id"], [{ issuer: "https://accounts.example.test", subject: "ada-sub-1", owner_id: owners.ada }]),
			invites: table(["hash", "note", "created_at", "used_by", "used_at"], [{ hash: "ab".repeat(32), note: "for grace", created_at: cutoverAt - 91 * 86_400_000, used_by: owners.grace, used_at: cutoverAt - 90 * 86_400_000 }]),
			cleanups: table(["owner_id", "kind", "requested_at", "attempts", "next_attempt_at", "last_error"], []),
			registrations: table(["address", "at"], []),
			rate_limits: table(["name", "key", "window_ends", "hits"], []),
			computer_requests: table(["owner_id", "id", "op", "name", "token", "requested_at", "taken_at"], []),
			directory_meta: table(["key", "value"], [
				{ key: "cookie_key", value: keys.cookieKey.toString("base64url") },
				{ key: "salt", value: Buffer.alloc(32, 3).toString("base64url") },
			]),
		}),
	);

	// Auth: one object per owner.
	for (const [name, owner] of Object.entries(owners)) {
		const n = name === "ada" ? 2 : 1;
		await writer.dump(
			dump("Auth", owner, {
				auth_passkeys: table(["id", "spki", "algorithm", "name", "created_at", "last_used_at"], Array.from({ length: n }, (_, i) => ({ id: `${name}-pk-${i}`, spki: randomLike(`${name}${i}`, 91), algorithm: -7, name: `${name} device ${i}`, created_at: cutoverAt - (100 - i) * 86_400_000, last_used_at: cutoverAt - (i + 1) * 3_600_000 }))),
				auth_tokens: table(["id", "name", "hash", "created_at", "last_used_at"], Array.from({ length: n }, (_, i) => ({ id: `${name}-tok-${i}`, name: `cli ${i}`, hash: Buffer.from(`${name}-token-${i}`).toString("hex").padEnd(64, "0").slice(0, 64), created_at: cutoverAt - 50 * 86_400_000, last_used_at: null }))),
				auth_recovery_codes: table(["hash", "created_at", "used_at"], [
					{ hash: Buffer.from(`${name}-rc-1`).toString("hex").padEnd(64, "1").slice(0, 64), created_at: cutoverAt - 80 * 86_400_000, used_at: null },
					{ hash: Buffer.from(`${name}-rc-2`).toString("hex").padEnd(64, "2").slice(0, 64), created_at: cutoverAt - 80 * 86_400_000, used_at: name === "ada" ? cutoverAt - 10 * 86_400_000 : null },
				]),
				auth_identities: table(["id", "provider", "issuer", "subject", "label", "created_at", "last_used_at", "name"], name === "ada" ? [{ id: "ada-ident", provider: "oidc", issuer: "https://accounts.example.test", subject: "ada-sub-1", label: "ada@example.test", created_at: cutoverAt - 60 * 86_400_000, last_used_at: cutoverAt - 86_400_000, name: "Ada" }] : []),
				auth_device_links: table(["hash", "passkey", "created_at", "expires_at"], []),
				auth_meta: table(["key", "value"], []),
			}),
		);
	}

	// Gallery: admin-supplied model provider with an API key in clear JSON, one template, one published app.
	await writer.dump(
		dump("Gallery", "gallery", {
			profiles: table(["owner_id", "username", "display_name", "bio", "updated_at"], [{ owner_id: owners.ada, username: "ada", display_name: "Ada", bio: null, updated_at: cutoverAt - 86_400_000 }]),
			templates: table(["id", "owner_id", "username", "agent_id", "name", "description", "instructions", "apps"], [{ id: "tpl_1", owner_id: owners.ada, username: "ada", agent_id: "agent_ada_1", name: "Researcher", description: "Reads things", instructions: "Be brief.", apps: "[]" }]),
			providers: table(["id", "provider", "created_at"], [{ id: "prov_1", provider: json({ id: "prov_1", kind: "openai-compatible", baseUrl: "https://models.example.test/v1", apiKey: "sk-example-not-a-real-key-123" }), created_at: cutoverAt - 300 * 86_400_000 }]),
			compute_providers: table(["id", "provider", "created_at"], [{ id: "cp_1", provider: json({ id: "cp_1", kind: "sandbox-manager", url: "https://manager.example.test", token: "mgr-token-example-456" }), created_at: cutoverAt - 100 * 86_400_000 }]),
			apps: table(["id", "name", "description", "url", "icon", "category", "created_at"], []),
			published_artifacts: table(["id", "owner_id", "username", "artifact_id", "version", "title", "kind", "files"], [{ id: "pa_1", owner_id: owners.ada, username: "ada", artifact_id: "art_1", version: 1, title: "Habit tracker", kind: "app", files: json(["index.html"]) }]),
		}),
	);

	// Ada's space.
	const pi = new Pi();
	const root = pi.conversation({ id: 1 });
	pi.message(root, "user", "Good morning");
	pi.message(root, "assistant", "Good morning, Ada.");
	const nap = pi.task(root, "optmem.nap", "terminal", { result: "ok" }, { background: true });
	const agentDoc = (conversation: number, overrides: Record<string, unknown>) => pi.document("pi.agent", "conversation", conversation, { model: overrides.model ?? null, ...overrides });
	agentDoc(root, { systemPrompt: "You are Ada's majordomo." });

	const plainChat = pi.conversation();
	pi.message(plainChat, "user", "Please fetch the status page");
	pi.message(plainChat, "assistant", "Calling the status API.");
	const httpTool = pi.task(plainChat, "pi.tool", "running", { tool: "http_request", callId: "call_http_1", args: { method: "POST", url: "https://api.example.test/orders", body: "{\"sku\":1}" }, replay: "unsafe" });
	agentDoc(plainChat, { model: "example/model-a" });

	const branched = pi.conversation();
	const b1 = pi.message(branched, "user", "Plan a trip to Lisbon");
	const b2 = pi.message(branched, "assistant", "Three days, two museums.");
	const b3 = pi.message(branched, "user", "Add a day trip");
	const b4 = pi.message(branched, "assistant", "Sintra works.");
	const approvalTool = pi.task(branched, "pi.tool", "waiting", { tool: "send_message", callId: "call_msg_1", args: { to: "friend@example.test" }, on: [] });
	agentDoc(branched, { model: "example/model-b", temperature: 0.2 });
	const fork1 = pi.conversation({ parent: { conversationId: branched, at: b2 } });
	pi.message(fork1, "user", "Make it cheaper");
	const f1b = pi.message(fork1, "assistant", "Use hostels.");
	pi.document("pi.agent", "conversation", fork1, { model: "example/model-b", temperature: 0.2 }); // copied at the cut
	const fork2 = pi.conversation({ parent: { conversationId: fork1, at: f1b } });
	pi.message(fork2, "user", "And walk everywhere");
	const earlyFork = pi.conversation({ parent: { conversationId: branched, at: b1 } });
	pi.entry(earlyFork, "message", { model: [text("user", "Actually, Porto")], edits: [{ target: b1, action: "omit" }], head: b1 });
	void b3;
	void b4;

	const continuation = pi.conversation();
	pi.entry(continuation, "summary", { model: [text("user", "Summary of the earlier chat: status page was fetched.")], data: { summaryOf: String(plainChat) } });
	pi.message(continuation, "assistant", "Carrying on from the summary.");

	const delegated = pi.conversation();
	const delegatedSubmission = pi.submission(delegated, "task:t1", "done");
	pi.message(delegated, "user", "Research hostels in Porto");
	pi.message(delegated, "assistant", "Found three.");
	const triggerChat = pi.conversation();
	pi.document("pim.trigger_chat", "conversation", triggerChat, { trigger: "trg_cron" }, [{ op: "set", path: "last", value: "ok" }]);
	pi.message(triggerChat, "assistant", "Daily digest ready.");
	void delegatedSubmission;

	const piTables = pi.tables();
	const pending = { id: "apr_pending", session: String(branched), action: "send_message", args: json({ to: "friend@example.test" }), summary: "Send a message", status: "pending", note: null, result: null, created_at: cutoverAt - 40 * MIN, decided_at: null, call_id: "call_msg_1", expires_at: null, tool: "send_message", on_timeout: "deny", decided_by: null, requested_by: null, member: null, review: null };
	const unresolved = { id: "apr_http", session: String(plainChat), action: "http_request", args: json({ method: "POST", url: "https://api.example.test/orders" }), summary: "POST an order", status: "approved", note: null, result: null, created_at: cutoverAt - 35 * MIN, decided_at: cutoverAt - 34 * MIN, call_id: "call_http_1", expires_at: null, tool: "http_request", on_timeout: "deny", decided_by: owners.ada, requested_by: null, member: null, review: null };
	const credBinding = (id: string, app: string) => legacyBinding(owners.ada, id, app, "credential");
	const gmailCredential = json({ accessToken: "ya29.example-access", refreshToken: "1//example-refresh", expiresAt: cutoverAt + 3_600_000 });
	const trigger = (id: string, spec: unknown, nextWake: number | null, last: number | null) => ({
		triggers: { id, revision: 1, lifecycle: "active", health: "ok", health_detail: null, generation: 1, created_at: cutoverAt - 20 * 86_400_000, updated_at: cutoverAt - 86_400_000 },
		revision: { trigger_id: id, revision: 1, spec: json(spec), created_at: cutoverAt - 20 * 86_400_000 },
		source: { trigger_id: id, source_revision: 1, position: null, cursor: null, last_observed_at: last, gap_pending: 0, condition_state: null, active_since: null, next_wake_at: nextWake, updated_at: cutoverAt - 40 * MIN },
	});
	const cron = trigger("trg_cron", { source: { kind: "time", schedule: "cron", expression: "*/15 * * * *", timeZone: "UTC", catchUpMs: 3_600_000 } }, cutoverAt - 7 * MIN, cutoverAt - 22 * MIN);
	const interval = trigger("trg_every", { source: { kind: "time", schedule: "interval", everyMs: 30 * MIN, anchorAt: cutoverAt - 10 * 86_400_000, catchUpMs: 86_400_000 } }, cutoverAt - 25 * MIN, cutoverAt - 55 * MIN);
	const once = trigger("trg_once", { source: { kind: "time", schedule: "once", at: cutoverAt - 3 * MIN, maxLatenessMs: 86_400_000 } }, cutoverAt - 3 * MIN, null);
	const future = trigger("trg_future", { source: { kind: "time", schedule: "once", at: cutoverAt + 2 * 3_600_000, maxLatenessMs: 60_000 } }, cutoverAt + 2 * 3_600_000, null);
	const all = [cron, interval, once, future];
	const mediaPng = pseudoBytes("image", 64 * 1024);
	const mediaMp4 = pseudoBytes("video", 3 * 1024 * 1024);
	const noteDoc = Buffer.from([1, 1, 168, 238, 217, 224, 5, 0, 4, 1, 4, 116, 101, 120, 116, 5, 72, 101, 108, 108, 111, 0]);

	await writer.dump(
		dump(
			"Pim",
			owners.ada,
			{
				...piTables,
				pim_sessions: table(["id", "title", "created_at", "updated_at", "deleted_at", "summary", "summary_of"], [
					{ id: String(plainChat), title: "Status page", created_at: cutoverAt - 9 * 86_400_000, updated_at: cutoverAt - 35 * MIN, deleted_at: null, summary: null, summary_of: null },
					{ id: String(branched), title: "Trip planning", created_at: cutoverAt - 8 * 86_400_000, updated_at: cutoverAt - 40 * MIN, deleted_at: null, summary: null, summary_of: null },
					{ id: String(fork1), title: "Trip planning (cheaper)", created_at: cutoverAt - 7 * 86_400_000, updated_at: cutoverAt - 7 * 86_400_000, deleted_at: null, summary: null, summary_of: null },
					{ id: String(fork2), title: "Trip planning (walking)", created_at: cutoverAt - 6 * 86_400_000, updated_at: cutoverAt - 6 * 86_400_000, deleted_at: null, summary: null, summary_of: null },
					{ id: String(earlyFork), title: "Porto instead", created_at: cutoverAt - 5 * 86_400_000, updated_at: cutoverAt - 5 * 86_400_000, deleted_at: null, summary: null, summary_of: null },
					{ id: String(continuation), title: "Status page (continued)", created_at: cutoverAt - 2 * 86_400_000, updated_at: cutoverAt - 86_400_000, deleted_at: null, summary: "Status page was fetched.", summary_of: chats.plain },
				]),
				pim_session_ids: table(["id", "session"], [
					{ id: chats.plain, session: String(plainChat) },
					{ id: chats.branched, session: String(branched) },
					{ id: chats.fork, session: String(fork1) },
					{ id: chats.nestedFork, session: String(fork2) },
					{ id: chats.earlyFork, session: String(earlyFork) },
					{ id: chats.continuation, session: String(continuation) },
				]),
				pim_approvals: table(Object.keys(pending), [pending, unresolved]),
				pim_meta: table(["key", "value"], [
					// Explicit settings only: every key the person never changed is absent, and must stay absent.
					{ key: "settings", value: json({ timeZone: "Europe/Madrid", approvalPolicy: "auto" }) },
					{ key: "hosted_key", value: Buffer.alloc(32, 5).toString("base64url") },
					{ key: "vapid_keys", value: json({ kty: "EC", crv: "P-256", d: "example-private-scalar", x: "x", y: "y" }) },
				]),
				pim_credentials: table(["provider", "credential"], [{ provider: "anthropic", credential: json({ apiKey: "sk-ant-example-789" }) }]),
				pim_app_connections: table(["id", "app", "name", "state", "credential", "sign_in_state", "pending", "auth_url", "error", "created_at", "generation"], [
					{ id: "conn_gmail", app: "gmail", name: "Gmail", state: "connected", credential: sealLegacyCredential(gmailCredential, keys.appCredentialsKey, credBinding("conn_gmail", "gmail")), sign_in_state: null, pending: null, auth_url: null, error: null, created_at: cutoverAt - 60 * 86_400_000, generation: "g1" },
					{ id: "conn_spot", app: "spotify", name: "Spotify", state: "connected", credential: json({ accessToken: "unsealed-example" }), sign_in_state: null, pending: null, auth_url: null, error: null, created_at: cutoverAt - 30 * 86_400_000, generation: "g1" },
				]),
				pim_tool_permissions: table(["audience", "app", "tool", "permission", "definition", "updated_at"], [
					{ audience: "", app: "conn_gmail", tool: "send_email", permission: "ask", definition: null, updated_at: cutoverAt - 86_400_000 },
					{ audience: "agent:ag_1", app: "conn_gmail", tool: "send_email", permission: "ask", definition: null, updated_at: cutoverAt - 86_400_000 },
					{ audience: "circle_1", app: "conn_gmail", tool: "send_email", permission: "on", definition: null, updated_at: cutoverAt - 86_400_000 },
				]),
				pim_mcp_servers: table(["id", "approval"], [{ id: "conn_gmail", approval: "all" }]),
				pim_push_subscriptions: table(["endpoint", "p256dh", "auth", "created_at"], [{ endpoint: "https://push.example.test/abc", p256dh: "p256", auth: "push-auth-secret", created_at: cutoverAt - 40 * 86_400_000 }]),
				pim_tasks: table(["id", "title", "status", "conversation", "operation_id"], [{ id: "t1", title: "Research hostels", status: "done", conversation: String(delegated), operation_id: "task:t1" }]),
				pim_notes: table(["id", "title", "ydoc", "updated_at"], [{ id: "note_1", title: "Packing list", ydoc: b64(noteDoc), updated_at: cutoverAt - 3_600_000 }]),
				pim_artifacts: table(["id", "name", "kind", "versions", "created_at"], [{ id: "art_1", name: "Habit tracker", kind: "app", versions: json([{ v: 1, files: { "index.html": "own_ada/art_1/v1/index.html" } }]), created_at: cutoverAt - 30 * 86_400_000 }]),
				pim_triggers: table(Object.keys(cron.triggers), all.map((t) => t.triggers)),
				pim_trigger_revisions: table(Object.keys(cron.revision), all.map((t) => t.revision)),
				pim_trigger_sources: table(Object.keys(cron.source), all.map((t) => t.source)),
				pim_trigger_occurrences: table(["id", "trigger_id", "occurrence_key", "revision", "generation", "status", "evidence", "due_at", "created_at", "updated_at"], [
					{ id: "occ_1", trigger_id: "trg_cron", occurrence_key: `t:${cutoverAt - 22 * MIN}`, revision: 1, generation: 1, status: "submitted", evidence: null, due_at: cutoverAt - 22 * MIN, created_at: cutoverAt - 22 * MIN, updated_at: cutoverAt - 22 * MIN },
					{ id: "occ_2", trigger_id: "trg_cron", occurrence_key: `t:${cutoverAt - 7 * MIN}`, revision: 1, generation: 1, status: "pending", evidence: null, due_at: cutoverAt - 7 * MIN, created_at: cutoverAt - 7 * MIN, updated_at: cutoverAt - 7 * MIN },
				]),
				pim_trigger_outbox: table(["id", "seq", "occurrence_id", "trigger_id", "operation_id", "status", "attempts", "available_at", "lease_until", "last_error", "created_at", "updated_at"], [
					{ id: "out_2", seq: 2, occurrence_id: "occ_2", trigger_id: "trg_cron", operation_id: "trigger:occ_2", status: "pending", attempts: 0, available_at: cutoverAt - 7 * MIN, lease_until: null, last_error: null, created_at: cutoverAt - 7 * MIN, updated_at: cutoverAt - 7 * MIN },
				]),
				cf_agents_jobs: table(["id", "capability", "fn", "time", "payload", "retry_options", "singleflight", "hung_timeout_seconds", "exclusive", "recovery_loop", "running", "execution_started_at", "created_at"], [
					{ id: "job_expire", capability: "schedule", fn: "expireApproval", time: Math.floor((cutoverAt - 5 * MIN) / 1000), payload: json({ approval: "apr_pending" }), retry_options: null, singleflight: 0, hung_timeout_seconds: null, exclusive: 0, recovery_loop: 0, running: 0, execution_started_at: null, created_at: Math.floor((cutoverAt - 40 * MIN) / 1000) },
					{ id: "job_tick", capability: "schedule", fn: "runTriggerTick", time: Math.floor((cutoverAt - 7 * MIN) / 1000), payload: null, retry_options: null, singleflight: 1, hung_timeout_seconds: null, exclusive: 0, recovery_loop: 0, running: 0, execution_started_at: null, created_at: Math.floor((cutoverAt - 2 * 86_400_000) / 1000) },
				]),
			},
			{
				kv: [
					{ key: "/own_ada/conn_gmail/client_1/token", value: { access_token: "mcp-oauth-access-example", refresh_token: "mcp-oauth-refresh-example" } },
					{ key: "/own_ada/conn_gmail/client_1/client_info", value: { client_id: "client_1", client_secret: "mcp-client-secret-example" } },
					{ key: "pim:last-open", value: cutoverAt - 3_600_000 },
				],
				alarm: cutoverAt - 7 * MIN,
			},
		),
	);

	// Anibal and Grace have small spaces: a root conversation and one chat each.
	for (const owner of [owners.anibal, owners.grace]) {
		const small = new Pi();
		const r = small.conversation({ id: 1 });
		small.message(r, "user", `hello from ${owner}`);
		const c = small.conversation();
		small.message(c, "user", "A chat");
		small.message(c, "assistant", "An answer");
		const uuid = `7a000000-0000-4000-8000-${owner === owners.anibal ? "0000000000a1" : "0000000000b1"}`;
		await writer.dump(
			dump("Pim", owner, {
				...small.tables(),
				pim_sessions: table(["id", "title", "created_at", "updated_at", "deleted_at", "summary", "summary_of"], [{ id: String(c), title: "A chat", created_at: cutoverAt - 86_400_000, updated_at: cutoverAt - 86_400_000, deleted_at: null, summary: null, summary_of: null }]),
				pim_session_ids: table(["id", "session"], [{ id: uuid, session: String(c) }]),
				pim_meta: table(["key", "value"], []),
			}),
		);
	}

	// Coding: Ada's scheduler, one thread running in Amp's cloud and one CLI run the fence cut off.
	const ampThread = "T-fixture-amp-0001";
	const threadRow = (id: string, extra: Record<string, unknown>) => ({ thread_id: id, space: owners.ada, repo_url: "https://git.example.test/ada/app", base_ref: "main", branch: `pim/${id}`, harness: "pi", provider_id: "prov", provider_kind: "workspace", orb: null, state: "running", start_operation: `start:${id}`, ...extra });
	const threadColumns = ["thread_id", "space", "repo_url", "base_ref", "branch", "harness", "provider_id", "provider_kind", "orb", "state", "start_operation"];
	await writer.dump(
		dump("CodingScheduler", owners.ada, {
			pim_coding_slots: table(["slot", "thread_id", "state"], [{ slot: "s1", thread_id: "thr_cli1", state: "running" }]),
			pim_coding_threads: table(["thread_id", "state"], [{ thread_id: "thr_amp1", state: "running" }, { thread_id: "thr_cli1", state: "running" }]),
		}),
	);
	await writer.dump(
		dump("CodingThread", "thr_amp1", {
			coding_thread: table(threadColumns, [threadRow("thr_amp1", { harness: "amp", provider_kind: "agent-hosted", orb: json({ threadId: ampThread, url: `https://ampcode.example.test/threads/${ampThread}` }) })]),
			coding_event: table(["seq", "kind", "at", "data"], [{ seq: 1, kind: "thread.turn_started", at: cutoverAt - 50 * MIN, data: json({ operationId: "start:thr_amp1", orb: ampThread }) }, { seq: 2, kind: "orb.polled", at: cutoverAt - 5 * MIN, data: null }]),
			...new Pi().tables(),
		}),
	);
	await writer.dump(
		dump("CodingThread", "thr_cli1", {
			coding_thread: table(threadColumns, [threadRow("thr_cli1", { harness: "claude-code" })]),
			coding_harness_run: table(["id", "operation_id", "status"], [{ id: 1, operation_id: "op:cli-turn-1", status: "running" }]),
			coding_event: table(["seq", "kind", "at", "data"], [{ seq: 1, kind: "thread.turn_started", at: cutoverAt - 20 * MIN, data: null }]),
		}),
	);
	await writer.dump(dump("HostOps", "hostops", { ops: table(["id", "kind", "status"], []), credential: table(["id", "digest"], []) }, { alarm: cutoverAt + MIN }));
	await writer.dump(dump("WorkspaceCatalog", "workspaces", {}, { kv: [] }));

	// Object storage: a hosted app's files, an image and a video, and a sealed coding-vault blob.
	await writer.object("ARTIFACTS", "own_ada/art_1/v1/index.html", Buffer.from("<!doctype html><title>Habit tracker</title>"), "text/html");
	await writer.object("ARTIFACTS", "own_ada/art_1/v1/app.js", Buffer.from("console.log('habits')"), "text/javascript");
	await writer.object("BLOBS", "own_ada/img_1.png", mediaPng, "image/png");
	await writer.object("BLOBS", "own_ada/vid_1.mp4", mediaMp4, "video/mp4");
	await writer.object("BLOBS", "own_ada/vault/claude-code", sealLegacyVaultBlob(Buffer.from("login-archive-bytes"), vaultKeyFromCookieKey(keys.cookieKey), owners.ada, "claude-code"), "application/octet-stream");
	await writer.oauthKv([
		{ key: "client:mcp-1", value: { clientId: "mcp-1", redirectUris: ["https://client.example.test/cb"] } },
		{ key: "token:abcd", value: { grant: "g1", expiresAt: cutoverAt + 86_400_000, hash: "ff".repeat(32) } },
	]);
	await writer.finish({
		cutoverAt,
		exportedAt: cutoverAt + 5 * MIN,
		source: "synthetic-fixture",
		keyMaterial: [
			{ name: "APP_CREDENTIALS_KEY", fingerprint: keyFingerprint(keys.appCredentialsKey) },
			{ name: "directory.cookie_key", fingerprint: keyFingerprint(keys.cookieKey) },
		],
	});
	void LEGACY_PREFIX;
	void nap;
	void httpTool;
	void approvalTool;
	return { keys, owners, chats, amp: { threadId: ampThread, codingThread: "thr_amp1" }, mediaBytes: mediaMp4.length + mediaPng.length };
}

function randomLike(seed: string, length: number) {
	return pseudoBytes(seed, length).toString("base64");
}
void randomBytes;
