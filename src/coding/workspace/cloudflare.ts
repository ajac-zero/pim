// Cloudflare Containers use the same agentd protocol as the sandbox manager.
// The Durable Objects own all lifecycle state; this client survives isolate eviction.
import { ComposeWorkspace, ComposeWorkspaceProvider } from "./compose";
import { resumeOrCreate } from "./egress";
import {
	WorkspaceNotFoundError,
	WorkspaceUnsupportedError,
	type EgressPolicy,
	type WorkspaceProvider,
	type WorkspaceRef,
	type WorkspaceSpec,
	type WorkspaceInfo,
	type WorkspaceFilter,
	type SnapshotRef,
	type ExecOptions,
	type ExecEvent,
} from "./types";

// Kept for callers of the earlier, unwired Sandbox SDK adapter.
export { CloudflareSandboxProvider, type SandboxLike } from "./cloudflare-sandbox";

export interface ContainerHost {
	create(spec: WorkspaceSpec): Promise<void>;
	info(): Promise<WorkspaceInfo | null>;
	request(request: Request): Promise<Response>;
	suspend(): Promise<void>;
	start(): Promise<void>;
	destroy(keepVolume: boolean): Promise<void>;
	keepAlive(): Promise<void>;
	setEgress(policy: EgressPolicy): Promise<void>;
	snapshot(): Promise<string>;
	restore(id: string): Promise<void>;
}
export interface ContainerCatalog {
	add(sessionId: string): Promise<void>;
	remove(sessionId: string): Promise<void>;
	list(): Promise<string[]>;
}
export type CloudflareContainerOptions = { containerFor: (id: string) => ContainerHost; catalog: ContainerCatalog };

export class CloudflareContainerProvider implements WorkspaceProvider {
	readonly id = "cloudflare";
	readonly capabilities = { snapshot: true, environmentSnapshots: false, egressAllowlist: true, sessionMaxMin: null, keepAlive: true, suspendResume: true, egressInjection: true };
	constructor(private options: CloudflareContainerOptions) {}
	private host(ref: WorkspaceRef) {
		if (ref.providerId !== this.id || ref.id !== ref.sessionId) throw new WorkspaceNotFoundError();
		return this.options.containerFor(ref.id);
	}
	async create(spec: WorkspaceSpec): Promise<WorkspaceRef> {
		// Register first so a lost response cannot leave an unlisted container.
		await this.options.catalog.add(spec.sessionId);
		await this.options.containerFor(spec.sessionId).create(spec);
		return { id: spec.sessionId, sessionId: spec.sessionId, providerId: this.id };
	}
	async get(ref: WorkspaceRef) {
		const host = this.host(ref);
		const info = await host.info();
		if (!info || info.state === "gone") return null;
		const errors = new ComposeWorkspaceProvider({ managerUrl: "https://agentd.example", token: "" });
		const bridge = {
			check: errors.check.bind(errors),
			call: async (method: string, path: string, init: Parameters<ComposeWorkspaceProvider["call"]>[2] = {}) => {
				const url = new URL(path, "http://agentd");
				let route = url.pathname.slice(`/sessions/${encodeURIComponent(ref.id)}`.length);
				if (!route) return Response.json({ state: (await host.info())?.state ?? "gone" });
				if (route === "/stop") {
					await host.suspend();
					return Response.json({ ok: true });
				}
				if (route === "/start") {
					await host.start();
					return Response.json({ ok: true });
				}
				if (route === "/exec/stream") {
					route = "/exec";
					init = { ...init, json: { ...(init.json as object), id: init.headers?.["x-exec-id"] } };
				} else route = route.replace(/(\/exec\/[^/]+)\/stream$/, "$1");
				const headers = new Headers(init.headers);
				if (init.json !== undefined) headers.set("content-type", "application/json");
				// agentd detaches on disconnect; an explicit cancellation must kill the process.
				if (route === "/exec" && init.signal) {
					const id = init.headers?.["x-exec-id"];
					const cancel = () => {
						void host
							.request(new Request(`http://agentd/exec/${id}`, { method: "DELETE" }))
							.then((res) => res.body?.cancel())
							.catch(() => {});
					};
					if (init.signal.aborted) cancel();
					else init.signal.addEventListener("abort", cancel, { once: true });
				}
				const response = await host.request(
					new Request(`http://agentd${route}${url.search}`, { method, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }),
				);
				if (init.signal?.aborted && route === "/exec") {
					void host
						.request(new Request(`http://agentd/exec/${init.headers?.["x-exec-id"]}`, { method: "DELETE" }))
						.then((res) => res.body?.cancel())
						.catch(() => {});
				}
				// agentd uses `error` for its code; the manager uses `code`.
				if (!response.ok) {
					const body = (await response.json()) as { error?: string; message?: string };
					return Response.json({ code: body.error, error: body.message }, { status: response.status });
				}
				return response;
			},
		};
		return new ContainerWorkspace(bridge, ref.id, host, this.id);
	}
	async destroy(ref: WorkspaceRef, o: { keepVolume?: boolean } = {}) {
		await this.host(ref).destroy(o.keepVolume ?? false);
		if (!o.keepVolume) await this.options.catalog.remove(ref.id);
	}
	async list(filter: WorkspaceFilter = {}): Promise<WorkspaceInfo[]> {
		const ids = filter.sessionId ? [filter.sessionId] : await this.options.catalog.list();
		const found: WorkspaceInfo[] = [];
		for (const id of ids) {
			const info = await this.options.containerFor(id).info();
			if (info && info.state !== "gone" && (!filter.state || filter.state === info.state)) found.push(info);
		}
		return found;
	}
	suspend(ref: WorkspaceRef) {
		return this.host(ref).suspend();
	}
	resumeOrCreate(ref: WorkspaceRef, spec: WorkspaceSpec) {
		return resumeOrCreate(this, ref, spec);
	}
	keepAlive(ref: WorkspaceRef) {
		return this.host(ref).keepAlive();
	}
	setEgress(ref: WorkspaceRef, policy: EgressPolicy) {
		return this.host(ref).setEgress(policy);
	}
	async snapshotEnvironment(): Promise<never> {
		throw new WorkspaceUnsupportedError();
	}
	async listEnvironments(): Promise<never> {
		throw new WorkspaceUnsupportedError();
	}
	async deleteEnvironment(): Promise<never> {
		throw new WorkspaceUnsupportedError();
	}
}

class ContainerWorkspace extends ComposeWorkspace {
	constructor(
		bridge: ConstructorParameters<typeof ComposeWorkspace>[0],
		id: string,
		private host: ContainerHost,
		private providerId: string,
	) {
		super(bridge, id);
	}
	override async *exec(cmd: string[], options: ExecOptions): AsyncGenerator<ExecEvent> {
		const controller = new AbortController();
		const abort = () => controller.abort();
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		try {
			yield* super.exec(cmd, { ...options, signal: controller.signal });
		} finally {
			options.signal?.removeEventListener("abort", abort);
			// Also release the daemon process when a caller stops iterating early.
			controller.abort();
		}
	}
	override async snapshot(): Promise<SnapshotRef> {
		return { id: await this.host.snapshot(), providerId: this.providerId };
	}
	override async restore(ref: SnapshotRef) {
		if (ref.providerId !== this.providerId) throw new WorkspaceNotFoundError();
		await this.host.restore(ref.id);
	}
}

/** Both bindings are needed; a legacy Sandbox binding must never advertise Containers as usable. */
export function containerProvider(env: object): CloudflareContainerProvider | null {
	const bindings = env as { WorkspaceContainer?: DurableObjectNamespace; WorkspaceCatalog?: DurableObjectNamespace };
	if (!bindings.WorkspaceContainer || !bindings.WorkspaceCatalog) return null;
	return new CloudflareContainerProvider({
		containerFor: (id) => bindings.WorkspaceContainer!.getByName(id) as unknown as ContainerHost,
		catalog: bindings.WorkspaceCatalog.getByName("workspaces") as unknown as ContainerCatalog,
	});
}
