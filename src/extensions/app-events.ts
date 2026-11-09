import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { type TriggerActor, type TriggerApi, TriggerApiError } from "../triggers/api";
import type { AppCatalog } from "./app-catalog";
import type { DirectoryApp } from "./app-directory";
import { type McpBridge, serverFor } from "./mcp";
import { json, text } from "./services";

/**
 * Event-triggered work through the draft MCP Events extension
 * (github.com/modelcontextprotocol/experimental-ext-triggers-events), with
 * webhook delivery only, the slice ChatGPT also implements.
 *
 * A watch is a trigger (../triggers, docs/triggers.md) on one event type of
 * a connected connector, with an instruction, delivering to the chat that
 * made it. The trigger's subscription manager subscribes with
 * `events/subscribe`, giving the connector a callback URL and a Standard
 * Webhooks secret, and renews it; each signed delivery is taken in once and
 * handed to the chat as a message starting with "[Connector event]".
 */

/** Deliveries signed longer ago than this are refused (Standard Webhooks). */
const TOLERANCE_S = 300;

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

/** A fresh Standard Webhooks secret: `whsec_` and 32 random bytes. */
export function newSecret(): string {
	return `whsec_${base64(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** The Standard Webhooks `v1` signature of a delivery. */
export async function signWebhook(secret: string, id: string, timestamp: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (char) => char.charCodeAt(0)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
	return `v1,${base64(new Uint8Array(signature))}`;
}

/** Checks a delivery's signature (any of the space-separated ones) and freshness. */
export async function verifyWebhook(secret: string, headers: Headers, body: string, nowSeconds: number): Promise<boolean> {
	const id = headers.get("webhook-id");
	const timestamp = headers.get("webhook-timestamp");
	const signatures = headers.get("webhook-signature");
	if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false;
	if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_S) return false;
	const expected = new TextEncoder().encode(await signWebhook(secret, id, timestamp, body));
	return signatures.split(" ").some((candidate) => {
		const given = new TextEncoder().encode(candidate);
		return given.length === expected.length && crypto.subtle.timingSafeEqual(given, expected);
	});
}

/** Where a watch's subscription with its connector stands. */
export type WatchSubscription = {
	/** `active` once the connector took it, `pending` until then, `ended` once it refused it or it was given up. */
	readonly status: "active" | "pending" | "ended";
	/** Why it isn't active, as fixed words and a code, never the connector's text; null when nothing went wrong. */
	readonly lastError: string | null;
	readonly renewsBefore: number | null;
	readonly lastEventAt: number | null;
};

/** What the watch tools need of the space. */
export type WatchHost = {
	/** Triggers' API, while the space's triggers are on; null otherwise. */
	readonly api: () => TriggerApi | null;
	/** Who calls from a chat: its agent. */
	readonly actor: (session: string) => TriggerActor;
	/** The origin callback URLs are built on; null while Pim doesn't know it. */
	readonly publicUrl: () => string | null;
	/** Sends what connectors' subscriptions call for now, such as a new watch's subscribe or a stopped one's unsubscribe. */
	readonly sync: () => Promise<void>;
	/** Where a watch's subscription stands. */
	readonly subscription: (triggerId: string) => WatchSubscription;
	/** The trigger that took over a watch made before watches were triggers, by that watch's id; null for any other id. */
	readonly triggerOfWatch: (watchId: string) => string | null;
};

const MAX_LABEL = 120;

/** The model-facing side: discovering, creating, listing and stopping watches. */
export function eventTools(
	bridge: McpBridge,
	catalog: AppCatalog,
	/** The connectors a conversation's agent works with: the only ones it may watch. */
	appsOf: (session: string) => readonly DirectoryApp[],
	/** Whether the person switched `watch_connector_event` off. */
	switchedOff: () => boolean,
	host: WatchHost,
) {
	/** The connected servers of the connectors this conversation's agent works with. */
	const servers = (session: string) => appsOf(session).flatMap((app) => serverFor(bridge.servers(), app) ?? []);
	const app = (name: string, session: string) => {
		const wanted = name.toLowerCase();
		return servers(session).find((server) => server.id === wanted || server.name.toLowerCase() === wanted);
	};
	const nameOf = (connectorId: string) => bridge.servers().find((server) => server.id === connectorId)?.name ?? connectorId;
	const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

	const listAppEvents = defineTool({
		name: "list_connector_events",
		description: "List the events connected connectors can notify you about, with the arguments each accepts.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			return json(
				servers(String(api.conversationId)).flatMap((server) =>
					catalog.events(server.id).map((event) => ({
						connector: server.name,
						event: event.name,
						description: event.description,
						arguments: event.inputSchema ?? {},
					})),
				),
			);
		},
	});

	const watchEvent = defineTool({
		name: "watch_connector_event",
		description: `Have a connected connector notify you whenever an event happens (see list_connector_events), and say what to do each time. Each event arrives as a message starting with "[Connector event]". Subscribing needs no approval; what you do when an event arrives is still subject to the usual approvals.`,
		parameters: Type.Object({
			connector: Type.String(),
			event: Type.String(),
			arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Filters the event accepts." })),
			instruction: Type.String({ minLength: 1, description: "What to do each time it fires, written to your future self." }),
		}),
		replay: "safe",
		async execute({ connector: appName, event, arguments: args, instruction }, api) {
			if (switchedOff()) return text("The person switched watch_connector_event off. Do not try it another way.", true);
			const session = String(api.conversationId);
			const server = app(appName, session);
			if (!server) return text(`No connector named ${appName} among the connectors you work with.`, true);
			if (!catalog.events(server.id).some((candidate) => candidate.name === event)) {
				return text(`${server.name} has no event named ${event}. See list_connector_events.`, true);
			}
			if (server.state !== "ready") return text(`${server.name} is not connected.`, true);
			const refused = (why: string) => text(`Could not watch ${server.name} for "${event}": ${why}`, true);
			const triggers = host.api();
			if (!triggers) return refused("triggers, which watches are, are off in this space.");
			if (!host.publicUrl()) return refused("pim does not know its public URL yet; set PIM_PUBLIC_URL.");
			const actor = host.actor(session);
			const label = `${server.name}: ${event}`;
			let id: string;
			try {
				// The tool call's durable identity is the creation key, so a replayed call makes nothing new.
				const made = await triggers.create(
					actor,
					{
						label: label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label,
						instruction,
						source: { kind: "connector_event", connectorId: server.id, event, arguments: args ?? {} },
						destination: { type: "existing_chat" },
						enabled: true,
					},
					`watch:${api.conversationId}:${api.taskId}`,
				);
				id = made.trigger.id;
			} catch (error) {
				if (error instanceof TriggerApiError) return refused(error.message);
				throw error;
			}
			// Subscribed now, so the connector's answer is this call's.
			await host.sync();
			const subscription = host.subscription(id);
			if (subscription.status === "ended" || subscription.lastError !== null) {
				await triggers.remove(actor, id).catch(() => undefined);
				await host.sync();
				return refused(`the connector did not take the subscription (${subscription.lastError ?? "ended"}).`);
			}
			return text(`Watching ${server.name} for "${event}" (watch ${id}). Each event will arrive here as a message starting with "[Connector event]".`);
		},
	});

	const listWatches = defineTool({
		name: "list_watches",
		description: "List your connector event watches and their state.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			const triggers = host.api();
			if (!triggers) return json([]);
			const actor = host.actor(String(api.conversationId));
			const views: ReturnType<TriggerApi["get"]>[] = [];
			let cursor: string | undefined;
			do {
				const page = triggers.list(actor, { sourceKind: "connector_event", ...(actor.kind === "agent" ? { agentId: actor.agentId } : {}), limit: 50, ...(cursor === undefined ? {} : { cursor }) });
				views.push(...page.triggers);
				cursor = page.nextCursor ?? undefined;
			} while (cursor !== undefined);
			return json(
				views.map((view) => {
					const source = view.source as { connectorId: string; event: string; arguments: Record<string, unknown> };
					const subscription = host.subscription(view.id);
					return {
						id: view.id,
						app: nameOf(source.connectorId),
						event: source.event,
						arguments: source.arguments,
						instruction: view.instruction,
						session: view.destination.type === "existing_chat" ? view.destination.chatId : null,
						status: view.lifecycle === "enabled" ? subscription.status : view.lifecycle,
						lastError: subscription.lastError ?? (view.health === "healthy" || view.health === "unknown" ? null : view.healthDetail),
						lastEventAt: iso(subscription.lastEventAt),
						renewsBefore: iso(subscription.renewsBefore),
					};
				}),
			);
		},
	});

	const stopWatch = defineTool({
		name: "stop_watch",
		description: "Stop a connector event watch by its id.",
		parameters: Type.Object({ id: Type.String() }),
		replay: "safe",
		async execute({ id }, api) {
			const triggers = host.api();
			const missing = text(`No watch with id ${id}.`, true);
			if (!triggers) return missing;
			const actor = host.actor(String(api.conversationId));
			const triggerId = host.triggerOfWatch(id) ?? id;
			try {
				const view = triggers.get(actor, triggerId);
				if ((view.source as { kind: string }).kind !== "connector_event" || view.lifecycle === "deleted") return missing;
				await triggers.remove(actor, triggerId);
			} catch (error) {
				if (error instanceof TriggerApiError) return error.code === "not_found" ? missing : text(error.message, true);
				throw error;
			}
			// Unsubscribed now, as stopping always did.
			await host.sync();
			return text("Stopped.");
		},
	});

	return (switchedOff() ? [listAppEvents, listWatches, stopWatch] : [listAppEvents, watchEvent, listWatches, stopWatch]) as ToolRegistration[];
}
