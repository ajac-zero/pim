// The admin's majordomo on host operations, end to end: a Gate and a Runner (separate process roles) over a real PostgreSQL and NATS, the real `sandbox-manager/hostopsd` daemon dialling out to the
// Gate with its own credential, and the model scripted. A command waits in Approvals and runs on the host only after the person approves exactly it, as the daemon's unprivileged user; a declined one
// never reaches the queue; another agent of the admin is refused and the refusal is kept; and a member's partition is not offered the tools at all.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const HOSTOPSD = fileURLToPath(new URL("../../../sandbox-manager/hostopsd/hostopsd.js", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../../..", import.meta.url));

real("host operations through the admin's majordomo", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let web: Client;
	let bobWeb: Client;
	let app: App;
	let chatId: string;
	let bobChat: string;
	let ownerId: string;
	let n = 0;
	let daemon: ChildProcess | undefined;
	let home: string;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	const transcriptOf = async (chat: string, owner: string) => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0];
		// A chat of its own family (partition) is numbered from the Runner's block of ids, not the application's sequence: the family has the one conversation.
		const inside = (await d.stack.admin.query("SELECT min(conversation_id) AS id FROM pim_runtime.entries WHERE owner_id = $1 AND partition_id = $2", [owner, c.partition_id])).rows[0]?.id;
		return JSON.stringify(await readTranscript(d.stack.runtime, owner, c.partition_id, Number(inside ?? c.conversation_id)));
	};
	const resultsOf = async (chat: string, owner: string, tool: string) =>
		(JSON.parse(await transcriptOf(chat, owner)) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === tool).map((m) => m.content.map((c) => c.text ?? "").join("")));
	const ask = async (client: Client, chat: string, owner: string, words: string, ...script: unknown[]) => {
		faux.setResponses([...script, toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` })), fauxAssistantMessage(`ended ${n}`)] as never);
		expect((await client.call("POST", `/api/sessions/${chat}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		const mine = n;
		return () => waitFor(`the turn "${words}" to end`, async () => ((await transcriptOf(chat, owner)).includes(`ended ${mine}`) ? true : undefined), 60_000);
	};
	const waiting = () => waitFor("the approval to be filed", async () => (await d.stack.admin.query("SELECT id, tool, args FROM pim_app.approvals WHERE state = 'waiting' ORDER BY created_at LIMIT 1")).rows[0], 60_000);
	const audit = async () => (await web.call("GET", "/api/hostops/audit?limit=200")).json.audit as { action: string; outcome: string; actorKind: string; args: any }[];

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "hostopsd-home-"));
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate");
		web = new Client(base(gate), d.ingressSecret);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000), session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		chatId = (await web.call("POST", "/api/sessions", { title: "Host" })).json.id;
		await web.call("POST", "/api/admin/registration", { open: true });
		bobWeb = new Client(base(gate), d.ingressSecret);
		const bob = await bobWeb.call("POST", "/auth/register", { username: "bob", session: true });
		expect(bob.status).toBe(201);
		bobChat = (await bobWeb.call("POST", "/api/sessions", { title: "Mine" })).json.id;
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate") });
		// The daemon, the real one, as an unprivileged process beside the stack with only its own credential.
		const credential = (await web.call("POST", "/api/hostops/credential")).json.token as string;
		writeFileSync(join(home, "env"), "");
		daemon = spawn(process.execPath, [HOSTOPSD], {
			stdio: "ignore",
			env: { PATH: process.env.PATH ?? "", HOME: home, HOSTOPSD_ENV_FILE: join(home, "env"), HOSTOPS_URL: base(gate), HOSTOPS_TOKEN: credential, PIM_CHECKOUT: CHECKOUT, HOSTOPSD_STACK: "compose", PIM_COMPOSE_DIR: home, HOSTOPSD_STATE_FILE: join(home, "state.json") },
		});
	}, 180_000);
	afterAll(async () => {
		daemon?.kill("SIGKILL");
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
		if (home) rmSync(home, { recursive: true, force: true });
	}, 60_000);

	it("runs a command on the host only after the person approves exactly it, and keeps it in the audit log", async () => {
		const end = await ask(web, chatId, ownerId, "check the disk", toolUse(fauxToolCall("hostops_exec", { command: "echo from-the-host; id -un" })), toolUse(fauxToolCall("send_to_user", { message: "Done." })));
		const approval = await waiting();
		expect(approval.tool).toBe("hostops_exec");
		expect(approval.args).toMatchObject({ op: "exec", args: { command: "echo from-the-host; id -un", timeoutSeconds: 60 }, summary: expect.stringContaining("echo from-the-host") });
		// Nothing was queued before the decision.
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.hostops_ops")).rows[0].n).toBe(0);
		expect((await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: true })).status).toBe(200);
		await end();
		const result = (await resultsOf(chatId, ownerId, "hostops_exec"))[0]!;
		expect(result).toMatch(/\(exec\): succeeded/);
		expect(result).toContain("from-the-host");
		// As the daemon's own unprivileged user.
		expect(result).toContain(userInfo().username);
		const op = (await d.stack.admin.query("SELECT state, approval_id, caller_agent_id FROM pim_app.hostops_ops")).rows;
		expect(op).toEqual([{ state: "succeeded", approval_id: approval.id, caller_agent_id: "pim" }]);
		const rows = await audit();
		expect(rows.map((r) => `${r.action}:${r.outcome}`)).toEqual(expect.arrayContaining(["enqueue:queued", "claim:running", "result:succeeded"]));
		expect(rows.find((r) => r.action === "result")!.args).toMatchObject({ command: "echo from-the-host; id -un", exitCode: 0 });
		expect((await web.call("GET", "/api/hostops/status")).json).toMatchObject({ credential: { present: true }, agent: { version: expect.any(String) } });
	}, 180_000);

	it("queues nothing when the person declines, and refuses an agent that is not the majordomo", async () => {
		const queued = async () => (await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.hostops_ops")).rows[0].n as number;
		const before = await queued();
		const end = await ask(web, chatId, ownerId, "restart the gate", toolUse(fauxToolCall("hostops_restart", { service: "gate" })), toolUse(fauxToolCall("send_to_user", { message: "Ok." })));
		const approval = await waiting();
		expect(approval.args.summary).toBe("Restart gate on this machine");
		expect((await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: false })).status).toBe(200);
		await end();
		expect((await resultsOf(chatId, ownerId, "hostops_restart"))[0]).toMatch(/did not approve/);
		expect(await queued()).toBe(before);

		// Another agent of the admin's has the tools in its partition, but the service refuses it, before anyone is asked, and keeps the refusal.
		const agent = (await web.call("POST", "/api/agents", { name: "Helper", instructions: "" })).json;
		const other = (await web.call("POST", "/api/sessions", { title: "Other", agentId: agent.id })).json.id;
		const end2 = await ask(web, other, ownerId, "look at the host", toolUse(fauxToolCall("hostops_stats", {})), toolUse(fauxToolCall("send_to_user", { message: "Ok." })));
		await end2();
		expect((await resultsOf(other, ownerId, "hostops_stats"))[0]).toMatch(/Only the admin's majordomo/);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.approvals WHERE state = 'waiting'")).rows[0].n).toBe(0);
		expect((await audit()).some((r) => r.action === "request" && r.outcome === "rejected" && r.actorKind === "agent")).toBe(true);
	}, 180_000);

	it("does not offer a member's agents the tools at all", async () => {
		const bobId = (await d.stack.admin.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'bob'")).rows[0].owner_id as string;
		await ask(bobWeb, bobChat, bobId, "stats please", toolUse(fauxToolCall("hostops_stats", {})));
		// The harness answers a call to a tool that is not registered; nothing reaches the host service or Approvals.
		const result = await waitFor("the harness to answer", async () => (await resultsOf(bobChat, bobId, "hostops_stats"))[0], 60_000);
		expect(result).toMatch(/Tool hostops_stats is not available/);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.approvals WHERE owner_id = $1", [bobId])).rows[0].n).toBe(0);
	}, 180_000);
});
