import { describe, expect, it } from "vitest";
import { ComposeManagerError, ComposeWorkspaceProvider, SCRIPTS } from "../src/coding/workspace/compose";
import { runConformanceSuite } from "../src/coding/workspace/conformance";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { ProviderCapacity } from "../src/coding/provider-capacity";
import {
	type ExecEvent,
	type FileStat,
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
const kind = (stat: FileStat) => (stat.type === "dir" ? "directory" : stat.type === "symlink" ? "symbolic link" : "regular file");
const statLine = (s: FileStat) => `${kind(s)}|${s.size}|${s.mode.toString(8)}|${Math.floor(s.mtimeMs / 1000)}|/workspace/${s.name}\n`;

/** A fetch stub that is the sandbox-manager's routes, backed by a FakeWorkspaceProvider. The `sh` scripts the provider runs for stat, list, remove and chmod are answered with the workspace's own operations, as the real scripts would answer them in a container (checked by hand against a real shell, not here). */
function fakeManager(max = 3) {
	const backing = new FakeWorkspaceProvider({ maxConcurrent: max });
	const requests: { method: string; path: string; auth: string | null; body?: unknown }[] = [];
	const refs = new Map<string, WorkspaceRef>();

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
			const infos = await backing.list();
			return json(200, infos.map((i) => ({ sessionId: i.ref.sessionId, state: i.state, createdAt: i.createdAt })));
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
				return json(existed ? 200 : 201, { sessionId: spec.sessionId, state: "running", createdAt: 1 });
			} catch (error) {
				if (error instanceof WorkspaceCapacityError) return json(429, { error: "at capacity", code: "capacity", limit: max, running: refs.size });
				throw error;
			}
		}
		const m = /^\/sessions\/([a-z0-9-]+)(?:\/(exec|files|stop|start))?$/.exec(url.pathname);
		if (!m) return json(404, { error: "not found" });
		const [, id = "", sub] = m;
		const ref = refs.get(id);
		if (!ref) return method === "DELETE" ? json(404, { error: "no such session" }) : json(404, { error: "no such session" });
		const ws = await backing.get(ref);
		if (!ws) return json(404, { error: "no such session" });
		if (!sub && method === "GET") return json(200, { sessionId: id, ...(await ws.status()) });
		if (!sub && method === "DELETE") {
			await backing.destroy(ref, { keepVolume: url.searchParams.get("keepVolume") === "1" });
			refs.delete(id);
			return json(200, { deleted: id });
		}
		if (sub === "stop") return await ws.stop(), json(200, { ok: true });
		if (sub === "start") return await ws.start(), json(200, { ok: true });
		const path = url.searchParams.get("path") ?? "";
		try {
			if (sub === "files" && method === "PUT") {
				await ws.writeFile(path, new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()));
				return json(200, { ok: true });
			}
			if (sub === "files" && method === "GET") return new Response(await ws.readFile(path), { status: 200 });
		} catch (error) {
			if (error instanceof WorkspacePathError) return json(403, { error: "path escapes /workspace" });
			if (error instanceof WorkspaceLimitError) return json(507, { error: error.message, code: "disk_full" });
			if (error instanceof WorkspaceFileError) return json(404, { error: "no such file" });
			throw error;
		}
		// exec
		const { cmd, cwd, timeoutMs, stdin } = body as { cmd: string[]; cwd?: string; timeoutMs: number; stdin?: string };
		const out = (exitCode: number, stdout = "", stderr = "") => json(200, { stdout, stderr, exitCode, timedOut: false, truncated: false });
		const script = cmd[0] === "sh" && cmd[1] === "-c" ? (Object.entries(SCRIPTS).find(([, s]) => s === cmd[2])?.[0] as keyof typeof SCRIPTS | undefined) : undefined;
		if (script) {
			const target = cmd[4] ?? "";
			try {
				if (script === "stat") return out(0, statLine(await ws.stat(target)).replace("/workspace/", `/workspace/`));
				if (script === "list") return out(0, (await ws.list(target)).map(statLine).join(""));
				if (script === "remove") return await ws.remove(target), out(0);
				// chmod: the fake keeps a mode with the file's data, so rewrite the file with the new one.
				await ws.writeFile(target, await ws.readFile(target), Number.parseInt(cmd[5] ?? "644", 8));
				return out(0);
			} catch (error) {
				if (error instanceof WorkspacePathError) return out(77);
				return out(error instanceof WorkspaceFileError && /Not a directory/.test(error.message) ? 79 : 78);
			}
		}
		const events: ExecEvent[] = [];
		for await (const event of ws.exec(cmd, { cwd, timeoutMs, stdin, signal: init.signal ?? undefined })) events.push(event);
		const exit = events.at(-1) as Extract<ExecEvent, { type: "exit" }>;
		const text = (type: string) => events.map((e) => (e.type === type ? (e as { data: string }).data : "")).join("");
		return json(200, { stdout: text("stdout"), stderr: text("stderr"), exitCode: exit.code ?? 137, timedOut: exit.timedOut === true, truncated: false });
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
				if (String(_url).endsWith("/sessions/h")) return Promise.resolve(json(200, { sessionId: "h" }));
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

	it("sends env through env(1) and the timeout to the manager", async () => {
		const m = fakeManager();
		const p = provider(m);
		const ws = await p.get(await p.create(spec("env-1")));
		await ws!.writeFile("sub/x", new Uint8Array());
		for await (const _ of ws!.exec(["echo", "hi"], { timeoutMs: 1234, env: { A: "1" }, cwd: "sub" })) void _;
		expect(m.requests.at(-1)?.body).toMatchObject({ cmd: ["env", "A=1", "echo", "hi"], cwd: "/workspace/sub", timeoutMs: 1234 });
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

	it("accepts https, and http only to loopback or private hosts", () => {
		const make = (managerUrl: string) => () => new ComposeWorkspaceProvider({ managerUrl, token: TOKEN });
		for (const ok of ["https://manager.example", "http://localhost:8080", "http://127.0.0.1", "http://[::1]:8080", "http://10.1.2.3", "http://172.20.0.5:8080", "http://192.168.1.9"]) expect(make(ok), ok).not.toThrow();
		for (const bad of ["http://manager.example", "http://8.8.8.8", "http://172.32.0.1", "http://192.169.0.1", "ftp://127.0.0.1", "not a url", "https://user:pw@manager.example"]) expect(make(bad), bad).toThrow();
	});
});
