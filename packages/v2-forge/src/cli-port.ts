// A real TurnPort for the vendor CLIs (claude-code, codex, mistral-vibe): `@pim/coding`'s HarnessRunner and command builders/parsers, run through the sandbox's Workspace.
import { environmentBrief } from "@pim/coding/repo-environment";
import type { CodingEnvironment } from "@pim/coding/environment-cache";
import { randomUUID } from "node:crypto";
import { type CliHarness } from "@pim/coding/harness/types";
import { authEnv } from "@pim/coding/harness/auth";
import { HarnessRunner, recoverRun, type RunJournal, type RunnerDeps, type RunRecord, type RunResult } from "@pim/coding/harness/runner";
import { restoreHarnessCredentials, writeBackHarnessCredentials, type Restored } from "@pim/coding/vault/inject";
import { isLoginHarness, type LoginHarness } from "@pim/shared/harnesses";
import { computeTag, type ComputeProvider } from "./compute";
import { type Row } from "./db";
import { type ForgeScheduler } from "./scheduler";
import { type ForgeStore } from "./store";
import { type ForgeVault } from "./vault";
import type { TurnPort, TurnRequest, TurnResult } from "./ports";

/** The person's login is leased this long and renewed as a run goes on, so a dead worker can't hold it for long. */
export const HARNESS_LOCK_LEASE_MS = 20 * 60_000;

export const FORGE_INSTRUCTIONS = "You are running as a Pim coding thread. Work in the repository checkout and commit your work on the pim/… branch you are on. When the work is ready and the tests pass, push that branch with `git push origin HEAD:refs/heads/<branch>` (fast-forward only: never force; never push, rewrite or merge main or the default branch, the broker refuses it), then open the pull request with `node /workspace/.config/pim/git/helper.mjs pull-request --title \"<title>\" --body \"<what changed and how you checked it>\"`. A person reviews and merges it on the git host.";

export type CliPortDeps = {
	cli: CliHarness;
	compute: ComputeProvider;
	store: ForgeStore;
	scheduler: ForgeScheduler;
	vault: ForgeVault;
	instructions?: string;
	graceMs?: number;
	stallMs?: number;
	now?: () => number;
};

const text = (parts: readonly { type: string; text?: string }[]) => parts.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n");

export class CliTurnPort implements TurnPort {
	constructor(private readonly d: CliPortDeps) {}

	private async workspace(turn: { workspace: TurnRequest["workspace"] }) {
		if (!turn.workspace || !this.d.compute.workspace) throw new Error("The thread has no workspace");
		return this.d.compute.workspace(turn.workspace);
	}

	/** What a CLI run needs of the thread: how it signs in, the person's login and lock, and where its record goes. */
	private deps(threadId: string, owner: string, tag: string, operationId: string, workspace: Awaited<ReturnType<CliPortDeps["compute"]["workspace"] & {}>>, auth: RunnerDeps["auth"], turn?: TurnRequest): RunnerDeps {
		const { cli, vault, scheduler, store } = this.d;
		const session = (sid: string) => ({ userId: owner, ref: { id: "", providerId: this.d.compute.id, sessionId: sid }, workspace });
		// A person's thread is their workspace's session: its tag is derived from the thread.
		const owns = async (userId: string, sessionId: string) => userId === owner && sessionId === tag;
		let queue: Promise<unknown> = Promise.resolve();
		const journal: RunJournal = {
			save: (record: RunRecord) => void (queue = queue.then(() => store.db.query("update pim_forge.forge_harness_runs set record = $3 where thread_id = $1 and operation_id = $2", [threadId, operationId, record]).catch(() => {}))),
			clear: () => void (queue = queue.then(() => store.db.query("update pim_forge.forge_harness_runs set record = null where thread_id = $1 and operation_id = $2", [threadId, operationId]).catch(() => {}))),
		};
		return {
			harness: cli,
			workspace,
			auth,
			credentials: {
				restore: async (): Promise<Restored> => (isLoginHarness(cli.id) ? restoreHarnessCredentials(vault, owns, session(tag), cli.id as LoginHarness) : ({ userId: owner, sessionId: tag, harness: cli.id as LoginHarness, version: 0, connected: true, fingerprint: null } as Restored)),
				writeBack: (restored: Restored) => writeBackHarnessCredentials(vault, owns, restored, session(tag)),
			},
			lock: { acquire: () => scheduler.acquireLogin(owner, cli.id, threadId, HARNESS_LOCK_LEASE_MS), release: () => scheduler.releaseLogin(owner, cli.id, threadId) },
			journal,
			onEvent: turn ? (event) => this.onEvent(turn, event) : undefined,
			onTestRun: turn ? (run) => void turn.recordTest({ command: run.command, exitCode: run.exitCode, output: run.output }).catch(() => {}) : undefined,
			now: this.d.now,
			graceMs: this.d.graceMs,
			stallMs: this.d.stallMs,
		};
	}

	private async onEvent(turn: TurnRequest, event: Parameters<NonNullable<RunnerDeps["onEvent"]>>[0]) {
		if (event.type === "assistant") {
			const calls = event.message.content.flatMap((c) => (c.type === "toolCall" ? [{ id: c.id, name: c.name, arguments: c.arguments }] : []));
			await turn.emit({ kind: "message", role: "assistant", sourceCursor: event.messageId ? `msg:${turn.operationId}:${event.messageId}` : null, data: { text: text(event.message.content as never), operationId: turn.operationId, ...(calls.length ? { toolCalls: calls } : {}) } });
		} else if (event.type === "tool_result") {
			await turn.emit({ kind: "message", role: "tool", data: { toolCallId: event.message.toolCallId, name: event.message.toolName, text: text(event.message.content as never), isError: event.message.isError, operationId: turn.operationId } });
		} else if (event.type === "notice") {
			await turn.emit({ kind: "message", role: "notice", data: { text: event.message, operationId: turn.operationId } });
		}
	}

	async run(turn: TurnRequest): Promise<TurnResult> {
		const { cli, store, vault } = this.d;
		const thread = (await store.get(turn.threadId))!;
		const workspace = await this.workspace(turn);
		const sess = (await store.db.query<Row>("select session_id, cost_usd, usage from pim_forge.forge_harness_sessions where thread_id = $1 and harness = $2", [turn.threadId, thread.harness])).rows[0];
		const sessionId = turn.sessionId ?? randomUUID();
		const auth = await authEnv({} as never, cli, (h) => vault.loadApiKey(thread.ownerId, h));
		const runner = new HarnessRunner(this.deps(turn.threadId, thread.ownerId, computeTag(thread), turn.operationId, workspace, auth, turn));
		const onAbort = () => void runner.abort();
		turn.signal.addEventListener("abort", onAbort);
		try {
			const prepared = await runner.prepare(turn.operationId, { sessionId, resume: turn.resume });
			if (prepared.status === "busy") return { outcome: "busy", detail: `Another of your coding threads is running ${cli.name}; this one starts when it ends` };
			if (prepared.status === "login_required") return { outcome: "login_required", detail: `Connect ${cli.name} with ${cli.apiKeyEnv ? "your API key" : "your subscription"}, then continue the thread` };
			const before = { costUsd: sess ? Number(sess.cost_usd) : 0, usage: sess?.usage ?? null };
			const r = await runner.run({ prompt: turn.prompt, sessionId, resume: turn.resume, maxBudgetUsd: cli.reportsCost ? turn.maxBudgetUsd : null, model: null, instructions: [this.d.instructions ?? FORGE_INSTRUCTIONS, (() => { const e = (thread.provisioning as { environment?: CodingEnvironment } | null)?.environment; return e && Array.isArray(e.toolchains) ? environmentBrief(e) : null; })()].filter(Boolean).join("\n\n"), sessionBefore: before }, null).catch((error): RunResult => ({ status: "unanswered", reason: "harness_error", detail: String(error instanceof Error ? error.message : error).slice(0, 500), sessionId: null, sessionCostUsd: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, sessionUsage: null, model: null, lines: 0 }));
			return this.map(r, sess && sess.session_id === r.sessionId ? before : { costUsd: 0, usage: null });
		} finally {
			turn.signal.removeEventListener("abort", onAbort);
		}
	}

	/** How a run ended, as Forge settles it: cost as the change in the session's total, tokens as the turn's own (or the session's growth). */
	private map(r: RunResult, before: { costUsd: number; usage: any }): TurnResult {
		const cost = r.sessionCostUsd === null ? 0 : Math.max(0, r.sessionCostUsd - before.costUsd);
		const grown = r.sessionUsage ? { input: Math.max(0, r.sessionUsage.input - (before.usage?.input ?? 0)), output: Math.max(0, r.sessionUsage.output - (before.usage?.output ?? 0)) } : r.usage;
		const base = { sessionId: r.sessionId, costUsd: cost, tokensIn: grown.input, tokensOut: grown.output, sessionCostUsd: r.sessionCostUsd, sessionUsage: r.sessionUsage, detail: r.detail ?? null };
		if (r.status === "done") return { ...base, outcome: "completed" };
		switch (r.reason) {
			case "interrupted":
			case "workspace_lost":
				return { ...base, outcome: "interrupted" };
			case "budget":
				return { ...base, outcome: "budget" };
			case "login_required":
				return { ...base, outcome: "login_required" };
			default:
				// aborted, timeout, stalled, max_turns, harness_error
				return { ...base, outcome: "failed" };
		}
	}

	async recover(run: { threadId: string; operationId: string; record: unknown; workspace: TurnRequest["workspace"] }): Promise<void> {
		const { cli, store } = this.d;
		const thread = (await store.get(run.threadId))!;
		const record = run.record as RunRecord | null;
		if (!record) return;
		let workspace;
		try {
			workspace = await this.workspace(run);
		} catch {
			// Without the workspace there is no CLI to stop and no login to keep: only the lock is let go.
			if (record.locked) await this.d.scheduler.releaseLogin(thread.ownerId, cli.id, run.threadId);
			await store.db.query("update pim_forge.forge_harness_runs set record = null where thread_id = $1 and operation_id = $2", [run.threadId, run.operationId]);
			return;
		}
		await recoverRun(this.deps(run.threadId, thread.ownerId, computeTag(thread), run.operationId, workspace, { mode: "signed_out" }), record);
	}
}
