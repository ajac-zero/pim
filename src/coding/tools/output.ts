// Keeping what the coding tools hand the model small and free of secrets: output is capped to its beginning or its end with a notice of what was left out, and anything shaped like a credential is replaced before it leaves the tool.

/** The most a tool's output may hold, in bytes and in lines. */
export const MAX_OUTPUT_BYTES = 30_000;
export const MAX_OUTPUT_LINES = 2_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const byteLength = (text: string) => encoder.encode(text).byteLength;

/** Credentials in the shapes they usually take in files, command output and environment listings. */
const SECRETS: [RegExp, string][] = [
	[/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
	[/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED]"],
	[/\b(?:sk|rk)-(?:[A-Za-z]+-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
	[/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
	[/\b(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, "$1[REDACTED]"],
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@"],
	// An upper-case setting named like a credential, given a literal value; not one read from elsewhere, such as `process.env.API_KEY`.
	[/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*["']?\s*[=:]\s*)("[^"\n]+"|'[^'\n]+'|[^\s"',;$(){}.]{4,}(?=[\s"',;]|$))/g, "$1[REDACTED]"],
];

/** `text` with every credential-shaped part replaced by a marker. */
export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
	return out;
}

/** The first `maxBytes` bytes and `maxLines` lines of `text`. */
function headOf(text: string, maxBytes: number, maxLines: number): string {
	const lines = text.split("\n");
	let kept = lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")}\n` : text;
	const bytes = encoder.encode(kept);
	if (bytes.byteLength > maxBytes) kept = decoder.decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD$/, "");
	return kept;
}

/** The last `maxBytes` bytes and `maxLines` lines of `text`. */
function tailOf(text: string, maxBytes: number, maxLines: number): string {
	const lines = text.split("\n");
	const trailing = text.endsWith("\n") ? 1 : 0;
	let kept = lines.length - trailing > maxLines ? lines.slice(lines.length - trailing - maxLines).join("\n") : text;
	const bytes = encoder.encode(kept);
	if (bytes.byteLength > maxBytes) kept = decoder.decode(bytes.subarray(bytes.byteLength - maxBytes)).replace(/^\uFFFD/, "");
	return kept;
}

/** Output gathered as it arrives, keeping only its beginning or its end, and counting what it drops. */
export class Capture {
	#text = "";
	#total = 0;

	constructor(
		readonly retain: "head" | "tail",
		readonly maxBytes = MAX_OUTPUT_BYTES,
		readonly maxLines = MAX_OUTPUT_LINES,
	) {}

	push(chunk: string): void {
		this.#total += byteLength(chunk);
		// A string never has more characters than bytes, so keeping `maxBytes` characters keeps at least `maxBytes` bytes.
		if (this.retain === "head") {
			if (this.#text.length < this.maxBytes) this.#text += chunk.slice(0, this.maxBytes - this.#text.length);
		} else {
			this.#text += chunk;
			if (this.#text.length > 2 * this.maxBytes) this.#text = this.#text.slice(-this.maxBytes);
		}
	}

	/** Whether the head is already full, so more output would be dropped. */
	get full(): boolean {
		return this.retain === "head" && this.#text.length >= this.maxBytes;
	}

	/** The kept output, redacted, and how many bytes were left out. */
	result(): { text: string; omittedBytes: number } {
		const kept = this.retain === "head" ? headOf(this.#text, this.maxBytes, this.maxLines) : tailOf(this.#text, this.maxBytes, this.maxLines);
		return { text: redact(kept), omittedBytes: Math.max(0, this.#total - byteLength(kept)) };
	}

	/** The kept output with a notice where something was left out. */
	render(): string {
		const { text, omittedBytes } = this.result();
		if (omittedBytes === 0) return text;
		return this.retain === "tail"
			? `[Output truncated: the first ${omittedBytes} bytes were left out; this is the end of it.]\n${text}`
			: `${text}${text.endsWith("\n") ? "" : "\n"}[Output truncated: ${omittedBytes} more bytes were left out.]`;
	}
}

/** Passes output on a line at a time, redacted, so a credential split across two chunks is still caught. A line longer than 8 KB is passed on as it is. */
export class LineStream {
	#pending = "";

	constructor(private emit: (text: string) => void) {}

	push(chunk: string): void {
		this.#pending += chunk;
		const end = this.#pending.lastIndexOf("\n");
		if (end >= 0) {
			this.emit(redact(this.#pending.slice(0, end + 1)));
			this.#pending = this.#pending.slice(end + 1);
		}
		if (this.#pending.length > 8192) this.flush();
	}

	flush(): void {
		if (this.#pending) this.emit(redact(this.#pending));
		this.#pending = "";
	}
}
