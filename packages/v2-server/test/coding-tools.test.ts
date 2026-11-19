import { describe, expect, it } from "vitest";
import { BRANCH_OR_COMMIT, MAX_DIFF_CHARS, MAX_LISTED, MAX_TEST_OUTPUT_CHARS, MAX_TEST_RUNS, brief, diffText, latestTests, listing, pushedMessage, threadArg } from "../src/coding-tools.ts";

const thread = { threadId: "t1", ownerId: "ada", harness: "pi", state: "idle", stateReason: null, stateDetail: null, task: "x".repeat(400), repo: "https://github.com/acme/app", branch: "pim/x-t1", placement: { pool: "default" }, workspaceRef: { provider: "compose" }, orb: null, provisioning: { environment: { state: "ready" } }, spentUsd: 1.23456789, budgetUsd: 5, capabilities: { cost: "per-call" } } as never;

describe("what an agent reads of a coding thread", () => {
	it("takes v1's thread_id or the thread it was later given, and says which is missing", () => {
		expect(threadArg({ thread_id: "a" })).toBe("a");
		expect(threadArg({ thread: "b" })).toBe("b");
		expect(() => threadArg({})).toThrow(/thread_id is required/);
	});

	it("briefs a thread without what only Forge may hold, and keeps what the agent decides by", () => {
		const b = brief({ ...(thread as object), gatewayNonce: "secret", leaseHolder: "w1" } as never, { link: (id) => `/coding/${id}`, queue: { position: 2 }, checkpoint: { sha: "abc", message: "Checkpoint 1" } });
		expect(JSON.stringify(b)).not.toMatch(/secret|w1|gatewayNonce|leaseHolder/);
		expect(b).toMatchObject({ thread_id: "t1", url: "/coding/t1", status: "idle", position: 2, waiting_for: "slots_full", pool: "default", provider: "compose", turn_under_way: false, spent_usd: 1.2346, budget_usd: 5, checkpoint: { sha: "abc" }, environment: { state: "ready" } });
		expect(b.task.length).toBe(301);
		// A harness that reports no cost is unmetered, not free.
		expect(brief({ ...(thread as object), harness: "codex", capabilities: { cost: "tokens-only" } } as never, { link: String, queue: { position: null }, checkpoint: null }).spent_usd).toBeNull();
	});

	it("lists at most twenty threads and says how many more there are", () => {
		const rows = Array.from({ length: MAX_LISTED + 3 }, (_, i) => ({ threadId: `t${i}`, harness: "amp", status: "running", repo: "r", branch: "b", task: "y".repeat(200), orb: { threadId: "T-1", url: "https://ampcode.com/threads/T-1" } }));
		const out = listing(rows);
		expect(out.threads).toHaveLength(MAX_LISTED);
		expect(out.more).toBe(3);
		expect(out.threads[0]).toMatchObject({ orb_url: "https://ampcode.com/threads/T-1", orb_id: "T-1" });
		expect(out.threads[0]!.task.length).toBe(121);
	});

	it("cuts a diff to what a model reads, and says where the rest is", () => {
		const big = "d".repeat(MAX_DIFF_CHARS + 50);
		const text = diffText({ source: "workspace", diff: big, unpushedOrb: false, since: "aaa", head: "bbb", truncated: false }, "b", "/coding/t1");
		expect(text.startsWith("From aaa to bbb:\n")).toBe(true);
		expect(text).toContain("[… 50 more characters: see /coding/t1]");
		expect(diffText({ source: "workspace", diff: "", unpushedOrb: false, since: null, head: null, truncated: false }, "b", "")).toMatch(/Nothing committed yet/);
		expect(diffText({ source: "workspace", diff: "", unpushedOrb: false, since: "a", head: "b", truncated: false }, "b", "")).toBe("No changes.");
		expect(diffText({ source: "orb", diff: "", unpushedOrb: true, since: null, head: null, truncated: false }, "amp/feature", "")).toContain("checked amp/feature");
	});

	it("reads the latest five test runs newest first, with counts and the end of the output", () => {
		const run = (i: number) => ({ command: `run ${i}`, exit_code: i % 2, output: `${"o".repeat(MAX_TEST_OUTPUT_CHARS)}END${i}`, summary: { passed: i, failed: 0, skipped: 1 } });
		const out = latestTests(Array.from({ length: 7 }, (_, i) => run(i))) as { command: string; passed: number; output: string }[];
		expect(out.map((r) => r.command)).toEqual(["run 6", "run 5", "run 4", "run 3", "run 2"]);
		expect(out).toHaveLength(MAX_TEST_RUNS);
		expect(out[0]).toMatchObject({ passed: 6, exit_code: 0 });
		expect(out[0]!.output.startsWith("…")).toBe(true);
		expect(out[0]!.output.endsWith("END6")).toBe(true);
		expect(out[0]!.output.length).toBe(MAX_TEST_OUTPUT_CHARS + 1);
		expect(latestTests([])).toBe("It hasn't run any tests.");
		expect(latestTests([run(1)], 3, { output: false })).toEqual([{ command: "run 1", exit_code: 1, passed: 1, failed: 0, skipped: 1 }]);
	});

	it("says where a push went", () => {
		expect(pushedMessage("https://github.com/acme/app", "acme/app", "pushed", "a".repeat(40), "pim/x")).toBe(`Pushed pim/x (${"a".repeat(12)}) to github.com/acme/app: https://github.com/acme/app/compare/pim%2Fx?expand=1 Open a pull request with coding_open_pull_request.`);
		expect(pushedMessage("https://gitea.example/acme/app", "acme/app", "unchanged", "b".repeat(40), "pim/x")).toBe(`pim/x on gitea.example/acme/app was already at ${"b".repeat(12)}.`);
		expect(BRANCH_OR_COMMIT.test("pim/x-1")).toBe(true);
		expect(BRANCH_OR_COMMIT.test("a b")).toBe(false);
	});
});
