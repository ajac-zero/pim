import type { Context } from "@earendil-works/chord";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { OWNER, type PimStore, type ToolPermission } from "../store";
import { type PimServices, text } from "./services";

/** A tool's permission as it applies now. */
export type ResolvedPermission = {
	readonly permission: ToolPermission;
	/** What applies when the user has not chosen. */
	readonly default: ToolPermission;
	/** What the user chose, if anything. */
	readonly chosen: ToolPermission | null;
	/**
	 * The app changed the tool since the user chose to let it run: the owner's
	 * Pim asks again, and a circle's guests lose it, until they choose anew.
	 */
	readonly changed: boolean;
};

/**
 * The user's choice for a tool, for the owner (`OWNER`) or a circle, or
 * `fallback` without one. A choice is tied to the tool's `definition` when it
 * was made: an app that changes a tool the user let run (its description,
 * inputs, or claims about itself) gets it asked about again in the owner's
 * Pim, and taken from guests, so a tool can't turn into something else under
 * a permission given to what it was.
 */
export function resolvePermission(
	store: PimStore,
	audience: string,
	app: string,
	tool: string,
	fallback: ToolPermission,
	definition: string | null,
): ResolvedPermission {
	const choice = store.toolPermission(audience, app, tool);
	if (!choice) return { permission: fallback, default: fallback, chosen: null, changed: false };
	const owner = audience === OWNER;
	const changed = (owner ? choice.permission === "on" : choice.permission !== "off") && choice.definition !== definition;
	const permission = changed ? (owner ? "ask" : "off") : choice.permission;
	return { permission, default: fallback, chosen: choice.permission, changed };
}

/** The permission of one of Pim's own tools that ask first: they ask unless the user chose otherwise. */
export function ownToolPermission(store: PimStore, name: string): ResolvedPermission {
	return resolvePermission(store, OWNER, "", name, "ask", null);
}

/**
 * An action with effects outside the conversation. The model can only ask
 * for it: calling the tool files an approval request and returns at once.
 * The Pim runs `run` once the user approves, and the decision, with the
 * result, comes back to the conversation as a message, so a request can wait
 * as long as the user takes. Under the `auto` policy an unanswered request is
 * approved after a while, so autonomous work never stalls. Calls to a tool the
 * user lets run without asking are approved at once, within the turn. A call
 * interrupted by an eviction replays and finds its request.
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
	/** Every call needs the person's decision: no timeout or always-approve permission. */
	readonly explicitApproval?: boolean;
};

export function defineGatedAction<P extends TSchema>(action: GatedAction<P>): GatedAction<P> {
	return action;
}

/** How long an approval waits, as the model and the user read it. */
export function describeWait(ms: number): string {
	if (ms < 120_000) return `${ms / 1000} seconds`;
	return `${Math.round(ms / 60_000)} minutes`;
}

/** Appended to the description of every tool that only files an approval request. */
export function approvalNote(services: PimServices, explicit = false): string {
	const timeout = explicit ? null : services.approvalTimeoutMs;
	const unanswered =
		timeout === null ? "the request waits for their answer, however long" : `with no answer in ${describeWait(timeout)} it is approved automatically`;
	return `Requires the user's approval: calling this asks them and returns at once; ${unanswered}. Their decision, with the action's result, arrives later in this conversation as a message starting with "[Approval". Don't call it again meanwhile.`;
}

/**
 * Files an approval request for the gated action `action` from inside a tool
 * call, and says what became of it: run at once when the user lets the tool
 * run without asking, else asked. Replay-safe: a replayed call finds the
 * request it already filed.
 */
export async function fileApproval(
	services: PimServices,
	api: ToolExecutionApi,
	context: Context,
	request: { action: string; tool: string | null; args: unknown; summary: string },
	explicit = false,
): Promise<ToolExecutionResult> {
	const id = await api.memo("approval", crypto.randomUUID(), context);
	const known = services.store.approval(id);
	const timeout = explicit ? null : services.approvalTimeoutMs;
	const now = Date.now();
	const session = String(api.conversationId);
	const approval = services.store.requestApproval({
		id,
		session,
		member: services.teamMember(session),
		callId: api.callId,
		createdAt: now,
		expiresAt: timeout === null ? null : now + timeout,
		onTimeout: timeout === null ? "deny" : "approve",
		...request,
	});
	return text(await services.approvalFiled(approval, known === undefined));
}

function gatedTool(action: GatedAction, services: PimServices, permission: ToolPermission) {
	return defineTool({
		name: action.name,
		description: permission === "ask" || action.explicitApproval ? `${action.description} ${approvalNote(services, action.explicitApproval)}` : action.description,
		parameters: action.parameters,
		replay: "safe",
		async execute(args, api, context) {
			return fileApproval(services, api, context, { action: action.name, tool: action.explicitApproval ? null : action.name, args, summary: action.summarize(args) }, action.explicitApproval);
		},
	});
}

/**
 * Tools for the actions the model calls directly; actions with `internal`
 * set are filed by other tools. Actions the user turned off are left out.
 */
export function gatedTools(services: PimServices, actions: readonly GatedAction[]) {
	return actions.flatMap((action) => {
		if (action.internal) return [];
		const { permission } = ownToolPermission(services.store, action.name);
		return permission === "off" ? [] : [gatedTool(action, services, permission)];
	});
}

/** Pim's own actions' tools. Extensions' actions are tools of their abilities, in the chats that use them. */
export function approvalsExtension(services: PimServices, actions: readonly GatedAction[]) {
	return defineExtension({ name: "pim.approvals", tools: gatedTools(services, actions) });
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
