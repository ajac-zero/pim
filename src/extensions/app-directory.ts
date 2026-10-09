/**
 * Finding an app's remote MCP server in the official MCP Registry
 * (https://registry.modelcontextprotocol.io), so connecting Linear is "connect
 * Linear", not "connect https://mcp.linear.app/mcp".
 *
 * The registry is open: searching "linear" also finds gateways that relay
 * Linear through someone else's server, who then sees everything that passes.
 * The registry verifies who publishes under a name: `app.linear/...` only by
 * whoever controls linear.app, `io.github.someone/...` only by that GitHub
 * user. So candidates are ranked by whether the server is the app's own: its
 * publisher's domain names the app, and the server runs on that domain.
 */

export const REGISTRY_URL = "https://registry.modelcontextprotocol.io";

const MAX_CANDIDATES = 8;

type RegistryRemote = {
	type?: string;
	url?: string;
	headers?: { name?: string; isRequired?: boolean }[];
};

export type RegistryEntry = {
	server?: {
		name?: string;
		title?: string;
		description?: string;
		remotes?: RegistryRemote[];
	};
	_meta?: Record<string, { status?: string } | undefined>;
};

export type AppCandidate = {
	/** The registry name, such as `app.linear/linear`. */
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly url: string;
	/** Who the registry verified as the publisher: a domain, or a GitHub user. */
	readonly publisher: { readonly kind: "domain"; readonly domain: string } | { readonly kind: "github"; readonly user: string };
	/** The server runs on its publisher's domain. */
	readonly ownDomain: boolean;
	/** The publisher's domain names the app searched for, like linear.app for "linear". */
	readonly matchesApp: boolean;
};

/** The publisher a registry namespace was verified for. */
export function publisherOf(name: string): AppCandidate["publisher"] {
	const namespace = name.split("/")[0] ?? "";
	const github = /^io\.github\.([^.]+)$/i.exec(namespace);
	if (github) return { kind: "github", user: github[1]! };
	return { kind: "domain", domain: namespace.split(".").reverse().join(".").toLowerCase() };
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** Words of the query, for matching a publisher's domain. */
function words(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 1);
}

/** Usable remotes of the latest, active entries, as candidates: the app's own first. */
export function rankCandidates(entries: readonly RegistryEntry[], query: string): AppCandidate[] {
	const wanted = words(query);
	const seen = new Set<string>();
	const candidates: AppCandidate[] = [];
	for (const entry of entries) {
		const server = entry.server;
		if (!server?.name) continue;
		const status = entry._meta?.["io.modelcontextprotocol.registry/official"]?.status;
		if (status !== undefined && status !== "active") continue;
		const publisher = publisherOf(server.name);
		for (const remote of server.remotes ?? []) {
			// Pim speaks Streamable HTTP; a URL template or a required header needs values Pim cannot know.
			if (remote.type !== "streamable-http" || !remote.url?.startsWith("https://")) continue;
			if (/[{}]/.test(remote.url) || remote.headers?.some((header) => header.isRequired)) continue;
			const host = hostOf(remote.url);
			if (!host || seen.has(remote.url)) continue;
			seen.add(remote.url);
			const domain = publisher.kind === "domain" ? publisher.domain : null;
			const labels = domain?.split(".") ?? [];
			candidates.push({
				name: server.name,
				title: server.title || server.name.split("/").at(-1) || server.name,
				description: server.description ?? "",
				url: remote.url,
				publisher,
				ownDomain: domain !== null && (host === domain || host.endsWith(`.${domain}`)),
				matchesApp: wanted.some((word) => labels.includes(word)),
			});
		}
	}
	const rank = (candidate: AppCandidate) =>
		(candidate.matchesApp && candidate.ownDomain ? 0 : 2) + (candidate.ownDomain ? 0 : 1);
	// Stable: within a rank, the registry's order.
	return candidates
		.map((candidate, index) => ({ candidate, index }))
		.sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.index - b.index)
		.slice(0, MAX_CANDIDATES)
		.map(({ candidate }) => candidate);
}

export async function searchRegistry(query: string): Promise<AppCandidate[]> {
	const url = new URL("/v0/servers", REGISTRY_URL);
	url.search = new URLSearchParams({ search: query, version: "latest", limit: "50" }).toString();
	const response = await fetch(url, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`The MCP Registry answered ${response.status}`);
	const body = (await response.json()) as { servers?: RegistryEntry[] };
	return rankCandidates(body.servers ?? [], query);
}

/** The candidates as the model reads them. */
export function describeCandidates(query: string, candidates: readonly AppCandidate[]): string {
	if (candidates.length === 0) {
		return `The MCP Registry has no remote server for "${query}". Ask the user for the app's MCP server URL, or look for it in the app's documentation.`;
	}
	const lines = candidates.map((candidate, index) => {
		const publisher =
			candidate.publisher.kind === "domain"
				? `published by ${candidate.publisher.domain}`
				: `published by GitHub user ${candidate.publisher.user}`;
		const trust =
			candidate.matchesApp && candidate.ownDomain
				? "the app's own server"
				: "third party: whoever runs it sees what passes through it";
		const description = candidate.description ? ` ${candidate.description}` : "";
		return `${index + 1}. ${candidate.title}: ${candidate.url} (${publisher}; ${trust}).${description}`;
	});
	return [
		`MCP Registry servers for "${query}", the app's own first:`,
		...lines,
		"Connect the app's own server with connect_app. Offer a third-party one only if the app has none, and say who runs it.",
	].join("\n");
}
