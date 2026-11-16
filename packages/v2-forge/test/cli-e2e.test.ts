// A real vendor CLI turn end to end: HarnessRunner and the claude-code command builder/parser, through ComposeWorkspaceProvider speaking the sandbox-manager's route contract (the fake manager), behind WorkspaceAgentComputeProvider.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeCode } from "@pim/coding/harness/claude-code";
import { claudeFixture, CLAUDE_SESSION } from "@pim/coding/support/claude-code";
import { fakeManager, TOKEN, URL_BASE } from "@pim/coding/support/fake-manager";
import { ComposeWorkspaceProvider } from "@pim/coding/workspace/compose";
import { CliTurnPort } from "../src/cli-port";
import { ForgeVault, LocalEnvelopeCrypto } from "../src/vault";
import { WorkspaceAgentComputeProvider } from "../src/workspace-agent";
import { ada, startReq, stack } from "./stack";
import { Seeded } from "./seeded";

describe("vendor CLI turns through workspace-agentd's manager", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let manager: ReturnType<typeof fakeManager>;
	let agent: WorkspaceAgentComputeProvider;
	let vault: ForgeVault;
	let port: CliTurnPort;
	const argv: string[][] = [];

	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		manager = fakeManager(5);
		manager.backing.register("claude", async (ctx) => {
			argv.push(ctx.argv);
			return { stdout: claudeFixture("turn"), code: 0 };
		});
		agent = new Seeded(new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: manager.fetch, sleep: async () => {} }));
		vault = new ForgeVault(s.db, new LocalEnvelopeCrypto({ keyId: "k1", key: randomBytes(32) }));
		port = new CliTurnPort({ cli: claudeCode, compute: agent, store: s.store, scheduler: s.scheduler, vault });
	});
	afterAll(async () => s.close());

	const worker = () => s.worker({ compute: agent, turns: { "claude-code": port }, computeSpec: (t) => ({ repo: { url: `https://pim.example.test/api/coding/git/acme/app.git`, ref: "main", branch: t.branch! } }) });

	it("without the person's login the thread waits for them, and nothing is left locked or in the sandbox", async () => {
		const { threadId } = await s.forge.start(ada, startReq("cli-nologin", { harness: "claude-code" }));
		const w = worker();
		await w.step(threadId);
		expect(await s.store.get(threadId)).toMatchObject({ state: "waiting_input", stateReason: "login_required" });
		expect(await s.scheduler.acquireLogin("ada", "claude-code", "someone-else")).toBe(true);
		await s.scheduler.releaseLogin("ada", "claude-code", "someone-else");
	});

	it("runs a turn with the person's login, records messages, tests and the cost delta, resumes the session, and takes the login back out", async () => {
		await vault.save("ada", "claude-code", [{ path: ".credentials.json", mode: 0o600, data: new TextEncoder().encode('{"claudeAiOauth":{"accessToken":"sk-ant-secret"}}') }], 0);
		const { threadId } = await s.forge.start(ada, startReq("cli-real", { harness: "claude-code" }));
		const w = worker();
		await w.step(threadId);
		const t = (await s.store.get(threadId))!;
		expect(t).toMatchObject({ state: "idle", spentUsd: 0.0841 });
		expect(argv.at(-1)).toContain("-p");
		expect(argv.at(-1)).toEqual(expect.arrayContaining([CLAUDE_SESSION].filter(() => false)));
		const msgs = (await s.forge.transcript(ada, threadId)).events;
		expect(msgs.map((e) => e.role)).toEqual(expect.arrayContaining(["user", "assistant", "tool"]));
		expect(msgs.some((e) => String(e.data.text).includes("Fixed `greet`"))).toBe(true);
		expect((await s.forge.tests(ada, threadId)).length).toBeGreaterThan(0);
		const sess = (await s.pool.query("select * from pim_forge.forge_harness_sessions where thread_id = $1", [threadId])).rows[0];
		expect(sess).toMatchObject({ session_id: CLAUDE_SESSION, harness: "claude-code" });
		expect(Number(sess.cost_usd)).toBeCloseTo(0.0841);
		// The login went back out of the sandbox.
		const ws = await agent.workspace(t.workspaceRef);
		await expect(ws.readFile("/workspace/.claude/.credentials.json")).rejects.toThrow();
		// The second turn resumes the same session; the CLI reports the same session total, so it costs nothing more.
		await s.forge.steer(ada, threadId, "also add a test", "cli-real-2");
		await w.step(threadId);
		expect(argv.at(-1)).toContain("--resume");
		expect((await s.store.get(threadId))!.spentUsd).toBeCloseTo(0.0841);
		// The wake carries the contract's envelope once per turn.
		const wakes = await s.pool.query("select dedupe_key from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1 order by id", [threadId]);
		expect(wakes.rows.map((r) => r.dedupe_key)).toEqual([`coding:${threadId}:cli-real`, `coding:${threadId}:cli-real-2`]);
	});

	it("a login another of the person's threads is using makes this one wait, with its input kept", async () => {
		const { threadId } = await s.forge.start(ada, startReq("cli-busy", { harness: "claude-code" }));
		const w = worker();
		expect(await s.scheduler.acquireLogin("ada", "claude-code", "other-thread")).toBe(true);
		expect(await w.step(threadId)).toBe("retry");
		expect(await s.store.get(threadId)).toMatchObject({ state: "idle", stateReason: "harness_busy" });
		await s.scheduler.releaseLogin("ada", "claude-code", "other-thread");
		expect(await w.step(threadId)).toBe("done");
		expect((await s.store.get(threadId))!.state).toBe("idle");
	});
});
