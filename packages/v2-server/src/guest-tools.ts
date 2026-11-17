/**
 * What a guest's agent can do in someone else's space: the tools of the host's connectors that the host granted the guest's audience (a bot's link, or a circle),
 * and nothing else. `guest_tools` lists them; `guest_call` calls one, re-reading the boundary first (`Guests.boundary`: the bot still shared, the circle enabled
 * and the member still in it), counting the call against the guest's day, and, for a tool the host wants to approve each time, filing an approval on the host and
 * parking until the host decides (the Gate carries the decision back to this task, in the guest's own chat). The host's credential is opened here with the
 * deployment's keys and used for this one call; it never reaches the guest's agent, and the guest's agent never sees a connector the host did not grant.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import type { Boundary, GuestConnector } from "@pim/v2-app/guests";
import { openString, sealString } from "@pim/v2-app/crypto";
import { PartitionId } from "@pim/v2-contracts/identity";
import type { EnvelopeCrypto } from "@pim/v2-contracts/platform";
import type { ExternalOperations } from "@pim/v2-runtime/external";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { listTools, McpAuthError, type McpTool, parseCredential, refresh, resultText, type Transport, withSession } from "./connector-tools.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ content: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

export type GuestToolsDeps = {
	ownerId: string;
	partitionId: string;
	runtime: RuntimeDb;
	app: App | undefined;
	crypto: EnvelopeCrypto | undefined;
	transport: Transport;
	ops: ExternalOperations;
	owner: unknown;
	now: () => number;
	chatOf(conversationId: number | string): Promise<string | null>;
};

const redact = (value: unknown) => JSON.parse(JSON.stringify(value ?? {}), (k, v) => (/token|secret|password|authorization|api[_-]?key/i.test(k) ? "[redacted]" : v));
const LISTED_FOR_MS = 30_000;

export function guestToolset(deps: GuestToolsDeps): ToolRegistration[] {
	const { ownerId, runtime } = deps;
	const listed = new Map<string, { at: number; tools: Promise<McpTool[]> }>();
	const noApp = () => text("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot reach anyone's space.", true);

	async function bearerOf(b: Boundary, c: GuestConnector, force = false): Promise<string | null> {
		if (!c.credential) return null;
		if (!deps.crypto) throw new Error("This Runner has no keys (PIM_KEK_<id> and PIM_KEK_CURRENT), so it cannot open a connector's credential.");
		const context = `connector:${b.host}/${c.id}`;
		const { bearer, bundle } = parseCredential(await openString(deps.crypto, c.credential, context));
		if (bundle && (force || (bundle.expires_at !== undefined && bundle.expires_at <= deps.now() + 30_000))) {
			const renewed = await refresh(bundle, deps.transport.fetch, deps.now()).catch(() => null);
			if (renewed) {
				await runtime.read(b.host, "SELECT pim_app.runner_set_connector_credential($1, $2, $3)", [b.host, c.id, await sealString(deps.crypto, JSON.stringify(renewed), context)]);
				return renewed.access_token;
			}
		}
		return bearer;
	}
	async function withBearer<T>(b: Boundary, c: GuestConnector, run: (bearer: string | null) => Promise<T>): Promise<T> {
		try {
			return await run(await bearerOf(b, c));
		} catch (error) {
			if (!(error instanceof McpAuthError)) throw error;
			return run(await bearerOf(b, c, true));
		}
	}
	const toolsOf = (b: Boundary, c: GuestConnector): Promise<McpTool[]> => {
		const key = `${b.host}\u0000${c.id}\u0000${c.url}`;
		const held = listed.get(key);
		if (held && deps.now() - held.at < LISTED_FOR_MS) return held.tools;
		const tools = withBearer(b, c, (bearer) => listTools(deps.transport, c.url, bearer));
		listed.set(key, { at: deps.now(), tools });
		tools.catch(() => listed.delete(key));
		return tools;
	};
	const refused = async (app: App, b: Boundary | null, tool: string, message: string): Promise<Result> => {
		if (b) await app.guests.log(b, tool, "refused", message).catch(() => undefined);
		return text(message, true);
	};

	const list = defineTool({
		name: "guest_tools",
		description: "The tools of the host's connected services that the host lets you use, with what each takes. A tool marked asksFirst waits for the host's approval when you call it. Call one with guest_call.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args: unknown, api: any) {
			const app = deps.app;
			if (!app) return noApp();
			try {
				const b = await app.guests.boundary(ownerId, await deps.chatOf(api.conversationId));
				const { connectors, permissions } = await app.guests.hostConnectors(b);
				const out: unknown[] = [];
				for (const c of connectors) {
					for (const t of await toolsOf(b, c).catch(() => [] as McpTool[])) {
						const permission = app.guests.permissionOf(b, c, { name: t.name, destructive: t.annotations?.destructiveHint === true }, permissions);
						if (permission !== "off") out.push({ connector: c.id, service: c.name, tool: t.name, description: t.description ?? null, inputSchema: t.inputSchema, asksFirst: permission === "ask" });
					}
				}
				return text(out.length ? JSON.stringify({ host: b.hostName, tools: out }, null, 1) : `${b.hostName} hasn't shared any tools with you.`);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	} as never) as unknown as ToolRegistration;

	const call = defineTool({
		name: "guest_call",
		description: "Call a tool the host shares with you (see guest_tools). Arguments are the tool's own. A tool the host wants to approve first waits for their answer, and a call with effects is sent once.",
		parameters: Type.Object({ connector: Type.String({ minLength: 1 }), tool: Type.String({ minLength: 1 }), arguments: Type.Optional(Type.Record(Type.String(), Type.Any())) }),
		// Safe to replay: a parked call finds its approval again (the id is a digest of the call), and a call with effects is made once through its operation.
		replay: "safe",
		async execute(args: { connector: string; tool: string; arguments?: Record<string, unknown> }, api: any) {
			const app = deps.app;
			if (!app) return noApp();
			let b: Boundary | null = null;
			try {
				const chat = await deps.chatOf(api.conversationId);
				b = await app.guests.boundary(ownerId, chat);
				const { connectors, permissions } = await app.guests.hostConnectors(b);
				const c = connectors.find((x) => x.id === args.connector);
				const tool = c ? (await toolsOf(b, c)).find((t) => t.name === args.tool) : undefined;
				// A tool the host did not grant is answered as one that does not exist: nothing says what else the host has connected.
				if (!c || !tool) return await refused(app, b, args.tool, `${b.hostName} doesn't share a tool ${args.tool} with you.`);
				const readOnly = tool.annotations?.readOnlyHint === true;
				const permission = app.guests.permissionOf(b, c, { name: tool.name, destructive: tool.annotations?.destructiveHint === true }, permissions);
				if (permission === "off") return await refused(app, b, tool.name, `${b.hostName} doesn't share a tool ${args.tool} with you.`);
				const taskId = String(api.taskId);
				if (permission === "ask") {
					const signal = (await runtime.read<{ payload: { approved?: boolean } }>(ownerId, "SELECT payload FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2 AND kind = 'approval' ORDER BY signal_id DESC LIMIT 1", [ownerId, taskId])).rows[0];
					if (signal && signal.payload.approved !== true) return await refused(app, b, tool.name, `${b.hostName} didn't approve that call, so it was not made.`);
					if (!signal) {
						if (!(await app.guests.countCall(b))) return await refused(app, b, tool.name, `You have used the calls ${b.hostName} allows a day. They reset at midnight UTC.`);
						const filed = await app.guests.file(b, { chat: chat ?? "", taskId, callId: String(api.callId), connector: c.id, service: c.name, tool: tool.name, arguments: redact(args.arguments), resource: { connector: c.id, tool: tool.name } });
						if (filed.state === "timed_out_denied") return await refused(app, b, tool.name, `${b.hostName} didn't answer within a day, so the call was not made.`);
						await app.guests.log(b, tool.name, "asked", `Asked ${b.hostName} to approve ${tool.name} of ${c.name}`);
						return { content: [{ type: "text", text: `Waiting for ${b.hostName} to approve.` }], control: { suspend: true } } as never;
					}
				} else if (!(await app.guests.countCall(b))) {
					return await refused(app, b, tool.name, `You have used the calls ${b.hostName} allows a day. They reset at midnight UTC.`);
				}
				const run = () => withBearer(b!, c, (bearer) => withSession(deps.transport, c.url, bearer, (rpc) => rpc("tools/call", { name: tool.name, arguments: args.arguments ?? {} }), 30_000));
				if (readOnly) {
					const result = await run();
					await app.guests.log(b, tool.name, "ran", `Used ${tool.name} of ${c.name}`);
					return text(resultText(result), result?.isError === true);
				}
				const operationId = `guest:${deps.partitionId}:${taskId}`;
				const op = await deps.ops.begin({ operationId, ownerId: deps.owner, partitionId: PartitionId.parse(deps.partitionId), taskId, toolName: "guest_call", capability: `guest:${b.host}:${c.id}`, idempotencyKey: `pim-guest-${ownerId}-${deps.partitionId}-${taskId}` } as never);
				if (op.state === "completed") return text(String((op.receipt as any)?.summary ?? "Done."));
				if (op.state === "failed" || op.state === "cancelled") return text(`The call did not go through: ${String((op.receipt as any)?.error ?? op.state)}`, true);
				if (op.state !== "pending") return text(`The call was started, but what became of it is not known (${op.state}). It was not made again.`, true);
				await deps.ops.transition(ownerId, operationId, "running");
				try {
					const result = await run();
					const summary = resultText(result);
					await deps.ops.transition(ownerId, operationId, result?.isError === true ? "failed" : "completed", result?.isError === true ? { error: summary } : { summary });
					await app.guests.log(b, tool.name, "ran", `Used ${tool.name} of ${c.name}`);
					return text(summary, result?.isError === true);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await deps.ops.transition(ownerId, operationId, "needs_reconciliation", { error: message });
					return text(`The call may or may not have reached ${c.name} (${message}). It was not made again.`, true);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (b) await app.guests.log(b, args.tool, "refused", message).catch(() => undefined);
				return text(message, true);
			}
		},
	} as never) as unknown as ToolRegistration;

	return [list, call];
}
