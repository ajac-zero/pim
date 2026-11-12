/**
 * Finding the ```ui blocks in a message's Markdown. The Worker and the web
 * app both do it, with this one function, so that a block is the same block
 * to each: the one Pim keeps state for under an id both work out alike (see
 * `uiBlockIds`).
 */

/** One ```ui fence of a text. */
export type UiFence = {
	/** What is between its fences. */
	source: string;
	/** Where its opening line's info string starts and where its line ends, as offsets into the text. */
	info: { from: number; to: number };
	/** Whether the text ended before its closing fence, as a message still arriving does. */
	open: boolean;
};

/** An opening or closing fence line: its mark, then the first word of its info string. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;

/**
 * The ```ui fences of a text, in order. Only the last can be open. A fence
 * inside another fence, such as a ```md block that shows one, is that block's
 * text and not a fence of its own; `ui-response` and the like are other
 * languages.
 */
export function uiFences(text: string): UiFence[] {
	const fences: UiFence[] = [];
	let fence: { mark: string; length: number; ui: boolean; info: UiFence["info"]; from: number } | null = null;
	let offset = 0;
	for (const line of text.split("\n")) {
		const found = FENCE_LINE.exec(line);
		if (found) {
			const mark = found[1] as string;
			if (fence === null) {
				fence = {
					mark: mark[0] as string,
					length: mark.length,
					ui: found[2] === "ui",
					info: { from: offset + line.indexOf(mark) + mark.length, to: offset + line.length },
					from: offset + line.length + 1,
				};
			} else if (mark[0] === fence.mark && mark.length >= fence.length && line.trim() === mark) {
				if (fence.ui) fences.push({ source: text.slice(fence.from, Math.max(fence.from, offset - 1)), info: fence.info, open: false });
				fence = null;
			}
		}
		offset += line.length + 1;
	}
	if (fence?.ui) fences.push({ source: text.slice(fence.from), info: fence.info, open: true });
	return fences;
}

/** The sources of the ```ui blocks of a text that are whole, as a message sent has them. */
export function closedUiSources(text: string): string[] {
	return uiFences(text).filter((fence) => !fence.open).map((fence) => fence.source);
}
