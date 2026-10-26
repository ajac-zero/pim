/**
 * The relay at the heart of a Cua bridge (docs/cua-bridge.md): what an
 * operator runs in front of one space's VM so that Pim's `Cua.connect`
 * (src/cua.ts) reaches pim-computer there. Nothing in Pim imports it; it is
 * for the operator's bridge to embed.
 *
 * A `Relay` is made for exactly one space and one bearer token, and keeps
 * neither past what it needs: the space's owner ID, and a SHA-256 digest of
 * the token. For each request it checks the address, method, upgrade, token
 * and space (`check`) before anything else happens; only then does the
 * embedder hand it the connection's socket (`open`), and the relay asks the
 * embedder's `OpenSession` for a session of pim-computer, whose messages it
 * carries both ways unchanged. It makes up nothing of pim-computer's (not its
 * `hello`, nor any reply), keeps nothing to send later, and sends nothing
 * again. One connection is open at a time: a newer one ends the one before
 * it, and its session, before its own session is asked for.
 *
 * How a session is made (a `pim-computer --stdio` process as the desktop
 * user, say) is the embedder's: this file starts no process and touches no
 * file. Closing a session means only that the relay is done with it; it says
 * nothing of whether pim-computer has exited, or what else runs on the VM.
 *
 * Everything but `serveWithWebSocketPair` uses only what Node and Workers
 * both have. That function is the one adapter here, for a Workers runtime
 * (workerd), which is how the tests run it; a host that serves TLS and
 * WebSockets some other way needs its own.
 */

/** The header Pim names the space in, and that the bridge names it back in on its `101`. */
export const SPACE_HEADER = "x-pim-space";

/** The most characters one message may have, either way; Pim's own limit (`MAX_MESSAGE_CHARS` in src/cua.ts). */
export const MAX_MESSAGE_CHARS = 16 * 1024 * 1024;

/** The close code a connection gets when a newer one replaces it, as pim-computer's `REPLACED`. */
export const REPLACED = 4409;

const OWNER = /^o_[0-9a-z]{26}$/;
/** A token is printable ASCII without spaces, 32 to 4096 characters, as Pim sends it. */
const TOKEN = /^[\x21-\x7e]{32,4096}$/;
const BEARER = /^Bearer ([\x21-\x7e]{32,4096})$/;
/** An Authorization header longer than this can't hold a token, and isn't read further. */
const MAX_AUTHORIZATION = "Bearer ".length + 4096;
/** The path the bridge serves: absolute, canonical, with no query or fragment. */
const PATH = /^\/[^?#\s]*$/;

/** One session of pim-computer, which the embedder opens for each connection. */
export type Session = {
	/** Hands pim-computer one message. Throws when it can't take it whole; the relay tries nothing again. */
	send(message: string): void;
	/** Ends pim-computer's input, as Pim has let go. It doesn't show that pim-computer has exited. */
	close(): void;
};

/** What a session tells the relay. Either may be called from the moment the session is asked for. */
export type SessionEvents = {
	/** One message from pim-computer: a JSON text with no line breaks. */
	message(message: string): void;
	/** The session's transport has ended, for whatever reason. */
	closed(): void;
};

/**
 * Opens a session of pim-computer for one connection. It gets nothing of the
 * request (no token, header or address), only where to send what
 * pim-computer says, and a signal that aborts when the connection is given
 * up before the session is open. A session it returns after that is closed
 * at once, unused.
 */
export type OpenSession = (events: SessionEvents, signal: AbortSignal) => Promise<Session>;

/** The bridge's end of Pim's WebSocket, as the embedder's runtime gives it. */
export type ClientSocket = {
	send(message: string): void;
	close(code: number, reason: string): void;
};

/** One connection, as `Relay.open` gives it back to the embedder. */
export type Channel = {
	/** Whether the session opened, and the connection is still there; false means no `101` may be answered. */
	readonly ready: Promise<boolean>;
	/** Whether the connection has ended. */
	readonly ended: boolean;
	/** A message from Pim's socket: text is passed on; anything else ends the connection. */
	receive(data: unknown): void;
	/** Pim's socket has closed or failed. */
	end(): void;
};

/** What the relay logs: fixed event names and reasons, never what a request carried or what the session threw. */
export type LogEntry = { readonly event: string; readonly reason?: string; readonly status?: number };

export type RelayOptions = {
	/** The owner ID of the one space this bridge serves. */
	readonly space: string;
	/** The bearer token Pim sends; only its digest is kept. */
	readonly token: string;
	/** The path the bridge takes connections at, such as `/pim`. */
	readonly path: string;
	readonly open: OpenSession;
	/** Where the relay's log entries go; by default, `console.error` as JSON. */
	readonly log?: (entry: LogEntry) => void;
};

const encoder = new TextEncoder();

async function digest(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** Compares two SHA-256 digests in time that doesn't depend on where they differ. */
function same(a: Uint8Array, b: Uint8Array): boolean {
	let difference = a.length ^ b.length;
	for (let index = 0; index < a.length; index++) difference |= a[index]! ^ (b[index] ?? 0);
	return difference === 0;
}

function hasLineBreak(message: string): boolean {
	return message.includes("\n") || message.includes("\r");
}

export class Relay {
	readonly #space: string;
	readonly #path: string;
	readonly #digest: Promise<Uint8Array>;
	readonly #open: OpenSession;
	readonly #log: (entry: LogEntry) => void;
	/** Ends the open connection, if there is one. */
	#active: ((code: number, reason: string, why: string) => void) | null = null;

	constructor(options: RelayOptions) {
		if (!OWNER.test(options.space)) throw new Error("A bridge serves one space, named by its owner ID.");
		if (!TOKEN.test(options.token)) throw new Error("A bridge's token must be printable ASCII without spaces, 32 to 4096 characters.");
		if (!PATH.test(options.path) || new URL(options.path, "https://bridge.invalid").pathname !== options.path) {
			throw new Error("A bridge's path must be absolute and canonical, with no query or fragment.");
		}
		this.#space = options.space;
		this.#path = options.path;
		this.#digest = digest(options.token);
		this.#open = options.open;
		this.#log = options.log ?? ((entry) => console.error(JSON.stringify(entry)));
	}

	/** The space this bridge serves, which a `101` names back. */
	get space(): string {
		return this.#space;
	}

	/**
	 * Null when `request` is Pim's, for this space, at this bridge's address;
	 * otherwise the answer refusing it. Nothing else happens either way. It
	 * reads only the method, the address, and the Upgrade, Authorization and
	 * `x-pim-space` headers; a token anywhere else, such as a query or a
	 * cookie, is never read.
	 */
	async check(request: Request): Promise<Response | null> {
		const refuse = (status: number, reason: string, message: string, headers: Record<string, string> = {}) => {
			this.#log({ event: "bridge.refused", status, reason });
			return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
		};
		let path: string | null = null;
		try {
			path = new URL(request.url).pathname;
		} catch {
			// Refused below.
		}
		if (path !== this.#path || request.url.includes("?") || request.url.includes("#")) return refuse(404, "path", "Not found.");
		if (request.method !== "GET") return refuse(405, "method", "Only GET is served here.", { allow: "GET" });
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return refuse(426, "upgrade", "Only WebSocket connections are served here.", { upgrade: "websocket" });
		const authorization = request.headers.get("authorization") ?? "";
		const presented = authorization.length <= MAX_AUTHORIZATION ? BEARER.exec(authorization)?.[1] : undefined;
		if (presented === undefined || !same(await digest(presented), await this.#digest)) {
			return refuse(401, "token", "Unauthorized.", { "www-authenticate": "Bearer" });
		}
		if (request.headers.get(SPACE_HEADER) !== this.#space) return refuse(403, "space", "This bridge serves another space.");
		return null;
	}

	/**
	 * Opens a session for a connection `check` let through, ending the one
	 * before it first. What pim-computer says goes to `client` from the start,
	 * which must hold it until the embedder answers `101` (a `WebSocketPair`
	 * does); nothing Pim sends is taken before the session is open. `signal`
	 * is the request's: when it aborts before the session is open, the
	 * connection ends.
	 */
	open(client: ClientSocket, signal?: AbortSignal): Channel {
		this.#active?.(REPLACED, "Replaced", "replaced");
		const stop = new AbortController();
		let session: Session | null = null;
		let state = "opening" as "opening" | "open" | "ended";
		/** Read through a call, as the state changes across the awaits below. */
		const ended = () => state === "ended";

		const end = (code: number, reason: string, why: string) => {
			if (state === "ended") return;
			state = "ended";
			if (this.#active === end) this.#active = null;
			signal?.removeEventListener("abort", abandoned);
			stop.abort();
			this.#log({ event: "bridge.ended", reason: why });
			try {
				session?.close();
			} catch {
				// The relay is done with it all the same.
			}
			try {
				client.close(code, reason);
			} catch {
				// A socket that can't be closed has ended or will.
			}
		};
		const abandoned = () => {
			if (state === "opening") end(1001, "Gone", "abandoned");
		};
		this.#active = end;

		const fromSession = (message: string) => {
			if (state === "ended") return;
			if (typeof message !== "string" || message.length > MAX_MESSAGE_CHARS || hasLineBreak(message)) {
				return end(1011, "Session broke the protocol", "session-protocol");
			}
			try {
				client.send(message);
			} catch {
				end(1011, "Error", "client-send");
			}
		};

		if (signal?.aborted) end(1001, "Gone", "abandoned");
		else signal?.addEventListener("abort", abandoned);

		const ready = (async () => {
			if (ended()) return false;
			let opened: Session;
			try {
				opened = await this.#open({ message: fromSession, closed: () => end(1000, "Session ended", "session-closed") }, stop.signal);
			} catch {
				// What the factory threw may carry anything, so only that it failed is logged.
				end(1011, "Session failed", "session-failed");
				return false;
			}
			if (ended()) {
				try {
					opened.close();
				} catch {
					// Nothing more to do with it.
				}
				return false;
			}
			session = opened;
			state = "open";
			signal?.removeEventListener("abort", abandoned);
			this.#log({ event: "bridge.opened" });
			return true;
		})();

		return {
			ready,
			get ended() {
				return ended();
			},
			receive(data) {
				if (state === "ended") return;
				if (state === "opening") return end(1008, "Not open", "early");
				if (typeof data !== "string") return end(1003, "Only text messages", "binary");
				if (data.length > MAX_MESSAGE_CHARS) return end(1009, "Message too big", "oversized");
				if (hasLineBreak(data)) return end(1007, "Line break in message", "line-break");
				try {
					session!.send(data);
				} catch {
					// It may or may not have reached pim-computer; it isn't sent again.
					end(1011, "Session didn't take it", "session-send");
				}
			},
			end() {
				end(1000, "Closed", "client-closed");
			},
		};
	}
}

/**
 * Splits pim-computer's output, as `--stdio` writes it, into its messages,
 * one per line. Bytes that aren't UTF-8, or a line longer than a message may
 * be, throw, and the embedder must then end the session. A line not ended
 * when the output ends is no message, and is dropped. The other way, each
 * message the relay hands a session is written followed by `\n`; the relay
 * lets no message with a line break through.
 */
export class Lines {
	readonly #max: number;
	readonly #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	#pending = "";

	constructor(max = MAX_MESSAGE_CHARS) {
		this.#max = max;
	}

	/** The messages `bytes` completes. */
	push(bytes: Uint8Array): string[] {
		const lines = (this.#pending + this.#decoder.decode(bytes, { stream: true })).split("\n");
		this.#pending = lines.pop()!;
		if (this.#pending.length > this.#max || lines.some((line) => line.length > this.#max)) {
			throw new RangeError("pim-computer wrote a line longer than a message may be.");
		}
		return lines;
	}
}

/**
 * Serves one request with `relay` in a Workers runtime: refuses it as
 * `check` says, or opens a session behind a `WebSocketPair` and answers `101`
 * naming the space back, or `502` when the session didn't open. This is the
 * only runtime-specific part of this file; it adds no route anywhere.
 */
export async function serveWithWebSocketPair(relay: Relay, request: Request): Promise<Response> {
	const refusal = await relay.check(request);
	if (refusal) return refusal;
	const { 0: client, 1: server } = new WebSocketPair();
	server.accept();
	const channel = relay.open({ send: (message) => server.send(message), close: (code, reason) => server.close(code, reason) }, request.signal);
	server.addEventListener("message", (event) => channel.receive(event.data));
	server.addEventListener("close", () => channel.end());
	server.addEventListener("error", () => channel.end());
	if (!(await channel.ready) || channel.ended) {
		return new Response("The computer's session couldn't be opened.", { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
	}
	return new Response(null, { status: 101, webSocket: client, headers: { [SPACE_HEADER]: relay.space } });
}
