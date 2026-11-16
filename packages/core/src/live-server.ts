import type { IncomingMessage, Server } from "node:http";
import type pg from "pg";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticate, tenantOfToken } from "./auth.ts";
import { LiveHub, LiveSession, ownerMayRead, StreamSource } from "./live.ts";
import type { Metrics } from "./metrics.ts";

export interface LiveServerDeps {
	pool: pg.Pool;
	metrics?: Metrics;
	pollMs?: number;
	maxConnections?: number;
	/** Bytes the socket may hold unsent before its subscriptions stop advancing. */
	highWaterBytes?: number;
}

/**
 * Attaches the Live WebSocket to an HTTP server. A connection authenticates with its first message
 * (`{type:"auth",token}`) and then subscribes by stream and cursor. Live holds no state worth keeping: restart it and
 * clients reconnect with their cursors.
 */
export function attachLive(server: Server, deps: LiveServerDeps): { hub: LiveHub; close(): void; connections(): number } {
	const source = new StreamSource(deps.pool);
	const hub = new LiveHub(source, deps.pollMs ?? 250);
	const wss = new WebSocketServer({ server, path: "/live", maxPayload: 16_384 });
	hub.start();
	wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
		if (wss.clients.size > (deps.maxConnections ?? 5000)) return socket.close(1013, "busy");
		deps.metrics?.inc("pim_live_connections_total");
		let session: LiveSession | undefined;
		const authTimer = setTimeout(() => session ?? socket.close(4401, "auth timeout"), 5000);
		socket.on("message", async (raw) => {
			try {
				const msg = JSON.parse(String(raw)) as { type: string; token?: string; stream?: string; cursor?: number };
				if (msg.type === "auth" && !session) {
					const tenantId = msg.token ? tenantOfToken(msg.token) : undefined;
					const principal = tenantId && msg.token ? await authenticate(deps.pool, tenantId, msg.token) : undefined;
					if (!principal) return socket.close(4401, "unauthorized");
					clearTimeout(authTimer);
					session = new LiveSession(source, principal, (m) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m)), { mayRead: ownerMayRead, backpressured: () => socket.bufferedAmount > (deps.highWaterBytes ?? 1_048_576) });
					hub.sessions.add(session);
					return;
				}
				if (!session) return socket.close(4401, "unauthorized");
				if (msg.type === "subscribe" && typeof msg.stream === "string") await session.subscribe(msg.stream, typeof msg.cursor === "number" ? msg.cursor : undefined);
				else if (msg.type === "unsubscribe" && typeof msg.stream === "string") session.unsubscribe(msg.stream);
			} catch {
				socket.close(4400, "bad message");
			}
		});
		socket.on("close", () => {
			clearTimeout(authTimer);
			if (session) {
				session.close();
				hub.sessions.delete(session);
			}
		});
	});
	deps.metrics?.gauge("pim_live_sockets", "Open Live sockets", () => wss.clients.size);
	deps.metrics?.gauge("pim_live_subscriptions", "Live subscriptions", () => [...hub.sessions].reduce((n, s) => n + s.subs.size, 0));
	return { hub, close: () => (hub.stop(), wss.close()), connections: () => wss.clients.size };
}
