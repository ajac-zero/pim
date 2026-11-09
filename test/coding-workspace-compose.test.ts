import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { ComposeManagerError, ComposeWorkspaceProvider } from "../src/coding/workspace/compose";
import { runConformanceSuite } from "../src/coding/workspace/conformance";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { ProviderCapacity } from "../src/coding/provider-capacity";
import {
	type ExecEvent,
	WorkspaceCapacityError,
	WorkspaceFileError,
	WorkspaceLimitError,
	WorkspaceNotFoundError,
	WorkspacePathError,
	type WorkspaceRef,
	type WorkspaceSpec,
} from "../src/coding/workspace/types";

const TOKEN = "s3cret-manager-token";
const URL_BASE = "http://127.0.0.1:8080";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (error: unknown): Response | null => {
	if (error instanceof WorkspacePathError) return json(403, { error: "path escapes /workspace", code: "path_escape" });
	if (error instanceof WorkspaceLimitError) return json(507, { error: "the write would take the workspace over its disk quota", code: "disk_full" });
	if (error instanceof WorkspaceFileError) return json(/Not a|Is a/.test(error.message) ? 409 : 404, { error: `no such file or directory: ${error.message}`, code: /Not a|Is a/.test(error.message) ? "conflict" : "not_found" });
	return null;
};

type FakeNodes = Map<string, { type: string; target?: string }>;

/** A fetch stub that speaks the sandbox-manager's route contract (sandbox-manager/README.md), backed by a FakeWorkspaceProvider. Where the real manager differs from the fake's workspace it follows the manager: `stat` describes a symlink itself, a deleted-with-keepVolume session is listed as gone, exec and files on a stopped session are 409, and `/exec/stream` answers NDJSON as the command prints. `readlink -f` is a command of the fake's shell. */
function fakeManager(max = 3) {
	const backing = new FakeWorkspaceProvider({ maxConcurrent: max });
	const requests: { method: string; path: string; auth: string | null; body?: unknown }[] = [];
	const refs = new Map<string, WorkspaceRef>();
	const kept = new Map<string, number>();
	backing.register("readlink", async ({ argv, workspace }) => {
		const nodes = (workspace as unknown as { nodes: FakeNodes }).nodes;
		let path = posix.normalize(argv.at(-1) ?? "");
		for (let hops = 0; hops < 32; hops++) {
			const parts = path.split("/").filter(Boolean);
			const at = parts.findIndex((_, i) => nodes.get(`/${parts.slice(0, i + 1).join("/")}`)?.type === "symlink");
			if (at < 0) break;
			const link = `/${parts.slice(0, at + 1).join("/")}`;
			path = posix.normalize(posix.join(posix.dirname(link), nodes.get(link)?.target ?? "", ...parts.slice(at + 1)));
			if (nodes.get(link)?.target?.startsWith("/")) path = posix.normalize(posix.join(nodes.get(link)?.target ?? "", ...parts.slice(at + 1)));
		}
		return { stdout: `${path}\n` };
	});

	// Like a real fetch, a request whose signal aborts rejects, whatever the manager was doing.
	const handler = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> =>
		new Promise((resolve, reject) => {
			const abort = () => reject(new DOMException("aborted", "AbortError"));
			if (init.signal?.aborted) return abort();
			init.signal?.addEventListener("abort", abort);
			route(input, init).then(resolve, reject);
		});

	const route = async (input: RequestInfo | URL, init: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const method = init.method ?? "GET";
		const auth = new Headers(init.headers).get("authorization");
		const raw = typeof init.body === "string" ? init.body : undefined;
		const body = raw ? JSON.parse(raw) : undefined;
		requests.push({ method, path: url.pathname + url.search, auth, body });
		if (url.pathname === "/health") return json(200, { runsc: true, freeDiskPct: 42.5, maxConcurrent: max, running: refs.size, free: max - refs.size, sessions: refs.size });
		if (auth !== `Bearer ${TOKEN}`) return json(401, { error: "unauthorized" });
		if (url.pathname === "/sessions" && method === "GET") {
			const live = (await backing.list()).map((i) => ({ sessionId: i.ref.sessionId, state: i.state, createdAt: i.createdAt }));
			const gone = [...kept].map(([sessionId, createdAt]) => ({ sessionId, state: "gone", reason: "kept_volume", createdAt }));
			return json(200, [...live, ...gone].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1)));
		}
		if (url.pathname === "/sessions" && method === "POST") {
			const spec = {
				sessionId: body.sessionId,
				image: body.image,
				repo: { url: "", ref: "", branch: "" },
				limits: { ...body.limits, wallClockMin: 1 },
				egress: { allow: body.egressAllow },
				gitAuth: { mode: "none" },
			} as WorkspaceSpec;
			const existed = refs.has(spec.sessionId);
			try {
				const ref = await backing.create(spec);
				refs.set(spec.sessionId, ref);
				kept.delete(spec.sessionId);
				return json(existed ? 200 : 201, { sessionId: spec.sessionId, state: "running", createdAt: 1 });
			} catch (error) {
				if (error instanceof WorkspaceCapacityError) return json(429, { error: "at capacity", code: "capacity", limit: max, running: refs.size });
				throw error;
			}
		}
		const m = /^\/sessions\/([a-z0-9-]+)(?:\/(exec\/stream|exec|file|list|stat|stop|start))?$/.exec(url.pathname);
		if (!m) return json(404, { error: "not found" });
		const [, id = "", sub] = m;
		const ref = refs.get(id);
		const ws = ref ? await backing.get(ref) : null;
		if (!ref || !ws) return json(404, { error: "no such session" });
		if (!sub && method === "GET") return json(200, { sessionId: id, ...(await ws.status()) });
		if (!sub && method === "DELETE") {
			const keep = url.searchParams.get("keepVolume") === "1";
			await backing.destroy(ref, { keepVolume: keep });
			refs.delete(id);
			if (keep) kept.set(id, 1);
			return json(200, { deleted: id });
		}
		if (sub === "stop") return await ws.stop(), json(200, { sessionId: id, state: "stopped" });
		if (sub === "start") return await ws.start(), json(200, { sessionId: id, state: "running" });
		if ((await ws.status()).state === "stopped") return json(409, { error: "session is stopped; start it first", code: "session_stopped" });
		const path = url.searchParams.get("path") ?? "";
		try {
			if (sub === "file" && method === "PUT") {
				const mode = url.searchParams.get("mode");
				await ws.writeFile(path, new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()), mode ? Number.parseInt(mode, 8) : undefined);
				return json(200, { ok: true });
			}
			if (sub === "file" && method === "GET") return new Response(await ws.readFile(path), { status: 200 });
			if (sub === "file" && method === "DELETE") return await ws.remove(path), json(200, { ok: true });
			if (sub === "list") return json(200, await ws.list(path));
			if (sub === "stat") {
				// lstat: the entry itself, found among its parent's entries.
				if (posix.normalize(path) === "/workspace") return json(200, await ws.stat(path));
				const entry = (await ws.list(posix.dirname(path))).find((e) => e.name === posix.basename(path));
				return entry ? json(200, entry) : json(404, { error: "no such file or directory", code: "not_found" });
			}
		} catch (error) {
			const answer = refusal(error);
			if (answer) return answer;
			throw error;
		}
		const { cmd, cwd, timeoutMs, stdin, env } = body as { cmd: string[]; cwd?: string; timeoutMs: number; stdin?: string; env?: Record<string, string> };
		const events = ws.exec(cmd, { cwd, timeoutMs, stdin, env, signal: init.signal ?? undefined });
		if (sub === "exec/stream") {
			const encoder = new TextEncoder();
			return new Response(
				new ReadableStream({
					async start(controller) {
						init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
						try {
							for await (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
							controller.close();
						} catch {}
					},
				}),
				{ status: 200, headers: { "content-type": "application/x-ndjson" } },
			);
		}
		throw new Error("the provider no longer uses buffered exec");
	};
	return { fetch: handler as typeof fetch, requests, backing };
}

const provider = (manager = fakeManager()) => new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: manager.fetch, maxConcurrent: 3 });

const spec = (sessionId: string): WorkspaceSpec => ({
	sessionId,
	image: "default",
	repo: { url: "https://example.test/repo.git", ref: "main", branch: "work" },
	limits: { cpu: 1, memMiB: 256, diskMiB: 64, pids: 64, wallClockMin: 5 },
	egress: { allow: ["allowed.test"] },
	gitAuth: { mode: "none" },
});

runConformanceSuite("compose", () => provider(), {
	checkLimit: async (p, s) => {
		const ref = await p.create({ ...s, limits: { ...s.limits, diskMiB: 1 } });
		await expect((await p.get(ref))?.writeFile("big.bin", new Uint8Array(2 * 1024 * 1024))).rejects.toBeInstanceOf(WorkspaceLimitError);
		await p.destroy(ref);
	},
});

describe("ComposeWorkspaceProvider", () => {
	it("sends the manager only the fields of its create body", async () => {
		const m = fakeManager();
		await provider(m).create(spec("body-1"));
		expect(m.requests[0]?.body).toEqual({ sessionId: "body-1", image: "default", limits: { cpu: 1, memMiB: 256, diskMiB: 64, pids: 64 }, egressAllow: ["allowed.test"] });
	});

	it("maps the manager's refusals and misses to workspace errors", async () => {
		const stub = (status: number, body: unknown) => new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: (async () => json(status, body)) as typeof fetch });
		const full = stub(429, { error: "at capacity", code: "capacity", limit: 2, running: 2 });
		await expect(full.create(spec("a"))).rejects.toBeInstanceOf(WorkspaceCapacityError);
		expect(full.capabilities.maxConcurrent).toBe(2);
		const low = await stub(507, { error: "free disk 3% is below 15%", code: "low_disk" })
			.create(spec("a"))
			.catch((e) => e);
		expect(low).toBeInstanceOf(ComposeManagerError);
		expect(low).toMatchObject({ status: 507, code: "low_disk" });
		// The code is the one ProviderCapacity takes.
		let held = false;
		new ProviderCapacity({ conditions: () => ({ lowDisk: false, budgetCapped: false }), setConditions: (c) => ((held = c.lowDisk), []), setLimit: () => [] }).onManagerError(low.code);
		expect(held).toBe(true);
		expect(await stub(404, { error: "no such session" }).get({ id: "x", providerId: "compose", sessionId: "x" })).toBeNull();
		const gone = stub(404, { error: "no such session" });
		await expect(gone.list()).rejects.toBeInstanceOf(WorkspaceNotFoundError);
		await expect(stub(409, { error: "session exists with different parameters" }).create(spec("a"))).rejects.toMatchObject({ status: 409 });
	});

	it("maps a failed request to an error that does not hold the token", async () => {
		const leaky = new ComposeWorkspaceProvider({
			managerUrl: URL_BASE,
			token: TOKEN,
			fetch: (async () => {
				throw new Error(`connect refused with Bearer ${TOKEN}`);
			}) as typeof fetch,
		});
		const error = await leaky.create(spec("a")).catch((e) => e);
		expect(String(error.message)).not.toContain(TOKEN);
		expect(String(error.message)).toContain("Cannot reach the workspace manager");
		const echoing = new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: (async () => json(500, { error: `bad ${TOKEN}` })) as typeof fetch });
		expect(String(((await echoing.create(spec("a")).catch((e) => e)) as Error).message)).not.toContain(TOKEN);
	});

	it("sends the token only in the Authorization header of authenticated routes", async () => {
		const m = fakeManager();
		const p = provider(m);
		const ref = await p.create(spec("tok-1"));
		await (await p.get(ref))?.writeFile("a.txt", new Uint8Array([1]));
		await p.managerHealth();
		expect(JSON.stringify(m.requests.map(({ method, path, body }) => ({ method, path, body })))).not.toContain(TOKEN);
		expect(m.requests.filter((r) => r.path !== "/health").every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
		expect(m.requests.find((r) => r.path === "/health")?.auth).toBeNull();
	});

	it("cancels the request when the signal aborts, even before it starts", async () => {
		let seen: AbortSignal | undefined;
		const hang = new ComposeWorkspaceProvider({
			managerUrl: URL_BASE,
			token: TOKEN,
			fetch: ((_url: string, init: RequestInit) => {
				if (String(_url).endsWith("/sessions/h")) return Promise.resolve(json(200, { sessionId: "h", state: "running" }));
				seen = init.signal ?? undefined;
				return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
			}) as unknown as typeof fetch,
		});
		const ws = await hang.get({ id: "h", providerId: "compose", sessionId: "h" });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const events: ExecEvent[] = [];
		for await (const e of ws!.exec(["sleep", "30"], { timeoutMs: 60_000, signal: controller.signal })) events.push(e);
		expect(seen?.aborted).toBe(true);
		expect(events).toEqual([{ type: "exit", code: null, signal: "SIGTERM" }]);
		const before: ExecEvent[] = [];
		for await (const e of ws!.exec(["true"], { timeoutMs: 1000, signal: controller.signal })) before.push(e);
		expect(before).toEqual(events);
	});

	it("sends env and the timeout in the exec body", async () => {
		const m = fakeManager();
		const p = provider(m);
		const ws = await p.get(await p.create(spec("env-1")));
		await ws!.writeFile("sub/x", new Uint8Array());
		for await (const _ of ws!.exec(["echo", "hi"], { timeoutMs: 1234, env: { A: "1" }, cwd: "sub" })) void _;
		expect(m.requests.at(-1)?.body).toMatchObject({ cmd: ["echo", "hi"], env: { A: "1" }, cwd: "/workspace/sub", timeoutMs: 1234 });
	});

	it("maps the manager's health for ProviderCapacity and refreshes capabilities", async () => {
		const p = new ComposeWorkspaceProvider({
			managerUrl: URL_BASE,
			token: TOKEN,
			fetch: (async () => json(200, { runsc: true, freeDiskPct: 61.2, maxConcurrent: 4, running: 1, free: 3, sessions: 1 })) as typeof fetch,
		});
		expect(p.capabilities).toEqual({ snapshot: false, egressAllowlist: true, maxConcurrent: undefined });
		expect(await p.managerHealth()).toEqual({ freeDiskPct: 61.2, maxConcurrent: 4, running: 1, free: 3, runscVerified: true, sessions: 1 });
		expect(p.capabilities.maxConcurrent).toBe(4);
		// A disk the manager could not read is reported as null by JSON, and is NaN here.
		const blind = new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: (async () => json(200, { runsc: false, freeDiskPct: null, maxConcurrent: 1, running: 1, free: 0 })) as typeof fetch });
		expect(await blind.managerHealth()).toMatchObject({ freeDiskPct: Number.NaN, runscVerified: false });
	});

	it("maps file and session refusals by their codes", async () => {
		const m = fakeManager();
		const p = provider(m);
		const ref = await p.create(spec("map-1"));
		const ws = (await p.get(ref))!;
		await expect(ws.readFile("missing")).rejects.toBeInstanceOf(WorkspaceFileError);
		await expect(ws.readFile("../x")).rejects.toBeInstanceOf(WorkspacePathError);
		await ws.stop();
		await expect(ws.writeFile("a", new Uint8Array())).rejects.toMatchObject({ status: 409, code: "session_stopped" });
		await expect(ws.exec(["true"], { timeoutMs: 1000 })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ status: 409, code: "session_stopped" });
		await ws.start();
		await p.destroy(ref);
		await expect(ws.readFile("a")).rejects.toBeInstanceOf(WorkspaceNotFoundError);
		expect(await ws.status()).toEqual({ state: "gone" });
	});

	it("lists a session kept by destroy as gone and opens none for it", async () => {
		const m = fakeManager();
		const p = provider(m);
		const ref = await p.create(spec("keep-1"));
		await p.destroy(ref, { keepVolume: true });
		expect(m.requests.at(-1)?.path).toBe("/sessions/keep-1?keepVolume=1");
		expect((await p.list({ state: "gone" })).map((i) => i.ref.sessionId)).toEqual(["keep-1"]);
		expect(await p.get(ref)).toBeNull();
		// A manager that did answer a gone session on GET would still give no workspace.
		const odd = new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: (async () => json(200, { sessionId: "keep-1", state: "gone" })) as typeof fetch });
		expect(await odd.get(ref)).toBeNull();
	});

	it("stat follows a symlink the manager describes as itself, within /workspace", async () => {
		const m = fakeManager();
		const p = provider(m);
		const ws = (await p.get(await p.create(spec("stat-1"))))!;
		const run = async (cmd: string[]) => {
			for await (const _ of ws.exec(cmd, { timeoutMs: 5000 })) void _;
		};
		await ws.writeFile("real/data.txt", new TextEncoder().encode("12345"), 0o600);
		await run(["ln", "-s", "real/data.txt", "file-link"]);
		await run(["ln", "-s", "file-link", "chain"]);
		await run(["ln", "-s", "real", "dir-link"]);
		await run(["ln", "-s", "/etc/hostname", "out-link"]);
		await run(["ln", "-s", "nowhere", "dangling"]);
		// The manager's own stat is of the link.
		expect((await (await m.fetch(`${URL_BASE}/sessions/stat-1/stat?path=file-link`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { type: string }).toMatchObject({ type: "symlink" });
		expect(await ws.stat("file-link")).toMatchObject({ name: "file-link", type: "file", size: 5, mode: 0o600 });
		expect(await ws.stat("chain")).toMatchObject({ name: "chain", type: "file", size: 5 });
		expect(await ws.stat("dir-link")).toMatchObject({ type: "dir" });
		expect(await ws.stat("real/data.txt")).toMatchObject({ type: "file", size: 5 });
		await expect(ws.stat("out-link")).rejects.toBeInstanceOf(WorkspacePathError);
		await expect(ws.stat("dangling")).rejects.toBeInstanceOf(WorkspaceFileError);
		// Only a symlink costs the extra exec.
		const before = m.requests.length;
		await ws.stat("real/data.txt");
		expect(m.requests.length - before).toBe(1);
	});

	it("streams output as the command prints it", async () => {
		const p = provider();
		const ws = (await p.get(await p.create(spec("stream-1"))))!;
		const seen: { at: number; event: ExecEvent }[] = [];
		const started = Date.now();
		for await (const event of ws.exec(["sh", "-c", "echo first; sleep 0.5; echo second"], { timeoutMs: 10_000 })) seen.push({ at: Date.now() - started, event });
		expect(seen.map((s) => s.event)).toEqual([
			{ type: "stdout", data: "first\n" },
			{ type: "stdout", data: "second\n" },
			{ type: "exit", code: 0 },
		]);
		expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(400);
		expect(seen[0]!.at).toBeLessThan(300);
	});

	it("reads NDJSON split across chunks and fails when the stream ends without an exit", async () => {
		const chunked = (parts: string[]) => {
			const encoder = new TextEncoder();
			return new ComposeWorkspaceProvider({
				managerUrl: URL_BASE,
				token: TOKEN,
				fetch: (async (url: string) =>
					String(url).endsWith("/exec/stream")
						? new Response(new ReadableStream({ start: (c) => (parts.forEach((x) => c.enqueue(encoder.encode(x))), c.close()) }), { status: 200 })
						: json(200, { sessionId: "c", state: "running" })) as unknown as typeof fetch,
			});
		};
		const run = async (parts: string[]) => {
			const p = chunked(parts);
			const ws = (await p.get({ id: "c", providerId: "compose", sessionId: "c" }))!;
			const out: ExecEvent[] = [];
			for await (const e of ws.exec(["x"], { timeoutMs: 1000 })) out.push(e);
			return out;
		};
		expect(await run(['{"type":"stdout","da', 'ta":"h\\u00e9"}\n{"type":"exit","code":3,"signal":null}', "\n"])).toEqual([
			{ type: "stdout", data: "h\u00e9" },
			{ type: "exit", code: 3 },
		]);
		await expect(run(['{"type":"stdout","data":"x"}\n'])).rejects.toBeInstanceOf(ComposeManagerError);
	});

	it("accepts https, and http only to loopback or private hosts", () => {
		const make = (managerUrl: string) => () => new ComposeWorkspaceProvider({ managerUrl, token: TOKEN });
		for (const ok of ["https://manager.example", "http://localhost:8080", "http://127.0.0.1", "http://[::1]:8080", "http://10.1.2.3", "http://172.20.0.5:8080", "http://192.168.1.9"]) expect(make(ok), ok).not.toThrow();
		for (const bad of ["http://manager.example", "http://8.8.8.8", "http://172.32.0.1", "http://192.169.0.1", "ftp://127.0.0.1", "not a url", "https://user:pw@manager.example"]) expect(make(bad), bad).toThrow();
	});
});
