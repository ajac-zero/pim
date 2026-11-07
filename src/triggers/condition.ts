/**
 * The conditions a trigger checks observations against: a small typed
 * expression, read from JSON, never code. There is no eval, no script, no
 * SQL, no network and no model in here; evaluating one is a pure function of
 * the condition, its bounded state and one observation. See
 * docs/triggers.md for the semantics in prose.
 *
 * Every expression is three-valued: `true`, `false` or `unknown`. A field
 * that is missing (or null) makes a comparison `unknown`, never `false`, and
 * `not` keeps it `unknown`; only `exists` asks whether a field is there.
 * `all` and `any` follow Kleene's logic: one `false` makes `all` false and
 * one `true` makes `any` true, whatever the unknowns.
 */

import { type JsonValue, TriggerValidationError, finite, integer, oneOf, record, text } from "./validate";

export type Scalar = number | string | boolean;

/** Where a value is in an observation: the keys of nested objects, outermost first. Arrays are not indexed. */
export type FieldPath = readonly string[];

export const COMPARISONS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;
export type Comparison = (typeof COMPARISONS)[number];

export type Expr =
	| { readonly op: "compare"; readonly path: FieldPath; readonly cmp: Comparison; readonly value: Scalar }
	| { readonly op: "exists"; readonly path: FieldPath }
	| { readonly op: "all"; readonly of: readonly Expr[] }
	| { readonly op: "any"; readonly of: readonly Expr[] }
	| { readonly op: "not"; readonly of: Expr }
	| { readonly op: "changed"; readonly path: FieldPath }
	| { readonly op: "stable_for"; readonly ms: number; readonly of: Expr }
	| { readonly op: "hysteresis"; readonly path: FieldPath; readonly direction: "rising" | "falling"; readonly enter: number; readonly exit: number };

export const OPERATORS = ["compare", "exists", "all", "any", "not", "changed", "stable_for", "hysteresis"] as const;

/** The operators that keep state between observations, which only edge conditions may use. */
const STATEFUL = new Set<Expr["op"]>(["changed", "stable_for", "hysteresis"]);

/**
 * How a condition turns observations into occurrences. `edge`, for sources
 * that report a state (polls, processes): an occurrence when the condition
 * goes from false to true. `filter`, for sources that report events
 * (connector events, streams, files): an occurrence for each event the
 * condition is true for.
 */
export type ConditionMode = "edge" | "filter";

export type Condition = {
	readonly when: Expr;
	/** An observation older than this when it is admitted counts as a gap, not as evidence; null: no limit. Edge conditions only. */
	readonly staleAfterMs: number | null;
};

export type Truth = "true" | "false" | "unknown";

export const CONDITION_LIMITS = {
	maxDepth: 8,
	maxNodes: 64,
	maxStateful: 16,
	maxOperands: 16,
	maxPathSegments: 8,
	maxSegmentLength: 64,
	maxStringLength: 256,
	/** The longest text `changed` keeps to compare with; a longer value is `unknown`. */
	maxChangedLength: 1_024,
	minDurationMs: 1_000,
	maxDurationMs: 7 * 24 * 3_600_000,
} as const;

/** Reads a condition for a source of `mode`, refusing operators it doesn't know or that `mode` can't use. */
export function parseCondition(value: unknown, mode: ConditionMode, path = "condition"): Condition {
	const given = record(value, path, ["when", "staleAfterMs"]);
	const counts = { nodes: 0, stateful: 0 };
	const when = parseExpr(given.when, `${path}.when`, mode, counts, 1, false);
	let staleAfterMs: number | null = null;
	if (given.staleAfterMs !== undefined && given.staleAfterMs !== null) {
		if (mode === "filter") throw new TriggerValidationError(`${path}.staleAfterMs`, "applies only to sources that report a state; an event is never stale");
		staleAfterMs = integer(given.staleAfterMs, `${path}.staleAfterMs`, CONDITION_LIMITS.minDurationMs, CONDITION_LIMITS.maxDurationMs);
	}
	return { when, staleAfterMs };
}

function parseExpr(value: unknown, path: string, mode: ConditionMode, counts: { nodes: number; stateful: number }, depth: number, underStable: boolean): Expr {
	if (depth > CONDITION_LIMITS.maxDepth) throw new TriggerValidationError(path, `nests deeper than ${CONDITION_LIMITS.maxDepth} levels`);
	counts.nodes += 1;
	if (counts.nodes > CONDITION_LIMITS.maxNodes) throw new TriggerValidationError(path, `has more than ${CONDITION_LIMITS.maxNodes} operators in all`);
	const op = oneOf((record(value, path, ["op", "path", "cmp", "value", "of", "ms", "direction", "enter", "exit"]) as { op?: unknown }).op, `${path}.op`, OPERATORS);
	if (STATEFUL.has(op)) {
		if (mode === "filter") throw new TriggerValidationError(`${path}.op`, `${op} keeps state between observations, which a condition on events can't use`);
		counts.stateful += 1;
		if (counts.stateful > CONDITION_LIMITS.maxStateful) throw new TriggerValidationError(path, `has more than ${CONDITION_LIMITS.maxStateful} stateful operators`);
	}
	const child = (of: unknown, at: string, stable = underStable) => parseExpr(of, at, mode, counts, depth + 1, stable);
	switch (op) {
		case "compare": {
			const given = record(value, path, ["op", "path", "cmp", "value"]);
			const cmp = oneOf(given.cmp, `${path}.cmp`, COMPARISONS);
			const literal = scalar(given.value, `${path}.value`);
			if (typeof literal !== "number" && cmp !== "eq" && cmp !== "ne") throw new TriggerValidationError(`${path}.cmp`, `${cmp} compares numbers only; text and true/false take eq or ne`);
			return { op, path: fieldPath(given.path, `${path}.path`), cmp, value: literal };
		}
		case "exists":
		case "changed": {
			if (op === "changed" && underStable) throw new TriggerValidationError(`${path}.op`, "changed is true for one observation at a time, so it can never be stable_for a while");
			const given = record(value, path, ["op", "path"]);
			return { op, path: fieldPath(given.path, `${path}.path`) };
		}
		case "all":
		case "any": {
			const given = record(value, path, ["op", "of"]);
			if (!Array.isArray(given.of) || given.of.length === 0 || given.of.length > CONDITION_LIMITS.maxOperands) {
				throw new TriggerValidationError(`${path}.of`, `must be a list of 1 to ${CONDITION_LIMITS.maxOperands} conditions`);
			}
			return { op, of: given.of.map((item, index) => child(item, `${path}.of[${index}]`)) };
		}
		case "not": {
			const given = record(value, path, ["op", "of"]);
			return { op, of: child(given.of, `${path}.of`) };
		}
		case "stable_for": {
			const given = record(value, path, ["op", "ms", "of"]);
			const ms = integer(given.ms, `${path}.ms`, CONDITION_LIMITS.minDurationMs, CONDITION_LIMITS.maxDurationMs);
			return { op, ms, of: child(given.of, `${path}.of`, true) };
		}
		case "hysteresis": {
			const given = record(value, path, ["op", "path", "direction", "enter", "exit"]);
			const direction = oneOf(given.direction, `${path}.direction`, ["rising", "falling"] as const);
			const enter = finite(given.enter, `${path}.enter`);
			const exit = finite(given.exit, `${path}.exit`);
			if (direction === "rising" ? exit >= enter : exit <= enter) {
				throw new TriggerValidationError(`${path}.exit`, direction === "rising" ? "must be below enter for a rising band" : "must be above enter for a falling band");
			}
			return { op, path: fieldPath(given.path, `${path}.path`), direction, enter, exit };
		}
	}
}

function scalar(value: unknown, path: string): Scalar {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return text(value, path, CONDITION_LIMITS.maxStringLength, { min: 0, multiline: true });
	return finite(value, path);
}

function fieldPath(value: unknown, path: string): FieldPath {
	if (!Array.isArray(value) || value.length === 0 || value.length > CONDITION_LIMITS.maxPathSegments) {
		throw new TriggerValidationError(path, `must be a list of 1 to ${CONDITION_LIMITS.maxPathSegments} field names`);
	}
	return value.map((segment, index) => {
		const name = text(segment, `${path}[${index}]`, CONDITION_LIMITS.maxSegmentLength);
		if (name === "__proto__") throw new TriggerValidationError(`${path}[${index}]`, "must not be __proto__");
		return name;
	});
}

/** What a stateful operator remembers between observations, in the order the operators appear (depth first). */
export type NodeState =
	| { readonly op: "changed"; readonly last: Scalar | null }
	| { readonly op: "stable_for"; readonly since: number | null }
	| { readonly op: "hysteresis"; readonly latched: boolean | null };

/**
 * Where an edge condition stands:
 *
 * - `unknown`: no known result since it started or since its continuity
 *   last broke (an unknown result, a gap or a stale observation).
 * - `armed`: its last result was a known false, with no break since, so a
 *   true fires.
 * - `waiting_for_false`: its last result was true, with no break since; it
 *   fires again only after a known false.
 */
export const EDGE_STATES = ["unknown", "armed", "waiting_for_false"] as const;
export type EdgeState = (typeof EDGE_STATES)[number];

/** All a condition remembers. */
export type ConditionState = { readonly version: 1; readonly edge: EdgeState; readonly nodes: readonly NodeState[] };

/** The state of a condition that has seen nothing yet. */
export function initialState(condition: Condition): ConditionState {
	const nodes: NodeState[] = [];
	const visit = (expr: Expr): void => {
		if (expr.op === "changed") nodes.push({ op: "changed", last: null });
		if (expr.op === "stable_for") nodes.push({ op: "stable_for", since: null });
		if (expr.op === "hysteresis") nodes.push({ op: "hysteresis", latched: null });
		if (expr.op === "all" || expr.op === "any") expr.of.forEach(visit);
		if (expr.op === "not" || expr.op === "stable_for") visit(expr.of);
	};
	visit(condition.when);
	return { version: 1, edge: "unknown", nodes };
}

/** A stored state if it fits `condition`, else the initial one: state from another condition is never reused. */
export function stateFor(condition: Condition, stored: unknown): ConditionState {
	const initial = initialState(condition);
	if (typeof stored !== "object" || stored === null) return initial;
	const given = stored as Partial<ConditionState>;
	if (given.version !== 1 || !Array.isArray(given.nodes) || given.nodes.length !== initial.nodes.length) return initial;
	if (!EDGE_STATES.includes(given.edge as EdgeState)) return initial;
	if (given.nodes.some((node, index) => node?.op !== initial.nodes[index]?.op)) return initial;
	return given as ConditionState;
}

export type Observation = {
	/** The observed data, as the source reported it. */
	readonly value: JsonValue;
	/** When it was observed (ms). */
	readonly observedAt: number;
	/** Observations may have been missed just before this one. */
	readonly gap: boolean;
};

export type Evaluation = {
	readonly truth: Truth;
	/** Whether this observation is an occurrence. */
	readonly fire: boolean;
	/** The observation was older than the condition's `staleAfterMs`, so it was not used. */
	readonly stale: boolean;
	readonly state: ConditionState;
};

/**
 * Evaluates `condition` on one observation. In `filter` mode it is fired
 * when the condition is true, and the state is untouched. In `edge` mode
 * a true result fires only when it follows a known false with nothing
 * unknown in between:
 *
 * - A false result arms the condition. A true result while armed fires it;
 *   any true result leaves it waiting for a known false.
 * - So a condition that is already true when it starts, or after a break,
 *   fires nothing until it has been seen false: true, true and
 *   false, unknown, true are both silent.
 * - A break in continuity starts the condition over: an `unknown` result,
 *   a gap (`observation.gap`), or a stale observation (older than
 *   `staleAfterMs`, which is not evaluated at all). The edge goes back to
 *   `unknown`, and every stateful operator forgets what it remembered:
 *   `stable_for` counts again, and `changed` and `hysteresis` start again.
 * - A `changed` that is true outside any `not` also fires while the
 *   condition waits for a false, but never from `unknown`: each change seen
 *   between two observations with no break between them is its own
 *   occurrence.
 *
 * Evaluating is the only thing that changes this state. A run the person
 * starts by hand is not an observation and must leave it alone.
 */
export function evaluate(condition: Condition, mode: ConditionMode, stored: ConditionState | null, observation: Observation, now: number): Evaluation {
	const prior = stored === null ? initialState(condition) : stateFor(condition, stored);
	if (mode === "filter") {
		const truth = evaluateExpr(condition.when, observation, [], { pulse: false });
		return { truth, fire: truth === "true", stale: false, state: prior };
	}
	if (condition.staleAfterMs !== null && now - observation.observedAt > condition.staleAfterMs) {
		return { truth: "unknown", fire: false, stale: true, state: initialState(condition) };
	}
	const start = observation.gap ? initialState(condition) : prior;
	const nodes = start.nodes.slice();
	const seen = { pulse: false };
	const truth = evaluateExpr(condition.when, observation, nodes, seen);
	if (truth === "unknown") return { truth, fire: false, stale: false, state: initialState(condition) };
	if (truth === "false") return { truth, fire: false, stale: false, state: { version: 1, edge: "armed", nodes } };
	const fire = start.edge === "armed" || (start.edge === "waiting_for_false" && seen.pulse);
	return { truth, fire, stale: false, state: { version: 1, edge: "waiting_for_false", nodes } };
}

/**
 * Evaluates every operand, never short-circuiting, so each stateful operator
 * sees each observation. `nodes` is consumed in the order of `initialState`.
 */
function evaluateExpr(expr: Expr, observation: Observation, nodes: NodeState[], seen: { pulse: boolean }): Truth {
	let next = 0;
	const visit = (node: Expr, positive: boolean): Truth => {
		switch (node.op) {
			case "compare":
				return compare(lookup(observation.value, node.path), node.cmp, node.value);
			case "exists": {
				const found = lookup(observation.value, node.path);
				return found === undefined || found === null ? "false" : "true";
			}
			case "all": {
				const results = node.of.map((item) => visit(item, positive));
				return results.includes("false") ? "false" : results.includes("unknown") ? "unknown" : "true";
			}
			case "any": {
				const results = node.of.map((item) => visit(item, positive));
				return results.includes("true") ? "true" : results.includes("unknown") ? "unknown" : "false";
			}
			case "not": {
				const result = visit(node.of, !positive);
				return result === "unknown" ? "unknown" : result === "true" ? "false" : "true";
			}
			case "changed": {
				const index = next++;
				const state = nodes[index] as Extract<NodeState, { op: "changed" }>;
				const found = lookup(observation.value, node.path);
				const current = typeof found === "string" ? (found.length <= CONDITION_LIMITS.maxChangedLength ? found : undefined) : typeof found === "number" || typeof found === "boolean" ? found : undefined;
				// A value it can't compare breaks continuity: the next one is a new baseline, not a change.
				if (current === undefined) {
					nodes[index] = { op: "changed", last: null };
					return "unknown";
				}
				nodes[index] = { op: "changed", last: current };
				if (state.last === null || state.last === current) return "false";
				if (positive) seen.pulse = true;
				return "true";
			}
			case "stable_for": {
				const index = next++;
				const state = nodes[index] as Extract<NodeState, { op: "stable_for" }>;
				const inner = visit(node.of, positive);
				if (inner !== "true") {
					nodes[index] = { op: "stable_for", since: null };
					return inner;
				}
				const since = state.since ?? observation.observedAt;
				nodes[index] = { op: "stable_for", since };
				return observation.observedAt - since >= node.ms ? "true" : "false";
			}
			case "hysteresis": {
				const index = next++;
				const state = nodes[index] as Extract<NodeState, { op: "hysteresis" }>;
				const found = lookup(observation.value, node.path);
				// A value that isn't a number breaks continuity: the band starts again.
				if (typeof found !== "number") {
					nodes[index] = { op: "hysteresis", latched: null };
					return "unknown";
				}
				let latched = state.latched;
				const entered = node.direction === "rising" ? found >= node.enter : found <= node.enter;
				const exited = node.direction === "rising" ? found <= node.exit : found >= node.exit;
				if (entered) latched = true;
				else if (exited) latched = false;
				nodes[index] = { op: "hysteresis", latched };
				return latched === null ? "unknown" : latched ? "true" : "false";
			}
		}
	};
	return visit(expr, true);
}

function compare(found: JsonValue | undefined, cmp: Comparison, value: Scalar): Truth {
	if (found === undefined || found === null || typeof found !== typeof value) return "unknown";
	const left = found as Scalar;
	switch (cmp) {
		case "eq":
			return left === value ? "true" : "false";
		case "ne":
			return left !== value ? "true" : "false";
		case "lt":
			return left < value ? "true" : "false";
		case "lte":
			return left <= value ? "true" : "false";
		case "gt":
			return left > value ? "true" : "false";
		case "gte":
			return left >= value ? "true" : "false";
	}
}

/** The value at `path`, through the object's own fields only; undefined when any part is missing or not an object. */
export function lookup(value: JsonValue, path: FieldPath): JsonValue | undefined {
	let current: JsonValue | undefined = value;
	for (const segment of path) {
		if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, segment)) return undefined;
		current = current[segment];
	}
	return current;
}

/** The paths a condition reads, each once, in the order they appear. */
export function referencedPaths(expr: Expr): FieldPath[] {
	const paths = new Map<string, FieldPath>();
	const visit = (node: Expr): void => {
		if ("path" in node) paths.set(JSON.stringify(node.path), node.path);
		if (node.op === "all" || node.op === "any") node.of.forEach(visit);
		if (node.op === "not" || node.op === "stable_for") visit(node.of);
	};
	visit(expr);
	return [...paths.values()];
}
