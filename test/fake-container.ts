import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { egressPolicy } from "../src/coding/workspace/egress";
import type { ContainerHost, ContainerCatalog } from "../src/coding/workspace/cloudflare";
import { WorkspaceNotFoundError, type WorkspaceSpec, type WorkspaceRef, type EgressPolicy, type WorkspaceInfo } from "../src/coding/workspace/types";

/** A shared remote service for testing clients reconstructed after isolate eviction. */
export function fakeContainers() {
	const backend = new FakeWorkspaceProvider();
	const hosts = new Map<string, ContainerHost>();
	const ids = new Set<string>();
	const policies = new Map<string, EgressPolicy>();
	const catalog: ContainerCatalog = {
		add: async (id) => {
			ids.add(id);
		},
		remove: async (id) => {
			ids.delete(id);
		},
		list: async () => [...ids],
	};
	const containerFor = (id: string): ContainerHost => {
		let host = hosts.get(id);
		if (host) return host;
		let ref: WorkspaceRef = { id, sessionId: id, providerId: "fake" };
		host = {
			create: async (spec: WorkspaceSpec) => {
				ref = await backend.create(spec);
				policies.set(id, spec.egress);
			},
			info: async () => {
				const info = (await backend.list({ sessionId: id }))[0];
				return info ? ({ ...info, ref: { id, sessionId: id, providerId: "cloudflare" } } satisfies WorkspaceInfo) : null;
			},
			request: async (request) => {
				const ws = await backend.get(ref);
				if (!ws) return Response.json({ error: "not_found" }, { status: 404 });
				const url = new URL(request.url);
				const p = url.searchParams.get("path") ?? "/workspace";
				try {
					switch (`${request.method} ${url.pathname}`) {
						case "POST /exec": {
							const body = (await request.json()) as { cmd: string[]; timeoutMs: number; cwd?: string; env?: Record<string, string>; stdin?: string };
							const events = [];
							for await (const event of ws.exec(body.cmd, { ...body, signal: request.signal })) events.push(JSON.stringify(event));
							return new Response(`${events.join("\n")}\n`);
						}
						case "GET /file":
							return new Response(await ws.readFile(p));
						case "PUT /file":
							await ws.writeFile(p, new Uint8Array(await request.arrayBuffer()), Number.parseInt(url.searchParams.get("mode") ?? "644", 8));
							break;
						case "DELETE /file":
							await ws.remove(p);
							break;
						case "GET /stat":
							return Response.json(await ws.stat(p));
						case "GET /list":
							return Response.json(await ws.list(p));
						default:
							return new Response(null, { status: 404 });
					}
					return Response.json({ ok: true });
				} catch (error) {
					const name = (error as Error).name;
					return Response.json(
						{ error: name === "WorkspacePathError" ? "path_escape" : name === "WorkspaceLimitError" ? "disk_full" : "not_found" },
						{ status: name === "WorkspacePathError" ? 403 : name === "WorkspaceLimitError" ? 507 : 404 },
					);
				}
			},
			suspend: () => backend.suspend(ref),
			start: async () => {
				await (await backend.get(ref))!.start();
			},
			destroy: (keepVolume) => backend.destroy(ref, { keepVolume }),
			keepAlive: async () => {
				if (!(await backend.get(ref))) throw new WorkspaceNotFoundError();
				await backend.keepAlive(ref);
			},
			setEgress: async (policy) => {
				const ws = await backend.get(ref);
				if (!ws) throw new WorkspaceNotFoundError();
				// As the Containers provider's proxy would: the policy the thread set is the one its requests are made under.
				ws.egress = egressPolicy(policy);
				policies.set(id, policy);
			},
			snapshot: async () => (await (await backend.get(ref))!.snapshot()).id,
			restore: async (snapshotId) => {
				await (await backend.get(ref))!.restore({ id: snapshotId, providerId: "fake" });
			},
		};
		hosts.set(id, host);
		return host;
	};
	return { containerFor, catalog, policies, backend };
}
