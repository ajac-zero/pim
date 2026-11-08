// pim-computer's triggers host, in Node: off by default, where it loads, makes and listens for nothing; and on, over a fake socket, with fake launchers on a fake clock for the protocol and the grants, the real runtime and spool in a temporary folder, and a few tiny real children for what only a real process group shows. Nothing here opens a socket or reaches the network.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Link, loadTriggers, TRIGGERS_GATE } from "../computer/pim-computer";
import type { ChildEvents, ChildExit, OwnedChild } from "../computer/triggers-adapters/poll";
import type { StreamChild, StreamChildEvents } from "../computer/triggers-adapters/stream";
import { ENVELOPE_BYTES, MAX_BUFFERED_BYTES, startTriggers, TRIGGERS_ENVELOPE, type TriggersHost, type TriggersSocket, grantScopeHash, triggersBinding } from "../computer/triggers-host";
import { type Binding, type ComputerSource, type DesiredSource, HARD_LIMITS, PROTOCOL, type RuntimeClock, SPOOL_FILE, sourceConfigHash } from "../computer/triggers-runtime";

const T0 = Date.UTC(2026, 10, 7);
const OWNER = `o_${"a".repeat(26)}`;
const TOKEN = `pimc_${OWNER}_s3cr3t-computer-token`;
const BINDING = triggersBinding(TOKEN) as Binding;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Frame = Record<string, any>;

let dir: string;
let stateDir: string;
beforeEach(async () => {
	dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pim-triggers-transport-")));
	stateDir = path.join(dir, "state");
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/** A clock whose timers run only when a test moves it; between timers it lets the runtime settle. */
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

/** pim-computer's WebSocket, as the host sees it. Every message it is given must be one triggers envelope within the frame's bound. */
class FakeSocket implements TriggersSocket {
	readyState = 1;
	bufferedAmount = 0;
	sent: string[] = [];
	send(data: string): void {
		this.sent.push(data);
	}
	frames(): Frame[] {
		return this.sent.map((message) => {
			expect(message.startsWith(TRIGGERS_ENVELOPE) && message.endsWith("}")).toBe(true);
			expect(Buffer.byteLength(message)).toBeLessThanOrEqual(HARD_LIMITS.frameBytes + ENVELOPE_BYTES);
			const envelope = JSON.parse(message);
			expect(Object.keys(envelope)).toEqual(["type", "frame"]);
			expect(envelope.type).toBe("triggers");
			return envelope.frame;
		});
	}
	of(type: string): Frame[] {
		return this.frames().filter((frame) => frame.type === type);
	}
	get connectionId(): string {
		return this.of("hello")[0]!.connectionId;
	}
}

class FakeStreamChild implements StreamChild {
	signals: string[] = [];
	exited = false;
	constructor(
		readonly request: { command: string; cwd: string | null },
		readonly events: StreamChildEvents,
	) {}
	signal(name: "SIGTERM" | "SIGKILL"): boolean {
		if (this.exited) return false;
		this.signals.push(name);
		queueMicrotask(() => this.exit({ code: null, signal: name }));
		return true;
	}
	pauseOutput(): void {}
	resumeOutput(): void {}
	release(): void {}
	print(text: string): void {
		this.events.stdout(Buffer.from(text));
	}
	exit(result: Partial<ChildExit> = {}): void {
		if (this.exited) return;
		this.exited = true;
		this.events.exit({ code: 0, signal: null, failed: false, cleaned: true, ...result });
		this.events.stdoutEnd();
	}
}

class FakeStreamLauncher {
	children: FakeStreamChild[] = [];
	launch = (request: { command: string; cwd: string | null }, events: StreamChildEvents): StreamChild => {
		const child = new FakeStreamChild(request, events);
		this.children.push(child);
		return child;
	};
	get last(): FakeStreamChild {
		return this.children.at(-1)!;
	}
}

class FakePollChild implements OwnedChild {
	signals: string[] = [];
	constructor(
		readonly request: { command: string; cwd: string | null },
		readonly events: ChildEvents,
	) {}
	signal(name: "SIGTERM" | "SIGKILL"): boolean {
		this.signals.push(name);
		return true;
	}
	release(): void {}
	finish(stdout: string): void {
		this.events.stdout(Buffer.from(stdout));
		this.events.exit({ code: 0, signal: null, failed: false, cleaned: true });
	}
}

class FakePollLauncher {
	children: FakePollChild[] = [];
	launch = (request: { command: string; cwd: string | null }, events: ChildEvents): OwnedChild => {
		const child = new FakePollChild(request, events);
		this.children.push(child);
		return child;
	};
}

const STREAM: ComputerSource = { kind: "stream", command: "watch-the-thing", cwd: null };
const POLL: ComputerSource = { kind: "poll", command: "check-the-thing", cwd: null, intervalMs: 60_000, deadlineMs: 5_000 };
const FILE: ComputerSource = { kind: "file", path: "/srv/inbox", events: ["created"], recursive: false };

/** A source the space wants, with the grant the space would give it: one that names exactly it, unless the test says otherwise. */
function desired(triggerId: string, source: ComputerSource, options: { revision?: number; generation?: number; grantRef?: string; scopeHash?: string; binding?: Binding } = {}): DesiredSource {
	const revision = options.revision ?? 1;
	const sourceId = `${triggerId}#${revision}`;
	const configHash = sourceConfigHash(source);
	const grantRef = options.grantRef ?? `approval-${triggerId}-${revision}`;
	const binding = options.binding ?? BINDING;
	return {
		triggerId,
		sourceId,
		revision,
		generation: options.generation ?? 1,
		configHash,
		source,
		grant: { grantRef, scopeHash: options.scopeHash ?? grantScopeHash({ ...binding, triggerId, sourceId, configHash, grantRef }) },
		checkpoint: null,
	};
}

const envelope = (frame: object | string) => `${TRIGGERS_ENVELOPE}${typeof frame === "string" ? frame : JSON.stringify(frame)}}`;

type Harness = { host: TriggersHost; clock: FakeClock; stream: FakeStreamLauncher; poll: FakePollLauncher; logs: string[] };

async function open(clock = new FakeClock()): Promise<Harness> {
	const stream = new FakeStreamLauncher();
	const poll = new FakePollLauncher();
	const logs: string[] = [];
	const host = await startTriggers({ token: TOKEN, stateDir, root: dir, log: (line) => logs.push(line), clock, stream, poll });
	if (!host) throw new Error("no host");
	clock.idle = () => host.idle();
	return { host, clock, stream, poll, logs };
}

async function attach(h: Harness): Promise<FakeSocket> {
	const socket = new FakeSocket();
	h.host.attach(socket);
	await h.clock.advance(0);
	return socket;
}

/** What the space sends on `socket`, in its envelope. */
async function say(h: Harness, socket: FakeSocket, message: Record<string, unknown>): Promise<void> {
	expect(h.host.receive(socket, envelope({ protocol: PROTOCOL, connectionId: socket.connectionId, serverEpoch: 1, ...message }))).toBe(true);
	await h.clock.advance(0);
}

const reconcile = (h: Harness, socket: FakeSocket, sources: DesiredSource[], extra: Record<string, unknown> = {}) =>
	say(h, socket, { type: "reconcile", binding: BINDING, desiredRevision: 1, leaseMs: 120_000, sources, ...extra });

const ack = (h: Harness, socket: FakeSocket, frames: Frame[]) =>
	say(h, socket, { type: "ack", durable: true, results: frames.map((frame) => ({ sequence: frame.sequence, eventId: frame.eventId, result: "accepted", reason: null, retryAfterMs: null })) });

const healthOf = (socket: FakeSocket, triggerId: string) => socket.of("health").filter((frame) => frame.triggerId === triggerId).map((frame) => frame.code);

/** Closes a host whose observers' stops wait on the fake clock. */
async function close(h: Harness): Promise<void> {
	const closing = h.host.close();
	await h.clock.advance(5_000);
	await closing;
}

describe("triggers in pim-computer, off", () => {
	it("loads, makes and listens for nothing unless the gate is exactly `internal`", async () => {
		const listeners = () => ["exit", "SIGTERM", "SIGINT", "SIGHUP"].map((name) => process.listenerCount(name));
		const before = { listeners: listeners(), resources: process.getActiveResourcesInfo().sort() };
		for (const value of [undefined, "", "1", "true", "on", "yes", "Internal", " internal", "internal "]) {
			const logs: string[] = [];
			const env = value === undefined ? {} : { [TRIGGERS_GATE]: value };
			expect(await loadTriggers(env, { token: TOKEN, stateDir, root: dir, log: (line) => logs.push(line) })).toBeNull();
			expect(logs).toEqual([]);
		}
		await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
		expect(listeners()).toEqual(before.listeners);
		expect(process.getActiveResourcesInfo().sort()).toEqual(before.resources);
	});

	it("keeps pim-computer one file that imports only Node's own modules, and leaves a triggers message to a Link that ignores it", async () => {
		// The Pim's install and update download pim-computer.ts alone: a value import of a module beside it would break every installed computer.
		const source = await fs.readFile(path.join(import.meta.dirname, "..", "computer", "pim-computer.ts"), "utf8");
		const imports = [...source.matchAll(/^import (?!type )[^;]*? from "([^"]+)";$/gm)].map((match) => match[1]);
		expect(imports.length).toBeGreaterThan(0);
		expect(imports.filter((name) => !name!.startsWith("node:"))).toEqual([]);

		const sent: unknown[] = [];
		const link = new Link({ root: dir, exec: async () => Promise.reject(new Error("no command runs")) }, (message) => sent.push(message));
		link.receive(envelope({ protocol: PROTOCOL, type: "reconcile", binding: BINDING, connectionId: "c", serverEpoch: 1, desiredRevision: 1, leaseMs: 1_000, sources: [desired("t", STREAM)] }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sent).toEqual([]);
	});
});

describe("triggers in pim-computer, on", () => {
	it("binds to the token's space under an id from its digest, and runs nothing for a token of another form or a state folder that isn't private", async () => {
		expect(BINDING.space).toBe(OWNER);
		expect(BINDING.runtimeId).toMatch(/^rt_[0-9a-f]{32}$/);
		expect(BINDING.runtimeId).not.toContain(TOKEN.slice(-12));
		expect(triggersBinding(`pimc_${OWNER}_another-secret`)!.runtimeId).not.toBe(BINDING.runtimeId);
		expect(triggersBinding("not-a-computer-token")).toBeNull();

		const on = { [TRIGGERS_GATE]: "internal" };
		const logs: string[] = [];
		expect(await loadTriggers(on, { token: "not-a-computer-token", stateDir, root: dir, log: (line) => logs.push(line) })).toBeNull();
		const elsewhere = path.join(dir, "elsewhere");
		await fs.mkdir(elsewhere);
		await fs.mkdir(stateDir);
		await fs.symlink(elsewhere, path.join(stateDir, "triggers"));
		expect(await loadTriggers(on, { token: TOKEN, stateDir, root: dir, log: (line) => logs.push(line) })).toBeNull();
		expect(logs).toHaveLength(2);
		expect(await fs.readdir(elsewhere)).toEqual([]);
	});

	it("says hello on each socket, takes the space's frames out of their envelope, and answers in one", async () => {
		const h = await open();
		const socket = await attach(h);
		expect(socket.frames()).toEqual([{ protocol: PROTOCOL, type: "hello", runtimeId: BINDING.runtimeId, connectionId: expect.stringMatching(UUID), lastEpoch: null, pending: 0 }]);
		// pim-computer's own messages are left for its Link.
		expect(h.host.receive(socket, '{"type":"call","id":"1","op":"stat","args":{"path":"/workspace"}}')).toBe(false);
		expect(h.host.receive(socket, '{"type":"cdp","channel":1,"data":"{}"}')).toBe(false);

		await reconcile(h, socket, [desired("s", STREAM), desired("p", POLL)]);
		expect(socket.of("reconciled")).toEqual([
			expect.objectContaining({ serverEpoch: 1, desiredRevision: 1, part: 1, parts: 1, sources: [expect.objectContaining({ triggerId: "s", state: "starting" }), expect.objectContaining({ triggerId: "p", state: "starting" })] }),
		]);
		expect(socket.of("installed").map((frame) => frame.triggerId).sort()).toEqual(["p", "s"]);
		expect(h.stream.children.map((child) => child.request)).toEqual([{ command: "watch-the-thing", cwd: null }]);

		h.stream.last.print('{"n":1}\n');
		// The first poll is due within its jitter, a tenth of its interval.
		for (let waited = 0; waited < 6_000 && h.poll.children.length === 0; waited += 100) await h.clock.advance(100);
		expect(h.poll.children.map((child) => child.request)).toEqual([{ command: "check-the-thing", cwd: null }]);
		h.poll.children[0]!.finish('{"v":2}');
		await h.clock.advance(0);
		const observations = socket.of("observation");
		expect(observations.map((frame) => [frame.triggerId, frame.sourceId, frame.generation, frame.data])).toEqual([
			["s", "s#1", 1, { n: 1 }],
			["p", "p#1", 1, { v: 2 }],
		]);
		// Each source's coverage gap came before its first observation.
		for (const frame of observations) {
			const gap = socket.of("gap").find((candidate) => candidate.triggerId === frame.triggerId)!;
			expect(gap.reasons).toEqual({ coverage_unknown: 1 });
			expect(gap.sequence).toBeLessThan(frame.sequence);
		}

		await ack(h, socket, [...socket.of("gap"), ...observations]);
		// A frame naming another connection, or one that isn't valid, is refused.
		await say(h, socket, { type: "ack", connectionId: "another-connection", durable: true, results: [] });
		await say(h, socket, { type: "reconcile", binding: BINDING, serverEpoch: 0, desiredRevision: 2, leaseMs: 120_000, sources: [] });
		expect(socket.of("error").map((frame) => frame.code)).toEqual(["wrong_connection", "invalid"]);

		// A new socket is a new connection; what still comes on the old one is dropped.
		h.host.detach(socket);
		const next = await attach(h);
		expect(next.connectionId).not.toBe(socket.connectionId);
		expect(next.of("hello")[0]).toMatchObject({ lastEpoch: 1, pending: 0 });
		const before = socket.sent.length;
		expect(h.host.receive(socket, envelope({ protocol: PROTOCOL, type: "reconcile", binding: BINDING, connectionId: socket.connectionId, serverEpoch: 1, desiredRevision: 2, leaseMs: 120_000, sources: [] }))).toBe(true);
		await h.clock.advance(0);
		expect(socket.sent.length).toBe(before);
		expect(next.frames().map((frame) => frame.type)).toEqual(["hello"]);
		expect(h.stream.last.signals).toEqual([]);

		await reconcile(h, next, [], { serverEpoch: 2 });
		expect(next.of("reconciled")[0]).toMatchObject({ serverEpoch: 2, sources: [] });
		expect(h.stream.last.signals).toEqual(["SIGTERM"]);
		await reconcile(h, next, [], { serverEpoch: 1, desiredRevision: 3 });
		expect(next.of("error").map((frame) => frame.code)).toEqual(["stale_epoch"]);
		await close(h);
	});

	it("starts a source only when its grant names exactly that source, for this computer", async () => {
		const h = await open();
		const socket = await attach(h);
		const other = triggersBinding(`pimc_o_${"b".repeat(26)}_another-computer`)!;
		const handle = "0a1b2c3d-0000-4000-8000-00000000000a";
		const watch: ComputerSource = { kind: "process", handle, expiresAt: T0 + 3_600_000 };
		await reconcile(h, socket, [
			desired("allowed", STREAM),
			desired("forged", STREAM, { scopeHash: "f".repeat(64) }),
			desired("elsewhere", STREAM, { binding: other }),
			// Another trigger's grant, for the very same source.
			desired("borrowed", STREAM, { grantRef: "approval-allowed-1", scopeHash: desired("allowed", STREAM).grant.scopeHash }),
			// A grant that names it, for a kind no observer here runs.
			desired("file", FILE),
			desired("watch", watch),
		]);
		expect(h.stream.children.map((child) => child.request.command)).toEqual(["watch-the-thing"]);
		for (const triggerId of ["forged", "elsewhere", "borrowed", "file"]) expect(healthOf(socket, triggerId)).toEqual(["auth_denied"]);
		// A process watch's grant lets its observer be made; it fails to start only because no managed launcher has given that handle.
		expect(healthOf(socket, "watch")).toEqual(["start_failed"]);
		expect(healthOf(socket, "allowed")).toEqual(["listening"]);

		// Its command changed, in a new generation under the same source identity, with the grant of the old one: the old command is stopped and the new never runs.
		const changed: ComputerSource = { kind: "stream", command: "watch-the-thing --and-more", cwd: null };
		const old = desired("allowed", STREAM).grant;
		await reconcile(h, socket, [desired("allowed", changed, { generation: 2, grantRef: old.grantRef, scopeHash: old.scopeHash })], { desiredRevision: 2 });
		expect(h.stream.children[0]!.signals).toEqual(["SIGTERM"]);
		expect(h.stream.children).toHaveLength(1);
		expect(healthOf(socket, "allowed")).toEqual(["listening", "auth_denied"]);

		// With a grant for the new source, it runs.
		await reconcile(h, socket, [desired("allowed", changed, { generation: 2 })], { desiredRevision: 3 });
		expect(h.stream.children.map((child) => child.request.command)).toEqual(["watch-the-thing", "watch-the-thing --and-more"]);

		// Its grant changed, on the same generation, to one that doesn't name it: it stops, and nothing runs it again.
		await reconcile(h, socket, [desired("allowed", changed, { generation: 2, grantRef: "approval-revoked", scopeHash: "0".repeat(64) })], { desiredRevision: 4 });
		await h.clock.advance(60_000);
		expect(h.stream.children[1]!.signals).toEqual(["SIGTERM"]);
		expect(h.stream.children).toHaveLength(2);
		expect(h.host.owned).toBe(0);
		await close(h);
	});

	it("keeps observers through a dropped connection only until the lease ends, then stops them and their children", async () => {
		const h = await open();
		const socket = await attach(h);
		await reconcile(h, socket, [desired("s", STREAM)], { leaseMs: 10_000 });
		expect(h.host.owned).toBe(1);
		h.host.detach(socket);
		await h.clock.advance(9_000);
		expect(h.stream.last.signals).toEqual([]);
		// Observed while disconnected: spooled, sent on the next connection.
		h.stream.last.print('{"while":"away"}\n');
		await h.clock.advance(1_000);
		expect(h.stream.last.signals).toEqual(["SIGTERM"]);
		expect(h.host.owned).toBe(0);
		expect(h.host.sources().map((source) => source.state)).toEqual(["stopped"]);
		expect(h.logs).toContain("Triggers: lease_expired");
		expect(socket.of("observation")).toEqual([]);

		await h.clock.advance(60_000);
		expect(h.stream.children).toHaveLength(1);
		const next = await attach(h);
		await reconcile(h, next, [desired("s", STREAM)], { desiredRevision: 2 });
		expect(h.stream.children).toHaveLength(2);
		expect(next.of("observation").map((frame) => frame.data)).toEqual([{ while: "away" }]);
		// The break is said before anything the new command sees.
		expect(next.of("gap").map((frame) => frame.reasons)).toContainEqual({ interrupted: 1 });
		await close(h);
		expect(h.stream.last.signals).toEqual(["SIGTERM"]);
		expect(h.host.owned).toBe(0);
	});

	it("replays its spool after a restart, from its private folder, and launches nothing until the space reconciles", async () => {
		const clock = new FakeClock();
		const first = await open(clock);
		const socket = await attach(first);
		await reconcile(first, socket, [desired("s", STREAM)]);
		first.stream.last.print('{"n":1}\n{"n":2}\n');
		await clock.advance(0);
		const sent = [...socket.of("gap"), ...socket.of("observation")].map(({ eventId, sequence, type, data }) => ({ eventId, sequence, type, data }));
		expect(sent).toHaveLength(3);
		await close(first);

		const spool = path.join(stateDir, "triggers", BINDING.runtimeId);
		expect((await fs.stat(path.join(stateDir, "triggers"))).mode & 0o777).toBe(0o700);
		expect((await fs.stat(spool)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(path.join(spool, SPOOL_FILE))).mode & 0o777).toBe(0o600);
		const journal = await fs.readFile(path.join(spool, SPOOL_FILE), "utf8");
		for (const kept of ["watch-the-thing", "approval-s-1", TOKEN, desired("s", STREAM).grant.scopeHash]) expect(journal).not.toContain(kept);

		const second = await open(clock);
		const again = await attach(second);
		expect(again.of("hello")[0]).toMatchObject({ lastEpoch: 1, pending: 3 });
		await clock.advance(120_000);
		expect(second.stream.children).toEqual([]);
		expect(again.frames().map((frame) => frame.type)).toEqual(["hello"]);

		await reconcile(second, again, [desired("s", STREAM)], { desiredRevision: 2 });
		const resent = [...again.of("gap"), ...again.of("observation")].map(({ eventId, sequence, type, data }) => ({ eventId, sequence, type, data }));
		for (const entry of sent) expect(resent).toContainEqual(entry);
		// The command runs again, as a new stream, after a gap that says nothing is known of what came before.
		expect(second.stream.children).toHaveLength(1);
		const fresh = again.of("gap").filter((frame) => !sent.some((entry) => entry.eventId === frame.eventId));
		expect(fresh.map((frame) => frame.reasons)).toEqual([{ coverage_unknown: 1 }]);
		expect(fresh[0]!.sequence).toBeGreaterThan(Math.max(...sent.map((entry) => entry.sequence)));
		await close(second);
	});

	it("keeps every message within its bound, both ways, and waits while the socket is full", async () => {
		const h = await open();
		const socket = await attach(h);
		// From the space: a frame over the runtime's inbound bound, or an envelope that isn't whole, is refused whole.
		expect(h.host.receive(socket, envelope(`{"protocol":"triggers.v1","type":"ack","pad":"${"x".repeat(1_048_576)}"}`))).toBe(true);
		expect(h.host.receive(socket, `${TRIGGERS_ENVELOPE}{"protocol":"triggers.v1","type":"ack"`)).toBe(true);
		await h.clock.advance(0);
		expect(socket.of("error").map((frame) => frame.code)).toEqual(["too_large", "invalid"]);

		// To the space: the answer to the largest reconcile, with the longest ids, in parts each within the bound.
		const many = Array.from({ length: HARD_LIMITS.sources }, (_, index) => desired(`${"t".repeat(150)}-${String(index).padStart(3, "0")}`, STREAM, { scopeHash: "f".repeat(64) }));
		await reconcile(h, socket, many);
		const parts = socket.of("reconciled");
		expect(parts.length).toBeGreaterThan(1);
		expect(parts.flatMap((part) => part.sources)).toHaveLength(HARD_LIMITS.sources);
		expect(h.stream.children).toEqual([]);
		expect(Math.max(...socket.sent.map((message) => Buffer.byteLength(message)))).toBeGreaterThan(HARD_LIMITS.frameBytes / 2);

		// An event whose every character JSON escapes, within the store's 16 KiB, goes in one frame, never cut.
		await reconcile(h, socket, [desired("s", STREAM)], { desiredRevision: 2 });
		const escaped = '"\\'.repeat(4_000);
		h.stream.last.print(`${JSON.stringify({ s: escaped })}\n`);
		await h.clock.advance(0);
		expect(socket.of("observation").map((frame) => frame.data)).toEqual([{ s: escaped }]);

		// A socket holding more than it should takes nothing; the runtime waits, then sends the same event.
		socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
		const before = socket.sent.length;
		h.stream.last.print('{"n":2}\n');
		await h.clock.advance(5_000);
		expect(socket.sent.length).toBe(before);
		socket.bufferedAmount = 0;
		await h.clock.advance(1_000);
		expect(socket.of("observation").map((frame) => frame.data)).toEqual([{ s: escaped }, { n: 2 }]);
		await close(h);
	});
});

describe("triggers in pim-computer, on real children", () => {
	/** Whether the process runs: a zombie, which is gone but not yet reaped by whoever inherited it, doesn't. */
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return stat[stat.lastIndexOf(")") + 2] !== "Z";
		} catch {
			return false;
		}
	};
	async function until(done: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
		for (const start = Date.now(); Date.now() - start < ms; ) {
			if (await done()) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("timed out");
	}
	async function pidFrom(file: string): Promise<number> {
		let pid = 0;
		await until(async () => {
			const text = await fs.readFile(file, "utf8").catch(() => "");
			pid = /^\d+\n$/.test(text) ? Number(text) : 0;
			return pid > 0;
		});
		return pid;
	}

	it("stops a stream's process group when the lease ends after the connection drops, kills what is still its own at exit, and signals nothing else", async () => {
		let bystander: ChildProcess | undefined;
		const host = await loadTriggers({ [TRIGGERS_GATE]: "internal" }, { token: TOKEN, stateDir, root: dir, log: () => {} });
		if (!host) throw new Error("no host");
		try {
			bystander = spawn("sleep", ["30"], { stdio: "ignore" });
			const pidFile = path.join(dir, "pid");
			const source: ComputerSource = { kind: "stream", command: `echo $$ > ${pidFile}; exec sleep 30`, cwd: null };
			const socket = new FakeSocket();
			host.attach(socket);
			await until(() => socket.sent.length > 0);
			const send = (message: Record<string, unknown>) =>
				host.receive(socket, envelope({ protocol: PROTOCOL, type: "reconcile", binding: BINDING, connectionId: socket.connectionId, serverEpoch: 1, sources: [desired("s", source)], ...message }));
			send({ desiredRevision: 1, leaseMs: 1_500 });
			const pid = await pidFrom(pidFile);
			expect(host.owned).toBe(1);
			host.detach(socket);
			await until(() => !alive(pid));
			await until(() => host.owned === 0);

			await fs.rm(pidFile);
			const next = new FakeSocket();
			host.attach(next);
			await until(() => next.sent.length > 0);
			expect(host.receive(next, envelope({ protocol: PROTOCOL, type: "reconcile", binding: BINDING, connectionId: next.connectionId, serverEpoch: 1, desiredRevision: 2, leaseMs: 120_000, sources: [desired("s", source)] }))).toBe(true);
			const again = await pidFrom(pidFile);
			expect(again).not.toBe(pid);
			// pim-computer's `exit`: SIGKILL, at once, to the group still its own.
			host.killOwned();
			await until(() => !alive(again));
			expect(alive(bystander.pid!)).toBe(true);
			await host.close();
			expect(host.owned).toBe(0);
			expect(alive(bystander.pid!)).toBe(true);
		} finally {
			bystander?.kill();
			await host.close();
		}
	});
});
