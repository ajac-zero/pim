// What Forge needs from outside, as ports. Production wires them to vendor CLIs in sandboxes, AmpHttpOrbClient, S3 Objects and the git host; tests wire deterministic fakes.
import { createHash } from "node:crypto";
import { type OrbClient } from "@pim/coding/orb/types";
import { type ObjectMetadata, type ObjectStore } from "@pim/v2-contracts/platform";
import { type ComputeHandle } from "./compute";
import { type EventInput } from "./store";

export type TurnRequest = {
	threadId: string;
	operationId: string;
	prompt: string;
	/** The vendor session to resume (CLI harnesses) or null for a fresh one. */
	sessionId: string | null;
	resume: boolean;
	maxBudgetUsd: number | null;
	workspace: ComputeHandle | null;
	/** The lease epoch the worker holds for this turn; storage written for it is fenced by it. */
	epoch: number;
	/** Aborted when the thread is aborted or archived, or an interrupting steer comes. */
	signal: AbortSignal;
	/** Records a transcript event of the turn (an assistant message, a tool result, a notice) under the thread's lease; a worker that lost the lease gets an error. */
	emit(event: EventInput): Promise<unknown>;
	/** Records a test run the agent made. */
	recordTest(run: { command: string; exitCode: number | null; output: string }): Promise<void>;
	/** The steers that wait for this thread, which a harness that takes input mid-turn (pi) reads while it runs and marks `sent` once its turn has them; a harness that doesn't leaves them for the next turn. */
	steers?: { next(): Promise<{ operationId: string; text: string }[]>; sent(operationId: string, text: string): Promise<unknown> };
};

export type TurnResult = {
	/** `busy`: the person's login for the harness is in use by another of their threads; the input waits and nothing is lost. */
	outcome: "completed" | "interrupted" | "failed" | "login_required" | "budget" | "session_limit" | "busy";
	/** The vendor session's whole cost and usage so far, kept for the next turn's delta. */
	sessionCostUsd?: number | null;
	sessionUsage?: object | null;
	sessionId?: string | null;
	costUsd?: number;
	tokensIn?: number;
	tokensOut?: number;
	text?: string | null;
	detail?: string | null;
	/** Whether the turn committed something new (resets the session-limit loop counter). */
	progress?: boolean;
};

/** Runs one turn of a sandbox harness: pi (through its pi-durable partition) or one vendor CLI process per turn through workspace.exec. */
export interface TurnPort {
	run(turn: TurnRequest): Promise<TurnResult>;
	/** Finishes off a run a dead worker left behind (kills the CLI, writes the login back, lets the lock go). */
	recover?(run: { threadId: string; operationId: string; record: unknown; workspace: ComputeHandle | null }): Promise<void>;
}

/** The orb client for a thread, or null when the deployment has none (no Amp credential). */
export type OrbClients = (thread: { threadId: string; ownerId: string }) => OrbClient | null | Promise<OrbClient | null>;

/** Objects: S3, through the contracts' `ObjectStore`. Autosave bundles and mirrored attachments live here, never in PostgreSQL. */
export type Objects = ObjectStore;

export class MemoryObjects implements ObjectStore {
	readonly map = new Map<string, { bytes: Uint8Array; contentType: string }>();
	async put(key: string, body: Uint8Array, options: { contentType: string }): Promise<ObjectMetadata> {
		this.map.set(key, { bytes: body, contentType: options.contentType });
		return { key, size: body.length, contentType: options.contentType, etag: createHash("sha256").update(body).digest("hex") };
	}
	async get(key: string) {
		const o = this.map.get(key);
		return o ? { body: o.bytes, metadata: await this.head(key).then((m) => m!) } : null;
	}
	async head(key: string): Promise<ObjectMetadata | null> {
		const o = this.map.get(key);
		return o ? { key, size: o.bytes.length, contentType: o.contentType, etag: createHash("sha256").update(o.bytes).digest("hex") } : null;
	}
	async delete(key: string) {
		this.map.delete(key);
	}
	async presign(key: string, options: { method: "GET" | "PUT"; expiresInSeconds: number }) {
		return `memory://${key}?method=${options.method}&expires=${options.expiresInSeconds}`;
	}
}

/** Fetches an Amp attachment as the person's Amp login (the login never leaves this call); null when it can't be fetched yet. */
/** `null`: it can never be mirrored (refused, wrong type, too big); `"retry"`: ask again on the next sync. */
export type AttachmentFetcher = (canonicalUrl: string, thread: { threadId: string; ownerId: string }) => Promise<{ bytes: Uint8Array; type: string } | null | "retry">;

export type PushOutcome = { outcome: "pushed" | "unchanged"; sha: string };
export type MergeOutcome = { outcome: "merged" | "conflict"; method?: "fast-forward" | "rebase"; sha?: string; detail?: string };

/** A git host (GitHub App or Gitea). The branch rules are Forge's; the host only moves refs and never force-pushes. */
export interface GitHost {
	defaultBranch(repo: string): Promise<string>;
	/** Pushes the thread's checkout HEAD to `branch`; `unchanged` when the branch already is there. */
	push(workspace: ComputeHandle, repo: string, branch: string): Promise<PushOutcome>;
	/** Integrates `branch`, already on the host, onto the default branch by fast-forward, else rebase, in a throwaway clone; a conflict aborts and leaves the default branch alone. Works for any thread, including an Amp orb's. */
	mergeBranch(repo: string, branch: string): Promise<MergeOutcome>;
	openPullRequest(repo: string, branch: string, base: string, title: string, body?: string): Promise<{ url: string; number: number }>;
	/** The diff of `branch` (or a commit) against `since`, by default the default branch, as the host has it (for remote orbs); null when the branch is not on the host. */
	remoteDiff(repo: string, branch: string, since?: string): Promise<string | null>;
	/** Whether `ancestor` is reachable from `descendant`, a commit the host already has: how the broker tells a fast-forward from a force. A host that can't say leaves this out, and the broker then takes only a branch's first push. */
	isAncestor?(repoUrl: string, ancestor: string, descendant: string): Promise<boolean>;
	/** Deletes a branch on the host; a separate explicit operation from archiving. */
	deleteBranch(repo: string, branch: string): Promise<void>;
	/** Whether the branch exists on the host. */
	hasBranch(repo: string, branch: string): Promise<boolean>;
}
