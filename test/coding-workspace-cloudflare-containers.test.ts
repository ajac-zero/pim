import { describe, expect, it, vi } from "vitest";
import { CloudflareContainerProvider, containerProvider } from "../src/coding/workspace/cloudflare";
import { runConformanceSuite } from "../src/coding/workspace/conformance";
import { fakeContainers } from "./fake-container";
import { computeSummary, prepareComputeProvider, workspaceProviderOf } from "../src/compute";
import { workspaceBackends } from "../src/coding/workspace/registry";
import type { WorkspaceSpec } from "../src/coding/workspace/types";
import { ContainerHost } from "../cloudflare-container";
import { handleEgress } from "../cloudflare-egress";

const spec: WorkspaceSpec = {
	sessionId: "session",
	image: "x",
	repo: { url: "", ref: "", branch: "" },
	limits: { cpu: 1, memMiB: 1024, diskMiB: 2048, pids: 256, wallClockMin: null },
	egress: { allow: ["example.com"] },
	gitAuth: { mode: "none" },
};
runConformanceSuite("Cloudflare Containers agentd client", () => new CloudflareContainerProvider(fakeContainers()));

describe("Cloudflare Containers integration", () => {
	it("keeps references, files and listing across client reconstruction and suspend", async () => {
		const service = fakeContainers();
		const first = new CloudflareContainerProvider(service);
		const ref = await first.create(spec);
		await (await first.get(ref))!.writeFile("kept", new TextEncoder().encode("saved"));
		await first.suspend(ref);
		const next = new CloudflareContainerProvider(service);
		expect(await next.list()).toMatchObject([{ state: "stopped", ref }]);
		expect(await next.resumeOrCreate(ref, spec)).toEqual({ ref, resumed: true });
		expect(new TextDecoder().decode(await (await next.get(ref))!.readFile("kept"))).toBe("saved");
		await next.setEgress(ref, { allow: ["api.example.com"], inject: [{ host: "api.example.com", headers: { authorization: "test-only" } }] });
		expect(service.policies.get(ref.id)?.inject?.[0]?.headers.authorization).toBe("test-only");
	});
	it("sends an explicit daemon cancellation after streaming headers arrive", async () => {
		const service = fakeContainers();
		const host = service.containerFor(spec.sessionId);
		const original = host.request;
		const requests: string[] = [];
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let stream!: ReadableStreamDefaultController<Uint8Array>;
		host.request = async (request) => {
			const path = new URL(request.url).pathname;
			requests.push(request.method + " " + path);
			if (path === "/exec") {
				const body = (await request.json()) as { id: string };
				expect(body.id).toMatch(/^[a-z0-9-]+$/);
				const response = new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							stream = controller;
						},
					}),
				);
				started();
				return response;
			}
			if (request.method === "DELETE" && path.startsWith("/exec/")) {
				stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: "exit", code: null, signal: "SIGTERM" }) + "\n"));
				stream.close();
				return Response.json({ ok: true });
			}
			return original(request);
		};
		const provider = new CloudflareContainerProvider(service);
		const workspace = (await provider.get(await provider.create(spec)))!;
		const abort = new AbortController();
		const events: unknown[] = [];
		const run = (async () => {
			for await (const event of workspace.exec(["sleep", "10"], { timeoutMs: 10_000, signal: abort.signal })) events.push(event);
		})();
		await ready;
		abort.abort();
		await run;
		expect(requests.some((path) => path.startsWith("DELETE /exec/"))).toBe(true);
		expect(events).toEqual([{ type: "exit", code: null, signal: "SIGTERM" }]);
	});
	it("requires both bindings for A0 usable and respects the admin switch", () => {
		const service = fakeContainers();
		const env = { WorkspaceContainer: { getByName: service.containerFor }, WorkspaceCatalog: { getByName: () => service.catalog } };
		const provider = prepareComputeProvider({ kind: "cloudflare-sandbox" }, null);
		expect(computeSummary(provider, {})).toMatchObject({ usable: false });
		expect(containerProvider({ Sandbox: {} })).toBeNull();
		expect(containerProvider({ WorkspaceContainer: env.WorkspaceContainer })).toBeNull();
		expect(computeSummary(provider, env)).toMatchObject({ usable: true });
		expect(workspaceProviderOf(provider, env)?.capabilities.suspendResume).toBe(true);
		expect(workspaceBackends(env, [provider]).ids()).toEqual(["cloudflare"]);
		expect(workspaceBackends(env, [{ ...provider, codingSandbox: false }]).ids()).toEqual([]);
	});
});

/** A native API stand-in: snapshot failure and unexpected stops must not claim a successful suspension. */
function hostFixture() {
	const data = new Map<string, unknown>();
	const calls: string[] = [];
	let running = false;
	let failSnapshot = false;
	let failDestroy = false;
	const container = {
		get running() {
			return running;
		},
		images: { base: "test-image" },
		start: (options: ContainerStartupOptions) => {
			calls.push(options.containerSnapshot ? "restore" : "start");
			expect(options.enableInternet).toBe(false);
			running = true;
		},
		destroy: async () => {
			calls.push("destroy");
			if (failDestroy) {
				failDestroy = false;
				throw new Error("startup destroy failed");
			}
			running = false;
		},
		setInactivityTimeout: async () => {},
		interceptOutboundHttp: async () => {},
		interceptAllOutboundHttp: async () => {},
		interceptOutboundHttps: async () => {},
		snapshotContainer: async () => {
			calls.push("snapshot");
			if (failSnapshot) throw new Error("snapshot failed");
			return { id: "checkpoint", size: 1 };
		},
		getTcpPort: () => ({ fetch: async () => Response.json({ ok: true }) }),
	};
	const ctx = {
		container,
		storage: {
			get: async (key: string) => structuredClone(data.get(key)),
			put: async (key: string, value: unknown) => {
				data.set(key, structuredClone(value));
			},
			deleteAll: async () => {
				data.clear();
			},
		},
		blockConcurrencyWhile: (work: () => Promise<unknown>) => work(),
		exports: { ContainerEgress: () => ({}) },
	};
	return {
		host: new ContainerHost(ctx as unknown as DurableObjectState),
		calls,
		restartWithFailedCleanup: () => {
			running = true;
			failDestroy = true;
			return new ContainerHost(ctx as unknown as DurableObjectState);
		},
		restart: () => new ContainerHost(ctx as unknown as DurableObjectState),
		lose: () => {
			running = false;
		},
		fail: () => {
			failSnapshot = true;
		},
	};
}
describe("WorkspaceContainer lifecycle", () => {
	it("recovers from a rejected startup cleanup and continues serving the workspace", async () => {
		const fixture = hostFixture();
		await fixture.host.create(spec);
		await fixture.host.suspend();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const host = fixture.restartWithFailedCleanup();
			expect((await host.info())?.state).toBe("stopped");
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("container_startup_cleanup_failed"));
			// A later lifecycle operation must run even though the constructor's cleanup failed.
			await host.destroy(false);
			await host.create(spec);
			await host.keepAlive();
			expect((await host.request(new Request("http://agentd/health"))).status).toBe(200);
			expect((await host.info())?.state).toBe("running");
		} finally {
			warn.mockRestore();
		}
	});
	it("injects the fresh token after suspend, resume and policy replacement, including after eviction", async () => {
		const fixture = hostFixture();
		const policy = (token: string) => ({ allow: ["api.example.com"], inject: [{ host: "api.example.com", headers: { authorization: token } }] });
		await fixture.host.create({ ...spec, egress: policy("stale-token") });
		await fixture.host.suspend();
		await fixture.host.start();
		await fixture.host.setEgress(policy("fresh-token"));
		const host = fixture.restart();
		await host.info();
		await handleEgress(new Request("https://api.example.com/request"), await host.egressPolicy(), "api.example.com", async (request) => {
			expect((request as Request).headers.get("authorization")).toBe("fresh-token");
			expect((request as Request).headers.get("authorization")).not.toBe("stale-token");
			return new Response("ok");
		});
	});
	it("saves before destroy and restores once, with durable state", async () => {
		const { host, calls } = hostFixture();
		await host.create(spec);
		await host.create(spec);
		await host.suspend();
		await host.suspend();
		expect((await host.info())?.state).toBe("stopped");
		await host.start();
		expect(calls).toEqual(["start", "snapshot", "destroy", "restore"]);
		expect((await host.info())?.state).toBe("running");
	});
	it("keeps a deleted workspace's checkpoint for create, and forgets it on full deletion", async () => {
		const { host, calls } = hostFixture();
		await host.create(spec);
		await host.destroy(true);
		await host.destroy(true);
		expect(await host.info()).toBeNull();
		await host.create(spec);
		expect(calls.at(-1)).toBe("restore");
		await host.destroy(false);
		await host.create(spec);
		expect(calls.at(-1)).toBe("start");
	});
	it("leaves a live container running when snapshotting fails", async () => {
		const { host, calls, fail } = hostFixture();
		await host.create(spec);
		fail();
		await expect(host.suspend()).rejects.toThrow("snapshot failed");
		expect(calls).toEqual(["start", "snapshot"]);
		expect((await host.info())?.state).toBe("running");
	});
	it("lets a lost workspace go so the thread can release its compute ledger stretch", async () => {
		const { host, calls, lose } = hostFixture();
		await host.create(spec);
		await host.suspend();
		await host.start();
		lose();
		await host.destroy(true);
		expect(await host.info()).toBeNull();
		await host.create(spec);
		expect(calls.at(-1)).toBe("start");
	});
	it("reports unexpected loss and rebuilds rather than restoring an old checkpoint", async () => {
		const { host, calls, lose } = hostFixture();
		await host.create(spec);
		await host.suspend();
		await host.start();
		lose();
		expect((await host.info())?.state).toBe("gone");
		await expect(host.request(new Request("http://agentd/file"))).rejects.toThrow(/lost|went down/);
		await host.create(spec);
		expect(calls.at(-1)).toBe("start");
	});
});
