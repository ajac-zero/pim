import { egressAllows, injectedHeaders } from "./src/coding/workspace/egress";
import type { EgressPolicy } from "./src/coding/workspace/types";

const log = (event: string, request: Request, url: URL | undefined, more: Record<string, unknown>) =>
	console.warn(JSON.stringify({ event, host: url?.hostname ?? null, protocol: url?.protocol ?? null, method: request.method, upgrade: request.headers.get("upgrade"), ...more }));

/**
 * Decides one request a Cloudflare container sends out, and forwards it when the policy allows its host. Each
 * intercept is scoped to its connection target, never to the untrusted Host header. A WebSocket upgrade is an
 * ordinary request here: the forwarded fetch answers 101 with a socket, which is returned as it is. Every denial is
 * logged with its reason, host, protocol, method and Upgrade header, and answers 403 with `x-pim-egress: denied` so
 * a 403 from Pim is told apart from one the destination sent (logged as `pim.coding.egress_upstream_refused`).
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
	if (response.status === 401 || response.status === 403)
		log("pim.coding.egress_upstream_refused", request, url, { status: response.status, server: response.headers.get("server"), via: response.headers.get("via"), cfRay: response.headers.get("cf-ray") });
	return response;
}
