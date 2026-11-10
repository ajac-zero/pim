import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyBrokerToken } from "../src/coding/git-broker/broker";
import { brokerTokenKey } from "../src/coding/git-broker/routes";
import { codingScheduler } from "../src/coding/scheduler-do";
import { type EnvironmentKeyInput, environmentKey, estimatedRestoreMs, lockfileHashes, SETUP_ENV, snapshotWorthKeeping } from "../src/coding/environment-cache";
import { PROVISION_ENV } from "../src/coding/repo-environment";
import { CONTINUE_TEXT, cliInstructions, codingThread, LOST_RESUME_TEXT, type StartThread, threadLimits } from "../src/coding/thread-do";
import { REPO_DIR } from "../src/coding/tools";
import { codingVault } from "../src/coding/vault/vault";
import { ComposeWorkspaceProvider } from "../src/coding/workspace/compose";
import { type FakeCommandHandler, type FakeCommandResult, FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { DEFAULT_WORKSPACE_IMAGE, NO_BACKEND_MESSAGE, NoWorkspaceBackendError, workspaceBackends, workspaceRegistry } from "../src/coding/workspace/registry";
import type { WorkspaceSpec } from "../src/coding/workspace/types";
import { fakeCloneFailures, fakeClones, fakeGit, fakeRemotes } from "./fake-git";
import { fakeManager, json, TOKEN, URL_BASE } from "./fake-manager";
import { AMP_SESSION, ampFixture } from "./fixtures/amp";
import { CLAUDE_SESSION, claudeFixture, claudeLines } from "./fixtures/claude-code";
import { CODEX_SESSION, codexFixture, codexLines } from "./fixtures/codex";
import { GO_REPO, installed, MISE_REPO } from "./fixtures/repos";
import { VIBE_META, VIBE_SESSION, vibeExport, vibeOutput } from "./fixtures/vibe";
import { api, OWNER, post, toolUse } from "./helpers";
import { type CodingThreadDO, codingBackends, codingEvents, codingFaux, codingSchedulers, codingThreadClock, codingTimings, codingWorkspaces } from "./worker";

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
	codingBackends.registry = null;
	codingSchedulers.notifier = null;
	codingSchedulers.now = null;
	codingThreadClock.now = null;
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
		expect(status.budgetUsd).toBeNull();
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
		const { id, stub, input, status } = await startThread({ workspaceProvider: "compose" });
		expect(status).toMatchObject({ state: "failed", stateReason: "no_backend", stateDetail: 'This Pim has no workspace backend "compose" for coding threads.', slot: "none", inbox: 1 });
		expect(await codingScheduler(env, input.space).snapshot()).toMatchObject({ running: [], queued: [] });
		// The agent that started it hears of it, once.
		expect(codingEvents.filter((event) => event.threadId === id)).toEqual([
			expect.objectContaining({ outcome: "error", reason: "no_backend", state: "failed", detail: 'This Pim has no workspace backend "compose" for coding threads.' }),
		]);
		// Continuing doesn't help until there is one.
		expect(await stub.continue({ operationId: "again" })).toMatchObject({ state: "failed", stateReason: "no_backend" });
	});

	it("keeps the broker token out of what it says and stores when the clone fails, though git printed it", async () => {
		const warn = vi.spyOn(console, "warn");
		const { id, stub } = await startThread({ repo: "https://github.com/acme/missing" });
		const failed = await vi.waitFor(
			async () => {
				const status = await stub.status();
				expect(status).toMatchObject({ state: "failed", slot: "none" });
				return status;
			},
			{ timeout: 10_000, interval: 50 },
		);
		// The fake git printed the header it was given, as a verbose git does.
		const clone = fakeClones.findLast((each) => each.url === "https://pim.test/api/coding/git/acme/missing.git")!;
		const token = clone.env.GIT_CONFIG_VALUE_0!.replace(/^Authorization: Bearer /, "");
		expect(token.length).toBeGreaterThan(20);
		expect(failed).toMatchObject({ stateReason: "workspace", slot: "none" });
		expect(failed.stateDetail).toContain("git clone exited 128: > Authorization: Bearer [redacted]\nfatal: repository");
		expect(failed.stateDetail).not.toContain(token);
		// The failure is told once, as an error turn's end is, with its detail.
		const [told, ...more] = await turns(id, 1);
		expect(more).toEqual([]);
		expect(told).toMatchObject({ outcome: "error", reason: "workspace", state: "failed", operationId: expect.stringMatching(/^failed-workspace-/) });
		expect(told!.detail).toContain("git clone exited 128");
		expect(told!.detail).not.toContain(token);
		expect(await everything(stub)).not.toContain(token);
		const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
		expect(logged).toContain(id);
		expect(logged).not.toContain(token);
		warn.mockRestore();
	});

	it("tries a rate limited clone again, and clones once the host lets it", async () => {
		const url = "https://pim.test/api/coding/git/acme/limited.git";
		fakeRemotes.set(url, { "README.md": "# Limited\n" });
		fakeCloneFailures.set(url, { times: 2, stderr: "fatal: unable to access: The requested URL returned error: 429\n" });
		codingFaux.setResponses([fauxAssistantMessage("Done.")]);
		const { id } = await startThread({ repo: "https://github.com/acme/limited" });
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "completed" });
		expect(fakeClones.filter((each) => each.url === url)).toHaveLength(3);
		fakeCloneFailures.delete(url);
	});

	it("gives up on a clone the host keeps rate limiting after three retries, reporting the last error, and fails other errors at once", async () => {
		const url = "https://pim.test/api/coding/git/acme/blocked.git";
		fakeRemotes.set(url, { "README.md": "# Blocked\n" });
		fakeCloneFailures.set(url, { times: 10, stderr: "error: RPC failed; HTTP 503 curl 22\nfatal: the remote end hung up\n" });
		const { stub } = await startThread({ repo: "https://github.com/acme/blocked" });
		const failed = await vi.waitFor(
			async () => {
				const status = await stub.status();
				expect(status).toMatchObject({ state: "failed", slot: "none" });
				return status;
			},
			{ timeout: 10_000, interval: 50 },
		);
		expect(failed.stateDetail).toContain("git clone exited 128: error: RPC failed; HTTP 503");
		expect(fakeClones.filter((each) => each.url === url)).toHaveLength(4);
		fakeCloneFailures.delete(url);
		// A missing repository is not retried.
		const clones = fakeClones.length;
		await startThread({ repo: "https://github.com/acme/nowhere" });
		await vi.waitFor(() => expect(fakeClones.length).toBeGreaterThan(clones), { timeout: 10_000 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fakeClones.length).toBe(clones + 1);
	});

	it("takes its backends from the deployment's environment", () => {
		const none = workspaceBackends({});
		expect(none.defaultId()).toBeNull();
		expect(() => none.get("compose")).toThrow(new NoWorkspaceBackendError(NO_BACKEND_MESSAGE));
		expect(() => workspaceBackends({ PIM_CODING_MANAGER_URL: "https://manager.example" }).get("compose")).toThrow("PIM_CODING_MANAGER_TOKEN isn't set");
		const compose = workspaceBackends({ PIM_CODING_MANAGER_URL: "https://manager.example", PIM_CODING_MANAGER_TOKEN: "t" });
		expect(compose.defaultId()).toBe("compose");
		expect(compose.get("compose")).toBeInstanceOf(ComposeWorkspaceProvider);
		// A manager URL the provider won't use is said at once, rather than failing a thread later.
		expect(() => workspaceBackends({ PIM_CODING_MANAGER_URL: "http://manager.example", PIM_CODING_MANAGER_TOKEN: "t" }).get("compose")).toThrow(
			"PIM_CODING_MANAGER_URL can't be used, so coding threads have no workspace backend: The workspace manager URL must be https",
		);
	});

	it("checkpoints work the coding agent committed itself, leaving a clean tree", async () => {
		codingFaux.setResponses([
			toolUse("write", { path: "own.txt", content: "mine\n" }),
			toolUse("bash", { command: "git commit -m own" }),
			fauxAssistantMessage("Committed it myself."),
		]);
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		await stub.start(startInput(id));
		const [ended] = await turns(id, 1);
		const status = await stub.status();
		expect(status.checkpoint).not.toBeNull();
		expect(ended).toMatchObject({ outcome: "completed", checkpoint: status.checkpoint!.sha });
		expect((await stub.diff()).diff).toContain("+++ b/own.txt");
		expect(await stub.checkpoints()).toHaveLength(1);
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
		// Told once: the turn's end is the only event for it.
		await stub.status();
		expect(codingEvents.filter((event) => event.threadId === id)).toHaveLength(1);
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
		expect((await stub.log()).map((event) => event.kind)).toEqual(["thread.turn_started", "model_call", "thread.turn_ended", "app.budget_stop"]);
		const transcript = await inside(stub, (thread) => thread.transcript());
		expect(transcript.at(-1)).toMatchObject({ role: "notice", parts: [{ type: "text", text: expect.stringMatching(/^Stopped: the thread spent \$\d+\.\d\d of its \$0\.5 budget\.$/) }] });
		expect((await codingScheduler(env, input.space).snapshot()).running).toEqual([]);
		await expect(inside(stub, (thread) => thread.continue({ operationId: "more" }))).rejects.toThrow(/spent its \$0\.5 budget/);
		await expect(inside(stub, (thread) => thread.steer("Go on.", { operationId: "more" }))).rejects.toThrow(/budget/);
	});

	it("has no budget unless one is given, so no spend stops it", async () => {
		codingFaux.setResponses([toolUse("bash", { command: "echo hi" }), fauxAssistantMessage("Done.")]);
		const { id, stub } = await startThread({ profile: { providerId: "coding-faux", model: "pricey" } });
		const [ended] = await turns(id, 1);
		// The same $1-a-token calls that stop a thread with a $0.5 budget.
		expect(ended).toMatchObject({ outcome: "completed", state: "idle", budgetUsd: null });
		expect((await stub.status()).spentUsd).toBeGreaterThanOrEqual(1);
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
		expect(codingEvents.filter((event) => event.threadId === second.id)).toEqual([expect.objectContaining({ outcome: "error", reason: "queue_expired:slots_full", state: "failed" })]);
	});

	it("fails a thread stuck provisioning for too long, once, and leaves queued, and waiting threads be", async () => {
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		await scheduler.setLimit(1);
		codingFaux.setResponses([fauxAssistantMessage("First done."), fauxAssistantMessage("Other done."), fauxAssistantMessage("Queued done.")]);
		const first = await startThread({ space });
		await turns(first.id, 1);
		// A queued thread may wait for hours: it is the scheduler's to expire, not stuck.
		const queued = await startThread({ space });
		expect(queued.status.state).toBe("queued");
		const waiting = await startThread();
		await turns(waiting.id, 1);
		const heartbeat = (stub: Stub) => inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));
		const force = (stub: Stub, state: "provisioning" | "waiting_input") => inside(stub, async (thread) => thread.store.update({ state }));
		await force(first.stub, "provisioning");
		await force(waiting.stub, "waiting_input");
		// Within its time, nothing happens.
		await heartbeat(first.stub);
		expect((await first.stub.status()).state).toBe("provisioning");
		codingThreadClock.now = Date.now() + 21 * 60_000;
		for (const each of [queued, waiting]) await heartbeat(each.stub);
		expect((await queued.stub.status()).state).toBe("queued");
		expect((await waiting.stub.status()).state).toBe("waiting_input");
		await heartbeat(first.stub);
		await heartbeat(first.stub);
		expect(await first.stub.status()).toMatchObject({ state: "failed", stateReason: "stuck", slot: "none" });
		// Its slot went to the queued thread, which runs on.
		await turns(queued.id, 1);
		expect(codingEvents.filter((event) => event.threadId === first.id)).toEqual([
			expect.objectContaining({ outcome: "completed" }),
			expect.objectContaining({ outcome: "error", reason: "stuck", state: "failed", detail: expect.stringMatching(/provisioning for 21 minutes/) }),
		]);
		for (const each of [queued, waiting]) expect(codingEvents.filter((event) => event.threadId === each.id && event.outcome === "error")).toEqual([]);
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
		// The manager's health went to the scheduler before the slot was asked for: its limit of 1 is under the space's 2.
		expect(calls()[0]).toBe("GET /health");
		expect((await codingScheduler(env, input.space).snapshot()).limit).toBe(1);
		// One workspace for the thread's session, the clone run in it with the broker's header, and every route but /health sent the manager's token.
		expect(manager.requests.find((request) => request.path === "/sessions" && request.method === "POST")?.body).toMatchObject({ sessionId: id });
		const clone = manager.requests.find((request) => (request.body as { cmd?: string[] } | undefined)?.cmd?.[1] === "clone")!;
		expect(clone.body).toMatchObject({ cmd: ["git", "clone", "--no-checkout", BROKER_URL, REPO_DIR], env: { GIT_CONFIG_KEY_0: "http.extraHeader" } });
		expect(manager.requests.filter((request) => request.path !== "/health").every((request) => request.auth === `Bearer ${TOKEN}`)).toBe(true);
		const [info] = await manager.backing.list({ sessionId: id });
		const workspace = (await manager.backing.get(info!.ref))!;
		expect(new TextDecoder().decode(await workspace.readFile(`${REPO_DIR}/hello.txt`))).toBe("Hello!\n");
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
		const base: EnvironmentKeyInput = { userId: "ada", repo: "acme/env", provision: [], setupScript: SCRIPT, lockfiles: { "pnpm-lock.yaml": "a".repeat(64), "web/package-lock.json": "b".repeat(64) }, image: "pim-workspace@sha256:1" };
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
		const key = await environmentKey({ userId: space, repo: fullName, provision: [], setupScript: SCRIPT, lockfiles: { "pnpm-lock.yaml": await sha256(LOCK), "web/package-lock.json": await sha256(WEB_LOCK) }, image: DEFAULT_WORKSPACE_IMAGE });
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
		// 8 MB a second: 400 MB takes 50 s to restore.
		expect(estimatedRestoreMs(400_000_000)).toBe(50_000);
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
		expect(environment.notes).toEqual([expect.stringContaining("starts the services postgres, redis")]);
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
		const key = await environmentKey({ userId: space, repo: fullName, provision: ["mise trust --yes --quiet && mise install --yes", installed("python@3.12")], setupScript: SCRIPT, lockfiles: { "mise.toml": await sha256(MISE_REPO["mise.toml"]!) }, image: DEFAULT_WORKSPACE_IMAGE });
		expect(environment.key).toBe(key);
	});
});

describe("a Claude Code thread", () => {
	// The thread runs `claude` in its in-memory workspace, where it is a script that prints the stream-json of
	// test/fixtures/claude-code/, and `pkill` tells the script the signal it was sent. Its person is the file's account,
	// `OWNER`, whose space keeps their Claude Code login in the coding vault for real.
	type Run = { argv: string[]; env: Record<string, string>; cwd: string; login: string };
	const runs: Run[] = [];
	const signals: string[][] = [];
	const waiting: { signal: string; resolve: () => void }[] = [];
	/** What `claude` does this time, after it is recorded in `runs`. */
	let claude: (context: Parameters<FakeCommandHandler>[0]) => Promise<FakeCommandResult> = async () => ({ stdout: claudeFixture("turn") });
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const LOGIN = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-original-login","refreshToken":"sk-ant-ort01-original"}}';
	const REFRESHED = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-refreshed-login","refreshToken":"sk-ant-ort01-refreshed"}}';
	const CREDENTIALS = "/workspace/.claude/.credentials.json";
	const started: Stub[] = [];

	const claudeCommand: FakeCommandHandler = async (context) => {
		const login = await context.workspace.readFile(`${context.env.CLAUDE_CONFIG_DIR}/.credentials.json`).then(
			(data) => decoder.decode(data),
			() => "",
		);
		runs.push({ argv: context.argv, env: context.env, cwd: context.cwd, login });
		return claude(context);
	};
	const pkillCommand: FakeCommandHandler = ({ argv }) => {
		signals.push(argv.slice(1));
		for (const waiter of waiting.splice(0).filter((each) => each.signal === argv[1] || (waiting.push(each), false))) waiter.resolve();
		return {};
	};
	codingWorkspaces.register("claude", claudeCommand);
	codingWorkspaces.register("pkill", pkillCommand);

	/** Resolves when `pkill` sends `signal`, or the command is killed. */
	const until = (signal: string, killed: Promise<void>) => Promise.race([new Promise<void>((resolve) => waiting.push({ signal, resolve })), killed]);

	/** The person's login, as Claude Code's own sign-in would have left it, in the vault. */
	async function signIn(login = LOGIN) {
		const vault = codingVault(env);
		const { version } = await vault.load(OWNER, "claude-code");
		await vault.save(OWNER, "claude-code", [{ path: ".credentials.json", mode: 0o600, data: encoder.encode(login) }], version);
	}

	const storedLogin = async () => {
		const files = (await codingVault(env).load(OWNER, "claude-code")).files;
		return files ? decoder.decode(files.find((file) => file.path === ".credentials.json")!.data) : null;
	};

	/** Starts a Claude Code thread in `OWNER`'s space, entered in its list as the API enters it. */
	async function startClaude(overrides: Partial<StartThread> = {}) {
		const id = crypto.randomUUID();
		await codingScheduler(env, OWNER).registerThread({ threadId: id, createdBy: { type: "person" }, parent: null, chat: null, harness: "claude-code", task: "Fix the greeting test", repo: REPO, ref: "main", budgetUsd: 3, createdAt: Date.now() });
		const stub = codingThread(env, id);
		started.push(stub);
		await stub.start(startInput(id, { space: OWNER, harness: "claude-code", task: "Fix the greeting test", ...overrides }));
		return { id, stub };
	}

	const running = (count: number) => vi.waitFor(() => expect(runs).toHaveLength(count), { timeout: 10_000, interval: 20 });

	beforeEach(async () => {
		runs.length = 0;
		signals.length = 0;
		waiting.length = 0;
		claude = async () => ({ stdout: claudeFixture("turn") });
		await signIn();
	});

	afterEach(async () => {
		// Its slots and the person's lock are free for the next test.
		for (const stub of started.splice(0)) await stub.archive().catch(() => {});
	});

	it("readies its environment before the person's login goes in, so the snapshot holds none of it", async () => {
		const name = `Env-${crypto.randomUUID().slice(0, 8)}`;
		fakeRemotes.set(`https://pim.test/api/coding/git/Acme/${name}.git`, { "README.md": "# Env\n", ".pim/setup.sh": "pnpm install\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
		const { id, stub } = await startClaude({ repo: `https://github.com/Acme/${name}` });
		await turns(id, 1);
		expect((await stub.status()).environment).toMatchObject({ state: "cached" });
		// The CLI ran signed in, after the snapshot was kept without the login in it.
		expect(runs[0]).toMatchObject({ login: LOGIN });
		const saved = [...codingWorkspaces.environments.values()].find((each) => each.userId === OWNER && each.repo === `acme/${name.toLowerCase()}`)!;
		expect(saved.nodes.has(`${REPO_DIR}/node_modules/.modules.yaml`)).toBe(true);
		expect([...saved.nodes.keys()].filter((path) => path.startsWith("/workspace/.claude"))).toEqual([]);
		expect(JSON.stringify([...saved.nodes.values()].map((node) => ("data" in node ? decoder.decode(node.data) : "")))).not.toContain("sk-ant-");
	});

	it("runs a turn with the person's login, and keeps its transcript, cost, tests, checkpoint and refreshed login, then resumes it", async () => {
		claude = async ({ workspace }) => {
			await workspace.writeFile(`${REPO_DIR}/greet.ts`, encoder.encode("export const greet = (name: string) => `Hello, ${name}`;\n"));
			// The CLI refreshed its token, as it does.
			await workspace.writeFile(CREDENTIALS, encoder.encode(REFRESHED), 0o600);
			return { stdout: claudeFixture("turn") };
		};
		const { id, stub } = await startClaude();
		const [ended] = await turns(id, 1);
		const status = await stub.status();
		expect(ended).toMatchObject({ outcome: "completed", checkpoint: status.checkpoint!.sha, said: "Fixed `greet` to include the name; the greeting test passes now." });
		expect(status).toMatchObject({ state: "idle", harness: "claude-code", profile: { providerId: "claude-code", model: "default" }, currentOperation: null });
		// The CLI ran in the checkout, signed in with the person's login, a new session, and no telemetry.
		const [first] = runs;
		expect(first).toMatchObject({ cwd: REPO_DIR, login: LOGIN, env: { HOME: "/workspace", CLAUDE_CONFIG_DIR: "/workspace/.claude", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
		const sessionId = first!.argv[first!.argv.indexOf("--session-id") + 1]!;
		expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(first!.argv.slice(-2)).toEqual(["--", "Fix the greeting test"]);
		// A thread has no budget unless one is given, so the CLI is given no ceiling either.
		expect(first!.argv).not.toContain("--max-budget-usd");
		expect(first!.argv[first!.argv.indexOf("--append-system-prompt") + 1]).toContain(`on the branch ${status.repo.branch}`);
		// Its workspace may reach Anthropic, besides the broker and the registries.
		const spec = (await workspaceOf(id)) as unknown as { spec: { egress: { allow: string[] } } };
		expect(spec.spec.egress.allow).toEqual(expect.arrayContaining(["api.anthropic.com", "claude.ai", "platform.claude.com", "registry.npmjs.org"]));
		// The refreshed login is kept, and none is left in the workspace or anywhere in the thread's tables.
		expect(await storedLogin()).toBe(REFRESHED);
		await expect((await workspaceOf(id)).readFile(CREDENTIALS)).rejects.toThrow();
		expect(await everything(stub)).not.toContain("sk-ant-");
		// The transcript, as the web app shows it: the task, the agent's text, its tools with their results.
		const transcript = await inside(stub, (thread) => thread.transcript());
		expect(transcript.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant"]);
		expect(transcript[0]!.parts).toEqual([{ type: "text", text: "Fix the greeting test" }]);
		expect(transcript[3]!.parts).toEqual([{ type: "tool-call", id: "toolu_01Bash", name: "Bash", arguments: { command: "npm test", description: "Run the tests" } }]);
		expect(transcript[4]!.parts[0]).toMatchObject({ type: "tool-result", id: "toolu_01Bash", name: "Bash", error: true });
		// What it cost as the CLI estimated it, its test run, its retry and refusal, and its checkpoint's diff.
		const log = await stub.log();
		expect(log.filter((event) => event.kind === "model_call")).toEqual([expect.objectContaining({ provider: "claude-code", model: "claude-sonnet-5", costUsd: 0.0841, input: 2569, output: 396 })]);
		expect(status.spentUsd).toBeCloseTo(0.0841, 10);
		expect(log.find((event) => event.kind === "harness.api_retry")?.data).toMatchObject({ attempt: 1, error: "overloaded", status: 529 });
		expect(log.find((event) => event.kind === "harness.permission_denied")?.data).toMatchObject({ tool: "WebFetch" });
		expect(await stub.tests()).toEqual([expect.objectContaining({ command: "npm test", exitCode: 1, summary: { format: "vitest", passed: 3, failed: 1, skipped: 0, total: 4 } })]);
		expect((await stub.diff()).diff).toContain("+++ b/greet.ts");

		// A steer is the next turn, which resumes the CLI's session; its cost is what the session's whole cost grew by.
		const turn = claudeLines("turn");
		claude = async () => ({ stdout: [turn[0], turn.at(-2), turn.at(-1)!.replace('"total_cost_usd": 0.0841', '"total_cost_usd": 0.1341')].join("\n") });
		await stub.steer("Also add a test for an empty name", { operationId: "steer-1" });
		const [, second] = await turns(id, 2);
		expect(second).toMatchObject({ outcome: "completed", operationId: "steer-1" });
		expect(runs[1]!.argv[runs[1]!.argv.indexOf("--resume") + 1]).toBe(CLAUDE_SESSION);
		expect(runs[1]!.argv).not.toContain("--session-id");
		expect(runs[1]!.login).toBe(REFRESHED);
		const calls = (await stub.log()).filter((event) => event.kind === "model_call");
		expect(calls[1]!.costUsd).toBeCloseTo(0.05, 10);
		expect((await stub.status()).spentUsd).toBeCloseTo(0.1341, 10);
	});

	it("stops on abort with SIGINT, ending the turn cancelled, and keeps the login", async () => {
		claude = async ({ killed }) => {
			await until("-INT", killed);
			return { stdout: `${claudeLines("turn")[0]}\n{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"${CLAUDE_SESSION}","total_cost_usd":0.01,"errors":["Interrupted"]}\n`, code: 130 };
		};
		const { id, stub } = await startClaude();
		await running(1);
		await stub.abort();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "cancelled" });
		expect(await stub.status()).toMatchObject({ state: "idle", currentOperation: null });
		const sessionId = runs[0]!.argv[runs[0]!.argv.indexOf("--session-id") + 1];
		expect(signals).toEqual([["-INT", "-f", sessionId]]);
		expect(await storedLogin()).toBe(LOGIN);
		await expect((await workspaceOf(id)).readFile(CREDENTIALS)).rejects.toThrow();
	});

	it("fails a turn that runs out of time, killing a CLI that ignores SIGINT after the grace", async () => {
		claude = async ({ killed }) => {
			await until("-KILL", killed);
			return {};
		};
		const { id, stub } = await startClaude({ limits: { wallClockMin: 0.005 } });
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "error", reason: "timeout", state: "failed" });
		expect((await stub.status()).stateDetail).toContain("ran out of time");
		await vi.waitFor(() => expect(signals.map((each) => each[0])).toEqual(["-INT", "-KILL"]));
	});

	it("stops a turn that prints nothing as stalled, then continues it once by itself, resuming the session, and leaves it failed if that stalls too", async () => {
		claude = async ({ killed }) => {
			await until("-INT", killed);
			return { stdout: `${claudeLines("turn")[0]}\n`, code: 130 };
		};
		const { id, stub } = await startClaude();
		const [first, second] = await turns(id, 2);
		expect(first).toMatchObject({ outcome: "error", reason: "stalled", state: "failed" });
		expect(second).toMatchObject({ outcome: "error", reason: "stalled", state: "failed" });
		expect(second!.operationId).toMatch(/^auto-continue:/);
		// Once: the continuation resumed the CLI's session, and its own stall is not continued again.
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(runs).toHaveLength(2);
		expect(runs[1]!.argv[runs[1]!.argv.indexOf("--resume") + 1]).toBe(CLAUDE_SESSION);
		expect(await stub.status()).toMatchObject({ state: "failed", stateReason: "stalled" });
	});

	it("goes on after a stall when the continuation finishes", async () => {
		let attempt = 0;
		claude = async ({ killed }) => {
			if (attempt++ === 0) {
				await until("-INT", killed);
				return { stdout: `${claudeLines("turn")[0]}\n`, code: 130 };
			}
			return { stdout: claudeFixture("turn") };
		};
		const { id, stub } = await startClaude();
		const [first, second] = await turns(id, 2);
		expect(first).toMatchObject({ reason: "stalled" });
		expect(second).toMatchObject({ outcome: "completed", state: "idle" });
	});

	it("ends a turn its object's reset cut off as interrupted, auto-resumes, and finishes the run off", async () => {
		let first = true;
		claude = async ({ killed }) => {
			if (!first) return { stdout: claudeFixture("turn") };
			first = false;
			await until("-KILL", killed);
			return {};
		};
		const { id, stub } = await startClaude();
		await running(1);
		await vi.waitFor(async () => expect(await sql(stub, "SELECT record FROM coding_harness_run")).toHaveLength(1));
		await runInDurableObject(stub, (_instance: CodingThreadDO, state) => state.abort("evicted")).catch(() => {});
		// Auto-resume should happen - no turn_ended event is emitted to supervisor
		// The turn continues with a new CLI run
		const after = codingThread(env, id);
		// Wait for the auto-resume to complete
		const ended = await turns(id, 1, true);
		// The first (and only) turn_ended event should be the completed turn after auto-resume
		expect(ended).toHaveLength(1);
		expect(ended[0]).toMatchObject({ outcome: "completed" });
		// The CLI was killed, the login written back and taken out of the workspace, and the person's lock let go.
		expect(signals.map((each) => each[0])).toContain("-KILL");
		expect(await sql(after, "SELECT record FROM coding_harness_run")).toEqual([]);
		expect(await storedLogin()).toBe(LOGIN);
		const scheduler = codingScheduler(env, OWNER);
		expect(await scheduler.acquireHarness("claude-code", "probe", 1000)).toBe(true);
		await scheduler.releaseHarness("claude-code", "probe");
		started.splice(started.indexOf(stub), 1, after);
		// The resumed turn completed normally, so the counter is back to 0, and the log keeps the resume.
		const status = await after.status();
		expect(status).toMatchObject({ consecutiveInterrupts: 0 });
		const log = await after.log();
		expect(log.some((event) => event.kind === "thread.resumed")).toBe(true);
	});

	describe("on the Compose sandbox manager, when its workspace goes down", () => {
		// The thread's workspaces are the stubbed manager's (test/fake-manager.ts), which a test makes go down: a container
		// that dies under a turn, a host that comes back with or without the workspace's volume, a manager that restarts.
		/** The Compose provider on a stubbed manager whose workspaces run the fake git and `claude`. */
		function compose() {
			const manager = fakeManager();
			manager.backing.register("git", fakeGit);
			manager.backing.register("claude", claudeCommand);
			manager.backing.register("pkill", pkillCommand);
			codingBackends.registry = workspaceRegistry([new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: manager.fetch, sleep: async () => {} })]);
			const creates = () => manager.requests.filter((request) => request.method === "POST" && request.path === "/sessions").length;
			const deletes = () => manager.requests.filter((request) => request.method === "DELETE" && /^\/sessions\/[^/?]+(\?|$)/.test(request.path)).map((request) => request.path);
			return { manager, creates, deletes };
		}

		const heartbeat = (stub: Stub) => inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));
		/** Runs `what` in the thread's object, as what a workspace does reaches the thread from its own requests: a stream the object reads may only be moved on from there. */
		const within = (stub: Stub, what: () => unknown) => inside(stub, async () => void (await what()));
		const kinds = async (stub: Stub) => (await stub.log()).map((event) => event.kind);
		const SESSION_FILE = `/workspace/.claude/projects/repo/${CLAUDE_SESSION}.jsonl`;

		/** A run that writes half its work, then works on until `release` is called: when its container dies, or when the test lets it finish with `then`. */
		function halfway(then: () => FakeCommandResult = () => ({})) {
			const run = { release: null as (() => void) | null };
			const command = async ({ cwd, workspace }: Parameters<FakeCommandHandler>[0]) => {
				await workspace.writeFile(`${cwd}/wip.txt`, encoder.encode("half done\n"));
				await new Promise<void>((resolve) => {
					run.release = resolve;
				});
				return then();
			};
			return { run, command, started: () => vi.waitFor(() => expect(run.release).not.toBeNull(), { timeout: 10_000, interval: 20 }) };
		}

		beforeEach(() => {
			// The runs that wait for their container to die print nothing meanwhile.
			codingTimings.stallMs = 60_000;
		});

		afterEach(() => {
			Object.assign(codingTimings, { stallMs: 300, lostGraceMs: 1_000, autosaveMs: 3 * 60_000 });
		});

		it("makes the workspace again from its kept volume when its container dies mid-turn, and resumes the CLI's session there", async () => {
			const { manager, creates, deletes } = compose();
			const cut = halfway();
			let sessionKept: boolean | null = null;
			claude = async (context) => {
				if (runs.length === 1) {
					await context.workspace.writeFile(SESSION_FILE, encoder.encode("{}\n"));
					return { stdout: claudeFixture("turn") };
				}
				if (runs.length === 2) return cut.command(context);
				sessionKept = await context.workspace.stat(SESSION_FILE).then(
					() => true,
					() => false,
				);
				return { stdout: claudeFixture("turn") };
			};
			const { id, stub } = await startClaude();
			await turns(id, 1);
			await stub.steer("Add a farewell too", { operationId: "steer-1" });
			await cut.started();
			// The container dies; the manager, which didn't see it go, still lists the session as running.
			await within(stub, () => manager.crash(id));
			await within(stub, cut.run.release!);
			// The cut-off turn went on by itself: the only turn to end after the first is the one it went on with.
			const [, ended] = await turns(id, 2);
			expect(ended).toMatchObject({ outcome: "completed", operationId: "resume-1-steer-1", state: "idle" });
			// It resumed Claude Code's session, whose files were on the kept volume, told why.
			expect(runs).toHaveLength(3);
			expect(runs[2]!.argv).toEqual(expect.arrayContaining(["--resume", CLAUDE_SESSION]));
			expect(runs[2]!.argv.at(-1)).toBe(LOST_RESUME_TEXT);
			expect(sessionKept).toBe(true);
			// The dead session was let go with its volume kept, and made again from it; what the cut-off run wrote is in the checkpoint.
			expect(deletes()).toEqual([`/sessions/${id}?keepVolume=1`]);
			expect(creates()).toBe(2);
			expect((await stub.diff()).diff).toContain("+half done");
			const log = await stub.log();
			expect(log.map((event) => event.kind)).toEqual(expect.arrayContaining(["workspace.lost", "thread.resumed"]));
			expect(log.find((event) => event.kind === "thread.resumed")?.data).toMatchObject({ attempt: 1, reason: "workspace_lost" });
			expect(await stub.status()).toMatchObject({ state: "idle", slot: "held", consecutiveInterrupts: 0 });
		});

		it("fails, telling whoever started it, once its workspace went down more times in a row than it goes on after", async () => {
			const { manager } = compose();
			const cuts: ReturnType<typeof halfway>[] = [];
			claude = async (context) => {
				if (runs.length === 1) return { stdout: claudeFixture("turn") };
				const cut = halfway();
				cuts.push(cut);
				return cut.command(context);
			};
			const { id, stub } = await startClaude();
			await turns(id, 1);
			await stub.steer("Add a farewell too", { operationId: "steer-1" });
			for (let attempt = 0; attempt < 4; attempt++) {
				await vi.waitFor(() => expect(cuts).toHaveLength(attempt + 1), { timeout: 10_000, interval: 20 });
				await cuts[attempt]!.started();
				// The first time the manager still lists the dead session; later the host came back, and its manager kept the volume.
				await within(stub, () => manager.crash(id, { restart: attempt > 0 }));
				await within(stub, cuts[attempt]!.run.release!);
			}
			const [, ended] = await turns(id, 2);
			expect(ended).toMatchObject({ outcome: "error", reason: "workspace_lost", state: "failed" });
			const status = await stub.status();
			expect(status).toMatchObject({ state: "failed", stateReason: "workspace_lost", slot: "none", consecutiveInterrupts: 3 });
			expect(status.stateDetail).toContain("went down 4 times in a row");
			expect(ended!.detail).toBe(status.stateDetail);
			expect(runs).toHaveLength(5);
			expect((await stub.log()).filter((event) => event.kind === "thread.resumed")).toHaveLength(3);
		});

		it("tells whoever started it once, with why, when the workspace it makes again keeps going down before a turn starts in it", async () => {
			const { manager, creates } = compose();
			// From now on each workspace the manager makes dies as soon as it is made.
			let doomed = false;
			const doom: typeof fetch = async (input, init) => {
				const res = await manager.fetch(input, init);
				const { pathname } = new URL(String(input));
				if (doomed && pathname === "/sessions" && init?.method === "POST") await manager.crash((JSON.parse(String(init.body)) as { sessionId: string }).sessionId);
				return res;
			};
			codingBackends.registry = workspaceRegistry([new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: doom, sleep: async () => {} })]);
			claude = async () => ({ stdout: claudeFixture("turn") });
			const { id, stub } = await startClaude();
			await turns(id, 1);
			doomed = true;
			await within(stub, () => manager.crash(id));
			await stub.steer("Add a farewell too", { operationId: "steer-1" });
			const [, ended] = await turns(id, 2);
			expect(ended).toMatchObject({ outcome: "error", reason: "workspace_lost", state: "failed" });
			expect(ended!.detail).toContain("went down 4 times in a row");
			expect(ended!.detail).toContain("Last: ");
			// It failed as the workspace was readied, not at a turn's end.
			expect(ended!.operationId).toMatch(/^failed-workspace_lost-/);
			const status = await stub.status();
			expect(status).toMatchObject({ state: "failed", stateReason: "workspace_lost", stateDetail: ended!.detail, slot: "none" });
			expect(creates()).toBe(4);
			// Nothing else ends a turn for it afterwards: one failure, heard of once.
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(codingEvents.filter((event) => event.threadId === id)).toHaveLength(2);
			expect(await sql(stub, "SELECT * FROM coding_inbox")).toEqual([]);
		});

		it("loses nothing when the manager restarts while the workspace lives on", async () => {
			const { manager, creates, deletes } = compose();
			const cut = halfway(() => ({ stdout: claudeFixture("turn") }));
			claude = async (context) => (runs.length === 1 ? { stdout: claudeFixture("turn") } : cut.command(context));
			const warn = vi.spyOn(console, "warn");
			const { id, stub } = await startClaude();
			await turns(id, 1);
			await stub.steer("Add a farewell too", { operationId: "steer-1" });
			await cut.started();
			codingTimings.autosaveMs = 0;
			// For a moment nothing reaches the manager: the autosave the heartbeat starts fails, and waits to see whether the workspace answers again.
			manager.outage.down = true;
			setTimeout(() => {
				manager.outage.down = false;
			}, 300);
			await heartbeat(stub);
			await vi.waitFor(() => expect(warn.mock.calls.some((call) => String(call[0]).includes("pim.coding.autosave_failed"))).toBe(true), { timeout: 10_000, interval: 50 });
			// It does, so the turn goes on in it, and its work is autosaved once the manager is back.
			await vi.waitFor(
				async () => {
					await heartbeat(stub);
					expect(await sql(stub, "SELECT commit_sha FROM coding_autosave")).toHaveLength(1);
				},
				{ timeout: 10_000, interval: 100 },
			);
			await within(stub, cut.run.release!);
			const [, ended] = await turns(id, 2);
			expect(ended).toMatchObject({ outcome: "completed", operationId: "steer-1" });
			expect(await kinds(stub)).not.toEqual(expect.arrayContaining(["workspace.lost"]));
			expect(await kinds(stub)).not.toEqual(expect.arrayContaining(["thread.resumed"]));
			expect(runs).toHaveLength(2);
			expect([creates(), deletes()]).toEqual([1, []]);
			expect(await stub.status()).toMatchObject({ state: "idle", consecutiveInterrupts: 0 });
			// The autosave is a commit the workspace keeps under a ref of Pim's, pushed nowhere, its checkout untouched.
			const [info] = await manager.backing.list({ sessionId: id });
			const workspace = (await manager.backing.get(info!.ref))!;
			const saved = (await sql(stub, "SELECT commit_sha, bundle FROM coding_autosave"))[0]!;
			expect(decoder.decode(await workspace.readFile(`${REPO_DIR}/.git/refs/pim/autosave`))).toBe(saved.commit_sha);
			expect((saved.bundle as ArrayBuffer).byteLength).toBeGreaterThan(0);
			warn.mockRestore();
		});

		it("starts again from the work it autosaved when the workspace's volume was lost with its host", async () => {
			const { manager, creates } = compose();
			const cut = halfway();
			let restored: string | null = null;
			claude = async (context) => {
				if (runs.length === 1) return { stdout: claudeFixture("turn") };
				if (runs.length === 2) return cut.command(context);
				restored = decoder.decode(await context.workspace.readFile(`${context.cwd}/wip.txt`));
				return { stdout: claudeFixture("turn") };
			};
			const { id, stub } = await startClaude();
			await turns(id, 1);
			await stub.steer("Add a farewell too", { operationId: "steer-1" });
			await cut.started();
			codingTimings.autosaveMs = 0;
			await vi.waitFor(
				async () => {
					await heartbeat(stub);
					expect(await sql(stub, "SELECT commit_sha FROM coding_autosave")).toHaveLength(1);
				},
				{ timeout: 10_000, interval: 100 },
			);
			// The host dies, and comes back without the workspace's volume.
			await within(stub, () => manager.crash(id, { restart: true, volume: "lost" }));
			await within(stub, cut.run.release!);
			const [, ended] = await turns(id, 2);
			expect(ended).toMatchObject({ outcome: "completed", operationId: "resume-1-steer-1" });
			// A new workspace, cloned again, with the run's work put back from the autosave, uncommitted as it was.
			expect(creates()).toBe(2);
			expect(restored).toBe("half done\n");
			expect((await stub.log()).find((event) => event.kind === "workspace.restored")?.data).toMatchObject({ from: "autosave" });
			expect((await stub.diff()).diff).toContain("+half done");
			// Claude Code's session went with the volume: the turn went on in a new one, told what it was doing.
			expect(runs[2]!.argv).not.toContain("--resume");
			expect(runs[2]!.argv).toContain("--session-id");
			expect(runs[2]!.argv.at(-1)).toContain(LOST_RESUME_TEXT);
			expect(runs[2]!.argv.at(-1)).toContain("The task you were given:\n\nFix the greeting test");
		});
	});

	it("runs one of the person's threads at a time on their login: the next waits for the first to end", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		claude = async () => {
			if (runs.length === 1) await gate;
			return { stdout: claudeFixture("turn") };
		};
		const first = await startClaude();
		await running(1);
		const second = await startClaude({ task: "Another task" });
		const heartbeat = (stub: Stub) => inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));
		await vi.waitFor(async () => expect(await second.stub.status()).toMatchObject({ stateReason: "harness_busy", currentOperation: null, inbox: 1 }));
		await heartbeat(second.stub);
		expect(runs).toHaveLength(1);
		release();
		await turns(first.id, 1);
		await heartbeat(second.stub);
		const [ended] = await turns(second.id, 1);
		expect(ended).toMatchObject({ outcome: "completed" });
		expect(runs.map((run) => run.argv.at(-1))).toEqual(["Fix the greeting test", "Another task"]);
	});

	it("waits for the person when the CLI says its login is gone, and goes on once continued", async () => {
		claude = async () => ({ stdout: claudeFixture("login"), code: 1 });
		const { id, stub } = await startClaude();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "needs_approval", reason: "login_required", state: "waiting_input" });
		expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required", slot: "held" });
		claude = async () => ({ stdout: claudeFixture("turn") });
		await stub.continue({ operationId: "after-login" });
		const [, again] = await turns(id, 2);
		expect(again).toMatchObject({ outcome: "completed", operationId: "after-login" });
		expect(runs[1]!.argv.at(-1)).toBe(CONTINUE_TEXT);
	});
});

describe("a Codex thread", () => {
	// The thread runs `codex` in its in-memory workspace, where it is a script that prints the JSONL of
	// test/fixtures/codex/, and `pkill` records the signal it was sent. The person's Codex login, `auth.json`, is in
	// the coding vault for real.
	type Run = { argv: string[]; env: Record<string, string>; cwd: string; login: string };
	const runs: Run[] = [];
	const signals: string[][] = [];
	const waiting: (() => void)[] = [];
	let codexCli: (context: Parameters<FakeCommandHandler>[0]) => Promise<FakeCommandResult> = async () => ({ stdout: codexFixture("turn") });
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const LOGIN = '{"auth_mode":"chatgpt","tokens":{"access_token":"eyJ-original-access","refresh_token":"rt_original"}}';
	const REFRESHED = '{"auth_mode":"chatgpt","tokens":{"access_token":"eyJ-refreshed-access","refresh_token":"rt_rotated"}}';
	const AUTH = "/workspace/.codex/auth.json";
	const started: Stub[] = [];

	codingWorkspaces.register("codex", async (context) => {
		const login = await context.workspace.readFile(`${context.env.CODEX_HOME}/auth.json`).then(
			(data) => decoder.decode(data),
			() => "",
		);
		runs.push({ argv: context.argv, env: context.env, cwd: context.cwd, login });
		return codexCli(context);
	});

	async function signIn(login = LOGIN) {
		const vault = codingVault(env);
		const { version } = await vault.load(OWNER, "codex");
		await vault.save(OWNER, "codex", [{ path: "auth.json", mode: 0o600, data: encoder.encode(login) }], version);
	}

	const storedLogin = async () => {
		const files = (await codingVault(env).load(OWNER, "codex")).files;
		return files ? decoder.decode(files.find((file) => file.path === "auth.json")!.data) : null;
	};

	async function startCodex(overrides: Partial<StartThread> = {}) {
		const id = crypto.randomUUID();
		await codingScheduler(env, OWNER).registerThread({ threadId: id, createdBy: { type: "person" }, parent: null, chat: null, harness: "codex", task: "Fix the greeting test", repo: REPO, ref: "main", budgetUsd: 3, createdAt: Date.now() });
		const stub = codingThread(env, id);
		started.push(stub);
		await stub.start(startInput(id, { space: OWNER, harness: "codex", task: "Fix the greeting test", ...overrides }));
		return { id, stub };
	}

	beforeEach(async () => {
		runs.length = 0;
		signals.length = 0;
		codexCli = async () => ({ stdout: codexFixture("turn") });
		await signIn();
	});

	afterEach(async () => {
		for (const stub of started.splice(0)) await stub.archive().catch(() => {});
	});

	it("runs a turn with the person's login, keeps its transcript, tokens, tests and refreshed login, then resumes Codex's session", async () => {
		codexCli = async ({ workspace }) => {
			await workspace.writeFile(`${REPO_DIR}/greet.ts`, encoder.encode("export const greet = (name: string) => `Hello, ${name}`;\n"));
			// Codex refreshed its token, rotating the refresh token, as it does.
			await workspace.writeFile(AUTH, encoder.encode(REFRESHED), 0o600);
			return { stdout: codexFixture("turn") };
		};
		const { id, stub } = await startCodex();
		const [ended] = await turns(id, 1);
		const status = await stub.status();
		expect(ended).toMatchObject({ outcome: "completed", said: "Fixed `greet` to include the name; the greeting test passes now." });
		expect(status).toMatchObject({ state: "idle", harness: "codex", profile: { providerId: "codex", model: "default" } });
		const [first] = runs;
		expect(first).toMatchObject({ cwd: REPO_DIR, login: LOGIN, env: { HOME: "/workspace", CODEX_HOME: "/workspace/.codex" } });
		expect(first!.argv.slice(0, 2)).toEqual(["codex", "exec"]);
		expect(first!.argv).not.toContain("resume");
		expect(first!.argv.slice(-2)).toEqual(["--", "Fix the greeting test"]);
		expect(first!.argv.find((arg) => arg.startsWith("developer_instructions="))).toContain(`on the branch ${status.repo.branch}`);
		const spec = (await workspaceOf(id)) as unknown as { spec: { egress: { allow: string[] } } };
		expect(spec.spec.egress.allow).toEqual(expect.arrayContaining(["auth.openai.com", "chatgpt.com", "api.openai.com", "registry.npmjs.org"]));
		// The rotated login is kept, and none is left in the workspace or the thread's tables.
		expect(await storedLogin()).toBe(REFRESHED);
		await expect((await workspaceOf(id)).readFile(AUTH)).rejects.toThrow();
		const tables = await everything(stub);
		for (const secret of ["eyJ-", "rt_original", "rt_rotated"]) expect(tables).not.toContain(secret);
		const transcript = await inside(stub, (thread) => thread.transcript());
		expect(transcript[0]!.parts).toEqual([{ type: "text", text: "Fix the greeting test" }]);
		expect(transcript.flatMap((message) => message.parts).find((part) => part.type === "tool-call" && part.name === "shell")).toMatchObject({ arguments: { command: "npm test" } });
		expect(transcript.at(-1)!.parts).toEqual([{ type: "text", text: "Fixed `greet` to include the name; the greeting test passes now." }]);
		// Its tokens as Codex counted them, at no cost, as it estimates none; its tests; its notices and retries.
		const log = await stub.log();
		expect(log.filter((event) => event.kind === "model_call")).toEqual([expect.objectContaining({ provider: "codex", model: "codex", costUsd: 0, input: 5110, output: 1180 })]);
		expect(status.spentUsd).toBe(0);
		expect(log.find((event) => event.kind === "harness.notice")?.data).toMatchObject({ message: expect.stringContaining("Falling back") });
		expect(log.find((event) => event.kind === "harness.api_retry")?.data).toMatchObject({ attempt: 1, status: 503 });
		expect((await stub.tests()).map((run) => [run.command, run.exitCode])).toEqual([
			["npm test", 1],
			["npx vitest run test/greet.test.ts && echo 'all good'", 0],
		]);
		expect((await stub.diff()).diff).toContain("+++ b/greet.ts");

		// A steer is the next turn, which resumes the session Codex named; its tokens are what the session's grew by.
		const turn = codexLines("turn");
		codexCli = async () => ({ stdout: [turn[0], turn.at(-2), turn.at(-1)!.replace('"input_tokens":24310', '"input_tokens":30310').replace('"output_tokens":1180', '"output_tokens":1500')].join("\n") });
		await stub.steer("Also add a test for an empty name", { operationId: "steer-1" });
		const [, second] = await turns(id, 2);
		expect(second).toMatchObject({ outcome: "completed", operationId: "steer-1" });
		expect(runs[1]!.argv.slice(-4)).toEqual(["resume", CODEX_SESSION, "--", "Also add a test for an empty name"]);
		expect(runs[1]!.login).toBe(REFRESHED);
		const calls = (await stub.log()).filter((event) => event.kind === "model_call");
		expect(calls[1]).toMatchObject({ input: 6000, output: 320, cacheRead: 0, costUsd: 0 });
	});

	it("doesn't hold Codex to a dollar budget, since it reports no cost: its spend is unmetered", async () => {
		// $0.02 against a turn that used 25,490 tokens: tokens are no price, so it neither stops nor refuses more.
		const { id, stub } = await startCodex({ budgetUsd: 0.02 });
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "completed", spentUsd: 0, unmetered: true });
		await stub.steer("Go on.", { operationId: "more" });
		const [, again] = await turns(id, 2);
		expect(again).toMatchObject({ outcome: "completed", operationId: "more" });
	});

	it("waits for the person when Codex says its login expired, and goes on once continued", async () => {
		codexCli = async () => ({ stdout: codexFixture("expired"), code: 1 });
		const { id, stub } = await startCodex();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "needs_approval", reason: "login_required", state: "waiting_input" });
		expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required" });
		codexCli = async () => ({ stdout: codexFixture("turn") });
		await stub.continue({ operationId: "after-login" });
		const [, again] = await turns(id, 2);
		expect(again).toMatchObject({ outcome: "completed", operationId: "after-login" });
	});

	it("waits for the person's login before running Codex when there is none", async () => {
		const vault = codingVault(env);
		await vault.delete(OWNER, "codex");
		const { stub } = await startCodex();
		await vi.waitFor(async () => expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required", inbox: 1 }), { timeout: 10_000, interval: 20 });
		expect((await stub.status()).stateDetail).toMatch(/Connect Codex/);
		expect(runs).toEqual([]);
	});

	it("stops on abort with SIGINT to the process the turn's id names, ending the turn cancelled, and keeps the login", async () => {
		// Registered here, once the Claude Code tests above have run, as it replaces their `pkill`.
		codingWorkspaces.register("pkill", ({ argv }) => {
			signals.push(argv.slice(1));
			for (const resolve of waiting.splice(0)) resolve();
			return {};
		});
		codexCli = async ({ killed }) => {
			await Promise.race([new Promise<void>((resolve) => waiting.push(resolve)), killed]);
			return { stdout: `${codexLines("turn")[0]}\n`, code: 1 };
		};
		const { id, stub } = await startCodex();
		await vi.waitFor(() => expect(runs).toHaveLength(1), { timeout: 10_000, interval: 20 });
		await stub.abort();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "cancelled" });
		expect(signals[0]![0]).toBe("-INT");
		// The id Pim gave the first turn, which its command line carries, as Codex hadn't named its session yet.
		expect(runs[0]!.argv.join(" ")).toContain(signals[0]![2]);
		expect(await storedLogin()).toBe(LOGIN);
	});
});

describe("a Mistral Vibe thread", () => {
	// The thread runs Vibe in its in-memory workspace, where `/bin/sh` is a script that prints the streaming output of
	// test/fixtures/vibe/ and leaves the export.json beside it that Vibe would. The person's API key is in the coding
	// vault for real.
	type Run = { argv: string[]; env: Record<string, string>; cwd: string };
	const runs: Run[] = [];
	let vibe: (run: Run & { workspace: Parameters<FakeCommandHandler>[0]["workspace"]; out: string }) => Promise<FakeCommandResult>;
	const KEY = "THREADMISTRALKEY0123456789abcdef";
	const started: Stub[] = [];
	const encoder = new TextEncoder();

	codingWorkspaces.register("/bin/sh", async ({ argv, env, cwd, workspace }) => {
		runs.push({ argv, env, cwd });
		// The shell's `$1` is the run's directory, where Vibe writes its export.
		return vibe({ argv, env, cwd, workspace, out: `${argv[4]}/out` });
	});

	/** Vibe's run that printed `name` and left its export. */
	const printsRun =
		(name: "turn" | "resume" | "auth", code = 0) =>
		async ({ workspace, out }: { workspace: Parameters<FakeCommandHandler>[0]["workspace"]; out: string }) => {
			await workspace.writeFile(`${out}/export.json`, encoder.encode(vibeExport(name)));
			await workspace.writeFile(`${out}/session/meta.json`, encoder.encode(VIBE_META));
			return { stdout: vibeOutput(name), code };
		};

	async function startVibe() {
		const id = crypto.randomUUID();
		await codingScheduler(env, OWNER).registerThread({ threadId: id, createdBy: { type: "person" }, parent: null, chat: null, harness: "mistral-vibe", task: "Fix the greeting test", repo: REPO, ref: "main", budgetUsd: 3, createdAt: Date.now() });
		const stub = codingThread(env, id);
		started.push(stub);
		await stub.start(startInput(id, { space: OWNER, harness: "mistral-vibe", task: "Fix the greeting test" }));
		return { id, stub };
	}

	beforeEach(async () => {
		runs.length = 0;
		vibe = printsRun("turn");
		expect((await api("/coding/vault/mistral-vibe/api-key", { method: "PUT", body: JSON.stringify({ apiKey: KEY }) })).status).toBe(200);
	});

	afterEach(async () => {
		for (const stub of started.splice(0)) await stub.archive().catch(() => {});
		await codingVault(env).delete(OWNER, "mistral-vibe");
	});

	it("runs a turn with the person's key, keeps its transcript, tests and cost, then resumes Vibe's session, counting only what the new run cost", async () => {
		const { id, stub } = await startVibe();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "completed", said: "Fixed `greet` to end with an exclamation mark; the greeting test passes now." });
		const [first] = runs;
		expect(first).toMatchObject({ cwd: REPO_DIR, env: { HOME: "/workspace", MISTRAL_API_KEY: KEY, VIBE_ENABLE_MCP: "false" } });
		expect(first!.argv[7]).toBe("vibe");
		expect(first!.argv).not.toContain("--resume");
		expect(first!.argv[5]).toContain(`on the branch ${(await stub.status()).repo.branch}`);
		expect(first!.argv[6]).toBe("Fix the greeting test");
		expect(JSON.stringify(first!.argv)).not.toContain(KEY);
		const spec = (await workspaceOf(id)) as unknown as { spec: { egress: { allow: string[] } } };
		expect(spec.spec.egress.allow).toEqual(expect.arrayContaining(["api.mistral.ai", "registry.npmjs.org"]));
		// The run's directory, with its export, is gone after.
		await expect((await workspaceOf(id)).readFile(`${first!.argv[4]}/out/export.json`)).rejects.toThrow();
		const transcript = await inside(stub, (thread) => thread.transcript());
		expect(transcript.flatMap((message) => message.parts).find((part) => part.type === "tool-call" && part.name === "file_system.bash")).toMatchObject({ arguments: { command: "npm test" } });
		expect((await stub.tests()).map((run) => [run.command, run.exitCode])).toEqual([
			["npm test", 1],
			["npm test", 0],
		]);
		// What the run cost, as Vibe estimated it, with its tokens, cached input apart.
		const log = await stub.log();
		expect(log.filter((event) => event.kind === "model_call")).toEqual([expect.objectContaining({ provider: "mistral-vibe", model: "mistral-vibe-cli-latest", costUsd: 0.007125, input: 2500, output: 200, cacheRead: 12500 })]);
		expect((await stub.status()).spentUsd).toBeCloseTo(0.007125, 12);

		// A steer is the next turn, which resumes the session Vibe named; its export counts that run alone.
		vibe = printsRun("resume");
		await stub.steer("Now say what you changed", { operationId: "steer-1" });
		const [, second] = await turns(id, 2);
		expect(second).toMatchObject({ outcome: "completed", operationId: "steer-1" });
		expect(runs[1]!.argv.slice(runs[1]!.argv.indexOf("--resume"), runs[1]!.argv.indexOf("--resume") + 2)).toEqual(["--resume", VIBE_SESSION]);
		const calls = (await stub.log()).filter((event) => event.kind === "model_call");
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({ input: 500, output: 40, cacheRead: 3500 });
		expect(calls[1]!.costUsd).toBeCloseTo(0.001575, 12);
		expect((await stub.status()).spentUsd).toBeCloseTo(0.0087, 12);
		// The key is nowhere in the thread's tables, its log or its transcript.
		expect(await everything(stub)).not.toContain(KEY);
		expect(JSON.stringify(await stub.log())).not.toContain(KEY);
		expect(JSON.stringify(await inside(stub, (thread) => thread.transcript()))).not.toContain(KEY);
	});

	it("waits for the person when Mistral refused the key, and goes on once continued", async () => {
		vibe = printsRun("auth", 1);
		const { id, stub } = await startVibe();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "needs_approval", reason: "login_required", state: "waiting_input" });
		expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required" });
		vibe = printsRun("turn");
		await stub.continue({ operationId: "after-key" });
		const [, again] = await turns(id, 2);
		expect(again).toMatchObject({ outcome: "completed", operationId: "after-key" });
	});
});

describe("an Amp thread", () => {
	// Amp signs in with the person's access token, from the coding vault. The thread runs `amp` in its in-memory
	// workspace, where it is a script that prints the stream-json of test/fixtures/amp/.
	const KEY = "sgamp_user_THREADKEY_0123456789abcdef";
	const started: Stub[] = [];
	const runs: { argv: string[]; env: Record<string, string> }[] = [];
	// What the next `amp` turn or `amp threads archive` does, set by the test that needs a failure.
	let behavior: { turn: "ok" | "crash" | "max-turns"; archive: "ok" | "fail" | "throw" } = { turn: "ok", archive: "ok" };
	const unarchives: string[][] = [];
	codingWorkspaces.register("amp", ({ argv, env }) => {
		if (argv.includes("--unarchive")) {
			unarchives.push(argv);
			return {};
		}
		runs.push({ argv, env });
		if (argv[1] === "threads" && argv[2] === "archive") {
			if (behavior.archive === "throw") throw new Error("amp is not installed");
			return behavior.archive === "fail" ? { stderr: "boom", exitCode: 1 } : {};
		}
		if (behavior.turn === "max-turns") return { stdout: ampFixture("max-turns.jsonl") };
		return behavior.turn === "crash" ? { stderr: "crashed", exitCode: 1 } : { stdout: ampFixture("turn.jsonl") };
	});
	const archiveRuns = () => runs.filter((run) => run.argv[1] === "threads" && run.argv[2] === "archive");

	async function startAmp(overrides: Partial<StartThread> = {}) {
		const id = crypto.randomUUID();
		await codingScheduler(env, OWNER).registerThread({ threadId: id, createdBy: { type: "person" }, parent: null, chat: null, harness: "amp", task: "Fix the greeting test", repo: REPO, ref: "main", budgetUsd: 3, createdAt: Date.now() });
		const stub = codingThread(env, id);
		started.push(stub);
		await stub.start(startInput(id, { space: OWNER, harness: "amp", task: "Fix the greeting test", ...overrides }));
		return { id, stub };
	}

	const saveKey = async () => expect((await api("/coding/vault/amp/api-key", { method: "PUT", body: JSON.stringify({ apiKey: KEY }) })).status).toBe(200);

	beforeEach(async () => {
		runs.length = 0;
		unarchives.length = 0;
		behavior = { turn: "ok", archive: "ok" };
		await codingVault(env).delete(OWNER, "amp");
	});

	afterEach(async () => {
		for (const stub of started.splice(0)) await stub.archive().catch(() => {});
		await codingVault(env).delete(OWNER, "amp");
	});

	it("waits for the person's key, then runs Amp with it, keeping its thread, transcript, tokens and tests but never the key", async () => {
		const { id, stub } = await startAmp();
		await vi.waitFor(async () => expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required", inbox: 1 }), { timeout: 10_000, interval: 20 });
		expect((await stub.status()).stateDetail).toBe("Connect Amp with your API key, then continue the thread");
		expect((await stub.log()).find((event) => event.kind === "thread.waiting_input")?.data).toMatchObject({ reason: "login_required", harness: "amp" });
		expect(runs).toEqual([]);
		// Its workspace may reach Amp, besides the broker and the registries.
		const spec = (await workspaceOf(id)) as unknown as { spec: { egress: { allow: string[] } } };
		expect(spec.spec.egress.allow).toEqual(expect.arrayContaining(["ampcode.com", "*.ampcode.com", "registry.npmjs.org"]));

		// Saving the key goes on with the thread, which runs Amp with it in its environment.
		await saveKey();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "completed", said: "Fixed `greet` to include the name; the greeting test passes now." });
		const [first] = runs;
		expect(first!.env).toMatchObject({ HOME: "/workspace", AMP_API_KEY: KEY, AMP_SKIP_UPDATE_CHECK: "1" });
		expect(first!.argv.slice(0, 2)).toEqual(["amp", "--stream-json"]);
		expect(first!.argv.at(-1)).toMatch(/^--execute=<instructions from="Pim">\nYou are working for a person[\s\S]*\n<\/instructions>\n\nFix the greeting test$/);
		expect(JSON.stringify(runs.map((run) => run.argv))).not.toContain("THREADKEY");
		// Its tokens as Amp counted them, at no cost, since it reports none; its tests, refusals and notices.
		const log = await stub.log();
		expect(log.filter((event) => event.kind === "model_call")).toEqual([expect.objectContaining({ provider: "amp", model: "high", costUsd: 0, input: 45, output: 477, cacheRead: 84518, cacheWrite: 17323 })]);
		expect((await stub.status()).spentUsd).toBe(0);
		expect(log.find((event) => event.kind === "harness.permission_denied")?.data).toMatchObject({ tool: "shell_command" });
		expect(log.find((event) => event.kind === "harness.notice")?.data).toMatchObject({ message: "A background subagent (toolu_01Bg) failed" });
		expect((await stub.tests()).map((run) => [run.command, run.exitCode])).toEqual([
			["npm test", 1],
			["npm test", 0],
		]);
		const transcript = await inside(stub, (thread) => thread.transcript());
		expect(transcript[0]!.parts).toEqual([{ type: "text", text: "Fix the greeting test" }]);
		expect(transcript.flatMap((message) => message.parts).find((part) => part.type === "tool-call" && part.name === "shell_command")).toMatchObject({ arguments: { command: "npm test" } });

		// A steer is the next turn, which goes on with Amp's thread.
		await stub.steer("Also add a test for an empty name", { operationId: "steer-1" });
		await turns(id, 2);
		// Amp's thread is unarchived first (it may have archived itself after `--execute`), then continued.
		expect(runs[1]!.argv.slice(0, 5)).toEqual(["amp", "threads", "archive", AMP_SESSION, "--unarchive"]);
		expect(runs[2]!.argv.slice(0, 4)).toEqual(["amp", "threads", "continue", AMP_SESSION]);
		expect(runs[2]!.argv.at(-1)).toBe("--execute=Also add a test for an empty name");
		// The key is nowhere in the thread's tables, its log or its transcript.
		expect(await everything(stub)).not.toContain("THREADKEY");
		expect(JSON.stringify(await stub.log())).not.toContain("THREADKEY");
		expect(JSON.stringify(await inside(stub, (thread) => thread.transcript()))).not.toContain("THREADKEY");
	});

	it("keeps an idle thread's Amp thread open, then archives it with the person's key when the Pim thread is archived", async () => {
		await saveKey();
		const { id, stub } = await startAmp();
		await turns(id, 1);
		expect(await stub.status()).toMatchObject({ state: "idle" });
		expect(archiveRuns()).toEqual([]);
		expect(await stub.archive()).toMatchObject({ state: "archived", slot: "none" });
		expect(archiveRuns().map((run) => run.argv)).toEqual([["amp", "threads", "archive", AMP_SESSION]]);
		expect(archiveRuns()[0]!.env).toMatchObject({ AMP_API_KEY: KEY });
		// Archiving again changes nothing.
		await stub.archive();
		expect(archiveRuns()).toHaveLength(1);
	});

	it("archives its Amp thread when a turn fails, and a thread that never started one has nothing to archive", async () => {
		await saveKey();
		behavior.turn = "crash";
		const never = await startAmp();
		expect((await turns(never.id, 1))[0]).toMatchObject({ outcome: "error", state: "failed" });
		await never.stub.archive();
		expect(archiveRuns()).toEqual([]);

		behavior.turn = "ok";
		const { id, stub } = await startAmp();
		await turns(id, 1);
		behavior.turn = "max-turns";
		await stub.steer("Again", { operationId: "steer-fail" });
		await turns(id, 2);
		expect(await stub.status()).toMatchObject({ state: "failed" });
		expect(archiveRuns().map((run) => run.argv)).toEqual([["amp", "threads", "archive", AMP_SESSION]]);

		// The failed thread goes on with the same Amp thread, which is unarchived first.
		behavior.turn = "ok";
		await stub.continue({ operationId: "continue-1" });
		await turns(id, 3);
		expect(runs.at(-1)!.argv.slice(0, 4)).toEqual(["amp", "threads", "continue", AMP_SESSION]);
		expect(unarchives.at(-1)).toEqual(["amp", "threads", "archive", AMP_SESSION, "--unarchive", ">/dev/null", "2>&1"]);
		expect(await stub.status()).toMatchObject({ state: "idle" });
	});

	it("never fails the thread when archiving its Amp thread fails", async () => {
		await saveKey();
		for (const archive of ["fail", "throw"] as const) {
			runs.length = 0;
			behavior.archive = archive;
			const { id, stub } = await startAmp();
			await turns(id, 1);
			expect(await stub.archive()).toMatchObject({ state: "archived", slot: "none" });
			expect(archiveRuns()).toHaveLength(1);
		}
	});

	it("doesn't enforce its dollar budget against Amp's tokens, which are not a cost and recount the whole context every response", async () => {
		await saveKey();
		// $0.03 would have allowed 30,000 tokens; the turn counts 102,363, mostly cache reads. It finishes: Amp's spend is unmetered, not exceeded.
		const { id, stub } = await startAmp({ budgetUsd: 0.03 });
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "completed", state: "idle", spentUsd: 0, unmetered: true });
		expect((await stub.status()).stateReason).toBeNull();
		expect((await stub.log()).some((event) => event.kind === "app.budget_stop")).toBe(false);
	});
});

describe("threadLimits", () => {
	it("uses the defaults, a repository's override, and lets explicit limits win", () => {
		expect(threadLimits("someone/else").memMiB).toBe(4096);
		expect(threadLimits("Ajac-Zero/Pim").memMiB).toBe(6144);
		expect(threadLimits("ajac-zero/pim", { memMiB: 2048 })).toMatchObject({ memMiB: 2048, cpu: 2 });
	});
});
