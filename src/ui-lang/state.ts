/**
 * What a block's state may be when it is kept: the app saves it as the person
 * changes it, so a draft, a toggled setting or a locked form is still there
 * after a reload. The Worker checks what the web sends against the compiled
 * block, with the limits below; the web uses the same code to send only what
 * will be accepted.
 */

import { MAX_STATE_BYTES, MAX_TEXT_CHARS } from "./limits";
import type { UiProgram } from "./program";
import { controlValueOk, type UiState, type Value } from "./value";

/** How many items a list kept in a block's state may have. */
export const MAX_STORED_LIST = 64;

/** What a block is called when it is the only one of its source in its message: a short hash of the source, which both sides work out alike. */
export function uiBlockId(given: string): string {
	// Line endings and the space around a block's source don't tell it apart.
	const source = given.replace(/\r\n/g, "\n").trim();
	// cyrb53: not for secrets, only for telling blocks of one message apart.
	let a = 0xdeadbeef;
	let b = 0x41c6ce57;
	for (let index = 0; index < source.length; index++) {
		const code = source.charCodeAt(index);
		a = Math.imul(a ^ code, 2654435761);
		b = Math.imul(b ^ code, 1597334677);
	}
	a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
	b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
	return (4294967296 * (2097151 & b) + (a >>> 0)).toString(16).padStart(14, "0");
}

/**
 * The ids of the blocks of one message, by their sources in order, so that
 * two blocks of one source are two blocks. The first of a source is its hash
 * alone, as every block was called before blocks of one source were told
 * apart, so what Pim kept under that id still reads; the n-th after it is the
 * hash and `-n`. The Worker and the web app both name blocks with this.
 */
export function uiBlockIds(sources: readonly string[]): string[] {
	const seen = new Map<string, number>();
	return sources.map((source) => {
		const hash = uiBlockId(source);
		const occurrence = seen.get(hash) ?? 0;
		seen.set(hash, occurrence + 1);
		return occurrence === 0 ? hash : `${hash}-${occurrence}`;
	});
}

type Scalar = string | number | boolean | null;

function isScalar(value: unknown): value is Scalar {
	if (typeof value === "string") return value.length <= MAX_TEXT_CHARS;
	if (typeof value === "number") return Number.isFinite(value);
	return typeof value === "boolean" || value === null;
}

/** Whether a value may be kept: a scalar, or a short list of them. */
export function isStorable(value: unknown): boolean {
	return isScalar(value) || (Array.isArray(value) && value.length <= MAX_STORED_LIST && value.every(isScalar));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The state of a block as the web keeps it: what can't be kept (a table a declaration started with) left out, because nothing a person does changes it. */
export function storableState(state: UiState): UiState {
	return { ...state, values: Object.fromEntries(Object.entries(state.values).filter(([, value]) => isStorable(value))) };
}

/** Why a value can't be what a checkbox or slider holds, or null when the key isn't one or the value fits. */
function controlProblem(program: UiProgram, key: string, value: Value): string | null {
	const control = Object.hasOwn(program.controls, key) ? program.controls[key] : undefined;
	if (control === undefined || controlValueOk(control, value)) return null;
	return control.kind === "checkbox" ? `${key} must be true or false` : `${key} must be a number from ${control.min} to ${control.max}`;
}

/** A block's state as it may be kept, or what is wrong with it. */
export function checkUiState(program: UiProgram, input: unknown): { ok: true; state: UiState } | { ok: false; error: string } {
	const bad = (error: string) => ({ ok: false as const, error });
	if (!isRecord(input)) return bad("state must be an object");
	const unknown = Object.keys(input).find((key) => key !== "values" && key !== "revealed" && key !== "submitted");
	if (unknown !== undefined) return bad(`state has no ${unknown}`);
	const { values = {}, revealed = {}, submitted = {} } = input;
	if (!isRecord(values) || !isRecord(revealed) || !isRecord(submitted)) return bad("values, revealed and submitted must be objects");
	const stateKeys = new Set(program.stateKeys);
	for (const [key, value] of Object.entries(values)) {
		if (!stateKeys.has(key)) return bad(`the block has no state called ${key}`);
		if (!isStorable(value)) return bad(`${key} must be text, a finite number, true, false, null or a short list of them`);
		const problem = controlProblem(program, key, value as Value);
		if (problem !== null) return bad(problem);
	}
	for (const [form, shown] of Object.entries(revealed)) {
		if (!Object.hasOwn(program.forms, form)) return bad(`the block has no form called ${form}`);
		if (shown !== true) return bad(`revealed.${form} must be true`);
	}
	for (const [form, answer] of Object.entries(submitted)) {
		const spec = Object.hasOwn(program.forms, form) ? program.forms[form] : undefined;
		if (spec === undefined) return bad(`the block has no form called ${form}`);
		if (!isRecord(answer) || !isRecord(answer.values) || !isRecord(answer.graded)) return bad(`submitted.${form} must hold values and graded`);
		const keys = new Set(spec.fields.map((field) => field.key));
		for (const [key, value] of Object.entries(answer.values)) {
			if (!keys.has(key)) return bad(`form ${form} has no field ${key}`);
			if (!isStorable(value)) return bad(`${key} must be text, a finite number, true, false, null or a short list of them`);
			const problem = controlProblem(program, key, value as Value);
			if (problem !== null) return bad(problem);
		}
		for (const [key, mark] of Object.entries(answer.graded)) {
			if (!keys.has(key)) return bad(`form ${form} has no field ${key}`);
			if (typeof mark !== "boolean") return bad(`graded.${key} must be true or false`);
		}
	}
	const state = { values, revealed, submitted } as UiState;
	if (new TextEncoder().encode(JSON.stringify(state)).length > MAX_STATE_BYTES) return bad(`a block's state may be at most ${MAX_STATE_BYTES} bytes`);
	return { ok: true, state };
}
