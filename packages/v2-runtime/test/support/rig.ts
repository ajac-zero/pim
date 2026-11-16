import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, createRegistry, defineExtension, defineTool, type EntryRecord, type Harness, type HarnessOptions, type TaskId } from "@earendil-works/pi-durable";
import type { Db } from "../../src/db.ts";
import { type Runner, type RunnerEvent, type RunnerOptions } from "../../src/runner.ts";
import { Runner as RunnerClass } from "../../src/runner.ts";
import { PgPiStorage } from "../../src/storage.ts";

export { fauxAssistantMessage, fauxToolCall };

/** A deferred promise a test releases by hand. */
export function latch(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

export async function waitFor<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 15_000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = await check();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/**
 * A scripted model and one tool, `gate`, for driving the Runner: `gate` is replay-safe and suspends the call until a
 * decision has been recorded for its task, which is how Pim holds a tool call for an approval.
 */
export function createRig(db: Db, ownerId: string) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const state = {
		gateRuns: [] as number[],
		gateLatch: undefined as ReturnType<typeof latch> | undefined,
		streamAborted: false,
	};
	const decided = async (taskId: number): Promise<boolean> => {
		const rows = await db.read(ownerId, "SELECT 1 FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2", [ownerId, taskId]);
		return rows.rows.length > 0;
	};
	const gate = defineTool({
		name: "gate",
		description: "Waits for a decision",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, context) => {
			state.gateRuns.push(api.taskId);
			// The decision is read before the call can be held, so a decision that arrives meanwhile is early: it reaches the task only through resumeTask.
			const hadDecision = await decided(api.taskId);
			const held = state.gateLatch;
			if (held !== undefined) {
				await Promise.race([held.promise, new Promise<void>((resolve) => context.abortSignal?.addEventListener("abort", () => resolve(), { once: true }))]);
				context.abortSignal?.throwIfAborted();
			}
			if (!hadDecision) return { control: { suspend: true } };
			return { content: [{ type: "text", text: "approved" }] };
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "gate", tools: [gate] }));
	const settings: { retry: { enabled: boolean; maxRetries: number; baseDelayMs: number } } = { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1_000 } };
	const harnessOptions = (): HarnessOptions => ({ models, registry, settings });
	const agent = { model: { provider: "faux", modelId: "m" } };
	const events: RunnerEvent[] = [];
	const reports: unknown[] = [];
	const runner = (options: Partial<RunnerOptions> = {}): Runner =>
		new RunnerClass({
			db,
			harnessOptions,
			homeRoot: () => ({ agent }),
			chatAgent: () => agent,
			listen: false,
			ownerFilter: ownerId,
			pollMs: 40,
			idleUnloadMs: 0,
			longWaitMs: 1_500,
			onEvent: (event) => events.push(event),
			onReport: (error) => reports.push(error),
			...options,
			steward: { holderId: `runner-${randomUUID().slice(0, 6)}`, leaseTtlMs: 4_000, ...options.steward },
		});
	return { faux, models, registry, settings, harnessOptions, agent, state, events, reports, runner, gate };
}

export type Rig = ReturnType<typeof createRig>;

/** The committed transcript of a conversation, oldest first, read without owning the partition. */
export async function readTranscript(db: Db, ownerId: string, partitionId: string, conversationId: number): Promise<EntryRecord[]> {
	try {
		const page = await PgPiStorage.forReading(db, ownerId, partitionId).scanEntries({ conversationId: conversationId as never, order: "ascending" }, 1_000, undefined, BACKGROUND_CONTEXT);
		return [...page.items];
	} catch (error) {
		// The conversation does not exist yet: nothing has been written.
		if (error instanceof Error && error.message.startsWith("Unknown conversation")) return [];
		throw error;
	}
}

/** The transcript through a live conversation handle. */
export async function transcript(_harness: Harness, conversation: Conversation): Promise<EntryRecord[]> {
	const page = await conversation.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT);
	return [...page.items];
}

export const textOf = (entry: EntryRecord): string =>
	JSON.stringify(entry.model ?? "").includes("approved") ? "approved" : (entry.model ?? []).map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join(""))).join("");

export type { TaskId };
