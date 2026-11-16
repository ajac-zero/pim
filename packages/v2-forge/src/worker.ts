// The Forge worker: steps threads one at a time under their lease, for all three execution families.
// Family A and B (sandbox pi and vendor CLIs) run a turn per inbox item; family C (Amp) is a remote thread Forge adopts, polls and mirrors, and never restarts.
import { randomUUID } from "node:crypto";
import { OrbLostError, OrbUnreachableError, OrbError, type OrbClient, type OrbMessage } from "@pim/coding/orb/types";
import { ampAttachments, replaceAmpAttachments } from "@pim/coding/orb/amp-attachments";
import { createHash } from "node:crypto";
import { type Row, type Queryable } from "./db";
import { CapabilityUnavailableError, ForgeError, LeaseLostError } from "./errors";
import { capabilitiesOf, LEGACY_AMP_WORKSPACE_MESSAGE, MAX_RESUMES, MAX_SESSION_RESTARTS, type Harness } from "./harnesses";
import { type AttachmentFetcher, type Objects, type OrbClients, type TurnPort, type TurnResult } from "./ports";
import { Provisioner, type ComputeProvider } from "./compute";
import { type ForgeScheduler } from "./scheduler";
import { type ForgeStore, type ThreadRow } from "./store";

export type WorkerDeps = {
	store: ForgeStore;
	scheduler: ForgeScheduler;
	/** Sandbox harnesses: one port each for pi, claude-code, codex, mistral-vibe. */
	turns: Partial<Record<Harness, TurnPort>>;
	compute: ComputeProvider | null;
	orbs: OrbClients;
	objects: Objects;
	attachments?: AttachmentFetcher;
	/** The pool a thread of a harness is placed on when it names none. */
	defaultPool?: string;
	holder?: string;
	leaseMs?: number;
	clock?: () => number;
};

/** `resume-<root>-<n>` and `retry-<root>-<n>` belong to the turn `root`; its wake is keyed by the root so a resumed turn ends once. */
export const rootOperation = (op: string) => op.replace(/^(?:resume|retry)-(.*)-\d+$/, "$1");

export type StepResult = "busy" | "done" | "queued" | "retry" | "skipped";

/** Strips a `<suggested-replies>` block off an assistant message and returns its lines (PR #25). */
export function splitSuggestedReplies(text: string): { text: string; replies: string[] } {
	const m = /<suggested-replies>([\s\S]*?)(?:<\/suggested-replies>|$)/.exec(text);
	if (!m) return { text, replies: [] };
	const replies = m[1]!.split("\n").map((l) => l.trim().replace(/^[-*]\s*/, "")).filter(Boolean).slice(0, 4);
	return { text: text.replace(/<suggested-replies>[\s\S]*?(?:<\/suggested-replies>|$)/g, "").trim(), replies };
}

export class ForgeWorker {
	readonly holder: string;
	private readonly provisioner: Provisioner | null;
	private readonly clock: () => number;

	constructor(private readonly d: WorkerDeps) {
		this.holder = d.holder ?? `worker-${randomUUID()}`;
		this.clock = d.clock ?? Date.now;
		this.provisioner = d.compute ? new Provisioner(d.store, d.compute, this.clock) : null;
	}

	/** Threads that need a step: provisioning, queued and promoted, running (after a crash), with pending input, or with an orb to poll. */
	async sweep(): Promise<StepResult[]> {
		const ids = (
			await this.d.store.db.query<Row>(
				`select thread_id from pim_forge.forge_threads t where state in ('provisioning', 'running')
				 or (state in ('idle', 'queued', 'waiting_input') and exists (select 1 from pim_forge.forge_inbox i where i.thread_id = t.thread_id and i.status = 'pending'))
				 order by created_at`,
			)
		).rows.map((r) => r.thread_id as string);
		const out: StepResult[] = [];
		for (const id of ids) out.push(await this.step(id));
		return out;
	}

	async step(threadId: string): Promise<StepResult> {
		const epoch = await this.d.store.acquireLease(threadId, this.holder, this.d.leaseMs ?? 60_000);
		if (epoch === null) return "busy";
		try {
			const thread = await this.d.store.get(threadId);
			if (!thread || thread.state === "archived" || thread.state === "failed") return "skipped";
			return capabilitiesOf(thread.harness).family === "remote-orb" ? await this.stepOrb(thread, epoch) : await this.stepSandbox(thread, epoch);
		} catch (error) {
			if (error instanceof LeaseLostError) return "busy";
			throw error;
		} finally {
			await this.d.store.releaseLease(threadId, this.holder, epoch);
		}
	}

	// ---------------------------------------------------------------- Families A and B

	private async stepSandbox(thread: ThreadRow, epoch: number): Promise<StepResult> {
		const { store, scheduler } = this.d;
		if (!this.d.compute || !this.provisioner) {
			await store.fenced(thread.threadId, epoch, (q) => store.setState(q, thread.threadId, "failed", "no_backend", "This deployment has no coding sandbox provider"));
			return "done";
		}
		if (!thread.workspaceRef) {
			const poolId = thread.placement?.pool ?? this.d.defaultPool ?? "default";
			const admitted = await scheduler.admit(thread.threadId, poolId, thread.ownerId);
			if (admitted.kind === "queued") return "queued";
			if (admitted.kind === "unhealthy") {
				await store.fenced(thread.threadId, epoch, async (q) => {
					await store.patch(q, thread.threadId, { placement: { pool: poolId } });
					await store.setState(q, thread.threadId, "queued", "pool_unhealthy", null);
				});
				return "queued";
			}
			try {
				await this.provisioner.provision(thread.threadId, epoch);
				await scheduler.report(poolId, thread.threadId, "success");
			} catch (error) {
				if (error instanceof LeaseLostError) throw error;
				const ambiguous = error instanceof Error && error.name === "AmbiguousCreateError";
				await scheduler.report(poolId, thread.threadId, ambiguous ? "failure" : error instanceof ForgeError ? "ignored" : "failure");
				// An ambiguous create leaves the thread provisioning: the next step reconciles by tag instead of failing it or creating a second sandbox.
				if (ambiguous || (error instanceof ForgeError && error.code === "conflict")) return "retry";
				await store.fenced(thread.threadId, epoch, (q) => store.setState(q, thread.threadId, "failed", "provision_failed", String(error instanceof Error ? error.message : error).slice(0, 500)));
				await scheduler.release(thread.threadId, "provision_failed");
				return "done";
			}
			await store.fenced(thread.threadId, epoch, async (q) => {
				await store.patch(q, thread.threadId, { placement: { pool: poolId } });
				await store.setState(q, thread.threadId, "idle");
			});
		}
		await this.recover(thread.threadId, epoch);
		for (;;) {
			const next = await store.fenced(thread.threadId, epoch, async (q, t) => {
				if (t.state === "archived" || t.cancelState !== "none") return null;
				const [item] = await store.takeInbox(q, thread.threadId).then(async (items) => {
					// One turn at a time: put the rest back.
					for (const rest of items.slice(1)) await q.query("update pim_forge.forge_inbox set status = 'pending' where thread_id = $1 and operation_id = $2", [thread.threadId, rest.operationId]);
					return items.slice(0, 1);
				});
				return item ?? null;
			});
			if (!next) break;
			await this.runTurn(thread.threadId, epoch, next);
		}
		const after = await store.get(thread.threadId);
		if (after && after.state === "idle") await scheduler.markIdle(thread.threadId);
		return "done";
	}

	/** A run left `running` by a worker that died: it settles as interrupted, and resumes (bounded) without a turn_ended. */
	private async recover(threadId: string, epoch: number): Promise<void> {
		await this.d.store.fenced(threadId, epoch, async (q, t) => {
			const lost = (await q.query<Row>("select * from pim_forge.forge_harness_runs where thread_id = $1 and status = 'running' for update", [threadId])).rows;
			for (const run of lost) await this.settle(q, t, run.operation_id, { outcome: "interrupted", detail: "interrupted_by_restart" });
		});
	}

	private async runTurn(threadId: string, epoch: number, item: { operationId: string; kind: string; payload: any }): Promise<void> {
		const { store } = this.d;
		const prep = await store.fenced(threadId, epoch, async (q, t) => {
			const done = (await q.query<Row>("select status from pim_forge.forge_harness_runs where thread_id = $1 and operation_id = $2", [threadId, item.operationId])).rows[0];
			if (done && done.status !== "interrupted") return null;
			if (t.budgetUsd !== null && t.spentUsd >= t.budgetUsd) {
				await store.setState(q, threadId, "failed", "budget", `Spent $${t.spentUsd} of $${t.budgetUsd}`);
				await store.appendEvent(q, threadId, { kind: "app.budget_stop", data: { spentUsd: t.spentUsd, budgetUsd: t.budgetUsd } });
				return null;
			}
			await q.query("insert into pim_forge.forge_harness_runs (thread_id, operation_id, harness, status) values ($1,$2,$3,'running') on conflict (thread_id, operation_id) do update set status = 'running', ended_at = null", [threadId, item.operationId, t.harness]);
			const session = (await q.query<Row>("select session_id from pim_forge.forge_harness_sessions where thread_id = $1 and harness = $2", [threadId, t.harness])).rows[0];
			await store.setState(q, threadId, "running");
			await store.appendEvent(q, threadId, { kind: "thread.turn_started", data: { operationId: item.operationId, harness: t.harness } });
			if (item.payload?.prompt && !item.operationId.startsWith("resume-")) await store.appendEvent(q, threadId, { kind: "message", role: "user", data: { text: item.payload.prompt, operationId: item.operationId } });
			return { thread: t, sessionId: (session?.session_id as string | undefined) ?? null };
		});
		if (!prep) return;
		await this.d.scheduler.markBusy(threadId);
		const port = this.d.turns[prep.thread.harness];
		const abort = new AbortController();
		let result: TurnResult;
		try {
			if (!port) throw new CapabilityUnavailableError("coding:runner", `no turn runner for ${prep.thread.harness}`);
			result = await port.run({ threadId, operationId: item.operationId, prompt: item.payload?.prompt ?? "Continue.", sessionId: prep.sessionId, resume: prep.sessionId !== null, maxBudgetUsd: prep.thread.budgetUsd === null ? null : Math.max(0, prep.thread.budgetUsd - prep.thread.spentUsd), workspace: prep.thread.workspaceRef, signal: abort.signal });
		} catch (error) {
			result = { outcome: "failed", detail: String(error instanceof Error ? error.message : error).slice(0, 500) };
		}
		await store.fenced(threadId, epoch, (q, t) => this.settle(q, t, item.operationId, result));
	}

	/** Settles a run and moves the thread, in the caller's fenced transaction. An interrupted run never ends the turn: it queues a bounded resume. */
	private async settle(q: Queryable, t: ThreadRow, operationId: string, r: TurnResult): Promise<void> {
		const { store } = this.d;
		const root = rootOperation(operationId);
		const cancelled = t.cancelState !== "none";
		const status = cancelled ? "cancelled" : r.outcome === "completed" ? "completed" : r.outcome === "interrupted" || r.outcome === "session_limit" ? "interrupted" : "failed";
		await q.query("update pim_forge.forge_harness_runs set status = $3, ended_at = now() where thread_id = $1 and operation_id = $2", [t.threadId, operationId, status]);
		if (r.sessionId) await q.query("insert into pim_forge.forge_harness_sessions (thread_id, harness, session_id) values ($1,$2,$3) on conflict (thread_id, harness) do update set session_id = $3, updated_at = now()", [t.threadId, t.harness, r.sessionId]);
		if (r.costUsd || r.tokensIn || r.tokensOut) await store.appendEvent(q, t.threadId, { kind: "model_call", costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut, data: { operationId, via: "harness", harness: t.harness } });
		if (r.text) {
			const { text, replies } = splitSuggestedReplies(r.text);
			await store.appendEvent(q, t.threadId, { kind: "message", role: "assistant", data: { text, operationId, ...(replies.length ? { suggestedReplies: replies } : {}) } });
		}
		await q.query("delete from pim_forge.forge_stall_episodes where source = $1", [t.threadId]);
		const wake = (outcome: "completed" | "failed", summary?: string | null) => store.emitCompletionWake(q, t, root, outcome, summary);
		if (cancelled) {
			await store.setState(q, t.threadId, "idle", "aborted");
			await store.patch(q, t.threadId, { cancel_state: "cancelled" });
			return;
		}
		if (r.outcome === "interrupted" || r.outcome === "session_limit") {
			const session = r.outcome === "session_limit";
			const interrupts = t.consecutiveInterrupts + 1;
			let restarts = 0;
			if (session) {
				restarts = Number((await q.query<Row>("update pim_forge.forge_harness_sessions set restarts = case when $3 then 0 else restarts + 1 end where thread_id = $1 and harness = $2 returning restarts", [t.threadId, t.harness, r.progress === true])).rows[0]?.restarts ?? 0);
			}
			const loop = session && restarts > MAX_SESSION_RESTARTS;
			if (interrupts > MAX_RESUMES || loop) {
				await store.patch(q, t.threadId, { consecutive_interrupts: interrupts });
				await store.setState(q, t.threadId, "failed", loop ? "session_limit" : "lost", loop ? `The sandbox's session reached its time limit ${MAX_SESSION_RESTARTS + 1} times in a row without the thread committing anything new` : `The sandbox was lost ${MAX_RESUMES} times in a row. Last: ${r.detail ?? "interrupted"}`.slice(0, 500));
				await wake("failed", loop ? "session_limit" : "lost");
				return;
			}
			await store.patch(q, t.threadId, { consecutive_interrupts: interrupts });
			await store.enqueueInbox(q, t.threadId, `resume-${root}-${interrupts}`, "resume", { prompt: "Continue where you left off.", reason: r.detail ?? "interrupted" });
			await store.setState(q, t.threadId, "running", "resuming", r.detail ?? "interrupted");
			return;
		}
		await store.patch(q, t.threadId, { consecutive_interrupts: 0 });
		if (r.outcome === "completed") {
			await store.appendEvent(q, t.threadId, { kind: "thread.turn_ended", data: { operationId: root, outcome: "completed" } });
			const spent = t.spentUsd + (r.costUsd ?? 0);
			if (t.budgetUsd !== null && spent >= t.budgetUsd) await store.setState(q, t.threadId, "failed", "budget", `Spent $${spent} of $${t.budgetUsd}`);
			else await store.setState(q, t.threadId, "idle");
			await wake("completed");
		} else if (r.outcome === "login_required") {
			await store.setState(q, t.threadId, "waiting_input", "login_required", r.detail ?? null);
			await wake("failed", "login_required");
		} else {
			await store.appendEvent(q, t.threadId, { kind: "thread.turn_ended", data: { operationId: root, outcome: r.outcome } });
			await store.setState(q, t.threadId, "failed", r.outcome === "budget" ? "budget" : "error", r.detail ?? null);
			await wake("failed", r.outcome === "budget" ? "budget" : (r.detail ?? "error"));
		}
	}

	// ---------------------------------------------------------------- Family C: Amp

	private async stepOrb(thread: ThreadRow, epoch: number): Promise<StepResult> {
		const { store } = this.d;
		// A retired workspace-Amp row stays readable and is never stepped again.
		if (thread.workspaceRef && !thread.orb) {
			await store.fenced(thread.threadId, epoch, (q) => store.setState(q, thread.threadId, "failed", "legacy_amp_workspace", LEGACY_AMP_WORKSPACE_MESSAGE));
			return "done";
		}
		const client = await this.d.orbs(thread);
		if (!client) {
			await store.fenced(thread.threadId, epoch, (q) => store.setState(q, thread.threadId, "failed", "no_backend", "No Amp credential is configured"));
			return "done";
		}
		if (!thread.orb) return this.startOrb(thread, epoch, client);
		return this.syncOrb(thread, epoch, client);
	}

	/** Records the provisioning intent first, then starts through the client's idempotency key, then persists the orb handle before doing anything else. */
	private async startOrb(thread: ThreadRow, epoch: number, client: OrbClient): Promise<StepResult> {
		const { store } = this.d;
		const key = `forge:${thread.threadId}:${thread.startOperation}`;
		await store.fenced(thread.threadId, epoch, async (q, t) => {
			if (!t.provisioning || t.provisioning.key !== key) await store.patch(q, thread.threadId, { provisioning: { kind: "orb", client: client.id, key, phase: "intent", at: this.clock() } });
		});
		let handle;
		try {
			handle = await client.start({ project: thread.repo, prompt: thread.task, mode: null, title: null, idempotencyKey: key });
		} catch (error) {
			if (error instanceof OrbUnreachableError || (error instanceof OrbError && error.code === "orb_start_uncertain")) {
				// The start may have happened: stay provisioning and retry with the same key, which the client answers with the same thread.
				await store.fenced(thread.threadId, epoch, (q) => store.patch(q, thread.threadId, { provisioning: { kind: "orb", client: client.id, key, phase: "uncertain", at: this.clock() } }));
				return "retry";
			}
			await store.fenced(thread.threadId, epoch, (q) => store.setState(q, thread.threadId, "failed", error instanceof OrbError ? error.code : "error", String(error instanceof Error ? error.message : error).slice(0, 500)));
			return "done";
		}
		await store.fenced(thread.threadId, epoch, async (q) => {
			await store.patch(q, thread.threadId, { orb: { threadId: handle.threadId, url: handle.url, client: client.id, turn: thread.startOperation }, provisioning: { kind: "orb", client: client.id, key, phase: "ready", at: this.clock() } });
			await store.setState(q, thread.threadId, "running");
			await store.appendEvent(q, thread.threadId, { kind: "thread.turn_started", data: { operationId: thread.startOperation, provider: client.id, orb: handle.threadId } });
			await q.query("insert into pim_forge.forge_inbox (thread_id, operation_id, kind, payload, status) values ($1,$2,'start','{}','done') on conflict do nothing", [thread.threadId, thread.startOperation]);
		});
		return "done";
	}

	/** Adoption and polling: reads the remote thread as it is. Nothing here starts, or re-sends the prompt of, a session. */
	private async syncOrb(thread: ThreadRow, epoch: number, client: OrbClient): Promise<StepResult> {
		const { store } = this.d;
		const orb = thread.orb!;
		// Input first, at most once: the inbox row is marked taken before the remote call.
		const inputs = await store.fenced(thread.threadId, epoch, (q) => store.takeInbox(q, thread.threadId));
		for (const item of inputs) {
			if (item.kind === "abort") continue;
			try {
				await client.steer(orb.threadId, item.payload.prompt);
				await store.fenced(thread.threadId, epoch, async (q) => {
					await q.query("update pim_forge.forge_inbox set status = 'done' where thread_id = $1 and operation_id = $2", [thread.threadId, item.operationId]);
					await store.appendEvent(q, thread.threadId, { kind: "message", role: "user", data: { text: item.payload.prompt, operationId: item.operationId, sentByPim: true } });
					await store.patch(q, thread.threadId, { orb: { ...orb, turn: item.operationId } });
				});
			} catch (error) {
				await store.fenced(thread.threadId, epoch, (q) => q.query("update pim_forge.forge_inbox set status = 'pending' where thread_id = $1 and operation_id = $2", [thread.threadId, item.operationId]));
				if (!(error instanceof OrbUnreachableError)) throw error;
				return "retry";
			}
		}
		let status;
		let messages: readonly OrbMessage[] = [];
		try {
			status = await client.state(orb.threadId);
			const last = (await store.db.query<Row>("select source_cursor from pim_forge.forge_events where thread_id = $1 and source_cursor like 'orb:%' order by seq desc limit 1", [thread.threadId])).rows[0]?.source_cursor as string | undefined;
			let after = last?.slice(4);
			for (;;) {
				const page = await client.messages(orb.threadId, after ? { after } : {});
				if (!page.length) break;
				messages = [...messages, ...page];
				after = page.at(-1)!.id;
			}
		} catch (error) {
			if (error instanceof OrbLostError) {
				await store.fenced(thread.threadId, epoch, async (q) => {
					await store.setState(q, thread.threadId, "failed", "orb_lost", "The Amp thread no longer exists");
					await store.emitCompletionWake(q, thread, orb.turn ?? thread.startOperation, "failed", "orb_lost");
				});
				return "done";
			}
			if (error instanceof OrbUnreachableError) return "retry";
			throw error;
		}
		// Cost where the orb exposes it (dollars only; Amp may report nothing, which is unmetered, not free).
		let usd: number | null = null;
		if (client.capabilities().usage) usd = (await client.usage(orb.threadId).catch(() => null))?.usd ?? null;
		// One at a time, so the same attachment in two messages is fetched once.
		const mirrored: { m: OrbMessage; text: string }[] = [];
		for (const m of messages) mirrored.push({ m, text: await this.mirrorAttachments(thread, m.text) });
		await store.fenced(thread.threadId, epoch, async (q, t) => {
			let turn = (t.orb?.turn as string | undefined) ?? thread.startOperation;
			for (const { m, text } of mirrored) {
				const split = m.role === "assistant" ? splitSuggestedReplies(text) : { text, replies: [] as string[] };
				const sentByPim = m.role === "user" && (await q.query("select 1 from pim_forge.forge_events where thread_id = $1 and role = 'user' and data ->> 'text' = $2 and source_cursor is null", [t.threadId, m.text])).rows.length > 0;
				const external = m.role === "user" && !sentByPim && m.text !== t.task;
				if (external) {
					turn = `external-${m.id}`;
					await store.appendEvent(q, t.threadId, { kind: "thread.turn_started", data: { operationId: turn, provider: client.id, orb: orb.threadId, external: true } });
				}
				await store.appendEvent(q, t.threadId, { kind: "message", role: m.role, sourceCursor: `orb:${m.id}`, data: { text: split.text, at: m.at, ...(split.replies.length ? { suggestedReplies: split.replies } : {}), ...(m.parts ? { parts: m.parts } : {}), ...(external ? { external: true } : {}) } });
			}
			const reported = (t.orb as { reportedUsd?: number } | null)?.reportedUsd ?? 0;
			if (usd !== null && usd > reported) await store.appendEvent(q, t.threadId, { kind: "model_call", costUsd: usd - reported, sourceCursor: `usage:${usd}`, data: { via: "orb", harness: "amp", reportedTotalUsd: usd } });
			await store.patch(q, t.threadId, { last_seen_at: new Date(this.clock()), orb: { ...t.orb, turn, ...(usd !== null && usd > reported ? { reportedUsd: usd } : {}) } });
			if (status.state === "working") {
				if (t.state !== "running") await store.setState(q, t.threadId, "running");
			} else if (status.state === "awaiting_approval") {
				if (t.state !== "waiting_input") await store.setState(q, t.threadId, "waiting_input", "awaiting_approval");
			} else if (status.state === "error") {
				await store.setState(q, t.threadId, "failed", "orb_error", "The Amp thread reported an error");
				await store.emitCompletionWake(q, t, turn, "failed", "orb_error");
			} else if (status.state === "idle" && t.state === "running") {
				await store.appendEvent(q, t.threadId, { kind: "thread.turn_ended", data: { operationId: turn, outcome: "completed" } });
				await store.setState(q, t.threadId, "idle");
				await store.emitCompletionWake(q, t, turn, "completed");
			}
		});
		return "done";
	}

	/** Copies each Amp attachment (images, MP4/WebM) into Objects once, and rewrites the message to point at the copy. */
	private async mirrorAttachments(thread: ThreadRow, text: string): Promise<string> {
		if (!this.d.attachments) return text;
		const copies = new Map<string, string>();
		for (const a of ampAttachments(text)) {
			const key = `forge/${thread.threadId}/attachments/${createHash("sha256").update(a.canonical).digest("hex").slice(0, 32)}`;
			if (!(await this.d.objects.get(key))) {
				const got = await this.d.attachments(a.canonical);
				if (!got) continue;
				await this.d.objects.put(key, got.bytes, { contentType: got.type });
			}
			copies.set(a.url, `/api/coding/${thread.threadId}/attachments/${key.split("/").pop()}`);
		}
		return copies.size ? replaceAmpAttachments(text, copies) : text;
	}
}

export { LEGACY_AMP_WORKSPACE_MESSAGE };
