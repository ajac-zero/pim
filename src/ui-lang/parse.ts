/**
 * The parser of the ```ui language: Markdown text plus native component tags,
 * {expr} interpolation, one-per-line statements and {#if}/{#each} blocks. It
 * is written to be repaired rather than refused: text cut off anywhere, such
 * as a reply still arriving, parses as the part that is whole — an element
 * or block still open is closed with the content it has, and a tag,
 * statement or expression still being written is dropped. Nothing it reads
 * can throw past it; what it couldn't make sense of becomes a diagnostic.
 */

import { MAX_DEPTH, MAX_NODES, MAX_SOURCE_BYTES } from "./limits";

/** How tall one expression's tree may be, which bounds the recursion that checks and works it out. */
const MAX_EXPR_DEPTH = 100;
/** How many warnings a block collects; errors are always kept, so a block's validity never depends on the cap. */
const MAX_WARNINGS = 100;
/** How many characters failed constructs may have read in all, a few times the longest source. */
const MAX_REREAD = 8 * MAX_SOURCE_BYTES;

/** A property a model may not name, because reaching it would reach the interpreter's own machinery. */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export type Diagnostic = {
	/** What went wrong, as a short code such as `unknown_tag`. */
	code: string;
	message: string;
	/** The line it happened on, from 1. */
	line: number;
	/** Whether the block can still be drawn. */
	severity: "error" | "warning";
};

/** The functions an expression may call. */
export const BUILTIN_NAMES = new Set([
	"abs",
	"round",
	"floor",
	"ceil",
	"min",
	"max",
	"sum",
	"len",
	"map",
	"filter",
	"join",
	"str",
	"num",
	"close",
	"eq",
	"submitted",
	"score",
	"count",
	"formSummary",
]);

/** The actions a handler's action list may run. */
export const ACTION_NAMES = new Set(["reveal", "issueNewTurn", "copy"]);

/** Every name a call may have while parsing; which may go where is a matter of validation. */
const CALLABLE = new Set([...BUILTIN_NAMES, ...ACTION_NAMES]);

/** An expression, as parsed: values, names, operators and builtin calls only. */
export type Expr =
	| { t: "num"; v: number }
	| { t: "str"; v: string }
	| { t: "bool"; v: boolean }
	| { t: "null" }
	| { t: "arr"; items: Expr[] }
	| { t: "obj"; entries: [string, Expr][] }
	| { t: "var"; name: string }
	| { t: "member"; of: Expr; prop: string }
	| { t: "index"; of: Expr; at: Expr }
	| { t: "un"; op: "!" | "-"; of: Expr }
	| { t: "bin"; op: string; a: Expr; b: Expr }
	| { t: "cond"; if: Expr; then: Expr; else: Expr }
	| { t: "call"; name: string; args: Expr[] };

/** One stretch of text, or the expression it interpolates. */
export type Part = { c: string } | { e: Expr };

export type RawNode =
	| { t: "md"; parts: Part[] }
	| { t: "text"; parts: Part[] }
	| { t: "el"; tag: string; props: Record<string, Expr>; children: RawNode[] }
	| { t: "if"; cond: Expr; then: RawNode[]; other: RawNode[] }
	| { t: "each"; list: Expr; item: string | null; index: string | null; body: RawNode[] }
	| { t: "decl"; state: boolean; name: string; value: Expr };

/** A parsed block: its nodes, and what was wrong with it. */
export type Parsed = { nodes: RawNode[]; diagnostics: Diagnostic[] };

/** Thrown within the parser to abandon one construct; caught at the one that began it. */
class Broken extends Error {}

/** A cursor over the block's source, with the diagnostics it collects. */
class Parser {
	private pos = 0;
	private count = 0;
	/** Set once the tree is over a limit; parsing goes on, but adds nothing. */
	private full = false;
	/** Where each line starts, worked out when a diagnostic first needs a line. */
	private lineStarts: number[] | null = null;
	private warnings = 0;
	/** How much source constructs that failed had read, which is read again as text: bounded, so many broken tags can't make the parse quadratic. */
	private reread = 0;

	constructor(
		private readonly source: string,
		private readonly diagnostics: Diagnostic[],
		/** Whether the source is a block still being written, which ends wherever the writer has got to. */
		private readonly partial = false,
	) {}

	private rest(): string {
		return this.source.slice(this.pos);
	}

	/** The line a position is on, for diagnostics about what was read up to it. */
	private lineAt(pos: number): number {
		if (this.lineStarts === null) {
			this.lineStarts = [0];
			for (let i = 0; i < this.source.length; i++) {
				if (this.source[i] === "\n") this.lineStarts.push(i + 1);
			}
		}
		// The last line that starts at or before pos.
		let low = 0;
		let high = this.lineStarts.length - 1;
		const at = Math.min(pos, this.source.length);
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if (this.lineStarts[middle]! <= at) low = middle;
			else high = middle - 1;
		}
		return low + 1;
	}

	private say(code: string, message: string, pos: number, severity: "error" | "warning" = "warning") {
		if (severity === "warning" && ++this.warnings > MAX_WARNINGS) return;
		this.diagnostics.push({ code, message, line: this.lineAt(pos), severity });
	}

	/** Gives up on the rest of the source, once a limit is past: what is read so far stands. */
	private stop(): void {
		this.full = true;
		this.pos = this.source.length;
	}

	/**
	 * Whether a construct that failed was cut off by the end of a block still
	 * being written. If so, all of it is dropped, rather than left as text.
	 */
	private cutOff(): boolean {
		if (!this.partial || this.pos < this.source.length) return false;
		return true;
	}

	/** Reads past `text` when it is next. */
	private eat(text: string): boolean {
		if (!this.source.startsWith(text, this.pos)) return false;
		this.pos += text.length;
		return true;
	}

	/** Reads past one character that is there. */
	private take(): string {
		const c = this.source[this.pos];
		this.pos++;
		return c ?? "";
	}

	/** Rewinds to before a construct that failed, so its text is read as text. */
	private rewind(start: number): void {
		this.reread += Math.max(0, this.pos - start);
		this.pos = start;
		if (this.reread > MAX_REREAD) {
			this.say("too_complex", "the block has too many tags and braces that never close", start, "error");
			this.stop();
		}
	}

	private skipSpace(): void {
		while (/\s/.test(this.source[this.pos] ?? "")) this.take();
	}

	private isDigit(c: string | undefined): boolean {
		return c !== undefined && c >= "0" && c <= "9";
	}

	/** An identifier, or null: a name for a variable, a property or a call. */
	private ident(): string | null {
		const c = this.source[this.pos];
		if (c === undefined || !/[a-zA-Z_]/.test(c)) return null;
		let end = this.pos + 1;
		while (end < this.source.length && /[\w]/.test(this.source[end]!)) end++;
		const name = this.source.slice(this.pos, end);
		this.pos = end;
		return name;
	}

	/* ------------------------------ expressions ----------------------------- */

	expression(depth = 0): Expr {
		if (depth > 64) throw new Broken();
		const expr = this.ternary(depth);
		// Chains of operators and members are read in a loop, so only the finished tree says how tall it is.
		if (depth === 0 && height(expr) > MAX_EXPR_DEPTH) throw new Broken();
		return expr;
	}

	private ternary(depth: number): Expr {
		if (depth > 64) throw new Broken();
		const cond = this.binary(0, depth);
		this.skipSpace();
		if (!this.eat("?")) return cond;
		const then = this.ternary(depth + 1);
		this.skipSpace();
		if (!this.eat(":")) throw new Broken();
		return { t: "cond", if: cond, then, else: this.ternary(depth + 1) };
	}

	/** Binary operators by level, tightest last. */
	private static readonly LEVELS = [
		["||"],
		["&&"],
		["==", "!="],
		["<", "<=", ">", ">="],
		["+", "-"],
		["*", "/", "%"],
	] as const;

	private binary(level: number, depth: number): Expr {
		const ops = Parser.LEVELS[level];
		if (ops === undefined) return this.unary(depth);
		let left = this.binary(level + 1, depth);
		for (;;) {
			this.skipSpace();
			const op = ops.find(
				(candidate) => this.source.startsWith(candidate, this.pos) && !this.source.startsWith(candidate + "=", this.pos),
			);
			if (op === undefined) return left;
			this.eat(op);
			left = { t: "bin", op, a: left, b: this.binary(level + 1, depth) };
		}
	}

	private unary(depth: number): Expr {
		this.skipSpace();
		if (depth > 64) throw new Broken();
		if (this.eat("!")) return { t: "un", op: "!", of: this.unary(depth + 1) };
		if (this.eat("-")) return { t: "un", op: "-", of: this.unary(depth + 1) };
		return this.postfix(this.primary(depth), depth);
	}

	private postfix(of: Expr, depth: number): Expr {
		for (;;) {
			if (this.eat(".")) {
				const prop = this.ident();
				if (prop === null || FORBIDDEN.has(prop)) throw new Broken();
				of = { t: "member", of, prop };
				continue;
			}
			if (this.source[this.pos] === "[") {
				this.take();
				const at = this.expression(depth + 1);
				if (at.t === "str" && FORBIDDEN.has(at.v)) throw new Broken();
				this.skipSpace();
				if (!this.eat("]")) throw new Broken();
				of = { t: "index", of, at };
				continue;
			}
			return of;
		}
	}

	private primary(depth: number): Expr {
		this.skipSpace();
		const c = this.source[this.pos];
		if (c === undefined) throw new Broken();
		if (c === '"' || c === "'") return { t: "str", v: this.string(c) };
		if (this.isDigit(c)) return { t: "num", v: this.number() };
		if (c === "(") {
			this.take();
			const inner = this.expression(depth + 1);
			this.skipSpace();
			if (!this.eat(")")) throw new Broken();
			return inner;
		}
		if (c === "[") {
			this.take();
			const items: Expr[] = [];
			this.skipSpace();
			while (this.source[this.pos] !== "]") {
				if (this.source[this.pos] === undefined) throw new Broken();
				items.push(this.expression(depth + 1));
				this.skipSpace();
				if (!this.eat(",")) break;
				this.skipSpace();
			}
			this.skipSpace();
			if (!this.eat("]")) throw new Broken();
			return { t: "arr", items };
		}
		if (c === "{") {
			this.take();
			const entries: [string, Expr][] = [];
			this.skipSpace();
			while (this.source[this.pos] !== "}") {
				if (this.source[this.pos] === undefined) throw new Broken();
				const quoted = this.source[this.pos] === '"' || this.source[this.pos] === "'";
				const key = quoted ? this.string(this.source[this.pos]!) : this.ident();
				if (key === null || FORBIDDEN.has(key)) throw new Broken();
				this.skipSpace();
				if (!this.eat(":")) throw new Broken();
				entries.push([key, this.expression(depth + 1)]);
				this.skipSpace();
				if (!this.eat(",")) break;
				this.skipSpace();
			}
			this.skipSpace();
			if (!this.eat("}")) throw new Broken();
			return { t: "obj", entries };
		}
		const name = this.ident();
		if (name === null) throw new Broken();
		if (name === "true" || name === "false") return { t: "bool", v: name === "true" };
		if (name === "null") return { t: "null" };
		this.skipSpace();
		if (this.source[this.pos] === "(") {
			if (!CALLABLE.has(name)) throw new Broken();
			this.take();
			const args: Expr[] = [];
			this.skipSpace();
			while (this.source[this.pos] !== ")") {
				if (this.source[this.pos] === undefined) throw new Broken();
				args.push(this.expression(depth + 1));
				this.skipSpace();
				if (!this.eat(",")) break;
				this.skipSpace();
			}
			this.skipSpace();
			if (!this.eat(")")) throw new Broken();
			return { t: "call", name, args };
		}
		return { t: "var", name };
	}

	/** A number, as JavaScript writes one: digits, a point and an exponent. */
	private number(): number {
		let end = this.pos;
		while (this.isDigit(this.source[end])) end++;
		if (this.source[end] === ".") {
			end++;
			while (this.isDigit(this.source[end])) end++;
		}
		if (this.source[end] === "e" || this.source[end] === "E") {
			let look = end + 1;
			if (this.source[look] === "+" || this.source[look] === "-") look++;
			if (this.isDigit(this.source[look])) {
				end = look;
				while (this.isDigit(this.source[end])) end++;
			}
		}
		const text = this.source.slice(this.pos, end);
		this.pos = end;
		return Number(text);
	}

	/** A quoted string, with backslash escapes; it ends at its own kind of quote. */
	private string(quote: string): string {
		this.take();
		let text = "";
		for (;;) {
			const c = this.source[this.pos];
			if (c === undefined || c === "\n") throw new Broken();
			if (c === quote) {
				this.take();
				return text;
			}
			this.take();
			if (c !== "\\") {
				text += c;
				continue;
			}
			const escape = this.source[this.pos];
			if (escape === undefined) throw new Broken();
			this.take();
			text += escape === "n" ? "\n" : escape === "t" ? "\t" : escape === "r" ? "\r" : escape;
		}
	}

	/* ------------------------------- the block ------------------------------ */

	/** The nodes of the whole block. */
	all(): RawNode[] {
		return this.nodes([], true, 0);
	}

	/** The nodes until one of `stops` shows or the source ends; the stop is left unread. */
	private nodes(stops: readonly string[], md: boolean, depth: number): RawNode[] {
		const nodes: RawNode[] = [];
		let text = "";
		const flush = () => {
			if (text !== "") {
				this.add(nodes, md ? { t: "md", parts: [{ c: text }] } : { t: "text", parts: [{ c: text }] }, depth);
				text = "";
			}
		};
		while (this.pos < this.source.length) {
			const c = this.source[this.pos]!;
			if (c === "<") {
				if (this.source[this.pos + 1] === "/") {
					const name = /^<\/([a-z][a-z0-9]*)/.exec(this.rest());
					if (name && stops.includes(`</${name[1]}>`)) {
						flush();
						return nodes;
					}
					// A close that is nobody's here reads as text, which shows what was meant.
					flush();
					this.say("stray_end", `</${name?.[1] ?? ""}> closes nothing here`, this.pos);
					this.pos += name ? name[0].length : 2;
					continue;
				}
				const node = this.element(md, depth);
				if (node) {
					flush();
					this.add(nodes, node, depth);
				} else text += this.take();
				continue;
			}
			if (c === "{") {
				if (stops.some((token) => this.source.startsWith(token, this.pos))) {
					flush();
					return nodes;
				}
				const control = this.source.startsWith("{#", this.pos) || this.source.startsWith("{:", this.pos);
				if (control) {
					const node = this.control(md, depth);
					if (node) {
						flush();
						this.add(nodes, node, depth);
					} else text += this.take();
					continue;
				}
				if (this.source.startsWith("{@", this.pos)) {
					const node = this.statement();
					if (node) {
						flush();
						this.add(nodes, node, depth);
					} else text += this.take();
					continue;
				}
				const part = this.interpolation();
				if (part) {
					flush();
					this.add(nodes, md ? { t: "md", parts: [part] } : { t: "text", parts: [part] }, depth);
				} else text += this.take();
				continue;
			}
			text += this.take();
		}
		flush();
		return nodes;
	}

	/** Adds a node, keeping to the limits: once the tree is full, or the block too deep, nothing more is added. */
	private add(nodes: RawNode[], node: RawNode, depth: number): void {
		if (this.full) return;
		if (++this.count > MAX_NODES) {
			this.full = true;
			this.say("too_many_nodes", `the block has more than ${MAX_NODES} nodes`, this.pos, "error");
			return;
		}
		nodes.push(node);
	}

	/** {expr} as one part, or null to leave the brace as text. */
	private interpolation(): Part | null {
		const start = this.pos;
		this.take();
		try {
			const expr = this.expression();
			this.skipSpace();
			if (!this.eat("}")) throw new Broken();
			return { e: expr };
		} catch {
			if (this.cutOff()) {
				this.say("unterminated_braced_value", "a {…} ends where the source does", start);
				return null;
			}
			this.say("invalid_expression", "a {…} didn't parse as an expression", start);
			this.rewind(start);
			return null;
		}
	}

	/** {@state name = expr} or {@let name = expr}, alone on its line. */
	private statement(): RawNode | null {
		const start = this.pos;
		const lineStart = this.source.lastIndexOf("\n", this.pos - 1) + 1;
		if (this.source.slice(lineStart, this.pos).trim() !== "") {
			this.say("invalid_statement", "a {@…} statement must be alone on its line", start);
			return null;
		}
		this.pos += 2;
		try {
			this.skipSpace();
			const kind = this.ident();
			if (kind !== "state" && kind !== "let") throw new Broken();
			this.skipSpace();
			const name = this.ident();
			if (name === null || FORBIDDEN.has(name)) throw new Broken();
			this.skipSpace();
			if (!this.eat("=")) throw new Broken();
			const value = this.expression();
			this.skipSpace();
			if (!this.eat("}")) throw new Broken();
			const lineEnd = this.source.indexOf("\n", this.pos);
			if (this.source.slice(this.pos, lineEnd === -1 ? this.source.length : lineEnd).trim() !== "") {
				this.say("invalid_statement", `a {@${kind}} statement must be alone on its line`, start);
				this.rewind(start);
				return null;
			}
			return { t: "decl", state: kind === "state", name, value };
		} catch {
			if (this.cutOff()) {
				this.say("unterminated_statement", "a {@…} statement ends where the source does", start);
				return null;
			}
			this.say("unterminated_statement", "a {@…} statement didn't parse", start);
			this.rewind(start);
			return null;
		}
	}

	/** {#if} and {#each} blocks, or {:else}, which a body's reader stops at. */
	private control(md: boolean, depth: number): RawNode | null {
		const start = this.pos;
		if (this.eat("{:else}")) {
			this.say("stray_else", "{:else} belongs to a {#if}", start);
			return null;
		}
		this.pos += 2;
		try {
			const kind = this.ident();
			this.skipSpace();
			if (kind === "if") {
				const cond = this.expression();
				this.skipSpace();
				if (!this.eat("}")) throw new Broken();
				if (depth >= MAX_DEPTH) {
					this.say("too_deep", `the block nests deeper than ${MAX_DEPTH}`, start, "error");
					this.stop();
					return null;
				}
				const then = this.nodes(["{:else}", "{/if}"], md, depth + 1);
				const other = this.eat("{:else}") ? this.nodes(["{/if}"], md, depth + 1) : [];
				if (!this.eat("{/if}")) this.say("unterminated_block", "a {#if} ends where the source does", start);
				return { t: "if", cond, then, other };
			}
			if (kind === "each") {
				const list = this.expression();
				this.skipSpace();
				let item: string | null = null;
				let index: string | null = null;
				if (this.eat("as")) {
					this.skipSpace();
					item = this.ident();
					if (item === null || FORBIDDEN.has(item)) throw new Broken();
					if (this.eat(",")) {
						this.skipSpace();
						index = this.ident();
						if (index === null || FORBIDDEN.has(index)) throw new Broken();
					}
				}
				this.skipSpace();
				if (!this.eat("}")) throw new Broken();
				if (depth >= MAX_DEPTH) {
					this.say("too_deep", `the block nests deeper than ${MAX_DEPTH}`, start, "error");
					this.stop();
					return null;
				}
				const body = this.nodes(["{/each}"], md, depth + 1);
				if (!this.eat("{/each}")) this.say("unterminated_block", "an {#each} ends where the source does", start);
				return { t: "each", list, item, index, body };
			}
			throw new Broken();
		} catch {
			if (this.cutOff()) {
				this.say("unterminated_block", "a {#…} tag ends where the source does", start);
				return null;
			}
			this.say("invalid_block", "a {#…} block didn't parse", start);
			this.rewind(start);
			return null;
		}
	}

	/** One element, or null to leave the `<` as text, such as a tag cut off mid-write. */
	private element(md: boolean, depth: number): RawNode | null {
		const start = this.pos;
		const tag = /^<([a-z][a-z0-9]*)/.exec(this.rest());
		if (tag === null) {
			// A `<` that is the last thing written is the start of a tag.
			if (this.partial && this.rest() === "<") {
				this.say("unterminated_tag", "a tag starts where the source ends", start);
				this.pos = this.source.length;
			}
			return null;
		}
		this.pos += tag[0].length;
		// Without a prototype, so a prop called `__proto__` is a prop to be refused, not a way to set one.
		const props: Record<string, Expr> = Object.create(null);
		try {
			for (;;) {
				this.skipSpace();
				if (this.source[this.pos] === undefined) throw new Broken();
				if (this.eat("/>")) return { t: "el", tag: tag[1]!, props, children: [] };
				if (this.eat(">")) break;
				const name = this.ident();
				if (name === null) {
					this.say("invalid_tag", `<${tag[1]} has a property that didn't parse`, this.pos);
					this.take();
					continue;
				}
				this.skipSpace();
				if (this.eat("=")) {
					this.skipSpace();
					const c = this.source[this.pos];
					if (c === '"' || c === "'") props[name] = { t: "str", v: this.string(c) };
					else if (c === "{") {
						// Braced: the expression between the braces, not an object literal of one.
						this.take();
						props[name] = this.expression();
						this.skipSpace();
						if (!this.eat("}")) throw new Broken();
					} else props[name] = this.expression();
				} else props[name] = { t: "bool", v: true };
			}
		} catch {
			// A tag still being written is dropped; the source before it stands.
			this.say("unterminated_tag", `the <${tag[1]}> tag ends where the source does`, start);
			if (!this.cutOff()) this.rewind(start);
			return null;
		}
		if (depth >= MAX_DEPTH) {
			this.say("too_deep", `the block nests deeper than ${MAX_DEPTH}`, start, "error");
			this.stop();
			return null;
		}
		const children = this.nodes([`</${tag[1]}>`], md, depth + 1);
		if (!this.eat(`</${tag[1]}>`)) {
			this.say("unterminated_tag", `the <${tag[1]}> element ends where the source does`, start);
			// An element still being written is closed if it has content, and dropped if it has none.
			if (this.partial && children.every(isBlank)) return null;
		}
		return { t: "el", tag: tag[1]!, props, children };
	}
}

/** How tall an expression's tree is, counted without recursion. */
function height(expr: Expr): number {
	let tallest = 0;
	const todo: [Expr, number][] = [[expr, 1]];
	for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
		const [node, level] = next;
		tallest = Math.max(tallest, level);
		if (tallest > MAX_EXPR_DEPTH) return tallest;
		const children: Expr[] =
			node.t === "arr" ? node.items
			: node.t === "obj" ? node.entries.map(([, value]) => value)
			: node.t === "member" ? [node.of]
			: node.t === "index" ? [node.of, node.at]
			: node.t === "un" ? [node.of]
			: node.t === "bin" ? [node.a, node.b]
			: node.t === "cond" ? [node.if, node.then, node.else]
			: node.t === "call" ? node.args
			: [];
		for (const child of children) todo.push([child, level + 1]);
	}
	return tallest;
}

/** Whether a node draws nothing: text of only space. */
function isBlank(node: RawNode): boolean {
	return (node.t === "md" || node.t === "text") && node.parts.every((part) => "c" in part && part.c.trim() === "");
}

/**
 * Parses a block's source. What it can't read whole it repairs as the part
 * that is complete, and says so; nothing throws. With `partial`, the source
 * is a block still being written: what is cut off at its end, an unfinished
 * tag, statement or `{…}`, is dropped, an open element with content is
 * closed, and one without is dropped. The text so far is kept.
 */
export function parse(source: string, options: { partial?: boolean } = {}): Parsed {
	const diagnostics: Diagnostic[] = [];
	const nodes = new Parser(source, diagnostics, options.partial === true).all();
	return { nodes, diagnostics };
}
