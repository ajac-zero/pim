/**
 * What an exact origin is, for the viewer's settings (docs/cua-viewer-first-preview.md): the one
 * check that `host.ts`, `viewer-host.ts` and the installer's configuration all use. It imports only
 * Node's `net`, so the operator's and the installer's programs can read it without `ws`.
 * Importing it does nothing.
 */

import * as net from "node:net";

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

