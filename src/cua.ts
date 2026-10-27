import type { ComputerLink } from "./computer";
import { HttpError } from "./http";

/**
 * A space's computer on a Cua VM, reached through a bridge its operator
 * runs (see docs/cua-bridge.md). A space uses it only when its operator
 * chose it (`PROVIDER_KEY`), and then no other computer.
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
 * header. It makes one request, gives up on it after `CONNECT_MS`, and
 * follows no redirect, so the token never goes to another address; the
 * bridge must name the space back before its connection is used. Nothing is tried again: a message handed to a
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

/**
 * Where a space keeps its operator's choice of computer, in its own
 * metadata (`pim_meta`). Only the operator writes it: no route, tool or
 * setting of Pim's does. `{"provider":"cua","space":"<owner>"}`, exactly,
 * makes the space's computer its Cua VM; anything else stored there can't
 * be read, and the space then uses no computer at all.
 */
export const PROVIDER_KEY = "computer_provider";

/** What a space's operator chose: its Cua VM, or something Pim can't read. */
export type Selection = "cua" | "unreadable";

/** The operator's choice, from what `PROVIDER_KEY` holds in `space`; null when it holds nothing, and the space keeps paired computers and Sprites. */
export function selection(stored: string | undefined, space: string): Selection | null {
	if (stored === undefined) return null;
	let value: unknown;
	try {
		value = JSON.parse(stored);
	} catch {
		return "unreadable";
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "unreadable";
	const { provider, space: named, ...rest } = value as Record<string, unknown>;
	return provider === "cua" && named === space && Object.keys(rest).length === 0 ? "cua" : "unreadable";
}

/**
 * `space`'s bridge, from `secret`: the Worker secret `CUA_BRIDGES`, which
 * holds every Cua space's bridge by owner,
 * `{"<owner>":{"url":"https://…","token":"…"}}`, and is the only place
 * Pim learns a bridge from. One that is missing, or that Pim can't read,
 * refuses, saying nothing of what the secret holds; `Cua.connect` checks
 * the address and token further.
 */
export function bridgeFor(secret: unknown, space: string): CuaBridge {
	let entry: unknown;
	try {
		const bridges: unknown = typeof secret === "string" ? JSON.parse(secret) : null;
		if (typeof bridges === "object" && bridges !== null && Object.hasOwn(bridges, space)) entry = (bridges as Record<string, unknown>)[space];
	} catch {
		// Refused below.
	}
	const { url, token, ...rest } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
	if (typeof url !== "string" || typeof token !== "string" || Object.keys(rest).length > 0) {
		console.error(JSON.stringify({ event: "cua.unconfigured" }));
		throw new HttpError(503, "This Pim has no usable bridge for this space's Cua computer, so nothing was sent to it. Its operator must set one up.");
	}
	return { space, url, token };
}

/** The header that names the space to the bridge, and that the bridge names it back in when it takes the connection. */
export const SPACE_HEADER = "x-pim-space";
/**
 * The most characters one message may have, either way. The largest
 * pim-computer sends in use are a 1 MiB read in base64, and DevTools
 * screenshots; anything past this ends the connection.
 */
export const MAX_MESSAGE_CHARS = 16 * 1024 * 1024;
/** How long the bridge has to take the connection; past it, Pim gives up on it, and doesn't try again. */
export const CONNECT_MS = 30_000;

const OWNER = /^o_[0-9a-z]{26}$/;
/** A token is printable ASCII without spaces, as a header value can carry it unchanged. */
const TOKEN = /^[\x21-\x7e]{32,4096}$/;

/**
 * Refuses, before anything leaves, a bridge that isn't for `space` or isn't
 * safe to send its token to; returns its address. The viewer's client
 * (./cua-viewer.ts) checks a bridge with it too.
 */
export function bridgeAddress(bridge: CuaBridge, space: string): URL {
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

/** Closes a socket that may still be open; one whose close throws is left to end by itself, as the link has ended all the same. */
function shut(socket: WebSocket, code: number, reason: string): void {
	try {
		if (socket.readyState !== WebSocket.CLOSED) socket.close(code, reason);
	} catch {
		// Nothing more can be done for it here.
	}
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
		const url = bridgeAddress(this.#bridge, space);
		const giveUp = new AbortController();
		const timer = setTimeout(() => giveUp.abort(), CONNECT_MS);
		const late = new HttpError(504, `The computer's bridge didn't answer within ${CONNECT_MS / 1000} seconds.`);
		let response: Response;
		try {
			response = await this.#fetch(url.href, {
				headers: { Authorization: `Bearer ${this.#bridge.token}`, Upgrade: "websocket", [SPACE_HEADER]: space },
				redirect: "manual",
				signal: giveUp.signal,
			});
		} catch {
			// What was thrown came from the fetcher and may carry anything, the token included, so only what happened is logged.
			console.error(JSON.stringify({ event: giveUp.signal.aborted ? "cua.timeout" : "cua.unreachable" }));
			throw giveUp.signal.aborted ? late : new HttpError(502, "Pim couldn't reach the computer's bridge. Try again in a minute.");
		} finally {
			clearTimeout(timer);
		}
		const socket = response.webSocket;
		const named = response.headers.get(SPACE_HEADER) === space;
		// An answer after Pim gave up on it is not used, whatever it is.
		const timedOut = giveUp.signal.aborted;
		if (timedOut || response.status !== 101 || !socket || !named) {
			if (socket) {
				try {
					socket.accept();
				} catch {
					// It is closed below if it can be.
				}
				shut(socket, 1008, "Refused");
			}
			await response.body?.cancel().catch(() => undefined);
			const redirect = response.status >= 300 && response.status < 400;
			console.error(JSON.stringify(timedOut ? { event: "cua.timeout" } : { event: "cua.refused", status: response.status, redirect, named }));
			if (timedOut) throw late;
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
			shut(socket, code, reason);
		};
		socket.addEventListener("message", (event) => {
			if (ended) return;
			if (typeof event.data !== "string") return refuse(1003, "Only text messages");
			if (event.data.length > MAX_MESSAGE_CHARS) return refuse(1009, "Message too big");
			receive(event.data);
		});
		socket.addEventListener("close", end);
		// An error ends the link, and its socket is closed if it can be. Neither says what the computer did, or stopped doing.
		socket.addEventListener("error", () => {
			end();
			shut(socket, 1011, "Error");
		});
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
				shut(socket, 1000, "Let go");
			},
		};
	}
}
