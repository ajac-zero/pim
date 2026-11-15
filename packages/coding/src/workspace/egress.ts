// Egress policy helpers shared by the thread and the backends: normalizing a policy, the rules that keep Pim's tokens out of a workspace, and what is left to hand a workspace when its backend can't inject them.

import type { EgressInjection, EgressPolicy, WorkspaceProvider, WorkspaceRef, WorkspaceSpec } from "./types";
import { WorkspaceUnsupportedError } from "./types";

const lower = (host: string) => host.trim().toLowerCase();

/** Whether a hostname pattern covers `name`: exactly, or for `*.example.com`, any subdomain but not the domain itself. */
const covers = (pattern: string, name: string) => pattern === name || (pattern.startsWith("*.") && name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1);

/**
 * The policy with hostnames lowercased and listed once, every host with an injection rule allowed, and rules for the
 * same host and path prefix merged (later headers win). The existing plain allowlist, `{ allow }`, becomes a policy
 * with no rules.
 */
export function egressPolicy(policy: EgressPolicy): { allow: string[]; inject: EgressInjection[] } {
	const rules = new Map<string, EgressInjection>();
	for (const rule of policy.inject ?? []) {
		const host = lower(rule.host);
		const key = `${host}\0${rule.pathPrefix ?? ""}`;
		rules.set(key, { host, ...(rule.pathPrefix ? { pathPrefix: rule.pathPrefix } : {}), headers: { ...rules.get(key)?.headers, ...rule.headers } });
	}
	const injected = [...rules.values()].map((rule) => rule.host);
	return { allow: [...new Set([...policy.allow.map(lower), ...injected].filter(Boolean))], inject: [...rules.values()] };
}

/**
 * The path a request means, as a server would resolve it: percent-encoding decoded per segment, `.` and `..`
 * resolved, empty segments dropped. Null (matches nothing) for a path that can't be read safely: bad
 * percent-encoding, or an encoded slash or backslash, which servers disagree about.
 */
export function normalizePath(path: string): string | null {
	const out: string[] = [];
	for (const raw of path.split(/[?#]/)[0]!.split("/")) {
		let segment: string;
		try {
			segment = decodeURIComponent(raw);
		} catch {
			return null;
		}
		if (segment.includes("/") || segment.includes("\\")) return null;
		if (segment === "" || segment === ".") continue;
		if (segment === "..") out.pop();
		else out.push(segment);
	}
	return `/${out.join("/")}`;
}

/** Whether a normalized path is the prefix or below it: `/api/git` covers `/api/git/x` but not `/api/gitx`. */
const underPrefix = (path: string, prefix: string) => prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);

/**
 * The headers a policy adds to a request to `host` and `path`, or none. The path is normalized (`normalizePath`) and
 * a rule's prefix matches whole segments only. The host is compared as given, lowercased and nothing else, so a
 * name with a trailing dot or userinfo matches no rule: it fails closed. Exact-host rules override wildcard
 * rules per header, regardless of their order; equally specific rules keep their existing later-wins order.
 */
export function injectedHeaders(policy: EgressPolicy, host: string, path = "/"): Record<string, string> {
	const name = lower(host);
	const resolved = normalizePath(path);
	let out: Record<string, string> = {};
	if (resolved === null) return out;
	const rules = egressPolicy(policy).inject.sort((a, b) => Number(!a.host.startsWith("*.")) - Number(!b.host.startsWith("*.")));
	for (const rule of rules) {
		const prefix = rule.pathPrefix === undefined ? "/" : normalizePath(rule.pathPrefix);
		if (covers(rule.host, name) && prefix !== null && underPrefix(resolved, prefix)) {
			for (const [header, value] of Object.entries(rule.headers)) out[header.toLowerCase()] = value;
		}
	}
	return out;
}

/** Whether the policy lets a workspace connect to `host`. */
export const egressAllows = (policy: EgressPolicy, host: string): boolean => egressPolicy(policy).allow.some((pattern) => covers(pattern, lower(host)));

/** A rule that gives requests to Pim's git broker, whose routes start at `pathPrefix`, a bearer token. */
export const gitBrokerInjection = (origin: string, pathPrefix: string, token: string): EgressInjection => ({ host: new URL(origin).hostname, pathPrefix, headers: { authorization: `Bearer ${token}` } });

/** A rule that gives requests to Pim's model gateway, whose routes start at `pathPrefix`, the thread's token, as the family's clients send it: `x-api-key` for Anthropic, a bearer token for OpenAI. */
export const gatewayInjection = (origin: string, pathPrefix: string, family: "anthropic" | "openai", token: string): EgressInjection => ({
	host: new URL(origin).hostname,
	pathPrefix,
	headers: family === "anthropic" ? { "x-api-key": token } : { authorization: `Bearer ${token}` },
});

/** What a workspace is given in place of a secret its backend injects: the CLI needs some value to send, and the proxy replaces it. */
export const INJECTED_PLACEHOLDER = "pim-injected-by-egress-proxy";

/**
 * Decides where a secret goes. A backend that injects (`capabilities.egressInjection`) gets the rule and the
 * workspace gets the placeholder; any other backend gets the secret in the workspace's environment, as before.
 */
export function placeSecret(provider: Pick<WorkspaceProvider, "capabilities">, rule: EgressInjection, secret: string): { env: string; rule?: EgressInjection } {
	return provider.capabilities.egressInjection ? { env: INJECTED_PLACEHOLDER, rule } : { env: secret };
}

/** The default `resumeOrCreate` for a backend that doesn't suspend: the workspace as it is, started if stopped, or a new one. */
export async function resumeOrCreate(provider: Pick<WorkspaceProvider, "get" | "create">, ref: WorkspaceRef, spec: WorkspaceSpec): Promise<{ ref: WorkspaceRef; resumed: boolean }> {
	const found = await provider.get(ref);
	const state = found ? (await found.status()).state : "gone";
	if (found && state !== "gone") {
		if (state === "stopped") await found.start();
		return { ref, resumed: true };
	}
	return { ref: await provider.create(spec), resumed: false };
}

/** The error a backend without `capabilities.suspendResume` throws from `suspend`. */
export const unsupportedSuspend = (id: string) => new WorkspaceUnsupportedError(`The ${id} workspace backend can't suspend a workspace`);

/** The error a backend without `capabilities.egressInjection` throws from `setEgress`. */
export const unsupportedEgress = (id: string) => new WorkspaceUnsupportedError(`The ${id} workspace backend doesn't inject credentials`);
