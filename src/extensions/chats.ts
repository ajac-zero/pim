import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { text } from "./services";

export const CHATS_EXTENSION = "pim.chats";
export const READ_CHAT = "read_chat";

/** A chat as an agent reads it: its title and what was said in it, or null if the person has no such chat. */
export type ChatReader = (id: string) => Promise<{ title: string | null; conversation: string } | null>;

/**
 * Lets any agent read one of the person's chats by its id, which the app
 * shows beside the chat's title, to carry on from it in a new chat or to
 * look up what was done there.
 */
export function chatsExtension(read: ChatReader) {
	const readChat = defineTool({
		name: READ_CHAT,
		description:
			"Read another of the person's chats by its id, which they can copy from the chat's title bar: what they said and what the agent in it sent them. Use it to carry on from a chat in a new one, or to check what was done in a previous chat. A long chat is cut to its latest part.",
		parameters: Type.Object({ id: Type.String({ minLength: 1, description: "The chat's id." }) }),
		replay: "safe",
		async execute({ id }) {
			const chat = await read(id.trim());
			if (!chat) return text(`The person has no chat with id ${id}.`, true);
			return text(`Chat${chat.title ? ` "${chat.title}"` : ""}:\n\n${chat.conversation || "(nothing was said)"}`);
		},
	});
	return defineExtension({ name: CHATS_EXTENSION, tools: [readChat] });
}
