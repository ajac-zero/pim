import { describe, expect, it } from "vitest";
import { CallPhases } from "../src/model-phases.ts";

/** A clock the test moves, and a response whose body the test releases. */
function setup() {
	let now = 1_000;
	const phases = new CallPhases(now, () => now);
	return { phases, advance: (ms: number) => (now += ms) };
}

const sse = (chunks: string[], hold: () => Promise<void>) =>
	new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = chunks.shift();
			if (next === undefined) return controller.close();
			await hold();
			controller.enqueue(new TextEncoder().encode(next));
		},
	});

describe("CallPhases", () => {
	it("says time went to the response headers when a gateway answers 524 only after them", async () => {
		const { phases, advance } = setup();
		advance(40);
		const fetch = phases.fetch(async () => {
			advance(125_000);
			return new Response("<html>timeout</html>", { status: 524, headers: { "cf-ray": "abc-LHR", "content-type": "text/html", "set-cookie": "secret=1", authorization: "Bearer nope" } });
		});
		const response = await fetch("https://gateway.example/v1/messages?beta=true", { method: "POST", headers: { "x-api-key": "sk-secret", authorization: "Bearer sk-secret", "anthropic-beta": "a-1,b-2", "content-type": "application/json" }, body: JSON.stringify({ stream: true }) });
		expect(await response.text()).toBe("<html>timeout</html>");
		const done = phases.finish();
		expect(done).toMatchObject({ preFetchMs: 40, httpAttempts: 1, headersMs: 125_000, totalMs: 125_040 });
		expect(done.attempts).toEqual([expect.objectContaining({ attempt: 1, status: 524, headersMs: 125_000, cfRay: "abc-LHR", contentType: "text/html" })]);
		expect(done.wire).toEqual({ method: "POST", headerNames: ["anthropic-beta", "authorization", "content-type", "x-api-key"], headers: { "anthropic-beta": "a-1,b-2", "content-type": "application/json" }, bodyBytes: 15 });
		const text = JSON.stringify(done);
		for (const leaked of ["sk-secret", "nope", "secret=1", "gateway.example"]) expect(text).not.toContain(leaked);
	});

	it("says time went to the stream when the headers were quick and the body stalled", async () => {
		const { phases, advance } = setup();
		let release: () => void = () => {};
		const fetch = phases.fetch(async () => {
			advance(300);
			return new Response(sse(["data: 1\n\n", "data: 2\n\n"], () => new Promise<void>((resolve) => (release = resolve))), { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		const response = await fetch("https://x.test", {});
		const reader = response.body!.getReader();
		const first = reader.read();
		await new Promise((resolve) => setTimeout(resolve, 0));
		advance(2_000);
		release();
		await first;
		phases.event();
		const second = reader.read();
		await new Promise((resolve) => setTimeout(resolve, 0));
		advance(120_000);
		release();
		await second;
		await reader.read();
		const done = phases.finish();
		expect(done).toMatchObject({ httpAttempts: 1, headersMs: 300, firstByteMs: 2_000, firstEventMs: 2_000, streamMs: 120_000 });
		expect(done.attempts[0]).toMatchObject({ status: 200, bodyMs: 122_000 });
	});

	it("counts every request a call sent, and a request that never got an answer", async () => {
		const { phases, advance } = setup();
		let n = 0;
		const fetch = phases.fetch(async () => {
			advance(60_000);
			if (++n === 3) throw Object.assign(new Error("boom"), { name: "TimeoutError" });
			return new Response("busy", { status: 529 });
		});
		await (await fetch("https://x.test", {})).text();
		await (await fetch("https://x.test", {})).text();
		await expect(fetch("https://x.test", {})).rejects.toThrow("boom");
		const done = phases.finish();
		expect(done.httpAttempts).toBe(3);
		expect(done.attempts.map((attempt) => [attempt.status, attempt.error])).toEqual([[529, undefined], [529, undefined], [null, "TimeoutError"]]);
		expect(done.headersMs).toBe(60_000);
		expect(done.firstEventMs).toBeNull();
	});

	it("reports no phases for a call that never reached fetch", () => {
		const { phases } = setup();
		expect(phases.finish()).toMatchObject({ preFetchMs: null, httpAttempts: 0, headersMs: null, streamMs: null, attempts: [] });
	});
});
