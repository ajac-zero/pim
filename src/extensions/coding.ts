import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";
import { NO_CODING_SANDBOX_LINE } from "../compute";
import { deploymentSettings } from "../deployment";
import { type CodingThreadView, threadPath } from "../coding/api";
import { cliHarness } from "../coding/harness";
import { codingThread } from "../coding/thread-do";
import { CodingError, calling, listThreads, liveThread, ownedThread, startThread, threadView } from "../coding/threads";
import { OUTPUT_LINES, pageTranscript, TRANSCRIPT_MAX_PAGE, TRANSCRIPT_PAGE, transcriptOutput } from "../coding/transcript";
import type { TranscriptMessage } from "../transcript";
import { defineGatedAction, definePimExtension } from "./define";
import { json, text } from "./services";

/**
 * Coding threads for every agent: it can start one on a GitHub or Gitea repository,
 * follow it, steer it, read its diff, its tests and what it said, stop it, archive it, and
 * push its branch or merge it into the default branch without asking, and open a pull request once the person approves. A thread an agent starts is recorded as
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

/** A thread's transcript, typed by hand as the API route has it: the transcript's type is too deep for the RPC stub's. */
async function threadTranscript(env: Env, threadId: string): Promise<TranscriptMessage[]> {
	const stub = codingThread(env, threadId) as unknown as { transcript(): Promise<TranscriptMessage[]> };
	return await stub.transcript();
}

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
		provider: view.provider,
		resolved_profile: view.resolvedProfile,
		pool: view.pool,
		placement_reason: view.placementReason,
		task: view.task.length > 300 ? `${view.task.slice(0, 300)}…` : view.task,
		turn_under_way: view.currentOperation !== null,
		inputs_waiting: view.inbox,
		checkpoint: view.checkpoint ? { sha: view.checkpoint.sha, message: view.checkpoint.message } : null,
		// Every field that says something, so the model can tell where the time to readiness went and what the workspace has: durations in ms, times in ms since the epoch; toolchains and dependencies with how their install went, and the commands the repository checks itself with.
		environment: {
			...Object.fromEntries(Object.entries(view.environment).filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0))),
			...(view.environment.readyFrom ? { cache_hit: view.environment.readyFrom === "snapshot" } : {}),
		},
		// Null for a CLI that reports no cost (Codex, Amp): its spend is unmetered, not $0.
		spent_usd: cliHarness(view.harness)?.reportsCost === false ? null : Number(view.spentUsd.toFixed(4)),
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
	description: "Coding agents that work on GitHub and Gitea repositories in workspaces of their own.",
	ability: ({ space, conversationOf, compute }) => ({
		// The tools follow the configuration: with no coding sandbox provider they aren't offered, and the prompt says so in one line.
		offeredTo: () => compute.codingSandbox(),
		sections: [section("coding_unavailable", () => (compute.codingSandbox() ? undefined : NO_CODING_SANDBOX_LINE))],
		tools: [
			defineTool({
				name: "coding_start",
				description:
					"Start a coding thread: a coding agent that works on a Git repository (GitHub or Gitea) in a workspace of its own, on a new branch (pim/…), on the task you give it. Use it for changes to a codebase: fixing a bug, adding a feature, writing tests. Write the task as you would for a capable engineer who knows nothing of this conversation: what to change, why, and how to check it. It returns at once, often queued while a workspace is made ready; don't wait for it. You are told in this chat when each of its turns ends. Then read its work with coding_diff and coding_tests, say more with coding_steer, and push it with coding_push or ship it to the default branch with coding_merge, which need no approval: check its diff and tests first. After a push, coding_open_pull_request opens a pull request, also with no approval. If a thread fails with a transient error (workspace, manager, harness or provider), retry once by starting a fresh thread with the same task; if that fails too, stop and tell the person what happened.",
				parameters: Type.Object({
					repo: Type.String({ description: "The repository's address, such as https://github.com/<owner>/<name> or the same on the deployment's Gitea." }),
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
					budget: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "The most it may spend on its model, in US dollars. None by default: a thread runs until it finishes. Only Pi, Claude Code and Mistral Vibe report what they spend; for Codex and Amp the budget is ignored." })),
					parent: Type.Optional(Type.String({ description: "The thread this one continues from, if any." })),
					pool: Type.Optional(Type.String({ description: "Pin the thread to one sandbox pool by id, such as compose or cloudflare: it is placed only there and queues if that pool is full. An unknown or disabled pool is refused. Leave it out to take the first pool with room." })),
					provider: Type.Optional(Type.String({ description: "Pin the thread to one sandbox provider, such as compose or cloudflare. Same as pool." })),
					rebuildEnvironment: Type.Optional(Type.Boolean({ description: "When true, start with a freshly rebuilt environment, skipping any cached snapshot. Default false." })),
				}),
				replay: "safe",
				async execute({ repo, ref, task, profile, harness, budget, parent, pool, provider, rebuildEnvironment }, api, context) {
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
								...(pool ? { pool } : {}),
								...(provider ? { provider } : {}),
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
							provider: view.provider,
							pool: view.pool,
							placement_reason: view.placementReason,
						});
					});
				},
			}),
			defineTool({
				name: "coding_status",
				description: "How a coding thread is doing: its state, its latest checkpoint, its prepared environment (the toolchains and dependencies the repository pins and how each install went, the commands it checks itself with, what its setup script did, and whether it was restored from a cached snapshot) and what it has spent. Without a thread_id, lists the space's coding threads, newest first.",
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
								resolved_profile: thread.resolvedProfile ?? null,
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
				description: `What a coding thread changed, as a git diff from where it started (or from \`since\`, a commit) to its latest checkpoint. At most ${MAX_DIFF_CHARS} characters; the thread's page has all of it. A suspended workspace is resumed automatically for a diff not kept, which may take a minute and may report that the thread is queued.`,
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
				name: "coding_transcript",
				description: `What a coding thread said: the task it was given, what its agent answered, the commands it ran and what they printed, and its notices. Messages come oldest first, \`limit\` (${TRANSCRIPT_PAGE} by default, at most ${TRANSCRIPT_MAX_PAGE}) from \`offset\` (0 by default); the answer says how many there are in all and where the next page starts. \`role\` reads only one kind of message (user, assistant, tool or notice), and \`summary\` one line of each, to see the shape of the conversation first. Long messages are cut; coding_transcript_output reads one whole by its id.`,
				parameters: Type.Object({
					thread_id: ThreadId,
					offset: Type.Optional(Type.Integer({ minimum: 0, description: "The first message to show, counting from 0; the oldest by default." })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TRANSCRIPT_MAX_PAGE, description: `How many messages to show; ${TRANSCRIPT_PAGE} by default.` })),
					role: Type.Optional(
						Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"), Type.Literal("notice")], {
							description: "Only messages of this kind: user is what it was told, assistant what it said and the tools it called, tool what those printed, notice what Pim added.",
						}),
					),
					summary: Type.Optional(Type.Boolean({ description: "One line of each message, instead of the whole of each." })),
				}),
				replay: "safe",
				async execute({ thread_id, offset, limit, role, summary }) {
					return answer(async () => {
						const { threadId } = await ownedThread(env, space, thread_id);
						return json(pageTranscript(await threadTranscript(env, threadId), { offset, limit, role, summary }));
					});
				},
			}),
			defineTool({
				name: "coding_transcript_output",
				description: `One message of a coding thread's transcript whole, by the id coding_transcript gave it: the whole of what it said, of a command it ran or of what that printed, which the transcript had cut. Paged by lines like read: up to ${OUTPUT_LINES} lines and about 30 KB from offset (line 1 by default), and it says how to read on when there is more.`,
				parameters: Type.Object({
					thread_id: ThreadId,
					id: Type.String({ description: "The message's id, as coding_transcript gave it." }),
					offset: Type.Optional(Type.Integer({ minimum: 1, description: "The first line to read, counting from 1." })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: OUTPUT_LINES, description: `How many lines to read; ${OUTPUT_LINES} by default.` })),
				}),
				replay: "safe",
				async execute({ thread_id, id, offset, limit }) {
					return answer(async () => {
						const { threadId } = await ownedThread(env, space, thread_id);
						const output = transcriptOutput(await threadTranscript(env, threadId), id, { offset, limit });
						if (output === null) throw new CodingError(404, `No message ${id} in coding thread ${threadId}'s transcript`, "not_found");
						return text(output);
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
			defineTool({
				name: "coding_push",
				description:
					"Push a coding thread's work to its git host (GitHub or Gitea) right away, with no approval: its latest checkpoint, to its own branch (pim/…) unless you name another pim/ branch, never main or the default branch (to ship to it, use coding_merge). Then open a pull request with coding_open_pull_request. The result includes the thread's latest test runs. A suspended workspace is resumed automatically, which may take a minute and may report that the thread is queued for a sandbox slot (error workspace_queued): try again later.",
				parameters: Type.Object({ thread_id: ThreadId, branch: Type.Optional(Type.String({ description: "A branch starting with pim/; the thread's own by default." })) }),
				// Run again, it finds the branch already there.
				replay: "safe",
				async execute({ thread_id, branch: named }) {
					return answer(async () => {
						const { threadId } = await ownedThread(env, space, thread_id);
						const stub = codingThread(env, threadId);
						const prepared = await stub.preparePush(named);
						if (!prepared.ok) return json({ error: prepared.code, message: prepared.message });
						const { branch, checkpoint, head } = prepared.request;
						const pushed = await stub.push({ branch, checkpoint, head });
						if (!pushed.ok) return json({ error: "push_failed", message: pushed.message });
						return json({
							message: pushedMessage(await repoUrlOf(env, space, threadId), pushed.result, branch),
							tests: await latestTests(stub),
						});
					});
				},
			}),
			defineTool({
				name: "coding_merge",
				description:
					"Ship a coding thread's work: merge its latest checkpoint into the repository's default branch on the git host right away, with no approval, so look at coding_diff and coding_tests first. Pim fetches the default branch into the thread's workspace, fast-forwards or rebases the checkpoint onto it, and moves the default branch forward through the host's integration (never a force push; if it moves meanwhile, the rebase is retried once), and updates the thread's own pim/… branch to the same commit. If the thread's changes conflict with the default branch, the rebase is aborted and nothing is pushed: coding_steer the thread to rebase onto origin/<default branch> and resolve the conflicts, then merge again after its turn ends. A suspended workspace is resumed automatically, which may take a minute and may report that the thread is queued for a sandbox slot (error workspace_queued): try again later. Returns the default branch's new commit and the thread's latest test runs.",
				parameters: Type.Object({ thread_id: ThreadId }),
				// Run again, it finds the work already merged.
				replay: "safe",
				async execute({ thread_id }) {
					return answer(async () => {
						const { threadId } = await ownedThread(env, space, thread_id);
						const stub = codingThread(env, threadId);
						const prepared = await stub.prepareMerge();
						if (!prepared.ok) return json({ error: prepared.code, message: prepared.message });
						const merged = await stub.merge({ checkpoint: prepared.request.checkpoint });
						if (!merged.ok) return json({ error: "merge_failed", message: merged.message, tests: await latestTests(stub) });
						const { repo, branch, outcome, after, rebased, threadBranch } = merged.result;
						const host = hostOf(await repoUrlOf(env, space, threadId));
						const message =
							outcome === "unchanged"
								? `${branch} on ${host}/${repo} already has this work, at ${after.slice(0, 12)}.`
								: `Merged into ${branch} on ${host}/${repo}${rebased ? " after rebasing onto it" : " as a fast-forward"}: ${branch} is now at ${after}.${threadBranch ? ` ${threadBranch} was updated to it.` : " The thread's own branch was left as it was on the host."}`;
						return json({ message, sha: after, tests: await latestTests(stub) });
					});
				},
			}),
			defineTool({
				name: "coding_open_pull_request",
				description:
					"Open a pull request on the thread's git host (GitHub or Gitea) right away, with no approval, from its pushed pim/… branch into the branch it started from (the default branch when it started from a commit). Push the branch first with coding_push. The title defaults to the thread's task, and the body to the task with a note that Pim opened it. If a pull request from the branch is open already, that one is the answer. Returns the pull request's URL and number.",
				parameters: Type.Object({
					thread_id: ThreadId,
					title: Type.Optional(Type.String({ description: "The pull request's title; the thread's task by default." })),
					body: Type.Optional(Type.String({ description: "The pull request's description; the thread's task by default." })),
				}),
				// Run again, it finds the pull request already open.
				replay: "safe",
				async execute({ thread_id, title, body }) {
					return answer(async () => {
						const { threadId } = await ownedThread(env, space, thread_id);
						const stub = codingThread(env, threadId);
						const prepared = await stub.preparePullRequest({ title, body });
						if (!prepared.ok) return json({ error: prepared.code, message: prepared.message });
						const opened = await stub.openPullRequest(prepared.request);
						if (!opened.ok) return json({ error: "pull_request_failed", message: opened.message });
						const { url, number, base, head } = opened.result;
						return json({ message: `Pull request #${number} from ${head} into ${base}: ${url}`, url, number });
					});
				},
			}),
		],
		actions: [
			// The app's Push button asks the person (POST /coding/threads/:id/push files this action's approval); the agent's own tools above push at once.
			defineGatedAction({
				name: "coding_push_for_approval",
				description: "Push a coding thread's latest checkpoint to its own pim/… branch on its git host after the person approves. Prefer coding_push, which needs no approval.",
				parameters: Type.Object({ thread_id: ThreadId, branch: Type.Optional(Type.String({ description: "A branch starting with pim/; the thread's own by default." })) }),
				explicitApproval: true,
				summarize: ({ thread_id, branch }) => `Push ${branch ?? "the branch"} of coding thread ${thread_id} to its git host`,
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
					return pushedMessage(await repoUrlOf(env, space, threadId), pushed.result, branch);
				},
			}),
		],
	}),
});

/** A thread's repository, by its URL. */
async function repoUrlOf(env: Env, space: string, threadId: string): Promise<string> {
	return (await codingThread(env, (await ownedThread(env, space, threadId)).threadId).status()).repo.url;
}

const hostOf = (repoUrl: string) => new URL(repoUrl).host;

/** What a push told the model: where the branch is, and on github.com the page that compares it. */
function pushedMessage(repoUrl: string, { repo, outcome, after }: { repo: string; outcome: string; after: string }, branch: string): string {
	const where = `${hostOf(repoUrl)}/${repo}`;
	if (outcome === "unchanged") return `${branch} on ${where} was already at ${after.slice(0, 12)}.`;
	return `Pushed ${branch} (${after.slice(0, 12)}) to ${where}${hostOf(repoUrl) === "github.com" ? `: https://github.com/${repo}/compare/${encodeURIComponent(branch)}?expand=1` : "."} Open a pull request with coding_open_pull_request.`;
}

/** What a thread's latest test runs said, for a tool that ships its work: each run's command, exit and counts, without the output (coding_tests has it). */
async function latestTests(thread: ReturnType<typeof codingThread>) {
	const runs = (await thread.tests()).slice(-3).reverse();
	if (runs.length === 0) return "It hasn't run any tests.";
	return runs.map((run) => ({
		command: run.command,
		exit_code: run.exitCode,
		...(run.timedOut ? { timed_out: true } : {}),
		...(run.summary ? { passed: run.summary.passed, failed: run.summary.failed, skipped: run.summary.skipped } : {}),
	}));
}
