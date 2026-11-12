/**
 * The interpreter. `evaluate` walks a compiled block with its state and, at
 * need, an event — a field filled in, a form submitted, a button clicked —
 * and gives the tree to draw, the state it ends in and the actions its
 * handler asked for, as data for the app to run. Nothing here reaches
 * outside: no calls but the builtins, no property but a value's own, and
 * every step is counted. An answer a form checks against stays out of the
 * tree until the form is revealed, so nothing puts it on the page.
 */

import { MAX_CHART_POINTS, MAX_DEPTH, MAX_STATE_BYTES, MAX_TEXT_CHARS } from "./limits";
import type { ActionName, Node, NodePart, UiProgram } from "./program";
import { httpUrlOf } from "./url";
import type { Expr } from "./parse";
import type { FormSpec, UiState, Value } from "./value";
import { coerceControl, evalExpr, EvalError, formReady, gradeForm, initialUiState, numberOf, stringOf, Steps, truthy } from "./value";

/** An action to run, with its arguments worked out, and the form it belongs to. */
export type Action = { name: ActionName; args: Value[]; form: string | null };

/** A node to draw: text, or a catalog component with its props and children. */
export type RenderNode =
	| { t: "md"; text: string }
	| { t: "text"; text: string }
	| { t: "el"; tag: string; props: Record<string, Value>; children: RenderNode[] };

/** What happened, as the app reports it to the block: a field filled in, a form submitted, a button clicked. */
export type UiEvent =
	| { type: "change"; key: string; value: string | number | boolean }
	| { type: "submit"; form: string }
	| { type: "click"; key: string }
	| { type: "reveal"; form: string };

/** What one evaluation gave: the tree, the state it ends in, and the actions to run. */
export type Evaluation = { tree: RenderNode[]; state: UiState; actions: Action[]; error: string | null };

/** The state a block starts in: nothing filled in, its declared state at its initial values. */
export function initialState(program: UiProgram): UiState {
	return { ...initialUiState(), values: { ...program.initial } };
}

/**
 * Evaluates a block: applies `event` to `state`, walks its nodes and works
 * out every expression, and returns what to draw and what to do. It is
 * deterministic — the same program, state and event give the same result —
 * and nothing it can't work out throws: that becomes the evaluation's error,
 * for the app to show the block's fallback instead.
 */
export function evaluate(program: UiProgram, given: UiState, event: UiEvent | null): Evaluation {
	const state: UiState = { values: { ...given.values }, revealed: { ...given.revealed }, submitted: { ...given.submitted } };
	const actions: Action[] = [];
	const steps = new Steps();
	try {
		if (event?.type === "change") {
			const control = Object.hasOwn(program.controls, event.key) ? program.controls[event.key] : undefined;
			if (control !== undefined) {
				state.values[event.key] = coerceControl(control, event.value);
			} else {
				if (!program.stateKeys.includes(event.key)) throw new EvalError(`The block has no field called ${event.key}.`);
				if (typeof event.value !== "string") throw new EvalError("That field holds text.");
				if (event.value.length > MAX_TEXT_CHARS) throw new EvalError(`A text value may be at most ${MAX_TEXT_CHARS} characters.`);
				state.values[event.key] = event.value;
			}
		}
		if (event?.type === "submit" || event?.type === "reveal") {
			const spec = Object.hasOwn(program.forms, event.form) ? program.forms[event.form] : undefined;
			if (spec === undefined) throw new EvalError(`No form is called ${event.form}.`);
			if (event.type === "reveal") {
				state.revealed[event.form] = true;
			} else {
				const values: Record<string, Value> = {};
				for (const field of spec.fields) values[field.key] = state.values[field.key] ?? "";
				if (!formReady(spec, values)) throw new EvalError("Fill in every field to submit.");
				state.submitted[event.form] = { values, graded: gradeForm(spec, values) };
				state.revealed[event.form] = true;
			}
		}
		const renderer = new Renderer(program, state, event, actions, steps);
		const tree = renderer.all(program.nodes);
		if (new TextEncoder().encode(JSON.stringify(state)).length > MAX_STATE_BYTES) {
			throw new EvalError(`The block's state is larger than ${MAX_STATE_BYTES} bytes.`);
		}
		return { tree, state, actions, error: null };
	} catch (caught) {
		const message = caught instanceof EvalError || caught instanceof RangeError ? caught.message : "The block couldn't be worked out.";
		return { tree: [], state: given, actions: [], error: message };
	}
}

/** One evaluation's walk over the nodes. */
class Renderer {
	private scope = new Map<string, Value>();
	private currentForm: string | null = null;

	constructor(
		private readonly program: UiProgram,
		private readonly state: UiState,
		private readonly event: UiEvent | null,
		private readonly actions: Action[],
		private readonly steps: Steps,
	) {}

	all(nodes: Node[]): RenderNode[] {
		return this.nodes(nodes, 0);
	}

	private nodes(nodes: Node[], depth: number): RenderNode[] {
		if (depth > MAX_DEPTH) throw new EvalError("The block nests too deeply.");
		const tree: RenderNode[] = [];
		for (const node of nodes) {
			switch (node.t) {
				case "md":
				case "text": {
					const text = this.text(node.parts);
					if (text === "") break;
					// Text that was side by side in the source stays side by side.
					const last = tree[tree.length - 1];
					if (last !== undefined && last.t === node.t) last.text += text;
					else tree.push({ t: node.t, text });
					break;
				}
				case "decl": {
					const value = this.expr(node.e);
					if (node.state && !Object.hasOwn(this.state.values, node.key)) this.state.values[node.key] = value;
					this.scope.set(node.key, node.state ? this.state.values[node.key]! : value);
					break;
				}
				case "if":
					tree.push(...this.nodes(truthy(this.expr(node.cond)) ? node.then : node.other, depth + 1));
					break;
				case "each": {
					const list = this.expr(node.list);
					if (!Array.isArray(list)) throw new EvalError("An {#each} goes over a list.");
					const within = new Map(this.scope);
					for (const [index, item] of list.entries()) {
						if (node.item !== null) within.set(node.item, item);
						if (node.index !== null) within.set(node.index, index);
						tree.push(...this.inside(within, node.body, depth + 1));
					}
					break;
				}
				case "el": {
					const el = this.el(node, depth);
					if (el) tree.push(el);
					break;
				}
			}
		}
		return tree;
	}

	/** Renders a body with a scope of its own, put back afterwards. */
	private inside(scope: ReadonlyMap<string, Value>, body: Node[], depth: number): RenderNode[] {
		const outer = this.scope;
		this.scope = new Map(scope);
		const tree = this.nodes(body, depth);
		this.scope = outer;
		return tree;
	}

	private el(node: Extract<Node, { t: "el" }>, depth: number): RenderNode | null {
		const props: Record<string, Value> = {};
		for (const [name, value] of Object.entries(node.props)) {
			if (value.k === "actions") continue;
			props[name] = value.k === "const" ? value.v : this.expr(value.e);
		}
		// Forms, fields and buttons carry their key, so the app can tell its events apart.
		if (node.key !== undefined) props.key = node.key;
		if (node.tag === "form") return this.form(node, props, depth);
		if (node.tag === "chart") this.chart(props);
		if (node.tag === "number" || node.tag === "input" || node.tag === "select" || node.tag === "checkbox" || node.tag === "slider") {
			const key = node.key;
			if (key !== undefined) {
				const formId = this.currentForm ?? key.slice(0, Math.max(0, key.lastIndexOf(".")));
				const submitted = this.state.submitted[formId];
				const revealed = this.state.revealed[formId] === true;
				if (!revealed) {
					// Until its form is revealed, an answer is for checking, not for the page.
					for (const secret of ["answer", "tol", "explain"]) delete props[secret];
				}
				props.required = this.program.forms[formId]?.fields.find((field) => field.key === key)?.required ?? true;
				const held = this.state.values[key] ?? "";
				props.value = node.tag === "checkbox" ? held === true : node.tag === "slider" ? (numberOf(held) ?? Number(props.min)) : stringOf(held);
				props.locked = submitted !== undefined;
				props.graded = submitted?.graded[key] === true;
			}
		}
		const children = this.nodes(node.children, depth + 1);
		this.fire(node, null);
		return { t: "el", tag: node.tag, props, children };
	}

	/** Puts a chart's data in the one shape the app draws, a list of {x, y} with y a number, and says what x and y are. */
	private chart(props: Record<string, Value>): void {
		if (!["bar", "line", "pie"].includes(String(props.kind))) throw new EvalError('A chart is "bar", "line" or "pie".');
		const data = props.data;
		if (!Array.isArray(data)) throw new EvalError("A chart's data is a list.");
		if (data.length > MAX_CHART_POINTS) throw new EvalError(`A chart may have at most ${MAX_CHART_POINTS} points.`);
		const x = props.x === undefined ? null : stringOf(props.x);
		const y = props.y === undefined ? null : stringOf(props.y);
		const points = data.map((item, index): Value => {
			if (item !== null && typeof item === "object" && !Array.isArray(item)) {
				if (x === null || y === null) throw new EvalError("A chart of tables needs its x and y.");
				const height = Object.hasOwn(item, y) ? numberOf(item[y]!) : null;
				if (height === null) throw new EvalError(`A chart's ${y} is a number in every item.`);
				return { x: stringOf(Object.hasOwn(item, x) ? item[x]! : null), y: height };
			}
			const height = typeof item === "number" ? item : null;
			if (height === null) throw new EvalError("A chart's data is a list of numbers or of tables.");
			return { x: String(index + 1), y: height };
		});
		if (props.kind === "pie" && points.some((point) => (point as { y: number }).y < 0)) throw new EvalError("A pie chart's values can't be negative.");
		props.data = points;
		props.x = x ?? "#";
		props.y = y ?? "value";
	}

	private form(node: Extract<Node, { t: "el" }>, props: Record<string, Value>, depth: number): RenderNode | null {
		const id = stringOf(props.id ?? "");
		if (id === "") return null;
		props.locked = this.state.submitted[id] !== undefined;
		props.revealed = this.state.revealed[id] === true;
		const spec = this.program.forms[id];
		props.ready = spec === undefined || formReady(spec, this.state.values);
		const outer = this.currentForm;
		this.currentForm = id;
		const children = this.nodes(node.children, depth + 1);
		this.currentForm = outer;
		this.fire(node, id);
		return { t: "el", tag: "form", props, children };
	}

	/** Runs the handler's actions, when this element is the one the event names. */
	private fire(node: Extract<Node, { t: "el" }>, form: string | null): void {
		const handler = node.props.onSubmit ?? node.props.onClick;
		if (handler === undefined || handler.k !== "actions") return;
		const mine =
			form !== null
				? this.event?.type === "submit" && this.event.form === form
				: this.event?.type === "click" && node.key !== undefined && this.event.key === node.key;
		if (!mine) return;
		for (const action of handler.a) {
			const args = action.args.map((arg) => this.expr(arg));
			if (action.name === "openUrl") {
				// Whatever the address was worked out from, only an http or https address goes on, as the browser will open it.
				const url = typeof args[0] === "string" ? httpUrlOf(args[0]) : null;
				if (url === null) throw new EvalError("openUrl opens only an http or https address.");
				args[0] = url;
			}
			this.actions.push({ name: action.name, args, form: form ?? this.currentForm });
		}
	}

	private text(parts: NodePart[]): string {
		let text = "";
		for (const part of parts) {
			if ("c" in part) text += this.program.texts[part.c] ?? "";
			else {
				const value = stringOf(this.expr(part.e));
				if (value.length > MAX_TEXT_CHARS) throw new EvalError(`A text value may be at most ${MAX_TEXT_CHARS} characters.`);
				text += value;
			}
		}
		return text;
	}

	private expr(e: Expr): Value {
		return evalExpr(e, this.scope, this.program.forms, this.state, this.steps);
	}
}
