import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecArgs, ExecResult } from "../computer/pim-computer";
import type { Approval } from "../src/store";
import { type ControlStorage, ControlCoordinator, ControlRefused } from "../src/computer-control-runtime";
import type { ControlState } from "../src/computer-control";
import * as fs from "node:fs/promises";
import { api, connectTestComputer, fakeChrome, OWNER, post, say, toolUse } from "./helpers";
import { faux, type Pim } from "./worker";

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

describe("the coordinator", () => {
	const request = (requestId: string, agentId = "agent-a") => ({ space: "o_a", agentId, requestId });
	const resumed = () => {
		const storage = memory();
		const coordinator = new ControlCoordinator("o_a", storage);
		coordinator.enable();
		coordinator.apply({ type: "resume", leaseId: "L1" });
		return { storage, coordinator };
	};
	const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error instanceof ControlRefused ? error.reason : error));

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
