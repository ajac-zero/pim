// Progress lines: while an agent works, the utility model says what it is doing in a few words, for the tool calls of each step, and the person's open apps are told as a notice
// (Pulse), which the chat on screen shows beside those calls. On the real stack (Gate, Runner, NATS) with a stand-in utility model and the faux model; the step's own tools are real.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NatsPulse, type Notice } from "@pim/v2-live/server/pulse";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { Progress } from "../src/progress.ts";
import { waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";


const real = describeWith(hasNats());

describe("the lines of a step", () => {
	const message = (calls: { id: string; name: string }[], text = "") =>
		({ role: "assistant", content: [...(text ? [{ type: "text", text }] : []), ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: { q: "x" } }))], stopReason: "toolUse" }) as never;

	it("describes the tool calls of a step once, at most one line at a time, and leaves out a final answer, the model's own headings and a person without a utility model", async () => {
		const asked: string[] = [];
		const shown: [string, readonly string[]][] = [];
		const progress = new Progress({
			gapMs: 20,
			describe: async (_chat, input) => (asked.push(input), `Line ${asked.length}`),
			show: (_chat, line, calls) => shown.push([line, calls]),
		});
		progress.request("c", [{ role: "user", content: "find me flights", timestamp: 1 }]);
		progress.step("c", message([{ id: "a", name: "fetch_url" }, { id: "b", name: "recall" }], "Looking"));
		// A step that comes while a line is being written replaces the one waiting; only the latest is described next.
		progress.step("c", message([{ id: "c1", name: "fetch_url" }]));
		progress.step("c", message([{ id: "c2", name: "fetch_url" }]));
		await waitFor("two lines", () => (shown.length === 2 ? true : undefined));
		expect(shown).toEqual([["Line 1", ["a", "b"]], ["Line 2", ["c2"]]]);
		expect(asked[0]).toContain("Their request: find me flights");
		expect(asked[0]).toContain("- fetch_url");
		expect(asked[1]).toContain("Previous line: Line 1");
		// Nothing for a final answer, for the headings the model wrote itself, or when there is no utility model.
		progress.step("c", message([{ id: "send", name: "send_to_user" }]));
		progress.step("c", message([{ id: "d", name: "fetch_url" }], "**Comparing prices**\nmore"));
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(shown).toHaveLength(2);
		const quiet = new Progress({ gapMs: 20, describe: async () => null, show: () => shown.push(["never", []]) });
		quiet.step("q", message([{ id: "e", name: "fetch_url" }]));
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(shown).toHaveLength(2);
	});
});

real("progress lines on the real stack", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let web: Client;
	let app: App;
	let utility: Server;
	let pulse: NatsPulse;
	let ownerId: string;
	const heard: Notice[] = [];
	const asked: string[] = [];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

	beforeAll(async () => {
		// The utility model: an OpenAI-compatible endpoint that answers each request with a line.
		utility = createServer(async (req, res) => {
			let raw = "";
			for await (const chunk of req) raw += chunk;
			asked.push(JSON.parse(raw).messages.at(-1).content);
			res.setHeader("content-type", "application/json").end(JSON.stringify({ choices: [{ message: { content: "Checking the page" } }] }));
		});
		await new Promise<void>((resolve) => utility.listen(0, "127.0.0.1", resolve));
		const gateway = `http://127.0.0.1:${(utility.address() as { port: number }).port}/v1`;
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate");
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		await stack.admin.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1, 'model_utility', $2)", [ownerId, JSON.stringify({ provider: "gateway", id: "u1" })]);
		pulse = await NatsPulse.connect(d.nats.url);
		pulse.subscribeNotices(ownerId, (notice) => heard.push(notice));
		runner = await start(
			d,
			"runner",
			{ pollMs: 40, providers: () => [faux.provider], fetch: (async () => new Response("a page", { headers: { "content-type": "text/plain" } })) as typeof fetch },
			{ PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), PIM_AI_GATEWAY_URL: gateway },
		);
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
		utility?.close();
	}, 60_000);

	it("tells the person's open apps, in a few words, what the agent is doing for the tool calls of its step", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Work" })).json.id as string;
		faux.setResponses([toolUse(fauxToolCall("fetch_url", { url: "http://93.184.216.34/page" })), toolUse(fauxToolCall("send_to_user", { message: "done" }))] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "p-1", text: "what is on that page?" })).status).toBe(202);
		const line = await waitFor("the progress notice", () => heard.find((notice) => notice.kind === "progress"), 60_000);
		expect(line.data).toMatchObject({ session: chat, text: "Checking the page", calls: [expect.any(String)] });
		// It is about the step's tool call, from the person's request.
		expect(asked[0]).toContain("Their request: what is on that page?");
		expect(asked[0]).toContain("fetch_url");
		const call = (line.data as { calls: string[] }).calls[0]!;
		// The model's request lists fetch_url among its tools before the call is written, so wait for the call itself.
		const done = await waitFor("the transcript", async () => {
			const rows = (await d.stack.admin.query("SELECT record FROM pim_runtime.entries WHERE owner_id = $1 AND record LIKE '%fetch_url%'", [ownerId])).rows;
			const records = rows.map((r) => r.record).join("\n");
			return records.includes(call) ? records : undefined;
		}, 60_000);
		expect(done).toContain(call);
	}, 120_000);
});
