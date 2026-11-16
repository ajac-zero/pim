import { createHash } from "node:crypto";
import type { CliHarness, HarnessEvent, HarnessTurn } from "@pim/coding/harness/types";
import { type HarnessAuth, HarnessRunner, type RunRecord } from "@pim/coding/harness/runner";
import type { OrbClient } from "@pim/coding/orb/types";
import type { Workspace, WorkspaceProvider, WorkspaceRef, WorkspaceSpec } from "@pim/coding/workspace/types";
import { type Actor, enforce } from "@pim/core/authz";
import { type Lease } from "@pim/core/partitions";
import { type Q, withTenant } from "@pim/core/db";
import { type Effector, type OpState, beginOp, requestCancel, runOp, settleCancel } from "@pim/core/ops";
import type { Harness } from "@pim/shared/harnesses";
import type pg from "pg";

/**
 * Forge: the coding control plane. It is a separate execution class from ordinary chat: it needs an explicit
 * execution grant (never implied by role or by an agent's tool permission), it records every paid start as an
 * external operation with its handle before control is relinquished, and a restart adopts or reconciles what is
 * running instead of starting it again.
 */
export interface ForgeDeps {
	/** pim_runtime: runs, events and operations. */
	pool: pg.Pool;
	/** The pool authorization reads credentials and grants through (pim_gate). */
	authz: pg.Pool;
	workspaces: WorkspaceProvider;
	/** The agent-hosted harness (Amp) is driven through this client. */
	orb?: OrbClient;
	/** The CLI harnesses (Claude Code, Codex, Mistral Vibe), from @pim/coding. */
	harnesses: Partial<Record<Harness, CliHarness>>;
	/** How a CLI signs in for a person's run. Vault injection is the deployment's. */
	authFor(tenantId: string, harness: Harness): HarnessAuth;
	workspaceSpec(input: { tenantId: string; opId: string; repo: string; branch: string; harness: Harness }): WorkspaceSpec;
	/** The most events a run keeps; the rest are counted. */
	maxEvents?: number;
	lease?: Lease;
}

export interface StartRun {
	opId: string;
	harness: Harness;
	repo: string;
	pool?: string;
	branch?: string;
	task: string;
	budgetUsd?: number;
	approvalId?: string;
}

const key = (tenantId: string, opId: string) => createHash("sha256").update(`${tenantId}\u0000${opId}`).digest("hex").slice(0, 32);

export class Forge {
	/** Runs this process is driving; a run not in here after a restart is adopted or reconciled, not re-run. */
	readonly driving = new Map<string, { runner?: HarnessRunner; done: Promise<void> }>();

	constructor(readonly deps: ForgeDeps) {}

	/** The workspace name for a run: unique per tenant and run, so two tenants never share one and a retry finds its own. */
	sessionOf(tenantId: string, opId: string): string {
		return `forge-${key(tenantId, opId)}`;
	}

	async start(actor: Actor, req: StartRun): Promise<{ state: OpState; duplicate: boolean }> {
		const tenantId = actor.principal.tenantId;
		const decision = await enforce(this.deps.authz, actor, "coding.run", { tenantId, pool: req.pool, repo: req.repo, tool: actor.agent ? "coding_start" : undefined, approvalId: req.approvalId });
		const harness = req.harness;
		let launched = false;
		const effector: Effector = {
			send: async (opKey, _request, recordHandle) => {
				launched = true;
				const branch = req.branch ?? `pim/${opKey.slice(0, 8)}`;
				if (harness === "amp") {
					if (!this.deps.orb) throw new Error("No agent-hosted client is configured for Amp");
					// The client's start is idempotent on this key: a retry after an ambiguous failure is the same remote thread.
					const thread = await this.deps.orb.start({ project: req.repo, prompt: req.task, mode: null, title: null, idempotencyKey: opKey });
					await recordHandle({ harness, orb: thread });
					await this.#insertRun(tenantId, req, actor.principal.userId, decision.grantId, { orb: thread }, null);
				} else {
					const ref = await this.deps.workspaces.create(this.deps.workspaceSpec({ tenantId, opId: req.opId, repo: req.repo, branch, harness }));
					await recordHandle({ harness, workspace: ref, sessionId: this.sessionOf(tenantId, req.opId) });
					await this.#insertRun(tenantId, req, actor.principal.userId, decision.grantId, null, ref);
				}
				return { started: true };
			},
		};
		const result = await runOp({ pool: this.deps.pool, lease: this.deps.lease }, { tenantId, opId: req.opId, kind: "coding.run", idempotent: false, request: { harness, repo: req.repo, task: req.task }, grantId: decision.grantId }, effector);
		// Only the call that made the effect drives the run: a repeated start finds the operation done and starts nothing.
		if (launched && result.state === "succeeded") this.drive(tenantId, req);
		return { state: result.state, duplicate: result.state === "succeeded" && result.receipt === null };
	}

	async #insertRun(tenantId: string, req: StartRun, userId: string, grantId: string | undefined, orb: unknown, ref: WorkspaceRef | null) {
		await withTenant(this.deps.pool, tenantId, (q) =>
			q.run("INSERT INTO app.coding_runs (tenant_id, op_id, harness, repo, pool, branch, state, session_id, workspace, created_by, grant_id) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8, $9, $10) ON CONFLICT DO NOTHING", tenantId, req.opId, req.harness, req.repo, req.pool ?? null, req.branch ?? null, this.sessionOf(tenantId, req.opId), JSON.stringify(ref ?? orb ?? {}), userId, grantId ?? null),
		);
	}

	/** Runs the turn and ingests its events. Not awaited by `start`: the run's progress is in PostgreSQL, not in this process. */
	drive(tenantId: string, req: StartRun): Promise<void> {
		const id = `${tenantId}:${req.opId}`;
		const entry: { runner?: HarnessRunner; done: Promise<void> } = { done: Promise.resolve() };
		entry.done = this.#drive(tenantId, req, entry).finally(() => this.driving.delete(id));
		this.driving.set(id, entry);
		return entry.done;
	}

	async #drive(tenantId: string, req: StartRun, entry: { runner?: HarnessRunner }): Promise<void> {
		try {
			if (req.harness === "amp") return await this.#driveAmp(tenantId, req);
			const harness = this.deps.harnesses[req.harness];
			if (!harness) throw new Error(`Harness ${req.harness} is not configured`);
			const run = await this.#run(tenantId, req.opId);
			const workspace = await this.deps.workspaces.get(run.workspace as WorkspaceRef);
			if (!workspace) return await this.#finishRun(tenantId, req.opId, "failed", { reason: "workspace_lost" });
			const runner = new HarnessRunner({
				harness,
				workspace,
				auth: this.deps.authFor(tenantId, req.harness),
				credentials: { restore: async () => ({ connected: true }) as never, writeBack: async () => undefined },
				lock: { acquire: async () => true, release: async () => undefined },
				journal: { save: (record: RunRecord) => void withTenant(this.deps.pool, tenantId, (q) => q.run("UPDATE app.coding_runs SET journal = $3, updated_at = now() WHERE tenant_id = $1 AND op_id = $2", tenantId, req.opId, JSON.stringify(record))), clear: () => void withTenant(this.deps.pool, tenantId, (q) => q.run("UPDATE app.coding_runs SET journal = NULL WHERE tenant_id = $1 AND op_id = $2", tenantId, req.opId)) },
				onEvent: (event) => this.#ingest(tenantId, req.opId, event),
			});
			entry.runner = runner;
			const prepared = await runner.prepare(req.opId, { sessionId: this.sessionOf(tenantId, req.opId), resume: false });
			if (prepared.status !== "ready") return await this.#finishRun(tenantId, req.opId, "failed", { reason: prepared.status });
			const turn: HarnessTurn = { prompt: req.task, sessionId: this.sessionOf(tenantId, req.opId), resume: false, maxBudgetUsd: req.budgetUsd ?? null, model: null, instructions: "", sessionBefore: { costUsd: 0, usage: null } };
			const result = await runner.run(turn, 60 * 60_000);
			await this.#finishRun(tenantId, req.opId, result.status === "done" ? "done" : result.reason === "aborted" ? "cancelled" : "failed", { reason: result.reason ?? null, detail: result.detail ?? null }, result.sessionCostUsd);
		} catch (error) {
			await this.#finishRun(tenantId, req.opId, "failed", { error: (error as Error).message }).catch(() => undefined);
		}
	}

	async #driveAmp(tenantId: string, req: StartRun): Promise<void> {
		const orb = this.deps.orb!;
		const run = await this.#run(tenantId, req.opId);
		const thread = (run.workspace as { orb: { threadId: string } }).orb;
		await this.syncAmp(tenantId, req.opId, thread.threadId, orb);
	}

	/** Reads an agent-hosted thread once: new messages become events (after the stored cursor), and an idle or errored thread ends the run. */
	async syncAmp(tenantId: string, opId: string, threadId: string, orb: OrbClient): Promise<"running" | "done" | "failed"> {
		const run = await this.#run(tenantId, opId);
		const after = (await withTenant(this.deps.pool, tenantId, (q) => q.get<{ payload: { id: string } }>("SELECT payload FROM app.coding_events WHERE tenant_id = $1 AND op_id = $2 AND kind = 'message' ORDER BY cursor DESC LIMIT 1", tenantId, opId), { readOnly: true }))?.payload.id;
		for (const message of await orb.messages(threadId, after ? { after } : {})) await this.#event(tenantId, opId, "message", { id: message.id, role: message.role, text: message.text.slice(0, 4000) });
		const status = await orb.state(threadId);
		void run;
		if (status.state === "working" || status.state === "awaiting_approval") return "running";
		const usage = await orb.usage?.(threadId).catch(() => null);
		await this.#finishRun(tenantId, opId, status.state === "error" ? "failed" : "done", { orbState: status.state }, usage?.usd ?? null);
		return status.state === "error" ? "failed" : "done";
	}

	async #run(tenantId: string, opId: string) {
		return (await withTenant(this.deps.pool, tenantId, (q) => q.get<{ harness: Harness; workspace: any; state: string; session_id: string; journal: RunRecord | null; grant_id: string | null; cost_usd: string | null }>("SELECT harness, workspace, state, session_id, journal, grant_id, cost_usd FROM app.coding_runs WHERE tenant_id = $1 AND op_id = $2", tenantId, opId), { readOnly: true }))!;
	}

	async #ingest(tenantId: string, opId: string, event: HarnessEvent): Promise<void> {
		if (event.type === "delta") return; // partial text is not stored: the complete message is
		await this.#event(tenantId, opId, event.type, event as unknown as Record<string, unknown>);
	}

	/** Appends one event, bounded: past the cap the oldest is deleted and counted, so a transcript flood costs a counter, not the table. */
	async #event(tenantId: string, opId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
		const cap = this.deps.maxEvents ?? 2000;
		await withTenant(this.deps.pool, tenantId, async (q: Q) => {
			const cursor = (await q.get<{ cursor: number }>("UPDATE app.coding_runs SET cursor = cursor + 1, updated_at = now() WHERE tenant_id = $1 AND op_id = $2 RETURNING cursor", tenantId, opId))!.cursor;
			await q.run("INSERT INTO app.coding_events (tenant_id, op_id, cursor, kind, payload) VALUES ($1, $2, $3, $4, $5)", tenantId, opId, cursor, kind, JSON.stringify(payload));
			if (cursor > cap) {
				const gone = await q.run("DELETE FROM app.coding_events WHERE tenant_id = $1 AND op_id = $2 AND cursor <= $3", tenantId, opId, cursor - cap);
				if (gone > 0) await q.run("UPDATE app.coding_runs SET dropped = dropped + $3 WHERE tenant_id = $1 AND op_id = $2", tenantId, opId, gone);
			}
		});
	}

	async #finishRun(tenantId: string, opId: string, state: "done" | "failed" | "cancelled" | "interrupted", result: Record<string, unknown>, costUsd?: number | null): Promise<void> {
		await withTenant(this.deps.pool, tenantId, async (q) => {
			const run = await q.get<{ grant_id: string | null }>("UPDATE app.coding_runs SET state = $3, result = $4, cost_usd = COALESCE($5::numeric, cost_usd), updated_at = now() WHERE tenant_id = $1 AND op_id = $2 AND state IN ('running', 'provisioning', 'interrupted') RETURNING grant_id", tenantId, opId, state, JSON.stringify(result), costUsd ?? null);
			// Spend lands on the grant that authorized the run, so a spend cap sees it. Rounded up to a whole cent: a cap is never undercounted.
			if (run?.grant_id && costUsd) await q.run("UPDATE app.execution_grants SET spent_cents = spent_cents + $3 WHERE tenant_id = $1 AND grant_id = $2", tenantId, run.grant_id, Math.ceil(costUsd * 100));
		});
	}

	/**
	 * After a restart: every run this process is not driving is looked at once. An agent-hosted thread is read by its handle;
	 * a CLI run's CLI is stopped and its turn ends `interrupted`, never silently run again (`recoverRun` in @pim/coding).
	 * A person or policy then resumes it explicitly, as a new authorized operation.
	 */
	async reconcile(tenantId: string): Promise<{ adopted: string[]; interrupted: string[] }> {
		const open = await withTenant(this.deps.pool, tenantId, (q) => q.all<{ op_id: string; harness: Harness; workspace: any; journal: RunRecord | null }>("SELECT op_id, harness, workspace, journal FROM app.coding_runs WHERE tenant_id = $1 AND state IN ('running', 'provisioning')", tenantId), { readOnly: true });
		const adopted: string[] = [];
		const interrupted: string[] = [];
		for (const run of open) {
			if (this.driving.has(`${tenantId}:${run.op_id}`)) continue;
			if (run.harness === "amp" && this.deps.orb) {
				const state = await this.syncAmp(tenantId, run.op_id, run.workspace.orb.threadId, this.deps.orb);
				if (state === "running") this.#adoptAmp(tenantId, run.op_id, run.workspace.orb.threadId);
				adopted.push(run.op_id);
				continue;
			}
			const workspace = await this.deps.workspaces.get(run.workspace as WorkspaceRef);
			if (!workspace) {
				await this.#finishRun(tenantId, run.op_id, "failed", { reason: "workspace_lost" });
				continue;
			}
			await this.#finishRun(tenantId, run.op_id, "interrupted", { reason: "interrupted", detail: "The process driving the run was lost; the CLI was stopped and nothing was started again." });
			interrupted.push(run.op_id);
		}
		return { adopted, interrupted };
	}

	#adoptAmp(tenantId: string, opId: string, threadId: string) {
		const id = `${tenantId}:${opId}`;
		this.driving.set(id, { done: Promise.resolve().then(() => void threadId) });
	}

	/** Cancellation is its own operation, with its own state: requested, then confirmed or, when the other side may not have stopped, uncertain. */
	async cancel(actor: Actor, opId: string): Promise<OpState | undefined> {
		const tenantId = actor.principal.tenantId;
		const run = await this.#run(tenantId, opId);
		const cancelOp = `cancel:${opId}`;
		await withTenant(this.deps.pool, tenantId, (q) => beginOp(q, { tenantId, opId: cancelOp, kind: "coding.cancel", idempotent: true, request: { target: opId } }));
		await requestCancel(this.deps.pool, tenantId, cancelOp);
		try {
			if (run.harness === "amp") await this.deps.orb?.cancel?.((run.workspace as { orb: { threadId: string } }).orb.threadId);
			else await this.driving.get(`${tenantId}:${opId}`)?.runner?.abort();
			await this.#finishRun(tenantId, opId, "cancelled", { by: actor.principal.userId });
			return await settleCancel(this.deps.pool, tenantId, cancelOp, "confirmed");
		} catch {
			return await settleCancel(this.deps.pool, tenantId, cancelOp, "uncertain");
		}
	}

	/** Grant revoked: every run it authorized is asked to stop. Called from the admin path that revokes. */
	async onGrantRevoked(tenantId: string, grantId: string, actor: Actor): Promise<string[]> {
		const runs = await withTenant(this.deps.pool, tenantId, (q) => q.all<{ op_id: string }>("SELECT op_id FROM app.coding_runs WHERE tenant_id = $1 AND grant_id = $2 AND state IN ('running', 'provisioning')", tenantId, grantId), { readOnly: true });
		for (const run of runs) await this.cancel(actor, run.op_id);
		return runs.map((r) => r.op_id);
	}

	// ---- git, tests, diff: effects with their own authority -------------------------------------------------

	async #workspaceOf(tenantId: string, opId: string): Promise<{ workspace: Workspace; repo: string; branch: string | null }> {
		const run = await this.#run(tenantId, opId);
		const row = await withTenant(this.deps.pool, tenantId, (q) => q.get<{ repo: string; branch: string | null }>("SELECT repo, branch FROM app.coding_runs WHERE tenant_id = $1 AND op_id = $2", tenantId, opId), { readOnly: true });
		const workspace = await this.deps.workspaces.get(run.workspace as WorkspaceRef);
		if (!workspace) throw new Error("The run's workspace is gone");
		return { workspace, repo: row!.repo, branch: row!.branch };
	}

	async #exec(workspace: Workspace, cmd: string[]): Promise<{ code: number | null; out: string }> {
		let out = "";
		let code: number | null = null;
		for await (const e of workspace.exec(cmd, { timeoutMs: 120_000 })) {
			if (e.type === "exit") code = e.code;
			else out += e.data;
		}
		return { code, out: out.slice(0, 200_000) };
	}

	async diff(tenantId: string, opId: string): Promise<string> {
		const { workspace } = await this.#workspaceOf(tenantId, opId);
		const result = await this.#exec(workspace, ["git", "diff", "--stat", "HEAD"]);
		await this.#event(tenantId, opId, "diff", { code: result.code, text: result.out.slice(0, 20_000) });
		return result.out;
	}

	async runTests(tenantId: string, opId: string, command: string[]): Promise<{ code: number | null }> {
		const { workspace } = await this.#workspaceOf(tenantId, opId);
		const result = await this.#exec(workspace, command);
		await this.#event(tenantId, opId, "test_run", { command, code: result.code, tail: result.out.slice(-4000) });
		return { code: result.code };
	}

	/** Push is its own authority (`repo.push`): the grant must name the repository, standing grants are explicit records, and an agent's push needs one or the person's approval of exactly it. The effect is idempotent under the operation id. */
	async push(actor: Actor, opId: string, approvalId?: string): Promise<{ state: OpState }> {
		return this.#git(actor, opId, "repo.push", "git.push", ["git", "push", "origin", "HEAD"], approvalId);
	}

	async merge(actor: Actor, opId: string, approvalId?: string): Promise<{ state: OpState }> {
		return this.#git(actor, opId, "repo.merge", "git.merge", ["git", "merge", "--ff-only", "origin/main"], approvalId);
	}

	async #git(actor: Actor, opId: string, action: "repo.push" | "repo.merge", kind: string, cmd: string[], approvalId?: string) {
		const tenantId = actor.principal.tenantId;
		const { workspace, repo } = await this.#workspaceOf(tenantId, opId);
		const decision = await enforce(this.deps.authz, actor, action, { tenantId, repo, tool: actor.agent ? (action === "repo.push" ? "coding_push" : "coding_merge") : undefined, approvalId });
		const result = await runOp({ pool: this.deps.pool, lease: this.deps.lease }, { tenantId, opId: `${kind}:${opId}`, kind, idempotent: true, request: { repo, cmd }, grantId: decision.grantId }, {
			send: async () => {
				const out = await this.#exec(workspace, cmd);
				if (out.code !== 0) throw new Error(`${kind} exited ${out.code}`);
				return { code: out.code };
			},
		});
		return { state: result.state };
	}

	/** Removes the workspaces of finished runs, and any workspace no open run owns (leaks from a crash between create and record). */
	async cleanup(tenantId: string): Promise<{ removed: number; orphans: number }> {
		const finished = await withTenant(this.deps.pool, tenantId, (q) => q.all<{ op_id: string; workspace: any }>("SELECT op_id, workspace FROM app.coding_runs WHERE tenant_id = $1 AND state IN ('done', 'failed', 'cancelled', 'interrupted') AND cleaned_at IS NULL AND harness <> 'amp'", tenantId), { readOnly: true });
		for (const run of finished) {
			await this.deps.workspaces.destroy(run.workspace as WorkspaceRef);
			await withTenant(this.deps.pool, tenantId, (q) => q.run("UPDATE app.coding_runs SET cleaned_at = now() WHERE tenant_id = $1 AND op_id = $2", tenantId, run.op_id));
		}
		const known = new Set((await withTenant(this.deps.pool, tenantId, (q) => q.all<{ session_id: string }>("SELECT session_id FROM app.coding_runs WHERE tenant_id = $1 AND cleaned_at IS NULL", tenantId), { readOnly: true })).map((r) => r.session_id));
		let orphans = 0;
		for (const info of await this.deps.workspaces.list()) {
			if (!info.ref.sessionId.startsWith("forge-")) continue;
			if (!known.has(info.ref.sessionId) && (await this.#ownedBy(tenantId, info.ref.sessionId))) {
				await this.deps.workspaces.destroy(info.ref);
				orphans++;
			}
		}
		return { removed: finished.length, orphans };
	}

	/** A workspace belongs to a tenant when a run or operation of that tenant names it: an orphan is one with an operation and no run. */
	async #ownedBy(tenantId: string, sessionId: string): Promise<boolean> {
		return (await withTenant(this.deps.pool, tenantId, (q) => q.get("SELECT 1 FROM app.external_ops WHERE tenant_id = $1 AND kind = 'coding.run' AND handle->>'sessionId' = $2", tenantId, sessionId), { readOnly: true })) !== undefined;
	}
}
