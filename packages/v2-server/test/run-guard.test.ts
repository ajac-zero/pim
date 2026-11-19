// What keeps a chat from staying busy for ever: a model stream that goes silent is cut off (and, before any output, the request goes to the next model), and a tool whose
// work never ends is stopped by the person's stop or by its timeout. The Runner's own stop and watchdog are tested in v2-runtime/test/runner.test.ts.
import { describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-durable";
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
		const failover = createFailover({ stallMs: 150 });
		failover.setChain("o", { provider: "faux", id: "a" }, [{ provider: "faux", id: "a" }, { provider: "faux", id: "b" }]);
		faux.setResponses([never, fauxAssistantMessage("from b")]);
		const message = await ask(failover.wrap(models, "o"), "a");
		expect(message.stopReason).toBe("stop");
		expect(JSON.stringify(message.content)).toContain("from b");
		expect(failover.isCooling("o", { provider: "faux", id: "a" })).toBe(true);
	});

	it("ends with a visible error when nothing else can answer, and with an aborted message when the person stops it", async () => {
		const { faux, models } = rig();
		const failover = createFailover({ stallMs: 150 });
		faux.setResponses([never]);
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
