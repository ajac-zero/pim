import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { type PimServices, text } from "./services";

/**
 * An action with effects outside the conversation. The model can only ask
 * for it: calling the tool files an approval request and returns at once.
 * The agent runs `run` when the user approves, and reports the outcome to
 * the conversation as a new message, so nothing waits in memory for a
 * human and the flow survives evictions and restarts.
 */
export type GatedAction<P extends TSchema = TSchema> = {
	readonly name: string;
	readonly description: string;
	readonly parameters: P;
	/** One line the user reads to decide. */
	summarize(args: Static<P>): string;
	/** Performs the action after approval; the text is reported to the model. */
	run(args: Static<P>): Promise<string>;
};

export function defineGatedAction<P extends TSchema>(action: GatedAction<P>): GatedAction<P> {
	return action;
}

function gatedTool(action: GatedAction, services: PimServices) {
	return defineTool({
		name: action.name,
		description: `${action.description} Requires the user's approval: calling this files a request and returns immediately; the outcome arrives later in a message starting with "[Approval".`,
		parameters: action.parameters,
		replay: "safe",
		async execute(args, api, context) {
			const id = await api.memo("approval", crypto.randomUUID(), context);
			const known = services.store.approval(id);
			const approval = services.store.requestApproval({
				id,
				session: String(api.conversationId),
				action: action.name,
				args,
				summary: action.summarize(args),
			});
			if (!known) await services.approvalRequested(approval);
			return text(
				`Approval requested (id ${approval.id}): ${approval.summary}\nThe user has been asked. Do not call this again for the same action; tell the user what you are waiting for.`,
			);
		},
	});
}

export function approvalsExtension(services: PimServices, actions: readonly GatedAction[]) {
	return defineExtension({
		name: "pim.approvals",
		tools: actions.map((action) => gatedTool(action, services)),
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
