import { diffIndices } from "node-diff3";
import { FILE_CHANGES } from "./transcript";

/**
 * What an agent is told of the files it has seen that changed since: the
 * person edits them in the app's code editor, or something else on the
 * computer does. The chat remembers each file it read or wrote as a hash,
 * and as its text while that is small; the next message the person sends
 * carries a short block with what differs (see `#fileChanges` in ./pim.ts).
 * The app hides the block from the person's own message (./transcript.ts).
 */

/** How many files a chat remembers, the most recently seen first. */
export const MAX_SEEN_FILES = 20;
/** The largest file whose text is kept for a diff; a bigger one is only reported as changed. */
export const MAX_SEEN_BYTES = 64 * 1024;
/** How many files one block names, how many lines of changes each shows, and how long the whole block may be. */
const MAX_BLOCK_FILES = 8;
const MAX_DIFF_LINES = 24;
const MAX_LINE_CHARS = 160;
const MAX_BLOCK_CHARS = 4_000;

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
	Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The text of bytes the diff can show: none when they hold a NUL early on or aren't UTF-8. */
export function textOf(bytes: Uint8Array): string | null {
	if (bytes.subarray(0, 8192).includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
}

const clip = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line);

/** The lines that differ between two texts, as `-` and `+` lines under `@@` headings, and none past a few. */
export function smallDiff(before: string, after: string): string {
	const out: string[] = [];
	let shown = 0;
	let hidden = 0;
	for (const hunk of diffIndices(before.split("\n"), after.split("\n"))) {
		const lines = [...hunk.buffer1Content.map((line) => `-${clip(line)}`), ...hunk.buffer2Content.map((line) => `+${clip(line)}`)];
		if (shown >= MAX_DIFF_LINES) {
			hidden += lines.length;
			continue;
		}
		out.push(`@@ line ${hunk.buffer1[0] + 1} @@`);
		for (const line of lines) {
			if (shown < MAX_DIFF_LINES) {
				out.push(line);
				shown++;
			} else hidden++;
		}
	}
	if (hidden > 0) out.push(`... ${hidden} more changed lines`);
	return out.join("\n");
}

/** One seen file as it is now: gone, or its hash and size, with its text when it is small text. */
export type FileNow = { readonly exists: false } | { readonly exists: true; readonly sha256: string; readonly size: number; readonly text: string | null };

/** What changed in a file since it was seen, as the lines that tell it, or null when nothing did. */
export function changeOf(path: string, seen: { sha256: string; text: string | null }, now: FileNow): string | null {
	if (!now.exists) return `${path} (deleted)`;
	if (now.sha256 === seen.sha256) return null;
	if (seen.text === null || now.text === null) return `${path} (changed, ${now.size} bytes; no diff shown)`;
	const diff = smallDiff(seen.text, now.text);
	return `${path} (changed)${diff === "" ? "" : `\n${diff}`}`;
}

/** The block that goes before the person's message, or null when no file changed. */
export function changesBlock(changes: readonly string[]): string | null {
	if (changes.length === 0) return null;
	const parts: string[] = [];
	let used = FILE_CHANGES.length;
	for (const change of changes.slice(0, MAX_BLOCK_FILES)) {
		const room = Math.max(0, MAX_BLOCK_CHARS - used);
		parts.push(change.length > room ? `${change.slice(0, room)}\n... (cut)` : change);
		used += change.length;
		if (used >= MAX_BLOCK_CHARS) break;
	}
	const left = changes.length - parts.length;
	if (left > 0) parts.push(`... and ${left} more files changed`);
	return `${FILE_CHANGES}\n${parts.join("\n")}\n\n`;
}
