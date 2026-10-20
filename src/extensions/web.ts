import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { text } from "./services";

const MAX_PAGE_CHARS = 20_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** How many of a page's images `fetch_url` lists. */
const MAX_PAGE_IMAGES = 12;

function decodeEntities(html: string): string {
	return html.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, name: string) => {
		if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
		if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
		return ENTITIES[name.toLowerCase()] ?? match;
	});
}

/** Readable text from an HTML page; good enough for a model to read. */
export function htmlToText(html: string): string {
	const stripped = html
		.replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	return decodeEntities(stripped)
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.trim();
}

/** An attribute's value in a tag's attributes, decoded. */
function attribute(attributes: string, name: string): string | undefined {
	const value = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attributes);
	return value ? decodeEntities(value[1] ?? value[2] ?? value[3] ?? "") : undefined;
}

/**
 * The images a page shows, by their web addresses, its preview image first:
 * what a reply's cards may show of it.
 */
export function pageImages(html: string, base: string): string[] {
	const found: string[] = [];
	for (const [, attributes = ""] of html.matchAll(/<meta\b([^>]*)>/gi)) {
		const name = attribute(attributes, "property") ?? attribute(attributes, "name") ?? "";
		if (/^(og:image(:secure_url)?|twitter:image)$/i.test(name)) found.push(attribute(attributes, "content") ?? "");
	}
	for (const [, attributes = ""] of html.matchAll(/<img\b([^>]*)>/gi)) found.push(attribute(attributes, "src") ?? "");
	const images = found.flatMap((value) => {
		const url = URL.parse(value.trim(), base);
		// A drawing is no image Pim shows: SVG can carry scripts.
		return url && (url.protocol === "https:" || url.protocol === "http:") && !url.pathname.toLowerCase().endsWith(".svg") ? [url.href] : [];
	});
	return [...new Set(images)].slice(0, MAX_PAGE_IMAGES);
}

const fetchUrl = defineTool({
	name: "fetch_url",
	description: "Read a web page or a text/JSON URL with a GET request. Returns the readable text, clipped, and a page's images, its preview image first.",
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
		const html = type.includes("html");
		const body = html ? htmlToText(raw) : raw;
		const clipped =
			body.length > MAX_PAGE_CHARS ? `${body.slice(0, MAX_PAGE_CHARS)}\n[... ${body.length - MAX_PAGE_CHARS} more characters]` : body;
		const images = html ? pageImages(raw, response.url || url) : [];
		const listed = images.length > 0 ? `\n\nImages:\n${images.map((image) => `- ${image}`).join("\n")}` : "";
		return text(`HTTP ${response.status} ${response.url}\n\n${clipped}${listed}`, !response.ok);
	},
});

/**
 * Reading a page the agent already has the address of. Searching is an
 * app's, such as Exa or Firecrawl, which each person connects.
 */
export const webExtension = defineExtension({ name: "pim.web", tools: [fetchUrl] });
