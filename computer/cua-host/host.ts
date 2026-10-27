/**
 * The Node host of a Cua bridge (docs/cua-bridge.md): serves one `Relay`
 * (computer/cua-bridge.ts) over HTTPS and WebSockets, so Pim's `Cua.connect`
 * can reach it over the network. The relay keeps the bridge's contract (the
 * token, the space, one connection at a time, what is held while a session
 * opens, what ends a connection); this file only carries requests and
 * sockets to it and back, and bounds what the network can make it hold.
 *
 * For each upgrade request, in order: the target must be a canonical path
 * and the headers the relay reads must each appear at most once; then
 * `relay.check` must let it through; then `ws` checks the handshake itself
 * (its key and version); only then is `relay.open` asked for a session, and
 * `101`, naming the space back in `x-pim-space`, is answered once the
 * relay's channel is ready. Nothing of the request reaches the session, and
 * no answer is a redirect or repeats what the request carried.
 *
 * It serves HTTPS with the operator's certificate and key, or, only when
 * asked by name and only on a loopback address, plain HTTP behind a TLS
 * terminator the operator runs on the same machine. It starts no process
 * and opens no session itself: the relay's `OpenSession` is the embedder's.
 * Importing it does nothing; `createHost(...).listen()` serves.
 */

import { Buffer } from "node:buffer";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { type Duplex, Readable, pipeline } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { type ServerOptions, WebSocketServer, type WebSocket } from "ws";
import { type Channel, type ClientSocket, type LogEntry, MAX_MESSAGE_CHARS, type Relay, SPACE_HEADER } from "../cua-bridge.ts";
import type { MediaSocket, ViewerAdapter } from "./viewer-adapter.ts";
import type { KeyRequest, LaunchRequestKey, ViewerLaunchManager } from "./viewer-launch-manager.ts";

/** The most bytes a request's line and headers may take. Pim's are a few hundred, with a token of at most 4096. */
export const MAX_HEADER_BYTES = 16 * 1024;

/** The most bytes one WebSocket message from Pim may take: `MAX_MESSAGE_CHARS` of UTF-16, at three bytes each at most. */
export const MAX_PAYLOAD_BYTES = 3 * MAX_MESSAGE_CHARS;

/**
 * What each message held for Pim counts beyond its bytes, for what holding
 * it costs: its entry in a queue, its frame's header and the socket's record
 * of the write. Even an empty message counts this much.
 */
export const MESSAGE_OVERHEAD_BYTES = 256;

/** How the host is reached. */
export type Transport =
	/** HTTPS with the operator's certificate chain and private key (PEM), on any address. */
	| { readonly kind: "https"; readonly cert: string | Buffer; readonly key: string | Buffer; readonly host: string; readonly port: number }
	/**
	 * Plain HTTP for a TLS terminator on the same machine, which alone faces
	 * the network. Only a loopback address written as an IP literal is taken
	 * (`127.0.0.0/8` or `::1`, IPv4-mapped or not; never a name such as
	 * `localhost`), and the address the server actually listens on is checked
	 * again.
	 */
	| { readonly kind: "loopback-http"; readonly host: string; readonly port: number };

export type Limits = {
	/** Upgrade requests being checked or waiting for their session at once; past it, `503`. */
	readonly maxPendingUpgrades: number;
	/** Sockets the server keeps at once, in any state; past it, new ones are dropped. */
	readonly maxConnections: number;
	/** How long a connection has for its TLS handshake and its request's headers. */
	readonly headersMs: number;
	/** How long an upgrade request has, from its headers, for its session to open; past it, `504`. */
	readonly openingMs: number;
	/** How long a closing socket has to finish closing before it is destroyed. */
	readonly closeMs: number;
	/**
	 * The most held for Pim and not yet handed to the network: what the
	 * session says before `101`, and after it what the socket hasn't sent.
	 * Each message counts its UTF-8 bytes and `MESSAGE_OVERHEAD_BYTES`, so
	 * this bounds how many are held too. A message that would pass it ends
	 * the connection; nothing waits for Pim to read, as a session can't be
	 * slowed down.
	 */
	readonly maxOutboundBytes: number;
};

export const DEFAULT_LIMITS: Limits = {
	maxPendingUpgrades: 4,
	maxConnections: 16,
	headersMs: 10_000,
	// Below Pim's own 30 seconds (`CONNECT_MS` in src/cua.ts), so the host gives up first and says so.
	openingMs: 20_000,
	closeMs: 5_000,
	// One largest message, at three bytes a character, fits with room to spare.
	maxOutboundBytes: 64 * 1024 * 1024,
};

/**
 * What the host routes to for a viewer (./viewer-host.ts), when it is given
 * one; without it the host serves the relay alone, as it always has.
 *
 * - `POST <relay path>/observations/launch|end|status` is the management
 *   API: Pim's, with the relay's own bearer token and space (`Relay.authorize`),
 *   a JSON body of at most `MAX_MANAGEMENT_BYTES`, and an `owner` that is the
 *   bridge's space. Each calls the manager and answers its answer as JSON.
 * - `/<launch>/…` is the adapter's: its files, its gRPC-Web calls and its
 *   media socket. These carry no bridge token. The adapter's own capability
 *   admits them (the launch's credential in `x-cua-env-authorization`, the
 *   attach token in the media target), and Pim's Worker, which checks the
 *   person's session first, is the only thing meant to reach them. A browser
 *   never holds the bridge token.
 */
export type ViewerRoutes = {
	readonly manager: Pick<ViewerLaunchManager, "launch" | "end" | "status">;
	readonly adapter: Pick<ViewerAdapter, "fetch" | "media">;
	/**
	 * The one exact HTTPS origin the viewer is served from and a browser
	 * connects to: the bridge's own public address, which is **not** spacesd's
	 * origin. A browser's media socket must carry exactly this `Origin`, and
	 * any other adapter request that carries an `Origin` must too. Without a
	 * match the media socket is refused (`403`), so an absent `Origin` fails
	 * closed there. No CORS header is ever sent: the viewer calls its own
	 * origin, and a cross-origin call fails at its preflight.
	 */
	readonly publicOrigin: string;
	/** The one exact HTTPS origin of the Pim app that may frame the viewer, if embedding is chosen; otherwise no one may (`frame-ancestors 'none'`). */
	readonly embedOrigin?: string;
};

/** One DNS label: letters, digits and inner hyphens, at most 63 characters. A `*` is not a letter or a digit. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether `hostname`, as a URL writes it, is a DNS name of well-formed labels, an IPv4 address, or a bracketed IPv6 address. No wildcard, empty label or trailing dot. */
function wellFormedHost(hostname: string): boolean {
	if (hostname.startsWith("[")) return hostname.endsWith("]") && net.isIPv6(hostname.slice(1, -1));
	if (net.isIPv4(hostname)) return true;
	return hostname.length <= 253 && hostname.split(".").every((label) => LABEL.test(label));
}

/**
 * Whether `value` is exactly an `https://host[:port]` origin, as a browser
 * writes it in `Origin`: nothing after the port (no path, query, fragment or
 * credentials), no default port written out (`:443`), no uppercase or other
 * form a browser wouldn't send, and a host that is a well-formed DNS name or
 * an IP address, never a wildcard. The URL parser accepts a `*` host, so the
 * host is checked on its own.
 */
export function isHttpsOrigin(value: unknown): value is string {
	if (typeof value !== "string") return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return url.protocol === "https:" && url.origin === value && !url.username && !url.password && wellFormedHost(url.hostname);
}

/** Whether a browser's `Origin` header (every occurrence of it) is exactly `publicOrigin`; absent, repeated or different is no. */
export function originAllowed(values: readonly string[] | undefined, publicOrigin: string): boolean {
	return values !== undefined && values.length === 1 && values[0] === publicOrigin;
}

/**
 * What the host adds to every adapter response beside the adapter's own
 * headers (its content security policy for the page, `nosniff` and
 * no-referrer stay): who may frame it, exactly one origin or no one, and a
 * permissions policy with no clipboard, microphone, camera or screen capture.
 * A second `content-security-policy` header is enforced beside the first.
 */
export function viewerHeaders(embedOrigin: string | undefined): [string, string][] {
	return [
		["content-security-policy", `frame-ancestors ${embedOrigin ?? "'none'"}`],
		["permissions-policy", "clipboard-read=(), clipboard-write=(), microphone=(), camera=(), display-capture=(), geolocation=()"],
	];
}

/** The most bytes a management request's body may take. */
export const MAX_MANAGEMENT_BYTES = 4096;

const MANAGEMENT_ACTIONS = ["launch", "end", "status"] as const;
/** What the adapter serves: `/<22 characters>/…`, and for a media socket exactly `media?ticket=<43 characters>`. */
const ADAPTER_TARGET = /^\/[A-Za-z0-9_-]{22}\//;
const MEDIA_TARGET = /^\/[A-Za-z0-9_-]{22}\/media\?ticket=[A-Za-z0-9_-]{43}$/;
/** The headers the adapter reads from a request: all it is handed, each at most once. It refuses `authorization` itself. */
const ADAPTER_HEADERS = ["content-type", "content-length", "content-encoding", "grpc-encoding", "x-cua-env-authorization", "authorization"] as const;
/** What a browser's media socket may send: a keyframe request or a frame ack, at most 1 KiB, with room to spare. */
const MEDIA_UP_BYTES = 4096;

export type HostOptions = {
	readonly relay: Relay;
	readonly viewer?: ViewerRoutes;
	readonly transport: Transport;
	readonly limits?: Partial<Limits>;
	/** Where the host's own log entries go (the relay has its own); by default, `console.error` as JSON. */
	readonly log?: (entry: LogEntry) => void;
};

export type Host = {
	/** Starts serving, and answers where. */
	listen(): Promise<{ address: string; port: number }>;
	/** Stops serving and ends every connection, open or opening, which closes its session. */
	close(): Promise<void>;
};

/** The headers `relay.check` reads, which must each come at most once. */
const READ_HEADERS = ["upgrade", "authorization", SPACE_HEADER] as const;
const ORIGIN = "https://bridge.invalid";
const PLAIN = "text/plain; charset=utf-8";

const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

function isLoopback(address: string): boolean {
	const family = net.isIP(address);
	return family === 4 ? loopback.check(address, "ipv4") : family === 6 ? loopback.check(address, "ipv6") : false;
}

/** A refusal the host makes itself, before or beside the relay's. */
type Refusal = { status: number; headers: [string, string][]; body: string };

const refusal = (status: number, body: string, headers: [string, string][] = []): Refusal => ({ status, headers: [["content-type", PLAIN], ...headers], body });

async function fromResponse(response: Response): Promise<Refusal> {
	return { status: response.status, headers: [...response.headers], body: await response.text() };
}

/** `target` when it is a canonical path (which `URL` would not normalize), or `null`. */
function canonical(target: string | undefined): string | null {
	if (target === undefined || !target.startsWith("/")) return null;
	try {
		return new URL(target, ORIGIN).href === ORIGIN + target ? target : null;
	} catch {
		return null;
	}
}

/**
 * The `Request` the relay checks, made from only what it reads; or the
 * host's refusal when the target isn't a canonical path (which `URL` would
 * otherwise normalize, so `/a/../pim` isn't taken for `/pim`), or a header
 * it reads comes more than once, or the request can't be made at all.
 */
function toRequest(req: http.IncomingMessage): Request | { refused: Refusal; reason: string } {
	const target = req.url ?? "";
	let canonical = false;
	try {
		canonical = target.startsWith("/") && new URL(target, ORIGIN).href === ORIGIN + target;
	} catch {
		// Refused below.
	}
	if (!canonical) return { refused: refusal(404, "Not found."), reason: "target" };
	const headers = new Headers();
	for (const name of READ_HEADERS) {
		const values = req.headersDistinct[name];
		if (!values) continue;
		if (values.length !== 1) return { refused: refusal(400, "Bad request."), reason: "headers" };
		try {
			headers.set(name, values[0]!);
		} catch {
			return { refused: refusal(400, "Bad request."), reason: "headers" };
		}
	}
	try {
		return new Request(ORIGIN + target, { method: req.method ?? "", headers });
	} catch {
		// A method `Request` won't make, such as TRACE.
		return { refused: refusal(400, "Bad request."), reason: "method" };
	}
}

/** Answers on a socket the HTTP server has let go of, then ends it, destroying it if that doesn't finish in time. */
function answerRaw(socket: Duplex, answer: Refusal, closeMs: number): void {
	const lines = [`HTTP/1.1 ${answer.status} ${http.STATUS_CODES[answer.status] ?? ""}`];
	for (const [name, value] of answer.headers) lines.push(`${name}: ${value}`);
	lines.push("connection: close", `content-length: ${Buffer.byteLength(answer.body)}`, "", answer.body);
	socket.end(lines.join("\r\n"));
	setTimeout(() => socket.destroy(), closeMs).unref();
}

/**
 * The relay's client socket for one connection. Before `101` it holds what
 * the session says (the relay's channel is ready only after the session
 * opened, and the socket exists only after `101`), and after it writes to
 * the WebSocket. Each message is charged its UTF-8 bytes and
 * `MESSAGE_OVERHEAD_BYTES` from when it is taken until the socket has
 * handed it to the network, so many small or empty messages cost what
 * holding them does. Rather than hold more than `maxOutboundBytes`, it
 * throws, which the relay takes as the connection failing.
 */
class Outbound implements ClientSocket {
	readonly #max: number;
	#held: { message: string; charge: number }[] = [];
	/** What every message held, or written and not yet handed to the network, is charged. */
	#charged = 0;
	#socket: WebSocket | null = null;
	#closed = false;
	#overflowed = false;

	constructor(max: number) {
		this.#max = max;
	}

	send(message: string): void {
		if (this.#closed) throw new Error("The connection has ended.");
		const charge = Buffer.byteLength(message) + MESSAGE_OVERHEAD_BYTES;
		if (this.#charged + charge > this.#max) {
			this.#overflowed = true;
			throw new Error("Pim isn't reading what it is sent.");
		}
		this.#charged += charge;
		if (this.#socket) this.#write(this.#socket, message, charge);
		else this.#held.push({ message, charge });
	}

	close(code: number, reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#held = [];
		// A socket too full to take more won't take a close frame either.
		if (this.#overflowed) this.#socket?.terminate();
		else this.#socket?.close(code, reason);
	}

	/** Takes the socket `101` made, and sends it what was held, in order. */
	attach(socket: WebSocket): void {
		this.#socket = socket;
		const held = this.#held;
		this.#held = [];
		for (const { message, charge } of held) this.#write(socket, message, charge);
	}

	/** `ws` calls back once the socket has handed the message on, or failed to, which ends the charge either way. */
	#write(socket: WebSocket, message: string, charge: number): void {
		socket.send(message, () => {
			this.#charged -= charge;
		});
	}
}

/** What the host knows of an upgrade request while it is checked and its session opens. */
type Opening = {
	readonly socket: Duplex;
	readonly abort: AbortController;
	readonly outbound: Outbound;
	channel: Channel | null;
	timedOut: boolean;
	/** Stops watching the socket for the request's sake: it is answered, or upgraded. */
	settle(): void;
};

export function createHost(options: HostOptions): Host {
	const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`A host's ${name} must be a positive whole number.`);
	}
	const { relay, transport } = options;
	if (!Number.isSafeInteger(transport.port) || transport.port < 0 || transport.port > 65_535) throw new RangeError("A host's port must be from 0 to 65535.");
	if (transport.kind === "loopback-http") {
		if (!isLoopback(transport.host)) throw new Error("Plain HTTP is served only on a loopback address, written as one (127.0.0.1 or ::1).");
	} else if (transport.kind !== "https") {
		throw new Error("A host serves HTTPS, or plain HTTP on a loopback address.");
	}
	const log = options.log ?? ((entry: LogEntry) => console.error(JSON.stringify(entry)));
	const viewer = options.viewer;
	const managementPrefix = `${relay.path}/observations/`;
	if (viewer && ADAPTER_TARGET.test(`${relay.path}/`)) throw new Error("A bridge's path can't look like a viewer launch's.");
	if (viewer && (!isHttpsOrigin(viewer.publicOrigin) || (viewer.embedOrigin !== undefined && !isHttpsOrigin(viewer.embedOrigin)))) {
		throw new Error("A viewer's public and embedding origins must each be exactly an https origin.");
	}
	const extraHeaders = viewer ? viewerHeaders(viewer.embedOrigin) : [];

	const serverOptions: http.ServerOptions = {
		maxHeaderSize: MAX_HEADER_BYTES,
		headersTimeout: limits.headersMs,
		requestTimeout: limits.headersMs,
		keepAliveTimeout: 1_000,
		connectionsCheckingInterval: Math.min(1_000, limits.headersMs),
	};
	const server: http.Server =
		transport.kind === "https"
			? https.createServer({
					...serverOptions,
					cert: transport.cert,
					key: transport.key,
					minVersion: "TLSv1.2",
					ALPNProtocols: ["http/1.1"],
					handshakeTimeout: limits.headersMs,
				})
			: http.createServer(serverOptions);
	server.maxConnections = limits.maxConnections;

	/** Every socket the server has, TCP and (for HTTPS) TLS, so `close` can end them all, upgraded or not. */
	const sockets = new Set<Duplex>();
	const track = (socket: net.Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	};
	server.on("connection", track);
	server.on("secureConnection", track);

	const openings = new WeakMap<http.IncomingMessage, Opening>();
	let pending = 0;

	// `closeTimeout` is ws's, though its types don't name it: how long a closing handshake may take.
	const wssOptions: ServerOptions & { closeTimeout: number } = {
		noServer: true,
		clientTracking: false,
		perMessageDeflate: false,
		maxPayload: MAX_PAYLOAD_BYTES,
		closeTimeout: limits.closeMs,
		// After `relay.check` and ws's own handshake checks: the one place a session is asked for.
		verifyClient: (info: { req: http.IncomingMessage }, accept: (verified: boolean) => void) => {
			const opening = openings.get(info.req);
			if (!opening || opening.abort.signal.aborted) return;
			void openSession(opening, () => accept(true));
		},
	};
	const wss = new WebSocketServer(wssOptions);
	wss.on("headers", (headers: string[]) => {
		headers.push(`${SPACE_HEADER}: ${relay.space}`);
	});

	/** The browser's media sockets, for the adapter's relays: `rcdp.v2` only, and only small messages up. */
	const mediaOptions: ServerOptions & { closeTimeout: number } = {
		noServer: true,
		clientTracking: false,
		perMessageDeflate: false,
		maxPayload: MEDIA_UP_BYTES,
		closeTimeout: limits.closeMs,
		handleProtocols: (protocols: Set<string>) => (protocols.has("rcdp.v2") ? "rcdp.v2" : false),
	};
	const mediaWss = new WebSocketServer(mediaOptions);

	async function openSession(opening: Opening, upgrade: () => void): Promise<void> {
		const channel = relay.open(opening.outbound, opening.abort.signal);
		opening.channel = channel;
		const opened = await channel.ready;
		if (!opened || channel.ended || opening.socket.destroyed) {
			if (opening.socket.destroyed) return;
			opening.settle();
			const status = opening.timedOut ? 504 : 502;
			log({ event: "host.refused", status, reason: opening.timedOut ? "opening-timeout" : "session" });
			answerRaw(opening.socket, refusal(status, "The computer's session couldn't be opened."), limits.closeMs);
			return;
		}
		opening.settle();
		// `ws` answers `101` and hands over the socket synchronously, so nothing happens in between.
		upgrade();
	}

	/** A request that isn't an upgrade as HTTP has it: never served, but refused as the relay would refuse it, or `426`. */
	async function plainRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		res.shouldKeepAlive = false;
		const request = toRequest(req);
		let answer: Refusal;
		if (request instanceof Request) {
			const refused = await relay.check(request);
			if (refused) {
				answer = await fromResponse(refused);
			} else {
				// Let through by the relay, but not an upgrade as HTTP has it (no `Connection: upgrade`).
				log({ event: "host.refused", status: 426, reason: "upgrade" });
				answer = refusal(426, "Only WebSocket connections are served here.", [["upgrade", "websocket"]]);
			}
		} else {
			log({ event: "host.refused", status: request.refused.status, reason: request.reason });
			answer = request.refused;
		}
		res.writeHead(answer.status, [...answer.headers.flat(), "connection", "close"]);
		res.end(answer.body);
	}

	/** Answers with `answer`, and `extra` headers beside its own; the viewer's routes pass their policy here, so a refusal carries it too. */
	const reply = (res: http.ServerResponse, answer: Refusal, extra: [string, string][] = []) => {
		res.writeHead(answer.status, [...answer.headers.flat(), ...extra.flat(), "connection", "close"]);
		res.end(answer.body);
	};

	/** A management request: Pim's, authenticated before its body is read, and for this bridge's space. */
	async function manage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		res.shouldKeepAlive = false;
		const target = canonical(req.url);
		const action = target === null || target.includes("?") ? undefined : MANAGEMENT_ACTIONS.find((name) => target === managementPrefix + name);
		if (action === undefined) return reply(res, refusal(404, "Not found."));
		if (req.method !== "POST") return reply(res, refusal(405, "Only POST is served here.", [["allow", "POST"]]));
		const request = toRequest(req);
		if (!(request instanceof Request)) {
			log({ event: "host.refused", status: request.refused.status, reason: request.reason });
			return reply(res, request.refused);
		}
		/** The client has gone: its connection is destroyed or ended unanswered. Nothing is asked of the manager for it. */
		const lost = () => res.destroyed || req.socket?.destroyed !== false;
		// Before the body is read, as `check` is before anything: the bearer token and the space, not an upgrade.
		const refused = await relay.authorize(request);
		if (lost()) return void res.destroy();
		if (refused) return reply(res, await fromResponse(refused));
		if (req.headers["content-type"] !== "application/json" || req.headers["content-encoding"] !== undefined) return reply(res, refusal(415, "Send application/json."));
		const length = req.headers["content-length"];
		if (length !== undefined && !(Number(length) <= MAX_MANAGEMENT_BYTES)) return reply(res, refusal(413, "Too large."));
		const chunks: Buffer[] = [];
		let size = 0;
		// A body that is slow or never ends is cut off here, not left to the server's own, longer timeout.
		const slow = setTimeout(() => req.destroy(), limits.headersMs);
		try {
			for await (const chunk of req as AsyncIterable<Buffer>) {
				size += chunk.length;
				if (size > MAX_MANAGEMENT_BYTES) return reply(res, refusal(413, "Too large."));
				chunks.push(chunk);
			}
		} catch {
			// The client went, or the body was cut off: nothing was asked of the manager.
			return void res.destroy();
		} finally {
			clearTimeout(slow);
		}
		if (lost() || !req.complete) return void res.destroy();
		let body: unknown;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return reply(res, refusal(400, "Bad request."));
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) return reply(res, refusal(400, "Bad request."));
		// One bridge serves one space: a request for another owner is refused here, never passed to the manager.
		if ((body as { owner?: unknown }).owner !== relay.space) return reply(res, refusal(403, "This bridge serves another space."));
		// Read last, right before the manager is asked: a client seen gone by now starts nothing.
		if (lost()) return void res.destroy();
		let answer: unknown;
		try {
			answer = action === "launch" ? await viewer!.manager.launch(body as LaunchRequestKey) : action === "end" ? await viewer!.manager.end(body as KeyRequest) : await viewer!.manager.status(body as KeyRequest);
		} catch {
			// The manager is not taking calls (the viewer is shutting down, or it failed): nothing is said of why, and the caller may ask again later.
			log({ event: "host.refused", status: 503, reason: "viewer" });
			return reply(res, refusal(503, "The viewer isn't taking requests.", [["retry-after", "5"]]));
		}
		log({ event: "host.managed", reason: action, status: 200 });
		// A launch's answer holds the viewer path, whose fragment is the launch's credential: it goes to this caller only.
		reply(res, { status: 200, headers: [["content-type", "application/json"], ["cache-control", "no-store"]], body: JSON.stringify(answer) });
	}

	/** An adapter request: rebuilt from only the headers it reads, and streamed back, which ends when the client does. */
	async function adapterRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		res.shouldKeepAlive = false;
		/** Every HTTP answer on a viewer route, refusals included, carries the viewer's framing and permissions policy. */
		const answer = (refused: Refusal) => reply(res, refused, extraHeaders);
		const target = canonical(req.url);
		if (target === null) return answer(refusal(404, "Not found."));
		if (req.method !== "GET" && req.method !== "POST") return answer(refusal(405, "Not allowed.", [["allow", "GET, POST"]]));
		// The viewer calls its own origin, so a browser's `Origin`, when it sends one, is the public origin; any other is refused, and no CORS answer is ever given.
		if (req.headersDistinct.origin !== undefined && !originAllowed(req.headersDistinct.origin, viewer!.publicOrigin)) {
			log({ event: "host.refused", status: 403, reason: "origin" });
			return answer(refusal(403, "Refused."));
		}
		const headers = new Headers();
		for (const name of ADAPTER_HEADERS) {
			const values = req.headersDistinct[name];
			if (!values) continue;
			try {
				if (values.length !== 1) throw new Error("repeated");
				headers.set(name, values[0]!);
			} catch {
				return answer(refusal(400, "Bad request."));
			}
		}
		const abort = new AbortController();
		res.once("close", () => abort.abort());
		let request: Request;
		try {
			const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, signal: abort.signal };
			if (req.method === "POST") {
				init.body = Readable.toWeb(req) as unknown as ReadableStream;
				init.duplex = "half";
			}
			request = new Request(ORIGIN + target, init);
		} catch {
			return answer(refusal(400, "Bad request."));
		}
		const response = await viewer!.adapter.fetch(request);
		res.writeHead(response.status, [...[...response.headers].flat(), ...extraHeaders.flat()]);
		if (!response.body) return void res.end();
		// A presence stream is long; when the client goes, the pipeline ends and cancels the adapter's body.
		pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), res, () => undefined);
	}

	server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
		const target = req.url ?? "";
		const handle = viewer && target.startsWith(managementPrefix) ? manage(req, res) : viewer && ADAPTER_TARGET.test(target) ? adapterRequest(req, res) : plainRequest(req, res);
		handle.catch(() => {
			log({ event: "host.failed" });
			res.destroy();
		});
	});

	/**
	 * A browser's media socket, through the adapter: the adapter checks the
	 * target and offered protocols, and `attach` checks them again and then
	 * calls `open`, which completes the upgrade. When `attach` refuses, no
	 * upgrade happened and the refusal is answered instead. Nothing of the
	 * request but its target and its offered subprotocols reaches the adapter,
	 * and the target, which carries an attach token, is never logged.
	 */
	function viewerMedia(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
		const refuse = (status: number, reason: string) => {
			log({ event: "host.refused", status, reason });
			answerRaw(socket, refusal(status, "Refused."), limits.closeMs);
		};
		if (head.length > 0) return socket.destroy();
		const target = canonical(req.url);
		const key = req.headers["sec-websocket-key"];
		const offered = req.headersDistinct["sec-websocket-protocol"] ?? [];
		if (
			target === null ||
			req.method !== "GET" ||
			req.headers.upgrade?.toLowerCase() !== "websocket" ||
			req.headers["sec-websocket-version"] !== "13" ||
			typeof key !== "string" ||
			!/^[A-Za-z0-9+/]{22}==$/.test(key) ||
			offered.length > 1
		) {
			return refuse(target === null ? 404 : 400, "handshake");
		}
		// A browser's media socket must come from the viewer's own origin; absent, repeated or different fails closed, before the adapter learns the token.
		if (!originAllowed(req.headersDistinct.origin, viewer!.publicOrigin)) return refuse(403, "origin");
		const result = viewer!.adapter.media(target, (offered[0] ?? "").split(",").map((protocol) => protocol.trim()).filter((protocol) => protocol !== ""));
		if (result.status !== 101) return refuse(result.status, "media");
		const status = result.attach((events) => {
			let made: WebSocket | undefined;
			// `ws` answers `101` and hands over the socket synchronously, once the handshake it can't refuse (checked above) is done.
			mediaWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
				made = ws;
			});
			if (!made) throw new Error("The upgrade wasn't completed.");
			const ws: WebSocket = made;
			if (socket instanceof net.Socket) socket.setKeepAlive(true, 30_000);
			ws.on("message", (data: Buffer, isBinary: boolean) => events.message(isBinary ? new Uint8Array(data.buffer, data.byteOffset, data.length) : data.toString("utf8")));
			ws.on("close", (code: number) => events.closed(code));
			ws.on("error", () => {
				// `ws` closes the socket after an error, and `close` follows.
			});
			const media: MediaSocket = {
				send: (data) => ws.send(data, { binary: typeof data !== "string" }),
				close: (code) => {
					try {
						ws.close(code);
					} catch {
						ws.terminate();
					}
				},
				terminate: () => ws.terminate(),
				bufferedAmount: () => ws.bufferedAmount,
			};
			return media;
		});
		if (status !== 101) refuse(status, "media");
		else log({ event: "host.upgraded", reason: "viewer" });
	}

	async function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		socket.on("error", () => socket.destroy());
		if (viewer && MEDIA_TARGET.test(req.url ?? "")) return viewerMedia(req, socket, head);
		if (pending >= limits.maxPendingUpgrades) {
			log({ event: "host.refused", status: 503, reason: "busy" });
			answerRaw(socket, refusal(503, "Too many connections are opening.", [["retry-after", "1"]]), limits.closeMs);
			return;
		}
		pending++;
		let settled = false;
		const abort = new AbortController();
		const opening: Opening = {
			socket,
			abort,
			outbound: new Outbound(limits.maxOutboundBytes),
			channel: null,
			timedOut: false,
			settle() {
				if (settled) return;
				settled = true;
				pending--;
				clearTimeout(timer);
				socket.off("data", early);
				socket.off("end", gone);
			},
		};
		/**
		 * Pim gave the request up, or broke HTTP by sending before `101`: the
		 * socket ends unanswered, and the relay is told, which ends the session
		 * already asked for, if one is.
		 */
		const gone = () => {
			opening.settle();
			abort.abort();
			socket.destroy();
		};
		const early = () => {
			log({ event: "host.refused", reason: "early-data" });
			gone();
		};
		const timer = setTimeout(() => {
			opening.timedOut = true;
			// While the session opens, the relay ends the channel and the answer is `504`; before that, there is no one to answer.
			if (opening.channel) abort.abort();
			else {
				log({ event: "host.refused", reason: "opening-timeout" });
				gone();
			}
		}, limits.openingMs);
		// However the socket ends, before or after `101`, the relay hears of it once; `end` is idempotent.
		socket.once("close", () => {
			opening.settle();
			abort.abort();
			opening.channel?.end();
		});
		socket.on("data", early);
		socket.on("end", gone);
		if (head.length > 0) return early();

		const request = toRequest(req);
		if (!(request instanceof Request)) {
			opening.settle();
			log({ event: "host.refused", status: request.refused.status, reason: request.reason });
			return answerRaw(socket, request.refused, limits.closeMs);
		}
		const refused = await relay.check(request);
		if (abort.signal.aborted) return;
		if (refused) {
			opening.settle();
			return answerRaw(socket, await fromResponse(refused), limits.closeMs);
		}
		openings.set(req, opening);
		wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
			const channel = opening.channel!;
			if (socket instanceof net.Socket) socket.setKeepAlive(true, 30_000);
			ws.on("message", (data: Buffer, isBinary: boolean) => channel.receive(isBinary ? data : data.toString("utf8")));
			ws.on("close", () => channel.end());
			ws.on("error", () => {
				// `ws` closes the socket after an error, and `close` follows.
			});
			opening.outbound.attach(ws);
			log({ event: "host.upgraded" });
		});
		// `ws` refused the handshake itself (its key or version) and answered it, or found the socket ended: nothing was opened.
		if (!opening.channel) {
			opening.settle();
			log({ event: "host.refused", reason: "handshake" });
		}
	}

	server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
		upgrade(req, socket, head).catch(() => {
			log({ event: "host.failed" });
			socket.destroy();
		});
	});

	server.on("clientError", (error: NodeJS.ErrnoException, socket: Duplex) => {
		const code = error.code ?? "";
		const status = code === "HPE_HEADER_OVERFLOW" ? 431 : code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : code.startsWith("HPE_") ? 400 : null;
		// Only a request HTTP couldn't take is answered; a socket that failed (a reset, or TLS that never began) has no one to answer.
		if (status === null || !socket.writable) return socket.destroy();
		log({ event: "host.refused", status, reason: "http" });
		answerRaw(socket, { status, headers: [], body: "" }, limits.closeMs);
	});
	server.on("tlsClientError", () => log({ event: "host.refused", reason: "tls" }));

	const host: Host = {
		async listen() {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen({ host: transport.host, port: transport.port, exclusive: true }, () => {
					server.off("error", reject);
					resolve();
				});
			});
			const bound = server.address() as net.AddressInfo;
			if (transport.kind === "loopback-http" && !isLoopback(bound.address)) {
				await host.close();
				throw new Error("Plain HTTP is served only on a loopback address.");
			}
			log({ event: "host.listening" });
			return { address: bound.address, port: bound.port };
		},
		async close() {
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			for (const socket of sockets) socket.destroy();
			await closed;
		},
	};
	return host;
}
