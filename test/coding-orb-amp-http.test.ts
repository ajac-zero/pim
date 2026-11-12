import { describe, expect, it, vi } from "vitest";
import { AmpHttpOrbClient, AMP_HTTP_AUTH_REJECTED, type AmpHttpOptions, type AmpHttpStore } from "../src/coding/orb/amp-http";
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
const start = { project: "https://github.com/acme/demo.git", prompt: "Fix it", mode: null, title: null, idempotencyKey: "one" };
const json = (body: unknown, status = 200, headers = {}) => Response.json(body, { status, headers });
function fixture(options: Partial<AmpHttpOptions> = {}) {
	let count = 0;
	const fetcher = vi.fn<typeof fetch>(async () => json({ thread: { id: `T-${++count}`, url: `https://ampcode.com/threads/T-${count}` } }, 201));
	const store = new MemoryStore();
	const client = new AmpHttpOrbClient({ store, token: async () => "sgamp_saved", fetch: fetcher, ...options });
	return { client, fetcher, store };
}
runOrbClientConformanceSuite("Amp HTTP", () => fixture().client, { project: "acme/demo" });

describe("AmpHttpOrbClient", () => {
	it("uses only the documented POST fields and the saved Amp bearer, and keeps the handle before polling", async () => {
		const { client, fetcher, store } = fixture();
		const thread = await client.start({ ...start, mode: "smart", title: "Fix" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0]!;
		expect(url).toBe("https://ampcode.com/api/v2/threads");
		expect(init?.headers).toMatchObject({ Authorization: "Bearer sgamp_saved" });
		expect(JSON.parse(init?.body as string)).toEqual({ project: "acme/demo", message: "Fix it", agentMode: "smart", title: "Fix" });
		expect(await store.get("amp:start:one")).toEqual({ thread });
		const restarted = new AmpHttpOrbClient({ ...client.options });
		expect(await restarted.start(start)).toEqual(thread);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("never repeats an ambiguous POST, even after restart or concurrent calls", async () => {
		const { client, fetcher } = fixture();
		fetcher.mockRejectedValue(new Error("network lost"));
		const results = await Promise.allSettled([client.start(start), client.start(start)]);
		expect(results.every((r) => r.status === "rejected")).toBe(true);
		await expect(new AmpHttpOrbClient(client.options).start(start)).rejects.toMatchObject({ code: "orb_start_uncertain" });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("asks to connect without a PAT, and maps a rejected saved token without exposing it", async () => {
		const missing = fixture({ token: async () => null });
		await expect(missing.client.start(start)).rejects.toBeInstanceOf(OrbAuthError);
		expect(missing.fetcher).not.toHaveBeenCalled();
		for (const status of [401, 403]) {
			const { client, fetcher } = fixture();
			fetcher.mockResolvedValue(json({ secret: "sgamp_saved" }, status));
			await expect(client.start(start)).rejects.toMatchObject({ code: "orb_auth", message: AMP_HTTP_AUTH_REJECTED });
		}
	});
	it("polls through missing and early idle states, persists working, and waits two minutes on Amp errors", async () => {
		let now = 0;
		const { client, fetcher } = fixture({ now: () => now });
		await client.start(start);
		const state = async (value?: string) => {
			fetcher.mockImplementation(async () => json({ thread: { agentState: value ? { state: value, updatedAt: "2026-01-01T00:00:00Z" } : undefined } }));
			return (await client.state("T-1")).state;
		};
		expect(await state()).toBe("working");
		expect(await state("idle")).toBe("working");
		expect(await state("working")).toBe("working");
		expect((await new AmpHttpOrbClient(client.options).state("T-1")).state).toBe("working");
		expect(await state("idle")).toBe("idle");
		expect(await state("awaiting_approval")).toBe("awaiting_approval");
		expect(await state("error")).toBe("working");
		now = 119_999;
		expect(await state("error")).toBe("working");
		now = 120_000;
		expect(await state("error")).toBe("error");
		expect(await state("working")).toBe("working");
		expect(await state("error")).toBe("working");
	});
	it("allows idle after a creation grace period even if working was never seen", async () => {
		let now = 0;
		const { client, fetcher } = fixture({ now: () => now });
		await client.start(start);
		now = 60_000;
		fetcher.mockResolvedValue(json({ thread: { agentState: { state: "idle" } } }));
		expect(await client.state("T-1")).toMatchObject({ state: "idle", lastEventAt: null });
	});
	it("reads cursor pages defensively, keeps raw JSON, and resumes by message id after restart", async () => {
		const { client, fetcher, store } = fixture();
		const one = { messageID: "m1", messageVersion: 2, createdAt: "2026-01-01T00:00:00Z", strange: [1, 2] };
		const two = { messageID: "m2", createdAt: 100, role: "user", text: "hello" };
		fetcher.mockImplementation(async (url) => String(url).includes("cursor=") ? json({ messages: [two] }) : json({ messages: [null, {}, one], nextCursor: "opaque /" }));
		expect((await client.messages("T-1")).map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(await store.get("amp:message:T-1:m1")).toEqual(one);
		expect(await new AmpHttpOrbClient(client.options).messages("T-1", { after: "m1" })).toEqual([{ id: "m2", role: "user", at: 100, text: "hello", raw: two }]);
		expect(fetcher.mock.calls[1]![0]).toBe("https://ampcode.com/api/v2/threads/T-1/messages?cursor=opaque%20%2F");
	});
	it("never calls steer, stop, DELETE or PAT usage endpoints", async () => {
		const { client, fetcher } = fixture();
		expect(client.capabilities()).toEqual({ steer: false, stop: false, usage: false });
		await expect(client.steer("T", "hi")).rejects.toBeInstanceOf(OrbUnsupportedError);
		await expect(client.stop("T")).rejects.toThrow("not supported by Amp's HTTP API yet");
		await expect(client.usage("T")).rejects.toBeInstanceOf(OrbUnsupportedError);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("uses optional client credentials for usage, never the PAT", async () => {
		const { client, fetcher } = fixture({ m2m: async () => ({ clientId: "client", clientSecret: "secret" }) });
		fetcher.mockResolvedValueOnce(json({ access_token: "oauth" })).mockResolvedValueOnce(json({ usd: 1.25 }));
		expect(await client.usage("T")).toEqual({ usd: 1.25 });
		expect(fetcher.mock.calls[0]![0]).toBe("https://auth.ampcode.com/oauth2/token");
		expect(fetcher.mock.calls[0]![1]?.body).toContain("scope=amp.api%3Aworkspace.threads.meta%3Aview");
		expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({ Authorization: "Bearer oauth" });
		const absent = fixture({ m2m: async () => null });
		expect(await absent.client.usage("T")).toBeNull();
		expect(absent.fetcher).not.toHaveBeenCalled();
	});
	it("retries a definitive 429 creation rejection after backoff, but never a 5xx creation outcome", async () => {
		let now = 0;
		const { client, fetcher } = fixture({ now: () => now });
		fetcher.mockImplementation(async () => json({}, 429, { "Retry-After": "90" }));
		await expect(client.start(start)).rejects.toMatchObject({ retryAfterMs: 90_000 });
		await expect(client.start(start)).rejects.toBeInstanceOf(OrbUnreachableError);
		now = 90_000;
		fetcher.mockImplementation(async () => json({ thread: { id: "T-ok", url: "https://ampcode.com/threads/T-ok" } }, 201));
		expect(await client.start(start)).toMatchObject({ threadId: "T-ok" });
		expect(fetcher).toHaveBeenCalledTimes(2);
		const uncertain = fixture();
		uncertain.fetcher.mockImplementation(async () => json({}, 503));
		await expect(uncertain.client.start(start)).rejects.toBeInstanceOf(OrbUnreachableError);
		await expect(uncertain.client.start(start)).rejects.toMatchObject({ code: "orb_start_uncertain" });
		expect(uncertain.fetcher).toHaveBeenCalledTimes(1);
	});
	it("honors Retry-After, bounds retries, and maps a missing thread", async () => {
		let now = 0;
		const { client, fetcher } = fixture({ now: () => now });
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
		fetcher.mockResolvedValue(json({}, 404));
		await expect(client.state("missing")).rejects.toBeInstanceOf(OrbLostError);
	});
});
