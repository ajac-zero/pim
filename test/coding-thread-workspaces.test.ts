import { injectedHeaders } from "../src/coding/workspace/egress";
import { handleGitBroker } from "../src/coding/git-broker/routes";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { verifyBrokerToken } from "../src/coding/git-broker/broker";
import { brokerTokenKey } from "../src/coding/git-broker/routes";
import { codingScheduler } from "../src/coding/scheduler-do";
import { type EnvironmentKeyInput, environmentKey, estimatedRestoreMs, lockfileHashes, SETUP_ENV, snapshotWorthKeeping } from "../src/coding/environment-cache";
import { PROVISION_ENV } from "../src/coding/repo-environment";
import { cliInstructions, codingThread, SESSION_RESUME_TEXT } from "../src/coding/thread-do";
import { REPO_DIR } from "../src/coding/tools";
import { ComposeWorkspaceProvider } from "../src/coding/workspace/compose";
import { type FakeCommandHandler, FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { DEFAULT_WORKSPACE_IMAGE, workspaceRegistry } from "../src/coding/workspace/registry";
import type { WorkspaceSpec } from "../src/coding/workspace/types";
import { fakeClones, fakeGit, fakeRemotes } from "./fake-git";
import { fakeManager, json, TOKEN, URL_BASE } from "./fake-manager";
import { fakeContainers } from "./fake-container";
import { prepareComputeProvider } from "../src/compute";
import { GO_REPO, installed, MISE_REPO } from "./fixtures/repos";
import { api, toolUse } from "./helpers";
import { type CodingThreadDO, codingBackends, codingCompute, codingContainers, codingFaux, codingGitHub, codingQuota, codingSchedulers, codingThreadClock, codingWorkspaces } from "./worker";
import { BROKER_URL, type Stub, startInput, startThread, turns, inside, everything, workspaceOf, fileIn, sql, sent , capped } from "./coding-thread-support";

describe("a coding thread on a provider with sessions, keepalives and egress injection", () => {
	const heartbeat = (stub: Stub) => inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));

	/** A file of the thread's repository in its workspace on `provider`. */
	const fileOn = async (provider: FakeWorkspaceProvider, id: string, path: string) => new TextDecoder().decode(await (await provider.get((await provider.list({ sessionId: id }))[0]!.ref))!.readFile(`${REPO_DIR}/${path}`));

	const running = (stub: Stub, tools: number) => vi.waitFor(async () => expect(await sql(stub, "SELECT tool FROM coding_tool_journal")).toHaveLength(tools), { timeout: 15_000, interval: 50 });

	it("pings a provider that needs keepalives while a turn runs, at its interval, and wakes the heartbeat in time", async () => {
		const { provider, t0 } = capped({ sessionMaxMin: undefined });
		codingFaux.setResponses([toolUse("bash", { command: "sleep 30" })]);
		const { id, stub } = await startThread();
		await running(stub, 1);
		const pings = () => provider.keepAlives.get(id)?.length ?? 0;
		const first = await heartbeat(stub);
		expect(pings()).toBe(1);
		// The next ping is due in a minute, so the heartbeat comes back within its usual 30 seconds.
		expect((first as { rescheduleAt: number }).rescheduleAt).toBeLessThanOrEqual(Date.now() + 30_000);
		await heartbeat(stub);
		expect(pings()).toBe(1);
		codingThreadClock.now = t0 + 61_000;
		await heartbeat(stub);
		expect(provider.keepAlives.get(id)).toEqual([t0, t0 + 61_000]);
		await stub.abort();
		await turns(id, 1);
		// Between turns nothing is pinged.
		codingThreadClock.now = t0 + 200_000;
		await heartbeat(stub);
		expect(pings()).toBe(2);
		expect((await stub.status()).session).toMatchObject({ keepAlive: true, maxMin: null, expiresAt: null });
	});

	it("does not ping a provider that doesn't need it", async () => {
		const { provider } = capped({ sessionMaxMin: undefined, keepAlive: false });
		codingFaux.setResponses([toolUse("bash", { command: "sleep 30" })]);
		const { id, stub } = await startThread();
		await running(stub, 1);
		await heartbeat(stub);
		expect(provider.keepAlives.get(id)).toBeUndefined();
		await stub.abort();
		await turns(id, 1);
	});

	it("moves a running turn to a new session before the provider's cap, keeping its files, and says so in its status", async () => {
		const { provider, t0 } = capped();
		let after = "";
		codingFaux.setResponses([
			toolUse("write", { path: "a.txt", content: "before\n" }),
			toolUse("bash", { command: "sleep 30" }),
			(context) => {
				after = sent(context);
				return toolUse("write", { path: "b.txt", content: "after\n" });
			},
			fauxAssistantMessage("Done across two sessions."),
		]);
		const { id, stub } = await startThread();
		await running(stub, 2);
		const before = await stub.status();
		expect(before.session).toMatchObject({ state: "active", startedAt: t0, maxMin: 1, expiresAt: t0 + 60_000, continuations: 0, last: null });
		const ref = (await provider.list({ sessionId: id }))[0]!.ref;
		await printedOf((await provider.get(ref))!, ["spawn", "daemon"]);
		const staleHeaders = injectedHeaders(provider.egressOf(id)!, "pim.test", "/api/coding/git/acme/demo.git/info/refs");
		expect(staleHeaders.authorization).toMatch(/^Bearer /);
		// Twelve seconds before the cap (a fifth of it): the heartbeat starts the move.
		codingThreadClock.now = t0 + 48_000;
		await heartbeat(stub);
		const [ended] = await turns(id, 1);
		expect(ended!.outcome).toBe("completed");
		const freshHeaders = injectedHeaders(provider.egressOf(id)!, "pim.test", "/api/coding/git/acme/demo.git/info/refs");
		expect(freshHeaders.authorization).toMatch(/^Bearer /);
		expect(freshHeaders.authorization).not.toBe(staleHeaders.authorization);
		const status = await stub.status();
		expect(status.session).toMatchObject({ state: "active", continuations: 1, startedAt: t0 + 48_000, expiresAt: t0 + 108_000, last: { mode: "resumed", reason: "session_cap" } });
		expect(status).toMatchObject({ state: "idle" });
		// The running command was stopped and the model told so; it went on in the new session, where its files were.
		expect(after).toContain("sleep 30");
		expect(await fileOn(provider, id, "a.txt")).toBe("before\n");
		expect(await fileOn(provider, id, "b.txt")).toBe("after\n");
		// The same workspace was resumed, its processes gone, and the work committed in the turn's checkpoints.
		expect((await provider.list({ sessionId: id }))[0]!.ref).toEqual(ref);
		expect(await printedOf((await provider.get(ref))!, ["ps"])).not.toContain("daemon");
		const checkpoints = await stub.checkpoints();
		expect(checkpoints.length).toBeGreaterThanOrEqual(2);
		// It is past the first session's cap now, and still works: the new session is what counts.
		codingThreadClock.now = t0 + 70_000;
		expect(await fileOn(provider, id, "a.txt")).toBe("before\n");
		expect(await sql(stub, "SELECT kind FROM coding_event WHERE kind LIKE 'session.%' ORDER BY seq")).toEqual([{ kind: "session.continuing" }, { kind: "session.continued" }]);
	});

	it("restarts the turn from its transcript when it can't be moved to a new session", async () => {
		const { provider, t0 } = capped();
		let resumed = "";
		codingFaux.setResponses([
			toolUse("write", { path: "a.txt", content: "before\n" }),
			toolUse("bash", { command: "sleep 30" }),
			(context) => {
				resumed = sent(context);
				return fauxAssistantMessage("Restarted and done.");
			},
		]);
		// The provider can't resume the suspended workspace this once.
		const resume = provider.resumeOrCreate.bind(provider);
		let refused = 0;
		provider.resumeOrCreate = async (ref, spec) => {
			if (refused++ === 0) throw new Error("The provider is down");
			return resume(ref, spec);
		};
		const { id, stub } = await startThread();
		await running(stub, 2);
		codingThreadClock.now = t0 + 50_000;
		await heartbeat(stub);
		const [ended] = await turns(id, 1);
		expect(ended!.outcome).toBe("completed");
		expect(resumed).toContain(SESSION_RESUME_TEXT);
		expect(await fileOn(provider, id, "a.txt")).toBe("before\n");
		const status = await stub.status();
		expect(status).toMatchObject({ state: "idle", consecutiveInterrupts: 0, session: { state: "active", continuations: 1, last: { mode: "turn_restarted" } } });
		expect(await sql(stub, "SELECT kind FROM coding_event WHERE kind LIKE 'session.%' ORDER BY seq")).toEqual([{ kind: "session.continuing" }, { kind: "session.turn_restarted" }]);
	});

	it("keeps Pim's tokens out of the workspace when the provider injects them, and in it when it doesn't", async () => {
		const { provider } = capped({ sessionMaxMin: undefined });
		codingFaux.setResponses([fauxAssistantMessage("Cloned.")]);
		const injected = await startThread();
		await turns(injected.id, 1);
		let policy = provider.egressOf(injected.id)!;
		expect(policy.inject).toEqual([{ host: "pim.test", pathPrefix: "/api/coding/git", headers: { authorization: expect.stringMatching(/^Bearer .{20,}$/) } }]);
		expect(policy.allow).toEqual(expect.arrayContaining(["pim.test", "registry.npmjs.org"]));
		const clone = fakeClones.findLast((each) => each.url === BROKER_URL && each.env.GIT_CONFIG_COUNT === undefined)!;
		expect(clone).toBeDefined();
		const token = policy.inject![0]!.headers.authorization!.replace("Bearer ", "");
		expect(JSON.stringify(fakeClones)).not.toContain(token);
		expect(await everything(injected.stub)).not.toContain(token);
		// An agent supplies no header: the egress policy authenticates its ordinary fetch.
		const [info] = await provider.list({ sessionId: injected.id });
		const workspace = (await provider.get(info!.ref))!;
		const events = [];
		for await (const event of workspace.exec(["git", "fetch", "origin", "main"], { cwd: REPO_DIR, timeoutMs: 1000 })) events.push(event);
		expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 });
		const path = "/api/coding/git/acme/demo.git/info/refs?service=git-upload-pack";
		const headers = injectedHeaders(policy, "pim.test", path);
		const fetched = await handleGitBroker(new Request("https://pim.test" + path, { headers }), path.slice(4).split("?")[0]!, {
			key: await brokerTokenKey(env), app: null, policy: { branchPrefix: "pim/", repos: null },
			fetch: async () => new Response("refs", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } }),
		});
		expect(fetched.status).toBe(200);
		await fetched.text();

		// The model gateway's token goes to the proxy too, next to the git rule, and the workspace is given a placeholder to send.
		const gateway = await inside(injected.stub, (thread) => thread.modelGatewayEnv("claude-code"));
		policy = provider.egressOf(injected.id)!;
		expect(policy.inject).toEqual([
			{ host: "pim.test", pathPrefix: "/api/coding/git", headers: { authorization: `Bearer ${token}` } },
			{ host: "pim.test", pathPrefix: "/api/coding/gateway", headers: { "x-api-key": expect.stringMatching(/.{20,}/) } },
		]);
		const gatewayToken = policy.inject![1]!.headers["x-api-key"]!;
		expect(gateway.env.ANTHROPIC_API_KEY).toBe("pim-injected-by-egress-proxy");
		expect(JSON.stringify(gateway.env)).not.toContain(gatewayToken);
		expect(await everything(injected.stub)).not.toContain(gatewayToken);
		// The same thread's environment held none, on a provider that can't inject.
		codingBackends.registry = null;
		codingFaux.setResponses([fauxAssistantMessage("Cloned.")]);
		const plain = await startThread();
		await turns(plain.id, 1);
		expect(codingWorkspaces.egressOf(plain.id)?.inject).toEqual([]);
		expect(fakeClones.findLast((each) => each.url === BROKER_URL)!.env.GIT_CONFIG_VALUE_0).toMatch(/^Authorization: Bearer /);
	});

	it("keeps the broker token out of the workspace when it fetches for a merge, on a provider that injects", async () => {
		const { provider } = capped({ sessionMaxMin: undefined });
		const fetches: Record<string, string>[] = [];
		provider.register("git", async (context) => {
			if (context.argv.includes("fetch") && context.argv.includes("origin")) fetches.push(context.env);
			return fakeGit(context);
		});
		codingFaux.setResponses([toolUse("write", { path: "hello.txt", content: "Hello!\n" }), fauxAssistantMessage("Added.")]);
		const { id, stub } = await startThread();
		await turns(id, 1);
		codingGitHub.app = { installationToken: async () => ({ token: "ghs_test", expiresAt: Date.now() + 3_600_000 }) } as never;
		codingGitHub.fetch = async (input: RequestInfo | URL) => (String(input) === "https://api.github.com/repos/acme/demo" ? Response.json({ default_branch: "main" }) : new Response("no", { status: 404 }));
		try {
			const checkpoint = (await stub.status()).checkpoint!.sha;
			// What the merge does after its fetch doesn't matter here.
			await inside(stub, (thread) => thread.merge({ checkpoint })).catch(() => undefined);
		} finally {
			codingGitHub.app = null;
			codingGitHub.fetch = null;
		}
		const token = provider.egressOf(id)!.inject![0]!.headers.authorization!.replace("Bearer ", "");
		// The merge's own fetch: the last one, with no header in its environment.
		expect(fetches.length).toBeGreaterThan(0);
		for (const fetchEnv of fetches) expect(Object.keys(fetchEnv).filter((name) => name.startsWith("GIT_CONFIG"))).toEqual([]);
		expect(JSON.stringify(fetches)).not.toContain(token);
	});

	it("doesn't leave a workspace behind when the thread is archived while its session is being renewed", async () => {
		const { provider, t0 } = capped();
		let release = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const resume = provider.resumeOrCreate.bind(provider);
		provider.resumeOrCreate = async (ref, spec) => {
			await gate;
			return resume(ref, spec);
		};
		codingFaux.setResponses([toolUse("bash", { command: "sleep 30" }), toolUse("bash", { command: "sleep 31" })]);
		const { id, stub } = await startThread();
		await running(stub, 1);
		codingThreadClock.now = t0 + 50_000;
		await heartbeat(stub);
		// The old workspace is suspended and the renewal waits for the provider.
		await vi.waitFor(async () => expect((await provider.list({ sessionId: id }))[0]?.state).toBe("stopped"), { timeout: 15_000 });
		// Its command was stopped for the move, and the model asked for another.
		await vi.waitFor(() => expect(codingFaux.getPendingResponseCount()).toBe(0), { timeout: 15_000 });
		await stub.archive();
		expect(await provider.list({ sessionId: id })).toEqual([]);
		release();
		// The renewal finishes after the archive: the workspace it made is destroyed, not kept.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(await provider.list({ sessionId: id })).toEqual([]);
		expect(await stub.status()).toMatchObject({ state: "archived", slot: "none", session: { state: "active" } });
	});

	it("doesn't restart a turn the person stopped while its session was being renewed", async () => {
		const { provider, t0 } = capped();
		let release = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		provider.suspend = async () => {
			await gate;
			throw new Error("The provider is down");
		};
		codingFaux.setResponses([toolUse("bash", { command: "sleep 30" }), toolUse("bash", { command: "sleep 31" })]);
		const { id, stub } = await startThread();
		await running(stub, 1);
		codingThreadClock.now = t0 + 50_000;
		await heartbeat(stub);
		// Its command was stopped for the move, and the model asked for another.
		await vi.waitFor(() => expect(codingFaux.getPendingResponseCount()).toBe(0), { timeout: 15_000 });
		await stub.abort();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "cancelled" });
		release();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(await turns(id, 1)).toHaveLength(1);
		expect(await stub.status()).toMatchObject({ state: "idle", currentOperation: null, inbox: 0, session: { state: "active", continuations: 0 } });
		expect(await sql(stub, "SELECT kind FROM coding_event WHERE kind = 'session.turn_restarted'")).toEqual([]);
	});

	it("fails a thread whose turn is restarted for its session again and again without committing anything", async () => {
		const { provider, t0 } = capped();
		provider.suspend = async () => {
			throw new Error("The provider is down");
		};
		// Each move also stops the command running, and the model may ask for another before the turn is: more answers than turns.
		codingFaux.setResponses(Array.from({ length: 12 }, (_, n) => toolUse("bash", { command: `sleep ${30 + n}` })));
		const { id, stub } = await startThread();
		for (let restart = 1; restart <= 4; restart++) {
			// The turn is under way again after the last restart.
			await vi.waitFor(async () => expect(await stub.status()).toMatchObject({ currentOperation: expect.any(String), session: { unproductiveRestarts: restart - 1 } }), { timeout: 15_000, interval: 50 });
			codingThreadClock.now = t0 + restart * 50_000;
			await heartbeat(stub);
		}
		try {
			const [ended] = await turns(id, 1);
			expect(ended).toMatchObject({ outcome: "error", reason: "session_restarts_exhausted", state: "failed", detail: expect.stringContaining("4 times in a row") });
			// The move that ended it settles a moment after the turn's end is told.
			await vi.waitFor(async () => expect(await stub.status()).toMatchObject({ state: "failed", stateReason: "session_restarts_exhausted", session: { state: "active", unproductiveRestarts: 4 } }), { timeout: 15_000, interval: 50 });
		} finally {
			codingFaux.setResponses([]);
		}
	}, 120_000);
});

async function printedOf(workspace: { exec: (cmd: string[], o: { timeoutMs: number }) => AsyncIterable<{ type: string; data?: string }> }, cmd: string[]) {
	let out = "";
	for await (const event of workspace.exec(cmd, { timeoutMs: 5_000 })) if (event.type === "stdout") out += event.data;
	return out;
}

describe("a coding thread on the Compose sandbox manager", () => {
	/** The real Compose provider, talking to a stubbed manager over its routes, whose workspaces have the fake git. */
	function compose(max = 3) {
		const manager = fakeManager(max);
		manager.backing.register("git", fakeGit);
		codingBackends.registry = workspaceRegistry([new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: manager.fetch, sleep: async () => {} })]);
		const calls = () => manager.requests.map((request) => `${request.method} ${request.path.replace(/\?.*$/, "")}`);
		return { manager, calls };
	}

	const heartbeat = (stub: Stub) => inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));

	it("starts, clones, runs tools and is archived through the manager, which sets its space's slots", async () => {
		const { manager, calls } = compose(1);
		let listed = "";
		codingFaux.setResponses([
			toolUse("write", { path: "hello.txt", content: "Hello!\n" }),
			toolUse("bash", { command: "cat hello.txt" }),
			(context) => {
				const result = context.messages.findLast((each) => each.role === "toolResult");
				listed = result?.role === "toolResult" ? result.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
				return fauxAssistantMessage("Wrote hello.txt.");
			},
		]);
		const { id, stub, input } = await startThread();
		const [ended] = await turns(id, 1);
		expect(ended!.outcome).toBe("completed");
		expect(listed).toContain("Hello!");
		// The manager's health went to the scheduler before the slot was asked for: its limit of 1 is under the space's 3, so the space's next thread waits.
		expect(calls()[0]).toBe("GET /health");
		const next = await startThread({ space: input.space });
		expect(next.status).toMatchObject({ state: "queued", queue: { position: 1, reason: "slots_full" } });
		await next.stub.archive();
		// One workspace for the thread's session, the clone run in it with the broker's header, and every route but /health sent the manager's token.
		expect(manager.requests.find((request) => request.path === "/sessions" && request.method === "POST")?.body).toMatchObject({ sessionId: id });
		const clone = manager.requests.find((request) => (request.body as { cmd?: string[] } | undefined)?.cmd?.[1] === "clone")!;
		expect(clone.body).toMatchObject({ cmd: ["git", "clone", "--no-checkout", BROKER_URL, REPO_DIR], env: { GIT_CONFIG_KEY_0: "http.extraHeader" } });
		expect(manager.requests.filter((request) => request.path !== "/health").every((request) => request.auth === `Bearer ${TOKEN}`)).toBe(true);
		const [info] = await manager.backing.list({ sessionId: id });
		const workspace = (await manager.backing.get(info!.ref))!;
		expect(new TextDecoder().decode(await workspace.readFile(`${REPO_DIR}/hello.txt`))).toBe("Hello!\n");
		const credential = JSON.parse(new TextDecoder().decode(await workspace.readFile("/workspace/.config/pim/git/credential.json"))) as { url: string; token: string };
		expect(credential.url).toBe(BROKER_URL);
		expect(await verifyBrokerToken(await brokerTokenKey(env), credential.token)).toMatchObject({ sessionId: id, repo: "acme/demo", renewUntil: expect.any(Number) });
		const configs = manager.requests.filter(request => (request.body as { cmd?: string[] })?.cmd?.[1] === "config");
		expect(configs.some(request => (request.body as { cmd: string[] }).cmd.includes("credential." + BROKER_URL + ".helper"))).toBe(true);
		expect(JSON.stringify(configs)).not.toContain(credential.token);
		expect(await everything(stub)).not.toContain(credential.token);
		const fetchEvents = [];
		for await (const event of workspace.exec(["git", "fetch", "origin", "main"], { cwd: REPO_DIR, timeoutMs: 1000 })) fetchEvents.push(event);
		expect(fetchEvents.at(-1)).toMatchObject({ type: "exit", code: 0 });

		expect(await stub.status()).toMatchObject({ state: "idle", slot: "held", checkpoint: { operationId: input.operationId } });
		// Archived: the session is deleted without its volume, and the slot is free.
		expect(await stub.archive()).toMatchObject({ state: "archived", slot: "none" });
		expect(calls().at(-1)).toBe(`DELETE /sessions/${id}`);
		expect(manager.requests.at(-1)!.path).not.toContain("keepVolume");
		expect(await manager.backing.list({ sessionId: id })).toEqual([]);
		expect((await codingScheduler(env, input.space).snapshot()).running).toEqual([]);
	});

	it("keeps the environment as the person's snapshot in the manager, and starts their next thread from it", async () => {
		const { manager } = compose();
		manager.backing.register("bash", async ({ cwd, workspace }) => {
			await workspace.writeFile(`${cwd}/node_modules/.modules.yaml`, new TextEncoder().encode("installed\n"));
			// Longer than the fake manager's 1-byte snapshot takes to restore, so it is kept (the clock stands still without a wait).
			await new Promise((resolve) => setTimeout(resolve, 10));
			return {};
		});
		const name = `Env-${crypto.randomUUID().slice(0, 8)}`;
		fakeRemotes.set(`https://pim.test/api/coding/git/Acme/${name}.git`, { "README.md": "# Env\n", ".pim/setup.sh": "pnpm install\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
		const repo = `https://github.com/Acme/${name}`;
		const fullName = `acme/${name.toLowerCase()}`;
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
		const first = await startThread({ repo, space });
		await turns(first.id, 1);
		const { key } = (await first.stub.status()).environment;
		const creates = () => manager.requests.filter((request) => request.method === "POST" && request.path === "/sessions").map((request) => request.body as Record<string, unknown>);
		// The session is the person's, of the repository, and says nothing of secrets: it never has any while it is snapshotted.
		expect(creates()[0]).toEqual({ sessionId: first.id, image: "pim-workspace:local", limits: expect.any(Object), egressAllow: expect.any(Array), userId: space, repo: fullName });
		expect(creates()[0]?.egressAllow).toEqual(expect.arrayContaining(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "index.crates.io", "static.crates.io", "proxy.golang.org", "sum.golang.org", "storage.googleapis.com"]));
		expect(manager.requests.filter((request) => request.method === "POST" && request.path === "/snapshots").map((request) => request.body)).toEqual([{ userId: space, repo: fullName, key, sessionId: first.id }]);
		const second = await startThread({ repo, space });
		await turns(second.id, 1);
		expect(creates().find((body) => body.sessionId === second.id)).toMatchObject({ userId: space, repo: fullName, restoreFrom: { key } });
		expect((await second.stub.status()).environment).toMatchObject({ state: "cached", key, restoredFromKey: key });
		// Every listing asked for this person's snapshots alone.
		const listings = manager.requests.filter((request) => request.method === "GET" && request.path.startsWith("/snapshots"));
		expect(listings.length).toBeGreaterThan(0);
		expect(listings.every((request) => new URL(request.path, URL_BASE).searchParams.get("userId") === space)).toBe(true);
	});

	it("makes a pi thread's workspace again when its container dies under a command, and the turn goes on in it", async () => {
		const { manager, calls } = compose();
		const command = { release: null as (() => void) | null };
		manager.backing.register("sleep", async () => {
			await new Promise<void>((resolve) => {
				command.release = resolve;
			});
			return {};
		});
		const results: string[] = [];
		const lastResult = (context: Context) => {
			const result = context.messages.findLast((each) => each.role === "toolResult");
			return result?.role === "toolResult" ? result.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
		};
		codingFaux.setResponses([
			toolUse("write", { path: "wip.txt", content: "half done\n" }),
			toolUse("bash", { command: "sleep 600" }),
			(context) => {
				results.push(lastResult(context));
				return toolUse("bash", { command: "cat wip.txt" });
			},
			(context) => {
				results.push(lastResult(context));
				return fauxAssistantMessage("Done.");
			},
		]);
		const { id, stub } = await startThread();
		await vi.waitFor(() => expect(command.release).not.toBeNull(), { timeout: 10_000, interval: 20 });
		// The container dies under the command; the manager still lists the session as running.
		await inside(stub, async () => void (await manager.crash(id)));
		await inside(stub, async () => command.release!());
		const [ended] = await turns(id, 1);
		expect(ended!.outcome).toBe("completed");
		// The model was told the command was lost, and its next one ran in the workspace made again from the kept volume.
		expect(results[0]).toContain("The workspace stopped answering");
		expect(results[1]).toContain("half done");
		expect(calls().filter((call) => call === "POST /sessions")).toHaveLength(2);
		expect(manager.requests.filter((request) => request.method === "DELETE" && !request.path.includes("/file")).map((request) => request.path)).toEqual([`/sessions/${id}?keepVolume=1`]);
		expect((await stub.log()).map((event) => event.kind)).toContain("workspace.lost");
	});

	it("waits in the queue while the manager's disk is low, and checks its health until there is room", async () => {
		const { manager } = compose();
		manager.disk.freeDiskPct = 9;
		codingFaux.setResponses([fauxAssistantMessage("Done.")]);
		const { id, stub, input, status } = await startThread();
		expect(status).toMatchObject({ state: "queued", slot: "queued", queue: { position: 1, reason: "low_disk", detail: "9% of the disk free" } });
		// While queued it comes back every heartbeat to check again.
		expect(await heartbeat(stub)).toEqual({ rescheduleAt: expect.any(Number) });
		expect(await stub.status()).toMatchObject({ state: "queued" });
		manager.disk.freeDiskPct = 40;
		await heartbeat(stub);
		expect((await turns(id, 1))[0]!.outcome).toBe("completed");
		expect(await codingScheduler(env, input.space).snapshot()).toMatchObject({ queued: [], running: [expect.objectContaining({ threadId: id })] });
	});

	it("holds its space's queue when the manager refuses its workspace for low disk, and makes it once there is room", async () => {
		const { manager } = compose();
		// The disk fills between the health check and the create.
		const fetch = manager.fetch;
		const health = { checks: 0 };
		codingBackends.registry = workspaceRegistry([
			new ComposeWorkspaceProvider({
				managerUrl: URL_BASE,
				token: TOKEN,
				fetch: async (input, init) => {
					const response = await fetch(input, init);
					if (String(input).endsWith("/health") && ++health.checks === 1) manager.disk.freeDiskPct = 9;
					return response;
				},
			}),
		]);
		codingFaux.setResponses([fauxAssistantMessage("Done.")]);
		const { id, stub, input } = await startThread();
		await vi.waitFor(async () => expect(await stub.status()).toMatchObject({ state: "provisioning", slot: "held", stateReason: "low_disk" }), { timeout: 10_000, interval: 50 });
		// Nobody else is let in meanwhile.
		const other = await startThread({ space: input.space });
		expect(other.status).toMatchObject({ state: "queued", queue: { reason: "low_disk" } });
		await other.stub.archive();
		manager.disk.freeDiskPct = 40;
		await heartbeat(stub);
		expect((await turns(id, 1))[0]!.outcome).toBe("completed");
		expect((await codingScheduler(env, input.space).snapshot()).running.map((slot) => slot.threadId)).toEqual([id]);
	});
	it("rides out a manager that answers 502 while it restarts, and takes up the workspace it left running instead of making another", async () => {
		const { manager, calls } = compose();
		// The manager made the thread's container, then went down before the thread saved it; it is back after three failures.
		let down = 0;
		codingBackends.registry = workspaceRegistry([
			new ComposeWorkspaceProvider({
				managerUrl: URL_BASE,
				token: TOKEN,
				sleep: async () => {},
				fetch: async (input, init) => (String(input).endsWith("/health") || down-- <= 0 ? manager.fetch(input, init) : json(502, {})),
			}),
		]);
		const id = crypto.randomUUID();
		await manager.fetch(`${URL_BASE}/sessions`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ sessionId: id, image: "pim-workspace:local", limits: { cpu: 1, memMiB: 256, diskMiB: 64, pids: 64 }, egressAllow: [] }),
		});
		down = 3;
		codingFaux.setResponses([fauxAssistantMessage("Done.")]);
		const stub = codingThread(env, id);
		await stub.start(startInput(id, {}));
		expect((await turns(id, 1))[0]!.outcome).toBe("completed");
		expect(await stub.status()).toMatchObject({ state: "idle", slot: "held" });
		expect(manager.requests.filter((request) => request.method === "POST" && request.path === "/sessions")).toHaveLength(1);
		expect(calls()).toContain(`GET /sessions/${id}`);
	});

});

describe("a coding thread with an overflow provider", () => {
	/** A sandbox manager and Cloudflare in memory, each with the fake git: the manager runs at most `managerMax` workspaces of every space's, as its own limit does. */
	function providers(managerMax?: number) {
		const compose = new FakeWorkspaceProvider({ id: "compose", ...(managerMax === undefined ? {} : { maxConcurrent: managerMax }) });
		const cloudflare = new FakeWorkspaceProvider({ id: "cloudflare" });
		for (const provider of [compose, cloudflare]) provider.register("git", fakeGit);
		codingBackends.registry = workspaceRegistry([compose, cloudflare]);
		return { compose, cloudflare };
	}
	const on = async (provider: FakeWorkspaceProvider, id: string) => (await provider.list({ sessionId: id })).length;
	const slots = async (space: string) => (await codingScheduler(env, space).snapshot()).running.map((slot) => `${slot.threadId}:${slot.pool}`);
	/** Sets the Gallery's sandbox pool registry as a test wants it, and gives back what restores it, for `onTestFinished`. */
	const setPools = async (pools: readonly { id: string; provider: string; size: number; priority: number; enabled?: boolean }[]) => {
		const gallery = env.Gallery.getByName("gallery");
		const write = async (list: readonly { id: string; provider: string; size: number; priority: number; enabled?: boolean }[]) => {
			const now = (await gallery.sandboxPools()) as { id: string }[];
			for (const pool of now) if (!list.some((candidate) => candidate.id === pool.id)) await gallery.removeSandboxPool(pool.id, "tester");
			for (const pool of list) await gallery.upsertSandboxPool(now.some((kept) => kept.id === pool.id) ? pool.id : null, pool, "tester");
		};
		const before = await gallery.sandboxPools();
		await write(pools);
		return async () => write(before);
	};
	const ledger = (id: string) =>
		runInDurableObject(env.Gallery.getByName("gallery"), (_instance: unknown, state: DurableObjectState) =>
			state.storage.sql.exec("SELECT provider, end_reason FROM compute_usage WHERE thread_id = ? ORDER BY id", id).toArray(),
		);
	const heartbeat = (stub: Stub) => inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));

	afterEach(() => {
		codingQuota.quota = null;
		codingCompute.providers = null;
		codingContainers.service = null;
		codingBackends.production = false;
	});

	it("runs on the sandbox manager while it has a slot, overflows to Cloudflare once it has none, and queues only when both are full", async () => {
		const { compose, cloudflare } = providers();
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		await scheduler.setLimit(1);
		await scheduler.setLimit(1, "cloudflare");
		codingFaux.setResponses([fauxAssistantMessage("First done."), fauxAssistantMessage("Second done."), fauxAssistantMessage("Third done.")]);
		const first = await startThread({ space });
		await turns(first.id, 1);
		expect(await first.stub.status()).toMatchObject({ workspaceProvider: "compose", slot: "held" });
		// The manager's one slot is taken: the next thread runs on Cloudflare at once, instead of waiting.
		const second = await startThread({ space });
		await turns(second.id, 1);
		expect(await second.stub.status()).toMatchObject({ workspaceProvider: "cloudflare", slot: "held", state: "idle" });
		expect([await on(compose, second.id), await on(cloudflare, second.id)]).toEqual([0, 1]);
		expect((await second.stub.log()).find((event) => event.kind === "workspace.overflow")?.data).toEqual({ from: "compose", to: "cloudflare" });
		expect(await slots(space)).toEqual(expect.arrayContaining([`${first.id}:compose`, `${second.id}:cloudflare`]));
		// Both are full: the third waits for whichever frees first.
		const third = await startThread({ space });
		expect(third.status).toMatchObject({ state: "queued", slot: "queued", workspaceProvider: "compose", queue: { position: 1, reason: "slots_full" } });
		await second.stub.archive();
		await turns(third.id, 1);
		expect(await third.stub.status()).toMatchObject({ workspaceProvider: "cloudflare", slot: "held" });
		expect(await on(cloudflare, third.id)).toBe(1);
		// The ledger counts each workspace's minutes under the provider it ran on.
		expect(await ledger(first.id)).toEqual([{ provider: "compose", end_reason: null }]);
		expect(await ledger(second.id)).toEqual([{ provider: "cloudflare", end_reason: "stop" }]);
		expect(await ledger(third.id)).toEqual([{ provider: "cloudflare", end_reason: null }]);
		for (const each of [first, third]) await each.stub.archive();
	});

	it("goes on where it made its workspace when it resumes, waiting for that provider though another has room", async () => {
		const { compose, cloudflare } = providers();
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		await scheduler.setLimit(1);
		codingFaux.setResponses([fauxAssistantMessage("First done."), fauxAssistantMessage("Other done."), fauxAssistantMessage("First again.")]);
		const first = await startThread({ space });
		await turns(first.id, 1);
		await (await compose.get((await compose.list({ sessionId: first.id }))[0]!.ref))!.writeFile(`${REPO_DIR}/notes.txt`, new TextEncoder().encode("Draft\n"));
		// Idle past ten minutes, it gives its slot back, keeping its files on the manager.
		codingSchedulers.now = Date.now() + 10 * 60_000 + 1_000;
		await scheduler.sweep();
		await runDurableObjectAlarm(scheduler);
		codingSchedulers.now = null;
		expect(await first.stub.status()).toMatchObject({ slot: "none", workspaceProvider: "compose" });
		// Another thread takes the manager's slot meanwhile.
		const other = await startThread({ space });
		await turns(other.id, 1);
		expect(await other.stub.status()).toMatchObject({ workspaceProvider: "compose" });
		// Cloudflare has room, but the first thread's work is on the manager: it waits for the manager's slot.
		await first.stub.steer("Carry on.", { operationId: "resume" });
		await vi.waitFor(async () => expect(await first.stub.status()).toMatchObject({ state: "queued", slot: "queued" }));
		expect((await scheduler.snapshot()).queued).toEqual([expect.objectContaining({ threadId: first.id, pool: "compose" })]);
		expect((await scheduler.snapshot()).queued[0]!.overflow).toBeUndefined();
		await other.stub.archive();
		const [, again] = await turns(first.id, 2);
		expect(again).toMatchObject({ outcome: "completed", operationId: "resume" });
		expect(await first.stub.status()).toMatchObject({ workspaceProvider: "compose", slot: "held" });
		expect(await on(cloudflare, first.id)).toBe(0);
		expect(new TextDecoder().decode(await (await compose.get((await compose.list({ sessionId: first.id }))[0]!.ref))!.readFile(`${REPO_DIR}/notes.txt`))).toBe("Draft\n");
		expect((await first.stub.log()).some((event) => event.kind === "workspace.overflow")).toBe(false);
		await first.stub.archive();
	});

	it("skips an unhealthy pool in placement and queues a pin until its probe succeeds", async () => {
		const { compose } = providers();
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		for (let i = 0; i < 2; i++) {
			await scheduler.request("fail", { pool: "compose" });
			await scheduler.workspaceResult("fail", "failure");
			await scheduler.release("fail");
		}
		vi.spyOn(compose, "create").mockRejectedValueOnce(new Error("Workspace start failed"));
		codingFaux.setResponses([fauxAssistantMessage("Overflow done."), fauxAssistantMessage("Probe done.")]);
		const plain = await startThread({ space });
		await turns(plain.id, 1);
		expect(await plain.stub.status()).toMatchObject({ pool: "cloudflare", placement: { skipped: [{ pool: "compose", reason: "unhealthy" }] } });
		const pinned = await startThread({ space, pool: "compose" });
		expect(await pinned.stub.status()).toMatchObject({ state: "queued", queue: { reason: "unhealthy" } });
		codingSchedulers.now = Date.now() + 5 * 60_000 + 1_000;
		onTestFinished(() => { codingSchedulers.now = null; });
		await runDurableObjectAlarm(scheduler);
		await turns(pinned.id, 1);
		expect(await scheduler.unhealthyPools(["compose"])).toEqual([]);
		codingSchedulers.now = null;
		for (const each of [plain, pinned]) await each.stub.archive();
	});

	it("places a pinned thread only on its pool, though the manager has room, and says why", async () => {
		const { compose, cloudflare } = providers();
		codingFaux.setResponses([fauxAssistantMessage("Pinned done."), fauxAssistantMessage("Default done.")]);
		const pinned = await startThread({ pool: "Cloudflare" });
		expect(pinned.status).toMatchObject({ provider: "cloudflare", pool: "cloudflare", placementReason: "pinned" });
		await turns(pinned.id, 1);
		expect([await on(compose, pinned.id), await on(cloudflare, pinned.id)]).toEqual([0, 1]);
		// Without a pin, the thread is on the first pool by priority.
		const plain = await startThread();
		await turns(plain.id, 1);
		expect(await plain.stub.status()).toMatchObject({ provider: "compose", pool: "compose", placementReason: "priority" });
		for (const each of [pinned, plain]) await each.stub.archive();
	});

	it("queues a pinned thread when its pool is full rather than overflowing it, and agrees pool with provider", async () => {
		providers();
		const space = `space-${crypto.randomUUID()}`;
		await codingScheduler(env, space).setLimit(1, "compose");
		codingFaux.setResponses([fauxAssistantMessage("First done."), fauxAssistantMessage("Second done.")]);
		const first = await startThread({ space, provider: "compose", pool: "compose" });
		await turns(first.id, 1);
		const second = await startThread({ space, pool: "compose" });
		expect(second.status).toMatchObject({ state: "queued", slot: "queued", placementReason: "pinned", queue: { position: 1 } });
		expect((await codingScheduler(env, space).snapshot()).queued[0]!.overflow).toBeUndefined();
		await first.stub.archive();
		await turns(second.id, 1);
		expect(await second.stub.status()).toMatchObject({ provider: "compose", slot: "held", placementReason: "pinned" });
		await second.stub.archive();
		const id = crypto.randomUUID();
		await expect(inside(codingThread(env, id), (thread) => thread.start(startInput(id, { pool: "compose", provider: "cloudflare" })))).rejects.toThrow(/different pools/);
	});

	it("refuses a pin to a pool the space doesn't have, naming the ones it has, and records nothing", async () => {
		codingBackends.registry = workspaceRegistry([new FakeWorkspaceProvider({ id: "compose" })]);
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		await expect(inside(stub, (thread) => thread.start(startInput(id, { pool: "cloudflare" })))).rejects.toThrow(/Unknown or disabled pool "cloudflare".*"compose"/);
		await expect(inside(stub, async (thread) => thread.store.thread())).resolves.toBeNull();
	});

	it("places by the pool registry: two pools on one provider each with its own size, and a thread overflows by priority", async () => {
		providers();
		const restore = await setPools([
			{ id: "big", provider: "compose", size: 2, priority: 1 },
			{ id: "small", provider: "compose", size: 1, priority: 2 },
			{ id: "cloudflare", provider: "cloudflare", size: 2, priority: 3 },
		]);
		onTestFinished(restore);
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("First done."), fauxAssistantMessage("Second done."), fauxAssistantMessage("Third done."), fauxAssistantMessage("Fourth done.")]);
		const first = await startThread({ space });
		const second = await startThread({ space });
		for (const each of [first, second]) {
			await turns(each.id, 1);
			expect(await each.stub.status()).toMatchObject({
				pool: "big",
				provider: "compose",
				placementReason: "priority",
				placement: { kind: "priority", pool: "big", provider: "compose", priority: 1, skipped: [] },
			});
		}
		// The big pool is full at its size of two, so the third takes the small one, still on the manager, before Cloudflare's.
		const third = await startThread({ space });
		await turns(third.id, 1);
		expect(await third.stub.status()).toMatchObject({
			pool: "small",
			provider: "compose",
			placementReason: "overflow",
			placement: { kind: "overflow", pool: "small", provider: "compose", priority: 2, skipped: [{ pool: "big", reason: "full" }] },
		});
		expect(await slots(space)).toEqual(expect.arrayContaining([`${first.id}:big`, `${second.id}:big`, `${third.id}:small`]));
		// Both of the manager's pools are full: the fourth goes on to Cloudflare's.
		const fourth = await startThread({ space });
		await turns(fourth.id, 1);
		expect(await fourth.stub.status()).toMatchObject({ pool: "cloudflare", provider: "cloudflare" });
		for (const each of [first, second, third, fourth]) await each.stub.archive();
	});

	it("cold-provisions a thread that overflows to a pool with no snapshot, then keeps that pool's own", async () => {
		const { compose } = providers();
		compose.register("bash", async ({ cwd, workspace }) => {
			await workspace.writeFile(`${cwd}/node_modules/.modules.yaml`, new TextEncoder().encode("installed\n"));
			return {};
		});
		const restore = await setPools([
			{ id: "big", provider: "compose", size: 1, priority: 1 },
			{ id: "small", provider: "compose", size: 1, priority: 2 },
		]);
		onTestFinished(restore);
		const name = `Pools-${crypto.randomUUID().slice(0, 8)}`;
		fakeRemotes.set(`https://pim.test/api/coding/git/Acme/${name}.git`, { "README.md": "# Pools\n", ".pim/setup.sh": "pnpm install\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
		const repo = `https://github.com/Acme/${name}`;
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("First done."), fauxAssistantMessage("Second done.")]);
		const first = await startThread({ repo, space });
		await turns(first.id, 1);
		const built = (await first.stub.status()).environment;
		// The first pool is the provider's first, so its snapshot has the key made before pools.
		expect(built).toMatchObject({ state: "cached", pool: "big", readyFrom: "setup", restoredFromKey: null, snapshotKept: true });
		expect([...compose.environments.values()].map((saved) => saved.key)).toEqual([built.key]);
		// The second thread overflows to the small pool, which has no snapshot: the big pool's isn't restored there.
		const second = await startThread({ repo, space });
		await turns(second.id, 1);
		const overflowed = (await second.stub.status()).environment;
		expect(await second.stub.status()).toMatchObject({ pool: "small", placementReason: "overflow" });
		expect(overflowed).toMatchObject({ state: "cached", pool: "small", readyFrom: "setup", restoredFromKey: null, snapshotKept: true });
		expect(overflowed.key).not.toBe(built.key);
		expect([...compose.environments.values()].map((saved) => saved.key).sort()).toEqual([built.key!, overflowed.key!].sort());
		for (const each of [first, second]) await each.stub.archive();
	});

	it("pins a thread to a pool by its id, and a provider's id to that provider's first pool", async () => {
		providers();
		const restore = await setPools([
			{ id: "big", provider: "compose", size: 2, priority: 2 },
			{ id: "small", provider: "compose", size: 1, priority: 1 },
			{ id: "cloudflare", provider: "cloudflare", size: 2, priority: 3 },
		]);
		onTestFinished(restore);
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("Big done."), fauxAssistantMessage("Small done.")]);
		// A pool's id, whatever the case: only there, though the small pool has room and stands first.
		const pinned = await startThread({ space, pool: "Big" });
		expect(pinned.status).toMatchObject({
			pool: "big",
			provider: "compose",
			placementReason: "pinned",
			placement: { kind: "pinned", pool: "big", provider: "compose", priority: 2, skipped: [] },
		});
		await turns(pinned.id, 1);
		// A provider's id names that provider's first pool, the small one.
		const byProvider = await startThread({ space, provider: "compose" });
		expect(byProvider.status).toMatchObject({ pool: "small", provider: "compose", placementReason: "pinned" });
		await turns(byProvider.id, 1);
		// The small pool is full at its size of one: a thread pinned there queues rather than overflowing.
		const queued = await startThread({ space, pool: "small" });
		expect(queued.status).toMatchObject({ state: "queued", slot: "queued", pool: "small", placementReason: "pinned" });
		expect((await codingScheduler(env, space).snapshot()).queued[0]).toMatchObject({ threadId: queued.id, pool: "small" });
		expect((await codingScheduler(env, space).snapshot()).queued[0]!.overflow).toBeUndefined();
		for (const each of [pinned, byProvider, queued]) await each.stub.archive();
	});

	it("resumes a thread from before pools, whose pool is its provider, where it made its workspace", async () => {
		const { compose, cloudflare } = providers();
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		codingFaux.setResponses([fauxAssistantMessage("First done."), fauxAssistantMessage("Again.")]);
		const thread = await startThread({ space });
		await turns(thread.id, 1);
		expect(await thread.stub.status()).toMatchObject({ pool: "compose", provider: "compose" });
		// A thread stored before pools has no pool of its own and no placement: its pool is its provider's id.
		await runInDurableObject(thread.stub, (_instance: CodingThreadDO, state) => {
			state.storage.sql.exec("UPDATE coding_thread SET pool_id = NULL, placement = NULL");
		});
		expect(await thread.stub.status()).toMatchObject({ pool: "compose", provider: "compose", placement: null });
		codingSchedulers.now = Date.now() + 10 * 60_000 + 1_000;
		await scheduler.sweep();
		await runDurableObjectAlarm(scheduler);
		codingSchedulers.now = null;
		await thread.stub.steer("Carry on.", { operationId: "resume" });
		await turns(thread.id, 2);
		// It asks for its slot in the same pool, and the one it gets counts there, though Cloudflare has room.
		expect(await thread.stub.status()).toMatchObject({ pool: "compose", provider: "compose", slot: "held", placementReason: "priority" });
		expect(await slots(space)).toEqual([`${thread.id}:compose`]);
		expect(await on(cloudflare, thread.id)).toBe(0);
		await thread.stub.archive();
	});

	it("places as it did before pools when the registry has no pool it can use", async () => {
		providers();
		const restore = await setPools([{ id: "elsewhere", provider: "daytona", size: 3, priority: 1 }]);
		onTestFinished(restore);
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("Done.")]);
		const thread = await startThread({ space });
		await turns(thread.id, 1);
		// One pool per provider, its id the provider's, in the registry's order; the pool the deployment lacks is named with why.
		expect(await thread.stub.status()).toMatchObject({
			pool: "compose",
			provider: "compose",
			placementReason: "priority",
			placement: { kind: "priority", pool: "compose", provider: "compose", priority: 1, skipped: [{ pool: "elsewhere", reason: "provider_unavailable" }] },
		});
		expect(await slots(space)).toEqual([`${thread.id}:compose`]);
		await thread.stub.archive();
	});

	it("keeps a pinned thread on its pool when it resumes, and records that an unpinned one overflowed", async () => {
		const { compose, cloudflare } = providers();
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		codingFaux.setResponses([fauxAssistantMessage("Pinned done."), fauxAssistantMessage("Pinned again."), fauxAssistantMessage("First done."), fauxAssistantMessage("Overflowed done.")]);
		const pinned = await startThread({ space, provider: "cloudflare" });
		await turns(pinned.id, 1);
		codingSchedulers.now = Date.now() + 10 * 60_000 + 1_000;
		await scheduler.sweep();
		await runDurableObjectAlarm(scheduler);
		codingSchedulers.now = null;
		expect(await pinned.stub.status()).toMatchObject({ slot: "none", provider: "cloudflare", placementReason: "pinned" });
		await pinned.stub.steer("Carry on.", { operationId: "resume" });
		await turns(pinned.id, 2);
		expect(await pinned.stub.status()).toMatchObject({ provider: "cloudflare", slot: "held", placementReason: "pinned" });
		expect([await on(compose, pinned.id), await on(cloudflare, pinned.id)]).toEqual([0, 1]);
		await pinned.stub.archive();
		// A thread that took a later provider because the first was full says so.
		await scheduler.setLimit(1);
		const first = await startThread({ space });
		await turns(first.id, 1);
		const overflowed = await startThread({ space });
		await turns(overflowed.id, 1);
		expect(await overflowed.stub.status()).toMatchObject({ provider: "cloudflare", placementReason: "overflow" });
		for (const each of [first, overflowed]) await each.stub.archive();
	});

	it("moves to Cloudflare when the manager refuses its first workspace for capacity, though its space had a slot", async () => {
		const { compose, cloudflare } = providers(1);
		codingFaux.setResponses([fauxAssistantMessage("Elsewhere done."), fauxAssistantMessage("Done.")]);
		// Another space's thread holds the manager's only workspace.
		const elsewhere = await startThread();
		await turns(elsewhere.id, 1);
		expect(await on(compose, elsewhere.id)).toBe(1);
		const { id, stub, input } = await startThread();
		await turns(id, 1);
		expect(await stub.status()).toMatchObject({ workspaceProvider: "cloudflare", slot: "held", stateReason: null });
		expect(await on(cloudflare, id)).toBe(1);
		expect(await slots(input.space)).toEqual([`${id}:cloudflare`]);
		// The refused try on the manager made no workspace and counted nothing that still runs.
		expect(await ledger(id)).toEqual([
			{ provider: "compose", end_reason: "failed" },
			{ provider: "cloudflare", end_reason: null },
		]);
		for (const each of [elsewhere.stub, stub]) await each.archive();
	});

	it("runs on Cloudflare at once when the manager's health says it is full", async () => {
		const manager = fakeManager(1);
		manager.backing.register("git", fakeGit);
		const cloudflare = new FakeWorkspaceProvider({ id: "cloudflare" });
		cloudflare.register("git", fakeGit);
		codingBackends.registry = workspaceRegistry([new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: manager.fetch, sleep: async () => {} }), cloudflare]);
		codingFaux.setResponses([fauxAssistantMessage("Elsewhere done."), fauxAssistantMessage("Done.")]);
		const elsewhere = await startThread();
		await turns(elsewhere.id, 1);
		const creates = () => manager.requests.filter((request) => request.method === "POST" && request.path === "/sessions").length;
		expect(creates()).toBe(1);
		const { id, stub } = await startThread();
		await turns(id, 1);
		expect(await stub.status()).toMatchObject({ workspaceProvider: "cloudflare" });
		// It never asked the full manager for a workspace.
		expect(creates()).toBe(1);
		expect(await ledger(id)).toEqual([{ provider: "cloudflare", end_reason: null }]);
		for (const each of [elsewhere.stub, stub]) await each.archive();
	});

	it("counts a workspace on Cloudflare against the person's quota like any other", async () => {
		providers();
		const space = `space-${crypto.randomUUID()}`;
		await codingScheduler(env, space).setLimit(1);
		codingQuota.quota = { maxConcurrentWorkspaces: 1, monthlySandboxMinutes: null, maxSessionMinutes: null };
		codingFaux.setResponses([fauxAssistantMessage("First done.")]);
		const first = await startThread({ space });
		await turns(first.id, 1);
		const second = await startThread({ space });
		await vi.waitFor(async () => expect(await second.stub.status()).toMatchObject({ state: "failed", stateReason: "compute_quota", workspaceProvider: "cloudflare" }), { timeout: 10_000, interval: 50 });
		await first.stub.archive();
	});

	it("finds the admin's overflow provider again on a fresh instance, before the Gallery is read", async () => {
		// The deployment's own backends as the admin set them up: Cloudflare Containers, here in memory, and nothing else.
		const containers = fakeContainers();
		containers.backend.register("git", fakeGit);
		codingContainers.service = containers;
		codingCompute.providers = [prepareComputeProvider({ kind: "cloudflare-sandbox" }, null)];
		codingBackends.production = true;
		codingFaux.setResponses([toolUse("write", { path: "a.txt", content: "A\n" }), fauxAssistantMessage("Wrote a."), toolUse("write", { path: "b.txt", content: "B\n" }), fauxAssistantMessage("Wrote b.")]);
		const { id, stub } = await startThread();
		await turns(id, 1);
		await stub.steer("Also write b.txt.", { operationId: "more" });
		const [, second] = await turns(id, 2);
		expect(second).toMatchObject({ outcome: "completed", operationId: "more" });
		expect(await stub.status()).toMatchObject({ workspaceProvider: "cloudflare", slot: "held" });
		const [first] = await stub.checkpoints();
		expect(first).not.toBeNull();
		// The object hibernates and comes back fresh, as between a person's requests: its first use of the workspace since, with no turn under way to read the compute providers, must still resolve the provider the admin added. The diff from the first checkpoint isn't one the thread kept, so it needs the workspace.
		await runInDurableObject(stub, (_instance: CodingThreadDO, state) => state.abort("evicted")).catch(() => {});
		const again = codingThread(env, id);
		expect(await again.diff(first!.sha)).toMatchObject({ since: first!.sha, diff: expect.stringContaining("+++ b/b.txt"), truncated: false });
		expect(await again.status()).toMatchObject({ workspaceProvider: "cloudflare", slot: "held", state: "idle" });
		await again.archive();
	});

	it("waits on the sandbox manager alone, holding its slot, when it refuses the workspace for capacity", async () => {
		const compose = new FakeWorkspaceProvider({ id: "compose", maxConcurrent: 1 });
		compose.register("git", fakeGit);
		codingBackends.registry = workspaceRegistry([compose]);
		codingFaux.setResponses([fauxAssistantMessage("Elsewhere done."), fauxAssistantMessage("Done.")]);
		const elsewhere = await startThread();
		await turns(elsewhere.id, 1);
		const { id, stub, input } = await startThread();
		await vi.waitFor(async () => expect(await stub.status()).toMatchObject({ state: "provisioning", slot: "held", stateReason: "workspace_capacity", workspaceProvider: "compose" }), {
			timeout: 10_000,
			interval: 50,
		});
		expect(await slots(input.space)).toEqual([`${id}:compose`]);
		await elsewhere.stub.archive();
		await heartbeat(stub);
		expect((await turns(id, 1))[0]!.outcome).toBe("completed");
		expect(await on(compose, id)).toBe(1);
		await stub.archive();
	});
});

describe("a coding thread's environment", () => {
	// Each test's repository has a setup script, and its own remote. `bash` in the in-memory workspace stands in for the
	// script: it records how it was run, then does what the test says, which is to install by writing node_modules.
	const SCRIPT = "set -euo pipefail\npnpm install --frozen-lockfile\n";
	const LOCK = "lockfileVersion: '9.0'\n";
	const WEB_LOCK = '{ "lockfileVersion": 3 }\n';
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const install: FakeCommandHandler = async ({ cwd, workspace }) => {
		await workspace.writeFile(`${cwd}/node_modules/.modules.yaml`, encoder.encode("installed\n"));
		return { stdout: "Done in 8s\n" };
	};
	const setups: { argv: string[]; cwd: string; env: Record<string, string>; space: string | undefined }[] = [];
	let setup: FakeCommandHandler = install;
	codingWorkspaces.register("bash", async (context) => {
		const spec = (context.workspace as unknown as { spec: WorkspaceSpec }).spec;
		setups.push({ argv: context.argv, cwd: context.cwd, env: context.env, space: spec.environment?.userId });
		return setup(context);
	});

	/** A repository of its own for the test, `Acme/<name>`, with a setup script and lockfiles at its root and in `web/`. */
	function envRepo(files: Record<string, string> = {}) {
		const name = `Env-${crypto.randomUUID().slice(0, 8)}`;
		fakeRemotes.set(`https://pim.test/api/coding/git/Acme/${name}.git`, { "README.md": "# Env\n", ".pim/setup.sh": SCRIPT, "pnpm-lock.yaml": LOCK, "web/package-lock.json": WEB_LOCK, ...files });
		return { repo: `https://github.com/Acme/${name}`, fullName: `acme/${name.toLowerCase()}`, remote: `https://pim.test/api/coding/git/Acme/${name}.git` };
	}

	const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const snapshotsOf = (space: string) => [...codingWorkspaces.environments.values()].filter((saved) => saved.userId === space);
	const settledEnvironment = (stub: Stub) =>
		vi.waitFor(
			async () => {
				const { environment } = await stub.status();
				expect(environment.state).toMatch(/^(cached|failed|none)$/);
				expect(environment.rebuildRequested).toBe(false);
				return environment;
			},
			{ timeout: 10_000, interval: 50 },
		);

	beforeEach(() => {
		setups.length = 0;
		setup = install;
	});

	it("is keyed by everything it is made from, however its lockfiles are listed", async () => {
		const base: EnvironmentKeyInput = { userId: "ada", repo: "acme/env", provision: [], setupScript: SCRIPT, setupSource: "repository", unpinned: [], lockfiles: { "pnpm-lock.yaml": "a".repeat(64), "web/package-lock.json": "b".repeat(64) }, image: "pim-workspace@sha256:1" };
		const key = await environmentKey(base);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(await environmentKey({ ...base })).toBe(key);
		expect(await environmentKey({ ...base, lockfiles: { "web/package-lock.json": "b".repeat(64), "pnpm-lock.yaml": "a".repeat(64) } })).toBe(key);
		const variants: EnvironmentKeyInput[] = [
			{ ...base, userId: "bob" },
			// Joined without separating the inputs, these two would be one key.
			{ ...base, userId: "ad", repo: "aacme/env" },
			{ ...base, repo: "acme/other" },
			{ ...base, setupScript: `${SCRIPT}pnpm build\n` },
			{ ...base, setupScript: null },
			// The same text from another source is another environment, and so is a toolchain that resolved to a newer version or whose period ended.
			{ ...base, setupSource: "settings" },
			{ ...base, unpinned: ["node@lts=22.1.0"] },
			{ ...base, unpinned: ["node@lts=22.2.0"] },
			{ ...base, unpinned: ["node@lts=ttl:2"] },
			{ ...base, unpinned: ["node@lts=ttl:3"] },
			{ ...base, provision: [installed("go@1.22")] },
			{ ...base, provision: [installed("go@1.23")] },
			{ ...base, provision: [installed("go@1.22"), "go mod download"] },
			{ ...base, lockfiles: { ...base.lockfiles, "pnpm-lock.yaml": "c".repeat(64) } },
			{ ...base, lockfiles: { ...base.lockfiles, "web/package-lock.json": "c".repeat(64) } },
			{ ...base, lockfiles: { "pnpm-lock.yaml": "a".repeat(64) } },
			{ ...base, lockfiles: { ...base.lockfiles, "api/uv.lock": "d".repeat(64) } },
			{ ...base, lockfiles: { "pnpm-lock.yaml": "a".repeat(64), "app/package-lock.json": "b".repeat(64) } },
			{ ...base, image: "pim-workspace@sha256:2" },
		];
		const keys = await Promise.all(variants.map((variant) => environmentKey(variant)));
		expect(new Set([key, ...keys]).size).toBe(variants.length + 1);
	});

	it("covers the lockfiles at the repository's root and one directory down, not deeper, in node_modules or in dot-directories", async () => {
		const provider = new FakeWorkspaceProvider();
		const ref = await provider.create({ sessionId: "lockfiles", image: "x", repo: { url: "", ref: "", branch: "" }, limits: { cpu: 1, memMiB: 64, diskMiB: 64, pids: 16, wallClockMin: 1 }, egress: { allow: [] }, gitAuth: { mode: "none" } });
		const workspace = (await provider.get(ref))!;
		const files: Record<string, string> = {
			"pnpm-lock.yaml": LOCK,
			"requirements-dev.txt": "pytest\n",
			"Cargo.toml": "[package]\n",
			"web/package-lock.json": WEB_LOCK,
			"api/poetry.lock": "poetry\n",
			"api/Cargo.lock": "cargo\n",
			"packages/a/yarn.lock": "too deep\n",
			"node_modules/yarn.lock": "a dependency's\n",
			".github/uv.lock": "hidden\n",
		};
		for (const [path, text] of Object.entries(files)) await workspace.writeFile(`${REPO_DIR}/${path}`, encoder.encode(text));
		expect(await lockfileHashes(workspace, REPO_DIR)).toEqual({
			"pnpm-lock.yaml": await sha256(LOCK),
			"requirements-dev.txt": await sha256("pytest\n"),
			"web/package-lock.json": await sha256(WEB_LOCK),
			"api/poetry.lock": await sha256("poetry\n"),
			"api/Cargo.lock": await sha256("cargo\n"),
		});
	});

	it("is set up by the repository's script before the first turn, with no secrets, and kept as the person's snapshot", async () => {
		const { repo, fullName } = envRepo();
		const space = `space-${crypto.randomUUID()}`;
		let keptBeforeTurn = false;
		codingFaux.setResponses([
			() => {
				keptBeforeTurn = snapshotsOf(space).length === 1;
				return fauxAssistantMessage("Ready.");
			},
		]);
		const { id, stub } = await startThread({ repo, space });
		expect((await turns(id, 1))[0]!.outcome).toBe("completed");
		expect(keptBeforeTurn).toBe(true);
		const { environment } = await stub.status();
		const key = await environmentKey({ userId: space, repo: fullName, provision: [], setupScript: SCRIPT, setupSource: "repository", lockfiles: { "pnpm-lock.yaml": await sha256(LOCK), "web/package-lock.json": await sha256(WEB_LOCK) }, image: DEFAULT_WORKSPACE_IMAGE });
		expect(environment).toMatchObject({ state: "cached", key, source: "repository", restoredFromKey: null, rebuildRequested: false, readyFrom: "setup", snapshotKept: true });
		for (const field of ["builtAt", "preparedAt", "provisionMs", "setupMs", "snapshotMs"] as const) expect(environment[field]).toEqual(expect.any(Number));
		expect(environment.error).toBeUndefined();
		// The script ran once, with bash in the checkout, given nothing but CI and a git that never prompts.
		expect(setups).toEqual([{ argv: ["bash", "-c", SCRIPT], cwd: REPO_DIR, env: SETUP_ENV, space }]);
		expect(SETUP_ENV).toEqual({ CI: "true", GIT_TERMINAL_PROMPT: "0" });
		// The snapshot is the person's, of this repository, with the dependencies installed; nobody else's lists it.
		const [saved] = snapshotsOf(space);
		expect(saved).toMatchObject({ repo: fullName, key });
		expect(decoder.decode((saved!.nodes.get(`${REPO_DIR}/node_modules/.modules.yaml`) as { data: Uint8Array }).data)).toBe("installed\n");
		expect(await codingWorkspaces.listEnvironments({ userId: `space-${crypto.randomUUID()}`, repo: fullName })).toEqual([]);
		// The workspace was made for the person and repository, and the log says what happened.
		expect(((await workspaceOf(id)) as unknown as { spec: WorkspaceSpec }).spec.environment).toEqual({ userId: space, repo: fullName });
		expect((await stub.log()).find((event) => event.kind === "environment.built")?.data).toMatchObject({ key });
	});

	it("runs a repository's .pim/env.json setup, hashes its cacheKeys into the key, and shows its checks and services", async () => {
		const schema = "create table t (id int);\n";
		const env = {
			setup: ["pnpm install --frozen-lockfile", "pnpm run build"],
			cacheKeys: ["db/schema.sql", "gone.txt"],
			cachePaths: ["node_modules"],
			services: [{ name: "web", command: "pnpm dev", port: 5173, preview: true }],
			check: ["pnpm typecheck", "pnpm test"],
		};
		const { repo, fullName } = envRepo({ ".pim/env.json": JSON.stringify(env), "db/schema.sql": schema });
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("Ready.")]);
		const { id, stub } = await startThread({ repo, space });
		expect((await turns(id, 1))[0]!.outcome).toBe("completed");
		const { environment } = await stub.status();
		// Its setup ran in place of .pim/setup.sh, and the schema's contents are in the key beside the lockfiles.
		const script = "set -e\npnpm install --frozen-lockfile\npnpm run build\n";
		expect(setups.map((each) => each.argv)).toEqual([["bash", "-c", script]]);
		const key = await environmentKey({ userId: space, repo: fullName, provision: [], setupScript: script, setupSource: "env", lockfiles: { "pnpm-lock.yaml": await sha256(LOCK), "web/package-lock.json": await sha256(WEB_LOCK), "env:db/schema.sql": await sha256(schema) }, image: DEFAULT_WORKSPACE_IMAGE });
		expect(environment).toMatchObject({ state: "cached", key, source: "env", cachePaths: ["node_modules"], services: env.services });
		expect(environment.testCommands).toEqual([
			{ command: "pnpm typecheck", source: "pim", from: ".pim/env.json" },
			{ command: "pnpm test", source: "pim", from: ".pim/env.json" },
		]);
		expect(environment.notes).toEqual([".pim/env.json: the cache key \"gone.txt\" matches no file and is left out"]);
	});

	/** Two fake backends, one that keeps environment snapshots ("snapshots") and one that doesn't ("plain"), whose `bash` runs the test's `setup`. */
	function twoBackends() {
		const make = (id: string, snapshots: boolean) => {
			const backend = new FakeWorkspaceProvider({ id });
			backend.register("git", fakeGit);
			backend.register("bash", async (context) => {
				setups.push({ argv: context.argv, cwd: context.cwd, env: context.env, space: undefined });
				return setup(context);
			});
			backend.capabilities.environmentSnapshots = snapshots;
			return backend;
		};
		const backends = { snapshots: make("snapshots", true), plain: make("plain", false) };
		codingBackends.registry = workspaceRegistry([backends.snapshots, backends.plain]);
		return backends;
	}
	const failing: FakeCommandHandler = async ({ argv }) => (argv[2]!.includes("fail-me") ? { stderr: "fail-me\n", code: 3 } : { stdout: "Done in 8s\n" });
	const environmentNotices = (messages: { role: string; parts: readonly unknown[] }[]) =>
		messages.filter((message) => message.role === "notice" && (message.parts[0] as { text: string }).text.startsWith("Environment")).map((message) => (message.parts[0] as { text: string }).text.replace(/\d+(\.\d)? m?s\b/g, "<time>"));

	it("runs the same lifecycle on a backend that keeps no snapshots, and keeps one only where it can", async () => {
		const runs: Record<string, { kinds: string[]; keys: string[][]; notices: string[]; state: string; reason: string | null }> = {};
		for (const [label, script, ok] of [["ok", SCRIPT, true], ["failing", "fail-me\n", false]] as const) {
			for (const provider of ["snapshots", "plain"] as const) {
				const backends = twoBackends();
				setup = failing;
				const { repo } = envRepo({ ".pim/setup.sh": script });
				codingFaux.setResponses([fauxAssistantMessage("Went on.")]);
				const { id, stub } = await startThread({ repo, provider });
				expect((await turns(id, 1))[0]!.outcome).toBe("completed");
				const status = await stub.status();
				const events = (await stub.log()).filter((event) => event.kind.startsWith("environment."));
				runs[`${label}/${provider}`] = {
					kinds: events.map((event) => event.kind),
					keys: events.map((event) => Object.keys(event.data ?? {}).sort()),
					notices: environmentNotices(await inside(stub, (thread) => thread.transcript())),
					state: status.environment.state,
					reason: status.stateReason,
				};
				expect(status.workspaceProvider).toBe(provider);
				// Only the backend that can, keeps a snapshot.
				expect(backends.snapshots.environments.size).toBe(provider === "snapshots" && ok ? 1 : 0);
				expect(backends.plain.environments.size).toBe(0);
				expect(status.environment.snapshotKept).toBe(provider === "snapshots" && ok ? true : ok ? false : null);
				expect(status.environment.state).toBe(ok ? "cached" : "failed");
				setups.length = 0;
			}
			expect(runs[`${label}/plain`]).toEqual(runs[`${label}/snapshots`]);
		}
		expect(runs["ok/plain"]!.kinds).toEqual(["environment.started", "environment.step", "environment.built"]);
		expect(runs["failing/plain"]!.kinds).toEqual(["environment.started", "environment.step", "environment.failed"]);
		expect(runs["ok/plain"]!.reason).toBeNull();
		expect(runs["failing/plain"]!.reason).toBe("environment_failed");
		expect(runs["failing/plain"]!.notices[0]).toMatch(/^Environment setup: exit 3, <time>\n\$ fail-me\nfail-me$/);
		expect(runs["failing/plain"]!.notices[1]).toContain("Environment: failed: The setup script exited 3: fail-me\nThe agent starts anyway, in the workspace as it is. Retry the environment to run the setup again.");
	});

	it("shows each step in the transcript before the first message, with its output cut to 2 KiB and redacted", async () => {
		const { repo } = envRepo();
		const secret = `sk-ant-api03-${"A".repeat(40)}`;
		setup = async () => ({ stdout: `${"x".repeat(3000)}\nkey ${secret}\n\u001b[32mdone\u001b[0m\n` });
		codingFaux.setResponses([fauxAssistantMessage("Ready.")]);
		const { id, stub } = await startThread({ repo });
		await turns(id, 1);
		const transcript = await inside(stub, (thread) => thread.transcript());
		const index = transcript.findIndex((message) => message.id.startsWith("environment-"));
		const first = transcript.findIndex((message) => message.role === "user");
		expect(index).toBeGreaterThanOrEqual(0);
		expect(first).toBeGreaterThan(index);
		const steps = transcript.filter((message) => message.id.startsWith("environment-") && (message.parts[0] as { text: string }).text.startsWith("Environment setup"));
		expect(steps).toHaveLength(1);
		const text = (steps[0]!.parts[0] as { text: string }).text;
		expect(text).toMatch(/^Environment setup: exit 0, [\d.]+ m?s\n\$ set -euo pipefail\npnpm install --frozen-lockfile\n/);
		expect(text).toContain("[REDACTED]");
		expect(text).not.toContain(secret);
		expect(text).not.toContain("\u001b");
		expect(text).toMatch(/done\n\[Output truncated to its last 2048 of 3\d{3} characters\]$/);
		const data = (await stub.log()).find((event) => event.kind === "environment.step")!.data!;
		expect(data).toMatchObject({ step: "setup", outcome: "ok", exitCode: 0, truncated: true });
		expect(String(data.output).length).toBeLessThanOrEqual(2048);
		// Every notice of the phase comes before the first thing the person said.
		for (const message of transcript.filter((entry) => entry.id.startsWith("environment-"))) expect(transcript.indexOf(message)).toBeLessThan(first);
	});

	it("shows a failed setup as the thread's state, tells the agent, and runs the setup again in the same workspace on a retry", async () => {
		const { repo } = envRepo({ ".pim/setup.sh": "fail-me\n" });
		setup = failing;
		let prompt = "";
		codingFaux.setResponses([
			(context) => {
				prompt = sent(context);
				return fauxAssistantMessage("Went on.");
			},
		]);
		const { id, stub } = await startThread({ repo });
		await turns(id, 1);
		const status = await stub.status();
		expect(status).toMatchObject({ state: "idle", stateReason: "environment_failed", stateDetail: "The setup script exited 3: fail-me", environment: { state: "failed" } });
		expect(prompt).toContain("The environment's setup failed: The setup script exited 3: fail-me");
		expect(prompt).toContain("the person can retry the environment");
		const workspace = await sql(stub, "SELECT workspace_ref FROM coding_thread");
		expect(setups).toHaveLength(1);
		// The script works now: a retry runs it again where the thread is.
		setup = install;
		await stub.rebuildEnvironment();
		const environment = await settledEnvironment(stub);
		expect(environment).toMatchObject({ state: "cached", readyFrom: "setup" });
		expect(environment.error).toBeUndefined();
		expect(setups).toHaveLength(2);
		expect(await sql(stub, "SELECT workspace_ref FROM coding_thread")).toEqual(workspace);
		expect(await stub.status()).toMatchObject({ stateReason: null, stateDetail: null });
	});

	it("starts the person's next thread from the snapshot, checked out afresh, and another person's from scratch", async () => {
		const { repo, fullName, remote } = envRepo();
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("First."), fauxAssistantMessage("Second."), fauxAssistantMessage("Someone else's.")]);
		const first = await startThread({ repo, space });
		await turns(first.id, 1);
		const { key } = (await first.stub.status()).environment;
		// The repository moved on, but not its lockfiles or script: the same environment.
		fakeRemotes.set(remote, { ...fakeRemotes.get(remote), "README.md": "# Env, later\n" });
		const clones = fakeClones.length;
		const second = await startThread({ repo, space });
		await turns(second.id, 1);
		const status = await second.stub.status();
		expect(status.environment).toMatchObject({ state: "cached", key, restoredFromKey: key, source: "repository", readyFrom: "snapshot" });
		expect(status.environment.restoreMs).toEqual(expect.any(Number));
		expect(status.environment.setupMs).toBeNull();
		// Made from the snapshot: no clone and no setup, the dependencies there, and the repository fetched and checked out over it.
		const workspace = await workspaceOf(second.id);
		expect((workspace as unknown as { spec: WorkspaceSpec }).spec.environment).toEqual({ userId: space, repo: fullName, restoreFrom: key });
		expect(fakeClones.length).toBe(clones);
		expect(setups).toHaveLength(1);
		expect(decoder.decode(await workspace.readFile(`${REPO_DIR}/node_modules/.modules.yaml`))).toBe("installed\n");
		expect(await fileIn(second.id, "README.md")).toBe("# Env, later\n");
		expect(decoder.decode(await workspace.readFile(`${REPO_DIR}/.git/origin`))).toBe(remote);
		expect(await fileIn(second.id, ".git/branch")).toBe(status.repo.branch);
		expect(status.repo.baseSha).toBe("base0000");
		expect((await second.stub.log()).map((event) => event.kind)).toContain("environment.restored");
		// Another person's thread of the same repository finds none of it, and builds its own.
		const other = await startThread({ repo });
		await turns(other.id, 1);
		const theirs = (await other.stub.status()).environment;
		expect(theirs).toMatchObject({ state: "cached", restoredFromKey: null });
		expect(theirs.key).not.toBe(key);
		expect(setups.map((each) => each.space)).toEqual([space, `space-${other.id}`]);
	});

	it("goes on without one when the setup script fails, keeping only the end of what it printed", async () => {
		const { repo, fullName } = envRepo();
		setup = async () => ({ stderr: `\u001b[31m${"x".repeat(5000)}\u0007\nERR_PNPM_OUTDATED_LOCKFILE\u001b[0m\n`, code: 1 });
		codingFaux.setResponses([fauxAssistantMessage("Went on without it.")]);
		const { id, stub, input } = await startThread({ repo });
		expect((await turns(id, 1))[0]!.outcome).toBe("completed");
		const { environment } = await stub.status();
		expect(environment).toMatchObject({ state: "failed", setupMs: expect.any(Number), snapshotMs: null, builtAt: null });
		expect(environment.error).toMatch(/^The setup script exited 1: …x+\nERR_PNPM_OUTDATED_LOCKFILE$/);
		expect(environment.error!.length).toBeLessThanOrEqual(500);
		expect(environment.error).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
		expect(await codingWorkspaces.listEnvironments({ userId: input.space, repo: fullName })).toEqual([]);
		expect((await stub.log()).find((event) => event.kind === "environment.failed")?.data).toMatchObject({ error: environment.error });
	});

	it("keeps a snapshot only when restoring it is expected to be quicker than the setup was", () => {
		// 8 MB a second by default: 400 MB takes 50 s to restore.
		expect(estimatedRestoreMs(400_000_000)).toBe(50_000);
		// A provider that restores 4 times as fast keeps what the default would delete, and one that is slower deletes what it would keep.
		expect(estimatedRestoreMs(400_000_000, 32)).toBe(12_500);
		expect(snapshotWorthKeeping(20_000, 400_000_000)).toBe(false);
		expect(snapshotWorthKeeping(20_000, 400_000_000, 32)).toBe(true);
		expect(snapshotWorthKeeping(12_500, 400_000_000, 32)).toBe(false);
		expect(snapshotWorthKeeping(60_000, 400_000_000, 2)).toBe(false);
		expect(snapshotWorthKeeping(60_000, 400_000_000, 8)).toBe(true);
		expect(new FakeWorkspaceProvider().capabilities.restoreMBps).toBe(8);
		expect(new FakeWorkspaceProvider({ restoreMBps: 50 }).capabilities.restoreMBps).toBe(50);
		expect(snapshotWorthKeeping(50_001, 400_000_000)).toBe(true);
		expect(snapshotWorthKeeping(50_000, 400_000_000)).toBe(false);
		expect(snapshotWorthKeeping(10_000, 355_000_000)).toBe(false);
		// However long the setup, a restore that would take longer isn't kept.
		expect(snapshotWorthKeeping(120_000, 4_000_000_000)).toBe(false);
		expect(snapshotWorthKeeping(500_001, 4_000_000_000)).toBe(true);
		// A backend that doesn't say how big it is keeps it, as before.
		expect(snapshotWorthKeeping(0, null)).toBe(true);
	});

	it("deletes a snapshot that would restore slower than the setup ran, and the person's next threads set up again without taking one", async () => {
		const { repo, fullName } = envRepo();
		const space = `space-${crypto.randomUUID()}`;
		const taken = vi.spyOn(codingWorkspaces, "snapshotEnvironment");
		// An older environment of the repository, which the first thread starts from as a guess.
		const stale = "e".repeat(64);
		codingWorkspaces.environments.set(`${space}\0${stale}`, { userId: space, repo: fullName, key: stale, createdAt: 1, lastUsedAt: 1, nodes: new Map([["/workspace", { type: "dir", mode: 0o755, mtimeMs: 1 }]]) });
		// 1 GB: about 2 minutes to restore, where the fake setup takes a moment.
		codingWorkspaces.environmentSize = 1_000_000_000;
		try {
			codingFaux.setResponses([fauxAssistantMessage("First."), fauxAssistantMessage("Second.")]);
			const first = await startThread({ repo, space });
			await turns(first.id, 1);
			const built = (await first.stub.status()).environment;
			expect(built).toMatchObject({ state: "cached", readyFrom: "setup", snapshotKept: false, snapshotBytes: 1_000_000_000, builtAt: null, snapshotMs: expect.any(Number), restoredFromKey: stale });
			// Neither its own snapshot nor the older one stays.
			expect(snapshotsOf(space)).toEqual([]);
			expect(taken).toHaveBeenCalledTimes(1);
			expect((await first.stub.log()).find((event) => event.kind === "environment.built")?.data).toMatchObject({ key: built.key, snapshotKept: false });
			// The next thread clones, runs the setup (cheap from the warm dependency cache) and takes no snapshot.
			const clones = fakeClones.length;
			const second = await startThread({ repo, space });
			await turns(second.id, 1);
			expect((await second.stub.status()).environment).toMatchObject({ state: "cached", key: built.key, readyFrom: "setup", snapshotKept: false, snapshotMs: null, snapshotBytes: null, restoredFromKey: null });
			expect(fakeClones.length).toBe(clones + 1);
			expect(setups.map((each) => each.space)).toEqual([space, space]);
			expect(taken).toHaveBeenCalledTimes(1);
			// A rebuild takes one and decides again: of a size the backend doesn't say, it is kept.
			codingWorkspaces.environmentSize = undefined;
			await second.stub.rebuildEnvironment();
			const rebuilt = await vi.waitFor(
				async () => {
					const { environment } = await second.stub.status();
					expect(environment).toMatchObject({ state: "cached", rebuildRequested: false, snapshotKept: true });
					return environment;
				},
				{ timeout: 10_000, interval: 50 },
			);
			expect(rebuilt.snapshotBytes).toBeNull();
			expect(taken).toHaveBeenCalledTimes(2);
			expect(snapshotsOf(space).map((saved) => [saved.repo, saved.key])).toEqual([[fullName, built.key]]);
		} finally {
			codingWorkspaces.environmentSize = undefined;
			taken.mockRestore();
		}
	});

	it("runs the highest setup source there is: the setting, .pim/setup.sh, a mise task, a dev container's commands", async () => {
		const MISE = '[tasks.setup]\nrun = "pnpm install"\n';
		const DEVCONTAINER = '{ // comments are allowed\n "postCreateCommand": "pnpm install",\n "onCreateCommand": ["echo", "hi there"] }\n';
		const ran = async (files: Record<string, string>, drop: string[] = [], space = `space-${crypto.randomUUID()}`) => {
			const { repo, remote } = envRepo(files);
			for (const path of drop) delete fakeRemotes.get(remote)![path];
			setups.length = 0;
			codingFaux.setResponses([fauxAssistantMessage("Ok.")]);
			const { id, stub } = await startThread({ repo, space });
			await turns(id, 1);
			const environment = await settledEnvironment(stub);
			return { environment, bash: setups.map((each) => each.argv[2]) };
		};
		const all = { "mise.toml": MISE, ".devcontainer/devcontainer.json": DEVCONTAINER };
		const repository = await ran(all);
		expect(repository.environment.source).toBe("repository");
		expect(repository.bash).toContain(SCRIPT);
		const mise = await ran(all, [".pim/setup.sh"]);
		expect(mise.environment.source).toBe("mise");
		expect(mise.bash).toContain("mise trust --yes --quiet && mise run setup");
		expect(mise.bash.join()).not.toContain("hi there");
		const devcontainer = await ran({ ".devcontainer/devcontainer.json": DEVCONTAINER }, [".pim/setup.sh"]);
		expect(devcontainer.environment.source).toBe("devcontainer");
		expect(devcontainer.bash).toContain("set -e\necho 'hi there'\n(\npnpm install\n)\n");
		// A setting beats them all.
		const space = `space-${crypto.randomUUID()}`;
		const { repo, fullName } = envRepo(all);
		await codingScheduler(env, space).setRepoSettings(fullName, { setupScript: "echo setting\n" });
		codingFaux.setResponses([fauxAssistantMessage("Ok.")]);
		const { id, stub } = await startThread({ repo, space });
		await turns(id, 1);
		expect((await settledEnvironment(stub)).source).toBe("settings");
		// The source and what defines it are in the key.
		expect(new Set([repository, mise, devcontainer].map((each) => each.environment.key)).size).toBe(3);
	});

	it("clones as usual when the snapshot can't be restored, and builds it again", async () => {
		const { repo } = envRepo();
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("First."), fauxAssistantMessage("Second.")]);
		const first = await startThread({ repo, space });
		await turns(first.id, 1);
		const { key } = (await first.stub.status()).environment;
		snapshotsOf(space)[0]!.corrupt = true;
		const clones = fakeClones.length;
		const second = await startThread({ repo, space });
		expect((await turns(second.id, 1))[0]!.outcome).toBe("completed");
		expect((await second.stub.status()).environment).toMatchObject({ state: "cached", key, restoredFromKey: null });
		expect(fakeClones.length).toBe(clones + 1);
		expect(setups).toHaveLength(2);
		expect((await second.stub.log()).find((event) => event.kind === "environment.restore_failed")?.data).toMatchObject({ key });
		expect(snapshotsOf(space).map((saved) => [saved.key, saved.corrupt])).toEqual([[key, undefined]]);
	});

	it("is built once when two of the person's threads need it together: the other waits for it and restores it", async () => {
		const { repo } = envRepo();
		const space = `space-${crypto.randomUUID()}`;
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		setup = async (context) => {
			await Promise.race([gate, context.killed]);
			return install(context);
		};
		codingFaux.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
		const threads = [await startThread({ repo, space }), await startThread({ repo, space })];
		await vi.waitFor(() => expect(setups).toHaveLength(1), { timeout: 10_000, interval: 20 });
		// One runs the script; the other waits for it, building too as far as anyone can tell.
		await vi.waitFor(async () => expect(await Promise.all(threads.map(async ({ stub }) => (await stub.status()).environment.state))).toEqual(["building", "building"]), { timeout: 10_000, interval: 20 });
		release();
		for (const { id } of threads) await turns(id, 1);
		const environments = await Promise.all(threads.map(async ({ stub }) => (await stub.status()).environment));
		expect(setups).toHaveLength(1);
		const key = environments[0]!.key;
		expect(environments.map((each) => [each.state, each.key])).toEqual([
			["cached", key],
			["cached", key],
		]);
		expect(environments.map((each) => each.restoredFromKey).sort()).toEqual([key, null].sort());
		expect(snapshotsOf(space)).toHaveLength(1);
		// The one that waited has a workspace made from the snapshot, on its own branch.
		for (const { id, stub } of threads) {
			const status = await stub.status();
			expect(await fileIn(id, ".git/branch")).toBe(status.repo.branch);
			expect(status.repo.baseSha).toBe("base0000");
			expect(await fileIn(id, "node_modules/.modules.yaml")).toBe("installed\n");
		}
	});

	it("is rebuilt on request: its snapshot deleted, the script run again in the thread's workspace, and a new snapshot kept", async () => {
		const { repo } = envRepo();
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("Ready.")]);
		const { id, stub } = await startThread({ repo, space });
		await turns(id, 1);
		const before = (await stub.status()).environment;
		const workspace = (await codingWorkspaces.list({ sessionId: id }))[0]!.ref.id;
		const deleted = vi.spyOn(codingWorkspaces, "deleteEnvironment");
		setup = async ({ cwd, workspace: ws }) => {
			await ws.writeFile(`${cwd}/node_modules/.modules.yaml`, encoder.encode("reinstalled\n"));
			return {};
		};
		expect(await stub.rebuildEnvironment()).toMatchObject({ state: "building", rebuildRequested: true });
		expect(deleted).toHaveBeenCalledWith(space, before.key);
		deleted.mockRestore();
		const after = await settledEnvironment(stub);
		expect(after).toMatchObject({ state: "cached", key: before.key, rebuildRequested: false });
		// In the same workspace, between turns, with no turn of its own.
		expect(setups).toHaveLength(2);
		expect((await codingWorkspaces.list({ sessionId: id }))[0]!.ref.id).toBe(workspace);
		expect(await stub.status()).toMatchObject({ state: "idle", slot: "held", currentOperation: null });
		const [saved] = snapshotsOf(space);
		expect(decoder.decode((saved!.nodes.get(`${REPO_DIR}/node_modules/.modules.yaml`) as { data: Uint8Array }).data)).toBe("reinstalled\n");
		expect((await stub.log()).filter((event) => event.kind === "environment.built")).toHaveLength(2);
	});

	it("is none for a repository without a setup script, which works as before", async () => {
		codingFaux.setResponses([fauxAssistantMessage("Nothing to set up.")]);
		const { id, stub, input } = await startThread();
		await turns(id, 1);
		expect((await stub.status()).environment).toMatchObject({ state: "none", key: null, source: null, restoredFromKey: null, preparedAt: expect.any(Number) });
		expect(setups).toEqual([]);
		expect(snapshotsOf(input.space)).toEqual([]);
	});

	it("starts with a freshly rebuilt environment when rebuildEnvironment is true", async () => {
		const { repo, fullName } = envRepo();
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("Ready.")]);
		const { id, stub } = await startThread({ repo, space, rebuildEnvironment: true });
		await turns(id, 1);
		const status = await stub.status();
		// When rebuildEnvironment is true, the rebuild path in #prepareEnvironment runs: skip restore, run setup, ignore existing snapshot
		// After the environment is prepared, rebuildRequested is cleared, but it was built from setup
		expect(status.environment.state).toBe("cached");
		expect(status.environment.readyFrom).toBe("setup");
		// It should not have restored from a snapshot
		expect(status.environment.restoredFromKey).toBeNull();
		expect(status.environment.rebuildRequested).toBe(false);
	});

	it("starts with cached environment when rebuildEnvironment is false or not set", async () => {
		const { repo, fullName } = envRepo();
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("Ready.")]);
		// First thread creates a snapshot
		const { id: firstId, stub: firstStub } = await startThread({ repo, space });
		await turns(firstId, 1);
		const firstStatus = await firstStub.status();
		const key = firstStatus.environment.key;
		expect(key).not.toBeNull();
		// Second thread with rebuildEnvironment false/undefined should use the cached snapshot
		codingFaux.setResponses([fauxAssistantMessage("Ready.")]);
		const { id: secondId, stub: secondStub } = await startThread({ repo, space, rebuildEnvironment: false });
		await turns(secondId, 1);
		const secondStatus = await secondStub.status();
		// Should have restored from the first thread's snapshot
		expect(secondStatus.environment.restoredFromKey).toBe(key);
		expect(secondStatus.environment.readyFrom).toBe("snapshot");
		expect(secondStatus.environment.rebuildRequested).toBe(false);
	});

	/** A repository of its own for the test with `files` and no setup script, as most repositories are. */
	function toolRepo(files: Record<string, string>) {
		const name = `Tools-${crypto.randomUUID().slice(0, 8)}`;
		fakeRemotes.set(`https://pim.test/api/coding/git/Acme/${name}.git`, files);
		return { repo: `https://github.com/Acme/${name}`, fullName: `acme/${name.toLowerCase()}` };
	}
	const scriptsRun = () => setups.map((each) => each.argv[2]!.replace(/^export PATH=.*\n/, ""));

	it("provisions what a Go repository pins without a setup script, tells the agent how it checks itself, and starts the next thread from the snapshot", async () => {
		const { repo } = toolRepo(GO_REPO);
		const space = `space-${crypto.randomUUID()}`;
		let prompt = "";
		codingFaux.setResponses([
			(context) => {
				prompt = sent(context);
				return fauxAssistantMessage("Ready.");
			},
			fauxAssistantMessage("Again."),
		]);
		const first = await startThread({ repo, space });
		await turns(first.id, 1);
		// Go from go.mod's toolchain directive with mise, then its modules, each with bash in the checkout and mise's shims on the PATH.
		expect(scriptsRun()).toEqual([installed("go@1.22.5"), "go mod download"]);
		expect(setups[0]).toMatchObject({ argv: ["bash", "-c", expect.stringMatching(/^export PATH="\$HOME\/\.local\/share\/mise\/shims:\$PATH"\n/)], cwd: REPO_DIR, env: { ...SETUP_ENV, ...PROVISION_ENV } });
		const { environment } = await first.stub.status();
		expect(environment).toMatchObject({ state: "cached", source: null, readyFrom: "setup", snapshotKept: true });
		expect(environment.error).toBeUndefined();
		expect(environment.toolchains).toEqual([{ tool: "go", version: "1.22.5", source: "manifest", from: "go.mod", status: "installed" }]);
		expect(environment.dependencies).toEqual([{ tool: "go", command: "go mod download", from: "go.sum", status: "installed" }]);
		expect(environment.testCommands.map((each) => each.command)).toEqual(["make test", "make lint", "go vet ./...", "go test -race -count=1 ./..."]);
		expect(environment.notes).toEqual([expect.stringContaining("starts the services postgres, redis"), "detected: go 1.22.5, installing with go mod download"]);
		expect(snapshotsOf(space)).toHaveLength(1);
		// The agent was told before its first turn: its toolchain, and the commands to check its work with.
		expect(prompt).toContain("go 1.22.5 (from go.mod)");
		expect(prompt).toContain("- `make test` (Makefile)");
		expect(cliInstructions({ repoUrl: repo, branch: "b", baseRef: "main", environment })).toContain("- `go vet ./...` (.github/workflows/ci.yml)");

		// The next thread starts from the snapshot: nothing runs, and what it has came with it.
		const second = await startThread({ repo, space });
		await turns(second.id, 1);
		const restored = (await second.stub.status()).environment;
		expect(restored).toMatchObject({ state: "cached", key: environment.key, readyFrom: "snapshot" });
		expect(restored.toolchains.map((each) => each.status)).toEqual(["cached"]);
		expect(restored.dependencies.map((each) => each.status)).toEqual(["cached"]);
		expect(restored.testCommands).toEqual(environment.testCommands);
		expect(setups).toHaveLength(2);
	});

	it("records a provisioning step that fails and goes on, skipping what needs it, keeping no snapshot, and trying again on the next thread", async () => {
		const { repo, fullName } = toolRepo(GO_REPO);
		const space = `space-${crypto.randomUUID()}`;
		setup = async ({ argv }) => (argv[2]!.includes("mise use") ? { stderr: "mise ERROR failed to install core:go@1.22.5: error sending request for url (https://dl.google.com/go/go1.22.5.linux-amd64.tar.gz)\n", code: 1 } : {});
		let prompt = "";
		codingFaux.setResponses([
			(context) => {
				prompt = sent(context);
				return fauxAssistantMessage("Went on.");
			},
			fauxAssistantMessage("Second."),
		]);
		const first = await startThread({ repo, space });
		expect((await turns(first.id, 1))[0]!.outcome).toBe("completed");
		const { environment } = await first.stub.status();
		// The thread went on in its workspace as it was, and says what failed and why.
		expect(environment).toMatchObject({ state: "cached", readyFrom: "setup", snapshotKept: false, builtAt: null });
		expect(environment.error).toBeUndefined();
		expect(environment.toolchains).toEqual([expect.objectContaining({ tool: "go", status: "failed", error: expect.stringMatching(/^`mise use --global --yes go@1\.22\.5 && .*` exited 1: mise ERROR failed to install core:go@1\.22\.5/) })]);
		expect(environment.dependencies).toEqual([expect.objectContaining({ command: "go mod download", status: "skipped" })]);
		expect(scriptsRun()).toEqual([installed("go@1.22.5")]);
		expect(await codingWorkspaces.listEnvironments({ userId: space, repo: fullName })).toEqual([]);
		expect((await first.stub.log()).find((event) => event.kind === "environment.provision_failed")?.data).toMatchObject({ step: "toolchain:go" });
		expect(prompt).toContain("go 1.22.5 (from go.mod) failed while the workspace was set up");
		expect(prompt).toContain("`go mod download` (from go.sum) wasn't run");

		// Once the network is back, the next thread provisions it all and keeps the snapshot.
		setup = install;
		const second = await startThread({ repo, space });
		await turns(second.id, 1);
		const retried = (await second.stub.status()).environment;
		expect(retried).toMatchObject({ key: environment.key, readyFrom: "setup", snapshotKept: true });
		expect(retried.toolchains.map((each) => each.status)).toEqual(["installed"]);
		expect(scriptsRun()).toEqual([installed("go@1.22.5"), installed("go@1.22.5"), "go mod download"]);
	});

	it("installs a mise repository's tools before its own setup script, and keys the environment by both", async () => {
		const { repo, fullName } = toolRepo({ ...MISE_REPO, ".pim/setup.sh": SCRIPT });
		const space = `space-${crypto.randomUUID()}`;
		codingFaux.setResponses([fauxAssistantMessage("Ready.")]);
		const { id, stub } = await startThread({ repo, space });
		await turns(id, 1);
		expect(scriptsRun()).toEqual(["mise trust --yes --quiet && mise install --yes", installed("python@3.12"), SCRIPT]);
		const { environment } = await stub.status();
		expect(environment).toMatchObject({ state: "cached", source: "repository" });
		expect(environment.toolchains.map(({ tool, source, status }) => `${tool}:${source}:${status}`)).toEqual(["go:mise:installed", "node:mise:installed", "npm:prettier:mise:installed", "python:devcontainer:installed"]);
		const key = await environmentKey({ userId: space, repo: fullName, provision: ["mise trust --yes --quiet && mise install --yes", installed("python@3.12")], setupScript: SCRIPT, setupSource: "repository", lockfiles: { "mise.toml": await sha256(MISE_REPO["mise.toml"]!) }, image: DEFAULT_WORKSPACE_IMAGE });
		expect(environment.key).toBe(key);
	});
});
