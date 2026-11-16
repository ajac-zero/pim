// The real ComputeProvider: a `@pim/coding` WorkspaceProvider (the sandbox-manager client, `ComposeWorkspaceProvider`, whose sandboxes run workspace-agentd) behind Forge's tag-based contract.
// The tag is the workspace's session id, and the manager creates idempotently per session, so `find` by tag is how an ambiguous create is settled.
import { WorkspaceCapacityError, type Workspace, type WorkspaceProvider, type WorkspaceRef, type WorkspaceSpec } from "@pim/coding/workspace/types";
import { AmbiguousCreateError, type ComputeHandle, type ComputeProvider, type ComputeSpec, type ExecOptions, type ExecResult } from "./compute";
import { ForgeError } from "./errors";

const DEFAULT_LIMITS = { cpu: 2, memMiB: 4096, diskMiB: 10_240, pids: 1024, wallClockMin: null };

export type WorkspaceAgentOptions = {
	/** The image sandboxes start from, as the manager names images. */
	image?: string;
	/** Hosts every sandbox may reach besides the git broker (the vendor CLIs' own, package registries). */
	egressAllow?: string[];
};

export class WorkspaceAgentComputeProvider implements ComputeProvider {
	readonly id: string;

	constructor(
		private readonly provider: WorkspaceProvider,
		private readonly options: WorkspaceAgentOptions = {},
	) {
		this.id = provider.id;
	}

	private ref = (h: ComputeHandle): WorkspaceRef => ({ id: h.id, providerId: h.provider, sessionId: h.tag });

	async find(tag: string): Promise<ComputeHandle | null> {
		const found = (await this.provider.list({ sessionId: tag })).find((w) => w.state !== "gone");
		return found ? { id: found.ref.id, provider: this.id, tag } : null;
	}

	async create(tag: string, spec: ComputeSpec): Promise<ComputeHandle> {
		const ws: WorkspaceSpec = {
			sessionId: tag,
			image: spec.image ?? this.options.image ?? "pim-workspace:local",
			repo: spec.repo ?? { url: "", ref: "HEAD", branch: "" },
			limits: spec.limits ?? DEFAULT_LIMITS,
			egress: { allow: [...(this.options.egressAllow ?? []), ...(spec.egressAllow ?? [])] },
			gitAuth: { mode: spec.repo ? "broker" : "none" },
		};
		try {
			const ref = await this.provider.create(ws);
			return { id: ref.id, provider: this.id, tag };
		} catch (error) {
			if (error instanceof WorkspaceCapacityError) throw new ForgeError("conflict", "The sandbox host is at capacity");
			// A manager that went quiet after receiving the request may have made the sandbox: the caller reconciles by tag.
			if (error instanceof Error && /fetch failed|timed out|timeout|ETIMEDOUT|ECONNRESET|socket hang up|502|503|504/i.test(error.message)) throw new AmbiguousCreateError(error.message);
			throw error;
		}
	}

	async workspace(handle: ComputeHandle): Promise<Workspace> {
		const ws = await this.provider.get(this.ref(handle));
		if (!ws) throw new ForgeError("workspace_not_running", `Sandbox ${handle.id} no longer exists`);
		return ws;
	}

	async exec(handle: ComputeHandle, command: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
		const ws = await this.workspace(handle);
		let stdout = "";
		let stderr = "";
		for await (const e of ws.exec([...command], { cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs ?? 120_000, stdin: options.stdin })) {
			if (e.type === "stdout") stdout += e.data;
			else if (e.type === "stderr") stderr += e.data;
			else if (e.type === "exit") return { code: e.code, stdout, stderr, ...(e.timedOut ? { timedOut: true } : {}) };
		}
		return { code: null, stdout, stderr };
	}

	async destroy(handle: ComputeHandle): Promise<void> {
		await this.provider.destroy(this.ref(handle));
	}
}
