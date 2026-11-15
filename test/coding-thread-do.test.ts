import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CodingThreadStore } from "../src/coding/thread-store";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyBrokerToken } from "../src/coding/git-broker/broker";
import { brokerTokenKey } from "../src/coding/git-broker/routes";
import { codingScheduler } from "../src/coding/scheduler-do";
import { CONTINUE_TEXT, codingThread, isTransient, rateLimitRetryDelayMs, retryAfterMs, threadLimits } from "../src/coding/thread-do";
import { REPO_DIR } from "../src/coding/tools";
import { ComposeWorkspaceProvider } from "../src/coding/workspace/compose";
import { NO_BACKEND_MESSAGE, NoWorkspaceBackendError, workspaceBackends } from "../src/coding/workspace/registry";
import { fakeCloneFailures, fakeClones, fakePushes, fakePushFailures, fakeRemotes } from "./fake-git";
import { json } from "./fake-manager";
import { api, OWNER, post, toolUse } from "./helpers";
import { type CodingThreadDO, codingEvents, codingFaux, codingQuota, codingSchedulers, codingThreadClock, codingTimings, codingWorkspaces } from "./worker";
import { REPO, BROKER_URL, CODER, type Stub, startInput, startThread, turns, inside, everything, workspaceOf, fileIn, sql, sent , capped } from "./coding-thread-support";

describe("a coding thread's automatic push", () => {
	const commit = (name: string) => [toolUse("write", { path: `${name}.txt`, content: `${name}\n` }), toolUse("bash", { command: `git commit -m ${name}` })];

	beforeEach(() => {
		fakePushes.length = 0;
		fakePushFailures.clear();
		codingTimings.autopushMs = 20_000;
	});

	const run = async (responses: Parameters<typeof codingFaux.setResponses>[0]) => {
		codingFaux.setResponses(responses);
		const { id, stub, status } = await startThread();
		await turns(id, 1);
		return { id, stub, branch: status.repo.branch, final: await stub.status(), log: (await stub.log()).filter((event) => event.kind === "thread.autopush_failed") };
	};

	it("pushes the thread's own branch when HEAD advanced, and keeps the sha", async () => {
		const { branch, final, log } = await run([...commit("one"), fauxAssistantMessage("Done.")]);
		// The commit was pushed once: the push after the call, and the turn's end finding nothing new.
		expect(fakePushes.map((push) => ({ url: push.url, refspec: push.refspec }))).toEqual([{ url: BROKER_URL, refspec: `HEAD:refs/heads/${branch}` }]);
		expect(final.lastPushedSha).toBe(fakePushes[0]!.sha);
		expect(final.lastPushedSha).toBe(final.checkpoint!.sha);
		expect(log).toEqual([]);
	});

	it("pushes uncommitted work at the turn's end, after it is checkpointed", async () => {
		const { final } = await run([toolUse("write", { path: "loose.txt", content: "x\n" }), fauxAssistantMessage("Done.")]);
		expect(fakePushes).toHaveLength(1);
		expect(final.lastPushedSha).toBe(final.checkpoint!.sha);
	});

	it("pushes at most once per debounce while a turn runs, and at its end", async () => {
		codingThreadClock.now = 1_000_000;
		const { final } = await run([...commit("a"), ...commit("b"), ...commit("c"), fauxAssistantMessage("Done.")]);
		expect(fakePushes).toHaveLength(2);
		expect(final.lastPushedSha).toBe(fakePushes[1]!.sha);
		expect(fakePushes[0]!.sha).not.toBe(fakePushes[1]!.sha);
	});

	it("pushes after each call once the debounce has passed", async () => {
		codingThreadClock.now = 1_000_000;
		const step = (response: ReturnType<typeof toolUse>) => async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
			codingThreadClock.now! += 60_000;
			return response;
		};
		const [w1, c1] = commit("a");
		const [w2, c2] = commit("b");
		await run([w1!, c1!, step(w2!), c2!, step(fauxAssistantMessage("Done."))] as never);
		expect(fakePushes).toHaveLength(2);
	});

	it("pushes nothing when the turn made no commits", async () => {
		const { final } = await run([fauxAssistantMessage("Nothing to do.")]);
		expect(fakePushes).toEqual([]);
		expect(final.lastPushedSha).toBeNull();
	});

	it("pushes nothing from another branch", async () => {
		const { final, log } = await run([toolUse("bash", { command: "git checkout -B main HEAD" }), ...commit("other"), fauxAssistantMessage("Done.")]);
		expect(fakePushes).toEqual([]);
		expect(final.lastPushedSha).toBeNull();
		expect(log).toEqual([]);
	});

	it("pushes nothing from a detached HEAD", async () => {
		const { final } = await run([toolUse("bash", { command: "git checkout --detach HEAD" }), ...commit("loose"), fauxAssistantMessage("Done.")]);
		expect(fakePushes).toEqual([]);
		expect(final.lastPushedSha).toBeNull();
	});

	it("logs a failed push with the token redacted, doesn't fail the turn, and pushes at the next trigger", async () => {
		fakePushFailures.set(BROKER_URL, { times: 1, stderr: " ! [rejected] HEAD -> branch (non-fast-forward)\n" });
		const { stub, final, log } = await run([...commit("one"), fauxAssistantMessage("Done.")]);
		expect(log).toHaveLength(1);
		expect(log[0]!.data).toMatchObject({ failures: 1, error: expect.stringContaining("non-fast-forward") });
		expect(JSON.stringify(log)).not.toContain("pimgit_");
		expect(JSON.stringify(log)).toContain("[redacted]");
		// The turn ended as completed, and its end pushed what the call's push couldn't.
		expect(codingEvents.filter((event) => event.threadId === final.threadId)).toMatchObject([{ outcome: "completed" }]);
		expect(final.lastPushedSha).toBe(final.checkpoint!.sha);
		expect(await stub.log()).not.toContainEqual(expect.objectContaining({ kind: "thread.autopush_failed", data: expect.objectContaining({ failures: 2 }) }));
	});

	it("falls back to the turn's end after three failures in a row", async () => {
		fakePushFailures.set(BROKER_URL, { times: 100, stderr: "remote: rejected\n" });
		codingThreadClock.now = 1_000_000;
		const step = (response: unknown) => async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
			codingThreadClock.now! += 60_000;
			return response;
		};
		const calls = ["a", "b", "c", "d"].flatMap((name) => commit(name));
		const { final, log } = await run([calls[0]!, calls[1]!, ...calls.slice(2).map((call) => step(call)), step(fauxAssistantMessage("Done."))] as never);
		// Three tries after calls, none after the fourth, one at the end.
		expect(log.map((event) => (event.data as { failures: number }).failures)).toEqual([1, 2, 3, 4]);
		expect(final.lastPushedSha).toBeNull();
		expect(codingEvents.filter((event) => event.threadId === final.threadId)).toMatchObject([{ outcome: "completed" }]);
	});
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
		expect(prompt).toContain("The repository's full suite runs in its CI on the pushed branch");
		expect(prompt).toContain("never sleep-poll");
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
		codingTimings.retryMs = 50;
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
		// Four tries, then the whole provisioning once more after a backoff, which fares no better.
		expect(fakeClones.filter((each) => each.url === url)).toHaveLength(8);
		expect((await stub.log()).filter((event) => event.kind === "thread.retrying")).toHaveLength(1);
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
		await vi.waitFor(async () => expect(await sql(stub, "SELECT tool FROM coding_tool_journal")).toHaveLength(1), { timeout: 10_000, interval: 20 });
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
		expect(failed).toMatchObject({ outcome: "error", reason: "model_error", detail: expect.stringContaining("invalid request: unknown parameter") });
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

	it("says what the provider answered when a turn fails with a model error", async () => {
		const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
		codingFaux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: `400 {"error":{"message":"Incorrect API key provided: ${key}","type":"invalid_request_error","code":"invalid_api_key"}}` }),
		]);
		const { id, stub } = await startThread();
		const [failed] = await turns(id, 1);
		const detail = "HTTP 400 (invalid_request_error, code invalid_api_key): Incorrect API key provided: [REDACTED]";
		expect(failed).toMatchObject({ outcome: "error", reason: "model_error", detail: expect.stringContaining(detail) });
		const status = await stub.status();
		expect(status).toMatchObject({ state: "failed", stateReason: "model_error", stateDetail: expect.stringContaining(detail) });
		expect(status.stateDetail).not.toContain(key);
	});

	it("never leaves a model error without a detail, even when the provider said nothing", async () => {
		// Nothing said is retried once like any model error; the retry fails the same way and ends the thread with the detail.
		codingTimings.retryMs = 50;
		codingFaux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "" }), fauxAssistantMessage("", { stopReason: "error", errorMessage: "" })]);
		const { id, stub } = await startThread();
		const [failed] = await turns(id, 1);
		expect(failed).toMatchObject({ outcome: "error", reason: "model_error" });
		expect(failed!.detail).toMatch(/ended with no error message/);
		expect((await stub.status()).stateDetail).toMatch(/ended with no error message/);
	});

	describe("when a turn fails for a transient error", () => {
		const providerDown = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "The model stream ended unexpectedly" });

		it("retries it once after a backoff in the same workspace, records the original error, and charges nothing twice", async () => {
			codingTimings.retryMs = 200;
			let retried = "";
			codingFaux.setResponses([
				toolUse("bash", { command: "echo kept" }),
				providerDown(),
				(context) => {
					retried = sent(context);
					return fauxAssistantMessage("Carried on.");
				},
			]);
			const { id, stub } = await startThread({ profile: { providerId: "coding-faux", model: "pricey" }, budgetUsd: 1_000_000 });
			const [ended] = await turns(id, 1);
			expect(ended).toMatchObject({ outcome: "completed" });
			expect(ended!.operationId).toMatch(/^retry-/);
			expect(retried).toContain(CONTINUE_TEXT);
			// The failed turn never reached the supervisor as a failure.
			expect(codingEvents.filter((event) => event.threadId === id && event.outcome === "error")).toEqual([]);
			// The retry went on in the one workspace, .
			expect(await codingWorkspaces.list({ sessionId: id })).toHaveLength(1);
			const log = await stub.log();
			expect(log.find((event) => event.kind === "thread.retrying")?.data).toMatchObject({ reason: "model_error", error: expect.stringContaining("ended unexpectedly") });
			// Each model call is recorded once, and spend is the sum of them.
			const calls = log.filter((event) => event.kind === "model_call");
			expect((await stub.status()).spentUsd).toBeCloseTo(calls.reduce((sum, event) => sum + (event.costUsd ?? 0), 0), 6);
			expect(await stub.status()).toMatchObject({ state: "idle", stateReason: null });
		});

		it("waits out the backoff before retrying", async () => {
			codingTimings.retryMs = 60_000;
			codingFaux.setResponses([providerDown(), fauxAssistantMessage("Never asked.")]);
			const { stub } = await startThread();
			await vi.waitFor(async () => expect(await stub.status()).toMatchObject({ stateReason: "retrying", inbox: 1 }), { timeout: 10_000, interval: 10 });
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(await stub.status()).toMatchObject({ stateReason: "retrying", inbox: 1 });
			// A person's message goes at once and withdraws the retry.
			codingFaux.setResponses([fauxAssistantMessage("Heard you.")]);
			await stub.steer("Never mind, do this", { operationId: "steer-now" });
			await vi.waitFor(async () => expect(await stub.status()).toMatchObject({ state: "idle", stateReason: null, inbox: 0 }), { timeout: 10_000, interval: 20 });
		});

		it("retries only once: a failed retry leaves the thread failed", async () => {
			codingTimings.retryMs = 50;
			codingFaux.setResponses([providerDown(), providerDown()]);
			const { id, stub } = await startThread();
			const [failed] = await turns(id, 1);
			expect(failed).toMatchObject({ outcome: "error", reason: "model_error", operationId: expect.stringMatching(/^retry-/) });
			expect(await stub.status()).toMatchObject({ state: "failed", stateReason: "model_error", inbox: 0 });
			expect((await stub.log()).filter((event) => event.kind === "thread.retrying")).toHaveLength(1);
		});

		// Workers AI's per-minute cap, as an `AiError` reaches a thread once pi gave up on it: the account shares the limit, so it outlasts one backoff.
		// The uuid in the error is fixed, not random: a random one can spell a run of digits — a "500" or "429" inside it — that reads as a
		// transient error to pi, which then retries the model call inside the turn (waiting out its own two-second backoff) and takes two
		// scripted responses for one retry, so the thread is seen to retry only five times. Fixed, it trips no retry but the thread's own.
		const rateLimited = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: `inference request per min rate reached (4f0e2b3c-9a71-4a2e-8d17-e45d1f1c3d21)` });

		it("retries a rate limited turn again and again, waiting longer each time, until the cap lifts", async () => {
			codingTimings.retryMs = 50;
			codingFaux.setResponses([rateLimited(), rateLimited(), rateLimited(), rateLimited(), rateLimited(), rateLimited(), fauxAssistantMessage("Free at last.")]);
			const { id, stub } = await startThread();
			const [ended] = await turns(id, 1);
			expect(ended).toMatchObject({ outcome: "completed" });
			// The turn that succeeded was the sixth retry of the one that began the thread.
			expect(ended!.operationId).toMatch(/^(retry-){6}start-/);
			const retrying = (await stub.log()).filter((event) => event.kind === "thread.retrying");
			expect(retrying).toHaveLength(6);
			expect(retrying.map((event) => event.data!.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
			// Every wait is longer than the one before it: the backoff grows with each retry.
			const waits = retrying.map((event) => Number(event.data!.retryAt) - event.at);
			expect(waits.every((wait, index) => index === 0 || wait > waits[index - 1]!)).toBe(true);
			expect(await stub.status()).toMatchObject({ state: "idle", stateReason: null });
		});

		it("gives up on a rate limit that never lifts after six retries, leaving the thread failed", async () => {
			codingTimings.retryMs = 50;
			codingFaux.setResponses([rateLimited(), rateLimited(), rateLimited(), rateLimited(), rateLimited(), rateLimited(), rateLimited()]);
			const { id, stub } = await startThread();
			const [failed] = await turns(id, 1);
			expect(failed).toMatchObject({ outcome: "error", reason: "model_error" });
			expect(failed!.operationId).toMatch(/^(retry-){6}start-/);
			expect((await stub.log()).filter((event) => event.kind === "thread.retrying")).toHaveLength(6);
			expect(await stub.status()).toMatchObject({ state: "failed", stateReason: "model_error", inbox: 0 });
		});

		it.each([
			["a rejected key", "401 Unauthorized: invalid api key"],
			["a bad request", "400 Bad Request: messages must not be empty"],
			["a usage limit", "usage limit reached for this month"],
		])("does not retry %s", async (_name, errorMessage) => {
			codingFaux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);
			const { id, stub } = await startThread();
			const [failed] = await turns(id, 1);
			expect(failed).toMatchObject({ outcome: "error", reason: "model_error" });
			expect((await stub.log()).filter((event) => event.kind === "thread.retrying")).toEqual([]);
			expect(await stub.status()).toMatchObject({ state: "failed", stateReason: "model_error" });
		});

		it("tells transient errors from permanent ones", () => {
			// pi-ai retries many of these inside a model call; what reaches a thread is what it gave up on.
			expect(isTransient("model_error", "429 Too Many Requests")).toBe(true);
			expect(isTransient("model_error", "502 Bad Gateway")).toBe(true);
			expect(isTransient("model_error", "")).toBe(true);
			expect(isTransient("harness_error", "WebSocket connection failed")).toBe(true);
			expect(isTransient("harness_error", "Amp exited without a result: read ECONNRESET")).toBe(true);
			expect(isTransient("workspace", "Workspace manager unavailable (503)")).toBe(true);
			expect(isTransient("model_error", "403 Forbidden")).toBe(false);
			expect(isTransient("model_error", "Coding thread out of budget: spent $2")).toBe(false);
			expect(isTransient("harness_error", "Claude Code usage limit reached: resets at 5pm")).toBe(false);
			expect(isTransient("harness_error", "Amp exited without a result: crashed")).toBe(false);
			expect(isTransient("aborted", "connection closed")).toBe(false);
			expect(isTransient("max_turns", "The turn reached its most steps")).toBe(false);
			// Workers AI's per-minute cap: neither its words nor the uuid in them read as a permanent error.
			expect(isTransient("model_error", "AiError: AiError: rate limiting: inference request per min rate reached (4f0e2b3c-9a71-4a2e-8d17-e45d1f1c3d21)")).toBe(true);
		});

		it("waits longer before each retry of a rate limited turn, up to a cap, and honors the provider's retry-after", () => {
			// A minute the first time, half again more each retry, at most five minutes, with jitter on top.
			const waits = [1, 2, 3, 4, 5].map((attempt) => rateLimitRetryDelayMs(attempt, null));
			expect(waits[0]).toBeGreaterThanOrEqual(60_000);
			expect(waits[0]).toBeLessThan(70_000);
			for (let index = 1; index < waits.length; index++) expect(waits[index]).toBeGreaterThan(waits[index - 1]!);
			expect(rateLimitRetryDelayMs(9, null)).toBeLessThanOrEqual(5 * 60_000 + 10_000);
			// A provider that says when to come back is obeyed, past the backoff and the cap alike.
			expect(rateLimitRetryDelayMs(1, 8 * 60_000)).toBe(8 * 60_000);
			expect(retryAfterMs("rate limited (429): retry-after: 90")).toBe(90_000);
			expect(retryAfterMs('429 Too Many Requests, headers: {"retry-after": "120"}')).toBe(120_000);
			expect(retryAfterMs("429 Too Many Requests")).toBeNull();
		});
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
		expect((await stub.log()).map((event) => event.kind)).toEqual(["model.resolved", "thread.turn_started", "model_call", "thread.turn_ended", "app.budget_stop"]);
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
		codingSchedulers.now = Date.now() + 11 * 60_000;
		expect(await scheduler.sweep()).toEqual({ released: [{ threadId: id, why: "idle" }], admitted: [] });
		await runDurableObjectAlarm(scheduler);
		codingSchedulers.now = null;
		expect(await stub.status()).toMatchObject({ state: "idle", slot: "none" });
		expect(await codingWorkspaces.list({ sessionId: id })).toMatchObject([{ state: "stopped" }]);
		// The checkpoint's diff is kept without a workspace.
		expect((await stub.diff()).diff).toContain("+++ b/a.txt");
		await stub.steer("Anything else?", { operationId: "steer-2" });
		const [, ended] = await turns(id, 2);
		expect(ended).toMatchObject({ outcome: "completed", operationId: "steer-2" });
		expect(await stub.status()).toMatchObject({ state: "idle", slot: "held", repo: { baseSha: "base0000" } });
		expect(await fileIn(id, "a.txt")).toBe("A\n");
		expect(await stub.checkpoints()).toHaveLength(1);
	});

	it("suspends after two idle minutes, wakes the FIFO head immediately, and steers through slot acquisition", async () => {
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		await scheduler.setLimit(1);
		codingFaux.setResponses([toolUse("write", { path: "kept.txt", content: "kept\n" }), fauxAssistantMessage("First done."), fauxAssistantMessage("Head done."), fauxAssistantMessage("Resumed.")]);
		const first = await startThread({ space });
		await turns(first.id, 1);
		const second = await startThread({ space });
		expect(second.status.state).toBe("queued");
		const [row] = await sql(first.stub, "SELECT idle_since FROM coding_thread");
		const heartbeat = () => inside(first.stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));
		codingThreadClock.now = Number(row!.idle_since) + 2 * 60_000 - 1;
		const next = await heartbeat();
		expect(next).toMatchObject({ rescheduleAt: expect.any(Number) });
		expect((await first.stub.status()).slot).toBe("held");
		codingThreadClock.now++;
		await heartbeat();
		expect(await first.stub.status()).toMatchObject({ state: "idle", slot: "none" });
		expect(await codingWorkspaces.list({ sessionId: first.id })).toMatchObject([{ state: "stopped" }]);
		// No scheduler alarm is needed to notify and start the newly admitted head.
		await turns(second.id, 1);
		await first.stub.steer("Continue", { operationId: "resume-idle" });
		await vi.waitFor(async () => expect(await first.stub.status()).toMatchObject({ state: "queued", slot: "queued" }));
		await second.stub.archive();
		await turns(first.id, 2);
		expect(await fileIn(first.id, "kept.txt")).toBe("kept\n");
	});

	it("recovers a missed idle alarm through the periodic scheduler sweep", async () => {
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		await scheduler.setLimit(1);
		codingFaux.setResponses([fauxAssistantMessage("Idle."), fauxAssistantMessage("Head awake.")]);
		const first = await startThread({ space });
		await turns(first.id, 1);
		const second = await startThread({ space });
		const idle = (await scheduler.snapshot()).running[0]!;
		codingSchedulers.now = idle.activitySince + 2 * 60_000;
		await runDurableObjectAlarm(scheduler);
		codingSchedulers.now = null;
		await turns(second.id, 1);
		expect(await first.stub.status()).toMatchObject({ state: "idle", slot: "none" });
		expect(await codingWorkspaces.list({ sessionId: first.id })).toMatchObject([{ state: "stopped" }]);
	});

	it("does not suspend while inputs wait for their retry backoff", async () => {
		codingFaux.setResponses([fauxAssistantMessage("Idle.")]);
		const { id, stub, input } = await startThread();
		await turns(id, 1);
		const [row] = await sql(stub, "SELECT idle_since FROM coding_thread");
		codingThreadClock.now = Number(row!.idle_since) + 3 * 60_000;
		await inside(stub, async (thread) => {
			thread.store.enqueue("waiting", "Continue", { notBefore: Date.now() + 60_000 });
			await thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]);
		});
		expect((await stub.status()).slot).toBe("held");
		expect(await codingWorkspaces.list({ sessionId: id })).toMatchObject([{ state: "running" }]);
		expect((await codingScheduler(env, input.space).snapshot()).running[0]!.activity).toBe("running");
	});

	it("does not suspend a running turn when an idle grace alarm fires", async () => {
		codingFaux.setResponses([toolUse("bash", { command: "sleep 30" })]);
		const { id, stub, input } = await startThread();
		await vi.waitFor(async () => expect(await sql(stub, "SELECT tool FROM coding_tool_journal")).toHaveLength(1), { timeout: 10_000, interval: 20 });
		codingThreadClock.now = Date.now() + 3 * 60_000;
		await inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));
		codingSchedulers.now = codingThreadClock.now;
		expect(await codingScheduler(env, input.space).sweep()).toMatchObject({ released: [] });
		expect(await stub.status()).toMatchObject({ state: "running", slot: "held" });
		expect(await codingWorkspaces.list({ sessionId: id })).toMatchObject([{ state: "running" }]);
		codingThreadClock.now = null;
		codingSchedulers.now = null;
		await stub.abort();
		await turns(id, 1);
	});

	describe("resuming a released workspace for a tool", () => {
		/** A thread with two checkpoints, whose idle slot was then taken back; the first checkpoint's diff to the second was never made. */
		async function released(space = `space-${crypto.randomUUID()}`) {
			codingFaux.setResponses([toolUse("write", { path: "a.txt", content: "A\n" }), fauxAssistantMessage("Wrote a."), toolUse("write", { path: "b.txt", content: "B\n" }), fauxAssistantMessage("Wrote b.")]);
			const thread = await startThread({ space });
			await turns(thread.id, 1);
			await thread.stub.steer("And b.", { operationId: "b" });
			await turns(thread.id, 2);
			const [first] = await thread.stub.checkpoints();
			const scheduler = codingScheduler(env, space);
			codingSchedulers.now = Date.now() + 11 * 60_000;
			expect(await scheduler.sweep()).toEqual({ released: [{ threadId: thread.id, why: "idle" }], admitted: [] });
			await runDurableObjectAlarm(scheduler);
			codingSchedulers.now = null;
			expect(await thread.stub.status()).toMatchObject({ state: "idle", slot: "none" });
			expect(await codingWorkspaces.list({ sessionId: thread.id })).toMatchObject([{ state: "stopped" }]);
			return { ...thread, scheduler, first: first! };
		}

		it("makes a diff that isn't kept, by resuming the workspace with no turn, and goes back to idle", async () => {
			const { id, stub, scheduler, first } = await released();
			const diff = await stub.diff(first.sha);
			expect(diff.diff).toContain("+++ b/b.txt");
			expect(await stub.status()).toMatchObject({ state: "idle", slot: "held", currentOperation: null, inbox: 0 });
			expect(await codingWorkspaces.list({ sessionId: id })).toHaveLength(1);
			expect(await fileIn(id, "a.txt")).toBe("A\n");
			// No turn began, and the scheduler was told it is idle, so it takes the slot back in time.
			expect(codingEvents.filter((event) => event.threadId === id)).toHaveLength(2);
			expect((await scheduler.snapshot()).running).toEqual([expect.objectContaining({ threadId: id, activity: "idle" })]);
			await stub.archive();
		});

		it("does nothing to a thread that already holds a slot", async () => {
			const { id, stub, first } = await released();
			await stub.diff(first.sha);
			const slot = (await codingScheduler(env, `space-${id}`).snapshot()).running;
			const workspaces = await codingWorkspaces.list({ sessionId: id });
			await expect(inside(stub, (thread) => thread.diff("base0000"))).resolves.toMatchObject({ truncated: false });
			await expect(stub.diff(first.sha)).resolves.toMatchObject({ since: first.sha });
			expect((await codingScheduler(env, `space-${id}`).snapshot()).running).toEqual(slot);
			expect(await codingWorkspaces.list({ sessionId: id })).toEqual(workspaces);
			await stub.archive();
		});

		it("says it is queued, with its place, while its space has no free slot, and resumes once one frees", async () => {
			const space = `space-${crypto.randomUUID()}`;
			const { id, stub, scheduler, first } = await released(space);
			await scheduler.setLimit(1);
			codingFaux.setResponses([fauxAssistantMessage("Other done.")]);
			const other = await startThread({ space });
			await turns(other.id, 1);
			codingTimings.resumeWaitMs = 300;
			await expect(inside(stub, (thread) => thread.diff(first.sha))).rejects.toThrow(/still queued for a sandbox slot \(position 1 of 1, .*\)/);
			expect(await stub.status()).toMatchObject({ slot: "queued", queue: { position: 1 }, inbox: 0 });
			// It stays queued for the slot, which it gets, and makes its workspace, when another thread gives one up.
			await other.stub.archive();
			await vi.waitFor(async () => expect(await stub.status()).toMatchObject({ state: "idle", slot: "held" }), { timeout: 10_000, interval: 50 });
			expect(codingEvents.filter((event) => event.threadId === id)).toHaveLength(2);
			await stub.archive();
		});
	});

	it("checkpoints uncommitted work when its idle slot is taken back after two minutes, and resumes at the checkpoint in a new workspace once the kept volume is gone", async () => {
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		codingFaux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Back.")]);
		const { id, stub } = await startThread({ space });
		await turns(id, 1);
		await (await workspaceOf(id)).writeFile(`${REPO_DIR}/notes.txt`, new TextEncoder().encode("Draft\n"));
		const before = (await stub.log()).length;
		// One minute idle is not enough; two are.
		codingSchedulers.now = Date.now() + 60_000;
		expect(await scheduler.sweep()).toEqual({ released: [], admitted: [] });
		codingSchedulers.now = Date.now() + 2 * 60_000 + 1_000;
		expect(await scheduler.sweep()).toEqual({ released: [{ threadId: id, why: "idle" }], admitted: [] });
		await runDurableObjectAlarm(scheduler);
		codingSchedulers.now = null;
		expect(await stub.status()).toMatchObject({ state: "idle", slot: "none" });
		expect((await scheduler.snapshot()).running).toEqual([]);
		expect(await codingWorkspaces.list({ sessionId: id })).toMatchObject([{ state: "stopped" }]);
		expect(await stub.checkpoints()).toEqual([expect.objectContaining({ message: "Checkpoint 1", operationId: null })]);
		expect((await stub.diff()).diff).toContain("+Draft");
		// Only the checkpoint was recorded: no turn, no other work.
		const added = (await stub.log()).slice(before).map((event) => event.kind);
		expect(added.filter((kind) => kind !== "checkpoint.created" && kind !== "workspace.released")).toEqual([]);
		// The kept volume is reclaimed, so a steer starts a new workspace from the saved work.
		await codingWorkspaces.destroy((await codingWorkspaces.list({ sessionId: id }))[0]!.ref);
		codingWorkspaces.loseVolume(id);
		await stub.steer("Carry on.", { operationId: "resume" });
		const [, again] = await turns(id, 2);
		expect(again).toMatchObject({ outcome: "completed", operationId: "resume" });
		expect(await stub.status()).toMatchObject({ state: "idle", slot: "held" });
		expect(await fileIn(id, "notes.txt")).toBe("Draft\n");
		expect((await stub.log()).find((event) => event.kind === "workspace.restored")?.data).toMatchObject({ from: "autosave" });
		await stub.archive();
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

	it("checkpoints and gives its workspace up when its slot is taken back while it waits, then asks again in FIFO order", async () => {
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

	it("retries no capacity once for another 30 minutes then fails and notifies once", async () => {
		const space = `space-${crypto.randomUUID()}`;
		const scheduler = codingScheduler(env, space);
		await scheduler.setLimit(0);
		const second = await startThread({ space });
		expect(second.status.state).toBe("queued");
		const initial = (await scheduler.snapshot()).queued[0]!;
		codingSchedulers.now = initial.deadlineAt - 1;
		await runDurableObjectAlarm(scheduler);
		expect((await second.stub.status()).stateReason).not.toBe("no_capacity");
		codingSchedulers.now = initial.deadlineAt;
		await runDurableObjectAlarm(scheduler);
		expect(await second.stub.status()).toMatchObject({ state: "queued", stateReason: "no_capacity", slot: "queued", inbox: 1, stateDetail: expect.stringContaining("Retrying automatically") });
		const retry = (await scheduler.snapshot()).queued[0]!;
		expect(retry.queuedAt).toBe(initial.deadlineAt);
		expect(retry.deadlineAt - retry.queuedAt).toBe(30 * 60_000);
		// Redelivery of the first notice cannot consume the second attempt.
		await second.stub.expired(initial, `coding:expired:${second.id}:1`);
		codingSchedulers.now = retry.deadlineAt;
		await runDurableObjectAlarm(scheduler);
		codingSchedulers.now = null;
		expect(await second.stub.status()).toMatchObject({ state: "failed", stateReason: "no_capacity", slot: "none", inbox: 1, stateDetail: expect.stringContaining("fake: full") });
		expect(await scheduler.snapshot()).toMatchObject({ running: [], queued: [] });
		expect(await sql(second.stub, "SELECT kind FROM coding_event WHERE kind = 'thread.no_capacity'")).toHaveLength(2);
		expect(codingEvents.filter((event) => event.threadId === second.id)).toEqual([expect.objectContaining({ outcome: "error", reason: "no_capacity", state: "failed" })]);
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
		await vi.waitFor(async () => expect(await sql(stub, "SELECT tool FROM coding_tool_journal")).toHaveLength(1), { timeout: 10_000, interval: 20 });
		await runInDurableObject(stub, (_instance: CodingThreadDO, state) => state.abort("evicted")).catch(() => {});
		const [ended] = await turns(id, 1, true);
		expect(ended!.outcome).toBe("completed");
		// The call ran again after the reset found its journal entry, so it told the model it was interrupted rather than running twice.
		expect(after).toContain("bash was interrupted, state unknown");
		expect(await codingThread(env, id).status()).toMatchObject({ state: "idle", currentOperation: null });
	});
});

describe("a coding thread's model", () => {
	it("records the space default at start and the actual model on later calls, once per change, across eviction", async () => {
		codingFaux.setResponses([fauxAssistantMessage("First."), fauxAssistantMessage("Second."), fauxAssistantMessage("Third.")]);
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		const status = await inside(stub, async (thread) => {
			vi.spyOn(thread as unknown as { defaultProfile(space: string): Promise<typeof CODER> }, "defaultProfile").mockResolvedValue(CODER);
			return thread.start(startInput(id, { profile: undefined }));
		});
		expect(status.resolvedProfile).toEqual({ provider: "coding-faux", model: "coder", source: "space default" });
		await turns(id, 1);
		// A runtime model change, such as a fallback, must not be mistaken for the requested profile.
		await inside(stub, async (thread) => {
			const root = await (await thread.harness.pi()).root(BACKGROUND_CONTEXT);
			await root.configure({ model: { provider: "coding-faux", modelId: "pricey" } }, BACKGROUND_CONTEXT);
		});
		await stub.steer("Again.", { operationId: "second" });
		await turns(id, 2);
		expect((await stub.status()).resolvedProfile).toEqual({ provider: "coding-faux", model: "pricey", source: "space default" });
		await stub.steer("Once more.", { operationId: "third" });
		await turns(id, 3);
		const notices = (await inside(stub, (thread) => thread.transcript())).filter((message) => message.role === "notice");
		expect(notices.map((message) => message.parts)).toEqual([
			[{ type: "text", text: "Model: coding-faux · coder · space default" }],
			[{ type: "text", text: "Model: coding-faux · pricey · space default" }],
		]);
		expect((await stub.log()).filter((event) => event.kind === "model.resolved")).toHaveLength(2);
		await runInDurableObject(stub, (_thread: CodingThreadDO, state) => state.abort("evicted")).catch(() => {});
		const restored = codingThread(env, id);
		expect((await restored.status()).resolvedProfile).toEqual({ provider: "coding-faux", model: "pricey", source: "space default" });
		expect((await inside(restored, (thread) => thread.transcript())).filter((message) => message.role === "notice")).toEqual(notices);
		await restored.archive();
	});

	it("migrates an older thread without guessing its profile source", async () => {
		codingFaux.setResponses([fauxAssistantMessage("Done.")]);
		const { id, stub } = await startThread();
		await turns(id, 1);
		await runInDurableObject(stub, (_thread: CodingThreadDO, state) => {
			state.storage.sql.exec("ALTER TABLE coding_thread DROP COLUMN resolved_profile");
			const migrated = new CodingThreadStore(state.storage.sql);
			expect(migrated.required().profile).toEqual(CODER);
			expect(migrated.required().resolvedProfile).toBeNull();
		});
		await stub.archive();
	});

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
		expect((await stub.status()).resolvedProfile).toEqual({ provider: providerId, model: "coder-1", source: "explicit" });
		const stored = await everything(stub);
		expect(stored).toContain("All done.");
		expect(stored).not.toContain(key);
		await stub.archive();
	});
});

describe("threadLimits", () => {
	it("uses the defaults, a repository's override, and lets explicit limits win", () => {
		expect(threadLimits("someone/else").memMiB).toBe(4096);
		expect(threadLimits("Ajac-Zero/Pim").memMiB).toBe(6144);
		expect(threadLimits("ajac-zero/pim", { memMiB: 2048 })).toMatchObject({ memMiB: 2048, cpu: 2 });
	});
});

describe("a coding thread's compute", () => {
	// The ledger (src/compute-ledger.ts) lives in the Gallery; a thread's rows are read there. Time goes by `codingThreadClock`.
	const heartbeat = (stub: Stub) => inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));
	const rows = (id: string) =>
		runInDurableObject(env.Gallery.getByName("gallery"), (_instance: unknown, state: DurableObjectState) =>
			state.storage.sql.exec("SELECT end_reason, cap_at FROM compute_usage WHERE thread_id = ? ORDER BY id", id).toArray(),
		);
	const unlimited = { maxConcurrentWorkspaces: null, monthlySandboxMinutes: null, maxSessionMinutes: null };
	const MINUTE = 60_000;

	afterEach(() => {
		codingQuota.quota = null;
	});

	/** A thread that ran its task and sits idle with its workspace. */
	async function idle() {
		codingFaux.setResponses([fauxAssistantMessage("Done.")]);
		const thread = await startThread();
		await turns(thread.id, 1);
		return thread;
	}

	it("stops a workspace that is still running past its session limit, keeping its files, and counts it as stopped", async () => {
		codingQuota.quota = { ...unlimited, maxSessionMinutes: 10 };
		const thread = await idle();
		const [row] = await rows(thread.id);
		expect(row).toMatchObject({ end_reason: null, cap_at: expect.any(Number) });
		expect(await codingWorkspaces.list({ sessionId: thread.id })).toHaveLength(1);
		// Before its time, and inside the two-minute idle grace, nothing happens at a heartbeat.
		codingThreadClock.now = Date.now() + 1 * MINUTE;
		await heartbeat(thread.stub);
		expect(await codingWorkspaces.list({ sessionId: thread.id })).toHaveLength(1);
		// Past it, the provider is told to delete the workspace and the ledger ends the stretch as stopped.
		codingThreadClock.now = Date.now() + 11 * MINUTE;
		await heartbeat(thread.stub);
		expect(await codingWorkspaces.list({ sessionId: thread.id })).toEqual([]);
		expect(await rows(thread.id)).toEqual([expect.objectContaining({ end_reason: "stop" })]);
		expect(await thread.stub.status()).toMatchObject({ state: "idle", stateReason: "compute_quota" });
	});

	it("stops a turn under way when its workspace's session limit is up", async () => {
		codingQuota.quota = { ...unlimited, maxSessionMinutes: 10 };
		codingFaux.setResponses([toolUse("bash", { command: "sleep 30" })]);
		const thread = await startThread();
		await vi.waitFor(async () => expect((await thread.stub.status()).currentOperation).not.toBeNull());
		codingThreadClock.now = Date.now() + 11 * MINUTE;
		await heartbeat(thread.stub);
		expect((await turns(thread.id, 1))[0]).toMatchObject({ outcome: "cancelled" });
		expect(await codingWorkspaces.list({ sessionId: thread.id })).toEqual([]);
		expect(await rows(thread.id)).toEqual([expect.objectContaining({ end_reason: "stop" })]);
	});

	it("lets a thread on a fresh deployment run past 120 minutes: there is no limit until the admin sets one", async () => {
		const thread = await idle();
		expect(await rows(thread.id)).toEqual([{ end_reason: null, cap_at: null }]);
		// Only the idle grace ends the stretch, as a suspend; no limit stops the workspace or marks the thread.
		codingThreadClock.now = Date.now() + 300 * MINUTE;
		await heartbeat(thread.stub);
		expect(await codingWorkspaces.list({ sessionId: thread.id })).toHaveLength(1);
		expect(await rows(thread.id)).toEqual([{ end_reason: "suspend", cap_at: null }]);
		expect(await thread.stub.status()).toMatchObject({ state: "idle", stateReason: null });
	});

	it("ends the count of a workspace its provider no longer has, as lost", async () => {
		const thread = await idle();
		const [info] = await codingWorkspaces.list({ sessionId: thread.id });
		await codingWorkspaces.destroy(info!.ref);
		await heartbeat(thread.stub);
		expect(await rows(thread.id)).toEqual([expect.objectContaining({ end_reason: "lost" })]);
	});

	describe("across a move to a new session", () => {
		const ledger = (id: string) =>
			runInDurableObject(env.Gallery.getByName("gallery"), (_instance: unknown, state: DurableObjectState) =>
				state.storage.sql.exec("SELECT started_at, ended_at, end_reason, cap_at FROM compute_usage WHERE thread_id = ? ORDER BY id", id).toArray(),
			);
		const sleeping = () => [toolUse("bash", { command: "sleep 30" })];
		const running = (stub: Stub) => vi.waitFor(async () => expect(await sql(stub, "SELECT tool FROM coding_tool_journal")).toHaveLength(1), { timeout: 15_000, interval: 50 });

		it("ends the old stretch and begins a new one, once each", async () => {
			const { t0 } = capped();
			codingQuota.quota = { ...unlimited, maxSessionMinutes: 10 };
			codingFaux.setResponses([...sleeping(), fauxAssistantMessage("Done.")]);
			const { id, stub } = await startThread();
			await running(stub);
			expect(await ledger(id)).toEqual([{ started_at: t0, ended_at: null, end_reason: null, cap_at: t0 + 10 * MINUTE }]);
			codingThreadClock.now = t0 + 48_000;
			await heartbeat(stub);
			await turns(id, 1);
			// A heartbeat after the move counts nothing more.
			await heartbeat(stub);
			expect(await ledger(id)).toEqual([
				{ started_at: t0, ended_at: t0 + 48_000, end_reason: "suspend", cap_at: t0 + 10 * MINUTE },
				// The session limit carries over: moving doesn't begin another one.
				{ started_at: t0 + 48_000, ended_at: null, end_reason: null, cap_at: t0 + 10 * MINUTE },
			]);
		});

		it("still fires the session limit after a move, when the provider's sessions are shorter than it", async () => {
			const { t0 } = capped();
			codingQuota.quota = { ...unlimited, maxSessionMinutes: 2 };
			codingFaux.setResponses([...sleeping(), ...sleeping()]);
			const { id, stub } = await startThread();
			await running(stub);
			codingThreadClock.now = t0 + 48_000;
			await heartbeat(stub);
			await vi.waitFor(async () => expect((await stub.status()).session).toMatchObject({ continuations: 1 }));
			expect((await ledger(id))[1]).toMatchObject({ started_at: t0 + 48_000, cap_at: t0 + 2 * MINUTE });
			// Past the limit of the first session, the second's own minute isn't up yet, and the workspace is stopped all the same.
			codingThreadClock.now = t0 + 2 * MINUTE + 1_000;
			await heartbeat(stub);
			await vi.waitFor(async () => expect(await ledger(id)).toEqual([expect.anything(), expect.objectContaining({ end_reason: "stop" })]));
			expect(await stub.status()).toMatchObject({ state: "idle", stateReason: "compute_quota" });
			codingFaux.setResponses([]);
		});

		it("ends the turn with the quota's reason when it refuses the new session, and doesn't try again", async () => {
			const { provider, t0 } = capped();
			// The command the move stops may be followed by another call; the turn is stopped by the refusal either way, so what is left unused is dropped.
			codingFaux.setResponses([...sleeping(), ...sleeping()]);
			const { id, stub } = await startThread();
			await running(stub);
			codingQuota.quota = { ...unlimited, maxSessionMinutes: 0 };
			const resume = vi.spyOn(provider, "resumeOrCreate");
			codingThreadClock.now = t0 + 48_000;
			await heartbeat(stub);
			await vi.waitFor(async () => expect(await stub.status()).toMatchObject({ state: "failed", stateReason: "compute_quota" }));
			expect((await turns(id, 2)).map((event) => event.outcome)).toEqual(["cancelled", "error"]);
			await heartbeat(stub);
			expect(resume).not.toHaveBeenCalled();
			expect(await ledger(id)).toEqual([expect.objectContaining({ ended_at: t0 + 48_000, end_reason: "suspend" })]);
			expect(await sql(stub, "SELECT kind FROM coding_event WHERE kind LIKE 'session.%'")).toEqual([{ kind: "session.continuing" }]);
			codingFaux.setResponses([]);
		});

		it("ends at the earlier of the compute cap and the provider's session limit", async () => {
			const { t0 } = capped();
			// The provider's limit (a minute) is earlier than the quota's ten.
			codingQuota.quota = { ...unlimited, maxSessionMinutes: 10 };
			codingFaux.setResponses(sleeping());
			const first = await startThread();
			await running(first.stub);
			expect((await first.stub.status()).session).toMatchObject({ maxMin: 1, expiresAt: t0 + 60_000 });
			await first.stub.abort();
			await turns(first.id, 1);
			// The quota's thirty seconds are earlier than the provider's minute: the workspace is stopped, not moved.
			codingQuota.quota = { ...unlimited, maxSessionMinutes: 0.5 };
			codingFaux.setResponses(sleeping());
			const second = await startThread();
			await running(second.stub);
			expect((await second.stub.status()).session).toMatchObject({ maxMin: 1, expiresAt: t0 + 30_000 });
			codingThreadClock.now = t0 + 31_000;
			await heartbeat(second.stub);
			expect((await turns(second.id, 1))[0]).toMatchObject({ outcome: "cancelled" });
			expect(await ledger(second.id)).toEqual([expect.objectContaining({ end_reason: "stop" })]);
			expect((await second.stub.status()).session).toMatchObject({ continuations: 0 });
		});

		it("leaves no stretch open for a workspace lost mid-move, and counts the one made after it", async () => {
			const { provider, t0 } = capped();
			codingFaux.setResponses([...sleeping(), fauxAssistantMessage("Restarted and done.")]);
			let open!: () => void;
			const gate = new Promise<void>((resolve) => (open = resolve));
			const resume = provider.resumeOrCreate.bind(provider);
			let tried = 0;
			provider.resumeOrCreate = async (ref, spec) => {
				if (tried++ > 0) return resume(ref, spec);
				await gate;
				await provider.destroy(ref, { keepVolume: false });
				throw new Error("The workspace is gone");
			};
			const { id, stub } = await startThread();
			await running(stub);
			codingThreadClock.now = t0 + 48_000;
			await heartbeat(stub);
			await vi.waitFor(() => expect(tried).toBe(1));
			// A heartbeat in the middle of the move doesn't take the workspace that is being brought back for lost.
			await heartbeat(stub);
			expect((await ledger(id)).map((row) => row.end_reason)).toEqual(["suspend", null]);
			open();
			await turns(id, 1);
			// The provider failed the move: its stretch ends as failed, and nothing is left open for the workspace that is gone.
			await vi.waitFor(async () => expect((await ledger(id)).map((row) => row.end_reason)).toEqual(["suspend", "failed"]));
			await heartbeat(stub);
			expect((await ledger(id)).filter((row) => row.ended_at === null)).toEqual([]);
		});

		it("closes the stretch when the person stops and archives the thread during the move", async () => {
			const { provider, t0 } = capped();
			codingFaux.setResponses([...sleeping(), ...sleeping()]);
			let open!: () => void;
			const gate = new Promise<void>((resolve) => (open = resolve));
			const resume = provider.resumeOrCreate.bind(provider);
			provider.resumeOrCreate = async (ref, spec) => {
				await gate;
				return resume(ref, spec);
			};
			const { id, stub } = await startThread();
			await running(stub);
			codingThreadClock.now = t0 + 48_000;
			await heartbeat(stub);
			await vi.waitFor(async () => expect((await ledger(id)).map((row) => row.end_reason)).toEqual(["suspend", null]));
			const stopped = stub.abort().then(() => stub.archive());
			open();
			await stopped;
			await vi.waitFor(async () => expect((await ledger(id)).filter((row) => row.ended_at === null)).toEqual([]));
			expect((await ledger(id)).map((row) => row.end_reason)).toEqual(["suspend", expect.stringMatching(/^(stop|suspend)$/)]);
		});
	});
});
