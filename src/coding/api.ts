import type { CodingThreadStatus } from "./thread-do";
import type { QueuePlace } from "./scheduler";
import type { AgentProfile, CodingHarness, CodingThreadState } from "./thread-store";

/**
 * The coding threads API, under `/api/coding/threads`: what the web app and
 * other clients see of a space's coding threads. See docs/coding-api.md.
 */

export type { CodingHarness };

/** Who started a thread: the person (the web app or the API), or one of their agents, from a chat. */
export type CodingCreator = { readonly type: "person" } | { readonly type: "agent"; readonly agent: string; readonly chat: string };

/** A thread as the space's list has it. */
export type CodingThreadSummary = {
	readonly id: string;
	/** The web app's page for it: `/coding/<id>`. */
	readonly url: string;
	readonly repo: string;
	readonly ref: string;
	readonly branch: string;
	readonly task: string;
	readonly state: CodingThreadState;
	readonly stateReason: string | null;
	readonly queue: QueuePlace | null;
	readonly createdBy: CodingCreator;
	readonly parent: string | null;
	/** The chat it was started from, under which the chat list shows it; null for one started elsewhere. */
	readonly chat: string | null;
	readonly harness: CodingHarness;
	readonly spentUsd: number;
	readonly budgetUsd: number;
	readonly createdAt: number;
	readonly updatedAt: number;
};

/** One thread in full: its status, with what the list says of it. */
export type CodingThreadView = Omit<CodingThreadStatus, "createdBy"> & {
	readonly id: string;
	readonly url: string;
	readonly task: string;
	readonly createdBy: CodingCreator;
	/** `state` again, as starting a thread answers it. */
	readonly status: CodingThreadState;
	/** While queued: its place in the queue, and what it waits for. */
	readonly position?: number;
	readonly reason?: string;
};

/** `POST /api/coding/threads`. */
export type StartCodingThread = {
	readonly repo: string;
	readonly ref?: string;
	readonly task: string;
	readonly profile?: AgentProfile;
	/** The coding agent that runs it; `pi` by default. The others aren't available yet. */
	readonly harness?: CodingHarness;
	/** The chat it is started from, for the chat list to show it under. An agent's own chat is recorded without it. */
	readonly chat?: string;
	readonly budgetUsd?: number;
	readonly parent?: string;
	readonly operationId?: string;
};

/** `POST /api/coding/threads/:id/push`: the approval the person decides. */
export type CodingPushRequested = {
	readonly approval: string;
	readonly status: "pending" | "approved" | "denied";
	readonly branch: string;
	readonly head: string;
	readonly bytes: number;
	readonly summary: string;
};

export type CodingErrorCode =
	| "invalid"
	| "forbidden"
	| "not_found"
	| "archived"
	| "budget_spent"
	| "not_cancellable"
	| "workspace_not_running"
	| "nothing_to_push"
	| "github_app_not_configured"
	| "push_refused"
	| "conflict";

export type CodingApiError = { readonly error: string; readonly code: CodingErrorCode };

/** The web app's page for a thread. */
export const threadPath = (threadId: string) => `/coding/${threadId}`;

/** The path the API's routes are under, in `/api`. */
export const CODING_API_PATH = "/coding/threads";
