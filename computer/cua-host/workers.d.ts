/**
 * The Workers globals that `serveWithWebSocketPair` in ../cua-bridge.ts
 * names, declared only so that file typechecks here, beside Node's types.
 * The host never calls that function, and Node has none of these. The
 * tsconfig takes the DOM's lib so that Node's types defer to its fetch
 * types, whose `ResponseInit` can be extended here; undici's can't.
 */

interface WorkersWebSocket {
	accept(): void;
	send(message: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	addEventListener(type: "close" | "error", listener: () => void): void;
}

declare class WebSocketPair {
	0: WorkersWebSocket;
	1: WorkersWebSocket;
}

interface ResponseInit {
	webSocket?: WorkersWebSocket;
}
