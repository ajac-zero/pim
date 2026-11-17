// The whole product's path, through the processes a deployment runs and nothing faked but the model and the network edge: a person registers with a
// passkey, opens a live socket, sends a message to the Gate (202), a Runner takes the chat and streams a turn whose tool call parks for approval,
// that Runner drains mid-turn and another takes over under a newer epoch, the person approves, and the turn finishes; Live, the HTTP snapshot and the shared-chat
// page all show the same transcript. Then a coding thread under an explicit grant and a standing approval wakes the chat and lands its spend in the cost ledger.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, type HarnessOptions } from "@earendil-works/pi-durable";
import { LiveClient, type LiveSocket, type LiveUpdate, SnapshotRefused } from "@pim/shared/live-client";
import { projectEntries } from "@pim/shared/transcript";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { userHandle } from "@pim/v2-app/signin";
import { Authz } from "@pim/v2-forge/authz";
import type { Db as ForgeDb } from "@pim/v2-forge/db";
import { ForgeScheduler } from "@pim/v2-forge/scheduler";
import { ForgeStore } from "@pim/v2-forge/store";
import type { Process } from "../src/main.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Authenticator } from "./support/authenticator.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const REPO = "https://github.com/acme/app";

real("the vertical slice", () => {
	let d: Deployment;
	let gate: Process;
	let live: Process;
	let maintenance: Process;
	let runnerA: Process;
	let runnerB: Process;
	let web: Client;
	let ownerId: string;
	let chatId: string;
	let live_: LiveClient;
	const updates: LiveUpdate[] = [];
	const toolRuns: string[] = [];
	const everyone: Process[] = [];

	// The model, shared by both Runners (the processes are in this one test process) so a script of answers survives the hand-off.
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }], tokensPerSecond: 8, tokenSize: { min: 2, max: 3 } });
	let appForTools: App;
	const hooks = () => {
		const models = createModels();
		models.setProvider(faux.provider);
		const approve = defineTool({
			name: "approve_me",
			description: "Does something that needs a person's yes",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async (_args, api) => {
				const { rows } = await d.stack.admin.query("SELECT 1 FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2", [ownerId, api.taskId]);
				if (rows.length > 0) {
					toolRuns.push("approved");
					return { content: [{ type: "text", text: "done with approval" }] };
				}
				// The tool files the approval the person will see, once per task, naming the task so the decision can wake it.
				await appForTools.db.owner(ownerId, (tx) =>
					tx.query("INSERT INTO pim_app.approvals (id, owner_id, public_chat_id, tool, args) VALUES ($1, $2, $3, 'approve_me', $4) ON CONFLICT DO NOTHING", [`ap_task_${api.taskId}`, ownerId, chatId, JSON.stringify({ taskId: api.taskId })]),
				);
				return { control: { suspend: true } };
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "approve", tools: [approve] }));
		const agent = { model: { provider: "faux", modelId: "m" } };
		return {
			harnessOptions: (): HarnessOptions => ({ models, registry, settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1_000 }, progress: { partialIntervalMs: 60, outputIntervalMs: 100 } } as never }),
			homeRoot: () => ({ agent }),
			chatAgent: () => agent,
			pollMs: 40,
		};
	};
	const go = async (...args: Parameters<typeof start>) => {
		const p = await start(...args);
		everyone.push(p);
		return p;
	};

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		appForTools = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		const gateEnv = { PIM_CODING_ALLOWED_REPOS: "acme/*" };
		gate = await go(d, "gate", {}, gateEnv);
		live = await go(d, "live", { pollMs: 40 });
		maintenance = await go(d, "maintenance", { pollMs: 100 });
		runnerA = await go(d, "runner", hooks(), { PIM_RUNNER_HOLDER_ID: "runner-a" });
		web = new Client(base(gate), d.ingressSecret);
	}, 180_000);
	afterAll(async () => {
		live_?.stop();
		await Promise.allSettled(everyone.map((p) => p.close()));
		await appForTools?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	const rp = () => new URL(base(gate)).hostname;
	const messages = (topic: string) =>
		updates
			.filter((u) => u.topic === topic)
			.flatMap((u) => (u.kind === "batch" ? (u.data as { events: { kind: string; data: unknown }[] }).events : [{ kind: u.kind, data: u.data }]))
			.filter((e) => e.kind === "message" || e.kind === "message.partial" || e.kind === "progress")
			.map((e) => e.data as { message: { id: string; role: string; parts: { type: string; text?: string }[] }; partial: boolean });
	const textOf = (m: { parts: { type: string; text?: string }[] }) => m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
	const snapshot = async () => (await web.call("GET", `/api/snapshot/chat/${chatId}`)).json as { messages: { id: string; role: string; partial: boolean; parts: { type: string; text?: string }[] }[]; liveCursor: string | null };

	it("registers the first admin with a passkey and signs in with it", async () => {
		const claim = await appForTools.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		const key = new Authenticator("ES256");
		const options = await web.call("POST", "/auth/passkeys/options", {});
		expect(options.status).toBe(200);
		expect((await web.call("POST", "/auth/passkeys", { ...key.create(options.json, base(gate)), name: "laptop" })).status).toBeLessThan(300);
		await web.call("POST", "/auth/sign-out");
		expect(((await web.call("GET", "/auth/session")).json as { signedIn: boolean }).signedIn).toBe(false);
		const challenge = await web.call("POST", "/auth/sign-in/options");
		expect((await web.call("POST", "/auth/sign-in", key.get(challenge.json, base(gate), userHandle(ownerId)))).status).toBe(200);
		const session = await web.call("GET", "/auth/session");
		expect(session.json).toMatchObject({ signedIn: true, account: { ownerId, role: "admin" } });
		expect(rp()).toBe("127.0.0.1");
	});

	it("admits a message at once, and a Runner turns it into a chat", async () => {
		chatId = (await web.call("POST", "/api/sessions", { title: "First" })).json.id;
		live_ = new LiveClient({
			openSocket: () => new WebSocket(`ws://127.0.0.1:${live.host.port}/api/ws`, { headers: { cookie: web.cookie, "x-pim-ingress-secret": d.ingressSecret } }) as unknown as LiveSocket,
			loadSnapshot: async (topic) => {
				const [kind, id] = topic.split(":");
				const r = await web.call("GET", `/api/snapshot/${kind}${id ? `/${id}` : ""}`);
				if (r.status !== 200) throw new SnapshotRefused(r.status);
				return { liveCursor: r.json.liveCursor };
			},
			onUpdate: (u) => updates.push(u),
			onUnauthorized: () => {},
		});
		live_.follow([`chat:${chatId}`, "sidebar"]);
		await waitFor("the live socket", () => (live_.status === "live" ? true : undefined));
		faux.setResponses([fauxAssistantMessage("Hello, Anibal.")]);
		const t0 = Date.now();
		const admitted = await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: "m-1", text: "hi" });
		expect(admitted.status).toBe(202);
		expect(Date.now() - t0).toBeLessThan(2_000);
		expect(admitted.json).toMatchObject({ state: "inbox_accepted", duplicate: false });
		// The same command again is the same command.
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: "m-1", text: "hi" })).json).toMatchObject({ duplicate: true });
		await waitFor("the answer on the client", () => (messages(`chat:${chatId}`).some((m) => !m.partial && m.message.role === "assistant" && textOf(m.message).includes("Hello, Anibal")) ? true : undefined), 30_000);
		await waitFor("the ledger to say the runtime has it", async () => ((await web.call("GET", `/api/sessions/${chatId}/pending`)).json.commands[0]?.runtimeCommitted ? true : undefined));
	}, 90_000);

	it("streams a turn whose tool parks for approval, survives its Runner draining mid-turn, and finishes after the person approves", async () => {
		updates.length = 0;
		const lead = "Let me do that for you, it needs your approval before I go on, so I will ask.";
		const slow = () => fauxAssistantMessage([{ type: "text", text: lead }, fauxToolCall("approve_me", {})], { stopReason: "toolUse" });
		faux.setResponses([slow(), slow(), fauxAssistantMessage("All done, with your approval.")]);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: "m-2", text: "please do the thing" })).status).toBe(202);
		await waitFor("a streamed partial", () => (messages(`chat:${chatId}`).some((m) => m.partial) ? true : undefined), 30_000);
		const first = (await d.stack.admin.query("SELECT holder_id, epoch FROM pim_runtime.partitions WHERE owner_id = $1 AND kind = 'family'", [ownerId])).rows[0];
		expect(first.holder_id).toBe("runner-a");

		// A second Runner comes up; the first drains while the answer is still streaming, and the chat's partition changes hands under a newer epoch.
		runnerB = await go(d, "runner", hooks(), { PIM_RUNNER_HOLDER_ID: "runner-b" });
		expect((await fetch(`${base(runnerA)}/drain`, { method: "POST" })).status).toBe(202);
		const second = await waitFor("runner B to hold the partition", async () => {
			if (process.env.DEBUG_SLICE) console.log("PART", JSON.stringify((await d.stack.admin.query("SELECT p.holder_id, p.epoch, p.lease_expires_at, d.state, d.reason FROM pim_runtime.partitions p LEFT JOIN pim_runtime.due_work d USING (owner_id, partition_id) WHERE p.owner_id = $1 AND p.kind = 'family'", [ownerId])).rows));
			const row = (await d.stack.admin.query("SELECT holder_id, epoch FROM pim_runtime.partitions WHERE owner_id = $1 AND kind = 'family'", [ownerId])).rows[0];
			return row.holder_id === "runner-b" ? row : undefined;
		}, 30_000);
		expect(BigInt(second.epoch)).toBeGreaterThan(BigInt(first.epoch));

		// The tool on the new Runner filed an approval; the person decides over the Gate; the decision wakes the parked task through the runtime.
		const approvalId = await waitFor("the approval to be filed", async () => (await web.call("GET", `/api/sessions/${chatId}/pending`)).json && (await d.stack.admin.query("SELECT id FROM pim_app.approvals WHERE state = 'waiting'")).rows[0]?.id, 60_000);
		expect((await web.call("POST", `/api/approvals/${approvalId}/decision`, { approve: true })).status).toBe(200);
		await waitFor("the final answer on the client", () => (messages(`chat:${chatId}`).some((m) => !m.partial && textOf(m.message).includes("All done, with your approval")) ? true : undefined), 60_000);
		expect(toolRuns).toEqual(["approved"]);

		const seen = messages(`chat:${chatId}`);
		const growing = seen.filter((m) => m.partial).map((m) => textOf(m.message)).filter((t) => t.length > 0 && lead.startsWith(t)).map((t) => t.length);
		expect(new Set(growing).size).toBeGreaterThan(1);
		// The drained Runner's cut-off answer stays in the transcript as an aborted message (pi records an abort), and the next Runner's turn follows it.
		const settled = seen.filter((m) => !m.partial);
		expect(settled.map((m) => m.message.role)).toEqual(["user", "assistant", "assistant", "tool", "assistant"]);
		expect((settled[1]!.message as { stopReason?: string }).stopReason).toBe("aborted");
	}, 180_000);

	it("shows one transcript everywhere: the live socket, the HTTP snapshot, the runtime's own entries, and the shared-chat page", async () => {
		await waitFor("the projector to catch up", async () => ((await snapshot()).messages.some((m) => !m.partial && textOf(m).includes("All done")) ? true : undefined));
		const snap = await snapshot();
		expect(snap.messages.some((m) => m.partial)).toBe(false);
		const partition = (await d.stack.admin.query("SELECT partition_id FROM pim_runtime.conversation_partitions WHERE owner_id = $1 AND public_chat_id = $2", [ownerId, chatId])).rows[0].partition_id;
		const conversation = Number((await d.stack.admin.query("SELECT conversation_id FROM pim_runtime.conversation_partitions WHERE owner_id = $1 AND public_chat_id = $2", [ownerId, chatId])).rows[0].conversation_id);
		const committed = projectEntries(await readTranscript(d.stack.runtime, ownerId, partition, conversation));
		expect(snap.messages.map((m) => m.id)).toEqual(committed.map((m) => m.id));
		expect(snap.messages.map((m) => textOf(m))).toEqual(committed.map((m) => textOf(m as never)));
		// What the live socket delivered for each committed message is what the snapshot holds.
		const live = messages(`chat:${chatId}`).filter((m) => !m.partial).map((m) => m.message.id);
		for (const id of live) expect(snap.messages.map((m) => m.id)).toContain(id);
		// The shared-chat page, read by someone with no session, is the same transcript.
		const link = (await web.call("PUT", `/api/sessions/${chatId}/link`)).json.link;
		const anonymous = new Client(base(gate), d.ingressSecret);
		const shared = await anonymous.call("GET", `/api/shared/${ownerId}/${link}`);
		expect(shared.status).toBe(200);
		expect(shared.json.messages.map((m: { id: string }) => m.id)).toEqual(snap.messages.map((m) => m.id));
		expect(shared.json.messages.map((m: { parts: { type: string; text?: string }[] }) => textOf(m))).toEqual(snap.messages.map((m) => textOf(m)));
	}, 60_000);

	it("runs a coding thread under an explicit grant and a standing approval, wakes the chat that started it, and records its spend", async () => {
		const forgeDb = d.stack.admin as unknown as ForgeDb;
		const authz = new Authz(forgeDb, { allowedRepos: ["acme/*"], branchPrefix: "pim/" });
		const actor = { ownerId, role: "admin" as const };
		// A person's harness logins are on the Gate too, sealed under the deployment's keys: none connected yet, and no key material in the answer.
		const vault = await web.call("GET", "/api/coding/vault");
		expect(vault.status).toBe(200);
		expect(vault.json.supported).toEqual(expect.arrayContaining(["claude-code", "codex"]));
		expect(JSON.stringify(vault.json)).not.toMatch(/sealed|secret/i);
		// Without a grant, coding is refused.
		expect((await web.call("POST", "/api/coding/threads", { operationId: "op-0", task: "Nothing", repo: REPO, chat: chatId })).status).toBe(403);
		// The admin grants through the Gate; Forge enforces the same grant. With one but no compute pool configured, it is unavailable (not forbidden): the deployment has nothing to run it on.
		const granted = await web.call("POST", "/api/admin/coding-grants", { ownerId, permissions: ["coding:start", "coding:merge"], repositories: ["github.com/acme/*"] });
		expect(granted.status).toBe(201);
		expect((await web.call("POST", "/api/coding/threads", { operationId: "op-0", task: "Nothing", repo: REPO, chat: chatId })).status).toBe(503);
		await new ForgeScheduler(forgeDb, new ForgeStore(forgeDb), Date.now).upsertPool({ poolId: "default", provider: "local", size: 10 });
		// Merge is permitted but needs a person; a standing approval, recorded by the admin and auditable, stands in for them.
		expect((await authz.check(actor, "coding:merge", { repo: REPO })).requiresApproval).toBe(true);
		const standing = await web.call("POST", "/api/admin/standing-approvals", { ownerId, action: "coding:merge", scope: { repository: "github.com/acme/app" } });
		expect(standing.status).toBe(201);
		expect((await authz.check(actor, "coding:merge", { repo: REPO })).viaStandingApproval).toBe(standing.json.approvalId);
		expect((await web.call("DELETE", `/api/admin/standing-approvals/${ownerId}/${standing.json.approvalId}`)).status).toBe(200);
		expect((await authz.check(actor, "coding:merge", { repo: REPO })).requiresApproval).toBe(true);

		const started = await web.call("POST", "/api/coding/threads", { operationId: "op-1", task: "Fix the flaky login test", repo: REPO, chat: chatId });
		expect(started.status).toBe(201);
		const threadId = started.json.threadId as string;
		// The worker's part, as it would write it: the thread's work, its spend, and the wake that ends the turn.
		const store = new ForgeStore(forgeDb);
		await store.locked(threadId, async (q) => {
			await store.setState(q, threadId, "running");
			await store.appendEvent(q, threadId, { kind: "message", role: "assistant", data: { text: "Fixed the test." }, costUsd: 0.75, tokensIn: 1200, tokensOut: 300 });
			await store.emitCompletionWake(q, { threadId, chatId }, "op-1", "completed", "Opened a pull request.");
		});
		faux.setResponses([fauxAssistantMessage("The coding thread finished.")]);
		await waitFor("the chat to hear the wake and answer", async () => ((await snapshot()).messages.some((m) => textOf(m).includes("The coding thread finished.")) ? true : undefined), 60_000);
		const heard = (await snapshot()).messages.filter((m) => m.role === "user").map((m) => textOf(m));
		expect(heard).toContain(`Coding thread ${threadId} completed. Opened a pull request.`);
		// Its spend is in the cost ledger as a coding thread's, and the sidebar knows the thread.
		const costs = await waitFor("the spend in the ledger", async () => {
			const c = (await web.call("GET", "/api/usage/costs?days=1")).json;
			return c.byDay?.some((d: { byRunKind: { key: string }[] }) => d.byRunKind.some((r) => r.key === "coding_thread")) ? c : undefined;
		}, 30_000);
		// The usage screen's report: dollars per day by kind of run.
		expect(costs.byDay.flatMap((d: { byRunKind: { key: string; costUsd: number }[] }) => d.byRunKind).find((r: { key: string }) => r.key === "coding_thread")).toMatchObject({ costUsd: 0.75 });
		const sidebar = (await web.call("GET", "/api/snapshot/sidebar")).json as { coding: { threadId: string; state: string }[] };
		expect(sidebar.coding.map((t) => t.threadId)).toContain(threadId);
	}, 120_000);
});
