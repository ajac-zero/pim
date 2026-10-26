import type { ComputerLink } from "./computer";
import { HttpError } from "./http";

/**
 * A space's computer on a Cua VM, reached through a bridge its operator
 * runs (unwired: nothing in Pim calls this yet; see docs/cua-bridge.md).
 *
 * The operator keeps one persistent VM per space, where pim-computer runs
 * as the one non-root desktop user every agent of the space shares, and
 * puts a bridge in front of it: an HTTPS endpoint that takes a WebSocket
 * and carries pim-computer's own messages over it, one per text message,
 * as pim-computer does when it connects to a Pim itself. Pim doesn't
 * assume Cua's own services speak this; the bridge is what does.
 *
 * What Pim knows of the bridge (`CuaBridge`) comes only from its operator,
 * for one space, and is never stored in the space. `Cua.connect` refuses
 * before reaching the network unless the bridge is for exactly the space
 * asking, its address is HTTPS with no credentials, query or fragment, and
 * its token is well-formed; the token goes only in the Authorization
 * header. It makes one request and follows no redirect, so the token never
 * goes to another address, and the bridge must name the space back before
 * its connection is used. Nothing is tried again: a message handed to a
 * connection that then ends may or may not have reached pim-computer, and
 * only its reply says it ran.
 */

/** What the operator gives Pim to reach one space's computer. */
export type CuaBridge = {
	/** The owner whose space this computer is; any other space is refused. */
	readonly space: string;
	/** The bridge's address: HTTPS, with no credentials, query or fragment. */
	readonly url: string;
	/** The bridge's bearer token, which goes only in the Authorization header. */
	readonly token: string;
};

/** The header that names the space to the bridge, and that the bridge names it back in when it takes the connection. */
export const SPACE_HEADER = "x-pim-space";
/**
 * The most characters one message may have, either way. The largest
 * pim-computer sends in use are a 1 MiB read in base64, and DevTools
 * screenshots; anything past this ends the connection.
 */
export const MAX_MESSAGE_CHARS = 16 * 1024 * 1024;

const OWNER = /^o_[0-9a-z]{26}$/;
/** A token is printable ASCII without spaces, as a header value can carry it unchanged. */
const TOKEN = /^[\x21-\x7e]{32,4096}$/;

/** Refuses, before anything leaves, a bridge that isn't for `space` or isn't safe to send its token to; returns its address. */
function address(bridge: CuaBridge, space: string): URL {
	if (!OWNER.test(space) || bridge.space !== space) {
		throw new HttpError(403, "This computer's bridge is for another space, so Pim didn't connect to it.");
	}
	let url: URL | null = null;
	try {
		url = new URL(bridge.url);
	} catch {
		// Refused below.
	}
	// `?` and `#` are refused even when empty, so no address carries anything past its path.
	if (!url || url.protocol !== "https:" || url.username || url.password || bridge.url.includes("?") || bridge.url.includes("#")) {
		throw new HttpError(503, "This computer's bridge address must be HTTPS, with no credentials, query or fragment.");
	}
	if (!TOKEN.test(bridge.token)) throw new HttpError(503, "This computer's bridge token is missing or malformed.");
	return url;
}

export class Cua {
	readonly #bridge: CuaBridge;
	readonly #fetch: typeof fetch;

	/** `fetcher` is the Worker's `fetch`; tests give their own. */
	constructor(bridge: CuaBridge, fetcher: typeof fetch = fetch) {
		this.#bridge = bridge;
		this.#fetch = fetcher;
	}

	/**
	 * Connects to pim-computer on the space's computer through its bridge.
	 * Each message it sends goes to `receive`; `closed` is called once, when
	 * the connection ends, whoever ends it.
	 */
	async connect(space: string, receive: (message: string) => void, closed: () => void): Promise<ComputerLink> {
		const url = address(this.#bridge, space);
		let response: Response;
		try {
			response = await this.#fetch(url.href, {
				headers: { Authorization: `Bearer ${this.#bridge.token}`, Upgrade: "websocket", [SPACE_HEADER]: space },
				redirect: "manual",
			});
		} catch (error) {
			console.error(JSON.stringify({ event: "cua.unreachable", error: (error as Error).name }));
			throw new HttpError(502, "Pim couldn't reach the computer's bridge. Try again in a minute.");
		}
		const socket = response.webSocket;
		const named = response.headers.get(SPACE_HEADER) === space;
		if (response.status !== 101 || !socket || !named) {
			if (socket) {
				socket.accept();
				socket.close(1008, "Refused");
			}
			await response.body?.cancel().catch(() => undefined);
			const redirect = response.status >= 300 && response.status < 400;
			console.error(JSON.stringify({ event: "cua.refused", status: response.status, redirect, named }));
			throw new HttpError(
				502,
				redirect
					? "The computer's bridge answered with a redirect, which Pim doesn't follow."
					: socket
						? "The computer's bridge didn't name this space back, so Pim didn't use it."
						: `The computer's bridge refused the connection (${response.status}).`,
			);
		}
		socket.accept();
		let ended = false;
		const end = () => {
			if (ended) return;
			ended = true;
			closed();
		};
		/** A message pim-computer's protocol has no place for ends the connection, as what follows it can't be trusted either. */
		const refuse = (code: number, reason: string) => {
			console.error(JSON.stringify({ event: "cua.protocol", reason }));
			end();
			if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
		};
		socket.addEventListener("message", (event) => {
			if (ended) return;
			if (typeof event.data !== "string") return refuse(1003, "Only text messages");
			if (event.data.length > MAX_MESSAGE_CHARS) return refuse(1009, "Message too big");
			receive(event.data);
		});
		socket.addEventListener("close", end);
		socket.addEventListener("error", end);
		return {
			get readyState() {
				return ended ? WebSocket.CLOSED : socket.readyState;
			},
			send(message) {
				// Nothing is kept to send later: a message that can't go now throws, unsent.
				if (ended || socket.readyState !== WebSocket.OPEN) throw new Error("The computer's bridge connection has closed, so nothing was sent.");
				if (message.length > MAX_MESSAGE_CHARS) throw new Error("The message is too big for the computer's bridge, so nothing was sent.");
				socket.send(message);
			},
			close() {
				end();
				if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Let go");
			},
		};
	}
}
