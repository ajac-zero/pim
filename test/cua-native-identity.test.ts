import { describe, expect, it } from "vitest";
import type { NativeOutcome } from "../computer/native-outcome";
import type { ControlLease } from "../src/computer-control";
import { ControlRefused } from "../src/computer-control-runtime";
import {
	type AuthorityAnswer,
	AUTHORITY_REFUSALS,
	MAX_NATIVE_BINDINGS,
	MAX_NATIVE_BINDINGS_CHARS,
	type NativeBinding,
	NativeIdentityBinder,
	type NativeIdentityAuthority,
	type NativeIdentityClaim,
} from "../src/cua-native-identity";

/**
 * The native-call binder (docs/cua-native-identity.md) with a stand-in
 * authority and in-memory storage. Nothing here touches the harness, a
 * Durable Object, a computer or a network: the authority below models the
 * harness's runs as its design document describes them, to show what the
 * binder does given such an authority. It is not the harness, and Pim has no
 * real authority yet.
 */

const SPACE = "space-1";
const lease1: ControlLease = { epoch: 1, leaseId: "L1" };
const known: NativeOutcome = { status: "completed", isError: false, code: null, content: [{ type: "text", text: "clicked" }], presentation: [] };
const unknown: NativeOutcome = { status: "unknown", reason: "timeout" };
const claim = (toolTaskId = "t1", callId = "call-1", conversationId = "c1"): NativeIdentityClaim => ({ conversationId, toolTaskId, callId });
const click = () => ({ pid: 42, x: 10, y: 20 });

/** In-memory storage whose writes can be made to fail before storing, or after. */
function memory() {
	const disk = { value: undefined as string | undefined, writes: 0, fail: null as "before" | "after" | null };
	const storage = {
		read: () => disk.value,
		write: (value: string) => {
			if (disk.fail === "before") throw new Error("disk");
			disk.value = value;
			disk.writes++;
			if (disk.fail === "after") throw new Error("disk");
		},
	};
	return { disk, storage };
}

/**
 * The harness's runs as pi-durable 1.1.0's design document describes them:
 * a conversation is busy while `pi.live.run` names the generation that
 * settles its inputs; a tool task is owned by the generation that called it,
 * which keeps the run during its tool round and then hands it over; steering
 * inputs join the run, and a successor run starts with other inputs. Its run
 * anchor is the run's first input. `answer` replaces what it says.
 */
class StandInHarness implements NativeIdentityAuthority {
	readonly agents = new Map<string, string>();
	readonly runs = new Map<string, { taskId: string; inputs: string[] }>();
	readonly tasks = new Map<string, { conversationId: string; callId: string; owner: string; live: boolean }>();
	readonly verified: NativeIdentityClaim[] = [];
	answer: ((claim: NativeIdentityClaim) => unknown) | null = null;

	async verify(claim: NativeIdentityClaim): Promise<AuthorityAnswer> {
		this.verified.push(claim);
		if (this.answer) return this.answer(claim) as AuthorityAnswer;
		const task = this.tasks.get(claim.toolTaskId);
		if (!task || task.conversationId !== claim.conversationId || task.callId !== claim.callId) return { status: "refused", reason: "missing" };
		const run = this.runs.get(task.conversationId);
		if (!task.live || !run) return { status: "refused", reason: "stopped" };
		if (run.taskId !== task.owner) return { status: "refused", reason: "not_run_owned" };
		const agentId = this.agents.get(task.conversationId);
		const runAnchor = run.inputs[0];
		if (!agentId || !runAnchor) return { status: "refused", reason: "legacy" };
		return { status: "verified", identity: { owner: SPACE, agentId, ...claim, runAnchor } };
	}

	start(conversationId: string, generation: string, input: string) {
		this.runs.set(conversationId, { taskId: generation, inputs: [input] });
	}
	call(conversationId: string, toolTaskId: string, callId: string) {
		const run = this.runs.get(conversationId);
		if (!run) throw new Error("not busy");
		this.tasks.set(toolTaskId, { conversationId, callId, owner: run.taskId, live: true });
	}
	finish(toolTaskId: string) {
		const task = this.tasks.get(toolTaskId);
		if (task) task.live = false;
	}
	handOver(conversationId: string, to: string) {
		const run = this.runs.get(conversationId);
		if (run) run.taskId = to;
	}
	steer(conversationId: string, input: string) {
		this.runs.get(conversationId)?.inputs.push(input);
	}
	end(conversationId: string) {
		this.runs.delete(conversationId);
		for (const task of this.tasks.values()) if (task.conversationId === conversationId) task.live = false;
	}
}

/** A binder over fresh storage, with conversation c1 of agent-a running from input s1, whose generation g1 called tool task t1. */
function setup() {
	const { disk, storage } = memory();
	const harness = new StandInHarness();
	const control = { lease: lease1 as ControlLease | null };
	let ids = 0;
	const make = (owner = SPACE) => new NativeIdentityBinder(owner, storage, { authority: harness, lease: () => control.lease, newId: () => `b${++ids}` });
	harness.agents.set("c1", "agent-a");
	harness.start("c1", "g1", "s1");
	harness.call("c1", "t1", "call-1");
	return { disk, harness, control, make, binder: make() };
}

/** A `send` that records what it was given and answers `answer`. */
function sender(answer: () => Promise<unknown> = async () => known) {
	const sent: NativeBinding[] = [];
	const send = async (binding: NativeBinding) => {
		sent.push(binding);
		return (await answer()) as NativeOutcome;
	};
	return { sent, send };
}

const bindingId = async (binder: NativeIdentityBinder, ...args: Parameters<NativeIdentityBinder["bind"]>) => {
	const bound = await binder.bind(...args);
	if (!bound.ok) throw new Error(`not bound: ${bound.reason}`);
	return bound.binding.id;
};

describe("binding a native-app call to who makes it", () => {
	it("verifies the call first, stores the binding before returning it, and sends that frozen copy once", async () => {
		const { binder, disk, harness } = setup();
		// What the arguments are is read only after the authority vouched for the call.
		const reads: string[] = [];
		const args = new Proxy(click(), {
			getOwnPropertyDescriptor: (target, key) => {
				reads.push(String(key));
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});
		harness.answer = () => ({ status: "refused", reason: "stopped" });
		expect(await binder.bind(claim(), "click", args)).toMatchObject({ ok: false, reason: "stopped" });
		expect(reads).toEqual([]);
		harness.answer = null;

		const bound = await binder.bind(claim(), "click", args);
		if (!bound.ok) throw new Error(bound.reason);
		expect(bound).toMatchObject({ replayed: false });
		expect(bound.binding).toEqual({
			id: "b1",
			identity: { owner: SPACE, agentId: "agent-a", conversationId: "c1", toolTaskId: "t1", callId: "call-1", runAnchor: "s1" },
			tool: "click",
			arguments: { pid: 42, x: 10, y: 20 },
			lease: lease1,
		});
		expect([bound.binding, bound.binding.identity, bound.binding.arguments, bound.binding.lease].every(Object.isFrozen)).toBe(true);
		expect(JSON.parse(disk.value!).records).toEqual([expect.objectContaining({ id: "b1", status: "bound" })]);

		// Changing the caller's object after binding changes nothing sent.
		args.x = 999;
		const atSend: string[] = [];
		const { sent, send } = sender(async () => {
			atSend.push(JSON.parse(disk.value!).records[0].status);
			return known;
		});
		expect(await binder.dispatch("b1", send)).toEqual({ ok: true, outcome: known });
		expect(atSend).toEqual(["claimed"]);
		expect(sent.map((binding) => binding.arguments)).toEqual([{ pid: 42, x: 10, y: 20 }]);
		expect(binder.status("b1")).toBe("closed");

		expect(await binder.dispatch("b1", send)).toMatchObject({ ok: false, reason: "closed" });
		expect(await binder.bind(claim(), "click", click())).toMatchObject({ ok: false, reason: "closed" });
		expect(sent).toHaveLength(1);
	});

	it("refuses unsent, storing nothing, whatever the authority can't vouch for", async () => {
		const { binder, disk, harness } = setup();
		const identity = { owner: SPACE, agentId: "agent-a", conversationId: "c1", toolTaskId: "t1", callId: "call-1", runAnchor: "s1" };
		for (const reason of AUTHORITY_REFUSALS) {
			harness.answer = () => ({ status: "refused", reason });
			expect(await binder.bind(claim(), "click", click())).toMatchObject({ ok: false, reason });
		}
		const answers: [unknown, string][] = [
			[undefined, "authority_failed"],
			[{ status: "verified" }, "authority_failed"],
			[{ status: "refused", reason: "busy" }, "authority_failed"],
			[{ status: "verified", identity, extra: true }, "authority_failed"],
			[{ status: "verified", identity: { ...identity, runAnchor: undefined } }, "authority_failed"],
			[{ status: "verified", identity: { ...identity, runAnchor: "" } }, "authority_failed"],
			[{ status: "verified", identity: { ...identity, agentId: "agent a" } }, "authority_failed"],
			[{ status: "verified", identity: { ...identity, sessionId: "x" } }, "authority_failed"],
			[{ status: "verified", identity: { ...identity, owner: "space-2" } }, "identity"],
			[{ status: "verified", identity: { ...identity, toolTaskId: "t2" } }, "identity"],
			[{ status: "verified", identity: { ...identity, callId: "call-2" } }, "identity"],
			[{ status: "verified", identity: { ...identity, conversationId: "c2" } }, "identity"],
		];
		for (const [answer, reason] of answers) {
			harness.answer = () => answer;
			expect(await binder.bind(claim(), "click", click()), JSON.stringify(answer)).toMatchObject({ ok: false, reason });
		}
		harness.answer = () => {
			throw new Error("the harness is closing");
		};
		expect(await binder.bind(claim(), "click", click())).toMatchObject({ ok: false, reason: "authority_failed" });
		harness.answer = null;

		// The claim is the harness's invocation, and names no run: a client can't supply one.
		const claims: unknown[] = [{ conversationId: "c1", toolTaskId: "t1" }, { ...claim(), runId: "r1" }, { ...claim(), callId: "" }, { ...claim(), toolTaskId: "t 1" }, null];
		for (const bad of claims) {
			expect(await binder.bind(bad as NativeIdentityClaim, "click", click())).toMatchObject({ ok: false, reason: "invalid_request" });
		}
		for (const [tool, args] of [
			["launch_app", { name: "xterm" }],
			["click", [1]],
			["click", { pid: 1, toJSON: () => ({}) }],
			["click", { pid: 1, when: new Date() }],
			["click", { pid: 1, text: "x".repeat(40_000) }],
		] as const) {
			expect(await binder.bind(claim(), tool, args)).toMatchObject({ ok: false, reason: "invalid_request" });
		}
		expect(disk).toMatchObject({ value: undefined, writes: 0 });
	});

	it("keeps a call's binding across its approval's suspension and a restart, and sends it from there", async () => {
		const { binder, make } = setup();
		const first = await binder.bind(claim(), "click", click());
		// The process ends while the call waits, suspended, for its approval; the call is woken in the next one.
		const restarted = make();
		const again = await restarted.bind(claim(), "click", click());
		expect(again).toEqual({ ok: true, binding: first.ok && first.binding, replayed: true });
		const { sent, send } = sender();
		expect(await restarted.dispatch("b1", send)).toEqual({ ok: true, outcome: known });
		expect(sent).toHaveLength(1);
	});

	it("keeps a run's anchor across handover and steering, and latches the run once a call's end is unknown", async () => {
		const { binder, harness, make } = setup();
		await bindingId(binder, claim(), "click", click());
		expect(await binder.dispatch("b1", sender(async () => unknown).send)).toEqual({ ok: true, outcome: unknown });
		expect(binder.status("b1")).toBe("unknown");

		// The round ends, the next generation takes the run, and a steering input joins it.
		harness.finish("t1");
		harness.handOver("c1", "g2");
		harness.steer("c1", "s2");
		harness.call("c1", "t2", "call-2");
		expect(await binder.bind(claim("t2", "call-2"), "click", click())).toMatchObject({ ok: false, reason: "run_uncertain" });
		// A tool task of the generation that handed the run over isn't the run's.
		harness.tasks.set("t0", { conversationId: "c1", callId: "call-0", owner: "g1", live: true });
		expect(await binder.bind(claim("t0", "call-0"), "click", click())).toMatchObject({ ok: false, reason: "not_run_owned" });
		// After a restart too, and for the uncertain call itself.
		const restarted = make();
		expect(await restarted.bind(claim("t2", "call-2"), "click", click())).toMatchObject({ ok: false, reason: "run_uncertain" });
		expect(await restarted.dispatch("b1", sender().send)).toMatchObject({ ok: false, reason: "uncertain" });

		// A successor run, from another input, is another run, even with a call ID seen before.
		harness.end("c1");
		harness.start("c1", "g3", "s3");
		harness.call("c1", "t3", "call-1");
		const next = await restarted.bind(claim("t3", "call-1"), "click", click());
		expect(next).toMatchObject({ ok: true, binding: { identity: { runAnchor: "s3", callId: "call-1" } } });
	});

	it("refuses a call ID seen before in the same run", async () => {
		const { binder, harness } = setup();
		await bindingId(binder, claim(), "click", click());
		harness.finish("t1");
		harness.handOver("c1", "g2");
		harness.call("c1", "t2", "call-1");
		expect(await binder.bind(claim("t2", "call-1"), "click", click())).toMatchObject({ ok: false, reason: "ambiguous_call" });
		expect(binder.status("b2")).toBeNull();
	});

	it("closes a binding whose call changed, and sends nothing", async () => {
		const changes: [string, (harness: StandInHarness) => void][] = [
			["another agent", (harness) => harness.agents.set("c1", "agent-b")],
			[
				"another run",
				(harness) => {
					harness.answer = (claim) => ({ status: "verified", identity: { owner: SPACE, agentId: "agent-a", ...claim, runAnchor: "s9" } });
				},
			],
			["a stopped run", (harness) => harness.end("c1")],
			["a missing task", (harness) => harness.tasks.delete("t1")],
		];
		for (const [name, change] of changes) {
			const { binder, harness } = setup();
			await bindingId(binder, claim(), "click", click());
			change(harness);
			const { sent, send } = sender();
			expect((await binder.dispatch("b1", send)).ok, name).toBe(false);
			expect(binder.status("b1"), name).toBe("closed");
			harness.answer = null;
			expect(await binder.dispatch("b1", send), name).toMatchObject({ ok: false, reason: "closed" });
			expect(sent, name).toEqual([]);
		}

		// The same tool task asking again with other arguments, or another tool, closes its binding.
		for (const [tool, args] of [["click", { pid: 42, x: 11, y: 20 }], ["click", { pid: 42, y: 20, x: 10 }], ["type_text", { pid: 42, text: "rm -rf ~" }]] as const) {
			const { binder } = setup();
			await bindingId(binder, claim(), "click", click());
			expect(await binder.bind(claim(), tool, args)).toMatchObject({ ok: false, reason: "changed" });
			expect(await binder.dispatch("b1", sender().send)).toMatchObject({ ok: false, reason: "closed" });
		}

		// Another space's binder finds the document isn't its own, and touches nothing.
		const { binder, disk, make } = setup();
		await bindingId(binder, claim(), "click", click());
		const stored = disk.value;
		const other = make("space-2");
		expect(other.blocked).toMatch(/another space/);
		expect(await other.dispatch("b1", sender().send)).toMatchObject({ ok: false, reason: "blocked" });
		expect(disk.value).toBe(stored);
	});

	it("an authority that fails at dispatch leaves the call bound and unsent", async () => {
		const { binder, harness } = setup();
		await bindingId(binder, claim(), "click", click());
		harness.answer = () => {
			throw new Error("the harness is closing");
		};
		const { sent, send } = sender();
		expect(await binder.dispatch("b1", send)).toMatchObject({ ok: false, reason: "authority_failed" });
		expect(binder.status("b1")).toBe("bound");
		harness.answer = null;
		expect(await binder.dispatch("b1", send)).toEqual({ ok: true, outcome: known });
		expect(sent).toHaveLength(1);
	});

	it("binds to the agent's lease, keeps it on replay, and refuses after a takeover", async () => {
		const { binder, control, disk } = setup();
		control.lease = null;
		expect(await binder.bind(claim(), "click", click())).toMatchObject({ ok: false, reason: "not_agent_owned" });
		expect(disk.writes).toBe(0);

		control.lease = lease1;
		await bindingId(binder, claim(), "click", click());
		// The person took over and handed back: a new epoch and lease.
		control.lease = { epoch: 3, leaseId: "L3" };
		expect(await binder.bind(claim(), "click", click())).toMatchObject({ ok: true, replayed: true, binding: { lease: lease1 } });
		const { sent, send } = sender();
		expect(await binder.dispatch("b1", send)).toMatchObject({ ok: false, reason: "stale_lease" });
		expect(binder.status("b1")).toBe("closed");
		expect(sent).toEqual([]);
	});

	it("survives a crash before or after its binding is stored", async () => {
		// Before: nothing was stored, so nothing is bound, here or after a restart, until the call binds again.
		{
			const { binder, disk, make } = setup();
			disk.fail = "before";
			expect(await binder.bind(claim(), "click", click())).toMatchObject({ ok: false, reason: "blocked" });
			disk.fail = null;
			expect(await binder.bind(claim(), "click", click())).toMatchObject({ ok: false, reason: "blocked" });
			expect(disk.value).toBeUndefined();
			expect(await make().bind(claim(), "click", click())).toMatchObject({ ok: true, replayed: false });
		}
		// After: the binding was stored though the write didn't say so; the call finds it after a restart.
		{
			const { binder, disk, make } = setup();
			disk.fail = "after";
			expect(await binder.bind(claim(), "click", click())).toMatchObject({ ok: false, reason: "blocked" });
			disk.fail = null;
			expect(await make().bind(claim(), "click", click())).toMatchObject({ ok: true, replayed: true, binding: { id: "b1" } });
		}
	});

	it("takes a dispatch whose end wasn't recorded as unknown after a restart, and never sends it again", async () => {
		const { binder, disk, harness, make } = setup();
		await bindingId(binder, claim(), "click", click());
		let started!: () => void;
		const sending = new Promise<void>((resolve) => (started = resolve));
		// The process ends while the call is out: its reply never comes.
		void binder.dispatch("b1", async () => {
			started();
			return new Promise<NativeOutcome>(() => {});
		});
		await sending;
		expect(JSON.parse(disk.value!).records[0].status).toBe("claimed");

		const restarted = make();
		expect(restarted.status("b1")).toBe("unknown");
		expect(JSON.parse(disk.value!).records[0].status).toBe("unknown");
		const { sent, send } = sender();
		expect(await restarted.dispatch("b1", send)).toMatchObject({ ok: false, reason: "uncertain" });
		expect(await restarted.bind(claim(), "click", click())).toMatchObject({ ok: false, reason: "uncertain" });
		harness.call("c1", "t2", "call-2");
		expect(await restarted.bind(claim("t2", "call-2"), "click", click())).toMatchObject({ ok: false, reason: "run_uncertain" });
		expect(sent).toEqual([]);
	});

	it("latches on a failed write, sending nothing more until a restart reads what was stored", async () => {
		const { binder, disk, harness, make } = setup();
		await bindingId(binder, claim(), "click", click());
		disk.fail = "before";
		const { sent, send } = sender();
		expect(await binder.dispatch("b1", send)).toMatchObject({ ok: false, reason: "blocked" });
		disk.fail = null;
		expect(await binder.dispatch("b1", send)).toMatchObject({ ok: false, reason: "blocked" });
		harness.call("c1", "t2", "call-2");
		expect(await binder.bind(claim("t2", "call-2"), "click", click())).toMatchObject({ ok: false, reason: "blocked" });
		expect(binder.release("b1")).toBe(false);
		expect(sent).toEqual([]);
		// Nothing was sent, and the store still says bound.
		expect(await make().dispatch("b1", send)).toEqual({ ok: true, outcome: known });

		// A settlement that can't be stored: the outcome is returned, and a restart takes the call as unknown.
		const second = setup();
		await bindingId(second.binder, claim(), "click", click());
		const settled = await second.binder.dispatch("b1", async () => {
			second.disk.fail = "before";
			return known;
		});
		expect(settled).toEqual({ ok: true, outcome: known });
		second.disk.fail = null;
		expect(second.make().status("b1")).toBe("unknown");
	});

	it("settles from what was sent, taking anything but a known outcome as unknown", async () => {
		const cases: [string, () => Promise<unknown>, string, boolean][] = [
			["a completed call", async () => known, "closed", true],
			["a refusal before spacesd", async () => ({ status: "rejected", reason: "busy" }), "closed", true],
			["an unknown outcome", async () => unknown, "unknown", true],
			["an unreadable answer", async () => ({ status: "completed" }), "unknown", false],
			["a send that throws", async () => Promise.reject(new Error("socket closed")), "unknown", false],
			["the control state's refusal", async () => Promise.reject(new ControlRefused("not_agent_owned", "the person has control")), "closed", false],
		];
		for (const [name, answer, status, ok] of cases) {
			const { binder, harness } = setup();
			await bindingId(binder, claim(), "click", click());
			expect((await binder.dispatch("b1", sender(answer).send)).ok, name).toBe(ok);
			expect(binder.status("b1"), name).toBe(status);
			// Only an unknown end latches the run.
			harness.call("c1", "t2", "call-2");
			expect((await binder.bind(claim("t2", "call-2"), "click", click())).ok, name).toBe(status !== "unknown");
		}
	});

	it("remembers a bounded number of bindings, letting go only of closed ones", async () => {
		const { binder, disk, harness } = setup();
		for (let index = 0; index < MAX_NATIVE_BINDINGS; index++) {
			harness.call("c1", `t${index}`, `call-${index}`);
			await bindingId(binder, claim(`t${index}`, `call-${index}`), "click", click());
		}
		harness.call("c1", "t-next", "call-next");
		expect(await binder.bind(claim("t-next", "call-next"), "click", click())).toMatchObject({ ok: false, reason: "full" });
		// One left unknown and one closed: only the closed one is let go, for a call of the next run.
		expect(await binder.dispatch("b1", sender(async () => unknown).send)).toMatchObject({ ok: true });
		expect(binder.release("b2")).toBe(true);
		harness.end("c1");
		harness.start("c1", "g9", "s9");
		harness.call("c1", "t-next", "call-next");
		const next = await binder.bind(claim("t-next", "call-next"), "click", click());
		expect(next).toMatchObject({ ok: true });
		expect(binder.status("b2")).toBeNull();
		expect(binder.status("b1")).toBe("unknown");
		expect(JSON.parse(disk.value!).records).toHaveLength(MAX_NATIVE_BINDINGS);

		// Large arguments reach the document's bound before the count does.
		const big = setup();
		let bound = 0;
		for (;;) {
			big.harness.call("c1", `t${bound}`, `call-${bound}`);
			const result = await big.binder.bind(claim(`t${bound}`, `call-${bound}`), "type_text", { pid: 1, text: "x".repeat(30_000) });
			if (!result.ok) {
				expect(result.reason).toBe("full");
				break;
			}
			bound++;
		}
		expect(bound).toBeLessThan(MAX_NATIVE_BINDINGS);
		expect(big.disk.value!.length).toBeLessThanOrEqual(MAX_NATIVE_BINDINGS_CHARS);
	});

	it("refuses everything over a stored document it can't read, and leaves it as it is", async () => {
		const { binder, disk } = setup();
		await bindingId(binder, claim(), "click", click());
		const good = JSON.parse(disk.value!);
		const record = good.records[0];
		const documents = [
			"not JSON",
			JSON.stringify({ ...good, version: 2 }),
			JSON.stringify({ ...good, records: undefined }),
			JSON.stringify({ ...good, extra: 1 }),
			JSON.stringify({ ...good, records: [{ ...record, status: "sent" }] }),
			JSON.stringify({ ...good, records: [{ ...record, identity: { ...record.identity, owner: "space-2" } }] }),
			JSON.stringify({ ...good, records: [{ ...record, identity: { ...record.identity, runAnchor: undefined } }] }),
			JSON.stringify({ ...good, records: [{ ...record, tool: "launch_app" }] }),
			JSON.stringify({ ...good, records: [{ ...record, lease: { epoch: -1, leaseId: "L1" } }] }),
			JSON.stringify({ ...good, records: [record, { ...record, id: "b2" }] }),
			JSON.stringify({ ...good, records: [record, { ...record, id: "b2", identity: { ...record.identity, toolTaskId: "t2" } }] }),
			JSON.stringify({ ...good, records: Array.from({ length: MAX_NATIVE_BINDINGS + 1 }, (_, index) => ({ ...record, id: `b${index}` })) }),
			" ".repeat(MAX_NATIVE_BINDINGS_CHARS + 1),
		];
		for (const document of documents) {
			const { disk, make } = setup();
			disk.value = document;
			const restored = make();
			expect(restored.blocked, document.slice(0, 80)).not.toBeNull();
			expect(await restored.bind(claim(), "click", click())).toMatchObject({ ok: false, reason: "blocked" });
			expect(await restored.dispatch("b1", sender().send)).toMatchObject({ ok: false, reason: "blocked" });
			expect(disk).toMatchObject({ value: document, writes: 0 });
		}
	});
});
