// How a thread's recorded `message` event reads as transcript messages. pi and the vendor CLIs record a tool call on the assistant's event (`data.toolCalls`) and each result as an event of its own (role `tool`); an Amp
// thread's messages are recorded as Amp sends them, with their tool steps in `data.parts` (a call in the assistant's message, its result in the user message that follows).
import type { MessagePart, TranscriptMessage } from "@pim/shared/transcript";

type Row = { seq: any; role: any; data?: any; at: any };

const object = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const args = (value: unknown): Record<string, unknown> => object(value);

/** The tool calls an event carries, in pi's shape or Amp's. A call without an id or name can't be shown or paired with a result, so it is left out rather than guessed at. */
function calls(d: Record<string, unknown>): { id: string; name: string; arguments: Record<string, unknown> }[] {
	const found: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
	for (const c of [...(Array.isArray(d.toolCalls) ? d.toolCalls : []), ...(Array.isArray(d.parts) ? d.parts.filter((p) => object(p).type === "toolCall") : [])]) {
		const o = object(c);
		if (typeof o.id === "string" && o.id !== "" && typeof o.name === "string") found.push({ id: o.id, name: o.name, arguments: args(o.arguments) });
	}
	return found;
}

/** The tool results an Amp event carries. */
function results(d: Record<string, unknown>): { id: string; name: string; text: string; isError: boolean }[] {
	const found: { id: string; name: string; text: string; isError: boolean }[] = [];
	for (const p of Array.isArray(d.parts) ? d.parts : []) {
		const o = object(p);
		if (o.type === "toolResult" && typeof o.id === "string" && o.id !== "") found.push({ id: o.id, name: typeof o.name === "string" ? o.name : "tool", text: typeof o.text === "string" ? o.text : "", isError: o.isError === true });
	}
	return found;
}

/** The transcript messages of one recorded message event: the message itself, then each tool result it carries as a message of role `tool` (the result's own id after the event's). */
export function eventMessages(e: Row): TranscriptMessage[] {
	const d = object(e.data);
	const timestamp = new Date(e.at).getTime();
	const id = String(e.seq);
	if (e.role === "tool") {
		return [{ id, role: "tool", timestamp, parts: [{ type: "tool-result", id: String(d.toolCallId ?? ""), name: String(d.name ?? "tool"), content: [{ type: "text", text: String(d.text ?? "") }], error: d.isError === true }] }];
	}
	const parts: MessagePart[] = [];
	if (d.text) parts.push({ type: "text", text: String(d.text) });
	for (const c of calls(d)) parts.push({ type: "tool-call", id: c.id, name: c.name, arguments: c.arguments as never });
	const answers = results(d);
	const role = (["user", "assistant", "tool", "notice"].includes(e.role ?? "") ? e.role : "notice") as TranscriptMessage["role"];
	// A user message of nothing but tool results is the agent's own plumbing, not something a person said.
	const carrier = answers.length > 0 && parts.length === 0;
	return [
		...(carrier ? [] : [{ id, role, parts, timestamp }]),
		...answers.map((r): TranscriptMessage => ({ id: `${id}:${r.id}`, role: "tool", timestamp, parts: [{ type: "tool-result", id: r.id, name: r.name, content: [{ type: "text", text: r.text }], error: r.isError }] })),
	];
}
