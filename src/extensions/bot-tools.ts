import type { ImageContent, TextContent, TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { text } from "./services";

/**
 * The tools a bot's author shares with its guests. The author picks them,
 * one by one, from what their agent can use in their own space: its connectors'
 * tools and `generate_image`. Each runs in the author's space, as the
 * author, with their connections, model and computer; a guest's copy of the
 * bot gets a stand-in for each, which calls the author's space
 * (`Pim.runBotTool`), and which the author's space checks against what the
 * bot shares at every call. Nothing else of the author's is reachable.
 * A tool the author asks about first files an approval in their space, and
 * the guest's call waits, suspended, until they decide.
 */

export const BOT_TOOLS_EXTENSION = "pim.bot-tools";

/** A tool a bot shares, as its guests' model sees it, kept with the bot when it's shared. */
export type BotTool = {
	/** As the model sees it: `<app>_<tool>`, or `generate_image`. */
	readonly name: string;
	/** The connector it belongs to; null for Pim's own. */
	readonly appName: string | null;
	readonly description: string;
	/** Its input, as JSON Schema text: as text, it crosses between spaces as it is. */
	readonly parameters: string;
	/** The connector says it changes or deletes things. */
	readonly destructive: boolean;
	/** The author approves each call first; missing in bots shared before they could. */
	readonly ask?: boolean;
};

/** What a shared tool answered, as it goes back to the guest's space. */
export type BotToolResult = { readonly content: (TextContent | ImageContent)[]; readonly isError?: boolean };

export const botToolError = (message: string): BotToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** A guest's call, as the author's space files an approval for it: one that can wait for the decision. */
export type BotToolCall = { readonly session: string; readonly callId: string; readonly username: string };

/**
 * The guest's side: a stand-in for each tool the bot shares, which counts
 * against the guest's tool calls a day and then asks the author's space to
 * run it. When the author's space answers null, the author is asked first:
 * the call suspends, and their decision wakes it to ask again, and find the
 * outcome.
 */
export function botToolsExtension(
	tools: readonly BotTool[],
	reserve: () => string | null,
	run: (name: string, args: Record<string, unknown>, call: BotToolCall | null) => Promise<BotToolResult | null>,
	username: string,
) {
	return defineExtension({
		name: BOT_TOOLS_EXTENSION,
		tools: tools.map(
			(tool) =>
				defineTool({
					name: tool.name,
					description: tool.ask
						? `${tool.description} The bot's author approves each call first: it waits for their answer, up to a day, so tell the person before you call it.`
						: tool.description,
					parameters: { type: "object", ...JSON.parse(tool.parameters) } as unknown as TSchema,
					// It runs elsewhere, and may spend the author's credits: never twice. One the author approves
					// first waits for them, suspended, and runs again once they decide, finding their decision.
					replay: tool.ask ? "safe" : "unsafe",
					async execute(args, api, context) {
						// Counted once, however many times a call that waits runs.
						let refusal = await api.memo<string>("reserved", context);
						if (refusal === undefined) refusal = await api.memo("reserved", reserve() ?? "", context);
						if (refusal) return text(refusal, true);
						try {
							const call = tool.ask ? { session: String(api.conversationId), callId: api.callId, username } : null;
							const result = await run(tool.name, (args ?? {}) as Record<string, unknown>, call);
							if (result === null) return { control: { suspend: true } };
							return { content: result.content, ...(result.isError ? { isError: true } : {}) };
						} catch (error) {
							return text(`${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`, true);
						}
					},
				}) as ToolRegistration,
		),
	});
}
