// What keeps a chat from staying busy for ever: a model stream that goes silent is cut off (and, before any output, the request goes to the next model), and a tool whose
// work never ends is stopped by the person's stop or by its timeout. The Runner's own stop and watchdog are tested in v2-runtime/test/runner.test.ts.
import { describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-durable";
import { DELIVERY_REMINDER } from "@pim/shared/transcript";
import { stoppable } from "../src/agent-tools.ts";
import { type CooldownStore, createFailover } from "../src/provider-failover.ts";

const never = () => new Promise<never>(() => {});

describe("a silent model stream", () => {
	const rig = () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "a" }, { id: "b" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		return { faux, models };
	};
	const ask = (models: any, id: string, signal?: AbortSignal) => models.stream(models.getModel("faux", id), { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { signal }).result();

	it("goes to the next model when it stalls before any output, and cools the one that stalled", async () => {
		const { faux, models } = rig();
		const failover = createFailover({ stallMs: 150, stallRetryMs: 10 });
		failover.setChain("o", { provider: "faux", id: "a" }, [{ provider: "faux", id: "a" }, { provider: "faux", id: "b" }]);
		// The silent model is asked once more before the next one is.
		faux.setResponses([never, never, fauxAssistantMessage("from b")]);
		const message = await ask(failover.wrap(models, "o"), "a");
		expect(message.stopReason).toBe("stop");
		expect(JSON.stringify(message.content)).toContain("from b");
		// The message records the model that answered, not the one the chat asked for: what every transcript's model label is read from.
		expect([message.provider, message.model]).toEqual(["faux", "b"]);
		expect(failover.isCooling("o", { provider: "faux", id: "a" })).toBe(true);
	});

	it("ends with a visible error when nothing else can answer, and with an aborted message when the person stops it", async () => {
		const { faux, models } = rig();
		const failover = createFailover({ stallMs: 150, stallRetryMs: 10 });
		faux.setResponses([never, never]);
		const message = await ask(failover.wrap(models, "o"), "a");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/timed out.*nothing/);

		faux.setResponses([never]);
		const stop = new AbortController();
		const pending = ask(createFailover({ stallMs: 60_000 }).wrap(models, "o"), "a", stop.signal);
		setTimeout(() => stop.abort(), 50);
		expect((await pending).stopReason).toBe("aborted");
	});
});

describe("a stalled model is asked once more, then replaced for the rest of the turn", () => {
	const rig = () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "a" }, { id: "b" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		return { faux, models };
	};
	const events: { kind: string; detail: Record<string, unknown> }[] = [];
	const failover = (extra: Parameters<typeof createFailover>[0] = {}) => {
		events.length = 0;
		const f = createFailover({ stallMs: 100, stallRetryMs: 20, event: (_o, kind, detail) => void events.push({ kind, detail }), ...extra });
		f.setChain("o", { provider: "faux", id: "a" }, [{ provider: "faux", id: "a" }, { provider: "faux", id: "b" }]);
		return f;
	};
	const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
	const ask = (models: any, messages: unknown[], signal?: AbortSignal) => models.stream(models.getModel("faux", "a"), { messages }, { signal, sessionId: "s1" }).result();
	const from = (m: any) => JSON.stringify(m.content);
	const limited = (text: string) => fauxAssistantMessage([], { stopReason: "error", errorMessage: text });

	it("asks the same model again after a stall, and says so, without cooling it", async () => {
		const { faux, models } = rig();
		const f = failover();
		faux.setResponses([never, fauxAssistantMessage("from a")]);
		const message = await ask(f.wrap(models, "o"), [user("hi", 1)]);
		expect(from(message)).toContain("from a");
		expect(faux.state.callCount).toBe(2);
		expect(f.isCooling("o", { provider: "faux", id: "a" })).toBe(false);
		expect(events.map((e) => e.kind)).toEqual(["model_call_failed"]);
		expect(events[0]!.detail).toMatchObject({ retrying: true, tryingNext: false, note: "model stalled; retrying once" });
	});

	it("falls back after the second stall, about two idle limits and a pause later", async () => {
		const { faux, models } = rig();
		const f = failover();
		faux.setResponses([never, never, fauxAssistantMessage("from b")]);
		const started = Date.now();
		const message = await ask(f.wrap(models, "o"), [user("hi", 1)]);
		const took = Date.now() - started;
		expect(from(message)).toContain("from b");
		expect(took).toBeGreaterThanOrEqual(2 * 100 + 20 - 10);
		expect(took).toBeLessThan(2 * 100 + 20 + 400);
		expect(f.isCooling("o", { provider: "faux", id: "a" })).toBe(true);
		expect(events.map((e) => e.kind)).toEqual(["model_call_failed", "model_call_failed", "provider_cooldown", "failover"]);
		expect(events.filter((e) => e.kind === "model_call_failed").map((e) => e.detail.note)).toEqual(["model stalled; retrying once", "model stalled twice; falling back"]);
	});

	it("ends with the timeout error when the only model stalls twice", async () => {
		const { faux, models } = rig();
		const f = createFailover({ stallMs: 80, stallRetryMs: 10 });
		faux.setResponses([never, never]);
		const message = await ask(f.wrap(models, "o"), [user("hi", 1)]);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/timed out/);
		expect(faux.state.callCount).toBe(2);
	});

	it("does not ask again after quota, a refused credential or an invalid request", async () => {
		for (const [text, next] of [["429 rate limit reached: usage limit", true], ["401 unauthorized", true], ["400 invalid_request_error: bad", false]] as const) {
			const { faux, models } = rig();
			faux.setResponses([limited(text), fauxAssistantMessage("from b")]);
			const message = await ask(failover().wrap(models, "o"), [user("hi", 1)]);
			expect(faux.state.callCount, text).toBe(next ? 2 : 1);
			expect(message.stopReason, text).toBe(next ? "stop" : "error");
			expect(events.some((e) => e.detail.retrying), text).toBe(false);
		}
	});

	it("keeps the fallback for the rest of the turn, and goes back to the agent's model on the next message", async () => {
		const { faux, models } = rig();
		const f = failover({ cooldowns: { transientMs: 1 } });
		const wrapped = f.wrap(models, "o");
		faux.setResponses([never, never, fauxAssistantMessage("b1")]);
		const turn = [user("hi", 1)];
		const first: any = await ask(wrapped, turn);
		expect(first.model).toBe("b");
		await new Promise((r) => setTimeout(r, 30));
		expect(f.isCooling("o", { provider: "faux", id: "a" })).toBe(false);
		// A later request of the same turn (after a tool round and a delivery reminder) is b's, though a's cooldown has ended.
		const round = [...turn, first, { role: "toolResult", toolCallId: "t", toolName: "x", content: [], isError: false, timestamp: 2 }, user(DELIVERY_REMINDER, 3)];
		faux.setResponses([fauxAssistantMessage("b2")]);
		expect(((await ask(wrapped, round)) as any).model).toBe("b");
		// The person's next message is another turn: a is asked first again.
		faux.setResponses([fauxAssistantMessage("a3")]);
		expect(((await ask(wrapped, [...round, user("again", 9)])) as any).model).toBe("a");
		expect(events.filter((e) => e.kind === "failover")).toHaveLength(1);
	});

	it("stops at once when the person stops it during the pause", async () => {
		const { faux, models } = rig();
		const f = createFailover({ stallMs: 50, stallRetryMs: 60_000 });
		faux.setResponses([never, fauxAssistantMessage("never asked")]);
		const stop = new AbortController();
		setTimeout(() => stop.abort(), 200);
		const started = Date.now();
		const message = await ask(f.wrap(models, "o"), [user("hi", 1)], stop.signal);
		expect(message.stopReason).toBe("aborted");
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(faux.state.callCount).toBe(1);
	});
});

describe("a tool that never returns", () => {
	const hung = (timeoutMs?: number) => stoppable(defineTool({ name: "hung", description: "x", parameters: Type.Object({}), execute: never } as never) as never, timeoutMs) as any;

	it("ends with the stop, even though its own work ignores the abort signal", async () => {
		const stop = new AbortController();
		const call = hung().execute({}, {}, { abortSignal: stop.signal });
		setTimeout(() => stop.abort(new Error("stopped")), 30);
		await expect(call).rejects.toThrow("stopped");
	});

	it("ends with an error result at its timeout, and a tool that returns is untouched", async () => {
		const result = await hung(80).execute({}, {}, { abortSignal: new AbortController().signal });
		expect(result.isError).toBe(true);
		expect(result.output[0].text).toMatch(/did not finish/);
		const quick = stoppable(defineTool({ name: "q", description: "x", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "ok" }] }) } as never) as never, 50) as any;
		expect((await quick.execute({}, {}, { abortSignal: new AbortController().signal })).output[0].text).toBe("ok");
	});
});

describe("cooldowns and failover across Runners", () => {
	const rig = () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "a" }, { id: "b" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		return { faux, models };
	};
	const ask = (models: any, id: string) => models.stream(models.getModel("faux", id), { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {}).result();
	const limited = (blocks: unknown[] = []) => fauxAssistantMessage(blocks as never, { stopReason: "error", errorMessage: "429 rate limit reached" });
	const memoryStore = (): CooldownStore => {
		const rows = new Map<string, number>();
		return { load: async () => new Map(rows), save: async (_o, provider, id, until) => void rows.set(`${provider}/${id}`, until) };
	};
	const chain = (f: ReturnType<typeof createFailover>) => f.setChain("o", { provider: "faux", id: "a" }, [{ provider: "faux", id: "a" }, { provider: "faux", id: "b" }]);

	it("a model one Runner found down is skipped by another, which never calls it", async () => {
		const store = memoryStore();
		const first = rig();
		const one = createFailover({ store });
		chain(one);
		first.faux.setResponses([limited(), fauxAssistantMessage("from b")]);
		expect(JSON.stringify((await ask(one.wrap(first.models, "o"), "a")).content)).toContain("from b");

		// A second Runner, with its own memory and the same store, asks for `a` and is answered by `b` at once: `a` is given no request.
		const second = rig();
		const two = createFailover({ store });
		chain(two);
		second.faux.setResponses([fauxAssistantMessage("b again")]);
		expect(JSON.stringify((await ask(two.wrap(second.models, "o"), "a")).content)).toContain("b again");
		expect(second.faux.state.callCount).toBe(1);
		expect(two.isCooling("o", { provider: "faux", id: "a" })).toBe(true);
	});

	it("goes to the next model when a request fails after only thinking, and never after an answer began", async () => {
		const { faux, models } = rig();
		const failover = createFailover({});
		chain(failover);
		faux.setResponses([limited([{ type: "thinking", thinking: "let me see" }]), fauxAssistantMessage("from b")]);
		const events: string[] = [];
		const stream = failover.wrap(models, "o").stream(models.getModel("faux", "a")!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never, {});
		for await (const e of stream) events.push(e.type);
		expect(JSON.stringify((await stream.result()).content)).toContain("from b");
		expect(events).not.toContain("error");

		// Text already shown is final: the failure ends the turn, and `b` is not asked.
		const cooled = createFailover({});
		chain(cooled);
		const again = rig();
		again.faux.setResponses([limited([{ type: "text", text: "half an answer" }]), fauxAssistantMessage("from b")]);
		const message = await ask(cooled.wrap(again.models, "o"), "a");
		expect(message.stopReason).toBe("error");
		expect(JSON.stringify(message.content)).toContain("half an answer");
		expect(again.faux.state.callCount).toBe(1);
	});
});
