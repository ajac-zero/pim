/**
 * What clients of the HTTP API that are not the web app call, in the shapes v1's reference documents (`docs/reference.md`): the space's root
 * and health, sending a message as `{ content, operationId }` and asking how it went, and reading a chat's messages. The web app's own
 * shapes (`{ commandId, text }`, the snapshots) still answer on the same paths; these accept both.
 */
import { randomUUID } from "node:crypto";
import type { TranscriptMessage } from "@pim/shared/transcript";
import type { App } from "@pim/v2-app/app";
import { BadRequestError, ConflictError } from "@pim/v2-app/errors";
import { ok, type Reply, type Route, route } from "@pim/v2-app/http";
import { transcriptPage } from "@pim/v2-live/projections/snapshots";
import { messageParts } from "../message-images.ts";
import { plainReply, textOf as partsText, widgetMarkdown, widgetsOf } from "../shared-chat.ts";

/** Message text from what a client sends: a string, or content blocks of which the text ones are joined. */
function textOf(body: Record<string, unknown>): string {
	const content = body.content ?? body.text;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "")).filter(Boolean).join("\n");
	return "";
}

/** What a sent message came to, as a client that waits for it reads it: `done` with what the agent sent the person, or `failed` and why. */
export type Outcome = { status: "done" | "failed" | "aborted"; replies: string[]; text?: string; reason?: string };

/**
 * What the turn that began with a message accepted at `since` (ms) came to, from the chat's projected transcript, or null while it goes on: the turn ended when nothing
 * is still streaming and the newest message is an agent's answer that called no tool. `replies` are only its successful sends to this chat, in order, with the widgets that
 * went with each as Markdown; private notes are never a fallback, and what went to the person's inbox is not a reply here.
 */
export function outcomeOf(messages: readonly TranscriptMessage[], since: number): Outcome | null {
	const begun = messages.findIndex((m) => m.role === "user" && m.timestamp >= since);
	if (begun < 0) return null;
	const turn = messages.slice(begun);
	// What the chat told of a model that was asked again or replaced is neither the agent's word nor the end of the turn.
	const last = turn.findLast((m) => m.notices === undefined || m.role !== "notice")!;
	// A reply not marked `complete: false` ends the turn: the agent asks the model nothing more, so the newest message is that call's result, not an answer.
	const closing = new Set<string>();
	for (const m of turn) for (const part of m.role === "assistant" ? m.parts : []) if (part.type === "tool-call" && part.name === "send_to_user" && (part.arguments as { complete?: unknown } | undefined)?.complete !== false) closing.add(part.id);
	const closed = last.role !== "assistant" && last.parts.some((part) => part.type === "tool-result" && closing.has(part.id));
	if (turn.some((m) => (m as { partial?: boolean }).partial)) return null;
	if (!closed && (last.role !== "assistant" || last.stopReason === undefined || last.stopReason === "toolUse")) return null;
	const results = new Map<string, { text: string; error: boolean }>();
	for (const m of turn) for (const part of m.parts) if (part.type === "tool-result") results.set(part.id, { text: partsText(part.content), error: part.error });
	const replies: string[] = [];
	for (const m of turn) {
		if (m.role !== "assistant") continue;
		for (const part of m.parts) {
			if (part.type !== "tool-call" || part.name !== "send_to_user") continue;
			const sent = results.get(part.id);
			const { message, channel } = (part.arguments ?? {}) as { message?: unknown; channel?: unknown };
			if (!sent || sent.error || typeof message !== "string" || channel === "email") continue;
			replies.push([plainReply(message), ...widgetsOf(sent.text).map((w) => widgetMarkdown(w as never))].join("\n\n"));
		}
	}
	const status = closed ? "done" : last.stopReason === "error" ? "failed" : last.stopReason === "aborted" ? "aborted" : "done";
	return { status, replies, ...(replies.length > 0 ? { text: replies.join("\n\n") } : {}), ...(status === "failed" ? { reason: last.error ?? "The run ended with an error." } : {}) };
}

/** Whether the agent is at work in the chat: its run, or a message of the person's it has not taken yet. */
async function chatBusy(app: App, ownerId: string, chat: string): Promise<boolean> {
	return app.db.owner(ownerId, async (tx) => (await tx.query(
		`SELECT coalesce((SELECT busy FROM pim_projection.sidebar_session_projection WHERE chat_id = $1::text), false)
		        OR EXISTS (SELECT 1 FROM pim_app.accepted_commands WHERE public_chat_id = $1::uuid AND kind = 'user_message' AND state = 'inbox_accepted') AS busy`, [chat])).rows[0]!.busy as boolean);
}

/** When the command was accepted, or null for one this chat never took. */
async function acceptedAt(app: App, ownerId: string, chat: string, command: string): Promise<number | null> {
	const row = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT accepted_at FROM pim_app.accepted_commands WHERE command_id = $1 AND public_chat_id = $2", [command, chat])).rows[0]);
	return row ? new Date(row.accepted_at).getTime() : null;
}

/** Waits up to `timeoutMs` for the message's turn to end; null when it has not. Polls the projection, which the Runner feeds as it goes. */
async function awaitOutcome(app: App, ownerId: string, chat: string, command: string, timeoutMs: number): Promise<Outcome | null> {
	const since = (await acceptedAt(app, ownerId, chat, command)) ?? Date.now();
	const until = Date.now() + timeoutMs;
	for (;;) {
		const found = outcomeOf((await transcriptPage(app.db.pool, ownerId, chat, { limit: 200 })).messages as TranscriptMessage[], since - 1000);
		if (found || Date.now() >= until) return found;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/** The tools an agent can have, by name and description, as `GET /api` lists them. The Runner builds each chat's own from these, so the list is what it can offer, not what one chat has. */
let catalog: Promise<{ name: string; description: string }[]> | undefined;
const listTools = () => (catalog ??= import("../agent-tools.ts").then(({ pimExtension }) => (pimExtension({ ownerId: "o_".padEnd(28, "0"), partitionId: "", runtime: {} } as never, []).tools as unknown as { name: string; description: string }[]).map(({ name, description }) => ({ name, description }))).catch(() => (catalog = undefined, [])));
/** What asks the person first, whatever a person's tool permissions say for connectors: adding a skill from outside Pim, a connector's tool that asks, an admin change. */
const NEEDS_APPROVAL = new Set(["install_skill", "connector_call", "admin_write_approved"]);

/** How long a message sent with `wait` is held for its turn to end before it answers `pending`. */
const waitMs = () => Number(process.env.PIM_API_WAIT_MS) || 110_000;

export function apiClientRoutes(): Route[] {
	return [
		route("GET", "/api/health", async () => ok({ name: "pim", ok: true })),
		// The root: what a client learns first: the model new chats run on, and the tools an agent can have, marking those that ask the person first.
		route("GET", "/api", async ({ app, principal }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const settings = await app.db.owner(p.ownerId, async (tx) => Object.fromEntries((await tx.query("SELECT key, value FROM pim_app.owner_settings WHERE key IN ('settings.timeZone', 'majordomo_chat', 'model')")).rows.map((r) => [r.key, r.value])));
			const model = (settings.model as { id?: string } | undefined)?.id ?? process.env.PIM_DEFAULT_MODEL?.split("/").slice(1).join("/") ?? null;
			return ok({ model, timeZone: settings["settings.timeZone"] ?? process.env.PIM_TIME_ZONE ?? "UTC", rootSession: settings.majordomo_chat ?? null, tools: (await listTools()).map((t) => ({ ...t, requiresApproval: NEEDS_APPROVAL.has(t.name) })) });
		}),
		route("POST", "/api/sessions/:id/messages", async ({ app, principal, json, params }): Promise<Reply> => {
			// A message with pictures is bigger than the usual 1 MB of JSON; each picture is fitted to what a model takes before it is kept.
			const b = await json(8_000_000);
			const text = textOf(b);
			const content = await messageParts(b.content);
			if (!text.trim() && !content && b.payload === undefined) throw new BadRequestError("A message needs content");
			const commandId = String(b.commandId ?? b.operationId ?? `cmd_${randomUUID()}`);
			const p = await principal();
			// What a message does when the agent is at work: it waits for the run to end (`followUp`, the default), joins it after the agent's current step (`steer`), or is refused (`reject`).
			const whenBusy = b.whenBusy;
			if (whenBusy !== undefined && whenBusy !== "followUp" && whenBusy !== "steer" && whenBusy !== "reject") throw new BadRequestError("whenBusy must be followUp, steer or reject");
			if (whenBusy === "reject" && (await chatBusy(app, p.ownerId, params[0]!))) throw new ConflictError("The agent is at work in this chat", "busy");
			const admission = await app.conversations.admit(p, { commandId, kind: "user_message", chatId: params[0]!, payload: b.payload ?? { text, ...(content ? { content } : {}), ...(whenBusy ? { whenBusy } : {}) } });
			// `wait` holds the answer until the turn has ended: its replies, or why it failed; a turn that outlasts the wait answers `pending`, and the operation can be followed.
			if (b.wait === true) {
				const outcome = await awaitOutcome(app, p.ownerId, params[0]!, commandId, waitMs());
				return ok({ operationId: commandId, session: params[0], ...(outcome ?? { status: "pending", replies: [] }) });
			}
			return ok({ ...admission, operationId: commandId, session: params[0] }, admission.duplicate ? 200 : 202);
		}),
		// Stops the chat's run. `operationId` names the message the client sent; the run is the chat's, so it is that run that stops.
		route("POST", "/api/sessions/:id/abort", async ({ app, principal, json, params }) => {
			const b = await json();
			const commandId = typeof b.commandId === "string" && b.commandId ? b.commandId : `abort:${typeof b.operationId === "string" && b.operationId ? b.operationId : randomUUID()}`;
			const admission = await app.conversations.admit(await principal(), { commandId, kind: "abort", chatId: params[0]!, payload: b.payload ?? { text: b.text } });
			return ok({ ...admission, aborted: true }, admission.duplicate ? 200 : 202);
		}),
		// How a sent message went: `?timeout=ms` (at most 60000, 25000 unless given) holds the answer until its turn has ended, with what the agent sent the person; until then `pending`.
		route("GET", "/api/sessions/:id/operations/:op", async ({ app, principal, params, url }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const since = await acceptedAt(app, p.ownerId, params[0]!, params[1]!);
			if (since === null) return ok({ operationId: params[1], session: params[0], status: "unknown" }, 404);
			const asked = Number(url.searchParams.get("timeout") ?? 25_000);
			const outcome = await awaitOutcome(app, p.ownerId, params[0]!, params[1]!, Math.min(Number.isFinite(asked) && asked >= 0 ? asked : 25_000, 60_000));
			return ok({ operationId: params[1], session: params[0], ...(outcome ?? { status: "pending" }) });
		}),
		route("GET", "/api/sessions/:id/messages", async ({ app, principal, params, url }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			await app.conversations.get(p.ownerId, params[0]!);
			const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
			const page = await transcriptPage(app.db.pool, p.ownerId, params[0]!, { before: url.searchParams.get("before"), ...(limit === undefined ? {} : { limit }) });
			const pending = (await app.conversations.pending(p.ownerId, params[0]!, 200)).filter((c) => !c.runtimeCommitted);
			return ok({ session: params[0], busy: pending.length > 0 || page.messages.some((m) => m.partial), pending: pending.map((c) => c.commandId), messages: page.messages, nextBefore: page.nextBefore });
		}),
	];
}
