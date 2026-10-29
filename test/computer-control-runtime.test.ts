import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nativeOutcome from "../computer/native-outcome";
import { BRIDGE_MESSAGE_CHARS, NATIVE_TOOL_OP, type NativeOutcome, readNativeRequest } from "../computer/native-outcome";
import type { ExecArgs, ExecResult } from "../computer/pim-computer";
import type { Approval } from "../src/store";
import { Computer, type ComputerLink } from "../src/computer";
import { MAX_MESSAGE_CHARS } from "../src/cua";
import { type ControlStorage, ControlCoordinator, ControlRefused, dispatchTrace } from "../src/computer-control-runtime";
import type { ControlState } from "../src/computer-control";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import { api, connectTestComputer, fakeChrome, OWNER, post, say, toolUse } from "./helpers";
import { faux, type Pim } from "./worker";

// The space's own check of native-app outcomes, as it is, but replaceable for one reply (see "fails closed when checking a native reply throws").
// The module registry is cleared first, before the mock is registered and before anything here is imported. Vitest resets modules before
// each file, but a Durable Object of an earlier file that wakes before this file's mocks are registered imports the Worker, and with it
// src/computer.ts, through the same module runner; cached, that src/computer.ts would keep the real check, and the mock would never reach it.
vi.hoisted(() => vi.resetModules());
vi.mock("../computer/native-outcome", async (original) => {
	const actual = await original<typeof import("../computer/native-outcome")>();
	return { ...actual, readNativeOutcome: vi.fn(actual.readNativeOutcome) };
});

/**
 * The control state on the paths agents really use: approved actions, file
 * tools and browser tools, over a computer that is the tests' own end of the
 * real transport. Nothing here runs a process or a browser: a request reaching
 * `ran`, or a DevTools message reaching `chrome`, was received by a fixture,
 * which is a transport receipt and says nothing about what a real machine
 * would then do or stop doing.
 */

const agent = () => env.Pim.getByName(OWNER);
const inSpace = <T>(fn: (instance: Pim) => T | Promise<T>) => runInDurableObject(agent(), (instance: Pim) => fn(instance));

const ran: ExecArgs[] = [];
/** The computer's browser: an in-process DevTools peer that records what reaches it. */
const chrome = fakeChrome();
let gate: Promise<void> | null = null;
const ok: ExecResult = { exitCode: 0, signal: null, stdout: "done\n", stderr: "", timedOut: false, truncated: false };

const connect = (token: string) =>
	connectTestComputer(token, `/tmp/computer-control-${crypto.randomUUID()}`, async (args) => {
		ran.push(args);
		await gate;
		return ok;
	}, chrome.host);

let computer: Awaited<ReturnType<typeof connect>>;
let token = "";

function lastToolResult(messages: readonly Message[]) {
	const result = messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("no tool result");
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The agent calls `name`; resolves once it is waiting for the person, with the call's result once the turn is over, and what the tool told the model it was. */
function uses(name: string, args: Record<string, unknown>) {
	let result = "";
	let description = "";
	faux.setResponses([
		(context) => {
			// The tool as it was last added to the conversation, which a changed one is again.
			const added = context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []));
			description = added.findLast((tool) => tool.name === name)?.description ?? "";
			return toolUse(name, args as never);
		},
		(context) => {
			result = lastToolResult(context.messages);
			return toolUse("send_to_user", { message: "Ok." });
		},
	]);
	const turn = say(`Use ${name}`);
	return { turn, result: () => result, description: () => description };
}
const useTool = async (name: string, args: Record<string, unknown> = {}) => {
	const call = uses(name, args);
	await call.turn;
	return call.result();
};

/** The agent asks to run `command`; resolves once it is waiting for the person. */
function asksToRun(command: string) {
	let result = "";
	faux.setResponses([
		toolUse("shell", { command }),
		(context) => {
			result = lastToolResult(context.messages);
			return toolUse("send_to_user", { message: "Ok." });
		},
	]);
	const turn = say(`Run ${command}`);
	return { turn, result: () => result };
}

/** The approval waiting for the person; given time, as a busy machine may be slow to file it. */
const pendingApproval = () =>
	vi.waitFor(
		async () => {
			const [approval] = (await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals;
			expect(approval).toBeDefined();
			return approval!;
		},
		{ timeout: 15_000 },
	);

const decide = (id: string) => post(`/approvals/${id}/approve`);
const control = <T>(fn: (state: Pim["control"]) => T) => inSpace((instance) => fn(instance.control));
const grant = (leaseId: string) => control((c) => c.apply({ type: "resume", leaseId }));
const stateOf = async (): Promise<ControlState> => (await control((c) => c.state))!;

describe("a space that has not opted in", () => {
	it("runs approved commands as before, with no control state", async () => {
		({ body: { token } } = await post<{ token: string }>("/computer"));
		computer = await connect(token);
		const asking = asksToRun("echo plain");
		await decide((await pendingApproval()).id);
		await asking.turn;
		expect(ran.map((call) => call.command)).toEqual(["echo plain"]);
		expect(await control((c) => [c.enabled, c.state])).toEqual([false, null]);
	});

	it("browses as before: the browser tools reach the browser with nothing recorded, and agents may ask the person to take over", async () => {
		const opening = uses("browser_open", { url: "https://example.com/" });
		await opening.turn;
		expect(opening.result()).toContain("# Fixture");
		expect(opening.description()).toContain("they choose Take over");
		expect(await useTool("browser_screenshot", { path: "/workspace/plain.png" })).toBe("Saved to /workspace/plain.png.");
		expect(chrome.sent("Page.navigate")).toHaveLength(1);
		expect(chrome.sent("Page.captureScreenshot")).toHaveLength(1);
		expect(await control((c) => [c.enabled, c.state])).toEqual([false, null]);
	});
});

describe("a space that opted in", () => {
	it("keeps agents out while the person has control, which is where it starts", async () => {
		await control((c) => c.enable());
		expect((await stateOf()).owner).toBe("human");
		const before = ran.length;
		const asking = asksToRun("echo no");
		await decide((await pendingApproval()).id);
		await asking.turn;
		expect(ran.length).toBe(before);
		expect(asking.result()).toContain("nothing was sent to it");
		// A refusal is not a request: nothing was admitted.
		expect((await stateOf()).requests).toEqual([]);
	});

	it("records an approved request, dispatches it once, and settles it from the reply", async () => {
		expect(await grant("lease-1")).toEqual({ ok: true });
		const before = ran.length;
		const asking = asksToRun("echo yes");
		const approval = await pendingApproval();
		expect(ran.length).toBe(before);
		await decide(approval.id);
		await asking.turn;
		expect(ran.slice(before).map((call) => call.command)).toEqual(["echo yes"]);
		const state = await stateOf();
		expect(state.requests).toEqual([expect.objectContaining({ requestId: `approval:${approval.id}`, epoch: 1, status: "completed" })]);
		// The agent is the server's record of who the chat talks as, not anything the request carried.
		expect(await inSpace((instance) => instance.agents.majordomo().id)).toBe(state.requests[0]!.agentId);
		// Approving it again is refused by the approval itself, and sends nothing.
		expect((await decide(approval.id)).status).toBe(409);
		expect(ran.length).toBe(before + 1);
	});

	it("does not dispatch an approval granted after a takeover, nor one filed before a takeover and resume", async () => {
		const before = ran.length;
		const afterTakeover = asksToRun("echo late");
		const first = await pendingApproval();
		expect(await control((c) => c.apply({ type: "takeover" }))).toEqual({ ok: true });
		await decide(first.id);
		await afterTakeover.turn;
		expect(afterTakeover.result()).toContain("nothing was sent to it");

		// Control comes back, with a new lease; an approval filed under the old one stays refused.
		expect(await grant("lease-2")).toEqual({ ok: true });
		const fresh = asksToRun("echo fresh");
		const second = await pendingApproval();
		await control((c) => c.apply({ type: "takeover" }));
		await grant("lease-3");
		await decide(second.id);
		await fresh.turn;
		expect(fresh.result()).toContain("nothing was sent to it");
		expect(ran.length).toBe(before);

		// One filed under the current lease still goes through.
		const current = asksToRun("echo current");
		await decide((await pendingApproval()).id);
		await current.turn;
		expect(ran.slice(before).map((call) => call.command)).toEqual(["echo current"]);
	});

	it("gates the file tools too, which need no approval", async () => {
		const write = (message: string) => {
			let result = "";
			faux.setResponses([
				toolUse("file_write", { path: "/workspace/a.txt", content: message }),
				(context) => {
					result = lastToolResult(context.messages);
					return toolUse("send_to_user", { message: "Ok." });
				},
			]);
			return { turn: say("Write a file"), result: () => result };
		};
		const written = write("one");
		await written.turn;
		expect(written.result()).not.toContain("nothing was sent");
		expect((await stateOf()).requests.filter((request) => request.requestId.startsWith("call:"))).toHaveLength(1);
		await control((c) => c.apply({ type: "takeover" }));
		const refused = write("two");
		await refused.turn;
		expect(refused.result()).toContain("nothing was sent to it");
		await grant("lease-4");
	});

	it("blocks on an answer that never came, and does not replay the request", async () => {
		const before = ran.length;
		// The fixture never answers this one; its end of the closed connection has nowhere to reply.
		gate = new Promise<void>(() => undefined);
		const asking = asksToRun("echo hang");
		// Deciding waits for the command, which the fixture holds back.
		const deciding = decide((await pendingApproval()).id);
		await vi.waitFor(() => expect(ran.length).toBe(before + 1));
		// The computer drops off without answering.
		computer.socket.close(1000);
		await computer.closed;
		await deciding;
		await asking.turn;
		const state = await stateOf();
		expect(state.requests.at(-1)).toMatchObject({ status: "unknown" });
		gate = null;

		// Reconnected, new requests are still refused, and the unknown one is not sent again.
		computer = await connect(token);
		const refused = asksToRun("echo blocked");
		await decide((await pendingApproval()).id);
		await refused.turn;
		expect(refused.result()).toContain("nothing was sent to it");
		expect(ran.length).toBe(before + 1);

		// Reconciliation is an explicit event that names what happened; then requests flow again.
		const stuck = state.requests.at(-1)!.requestId;
		expect(await control((c) => c.apply({ type: "reconcile_request", requestId: stuck, resolution: "not_executed", evidence: "fixture log shows the command was abandoned" }))).toEqual({ ok: true });
		const after = asksToRun("echo after");
		await decide((await pendingApproval()).id);
		await after.turn;
		expect(ran.slice(before).map((call) => call.command)).toEqual(["echo hang", "echo after"]);
	});

	it("takes a request that left nothing behind as rejected, not unknown", async () => {
		computer.socket.close(1000);
		await computer.closed;
		await vi.waitFor(async () => expect((await api("/computer")).body.state).toBe("offline"));
		const asking = asksToRun("echo offline");
		await decide((await pendingApproval()).id);
		await asking.turn;
		expect((await stateOf()).requests.at(-1)).toMatchObject({ status: "rejected" });
		computer = await connect(token);
		// Rejected is definitive: admissions stay open.
		const again = asksToRun("echo back");
		await decide((await pendingApproval()).id);
		await again.turn;
		expect((await stateOf()).requests.at(-1)).toMatchObject({ status: "completed" });
	});
});

/** A control document kept in memory, which the test can read, damage and share. */
function memory(initial?: string): ControlStorage & { value: string | undefined; failWrites: boolean } {
	return {
		value: initial,
		failWrites: false,
		read() {
			return this.value;
		},
		write(value) {
			if (this.failWrites) throw new Error("disk full");
			this.value = value;
		},
	};
}

const request = (requestId: string, agentId = "agent-a") => ({ space: "o_a", agentId, requestId });
/** A request of native-app run `runId`, as the server would name it. */
const inRun = (requestId: string, runId: string, agentId = "agent-a") => ({ ...request(requestId, agentId), runId });
/** A coordinator of space `o_a`, opted in and granted to the agents. */
const resumed = () => {
	const storage = memory();
	const coordinator = new ControlCoordinator("o_a", storage);
	coordinator.enable();
	coordinator.apply({ type: "resume", leaseId: "L1" });
	return { storage, coordinator };
};
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error instanceof ControlRefused ? error.reason : error));

describe("the coordinator", () => {
	it("admits two agents under distinct requests and sends a duplicate ID once", async () => {
		const { coordinator } = resumed();
		const sent: string[] = [];
		const send = (name: string) => async () => {
			sent.push(name);
			return name;
		};
		const concurrent = await Promise.allSettled([
			coordinator.dispatch(request("r1", "agent-a"), send("a1")),
			coordinator.dispatch(request("r2", "agent-b"), send("b1")),
			coordinator.dispatch(request("r1", "agent-b"), send("dup")),
		]);
		expect(concurrent.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
		expect(sent).toEqual(["a1", "b1"]);
		expect(coordinator.state?.requests.map((r) => [r.requestId, r.agentId])).toEqual([["r1", "agent-a"], ["r2", "agent-b"]]);
	});

	it("stores the admission before sending, and sends nothing when it can't be stored", async () => {
		const { storage, coordinator } = resumed();
		let storedWhenSent: string | undefined;
		await coordinator.dispatch(request("r1"), async () => {
			storedWhenSent = storage.value;
		});
		expect(JSON.parse(storedWhenSent!).state.requests).toEqual([expect.objectContaining({ requestId: "r1", status: "in_flight" })]);

		storage.failWrites = true;
		const send = vi.fn(async () => undefined);
		await expect(coordinator.dispatch(request("r2"), send)).rejects.toThrow("disk full");
		expect(send).not.toHaveBeenCalled();
		expect(coordinator.state?.requests.map((r) => r.requestId)).toEqual(["r1"]);
		// The failed write may have half happened: latched, and a disk that comes back doesn't clear it.
		storage.failWrites = false;
		expect(await refusal(coordinator.dispatch(request("r3"), send))).toBe("blocked");
		expect(send).not.toHaveBeenCalled();
	});

	it("latches blocked when settling can't be stored, even if storage then recovers, and again after a restart", async () => {
		const { storage, coordinator } = resumed();
		await coordinator.dispatch(request("r1"), async () => {
			// The answer arrived, but storing what became of it fails.
			storage.failWrites = true;
		});
		storage.failWrites = false;
		expect(coordinator.blocked).toEqual(expect.any(String));
		const send = vi.fn(async () => undefined);
		expect(await refusal(coordinator.dispatch(request("r2"), send))).toBe("blocked");
		expect(() => coordinator.apply({ type: "takeover" })).toThrow(ControlRefused);
		expect(send).not.toHaveBeenCalled();
		// Stored, it is still in flight; read after a restart it is unknown, and that is stored.
		expect(JSON.parse(storage.value!).state.requests[0].status).toBe("in_flight");
		const restarted = new ControlCoordinator("o_a", storage);
		expect(restarted.state?.requests[0]?.status).toBe("unknown");
		expect(await refusal(restarted.dispatch(request("r2"), send))).toBe("blocked");

		// If that can't be stored either, it is blocked all the same, and stays so when storage returns.
		const pending = resumed();
		void pending.coordinator.dispatch(request("r1"), () => new Promise<void>(() => undefined));
		const stuck = memory(pending.storage.value);
		stuck.failWrites = true;
		const again = new ControlCoordinator("o_a", stuck);
		stuck.failWrites = false;
		expect(again.blocked).toEqual(expect.any(String));
		expect(await refusal(again.dispatch(request("r3"), send))).toBe("blocked");
		expect(send).not.toHaveBeenCalled();
	});

	it("latches blocked when the first write fails, whether or not it was stored, and a retry doesn't clear it", async () => {
		for (const stored of [false, true]) {
			const storage = memory();
			const real = storage.write.bind(storage);
			// Throws, after storing the document or before.
			storage.write = (value) => {
				if (stored) real(value);
				throw new Error("disk full");
			};
			const coordinator = new ControlCoordinator("o_a", storage);
			expect(() => coordinator.enable()).toThrow("disk full");
			storage.write = real;
			expect(coordinator.enabled, `stored ${stored}`).toBe(true);
			expect(coordinator.blocked).toEqual(expect.any(String));
			const send = vi.fn(async () => undefined);
			expect(await refusal(coordinator.dispatch(request("r1"), send))).toBe("blocked");
			coordinator.enable();
			expect(coordinator.blocked).toEqual(expect.any(String));
			expect(await refusal(coordinator.dispatch(request("r1"), send))).toBe("blocked");
			expect(send).not.toHaveBeenCalled();
			expect(storage.value !== undefined).toBe(stored);
			// A restart reads what is stored: opted in if it was, else not.
			expect(new ControlCoordinator("o_a", storage).enabled).toBe(stored);
		}
	});

	it("changes nothing when asked to bind while blocked", async () => {
		const { storage, coordinator } = resumed();
		await coordinator.dispatch(request("r1"), async () => {
			storage.failWrites = true;
		});
		storage.failWrites = false;
		const before = storage.value;
		coordinator.bind("a1");
		expect(storage.value).toBe(before);
		expect(coordinator.state?.requests).toHaveLength(1);
	});

	it("refuses to restore lease bindings that repeat, have impossible epochs, or contradict the lease", async () => {
		const { storage, coordinator } = resumed();
		coordinator.bind("a1");
		const good = JSON.parse(storage.value!);
		const lease = { epoch: 1, leaseId: "L1" };
		const bindings: Record<string, unknown> = {
			"repeated approval": [{ id: "a1", lease }, { id: "a1", lease }],
			"negative epoch": [{ id: "a1", lease: { ...lease, epoch: -1 } }],
			"fractional epoch": [{ id: "a1", lease: { ...lease, epoch: 0.5 } }],
			"future epoch": [{ id: "a1", lease: { ...lease, epoch: 2 } }],
			"another lease in the current epoch": [{ id: "a1", lease: { ...lease, leaseId: "other" } }],
			"too many": Array.from({ length: 257 }, (_, index) => ({ id: `a${index}`, lease: null })),
		};
		for (const [name, value] of Object.entries(bindings)) {
			expect(new ControlCoordinator("o_a", memory(JSON.stringify({ ...good, bindings: value }))).blocked, name).toEqual(expect.any(String));
		}
		expect(new ControlCoordinator("o_a", memory(JSON.stringify(good))).blocked).toBeNull();
		for (let index = 0; index < 300; index++) coordinator.bind(`b${index}`);
		expect(JSON.parse(storage.value!).bindings).toHaveLength(256);
	});

	it("serializes a takeover against dispatches started around it: each request sees one consistent state", async () => {
		const { coordinator } = resumed();
		// Admission is synchronous: r1 is admitted before the takeover applies, r2 after, whatever happens to their sends.
		const first = refusal(coordinator.dispatch(request("r1"), async () => "sent"));
		const takeover = coordinator.apply({ type: "takeover" });
		const second = refusal(coordinator.dispatch(request("r2"), async () => "sent"));
		expect([await first, takeover, await second]).toEqual([null, { ok: true }, "not_agent_owned"]);
		expect(coordinator.state).toMatchObject({ owner: "human", lease: null });
		expect(coordinator.state?.requests).toEqual([expect.objectContaining({ requestId: "r1", status: "rejected" })]);
	});

	it("keeps a pending request across a restart as unknown, and sends nothing for it", async () => {
		const { storage, coordinator } = resumed();
		const sent = vi.fn(() => new Promise<void>(() => undefined));
		void coordinator.dispatch(request("r1"), sent);
		expect(coordinator.state?.requests[0]?.status).toBe("in_flight");

		const restarted = new ControlCoordinator("o_a", storage);
		expect(restarted.state?.requests[0]).toMatchObject({ requestId: "r1", status: "unknown" });
		expect(JSON.parse(storage.value!).state.requests[0].status).toBe("unknown");
		const resend = vi.fn(async () => undefined);
		expect(await refusal(restarted.dispatch(request("r2"), resend))).toBe("blocked");
		expect(await refusal(restarted.dispatch(request("r1"), resend))).toBe("duplicate_id");
		expect(resend).not.toHaveBeenCalled();
	});

	it("blocks on malformed, unknown-version or another space's state, and never resets it", async () => {
		const good = resumed().storage.value!;
		const damaged = [
			"not json",
			JSON.stringify({ ...JSON.parse(good), version: 9 }),
			JSON.stringify({ ...JSON.parse(good), state: { ...JSON.parse(good).state, owner: "both" } }),
			JSON.stringify({ ...JSON.parse(good), bindings: "x" }),
			JSON.stringify({ ...JSON.parse(good), space: "o_b" }),
		];
		for (const value of damaged) {
			const storage = memory(value);
			const coordinator = new ControlCoordinator("o_a", storage);
			expect(coordinator.blocked, value).toEqual(expect.any(String));
			expect(coordinator.enabled).toBe(true);
			coordinator.enable();
			const send = vi.fn(async () => undefined);
			expect(await refusal(coordinator.dispatch(request("r1"), send))).toBe("blocked");
			expect(() => coordinator.apply({ type: "takeover" })).toThrow(ControlRefused);
			expect(send).not.toHaveBeenCalled();
			expect(storage.value).toBe(value);
		}
	});

	it("refuses a request that names another space, and a state copied from one", async () => {
		const { storage, coordinator } = resumed();
		const send = vi.fn(async () => undefined);
		expect(await refusal(coordinator.dispatch({ space: "o_b", agentId: "x", requestId: "r1" }, send))).toBe("wrong_space");
		expect(send).not.toHaveBeenCalled();
		expect(new ControlCoordinator("o_b", memory(storage.value)).blocked).toContain("another space");
	});

	it("runs without checks when the space never opted in", async () => {
		const coordinator = new ControlCoordinator("o_a", memory());
		expect(await coordinator.dispatch(request("r1"), async () => "ran")).toBe("ran");
		expect(coordinator.state).toBeNull();
	});
});

describe("a native-app call, through Computer.call and the coordinator", () => {
	/**
	 * An operator's Cua computer, as `Computer` sees it, with native-app
	 * calls turned on, whose link is the test's: each call sent is recorded,
	 * and the test answers it as pim-computer would, or doesn't. Nothing is
	 * installed or run, and no native-app call goes anywhere: the reserved op
	 * has no handler yet. `sprite` makes it a computer Pim started instead,
	 * and `nativeApps` false leaves native-app calls off.
	 */
	function machine({ sprite = false, nativeApps = true } = {}) {
		const sent: { type: string; id: string; op: string; args: unknown }[] = [];
		const meta = new Map<string, string>();
		let link: ComputerLink | null = null;
		const computer: Computer = new Computer({
			selected: () => (sprite ? null : "cua"),
			nativeApps: () => nativeApps,
			meta: { meta: (key) => meta.get(key), setMeta: (key, value) => void meta.set(key, value), deleteMeta: (key) => void meta.delete(key) },
			sockets: () => [],
			wake: async () => {
				setTimeout(() => computer.receive(JSON.stringify({ type: "hello", agent: "pim-computer/test" })), 0);
				const opened = {
					readyState: WebSocket.OPEN,
					send: (message: string) => void sent.push(JSON.parse(message)),
					close() {
						opened.readyState = WebSocket.CLOSED;
						computer.disconnected();
					},
				};
				link = opened;
				return opened;
			},
			inUse: () => false,
		});
		if (sprite) computer.started("native-test", Date.now());
		/** Answers the `index`th call sent, with whatever `body` holds beside its type and ID. */
		const reply = (index: number, body: Record<string, unknown>) => computer.receive(JSON.stringify({ type: "reply", id: sent[index]!.id, ...body }));
		const calls = (count: number) => vi.waitFor(() => expect(sent).toHaveLength(count));
		const drop = () => link?.close();
		return { computer, sent, reply, calls, drop };
	}
	/** Runs `send` as request `requestId` of `coordinator`, noting what its trace said once each call it awaits settled. */
	function traced(coordinator: ControlCoordinator, requestId: string, send: (note: () => void) => Promise<unknown>, runId = "run-1") {
		const notes: { sent: boolean; uncertain: boolean; awaiting: number }[] = [];
		const note = () => {
			const trace = dispatchTrace.getStore()!;
			notes.push({ sent: trace.sent, uncertain: trace.uncertain, awaiting: trace.awaiting.size });
		};
		const done = coordinator.dispatch(inRun(requestId, runId), () => send(note)).then(
			(value) => ({ value }),
			(error: unknown) => ({ error: error as Error & Record<string, unknown> }),
		);
		const status = () => coordinator.state?.requests.find((each) => each.requestId === requestId)?.status;
		return { done, notes, status };
	}
	const LEAK = "Bearer pimc_o_leak-0123456789 /home/desktop/.cua/token";
	const known: NativeOutcome = { status: "completed", isError: false, code: null, content: [{ type: "text", text: "[1] button \"OK\"" }], presentation: [] };

	it("leaves a request unknown on a native unknown, before its caller hears, and nothing is sent again, also after a restart", async () => {
		const { computer, sent, reply, calls } = machine();
		const { storage, coordinator } = resumed();
		const run = traced(coordinator, "r1", async (note) => {
			const outcome = await computer.native("click", { pid: 42 });
			note();
			return outcome;
		});
		await calls(1);
		expect(sent[0]).toMatchObject({ type: "call", op: NATIVE_TOOL_OP });
		reply(0, { result: { status: "unknown", reason: "timeout" } });
		// The outcome is the caller's to read, as a value; the request is already uncertain when it does.
		expect(await run.done).toEqual({ value: { status: "unknown", reason: "timeout" } });
		expect(run.notes).toEqual([{ sent: true, uncertain: true, awaiting: 0 }]);
		expect(run.status()).toBe("unknown");

		const send = vi.fn(async () => undefined);
		expect(await refusal(coordinator.dispatch(request("r2"), send))).toBe("blocked");
		const restarted = new ControlCoordinator("o_a", storage);
		expect(restarted.state?.requests).toEqual([expect.objectContaining({ requestId: "r1", status: "unknown" })]);
		expect(await refusal(restarted.dispatch(request("r2"), send))).toBe("blocked");
		expect(await refusal(restarted.dispatch(request("r1"), send))).toBe("duplicate_id");
		expect(send).not.toHaveBeenCalled();
		expect(sent).toHaveLength(1);
	});

	it("keeps a known native outcome known: a result, the tool's refusal, a JSON-RPC error and a refusal unsent", async () => {
		const { computer, reply, calls } = machine();
		const outcomes: NativeOutcome[] = [
			{
				status: "completed",
				isError: false,
				code: null,
				content: [{ type: "text", text: "ok" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=", width: 8, height: 8 }],
				presentation: [{ kind: "text_truncated", index: 0 }, { kind: "image_omitted", index: 2 }, { kind: "items_unread", count: 3 }, { kind: "is_error_malformed" }],
			},
			{ status: "completed", isError: true, code: "permission_denied", content: [{ type: "text", text: "denied" }], presentation: [] },
			{ status: "rpc_error", code: -32602 },
			// Nothing reached spacesd, but the call did reach the computer: the request's `sent` stands.
			{ status: "rejected", reason: "busy" },
		];
		for (const [index, outcome] of outcomes.entries()) {
			const { coordinator } = resumed();
			const run = traced(coordinator, "r1", async (note) => {
				const value = await computer.native("list_apps", {});
				note();
				return value;
			});
			await calls(index + 1);
			reply(index, { result: outcome });
			expect(await run.done, outcome.status).toEqual({ value: outcome });
			expect(run.notes, outcome.status).toEqual([{ sent: true, uncertain: false, awaiting: 0 }]);
			expect(run.status(), outcome.status).toBe("completed");
		}
	});

	it("leaves a request unknown on a reply that is no outcome, an error or anything malformed, and passes none of it on", async () => {
		const { computer, reply, calls } = machine();
		const completed = { status: "completed", isError: false, code: null, content: [], presentation: [] };
		const replies: Record<string, Record<string, unknown>> = {
			"an error, which can't say whether the app was acted on": { error: { message: `ENOSYS ${LEAK}`, code: "ENOSYS" } },
			"an error beside a result": { error: null, result: completed },
			"no result": {},
			"a null result": { result: null },
			"a string": { result: "completed" },
			"an unknown status": { result: { status: "done" } },
			"an unknown status that looks like success": { result: { ...completed, status: "ok" } },
			"an unknown reason": { result: { status: "unknown", reason: LEAK } },
			"an unknown refusal": { result: { status: "rejected", reason: "nope" } },
			"an extra field": { result: { status: "rejected", reason: "busy", detail: LEAK } },
			"a missing field": { result: { status: "completed", isError: false, content: [], presentation: [] } },
			"a code without an error": { result: { ...completed, code: "permission_denied" } },
			"a code that isn't plain": { result: { ...completed, isError: true, code: LEAK } },
			"an error flag that isn't a boolean": { result: { ...completed, isError: "false" } },
			"a resource link": { result: { ...completed, content: [{ type: "resource_link", uri: `https://evil.test/${LEAK}` }] } },
			"an image of another type": { result: { ...completed, content: [{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+", width: 1, height: 1 }] } },
			"an unknown issue": { result: { ...completed, presentation: [{ kind: "fine" }] } },
			"a JSON-RPC error code that isn't an integer": { result: { status: "rpc_error", code: 1.5 } },
			"more items than any limit allows": { result: { ...completed, content: Array.from({ length: 1025 }, () => ({ type: "text", text: "" })) } },
			"more text than any limit allows": { result: { ...completed, content: [{ type: "text", text: "é".repeat(2 * 1024 * 1024 + 1) }] } },
		};
		for (const [index, [what, body]] of Object.entries(replies).entries()) {
			const { coordinator } = resumed();
			const run = traced(coordinator, "r1", async (note) => {
				try {
					return await computer.native("list_apps", {});
				} finally {
					note();
				}
			});
			await calls(index + 1);
			reply(index, body);
			const done = await run.done;
			expect("error" in done && done.error.message, what).toBe("The computer's answer to a native-app call couldn't be read, so whether it acted is unknown.");
			expect("error" in done && [done.error.answered, done.error.code], what).toEqual([undefined, undefined]);
			expect(run.notes, what).toEqual([{ sent: true, uncertain: true, awaiting: 0 }]);
			expect(run.status(), what).toBe("unknown");
		}
	});

	it("answers every other op as before, whatever its result holds", async () => {
		const { computer, reply, calls } = machine();
		const { coordinator } = resumed();
		const run = traced(coordinator, "r1", async (note) => {
			const result = await computer.call("exec", { command: "date" });
			const missing = await computer.call("stat", { path: "/workspace/x" }).catch((error: Error) => error);
			note();
			return [result, missing];
		});
		await calls(1);
		reply(0, { result: { status: "unknown", reason: "timeout" } });
		await calls(2);
		reply(1, { error: { message: "No such file", code: "ENOENT" } });
		const done = await run.done;
		expect("value" in done && done.value).toEqual([{ status: "unknown", reason: "timeout" }, expect.objectContaining({ message: "No such file", code: "ENOENT", answered: true })]);
		expect(run.notes).toEqual([{ sent: true, uncertain: false, awaiting: 0 }]);
		expect(run.status()).toBe("completed");

	});

	it("is monotonic in a request: a known native outcome after an uncertain call, or a known reply after a native unknown, lowers nothing", async () => {
		const { computer, reply, calls } = machine();
		for (const [index, outcome] of ([{ status: "rejected", reason: "uncertain" }, known] as NativeOutcome[]).entries()) {
			const { coordinator } = resumed();
			const run = traced(coordinator, "r1", async (note) => {
				await computer.call("exec", { command: "date" }, 20).catch(() => undefined);
				note();
				await computer.native("list_apps", {});
				note();
			});
			await calls(2 * index + 2);
			reply(2 * index + 1, { result: outcome });
			await run.done;
			expect(run.notes, outcome.status).toEqual(Array(2).fill({ sent: true, uncertain: true, awaiting: 0 }));
			expect(run.status(), outcome.status).toBe("unknown");
		}
		const { coordinator } = resumed();
		const run = traced(coordinator, "r1", async (note) => {
			await computer.native("list_apps", {});
			note();
			await computer.call("stat", { path: "/workspace" });
			note();
		});
		await calls(5);
		reply(4, { result: { status: "unknown", reason: "transport" } });
		await calls(6);
		reply(5, { result: { size: 0 } });
		await run.done;
		expect(run.notes).toEqual(Array(2).fill({ sent: true, uncertain: true, awaiting: 0 }));
		expect(run.status()).toBe("unknown");
	});

	it("leaves unknown a native call given up, cut off, or still awaited when its request settles, and a late reply changes nothing", async () => {
		const { computer, sent, reply, calls, drop } = machine();
		const { storage, coordinator: timedOut } = resumed();
		const late = traced(timedOut, "r1", () => computer.native("list_apps", {}, 20));
		expect((await late.done as { error: Error }).error.message).toMatch(/didn't answer/);
		expect(late.status()).toBe("unknown");

		const { coordinator: cutOff } = resumed();
		const dropped = traced(cutOff, "r1", () => computer.native("list_apps", {}));
		await calls(2);
		drop();
		expect((await dropped.done as { error: Error }).error.message).toMatch(/disconnected/);
		expect(dropped.status()).toBe("unknown");

		// A request that doesn't wait for its native call is settled before the reply.
		const { coordinator: unwaited } = resumed();
		const early = traced(unwaited, "r1", async () => {
			void computer.native("list_apps", {}).catch(() => undefined);
			await calls(3);
		});
		await early.done;
		expect(early.status()).toBe("unknown");

		// Their replies come at last, each a known result: nothing reopens, and nothing is sent again.
		for (let index = 0; index < 3; index++) reply(index, { result: known });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect([late.status(), dropped.status(), early.status()]).toEqual(["unknown", "unknown", "unknown"]);
		expect(new ControlCoordinator("o_a", storage).state?.requests[0]?.status).toBe("unknown");
		expect(sent.map((call) => call.op)).toEqual([NATIVE_TOOL_OP, NATIVE_TOOL_OP, NATIVE_TOOL_OP]);
	});

	it("reads a multi-megabyte screenshot whole, and refuses multi-megabyte base64 that isn't, with nothing overflowing", async () => {
		const { computer, reply, calls } = machine();
		const header = Buffer.from("iVBORw0KGgoAAAANSUhEUgAABiAAAALdCAIAAAA=", "base64");
		const screenshot = Buffer.concat([header, Buffer.alloc(6 * 1024 * 1024)]).toString("base64");
		const image = (data: string) => ({ status: "completed", isError: false, code: null, content: [{ type: "image", mimeType: "image/png", data, width: 1568, height: 733 }], presentation: [] });
		const cases: [string, string, boolean][] = [
			["a PNG of 6 MiB", screenshot, true],
			["8,000,000 characters of the alphabet", "A".repeat(8_000_000), true],
			["a character outside it, at the end", `${"A".repeat(7_999_999)}!`, false],
			["padding in the middle", `${"A".repeat(4_000_000)}=${"A".repeat(3_999_999)}`, false],
			["a group cut short", "A".repeat(8_000_001), false],
		];
		for (const [index, [what, data, known]] of cases.entries()) {
			expect(data.length, what).toBeGreaterThan(8 * 1000 * 1000 - 1);
			const { coordinator } = resumed();
			const run = traced(coordinator, "r1", async (note) => {
				try {
					return await computer.native("list_apps", {});
				} finally {
					note();
				}
			});
			await calls(index + 1);
			reply(index, { result: image(data) });
			const done = await run.done;
			if (known) expect("value" in done && (done.value as { content: { data: string }[] }).content[0]!.data === data, what).toBe(true);
			else expect("error" in done && done.error.message, what).toMatch(/couldn't be read/);
			expect(run.notes, what).toEqual([{ sent: true, uncertain: !known, awaiting: 0 }]);
			expect(run.status(), what).toBe(known ? "completed" : "unknown");
		}
		expect(computer.busy()).toBe(false);
	});

	it("fails closed when checking a native reply throws: the call settles, uncertain, with nothing of the error passed on", async () => {
		const { computer, reply, calls } = machine();
		const { coordinator } = resumed();
		vi.mocked(nativeOutcome.readNativeOutcome).mockImplementationOnce(() => {
			throw new RangeError(`Maximum call stack size exceeded ${LEAK}`);
		});
		// A timeout well past the test's, so only the reply can settle it.
		const run = traced(coordinator, "r1", async (note) => {
			try {
				return await computer.native("list_apps", {}, 600_000);
			} finally {
				note();
			}
		});
		await calls(1);
		expect(computer.busy()).toBe(true);
		expect(() => reply(0, { result: known })).not.toThrow();
		// The throwing check is the one that read this reply: the injection reached the space's code, so what follows is about how it failed.
		const check = vi.mocked(nativeOutcome.readNativeOutcome).mock;
		expect([check.calls.at(-1), check.results.at(-1)?.type]).toEqual([[known], "throw"]);
		const done = await run.done;
		expect("error" in done && [done.error.message, done.error.answered]).toEqual([
			"The computer's answer to a native-app call couldn't be read, so whether it acted is unknown.",
			undefined,
		]);
		expect(run.notes).toEqual([{ sent: true, uncertain: true, awaiting: 0 }]);
		expect(run.status()).toBe("unknown");
		expect(computer.busy()).toBe(false);
	});

	it("binds a native call to the admitted request and the space, never to what the caller passes", async () => {
		const { computer, sent, reply, calls } = machine();
		const { coordinator } = resumed();
		// What a model might write: identities, a session, an endpoint and a token, all as arguments.
		const forged: Record<string, unknown> = { pid: 42, owner: "o_evil", agentId: "agent-evil", runId: "run-evil", callId: "c1", session: "s", origin: "https://evil.test", token: LEAK };
		const asked = { ...forged };
		const runs = [traced(coordinator, "r1", () => computer.native("click", forged), "run-7")];
		// Changed after the call, it changes nothing sent: the copy was made before anything was awaited.
		forged.pid = 1;
		await calls(1);
		reply(0, { result: known });
		runs.push(traced(coordinator, "r2", () => computer.native("list_apps", {}), "run-8"));
		await calls(2);
		reply(1, { result: known });
		for (const run of runs) expect(await run.done).toEqual({ value: known });
		expect(sent.map((call) => [call.op, call.args])).toEqual([
			[NATIVE_TOOL_OP, { owner: "o_a", agentId: "agent-a", runId: "run-7", callId: "r1", tool: "click", arguments: asked }],
			[NATIVE_TOOL_OP, { owner: "o_a", agentId: "agent-a", runId: "run-8", callId: "r2", tool: "list_apps", arguments: {} }],
		]);
		// Exactly what the host reads as a call, and nothing else.
		for (const call of sent) expect(readNativeRequest(call.args)).toEqual(call.args);
		// Another agent's request is that agent's.
		const other = coordinator.dispatch(inRun("r3", "run-9", "agent-b"), () => computer.native("list_apps", {}));
		await calls(3);
		reply(2, { result: known });
		await other;
		expect(sent[2]?.args).toMatchObject({ owner: "o_a", agentId: "agent-b", runId: "run-9", callId: "r3" });
	});

	it("sends no native call without an admitted request of a run, or with a tool or arguments it can't vouch for", async () => {
		const { computer, sent, reply, calls } = machine();
		const refusedNative = (promise: Promise<unknown>) =>
			promise.then(
				() => "sent",
				(error: Error & { status?: number }) => error.status,
			);

		// Outside any request; through the plain call, in a request or not; and in a request made by hand, not admitted.
		expect(await refusedNative(computer.native("list_apps", {}))).toBe(409);
		expect(await refusedNative(computer.call(NATIVE_TOOL_OP, { owner: "o_a", agentId: "agent-a", runId: "run-1", callId: "x", tool: "list_apps", arguments: {} }))).toBe(400);
		const handMade = { sent: false, uncertain: false, awaiting: new Set<string>(), settled: false };
		expect(await refusedNative(dispatchTrace.run(handMade, () => computer.native("list_apps", {})))).toBe(409);
		const { coordinator } = resumed();
		expect(await refusedNative(coordinator.dispatch(inRun("raw", "run-1"), () => computer.call(NATIVE_TOOL_OP, {})))).toBe(400);
		// Admitted, but naming no run.
		expect(await refusedNative(coordinator.dispatch(request("no-run"), () => computer.native("list_apps", {})))).toBe(409);

		const tools: unknown[] = ["launch_app", "run_steps", "page", "initialize", "tools/call", "__proto__", "toString", "", 42, null, undefined];
		const args: [string, unknown][] = [
			["an array", [{ pid: 42 }]],
			["null", null],
			["a string", "{\"pid\":42}"],
			["a date", new Date()],
			["a map", new Map([["pid", 42]])],
			["an object without a prototype", Object.assign(Object.create(null), { pid: 42 })],
			["a getter that throws", Object.defineProperty({}, "pid", { enumerable: true, get: () => { throw new Error(LEAK); } })],
			["a cycle", (() => { const cycle: Record<string, unknown> = { pid: 42 }; cycle.self = cycle; return cycle; })()],
			["a bigint", { pid: 42n }],
			// Each of these JSON would turn into something a curated schema admits; none is converted.
			["a getter that answers", Object.defineProperty({}, "pid", { enumerable: true, get: () => 42 })],
			["a value with toJSON", { pid: { toJSON: () => 42 } }],
			["arguments with toJSON", { toJSON: () => ({ pid: 42 }) }],
			["a nested date", { pid: 42, since: new Date(0) }],
			["an undefined beside them", { pid: 42, x: undefined }],
			["too much", { pid: 42, text: "x".repeat(40_000) }],
		];
		const cases: [string, () => Promise<unknown>][] = [
			...tools.map((tool): [string, () => Promise<unknown>] => [`the tool ${String(tool)}`, () => computer.native(tool, {})]),
			...args.map(([what, value]): [string, () => Promise<unknown>] => [`arguments that are ${what}`, () => computer.native("click", value)]),
		];
		for (const [index, [what, call]] of cases.entries()) {
			const run = traced(coordinator, `bad-${index}`, call);
			const done = await run.done;
			expect("error" in done && done.error.status, what).toBe(400);
			expect("error" in done && done.error.message, what).not.toContain(LEAK);
			// Nothing left the space, so the request is definitively not run.
			expect(run.status(), what).toBe("rejected");
		}

		// A request makes one native call, whose ID is the request's; a second is refused unsent.
		const twice = traced(coordinator, "twice", async () => {
			const first = computer.native("list_apps", {});
			await calls(1);
			const second = await refusedNative(computer.native("list_apps", {}));
			reply(0, { result: known });
			return [await first, second];
		});
		expect(await twice.done).toEqual({ value: [known, 409] });
		expect(sent.map((call) => call.args)).toEqual([expect.objectContaining({ callId: "twice" })]);
		expect(twice.status()).toBe("completed");
	});

	it("keeps native calls off unless turned on, and never sends one to a Sprite or a paired computer, whose calls are as before", async () => {
		for (const options of [{ nativeApps: false }, { sprite: true }]) {
			const { computer, sent } = machine(options);
			const { coordinator } = resumed();
			const run = traced(coordinator, "r1", () => computer.native("list_apps", {}));
			const done = await run.done;
			expect("error" in done && done.error.status, JSON.stringify(options)).toBe(409);
			expect(run.status(), JSON.stringify(options)).toBe("rejected");
			expect(sent, JSON.stringify(options)).toEqual([]);
		}
		// A Sprite answers its calls outside any request, as before; only the reserved op is refused there.
		const { computer, sent, reply, calls } = machine({ sprite: true });
		const ran = computer.call("exec", { command: "date" });
		await calls(1);
		reply(0, { result: { status: "unknown", reason: "timeout" } });
		expect(await ran).toEqual({ status: "unknown", reason: "timeout" });
		await expect(computer.call(NATIVE_TOOL_OP, {})).rejects.toThrow(/native-app path/);
		expect(sent.map((call) => call.op)).toEqual(["exec"]);
		// The space's own computer, as Pim makes it, has native-app calls off.
		expect(await inSpace((pim) => pim.computer.native("list_apps", {}).then(() => "sent", (error: Error) => error.message))).toMatch(/off/);
	});

	it("latches a run once one of its requests is unknown: reconciling reopens other runs, never it, also after a restart", async () => {
		const { computer, sent, reply, calls } = machine();
		const { storage, coordinator } = resumed();
		const first = traced(coordinator, "r1", () => computer.native("click", { pid: 42 }), "run-1");
		await calls(1);
		reply(0, { result: { status: "unknown", reason: "transport" } });
		await first.done;
		expect(coordinator.apply({ type: "reconcile_request", requestId: "r1", resolution: "not_executed", evidence: "The operator checked the app." })).toEqual({ ok: true });

		const send = vi.fn(async () => undefined);
		// Neither a new request ID nor a new agent escapes it through the same run.
		expect(await refusal(coordinator.dispatch(inRun("r2", "run-1"), send))).toBe("run_uncertain");
		expect(await refusal(coordinator.dispatch(inRun("r3", "run-1", "agent-b"), send))).toBe("run_uncertain");
		// A request in flight when the space restarts comes back unknown, and latches its run too.
		const hanging = traced(coordinator, "r4", () => computer.native("list_apps", {}, 600_000), "run-2");
		await calls(2);
		// The space restarts on what was stored; the old process's coordinator is gone with it.
		const restarted = new ControlCoordinator("o_a", memory(storage.value));
		expect(restarted.state?.requests.map((each) => [each.requestId, each.runId, each.status])).toEqual([
			["r1", "run-1", "reconciled_not_executed"],
			["r4", "run-2", "unknown"],
		]);
		restarted.apply({ type: "reconcile_request", requestId: "r4", resolution: "completed", evidence: "The operator saw the list." });
		for (const run of ["run-1", "run-2"]) expect(await refusal(restarted.dispatch(inRun(`after-${run}`, run), send)), run).toBe("run_uncertain");
		expect(await refusal(restarted.dispatch(inRun("r1", "run-3"), send))).toBe("duplicate_id");
		expect(send).not.toHaveBeenCalled();

		// Another run is admitted, and its call carries its own run.
		const fresh = traced(restarted, "r5", () => computer.native("list_apps", {}), "run-3");
		await calls(3);
		reply(2, { result: known });
		expect(await fresh.done).toEqual({ value: known });
		expect(fresh.status()).toBe("completed");
		expect(sent.map((call) => (call.args as { runId: string }).runId)).toEqual(["run-1", "run-2", "run-3"]);
		reply(1, { result: known });
		await hanging.done;
	});

	it("keeps an outcome's budget below what one bridge message carries", () => {
		expect(BRIDGE_MESSAGE_CHARS).toBe(MAX_MESSAGE_CHARS);
	});

	it("fails closed when a native call's settling can't be stored, and stays so after a restart", async () => {
		const { computer, reply, calls } = machine();
		const { storage, coordinator } = resumed();
		const run = traced(coordinator, "r1", () => computer.native("list_apps", {}));
		await calls(1);
		storage.failWrites = true;
		reply(0, { result: { status: "unknown", reason: "aborted" } });
		expect(await run.done).toEqual({ value: { status: "unknown", reason: "aborted" } });
		storage.failWrites = false;
		expect(coordinator.blocked).toEqual(expect.any(String));
		const send = vi.fn(async () => undefined);
		expect(await refusal(coordinator.dispatch(request("r2"), send))).toBe("blocked");
		// Stored, it is still in flight, which a restart reads as unknown.
		expect(JSON.parse(storage.value!).state.requests[0].status).toBe("in_flight");
		const restarted = new ControlCoordinator("o_a", storage);
		expect(restarted.state?.requests[0]?.status).toBe("unknown");
		expect(await refusal(restarted.dispatch(request("r2"), send))).toBe("blocked");
		expect(send).not.toHaveBeenCalled();
	});
});

describe("two spaces", () => {
	it("keep separate control state, and one can't use the other's", async () => {
		await control((c) => c.apply({ type: "takeover" }));
		await grant("lease-9");
		const stub = await getAgentByName(env.Pim, "o_otherspace0000000000000000");
		const other = await runInDurableObject(stub, (instance: Pim) => [instance.control.enabled, instance.control.state]);
		expect(other).toEqual([false, null]);
		const mine = await stateOf();
		const crossed = await runInDurableObject(stub, async (instance: Pim) => {
			instance.control.enable();
			const outcome = await instance.control
				.dispatch({ space: OWNER, agentId: "a", requestId: "r-cross" }, async () => "sent")
				.then(() => "sent", (error: unknown) => (error instanceof ControlRefused ? error.reason : String(error)));
			return { outcome, state: instance.control.state };
		});
		expect(crossed.outcome).toBe("wrong_space");
		expect(crossed.state).toMatchObject({ owner: "human", requests: [] });
		expect(await stateOf()).toEqual(mine);
	});
});

const setPermission = (tool: string, permission: string | null) => api("/permissions", { method: "PUT", body: JSON.stringify({ app: null, tool, permission }) });
/** The requests admitted since `before` requests were. */
const since = async (before: number) => (await stateOf()).requests.slice(before);
const BROWSER_TOOLS = [
	["browser_open", { url: "https://example.com/" }],
	["browser_read", {}],
	["browser_click", { ref: 1 }],
	["browser_type", { ref: 1, text: "x" }],
	["browser_screenshot", {}],
	["browser_close", {}],
] as const;

describe("the browser in a space under control state", () => {
	it("refuses all six agent browser tools while the person has control, reaching neither the browser nor another computer", async () => {
		await control((c) => c.apply({ type: "takeover" }));
		// Installing the tools again, as a permission change does, tells agents the live view is no takeover the state knows of.
		await setPermission("browser_click", "ask");
		let connects = 0;
		await inSpace((instance) => {
			const connectBrowser = instance.computer.connectBrowser.bind(instance.computer);
			instance.computer.connectBrowser = () => {
				connects++;
				return connectBrowser();
			};
		});
		const state = await stateOf();
		const packets = chrome.packets.length;
		const commands = ran.length;
		for (const [name, args] of BROWSER_TOOLS) {
			const call = uses(name, args);
			await call.turn;
			expect(call.result(), name).toContain("nothing was sent to it");
			if (name === "browser_open") {
				expect(call.description()).not.toContain("Take over");
				expect(call.description()).toContain("tell them what it needs");
			}
		}
		// Nothing reached the browser or the computer, no approval was filed, and a refusal is not a request.
		expect([connects, chrome.packets.length, ran.length]).toEqual([0, packets, commands]);
		expect((await api("/approvals?status=pending")).body.approvals).toEqual([]);
		expect(await stateOf()).toEqual(state);
		await inSpace((instance) => {
			instance.computer.connectBrowser = Object.getPrototypeOf(instance.computer).connectBrowser.bind(instance.computer);
		});
	});

	it("admits each tool call under the current lease, and settles it from the answers to its own DevTools messages", async () => {
		await grant("lease-10");
		const before = (await stateOf()).requests.length;
		expect(await useTool("browser_open", { url: "https://example.com/" })).toContain("# Fixture");
		expect(await useTool("browser_read")).toContain("# Fixture");
		expect(await useTool("browser_screenshot", { path: "/workspace/shot.png" })).toBe("Saved to /workspace/shot.png.");
		expect(await useTool("browser_close")).toBe("Your window is closed.");
		const majordomo = await inSpace((instance) => instance.agents.majordomo().id);
		// One request per call, the screenshot's write to the computer included in its own.
		expect(await since(before)).toEqual(
			Array.from({ length: 4 }, () => expect.objectContaining({ requestId: expect.stringMatching(/^call:/), agentId: majordomo, status: "completed" })),
		);
		expect([...(await fs.readFile(`${computer.root}/shot.png`)).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});

	it("clicks and types in an already connected browser only once an approval filed under the current lease is decided", async () => {
		await useTool("browser_open", { url: "https://example.com/" });
		const connections = chrome.sent("Target.getBrowserContexts").length;
		const before = (await stateOf()).requests.length;
		const mark = chrome.packets.length;

		const clicking = uses("browser_click", { ref: 1 });
		const click = await pendingApproval();
		// Naming the element was a request of its own; no input has been sent.
		expect(await since(before)).toEqual([expect.objectContaining({ requestId: expect.stringMatching(/^call:/), status: "completed" })]);
		expect(chrome.sent("Input.dispatchMouseEvent", mark)).toEqual([]);
		expect((await decide(click.id)).body.result).toContain("# Fixture");
		await clicking.turn;
		expect(chrome.sent("Input.dispatchMouseEvent", mark).map((packet) => packet.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);

		const typing = uses("browser_type", { ref: 1, text: "hi", submit: true });
		const type = await pendingApproval();
		expect(chrome.sent("Input.dispatchKeyEvent", mark)).toEqual([]);
		await decide(type.id);
		await typing.turn;
		expect(chrome.sent("Input.dispatchKeyEvent", mark).map((packet) => packet.params.key)).toContain("Enter");

		// The approvals ran as the requests they were filed for; the calls, woken after, looked at the page again as requests of their own.
		const call = (approval: Approval) => `call:${approval.callId}`;
		expect((await since(before)).map((request) => [request.requestId.replace(/^call:[^:]+:/, "call:"), request.status])).toEqual([
			[call(click), "completed"],
			[`approval:${click.id}`, "completed"],
			[`${call(click)}:resumed`, "completed"],
			[call(type), "completed"],
			[`approval:${type.id}`, "completed"],
			[`${call(type)}:resumed`, "completed"],
		]);
		// Over the connection it had: nothing reconnected.
		expect(chrome.sent("Target.getBrowserContexts")).toHaveLength(connections);
	});

	it("sends no input for an approval decided after a takeover, or filed before a takeover and resume", async () => {
		const mark = chrome.packets.length;
		const late = uses("browser_click", { ref: 1 });
		const first = await pendingApproval();
		await control((c) => c.apply({ type: "takeover" }));
		await decide(first.id);
		await late.turn;
		expect(late.result()).toContain("nothing was sent to it");

		await grant("lease-11");
		const stale = uses("browser_type", { ref: 1, text: "stale" });
		const second = await pendingApproval();
		await control((c) => c.apply({ type: "takeover" }));
		await grant("lease-12");
		expect((await decide(second.id)).body.result).toContain("nothing was sent to it");
		await stale.turn;
		expect([...chrome.sent("Input.dispatchMouseEvent", mark), ...chrome.sent("Input.dispatchKeyEvent", mark), ...chrome.sent("Input.insertText", mark)]).toEqual([]);
		const ids = (await stateOf()).requests.map((request) => request.requestId);
		expect(ids).not.toContain(`approval:${first.id}`);
		expect(ids).not.toContain(`approval:${second.id}`);
	});

	it("leaves a click whose input went unanswered unknown when the connection closes, blocks, and never sends it again", async () => {
		await setPermission("browser_click", "on");
		await useTool("browser_open", { url: "https://example.com/" });
		const mark = chrome.packets.length;
		chrome.hold.add("Input.dispatchMouseEvent");
		const clicking = uses("browser_click", { ref: 1 });
		// Puppeteer sends the move, press and release without waiting for each answer.
		await vi.waitFor(() => expect(chrome.sent("Input.dispatchMouseEvent", mark)).toHaveLength(3));
		// The browser goes away without answering.
		chrome.drop();
		await clicking.turn;
		chrome.hold.clear();
		expect(clicking.result()).toContain("The action failed");
		const stuck = (await stateOf()).requests.at(-1)!;
		expect(stuck).toMatchObject({ requestId: expect.stringMatching(/^approval:/), status: "unknown" });

		const blocked = chrome.packets.length;
		expect(await useTool("browser_read")).toContain("nothing was sent to it");
		expect(chrome.packets.length).toBe(blocked);
		await control((c) => c.apply({ type: "reconcile_request", requestId: stuck.requestId, resolution: "not_executed", evidence: "fixture held the mouse event" }));
		expect(await useTool("browser_read")).toContain("# Fixture");
		expect(chrome.sent("Input.dispatchMouseEvent", mark)).toHaveLength(3);
		await setPermission("browser_click", null);
	});

	it("covers a screenshot's write: written by the computer but not answered, the request is unknown", async () => {
		await useTool("browser_open", { url: "https://example.com/" });
		// The computer writes the file, then drops off before its answer leaves.
		const writes = new Set<string>();
		computer.socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data as string) as { type?: string; op?: string; id?: string };
			if (message.type === "call" && message.op === "write") writes.add(message.id!);
		});
		const send = computer.socket.send.bind(computer.socket);
		computer.socket.send = (message: string) => {
			if (writes.has((JSON.parse(message) as { id?: string }).id ?? "")) computer.socket.close(1000);
			else send(message);
		};
		const result = await useTool("browser_screenshot", { path: "/workspace/lost.png" });
		expect(result).toContain("disconnected before it answered");
		expect((await stateOf()).requests.at(-1)).toMatchObject({ requestId: expect.stringMatching(/^call:/), status: "unknown" });
		expect((await fs.stat(`${computer.root}/lost.png`)).isFile()).toBe(true);
		computer = await connect(token);
		const stuck = (await stateOf()).requests.at(-1)!.requestId;
		await control((c) => c.apply({ type: "reconcile_request", requestId: stuck, resolution: "completed", evidence: "fixture shows lost.png written" }));
	});
});

describe("the browser's transport, for requests the state admits", () => {
	/**
	 * The space's real computer and its DevTools connection, with coordinators
	 * of the test's own, so one test's unknown request doesn't block another.
	 * What the browser sends of its own (`chrome.inject`, `chrome.drop`) is the
	 * test's I/O, so it happens between calls into the space.
	 */
	async function wire(instance: Pim) {
		const connect = async () => {
			const transport = await instance.computer.connectBrowser();
			const answers = new Map<string, (message: Record<string, unknown>) => void>();
			let ended!: () => void;
			const closed = new Promise<void>((resolve) => (ended = resolve));
			transport.onmessage = (raw) => {
				const message = JSON.parse(raw) as Record<string, unknown>;
				answers.get(`${message.sessionId ?? ""}:${message.id}`)?.(message);
			};
			transport.onclose = () => ended();
			/** Sends a DevTools message; resolves with its answer. */
			const ask = (id: number, method: string, sessionId?: string) => {
				const answered = new Promise<Record<string, unknown>>((resolve) => answers.set(`${sessionId ?? ""}:${id}`, resolve));
				transport.send(JSON.stringify({ id, method, params: {}, ...(sessionId ? { sessionId } : {}) }));
				return answered;
			};
			return { transport, ask, closed };
		};
		/** A coordinator of its own, opted in and granted to the agents. */
		const control = () => {
			const storage = memory();
			const coordinator = new ControlCoordinator("o_t", storage);
			coordinator.enable();
			coordinator.apply({ type: "resume", leaseId: "L" });
			const dispatch = <T>(requestId: string, send: () => Promise<T>, agentId = "agent-a") => coordinator.dispatch({ space: "o_t", agentId, requestId }, send);
			const statusOf = (requestId: string) => coordinator.state?.requests.find((request) => request.requestId === requestId)?.status;
			return { storage, coordinator, dispatch, statusOf };
		};
		return { instance, connect, control, held: {} as Record<string, unknown> };
	}
	let lab: Awaited<ReturnType<typeof wire>>;
	const inLab = <T>(fn: (lab: Awaited<ReturnType<typeof wire>>) => T | Promise<T>) => inSpace(() => fn(lab));
	beforeEach(async () => {
		await inSpace(async (instance) => {
			lab = await wire(instance);
		});
		chrome.hold.add("Fixture.hold");
	});
	afterEach(() => {
		chrome.hold.clear();
		chrome.fail.clear();
	});
	const settle = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error instanceof ControlRefused ? error.reason : (error as Error).message));
	const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

	it("completes a request whose every message was answered, a protocol error included", async () => {
		chrome.fail.add("Fixture.refuse");
		const status = await inLab(async ({ connect, control }) => {
			const { ask } = await connect();
			const { dispatch, statusOf } = control();
			await dispatch("r1", async () => {
				await ask(1, "Fixture.echo");
				expect((await ask(2, "Fixture.refuse")).error).toMatchObject({ message: "The fixture refuses this." });
			});
			return statusOf("r1");
		});
		expect(status).toBe("completed");
	});

	it("leaves unknown a request that gave up on a message, or had only some answered, and a late answer doesn't change that", async () => {
		const settled = await inLab(async ({ connect, control, held }) => {
			const { ask } = await connect();
			const [timeout, partial] = [control(), control()];
			Object.assign(held, { timeout, partial });
			// Gives up on its own clock, never answered.
			await timeout.dispatch("r", async () => {
				await Promise.race([ask(1, "Fixture.hold"), tick()]);
			});
			// Two messages, one answered.
			await partial.dispatch("r", async () => {
				void ask(2, "Fixture.hold");
				await ask(3, "Fixture.echo");
			});
			return [timeout.statusOf("r"), partial.statusOf("r")];
		});
		expect(settled).toEqual(["unknown", "unknown"]);
		// The browser answers at last: nothing reopens.
		chrome.inject({ id: 1, result: {} });
		chrome.inject({ id: 2, result: {} });
		const after = await inLab(async ({ held }) => {
			await tick();
			const { timeout, partial } = held as Record<string, ReturnType<Awaited<ReturnType<typeof wire>>["control"]>>;
			return [timeout!.statusOf("r"), partial!.statusOf("r"), await settle(timeout!.dispatch("next", async () => undefined))];
		});
		expect(after).toEqual(["unknown", "unknown", "blocked"]);
	});

	it("counts an answer only for the message it answers: foreign and other-session answers and events don't clear one", async () => {
		await inLab(async ({ connect, control, held }) => {
			const { ask } = await connect();
			const [foreign, answered] = [control(), control()];
			let release!: () => void;
			const waiting = new Promise<void>((resolve) => (release = resolve));
			held.release = release;
			held.statuses = () => [foreign.statusOf("r"), answered.statusOf("r")];
			held.done = Promise.all([
				foreign.dispatch("r", async () => {
					void ask(7, "Fixture.hold");
					await waiting;
				}),
				answered.dispatch("r", () => ask(9, "Fixture.hold")),
			]);
		});
		await vi.waitFor(() => expect(chrome.packets.filter((packet) => packet.method === "Fixture.hold").slice(-2).map((packet) => packet.id)).toEqual([7, 9]));
		// Answers nobody waits for, another session's message 7, and an event naming 7; then message 9's own answer.
		chrome.inject({ id: 8, result: {} });
		chrome.inject({ id: 7, sessionId: "another", result: {} });
		chrome.inject({ method: "Page.loadEventFired", params: { id: 7 } });
		chrome.inject({ id: 9, result: {} });
		const statuses = await inLab(async ({ held }) => {
			await tick();
			(held.release as () => void)();
			await held.done;
			return (held.statuses as () => unknown[])();
		});
		expect(statuses).toEqual(["unknown", "completed"]);
	});

	it("keeps two agents' requests on one connection apart, and sends a message ID still awaited for nobody", async () => {
		const mark = chrome.packets.length;
		const result = await inLab(async ({ connect, control }) => {
			const { ask } = await connect();
			const { dispatch, statusOf } = control();
			let release!: () => void;
			const waiting = new Promise<void>((resolve) => (release = resolve));
			const first = dispatch("a", async () => {
				void ask(20, "Fixture.hold");
				await waiting;
			});
			// While a's message waits, b's is answered on the same connection, and c's reuse of a's ID is refused before it leaves.
			await dispatch("b", () => ask(21, "Fixture.echo"), "agent-b");
			const duplicate = await settle(dispatch("c", () => ask(20, "Fixture.echo"), "agent-b"));
			const during = [statusOf("a"), statusOf("b"), statusOf("c")];
			release();
			await first;
			return { during, duplicate, after: statusOf("a") };
		});
		expect(result.during).toEqual(["in_flight", "completed", "rejected"]);
		expect(result.duplicate).toContain("still awaiting its answer");
		expect(result.after).toBe("unknown");
		expect(chrome.packets.slice(mark).filter((packet) => packet.id === 20)).toHaveLength(1);
	});

	it("makes a request using the connection wait for messages sent for no request, but not for one sent before any request used it", async () => {
		const statuses = await inLab(async ({ connect, control }) => {
			const { ask } = await connect();
			const [before, using] = [control(), control()];
			// Sent for no request while nobody uses the connection: nobody waits for it.
			void ask(30, "Fixture.hold");
			await before.dispatch("r", () => ask(31, "Fixture.echo"));
			let release!: () => void;
			const waiting = new Promise<void>((resolve) => (release = resolve));
			const pending = using.dispatch("r", async () => {
				await ask(32, "Fixture.echo");
				await waiting;
			});
			// Sent for no request, as puppeteer's own or the person's, while a request uses it: that request may have caused it.
			await tick();
			void ask(33, "Fixture.hold");
			release();
			await pending;
			return [before.statusOf("r"), using.statusOf("r")];
		});
		expect(statuses).toEqual(["completed", "unknown"]);
	});

	it("tells an unsent message from a sent one: a replaced connection sends nothing, and a closed one leaves what was sent unknown", async () => {
		const mark = chrome.packets.length;
		const stale = await inLab(async ({ connect, control, held }) => {
			const old = await connect();
			const current = await connect();
			const unsent = control();
			const closed = control();
			held.statuses = () => [unsent.statusOf("r"), closed.statusOf("r")];
			const refused = await settle(unsent.dispatch("r", () => old.ask(1, "Fixture.echo")));
			held.done = closed.dispatch("r", async () => {
				void current.ask(2, "Fixture.hold");
				await current.closed;
			});
			return refused;
		});
		expect(stale).toContain("nothing was sent");
		await vi.waitFor(() => expect(chrome.sent("Fixture.hold", mark)).toHaveLength(1));
		// The browser closes the connection without answering.
		chrome.drop();
		const statuses = await inLab(async ({ held }) => {
			await held.done;
			return (held.statuses as () => unknown[])();
		});
		expect(statuses).toEqual(["rejected", "unknown"]);
		expect(chrome.packets.slice(mark).map((packet) => packet.method)).toEqual(["Fixture.hold"]);
	});

	it("doesn't take the connection's setup as an answer for what is sent over it", async () => {
		const statuses = await inLab(async ({ instance, control }) => {
			const [setup, more] = [control(), control()];
			await setup.dispatch("r", () => instance.computer.connectBrowser());
			await more.dispatch("r", async () => {
				const transport = await instance.computer.connectBrowser();
				transport.send(JSON.stringify({ id: 1, method: "Fixture.hold", params: {} }));
			});
			return [setup.statusOf("r"), more.statusOf("r")];
		});
		expect(statuses).toEqual(["completed", "unknown"]);
	});

	it("reads a request still waiting on the browser as unknown after a restart, and sends nothing for it", async () => {
		const mark = chrome.packets.length;
		const result = await inLab(async ({ connect, control }) => {
			const { ask } = await connect();
			const { dispatch, storage } = control();
			void dispatch("r1", () => ask(1, "Fixture.hold"));
			const restarted = new ControlCoordinator("o_t", storage);
			const again = await settle(restarted.dispatch({ space: "o_t", agentId: "agent-a", requestId: "r2" }, () => ask(2, "Fixture.echo")));
			return { status: restarted.state?.requests[0]?.status, again };
		});
		expect(result).toEqual({ status: "unknown", again: "blocked" });
		expect(chrome.packets.slice(mark).map((packet) => packet.method)).toEqual(["Fixture.hold"]);
	});
});

describe("the space's control state, once it can't be stored", () => {
	it("sends nothing to the browser, and refuses everything after", async () => {
		const mark = chrome.packets.length;
		await inSpace((instance) => {
			const setMeta = instance.store.setMeta.bind(instance.store);
			vi.spyOn(instance.store, "setMeta").mockImplementation((key, value) => {
				if (key === "computer_control") throw new Error("disk full");
				setMeta(key, value);
			});
		});
		expect(await useTool("browser_open", { url: "https://example.com/" })).toContain("disk full");
		vi.restoreAllMocks();
		expect(await useTool("browser_read")).toContain("could not be stored");
		expect(chrome.packets.length).toBe(mark);
	});
});
