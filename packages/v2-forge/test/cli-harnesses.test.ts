// The other two vendor CLIs through the same real runner: Codex (a subscription login, tokens but no dollars) and Mistral Vibe (an API key, a run's cost from its export.json).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codex } from "@pim/coding/harness/codex";
import { mistralVibe } from "@pim/coding/harness/vibe";
import { codexFixture, CODEX_SESSION } from "@pim/coding/support/codex";
import { fakeManager, TOKEN, URL_BASE } from "@pim/coding/support/fake-manager";
import { vibeExport, vibeOutput, VIBE_SESSION } from "@pim/coding/support/vibe";
import { ComposeWorkspaceProvider } from "@pim/coding/workspace/compose";
import { CliTurnPort } from "../src/cli-port";
import { ForgeVault, LocalEnvelopeCrypto } from "../src/vault";
import { Seeded } from "./seeded";
import { ada, startReq, stack } from "./stack";

describe("codex and mistral-vibe turns", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let agent: Seeded;
	let vault: ForgeVault;
	const argv: Record<string, string[][]> = { codex: [], vibe: [] };
	const env: Record<string, Record<string, string>[]> = { vibe: [] };

	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		const manager = fakeManager(5);
		manager.backing.register("codex", async (ctx) => {
			argv.codex!.push(ctx.argv);
			return { stdout: codexFixture("turn"), code: 0 };
		});
		// Vibe runs through `sh -c <script> vibe <dir> …`: the script's effect is the run's export.json in its output directory.
		const vibe = async (ctx: { argv: string[]; env: Record<string, string>; workspace: any }) => {
			if (!ctx.argv.includes("vibe")) return { stdout: "", code: 0 };
			argv.vibe!.push(ctx.argv);
			env.vibe!.push(ctx.env);
			const dir = ctx.argv[ctx.argv.indexOf("vibe") + 1]!;
			await ctx.workspace.writeFile(`${dir}/out/export.json`, new TextEncoder().encode(vibeExport("turn")));
			return { stdout: vibeOutput("turn"), code: 0 };
		};
		manager.backing.register("sh", vibe as never);
		manager.backing.register("/bin/sh", vibe as never);
		agent = new Seeded(new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: manager.fetch, sleep: async () => {} }));
		vault = new ForgeVault(s.db, new LocalEnvelopeCrypto({ keyId: "k", key: randomBytes(32) }));
	});
	afterAll(async () => s.close());

	const run = (cli: typeof codex | typeof mistralVibe) => s.worker({ compute: agent, turns: { [cli.id]: new CliTurnPort({ cli, compute: agent, store: s.store, scheduler: s.scheduler, vault }) } });

	it("codex: signs in from the vault, resumes its session, and reports tokens with no dollars", async () => {
		const { threadId } = await s.forge.start(ada, startReq("codex-1", { harness: "codex" }));
		const w = run(codex);
		// No login: the thread waits for the person.
		await w.step(threadId);
		expect(await s.store.get(threadId)).toMatchObject({ state: "waiting_input", stateReason: "login_required" });
		await vault.save("ada", "codex", [{ path: "auth.json", mode: 0o600, data: new TextEncoder().encode('{"tokens":{"access_token":"secret-codex"}}') }], 0);
		await s.forge.continueThread(ada, threadId, "codex-go");
		await w.step(threadId);
		const t = (await s.store.get(threadId))!;
		expect(t).toMatchObject({ state: "idle", spentUsd: 0 });
		expect(argv.codex!.at(-1)).toEqual(expect.arrayContaining(["codex", "exec"]));
		const call = (await s.store.events(threadId, { kind: "model_call" }))[0]!;
		expect(Number(call.tokens_in) + Number(call.tokens_out)).toBeGreaterThan(0);
		const sess = (await s.pool.query("select session_id from pim_forge.forge_harness_sessions where thread_id = $1", [threadId])).rows[0];
		expect(sess.session_id).toBe(CODEX_SESSION);
		const ws = await agent.workspace(t.workspaceRef);
		await expect(ws.readFile("/workspace/.codex/auth.json")).rejects.toThrow();
		await s.forge.steer(ada, threadId, "more", "codex-2");
		await w.step(threadId);
		expect(argv.codex!.at(-1)).toContain("resume");
		expect((await s.forge.transcript(ada, threadId)).events.some((e) => e.role === "assistant")).toBe(true);
	});

	it("mistral-vibe: runs on the person's API key, which never reaches the transcript, and charges the run's cost from export.json", async () => {
		const key = "mistral-key-0123456789abcdef";
		const { threadId } = await s.forge.start(ada, startReq("vibe-1", { harness: "mistral-vibe" }));
		const w = run(mistralVibe);
		await w.step(threadId);
		expect(await s.store.get(threadId)).toMatchObject({ state: "waiting_input", stateReason: "login_required" });
		await vault.saveApiKey("ada", "mistral-vibe", key);
		await s.forge.continueThread(ada, threadId, "vibe-go");
		await w.step(threadId);
		const t = (await s.store.get(threadId))!;
		expect(t.state).toBe("idle");
		expect(env.vibe!.at(-1)!.MISTRAL_API_KEY).toBe(key);
		const all = JSON.stringify([...(await s.store.events(threadId)), t]);
		expect(all).not.toContain(key);
		expect(t.spentUsd).toBeGreaterThan(0);
		expect((await s.pool.query("select session_id from pim_forge.forge_harness_sessions where thread_id = $1", [threadId])).rows[0].session_id).toBeTruthy();
		void VIBE_SESSION;
		// An API key harness takes no login lock and leaves nothing locked.
		expect(await s.scheduler.acquireLogin("ada", "mistral-vibe", "other")).toBe(true);
	});
});
