import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { DELIVERY_REMINDER } from "../transcript";
import { widgetMarkdown } from "./define";
import { type PimServices, text } from "./services";

/** The tool Pim speaks with: the person sees what it sends, and nothing else it writes. */
export const SEND_TO_USER = "send_to_user";
export const MESSAGING_EXTENSION = "pim.messaging";

/** How many widgets one message can carry. */
export const MAX_WIDGETS = 4;

/** A notification's title when the model gives none: the message's first line. */
function headline(message: string): string {
	const line = message.trim().split(/\r?\n/)[0]!.replace(/^[#>*\-\s]+/, "").trim();
	return line.length > 120 ? `${line.slice(0, 119)}…` : line || "Pim";
}

export function messagingExtension(services: PimServices) {
	const fields = {
		message: Type.String({ minLength: 1, maxLength: 20_000, description: "What they read, in Markdown." }),
		complete: Type.Optional(Type.Boolean({ description: "Finish this turn (default true). Set false only for a progress update; send the final answer in a separate call with no other tools." })),
		notify: Type.Optional(Type.Boolean({ description: "Also alert their devices. Use it sparingly." })),
		title: Type.Optional(
			Type.String({ maxLength: 120, description: "A short headline: the email's subject, or the alert's; else the message's first line." }),
		),
		widgets: Type.Optional(
			Type.Array(Type.String(), {
				maxItems: MAX_WIDGETS,
				description:
					"Widgets to show under the message, from the ones your prompt lists, by name. They show the person's data as it is now, drawn by the app: use one instead of retyping what it shows.",
			}),
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
			// A widget this chat can't show is a mistake the model can fix: say so, and send nothing.
			const wanted = [...new Set(args.widgets ?? [])];
			const available = services.widgetsFor(session).map((widget) => widget.ref);
			const unknown = wanted.filter((ref) => !available.includes(ref));
			if (unknown.length > 0) {
				const offer = available.length > 0 ? `The widgets you can show here: ${available.join(", ")}.` : "No widgets can be shown here.";
				return text(`Not sent: ${unknown.join(", ")} ${unknown.length === 1 ? "isn't a widget" : "aren't widgets"} you can show. ${offer}`, true);
			}
			// Loaded once, as sent: the message and what it shows stay together.
			const shown = await Promise.all(wanted.map((ref) => services.showWidget(session, ref)));
			let sent = "Sent.";
			if (channel === "email") {
				const id = await api.memo("email", crypto.randomUUID(), context);
				// An inbox can't draw widgets: they go as text.
				const body = [message, ...shown.map((widget) => widgetMarkdown(widget))].join("\n\n");
				const emailed = await services.sendEmail({ id, session, subject: headed, text: body });
				if ("error" in emailed) return text(`Not sent: ${emailed.error}`, true);
				sent = `Emailed it to ${emailed.to}.`;
			}
			// The chat moves up the list; a deleted one stays deleted.
			if (!services.store.deletedSessions().has(session)) services.store.touchSession(session);
			if (notify) {
				const id = await api.memo("notification", crypto.randomUUID(), context);
				const known = services.store.notification(id);
				const notification = services.store.addNotification({ id, session, title: headed, body: message });
				// A replayed call stored it already; deliver only once.
				if (!known) await services.notify(notification);
				sent = `${sent} Their devices were alerted.`;
			}
			// What the widgets showed goes back to the model too, so it knows what the person saw; the app draws it from here.
			return { ...text(shown.length === 0 ? sent : JSON.stringify({ sent, widgets: shown })), ...(args.complete === false ? {} : { control: { terminate: true as const } }) };
		},
	});

	return defineExtension({
		name: MESSAGING_EXTENSION,
		tools: [sendToUser],
		hooks: [
			hook(GenerationTask, {
				async beforeRequest({ messages }, api, context) {
					let required = false;
					let reminders = 0;
					for (const message of messages) {
						if (message.role === "user") {
							const input = typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
							if (input === DELIVERY_REMINDER) {
								reminders++;
								continue;
							}
							// Background work may deliberately stay silent.
							required = !/^\[(?:Scheduled task|Approval |App event\]|Team:)/.test(input);
							reminders = 0;
						}
					}
					await api.memo("delivery", { required, reminders }, context);
				},
				async afterResponse(answer, api, context) {
					const state = await api.memo<{ required: boolean; reminders: number }>("delivery", context);
					if (!state?.required || state.reminders < 2) return;
					if (answer.stopReason === "stop" || answer.stopReason === "length" || (answer.stopReason === "toolUse" && !answer.content.some((part) => part.type === "toolCall"))) {
						// Hook throws are reported and ignored by pi; classify this as a non-retryable failure instead.
						answer.stopReason = "error";
						answer.errorMessage = "The agent did not deliver its reply with send_to_user.";
					}
				},
				async onYield(_answer, api, context) {
					const state = await api.memo<{ required: boolean; reminders: number }>("delivery", context);
					if (!state?.required) return;
					// Continuations create new generation tasks: count in the transcript, not a task-local counter.
					return { continue: DELIVERY_REMINDER };
				},
			}),
		],
		sections: [
			// Always present, so it never appears later out of order and makes pi re-send every section.
			section("widgets", ({ conversationId }) => {
				const widgets = services.widgetsFor(String(conversationId));
				if (widgets.length === 0) return "No widgets can be shown in this conversation.";
				return [
					"Widgets you can show with a message, by name in send_to_user's widgets:",
					...widgets.map((widget) => `- ${widget.ref}: ${widget.description}`),
				].join("\n");
			}),
		],
	});
}
