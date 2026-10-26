import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import type { ExecArgs, ExecResult } from "../computer/pim-computer";
import { type ControlStorage, ControlCoordinator, ControlRefused } from "../src/computer-control-runtime";
import type { ControlState } from "../src/computer-control";
import { api, connectTestComputer, OWNER, pendingApproval, post, say, toolUse } from "./helpers";
import { faux, type Pim } from "./worker";

/**
 * The control state on the paths agents really use: approved actions and file
 * tools, over a computer that is the tests' own end of the real transport.
 * Nothing here runs a process: a request reaching `ran` was received by the
 * fixture, which is a transport receipt and says nothing about what a real
 * machine would then do or stop doing.
 */

const agent = () => env.Pim.getByName(OWNER);
const inSpace = <T>(fn: (instance: Pim) => T | Promise<T>) => runInDurableObject(agent(), (instance: Pim) => fn(instance));

const ran: ExecArgs[] = [];
let gate: Promise<void> | null = null;
const ok: ExecResult = { exitCode: 0, signal: null, stdout: "done\n", stderr: "", timedOut: false, truncated: false };

const connect = (token: string) =>
	connectTestComputer(token, `/tmp/computer-control-${crypto.randomUUID()}`, async (args) => {
		ran.push(args);
		await gate;
		return ok;
	});

let computer: Awaited<ReturnType<typeof connect>>;
let token = "";

function lastToolResult(messages: readonly Message[]) {
	const result = messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("no tool result");
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

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
