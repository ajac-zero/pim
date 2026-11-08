// The space's side of computer triggers (src/triggers/computer.ts), end to end in Node: the real runtime and spool of pim-computer's triggers host (computer/triggers-host.ts) with fake launchers on a fake clock, over a fake connection, against the real TriggerStore, PimStore approvals and grants on a real SQLite file of each test's own. Nothing opens a socket or reaches the network.
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildEvents, ChildExit, OwnedChild } from "../computer/triggers-adapters/poll";
import type { StreamChild, StreamChildEvents } from "../computer/triggers-adapters/stream";
import { grantScopeHash as hostGrantScope, startTriggers, TRIGGERS_ENVELOPE as HOST_ENVELOPE, type TriggersHost, type TriggersSocket, triggersBinding } from "../computer/triggers-host";
import { type Binding, type ComputerSource, PROTOCOL as HOST_PROTOCOL, type RuntimeClock, SPOOL_FILE, sourceConfigHash as hostConfigHash } from "../computer/triggers-runtime";
import { type ApprovalDecider, PimStore } from "../src/store";
import {
	COMPUTER_GRANT_ACTION,
	COMPUTER_LIMITS,
	COMPUTER_TABLES,
	ComputerGrants,
	ComputerTriggers,
	computerTriggersAllowed,
	grantScopeHash,
	PROTOCOL,
	runtimeIdOf,
	sourceConfigHash,
	TRIGGERS_ENVELOPE,
} from "../src/triggers/computer";
import { triggerHistory } from "../src/triggers/engine";
import { TriggerStore } from "../src/triggers/store";

const T0 = Date.UTC(2026, 10, 7);
const OWNER = `o_${"a".repeat(26)}`;
const TOKEN = `pimc_${OWNER}_s3cr3t-computer-token`;
const BINDING = triggersBinding(TOKEN) as Binding;
const DIGEST = createHash("sha256").update(TOKEN).digest("hex");
type Frame = Record<string, any>;

let dir: string;
beforeEach(async () => {
	dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pim-triggers-computer-")));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/** A clock whose timers run only when a test moves it, shared by the space and the computer; between timers it lets the runtime settle. */
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

/** These tests watch streams only. */
const noPolls = {
	launch: (_request: unknown, _events: ChildEvents): OwnedChild => {
		throw new Error("no polls here");
	},
};

/** A Durable Object's SQL API over node:sqlite, as much as the stores use. */
function sqlStorage(db: DatabaseSync): SqlStorage {
	const exec = (query: string, ...bindings: unknown[]) => {
		let rows: Record<string, SqlStorageValue>[] = [];
		let written = 0;
		if (bindings.length === 0 && query.trim().replace(/;\s*$/, "").includes(";")) db.exec(query);
		else {
			const statement = db.prepare(query);
			if (statement.columns().length > 0) rows = statement.all(...(bindings as never[])) as Record<string, SqlStorageValue>[];
			else written = Number(statement.run(...(bindings as never[])).changes);
		}
		return {
			toArray: () => rows,
			one: () => {
				if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
				return rows[0]!;
			},
			rowsWritten: written,
			rowsRead: rows.length,
			[Symbol.iterator]: () => rows[Symbol.iterator](),
		};
	};
	return { exec } as unknown as SqlStorage;
}

/** The space: its database file, with the stores, grants and computer triggers Pim would make over it. */
type Space = {
	readonly file: string;
	readonly sql: SqlStorage;
	readonly pim: PimStore;
	readonly store: TriggerStore;
	readonly grants: ComputerGrants;
	readonly triggers: ComputerTriggers;
	/** The digest of the paired computer's token, as the space keeps it. */
	digest: string | null;
	/** Makes every transaction fail before it writes, as a full disk would. */
	failWrites: boolean;
	close(): void;
};

/** `renewals`, when given, lets the space set its renewal timer only while it is on, as if a lost timer came back. */
function openSpace(file: string, clock: FakeClock, options: { reconcileBytes?: number; renewals?: { on: boolean } } = {}): Space {
	const db = new DatabaseSync(file);
	db.exec("PRAGMA synchronous = FULL");
	const sql = sqlStorage(db);
	let depth = 0;
	const space = {} as Space;
	const transaction = <T>(work: () => T): T => {
		if (space.failWrites) throw new Error("disk I/O error");
		const name = `t${depth++}`;
		db.exec(`SAVEPOINT ${name}`);
		try {
			const result = work();
			db.exec(`RELEASE ${name}`);
			return result;
		} catch (error) {
			db.exec(`ROLLBACK TO ${name}`);
			db.exec(`RELEASE ${name}`);
			throw error;
		} finally {
			depth--;
		}
	};
	const pim = new PimStore(sql);
	const grants = new ComputerGrants(sql, { approval: (id) => pim.approval(id), space: OWNER, now: clock.now });
	const store = new TriggerStore(sql, { transaction, now: clock.now, authorize: grants.authorize(() => runtimeIdOf(space.digest)) });
	const triggers = new ComputerTriggers(sql, {
		store,
		grants,
		transaction,
		now: clock.now,
		space: OWNER,
		tokenDigest: () => space.digest,
		setTimer: (ms, run) => (options.renewals && !options.renewals.on ? () => {} : clock.setTimer(ms, run)),
		...(options.reconcileBytes ? { reconcileBytes: options.reconcileBytes } : {}),
	});
	return Object.assign(space, { file, sql, pim, store, grants, triggers, digest: DIGEST, failWrites: false, close: () => db.close() });
}

type Computer = { host: TriggersHost; stream: FakeStreamLauncher; logs: string[] };

async function openComputer(clock: FakeClock): Promise<Computer> {
	const stream = new FakeStreamLauncher();
	const logs: string[] = [];
	const host = await startTriggers({ token: TOKEN, stateDir: path.join(dir, "computer"), root: dir, log: (line) => logs.push(line), clock, stream, poll: noPolls });
	if (!host) throw new Error("no host");
	clock.idle = () => host.idle();
	return { host, stream, logs };
}

async function closeComputer(computer: Computer, clock: FakeClock): Promise<void> {
	const closing = computer.host.close();
	await clock.advance(5_000);
	await closing;
}

let sockets = 0;

/**
 * One connection between the space and the computer: what each sends goes
 * to the other while it is open, and is recorded. When the space acks, the
 * ack is checked against another connection to the database file: what it
 * acknowledges must already be committed there.
 */
class Wire {
	readonly toSpace: Frame[] = [];
	readonly toComputer: Frame[] = [];
	readonly toSpaceRaw: string[] = [];
	durableAcks = 0;
	open = true;
	readonly computerSocket: TriggersSocket & { readyState: number };
	readonly spaceSocket: { readonly id: string; send(message: string): void };

	constructor(
		readonly space: Space,
		readonly computer: Computer,
	) {
		const wire = this;
		this.computerSocket = {
			readyState: 1,
			bufferedAmount: 0,
			send(message: string) {
				wire.toSpaceRaw.push(message);
				wire.toSpace.push(JSON.parse(message).frame);
				if (wire.open) expect(space.triggers.receive(wire.spaceSocket, message)).toBe(true);
			},
		};
		this.spaceSocket = {
			id: `socket-${++sockets}`,
			send(message: string) {
				expect(message.startsWith(TRIGGERS_ENVELOPE) && message.endsWith("}")).toBe(true);
				expect(Buffer.byteLength(message)).toBeLessThanOrEqual(COMPUTER_LIMITS.reconcileBytes + TRIGGERS_ENVELOPE.length + 1);
				const frame = JSON.parse(message).frame;
				expect(Object.keys(JSON.parse(message))).toEqual(["type", "frame"]);
				if (frame.type === "ack") wire.#checkDurable(frame);
				wire.toComputer.push(frame);
				if (wire.open) expect(computer.host.receive(wire.computerSocket, message)).toBe(true);
			},
		};
	}

	#checkDurable(ack: Frame): void {
		const reader = new DatabaseSync(this.space.file, { readOnly: true });
		try {
			for (const result of ack.results) {
				const said = this.toSpace.find((frame) => frame.sequence === result.sequence && frame.eventId === result.eventId);
				if (!said || result.result === "rejected" || result.result === "deferred") continue;
				if (said.type === "observation") {
					expect(reader.prepare("SELECT 1 FROM pim_trigger_inbox WHERE source = ? AND event_id = ?").all(said.sourceId, said.eventId)).toHaveLength(1);
				} else if (said.triggerId !== null) {
					expect(reader.prepare("SELECT gap_pending FROM pim_trigger_sources WHERE trigger_id = ?").get(said.triggerId)).toEqual({ gap_pending: 1 });
				}
				this.durableAcks++;
			}
		} finally {
			reader.close();
		}
	}

	from(type: string): Frame[] {
		return this.toSpace.filter((frame) => frame.type === type);
	}

	to(type: string): Frame[] {
		return this.toComputer.filter((frame) => frame.type === type);
	}

	/** Every result the space acked, by the frame it answered. */
	acks(): { type: string; triggerId: string | null; data?: unknown; result: string; reason: string | null; retryAfterMs: number | null }[] {
		return this.to("ack").flatMap((ack) =>
			ack.results.map((result: Frame) => {
				const said = this.toSpace.find((frame) => frame.sequence === result.sequence && frame.eventId === result.eventId)!;
				return { type: said.type, triggerId: said.triggerId, ...(said.type === "observation" ? { data: said.data } : {}), result: result.result, reason: result.reason, retryAfterMs: result.retryAfterMs };
			}),
		);
	}

	close(): void {
		this.open = false;
		this.computerSocket.readyState = 3;
		this.computer.host.detach(this.computerSocket);
		this.space.triggers.closed(this.spaceSocket);
	}
}

async function connect(space: Space, computer: Computer, clock: FakeClock): Promise<Wire> {
	const wire = new Wire(space, computer);
	computer.host.attach(wire.computerSocket);
	await clock.advance(0);
	return wire;
}

const base = { version: 1, owningAgentId: "agent-1", originChatId: "chat-1", label: "Watch", instruction: "Tell me what it said.", destination: { type: "existing_chat", chatId: "chat-1" } };
const stream = (command: string): ComputerSource => ({ kind: "stream", command, cwd: null });

let approvals = 0;

/** An approval to grant `args`, decided as the test says: by the person, unless it says otherwise. */
function approve(space: Space, args: unknown, decidedBy: ApprovalDecider = "user", status: "approved" | "denied" = "approved", action = COMPUTER_GRANT_ACTION): string {
	const id = `approval-${++approvals}`;
	space.pim.requestApproval({ id, session: "chat-1", action, tool: null, args, summary: "Let a trigger run a command on your computer", callId: `call-${id}`, createdAt: T0, expiresAt: null, onTimeout: "deny" });
	if (status) space.pim.decideApproval(id, status, null, decidedBy);
	return id;
}

const scopeOf = (triggerId: string, revision: number, source: ComputerSource) => ({ space: OWNER, runtimeId: BINDING.runtimeId, triggerId, sourceId: `${triggerId}#${revision}`, configHash: hostConfigHash(source) });

/** A recorded grant, from the person's approval of exactly this source. */
function grant(space: Space, triggerId: string, revision: number, source: ComputerSource): string {
	const id = approve(space, scopeOf(triggerId, revision, source));
	expect(space.grants.record(id)).toMatchObject({ ok: true });
	return id;
}

/** An enabled stream trigger, under its own grant. */
function watch(space: Space, id: string, command: string, extra: Record<string, unknown> = {}) {
	const source = stream(command);
	const authorizationRef = grant(space, id, 1, source);
	const created = space.store.create({ id, spec: { ...base, source, authorizationRef, ...extra }, lifecycle: "enabled" });
	if (!created.ok) throw new Error(`not created: ${created.reason}`);
	return { trigger: created.trigger, authorizationRef, source };
}

const inbox = (space: Space) => Number(space.sql.exec("SELECT COUNT(*) AS n FROM pim_trigger_inbox").one().n);

describe("computer triggers' digests and gate", () => {
	it("computes the same digests, runtime id and envelope as the computer, and is on only for exactly `internal`", () => {
		const sources: ComputerSource[] = [
			stream("tail -F log | jq -c ."),
			{ kind: "poll", command: "./price.sh", cwd: "/srv", intervalMs: 300_000, deadlineMs: 30_000 },
			{ kind: "process", handle: "proc-1", expiresAt: T0 + 3_600_000 },
			{ kind: "file", path: "/home/ada/inbox", events: ["created", "deleted"], recursive: true },
		];
		for (const source of sources) expect(sourceConfigHash(source)).toBe(hostConfigHash(source));
		const scope = { ...scopeOf("watch", 3, sources[0]!), grantRef: "approval-9" };
		expect(grantScopeHash(scope)).toBe(hostGrantScope(scope));
		expect(runtimeIdOf(DIGEST)).toBe(BINDING.runtimeId);
		expect(runtimeIdOf(null)).toBeNull();
		expect(TRIGGERS_ENVELOPE).toBe(HOST_ENVELOPE);
		expect(PROTOCOL).toBe(HOST_PROTOCOL);
		for (const value of [undefined, "", "1", "true", "on", "Internal", " internal", "internal "]) expect(computerTriggersAllowed(value === undefined ? {} : { PIM_TRIGGERS_COMPUTER: value })).toBe(false);
		expect(computerTriggersAllowed(null)).toBe(false);
		expect(computerTriggersAllowed({ PIM_TRIGGERS_COMPUTER: "internal" })).toBe(true);
	});
});

describe("computer triggers, end to end", () => {
	it("reconciles what is enabled and granted, takes what it observes into the store, and acks each only once it is committed", async () => {
		const clock = new FakeClock();
		const space = openSpace(path.join(dir, "space.sqlite"), clock);
		const computer = await openComputer(clock);
		const { trigger, authorizationRef, source } = watch(space, "watch", "tail-the-log");
		const wire = await connect(space, computer, clock);

		const [hello] = wire.from("hello");
		expect(hello).toEqual({ protocol: PROTOCOL, type: "hello", runtimeId: BINDING.runtimeId, connectionId: expect.any(String), lastEpoch: null, pending: 0 });
		expect(wire.to("reconcile")).toEqual([
			{
				protocol: PROTOCOL,
				type: "reconcile",
				binding: BINDING,
				connectionId: hello!.connectionId,
				serverEpoch: 1,
				desiredRevision: 1,
				leaseMs: 120_000,
				sources: [
					{
						triggerId: "watch",
						sourceId: "watch#1",
						revision: 1,
						generation: trigger.generation,
						configHash: hostConfigHash(source),
						source,
						grant: { grantRef: authorizationRef, scopeHash: hostGrantScope({ ...scopeOf("watch", 1, source), grantRef: authorizationRef }) },
						checkpoint: null,
					},
				],
			},
		]);
		expect(wire.from("reconciled")).toEqual([expect.objectContaining({ serverEpoch: 1, desiredRevision: 1, part: 1, parts: 1, sources: [expect.objectContaining({ triggerId: "watch", state: "starting" })] })]);
		expect(computer.stream.children.map((child) => child.request)).toEqual([{ command: "tail-the-log", cwd: null }]);
		// What the runtime says of its observers is health, never something taken in.
		expect(wire.from("installed")).toHaveLength(1);
		expect(space.store.get("watch")).toMatchObject({ health: "healthy" });
		expect(inbox(space)).toBe(0);
		// Its coverage gap was taken as a gap, then acked.
		expect(wire.acks()).toEqual([{ type: "gap", triggerId: "watch", result: "accepted", reason: null, retryAfterMs: null }]);
		expect(space.store.sourceState("watch")!.gapPending).toBe(true);

		computer.stream.last.print('{"level":"error","line":42}\n');
		await clock.advance(0);
		expect(wire.acks().slice(1)).toEqual([{ type: "observation", triggerId: "watch", data: { level: "error", line: 42 }, result: "accepted", reason: "accepted", retryAfterMs: null }]);
		expect(space.store.occurrences("watch")).toEqual([expect.objectContaining({ status: "pending", evidence: expect.objectContaining({ reason: "event" }) })]);
		expect(inbox(space)).toBe(1);
		expect(wire.durableAcks).toBe(2);
		expect(wire.to("ack").every((ack) => ack.connectionId === hello!.connectionId && ack.serverEpoch === 1 && ack.durable === true)).toBe(true);

		// Renewed every third of the lease with the same revision, since nothing changed; what was acked is never sent again.
		await clock.advance(100_000);
		expect(wire.to("reconcile").map((frame) => [frame.desiredRevision, frame.serverEpoch])).toEqual([
			[1, 1],
			[1, 1],
			[1, 1],
		]);
		expect(wire.from("observation")).toHaveLength(1);
		expect(wire.from("error")).toEqual([]);
		expect(computer.stream.last.signals).toEqual([]);
		await closeComputer(computer, clock);
		space.close();
	});

	it("acks nothing it couldn't write, so the same observation comes again; defers what the store can't hold yet; and answers a repeat as a duplicate", async () => {
		const clock = new FakeClock();
		const space = openSpace(path.join(dir, "space.sqlite"), clock);
		const computer = await openComputer(clock);
		watch(space, "watch", "tail-the-log");
		watch(space, "busy", "tail-the-queue", { delivery: { rawSamples: false, maxPendingEvents: 1 } });
		const wire = await connect(space, computer, clock);
		const watching = computer.stream.children.find((child) => child.request.command === "tail-the-log")!;
		const busy = computer.stream.children.find((child) => child.request.command === "tail-the-queue")!;
		const acked = wire.acks().length;

		space.failWrites = true;
		watching.print('{"n":1}\n');
		await clock.advance(0);
		const [first] = wire.from("observation");
		expect(first).toMatchObject({ triggerId: "watch", data: { n: 1 } });
		expect(wire.acks()).toHaveLength(acked);
		expect(inbox(space)).toBe(0);

		space.failWrites = false;
		await clock.advance(30_000);
		const again = wire.from("observation").filter((frame) => frame.eventId === first!.eventId);
		expect(again.length).toBeGreaterThanOrEqual(2);
		expect(again.every((frame) => frame.sequence === first!.sequence)).toBe(true);
		expect(wire.acks().slice(acked)).toEqual([expect.objectContaining({ type: "observation", data: { n: 1 }, result: "accepted" })]);
		expect(inbox(space)).toBe(1);

		// The same frame again is a duplicate, written nowhere.
		expect(space.triggers.receive(wire.spaceSocket, wire.toSpaceRaw.find((message) => message.includes(first!.eventId))!)).toBe(true);
		expect(wire.acks().at(-1)).toMatchObject({ type: "observation", result: "duplicate" });
		expect(inbox(space)).toBe(1);

		// One undelivered occurrence is all `busy` holds: the next event is deferred, and stays on the computer.
		busy.print('{"job":1}\n{"job":2}\n');
		await clock.advance(0);
		expect(wire.acks().filter((ack) => ack.triggerId === "busy" && ack.type === "observation")).toEqual([
			expect.objectContaining({ data: { job: 1 }, result: "accepted" }),
			expect.objectContaining({ data: { job: 2 }, result: "deferred", reason: "backpressure", retryAfterMs: 30_000 }),
		]);
		expect(space.store.occurrences("busy")).toHaveLength(1);
		await closeComputer(computer, clock);
		space.close();
	});

	it("keeps its epoch and revision across its own restart, the computer's, and moves to a new epoch when it lost its record", async () => {
		const clock = new FakeClock();
		const file = path.join(dir, "space.sqlite");
		let space = openSpace(file, clock);
		let computer = await openComputer(clock);
		watch(space, "watch", "tail-the-log");
		const first = await connect(space, computer, clock);
		expect(first.to("reconcile")[0]).toMatchObject({ serverEpoch: 1, desiredRevision: 1 });

		// Observed while the connection is down: spooled on the computer. The space restarts meanwhile.
		first.close();
		expect(space.store.get("watch")).toMatchObject({ health: "waiting_computer" });
		computer.stream.last.print('{"while":"away"}\n');
		await clock.advance(1_000);
		space.close();
		space = openSpace(file, clock);
		const second = await connect(space, computer, clock);
		expect(second.from("hello")[0]).toMatchObject({ lastEpoch: 1, pending: 1 });
		expect(second.to("reconcile")[0]).toMatchObject({ connectionId: second.from("hello")[0]!.connectionId, serverEpoch: 1, desiredRevision: 1 });
		expect(second.acks()).toEqual([expect.objectContaining({ type: "observation", data: { while: "away" }, result: "accepted" })]);
		expect(space.store.get("watch")).toMatchObject({ health: "healthy" });

		// Whatever still comes on the old socket is dropped; each socket is its own connection.
		expect(space.triggers.receive(first.spaceSocket, second.toSpaceRaw.find((message) => message.includes('"observation"'))!)).toBe(true);
		expect(second.to("ack")).toHaveLength(1);
		expect(first.to("ack")).toHaveLength(1);

		// The computer restarts: the same epoch, a new observer, and the break in coverage taken as a gap.
		second.close();
		await closeComputer(computer, clock);
		computer = await openComputer(clock);
		const third = await connect(space, computer, clock);
		expect(third.from("hello")[0]).toMatchObject({ lastEpoch: 1 });
		expect(third.to("reconcile")[0]).toMatchObject({ serverEpoch: 1, desiredRevision: 1 });
		expect(third.acks()).toEqual([{ type: "gap", triggerId: "watch", result: "accepted", reason: null, retryAfterMs: null }]);
		expect(third.from("gap")[0]!.reasons).toEqual({ coverage_unknown: 1 });
		expect(space.store.sourceState("watch")!.gapPending).toBe(true);

		// The space lost its record of the epoch: it moves above the computer's, and what the old epoch held arrives as a loss, never as observations.
		third.close();
		computer.stream.last.print('{"in":"the old epoch"}\n');
		await clock.advance(1_000);
		space.sql.exec("DELETE FROM pim_trigger_computer_runtimes");
		const fourth = await connect(space, computer, clock);
		expect(fourth.to("reconcile")[0]).toMatchObject({ serverEpoch: 2 });
		expect(fourth.from("observation")).toEqual([]);
		expect(fourth.from("gap").map((frame) => [frame.serverEpoch, frame.reasons])).toContainEqual([2, { epoch_replaced: 1 }]);
		expect(fourth.acks().every((ack) => ack.type === "gap" && ack.result === "accepted")).toBe(true);
		expect(Number(space.sql.exec("SELECT server_epoch FROM pim_trigger_computer_runtimes").one().server_epoch)).toBe(2);
		expect(inbox(space)).toBe(1);

		// Its record is behind the computer's, as after a restore: it moves above the computer's epoch, not back to its own.
		fourth.close();
		space.sql.exec("UPDATE pim_trigger_computer_runtimes SET server_epoch = 1");
		const fifth = await connect(space, computer, clock);
		expect(fifth.from("hello")[0]).toMatchObject({ lastEpoch: 2 });
		expect(fifth.to("reconcile")[0]).toMatchObject({ serverEpoch: 3 });
		expect(fifth.from("reconciled")[0]).toMatchObject({ serverEpoch: 3 });
		expect(fifth.from("error")).toEqual([]);
		fifth.close();
		await closeComputer(computer, clock);
		space.close();
	});

	it("waits for the computer while it's away, which stops at the lease's end, and stops taking in when its own lease lapses until it reconciles again", async () => {
		const clock = new FakeClock();
		const space = openSpace(path.join(dir, "space.sqlite"), clock);
		const computer = await openComputer(clock);
		watch(space, "watch", "tail-the-log");
		const wire = await connect(space, computer, clock);
		await clock.advance(80_000);
		expect(wire.to("reconcile")).toHaveLength(3);
		wire.close();
		expect(space.store.get("watch")).toMatchObject({ health: "waiting_computer" });
		// The last renewal came at 80 s: the observer keeps going until 200 s.
		await clock.advance(119_000);
		expect(computer.stream.last.signals).toEqual([]);
		await clock.advance(2_000);
		expect(computer.stream.last.signals).toEqual(["SIGTERM"]);
		// Nothing renews while it's gone.
		await clock.advance(60_000);
		expect(wire.to("reconcile")).toHaveLength(3);

		const back = await connect(space, computer, clock);
		expect(computer.stream.children).toHaveLength(2);
		expect(back.from("gap").map((frame) => frame.reasons)).toContainEqual({ interrupted: 1 });
		expect(back.acks().filter((ack) => ack.type === "gap").every((ack) => ack.result === "accepted")).toBe(true);
		expect(space.store.get("watch")).toMatchObject({ health: "healthy" });
		back.close();
		await closeComputer(computer, clock);
		space.close();

		// A space whose renewals don't go out (as if its timer were lost) takes nothing once its own lease has lapsed, and reconciles at once when the computer next says something.
		const renewals = { on: false };
		const lapsing = openSpace(path.join(dir, "lapsing.sqlite"), clock, { renewals });
		await fs.rm(path.join(dir, "computer"), { recursive: true });
		const other = await openComputer(clock);
		watch(lapsing, "watch", "tail-the-log");
		const link = await connect(lapsing, other, clock);
		lapsing.failWrites = true;
		other.stream.last.print('{"n":1}\n');
		await clock.advance(125_000);
		// Sent at 0, 30 and 90 s, never written, so never acked; the runtime's lease ran out at 120 s.
		expect(link.from("observation")).toHaveLength(3);
		expect(other.stream.last.signals).toEqual(["SIGTERM"]);
		lapsing.failWrites = false;
		renewals.on = true;
		await clock.advance(100_000);
		// Sent again at 210 s: past the space's lease too, so not taken, and a reconcile went out at once, which started the source again.
		expect(link.from("observation")).toHaveLength(4);
		expect(link.acks().filter((ack) => ack.type === "observation")).toEqual([]);
		expect(link.to("reconcile")).toHaveLength(2);
		expect(other.stream.children).toHaveLength(2);
		expect(link.acks().filter((ack) => ack.type === "gap").map((ack) => ack.result)).toEqual(["accepted", "accepted"]);
		// Renewed since, so the next time it's sent it is taken.
		await clock.advance(300_000);
		expect(link.acks().filter((ack) => ack.type === "observation")).toEqual([expect.objectContaining({ data: { n: 1 }, result: "accepted" })]);
		await closeComputer(other, clock);
		lapsing.close();
	});

	it("runs a source only under a current grant of exactly it: revoked, it is refused and stops; changed, it restarts under the new one", async () => {
		const clock = new FakeClock();
		const space = openSpace(path.join(dir, "space.sqlite"), clock);
		const computer = await openComputer(clock);
		const { trigger, source } = watch(space, "watch", "tail-the-log");
		const wire = await connect(space, computer, clock);
		expect(computer.stream.children).toHaveLength(1);

		// The grant changes, for the same source: the observer stops for consent and starts again under the new one.
		const regrant = grant(space, "watch", 1, source);
		const renamed = space.store.update({ id: "watch", expectedRevision: 1, spec: { ...base, source, authorizationRef: regrant } });
		expect(renamed).toMatchObject({ ok: true, trigger: { revision: 2, generation: trigger.generation } });
		space.triggers.refresh();
		await clock.advance(0);
		expect(wire.to("reconcile").at(-1)).toMatchObject({ desiredRevision: 2, sources: [expect.objectContaining({ generation: trigger.generation, grant: expect.objectContaining({ grantRef: regrant }) })] });
		expect(wire.from("stopped").map((frame) => frame.reason)).toEqual(["consent_changed"]);
		expect(computer.stream.children).toHaveLength(2);

		// Revoked: what the computer still sends is refused before the store sees it, and the next reconcile leaves the source out.
		expect(space.grants.revoke(regrant)).toBe(true);
		computer.stream.last.print('{"after":"revoke"}\n');
		await clock.advance(0);
		expect(wire.acks().filter((ack) => ack.type === "observation")).toEqual([expect.objectContaining({ data: { after: "revoke" }, result: "rejected", reason: "not_granted" })]);
		expect(inbox(space)).toBe(0);
		space.triggers.refresh();
		await clock.advance(0);
		expect(wire.to("reconcile").at(-1)).toMatchObject({ desiredRevision: 3, sources: [] });
		expect(wire.from("stopped").map((frame) => frame.reason)).toEqual(["consent_changed", "not_desired"]);
		expect(computer.stream.last.signals).toEqual(["SIGTERM"]);
		expect(space.store.get("watch")).toMatchObject({ health: "auth_required", healthDetail: "no_current_grant" });
		// A revoked grant can't be recorded again, and can't enable anything.
		expect(space.grants.record(regrant)).toEqual({ ok: false, reason: "revoked" });

		// The source changes, under a grant of the new one: a new generation, which the computer starts in place of the old.
		const changed = stream("tail-the-other-log");
		const fresh = grant(space, "watch", 3, changed);
		const moved = space.store.update({ id: "watch", expectedRevision: 2, spec: { ...base, source: changed, authorizationRef: fresh } });
		expect(moved).toMatchObject({ ok: true, trigger: { revision: 3 } });
		const generation = (moved as { trigger: { generation: number } }).trigger.generation;
		expect(generation).toBeGreaterThan(trigger.generation);
		space.triggers.refresh();
		await clock.advance(0);
		expect(wire.to("reconcile").at(-1)).toMatchObject({ desiredRevision: 4, sources: [expect.objectContaining({ sourceId: "watch#3", generation, configHash: hostConfigHash(changed) })] });
		expect(computer.stream.last.request).toEqual({ command: "tail-the-other-log", cwd: null });
		expect(space.store.get("watch")).toMatchObject({ health: "healthy" });
		// The old generation's observation, sent again, is refused.
		const old = wire.toSpaceRaw.find((message) => message.includes('"after":"revoke"'))!;
		space.triggers.receive(wire.spaceSocket, old);
		expect(wire.acks().at(-1)).toMatchObject({ result: "rejected", reason: "stale_generation" });
		computer.stream.last.print('{"from":"the new source"}\n');
		await clock.advance(0);
		expect(wire.acks().at(-1)).toMatchObject({ data: { from: "the new source" }, result: "accepted" });
		await closeComputer(computer, clock);
		space.close();
	});

	it("refuses to record or enable a grant that isn't the person's own decision for exactly that source on this computer", async () => {
		const clock = new FakeClock();
		const space = openSpace(path.join(dir, "space.sqlite"), clock);
		const source = stream("tail-the-log");
		const scope = scopeOf("watch", 1, source);
		const refused = [
			approve(space, scope, "timeout"),
			approve(space, scope, "always"),
			approve(space, scope, "majordomo"),
			approve(space, scope, "user", "denied"),
			approve(space, scope, "user", "approved", "http_request"),
			approve(space, { ...scope, extra: "field" }),
			approve(space, { ...scope, space: `o_${"b".repeat(26)}` }),
			approve(space, { ...scope, configHash: "not-a-digest" }),
			"approval-that-does-not-exist",
		];
		for (const id of refused) expect(space.grants.record(id)).toEqual({ ok: false, reason: "not_approved" });
		const pending = `approval-${++approvals}`;
		space.pim.requestApproval({ id: pending, session: "chat-1", action: COMPUTER_GRANT_ACTION, tool: null, args: scope, summary: "s", callId: "c", createdAt: T0, expiresAt: null, onTimeout: "deny" });
		expect(space.grants.record(pending)).toEqual({ ok: false, reason: "not_approved" });

		// An approval the person gave but no grant recorded from it, a grant of another source, and one for another computer don't enable it.
		const unrecorded = approve(space, scope);
		const otherSource = grant(space, "watch", 1, stream("tail-another-log"));
		const otherComputer = approve(space, { ...scope, runtimeId: triggersBinding(`pimc_${OWNER}_another-token`)!.runtimeId });
		expect(space.grants.record(otherComputer)).toMatchObject({ ok: true });
		for (const authorizationRef of [null, unrecorded, otherSource, otherComputer]) {
			expect(space.store.create({ id: "watch", spec: { ...base, source, authorizationRef }, lifecycle: "enabled" })).toMatchObject({ ok: false });
		}
		// With no computer paired, not even an exact grant does.
		const exact = grant(space, "watch", 1, source);
		space.digest = null;
		expect(space.store.create({ id: "watch", spec: { ...base, source, authorizationRef: exact }, lifecycle: "enabled" })).toMatchObject({ ok: false, reason: "authorization_denied" });
		space.digest = DIGEST;
		expect(space.store.create({ id: "watch", spec: { ...base, source, authorizationRef: exact }, lifecycle: "enabled" })).toMatchObject({ ok: true });
		// The approval's own record decides: had it been changed after the grant was recorded, the grant no longer counts.
		space.sql.exec("UPDATE pim_approvals SET decided_by = 'timeout' WHERE id = ?", exact);
		expect(space.grants.current(exact)).toBeNull();
		space.close();
	});

	it("says nothing of triggers to a runtime the stored token doesn't name", async () => {
		const clock = new FakeClock();
		const space = openSpace(path.join(dir, "space.sqlite"), clock);
		const computer = await openComputer(clock);
		watch(space, "watch", "tail-the-log");
		// Paired again since: this computer's token is no longer the space's.
		space.digest = createHash("sha256").update(`pimc_${OWNER}_the-new-token`).digest("hex");
		const wire = await connect(space, computer, clock);
		expect(wire.from("hello")).toHaveLength(1);
		expect(wire.toComputer).toEqual([]);
		expect(computer.stream.children).toEqual([]);
		space.triggers.refresh();
		expect(wire.toComputer).toEqual([]);
		await closeComputer(computer, clock);
		space.close();
	});

	it("keeps every frame within its bound both ways, and leaves out what doesn't fit in a reconcile", async () => {
		const clock = new FakeClock();
		const space = openSpace(path.join(dir, "space.sqlite"), clock, { reconcileBytes: 32_768 });
		const computer = await openComputer(clock);
		for (let index = 0; index < 12; index++) watch(space, `watch-${index}`, `${"x".repeat(3_500)} ${index}`);
		const wire = await connect(space, computer, clock);
		const [reconcile] = wire.to("reconcile");
		expect(Buffer.byteLength(JSON.stringify(reconcile))).toBeLessThanOrEqual(32_768);
		const sent = reconcile!.sources.map((source: Frame) => source.triggerId);
		expect(sent.length).toBeGreaterThan(4);
		expect(sent.length).toBeLessThan(12);
		expect(wire.from("error")).toEqual([]);
		expect(wire.from("reconciled").flatMap((frame) => frame.sources).map((source: Frame) => source.triggerId)).toEqual(sent);
		for (let index = 0; index < 12; index++) {
			if (!sent.includes(`watch-${index}`)) expect(space.store.get(`watch-${index}`)).toMatchObject({ health: "configuration_error", healthDetail: "too_many_sources" });
		}

		// What comes from the computer past its largest frame, malformed, or not as the protocol has it, is dropped whole.
		const acks = wire.to("ack").length;
		const observation = { protocol: PROTOCOL, type: "observation", serverEpoch: 1, eventId: "ev-1", triggerId: "watch-0", sourceId: "watch-0#1", revision: 1, generation: 1, sequence: 9_999, occurredAt: T0, data: {}, checkpoint: null, coalesced: null };
		const envelope = (frame: unknown) => `${TRIGGERS_ENVELOPE}${typeof frame === "string" ? frame : JSON.stringify(frame)}}`;
		for (const message of [
			envelope({ ...observation, data: { pad: "y".repeat(COMPUTER_LIMITS.inboundBytes) } }),
			envelope("{not json"),
			envelope({ ...observation, extra: true }),
			envelope({ ...observation, protocol: "triggers.v2" }),
			envelope({ ...observation, eventId: 'with "quotes"' }),
			`${envelope(observation)} `,
		]) {
			expect(space.triggers.receive(wire.spaceSocket, message)).toBe(true);
		}
		expect(wire.to("ack")).toHaveLength(acks);
		expect(inbox(space)).toBe(0);
		// Anything else is the computer's own, left for it.
		expect(space.triggers.receive(wire.spaceSocket, '{"type":"hello","agent":"pim-computer"}')).toBe(false);
		expect(space.triggers.receive(wire.spaceSocket, '{"type":"reply","id":"1","result":null}')).toBe(false);
		// The well-formed one is taken.
		expect(space.triggers.receive(wire.spaceSocket, envelope(observation))).toBe(true);
		expect(wire.to("ack")).toHaveLength(acks + 1);
		await closeComputer(computer, clock);
		space.close();
	});

	it("keeps nothing observed, no token and no credential in what the person's export holds or on the computer's disk", async () => {
		const clock = new FakeClock();
		const space = openSpace(path.join(dir, "space.sqlite"), clock);
		const computer = await openComputer(clock);
		const { authorizationRef } = watch(space, "watch", "tail-the-log");
		const wire = await connect(space, computer, clock);
		computer.stream.last.print('{"secret":"observed-secret-value"}\n');
		await clock.advance(0);
		expect(wire.acks().at(-1)).toMatchObject({ result: "accepted" });

		const history = triggerHistory(space.sql)!;
		for (const table of COMPUTER_TABLES) expect(Object.keys(history)).toContain(table);
		expect(history.pim_trigger_computer_runtimes).toEqual([{ runtime_id: BINDING.runtimeId, server_epoch: 1, desired_revision: 1, desired_digest: expect.stringMatching(/^[0-9a-f]{64}$/), updated_at: T0 }]);
		expect(history.pim_trigger_computer_grants).toEqual([
			{ grant_ref: authorizationRef, trigger_id: "watch", source_id: "watch#1", config_hash: hostConfigHash(stream("tail-the-log")), runtime_id: BINDING.runtimeId, granted_at: T0, revoked_at: null },
		]);
		const exported = JSON.stringify(history);
		expect(exported).not.toContain("observed-secret-value");
		expect(exported).not.toContain(TOKEN);
		expect(exported).not.toContain(DIGEST);
		expect(exported).not.toContain(wire.to("reconcile")[0]!.sources[0].grant.scopeHash);
		expect(space.pim.remainingData()).toEqual(expect.arrayContaining(["triggers' sessions with the computer", "triggers' grants on the computer"]));

		// The computer's spool keeps no command, grant or token, and what it observed leaves it once acked.
		await clock.advance(120_000);
		const journal = await fs.readFile(path.join(dir, "computer", "triggers", BINDING.runtimeId, SPOOL_FILE), "utf8");
		for (const secret of ["observed-secret-value", "tail-the-log", authorizationRef, TOKEN, DIGEST]) expect(journal).not.toContain(secret);
		await closeComputer(computer, clock);
		space.close();
	});
});
