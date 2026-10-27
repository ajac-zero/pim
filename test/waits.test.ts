import { describe, expect, it, vi } from "vitest";
import { type Budget, Cancelled, CleanupNotObserved, label, owned, ownedBy, owner, Waits } from "./waits";

/**
 * The tests' record of waits (./waits.ts) on its own, with a signal each
 * test aborts itself where the runner would abort a test that ran out of
 * time, and scopes it owns code by itself where the tests' hooks
 * (test/helpers.ts) would. Nothing here reaches a space, a browser or a
 * process; the "effects" are entries in an array.
 */

const BUDGET: Budget = { tasks: 1_000, cleanup: 1_000 };
const SHORT: Budget = { tasks: 50, cleanup: 50 };

/** What `settle` rejected with, or null. */
const failureOf = (settling: Promise<void>) =>
	settling.then(
		() => null,
		(error: unknown) => error as CleanupNotObserved,
	);

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
		await waits.settle(BUDGET);
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

		await waits.settle(BUDGET);
		expect(steps).toEqual(["started", "finished"]);
		expect(await held).toBe("done");
		expect(JSON.parse(waits.report())).toMatchObject({ closed: true, open: [], shut: [], done: [{ label: "held work" }] });
	});

	it("counts a socket closed only once its close event is seen, not once its close was asked for", async () => {
		const waits = new Waits("test", new AbortController().signal);
		const { 0: client, 1: server } = new WebSocketPair();
		server.accept();
		client.accept();
		const closed = waits.start("server's close event", () => new Promise<CloseEvent>((resolve) => server.addEventListener("close", resolve)));
		// Nothing closed it yet: the deadline passes with the close unseen.
		await expect(waits.settle(SHORT)).rejects.toThrow(/server's close event/);

		client.close(1000, "Done");
		expect((await closed).code).toBe(1000);
		await waits.settle(BUDGET);
	});

	it("fails, naming it, when work the test started hasn't finished by the deadline", async () => {
		const waits = new Waits("test", new AbortController().signal);
		void waits.start("never answered", () => new Promise<never>(() => undefined));
		void waits.start("answered", async () => "yes");
		const failure = await failureOf(waits.settle(SHORT));
		expect(failure).toBeInstanceOf(CleanupNotObserved);
		expect(failure!.unfinished).toEqual(["never answered"]);
		expect(failure!.failed).toEqual([]);
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

	it("keeps a continuation of a test that ran out of time to that test, so it starts nothing and sets no model answer under the next test", async () => {
		/** Stands in for scripting the model's answers: what each scope's work set. */
		const answers: string[] = [];
		const answer = (who: string) => async () => {
			answers.push(who);
			return who;
		};
		const first = new AbortController();
		const earlier = new Waits("test", first.signal);
		let resume = () => undefined as void;
		const resumed = new Promise<void>((resolve) => {
			resume = () => resolve();
		});
		// A continuation of the earlier test, and a poll's timer it set, each asking whichever scope owns it when it runs.
		const continuation = ownedBy(earlier, async () => {
			await resumed;
			return owned().start("model answer", answer("earlier"));
		});
		const poll = ownedBy(earlier, () => new Promise<string>((resolve) => setTimeout(() => resolve((async () => owned().start("poll", answer("earlier poll")))()), 20)));
		first.abort(new Error("Test timed out"));

		const later = new Waits("test", new AbortController().signal);
		await ownedBy(later, async () => {
			expect(owner()).toBe(later);
			resume();
			await expect(continuation).rejects.toBeInstanceOf(Cancelled);
			await expect(poll).rejects.toBeInstanceOf(Cancelled);
			expect(await owned().start("its own work", answer("later"))).toBe("later");
		});
		expect(answers).toEqual(["later"]);
		await earlier.settle(BUDGET);
		await later.settle(BUDGET);
		expect(JSON.parse(later.report()).done).toEqual([{ label: "its own work", ms: expect.any(Number) }]);
		// Code no scope owns starts nothing.
		expect(() => owned()).toThrow(/outside any setup, test or cleanup/);
	});

	it("refuses work a task asks for while its test settles, and fails naming work a task left running", async () => {
		const settling = new Waits("test", new AbortController().signal);
		const { opened } = settling.gate("fixture");
		const child = vi.fn(async () => "child ran");
		const parent = settling.start("parent", async () => {
			await opened;
			return owned().start("child", child);
		});
		// The gate opens only once the scope has closed: the child is asked for after that, and refused.
		await settling.settle(BUDGET);
		await expect(parent).rejects.toBeInstanceOf(Cancelled);
		expect(child).not.toHaveBeenCalled();
		expect(() => settling.gate("after")).toThrow(Cancelled);
		expect(() => settling.defer("after", () => undefined)).toThrow(Cancelled);

		// A child started before settling, and left running by its parent, is waited for, and named when it doesn't finish.
		const orphaning = new Waits("test", new AbortController().signal);
		expect(
			await orphaning.start("parent", () => {
				void owned().start("child left running", () => new Promise<never>(() => undefined));
				return "parent done";
			}),
		).toBe("parent done");
		const failure = await failureOf(orphaning.settle(SHORT));
		expect(failure).toBeInstanceOf(CleanupNotObserved);
		expect(failure!.unfinished).toEqual(["child left running"]);
	});

	it("runs a test's cleanup after it ran out of time, in a scope that admits the cleanup's work and not the test's", async () => {
		const timeout = new AbortController();
		const waits = new Waits("test", timeout.signal);
		const effects: string[] = [];
		const effect = (what: string) => async () => void effects.push(what);
		let resume = () => undefined as void;
		const resumed = new Promise<void>((resolve) => {
			resume = () => resolve();
		});
		await waits.start("change", effect("changed"));
		waits.defer("undo", () => {
			resume();
			return owned().start("restore", effect("restored"));
		});
		const dismiss = waits.defer("undone already", effect("dismissed cleanup ran"));
		dismiss();
		// The test's own continuation, resumed by the cleanup while it runs.
		const stale = ownedBy(waits, async () => {
			await resumed;
			return owned().start("after the test", effect("stale work ran"));
		});
		timeout.abort(new Error("Test timed out"));
		await expect(waits.start("more", effect("more ran"))).rejects.toBeInstanceOf(Cancelled);

		await waits.settle(BUDGET);
		await expect(stale).rejects.toBeInstanceOf(Cancelled);
		expect(effects).toEqual(["changed", "restored"]);
		expect(JSON.parse(waits.report()).cleanup).toEqual([]);
	});

	it("fails naming cleanup that hangs, isn't reached, or fails, and runs cleanup last registered first", async () => {
		const order: string[] = [];
		const waits = new Waits("test", new AbortController().signal);
		waits.defer("registered first", () => void order.push("first"));
		waits.defer("hangs", () => new Promise<never>(() => undefined));
		waits.defer("registered last", () => void order.push("last"));
		const failure = await failureOf(waits.settle(SHORT));
		expect(failure).toBeInstanceOf(CleanupNotObserved);
		expect(order).toEqual(["last"]);
		expect(failure!.unfinished).toEqual(["cleanup not started: registered first", "cleanup: hangs"]);

		const failing = new Waits("test", new AbortController().signal);
		const broken = new Error("undo failed");
		failing.defer("undo", () => Promise.reject(broken));
		const failed = await failureOf(failing.settle(BUDGET));
		expect(failed).toBeInstanceOf(CleanupNotObserved);
		expect([failed!.unfinished, failed!.failed, failed!.cause]).toEqual([[], ["undo"], broken]);
	});
});
