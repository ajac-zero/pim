import { describe, expect, it, vi } from "vitest";
import { Cancelled, CleanupNotObserved, label, Waits } from "./waits";

/**
 * The tests' record of waits (./waits.ts) on its own, with a signal each
 * test aborts itself where the runner would abort a test that ran out of
 * time. Nothing here reaches a space, a browser or a process.
 */

describe("a test's waits", () => {
	it("starts nothing once the test has run out of time, and starts work before then", async () => {
		const timeout = new AbortController();
		const waits = new Waits("test", timeout.signal);
		const before = vi.fn(async () => "ran");
		expect(await waits.start("before", before)).toBe("ran");
		expect(before).toHaveBeenCalledTimes(1);

		timeout.abort(new Error("Test timed out"));
		const after = vi.fn(async () => "ran");
		await expect(waits.start("after", after)).rejects.toBeInstanceOf(Cancelled);
		expect(after).not.toHaveBeenCalled();
		await waits.settle(1_000);
	});

	it("doesn't stop work already started when the test runs out of time, and lets it finish once its gate opens", async () => {
		const timeout = new AbortController();
		const waits = new Waits("test", timeout.signal);
		const { opened } = waits.gate("handshake");
		const steps: string[] = [];
		const held = waits.start("held work", async () => {
			steps.push("started");
			await opened;
			steps.push("finished");
			return "done";
		});
		timeout.abort(new Error("Test timed out"));
		expect(JSON.parse(waits.report())).toMatchObject({ open: [{ label: "held work" }], shut: ["handshake"] });
		expect(steps).toEqual(["started"]);

		await waits.settle(1_000);
		expect(steps).toEqual(["started", "finished"]);
		expect(await held).toBe("done");
		expect(JSON.parse(waits.report())).toMatchObject({ open: [], shut: [], done: [{ label: "held work" }] });
	});

	it("counts a socket closed only once its close event is seen, not once its close was asked for", async () => {
		const waits = new Waits("test", new AbortController().signal);
		const { 0: client, 1: server } = new WebSocketPair();
		server.accept();
		client.accept();
		const closed = waits.start("server's close event", () => new Promise<CloseEvent>((resolve) => server.addEventListener("close", resolve)));
		// Nothing closed it yet: the deadline passes with the close unseen.
		await expect(waits.settle(50)).rejects.toThrow(/server's close event/);

		client.close(1000, "Done");
		expect((await closed).code).toBe(1000);
		await waits.settle(1_000);
	});

	it("fails, naming it, when work the test started hasn't finished by the deadline", async () => {
		const waits = new Waits("test", new AbortController().signal);
		void waits.start("never answered", () => new Promise<never>(() => undefined));
		void waits.start("answered", async () => "yes");
		const failure = await waits.settle(50).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(CleanupNotObserved);
		expect((failure as CleanupNotObserved).unfinished).toEqual(["never answered"]);
	});

	it("passes on what it watches unchanged, and keeps IDs, tokens and length out of its labels", async () => {
		const waits = new Waits("test");
		const refused = new Error("refused");
		await expect(waits.watch("refusal", Promise.reject(refused))).rejects.toBe(refused);
		expect(await waits.watch("answer", Promise.resolve(42))).toBe(42);

		expect(label("POST /api/approvals/0211776f-0bd6-46f6-b575-db7045607a0b/approve")).toBe("POST /api/approvals/:id/approve");
		expect(label("GET /api/spaces/o_0123456789abcdefghijklmnop")).toBe("GET /api/spaces/:id");
		expect(label("token cua-bridge-test-token-0123456789abcdef")).toBe("token :id");
		expect(label("x ".repeat(100))).toHaveLength(80);
	});
});
