import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeOutcome } from "../computer/native-outcome";
import type { NativeGate } from "../src/computer";
import { currentTrace } from "../src/computer-control-runtime";
import { PROVIDER_KEY } from "../src/cua";
import { MAX_NATIVE_FENCES, type NativeFenceRecord, type NativeFenceRequest } from "../src/cua-native-fences";
import { NativeBindingsDoc, NativeIdentityBinder } from "../src/cua-native-identity";
import { apiUrl, scripts, toolUse, waits } from "./helpers";
import { desktopSpaces, faux, fenceTransports, type Pim } from "./worker";

/**
 * Pim's side of native fences (src/cua-native-fences.ts,
 * docs/cua-native-fence-obligations.md), composed in the real Pim Durable
 * Object in workerd: the agent's desktop tool call, its binding and run
 * authority, the control state's admission, Pim's Stop and Delete routes
 * through the abort-effect companions, Pim's SQL storage and its `sync`.
 *
 * Two things are stand-ins, written here: the computer's `native` call, which
 * passes through the send's real authorization (its gate) and then answers as
 * the test says, with nothing behind it; and the broker's fence channel,
 * which there isn't one of anywhere (`fenceTransports` in ./worker.ts). A
 * restart is the instance reset with `ctx.abort`, which ends it as a crash
 * would in the local runtime and keeps what its storage committed: it is not
 * a power loss. A write a test makes fail is refused by the test before
 * storage sees it; a `sync` a test makes fail leaves the write to storage
 * regardless. Nothing here shows what a real broker, VM or crash does.
 */

const COMPLETED: NativeOutcome = { status: "completed", isError: false, code: null, content: [{ type: "text", text: "done" }], presentation: [] };

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = (check: () => unknown, timeout = 10_000) => vi.waitFor(check, { timeout, interval: 20 });

/** The computer's `native` call: authorized by Pim's own gate, recorded, then answered by `next`, which a test sets. */
function standIn() {
	const self = {
		sent: [] as { tool: string; args: unknown }[],
		next: async (): Promise<NativeOutcome> => COMPLETED,
		/** What the computer does before the send's authorization, as waking it does; resolves at once unless a test holds it. */
		wake: async (): Promise<void> => undefined,
		install(instance: Pim) {
			vi.spyOn(instance.computer, "native").mockImplementation(async (tool: unknown, args: unknown, gate: NativeGate) => {
				const trace = currentTrace();
				await self.wake();
				let transmitted = false;
				await gate(() => {
					transmitted = true;
					if (trace) trace.sent = true;
				});
				if (!transmitted) throw new Error("The call wasn't authorized at the moment of sending.");
				self.sent.push({ tool: String(tool), args });
				const outcome = await self.next();
				if (outcome.status === "unknown" && trace) trace.uncertain = true;
				return outcome;
			});
		},
	};
	return self;
}

/** A scripted broker's fence channel: its instance, the fences asked of it, and its answer, which by default echoes the request. */
function broker(instance: string) {
	const self = {
		now: instance as string | null,
		asked: [] as NativeFenceRequest[],
		answer: async (request: NativeFenceRequest): Promise<unknown> => ({ ...request }),
		transport: {
			instance: () => self.now,
			fence: (request: NativeFenceRequest) => {
				self.asked.push(request);
				return self.answer(request);
			},
		},
	};
	return self;
}

/** A space whose agents have the desktop's tools on the operator's Cua computer, as the tests' Pim allows; or, `native: false`, an ordinary one. */
async function desk(username: string, options: { native?: boolean; broker?: ReturnType<typeof broker> } = {}) {
	const native = options.native !== false;
	const directory = env.Directory.getByName("directory");
	const registered = await directory.register({ username, ip: "192.0.2.9", claim: { window: true }, policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
	if (!registered.ok) throw new Error(registered.error);
	const owner = registered.account.ownerId;
	if (native) desktopSpaces.add(owner);
	if (options.broker) fenceTransports.set(owner, options.broker.transport);
	await directory.activate(owner);
	if (native) await runInDurableObject(env.Pim.getByName(owner), (instance: Pim) => instance.store.setMeta(PROVIDER_KEY, JSON.stringify({ provider: "cua", space: owner })));
	await (await getAgentByName(env.Pim, owner)).provision({ ownerId: owner, username });
	const { token } = await env.Auth.getByName(owner).createToken(owner, "tests", Date.now());
	const call = async <T = any>(path: string, init: RequestInit = {}) => {
		const response = await exports.default.fetch(new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" } }));
		return { status: response.status, body: (await response.json().catch(() => null)) as T };
	};
	const within = <T>(work: (instance: Pim) => T | Promise<T>) => runInDurableObject(env.Pim.getByName(owner), work);
	const computer = standIn();
	const self = {
		owner,
		token,
		computer,
		root: (await call<{ rootSession: string }>("/")).body.rootSession,
		api: call,
		post: <T = any>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) }),
		within,
		/** Starts this instance: the stand-in computer, and the agent's lease, on the first start. */
		start: async (lease?: string) =>
			within((instance) => {
				computer.install(instance);
				if (lease) {
					instance.control.enable();
					instance.control.apply({ type: "resume", leaseId: lease });
				}
			}),
		/** The space's instance is reset (`ctx.abort`, as a crash would end it) and a new one starts, with the stand-in computer. */
		restart: async () => {
			await runInDurableObject(env.Pim.getByName(owner), (_instance: Pim, state) => state.abort("The test restarts the space")).catch(() => undefined);
			await self.start();
		},
		chat: async () => (await call<{ id: string }>("/sessions", { method: "POST", body: "{}" })).body.id,
		/** One turn of `chat` in which the agent reads the desktop's apps. Resolves when the turn ends, however it ends. */
		turn: (chat: string) => {
			faux.setResponses([() => toolUse("desktop_list_apps", {}), () => toolUse("send_to_user", { message: "Ok." })]);
			return call(`/sessions/${chat}/messages`, { method: "POST", body: JSON.stringify({ content: "Look at the desktop", wait: true }) }).catch((error: unknown) => error);
		},
		fences: () => within((instance) => instance.nativeFences.list()),
		fence: async (run: string) => (await self.fences()).find((record) => record.run === run),
		bindings: async () =>
			JSON.parse((await within(async (instance) => (await instance.harness.pi()).commit(async (tx) => (await tx.doc(NativeBindingsDoc)).text, context))) ?? '{"records":[]}')
				.records as { id: string; status: string; identity: { runAnchor: string; conversationId: string } }[],
		/** The run of the call the stand-in holds now: the one binding claimed. */
		claimedRun: async () => {
			const claimed = (await self.bindings()).filter((binding) => binding.status === "claimed");
			expect(claimed).toHaveLength(1);
			return claimed[0]!.identity.runAnchor;
		},
	};
	await self.start(native ? "lease-1" : undefined);
	return self;
}
type Desk = Awaited<ReturnType<typeof desk>>;

/** Holds the stand-in computer's next answer until the returned gate opens. */
function holdNext(space: Desk, what: string, outcome: NativeOutcome = COMPLETED) {
	const gate = waits().gate(what);
	space.computer.next = async () => {
		await gate.opened;
		return outcome;
	};
	return gate;
}

const storageOf = (instance: Pim) => (instance as unknown as { ctx: DurableObjectState }).ctx.storage;

/** A new chat's run whose call is held when it is stopped, while `broker` answers `answer`; resolves with the run once the Stop and turn end. */
async function stoppedRun(space: Desk, scripted: ReturnType<typeof broker>, answer: (request: NativeFenceRequest) => Promise<unknown>) {
	scripted.answer = answer;
	const chat = await space.chat();
	const call = holdNext(space, "a stopped run's call");
	const before = space.computer.sent.length;
	const turn = space.turn(chat);
	await until(() => expect(space.computer.sent).toHaveLength(before + 1));
	const run = await space.claimedRun();
	const stopping = space.post(`/sessions/${chat}/abort`);
	await until(async () => expect((await space.fence(run))?.state).not.toBe("open"));
	call.open();
	await bounded(stopping, 5_000, "the Stop");
	await bounded(turn, 5_000, "the turn");
	return run;
}

/** The fence's state as SQLite holds it now, synced or not. */
const stored = (space: Desk, run: string) => space.within((instance) => String(storageOf(instance).sql.exec("SELECT state FROM pim_native_fences WHERE run = ?", run).one().state));
/** The faults SQLite holds now. */
const faults = (space: Desk) => space.within((instance) => storageOf(instance).sql.exec("SELECT why FROM pim_native_fence_faults").toArray());
/** Makes SQL statements starting with any of `prefixes` throw before SQLite sees them, in the space's current instance. */
const failWrites = (space: Desk, ...prefixes: string[]) =>
	space.within((instance) => {
		const sql = storageOf(instance).sql;
		const exec = sql.exec.bind(sql);
		vi.spyOn(sql, "exec").mockImplementation((query: string, ...bindings: unknown[]) => {
			if (prefixes.some((prefix) => query.startsWith(prefix))) throw new Error("injected: the write failed");
			return exec(query, ...bindings);
		});
	});

afterEach(() => {
	faux.setResponses([]);
	vi.restoreAllMocks();
});

describe("native fences, through Pim's Stop and Delete", () => {
	it("requires the fence of the run a Stop marked, durably before the Stop waits for idle, once however often asked, and a scripted broker's echo confirms it", async () => {
		const brokerA = broker("broker-A");
		const space = await desk("fencestop", { broker: brokerA });
		const ack = waits().gate("broker answers");
		brokerA.answer = async (request) => {
			await ack.opened;
			return { ...request };
		};
		const call = holdNext(space, "the call's answer");
		const turn = space.turn(space.root);
		await until(() => expect(space.computer.sent).toHaveLength(1));
		const run = await space.claimedRun();
		// Admitted, so recorded, under the instance the transport names; nothing required yet.
		expect(await space.fences()).toEqual([{ run, instance: "broker-A", state: "open", fenceId: null, reason: null, requiredAt: null, confirmedAt: null }]);

		// What each sync found, and whether the Stop had answered by then.
		let answered = false;
		const syncs: { state: string | undefined; answered: boolean }[] = [];
		await space.within((instance) => {
			const storage = storageOf(instance);
			const sync = storage.sync.bind(storage);
			vi.spyOn(storage, "sync").mockImplementation(async () => {
				await sync();
				syncs.push({ state: instance.nativeFences.list().find((record) => record.run === run)?.state, answered });
			});
		});
		const stopping = space.post<{ aborted: boolean }>(`/sessions/${space.root}/abort`).then((response) => {
			answered = true;
			return response;
		});
		await until(async () => expect((await space.fence(run))?.state).toBe("pending"));
		const required = (await space.fence(run))!;
		expect(required).toMatchObject({ reason: "stop", instance: "broker-A", fenceId: expect.any(String), requiredAt: expect.any(Number) });
		await until(() => expect(syncs).toContainEqual({ state: "pending", answered: false }));
		expect(brokerA.asked).toEqual([{ fenceId: required.fenceId, run, instance: "broker-A" }]);
		// The Stop waits for idle, which waits on the held call: it hasn't answered.
		await sleep(50);
		expect(answered).toBe(false);

		// Stopped again while the call is held: the companion reports the same run marked, and it keeps its one fence.
		const again = space.post<{ aborted: boolean }>(`/sessions/${space.root}/abort`);
		await sleep(50);
		expect((await space.fences()).map((record) => [record.run, record.fenceId])).toEqual([[run, required.fenceId]]);

		call.open();
		expect(await bounded(stopping, 5_000, "the Stop")).toEqual({ status: 200, body: { aborted: true } });
		expect(await bounded(again, 5_000, "the second Stop")).toEqual({ status: 200, body: { aborted: true } });
		await bounded(turn, 5_000, "the turn");
		expect(await space.fence(run)).toMatchObject({ state: "pending", fenceId: required.fenceId });

		ack.open();
		await until(async () => expect((await space.fence(run))?.state).toBe("confirmed"));
		expect(await space.fence(run)).toMatchObject({ fenceId: required.fenceId, reason: "stop", confirmedAt: expect.any(Number) });
		expect(brokerA.asked).toHaveLength(1);
		// The call itself had a known end, sent once.
		expect((await space.bindings()).map((binding) => binding.status)).toEqual(["closed"]);
		expect(space.computer.sent).toHaveLength(1);

		// A run of the chat after the Stop is another run, admitted afresh; the fenced run admits nothing more.
		await space.turn(space.root);
		const runs = (await space.fences()).map((record) => record.run);
		expect(runs).toHaveLength(2);
		expect(space.computer.sent).toHaveLength(2);
		expect(await space.within((instance) => instance.nativeFences.admit(run))).toMatch(/fence was required for this run/);
	});

	it("fences the run the companion reports marked: an operation placed into a newer run fences that run, and Delete fences its chat's", async () => {
		const brokerA = broker("broker-A");
		const space = await desk("fencerace", { broker: brokerA });

		// Run 1 reads the desktop and is still at work while op-F is queued behind it.
		const model = waits().gate("run 1's last answer");
		faux.setResponses([
			() => toolUse("desktop_list_apps", {}),
			async () => {
				await model.opened;
				return toolUse("send_to_user", { message: "One." });
			},
			() => toolUse("desktop_list_apps", {}),
			() => toolUse("send_to_user", { message: "Two." }),
		]);
		const first = space.post(`/sessions/${space.root}/messages`, { content: "First", wait: true }).catch((error: unknown) => error);
		await until(() => expect(space.computer.sent).toHaveLength(1));
		await until(async () => expect((await space.bindings()).map((binding) => binding.status)).toEqual(["closed"]));
		const run1 = (await space.bindings())[0]!.identity.runAnchor;
		expect(await space.post(`/sessions/${space.root}/messages`, { content: "Second", operationId: "op-F", whenBusy: "followUp" })).toMatchObject({ status: expect.any(Number) });

		// Run 1 ends; op-F is placed into run 2, whose call is held when op-F's Stop comes.
		const call = holdNext(space, "run 2's call");
		model.open();
		await bounded(first, 5_000, "run 1");
		await until(() => expect(space.computer.sent).toHaveLength(2));
		const run2 = await space.claimedRun();
		expect(run2).not.toBe(run1);
		const stopping = space.post(`/sessions/${space.root}/abort`, { operationId: "op-F" });
		await until(async () => expect((await space.fence(run2))?.state).toBe("confirmed"));
		call.open();
		expect(await bounded(stopping, 5_000, "op-F's Stop")).toEqual({ status: 200, body: { aborted: true } });
		// Run 1 had calls admitted too, and isn't the one marked: it stays open.
		expect(await space.fence(run1)).toMatchObject({ state: "open", fenceId: null });
		expect(await space.fence(run2)).toMatchObject({ state: "confirmed", reason: "stop" });

		// A chat deleted while its call is held: Delete stops it through the same companion, and its run's fence is required.
		const chat = await space.chat();
		const held = holdNext(space, "the deleted chat's call");
		const turn = space.turn(chat);
		await until(() => expect(space.computer.sent).toHaveLength(3));
		const run3 = await space.claimedRun();
		const deleting = space.api(`/sessions/${chat}`, { method: "DELETE" });
		await until(async () => expect((await space.fence(run3))?.state).toBe("confirmed"));
		held.open();
		expect((await bounded(deleting, 5_000, "the Delete")).status).toBe(200);
		await bounded(turn, 5_000, "the deleted chat's turn");
		expect(brokerA.asked.map((request) => request.run)).toEqual([run2, run3]);
		expect(space.computer.sent).toHaveLength(3);
	});

	it("fences a run whose call has no known end at once, sends nothing more of it, and replays nothing", async () => {
		const brokerA = broker("broker-A");
		const space = await desk("fenceunknown", { broker: brokerA });
		space.computer.next = async () => ({ status: "unknown", reason: "timeout" });
		faux.setResponses([() => toolUse("desktop_list_apps", {}), () => toolUse("desktop_list_apps", {}), () => toolUse("send_to_user", { message: "Ok." })]);
		await space.post(`/sessions/${space.root}/messages`, { content: "Twice", wait: true });
		// The run's second call is refused before it is bound.
		const [unknown, ...more] = await space.bindings();
		expect([unknown!.status, more]).toEqual(["unknown", []]);
		const run = unknown!.identity.runAnchor;
		expect(await space.fence(run)).toMatchObject({ state: "confirmed", reason: "unknown" });
		expect(brokerA.asked).toEqual([{ fenceId: (await space.fence(run))!.fenceId, run, instance: "broker-A" }]);
		// Sent once; the run's second call never reached the computer, and nothing sends the first again.
		expect(space.computer.sent).toHaveLength(1);
		await space.restart();
		expect((await space.bindings()).map((binding) => binding.status)).toEqual(["unknown"]);
		expect(space.computer.sent).toHaveLength(1);
	});

	it("counts an acknowledgement only for its own fence, run and instance, once synced; asks again by the same fence ID after a lost answer; and a new instance clears nothing of the old", async () => {
		const brokerA = broker("broker-A");
		const space = await desk("fenceacks", { broker: brokerA });
		const stopped = (answer: (request: NativeFenceRequest) => Promise<unknown>) => stoppedRun(space, brokerA, answer);
		const echo = async (request: NativeFenceRequest) => ({ ...request });
		const wrong: [string, (request: NativeFenceRequest) => Promise<unknown>][] = [
			["another fence", async (request) => ({ ...request, fenceId: "another-fence" })],
			["another run", async (request) => ({ ...request, run: "999999" })],
			["another instance", async (request) => ({ ...request, instance: "broker-B" })],
			["more than the request", async (request) => ({ ...request, done: true })],
			["a lost answer", async () => Promise.reject(new Error("the answer was lost"))],
		];
		const runs: string[] = [];
		for (const [what, answer] of wrong) {
			const run = await stopped(answer);
			runs.push(run);
			await until(async () => expect((await space.fence(run))?.state, what).toBe("unconfirmed"));
		}
		const unconfirmed = await space.fences();

		// The space starts again: before it admits anything, it asks for each unconfirmed fence again, by the same fence ID, and the right echo confirms each.
		brokerA.answer = echo;
		await space.restart();
		const asked = brokerA.asked.length;
		await space.turn(await space.chat());
		await until(async () => expect((await space.fences()).filter((record) => runs.includes(record.run)).map((record) => record.state)).toEqual(runs.map(() => "confirmed")));
		expect(brokerA.asked.slice(asked).filter((request) => runs.includes(request.run))).toEqual(
			expect.arrayContaining(unconfirmed.filter((record) => runs.includes(record.run)).map((record) => ({ fenceId: record.fenceId, run: record.run, instance: "broker-A" }))),
		);
		for (const record of unconfirmed) expect((await space.fence(record.run))!.fenceId).toBe(record.fenceId);

		// A lost answer under broker-A, then the broker comes back as broker-B: after a restart, the old instance's fence can't be confirmed by
		// asking the new one, a new run is admitted under the new instance, and the fences the old instance acknowledged stay confirmed.
		const lost = await stopped(async () => Promise.reject(new Error("the answer was lost")));
		await until(async () => expect((await space.fence(lost))?.state).toBe("unconfirmed"));
		const lostFence = (await space.fence(lost))!.fenceId;
		brokerA.answer = echo;
		brokerA.now = "broker-B";
		await space.restart();
		const sent = space.computer.sent.length;
		await space.turn(await space.chat());
		expect(space.computer.sent).toHaveLength(sent + 1);
		expect(await space.fence(lost)).toMatchObject({ state: "unconfirmed", fenceId: lostFence });
		expect(brokerA.asked.filter((request) => request.instance === "broker-B")).toEqual([]);
		for (const run of runs) expect((await space.fence(run))?.state).toBe("confirmed");
		expect((await space.fences()).find((record) => record.instance === "broker-B")).toMatchObject({ state: "open" });
		// A run whose calls were admitted under the old instance admits none under the new one.
		const older = (await space.fences()).find((record) => record.instance === "broker-A" && record.state === "open")!;
		expect(await space.within((instance) => instance.nativeFences.admit(older.run))).toMatch(/admitted under another broker instance/);
	});

	it("counts a confirmation only once it is durable: read as before while its sync is held, undone when the sync fails, and what storage keeps after a restart", async () => {
		const brokerA = broker("broker-A");
		const space = await desk("fencedurable", { broker: brokerA });
		/** Holds the sync that follows the run's confirmation being written, then lets it resolve or fail. */
		const holdConfirmingSync = async (run: string, then: "resolve" | "reject") => {
			const held = waits().gate("the confirmation's sync");
			await space.within((instance) => {
				const storage = storageOf(instance);
				const sync = storage.sync.bind(storage);
				let armed = true;
				vi.spyOn(storage, "sync").mockImplementation(async () => {
					if (armed && String(storage.sql.exec("SELECT state FROM pim_native_fences WHERE run = ?", run).one().state) === "confirmed") {
						armed = false;
						await held.opened;
						if (then === "reject") throw new Error("injected: sync failed");
					}
					return sync();
				});
			});
			return held;
		};
		const heldEcho = () => {
			const gate = waits().gate("the echo");
			return { gate, answer: async (request: NativeFenceRequest) => (await gate.opened, { ...request }) };
		};

		// Its sync held: SQLite holds the confirmation, and the fences read pending until the sync resolves.
		const first = heldEcho();
		const confirming = await stoppedRun(space, brokerA, first.answer);
		const synced = await holdConfirmingSync(confirming, "resolve");
		first.gate.open();
		await until(async () => expect(await stored(space, confirming)).toBe("confirmed"));
		expect(await space.fence(confirming)).toMatchObject({ state: "pending", confirmedAt: null });
		await sleep(50);
		expect(await space.fence(confirming)).toMatchObject({ state: "pending", confirmedAt: null });
		synced.open();
		await until(async () => expect(await space.fence(confirming)).toMatchObject({ state: "confirmed", confirmedAt: expect.any(Number) }));
		vi.restoreAllMocks();
		await space.start();

		// Its sync failing: it reads pending throughout, the write is undone, and the process latches.
		const second = heldEcho();
		const failing = await stoppedRun(space, brokerA, second.answer);
		const failed = await holdConfirmingSync(failing, "reject");
		second.gate.open();
		await until(async () => expect(await stored(space, failing)).toBe("confirmed"));
		expect(await space.fence(failing)).toMatchObject({ state: "pending", confirmedAt: null });
		failed.open();
		await until(async () => expect(await space.within((instance) => instance.nativeFences.blocked())).toMatch(/acknowledgement couldn't be stored/));
		expect([await stored(space, failing), (await space.fence(failing))?.state]).toEqual(["pending", "pending"]);

		// After a restart, storage holds the undone write, pending, never a confirmation from the failed sync. The restart asks for the fence again
		// by its own ID, and the echo it gets now, synced, confirms it. (Here the fault row was stored too, so nothing is admitted.)
		vi.restoreAllMocks();
		await space.restart();
		expect([await stored(space, failing), await stored(space, confirming)]).toEqual(["pending", "confirmed"]);
		brokerA.answer = async (request) => ({ ...request });
		await space.turn(await space.chat());
		await until(async () => expect(await space.fence(failing)).toMatchObject({ state: "confirmed" }));
		expect(brokerA.asked.filter((request) => request.run === failing).map((request) => request.fenceId)).toEqual([(await space.fence(failing))!.fenceId, (await space.fence(failing))!.fenceId]);
	});

	it("fails closed in the process when Pim's own record fails: a failed write or sync admits nothing more, and quota saturation refuses admission and keeps every record", async () => {
		// A Stop whose fence write is refused: the Stop answers as before, nothing is asked of the broker, and nothing more is admitted.
		const brokerA = broker("broker-A");
		const written = await desk("fencewrite", { broker: brokerA });
		let call = holdNext(written, "the call's answer");
		let turn = written.turn(written.root);
		await until(() => expect(written.computer.sent).toHaveLength(1));
		const run = await written.claimedRun();
		await failWrites(written, "UPDATE pim_native_fences SET state = ?, fence_id");
		let stopping = written.post(`/sessions/${written.root}/abort`);
		await until(async () => expect(await written.within((instance) => instance.nativeFences.blocked())).toMatch(/couldn't be stored/));
		call.open();
		expect(await bounded(stopping, 5_000, "the Stop")).toEqual({ status: 200, body: { aborted: true } });
		await bounded(turn, 5_000, "the turn");
		vi.restoreAllMocks();
		await written.start();
		expect(await written.fence(run)).toMatchObject({ state: "open", fenceId: null });
		expect(brokerA.asked).toEqual([]);
		await written.turn(await written.chat());
		expect(written.computer.sent).toHaveLength(1);
		expect((await written.bindings()).map((binding) => binding.status)).toEqual(["closed", "closed"]);

		// A Stop whose fence write is kept and whose sync fails: the same.
		const brokerS = broker("broker-A");
		const synced = await desk("fencesync", { broker: brokerS });
		call = holdNext(synced, "the call's answer");
		turn = synced.turn(synced.root);
		await until(() => expect(synced.computer.sent).toHaveLength(1));
		const syncRun = await synced.claimedRun();
		await synced.within((instance) => {
			const storage = storageOf(instance);
			const sync = storage.sync.bind(storage);
			let armed = true;
			vi.spyOn(storage, "sync").mockImplementation(async () => {
				if (armed && instance.nativeFences.list().find((record) => record.run === syncRun)?.state === "pending") {
					armed = false;
					throw new Error("injected: sync failed");
				}
				return sync();
			});
		});
		stopping = synced.post(`/sessions/${synced.root}/abort`);
		await until(async () => expect(await synced.within((instance) => instance.nativeFences.blocked())).toMatch(/couldn't be stored/));
		call.open();
		expect(await bounded(stopping, 5_000, "the Stop")).toEqual({ status: 200, body: { aborted: true } });
		await bounded(turn, 5_000, "the turn");
		expect(brokerS.asked).toEqual([]);
		await synced.turn(await synced.chat());
		expect(synced.computer.sent).toHaveLength(1);

		// Every record kept: a run more is refused before anything is admitted or sent, and none is let go.
		const full = await desk("fencefull", { broker: broker("broker-A") });
		const seeded = await full.within((instance) => {
			instance.nativeFences.list();
			const sql = storageOf(instance).sql;
			for (let index = 0; index < MAX_NATIVE_FENCES; index++) {
				sql.exec("INSERT INTO pim_native_fences (run, instance, state, fence_id, reason, required_at) VALUES (?, 'broker-old', 'unconfirmed', ?, 'recovered', 0)", `synthetic-${index}`, `fence-${index}`);
			}
			return instance.nativeFences.list();
		});
		await full.turn(full.root);
		expect(full.computer.sent).toEqual([]);
		expect((await full.bindings()).map((binding) => binding.status)).toEqual(["closed"]);
		expect(await full.fences()).toEqual(seeded);
	});

	it("after a fault, a restart stays closed only where the fault was stored, and otherwise rebuilds from the binder and admits new runs", async () => {
		/** A space whose Stop's fence write fails, with the fault row's own write failing too when `faultLost`; restarted after. */
		const faulted = async (username: string, faultLost: boolean) => {
			const scripted = broker("broker-A");
			const space = await desk(username, { broker: scripted });
			const call = holdNext(space, "the call's answer");
			const turn = space.turn(space.root);
			await until(() => expect(space.computer.sent).toHaveLength(1));
			const run = await space.claimedRun();
			await failWrites(space, "UPDATE pim_native_fences SET state = ?, fence_id", ...(faultLost ? ["INSERT INTO pim_native_fence_faults"] : []));
			const stopping = space.post(`/sessions/${space.root}/abort`);
			await until(async () => expect(await space.within((instance) => instance.nativeFences.blocked())).toMatch(/couldn't be stored/));
			call.open();
			await bounded(stopping, 5_000, "the Stop");
			await bounded(turn, 5_000, "the turn");
			vi.restoreAllMocks();
			await space.restart();
			return { space, run, scripted };
		};

		// The fault row was stored: the restart keeps native calls closed, and says why.
		const kept = await faulted("fencekept", false);
		expect(await faults(kept.space)).toEqual([{ why: "a native fence couldn't be stored" }]);
		await kept.space.turn(await kept.space.chat());
		expect(kept.space.computer.sent).toHaveLength(1);
		expect(await kept.space.within((instance) => instance.nativeFences.blocked())).toMatch(/stay closed until a reconciliation policy reopens them/);
		// The Stop's own fence, lost with its write, isn't made up again; the run's call had a known end, so nothing of it is outstanding.
		expect(await kept.space.fence(kept.run)).toMatchObject({ state: "open", fenceId: null });
		expect((await kept.space.bindings()).map((binding) => binding.status)).toEqual(["closed", "closed"]);

		// The fault row was lost too: nothing records that a fault happened, so nothing claims a stored latch. The restart rebuilds from the binder,
		// finds no call of unknown end, and admits a new run under the same instance.
		const lost = await faulted("fencelost", true);
		expect(await faults(lost.space)).toEqual([]);
		await lost.space.turn(await lost.space.chat());
		expect(lost.space.computer.sent).toHaveLength(2);
		expect(await lost.space.within((instance) => instance.nativeFences.blocked())).toBeNull();
		expect(await lost.space.fence(lost.run)).toMatchObject({ state: "open", fenceId: null });
		expect(lost.scripted.asked).toEqual([]);

		// A fence whose write was kept and whose sync failed: the restart finds it pending and asks for it by its own ID, and stays closed.
		const scripted = broker("broker-A");
		const space = await desk("fencekeptsync", { broker: scripted });
		const call = holdNext(space, "the call's answer");
		const turn = space.turn(space.root);
		await until(() => expect(space.computer.sent).toHaveLength(1));
		const run = await space.claimedRun();
		await space.within((instance) => {
			const storage = storageOf(instance);
			const sync = storage.sync.bind(storage);
			let armed = true;
			vi.spyOn(storage, "sync").mockImplementation(async () => {
				if (armed && instance.nativeFences.list().find((record) => record.run === run)?.state === "pending") {
					armed = false;
					throw new Error("injected: sync failed");
				}
				return sync();
			});
		});
		const stopping = space.post(`/sessions/${space.root}/abort`);
		await until(async () => expect(await space.within((instance) => instance.nativeFences.blocked())).toMatch(/couldn't be stored/));
		call.open();
		await bounded(stopping, 5_000, "the Stop");
		await bounded(turn, 5_000, "the turn");
		vi.restoreAllMocks();
		await space.restart();
		expect([await stored(space, run), await faults(space)]).toEqual(["pending", [{ why: "a native fence couldn't be stored" }]]);
		await space.turn(await space.chat());
		await until(async () => expect((await space.fence(run))?.state).toBe("confirmed"));
		expect(scripted.asked.map((request) => request.run)).toEqual([run]);
		expect(space.computer.sent).toHaveLength(1);
	});

	it("after a crash between the Stop's mark and Pim's write, the restart fences each run with a call claimed and unanswered, admits nothing before, and replays nothing", async () => {
		const brokerA = broker("broker-A");
		const space = await desk("fencecrash", { broker: brokerA });

		// A marking commit that fails: the Stop fails as abort() would, nothing is required, and the call goes on to its end.
		let call = holdNext(space, "the first call's answer");
		let turn = space.turn(space.root);
		await until(() => expect(space.computer.sent).toHaveLength(1));
		const first = await space.claimedRun();
		await space.within((instance) => {
			const sessions = Object.getPrototypeOf(instance.harness.session(space.root)) as { abortWithEffect: () => Promise<unknown> };
			vi.spyOn(sessions, "abortWithEffect").mockRejectedValueOnce(new Error("injected: the marking commit was refused"));
		});
		expect((await space.post(`/sessions/${space.root}/abort`)).status).toBe(500);
		vi.restoreAllMocks();
		await space.start();
		expect(await space.fence(first)).toMatchObject({ state: "open", fenceId: null });
		call.open();
		await bounded(turn, 5_000, "the first turn");
		expect(brokerA.asked).toEqual([]);

		// The process ends right after the Stop's marking commit, before Pim writes the fence; the held call never answers in it.
		space.computer.next = () => new Promise<NativeOutcome>(() => undefined);
		const chat = await space.chat();
		turn = space.turn(chat);
		await until(() => expect(space.computer.sent).toHaveLength(2));
		const crashed = await space.claimedRun();
		let marked = false;
		await space.within((instance) => {
			vi.spyOn(instance.nativeFences, "require").mockImplementation(() => {
				marked = true;
				return new Promise<void>(() => undefined);
			});
		});
		const stopping = space.post(`/sessions/${chat}/abort`).catch((error: unknown) => error);
		await until(() => expect(marked).toBe(true));
		vi.restoreAllMocks();
		space.computer.next = async () => COMPLETED;
		await space.restart();
		await bounded(Promise.all([stopping, turn]), 5_000, "the requests the restart ended");
		expect(await space.fence(crashed)).toMatchObject({ state: "open", fenceId: null });
		expect((await space.bindings()).find((binding) => binding.identity.runAnchor === crashed)?.status).toBe("claimed");

		// The control state blocks every agent's request until the operator settles the request it lost with the crash, as before this change;
		// settled here from the stand-in's own record that it was sent. That reopens other runs, never the crashed one.
		await space.within((instance) => {
			const lost = instance.control.state!.requests.find((request) => request.runId === crashed)!;
			instance.control.apply({ type: "reconcile_request", requestId: lost.requestId, resolution: "completed", evidence: "the test's stand-in recorded it sent" });
		});

		// Until it can read the binder's records, the restarted space admits nothing.
		const unknownRuns = vi.spyOn(NativeIdentityBinder.prototype, "unknownRuns").mockReturnValueOnce("injected: the bindings can't be read");
		await space.turn(await space.chat());
		expect(space.computer.sent).toHaveLength(2);
		expect(await space.within((instance) => instance.nativeFences.blocked())).toMatch(/haven't been reconciled/);
		expect(unknownRuns).toHaveBeenCalledTimes(1);
		unknownRuns.mockRestore();

		// Then it fences the run whose call it can't see the end of, as recovered, before it admits a new run's call; that call is never sent again.
		await space.turn(await space.chat());
		expect(space.computer.sent).toHaveLength(3);
		expect((await space.bindings()).find((binding) => binding.identity.runAnchor === crashed)?.status).toBe("unknown");
		await until(async () => expect((await space.fence(crashed))?.state).toBe("confirmed"));
		expect(await space.fence(crashed)).toMatchObject({ reason: "recovered" });
		expect(brokerA.asked.map((request) => request.run)).toEqual([crashed]);
		expect(await space.fence(first)).toMatchObject({ state: "open", fenceId: null });
		expect(space.computer.sent.map((each) => each.tool)).toEqual(["list_apps", "list_apps", "list_apps"]);
	});
	it("checks the run's fence again at the send itself, after the computer's wake and the admission's sync: a fence, a fault or a new instance by then sends nothing", async () => {
		const brokerA = broker("broker-A");
		const space = await desk("fencegate", { broker: brokerA });
		/** A call of a new chat whose wake (or admission sync) is held while `change` is made; resolves once its turn ends, with its run. */
		const whileHeld = async (where: "wake" | "admission", change: (instance: Pim, run: string) => unknown) => {
			const chat = await space.chat();
			const held = waits().gate(`held ${where}`);
			let reached = false;
			const known = new Set((await space.fences()).map((record) => record.run));
			if (where === "wake") {
				space.computer.wake = async () => {
					reached = true;
					await held.opened;
				};
			} else {
				await space.within((instance) => {
					const storage = storageOf(instance);
					const sync = storage.sync.bind(storage);
					let armed = true;
					vi.spyOn(storage, "sync").mockImplementation(async () => {
						// The admission's own sync: the first after a new run's record is written.
						if (armed && instance.nativeFences.list().some((record) => !known.has(record.run))) {
							armed = false;
							reached = true;
							await held.opened;
						}
						return sync();
					});
				});
			}
			const turn = space.turn(chat);
			await until(() => expect(reached).toBe(true));
			const run = (await space.fences()).map((record) => record.run).find((each) => !known.has(each))!;
			await space.within((instance) => change(instance, run));
			held.open();
			await bounded(turn, 5_000, `the ${where} turn`);
			space.computer.wake = async () => undefined;
			vi.restoreAllMocks();
			await space.start();
			return run;
		};
		const sent = () => space.computer.sent.length;
		const closed = async (run: string) => (await space.bindings()).filter((binding) => binding.identity.runAnchor === run).map((binding) => binding.status);

		// Its run's fence required while the computer wakes, with no Stop of the harness's to refuse it: the send's check does.
		const fenced = await whileHeld("wake", (instance, run) => instance.nativeFences.require([run], "unknown"));
		expect([sent(), await closed(fenced)]).toEqual([0, ["closed"]]);
		// The broker replaced while the computer wakes.
		const replaced = await whileHeld("wake", () => void (brokerA.now = "broker-B"));
		expect([sent(), await closed(replaced)]).toEqual([0, ["closed"]]);
		brokerA.now = "broker-A";
		// The same two while the admission's sync is held, after its checks and before the control state admits the call.
		const fencedEarly = await whileHeld("admission", (instance, run) => instance.nativeFences.require([run], "unknown"));
		expect([sent(), await closed(fencedEarly)]).toEqual([0, ["closed"]]);
		const replacedEarly = await whileHeld("admission", () => void (brokerA.now = "broker-B"));
		expect([sent(), await closed(replacedEarly)]).toEqual([0, ["closed"]]);
		brokerA.now = "broker-A";
		// A call unhindered still goes, once.
		await space.turn(await space.chat());
		expect(sent()).toBe(1);
		// A fence write that fails while the computer wakes: the fault stops the send.
		const faulted = await whileHeld("wake", (instance) => {
			const sql = storageOf(instance).sql;
			const exec = sql.exec.bind(sql);
			const failing = vi.spyOn(sql, "exec").mockImplementation((query: string, ...bindings: unknown[]) => {
				if (query.startsWith("INSERT INTO pim_native_fences")) throw new Error("injected: the write failed");
				return exec(query, ...bindings);
			});
			return instance.nativeFences.require(["synthetic-elsewhere"], "unknown").finally(() => failing.mockRestore());
		});
		expect([sent(), await closed(faulted)]).toEqual([1, ["closed"]]);
		expect(await space.within((instance) => instance.nativeFences.blocked())).toMatch(/couldn't be stored/);
	});

	it("waits a bounded time for an acknowledgement: unanswered, the fence is unconfirmed and asked for again by the same ID; one answered late still counts", async () => {
		const brokerA = broker("broker-A");
		const space = await desk("fencebound", { broker: brokerA });
		await space.within((instance) => vi.spyOn(instance as unknown as { nativeFenceAskMs(): number }, "nativeFenceAskMs").mockReturnValue(100));
		// The first fence asked for is never answered; every other is answered once `late` opens.
		const late = waits().gate("the late answer");
		let silentFence: string | null = null;
		brokerA.answer = (request) => {
			silentFence ??= request.fenceId;
			return request.fenceId === silentFence ? new Promise(() => undefined) : late.opened.then(() => ({ ...request }));
		};
		const stop = async (chat: string) => {
			const call = holdNext(space, "the call");
			const before = space.computer.sent.length;
			const turn = space.turn(chat);
			await until(() => expect(space.computer.sent).toHaveLength(before + 1));
			const run = await space.claimedRun();
			const stopping = space.post(`/sessions/${chat}/abort`);
			await until(async () => expect((await space.fence(run))?.state).not.toBe("open"));
			call.open();
			await bounded(stopping, 5_000, "the Stop");
			await bounded(turn, 5_000, "the turn");
			return run;
		};
		// A broker that never answers: unconfirmed once the wait is over.
		const silent = await stop(await space.chat());
		await until(async () => expect((await space.fence(silent))?.state).toBe("unconfirmed"));
		const fenceId = (await space.fence(silent))!.fenceId;
		// The next fence asked for asks for the silent one again, by its own ID, since its first ask is over; the next one's answer comes late.
		const slow = await stop(await space.chat());
		await until(async () => expect((await space.fence(slow))?.state).toBe("unconfirmed"));
		expect(brokerA.asked.filter((request) => request.run === silent)).toEqual([
			{ fenceId, run: silent, instance: "broker-A" },
			{ fenceId, run: silent, instance: "broker-A" },
		]);
		late.open();
		await until(async () => expect((await space.fence(slow))?.state).toBe("confirmed"));
		expect((await space.fence(silent))?.state).toBe("unconfirmed");
	});

	it("fences through every path that stops a chat: its seats on Stop and Delete, a seat taken out, a canceled task, a deleted agent's task, suspension and the socket", async () => {
		const brokerA = broker("broker-A");
		const space = await desk("fencepaths", { broker: brokerA });
		const coach = (await space.post<{ id: string }>("/agents", { name: "Coach", description: "Plans runs", instructions: "Plan runs." })).body;
		/** `start` begins work whose call of the desktop is held; `stop` is the path; the held call's run must be fenced by a Stop, and the call sent once. */
		const through = async (what: string, start: () => Promise<unknown>, stop: () => Promise<unknown>) => {
			const call = holdNext(space, `${what}: the call`);
			const before = space.computer.sent.length;
			const work = start().catch((error: unknown) => error);
			await until(() => expect(space.computer.sent).toHaveLength(before + 1));
			const run = await space.claimedRun();
			const stopping = stop();
			await until(async () => expect((await space.fence(run))?.state, what).toBe("confirmed"));
			expect((await space.fence(run))?.reason, what).toBe("stop");
			call.open();
			await bounded(Promise.resolve(stopping), 5_000, `${what}: the stop`);
			await bounded(work, 5_000, `${what}: the work`);
			faux.setResponses([]);
			expect(space.computer.sent, what).toHaveLength(before + 1);
		};
		const desktop = () => toolUse("desktop_list_apps", {});
		const done = () => toolUse("send_to_user", { message: "Done." });
		const mention = (chat: string) => {
			scripts({ Coach: [desktop, done] });
			return space.post(`/sessions/${chat}/messages`, { content: "@Coach look at the desktop", wait: true });
		};

		// A group chat's Stop stops its seats.
		const group = await space.chat();
		await through("seat on Stop", () => mention(group), () => space.post(`/sessions/${group}/abort`));
		// A seat taken out of the chat.
		await through("seat taken out", () => mention(group), () => space.api(`/sessions/${group}/room/members/${coach.id}`, { method: "DELETE" }));
		// A chat deleted with a seat in it.
		const deleted = await space.chat();
		await through("seat on Delete", () => mention(deleted), () => space.api(`/sessions/${deleted}`, { method: "DELETE" }));

		// A task the person cancels, and one whose agent is deleted.
		const payer = (await space.post<{ id: string }>("/agents", { name: "Payer", instructions: "Pays." })).body;
		const delegated = async (to: string) => {
			scripts({ lead: [() => toolUse("delegate", { tasks: [{ to, task: "Look at the desktop." }] }), done, done], [to]: [desktop, done] });
			return space.post(`/sessions/${space.root}/messages`, { content: `Ask ${to}`, wait: true });
		};
		const lastTask = async () => (await space.api<{ tasks: { id: string }[] }>(`/sessions/${space.root}/tasks`)).body.tasks.at(-1)!.id;
		await through("canceled task", () => delegated("Payer"), async () => space.post(`/sessions/${space.root}/tasks/${await lastTask()}/cancel`));
		const mover = (await space.post<{ id: string }>("/agents", { name: "Mover", instructions: "Moves." })).body;
		await through("deleted agent's task", () => delegated("Mover"), () => space.api(`/agents/${mover.id}`, { method: "DELETE" }));
		expect(payer.id).not.toBe(mover.id);

		// Suspension stops every chat.
		const suspended = await space.chat();
		await through("suspension", () => space.turn(suspended), () => space.within((instance) => instance.setStatus("suspended")));
		await space.within((instance) => instance.setStatus("active"));

		// The chat's own socket, as the app stops it.
		const socketChat = await space.chat();
		const upgrade = await exports.default.fetch(apiUrl(`/ws?${new URLSearchParams({ token: space.token, session: socketChat })}`), { headers: { Upgrade: "websocket" } });
		const socket = upgrade.webSocket!;
		const results: unknown[] = [];
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data as string) as { type: string; id?: string; result?: unknown };
			if (message.type === "result" && message.id === "stop") results.push(message.result);
		});
		socket.accept();
		await through("socket", () => space.turn(socketChat), async () => {
			socket.send(JSON.stringify({ type: "abort", id: "stop" }));
			await until(() => expect(results).toEqual([true]));
		});
		socket.close();
	});
});

describe("Stop where the desktop's tools are off", () => {
	it("is abort(): the same answers for queued, missing and plain Stops, a queued reset as before, and no fence table", async () => {
		const space = await desk("fenceoff", { native: false });
		const required = await space.within((instance) => vi.spyOn(instance.nativeFences, "require"));
		const first = waits().gate("run 1's answer");
		const second = waits().gate("run 2's answer");
		let asked = 0;
		faux.setResponses([
			async () => {
				asked++;
				await first.opened;
				return toolUse("send_to_user", { message: "One." });
			},
			async () => {
				asked++;
				await second.opened;
				return toolUse("send_to_user", { message: "Two." });
			},
		]);
		const turn = space.post(`/sessions/${space.root}/messages`, { content: "First", operationId: "op-A", wait: true }).catch((error: unknown) => error);
		await until(() => expect(asked).toBe(1));
		await space.post(`/sessions/${space.root}/messages`, { content: "Queued", operationId: "op-Q", whenBusy: "followUp" });
		expect((await space.post(`/sessions/${space.root}/abort`, { operationId: "op-Q" })).body).toEqual({ aborted: true });
		expect((await space.post(`/sessions/${space.root}/abort`, { operationId: "op-missing" })).body).toEqual({ aborted: false });
		expect((await space.post(`/sessions/${space.root}/reset`)).status).toBe(200);
		first.open();
		await bounded(turn, 5_000, "run 1");
		// A plain Stop of a live run marks it, as before; here it is abort() itself, so nothing of the fences is touched.
		const again = space.post(`/sessions/${space.root}/messages`, { content: "Again", wait: true }).catch((error: unknown) => error);
		await until(() => expect(asked).toBe(2));
		const stopping = space.post(`/sessions/${space.root}/abort`);
		await sleep(50);
		second.open();
		expect((await bounded(stopping, 5_000, "the Stop")).body).toEqual({ aborted: true });
		await bounded(again, 5_000, "run 2");
		expect(required).not.toHaveBeenCalled();
		expect(await space.within((instance) => storageOf(instance).sql.exec("SELECT name FROM sqlite_master WHERE name = 'pim_native_fences'").toArray())).toEqual([]);
	});
});
