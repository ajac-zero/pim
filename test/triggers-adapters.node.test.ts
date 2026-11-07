// The concrete trigger observers, `poll` and `process`, in Node: on a fake clock with a fake launcher and a fake provider for timing and lifecycle, on tiny real children and real receipts in a temporary folder for what only a real process shows, and inside the real runtime for the order of what the space hears. Nothing here reaches the network, and every real child is the test's own and ends within seconds.
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observerAdapters } from "../computer/triggers-adapters/index";
import { FileProcessProvider, LinuxProcessProbe, readManagedRecord, writeCompletionReceipt, writeLaunchIntent } from "../computer/triggers-adapters/managed";
import { type ChildEvents, type ChildExit, NodeChildLauncher, type OwnedChild, POLL_LIMITS, PollAdapter, type PollAdapterOptions, readPollOutput } from "../computer/triggers-adapters/poll";
import { type CompletionReceipt, type LaunchIntent, type Liveness, type ManagedProcessProvider, type ManagedRecord, PROCESS_WATCH, type ProcessIdentity, ProcessWatchAdapter } from "../computer/triggers-adapters/process";
import {
	type AdapterConfig,
	type AdapterHealth,
	type ComputerSource,
	type DesiredSource,
	type Emit,
	type EmitResult,
	ObservationSpool,
	type Observed,
	PROTOCOL,
	type RuntimeClock,
	TriggersRuntime,
	sourceConfigHash,
} from "../computer/triggers-runtime";
import { TRIGGER_DEFAULTS, TRIGGER_LIMITS } from "../src/triggers/spec";

const T0 = Date.UTC(2026, 10, 7);
const SECRET = "s3cr3t-poll-output";
const HANDLE = "0b5e3a52-6f0c-4c1e-9d3a-6a1f2b3c4d5e";
const BOOT = "11111111-2222-4333-8444-555555555555";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pim-triggers-adapters-"));
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
	/** Moves time on without running anything, as a computer that slept would; the timers due run late, on the next `advance`. */
	jump(ms: number): void {
		this.time += ms;
	}
}

class FakeChild implements OwnedChild {
	signals: string[] = [];
	released = false;
	exited = false;
	readonly at: number;
	constructor(
		readonly request: { command: string; cwd: string | null },
		readonly events: ChildEvents,
		clock: FakeClock,
	) {
		this.at = clock.now() - T0;
	}
	signal(name: "SIGTERM" | "SIGKILL"): boolean {
		if (this.exited) return false;
		this.signals.push(name);
		return true;
	}
	release(): void {
		this.released = true;
	}
	/** Prints `stdout` and exits. */
	finish(stdout: string | Uint8Array = "", result: Partial<ChildExit> = {}): void {
		if (stdout.length > 0) this.events.stdout(typeof stdout === "string" ? Buffer.from(stdout) : stdout);
		this.exited = true;
		this.events.exit({ code: 0, signal: null, failed: false, cleaned: true, ...result });
	}
}

class FakeLauncher {
	children: FakeChild[] = [];
	fail = false;
	constructor(readonly clock: FakeClock) {}
	launch = (request: { command: string; cwd: string | null }, events: ChildEvents): OwnedChild => {
		if (this.fail) throw new Error("spawn failed");
		const child = new FakeChild(request, events, this.clock);
		this.children.push(child);
		return child;
	};
	get last(): FakeChild {
		const child = this.children.at(-1);
		if (!child) throw new Error("no child");
		return child;
	}
}

function pollSource(overrides: Partial<Extract<ComputerSource, { kind: "poll" }>> = {}): ComputerSource {
	return { kind: "poll", command: "check-the-thing", cwd: "/srv", intervalMs: 60_000, deadlineMs: 30_000, ...overrides };
}

function adapterConfig(source: ComputerSource, signal = new AbortController().signal): AdapterConfig {
	return { triggerId: "t1", sourceId: "t1#1", generation: 1, source, resume: null, signal };
}

/** What an adapter emitted and reported, with the runtime's answers scripted. */
class Sink {
	emits: Observed[] = [];
	reports: AdapterHealth[] = [];
	results: EmitResult[] = [];
	emit: Emit = async (observed) => {
		this.emits.push(structuredClone(observed));
		return this.results.shift() ?? { ok: true, eventId: "e", duplicate: false };
	};
	health = (report: AdapterHealth) => this.reports.push(report);
	codes(): string[] {
		return this.reports.map((report) => report.code);
	}
}

async function startPoll(source: ComputerSource = pollSource(), options: Partial<PollAdapterOptions> = {}) {
	const clock = new FakeClock();
	const launcher = new FakeLauncher(clock);
	const sink = new Sink();
	const abort = new AbortController();
	const adapter = new PollAdapter({ launcher, clock, random: () => 0, ...options });
	await adapter.start(adapterConfig(source, abort.signal), sink.emit, sink.health);
	return { clock, launcher, sink, abort, adapter };
}

const nested = (levels: number): unknown => {
	let value: unknown = 1;
	for (let level = 0; level < levels; level++) value = { a: value };
	return value;
};

describe("poll timing", () => {
	it("reads the space's bounds, and refuses a source outside them before anything runs", async () => {
		expect(POLL_LIMITS.minIntervalMs).toBe(TRIGGER_DEFAULTS.pollMinIntervalMs);
		expect(POLL_LIMITS.defaultIntervalMs).toBe(TRIGGER_DEFAULTS.pollIntervalMs);
		expect(POLL_LIMITS.maxIntervalMs).toBe(TRIGGER_DEFAULTS.pollMaxIntervalMs);
		expect(POLL_LIMITS.minDeadlineMs).toBe(TRIGGER_DEFAULTS.pollMinDeadlineMs);
		expect(POLL_LIMITS.maxDeadlineMs).toBe(TRIGGER_DEFAULTS.pollDeadlineMs);
		expect(POLL_LIMITS.commandLength).toBe(TRIGGER_LIMITS.commandLength);
		const refused: [Partial<Extract<ComputerSource, { kind: "poll" }>>, string][] = [
			[{ intervalMs: 59_999 }, "poll_interval_out_of_bounds"],
			[{ intervalMs: 86_400_001 }, "poll_interval_out_of_bounds"],
			[{ deadlineMs: 999 }, "poll_deadline_out_of_bounds"],
			[{ deadlineMs: 30_001 }, "poll_deadline_out_of_bounds"],
			[{ command: "  " }, "poll_command_invalid"],
			[{ cwd: "relative/dir" }, "poll_cwd_invalid"],
		];
		for (const [overrides, code] of refused) {
			const clock = new FakeClock();
			const launcher = new FakeLauncher(clock);
			const sink = new Sink();
			await expect(new PollAdapter({ launcher, clock }).start(adapterConfig(pollSource(overrides)), sink.emit, sink.health)).rejects.toMatchObject({ code });
			await clock.advance(120_000);
			expect(launcher.children).toHaveLength(0);
		}
		const accepted = await startPoll(pollSource({ intervalMs: 60_000, deadlineMs: 30_000 }));
		await accepted.clock.advance(0);
		expect(accepted.launcher.children).toHaveLength(1);
	});

	it("polls nothing during start, then on a cadence anchored to the start, each slot with its own jitter", async () => {
		const jitters = [0.5, 0.25, 0, 0.9];
		const clock = new FakeClock();
		const launcher = new FakeLauncher(clock);
		const sink = new Sink();
		const adapter = new PollAdapter({ launcher, clock, random: () => jitters.shift() ?? 0 });
		await adapter.start(adapterConfig(pollSource()), sink.emit, sink.health);
		expect(launcher.children).toHaveLength(0);
		// A tenth of the interval at most: 6 s of jitter on 60 s.
		await clock.advance(2_999);
		expect(launcher.children).toHaveLength(0);
		await clock.advance(1);
		expect(launcher.children.map((child) => child.at)).toEqual([3_000]);
		// A poll that takes 20 s doesn't move the next slot.
		await clock.advance(20_000);
		launcher.last.finish('{"n":1}');
		await clock.advance(38_499);
		expect(launcher.children).toHaveLength(1);
		await clock.advance(1);
		launcher.last.finish('{"n":2}');
		await clock.advance(58_500);
		launcher.last.finish('{"n":3}');
		await clock.advance(65_400);
		launcher.last.finish('{"n":4}');
		await clock.advance(0);
		expect(launcher.children.map((child) => child.at)).toEqual([3_000, 61_500, 120_000, 185_400]);
		expect(launcher.last.request).toEqual({ command: "check-the-thing", cwd: "/srv" });
		expect(sink.emits.map((emitted) => emitted.data)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
		expect(sink.emits[0]?.occurredAt).toBe(T0 + 23_000);
		expect(sink.emits[0]?.checkpoint).toBeNull();
		await adapter.stop("shutdown");
	});

	it("never runs two at once, and after a late wake runs one poll, not the missed ones", async () => {
		const { clock, launcher, sink, adapter } = await startPoll(pollSource(), { graceMs: 2_000, reapMs: 2_000 });
		await clock.advance(0);
		const stuck = launcher.last;
		// Deadline, grace, then reaping all pass, and it still hasn't exited.
		await clock.advance(34_000);
		expect(stuck.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(sink.codes()).toEqual(["poll_unreaped"]);
		await clock.advance(130_000);
		expect(launcher.children).toHaveLength(1);
		stuck.finish("", { code: null, signal: "SIGKILL" });
		await clock.advance(16_000);
		expect(launcher.children.map((child) => child.at)).toEqual([0, 180_000]);
		launcher.last.finish("{}");
		await clock.advance(0);
		// The computer sleeps through three and a half intervals: one poll on waking, then the next slot still to come.
		clock.jump(210_000);
		await clock.advance(0);
		expect(launcher.children.map((child) => child.at)).toEqual([0, 180_000, 390_000]);
		expect(sink.codes()).toContain("poll_skipped");
		launcher.last.finish("{}");
		await clock.advance(29_999);
		expect(launcher.children).toHaveLength(3);
		await clock.advance(1);
		expect(launcher.children.map((child) => child.at)).toEqual([0, 180_000, 390_000, 420_000]);
		launcher.last.finish("{}");
		await adapter.stop("shutdown");
	});
});

describe("poll output and its child", () => {
	it("ends its child at the deadline with SIGTERM, then SIGKILL, and reports only a code", async () => {
		const { clock, launcher, sink, adapter } = await startPoll(pollSource({ deadlineMs: 5_000 }), { graceMs: 1_000 });
		await clock.advance(4_999);
		expect(launcher.last.signals).toEqual([]);
		await clock.advance(1);
		expect(launcher.last.signals).toEqual(["SIGTERM"]);
		await clock.advance(1_000);
		expect(launcher.last.signals).toEqual(["SIGTERM", "SIGKILL"]);
		launcher.last.finish(`{"late":"${SECRET}"}`, { code: null, signal: "SIGKILL" });
		await clock.advance(0);
		expect(sink.reports).toEqual([{ status: "degraded", code: "poll_timeout" }]);
		expect(sink.emits).toEqual([]);
		await adapter.stop("shutdown");
	});

	it("takes one JSON object of bounded size and depth, and nothing else", () => {
		const ok = (value: string) => readPollOutput(Buffer.from(value));
		expect(ok(' {"up": true}\n')).toEqual({ ok: true, data: { up: true } });
		expect(ok(JSON.stringify(nested(8)))).toMatchObject({ ok: true });
		expect(ok(JSON.stringify(nested(9)))).toEqual({ ok: false, code: "poll_invalid_output" });
		expect(ok(JSON.stringify({ s: "x".repeat(POLL_LIMITS.dataBytes - 8) }))).toMatchObject({ ok: true });
		expect(ok(JSON.stringify({ s: "x".repeat(POLL_LIMITS.dataBytes - 7) }))).toEqual({ ok: false, code: "poll_output_too_large" });
		expect(ok(JSON.stringify({ a: Array.from({ length: POLL_LIMITS.dataValues }, () => 0) }))).toEqual({ ok: false, code: "poll_invalid_output" });
		for (const refused of ["", "[1]", "3", '"text"', "null", '{"a":1}{"b":2}', '{"a":1} trailing', "{a:1}", "process.exit(1)"]) {
			expect(ok(refused)).toEqual({ ok: false, code: "poll_invalid_output" });
		}
		expect(readPollOutput(Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))).toEqual({ ok: false, code: "poll_invalid_output" });
		// An exponent too large parses as Infinity, which JSON would turn into null: refused, at any depth.
		for (const refused of ['{"value":1e999}', '{"value":-1e999}', '{"a":[{"b":[1,2,-1e400]}]}', `{"v":${"9".repeat(400)}}`]) {
			expect(ok(refused)).toEqual({ ok: false, code: "poll_invalid_output" });
		}
		expect(ok('{"small":1e-999,"big":1.7976931348623157e308}')).toEqual({ ok: true, data: { small: 0, big: 1.7976931348623157e308 } });
	});

	it("ends a child that prints too much, keeps nothing of stderr, and never reports what was printed", async () => {
		const log = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
		try {
			const { clock, launcher, sink, adapter } = await startPoll();
			await clock.advance(0);
			launcher.last.events.stdout(Buffer.alloc(POLL_LIMITS.stdoutBytes, 0x20));
			expect(launcher.last.signals).toEqual([]);
			launcher.last.events.stdout(Buffer.from(SECRET));
			expect(launcher.last.signals).toEqual(["SIGTERM"]);
			launcher.last.finish("", { code: null, signal: "SIGTERM" });
			await clock.advance(60_000);
			launcher.last.events.stderr(Buffer.from(SECRET.repeat(1_000)));
			expect(launcher.last.signals).toEqual(["SIGTERM"]);
			launcher.last.finish("", { code: null, signal: "SIGTERM" });
			await clock.advance(60_000);
			launcher.last.events.stderr(Buffer.from(`warning: ${SECRET}`));
			launcher.last.finish(`not json ${SECRET}`);
			await clock.advance(60_000);
			launcher.last.finish(`{"v":"${SECRET}"}`, { code: 2 });
			launcher.fail = true;
			await clock.advance(60_000);
			expect(sink.reports).toEqual([
				{ status: "degraded", code: "poll_output_too_large" },
				{ status: "degraded", code: "poll_output_too_large" },
				{ status: "degraded", code: "poll_invalid_output" },
				{ status: "degraded", code: "poll_failed" },
				{ status: "error", code: "poll_spawn_failed" },
			]);
			expect(sink.emits).toEqual([]);
			expect(JSON.stringify(sink.reports)).not.toContain(SECRET);
			for (const spy of log) expect(spy).not.toHaveBeenCalled();
			launcher.fail = false;
			await clock.advance(60_000);
			launcher.last.finish('{"fine":true}');
			await clock.advance(0);
			expect(sink.reports.at(-1)).toEqual({ status: "ok", code: "poll_ok" });
			await adapter.stop("shutdown");
		} finally {
			for (const spy of log) spy.mockRestore();
		}
	});
});

describe("poll delivery", () => {
	it("keeps an observation the runtime couldn't take yet, tries it again as the same event, and samples nothing newer meanwhile", async () => {
		const { clock, launcher, sink, adapter } = await startPoll();
		sink.results = [{ ok: false, reason: "not_started" }, ...Array.from({ length: 6 }, () => ({ ok: false, reason: "spool_unavailable" }) as const)];
		await clock.advance(0);
		launcher.last.finish('{"n":1}');
		// Tried again after 1, 2, 4, 8, 16 and 30 seconds: past the next slot, which is skipped.
		await clock.advance(61_000);
		expect(sink.emits).toHaveLength(7);
		expect(launcher.children).toHaveLength(1);
		await clock.advance(30_000);
		expect(sink.emits).toHaveLength(8);
		expect(new Set(sink.emits.map((emitted) => emitted.key)).size).toBe(1);
		expect(new Set(sink.emits.map((emitted) => emitted.occurredAt)).size).toBe(1);
		await clock.advance(28_999);
		expect(launcher.children).toHaveLength(1);
		await clock.advance(1);
		expect(launcher.children).toHaveLength(2);
		launcher.last.finish('{"n":2}');
		await clock.advance(0);
		expect(sink.emits.at(-1)?.data).toEqual({ n: 2 });
		expect(sink.emits.at(-1)?.key).not.toBe(sink.emits[0]?.key);
		await adapter.stop("shutdown");
	});

	it("polls nothing while paused, and on resume goes on with the next slot, not at once", async () => {
		const { clock, launcher, sink, adapter } = await startPoll();
		sink.results = [{ ok: false, reason: "backpressure" }];
		await clock.advance(0);
		launcher.last.finish('{"n":1}');
		await clock.advance(0);
		// The runtime counted it in an `overflow` gap; it is not emitted again.
		expect(sink.emits).toHaveLength(1);
		await clock.advance(300_000);
		expect(launcher.children).toHaveLength(1);
		adapter.resume();
		await clock.advance(0);
		expect(launcher.children).toHaveLength(1);
		expect(sink.emits).toHaveLength(1);
		await clock.advance(60_000);
		expect(launcher.children.map((child) => child.at)).toEqual([0, 360_000]);
		launcher.last.finish("{}");
		adapter.pause();
		await clock.advance(120_000);
		expect(launcher.children).toHaveLength(2);
		await adapter.stop("shutdown");
	});
});

describe("poll stop", () => {
	it("ends only its own child on stop, waits for it, and emits nothing after", async () => {
		const first = await startPoll();
		const other = await startPoll();
		await first.clock.advance(0);
		await other.clock.advance(0);
		let stopped = false;
		const stopping = first.adapter.stop("not_desired").then(() => (stopped = true));
		expect(first.launcher.last.signals).toEqual(["SIGTERM"]);
		await first.clock.advance(1_999);
		expect(stopped).toBe(false);
		await first.clock.advance(1);
		expect(first.launcher.last.signals).toEqual(["SIGTERM", "SIGKILL"]);
		first.launcher.last.finish(`{"after":"${SECRET}"}`, { code: null, signal: "SIGKILL" });
		await stopping;
		expect(first.launcher.last.released).toBe(true);
		await first.clock.advance(600_000);
		expect(first.launcher.children).toHaveLength(1);
		expect(first.sink.emits).toEqual([]);
		expect(first.sink.reports).toEqual([]);
		expect(other.launcher.last.signals).toEqual([]);
		other.launcher.last.finish("{}");
		await other.adapter.stop("shutdown");
	});

	it("returns from stop within its bound when its child won't die, and fences at abort before stop is called", async () => {
		const stuck = await startPoll(pollSource(), { graceMs: 100, reapMs: 100 });
		await stuck.clock.advance(0);
		let stopped = false;
		const stopping = stuck.adapter.stop("shutdown").then(() => (stopped = true));
		await stuck.clock.advance(299);
		expect(stopped).toBe(false);
		await stuck.clock.advance(1);
		await stopping;
		expect(stuck.launcher.last.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(stuck.launcher.last.released).toBe(true);

		const aborted = await startPoll();
		await aborted.clock.advance(0);
		aborted.abort.abort();
		expect(aborted.launcher.last.signals).toEqual(["SIGTERM"]);
		aborted.launcher.last.finish('{"n":1}');
		await aborted.clock.advance(600_000);
		expect(aborted.sink.emits).toEqual([]);
		expect(aborted.launcher.children).toHaveLength(1);

		const early = await startPoll(pollSource(), { random: () => 0.9 });
		await early.adapter.stop("not_desired");
		await early.clock.advance(600_000);
		expect(early.launcher.children).toHaveLength(0);
		expect(early.clock.pending).toBe(0);
	});

	it("keeps its stop within the runtime's stop bound", () => {
		const clock = new FakeClock();
		const launcher = new FakeLauncher(clock);
		expect(() => new PollAdapter({ launcher, graceMs: 5_000, reapMs: 4_899 })).not.toThrow();
		expect(() => new PollAdapter({ launcher, graceMs: 5_000, reapMs: 4_900 })).toThrow(RangeError);
		expect(() => new PollAdapter({ launcher, graceMs: 450, reapMs: 449, stopTimeoutMs: 1_000 })).not.toThrow();
		expect(() => new PollAdapter({ launcher, graceMs: 450, reapMs: 450, stopTimeoutMs: 1_000 })).toThrow(RangeError);
		expect(() => new PollAdapter({ launcher, stopTimeoutMs: 4_100 })).toThrow(RangeError);
	});

	it("drops what an emission in flight returns once stopped, and retries nothing", async () => {
		const { clock, launcher, sink, adapter } = await startPoll();
		let answer!: (result: EmitResult) => void;
		const emits: Observed[] = [];
		const slow: Emit = (observed) => {
			emits.push(observed);
			return new Promise((resolve) => (answer = resolve));
		};
		const gated = new PollAdapter({ launcher, clock, random: () => 0 });
		await gated.start(adapterConfig(pollSource()), slow, sink.health);
		await adapter.stop("shutdown");
		await clock.advance(0);
		launcher.last.finish('{"n":1}');
		await clock.advance(0);
		expect(emits).toHaveLength(1);
		await gated.stop("revoked");
		answer({ ok: false, reason: "spool_unavailable" });
		await clock.advance(600_000);
		expect(emits).toHaveLength(1);
		expect(clock.pending).toBe(0);
	});
});

describe("poll on real children", () => {
	type Real = { adapter: PollAdapter; sink: Sink; settled: Promise<void> };
	function realPoll(command: string, options: { deadlineMs?: number; env?: Record<string, string> } = {}): Real {
		const sink = new Sink();
		let settle = () => {};
		const settled = new Promise<void>((resolve) => (settle = resolve));
		const emit: Emit = async (observed) => {
			const result = await sink.emit(observed);
			settle();
			return result;
		};
		const health = (report: AdapterHealth) => {
			sink.health(report);
			settle();
		};
		const launcher = new NodeChildLauncher({ defaultCwd: dir, ...(options.env ? { env: options.env } : {}) });
		const adapter = new PollAdapter({ launcher, jitterRatio: 0, graceMs: 100, reapMs: 500 });
		void adapter.start(adapterConfig(pollSource({ command, cwd: null, deadlineMs: options.deadlineMs ?? 5_000 })), emit, health);
		return { adapter, sink, settled };
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
		for (let tries = 0; tries < 40 && alive(pid); tries++) await new Promise((resolve) => setTimeout(resolve, 25));
		return !alive(pid);
	}
	async function pidFrom(file: string): Promise<number> {
		for (let tries = 0; tries < 80; tries++) {
			const text = await fs.readFile(file, "utf8").catch(() => "");
			if (/^\d+\n$/.test(text)) return Number(text);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("no pid");
	}

	it("runs the command in its own folder with only the allowed environment, and kills what it leaves behind", async () => {
		process.env.PIM_COMPUTER_TOKEN = SECRET;
		try {
			const real = realPoll(`sleep 20 & echo $! > leftover.pid; printf '{"token":"%s","cwd":"%s"}' "\${PIM_COMPUTER_TOKEN:-none}" "$(pwd)"`);
			await real.settled;
			expect(real.sink.reports).toEqual([]);
			expect(real.sink.emits[0]?.data).toEqual({ token: "none", cwd: await fs.realpath(dir) });
			expect(await gone(await pidFrom(path.join(dir, "leftover.pid")))).toBe(true);
			await real.adapter.stop("shutdown");
		} finally {
			delete process.env.PIM_COMPUTER_TOKEN;
		}
	});

	it("kills its own group at the deadline and on stop, and leaves other processes alone", async () => {
		const bystander = spawn("sleep", ["20"], { stdio: "ignore" });
		try {
			const late = realPoll("sleep 20 & echo $! > late.pid; wait", { deadlineMs: 1_000 });
			const latePid = await pidFrom(path.join(dir, "late.pid"));
			await late.settled;
			expect(late.sink.reports).toEqual([{ status: "degraded", code: "poll_timeout" }]);
			expect(await gone(latePid)).toBe(true);
			await late.adapter.stop("shutdown");

			const stopped = realPoll("sleep 20 & echo $! > stopped.pid; wait");
			const stoppedPid = await pidFrom(path.join(dir, "stopped.pid"));
			await stopped.adapter.stop("not_desired");
			expect(await gone(stoppedPid)).toBe(true);
			expect(stopped.sink.emits).toEqual([]);
			expect(alive(bystander.pid as number)).toBe(true);
		} finally {
			bystander.kill("SIGKILL");
		}
	});

	it("never signals a group once its leader is reaped; the leader cleans up its own group first", async () => {
		const kills: [number, string][] = [];
		const launcher = new NodeChildLauncher({ defaultCwd: dir, kill: (pid, signal) => void kills.push([pid, signal]) });
		const run = (command: string) =>
			new Promise<{ result: ChildExit; child: OwnedChild }>((resolve) => {
				const child: OwnedChild = launcher.launch({ command, cwd: null }, { stdout: () => {}, stderr: () => {}, exit: (result) => resolve({ result, child }) });
			});
		const cases: [string, Partial<ChildExit>][] = [
			["exit 0", { code: 0, signal: null }],
			["exit 3", { code: 3, signal: null }],
			["kill -TERM $$", { code: 143, signal: null }],
			["sleep 20 & echo $! > owned.pid; exit 0", { code: 0, signal: null }],
		];
		for (const [command, expected] of cases) {
			const { result, child } = await run(command);
			expect(result).toMatchObject(expected);
			// Its leader is reaped: whatever pid its group had may be anyone's now, and nothing is sent to it.
			expect(child.signal("SIGKILL")).toBe(false);
			expect(child.signal("SIGTERM")).toBe(false);
		}
		expect(kills).toEqual([]);
		// The leftover in its group went with the leader's own `kill -9 0`.
		expect(await gone(await pidFrom(path.join(dir, "owned.pid")))).toBe(true);

		// Before reaping, a signal goes to its own group, by the leader's id; a group already gone is reported as not signalled.
		const throwing = new NodeChildLauncher({
			defaultCwd: dir,
			kill: (pid, signal) => {
				kills.push([pid, signal]);
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			},
		});
		let done = () => {};
		const exited = new Promise<void>((resolve) => (done = resolve));
		const live = throwing.launch({ command: "sleep 1", cwd: null }, { stdout: () => {}, stderr: () => {}, exit: () => done() });
		expect(live.signal("SIGTERM")).toBe(false);
		expect(kills).toHaveLength(1);
		expect(kills[0]?.[0]).toBeLessThan(0);
		await exited;
		expect(live.signal("SIGKILL")).toBe(false);
		expect(kills).toHaveLength(1);

		// A leader killed from outside before it cleaned up: its leftover is not signalled from here, and the exit says cleanup is unknown.
		const { result } = await run("sleep 20 & echo $! > orphan.pid; kill -9 $PPID");
		const orphan = await pidFrom(path.join(dir, "orphan.pid"));
		try {
			expect(result).toMatchObject({ code: null, signal: "SIGKILL", cleaned: false });
			expect(kills).toHaveLength(1);
			process.kill(orphan, 0);
		} finally {
			process.kill(orphan, "SIGKILL");
		}
	});

	it("stops for good when it can't vouch for its last child's cleanup", async () => {
		const { clock, launcher, sink, adapter } = await startPoll();
		await clock.advance(0);
		const first = launcher.last;
		first.finish('{"n":1}', { code: null, signal: "SIGKILL", cleaned: false });
		await clock.advance(0);
		// Its group's members may still run: no further child, no emission, and nothing reported after this.
		expect(sink.reports).toEqual([{ status: "error", code: "poll_cleanup_unknown" }]);
		await clock.advance(600_000);
		adapter.pause();
		await clock.advance(120_000);
		adapter.resume();
		await clock.advance(600_000);
		first.events.stdout(Buffer.from('{"late":true}'));
		first.events.exit({ code: 0, signal: null, failed: false, cleaned: true });
		await clock.advance(60_000);
		expect(launcher.children).toHaveLength(1);
		expect(sink.emits).toEqual([]);
		expect(sink.reports).toEqual([{ status: "error", code: "poll_cleanup_unknown" }]);
		expect(clock.pending).toBe(0);
		await adapter.stop("shutdown");
		expect(first.signals).toEqual([]);
		expect(clock.pending).toBe(0);

		// The same after a child it was ending: the timeout isn't reported over it either.
		const ended = await startPoll(pollSource({ deadlineMs: 1_000 }));
		await ended.clock.advance(1_000);
		ended.launcher.last.finish("", { code: null, signal: "SIGKILL", cleaned: false });
		await ended.clock.advance(600_000);
		expect(ended.sink.reports).toEqual([{ status: "error", code: "poll_cleanup_unknown" }]);
		expect(ended.launcher.children).toHaveLength(1);
	});

	it("keeps stderr out of what it reports, and out of the console", async () => {
		const log = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
		try {
			const real = realPoll(`echo ${SECRET} >&2; echo not-json-${SECRET}`);
			await real.settled;
			await real.adapter.stop("shutdown");
			expect(real.sink.reports).toEqual([{ status: "degraded", code: "poll_invalid_output" }]);
			expect(real.sink.emits).toEqual([]);
			for (const spy of log) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of log) spy.mockRestore();
		}
	});
});

const SUPERVISOR: ProcessIdentity = { bootId: BOOT, pid: 4242, startTime: "987654" };
const intent = (overrides: Partial<LaunchIntent> = {}): LaunchIntent => ({ version: 1, handle: HANDLE, supervisor: SUPERVISOR, launchedAt: T0 - 60_000, ...overrides });
const receipt = (overrides: Partial<CompletionReceipt> = {}): CompletionReceipt => ({ version: 1, handle: HANDLE, supervisor: SUPERVISOR, exitCode: 0, signal: null, endedAt: T0 + 1_000, ...overrides });

class FakeProvider implements ManagedProcessProvider {
	records = new Map<string, ManagedRecord>();
	liveness_: Liveness = "running";
	/** What the next read returns instead, once. */
	next: (ManagedRecord | null | Error)[] = [];
	/** Promises the next reads, and the next liveness checks, wait on before they answer. */
	holdReads: Promise<unknown>[] = [];
	holdChecks: Promise<unknown>[] = [];
	reads = 0;
	checks = 0;
	async read(handle: string): Promise<ManagedRecord | null> {
		this.reads++;
		const hold = this.holdReads.shift();
		if (hold) await hold;
		const next = this.next.shift();
		if (next instanceof Error) throw next;
		if (next !== undefined) return next;
		return this.records.get(handle) ?? null;
	}
	async liveness(_identity: ProcessIdentity): Promise<Liveness> {
		this.checks++;
		const hold = this.holdChecks.shift();
		if (hold) await hold;
		return this.liveness_;
	}
	set(record: ManagedRecord): void {
		this.records.set(record.intent.handle, record);
	}
}

function processSource(overrides: Partial<Extract<ComputerSource, { kind: "process" }>> = {}): ComputerSource {
	return { kind: "process", handle: HANDLE, expiresAt: T0 + PROCESS_WATCH.defaultMs, ...overrides };
}

async function startWatch(provider: ManagedProcessProvider, source = processSource(), clock = new FakeClock()) {
	const sink = new Sink();
	const abort = new AbortController();
	const adapter = new ProcessWatchAdapter({ provider, clock, checkMs: 1_000 });
	await adapter.start(adapterConfig(source, abort.signal), sink.emit, sink.health);
	return { clock, sink, abort, adapter };
}

describe("process watch", () => {
	it("starts only for a handle launched here, for at most seven days, and never by name", async () => {
		expect(PROCESS_WATCH.maxMs).toBe(TRIGGER_LIMITS.maxProcessWatchMs);
		const provider = new FakeProvider();
		provider.set({ intent: intent(), receipt: null });
		provider.set({ intent: { ...intent(), handle: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, receipt: null });
		const refused: [Partial<Extract<ComputerSource, { kind: "process" }>>, string][] = [
			[{ handle: "nightly-backup" }, "process_handle_invalid"],
			[{ handle: "4242" }, "process_handle_invalid"],
			[{ handle: HANDLE.toUpperCase() }, "process_handle_invalid"],
			[{ expiresAt: T0 }, "process_watch_expired"],
			[{ expiresAt: T0 + PROCESS_WATCH.maxMs + 1 }, "process_watch_too_long"],
			[{ handle: "99999999-9999-4999-8999-999999999999" }, "process_unknown_handle"],
		];
		for (const [overrides, code] of refused) await expect(startWatch(provider, processSource(overrides))).rejects.toMatchObject({ code });
		provider.next = [{ intent: intent({ handle: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }), receipt: null }];
		await expect(startWatch(provider)).rejects.toMatchObject({ code: "process_identity_mismatch" });
		expect(provider.checks).toBe(0);
		const longest = await startWatch(provider, processSource({ expiresAt: T0 + PROCESS_WATCH.maxMs }));
		await longest.adapter.stop("shutdown");
	});

	it("reports a receipt's completion once, after start, under a key bound to the handle and its supervisor", async () => {
		const provider = new FakeProvider();
		provider.set({ intent: intent(), receipt: receipt({ exitCode: 2 }) });
		const first = await startWatch(provider);
		expect(first.sink.emits).toEqual([]);
		await first.clock.advance(0);
		expect(first.sink.emits).toEqual([
			{ occurredAt: T0 + 1_000, data: { handle: HANDLE, outcome: "exited", exitCode: 2, signal: null }, checkpoint: null, key: `process:${HANDLE}:${BOOT}:4242:987654` },
		]);
		const reads = provider.reads;
		await first.clock.advance(60_000);
		expect(first.sink.emits).toHaveLength(1);
		expect(provider.reads).toBe(reads);
		// A later watch of the same handle, as after a restart, reads the same receipt as the same event.
		const again = await startWatch(provider);
		await again.clock.advance(0);
		expect(again.sink.emits).toEqual(first.sink.emits);
		provider.set({ intent: intent(), receipt: receipt({ exitCode: null, signal: "SIGTERM" }) });
		const signalled = await startWatch(provider);
		await signalled.clock.advance(0);
		expect(signalled.sink.emits[0]?.data).toEqual({ handle: HANDLE, outcome: "signalled", exitCode: null, signal: "SIGTERM" });
	});

	it("waits while its supervisor runs, and takes the receipt it writes", async () => {
		const provider = new FakeProvider();
		provider.set({ intent: intent(), receipt: null });
		const { clock, sink, adapter } = await startWatch(provider);
		await clock.advance(10_000);
		expect(sink.emits).toEqual([]);
		expect(provider.checks).toBe(11);
		provider.set({ intent: intent(), receipt: receipt({ endedAt: T0 + 10_500 }) });
		await clock.advance(1_000);
		expect(sink.emits.map((emitted) => [emitted.occurredAt, emitted.data.outcome, emitted.data.exitCode])).toEqual([[T0 + 10_500, "exited", 0]]);
		await adapter.stop("shutdown");
	});

	it("reports an unknown outcome, never an exit code, when the supervisor is gone without a receipt", async () => {
		for (const liveness of ["exited", "pid_reused", "other_boot"] as const) {
			const provider = new FakeProvider();
			provider.set({ intent: intent(), receipt: null });
			provider.liveness_ = liveness;
			const { clock, sink } = await startWatch(provider);
			await clock.advance(5_000);
			expect(sink.emits).toEqual([{ occurredAt: T0, data: { handle: HANDLE, outcome: "unknown", exitCode: null, signal: null }, checkpoint: null, key: `process:${HANDLE}:${BOOT}:4242:987654` }]);
		}
		// A receipt that lands just as its supervisor exits is read again before anything is called unknown.
		const provider = new FakeProvider();
		provider.set({ intent: intent(), receipt: null });
		provider.liveness_ = "exited";
		// Read at start, at the check, and again once the supervisor is seen gone.
		provider.next = [{ intent: intent(), receipt: null }, { intent: intent(), receipt: null }, { intent: intent(), receipt: receipt({ exitCode: 3 }) }];
		const { clock, sink } = await startWatch(provider, processSource());
		await clock.advance(0);
		expect(provider.reads).toBe(3);
		expect(sink.emits.map((emitted) => emitted.data)).toEqual([{ handle: HANDLE, outcome: "exited", exitCode: 3, signal: null }]);
	});

	it("refuses a receipt for another handle, boot or supervisor, and reports nothing of it", async () => {
		const wrong: Partial<CompletionReceipt>[] = [
			{ supervisor: { ...SUPERVISOR, bootId: "22222222-2222-4333-8444-555555555555" } },
			{ supervisor: { ...SUPERVISOR, pid: 4243 } },
			{ supervisor: { ...SUPERVISOR, startTime: "987655" } },
			{ handle: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
		];
		for (const overrides of wrong) {
			const provider = new FakeProvider();
			provider.set({ intent: intent(), receipt: receipt(overrides) });
			const { clock, sink } = await startWatch(provider);
			await clock.advance(60_000);
			expect(sink.emits).toEqual([]);
			expect(sink.reports).toEqual([{ status: "error", code: "process_identity_mismatch" }]);
			expect(provider.reads).toBe(2);
		}
		// An intent that changes under a running watch is refused the same way.
		const provider = new FakeProvider();
		provider.set({ intent: intent(), receipt: null });
		const { clock, sink } = await startWatch(provider);
		await clock.advance(0);
		provider.set({ intent: intent({ supervisor: { ...SUPERVISOR, pid: 1 } }), receipt: receipt({ supervisor: { ...SUPERVISOR, pid: 1 } }) });
		await clock.advance(1_000);
		expect(sink.emits).toEqual([]);
		expect(sink.reports).toEqual([{ status: "error", code: "process_identity_mismatch" }]);
		// So is one that changes with no receipt yet, whatever its supervisor's liveness, and the watch reads no more.
		for (const changed of [intent({ supervisor: { ...SUPERVISOR, startTime: "1" } }), intent({ launchedAt: T0 }), intent({ supervisor: { ...SUPERVISOR, bootId: BOOT.replace("1", "9") } })]) {
			for (const liveness of ["running", "exited"] as const) {
				const watched = new FakeProvider();
				watched.set({ intent: intent(), receipt: null });
				watched.liveness_ = liveness;
				const w = await startWatch(watched);
				watched.set({ intent: changed, receipt: null });
				await w.clock.advance(60_000);
				expect(w.sink.emits).toEqual([]);
				expect(w.sink.reports).toEqual([{ status: "error", code: "process_identity_mismatch" }]);
				expect(watched.reads).toBe(2);
				expect(watched.checks).toBe(0);
			}
		}
	});

	it("never infers an outcome once its time is up, however long the provider took to answer", async () => {
		type Gate = { promise: Promise<void>; open: () => void };
		const gate = (): Gate => {
			let open = () => {};
			const promise = new Promise<void>((resolve) => (open = resolve));
			return { promise, open };
		};
		const scenario = async (hold: "read" | "liveness" | "reread", answer: { liveness?: Liveness; receipt?: CompletionReceipt | null; final?: CompletionReceipt | null }) => {
			const provider = new FakeProvider();
			provider.set({ intent: intent(), receipt: null });
			provider.liveness_ = answer.liveness ?? "exited";
			const g = gate();
			const watch = await startWatch(provider, processSource({ expiresAt: T0 + 1_500 }));
			if (hold === "read") provider.holdReads.push(g.promise);
			else if (hold === "reread") provider.holdReads.push(Promise.resolve(), g.promise);
			else provider.holdChecks.push(g.promise);
			await watch.clock.advance(0);
			// The answer comes only after the watch's time is up.
			await watch.clock.advance(2_000);
			if (answer.receipt !== undefined) provider.set({ intent: intent(), receipt: answer.receipt });
			if (answer.final !== undefined) provider.next = [{ intent: intent(), receipt: answer.final }];
			const before = provider.reads;
			g.open();
			await watch.clock.advance(0);
			return { ...watch, provider, finalReads: provider.reads - before };
		};
		// The supervisor is found gone after expiry: one final read, and no receipt in it means expired, not unknown.
		const gone = await scenario("liveness", { liveness: "exited" });
		expect(gone.sink.emits).toEqual([]);
		expect(gone.sink.reports).toEqual([{ status: "degraded", code: "process_watch_expired" }]);
		expect(gone.finalReads).toBe(1);
		const reads = gone.provider.reads;
		await gone.clock.advance(600_000);
		expect(gone.provider.reads).toBe(reads);
		expect(gone.clock.pending).toBe(0);
		// Running when it was asked makes no difference.
		const running = await scenario("liveness", { liveness: "running" });
		expect(running.sink.emits).toEqual([]);
		expect(running.sink.reports).toEqual([{ status: "degraded", code: "process_watch_expired" }]);
		// The final read finds a receipt from before expiry: that completes it, with its own end.
		const timely = await scenario("liveness", { final: receipt({ endedAt: T0 + 1_499 }) });
		expect(timely.sink.emits.map((emitted) => [emitted.occurredAt, emitted.data.outcome])).toEqual([[T0 + 1_499, "exited"]]);
		const tooLate = await scenario("liveness", { final: receipt({ endedAt: T0 + 1_501 }) });
		expect(tooLate.sink.emits).toEqual([]);
		expect(tooLate.sink.reports).toEqual([{ status: "degraded", code: "process_watch_expired" }]);
		// A slow read that crossed expiry with nothing in it gets a final read; one with a timely receipt needs none.
		const slowRead = await scenario("read", {});
		expect(slowRead.sink.emits).toEqual([]);
		expect(slowRead.sink.reports).toEqual([{ status: "degraded", code: "process_watch_expired" }]);
		expect(slowRead.provider.checks).toBe(0);
		expect(slowRead.finalReads).toBe(1);
		// The supervisor was found gone in time, but the read after it answered only after expiry: still expired, not unknown.
		const slowReread = await scenario("reread", { liveness: "exited" });
		expect(slowReread.sink.emits).toEqual([]);
		expect(slowReread.sink.reports).toEqual([{ status: "degraded", code: "process_watch_expired" }]);
		expect(slowReread.finalReads).toBe(1);
		const slowReceipt = await scenario("read", { receipt: receipt({ endedAt: T0 + 1_000 }) });
		expect(slowReceipt.sink.emits.map((emitted) => emitted.occurredAt)).toEqual([T0 + 1_000]);
		expect(slowReceipt.finalReads).toBe(0);
	});

	it("gives up on a provider that doesn't answer, asks it nothing more meanwhile, and still expires", async () => {
		const provider = new FakeProvider();
		provider.set({ intent: intent(), receipt: null });
		const clock = new FakeClock();
		const sink = new Sink();
		const adapter = new ProcessWatchAdapter({ provider, clock, checkMs: 1_000, ioTimeoutMs: 500 });
		await adapter.start(adapterConfig(processSource({ expiresAt: T0 + 3_000 })), sink.emit, sink.health);
		provider.holdReads.push(new Promise(() => {}));
		await clock.advance(500);
		expect(sink.reports).toEqual([{ status: "degraded", code: "process_read_failed" }]);
		await clock.advance(2_500);
		// The hung read is the only one ever asked.
		expect(provider.reads).toBe(2);
		expect(sink.emits).toEqual([]);
		expect(sink.reports).toEqual([
			{ status: "degraded", code: "process_read_failed" },
			{ status: "degraded", code: "process_watch_expired" },
		]);
		await clock.advance(600_000);
		expect(provider.reads).toBe(2);
		expect(clock.pending).toBe(0);
	});

	it("reports nothing of an answer that comes after stop or abort", async () => {
		for (const end of ["stop", "abort"] as const) {
			const provider = new FakeProvider();
			provider.set({ intent: intent(), receipt: null });
			provider.liveness_ = "exited";
			let open = () => {};
			provider.holdChecks.push(new Promise<void>((resolve) => (open = resolve)));
			const watch = await startWatch(provider);
			await watch.clock.advance(0);
			if (end === "stop") await watch.adapter.stop("not_desired");
			else watch.abort.abort();
			open();
			await watch.clock.advance(600_000);
			expect(watch.sink.emits).toEqual([]);
			expect(watch.sink.reports).toEqual([]);
			expect(provider.reads).toBe(2);
			expect(watch.clock.pending).toBe(0);
		}
	});

	it("expires without a completion, and takes only an end from before its expiry", async () => {
		const provider = new FakeProvider();
		provider.set({ intent: intent(), receipt: null });
		const { clock, sink } = await startWatch(provider, processSource({ expiresAt: T0 + 5_500 }));
		await clock.advance(5_500);
		expect(sink.emits).toEqual([]);
		expect(sink.reports).toEqual([{ status: "degraded", code: "process_watch_expired" }]);
		const reads = provider.reads;
		await clock.advance(60_000);
		expect(provider.reads).toBe(reads);

		const late = new FakeProvider();
		late.set({ intent: intent(), receipt: null });
		const after = await startWatch(late, processSource({ expiresAt: T0 + 1_500 }));
		await after.clock.advance(1_000);
		late.set({ intent: intent(), receipt: receipt({ endedAt: T0 + 1_501 }) });
		await after.clock.advance(500);
		expect(after.sink.emits).toEqual([]);
		expect(after.sink.reports).toEqual([{ status: "degraded", code: "process_watch_expired" }]);

		const justInTime = new FakeProvider();
		justInTime.set({ intent: intent(), receipt: null });
		const before = await startWatch(justInTime, processSource({ expiresAt: T0 + 1_500 }));
		await before.clock.advance(1_000);
		justInTime.set({ intent: intent(), receipt: receipt({ endedAt: T0 + 1_400 }) });
		await before.clock.advance(500);
		expect(before.sink.emits.map((emitted) => emitted.occurredAt)).toEqual([T0 + 1_400]);
	});

	it("keeps a completion the runtime couldn't take, and emits it again, the same event, until it is taken", async () => {
		const provider = new FakeProvider();
		provider.set({ intent: intent(), receipt: receipt() });
		const clock = new FakeClock();
		const sink = new Sink();
		sink.results = [{ ok: false, reason: "not_started" }, { ok: false, reason: "backpressure" }];
		const adapter = new ProcessWatchAdapter({ provider, clock, checkMs: 1_000 });
		await adapter.start(adapterConfig(processSource()), sink.emit, sink.health);
		await clock.advance(1_000);
		expect(sink.emits).toHaveLength(2);
		await clock.advance(600_000);
		expect(sink.emits).toHaveLength(2);
		adapter.resume();
		await clock.advance(0);
		expect(sink.emits).toHaveLength(3);
		expect(new Set(sink.emits.map((emitted) => emitted.key)).size).toBe(1);
		await clock.advance(600_000);
		expect(sink.emits).toHaveLength(3);
	});

	it("stops reading at stop or abort, and says when its records can't be read", async () => {
		const provider = new FakeProvider();
		provider.set({ intent: intent(), receipt: null });
		const { clock, sink, adapter } = await startWatch(provider);
		provider.next = [new Error("EACCES"), new Error("EACCES")];
		await clock.advance(1_000);
		expect(sink.reports).toEqual([{ status: "degraded", code: "process_read_failed" }]);
		await clock.advance(1_000);
		expect(sink.reports).toEqual([
			{ status: "degraded", code: "process_read_failed" },
			{ status: "ok", code: "process_watching" },
		]);
		await adapter.stop("not_desired");
		const reads = provider.reads;
		provider.set({ intent: intent(), receipt: receipt() });
		await clock.advance(600_000);
		expect(provider.reads).toBe(reads);
		expect(sink.emits).toEqual([]);
		expect(clock.pending).toBe(0);

		const aborted = await startWatch(provider);
		aborted.abort.abort();
		await aborted.clock.advance(60_000);
		expect(aborted.sink.emits).toEqual([]);
	});
});

describe.runIf(process.platform === "linux")("managed records on a real computer", () => {
	const wrapper = path.join(import.meta.dirname, "fixtures", "managed-wrapper.ts");
	let stateDir: string;
	beforeEach(async () => {
		stateDir = path.join(dir, "managed");
		await fs.mkdir(stateDir, { mode: 0o700 });
	});

	function supervise(handle: string, job: "exit0" | "exit2" | "signalled" | "wait"): { child: ChildProcess; exited: Promise<number | null> } {
		const child = spawn(process.execPath, ["--no-warnings", wrapper, stateDir, handle, job], { stdio: "ignore" });
		const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
		return { child, exited };
	}
	async function intentOf(handle: string): Promise<void> {
		for (let tries = 0; tries < 200; tries++) {
			if (await readManagedRecord(stateDir, handle).catch(() => null)) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("no intent");
	}
	/** Watches `handle` until it has an answer, or its supervisor was seen running. */
	async function watch(handle: string) {
		const clock = new FakeClock();
		clock.time = Date.now();
		const files = new FileProcessProvider(stateDir);
		let running = false;
		const provider: ManagedProcessProvider = {
			read: (handle) => files.read(handle),
			liveness: async (identity) => {
				const liveness = await files.liveness(identity);
				running ||= liveness === "running";
				return liveness;
			},
		};
		const watched = await startWatch(provider, processSource({ handle, expiresAt: clock.time + PROCESS_WATCH.defaultMs }), clock);
		for (let tries = 0; tries < 200 && !running && watched.sink.emits.length === 0 && watched.sink.reports.length === 0; tries++) {
			await clock.advance(0);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return watched;
	}

	it("reports how a supervised job exited, from the receipt its supervisor wrote", async () => {
		const cases = [
			["exit0", { outcome: "exited", exitCode: 0, signal: null }],
			["exit2", { outcome: "exited", exitCode: 2, signal: null }],
			["signalled", { outcome: "signalled", exitCode: null, signal: "SIGTERM" }],
		] as const;
		for (const [job, expected] of cases) {
			const handle = crypto.randomUUID();
			expect(await supervise(handle, job).exited).toBe(0);
			const { sink } = await watch(handle);
			expect(sink.emits).toHaveLength(1);
			expect(sink.emits[0]?.data).toEqual({ handle, ...expected });
			expect((await fs.stat(path.join(stateDir, handle))).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(stateDir, handle, "receipt.json"))).mode & 0o777).toBe(0o600);
			const second = await watch(handle);
			expect(second.sink.emits[0]?.key).toBe(sink.emits[0]?.key);
		}
	});

	it("reports an unknown outcome when the supervisor dies before its receipt", async () => {
		const handle = crypto.randomUUID();
		const { child, exited } = supervise(handle, "wait");
		await intentOf(handle);
		child.kill("SIGKILL");
		await exited;
		const { sink } = await watch(handle);
		expect(sink.emits.map((emitted) => emitted.data)).toEqual([{ handle, outcome: "unknown", exitCode: null, signal: null }]);
		expect((await readManagedRecord(stateDir, handle))?.receipt).toBeNull();
	});

	it("leaves the job running when its watch stops, and a later watch takes its receipt", async () => {
		const handle = crypto.randomUUID();
		const { child, exited } = supervise(handle, "wait");
		await intentOf(handle);
		const watched = await watch(handle);
		expect(watched.sink.emits).toEqual([]);
		await watched.adapter.stop("not_desired");
		process.kill(child.pid as number, 0);
		expect(await exited).toBe(0);
		const later = await watch(handle);
		expect(later.sink.emits.map((emitted) => emitted.data)).toEqual([{ handle, outcome: "exited", exitCode: 0, signal: null }]);
	});

	it("reads only private records of this user's, through no link, and only a few KiB of each", async () => {
		const probe = new LinuxProcessProbe();
		const identity = (await probe.read(process.pid))?.identity as ProcessIdentity;
		const handle = crypto.randomUUID();
		await writeLaunchIntent(stateDir, { version: 1, handle, supervisor: identity, launchedAt: Date.now() });
		await writeCompletionReceipt(stateDir, { version: 1, handle, supervisor: identity, exitCode: 0, signal: null, endedAt: Date.now() });
		const folder = path.join(stateDir, handle);
		const receiptFile = path.join(folder, "receipt.json");
		expect((await readManagedRecord(stateDir, handle))?.receipt?.exitCode).toBe(0);
		const refused = async (change: () => Promise<void>, undo: () => Promise<void>) => {
			await change();
			await expect(readManagedRecord(stateDir, handle)).rejects.toMatchObject({ code: "record_unsafe" });
			await undo();
			expect((await readManagedRecord(stateDir, handle))?.receipt?.exitCode).toBe(0);
		};
		for (const mode of [0o755, 0o750, 0o701]) await refused(() => fs.chmod(folder, mode), () => fs.chmod(folder, 0o700));
		for (const mode of [0o644, 0o640, 0o604, 0o620]) await refused(() => fs.chmod(receiptFile, mode), () => fs.chmod(receiptFile, 0o600));
		const kept = await fs.readFile(receiptFile);
		const elsewhere = path.join(dir, "elsewhere.json");
		await fs.writeFile(elsewhere, kept, { mode: 0o600 });
		await refused(
			async () => {
				await fs.rm(receiptFile);
				await fs.symlink(elsewhere, receiptFile);
			},
			async () => {
				await fs.rm(receiptFile);
				await fs.writeFile(receiptFile, kept, { mode: 0o600 });
			},
		);
		await refused(
			() => fs.writeFile(receiptFile, Buffer.alloc(4_097, 0x20), { mode: 0o600 }),
			() => fs.writeFile(receiptFile, kept, { mode: 0o600 }),
		);
		await refused(
			async () => {
				await fs.rm(receiptFile);
				await new Promise<void>((resolve, reject) => spawn("mkfifo", ["-m", "600", receiptFile]).once("exit", (code) => (code === 0 ? resolve() : reject(new Error("mkfifo")))));
			},
			async () => {
				await fs.rm(receiptFile);
				await fs.writeFile(receiptFile, kept, { mode: 0o600 });
			},
		);
		// A handle's folder that is a link to one elsewhere is refused too.
		const moved = path.join(dir, "moved");
		await refused(
			async () => {
				await fs.rename(folder, moved);
				await fs.symlink(moved, folder);
			},
			async () => {
				await fs.rm(folder);
				await fs.rename(moved, folder);
			},
		);
	});

	it("tells a reused process id and another boot from the supervisor, and writes each record once", async () => {
		const probe = new LinuxProcessProbe();
		const self = await probe.read(process.pid);
		expect(self?.identity.bootId).toBe(await probe.bootId());
		const provider = new FileProcessProvider(stateDir);
		const identity = self?.identity as ProcessIdentity;
		expect(await provider.liveness(identity)).toBe("running");
		expect(await provider.liveness({ ...identity, startTime: String(Number(identity.startTime) + 1) })).toBe("pid_reused");
		expect(await provider.liveness({ ...identity, bootId: BOOT })).toBe("other_boot");

		const handle = crypto.randomUUID();
		await writeLaunchIntent(stateDir, { version: 1, handle, supervisor: identity, launchedAt: Date.now() });
		await expect(writeLaunchIntent(stateDir, { version: 1, handle, supervisor: identity, launchedAt: Date.now() })).rejects.toMatchObject({ code: "EEXIST" });
		await expect(writeCompletionReceipt(stateDir, { version: 1, handle, supervisor: { ...identity, pid: identity.pid + 1 }, exitCode: 0, signal: null, endedAt: Date.now() })).rejects.toMatchObject({
			code: "identity_mismatch",
		});
		await writeCompletionReceipt(stateDir, { version: 1, handle, supervisor: identity, exitCode: 1, signal: null, endedAt: Date.now() });
		await expect(writeCompletionReceipt(stateDir, { version: 1, handle, supervisor: identity, exitCode: 0, signal: null, endedAt: Date.now() })).rejects.toMatchObject({ code: "EEXIST" });
		expect((await readManagedRecord(stateDir, handle))?.receipt?.exitCode).toBe(1);

		// A state folder others may read is not used at all.
		await fs.chmod(stateDir, 0o755);
		await expect(startWatch(provider, processSource({ handle, expiresAt: Date.now() + 60_000 }), Object.assign(new FakeClock(), { time: Date.now() }))).rejects.toMatchObject({ code: "state_dir_unsafe" });
	});
});

describe("adapters in the runtime", () => {
	type Frame = Record<string, any>;
	const GRANT = { grantRef: "approval-1", scopeHash: "a".repeat(64) };
	const desired = (triggerId: string, source: ComputerSource): DesiredSource => ({
		triggerId,
		sourceId: `${triggerId}#1`,
		revision: 1,
		generation: 1,
		configHash: sourceConfigHash(source),
		source,
		grant: GRANT,
		checkpoint: null,
	});

	async function runtime(allowed: boolean) {
		const clock = new FakeClock();
		const launcher = new FakeLauncher(clock);
		const provider = new FakeProvider();
		const frames: Frame[] = [];
		const made: string[] = [];
		const factory = observerAdapters({ poll: { launcher, clock, random: () => 0 }, process: { provider, clock } });
		const open = async (connection: string) => {
			const spool = await ObservationSpool.open(path.join(dir, "spool"));
			const rt = new TriggersRuntime({
				binding: { space: "space-1", runtimeId: "rt-1" },
				spool,
				adapters: (source) => {
					made.push(source.kind);
					return factory(source);
				},
				authorize: () => (allowed ? { ok: true } : { ok: false, reason: "no grant" }),
				clock,
			});
			clock.idle = () => rt.idle();
			rt.attach({ send: (frame) => frames.push(JSON.parse(frame)) > 0 }, connection);
			return rt;
		};
		const reconcile = async (rt: TriggersRuntime, connection: string, sources: DesiredSource[]) => {
			await rt.receive(
				connection,
				JSON.stringify({ protocol: PROTOCOL, type: "reconcile", binding: { space: "space-1", runtimeId: "rt-1" }, connectionId: connection, serverEpoch: 1, desiredRevision: 1, leaseMs: 120_000, sources }),
			);
			await clock.advance(0);
		};
		return { clock, launcher, provider, frames, made, open, reconcile };
	}

	it("makes no adapter for a source its grant doesn't allow, or of a kind with none", async () => {
		const denied = await runtime(false);
		const rt = await denied.open("c1");
		await denied.reconcile(rt, "c1", [desired("t1", pollSource()), desired("t2", processSource())]);
		await denied.clock.advance(600_000);
		expect(denied.made).toEqual([]);
		expect(denied.launcher.children).toEqual([]);
		expect(denied.provider.reads).toBe(0);
		expect(denied.frames.filter((frame) => frame.type === "health").map((frame) => frame.code)).toEqual(["auth_denied", "auth_denied"]);
		await rt.close();

		await fs.rm(path.join(dir, "spool"), { recursive: true });
		const allowed = await runtime(true);
		const other = await allowed.open("c1");
		await allowed.reconcile(other, "c1", [desired("t3", { kind: "stream", command: "tail -F log", cwd: null }), desired("t4", { kind: "file", path: "/tmp/x", events: ["created"], recursive: false })]);
		expect(allowed.frames.filter((frame) => frame.type === "health").map((frame) => frame.code)).toEqual(["unsupported", "unsupported"]);
		expect(allowed.frames.filter((frame) => frame.type === "installed")).toEqual([]);
		await other.close();
	});

	it("is installed, with its coverage gap, before anything it observes, and a re-read completion is one event", async () => {
		const h = await runtime(true);
		h.provider.set({ intent: intent(), receipt: receipt({ exitCode: 2 }) });
		const rt = await h.open("c1");
		await h.reconcile(rt, "c1", [desired("poll", pollSource()), desired("proc", processSource({ expiresAt: T0 + PROCESS_WATCH.defaultMs }))]);
		h.launcher.last.finish(JSON.stringify(nested(8)));
		await h.clock.advance(100);
		const order = (triggerId: string) => h.frames.filter((frame) => frame.triggerId === triggerId).map((frame) => (frame.type === "health" ? `health:${frame.code}` : frame.type));
		expect(order("poll")).toEqual(["installed", "health:listening", "gap", "observation"]);
		expect(order("proc")).toEqual(["installed", "health:listening", "gap", "observation"]);
		for (const triggerId of ["poll", "proc"]) {
			const gap = h.frames.find((frame) => frame.type === "gap" && frame.triggerId === triggerId) as Frame;
			const observation = h.frames.find((frame) => frame.type === "observation" && frame.triggerId === triggerId) as Frame;
			expect(gap.reasons).toEqual({ coverage_unknown: 1 });
			expect(gap.sequence).toBeLessThan(observation.sequence);
		}
		const completion = h.frames.find((frame) => frame.type === "observation" && frame.triggerId === "proc") as Frame;
		expect(completion.data).toEqual({ handle: HANDLE, outcome: "exited", exitCode: 2, signal: null });
		expect((h.frames.find((frame) => frame.type === "observation" && frame.triggerId === "poll") as Frame).data).toEqual(nested(8));

		// After a restart, before the space has settled it, the same receipt is read as the same event, not a second one.
		await rt.close();
		h.frames.length = 0;
		const again = await h.open("c2");
		await h.reconcile(again, "c2", [desired("proc", processSource({ expiresAt: T0 + PROCESS_WATCH.defaultMs }))]);
		await h.clock.advance(100);
		const resent = h.frames.filter((frame) => frame.type === "observation" && frame.triggerId === "proc");
		expect(resent.map((frame) => frame.eventId)).toEqual([completion.eventId]);
		expect(h.made).toEqual(["poll", "process", "process"]);
		await again.close();
	});
});
