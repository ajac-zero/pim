/**
 * The addresses a ```ui block may send a person to. Only web addresses: what
 * a link in a message does is open a page, never run something, so anything
 * that isn't plain http or https is refused, wherever it was written.
 */

/** The longest address a block may open, characters. */
export const MAX_URL_CHARS = 2048;

/**
 * The address a text names, as the browser will open it, or null when it is
 * not an http or https address of a host: no other scheme, no relative
 * address, no whitespace or control characters the browser would silently
 * drop, and no user name or password in it.
 */
export function httpUrlOf(text: string): string | null {
	if (text.length === 0 || text.length > MAX_URL_CHARS) return null;
	// A browser ignores tabs and line breaks inside an address, which would let `java\tscript:` through a check of its text.
	if (/[\u0000-\u0020\u007f-\u009f\u2028\u2029]/.test(text)) return null;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.hostname === "" || url.username !== "" || url.password !== "") return null;
	return url.href;
}
