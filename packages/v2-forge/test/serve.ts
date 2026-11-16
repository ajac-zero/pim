// Serves a Fetch-API handler on a real node http server, so git and curl-like clients can talk to it.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { Handler } from "../src/http/common";

export async function serve(handler: Handler): Promise<{ url: string; stop(): Promise<void>; server: Server }> {
	const server = createServer(async (req, res) => {
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${req.url}`;
		const hasBody = req.method !== "GET" && req.method !== "HEAD";
		const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined, duplex: "half" } as RequestInit);
		const response = (await handler(request)) ?? new Response("not found", { status: 404 });
		const headers: Record<string, string> = {};
		response.headers.forEach((v, k) => (headers[k] = v));
		res.writeHead(response.status, headers);
		if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
		res.end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		server,
		stop: () => {
			server.closeAllConnections();
			return new Promise<void>((r) => server.close(() => r()));
		},
	};
}
