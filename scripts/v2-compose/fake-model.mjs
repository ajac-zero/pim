// OpenAI-compatible stand-in model for the Compose smoke test (scripts/v2-compose/smoke.sh), like the preview's: it answers each user message through send_to_user ("Echo: ...");
// "/tool name {json}" makes it call that tool first, then send its result through send_to_user. "/stall" sends the response's headers and then nothing, as a model whose
// connection has gone quiet does (the run guard's proof).
import { createServer } from "node:http";
const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => p.text ?? "").join(""));
createServer(async (req, res) => {
	let body = ""; for await (const c of req) body += c;
	if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "fake-1", object: "model" }] }));
	const msgs = (JSON.parse(body || "{}").messages) ?? [];
	const last = msgs[msgs.length - 1] ?? {};
	const lastUser = [...msgs].reverse().find((m) => m.role === "user");
	const text = textOf(lastUser).trim();
	const m = /^\/tool (\S+) (.*)$/s.exec(text);
	// What tool calls the assistant made since the last user message.
	const since = msgs.slice(msgs.lastIndexOf(lastUser) + 1);
	const sent = since.some((x) => x.role === "assistant" && (x.tool_calls ?? []).some((c) => c.function?.name === "send_to_user"));
	console.log(new Date().toISOString(), last.role, JSON.stringify(text).slice(0, 80), sent ? "(done)" : "");
	res.writeHead(200, { "content-type": "text/event-stream" });
	if (text.startsWith("/stall") && last.role === "user") return res.flushHeaders();
	const send = (o) => res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake-1", ...o })}\n\n`);
	const call = (name, args) => {
		send({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_" + Date.now(), type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
		send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
	};
	if (sent) send({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
	else if (m && last.role === "user") call(m[1], JSON.parse(m[2]));
	else if (last.role === "tool") call("send_to_user", { message: `Tool result: ${textOf(last).slice(0, 400)}` });
	else call("send_to_user", { message: `Echo: ${text}` });
	res.end("data: [DONE]\n\n");
}).listen(9000, () => console.log("fake model on 9000"));
