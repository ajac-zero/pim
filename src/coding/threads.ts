import { digestHex } from "../auth/store";
import { HttpError } from "../http";
import type { CodingCreator, CodingErrorCode, CodingThreadSummary, CodingThreadView, StartCodingThread } from "./api";
import { threadPath } from "./api";
import { GitBrokerError, parseRepoUrl } from "./git-broker/broker";
import { brokerPolicy } from "./git-broker/config";
import { cliHarness } from "./harness";
import { codingScheduler } from "./scheduler-do";
import { codingThread, DEFAULT_BUDGET_USD } from "./thread-do";
import type { IndexedThread } from "./thread-index";
import { type AgentProfile, CODING_HARNESSES } from "./thread-store";

/**
 * A space's coding threads as the API (./api.ts) and agents' tools
 * (../extensions/coding.ts) reach them: started in the space's list first
 * (./thread-index.ts), and found there before every call, so a space
 * reaches only its own threads.
 */

/** A refusal with its HTTP status and a code a client can tell apart. */
export class CodingError extends HttpError {
	constructor(
		status: number,
		message: string,
		readonly code: CodingErrorCode,
	) {
		super(status, message);
	}
}

type Listed = IndexedThread & { readonly queue: CodingThreadSummary["queue"] };

/** A thread of the space, as its list has it; `not_found` for one that isn't the space's. */
export async function ownedThread(env: Env, space: string, threadId: string): Promise<Listed> {
	const thread = typeof threadId === "string" && threadId.length <= 128 ? await codingScheduler(env, space).thread(threadId) : null;
	if (!thread) throw new CodingError(404, `No coding thread ${threadId}`, "not_found");
	return thread;
}

export function summaryOf(thread: Listed): CodingThreadSummary {
	return {
		id: thread.threadId,
		url: threadPath(thread.threadId),
		repo: thread.repo,
		ref: thread.ref,
		branch: thread.branch,
		task: thread.task,
		state: thread.state,
		stateReason: thread.stateReason,
		queue: thread.queue,
		createdBy: thread.createdBy,
		parent: thread.parent,
		chat: thread.chat,
		harness: thread.harness,
		spentUsd: thread.spentUsd,
		budgetUsd: thread.budgetUsd,
		createdAt: thread.createdAt,
		updatedAt: thread.updatedAt,
	};
}

/** The space's threads, newest first. */
export async function listThreads(env: Env, space: string): Promise<CodingThreadSummary[]> {
	return (await codingScheduler(env, space).threads()).map(summaryOf);
}

/** A thread of the space in full: its own status, with what the list says of it. */
export async function threadView(env: Env, space: string, threadId: string, listed?: Listed): Promise<CodingThreadView> {
	const thread = listed ?? (await ownedThread(env, space, threadId));
	const status = await codingThread(env, thread.threadId).status();
	return viewOf(thread, status);
}

export function viewOf(thread: Listed, status: Awaited<ReturnType<ReturnType<typeof codingThread>["status"]>>): CodingThreadView {
	return {
		...status,
		id: thread.threadId,
		url: threadPath(thread.threadId),
		task: thread.task,
		createdBy: thread.createdBy,
		status: status.state,
		...(status.queue ? { position: status.queue.position, reason: status.queue.reason } : {}),
	};
}

/** A thread's ID: from the space and the start's operation, so starting again with it reaches the same thread, and no other space's. */
export async function codingThreadId(space: string, operationId: string): Promise<string> {
	const hex = await digestHex(`pim coding thread\n${space}\n${operationId}`);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const invalid = (message: string) => new CodingError(400, message, "invalid");

/** The ID a thread records as who started it: the person's own, or the agent's. */
const creatorId = (space: string, creator: CodingCreator) => (creator.type === "agent" ? `agent:${creator.agent}` : space);

/**
 * Starts a thread in the space: checks what it's given, enters the thread
 * in the space's list, and starts it, which returns at once, queued when the
 * space's slots are taken. The same `operationId` again answers with the
 * thread it started (`created: false`).
 */
export async function startThread(env: Env, space: string, input: Partial<StartCodingThread>, createdBy: CodingCreator): Promise<{ view: CodingThreadView; created: boolean }> {
	const task = typeof input.task === "string" ? input.task.trim() : "";
	if (!task) throw invalid("A coding thread needs a task");
	if (typeof input.repo !== "string") throw invalid("repo must be https://github.com/<owner>/<name>");
	let repo: string;
	try {
		repo = `https://github.com/${parseRepoUrl(input.repo, brokerPolicy(env)).fullName}`;
	} catch (error) {
		if (error instanceof GitBrokerError) throw new CodingError(error.status, error.message, error.status === 403 ? "forbidden" : "invalid");
		throw error;
	}
	const ref = input.ref ?? "main";
	if (typeof ref !== "string" || !ref.trim() || ref.length > 200 || /[\s\u0000-\u001f]/.test(ref)) throw invalid("ref must be a branch, tag or commit");
	const budgetUsd = input.budgetUsd ?? DEFAULT_BUDGET_USD;
	if (typeof budgetUsd !== "number" || !(Number.isFinite(budgetUsd) && budgetUsd > 0)) throw invalid("budgetUsd must be a positive number of dollars");
	const harness = input.harness ?? "pi";
	if (!CODING_HARNESSES.includes(harness)) throw invalid(`harness must be ${CODING_HARNESSES.join(", ")}`);
	if (harness !== "pi" && !cliHarness(harness)) throw invalid("harness not yet available");
	if (input.chat !== undefined && (typeof input.chat !== "string" || !input.chat || input.chat.length > 128)) throw invalid("chat must be a chat's ID");
	const profile = input.profile === undefined ? undefined : profileOf(input.profile);
	if (input.parent !== undefined && input.parent !== null) await ownedThread(env, space, input.parent);
	if (input.operationId !== undefined && (typeof input.operationId !== "string" || !input.operationId || input.operationId.length > 200)) {
		throw invalid("operationId must be a string of at most 200 characters");
	}
	const operationId = input.operationId ?? crypto.randomUUID();
	const threadId = await codingThreadId(space, operationId);
	const scheduler = codingScheduler(env, space);
	const known = await scheduler.thread(threadId);
	if (known) return { view: await threadView(env, space, threadId, known), created: false };
	await scheduler.registerThread({ threadId, createdBy, parent: input.parent ?? null, chat: createdBy.type === "agent" ? createdBy.chat : (input.chat ?? null), harness, task, repo, ref, budgetUsd, createdAt: Date.now() });
	const stub = codingThread(env, threadId);
	let status: Awaited<ReturnType<typeof stub.start>>;
	try {
		status = await stub.start({
			space,
			repo,
			ref,
			task,
			...(profile ? { profile } : {}),
			harness,
			budgetUsd,
			parent: input.parent ?? null,
			createdBy: creatorId(space, createdBy),
			operationId,
		});
	} catch (error) {
		// Such as a model the space doesn't have: the thread recorded nothing, so the list keeps nothing either.
		await scheduler.forgetThread(threadId);
		throw new CodingError(400, error instanceof Error ? error.message : String(error), "invalid");
	}
	const listed = (await scheduler.thread(threadId))!;
	return { view: viewOf(listed, status), created: true };
}

function profileOf(value: unknown): AgentProfile {
	const given = value as Partial<AgentProfile> | null;
	if (!given || typeof given !== "object" || typeof given.providerId !== "string" || !given.providerId || typeof given.model !== "string" || !given.model) {
		throw invalid("profile must be { providerId, model }, a provider and model of the space");
	}
	const thinking = given.thinking;
	if (thinking !== undefined && !["minimal", "low", "medium", "high", "xhigh"].includes(thinking)) throw invalid("profile.thinking must be minimal, low, medium, high or xhigh");
	return { providerId: given.providerId, model: given.model, ...(thinking ? { thinking } : {}) };
}

/**
 * A thread the call may change: not archived, and for `steer`, with budget
 * left. Checked before calling the thread, which refuses the same, so the
 * refusal comes back with its code.
 */
export async function liveThread(env: Env, space: string, threadId: string, options: { budget?: boolean } = {}) {
	const listed = await ownedThread(env, space, threadId);
	const stub = codingThread(env, listed.threadId);
	const status = await stub.status();
	if (status.state === "archived") throw new CodingError(409, "This coding thread is archived", "archived");
	if (options.budget && status.spentUsd >= status.budgetUsd) {
		throw new CodingError(409, `This coding thread has spent its $${status.budgetUsd} budget: continue it with a bigger one`, "budget_spent");
	}
	return { listed, stub, status };
}

/** A refusal the thread made, which got here as an error: a conflict with its state, said as it said it. */
export function refusal(error: unknown): CodingError {
	if (error instanceof CodingError) return error;
	return new CodingError(409, error instanceof Error ? error.message : String(error), "conflict");
}

/** Wraps `view` for a thread's call: its refusals come back as conflicts. */
export async function calling<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		throw refusal(error);
	}
}
