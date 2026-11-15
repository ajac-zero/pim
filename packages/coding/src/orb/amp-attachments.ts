/**
 * Amp's attachment images in an agent's reply (`![Light](https://ampcode.com/user-content/attachments/…)`):
 * only Amp's signed-in clients can load them, so Pim copies each into the space's own images. Finding them in
 * Markdown, and fetching one as the space's Amp login, with the login never sent anywhere but Amp.
 */
import { maskCode } from "@pim/shared/markdown-code";

const DEFAULT_BASE = "https://ampcode.com";
const ATTACHMENT_PATHS = [
	/^\/(?:attachments|user-content\/attachments|user-content\/temporary-files|user-content\/artifacts)\/[^/]+$/,
	/^\/user-content\/artifact-files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+$/i,
];
const IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** An attachment image a message shows: the address as written (with Amp's `#amp-media-…` fragment), and the one fetch asks for. */
export type AmpAttachment = { readonly url: string; readonly canonical: string };

/** The attachment images `text` shows outside its code, each address once, in order. */
export function ampAttachments(text: string, baseUrl: string = DEFAULT_BASE): AmpAttachment[] {
	const origin = new URL(baseUrl).origin;
	const masked = maskCode(text);
	const found = new Map<string, AmpAttachment>();
	for (const match of masked.matchAll(IMAGE)) {
		const url = match[1]!;
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			continue;
		}
		if (parsed.origin !== origin || !ATTACHMENT_PATHS.some((path) => path.test(parsed.pathname))) continue;
		parsed.hash = "";
		if (!found.has(url)) found.set(url, { url, canonical: parsed.href });
	}
	return [...found.values()];
}

/** `text` with each image address in `copies` (as written) replaced by its copy, outside code. */
export function replaceAmpAttachments(text: string, copies: ReadonlyMap<string, string>): string {
	if (copies.size === 0) return text;
	const masked = maskCode(text);
	let out = "";
	let at = 0;
	for (const match of masked.matchAll(IMAGE)) {
		const url = match[1]!;
		const copy = copies.get(url);
		if (copy === undefined) continue;
		const start = match.index + match[0].indexOf(url);
		out += text.slice(at, start) + copy;
		at = start + url.length;
	}
	return out + text.slice(at);
}

/** A host Amp never redirects to: this machine or a private network. */
function isPrivateHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
	if (host.includes(":")) return host === "::1" || host === "::" || /^(fc|fd|fe80)/.test(host) || host.startsWith("::ffff:");
	const octets = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
	if (!octets) return false;
	const [a, b] = [Number(octets[1]), Number(octets[2])];
	return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export type AmpImageOptions = {
	readonly token: string;
	readonly baseUrl?: string;
	readonly types: readonly string[];
	/** The most the image may be: the size limit, or the space's room if less. */
	readonly maxBytes: number;
	readonly timeoutMs?: number;
	readonly fetch?: typeof fetch;
};

/** How a fetch ended: the image, or whether asking again could help. */
export type AmpImageResult = { readonly ok: true; readonly bytes: Uint8Array; readonly type: string } | { readonly ok: false; readonly retry: boolean };

/**
 * One attachment's bytes. The Amp login goes to Amp alone: a redirect to Amp's own origin is followed once
 * with it, one to another HTTPS address (signed storage) once without it, and any other redirect, a
 * plain-HTTP or private address, or a second hop fails.
 */
export async function fetchAmpImage(canonical: string, options: AmpImageOptions): Promise<AmpImageResult> {
	const origin = new URL(options.baseUrl ?? DEFAULT_BASE).origin;
	const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
	let url = new URL(canonical);
	let withLogin = true;
	try {
		for (let hop = 0; hop < 2; hop++) {
			const headers: Record<string, string> = { accept: options.types.join(", ") };
			if (withLogin) headers.authorization = `Bearer ${options.token}`;
			const response = await doFetch(url.href, { headers, redirect: "manual", signal });
			if (REDIRECTS.has(response.status)) {
				await response.body?.cancel();
				const location = response.headers.get("location");
				if (!location || hop > 0) return { ok: false, retry: false };
				const next = new URL(location, url);
				if (next.protocol !== "https:" || isPrivateHost(next.hostname)) return { ok: false, retry: false };
				withLogin = withLogin && next.origin === origin;
				url = next;
				continue;
			}
			const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
			if (!response.ok) {
				await response.body?.cancel();
				return { ok: false, retry: response.status === 401 || response.status === 429 || response.status >= 500 };
			}
			if (!options.types.includes(type) || Number(response.headers.get("content-length") ?? 0) > options.maxBytes) {
				await response.body?.cancel();
				return { ok: false, retry: false };
			}
			const bytes = await readAtMost(response.body, options.maxBytes);
			return bytes && bytes.byteLength > 0 ? { ok: true, bytes, type } : { ok: false, retry: false };
		}
	} catch {
		return { ok: false, retry: true };
	}
	return { ok: false, retry: false };
}

/** The body if it is at most `limit` bytes, counted as it arrives; else null. */
async function readAtMost(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
	if (!body) return null;
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		size += next.value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(next.value);
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
}
