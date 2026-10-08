import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { type PimServices, json, text } from "./services";

/** How many memories are always in the system prompt; older ones stay reachable through `recall`. */
const PROMPT_MEMORIES = 100;

export function memoryExtension({ store }: PimServices) {
	const remember = defineTool({
		name: "remember",
		description:
			"Save one lasting fact about the user (a preference, relationship, date, constraint or decision) so you know it in every future conversation. One fact per call, written as a full sentence.",
		parameters: Type.Object({ content: Type.String({ minLength: 1, maxLength: 1000 }) }),
		replay: "safe",
		async execute({ content }, api, context) {
			// The id is memoized, so a call replayed after an eviction saves the fact once.
			const id = await api.memo("memory", crypto.randomUUID(), context);
			const memory = store.addMemory(content, id);
			return text(`Remembered (id ${memory.id}).`);
		},
	});

	const recall = defineTool({
		name: "recall",
		description: "Search everything you have remembered about the user by keywords.",
		parameters: Type.Object({ query: Type.String() }),
		replay: "safe",
		async execute({ query }) {
			const found = store.searchMemories(query);
			return found.length === 0 ? text("Nothing remembered matches.") : json(found);
		},
	});

	const forget = defineTool({
		name: "forget",
		description: "Delete a remembered fact by its id, for example when the user asks you to forget it or it is no longer true.",
		parameters: Type.Object({ id: Type.String() }),
		replay: "safe",
		async execute({ id }) {
			return store.deleteMemory(id) ? text("Forgotten.") : text(`No memory with id ${id}.`, true);
		},
	});

	return defineExtension({
		name: "pim.memory",
		tools: [remember, recall, forget],
		sections: [
			section("memories", () => {
				const memories = store.memories(PROMPT_MEMORIES);
				if (memories.length === 0) return "You have not remembered anything about the user yet.";
				return [
					"What you remember about the user (id: fact), newest first:",
					...memories.map((memory) => `- ${memory.id}: ${memory.content}`),
				].join("\n");
			}),
		],
	});
}
