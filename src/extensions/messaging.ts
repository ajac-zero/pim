import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { type PimServices, text } from "./services";

/** The tool Pim speaks with: the person sees what it sends, and nothing else it writes. */
export const SEND_TO_USER = "send_to_user";
export const MESSAGING_EXTENSION = "pim.messaging";

/** A notification's title when the model gives none: the message's first line. */
function headline(message: string): string {
	const line = message.trim().split(/\r?\n/)[0]!.replace(/^[#>*\-\s]+/, "").trim();
	return line.length > 120 ? `${line.slice(0, 119)}…` : line || "Pim";
}

export function messagingExtension(services: PimServices) {
	const sendToUser = defineTool({
		name: SEND_TO_USER,
		description:
			"Send the person a message in this conversation. It is the only way they see anything you write: the rest of your text is private working notes. Set notify to also alert their phone and browsers, for something they should see soon even if they are not looking at this conversation.",
		parameters: Type.Object({
			message: Type.String({ minLength: 1, maxLength: 20_000, description: "What they read, in Markdown." }),
			notify: Type.Optional(Type.Boolean({ description: "Also alert their devices. Use it sparingly." })),
			title: Type.Optional(Type.String({ maxLength: 120, description: "The alert's headline, with notify; else the message's first line." })),
		}),
		replay: "safe",
		async execute({ message, notify, title }, api, context) {
			const session = String(api.conversationId);
			// The chat moves up the list; a deleted one stays deleted.
			if (!services.store.deletedSessions().has(session)) services.store.touchSession(session);
			if (!notify) return text("Sent.");
			const id = await api.memo("notification", crypto.randomUUID(), context);
			const known = services.store.notification(id);
			const notification = services.store.addNotification({ id, session, title: title?.trim() || headline(message), body: message });
			// A replayed call stored it already; deliver only once.
			if (!known) await services.notify(notification);
			return text("Sent, and alerted their devices.");
		},
	});

	return defineExtension({ name: MESSAGING_EXTENSION, tools: [sendToUser] });
}
