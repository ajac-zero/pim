// Compute isolation: a provider of per-thread sandboxes, and the reconciliation that keeps an ambiguous creation from ever launching a second paid sandbox.
import { type ForgeStore, type ThreadRow } from "./store";
import { ForgeError } from "./errors";

export type ComputeHandle = { readonly id: string; readonly provider: string; readonly tag: string };

/** What a new sandbox is made from: the thread's repository, and what it may reach. A provider fills in what is absent. */
export type ComputeSpec = { /** Whose dependency cache and environment snapshots the sandbox belongs to (a host that keeps snapshots), and the snapshot it starts from. */ environment?: { userId: string; repo: string; restoreFrom?: string }; image?: string; repo?: { url: string; ref: string; branch: string }; egressAllow?: string[]; limits?: { cpu: number; memMiB: number; diskMiB: number; pids: number; wallClockMin: number | null };
	/** How long the sandbox may run from its creation, in minutes, which the host enforces: the person's session limit, or the minutes the month has left. It replaces the limits' own. */
	wallClockMin?: number | null };
export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut?: boolean };
export type ExecOptions = { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string };

/** Thrown by a provider whose create call may or may not have taken effect (a timeout after the request left). */
export class AmbiguousCreateError extends Error {
	constructor(message = "The compute provider didn't answer; the sandbox may exist") {
		super(message);
		this.name = "AmbiguousCreateError";
	}
}

/** A prepared environment kept by key for a person and a repository. */
export type EnvironmentSnapshot = { key: string; repo: string; createdAt: number; size?: number };
/** What a host that keeps environment snapshots offers: the person's snapshots of a repository (newest first), keeping one of a sandbox, and deleting one. */
export interface Environments {
	/** How fast a snapshot restores, in MB a second; decides whether one is worth keeping. */
	readonly restoreMBps: number;
	list(owner: { userId: string; repo: string }): Promise<EnvironmentSnapshot[]>;
	snapshot(handle: ComputeHandle, o: { userId: string; repo: string; key: string }): Promise<EnvironmentSnapshot>;
	delete(userId: string, key: string): Promise<boolean>;
}

/** What Forge needs of a sandbox host (sandbox-manager, a runner fleet, a local process sandbox). `tag` is the idempotency key: `find` by it is how an ambiguous create is settled. */
export interface ComputeProvider {
	readonly id: string;
	find(tag: string): Promise<ComputeHandle | null>;
	create(tag: string, spec: ComputeSpec): Promise<ComputeHandle>;
	/** The sandbox as a `@pim/coding` Workspace (streaming exec, files), for the vendor CLI runner and the pi coding tools. */
	workspace?(handle: ComputeHandle): Promise<import("@pim/coding/workspace/types").Workspace>;
	exec(handle: ComputeHandle, command: readonly string[], options?: ExecOptions): Promise<ExecResult>;
	destroy(handle: ComputeHandle): Promise<void>;
	/** Present only on a host that keeps environment snapshots; a sandbox is then given `spec.environment`. Without it each thread builds its environment in place. */
	readonly environments?: Environments;
}

/** How long after an ambiguous create Forge waits before trusting that "not found" means "not created". */
export const SETTLE_MS = 30_000;

/** The sandbox's idempotency tag is the thread's id: the manager's session id (`[a-z0-9-]{1,63}`), as the legacy workspaces were named, so existing sandboxes are found by it. */
export const computeTag = (thread: { threadId: string }) => thread.threadId;

export class Provisioner {
	constructor(
		private readonly store: ForgeStore,
		private readonly provider: ComputeProvider,
		private readonly clock: () => number = Date.now,
		private readonly settleMs = SETTLE_MS,
		private readonly specFor: (thread: ThreadRow) => ComputeSpec = () => ({}),
	) {}

	/**
	 * Provisions the thread's sandbox. The intent (tag, provider) is committed before the provider is called; an ambiguous failure is recorded as uncertain, and the
	 * next attempt looks up the tag first and creates only when nothing exists and the settle window has passed.
	 */
	async provision(threadId: string, epoch: number): Promise<ComputeHandle> {
		const tag = await this.store.fenced(threadId, epoch, async (q, t) => {
			if (t.workspaceRef) return null;
			const tag = computeTag(t);
			if (!t.provisioning || t.provisioning.tag !== tag) await this.store.patch(q, threadId, { provisioning: { kind: "workspace", provider: this.provider.id, tag, phase: "intent", at: this.clock() } });
			return tag;
		});
		if (tag === null) return (await this.store.get(threadId))!.workspaceRef as ComputeHandle;
		const found = await this.provider.find(tag);
		if (found) return this.record(threadId, epoch, found);
		const prior = (await this.store.get(threadId))!.provisioning;
		if (prior?.phase === "uncertain" && this.clock() - prior.at < this.settleMs) throw new ForgeError("conflict", "A sandbox creation for this thread is still unsettled; not creating another");
		try {
			return await this.record(threadId, epoch, await this.provider.create(tag, this.specFor((await this.store.get(threadId))!)));
		} catch (error) {
			if (error instanceof AmbiguousCreateError) {
				await this.store.fenced(threadId, epoch, (q) => this.store.patch(q, threadId, { provisioning: { kind: "workspace", provider: this.provider.id, tag, phase: "uncertain", at: this.clock() } }));
			}
			throw error;
		}
	}

	private async record(threadId: string, epoch: number, handle: ComputeHandle): Promise<ComputeHandle> {
		await this.store.fenced(threadId, epoch, async (q, t) => {
			await this.store.patch(q, threadId, { workspace_ref: handle, provisioning: { ...(t.provisioning ?? {}), phase: "ready", at: this.clock() } });
		});
		return handle;
	}
}
