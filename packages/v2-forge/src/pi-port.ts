// Family A: a real pi-durable 1.1.0 Harness per `pi` coding thread, on PgPiStorage, with the coding tools (read, write, edit, bash, test, git…) executing inside the sandbox through its Workspace.
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
import { rootOperation } from "./worker";

export const PI_CODING_PROMPT = "You are a coding agent working in a sandboxed checkout of the repository. Make the change the task asks for, run its tests, and commit your work on the current branch. Never push; Pim pushes and merges.";

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
};

const costOf = (usage: { models: Record<string, any> }) => Object.values(usage.models).reduce((sum: number, u: any) => sum + Number(u?.cost?.total ?? 0), 0);
const textOf = (content: readonly any[] | undefined) => (content ?? []).flatMap((c) => (c?.type === "text" ? [c.text as string] : [])).join("\n");

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
				sections: [section("coding_agent", () => PI_CODING_PROMPT, { tag: false })],
				tools: createCodingTools({
					workspace: () => this.d.compute.workspace!(handle),
					journal: new PgToolJournal(store.db, turn.threadId),
					onTestRun: (r) => void turn.recordTest({ command: r.command, exitCode: r.exitCode, output: r.output }).catch(() => {}),
				}),
			}),
		);
		const harness = await Harness.open(storage, { models: await this.d.models(thread), registry }, BACKGROUND_CONTEXT);
		try {
			const model = thread.profile?.providerId ? { provider: thread.profile.providerId, modelId: thread.profile.model } : this.d.defaultModel;
			const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model } });
			harness.resume();
			const before = costOf(await harness.usage(BACKGROUND_CONTEXT));
			// The request id is the turn's root operation: a resumed turn finds the submission the dead worker made instead of submitting twice.
			const submission = await root.submit({ type: "input", content: turn.prompt, requestId: rootOperation(turn.operationId), whenBusy: "steer" }, BACKGROUND_CONTEXT);
			const onAbort = () => void root.abort(BACKGROUND_CONTEXT);
			turn.signal.addEventListener("abort", onAbort);
			let settled;
			try {
				settled = await submission.wait(BACKGROUND_CONTEXT);
			} finally {
				turn.signal.removeEventListener("abort", onAbort);
			}
			// The transcript: every message of the log not yet recorded (a replayed cursor is dropped).
			let text: string | null = null;
			const page = await root.entries({ order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT);
			for (const e of page.items) {
				const m = (e.model?.[0] ?? null) as any;
				if (AssistantEntry.is(e) && m) {
					const calls = (m.content as any[]).filter((c) => c.type === "toolCall").map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
					text = textOf(m.content) || text;
					await turn.emit({ kind: "message", role: "assistant", sourceCursor: `pi:${e.id}`, data: { text: textOf(m.content), operationId: turn.operationId, ...(calls.length ? { toolCalls: calls } : {}) } });
				} else if (ToolResultEntry.is(e) && m) {
					await turn.emit({ kind: "message", role: "tool", sourceCursor: `pi:${e.id}`, data: { toolCallId: m.toolCallId, name: m.toolName, text: textOf(m.content), isError: !!m.isError, operationId: turn.operationId } });
				}
			}
			const costUsd = Math.max(0, costOf(await harness.usage(BACKGROUND_CONTEXT)) - before);
			if (settled.status === "done") return { outcome: "completed", costUsd, text: null, detail: null, progress: true };
			return { outcome: turn.signal.aborted ? "failed" : "failed", costUsd, detail: `The run ended unanswered${(settled as any).reason ? `: ${JSON.stringify((settled as any).reason).slice(0, 300)}` : ""}` };
		} finally {
			await harness.close(BACKGROUND_CONTEXT).catch(() => {});
		}
	}
}
