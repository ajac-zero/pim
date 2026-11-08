// The `stream` observer, in Node: on a fake clock with a fake launcher for lines, bounds, delivery and lifecycle, on a few tiny real children for what only a real process group and pipe show, and inside the real runtime for the order of what the space hears. Nothing here reaches the network, and every real child is the test's own and ends within seconds.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildExit } from "../computer/triggers-adapters/poll";
import {
	NodeStreamLauncher,
	STREAM_LIMITS,
	StreamAdapter,
	type StreamAdapterOptions,
	type StreamChild,
	type StreamChildEvents,
	checkStreamSource,
} from "../computer/triggers-adapters/stream";
import {
	type AdapterHealth,
	type ComputerSource,
	type DesiredSource,
	type Emit,
	type EmitResult,
	type EndCoverage,
	HARD_LIMITS,
	ObservationSpool,
	type Observed,
	PROTOCOL,
	type RuntimeClock,
	TriggersRuntime,
	sourceConfigHash,
} from "../computer/triggers-runtime";
import { TRIGGER_LIMITS } from "../src/triggers/spec";

const T0 = Date.UTC(2026, 10, 7);
const SECRET = "s3cr3t-stream-output";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pim-triggers-stream-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/** A clock whose timers run only when a test moves it; between timers it lets promises, and the runtime, settle. */
class FakeClock implements RuntimeClock {
	time = T0;
	#timers: { at: number; order: number; run: () => void; cancelled: boolean }[] = [];
	#order = 0;
	idle: () => Promise<void> = async () => {};
	now = () => this.time;
	setTimer = (ms: number, run: () => void) => {
		const timer = { at: this.time + ms, order: this.#order++, run, cancelled: false };
		this.#timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	};
	get pending(): number {
		return this.#timers.filter((timer) => !timer.cancelled).length;
	}
	async settle(): Promise<void> {
		for (let round = 0; round < 4; round++) {
			await new Promise((resolve) => setImmediate(resolve));
			await this.idle();
		}
	}
	async advance(ms: number): Promise<void> {
		const until = this.time + ms;
		for (let fired = 0; ; fired++) {
			if (fired > 10_000) throw new Error("timers never settle");
			await this.settle();
			this.#timers = this.#timers.filter((timer) => !timer.cancelled);
			const next = this.#timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at || a.order - b.order)[0];
			if (!next) break;
			this.#timers.splice(this.#timers.indexOf(next), 1);
			this.time = Math.max(this.time, next.at);
			next.run();
		}
		this.time = until;
		await this.settle();
	}
}

class FakeChild implements StreamChild {
	signals: string[] = [];
	paused = false;
	released = false;
	exited = false;
	constructor(
		readonly request: { command: string; cwd: string | null },
		readonly events: StreamChildEvents,
	) {}
	signal(name: "SIGTERM" | "SIGKILL"): boolean {
		if (this.exited) return false;
		this.signals.push(name);
		return true;
	}
	pauseOutput(): void {
		this.paused = true;
	}
	resumeOutput(): void {
		this.paused = false;
	}
	release(): void {
		this.released = true;
	}
	print(text: string | Uint8Array): void {
		this.events.stdout(typeof text === "string" ? Buffer.from(text) : text);
	}
	/** Exits, and its stdout ends after. */
	exit(result: Partial<ChildExit> = {}): void {
		this.exited = true;
		this.events.exit({ code: 0, signal: null, failed: false, cleaned: true, ...result });
		this.events.stdoutEnd();
	}
}

class FakeLauncher {
	children: FakeChild[] = [];
	fail = false;
	launch = (request: { command: string; cwd: string | null }, events: StreamChildEvents): StreamChild => {
		if (this.fail) throw new Error("spawn failed");
		const child = new FakeChild(request, events);
		this.children.push(child);
		return child;
	};
	get last(): FakeChild {
		const child = this.children.at(-1);
		if (!child) throw new Error("no child");
		return child;
	}
}

const streamSource = (overrides: Partial<Extract<ComputerSource, { kind: "stream" }>> = {}): ComputerSource => ({ kind: "stream", command: "watch-the-thing", cwd: "/srv", ...overrides });

/** What an adapter emitted and reported, with the runtime's answers scripted, or held until a test releases them. */
class Sink {
	emits: Observed[] = [];
	reports: AdapterHealth[] = [];
	results: (EmitResult | Error | Promise<EmitResult>)[] = [];
	emit: Emit = async (observed) => {
		this.emits.push(structuredClone(observed));
		const next = this.results.shift() ?? { ok: true, eventId: "e", duplicate: false };
		if (next instanceof Error) throw next;
		return next;
	};
	health = (report: AdapterHealth) => this.reports.push(report);
	codes(): string[] {
		return this.reports.map((report) => report.code);
	}
	data(): unknown[] {
		return this.emits.map((observed) => observed.data);
	}
	keys(): string[] {
		return this.emits.map((observed) => observed.key as string);
	}
}

function held(): { promise: Promise<EmitResult>; resolve: (result: EmitResult) => void } {
	let resolve: (result: EmitResult) => void = () => {};
	const promise = new Promise<EmitResult>((done) => (resolve = done));
	return { promise, resolve };
}

async function startStream(options: Partial<StreamAdapterOptions> = {}, endCoverage?: EndCoverage) {
	const clock = new FakeClock();
	const launcher = new FakeLauncher();
	const sink = new Sink();
	const abort = new AbortController();
	const adapter = new StreamAdapter({ launcher, clock, ...options });
	await adapter.start({ triggerId: "t1", sourceId: "t1#1", generation: 1, source: streamSource(), resume: null, signal: abort.signal, ...(endCoverage ? { endCoverage } : {}) }, sink.emit, sink.health);
	return { clock, launcher, sink, abort, adapter };
}

const nested = (levels: number): unknown => {
	let value: unknown = 1;
	for (let level = 0; level < levels; level++) value = { a: value };
	return value;
};
/** An object whose JSON is exactly `bytes` long. */
const sized = (bytes: number) => ({ s: "x".repeat(bytes - 8) });

describe("stream lines", () => {
	it("reads the space's bounds, and runs nothing until start has returned", async () => {
		expect(STREAM_LIMITS.commandLength).toBe(TRIGGER_LIMITS.commandLength);
		expect(STREAM_LIMITS.dataBytes).toBe(HARD_LIMITS.dataBytes);
		expect(JSON.stringify(sized(16_384)).length).toBe(16_384);
		for (const [source, code] of [
			[{ kind: "poll", command: "x", cwd: null, intervalMs: 60_000, deadlineMs: 1_000 }, "stream_wrong_kind"],
			[streamSource({ command: "  " }), "stream_command_invalid"],
			[streamSource({ command: "x".repeat(4_001) }), "stream_command_invalid"],
			[streamSource({ cwd: "relative" }), "stream_cwd_invalid"],
			[streamSource({ cwd: "/a\0b" }), "stream_cwd_invalid"],
		] as [ComputerSource, string][]) {
			expect(() => checkStreamSource(source)).toThrow(code);
		}
		expect(() => new StreamAdapter({ launcher: new FakeLauncher(), graceMs: 5_000, reapMs: 5_000 })).toThrow(RangeError);
		expect(() => new StreamAdapter({ launcher: new FakeLauncher(), graceMs: 2_000, reapMs: 2_000, stopTimeoutMs: 4_100 })).toThrow(RangeError);

		const { clock, launcher } = await startStream();
		expect(launcher.children).toEqual([]);
		await clock.advance(0);
		expect(launcher.last.request).toEqual({ command: "watch-the-thing", cwd: "/srv" });
	});

	it("takes lines split anywhere, inside a character or a CRLF, each when its newline came, under one invocation's keys", async () => {
		const { clock, launcher, sink } = await startStream();
		await clock.advance(0);
		const child = launcher.last;
		const text = Buffer.from('{"a":"é€"}\r\n\n  \r\n{"b":2}\n{"c":[1,{"d":null}]}\r\n{"e":true}');
		// Cut inside the two-byte é, the three-byte €, between \r and \n, and in the middle of the last record.
		const cuts = [7, 9, 13, 14, 30, text.length - 4];
		let from = 0;
		for (const cut of [...cuts, text.length]) {
			child.print(text.subarray(from, cut));
			from = cut;
			await clock.advance(10);
		}
		expect(sink.data()).toEqual([{ a: "é€" }, { b: 2 }, { c: [1, { d: null }] }]);
		// Each line is dated by when its newline arrived: the first two with the fifth chunk, the third with the sixth.
		expect(sink.emits.map((observed) => observed.occurredAt - T0)).toEqual([40, 40, 50]);
		expect(sink.emits.every((observed) => observed.checkpoint === null)).toBe(true);
		const [nonce] = /^stream:([0-9a-f-]{36}):0$/.exec(sink.keys()[0] as string)?.slice(1) ?? [];
		expect(sink.keys()).toEqual([0, 1, 2].map((n) => `stream:${nonce}:${n}`));

		// The record with no newline counts only once the command has ended by itself.
		expect(sink.reports).toEqual([]);
		child.exit();
		await clock.advance(0);
		expect(sink.data().at(-1)).toEqual({ e: true });
		expect(sink.keys().at(-1)).toBe(`stream:${nonce}:3`);
		expect(sink.reports).toEqual([{ status: "error", code: "stream_ended" }]);
		expect(child.released).toBe(true);

		// Another invocation of the same command is another stream, whose keys can't be this one's.
		const other = await startStream();
		await other.clock.advance(0);
		other.launcher.last.print('{"a":"é€"}\n');
		await other.clock.advance(0);
		expect(other.sink.keys()[0]).not.toBe(sink.keys()[0]);
		expect(other.sink.keys()[0]).toMatch(/:0$/);
	});

	it("ends the stream at the first line that can't be an event, and emits nothing after it", async () => {
		const cases: [string | Uint8Array, string][] = [
			["not json", "stream_invalid_output"],
			['[{"a":1}]', "stream_invalid_output"],
			['"text"', "stream_invalid_output"],
			['{"a":1} {"b":2}', "stream_invalid_output"],
			['{"big":1e999}', "stream_invalid_output"],
			[JSON.stringify(nested(9)), "stream_invalid_output"],
			[JSON.stringify({ many: Array(STREAM_LIMITS.dataValues).fill(0) }), "stream_invalid_output"],
			[Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), "stream_invalid_output"],
			[JSON.stringify(sized(16_385)), "stream_event_too_large"],
			[`{"a":${" ".repeat(STREAM_LIMITS.lineBytes)}1}`, "stream_line_too_large"],
		];
		for (const [line, code] of cases) {
			const { clock, launcher, sink } = await startStream();
			await clock.advance(0);
			const child = launcher.last;
			child.print(Buffer.concat([Buffer.from('{"before":1}\n'), Buffer.from(line), Buffer.from('\n{"after":1}\n')]));
			await clock.advance(0);
			child.print('{"later":1}\n');
			await clock.advance(0);
			expect(sink.data(), code).toEqual([{ before: 1 }]);
			expect(sink.codes()).toEqual([code]);
			expect(child.signals).toEqual(["SIGTERM"]);
		}

		// At the bounds, a line is an event.
		const { clock, launcher, sink } = await startStream();
		await clock.advance(0);
		launcher.last.print(`${JSON.stringify(nested(8))}\n${JSON.stringify(sized(16_384))}\n`);
		await clock.advance(0);
		expect(sink.data()).toEqual([nested(8), sized(16_384)]);
		expect(sink.reports).toEqual([]);

		// A line still being printed past its bound ends the stream as soon as it passes it, not when its newline comes.
		const long = await startStream();
		await long.clock.advance(0);
		long.launcher.last.print('{"before":1}\n{"a":"');
		long.launcher.last.print("x".repeat(STREAM_LIMITS.lineBytes));
		await long.clock.advance(0);
		expect(long.sink.data()).toEqual([{ before: 1 }]);
		expect(long.sink.codes()).toEqual(["stream_line_too_large"]);
		expect(long.launcher.last.signals).toEqual(["SIGTERM"]);

		// A record left without a newline at the command's own end must be whole.
		const cut = await startStream();
		await cut.clock.advance(0);
		cut.launcher.last.print('{"a":1}\n{"b":');
		cut.launcher.last.exit();
		await cut.clock.advance(0);
		expect(cut.sink.data()).toEqual([{ a: 1 }]);
		expect(cut.sink.codes()).toEqual(["stream_ended", "stream_invalid_output"]);
	});

	it("holds what it reads within its buffers: the command waits on its pipe, and one that doesn't ends the stream", async () => {
		const { clock, launcher, sink } = await startStream();
		await clock.advance(0);
		const child = launcher.last;
		const first = held();
		sink.results.push(first.promise);
		const line = `${JSON.stringify({ pad: "y".repeat(1_000) })}\n`;
		const lines = Math.ceil(STREAM_LIMITS.readHighBytes / line.length) + 1;
		for (let n = 0; n < lines; n++) child.print(line);
		await clock.advance(0);
		// One event waits on the runtime; the rest is held as bytes, and reading has stopped.
		expect(sink.emits).toHaveLength(1);
		expect(child.paused).toBe(true);
		first.resolve({ ok: true, eventId: "e", duplicate: false });
		await clock.advance(0);
		expect(sink.emits).toHaveLength(lines);
		expect(child.paused).toBe(false);

		// A launcher that goes on delivering past the buffer: the stream ends, and what was read whole before it is still emitted.
		const over = await startStream();
		await over.clock.advance(0);
		const stuck = held();
		over.sink.results.push(stuck.promise);
		over.launcher.last.print('{"n":0}\n{"n":1}\n{"partial":');
		over.launcher.last.print(Buffer.alloc(STREAM_LIMITS.bufferBytes, 0x20));
		await over.clock.advance(0);
		expect(over.sink.codes()).toEqual(["stream_output_overflow"]);
		expect(over.launcher.last.signals).toEqual(["SIGTERM"]);
		over.launcher.last.print('{"n":2}\n');
		stuck.resolve({ ok: true, eventId: "e", duplicate: false });
		await over.clock.advance(0);
		expect(over.sink.data()).toEqual([{ n: 0 }, { n: 1 }]);
	});

	it("counts stderr and drops it, and ends a stream that floods it", async () => {
		const { clock, launcher, sink } = await startStream();
		await clock.advance(0);
		const child = launcher.last;
		child.events.stderr(Buffer.alloc(STREAM_LIMITS.stderrBytes, 0x61));
		await clock.advance(STREAM_LIMITS.stderrWindowMs);
		child.events.stderr(Buffer.alloc(STREAM_LIMITS.stderrBytes, 0x61));
		child.print('{"ok":1}\n{"cut":');
		await clock.advance(0);
		expect(sink.reports).toEqual([]);
		child.events.stderr(Buffer.from(SECRET));
		await clock.advance(0);
		expect(sink.codes()).toEqual(["stream_stderr_flood"]);
		expect(child.signals).toEqual(["SIGTERM"]);
		// The record being printed is dropped with the stream; its end at exit is not taken.
		child.print('1}\n');
		child.exit({ code: 143 });
		await clock.advance(0);
		expect(sink.data()).toEqual([{ ok: 1 }]);
		expect(JSON.stringify([sink.reports, sink.emits])).not.toContain(SECRET);
	});
});

describe("stream delivery", () => {
	it("keeps an event the runtime couldn't take yet and emits it again, the same event, before any later line", async () => {
		const { clock, launcher, sink } = await startStream();
		await clock.advance(0);
		sink.results.push({ ok: false, reason: "not_started" }, { ok: false, reason: "spool_unavailable" }, new Error("spool"));
		launcher.last.print('{"n":0}\n{"n":1}\n');
		await clock.advance(0);
		expect(sink.emits).toHaveLength(1);
		await clock.advance(999);
		expect(sink.emits).toHaveLength(1);
		await clock.advance(1);
		await clock.advance(2_000);
		await clock.advance(4_000);
		expect(sink.data()).toEqual([{ n: 0 }, { n: 0 }, { n: 0 }, { n: 0 }, { n: 1 }]);
		const keys = sink.keys();
		expect(new Set(keys.slice(0, 4)).size).toBe(1);
		expect(keys[4]).not.toBe(keys[0]);
		expect(new Set(sink.emits.slice(0, 4).map((observed) => observed.occurredAt)).size).toBe(1);
		expect(sink.reports).toEqual([]);
	});

	it("on backpressure keeps the event, reads nothing more, and emits it again only once resumed", async () => {
		const { clock, launcher, sink, adapter } = await startStream();
		await clock.advance(0);
		const child = launcher.last;
		sink.results.push({ ok: false, reason: "backpressure" });
		child.print('{"n":0}\n{"n":1}\n');
		await clock.advance(0);
		expect(child.paused).toBe(true);
		await clock.advance(600_000);
		expect(sink.data()).toEqual([{ n: 0 }]);
		adapter.resume();
		await clock.advance(0);
		expect(sink.data()).toEqual([{ n: 0 }, { n: 0 }, { n: 1 }]);
		expect(sink.keys()[1]).toBe(sink.keys()[0]);
		expect(child.paused).toBe(false);

		// The runtime pauses it and resumes it while a refusal is still on its way: the resume counts, and it isn't left waiting.
		const answer = held();
		sink.results.push(answer.promise);
		child.print('{"n":2}\n');
		await clock.advance(0);
		adapter.pause();
		expect(child.paused).toBe(true);
		adapter.resume();
		answer.resolve({ ok: false, reason: "backpressure" });
		await clock.advance(0);
		expect(sink.data().slice(3)).toEqual([{ n: 2 }, { n: 2 }]);
		expect(child.paused).toBe(false);
	});

	it("ends the stream before an event the runtime refuses for good", async () => {
		for (const [reason, code] of [
			["too_large", "stream_event_too_large"],
			["invalid", "stream_event_refused"],
		] as const) {
			const { clock, launcher, sink } = await startStream();
			await clock.advance(0);
			sink.results.push({ ok: true, eventId: "e", duplicate: false }, { ok: false, reason });
			launcher.last.print('{"n":0}\n{"n":1}\n{"n":2}\n');
			await clock.advance(500);
			expect(sink.data()).toEqual([{ n: 0 }, { n: 1 }]);
			expect(sink.codes()[0]).toBe(code);
			expect(launcher.last.signals).toEqual(["SIGTERM"]);
		}
	});
});

describe("stream lifecycle", () => {
	it("runs its command once, never again, and says how and when it ended until it is stopped", async () => {
		for (const [end, code] of [
			[{ code: 0 }, "stream_ended"],
			[{ code: 3 }, "stream_failed"],
			[{ code: null, signal: "SIGTERM" }, "stream_failed"],
			[{ failed: true }, "stream_spawn_failed"],
		] as [Partial<ChildExit>, string][]) {
			const { clock, launcher, sink, adapter } = await startStream();
			await clock.advance(0);
			launcher.last.exit(end);
			await clock.advance(3_600_000);
			expect(launcher.children).toHaveLength(1);
			// Said again after 1, 2, 4, 8, 16 and 32 seconds, then once a minute: the runtime drops health before installation and while disconnected.
			expect(new Set(sink.codes())).toEqual(new Set([code]));
			expect(sink.reports.length).toBeGreaterThan(55);
			expect(sink.reports.length).toBeLessThan(70);
			await adapter.stop("shutdown");
			const count = sink.reports.length;
			await clock.advance(3_600_000);
			expect(sink.reports).toHaveLength(count);
			expect(clock.pending).toBe(0);
		}

		const failed = await startStream();
		failed.launcher.fail = true;
		await failed.clock.advance(0);
		expect(failed.sink.codes()).toEqual(["stream_spawn_failed"]);

		// A command that closes its output and runs on is ended: it can print no more events.
		const closed = await startStream();
		await closed.clock.advance(0);
		closed.launcher.last.print('{"n":0}\n');
		closed.launcher.last.events.stdoutEnd();
		await closed.clock.advance(999);
		expect(closed.sink.reports).toEqual([]);
		await closed.clock.advance(1);
		expect(closed.sink.codes()).toEqual(["stream_output_closed"]);
		expect(closed.launcher.last.signals).toEqual(["SIGTERM"]);
		expect(closed.sink.data()).toEqual([{ n: 0 }]);

		// Its leader exited, and something outside its group still holds its output open: read for `drainMs`, then let go.
		const unclosed = await startStream({ drainMs: 500 });
		await unclosed.clock.advance(0);
		const child = unclosed.launcher.last;
		child.print('{"n":0}\n{"n":');
		child.exited = true;
		child.events.exit({ code: 0, signal: null, failed: false, cleaned: true });
		child.print('1}\n{"n":2');
		await unclosed.clock.advance(500);
		child.print("}\n");
		await unclosed.clock.advance(0);
		expect(unclosed.sink.data()).toEqual([{ n: 0 }, { n: 1 }]);
		expect(unclosed.sink.codes()).toEqual(["stream_ended", "stream_output_unclosed"]);
		expect(child.released).toBe(true);
		expect(child.signals).toEqual([]);
	});

	it("fences at stop and abort, during output and a slow emission, and ends only its own child within its bound", async () => {
		const { clock, launcher, sink, adapter } = await startStream({ graceMs: 100, reapMs: 100 });
		await clock.advance(0);
		const child = launcher.last;
		const slow = held();
		sink.results.push(slow.promise);
		child.print('{"n":0}\n{"n":1}\n');
		await clock.advance(0);
		let stopped = false;
		void adapter.stop("not_desired").then(() => (stopped = true));
		expect(child.signals).toEqual(["SIGTERM"]);
		slow.resolve({ ok: false, reason: "not_started" });
		child.print('{"n":2}\n');
		child.events.stderr(Buffer.alloc(STREAM_LIMITS.stderrBytes + 1));
		await clock.advance(100);
		expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
		await clock.advance(100);
		expect(stopped).toBe(false);
		// It won't die: stop returns within grace, reaping and slack, and says nothing.
		await clock.advance(100);
		expect(stopped).toBe(true);
		expect(child.released).toBe(true);
		expect(sink.data()).toEqual([{ n: 0 }]);
		expect(sink.reports).toEqual([]);
		child.exit({ cleaned: false });
		await clock.advance(600_000);
		expect(sink.reports).toEqual([]);
		expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(clock.pending).toBe(0);

		// Abort fences before stop is called, and a child that exits on SIGTERM ends the wait.
		const aborted = await startStream();
		await aborted.clock.advance(0);
		aborted.sink.results.push({ ok: false, reason: "spool_unavailable" });
		aborted.launcher.last.print('{"n":0}\n');
		await aborted.clock.advance(0);
		aborted.abort.abort();
		expect(aborted.launcher.last.signals).toEqual(["SIGTERM"]);
		await aborted.clock.advance(60_000);
		expect(aborted.sink.emits).toHaveLength(1);
		const stopping = aborted.adapter.stop("lease_expired");
		aborted.launcher.last.exit({ code: 143 });
		await stopping;
		expect(aborted.sink.reports).toEqual([]);

		// Stopped before its command started: nothing ever runs.
		const early = await startStream();
		await early.adapter.stop("not_desired");
		await early.clock.advance(60_000);
		expect(early.launcher.children).toEqual([]);
	});

	it("never signals once its leader is reaped, and an unknown cleanup stays the last word", async () => {
		const { clock, launcher, sink, adapter } = await startStream();
		await clock.advance(0);
		const child = launcher.last;
		const slow = held();
		sink.results.push(slow.promise);
		child.print('{"n":0}\n{"n":1}\n');
		await clock.advance(0);
		child.exit({ code: null, signal: "SIGKILL", cleaned: false });
		await clock.advance(0);
		expect(sink.codes()).toEqual(["stream_cleanup_unknown"]);
		// What it read before is still emitted; nothing is started again or signalled.
		slow.resolve({ ok: true, eventId: "e", duplicate: false });
		adapter.pause();
		adapter.resume();
		await clock.advance(3_600_000);
		expect(sink.data()).toEqual([{ n: 0 }, { n: 1 }]);
		expect(new Set(sink.codes())).toEqual(new Set(["stream_cleanup_unknown"]));
		await adapter.stop("shutdown");
		expect(child.signals).toEqual([]);
		expect(launcher.children).toHaveLength(1);

		// A child that outlives SIGKILL is reported unreaped, and once reaped, the end is said again.
		const stuck = await startStream({ graceMs: 100, reapMs: 100 });
		await stuck.clock.advance(0);
		stuck.launcher.last.print("oops\n");
		await stuck.clock.advance(200);
		expect(stuck.sink.codes()).toEqual(["stream_invalid_output", "stream_unreaped"]);
		stuck.launcher.last.exit({ code: null, signal: "SIGKILL", cleaned: true });
		await stuck.clock.advance(0);
		expect(stuck.sink.codes()).toEqual(["stream_invalid_output", "stream_unreaped", "stream_invalid_output"]);
		expect(stuck.launcher.last.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("says where coverage ended through the runtime's endCoverage, once everything before the end is emitted", async () => {
		const ends: { at: number; code: string }[] = [];
		const answers: Awaited<ReturnType<EndCoverage>>[] = ["unavailable", "recorded"];
		const endCoverage: EndCoverage = async (end) => {
			ends.push(end);
			return answers.shift() ?? "recorded";
		};
		const { clock, launcher, sink } = await startStream({}, endCoverage);
		await clock.advance(0);
		const slow = held();
		sink.results.push(slow.promise);
		launcher.last.print('{"n":0}\n{"n":1}\n');
		await clock.advance(5);
		launcher.last.exit();
		await clock.advance(5);
		expect(ends).toEqual([]);
		slow.resolve({ ok: true, eventId: "e", duplicate: false });
		await clock.advance(0);
		expect(sink.data()).toEqual([{ n: 0 }, { n: 1 }]);
		expect(ends).toEqual([{ at: T0 + 5, code: "stream_ended" }]);
		await clock.advance(1_000);
		await clock.advance(600_000);
		expect(ends).toEqual([
			{ at: T0 + 5, code: "stream_ended" },
			{ at: T0 + 5, code: "stream_ended" },
		]);
		// Said again once, a second after the end, while it wasn't yet recorded; once it is, health doesn't repeat it.
		expect(sink.codes()).toEqual(["stream_ended", "stream_ended"]);
		expect(clock.pending).toBe(0);

		// `stopped` fences it: nothing more is reported.
		const fenced = await startStream({}, async () => "stopped");
		await fenced.clock.advance(0);
		fenced.launcher.last.exit({ code: 1 });
		await fenced.clock.advance(600_000);
		expect(fenced.sink.codes()).toEqual(["stream_failed"]);
	});

	it("asks one end at a time, tries again while not installed, and drops a late answer after stop", async () => {
		// Not installed yet, then refused as invalid: nothing more is asked, and health keeps saying it.
		const answers: Awaited<ReturnType<EndCoverage>>[] = ["not_started", "invalid"];
		let calls = 0;
		const refused = await startStream({}, async () => {
			calls++;
			return answers.shift() ?? "recorded";
		});
		await refused.clock.advance(0);
		refused.launcher.last.exit();
		await refused.clock.advance(0);
		expect(calls).toBe(1);
		await refused.clock.advance(1_000);
		expect(calls).toBe(2);
		await refused.clock.advance(600_000);
		expect(calls).toBe(2);
		expect(new Set(refused.sink.codes())).toEqual(new Set(["stream_ended"]));
		expect(refused.sink.reports.length).toBeGreaterThan(10);

		// An answer held across pause, resume and stop: asked once, and what comes after stop changes nothing.
		let answer: (result: Awaited<ReturnType<EndCoverage>>) => void = () => {};
		let asked = 0;
		const { clock, launcher, sink, adapter } = await startStream({}, () => {
			asked++;
			return new Promise((resolve) => (answer = resolve));
		});
		await clock.advance(0);
		launcher.last.exit({ code: 2 });
		await clock.advance(0);
		adapter.pause();
		adapter.resume();
		await clock.advance(5_000);
		expect(asked).toBe(1);
		const reports = sink.reports.length;
		await adapter.stop("lease_expired");
		answer("recorded");
		await clock.advance(600_000);
		expect(asked).toBe(1);
		expect(sink.reports).toHaveLength(reports);
		expect(clock.pending).toBe(0);
	});
});

describe("stream on real children", () => {
	type Real = { adapter: StreamAdapter; sink: Sink; until: (done: () => boolean) => Promise<void> };
	function realStream(command: string, options: { results?: Sink["results"]; kill?: (pid: number, signal: NodeJS.Signals) => void; env?: Record<string, string>; cwd?: string } = {}): Real {
		const sink = new Sink();
		sink.results.push(...(options.results ?? []));
		const launcher = new NodeStreamLauncher({ defaultCwd: dir, ...(options.kill ? { kill: options.kill } : {}), ...(options.env ? { env: options.env } : {}) });
		const adapter = new StreamAdapter({ launcher, graceMs: 200, reapMs: 500, drainMs: 200 });
		void adapter.start({ triggerId: "t1", sourceId: "t1#1", generation: 1, source: streamSource({ command, cwd: options.cwd ?? null }), resume: null, signal: new AbortController().signal }, sink.emit, sink.health);
		const until = async (done: () => boolean) => {
			for (let tries = 0; tries < 1_200 && !done(); tries++) await new Promise((resolve) => setTimeout(resolve, 25));
			if (!done()) throw new Error("timed out");
		};
		return { adapter, sink, until };
	}
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	async function gone(pid: number): Promise<boolean> {
		for (let tries = 0; tries < 1_200 && alive(pid); tries++) await new Promise((resolve) => setTimeout(resolve, 25));
		return !alive(pid);
	}
	async function pidFrom(file: string): Promise<number> {
		for (let tries = 0; tries < 1_200; tries++) {
			const text = await fs.readFile(file, "utf8").catch(() => "");
			if (/^\d+\n$/.test(text)) return Number(text);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("no pid");
	}

	it("emits each line a real command prints, in order, with only the allowed environment, and says when it ended", async () => {
		process.env.PIM_COMPUTER_TOKEN = SECRET;
		try {
			const real = realStream(`printf '{"n":1}\\r\\n{"s":"é"}\\n'; sleep 0.1; printf '{"token":"%s","cwd":"%s"}' "\${PIM_COMPUTER_TOKEN:-none}" "$(pwd)"`);
			await real.until(() => real.sink.reports.length > 0 && real.sink.emits.length === 3);
			expect(real.sink.data()).toEqual([{ n: 1 }, { s: "é" }, { token: "none", cwd: await fs.realpath(dir) }]);
			expect(real.sink.codes()).toEqual(["stream_ended"]);
			await real.adapter.stop("shutdown");

			const missing = realStream(`printf '{"n":1}\\n'`, { cwd: path.join(dir, "missing") });
			await missing.until(() => missing.sink.reports.length > 0);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(missing.sink.codes()).toEqual(["stream_spawn_failed"]);
			expect(missing.sink.emits).toEqual([]);
			await missing.adapter.stop("shutdown");
		} finally {
			delete process.env.PIM_COMPUTER_TOKEN;
		}
	});

	it("holds a command that prints faster than its events are taken on its pipe, then ends its group on stop", async () => {
		const never = new Promise<EmitResult>(() => {});
		const memory = process.memoryUsage().rss;
		const real = realStream(`echo $$ > leader.pid; sleep 20 & echo $! > owned.pid; yes '{"y":1}' | head -c 200000000; wait`, { results: [never] });
		const owned = await pidFrom(path.join(dir, "owned.pid"));
		await real.until(() => real.sink.emits.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(real.sink.reports).toEqual([]);
		expect(real.sink.emits).toHaveLength(1);
		expect(process.memoryUsage().rss - memory).toBeLessThan(64 * 1_048_576);
		const bystander = spawn("sleep", ["20"], { stdio: "ignore" });
		try {
			await real.adapter.stop("not_desired");
			expect(await gone(owned)).toBe(true);
			expect(alive(bystander.pid as number)).toBe(true);
		} finally {
			bystander.kill("SIGKILL");
		}
	});

	it("sends nothing once its leader is reaped, keeps stderr out of everything, and can't vouch for a group whose leader was killed", async () => {
		const kills: [number, string][] = [];
		const log = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
		try {
			const quiet = realStream(`echo ${SECRET} >&2; sleep 20 & echo $! > left.pid; printf '{"ok":1}\\n'`, { kill: (pid, signal) => void kills.push([pid, signal]) });
			await quiet.until(() => quiet.sink.reports.length > 0 && quiet.sink.emits.length === 1);
			expect(quiet.sink.codes()).toEqual(["stream_ended"]);
			// The leader's own `kill -9 0` took what it left behind; nothing was sent from here, and stop sends nothing after the reap.
			expect(await gone(await pidFrom(path.join(dir, "left.pid")))).toBe(true);
			await quiet.adapter.stop("shutdown");
			expect(kills).toEqual([]);
			// The launcher itself refuses to signal a reaped leader's group.
			const launcher = new NodeStreamLauncher({ defaultCwd: dir, kill: (pid, signal) => void kills.push([pid, signal]) });
			const reaped = await new Promise<StreamChild>((resolve) => {
				const child: StreamChild = launcher.launch({ command: "exit 0", cwd: null }, { stdout: () => {}, stdoutEnd: () => {}, stderr: () => {}, exit: () => resolve(child) });
			});
			expect(reaped.signal("SIGTERM")).toBe(false);
			expect(reaped.signal("SIGKILL")).toBe(false);
			expect(kills).toEqual([]);
			expect(JSON.stringify([quiet.sink.reports, quiet.sink.emits])).not.toContain(SECRET);
			for (const spy of log) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of log) spy.mockRestore();
		}

		const killed = realStream(`echo $$ > shell.pid; sleep 20 & echo $! > orphan.pid; printf '{"a":1}\\n'; sleep 0.2; kill -9 $PPID; wait`, { kill: (pid, signal) => void kills.push([pid, signal]) });
		const shell = await pidFrom(path.join(dir, "shell.pid"));
		const orphan = await pidFrom(path.join(dir, "orphan.pid"));
		try {
			await killed.until(() => killed.sink.reports.length > 0);
			expect(killed.sink.codes()).toEqual(["stream_cleanup_unknown"]);
			expect(killed.sink.data()).toEqual([{ a: 1 }]);
			await killed.adapter.stop("shutdown");
			expect(kills).toEqual([]);
			expect(alive(orphan)).toBe(true);
		} finally {
			for (const pid of [orphan, shell]) process.kill(pid, "SIGKILL");
		}
	});
});

describe("stream in the runtime", () => {
	type Frame = Record<string, any>;
	const desired = (source: ComputerSource, generation = 1): DesiredSource => ({
		triggerId: "s",
		sourceId: "s#1",
		revision: 1,
		generation,
		configHash: sourceConfigHash(source),
		source,
		grant: { grantRef: "approval-1", scopeHash: "a".repeat(64) },
		checkpoint: null,
	});

	async function runtime(spoolOptions: { maxEntries?: number } = {}) {
		const clock = new FakeClock();
		const launcher = new FakeLauncher();
		const frames: Frame[] = [];
		/** What the runtime answered each emission. */
		const results: string[] = [];
		/** While set, writes of gaps wait for it. */
		const gate: { held: Promise<void> | null } = { held: null };
		const open = async (connection: string) => {
			const spool = await ObservationSpool.open(path.join(dir, "spool"), {
				...spoolOptions,
				write: async (handle, data) => {
					if (gate.held && data.includes('"kind":"gap"')) await gate.held;
					await handle.write(data, 0, data.length);
					await handle.datasync();
				},
			});
			const rt = new TriggersRuntime({
				binding: { space: "space-1", runtimeId: "rt-1" },
				spool,
				adapters: () => {
					const inner = new StreamAdapter({ launcher, clock });
					return {
						start: (config, emit, health) =>
							inner.start(
								config,
								async (observed) => {
									const result = await emit(observed);
									results.push(result.ok ? "ok" : result.reason);
									return result;
								},
								health,
							),
						stop: (reason) => inner.stop(reason),
						pause: () => inner.pause(),
						resume: () => inner.resume(),
					};
				},
				authorize: () => ({ ok: true }),
				clock,
			});
			clock.idle = () => rt.idle();
			rt.attach({ send: (frame) => frames.push(JSON.parse(frame)) > 0 }, connection);
			return rt;
		};
		const send = async (rt: TriggersRuntime, connection: string, message: Record<string, unknown>) => {
			await rt.receive(connection, JSON.stringify({ protocol: PROTOCOL, connectionId: connection, serverEpoch: 1, ...message }));
			await clock.advance(0);
		};
		const reconcile = (rt: TriggersRuntime, connection: string, generation = 1, revision = 1) =>
			send(rt, connection, { type: "reconcile", binding: { space: "space-1", runtimeId: "rt-1" }, desiredRevision: revision, leaseMs: 120_000, sources: [desired(streamSource(), generation)] });
		const ack = (rt: TriggersRuntime, connection: string, entries: Frame[]) =>
			send(rt, connection, { type: "ack", durable: true, results: entries.map((frame) => ({ sequence: frame.sequence, eventId: frame.eventId, result: "accepted" })) });
		const of = (type: string) => frames.filter((frame) => frame.type === type);
		/** Closes the runtime, whose stop waits on the fake clock for a fake child that won't exit. */
		const close = async (rt: TriggersRuntime) => {
			const closing = rt.close();
			await clock.advance(5_000);
			await closing;
		};
		return { clock, launcher, frames, results, gate, open, reconcile, ack, of, close };
	}

	it("is installed, with its coverage gap, before its first event; lines printed before then wait; a restart can't replay them", async () => {
		const h = await runtime();
		const rt = await h.open("c1");
		// The coverage gap's write is held, so the command runs, once start has returned, and prints before the runtime has installed it.
		let release = () => {};
		h.gate.held = new Promise<void>((resolve) => (release = resolve));
		const idle = h.clock.idle;
		h.clock.idle = async () => {};
		const receiving = rt.receive(
			"c1",
			JSON.stringify({ protocol: PROTOCOL, type: "reconcile", binding: { space: "space-1", runtimeId: "rt-1" }, connectionId: "c1", serverEpoch: 1, desiredRevision: 1, leaseMs: 120_000, sources: [desired(streamSource())] }),
		);
		// The reconcile's own write isn't held: wait, in real time, for it and for the command to start.
		for (let tries = 0; tries < 400 && h.launcher.children.length === 0; tries++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			await h.clock.advance(0);
		}
		h.launcher.last.print('{"n":0}\n{"n":1}\n');
		await h.clock.advance(0);
		expect(h.results).toEqual(["not_started"]);
		expect(h.of("installed")).toEqual([]);
		h.gate.held = null;
		release();
		h.clock.idle = idle;
		await receiving;
		await h.clock.advance(2_000);
		expect(h.results).toEqual(["not_started", "ok", "ok"]);
		// Installed before anything it observed, and its coverage gap sent no later than the first event, with a lower sequence.
		const order = h.frames.filter((frame) => frame.triggerId === "s").map((frame) => (frame.type === "health" ? `health:${frame.code}` : frame.type));
		expect(order.filter((type) => type !== "gap")).toEqual(["installed", "health:listening", "observation", "observation"]);
		expect(order.indexOf("gap")).toBeLessThan(order.indexOf("observation"));
		const gap = h.of("gap")[0] as Frame;
		const observations = h.of("observation");
		expect(gap.reasons).toEqual({ coverage_unknown: 1 });
		expect(observations.map((frame) => frame.data)).toEqual([{ n: 0 }, { n: 1 }]);
		expect(observations.map((frame) => frame.checkpoint)).toEqual([null, null]);
		expect(gap.sequence).toBeLessThan(observations[0]?.sequence);
		expect(observations[0]?.sequence).toBeLessThan(observations[1]?.sequence);

		// A new connection, same runtime: the spool sends the same events again; the adapter takes no part.
		const first = observations.map((frame) => frame.eventId);
		h.frames.length = 0;
		rt.attach({ send: (frame) => h.frames.push(JSON.parse(frame)) > 0 }, "c2");
		await h.reconcile(rt, "c2");
		await h.clock.advance(100);
		expect(h.of("observation").map((frame) => frame.eventId)).toEqual(first);
		expect(h.launcher.children).toHaveLength(1);

		// A restart runs the command again: a new stream, whose lines are new events, after a gap that says coverage is unknown.
		await h.close(rt);
		h.frames.length = 0;
		const again = await h.open("c3");
		await h.reconcile(again, "c3");
		h.launcher.last.print('{"n":0}\n');
		await h.clock.advance(2_000);
		expect(h.launcher.children).toHaveLength(2);
		const fresh = h.of("observation").filter((frame) => !first.includes(frame.eventId));
		expect(fresh.map((frame) => frame.data)).toEqual([{ n: 0 }]);
		expect(h.of("gap").map((frame) => frame.reasons)).toContainEqual({ coverage_unknown: 1 });
		await h.close(again);
	});

	it("on a full spool keeps the refused event, which a gap counts, and delivers it, and every line after, once resumed", async () => {
		const h = await runtime({ maxEntries: 8 });
		const rt = await h.open("c1");
		await h.reconcile(rt, "c1");
		await h.clock.advance(2_000);
		h.launcher.last.print(Array.from({ length: 8 }, (_, n) => `{"n":${n}}\n`).join(""));
		await h.clock.advance(1_000);
		const health = () => h.of("health").map((frame) => frame.code);
		expect(health()).toEqual(["listening", "backpressure"]);
		const sent = h.of("observation");
		expect(sent.map((frame) => frame.data)).toEqual([0, 1, 2, 3, 4].map((n) => ({ n })));
		expect(h.launcher.last.paused).toBe(true);
		await h.clock.advance(60_000);
		// Sent again while unsettled, but nothing new.
		expect(new Set(h.of("observation").map((frame) => frame.eventId))).toEqual(new Set(sent.map((frame) => frame.eventId)));

		await h.ack(rt, "c1", [...h.of("gap"), ...sent]);
		await h.clock.advance(1_000);
		expect(health()).toEqual(["listening", "backpressure", "resumed"]);
		const all = [...new Map(h.of("observation").map((frame) => [frame.eventId, frame])).values()].sort((a, b) => a.sequence - b.sequence);
		expect(all.map((frame) => frame.data)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ n })));
		// The runtime counted the refusal as an overflow, though the event came after all: the gap marks the episode, and over-counts it by that one.
		const gaps = [...new Map(h.of("gap").map((frame) => [frame.eventId, frame.reasons])).values()];
		expect(gaps).toEqual([{ coverage_unknown: 1 }, { overflow: 1 }]);
		await h.close(rt);
	});

	/** Each frame once, by event id, in sequence order. */
	const unique = (frames: Frame[]) => [...new Map(frames.map((frame) => [frame.eventId, frame])).values()].sort((a, b) => a.sequence - b.sequence);

	it("makes a stream's end durable after its last event, and never runs the same generation's command again", async () => {
		const h = await runtime();
		const rt = await h.open("c1");
		await h.reconcile(rt, "c1");
		await h.clock.advance(2_000);
		h.launcher.last.print('{"n":0}\n{"n":1}\n');
		await h.clock.advance(10);
		const endedAt = h.clock.now();
		h.launcher.last.exit({ code: 3 });
		await h.clock.advance(1_000);
		const sent = unique([...h.of("observation"), ...h.of("gap")]);
		expect(sent.map((frame) => (frame.type === "gap" ? Object.keys(frame.reasons)[0] : frame.data.n))).toEqual(["coverage_unknown", 0, 1, "interrupted"]);
		expect(sent.at(-1)).toMatchObject({ from: endedAt, generation: 1 });
		expect(h.of("stopped")).toMatchObject([{ reason: "ended" }]);
		expect(h.of("health").map((frame) => frame.code)).toContain("stream_failed");

		// The same generation again, on this runtime and after a restart: ended, and the command isn't run.
		await h.reconcile(rt, "c1", 1, 2);
		expect(h.of("reconciled").at(-1)?.sources).toMatchObject([{ state: "ended" }]);
		await h.close(rt);
		const again = await h.open("c2");
		await h.reconcile(again, "c2");
		await h.clock.advance(60_000);
		expect(h.of("reconciled").at(-1)?.sources).toMatchObject([{ state: "ended" }]);
		expect(h.launcher.children).toHaveLength(1);
		// A new generation is the space asking again: the command runs anew.
		await h.reconcile(again, "c2", 2, 2);
		expect(h.launcher.children).toHaveLength(2);
		await h.close(again);
	});

	it("records an end that came before installation once it is installed, after the events printed before it", async () => {
		const h = await runtime();
		const rt = await h.open("c1");
		let release = () => {};
		h.gate.held = new Promise<void>((resolve) => (release = resolve));
		const idle = h.clock.idle;
		h.clock.idle = async () => {};
		const receiving = rt.receive(
			"c1",
			JSON.stringify({ protocol: PROTOCOL, type: "reconcile", binding: { space: "space-1", runtimeId: "rt-1" }, connectionId: "c1", serverEpoch: 1, desiredRevision: 1, leaseMs: 120_000, sources: [desired(streamSource())] }),
		);
		for (let tries = 0; tries < 400 && h.launcher.children.length === 0; tries++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			await h.clock.advance(0);
		}
		h.launcher.last.print('{"n":0}\n');
		h.launcher.last.exit();
		await h.clock.advance(0);
		expect(h.of("installed")).toEqual([]);
		h.gate.held = null;
		release();
		h.clock.idle = idle;
		await receiving;
		await h.clock.advance(3_000);
		const sent = unique([...h.of("observation"), ...h.of("gap")]);
		expect(sent.map((frame) => (frame.type === "gap" ? Object.keys(frame.reasons)[0] : frame.data.n))).toEqual(["coverage_unknown", 0, "interrupted"]);
		// Coverage is counted as broken from the installation at the latest: the gap before it already covers what came first.
		expect(sent[2]?.from).toBe(sent[0]?.to);
		expect(h.of("reconciled").at(-1)?.sources).toMatchObject([{ state: "starting" }]);
		await h.reconcile(rt, "c1", 1, 2);
		expect(h.of("reconciled").at(-1)?.sources).toMatchObject([{ state: "ended" }]);
		await h.close(rt);
	});

	it("waits for an event held by backpressure before closing coverage, and counts coverage from the pause if stopped first", async () => {
		const h = await runtime({ maxEntries: 8 });
		const rt = await h.open("c1");
		await h.reconcile(rt, "c1");
		await h.clock.advance(2_000);
		const pausedAt = h.clock.now();
		h.launcher.last.print(Array.from({ length: 8 }, (_, n) => `{"n":${n}}\n`).join(""));
		h.launcher.last.exit();
		await h.clock.advance(30_000);
		// Ended, and said so, but its coverage isn't closed while an event it read before the end waits.
		expect(h.of("health").map((frame) => frame.code)).toEqual(expect.arrayContaining(["backpressure", "stream_ended"]));
		expect(unique(h.of("gap")).map((frame) => frame.reasons)).toEqual([{ coverage_unknown: 1 }, { overflow: 1 }]);
		await h.ack(rt, "c1", [...unique(h.of("gap")), ...unique(h.of("observation"))]);
		await h.clock.advance(2_000);
		const sent = unique([...h.of("observation"), ...h.of("gap")]);
		expect(sent.filter((frame) => frame.type === "observation").map((frame) => frame.data.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(sent.at(-1)).toMatchObject({ type: "gap", reasons: { interrupted: 1 }, from: pausedAt });
		await h.close(rt);

		// The same, never resumed: the lease ends it, and the next generation's gap starts at the pause, not at the stop.
		await fs.rm(path.join(dir, "spool"), { recursive: true });
		const stuck = await runtime({ maxEntries: 8 });
		const rt2 = await stuck.open("c1");
		await stuck.reconcile(rt2, "c1");
		await stuck.clock.advance(2_000);
		const pause = stuck.clock.now();
		stuck.launcher.last.print(Array.from({ length: 8 }, (_, n) => `{"n":${n}}\n`).join(""));
		stuck.launcher.last.exit();
		await stuck.clock.advance(150_000);
		expect(stuck.of("stopped")).toMatchObject([{ reason: "lease_expired" }]);
		await stuck.ack(rt2, "c1", [...unique(stuck.of("gap")), ...unique(stuck.of("observation"))]);
		await stuck.reconcile(rt2, "c1", 2, 2);
		await stuck.clock.advance(2_000);
		expect(unique(stuck.of("gap")).filter((frame) => "interrupted" in frame.reasons)).toMatchObject([{ generation: 2, from: pause }]);
		await stuck.close(rt2);
	});
});
