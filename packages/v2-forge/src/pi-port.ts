// Family A: a real pi-durable Harness per `pi` coding thread, on PgPiStorage, with the coding tools (read, write, edit, bash, test, git…) executing inside the sandbox through its Workspace.
// Every tool call is journaled in `forge_tool_journal` before it acts, so a call interrupted by a crash is never run twice; a resumed turn re-opens the log, `resume()`s the unfinished run, and finds its submission again by request id.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineExtension, Harness, section, ToolResultEntry } from "@earendil-works/pi-durable";
import { createCodingTools, type JournalEntry, type ToolJournal } from "@pim/coding/tools/index";
import { type Db } from "./db";
import { type ComputeProvider } from "./compute";
import { PgPiStorage } from "./pi-storage";
import type { TurnPort, TurnRequest, TurnResult } from "./ports";
import { type ForgeStore, type ThreadRow } from "./store";
import { environmentBrief } from "@pim/coding/repo-environment";
import { NO_ENVIRONMENT, type CodingEnvironment } from "@pim/coding/environment-cache";
import { rootOperation } from "./worker";

export const PI_CODING_PROMPT = "You are a coding agent working in a sandboxed checkout of the repository. Make the change the task asks for, run its tests, and commit your work on the current pim/… branch. When the work is ready and the tests pass, push that branch with `git push origin HEAD:refs/heads/<branch>` from bash (fast-forward only: never force; never push or merge main or the default branch, the broker refuses it), then open the pull request with `node /workspace/.config/pim/git/helper.mjs pull-request --title \"<title>\" --body \"<what changed and how you checked it>\"`. A person reviews and merges it on the git host.";

/** The tool journal on `forge_tool_journal`: durable by the time `put` returns, since a command starts right after. */
export class PgToolJournal implements ToolJournal {
	constructor(
		private readonly db: Db,
		private readonly threadId: string,
	) {}
	async get(key: string): Promise<JournalEntry | undefined> {
		const r = (await this.db.query("select result from pim_forge.forge_tool_journal where thread_id = $1 and call_id = $2", [this.threadId, key])).rows[0];
		return (r?.result as JournalEntry | null) ?? undefined;
	}
	async put(key: string, entry: JournalEntry): Promise<void> {
		await this.db.query(
			"insert into pim_forge.forge_tool_journal (thread_id, call_id, tool, result) values ($1,$2,$3,$4) on conflict (thread_id, call_id) do update set result = $4, tool = $3",
			[this.threadId, key, entry.tool, JSON.stringify(entry)],
		);
	}
}

export type PiPortDeps = {
	store: ForgeStore;
	compute: ComputeProvider;
	/** The models this thread may use (the person's providers, the deployment's default); the port asks once per turn. */
	models: (thread: ThreadRow) => Promise<Models>;
	defaultModel: { provider: string; modelId: string };
	/** How often a running turn is looked at for its spend and for steers, in ms. */
	lookMs?: number;
};

const costOf = (usage: { models: Record<string, any> }) => Object.values(usage.models).reduce((sum: number, u: any) => sum + Number(u?.cost?.total ?? 0), 0);
const textOf = (content: readonly any[] | undefined) => (content ?? []).flatMap((c) => (c?.type === "text" ? [c.text as string] : [])).join("\n");

/** What the thread's record says of its environment, for the agent to be told (what is installed, what failed, the checks to run). */
const environmentOf = (t: ThreadRow): CodingEnvironment => {
	const e = (t.provisioning as { environment?: CodingEnvironment } | null)?.environment;
	return e && Array.isArray(e.toolchains) ? e : NO_ENVIRONMENT;
};

export class PiTurnPort implements TurnPort {
	constructor(private readonly d: PiPortDeps) {}

	async run(turn: TurnRequest): Promise<TurnResult> {
		const { store } = this.d;
		const thread = (await store.get(turn.threadId))!;
		if (!turn.workspace || !this.d.compute.workspace) return { outcome: "failed", detail: "The thread has no workspace" };
		const handle = turn.workspace;
		const storage = await PgPiStorage.open(store, turn.threadId, turn.epoch);
		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "coding",
				sections: [section("coding_agent", () => [PI_CODING_PROMPT, environmentBrief(environmentOf(thread))].filter(Boolean).join("\n\n"), { tag: false })],
				tools: createCodingTools({
					workspace: () => this.d.compute.workspace!(handle),
					journal: new PgToolJournal(store.db, turn.threadId),
					onTestRun: (r) => void turn.recordTest({ command: r.command, exitCode: r.exitCode, output: r.output }).catch(() => {}),
				}),
			}),
		);
		const models = await this.d.models(thread);
		const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
		try {
			// The model the thread asked for, as the person's catalog has it; a thread that asked for none runs on the deployment's default, or on the first model the person can run when that one is not theirs to use.
			const asked = thread.profile?.providerId ? { provider: String(thread.profile.providerId).replace(/^own:/, ""), modelId: thread.profile.model as string } : null;
			const available = asked ? [] : await models.getAvailable().catch(() => []);
			const first = available[0];
			const model = asked ?? (first && !available.some((m) => m.provider === this.d.defaultModel.provider && m.id === this.d.defaultModel.modelId) ? { provider: first.provider, modelId: first.id } : this.d.defaultModel);
			await store.patch(store.db, thread.threadId, { resolved_profile: { provider: model.provider, model: model.modelId, source: asked ? "explicit" : "default" } }).catch(() => {});
			const thinking = thread.profile?.thinking;
			const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model, ...(["minimal", "low", "medium", "high", "xhigh"].includes(thinking) ? { thinkingLevel: thinking } : {}) } });
			harness.resume();
			const before = costOf(await harness.usage(BACKGROUND_CONTEXT));
			// The request id is the turn's root operation: a resumed turn finds the submission the dead worker made instead of submitting twice. A retry after a failure is a new submission.
			const submission = await root.submit({ type: "input", content: turn.prompt, requestId: turn.operationId.startsWith("retry-") ? turn.operationId : rootOperation(turn.operationId), whenBusy: "steer" }, BACKGROUND_CONTEXT);
			const onAbort = () => void root.abort(BACKGROUND_CONTEXT);
			turn.signal.addEventListener("abort", onAbort);
			// The transcript: every message of the log not yet recorded (a replayed cursor is dropped), written as the turn goes so the page follows it.
			const flush = async () => {
				const page = await root.entries({ order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT);
				for (const e of page.items) {
					const m = (e.model?.[0] ?? null) as any;
					if (AssistantEntry.is(e) && m) {
						const calls = (m.content as any[]).filter((c) => c.type === "toolCall").map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
						await turn.emit({ kind: "message", role: "assistant", sourceCursor: `pi:${e.id}`, data: { text: textOf(m.content), operationId: turn.operationId, ...(calls.length ? { toolCalls: calls } : {}) } });
					} else if (ToolResultEntry.is(e) && m) {
						await turn.emit({ kind: "message", role: "tool", sourceCursor: `pi:${e.id}`, data: { toolCallId: m.toolCallId, name: m.toolName, text: textOf(m.content), isError: !!m.isError, operationId: turn.operationId } });
					}
				}
			};
			// While the turn runs: what it has spent is held to the budget (a call that crosses it is the last), and the steers that arrive join the turn after its current step.
			let overBudget = false;
			let looking: Promise<void> | null = null;
			const joined: (typeof submission)[] = [];
			const lookOnce = async () => {
				try {
					if (turn.maxBudgetUsd !== null && costOf(await harness.usage(BACKGROUND_CONTEXT)) - before >= turn.maxBudgetUsd) {
						overBudget = true;
						await root.abort(BACKGROUND_CONTEXT);
						return;
					}
					for (const steer of (await turn.steers?.next()) ?? []) {
						joined.push(await root.submit({ type: "input", content: steer.text, requestId: steer.operationId, whenBusy: "steer" }, BACKGROUND_CONTEXT));
						await turn.steers!.sent(steer.operationId, steer.text);
					}
					await flush();
				} catch {
					// Looked at again at the next tick.
				}
			};
			const look = () => {
				if (!looking && !overBudget) looking = lookOnce().finally(() => (looking = null));
			};
			const ticker = setInterval(look, this.d.lookMs ?? 1000);
			let settled;
			try {
				settled = await submission.wait(BACKGROUND_CONTEXT);
				// A steer that came as the turn ended is part of it: it is waited for, not cut off.
				while (joined.length) await joined.shift()!.wait(BACKGROUND_CONTEXT);
			} finally {
				clearInterval(ticker);
				turn.signal.removeEventListener("abort", onAbort);
				await looking;
			}
			await flush();
			const costUsd = Math.max(0, costOf(await harness.usage(BACKGROUND_CONTEXT)) - before);
			if (overBudget) return { outcome: "budget", costUsd, detail: `Spent $${costUsd.toFixed(4)} of the turn's $${turn.maxBudgetUsd?.toFixed(4)}` };
			if (settled.status === "done") return { outcome: "completed", costUsd, text: null, detail: null, progress: true };
			return { outcome: "failed", costUsd, detail: `The run ended unanswered${(settled as any).reason ? `: ${JSON.stringify((settled as any).reason).slice(0, 300)}` : ""}` };
		} finally {
			await harness.close(BACKGROUND_CONTEXT).catch(() => {});
		}
	}
}
