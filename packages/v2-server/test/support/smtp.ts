import net from "node:net";
import { freePort } from "./stack.ts";

export type Received = { from: string; to: string[]; raw: string; user: string | null };

/** A message as a mail client reads it: its headers (decoded subject), and its text. */
export function readMessage(raw: string): { headers: Record<string, string>; subject: string; text: string } {
	const [head = "", ...rest] = raw.split("\r\n\r\n");
	const headers: Record<string, string> = {};
	for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) headers[line.slice(0, line.indexOf(":")).toLowerCase()] = line.slice(line.indexOf(":") + 1).trim();
	const subject = (headers.subject ?? "").replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (_, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
	return { headers, subject, text: Buffer.from(rest.join("\r\n\r\n").replace(/\s+/g, ""), "base64").toString("utf8").replace(/\r\n/g, "\n") };
}

/** A stand-in SMTP server: it keeps what it is sent, and can ask for a password (AUTH PLAIN). */
export async function startSmtp(options: { auth?: { user: string; pass: string } } = {}) {
	const received: Received[] = [];
	const port = await freePort();
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		let buffer = "";
		let data: string | undefined;
		let current: Received = { from: "", to: [], raw: "", user: null };
		const say = (line: string) => socket.write(`${line}\r\n`);
		say("220 stand-in ESMTP");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				if (data !== undefined) {
					const end = buffer.indexOf("\r\n.\r\n");
					if (end < 0) return;
					current.raw = buffer.slice(0, end).replace(/^\.\./gm, ".");
					buffer = buffer.slice(end + 5);
					received.push(current);
					current = { from: "", to: [], raw: "", user: current.user };
					data = undefined;
					say("250 queued");
					continue;
				}
				const end = buffer.indexOf("\r\n");
				if (end < 0) return;
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const [verb = "", ...args] = line.split(" ");
				if (verb === "EHLO") socket.write(`250-stand-in\r\n250-8BITMIME\r\n${options.auth ? "250 AUTH PLAIN LOGIN\r\n" : "250 OK\r\n"}`);
				else if (verb === "AUTH") {
					const [user, pass] = Buffer.from(args[1] ?? "", "base64").toString().split("\u0000").slice(1);
					if (options.auth && user === options.auth.user && pass === options.auth.pass) (current.user = user ?? null, say("235 welcome"));
					else say("535 no");
				} else if (verb === "MAIL") (current.from = /<(.*)>/.exec(line)?.[1] ?? "", say("250 ok"));
				else if (verb === "RCPT") (current.to.push(/<(.*)>/.exec(line)?.[1] ?? ""), say("250 ok"));
				else if (verb === "DATA") (data = "", say("354 go on"));
				else if (verb === "QUIT") (say("221 bye"), socket.end());
				else say("500 what");
			}
		});
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	return { port, received, close: () => new Promise<void>((resolve) => (sockets.forEach((socket) => socket.destroy()), server.close(() => resolve()))) };
}
