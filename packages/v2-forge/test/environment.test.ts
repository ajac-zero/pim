// A thread's environment through the sandbox manager's route contract (the fake manager): the person's setup script runs once and the sandbox is kept as their snapshot of the repository,
// their next thread starts from it without running the setup again, and a rebuild sets it up once more and replaces the snapshot.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeManager, TOKEN, URL_BASE } from "@pim/coding/support/fake-manager";
import { ComposeWorkspaceProvider } from "@pim/coding/workspace/compose";
import type { ComputeHandle, ComputeSpec } from "../src/compute";
import { ForgeError } from "../src/errors";
import { Seeded } from "./seeded";
import { ada, ScriptedPort, startReq, stack } from "./stack";

/** A sandbox with a git checkout in it, as a harness's own clone leaves one. */
class Cloned extends Seeded {
	override async create(tag: string, spec: ComputeSpec): Promise<ComputeHandle> {
		const h = await super.create(tag, spec);
		await (await this.workspace(h)).writeFile("/workspace/repo/.git/HEAD", new TextEncoder().encode("ref: refs/heads/main\n"));
		return h;
	}
}

describe("environment snapshots", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let agent: Cloned;
	let setups = 0;
	let clock = 0;
	const repo = { userId: "ada", repo: "acme/app" };

	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		const manager = fakeManager(10);
		manager.backing.register("bash", async ({ workspace }) => {
			setups++;
			await workspace.writeFile("/workspace/repo/setup-ran.txt", new TextEncoder().encode(`run ${setups}`));
			return { code: 0, stdout: "" };
		});
		manager.backing.register("test", async ({ workspace }) => ((await workspace.stat("/workspace/repo/.git").then(() => true, () => false)) ? { code: 0 } : { code: 1 }));
		agent = new Cloned(new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: manager.fetch, sleep: async () => {} }));
	});
	afterAll(async () => s.close());

	// Each reading of the clock is half a minute on: the setup takes long enough that its snapshot is worth keeping.
	const step = (threadId: string) => s.worker({ compute: agent, turns: { "claude-code": new ScriptedPort([{ outcome: "completed", text: "ok" }, { outcome: "completed", text: "ok" }]) }, repoDir: "/workspace/repo", prepareWorkspace: async () => {}, clock: () => (clock += 30_000) }).step(threadId);
	const environmentOf = async (id: string) => (await s.store.get(id))!.provisioning.environment;
	const fileOf = async (id: string) => new TextDecoder().decode(await (await agent.workspace((await s.store.get(id))!.workspaceRef)).readFile("/workspace/repo/setup-ran.txt"));

	it("keeps the sandbox of a first thread as the person's snapshot, and starts their next thread from it without running the setup again", async () => {
		await s.forge.repoSettings(ada, "acme/app", { setupScript: "pnpm install" });
		const first = await s.forge.start(ada, startReq("env-1", { harness: "claude-code" }));
		await step(first.threadId);
		expect(setups).toBe(1);
		expect(await environmentOf(first.threadId)).toMatchObject({ state: "cached", readyFrom: "setup", source: "settings", snapshotKept: true });
		expect(await agent.environments!.list(repo)).toHaveLength(1);

		const second = await s.forge.start(ada, startReq("env-2", { harness: "claude-code" }));
		const before = (await s.store.get(second.threadId))!.workspaceRef;
		await step(second.threadId);
		// The sandbox it works in was restored from the snapshot: the setup's own file is there and the script did not run again.
		expect(setups).toBe(1);
		expect(await environmentOf(second.threadId)).toMatchObject({ state: "cached", readyFrom: "snapshot", restoredFromKey: (await environmentOf(first.threadId)).key });
		expect(await fileOf(second.threadId)).toBe("run 1");
		expect(await s.store.get(second.threadId)).toMatchObject({ state: "idle" });
		expect(before).toBeNull();
		const events = (await s.pool.query("select kind from pim_forge.forge_events where thread_id = $1 and kind like 'environment.%' order by seq", [second.threadId])).rows.map((r) => r.kind);
		expect(events).toEqual(expect.arrayContaining(["environment.started", "environment.restored"]));
	});

	it("rebuilds an environment on request, between turns: the setup runs again in the thread's own sandbox and the snapshot is replaced", async () => {
		const { threadId } = (await s.pool.query("select thread_id as \"threadId\" from pim_forge.forge_threads where start_operation = 'env-1'")).rows[0];
		const key = (await environmentOf(threadId)).key;
		expect(await s.forge.rebuildEnvironment(ada, threadId)).toEqual({ queued: true });
		expect(await environmentOf(threadId)).toMatchObject({ state: "building", rebuildRequested: true });
		await step(threadId);
		expect(setups).toBe(2);
		expect(await environmentOf(threadId)).toMatchObject({ state: "cached", readyFrom: "setup", rebuildRequested: false, key });
		expect(await fileOf(threadId)).toBe("run 2");
		expect(await agent.environments!.list(repo)).toHaveLength(1);
		// A thread after it restores the rebuilt one.
		const third = await s.forge.start(ada, startReq("env-3", { harness: "claude-code" }));
		await step(third.threadId);
		expect(await fileOf(third.threadId)).toBe("run 2");
		expect(setups).toBe(2);
	});

	it("is another environment when the setup changes, and an Amp thread has none to rebuild", async () => {
		await s.forge.repoSettings(ada, "acme/app", { setupScript: "pnpm install --frozen-lockfile" });
		const next = await s.forge.start(ada, startReq("env-4", { harness: "claude-code" }));
		await step(next.threadId);
		expect(setups).toBe(3);
		expect(await agent.environments!.list(repo)).toHaveLength(2);
		const amp = await s.forge.start(ada, startReq("env-amp", { harness: "amp" }));
		await expect(s.forge.rebuildEnvironment(ada, amp.threadId)).rejects.toBeInstanceOf(ForgeError);
	});
});
