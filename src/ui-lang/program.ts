/**
 * The shapes a block is compiled to: a program its interpreter walks, made of
 * JSON with its text in a table beside it, so the program is small to keep
 * and check, and every stateful thing in it has a key that stays put.
 */

import type { Expr } from "./parse";
import type { Diagnostic } from "./parse";
import type { ControlSpec, Field, FormSpec, Value } from "./value";

/** What a handler may run. */
export type ActionName = "reveal" | "issueNewTurn" | "copy";

/** One action in a handler's list, with the expressions that give its arguments. */
export type ActionSpec = { name: ActionName; args: Expr[] };

/** A prop's value: worked out when the block was compiled, when it is filled in, or a list of actions. */
export type PropValue =
	| { k: "const"; v: Value }
	| { k: "expr"; e: Expr }
	| { k: "actions"; a: ActionSpec[] };

/** One stretch of the block's text by its place in the table, or the expression it interpolates. */
export type NodePart = { c: number } | { e: Expr };

/** A node of the compiled block. */
export type Node =
	| { t: "md"; parts: NodePart[] }
	| { t: "text"; parts: NodePart[] }
	| { t: "el"; tag: string; props: Record<string, PropValue>; children: Node[]; key?: string }
	| { t: "if"; cond: Expr; then: Node[]; other: Node[] }
	| { t: "each"; list: Expr; item: string | null; index: string | null; body: Node[] }
	| { t: "decl"; key: string; e: Expr; state: boolean };

/** A ```ui block, compiled: checked against the catalog, normalised, with its fallback in hand. */
export type UiProgram = {
	/** The catalog it was checked against. */
	version: number;
	/** The block itself, as JSON. */
	nodes: Node[];
	/** The block's text, each stretch once, by its place here. */
	texts: string[];
	/** What each piece of state starts as, by its key. */
	initial: Record<string, Value>;
	/** The keys of its stateful things: declared state and each field of each form. */
	stateKeys: string[];
	/** Its checkboxes and sliders, by the key of the state each holds. */
	controls: Record<string, ControlSpec>;
	/** Its forms, by their id. */
	forms: Record<string, FormSpec>;
	/** What was wrong with it, warnings and errors. */
	diagnostics: Diagnostic[];
	/** It as readable Markdown, for where it can't be drawn. */
	fallbackMarkdown: string;
	/** Whether it can be drawn at all. */
	valid: boolean;
};

/** A block's fields, by form, in order. */
export function fieldsOf(program: UiProgram): Field[] {
	return Object.values(program.forms).flatMap((form) => form.fields);
}
