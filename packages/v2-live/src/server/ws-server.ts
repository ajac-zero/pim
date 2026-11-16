/**
 * The Live service's network edge: an HTTP server with the WebSocket endpoint (`/live`) and the bounded
 * snapshot reads (`/snapshot/...`), both authenticated by `LiveIdentity`. It holds no state that a restart or
 * another replica could not rebuild.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { Pool } from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { CLOSE_UNAUTHORIZED } from "../contracts.ts";
import { sidebarPage, transcriptPage } from "../projections/snapshots.ts";
import type { LiveConnection, LiveHub, Transport } from "./hub.ts";

export type LiveServer = { server: Server; port: number; close(): Promise<void> };

function transportOf(socket: WebSocket): Transport {
	return {
		send: (data) => socket.send(data),
		buffered: () => socket.bufferedAmount,
		close: (code, reason) => socket.close(code, reason),
	};
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * The WebSocket endpoint and the snapshot reads of a Live service, for a host that owns the HTTP server: `upgrade` handles an upgrade request
 * for one of `paths` (anything else is not its to answer, and it says so), `snapshot` answers `/snapshot/...`. `startLiveServer` hosts them alone;
 * the `live` role hosts them with its health endpoints, and `all-in-one` beside the Gate.
 */
export function liveEndpoint(hub: LiveHub, pool: Pool, options: { paths?: readonly string[] } = {}) {
	const paths = options.paths ?? ["/live"];
	const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

	async function snapshot(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://live");
		const principal = await hub.identity.authenticate(request);
		if (!principal || !(await hub.identity.stillValid(principal))) return json(response, 401, { error: "Sign in" });
		const ownerId = principal.ownerId;
		const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
		const parts = url.pathname.split("/").filter(Boolean);
		if (request.method === "GET" && parts[0] === "snapshot" && parts[1] === "sidebar") {
			return json(response, 200, await sidebarPage(pool, ownerId, { after: url.searchParams.get("after"), ...(limit === undefined ? {} : { limit }) }));
		}
		if (request.method === "GET" && parts[0] === "snapshot" && (parts[1] === "chat" || parts[1] === "coding") && parts[2]) {
			return json(response, 200, await transcriptPage(pool, ownerId, decodeURIComponent(parts[2]), { kind: parts[1], before: url.searchParams.get("before"), ...(limit === undefined ? {} : { limit }) }));
		}
		json(response, 404, { error: "Not found" });
	}

	/** True when the request was for a Live path. */
	function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		if (!paths.includes(new URL(request.url ?? "/", "http://live").pathname)) return false;
		// The upgrade completes first, so an unauthenticated client gets the close code the app acts on.
		const principal = hub.identity.authenticate(request).catch(() => null);
		sockets.handleUpgrade(request, socket, head, (ws) => {
			// Frames that arrive while the principal is being looked up wait for it, in order.
			let connection: LiveConnection | null = null;
			const early: string[] = [];
			ws.on("message", (data, isBinary) => {
				if (isBinary) return;
				if (connection) void connection.receive(data.toString());
				else early.push(data.toString());
			});
			ws.on("close", () => connection?.close(1000, "closed"));
			ws.on("error", () => connection?.close(1011, "error"));
			void principal.then(async (who) => {
				if (!who) return ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
				if (ws.readyState !== WebSocket.OPEN) return;
				connection = hub.connect(who, transportOf(ws));
				for (const frame of early.splice(0)) await connection.receive(frame);
			});
		});
		return true;
	}

	return {
		snapshot: (request: IncomingMessage, response: ServerResponse) => snapshot(request, response).catch(() => json(response, 500, { error: "Unavailable" })),
		upgrade,
		close() {
			for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.terminate();
			sockets.close();
		},
	};
}

export async function startLiveServer(hub: LiveHub, pool: Pool, options: { port?: number; host?: string } = {}): Promise<LiveServer> {
	const live = liveEndpoint(hub, pool);
	const server = createServer((request, response) => void live.snapshot(request, response));
	server.on("upgrade", (request, socket, head) => {
		if (!live.upgrade(request, socket, head)) socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
	return {
		server,
		port: (server.address() as AddressInfo).port,
		async close() {
			live.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
