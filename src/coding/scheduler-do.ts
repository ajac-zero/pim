import { getAgentByName } from "agents";
import { DurableObject } from "cloudflare:workers";
import type { CodingRepoSettings } from "./api";
import { MAX_SETUP_SCRIPT_BYTES } from "./environment-cache";
import { cliHarness } from "./harness";
import { HarnessLoginFlow, type LoginStatus } from "./harness/login";
import { DEFAULT_SPACE_CAP, type ManagerHealth, ProviderCapacity } from "./provider-capacity";
import {
	type AdmissionConditions,
	CodingScheduler,
	type QueueEntry,
	type QueuePlace,
	type Reconciliation,
	type Released,
	type RequestResult,
	type SchedulerSnapshot,
	type SlotActivity,
	type SlotRequest,
	type Sweep,
} from "./scheduler";
import { CodingThreadIndex, type IndexedThread, type ThreadRecord, type ThreadRegistration } from "./thread-index";
import type { Harness } from "./vault/harnesses";
import { codingVault } from "./vault/vault";
import { DEFAULT_WORKSPACE_IMAGE, workspaceBackends, type WorkspaceProviderRegistry } from "./workspace/registry";
import type { WorkspaceRef } from "./workspace/types";

/**
 * A space's coding scheduler (./scheduler.ts) in a Durable Object of its
 * own, one per space and named by its ID (`codingScheduler`). Its methods
 * are the scheduler's, over RPC, and each runs as one transaction.
 *
 * While a thread is queued or a slot's thread is idle or waiting for the
 * person, an alarm ticks the scheduler every 30 seconds, so deadlines pass
 * and slots are swept without anyone asking; with nothing to do, there is no
 * alarm. Requests and reports of activity set it again.
 *
 * Threads hear of what happens to them without asking: admitted from the
 * queue (other than by their own request, which answers them), expired from
 * it, or their slot taken back by a sweep. Each notice is written to an
 * outbox in the same transaction as the change it tells of, and the alarm
 * hands it to the notifier and deletes it once delivered; one that fails
 * stays for the next alarm, as do the same thread's later notices, so each
 * thread hears of its changes in order. After 20 failed attempts a notice is
 * dead: it stays in the outbox for diagnosis but is never tried again, and
 * no longer holds up the thread's later notices or keeps the alarm set. A
 * notice can arrive twice, such as
 * when it was delivered but the object restarted before deleting it, so
 * each carries a key that never changes, for its receiver to ignore it the
 * second time.
 *
 * It also keeps the space's list of its threads (./thread-index.ts), which
 * says which threads are the space's, and the person's lock on each CLI
 * harness's login (`acquireHarness`), so only one of their threads runs a
 * harness with their subscription at a time. And it hosts the person's
 * sign-in to a harness (`harnessLoginStart`, ./harness/login.ts), whose
 * CLI waits in a workspace between their requests: one per harness, kept
 * in this object's memory, so a restart ends it and deletes its workspace.
 *
 * And it keeps the person's settings for each repository
 * (`repoSettings`), such as the setup script that readies a thread's
 * environment, and the lock that has one of their threads at a time build
 * an environment (`acquireEnvironmentBuild`), so threads that start
 * together don't each run the same setup, and which environments' snapshots
 * weren't worth keeping (`environmentSnapshotSkipped`).
 */
export class CodingSchedulerDO extends DurableObject<Env> {
	readonly #scheduler: CodingScheduler;
	readonly #threads: CodingThreadIndex;
	/** The person's sign-ins under way, by harness. */
	readonly #logins = new Map<Harness, HarnessLoginFlow>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(OUTBOX_SCHEMA);
		ctx.storage.sql.exec(HARNESS_LOCK_SCHEMA);
		ctx.storage.sql.exec(REPO_SETTINGS_SCHEMA);
		this.#scheduler = new CodingScheduler(ctx.storage.sql, {
			transaction: (work) => ctx.storage.transactionSync(work),
			now: () => this.now(),
			defaultLimit: DEFAULT_SPACE_CAP,
		});
		this.#threads = new CodingThreadIndex(ctx.storage.sql);
	}

	/** The clock the scheduler and its alarm go by. */
	protected now(): number {
		return Date.now();
	}

	/** The workspace backends sign-ins make their workspace with: the deployment's, as threads use. */
	protected loginProviders(): WorkspaceProviderRegistry {
		return workspaceBackends(this.env);
	}

	/** Who hears of what happens to threads: each thread's own Durable Object (./thread-do.ts). */
	protected notifier(): SchedulerNotifier {
		return threadNotifier(this.env);
	}

	/** Gives the thread a slot or a place in the queue (`CodingScheduler.request`). */
	async request(threadId: string, request: SlotRequest): Promise<RequestResult> {
		const result = this.#scheduler.request(threadId, request);
		await this.#schedule(false);
		return result;
	}

	/** Frees the thread's slot, and tells the threads admitted into it. */
	async release(threadId: string): Promise<string[]> {
		return this.#changed(() => {
			const admitted = this.#scheduler.release(threadId);
			return { result: admitted, admitted };
		});
	}

	async cancel(threadId: string): Promise<boolean> {
		const cancelled = this.#scheduler.cancel(threadId);
		await this.#schedule(false);
		return cancelled;
	}

	position(threadId: string): QueuePlace | null {
		return this.#scheduler.position(threadId);
	}

	snapshot(): SchedulerSnapshot {
		return this.#scheduler.snapshot();
	}

	/** Sets how many slots the space has: the space's own cap for a provider without a manager, or `refreshConditions` for one with. */
	async setLimit(limit: number): Promise<string[]> {
		return this.#changed(() => {
			const admitted = this.#scheduler.setLimit(limit);
			return { result: admitted, admitted };
		});
	}

	async setConditions(conditions: AdmissionConditions): Promise<string[]> {
		return this.#changed(() => {
			const admitted = this.#scheduler.setConditions(conditions);
			return { result: admitted, admitted };
		});
	}

	/** Sets the conditions and the limit from the workspace manager's `/health`, with the space's cap (./provider-capacity.ts). */
	async refreshConditions(health: ManagerHealth, spaceCap = DEFAULT_SPACE_CAP): Promise<string[]> {
		return this.#changed(() => {
			const admitted = new ProviderCapacity(this.#scheduler, spaceCap).refreshConditions(health);
			return { result: admitted, admitted };
		});
	}

	/** Takes in the workspace manager's refusal of a workspace, by its `code`. */
	async onManagerError(code: string): Promise<string[]> {
		return this.#changed(() => {
			const admitted = new ProviderCapacity(this.#scheduler).onManagerError(code);
			return { result: admitted, admitted };
		});
	}

	async setActivity(threadId: string, activity: SlotActivity): Promise<boolean> {
		const holds = this.#scheduler.setActivity(threadId, activity);
		await this.#schedule(false);
		return holds;
	}

	/** Sweeps now rather than at the next alarm, and tells the threads whose slots it took back and those it admitted. */
	async sweep(): Promise<Sweep> {
		return this.#changed(() => {
			const sweep = this.#scheduler.sweep();
			return { result: sweep, admitted: sweep.admitted, released: sweep.released };
		});
	}

	/** Brings the slots in line with the workspaces running (`CodingScheduler.reconcile`), and tells the threads admitted. Threads released or adopted aren't told: they aren't running, or already are. */
	async reconcile(liveThreadIds: readonly string[]): Promise<Reconciliation> {
		return this.#changed(() => {
			const reconciliation = this.#scheduler.reconcile(liveThreadIds);
			return { result: reconciliation, admitted: reconciliation.admitted };
		});
	}

	/** Enters a thread about to start in the space's list. */
	registerThread(thread: ThreadRegistration): void {
		this.#threads.register(thread);
	}

	/** Takes a thread whose start failed out of the list. */
	forgetThread(threadId: string): void {
		this.#threads.forget(threadId);
	}

	/** The thread's own object bringing its row up to date. */
	recordThread(thread: ThreadRecord): void {
		this.#threads.record(thread);
	}

	/** The person viewed a thread now; false for one that isn't the space's. */
	markThreadSeen(threadId: string): boolean {
		return this.#threads.markSeen(threadId, this.now());
	}

	/** One of the space's threads, with its place in the queue while it waits; null for a thread that isn't the space's. */
	thread(threadId: string): (IndexedThread & { readonly queue: QueuePlace | null }) | null {
		const thread = this.#threads.get(threadId);
		return thread && { ...thread, queue: this.#scheduler.position(threadId) };
	}

	/** The space's threads, newest first, each with its place in the queue while it waits. */
	threads(): (IndexedThread & { readonly queue: QueuePlace | null })[] {
		return this.#threads.list().map((thread) => ({ ...thread, queue: this.#scheduler.position(thread.threadId) }));
	}

	/**
	 * Takes the space's lock on a harness's login for `holder`, a thread, for
	 * at most `ttlMs`: true when it is free, expired or already the holder's
	 * (which renews it), false while another thread holds it.
	 */
	acquireHarness(harness: string, holder: string, ttlMs: number): boolean {
		const now = this.now();
		const held = this.ctx.storage.sql.exec("SELECT holder, expires_at FROM pim_coding_harness_lock WHERE harness = ?", harness).toArray()[0];
		if (held && held.holder !== holder && Number(held.expires_at) > now) return false;
		this.ctx.storage.sql.exec(
			"INSERT INTO pim_coding_harness_lock (harness, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT (harness) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at",
			harness,
			holder,
			now + ttlMs,
		);
		return true;
	}

	/** Lets the lock go, if `holder` holds it. */
	releaseHarness(harness: string, holder: string): void {
		this.ctx.storage.sql.exec("DELETE FROM pim_coding_harness_lock WHERE harness = ? AND holder = ?", harness, holder);
	}

	/** Takes the lock on building the environment with `key` for `holder`, a thread, as `acquireHarness` takes a harness's: true when it is free, expired or the holder's. Keys are hex, so they never meet a harness's name. */
	acquireEnvironmentBuild(key: string, holder: string, ttlMs: number): boolean {
		return this.acquireHarness(`environment:${key}`, holder, ttlMs);
	}

	releaseEnvironmentBuild(key: string, holder: string): void {
		this.releaseHarness(`environment:${key}`, holder);
	}

	/** Whether a build of the environment with `key` found its snapshot not worth keeping (`snapshotWorthKeeping`) in the last `SNAPSHOT_SKIP_TTL_MS`, so threads set it up each time and take no snapshot. */
	environmentSnapshotSkipped(key: string): boolean {
		return this.ctx.storage.sql.exec("SELECT 1 FROM pim_coding_environment_skip WHERE key = ? AND decided_at > ?", key, this.now() - SNAPSHOT_SKIP_TTL_MS).toArray().length > 0;
	}

	/** Records what the latest build of the environment with `key` found, and forgets findings past `SNAPSHOT_SKIP_TTL_MS`. */
	setEnvironmentSnapshotSkipped(key: string, skipped: boolean): void {
		const now = this.now();
		this.ctx.storage.sql.exec("DELETE FROM pim_coding_environment_skip WHERE key = ? OR decided_at <= ?", key, now - SNAPSHOT_SKIP_TTL_MS);
		if (skipped) this.ctx.storage.sql.exec("INSERT INTO pim_coding_environment_skip (key, decided_at) VALUES (?, ?)", key, now);
	}

	/** The person's settings for a repository, `owner/name`; empty ones when they set none. */
	repoSettings(repo: string): CodingRepoSettings {
		const name = repo.toLowerCase();
		const row = this.ctx.storage.sql.exec("SELECT setup_script, updated_at FROM pim_coding_repo_settings WHERE repo = ?", name).toArray()[0];
		return { repo: name, setupScript: row?.setup_script === undefined || row.setup_script === null ? null : String(row.setup_script), updatedAt: row ? Number(row.updated_at) : null };
	}

	/** Sets the person's settings for a repository. A null or blank setup script clears it, so the repository's own `.pim/setup.sh` is used again. */
	setRepoSettings(repo: string, settings: { setupScript: string | null }): CodingRepoSettings {
		const script = settings.setupScript?.trim() ? settings.setupScript : null;
		if (script !== null && new TextEncoder().encode(script).byteLength > MAX_SETUP_SCRIPT_BYTES) throw new Error(`A setup script may be at most ${MAX_SETUP_SCRIPT_BYTES / 1024} KiB`);
		const name = repo.toLowerCase();
		if (script === null) this.ctx.storage.sql.exec("DELETE FROM pim_coding_repo_settings WHERE repo = ?", name);
		else {
			this.ctx.storage.sql.exec(
				"INSERT INTO pim_coding_repo_settings (repo, setup_script, updated_at) VALUES (?, ?, ?) ON CONFLICT (repo) DO UPDATE SET setup_script = excluded.setup_script, updated_at = excluded.updated_at",
				name,
				script,
				this.now(),
			);
		}
		return this.repoSettings(name);
	}

	/**
	 * Starts the person's sign-in to `harness` with their subscription, in a
	 * workspace of theirs, ending one already under way: answers with the URL
	 * to open once the CLI printed it.
	 */
	async harnessLoginStart(userId: string, harness: Harness): Promise<LoginStatus> {
		await this.#forgetLogin(harness);
		const cli = cliHarness(harness);
		if (!cli?.login) return { harness, state: "failed", url: null, userCode: null, error: "This harness has no sign-in Pim can relay" };
		let provider: ReturnType<WorkspaceProviderRegistry["get"]>;
		try {
			const registry = this.loginProviders();
			provider = registry.get(registry.defaultId() ?? "none");
		} catch (error) {
			return { harness, state: "failed", url: null, userCode: null, error: error instanceof Error ? error.message : String(error) };
		}
		const flow = new HarnessLoginFlow({
			harness: cli,
			userId,
			provider,
			image: DEFAULT_WORKSPACE_IMAGE,
			vault: codingVault(this.env),
			remember: (ref) => this.#rememberLogin(harness, ref),
			onConnected: async () => this.#resumeWaiting(harness),
		});
		this.#logins.set(harness, flow);
		return flow.start();
	}

	/** Where the person's sign-in to `harness` is. */
	harnessLoginStatus(harness: Harness): LoginStatus {
		return this.#logins.get(harness)?.status() ?? { harness, state: "none", url: null, userCode: null, error: null };
	}

	/** Hands the code the person pasted to the sign-in under way. */
	async harnessLoginCode(harness: Harness, code: string): Promise<LoginStatus> {
		const flow = this.#logins.get(harness);
		if (!flow) return { harness, state: "none", url: null, userCode: null, error: "No sign-in is under way: start again" };
		return flow.submit(code);
	}

	/** Ends the person's sign-in to `harness`, deleting its workspace. */
	async harnessLoginCancel(harness: Harness): Promise<LoginStatus> {
		await this.#forgetLogin(harness);
		return { harness, state: "none", url: null, userCode: null, error: null };
	}

	/** Ends a sign-in under way, and deletes a workspace a sign-in left behind when this object restarted. */
	async #forgetLogin(harness: Harness): Promise<void> {
		const flow = this.#logins.get(harness);
		this.#logins.delete(harness);
		if (flow) await flow.cancel();
		const left = this.ctx.storage.sql.exec("SELECT ref FROM pim_coding_harness_login WHERE harness = ?", harness).toArray()[0];
		if (!left) return;
		const ref = JSON.parse(String(left.ref)) as WorkspaceRef;
		try {
			await this.loginProviders().get(ref.providerId).destroy(ref);
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.harness_login_destroy_failed", harness, error: String(error) }));
		}
		this.#rememberLogin(harness, null);
	}

	#rememberLogin(harness: Harness, ref: WorkspaceRef | null): void {
		if (ref) this.ctx.storage.sql.exec("INSERT INTO pim_coding_harness_login (harness, ref) VALUES (?, ?) ON CONFLICT (harness) DO UPDATE SET ref = excluded.ref", harness, JSON.stringify(ref));
		else this.ctx.storage.sql.exec("DELETE FROM pim_coding_harness_login WHERE harness = ?", harness);
	}

	/** The person connected `harness` some other way than a sign-in here, such as by giving its API key: their threads that waited for it go on. */
	harnessConnected(harness: Harness): void {
		this.#resumeWaiting(harness);
	}

	/** Goes on with the person's threads that waited for their login to `harness`, now that they signed in. */
	#resumeWaiting(harness: Harness): void {
		const waiting = this.#threads.list().filter((thread) => thread.harness === harness && thread.state === "waiting_input" && thread.stateReason === "login_required");
		const at = this.now();
		for (const thread of waiting) {
			const resumed = this.env.CodingThread.getByName(thread.threadId)
				.continue({ operationId: `login-${at}` })
				.catch((error) => console.warn(JSON.stringify({ event: "pim.coding.harness_resume_failed", thread: thread.threadId, error: String(error) })));
			this.ctx.waitUntil(resumed);
		}
	}

	recordDuration(ms: number): void {
		this.#scheduler.recordDuration(ms);
	}

	etaMs(position: number): number | null {
		return this.#scheduler.etaMs(position);
	}

	/** Ticks the scheduler, delivers the notices waiting, and sets the next alarm if anything is left to do. */
	override async alarm(): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			const tick = this.#scheduler.tick();
			this.#post({ admitted: tick.admitted, released: tick.released, expired: tick.expired });
		});
		await this.#deliver();
		await this.#schedule(false, true);
	}

	/** Runs a change and writes the notices it makes, in one transaction, then has the alarm deliver them at once. */
	async #changed<T>(change: () => { result: T } & Notices): Promise<T> {
		const { result, posted } = this.ctx.storage.transactionSync(() => {
			const { result, ...notices } = change();
			return { result, posted: this.#post(notices) };
		});
		await this.#schedule(posted);
		return result;
	}

	/** Writes the notices to the outbox, released and expired before admitted, as a slot is taken back before it is given again. Returns whether there were any. */
	#post({ admitted = [], released = [], expired = [] }: Notices): boolean {
		const now = this.now();
		const write = (kind: SchedulerNotice["kind"], threadId: string, body: unknown) =>
			this.ctx.storage.sql.exec("INSERT INTO pim_coding_outbox (kind, thread_id, body, created_at) VALUES (?, ?, ?, ?)", kind, threadId, JSON.stringify(body), now);
		for (const entry of released) write("released", entry.threadId, entry);
		for (const entry of expired) write("expired", entry.threadId, entry);
		for (const threadId of admitted) write("admitted", threadId, null);
		return admitted.length + released.length + expired.length > 0;
	}

	/** Hands each live notice to the notifier, oldest first, and deletes those delivered. After one fails, the same thread's later notices wait with it, unless that failure was its last attempt and it is now dead. */
	async #deliver(): Promise<void> {
		const notifier = this.notifier();
		const held = new Set<string>();
		for (const row of this.ctx.storage.sql.exec("SELECT * FROM pim_coding_outbox WHERE dead = 0 ORDER BY seq").toArray()) {
			const notice = noticeOf(row);
			if (held.has(notice.threadId)) continue;
			try {
				if (notice.kind === "admitted") await notifier.admitted(notice.threadId, notice.key);
				else if (notice.kind === "expired") await notifier.expired(notice.entry, notice.key);
				else await notifier.released(notice.released, notice.key);
				this.ctx.storage.sql.exec("DELETE FROM pim_coding_outbox WHERE seq = ?", row.seq);
			} catch (error) {
				const attempts = Number(row.attempts) + 1;
				const dead = attempts >= MAX_NOTICE_ATTEMPTS;
				this.ctx.storage.sql.exec("UPDATE pim_coding_outbox SET attempts = ?, dead = ? WHERE seq = ?", attempts, dead ? 1 : 0, row.seq);
				if (dead) console.error(JSON.stringify({ event: "pim.coding.notice_dead", key: notice.key, attempts, error: String(error) }));
				else {
					held.add(notice.threadId);
					console.warn(JSON.stringify({ event: "pim.coding.notice_failed", key: notice.key, attempts, error: String(error) }));
				}
			}
		}
	}

	/**
	 * Sets the alarm while there is something to do: live notices to deliver, a
	 * thread queued, or a slot's thread idle or waiting. Notices just posted
	 * go at once; otherwise the next tick is in 30 seconds, or sooner if the
	 * alarm is already set sooner. With nothing to do, the alarm is deleted.
	 * The alarm itself `replace`s its own time, since it has just run.
	 */
	async #schedule(urgent: boolean, replace = false): Promise<void> {
		const pending = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pim_coding_outbox WHERE dead = 0").one().n !== 0;
		const { queued, running } = this.#scheduler.snapshot();
		if (!pending && queued.length === 0 && running.every((slot) => slot.activity === "running")) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const at = this.now() + (urgent ? 0 : TICK_MS);
		const current = replace ? null : await this.ctx.storage.getAlarm();
		if (current === null || at < current) await this.ctx.storage.setAlarm(at);
	}
}

/** How often the alarm ticks the scheduler while there is something to do. */
export const TICK_MS = 30_000;

/** How many times a notice is tried before it is dead. */
export const MAX_NOTICE_ATTEMPTS = 20;

/**
 * Who hears of what happens to a space's coding threads. Each method gets
 * the notice's key, the same every time that notice is delivered, and
 * throws when the notice wasn't taken, to have it delivered again later.
 * Coding threads' Durable Objects implement it, each for its own thread
 * (`threadNotifier`).
 */
export interface SchedulerNotifier {
	/** The thread was admitted from the queue and holds a slot: it may start its workspace. */
	admitted(threadId: string, key: string): void | Promise<void>;
	/** The thread waited past its deadline and left the queue; `entry.reason` is what it waited for. */
	expired(entry: QueueEntry, key: string): void | Promise<void>;
	/** A sweep took the thread's slot back: it checkpoints its work and destroys its workspace, and for `preempted` asks again then. */
	released(released: Released, key: string): void | Promise<void>;
}

/** Tells nobody: every notice counts as delivered. */
export const noopNotifier: SchedulerNotifier = { admitted() {}, expired() {}, released() {} };

/** Tells each thread's Durable Object, which ignores a notice it already took by its key. A thread that can't be reached throws, so the notice is delivered again later. */
export function threadNotifier(env: Env): SchedulerNotifier {
	return {
		admitted: (threadId, key) => env.CodingThread.getByName(threadId).admitted(key),
		expired: (entry, key) => env.CodingThread.getByName(entry.threadId).expired(entry, key),
		released: (released, key) => env.CodingThread.getByName(released.threadId).released(released, key),
	};
}

/** A notice as delivered. */
export type SchedulerNotice = { readonly key: string; readonly threadId: string } & (
	| { readonly kind: "admitted" }
	| { readonly kind: "expired"; readonly entry: QueueEntry }
	| { readonly kind: "released"; readonly released: Released }
);

/** The space's coding scheduler. */
export function codingScheduler(env: Env, spaceId: string): DurableObjectStub<CodingSchedulerDO> {
	return env.CodingScheduler.getByName(spaceId);
}

/** Tells the space's open pages its list of coding threads changed, on the socket that refreshes the chat list. Best-effort: the list is right on the next fetch. */
export async function codingThreadsChanged(env: Env, spaceId: string): Promise<void> {
	try {
		await (await getAgentByName(env.Pim, spaceId)).codingThreadsChanged();
	} catch (error) {
		console.warn(JSON.stringify({ event: "pim.coding.broadcast_failed", error: String(error) }));
	}
}

type Notices = { readonly admitted?: readonly string[]; readonly released?: readonly Released[]; readonly expired?: readonly QueueEntry[] };

/** Its `seq` is never reused, even once a notice is deleted, so a notice's key (from it) is never another's. */
const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_coding_outbox (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	dead INTEGER NOT NULL DEFAULT 0
);
`;

/** Which thread holds the person's login for each harness, until when; and the workspace of each sign-in under way, to delete after a restart. */
const HARNESS_LOCK_SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_coding_harness_lock (
	harness TEXT PRIMARY KEY,
	holder TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_coding_harness_login (
	harness TEXT PRIMARY KEY,
	ref TEXT NOT NULL
);
`;

/** The person's settings for each of their repositories, by lowercase `owner/name`. */
/** How long a finding that an environment's snapshot isn't worth keeping holds; after it, the next build takes one and decides again. */
const SNAPSHOT_SKIP_TTL_MS = 30 * 24 * 60 * 60_000;

const REPO_SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_coding_repo_settings (
	repo TEXT PRIMARY KEY,
	setup_script TEXT,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_coding_environment_skip (
	key TEXT PRIMARY KEY,
	decided_at INTEGER NOT NULL
);
`;

function noticeOf(row: Record<string, SqlStorageValue>): SchedulerNotice {
	const kind = String(row.kind) as SchedulerNotice["kind"];
	const threadId = String(row.thread_id);
	const key = `coding:${kind}:${threadId}:${row.seq}`;
	const body = JSON.parse(String(row.body));
	if (kind === "expired") return { key, threadId, kind, entry: body as QueueEntry };
	if (kind === "released") return { key, threadId, kind, released: body as Released };
	return { key, threadId, kind };
}
