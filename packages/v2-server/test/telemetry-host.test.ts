// The default agent host with tracing on, as a deployment runs it: a Runner given an OTLP endpoint reports pi's spans for a real chat turn, and the generations it sends are the ledger's
// rows, once each. Kept apart from agent-host.test.ts so that suite runs with tracing off, as most deployments do.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Process } from "../src/main.ts";
import { waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";

const real = describeWith(hasNats());
const KEK = { PIM_KEK_K1: randomBytes(32).toString("base64"), PIM_KEK_CURRENT: "k1" };

real("the default agent host with tracing on", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let collector: Server;
	let app: App;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	/** The generations the collector was sent, as `[session, output tokens]`. */
	const generations: { session: string; output: number }[] = [];

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		collector = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				for (const rs of JSON.parse(Buffer.concat(chunks).toString() || "{}").resourceSpans ?? []) for (const ss of rs.scopeSpans) for (const span of ss.spans) {
					const attrs = Object.fromEntries(span.attributes.map((a: { key: string; value: { stringValue?: string } }) => [a.key, a.value.stringValue]));
					if (attrs["langfuse.observation.type"] === "generation" && attrs["langfuse.observation.usage_details"]) generations.push({ session: attrs["langfuse.session.id"] ?? "", output: JSON.parse(attrs["langfuse.observation.usage_details"]).output });
				}
				res.writeHead(200).end("{}");
			});
		});
		await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
		gate = await start(d, "gate", {}, KEK);
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), PIM_FORGE_DATABASE_URL: stack.url("forge"), OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${(collector.address() as { port: number }).port}/api/public/otel`, ...KEK });
	}, 180_000);
	afterAll(async () => {
		collector?.close();
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("sends a chat's model requests to the collector, each as the ledger recorded it", async () => {
		const web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		expect((await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true })).status).toBe(201);
		const chat = (await web.call("POST", "/api/sessions", { title: "Traced" })).json.id as string;
		for (const [n, words] of ["hello", "again"].entries()) {
			faux.setResponses([fauxAssistantMessage([fauxToolCall("current_time", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxToolCall("send_to_user", { message: `done ${n}` })], { stopReason: "toolUse" })] as never);
			expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
			await waitFor(`turn ${n} in the ledger`, async () => ((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.model_calls WHERE public_chat_id = $1 AND run_kind = 'chat'", [chat])).rows[0].n >= (n + 1) * 2 ? true : undefined), 60_000);
		}
		const ledger = async () => Number((await d.stack.admin.query("SELECT coalesce(sum(output_tokens), 0) AS n FROM pim_app.model_calls WHERE public_chat_id = $1 AND run_kind = 'chat'", [chat])).rows[0].n);
		const sent = () => generations.filter((g) => g.session === chat).reduce((n, g) => n + g.output, 0);
		const expected = await ledger();
		expect(expected).toBeGreaterThan(0);
		await waitFor("the generations to reach the collector", async () => (sent() === expected ? true : undefined), 30_000);
		expect(generations.filter((g) => g.session === chat).length).toBe((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.model_calls WHERE public_chat_id = $1 AND run_kind = 'chat' AND output_tokens > 0", [chat])).rows[0].n);
	}, 120_000);
});
