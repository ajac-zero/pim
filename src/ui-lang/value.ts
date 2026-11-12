/**
 * The values an expression has, and how each one is worked out. There is no
 * JavaScript in a block: an expression is read by this file alone, its
 * operations are the fixed ones, its functions are the builtins below, and
 * its steps are counted so nothing runs away. Property access reads a value's
 * own properties, never the machinery it inherits.
 */

import { STEP_BUDGET } from "./limits";
import type { Expr } from "./parse";

/** What an expression works out to: text, a number, true, false, nothing, a list or a table of them. */
export type Value = string | number | boolean | null | Value[] | { [name: string]: Value };

/** A field a person fills in: which form it belongs to, and what its answer is checked against. */
export type Field = {
	/** The field's stable key, its form's id and its own name: "quiz.q1". */
	key: string;
	/** The form it belongs to. */
	form: string;
	/** Its name in the form. */
	name: string;
	/** What it is called, when it says. */
	label: string | null;
	/** The kind of input it is. */
	tag: "number" | "input" | "select";
	/** Whether the form can't be submitted while it is empty; true unless the tag says required={false}. */
	required: boolean;
	/** Whether submitting checks it: it has an answer. */
	graded: boolean;
	/** What it is checked against. */
	answer?: Value;
	/** How far a number may be off. */
	tol?: number;
	/** Shown when its answer is wrong. */
	explain?: string;
};

/** A form as the language sees it: its id, its title and its fields. */
export type FormSpec = { id: string; title: string | null; fields: Field[] };

/** The state a block keeps between the times it is evaluated. */
export type UiState = {
	/** What each named thing holds: state the model declared, and what each field was filled with. */
	values: Record<string, Value>;
	/** The forms whose answers have been shown. */
	revealed: Record<string, true>;
	/** The forms that were submitted: what they held, and how each field did. */
	submitted: Record<string, { values: Record<string, Value>; graded: Record<string, boolean> }>;
};

/** A block's forms by their id, as its program laid them out. */
export type Forms = Record<string, FormSpec>;

/** The state a block starts with: nothing. */
export function initialUiState(): UiState {
	return { values: {}, revealed: {}, submitted: {} };
}

/** An expression couldn't be worked out: the block shows as its fallback. */
export class EvalError extends Error {}

/** How many evaluation steps are left. */
export class Steps {
	private left: number;
	constructor(left: number = STEP_BUDGET) {
		this.left = left;
	}
	take(): void {
		if (--this.left < 0) throw new EvalError("The block took too many steps to work out.");
	}
}

/** Whether a value counts as true: nothing, false, 0 and empty text don't. */
export function truthy(value: Value): boolean {
	return value !== null && value !== false && value !== 0 && value !== "";
}

/** A value as text, for showing and for joining. */
export function stringOf(value: Value): string {
	if (value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(Number(value.toPrecision(12)));
	if (Array.isArray(value)) return value.map(stringOf).join(", ");
	return JSON.stringify(value);
}

/** A value as a number, or null when it isn't one. */
export function numberOf(value: Value): number | null {
	if (typeof value === "number") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "string") {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** Reads a value's own property by name: a list's item or length, a text's length, a table's own key. */
function property(of: Value, name: string): Value {
	if (Array.isArray(of)) {
		if (name === "length") return of.length;
		if (/^\d+$/.test(name)) {
			const item = of[Number(name)];
			return item === undefined ? null : item;
		}
		return null;
	}
	if (typeof of === "string") {
		if (name === "length") return of.length;
		if (/^\d+$/.test(name)) {
			const c = of[Number(name)];
			return c === undefined ? null : c;
		}
		return null;
	}
	if (of !== null && typeof of === "object") {
		const table = of as { [name: string]: Value };
		return Object.hasOwn(table, name) ? table[name]! : null;
	}
	return null;
}

/** Two values are the same, deeply; text and numbers compare as numbers when either is one. */
export function equal(a: Value, b: Value): boolean {
	if (typeof a === "number" || typeof b === "number") {
		const x = numberOf(a);
		const y = numberOf(b);
		return x !== null && y !== null && x === y;
	}
	if (typeof a === "string" || typeof b === "string" || typeof a === "boolean" || typeof b === "boolean") {
		return a === b;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, index) => equal(item, b[index] ?? null));
	}
	if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
		const left = a as { [name: string]: Value };
		const right = b as { [name: string]: Value };
		const keys = Object.keys(left);
		return keys.length === Object.keys(right).length && keys.every((key) => key in right && equal(left[key]!, right[key]!));
	}
	return a === b;
}

/** How each builtin's arguments are counted. */
const ARITY: Record<string, [number, number | undefined]> = {
	abs: [1, 1],
	round: [1, 1],
	floor: [1, 1],
	ceil: [1, 1],
	min: [1, undefined],
	max: [1, undefined],
	sum: [1, 1],
	len: [1, 1],
	map: [2, 2],
	filter: [2, 2],
	join: [1, 2],
	str: [1, 1],
	num: [1, 1],
	close: [2, 3],
	eq: [2, 2],
	submitted: [1, 1],
	score: [1, 1],
	count: [1, 1],
	formSummary: [1, 1],
};

/** Whether a call to a builtin has the arguments it takes. */
export function arityOk(name: string, count: number): boolean {
	const [min, max] = ARITY[name] ?? [0, 0];
	return count >= min && (max === undefined || count <= max);
}

/** What a field holds, as text, when nothing was typed. */
export function valueOf(state: UiState, key: string): string {
	const value = state.values[key];
	return value === undefined ? "" : stringOf(value);
}

/** Whether a field's answer is right: numbers within tol, text trimmed and regardless of case, choices exact. */
export function gradeField(field: Field, value: Value): boolean {
	if (field.tag === "number") {
		const answer = numberOf(field.answer ?? null);
		const given = numberOf(value);
		const tol = field.tol ?? 0;
		return answer !== null && given !== null && Math.abs(given - answer) <= tol;
	}
	if (field.tag === "input") {
		return stringOf(value).trim().toLowerCase() === stringOf(field.answer ?? "").trim().toLowerCase();
	}
	return stringOf(value) === stringOf(field.answer ?? "");
}

/** Whether a required field holds a valid value: text that isn't blank, and for a number a finite one. */
function filled(field: Field, value: Value | undefined): boolean {
	const text = stringOf(value ?? "").trim();
	if (text === "") return false;
	return field.tag !== "number" || Number.isFinite(Number(text));
}

/** Whether every required field of a form holds a valid value, so it may be submitted. */
export function formReady(spec: FormSpec, values: Record<string, Value>): boolean {
	return spec.fields.every((field) => !field.required || filled(field, values[field.key]));
}

/** How each field of a form did, by its key. */
export function gradeForm(spec: FormSpec, values: Record<string, Value>): Record<string, boolean> {
	const graded: Record<string, boolean> = {};
	for (const field of spec.fields) {
		if (field.graded) graded[field.key] = gradeField(field, values[field.key] ?? "");
	}
	return graded;
}

/** A form's answers as readable Markdown: its title, a field table and the score. */
export function formSummary(spec: FormSpec, submitted: { values: Record<string, Value>; graded: Record<string, boolean> }): string {
	/** Markdown table cells wrap badly: | and line breaks are stood in for. */
	const cell = (text: Value) => stringOf(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
	const head = spec.title ? `${spec.title} (form ${spec.id})` : `Form ${spec.id}`;
	if (spec.fields.length === 0) return head;
	const rows = spec.fields.map((field) => {
		const answer = cell(submitted.values[field.key] ?? "");
		const mark = field.graded ? (submitted.graded[field.key] ? " ✓" : " ✗") : "";
		return `| ${cell(field.label ?? field.name)} | ${answer === "" ? "—" : answer}${mark} |`;
	});
	const right = spec.fields.filter((field) => field.graded && submitted.graded[field.key]).length;
	const total = spec.fields.filter((field) => field.graded).length;
	return [head, "", "| Field | Answer |", "| --- | --- |", ...rows, "", `Score: ${right} / ${total}`].join("\n");
}

/**
 * Works an expression out. The forms and state a form's builtins read may be
 * null while a block is being compiled, where a value that needs them simply
 * isn't a constant.
 */
export function evalExpr(
	expr: Expr,
	scope: ReadonlyMap<string, Value>,
	forms: Forms | null,
	state: UiState | null,
	steps: Steps,
): Value {
	steps.take();
	switch (expr.t) {
		case "num":
			return expr.v;
		case "str":
			return expr.v;
		case "bool":
			return expr.v;
		case "null":
			return null;
		case "arr":
			return expr.items.map((item) => evalExpr(item, scope, forms, state, steps));
		case "obj":
			return Object.fromEntries(expr.entries.map(([key, value]) => [key, evalExpr(value, scope, forms, state, steps)]));
		case "var": {
			const value = scope.get(expr.name);
			if (value === undefined) throw new EvalError(`Nothing is called ${expr.name}.`);
			return value;
		}
		case "member":
			return property(evalExpr(expr.of, scope, forms, state, steps), expr.prop);
		case "index": {
			const of = evalExpr(expr.of, scope, forms, state, steps);
			const at = evalExpr(expr.at, scope, forms, state, steps);
			const name = typeof at === "number" ? String(at) : stringOf(at);
			if (name === "__proto__" || name === "constructor" || name === "prototype") {
				throw new EvalError("That property is not the block's to read.");
			}
			return property(of, name);
		}
		case "un": {
			const value = evalExpr(expr.of, scope, forms, state, steps);
			if (expr.op === "!") return !truthy(value);
			const number = numberOf(value);
			if (number === null) throw new EvalError("That is not a number.");
			return -number;
		}
		case "cond":
			return truthy(evalExpr(expr.if, scope, forms, state, steps))
				? evalExpr(expr.then, scope, forms, state, steps)
				: evalExpr(expr.else, scope, forms, state, steps);
		case "bin": {
			if (expr.op === "&&" || expr.op === "||") {
				const a = evalExpr(expr.a, scope, forms, state, steps);
				if (expr.op === "&&") return truthy(a) ? evalExpr(expr.b, scope, forms, state, steps) : a;
				return truthy(a) ? a : evalExpr(expr.b, scope, forms, state, steps);
			}
			const a = evalExpr(expr.a, scope, forms, state, steps);
			const b = evalExpr(expr.b, scope, forms, state, steps);
			switch (expr.op) {
				case "+":
					if (typeof a === "string" || typeof b === "string") return stringOf(a) + stringOf(b);
					return needNumber(a) + needNumber(b);
				case "-":
					return needNumber(a) - needNumber(b);
				case "*":
					return needNumber(a) * needNumber(b);
				case "/":
					return needNumber(a) / needNumber(b);
				case "%":
					return needNumber(a) % needNumber(b);
				case "==":
					return equal(a, b);
				case "!=":
					return !equal(a, b);
				case "<":
				case "<=":
				case ">":
				case ">=": {
					const compare: [number | string, number | string] =
						typeof a === "string" && typeof b === "string" ? [a, b] : [needNumber(a), needNumber(b)];
					return expr.op === "<" ? compare[0] < compare[1] : expr.op === "<=" ? compare[0] <= compare[1] : expr.op === ">" ? compare[0] > compare[1] : compare[0] >= compare[1];
				}
			}
			throw new EvalError(`No such operation as ${expr.op}.`);
		}
		case "call": {
			const args = expr.args.map((arg) => evalExpr(arg, scope, forms, state, steps));
			if (!arityOk(expr.name, args.length)) throw new EvalError(`${expr.name} takes a different number of arguments.`);
			switch (expr.name) {
				case "abs":
					return Math.abs(needNumber(args[0]!));
				case "round":
					return Math.round(needNumber(args[0]!));
				case "floor":
					return Math.floor(needNumber(args[0]!));
				case "ceil":
					return Math.ceil(needNumber(args[0]!));
				case "min":
				case "max": {
					const numbers = args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg])).map(needNumber);
					if (numbers.length === 0) throw new EvalError(`${expr.name} needs a number.`);
					return expr.name === "min" ? Math.min(...numbers) : Math.max(...numbers);
				}
				case "sum":
					return toList(args[0]!).reduce((total: number, item) => total + needNumber(item), 0);
				case "len": {
					const of = args[0]!;
					if (typeof of === "string" || Array.isArray(of)) return of.length;
					if (of !== null && typeof of === "object") return Object.keys(of).length;
					throw new EvalError("len takes a list or text.");
				}
				case "map":
					return toList(args[0]!).map((item) => property(item, stringOf(args[1]!)));
				case "filter":
					return toList(args[0]!).filter((item) => truthy(property(item, stringOf(args[1]!))));
				case "join":
					return toList(args[0]!).map(stringOf).join(args[1] === undefined ? " " : stringOf(args[1]));
				case "str":
					return stringOf(args[0]!);
				case "num":
					return numberOf(args[0]!);
				case "close": {
					const a = needNumber(args[0]!);
					const b = needNumber(args[1]!);
					const tol = args[2] === undefined ? 0 : needNumber(args[2]!);
					return Math.abs(a - b) <= tol;
				}
				case "eq":
					return equal(args[0]!, args[1]!);
				case "submitted":
				case "score":
				case "count":
				case "formSummary": {
					if (forms === null || state === null) throw new EvalError("That is only known while the block runs.");
					const id = stringOf(args[0]!);
					const spec = forms[id];
					if (spec === undefined) throw new EvalError(`No form is called ${id}.`);
					if (expr.name === "submitted") return state.submitted[id] !== undefined;
					const submitted = state.submitted[id];
					if (expr.name === "count") return spec.fields.filter((field) => field.graded).length;
					if (submitted === undefined) throw new EvalError(`The form ${id} has not been submitted.`);
					if (expr.name === "score") return spec.fields.filter((field) => field.graded && submitted.graded[field.key]).length;
					return formSummary(spec, submitted);
				}
			}
			throw new EvalError(`No such function as ${expr.name}.`);
		}
	}
}

function needNumber(value: Value): number {
	const number = numberOf(value);
	if (number === null) throw new EvalError("That is not a number.");
	return number;
}

function toList(value: Value): Value[] {
	if (!Array.isArray(value)) throw new EvalError("That is not a list.");
	return value;
}
