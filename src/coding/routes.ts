import { getAgentByName } from "agents";
import type { Account } from "../directory";
import type { ApiExtension } from "../gateway";
import { dispatch, HttpError, readJson, type Route } from "../http";
import type { TranscriptMessage } from "../transcript";
import { CODING_API_PATH, CODING_REPOS_PATH, type CodingErrorCode, type CodingPushRequested, type StartCodingThread } from "./api";
import { GitBrokerError, repoRef } from "./git-broker/broker";
import { brokerPolicy } from "./git-broker/config";
import { MAX_SETUP_SCRIPT_BYTES } from "./environment-cache";
import { codingScheduler, codingThreadsChanged } from "./scheduler-do";
import { codingThread } from "./thread-do";
import { calling, CodingError, listThreads, liveThread, ownedThread, startThread, threadView, viewOf } from "./threads";

/**
 * The coding threads API, `/api/coding/threads` (docs/coding-api.md), for
 * the signed-in person's own space: the gateway (../gateway.ts) has checked
 * who they are. Every route but the list and a start finds the thread in the
 * space's list first, so another space's thread is `404`. The person's
 * settings for each repository are under `/api/coding/repos`. The git broker,
 * `/api/coding/git`, is apart: a workspace reaches it with its own token.
 */
export function codingApi(env: Env, account: Account, request: Request): ApiExtension {
	return async (path) => {
		if (path !== CODING_API_PATH && !path.startsWith(`${CODING_API_PATH}/`) && !path.startsWith(`${CODING_REPOS_PATH}/`)) return undefined;
		if (account.role === "guest") return failure(new CodingError(403, "A guest's account has no coding threads.", "forbidden"));
		return dispatch(codingRoutes(env, account.ownerId), request, path);
	};
}

const STATUS_CODES: Record<number, CodingErrorCode> = { 400: "invalid", 403: "forbidden", 404: "not_found" };

function failure(error: unknown): Response {
	if (error instanceof CodingError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
	if (error instanceof HttpError) return Response.json({ error: error.message, code: STATUS_CODES[error.status] ?? "conflict" }, { status: error.status });
	console.error(JSON.stringify({ event: "pim.coding.api_failed", error: String(error) }));
	return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

/** Each handler's refusals answered with their codes. */
const route = (method: string, pattern: string, handler: Route[2]): Route => [
	method,
	`${CODING_API_PATH}${pattern}`,
	async (params, request, url) => {
		try {
			return await handler(params, request, url);
		} catch (error) {
			return failure(error);
		}
	},
];

/** A string field of a body, if given. */
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
	const value = body[field];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new CodingError(400, `${field} must be a string`, "invalid");
	return value;
}

function sinceOf(url: URL): number {
	const given = url.searchParams.get("since");
	const since = given === null ? 0 : Number(given);
	if (!Number.isInteger(since) || since < 0) throw new CodingError(400, "since must be a log entry's seq", "invalid");
	return since;
}

function codingRoutes(env: Env, space: string): Route[] {
	const thread = (id: string) => ownedThread(env, space, id);
	/** A route of a repository's settings, `/coding/repos/:owner/:name/settings`, given the repository as `owner/name` once the deployment allows it. */
	const repoRoute = (method: string, handler: (repo: string, request: Request) => Promise<unknown>): Route => [
		method,
		`${CODING_REPOS_PATH}/:owner/:name/settings`,
		async ({ owner, name }, request) => {
			try {
				let repo: string;
				try {
					repo = repoRef(owner!, name!, brokerPolicy(env)).fullName;
				} catch (error) {
					if (error instanceof GitBrokerError) throw new CodingError(error.status, error.message, error.status === 403 ? "forbidden" : "invalid");
					throw error;
				}
				return await handler(repo, request);
			} catch (error) {
				return failure(error);
			}
		},
	];
	return [
		route("GET", "", async () => ({ threads: await listThreads(env, space) })),
		route("POST", "", async (_params, request) => {
			const body = await readJson<StartCodingThread>(request);
			const { view, created } = await startThread(env, space, body, { type: "person" });
			return Response.json(view, { status: created ? 201 : 200 });
		}),
		route("GET", "/:id", ({ id }) => threadView(env, space, id!)),
		route("POST", "/:id/seen", async ({ id }) => {
			const listed = await thread(id!);
			await codingScheduler(env, space).markThreadSeen(listed.threadId);
			await codingThreadsChanged(env, space);
			return { seen: true };
		}),
		route("GET", "/:id/transcript", async ({ id }) => {
			// Typed by hand: the transcript's type is too deep for the RPC stub's.
			const stub = codingThread(env, (await thread(id!)).threadId) as unknown as { transcript(): Promise<TranscriptMessage[]> };
			return { messages: await stub.transcript() };
		}),
		route("GET", "/:id/diff", async ({ id }, _request, url) => {
			const { threadId } = await thread(id!);
			const since = url.searchParams.get("since") ?? undefined;
			if (since !== undefined && !/^[0-9a-zA-Z]{4,64}$/.test(since)) throw new CodingError(400, "since must be a commit", "invalid");
			try {
				return await codingThread(env, threadId).diff(since);
			} catch (error) {
				throw new CodingError(409, error instanceof Error ? error.message : String(error), "workspace_not_running");
			}
		}),
		route("GET", "/:id/tests", async ({ id }) => ({ runs: await codingThread(env, (await thread(id!)).threadId).tests() })),
		route("GET", "/:id/log", async ({ id }, _request, url) => {
			const events = await codingThread(env, (await thread(id!)).threadId).log(sinceOf(url));
			return { events, next: events.at(-1)?.seq ?? sinceOf(url) };
		}),
		route("GET", "/:id/events", async ({ id }, request) => {
			const stream = await codingThread(env, (await thread(id!)).threadId).events();
			const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
			if (!request.headers.get("accept")?.includes("text/event-stream")) return new Response(stream, { headers: { ...headers, "content-type": "application/x-ndjson" } });
			return new Response(stream.pipeThrough(ndjsonToSse()), { headers: { ...headers, "content-type": "text/event-stream" } });
		}),
		route("POST", "/:id/steer", async ({ id }, request) => {
			const body = await readJson<Record<string, unknown>>(request);
			const text = optionalString(body, "text")?.trim();
			if (!text) throw new CodingError(400, "text must say something", "invalid");
			if (body.interrupt !== undefined && typeof body.interrupt !== "boolean") throw new CodingError(400, "interrupt must be true or false", "invalid");
			const operationId = optionalString(body, "operationId") ?? crypto.randomUUID();
			const { listed, stub } = await liveThread(env, space, id!, { budget: true });
			return viewOf(listed, await calling(() => stub.steer(text, { interrupt: body.interrupt === true, operationId })));
		}),
		route("POST", "/:id/abort", async ({ id }) => {
			const { listed, stub } = await liveThread(env, space, id!);
			return viewOf(listed, await calling(() => stub.abort()));
		}),
		route("POST", "/:id/continue", async ({ id }, request) => {
			const body = await readJson<Record<string, unknown>>(request);
			const budgetUsd = body.budgetUsd;
			if (budgetUsd !== undefined && (typeof budgetUsd !== "number" || !(Number.isFinite(budgetUsd) && budgetUsd > 0))) {
				throw new CodingError(400, "budgetUsd must be a positive number of dollars", "invalid");
			}
			const operationId = optionalString(body, "operationId") ?? crypto.randomUUID();
			const { listed, stub, status } = await liveThread(env, space, id!);
			const budget = budgetUsd ?? status.budgetUsd;
			if (budget !== null && budget <= status.spentUsd) {
				throw new CodingError(409, `This coding thread has spent $${status.spentUsd.toFixed(2)}: continue it with a bigger budget`, "budget_spent");
			}
			return viewOf(listed, await calling(() => stub.continue({ operationId, ...(budgetUsd !== undefined ? { budgetUsd } : {}) })));
		}),
		route("POST", "/:id/cancel", async ({ id }) => {
			const { listed, stub, status } = await liveThread(env, space, id!);
			if (status.currentOperation !== null) throw new CodingError(409, "This coding thread's turn has started: abort it instead", "not_cancellable");
			return viewOf(listed, await calling(() => stub.cancel()));
		}),
		route("POST", "/:id/archive", async ({ id }) => {
			const listed = await thread(id!);
			return viewOf(listed, await calling(() => codingThread(env, listed.threadId).archive()));
		}),
		route("GET", "/:id/environment", async ({ id }) => codingThread(env, (await thread(id!)).threadId).environment()),
		route("POST", "/:id/environment/rebuild", async ({ id }) => {
			const { stub } = await liveThread(env, space, id!);
			return calling(() => stub.rebuildEnvironment());
		}),
		repoRoute("GET", async (repo) => codingScheduler(env, space).repoSettings(repo)),
		repoRoute("PUT", async (repo, request) => {
			const setupScript = (await readJson<Record<string, unknown>>(request)).setupScript ?? null;
			if (setupScript !== null && typeof setupScript !== "string") throw new CodingError(400, "setupScript must be a string or null", "invalid");
			if (setupScript !== null && new TextEncoder().encode(setupScript).byteLength > MAX_SETUP_SCRIPT_BYTES) throw new CodingError(400, `setupScript may be at most ${MAX_SETUP_SCRIPT_BYTES / 1024} KiB`, "invalid");
			return calling(() => codingScheduler(env, space).setRepoSettings(repo, { setupScript }));
		}),
		route("POST", "/:id/push", async ({ id }, request) => {
			const branch = optionalString(await readJson<Record<string, unknown>>(request), "branch");
			const listed = await thread(id!);
			const prepared = await codingThread(env, listed.threadId).preparePush(branch);
			if (!prepared.ok) throw new CodingError(prepared.code === "push_refused" ? 403 : 409, prepared.message, prepared.code);
			const { branch: target, checkpoint, head, bytes, summary } = prepared.request;
			const approval = await (await getAgentByName(env.Pim, space)).codingRequestPush(listed.threadId, { branch: target, checkpoint, head, summary });
			const answer: CodingPushRequested = { approval: approval.id, status: approval.status, branch: target, head, bytes, summary };
			return Response.json(answer, { status: 202 });
		}),
	];
}

/** Newline-delimited JSON as server-sent events: each line one `data:` event. */
function ndjsonToSse(): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let pending = "";
	return new TransformStream({
		transform(chunk, controller) {
			pending += decoder.decode(chunk, { stream: true });
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) if (line) controller.enqueue(encoder.encode(`data: ${line}\n\n`));
		},
		flush(controller) {
			if (pending) controller.enqueue(encoder.encode(`data: ${pending}\n\n`));
		},
	});
}
