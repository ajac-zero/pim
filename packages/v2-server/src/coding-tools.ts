// What an agent reads of a coding thread, in the words and limits v1's `coding_*` tools had (src/extensions/coding.ts): enough to decide what to do next, never a raw row (no nonce, no lease), and a diff or a test run cut to what fits a model's context.
import type { ThreadDiff, ThreadView } from "@pim/v2-forge/forge";

/** The most of a diff the model reads at once. */
export const MAX_DIFF_CHARS = 30_000;
/** How many test runs, and how much of each one's output, the model reads. */
export const MAX_TEST_RUNS = 5;
export const MAX_TEST_OUTPUT_CHARS = 1_500;
/** How many threads a list shows. */
export const MAX_LISTED = 20;
/** A commit, as git names it; a branch or a commit for the diff's `head`. */
export const COMMIT = /^[0-9a-zA-Z]{4,64}$/;
export const BRANCH_OR_COMMIT = /^[\w./-]{1,200}$/;

/** The thread an agent names, by either spelling of the argument: v1's `thread_id` or the `thread` v2's first tools took. */
export const threadArg = (a: { thread_id?: string; thread?: string }): string => {
	const given = a.thread_id ?? a.thread;
	if (typeof given !== "string" || !given.trim()) throw new Error("Say which coding thread: thread_id is required");
	return given;
};

type Queue = { position: number | null };
type Checkpoint = { sha: string; message: string } | null;

/** How a thread is doing: its state, harness, where its work is, and what it has spent. */
export function brief(t: Omit<ThreadView, "capabilities"> & { capabilities?: ThreadView["capabilities"] }, o: { link: (id: string) => string; queue: Queue; checkpoint: Checkpoint }) {
	const pool = t.placement?.pool ?? "";
	// Null for a harness that reports no cost (Codex, Amp): its spend is unmetered, not $0.
	const unmetered = t.capabilities?.cost === "tokens-only" || (t.harness === "amp" && t.spentUsd === 0);
	const environment = (t.provisioning as { environment?: object } | null)?.environment;
	return {
		thread_id: t.threadId,
		url: o.link(t.threadId),
		status: t.state,
		harness: t.harness,
		...(t.orb ? { orb: { ...(t.orb.threadId ? { thread_id: t.orb.threadId } : {}), url: t.orb.url } } : {}),
		...(t.stateReason ? { reason: t.stateReason } : {}),
		...(t.stateDetail ? { detail: t.stateDetail } : {}),
		...(o.queue.position !== null ? { position: o.queue.position, waiting_for: "slots_full" } : {}),
		repo: t.repo,
		branch: t.branch ?? "",
		provider: t.workspaceRef?.provider ?? t.placement?.provider ?? "",
		pool,
		task: t.task.length > 300 ? `${t.task.slice(0, 300)}…` : t.task,
		turn_under_way: t.state === "running",
		checkpoint: o.checkpoint,
		...(environment ? { environment } : {}),
		spent_usd: unmetered ? null : Number(t.spentUsd.toFixed(4)),
		budget_usd: t.budgetUsd,
	};
}

/** The space's threads, newest first. */
export function listing(rows: { threadId: string; harness: string; status: string; repo: string; branch: string | null; task: string; orb?: { threadId?: string; url?: string } | null }[]) {
	return {
		threads: rows.slice(0, MAX_LISTED).map((t) => ({
			thread_id: t.threadId,
			harness: t.harness,
			...(t.orb?.url ? { orb_url: t.orb.url, ...(t.orb.threadId ? { orb_id: t.orb.threadId } : {}) } : {}),
			status: t.status,
			repo: t.repo,
			branch: t.branch ?? "",
			task: t.task.length > 120 ? `${t.task.slice(0, 120)}…` : t.task,
		})),
		...(rows.length > MAX_LISTED ? { more: rows.length - MAX_LISTED } : {}),
	};
}

/** A thread's diff as the model reads it: cut at what fits, with where the rest is. */
export function diffText(d: ThreadDiff, branch: string | null, page: string): string {
	if (d.unpushedOrb) return `No pushed branch or commit found on the git host yet (checked ${branch ?? "its branch"}). Amp Orb threads run in Amp's cloud without a Pim workspace, so coding_diff only sees changes once pushed to GitHub/Gitea (or pass head=<branch-or-sha> if pushed under another name). Read coding_transcript / coding_transcript_output for what the agent did so far, or coding_steer it to push a pim/* branch.`;
	if (!d.diff) return d.head ? "No changes." : "Nothing committed yet: each turn's changes are committed when it ends.";
	const clipped = d.diff.length > MAX_DIFF_CHARS;
	const more = clipped ? `\n[… ${d.diff.length - MAX_DIFF_CHARS} more characters: see ${page}]` : d.truncated ? "\n[The diff was too large to keep whole.]" : "";
	return `From ${d.since ?? "the start"} to ${d.head ?? "its latest work"}:\n${clipped ? d.diff.slice(0, MAX_DIFF_CHARS) : d.diff}${more}`;
}

type Run = { command: string; exit_code?: number | null; exitCode?: number | null; timedOut?: boolean; summary?: { passed: number; failed: number; skipped: number } | null; output: string };

/** One test run for the model: the command, how it exited, the counts when the runner said them, and the end of its output. */
export const testRun = (run: Run, o: { output?: boolean } = {}) => ({
	command: run.command,
	exit_code: run.exitCode ?? run.exit_code ?? null,
	...(run.timedOut ? { timed_out: true } : {}),
	...(run.summary ? { passed: run.summary.passed, failed: run.summary.failed, skipped: run.summary.skipped } : {}),
	...(o.output === false ? {} : { output: run.output.length > MAX_TEST_OUTPUT_CHARS ? `…${run.output.slice(-MAX_TEST_OUTPUT_CHARS)}` : run.output }),
});

/** The latest test runs, newest first. */
export const latestTests = (rows: Run[], n = MAX_TEST_RUNS, o: { output?: boolean } = {}) => (rows.length === 0 ? "It hasn't run any tests." : rows.slice(-n).reverse().map((r) => testRun(r, o)));

/** What a push told the model: where the branch is, and on github.com the page that compares it. */
export function pushedMessage(repoUrl: string, repo: string, outcome: string, sha: string, branch: string): string {
	const host = new URL(repoUrl).host;
	if (outcome === "unchanged") return `${branch} on ${host}/${repo} was already at ${sha.slice(0, 12)}.`;
	return `Pushed ${branch} (${sha.slice(0, 12)}) to ${host}/${repo}${host === "github.com" ? `: https://github.com/${repo}/compare/${encodeURIComponent(branch)}?expand=1` : "."} Open a pull request with coding_open_pull_request.`;
}
