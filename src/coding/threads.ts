import { digestHex } from "../auth/store";
import { HttpError } from "@pim/shared/http";
import type { CodingCreator } from "@pim/coding/thread-index";
import type { CodingErrorCode, CodingThreadSummary, CodingThreadView, StartCodingThread } from "./api";
import { threadPath } from "./api";
import { GitBrokerError } from "@pim/coding/git-broker/broker";
import { brokerPolicy } from "@pim/coding/git-broker/config";
import { deploymentProviders } from "./git-broker/worker";
import { AMP_HTTP_UNSUPPORTED, AmpHttpOrbClient } from "@pim/coding/orb/amp-http";
import { type OrbMessage, OrbAuthError, OrbError, OrbLostError } from "@pim/coding/orb/types";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { TranscriptMessage } from "@pim/shared/transcript";
import { codingVault } from "./vault/worker";
import { cliHarness } from "@pim/coding/harness/index";
import { codingScheduler, codingThreadsChanged } from "./scheduler-do";
import { codingThread } from "./thread-do";
import type { IndexedThread } from "@pim/coding/thread-index";
import { type AgentProfile, CODING_HARNESSES } from "@pim/coding/thread-store";

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

/** A branch or commit as a git host names it: no `..`, spaces or control characters. */
export const BRANCH_OR_COMMIT = /^(?!.*\.\.)[0-9A-Za-z._/-]{1,200}$/;

type Listed = IndexedThread & { readonly queue: CodingThreadSummary["queue"] };

/** A thread a caller names: one of Pim's by its id, or an Amp thread by its `T-…` id. */
export type ThreadRef = { readonly kind: "pim" | "amp"; readonly id: string };

/**
 * What a caller may give for a thread: a Pim coding thread's id, its page (`/coding/<id>`, with or without
 * the deployment's origin), an Amp thread's id (`T-…`) or its page (`https://ampcode.com/threads/T-…`).
 */
export function threadRef(input: string): ThreadRef {
	const given = typeof input === "string" ? input.trim() : "";
	if (/^T-[A-Za-z0-9_-]+$/.test(given)) return { kind: "amp", id: given };
	const amp = /^https?:\/\/(?:www\.)?ampcode\.com\/threads\/(T-[A-Za-z0-9_-]+)\/?(?:[?#].*)?$/.exec(given);
	if (amp) return { kind: "amp", id: amp[1]! };
	const page = /^(?:https?:\/\/[^/\s]+)?\/coding\/([^/?#\s]+)\/?(?:[?#].*)?$/.exec(given);
	return { kind: "pim", id: page ? page[1]! : given };
}

/** The space's thread that runs on the Amp thread `orbId`, as its list has it; null when it has none. Rows from before the list kept Amp's id are found by asking the space's recent Amp threads. */
async function threadOfOrb(env: Env, space: string, orbId: string): Promise<Listed | null> {
	const scheduler = codingScheduler(env, space);
	const known = await scheduler.threadByOrb(orbId);
	if (known) return known;
	const candidates = (await scheduler.threads()).filter((thread) => thread.harness === "amp" && !thread.orbId).slice(0, 50);
	for (const candidate of candidates) {
		const orb = (await codingThread(env, candidate.threadId).status().catch(() => null))?.orb;
		if (orb && (orb.threadId === orbId || orb.url.endsWith(`/${orbId}`))) {
			await scheduler.recordThreadOrb(candidate.threadId, orbId, orb.url);
			return (await scheduler.thread(candidate.threadId)) ?? null;
		}
	}
	return null;
}

/** A thread of the space, as its list has it; `not_found` for one that isn't the space's. */
export async function ownedThread(env: Env, space: string, threadId: string): Promise<Listed> {
	const ref = threadRef(threadId);
	const thread = typeof threadId !== "string" || threadId.length > 512 ? null : ref.kind === "amp" ? await threadOfOrb(env, space, ref.id) : ref.id.length <= 128 ? await codingScheduler(env, space).thread(ref.id) : null;
	if (!thread) {
		throw new CodingError(404, ref.kind === "amp" ? `Pim holds no coding thread of this space for Amp thread ${ref.id}: only coding_status, coding_transcript and coding_transcript_output can read one it didn't start` : `No coding thread ${threadId}`, "not_found");
	}
	return thread;
}

/** An Amp thread this space's Pim didn't start, read on Amp's site with the space's own Amp login. */
export type ExternalAmpThread = Awaited<ReturnType<AmpHttpOrbClient["readThread"]>> & { readonly transcript: TranscriptMessage[] };

/** One Amp message as a transcript's messages: what was said, the tools it called, and what they printed, each result its own message. */
function transcriptOfOrb(messages: readonly OrbMessage[]): TranscriptMessage[] {
	const out: TranscriptMessage[] = [];
	for (const message of messages) {
		const parts = message.parts ?? [{ type: "text" as const, text: message.text }];
		const results = parts.filter((part) => part.type === "toolResult");
		const said = parts.flatMap<TranscriptMessage["parts"][number]>((part) => (part.type === "text" ? [{ type: "text", text: part.text }] : part.type === "toolCall" ? [{ type: "tool-call", id: part.id, name: part.name, arguments: part.arguments as JsonValue }] : []));
		if (message.role === "assistant" ? said.length > 0 : message.text || results.length === 0) {
			out.push({ id: message.id, role: message.role, parts: message.role === "assistant" ? said : [{ type: "text", text: message.text }], timestamp: message.at });
		}
		for (const [at, result] of results.entries()) {
			out.push({ id: `${message.id}.${at + 1}`, role: "tool", parts: [{ type: "tool-result", id: result.id, name: result.name, content: [{ type: "text", text: result.text }], error: result.isError }], timestamp: message.at });
		}
	}
	return out;
}

/** The Amp thread `orbId` read directly, for one that Pim didn't start. Refuses, as a coding error, when Amp isn't connected in the space or has no such thread. */
export async function readAmpThread(env: Env, space: string, orbId: string): Promise<ExternalAmpThread> {
	const vault = codingVault(env);
	if ((await vault.loadApiKey(space, "amp")) === null) throw new CodingError(409, "Amp isn't connected in this space: add an Amp token on the Coding page first", "conflict");
	const values = new Map<string, unknown>();
	const client = new AmpHttpOrbClient({ token: () => vault.loadApiKey(space, "amp"), store: { get: async (key) => values.get(key) ?? null, put: async (key, value) => void values.set(key, value), claim: async (key, value) => !values.has(key) && !!values.set(key, value) } });
	try {
		const thread = await client.readThread(orbId);
		return { ...thread, transcript: transcriptOfOrb(thread.messages) };
	} catch (error) {
		if (error instanceof OrbLostError) throw new CodingError(404, `Amp has no thread ${orbId} for this space's Amp login`, "not_found");
		if (error instanceof OrbError) throw new CodingError(error instanceof OrbAuthError ? 409 : 502, error.message, "conflict");
		throw error;
	}
}

/** A thread a read tool names: one of the space's, or an Amp thread it can read on Amp's site. */
export async function readableThread(env: Env, space: string, input: string): Promise<{ readonly owned: Listed } | { readonly external: ExternalAmpThread }> {
	const ref = threadRef(input);
	if (ref.kind === "amp" && !(await threadOfOrb(env, space, ref.id))) return { external: await readAmpThread(env, space, ref.id) };
	return { owned: await ownedThread(env, space, input) };
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
		resolvedProfile: thread.resolvedProfile ?? null,
		spentUsd: thread.spentUsd,
		budgetUsd: thread.budgetUsd,
		createdAt: thread.createdAt,
		updatedAt: thread.updatedAt,
		lastTurnEndedAt: thread.lastTurnEndedAt,
		lastSeenAt: thread.lastSeenAt,
		...(thread.orbUrl ? { orbUrl: thread.orbUrl, ...(thread.orbId ? { orbId: thread.orbId } : {}) } : {}),
	};
}

/** The space's threads, newest first. Only running threads are woken for activity, at most eight at once. */
export async function listThreads(env: Env, space: string): Promise<CodingThreadSummary[]> {
	const threads = await codingScheduler(env, space).threads();
	const items = threads.map(summaryOf);
	const running = threads.flatMap((thread, index) => thread.state === "running" ? [index] : []);
	let next = 0;
	const worker = async () => {
		while (next < running.length) {
			const index = running[next++]!;
			try {
				items[index] = { ...items[index]!, activity: await codingThread(env, threads[index]!.threadId).activity() };
			} catch {
				// Activity is best-effort: a broken thread must not hide the space's list.
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(8, running.length) }, worker));
	return items;
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
	if (typeof input.repo !== "string") throw invalid("repo must be a repository address, such as https://github.com/<owner>/<name>");
	let repo: string;
	try {
		const resolved = deploymentProviders(env).resolveUrl(input.repo, brokerPolicy(env));
		repo = resolved.provider.repoUrl(resolved.repo);
	} catch (error) {
		if (error instanceof GitBrokerError) throw new CodingError(error.status, error.message, error.status === 403 ? "forbidden" : "invalid");
		throw error;
	}
	const ref = input.ref ?? "main";
	if (typeof ref !== "string" || !ref.trim() || ref.length > 200 || /[\s\u0000-\u001f]/.test(ref)) throw invalid("ref must be a branch, tag or commit");
	const budgetUsd = input.budgetUsd ?? null;
	if (budgetUsd !== null && (typeof budgetUsd !== "number" || !(Number.isFinite(budgetUsd) && budgetUsd > 0))) throw invalid("budgetUsd must be a positive number of dollars");
	const harness = input.harness ?? "pi";
	if (!CODING_HARNESSES.includes(harness)) throw invalid(`harness must be ${CODING_HARNESSES.join(", ")}`);
	// amp harness uses agent-hosted Orbs, so it doesn't have a CLI harness entry but is still valid
	if (harness !== "pi" && harness !== "amp" && !cliHarness(harness)) throw invalid("harness not yet available");
	if (input.chat !== undefined && (typeof input.chat !== "string" || !input.chat || input.chat.length > 128)) throw invalid("chat must be a chat's ID");
	const profile = input.profile === undefined ? undefined : profileOf(input.profile);
	if (input.parent !== undefined && input.parent !== null) await ownedThread(env, space, input.parent);
	if (input.operationId !== undefined && (typeof input.operationId !== "string" || !input.operationId || input.operationId.length > 200)) {
		throw invalid("operationId must be a string of at most 200 characters");
	}
	for (const field of ["pool", "provider"] as const) {
		const given = input[field];
		if (given !== undefined && (typeof given !== "string" || !given.trim() || given.length > 100)) throw invalid(`${field} must be the name of a coding sandbox pool, such as compose or cloudflare`);
	}
	if ([input.pool, input.provider].some((name) => name === "orbs" || name === "amp-http") && harness !== "amp") throw invalid("Orbs requires harness amp");
	// workspace Amp is retired; amp harness uses agent-hosted Orbs only, no sandbox slot.
	// Explicit non-orb pool/provider with harness amp is refused.
	if (harness === "amp" && [input.pool, input.provider].some((name): name is string => name !== undefined && name !== "orbs" && name !== "amp-http")) {
		throw invalid("workspace Amp is retired; amp harness now uses agent-hosted Orbs only, with no sandbox slot. Do not set pool or provider with harness amp.");
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
			...(input.pool !== undefined ? { pool: input.pool } : {}),
			...(input.provider !== undefined ? { provider: input.provider } : {}),
			...(input.rebuildEnvironment !== undefined ? { rebuildEnvironment: input.rebuildEnvironment } : {}),
		});
	} catch (error) {
		// Such as a model the space doesn't have: the thread recorded nothing, so the list keeps nothing either.
		await scheduler.forgetThread(threadId);
		throw new CodingError(400, error instanceof Error ? error.message : String(error), "invalid");
	}
	await codingThreadsChanged(env, space);
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
	if (options.budget && status.budgetUsd !== null && status.spentUsd >= status.budgetUsd) {
		throw new CodingError(409, `This coding thread has spent its $${status.budgetUsd} budget: continue it with a bigger one`, "budget_spent");
	}
	return { listed, stub, status };
}

/** A refusal the thread made, which got here as an error: a conflict with its state, said as it said it. */
export function refusal(error: unknown): CodingError {
	if (error instanceof CodingError) return error;
	const message = error instanceof Error ? error.message : String(error);
	// The thread's own budget refusal, such as a CLI harness's token ceiling, which the route can't check before calling it.
	return new CodingError(409, message, message === AMP_HTTP_UNSUPPORTED ? "unsupported" : /: continue it with a bigger one$/.test(message) ? "budget_spent" : "conflict");
}

/** Wraps `view` for a thread's call: its refusals come back as conflicts. */
export async function calling<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		throw refusal(error);
	}
}
