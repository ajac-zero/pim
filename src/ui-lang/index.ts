/**
 * The ```ui language: what an agent's message draws in the chat. One module
 * serves both sides: the Worker checks a block when the message is sent, and
 * the web app compiles it again and walks it with this same code to draw it.
 * It is all pure TypeScript with no JavaScript of the model's own anywhere —
 * expressions are read by an interpreter, never run — so it needs no sandbox
 * beyond the ordinary care of what may be drawn.
 */

export { CATALOG, CATALOG_VERSION, uiBlockReference, UI_EXAMPLE } from "./catalog";
export { compile } from "./compile";
export { evaluate, initialState } from "./evaluate";
export type { Action, Evaluation, RenderNode, UiEvent } from "./evaluate";
export {
	MAX_DEPTH,
	MAX_NODES,
	MAX_RESPONSE_STATE_BYTES,
	MAX_SOURCE_BYTES,
	MAX_STATE_BYTES,
	MAX_TEXT_CHARS,
	MAX_TURN_BYTES,
	STEP_BUDGET,
} from "./limits";
export { parse } from "./parse";
export type { Diagnostic, Expr, RawNode } from "./parse";
export type { ActionName, ActionSpec, Node, PropValue, UiProgram } from "./program";
export { checkUiState, isStorable, MAX_STORED_LIST, storableState, uiBlockId } from "./state";
export { extraState, splitUiResponse, stateSummary, turnFits, uiResponseOf, uiTurn } from "./response";
export type { UiResponse } from "./response";
export { formSummary, gradeField, initialUiState, numberOf, stringOf } from "./value";
export type { Field, FormSpec, UiState, Value } from "./value";
