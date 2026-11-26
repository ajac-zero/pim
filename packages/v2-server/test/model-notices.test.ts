// What the person is told in the chat when a stalled model is asked again or a fallback takes over: it is stored with the answer of the request it happened in, so it is in the
// projected transcript, in Live's views and after a rebuild, and it is nothing the model reads or a run starts from.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectEntries } from "@pim/shared/transcript";
import { Projector } from "@pim/v2-live/projections/projector";
import { transcriptPage } from "@pim/v2-live/projections/snapshots";
import { runtimeOutboxSource } from "../src/runtime-source.ts";
import { createFailover } from "../src/provider-failover.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { createStack, type Stack } from "./support/stack.ts";
import { ADA, createTurnRig, fauxAssistantMessage } from "./support/turn.ts";

const never = () => new Promise<never>(() => {});

describe("the chat's notices of a model that was asked again or replaced", () => {
	let stack: Stack;
	let rig: Awaited<ReturnType<typeof createTurnRig>>;
	let projector: Projector;
	let loop: ReturnType<typeof setInterval>;

	beforeAll(async () => {
		stack = await createStack();
		const failover = createFailover({ stallMs: 150, stallRetryMs: 10 });
		failover.setChain(ADA, { provider: "faux", id: "m" }, [{ provider: "faux", id: "m" }, { provider: "faux", id: "n" }]);
		rig = await createTurnRig(stack, failover);
		projector = new Projector(stack.live, { source: runtimeOutboxSource(stack.live) });
		loop = setInterval(() => void projector.drainAll().catch(() => {}), 40);
	});
	afterAll(async () => {
		clearInterval(loop);
		await rig?.runner.stop();
		await stack?.drop();
	});

	it("stays in the history after a reload, is shown before the answer it belongs to, and is not in what the next request carries to the model", async () => {
		// m stalls twice and n answers: a retry, then a fallback, both on n's answer.
		rig.faux.setResponses([never, never, fauxAssistantMessage("from n")]);
		await rig.submit("c1", "hi");
		const chat = await waitFor("the home conversation's public id", () => rig.chatId());
		await waitFor("the answer", async () => (await transcriptPage(stack.live, ADA, chat)).messages.some((m) => m.role === "assistant" && !m.partial));
		const notices = [{ kind: "retry", model: "m" }, { kind: "fallback", from: "m", to: "n", cause: "stalled" }];
		const stored = await readTranscript(stack.runtime, ADA, rig.home, 1);
		const projected = projectEntries(stored);
		expect(projected.map((m) => [m.role, m.notices ?? null])).toEqual([["user", null], ["assistant", notices]]);
		expect(projected.at(-1)).toMatchObject({ model: { provider: "faux", model: "n" } });

		// Live's view, which the web app loads on a reload, has the same, and a rebuild from the runtime's tables keeps it.
		await waitFor("the projector to catch up", async () => ((await projector.lag()).every((l) => l.lagCommits === 0) ? true : undefined));
		const view = async () => (await transcriptPage(stack.live, ADA, chat)).messages.map((m) => [m.role, (m as { notices?: unknown }).notices ?? null]);
		expect(await view()).toEqual([["user", null], ["assistant", notices]]);
		await projector.rebuild(ADA);
		expect(await view()).toEqual([["user", null], ["assistant", notices]]);

		// The next message: the model is asked first again on m, and is not shown anything of the notices; nothing new is told.
		let carried = "";
		rig.faux.setResponses([(context: { messages: unknown[] }) => {
			carried = JSON.stringify(context.messages.map((m: any) => (m.role === "assistant" ? m.content : m)));
			return fauxAssistantMessage("from m");
		}]);
		await rig.submit("c2", "again");
		await waitFor("the second answer", async () => (projectEntries(await readTranscript(stack.runtime, ADA, rig.home, 1)).length >= 4 ? true : undefined));
		expect(carried).toContain("from n");
		expect(carried).not.toMatch(/stalled|once more|continuing with|modelNotices/);
		expect(projectEntries(await readTranscript(stack.runtime, ADA, rig.home, 1)).map((m) => m.notices ?? null)).toEqual([null, notices, null, null]);
	}, 60_000);
});
