import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codingScheduler } from "../src/coding/scheduler-do";
import { CONTINUE_TEXT, codingThread, REPO_DIR, type StartThread } from "../src/coding/thread-do";
import { fakeRemotes } from "./fake-git";
import { OWNER, post, toolUse } from "./helpers";
import { type CodingThreadDO, codingEvents, codingFaux, codingSchedulers, codingWorkspaces } from "./worker";

// Each thread here works in the in-memory workspace with a fake git, talks to the scripted `coding-faux` model, and
// asks a scheduler of its own space for a slot; the schedulers tell threads what happens to them for real.

const REPO = "https://git.example.test/demo.git";
fakeRemotes.set(REPO, { "README.md": "# Demo\n" });

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
		// Nothing changed, so there is no checkpoint and no diff.
		expect(idle.checkpoint).toBeNull();
		expect((await stub.diff()).diff).toBe("");
		// The web app can follow it: a snapshot first.
		const reader = (await stub.events()).getReader();
		const { value } = await reader.read();
		expect(JSON.parse(new TextDecoder().decode(value).split("\n")[0]!)).toMatchObject({ type: "snapshot" });
		await reader.cancel();
	});

	it("refuses a workspace provider or model the space doesn't have, recording nothing", async () => {
		const id = crypto.randomUUID();
		const stub = codingThread(env, id);
		await expect(inside(stub, (thread) => thread.start(startInput(id, { workspaceProvider: "compose" })))).rejects.toThrow('no workspace provider "compose"');
		await expect(inside(stub, (thread) => thread.start(startInput(id, { profile: { providerId: "coding-faux", model: "nope" } })))).rejects.toThrow("has no model nope");
		await expect(inside(stub, (thread) => thread.start(startInput(id, { profile: { providerId: "own:nope", model: "x" } })))).rejects.toThrow("no model provider own:nope");
		await expect(inside(stub, (thread) => thread.status())).rejects.toThrow("never started");
	});

	it("runs the model's tool calls in its workspace, commits a checkpoint, and keeps its diff, tests and journal", async () => {
		let result = "";
		codingFaux.setResponses([
			toolUse("write_file", { path: "hello.txt", content: "Hello!\n" }),
			toolUse("run", { argv: ["echo", "1 passed"], test: true }),
			(context) => {
				result = sent(context);
				return fauxAssistantMessage("Added hello.txt; the tests pass.");
			},
		]);
		const { id, stub } = await startThread();
		const [ended] = await turns(id, 1);
		expect(result).toContain("exit 0\\n1 passed");
		const status = await stub.status();
		expect(status.checkpoint).toMatchObject({ message: `Checkpoint 1 (start-${id})`, operationId: `start-${id}` });
		expect(ended).toMatchObject({ outcome: "completed", checkpoint: status.checkpoint!.sha });
		// The file is in the workspace, committed on the thread's branch.
		const [info] = await codingWorkspaces.list({ sessionId: id });
		const workspace = (await codingWorkspaces.get(info!.ref))!;
		expect(new TextDecoder().decode(await workspace.readFile(`${REPO_DIR}/hello.txt`))).toBe("Hello!\n");
		expect(await stub.diff()).toEqual({
			since: "base0000",
			head: status.checkpoint!.sha,
			diff: "diff --git a/hello.txt b/hello.txt\n--- /dev/null\n+++ b/hello.txt\n+Hello!\n",
			truncated: false,
		});
		expect(await stub.tests()).toEqual([expect.objectContaining({ command: "echo 1 passed", exitCode: 0, passed: 1, failed: 0, summary: "1 passed\n" })]);
		expect(await sql(stub, "SELECT tool, args, status, result FROM coding_tool_journal")).toEqual([
			{ tool: "run", args: JSON.stringify({ argv: ["echo", "1 passed"] }), status: "ok", result: JSON.stringify({ code: 0, output: "1 passed\n" }) },
		]);
		const transcript = await inside(stub, (thread) => thread.transcript());
		expect(transcript.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
	});

	it("takes a steer into the turn under way", async () => {
		let second = "";
		codingFaux.setResponses([
			toolUse("run", { argv: ["sleep", "1"] }),
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
		codingFaux.setResponses([toolUse("run", { argv: ["sleep", "30"] })]);
		const { id, stub } = await startThread();
		await vi.waitFor(async () => expect(await sql(stub, "SELECT tool FROM coding_tool_journal")).toHaveLength(1));
		const stopping = Date.now();
		const status = await stub.abort();
		expect(Date.now() - stopping).toBeLessThan(5_000);
		expect(status).toMatchObject({ state: "idle", currentOperation: null });
		const [ended] = await turns(id, 1);
		expect(ended!.outcome).toBe("cancelled");
		// The test tool doesn't pass pi's abort signal on: the thread killed the command itself.
		await vi.waitFor(async () =>
			expect(await sql(stub, "SELECT status, result FROM coding_tool_journal")).toEqual([{ status: "error", result: JSON.stringify({ code: null, output: "" }) }]),
		);
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
		codingFaux.setResponses([toolUse("run", { argv: ["echo", "hi"] })]);
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
		codingFaux.setResponses([toolUse("write_file", { path: "a.txt", content: "A\n" }), fauxAssistantMessage("Wrote a.txt."), fauxAssistantMessage("Still here.")]);
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
		const [info] = await codingWorkspaces.list({ sessionId: id });
		const workspace = (await codingWorkspaces.get(info!.ref))!;
		expect(new TextDecoder().decode(await workspace.readFile(`${REPO_DIR}/a.txt`))).toBe("A\n");
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

	it("goes on with an interrupted turn after its object is reset", async () => {
		let after = "";
		codingFaux.setResponses([
			toolUse("run", { argv: ["sleep", "1"] }),
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
		// The tool call isn't replay-safe, so the model was told it was interrupted rather than it running twice.
		expect(after).toMatch(/interrupted/i);
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
		const stored = await runInDurableObject(stub, (_instance: CodingThreadDO, state) => {
			const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray();
			return JSON.stringify(tables.map(({ name }) => state.storage.sql.exec(`SELECT * FROM "${String(name)}"`).toArray()));
		});
		expect(stored).toContain("All done.");
		expect(stored).not.toContain(key);
		await stub.archive();
	});
});
