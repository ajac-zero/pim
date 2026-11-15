/**
 * Markdown with its code blanked: `text` with every fenced code block and inline code span replaced by
 * spaces (newlines kept), so each index in the result is the same index in `text`. For finding what a
 * message says outside its code, such as images and tags a person never meant as code.
 */
export function maskCode(text: string): string {
	const blank = (code: string) => code.replace(/[^\n]/g, " ");
	let fence: { char: string; length: number } | null = null;
	const lines = text.split("\n").map((line) => {
		const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (open && open[1]![0] === fence.char && open[1]!.length >= fence.length && /^\s*$/.test(line.slice(open[0].length))) fence = null;
			return blank(line);
		}
		if (open) {
			fence = { char: open[1]![0]!, length: open[1]!.length };
			return blank(line);
		}
		return line;
	});
	return lines.join("\n").replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, blank);
}
