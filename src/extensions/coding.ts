import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { deploymentSettings } from "../deployment";
import { type CodingThreadView, threadPath } from "../coding/api";
import { codingThread } from "../coding/thread-do";
import { CodingError, calling, listThreads, liveThread, ownedThread, startThread, threadView } from "../coding/threads";
import { defineGatedAction, definePimExtension } from "./define";
import { json, text } from "./services";

/**
 * Coding threads for every agent: it can start one on a GitHub repository,
 * follow it, steer it, read its diff and tests, stop it, archive it, and
 * ask the person to push its branch. A thread an agent starts is recorded as
 * started by that agent from that chat, which is woken when each of the
 * thread's turns ends (src/coding/supervisor.ts). The tools reach only the
 * space's own threads (src/coding/threads.ts). See docs/coding-api.md.
 */

/** The most of a diff the model reads at once. */
const MAX_DIFF_CHARS = 30_000;
/** How many test runs, and how much of each one's output, the model reads. */
const MAX_TEST_RUNS = 5;
const MAX_TEST_OUTPUT_CHARS = 1_500;
/** A commit, as git names it. */
const COMMIT = /^[0-9a-zA-Z]{4,64}$/;
/** How many threads a list shows. */
const MAX_LISTED = 20;

const link = (threadId: string) => `${deploymentSettings(env).publicUrl ?? ""}${threadPath(threadId)}`;

/** What the model reads of a thread: enough to decide what to do next. */
function brief(view: CodingThreadView) {
	return {
		thread_id: view.id,
		url: link(view.id),
		status: view.state,
		...(view.stateReason ? { reason: view.stateReason } : {}),
		...(view.stateDetail ? { detail: view.stateDetail } : {}),
		...(view.queue ? { position: view.queue.position, waiting_for: view.queue.reason } : {}),
		repo: view.repo.url,
		branch: view.repo.branch,
		task: view.task.length > 300 ? `${view.task.slice(0, 300)}…` : view.task,
		turn_under_way: view.currentOperation !== null,
		inputs_waiting: view.inbox,
		checkpoint: view.checkpoint ? { sha: view.checkpoint.sha, message: view.checkpoint.message } : null,
		// Every field that says something, so the model can tell where the time to readiness went: durations in ms, times in ms since the epoch.
		environment: Object.fromEntries(Object.entries(view.environment).filter(([, value]) => value !== null && value !== undefined)),
		spent_usd: Number(view.spentUsd.toFixed(4)),
		budget_usd: view.budgetUsd,
	};
}

/** A refusal the model can act on, rather than a failed call. */
async function answer(work: () => Promise<ReturnType<typeof text>>) {
	try {
		return await work();
	} catch (error) {
		if (error instanceof CodingError) return text(JSON.stringify({ error: error.code, message: error.message }), true);
		throw error;
	}
}

const ThreadId = Type.String({ description: "The thread's ID, as coding_start or coding_status gave it." });

export const coding = definePimExtension({
	id: "coding",
	name: "Coding threads",
	description: "Coding agents that work on GitHub repositories in workspaces of their own.",
	ability: ({ space, conversationOf }) => ({
		tools: [
			defineTool({
				name: "coding_start",
				description:
					"Start a coding thread: a coding agent that works on a GitHub repository in a workspace of its own, on a new branch (pim/…), on the task you give it. Use it for changes to a codebase: fixing a bug, adding a feature, writing tests. Write the task as you would for a capable engineer who knows nothing of this conversation: what to change, why, and how to check it. It returns at once, often queued while a workspace is made ready; don't wait for it. You are told in this chat when each of its turns ends. Then read its work with coding_diff and coding_tests, say more with coding_steer, and ask the person to push it with coding_push.",
				parameters: Type.Object({
					repo: Type.String({ description: "https://github.com/<owner>/<name>" }),
					ref: Type.Optional(Type.String({ description: "The branch, tag or commit to start from; main by default." })),
					task: Type.String({ minLength: 1 }),
					profile: Type.Optional(
						Type.Object(
							{ provider: Type.String(), model: Type.String() },
							{ description: "The model it runs on, by provider and model id. Leave it out for the space's default." },
						),
					),
					harness: Type.Optional(
						Type.Union([Type.Literal("pi"), Type.Literal("claude-code"), Type.Literal("codex"), Type.Literal("mistral-vibe"), Type.Literal("amp")], {
							description: "The coding agent that runs it; pi by default. The others run the vendor's own CLI signed in as the person, who connects it on the coding page first.",
						}),
					),
					budget: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "The most it may spend on its model, in US dollars; 3 by default." })),
					parent: Type.Optional(Type.String({ description: "The thread this one continues from, if any." })),
					rebuildEnvironment: Type.Optional(Type.Boolean({ description: "When true, start with a freshly rebuilt environment, skipping any cached snapshot. Default false." })),
				}),
				replay: "safe",
				async execute({ repo, ref, task, profile, harness, budget, parent, rebuildEnvironment }, api, context) {
					// The same call run again starts the same thread.
					const operationId = await api.memo("operation", crypto.randomUUID(), context);
					const { chat, agent } = conversationOf(String(api.conversationId));
					return answer(async () => {
						const { view } = await startThread(
							env,
							space,
							{
								repo,
								task,
								...(ref ? { ref } : {}),
								...(profile ? { profile: { providerId: profile.provider, model: profile.model } } : {}),
								...(harness ? { harness } : {}),
								...(budget !== undefined ? { budgetUsd: budget } : {}),
								...(parent ? { parent } : {}),
								...(rebuildEnvironment !== undefined ? { rebuildEnvironment } : {}),
								operationId,
							},
							{ type: "agent", agent: agent.id, chat },
						);
						return json({
							thread_id: view.id,
							url: link(view.id),
							status: view.state,
							...(view.queue ? { position: view.queue.position, waiting_for: view.queue.reason } : {}),
							branch: view.repo.branch,
						});
					});
				},
			}),
			defineTool({
				name: "coding_status",
				description: "How a coding thread is doing: its state, its latest checkpoint, its prepared environment (dependencies installed by the repository's setup script, restored from a snapshot when one was kept) and what it has spent. Without a thread_id, lists the space's coding threads, newest first.",
				parameters: Type.Object({ thread_id: Type.Optional(ThreadId) }),
				replay: "safe",
				async execute({ thread_id }) {
					return answer(async () => {
						if (thread_id) return json(brief(await threadView(env, space, thread_id)));
						const threads = await listThreads(env, space);
						return json({
							threads: threads.slice(0, MAX_LISTED).map((thread) => ({
								thread_id: thread.id,
								status: thread.state,
								repo: thread.repo,
								branch: thread.branch,
								task: thread.task.length > 120 ? `${thread.task.slice(0, 120)}…` : thread.task,
								...(thread.queue ? { position: thread.queue.position } : {}),
							})),
							...(threads.length > MAX_LISTED ? { more: threads.length - MAX_LISTED } : {}),
						});
					});
				},
			}),
			defineTool({
				name: "coding_steer",
				description:
					"Tell a coding thread something: more to do, a correction, an answer to its question. During a turn it reads it after its current step, or with interrupt stops what it is doing and starts on it; between turns it starts a new turn.",
				parameters: Type.Object({ thread_id: ThreadId, text: Type.String({ minLength: 1 }), interrupt: Type.Optional(Type.Boolean()) }),
				replay: "safe",
				async execute({ thread_id, text: said, interrupt }, api, context) {
					const operationId = await api.memo("operation", crypto.randomUUID(), context);
					return answer(async () => {
						const { listed, stub } = await liveThread(env, space, thread_id, { budget: true });
						const status = await calling(() => stub.steer(said, { interrupt: interrupt === true, operationId }));
						return json({ thread_id: listed.threadId, status: status.state, turn_under_way: status.currentOperation !== null });
					});
				},
			}),
			defineTool({
				name: "coding_diff",
				description: `What a coding thread changed, as a git diff from where it started (or from \`since\`, a commit) to its latest checkpoint. At most ${MAX_DIFF_CHARS} characters; the thread's page has all of it.`,
				parameters: Type.Object({ thread_id: ThreadId, since: Type.Optional(Type.String({ description: "A commit to diff from: an earlier checkpoint's sha." })) }),
				replay: "safe",
				async execute({ thread_id, since }) {
					return answer(async () => {
						if (since !== undefined && !COMMIT.test(since)) throw new CodingError(400, "since must be a commit's sha", "invalid");
						const { threadId } = await ownedThread(env, space, thread_id);
						const diff = await calling(() => codingThread(env, threadId).diff(since));
						if (!diff.diff) return text(diff.head ? "No changes." : "Nothing committed yet: each turn's changes are committed when it ends.");
						const clipped = diff.diff.length > MAX_DIFF_CHARS;
						const more = clipped ? `\n[… ${diff.diff.length - MAX_DIFF_CHARS} more characters: see ${link(threadId)}]` : diff.truncated ? "\n[The diff was too large to keep whole.]" : "";
						return text(`From ${diff.since} to ${diff.head}:\n${clipped ? diff.diff.slice(0, MAX_DIFF_CHARS) : diff.diff}${more}`);
					});
				},
			}),
			defineTool({
				name: "coding_tests",
				description: `The latest test runs of a coding thread (up to ${MAX_TEST_RUNS}), newest first: the command, how it exited, the counts when the runner said them, and the end of its output.`,
				parameters: Type.Object({ thread_id: ThreadId }),
				replay: "safe",
				async execute({ thread_id }) {
					return answer(async () => {
						const { threadId } = await ownedThread(env, space, thread_id);
						const runs = (await codingThread(env, threadId).tests()).slice(-MAX_TEST_RUNS).reverse();
						if (runs.length === 0) return text("It hasn't run any tests.");
						return json(
							runs.map((run) => ({
								command: run.command,
								exit_code: run.exitCode,
								...(run.timedOut ? { timed_out: true } : {}),
								...(run.summary ? { passed: run.summary.passed, failed: run.summary.failed, skipped: run.summary.skipped } : {}),
								output: run.output.length > MAX_TEST_OUTPUT_CHARS ? `…${run.output.slice(-MAX_TEST_OUTPUT_CHARS)}` : run.output,
							})),
						);
					});
				},
			}),
			defineTool({
				name: "coding_abort",
				description: "Stop a coding thread: its turn and every command it runs, and what was waiting for it. It keeps its work, and can be steered again.",
				parameters: Type.Object({ thread_id: ThreadId }),
				replay: "safe",
				async execute({ thread_id }) {
					return answer(async () => {
						const { listed, stub } = await liveThread(env, space, thread_id);
						await calling(() => stub.abort());
						return json(brief(await threadView(env, space, listed.threadId, listed)));
					});
				},
			}),
			defineTool({
				name: "coding_archive",
				description: "End a coding thread for good: it stops and its workspace is deleted. Its transcript, diff and tests stay readable. Push its branch first if its work is wanted.",
				parameters: Type.Object({ thread_id: ThreadId }),
				replay: "safe",
				async execute({ thread_id }) {
					return answer(async () => {
						const { threadId } = await ownedThread(env, space, thread_id);
						const status = await calling(() => codingThread(env, threadId).archive());
						return json({ thread_id: threadId, status: status.state });
					});
				},
			}),
		],
		actions: [
			defineGatedAction({
				name: "coding_push",
				description:
					"Push a coding thread's work to GitHub: its latest checkpoint, to its own branch (pim/…) unless you name another, never main or the default branch. Then the person can open a pull request. Its workspace must be running: push soon after its turn ends.",
				parameters: Type.Object({ thread_id: ThreadId, branch: Type.Optional(Type.String({ description: "A branch starting with pim/; the thread's own by default." })) }),
				explicitApproval: true,
				summarize: ({ thread_id, branch }) => `Push ${branch ?? "the branch"} of coding thread ${thread_id} to GitHub`,
				async prepare(args) {
					try {
						const { threadId } = await ownedThread(env, space, args.thread_id);
						const prepared = await codingThread(env, threadId).preparePush(args.branch);
						if (!prepared.ok) return { refused: JSON.stringify({ error: prepared.code, message: prepared.message }) };
						const { branch, checkpoint, head, summary } = prepared.request;
						return { args: { thread_id: threadId, branch, checkpoint, head } as typeof args, summary };
					} catch (error) {
						if (error instanceof CodingError) return { refused: JSON.stringify({ error: error.code, message: error.message }) };
						throw error;
					}
				},
				async run(args) {
					const { thread_id, branch, checkpoint, head } = args as typeof args & { checkpoint?: string; head?: string };
					if (!branch || !checkpoint || !head) return "This push wasn't readied: ask to push again.";
					const { threadId } = await ownedThread(env, space, thread_id);
					const pushed = await codingThread(env, threadId).push({ branch, checkpoint, head });
					if (!pushed.ok) return `The push failed: ${pushed.message}`;
					const { repo, outcome, after } = pushed.result;
					return outcome === "unchanged"
						? `${branch} on github.com/${repo} was already at ${after.slice(0, 12)}.`
						: `Pushed ${branch} (${after.slice(0, 12)}) to github.com/${repo}: https://github.com/${repo}/compare/${encodeURIComponent(branch)}?expand=1`;
				},
			}),
		],
	}),
});
