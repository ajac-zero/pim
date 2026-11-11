import { describe, expect, it } from "vitest";
import { ComposeManagerError, ComposeWorkspaceProvider } from "../src/coding/workspace/compose";
import { runConformanceSuite } from "../src/coding/workspace/conformance";
import { ProviderCapacity } from "../src/coding/provider-capacity";
import { fakeManager, json, TOKEN, URL_BASE } from "./fake-manager";
import {
	type ExecEvent,
	WorkspaceCapacityError,
	WorkspaceFileError,
	WorkspaceLimitError,
	WorkspaceNotFoundError,
	WorkspacePathError,
	type WorkspaceSpec,
} from "../src/coding/workspace/types";

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
		// A person's workspace names them and the repository, for its caches, and the snapshot it starts from; never secrets.
		const key = "ab".repeat(32);
		await provider(m)
			.create({ ...spec("body-2"), environment: { userId: "ada", repo: "acme/demo", restoreFrom: key } })
			.catch(() => {});
		expect(m.requests.at(-1)?.body).toEqual({ sessionId: "body-2", image: "default", limits: { cpu: 1, memMiB: 256, diskMiB: 64, pids: 64 }, egressAllow: ["allowed.test"], userId: "ada", repo: "acme/demo", restoreFrom: { key } });
	});

	it("maps the manager's refusals and misses to workspace errors", async () => {
		const stub = (status: number, body: unknown) => new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: (async () => json(status, body)) as typeof fetch });
		const full = stub(429, { error: "at capacity", code: "capacity", limit: 2, running: 2 });
		await expect(full.create(spec("a"))).rejects.toBeInstanceOf(WorkspaceCapacityError);
		expect(full.capabilities.maxConcurrent).toBe(2);
		// The manager's total workspace disk being promised out queues the thread like a full backend, and says what holds it.
		const quota = await stub(507, { error: "workspace disk would exceed 100 MiB (3 live workspaces 100 MiB)", code: "workspace_quota" })
			.create(spec("a"))
			.catch((e) => e);
		expect(quota).toBeInstanceOf(WorkspaceCapacityError);
		expect(quota.message).toContain("3 live workspaces");
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
			sleep: async () => {},
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
		// A turn's four-hour timeout reaches the manager whole: it was once cut to 15 minutes on the way.
		for await (const _ of ws!.exec(["true"], { timeoutMs: 240 * 60_000 })) void _;
		expect(m.requests.at(-1)?.body).toMatchObject({ timeoutMs: 240 * 60_000 });
	});

	it("maps the manager's health for ProviderCapacity and refreshes capabilities", async () => {
		const p = new ComposeWorkspaceProvider({
			managerUrl: URL_BASE,
			token: TOKEN,
			fetch: (async () => json(200, { runsc: true, freeDiskPct: 61.2, maxConcurrent: 4, running: 1, free: 3, sessions: 1 })) as typeof fetch,
		});
		expect(p.capabilities).toEqual({ snapshot: false, environmentSnapshots: true, egressAllowlist: true, restoreMBps: 8, maxConcurrent: undefined });
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
						: String(url).includes("/exec/")
							? json(404, { error: "not found" }) // a manager that cannot read on
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

	it("reads on through a manager restart from the event the broken stream stopped at", async () => {
		const encoder = new TextEncoder();
		const requests: { method: string; url: string; execId: string | null }[] = [];
		const resumes: (() => Response)[] = [
			() => {
				throw new TypeError("fetch failed"); // the manager is down
			},
			() => json(503, { error: "starting" }),
			() => new Response('\n{"type":"stdout","data":"c"}\n{"type":"exit","code":0,"signal":null}\n', { status: 200 }),
		];
		const p = new ComposeWorkspaceProvider({
			managerUrl: URL_BASE,
			token: TOKEN,
			fetch: (async (url: string, init: RequestInit) => {
				const headers = new Headers(init.headers);
				requests.push({ method: init.method!, url: String(url), execId: headers.get("x-exec-id") });
				if (String(url).endsWith("/exec/stream")) {
					// Two events and part of a third, then the connection breaks.
					let pulls = 0;
					const body = new ReadableStream({ pull: (c) => (pulls++ === 0 ? c.enqueue(encoder.encode('{"type":"stdout","data":"a"}\n{"type":"stdout","data":"b"}\n{"type":"std')) : c.error(new TypeError("terminated"))) });
					return new Response(body, { status: 200 });
				}
				if (String(url).includes("/exec/")) return resumes.shift()!();
				return json(200, { sessionId: "r", state: "running" });
			}) as unknown as typeof fetch,
		});
		const ws = (await p.get({ id: "r", providerId: "compose", sessionId: "r" }))!;
		const out: ExecEvent[] = [];
		for await (const e of ws.exec(["turn"], { timeoutMs: 60_000 })) out.push(e);
		expect(out).toEqual([
			{ type: "stdout", data: "a" },
			{ type: "stdout", data: "b" },
			{ type: "stdout", data: "c" },
			{ type: "exit", code: 0 },
		]);
		const [post, ...gets] = requests.filter((r) => r.url.includes("/exec"));
		expect(post!.execId).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
		expect(gets.map((g) => [g.method, g.url])).toEqual(Array(3).fill(["GET", `${URL_BASE}/sessions/r/exec/${post!.execId}/stream?after=2`]));
		// A manager or workspace that no longer has the command fails the exec as before.
		resumes.push(() => json(404, { error: "no such command", code: "exec_not_found" }));
		await expect(
			(async () => {
				for await (const _ of ws.exec(["turn"], { timeoutMs: 60_000 })) void _;
			})(),
		).rejects.toThrow("terminated");
	});

	it("accepts https, and http only to loopback or private hosts", () => {
		const make = (managerUrl: string) => () => new ComposeWorkspaceProvider({ managerUrl, token: TOKEN });
		for (const ok of ["https://manager.example", "http://localhost:8080", "http://127.0.0.1", "http://[::1]:8080", "http://10.1.2.3", "http://172.20.0.5:8080", "http://192.168.1.9"]) expect(make(ok), ok).not.toThrow();
		for (const bad of ["http://manager.example", "http://8.8.8.8", "http://172.32.0.1", "http://192.169.0.1", "ftp://127.0.0.1", "not a url", "https://user:pw@manager.example"]) expect(make(bad), bad).toThrow();
	});

	describe("when the manager is unavailable", () => {
		const flaky = (manager: ReturnType<typeof fakeManager>, fail: (n: number) => Response | Error | null) => {
			let n = 0;
			const sleeps: number[] = [];
			const p = new ComposeWorkspaceProvider({
				managerUrl: URL_BASE,
				token: TOKEN,
				sleep: async (ms) => void sleeps.push(ms),
				fetch: (async (input, init) => {
					if (String(input).endsWith("/health")) return manager.fetch(input, init);
					const failure = fail(++n);
					if (failure instanceof Error) throw failure;
					return failure ?? manager.fetch(input, init);
				}) as typeof fetch,
			});
			return { p, sleeps, attempts: () => n };
		};

		it("retries a 502 or a network error with growing, jittered waits until the manager answers", async () => {
			const { p, sleeps, attempts } = flaky(fakeManager(), (n) => (n <= 2 ? json(502, { error: "bad gateway" }) : n === 3 ? new TypeError("connection refused") : n === 4 ? json(503, {}) : null));
			await p.create(spec("retry-1"));
			expect(attempts()).toBe(5);
			expect(sleeps).toHaveLength(4);
			sleeps.forEach((ms, i) => {
				expect(ms).toBeGreaterThanOrEqual(4_000 * 2 ** i * 0.75);
				expect(ms).toBeLessThanOrEqual(4_000 * 2 ** i * 1.25);
			});
		});

		it("fails with the manager's answer after six attempts when it never recovers", async () => {
			const down = flaky(fakeManager(), () => json(502, {}));
			await expect(down.p.create(spec("retry-2"))).rejects.toMatchObject({ name: "ComposeManagerError", status: 502, message: "The workspace manager answered 502" });
			expect(down.attempts()).toBe(6);
			expect(down.sleeps).toHaveLength(5);
			const unreachable = flaky(fakeManager(), () => new TypeError("connection refused"));
			await expect(unreachable.p.create(spec("retry-3"))).rejects.toThrow("Cannot reach the workspace manager: connection refused");
			expect(unreachable.attempts()).toBe(6);
		});

		it("never repeats a command the manager may have run: only a refused connection or a gateway answer is retried", async () => {
			const exec = async (fail: (n: number) => Response | Error | null) => {
				const manager = fakeManager();
				const { p, attempts } = flaky(manager, fail);
				const ws = await p.get(await p.create(spec("exec-1")));
				const before = attempts();
				const events: ExecEvent[] = [];
				const outcome = await (async () => {
					for await (const e of ws!.exec(["echo", "hi"], { timeoutMs: 1000 })) events.push(e);
				})().then(
					() => "ok",
					(e: Error) => e.message,
				);
				return { outcome, tries: attempts() - before, events };
			};
			// Calls 1 and 2 are the create and the get; the exec is the third.
			expect((await exec((n) => (n === 3 ? new TypeError("socket hang up: ECONNRESET") : null))).tries).toBe(1);
			expect((await exec((n) => (n === 3 ? json(408, {}) : null))).tries).toBe(1);
			expect((await exec((n) => (n === 3 ? json(500, {}) : null))).tries).toBe(1);
			const refusedThenOk = await exec((n) => (n === 3 ? new Error("connect ECONNREFUSED 127.0.0.1:8080") : n === 4 ? json(502, {}) : null));
			expect(refusedThenOk.tries).toBe(3);
			expect(refusedThenOk.events.at(-1)).toMatchObject({ type: "exit", code: 0 });
		});


		it("fails at once on an answer that retrying won't change", async () => {
			for (const [status, body] of [[400, {}], [401, {}], [404, {}], [409, {}], [422, {}], [429, { code: "capacity", limit: 1 }], [507, { code: "low_disk" }]] as const) {
				const { p, attempts } = flaky(fakeManager(), () => json(status, body));
				await expect(p.create(spec("once")), String(status)).rejects.toThrow();
				expect(attempts(), String(status)).toBe(1);
			}
		});
	});
});
