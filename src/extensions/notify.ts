import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { type PimServices, text } from "./services";

export function notifyExtension(services: PimServices) {
	const notifyUser = defineTool({
		name: "notify_user",
		description:
			"Send the user a notification they will see even when they are not looking at this conversation: results of background work, reminders, or something that needs their attention.",
		parameters: Type.Object({
			title: Type.String({ minLength: 1, maxLength: 120 }),
			body: Type.String({ minLength: 1, maxLength: 4000 }),
		}),
		replay: "safe",
		async execute({ title, body }, api, context) {
			const id = await api.memo("notification", crypto.randomUUID(), context);
			const known = services.store.notification(id);
			const notification = services.store.addNotification({ id, session: String(api.conversationId), title, body });
			// A replayed call stored it already; deliver only once.
			if (!known) await services.notify(notification);
			return text("Notification sent.");
		},
	});

	return defineExtension({ name: "pim.notify", tools: [notifyUser] });
}
