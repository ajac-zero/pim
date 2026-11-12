import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { type ContainerHost as ContainerHostApi, type ContainerCatalog, isNoInstanceError } from "./src/coding/workspace/cloudflare";
import { egressPolicy } from "./src/coding/workspace/egress";
import { WorkspaceLostError, WorkspaceNotFoundError, WorkspaceUnsupportedError, type WorkspaceSpec, type WorkspaceInfo, type EgressPolicy } from "./src/coding/workspace/types";
import { handleEgress } from "./cloudflare-egress";

// Cloudflare stops an inactive container without a snapshot. The thread gives an idle workspace's slot back after 10 minutes
// (src/coding/scheduler.ts), which suspends it with a snapshot (`park`); this is only the net under that, long enough that the
// thread always gets there first, so files outside git survive.
const IDLE_MS = 30 * 60_000;
type Saved = { spec: WorkspaceSpec; createdAt: number; state: "running" | "stopped" | "kept"; snapshot?: string; token: string };
type Snapshot = { id: string; sessionId: string };

/**
 * The instance a coding workspace runs on: the thread's limits, raised to
 * at least 4 vCPU, 12 GiB of memory (Cloudflare asks for 3 GiB per vCPU) and 16 GB of disk so builds have room,
 * and kept within Cloudflare's largest custom instance (4 vCPU, 12 GiB,
 * 20 GB). Memory and disk are billed for as long as the container is up, CPU
 * only while it is busy (docs/coding-cloudflare-sandbox.md).
 */
export function instanceFor(limits: WorkspaceSpec["limits"]): { vcpu: number; memoryMib: number; diskMb: number } {
	return {
		vcpu: Math.min(Math.max(limits.cpu, 4), 4),
		memoryMib: Math.min(Math.max(limits.memMiB, 12 * 1024), 12 * 1024),
		diskMb: Math.min(Math.max(Math.ceil(limits.diskMiB * 1.048576), 16_000), 20_000),
	};
}
type EgressProps = { sessionId: string; target: string };
type Bindings = { WorkspaceContainer: DurableObjectNamespace<WorkspaceContainer> };

/** Lifecycle operations are serialized; streaming agentd requests do not hold that lock. */
export class ContainerHost implements ContainerHostApi {
	private pending: Promise<void> = Promise.resolve();
	// Snapshots and cold starts can exceed blockConcurrencyWhile's 30-second limit.
	private exclusive<T>(work: () => Promise<T>): Promise<T> {
		const next = this.pending.then(work);
		this.pending = next.then(
			() => {},
			() => {},
		);
		return next;
	}
	constructor(private ctx: DurableObjectState) {
		if (ctx.container?.running) {
			this.pending = (async () => {
				const saved = await ctx.storage.get<Saved>("workspace");
				// Complete a stop interrupted after its checkpoint was persisted.
				if (!saved || saved.state !== "running") await ctx.container!.destroy();
				else {
					await ctx.container!.setInactivityTimeout(IDLE_MS);
					// The container outlived this isolate (a deploy, an eviction), carrying the egress intercepts the
					// code that ran then installed. Put the current handler in place, so requests are decided by the
					// policy as this deployment reads it, not by whichever handler the container was left with.
					await this.intercept(saved);
				}
			})().catch((error) => {
				console.warn(JSON.stringify({ event: "pim.coding.container_startup_cleanup_failed", error: String(error) }));
			});
		}
	}
	private get container() {
		if (!this.ctx.container) throw new Error("No Cloudflare container configured");
		return this.ctx.container;
	}
	private async saved() {
		const saved = await this.ctx.storage.get<Saved>("workspace");
		if (!saved || saved.state === "kept") throw new WorkspaceNotFoundError();
		return saved;
	}
	private save(saved: Saved) {
		return this.ctx.storage.put("workspace", saved);
	}
	private async intercept(saved: Saved) {
		const policy = egressPolicy(saved.spec.egress);
		if (policy.allow.length > 256) throw new Error("Cloudflare workspaces allow at most 256 egress hosts");
		for (const target of policy.allow) if (!/^(\*\.)?[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(target)) throw new Error("Invalid egress hostname");
		// A container may hold at most 128 intercept entries, and each host needs two. Two catch-alls cover every
		// host; the handler allows or denies each request against the current policy, by the URL it will fetch.
		const handler = this.ctx.exports.ContainerEgress({ props: { sessionId: saved.spec.sessionId, target: "*" } });
		await this.container.interceptAllOutboundHttp(handler);
		await this.container.interceptOutboundHttps("*", handler);
	}
	private async boot(saved: Saved) {
		await this.intercept(saved);
		const limits = saved.spec.limits;
		const common = { enableInternet: false, env: { AGENTD_TOKEN: saved.token }, instance: instanceFor(limits) };
		this.container.start(saved.snapshot ? { ...common, containerSnapshot: { id: saved.snapshot } } : { ...common, image: this.container.images.base! });
		await this.container.setInactivityTimeout(IDLE_MS);
		// Do not publish running until agentd accepts authenticated requests.
		try {
			for (let attempt = 0; ; attempt++) {
				try {
					const response = await this.agent(saved, new Request("http://agentd/health"));
					await response.body?.cancel();
					if (response.ok) break;
				} catch (error) {
					// Cloudflare has no instance to give it now: the thread makes its workspace elsewhere or waits, rather than this waiting out the loop.
					if (isNoInstanceError(error)) throw error;
				}
				if (attempt >= 100) throw new Error("Workspace agent did not become ready");
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			saved.state = "running";
			await this.save(saved);
		} catch (error) {
			await this.container.destroy();
			throw error;
		}
	}
	private agent(saved: Saved, request: Request) {
		const headers = new Headers(request.headers);
		headers.set("authorization", `Bearer ${saved.token}`);
		return this.container.getTcpPort(8787).fetch(new Request(request, { headers }));
	}
	create(spec: WorkspaceSpec) {
		return this.exclusive(async () => {
			if (spec.environment?.restoreFrom) throw new WorkspaceUnsupportedError();
			let saved = await this.ctx.storage.get<Saved>("workspace");
			if (!saved) {
				saved = { spec, createdAt: Date.now(), state: "stopped", token: crypto.randomUUID() };
				await this.save(saved);
			} else if (saved.spec.sessionId !== spec.sessionId) throw new WorkspaceNotFoundError();
			if (saved.state === "kept") {
				saved.state = "stopped";
				saved.spec = spec;
				await this.save(saved);
			}
			if (this.container.running) {
				// The container keeps its files and processes, but the spec it answers for is the thread's current one:
				// the egress handler reads the policy from storage, so an allowlist that changed since the workspace was
				// made (a harness host added, a deploy) takes effect here rather than being denied as not allowed.
				saved.spec = spec;
				await this.save(saved);
				await this.intercept(saved);
				return;
			}
			if (saved.state === "running") {
				// An unexpected stop lost its uncheckpointed files. Rebuild instead of claiming a stale restore.
				saved = { spec, createdAt: Date.now(), state: "stopped", token: crypto.randomUUID() };
				await this.save(saved);
			}
			await this.boot(saved);
		});
	}
	async info(): Promise<WorkspaceInfo | null> {
		await this.pending;
		const saved = await this.ctx.storage.get<Saved>("workspace");
		if (!saved || saved.state === "kept") return null;
		return {
			ref: { id: saved.spec.sessionId, sessionId: saved.spec.sessionId, providerId: "cloudflare" },
			createdAt: saved.createdAt,
			state: saved.state === "running" && !this.container.running ? "gone" : saved.state,
		};
	}
	async request(request: Request) {
		await this.pending;
		const saved = await this.saved();
		if (saved.state !== "running") throw new Error("The workspace is stopped");
		if (!this.container.running) throw new WorkspaceLostError();
		return this.agent(saved, request);
	}
	private async park(saved: Saved) {
		if (saved.state === "stopped") return;
		if (!this.container.running) throw new WorkspaceLostError();
		// Persist the checkpoint before stopping: failure leaves the live workspace intact.
		saved.snapshot = (await this.container.snapshotContainer({})).id;
		saved.state = "stopped";
		await this.save(saved);
		try {
			await this.container.destroy();
		} catch (error) {
			saved.state = "running";
			await this.save(saved);
			throw error;
		}
	}
	suspend() {
		return this.exclusive(async () => this.park(await this.saved()));
	}
	start() {
		return this.exclusive(async () => {
			const saved = await this.saved();
			if (saved.state === "running") {
				if (!this.container.running) throw new WorkspaceLostError();
				return;
			}
			await this.boot(saved);
		});
	}
	destroy(keepVolume: boolean) {
		return this.exclusive(async () => {
			if (keepVolume) {
				const saved = await this.ctx.storage.get<Saved>("workspace");
				if (!saved || saved.state === "kept") return;
				// A lost container has no current disk to save. Let the thread close its ledger stretch.
				if (saved.state === "running" && !this.container.running) saved.snapshot = undefined;
				else await this.park(saved);
				saved.state = "kept";
				await this.save(saved);
			} else {
				await this.container.destroy();
				await this.ctx.storage.deleteAll();
			}
		});
	}
	async keepAlive() {
		await this.pending;
		await this.saved();
		if (!this.container.running) throw new WorkspaceNotFoundError();
		await this.container.setInactivityTimeout(IDLE_MS);
	}
	setEgress(policy: EgressPolicy) {
		return this.exclusive(async () => {
			const saved = await this.saved();
			// Handlers read the current policy on each request. Removed intercepts deny access.
			saved.spec.egress = egressPolicy(policy);
			await this.save(saved);
			if (this.container.running) await this.intercept(saved);
		});
	}
	async egressPolicy(): Promise<EgressPolicy> {
		return (await this.saved()).spec.egress;
	}
	snapshot() {
		return this.exclusive(async () => {
			const saved = await this.saved();
			if (!this.container.running) throw new WorkspaceLostError();
			const id = crypto.randomUUID();
			await this.ctx.storage.put(`snapshot:${id}`, { id: (await this.container.snapshotContainer({})).id, sessionId: saved.spec.sessionId } satisfies Snapshot);
			return id;
		});
	}
	restore(id: string) {
		return this.exclusive(async () => {
			const saved = await this.saved();
			const snapshot = await this.ctx.storage.get<Snapshot>(`snapshot:${id}`);
			if (!snapshot || snapshot.sessionId !== saved.spec.sessionId) throw new WorkspaceNotFoundError();
			await this.container.destroy();
			saved.state = "stopped";
			saved.snapshot = snapshot.id;
			await this.save(saved);
			await this.boot(saved);
		});
	}
}

/** The binding exposes only trusted Worker RPC, never an HTTP management endpoint. */
export class WorkspaceContainer extends DurableObject<Bindings> implements ContainerHostApi {
	private host: ContainerHost;
	constructor(ctx: DurableObjectState, env: Bindings) {
		super(ctx, env);
		this.host = new ContainerHost(ctx);
	}
	create(spec: WorkspaceSpec) {
		return this.host.create(spec);
	}
	info() {
		return this.host.info();
	}
	request(request: Request) {
		return this.host.request(request);
	}
	suspend() {
		return this.host.suspend();
	}
	start() {
		return this.host.start();
	}
	destroy(keepVolume: boolean) {
		return this.host.destroy(keepVolume);
	}
	keepAlive() {
		return this.host.keepAlive();
	}
	setEgress(policy: EgressPolicy) {
		return this.host.setEgress(policy);
	}
	egressPolicy() {
		return this.host.egressPolicy();
	}
	snapshot() {
		return this.host.snapshot();
	}
	restore(id: string) {
		return this.host.restore(id);
	}
}

/** A durable index, not an isolate-local map. Never contains egress credentials. */
export class WorkspaceCatalog extends DurableObject implements ContainerCatalog {
	async add(id: string) {
		await this.ctx.storage.put(`session:${id}`, true);
	}
	async remove(id: string) {
		await this.ctx.storage.delete(`session:${id}`);
	}
	async list() {
		return [...(await this.ctx.storage.list({ prefix: "session:" })).keys()].map((key) => key.slice(8));
	}
}
export class ContainerEgress extends WorkerEntrypoint<Bindings, EgressProps> {
	async fetch(request: Request) {
		const { sessionId, target } = this.ctx.props;
		const policy = await this.env.WorkspaceContainer.getByName(sessionId).egressPolicy();
		return handleEgress(request, policy, target);
	}
}
