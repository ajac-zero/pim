import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { webSearchTool } from "agents/websearch/pi";
import { text } from "./services";

const MAX_PAGE_CHARS = 20_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Readable text from an HTML page; good enough for a model to read. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, name: string) => {
			if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
			if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
			return ENTITIES[name.toLowerCase()] ?? match;
		})
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.trim();
}

const fetchUrl = defineTool({
	name: "fetch_url",
	description: "Read a web page or a text/JSON URL with a GET request. Returns the readable text, clipped.",
	parameters: Type.Object({ url: Type.String({ pattern: "^https?://" }) }),
	replay: "safe",
	async execute({ url }) {
		const response = await fetch(url, {
			headers: { accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5", "user-agent": "pim-agent/0.1" },
			redirect: "follow",
			signal: AbortSignal.timeout(20_000),
		});
		const type = response.headers.get("content-type") ?? "";
		if (!/text|json|xml|javascript/.test(type) && type !== "") {
			return text(`HTTP ${response.status}: ${type} content is not readable as text.`, true);
		}
		const raw = await response.text();
		const body = type.includes("html") ? htmlToText(raw) : raw;
		const clipped =
			body.length > MAX_PAGE_CHARS ? `${body.slice(0, MAX_PAGE_CHARS)}\n[... ${body.length - MAX_PAGE_CHARS} more characters]` : body;
		return text(`HTTP ${response.status} ${response.url}\n\n${clipped}`, !response.ok);
	},
});

type SearchProvider = "exa" | "ceramic" | "linkup";

/**
 * `fetch_url` always; `web_search` only when a provider is configured,
 * since searches are billed to the account's AI Gateway.
 */
export function webExtension(options: { ai: Ai; searchProvider?: string }) {
	const tools: ToolRegistration[] = [fetchUrl as ToolRegistration];
	const provider = options.searchProvider?.trim();
	if (provider) {
		if (!["exa", "ceramic", "linkup"].includes(provider)) {
			throw new Error(`PIM_WEB_SEARCH must be exa, ceramic or linkup, not ${JSON.stringify(provider)}`);
		}
		tools.push(webSearchTool({ binding: options.ai, provider: provider as SearchProvider }) as ToolRegistration);
	}
	return defineExtension({ name: "pim.web", tools });
}
