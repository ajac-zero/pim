// The Forge facade: one authorized surface for REST (`/api/coding/**`) and agent tools (`coding_*`). Both call these methods with an Actor, so a route and a tool can't disagree about who may do what.
import { type OrbClient } from "@pim/coding/orb/types";
import { type Actor, Authz, assertCapability, assertPushBranch, repoName, type Permission } from "./authz";
import { type ComputeProvider } from "./compute";
import { type Db, type Row, tx } from "./db";
import { ForbiddenError, ForgeError } from "./errors";
import { HARNESSES, capabilitiesOf, type Harness } from "./harnesses";
import { type GitHost, type Objects, type OrbClients } from "./ports";
import { type ForgeScheduler } from "./scheduler";
import { type ForgeStore, type ThreadRow } from "./store";
import { type Credentials } from "./tokens";

export type ForgeConfig = {
	db: Db;
	store: ForgeStore;
	authz: Authz;
	scheduler: ForgeScheduler;
	credentials: Credentials;
	git: GitHost;
	objects: Objects;
	orbs: OrbClients;
	compute: ComputeProvider | null;
	/** Whether this deployment holds an Amp credential at all. */
	ampConfigured: boolean;
};

export type StartRequest = { operationId: string; harness?: Harness; task: string; repo: string; ref?: string; chatId?: string; budgetUsd?: number | null; pool?: string; profile?: object };
export type Gated<T> = ({ status: "done" } & T) | { status: "approval_required"; approvalId: string };

export class Forge {
	constructor(private readonly c: ForgeConfig) {}

	private async own(actor: Actor, ref: string): Promise<ThreadRow> {
		if (actor.role === "guest") throw new ForbiddenError("coding", "guests can't use coding threads");
		return this.c.store.find(actor.ownerId, ref);
	}

	/** Re-verifies the actor's grant against the thread's repository: called before every privileged action, never cached. */
	private async allow(actor: Actor, permission: Permission, t: ThreadRow) {
		return this.c.authz.check(actor, permission, { repo: t.repo, pool: t.placement?.pool ?? null });
	}

	async start(actor: Actor, req: StartRequest): Promise<{ threadId: string; created: boolean; harness: Harness }> {
		const harness = req.harness ?? "pi";
		if (!(HARNESSES as readonly string[]).includes(harness)) throw new ForgeError("invalid", `Unknown harness ${harness}`);
		if (typeof req.task !== "string" || !req.task.trim()) throw new ForgeError("invalid", "A coding thread needs a task");
		if (typeof req.operationId !== "string" || !req.operationId || req.operationId.length > 200) throw new ForgeError("invalid", "A coding thread needs an operationId");
		if (!repoName(req.repo)) throw new ForgeError("invalid", `Not a repository: ${req.repo}`);
		if (harness === "amp" && req.pool && req.pool !== "orbs") throw new ForgeError("invalid", "Amp threads run in orbs, not in a pool");
		// Permission first (a person without a grant learns that, not what the deployment lacks), then whether the deployment can run it at all.
		await this.c.authz.check(actor, "coding:start", { repo: req.repo, pool: harness === "amp" ? null : (req.pool ?? null) });
		await assertCapability(this.c.db, harness, this.c.ampConfigured, req.pool);
		await tx(this.c.db, (q) => this.c.scheduler.checkQuota(q, actor.ownerId, actor.tenantId ?? null, { startingWorkspaceThread: false }));
		const { thread, created } = await this.c.store.start({ ownerId: actor.ownerId, operationId: req.operationId, harness, task: req.task, repo: req.repo, ref: req.ref, chatId: req.chatId, createdBy: actor.agent ? `agent:${actor.agent}` : actor.ownerId, budgetUsd: req.budgetUsd, profile: req.profile }, this.c.authz.policy.branchPrefix);
		if (created) {
			await this.c.store.locked(thread.threadId, async (q) => {
				if (req.pool) await this.c.store.patch(q, thread.threadId, { placement: { pool: req.pool } });
				if (harness !== "amp") await this.c.store.enqueueInbox(q, thread.threadId, req.operationId, "start", { prompt: req.task });
				await this.c.store.emit(q, "projection", `created:${thread.threadId}`, thread.threadId, { type: "coding.created", threadId: thread.threadId, harness });
			});
		}
		return { threadId: thread.threadId, created, harness };
	}

	async status(actor: Actor, ref: string) {
		const t = await this.own(actor, ref);
		return { ...t, capabilities: capabilitiesOf(t.harness) };
	}

	async steer(actor: Actor, ref: string, text: string, operationId: string): Promise<{ queued: boolean }> {
		const t = await this.own(actor, ref);
		await this.allow(actor, "coding:steer", t);
		if (t.state === "archived") throw new ForgeError("archived", "This thread is archived");
		if (t.state === "failed" && t.stateReason === "budget" ) throw new ForgeError("budget_spent", "The thread's budget is spent");
		return this.c.store.locked(t.threadId, async (q) => ({ queued: await this.c.store.enqueueInbox(q, t.threadId, operationId, "steer", { prompt: text }) }));
	}

	/** Stops the turn: `requested` at once, `cancelled` once the work has really stopped, `cancel_uncertain` when the remote can't say. Credentials die immediately. */
	async abort(actor: Actor, ref: string): Promise<{ cancelState: ThreadRow["cancelState"] }> {
		const t = await this.own(actor, ref);
		await this.allow(actor, "coding:abort", t);
		await this.c.store.locked(t.threadId, async (q) => {
			await this.c.store.patch(q, t.threadId, { cancel_state: "requested" });
			await this.c.store.revokeCredentials(q, t.threadId);
			await q.query("delete from pim_forge.forge_inbox where thread_id = $1 and status = 'pending'", [t.threadId]);
		});
		let state: ThreadRow["cancelState"] = "requested";
		if (capabilitiesOf(t.harness).family === "remote-orb" && t.orb) {
			const client = await this.c.orbs(t);
			state = await this.cancelOrb(client, t.orb.threadId);
		} else if (t.state !== "running") state = "cancelled";
		await this.c.store.locked(t.threadId, async (q, cur) => {
			if (state !== "requested") await this.c.store.patch(q, t.threadId, { cancel_state: state });
			if (state === "cancelled" && cur.state === "running") await this.c.store.setState(q, t.threadId, "idle", "aborted");
		});
		return { cancelState: state };
	}

	private async cancelOrb(client: OrbClient | null, orbId: string): Promise<ThreadRow["cancelState"]> {
		try {
			if (!client) return "uncertain";
			if (client.cancel) await client.cancel(orbId);
			else await client.stop(orbId);
			return "cancelled";
		} catch {
			return "uncertain";
		}
	}

	/** The transcript's messages: the newest `tail` when asked, and one role when asked. */
	async transcript(actor: Actor, ref: string, o: { tail?: number; role?: "user" | "assistant" } = {}) {
		const t = await this.own(actor, ref);
		return { events: await this.c.store.events(t.threadId, { role: o.role, kind: "message", tail: o.tail }) };
	}

	/** Only the thread's last assistant message (coding_transcript_output). */
	async transcriptOutput(actor: Actor, ref: string): Promise<{ text: string }> {
		const t = await this.own(actor, ref);
		const last = (await this.c.store.events(t.threadId, { role: "assistant", kind: "message", tail: 1 }))[0];
		return { text: last?.data?.text ?? "" };
	}

	async diff(actor: Actor, ref: string): Promise<{ source: "workspace" | "orb"; diff: string; unpushedOrb: boolean }> {
		const t = await this.own(actor, ref);
		if (capabilitiesOf(t.harness).diff === "remote-git-host") {
			const branch = t.orb?.branch as string | undefined;
			const diff = branch ? await this.c.git.remoteDiff(t.repo, branch) : null;
			// The orb's work is only visible once it's on the git host: say so instead of showing an empty diff.
			const out = { source: "orb" as const, diff: diff ?? "", unpushedOrb: diff === null };
			await this.saveDiff(t, out);
			return out;
		}
		if (t.workspaceRef && this.c.compute && !t.computeTornDownAt) {
			const r = await this.c.compute.exec(t.workspaceRef, ["git", "diff", "HEAD"], {});
			const out = { source: "workspace" as const, diff: r.stdout, unpushedOrb: false };
			await this.saveDiff(t, out);
			return out;
		}
		const last = (await this.c.db.query<Row>("select source, diff, unpushed_orb from pim_forge.forge_diffs where thread_id = $1 order by seq desc limit 1", [t.threadId])).rows[0];
		return { source: last?.source ?? "workspace", diff: last?.diff ?? "", unpushedOrb: last?.unpushed_orb ?? false };
	}

	private async saveDiff(t: ThreadRow, d: { source: string; diff: string; unpushedOrb: boolean }) {
		await this.c.db.query("insert into pim_forge.forge_diffs (thread_id, seq, source, unpushed_orb, diff) select $1, coalesce(max(seq), 0) + 1, $2, $3, $4 from pim_forge.forge_diffs where thread_id = $1", [t.threadId, d.source, d.unpushedOrb, d.diff]);
	}

	async runTests(actor: Actor, ref: string, command: string[]) {
		const t = await this.own(actor, ref);
		await this.allow(actor, "coding:steer", t);
		if (!t.workspaceRef || !this.c.compute || t.computeTornDownAt) throw new ForgeError("workspace_not_running", "This thread has no running workspace");
		const r = await this.c.compute.exec(t.workspaceRef, command, { timeoutMs: 15 * 60_000 });
		await this.c.db.query("insert into pim_forge.forge_test_runs (thread_id, seq, command, exit_code, output) select $1, coalesce(max(seq), 0) + 1, $2, $3, $4 from pim_forge.forge_test_runs where thread_id = $1", [t.threadId, command.join(" "), r.code, (r.stdout + r.stderr).slice(-20_000)]);
		return { exitCode: r.code, output: r.stdout + r.stderr };
	}

	async tests(actor: Actor, ref: string) {
		const t = await this.own(actor, ref);
		return (await this.c.db.query<Row>("select seq, command, exit_code, output, at from pim_forge.forge_test_runs where thread_id = $1 order by seq", [t.threadId])).rows;
	}

	/** Permission, then (when the grant says so) a human's yes. A permission is not an approval: both are required where policy says. */
	private async gate(actor: Actor, permission: Permission, action: string, t: ThreadRow): Promise<{ approvalId: string } | null> {
		const d = await this.allow(actor, permission, t);
		if (d.requiresApproval && !(await this.c.authz.approved(t.threadId, action))) return { approvalId: await this.c.authz.requestApproval(t.threadId, action) };
		return null;
	}

	private workspaceOf(t: ThreadRow) {
		if (!capabilitiesOf(t.harness).forgePush) throw new ForgeError("unsupported", "Pim can't push or merge an Amp thread: Amp pushes with its own credentials");
		if (!t.workspaceRef || !this.c.compute || t.computeTornDownAt) throw new ForgeError("workspace_not_running", "This thread has no running workspace");
		return t.workspaceRef;
	}

	async push(actor: Actor, ref: string): Promise<Gated<{ outcome: "pushed" | "unchanged"; sha: string; branch: string }>> {
		const t = await this.own(actor, ref);
		const ws = this.workspaceOf(t);
		const pending = await this.gate(actor, "coding:push", "push", t);
		if (pending) return { status: "approval_required", ...pending };
		const branch = t.branch!;
		assertPushBranch(this.c.authz.policy, branch, await this.c.git.defaultBranch(t.repo));
		const r = await this.c.git.push(ws, t.repo, branch);
		await this.c.store.locked(t.threadId, (q) => this.c.store.patch(q, t.threadId, { last_pushed_sha: r.sha }));
		await this.c.authz.consumeApproval(t.threadId, "push");
		return { status: "done", ...r, branch };
	}

	async openPullRequest(actor: Actor, ref: string, title?: string): Promise<Gated<{ url: string; number: number }>> {
		const t = await this.own(actor, ref);
		const pending = await this.gate(actor, "coding:pr", "pr", t);
		if (pending) return { status: "approval_required", ...pending };
		const branch = (t.branch ?? (t.orb?.branch as string | undefined)) ?? null;
		if (!branch || !(await this.c.git.hasBranch(t.repo, branch))) throw new ForgeError("not_pushed", "The thread's branch isn't on the git host yet");
		const pr = await this.c.git.openPullRequest(t.repo, branch, await this.c.git.defaultBranch(t.repo), title ?? t.task.slice(0, 120));
		await this.c.store.locked(t.threadId, (q) => this.c.store.patch(q, t.threadId, { pull_request: pr }));
		await this.c.authz.consumeApproval(t.threadId, "pr");
		return { status: "done", ...pr };
	}

	/** The only way onto the default branch: fast-forward, else rebase, never force; a conflict aborts and changes nothing. */
	async merge(actor: Actor, ref: string): Promise<Gated<{ outcome: "merged" | "conflict"; method?: string; detail?: string }>> {
		const t = await this.own(actor, ref);
		const ws = this.workspaceOf(t);
		const pending = await this.gate(actor, "coding:merge", "merge", t);
		if (pending) return { status: "approval_required", ...pending };
		const r = await this.c.git.merge(ws, t.repo, t.branch!);
		if (r.outcome === "merged") await this.c.authz.consumeApproval(t.threadId, "merge");
		return { status: "done", ...r };
	}

	/** Archive stops the turn, cuts credentials, frees the slot and tears down the workspace; transcript, diffs, tests and checkpoints stay readable. */
	async archive(actor: Actor, ref: string): Promise<void> {
		const t = await this.own(actor, ref);
		await this.c.store.locked(t.threadId, async (q, cur) => {
			if (cur.state === "archived") return;
			if (cur.state === "running") await this.c.store.patch(q, t.threadId, { cancel_state: "requested" });
			await this.c.store.revokeCredentials(q, t.threadId);
			await q.query("delete from pim_forge.forge_inbox where thread_id = $1 and status = 'pending'", [t.threadId]);
			await q.query("update pim_forge.forge_threads set state = 'archived', archived_at = now(), updated_at = now() where thread_id = $1", [t.threadId]);
			await this.c.store.emit(q, "projection", `archived:${t.threadId}`, t.threadId, { type: "coding.archived", threadId: t.threadId });
		});
		await this.c.scheduler.release(t.threadId, "archived");
		await this.teardownCompute(actor, ref);
	}

	/** Records the branch the remote orb pushed to, so its diff can be read from the git host. */
	async recordOrbBranch(threadId: string, branch: string): Promise<void> {
		await this.c.store.locked(threadId, async (q, t) => {
			if (t.orb) await this.c.store.patch(q, threadId, { orb: { ...t.orb, branch } });
		});
	}

	/** Deletes the workspace compute only. */
	async teardownCompute(actor: Actor, ref: string): Promise<void> {
		const t = await this.own(actor, ref);
		if (t.workspaceRef && this.c.compute && !t.computeTornDownAt) {
			await this.c.compute.destroy(t.workspaceRef);
			await this.c.store.locked(t.threadId, (q) => this.c.store.patch(q, t.threadId, { compute_torn_down_at: new Date() }));
		}
	}

	/** Deletes stored artifacts (autosave bundle) only; the transcript stays. */
	async deleteArtifacts(actor: Actor, ref: string): Promise<void> {
		const t = await this.own(actor, ref);
		const a = (await this.c.db.query<Row>("delete from pim_forge.forge_autosaves where thread_id = $1 returning object_key", [t.threadId])).rows[0];
		if (a) await this.c.objects.delete(a.object_key);
	}

	/** Deletes the branch on the git host: its own operation, needing the push grant. */
	async deleteRemoteBranch(actor: Actor, ref: string): Promise<void> {
		const t = await this.own(actor, ref);
		await this.allow(actor, "coding:push", t);
		if (!t.branch) throw new ForgeError("not_pushed", "This thread has no branch of its own");
		assertPushBranch(this.c.authz.policy, t.branch, await this.c.git.defaultBranch(t.repo));
		await this.c.git.deleteBranch(t.repo, t.branch);
	}

	/** A git bundle of the checkout goes to Objects; PostgreSQL keeps only the row that finds it. */
	async autosave(threadId: string): Promise<void> {
		const t = await this.c.store.get(threadId);
		if (!t?.workspaceRef || !this.c.compute || t.computeTornDownAt) return;
		const r = await this.c.compute.exec(t.workspaceRef, ["sh", "-c", "git bundle create ../autosave.bundle HEAD >&2 && base64 -w0 ../autosave.bundle"], {});
		if (r.code !== 0) return;
		const bytes = Buffer.from(r.stdout, "base64");
		const head = (await this.c.compute.exec(t.workspaceRef, ["git", "rev-parse", "HEAD"], {})).stdout.trim();
		const key = `forge/${threadId}/autosave/${head}.bundle`;
		await this.c.objects.put(key, bytes, { contentType: "application/x-git-bundle" });
		await this.c.db.query("insert into pim_forge.forge_autosaves (thread_id, head_sha, object_key, bytes) values ($1,$2,$3,$4) on conflict (thread_id) do update set head_sha = $2, object_key = $3, bytes = $4, at = now()", [threadId, head, key, bytes.length]);
	}

	/** Hands undelivered outbox rows to `deliver` (Live, the originating chat's inbox, the cost ledger), exactly one consumer per row. */
	async deliverOutbox(deliver: (row: { id: number; topic: string; dedupeKey: string; payload: any }) => Promise<void>, limit = 100): Promise<number> {
		return tx(this.c.db, async (q) => {
			const rows = (await q.query<Row>("select * from pim_forge.forge_outbox where delivered_at is null order by id limit $1 for update skip locked", [limit])).rows;
			for (const r of rows) {
				await deliver({ id: Number(r.id), topic: r.topic, dedupeKey: r.dedupe_key, payload: r.payload });
				await q.query("update pim_forge.forge_outbox set delivered_at = now() where id = $1", [r.id]);
			}
			return rows.length;
		});
	}
}
