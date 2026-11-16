import { randomUUID } from "node:crypto";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, type HarnessOptions } from "@earendil-works/pi-durable";
import { OwnerId, type PartitionId, type PublicChatId } from "@pim/v2-contracts/identity";
import { PartitionDirectory } from "@pim/v2-runtime/directory";
import { Runner } from "@pim/v2-runtime/runner";
import type { Stack } from "./stack.ts";

export { fauxAssistantMessage, fauxToolCall };

export const ADA = OwnerId.parse("o_ada");

/** The lead-in of the scripted answer that calls the tool: long enough that, streamed slowly, it commits several partials. */
export const LEAD = "Let me check that for you, one moment while I look it up carefully.";

/**
 * A real Runner on the stack's runtime database with a scripted model that streams slowly, and one replay-safe tool,
 * `echo`, whose runs are recorded so a test can show a rebuild repeats none.
 */
export async function createTurnRig(stack: Stack) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }], tokensPerSecond: 40, tokenSize: { min: 2, max: 3 } });
	const models = createModels();
	models.setProvider(faux.provider);
	const echoRuns: string[] = [];
	const echo = defineTool({
		name: "echo",
		description: "Echoes",
		parameters: Type.Object({ text: Type.String() }),
		replay: "safe",
		execute: async (args) => {
			echoRuns.push(args.text);
			return { content: [{ type: "text", text: `echo:${args.text}` }] };
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "echo", tools: [echo] }));
	const agent = { model: { provider: "faux", modelId: "m" } };
	const options = (): HarnessOptions => ({ models, registry, settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1_000 }, progress: { partialIntervalMs: 60, outputIntervalMs: 100 } } as never });
	const runner = new Runner({ db: stack.runtime, harnessOptions: options, homeRoot: () => ({ agent }), chatAgent: () => agent, listen: false, ownerFilter: ADA, pollMs: 40, idleUnloadMs: 0, steward: { holderId: "runner-1", leaseTtlMs: 8_000 } });
	const home = (await new PartitionDirectory(stack.runtime).createPartition(ADA, { kind: "home" })) as PartitionId;
	await runner.start();
	const submit = (commandId: string, content: string) =>
		runner.inbox.enqueueCommand({
			commandId,
			ownerId: ADA,
			partitionId: home,
			conversationId: 1,
			// The home conversation exists from the partition's first commit, so its public chat id is the runtime's, read with `chatId`.
			publicChatId: randomUUID() as PublicChatId,
			piRequestId: `pi:${commandId}`,
			kind: "user_message",
			payload: { content },
			submittedAt: new Date().toISOString(),
		});
	const chatId = async (): Promise<PublicChatId | undefined> =>
		(await stack.admin.query("SELECT public_chat_id FROM pim_runtime.conversation_partitions WHERE owner_id = $1 AND conversation_id = 1", [ADA])).rows[0]?.public_chat_id;
	/** The scripted turn: a slowly streamed answer that calls `echo`, then the final answer. */
	const scriptTurn = () => faux.setResponses([fauxAssistantMessage([{ type: "text", text: LEAD }, fauxToolCall("echo", { text: "ping" })], { stopReason: "toolUse" }), fauxAssistantMessage("All done: the echo said ping.")]);
	return { faux, runner, echoRuns, home, submit, chatId, scriptTurn };
}
