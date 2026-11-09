import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyBrokerToken } from "../src/coding/git-broker/broker";
import { brokerTokenKey } from "../src/coding/git-broker/routes";
import { codingScheduler } from "../src/coding/scheduler-do";
import { CONTINUE_TEXT, codingThread, type StartThread } from "../src/coding/thread-do";
import { REPO_DIR } from "../src/coding/tools";
import { NO_BACKEND_MESSAGE, NoWorkspaceBackendError, workspaceBackends } from "../src/coding/workspace/registry";
import { fakeClones, fakeRemotes } from "./fake-git";
import { OWNER, post, toolUse } from "./helpers";
import { type CodingThreadDO, codingEvents, codingFaux, codingSchedulers, codingWorkspaces } from "./worker";

// Each thread here works in the in-memory workspace with a fake git, with the real coding tools, talks to the scripted
// `coding-faux` model, and asks a scheduler of its own space for a slot; the schedulers tell threads what happens to them
// for real. Workspaces clone through the git broker on this Pim, https://pim.test, which the fake git stands in for.

const REPO = "https://github.com/acme/demo";
const BROKER_URL = "https://pim.test/api/coding/git/acme/demo.git";
fakeRemotes.set(BROKER_URL, { "README.md": "# Demo\n" });

const CODER = { providerId: "coding-faux", model: "coder" };

type Stub = DurableObjectStub<CodingThreadDO>;

function startInput(id: string, overrides: Partial<StartThread> = {}): StartThread {
	return { space: `space-${id}`, repo: REPO, task: "Add a greeting", profile: CODER, createdBy: "tester", operationId: `start-${id}`, ...overrides };
}

async function startThread(overrides: Partial<StartThread> = {}) {
	const id = crypto.randomUUID();
	const stub = codingThread(env, id);
	const input = startInput(id, overrides);
	const status = await stub.start(input);
	return { id, stub, input, status };
}

/** The thread's `thread.turn_ended` events, once it has had `count`. With `wake`, asks for its status meanwhile, which starts a thread that was reset. */
async function turns(id: string, count: number, wake = false) {
	return vi.waitFor(
		async () => {
			// A stub of an object that was reset is broken: each try takes a new one.
			if (wake) await codingThread(env, id).status();
			const ended = codingEvents.filter((event) => event.threadId === id);
			expect(ended).toHaveLength(count);
			return ended;
		},
		{ timeout: 15_000, interval: 50 },
	);
}

/**
 * Calls the thread in its object rather than over RPC, for calls that throw: the Workers test pool reports an error
 * thrown across RPC as unhandled, though the caller catches it.
 */
const inside = <T>(stub: Stub, call: (thread: CodingThreadDO) => Promise<T>) => runInDurableObject(stub, (instance: CodingThreadDO) => call(instance));

/** Every row of every table the thread's object keeps, as one text, to look for what must never be stored. */
const everything = (stub: Stub) =>
	runInDurableObject(stub, (_instance: CodingThreadDO, state) => {
		const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray();
		return JSON.stringify(tables.map(({ name }) => state.storage.sql.exec(`SELECT * FROM "${String(name)}"`).toArray()));
	});

/** The thread's workspace, as its provider has it. */
async function workspaceOf(id: string) {
	const [info] = await codingWorkspaces.list({ sessionId: id });
	return (await codingWorkspaces.get(info!.ref))!;
}

const fileIn = async (id: string, path: string) => new TextDecoder().decode(await (await workspaceOf(id)).readFile(`${REPO_DIR}/${path}`));

const sql = (stub: Stub, query: string) => runInDurableObject(stub, (_instance: CodingThreadDO, state) => state.storage.sql.exec(query).toArray());

/** The text the model was last sent, its system prompt included. */
const sent = (context: Context) => JSON.stringify(context);

beforeEach(() => {
	codingSchedulers.notifier = null;
	codingSchedulers.now = null;
	codingEvents.length = 0;
});

afterEach(() => {
	// Every scripted response was used: the thread called its model as the test expected.
	expect(codingFaux.getPendingResponseCount()).toBe(0);
});

describe("a coding thread", () => {
	it("starts once per operation, on a branch of its own, and runs its task as one turn", async () => {
		let prompt = "";
		codingFaux.setResponses([
			(context) => {
				prompt = sent(context);
				return fauxAssistantMessage("Nothing to change.");
			},
		]);
		const { id, stub, input, status } = await startThread();
		expect(status.state).toMatch(/^(provisioning|running)$/);
		expect(status.repo).toMatchObject({ url: REPO, ref: "main", branch: `pim/add-a-greeting-${id.replaceAll("-", "").slice(0, 8)}` });
		expect(status.budgetUsd).toBe(3);
		const again = await stub.start(input);
		expect(again.createdAt).toBe(status.createdAt);
		await expect(inside(stub, (thread) => thread.start({ ...input, operationId: "another" }))).rejects.toThrow(/already started/);
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ type: "thread.turn_ended", threadId: id, space: input.space, operationId: input.operationId, outcome: "completed" });
		const idle = await stub.status();
		expect(idle).toMatchObject({ state: "idle", slot: "held", currentOperation: null, inbox: 0, repo: { baseSha: "base0000" } });
		// The coding agent's instructions and where the repository is.
		expect(prompt).toContain("run the repository's tests");
		expect(prompt).toContain(`checked out at ${REPO_DIR}, on the branch ${idle.repo.branch}`);
		// One model call, priced from the catalog: $1 per million tokens.
		const calls = (await stub.log()).filter((event) => event.kind === "model_call");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ provider: "coding-faux", model: "coder" });
		expect(calls[0]!.costUsd).toBeCloseTo((calls[0]!.input + calls[0]!.output) / 1_000_000, 12);
		expect(idle.spentUsd).toBeCloseTo(calls[0]!.costUsd, 12);
		// Between turns its slot's thread is idle.
		expect((await codingScheduler(env, input.space).snapshot()).running.map((slot) => `${slot.threadId}:${slot.activity}`)).toEqual([`${id}:idle`]);
		// It cloned through the broker, with a token for this thread and repository alone that it never stored.
		const clone = fakeClones.findLast((each) => each.env.GIT_CONFIG_VALUE_0 !== undefined && each.url === BROKER_URL)!;
		const token = clone.env.GIT_CONFIG_VALUE_0!.replace(/^Authorization: Bearer /, "");
		expect(clone.env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
		expect(await verifyBrokerToken(await brokerTokenKey(env), token)).toMatchObject({ sessionId: id, repo: "acme/demo" });
		expect(await everything(stub)).not.toContain(token);
		// Nothing changed, so there is no checkpoint and no diff.
		expect(idle.checkpoint).toBeNull();
		expect((await stub.diff()).diff).toBe("");
		// The web app can follow it: a snapshot first.
		const reader = (await stub.events()).getReader();
		let first = "";
		while (!first.includes("\n")) first += new TextDecoder().decode((await reader.read()).value);
		expect(JSON.parse(first.split("\n")[0]!)).toMatchObject({ type: "snapshot" });
		await reader.cancel();
	});

	it("refuses a repository not on GitHub, or a model the space doesn't have, recording nothing", async () => {
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		await expect(inside(stub, (thread) => thread.start(startInput(id, { repo: "https://gitlab.com/acme/demo.git" })))).rejects.toThrow(
			"A repository must be https://github.com/<owner>/<name>",
		);
		await expect(inside(stub, (thread) => thread.start(startInput(id, { profile: { providerId: "coding-faux", model: "nope" } })))).rejects.toThrow("has no model nope");
		await expect(inside(stub, (thread) => thread.start(startInput(id, { profile: { providerId: "own:nope", model: "x" } })))).rejects.toThrow("no model provider own:nope");
		await expect(inside(stub, (thread) => thread.status())).rejects.toThrow("never started");
	});

	it("fails with no_backend, saying why, when the deployment has no workspace backend for it", async () => {
		const { stub, input, status } = await startThread({ workspaceProvider: "compose" });
		expect(status).toMatchObject({ state: "failed", stateReason: "no_backend", stateDetail: 'This Pim has no workspace backend "compose" for coding threads.', slot: "none", inbox: 1 });
		expect(await codingScheduler(env, input.space).snapshot()).toMatchObject({ running: [], queued: [] });
		// Continuing doesn't help until there is one.
		expect(await stub.continue({ operationId: "again" })).toMatchObject({ state: "failed", stateReason: "no_backend" });
	});

	it("takes its backends from the deployment's environment", () => {
		const none = workspaceBackends({});
		expect(none.defaultId()).toBeNull();
		expect(() => none.get("compose")).toThrow(new NoWorkspaceBackendError(NO_BACKEND_MESSAGE));
		expect(() => workspaceBackends({ PIM_CODING_MANAGER_URL: "https://manager.example" }).get("compose")).toThrow("PIM_CODING_MANAGER_TOKEN isn't set");
		// The Compose provider isn't in this build yet: a configured manager still says so rather than failing later.
		expect(() => workspaceBackends({ PIM_CODING_MANAGER_URL: "https://manager.example", PIM_CODING_MANAGER_TOKEN: "t" }).get("compose")).toThrow("no Compose workspace provider yet");
	});

	it("runs the model's calls to the real tools in its workspace, commits a checkpoint, and keeps its diff, tests, journal and output", async () => {
		const results: string[] = [];
		const lastResult = (context: Context) => {
			const message = context.messages.findLast((each) => each.role === "toolResult");
			return message?.role === "toolResult" ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
		};
		codingFaux.setResponses([
			toolUse("write", { path: "hello.txt", content: "Hello!\n" }),
			(context) => (results.push(lastResult(context)), toolUse("bash", { command: "echo hi from bash" })),
			(context) => (results.push(lastResult(context)), toolUse("test", { command: 'echo "2 passed in 0.01s"' })),
			(context) => (results.push(lastResult(context)), toolUse("git", { subcommand: "diff" })),
			(context) => (results.push(lastResult(context)), fauxAssistantMessage("Added hello.txt; the tests pass.")),
		]);
		// Following it from before it starts, as the web app would.
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		const reader = (await stub.events()).getReader();
		await stub.start(startInput(id));
		const [ended] = await turns(id, 1);
		const [wrote, bash, test, diff] = results;
		expect(wrote).toContain("hello.txt");
		expect(bash).toContain("hi from bash");
		expect(test).toContain("[Tests: 0 failed, 2 passed, 0 skipped (2 total), read from pytest output.]");
		expect(diff).toBe("diff --git a/hello.txt b/hello.txt\n--- /dev/null\n+++ b/hello.txt\n+Hello!\n");
		const status = await stub.status();
		expect(status.checkpoint).toMatchObject({ message: `Checkpoint 1 (start-${id})`, operationId: `start-${id}` });
		expect(ended).toMatchObject({ outcome: "completed", checkpoint: status.checkpoint!.sha });
		// The file is in the workspace, committed on the thread's branch.
		expect(await fileIn(id, "hello.txt")).toBe("Hello!\n");
		expect(await stub.diff()).toEqual({
			since: "base0000",
			head: status.checkpoint!.sha,
			diff: "diff --git a/hello.txt b/hello.txt\n--- /dev/null\n+++ b/hello.txt\n+Hello!\n",
			truncated: false,
		});
		expect(await stub.tests()).toEqual([
			expect.objectContaining({ command: 'echo "2 passed in 0.01s"', exitCode: 0, timedOut: false, summary: { format: "pytest", passed: 2, failed: 0, skipped: 0, total: 2 }, output: "2 passed in 0.01s\n" }),
		]);
		// Every call that changes things is in the durable journal, finished.
		const journal = (await sql(stub, "SELECT tool, entry FROM coding_tool_journal ORDER BY tool")).map((row) => ({ tool: row.tool, state: JSON.parse(String(row.entry)).state }));
		expect(journal).toEqual([
			{ tool: "bash", state: "done" },
			{ tool: "test", state: "done" },
			{ tool: "write", state: "file" },
		]);
		// The web app saw the commands' output as it was printed.
		const decoder = new TextDecoder();
		let lines = "";
		while (!lines.includes('"type":"output"')) lines += decoder.decode((await reader.read()).value);
		expect(lines).toMatch(/"type":"output","tool":"bash","callId":"[^"]+","data":"hi from bash\\n"/);
		await reader.cancel();
	});

	it("takes a steer into the turn under way", async () => {
		let second = "";
		codingFaux.setResponses([
			toolUse("bash", { command: "sleep 1" }),
			(context) => {
				second = sent(context);
				return fauxAssistantMessage("Done, in Spanish.");
			},
		]);
		const { id, stub } = await startThread();
		await vi.waitFor(async () => expect((await stub.status()).state).toBe("running"));
		await stub.steer("Write the greeting in Spanish.", { operationId: "steer-1" });
		const [ended] = await turns(id, 1);
		expect(ended!.outcome).toBe("completed");
		expect(second).toContain("Write the greeting in Spanish.");
		expect((await stub.status()).state).toBe("idle");
	});

	it("aborts a turn, killing the command it runs", async () => {
		codingFaux.setResponses([toolUse("bash", { command: "sleep 30" })]);
		const { id, stub } = await startThread();
		await vi.waitFor(async () => expect(await sql(stub, "SELECT tool FROM coding_tool_journal")).toHaveLength(1));
		const stopping = Date.now();
		const status = await stub.abort();
		expect(Date.now() - stopping).toBeLessThan(5_000);
		expect(status).toMatchObject({ state: "idle", currentOperation: null });
		const [ended] = await turns(id, 1);
		expect(ended!.outcome).toBe("cancelled");
		// The thread killed the command itself, before pi aborted the call, so the call saw it killed.
		expect((await sql(stub, "SELECT entry FROM coding_tool_journal")).map((row) => JSON.parse(String(row.entry)))).toEqual([
			expect.objectContaining({ state: "done", tool: "bash", isError: true, text: "(no output)\n[Killed by SIGTERM.]" }),
		]);
	});

	it("fails on a model error, gives its slot back, and continues", async () => {
		let resumed = "";
		codingFaux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request: unknown parameter" }),
			(context) => {
				resumed = sent(context);
				return fauxAssistantMessage("Picked it up again.");
			},
		]);
		const { id, stub, input } = await startThread();
		const [failed] = await turns(id, 1);
		expect(failed).toMatchObject({ outcome: "error", reason: "model_error" });
		expect(await stub.status()).toMatchObject({ state: "failed", stateReason: "model_error", slot: "none" });
		expect((await codingScheduler(env, input.space).snapshot()).running).toEqual([]);
		// Its workspace is gone, its files kept for the next one.
		expect(await codingWorkspaces.list({ sessionId: id })).toEqual([]);
		await stub.continue({ operationId: "continue-1" });
		const [, ended] = await turns(id, 2);
		expect(ended).toMatchObject({ outcome: "completed", operationId: "continue-1" });
		expect(resumed).toContain(CONTINUE_TEXT);
		expect(await stub.status()).toMatchObject({ state: "idle", slot: "held", stateReason: null });
	});

	it("stops at its budget before the next model call", async () => {
		codingFaux.setResponses([toolUse("bash", { command: "echo hi" })]);
		const { id, stub, input } = await startThread({ profile: { providerId: "coding-faux", model: "pricey" }, budgetUsd: 0.5 });
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "error", reason: "budget" });
		const status = await stub.status();
		expect(status).toMatchObject({ state: "failed", stateReason: "budget", slot: "none" });
		// The one call it made cost $1 a token, past the budget; the next was never sent.
		expect(status.spentUsd).toBeGreaterThanOrEqual(1);
		expect((await stub.log()).map((event) => event.kind)).toEqual(["model_call", "thread.turn_ended", "app.budget_stop"]);
		const transcript = await inside(stub, (thread) => thread.transcript());
		expect(transcript.at(-1)).toMatchObject({ role: "notice", parts: [{ type: "text", text: expect.stringMatching(/^Stopped: the thread spent \$\d+\.\d\d of its \$0\.5 budget\.$/) }] });
		expect((await codingScheduler(env, input.space).snapshot()).running).toEqual([]);
		await expect(inside(stub, (thread) => thread.continue({ operationId: "more" }))).rejects.toThrow(/spent its \$0\.5 budget/);
		await expect(inside(stub, (thread) => thread.steer("Go on.", { operationId: "more" }))).rejects.toThrow(/budget/);
	});

	it("gives its workspace up when its idle slot is taken back, and gets both again, files kept, for its next turn", async () => {
		codingFaux.setResponses([toolUse("write", { path: "a.txt", content: "A\n" }), fauxAssistantMessage("Wrote a.txt."), fauxAssistantMessage("Still here.")]);
		const { id, stub, input } = await startThread();
		await turns(id, 1);
		const scheduler = codingScheduler(env, input.space);
		codingSchedulers.now = Date.now() + 31 * 60_000;
		expect(await scheduler.sweep()).toEqual({ released: [{ threadId: id, why: "idle" }], admitted: [] });
		await runDurableObjectAlarm(scheduler);
		codingSchedulers.now = null;
		expect(await stub.status()).toMatchObject({ state: "idle", slot: "none" });
		expect(await codingWorkspaces.list({ sessionId: id })).toEqual([]);
		// The checkpoint's diff is kept without a workspace.
		expect((await stub.diff()).diff).toContain("+++ b/a.txt");
		await stub.steer("Anything else?", { operationId: "steer-2" });
		const [, ended] = await turns(id, 2);
		expect(ended).toMatchObject({ outcome: "completed", operationId: "steer-2" });
		expect(await stub.status()).toMatchObject({ state: "idle", slot: "held", repo: { baseSha: "base0000" } });
		expect(await fileIn(id, "a.txt")).toBe("A\n");
		expect(await stub.checkpoints()).toHaveLength(1);
	});

	it("waits in the queue while its space's slots are taken, and runs once archiving another frees one", async () => {
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		await scheduler.setLimit(1);
		codingFaux.setResponses([fauxAssistantMessage("First done."), fauxAssistantMessage("Second done.")]);
		const first = await startThread({ space });
		await turns(first.id, 1);
		const second = await startThread({ space });
		expect(second.status).toMatchObject({ state: "queued", slot: "queued", queue: { position: 1, reason: "slots_full" } });
		expect((await scheduler.snapshot()).running.map((slot) => slot.threadId)).toEqual([first.id]);
		expect(await first.stub.archive()).toMatchObject({ state: "archived", slot: "none" });
		// The first's workspace is gone for good, and its slot went to the second, which was told and ran its task.
		expect(await codingWorkspaces.list({ sessionId: first.id })).toEqual([]);
		const [ended] = await turns(second.id, 1);
		expect(ended!.outcome).toBe("completed");
		expect(await second.stub.status()).toMatchObject({ state: "idle", slot: "held" });
		expect((await scheduler.snapshot()).running.map((slot) => slot.threadId)).toEqual([second.id]);
		await second.stub.archive();
		expect((await scheduler.snapshot()).running).toEqual([]);
		await expect(inside(second.stub, (thread) => thread.steer("More?", { operationId: "late" }))).rejects.toThrow("archived");
	});

	it("checkpoints and gives its workspace up when its slot is taken back while it waits, then asks again at the head of the queue", async () => {
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		await scheduler.setLimit(1);
		codingFaux.setResponses([fauxAssistantMessage("First done."), fauxAssistantMessage("Second done."), fauxAssistantMessage("First again.")]);
		const first = await startThread({ space });
		await turns(first.id, 1);
		// As a thread waiting for the person says, with a change in its workspace not committed yet.
		await scheduler.setActivity(first.id, "waiting");
		await (await workspaceOf(first.id)).writeFile(`${REPO_DIR}/notes.txt`, new TextEncoder().encode("Draft\n"));
		const second = await startThread({ space });
		expect(second.status.state).toBe("queued");
		codingSchedulers.now = Date.now() + 6 * 60_000;
		expect(await scheduler.sweep()).toEqual({ released: [{ threadId: first.id, why: "preempted" }], admitted: [second.id] });
		await runDurableObjectAlarm(scheduler);
		codingSchedulers.now = null;
		expect(await first.stub.status()).toMatchObject({ state: "idle", slot: "none" });
		expect(await first.stub.checkpoints()).toEqual([expect.objectContaining({ message: "Checkpoint 1", operationId: null })]);
		expect((await first.stub.diff()).diff).toContain("+Draft");
		expect(await codingWorkspaces.list({ sessionId: first.id })).toEqual([]);
		await turns(second.id, 1);
		// Its next turn waits ahead of anyone who asks at the usual priority.
		await first.stub.steer("Carry on.", { operationId: "resume" });
		await vi.waitFor(async () => expect(await first.stub.status()).toMatchObject({ state: "queued", queue: { position: 1 } }));
		expect((await scheduler.snapshot()).queued).toEqual([expect.objectContaining({ threadId: first.id, priority: 1000 })]);
		await second.stub.archive();
		const [, again] = await turns(first.id, 2);
		expect(again).toMatchObject({ outcome: "completed", operationId: "resume" });
		expect(await fileIn(first.id, "notes.txt")).toBe("Draft\n");
		await first.stub.archive();
	});

	it("fails when it waits in the queue past its deadline", async () => {
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		await scheduler.setLimit(1);
		codingFaux.setResponses([fauxAssistantMessage("First done.")]);
		const first = await startThread({ space });
		await turns(first.id, 1);
		const second = await startThread({ space });
		expect(second.status.state).toBe("queued");
		// Seven hours on: the second waited past its six, and the first was idle past its half hour.
		codingSchedulers.now = Date.now() + 7 * 60 * 60_000;
		await runDurableObjectAlarm(scheduler);
		codingSchedulers.now = null;
		expect(await second.stub.status()).toMatchObject({ state: "failed", stateReason: "queue_expired:slots_full", slot: "none", inbox: 1 });
		expect(await first.stub.status()).toMatchObject({ state: "idle", slot: "none" });
		expect(await scheduler.snapshot()).toMatchObject({ running: [], queued: [] });
		expect(codingEvents.filter((event) => event.threadId === second.id)).toEqual([]);
	});

	it("caps a diff at 256 KiB, and diffs from any checkpoint while its workspace runs", async () => {
		const big = "x".repeat(99) + "\n";
		codingFaux.setResponses([
			toolUse("write", { path: "big.txt", content: big.repeat(3_000) }),
			fauxAssistantMessage("Wrote a big file."),
			toolUse("write", { path: "small.txt", content: "small\n" }),
			fauxAssistantMessage("Wrote a small one."),
		]);
		const { id, stub } = await startThread();
		await turns(id, 1);
		const whole = await stub.diff();
		expect(whole.truncated).toBe(true);
		expect(whole.diff).toHaveLength(256 * 1024);
		expect(whole.diff.startsWith("diff --git a/big.txt b/big.txt\n")).toBe(true);
		const [first] = await stub.checkpoints();
		await stub.steer("And a small one.", { operationId: "small" });
		const [, second] = await turns(id, 2);
		expect(second!.outcome).toBe("completed");
		const since = await stub.diff(first!.sha);
		expect(since).toEqual({
			since: first!.sha,
			head: (await stub.status()).checkpoint!.sha,
			diff: "diff --git a/small.txt b/small.txt\n--- /dev/null\n+++ b/small.txt\n+small\n",
			truncated: false,
		});
		// Diffs already made are kept after the workspace is gone; others need it.
		await stub.archive();
		expect(await stub.diff(first!.sha)).toEqual(since);
		await expect(inside(stub, (thread) => thread.diff("base0000"))).resolves.toMatchObject({ truncated: true });
		await expect(inside(stub, (thread) => thread.diff((since.head ?? "").replace(/./, "z")))).rejects.toThrow("workspace isn't running");
	});

	it("goes on with an interrupted turn after its object is reset", async () => {
		let after = "";
		codingFaux.setResponses([
			toolUse("bash", { command: "sleep 1" }),
			(context) => {
				after = sent(context);
				return fauxAssistantMessage("Back after the reset.");
			},
		]);
		const { id, stub } = await startThread();
		await vi.waitFor(async () => expect(await sql(stub, "SELECT tool FROM coding_tool_journal")).toHaveLength(1));
		await runInDurableObject(stub, (_instance: CodingThreadDO, state) => state.abort("evicted")).catch(() => {});
		const [ended] = await turns(id, 1, true);
		expect(ended!.outcome).toBe("completed");
		// The call ran again after the reset found its journal entry, so it told the model it was interrupted rather than running twice.
		expect(after).toContain("bash was interrupted, state unknown");
		expect(await codingThread(env, id).status()).toMatchObject({ state: "idle", currentOperation: null });
	});
});

describe("a coding thread's model", () => {
	it("is the space's own provider, called with its key, which the thread never stores", async () => {
		const key = "sk-coding-secret-4f9a";
		const authorizations: (string | null)[] = [];
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
			const url = request instanceof Request ? request.url : String(request);
			if (!url.startsWith("https://llm.example.test/")) return realFetch(request, init);
			if (url.endsWith("/models")) return Response.json({ data: [{ id: "coder-1" }] });
			authorizations.push(new Headers(request instanceof Request ? request.headers : init?.headers).get("authorization"));
			const chunk = (choice: Record<string, unknown>) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: "coder-1", choices: [{ index: 0, ...choice }] });
			const events = [
				chunk({ delta: { role: "assistant", content: "All done." }, finish_reason: null }),
				chunk({ delta: {}, finish_reason: "stop" }),
				{ id: "c1", object: "chat.completion.chunk", created: 0, model: "coder-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
			];
			return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		});
		const added = await post("/providers", { name: "Coder", url: "https://llm.example.test/v1", key, models: ["coder-1"] });
		expect(added.status).toBe(200);
		const providerId = `own:${added.body.provider.id}`;
		const { id, stub } = await startThread({ space: OWNER, profile: { providerId, model: "coder-1" } });
		const [ended] = await turns(id, 1);
		expect(ended!.outcome).toBe("completed");
		expect(authorizations).toEqual([`Bearer ${key}`]);
		expect((await stub.status()).profile).toEqual({ providerId, model: "coder-1" });
		const stored = await everything(stub);
		expect(stored).toContain("All done.");
		expect(stored).not.toContain(key);
		await stub.archive();
	});
});
