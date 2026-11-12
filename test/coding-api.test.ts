import type { Activity } from "../src/activity-types";
import { listThreads } from "../src/coding/threads";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { getAgentByName } from "agents";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingEnvironment, CodingRepoSettings, CodingThreadSummary, CodingThreadView } from "../src/coding/api";
import { pktLine } from "../src/coding/git-broker/broker";
import type { GitHubApp } from "../src/coding/git-broker/github-app";
import { DEFAULT_SPACE_CAP } from "../src/coding/provider-capacity";
import { codingScheduler } from "../src/coding/scheduler-do";
import { type CodingEventSink, codingThread } from "../src/coding/thread-do";
import { turnEndedMessage } from "../src/coding/supervisor";
import { CodingThreadIndex, type IndexedThread } from "../src/coding/thread-index";
import { CodingThreadStore } from "../src/coding/thread-store";
import type { ComputeQuota } from "../src/compute";
import type { Pim } from "../src/pim";
import type { Approval } from "../src/store";
import type { WorkspaceSpec } from "../src/coding/workspace/types";
import { CODING_EVENT } from "../src/transcript";
import { fakeRemotes, hex40 } from "./fake-git";
import { api, apiUrl, connect, lastUserText, messagesOf, OWNER, post, say, settled, TOKEN, toolUse } from "./helpers";
import { installed } from "./fixtures/repos";
import { type CodingThreadDO, codingEvents, codingFaux, codingGitHub, codingSchedulers, codingWorkspaces, faux } from "./worker";

// The API and the agents' tools over real coding threads: each works in the in-memory workspace with a fake git and the
// scripted `coding-faux` model, in the space of the file's account (`OWNER`), whose chats talk to the scripted `faux`.

const REPO = "https://github.com/acme/demo";
fakeRemotes.set("https://pim.test/api/coding/git/acme/demo.git", { "README.md": "# Demo\n" });
const CODER = { providerId: "coding-faux", model: "coder" };

/** Another person on this Pim, with a token for their own space. */
let otherToken = "";

beforeAll(async () => {
	const directory = env.Directory.getByName("directory");
	const registered = await directory.register({ username: "other", ip: "192.0.2.2", claim: { window: true }, policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
	if (!registered.ok) throw new Error(registered.error);
	const owner = registered.account.ownerId;
	await directory.activate(owner);
	await (await getAgentByName(env.Pim, owner)).provision({ ownerId: owner, username: "other" });
	otherToken = (await env.Auth.getByName(owner).createToken(owner, "tests", Date.now())).token;
});

beforeEach(() => {
	codingEvents.length = 0;
	codingGitHub.app = null;
	codingGitHub.fetch = null;
});

afterEach(async () => {
	expect(codingFaux.getPendingResponseCount()).toBe(0);
	// Each test's threads give their slots back, so the next test's start where they did.
	for (const thread of (await api<{ threads: CodingThreadSummary[] }>("/coding/threads")).body.threads) {
		if (thread.state !== "archived") await post(`/coding/threads/${thread.id}/archive`);
	}
	await codingScheduler(env, OWNER).setLimit(DEFAULT_SPACE_CAP);
});

const asOther = (path: string, init: RequestInit = {}) =>
	exports.default.fetch(new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${otherToken}`, "content-type": "application/json" } }));

async function start(body: Record<string, unknown> = {}) {
	const { status, body: view } = await post<CodingThreadView>("/coding/threads", { repo: REPO, task: "Add a greeting", profile: CODER, ...body });
	expect(status).toBe(201);
	return view;
}

/** Takes the idle thread's slot back, as the scheduler does after 10 minutes, which deletes its workspace. */
async function release(threadId: string, space: string) {
	const scheduler = codingScheduler(env, space);
	codingSchedulers.now = Date.now() + 11 * 60_000;
	try {
		expect((await scheduler.sweep()).released).toEqual([{ threadId, why: "idle" }]);
		await runDurableObjectAlarm(scheduler);
	} finally {
		codingSchedulers.now = null;
	}
	expect(await codingWorkspaces.list({ sessionId: threadId })).toEqual([]);
}

/** The thread's `thread.turn_ended` events once it has had `count`. */
const turns = (id: string, count: number) =>
	vi.waitFor(
		() => {
			const ended = codingEvents.filter((event) => event.threadId === id);
			expect(ended).toHaveLength(count);
			return ended;
		},
		{ timeout: 15_000, interval: 50 },
	);

const view = async (id: string) => (await api<CodingThreadView>(`/coding/threads/${id}`)).body;

describe("the coding threads API", () => {
	it("is only for someone signed in, and only reaches their own space's threads", async () => {
		const anonymous = await exports.default.fetch(new Request(apiUrl("/coding/threads")));
		expect(anonymous.status).toBe(401);
		codingFaux.setResponses([fauxAssistantMessage("Nothing to change.")]);
		const thread = await start();
		await turns(thread.id, 1);
		// The other person's space has none, and doesn't find this one, however asked.
		expect(await (await asOther("/coding/threads")).json()).toEqual({ threads: [] });
		for (const [method, path] of [
			["GET", ""],
			["GET", "/transcript"],
			["GET", "/diff"],
			["GET", "/log"],
			["GET", "/events"],
			["POST", "/steer"],
			["POST", "/cancel"],
			["POST", "/archive"],
			["POST", "/seen"],
			["POST", "/push"],
		] as const) {
			const answer = await asOther(`/coding/threads/${thread.id}${path}`, { method, ...(method === "POST" ? { body: JSON.stringify({ text: "Hi" }) } : {}) });
			expect([method, path, answer.status, await answer.json()]).toEqual([method, path, 404, { error: `No coding thread ${thread.id}`, code: "not_found" }]);
		}
		// Nor can it start one under this one.
		const child = await asOther("/coding/threads", { method: "POST", body: JSON.stringify({ repo: REPO, task: "More", profile: CODER, parent: thread.id }) });
		expect(child.status).toBe(404);
		expect((await view(thread.id)).state).toBe("idle");
	});

	it("starts a thread once per operation, lists it, and says what was wrong with a start", async () => {
		codingFaux.setResponses([fauxAssistantMessage("Added it.")]);
		const first = await post<CodingThreadView>("/coding/threads", { repo: `${REPO}.git`, task: "Add a greeting", profile: CODER, budgetUsd: 2, operationId: "op-1" });
		expect(first.status).toBe(201);
		expect(first.body).toMatchObject({
			id: expect.any(String),
			url: `/coding/${first.body.id}`,
			task: "Add a greeting",
			createdBy: { type: "person" },
			repo: { url: REPO, ref: "main" },
			profile: CODER,
			budgetUsd: 2,
		});
		expect(first.body.status).toBe(first.body.state);
		const again = await post<CodingThreadView>("/coding/threads", { repo: REPO, task: "Add a greeting", profile: CODER, operationId: "op-1" });
		expect(again.status).toBe(200);
		expect(again.body.id).toBe(first.body.id);
		const [ended] = await turns(first.body.id, 1);
		expect(ended).toMatchObject({ outcome: "completed", state: "idle", said: "Added it.", budgetUsd: 2 });
		// The list has it once, as its own object last said it was.
		await vi.waitFor(async () => {
			const { threads } = (await api<{ threads: CodingThreadSummary[] }>("/coding/threads")).body;
			expect(threads.filter((thread) => thread.id === first.body.id)).toEqual([
				expect.objectContaining({ repo: REPO, ref: "main", branch: first.body.repo.branch, state: "idle", createdBy: { type: "person" }, budgetUsd: 2, queue: null }),
			]);
		});
		// What the web app reads of it.
		const log = (await api<{ events: { kind: string }[]; next: number }>(`/coding/threads/${first.body.id}/log`)).body;
		expect(log.events.map((event) => event.kind)).toEqual(["thread.turn_started", "model_call", "thread.turn_ended"]);
		expect((await api(`/coding/threads/${first.body.id}/log?since=${log.next}`)).body).toEqual({ events: [], next: log.next });
		const { messages } = (await api<{ messages: { role: string }[] }>(`/coding/threads/${first.body.id}/transcript`)).body;
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect((await api(`/coding/threads/${first.body.id}/tests`)).body).toEqual({ runs: [] });
		const sse = await exports.default.fetch(new Request(apiUrl(`/coding/threads/${first.body.id}/events`), { headers: { Authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" } }));
		expect(sse.headers.get("content-type")).toBe("text/event-stream");
		const reader = sse.body!.getReader();
		let head = "";
		while (!head.includes("\n\n")) head += new TextDecoder().decode((await reader.read()).value);
		expect(JSON.parse(head.split("\n\n")[0]!.replace(/^data: /, ""))).toMatchObject({ type: "snapshot" });
		await reader.cancel();
		// Starts it refuses, saying why, with nothing started.
		const before = (await api<{ threads: unknown[] }>("/coding/threads")).body.threads.length;
		const refused = async (body: Record<string, unknown>) => {
			const { status, body: error } = await post("/coding/threads", { repo: REPO, task: "Add a greeting", profile: CODER, ...body });
			return [status, error.code];
		};
		expect(await refused({ task: "  " })).toEqual([400, "invalid"]);
		expect(await refused({ repo: "https://gitlab.com/acme/demo" })).toEqual([400, "invalid"]);
		expect(await refused({ budgetUsd: 0 })).toEqual([400, "invalid"]);
		expect(await refused({ profile: { providerId: "coding-faux" } })).toEqual([400, "invalid"]);
		expect(await refused({ parent: "nobody" })).toEqual([404, "not_found"]);
		expect(await refused({ pool: "nowhere" })).toEqual([400, "invalid"]);
		expect(await refused({ pool: 7 })).toEqual([400, "invalid"]);
		expect((await api<{ threads: unknown[] }>("/coding/threads")).body.threads).toHaveLength(before);
	});

	it("tells open pages on the chat list's socket when a thread starts, changes state or is archived", async () => {
		const { socket, received } = await connect();
		const lists = () => received.filter((message) => message.type === "sessions").length;
		const view = await start();
		await vi.waitFor(() => expect(lists()).toBeGreaterThan(0));
		await settled();
		const afterStart = lists();
		expect((await post(`/coding/threads/${view.id}/archive`)).status).toBe(200);
		await vi.waitFor(() => expect(lists()).toBeGreaterThan(afterStart));
		socket.close();
	});

	it("lists a thread as unread once a turn ends after the person last viewed it, until they mark it seen", async () => {
		codingFaux.setResponses([fauxAssistantMessage("Done.")]);
		const { socket, received } = await connect();
		const lists = () => received.filter((message) => message.type === "sessions").length;
		const view = await start();
		const row = async () => (await api<{ threads: CodingThreadSummary[] }>("/coding/threads")).body.threads.find((thread) => thread.id === view.id)!;
		await vi.waitFor(async () => expect(await row()).toMatchObject({ state: "idle", lastSeenAt: null }));
		const ended = await row();
		expect(ended.lastTurnEndedAt).toBeGreaterThan(0);
		await settled();
		const before = lists();
		expect((await post(`/coding/threads/${view.id}/seen`)).status).toBe(200);
		const seen = await row();
		expect(seen.lastSeenAt).toBeGreaterThanOrEqual(ended.lastTurnEndedAt!);
		expect(seen.lastTurnEndedAt).toBe(ended.lastTurnEndedAt);
		await vi.waitFor(() => expect(lists()).toBeGreaterThan(before));
		socket.close();
	});

	it("records its harness, which is pi by default, and the chat a person starts it from", async () => {
		codingFaux.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
		const plain = await start();
		expect(plain.harness).toBe("pi");
		const fromChat = await start({ task: "From a chat", chat: "chat-1", harness: "pi" });
		const listed = (await api<{ threads: CodingThreadSummary[] }>("/coding/threads")).body.threads;
		expect(listed.find((thread) => thread.id === plain.id)).toMatchObject({ harness: "pi", chat: null });
		expect(listed.find((thread) => thread.id === fromChat.id)).toMatchObject({ harness: "pi", chat: "chat-1" });
		expect((await view(fromChat.id)).harness).toBe("pi");
		const unknown = await post("/coding/threads", { repo: REPO, task: "Add a greeting", profile: CODER, harness: "vim" });
		expect([unknown.status, unknown.body.code]).toEqual([400, "invalid"]);
		expect((await api<{ threads: unknown[] }>("/coding/threads")).body.threads).toHaveLength(listed.length);
	});

	it("pins a thread to a pool of the space, and shows where it runs and why", async () => {
		codingFaux.setResponses([fauxAssistantMessage("Nothing to change.")]);
		const pinned = await start({ pool: codingWorkspaces.id });
		expect(pinned).toMatchObject({ provider: codingWorkspaces.id, pool: codingWorkspaces.id, placementReason: "pinned" });
		await turns(pinned.id, 1);
		expect(await view(pinned.id)).toMatchObject({ provider: codingWorkspaces.id, placementReason: "pinned" });
		const refused = await post("/coding/threads", { repo: REPO, task: "Add a greeting", profile: CODER, provider: "nowhere" });
		expect(refused.body.error).toMatch(/Unknown or disabled pool "nowhere"/);
	});

	it("starts a Claude Code or Codex thread on the CLI's own model, which waits for the person's login while they have none", async () => {
		for (const [harness, name] of [
			["claude-code", "Claude Code"],
			["codex", "Codex"],
		] as const) {
			const thread = await start({ task: "Fix the date test", harness });
			expect(thread).toMatchObject({ harness, profile: { providerId: harness, model: "default" } });
			const waiting = await vi.waitFor(
				async () => {
					const current = await view(thread.id);
					expect(current.state).toBe("waiting_input");
					return current;
				},
				{ timeout: 10_000, interval: 50 },
			);
			// Its task waits with it, unanswered: no turn started, and nothing was spent.
			expect(waiting).toMatchObject({ stateReason: "login_required", currentOperation: null, inbox: 1, spentUsd: 0 });
			expect(waiting.stateDetail).toMatch(new RegExp(`Connect ${name}`));
			const log = (await api<{ events: { kind: string; data: unknown }[] }>(`/coding/threads/${thread.id}/log`)).body.events;
			expect(log.map((event) => event.kind)).not.toContain("thread.turn_started");
			expect(log.find((event) => event.kind === "thread.waiting_input")?.data).toMatchObject({ reason: "login_required", harness });
		}
	});

	it("answers at once with a queued thread's place, and cancels it out of the queue", async () => {
		await codingScheduler(env, OWNER).setLimit(1);
		codingFaux.setResponses([toolUse("bash", { command: "sleep 30" })]);
		const running = await start();
		await vi.waitFor(async () => expect((await view(running.id)).state).toBe("running"));
		const queued = await start({ task: "Write the docs" });
		expect(queued).toMatchObject({ status: "queued", state: "queued", position: 1, reason: "slots_full", queue: { position: 1, reason: "slots_full" } });
		expect((await api<{ events: { kind: string; data: unknown }[] }>(`/coding/threads/${queued.id}/log`)).body.events).toEqual([
			expect.objectContaining({ kind: "thread.queued", data: { position: 1, reason: "slots_full" } }),
		]);
		await vi.waitFor(async () => {
			const { threads } = (await api<{ threads: CodingThreadSummary[] }>("/coding/threads")).body;
			expect(threads.find((thread) => thread.id === queued.id)).toMatchObject({ state: "queued", queue: { position: 1, reason: "slots_full" } });
		});
		// A thread in its turn isn't cancelled; the queued one is, at once, and its turn ends cancelled.
		expect((await post(`/coding/threads/${running.id}/cancel`)).body).toMatchObject({ code: "not_cancellable" });
		const cancelled = await post<CodingThreadView>(`/coding/threads/${queued.id}/cancel`);
		expect(cancelled.status).toBe(200);
		expect(cancelled.body).toMatchObject({ state: "idle", stateReason: "cancelled", slot: "none", queue: null, inbox: 0 });
		expect(codingEvents.filter((event) => event.threadId === queued.id)).toEqual([
			expect.objectContaining({ type: "thread.turn_ended", outcome: "cancelled", reason: "cancelled", state: "idle" }),
		]);
		expect((await codingScheduler(env, OWNER).snapshot()).queued).toEqual([]);
		// Again, it changes nothing.
		expect((await post<CodingThreadView>(`/coding/threads/${queued.id}/cancel`)).body).toMatchObject({ state: "idle", stateReason: "cancelled" });
		expect(codingEvents.filter((event) => event.threadId === queued.id)).toHaveLength(1);
		await post(`/coding/threads/${running.id}/abort`);
	});

	it("counts a workspace's minutes by provider, and refuses one past the person's compute quota before the provider is asked", async () => {
		const gallery = env.Gallery.getByName("gallery");
		const quota = (change: Partial<ComputeQuota> | null) => runInDurableObject(env.Pim.getByName(OWNER), (pim: Pim) => pim.setComputeQuota(change));
		const before = (await gallery.computeUsageOf(OWNER)).minutes;
		await quota({ maxConcurrentWorkspaces: 1, maxSessionMinutes: 45 });
		try {
			codingFaux.setResponses([toolUse("bash", { command: "sleep 30" })]);
			const running = await start();
			await vi.waitFor(async () => expect((await view(running.id)).state).toBe("running"));
			// The workspace is counted as running, held to the session limit.
			const during = await gallery.computeUsageOf(OWNER);
			expect(during).toMatchObject({ running: 1, byProvider: [{ provider: "fake", running: 1 }] });
			const [made] = await codingWorkspaces.list({ sessionId: running.id });
			expect(((await codingWorkspaces.get(made!.ref)) as unknown as { spec: WorkspaceSpec }).spec.limits.wallClockMin).toBe(45);

			// The person's one is taken: a second thread has its slot, but no workspace is made for it.
			const second = await start({ task: "Write the docs" });
			const failed = await vi.waitFor(async () => {
				const thread = await view(second.id);
				expect(thread.state).toBe("failed");
				return thread;
			});
			expect(failed.stateReason).toBe("compute_quota");
			expect(failed.stateDetail).toMatch(/already have 1 sandbox workspace running.*\(1\)/);
			expect(await codingWorkspaces.list({ sessionId: second.id })).toEqual([]);
			expect((await gallery.computeUsageOf(OWNER)).running).toBe(1);

			// Stopping the first gives its minutes back as usage, and the person's next workspace is made.
			await post(`/coding/threads/${running.id}/archive`);
			const after = await gallery.computeUsageOf(OWNER);
			expect(after.running).toBe(0);
			expect(after.minutes).toBeGreaterThanOrEqual(before);
			expect(after.byProvider).toEqual([expect.objectContaining({ provider: "fake", running: 0 })]);
			codingFaux.setResponses([fauxAssistantMessage("Nothing to change.")]);
			const next = await start({ task: "Try again" });
			await turns(next.id, 1);
		} finally {
			await quota(null);
		}
	});

	it("checks the quota again and counts a new stretch when a suspended thread resumes", async () => {
		const quota = (change: Partial<ComputeQuota> | null) => runInDurableObject(env.Pim.getByName(OWNER), (pim: Pim) => pim.setComputeQuota(change));
		const stretches = (id: string) =>
			runInDurableObject(env.Gallery.getByName("gallery"), (_instance: unknown, state: DurableObjectState) =>
				state.storage.sql.exec("SELECT end_reason FROM compute_usage WHERE thread_id = ? ORDER BY id", id).toArray().map((row) => row.end_reason),
			);
		codingFaux.setResponses([fauxAssistantMessage("Nothing to change.")]);
		const thread = await start();
		await turns(thread.id, 1);
		// The scheduler takes its idle workspace back: the stretch ends as suspended.
		await release(thread.id, OWNER);
		expect(await stretches(thread.id)).toEqual(["suspend"]);

		// Over its quota, the thread is refused before the provider is asked for a workspace, and nothing is counted.
		await quota({ maxConcurrentWorkspaces: 0 });
		try {
			await post(`/coding/threads/${thread.id}/steer`, { text: "More, please.", operationId: "more-1" });
			const refused = await vi.waitFor(async () => {
				const now = await view(thread.id);
				expect(now.stateReason).toBe("compute_quota");
				return now;
			});
			expect(refused.stateDetail).toMatch(/most this Pim lets you have at once \(0\)/);
			expect(await codingWorkspaces.list({ sessionId: thread.id })).toEqual([]);
			expect(await stretches(thread.id)).toEqual(["suspend"]);
		} finally {
			await quota(null);
		}

		// Within it, continuing makes the workspace again and a second stretch runs.
		codingFaux.setResponses([fauxAssistantMessage("Did more.")]);
		await post(`/coding/threads/${thread.id}/continue`, { operationId: "more-2" });
		// Its first turn, the refusal (a failed turn), and this one.
		expect((await turns(thread.id, 3))[2]).toMatchObject({ outcome: "completed" });
		expect(await stretches(thread.id)).toEqual(["suspend", null]);
		expect(await codingWorkspaces.list({ sessionId: thread.id })).toHaveLength(1);
	});

	it("aborts, continues and steers a thread, and refuses an archived one", async () => {
		codingFaux.setResponses([toolUse("bash", { command: "sleep 30" }), fauxAssistantMessage("Went on."), fauxAssistantMessage("Did more.")]);
		const thread = await start();
		await vi.waitFor(async () => expect((await view(thread.id)).state).toBe("running"));
		expect((await post<CodingThreadView>(`/coding/threads/${thread.id}/abort`)).body).toMatchObject({ state: "idle", currentOperation: null });
		expect((await turns(thread.id, 1))[0]).toMatchObject({ outcome: "cancelled" });
		expect((await post(`/coding/threads/${thread.id}/continue`, { budgetUsd: -1 })).body.code).toBe("invalid");
		await post(`/coding/threads/${thread.id}/continue`, { operationId: "go-on" });
		expect((await turns(thread.id, 2))[1]).toMatchObject({ outcome: "completed", operationId: "go-on", said: "Went on." });
		expect((await post(`/coding/threads/${thread.id}/steer`, { text: " " })).body.code).toBe("invalid");
		await post(`/coding/threads/${thread.id}/steer`, { text: "Now the docs.", operationId: "steer-1" });
		expect((await turns(thread.id, 3))[2]).toMatchObject({ outcome: "completed", operationId: "steer-1", said: "Did more." });
		expect((await post<CodingThreadView>(`/coding/threads/${thread.id}/archive`)).body).toMatchObject({ state: "archived" });
		const late = await post(`/coding/threads/${thread.id}/steer`, { text: "More?" });
		expect([late.status, late.body.code]).toEqual([409, "archived"]);
		// Reading it still works.
		expect((await view(thread.id)).state).toBe("archived");
	});

	it("keeps the person's setup script for a repository, which its threads run, and shows and rebuilds a thread's environment", async () => {
		// The repository has no .pim/setup.sh of its own; the person's setting gives it one. Its go.mod pins Go, which is provisioned before it. `bash` runs both.
		fakeRemotes.set("https://pim.test/api/coding/git/acme/configured.git", { "README.md": "# Configured\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "go.mod": "module example.com/configured\n\ngo 1.22\n" });
		const scripts: string[] = [];
		codingWorkspaces.register("bash", ({ argv }) => (scripts.push(argv[2]!.replace(/^export PATH=.*\n/, "")), {}));
		const path = "/coding/repos/Acme/Configured/settings";
		const put = (body: unknown, as = api) => as(path, { method: "PUT", body: JSON.stringify(body) });
		expect((await api<CodingRepoSettings>(path)).body).toEqual({ repo: "acme/configured", setupScript: null, updatedAt: null });
		expect(await put({ setupScript: 5 })).toMatchObject({ status: 400, body: { code: "invalid" } });
		expect(await put({ setupScript: "x".repeat(64 * 1024 + 1) })).toMatchObject({ status: 400, body: { code: "invalid" } });
		expect(await api("/coding/repos/acme/..%2Fx/settings")).toMatchObject({ status: 400, body: { code: "invalid" } });
		const saved = await put({ setupScript: "pnpm install --frozen-lockfile\n" });
		expect(saved).toMatchObject({ status: 200, body: { repo: "acme/configured", setupScript: "pnpm install --frozen-lockfile\n", updatedAt: expect.any(Number) } });
		// Another person's settings are their own.
		expect(await (await asOther(path)).json()).toMatchObject({ setupScript: null });
		codingFaux.setResponses([fauxAssistantMessage("Ready.")]);
		const thread = await start({ repo: "https://github.com/acme/configured" });
		expect(thread.environment).toMatchObject({ state: expect.any(String) });
		await turns(thread.id, 1);
		const environment = (await view(thread.id)).environment;
		expect(environment).toMatchObject({ state: "cached", source: "settings", key: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect((await api<CodingEnvironment>(`/coding/threads/${thread.id}/environment`)).body).toEqual(environment);
		expect(scripts).toEqual([installed("go@1.22"), "pnpm install --frozen-lockfile\n"]);
		// An agent's coding_status shows every field that says something, its timings, toolchains and check commands included, and whether it came from a cached snapshot.
		let told = "";
		faux.setResponses([
			toolUse("coding_status", { thread_id: thread.id }),
			(context: Parameters<FauxResponseFactory>[0]) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				told = result?.role === "toolResult" && result.content[0]?.type === "text" ? result.content[0].text : "";
				return toolUse("send_to_user", { message: "It's ready." });
			},
		]);
		await say("Is its environment ready?");
		const { builtAt, provisionMs, setupMs, snapshotMs, preparedAt } = environment;
		for (const value of [builtAt, provisionMs, setupMs, snapshotMs, preparedAt]) expect(value).toEqual(expect.any(Number));
		// It says where the thread runs and why, too.
		expect(JSON.parse(told)).toMatchObject({ provider: codingWorkspaces.id, pool: codingWorkspaces.id, placement_reason: "priority" });
		expect(JSON.parse(told).environment).toEqual({
			state: "cached",
			key: environment.key,
			source: "settings",
			builtAt,
			provisionMs,
			setupMs,
			snapshotMs,
			preparedAt,
			rebuildRequested: false,
			snapshotKept: true,
			readyFrom: "setup",
			cache_hit: false,
			toolchains: [{ tool: "go", version: "1.22", source: "manifest", from: "go.mod", status: "installed" }],
			testCommands: [
				{ command: "go vet ./...", source: "default", from: "go.mod" },
				{ command: "go test ./...", source: "default", from: "go.mod" },
			],
		});
		// A rebuild runs it again, between turns.
		expect(await post(`/coding/threads/${thread.id}/environment/rebuild`)).toMatchObject({ status: 200, body: { state: "building", rebuildRequested: true } });
		await vi.waitFor(async () => expect((await view(thread.id)).environment).toMatchObject({ state: "cached", rebuildRequested: false }), { timeout: 10_000, interval: 50 });
		expect(scripts).toHaveLength(4);
		expect((await asOther(`/coding/threads/${thread.id}/environment`)).status).toBe(404);
		// A blank script clears the setting.
		expect((await put({ setupScript: null })).body).toEqual({ repo: "acme/configured", setupScript: null, updatedAt: null });
		await post(`/coding/threads/${thread.id}/archive`);
		expect(await post(`/coding/threads/${thread.id}/environment/rebuild`)).toMatchObject({ status: 409, body: { code: "archived" } });
	});

	it("asks the person before it pushes, and only when the GitHub App is set up and the branch is one Pim pushes to", async () => {
		codingFaux.setResponses([toolUse("write", { path: "hello.txt", content: "Hello!\n" }), fauxAssistantMessage("Added hello.txt.")]);
		const thread = await start();
		const [ended] = await turns(thread.id, 1);
		expect(ended!.checkpoint).toEqual(expect.any(String));
		const diff = (await api(`/coding/threads/${thread.id}/diff`)).body;
		expect(diff.diff).toContain("+Hello!");
		// Without the App, nothing is asked.
		const unset = await post(`/coding/threads/${thread.id}/push`);
		expect([unset.status, unset.body]).toEqual([409, { error: "GitHub App not configured: ask the Pim owner to set it up", code: "github_app_not_configured" }]);
		const pending = async () => (await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals.filter((approval) => approval.action === "coding_push_for_approval");
		expect(await pending()).toEqual([]);
		// With it, never main, nor a branch outside pim/.
		const github = fakeGitHub();
		codingGitHub.app = github.app;
		codingGitHub.fetch = github.fetch;
		for (const branch of ["main", "feature/x"]) {
			const refused = await post(`/coding/threads/${thread.id}/push`, { branch });
			expect([branch, refused.status, refused.body.code]).toEqual([branch, 403, "push_refused"]);
		}
		expect(await pending()).toEqual([]);
		// Its own branch: an approval for the person, the same one if asked again.
		const asked = await post(`/coding/threads/${thread.id}/push`);
		expect(asked.status).toBe(202);
		const head = hex40(ended!.checkpoint!);
		expect(asked.body).toMatchObject({ approval: expect.any(String), status: "pending", branch: thread.repo.branch, head });
		expect(asked.body.summary).toBe(`Push ${thread.repo.branch} (${head.slice(0, 12)}, 1 KB) to github.com/acme/demo`);
		expect((await post(`/coding/threads/${thread.id}/push`)).body.approval).toBe(asked.body.approval);
		expect(await pending()).toEqual([expect.objectContaining({ id: asked.body.approval, summary: asked.body.summary, tool: null })]);
		expect(github.pushes).toEqual([]);
		// Approved, Pim pushes the branch as a new one.
		const approved = await post<Approval>(`/approvals/${asked.body.approval}/approve`);
		expect(approved.status).toBe(200);
		expect(approved.body).toMatchObject({ status: "approved", result: expect.stringContaining(`Pushed ${thread.repo.branch} (${head.slice(0, 12)}) to github.com/acme/demo`) });
		expect(github.pushes).toEqual([`0000000000000000000000000000000000000000 ${head} refs/heads/${thread.repo.branch}`]);
		const log = (await api<{ events: { kind: string; data: unknown }[] }>(`/coding/threads/${thread.id}/log`)).body.events;
		expect(log.at(-1)).toMatchObject({ kind: "thread.pushed", data: { repo: "acme/demo", branch: thread.repo.branch, before: null, after: head, outcome: "created" } });
	});

	it("resumes a thread whose workspace was released to push it, with no turn", async () => {
		codingFaux.setResponses([toolUse("write", { path: "hello.txt", content: "Hello!\n" }), fauxAssistantMessage("Added hello.txt.")]);
		const thread = await start();
		const [ended] = await turns(thread.id, 1);
		const github = fakeGitHub();
		codingGitHub.app = github.app;
		codingGitHub.fetch = github.fetch;
		await release(thread.id, ended!.space);
		const asked = await post(`/coding/threads/${thread.id}/push`);
		expect(asked.status).toBe(202);
		expect((await view(thread.id)).slot).toBe("held");
		await post(`/approvals/${asked.body.approval}/approve`);
		expect(github.pushes).toEqual([`0000000000000000000000000000000000000000 ${hex40(ended!.checkpoint!)} refs/heads/${thread.repo.branch}`]);
		expect(codingEvents.filter((event) => event.threadId === thread.id)).toHaveLength(1);
		// Released again before the approval is given, it is resumed for the push itself.
		await release(thread.id, ended!.space);
		const again = await post(`/coding/threads/${thread.id}/push`, { branch: `pim/again-${thread.id.slice(0, 8)}` });
		expect(again.status).toBe(202);
		await post(`/approvals/${again.body.approval}/approve`);
		expect(github.pushes).toHaveLength(2);
	});

	it("starts a thread with rebuildEnvironment=true", async () => {
		codingFaux.setResponses([fauxAssistantMessage("Ready.")]);
		const thread = await start({ rebuildEnvironment: true });
		await turns(thread.id, 1);
		const status = await view(thread.id);
		// When rebuildEnvironment is true, the flag should be cleared after the environment is prepared
		expect(status.environment.rebuildRequested).toBe(false);
	});

	it("starts a thread with rebuildEnvironment=false (default)", async () => {
		codingFaux.setResponses([fauxAssistantMessage("Ready.")]);
		const thread = await start({ rebuildEnvironment: false });
		await turns(thread.id, 1);
		const status = await view(thread.id);
		// Default behavior: rebuildRequested should be false
		expect(status.environment.rebuildRequested).toBe(false);
	});
});

describe("opening a pull request from a coding thread", () => {
	it("is refused until the provider is set up and the branch pushed, then opens the pull request at once, with no approval", async () => {
		codingFaux.setResponses([toolUse("write", { path: "hello.txt", content: "Hello!\n" }), fauxAssistantMessage("Added hello.txt.")]);
		const thread = await start();
		await turns(thread.id, 1);
		const open = (body: Record<string, unknown> = {}) => post(`/coding/threads/${thread.id}/pull-request`, body);
		const unset = await open();
		expect([unset.status, unset.body.code]).toEqual([409, "github_app_not_configured"]);
		const github = fakeGitHub();
		codingGitHub.app = github.app;
		codingGitHub.fetch = github.fetch;
		const unpushed = await open();
		expect([unpushed.status, unpushed.body.code]).toEqual([409, "not_pushed"]);
		const push = await post(`/coding/threads/${thread.id}/push`);
		await post(`/approvals/${push.body.approval}/approve`);
		expect(github.pushes).toHaveLength(1);
		const opened = await open();
		expect(opened.status).toBe(200);
		expect(opened.body).toEqual({ title: "Add a greeting", base: "main", url: "https://github.com/acme/demo/pull/1", number: 1 });
		expect((await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals).toEqual([]);
		expect(github.pulls).toEqual([{ head: thread.repo.branch, base: "main", title: "Add a greeting", body: "Add a greeting\n\n---\nOpened by Pim from a coding thread." }]);
		expect((await view(thread.id)).pullRequest).toEqual({ url: "https://github.com/acme/demo/pull/1", number: 1 });
		const custom = await open({ title: "Greet the world", body: "Says hello." });
		expect(custom.body).toMatchObject({ title: "Greet the world", number: 2 });
		expect(github.pulls.at(-1)).toEqual({ head: thread.repo.branch, base: "main", title: "Greet the world", body: "Says hello." });
		const log = (await api<{ events: { kind: string; data: unknown }[] }>(`/coding/threads/${thread.id}/log`)).body.events;
		expect(log.at(-1)).toMatchObject({ kind: "thread.pull_request", data: { repo: "acme/demo", branch: thread.repo.branch, base: "main", number: 2 } });
	});

	it("is a tool that needs no approval, with a title and body of its own", async () => {
		await runInDurableObject(env.Pim.getByName(OWNER), async (pim: Pim) => {
			const ability = pim.abilities.get("coding")!;
			expect(ability.actions!.map((action) => action.name)).not.toContain("coding_open_pull_request");
			const tool = ability.tools!.find((candidate) => candidate.name === "coding_open_pull_request")!;
			expect(tool.description).toMatch(/no approval/);
			expect(tool.description).not.toMatch(/github\.com/i);
			const schema = tool.parameters as unknown as { properties: Record<string, unknown>; required: string[] };
			expect(Object.keys(schema.properties).sort()).toEqual(["body", "thread_id", "title"]);
			expect(schema.required).toEqual(["thread_id"]);
		});
	});

	it("tells agents to retry a transiently failed thread once, then tell the person", async () => {
		await runInDurableObject(env.Pim.getByName(OWNER), async (pim: Pim) => {
			const tool = pim.abilities.get("coding")!.tools!.find((candidate) => candidate.name === "coding_start")!;
			expect(tool.description).toMatch(/transient error.*retry once by starting a fresh thread with the same task.*stop and tell the person/);
		});
	});
});

describe("merging a coding thread into the default branch", () => {
	const MAIN = hex40("m-main");
	const MAIN_REMOTE = "https://pim.test/api/coding/git/acme/demo.git";

	/** A thread that added hello.txt, and the agent merging it: what the tool answered once the person approved, and the log's merge events. */
	async function merged(options: { remote?: Record<string, string>; patchAnswers?: number[]; refs?: Record<string, string>; released?: boolean } = {}) {
		codingFaux.setResponses([toolUse("write", { path: "hello.txt", content: "Hello!\n" }), fauxAssistantMessage("Added hello.txt.")]);
		const thread = await start();
		const [ended] = await turns(thread.id, 1);
		const github = fakeGitHub({ "refs/heads/main": MAIN, ...options.refs }, options.patchAnswers);
		codingGitHub.app = github.app;
		codingGitHub.fetch = github.fetch;
		if (options.remote) fakeRemotes.set(MAIN_REMOTE, options.remote);
		if (options.released) await release(thread.id, ended!.space);
		try {
			let told = "";
			faux.setResponses([
				toolUse("coding_merge", { thread_id: thread.id }),
				(context) => {
					const result = context.messages.findLast((message) => message.role === "toolResult");
					told = result?.role === "toolResult" && result.content[0]?.type === "text" ? result.content[0].text : "";
					return toolUse("send_to_user", { message: "Merged." });
				},
			]);
			const chat = (await post<{ id: string }>("/sessions")).body.id;
			// No approval is asked: the tool runs at once.
			await say("Ship it.", chat);
			expect((await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals.filter((candidate) => candidate.action === "coding_merge")).toEqual([]);
			const decided = { result: told };
			const log = (await api<{ events: { kind: string; data: Record<string, unknown> }[] }>(`/coding/threads/${thread.id}/log`)).body.events;
			return { thread, ended: ended!, github, result: decided.result, log };
		} finally {
			fakeRemotes.set(MAIN_REMOTE, { "README.md": "# Demo\n" });
		}
	}

	it("resumes a thread whose workspace was released, to merge it", async () => {
		const { thread, ended, result, log } = await merged({ released: true });
		const head = hex40(ended.checkpoint!);
		expect(JSON.parse(result)).toMatchObject({ message: expect.stringContaining(`main is now at ${head}`), sha: head });
		expect(log.filter((event) => event.kind === "thread.merged")).toHaveLength(1);
		expect((await view(thread.id)).slot).toBe("held");
		expect(codingEvents.filter((event) => event.threadId === thread.id)).toHaveLength(1);
	});

	it("fast-forwards the default branch to the thread's checkpoint and updates its own branch, never by force", async () => {
		const { thread, ended, github, result, log } = await merged();
		const head = hex40(ended.checkpoint!);
		expect(JSON.parse(result)).toEqual({ message: `Merged into main on github.com/acme/demo as a fast-forward: main is now at ${head}. ${thread.repo.branch} was updated to it.`, sha: head, tests: "It hasn't run any tests." });
		// The default branch is moved by the API without force, after the objects went to a staging ref; nothing is sent to it directly.
		expect(github.moves).toEqual([{ ref: "refs/heads/main", sha: head, force: false }]);
		expect(github.pushes.filter((command) => command.includes("refs/heads/main"))).toEqual([]);
		expect(github.pushes.map((command) => command.split(" ")[2]!.replace(/[0-9a-f-]{36}$/, "<id>"))).toEqual(["refs/pim-staging/<id>", "refs/pim-staging/<id>", `refs/heads/${thread.repo.branch}`]);
		expect(log.filter((event) => event.kind === "thread.merged").map((event) => event.data)).toEqual([{ repo: "acme/demo", branch: "main", before: MAIN, after: head, outcome: "updated", rebased: false }]);
	});

	it("rebases the thread onto a default branch that has moved, and records the rebased commit as a checkpoint", async () => {
		const { ended, github, result, log } = await merged({ remote: { "README.md": "# Demo\n", "CHANGELOG.md": "v2\n" } });
		expect(JSON.parse(result).message).toMatch(/^Merged into main on github.com\/acme\/demo after rebasing onto it: main is now at [0-9a-f]{40}\./);
		const after = github.moves[0]!.sha as string;
		expect(after).not.toBe(hex40(ended.checkpoint!));
		expect(github.moves).toEqual([{ ref: "refs/heads/main", sha: after, force: false }]);
		expect(log.filter((event) => event.kind === "thread.merged")[0]!.data).toMatchObject({ rebased: true, outcome: "updated" });
	});

	it("stops at a conflict with nothing pushed, and tells the agent to steer the thread", async () => {
		const { result, github, log } = await merged({ remote: { "README.md": "# Demo\n", "hello.txt": "Hi from main\n" } });
		expect(JSON.parse(result)).toMatchObject({ error: "merge_failed", tests: "It hasn't run any tests." });
		expect(result).toContain("The thread's changes conflict with main");
		expect(result).toContain("Steer the thread to rebase onto origin/main");
		expect(github.pushes).toEqual([]);
		expect(github.moves).toEqual([]);
		expect(log.some((event) => event.kind === "thread.merged")).toBe(false);
	});

	it("retries the rebase once when the default branch moves meanwhile, and then gives up", async () => {
		const once = await merged({ patchAnswers: [422] });
		expect(JSON.parse(once.result).message).toContain("Merged into main");
		expect(once.github.moves).toHaveLength(2);
		expect(once.github.moves.every((move) => move.force === false)).toBe(true);
		await post(`/coding/threads/${once.thread.id}/archive`);
		const twice = await merged({ patchAnswers: [422, 422] });
		expect(JSON.parse(twice.result)).toMatchObject({ error: "merge_failed", message: "main moved again while merging; nothing was pushed to it. Ask to merge again." });
		expect(twice.github.moves).toHaveLength(2);
		expect(twice.github.moves.every((move) => move.force === false)).toBe(true);
	});
});

describe("an agent's coding tools", () => {
	it("start a thread from a chat, which is woken once when its turn ends", async () => {
		let started: Record<string, unknown> = {};
		let woken = "";
		faux.setResponses([
			toolUse("coding_start", { repo: REPO, task: "Add a greeting", profile: { provider: "coding-faux", model: "coder" }, budget: 1 }),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				started = JSON.parse(result?.role === "toolResult" && result.content[0]?.type === "text" ? result.content[0].text : "{}");
				return toolUse("send_to_user", { message: "Started it." });
			},
			(context) => {
				woken = lastUserText(context.messages);
				return toolUse("send_to_user", { message: "It added the greeting." });
			},
		]);
		codingFaux.setResponses([fauxAssistantMessage("Added the greeting.")]);
		const chat = (await post<{ id: string }>("/sessions")).body.id;
		await say("Add a greeting to acme/demo.", chat);
		const id = String(started.thread_id);
		expect(started).toMatchObject({ url: `https://pim.test/coding/${id}`, status: expect.any(String), branch: expect.stringMatching(/^pim\/add-a-greeting-/) });
		const [ended] = await turns(id, 1);
		await vi.waitFor(() => expect(woken).not.toBe(""), { timeout: 10_000 });
		expect(woken).toContain(`[Coding thread ${id}] It finished its turn.`);
		expect(woken).toContain("State: idle. Spent $0.00 of its $1 budget.");
		expect(woken).toContain(`Link: https://pim.test/coding/${id}`);
		expect(woken).toContain("It last said:\nAdded the greeting.");
		// The list says which agent started it, from which chat.
		const listed = (await api<{ threads: CodingThreadSummary[] }>("/coding/threads")).body.threads.find((thread) => thread.id === id);
		expect(listed?.createdBy).toEqual({ type: "agent", agent: expect.any(String), chat });
		// And records the chat as the one the thread is a subthread of, with the default harness.
		expect(listed).toMatchObject({ chat, harness: "pi" });
		expect((await view(id)).createdBy).toEqual(listed!.createdBy);
		// The same turn's end told again wakes nobody.
		await runInDurableObject(codingThread(env, id), (thread: CodingThreadDO) => (thread as unknown as { eventSink(): CodingEventSink }).eventSink().emit(ended!));
		await settled(chat);
		expect((await messagesOf(chat, "user")).filter((text) => text.includes("[Coding thread"))).toHaveLength(1);
		// A stall uses the same parent-wake path, with a durable claim even across repeated heartbeat checks.
		let stalled = "";
		faux.setResponses([(context) => {
			stalled = lastUserText(context.messages);
			return toolUse("send_to_user", { message: "Checking the slow command." });
		}]);
		const activity = { running: true, lastActivityAt: 100, current: [{ name: "test", summary: "command=vitest run", startedAt: 100, elapsedMs: 901000, timeoutMs: 900000 }], steps: [], stalls: [{ key: "tool:100:test", reason: "past declared timeout", since: 100 }] };
		const pim = await getAgentByName(env.Pim, OWNER);
		await pim.codingStalled(id, activity);
		await pim.codingStalled(id, activity);
		await settled(chat);
		expect(stalled).toContain("past declared timeout");
		expect(stalled).toContain("command=vitest run");
		expect((await messagesOf(chat, "user")).filter((text) => text.includes("Stalled:"))).toHaveLength(1);

	});

	it("started by a guest agent in a group chat belong to that chat, and wake that agent in it when a turn ends", async () => {
		const coach = (await post<{ id: string }>("/agents", { name: "Coach", description: "Plans runs", instructions: "Plan runs." })).body;
		const chat = (await post<{ id: string }>("/sessions")).body.id;
		const heard: string[] = [];
		let started: Record<string, unknown> = {};
		const result = (context: Parameters<FauxResponseFactory>[0]) => {
			const last = context.messages.findLast((message) => message.role === "toolResult");
			return last?.role === "toolResult" && last.content[0]?.type === "text" ? last.content[0].text : "{}";
		};
		const guest = (step: (context: Parameters<FauxResponseFactory>[0]) => ReturnType<FauxResponseFactory>) => step;
		faux.setResponses([toolUse("send_to_user", { message: "Hello." })]);
		await say("Hi.", chat);
		await settled(chat);
		// The guest is brought in by a mention, and starts a thread.
		faux.setResponses([
			guest(() => toolUse("coding_start", { repo: REPO, task: "Add a greeting", profile: { provider: "coding-faux", model: "coder" } })),
			guest((context) => {
				started = JSON.parse(result(context));
				return toolUse("send_to_user", { message: "Started it." });
			}),
			guest((context) => {
				heard.push(lastUserText(context.messages));
				return toolUse("send_to_user", { message: "Noted." });
			}),
			guest((context) => {
				heard.push(lastUserText(context.messages));
				return toolUse("send_to_user", { message: "Noted the failure." });
			}),
		]);
		codingFaux.setResponses([fauxAssistantMessage("Added the greeting.")]);
		await say("@coach add a greeting to acme/demo.", chat);
		await vi.waitFor(() => expect(started.thread_id).toBeDefined(), { timeout: 10_000 });
		const id = String(started.thread_id);
		const [ended] = await turns(id, 1);

		// It is recorded under the group chat, not under the guest's own conversation, and the guest started it.
		const listed = (await api<{ threads: CodingThreadSummary[] }>("/coding/threads")).body.threads.find((thread) => thread.id === id);
		expect(listed).toMatchObject({ chat, createdBy: { type: "agent", agent: coach.id, chat } });
		// The sidebar shows it under a chat the list has.
		expect((await api<{ sessions: { id: string }[] }>("/sessions")).body.sessions.map((info) => info.id)).toContain(listed!.chat);

		// The guest, not the host, hears that its turn ended, in the room; and again for a failed turn.
		await vi.waitFor(() => expect(heard).toHaveLength(1), { timeout: 10_000 });
		expect(heard[0]).toContain(`[Coding thread ${id}] It finished its turn.`);
		await runInDurableObject(codingThread(env, id), (thread: CodingThreadDO) =>
			(thread as unknown as { eventSink(): CodingEventSink }).eventSink().emit({ ...ended!, operationId: "failed-turn", outcome: "error", reason: "the model failed" }),
		);
		await vi.waitFor(() => expect(heard).toHaveLength(2), { timeout: 10_000 });
		expect(heard[1]).toContain(`[Coding thread ${id}] It stopped with an error (the model failed).`);
		await settled(chat);
		expect((await messagesOf(chat, "user")).filter((text) => text.includes("[Coding thread"))).toEqual([]);
	});

	it("follow, steer and archive the space's threads, and push only once the App is set up, asking first", async () => {
		codingFaux.setResponses([fauxAssistantMessage("Nothing to change."), fauxAssistantMessage("Still nothing.")]);
		const thread = await start();
		await turns(thread.id, 1);
		const results: string[] = [];
		const lastResult = (context: Parameters<FauxResponseFactory>[0]) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			return result?.role === "toolResult" && result.content[0]?.type === "text" ? result.content[0].text : "";
		};
		const step = (name: string, args: Record<string, string>) => (context: Parameters<FauxResponseFactory>[0]) => (results.push(lastResult(context)), toolUse(name, args));
		faux.setResponses([
			toolUse("coding_status", {}),
			step("coding_status", { thread_id: thread.id }),
			step("coding_steer", { thread_id: thread.id, text: "Look again." }),
			step("coding_push", { thread_id: thread.id }),
			step("coding_status", { thread_id: "not-a-thread" }),
			step("send_to_user", { message: "Done." }),
		]);
		await say("How are the coding threads?");
		const [list, status, steered, push, missing] = results.map((result) => JSON.parse(result));
		expect(list.threads[0]).toEqual(expect.objectContaining({ thread_id: thread.id, repo: REPO, status: "idle" }));
		expect(status).toMatchObject({ thread_id: thread.id, url: `https://pim.test/coding/${thread.id}`, status: "idle", branch: thread.repo.branch, budget_usd: null, environment: { state: "none" } });
		expect(steered).toMatchObject({ thread_id: thread.id });
		// Refused before anyone is asked.
		expect(push).toEqual({ error: "github_app_not_configured", message: "GitHub App not configured: ask the Pim owner to set it up" });
		const asked = (await api<{ approvals: Approval[] }>("/approvals")).body.approvals.filter((approval) => (approval.args as { thread_id?: string }).thread_id === thread.id);
		expect(asked).toEqual([]);
		expect(missing).toEqual({ error: "not_found", message: "No coding thread not-a-thread" });
		expect((await turns(thread.id, 2))[1]).toMatchObject({ outcome: "completed", said: "Still nothing." });
		results.length = 0;
		faux.setResponses([toolUse("coding_archive", { thread_id: thread.id }), step("send_to_user", { message: "Archived it." })]);
		await say("Archive it.");
		expect(JSON.parse(results[0]!)).toEqual({ thread_id: thread.id, status: "archived" });
		expect((await view(thread.id)).state).toBe("archived");
	});

	it("read what a thread said, and no other space's thread", async () => {
		// A thread with two turns: the task and a steering, each answered.
		codingFaux.setResponses([fauxAssistantMessage("Added the greeting."), fauxAssistantMessage("Looked again.")]);
		const thread = await start();
		await turns(thread.id, 1);
		await post(`/coding/threads/${thread.id}/steer`, { text: "Look again." });
		await turns(thread.id, 2);
		// Another person's space has a thread of its own, which this space's agent must not find.
		const theirs = await asOther("/coding/threads", { method: "POST", body: JSON.stringify({ repo: REPO, task: "Their own task", profile: CODER }) });
		expect(theirs.status).toBe(201);
		const theirId = ((await theirs.json()) as CodingThreadView).id;

		const answers: string[] = [];
		const lastResult = (context: Parameters<FauxResponseFactory>[0]) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			const text = result?.role === "toolResult" && result.content[0]?.type === "text" ? result.content[0].text : "";
			if (text) answers.push(text);
			return text;
		};
		let whole: { messages: { id: string; role: string; text: string }[]; total: number } | undefined;
		faux.setResponses([
			toolUse("coding_transcript", { thread_id: thread.id, role: "user" }),
			(context) => (lastResult(context), toolUse("coding_transcript", { thread_id: thread.id })),
			(context) => {
				const page = JSON.parse(lastResult(context)) as { messages: { id: string; role: string; text: string }[]; total: number };
				whole = page;
				const answer = page.messages.find((message) => message.role === "assistant" && message.text === "Added the greeting.");
				return toolUse("coding_transcript_output", { thread_id: thread.id, id: answer!.id });
			},
			(context) => (lastResult(context), toolUse("coding_transcript", { thread_id: theirId, role: "user" })),
			(context) => (lastResult(context), toolUse("send_to_user", { message: "Read it." })),
		]);
		await say("What did the coding thread say?");
		const ofUser = JSON.parse(answers[0]!);
		const output = answers[2]!;
		const denied = JSON.parse(answers[3]!);
		// The role filter keeps what the thread was told, oldest first, and counts just those.
		expect(ofUser).toEqual({
			messages: [
				{ id: expect.any(String), role: "user", text: "Add a greeting" },
				{ id: expect.any(String), role: "user", text: "Look again." },
			],
			total: 2,
		});
		// The whole page has both turns' answers, and one message read whole is its text, uncut.
		expect(whole).toMatchObject({ total: 4 });
		expect(whole!.messages.map((message) => message.text)).toContain("Looked again.");
		expect(output).toBe("Added the greeting.");
		// Another space's thread is not this space's, however asked.
		expect(denied).toEqual({ error: "not_found", message: `No coding thread ${theirId}` });
	});

	it("start on the space's own model unless told another", async () => {
		expect(await (await getAgentByName(env.Pim, OWNER)).codingDefaultProfile()).toEqual({ providerId: "faux", model: "faux-model" });
	});
});

/**
 * GitHub as a push to acme/demo sees it: the repository, its branches (`refs`, none unless given),
 * and receive-pack, which takes every update. It moves a branch through the API as GitHub does
 * without force: the answers in `patchAnswers`, one for each, are the status it gives (422 as if
 * the branch had moved), and 200 once they run out. Every move of a branch is kept in `moves`.
 */
function fakeGitHub(refs: Record<string, string> = {}, patchAnswers: number[] = []) {
	const encoder = new TextEncoder();
	const pushes: string[] = [];
	const moves: { ref: string; sha: unknown; force: unknown }[] = [];
	const lines = (...payloads: string[]) => {
		const parts = payloads.map((payload) => (payload === "" ? encoder.encode("0000") : pktLine(payload)));
		const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
		let at = 0;
		for (const part of parts) {
			out.set(part, at);
			at += part.length;
		}
		return out;
	};
	const pulls: { head: string; base: string; title: string; body: string }[] = [];
	const app = { installationToken: async () => ({ token: "ghs_test", expiresAt: Date.now() + 3_600_000 }) } as unknown as GitHubApp;
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "https://api.github.com/repos/acme/demo") return Response.json({ default_branch: "main" });
		if (url === "https://github.com/acme/demo.git/info/refs?service=git-receive-pack") {
			const listed = Object.entries(refs).map(([ref, sha], index) => `${sha} ${ref}${index === 0 ? "\0report-status delete-refs ofs-delta quiet" : ""}\n`);
			return new Response(lines("# service=git-receive-pack\n", "", ...(listed.length ? listed : [`${"0".repeat(40)} capabilities^{}\0report-status delete-refs ofs-delta quiet\n`]), ""), {
				headers: { "content-type": "application/x-git-receive-pack-advertisement" },
			});
		}
		if (url === "https://api.github.com/repos/acme/demo/pulls" && init?.method === "POST") {
			pulls.push(JSON.parse(String(init.body)));
			return Response.json({ html_url: `https://github.com/acme/demo/pull/${pulls.length}`, number: pulls.length }, { status: 201 });
		}
		if (init?.method === "PATCH" && url.startsWith("https://api.github.com/repos/acme/demo/git/")) {
			const { sha, force } = JSON.parse(String(init.body)) as { sha: unknown; force: unknown };
			moves.push({ ref: url.slice("https://api.github.com/repos/acme/demo/git/".length), sha, force });
			return new Response("{}", { status: patchAnswers.shift() ?? 200 });
		}
		if (url === "https://github.com/acme/demo.git/git-receive-pack") {
			const body = new TextDecoder("latin1").decode(init!.body as Uint8Array);
			const command = body.slice(4, body.indexOf("\0"));
			pushes.push(command);
			return new Response(lines("unpack ok\n", `ok ${command.split(" ")[2]}\n`, ""), { headers: { "content-type": "application/x-git-receive-pack-result" } });
		}
		return new Response("Not found", { status: 404 });
	};
	return { app, fetch, pushes, moves, pulls };
}

describe("threads from before harnesses", () => {
	it("become pi threads in the thread's own tables and in the space's list", async () => {
		await runInDurableObject(env.Pim.getByName("legacy-harness"), async (_pim, state) => {
			const sql = state.storage.sql;
			sql.exec(`CREATE TABLE coding_thread (thread_id TEXT PRIMARY KEY, space TEXT NOT NULL, repo_url TEXT NOT NULL, base_ref TEXT NOT NULL, base_sha TEXT, branch TEXT NOT NULL, agent_profile TEXT NOT NULL,
				provider_id TEXT NOT NULL, workspace_ref TEXT, state TEXT NOT NULL, state_reason TEXT, state_detail TEXT, created_by TEXT NOT NULL, parent_thread TEXT, limits TEXT NOT NULL,
				budget_usd REAL NOT NULL DEFAULT 3, spent_usd REAL NOT NULL DEFAULT 0, start_operation TEXT NOT NULL, slot TEXT NOT NULL DEFAULT 'none', slot_since INTEGER,
				resume_priority INTEGER NOT NULL DEFAULT 0, current_operation TEXT, budget_stopped INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
			sql.exec(
				`INSERT INTO coding_thread (thread_id, space, repo_url, base_ref, branch, agent_profile, provider_id, state, created_by, limits, start_operation, created_at, updated_at)
				VALUES ('old', 's', 'https://github.com/acme/demo', 'main', 'pim/old', '{}', 'p', 'idle', 's', '{}', 'op', 1, 1)`,
			);
			sql.exec(`CREATE TABLE pim_coding_threads (thread_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, parent TEXT, task TEXT NOT NULL, repo TEXT NOT NULL, ref TEXT NOT NULL,
				branch TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'provisioning', state_reason TEXT, spent_usd REAL NOT NULL DEFAULT 0, budget_usd REAL NOT NULL,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)`);
			sql.exec(`INSERT INTO pim_coding_threads (thread_id, created_by, task, repo, ref, budget_usd, created_at) VALUES ('old', '{"type":"person"}', 'Task', 'r', 'main', 3, 1)`);
			expect(new CodingThreadStore(sql).required().harness).toBe("pi");
			expect(new CodingThreadIndex(sql).get("old")).toMatchObject({ harness: "pi", chat: null });
			// Opening them again changes nothing.
			expect(new CodingThreadStore(sql).required().harness).toBe("pi");
		});
	});
});

describe("what an agent hears of a coding thread's failure", () => {
	const ended = { type: "thread.turn_ended", threadId: "T-9", space: "s", operationId: "failed-workspace-1", outcome: "error", reason: "workspace", state: "failed", spentUsd: 0, budgetUsd: 1, at: 1 } as const;

	it("says what went wrong and to retry once if it looks transient", () => {
		const message = turnEndedMessage({ ...ended, detail: "manager answered 502" }, "https://pim.test");
		expect(message.startsWith("[Coding thread T-9] It stopped with an error (workspace).")).toBe(true);
		expect(CODING_EVENT.test(message)).toBe(true);
		expect(message).toContain("Detail: manager answered 502");
		expect(message).toContain("retry once by starting a fresh thread with the same task");
	});

	it("has neither for a turn that didn't fail", () => {
		const message = turnEndedMessage({ ...ended, outcome: "completed", state: "idle" }, null);
		expect(message).not.toContain("Detail:");
		expect(message).not.toContain("retry once");
	});
});

describe("listing thread activity", () => {
	const activity: Activity = { running: true, lastActivityAt: 100, current: [], steps: [], stalls: [] };
	const listed = (state: IndexedThread["state"], index: number): import("../src/coding/thread-index").IndexedThread & { queue: null } => ({
		threadId: `list-thread-${index}`, createdBy: { type: "person" }, parent: null, chat: null, harness: "pi", task: "Run a test", repo: REPO, ref: "main", branch: "pim/test", state, stateReason: null, spentUsd: 0, budgetUsd: null, createdAt: index, updatedAt: index, lastTurnEndedAt: null, lastSeenAt: null, queue: null,
	});
	const listEnv = (threads: ReturnType<typeof listed>[], read: (id: string) => Promise<typeof activity>) => {
		const get = vi.fn((id: string) => ({ activity: () => read(id) }));
		const bindings = {
			CodingScheduler: { getByName: () => ({ threads: async () => threads }) },
			CodingThread: { getByName: get },
		} as unknown as Env;
		return { bindings, get };
	};

	it("reads activity only for running threads and leaves every other state unwoken", async () => {
		const threads = (["idle", "running", "archived", "failed", "queued", "waiting_input", "provisioning", "running"] as const).map(listed);
		const { bindings, get } = listEnv(threads, async () => activity);
		const items = await listThreads(bindings, "list-space");
		expect(get.mock.calls.map(([id]) => id)).toEqual(["list-thread-1", "list-thread-7"]);
		expect(items.map((item) => item.id)).toEqual(threads.map((thread) => thread.threadId));
		for (const item of items) expect(item.activity).toEqual(item.state === "running" ? activity : undefined);
	}, 10_000);

	it("bounds activity reads to eight and keeps listing after one fails", async () => {
		const threads = Array.from({ length: 19 }, (_, index) => listed("running", index));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let started!: () => void;
		const firstWave = new Promise<void>((resolve) => { started = resolve; });
		let active = 0;
		let peak = 0;
		const { bindings, get } = listEnv(threads, async (id) => {
			active++;
			peak = Math.max(peak, active);
			if (active === 8) started();
			try {
				await gate;
				if (id === "list-thread-3") throw new Error("Thread unavailable");
				return activity;
			} finally {
				active--;
			}
		});
		const pending = listThreads(bindings, "list-space");
		await firstWave;
		try {
			expect(get).toHaveBeenCalledTimes(8);
			expect(active).toBe(8);
		} finally {
			release();
		}
		const items = await pending;
		expect(peak).toBe(8);
		expect(active).toBe(0);
		expect(get).toHaveBeenCalledTimes(19);
		expect(items.map((item) => item.id)).toEqual(threads.map((thread) => thread.threadId));
		expect(items[3]?.activity).toBeUndefined();
		expect(items.filter((item) => item.activity === activity)).toHaveLength(18);
	}, 10_000);
});
