// Compute isolation: a provider of per-thread sandboxes, and the reconciliation that keeps an ambiguous creation from ever launching a second paid sandbox.
import { type ForgeStore } from "./store";
import { ForgeError } from "./errors";

export type ComputeHandle = { readonly id: string; readonly provider: string; readonly tag: string };
export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut?: boolean };
export type ExecOptions = { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string };

/** Thrown by a provider whose create call may or may not have taken effect (a timeout after the request left). */
export class AmbiguousCreateError extends Error {
	constructor(message = "The compute provider didn't answer; the sandbox may exist") {
		super(message);
		this.name = "AmbiguousCreateError";
	}
}

/** What Forge needs of a sandbox host (sandbox-manager, a runner fleet, a local process sandbox). `tag` is the idempotency key: `find` by it is how an ambiguous create is settled. */
export interface ComputeProvider {
	readonly id: string;
	find(tag: string): Promise<ComputeHandle | null>;
	create(tag: string, spec: { image?: string }): Promise<ComputeHandle>;
	exec(handle: ComputeHandle, command: readonly string[], options?: ExecOptions): Promise<ExecResult>;
	destroy(handle: ComputeHandle): Promise<void>;
}

/** How long after an ambiguous create Forge waits before trusting that "not found" means "not created". */
export const SETTLE_MS = 30_000;

export const computeTag = (thread: { threadId: string; startOperation: string }) => `forge:${thread.threadId}:${thread.startOperation}`;

export class Provisioner {
	constructor(
		private readonly store: ForgeStore,
		private readonly provider: ComputeProvider,
		private readonly clock: () => number = Date.now,
		private readonly settleMs = SETTLE_MS,
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
			return await this.record(threadId, epoch, await this.provider.create(tag, {}));
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
