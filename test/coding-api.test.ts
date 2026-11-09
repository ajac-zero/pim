import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingThreadSummary, CodingThreadView } from "../src/coding/api";
import { pktLine } from "../src/coding/git-broker/broker";
import type { GitHubApp } from "../src/coding/git-broker/github-app";
import { DEFAULT_SPACE_CAP } from "../src/coding/provider-capacity";
import { codingScheduler } from "../src/coding/scheduler-do";
import { type CodingEventSink, codingThread } from "../src/coding/thread-do";
import { CodingThreadIndex } from "../src/coding/thread-index";
import { CodingThreadStore } from "../src/coding/thread-store";
import type { Approval } from "../src/store";
import { fakeRemotes, hex40 } from "./fake-git";
import { api, apiUrl, lastUserText, messagesOf, OWNER, post, say, settled, TOKEN, toolUse } from "./helpers";
import { type CodingThreadDO, codingEvents, codingFaux, codingGitHub, faux } from "./worker";

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
		expect((await api<{ threads: unknown[] }>("/coding/threads")).body.threads).toHaveLength(before);
	});

	it("keeps each thread's harness, pi unless given, and the thread it continues from", async () => {
		codingFaux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Done too.")]);
		const first = await start();
		expect(first.harness).toBe("pi");
		const second = await start({ task: "Write the docs", harness: "codex", parent: first.id });
		expect(second).toMatchObject({ harness: "codex", parentThread: first.id });
		await turns(first.id, 1);
		await turns(second.id, 1);
		const { threads } = (await api<{ threads: CodingThreadSummary[] }>("/coding/threads")).body;
		expect(threads.find((thread) => thread.id === first.id)).toMatchObject({ harness: "pi", parent: null, createdBy: { type: "person" } });
		expect(threads.find((thread) => thread.id === second.id)).toMatchObject({ harness: "codex", parent: first.id, createdBy: { type: "person" } });
		expect((await view(second.id)).harness).toBe("codex");
		const refused = await post("/coding/threads", { repo: REPO, task: "Add a greeting", profile: CODER, harness: "aider" });
		expect([refused.status, refused.body]).toEqual([400, { error: "harness must be pi, claude-code, codex", code: "invalid" }]);
	});

	it("reads threads from before there was a harness as pi's", async () => {
		/** Makes `table` again as it was before its harness column, with one row. */
		const asBefore = (sql: SqlStorage, table: string, row: Record<string, SqlStorageValue>) => {
			const schema = String(sql.exec("SELECT sql FROM sqlite_master WHERE name = ?", table).one().sql);
			sql.exec(`DROP TABLE ${table}`);
			sql.exec(schema.replace(/\s*harness TEXT NOT NULL DEFAULT 'pi',/, ""));
			expect(sql.exec(`PRAGMA table_info(${table})`).toArray().map((column) => column.name)).not.toContain("harness");
			const names = Object.keys(row);
			sql.exec(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, ...Object.values(row));
		};
		const id = crypto.randomUUID();
		await runInDurableObject(codingScheduler(env, `space-${id}`), (_scheduler, state) => {
			asBefore(state.storage.sql, "pim_coding_threads", { thread_id: id, created_by: '{"type":"person"}', task: "Old", repo: REPO, ref: "main", budget_usd: 3, created_at: 1 });
			expect(new CodingThreadIndex(state.storage.sql).get(id)).toMatchObject({ threadId: id, harness: "pi" });
		});
		await runInDurableObject(codingThread(env, id), (_thread, state) => {
			asBefore(state.storage.sql, "coding_thread", {
				thread_id: id,
				space: "space",
				repo_url: REPO,
				base_ref: "main",
				branch: "pim/old",
				agent_profile: JSON.stringify(CODER),
				provider_id: "none",
				state: "idle",
				created_by: "space",
				limits: "{}",
				start_operation: "op",
				created_at: 1,
				updated_at: 1,
			});
			expect(new CodingThreadStore(state.storage.sql).required()).toMatchObject({ threadId: id, harness: "pi" });
		});
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
		const pending = async () => (await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals.filter((approval) => approval.action === "coding_push");
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
		expect(started).toMatchObject({ url: `https://pim.test/coding/${id}`, status: expect.any(String), branch: expect.stringMatching(/^pim\/add-a-greeting-/), harness: "pi" });
		const [ended] = await turns(id, 1);
		await vi.waitFor(() => expect(woken).not.toBe(""), { timeout: 10_000 });
		expect(woken).toContain(`[Coding thread ${id}] It finished its turn.`);
		expect(woken).toContain("State: idle. Spent $0.00 of its $1 budget.");
		expect(woken).toContain(`Link: https://pim.test/coding/${id}`);
		expect(woken).toContain("It last said:\nAdded the greeting.");
		// The list says which agent started it, from which chat.
		const listed = (await api<{ threads: CodingThreadSummary[] }>("/coding/threads")).body.threads.find((thread) => thread.id === id);
		expect(listed).toMatchObject({ createdBy: { type: "agent", agent: expect.any(String), chat }, parent: null, harness: "pi" });
		expect((await view(id)).createdBy).toEqual(listed!.createdBy);
		// The same turn's end told again wakes nobody.
		await runInDurableObject(codingThread(env, id), (thread: CodingThreadDO) => (thread as unknown as { eventSink(): CodingEventSink }).eventSink().emit(ended!));
		await settled(chat);
		expect((await messagesOf(chat, "user")).filter((text) => text.includes("[Coding thread"))).toHaveLength(1);
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
		expect(list.threads[0]).toEqual(expect.objectContaining({ thread_id: thread.id, repo: REPO, status: "idle", harness: "pi" }));
		expect(status).toMatchObject({ thread_id: thread.id, url: `https://pim.test/coding/${thread.id}`, status: "idle", branch: thread.repo.branch, harness: "pi", budget_usd: 3 });
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

	it("start on the space's own model unless told another", async () => {
		expect(await (await getAgentByName(env.Pim, OWNER)).codingDefaultProfile()).toEqual({ providerId: "faux", model: "faux-model" });
	});
});

/** GitHub as a push to a new branch of acme/demo sees it: the repository, its branches (none), and receive-pack, which takes every update. */
function fakeGitHub() {
	const encoder = new TextEncoder();
	const pushes: string[] = [];
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
	const app = { installationToken: async () => ({ token: "ghs_test", expiresAt: Date.now() + 3_600_000 }) } as unknown as GitHubApp;
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "https://api.github.com/repos/acme/demo") return Response.json({ default_branch: "main" });
		if (url === "https://github.com/acme/demo.git/info/refs?service=git-receive-pack") {
			return new Response(lines("# service=git-receive-pack\n", "", `${"0".repeat(40)} capabilities^{}\0report-status delete-refs ofs-delta quiet\n`, ""), {
				headers: { "content-type": "application/x-git-receive-pack-advertisement" },
			});
		}
		if (url === "https://github.com/acme/demo.git/git-receive-pack") {
			const body = new TextDecoder("latin1").decode(init!.body as Uint8Array);
			const command = body.slice(4, body.indexOf("\0"));
			pushes.push(command);
			return new Response(lines("unpack ok\n", `ok ${command.split(" ")[2]}\n`, ""), { headers: { "content-type": "application/x-git-receive-pack-result" } });
		}
		return new Response("Not found", { status: 404 });
	};
	return { app, fetch, pushes };
}
