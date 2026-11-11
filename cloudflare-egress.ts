import { egressAllows, injectedHeaders } from "./src/coding/workspace/egress";
import type { EgressPolicy } from "./src/coding/workspace/types";

/** Each intercept is scoped to its connection target, never to the untrusted Host header. */
export async function handleEgress(request: Request, policy: EgressPolicy, target: string, forward: typeof fetch = fetch): Promise<Response> {
	const url = new URL(request.url);
	const denied = () => new Response("Forbidden", { status: 403 });
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !egressAllows({ allow: [target] }, url.hostname) || !egressAllows(policy, url.hostname)) return denied();
	if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) return denied();
	const headers = new Headers(request.headers);
	headers.delete("host");
	// Credentials are only injected over TLS. Redirects must be rechecked by the intercept.
	if (url.protocol === "https:") for (const [name, value] of Object.entries(injectedHeaders(policy, url.hostname, url.pathname))) headers.set(name, value);
	return forward(new Request(request, { headers, redirect: "manual" }), { redirect: "manual" });
}
