/**
 * Compiles a ```ui block: parses it, repairs what was cut off, checks it
 * against the catalog and lays it out as a program — JSON with its text in a
 * table and a key for everything stateful — plus the Markdown that stands in
 * for it where it can't be drawn. A mistake the model made doesn't stop the
 * block: what can't be used is dropped and said, and what is left still
 * draws. An answer a form checks against stays out of the fallback, which
 * shows where the answers go, not what they are.
 */

import { CATALOG, CATALOG_VERSION, type PropSpec } from "./catalog";
import { MAX_SOURCE_BYTES } from "./limits";
import { ACTION_NAMES, parse, BUILTIN_NAMES, type Diagnostic, type Expr, type RawNode } from "./parse";
import type { ActionName, ActionSpec, Node, NodePart, PropValue, UiProgram } from "./program";
import { evaluate, type RenderNode } from "./evaluate";
import { initialState } from "./evaluate";
import { arityOk, evalExpr, Steps, type Field, type FormSpec, type Value } from "./value";

/** One action's arguments, as an expression each. */
const ACTION_ARITY: Record<ActionName, number> = { reveal: 0, issueNewTurn: 1, copy: 1 };

/** The tags that hold a person's answers. */
const FIELD_TAGS = ["number", "input", "select"] as const;

/**
 * Compiles a block's source to its program. Whatever is wrong with it comes
 * back as diagnostics on the program, not as an exception; nothing throws.
 */
export function compile(source: string): UiProgram {
	const compiler = new Compiler();
	const program = compiler.compile(source);
	return program;
}

class Compiler {
	private readonly diagnostics: Diagnostic[] = [];
	private readonly texts: string[] = [];
	private readonly interned = new Map<string, number>();
	private readonly forms: Record<string, FormSpec> = {};
	private readonly stateKeys: string[] = [];
	private readonly initial: Record<string, Value> = {};
	private readonly constants = new Map<string, Value>();
	private buttons = 0;

	private say(severity: "error" | "warning", code: string, message: string) {
		this.diagnostics.push({ code, message, line: 0, severity });
	}

	compile(source: string): UiProgram {
		if (source.length > MAX_SOURCE_BYTES) {
			this.say("error", "too_long_source", `A ui block may be at most ${MAX_SOURCE_BYTES} bytes; this one is ${source.length}.`);
			return this.finish([]);
		}
		const parsed = parse(source);
		this.diagnostics.push(...parsed.diagnostics);
		const nodes = this.nodes(parsed.nodes, "any", null);
		return this.finish(nodes);
	}

	private finish(nodes: Node[]): UiProgram {
		const program: UiProgram = {
			version: CATALOG_VERSION,
			nodes,
			texts: this.texts,
			initial: this.initial,
			stateKeys: this.stateKeys,
			forms: this.forms,
			diagnostics: this.diagnostics,
			fallbackMarkdown: "",
			valid: this.diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
		};
		// The fallback is the block as it first draws, which needs nothing from
		// the person. It is made even where something was wrong, of what was
		// left; when even that can't be worked out, there is nothing to stand in.
		try {
			const drawn = evaluate(program, initialState(program), null);
			if (drawn.error !== null) {
				this.say("error", "runtime_error", drawn.error);
				return { ...program, valid: false };
			}
			return { ...program, fallbackMarkdown: markdownOf(drawn.tree) };
		} catch {
			this.say("error", "runtime_error", "The block didn't work out.");
			return { ...program, valid: false };
		}
	}

	/** The block's text, each stretch once. */
	private text(value: string): number {
		const known = this.interned.get(value);
		if (known !== undefined) return known;
		this.texts.push(value);
		const index = this.texts.length - 1;
		this.interned.set(value, index);
		return index;
	}

	/** The nodes of a body, checked against what its parent may hold. */
	private nodes(raw: RawNode[], allowed: "any" | "text" | "rows" | "cells", form: FormSpec | null): Node[] {
		const nodes: Node[] = [];
		for (const node of raw) {
			switch (node.t) {
				case "md":
				case "text": {
					const run = node.parts.map((part) => ("c" in part ? part.c : "")).join("");
					if (allowed === "rows" || allowed === "cells") {
						// What lies between a table's rows is layout, not text.
						if (run.trim() === "") continue;
						this.say("warning", "invalid_children", `${allowed === "rows" ? "A table" : "A row"} holds only ${allowed}, not text.`);
						continue;
					}
					nodes.push({ t: node.t, parts: node.parts.map((part) => this.part(part)) });
					break;
				}
				case "decl":
					if (allowed !== "any") {
						this.say("warning", "invalid_children", "A statement goes in the block's own body, not inside text.");
						continue;
					}
					nodes.push(this.decl(node, form));
					break;
				case "if":
					if (allowed !== "any") {
						this.say("warning", "invalid_children", "An {#if} goes in the block's own body, not inside text.");
						continue;
					}
					this.check(node.cond);
					nodes.push({
						t: "if",
						cond: node.cond,
						then: this.nodes(node.then, allowed, form),
						other: this.nodes(node.other, allowed, form),
					});
					break;
				case "each":
					if (allowed !== "any") {
						this.say("warning", "invalid_children", "An {#each} goes in the block's own body, not inside text.");
						continue;
					}
					this.check(node.list);
					nodes.push({
						t: "each",
						list: node.list,
						item: node.item,
						index: node.index,
						body: this.nodes(node.body, allowed, form),
					});
					break;
				case "el":
					if (allowed === "text") {
						this.say("warning", "invalid_children", `Only text goes inside here, not a <${node.tag}>.`);
						continue;
					}
					if (allowed === "rows" && node.tag !== "row") {
						this.say("warning", "invalid_children", "A table holds only rows.");
						continue;
					}
					if (allowed === "cells" && node.tag !== "cell") {
						this.say("warning", "invalid_children", "A row holds only cells.");
						continue;
					}
					const el = this.el(node, form);
					if (el) nodes.push(el);
					break;
			}
		}
		return nodes;
	}

	private part(part: { c: string } | { e: Expr }): NodePart {
		if ("c" in part) return { c: this.text(part.c) };
		this.check(part.e);
		return { e: part.e };
	}

	private decl(node: Extract<RawNode, { t: "decl" }>, _form: FormSpec | null): Node {
		const name = node.name;
		const known = this.constants.has(name);
		const folded = this.fold(node.value);
		if (node.state) {
			if (!this.stateKeys.includes(name)) this.stateKeys.push(name);
			if (folded !== null && !known) this.initial[name] = folded;
		}
		if (folded !== null) this.constants.set(name, folded);
		else this.constants.delete(name);
		return { t: "decl", key: name, e: node.value, state: node.state };
	}

	/** Works an expression out with what is known at compile time, or null when it needs the block to run. */
	private fold(expr: Expr): Value | null {
		try {
			return evalExpr(expr, this.constants, null, null, new Steps(2000));
		} catch {
			return null;
		}
	}

	private el(node: Extract<RawNode, { t: "el" }>, form: FormSpec | null): Node | null {
		const spec = CATALOG[node.tag];
		if (spec === undefined) {
			this.say("error", "unknown_tag", `<${node.tag}> is not one of the components a ui block may draw.`);
			return null;
		}
		const props: Record<string, PropValue> = {};
		for (const [name, expr] of Object.entries(node.props)) {
			const prop = spec.props[name];
			if (prop === undefined) {
				this.say("warning", "unknown_prop", `<${node.tag}> has no ${name}.`);
				continue;
			}
			const value = this.prop(node.tag, name, prop, expr);
			if (value !== null) props[name] = value;
		}
		for (const [name, prop] of Object.entries(spec.props)) {
			if (prop.required && props[name] === undefined) {
				this.say("error", "missing_prop", `A <${node.tag}> needs its ${name}.`);
				return null;
			}
		}
		// What a form is called, what a field is called and what a choice offers must be written plainly.
		for (const name of ["id", "name", "options"] as const) {
			const value = props[name];
			if (value !== undefined && value.k !== "const") {
				this.say("error", "invalid_literal", `A <${node.tag}>'s ${name} must be plain, not worked out.`);
				return null;
			}
		}
		if (node.tag === "form") return this.form(node, props, form);
		if ((FIELD_TAGS as readonly string[]).includes(node.tag)) return this.field(node, props, form);
		const key = node.tag === "button" && props.onClick !== undefined ? `b${this.buttons++}` : undefined;
		if (spec.children === "none" && node.children.length > 0) {
			this.say("warning", "invalid_children", `<${node.tag}> takes no children.`);
		}
		const children = spec.children === "none" ? [] : this.nodes(node.children, spec.children, form);
		if (spec.children === "text") {
			// Only text was kept of what it was given.
			return { t: "el", tag: node.tag, props, children: children.filter((child) => child.t === "md" || child.t === "text"), key };
		}
		return { t: "el", tag: node.tag, props, children, key };
	}

	/** One prop, checked against its kind; null drops it. */
	private prop(tag: string, name: string, spec: PropSpec, expr: Expr): PropValue | null {
		if (spec.kind === "actions") return this.actions(tag, name, expr);
		const folded = this.fold(expr);
		if (folded === null) {
			this.check(expr);
			return { k: "expr", e: expr };
		}
		const wrong = (what: string) => {
			this.say("warning", "invalid_literal", `${tag}'s ${name} is not ${what}: ${whatOf(folded)}.`);
			return null;
		};
		switch (spec.kind) {
			case "string":
				return typeof folded === "string" ? { k: "const", v: folded } : wrong("text");
			case "number":
				return typeof folded === "number" ? { k: "const", v: folded } : wrong("a number");
			case "boolean":
				return typeof folded === "boolean" ? { k: "const", v: folded } : wrong("true or false");
			case "strings":
				return Array.isArray(folded) && folded.every((item) => typeof item === "string") ? { k: "const", v: folded } : wrong("a list of texts");
			case "enum":
				return typeof folded === "string" && spec.values?.includes(folded) === true
					? { k: "const", v: folded }
					: wrong(spec.values ? `one of ${spec.values.map((value) => `"${value}"`).join(", ")}` : "one of its values");
		}
	}

	/** A handler's action list: calls to the actions, with their arguments. */
	private actions(tag: string, name: string, expr: Expr): PropValue | null {
		if (expr.t !== "arr") {
			this.say("warning", "invalid_actions", `${tag}'s ${name} is a list of actions, in braces.`);
			return null;
		}
		const actions: ActionSpec[] = [];
		for (const item of expr.items) {
			if (item.t !== "call" || !ACTION_NAMES.has(item.name) || item.args.length !== ACTION_ARITY[item.name as ActionName]) {
				this.say("warning", "invalid_actions", `${tag}'s ${name} may call reveal(), issueNewTurn(text) and copy(text), nothing else.`);
				return null;
			}
			for (const arg of item.args) this.check(arg);
			actions.push({ name: item.name as ActionName, args: item.args });
		}
		return { k: "actions", a: actions };
	}

	private form(node: Extract<RawNode, { t: "el" }>, props: Record<string, PropValue>, enclosing: FormSpec | null): Node | null {
		const id = props.id?.k === "const" ? String(props.id.v) : "";
		if (id === "") return null;
		if (enclosing !== null) {
			this.say("error", "nested_form", `The form ${id} goes inside no other form.`);
			return null;
		}
		if (this.forms[id] !== undefined) {
			this.say("error", "duplicate_form", `Two forms are called ${id}; a form's id is its own.`);
			return null;
		}
		const title = props.title?.k === "const" && typeof props.title.v === "string" ? props.title.v : null;
		const spec: FormSpec = { id, title, fields: [] };
		this.forms[id] = spec;
		const children = this.nodes(node.children, "any", spec);
		return { t: "el", tag: "form", props, children, key: id };
	}

	private field(node: Extract<RawNode, { t: "el" }>, props: Record<string, PropValue>, form: FormSpec | null): Node | null {
		if (form === null) {
			this.say("error", "orphan_field", `A <${node.tag}> goes inside a <form>.`);
			return null;
		}
		const name = props.name?.k === "const" ? String(props.name.v) : "";
		if (name === "") return null;
		const key = `${form.id}.${name}`;
		if (form.fields.some((field) => field.key === key)) {
			this.say("error", "duplicate_field", `Two fields in ${form.id} are called ${name}.`);
			return null;
		}
		const answer = props.answer;
		const graded = answer?.k === "const";
		if (answer !== undefined && !graded) {
			this.say("warning", "invalid_literal", `A <${node.tag}>'s answer must be plain, or it can't be checked.`);
		}
		const tol = props.tol?.k === "const" && typeof props.tol.v === "number" ? props.tol.v : undefined;
		const explain = props.explain?.k === "const" && typeof props.explain.v === "string" ? props.explain.v : undefined;
		const label = props.label?.k === "const" && typeof props.label.v === "string" ? props.label.v : null;
		const field: Field = {
			key,
			form: form.id,
			name,
			label,
			tag: node.tag as Field["tag"],
			graded,
			...(graded ? { answer: (answer as { v: Value }).v } : {}),
			...(tol !== undefined ? { tol } : {}),
			...(explain !== undefined ? { explain } : {}),
		};
		form.fields.push(field);
		this.stateKeys.push(key);
		return { t: "el", tag: node.tag, props, children: [], key };
	}

	/** Looks over an expression: only builtins may be called, each with the arguments it takes. */
	private check(expr: Expr): void {
		switch (expr.t) {
			case "call":
				if (ACTION_NAMES.has(expr.name)) {
					this.say("warning", "invalid_builtin", `${expr.name}() is a handler's action, not something an expression calls.`);
				}
				if (BUILTIN_NAMES.has(expr.name) && !arityOk(expr.name, expr.args.length)) {
					this.say("warning", "invalid_builtin", `${expr.name} takes a different number of arguments.`);
				}
				for (const arg of expr.args) this.check(arg);
				break;
			case "arr":
				for (const item of expr.items) this.check(item);
				break;
			case "obj":
				for (const [, value] of expr.entries) this.check(value);
				break;
			case "un":
				this.check(expr.of);
				break;
			case "bin":
				this.check(expr.a);
				this.check(expr.b);
				break;
			case "cond":
				this.check(expr.if);
				this.check(expr.then);
				this.check(expr.else);
				break;
			case "member":
				this.check(expr.of);
				break;
			case "index":
				this.check(expr.of);
				this.check(expr.at);
				break;
		}
	}
}

/** What a value is, for a diagnostic that says why it didn't fit. */
function whatOf(value: Value): string {
	if (value === null) return "nothing";
	if (Array.isArray(value)) return "a list";
	return typeof value === "object" ? "a table" : JSON.stringify(value);
}

/** The Markdown that stands in for a drawn block: what it says, and where the answers go. */
function markdownOf(tree: RenderNode[]): string {
	const blocks: string[] = [];
	for (const node of tree) {
		const text = blockOf(node);
		if (text.trim() !== "") blocks.push(text.trim());
	}
	return blocks.join("\n\n");
}

function blockOf(node: RenderNode): string {
	switch (node.t) {
		case "md":
		case "text":
			return node.text;
		case "el":
			switch (node.tag) {
				case "title":
					return `## ${inline(node.children)}`;
				case "text":
					return inline(node.children);
				case "table":
					return tableOf(node);
				case "form":
					return formOf(node);
				case "box":
					return markdownOf(node.children);
				case "button":
					return "";
				default:
					// A field on its own, or a row or cell outside its table, shows as its blank.
					return node.children.length > 0 ? inline(node.children) : "___";
			}
	}
}

/** The text of children, with every field as the blank it is until filled in. */
function inline(children: RenderNode[]): string {
	return children
		.map((child) => {
			if (child.t === "md" || child.t === "text") return child.text;
			if (child.tag === "button") return "";
			if (child.children.length > 0 && (child.tag === "row" || child.tag === "cell" || child.tag === "box" || child.tag === "title" || child.tag === "text")) {
				return inline(child.children);
			}
			return "___";
		})
		.join("");
}

function tableOf(node: Extract<RenderNode, { t: "el" }>): string {
	const head = Array.isArray(node.props.head) ? node.props.head.map(String) : null;
	const rows = node.children
		.filter((child): child is Extract<RenderNode, { t: "el" }> => child.t === "el" && child.tag === "row")
		.map((row) => row.children.filter((cell): cell is Extract<RenderNode, { t: "el" }> => cell.t === "el" && cell.tag === "cell").map((cell) => inline(cell.children)));
	const width = Math.max(head?.length ?? 0, ...rows.map((row) => row.length));
	const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |`;
	const separator = `| ${Array(width).fill("---").join(" | ")} |`;
	const lines = head ? [line(head), separator, ...rows.map(line)] : [separator, ...rows.map(line)];
	return lines.join("\n");
}

function formOf(node: Extract<RenderNode, { t: "el" }>): string {
	const id = String(node.props.id ?? "");
	const title = node.props.title === undefined ? `Form ${id}` : `${String(node.props.title)} (form ${id})`;
	const blocks: string[] = [title];
	for (const child of node.children) {
		if (child.t !== "el") {
			const text = blockOf(child);
			if (text.trim() !== "") blocks.push(text.trim());
			continue;
		}
		if ((FIELD_TAGS as readonly string[]).includes(child.tag)) {
			blocks.push(`- ${child.props.label === undefined ? String(child.props.name ?? "") : String(child.props.label)}: ___`);
		} else if (child.tag !== "button") {
			// A table or box keeps its own markdown, with its fields as blanks.
			blocks.push(blockOf(child));
		}
	}
	return blocks.join("\n\n");
}
