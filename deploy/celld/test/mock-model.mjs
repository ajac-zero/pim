// A stand-in model server for the scratch run: it speaks OpenAI's /chat/completions, which Pim
// reaches as a custom endpoint the person adds in Settings, the way a homelab Pim reaches
// llama.cpp or LM Studio. It answers as the preview's stand-in model does (preview/worker.ts):
// `/tool <name> {json}` calls that tool; anything else is sent back through `send_to_user`.
// It knows nothing of Pim's prompt and judges nothing. Never point a real Pim at it.
//
//   node deploy/celld/test/mock-model.mjs PORT

import { createServer } from "node:http";

const MODEL = "mock-model";
let calls = 0;

const textOf = (message) =>
	typeof message?.content === "string" ? message.content : (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** The next assistant turn: a tool call, or plain text, which ends the turn. */
function answer(messages) {
	const last = messages.at(-1);
	if (last?.role === "tool") {
		const call = messages.flatMap((message) => message.tool_calls ?? []).find((call) => call.id === last.tool_call_id);
		if (call?.function.name === "send_to_user") return { text: "" };
		return { tool: "send_to_user", args: { message: `${call?.function.name} returned: ${textOf(last).slice(0, 500)}` } };
	}
	const said = textOf(messages.findLast((message) => message.role === "user")).trim();
	const directive = /^\/tool\s+(\S+)\s*([\s\S]*)$/.exec(said);
	if (directive) return { tool: directive[1], args: JSON.parse(directive[2] || "{}") };
	return { tool: "send_to_user", args: { message: `You said: ${said}` } };
}

function completion(body, res) {
	const turn = answer(body.messages ?? []);
	const id = `chatcmpl-${++calls}`;
	const toolCalls = turn.tool ? [{ index: 0, id: `call_${calls}`, type: "function", function: { name: turn.tool, arguments: JSON.stringify(turn.args) } }] : undefined;
	const finish = turn.tool ? "tool_calls" : "stop";
	const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
	if (!body.stream) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ id, object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: turn.text ?? null, tool_calls: toolCalls }, finish_reason: finish }], usage }));
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: MODEL, choices, ...extra })}\n\n`);
	chunk([{ index: 0, delta: { role: "assistant", ...(turn.tool ? { tool_calls: toolCalls } : { content: turn.text }) }, finish_reason: null }]);
	chunk([{ index: 0, delta: {}, finish_reason: finish }]);
	chunk([], { usage });
	res.end("data: [DONE]\n\n");
}

const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		const path = new URL(req.url, "http://x").pathname.replace(/^\/v1/, "");
		if (req.method === "GET" && path === "/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", owned_by: "scratch" }] }));
		} else if (req.method === "POST" && path === "/chat/completions") {
			completion(JSON.parse(raw), res);
		} else {
			res.writeHead(404).end();
		}
	});
});
server.listen(Number(process.argv[2] ?? 0), "127.0.0.1", () => console.log(`mock model on http://127.0.0.1:${server.address().port}/v1`));
