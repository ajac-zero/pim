// Contract test for the Amp internal-API client against recorded fixtures
// (test/fixtures/amp-internal, shapes verified live, tokens redacted).
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmpHttpOrbClient, AMP_MAX_MESSAGE_CHARS, type AmpHttpOptions, type AmpHttpStore } from "../src/coding/orb/amp-http";
import { runOrbClientConformanceSuite } from "../src/coding/orb/conformance";
import { OrbAuthError, OrbLostError, OrbUnreachableError, OrbUnsupportedError } from "../src/coding/orb/types";

class MemoryStore implements AmpHttpStore {
	values = new Map<string, unknown>();
	async get(key: string) { return structuredClone(this.values.get(key) ?? null); }
	async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
	async claim(key: string, value: unknown) {
		if (this.values.get(key)) return false;
		this.values.set(key, structuredClone(value));
		return true;
	}
}
declare global {
	interface ImportMeta {
		glob(patterns: string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
	}
}
const raw = import.meta.glob(["./fixtures/amp-internal/*.json"], { query: "?raw", import: "default", eager: true });
const fixtureText = (name: string) => raw[`./fixtures/amp-internal/${name}.json`]!;
const fx = (name: string) => JSON.parse(fixtureText(name)) as Record<string, any>;
const reply = (name: string, status = 200, headers = {}) => new Response(fixtureText(name), { status, headers: { "content-type": "application/json", ...headers } });
const json = (body: unknown, status = 200, headers = {}) => Response.json(body, { status, headers });
const start = { project: "https://github.com/acme/demo.git", prompt: "Fix it", mode: null, title: null, idempotencyKey: "one" };
const TOKEN = "sgamp_saved";
const routes: Record<string, string> = { resolveProjectByRepositoryURLs: "resolve-project", createRemoteExecutorThread: "create-thread", getThreadTail: "tail-working", sendMessageToThread: "send-message", archiveThread: "archive" };
const methodOf = (init?: RequestInit) => JSON.parse(init?.body as string).method as string;

function fixture(options: Partial<AmpHttpOptions> = {}) {
	let created = 0;
	const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
		const method = methodOf(init);
		if (method !== "createRemoteExecutorThread") return reply(routes[method]!);
		// The first thread is the recorded one; later ones get their own id, as Amp would give.
		const id = ++created === 1 ? "T-abc-1" : `T-abc-${created}`;
		return new Response(fixtureText("create-thread").replaceAll("T-abc-1", id));
	});
	const store = new MemoryStore();
	const client = new AmpHttpOrbClient({ store, token: async () => TOKEN, fetch: fetcher, ...options });
	return { client, fetcher, store };
}
const bodies = (fetcher: ReturnType<typeof fixture>["fetcher"]) => fetcher.mock.calls.map(([, init]) => JSON.parse(init?.body as string));

runOrbClientConformanceSuite("Amp internal API", () => fixture().client, { project: "acme/demo", stopHalts: false });

describe("AmpHttpOrbClient contract", () => {
	afterEach(() => vi.restoreAllMocks());
	const logs = () => vi.spyOn(console, "warn").mockImplementation(() => {});

	it("declares steer and stop (archive) but no usage", async () => {
		const { client } = fixture();
		expect(client.capabilities()).toEqual({ steer: true, stop: true, usage: false });
		await expect(client.usage("T")).rejects.toBeInstanceOf(OrbUnsupportedError);
	});

	it("calls the global fetch without the client as `this` when none is injected", async () => {
		const original = globalThis.fetch;
		const stub = vi.fn(function (this: unknown, _url: unknown, init?: RequestInit) {
			if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
			return Promise.resolve(reply(routes[methodOf(init)]!));
		});
		globalThis.fetch = stub as unknown as typeof fetch;
		try {
			const client = new AmpHttpOrbClient({ store: new MemoryStore(), token: async () => TOKEN });
			await expect(client.start(start)).resolves.toMatchObject({ threadId: "T-abc-1" });
			expect(stub).toHaveBeenCalledTimes(2);
		} finally {
			globalThis.fetch = original;
		}
	});

	it("resolves the project, then creates the thread with exactly the documented request", async () => {
		const { client, fetcher, store } = fixture();
		const thread = await client.start({ ...start, mode: "high", title: "ignored" });
		expect(thread).toEqual({ threadId: "T-abc-1", url: "https://ampcode.com/threads/T-abc-1" });
		expect(fetcher).toHaveBeenCalledTimes(2);
		const [[url1, init1], [url2, init2]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
		expect(url1).toBe("https://ampcode.com/api/internal?resolveProjectByRepositoryURLs");
		expect(url2).toBe("https://ampcode.com/api/internal?createRemoteExecutorThread");
		for (const init of [init1, init2]) {
			expect(init.method).toBe("POST");
			expect(init.redirect).toBe("manual");
			expect(init.signal).toBeInstanceOf(AbortSignal);
			expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
		}
		expect(JSON.parse(init1.body as string)).toEqual({ method: "resolveProjectByRepositoryURLs", params: { repositoryURLs: ["https://github.com/acme/demo"] } });
		expect(JSON.parse(init2.body as string)).toEqual({
			method: "createRemoteExecutorThread",
			params: { agentMode: "high", content: [{ type: "text", text: "Fix it" }], features: [], userState: { currentlyVisibleFiles: [], timeZone: "UTC" }, projectID: "P-1234", executeMode: true, threadMeta: { visibility: "private", sharedGroupIDs: [] } },
		});
		expect(await store.get("amp:start:one")).toEqual({ thread });
		expect(await store.get("amp:project:https://github.com/acme/demo")).toBe("P-1234");
	});

	it("defaults the agent mode to medium and caches the project in memory and the store", async () => {
		const { client, fetcher, store } = fixture();
		await client.start({ ...start, mode: "smart" });
		await client.start({ ...start, idempotencyKey: "two" });
		expect(bodies(fetcher).map((b) => b.method)).toEqual(["resolveProjectByRepositoryURLs", "createRemoteExecutorThread", "createRemoteExecutorThread"]);
		expect(bodies(fetcher)[1].params.agentMode).toBe("medium");
		// A new client (as after a DO restart) reads the stored project.
		const restarted = new AmpHttpOrbClient({ ...client.options });
		await restarted.start({ ...start, idempotencyKey: "three" });
		expect(fetcher).toHaveBeenCalledTimes(4);
		expect(store.values.get("amp:start:one")).toBeTruthy();
		// The saved handle is returned without any call.
		await restarted.start(start);
		expect(fetcher).toHaveBeenCalledTimes(4);
	});

	it("accepts namespace/name projects and honors a base URL override", async () => {
		const { client, fetcher } = fixture({ baseUrl: "https://amp.test/" });
		await client.start({ ...start, project: "acme/demo" });
		expect(fetcher.mock.calls[0]![0]).toBe("https://amp.test/api/internal?resolveProjectByRepositoryURLs");
		expect(bodies(fetcher)[0].params.repositoryURLs).toEqual(["https://github.com/acme/demo"]);
		await expect(client.start({ ...start, project: "nonsense", idempotencyKey: "x" })).rejects.toMatchObject({ code: "orb_request" });
	});

	it("never repeats an ambiguous create, even after restart or concurrent calls", async () => {
		const { client, fetcher } = fixture();
		fetcher.mockImplementation(async (_u, init) => {
			if (methodOf(init) === "resolveProjectByRepositoryURLs") return reply("resolve-project");
			throw new Error("network lost");
		});
		logs();
		const results = await Promise.allSettled([client.start(start), client.start(start)]);
		expect(results.every((r) => r.status === "rejected")).toBe(true);
		await expect(new AmpHttpOrbClient(client.options).start(start)).rejects.toMatchObject({ code: "orb_start_uncertain" });
		expect(bodies(fetcher).filter((b) => b.method === "createRemoteExecutorThread")).toHaveLength(1);
	});

	it("maps tail states: working -> working, idle -> idle after working was seen", async () => {
		let now = 0;
		const { client, fetcher } = fixture({ now: () => now });
		await client.start(start);
		fetcher.mockClear();
		fetcher.mockImplementation(async () => reply("tail-idle"));
		// idle straight after creation is not trusted yet
		expect((await client.state("T-abc-1")).state).toBe("working");
		fetcher.mockImplementation(async () => reply("tail-working"));
		expect(await client.state("T-abc-1")).toEqual({ state: "working", lastEventAt: Date.parse("2026-01-01T00:00:05Z") });
		fetcher.mockImplementation(async () => reply("tail-idle"));
		expect((await client.state("T-abc-1")).state).toBe("idle");
		expect(bodies(fetcher)[0]).toEqual({ method: "getThreadTail", params: { thread: "T-abc-1", limit: 1 } });
		expect(fetcher.mock.calls[0]![0]).toBe("https://ampcode.com/api/internal?getThreadTail");
	});

	it("allows idle after the creation grace period, waits two minutes on errors, treats unknown states as working", async () => {
		let now = 0;
		const { client, fetcher } = fixture({ now: () => now });
		const warn = logs();
		await client.start(start);
		const state = async (value?: string) => {
			fetcher.mockImplementation(async () => json({ ok: true, result: { thread: { data: { meta: value ? { lastKnownAgentState: { state: value } } : {} } }, messages: [] } }));
			return (await client.state("T-abc-1")).state;
		};
		expect(await state()).toBe("working");
		expect(await state("surprising")).toBe("working");
		expect(warn.mock.calls.join("\n")).toContain("amp_http_unknown_state");
		expect(await state("awaiting_approval")).toBe("awaiting_approval");
		expect(await state("error")).toBe("working");
		now = 120_000;
		expect(await state("error")).toBe("error");
		expect(await state("idle")).toBe("idle");
	});

	it("maps the transcript, tolerating non-text blocks, and resumes after a message id", async () => {
		const { client, fetcher } = fixture();
		fetcher.mockImplementation(async () => reply("tail-idle"));
		const all = await client.messages("T-abc-1");
		expect(all.map((m) => [m.id, m.role, m.text])).toEqual([
			["0", "user", "Fix it"],
			["1", "assistant", "[tool_use]\nReading."],
			["2", "user", "[tool_result]"],
			["3", "assistant", "Done.\nAll fixed."],
		]);
		expect(all[1]!.at).toBe(1767225610000);
		expect((await client.messages("T-abc-1", { after: "2" })).map((m) => m.id)).toEqual(["3"]);
		expect(bodies(fetcher)[0]).toEqual({ method: "getThreadTail", params: { thread: "T-abc-1", limit: 200 } });
	});

	it("survives garbage message shapes and truncates huge text", async () => {
		const { client, fetcher } = fixture();
		const huge = "x".repeat(AMP_MAX_MESSAGE_CHARS * 3);
		fetcher.mockImplementation(async () => json({ ok: true, result: { messages: [null, 5, {}, { messageId: "a", role: "assistant", content: null }, { messageId: "b", content: [null, 3, { type: 9 }, { type: "text" }, { type: "text", text: huge }] }, { messageId: "b", content: [] }] } }));
		const all = await client.messages("T");
		expect(all.map((m) => m.id)).toEqual(["a", "b"]);
		expect(all[1]!.text.length).toBeLessThan(AMP_MAX_MESSAGE_CHARS + 50);
		expect(all[1]!.text.endsWith("[truncated]")).toBe(true);
	});

	it("caps the response size, retrying the transcript with a smaller window", async () => {
		const { client, fetcher } = fixture();
		logs();
		const big = () => new Response(`{"ok":true,"result":{"pad":"${"x".repeat(2_100_000)}"}}`);
		fetcher.mockImplementationOnce(async () => big()).mockImplementationOnce(async () => reply("tail-idle"));
		expect(await client.messages("T")).toHaveLength(4);
		expect(bodies(fetcher).map((b) => b.params.limit)).toEqual([200, 20]);
		fetcher.mockImplementation(async () => big());
		await expect(client.state("T")).rejects.toMatchObject({ code: "orb_request", message: expect.stringContaining("size cap") });
	});

	it("steers with sendMessageToThread", async () => {
		const { client, fetcher } = fixture();
		await client.steer("T-abc-1", "also add tests");
		expect(fetcher.mock.calls[0]![0]).toBe("https://ampcode.com/api/internal?sendMessageToThread");
		expect(fetcher.mock.calls[0]![1]?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
		expect(bodies(fetcher)[0]).toEqual({ method: "sendMessageToThread", params: { threadID: "T-abc-1", content: [{ type: "text", text: "also add tests" }], userState: { currentlyVisibleFiles: [], timeZone: "UTC" } } });
	});

	it("stops by archiving with the `thread` key", async () => {
		const { client, fetcher } = fixture();
		await client.stop("T-abc-1");
		expect(fetcher.mock.calls[0]![0]).toBe("https://ampcode.com/api/internal?archiveThread");
		expect(bodies(fetcher)[0]).toEqual({ method: "archiveThread", params: { thread: "T-abc-1", archived: true } });
	});

	it("never touches /api/v2", async () => {
		const { client, fetcher } = fixture();
		await client.start(start);
		await client.state("T-abc-1");
		await client.messages("T-abc-1");
		await client.steer("T-abc-1", "x");
		await client.stop("T-abc-1");
		for (const [url] of fetcher.mock.calls) expect(String(url)).toMatch(/^https:\/\/ampcode\.com\/api\/internal\?[A-Za-z]+$/);
	});

	describe("errors", () => {
		it("asks to connect without a token and sends nothing", async () => {
			const { client, fetcher } = fixture({ token: async () => null });
			await expect(client.start(start)).rejects.toBeInstanceOf(OrbAuthError);
			expect(fetcher).not.toHaveBeenCalled();
		});
		it("maps 401 {status,message} to an auth error without leaking the token", async () => {
			const spy = logs();
			const { client, fetcher } = fixture();
			fetcher.mockImplementation(async () => reply("error-401", 401, { "x-request-id": "req-1", "www-authenticate": `Bearer ${TOKEN}` }));
			const error = await client.start(start).catch((e) => e);
			expect(error).toBeInstanceOf(OrbAuthError);
			expect(error.message).toContain("HTTP 401");
			expect(error.message).toContain("unauthorized");
			const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(logged).toContain("req-1");
			expect(logged).toContain('"status":401');
			expect(logged + error.message).not.toContain(TOKEN);
		});
		it("treats ok:false as a definitive, redacted rejection that frees the start", async () => {
			const spy = logs();
			const { client, fetcher, store } = fixture();
			fetcher.mockImplementation(async (_u, init) => methodOf(init) === "resolveProjectByRepositoryURLs" ? reply("resolve-project") : reply("error-ok-false"));
			const error = await client.start(start).catch((e) => e);
			expect(error).toMatchObject({ code: "orb_request" });
			expect(error.message).toContain("invalid-params");
			expect(error.message).not.toContain("sgamp_");
			expect(store.values.get("amp:start:one")).toBeNull();
			expect(spy.mock.calls.join("\n")).not.toContain("sgamp_");
			// ok:false is not retried with backoff, and can be started again.
			fetcher.mockImplementation(async (_u, init) => reply(routes[methodOf(init)]!));
			await expect(client.start(start)).resolves.toMatchObject({ threadId: "T-abc-1" });
		});
		it("maps a thread-not-found ok:false on a thread call to a lost thread, and an auth code to auth", async () => {
			const { client, fetcher } = fixture();
			fetcher.mockResolvedValue(json({ ok: false, error: { code: "thread-not-found", message: "nope" } }));
			await expect(client.state("T")).rejects.toBeInstanceOf(OrbLostError);
			fetcher.mockResolvedValue(json({ ok: false, error: { code: "unauthorized", message: "no" } }));
			await expect(client.state("T")).rejects.toBeInstanceOf(OrbAuthError);
			fetcher.mockResolvedValue(json({}, 404));
			await expect(client.state("T")).rejects.toBeInstanceOf(OrbLostError);
		});
		it("fails on malformed JSON and unexpected shapes without echoing the token", async () => {
			const spy = logs();
			const { client, fetcher } = fixture();
			fetcher.mockResolvedValue(new Response(`not json ${TOKEN}`, { status: 200 }));
			const error = await client.state("T").catch((e) => e);
			expect(error).toMatchObject({ code: "orb_request" });
			expect(error.message).toContain("invalid JSON (status 200: not json [redacted])");
			fetcher.mockResolvedValue(json({ hello: "world" }));
			await expect(client.steer("T", "x")).rejects.toMatchObject({ code: "orb_request" });
			expect(JSON.stringify([error.message, spy.mock.calls])).not.toContain(TOKEN);
		});
		it("keeps the first failure for an uncertain create, redacted", async () => {
			const spy = logs();
			const { client, fetcher, store } = fixture();
			fetcher.mockImplementation(async (_u, init) => {
				if (methodOf(init) === "resolveProjectByRepositoryURLs") return reply("resolve-project");
				throw new TypeError(`fetch failed ${TOKEN} Bearer ${TOKEN}`);
			});
			await client.start(start).catch(() => null);
			const message = await client.start(start).then(() => "", (e: Error) => e.message);
			expect(message).toContain("first attempt: fetch failed [redacted] Bearer [redacted]");
			expect(JSON.stringify([spy.mock.calls, message, [...store.values]])).not.toContain(TOKEN);
		});
		it("retries a 429 on create after backoff, but never a 5xx create", async () => {
			let now = 0;
			const { client, fetcher } = fixture({ now: () => now });
			logs();
			const create = vi.fn(async (): Promise<Response> => json({}, 429, { "Retry-After": "90" }));
			fetcher.mockImplementation(async (_u, init) => methodOf(init) === "resolveProjectByRepositoryURLs" ? reply("resolve-project") : create());
			await expect(client.start(start)).rejects.toMatchObject({ retryAfterMs: 90_000 });
			await expect(client.start(start)).rejects.toBeInstanceOf(OrbUnreachableError);
			expect(create).toHaveBeenCalledTimes(1);
			now = 90_000;
			create.mockImplementation(async () => reply("create-thread"));
			expect(await client.start(start)).toMatchObject({ threadId: "T-abc-1" });
			const uncertain = fixture();
			uncertain.fetcher.mockImplementation(async (_u, init) => methodOf(init) === "resolveProjectByRepositoryURLs" ? reply("resolve-project") : json({}, 503));
			await expect(uncertain.client.start(start)).rejects.toBeInstanceOf(OrbUnreachableError);
			await expect(uncertain.client.start(start)).rejects.toMatchObject({ code: "orb_start_uncertain" });
		});
		it("honors Retry-After and bounds retries", async () => {
			let now = 0;
			const { client, fetcher } = fixture({ now: () => now });
			logs();
			fetcher.mockImplementation(async () => json({}, 429, { "Retry-After": "90" }));
			await expect(client.state("T")).rejects.toMatchObject({ retryAfterMs: 90_000 });
			await expect(client.state("T")).rejects.toBeInstanceOf(OrbUnreachableError);
			expect(fetcher).toHaveBeenCalledTimes(1);
			for (let i = 0; i < 5; i++) {
				now += 1_000_000;
				await expect(client.state("T")).rejects.toBeInstanceOf(OrbUnreachableError);
			}
			now += 1_000_000;
			await expect(client.state("T")).rejects.toMatchObject({ code: "orb_retry_exhausted" });
		});
		it("keeps a 500 body snippet, bounded and redacted", async () => {
			const spy = logs();
			const { client, fetcher } = fixture();
			fetcher.mockResolvedValue(new Response(`boom ${TOKEN} ${"x".repeat(500)}`, { status: 500 }));
			const error = await client.state("T").catch((e) => e);
			expect(error).toBeInstanceOf(OrbUnreachableError);
			expect(error.message).toContain("HTTP 500: boom [redacted]");
			expect(JSON.parse(String(spy.mock.calls[0]![0])).errMessage.length).toBeLessThanOrEqual(200);
			expect(JSON.stringify([spy.mock.calls, error.message])).not.toContain(TOKEN);
		});
	});

	describe("redirects", () => {
		const workersFetch = (inner: (init?: RequestInit) => Response) => vi.fn<typeof fetch>(async (_url, init) => {
			if (init?.redirect !== "follow" && init?.redirect !== "manual") throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
			return inner(init);
		});
		it("works with a Workers-style fetch that rejects redirect: error", async () => {
			const { client } = fixture({ fetch: workersFetch((init) => reply(routes[methodOf(init)]!)) });
			await expect(client.start(start)).resolves.toMatchObject({ threadId: "T-abc-1" });
		});
		it("treats a 302 as a definitive non-retryable error without leaking the target", async () => {
			logs();
			const { client } = fixture({ fetch: workersFetch(() => new Response(null, { status: 302, headers: { Location: "https://evil.example/path?secret=abc" } })) });
			const error = await client.state("T").catch((e: Error) => e);
			expect(error).toMatchObject({ code: "orb_request" });
			expect(error).not.toBeInstanceOf(OrbUnreachableError);
			expect((error as Error).message).toContain("302");
			expect((error as Error).message).not.toMatch(/sgamp_saved|secret=abc|evil\.example/);
		});
	});
});
