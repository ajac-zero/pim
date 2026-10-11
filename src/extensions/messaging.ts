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
	const fields = {
		message: Type.String({ minLength: 1, maxLength: 20_000, description: "What they read, in Markdown." }),
		notify: Type.Optional(Type.Boolean({ description: "Also alert their devices. Use it sparingly." })),
		title: Type.Optional(
			Type.String({ maxLength: 120, description: "A short headline: the email's subject, or the alert's; else the message's first line." }),
		),
	};
	const withEmail = Type.Object({
		...fields,
		channel: Type.Optional(
			Type.Union([Type.Literal("chat"), Type.Literal("email")], {
				description:
					'Where it goes: "chat" (the default), this conversation; "email", their inbox, when they ask for email or for something they will want to keep, such as a report. The conversation shows that it was emailed.',
			}),
		),
	});
	const sendToUser = defineTool({
		name: SEND_TO_USER,
		description:
			"Send the person a message. It is the only way they see anything you write: the rest of your text is private working notes. Set notify to also alert their phone and browsers, for something they should see soon even if they are not looking at this conversation.",
		// Email is a channel only where the deployment can send it.
		parameters: services.emailEnabled ? withEmail : (Type.Object(fields) as unknown as typeof withEmail),
		replay: "safe",
		async execute(args, api, context) {
			const { message, channel, notify, title } = args;
			const session = String(api.conversationId);
			const headed = title?.trim() || headline(message);
			let sent = "Sent.";
			if (channel === "email") {
				const id = await api.memo("email", crypto.randomUUID(), context);
				const emailed = await services.sendEmail({ id, session, subject: headed, text: message });
				if ("error" in emailed) return text(`Not sent: ${emailed.error}`, true);
				sent = `Emailed it to ${emailed.to}.`;
			}
			// The chat moves up the list; a deleted one stays deleted.
			if (!services.store.deletedSessions().has(session)) services.store.touchSession(session);
			if (!notify) return text(sent);
			const id = await api.memo("notification", crypto.randomUUID(), context);
			const known = services.store.notification(id);
			const notification = services.store.addNotification({ id, session, title: headed, body: message });
			// A replayed call stored it already; deliver only once.
			if (!known) await services.notify(notification);
			return text(`${sent} Their devices were alerted.`);
		},
	});

	return defineExtension({ name: MESSAGING_EXTENSION, tools: [sendToUser] });
}
