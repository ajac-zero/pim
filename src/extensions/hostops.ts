import { env } from "cloudflare:workers";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";
import { enqueueHostOp, HOST_SERVICES, type HostOpName, type HostOpView, hostOpsStatus, readHostOp, waitForHostOp } from "../hostops";
import { HttpError } from "../http";
import { definePimExtension } from "./define";
import { json, text } from "./services";

/**
 * Host operations for the admin's majordomo: tools that ask the daemon on
 * this Pim's host (`hostopsd`, see ../hostops.ts) for one of its fixed
 * operations and wait for the result, and a prompt section saying what they
 * do. They aren't actions that ask first, so they run overnight too: the
 * allowlist of operations and their arguments, the audit log, and the daemon
 * rolling back a deploy that fails are what keep them safe.
 *
 * Only the majordomo of the admin's space is offered them. That only keeps
 * them out of other agents' prompts: the HostOps Durable Object checks every
 * caller, and refuses and audits any other.
 */

/** How long a call waits for its operation to finish before it answers with the operation as it is. */
export const HOSTOPS_WAIT_MS = 100_000;

const FINISHED: readonly string[] = ["succeeded", "failed", "rolled_back", "expired"];

/** What the model reads of an operation. Times are ISO 8601, in UTC. */
function brief(op: HostOpView) {
	const at = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
	return {
		id: op.id,
		op: op.op,
		args: op.args,
		state: op.state,
		summary: op.summary,
		data: op.data,
		created_at: at(op.createdAt),
		started_at: at(op.startedAt),
		finished_at: at(op.finishedAt),
	};
}

/** An operation as a tool's answer: what came of it, or, while it still runs, its id to follow it with. */
function result(op: HostOpView) {
	if (FINISHED.includes(op.state)) return json(brief(op));
	return json({ ...brief(op), note: `Still ${op.state}. Follow it with hostops_op and id ${op.id}.` });
}

/** A refusal or a bad argument, as a tool error the model can act on. */
async function answer(work: () => Promise<ReturnType<typeof text>>) {
	try {
		return await work();
	} catch (error) {
		if (error instanceof HttpError) return text(JSON.stringify({ error: error.message, status: error.status }), true);
		throw error;
	}
}

const Service = Type.Union(
	HOST_SERVICES.map((service) => Type.Literal(service)),
	{ description: "The service on the host." },
);

const PROMPT = `You run this Pim's host for the person, who is its admin, through its host daemon. Each of these asks the daemon for one fixed operation and waits for what came of it:
- hostops_stats: the host's load, memory, disk and services.
- hostops_logs: a service's latest log lines.
- hostops_restart: restart a service.
- hostops_set_slot_limit: how many sandboxes the sandbox manager runs at once.
- hostops_deploy: deploy a git ref (origin/main unless given). The daemon checks the new version and rolls back on its own when it fails, which comes back as rolled_back. A deploy can take up to 15 minutes: when the call answers before it ends, follow it with hostops_op.
- hostops_rollback: go back to an earlier commit.
- hostops_status: whether the daemon is connected, its version, and what waits in its queue.
- hostops_op: an operation by its id, once it finishes.
The services are ${HOST_SERVICES.join(", ")}. One deploy or rollback runs at a time. Nothing else runs on the host: there is no shell. These run without asking, so run only what the person asked for, or what a schedule they set says to; every call is in the audit log they read in Settings → Deployment. If the daemon hasn't been seen, operations wait and expire after 10 minutes: tell them to install it from there. Report each result briefly: what ran, how it ended, and anything they need to do.`;

/**
 * The extension, waiting `waitMs` for an operation before answering with it
 * as it is. The tests wait less.
 */
export function hostOpsExtension({ waitMs = HOSTOPS_WAIT_MS }: { waitMs?: number } = {}) {
	return definePimExtension({
		id: "hostops",
		name: "Host operations",
		description: "The admin's majordomo deploys, rolls back, restarts and reads the logs of this Pim's host, through its host daemon.",
		ability: (context) => {
			const { space, conversationOf } = context;
			const caller = (conversationId: unknown) => {
				const { chat, agent } = conversationOf(String(conversationId));
				return { kind: "agent", accountId: space, agentId: agent.id, chatId: chat } as const;
			};
			/** A tool for one operation, which waits for it and answers with what came of it. */
			const operation = <T extends TSchema>(name: HostOpName, description: string, parameters: T) =>
				defineTool({
					name: `hostops_${name}`,
					description,
					parameters,
					async execute(args, api) {
						return answer(async () => {
							const queued = await enqueueHostOp(env, caller(api.conversationId), name, args);
							return result((await waitForHostOp(env, queued.id, waitMs)) ?? queued);
						});
					},
				});
			return {
				offeredTo: (agent) => context.admin && agent.majordomo,
				sections: [
					section("host_operations", ({ conversationId }) =>
						context.admin && conversationOf(String(conversationId)).agent.majordomo ? PROMPT : undefined,
					),
				],
				tools: [
					operation("stats", "The host's load, memory, disk and services, from its host daemon.", Type.Object({})),
					operation(
						"deploy",
						"Deploy a git ref of this Pim on its host. The daemon checks the new version and rolls back on its own when it fails (state rolled_back). Answers once it ends, or with its id while it still runs: then follow it with hostops_op.",
						Type.Object({ ref: Type.Optional(Type.String({ description: "The git ref to deploy, such as origin/main (the default), a branch or a tag." })) }),
					),
					operation(
						"rollback",
						"Go back to an earlier commit of this Pim on its host. Answers once it ends, or with its id while it still runs: then follow it with hostops_op.",
						Type.Object({ commit: Type.String({ description: "The commit to go back to: 7 to 40 hex digits." }) }),
					),
					operation("restart", "Restart a service on the host.", Type.Object({ service: Service })),
					operation(
						"logs",
						"A service's latest log lines.",
						Type.Object({ service: Service, lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "How many lines, 100 unless given." })) }),
					),
					operation(
						"set_slot_limit",
						"How many sandboxes the sandbox manager runs at once.",
						Type.Object({ maxConcurrent: Type.Integer({ minimum: 1, maximum: 16 }) }),
					),
					defineTool({
						name: "hostops_status",
						description: "Whether the host daemon has a credential, when it was last seen, its version and commit, and how many operations are queued and running.",
						parameters: Type.Object({}),
						async execute(_args, api) {
							return answer(async () => {
								const { credential, agent, queue } = await hostOpsStatus(env, caller(api.conversationId));
								const at = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
								return json({
									credential: credential.present ? "issued" : credential.revoked ? "revoked" : "none",
									last_seen_at: at(agent.lastSeenAt),
									version: agent.version,
									commit: agent.commit,
									queue,
								});
							});
						},
					}),
					defineTool({
						name: "hostops_op",
						description: "A host operation by its id, as a host operation tool gave it: waits for it to end, then answers with what came of it; while it still runs, call it again.",
						parameters: Type.Object({ id: Type.String({ description: "The operation's id." }) }),
						async execute({ id }, api) {
							return answer(async () => {
								const op = await readHostOp(env, caller(api.conversationId), id, waitMs);
								return op ? result(op) : text(`No host operation ${id}.`, true);
							});
						},
					}),
				],
			};
		},
	});
}

export const hostOps = hostOpsExtension();
