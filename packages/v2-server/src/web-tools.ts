/**
 * `fetch_url`, as v1 had it (`src/extensions/web.ts`): a web page comes back as the readable text of it, clipped, with the images the page shows (its preview image first), which a reply's
 * cards may use. Redirects are followed a few hops, and every hop must still be a public address; content that is not text is refused.
 */
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
type Define = (name: string, description: string, parameters: any, execute: (args: any, api: any, context: any) => Promise<Result>, replay?: "safe" | "unsafe") => ToolRegistration;

const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

/** How much of a page `fetch_url` returns. */
export const MAX_PAGE_CHARS = 20_000;
/** How many of a page's images it lists. */
const MAX_PAGE_IMAGES = 12;
/** What is read of a response before it is turned into text: enough that a page's text is not all markup. */
const MAX_PAGE_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const REQUEST_MS = 20_000;

/** `value` cut to `limit` characters, saying how many more there were. */
export const clipText = (value: string, limit: number): string => (value.length > limit ? `${value.slice(0, limit)}\n[... ${value.length - limit} more characters]` : value);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(html: string): string {
	return html.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, name: string) => {
		try {
			if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
			if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
		} catch {
			return match;
		}
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

/** The images a page shows, by their web addresses, its preview image first: what a reply's cards may show of it. */
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

/** The first `max` bytes of a response's body, as text. */
export async function readText(response: Response, max: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < max) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.length;
	}
	await reader.cancel().catch(() => {});
	return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

export function webTools(deps: { tool: Define; fetch: typeof fetch; publicUrl(raw: string): Promise<URL> }): ToolRegistration[] {
	return [
		deps.tool("fetch_url", "Read a web page or a text/JSON URL with a GET request. Returns the readable text, clipped, and a page's images, its preview image first. Public addresses only.", Type.Object({ url: Type.String({ pattern: "^https?://" }) }), async (args) => {
			try {
				let url = await deps.publicUrl(args.url);
				let response: Response;
				// Redirects are followed by hand, so that each hop is checked to be a public address.
				for (let hops = 0; ; hops++) {
					response = await deps.fetch(url, { signal: AbortSignal.timeout(REQUEST_MS), redirect: "manual", headers: { accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5", "user-agent": "Pim/2" } });
					const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
					if (!location) break;
					await response.body?.cancel().catch(() => {});
					if (hops >= MAX_REDIRECTS) return text(`Too many redirects: ${url.href} went on to ${location}.`, true);
					url = await deps.publicUrl(new URL(location, url).href);
				}
				const type = response.headers.get("content-type") ?? "";
				if (type !== "" && !/text|json|xml|javascript/.test(type)) {
					await response.body?.cancel().catch(() => {});
					return text(`HTTP ${response.status}: ${type} content is not readable as text.`, true);
				}
				const raw = await readText(response, MAX_PAGE_BYTES);
				const html = type.includes("html");
				const images = html ? pageImages(raw, url.href) : [];
				const listed = images.length > 0 ? `\n\nImages:\n${images.map((image) => `- ${image}`).join("\n")}` : "";
				return text(`HTTP ${response.status} ${url.href}\n\n${clipText(html ? htmlToText(raw) : raw, MAX_PAGE_CHARS)}${listed}`, !response.ok);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		}, "safe"),
	];
}
