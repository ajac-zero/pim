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
import { apiUrl, toolUse, waits } from "./helpers";
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
		install(instance: Pim) {
			vi.spyOn(instance.computer, "native").mockImplementation(async (tool: unknown, args: unknown, gate: NativeGate) => {
				const trace = currentTrace();
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
		/** A chat's run whose call is held when it is stopped, while the broker answers `answer`; resolves with the run. */
		const stopped = async (answer: (request: NativeFenceRequest) => Promise<unknown>) => {
			brokerA.answer = answer;
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
		};
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

		// An echo whose recording fails to sync isn't counted: what this process reads goes back to pending, and nothing more is admitted here.
		const ack = waits().gate("the last echo");
		const last = await stopped(async (request) => {
			await ack.opened;
			return { ...request };
		});
		await space.within((instance) => {
			const storage = storageOf(instance);
			const sync = storage.sync.bind(storage);
			vi.spyOn(storage, "sync").mockImplementation(async () => {
				if (instance.nativeFences.list().find((record) => record.run === last)?.state === "confirmed") throw new Error("injected: sync failed");
				return sync();
			});
		});
		ack.open();
		await until(async () => expect(await space.within((instance) => instance.nativeFences.blocked())).toMatch(/acknowledgement couldn't be stored/));
		expect(await space.fence(last)).toMatchObject({ state: "pending", confirmedAt: null });
		const sent = space.computer.sent.length;
		await space.turn(await space.chat());
		expect(space.computer.sent).toHaveLength(sent);

		// The broker comes back as another instance: after a restart, the old instance's fence can't be confirmed by asking the new one,
		// a new run is admitted under the new instance, and the fences the old instance acknowledged stay confirmed.
		vi.restoreAllMocks();
		brokerA.now = "broker-B";
		await space.restart();
		const fresh = await space.chat();
		await space.turn(fresh);
		expect(space.computer.sent).toHaveLength(sent + 1);
		await until(async () => expect((await space.fence(last))?.state).toBe("unconfirmed"));
		expect(brokerA.asked.filter((request) => request.instance === "broker-B")).toEqual([]);
		for (const run of runs) expect((await space.fence(run))?.state).toBe("confirmed");
		const newest = (await space.fences()).find((record) => record.instance === "broker-B")!;
		expect(newest).toMatchObject({ state: "open" });
		// A run whose calls were admitted under the old instance admits none under the new one.
		const older = (await space.fences()).find((record) => record.instance === "broker-A" && record.state === "open")!;
		expect(await space.within((instance) => instance.nativeFences.admit(older.run))).toMatch(/admitted under another broker instance/);
	});

	it("fails closed when Pim's own record fails: a failed write or sync admits nothing more in the process, and quota saturation refuses admission and keeps every record", async () => {
		// A Stop whose fence write is refused: the Stop answers as before, and nothing more is admitted in this process.
		const brokerA = broker("broker-A");
		const written = await desk("fencewrite", { broker: brokerA });
		let call = holdNext(written, "the call's answer");
		let turn = written.turn(written.root);
		await until(() => expect(written.computer.sent).toHaveLength(1));
		const run = await written.claimedRun();
		await written.within((instance) => {
			const sql = storageOf(instance).sql;
			const exec = sql.exec.bind(sql);
			vi.spyOn(sql, "exec").mockImplementation((query: string, ...bindings: unknown[]) => {
				if (query.startsWith("UPDATE pim_native_fences SET state = ?, fence_id")) throw new Error("injected: the write failed");
				return exec(query, ...bindings);
			});
		});
		let stopping = written.post(`/sessions/${written.root}/abort`);
		await until(async () => expect(await written.within((instance) => instance.nativeFences.blocked())).toMatch(/couldn't be stored/));
		call.open();
		expect(await bounded(stopping, 5_000, "the Stop")).toEqual({ status: 200, body: { aborted: true } });
		await bounded(turn, 5_000, "the turn");
		vi.restoreAllMocks();
		expect(await written.fence(run)).toMatchObject({ state: "open", fenceId: null });
		expect(brokerA.asked).toEqual([]);
		await written.turn(await written.chat());
		expect(written.computer.sent).toHaveLength(1);
		expect((await written.bindings()).map((binding) => binding.status)).toEqual(["closed", "closed"]);
		// A restart rebuilds from the binder's records: the stopped run's call had a known end, so nothing of it needs fencing, and a new run is admitted.
		// The Stop's own fence, lost with the write, isn't made up again.
		await written.restart();
		await written.turn(await written.chat());
		expect(written.computer.sent).toHaveLength(2);
		expect(await written.fence(run)).toMatchObject({ state: "open", fenceId: null });

		// A Stop whose fence write is stored and whose sync fails: nothing is asked of the broker, and nothing more is admitted in this process.
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
		// The stand-in's failed sync didn't lose the write, so the restart finds the fence pending and asks for it, by its own ID.
		vi.restoreAllMocks();
		await synced.restart();
		await synced.turn(await synced.chat());
		await until(async () => expect((await synced.fence(syncRun))?.state).toBe("confirmed"));
		expect(brokerS.asked.map((request) => request.run)).toEqual([syncRun]);

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
