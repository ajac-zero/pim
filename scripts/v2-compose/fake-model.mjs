// OpenAI-compatible stand-in model for the Compose smoke test (scripts/v2-compose/smoke.sh), like the preview's: it answers each user message through send_to_user ("Echo: ...");
// "/tool name {json}" makes it call that tool first, then send its result through send_to_user.
import { createServer } from "node:http";
const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => p.text ?? "").join(""));
createServer(async (req, res) => {
	let body = ""; for await (const c of req) body += c;
	if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "fake-1", object: "model" }] }));
	const request = JSON.parse(body || "{}");
	const msgs = request.messages ?? [];
	const system = textOf(msgs[0]);
	// A side job of the utility model (a title, a summary, ...) asks for one plain answer, not a stream; an app's window.pim.ask is told it comes from an app.
	if (request.stream === false && !system.includes("from a small app")) {
		const content = system.includes("name chats") ? "Fake Utility Title" : system.includes("improve messages") ? "Improved: " + textOf(msgs[1]) : system.includes("suggest") ? '{"messages":["Plan my week","Summarize this chat"]}' : "- Summary from the utility model";
		return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "c1", object: "chat.completion", model: request.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
	}
	// A request with no tools, as an app's window.pim.ask makes, is answered with plain text.
	if (!request.tools?.length) {
		const asked = textOf([...msgs].reverse().find((m) => m.role === "user")).trim();
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 0, model: "fake-1", choices: [{ index: 0, message: { role: "assistant", content: `Echo: ${asked}` }, finish_reason: "stop" }] }));
	}
	// A coding thread's pi has no send_to_user: it answers in text once a tool's result is in.
	const chat = (request.tools ?? []).some((t) => t.function?.name === "send_to_user");
	const last = msgs[msgs.length - 1] ?? {};
	const lastUser = [...msgs].reverse().find((m) => m.role === "user");
	const text = textOf(lastUser).trim();
	const m = /^\/tool (\S+) (.*)$/s.exec(text);
	// What tool calls the assistant made since the last user message.
	const since = msgs.slice(msgs.lastIndexOf(lastUser) + 1);
	const sent = since.some((x) => x.role === "assistant" && (x.tool_calls ?? []).some((c) => c.function?.name === "send_to_user"));
	console.log(new Date().toISOString(), request.model, last.role, JSON.stringify(text).slice(0, 80), sent ? "(done)" : "");
	res.writeHead(200, { "content-type": "text/event-stream" });
	const send = (o) => res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake-1", ...o })}\n\n`);
	const call = (name, args) => {
		send({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_" + Date.now(), type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
		send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
	};
	if (sent) send({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
	else if (m && last.role === "user") call(m[1], JSON.parse(m[2]));
	else if (last.role === "tool" && !chat) send({ choices: [{ index: 0, delta: { role: "assistant", content: `Tool result: ${textOf(last).slice(0, 400)}` }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
	else if (!chat) send({ choices: [{ index: 0, delta: { role: "assistant", content: `Echo: ${text}` }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
	else if (last.role === "tool") call("send_to_user", { message: `Tool result: ${textOf(last).slice(0, 400)}` });
	else call("send_to_user", { message: `Echo: ${text}` });
	res.end("data: [DONE]\n\n");
}).listen(9000, () => console.log("fake model on 9000"));
