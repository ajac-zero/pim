/**
 * The admin's majordomo's tools for the machine the stack runs on, ported from v1 (`src/extensions/hostops.ts`): `hostops_stats`, `_logs`, `_restart`, `_set_slot_limit`, `_deploy`,
 * `_rollback` and `_exec` ask the host daemon through the queue in `./service.ts`; `hostops_status`, `_audit` and `_op` only read it. The tools are offered to the admin's partitions
 * only, and every call is checked again by the service: a chat whose agent is not the majordomo is refused and the refusal is kept in the audit log.
 *
 * Everything that reaches the host asks a person first, with the exact operation and its arguments in front of them, and one approval runs one operation (the service checks the
 * application's own record of the decision, not what a tool says). The request is queued once however often the call is replayed. Nothing here runs a command: the daemon does,
 * on the host, outside every role of the stack, as an unprivileged user with no stack credentials.
 */
import { Type } from "typebox";
import { defineExtension, defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import { newId } from "@pim/v2-app/ids";
import { hostServices } from "./routes.ts";
import { checkHostOp, EXEC_MAX_COMMAND, EXEC_MAX_OUTPUT, EXEC_MAX_TIMEOUT, HOST_OPS, HOST_SERVICES, type HostOpName, type HostOpView, type HostOpsCaller } from "./service.ts";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });
const clip = (s: string, n = 60_000) => (s.length > n ? `${s.slice(0, n)}\n[… cut; ${s.length - n} more characters]` : s);
/** A call waits this long for its operation to end; a deploy can take longer, and then the answer is the operation's id, which `hostops_op` follows. */
const WAIT_MS = 100_000;

export type HostOpsToolDeps = { ownerId: string; partitionId: string; app: App | undefined; chatOf(conversationId: number | string): Promise<string | null> };

const service = Type.Union(HOST_SERVICES.map((s) => Type.Literal(s)), { description: `One of ${HOST_SERVICES.join(", ")}.` });

/** What a person reads to decide. */
function summarize(op: HostOpName, a: Record<string, string | number>): string {
	switch (op) {
		case "stats": return "Read this machine's stats (load, memory, disk, containers)";
		case "logs": return `Read the last ${a.lines} lines of ${a.service}'s logs on this machine`;
		case "restart": return `Restart ${a.service} on this machine`;
		case "set_slot_limit": return `Let the sandbox manager run at most ${a.maxConcurrent} sandboxes at once`;
		case "deploy": return `Deploy ${a.ref} on this machine: build its image and recreate the stack's containers, running its migrations`;
		case "rollback": return `Roll this machine back to commit ${a.commit}: rebuild its image and recreate the stack's containers (migrations are not undone)`;
		case "update": return `Update this Pim to the newest image on ${a.tag ? `the ${a.tag} tag` : "its channel"}: pull it, back up the database, recreate the stack's containers (running its migrations), and go back to the current image if it does not come up healthy`;
		case "exec": return `Run a command on this machine's host, outside the stack: ${String(a.command).slice(0, 300)}`;
	}
}

export function hostopsTools(deps: HostOpsToolDeps): ToolRegistration[] {
	const { ownerId, partitionId } = deps;
	const waiting = { output: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
	const tool = (name: string, description: string, parameters: any, execute: (args: any, api: any) => Promise<Result>) =>
		defineTool({ name, description, parameters, replay: "safe", execute: async (args: any, api: any) => {
			try {
				return await execute(args, api);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		} } as never) as ToolRegistration;

	const caller = async (api: any): Promise<{ who: HostOpsCaller; chat: string | null }> => {
		const app = deps.app;
		if (!app) throw new Error("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot reach the host.");
		const chat = await deps.chatOf(api.conversationId);
		// The agent answering in the chat; a chat that names none is answered by the majordomo (`pim`). A delegated task's chat is no agent's own: it asks as a token and is refused.
		const row = chat ? await app.db.owner(ownerId, async (tx) => ({ task: (await tx.query("SELECT task_id FROM pim_app.tasks WHERE task_chat = $1", [chat])).rows[0]?.task_id as string | undefined, agent: (await tx.query("SELECT agent_id FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0]?.agent_id as string | null | undefined })) : null;
		return { chat, who: row?.task ? { kind: "token", ownerId } : { kind: "agent", ownerId, agentId: row?.agent ?? "pim", chatId: chat } };
	};

	/** The operation, once a person has approved exactly it, queued once and waited for. */
	const ask = async (api: any, op: HostOpName, args: Record<string, unknown>): Promise<Result> => {
		const app = deps.app!;
		const { hostops } = hostServices(app);
		const { who, chat } = await caller(api);
		// The majordomo's, or a refusal that is kept, before anybody is asked for anything.
		await hostops.assertCaller(who, "request", { op, args });
		// The admin's switch in Tool permissions: off, the operation is not asked for at all (every one is asked about one at a time otherwise).
		if (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT 1 FROM pim_app.tool_permissions WHERE audience = 'owner' AND app = '' AND tool = $1 AND permission = 'off'", [`hostops_${op}`])).rowCount)) return text(`hostops_${op} is switched off in Settings → Tool permissions, so it was not asked for.`, true);
		const checked = checkHostOp(op, args, { approval: false });
		const taskId = String(api.taskId);
		const callId = String(api.callId);
		// The application's record of the approval decides, not a signal: a person's decision wakes this task, and the call then finds its approval here.
		const filed = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id, state FROM pim_app.approvals WHERE tool = $1 AND args->>'taskId' = $2 AND args->>'callId' = $3 ORDER BY created_at DESC LIMIT 1", [`hostops_${op}`, taskId, callId])).rows[0] as { id: string; state: string } | undefined);
		if (!filed) {
			// Always filed, never covered by a standing approval: an operation on the host is approved one at a time.
			await app.db.owner(ownerId, (tx) =>
				tx.query("INSERT INTO pim_app.approvals (id, owner_id, public_chat_id, tool, args, timeout_policy, expires_at) VALUES ($1,$2,$3,$4,$5,'deny', now() + interval '24 hours')", [newId("ap"), ownerId, chat, `hostops_${op}`, JSON.stringify({ taskId, callId, op, args: checked.args, summary: summarize(op, checked.args), resource: {} })]),
			);
			return waiting;
		}
		if (filed.state === "waiting") return waiting;
		if (filed.state !== "approved") return text("A person did not approve this, so it was not done.", true);
		const op_ = await hostops.enqueue(who, op, { ...checked.args, approval: filed.id }, `${partitionId}:${taskId}:${callId}`);
		return describe(await hostops.waitFor(op_.id, WAIT_MS) ?? op_);
	};

	const op = (name: HostOpName, description: string, parameters: any, args: (a: any) => Record<string, unknown> = () => ({})) => tool(`hostops_${name}`, description, parameters, (a, api) => ask(api, name, args(a)));

	return [
		op("stats", "The machine's stats as the daemon reports them: load, memory, disk, the stack's containers. A person approves the request first.", Type.Object({})),
		op("logs", "A service's latest log lines (1 to 500, 100 by default). A person approves the request first. Secrets are taken out.", Type.Object({ service, lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }), (a) => ({ service: a.service, ...(a.lines !== undefined ? { lines: a.lines } : {}) })),
		op("restart", "Restart one of the stack's services. A person approves it first.", Type.Object({ service }), (a) => ({ service: a.service })),
		op("set_slot_limit", "How many sandboxes the sandbox manager runs at once (1 to 16). A person approves it first.", Type.Object({ maxConcurrent: Type.Integer({ minimum: 1, maximum: 16 }) }), (a) => ({ maxConcurrent: a.maxConcurrent })),
		op("deploy", "Deploy a git ref (origin/main by default): the daemon checks the new version and goes back on its own when it fails to come up healthy, which reports rolled_back. A person approves it first. It can take longer than this call waits: then it answers with the operation's id, which hostops_op follows.", Type.Object({ ref: Type.Optional(Type.String({ maxLength: 100 })) }), (a) => ({ ...(a.ref !== undefined ? { ref: a.ref } : {}) })),
		op("update", "Update this Pim to the newest published image on its channel (or on the image tag given): the host pulls it, backs up, restarts the stack and goes back to the previous image on its own when it fails to come up healthy, which reports rolled_back. Settings → Deployment says whether one is available. A person approves it first. It can take longer than this call waits: then it answers with the operation's id, which hostops_op follows.", Type.Object({ tag: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" })) }), (a) => ({ ...(a.tag !== undefined ? { tag: a.tag } : {}) })),
		op("rollback", "Go back to a commit (7 to 40 hex digits). Database migrations are not undone. A person approves it first.", Type.Object({ commit: Type.String({ pattern: "^[0-9a-fA-F]{7,40}$" }) }), (a) => ({ commit: a.commit })),
		op("exec", `Run one shell command on the machine's host, outside the stack, as an unprivileged user with none of the stack's credentials, for what the fixed operations do not cover (df -h /, journalctl -u docker -n 50). A person approves every call and reads the exact command first; there is no always-approve. At most ${EXEC_MAX_COMMAND} characters, timeoutSeconds 1 to ${EXEC_MAX_TIMEOUT} (60 by default), output cut to its last maxOutputBytes (at most ${EXEC_MAX_OUTPUT}).`, Type.Object({ command: Type.String({ minLength: 1, maxLength: EXEC_MAX_COMMAND }), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: EXEC_MAX_TIMEOUT })), maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: EXEC_MAX_OUTPUT })) }), (a) => ({ command: a.command, ...(a.timeoutSeconds !== undefined ? { timeoutSeconds: a.timeoutSeconds } : {}), ...(a.maxOutputBytes !== undefined ? { maxOutputBytes: a.maxOutputBytes } : {}) })),
		tool("hostops_status", "Whether the host daemon has a credential, when it last asked for work, its version and commit, and its queue.", Type.Object({}), async (_a, api) => text(JSON.stringify(await hostServices(deps.app!).hostops.statusFor((await caller(api)).who), null, 1))),
		tool("hostops_audit", "The audit log of host operations, newest first, read-only: when, what, a short summary of the arguments, which agent and chat asked, the approval, how it ended. Never secrets or a command's output beyond its last lines.", Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), since: Type.Optional(Type.String({ description: "An ISO time." })), op: Type.Optional(Type.String()) }), async (a, api) => {
			const since = a.since ? Date.parse(a.since) : undefined;
			if (since !== undefined && Number.isNaN(since)) return text("since must be an ISO time", true);
			const rows = await hostServices(deps.app!).hostops.auditFor((await caller(api)).who, a.limit ?? 50, { ...(since !== undefined ? { since } : {}), ...(a.op ? { op: a.op } : {}) });
			return text(clip(JSON.stringify(rows.map((r) => ({ ...r, ts: new Date(r.ts).toISOString() })), null, 1)));
		}),
		tool("hostops_op", `An operation by its id, once it ends (waits up to ${WAIT_MS / 1000} seconds).`, Type.Object({ id: Type.String() }), async (a, api) => {
			const found = await hostServices(deps.app!).hostops.readFor((await caller(api)).who, a.id, WAIT_MS);
			return found ? describe(found) : text(`There is no operation ${a.id}.`, true);
		}),
	];
}

/** An operation as the model reads it: how it ended, and what the daemon sent. */
function describe(op: HostOpView): Result {
	const head = `Operation ${op.id} (${op.op}): ${op.state}${op.summary ? ` - ${op.summary}` : ""}`;
	if (op.state === "queued" || op.state === "running") return text(`${head}. It has not finished; follow it with hostops_op.`);
	const data = op.data ?? {};
	const body = typeof data.output === "string" ? data.output : typeof data.text === "string" ? data.text : op.op === "stats" ? JSON.stringify(data, null, 1) : "";
	return text(clip(body ? `${head}\n${body}` : head), op.state !== "succeeded");
}

export const HOSTOPS_TOOL_NAMES = HOST_OPS.map((o) => `hostops_${o}`);

/** The tools as an extension, for the admin's partitions only; null for anyone else, or where this Runner has no application database. */
export async function hostopsExtension(deps: HostOpsToolDeps) {
	if (!deps.app) return null;
	const role = await deps.app.db.owner(deps.ownerId, async (tx) => (await tx.query("SELECT role FROM pim_app.accounts WHERE owner_id = $1", [deps.ownerId])).rows[0]?.role).catch(() => null);
	if (role !== "admin") return null;
	return defineExtension({
		name: "pim-hostops",
		tools: hostopsTools(deps),
		sections: [section("host_operations", async () => "As the admin's majordomo you can look after the machine this Pim runs on with the hostops_* tools: stats, logs, restarting a service, updating to the newest release, deploying a checkout and rolling back, and one shell command. Each asks the admin for approval, showing the exact operation, and only the admin's majordomo may use them; every request is kept in an audit log (hostops_audit).")],
	});
}
