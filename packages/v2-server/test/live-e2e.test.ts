// A turn through every v2 piece between a message and a screen: the Runner commits it to PostgreSQL, the projector turns the
// runtime's commits into views and the live log, Pulse announces it over NATS, Live streams it over a real WebSocket, and the
// web app's LiveClient (`@pim/shared/live-client`) receives it. It needs nats-server on PATH (CI installs it).
import type { IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { projectEntries } from "@pim/shared/transcript";
import type { Principal } from "@pim/v2-contracts/identity";
import { Projector } from "@pim/v2-live/projections/projector";
import { transcriptPage } from "@pim/v2-live/projections/snapshots";
import { LiveHub } from "@pim/v2-live/server/hub";
import { LogStore } from "@pim/v2-live/server/log-store";
import { NatsPulse } from "@pim/v2-live/server/pulse";
import { startLiveServer, type LiveServer } from "@pim/v2-live/server/ws-server";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { runtimeOutboxSource } from "../src/runtime-source.ts";
import { createStack, describeWith, hasNats, startNats, type Nats, type Stack } from "./support/stack.ts";
import { ADA, createTurnRig, fauxAssistantMessage, LEAD } from "./support/turn.ts";
import { LiveClient, type LiveSocket, type LiveUpdate, SnapshotRefused } from "@pim/shared/live-client";

const real = describeWith(hasNats());

/** Gate's part, as a fixture: the cookie names the owner. */
const identity = {
	async authenticate(request: IncomingMessage): Promise<Principal | null> {
		return /pim_session=ada/.test(request.headers.cookie ?? "") ? { kind: "user", ownerId: ADA, role: "member", sessionId: "ada" } : null;
	},
	async stillValid() {
		return true;
	},
};
const allow = { authorize: async () => ({ outcome: "allow" as const }) };
const cookie = { cookie: "pim_session=ada" };

type Message = { message: { id: string; role: string; parts: { type: string; text?: string }[] }; partial: boolean; replaces?: string };

real("a turn from the Runner to a LiveClient", () => {
	let stack: Stack;
	let nats: Nats;
	let pulse: NatsPulse;
	let hub: LiveHub;
	let server: LiveServer;
	let projector: Projector;
	let rig: Awaited<ReturnType<typeof createTurnRig>>;
	let loop: ReturnType<typeof setInterval>;
	let client: LiveClient;
	const updates: LiveUpdate[] = [];

	beforeAll(async () => {
		stack = await createStack();
		nats = await startNats();
		pulse = await NatsPulse.connect(nats.url);
		rig = await createTurnRig(stack);
		projector = new Projector(stack.live, { pulse, source: runtimeOutboxSource(stack.live) });
		loop = setInterval(() => void projector.drainAll().catch(() => {}), 40);
		hub = new LiveHub(new LogStore(stack.live), pulse, identity, allow, { heartbeatMs: 200, revalidateMs: 1_000, pumpMs: 2 });
		server = await startLiveServer(hub, stack.live);
		client = new LiveClient({
			openSocket: () => new WebSocket(`ws://127.0.0.1:${server.port}/live`, { headers: cookie }) as unknown as LiveSocket,
			loadSnapshot: async (topic) => {
				const [kind, id] = topic.split(":");
				const response = await fetch(`http://127.0.0.1:${server.port}/snapshot/${kind}${id ? `/${id}` : ""}`, { headers: cookie });
				if (!response.ok) throw new SnapshotRefused(response.status);
				return { liveCursor: ((await response.json()) as { liveCursor: string | null }).liveCursor };
			},
			onUpdate: (update) => updates.push(update),
			onUnauthorized: () => {},
		});
	}, 120_000);
	afterAll(async () => {
		clearInterval(loop);
		client?.stop();
		await rig?.runner.stop();
		await hub?.close();
		await server?.close();
		await pulse?.close();
		nats?.stop();
		await stack?.drop();
	});

	/** Every transcript message the client was told of on a topic, in order, whether it arrived alone or folded into a batch. */
	const messages = (topic: string): Message[] =>
		updates
			.filter((u) => u.topic === topic)
			.flatMap((u) => (u.kind === "batch" ? (u.data as { events: { kind: string; data: unknown }[] }).events : [{ kind: u.kind, data: u.data }]))
			.filter((e) => e.kind === "message" || e.kind === "message.partial" || e.kind === "progress")
			.map((e) => e.data as Message);

	it("streams the partials, the tool call and the final answer, and a rebuild gives the same transcript with no effect repeated", async () => {
		rig.faux.setResponses([fauxAssistantMessage("Hello, Ada.")]);
		await rig.submit("c1", "hi");
		const chat = await waitFor("the home conversation's public id", () => rig.chatId());
		const topic = `chat:${chat}`;
		await waitFor("the first answer to be projected", async () => (await transcriptPage(stack.live, ADA, chat)).messages.some((m) => m.role === "assistant" && !m.partial));
		client.follow([topic, "sidebar"]);
		await waitFor("the client to be live", () => (client.status === "live" ? true : undefined));
		updates.length = 0;

		rig.scriptTurn();
		await rig.submit("c2", "please echo ping");
		await waitFor("the final answer to reach the client", () => (messages(topic).some((m) => !m.partial && m.message.parts.some((p) => p.text?.includes("All done"))) ? true : undefined), 30_000);

		const seen = messages(topic);
		const lengths = seen.filter((m) => m.partial).map((m) => m.message.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("")).filter((t) => t.length > 0 && LEAD.startsWith(t)).map((t) => t.length);
		expect(new Set(lengths).size).toBeGreaterThan(1);
		expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
		expect(seen.filter((m) => !m.partial).map((m) => m.message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
		expect(seen.filter((m) => !m.partial && m.replaces !== undefined)).toHaveLength(2);
		expect(rig.echoRuns).toEqual(["ping"]);
		// The sidebar told the client the chat was busy, then idle.
		const busy = () => updates.filter((u) => u.topic === "sidebar").map((u) => (u.data as { busy: boolean }).busy);
		await waitFor("the sidebar to say the chat is idle again", () => (busy().at(-1) === false ? true : undefined));
		expect(busy()[0]).toBe(true);

		// The final transcript is the runtime's committed one, and a rebuild from the runtime's tables reproduces it.
		await waitFor("the projector to catch up", async () => ((await projector.lag()).every((l) => l.lagCommits === 0) ? true : undefined));
		const committed = projectEntries(await readTranscript(stack.runtime, ADA, rig.home, 1)).map((m) => m.id);
		const shown = await transcriptPage(stack.live, ADA, chat);
		expect(shown.messages.map((m) => m.id)).toEqual(committed);
		expect(shown.messages.some((m) => m.partial)).toBe(false);
		const before = JSON.stringify(shown.messages);
		await projector.rebuild(ADA);
		expect(JSON.stringify((await transcriptPage(stack.live, ADA, chat)).messages)).toBe(before);
		expect(rig.echoRuns).toEqual(["ping"]);

		// Switching away from the chat unsubscribes it on the same socket: nothing more of it arrives, and the socket stays up.
		client.follow(["sidebar"]);
		updates.length = 0;
		rig.faux.setResponses([fauxAssistantMessage("Another one.")]);
		await rig.submit("c3", "and again");
		await waitFor("the sidebar to hear of it", () => (updates.some((u) => u.topic === "sidebar") ? true : undefined));
		await waitFor("the third answer to be projected", async () => (await transcriptPage(stack.live, ADA, chat)).messages.some((m) => m.parts.some((p) => "text" in p && p.text === "Another one.")));
		expect(updates.some((u) => u.topic === topic)).toBe(false);
		expect(client.status).toBe("live");
	});
});
