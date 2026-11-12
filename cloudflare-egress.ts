import { egressAllows, injectedHeaders } from "./src/coding/workspace/egress";
import type { EgressPolicy } from "./src/coding/workspace/types";

const log = (event: string, request: Request, url: URL | undefined, more: Record<string, unknown>) =>
	console.warn(JSON.stringify({ event, host: url?.hostname ?? null, protocol: url?.protocol ?? null, method: request.method, upgrade: request.headers.get("upgrade"), ...more }));

/** Cuts the query off any URL quoted in text that is about to be logged: the upgrade URL's carries the `rvt-token`. */
const withoutQueries = (text: string) => text.replace(/(\b[wW]ss?:\/\/[^\s?'"#]*)\?[^\s'"]*/g, "$1");

/**
 * Relays one leg of an upgraded socket: what arrives on one WebSocket is sent on the other, and a close is
 * forwarded with its code and reason. 1005 (no status) and 1006 (abnormal closure) are reserved and cannot
 * travel in a close frame, so they are spoken of as an ordinary close.
 */
const relayFrames = (from: WebSocket, to: WebSocket, count: () => void) => {
	const giveUp = (why: string) => {
		try {
			to.close(1011, why);
		} catch {
			// The far side had already gone away.
		}
	};
	from.addEventListener("message", (event) => {
		count();
		try {
			if (event.data instanceof Blob) void event.data.arrayBuffer().then((buffer) => to.send(buffer)).catch(() => giveUp("Relaying a message failed"));
			else to.send(event.data as (ArrayBuffer | ArrayBufferView) | string);
		} catch {
			giveUp("Relaying a message failed");
		}
	});
	from.addEventListener("close", (event) => {
		try {
			to.close(event.code === 1005 || event.code === 1006 ? 1000 : event.code, event.reason);
		} catch {
			// Already gone.
		}
	});
	from.addEventListener("error", () => giveUp("The relay's other end failed"));
};

/**
 * Answers one upgrade the destination agreed to, with the socket it gave, relayed through a WebSocketPair of
 * Pim's own rather than returned untouched. A returned socket is coupled by the runtime below the level of
 * any Worker code, so nothing of its life could be told; a relayed one lets this handler log its open, each
 * close (which side closed, with what code and reason) and each error, with how many messages went each way —
 * the only evidence there is when the CLI inside the container reports the connection failed. Nothing the
 * socket carries is logged, and any URL quoted in a close reason or an error is stripped of its query first.
 *
 * The socket is re-framed by the Worker on both legs now, so the compression the destination negotiated cannot
 * be kept (as for the request's `sec-websocket-extensions`), and the accept key it answered belongs to the
 * destination's own handshake: the runtime answers the container's key. The subprotocol the destination chose
 * is the container's to see, so it stays.
 */
function relayedUpgrade(response: Response, upstream: WebSocket, request: Request, url: URL, target: string): Response {
	const headers = new Headers(response.headers);
	headers.delete("sec-websocket-extensions");
	headers.delete("sec-websocket-accept");
	const pair = new WebSocketPair();
	const toContainer = pair[0];
	const fromContainer = pair[1];
	upstream.accept();
	fromContainer.accept();
	const openedAt = Date.now();
	let upstreamToContainer = 0;
	let containerToUpstream = 0;
	log("pim.coding.egress_ws_open", request, url, { target });
	for (const [side, socket] of [
		["upstream", upstream],
		["container", fromContainer],
	] as const) {
		const close = (event: CloseEvent) =>
			log("pim.coding.egress_ws_close", request, url, {
				side,
				code: event.code,
				reason: withoutQueries(event.reason),
				wasClean: event.wasClean,
				upstreamToContainer,
				containerToUpstream,
				durationMs: Date.now() - openedAt,
				target,
			});
		socket.addEventListener("close", close);
		socket.addEventListener("error", (event) =>
			log("pim.coding.egress_ws_error", request, url, {
				side,
				error: withoutQueries((event as ErrorEvent).message ?? String(event)),
				durationMs: Date.now() - openedAt,
				target,
			}),
		);
	}
	relayFrames(upstream, fromContainer, () => upstreamToContainer++);
	relayFrames(fromContainer, upstream, () => containerToUpstream++);
	return new Response(null, { status: 101, webSocket: toContainer, headers });
}

/**
 * Decides one request a Cloudflare container sends out, and forwards it when the policy allows its host. Each
 * intercept is scoped to its connection target, never to the untrusted Host header. Every request is logged,
 * with its destination's status, but never with anything of the request's own that could hold a secret: no
 * path or query (Amp's upgrade URL carries an `rvt-token`), no headers (Pim's carry its tokens), no body. A
 * denial says so with its reason and answers 403 with `x-pim-egress: denied`, so a 403 from Pim is told apart
 * from one the destination sent (logged as `pim.coding.egress_upstream_refused`, and as
 * `pim.coding.egress_allowed` with its status like any other pass). An upgrade the destination answered 101
 * with a socket on is relayed by `relayedUpgrade`; one it answered without a socket cannot be re-framed for the
 * container and goes back as it came, said so in `pim.coding.egress_ws_error`.
 */
export async function handleEgress(request: Request, policy: EgressPolicy, target: string, forward: typeof fetch = fetch): Promise<Response> {
	const url = new URL(request.url);
	const deny = (reason: string) => {
		log("pim.coding.egress_denied", request, url, { reason, target });
		return new Response(`Forbidden: ${reason}`, { status: 403, headers: { "x-pim-egress": "denied" } });
	};
	if (!["http:", "https:"].includes(url.protocol)) return deny("protocol");
	if (url.username || url.password) return deny("credentials in URL");
	if (target !== "*" && !egressAllows({ allow: [target] }, url.hostname)) return deny("host outside intercept target");
	if (!egressAllows(policy, url.hostname)) return deny("host not in allowlist");
	if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) return deny("port");
	const headers = new Headers(request.headers);
	headers.delete("host");
	// The socket is re-framed by the Worker, so extensions the container negotiated (permessage-deflate) can't be kept.
	if (request.headers.get("upgrade")?.toLowerCase() === "websocket") headers.delete("sec-websocket-extensions");
	// Credentials are only injected over TLS. Redirects must be rechecked by the intercept.
	if (url.protocol === "https:") for (const [name, value] of Object.entries(injectedHeaders(policy, url.hostname, url.pathname))) headers.set(name, value);
	const response = await forward(new Request(request, { headers, redirect: "manual" }), { redirect: "manual" });
	// What the destination answered. The request's own path, query and headers stay out of it: they hold tokens.
	log("pim.coding.egress_allowed", request, url, { status: response.status, target });
	if (response.status === 401 || response.status === 403)
		log("pim.coding.egress_upstream_refused", request, url, { status: response.status, server: response.headers.get("server"), via: response.headers.get("via"), cfRay: response.headers.get("cf-ray") });
	if (response.status !== 101) return response;
	const upstream = response.webSocket;
	if (!upstream) {
		log("pim.coding.egress_ws_error", request, url, { reason: "101 without a WebSocket", target });
		return response;
	}
	return relayedUpgrade(response, upstream, request, url, target);
}
