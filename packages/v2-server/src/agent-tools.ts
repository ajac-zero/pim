/**
 * The tools of a Pim agent on the portable stack, as one extension (`pim`) built for one partition's owner: the owner is fixed by the partition, so a tool can only
 * act for the person whose space it runs in. What a tool writes goes through the application's services (`@pim/v2-app`), whose Authorizer decides each call for the agent
 * principal (or, in a delegated task's chat, for the principal that started the chain). Coding goes through Forge. A tool whose service this Runner was not given answers
 * with what is missing instead of failing the turn.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type PromptSection, type ToolRegistration } from "@earendil-works/pi-durable";
import { QUOTA_MESSAGE } from "@pim/v2-app/quota";
import type { App } from "@pim/v2-app/app";
import { OwnerId, PartitionId, type Principal } from "@pim/v2-contracts/identity";
import { ExternalOperations } from "@pim/v2-runtime/external";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import type { Actor } from "@pim/v2-forge/authz";
import type { RelayBus } from "@pim/v2-app/relay";
import { computerTools } from "./computer-tools.ts";
import type { ForgeParts } from "./forge-assembly.ts";
import type { EnvelopeCrypto } from "@pim/v2-contracts/platform";
import { connectorToolset, type Transport } from "./connector-tools.ts";

export type ToolDeps = {
	ownerId: string;
	partitionId: string;
	runtime: RuntimeDb;
	app: App | undefined;
	forge: ForgeParts | undefined;
	/** The Relay's bus, made when first needed: how the computer, browser and desktop tools reach the owner's paired computer. */
	relay?: (() => Promise<RelayBus>) | undefined;
	fetch: typeof fetch;
	now: () => number;
	/** The deployment's keys, which open a connector's sealed credential; and whether a connector may live at a private address. */
	crypto?: EnvelopeCrypto | undefined;
	allowPrivateConnectors?: boolean | undefined;
	/** The public id of the chat that a pi conversation is. */
	chatOf(conversationId: number | string): Promise<string | null>;
};

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ content: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });
const json = (v: unknown): Result => text(JSON.stringify(v, null, 1));

const MAX_BODY = 100_000;
const MAX_REQUEST_MS = 20_000;

/** Whether an address is one an agent may not reach: loopback, private, link-local and the like. */
function privateAddress(address: string): boolean {
	if (isIP(address) === 6) {
		const a = address.toLowerCase();
		return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80") || (a.startsWith("::ffff:") && privateAddress(a.slice(7)));
	}
	const [a = 0, b = 0] = address.split(".").map(Number);
	return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function publicUrl(raw: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("That is not a web address");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https addresses can be fetched");
	if (url.username || url.password) throw new Error("An address with credentials in it is refused");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
	if (addresses.length === 0 || addresses.some(privateAddress)) throw new Error("That address is not on the public internet");
	return url;
}

async function readBody(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < MAX_BODY) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.length;
	}
	await reader.cancel().catch(() => {});
	return Buffer.concat(chunks).subarray(0, MAX_BODY).toString("utf8");
}

const REDACT = /^(authorization|cookie|x-api-key|proxy-authorization)$/i;
const redactHeaders = (headers: Record<string, string> | undefined) => Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k, REDACT.test(k) ? "[redacted]" : v]));

export function pimExtension(deps: ToolDeps, sections: PromptSection[]) {
	const { ownerId, partitionId, runtime } = deps;
	const owner = OwnerId.parse(ownerId);
	const ops = new ExternalOperations(runtime);
	const principals = new Map<string, Promise<Principal>>();
	const noApp = () => text("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot do that.", true);
	const noForge = () => text("Coding is not available here: this Runner has no coding database (PIM_FORGE_DATABASE_URL).", true);

	/** The agent that is answering in a chat, as the Authorizer knows it; in a delegated task's chat, the principal that started the chain. */
	const principalOf = (app: App, chat: string | null): Promise<Principal> => {
		const key = chat ?? "";
		let held = principals.get(key);
		if (!held) {
			held = (async (): Promise<Principal> => {
				if (!chat) return { kind: "agent", ownerId: owner, agentId: "pim" };
				const row = await app.db.owner(ownerId, async (tx) => ({
					task: (await tx.query("SELECT task_id FROM pim_app.tasks WHERE task_chat = $1", [chat])).rows[0]?.task_id as string | undefined,
					agent: (await tx.query("SELECT agent_id FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0]?.agent_id as string | null | undefined,
				}));
				return row.task ? app.conversations.taskPrincipal(ownerId, row.task) : { kind: "agent", ownerId: owner, agentId: row.agent ?? "pim" };
			})();
			principals.set(key, held);
			held.catch(() => principals.delete(key));
		}
		return held;
	};

	type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
	/** A tool that needs the application: it gets the services and the principal of the chat it runs in. */
	const withApp = (run: (app: App, call: Call, args: any) => Promise<Result>) =>
		async (args: any, api: any, context: any): Promise<Result> => {
			const app = deps.app;
			if (!app) return noApp();
			try {
				const chat = await deps.chatOf(api.conversationId);
				const p = await principalOf(app, chat);
				const agentId = p.kind === "agent" ? (p.agentId === "pim" ? null : p.agentId) : null;
				return await run(app, { chat, p, api, agentId, context }, args);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		};
	/** Every tool call counts against the owner's day (migration 0621); once the day's allowance is used the call is refused with the space's usual message. */
	const defaultToolCalls = /^\d+$/.test(process.env.PIM_LIMIT_DAILY_TOOL_CALLS?.trim() ?? "") ? Number(process.env.PIM_LIMIT_DAILY_TOOL_CALLS) : null;
	const counted = (execute: (args: any, api: any, context: any) => Promise<Result>) => async (args: any, api: any, context: any): Promise<Result> => {
		const allowed = await runtime.read<{ ok: boolean }>(ownerId, "SELECT pim_app.runner_count_tool_call($1, $2) AS ok", [ownerId, defaultToolCalls]).then((r) => r.rows[0]?.ok !== false, () => true);
		return allowed ? execute(args, api, context) : text(`${QUOTA_MESSAGE} too many tool calls today. It resets at midnight UTC.`, true);
	};
	const tool = (name: string, description: string, parameters: any, execute: (args: any, api: any, context: any) => Promise<Result>, replay: "safe" | "unsafe" = "unsafe") =>
		defineTool({ name, description, parameters, replay, execute: counted(execute) } as never) as ToolRegistration;
	const read = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => tool(name, description, parameters, withApp(run), "safe");
	const write = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => tool(name, description, parameters, withApp(run), "unsafe");

	const S = Type.String;
	const O = Type.Optional;
	const strings = Type.Array(Type.String());
	const anyObject = Type.Record(Type.String(), Type.Any());
	const files = Type.Record(Type.String(), Type.String());
	const scopeOf = (call: Call, scope?: string) => scope ?? (call.agentId ? `agent-${call.agentId}` : "everyone");

	const tools: ToolRegistration[] = [
		tool(
			"send_to_user",
			"Send the person a message. It is the only way they see anything you write: the rest of your text is private working notes. Set complete when you are finishing a delegated task.",
			Type.Object({ message: S({ minLength: 1 }), complete: O(Type.Boolean()), widgets: O(strings) }),
			async (args, api) => {
				const app = deps.app;
				const chat = await deps.chatOf(api.conversationId);
				if (app && chat) {
					try {
						await app.conversations.markResponse(ownerId, chat);
						if (args.complete) {
							const p = await principalOf(app, chat);
							if (p.kind === "delegated") await app.conversations.updateTask(p, p.delegateId, "completed", String(args.message).slice(0, 2000));
						}
					} catch (error) {
						return text(`Not sent: ${error instanceof Error ? error.message : String(error)}`, true);
					}
				}
				return text(args.widgets?.length ? `Sent. The widgets (${args.widgets.join(", ")}) are shown with it where this deployment has them.` : "Sent.");
			},
			"safe",
		),
		tool("current_time", "The current date and time, in UTC.", Type.Object({}), async () => text(new Date(deps.now()).toISOString()), "safe"),

		// Memory.
		write("note", "Save something to remember: a title and the text. It goes to your own memory unless you give a scope such as everyone.", Type.Object({ title: S({ minLength: 1 }), body: S({ minLength: 1 }), scope: O(S()) }), async (app, call, a) =>
			text(`Remembered as ${await app.memories.remember(call.p, scopeOf(call, a.scope), a.title, a.body)}.`)),
		read("recall", "Search your memory with a regular expression (case-insensitive) over titles and text.", Type.Object({ pattern: S({ minLength: 1 }), scope: O(S()), limit: O(Type.Integer({ minimum: 1, maximum: 50 })) }), async (app, call, a) => {
			const scopes = a.scope ? [a.scope] : [...new Set([scopeOf(call), "everyone"])];
			const found = await app.memories.recall(call.p, scopes, a.pattern, a.limit ?? 20);
			return text(found.length ? found.map((m) => `[${m.id}] (${m.scope}) ${m.title}`).join("\n") : "Nothing matches.");
		}),
		read("zoom", "Read a memory in full, or a block of its lines.", Type.Object({ id: S(), start: O(Type.Integer({ minimum: 1 })), count: O(Type.Integer({ minimum: 1, maximum: 400 })) }), async (app, call, a) => {
			const z = await app.memories.zoom(call.p, a.id, a.start ?? 1, a.count ?? 40);
			return text(`${z.lines.join("\n")}\n(${z.total} lines in all)`);
		}),
		write("forget", "Forget a memory.", Type.Object({ id: S() }), async (app, call, a) => (await app.memories.forget(call.p, a.id), text("Forgotten."))),
		write("move_memory", "Move a memory to another scope, such as everyone or another agent's.", Type.Object({ id: S(), scope: S() }), async (app, call, a) => (await app.memories.move(call.p, a.id, a.scope), text(`Moved to ${a.scope}.`))),

		// Skills and goals.
		read("read_skill", "Read a skill's instructions and the names of its files.", Type.Object({ name: S() }), async (app, call, a) => {
			const s = await app.agents.getSkill(call.p, a.name);
			return text(`${s.body}\n\nFiles: ${Object.keys(s.files ?? {}).join(", ") || "none"}`);
		}),
		read("read_skill_file", "Read one of a skill's supporting files.", Type.Object({ name: S(), path: S() }), async (app, call, a) => {
			const file = ((await app.agents.getSkill(call.p, a.name)).files ?? {})[a.path];
			return file === undefined ? text(`${a.name} has no file ${a.path}.`, true) : text(file);
		}),
		write("write_skill", "Create a skill, or save a new version of it: a name, what it is for, instructions, and supporting files by path.", Type.Object({ name: S(), description: O(S()), body: O(S()), files: O(files) }), async (app, call, a) => {
			const exists = await app.agents.getSkill(call.p, a.name).then(() => true, () => false);
			await (exists ? app.agents.updateSkill(call.p, a.name, { description: a.description, body: a.body, files: a.files }) : app.agents.createSkill(call.p, { name: a.name, description: a.description, body: a.body, files: a.files }));
			return text(exists ? `Saved a new version of ${a.name}.` : `Created ${a.name}.`);
		}),
		write("create_goal", "Start a goal, with the steps to reach it.", Type.Object({ title: S({ minLength: 1 }), steps: O(strings) }), async (app, call, a) => text(`Created goal ${await app.memories.createGoal(call.p, a.title, a.steps ?? [])}.`)),
		write("update_goal", "Change a goal: its title, its status (active, done, dropped) or its steps; or tick a step off with complete_step (its position, from 0).", Type.Object({ id: S(), title: O(S()), status: O(Type.Union([Type.Literal("active"), Type.Literal("done"), Type.Literal("dropped")])), steps: O(strings), complete_step: O(Type.Integer({ minimum: 0 })) }), async (app, call, a) => {
			if (a.title !== undefined || a.status !== undefined || a.steps !== undefined) await app.memories.updateGoal(call.p, a.id, { title: a.title, status: a.status, steps: a.steps });
			if (a.complete_step !== undefined) return text((await app.memories.completeStep(call.p, a.id, a.complete_step)).goalDone ? "Step done; the goal is done." : "Step done.");
			return text("Updated.");
		}),
		read("list_goals", "Your goals and their steps.", Type.Object({}), async (app, call) => json(await app.memories.listGoals(call.p))),

		// Schedules and triggers.
		write("schedule_task", "Run a prompt later: kind cron (spec is a 5-field cron expression, in UTC), at (spec is a date and time) or delay (spec is milliseconds). target is new_chat (default) or this chat.", Type.Object({ kind: Type.Union([Type.Literal("cron"), Type.Literal("at"), Type.Literal("delay")]), spec: S(), prompt: S({ minLength: 1 }), target: O(Type.Union([Type.Literal("new_chat"), Type.Literal("same_chat")])) }), async (app, call, a) =>
			text(`Scheduled ${await app.schedules.create(call.p, { kind: a.kind, spec: a.spec, prompt: a.prompt, target: a.target ?? "new_chat", ...(call.chat ? { chatId: call.chat } : {}), ...(call.agentId ? { agentId: call.agentId } : {}) })}.`)),
		read("list_scheduled_tasks", "Your scheduled tasks.", Type.Object({}), async (app, call) => json(await app.schedules.list(call.p))),
		write("cancel_scheduled_task", "Cancel a scheduled task.", Type.Object({ id: S() }), async (app, call, a) => (await app.schedules.remove(call.p, a.id), text("Cancelled."))),
		write("create_trigger", "Create a trigger: the spec says what starts a turn (a time, a connector's event, a computer's file or process) and what to do. It starts as a draft; resume_trigger enables it.", Type.Object({ spec: anyObject }), async (app, call, a) => {
			const t = await app.triggers.create(call.p, { spec: { ...(call.chat ? { originChatId: call.chat } : {}), ...(call.agentId ? { owningAgentId: call.agentId } : {}), ...a.spec } });
			return json({ id: t.id, lifecycle: t.lifecycle, label: t.label });
		}),
		write("update_trigger", "Replace a trigger's spec.", Type.Object({ id: S(), spec: anyObject }), async (app, call, a) => {
			const t = await app.triggers.update(call.p, a.id, { spec: { ...(call.chat ? { originChatId: call.chat } : {}), ...(call.agentId ? { owningAgentId: call.agentId } : {}), ...a.spec } });
			return json({ id: t.id, lifecycle: t.lifecycle, label: t.label });
		}),
		read("list_triggers", "Your triggers.", Type.Object({ lifecycle: O(S()) }), async (app, call, a) => json((await app.triggers.list(call.p, { lifecycle: a.lifecycle })).map((t) => ({ id: t.id, lifecycle: t.lifecycle, label: t.label })))),
		read("get_trigger", "One trigger with its spec and its latest runs.", Type.Object({ id: S() }), async (app, call, a) => json({ trigger: await app.triggers.get(call.p, a.id), runs: await app.triggers.runs(call.p, a.id, 10) })),
		write("pause_trigger", "Pause a trigger.", Type.Object({ id: S() }), async (app, call, a) => text(`Now ${(await app.triggers.setLifecycle(call.p, a.id, "paused")).lifecycle}.`)),
		write("resume_trigger", "Enable a trigger, or start one that is paused. A time trigger counts from now.", Type.Object({ id: S() }), async (app, call, a) => text(`Now ${(await app.triggers.setLifecycle(call.p, a.id, "enabled")).lifecycle}.`)),
		write("delete_trigger", "Delete a trigger.", Type.Object({ id: S() }), async (app, call, a) => (await app.triggers.setLifecycle(call.p, a.id, "deleted"), text("Deleted."))),
		read("test_trigger", "See what a time trigger would do next, without running it.", Type.Object({ id: S(), count: O(Type.Integer({ minimum: 1, maximum: 20 })) }), async (app, call, a) => json(await app.triggers.test(call.p, a.id, { count: a.count }))),

		// Notes and apps.
		write("note_create", "Create a note a person can open and edit alongside you.", Type.Object({ title: S({ minLength: 1 }), text: O(S()) }), async (app, call, a) => text(`Created note ${await app.canvas.create(call.p, a.title, a.text ?? "")}.`)),
		read("note_read", "Read a note: its text and its version.", Type.Object({ id: S() }), async (app, call, a) => {
			const n = await app.canvas.read(ownerId, a.id);
			return text(`version ${n.version}\n${n.text}`);
		}),
		write("note_edit", "Edit a note by replacing text. base_version is the version you read; if the note changed since, nothing is changed and you read it again. A person's typing is never lost.", Type.Object({ id: S(), base_version: Type.Integer({ minimum: 0 }), find: S({ minLength: 1 }), replace: S() }), async (app, call, a) =>
			text(`Edited; the note is at version ${(await app.canvas.edit(call.p, a.id, a.base_version, a.find, a.replace)).version}.`)),
		read("note_list", "Your notes.", Type.Object({}), async (app) => json((await app.db.owner(ownerId, (tx) => tx.query("SELECT note_id, title, version FROM pim_app.notes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200"))).rows)),
		write("app_create", "Create an app: kind html or jsx, or backend (with a pim.app.json). Files are by path.", Type.Object({ title: S({ minLength: 1 }), kind: Type.Union([Type.Literal("html"), Type.Literal("jsx"), Type.Literal("backend")]), files, message: O(S()) }), async (app, call, a) => json(await app.apps.create(call.p, { title: a.title, kind: a.kind, files: a.files, message: a.message }))),
		write("app_update", "Change an app. base_version is the version you read; an app that changed since is refused.", Type.Object({ id: S(), base_version: Type.Integer({ minimum: 1 }), title: O(S()), files: O(files), delete_files: O(strings), edits: O(Type.Array(Type.Object({ path: O(S()), find: S(), replace: S() }))), message: O(S()) }), async (app, call, a) =>
			json(await app.apps.update(call.p, a.id, { baseVersion: a.base_version, title: a.title, files: a.files, deleteFiles: a.delete_files, edits: a.edits, message: a.message }))),
		read("app_read", "Read an app: its files, or one file.", Type.Object({ id: S(), version: O(Type.Integer({ minimum: 1 })), path: O(S()), offset: O(Type.Integer({ minimum: 0 })) }), async (app, call, a) => json(await app.apps.read(call.p, a.id, { version: a.version, path: a.path, offset: a.offset }))),
		read("app_list", "Your apps.", Type.Object({ query: O(S()) }), async (app, call, a) => json(await app.apps.list(call.p, a.query ?? ""))),

		// The web.
		tool("fetch_url", "Read a web page or file with an HTTP GET. Public addresses only.", Type.Object({ url: S() }), async (args) => {
			try {
				const url = await publicUrl(args.url);
				const response = await deps.fetch(url, { signal: AbortSignal.timeout(MAX_REQUEST_MS), redirect: "manual", headers: { "user-agent": "Pim/2" } });
				if (response.status >= 300 && response.status < 400) return text(`Redirected (${response.status}) to ${response.headers.get("location") ?? "somewhere"}. Fetch that address instead if you want it.`);
				return text(`${response.status} ${response.headers.get("content-type") ?? ""}\n${await readBody(response)}`, !response.ok);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		}, "safe"),
		tool("http_request", "Make an HTTP request that may change something elsewhere (POST, PUT, PATCH, DELETE). A person approves it first, unless they have said it may go ahead. It is sent once: if its outcome cannot be known, it is not sent again.", Type.Object({ method: Type.Union(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map((m) => Type.Literal(m))), url: S(), headers: O(Type.Record(Type.String(), Type.String())), body: O(S()) }),
			async (args, api) => {
				const app = deps.app;
				if (!app) return noApp();
				const taskId = String(api.taskId);
				try {
					const url = await publicUrl(args.url);
					const chat = await deps.chatOf(api.conversationId);
					const p = await principalOf(app, chat);
					// The decision: a person's, delivered as a signal that wakes this task; or a standing approval, which stands in for it.
					const signal = (await runtime.read<{ payload: { approved?: boolean } }>(ownerId, "SELECT payload FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2 AND kind = 'approval' ORDER BY signal_id DESC LIMIT 1", [ownerId, taskId])).rows[0];
					if (signal && signal.payload.approved !== true) return text("A person did not approve this request, so it was not sent.", true);
					if (!signal) {
						const filed = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.approvals WHERE tool = 'http:request' AND args->>'taskId' = $1 LIMIT 1", [taskId])).rows[0]?.id as string | undefined);
						if (filed) return { content: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
						const gate = await app.approvals.gate(p, { action: "http:request", resource: { host: url.host, method: args.method }, ...(chat ? { chatId: chat } : {}), args: { taskId, callId: api.callId, method: args.method, url: url.href, headers: redactHeaders(args.headers), body: typeof args.body === "string" ? args.body.slice(0, 2000) : undefined }, timeoutMs: 24 * 3600_000, onTimeout: "deny" });
						if (gate.outcome === "waiting") return { content: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
					}
					// The request itself, once: its outcome is on the operation, so a replay or a new owner finds it there, and one that was in flight is reconciled, not sent again.
					const operationId = `http:${partitionId}:${taskId}`;
					const op = await ops.begin({ operationId, ownerId: owner, partitionId: PartitionId.parse(partitionId), taskId, toolName: "http_request", capability: "http", idempotencyKey: `pim-${ownerId}-${partitionId}-${taskId}` });
					if (op.state === "completed") return text(String((op.receipt as any)?.summary ?? "Done."));
					if (op.state === "failed" || op.state === "cancelled") return text(`The request did not go through: ${String((op.receipt as any)?.error ?? op.state)}`, true);
					if (op.state !== "pending") return text(`The request was started, but what became of it is not known (${op.state}). It was not sent again; check with the other service before asking again.`, true);
					await ops.transition(ownerId, operationId, "running");
					const idempotent = args.method === "GET" || args.method === "HEAD";
					try {
						const response = await deps.fetch(url, { method: args.method, headers: { ...(args.headers ?? {}), ...(idempotent ? {} : { "idempotency-key": op.idempotencyKey }) }, ...(args.body !== undefined && !idempotent ? { body: args.body } : {}), signal: AbortSignal.timeout(MAX_REQUEST_MS), redirect: "manual" });
						const body = await readBody(response);
						const summary = `${response.status} ${response.headers.get("content-type") ?? ""}\n${body}`;
						await ops.transition(ownerId, operationId, "completed", { status: response.status, summary });
						return text(summary, response.status >= 400);
					} catch (error) {
						// It may have reached the other side. A read is just asked again later; anything else waits for a person to check.
						await ops.transition(ownerId, operationId, idempotent ? "failed" : "needs_reconciliation", { error: error instanceof Error ? error.message : String(error) });
						return text(idempotent ? `The request failed: ${error instanceof Error ? error.message : String(error)}` : `The request may or may not have reached the other service (${error instanceof Error ? error.message : String(error)}). It was not sent again; check with that service before asking again.`, true);
					}
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error), true);
				}
			}, "safe"),

		// Delegation and agents.
		write("delegate", "Hand a task to another agent (or yourself) in a chat of its own. Its progress and answer come back to you as [Task update] messages. Pass agent_id to choose who does it.", Type.Object({ title: S({ minLength: 1 }), text: S({ minLength: 1 }), agent_id: O(S()) }), async (app, call, a) => {
			if (!call.chat) return text("There is no chat to delegate from.", true);
			const admission = await app.conversations.admit(call.p, { commandId: `delegate:${ownerId}:${call.api.taskId}:${call.api.callId}`, kind: "delegate", chatId: call.chat, payload: { title: a.title, text: a.text, ...(a.agent_id ? { agentId: a.agent_id } : {}) } });
			return json({ task: admission.result?.taskId, chat: admission.chatId });
		}),
		write("archive_task_chats", "Archive the chats of tasks that are finished, so they leave the list.", Type.Object({}), async (app, call) => text(`Archived ${await app.conversations.archiveTaskChats(call.p)} task chats.`)),
		write("create_agent", "Create an agent: a name, its instructions, and optionally its model, skills and the agents it may delegate to.", Type.Object({ name: S({ minLength: 1 }), instructions: O(S()), emoji: O(S()), color: O(S()), model: O(Type.Object({ provider: S(), id: S() })), skills: O(strings), contacts: O(strings), delegates: O(strings) }), async (app, call, a) => {
			const created = await app.agents.create(call.p, a);
			return text(`Created agent ${created.id} (${created.name}).`);
		}),
		write("update_agent", "Change an agent, yourself included: its name, instructions, emoji, color, model, skills or contacts.", Type.Object({ id: S(), name: O(S()), instructions: O(S()), emoji: O(S()), color: O(S()), model: O(Type.Object({ provider: S(), id: S() })), skills: O(strings), contacts: O(strings), delegates: O(strings) }), async (app, call, a) => {
			const { id, ...changes } = a;
			return text(`Updated agent ${(await app.agents.update(call.p, id, changes)).name}.`);
		}),
	];

	// Coding: Forge, with the Authorizer deciding first whether this agent may.
	const coding = (name: string, description: string, parameters: any, action: string, run: (forge: ForgeParts, actor: Actor, call: Call, args: any) => Promise<unknown>) =>
		tool(name, description, parameters, async (args, api, context) => {
			const app = deps.app;
			if (!app) return noApp();
			const forge = deps.forge;
			if (!forge) return noForge();
			try {
				const chat = await deps.chatOf(api.conversationId);
				const p = await principalOf(app, chat);
				// Whether the agent may at all: its owner's grant, and the repository and pool it covers. What a person must approve (push, pull request, merge) Forge files itself.
				const repo = typeof args.repo === "string" ? { repository: args.repo.replace(/^https?:\/\//, "").replace(/\.git$/, ""), ...(typeof args.pool === "string" ? { pool: args.pool } : {}) } : undefined;
				await app.identity.authz.authorize({ principal: p, ownerId: owner, action, ...(repo ? { resource: repo } : {}) });
				const role = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT role FROM pim_app.accounts WHERE owner_id = $1", [ownerId])).rows[0]?.role)) ?? "member";
				const actor: Actor = { ownerId: owner, role, ...(p.kind === "agent" && p.agentId !== "pim" ? { agent: p.agentId } : {}) };
				const result: any = await run(forge, actor, { chat, p, api, agentId: null, context }, args);
				if (result?.status === "approval_required") return text(`This needs a person's approval (${result.approvalId}). It is waiting in their approvals; ask again once they have said yes.`);
				return typeof result === "string" ? text(result) : json(result ?? { ok: true });
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		}, action === "coding:start" || action === "coding:push" || action === "coding:merge" || action === "coding:pr" || action === "coding:steer" || action === "coding:abort" ? "unsafe" : "safe");
	const thread = Type.String({ description: "The coding thread's id." });
	tools.push(
		coding("coding_start", "Start a coding thread on a repository: a task for a coding agent in its own workspace.", Type.Object({ task: S({ minLength: 1 }), repo: S({ minLength: 1 }), ref: O(S()), harness: O(S()), pool: O(S()), budget_usd: O(Type.Number({ minimum: 0 })) }), "coding:start", async (f, actor, c, a) =>
			f.forge.start(actor, { operationId: `coding:${ownerId}:${c.api.taskId}:${c.api.callId}`, task: a.task, repo: a.repo, ref: a.ref, harness: a.harness, pool: a.pool, ...(c.chat ? { chatId: c.chat } : {}), ...(a.budget_usd !== undefined ? { budgetUsd: a.budget_usd } : {}) })),
		coding("coding_status", "A coding thread's state.", Type.Object({ thread }), "coding:read", (f, actor, _c, a) => f.forge.status(actor, a.thread)),
		coding("coding_steer", "Send a coding thread an instruction.", Type.Object({ thread, text: S({ minLength: 1 }) }), "coding:steer", (f, actor, c, a) => f.forge.steer(actor, a.thread, a.text, `steer:${ownerId}:${c.api.taskId}:${c.api.callId}`)),
		coding("coding_diff", "The changes a coding thread has made.", Type.Object({ thread }), "coding:read", (f, actor, _c, a) => f.forge.diff(actor, a.thread)),
		coding("coding_tests", "Run a command in a coding thread's workspace (for example its tests), or read the last run.", Type.Object({ thread, command: O(strings) }), "coding:steer", (f, actor, _c, a) => (a.command ? f.forge.runTests(actor, a.thread, a.command) : f.forge.tests(actor, a.thread))),
		coding("coding_transcript", "A coding thread's transcript.", Type.Object({ thread, offset: O(Type.Integer({ minimum: 0 })), limit: O(Type.Integer({ minimum: 1, maximum: 100 })), role: O(S()), summary: O(Type.Boolean()), tail: O(Type.Boolean()) }), "coding:read", (f, actor, _c, a) => f.forge.transcriptPage(actor, a.thread, { offset: a.offset, limit: a.limit, role: a.role, summary: a.summary, tail: a.tail })),
		coding("coding_transcript_output", "The full output of one step of a coding thread's transcript.", Type.Object({ thread, id: O(S()), offset: O(Type.Integer({ minimum: 0 })), limit: O(Type.Integer({ minimum: 1 })) }), "coding:read", (f, actor, _c, a) => f.forge.transcriptOutput(actor, a.thread, { id: a.id, offset: a.offset, limit: a.limit })),
		coding("coding_abort", "Stop a coding thread's current turn.", Type.Object({ thread }), "coding:steer", (f, actor, _c, a) => f.forge.abort(actor, a.thread)),
		coding("coding_archive", "Archive a coding thread: its workspace is torn down, its transcript and diffs stay readable.", Type.Object({ thread }), "coding:steer", (f, actor, _c, a) => f.forge.archive(actor, a.thread)),
		coding("coding_push", "Push a coding thread's branch. A person approves it first, unless they have said it may go ahead.", Type.Object({ thread }), "coding:push", (f, actor, _c, a) => f.forge.push(actor, a.thread)),
		coding("coding_open_pull_request", "Open a pull request for a coding thread's branch. A person approves it first, unless they have said it may go ahead.", Type.Object({ thread, title: O(S()) }), "coding:pr", (f, actor, _c, a) => f.forge.openPullRequest(actor, a.thread, a.title)),
		coding("coding_merge", "Merge a coding thread's branch into the default branch, fast-forward or rebase, never forced. A person approves it first, unless they have said it may go ahead.", Type.Object({ thread }), "coding:merge", (f, actor, _c, a) => f.forge.merge(actor, a.thread)),
	);

	// The person's computer: files, shell, browser, desktop (`./computer-tools.ts`).
	tools.push(...computerTools({ ownerId, partitionId, runtime, app: deps.app, relay: deps.relay, chatOf: deps.chatOf }, { ops, principalOf }));

	// The owner's connected MCP servers: their tools, with each one's Off, Ask or On.
	const transport: Transport = { fetch: deps.fetch, allowPrivate: deps.allowPrivateConnectors === true, check: publicUrl };
	const connectors = connectorToolset({ ownerId, partitionId, runtime, app: deps.app, crypto: deps.crypto, transport, ops, owner, now: deps.now, chatOf: deps.chatOf, principalOf });
	tools.push(...connectors.tools);

	return defineExtension({ name: "pim", tools, sections: [...sections, ...connectors.sections] });
}
