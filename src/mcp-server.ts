import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { Agent } from "./agents";
import { HttpError } from "./http";

/**
 * The person's Pim as an MCP server, at `/mcp`, so MCP clients such as
 * Claude or ChatGPT can talk with it. Like Amp's Puck over MCP, it has one
 * tool, `pim`: a message to the person's majordomo (./majordomo.ts),
 * answered with what the majordomo sends back. Each call starts a new chat
 * unless it names one an earlier call started, and every answer names its
 * chat, so the client decides what belongs together and Pim keeps no state
 * for it.
 *
 * The majordomo hands bigger work to the person's other agents, and what they
 * say later comes back to its chat, so asking again in the same conversation
 * finds out how things went.
 */

/** How long a call waits for the majordomo's answer. Under the 60 seconds MCP clients commonly allow. */
export const REPLY_WAIT_MS = 45_000;

/** How the majordomo's turn ended, with what it sent the person. */
export type PimReply = {
	readonly status: "done" | "unanswered";
	readonly replies: readonly string[];
	readonly reason?: string;
};

/** The majordomo the server talks with. */
export type PimChat = {
	readonly majordomo: Agent;
	/**
	 * Sends `message` to the majordomo's chat `conversation`, or to a new chat
	 * without one, and returns the chat with the turn's result, or null when
	 * `signal` aborts the wait first. Throws an `HttpError` it reports to the client.
	 */
	send(message: string, conversation: string | undefined, signal: AbortSignal): Promise<{ conversation: string; reply: PimReply | null }>;
};

/** Answers an MCP request, on the path the request came to. */
export function serveMcp(request: Request, chat: PimChat): Promise<Response> {
	const route = new URL(request.url).pathname;
	// The Worker answers CORS.
	return createMcpHandler(() => pimServer(chat), { route, corsOptions: false }).fetch(request);
}

function pimServer({ majordomo, send }: PimChat): McpServer {
	const { name } = majordomo;
	const server = new McpServer({ name: "Pim", version: "1.0.0" }, { instructions: `Talk with ${name}, the person's majordomo in Pim, through the pim tool.` });
	server.registerTool(
		"pim",
		{
			title: `Message ${name}`,
			description:
				`Send a message to ${name}, the person's majordomo in Pim, and get its reply. It knows them, their memory, goals, schedules and apps, ` +
				"and hands bigger work to their other agents, whose answers come back to it. " +
				"Each call starts a new conversation, which the person can also continue in Pim. Every reply names its conversation: " +
				"pass it back as conversation to continue, for example to follow up or to hear how handed-off work went.",
			inputSchema: z.object({
				message: z.string().min(1).describe("What to say, in plain words."),
				conversation: z.string().min(1).optional().describe("A conversation an earlier reply named, to continue it. Leave out to start a new one."),
			}),
			outputSchema: z.object({
				conversation: z.string().describe("The conversation this happened in: pass it as conversation to continue."),
				reply: z.string().describe(`What ${name} said.`),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async ({ message, conversation }) => {
			let sent: Awaited<ReturnType<PimChat["send"]>>;
			try {
				sent = await send(message, conversation, AbortSignal.timeout(REPLY_WAIT_MS));
			} catch (error) {
				if (!(error instanceof HttpError)) throw error;
				return { content: [{ type: "text" as const, text: error.message }], isError: true };
			}
			const { reply } = sent;
			const said = !reply
				? `${name} is still working on this. Ask again in a little while, in this conversation.`
				: reply.status === "unanswered"
					? `${name} didn't finish: ${reply.reason ?? "the turn ended without an answer"}.`
					: reply.replies.join("\n\n") || `${name} sent no reply.`;
			return {
				content: [{ type: "text" as const, text: `${said}\n\n[conversation: ${sent.conversation}]` }],
				structuredContent: { conversation: sent.conversation, reply: said },
				isError: reply?.status === "unanswered",
			};
		},
	);
	return server;
}
