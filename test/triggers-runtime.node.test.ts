// The computer runtime for triggers' observers, in Node with fake adapters, a fake clock, a fake transport and a temporary spool. Nothing here runs a process, opens a socket or watches a file.
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AdapterConfig,
	type AdapterHealth,
	type AuthorizationRequest,
	type AuthorizationVerdict,
	type Checkpoint,
	type ComputerSource,
	type DesiredSource,
	type Emit,
	HARD_LIMITS,
	ObservationSpool,
	type ObserverAdapter,
	PROTOCOL,
	type RuntimeLimits,
	type RuntimeLogEvent,
	SPOOL_FILE,
	type SpoolOptions,
	type StopReason,
	TriggersRuntime,
	sourceConfigHash,
} from "../computer/triggers-runtime";

const T0 = Date.UTC(2026, 10, 7);
const SECRET = "s3cr3t-observed-value";
/** A frame read back as plain JSON. */
type Frame = any;

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

class FakeClock {
	time = T0;
	now = () => this.time;
	#timers: { at: number; order: number; run: () => void; cancelled: boolean }[] = [];
	#order = 0;
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
	async advance(ms: number, runtime: TriggersRuntime): Promise<void> {
		const until = this.time + ms;
		for (let fired = 0; ; fired++) {
			if (fired > 10_000) throw new Error("timers never settle");
			await runtime.idle();
			this.#timers = this.#timers.filter((timer) => !timer.cancelled);
			const next = this.#timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at || a.order - b.order)[0];
			if (!next) break;
			this.#timers.splice(this.#timers.indexOf(next), 1);
			this.time = Math.max(this.time, next.at);
			next.run();
		}
		this.time = until;
		await runtime.idle();
	}
}

class Wire {
	frames: Frame[] = [];
	raw: string[] = [];
	open = true;
	send = (frame: string): boolean => {
		if (!this.open) return false;
		this.raw.push(frame);
		this.frames.push(JSON.parse(frame));
		return true;
	};
	of(type: string): Frame[] {
		return this.frames.filter((frame) => frame.type === type);
	}
	clear(): void {
		this.frames = [];
		this.raw = [];
	}
}

class FakeAdapter implements ObserverAdapter {
	config: AdapterConfig | null = null;
	emit!: Emit;
	health!: (report: AdapterHealth) => void;
	stops: StopReason[] = [];
	commits: Checkpoint[] = [];
	pauses = 0;
	resumes = 0;
	startGate: Deferred | null;
	stopGate: Deferred | null;
	failStart: Error | null;
	readonly #harness: Harness;
	readonly source: ComputerSource;
	constructor(harness: Harness, source: ComputerSource, plan: Plan) {
		this.#harness = harness;
		this.source = source;
		this.startGate = plan.start ?? null;
		this.stopGate = plan.stop ?? null;
		this.failStart = plan.fail ?? null;
	}
	get generation(): number {
		return this.config?.generation ?? -1;
	}
	async start(config: AdapterConfig, emit: Emit, health: (report: AdapterHealth) => void): Promise<void> {
		this.config = config;
		this.emit = emit;
		this.health = health;
		this.#harness.live(config.triggerId, 1);
		if (this.startGate) await this.startGate.promise;
		if (this.failStart) throw this.failStart;
	}
	async stop(reason: StopReason): Promise<void> {
		this.stops.push(reason);
		if (this.stopGate) await this.stopGate.promise;
		if (this.config) this.#harness.live(this.config.triggerId, -1);
	}
	commit(checkpoint: Checkpoint): void {
		this.commits.push(checkpoint);
	}
	pause(): void {
		this.pauses++;
	}
	resume(): void {
		this.resumes++;
	}
}

type Plan = { start?: Deferred; stop?: Deferred; fail?: Error };
type HarnessOptions = { spool?: SpoolOptions; limits?: Partial<RuntimeLimits>; authorize?: "grants" | "none" | ((request: AuthorizationRequest) => AuthorizationVerdict) };

const GRANT = { grantRef: "approval-1", scopeHash: "a".repeat(64) };

function streamSource(command = "tail -F /var/log/app.log"): ComputerSource {
	return { kind: "stream", command, cwd: null };
}
function pollSource(intervalMs = 60_000): ComputerSource {
	return { kind: "poll", command: "curl -s localhost/health", cwd: "/srv", intervalMs, deadlineMs: 30_000 };
}
function desired(triggerId: string, generation: number, source: ComputerSource = streamSource(), overrides: Partial<DesiredSource> = {}): DesiredSource {
	return { triggerId, sourceId: `${triggerId}#1`, revision: 1, generation, configHash: sourceConfigHash(source), source, grant: GRANT, checkpoint: null, ...overrides };
}

class Harness {
	readonly clock: FakeClock;
	readonly options: HarnessOptions;
	wire = new Wire();
	logs: RuntimeLogEvent[] = [];
	adapters: FakeAdapter[] = [];
	plans: Plan[] = [];
	grants = new Set<string>();
	checks: AuthorizationRequest[] = [];
	liveBy = new Map<string, number>();
	maxLive = 0;
	spool!: ObservationSpool;
	runtime!: TriggersRuntime;
	connection = "c1";

	constructor(options: HarnessOptions = {}, clock = new FakeClock()) {
		this.options = options;
		this.clock = clock;
	}

	static async open(options: HarnessOptions = {}): Promise<Harness> {
		const harness = new Harness(options);
		await harness.start();
		return harness;
	}

	async start(): Promise<void> {
		this.spool = await ObservationSpool.open(path.join(dir, "spool"), this.options.spool);
		const authorize = this.options.authorize ?? "grants";
		this.runtime = new TriggersRuntime({
			binding: { space: "space-1", runtimeId: "rt-1" },
			spool: this.spool,
			adapters: (source) => {
				const adapter = new FakeAdapter(this, source, this.plans.shift() ?? {});
				this.adapters.push(adapter);
				return adapter;
			},
			authorize:
				authorize === "none"
					? undefined
					: authorize === "grants"
						? (request) => {
								this.checks.push(request);
								return this.grants.has(`${request.grant.grantRef}|${request.grant.scopeHash}|${request.configHash}`) ? { ok: true } : { ok: false, reason: "no grant" };
							}
						: authorize,
			clock: this.clock,
			log: (event) => this.logs.push(event),
			limits: this.options.limits,
		});
		this.attach();
		await this.tick();
	}

	attach(connection = this.connection): void {
		this.connection = connection;
		this.wire = new Wire();
		this.runtime.attach(this.wire, connection);
	}

	/** Closes the runtime as a restart would, and opens a new one on the same spool. */
	async restart(): Promise<void> {
		await this.runtime.close();
		this.adapters = [];
		await this.start();
	}

	live(triggerId: string, change: number): void {
		const now = (this.liveBy.get(triggerId) ?? 0) + change;
		this.liveBy.set(triggerId, now);
		this.maxLive = Math.max(this.maxLive, now);
	}

	allow(source: DesiredSource): void {
		this.grants.add(`${source.grant.grantRef}|${source.grant.scopeHash}|${source.configHash}`);
	}

	adapter(triggerId: string, generation: number): FakeAdapter {
		const found = this.adapters.filter((adapter) => adapter.config?.triggerId === triggerId && adapter.generation === generation);
		expect(found).toHaveLength(1);
		return found[0] as FakeAdapter;
	}

	async reconcile(sources: DesiredSource[], options: { epoch?: number; revision?: number; leaseMs?: number; space?: string; connection?: string } = {}): Promise<void> {
		await this.receive({
			protocol: PROTOCOL,
			type: "reconcile",
			binding: { space: options.space ?? "space-1", runtimeId: "rt-1" },
			connectionId: options.connection ?? this.connection,
			serverEpoch: options.epoch ?? 1,
			desiredRevision: options.revision ?? 1,
			leaseMs: options.leaseMs ?? 120_000,
			sources,
		});
	}

	async ack(results: { sequence: number; eventId: string; result?: string; retryAfterMs?: number }[], epoch = 1): Promise<void> {
		await this.receive({
			protocol: PROTOCOL,
			type: "ack",
			connectionId: this.connection,
			serverEpoch: epoch,
			durable: true,
			results: results.map((result) => ({ reason: null, retryAfterMs: null, result: "accepted", ...result })),
		});
	}

	/** Acknowledges every observation and gap sent so far. */
	async ackAll(epoch = 1): Promise<void> {
		const sent = this.wire.frames.filter((frame) => frame.type === "observation" || frame.type === "gap");
		await this.ack(sent.map((frame) => ({ sequence: frame.sequence, eventId: frame.eventId })), epoch);
	}

	async receive(message: unknown, connection = this.connection): Promise<void> {
		await this.runtime.receive(connection, typeof message === "string" ? message : JSON.stringify(message));
		await this.tick();
	}

	async tick(ms = 0): Promise<void> {
		await this.clock.advance(ms, this.runtime);
	}

	/** Reconciles one source with its grant and waits until it is installed. */
	async running(source: DesiredSource, options: { epoch?: number; revision?: number } = {}): Promise<FakeAdapter> {
		this.allow(source);
		await this.reconcile([source], options);
		const adapter = this.adapter(source.triggerId, source.generation);
		expect(this.runtime.sources().find((held) => held.triggerId === source.triggerId)?.state).toBe("installed");
		return adapter;
	}

	async journal(): Promise<string> {
		return fs.readFile(path.join(dir, "spool", SPOOL_FILE), "utf8");
	}
}

let dir: string;
let harness: Harness | null = null;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pim-triggers-runtime-"));
});
afterEach(async () => {
	await harness?.runtime.close();
	harness = null;
	await fs.rm(dir, { recursive: true, force: true });
});

async function open(options: HarnessOptions = {}): Promise<Harness> {
	harness = await Harness.open(options);
	return harness;
}

const event = (n: number, extra: Record<string, unknown> = {}) => ({ occurredAt: T0 + n, data: { n, ...extra } });

describe("triggers.v1 messages", () => {
	it("serves only its configured owner, on the connection it was given", async () => {
		const h = await open();
		expect(h.wire.of("hello")).toEqual([{ protocol: PROTOCOL, type: "hello", runtimeId: "rt-1", connectionId: "c1", lastEpoch: null, pending: 0 }]);
		const source = desired("t1", 1);
		h.allow(source);

		await h.reconcile([source], { space: "space-2" });
		await h.reconcile([source], { connection: "c0" });
		await h.receive({ protocol: PROTOCOL, type: "reconcile" }, "c0");
		await h.reconcile([source], { leaseMs: HARD_LIMITS.leaseMs + 1 });
		await h.receive({ protocol: "triggers.v2", type: "reconcile" });
		await h.reconcile([{ ...source, spaceId: "space-2" } as DesiredSource]);
		await h.receive("{not json");

		expect(h.wire.of("error").map((frame) => frame.code)).toEqual(["binding_mismatch", "wrong_connection", "invalid", "unsupported_protocol", "invalid", "invalid"]);
		expect(h.adapters).toHaveLength(0);
		expect(h.checks).toHaveLength(0);
		expect(h.spool.epoch).toBeNull();
	});

	it("keeps what an observer emits inside the envelope, which only the runtime fills in", async () => {
		const h = await open();
		const adapter = await h.running(desired("t1", 1));
		await adapter.emit({ occurredAt: T0, data: { serverEpoch: 99, sourceId: "t9#1", spaceId: "space-2", sequence: 1 } });
		await h.tick();
		const [observation] = h.wire.of("observation");
		expect(observation).toMatchObject({ serverEpoch: 1, sourceId: "t1#1", triggerId: "t1", generation: 1, revision: 1, data: { serverEpoch: 99, sourceId: "t9#1", spaceId: "space-2", sequence: 1 } });
		expect(observation).not.toHaveProperty("spaceId");
		expect(await adapter.emit({ occurredAt: T0, data: { n: 1 }, extra: true } as never)).toEqual({ ok: false, reason: "invalid" });
		expect(await adapter.emit({ occurredAt: T0, data: { n: Number.NaN } })).toEqual({ ok: false, reason: "invalid" });
	});
});

describe("grants", () => {
	it("denies every source when the host gives no check", async () => {
		const h = await open({ authorize: "none" });
		await h.reconcile([desired("t1", 1)]);
		expect(h.adapters).toHaveLength(0);
		expect(h.wire.of("health")).toMatchObject([{ triggerId: "t1", status: "error", code: "auth_denied" }]);
		expect(h.wire.of("installed")).toHaveLength(0);
	});

	it("takes only a verdict of exactly ok: true", async () => {
		for (const verdict of [{ ok: "true" }, { ok: 1 }, { reason: "fine" }, null, "ok"]) {
			const h = new Harness({ authorize: () => verdict as never });
			harness = h;
			await h.start();
			await h.reconcile([desired("t1", 1)]);
			expect(h.adapters).toHaveLength(0);
			await h.runtime.close();
			harness = null;
			await fs.rm(path.join(dir, "spool"), { recursive: true });
		}
		const h = await open({
			authorize: () => {
				throw new Error(SECRET);
			},
		});
		await h.reconcile([desired("t1", 1)]);
		expect(h.adapters).toHaveLength(0);
		expect(JSON.stringify([h.wire.raw, h.logs])).not.toContain(SECRET);
	});

	it("checks the grant against the exact configuration, so a changed interval needs a new consent", async () => {
		const h = await open();
		const first = desired("t1", 1, pollSource(60_000));
		await h.running(first);
		const faster = desired("t1", 2, pollSource(30_000));
		await h.reconcile([faster], { revision: 2 });
		expect(h.checks.at(-1)).toMatchObject({ triggerId: "t1", generation: 2, configHash: sourceConfigHash(pollSource(30_000)), grant: GRANT });
		expect(h.adapter("t1", 1).stops).toEqual(["reconfigured"]);
		expect(h.adapters).toHaveLength(1);
		expect(h.wire.of("health").at(-1)).toMatchObject({ generation: 2, status: "error", code: "auth_denied" });

		// A configuration that isn't what its hash says is refused before any check.
		const forged = { ...desired("t2", 1, pollSource(60_000)), source: pollSource(1_000) };
		h.allow(forged);
		await h.reconcile([forged], { revision: 3 });
		expect(h.wire.of("reconciled").at(-1).sources).toEqual([{ triggerId: "t2", sourceId: "t2#1", generation: 1, state: "invalid" }]);
		expect(h.adapters).toHaveLength(1);
	});

	it("checks again on every reconcile, and stops a source whose grant was revoked", async () => {
		const h = await open();
		const source = desired("t1", 1);
		const adapter = await h.running(source);
		await h.reconcile([source], { revision: 2 });
		expect(h.checks).toHaveLength(2);
		expect(adapter.stops).toEqual([]);

		h.grants.clear();
		await h.reconcile([source], { revision: 3 });
		expect(h.checks).toHaveLength(3);
		expect(adapter.stops).toEqual(["revoked"]);
		expect(h.wire.of("health").at(-1)).toMatchObject({ code: "auth_denied" });
		expect(h.wire.of("stopped").at(-1)).toMatchObject({ triggerId: "t1", generation: 1, reason: "revoked", adapter: "returned" });
		expect(await adapter.emit(event(1))).toEqual({ ok: false, reason: "stopped" });
		expect(h.spool.count).toBe(0);
	});

	it("stops the running observer when the grant on the same generation changes, and checks the new one", async () => {
		const h = await open();
		const adapter = await h.running(desired("t1", 1));
		const regranted = desired("t1", 1, streamSource(), { grant: { grantRef: "approval-2", scopeHash: "b".repeat(64) } });
		await h.reconcile([regranted], { revision: 2 });
		expect(adapter.stops).toEqual(["consent_changed"]);
		expect(h.adapters).toHaveLength(1);
		expect(h.checks.at(-1)?.grant).toEqual({ grantRef: "approval-2", scopeHash: "b".repeat(64) });
	});
});

describe("observer lifecycle", () => {
	it("acknowledges an installation before anything it observes, and takes nothing before then", async () => {
		const h = await open();
		const gate = deferred();
		h.plans.push({ start: gate });
		const source = desired("t1", 1);
		h.allow(source);
		await h.reconcile([source]);
		const adapter = h.adapter("t1", 1);
		expect(h.runtime.sources()[0]?.state).toBe("starting");
		expect(await adapter.emit(event(1))).toEqual({ ok: false, reason: "not_started" });
		expect(h.wire.of("installed")).toHaveLength(0);
		expect(h.wire.of("reconciled")[0].sources[0].state).toBe("starting");

		gate.resolve();
		await h.tick();
		expect(await adapter.emit(event(2))).toMatchObject({ ok: true, duplicate: false });
		await h.tick();
		expect(h.wire.frames.map((frame) => frame.type)).toEqual(["hello", "reconciled", "installed", "health", "observation"]);
		expect(h.wire.of("installed")[0]).toEqual({ protocol: PROTOCOL, type: "installed", serverEpoch: 1, triggerId: "t1", sourceId: "t1#1", generation: 1, configHash: source.configHash });
		expect(h.wire.of("health")[0]).toMatchObject({ status: "ok", code: "listening" });
	});

	it("reports a failed start as a health error, never as installed, and stops only that adapter", async () => {
		const h = await open();
		h.plans.push({ fail: new Error(`spawn failed: ${SECRET}`) });
		const source = desired("t1", 1);
		h.allow(source);
		await h.reconcile([source]);
		expect(h.wire.of("installed")).toHaveLength(0);
		expect(h.wire.of("health")).toMatchObject([{ status: "error", code: "start_failed" }]);
		expect(h.adapter("t1", 1).stops).toEqual(["start_failed"]);
		expect(h.wire.of("stopped")).toMatchObject([{ reason: "start_failed", adapter: "returned" }]);
		expect(JSON.stringify([h.wire.raw, h.logs])).not.toContain(SECRET);
	});

	it("starts once for a reconcile repeated, and once per generation however starts and stops interleave", async () => {
		const h = await open();
		const startOne = deferred();
		const stopOne = deferred();
		h.plans.push({ start: startOne, stop: stopOne });
		const one = desired("t1", 1);
		h.allow(one);
		await h.reconcile([one]);
		await h.reconcile([one], { revision: 2 });
		await h.reconcile([one], { revision: 2 });
		expect(h.adapters).toHaveLength(1);

		// Generation 2 arrives while generation 1 is still starting: 1 is fenced and asked to stop at once.
		const two = desired("t1", 2);
		h.allow(two);
		await h.reconcile([two], { revision: 3 });
		const first = h.adapter("t1", 1);
		expect(first.stops).toEqual(["reconfigured"]);
		expect(h.adapters).toHaveLength(1);

		// Its start finishing late reports nothing, and what it emits is refused.
		startOne.resolve();
		await h.tick();
		expect(h.wire.of("installed")).toHaveLength(0);
		expect(await first.emit(event(1))).toEqual({ ok: false, reason: "stopped" });

		// Generation 2 starts only once generation 1's stop has returned.
		await h.reconcile([two], { revision: 4 });
		expect(h.adapters).toHaveLength(1);
		stopOne.resolve();
		await h.tick();
		const second = h.adapter("t1", 2);
		expect(h.adapters).toHaveLength(2);
		expect(h.wire.of("installed")).toMatchObject([{ generation: 2 }]);
		expect(h.wire.of("stopped")).toMatchObject([{ generation: 1, reason: "reconfigured", adapter: "returned" }]);
		expect(second.stops).toEqual([]);
		expect(first.stops).toEqual(["reconfigured"]);
		expect(h.maxLive).toBe(1);

		// An older generation offered again is stale and changes nothing.
		await h.reconcile([one], { revision: 5 });
		expect(h.wire.of("reconciled").at(-1).sources[0].state).toBe("stale");
		expect(second.stops).toEqual([]);
	});

	it("fences a stopped generation's late emissions and health, whatever it still holds", async () => {
		const h = await open();
		const one = await h.running(desired("t1", 1));
		const two = desired("t1", 2);
		h.allow(two);
		await h.reconcile([two], { revision: 2 });
		expect(one.config?.signal.aborted).toBe(true);
		const before = h.wire.frames.length;
		expect(await one.emit(event(1))).toEqual({ ok: false, reason: "stopped" });
		one.health({ status: "error", code: "late" });
		await h.tick();
		expect(h.wire.frames.slice(before).filter((frame) => frame.generation === 1 && frame.type !== "stopped")).toEqual([]);
		expect(h.spool.count).toBe(0);
	});

	it("stops promptly when a source is paused or deleted, claiming only that its adapter's stop returned", async () => {
		const h = await open();
		const adapter = await h.running(desired("t1", 1));
		await h.reconcile([], { revision: 2 });
		expect(adapter.stops).toEqual(["not_desired"]);
		expect(h.wire.of("stopped")).toEqual([{ protocol: PROTOCOL, type: "stopped", serverEpoch: 1, triggerId: "t1", sourceId: "t1#1", generation: 1, reason: "not_desired", adapter: "returned" }]);
		expect(h.wire.raw.join("\n")).not.toMatch(/cancel/i);
	});

	it("reports a stop that never returns as timed out, and keeps the old generation fenced", async () => {
		const h = await open({ limits: { stopTimeoutMs: 5_000 } });
		h.plans.push({ stop: deferred() });
		const adapter = await h.running(desired("t1", 1));
		await h.reconcile([], { revision: 2 });
		expect(h.wire.of("stopped")).toHaveLength(0);
		await h.tick(5_000);
		expect(h.wire.of("stopped")).toMatchObject([{ reason: "not_desired", adapter: "timed_out" }]);
		expect(await adapter.emit(event(1))).toEqual({ ok: false, reason: "stopped" });
		expect(h.logs).toContainEqual({ code: "adapter_stop_timed_out", triggerId: "t1", generation: 1 });
	});

	it("shuts observers down when the lease runs out, connected or not, and a renewal keeps them", async () => {
		const h = await open();
		const source = desired("t1", 1);
		const adapter = await h.running(source);
		await h.tick(100_000);
		await h.reconcile([source], { revision: 2 });
		h.runtime.detach("c1");
		await h.tick(119_999);
		expect(adapter.stops).toEqual([]);
		expect(await adapter.emit(event(1))).toMatchObject({ ok: true });
		await h.tick(1);
		expect(adapter.stops).toEqual(["lease_expired"]);
		expect(await adapter.emit(event(2))).toEqual({ ok: false, reason: "stopped" });
		expect(h.logs).toContainEqual({ code: "lease_expired" });

		// The same epoch reconciling again starts it once more, after its check.
		h.attach("c2");
		await h.reconcile([source], { revision: 3 });
		expect(h.adapters).toHaveLength(2);
		expect(h.adapters[1]?.stops).toEqual([]);
	});

	it("starts nothing after a restart until the space reconciles, and then only what it still allows", async () => {
		const h = await open();
		const one = desired("t1", 1);
		const two = desired("t2", 1, streamSource("journalctl -f"));
		h.allow(one);
		h.allow(two);
		await h.reconcile([one, two]);
		await h.adapter("t1", 1).emit(event(1));
		await h.tick();
		const sent = h.wire.of("observation")[0];

		await h.restart();
		await h.tick(600_000);
		expect(h.adapters).toHaveLength(0);
		expect(h.wire.frames.map((frame) => frame.type)).toEqual(["hello"]);
		expect(h.wire.of("hello")[0]).toMatchObject({ lastEpoch: 1, pending: 1 });

		h.grants.clear();
		h.allow(one);
		await h.reconcile([one, two], { revision: 2 });
		expect(h.adapters.map((adapter) => adapter.config?.triggerId)).toEqual(["t1"]);
		expect(h.wire.of("health")).toContainEqual(expect.objectContaining({ triggerId: "t2", code: "auth_denied" }));
		expect(h.wire.of("observation")).toEqual([sent]);
	});
});

describe("delivery", () => {
	it("sends unsettled observations again on a new connection in the same epoch, with the same ids and sequences", async () => {
		const h = await open();
		const adapter = await h.running(desired("t1", 1));
		await adapter.emit(event(1));
		await adapter.emit(event(2));
		await h.tick();
		const first = h.wire.of("observation");
		expect(first.map((frame) => frame.sequence)).toEqual([1, 2]);

		h.runtime.detach("c1");
		h.attach("c2");
		await h.tick();
		expect(h.wire.of("observation")).toHaveLength(0);
		await h.reconcile([desired("t1", 1)], { revision: 2 });
		expect(h.wire.of("observation")).toEqual(first);
		expect(h.adapters).toHaveLength(1);

		await h.ack([{ sequence: 1, eventId: first[0].eventId }]);
		h.wire.clear();
		await h.tick(30_000);
		expect(h.wire.of("observation")).toEqual([first[1]]);
		await h.tick(60_000);
		expect(h.wire.of("observation")).toEqual([first[1], first[1]]);
	});

	it("moves an observer's checkpoint only over what the space has durably settled, in order", async () => {
		const h = await open();
		const adapter = await h.running(desired("t1", 1));
		for (const position of [1, 2, 3, 4]) await adapter.emit({ ...event(position), checkpoint: { position, cursor: `c${position}` } });
		await h.tick();
		const sent = h.wire.of("observation");
		expect(adapter.commits).toEqual([]);

		await h.ack([{ sequence: sent[1].sequence, eventId: sent[1].eventId }]);
		expect(adapter.commits).toEqual([]);
		await h.ack([{ sequence: sent[0].sequence, eventId: sent[0].eventId }]);
		expect(adapter.commits).toEqual([{ position: 2, cursor: "c2" }]);
		await h.ack([{ sequence: sent[0].sequence, eventId: sent[0].eventId }]);
		expect(adapter.commits).toEqual([{ position: 2, cursor: "c2" }]);
		expect(h.logs).toContainEqual({ code: "ack_unknown" });

		// A deferral keeps the entry and holds the checkpoint back; a mismatched id or an old epoch is ignored.
		await h.ack([{ sequence: sent[2].sequence, eventId: sent[2].eventId, result: "deferred", retryAfterMs: 60_000 }]);
		await h.ack([{ sequence: sent[3].sequence, eventId: sent[2].eventId }]);
		await h.ack([{ sequence: sent[3].sequence, eventId: sent[3].eventId }], 2);
		expect(h.logs).toContainEqual({ code: "ack_mismatch" });
		expect(h.logs).toContainEqual({ code: "ack_stale_epoch" });
		expect(h.spool.entries().map((entry) => entry.seq)).toEqual([sent[2].sequence, sent[3].sequence]);
		await h.ack([{ sequence: sent[3].sequence, eventId: sent[3].eventId }]);
		expect(adapter.commits).toEqual([{ position: 2, cursor: "c2" }]);

		h.wire.clear();
		await h.tick(59_999);
		expect(h.wire.of("observation")).toHaveLength(0);
		await h.tick(1);
		expect(h.wire.of("observation")).toEqual([sent[2]]);
		await h.ack([{ sequence: sent[2].sequence, eventId: sent[2].eventId, result: "rejected" }]);
		expect(adapter.commits).toEqual([
			{ position: 2, cursor: "c2" },
			{ position: 4, cursor: "c4" },
		]);
		expect(h.spool.count).toBe(0);
	});

	it("takes an event with a key once, and lets the space's duplicate settle it", async () => {
		const h = await open();
		const adapter = await h.running(desired("t1", 1));
		const first = await adapter.emit({ ...event(1), key: "inode-7:42" });
		const again = await adapter.emit({ ...event(1), key: "inode-7:42" });
		expect(first).toMatchObject({ ok: true, duplicate: false });
		expect(again).toEqual({ ok: true, eventId: (first as { eventId: string }).eventId, duplicate: true });
		expect(h.spool.count).toBe(1);
		await h.tick();
		const [sent] = h.wire.of("observation");
		await h.ack([{ sequence: sent.sequence, eventId: sent.eventId, result: "duplicate" }]);
		expect(h.spool.count).toBe(0);
		// Read again after it was settled, it goes with the same id, for the space to answer duplicate.
		expect(await adapter.emit({ ...event(1), key: "inode-7:42" })).toMatchObject({ eventId: sent.eventId, duplicate: false });
	});

	it("never sends an old epoch's observations, and records them as a gap in the new one", async () => {
		const h = await open();
		const adapter = await h.running(desired("t1", 1));
		h.runtime.detach("c1");
		for (const n of [1, 2, 3]) await adapter.emit(event(n));
		h.attach("c2");
		const next = desired("t1", 1);
		await h.reconcile([next], { epoch: 2 });
		expect(adapter.stops).toEqual(["epoch_replaced"]);
		expect(h.wire.of("observation")).toEqual([]);
		expect(h.wire.of("gap")).toMatchObject([{ serverEpoch: 2, triggerId: "t1", sourceId: "t1#1", generation: 1, reasons: { epoch_replaced: 3 }, from: T0 + 1, to: T0 + 3 }]);
		expect(h.spool.entries().every((entry) => entry.epoch === 2)).toBe(true);
		expect(h.adapters).toHaveLength(2);
		expect(h.adapters[1]?.stops).toEqual([]);

		await h.reconcile([next], { epoch: 1, revision: 9 });
		expect(h.wire.of("error").map((frame) => frame.code)).toEqual(["stale_epoch"]);
		expect(h.wire.of("observation")).toEqual([]);
	});

	it("sends bounded batches, and waits rather than spins when the transport takes nothing", async () => {
		const h = await open({ limits: { batch: 3, flushIntervalMs: 50, blockedRetryMs: 1_000 } });
		const adapter = await h.running(desired("t1", 1));
		h.runtime.detach("c1");
		for (let n = 0; n < 10; n++) await adapter.emit(event(n));
		h.attach("c2");
		await h.reconcile([desired("t1", 1)], { revision: 2 });
		expect(h.wire.of("observation")).toHaveLength(3);
		expect(h.wire.frames.slice(0, 2).map((frame) => frame.type)).toEqual(["hello", "reconciled"]);
		await h.tick(50);
		expect(h.wire.of("observation")).toHaveLength(6);
		await h.tick(100);
		expect(h.wire.of("observation").map((frame) => frame.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

		h.wire.open = false;
		h.wire.clear();
		await adapter.emit(event(11));
		await h.tick(999);
		expect(h.clock.pending).toBeLessThanOrEqual(4);
		h.wire.open = true;
		await h.tick(1);
		expect(h.wire.of("observation").map((frame) => frame.sequence)).toEqual([11]);
	});
});

describe("the spool", () => {
	it("keeps its directory and journal private to the user", async () => {
		const spoolDir = path.join(dir, "spool");
		await fs.mkdir(spoolDir, { mode: 0o755 });
		await fs.chmod(spoolDir, 0o755);
		await fs.writeFile(path.join(spoolDir, SPOOL_FILE), "", { mode: 0o644 });
		await fs.chmod(path.join(spoolDir, SPOOL_FILE), 0o644);
		const spool = await ObservationSpool.open(spoolDir);
		expect((await fs.stat(spoolDir)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(path.join(spoolDir, SPOOL_FILE))).mode & 0o777).toBe(0o600);
		await spool.close();

		const fresh = await ObservationSpool.open(path.join(dir, "fresh"));
		expect((await fs.stat(path.join(dir, "fresh"))).mode & 0o777).toBe(0o700);
		expect((await fs.stat(path.join(dir, "fresh", SPOOL_FILE))).mode & 0o777).toBe(0o600);
		await fresh.close();

		await fs.symlink(spoolDir, path.join(dir, "link"));
		await expect(ObservationSpool.open(path.join(dir, "link"))).rejects.toMatchObject({ code: "unsafe_path" });
		await fs.rm(path.join(spoolDir, SPOOL_FILE));
		await fs.symlink(path.join(dir, "elsewhere"), path.join(spoolDir, SPOOL_FILE));
		await expect(ObservationSpool.open(spoolDir)).rejects.toMatchObject({ code: "unsafe_path" });
	});

	it("refuses limits past the hard ones", async () => {
		await expect(ObservationSpool.open(path.join(dir, "a"), { maxBytes: HARD_LIMITS.spoolBytes + 1 })).rejects.toThrow(RangeError);
		const spool = await ObservationSpool.open(path.join(dir, "b"), { maxBytes: 8_192 });
		for (const limits of [{ ttlMs: HARD_LIMITS.spoolTtlMs + 1 }, { leaseMs: HARD_LIMITS.leaseMs + 1 }, { frameBytes: HARD_LIMITS.frameBytes + 1 }, { flushIntervalMs: 0 }]) {
			expect(() => new TriggersRuntime({ binding: { space: "s", runtimeId: "r" }, spool, adapters: () => ({}) as never, limits })).toThrow(RangeError);
		}
		await spool.close();
	});

	it("recovers from a crash part-way through a record without reading half of it", async () => {
		const h = await open();
		const adapter = await h.running(desired("t1", 1));
		for (const n of [1, 2]) await adapter.emit(event(n));
		await h.runtime.close();
		const file = path.join(dir, "spool", SPOOL_FILE);
		const whole = await fs.readFile(file);
		const lastLine = whole.subarray(whole.lastIndexOf(0x0a, whole.length - 2) + 1);
		// A third record, cut off as a crash would leave it.
		await fs.appendFile(file, lastLine.subarray(0, Math.floor(lastLine.length / 2)));

		await h.start();
		expect(h.spool.recovery).toEqual({ torn: true, corrupt: 0 });
		expect(h.spool.entries().map((entry) => (entry.kind === "observation" ? entry.data.n : null))).toEqual([1, 2]);
		const text = await h.journal();
		expect(text.endsWith("\n")).toBe(true);
		expect(text.length).toBe(whole.length);
	});

	it("cuts a failed write back to the last whole record, and goes on", async () => {
		let failNext = false;
		const h = await open({
			spool: {
				write: async (handle, data) => {
					if (failNext) {
						failNext = false;
						await handle.write(data, 0, Math.floor(data.length / 2));
						throw Object.assign(new Error(`no space left: ${SECRET}`), { code: "ENOSPC" });
					}
					await handle.write(data, 0, data.length);
					await handle.datasync();
				},
			},
		});
		const adapter = await h.running(desired("t1", 1));
		await adapter.emit(event(1));
		failNext = true;
		expect(await adapter.emit(event(2))).toEqual({ ok: false, reason: "spool_unavailable" });
		await h.tick();
		expect(h.wire.of("health").at(-1)).toMatchObject({ status: "error", code: "spool_unavailable" });
		expect(await adapter.emit(event(3))).toMatchObject({ ok: true });
		const before = h.spool.entries().map((entry) => entry.seq);

		await h.runtime.close();
		await h.start();
		expect(h.spool.recovery).toEqual({ torn: false, corrupt: 0 });
		expect(h.spool.entries().map((entry) => entry.seq)).toEqual(before);
		expect(h.spool.entries().map((entry) => (entry.kind === "observation" ? entry.data.n : null))).toEqual([1, 3]);
		expect(JSON.stringify([h.wire.raw, h.logs])).not.toContain(SECRET);
	});

	it("skips a corrupt record and says so with a gap, keeping the rest", async () => {
		const h = await open();
		const adapter = await h.running(desired("t1", 1));
		for (const n of [1, 2, 3]) await adapter.emit(event(n));
		await h.runtime.close();
		const file = path.join(dir, "spool", SPOOL_FILE);
		const lines = (await fs.readFile(file, "utf8")).split("\n");
		lines[2] = (lines[2] as string).replace('"n":2', '"n":7');
		await fs.writeFile(file, lines.join("\n"));

		await h.start();
		expect(h.spool.recovery).toEqual({ torn: false, corrupt: 1 });
		expect(h.spool.entries().map((entry) => (entry.kind === "observation" ? entry.data.n : entry.kind))).toEqual([1, 3, "gap"]);
		h.allow(desired("t1", 1));
		await h.reconcile([desired("t1", 1)], { revision: 2 });
		expect(h.wire.of("gap")).toMatchObject([{ triggerId: null, sourceId: null, reasons: { corrupt: 1 } }]);
		expect(h.wire.of("observation").map((frame) => frame.data.n)).toEqual([1, 3]);
	});

	it("never grows past its bytes, pausing an event source with a durable gap instead of dropping events", async () => {
		const h = await open({ spool: { maxBytes: 4_096, reserveBytes: 1_024 } });
		const adapter = await h.running(desired("t1", 1));
		h.runtime.detach("c1");
		const results = [];
		for (let n = 0; n < 20; n++) results.push(await adapter.emit(event(n, { body: "x".repeat(200) })));
		const accepted = results.filter((result) => result.ok).length;
		expect(accepted).toBeGreaterThan(3);
		expect(results.slice(0, accepted).every((result) => result.ok)).toBe(true);
		expect(results.slice(accepted)).toEqual(Array(20 - accepted).fill({ ok: false, reason: "backpressure" }));
		expect(adapter.pauses).toBe(1);
		expect((await fs.stat(path.join(dir, "spool", SPOOL_FILE))).size).toBeLessThanOrEqual(4_096);

		await h.runtime.close();
		await h.start();
		const gap = h.spool.entries().find((entry) => entry.kind === "gap");
		expect(gap).toMatchObject({ sourceId: "t1#1", generation: 1, reasons: { overflow: 20 - accepted }, from: T0 + accepted, to: T0 + 19 });
		expect(h.spool.count).toBe(accepted + 1);
	});

	it("resumes a paused event source once the space has taken enough, with the gap in sequence", async () => {
		const h = await open({ spool: { maxBytes: 4_096, reserveBytes: 1_024 } });
		const adapter = await h.running(desired("t1", 1));
		let n = 0;
		h.wire.open = false;
		while ((await adapter.emit(event(n, { body: "x".repeat(200) }))).ok) n++;
		expect(adapter.pauses).toBe(1);
		h.wire.open = true;
		await h.tick(1_000);
		const sent = h.wire.frames.filter((frame) => frame.type === "observation" || frame.type === "gap");
		expect(sent.map((frame) => frame.type)).toEqual([...Array(n).fill("observation"), "gap"]);
		await h.ackAll();
		expect(adapter.resumes).toBe(1);
		expect(h.wire.of("health").map((frame) => frame.code)).toEqual(["listening", "backpressure", "resumed"]);
		expect(await adapter.emit(event(100))).toMatchObject({ ok: true });
		expect(h.spool.count).toBe(1);
	});

	it("coalesces a state's unsent snapshots under pressure, saying how many and over what time", async () => {
		const h = await open({ spool: { maxBytes: 4_096, reserveBytes: 1_024 } });
		const adapter = await h.running(desired("t1", 1, pollSource()));
		h.runtime.detach("c1");
		for (let n = 0; n < 40; n++) expect(await adapter.emit(event(n, { body: "x".repeat(200) }))).toMatchObject({ ok: true });
		expect(adapter.pauses).toBe(0);
		const held = h.spool.entries();
		const total = held.reduce((sum, entry) => sum + (entry.kind === "observation" ? (entry.coalesced?.count ?? 1) : 0), 0);
		expect(total).toBe(40);
		const folded = held.filter((entry) => entry.kind === "observation" && entry.coalesced !== null);
		expect(folded.length).toBeGreaterThan(0);
		for (const entry of folded) {
			if (entry.kind !== "observation" || !entry.coalesced) continue;
			expect(entry.coalesced.count).toBeGreaterThan(1);
			expect(entry.coalesced.to).toBe(entry.occurredAt);
			expect(entry.coalesced.from).toBeLessThan(entry.coalesced.to);
		}
		expect(held.at(-1)).toMatchObject({ kind: "observation", data: { n: 39 } });

		h.attach("c2");
		await h.reconcile([desired("t1", 1, pollSource())], { revision: 2 });
		expect(h.wire.of("observation").reduce((sum, frame) => sum + (frame.coalesced?.count ?? 1), 0)).toBe(40);
		expect(h.wire.of("observation").filter((frame) => frame.coalesced !== null).length).toBe(folded.length);
		// Snapshots already sent are never folded into a later one.
		h.runtime.detach("c2");
		const sentSeqs = new Set(h.spool.entries().map((entry) => entry.seq));
		for (let n = 40; n < 60; n++) await adapter.emit(event(n, { body: "x".repeat(200) }));
		for (const seq of sentSeqs) expect(h.spool.get(seq)).toBeDefined();
	});

	it("gives up observations past their time to live with a gap, and never sends them", async () => {
		const h = await open({ limits: { ttlMs: 1_000 } });
		const adapter = await h.running(desired("t1", 1));
		h.runtime.detach("c1");
		await adapter.emit({ ...event(1), checkpoint: { position: 1, cursor: null } });
		await adapter.emit({ ...event(2), checkpoint: { position: 2, cursor: null } });
		await h.tick(999);
		expect(h.spool.count).toBe(2);
		await h.tick(1);
		expect(h.spool.entries()).toMatchObject([{ kind: "gap", reasons: { expired: 2 }, from: T0 + 1, to: T0 + 2 }]);
		expect(h.logs).toContainEqual({ code: "spool_expired", count: 2 });

		h.attach("c2");
		await h.reconcile([desired("t1", 1)], { revision: 2 });
		expect(h.wire.of("observation")).toEqual([]);
		expect(h.wire.of("gap")).toMatchObject([{ reasons: { expired: 2 } }]);
		await h.ackAll();
		expect(adapter.commits).toEqual([]);
		// What follows a loss never moves the checkpoint past it.
		await adapter.emit({ ...event(3), checkpoint: { position: 3, cursor: null } });
		await h.tick();
		await h.ackAll();
		expect(adapter.commits).toEqual([]);
	});

	it("refuses an observation larger than a frame, rather than cutting it, and records the loss", async () => {
		const h = await open({ limits: { frameBytes: 1_024 } });
		const adapter = await h.running(desired("t1", 1));
		expect(await adapter.emit(event(1, { body: "x".repeat(2_000) }))).toEqual({ ok: false, reason: "too_large" });
		await h.tick();
		expect(h.wire.of("observation")).toEqual([]);
		expect(h.wire.of("gap")).toMatchObject([{ reasons: { too_large: 1 } }]);
		expect(h.wire.raw.every((frame) => Buffer.byteLength(frame) <= 1_024)).toBe(true);
	});

	it("refuses data larger than the space's store takes, however large a frame may be", async () => {
		const h = await open();
		const adapter = await h.running(desired("t1", 1));
		expect(await adapter.emit(event(1, { body: "x".repeat(16_384) }))).toEqual({ ok: false, reason: "too_large" });
		expect(await adapter.emit(event(2, { body: "x".repeat(16_000) }))).toMatchObject({ ok: true });
	});
});

describe("what is kept and logged", () => {
	it("logs codes and counts only, and keeps commands and grants out of the spool and the protocol", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name));
		try {
			const source = streamSource(`tail -F /home/me/${SECRET}.log`);
			const h = await open({ limits: { ttlMs: 1_000 } });
			const adapter = await h.running(desired("t1", 1, source, { grant: { grantRef: `grant-${SECRET}`, scopeHash: "c".repeat(64) } }));
			await adapter.emit(event(1, { line: SECRET }));
			adapter.health({ status: "error", code: SECRET } as AdapterHealth);
			adapter.health({ status: "degraded", code: "slow_reader" });
			await h.tick();
			h.runtime.detach("c1");
			await adapter.emit(event(2, { line: SECRET }));
			await h.tick(1_000);
			await h.reconcile([], { revision: 2 });

			expect(JSON.stringify(h.logs)).not.toContain(SECRET);
			expect(h.wire.raw.filter((frame) => !frame.includes('"type":"observation"')).join("\n")).not.toContain(SECRET);
			expect(h.wire.of("health").map((frame) => frame.code)).toEqual(["listening", "slow_reader"]);
			expect(h.logs).toContainEqual({ code: "adapter_health_invalid", triggerId: "t1", generation: 1 });
			const journal = await h.journal();
			expect(journal).not.toContain("tail -F");
			expect(journal).not.toContain("grant-");
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});
