import type { Context } from "@earendil-works/chord";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { type PimServices, text } from "./services";

/**
 * An action with effects outside the conversation. The model can only ask
 * for it: calling the tool files an approval request and waits a short time
 * for the user. The agent runs `run` once the user approves, or when the wait
 * runs out so autonomous work is never blocked, and the tool returns the
 * outcome within the same turn. A call interrupted by an eviction replays,
 * finds its request, and waits again.
 */
export type GatedAction<P extends TSchema = TSchema> = {
	readonly name: string;
	readonly description: string;
	readonly parameters: P;
	/** One line the user reads to decide. */
	summarize(args: Static<P>): string;
	/** Performs the action after approval; the text is reported to the model. */
	run(args: Static<P>): Promise<string>;
	/** Not a tool of its own: other tools file approvals for it (such as MCP tool calls). */
	readonly internal?: boolean;
};

export function defineGatedAction<P extends TSchema>(action: GatedAction<P>): GatedAction<P> {
	return action;
}

/** Appended to the description of every tool that only files an approval request. */
export const APPROVAL_NOTE =
	'Requires the user\'s approval: calling this waits up to 30 seconds for the user, who may approve or deny; with no answer it is approved automatically. The result of the action is the result of this call.';

/**
 * Files an approval request for the gated action `action` from inside a tool
 * call. Replay-safe: a replayed call finds the request it already filed.
 */
export async function fileApproval(
	services: PimServices,
	api: ToolExecutionApi,
	context: Context,
	request: { action: string; args: unknown; summary: string },
): Promise<ToolExecutionResult> {
	const id = await api.memo("approval", crypto.randomUUID(), context);
	const known = services.store.approval(id);
	const approval = services.store.requestApproval({
		id,
		session: String(api.conversationId),
		callId: api.callId,
		expiresAt: Date.now() + services.approvalTimeoutMs,
		...request,
	});
	if (!known) await services.approvalRequested(approval);
	return text(await services.awaitApproval(approval));
}

function gatedTool(action: GatedAction, services: PimServices) {
	return defineTool({
		name: action.name,
		description: `${action.description} ${APPROVAL_NOTE}`,
		parameters: action.parameters,
		replay: "safe",
		async execute(args, api, context) {
			return fileApproval(services, api, context, { action: action.name, args, summary: action.summarize(args) });
		},
	});
}

/** Tools for the actions the model calls directly; actions with `internal` set are filed by other tools. */
export function approvalsExtension(services: PimServices, actions: readonly GatedAction[]) {
	return defineExtension({
		name: "pim.approvals",
		tools: actions.filter((action) => !action.internal).map((action) => gatedTool(action, services)),
	});
}

const MAX_RESPONSE_CHARS = 8000;

/** Arbitrary HTTP request: webhooks, APIs, form posts. */
export const httpRequest = defineGatedAction({
	name: "http_request",
	description: "Send an HTTP request that may change something, such as calling an API or a webhook.",
	parameters: Type.Object({
		method: Type.Union([
			Type.Literal("GET"),
			Type.Literal("POST"),
			Type.Literal("PUT"),
			Type.Literal("PATCH"),
			Type.Literal("DELETE"),
		]),
		url: Type.String({ pattern: "^https?://" }),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		body: Type.Optional(Type.String()),
	}),
	summarize: ({ method, url, body }) =>
		`${method} ${url}${body ? ` with a ${body.length}-character body` : ""}`,
	async run({ method, url, headers, body }) {
		const response = await fetch(url, {
			method,
			...(headers ? { headers } : {}),
			...(body !== undefined && method !== "GET" ? { body } : {}),
			signal: AbortSignal.timeout(30_000),
		});
		const responseText = await response.text();
		const clipped =
			responseText.length > MAX_RESPONSE_CHARS
				? `${responseText.slice(0, MAX_RESPONSE_CHARS)}\n[... ${responseText.length - MAX_RESPONSE_CHARS} more characters]`
				: responseText;
		return `HTTP ${response.status} ${response.statusText}\n${clipped}`;
	},
});
