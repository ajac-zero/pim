import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkCompute,
	codingBackendIds,
	type ComputeQuota,
	computeProviderInfo,
	NO_CODING_SANDBOX_LINE,
	prepareComputeProvider,
	withoutSecrets,
} from "../src/compute";
import { workspaceBackends } from "../src/coding/workspace/registry";
import type { Pim } from "../src/pim";
import { OWNER, ROOT, say, toolUse } from "./helpers";
import { faux } from "./worker";

// Compute providers the admin sets up for everyone's coding sandboxes: their secrets, the quotas on each person, the minutes
// they've run, and the coding tools that appear only while some provider can run a thread. The admin's routes and a real
// coding thread meeting its quota are tested with the people (test/people.test.ts) and the coding API (test/coding-api.test.ts).

const MINUTE = 60_000;
const NOV = Date.UTC(2026, 10, 10, 12, 0, 0);
const UNLIMITED: ComputeQuota = { maxConcurrentWorkspaces: null, monthlySandboxMinutes: null, maxSessionMinutes: null };
const TOKEN = "manager-token-4f9a1c";
const MANAGER = "https://manager.example.test";

const manager = (input: Record<string, unknown> = {}) =>
	prepareComputeProvider({ kind: "compose", settings: { managerUrl: MANAGER }, credentials: { token: TOKEN }, ...input }, null);

/** A Gallery of its own, so the minutes and providers of one test are not another's. */
const gallery = () => env.Gallery.getByName(`compute-${crypto.randomUUID()}`);

afterEach(() => {
	vi.unstubAllGlobals();
	expect(faux.getPendingResponseCount()).toBe(0);
});

describe("a compute provider's secrets", () => {
	it("are kept apart from what the API shows: only that a credential is set", () => {
		const provider = manager();
		expect(provider.credentials.token).toBe(TOKEN);
		const shown = computeProviderInfo(provider);
		expect(shown).toMatchObject({ id: "compose", kind: "compose", codingSandbox: true, agentComputer: false, settings: { managerUrl: MANAGER }, credentialsSet: { token: true } });
		expect(JSON.stringify(shown)).not.toContain(TOKEN);
		expect(shown).not.toHaveProperty("credentials");
		// With none set it says so, and a provider that needs none has nothing to show.
		expect(computeProviderInfo({ ...provider, credentials: {} }).credentialsSet).toEqual({ token: false });
		expect(computeProviderInfo(prepareComputeProvider({ kind: "cloudflare-sandbox" }, null)).credentialsSet).toEqual({});
	});

	it("stay when a change leaves them out, change when given, and go when emptied", () => {
		const provider = manager();
		expect(prepareComputeProvider({ name: "Team sandboxes", codingSandbox: false }, provider)).toMatchObject({ name: "Team sandboxes", codingSandbox: false, credentials: { token: TOKEN } });
		expect(prepareComputeProvider({ credentials: { token: "rotated-token-77" } }, provider).credentials).toEqual({ token: "rotated-token-77" });
		expect(() => prepareComputeProvider({ credentials: { token: "" } }, provider)).toThrow(/needs token/);
	});

	it("take a manager address that is http(s) and has no login in it", () => {
		for (const managerUrl of ["https://user:pass@manager.example.test", "ftp://manager.example.test", "manager.example.test"]) {
			expect(() => manager({ settings: { managerUrl } }), managerUrl).toThrow(/managerUrl must/);
		}
	});

	it("are required, and only for the fields a kind has", () => {
		expect(() => prepareComputeProvider({ kind: "compose", settings: { managerUrl: MANAGER } }, null)).toThrow(/needs token/);
		expect(() => prepareComputeProvider({ kind: "compose", credentials: { token: TOKEN } }, null)).toThrow(/needs managerUrl/);
		expect(() => prepareComputeProvider({ kind: "compose", settings: { managerUrl: MANAGER, token: TOKEN }, credentials: { token: TOKEN } }, null)).toThrow(/no token setting/);
		expect(() => prepareComputeProvider({ kind: "daytona" }, null)).toThrow(/kind must be one of/);
		expect(() => prepareComputeProvider({ kind: "cloudflare-sandbox", credentials: { apiKey: "x" } }, null)).toThrow(/no apiKey credential/);
		expect(() => prepareComputeProvider({ kind: "cloudflare-sandbox", codingSandbox: "yes" }, null)).toThrow(/true or false/);
		expect(() => prepareComputeProvider({ kind: "cloudflare-sandbox" }, prepareComputeProvider({ kind: "compose", settings: { managerUrl: MANAGER }, credentials: { token: TOKEN } }, null))).toThrow(/cannot be changed/);
	});

	it("never appear in a health check's answer, whether it passes or fails", async () => {
		const provider = manager();
		const seen: { url: string; authorization: string | null }[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			seen.push({ url: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
			if (request.url.endsWith("/health")) return Response.json({ maxConcurrent: 4, running: 1, free: 3, freeDiskPct: 60 });
			return Response.json([]);
		});
		const healthy = await checkCompute(provider, env);
		expect(healthy).toMatchObject({ ok: true, message: "Reachable: 1 of 4 workspaces running." });
		// One cheap read, with the token, and the health page.
		expect(seen).toEqual([
			{ url: "/sessions", authorization: `Bearer ${TOKEN}` },
			{ url: "/health", authorization: null },
		]);

		// A library error that quotes the token is scrubbed before anyone sees it.
		vi.stubGlobal("fetch", async () => Response.json({ error: `bad credentials ${TOKEN}` }, { status: 401 }));
		const down = await checkCompute(provider, env);
		expect(down.ok).toBe(false);
		expect(down.message).toMatch(/bad credentials/);
		expect(JSON.stringify(down)).not.toContain(TOKEN);
		expect(withoutSecrets(`bad ${TOKEN}`, provider)).toBe("bad [hidden]");

		// A Worker without the Sandbox binding says so rather than throwing.
		expect(await checkCompute(prepareComputeProvider({ kind: "cloudflare-sandbox" }, null), {})).toMatchObject({ ok: false, message: expect.stringContaining("no WorkspaceContainer and WorkspaceCatalog bindings") });
	});

	it("stay in the Gallery: the summaries a space reads have none", async () => {
		const store = gallery();
		await store.putComputeProvider(null, { kind: "compose", settings: { managerUrl: MANAGER }, credentials: { token: TOKEN } });
		expect(JSON.stringify(await store.computeSummaries())).not.toContain(TOKEN);
		expect(await store.computeSummaries()).toEqual([{ id: "compose", kind: "compose", codingSandbox: true, usable: true }]);
		expect((await store.computeProviders())[0]?.credentials).toEqual({ token: TOKEN });
		// One provider of each kind.
		const duplicate = await store.putComputeProvider(null, { kind: "compose", settings: { managerUrl: MANAGER }, credentials: { token: "x" } }).then(
			() => "added",
			(error: Error) => error.message,
		);
		expect(duplicate).toMatch(/already set up/);
		expect(await store.putComputeProvider("nope", { name: "x" })).toBeNull();
		expect(await store.removeComputeProvider("compose")).toBe(true);
		expect(await store.removeComputeProvider("compose")).toBe(false);
	});
});

describe("which backends coding threads have", () => {
	it("follow the configuration: a provider is added, and one switched off is taken out whichever way it was set up", () => {
		const configured = (codingSandbox: boolean, usable = true) => [{ id: "compose" as const, kind: "compose" as const, codingSandbox, usable }];
		expect(codingBackendIds([], [])).toEqual([]);
		expect(codingBackendIds(["cloudflare"], [])).toEqual(["cloudflare"]);
		expect(codingBackendIds([], configured(true))).toEqual(["compose"]);
		// The configured one comes first, and is not listed twice when the environment has it too.
		expect(codingBackendIds(["cloudflare", "compose"], configured(true))).toEqual(["compose", "cloudflare"]);
		expect(codingBackendIds(["compose"], configured(false))).toEqual([]);
		expect(codingBackendIds(["compose", "cloudflare"], configured(false))).toEqual(["cloudflare"]);
		// A provider this Worker can't make workspaces with offers nothing, and takes nothing from the environment.
		expect(codingBackendIds([], configured(true, false))).toEqual([]);
		expect(codingBackendIds(["compose"], configured(true, false))).toEqual(["compose"]);
	});

	it("are the registry's: a configured provider is the default, and one switched off is absent", () => {
		expect(workspaceBackends({}).ids()).toEqual([]);
		const on = workspaceBackends({}, [manager()]);
		expect(on.ids()).toEqual(["compose"]);
		expect(on.defaultId()).toBe("compose");
		expect(workspaceBackends({}, [manager({ codingSandbox: false })]).ids()).toEqual([]);
		// A provider whose settings can't be used leaves none, and says why without its token.
		const broken = workspaceBackends({}, [manager({ settings: { managerUrl: "http://public.example.test" } })]);
		expect(broken.ids()).toEqual([]);
		expect(() => broken.get("compose")).toThrow(/can't be used/);
		expect(() => broken.get("compose")).not.toThrow(TOKEN);
	});

	it("keep the sandbox manager first and Cloudflare Containers after it, as overflow, whoever set each up", () => {
		const containers = { WorkspaceContainer: { getByName: () => ({}) }, WorkspaceCatalog: { getByName: () => ({}) } };
		const environment = () => ({ PIM_CODING_MANAGER_URL: MANAGER, PIM_CODING_MANAGER_TOKEN: TOKEN, ...containers });
		const cloudflare = (codingSandbox: boolean) => prepareComputeProvider({ kind: "cloudflare-sandbox", codingSandbox }, null);
		// As deployed: the admin's Cloudflare provider is off, so threads have the manager alone.
		expect(workspaceBackends(environment(), [cloudflare(false)]).ids()).toEqual(["compose"]);
		// Switched on, it overflows from the manager rather than taking its place as the default.
		const on = workspaceBackends(environment(), [cloudflare(true)]);
		expect(on.ids()).toEqual(["compose", "cloudflare"]);
		expect(on.defaultId()).toBe("compose");
		expect(workspaceBackends(containers, [cloudflare(true), manager()]).ids()).toEqual(["compose", "cloudflare"]);
		// Where it is the only backend, it is the default.
		expect(workspaceBackends({ ...containers }, [cloudflare(true)]).defaultId()).toBe("cloudflare");
		expect(workspaceBackends(environment(), [cloudflare(true), manager({ codingSandbox: false })]).ids()).toEqual(["cloudflare"]);
	});
});

describe("quotas", () => {
	const begin = (store: ReturnType<typeof gallery>, thread: string, quota: Partial<ComputeQuota> | null, now: number, user = "ann", provider = "fake") =>
		store.computeBegin({ userId: user, threadId: thread, provider, quota: quota === null ? null : { ...UNLIMITED, ...quota }, now });

	it("refuse another workspace past the most running at once, until one stops, for that person only", async () => {
		const store = gallery();
		expect(await begin(store, "t1", { maxConcurrentWorkspaces: 2 }, NOV)).toEqual({ ok: true, wallClockMin: null, capAt: null });
		expect(await begin(store, "t2", { maxConcurrentWorkspaces: 2 }, NOV)).toMatchObject({ ok: true });
		const refused = await begin(store, "t3", { maxConcurrentWorkspaces: 2 }, NOV);
		expect(refused).toMatchObject({ ok: false, code: "concurrent" });
		expect(refused.ok === false && refused.message).toMatch(/already have 2 sandbox workspaces running.*\(2\)/);
		// Someone else has their own two, and a refused thread left nothing behind.
		expect(await begin(store, "b1", { maxConcurrentWorkspaces: 2 }, NOV, "bea")).toMatchObject({ ok: true });
		expect((await store.computeUsageOf("ann", NOV)).running).toBe(2);
		// A thread that is running already is let be, whatever the quota says now: its restart doesn't count it twice.
		expect(await begin(store, "t1", { maxConcurrentWorkspaces: 0 }, NOV + MINUTE)).toEqual({ ok: true, wallClockMin: null, capAt: null });
		expect((await store.computeUsageOf("ann", NOV)).running).toBe(2);
		expect(await store.computeEnd("t1", "suspend", NOV + MINUTE)).toBe(true);
		expect(await store.computeEnd("t1", "suspend", NOV + MINUTE)).toBe(false);
		expect(await begin(store, "t3", { maxConcurrentWorkspaces: 2 }, NOV + MINUTE)).toMatchObject({ ok: true });
	});

	it("refuse past the month's minutes, give a workspace only the minutes left, and start again with the next month", async () => {
		const store = gallery();
		const quota = { monthlySandboxMinutes: 60, maxSessionMinutes: 45 };
		// The first session is held to 45 minutes; it runs 40.
		expect(await begin(store, "t1", quota, NOV)).toEqual({ ok: true, wallClockMin: 45, capAt: NOV + 45 * MINUTE });
		await store.computeEnd("t1", "stop", NOV + 40 * MINUTE);
		// 20 are left, which is less than a session.
		expect(await begin(store, "t2", quota, NOV + 41 * MINUTE)).toEqual({ ok: true, wallClockMin: 20, capAt: NOV + 61 * MINUTE });
		await store.computeEnd("t2", "stop", NOV + 61 * MINUTE);
		const spent = await begin(store, "t3", quota, NOV + 62 * MINUTE);
		expect(spent).toMatchObject({ ok: false, code: "monthly" });
		expect(spent.ok === false && spent.message).toMatch(/used your 60 sandbox minutes for 2026-11 \(60 used\).*reset/);
		// The reset is the calendar: on the 1st the new month starts at zero, and the old one stays in the history.
		const december = Date.UTC(2026, 11, 1, 0, 5);
		expect(await begin(store, "t4", quota, december)).toEqual({ ok: true, wallClockMin: 45, capAt: december + 45 * MINUTE });
		const usage = await store.computeUsageOf("ann", december);
		expect(usage).toMatchObject({ month: "2026-12", minutes: 0, running: 1 });
		expect(usage.history.at(-1)).toEqual({ month: "2026-12", minutes: 0 });
		expect(usage.history.at(-2)).toEqual({ month: "2026-11", minutes: 60 });
		expect(usage.history).toHaveLength(12);
	});

	it("count a session that crosses midnight on the 1st toward each month by when it ran", async () => {
		const store = gallery();
		const lateOctober = Date.UTC(2026, 9, 31, 23, 40);
		await begin(store, "t1", null, lateOctober);
		await store.computeEnd("t1", "stop", Date.UTC(2026, 10, 1, 0, 20));
		const november = await store.computeUsageOf("ann", Date.UTC(2026, 10, 1, 1, 0));
		expect(november.minutes).toBe(20);
		expect(november.history.slice(-2)).toEqual([
			{ month: "2026-10", minutes: 20 },
			{ month: "2026-11", minutes: 20 },
		]);
	});

	it("refuse when the session limit is 0, and go on counting a workspace past its session limit until it is ended", async () => {
		const store = gallery();
		expect(await begin(store, "t1", { maxSessionMinutes: 0 }, NOV)).toMatchObject({ ok: false, code: "session" });
		// The limit says when the thread must stop the workspace; until it has, the workspace is running and counts, so a limit nothing enforced is no way round the others.
		expect(await begin(store, "t2", { maxSessionMinutes: 30, maxConcurrentWorkspaces: 1 }, NOV)).toEqual({ ok: true, wallClockMin: 30, capAt: NOV + 30 * MINUTE });
		expect(await store.computeOpen("t2")).toEqual({ capAt: NOV + 30 * MINUTE });
		const later = NOV + 3 * 60 * MINUTE;
		expect(await store.computeUsageOf("ann", later)).toMatchObject({ running: 1, minutes: 180 });
		expect(await begin(store, "t3", { maxConcurrentWorkspaces: 1 }, later)).toMatchObject({ ok: false, code: "concurrent" });
		// Ended, it stops counting; a thread that lost track of it ends it as lost.
		expect(await store.computeEnd("t2", "lost", later)).toBe(true);
		expect(await store.computeOpen("t2")).toBeNull();
		expect(await begin(store, "t3", { maxConcurrentWorkspaces: 1 }, later)).toMatchObject({ ok: true });
	});

	it("starts with no limits, and ends the stretches of threads that aren't kept", async () => {
		const store = gallery();
		expect(await store.computeQuota()).toEqual(UNLIMITED);
		await begin(store, "login:a:claude-code", null, NOV);
		await begin(store, "login:a:codex", null, NOV);
		await begin(store, "login:b:codex", null, NOV);
		expect(await store.computeEndExcept("login:a:", ["login:a:codex"], "lost", NOV + MINUTE)).toBe(1);
		expect(await store.computeOpen("login:a:claude-code")).toBeNull();
		expect(await store.computeOpen("login:a:codex")).not.toBeNull();
		expect(await store.computeOpen("login:b:codex")).not.toBeNull();
	});
});

describe("usage", () => {
	it("is recorded by provider from start, suspend and stop, for a person and for the admin's totals", async () => {
		const store = gallery();
		const start = (thread: string, user: string, provider: string, at: number) => store.computeBegin({ userId: user, threadId: thread, provider, quota: null, now: at });
		await start("a1", "ann", "cloudflare", NOV);
		await store.computeEnd("a1", "suspend", NOV + 10 * MINUTE);
		await start("a1", "ann", "cloudflare", NOV + 20 * MINUTE);
		await store.computeEnd("a1", "stop", NOV + 25 * MINUTE);
		await start("a2", "ann", "compose", NOV);
		await store.computeEnd("a2", "lost", NOV + 3 * MINUTE);
		await start("b1", "bea", "compose", NOV);
		const at = NOV + 30 * MINUTE;
		const ann = await store.computeUsageOf("ann", at);
		expect(ann).toMatchObject({ month: "2026-11", minutes: 18, running: 0 });
		expect(ann.byProvider).toEqual([
			{ provider: "cloudflare", minutes: 15, running: 0 },
			{ provider: "compose", minutes: 3, running: 0 },
		]);
		// Bea's workspace is still running, so it counts up to now.
		expect(await store.computeUsageOf("bea", at)).toMatchObject({ minutes: 30, running: 1, byProvider: [{ provider: "compose", minutes: 30, running: 1 }] });
		const everyone = await store.computeUsage(at);
		expect(everyone).toMatchObject({ month: "2026-11", minutes: 48, running: 1 });
		expect(everyone.byProvider).toEqual([
			{ provider: "compose", minutes: 33, running: 1 },
			{ provider: "cloudflare", minutes: 15, running: 0 },
		]);
		expect(everyone.top).toEqual([
			{ userId: "bea", minutes: 30, running: 1 },
			{ userId: "ann", minutes: 18, running: 0 },
		]);
		// A workspace still running carries into the next month, as it runs; ended, nothing does, and nobody else's minutes are in a person's.
		expect(await store.computeUsage(Date.UTC(2026, 11, 20))).toMatchObject({ month: "2026-12", running: 1 });
		await store.computeEnd("b1", "stop", at);
		expect(await store.computeUsage(Date.UTC(2026, 11, 20))).toMatchObject({ month: "2026-12", minutes: 0, byProvider: [], top: [] });
		expect((await store.computeUsageOf("nobody", at)).minutes).toBe(0);
	});
});

describe("moving a workspace to a new session", () => {
	const concurrentOne: ComputeQuota = { maxConcurrentWorkspaces: 1, monthlySandboxMinutes: null, maxSessionMinutes: 10 };
	const rows = (store: ReturnType<typeof gallery>, thread: string) =>
		runInDurableObject(store, (_instance: unknown, state: DurableObjectState) =>
			state.storage.sql.exec("SELECT started_at, ended_at, end_reason, cap_at FROM compute_usage WHERE thread_id = ? ORDER BY id", thread).toArray(),
		);

	it("ends one stretch and begins the next in one step, so the person's only slot is theirs to keep, with the limit carried over", async () => {
		const store = gallery();
		const first = await store.computeBegin({ userId: "ann", threadId: "m1", provider: "compose", quota: concurrentOne, now: NOV });
		expect(first).toMatchObject({ ok: true, capAt: NOV + 10 * MINUTE });
		// A plain begin for another thread is refused while the slot is taken; the renewal of the first isn't, and it keeps its end time.
		expect(await store.computeBegin({ userId: "ann", threadId: "m2", provider: "compose", quota: concurrentOne, now: NOV + MINUTE })).toMatchObject({ ok: false, code: "concurrent" });
		const renewed = await store.computeRenew({ userId: "ann", threadId: "m1", provider: "compose", quota: concurrentOne, now: NOV + 4 * MINUTE });
		expect(renewed).toEqual({ ok: true, wallClockMin: 6, capAt: NOV + 10 * MINUTE });
		expect(await rows(store, "m1")).toEqual([
			{ started_at: NOV, ended_at: NOV + 4 * MINUTE, end_reason: "suspend", cap_at: NOV + 10 * MINUTE },
			{ started_at: NOV + 4 * MINUTE, ended_at: null, end_reason: null, cap_at: NOV + 10 * MINUTE },
		]);
		expect((await store.computeUsageOf("ann", NOV + 5 * MINUTE)).running).toBe(1);
		// Continuing the thread later begins afresh, with a limit of its own.
		await store.computeEnd("m1", "stop", NOV + 8 * MINUTE);
		expect(await store.computeBegin({ userId: "ann", threadId: "m1", provider: "compose", quota: concurrentOne, now: NOV + 20 * MINUTE })).toMatchObject({ capAt: NOV + 30 * MINUTE });
	});

	it("leaves the old stretch ended when the quota refuses the new one", async () => {
		const store = gallery();
		await store.computeBegin({ userId: "bea", threadId: "r1", provider: "compose", quota: null, now: NOV });
		const refused = await store.computeRenew({ userId: "bea", threadId: "r1", provider: "compose", quota: { ...UNLIMITED, monthlySandboxMinutes: 5 }, now: NOV + 6 * MINUTE });
		expect(refused).toMatchObject({ ok: false, code: "monthly" });
		expect(await rows(store, "r1")).toEqual([{ started_at: NOV, ended_at: NOV + 6 * MINUTE, end_reason: "suspend", cap_at: null }]);
	});
});

describe("coding tools", () => {
	const offered = ({ messages }: { messages: Message[] }) => {
		const tools = new Set<string>();
		for (const message of messages) {
			if (message.role !== "system") continue;
			for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
			for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		}
		return [...tools];
	};

	/** The prompt section's text as the model reads it now: the system messages replayed in order. */
	const sectionNow = ({ messages }: { messages: Message[] }, name: string) => {
		let text: string | null | undefined;
		for (const message of messages) if (message.role === "system" && message.sections && name in message.sections) text = message.sections[name];
		return text ?? null;
	};

	/** What the model of the next turn is offered, and what it reads about coding. */
	async function turn() {
		let seen: { tools: string[]; line: string | null } | undefined;
		faux.setResponses([
			(context) => {
				seen = { tools: offered(context), line: sectionNow(context, "coding_unavailable") };
				return toolUse("send_to_user", { message: "ok" });
			},
		]);
		await say("Hello", ROOT);
		return seen!;
	}

	const space = <T>(work: (pim: Pim) => T | Promise<T>) => runInDurableObject(env.Pim.getByName(OWNER), (pim: Pim) => work(pim));
	const shared = env.Gallery.getByName("gallery");

	it("are offered only while a provider can run a thread, and the prompt says one line about it when none can", async () => {
		const names = (tools: string[]) => tools.filter((name) => name.startsWith("coding_"));
		// The tests' own backend is the environment's: coding is on, and the prompt says nothing of it.
		const normal = await turn();
		expect(names(normal.tools)).toContain("coding_start");
		expect(normal.line).toBeNull();

		// With no backend the next turn has none of the coding tools, and the one line.
		await space((pim) => pim.store.setMeta("test:no-coding-backend", "1"));
		try {
			const without = await turn();
			expect(names(without.tools)).toEqual([]);
			expect(without.line).toContain(NO_CODING_SANDBOX_LINE);

			// The admin sets a provider up: the next turn has them again. No flag, no deploy.
			await shared.putComputeProvider(null, { kind: "compose", settings: { managerUrl: MANAGER }, credentials: { token: TOKEN } });
			const added = await turn();
			expect(names(added.tools)).toContain("coding_start");
			expect(added.line).toBeNull();

			// A provider this Worker can't make workspaces with offers nothing, whatever is set.
			await shared.removeComputeProvider("compose");
			await shared.putComputeProvider(null, { kind: "cloudflare-sandbox" });
			expect(await shared.computeSummaries()).toEqual([{ id: "cloudflare-sandbox", kind: "cloudflare-sandbox", codingSandbox: true, usable: false }]);
			expect(names((await turn()).tools)).toEqual([]);
			await shared.removeComputeProvider("cloudflare-sandbox");
			await shared.putComputeProvider(null, { kind: "compose", settings: { managerUrl: MANAGER }, credentials: { token: TOKEN } });

			// Switched off for coding, it is configured but offers nothing.
			await shared.putComputeProvider("compose", { codingSandbox: false });
			expect(names((await turn()).tools)).toEqual([]);
			await shared.putComputeProvider("compose", { codingSandbox: true });
			expect(names((await turn()).tools)).toContain("coding_start");

			// Taken away, they go again.
			await shared.removeComputeProvider("compose");
			const removed = await turn();
			expect(names(removed.tools)).toEqual([]);
			expect(removed.line).toContain(NO_CODING_SANDBOX_LINE);
		} finally {
			await shared.removeComputeProvider("compose");
			await space((pim) => pim.store.deleteMeta("test:no-coding-backend"));
		}
		expect(names((await turn()).tools)).toContain("coding_start");
	});
});
