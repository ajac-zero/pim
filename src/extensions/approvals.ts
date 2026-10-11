import type { Context } from "@earendil-works/chord";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { PimStore, ToolPermission } from "../store";
import { type PimServices, text } from "./services";

/** A tool's permission as it applies now. */
export type ResolvedPermission = {
	readonly permission: ToolPermission;
	/** What applies when the user has not chosen. */
	readonly default: ToolPermission;
	/** What the user chose, if anything. */
	readonly chosen: ToolPermission | null;
	/** The app changed the tool since the user chose `on`, so Pim asks again until they choose anew. */
	readonly changed: boolean;
};

/**
 * The user's choice for a tool, or `fallback` without one. A choice is tied
 * to the tool's `definition` when it was made: an app that changes a tool
 * the user let run without asking (its description, inputs, or claims about
 * itself) gets it asked about again, so a tool can't turn into something
 * else under a permission given to what it was.
 */
export function resolvePermission(
	store: PimStore,
	app: string,
	tool: string,
	fallback: ToolPermission,
	definition: string | null,
): ResolvedPermission {
	const choice = store.toolPermission(app, tool);
	if (!choice) return { permission: fallback, default: fallback, chosen: null, changed: false };
	const changed = choice.permission === "on" && choice.definition !== definition;
	return { permission: changed ? "ask" : choice.permission, default: fallback, chosen: choice.permission, changed };
}

/** The permission of one of Pim's own tools that ask first: they ask unless the user chose otherwise. */
export function ownToolPermission(store: PimStore, name: string): ResolvedPermission {
	return resolvePermission(store, "", name, "ask", null);
}

/**
 * An action with effects outside the conversation. The model can only ask
 * for it: calling the tool files an approval request and waits for the user.
 * The agent runs `run` once the user approves. When nobody answers, the
 * approval policy decides: `auto` approves it so autonomous work is never
 * blocked, `explicit` denies it. Either way the tool returns the outcome
 * within the same turn. Calls to a tool the user chose to always approve are
 * approved at once. A call interrupted by an eviction replays, finds its
 * request, and waits again.
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

/** How long an approval waits, as the model and the user read it. */
export function describeWait(ms: number): string {
	if (ms < 120_000) return `${ms / 1000} seconds`;
	return `${Math.round(ms / 60_000)} minutes`;
}

/** Appended to the description of every tool that only files an approval request. */
export function approvalNote(services: PimServices): string {
	const wait = describeWait(services.approvalTimeoutMs);
	const timeout =
		services.approvalPolicy === "explicit"
			? "with no answer it is denied and the action does not happen"
			: "with no answer it is approved automatically";
	return `Requires the user's approval: calling this waits up to ${wait} for the user, who may approve or deny; ${timeout}. The result of the action is the result of this call.`;
}

/**
 * Files an approval request for the gated action `action` from inside a tool
 * call. Replay-safe: a replayed call finds the request it already filed.
 */
export async function fileApproval(
	services: PimServices,
	api: ToolExecutionApi,
	context: Context,
	request: { action: string; tool: string; args: unknown; summary: string },
): Promise<ToolExecutionResult> {
	const id = await api.memo("approval", crypto.randomUUID(), context);
	const known = services.store.approval(id);
	const { approvalTimeoutMs, approvalPolicy } = services;
	const now = Date.now();
	const approval = services.store.requestApproval({
		id,
		session: String(api.conversationId),
		callId: api.callId,
		createdAt: now,
		expiresAt: now + approvalTimeoutMs,
		onTimeout: approvalPolicy === "explicit" ? "deny" : "approve",
		...request,
	});
	// A tool the user lets run without asking is approved without asking.
	if (!known && services.permission(approval) !== "on") await services.approvalRequested(approval);
	return text(await services.awaitApproval(approval));
}

function gatedTool(action: GatedAction, services: PimServices, permission: ToolPermission) {
	return defineTool({
		name: action.name,
		description: permission === "ask" ? `${action.description} ${approvalNote(services)}` : action.description,
		parameters: action.parameters,
		replay: "safe",
		async execute(args, api, context) {
			return fileApproval(services, api, context, { action: action.name, tool: action.name, args, summary: action.summarize(args) });
		},
	});
}

/**
 * Tools for the actions the model calls directly; actions with `internal`
 * set are filed by other tools. Actions the user turned off are left out.
 */
export function approvalsExtension(services: PimServices, actions: readonly GatedAction[]) {
	return defineExtension({
		name: "pim.approvals",
		tools: actions.flatMap((action) => {
			if (action.internal) return [];
			const { permission } = ownToolPermission(services.store, action.name);
			return permission === "off" ? [] : [gatedTool(action, services, permission)];
		}),
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
